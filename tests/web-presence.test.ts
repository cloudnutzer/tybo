/**
 * Anwesenheit offener Seiten (Issue #226): Speicher mit Uhr-Attrappe
 * (sichtbar, verdeckt, nach 70 Sekunden verfallen, zwei Tabs, verspätete
 * Meldung, fremde Session, Abmelden) und die Route POST /api/presence
 * (Anmeldung, Origin, nur Browser, Prüfung des Bodys, Abmelden nimmt die
 * Anwesenheit zurück).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCliToken } from "../src/web/cli-token";
import { parsePresenceReport, PRESENCE_TTL_MS, PresenceTracker } from "../src/web/presence";
import { createWebServer, type WebServer } from "../src/web/server";

const TAB_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TAB_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const WEB_ID = "3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e";
const ok = { session: "s1", isAuthorized: () => true };

function tracker() {
  const clock = { t: 1_000_000 };
  return { clock, presence: new PresenceTracker({ now: () => clock.t }) };
}

describe("Speicher mit Uhr-Attrappe", () => {
  test("sichtbar gemeldet zählt, verdeckt nicht, ein anderes Gespräch nicht", () => {
    const { presence } = tracker();
    presence.report({ tab: TAB_A, conversationId: "dm", visible: true, seq: 1 }, ok);
    expect(presence.isVisible("dm")).toBe(true);
    expect(presence.isVisible("topic-5")).toBe(false);
    presence.report({ tab: TAB_A, conversationId: "dm", visible: false, seq: 2 }, ok);
    expect(presence.isVisible("dm")).toBe(false);
  });

  test("verfällt nach 70 Sekunden ohne Meldung, eine neue Meldung hält ihn frisch", () => {
    const { clock, presence } = tracker();
    presence.report({ tab: TAB_A, conversationId: "dm", visible: true, seq: 1 }, ok);
    clock.t += PRESENCE_TTL_MS - 1;
    expect(presence.isVisible("dm")).toBe(true);
    presence.report({ tab: TAB_A, conversationId: "dm", visible: true, seq: 2 }, ok);
    clock.t += PRESENCE_TTL_MS - 1;
    expect(presence.isVisible("dm")).toBe(true);
    clock.t += 1;
    expect(presence.isVisible("dm")).toBe(false);
    expect(presence.size()).toBe(0);
  });

  test("zwei Tabs: sichtbar, solange einer das Gespräch sichtbar meldet", () => {
    const { presence } = tracker();
    presence.report({ tab: TAB_A, conversationId: "dm", visible: true, seq: 1 }, ok);
    presence.report({ tab: TAB_B, conversationId: "dm", visible: false, seq: 1 }, ok);
    expect(presence.isVisible("dm")).toBe(true);
    presence.report({ tab: TAB_A, conversationId: null, visible: true, seq: 2 }, ok);
    expect(presence.isVisible("dm")).toBe(false);
    presence.report({ tab: TAB_B, conversationId: "dm", visible: true, seq: 2 }, ok);
    expect(presence.isVisible("dm")).toBe(true);
    presence.report({ tab: TAB_B, conversationId: "dm", visible: true, seq: 3, gone: true }, ok);
    expect(presence.isVisible("dm")).toBe(false);
  });

  test("verspätete Meldung überschreibt keinen neueren Gesprächswechsel", () => {
    const { presence } = tracker();
    presence.report({ tab: TAB_A, conversationId: "topic-5", visible: true, seq: 2 }, ok);
    expect(presence.report({ tab: TAB_A, conversationId: "dm", visible: true, seq: 1 }, ok)).toBe(false);
    expect(presence.report({ tab: TAB_A, conversationId: "dm", visible: true, seq: 2 }, ok)).toBe(false);
    expect(presence.isVisible("topic-5")).toBe(true);
    expect(presence.isVisible("dm")).toBe(false);
  });

  test("nach gone bleibt die seq gesperrt: verspätete Meldung belebt den Tab nicht, pageshow mit neuer seq schon", () => {
    const { clock, presence } = tracker();
    presence.report({ tab: TAB_A, conversationId: "dm", visible: true, seq: 1 }, ok);
    expect(presence.report({ tab: TAB_A, conversationId: null, visible: false, seq: 3, gone: true }, ok)).toBe(true);
    expect(presence.isVisible("dm")).toBe(false);
    expect(presence.size()).toBe(0);
    expect(presence.report({ tab: TAB_A, conversationId: "dm", visible: true, seq: 2 }, ok)).toBe(false);
    expect(presence.isVisible("dm")).toBe(false);
    expect(presence.report({ tab: TAB_A, conversationId: "dm", visible: true, seq: 4 }, ok)).toBe(true);
    expect(presence.isVisible("dm")).toBe(true);
    // Der inaktive Eintrag verfällt wie jeder andere
    presence.report({ tab: TAB_B, conversationId: null, visible: false, seq: 5, gone: true }, ok);
    clock.t += PRESENCE_TTL_MS;
    expect(presence.report({ tab: TAB_B, conversationId: "dm", visible: true, seq: 1 }, ok)).toBe(true);
  });

  test("fremde Session kann einen Tab nicht übernehmen; Abmelden und abgelaufene Session zählen nicht", () => {
    const { presence } = tracker();
    let valid = true;
    presence.report({ tab: TAB_A, conversationId: "dm", visible: true, seq: 1 }, { session: "s1", isAuthorized: () => valid });
    expect(presence.report({ tab: TAB_A, conversationId: null, visible: false, seq: 5 }, { session: "s2", isAuthorized: () => true })).toBe(false);
    expect(presence.isVisible("dm")).toBe(true);
    valid = false;
    expect(presence.isVisible("dm")).toBe(false);
    valid = true;
    presence.clearSession("s1");
    expect(presence.isVisible("dm")).toBe(false);
  });

  test("höchstens so viele Tabs wie erlaubt, der älteste fällt weg", () => {
    const clock = { t: 0 };
    const presence = new PresenceTracker({ now: () => clock.t, max: 2 });
    presence.report({ tab: TAB_A, conversationId: "dm", visible: true, seq: 1 }, ok);
    presence.report({ tab: TAB_B, conversationId: "topic-2", visible: true, seq: 1 }, ok);
    presence.report({ tab: "cccccccccccccccc", conversationId: "topic-3", visible: true, seq: 1 }, ok);
    expect(presence.size()).toBe(2);
    expect(presence.isVisible("dm")).toBe(false);
  });

  test("Body-Prüfung: Tab, seq, Gespräch", () => {
    expect(parsePresenceReport(JSON.stringify({ tab: TAB_A, seq: 1, conversation: WEB_ID, visible: true }))).toEqual({
      tab: TAB_A, seq: 1, conversationId: WEB_ID, visible: true,
    });
    expect(parsePresenceReport(JSON.stringify({ tab: TAB_A, seq: 3, conversation: null, visible: false, gone: true }))?.gone).toBe(true);
    for (const bad of [
      "kein json",
      JSON.stringify([]),
      JSON.stringify({ tab: "kurz", seq: 1 }),
      JSON.stringify({ tab: TAB_A, seq: -1 }),
      JSON.stringify({ tab: TAB_A, seq: 1.5 }),
      JSON.stringify({ tab: TAB_A, seq: 1, conversation: "../etc" }),
      JSON.stringify({ tab: TAB_A, seq: 1, visible: "ja" }),
    ]) {
      expect(parsePresenceReport(bad)).toBeNull();
    }
  });
});

const PASSWORD = "test-passwort-lang";
const root = await mkdtemp(join(tmpdir(), "tybo-presence-"));
const servers: WebServer[] = [];
let counter = 0;
afterAll(async () => {
  for (const s of servers.splice(0)) await s.stop();
  await rm(root, { recursive: true, force: true });
});

async function start() {
  const dir = join(root, `case-${++counter}`);
  const tokenFile = join(dir, "cli-token");
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [], publicOrigin: null, access: null },
    { sessionFile: join(dir, "sessions.json"), dataDir: join(dir, "web"), cliTokenFile: tokenFile, log: () => {} }
  );
  servers.push(server);
  return { server, url: server.url, cliToken: (await readCliToken(tokenFile))! };
}

async function login(url: string): Promise<string> {
  const res = await fetch(`${url}/api/login`, { method: "POST", headers: { origin: url }, body: JSON.stringify({ password: PASSWORD }) });
  return res.headers.get("set-cookie")!.split(";")[0];
}

function report(url: string, cookie: string | null, body: unknown, extra: Record<string, string> = {}) {
  return fetch(`${url}/api/presence`, {
    method: "POST",
    headers: { origin: url, "content-type": "text/plain", ...(cookie ? { cookie } : {}), ...extra },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/presence", () => {
  test("angemeldet 204 und danach sichtbar; ohne Anmeldung 401, fremder Origin 403, Terminal 403, falscher Body 400", async () => {
    const { server, url, cliToken } = await start();
    const body = { tab: TAB_A, seq: 1, conversation: "dm", visible: true };
    expect((await report(url, null, body)).status).toBe(401);
    const cookie = await login(url);
    expect((await report(url, cookie, body, { origin: "https://evil.example" })).status).toBe(403);
    expect(server.isConversationVisible("dm")).toBe(false);
    const terminal = await fetch(`${url}/api/presence`, { method: "POST", headers: { authorization: `Bearer ${cliToken}` }, body: JSON.stringify(body) });
    expect(terminal.status).toBe(403);
    expect((await report(url, cookie, { tab: TAB_A })).status).toBe(400);
    expect((await fetch(`${url}/api/presence`, { headers: { cookie } })).status).toBe(405);
    expect((await report(url, cookie, body)).status).toBe(204);
    expect(server.isConversationVisible("dm")).toBe(true);
  });

  test("Abmelden nimmt die Anwesenheit dieser Session zurück", async () => {
    const { server, url } = await start();
    const cookie = await login(url);
    const other = await login(url);
    await report(url, cookie, { tab: TAB_A, seq: 1, conversation: "dm", visible: true });
    await report(url, other, { tab: TAB_B, seq: 1, conversation: "topic-4", visible: true });
    await fetch(`${url}/api/logout`, { method: "POST", headers: { origin: url, cookie } });
    expect(server.isConversationVisible("dm")).toBe(false);
    expect(server.isConversationVisible("topic-4")).toBe(true);
  });

  test("Verlassen der Seite (gone, wie per sendBeacon als text/plain) nimmt den Tab zurück, verspätete Meldung danach wirkt nicht", async () => {
    const { server, url } = await start();
    const cookie = await login(url);
    await report(url, cookie, { tab: TAB_A, seq: 1, conversation: "dm", visible: true });
    expect((await report(url, cookie, { tab: TAB_A, seq: 3, conversation: null, visible: false, gone: true })).status).toBe(204);
    expect(server.isConversationVisible("dm")).toBe(false);
    await report(url, cookie, { tab: TAB_A, seq: 2, conversation: "dm", visible: true });
    expect(server.isConversationVisible("dm")).toBe(false);
  });
});
