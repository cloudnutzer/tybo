/**
 * Issue #231, Checkbox 2 (Sicherheitstests): Anfragen über `tailscale serve`
 * kommen wie beim Cloudflare Tunnel von 127.0.0.1. Sie gelten als von
 * unterwegs, nie als lokal: Login nur mit dem WebUI-Passwort, Cookie mit
 * Secure, Login-Bremse pro Tailnet-Adresse, kein Terminal-Schlüssel, keine
 * Demo-Anmeldung, Schlüssel nur lesbar. Erkannt an den Kopfzeilen von
 * Tailscale und, auch ohne sie (getaggte Geräte), am genau konfigurierten
 * Host. Cloudflare bekommt über Tailscale-Kopfzeilen keinen Access-Bypass.
 * Alles mit Attrappen, kein Netz, kein tailscale.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestOrigin, TUNNEL_UNKNOWN_CLIENT } from "../src/web/auth";
import type { RunTurnOptions, WebChat } from "../src/web/chat";
import { readCliToken } from "../src/web/cli-token";
import { loadWebConfig, remoteKind, type AccessConfig } from "../src/web/config";
import { KEYS_TEXT, type KeysPort } from "../src/web/keys";
import { ACCESS_DENIED_TEXT, createWebServer, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import { ACCESS, FakeCerts } from "./access-fixture";
import { startSetup, type Started } from "./setup-web-fixture";

const PASSWORD = "test-passwort-lang";
const TS_HOST = "rechner.tailnet-beispiel.ts.net";
const TS_ORIGIN = `https://${TS_HOST}`;
const PEER = "100.64.0.9";
const OTHER_PEER = "100.64.0.10";

const root = await mkdtemp(join(tmpdir(), "tybo-tailscale-"));
let counter = 0;
const servers: WebServer[] = [];
const setups: Started[] = [];

afterEach(async () => {
  for (const s of setups.splice(0)) await s.server.stop();
});
afterAll(async () => {
  for (const s of servers.splice(0)) await s.stop();
  await rm(root, { recursive: true, force: true });
});

class RecordingChat implements WebChat {
  turns: RunTurnOptions[] = [];
  async runTurn(opts: RunTurnOptions) {
    this.turns.push(opts);
    return { text: "Antwort" };
  }
  stop() {}
}

// Platzhalter, keine echten Schlüssel
const OLD_KEY = "platzhalter-openai-alt-Q7x2";

interface Ctx {
  url: string;
  port: string;
  chat: RecordingChat;
  conversationId: string;
  cliToken: string;
  logs: string[];
  env: Map<string, string>;
  certs: FakeCerts;
}

async function start(options: { publicOrigin?: string | null; access?: AccessConfig | null; demo?: boolean } = {}): Promise<Ctx> {
  const dir = join(root, `case-${++counter}`);
  const store = new ConversationStore({ dir: join(dir, "web") });
  await store.load();
  const conversationId = (await store.createConversation("general")).id;
  const chat = new RecordingChat();
  const logs: string[] = [];
  const tokenFile = join(dir, "cli-token");
  const certs = new FakeCerts();
  const env = new Map([["WEB_ALLOW_KEY_EDIT", "true"], ["OPENAI_API_KEY", OLD_KEY]]);
  const atStart = Object.fromEntries(env);
  const keys: KeysPort = {
    read: async () => Object.fromEntries(env),
    set: async (name, value) => void env.set(name, value),
    remove: async name => env.delete(name),
    running: () => atStart,
    editEnabledAtStart: () => true,
  };
  const server = await createWebServer(
    {
      host: "127.0.0.1",
      port: 0,
      password: PASSWORD,
      allowedHosts: [],
      publicOrigin: options.publicOrigin === undefined ? TS_ORIGIN : options.publicOrigin,
      access: options.access ?? null,
    },
    {
      sessionFile: join(dir, "sessions.json"),
      conversationStore: store,
      chat,
      cliTokenFile: tokenFile,
      keepaliveMs: 60_000,
      demo: options.demo,
      accessCerts: certs.fetch,
      keys,
      log: m => logs.push(m),
    },
  );
  servers.push(server);
  const port = new URL(server.url).port;
  return { url: `http://127.0.0.1:${port}`, port, chat, conversationId, cliToken: (await readCliToken(tokenFile))!, logs, env, certs };
}

/** Kopfzeilen, wie `tailscale serve` sie bei einem Gerät mit Nutzer weiterreicht */
function viaTailscale(extra: Record<string, string> = {}, peer = PEER): Record<string, string> {
  return {
    host: TS_HOST,
    origin: TS_ORIGIN,
    "x-forwarded-host": TS_HOST,
    "x-forwarded-proto": "https",
    "x-forwarded-for": peer,
    "tailscale-user-login": "alex@example.org",
    "tailscale-user-name": "Alex",
    "tailscale-headers-info": "https://tailscale.com/s/serve-headers",
    ...extra,
  };
}

