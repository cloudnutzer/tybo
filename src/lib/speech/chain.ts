/**
 * Auswahl und Weiterschalten der Sprach-Anbieter (Issue #248).
 *
 * Wahl aus config/settings.json (Abschnitt speech), sonst SPEECH_STT bzw.
 * SPEECH_TTS aus .env, sonst auto. Ein ungültiger Wert in der Umgebung
 * ergibt eine Log-Zeile mit dem Variablennamen (nie dem Wert), dann gilt auto.
 *
 * Hören:
 * - auto: Kandidaten in der Reihenfolge von STT_IDS, nicht verfügbare werden
 *   übersprungen; wirft ein Anbieter oder liefert er leeren Text, kommt der
 *   nächste dran.
 * - fest gewählt: nur dieser Anbieter. Nicht verfügbar ergibt
 *   "[Voice transcription unavailable - <id> not available]", Fehler oder
 *   leer "[Transcription failed]".
 * - kein Anbieter verfügbar: der alte Platzhalter je Zugang (Datei bzw.
 *   Puffer); alle verfügbaren gescheitert: "[Transcription failed]".
 *   Transkribieren wirft nie.
 *
 * Sprechen für Telegram (textToSpeech): auto, browser oder nichts ergibt
 * die Server-Kette qwen3-mlx, elevenlabs, gemini; ein fest gewählter
 * Server-Anbieter nur diesen. Ergebnis Buffer oder null. Die eigene Stimme
 * (clone, Issue #253) spricht nie in Telegram: bei tts = clone gilt
 * speech.telegramTts (die Wahl von vor „Verwenden"), ohne sie SPEECH_TTS
 * bzw. auto.
 *
 * Sprechen im Sprechmodus: auto ergibt browser (Status in localMode).
 *
 * Sprechmodus (Issue #249): recognize() ist der strenge Weg fürs Hören. Er
 * liefert nie einen Platzhaltertext, sondern ein Ergebnis mit Grund
 * (unavailable, empty, failed, timeout), und das Zeitlimit gilt für die ganze
 * Erkennung über alle Anbieter; danach bricht ein Signal die laufende Arbeit
 * ab. empty heißt: ein Anbieter hat gearbeitet und nichts gehört (leerer
 * Text), kein technischer Fehler. Die Platzhalter von transcribe (Telegram)
 * bleiben davon unberührt.
 *
 * synthesizeSpeech() ist der strenge Weg fürs Sprechen im Sprechmodus: nur
 * der gewählte serverseitige Anbieter, nie die Telegram-Kette. auto und
 * browser heißen dort „der Browser spricht" (Grund browser). Das Ergebnis
 * trägt den MIME-Typ (WAV, Ogg oder MP3); WAV bekommt den Hinweis
 * „KI-generiert" im LIST/INFO-Block (./wav.ts), die eigene Stimme dazu
 * „geklonte Stimme" (sie liefert nur WAV).
 *
 * Telefonhörer (Issue #257, Entscheidung 0024): callChoice() wählt fürs
 * Hören nach speech.call.stt (Issue #279). auto (oder fehlend) wie vor #279:
 * die feste Wahl aus speech.stt (samt SPEECH_STT), wenn sie lokal ist
 * (Parakeet, whisper.cpp), bei auto der erste verfügbare davon; steht
 * speech.stt auf einem Cloud-Erkenner, ist der Telefonhörer nicht bereit.
 * parakeet bzw. whisper-cpp fest, unabhängig von speech.stt; fehlt er, ist
 * der Telefonhörer nicht bereit (kein Ausweichen auf den anderen).
 * elevenlabs ist die einzige Cloud-Erkennung (gezielte Ausnahme von
 * Entscheidung 0024, siehe dort): mit ELEVENLABS_API_KEY erkennt ElevenLabs
 * Scribe (scribe_v2, ./scribe.ts), Parakeet ist der Rückfall je Äußerung,
 * wenn eingerichtet. Ohne Schlüssel erkennt gleich der erste lokale
 * Erkenner (Parakeet, whisper.cpp), der Grund steht in sttNote; ohne
 * lokalen ist der Telefonhörer nicht bereit.
 * Sprechen nach speech.call.tts (Issue #276): auto (oder fehlend) wie vor
 * #276, also Pocket TTS oder Piper, wenn speech.tts so steht und verfügbar
 * ist, sonst die Browser-Stimme; pocket bzw. piper fest, wenn verfügbar,
 * sonst der Browser; browser immer der Browser. elevenlabs ist die einzige
 * Cloud-Stimme (gezielte Ausnahme von Entscheidung 0024, siehe dort): mit
 * ELEVENLABS_API_KEY spricht ElevenLabs gestreamt mit Stimme und Modell aus
 * speech.call, Pocket TTS ist der Rückfall je Abschnitt (fehlt es, der
 * Browser). Ohne Schlüssel spricht gleich Pocket TTS bzw. der Browser, der
 * Grund steht in ttsReason. ELEVENLABS_VOICE_ID gilt hier nicht (Telegram
 * und Sprechmodus behalten sie). Nie die eigene Stimme (Entscheidung 0023:
 * Telefonate übernehmen sie nicht), nie Qwen3-TTS (Prozess je Aufruf,
 * mehrere Sekunden), nie Gemini.
 *
 * Log je Aufruf: Anbieter, Dauer, Ergebnis. Nie Transkript, Text, stderr
 * oder Antworttexte der Anbieter.
 */

