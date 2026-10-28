/**
 * Eigene Stimme (Issue #253, Entscheidung 0023): Routen und Schnittstelle,
 * über die die WebUI eine geklonte Stimme anlegt, prüft, verwendet und
 * löscht.
 *
 * - GET /api/speech/voices: Stimmen, Klon-Engine, Texte (Einwilligung,
 *   Vorlesetext, Grenzen)
 * - POST /api/speech/voices?name=<Name>&consent=ja: Rohdaten einer Aufnahme
 *   (audio/wav, PCM16 mono, 5 bis 30 Sekunden). Ohne consent=ja nimmt der
 *   Server nichts an und legt nichts ab (400 einwilligung), auch wenn die
 *   Aufnahme gültig wäre. Kein Formular-Upload (multipart wird abgewiesen)
 * - POST /api/speech/voices/<id>/probe: Testsatz mit dieser Stimme (WAV mit
 *   Kennzeichnung „KI-generiert, geklonte Stimme")
 * - POST /api/speech/voices/<id>/use: als Stimme fürs Vorlesen im
 *   Sprechmodus verwenden (nie für Telegram, Telefon oder ElevenLabs)
 * - DELETE /api/speech/voices/<id>: Referenz, Text und Einwilligung löschen
 *
 * Alle Routen nur angemeldet; schreibende mit Origin-Prüfung wie überall.
 * Die Einwilligung prüft der Port bei Probe und Verwendung erneut (die
 * Ablage liefert eine Stimme ohne gültige Einwilligung nicht).
 *
 * Wie ./speech.ts importiert diese Datei nichts aus src/lib: src/bot.ts
 * reicht den Port aus ./bot-voice-clone.ts herein, Demo und Tests Attrappen.
 */

export const VOICES_PATH = "/api/speech/voices";
/** /api/speech/voices/<id> und /api/speech/voices/<id>/(probe|use) */
export const VOICE_ITEM_PATH = /^\/api\/speech\/voices\/([^/]+)(?:\/(probe|use))?$/;

/** Wie VOICE_MAX_BYTES in src/lib/speech/voices.ts */
export const MAX_VOICE_UPLOAD_BYTES = 3 * 1_048_576;

export interface ClonedVoiceInfo {
  id: string;
  name: string;
  /** „<Name> (KI-Stimme)" */
  label: string;
  createdAt: string;
  seconds: number;
  /** Ist sie die gewählte Stimme fürs Vorlesen? */
  active: boolean;
}

export interface CloneEngineStatus {
  ready: boolean;
  /** pocket oder qwen3-base, wenn eine eingerichtet ist */
  id?: string;
  label?: string;
  /** Hinweis zur Engine (Lizenz, Tempo) */
  note?: string;
  /** Nur bei ready: false, kurzer deutscher Satz */
  reason?: string;
}

export interface VoiceList {
  voices: ClonedVoiceInfo[];
  engine: CloneEngineStatus;
  /** Wird die gewählte eigene Stimme gerade zum Vorlesen genutzt (speech.tts = clone)? */
  inUse: boolean;
  texts: VoiceCloneTexts;
}

export type VoiceCreateRefusal = "einwilligung" | "name" | "format" | "leer" | "zu-kurz" | "zu-lang" | "zu-gross" | "zu-viele";

export type VoiceProbeResult =
  | { ok: true; audio: Uint8Array; mime: "audio/wav" }
  | { ok: false; reason: "unbekannt" | "engine" | "failed" };

export interface VoiceClonePort {
  list(): Promise<VoiceList>;
  create(input: { name: string; consent: boolean; device: string; audio: Uint8Array }): Promise<{ ok: true; voice: ClonedVoiceInfo } | { ok: false; reason: VoiceCreateRefusal }>;
  /** Testsatz mit dieser Stimme; prüft Einwilligung und Engine */
  probe(id: string): Promise<VoiceProbeResult>;
  /** Als Stimme fürs Vorlesen verwenden; prüft Einwilligung und Engine */
  use(id: string): Promise<{ ok: true } | { ok: false; reason: "unbekannt" | "engine" | "settings" }>;
  /** Löscht Referenz, Text und Einwilligung; war sie gewählt, gilt danach wieder die Wahl von vor „Verwenden" */
  remove(id: string): Promise<boolean>;
}

/** Feste Texte für die Oberfläche (aus src/lib/speech/voices.ts, im Port gesetzt) */
export interface VoiceCloneTexts {
  consent: string;
  reading: string;
  probe: string;
  minSeconds: number;
  maxSeconds: number;
}

export const VOICE_CLONE_TEXT = {
  notConfigured: "Eigene Stimmen sind nicht eingerichtet",
  consent: "Ohne Einwilligung wird nichts gespeichert",
  name: "Bitte einen Namen mit höchstens 40 Zeichen angeben (Buchstaben, Ziffern, Leerzeichen, Punkt, Bindestrich)",
  format: "Die Aufnahme muss ein WAV (PCM 16 Bit, mono) aus der Aufnahme in tybo sein",
  empty: "Die Aufnahme ist leer",
  tooShort: "Die Aufnahme ist zu kurz: mindestens 5 Sekunden",
  tooLong: "Die Aufnahme ist zu lang: höchstens 30 Sekunden",
  tooLarge: "Die Aufnahme ist zu groß: höchstens 3 MB",
  tooMany: "Höchstens 10 eigene Stimmen; bitte erst eine löschen",
  unknown: "Diese Stimme gibt es nicht (mehr)",
  engine: "Keine Klon-Engine eingerichtet",
  probeFailed: "Die Probe ist fehlgeschlagen",
  settings: "Die Einstellung ließ sich nicht speichern",
  failed: "Die Stimme ließ sich nicht speichern",
} as const;

const CREATE_TEXT: Record<VoiceCreateRefusal, string> = {
  einwilligung: VOICE_CLONE_TEXT.consent,
  name: VOICE_CLONE_TEXT.name,
  format: VOICE_CLONE_TEXT.format,
  leer: VOICE_CLONE_TEXT.empty,
  "zu-kurz": VOICE_CLONE_TEXT.tooShort,
  "zu-lang": VOICE_CLONE_TEXT.tooLong,
  "zu-gross": VOICE_CLONE_TEXT.tooLarge,
  "zu-viele": VOICE_CLONE_TEXT.tooMany,
};

const CREATE_STATUS: Record<VoiceCreateRefusal, number> = {
  einwilligung: 400,
  name: 400,
  format: 415,
  leer: 400,
  "zu-kurz": 400,
  "zu-lang": 413,
  "zu-gross": 413,
  "zu-viele": 409,
};

export function createRefusalResponse(reason: VoiceCreateRefusal): { status: number; body: { error: string; reason: string } } {
  return { status: CREATE_STATUS[reason], body: { error: CREATE_TEXT[reason], reason } };
}

/** consent=ja aus der Adresse; nur genau dieser Wert zählt als Einwilligung */
export function consentFromQuery(params: URLSearchParams): boolean {
  const all = params.getAll("consent");
  return all.length === 1 && all[0] === "ja";
}
