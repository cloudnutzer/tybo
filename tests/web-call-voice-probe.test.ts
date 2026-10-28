/**
 * Hörprobe und Einstellung der Stimme des Telefonhörers (Issue #276,
 * Checkbox 4): Route POST /api/voice/call/voice-probe (Login, Origin, Grenze,
 * Zeitlimit, besetzt), Anschluss voiceProbe mit Stimme und Modell des
 * Telefonhörers statt speech.tts, ohne Rückfall; Speichern über
 * PATCH /api/settings. Fetch-Attrappe, kein Aufruf bei ElevenLabs.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSettingsPath, type Settings } from "../src/lib/settings";
import { createSpeech } from "../src/lib/speech/chain";
import { createTtsProviders, type ProviderDeps } from "../src/lib/speech/providers";
import type { SttProvider, TtsProvider } from "../src/lib/speech/types";
import { createBotCall } from "../src/web/bot-call";
import { botSettings } from "../src/web/bot-settings";
import { CALL_VOICE_PROBE_PATH, CALL_VOICE_PROBE_TEXT, CALL_VOICE_PROBE_TEXT_SPOKEN, type CallVoiceProbeResult } from "../src/web/call-probe";
import type { CallPort } from "../src/web/call-protocol";
import { createWebServer, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import { fakePort } from "./call-fixture";
import { isolateAgentCatalog } from "./catalog-fixture";
import { topicServer } from "./topic-fixture";

const root = await mkdtemp(join(tmpdir(), "tybo-call-voice-probe-"));
const servers: WebServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map(s => s.stop()));
  await rm(root, { recursive: true, force: true });
}, 30_000);
isolateAgentCatalog();

const KEY = "KEY-MARKER-EL";
const PASSWORD = "test-passwort-hoerprobe";
const WAV = Buffer.from("RIFF0000WAVEfmt ");

async function probeServer(port: CallPort | undefined, extra: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(root, "srv-"));
  const store = new ConversationStore({ dir: join(dir, "web") });
  await store.load();
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    { sessionFile: join(dir, "sessions.json"), conversationStore: store, ...(port ? { call: port } : {}), log: () => {}, ...extra },
  );
  servers.push(server);
  const url = server.url;
  const login = await fetch(`${url}/api/login`, { method: "POST", headers: { origin: url }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const post = (headers: Record<string, string> = { cookie, origin: url }) => fetch(`${url}${CALL_VOICE_PROBE_PATH}`, { method: "POST", headers });
  return { url, cookie, post };
}

describe("POST /api/voice/call/voice-probe", () => {
  test("hinter Login und Origin; liefert WAV ohne Cache; siebte Hörprobe in zehn Minuten: 429", async () => {
    let runs = 0;
    const p = fakePort();
    const port: CallPort = { ...p.port, voiceProbe: async () => (runs++, { ok: true, audio: WAV, provider: "elevenlabs", firstMs: 151.4 }) };
    const s = await probeServer(port);
    expect((await s.post({ origin: s.url })).status).toBe(401);
    expect((await s.post({ cookie: s.cookie, origin: "http://evil.example" })).status).toBe(403);
    expect(runs).toBe(0);
    for (let i = 0; i < 6; i++) {
      const res = await s.post();
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("audio/wav");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-tybo-voice")).toBe("elevenlabs");
      expect(res.headers.get("x-tybo-first-audio-ms")).toBe("151");
      expect(Buffer.from(await res.arrayBuffer())).toEqual(WAV);
    }
    const seventh = await s.post();
    expect(seventh.status).toBe(429);
    expect(Number(seventh.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await seventh.json()).toEqual({ error: CALL_VOICE_PROBE_TEXT.tooMany, reason: "zu-viele" });
    expect(runs).toBe(6);
    expect((await fetch(`${s.url}${CALL_VOICE_PROBE_PATH}`, { headers: { cookie: s.cookie } })).status).toBe(405);
  });

  test("ohne Hörprobe 503; Fehler 422 mit Grund; Zeitlimit 504 bricht über das Signal ab", async () => {
    expect((await (await probeServer(undefined)).post()).status).toBe(503);
    expect((await (await probeServer(fakePort().port)).post()).status).toBe(503);
    const failing = await probeServer({ ...fakePort().port, voiceProbe: async () => ({ ok: false, reason: "ElevenLabs: HTTP 401." }) });
    const res = await failing.post();
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "ElevenLabs: HTTP 401.", reason: "fehlgeschlagen" });
    let seen: AbortSignal | undefined;
    const hanging = await probeServer(
      {
        ...fakePort().port,
        voiceProbe: o =>
          new Promise<CallVoiceProbeResult>(() => {
            seen = o?.signal;
          }),
      },
      { callVoiceProbeTimeoutMs: 50 },
    );
    const slow = await hanging.post();
    expect(slow.status).toBe(504);
    expect(seen?.aborted).toBe(true);
  });
});

describe("Anschluss voiceProbe", () => {
  function botWith(settings: Settings, respond: (url: string, body: any) => Response, o: { key?: boolean } = {}) {
    const calls: { url: string; body: any }[] = [];
    const deps: ProviderDeps = {
      env: () => ({ ...(o.key === false ? {} : { ELEVENLABS_API_KEY: KEY }), ELEVENLABS_VOICE_ID: "telegramStimme" }),
      run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
      fetch: async (url, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url, body });
        return respond(url, body);
      },
      exists: () => false,
      which: () => null,
      readFile: async () => Buffer.alloc(0),
      writeFile: async () => {},
      unlink: async () => {},
      mkdir: async () => {},
      cwd: () => "/nirgends",
      tmpDir: "/tmp",
      unique: () => "u",
    };
    const eleven = createTtsProviders(deps).find(p => p.id === "elevenlabs")!;
    let pocketCalls = 0;
    const pocket: TtsProvider = {
      id: "pocket",
      label: "Pocket",
      local: true,
      where: "server",
      available: () => ({ ok: true }),
      synthesize: async () => ({ audio: Buffer.alloc(0), mime: "audio/wav" }),
      streamSampleRate: 24_000,
      async *synthesizeStream() {
        pocketCalls++;
        yield new Uint8Array([7, 7]);
      },
    };
    const stt: SttProvider = { id: "parakeet", label: "Parakeet", local: true, available: () => ({ ok: true }), transcribe: async () => "x" };
    const speech = createSpeech({ stt: [stt], tts: [eleven, pocket], getSettings: () => settings, env: () => ({}), log: () => {}, readFile: async () => Buffer.alloc(0) });
    const bot = createBotCall({
      userId: "1",
      groupId: () => null,
      agentForTopic: () => "general",
      speech: () => speech,
      resolve: async () => ({ spec: "x", kind: "claude", model: "m", via: "api", effort: "low", ready: true, expectation: "", billing: null, costsMoney: false, setting: "auto", source: "code" }),
      ways: async () => [],
      readRestart: async () => null,
      isIntakeClosed: () => false,
      reserveRequest: () => () => {},
      env: {},
      log: () => {},
    });
    return { bot, calls, pocketCalls: () => pocketCalls };
  }

  test("spricht den festen Satz mit Stimme und Modell des Telefonhörers, nicht mit speech.tts bzw. ELEVENLABS_VOICE_ID", async () => {
    const b = botWith({ speech: { tts: "elevenlabs", call: { tts: "elevenlabs", elevenlabsVoice: "anrufStimme", elevenlabsModel: "eleven_turbo_v2_5" } } }, () => new Response(new Uint8Array([1, 0, 2, 0, 3])));
    const r = await b.bot.voiceProbe!();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provider).toBe("elevenlabs");
    expect(r.audio.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(b.calls).toEqual([{ url: "https://api.elevenlabs.io/v1/text-to-speech/anrufStimme/stream?output_format=pcm_24000", body: { text: CALL_VOICE_PROBE_TEXT_SPOKEN, model_id: "eleven_turbo_v2_5", voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1 } } }]);
  });

  test("Fehler ohne Rückfall: ehrlicher Grund, Pocket nicht gefragt, kein Schlüssel im Grund", async () => {
    const b = botWith({ speech: { call: { tts: "elevenlabs" } } }, () => new Response(`{"detail":"${KEY}"}`, { status: 401 }));
    const r = await b.bot.voiceProbe!();
    expect(r).toEqual({ ok: false, reason: "ElevenLabs: HTTP 401." });
    expect(b.pocketCalls()).toBe(0);
  });

  test("ElevenLabs gewählt, kein Schlüssel, Pocket verfügbar: Fehlermeldung, kein Pocket-Aufruf, kein Aufruf bei ElevenLabs", async () => {
    const b = botWith({ speech: { call: { tts: "elevenlabs" } } }, () => new Response(new Uint8Array([1, 0, 2, 0])), { key: false });
    const r = await b.bot.voiceProbe!();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("ElevenLabs ist nicht verfügbar (ELEVENLABS_API_KEY fehlt).");
    expect(b.pocketCalls()).toBe(0);
    expect(b.calls).toHaveLength(0);
  });

  test("Browser-Stimme: keine Hörprobe vom Server, kein Aufruf", async () => {
    const b = botWith({ speech: { call: { tts: "browser" } } }, () => new Response(new Uint8Array([1, 2])));
    expect(await b.bot.voiceProbe!()).toEqual({ ok: false, reason: CALL_VOICE_PROBE_TEXT.browser });
    expect(b.calls).toHaveLength(0);
    expect((await b.bot.status()).voiceProbe).toBe(true);
  });
});

describe("speech.call.tts über PATCH /api/settings", () => {
  let file: string;
  let n = 0;
  beforeEach(() => {
    file = join(root, `settings-${++n}.json`);
    setSettingsPath(file);
  });
  afterEach(() => setSettingsPath());

  test("Stimme setzen, neu laden, zurück auf auto; ungültige Kennung und Schlüsselfeld abgelehnt", async () => {
    const ctx = await topicServer(root, servers, null, { settings: botSettings });
    const read = async () => JSON.parse(await readFile(file, "utf8"));
    let res = await ctx.api("/api/settings", "PATCH", { speech: { tts: "pocket", call: { tts: "elevenlabs", elevenlabsVoice: "anrufStimme", elevenlabsModel: "eleven_flash_v2_5" } } });
    expect(res.status).toBe(200);
    expect((await read()).speech).toEqual({ tts: "pocket", call: { tts: "elevenlabs", elevenlabsVoice: "anrufStimme", elevenlabsModel: "eleven_flash_v2_5" } });
    const got = await ctx.api("/api/settings", "GET");
    expect((await got.json()).settings.speech.call).toEqual({ tts: "elevenlabs", elevenlabsVoice: "anrufStimme", elevenlabsModel: "eleven_flash_v2_5" });
    expect((await ctx.api("/api/settings", "PATCH", { speech: { call: { elevenlabsVoice: "../x" } } })).status).toBe(400);
    expect((await ctx.api("/api/settings", "PATCH", { speech: { call: { elevenlabsKey: KEY } } })).status).toBe(400);
    res = await ctx.api("/api/settings", "PATCH", { speech: { call: { tts: null, elevenlabsVoice: null, elevenlabsModel: null } } });
    expect(res.status).toBe(200);
    expect((await read()).speech).toEqual({ tts: "pocket" });
    expect(await readFile(file, "utf8")).not.toContain(KEY);
  });
});
