/**
 * Hören für Telegram, WebUI-Anhänge und das VPS-Gateway: dünne Zugänge zur
 * Sprach-Schnittstelle (src/lib/speech/, seit Issue #248).
 *
 * Welcher Anbieter hört, entscheidet die Kette: speech.stt in
 * config/settings.json bzw. SPEECH_STT legt einen fest; bei auto der Reihe
 * nach Parakeet, whisper.cpp, ElevenLabs, Gemini. Nicht verfügbare werden
 * übersprungen, Fehler und leere Ergebnisse geben an den nächsten weiter.
 * Beide Wege liefern immer Text und werfen nie.
 */

import { getSpeech } from "./speech";

/** Audiodatei in Text; den MIME-Typ bestimmt die Endung */
export const transcribeAudio = (filePath: string): Promise<string> => getSpeech().transcribeFile(filePath);

/** Audio im Speicher in Text (VPS-Gateway); ohne Angabe gilt Ogg */
export const transcribeAudioBuffer = (audioBuffer: Buffer, mimeType = "audio/ogg"): Promise<string> =>
  getSpeech().transcribeBuffer(audioBuffer, mimeType);

/** Steht ein Anbieter zum Hören bereit? Bei fester Wahl zählt nur dieser */
export const isTranscriptionEnabled = (): boolean => getSpeech().isTranscriptionEnabled();

/** Anzeigename des Anbieters fürs Startlog, "none" ohne Anbieter */
export const getTranscriptionProvider = (): string => getSpeech().getTranscriptionProvider();
