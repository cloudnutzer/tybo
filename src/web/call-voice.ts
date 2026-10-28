/**
 * Stimme eines Telefonhörer-Gesprächs mit Rückfall je Abschnitt (Issue #276).
 * Nur ./bot-call.ts bindet das ein.
 *
 * Ohne Rückfall (Pocket TTS, Piper): der Ton des Anbieters wie bisher,
 * gestreamt oder am Stück; ein Fehler wirft (die Sitzung macht den Turn dann
 * zu Text).
 *
 * Mit Rückfall (ElevenLabs, Pocket TTS als Rückfall, sonst der Browser):
 * - Scheitert der Hauptanbieter an einem Abschnitt (HTTP 401/429, Netz,
 *   Zeitlimit, leerer Strom), wird genau dieser Abschnitt vom Rückfall
 *   gesprochen: kam schon Ton, erst restart (der Browser verwirft den
 *   ungespielten Rest), dann ein Hinweis, dann der ganze Abschnitt vom
 *   Rückfall. Schon Gehörtes lässt sich nicht zurücknehmen.
 * - Fehler zählen je Gespräch über Turns hinweg. Ein erfolgreicher Abschnitt
 *   des Hauptanbieters setzt den Zähler zurück, ein erfolgreicher Rückfall
 *   nicht. Nach CALL_VOICE_MAX_FAILURES Fehlern in Folge bleibt das Gespräch
 *   beim Rückfall (Hinweis einmal).
 * - Abbruch (Unterbrechen, Auflegen) zählt nicht und startet keinen
 *   Rückfall; danach kommt nichts mehr, auch kein Aufruf beim Rückfall.
 * - Scheitert auch Pocket TTS (oder fehlt es), spricht der Browser diesen
 *   Abschnitt (browser); nach CALL_VOICE_MAX_FAILURES Pocket-Fehlern in Folge
 *   jeden weiteren.
 * - Logs nur Anbieter, Fehlerart und Dauer, nie Text.
 */

import { resamplePcm16, wavToPcm } from "../lib/speech/pcm";
import { describeSpeechError, SpeechError, type SpeechOpts, type TtsProvider } from "../lib/speech/types";
import { CALL_SAMPLE_RATE, type CallSpeakEvent } from "./call-protocol";

/** Fehler in Folge, nach denen das Gespräch beim Rückfall bleibt */
export const CALL_VOICE_MAX_FAILURES = 2;

export interface CallVoiceOptions {
  primary: TtsProvider;
  /** Sprache, Stimme und Modell je Aufruf des Hauptanbieters */
  primaryOpts: Omit<SpeechOpts, "signal">;
  /** Rückfall aktiv (nur bei ElevenLabs); fehlt: kein Rückfall, Fehler werfen */
  fallback?: {
    /** Pocket TTS; null: gleich die Browser-Stimme */
    provider: TtsProvider | null;
    opts: Omit<SpeechOpts, "signal">;
    /** Name des Hauptanbieters für den Hinweis (zur Laufzeit, etwa der Name der Stimme) */
    primaryName: () => string;
    /** Name des Rückfalls für den Hinweis */
    fallbackName: string;
  };
  log: (line: string) => void;
  now?: () => number;
}

export interface CallVoice {
  speak(text: string, signal: AbortSignal): AsyncGenerator<Uint8Array | CallSpeakEvent>;
  /** Gespräch bleibt beim Rückfall (für Tests und Logs) */
  readonly stuck: boolean;
}

/** Ton eines Anbieters als PCM16 in CALL_SAMPLE_RATE: gestreamt, sonst WAV am Stück umgerechnet */
export async function* providerPcm(provider: TtsProvider, text: string, opts: SpeechOpts & { signal: AbortSignal }): AsyncGenerator<Uint8Array> {
  const sig = opts.signal;
  if (provider.synthesizeStream) {
    const rate = provider.streamSampleRate ?? CALL_SAMPLE_RATE;
    for await (const chunk of provider.synthesizeStream(text, opts)) {
      if (sig.aborted) return;
      yield rate === CALL_SAMPLE_RATE ? chunk : resamplePcm16(chunk, rate, CALL_SAMPLE_RATE);
    }
    return;
  }
  const out = await provider.synthesize(text, opts);
  if (!out.mime.startsWith("audio/wav") && !out.mime.startsWith("audio/x-wav")) throw new SpeechError("format");
  const { sampleRate, pcm } = wavToPcm(out.audio);
  if (sig.aborted) return;
  yield resamplePcm16(pcm, sampleRate, CALL_SAMPLE_RATE);
}