/** Getaggtes Gerät: keine Identitäts-Kopfzeilen, nur Weiterleitung */
function taggedDevice(peer = PEER): Record<string, string> {
  return { host: TS_HOST, origin: TS_ORIGIN, "x-forwarded-host": TS_HOST, "x-forwarded-proto": "https", "x-forwarded-for": peer };
}

function login(ctx: Ctx, headers: Record<string, string>, password = PASSWORD) {
  return fetch(`${ctx.url}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ password }),
  });
}

function postMessage(ctx: Ctx, headers: Record<string, string>) {
  return fetch(`${ctx.url}/api/conversations/${ctx.conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ text: "Hallo aus dem Tailnet" }),
  });
}

function cookieOf(res: Response): string {
  return res.headers.get("set-cookie")!.split(";")[0];
}

describe("Konfiguration", () => {
  test("ts.net-Adresse ohne Access: Tailscale; mit Access oder andere Domain: Cloudflare", () => {
    const base = { WEB_ENABLED: "true", WEB_PASSWORD: PASSWORD };
    const ts = loadWebConfig({ ...base, WEB_PUBLIC_ORIGIN: TS_ORIGIN });
    expect(ts.status).toBe("ok");
    if (ts.status === "ok") expect(remoteKind(ts.config)).toBe("tailscale");
    const mixed = loadWebConfig({ ...base, WEB_PUBLIC_ORIGIN: TS_ORIGIN, WEB_ACCESS_TEAM: ACCESS.team, WEB_ACCESS_AUD: ACCESS.aud });
    if (mixed.status === "ok") expect(remoteKind(mixed.config)).toBe("cloudflare");
    const cf = loadWebConfig({ ...base, WEB_PUBLIC_ORIGIN: "https://tybo.example.org" });
    if (cf.status === "ok") expect(remoteKind(cf.config)).toBe("cloudflare");
    const none = loadWebConfig(base);
    if (none.status === "ok") expect(remoteKind(none.config)).toBeNull();
  });

  test("requestOrigin: Tailscale-Kopfzeilen, getaggtes Gerät und öffentlicher Host sind von unterwegs, nie lokal", () => {
    const req = (headers: Record<string, string>) => new Request("http://127.0.0.1:3100/api/me", { headers });
    expect(requestOrigin(req(viaTailscale()), "127.0.0.1", TS_ORIGIN, "tailscale")).toEqual({
      tunneled: true,
      via: "tailscale",
      local: false,
      clientIp: PEER,
    });
    expect(requestOrigin(req(taggedDevice()), "127.0.0.1", TS_ORIGIN, "tailscale").via).toBe("tailscale");
    // Ganz ohne Kopfzeilen, nur der Host aus WEB_PUBLIC_ORIGIN
    expect(requestOrigin(req({ host: TS_HOST }), "::1", TS_ORIGIN, "tailscale")).toMatchObject({ tunneled: true, local: false });
    // Ungültige oder mehrfache Tailnet-Adresse: Platzhalter
    expect(requestOrigin(req(viaTailscale({ "x-forwarded-for": `${PEER}, ${OTHER_PEER}` })), "127.0.0.1", TS_ORIGIN, "tailscale").clientIp).toBe(
      TUNNEL_UNKNOWN_CLIENT,
    );
    // Echt lokal bleibt lokal
    expect(requestOrigin(req({ host: "127.0.0.1:3100" }), "127.0.0.1", TS_ORIGIN, "tailscale")).toEqual({
      tunneled: false,
      via: null,
      local: true,
      clientIp: "127.0.0.1",
    });
    // Cloudflare-Kopfzeilen bei Tailscale-Weg: gilt als Cloudflare (ohne Access abgelehnt)
    expect(requestOrigin(req(viaTailscale({ "cf-connecting-ip": "203.0.113.7" })), "127.0.0.1", TS_ORIGIN, "tailscale").via).toBe("cloudflare");
    // Andere Verbindungsadresse: Kopfzeilen zählen nicht
    expect(requestOrigin(req(viaTailscale()), "192.168.1.20", TS_ORIGIN, "tailscale")).toMatchObject({ tunneled: false, local: false });
  });
});

