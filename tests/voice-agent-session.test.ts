/**
 * Issue #494: POST /api/voice-agents/<kennung>/session über den echten Server,
 * mit echter Ablage im Temp-Ordner und dem Anbieter als Fetch-Attrappe.
 * Login, Freischaltung, Abgleich, Web-Freigabe nur bei gehirn bruecke,
 * Parallel-Sperre, Rate-Limit, Anbieterfehler; Schlüssel und Token nie im Log.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateState } from "../src/lib/voice-agents/state";
import { verifyWebCall } from "../src/lib/voice-agents/web-calls";
import { readWebSessions, WEB_SESSION_RATE } from "../src/lib/voice-agents/web-sessions";
import type { WebServer } from "../src/web/server";
import { readCliToken } from "../src/web/cli-token";
import { topicServer } from "./topic-fixture";
import { writeRecipe } from "./voice-agents-manage-fixture";
import { API_KEY, BRIDGE_TOKEN, bridge, readyAgent, removeSessionWorlds, sessionServer, sessionWorld, tokenName, type SessionWorld } from "./voice-agent-session-fixture";

const root = await mkdtemp(join(tmpdir(), "voice-agent-session-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  removeSessionWorlds();
});
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
});

const start = (ctx: { api: (path: string, method?: string, body?: unknown) => Promise<Response> }, kennung: string) =>
  ctx.api(`/api/voice-agents/${kennung}/session`, "POST", {});
const webCallFiles = (w: SessionWorld, kennung: string) => {
  const dir = join(w.paths.dataDir, kennung, "web-calls");
  return existsSync(dir) ? readdirSync(dir) : [];
};

/** Kein Schlüssel und kein Brücken-Token in Antworten und Logs; Gesprächs-Token nie im Log */
function expectNoSecrets(texts: string[], logs: string[]): void {
  for (const text of [...texts, ...logs]) {
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(BRIDGE_TOKEN);
  }
  for (const line of logs) expect(line).not.toContain("gespraechstoken");
}

describe("Token-Route: Ausgabe beim Anbieter", () => {
  test("gehirn anbieter: Token und Gesprächs-ID, keine Web-Freigabe, kein Brücken-Token nötig", async () => {
    const w = sessionWorld({ env: { VOICE_BRIDGE_TOKEN: undefined } });
    await readyAgent(w, "experte");
    const ctx = await sessionServer(root, servers, w);
    const res = await start(ctx, "experte");
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = JSON.parse(text);
    expect(body).toEqual({ conversationToken: expect.any(String), conversationId: "conv_1", connectionType: "webrtc", expiresInSec: 900, maxMinuten: 12 });
    // Genau das Token des Anbieters, unverändert
    expect(tokenName(body.conversationToken)).toBe("gespraechstoken-1");
    // Genau ein Aufruf mit dem Schlüssel im Kopf, Agent aus state.json
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0].url).toBe("https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=agent_experte");
    expect(w.calls[0].headers["xi-api-key"]).toBe(API_KEY);
    expect(webCallFiles(w, "experte")).toEqual([]);
    expectNoSecrets([text], [...w.logs, ...ctx.logs]);
    expect(w.logs.some((l) => l.includes("experte Web-Gespräch: gestartet"))).toBe(true);
  });

  test("gehirn bruecke: Web-Freigabe für genau diese Gesprächs-ID steht vor der Antwort", async () => {
    const w = sessionWorld();
    await readyAgent(w, "jarvis", bridge);
    const ctx = await sessionServer(root, servers, w);
    const res = await start(ctx, "jarvis");
    expect(res.status).toBe(200);
    const body = await res.json();
    const options = { ...w.paths, token: BRIDGE_TOKEN, now: () => w.clock.now };
    expect(await verifyWebCall({ kennung: "jarvis", conversationId: body.conversationId }, options)).toBe(true);
    expect(await verifyWebCall({ kennung: "jarvis", conversationId: "conv_anderes" }, options)).toBe(false);
    expect(webCallFiles(w, "jarvis")).toHaveLength(1);
    // Gültig bis zur harten Grenze: Token (15) plus maxMinuten (12) plus eine Minute Zuschlag, danach nicht mehr
    expect(await verifyWebCall({ kennung: "jarvis", conversationId: body.conversationId }, { ...options, now: () => w.clock.now + 28 * 60_000 - 1 })).toBe(true);
    expect(await verifyWebCall({ kennung: "jarvis", conversationId: body.conversationId }, { ...options, now: () => w.clock.now + 28 * 60_000 })).toBe(false);
    expectNoSecrets([JSON.stringify(body)], [...w.logs, ...ctx.logs]);
  });

  test("gehirn bruecke ohne VOICE_BRIDGE_TOKEN: 503, kein Aufruf beim Anbieter", async () => {
    const w = sessionWorld({ env: { VOICE_BRIDGE_TOKEN: "" } });
    await readyAgent(w, "jarvis", bridge);
    const ctx = await sessionServer(root, servers, w);
    const res = await start(ctx, "jarvis");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: "keine_bruecke" });
    expect(w.calls).toEqual([]);
  });

  test("ohne ELEVENLABS_API_KEY: 503, kein Aufruf", async () => {
    const w = sessionWorld({ env: { ELEVENLABS_API_KEY: "" } });
    await readyAgent(w, "experte");
    const ctx = await sessionServer(root, servers, w);
    const res = await start(ctx, "experte");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: "kein_anbieter" });
    expect(w.calls).toEqual([]);
  });
});

