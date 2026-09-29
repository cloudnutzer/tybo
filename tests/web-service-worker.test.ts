/**
 * Service Worker der installierbaren Web-App (Issue #224) ohne Browser:
 * sw.js läuft mit Attrappen für self, caches und fetch. Geprüft: Offline-
 * Seite bei Netzfehler und bei 502/503/504/520 bis 530 auf eine Navigation,
 * Weiterleitungen (302, opaqueredirect) unverändert, /api/… nie angefasst,
 * nichts außer den Offline-Dateien im Cache, activate löscht nur eigene
 * ältere Caches, skipWaiting nur auf Wunsch der Seite. Dazu die Auslieferung
 * durch den Server (Version in den Bytes, ohne Sitzung, Tunnel mit Access).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BRAND } from "../src/brand";
import { ACCESS_DENIED_TEXT, createWebServer, type WebServer } from "../src/web/server";
import { renderServiceWorker } from "../src/web/service-worker";
import { computeUiVersion } from "../src/web/ui-version";
import { ACCESS, FakeCerts, validJwt } from "./access-fixture";

const publicDir = resolve(import.meta.dir, "..", "src", "web", "public");
const template = await readFile(join(publicDir, "sw.js"), "utf8");
const ORIGIN = "https://app.example.org";
const VERSION = "0123456789abcdef";
const OLD = "fedcba9876543210";
const CACHE = `${BRAND.cli}-offline-${VERSION}`;
const OFFLINE_ASSETS = ["/offline.html", "/offline.js", "/style.css", "/theme.js", "/favicon.svg"];

interface FakeRequest {
  url: string;
  method: string;
  mode: string;
}

/** Gespeicherte Antwort; jeder Treffer bekommt eine frische Kopie */
interface Stored {
  status: number;
  body: string;
  headers: Record<string, string>;
}

function stored(res: Response, body: string): Stored {
  return { status: res.status, body, headers: Object.fromEntries(res.headers) };
}

function revive(s: Stored): Response {
  return new Response(s.body, { status: s.status, headers: s.headers });
}

function keyOf(request: FakeRequest | string): string {
  const url = new URL(typeof request === "string" ? request : request.url, ORIGIN);
  return url.pathname + url.search;
}

type NetResult = Response | { error: true } | { opaqueredirect: true };

