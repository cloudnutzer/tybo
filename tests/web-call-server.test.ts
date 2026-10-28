/**
 * Telefonhörer im Server (Issue #257, Checkbox 1): WebSocket GET /api/call
 * über den echten Server auf einem freien Port, mit CallPort-Attrappe.
 * Geprüft: kein Upgrade ohne Sitzung, mit fremdem oder fehlendem Origin,
 * vom Terminal oder über den Tunnel ohne Access-Nachweis; besetzt; siebter
 * Start in 10 Minuten; zu große und unbekannte Nachrichten; Abmelden beendet
 * das Gespräch; CSP unverändert, Permissions-Policy neu; modes.call.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CALL_CLOSE, CALL_PATH } from "../src/web/call";
import { createWebServer, SECURITY_HEADERS, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import type { VoicePort } from "../src/web/voice";
import { ACCESS, FakeCerts, validJwt } from "./access-fixture";
import { fakePort, READY_STATUS, type FakePortControl } from "./call-fixture";

const PASSWORD = "test-passwort-telefon";
const PUBLIC = "https://app.example.org";
const dirs: string[] = [];
const servers: WebServer[] = [];

// Jeder Stopp wartet nach serverseitig geschlossenen Verbindungen bis zu 2 s (Bun, siehe server.ts)
afterAll(async () => {
  await Promise.all(servers.map(s => s.stop()));
  for (const d of dirs) await rm(d, { recursive: true, force: true });
}, 30_000);

const voice: VoicePort = {
  localMode: () => ({ ready: true, stt: { id: "parakeet", label: "Parakeet", local: true, available: true }, tts: { id: "browser", label: "Browser-Stimme", where: "browser", available: true } }),
};

interface Ctx {
  url: string;
  wsUrl: string;
  host: string;
  cookie: string;
  conversationId: string;
  port: FakePortControl;
  logs: string[];
}

async function start(o: { call?: boolean; tunnel?: boolean } = {}): Promise<Ctx> {
  const dir = await mkdtemp(join(tmpdir(), "tybo-call-server-"));
  dirs.push(dir);
  const store = new ConversationStore({ dir: join(dir, "web") });
  await store.load();
  const conversation = await store.createConversation("general");
  const port = fakePort();
  const logs: string[] = [];
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [], ...(o.tunnel ? { publicOrigin: PUBLIC, access: ACCESS } : {}) },
    {
      sessionFile: join(dir, "sessions.json"),
      conversationStore: store,
      voice,
      ...(o.call === false ? {} : { call: port.port }),
      accessCerts: new FakeCerts().fetch,
      log: line => logs.push(line),
    }
  );
  servers.push(server);
  const url = server.url;
  const login = await fetch(`${url}/api/login`, { method: "POST", headers: { origin: url }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  return { url, wsUrl: url.replace(/^http/, "ws") + CALL_PATH, host: new URL(url).host, cookie, conversationId: conversation.id, port, logs };
}

const UPGRADE = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };

/** Handshake per fetch: zeigt den Status ohne Upgrade */
function handshake(ctx: Ctx, headers: Record<string, string>): Promise<Response> {
  return fetch(ctx.url + CALL_PATH, { headers: { ...UPGRADE, ...headers } });
}

interface Client {
  ws: WebSocket;
  messages: Array<Record<string, any>>;
  binary: number;
  closed: Promise<{ code: number; reason: string }>;
  next(type: string, timeoutMs?: number): Promise<Record<string, any>>;
}

function connect(ctx: Ctx, headers: Record<string, string> = { cookie: ctx.cookie, origin: ctx.url }): Client {
  const ws = new WebSocket(ctx.wsUrl, { headers } as any);
  ws.binaryType = "arraybuffer";
  const client: Client = {
    ws,
    messages: [],
    binary: 0,
    closed: new Promise(resolve => ws.addEventListener("close", e => resolve({ code: e.code, reason: e.reason }))),
    async next(type, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = client.messages.find(m => m.type === type);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`keine Nachricht ${type}: ${JSON.stringify(client.messages)}`);
        await Bun.sleep(5);
      }
    },
  };
  ws.addEventListener("message", e => {
    if (typeof e.data === "string") client.messages.push(JSON.parse(e.data));
    else client.binary++;
  });
  return client;
}

