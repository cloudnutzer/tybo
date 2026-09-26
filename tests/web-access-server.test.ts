/**
 * Issue #99, Schritt 2 (Sicherheitstests): der Access-Nachweis in der
 * Anfragekette. Jede getunnelte Anfrage braucht einen gültigen
 * Cf-Access-Jwt-Assertion, geprüft vor Anmeldung, Body und Routing. Ist
 * WEB_PUBLIC_ORIGIN gesetzt, Access aber nicht, scheitern getunnelte
 * Anfragen immer. Nicht getunnelte Anfragen bleiben unberührt.
 * Schlüsselabruf und Chat sind Attrappen; nur lokale Testserver.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunTurnOptions, WebChat } from "../src/web/chat";
import type { AccessConfig } from "../src/web/config";
import { ACCESS_DENIED_TEXT, createWebServer, type WebServer } from "../src/web/server";
import { KEYS_TEXT, type KeysPort } from "../src/web/keys";
import { ConversationStore } from "../src/web/store";
import { ACCESS, claims, FakeCerts, KEY_A, makeKey, signJwt, validJwt } from "./access-fixture";

const PASSWORD = "test-passwort-lang";
const PUBLIC = "https://app.tybo.ai";
const VISITOR = "203.0.113.7";

const root = await mkdtemp(join(tmpdir(), "tybo-access-"));
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
  url: string;
  port: string;
  chat: RecordingChat;
  conversationId: string;
  certs: FakeCerts;
  logs: string[];
  /** .env der Schlüssel-Attrappe */
  env: Map<string, string>;
}

// Platzhalter, keine echten Schlüssel
const OLD_KEY = "platzhalter-openai-alt-Q7x2";
const NEW_KEY = "platzhalter-openai-neu-Z9k4";

function keysPort(env: Map<string, string>): KeysPort {
  const atStart = Object.fromEntries(env);
  return {
    read: async () => Object.fromEntries(env),
    set: async (name, value) => void env.set(name, value),
    remove: async name => env.delete(name),
    running: () => atStart,
    editEnabledAtStart: () => true,
  };
}

async function start(options: { access?: AccessConfig | null; publicOrigin?: string | null } = {}): Promise<Ctx> {
  const dir = join(root, `case-${++counter}`);
  const store = new ConversationStore({ dir: join(dir, "web") });
  await store.load();
  const conversationId = (await store.createConversation("general")).id;
  const chat = new RecordingChat();
  const logs: string[] = [];
  const certs = new FakeCerts();
  const env = new Map([["WEB_ALLOW_KEY_EDIT", "true"], ["OPENAI_API_KEY", OLD_KEY]]);
  const server = await createWebServer(
    {
      host: "127.0.0.1",
      port: 0,
      password: PASSWORD,
      allowedHosts: [],
      publicOrigin: options.publicOrigin === undefined ? PUBLIC : options.publicOrigin,
      access: options.access === undefined ? ACCESS : options.access,
    },
    {
      sessionFile: join(dir, "sessions.json"),
      conversationStore: store,
      chat,
      cliTokenFile: join(dir, "cli-token"),
      keepaliveMs: 60_000,
      accessCerts: certs.fetch,
      keys: keysPort(env),
      log: m => logs.push(m),
    }
  );
  servers.push(server);
  const port = new URL(server.url).port;
  return { url: `http://127.0.0.1:${port}`, port, chat, conversationId, certs, logs, env };
}

function tunnel(jwt: string | null = validJwt(), extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { host: "app.tybo.ai", origin: PUBLIC, "cf-connecting-ip": VISITOR, ...extra };
  if (jwt !== null) headers["cf-access-jwt-assertion"] = jwt;
  return headers;
}

function login(ctx: Ctx, headers: Record<string, string>) {
  return fetch(`${ctx.url}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ password: PASSWORD }),
  });
}

function postMessage(ctx: Ctx, headers: Record<string, string>, text = "Hallo von unterwegs") {
  return fetch(`${ctx.url}/api/conversations/${ctx.conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ text }),
  });
}

function cookieOf(res: Response): string {
  return res.headers.get("set-cookie")!.split(";")[0];
}

