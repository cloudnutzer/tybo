/**
 * Sprechmodus im Server (Issue #249, Entscheidung 0023): Grenzen, Texte und
 * die Schnittstelle, über die der Web-Server hört und spricht.
 *
 * POST /api/conversations/<id>/speech nimmt eine Äußerung als Rohdaten an
 * (WAV, WebM/Opus, Ogg/Opus oder MP3, erkannt nur an den Bytes), lässt sie
 * erkennen und startet mit dem Text einen Turn wie eine getippte Nachricht.
 * An die Erkennung geht eine vom Server neu geschriebene Fassung aus den
 * gezählten Ton-Einheiten (./audio-duration.ts), nie der Upload selbst.
 * Das Audio wird nie abgelegt: es lebt nur im Speicher der Anfrage (ein
 * lokaler Anbieter wie whisper.cpp braucht kurz eine Temp-Datei, die er in
 * jedem Fall wieder löscht).
 *
 * POST /api/speech/tts liest einen kurzen Text mit dem gewählten
 * serverseitigen Anbieter vor.
 *
 * Wie ./voice.ts importiert diese Datei nichts aus src/lib: src/bot.ts
 * reicht den Port aus ./bot-speech.ts herein, Demo und Tests Attrappen.
 */

/** POST /api/conversations/<id>/speech */
export const SPEECH_PATH = /^\/api\/conversations\/([^/]+)\/speech$/;
export const SPEECH_TTS_PATH = "/api/speech/tts";

/** 60 Sekunden PCM16 mit 16 kHz mono sind 1,92 MB */
export const MAX_SPEECH_BYTES = 2 * 1_048_576;
export const MAX_SPEECH_SECONDS = 60;
/** Für die gesamte Erkennung, über alle Anbieter */
export const SPEECH_STT_TIMEOUT_MS = 30_000;
/** Darunter gilt eine Äußerung als nicht verstanden (Buchstaben und Ziffern) */
export const MIN_TRANSCRIPT_CHARS = 2;

/** Höchstens so viele Zeichen je Aufruf von POST /api/speech/tts */
export const MAX_TTS_CHARS = 600;
/** Rate-Limit der Sprachausgabe: Aufrufe je Zeitfenster, für den ganzen Server */
export const TTS_RATE_LIMIT = 120;
export const TTS_RATE_WINDOW_MS = 10 * 60_000;
/** Wie VOICE_PATTERN in src/lib/speech/types.ts */
export const TTS_VOICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Was die Route ausliefert; alles andere gilt als gescheiterte Synthese */
export const TTS_MIMES: readonly string[] = ["audio/wav", "audio/ogg", "audio/mpeg"];

export type SpeechRecognition =
  | { ok: true; text: string; provider?: string }
  /** empty: der Anbieter hat gearbeitet und nichts gehört (leerer Text), kein technischer Fehler */
  | { ok: false; reason: "unavailable" | "empty" | "failed" | "timeout" };

export type SpeechSynthesis =
  | { ok: true; audio: Uint8Array; mime: string; provider?: string }
  /**
   * browser: gewählt ist die Browser-Stimme (auch bei auto), der Server spricht dann nie;
   * voice: Stimme beim gewählten Anbieter nicht freigegeben (Pocket TTS, Issue #252)
   */
  | { ok: false; reason: "browser" | "unavailable" | "failed" | "voice" };

/** Vormerkung eines Sprech-Turns; release gibt frei, mehrfacher Aufruf schadet nicht */
export interface SpeechReservation {
  release(): void;
}

