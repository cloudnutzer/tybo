/**
 * Sprach-Anbieter (Issue #248): Hören und Sprechen hinter SttProvider und
 * TtsProvider (./types.ts); vor dem Umbau stand das in transcribe.ts und
 * voice.ts.
 *
 * Hören: parakeet (sherpa-onnx, Issue #251, ./parakeet.ts), whisper-cpp,
 * elevenlabs, gemini.
 * Sprechen: browser (spricht nur im Browser), qwen3-mlx, elevenlabs, gemini,
 * pocket (Kyutai Pocket TTS als Kindprozess, Issue #252, ./pocket.ts) und
 * piper (eigener Prozess je Aufruf, Issue #252, ./piper.ts), clone (eigene
 * Stimme, Issue #253, ./clone.ts).
 *
 * Subprozesse (RunFn), fetch und Dateisystem kommen als Abhängigkeiten
 * herein. Kein Anbieter loggt selbst; Fehler werfen sie als SpeechError ohne
 * Inhalt, die Kette (./chain.ts) schreibt das Log.
 */

import { readFileSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { parakeetAvailability, parakeetPaths, selectPlatform, speechDir, transcribeWithSherpa, type StatFn } from "./parakeet";
import { capiLibrary, startParakeetWarm, type WarmSpawn } from "./parakeet-warm";
import { PIPER_ATTRIBUTION, PIPER_LABEL, piperAvailability, piperPaths, synthesizeWithPiper } from "./piper";
import {
  createPocketServer,
  POCKET_ATTRIBUTION,
  POCKET_DEFAULT_VOICE,
  POCKET_LABEL,
  POCKET_SAMPLE_RATE,
  pocketAvailability,
  pocketPaths,
  realPocketServerDeps,
  resolvePocketVoice,
  type PocketServer,
  type PocketServerDeps,
} from "./pocket";
import { ELEVENLABS_STREAM_RATE, elevenLabsVoiceName, streamElevenLabs } from "./elevenlabs";
import { pcmToWav } from "./pcm";
import { openScribeStream, type ScribeConnect } from "./scribe";
import { SpeechError, VOICE_PATTERN, type SttProvider, type TtsProvider } from "./types";
import type { RunFn } from "./process";
import type { CloneSelection, CloneTts } from "./clone";

export interface ProviderDeps {
  env: () => Record<string, string | undefined>;
  run: RunFn;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  exists: (path: string) => boolean;
  /** Programm im PATH (Bun.which); null, wenn es fehlt */
  which: (cmd: string) => string | null;
  readFile: (path: string) => Promise<Buffer>;
  writeFile: (path: string, data: Buffer) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  cwd: () => string;
  /** Verzeichnis für die Dateien von Qwen3-TTS (bisher /tmp) */
  tmpDir: string;
  /** Eindeutiger Teil für Temp-Dateinamen */
  unique: () => string;
  /**
   * Für Parakeet (Issue #251): Plattform, Größe und Änderungszeit einer
   * Datei (null: fehlt) und Text einer Datei (null: fehlt). Fehlen sie,
   * gelten process.platform, process.arch und das echte Dateisystem.
   */
  platform?: string;
  arch?: string;
  stat?: StatFn;
  readText?: (path: string) => string | null;
  /** Für Pocket TTS (Issue #252): Prozess, Ports und Uhr; fehlt: echte */
  pocket?: PocketServerDeps;
  /** Wird mit dem Pocket-Prozess aufgerufen, damit der Bot ihn beim Ende beenden kann */
  onPocketServer?: (server: PocketServer) => void;
  /** Eigene Stimme (Issue #253): gewählte Stimme und Engine aus speech.cloneVoice und speech.cloneEngine */
  cloneSelection?: () => CloneSelection;
  /** Erkennungsprozess für Parakeet im Dauerbetrieb (Issue #257); fehlt: Bun.spawn */
  warmSpawn?: WarmSpawn;
  /** Realtime-Verbindung zu ElevenLabs Scribe im Telefonhörer (Issue #279); fehlt: Bun-WebSocket */
  connectWebSocket?: ScribeConnect;
}

const MAX_TTS_CHARS = 4500;
const WHISPER_TIMEOUT_MS = 60_000;
const LOCAL_TTS_TIMEOUT_MS = 180_000;
const FFMPEG_TIMEOUT_MS = 30_000;

const MIME_EXT: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/webm": "webm",
};

