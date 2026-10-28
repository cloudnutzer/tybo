/**
 * Erkennen im Telefonhörer mit Rückfall je Äußerung (Issue #279). Nur
 * ./bot-call.ts bindet das ein; Muster wie die Stimme in ./call-voice.ts.
 *
 * Ohne Rückfall (Parakeet, whisper.cpp): der Erkenner wie bisher, mit
 * seinem Zeitlimit; ein Fehler ergibt failed (die Sitzung sagt dann den
 * Fehlersatz, der zweite Fehler in Folge beendet das Gespräch).
 *
 * Mit Rückfall (ElevenLabs Scribe, Parakeet als Rückfall):
 * - Scribe hat ein eigenes, kurzes Zeitlimit (CALL_SCRIBE_TIMEOUT_MS),
 *   getrennt vom Abbruch der Äußerung. Der Rückfall bekommt ein frisches
 *   Zeitlimit, nie das schon abgelaufene.
 * - Scheitert Scribe (HTTP wie 401 oder 429, Netz, Zeitlimit, kaputte
 *   Antwort), erkennt Parakeet genau diese Äußerung, und das Ergebnis trägt
 *   einen Hinweis für den Browser (notice).
 * - Fehler zählen je Gespräch über Äußerungen hinweg. Ein erfolgreiches
 *   Scribe-Ergebnis setzt den Zähler zurück, ein erfolgreicher Rückfall
 *   nicht. Nach CALL_STT_MAX_FAILURES Fehlern in Folge bleibt das Gespräch
 *   bei Parakeet (Hinweis einmal). Fehlt der Schlüssel inzwischen
 *   (unavailable), bleibt es sofort bei Parakeet.
 * - Zähler, Bleiben und Hinweis gelten erst, wenn die Sitzung das Ergebnis
 *   übernimmt (adopt). recognize selbst ändert nichts am Gesprächszustand:
 *   Eine veraltete Pausen-Erkennung, die die Sitzung verwirft, zählt also
 *   nie, auch wenn sie schon fertig war.
 * - Abbruch der Äußerung (weitere Sprache, Unterbrechen, Auflegen) zählt
 *   nicht, startet keinen Rückfall und bringt keinen Hinweis, auch nicht
 *   während des Rückfalls.
 * - Ein leeres Ergebnis heißt „nichts gehört“, kein Fehler: kein Rückfall,
 *   der Zähler bleibt, wie er ist.
 * - Ist Parakeet nicht eingerichtet (fallback null), endet ein Scribe-Fehler
 *   wie bisher mit failed; ohne Rückfall gibt es kein Bleiben.
 *
 * Log: Anbieter, Dauer und Ergebnis als Status (ok, leer, Fehlerart,
 * abgebrochen), nie Text oder Ton.
 */

import { describeSpeechError, SpeechError } from "../lib/speech/types";
import type { CallRecognition } from "./call-protocol";

/** Fehler in Folge, nach denen das Gespräch beim Rückfall bleibt */
export const CALL_STT_MAX_FAILURES = 2;
/**
 * Zeitlimit für Scribe je Äußerung (Warten auf den Text ab dem Commit).
 * Gemessen am 2.10.2026 mit Realtime: höchstens 0,29 s in 20 Läufen.
 * Danach erkennt Parakeet.
 */
export const CALL_SCRIBE_TIMEOUT_MS = 4_000;

/** Ein Erkenner für das Gespräch */
export interface CallSttRunner {
  /** Kennung fürs Log (elevenlabs, parakeet, ...) */
  id: string;
  /** Zusatz fürs Log zur Laufzeit, etwa „ (geladen)“ */
  logSuffix?: () => string;
  /** Name für den Hinweis an den Browser */
  name: string;
  /** Zeitlimit je Äußerung */
  timeoutMs: number;
  /** PCM16 LE mono 16 kHz erkennen; wirft bei Fehlern */
  run(pcm: Uint8Array, signal: AbortSignal): Promise<string>;
}

export interface CallRecognizerOptions {
  primary: CallSttRunner;
  /** Rückfall (nur bei Scribe): Parakeet, null wenn nicht eingerichtet; fehlt: kein Rückfall */
  fallback?: CallSttRunner | null;
  log: (line: string) => void;
  now?: () => number;
  /** Zeitlimit-Signal (Tests); Standard AbortSignal.timeout */
  timeoutSignal?: (ms: number) => AbortSignal;
}

