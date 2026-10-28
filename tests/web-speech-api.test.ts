/**
 * Issue #248, Checkbox 3: GET /api/voice (modes.local) und der Abschnitt
 * speech der Einstellungen-API. Status mit Anbieter-Attrappen über
 * createSpeech; Einstellungen über die echte, temporäre Einstellungsdatei
 * (setSettingsPath) und botSettings. Kein Netzwerk, kein Subprozess, kein
 * Modell: die echten Anbieter prüfen nur Dateien, PATH und Umgebung.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSettingsPath, type Settings } from "../src/lib/settings";
import { createSpeech } from "../src/lib/speech/chain";
import { STT_IDS, TTS_IDS, type SttId, type TtsId } from "../src/lib/speech/ids";
import type { SttProvider, TtsProvider } from "../src/lib/speech/types";
import { botSettings, botVoice } from "../src/web/bot-settings";
import { DEMO_SPEECH_OPTIONS, createDemoSettings, createDemoVoice } from "../src/web/demo";
import type { WebServer } from "../src/web/server";
import { applySettingsPatch } from "../src/web/settings";
import type { VoicePort } from "../src/web/voice";
import { isolateAgentCatalog } from "./catalog-fixture";
import { topicServer } from "./topic-fixture";

const ENV_KEYS = [
  "SPEECH_STT",
  "SPEECH_TTS",
  "WHISPER_MODEL_PATH",
  "WHISPER_CLI_PATH",
  "LOCAL_TTS",
  "LOCAL_TTS_PYTHON",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
  "GEMINI_API_KEY",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

const root = await mkdtemp(join(tmpdir(), "web-speech-api-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
let file: string;
let counter = 0;
isolateAgentCatalog();

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  // Echte Anbieter ohne Zufall vom Rechner: kein whisper.cpp, kein Qwen3, Gemini mit Test-Schlüssel
  process.env.WHISPER_MODEL_PATH = join(root, "fehlt.bin");
  process.env.LOCAL_TTS = "false";
  process.env.GEMINI_API_KEY = "test-schluessel";
  file = join(root, `settings-${++counter}.json`);
  setSettingsPath(file);
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  setSettingsPath();
});

async function readFileJson(): Promise<any> {
  try {
    return JSON.parse(await readFile(file, "utf-8"));
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

// --- Status mit Attrappen ------------------------------------------------------

function voicePort(o: { stt?: Partial<Record<SttId, boolean>>; tts?: Partial<Record<TtsId, boolean>>; settings?: Settings }): VoicePort {
  const reasons: Record<string, string> = { parakeet: "nicht installiert", "whisper-cpp": "Modelldatei fehlt", elevenlabs: "ELEVENLABS_API_KEY fehlt", gemini: "GEMINI_API_KEY fehlt", "qwen3-mlx": "Python-Umgebung für Qwen3-TTS fehlt", pocket: "nicht installiert" };
  const labels: Record<string, string> = { parakeet: "Parakeet", "whisper-cpp": "whisper.cpp", elevenlabs: "ElevenLabs", gemini: "Gemini", browser: "Browser-Stimme", "qwen3-mlx": "Qwen3-TTS", pocket: "Pocket TTS" };
  const never = async (): Promise<never> => {
    throw new Error("darf nicht laufen");
  };
  const stt: SttProvider[] = STT_IDS.map(id => ({
    id,
    label: labels[id],
    local: id === "parakeet" || id === "whisper-cpp",
    available: () => (o.stt?.[id] ? { ok: true } : { ok: false, reason: reasons[id] }),
    transcribe: never,
  }));
  const tts: TtsProvider[] = TTS_IDS.map(id => ({
    id,
    label: labels[id],
    local: id !== "elevenlabs" && id !== "gemini",
    where: id === "browser" ? "browser" : "server",
    available: () => (id === "browser" || o.tts?.[id] ? { ok: true } : { ok: false, reason: reasons[id] }),
    synthesize: never,
  }));
  const speech = createSpeech({ stt, tts, getSettings: () => o.settings ?? {}, env: () => ({}), log: () => {}, readFile: never });
  return { localMode: () => speech.localMode() };
}

async function voiceServer(voice?: VoicePort) {
  return topicServer(root, servers, null, voice ? { voice } : {});
}

describe("GET /api/voice", () => {
  test("ohne Anmeldung 401, falsche Methode 405, ohne Port 503", async () => {
    const ctx = await voiceServer(voicePort({ stt: { "whisper-cpp": true } }));
    expect((await fetch(`${ctx.origin}/api/voice`, { headers: { origin: ctx.origin } })).status).toBe(401);
    const post = await ctx.api("/api/voice", "POST", {});
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
    const none = await voiceServer();
    expect((await none.api("/api/voice")).status).toBe(503);
  });

  test("auto mit verfügbarem Anbieter: bereit, erster verfügbarer, Browser-Stimme", async () => {
    const ctx = await voiceServer(voicePort({ stt: { "whisper-cpp": true, gemini: true } }));
    const res = await ctx.api("/api/voice");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      modes: {
        local: {
          ready: true,
          stt: { id: "whisper-cpp", label: "whisper.cpp", local: true, available: true },
          tts: { id: "browser", label: "Browser-Stimme", where: "browser", available: true },
        },
      },
    });
  });

  test("auto ohne verfügbaren Anbieter: stt null, nicht bereit mit Grund", async () => {
    const ctx = await voiceServer(voicePort({}));
    const { modes } = await (await ctx.api("/api/voice")).json();
    expect(modes.local.ready).toBe(false);
    expect(modes.local.stt).toBeNull();
    expect(modes.local.reason).toBe("Hören: kein Anbieter eingerichtet");
  });

  test("fest gewählt und nicht verfügbar: nicht bereit, obwohl ein anderer verfügbar wäre", async () => {
    const ctx = await voiceServer(voicePort({ stt: { gemini: true }, settings: { speech: { stt: "whisper-cpp" } } }));
    const { modes } = await (await ctx.api("/api/voice")).json();
    expect(modes.local.ready).toBe(false);
    expect(modes.local.stt).toEqual({ id: "whisper-cpp", label: "whisper.cpp", local: true, available: false });
    expect(modes.local.reason).toBe("Hören: whisper.cpp ist nicht verfügbar (Modelldatei fehlt)");
  });

  test("fest gewählter TTS nicht verfügbar: nicht bereit, kein Ausweichen auf den Browser", async () => {
    const ctx = await voiceServer(voicePort({ stt: { gemini: true }, settings: { speech: { tts: "elevenlabs" } } }));
    const { modes } = await (await ctx.api("/api/voice")).json();
    expect(modes.local.ready).toBe(false);
    expect(modes.local.stt.id).toBe("gemini");
    expect(modes.local.tts).toEqual({ id: "elevenlabs", label: "ElevenLabs", where: "server", available: false });
    expect(modes.local.reason).toBe("Sprechen: ElevenLabs ist nicht verfügbar (ELEVENLABS_API_KEY fehlt)");
  });

  test("fest gewählter, verfügbarer TTS wird genannt", async () => {
    const ctx = await voiceServer(voicePort({ stt: { gemini: true }, tts: { gemini: true }, settings: { speech: { tts: "gemini" } } }));
    const { modes } = await (await ctx.api("/api/voice")).json();
    expect(modes.local).toEqual({
      ready: true,
      stt: { id: "gemini", label: "Gemini", local: false, available: true },
      tts: { id: "gemini", label: "Gemini", where: "server", available: true },
    });
  });

  test("botVoice folgt der Einstellungsdatei ohne Neustart", async () => {
    await writeFile(file, JSON.stringify({ speech: { stt: "whisper-cpp" } }));
    expect(botVoice.localMode().stt).toEqual({ id: "whisper-cpp", label: "whisper.cpp", local: true, available: false });
    await writeFile(file, JSON.stringify({ speech: { stt: "gemini", tts: "browser" } }));
    const local = botVoice.localMode();
    expect(local.ready).toBe(true);
    expect(local.stt?.id).toBe("gemini");
  });

  test("Demo-Status über den Demo-Einstellungen", async () => {
    const settings = createDemoSettings({});
    const voice = createDemoVoice(settings);
    expect(voice.localMode()).toMatchObject({ ready: true, stt: { id: "whisper-cpp" }, tts: { id: "browser" } });
    await settings.write({ speech: { stt: "parakeet" } });
    expect(voice.localMode()).toMatchObject({ ready: false, reason: "Hören: Parakeet ist nicht verfügbar (nicht installiert)" });
  });
});

// --- Einstellungen-API ---------------------------------------------------------

async function settingsServer() {
  return topicServer(root, servers, null, { settings: botSettings });
}

describe("speech in /api/settings", () => {
  test("GET: effective, geerbte Werte und speechOptions mit Gründen", async () => {
    process.env.SPEECH_STT = "gemini";
    const ctx = await settingsServer();
    const body = await (await ctx.api("/api/settings")).json();
    expect(body.effective.speech).toEqual({
      stt: { value: "gemini", source: "env" },
      tts: { value: "auto", source: "code" },
      language: { value: "auto", source: "code" },
    });
    expect(body.inheritedModels.speech.stt).toEqual({ value: "gemini", source: "env" });
    expect(body.speechOptions.languages).toEqual(["de", "en"]);
    expect(body.speechOptions.stt.map((o: any) => o.id)).toEqual([...STT_IDS]);
    expect(body.speechOptions.tts.map((o: any) => o.id)).toEqual([...TTS_IDS]);
    const stt = Object.fromEntries(body.speechOptions.stt.map((o: any) => [o.id, o]));
    const tts = Object.fromEntries(body.speechOptions.tts.map((o: any) => [o.id, o]));
    // Seit Issue #251 echt: ohne Dateien und Nachweis unter models/speech nicht eingerichtet
    expect(stt.parakeet).toEqual({ id: "parakeet", label: "Parakeet", local: true, available: false, reason: "nicht eingerichtet, tybo setup sprache ausführen" });
    expect(stt["whisper-cpp"]).toEqual({ id: "whisper-cpp", label: "whisper.cpp", local: true, available: false, reason: "Modelldatei fehlt" });
    expect(stt.elevenlabs).toEqual({ id: "elevenlabs", label: "ElevenLabs", local: false, available: false, reason: "ELEVENLABS_API_KEY fehlt" });
    expect(stt.gemini).toEqual({ id: "gemini", label: "Gemini", local: false, available: true });
    expect(tts.browser).toEqual({ id: "browser", label: "Browser-Stimme", local: true, where: "browser", available: true });
    expect(tts["qwen3-mlx"].reason).toBe("mit LOCAL_TTS=false abgeschaltet");
    expect(tts.pocket.available).toBe(false);
    // Schlüssel nie in der Antwort
    expect(JSON.stringify(body)).not.toContain("test-schluessel");
  });

  test("PATCH setzt, Datei gewinnt gegen .env, auto wird ausdrücklich gespeichert", async () => {
    process.env.SPEECH_STT = "gemini";
    const ctx = await settingsServer();
    let res = await ctx.api("/api/settings", "PATCH", { speech: { stt: "elevenlabs", language: "en" } });
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(await readFileJson()).toEqual({ speech: { stt: "elevenlabs", language: "en" } });
    expect(body.effective.speech.stt).toEqual({ value: "elevenlabs", source: "settings" });
    expect(body.inheritedModels.speech.stt).toEqual({ value: "gemini", source: "env" });
    res = await ctx.api("/api/settings", "PATCH", { speech: { stt: "auto" } });
    body = await res.json();
    expect(body.effective.speech.stt).toEqual({ value: "auto", source: "settings" });
    expect(ctx.logs.some(l => l.includes("speech.stt"))).toBe(true);
    expect(ctx.logs.join("\n")).not.toContain("elevenlabs");
  });

  test("PATCH mit null entfernt das Feld, leerer Abschnitt wird aufgeräumt, null entfernt den Abschnitt", async () => {
    await writeFile(file, JSON.stringify({ speech: { stt: "gemini", tts: "browser" }, fallback: { offlineOnly: true } }));
    const ctx = await settingsServer();
    await ctx.api("/api/settings", "PATCH", { speech: { stt: null } });
    expect(await readFileJson()).toEqual({ speech: { tts: "browser" }, fallback: { offlineOnly: true } });
    await ctx.api("/api/settings", "PATCH", { speech: { tts: "" } });
    expect(await readFileJson()).toEqual({ fallback: { offlineOnly: true } });
    await ctx.api("/api/settings", "PATCH", { speech: { stt: "whisper-cpp", language: "fr" } });
    expect((await readFileJson()).speech).toEqual({ stt: "whisper-cpp", language: "fr" });
    // Andere Felder speichern überschreibt gespeicherte, auch nicht verfügbare Anbieter und fremde Sprachen nicht
    await ctx.api("/api/settings", "PATCH", { speech: { tts: "gemini" } });
    expect((await readFileJson()).speech).toEqual({ stt: "whisper-cpp", language: "fr", tts: "gemini" });
    await ctx.api("/api/settings", "PATCH", { speech: null });
    expect(await readFileJson()).toEqual({ fallback: { offlineOnly: true } });
  });

  test("PATCH lehnt unbekannte Felder und Kennungen ab, nichts wird gespeichert", async () => {
    await writeFile(file, JSON.stringify({ speech: { stt: "gemini" } }));
    const ctx = await settingsServer();
    let res = await ctx.api("/api/settings", "PATCH", { speech: { voices: "x" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Unbekanntes Feld: speech.voices");
    res = await ctx.api("/api/settings", "PATCH", { speech: { stt: "deepgram" } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues[0].path).toBe("speech.stt");
    expect(body.error).not.toContain("deepgram");
    res = await ctx.api("/api/settings", "PATCH", { speech: { tts: "openai" } });
    expect(res.status).toBe(400);
    res = await ctx.api("/api/settings", "PATCH", { speech: { language: "deu" } });
    expect(res.status).toBe(400);
    expect((await res.json()).issues[0]).toEqual({ path: "speech.language", message: "auto oder zwei Kleinbuchstaben" });
    res = await ctx.api("/api/settings", "PATCH", { speech: { stt: 3 } });
    expect(res.status).toBe(400);
    res = await ctx.api("/api/settings", "PATCH", { speech: "gemini" });
    expect(res.status).toBe(400);
    expect(await readFileJson()).toEqual({ speech: { stt: "gemini" } });
  });

  test("applySettingsPatch: speech als Abschnitt mit drei Textfeldern", () => {
    const r = applySettingsPatch({ speech: { stt: "gemini" } }, { speech: { tts: " browser ", stt: null } }, []);
    expect(r).toEqual({ ok: true, value: { speech: { tts: "browser" } }, changed: ["speech.stt", "speech.tts"] });
  });

  test("Demo-Einstellungen prüfen speech wie das Schema und nennen dieselben Kennungen", () => {
    const demo = createDemoSettings({});
    expect(demo.validate({ speech: { stt: "whisper-cpp", tts: "browser", language: "en" } }).ok).toBe(true);
    expect(demo.validate({ speech: { stt: "deepgram" } }).ok).toBe(false);
    expect(demo.validate({ speech: { language: "DE" } }).ok).toBe(false);
    expect(DEMO_SPEECH_OPTIONS.stt.map(o => o.id)).toEqual([...STT_IDS]);
    expect(DEMO_SPEECH_OPTIONS.tts.map(o => o.id)).toEqual([...TTS_IDS]);
    for (const list of [DEMO_SPEECH_OPTIONS.stt, DEMO_SPEECH_OPTIONS.tts]) {
      expect(list.some(o => o.available)).toBe(true);
      expect(list.some(o => !o.available && o.reason)).toBe(true);
    }
    expect(demo.effective({ speech: { tts: "gemini" } }).speech).toEqual({
      stt: { value: "auto", source: "code" },
      tts: { value: "gemini", source: "settings" },
      language: { value: "auto", source: "code" },
    });
  });
});