/** Jeder Ablehnungsgrund einmal, mit einem Nachweis, der genau daran scheitert */
function badTokens(): Record<string, string | null> {
  const now = Date.now();
  const s = Math.floor(now / 1000);
  return {
    fehlt: null,
    leer: "",
    kaputt: "kein.jwt",
    algorithmus: signJwt(claims(now), KEY_A, { alg: "HS256", kid: KEY_A.kid }),
    "unbekannte kid": signJwt(claims(now), makeKey("fremd")),
    signatur: signJwt(claims(now), makeKey(KEY_A.kid)),
    aud: signJwt(claims(now, { aud: ["andere-anwendung-1234567890"] })),
    iss: signJwt(claims(now, { iss: "https://anderes.cloudflareaccess.com" })),
    abgelaufen: signJwt(claims(now, { exp: s - 120 })),
    nbf: signJwt(claims(now, { nbf: s + 600 })),
    zeitangaben: signJwt(claims(now, { exp: undefined })),
  };
}

describe("getunnelt mit Access", () => {
  test("gültiger Nachweis und Passwort-Cookie: Login, Senden und Chat gehen", async () => {
    const ctx = await start();
    const res = await login(ctx, tunnel());
    expect(res.status).toBe(200);
    const cookie = cookieOf(res);
    expect((await fetch(`${ctx.url}/api/me`, { headers: { ...tunnel(), cookie } })).status).toBe(200);
    expect((await postMessage(ctx, { ...tunnel(), cookie })).status).toBe(202);
    await Bun.sleep(20);
    expect(ctx.chat.turns.map(t => t.text)).toEqual(["Hallo von unterwegs"]);
    // Seite, Stil und Skripte
    expect((await fetch(`${ctx.url}/`, { headers: { ...tunnel(), cookie } })).status).toBe(200);
    expect((await fetch(`${ctx.url}/login`, { headers: tunnel() })).status).toBe(200);
  });

  test("gültiger Nachweis ohne Passwort-Cookie: 401 bzw. Weiterleitung zum Login", async () => {
    const ctx = await start();
    expect((await fetch(`${ctx.url}/api/me`, { headers: tunnel() })).status).toBe(401);
    expect((await postMessage(ctx, tunnel())).status).toBe(401);
    // Anhänge des Web-Gesprächs (Issue #112): Access-Nachweis allein reicht auch hier nicht
    const attachments = `${ctx.url}/api/conversations/${ctx.conversationId}/attachments`;
    expect((await fetch(`${attachments}/${crypto.randomUUID()}`, { headers: tunnel() })).status).toBe(401);
    const upload = await fetch(attachments, { method: "POST", headers: tunnel(), body: new Uint8Array(16) });
    expect(upload.status).toBe(401);
    const page = await fetch(`${ctx.url}/`, { headers: tunnel(), redirect: "manual" });
    expect(page.status).toBe(302);
    expect(ctx.chat.turns).toEqual([]);
  });

  test("jeder Ablehnungsgrund: 403 mit Hinweis, auch mit gültigem Passwort-Cookie", async () => {
    const ctx = await start();
    const cookie = cookieOf(await login(ctx, tunnel()));
    for (const [name, jwt] of Object.entries(badTokens())) {
      const me = await fetch(`${ctx.url}/api/me`, { headers: { ...tunnel(jwt), cookie } });
      expect({ name, status: me.status }).toEqual({ name, status: 403 });
      expect(await me.json()).toEqual({ error: ACCESS_DENIED_TEXT });
      expect((await postMessage(ctx, { ...tunnel(jwt), cookie })).status).toBe(403);
      expect((await login(ctx, tunnel(jwt))).status).toBe(403);
    }
    expect(ctx.chat.turns).toEqual([]);
  });

  test("abgelehnt vor Login, statischen Dateien, Downloads, Uploads und Live-Verbindungen", async () => {
    const ctx = await start();
    const cookie = cookieOf(await login(ctx, tunnel()));
    const bad = { ...tunnel(null), cookie };
    const fetched = ctx.certs.calls.length;
    const requests: [string, RequestInit][] = [
      ["/login", {}],
      ["/login.js", {}],
      ["/style.css", {}],
      ["/theme.js", {}],
      ["/favicon.svg", {}],
      ["/apple-touch-icon.png", {}],
      ["/", {}],
      ["/app.js", {}],
      ["/gibts-nicht", {}],
      ["/api/files/abc", {}],
      [`/api/conversations/${ctx.conversationId}/attachments/abc`, {}],
      [`/api/conversations/${ctx.conversationId}/events`, {}],
      ["/api/telegram/events", {}],
      ["/api/logout", { method: "POST" }],
      [`/api/conversations/${ctx.conversationId}/attachments`, { method: "POST", body: new Uint8Array(1024) }],
      ["/api/keys/OPENAI_API_KEY", { method: "PUT", body: JSON.stringify({ value: "x".repeat(20) }) }],
    ];
    for (const [path, init] of requests) {
      const res = await fetch(`${ctx.url}${path}`, { ...init, headers: bad, redirect: "manual" });
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
      // Auch abgelehnte Antworten tragen die Sicherheits-Kopfzeilen
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      await res.arrayBuffer();
    }
    // Ohne Nachweis kein Schlüsselabruf
    expect(ctx.certs.calls.length).toBe(fetched);
    expect(ctx.chat.turns).toEqual([]);
    // Die Session lebt noch: Abmelden ohne Nachweis hat nichts bewirkt
    expect((await fetch(`${ctx.url}/api/me`, { headers: { ...tunnel(), cookie } })).status).toBe(200);
  });

  test("Seiten bekommen den Hinweis als Text", async () => {
    const ctx = await start();
    const res = await fetch(`${ctx.url}/login`, { headers: tunnel(null) });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(ACCESS_DENIED_TEXT);
  });

  test("Schlüsselabruf gescheitert: 403, kein Durchlass", async () => {
    const ctx = await start();
    ctx.certs.fail = true;
    expect((await login(ctx, tunnel())).status).toBe(403);
    expect(ctx.logs).toContain("Access: Schlüsselabruf fehlgeschlagen (Error)");
    expect(ctx.logs).toContain(`Access abgelehnt für ${VISITOR} (Tunnel): Schlüssel nicht abrufbar`);
  });

  test("Log nur mit Ergebnis und Grund, nie mit Token; gleiche Meldungen gebremst", async () => {
    const ctx = await start();
    const good = validJwt();
    const expired = badTokens().abgelaufen!;
    for (let i = 0; i < 3; i++) {
      await fetch(`${ctx.url}/api/me`, { headers: tunnel(good) });
      await fetch(`${ctx.url}/api/me`, { headers: tunnel(expired) });
    }
    expect(ctx.logs.filter(l => l.startsWith("Access"))).toEqual([
      `Access ok für ${VISITOR} (Tunnel)`,
      `Access abgelehnt für ${VISITOR} (Tunnel): abgelaufen`,
    ]);
    const all = ctx.logs.join("\n");
    for (const t of [good, expired]) for (const part of t.split(".")) expect(all).not.toContain(part);
  });
});

