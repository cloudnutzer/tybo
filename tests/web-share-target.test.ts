/**
 * Teilen-Ziel (Issue #229) ohne Browser: sw.js läuft mit Attrappen für self
 * und caches, die Anfragen sind echte Request-Objekte mit FormData. Geprüft:
 * Manifest-Feld, Ablegen und 303 auf /#/teilen, Grenzen (Art, Größe, Anzahl,
 * leer), Verfall nach zehn Minuten, Speicherfehler, dazu der Server: ein POST
 * an /teilen ohne Service Worker ändert nichts und antwortet 303 auf /.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BRAND } from "../src/brand";
import { SHARE_ACCEPT, SHARE_FILES_FIELD, SHARE_TARGET_PATH, webManifest } from "../src/web/manifest";
import { ACCESS_DENIED_TEXT, createWebServer, type WebServer } from "../src/web/server";
import { renderServiceWorker } from "../src/web/service-worker";
import { ACCESS, FakeCerts, validJwt } from "./access-fixture";

const publicDir = resolve(import.meta.dir, "..", "src", "web", "public");
const template = await readFile(join(publicDir, "sw.js"), "utf8");
const ORIGIN = "https://app.example.org";
const SHARE_CACHE = `${BRAND.cli}-teilen`;
const MB = 1_048_576;
const MINUTE = 60_000;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface Stored {
  blob: Blob;
  headers: Record<string, string>;
}

/**
 * Cache-Attrappe mit echten Response-Objekten; put kann scheitern (Speicher
 * voll). hold(pass) lässt noch pass Schreibvorgänge durch und hält die
 * weiteren an, bis die zurückgegebene Funktion sie freigibt (langsames Gerät).
 */