describe("Token-Route: wer kein Token bekommt", () => {
  test("ohne Login mit gültigem Origin: 401, kein Aufruf", async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte");
    const ctx = await sessionServer(root, servers, w);
    const res = await fetch(`${ctx.origin}/api/voice-agents/experte/session`, { method: "POST", headers: { origin: ctx.origin }, body: "{}" });
    expect(res.status).toBe(401);
    expect(w.calls).toEqual([]);
  });

  test("fremder Origin trotz Login: 403", async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte");
    const ctx = await sessionServer(root, servers, w);
    const res = await ctx.api("/api/voice-agents/experte/session", "POST", {}, { origin: "https://fremd.example" });
    expect(res.status).toBe(403);
    expect(w.calls).toEqual([]);
  });

  test("unbekannte Kennung: 404, ungültige Kennung: 404, kein Ordner angelegt", async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte");
    const ctx = await sessionServer(root, servers, w);
    for (const kennung of ["fremd", "Gross", "a..b", "%2e%2e", "%E0%A4%A"]) {
      const res = await start(ctx, kennung);
      expect(res.status).toBe(404);
    }
    expect(readdirSync(w.paths.dataDir).sort()).toEqual(["experte"]);
    expect(w.calls).toEqual([]);
  });

  test("Web-Zugang aus: 403 kein_web", async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte", (raw) => {
      raw.zugang.web = { link: false };
    });
    const ctx = await sessionServer(root, servers, w);
    const res = await start(ctx, "experte");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "kein_web" });
    expect(w.calls).toEqual([]);
  });

  test("ohne Freischaltung: direkter POST bekommt 403 gesperrt", async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte");
    await rm(join(w.paths.dataDir, "experte", "freischaltung.json"));
    const ctx = await sessionServer(root, servers, w);
    const res = await start(ctx, "experte");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "gesperrt" });
    expect(w.calls).toEqual([]);
  });

  test("Rezept nach der Freischaltung geändert: gesperrt, kein Token", async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte");
    writeRecipe(w, "experte", (raw) => {
      raw.zweck = "Etwas anderes";
    });
    const ctx = await sessionServer(root, servers, w);
    const res = await start(ctx, "experte");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "gesperrt" });
    expect(w.calls).toEqual([]);
  });

  test("freigeschaltet, aber beim Anbieter nicht in dieser Fassung abgeglichen: 409", async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte");
    await updateState("experte", { letzterHash: "0".repeat(64) }, w.paths);
    const ctx = await sessionServer(root, servers, w);
    let res = await start(ctx, "experte");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "nicht_abgeglichen" });
    // Ohne Agent beim Anbieter ebenso
    await updateState("experte", { agentId: undefined }, w.paths);
    res = await start(ctx, "experte");
    expect(res.status).toBe(409);
    expect(w.calls).toEqual([]);
  });

  test("ausstehender Abgleich gilt als nicht abgeglichen", async () => {
    const w = sessionWorld();
    const hash = await readyAgent(w, "experte");
    await updateState("experte", { ausstehend: { stand: {}, hash, eingabeHash: "x" } } as any, w.paths);
    const ctx = await sessionServer(root, servers, w);
    const res = await start(ctx, "experte");
    expect(res.status).toBe(409);
    expect(w.calls).toEqual([]);
  });

  test("Terminal-Schlüssel bekommt kein Token (nur Browser): 403, kein Aufruf", async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte");
    const tokenFile = join(w.root, "cli-token");
    const ctx = await topicServer(root, servers, null, { voiceAgentSessions: w.port(), cliTokenFile: tokenFile });
    const cliToken = (await readCliToken(tokenFile))!;
    const res = await fetch(`${ctx.origin}/api/voice-agents/experte/session`, { method: "POST", headers: { authorization: `Bearer ${cliToken}` }, body: "{}" });
    expect(res.status).toBe(403);
    expect(w.calls).toEqual([]);
  });
});