describe("sicherer Ausfall", () => {
  test("WEB_PUBLIC_ORIGIN ohne Access: getunnelte Anfragen immer 403, auch mit gültig aussehendem Nachweis", async () => {
    const ctx = await start({ access: null });
    expect(ctx.logs.some(l => l.includes("Access aber nicht"))).toBe(true);
    for (const jwt of [null, validJwt()]) {
      expect((await login(ctx, tunnel(jwt))).status).toBe(403);
      expect((await fetch(`${ctx.url}/login`, { headers: tunnel(jwt) })).status).toBe(403);
    }
    expect(ctx.logs).toContain(`Access abgelehnt für ${VISITOR} (Tunnel): Access nicht eingerichtet (WEB_ACCESS_TEAM, WEB_ACCESS_AUD)`);
    // Heimnetz bleibt offen
    const local = { host: `127.0.0.1:${ctx.port}`, origin: ctx.url };
    expect((await login(ctx, local)).status).toBe(200);
  });

  test("nicht getunnelt: kein Nachweis nötig, auch ein kaputter stört nicht", async () => {
    const ctx = await start();
    const local = { host: `127.0.0.1:${ctx.port}`, origin: ctx.url };
    const res = await login(ctx, local);
    expect(res.status).toBe(200);
    expect((await postMessage(ctx, { ...local, cookie: cookieOf(res), "cf-access-jwt-assertion": "kaputt" })).status).toBe(202);
    expect(ctx.certs.calls).toEqual([]);
  });

  test("ohne WEB_PUBLIC_ORIGIN wie bisher: kein Access, Loopback mit Tunnel-Kopfzeile gilt als Heimnetz", async () => {
    const ctx = await start({ publicOrigin: null });
    const local = { host: `127.0.0.1:${ctx.port}`, origin: ctx.url, "cf-connecting-ip": VISITOR };
    expect((await login(ctx, local)).status).toBe(200);
    expect(ctx.certs.calls).toEqual([]);
  });
});