export interface SpeechPort {
  /**
   * Erkennt den Text einer Äußerung mit dem gewählten Anbieter (speech.stt).
   * timeoutMs gilt für die gesamte Erkennung. Nie ein Platzhaltertext: ohne
   * Text ein Grund.
   */
  recognize(audio: Uint8Array, mime: string, opts: { timeoutMs: number }): Promise<SpeechRecognition>;
  /** Liest Text mit dem gewählten serverseitigen Anbieter (speech.tts) vor */
  synthesize(text: string, opts: { voice?: string }): Promise<SpeechSynthesis>;
  /**
   * Läuft oder wartet im Gespräch gerade eine Ausführung, gleich aus welchem
   * Kanal (gemeinsamer Ausführungsschlüssel, auch Turns aus Telegram)? Der
   * ChatHub kennt nur seine eigenen Turns. Fehlt: nur der ChatHub zählt.
   */
  isBusy?(conversationId: string): boolean;
  /**
   * Prüft wie isBusy und reserviert im selben Schritt den Platz des
   * Sprech-Turns in der gemeinsamen Warteschlange des Gesprächs (Schlüssel
   * und Agent): null, wenn dort schon etwas läuft, sonst die Vormerkung. Bis
   * zur Freigabe gilt das Gespräch in jedem Kanal als beschäftigt, und ein
   * Turn aus einem anderen Kanal, der danach beginnt, wartet hinter dem
   * Sprech-Turn. Die Route ruft das unmittelbar vor dem Start des Turns,
   * reicht die Vormerkung an den Turn weiter (ChatHub.send, reservation) und
   * gibt frei, wenn er fertig ist. agent ist der Agent des Gesprächs; bei
   * Telegram-Gesprächen zählt der des Topics.
   * Fehlt: die letzte Prüfung läuft nur lesend über isBusy.
   */
  reserve?(conversationId: string, agent: string): SpeechReservation | null;
}

export const SPEECH_TEXT = {
  notConfigured: "Der Sprechmodus ist nicht eingerichtet",
  busy: "In diesem Gespräch läuft schon eine Antwort",
  tooLarge: "Aufnahme zu groß: höchstens 2 MB",
  tooLong: "Aufnahme zu lang: höchstens 60 Sekunden",
  empty: "Die Aufnahme ist leer",
  format: "Format nicht erlaubt. Erlaubt sind WAV, WebM, MP4, Ogg/Opus und MP3.",
  durationUnknown: "Die Dauer der Aufnahme lässt sich nicht bestimmen. Bitte als unkomprimiertes WAV (PCM) senden.",
  nothingUnderstood: "Nichts verstanden",
  noProvider: "Kein Anbieter fürs Hören verfügbar",
  sttFailed: "Die Erkennung ist fehlgeschlagen",
  sttTimeout: "Die Erkennung hat zu lange gedauert",
  ttsInvalid: "Ungültige Anfrage",
  ttsTooLong: `Text zu lang: höchstens ${MAX_TTS_CHARS} Zeichen je Aufruf`,
  ttsVoice: "Ungültige Stimme",
  ttsBrowser: "Gewählt ist die Browser-Stimme, der Server liest nicht vor",
  ttsUnavailable: "Die gewählte Stimme ist nicht verfügbar",
  ttsFailed: "Die Sprachausgabe ist fehlgeschlagen",
  ttsRate: "Zu viele Aufrufe der Sprachausgabe, bitte später erneut versuchen",
} as const;

/** Verzögerungslaute, die allein keine Äußerung sind: äh, ähm, öh, eh, ehm, em, uh, uhm, um, hm, mhm, mm */
const FILLER = /^(?:ä+h*m*|ö+h*m*|e+h+m*|e+m+|u+h+m*|u+m+|h+m+|m+h+m*|m{2,})$/;

/**
 * true, wenn aus der Erkennung nichts Brauchbares kam: leer, unter zwei
 * Buchstaben oder Ziffern, nur Verzögerungslaute („äh", „hm") oder nur
 * Geräusch-Anmerkungen in Klammern, wie Erkenner sie bei Stille schreiben
 * („[Musik]", „(Räuspern)").
 */
export function isNothingUnderstood(text: string): boolean {
  const spoken = text.replace(/\[[^\]]*\]|\([^)]*\)/g, " ");
  const words = spoken
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if ([...words.join("")].length < MIN_TRANSCRIPT_CHARS) return true;
  return words.every(w => FILLER.test(w));
}

/**
 * Rate-Limit mit gleitendem Fenster: höchstens `limit` Aufrufe in `windowMs`.
 * take() zählt den Aufruf, wenn er erlaubt ist; sonst nennt retryAfterMs,
 * wann der älteste aus dem Fenster fällt.
 */
export function createRateLimit(limit: number, windowMs: number, now: () => number = Date.now) {
  const times: number[] = [];
  return {
    take(): { ok: true } | { ok: false; retryAfterMs: number } {
      const t = now();
      while (times.length && t - times[0] >= windowMs) times.shift();
      if (times.length >= limit) return { ok: false, retryAfterMs: Math.max(1, times[0] + windowMs - t) };
      times.push(t);
      return { ok: true };
    },
  };
}
