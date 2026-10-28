/**
 * Issue #98, Schritte 2 und 3 (Sicherheitstests): getunnelte Anfragen
 * (Loopback mit CF-Connecting-IP bei gesetztem WEB_PUBLIC_ORIGIN) brauchen
 * genau den öffentlichen Host und Origin, zählen in der Login-Bremse pro
 * Besucher-IP und bekommen ein Secure-Cookie. Ohne WEB_PUBLIC_ORIGIN bleibt
 * alles wie im Heimnetz. Keine lokalen Sonderrechte über den Tunnel.
 * Seit Issue #99 tragen getunnelte Anfragen hier einen gültigen
 * Access-Nachweis, damit diese Prüfungen erreichbar bleiben.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TUNNEL_UNKNOWN_CLIENT } from "../src/web/auth";
import type { RunTurnOptions, WebChat } from "../src/web/chat";
import { readCliToken } from "../src/web/cli-token";
import { createWebServer, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import { ACCESS, claims, FakeCerts, signJwt } from "./access-fixture";

/** Gültig bis 2100, damit auch Tests mit vorgestellter Uhr ihn annehmen */
const JWT = signJwt(claims(Date.now(), { exp: 4_102_444_800 }));

const PASSWORD = "test-passwort-lang";
const PUBLIC = "https://app.tybo.ai";
const VISITOR = "203.0.113.7";
const OTHER_VISITOR = "198.51.100.2";

const root = await mkdtemp(join(tmpdir(), "tybo-tunnel-"));
let counter = 0;
const servers: WebServer[] = [];

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

interface Ctx {
  /** Echte Adresse des Servers (immer 127.0.0.1, wie bei cloudflared) */
  url: string;
  port: string;
  /** Heimnetz-Origin, wie ihn der Browser bei http://127.0.0.1:<port> sendet */
  localOrigin: string;
  chat: RecordingChat;
  conversationId: string;
  cliToken: string;
  logs: string[];
}

async function start(
  options: { publicOrigin?: string | null; allowedHosts?: string[]; now?: () => number; demo?: boolean } = {}
): Promise<Ctx> {
  const dir = join(root, `case-${++counter}`);
  const store = new ConversationStore({ dir: join(dir, "web") });
  await store.load();
  const conversationId = (await store.createConversation("general")).id;
  const chat = new RecordingChat();
  const logs: string[] = [];
  const tokenFile = join(dir, "cli-token");
  const server = await createWebServer(
    {
      host: "127.0.0.1",
      port: 0,
      password: PASSWORD,
      allowedHosts: options.allowedHosts ?? [],
      publicOrigin: options.publicOrigin ?? null,
      access: ACCESS,
    },
    {
      sessionFile: join(dir, "sessions.json"),
      conversationStore: store,
      chat,
      cliTokenFile: tokenFile,
      keepaliveMs: 60_000,
      now: options.now,
      demo: options.demo,
      accessCerts: new FakeCerts().fetch,
      log: m => logs.push(m),
    }
  );
  servers.push(server);
  const port = new URL(server.url).port;
  const url = `http://127.0.0.1:${port}`;
  return { url, port, localOrigin: url, chat, conversationId, cliToken: (await readCliToken(tokenFile))!, logs };
}

/** Kopfzeilen, wie cloudflared sie für app.tybo.ai weiterreicht */
function tunnel(extra: Record<string, string> = {}, visitor = VISITOR): Record<string, string> {
  return {
    host: "app.tybo.ai",
    origin: PUBLIC,
    "cf-connecting-ip": visitor,
    "cf-ray": "8a1b2c3d4e5f-FRA",
    "cf-access-jwt-assertion": JWT,
    ...extra,
  };
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
    body: JSON.stringify({ text: "Hallo von unterwegs" }),
  });
}

function withoutOrigin(headers: Record<string, string>): Record<string, string> {
  const { origin: _, ...rest } = headers;
  return rest;
}

function cookieOf(res: Response): string {
  return res.headers.get("set-cookie")!.split(";")[0];
}