describe("über Tailscale", () => {
  test("Login nur mit WebUI-Passwort, Cookie mit Secure, Log nennt Tailscale, danach Senden", async () => {
    const ctx = await start();
    expect((await fetch(`${ctx.url}/api/me`, { headers: viaTailscale() })).status).toBe(401);
    const page = await fetch(`${ctx.url}/`, { headers: viaTailscale(), redirect: "manual" });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/login");
    expect((await login(ctx, viaTailscale(), "falsches-passwort-xyz")).status).toBe(401);
    const res = await login(ctx, viaTailscale());
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("; Secure");
    expect(ctx.logs).toContain(`Login von ${PEER} (Tailscale)`);
    expect(ctx.logs).toContain(`Fehlgeschlagener Login von ${PEER} (Tailscale)`);
    expect(ctx.logs).toContain("Zugang von unterwegs über Tailscale (WEB_PUBLIC_ORIGIN), Anmeldung mit dem WebUI-Passwort");
    expect((await postMessage(ctx, { ...viaTailscale(), cookie: cookieOf(res) })).status).toBe(202);
    // Kein Access-Abruf über Tailscale
    expect(ctx.certs.calls).toEqual([]);
  });

  test("getaggtes Gerät ohne Identitäts-Kopfzeilen: ebenfalls von unterwegs, Passwort Pflicht", async () => {
    const ctx = await start();
    expect((await fetch(`${ctx.url}/api/me`, { headers: taggedDevice() })).status).toBe(401);
    const res = await login(ctx, taggedDevice());
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("; Secure");
  });

  test("nur der genau eingerichtete Host, keine pauschale ts.net-Freigabe; schreibend nur mit genau diesem Origin", async () => {
    const ctx = await start();
    const other = viaTailscale({ host: "anderes-geraet.tailnet-beispiel.ts.net", origin: "https://anderes-geraet.tailnet-beispiel.ts.net" });
    expect((await login(ctx, other)).status).toBe(421);
    expect((await login(ctx, viaTailscale({ host: `127.0.0.1:${ctx.port}` }))).status).toBe(421);
    expect((await login(ctx, viaTailscale({ origin: `http://${TS_HOST}` }))).status).toBe(403);
    expect((await login(ctx, viaTailscale({ origin: "https://boese.example.org" }))).status).toBe(403);
  });

  test("Login-Bremse pro Tailnet-Adresse, getrennt vom lokalen Zugang", async () => {
    const ctx = await start();
    for (let i = 0; i < 10; i++) expect((await login(ctx, viaTailscale(), `falsch-${i}-xxxxxxxx`)).status).toBe(401);
    expect((await login(ctx, viaTailscale())).status).toBe(429);
    expect((await login(ctx, viaTailscale({}, OTHER_PEER))).status).toBe(200);
    const local = { host: `127.0.0.1:${ctx.port}`, origin: ctx.url };
    expect((await login(ctx, local)).status).toBe(200);
  });

  test("Terminal-Schlüssel gilt nicht, auch nicht ohne Kopfzeilen mit öffentlichem Host", async () => {
    const ctx = await start();
    const bearer = { authorization: `Bearer ${ctx.cliToken}` };
    for (const headers of [viaTailscale(), taggedDevice(), { host: TS_HOST }]) {
      expect((await fetch(`${ctx.url}/api/me`, { headers: { ...headers, ...bearer } })).status).toBe(401);
      expect((await postMessage(ctx, { ...headers, ...bearer })).status).toBe(401);
    }
    expect(ctx.chat.turns).toEqual([]);
    expect(ctx.logs).toContain(`Terminal-Anmeldung abgelehnt von ${PEER} (Tailscale)`);
    // Lokal gilt derselbe Schlüssel
    expect((await fetch(`${ctx.url}/api/me`, { headers: { host: `127.0.0.1:${ctx.port}`, ...bearer } })).status).toBe(200);
  });

  test("Demo-Anmeldung gilt nur lokal, nie über Tailscale", async () => {
    const ctx = await start({ demo: true });
    expect((await fetch(`${ctx.url}/api/me`, { headers: { host: `127.0.0.1:${ctx.port}` } })).status).toBe(200);
    expect((await fetch(`${ctx.url}/api/me`, { headers: viaTailscale() })).status).toBe(401);
    expect((await fetch(`${ctx.url}/api/me`, { headers: taggedDevice() })).status).toBe(401);
  });

  test("Schlüssel nur lesbar: Sperrgrund tunnel, PUT und DELETE 403, nichts geändert", async () => {
    const ctx = await start();
    const cookie = cookieOf(await login(ctx, viaTailscale()));
    const remote = { ...viaTailscale(), cookie };
    const list = (await (await fetch(`${ctx.url}/api/keys`, { headers: remote })).json()) as any;
    expect(list.editAllowed).toBe(false);
    expect(list.readOnlyReason).toBe("tunnel");
    const put = await fetch(`${ctx.url}/api/keys/OPENAI_API_KEY`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...remote },
      body: JSON.stringify({ value: "platzhalter-openai-neu-Z9k4" }),
    });
    expect(put.status).toBe(403);
    expect(await put.json()).toEqual({ error: KEYS_TEXT.homeOnly, editAllowed: false, homeOnly: true });
    const del = await fetch(`${ctx.url}/api/keys/OPENAI_API_KEY`, { method: "DELETE", headers: remote });
    expect(del.status).toBe(403);
    expect(Object.fromEntries(ctx.env)).toEqual({ WEB_ALLOW_KEY_EDIT: "true", OPENAI_API_KEY: OLD_KEY });
  });

  test("Cloudflare-Kopfzeilen bei eingerichtetem Tailscale: abgelehnt wie ein Tunnel ohne Access", async () => {
    const ctx = await start();
    const res = await login(ctx, viaTailscale({ "cf-connecting-ip": "203.0.113.7", "cf-access-jwt-assertion": "irgendwas" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: ACCESS_DENIED_TEXT });
  });
});