function load(options: { failPutAfter?: number; now?: () => number } = {}) {
  const store = new Map<string, Map<string, Stored>>();
  let puts = 0;
  let gate: Promise<void> | null = null;
  let passing = 0;
  const hold = (pass = 0) => {
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    gate = held;
    passing = pass;
    return () => {
      if (gate === held) gate = null;
      release();
    };
  };
  const keyOf = (r: string | { url: string }) => (typeof r === "string" ? r : r.url);
  function cache(name: string) {
    let entries = store.get(name);
    if (!entries) store.set(name, (entries = new Map()));
    const e = entries;
    return {
      async put(request: string | { url: string }, res: Response) {
        puts++;
        if (options.failPutAfter !== undefined && puts > options.failPutAfter) throw new DOMException("voll", "QuotaExceededError");
        const blob = await res.blob();
        if (gate) {
          if (passing > 0) passing--;
          else await gate;
        }
        e.set(keyOf(request), { blob, headers: Object.fromEntries(res.headers) });
      },
      async match(request: string | { url: string }) {
        const s = e.get(keyOf(request));
        return s ? new Response(s.blob, { headers: s.headers }) : undefined;
      },
      async keys() {
        return [...e.keys()].map(url => ({ url }));
      },
      async delete(request: string | { url: string }) {
        return e.delete(keyOf(request));
      },
      async addAll() {},
    };
  }
  const caches = {
    open: async (name: string) => cache(name),
    has: async (name: string) => store.has(name),
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
    match: async () => undefined,
  };
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener(type: string, fn: (e: any) => void) { (listeners[type] ??= []).push(fn); },
    skipWaiting() {},
  };
  const netCalls: string[] = [];
  const fetchFake = async (request: Request | string) => {
    netCalls.push(typeof request === "string" ? request : `${request.method} ${new URL(request.url).pathname}`);
    return new Response("netz");
  };
  const realNow = Date.now;
  const source = renderServiceWorker(template, "0123456789abcdef");
  new Function("self", "caches", "fetch", source)(self, caches, fetchFake);

  function dispatch(type: string, event: any) {
    for (const fn of listeners[type] ?? []) fn(event);
  }
  /** Fetch-Ereignis mit echter Anfrage; undefined, wenn der Worker nicht antwortet */
  async function send(request: Request): Promise<Response | undefined> {
    let responded: Promise<Response> | undefined;
    const now = options.now;
    if (now) Date.now = now;
    try {
      dispatch("fetch", { request, respondWith(p: Promise<Response>) { responded = p; } });
      return responded ? await responded : undefined;
    } finally {
      Date.now = realNow;
    }
  }
  async function activate() {
    const waits: Promise<unknown>[] = [];
    const now = options.now;
    if (now) Date.now = now;
    try {
      dispatch("activate", { waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
    } finally {
      Date.now = realNow;
    }
  }
  /** Übergaben im Teilen-Cache: Beschreibung samt Dateien */
  async function handoffs() {
    const entries = store.get(SHARE_CACHE) ?? new Map();
    const out: { meta: any; files: { type: string; bytes: number }[] }[] = [];
    for (const [url, s] of entries) {
      if (!/\/teilen\/[0-9a-f]{32}$/.test(url)) continue;
      const meta = JSON.parse(await s.blob.text());
      const files = [];
      for (const f of meta.files) {
        const file = entries.get(`${url}/${f.n}`)!;
        files.push({ type: file.headers["content-type"], bytes: file.blob.size });
      }
      out.push({ meta, files });
    }
    return out;
  }
  const shareKeys = () => [...(store.get(SHARE_CACHE)?.keys() ?? [])];
  return { store, send, activate, handoffs, shareKeys, netCalls, hold };
}

/** Kennung wie shareId in sw.js zum Zeitpunkt at */
function idAt(at: number) {
  return Math.floor(at).toString(16).padStart(12, "0") + "0".repeat(19) + "1";
}

// Dateien nie aus lauter Nullbytes: Bun liest sie aus FormData sonst leer und ohne Namen
function png(name: string, size = 64): File {
  const bytes = new Uint8Array(size).fill(7);
  bytes.set(PNG);
  return new File([bytes], name, { type: "image/png" });
}

function shareRequest(fields: { title?: string; text?: string; url?: string; files?: File[] }, path = SHARE_TARGET_PATH) {
  const form = new FormData();
  if (fields.title !== undefined) form.set("title", fields.title);
  if (fields.text !== undefined) form.set("text", fields.text);
  if (fields.url !== undefined) form.set("url", fields.url);
  for (const file of fields.files ?? []) form.append(SHARE_FILES_FIELD, file);
  return new Request(`${ORIGIN}${path}`, { method: "POST", body: form });
}

describe("Manifest", () => {
  test("share_target: POST multipart an /teilen mit title, text, url und dateien", () => {
    const target = webManifest().share_target;
    expect(target).toEqual({
      action: "/teilen",
      method: "POST",
      enctype: "multipart/form-data",
      params: { title: "title", text: "text", url: "url", files: [{ name: "dateien", accept: SHARE_ACCEPT }] },
    });
    // Nur die Arten der Büroklammer: Bilder, PDF, Sprachdateien in den Formaten, die der Server erkennt
    expect(SHARE_ACCEPT.every(t => /^(image\/(png|jpeg|gif|webp)|application\/pdf|audio\/[a-z0-9-]+)$/.test(t))).toBe(true);
    expect(SHARE_ACCEPT).not.toContain("audio/*");
  });

  test("sw.js kennt genau die Typen aus dem Manifest", () => {
    const block = /const SHARE_TYPES = \{([^}]+)\}/.exec(template)![1];
    const types = [...block.matchAll(/"([a-z]+\/[a-z0-9.+-]+)":/g)].map(m => m[1]);
    expect(types.sort()).toEqual([...SHARE_ACCEPT].sort());
  });
});

