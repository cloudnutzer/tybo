/**
 * Health-Server (Issue #343, src/app/health-server.ts): HTTP-Vertrag von
 * GET / und /health, POST /process (Sprach-Brücke, Hybrid-Modus), Foto-Download
 * und Asset-Nachbearbeitung. Echter Bun.serve auf freiem Port, alle
 * Abhängigkeiten sind Attrappen; src/bot.ts und src/voice-bridge.ts werden
 * weder importiert noch gestartet.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  HEALTH_SERVICE,
  describeAssetFromReply,
  healthAddress,
  loadTelegramPhoto,
  startHealthServer,
  type HealthServer,
  type HealthServerOptions,
} from "../src/app/health-server";
import { Api } from "grammy";
import { PROCESS_TEXT, processInBackground, type ProcessBackgroundDeps, type ProcessRequest } from "../src/lib/process-background";

const SECRET = "test-gateway-geheimnis";
let servers: HealthServer[] = [];
let dirs: string[] = [];

afterEach(async () => {
  for (const s of servers) await s.stop();
  servers = [];
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

function held() {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  return { gate, release };
}

function serve(over: Partial<HealthServerOptions> = {}) {
  const received: ProcessRequest[] = [];
  let session = { sessionId: "sitzung-1" as string | null, engine: "claude" as const | null };
  const options: HealthServerOptions = {
    port: 0,
    session: () => session,
    uptime: () => 12.5,
    pid: 4242,
    now: () => new Date("2026-10-21T08:00:00.000Z"),
    secret: () => SECRET,
    allowChat: id => id === "7",
    process: async req => void received.push(req),
    ...over,
  };
  const server = startHealthServer(options);
  servers.push(server);
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const post = (body: unknown, auth: string | null = `Bearer ${SECRET}`) =>
    fetch(url("/process"), {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { server, url, post, received, setSession: (s: typeof session) => (session = s) };
}

async function waitUntil(check: () => boolean, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(2);
  }
}

describe("Adresse", () => {
  test("Standard 127.0.0.1:3000, HEALTH_HOST und HEALTH_PORT überschreiben", () => {
    expect(healthAddress({})).toEqual({ hostname: "127.0.0.1", port: 3000 });
    expect(healthAddress({ HEALTH_HOST: "0.0.0.0", HEALTH_PORT: "3555" })).toEqual({ hostname: "0.0.0.0", port: 3555 });
    expect(healthAddress({ HEALTH_HOST: "", HEALTH_PORT: "" })).toEqual({ hostname: "127.0.0.1", port: 3000 });
  });

  test("ohne Angabe lauscht der Server nur auf 127.0.0.1", () => {
    const { server } = serve();
    expect(server.hostname).toBe("127.0.0.1");
  });
});

describe("GET / und /health", () => {
  test("liefert Status, Dienst, Laufzeit, PID, Session und Zeit als JSON", async () => {
    const { url } = serve();
    for (const path of ["/", "/health"]) {
      const res = await fetch(url(path));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({
        status: "ok",
        service: HEALTH_SERVICE,
        uptime: 12.5,
        pid: 4242,
        sessionId: "sitzung-1",
        sessionEngine: "claude",
        timestamp: "2026-10-21T08:00:00.000Z",
      });
    }
    expect(HEALTH_SERVICE).toBe("tybo-telegram-bot");
  });

  test("Session wird bei jeder Anfrage frisch gelesen", async () => {
    const { url, setSession } = serve();
    setSession({ sessionId: null, engine: null });
    expect(await (await fetch(url("/health"))).json()).toMatchObject({ sessionId: null, sessionEngine: null });
    setSession({ sessionId: "sitzung-2", engine: "claude" });
    expect(await (await fetch(url("/health"))).json()).toMatchObject({ sessionId: "sitzung-2" });
  });
});

describe("POST /process", () => {
  test("Sprach-Brücke: Bearer GATEWAY_SECRET und {text, chatId} ergeben sofort 202", async () => {
    const work = held();
    let started = 0;
    const received: ProcessRequest[] = [];
    const { post } = serve({
      process: async req => {
        started++;
        received.push(req);
        await work.gate;
      },
    });
    // Genau die Form aus deepThink in src/voice-bridge.ts
    const res = await post({ text: "Denk bitte gründlich nach: Urlaubsplanung", chatId: "7" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    // Antwort kam, obwohl die Arbeit noch hängt
    await waitUntil(() => started === 1);
    expect(received[0]).toEqual({ text: "Denk bitte gründlich nach: Urlaubsplanung", chatId: "7" });
    work.release();
  });

  test("numerische chatId, threadId und Foto werden weitergereicht", async () => {
    const { post, received } = serve();
    expect((await post({ chatId: 7, threadId: 12, photoFileId: "foto-1" })).status).toBe(202);
    await waitUntil(() => received.length === 1);
    expect(received[0]).toEqual({ chatId: "7", threadId: 12, photoFileId: "foto-1" });
  });

  test("ohne eingerichtetes Geheimnis 503, ohne oder mit falschem Token 401", async () => {
    let secret = "";
    const { post, received } = serve({ secret: () => secret });
    expect((await post({ text: "hallo", chatId: "7" })).status).toBe(503);
    secret = SECRET;
    expect((await post({ text: "hallo", chatId: "7" }, null)).status).toBe(401);
    expect((await post({ text: "hallo", chatId: "7" }, "Bearer falsch")).status).toBe(401);
    expect(received).toEqual([]);
  });

  test("fremder Chat 403, ungültige Nachricht und kaputtes JSON 400", async () => {
    const { post, received } = serve();
    expect((await post({ text: "hallo", chatId: "8" })).status).toBe(403);
    expect((await post({ text: "  ", chatId: "7" })).status).toBe(400);
    expect((await post({ text: "hallo", chatId: "7", extra: 1 })).status).toBe(400);
    expect((await post({ text: "hallo", chatId: "7", threadId: -1 })).status).toBe(400);
    expect((await post("{kein json")).status).toBe(400);
    expect(received).toEqual([]);
  });

  test("über 64 KiB: 413, nichts angenommen", async () => {
    const { post, received } = serve();
    const res = await post({ text: "x".repeat(70_000), chatId: "7" });
    expect(res.status).toBe(413);
    expect(received).toEqual([]);
  });

  test("Grenze offener Aufträge gilt über alle Anfragen: danach 429 mit Retry-After", async () => {
    const work = held();
    let started = 0;
    const { post } = serve({
      capacity: 2,
      process: async () => {
        started++;
        await work.gate;
      },
    });
    expect((await post({ text: "a", chatId: "7" })).status).toBe(202);
    expect((await post({ text: "b", chatId: "7" })).status).toBe(202);
    const busy = await post({ text: "c", chatId: "7" });
    expect(busy.status).toBe(429);
    expect(busy.headers.get("retry-after")).toBe("5");
    work.release();
    await waitUntil(() => started === 2);
    await Bun.sleep(5);
    expect((await post({ text: "d", chatId: "7" })).status).toBe(202);
  });

  test("Standardgrenze 16 offene Aufträge", async () => {
    const work = held();
    const { post } = serve({ process: () => work.gate });
    for (let i = 0; i < 16; i++) expect((await post({ text: `n${i}`, chatId: "7" })).status).toBe(202);
    expect((await post({ text: "zu viel", chatId: "7" })).status).toBe(429);
    work.release();
  });

  test("Fehler im Hintergrund ändern die Antwort nicht", async () => {
    let calls = 0;
    const { post } = serve({
      process: async () => {
        calls++;
        throw new Error("kaputt");
      },
    });
    const original = console.error;
    console.error = () => {};
    try {
      expect((await post({ text: "a", chatId: "7" })).status).toBe(202);
      await waitUntil(() => calls === 1);
    } finally {
      console.error = original;
    }
  });
});

describe("andere Wege", () => {
  test("GET /process, unbekannte Pfade: 404", async () => {
    const { url, received } = serve();
    expect((await fetch(url("/process"))).status).toBe(404);
    expect((await fetch(url("/api/irgendwas"))).status).toBe(404);
    expect((await fetch(url("/health"), { method: "POST" })).status).toBe(200);
    expect(received).toEqual([]);
  });

  test("stop() gibt den Port frei", async () => {
    const { server, url } = serve();
    const port = server.port;
    await server.stop();
    servers = [];
    await expect(fetch(url("/health"))).rejects.toThrow();
    const again = startHealthServer({
      port, session: () => ({ sessionId: null, engine: null }),
      secret: () => SECRET, allowChat: () => true, process: async () => {},
    });
    servers.push(again);
    expect(again.port).toBe(port);
  });
});

describe("Foto aus Telegram laden", () => {
  async function tempDir() {
    const dir = await mkdtemp(join(tmpdir(), "health-foto-"));
    dirs.push(dir);
    return join(dir, "uploads");
  }

  test("legt das Foto unter uploads/ ab und liefert den Pfad", async () => {
    const dir = await tempDir();
    const asked: string[] = [];
    const load = loadTelegramPhoto({
      api: () => ({ getFile: async (id: string) => (asked.push(id), { file_path: "photos/file_9.png" }) }),
      token: "123:geheim",
      dir,
      now: () => 1700,
      uuid: () => "abc",
      fetch: async url => {
        expect(url).toBe("https://api.telegram.org/file/bot123:geheim/photos/file_9.png");
        return new Response(new Uint8Array([1, 2, 3]));
      },
    });
    const path = await load("foto-1");
    expect(asked).toEqual(["foto-1"]);
    expect(path).toBe(join(dir, "photo_1700_abc.png"));
    expect([...(await readFile(path!))]).toEqual([1, 2, 3]);
  });

  test("seltsame Endung wird zu jpg", async () => {
    const dir = await tempDir();
    const load = loadTelegramPhoto({
      api: () => ({ getFile: async () => ({ file_path: "photos/datei.ex/../e" }) }),
      token: "t", dir, now: () => 1, uuid: () => "u",
      fetch: async () => new Response(new Uint8Array([1])),
    });
    expect(await load("f")).toBe(join(dir, "photo_1_u.jpg"));
  });

  test("ohne Telegram oder ohne Dateipfad: null", async () => {
    const dir = await tempDir();
    const noTelegram = loadTelegramPhoto({ api: () => null, token: "", dir });
    expect(await noTelegram("f")).toBeNull();
    const noPath = loadTelegramPhoto({ api: () => ({ getFile: async () => ({}) }), token: "t", dir });
    expect(await noPath("f")).toBeNull();
  });

  test("Fehler beim Laden enthält den Token nicht", async () => {
    const dir = await tempDir();
    const load = loadTelegramPhoto({
      api: () => ({ getFile: async () => ({ file_path: "p.jpg" }) }),
      token: "123:geheim",
      dir,
      fetch: async url => {
        throw new Error(`Verbindung zu ${url} fehlgeschlagen`);
      },
    });
    const err = await load("f").catch(e => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain("geheim");
  });
});

describe("Foto im /process-Auftrag: Telegram lehnt getFile ab", () => {
  // Echte grammY-Api, nur ihr fetch ist ersetzt: so entsteht der GrammyError
  // genau wie im Betrieb aus der Fehlerantwort von Telegram
  function run(telegramFetch: (url: string) => Promise<Response>) {
    const sent: string[] = [];
    const claude: string[] = [];
    const files: string[] = [];
    const api = new Api("123:geheim", { fetch: (url => telegramFetch(String(url))) as typeof fetch });
    const deps: ProcessBackgroundDeps = {
      sessionKey: chatId => `topic:${chatId}:0`,
      send: async (_chatId, text) => void sent.push(text),
      typing: async () => {},
      downloadPhoto: loadTelegramPhoto({
        api: () => api,
        token: "123:geheim",
        dir: join(tmpdir(), "health-foto-nie-angelegt"),
        fetch: async url => (files.push(url), new Response(new Uint8Array([1]))),
      }),
      uploadAsset: async () => ({ id: "a1" }),
      callClaude: async prompt => (claude.push(prompt), "Antwort"),
      finishAsset: (_id, response) => response,
      log: () => {},
    };
    return { done: processInBackground({ chatId: "7", photoFileId: "abgelaufen", text: "Was ist das?" }, deps), sent, claude, files };
  }

  test("400 invalid file_id: Foto-Hinweis an den Nutzer, kein Claude-Aufruf", async () => {
    const asked: string[] = [];
    const t = run(async url => {
      asked.push(url);
      return Response.json({ ok: false, error_code: 400, description: "Bad Request: invalid file_id" }, { status: 400 });
    });
    await t.done;
    expect(asked).toEqual(["https://api.telegram.org/bot123:geheim/getFile"]);
    expect(t.sent).toEqual([PROCESS_TEXT.photoFailed]);
    expect(t.sent).toEqual(["Could not download the photo from Telegram."]);
    expect(t.claude).toEqual([]);
    expect(t.files).toEqual([]);
  });

  test("Transportfehler bei getFile: allgemeine Fehlermeldung statt Foto-Hinweis, kein Claude-Aufruf", async () => {
    const t = run(async () => {
      throw new TypeError("fetch failed");
    });
    await t.done;
    expect(t.sent).toEqual([PROCESS_TEXT.failed]);
    expect(t.claude).toEqual([]);
    expect(t.files).toEqual([]);
  });
});

describe("Asset-Beschreibung aus der Antwort", () => {
  function setup() {
    const described: Array<{ id: string; text: string; keywords?: string[] }> = [];
    const finish = describeAssetFromReply({
      describe: async (id, text, keywords) => void described.push({ id, text, ...(keywords ? { keywords } : {}) }),
    });
    return { finish, described };
  }

  test("[ASSET_DESC:]-Tag: Beschreibung und Schlagwörter, Tag aus der Antwort entfernt", () => {
    const { finish, described } = setup();
    const out = finish("bild-1", "Schönes Bild.\n[ASSET_DESC: Ein Hund am Strand | hund, strand]");
    expect(out).toBe("Schönes Bild.");
    expect(described).toEqual([{ id: "bild-1", text: "Ein Hund am Strand", keywords: ["hund", "strand"] }]);
  });

  test("ohne Tag: die ersten zwei Sätze als Beschreibung", () => {
    const { finish, described } = setup();
    const out = finish("bild-2", "Ein Hund. Er läuft! Am Strand? Ja.");
    expect(out).toBe("Ein Hund. Er läuft! Am Strand? Ja.");
    expect(described).toEqual([{ id: "bild-2", text: "Ein Hund. Er läuft!" }]);
  });

  test("ohne Satzende oder ohne Asset: keine Beschreibung", () => {
    const { finish, described } = setup();
    expect(finish("bild-3", "kein satzende")).toBe("kein satzende");
    expect(finish(null, "Ein Satz. [ASSET_DESC: x]")).toBe("Ein Satz.");
    expect(described).toEqual([]);
  });

  test("Fehler beim Speichern der Beschreibung bleibt still", async () => {
    const finish = describeAssetFromReply({ describe: async () => { throw new Error("db weg"); } });
    expect(finish("bild-4", "Ein Satz.")).toBe("Ein Satz.");
    await Bun.sleep(5);
  });
});