describe("ohne WEB_PUBLIC_ORIGIN unverändert", () => {
  test("Loopback mit CF-Connecting-IP: Heimnetz-Regeln, Login und Senden wie bisher", async () => {
    const ctx = await start();
    const local = { host: `127.0.0.1:${ctx.port}`, origin: ctx.localOrigin, "cf-connecting-ip": VISITOR };
    const res = await login(ctx, local);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).not.toContain("Secure");
    expect((await postMessage(ctx, { ...local, cookie: cookieOf(res) })).status).toBe(202);
    expect(ctx.logs).toContain("Login von 127.0.0.1");
  });

  test("öffentlicher Host und https-Origin werden abgelehnt", async () => {
    const ctx = await start();
    expect((await login(ctx, tunnel())).status).toBe(421);
    // Heimnetz-Host, aber https-Origin: fremd
    const res = await login(ctx, { host: `127.0.0.1:${ctx.port}`, origin: PUBLIC, "cf-connecting-ip": VISITOR });
    expect(res.status).toBe(403);
  });

  test("Login-Bremse zählt pro Verbindungsadresse, nicht pro Kopfzeile", async () => {
    const ctx = await start();
    const local = (ip: string) => ({ host: `127.0.0.1:${ctx.port}`, origin: ctx.localOrigin, "cf-connecting-ip": ip });
    for (let i = 0; i < 10; i++) expect((await login(ctx, local(`203.0.113.${i + 1}`), `falsch-${i}-xxxxxx`)).status).toBe(401);
    expect((await login(ctx, local("203.0.113.99"))).status).toBe(429);
    expect(ctx.logs).toContain("Fehlgeschlagener Login von 127.0.0.1");
  });

  test("Terminal-Schlüssel gilt wie bisher ohne Weiterleitungs-Kopfzeile, GET und Schreiben ohne Origin", async () => {
    const ctx = await start();
    const headers = { host: `127.0.0.1:${ctx.port}`, authorization: `Bearer ${ctx.cliToken}` };
    expect((await fetch(`${ctx.url}/api/me`, { headers })).status).toBe(200);
    expect((await postMessage(ctx, headers)).status).toBe(202);
    expect(ctx.chat.turns.map(t => t.text)).toEqual(["Hallo von unterwegs"]);
  });

  // Seit Issue #231: eine weitergeleitete Anfrage ist nie lokal, auch ohne WEB_PUBLIC_ORIGIN
  // (etwa `tailscale serve`, schon eingerichtet, aber tybo noch nicht neu gestartet)
  test("Terminal-Schlüssel mit Weiterleitungs-Kopfzeile: abgelehnt, nichts gesendet", async () => {
    for (const extra of [{ "cf-connecting-ip": VISITOR }, { "x-forwarded-for": "100.64.0.9" }, { "tailscale-user-login": "alex@example.org" }]) {
      const ctx = await start();
      const headers = { host: `127.0.0.1:${ctx.port}`, authorization: `Bearer ${ctx.cliToken}`, ...extra };
      expect((await fetch(`${ctx.url}/api/me`, { headers })).status).toBe(401);
      expect((await postMessage(ctx, headers)).status).toBe(401);
      expect(ctx.chat.turns).toEqual([]);
    }
  });
});