export function createCallVoice(o: CallVoiceOptions): CallVoice {
  const now = o.now ?? Date.now;
  const fb = o.fallback;
  let primaryFailures = 0;
  let fallbackFailures = 0;
  let stuck = false;
  let browserOnly = false;

  /** Ein Anbieter für einen Abschnitt; ok false: gescheitert (nicht abgebrochen), sent: ob schon Ton hinausging */
  async function* attempt(provider: TtsProvider, text: string, opts: Omit<SpeechOpts, "signal">, signal: AbortSignal, result: { ok: boolean; sent: boolean; error?: unknown }): AsyncGenerator<Uint8Array> {
    try {
      let bytes = 0;
      for await (const chunk of providerPcm(provider, text, { ...opts, signal })) {
        if (signal.aborted) return;
        if (!chunk.length) continue;
        bytes += chunk.length;
        result.sent = true;
        yield chunk;
      }
      if (signal.aborted) return;
      // Ein leerer Strom ist für den Rückfall ein Fehler: sonst bliebe der Abschnitt stumm
      if (!bytes) throw new SpeechError("empty");
      result.ok = true;
    } catch (e) {
      result.ok = false;
      result.error = e;
    }
  }

  async function* speak(text: string, signal: AbortSignal): AsyncGenerator<Uint8Array | CallSpeakEvent> {
    if (!fb) {
      yield* providerPcm(o.primary, text, { ...o.primaryOpts, signal });
      return;
    }
    if (signal.aborted) return;
    if (!stuck) {
      const t0 = now();
      const r = { ok: false, sent: false } as { ok: boolean; sent: boolean; error?: unknown };
      yield* attempt(o.primary, text, o.primaryOpts, signal, r);
      if (signal.aborted) return;
      if (r.ok) {
        primaryFailures = 0;
        return;
      }
      primaryFailures++;
      if (primaryFailures >= CALL_VOICE_MAX_FAILURES) stuck = true;
      const target = fb.provider && !browserOnly ? fb.fallbackName : "der Browser-Stimme";
      o.log(`Stimme ${o.primary.id}: Fehler (${describeSpeechError(r.error)}) nach ${now() - t0} ms, ${stuck ? "Gespräch bleibt beim Rückfall" : "Rückfall für diesen Abschnitt"}`);
      if (r.sent) yield { type: "restart" };
      yield {
        type: "notice",
        text: stuck ? `${fb.primaryName()} ist nicht erreichbar, das Gespräch bleibt bei ${target}.` : `${fb.primaryName()} ist nicht erreichbar, weiter mit ${target}.`,
      };
    }
    if (fb.provider && !browserOnly) {
      const t0 = now();
      const r = { ok: false, sent: false } as { ok: boolean; sent: boolean; error?: unknown };
      yield* attempt(fb.provider, text, fb.opts, signal, r);
      if (signal.aborted) return;
      if (r.ok) {
        fallbackFailures = 0;
        return;
      }
      fallbackFailures++;
      if (fallbackFailures >= CALL_VOICE_MAX_FAILURES) browserOnly = true;
      o.log(`Rückfall ${fb.provider.id}: Fehler (${describeSpeechError(r.error)}) nach ${now() - t0} ms, der Browser spricht ${browserOnly ? "ab jetzt" : "diesen Abschnitt"}`);
      if (r.sent) yield { type: "restart" };
    }
    yield { type: "browser" };
  }

  return {
    speak,
    get stuck() {
      return stuck;
    },
  };
}