// `tailscale serve` läuft schon vor dem Neustart (ohne WEB_PUBLIC_ORIGIN) und
// bleibt nach dem Wechsel zu Cloudflare bestehen; es übernimmt den Host des
// Browsers, eine Weiterleitung auf localhost besteht also die Heimnetz-Prüfungen
describe("weitergeleitet ohne passende öffentliche Adresse", () => {
  const configs: Array<[string, { publicOrigin: string | null; access: AccessConfig | null }]> = [
    ["ohne WEB_PUBLIC_ORIGIN", { publicOrigin: null, access: null }],
    ["nach Wechsel zu Cloudflare", { publicOrigin: "https://tybo.example.org", access: ACCESS }],
  ];
  for (const [name, options] of configs) {
    test(`${name}: Schlüssel nur lesbar, PUT und DELETE 403, nichts geändert`, async () => {
      const ctx = await start(options);
      const host = `localhost:${ctx.port}`;
      const forwarded = viaTailscale({ host, origin: `http://${host}`, "x-forwarded-host": host });
      const res = await login(ctx, forwarded);
      expect(res.status).toBe(200);
      const remote = { ...forwarded, cookie: cookieOf(res) };
      const list = (await (await fetch(`${ctx.url}/api/keys`, { headers: remote })).json()) as any;
      expect(list.editAllowed).toBe(false);
      expect(list.readOnlyReason).toBe("tunnel");
      const put = await fetch(`${ctx.url}/api/keys/OPENAI_API_KEY`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...remote },
        body: JSON.stringify({ value: "platzhalter-openai-neu-Z9k4" }),
      });
      expect(put.status).toBe(403);
      expect(await put.json()).toEqual({ error: KEYS_TEXT.homeOnly, editAllowed: false, homeOnly: true });
      const del = await fetch(`${ctx.url}/api/keys/OPENAI_API_KEY`, { method: "DELETE", headers: remote });
      expect(del.status).toBe(403);
      expect(Object.fromEntries(ctx.env)).toEqual({ WEB_ALLOW_KEY_EDIT: "true", OPENAI_API_KEY: OLD_KEY });

      // Gegenprobe: dieselbe Session ohne Weiterleitungs-Kopfzeilen darf ändern
      const local = { host, origin: `http://${host}`, cookie: remote.cookie };
      expect(((await (await fetch(`${ctx.url}/api/keys`, { headers: local })).json()) as any).editAllowed).toBe(true);
    });
  }
});