import type { Settings } from "../settings";
import { ELEVENLABS_DEFAULT_MODEL } from "./elevenlabs";
import {
  CALL_ELEVENLABS_DEFAULT_VOICE,
  isSttChoice,
  isTtsChoice,
  SPEECH_LANGUAGES,
  STT_IDS,
  type CallSttChoice,
  type CallTtsChoice,
  type SttChoice,
  type TelegramTtsChoice,
  type TtsChoice,
  type TtsId,
} from "./ids";
import { describeSpeechError, SpeechError, VOICE_PATTERN, type SttProvider, type TtsProvider } from "./types";
import { tagWavAiGenerated } from "./wav";

export type SpeechSource = "settings" | "env" | "code";

export interface SourcedValue<T> {
  value: T;
  source: SpeechSource;
}

export interface SpeechChoice {
  stt: SourcedValue<SttChoice>;
  tts: SourcedValue<TtsChoice>;
  language: SourcedValue<string>;
}

/** Telefonhörer (Issue #257): erlaubte Anbieter, in dieser Reihenfolge bei auto */
export const CALL_STT_IDS: readonly string[] = ["parakeet", "whisper-cpp"];
export const CALL_TTS_IDS: readonly string[] = ["pocket", "piper"];

/** Anbieter des Telefonhörers; tts null heißt Browser-Stimme */
export interface CallSpeechChoice {
  stt: SttProvider | null;
  /** Warum kein Erkenner (deutsch, ohne Werte) */
  sttReason?: string;
  /** Eingestellter Erkenner (speech.call.stt, fehlt: auto), Issue #279 */
  sttSetting: CallSttChoice;
  /** Warum der eingestellte Erkenner nicht erkennt, obwohl ein anderer es tut (deutsch, ohne Werte) */
  sttNote?: string;
  /** Rückfall je Äußerung, nur bei ElevenLabs Scribe: Parakeet, wenn verfügbar */
  sttFallback?: SttProvider | null;
  tts: TtsProvider | null;
  /** Eingestellte Stimme (speech.call.tts, fehlt: auto), Issue #276 */
  ttsSetting: CallTtsChoice;
  /** Warum die eingestellte Stimme nicht spricht (deutsch, ohne Werte) */
  ttsReason?: string;
  /** Rückfall je Abschnitt, nur bei ElevenLabs: Pocket TTS, wenn verfügbar */
  ttsFallback?: TtsProvider | null;
  /** Stimme und Modell je Aufruf, nur bei ElevenLabs */
  ttsOptions?: { voice: string; model: string };
}

/** Name von ElevenLabs Scribe im Telefonhörer (Hinweise, Auswahl) */
export const CALL_SCRIBE_LABEL = "ElevenLabs Scribe";

/** Ein Erkenner zur Auswahl im Reiter „Sprechen“ (Issue #279) */
export interface CallSttOption {
  id: CallSttChoice;
  label: string;
  available: boolean;
  reason?: string;
}

/** Eine Stimme zur Auswahl im Reiter „Sprechen“ (Issue #276) */
export interface CallTtsOption {
  id: CallTtsChoice;
  label: string;
  available: boolean;
  reason?: string;
}

