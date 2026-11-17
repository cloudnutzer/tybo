/**
 * Issue #494, Eskalation 4: Sperre, Freigabe und Minuten richten sich nach
 * ElevenLabs, nie nach einer Meldung des Browsers. Der Server fragt
 * GET /v1/convai/conversations/<id> (hier eine Attrappe) beim Auflegen, vor
 * jedem Start und für die Zustandsroute. Geprüft: Ende nur auf Nachweis,
 * Dauer laut Anbieter, nicht erreichbar oder unklar hält alles bis zur harten
 * Grenze, unbekannte Gesprächs-ID erst nach Tokenablauf als nie zustande
 * gekommen, Ablauf aus dem Token, keine Geheimnisse in Antworten und Log.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyWebCall } from "../src/lib/voice-agents/web-calls";
import { readWebSessions, usedMinutes, WEB_SESSION_SLACK_MS, WEB_SESSION_TOKEN_MS } from "../src/lib/voice-agents/web-sessions";
import { VOICE_AGENT_END_CHECK_DELAYS_MS } from "../src/web/bot-voice-agent-session";
import type { WebServer } from "../src/web/server";
import type { ServerCtx } from "./topic-fixture";
import { API_KEY, BRIDGE_TOKEN, bridge, providerToken, readyAgent, removeSessionWorlds, sessionServer, sessionWorld, START, tokenName, type ProviderConversation, type SessionWorld } from "./voice-agent-session-fixture";

const root = await mkdtemp(join(tmpdir(), "voice-agent-provider-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  removeSessionWorlds();
});
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
});

const MAX = 12;
/** Harte Grenze eines Gesprächs, dessen Token bei START ausgegeben wurde */
const HARD = START + WEB_SESSION_TOKEN_MS + MAX * 60_000 + WEB_SESSION_SLACK_MS;

const start = (ctx: ServerCtx) => ctx.api("/api/voice-agents/jarvis/session", "POST", {});
const end = (ctx: ServerCtx, conversationId = "conv_1") => ctx.api("/api/voice-agents/jarvis/session/end", "POST", { conversationId });
const info = (ctx: ServerCtx) => ctx.api("/api/voice-agents/jarvis").then((r) => r.json());
const verify = (w: SessionWorld, conversationId = "conv_1") =>
  verifyWebCall({ kennung: "jarvis", conversationId }, { ...w.paths, token: BRIDGE_TOKEN, now: () => w.clock.now });
const webCallFiles = (w: SessionWorld) => {
  const dir = join(w.paths.dataDir, "jarvis", "web-calls");
  return existsSync(dir) ? readdirSync(dir) : [];
};
const stored = async (w: SessionWorld) => (await readWebSessions("jarvis", w.paths)).sitzungen.map((s) => [s.gespraech, s.ende !== null, s.minuten]);

async function world(): Promise<{ w: SessionWorld; ctx: ServerCtx }> {
  const w = sessionWorld();
  await readyAgent(w, "jarvis", bridge);
  const ctx = await sessionServer(root, servers, w);
  return { w, ctx };
}

/** Platz, Freigabe und volle Minuten unverändert belegt */
async function expectHeld(w: SessionWorld, ctx: ServerCtx): Promise<void> {
  expect((await start(ctx)).status).toBe(409);
  expect(await verify(w)).toBe(true);
  expect((await info(ctx)).laufend).not.toBeNull();
  expect(await stored(w)).toEqual([["conv_1", false, MAX]]);
}