export interface CallRecognizer {
  /** PCM16 LE mono 16 kHz; wirft nie; ändert Zähler und Bleiben nicht */
  recognize(pcm: Uint8Array, signal: AbortSignal): Promise<CallRecognition>;
  /**
   * Die Sitzung übernimmt dieses Ergebnis: erst jetzt zählen Fehler, setzt
   * ein Scribe-Erfolg zurück und wird das Bleiben entschieden. Liefert den
   * Hinweis für den Browser; je Ergebnis nur einmal wirksam
   */
  adopt(result: CallRecognition): string | undefined;
  /** Gespräch bleibt beim Rückfall */
  readonly stuck: boolean;
  /** Scribe-Fehler in Folge */
  readonly failures: number;
}

type Attempt = { kind: "ok"; text: string } | { kind: "empty" } | { kind: "aborted" } | { kind: "error"; error: unknown };
/** Was die Übernahme eines Ergebnisses am Gespräch ändert */
type Effect = { kind: "reset" } | { kind: "failure"; gone: boolean };

export function createCallRecognizer(o: CallRecognizerOptions): CallRecognizer {
  const now = o.now ?? Date.now;
  const timeoutSignal = o.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const fb = o.fallback;
  let failures = 0;
  let stuck = false;

  async function attempt(r: CallSttRunner, pcm: Uint8Array, signal: AbortSignal): Promise<Attempt> {
    const name = () => `Hören ${r.id}${r.logSuffix?.() ?? ""}`;
    const t0 = now();
    if (signal.aborted) return { kind: "aborted" };
    const timeout = timeoutSignal(r.timeoutMs);
    try {
      const text = (await r.run(pcm, AbortSignal.any([signal, timeout]))).trim();
      if (signal.aborted) {
        o.log(`${name()}: abgebrochen, ${now() - t0} ms`);
        return { kind: "aborted" };
      }
      if (!text) {
        o.log(`${name()}: leer, ${now() - t0} ms`);
        return { kind: "empty" };
      }
      o.log(`${name()}: ok, ${now() - t0} ms`);
      return { kind: "ok", text };
    } catch (e) {
      if (signal.aborted) {
        o.log(`${name()}: abgebrochen, ${now() - t0} ms`);
        return { kind: "aborted" };
      }
      if (e instanceof SpeechError && e.kind === "empty") {
        o.log(`${name()}: leer, ${now() - t0} ms`);
        return { kind: "empty" };
      }
      const error = timeout.aborted ? new SpeechError("timeout") : e;
      o.log(`${name()}: Fehler (${describeSpeechError(error)}), ${now() - t0} ms`);
      return { kind: "error", error };
    }
  }

  function result(a: Attempt, provider: string): CallRecognition {
    if (a.kind === "ok") return { ok: true, text: a.text, provider };
    if (a.kind === "empty") return { ok: false, reason: "empty" };
    return { ok: false, reason: "failed" };
  }

  // Wirkung je Ergebnis, bis die Sitzung es übernimmt; verworfene Ergebnisse verfallen mit ihm
  const effects = new WeakMap<CallRecognition, Effect>();

  async function recognize(pcm: Uint8Array, signal: AbortSignal): Promise<CallRecognition> {
    if (stuck && fb) return result(await attempt(fb, pcm, signal), fb.id);
    const a = await attempt(o.primary, pcm, signal);
    if (a.kind !== "error" || !fb) {
      const r = result(a, o.primary.id);
      // Nur ein Erfolg des Hauptanbieters setzt den Zähler zurück; leer und abgebrochen lassen ihn
      if (a.kind === "ok" && fb) effects.set(r, { kind: "reset" });
      return r;
    }
    o.log(`Hören ${o.primary.id}: Rückfall ${fb.id} für diese Äußerung`);
    const b = await attempt(fb, pcm, signal);
    const r = result(b, fb.id);
    // Abgebrochen (auch während des Rückfalls): zählt nicht, kein Hinweis
    if (b.kind !== "aborted") effects.set(r, { kind: "failure", gone: a.error instanceof SpeechError && a.error.kind === "unavailable" });
    return r;
  }

  function adopt(r: CallRecognition): string | undefined {
    const e = effects.get(r);
    if (!e || !fb) return undefined;
    effects.delete(r);
    if (e.kind === "reset") {
      failures = 0;
      return undefined;
    }
    // Inzwischen schon beim Rückfall (eine andere Äußerung hat entschieden): kein zweiter Hinweis
    if (stuck) return undefined;
    failures++;
    if (failures >= CALL_STT_MAX_FAILURES || e.gone) {
      stuck = true;
      o.log(`Hören ${o.primary.id}: Gespräch bleibt bei ${fb.id}`);
      return `${o.primary.name} ist nicht erreichbar, das Gespräch bleibt bei ${fb.name}.`;
    }
    return `${o.primary.name} ist nicht erreichbar, ${fb.name} erkennt diese Äußerung.`;
  }

  return {
    recognize,
    adopt,
    get stuck() {
      return stuck;
    },
    get failures() {
      return failures;
    },
  };
}