/** Server-Stimmen für Telegram in der Reihenfolge wie vor Issue #248 */
export const SERVER_TTS_CHAIN: readonly TtsId[] = ["qwen3-mlx", "elevenlabs", "gemini"];

export const TRANSCRIPTION_TEXT = {
  noneFile: "[Voice transcription unavailable - no transcription provider configured]",
  noneBuffer: "[Voice transcription unavailable - no provider configured]",
  failed: "[Transcription failed]",
  fixedUnavailable: (id: string) => `[Voice transcription unavailable - ${id} not available]`,
} as const;

/** Anzeigenamen von getTranscriptionProvider() wie vor Issue #248 (Startlog) */
const TRANSCRIPTION_LABELS: Record<string, string> = {
  parakeet: "Parakeet (local)",
  "whisper-cpp": "whisper.cpp (local)",
  elevenlabs: "ElevenLabs",
  gemini: "Gemini",
};

export interface SttOption {
  id: string;
  label: string;
  local: boolean;
  available: boolean;
  reason?: string;
}

export interface TtsOption extends SttOption {
  where: "server" | "browser";
  /** Namensnennung bzw. Lizenzhinweis (Pocket TTS, Piper) */
  note?: string;
}

/** Anbieterlisten für die Einstellungsseite (SettingsPort.speechOptions) */
export interface SpeechOptions {
  stt: SttOption[];
  tts: TtsOption[];
  languages: string[];
}

/** Status des Sprechmodus ohne Abo für GET /api/voice (modes.local) */
export interface LocalModeStatus {
  ready: boolean;
  reason?: string;
  stt: { id: string; label: string; local: boolean; available: boolean } | null;
  tts: { id: string; label: string; where: "server" | "browser"; available: boolean };
}

/** Ergebnis von recognize(): Text oder der Grund, nie ein Platzhaltertext */
export type RecognizeResult =
  | { ok: true; text: string; provider: string }
  /** empty: ein Anbieter lieferte leeren Text (nichts gehört), keiner einen Text */
  | { ok: false; reason: "unavailable" | "empty" | "failed" | "timeout" };

/** MIME-Typen, die synthesizeSpeech() liefert */
export type SpeechAudioMime = "audio/wav" | "audio/ogg" | "audio/mpeg";

/** Ergebnis von synthesizeSpeech(): Audio mit Typ oder der Grund */
export type SynthesizeResult =
  | { ok: true; audio: Buffer; mime: SpeechAudioMime; provider: string }
  /** browser: gewählt ist die Browser-Stimme (auch bei auto); voice: ungültige Stimme */
  | { ok: false; reason: "browser" | "unavailable" | "failed" | "voice" };

const AUDIO_MIME: Record<string, SpeechAudioMime> = {
  "audio/wav": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/ogg": "audio/ogg",
  "audio/mpeg": "audio/mpeg",
  "audio/mp3": "audio/mpeg",
};

export interface SpeechDeps {
  stt: readonly SttProvider[];
  tts: readonly TtsProvider[];
  getSettings: () => Settings;
  env: () => Record<string, string | undefined>;
  log: (line: string) => void;
  /** Für transcribeFile; wirft bei Lesefehlern */
  readFile: (path: string) => Promise<Buffer>;
  now?: () => number;
}

/** Bekannte Endungen des Dateiwegs und ihr MIME-Typ (wie vor Issue #248) */
const AUDIO_TYPE_BY_EXT = new Map<string, string>([
  ["ogg", "audio/ogg"],
  ["mp3", "audio/mpeg"],
  ["wav", "audio/wav"],
  ["m4a", "audio/mp4"],
  ["webm", "audio/webm"],
]);

/** MIME aus dem Teil nach dem letzten Punkt, ohne Rücksicht auf Großschreibung; Unbekanntes gilt als Ogg */
export function mimeForFile(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return AUDIO_TYPE_BY_EXT.get(ext) ?? "audio/ogg";
}

export type Speech = ReturnType<typeof createSpeech>;

