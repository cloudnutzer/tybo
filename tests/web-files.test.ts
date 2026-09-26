// Download von Dateien aus Meldungen (Issue #47, Schritt 2): GET /api/files/<id>
// nur angemeldet, nur mit festgehaltenem Eintrag, nur aus der Ablage, immer als
// Anhang; inline nur PNG, JPEG, WebP und GIF mit ?inline=1.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDisplayOnlyFile, getDisplayOnlyPage, getLatestDisplayOnlyAt } from "../src/lib/supabase";
import { contentDisposition, type FileSource } from "../src/web/files";
import { createFileSource } from "../src/web/bot-files";
import type { NoticeFile } from "../src/web/notice";
import { createWebServer, SECURITY_HEADERS, type WebServer } from "../src/web/server";
import { useFakeSupabase } from "./supabase-fixture";

const PASSWORD = "test-passwort-lang";
const USER = "4711";
const GROUP = "-1001234567890";
const root = await mkdtemp(join(tmpdir(), "tybo-web-files-"));
let counter = 0;
afterAll(() => rm(root, { recursive: true, force: true }));

const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

function uuid(): string {
  return crypto.randomUUID();
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const GIF = new TextEncoder().encode("GIF89a\x01\x00\x01\x00\x00\x00");
const WEBP = new TextEncoder().encode("RIFF\x10\x00\x00\x00WEBPVP8 ");

interface Ctx {
  url: string;
  cookie: string;
  outbox: string;
  outside: string;
  entries: Map<string, NoticeFile>;
  /** Legt Datei und Eintrag an */
  add(name: string, content: Uint8Array | string, mime: string, options?: { entry?: boolean; file?: boolean }): Promise<string>;
  get(path: string, cookie?: string): Promise<Response>;
}

async function start(options: { source?: (entries: Map<string, NoticeFile>) => FileSource; files?: false } = {}): Promise<Ctx> {
  const dir = join(root, `case-${++counter}`);
  const outbox = join(dir, "outbox");
  const outside = join(dir, "outside");
  await mkdir(outbox, { recursive: true });
  await mkdir(outside, { recursive: true });
  const entries = new Map<string, NoticeFile>();
  const source: FileSource = options.source?.(entries) ?? { find: async id => entries.get(id) ?? null };
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    {
      sessionFile: join(dir, "web-sessions.json"),
      dataDir: join(dir, "web"),
      ...(options.files === false ? {} : { files: { source, dir: outbox } }),
      log: () => {},
    }
  );
  servers.push(server);
  const res = await fetch(`${server.url}/api/login`, {
    method: "POST",
    headers: { origin: server.url },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  return {
    url: server.url,
    cookie,
    outbox,
    outside,
    entries,
    async add(name, content, mime, opts = {}) {
      const id = uuid();
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      if (opts.file !== false) {
        await mkdir(join(outbox, id), { recursive: true });
        await writeFile(join(outbox, id, name), bytes);
      }
      if (opts.entry !== false) entries.set(id, { id, name, size: bytes.byteLength, mime });
      return id;
    },
    get: (path, c = cookie) => fetch(`${server.url}${path}`, { headers: c ? { cookie: c } : {}, redirect: "manual" }),
  };
}

describe("GET /api/files/<id>", () => {
  test("ohne Anmeldung 401, auch für vorhandene Dateien", async () => {
    const ctx = await start();
    const id = await ctx.add("bericht.pdf", "%PDF-1.4", "application/pdf");
    const res = await ctx.get(`/api/files/${id}`, "");
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("PDF");
  });

  test("Anhang mit nosniff, neutralem Typ und unveränderter CSP", async () => {
    const ctx = await start();
    const id = await ctx.add("bericht.pdf", "%PDF-1.4 inhalt", "application/pdf");
    const res = await ctx.get(`/api/files/${id}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("%PDF-1.4 inhalt");
    expect(res.headers.get("content-disposition")).toStartWith("attachment;");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(SECURITY_HEADERS["Content-Security-Policy"]!);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("unbekannte id 404", async () => {
    const ctx = await start();
    expect((await ctx.get(`/api/files/${uuid()}`)).status).toBe(404);
  });

  test("verwaiste Datei ohne festgehaltenen Eintrag 404", async () => {
    const ctx = await start();
    const id = await ctx.add("waise.txt", "ohne Eintrag", "text/plain", { entry: false });
    expect((await ctx.get(`/api/files/${id}`)).status).toBe(404);
  });

  test("Eintrag vorhanden, Datei fehlt in der Ablage: 404", async () => {
    const ctx = await start();
    const id = await ctx.add("weg.txt", "x", "text/plain", { file: false });
    expect((await ctx.get(`/api/files/${id}`)).status).toBe(404);
  });

  test("Pfad-Tricks in der id: 404", async () => {
    const ctx = await start();
    await writeFile(join(ctx.outbox, "geheim.txt"), "geheim");
    for (const path of [
      "/api/files/..%2Fgeheim.txt",
      "/api/files/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "/api/files/geheim.txt",
      "/api/files/..",
      `/api/files/${uuid().toUpperCase()}`,
      "/api/files/%00",
    ]) {
      const res = await ctx.get(path);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("geheim\n");
    }
  });

  test("manipulierter Dateiname im Eintrag: 404, nichts außerhalb der Ablage", async () => {
    const ctx = await start();
    await writeFile(join(ctx.outbox, "geheim.txt"), "GEHEIM");
    for (const name of ["../geheim.txt", "..", "a/../../geheim.txt", ".env", "x\u0000.txt"]) {
      const id = uuid();
      await mkdir(join(ctx.outbox, id), { recursive: true });
      ctx.entries.set(id, { id, name, size: 6, mime: "text/plain" });
      const res = await ctx.get(`/api/files/${id}`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("GEHEIM");
    }
  });

  test("Quelle liefert eine andere id als angefragt: 404", async () => {
    const ctx = await start();
    const other = await ctx.add("a.txt", "A", "text/plain");
    const id = uuid();
    ctx.entries.set(id, ctx.entries.get(other)!);
    expect((await ctx.get(`/api/files/${id}`)).status).toBe(404);
  });

  test("Symlinks: Datei oder Ordner, der aus der Ablage zeigt, ergibt 404", async () => {
    const ctx = await start();
    await writeFile(join(ctx.outside, "passwort.txt"), "GEHEIM");
    // Datei als Symlink
    const id1 = uuid();
    await mkdir(join(ctx.outbox, id1), { recursive: true });
    await symlink(join(ctx.outside, "passwort.txt"), join(ctx.outbox, id1, "passwort.txt"));
    ctx.entries.set(id1, { id: id1, name: "passwort.txt", size: 6, mime: "text/plain" });
    // Ordner als Symlink
    const id2 = uuid();
    await symlink(ctx.outside, join(ctx.outbox, id2));
    ctx.entries.set(id2, { id: id2, name: "passwort.txt", size: 6, mime: "text/plain" });
    for (const id of [id1, id2]) {
      const res = await ctx.get(`/api/files/${id}`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("GEHEIM");
    }
  });

  test("Umlaute: sicherer Ersatzname und UTF-8-Name nach RFC 5987", async () => {
    const ctx = await start();
    const id = await ctx.add("Bericht März (final).pdf", "%PDF", "application/pdf");
    const res = await ctx.get(`/api/files/${id}`);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="Bericht Marz (final).pdf"; filename*=UTF-8''Bericht%20M%C3%A4rz%20%28final%29.pdf`
    );
  });

  test("HTML und SVG mit ?inline=1 bleiben Anhang", async () => {
    const ctx = await start();
    const html = await ctx.add("report.html", "<script>alert(1)</script>", "text/html");
    const svg = await ctx.add("bild.svg", "<svg onload=alert(1)></svg>", "image/svg+xml");
    for (const id of [html, svg]) {
      const res = await ctx.get(`/api/files/${id}?inline=1`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toStartWith("attachment;");
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  test("PNG, JPEG, WebP und GIF mit ?inline=1 als Vorschau, ohne inline als Anhang", async () => {
    const ctx = await start();
    const cases: [string, Uint8Array, string][] = [
      ["a.png", PNG, "image/png"],
      ["b.jpg", JPEG, "image/jpeg"],
      ["c.jpeg", JPEG, "image/jpeg"],
      ["d.webp", WEBP, "image/webp"],
      ["e.gif", GIF, "image/gif"],
    ];
    for (const [name, bytes, mime] of cases) {
      const id = await ctx.add(name, bytes, mime);
      const inline = await ctx.get(`/api/files/${id}?inline=1`);
      expect(inline.status).toBe(200);
      expect(inline.headers.get("content-type")).toBe(mime);
      expect(inline.headers.get("content-disposition")).toStartWith("inline;");
      expect(inline.headers.get("x-content-type-options")).toBe("nosniff");
      const plain = await ctx.get(`/api/files/${id}`);
      expect(plain.headers.get("content-disposition")).toStartWith("attachment;");
      expect(plain.headers.get("content-type")).toBe("application/octet-stream");
    }
  });

  test("Bild-Endung mit fremdem Inhalt oder abweichendem Typ: kein inline", async () => {
    const ctx = await start();
    const fake = await ctx.add("tarn.png", "<html><script>alert(1)</script></html>", "image/png");
    const wrongMime = await ctx.add("echt.png", PNG, "text/html");
    for (const id of [fake, wrongMime]) {
      const res = await ctx.get(`/api/files/${id}?inline=1`);
      expect(res.headers.get("content-disposition")).toStartWith("attachment;");
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
    }
  });

  test("Speicher nicht lesbar: 503; ohne Dateiquelle: 404", async () => {
    const broken = await start({ source: () => ({ find: async () => Promise.reject(new Error("db weg")) }) });
    expect((await broken.get(`/api/files/${uuid()}`)).status).toBe(503);
    const none = await start({ files: false });
    expect((await none.get(`/api/files/${uuid()}`)).status).toBe(404);
  });
});

describe("contentDisposition", () => {
  test("keine Anführungszeichen, Backslashes oder Zeilenumbrüche im Ersatznamen", () => {
    const value = contentDisposition("attachment", 'a"b\\c\r\nd.txt');
    expect(value).not.toMatch(/[\r\n]/);
    expect(value.split(";")[1]).toBe(' filename="a_b_c__d.txt"');
  });
});

describe("createFileSource (Bot-Prozess)", () => {
  const file = (id: string) => ({ id, name: "a.pdf", size: 3, mime: "application/pdf" });
  const row = (id: string, chatId: string, metadata: Record<string, unknown>) => ({
    id: "1",
    created_at: "2026-09-24T10:00:00.000Z",
    chat_id: chatId,
    role: "assistant",
    content: "a.pdf",
    metadata,
  });

  test("fragt nur Direktchat und Gruppe ab und gibt nur geprüfte Felder zurück", async () => {
    const id = uuid();
    const calls: string[][] = [];
    const source = createFileSource({
      userId: USER,
      groupId: () => GROUP,
      find: async (_id, chatIds) => {
        calls.push(chatIds);
        return row(id, GROUP, { display_only: true, source: "datei", topicId: 443, file: { ...file(id), path: "/Users/x/y" } });
      },
    });
    expect(await source.find(id)).toEqual(file(id));
    expect(calls).toEqual([[USER, GROUP]]);
  });

  test("kein Nur-Anzeige-Eintrag, fremder Chat oder gelöschtes Topic: null", async () => {
    const id = uuid();
    const make = (r: ReturnType<typeof row>) =>
      createFileSource({
        userId: USER,
        groupId: () => GROUP,
        find: async () => r,
        topicState: async () => new Map([[9, { deleted: true } as any]]),
      });
    expect(await make(row(id, GROUP, { display_only: "true", file: file(id) })).find(id)).toBeNull();
    expect(await make(row(id, "-100999", { display_only: true, file: file(id) })).find(id)).toBeNull();
    expect(await make(row(id, GROUP, { display_only: true, topicId: 9, file: file(id) })).find(id)).toBeNull();
    expect(await make(row(id, GROUP, { display_only: true, topicId: 10, file: file(id) })).find(id)).toEqual(file(id));
    expect(await make(row(id, USER, { display_only: true, file: file(id) })).find(id)).toEqual(file(id));
  });
});

describe("Supabase-Lesezugriffe für Meldungen", () => {
  test("Dateinachweis filtert auf display_only, file.id und die Chats", async () => {
    const id = uuid();
    const fake = useFakeSupabase({ rows: () => [] });
    try {
      expect(await findDisplayOnlyFile(id, [USER, GROUP])).toBeNull();
      const q = fake.requests.find(r => r.url.pathname === "/rest/v1/messages")!.url.searchParams;
      expect(q.get("metadata->>display_only")).toBe("eq.true");
      expect(q.get("metadata->file->>id")).toBe(`eq.${id}`);
      expect(q.get("chat_id")).toBe(`in.(${USER},${GROUP})`);
      expect(q.get("select")).not.toContain("embedding");
    } finally {
      fake.restore();
    }
  });

  test("Seite der Meldungen: aufsteigend, ab Zeitpunkt, Cursor mit Mikrosekunden", async () => {
    const fake = useFakeSupabase({ rows: () => [] });
    try {
      await getDisplayOnlyPage([USER, GROUP], {
        since: "2026-09-24T09:59:00.000Z",
        after: { createdAt: "2026-09-24T10:00:00.123456+00:00", id: "42" },
        limit: 100,
      });
      const q = fake.requests.find(r => r.url.pathname === "/rest/v1/messages")!.url.searchParams;
      expect(q.get("metadata->>display_only")).toBe("eq.true");
      expect(q.get("created_at")).toBe("gte.2026-09-24T09:59:00.000Z");
      expect(q.get("or")).toBe(
        '(created_at.gt."2026-09-24T10:00:00.123456+00:00",and(created_at.eq."2026-09-24T10:00:00.123456+00:00",id.gt.42))'
      );
      expect(q.get("order")).toBe("created_at.asc,id.asc");
      expect(q.get("limit")).toBe("100");
      await expect(getDisplayOnlyPage([USER], { since: 'x",id.gt.0', limit: 1 })).rejects.toThrow();
    } finally {
      fake.restore();
    }
  });

  test("Fehler werden geworfen, nicht als leer gemeldet", async () => {
    const fake = useFakeSupabase({ rows: () => ({ message: "kaputt" }) as any });
    try {
      await expect(getLatestDisplayOnlyAt([USER])).rejects.toThrow();
      await expect(getDisplayOnlyPage([USER], { limit: 5 })).rejects.toThrow();
      await expect(findDisplayOnlyFile(uuid(), [USER])).rejects.toThrow();
    } finally {
      fake.restore();
    }
  });
});