function opened(c: Client): Promise<void> {
  return new Promise((resolve, reject) => {
    if (c.ws.readyState === WebSocket.OPEN) return resolve();
    c.ws.addEventListener("open", () => resolve());
    c.ws.addEventListener("error", () => reject(new Error("Verbindung gescheitert")));
  });
}

describe("Upgrade nur mit Sitzung, Origin und Nachweis", () => {
  test("ohne Sitzung 401, kein Upgrade", async () => {
    const ctx = await start();
    const res = await handshake(ctx, { origin: ctx.url });
    expect(res.status).toBe(401);
    expect(res.headers.get("upgrade")).toBeNull();
    const c = connect(ctx, { origin: ctx.url });
    const closed = await c.closed;
    expect(closed.code).not.toBe(CALL_CLOSE.normal);
    expect(ctx.port.opened).toEqual([]);
  });

  test("fremder Origin 403, fehlender Origin 403", async () => {
    const ctx = await start();
    expect((await handshake(ctx, { cookie: ctx.cookie, origin: "http://evil.example" })).status).toBe(403);
    expect((await handshake(ctx, { cookie: ctx.cookie })).status).toBe(403);
    // Gleicher Host, anderes Schema: auch fremd
    expect((await handshake(ctx, { cookie: ctx.cookie, origin: `https://${ctx.host}` })).status).toBe(403);
  });

  test("mit Sitzung und eigenem Origin: Upgrade, ready nach start", async () => {
    const ctx = await start();
    const c = connect(ctx);
    await opened(c);
    c.ws.send(JSON.stringify({ type: "start", conversationId: ctx.conversationId, tts: "server" }));
    const ready = await c.next("ready");
    expect(ready).toMatchObject({ model: "claude-sonnet-5-5", via: "api", stt: "parakeet", tts: "server", sampleRate: 24000 });
    expect(ctx.port.opened).toEqual([{ conversationId: ctx.conversationId, agent: "general", tts: "server" }]);
    c.ws.send(JSON.stringify({ type: "hangup" }));
    expect((await c.closed).code).toBe(CALL_CLOSE.normal);
    expect(c.messages.at(-1)).toMatchObject({ type: "ended", reason: "aufgelegt" });
    expect(ctx.port.lines[0]!.closed).toBe(1);
  });

  test("unbekanntes Gespräch: error gespraech, kein open", async () => {
    const ctx = await start();
    const c = connect(ctx);
    await opened(c);
    c.ws.send(JSON.stringify({ type: "start", conversationId: "gibt-es-nicht", tts: "browser" }));
    expect(await c.next("error")).toMatchObject({ reason: "gespraech" });
    await c.closed;
    expect(ctx.port.opened).toEqual([]);
  });

  test("Terminal-Schlüssel statt Browser: kein Upgrade", async () => {
    const ctx = await start();
    // Ein ungültiger Bearer endet schon vor der Route mit 401; mit Cookie und Bearer bleibt es ein Browser
    expect((await handshake(ctx, { authorization: "Bearer falsch", origin: ctx.url })).status).toBe(401);
  });

  test("über den Tunnel ohne Access-Nachweis 403, mit Nachweis Upgrade-fähig", async () => {
    const ctx = await start({ tunnel: true });
    const host = new URL(PUBLIC).host;
    const tunnel = { host, "cf-connecting-ip": "203.0.113.7", origin: PUBLIC };
    expect((await handshake(ctx, { ...tunnel, cookie: ctx.cookie })).status).toBe(403);
    // Mit Nachweis, aber ohne Sitzung: 401 (die Prüfung geht bis zur Anmeldung weiter)
    expect((await handshake(ctx, { ...tunnel, "cf-access-jwt-assertion": validJwt() })).status).toBe(401);
    // Mit Nachweis, Sitzung und falschem Origin: 403
    expect((await handshake(ctx, { ...tunnel, "cf-access-jwt-assertion": validJwt(), cookie: ctx.cookie, origin: ctx.url })).status).toBe(403);
  });

  test("ohne CallPort 503, ohne Upgrade-Kopf 426", async () => {
    const ctx = await start({ call: false });
    expect((await handshake(ctx, { cookie: ctx.cookie, origin: ctx.url })).status).toBe(503);
    const ctx2 = await start();
    expect((await fetch(ctx2.url + CALL_PATH, { headers: { cookie: ctx2.cookie, origin: ctx2.url } })).status).toBe(426);
    expect((await fetch(ctx2.url + CALL_PATH, { method: "POST", headers: { cookie: ctx2.cookie, origin: ctx2.url } })).status).toBe(405);
  });
});