/** Dateiendung zum MIME-Typ, bereinigt (nur a-z und 0-9, ohne Parameter), Standard ogg */
export function extForMime(mime: string): string {
  const base = mime.split(";")[0].trim().toLowerCase();
  if (MIME_EXT[base]) return MIME_EXT[base];
  const sub = (base.split("/")[1] ?? "").replace(/[^a-z0-9]/g, "").slice(0, 10);
  return sub || "ogg";
}

function truncate(text: string): string {
  return text.length > MAX_TTS_CHARS ? text.substring(0, MAX_TTS_CHARS) + "..." : text;
}

/**
 * Sprache für Qwen3-TTS in mlx-audio (Issue #252): das Modell kennt nur
 * ausgeschriebene Namen (german, english, ...). Ein Kürzel wie de fiel dort
 * still auf automatische Erkennung zurück. Kürzel und Namen werden auf den
 * Namen abgebildet, Unbekanntes auf auto (wie bisher im Ergebnis, aber
 * ausdrücklich).
 */
const QWEN_LANGUAGES: Record<string, string> = {
  zh: "chinese",
  en: "english",
  ja: "japanese",
  ko: "korean",
  de: "german",
  fr: "french",
  ru: "russian",
  pt: "portuguese",
  es: "spanish",
  it: "italian",
};

export function qwenLanguage(value: string | undefined): string {
  const v = (value ?? "").trim().toLowerCase();
  if (!v || v === "auto") return "auto";
  if (QWEN_LANGUAGES[v]) return QWEN_LANGUAGES[v];
  return Object.values(QWEN_LANGUAGES).includes(v) ? v : "auto";
}

/** JSON einer Antwort; kaputtes JSON ist eine unerwartete Antwort, nie mit Inhalt im Fehler */
async function jsonOf(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    throw new SpeechError("format");
  }
}

/** Gemini: Hören mit dem Flash-Modell, Sprechen mit dem TTS-Vorschaumodell */
const GEMINI_STT_MODEL = "gemini-2.0-flash";
const GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";
const GEMINI_STT_PROMPT = "Transcribe this audio message accurately. Only output the transcription, nothing else.";
/** Gemini spricht rohes PCM16 mono mit 24 kHz, ohne Dateikopf */
const GEMINI_TTS_RATE = 24_000;

/**
 * Ein generateContent-Aufruf an Gemini; der Schlüssel steht in der Adresse.
 * Ein Abbruchsignal kommt nur in die Anfrage, wenn es eines gibt.
 */
async function askGemini(fetchFn: ProviderDeps["fetch"], key: string, model: string, request: object, signal?: AbortSignal): Promise<any> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const init: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) };
  if (signal) init.signal = signal;
  const reply = await fetchFn(url, init);
  if (!reply.ok) throw new SpeechError("http", reply.status);
  return jsonOf(reply);
}

/** Erster Teil des ersten Kandidaten einer Gemini-Antwort */
function firstGeminiPart(reply: any): any {
  return reply?.candidates?.[0]?.content?.parts?.[0];
}

