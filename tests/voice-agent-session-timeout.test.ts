/**
 * Issue #494, Eskalation 5: HTTP-Zeitlimit der Sprachagenten-Routen. Bun beendet
 * eine Anfrage ohne Antwort nach seiner Ruhezeit (idleTimeout, Standard 10
 * Sekunden). Ende und Start fragen ElevenLabs mehrmals (Status, Token), mit
 * Wartezeiten dazwischen; zusammen dauert das länger. Geprüft über den echten
 * Bun-Server mit echtem Warten: Die Attrappe des Anbieters antwortet verzögert,
 * die Wartezeiten nach dem Auflegen laufen mit Bun.sleep, und die Antwort kommt
 * trotzdem vollständig an.
 *
 * Bun 1.4 kappt nach der Ruhezeit nur Anfragen ohne Body (GET, POST mit
 * Content-Length 0); mit Body bleibt die Verbindung bisher zufällig offen. Die
 * Gesprächsseite schickt immer einen Body. Geprüft wird deshalb beides: der
 * Start ohne Body (ohne keepOpen in server.ts bricht er mit ECONNRESET ab)
 * und Start und Ende so, wie der Browser sie schickt.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWebSessions } from "../src/lib/voice-agents/web-sessions";
import { VOICE_AGENT_END_CHECK_DELAYS_MS } from "../src/web/bot-voice-agent-session";
import type { WebServer } from "../src/web/server";
import { topicServer, type ServerCtx } from "./topic-fixture";
import { bridge, readyAgent, removeSessionWorlds, sessionWorld, tokenName, type SessionWorld } from "./voice-agent-session-fixture";

const root = await mkdtemp(join(tmpdir(), "voice-agent-timeout-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  removeSessionWorlds();
});
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
});

/** Buns Standard für idleTimeout; der Server setzt keinen eigenen Wert */
const BUN_IDLE_MS = 10_000;

const start = (ctx: ServerCtx) => ctx.api("/api/voice-agents/jarvis/session", "POST", {});
/** Start ohne Body: Diese Form kappt Bun nach seiner Ruhezeit */
const startNoBody = (ctx: ServerCtx) => ctx.api("/api/voice-agents/jarvis/session", "POST");
const end = (ctx: ServerCtx) => ctx.api("/api/voice-agents/jarvis/session/end", "POST", { conversationId: "conv_1" });

/** Echter Server, echtes Warten nach dem Auflegen (Standard 0, 1,5 und 3 Sekunden) */
async function world(): Promise<{ w: SessionWorld; ctx: ServerCtx }> {
  const w = sessionWorld();
  await readyAgent(w, "jarvis", bridge);
  const ctx = await topicServer(root, servers, null, { voiceAgentSessions: w.port({ sleep: (ms) => Bun.sleep(ms) }) });
  return { w, ctx };
}

async function timed(run: () => Promise<Response>): Promise<{ status: number; body: any; ms: number }> {
  const t0 = performance.now();
  const res = await run();
  const body = await res.json();
  return { status: res.status, body, ms: performance.now() - t0 };
}

/** Gespräch läuft; dann beendet es ElevenLabs nach 4 Minuten, und jede Antwort des Anbieters kommt erst nach delayMs */
async function endedAtProvider(delayMs: number): Promise<{ w: SessionWorld; ctx: ServerCtx }> {
  const { w, ctx } = await world();
  expect((await start(ctx)).status).toBe(200);
  w.clock.now += 4 * 60_000;
  w.hangUp("conv_1");
  w.providerDelayMs = delayMs;
  return { w, ctx };
}

/** Start nach Statusklärung: altes Gespräch mit 4 Minuten gebucht, neues offen, je eine Status- und Tokenanfrage */
async function expectRestarted(w: SessionWorld, result: { status: number; body: any; ms: number }): Promise<void> {
  expect(result.status).toBe(200);
  expect(tokenName(result.body.conversationToken)).toBe("gespraechstoken-2");
  expect(w.statusCalls.map((c) => c.id)).toEqual(["conv_1"]);
  expect(w.calls).toHaveLength(2);
  expect(result.ms).toBeGreaterThan(BUN_IDLE_MS + 1_000);
  const sitzungen = (await readWebSessions("jarvis", w.paths)).sitzungen.map((s) => [s.gespraech, s.ende !== null, s.minuten]);
  expect(sitzungen).toEqual([
    ["conv_1", true, 4],
    ["conv_2", false, 12],
  ]);
}

describe("HTTP-Zeitlimit bei langsamen Antworten des Anbieters", () => {
  test(
    "Ende mit drei Statusabrufen zu je 3 Sekunden plus Wartezeiten (13,5 Sekunden), Start mit vorgeschalteter Statusklärung (12 Sekunden) mit und ohne Body: Antworten kommen vollständig an",
    async () => {
      expect(VOICE_AGENT_END_CHECK_DELAYS_MS).toEqual([0, 1_500, 3_000]);
      const ending = await world();
      expect((await start(ending.ctx)).status).toBe(200);
      // Ende: ElevenLabs meldet weiter in-progress, jede Antwort nach 3 Sekunden
      ending.w.providerDelayMs = 3_000;
      // Start: Status des alten Gesprächs und neues Token je nach 6 Sekunden
      const noBody = await endedAtProvider(6_000);
      const withBody = await endedAtProvider(6_000);

      const [ended, startedNoBody, startedWithBody] = await Promise.all([
        timed(() => end(ending.ctx)),
        timed(() => startNoBody(noBody.ctx)),
        timed(() => start(withBody.ctx)),
      ]);

      expect(ended.status).toBe(202);
      expect(ended.body).toMatchObject({ ausstehend: true, reason: "anbieter_aktiv" });
      expect(ending.w.statusCalls.map((c) => c.id)).toEqual(["conv_1", "conv_1", "conv_1"]);
      expect(ended.ms).toBeGreaterThan(BUN_IDLE_MS + 3_000);
      await expectRestarted(noBody.w, startedNoBody);
      await expectRestarted(withBody.w, startedWithBody);
    },
    60_000
  );
});