describe("Grenzen", () => {
  test("zweites Gespräch: besetzt", async () => {
    const ctx = await start();
    const first = connect(ctx);
    await opened(first);
    const second = connect(ctx);
    const closed = await second.closed;
    expect(closed).toEqual({ code: CALL_CLOSE.busy, reason: "besetzt" });
    expect(first.ws.readyState).toBe(WebSocket.OPEN);
    first.ws.close();
    await first.closed;
  });

  test("siebter Start in 10 Minuten abgelehnt", async () => {
    const ctx = await start();
    for (let i = 0; i < 6; i++) {
      const c = connect(ctx);
      await opened(c);
      c.ws.send(JSON.stringify({ type: "hangup" }));
      expect((await c.closed).code).toBe(CALL_CLOSE.normal);
      // Der Platz wird beim Ende frei
      await Bun.sleep(10);
    }
    const seventh = connect(ctx);
    expect(await seventh.closed).toEqual({ code: CALL_CLOSE.tooMany, reason: "zu-viele" });
  });

  test("zu große Textnachricht schließt die Verbindung", async () => {
    const ctx = await start();
    const c = connect(ctx);
    await opened(c);
    c.ws.send(JSON.stringify({ type: "start", conversationId: "x".repeat(5000), tts: "server" }));
    expect((await c.closed).code).toBe(CALL_CLOSE.tooLarge);
  });

  test("zu große Binärnachricht schließt die Verbindung", async () => {
    const ctx = await start();
    const c = connect(ctx);
    await opened(c);
    c.ws.send(JSON.stringify({ type: "start", conversationId: ctx.conversationId, tts: "server" }));
    await c.next("ready");
    c.ws.send(new Uint8Array(64 * 1024 + 2));
    const closed = await c.closed;
    expect(closed.code).not.toBe(CALL_CLOSE.normal);
    expect(ctx.port.lines[0]!.closed).toBe(1);
  });

  test("unbekannte Nachricht schließt die Verbindung", async () => {
    const ctx = await start();
    const c = connect(ctx);
    await opened(c);
    c.ws.send(JSON.stringify({ type: "tool_call", name: "x" }));
    expect((await c.closed).code).toBe(CALL_CLOSE.protocol);
  });

  test("Abmelden beendet das laufende Gespräch", async () => {
    const ctx = await start();
    const c = connect(ctx);
    await opened(c);
    c.ws.send(JSON.stringify({ type: "start", conversationId: ctx.conversationId, tts: "browser" }));
    await c.next("ready");
    const out = await fetch(`${ctx.url}/api/logout`, { method: "POST", headers: { cookie: ctx.cookie, origin: ctx.url } });
    expect(out.status).toBe(200);
    expect(await c.closed).toEqual({ code: CALL_CLOSE.unauthorized, reason: "abgemeldet" });
    expect(c.messages.at(-1)).toMatchObject({ type: "ended", reason: "abgemeldet" });
    // Danach kein neues Gespräch mit dem alten Cookie
    expect((await handshake(ctx, { cookie: ctx.cookie, origin: ctx.url })).status).toBe(401);
  });

  test("Server-Stopp beendet das Gespräch", async () => {
    const ctx = await start();
    const c = connect(ctx);
    await opened(c);
    c.ws.send(JSON.stringify({ type: "start", conversationId: ctx.conversationId, tts: "browser" }));
    await c.next("ready");
    const server = servers.pop()!;
    await server.stop();
    // Bun meldet dem Client hier 1000 statt des gesendeten 1001; der Grund steht in ended
    await c.closed;
    expect(c.messages.at(-1)).toMatchObject({ type: "ended", reason: "server" });
    expect(ctx.port.lines[0]!.closed).toBe(1);
  });
});

