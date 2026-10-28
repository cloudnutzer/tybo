/**
 * Stimme des Telefonhörers (Issue #276, Checkbox 2): speech.call.tts,
 * elevenlabsVoice und elevenlabsModel im Schema und in PATCH, Bedeutung von
 * auto und fehlender Einstellung, ohne Schlüssel nicht wählbar, Telegram
 * und Sprechmodus unverändert (ELEVENLABS_VOICE_ID wirkt dort weiter).
 */

import { describe, expect, test } from "bun:test";
import { createSpeech } from "../src/lib/speech/chain";
import { ELEVENLABS_DEFAULT_MODEL } from "../src/lib/speech/elevenlabs";
import { CALL_ELEVENLABS_DEFAULT_VOICE } from "../src/lib/speech/ids";
import { createTtsProviders, type ProviderDeps } from "../src/lib/speech/providers";
import type { SttProvider, TtsProvider } from "../src/lib/speech/types";
import { settingsSchema, type Settings } from "../src/lib/settings";
import { applySettingsPatch } from "../src/web/settings";

const KEY = "KEY-MARKER-EL";

function deps(env: Record<string, string | undefined>, fetchFn: ProviderDeps["fetch"]): ProviderDeps {
  return {
    env: () => env,
    run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    fetch: fetchFn,
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
}

const parakeet: SttProvider = { id: "parakeet", label: "Parakeet", local: true, available: () => ({ ok: true }), transcribe: async () => "x" };

function fakeLocal(id: "pocket" | "piper", ok = true): TtsProvider {
  return { id, label: id === "pocket" ? "Pocket TTS" : "Piper", local: true, where: "server", available: () => (ok ? { ok: true } : { ok: false, reason: "nicht eingerichtet" }), synthesize: async () => ({ audio: Buffer.alloc(0), mime: "audio/wav" }) };
}

/** Echte Anbieterliste (ElevenLabs aus providers.ts), Pocket und Piper als Attrappe */
function speechWith(settings: Settings, env: Record<string, string | undefined>, o: { pocket?: boolean; piper?: boolean } = {}) {
  const fetchCalls: string[] = [];
  const real = createTtsProviders(deps(env, async url => {
    fetchCalls.push(url);
    return new Response(new Uint8Array([1, 2]));
  }));
  const tts = real.map(p => (p.id === "pocket" ? fakeLocal("pocket", o.pocket ?? true) : p.id === "piper" ? fakeLocal("piper", o.piper ?? true) : p));
  const speech = createSpeech({ stt: [parakeet], tts, getSettings: () => settings, env: () => env, log: () => {}, readFile: async () => Buffer.alloc(0) });
  return { speech, fetchCalls };
}

describe("Schema und PATCH für speech.call", () => {
  test("tts, elevenlabsVoice und elevenlabsModel gültig; Unsinn abgelehnt", () => {
    expect(settingsSchema.safeParse({ speech: { call: { tts: "elevenlabs", elevenlabsVoice: CALL_ELEVENLABS_DEFAULT_VOICE, elevenlabsModel: "eleven_turbo_v2_5" } } }).success).toBe(true);
    for (const tts of ["auto", "pocket", "piper", "browser"]) expect(settingsSchema.safeParse({ speech: { call: { tts } } }).success).toBe(true);
    expect(settingsSchema.safeParse({ speech: { call: { tts: "gemini" } } }).success).toBe(false);
    expect(settingsSchema.safeParse({ speech: { call: { tts: "clone" } } }).success).toBe(false);
    expect(settingsSchema.safeParse({ speech: { call: { elevenlabsVoice: "-rm" } } }).success).toBe(false);
    expect(settingsSchema.safeParse({ speech: { call: { elevenlabsVoice: "a/b" } } }).success).toBe(false);
    expect(settingsSchema.safeParse({ speech: { call: { elevenlabsModel: "eleven_v9" } } }).success).toBe(false);
    // Der Schlüssel gehört nie in settings.json
    expect(settingsSchema.safeParse({ speech: { call: { elevenlabsKey: KEY } } }).success).toBe(true);
    expect((settingsSchema.parse({ speech: { call: { elevenlabsKey: KEY } } }) as any).speech.call.elevenlabsKey).toBeUndefined();
  });

  test("PATCH setzt und entfernt die neuen Felder, andere bleiben; ein Schlüsselfeld wird abgelehnt", () => {
    const current = { speech: { tts: "pocket", call: { model: "auto", claudeVia: "api" } } };
    const r = applySettingsPatch(current, { speech: { call: { tts: "elevenlabs", elevenlabsVoice: "abcDEF123", elevenlabsModel: "eleven_flash_v2_5" } } }, []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.speech).toEqual({ tts: "pocket", call: { model: "auto", claudeVia: "api", tts: "elevenlabs", elevenlabsVoice: "abcDEF123", elevenlabsModel: "eleven_flash_v2_5" } });
    const back = applySettingsPatch(r.value, { speech: { call: { tts: null, elevenlabsVoice: "" } } }, []);
    expect(back.ok && back.value.speech).toEqual({ tts: "pocket", call: { model: "auto", claudeVia: "api", elevenlabsModel: "eleven_flash_v2_5" } });
    const key = applySettingsPatch(current, { speech: { call: { elevenlabsKey: KEY } } }, []);
    expect(key.ok).toBe(false);
    if (!key.ok) expect(key.error).not.toContain(KEY);
  });
});

describe("callChoice: Stimme des Telefonhörers", () => {
  test("fehlend und auto wie vor #276: speech.tts pocket bzw. piper, sonst Browser; elevenlabs in speech.tts bleibt Browser", () => {
    const env = { ELEVENLABS_API_KEY: KEY, ELEVENLABS_VOICE_ID: "envvoice" };
    for (const call of [undefined, { tts: "auto" as const }]) {
      expect(speechWith({ speech: { tts: "pocket", ...(call ? { call } : {}) } }, env).speech.callChoice().tts?.id).toBe("pocket");
      expect(speechWith({ speech: { tts: "piper", ...(call ? { call } : {}) } }, env).speech.callChoice().tts?.id).toBe("piper");
      expect(speechWith({ speech: { tts: "elevenlabs", ...(call ? { call } : {}) } }, env).speech.callChoice().tts).toBeNull();
      expect(speechWith({ speech: { tts: "pocket", ...(call ? { call } : {}) } }, env, { pocket: false }).speech.callChoice().tts).toBeNull();
    }
    expect(speechWith({ speech: { tts: "pocket" } }, env).speech.callChoice().ttsSetting).toBe("auto");
  });

  test("fest pocket, piper oder browser, unabhängig von speech.tts", () => {
    expect(speechWith({ speech: { tts: "browser", call: { tts: "pocket" } } }, {}).speech.callChoice().tts?.id).toBe("pocket");
    expect(speechWith({ speech: { tts: "pocket", call: { tts: "piper" } } }, {}).speech.callChoice().tts?.id).toBe("piper");
    expect(speechWith({ speech: { tts: "pocket", call: { tts: "browser" } } }, {}).speech.callChoice().tts).toBeNull();
    const missing = speechWith({ speech: { call: { tts: "piper" } } }, {}, { piper: false }).speech.callChoice();
    expect(missing.tts).toBeNull();
    expect(missing.ttsReason).toContain("Piper ist nicht verfügbar");
  });

  test("elevenlabs mit Schlüssel: ElevenLabs, Pocket als Rückfall, Stimme und Modell aus speech.call bzw. Standard; ohne ELEVENLABS_VOICE_ID", () => {
    const c = speechWith({ speech: { tts: "browser", call: { tts: "elevenlabs" } } }, { ELEVENLABS_API_KEY: KEY }).speech.callChoice();
    expect(c.tts?.id).toBe("elevenlabs");
    expect(c.ttsFallback?.id).toBe("pocket");
    expect(c.ttsOptions).toEqual({ voice: CALL_ELEVENLABS_DEFAULT_VOICE, model: ELEVENLABS_DEFAULT_MODEL });
    const own = speechWith({ speech: { call: { tts: "elevenlabs", elevenlabsVoice: "eigeneStimme1", elevenlabsModel: "eleven_turbo_v2_5" } } }, { ELEVENLABS_API_KEY: KEY, ELEVENLABS_VOICE_ID: "envvoice" }).speech.callChoice();
    expect(own.ttsOptions).toEqual({ voice: "eigeneStimme1", model: "eleven_turbo_v2_5" });
    const noPocket = speechWith({ speech: { call: { tts: "elevenlabs" } } }, { ELEVENLABS_API_KEY: KEY }, { pocket: false }).speech.callChoice();
    expect(noPocket.tts?.id).toBe("elevenlabs");
    expect(noPocket.ttsFallback).toBeNull();
  });

  test("ohne Schlüssel ist elevenlabs nicht wählbar: Grund, es spricht Pocket bzw. der Browser", () => {
    const { speech, fetchCalls } = speechWith({ speech: { call: { tts: "elevenlabs" } } }, { ELEVENLABS_VOICE_ID: "envvoice" });
    const c = speech.callChoice();
    expect(c.tts?.id).toBe("pocket");
    expect(c.ttsReason).toContain("ELEVENLABS_API_KEY fehlt");
    const option = speech.callTtsOptions().find(o => o.id === "elevenlabs")!;
    expect(option).toEqual({ id: "elevenlabs", label: "ElevenLabs", available: false, reason: "ELEVENLABS_API_KEY fehlt" });
    const noPocket = speechWith({ speech: { call: { tts: "elevenlabs" } } }, {}, { pocket: false }).speech.callChoice();
    expect(noPocket.tts).toBeNull();
    expect(noPocket.ttsReason).toContain("der Browser");
    expect(fetchCalls).toHaveLength(0);
  });

  test("callTtsOptions nennt alle Stimmen mit Verfügbarkeit", () => {
    const opts = speechWith({}, { ELEVENLABS_API_KEY: KEY }, { piper: false }).speech.callTtsOptions();
    expect(opts.map(o => [o.id, o.available])).toEqual([
      ["auto", true],
      ["pocket", true],
      ["piper", false],
      ["elevenlabs", true],
      ["browser", true],
    ]);
    expect(opts.find(o => o.id === "piper")!.reason).toBe("nicht eingerichtet");
  });
});

describe("Telegram und Sprechmodus unverändert", () => {
  test("speech.call.tts elevenlabs ändert weder Telegram-Kette noch Sprechmodus; ELEVENLABS_VOICE_ID wirkt dort weiter", async () => {
    const urls: string[] = [];
    const env = { ELEVENLABS_API_KEY: KEY, ELEVENLABS_VOICE_ID: "envvoice", LOCAL_TTS: "false" };
    const tts = createTtsProviders(deps(env, async url => {
      urls.push(url);
      return new Response(new Uint8Array(2000), { headers: { "content-type": "audio/mpeg" } });
    }));
    const settings: Settings = { speech: { tts: "elevenlabs", call: { tts: "elevenlabs", elevenlabsVoice: "anrufStimme", elevenlabsModel: "eleven_turbo_v2_5" } } };
    const speech = createSpeech({ stt: [parakeet], tts, getSettings: () => settings, env: () => env, log: () => {}, readFile: async () => Buffer.alloc(0) });
    expect(await speech.synthesizeServer("Hallo.")).not.toBeNull();
    const out = await speech.synthesizeSpeech("Hallo.");
    expect(out.ok).toBe(true);
    expect(urls).toEqual(["https://api.elevenlabs.io/v1/text-to-speech/envvoice", "https://api.elevenlabs.io/v1/text-to-speech/envvoice"]);
    expect(speech.isVoiceEnabled()).toBe(true);
  });
});