describe("kein Access-Bypass bei Cloudflare", () => {
  const PUBLIC = "https://app.tybo.ai";

  test("Tailscale-Kopfzeilen zusätzlich zum Tunnel ersetzen den Access-Nachweis nicht", async () => {
    const ctx = await start({ publicOrigin: PUBLIC, access: ACCESS });
    const headers = {
      host: "app.tybo.ai",
      origin: PUBLIC,
      "cf-connecting-ip": "203.0.113.7",
      "tailscale-user-login": "alex@example.org",
      "x-forwarded-for": PEER,
    };
    const res = await login(ctx, headers);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: ACCESS_DENIED_TEXT });
    expect((await fetch(`${ctx.url}/`, { headers, redirect: "manual" })).status).toBe(403);
  });

  test("ts.net-Adresse mit Access-Werten: Cloudflare-Regeln, Tailscale-Anfrage ohne Nachweis abgelehnt", async () => {
    const ctx = await start({ access: ACCESS });
    // Ohne CF-Connecting-IP keine Tunnel-Anfrage, der ts.net-Host passt dann nicht zum Heimnetz
    expect((await login(ctx, viaTailscale())).status).toBe(421);
    expect(ctx.logs).not.toContain("Zugang von unterwegs über Tailscale (WEB_PUBLIC_ORIGIN), Anmeldung mit dem WebUI-Passwort");
  });
});

describe("Einrichtungsmodus", () => {
  test("Tailscale-Kopfzeilen und ts.net-Host: abgelehnt, auch ohne WEB_PUBLIC_ORIGIN", async () => {
    const s = await startSetup();
    setups.push(s);
    const localHost = `127.0.0.1:${s.server.port}`;
    for (const headers of [viaTailscale({ host: localHost }), { host: localHost, "x-forwarded-host": TS_HOST }]) {
      const res = await fetch(`${s.base}/api/setup/overview`, { headers });
      expect(res.status).toBe(403);
    }
    const res = await fetch(`${s.base}/api/setup/overview`, { headers: { host: TS_HOST } });
    expect(res.status).toBe(421);
  });
});