export function createSpeech(deps: SpeechDeps) {
  const now = deps.now ?? (() => Date.now());
  const warned = new Map<string, string>();

  /** SPEECH_STT/SPEECH_TTS; ungültig: einmal je Wert loggen (nur der Name), dann auto */
  function envChoice<T>(name: string, check: (v: unknown) => v is T): T | undefined {
    const raw = deps.env()[name]?.trim().toLowerCase();
    if (!raw) return undefined;
    if (check(raw)) return raw;
    if (warned.get(name) !== raw) {
      warned.set(name, raw);
      deps.log(`[Sprache] ${name} ungültig, es gilt auto`);
    }
    return undefined;
  }

  /** Wirksame Wahl für einen Stand der Einstellungen (Standard: aktuelle Datei) */
  function choice(settings: Settings = deps.getSettings()): SpeechChoice {
    const own = settings.speech ?? {};
    const pick = <T extends string>(fileValue: T | undefined, envValue: T | undefined, fallback: T): SourcedValue<T> =>
      fileValue !== undefined
        ? { value: fileValue, source: "settings" }
        : envValue !== undefined
          ? { value: envValue, source: "env" }
          : { value: fallback, source: "code" };
    return {
      stt: pick<SttChoice>(own.stt, envChoice("SPEECH_STT", isSttChoice), "auto"),
      tts: pick<TtsChoice>(own.tts, envChoice("SPEECH_TTS", isTtsChoice), "auto"),
      language: pick<string>(own.language, undefined, "auto"),
    };
  }

  /** Wahl für Telegram: wie tts, bei clone die gemerkte Wahl (telegramTts), sonst SPEECH_TTS bzw. auto */
  function telegramTts(settings: Settings = deps.getSettings()): TelegramTtsChoice {
    const c = choice(settings);
    if (c.tts.value !== "clone") return c.tts.value;
    const kept = settings.speech?.telegramTts;
    if (kept !== undefined) return kept;
    const env = envChoice("SPEECH_TTS", isTtsChoice);
    return env !== undefined && env !== "clone" ? env : "auto";
  }

  const sttById = (id: string) => deps.stt.find(p => p.id === id);
  const ttsById = (id: string) => deps.tts.find(p => p.id === id);
  const sttInOrder = () => STT_IDS.map(sttById).filter((p): p is SttProvider => !!p);

  function languageOpt(c: SpeechChoice) {
    return c.language.value === "auto" ? {} : { language: c.language.value };
  }

  async function timed<T>(what: string, run: () => Promise<T>): Promise<T> {
    const start = now();
    try {
      const result = await run();
      deps.log(`[Sprache] ${what}: ok, ${now() - start} ms`);
      return result;
    } catch (e) {
      deps.log(`[Sprache] ${what}: Fehler (${describeSpeechError(e)}), ${now() - start} ms`);
      throw e;
    }
  }

  async function runStt(p: SttProvider, audio: Buffer, mime: string, c: SpeechChoice, signal?: AbortSignal): Promise<string> {
    return timed(`Hören ${p.id}`, async () => {
      const text = await p.transcribe(audio, mime, { ...languageOpt(c), ...(signal ? { signal } : {}) });
      if (typeof text !== "string" || !text.trim()) throw new SpeechError("empty");
      return text;
    });
  }

  /** Transkribiert einen Puffer; wirft nie. none: Platzhalter, wenn gar kein Anbieter verfügbar ist */
  async function transcribe(audio: Buffer, mime: string, none: string): Promise<string> {
    const c = choice();
    if (c.stt.value !== "auto") {
      const p = sttById(c.stt.value);
      const avail = p?.available() ?? { ok: false, reason: "unbekannt" };
      if (!p || !avail.ok) {
        deps.log(`[Sprache] Hören ${c.stt.value} nicht verfügbar: ${avail.reason ?? "ohne Grund"}`);
        return TRANSCRIPTION_TEXT.fixedUnavailable(c.stt.value);
      }
      try {
        return await runStt(p, audio, mime, c);
      } catch {
        return TRANSCRIPTION_TEXT.failed;
      }
    }
    let tried = 0;
    for (const p of sttInOrder()) {
      if (!p.available().ok) continue;
      tried++;
      try {
        return await runStt(p, audio, mime, c);
      } catch {
        // nächster Anbieter
      }
    }
    return tried ? TRANSCRIPTION_TEXT.failed : none;
  }

  /**
   * Strenges Hören für den Sprechmodus (Issue #249): dieselbe Auswahl wie
   * transcribe (fest gewählt nur dieser Anbieter, auto der Reihe nach), aber
   * ohne Platzhaltertexte. timeoutMs gilt für die gesamte Erkennung; läuft
   * es ab, endet die Arbeit der Anbieter über das Signal und ein spätes
   * Ergebnis wird verworfen. Liefert kein Anbieter einen Text, aber
   * mindestens einer ein leeres Ergebnis, ist der Grund empty (nichts
   * gehört) statt failed (nur technische Fehler). Wirft nie.
   */
  async function recognize(audio: Buffer, mime: string, opts: { timeoutMs: number }): Promise<RecognizeResult> {
    const c = choice();
    let candidates: SttProvider[];
    if (c.stt.value !== "auto") {
      const p = sttById(c.stt.value);
      const avail = p?.available() ?? { ok: false, reason: "unbekannt" };
      if (!p || !avail.ok) {
        deps.log(`[Sprache] Hören ${c.stt.value} nicht verfügbar: ${avail.reason ?? "ohne Grund"}`);
        return { ok: false, reason: "unavailable" };
      }
      candidates = [p];
    } else {
      candidates = sttInOrder().filter(p => p.available().ok);
      if (!candidates.length) return { ok: false, reason: "unavailable" };
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">(resolve => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, opts.timeoutMs);
    });
    const work = (async (): Promise<RecognizeResult> => {
      let heardNothing = false;
      for (const p of candidates) {
        if (controller.signal.aborted) break;
        try {
          const text = await runStt(p, audio, mime, c, controller.signal);
          return { ok: true, text: text.trim(), provider: p.id };
        } catch (e) {
          // Leerer Text ist kein technischer Fehler; bei auto trotzdem der nächste Anbieter
          if (e instanceof SpeechError && e.kind === "empty") heardNothing = true;
        }
      }
      return { ok: false, reason: heardNothing ? "empty" : "failed" };
    })();
    try {
      const result = await Promise.race([work, timeout]);
      if (result !== "timeout") return result;
      deps.log(`[Sprache] Hören: Zeitlimit nach ${opts.timeoutMs} ms`);
      return { ok: false, reason: "timeout" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Dateiweg (Telegram, WebUI-Anhänge): MIME aus der Endung, Lesefehler ergeben einen Platzhalter */
  async function transcribeFile(path: string): Promise<string> {
    let audio: Buffer;
    try {
      audio = await deps.readFile(path);
    } catch (e) {
      deps.log(`[Sprache] Audiodatei nicht lesbar (${describeSpeechError(e)})`);
      return TRANSCRIPTION_TEXT.failed;
    }
    return transcribe(audio, mimeForFile(path), TRANSCRIPTION_TEXT.noneFile);
  }

  /** Pufferweg (VPS-Gateway) */
  function transcribeBuffer(audio: Buffer, mime: string = "audio/ogg"): Promise<string> {
    return transcribe(audio, mime, TRANSCRIPTION_TEXT.noneBuffer);
  }

  /** Server-Anbieter für textToSpeech nach der Telegram-Wahl; browser gilt als auto */
  function serverTtsCandidates(v: TelegramTtsChoice): { fixed: boolean; list: TtsProvider[] } {
    if (v === "auto" || v === "browser") {
      return { fixed: false, list: SERVER_TTS_CHAIN.map(ttsById).filter((p): p is TtsProvider => !!p) };
    }
    const p = ttsById(v);
    return { fixed: true, list: p && p.where === "server" ? [p] : [] };
  }

  /** Sprachausgabe für Telegram und /voice: Buffer oder null, wirft nie */
  async function synthesizeServer(text: string): Promise<Buffer | null> {
    const c = choice();
    const v = telegramTts();
    const { fixed, list } = serverTtsCandidates(v);
    if (fixed && !list.length) {
      deps.log(`[Sprache] Sprechen ${v} nicht verfügbar: kein Server-Anbieter`);
      return null;
    }
    for (const p of list) {
      const avail = p.available();
      if (!avail.ok) {
        if (fixed) deps.log(`[Sprache] Sprechen ${p.id} nicht verfügbar: ${avail.reason ?? "ohne Grund"}`);
        continue;
      }
      try {
        const out = await timed(`Sprechen ${p.id}`, () => p.synthesize(text, languageOpt(c)));
        return out.audio;
      } catch {
        // nächster Anbieter
      }
    }
    return null;
  }

  /**
   * Sprachausgabe für den Sprechmodus (Issue #249): der gewählte
   * serverseitige Anbieter und nur er. auto und browser: Grund browser, der
   * Server spricht dann nie. voice gilt nur für diesen Aufruf (VOICE_PATTERN).
   * Wirft nie.
   */
  async function synthesizeSpeech(text: string, opts: { voice?: string } = {}): Promise<SynthesizeResult> {
    const c = choice();
    const v = c.tts.value;
    if (v === "auto" || v === "browser") return { ok: false, reason: "browser" };
    if (opts.voice !== undefined && !VOICE_PATTERN.test(opts.voice)) return { ok: false, reason: "voice" };
    const p = ttsById(v);
    const avail = p && p.where === "server" ? p.available() : { ok: false, reason: "kein Server-Anbieter" };
    if (!p || !avail.ok) {
      deps.log(`[Sprache] Sprechen ${v} nicht verfügbar: ${avail.reason ?? "ohne Grund"}`);
      return { ok: false, reason: "unavailable" };
    }
    // Stimmen außerhalb der Positivliste des Anbieters (Pocket TTS, Issue #252) gar nicht erst anfragen
    if (opts.voice !== undefined && p.voiceAllowed && !p.voiceAllowed(opts.voice)) return { ok: false, reason: "voice" };
    try {
      const out = await timed(`Sprechen ${p.id}`, async () => {
        const result = await p.synthesize(text, { ...languageOpt(c), ...(opts.voice ? { voice: opts.voice } : {}) });
        const mime = AUDIO_MIME[result.mime.split(";")[0].trim().toLowerCase()];
        if (!mime || !result.audio.length) throw new SpeechError("format");
        // Eigene Stimme nur als WAV: sonst fehlte die Kennzeichnung
        if (p.id === "clone" && mime !== "audio/wav") throw new SpeechError("format");
        return { audio: result.audio, mime };
      });
      const audio = out.mime === "audio/wav" ? tagWavAiGenerated(out.audio, { cloned: p.id === "clone" }) : out.audio;
      return { ok: true, audio, mime: out.mime, provider: p.id };
    } catch {
      return { ok: false, reason: "failed" };
    }
  }

  /** Erster verfügbarer bzw. fest gewählter Anbieter fürs Hören; null, wenn keiner verfügbar ist */
  function activeStt(c: SpeechChoice = choice()): SttProvider | null {
    if (c.stt.value !== "auto") {
      const p = sttById(c.stt.value);
      return p && p.available().ok ? p : null;
    }
    return sttInOrder().find(p => p.available().ok) ?? null;
  }

  function isTranscriptionEnabled(): boolean {
    return activeStt() !== null;
  }

  function getTranscriptionProvider(): string {
    const p = activeStt();
    return p ? (TRANSCRIPTION_LABELS[p.id] ?? p.label) : "none";
  }

  /** Nur Server-Anbieter zählen; die Browser-Stimme macht Telegram-TTS nie eingerichtet */
  function isVoiceEnabled(): boolean {
    return serverTtsCandidates(telegramTts()).list.some(p => p.available().ok);
  }

  function localMode(c: SpeechChoice = choice()): LocalModeStatus {
    let stt: LocalModeStatus["stt"] = null;
    let sttReason: string | undefined;
    if (c.stt.value !== "auto") {
      const p = sttById(c.stt.value);
      const avail = p?.available() ?? { ok: false };
      stt = { id: c.stt.value, label: p?.label ?? c.stt.value, local: p?.local ?? false, available: avail.ok };
      if (!avail.ok) sttReason = `Hören: ${stt.label} ist nicht verfügbar${avail.reason ? ` (${avail.reason})` : ""}`;
    } else {
      const p = sttInOrder().find(x => x.available().ok);
      if (p) stt = { id: p.id, label: p.label, local: p.local, available: true };
      else sttReason = "Hören: kein Anbieter eingerichtet";
    }
    const ttsId = c.tts.value === "auto" ? "browser" : c.tts.value;
    const tp = ttsById(ttsId);
    const tAvail = tp?.available() ?? { ok: false };
    const tts: LocalModeStatus["tts"] = { id: ttsId, label: tp?.label ?? ttsId, where: tp?.where ?? "server", available: tAvail.ok };
    const ttsReason = tAvail.ok ? undefined : `Sprechen: ${tts.label} ist nicht verfügbar${tAvail.reason ? ` (${tAvail.reason})` : ""}`;
    const ready = !!stt && stt.available && tts.available;
    const reason = [sttReason, ttsReason].filter(Boolean).join("; ");
    return { ready, ...(ready || !reason ? {} : { reason }), stt, tts };
  }

  /** Anbieter für den Telefonhörer (siehe Kopf); keine eigene Stimme */
  function callChoice(c: SpeechChoice = choice()): CallSpeechChoice {
    return { ...callStt(c), ...callTts(c) };
  }

  /** Lokaler Erkenner (Parakeet, whisper.cpp), wenn verfügbar */
  const localStt = (id: string) => {
    const p = sttById(id);
    return p && CALL_STT_IDS.includes(p.id) && p.available().ok ? p : null;
  };

  /** ElevenLabs Scribe bereit? (Schlüssel und eigener Weg des Telefonhörers) */
  function scribe(): { provider: SttProvider | null; reason?: string } {
    const e = sttById("elevenlabs");
    if (!e || !e.openCallStream) return { provider: null, reason: "ElevenLabs ist nicht eingebunden" };
    const a = e.available();
    return a.ok ? { provider: e } : { provider: null, reason: a.reason ?? "nicht verfügbar" };
  }

  /** Erkenner des Telefonhörers nach speech.call.stt (siehe Kopf) */
  function callStt(c: SpeechChoice): Pick<CallSpeechChoice, "stt" | "sttReason" | "sttSetting" | "sttNote" | "sttFallback"> {
    const setting: CallSttChoice = deps.getSettings().speech?.call?.stt ?? "auto";
    if (setting === "parakeet" || setting === "whisper-cpp") {
      const p = sttById(setting);
      const stt = localStt(setting);
      if (stt) return { stt, sttSetting: setting };
      const reason = p?.available().reason;
      return { stt: null, sttSetting: setting, sttReason: `Hören: ${p?.label ?? setting} ist nicht verfügbar${reason ? ` (${reason})` : ""}` };
    }
    if (setting === "elevenlabs") {
      const e = scribe();
      if (e.provider) return { stt: e.provider, sttSetting: setting, sttFallback: localStt("parakeet") };
      const local = CALL_STT_IDS.map(localStt).find((p): p is SttProvider => !!p) ?? null;
      const why = `${CALL_SCRIBE_LABEL} ist nicht wählbar (${e.reason})`;
      return local
        ? { stt: local, sttSetting: setting, sttNote: `${why}, es erkennt ${local.label}` }
        : { stt: null, sttSetting: setting, sttReason: `${why}; Parakeet oder whisper.cpp einrichten` };
    }
    // auto: wie vor Issue #279 nach speech.stt, nur lokal
    let stt: SttProvider | null = null;
    let sttReason: string | undefined;
    if (c.stt.value !== "auto") {
      const p = sttById(c.stt.value);
      if (!p || !CALL_STT_IDS.includes(p.id)) sttReason = `Der Telefonhörer hört nur lokal (Parakeet oder whisper.cpp), eingestellt ist ${p?.label ?? c.stt.value}`;
      else {
        const avail = p.available();
        if (avail.ok) stt = p;
        else sttReason = `Hören: ${p.label} ist nicht verfügbar${avail.reason ? ` (${avail.reason})` : ""}`;
      }
    } else {
      stt = sttInOrder().find(p => CALL_STT_IDS.includes(p.id) && p.available().ok) ?? null;
      if (!stt) sttReason = "Hören: Parakeet oder whisper.cpp einrichten";
    }
    return { stt, sttSetting: setting, ...(sttReason ? { sttReason } : {}) };
  }

  /** Erkenner für den Telefonhörer mit Verfügbarkeit (Reiter „Sprechen“, Issue #279) */
  function callSttOptions(): CallSttOption[] {
    const local = (id: "parakeet" | "whisper-cpp"): CallSttOption => {
      const p = sttById(id);
      const a = p?.available() ?? { ok: false, reason: "nicht eingebunden" };
      return { id, label: p?.label ?? id, available: a.ok, ...(a.ok || !a.reason ? {} : { reason: a.reason }) };
    };
    const e = scribe();
    return [
      { id: "auto", label: "Automatisch", available: true },
      local("parakeet"),
      local("whisper-cpp"),
      { id: "elevenlabs", label: CALL_SCRIBE_LABEL, available: !!e.provider, ...(e.provider ? {} : { reason: e.reason }) },
    ];
  }

  /** Lokale Server-Stimme (Pocket TTS, Piper), wenn verfügbar */
  function localServerTts(id: string): TtsProvider | null {
    const t = ttsById(id);
    return t && CALL_TTS_IDS.includes(t.id) && t.where === "server" && t.available().ok ? t : null;
  }

  /** ElevenLabs gestreamt bereit? (nur der Schlüssel zählt, nicht ELEVENLABS_VOICE_ID) */
  function elevenStream(): { provider: TtsProvider | null; reason?: string } {
    const e = ttsById("elevenlabs");
    if (!e || !e.synthesizeStream) return { provider: null, reason: "ElevenLabs ist nicht eingebunden" };
    const a = (e.streamAvailable ?? e.available)();
    return a.ok ? { provider: e } : { provider: null, reason: a.reason ?? "nicht verfügbar" };
  }

  /** Stimme des Telefonhörers nach speech.call.tts (siehe Kopf) */
  function callTts(c: SpeechChoice): Omit<CallSpeechChoice, "stt" | "sttReason" | "sttSetting" | "sttNote" | "sttFallback"> {
    const call = deps.getSettings().speech?.call;
    const setting: CallTtsChoice = call?.tts ?? "auto";
    if (setting === "browser") return { tts: null, ttsSetting: setting };
    if (setting === "auto") return { tts: localServerTts(c.tts.value), ttsSetting: setting };
    if (setting === "pocket" || setting === "piper") {
      const t = localServerTts(setting);
      if (t) return { tts: t, ttsSetting: setting };
      const p = ttsById(setting);
      const reason = p?.available().reason;
      return { tts: null, ttsSetting: setting, ttsReason: `${p?.label ?? setting} ist nicht verfügbar${reason ? ` (${reason})` : ""}, der Browser spricht` };
    }
    const pocket = localServerTts("pocket");
    const e = elevenStream();
    if (!e.provider) {
      return { tts: pocket, ttsSetting: setting, ttsReason: `ElevenLabs ist nicht wählbar (${e.reason}), es spricht ${pocket ? pocket.label : "der Browser"}` };
    }
    return {
      tts: e.provider,
      ttsSetting: setting,
      ttsFallback: pocket,
      ttsOptions: { voice: call?.elevenlabsVoice ?? CALL_ELEVENLABS_DEFAULT_VOICE, model: call?.elevenlabsModel ?? ELEVENLABS_DEFAULT_MODEL },
    };
  }

  /** Stimmen für den Telefonhörer mit Verfügbarkeit (Reiter „Sprechen“, Issue #276) */
  function callTtsOptions(): CallTtsOption[] {
    const local = (id: "pocket" | "piper"): CallTtsOption => {
      const p = ttsById(id);
      const a = p?.available() ?? { ok: false, reason: "nicht eingebunden" };
      return { id, label: p?.label ?? id, available: a.ok, ...(a.ok || !a.reason ? {} : { reason: a.reason }) };
    };
    const e = elevenStream();
    return [
      { id: "auto", label: "Automatisch", available: true },
      local("pocket"),
      local("piper"),
      { id: "elevenlabs", label: "ElevenLabs", available: !!e.provider, ...(e.provider ? {} : { reason: e.reason }) },
      { id: "browser", label: "Browser-Stimme", available: true },
    ];
  }

  function options(): SpeechOptions {
    const withReason = (a: { ok: boolean; reason?: string }) => ({ available: a.ok, ...(a.ok || !a.reason ? {} : { reason: a.reason }) });
    return {
      stt: sttInOrder().map(p => ({ id: p.id, label: p.label, local: p.local, ...withReason(p.available()) })),
      tts: deps.tts.map(p => ({ id: p.id, label: p.label, local: p.local, where: p.where, ...(p.note ? { note: p.note } : {}), ...withReason(p.available()) })),
      languages: [...SPEECH_LANGUAGES],
    };
  }

  return {
    choice,
    telegramTts,
    transcribe,
    transcribeFile,
    transcribeBuffer,
    recognize,
    synthesizeServer,
    synthesizeSpeech,
    isTranscriptionEnabled,
    getTranscriptionProvider,
    isVoiceEnabled,
    localMode,
    callChoice,
    callSttOptions,
    callTtsOptions,
    options,
  };
}