describe("getunnelt mit WEB_PUBLIC_ORIGIN", () => {
  test("richtiger Host und https-Origin: Login und Senden gehen", async () => {
    const ctx = await start({ publicOrigin: PUBLIC });
    const res = await login(ctx, tunnel());
    expect(res.status).toBe(200);
    const cookie = cookieOf(res);
    expect((await fetch(`${ctx.url}/api/me`, { headers: { ...tunnel(), cookie } })).status).toBe(200);
    expect((await postMessage(ctx, { ...tunnel(), cookie })).status).toBe(202);
    await Bun.sleep(20);
    expect(ctx.chat.turns.map(t => t.text)).toEqual(["Hallo von unterwegs"]);
  });

  test("falscher Host 421, auch mit Port, Heimnetz-Namen oder WEB_ALLOWED_HOSTS", async () => {
    const ctx = await start({ publicOrigin: PUBLIC, allowedHosts: ["mein-mac.local"] });
    const hosts = [
      "app.tybo.ai:443",
      `app.tybo.ai:${ctx.port}`,
      "evil.tybo.ai",
      "app.tybo.ai.evil.example",
      `127.0.0.1:${ctx.port}`,
      `localhost:${ctx.port}`,
      `mein-mac.local:${ctx.port}`,
      "mein-mac.local",
    ];
    for (const host of hosts) {
      expect((await login(ctx, tunnel({ host }))).status).toBe(421);
      expect((await fetch(`${ctx.url}/api/me`, { headers: tunnel({ host }) })).status).toBe(421);
    }
  });

  test("falscher, fehlender oder null-Origin 403 beim Login und beim Senden", async () => {
    const ctx = await start({ publicOrigin: PUBLIC });
    const cookie = cookieOf(await login(ctx, tunnel()));
    const origins = ["http://app.tybo.ai", "https://app.tybo.ai:443", "https://evil.example", ctx.localOrigin, "null", "HTTPS://APP.TYBO.AI"];
    for (const origin of origins) {
      expect((await login(ctx, tunnel({ origin }))).status).toBe(403);
      expect((await postMessage(ctx, tunnel({ origin, cookie }))).status).toBe(403);
    }
    expect((await login(ctx, withoutOrigin(tunnel()))).status).toBe(403);
    expect((await postMessage(ctx, { ...withoutOrigin(tunnel()), cookie })).status).toBe(403);
    expect(ctx.chat.turns).toEqual([]);
  });

  test("nicht getunnelte Anfragen bleiben wie im Heimnetz", async () => {
    const ctx = await start({ publicOrigin: PUBLIC });
    const local = { host: `127.0.0.1:${ctx.port}`, origin: ctx.localOrigin };
    const res = await login(ctx, local);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).not.toContain("Secure");
    expect((await postMessage(ctx, { ...local, cookie: cookieOf(res) })).status).toBe(202);
    // Öffentlicher Host ohne Tunnel-Kopfzeile: kein erlaubter Heimnetz-Host
    expect((await login(ctx, { host: "app.tybo.ai", origin: PUBLIC })).status).toBe(421);
    // Heimnetz-Anfrage mit https-Origin: fremd
    expect((await login(ctx, { ...local, origin: PUBLIC })).status).toBe(403);
  });

  test("Login-Bremse pro CF-Connecting-IP: getrennte Sperren, lokale Anmeldung bleibt frei", async () => {
    let now = 1_800_000_000_000;
    const ctx = await start({ publicOrigin: PUBLIC, now: () => now });
    for (let i = 0; i < 10; i++) expect((await login(ctx, tunnel(), `falsch-${i}-xxxxxx`)).status).toBe(401);
    expect((await login(ctx, tunnel())).status).toBe(429);
    // Anderer Besucher und die echte lokale Verbindung sind nicht gesperrt
    expect((await login(ctx, tunnel({}, OTHER_VISITOR))).status).toBe(200);
    expect((await login(ctx, { host: `127.0.0.1:${ctx.port}`, origin: ctx.localOrigin })).status).toBe(200);
    // Ein Besucher mit angeblicher Adresse 127.0.0.1 sperrt die lokale Anmeldung nicht
    for (let i = 0; i < 10; i++) await login(ctx, tunnel({}, "127.0.0.1"), `falsch-${i}-xxxxxx`);
    expect((await login(ctx, tunnel({}, "127.0.0.1"))).status).toBe(429);
    expect((await login(ctx, { host: `127.0.0.1:${ctx.port}`, origin: ctx.localOrigin })).status).toBe(200);
    now += 15 * 60 * 1000;
    expect((await login(ctx, tunnel())).status).toBe(200);
  });

  test("Log nennt die Besucher-IP mit Hinweis Tunnel, nie beliebigen Kopfzeilentext", async () => {
    const ctx = await start({ publicOrigin: PUBLIC });
    await login(ctx, tunnel(), "falsch-xxxxxxxxxx");
    await login(ctx, tunnel({}, OTHER_VISITOR));
    await login(ctx, tunnel({}, "boese <zeile> 1.2.3.4"), "falsch-xxxxxxxxxx");
    expect(ctx.logs).toContain(`Fehlgeschlagener Login von ${VISITOR} (Tunnel)`);
    expect(ctx.logs).toContain(`Login von ${OTHER_VISITOR} (Tunnel)`);
    expect(ctx.logs).toContain(`Fehlgeschlagener Login von ${TUNNEL_UNKNOWN_CLIENT} (Tunnel)`);
    expect(ctx.logs.join("\n")).not.toContain("boese");
  });

  test("ungültige Besucher-IPs teilen sich eine Sperre (kein Umgehen mit wechselndem Text)", async () => {
    const ctx = await start({ publicOrigin: PUBLIC });
    for (let i = 0; i < 10; i++) await login(ctx, tunnel({}, `kaputt-${i}`), `falsch-${i}-xxxxxx`);
    expect((await login(ctx, tunnel({}, "noch-anders"))).status).toBe(429);
    expect((await login(ctx, tunnel({}, ""))).status).toBe(429);
    expect((await login(ctx, tunnel())).status).toBe(200);
  });

  test("Terminal-Schlüssel über den Tunnel: 401, auch mit ungültiger Besucher-IP", async () => {
    const ctx = await start({ publicOrigin: PUBLIC });
    const auth = { authorization: `Bearer ${ctx.cliToken}` };
    for (const visitor of [VISITOR, "127.0.0.1", "", "kaputt"]) {
      expect((await fetch(`${ctx.url}/api/me`, { headers: { ...tunnel({}, visitor), ...auth } })).status).toBe(401);
      expect((await postMessage(ctx, { ...withoutOrigin(tunnel({}, visitor)), ...auth })).status).toBe(401);
    }
    expect(ctx.chat.turns).toEqual([]);
    // Lokal gilt er weiter
    expect((await fetch(`${ctx.url}/api/me`, { headers: auth })).status).toBe(200);
  });

  test("Demo-Session gilt nicht über den Tunnel", async () => {
    const ctx = await start({ publicOrigin: PUBLIC, demo: true });
    expect((await fetch(`${ctx.url}/api/me`)).status).toBe(200);
    expect((await fetch(`${ctx.url}/api/me`, { headers: tunnel() })).status).toBe(401);
  });
});