describe("Schlüssel nur im Heimnetz", () => {
  async function sessions(ctx: Ctx) {
    const local = { host: `127.0.0.1:${ctx.port}`, origin: ctx.url };
    const localCookie = cookieOf(await login(ctx, local));
    const remoteCookie = cookieOf(await login(ctx, tunnel()));
    return { local: { ...local, cookie: localCookie }, remote: () => ({ ...tunnel(), cookie: remoteCookie }) };
  }

  function putKey(ctx: Ctx, headers: Record<string, string>, name = "OPENAI_API_KEY") {
    return fetch(`${ctx.url}/api/keys/${name}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ value: NEW_KEY }),
    });
  }

  test("getunnelt: PUT und DELETE 403 mit Hinweis „nur im Heimnetz\", nichts geändert", async () => {
    const ctx = await start();
    const s = await sessions(ctx);
    for (const name of ["OPENAI_API_KEY", "GEMINI_API_KEY", "WEB_PASSWORD", "kaputt!"]) {
      const put = await putKey(ctx, s.remote(), name);
      expect(put.status).toBe(403);
      expect(await put.json()).toEqual({ error: KEYS_TEXT.homeOnly, editAllowed: false, homeOnly: true });
      const del = await fetch(`${ctx.url}/api/keys/${name}`, { method: "DELETE", headers: s.remote() });
      expect(del.status).toBe(403);
      expect((await del.json()).homeOnly).toBe(true);
    }
    expect(Object.fromEntries(ctx.env)).toEqual({ WEB_ALLOW_KEY_EDIT: "true", OPENAI_API_KEY: OLD_KEY });
    expect(ctx.logs).toContain("Schlüsseländerung über den Tunnel abgelehnt");
    expect(ctx.logs.join("\n")).not.toContain(NEW_KEY);
  });

  test("getunnelt lesen: editAllowed und editable aus, Sperrgrund tunnel", async () => {
    const ctx = await start();
    const s = await sessions(ctx);
    const res = await fetch(`${ctx.url}/api/keys`, { headers: s.remote() });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.editAllowed).toBe(false);
    expect(data.readOnlyReason).toBe("tunnel");
    expect(data.keys.every((k: any) => k.editable === false)).toBe(true);
    // Lesen wie gewohnt: gesetzt und letzte 4 Zeichen
    expect(data.keys.find((k: any) => k.name === "OPENAI_API_KEY")).toMatchObject({ set: true, last4: OLD_KEY.slice(-4) });
  });

  test("im Heimnetz wie bisher, auch gleichzeitig mit getunnelten Anfragen", async () => {
    const ctx = await start();
    const s = await sessions(ctx);
    const [remote, local] = await Promise.all([
      fetch(`${ctx.url}/api/keys`, { headers: s.remote() }).then(r => r.json() as any),
      fetch(`${ctx.url}/api/keys`, { headers: s.local }).then(r => r.json() as any),
    ]);
    expect(remote.editAllowed).toBe(false);
    expect(local.editAllowed).toBe(true);
    expect(local.readOnlyReason).toBeNull();
    expect(local.keys.find((k: any) => k.name === "OPENAI_API_KEY").editable).toBe(true);
    const [denied, saved] = await Promise.all([putKey(ctx, s.remote()), putKey(ctx, s.local)]);
    expect(denied.status).toBe(403);
    expect(saved.status).toBe(200);
    expect(ctx.env.get("OPENAI_API_KEY")).toBe(NEW_KEY);
    const del = await fetch(`${ctx.url}/api/keys/OPENAI_API_KEY`, { method: "DELETE", headers: s.local });
    expect(del.status).toBe(200);
    expect(ctx.env.has("OPENAI_API_KEY")).toBe(false);
  });

  test("ohne Opt-in im Heimnetz: Sperrgrund switch", async () => {
    const ctx = await start();
    ctx.env.delete("WEB_ALLOW_KEY_EDIT");
    const s = await sessions(ctx);
    const data = (await (await fetch(`${ctx.url}/api/keys`, { headers: s.local })).json()) as any;
    expect(data.editAllowed).toBe(false);
    expect(data.readOnlyReason).toBe("switch");
  });
});