function statOrNull(path: string) {
  try {
    const s = statSync(path);
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
  } catch {
    return null;
  }
}

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function createSttProviders(d: ProviderDeps): SttProvider[] {
  const whisperCli = () => d.env().WHISPER_CLI_PATH || "whisper-cli";
  const whisperModel = () => d.env().WHISPER_MODEL_PATH || join(d.cwd(), "models", "ggml-medium.bin");
  const elevenKey = () => d.env().ELEVENLABS_API_KEY || "";
  const geminiKey = () => d.env().GEMINI_API_KEY || "";

  // Parakeet über sherpa-onnx unter models/speech (Issue #251): verfügbar nur mit passendem Nachweis der Einrichtung
  const platform = () => d.platform ?? process.platform;
  const arch = () => d.arch ?? process.arch;
  const parakeet: SttProvider = {
    id: "parakeet",
    label: "Parakeet",
    local: true,
    available: () => parakeetAvailability(speechDir(d.cwd()), platform(), arch(), d.stat ?? statOrNull, d.readText ?? readTextOrNull),
    transcribe: async (audio, mime, opts) => {
      const sel = selectPlatform(platform(), arch());
      if (!sel.ok) throw new SpeechError("unavailable");
      return transcribeWithSherpa(
        audio,
        {
          paths: parakeetPaths(speechDir(d.cwd()), sel.key),
          key: sel.key,
          tmpDir: join(d.cwd(), "uploads"),
          unique: `${Date.now()}_${d.unique()}`,
          ext: extForMime(mime),
          threads: Math.min(4, Math.max(1, availableParallelism())),
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
        d,
        d.exists,
      );
    },
    // Dauerbetrieb (Issue #257): eingerichtet und die C-API-Bibliothek liegt im Laufzeitpaket
    canWarm: () => {
      const sel = selectPlatform(platform(), arch());
      if (!sel.ok || !parakeet.available().ok) return false;
      return d.exists(capiLibrary(parakeetPaths(speechDir(d.cwd()), sel.key), sel.key));
    },
    warm: async () => {
      const sel = selectPlatform(platform(), arch());
      if (!sel.ok || !parakeet.canWarm!()) throw new SpeechError("unavailable");
      return startParakeetWarm({
        paths: parakeetPaths(speechDir(d.cwd()), sel.key),
        key: sel.key,
        threads: Math.min(4, Math.max(1, availableParallelism())),
        env: d.env(),
        ...(d.warmSpawn ? { spawn: d.warmSpawn } : {}),
      });
    },
  };

  const whisper: SttProvider = {
    id: "whisper-cpp",
    label: "whisper.cpp",
    local: true,
    available: () => {
      if (!d.exists(whisperModel())) return { ok: false, reason: "Modelldatei fehlt" };
      if (!d.which(whisperCli())) return { ok: false, reason: "Programm whisper-cli nicht gefunden" };
      return { ok: true };
    },
    // whisper.cpp braucht eine Datei: Temp-Datei unter uploads/, immer gelöscht
    transcribe: async (audio, mime, opts) => {
      const dir = join(d.cwd(), "uploads");
      const tmpPath = join(dir, `whisper_tmp_${Date.now()}_${d.unique()}.${extForMime(mime)}`);
      try {
        await d.mkdir(dir);
        await d.writeFile(tmpPath, audio);
        const res = await d.run(
          [whisperCli(), "--model", whisperModel(), "--language", opts.language ?? "auto", "--no-timestamps", "--no-prints", "--file", tmpPath],
          { timeoutMs: WHISPER_TIMEOUT_MS, ...(opts.signal ? { signal: opts.signal } : {}) }
        );
        if (res.timedOut || opts.signal?.aborted) throw new SpeechError("timeout");
        if (res.exitCode !== 0) throw new SpeechError("exit", res.exitCode ?? undefined);
        const text = res.stdout.trim();
        if (!text) throw new SpeechError("empty");
        return text;
      } finally {
        await d.unlink(tmpPath).catch(() => {});
      }
    },
  };

  const elevenlabs: SttProvider = {
    id: "elevenlabs",
    label: "ElevenLabs",
    local: false,
    available: () => (elevenKey() ? { ok: true } : { ok: false, reason: "ELEVENLABS_API_KEY fehlt" }),
    transcribe: async (audio, mime, opts) => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `audio.${extForMime(mime)}`);
      form.append("model_id", "scribe_v1");
      const res = await d.fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": elevenKey() },
        body: form,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (!res.ok) throw new SpeechError("http", res.status);
      const result = await jsonOf(res);
      const text = typeof result?.text === "string" ? result.text.trim() : "";
      if (!text) throw new SpeechError("empty");
      return text;
    },
    // Telefonhörer (Issue #279, ./scribe.ts): Realtime-Verbindung je Gespräch mit Sprache; transcribe oben bleibt wie bisher
    openCallStream: opts =>
      openScribeStream({
        key: elevenKey(),
        ...(opts.language ? { language: opts.language } : {}),
        ...(d.connectWebSocket ? { connect: d.connectWebSocket } : {}),
      }),
  };

  const gemini: SttProvider = {
    id: "gemini",
    label: "Gemini",
    local: false,
    available: () => (geminiKey() ? { ok: true } : { ok: false, reason: "GEMINI_API_KEY fehlt" }),
    transcribe: async (audio, mime, opts) => {
      const inline_data = { mime_type: mime, data: audio.toString("base64") };
      const reply = await askGemini(d.fetch, geminiKey(), GEMINI_STT_MODEL, { contents: [{ parts: [{ text: GEMINI_STT_PROMPT }, { inline_data }] }] }, opts.signal);
      const text = firstGeminiPart(reply)?.text;
      if (typeof text !== "string" || !text.trim()) throw new SpeechError("empty");
      return text;
    },
  };

  return [parakeet, whisper, elevenlabs, gemini];
}