describe("Service Worker legt ab und leitet um", () => {
  test("Text und zwei Bilder: eine Übergabe im eigenen Cache, 303 auf /#/teilen, nichts ans Netz", async () => {
    const sw = load();
    const res = (await sw.send(shareRequest({ title: "Seite", text: "Schau mal", url: "https://example.org/a", files: [png("a.png"), png("b.png", 80)] })))!;
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/#/teilen`);
    expect(sw.netCalls).toEqual([]);
    const [handoff, ...more] = await sw.handoffs();
    expect(more).toEqual([]);
    expect(handoff.meta).toMatchObject({ v: 1, title: "Seite", text: "Schau mal", url: "https://example.org/a", rejected: [] });
    expect(handoff.meta.id).toMatch(/^[0-9a-f]{32}$/);
    expect(handoff.meta.files.map((f: any) => [f.name, f.kind, f.size])).toEqual([["a.png", "image", 64], ["b.png", "image", 80]]);
    expect(handoff.files).toEqual([{ type: "image/png", bytes: 64 }, { type: "image/png", bytes: 80 }]);
    // Nur der eigene Cache, kein Offline-Cache angefasst
    expect([...sw.store.keys()]).toEqual([SHARE_CACHE]);
  });

  test("jedes Teilen ist eine eigene Übergabe mit eigener Kennung", async () => {
    const sw = load();
    await sw.send(shareRequest({ text: "eins" }));
    await sw.send(shareRequest({ text: "zwei" }));
    const list = await sw.handoffs();
    expect(list.map(h => h.meta.text).sort()).toEqual(["eins", "zwei"]);
    expect(new Set(list.map(h => h.meta.id)).size).toBe(2);
  });

  test("nicht erlaubte, leere, zu große und mehr als fünf Dateien: mit Grund abgewiesen, der Rest bleibt", async () => {
    const sw = load();
    const files = [
      new File(["x"], "notiz.txt", { type: "text/plain" }),
      new File([], "leer.png", { type: "image/png" }),
      new File([new Uint8Array(20 * MB + 1).fill(1)], "riesig.jpg", { type: "image/jpeg" }),
      new File([new Uint8Array(21 * MB).fill(1)], "lang.m4a", { type: "audio/mp4" }),
      new File(["%PDF-1.7"], "brief.pdf", { type: "application/pdf" }),
      new File([new Uint8Array(4).fill(1)], "ohne-typ.webp", { type: "" }),
      png("1.png"), png("2.png"), png("3.png"), png("4.png"),
      new File([new Uint8Array(3).fill(1)], "film.mp4", { type: "video/mp4" }),
    ];
    const res = (await sw.send(shareRequest({ files })))!;
    expect(res.status).toBe(303);
    const [handoff] = await sw.handoffs();
    expect(handoff.meta.files.map((f: any) => f.name)).toEqual(["lang.m4a", "brief.pdf", "ohne-typ.webp", "1.png", "2.png"]);
    // Leere Dateien liest Bun aus FormData ohne Namen (Chrome behält ihn): hier nur der Grund
    expect(handoff.meta.rejected.map((r: any) => (r.reason === "empty" ? { reason: r.reason } : r))).toEqual([
      { name: "notiz.txt", reason: "type" },
      { reason: "empty" },
      { name: "riesig.jpg", reason: "size", kind: "image" },
      { name: "3.png", reason: "count" },
      { name: "4.png", reason: "count" },
      { name: "film.mp4", reason: "type" },
    ]);
    expect(handoff.files.length).toBe(5);
  });

  test("Dateinamen ohne Pfad und Steuerzeichen, Text auf 20000 Zeichen begrenzt", async () => {
    const sw = load();
    await sw.send(shareRequest({ text: "a".repeat(25_000), url: "https://x", files: [png("../../etc/\u0007bild.png")] }));
    const [handoff] = await sw.handoffs();
    expect(handoff.meta.files[0].name).toBe("bild.png");
    expect(handoff.meta.text.length).toBe(20_000);
    expect(handoff.meta.url).toBe("");
  });

  test("leeres Teilen legt nichts ab und leitet trotzdem um", async () => {
    const sw = load();
    const res = (await sw.send(shareRequest({})))!;
    expect(res.status).toBe(303);
    expect(sw.shareKeys()).toEqual([]);
  });

  test("Speicher voll: halbe Übergabe weggeräumt, 303 auf /#/teilen/fehler", async () => {
    const sw = load({ failPutAfter: 1 });
    const res = (await sw.send(shareRequest({ text: "hallo", files: [png("a.png"), png("b.png")] })))!;
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/#/teilen/fehler`);
    expect(sw.shareKeys()).toEqual([]);
  });

  test("kaputtes Formular: 303 auf /#/teilen/fehler", async () => {
    const sw = load();
    const res = (await sw.send(new Request(`${ORIGIN}/teilen`, { method: "POST", body: "kein formular", headers: { "Content-Type": "multipart/form-data; boundary=x" } })))!;
    expect(res.headers.get("location")).toBe(`${ORIGIN}/#/teilen/fehler`);
  });

  test("nur POST an /teilen auf dem eigenen Ursprung; andere POSTs fasst der Worker nicht an", async () => {
    const sw = load();
    expect(await sw.send(shareRequest({ text: "x" }, "/teilen?x=1"))).toBeUndefined();
    expect(await sw.send(new Request(`${ORIGIN}/api/conversations/dm/messages`, { method: "POST", body: "{}" }))).toBeUndefined();
    const form = new FormData();
    form.set("text", "x");
    expect(await sw.send(new Request("https://fremd.example/teilen", { method: "POST", body: form }))).toBeUndefined();
    expect(sw.shareKeys()).toEqual([]);
  });
});