describe("Kopfzeilen und Status", () => {
  test("CSP unverändert, Permissions-Policy neu", async () => {
    const ctx = await start();
    const res = await fetch(`${ctx.url}/login`);
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; " +
        "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; worker-src 'self'; manifest-src 'self'"
    );
    expect(res.headers.get("permissions-policy")).toBe("microphone=(self), camera=(self), geolocation=(), payment=()");
    expect(SECURITY_HEADERS["Permissions-Policy"]).toBe("microphone=(self), camera=(self), geolocation=(), payment=()");
  });

  test("GET /api/voice: modes.call aus dem CallPort, ohne ihn kein modes.call", async () => {
    const ctx = await start();
    const body = (await (await fetch(`${ctx.url}/api/voice`, { headers: { cookie: ctx.cookie } })).json()) as any;
    expect(body.modes.call).toEqual(READY_STATUS);
    expect(body.modes.local.ready).toBe(true);
    const without = await start({ call: false });
    const body2 = (await (await fetch(`${without.url}/api/voice`, { headers: { cookie: without.cookie } })).json()) as any;
    expect(body2.modes.call).toBeUndefined();
  });
});

describe("Protokoll-Parser und Ping", () => {
  test("nur bekannte Nachrichten mit genau den erlaubten Feldern", async () => {
    const { parseCallMessage } = await import("../src/web/call");
    expect(parseCallMessage('{"type":"start","conversationId":"abc-1","tts":"server"}')).toEqual({ type: "start", conversationId: "abc-1", tts: "server" });
    expect(parseCallMessage('{"type":"played","id":3}')).toEqual({ type: "played", id: 3 });
    expect(parseCallMessage('{"type":"mute","on":true}')).toEqual({ type: "mute", on: true });
    for (const t of ["utterance_pause", "utterance_end", "interrupt", "hangup"]) expect(parseCallMessage(JSON.stringify({ type: t }))).toEqual({ type: t } as any);
    for (const bad of [
      "kein json",
      "[]",
      "null",
      '{"type":"start","conversationId":"a","tts":"lautsprecher"}',
      '{"type":"start","conversationId":"a/../b","tts":"server"}',
      '{"type":"start","conversationId":"a","tts":"server","extra":1}',
      '{"type":"played","id":0}',
      '{"type":"played","id":1.5}',
      '{"type":"mute","on":"ja"}',
      '{"type":"hangup","grund":"x"}',
      '{"type":"tool","name":"x"}',
      JSON.stringify({ type: "start", conversationId: "a", tts: "server", pad: "x".repeat(5000) }),
    ]) {
      expect(parseCallMessage(bad)).toBeNull();
    }
  });

  test("Ping alle 25 s; abgelaufene Sitzung beendet das Gespräch", async () => {
    const { CallSession } = await import("../src/web/call-session");
    const { fakeClock, fakeSocket } = await import("./call-fixture");
    const clock = fakeClock();
    const s = fakeSocket();
    const port = fakePort();
    let ended = 0;
    const session = new CallSession({ socket: s.socket, port: port.port, checkConversation: async () => ({ ok: true, agent: "general" }), clock, log: () => {}, onEnd: () => ended++ });
    session.begin();
    session.receive(JSON.stringify({ type: "start", conversationId: "abc", tts: "browser" }));
    await clock.advance(0);
    await clock.advance(25_000);
    expect(s.state.pings).toBe(1);
    await clock.advance(25_000);
    expect(s.state.pings).toBe(2);
    s.state.authorized = false;
    await clock.advance(25_000);
    expect(s.state.closed).toEqual({ code: CALL_CLOSE.unauthorized, reason: "abgemeldet" });
    expect(ended).toBe(1);
  });

  test("ohne start binnen 10 s: Verbindung zu", async () => {
    const { CallSession } = await import("../src/web/call-session");
    const { fakeClock, fakeSocket } = await import("./call-fixture");
    const clock = fakeClock();
    const s = fakeSocket();
    const session = new CallSession({ socket: s.socket, port: fakePort().port, checkConversation: async () => ({ ok: true, agent: "general" }), clock, log: () => {}, onEnd: () => {} });
    session.begin();
    await clock.advance(9_999);
    expect(s.state.closed).toBeNull();
    await clock.advance(1);
    expect(s.json("ended")[0]).toMatchObject({ reason: "start" });
  });
});