describe("Ende nur auf Nachweis von ElevenLabs", () => {
  test("Anbieter meldet in-progress: Endemeldung 202 ausstehend, Platz, Freigabe und volle Minuten bleiben; nach done klärt der nächste Start", async () => {
    const { w, ctx } = await world();
    expect((await start(ctx)).status).toBe(200);
    w.clock.now += 5 * 60_000;
    const res = await end(ctx);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ ausstehend: true, reason: "anbieter_aktiv", bis: new Date(HARD).toISOString() });
    expect(body.error).toContain("ElevenLabs");
    // Nachgefragt wie eingestellt: dreimal, mit Wartezeiten dazwischen
    expect(w.statusCalls.map((c) => c.id)).toEqual(VOICE_AGENT_END_CHECK_DELAYS_MS.map(() => "conv_1"));
    expect(w.statusCalls.every((c) => c.headers["xi-api-key"] === API_KEY)).toBe(true);
    await expectHeld(w, ctx);
    const blocked = await (await start(ctx)).json();
    expect(blocked).toMatchObject({ reason: "laeuft", bis: new Date(HARD).toISOString() });
    // Erst als ElevenLabs das Ende meldet (7 Minuten Gespräch), ist der Platz frei
    w.clock.now += 2 * 60_000;
    w.hangUp("conv_1");
    w.clock.now += 3 * 60_000;
    const next = await start(ctx);
    expect(next.status).toBe(200);
    expect(await verify(w)).toBe(false);
    expect(await stored(w)).toEqual([["conv_1", true, 7], ["conv_2", false, MAX]]);
    expect(w.logs.some((l) => l.includes("beendet laut Anbieter"))).toBe(true);
  });

  test("Status wechselt kurz nach dem Auflegen: die Nachfrage wartet und bucht dann die Dauer", async () => {
    const w = sessionWorld();
    await readyAgent(w, "jarvis", bridge);
    const slept: number[] = [];
    let checks = 0;
    w.conversation = (id) => (++checks < 3 ? { status: "in-progress" } : { status: "processing", dauerSek: 61 });
    const port = w.port({ sleep: async (ms) => void slept.push(ms) });
    expect((await port.start("jarvis")).status).toBe(200);
    checks = 0;
    const res = await port.end("jarvis", JSON.stringify({ conversationId: "conv_1" }));
    expect(res).toEqual({ status: 200, body: { ok: true, minuten: 2 } });
    expect(slept).toEqual(VOICE_AGENT_END_CHECK_DELAYS_MS.filter((ms) => ms > 0));
  });

  for (const [name, state, minutes] of [
    ["done", { status: "done", dauerSek: 125 }, 3],
    ["processing", { status: "processing", dauerSek: 59 }, 1],
    ["failed ohne Dauer", { status: "failed", dauerSek: 0 }, 1],
    ["done länger als reserviert", { status: "done", dauerSek: 40 * 60 }, MAX],
  ] as const) {
    test(`Anbieter meldet ${name}: beendet, Freigabe gelöscht, ${minutes} Minuten`, async () => {
      const { w, ctx } = await world();
      expect((await start(ctx)).status).toBe(200);
      w.conversation = () => state as ProviderConversation;
      const res = await end(ctx);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, minuten: minutes });
      expect(await verify(w)).toBe(false);
      expect(webCallFiles(w)).toEqual([]);
      expect(await stored(w)).toEqual([["conv_1", true, minutes]]);
      expect((await start(ctx)).status).toBe(200);
    });
  }

  for (const [name, state] of [
    ["nicht erreichbar", "wirft"],
    ["HTTP 500", { http: 500 }],
    ["HTTP 401", { http: 401 }],
    ["Antwort ohne Status", { http: 200, body: { conversation_id: "conv_1" } }],
    ["unbekannter Status", { http: 200, body: { conversation_id: "conv_1", status: "irgendwas" } }],
    ["Antwort zu einem anderen Gespräch", { http: 200, body: { conversation_id: "conv_2", status: "done", metadata: { call_duration_secs: 1 } } }],
  ] as const) {
    test(`Anbieter ${name}: 202 unklar, alles bleibt bis zur harten Grenze, danach frei mit vollen Minuten`, async () => {
      const { w, ctx } = await world();
      expect((await start(ctx)).status).toBe(200);
      w.conversation = () => state as ProviderConversation;
      const res = await end(ctx);
      expect(res.status).toBe(202);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ ausstehend: true, reason: "anbieter_unklar" });
      await expectHeld(w, ctx);
      w.clock.now = HARD - 1;
      await expectHeld(w, ctx);
      // Harte Grenze: Token abgelaufen, längstes Gespräch vorbei; Minuten bleiben voll
      w.clock.now = HARD;
      expect(await verify(w)).toBe(false);
      expect((await info(ctx)).laufend).toBeNull();
      expect((await start(ctx)).status).toBe(200);
      expect(usedMinutes(await readWebSessions("jarvis", w.paths), w.clock.now)).toBe(2 * MAX);
      // Kein Schlüssel und kein Anbietertext in Antworten oder Log
      for (const line of [text, ...w.logs, ...ctx.logs]) {
        expect(line).not.toContain(API_KEY);
        expect(line).not.toContain("Geheimer Inhalt");
      }
    });
  }

  test("Gesprächs-ID beim Anbieter unbekannt (Token nie benutzt): belegt bis Tokenablauf plus Zuschlag, dann null Minuten und Freigabe weg", async () => {
    const { w, ctx } = await world();
    expect((await start(ctx)).status).toBe(200);
    w.conversation = () => "unbekannt";
    const res = await end(ctx);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ausstehend: true, reason: "anbieter_aktiv" });
    // Das Token kann bis zu seinem Ablauf noch ein Gespräch eröffnen
    w.clock.now = START + WEB_SESSION_TOKEN_MS + WEB_SESSION_SLACK_MS - 1;
    await expectHeld(w, ctx);
    w.clock.now += 1;
    // Die Zustandsroute klärt es von selbst, ohne Endemeldung
    expect((await info(ctx)).laufend).toBeNull();
    expect(await verify(w)).toBe(false);
    expect(webCallFiles(w)).toEqual([]);
    expect(await stored(w)).toEqual([["conv_1", true, 0]]);
    expect((await start(ctx)).status).toBe(200);
  });

  test("vergessenes Ende (Tab geschlossen): Zustandsroute und Start fragen selbst nach", async () => {
    const { w, ctx } = await world();
    expect((await start(ctx)).status).toBe(200);
    expect((await info(ctx)).laufend).not.toBeNull();
    w.clock.now += 4 * 60_000;
    w.hangUp("conv_1");
    w.clock.now += 60_000;
    expect((await info(ctx)).laufend).toBeNull();
    expect(await stored(w)).toEqual([["conv_1", true, 4]]);
    expect(await verify(w)).toBe(false);
  });

  test("Endemeldung für ein schon geklärtes Gespräch: 404, kein Anbieteraufruf", async () => {
    const { w, ctx } = await world();
    expect((await start(ctx)).status).toBe(200);
    w.hangUp("conv_1");
    expect((await end(ctx)).status).toBe(200);
    const before = w.statusCalls.length;
    expect((await end(ctx)).status).toBe(404);
    expect((await end(ctx, "conv_fremd")).status).toBe(404);
    expect(w.statusCalls).toHaveLength(before);
  });
});

