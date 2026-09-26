/**
 * Issue #59, Schritt 2 (Sicherheitstests): Anmeldung mit dem lokalen
 * Schlüssel („Authorization: Bearer") nur über eine Loopback-Verbindung.
 * Fremde Adresse, falscher oder alter Schlüssel ergeben 401; Host-Prüfung
 * bleibt, Origin entfällt nur mit gültigem Schlüssel; der Schlüssel steht nie
 * im Log. Beide Ereignisströme funktionieren ohne Cookie.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { RunTurnOptions, WebChat } from "../src/web/chat";
import { isLoopbackAddress, parseBearer, readCliToken } from "../src/web/cli-token";
import { createWebServer, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";

const PASSWORD = "test-passwort-lang";
const root = await mkdtemp(join(tmpdir(), "tybo-cli-auth-"));
let counter = 0;
const servers: WebServer[] = [];
/** Alle Log-Zeilen aller Server dieser Datei, am Ende auf Schlüssel geprüft */
const allLogs: string[] = [];
const seenTokens: string[] = [];

afterAll(async () => {
  for (const s of servers.splice(0)) await s.stop();
  for (const token of seenTokens) expect(allLogs.join("\n")).not.toContain(token);
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
  server: WebServer;
  url: string;
  token: string;
  tokenFile: string;
  chat: RecordingChat;
  conversationId: string;
}

async function start(host = "127.0.0.1", tokenFile = join(root, `case-${++counter}`, "cli-token")): Promise<Ctx> {
  const dir = join(root, `data-${++counter}`);
  const store = new ConversationStore({ dir: join(dir, "web") });
  await store.load();
  const conversationId = (await store.createConversation("general")).id;
  const chat = new RecordingChat();
  const server = await createWebServer(
    { host, port: 0, password: PASSWORD, allowedHosts: [] },
    {
      sessionFile: join(dir, "sessions.json"),
      conversationStore: store,
      chat,
      cliTokenFile: tokenFile,
      keepaliveMs: 60_000,
      log: m => allLogs.push(m),
    }
  );
  servers.push(server);
  const token = (await readCliToken(tokenFile))!;
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  seenTokens.push(token);
  const port = new URL(server.url).port;
  return { server, url: `http://127.0.0.1:${port}`, token, tokenFile, chat, conversationId };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function cookieFor(ctx: Ctx): Promise<string> {
  const res = await fetch(`${ctx.url}/api/login`, {
    method: "POST",
    headers: { origin: ctx.url, "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0];
}

function postMessage(ctx: Ctx, headers: Record<string, string>, base = ctx.url) {
  return fetch(`${base}/api/conversations/${ctx.conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ text: "Hallo aus dem Terminal" }),
  });
}

/** Öffnet einen Ereignisstrom, liest den ersten Teil und schließt ihn wieder */
async function openStream(url: string, headers: Record<string, string>): Promise<{ status: number; type: string; first: string }> {
  const abort = new AbortController();
  const res = await fetch(url, { headers, signal: abort.signal });
  let first = "";
  if (res.status === 200 && res.body) {
    const { value } = await res.body.getReader().read();
    first = new TextDecoder().decode(value);
  }
  abort.abort();
  return { status: res.status, type: res.headers.get("content-type") ?? "", first };
}

/** Eine IPv4-Adresse des Rechners außer Loopback (Heimnetz); null, wenn es keine gibt */
function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return null;
}

describe("Hilfsfunktionen", () => {
  test("isLoopbackAddress: nur 127.0.0.1, ::1 und 127.0.0.1 auf IPv6-Socket", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    for (const other of ["192.168.1.20", "10.0.0.1", "127.0.0.2", "::ffff:192.168.1.20", "localhost", "", null, undefined]) {
      expect(isLoopbackAddress(other)).toBe(false);
    }
  });

  test("parseBearer: kein Bearer, fehlerhafter Bearer und gültige Form getrennt", () => {
    expect(parseBearer("Bearer abc")).toEqual({ token: "abc" });
    expect(parseBearer("bearer abc")).toEqual({ token: "abc" });
    expect(parseBearer("Bearer")).toEqual({ token: null });
    expect(parseBearer("Bearer ")).toEqual({ token: null });
    expect(parseBearer("Bearer a b")).toEqual({ token: null });
    expect(parseBearer("Basic abc")).toBeNull();
    expect(parseBearer("Bearerabc")).toBeNull();
    expect(parseBearer("")).toBeNull();
    expect(parseBearer(null)).toBeNull();
  });
});

describe("Bearer von Loopback", () => {
  test("gültiger Schlüssel: angemeldet, ohne Cookie", async () => {
    const ctx = await start();
    const res = await fetch(`${ctx.url}/api/me`, { headers: bearer(ctx.token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true });
  });

  test("schreibende Anfrage ohne Cookie und ohne Origin: angenommen, Quelle terminal", async () => {
    const ctx = await start();
    const res = await postMessage(ctx, bearer(ctx.token));
    expect(res.status).toBe(202);
    await Bun.sleep(20);
    expect(ctx.chat.turns.map(t => t.source)).toEqual(["terminal"]);
  });

  test("Forwarded-Kopfzeilen ändern nichts an der Verbindungsadresse", async () => {
    const ctx = await start();
    const res = await fetch(`${ctx.url}/api/me`, {
      headers: { ...bearer(ctx.token), "x-forwarded-for": "203.0.113.9", forwarded: "for=203.0.113.9" },
    });
    expect(res.status).toBe(200);
  });

  test("falscher Schlüssel: 401, auch bei POST ohne Origin (statt 403)", async () => {
    const ctx = await start();
    const wrong = ctx.token.slice(0, -2) + (ctx.token.endsWith("AA") ? "BB" : "AA");
    expect((await fetch(`${ctx.url}/api/me`, { headers: bearer(wrong) })).status).toBe(401);
    expect((await postMessage(ctx, bearer(wrong))).status).toBe(401);
    expect((await postMessage(ctx, bearer("kurz"))).status).toBe(401);
    expect(ctx.chat.turns).toEqual([]);
    expect(allLogs.join("\n")).toContain("Terminal-Anmeldung abgelehnt von 127.0.0.1");
  });

  test("fehlerhafter Bearer („Bearer“, „Bearer a b“) ohne Cookie: 401, auch bei POST ohne Origin", async () => {
    const ctx = await start();
    for (const authorization of ["Bearer", "Bearer a b"]) {
      expect((await fetch(`${ctx.url}/api/me`, { headers: { authorization } })).status).toBe(401);
      expect((await postMessage(ctx, { authorization })).status).toBe(401);
      expect((await postMessage(ctx, { authorization, origin: ctx.url })).status).toBe(401);
    }
    expect(ctx.chat.turns).toEqual([]);
  });

  test("alter Schlüssel nach Neustart: 401; neuer gilt", async () => {
    const tokenFile = join(root, `neustart-${++counter}`, "cli-token");
    const first = await start("127.0.0.1", tokenFile);
    await first.server.stop();
    const second = await start("127.0.0.1", tokenFile);
    expect(second.token).not.toBe(first.token);
    expect((await fetch(`${second.url}/api/me`, { headers: bearer(first.token) })).status).toBe(401);
    expect((await fetch(`${second.url}/api/me`, { headers: bearer(second.token) })).status).toBe(200);
  });

  test("Host-Prüfung bleibt: fremder Host-Header mit gültigem Schlüssel ergibt 421", async () => {
    const ctx = await start();
    const port = new URL(ctx.url).port;
    const res = await fetch(`${ctx.url}/api/me`, { headers: { ...bearer(ctx.token), host: `evil.example:${port}` } });
    expect(res.status).toBe(421);
  });

  test("ohne cliTokenFile gibt es keinen Terminal-Zugang", async () => {
    const dir = join(root, `ohne-${++counter}`);
    const server = await createWebServer(
      { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
      { sessionFile: join(dir, "sessions.json"), dataDir: join(dir, "web"), log: m => allLogs.push(m) }
    );
    servers.push(server);
    expect((await fetch(`${server.url}/api/me`, { headers: bearer("A".repeat(43)) })).status).toBe(401);
  });
});

describe("Cookie- und Origin-Regeln bleiben (Regression)", () => {
  test("ohne Anmeldung: GET 401, POST ohne Origin 403", async () => {
    const ctx = await start();
    expect((await fetch(`${ctx.url}/api/me`)).status).toBe(401);
    expect((await postMessage(ctx, {})).status).toBe(403);
  });

  test("Cookie: POST ohne Origin 403, mit Origin 202, Quelle web", async () => {
    const ctx = await start();
    const cookie = await cookieFor(ctx);
    expect((await postMessage(ctx, { cookie })).status).toBe(403);
    expect((await postMessage(ctx, { cookie, origin: ctx.url })).status).toBe(202);
    await Bun.sleep(20);
    expect(ctx.chat.turns.map(t => t.source)).toEqual(["web"]);
  });

  test("Cookie mit falschem Bearer: bleibt eine Browser-Anfrage (Origin nötig)", async () => {
    const ctx = await start();
    const cookie = await cookieFor(ctx);
    expect((await fetch(`${ctx.url}/api/me`, { headers: { cookie, authorization: "Bearer falsch" } })).status).toBe(200);
    expect((await postMessage(ctx, { cookie, authorization: "Bearer falsch" })).status).toBe(403);
  });

  test("Cookie mit fehlerhaftem Bearer: bleibt eine Browser-Anfrage (Origin nötig)", async () => {
    const ctx = await start();
    const cookie = await cookieFor(ctx);
    for (const authorization of ["Bearer", "Bearer a b"]) {
      expect((await fetch(`${ctx.url}/api/me`, { headers: { cookie, authorization } })).status).toBe(200);
      expect((await postMessage(ctx, { cookie, authorization })).status).toBe(403);
    }
    expect((await postMessage(ctx, { cookie, authorization: "Bearer a b", origin: ctx.url })).status).toBe(202);
  });

  test("anderes Schema (Basic) zählt nicht als Schlüssel", async () => {
    const ctx = await start();
    expect((await fetch(`${ctx.url}/api/me`, { headers: { authorization: `Basic ${ctx.token}` } })).status).toBe(401);
  });
});

describe("Ereignisströme ohne Cookie", () => {
  test("Gespräch und Telegram-Sammelstrom mit Schlüssel offen, mit falschem 401", async () => {
    const ctx = await start();
    const conv = await openStream(`${ctx.url}/api/conversations/${ctx.conversationId}/events`, bearer(ctx.token));
    expect(conv.status).toBe(200);
    expect(conv.type).toContain("text/event-stream");
    expect(conv.first).toContain("event: status");
    const activity = await openStream(`${ctx.url}/api/telegram/events`, bearer(ctx.token));
    expect(activity.status).toBe(200);
    expect(activity.type).toContain("text/event-stream");
    expect((await openStream(`${ctx.url}/api/telegram/events`, bearer("falsch"))).status).toBe(401);
  });
});

const lan = lanAddress();

describe("Bearer von einer fremden Adresse", () => {
  test.skipIf(!lan)("gültiger Schlüssel über die Heimnetz-Adresse: 401, auch mit Forwarded auf 127.0.0.1", async () => {
    const ctx = await start("0.0.0.0");
    const port = new URL(ctx.server.url).port;
    const base = `http://${lan}:${port}`;
    // Gegenprobe: dieselbe Adresse ist erreichbar, der Server antwortet
    expect((await fetch(`${base}/login`)).status).toBe(200);
    expect((await fetch(`${base}/api/me`, { headers: bearer(ctx.token) })).status).toBe(401);
    const spoofed = await fetch(`${base}/api/me`, {
      headers: { ...bearer(ctx.token), "x-forwarded-for": "127.0.0.1", forwarded: "for=127.0.0.1", "x-real-ip": "127.0.0.1" },
    });
    expect(spoofed.status).toBe(401);
    expect((await postMessage(ctx, bearer(ctx.token), base)).status).toBe(401);
    expect(ctx.chat.turns).toEqual([]);
    expect(allLogs.join("\n")).toContain(`Terminal-Anmeldung abgelehnt von ${lan}`);
    // Über Loopback gilt derselbe Schlüssel
    expect((await fetch(`http://127.0.0.1:${port}/api/me`, { headers: bearer(ctx.token) })).status).toBe(200);
  });
});