describe("Secure-Cookie nur getunnelt", () => {
  test("Login und Abmelden über den Tunnel setzen Secure, alle übrigen Attribute bleiben", async () => {
    const ctx = await start({ publicOrigin: PUBLIC });
    const res = await login(ctx, tunnel());
    const set = res.headers.get("set-cookie")!;
    expect(set).toMatch(/; Secure$/);
    for (const part of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=2592000"]) expect(set).toContain(part);
    const out = await fetch(`${ctx.url}/api/logout`, { method: "POST", headers: { ...tunnel(), cookie: cookieOf(res) } });
    expect(out.status).toBe(200);
    const cleared = out.headers.get("set-cookie")!;
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toMatch(/; Secure$/);
    // Abgemeldet: das alte Cookie gilt nicht mehr
    expect((await fetch(`${ctx.url}/api/me`, { headers: { ...tunnel(), cookie: cookieOf(res) } })).status).toBe(401);
  });

  test("im Heimnetz ohne Secure, mit und ohne WEB_PUBLIC_ORIGIN, auch mit fremder Tunnel-Kopfzeile", async () => {
    for (const publicOrigin of [null, PUBLIC]) {
      const ctx = await start({ publicOrigin });
      const cases: Record<string, string>[] = [{ host: `127.0.0.1:${ctx.port}`, origin: ctx.localOrigin }];
      // Ohne WEB_PUBLIC_ORIGIN ist auch Loopback mit Kopfzeile nicht getunnelt
      if (!publicOrigin) cases.push({ ...cases[0], "cf-connecting-ip": VISITOR });
      for (const headers of cases) {
        const res = await login(ctx, headers);
        expect(res.status).toBe(200);
        expect(res.headers.get("set-cookie")).not.toContain("Secure");
        const out = await fetch(`${ctx.url}/api/logout`, { method: "POST", headers: { ...headers, cookie: cookieOf(res) } });
        expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
        expect(out.headers.get("set-cookie")).not.toContain("Secure");
      }
    }
  });
});