/** clone: Anbieter der eigenen Stimme (./clone.ts); fehlt er, gibt es keine eigene Stimme */
export function createTtsProviders(d: ProviderDeps, clone?: CloneTts): TtsProvider[] {
  // Qwen3-TTS auf Apple Silicon (mlx-audio im eigenen venv), abschaltbar mit LOCAL_TTS=false
  const qwenPython = () => d.env().LOCAL_TTS_PYTHON || `${d.env().HOME}/.venvs/qwen3-tts/bin/python`;
  const qwenModel = () => d.env().LOCAL_TTS_MODEL || "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit";
  // Stimmen: serena, vivian, uncle_fu, ryan, aiden, ono_anna, sohee, eric, dylan
  const qwenVoice = () => d.env().LOCAL_TTS_VOICE || "vivian";
  const qwenLang = () => d.env().LOCAL_TTS_LANG || "de";
  const elevenKey = () => d.env().ELEVENLABS_API_KEY || "";
  const elevenVoice = () => d.env().ELEVENLABS_VOICE_ID || "";
  /** Namen der Stimmen aus warm (Issue #276), nur für die Anzeige */
  const elevenNames = new Map<string, string>();
  const geminiKey = () => d.env().GEMINI_API_KEY || "";
  const geminiVoice = () => d.env().GEMINI_TTS_VOICE || "Kore";

  const browser: TtsProvider = {
    id: "browser",
    label: "Browser-Stimme",
    local: true,
    where: "browser",
    available: () => ({ ok: true }),
    // Spricht im Browser (#249/#250), nie auf dem Server
    synthesize: async () => {
      throw new SpeechError("unavailable");
    },
  };

  const qwen: TtsProvider = {
    id: "qwen3-mlx",
    label: "Qwen3-TTS",
    local: true,
    where: "server",
    available: () => {
      if (d.env().LOCAL_TTS === "false") return { ok: false, reason: "mit LOCAL_TTS=false abgeschaltet" };
      if (!d.exists(qwenPython())) return { ok: false, reason: "Python-Umgebung für Qwen3-TTS fehlt" };
      return { ok: true };
    },
    // WAV per Subprozess, dann Ogg/Opus (Telegram-Sprachformat) per ffmpeg; ohne ffmpeg das WAV
    synthesize: async (text, opts) => {
      const prefix = `tybo_tts_${Date.now()}_${d.unique()}`;
      const wavPath = join(d.tmpDir, `${prefix}_000.wav`);
      const oggPath = join(d.tmpDir, `${prefix}.ogg`);
      try {
        const gen = await d.run(
          [
            qwenPython(), "-m", "mlx_audio.tts.generate",
            "--model", qwenModel(),
            "--voice", opts.voice ?? qwenVoice(),
            "--lang_code", qwenLanguage(opts.language ?? qwenLang()),
            "--text", truncate(text),
            "--file_prefix", prefix,
          ],
          { cwd: d.tmpDir, timeoutMs: LOCAL_TTS_TIMEOUT_MS }
        );
        if (gen.timedOut) throw new SpeechError("timeout");
        if (gen.exitCode !== 0) throw new SpeechError("exit", gen.exitCode ?? undefined);
        if (!d.exists(wavPath)) throw new SpeechError("empty");

        let ogg = false;
        try {
          const ff = await d.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", wavPath, "-c:a", "libopus", "-b:a", "48k", oggPath],
            { timeoutMs: FFMPEG_TIMEOUT_MS }
          );
          ogg = !ff.timedOut && ff.exitCode === 0 && d.exists(oggPath);
        } catch {
          // ffmpeg fehlt: WAV tut es auch
        }
        const audio = await d.readFile(ogg ? oggPath : wavPath);
        if (audio.length <= 1000) throw new SpeechError("empty");
        return { audio, mime: ogg ? "audio/ogg" : "audio/wav" };
      } finally {
        for (const p of [wavPath, oggPath]) await d.unlink(p).catch(() => {});
      }
    },
  };

  const elevenlabs: TtsProvider = {
    id: "elevenlabs",
    label: "ElevenLabs",
    local: false,
    where: "server",
    available: () => {
      if (!elevenKey()) return { ok: false, reason: "ELEVENLABS_API_KEY fehlt" };
      if (!elevenVoice()) return { ok: false, reason: "ELEVENLABS_VOICE_ID fehlt" };
      return { ok: true };
    },
    synthesize: async (text, opts) => {
      const res = await d.fetch(`https://api.elevenlabs.io/v1/text-to-speech/${opts.voice ?? elevenVoice()}`, {
        method: "POST",
        headers: { "xi-api-key": elevenKey(), "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({
          text: truncate(text),
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      });
      if (!res.ok) throw new SpeechError("http", res.status);
      return { audio: Buffer.from(await res.arrayBuffer()), mime: "audio/mpeg" };
    },
    // Telefonhörer (Issue #276, ./elevenlabs.ts): gestreamt, Stimme und Modell je Aufruf, nur der Schlüssel ist Pflicht
    streamAvailable: () => (elevenKey() ? { ok: true } : { ok: false, reason: "ELEVENLABS_API_KEY fehlt" }),
    streamSampleRate: ELEVENLABS_STREAM_RATE,
    synthesizeStream: (text, opts) => {
      const voice = opts.voice ?? elevenVoice();
      if (!elevenKey() || !voice) throw new SpeechError("unavailable");
      return streamElevenLabs(d.fetch, text, {
        key: elevenKey(),
        voice,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.language ? { language: opts.language } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    },
    // Vorwärmen: Verbindung öffnen und den Namen der Stimme holen; scheitert still
    warm: async opts => {
      const voice = opts?.voice ?? elevenVoice();
      if (!elevenKey() || !voice) throw new SpeechError("unavailable");
      const name = await elevenLabsVoiceName(d.fetch, elevenKey(), voice, opts?.signal);
      if (name) elevenNames.set(voice, name);
    },
    voiceName: voice => (VOICE_PATTERN.test(voice) ? (elevenNames.get(voice) ?? null) : null),
  };

  const gemini: TtsProvider = {
    id: "gemini",
    label: "Gemini",
    local: false,
    where: "server",
    available: () => (geminiKey() ? { ok: true } : { ok: false, reason: "GEMINI_API_KEY fehlt" }),
    // Ohne Abbruchsignal wie bisher: eine Ansage läuft zu Ende
    synthesize: async (text, opts) => {
      const voiceName = opts.voice ?? geminiVoice();
      const reply = await askGemini(d.fetch, geminiKey(), GEMINI_TTS_MODEL, {
        contents: [{ parts: [{ text: truncate(text) }] }],
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } },
      });
      const base64 = firstGeminiPart(reply)?.inlineData?.data;
      if (typeof base64 !== "string" || !base64) throw new SpeechError("format");
      return { audio: pcmToWav(Buffer.from(base64, "base64"), GEMINI_TTS_RATE), mime: "audio/wav" };
    },
  };

  // Pocket TTS (Issue #252): Kindprozess erst beim ersten Vorlesen, Ende nach Leerlauf
  const readText = d.readText ?? readTextOrNull;
  const pocketVoice = () => d.env().POCKET_TTS_VOICE || POCKET_DEFAULT_VOICE;
  const pPaths = () => pocketPaths(speechDir(d.cwd()));
  let pocketServer: PocketServer | null = null;
  const server = () => {
    if (!pocketServer) {
      pocketServer = createPocketServer({ paths: pPaths(), env: d.env, deps: d.pocket ?? realPocketServerDeps });
      d.onPocketServer?.(pocketServer);
    }
    return pocketServer;
  };
  const pocket: TtsProvider = {
    id: "pocket",
    label: POCKET_LABEL,
    local: true,
    where: "server",
    note: POCKET_ATTRIBUTION,
    available: () => pocketAvailability(pPaths(), d.exists, readText, pocketVoice()),
    voiceAllowed: voice => resolvePocketVoice(voice) !== null,
    voiceName: voice => resolvePocketVoice(voice)?.label ?? null,
    synthesize: async (text, opts) => {
      const voice = opts.voice ?? pocketVoice();
      if (!resolvePocketVoice(voice)) throw new SpeechError("unavailable");
      const audio = await server().synthesize(truncate(text), voice, opts.signal);
      return { audio, mime: "audio/wav" };
    },
    // Telefonhörer (Issue #257): Stücke, sobald Pocket sie erzeugt, und Vorwärmen beim Start
    streamSampleRate: POCKET_SAMPLE_RATE,
    synthesizeStream: (text, opts) => {
      const voice = opts.voice ?? pocketVoice();
      if (!resolvePocketVoice(voice)) throw new SpeechError("unavailable");
      return server().synthesizeStream(truncate(text), voice, opts.signal);
    },
    warm: async opts => {
      const voice = opts?.voice ?? pocketVoice();
      if (!resolvePocketVoice(voice)) throw new SpeechError("unavailable");
      await server().warmUp(voice, opts?.signal);
    },
  };

  // Piper (Issue #252): eigener Prozess je Aufruf, Stimme de_DE-thorsten-medium
  const iPaths = () => piperPaths(speechDir(d.cwd()));
  const piper: TtsProvider = {
    id: "piper",
    label: PIPER_LABEL,
    local: true,
    where: "server",
    note: PIPER_ATTRIBUTION,
    available: () => piperAvailability(iPaths(), d.exists, readText),
    // Eine Stimme je Einrichtung: andere Namen gibt es hier nicht
    voiceAllowed: () => false,
    synthesize: async (text, opts) => {
      if (opts.voice !== undefined) throw new SpeechError("unavailable");
      const audio = await synthesizeWithPiper(truncate(text), iPaths(), { tmpDir: d.tmpDir, unique: `${Date.now()}_${d.unique()}`, ...(opts.signal ? { signal: opts.signal } : {}) }, d);
      return { audio, mime: "audio/wav" };
    },
  };

  return clone ? [browser, qwen, elevenlabs, gemini, pocket, piper, clone.provider] : [browser, qwen, elevenlabs, gemini, pocket, piper];
}