describe("Verfall nach zehn Minuten", () => {
  test("beim nächsten Teilen und beim Aktivieren sind ältere Übergaben weg, jüngere bleiben", async () => {
    let now = 1_000_000;
    const sw = load({ now: () => now });
    await sw.send(shareRequest({ text: "alt", files: [png("alt.png")] }));
    now += 9 * MINUTE;
    await sw.send(shareRequest({ text: "mittel" }));
    expect((await sw.handoffs()).map(h => h.meta.text).sort()).toEqual(["alt", "mittel"]);
    now += 1 * MINUTE;
    await sw.send(shareRequest({ text: "neu" }));
    expect((await sw.handoffs()).map(h => h.meta.text).sort()).toEqual(["mittel", "neu"]);
    // Auch die Datei der alten Übergabe ist weg
    expect(sw.shareKeys().length).toBe(2);
    now += 9 * MINUTE + 1;
    await sw.activate();
    expect((await sw.handoffs()).map(h => h.meta.text)).toEqual(["neu"]);
  });

  test("abgebrochene Übergaben (Datei ohne Beschreibung, Kennung älter als zehn Minuten) und fremde Einträge räumt das Aktivieren weg", async () => {
    const sw = load();
    const entries = new Map<string, Stored>();
    sw.store.set(SHARE_CACHE, entries);
    entries.set(`${ORIGIN}/teilen/${idAt(Date.now() - 10 * MINUTE - 1)}/0`, { blob: new Blob(["x"]), headers: {} });
    entries.set(`${ORIGIN}/teilen/${"a".repeat(32)}/0`, { blob: new Blob(["x"]), headers: {} });
    entries.set(`${ORIGIN}/anderes`, { blob: new Blob(["x"]), headers: {} });
    await sw.activate();
    expect(sw.shareKeys()).toEqual([]);
  });

  test("junge Datei ohne Beschreibung schreibt ein anderes Teilen gerade: das Aktivieren lässt sie liegen", async () => {
    const sw = load();
    const entries = new Map<string, Stored>();
    sw.store.set(SHARE_CACHE, entries);
    const url = `${ORIGIN}/teilen/${idAt(Date.now() - 1000)}/0`;
    entries.set(url, { blob: new Blob(["x"]), headers: {} });
    await sw.activate();
    expect(sw.shareKeys()).toEqual([url]);
  });
});