describe("Token-Route: Parallel-Sperre, Rate-Limit, Anbieterfehler", () => {
  test("zweiter Start während eines Gesprächs: 409, nach dem Ende wieder frei", async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte");
    const ctx = await sessionServer(root, servers, w);
    expect((await start(ctx, "experte")).status).toBe(200);
    const second = await start(ctx, "experte");
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ reason: "laeuft" });
    expect(w.calls).toHaveLength(1);
    // Endemeldung, solange ElevenLabs das Gespräch noch als aktiv führt: 202, Platz bleibt
    const pending = await ctx.api("/api/voice-agents/experte/session/end", "POST", { conversationId: "conv_1" });
    expect(pending.status).toBe(202);
    expect(await pending.json()).toMatchObject({ ausstehend: true, reason: "anbieter_aktiv" });
    expect((await start(ctx, "experte")).status).toBe(409);
    w.hangUp("conv_1");
    expect((await ctx.api("/api/voice-agents/experte/session/end", "POST", { conversationId: "conv_1" })).status).toBe(200);
    expect((await start(ctx, "experte")).status).toBe(200);
  });

  test("zwei Starts zugleich: genau einer bekommt ein Token", async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte");
    const ctx = await sessionServer(root, servers, w);
    const results = await Promise.all([start(ctx, "experte"), start(ctx, "experte"), start(ctx, "experte")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(w.calls).toHaveLength(1);
  });

  test("Gespräche je Rezept getrennt: ein laufendes sperrt kein anderes Rezept", async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte");
    await readyAgent(w, "coach");
    const ctx = await sessionServer(root, servers, w);
    expect((await start(ctx, "experte")).status).toBe(200);
    expect((await start(ctx, "coach")).status).toBe(200);
  });

  test(`Rate-Limit: nach ${WEB_SESSION_RATE.limit} Starts in 10 Minuten 429 mit Retry-After, danach wieder frei`, async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte");
    const ctx = await sessionServer(root, servers, w);
    for (let i = 1; i <= WEB_SESSION_RATE.limit; i++) {
      const res = await start(ctx, "experte");
      expect(res.status).toBe(200);
      const { conversationId } = await res.json();
      w.hangUp(conversationId);
      expect((await ctx.api("/api/voice-agents/experte/session/end", "POST", { conversationId })).status).toBe(200);
      w.clock.now += 30_000;
    }
    const blocked = await start(ctx, "experte");
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ reason: "zu_viele" });
    // Erster Start vor 3 Minuten: frei in 7 Minuten
    expect(Number(blocked.headers.get("retry-after"))).toBe(7 * 60);
    expect(w.calls).toHaveLength(WEB_SESSION_RATE.limit);
    w.clock.now += 7 * 60_000;
    expect((await start(ctx, "experte")).status).toBe(200);
  });

  test("Anbieter antwortet mit Fehler: 502 mit eigenem Satz, Reservierung zurückgenommen, Versuch zählt", async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte", bridge);
    w.replies.push({ status: 401, body: { detail: { message: `invalid api key ${API_KEY}` } } });
    const ctx = await sessionServer(root, servers, w);
    const res = await start(ctx, "experte");
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(JSON.parse(text)).toMatchObject({ reason: "anbieter" });
    expect(text).not.toContain("invalid api key");
    expect(webCallFiles(w, "experte")).toEqual([]);
    const stored = await readWebSessions("experte", w.paths);
    expect(stored.sitzungen).toEqual([]);
    expect(stored.versuche).toHaveLength(1);
    expect(w.logs.some((l) => l.includes("HTTP 401"))).toBe(true);
    expectNoSecrets([text], [...w.logs, ...ctx.logs]);
    // Gleich danach geht der nächste Start
    expect((await start(ctx, "experte")).status).toBe(200);
  });

  test("Anbieter nicht erreichbar, Zeitablauf, unvollständige Antwort: 502, nichts reserviert", async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte");
    w.replies.push("wirft", "zeitablauf", { status: 200, body: { token: "gespraechstoken-x" } }, { status: 200, body: { token: "", conversation_id: "conv_9" } }, { status: 200, body: { token: "t", conversation_id: "{{system__conversation_id}}" } });
    const ctx = await sessionServer(root, servers, w);
    for (let i = 0; i < 5; i++) expect((await start(ctx, "experte")).status).toBe(502);
    expect((await readWebSessions("experte", w.paths)).sitzungen).toEqual([]);
    expect(w.logs.some((l) => l.includes("Zeitablauf"))).toBe(true);
    expect(w.logs.some((l) => l.includes("nicht erreichbar"))).toBe(true);
    expectNoSecrets([], [...w.logs, ...ctx.logs]);
  });

  test("Neustart: laufendes Gespräch und Versuche stehen in der Datei und gelten weiter", async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte");
    const first = await sessionServer(root, servers, w);
    expect((await start(first, "experte")).status).toBe(200);
    const restarted = await sessionServer(root, servers, w);
    expect((await start(restarted, "experte")).status).toBe(409);
    // Ohne Nachweis des Anbieters gilt es bis zur harten Grenze als laufend:
    // Token (15) plus maxMinuten (12) plus Zuschlag (1), danach auch ohne Meldung vorbei
    w.clock.now += 28 * 60_000 - 1;
    expect((await start(restarted, "experte")).status).toBe(409);
    w.clock.now += 1;
    expect((await start(restarted, "experte")).status).toBe(200);
  });

  test("beschädigte Ablage: kein Token, 503", async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte");
    writeFileSync(join(w.paths.dataDir, "experte", "web-sitzungen.json"), "{kaputt");
    const ctx = await sessionServer(root, servers, w);
    const res = await start(ctx, "experte");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: "ablage" });
    expect(w.calls).toEqual([]);
  });

  test("Freigabe nicht speicherbar: kein Token in der Antwort, Reservierung zurück", async () => {
    const w = sessionWorld();
    await readyAgent(w, "jarvis", bridge);
    // web-calls als symbolischer Link: Die Ablage der Freigaben weigert sich, dort zu schreiben
    writeFileSync(join(w.paths.dataDir, "jarvis", "ziel"), "");
    symlinkSync(join(w.paths.dataDir, "jarvis", "ziel"), join(w.paths.dataDir, "jarvis", "web-calls"));
    const ctx = await sessionServer(root, servers, w);
    const res = await start(ctx, "jarvis");
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(text).not.toContain("gespraechstoken");
    expect((await readWebSessions("jarvis", w.paths)).sitzungen).toEqual([]);
  });
});