function load(options: { version?: string; network?: (path: string) => NetResult } = {}) {
  const cacheStore = new Map<string, Map<string, Stored>>();
  const network = options.network ?? (path => new Response(`netz:${path}`, { status: 200 }));
  const netCalls: string[] = [];
  const opaque = { type: "opaqueredirect", status: 0, ok: false };
  async function fetchFake(request: FakeRequest | string): Promise<any> {
    const path = keyOf(request);
    netCalls.push(path);
    const result = network(path);
    if ("error" in result) throw new TypeError("Failed to fetch");
    if ("opaqueredirect" in result) return opaque;
    return result;
  }
  function openSync(name: string) {
    let entries = cacheStore.get(name);
    if (!entries) cacheStore.set(name, (entries = new Map()));
    const e = entries;
    return {
      async addAll(urls: string[]) {
        for (const url of urls) {
          const res = await fetchFake(url);
          if (!res.ok) throw new TypeError(`addAll: ${res.status}`);
          e.set(keyOf(url), stored(res, await res.text()));
        }
      },
      async put(request: FakeRequest | string, res: Response) {
        e.set(keyOf(request), stored(res, await res.text()));
      },
      async match(request: FakeRequest | string) {
        const s = e.get(keyOf(request));
        return s ? revive(s) : undefined;
      },
    };
  }
  const caches = {
    open: async (name: string) => openSync(name),
    keys: async () => [...cacheStore.keys()],
    delete: async (name: string) => cacheStore.delete(name),
    async match(request: FakeRequest | string, opts?: { cacheName?: string }) {
      const names = opts?.cacheName ? [opts.cacheName] : [...cacheStore.keys()];
      for (const name of names) {
        const s = cacheStore.get(name)?.get(keyOf(request));
        if (s) return revive(s);
      }
      return undefined;
    },
  };
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    skipped: 0,
    addEventListener(type: string, fn: (e: any) => void) { (listeners[type] ??= []).push(fn); },
    skipWaiting() { this.skipped++; return Promise.resolve(); },
  };
  const source = renderServiceWorker(template, options.version ?? VERSION);
  new Function("self", "caches", "fetch", source)(self, caches, fetchFake);

  function dispatch(type: string, event: any) {
    for (const fn of listeners[type] ?? []) fn(event);
  }
  async function lifecycle(type: "install" | "activate") {
    const waits: Promise<unknown>[] = [];
    dispatch(type, { waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  }
  /** Fetch-Ereignis; undefined, wenn der Worker nicht antwortet (Browser macht es selbst) */
  async function request(path: string, init: { mode?: string; method?: string; origin?: string } = {}) {
    let responded: Promise<any> | undefined;
    const event = {
      request: { url: `${init.origin ?? ORIGIN}${path}`, method: init.method ?? "GET", mode: init.mode ?? "navigate" },
      respondWith(p: Promise<any>) { responded = p; },
    };
    dispatch("fetch", event);
    return responded;
  }
  const cacheKeys = (name = CACHE) => [...(cacheStore.get(name)?.keys() ?? [])].sort();
  return { self, cacheStore, netCalls, lifecycle, request, dispatch, cacheKeys, opaque };
}

async function installed(network?: (path: string) => NetResult) {
  const sw = load({ network: path => (installing ? new Response(`datei:${path}`) : network ? network(path) : new Response(`netz:${path}`)) });
  let installing = true;
  await sw.lifecycle("install");
  await sw.lifecycle("activate");
  installing = false;
  return sw;
}

describe("Installieren", () => {
  test("cacht genau die Dateien der Offline-Seite unter dem Versionsnamen", async () => {
    const sw = await installed();
    expect([...sw.cacheStore.keys()]).toEqual([CACHE]);
    expect(sw.cacheKeys()).toEqual([...OFFLINE_ASSETS].sort());
  });

  test("ohne eingesetzte Version: Platzhalter verschwinden trotzdem", () => {
    const source = renderServiceWorker(template, "");
    expect(source).not.toContain("{{");
    expect(source).toContain(`const CACHE_PREFIX = "${BRAND.cli}-offline-";`);
  });
});

describe("Navigation", () => {
  test("erreichbar: Antwort des Netzes unverändert", async () => {
    const res = new Response("seite", { status: 200 });
    const sw = await installed(() => res);
    expect(await sw.request("/")).toBe(res);
  });

  test("Netzfehler: Offline-Seite aus dem Cache", async () => {
    const sw = await installed(() => ({ error: true }));
    const res = await sw.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("datei:/offline.html");
  });

  const unreachable = [502, 503, 504, ...Array.from({ length: 11 }, (_, i) => 520 + i)];
  test(`Status ${unreachable.join(", ")}: Offline-Seite`, async () => {
    for (const status of unreachable) {
      const sw = await installed(() => new Response("cloudflare", { status }));
      const res = await sw.request("/");
      expect({ status, body: await res.text() }).toEqual({ status, body: "datei:/offline.html" });
    }
  });

  test("andere Fehler (500, 404, 401, 403) gehen unverändert durch", async () => {
    for (const status of [500, 404, 401, 403, 501, 505, 519, 531]) {
      const answer = new Response("fehler", { status });
      const sw = await installed(() => answer);
      expect(await sw.request("/")).toBe(answer);
    }
  });

  test("Weiterleitungen unverändert: 302 (Access, Login) und opaqueredirect, dieselbe Anfrage geht ans Netz", async () => {
    const redirect = new Response(null, { status: 302, headers: { Location: "https://team.cloudflareaccess.com/login" } });
    const sw = await installed(() => redirect);
    expect(await sw.request("/")).toBe(redirect);
    const opaque = await installed(() => ({ opaqueredirect: true }));
    expect(await opaque.request("/")).toBe(opaque.opaque);
    expect(opaque.netCalls.at(-1)).toBe("/");
  });

  test("ohne Cache (Worker noch nicht installiert): der Netzfehler bleibt beim Browser", async () => {
    const sw = load({ network: () => ({ error: true }) });
    await expect(sw.request("/")).rejects.toThrow("Failed to fetch");
  });

  test("Navigationen landen nie im Cache", async () => {
    const sw = await installed();
    for (const path of ["/", "/login", "/#/einstellungen", "/app.js"]) await sw.request(path);
    expect(sw.cacheKeys()).toEqual([...OFFLINE_ASSETS].sort());
  });
});

describe("Nicht angefasst", () => {
  test("/api, Dateien, Downloads und Live-Verbindungen, auch als Navigation im Browser", async () => {
    const sw = await installed(() => ({ error: true }));
    for (const path of ["/api", "/api/me", "/api/files/abc", "/api/conversations/x/attachments/y", "/api/conversations/x/events", "/api/telegram/events"]) {
      for (const mode of ["navigate", "cors", "same-origin", "no-cors"]) {
        expect({ path, mode, responded: await sw.request(path, { mode }) }).toEqual({ path, mode, responded: undefined });
      }
    }
    expect(sw.cacheKeys().some(k => k.startsWith("/api"))).toBe(false);
  });

  test("app.js, brand.js, Bilder und andere Unterressourcen: kein respondWith", async () => {
    const sw = await installed(() => ({ error: true }));
    for (const path of ["/app.js", "/settings.js", "/brand.js", "/login.js", "/icon-192.png", "/manifest.webmanifest", "/style.css?v=1"]) {
      expect({ path, responded: await sw.request(path, { mode: "no-cors" }) }).toEqual({ path, responded: undefined });
    }
  });

  test("andere Methoden und fremde Origins", async () => {
    const sw = await installed(() => ({ error: true }));
    expect(await sw.request("/", { method: "POST" })).toBeUndefined();
    expect(await sw.request("/", { origin: "https://anders.example.org" })).toBeUndefined();
  });
});

describe("Dateien der Offline-Seite", () => {
  test("zuerst aus dem Netz, bei Fehler oder 530 aus dem Cache", async () => {
    let mode: "ok" | "error" | "530" = "ok";
    const sw = await installed(path => (mode === "error" ? { error: true } : mode === "530" ? new Response("cf", { status: 530 }) : new Response(`netz:${path}`)));
    for (const path of ["/style.css", "/theme.js", "/offline.js", "/favicon.svg"]) {
      mode = "ok";
      expect(await (await sw.request(path, { mode: "no-cors" })).text()).toBe(`netz:${path}`);
      mode = "error";
      expect(await (await sw.request(path, { mode: "no-cors" })).text()).toBe(`datei:${path}`);
      mode = "530";
      expect(await (await sw.request(path, { mode: "no-cors" })).text()).toBe(`datei:${path}`);
    }
    // Aus dem Netz geholte Fassungen ersetzen den Cache nicht
    expect(sw.cacheKeys()).toEqual([...OFFLINE_ASSETS].sort());
  });
});

describe("Aufräumen und Übernahme", () => {
  test("activate löscht nur eigene ältere Caches, keine fremden derselben Origin", async () => {
    const sw = load({ network: path => new Response(`datei:${path}`) });
    for (const name of [`${BRAND.cli}-offline-${OLD}`, `${BRAND.cli}-offline-`, "andere-app", `${BRAND.cli}-sonstiges`, "workbox-precache"]) {
      sw.cacheStore.set(name, new Map());
    }
    await sw.lifecycle("install");
    await sw.lifecycle("activate");
    expect([...sw.cacheStore.keys()].sort()).toEqual(["andere-app", "workbox-precache", `${BRAND.cli}-sonstiges`, CACHE].sort());
  });

  test("skipWaiting nur auf die Nachricht der Seite, nicht beim Installieren", async () => {
    const sw = await installed();
    expect(sw.self.skipped).toBe(0);
    sw.dispatch("message", { data: { type: "etwas-anderes" } });
    sw.dispatch("message", { data: null });
    expect(sw.self.skipped).toBe(0);
    sw.dispatch("message", { data: { type: "skip-waiting" } });
    expect(sw.self.skipped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Auslieferung durch den Server
// ---------------------------------------------------------------------------

const root = await mkdtemp(join(tmpdir(), "tybo-sw-"));
const servers: WebServer[] = [];
let counter = 0;
afterAll(async () => {
  for (const s of servers.splice(0)) await s.stop();
  await rm(root, { recursive: true, force: true });
});

async function start(options: { tunnel?: boolean; publicDir?: string; uiVersion?: string } = {}): Promise<string> {
  const dir = join(root, `case-${++counter}`);
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: "test-passwort-lang", allowedHosts: [], ...(options.tunnel ? { publicOrigin: ORIGIN, access: ACCESS } : {}) },
    {
      sessionFile: join(dir, "sessions.json"),
      dataDir: join(dir, "web"),
      accessCerts: new FakeCerts().fetch,
      log: () => {},
      ...(options.publicDir ? { publicDir: options.publicDir } : {}),
      ...(options.uiVersion ? { uiVersion: options.uiVersion } : {}),
    }
  );
  servers.push(server);
  return server.url;
}

describe("Server", () => {
  test("sw.js, offline.html und offline.js ohne Sitzung, sw.js mit no-cache und eingesetzter Version", async () => {
    const url = await start({ uiVersion: VERSION });
    const sw = await fetch(`${url}/sw.js`, { redirect: "manual" });
    expect(sw.status).toBe(200);
    expect(sw.headers.get("content-type")).toContain("javascript");
    expect(sw.headers.get("cache-control")).toBe("no-cache");
    expect(sw.headers.get("service-worker-allowed")).toBeNull();
    const body = await sw.text();
    expect(body).toContain(`const CACHE_PREFIX = "${BRAND.cli}-offline-";`);
    expect(body).toContain(`const CACHE_NAME = CACHE_PREFIX + "${VERSION}";`);
    expect(body).not.toContain("{{");

    const page = await fetch(`${url}/offline.html`, { redirect: "manual" });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`<title>${BRAND.name} nicht erreichbar</title>`);
    expect(html).toContain("Erneut versuchen");
    expect(html).not.toContain("{{");
    const js = await fetch(`${url}/offline.js`, { redirect: "manual" });
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
  });

  test("reine CSS-Änderung ergibt neue sw.js-Bytes (neuer Worker, neuer Cache)", async () => {
    const copy = join(root, "public-copy");
    await cp(publicDir, copy, { recursive: true });
    const before = await (await fetch(`${await start({ publicDir: copy })}/sw.js`)).text();
    await writeFile(join(copy, "style.css"), `${await readFile(join(copy, "style.css"), "utf8")}\n/* geändert */\n`);
    const after = await (await fetch(`${await start({ publicDir: copy })}/sw.js`)).text();
    expect(after).not.toBe(before);
    expect(after).toContain(`CACHE_PREFIX + "${await computeUiVersion(copy)}"`);
  });

  test("über den Tunnel ohne gültigen Access-Nachweis 403, mit Nachweis erreichbar", async () => {
    const url = await start({ tunnel: true });
    const host = new URL(ORIGIN).host;
    for (const path of ["/sw.js", "/offline.html", "/offline.js"]) {
      const denied = await fetch(`${url}${path}`, { headers: { host, "cf-connecting-ip": "203.0.113.7" }, redirect: "manual" });
      expect({ path, status: denied.status }).toEqual({ path, status: 403 });
      expect(await denied.text()).toBe(ACCESS_DENIED_TEXT);
      const ok = await fetch(`${url}${path}`, { headers: { host, "cf-connecting-ip": "203.0.113.7", "cf-access-jwt-assertion": validJwt() }, redirect: "manual" });
      expect({ path, status: ok.status }).toEqual({ path, status: 200 });
      await ok.arrayBuffer();
    }
  });
});