describe("Teilen gleichzeitig", () => {
  test("zwei parallele Share-POSTs: das zweite räumt die halb geschriebene erste Übergabe nicht weg, beide kommen vollständig an", async () => {
    const sw = load();
    // Vom ersten Teilen liegt das erste Bild schon im Gerät, das zweite und die Beschreibung noch nicht
    const release = sw.hold(1);
    const first = sw.send(shareRequest({ text: "eins", files: [png("a.png"), png("b.png", 80)] }));
    for (let i = 0; i < 20; i++) await Bun.sleep(0);
    expect(sw.shareKeys().length).toBe(1);
    const second = sw.send(shareRequest({ text: "zwei", files: [png("c.png")] }));
    for (let i = 0; i < 20; i++) await Bun.sleep(0);
    release();
    expect((await first)!.headers.get("location")).toBe(`${ORIGIN}/#/teilen`);
    expect((await second)!.headers.get("location")).toBe(`${ORIGIN}/#/teilen`);
    const list = await sw.handoffs();
    expect(list.map(h => [h.meta.text, h.files.length]).sort()).toEqual([["eins", 2], ["zwei", 1]]);
  });

  test("Kennung trägt den Zeitpunkt: die ersten zwölf Stellen sind die Uhrzeit des Teilens", async () => {
    let now = 1_700_000_000_000;
    const sw = load({ now: () => now });
    await sw.send(shareRequest({ text: "eins" }));
    const [handoff] = await sw.handoffs();
    expect(parseInt(handoff.meta.id.slice(0, 12), 16)).toBe(now);
    expect(handoff.meta.at).toBe(now);
  });
});

describe("Server ohne Service Worker", () => {
  const dirs: string[] = [];
  const servers: WebServer[] = [];
  afterAll(async () => {
    for (const s of servers) await s.stop();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  async function start(options: { tunnel?: boolean } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "tybo-share-"));
    dirs.push(dir);
    const server = await createWebServer(
      { host: "127.0.0.1", port: 0, password: "geheim-passwort-123", allowedHosts: [], ...(options.tunnel ? { publicOrigin: ORIGIN, access: ACCESS } : {}) },
      { sessionFile: join(dir, "sessions.json"), dataDir: join(dir, "web"), accessCerts: new FakeCerts().fetch, log: () => {} }
    );
    servers.push(server);
    return { url: server.url.replace(/\/$/, ""), dir };
  }

  async function listing(dir: string): Promise<string[]> {
    const out: string[] = [];
    async function walk(p: string, rel: string) {
      let names: string[] = [];
      try {
        names = await readdir(p);
      } catch {
        return;
      }
      for (const name of names) {
        out.push(join(rel, name));
        await walk(join(p, name), join(rel, name));
      }
    }
    await walk(dir, "");
    return out.sort();
  }

  test("POST /teilen ohne Sitzung, ohne Origin und mit fremdem Origin: 303 auf /, nichts gespeichert", async () => {
    const { url, dir } = await start();
    const before = await listing(dir);
    for (const headers of [{}, { origin: "https://fremd.example" }, { origin: url }]) {
      const form = new FormData();
      form.set("text", "geteilt");
      form.append("dateien", png("a.png"));
      const res = await fetch(`${url}/teilen`, { method: "POST", body: form, headers, redirect: "manual" });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(await listing(dir)).toEqual(before);
  });

  test("auch große Bodies (über der 64-KiB-Grenze) enden mit 303 statt 413", async () => {
    const { url } = await start();
    const form = new FormData();
    form.append("dateien", new File([new Uint8Array(3 * MB).fill(1)], "gross.png", { type: "image/png" }));
    const res = await fetch(`${url}/teilen`, { method: "POST", body: form, redirect: "manual" });
    expect(res.status).toBe(303);
  });

  test("über den Tunnel gilt der Access-Nachweis: ohne 403, mit 303", async () => {
    const { url } = await start({ tunnel: true });
    const host = new URL(ORIGIN).host;
    const post = (headers: Record<string, string>) => {
      const form = new FormData();
      form.set("text", "geteilt");
      return fetch(`${url}/teilen`, { method: "POST", body: form, headers: { host, "cf-connecting-ip": "203.0.113.7", ...headers }, redirect: "manual" });
    };
    const denied = await post({});
    expect(denied.status).toBe(403);
    expect(await denied.text()).toBe(ACCESS_DENIED_TEXT);
    // Mit Nachweis, aber ohne Sitzung und mit fremdem Origin: trotzdem nur 303, nichts gelesen
    const ok = await post({ "cf-access-jwt-assertion": validJwt(), origin: "https://fremd.example" });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/");
  });

  test("GET /teilen ist keine Hintertür: ohne Anmeldung zur Anmeldung", async () => {
    const { url } = await start();
    const res = await fetch(`${url}/teilen`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});