describe("Ablauf aus dem Token", () => {
  test("Token nennt exp in 30 Minuten: harte Grenze, Freigabe und expiresInSec folgen ihm", async () => {
    const { w, ctx } = await world();
    const exp = Math.floor(START / 1000) + 30 * 60;
    const token = `kopf.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signatur`;
    w.replies.push({ status: 200, body: { token, conversation_id: "conv_jwt" } });
    const res = await start(ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).expiresInSec).toBe(30 * 60);
    const [session] = (await readWebSessions("jarvis", w.paths)).sitzungen;
    const hard = exp * 1000 + MAX * 60_000 + WEB_SESSION_SLACK_MS;
    expect(session).toMatchObject({ gespraech: "conv_jwt", tokenBis: exp * 1000, bis: hard });
    w.conversation = () => "unbekannt";
    // Nach dem Standard (15 Minuten) wäre das Token abgelaufen, laut exp aber nicht
    w.clock.now = START + WEB_SESSION_TOKEN_MS + WEB_SESSION_SLACK_MS;
    expect((await start(ctx)).status).toBe(409);
    expect(await verify(w, "conv_jwt")).toBe(true);
    w.clock.now = hard - 1;
    expect(await verify(w, "conv_jwt")).toBe(true);
  });

  const START_SEC = Math.floor(START / 1000);

  /** Nichts ausgegeben: 502 token_ablauf ohne Token, keine Freigabe, keine Reservierung, keine Minuten */
  async function expectRefused(w: SessionWorld, ctx: ServerCtx, conversationId: string): Promise<void> {
    const res = await start(ctx);
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(JSON.parse(text)).toMatchObject({ reason: "token_ablauf" });
    expect(text).not.toContain("gespraechstoken");
    expect(await verify(w, conversationId)).toBe(false);
    expect(webCallFiles(w)).toEqual([]);
    expect((await readWebSessions("jarvis", w.paths)).sitzungen).toEqual([]);
    expect(usedMinutes(await readWebSessions("jarvis", w.paths), w.clock.now)).toBe(0);
    expect((await info(ctx)).laufend).toBeNull();
  }

  test("Token nennt exp in 120 Minuten: nicht ausgegeben statt auf 15 Minuten verkürzt; der nächste Start bekommt ein gültiges Token und hält Platz, Freigabe und Minuten", async () => {
    const { w, ctx } = await world();
    w.replies.push({ status: 200, body: { token: providerToken("gespraechstoken-lang", START_SEC + 120 * 60), conversation_id: "conv_lang" } });
    await expectRefused(w, ctx, "conv_lang");
    expect(w.logs.some((l) => l.includes("zu langem Ablauf"))).toBe(true);
    // Das abgelehnte Token wurde nie ausgegeben: Später gibt es dazu nichts freizugeben oder zu buchen
    w.conversation = () => "unbekannt";
    w.clock.now = START + 16 * 60_000;
    expect((await info(ctx)).laufend).toBeNull();
    expect(w.statusCalls).toEqual([]);
    // Zweitstart: das nächste Token (exp in 15 Minuten) gilt und hält alles bis zu seinem Ablauf
    w.conversation = (id) => (id === "conv_1" ? { status: "in-progress" } : "unbekannt");
    const second = await start(ctx);
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(tokenName(body.conversationToken)).toBe("gespraechstoken-1");
    expect(body.expiresInSec).toBe(900);
    expect(await verify(w)).toBe(true);
    expect(await stored(w)).toEqual([["conv_1", false, MAX]]);
    expect((await start(ctx)).status).toBe(409);
    expect(w.calls).toHaveLength(2);
  });

  test("Token nennt exp genau in 60 Minuten: übernommen, nie verkürzt; 404 nach 16 und 28 Minuten gibt nichts frei, erst nach Tokenablauf plus Zuschlag null Minuten", async () => {
    const { w, ctx } = await world();
    const exp = START_SEC + 60 * 60;
    w.replies.push({ status: 200, body: { token: providerToken("gespraechstoken-60", exp), conversation_id: "conv_1" } });
    const res = await start(ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).expiresInSec).toBe(60 * 60);
    const hard = exp * 1000 + MAX * 60_000 + WEB_SESSION_SLACK_MS;
    const [session] = (await readWebSessions("jarvis", w.paths)).sitzungen;
    expect(session).toMatchObject({ gespraech: "conv_1", tokenBis: exp * 1000, bis: hard });
    // ElevenLabs kennt die ID (noch) nicht: Das Token könnte bis zu seinem Ablauf noch verbinden
    w.conversation = () => "unbekannt";
    for (const minute of [16, 28]) {
      w.clock.now = START + minute * 60_000;
      const ended = await end(ctx);
      expect(ended.status).toBe(202);
      await expectHeld(w, ctx);
    }
    w.clock.now = exp * 1000 + WEB_SESSION_SLACK_MS - 1;
    await expectHeld(w, ctx);
    // Erst jetzt ist sicher, dass dieses Token nie verbunden hat
    w.clock.now += 1;
    expect((await info(ctx)).laufend).toBeNull();
    expect(await verify(w)).toBe(false);
    expect(await stored(w)).toEqual([["conv_1", true, 0]]);
    expect((await start(ctx)).status).toBe(200);
  });

  test("Ablauf nicht auswertbar (kein JWT, ohne exp, exp kein Zeitstempel, schon abgelaufen, kaputter Inhalt): nie ausgegeben, keine Freigabe, keine Minuten; Zweitstart mit gültigem Token klappt", async () => {
    const { w, ctx } = await world();
    const unusable = [
      "gespraechstoken-ohne-jwt",
      providerToken("gespraechstoken-leer", 0, {}),
      providerToken("gespraechstoken-text", 0, { exp: "morgen" }),
      providerToken("gespraechstoken-alt", START_SEC),
      "kopf.%%%.gespraechstoken-kaputt",
    ];
    for (const [i, token] of unusable.entries()) {
      w.replies.push({ status: 200, body: { token, conversation_id: `conv_x${i}` } });
      await expectRefused(w, ctx, `conv_x${i}`);
    }
    for (const line of w.logs) expect(line).not.toContain("gespraechstoken");
    // Jeder Abruf zählt fürs Rate-Limit; der sechste Versuch bekommt ein gültiges Token
    const second = await start(ctx);
    expect(second.status).toBe(200);
    expect(tokenName((await second.json()).conversationToken)).toBe("gespraechstoken-1");
    expect(await verify(w)).toBe(true);
    expect(await stored(w)).toEqual([["conv_1", false, MAX]]);
    expect((await start(ctx)).status).toBe(409);
  });
});
