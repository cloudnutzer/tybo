/**
 * Schnittstellen der Sprach-Anbieter (Issue #248, Entscheidung 0023).
 *
 * available() ist synchron und prüft nur Dateien, Programme im PATH,
 * Schlüssel und Umgebung: kein Modellstart, kein Netzwerk. reason ist ein
 * kurzer deutscher Satz ohne Werte.
 *
 * transcribe/synthesize werfen bei Fehlern (am liebsten SpeechError, damit
 * das Log die Art nennen kann). Leerer Text gilt beim Hören als Fehler.
 * Platzhaltertexte bildet nur die Kette (./chain.ts).
 */

import type { SttId, TtsId } from "./ids";
import type { ScribeStream } from "./scribe";

export interface Availability {
  ok: boolean;
  reason?: string;
}

export interface SpeechOpts {
  /** Sprachcode aus zwei Kleinbuchstaben; fehlt: automatisch bzw. Standard des Anbieters */
  language?: string;
  /**
   * Abbruch von außen (Issue #249, Zeitlimit des Sprechmodus): Subprozesse
   * und Netzaufrufe enden, Temp-Dateien werden trotzdem aufgeräumt
   */
  signal?: AbortSignal;
  /**
   * Stimme für diesen Aufruf (Issue #249, nur Sprechen): Name bzw. Kennung
   * beim Anbieter, geprüft mit VOICE_PATTERN; fehlt: die eingestellte Stimme
   */
  voice?: string;
  /**
   * Modell beim Anbieter für diesen Aufruf (Issue #276, nur ElevenLabs
   * gestreamt, aus ELEVENLABS_MODELS); fehlt: der Standard des Anbieters
   */
  model?: string;
}

/** Stimme je Aufruf: Buchstaben, Ziffern, _ und -, nie mit - am Anfang (geht als Argument an Programme) */
export const VOICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Geladener Erkenner für die Dauer eines Telefonhörer-Gesprächs (Issue #257):
 * transcribe wie beim Anbieter, close() beendet ihn (beim Auflegen).
 */
export interface WarmStt {
  transcribe(audio: Buffer, mime: string, opts: SpeechOpts): Promise<string>;
  close(): void;
}

export interface SttProvider {
  id: SttId;
  label: string;
  local: boolean;
  available(): Availability;
  transcribe(audio: Buffer, mime: string, opts: SpeechOpts): Promise<string>;
  /**
   * Dauerbetrieb (Issue #257, abwärtskompatibel): hält das Modell geladen.
   * Fehlt warm oder ergibt canWarm() false, ruft der Telefonhörer
   * transcribe je Äußerung (langsamer).
   */
  warm?(): Promise<WarmStt>;
  /** Lässt sich warm() hier nutzen? Nur Dateien prüfen, synchron */
  canWarm?(): boolean;
  /**
   * Eigener Weg des Telefonhörers (Issue #279, nur ElevenLabs Scribe): eine
   * Realtime-Verbindung je Gespräch, die die Äußerung schon beim Sprechen
   * bekommt (./scribe.ts), Sprache aus opts. transcribe (Telegram,
   * Sprechmodus) bleibt davon unberührt.
   */
  openCallStream?(opts: SpeechOpts): ScribeStream;
}

export interface TtsProvider {
  id: TtsId;
  label: string;
  local: boolean;
  where: "server" | "browser";
  /** Namensnennung bzw. Lizenzhinweis für die Einstellungsseite (Issue #252) */
  note?: string;
  available(): Availability;
  /**
   * Darf diese Stimme je Aufruf gewählt werden? Fehlt: jede Stimme nach
   * VOICE_PATTERN. Pocket TTS nur aus seiner Positivliste (Issue #252).
   */
  voiceAllowed?(voice: string): boolean;
  synthesize(text: string, opts: SpeechOpts): Promise<{ audio: Buffer; mime: string }>;
  /**
   * Gestreamte Sprachausgabe (Issue #257, abwärtskompatibel): PCM16 LE mono
   * in streamSampleRate, Stück für Stück, sobald es berechnet ist. Fehlt sie,
   * liefert der Telefonhörer den Abschnitt am Stück (synthesize).
   */
  synthesizeStream?(text: string, opts: SpeechOpts): AsyncIterable<Uint8Array>;
  /** Abtastrate von synthesizeStream */
  streamSampleRate?: number;
  /** Vorwärmen (Issue #257): Prozess starten und Modell laden, ohne zu sprechen */
  warm?(opts?: SpeechOpts): Promise<void>;
  /**
   * Bereit für synthesizeStream mit einer Stimme je Aufruf (Issue #276):
   * ElevenLabs braucht dafür nur den Schlüssel, nicht ELEVENLABS_VOICE_ID.
   * Fehlt: es gilt available().
   */
  streamAvailable?(): Availability;
  /** Anzeigename einer Stimme, soweit schon bekannt (Issue #276, ElevenLabs nach warm) */
  voiceName?(voice: string): string | null;
}

/** Art eines Fehlers, fürs Log (nie Inhalt) */
export type SpeechErrorKind = "exit" | "http" | "timeout" | "empty" | "unavailable" | "format" | "network";

/**
 * Fehler eines Anbieters. code: Exit-Code bzw. HTTP-Status. Die Meldung
 * enthält nie Transkript, Text, stderr oder Antworttexte.
 */
export class SpeechError extends Error {
  constructor(readonly kind: SpeechErrorKind, readonly code?: number) {
    super(code !== undefined ? `${kind} ${code}` : kind);
    this.name = "SpeechError";
  }
}

/** Kurzform eines Fehlers fürs Log: Art mit Exit-Code oder HTTP-Status, sonst nur der Fehlername */
export function describeSpeechError(e: unknown): string {
  if (e instanceof SpeechError) {
    switch (e.kind) {
      case "exit":
        return `Exit-Code ${e.code ?? "?"}`;
      case "http":
        return `HTTP ${e.code ?? "?"}`;
      case "timeout":
        return "Zeitlimit";
      case "empty":
        return "leeres Ergebnis";
      case "unavailable":
        return "nicht verfügbar";
      case "format":
        return "unerwartete Antwort";
      case "network":
        return "Netzfehler";
    }
  }
  // Rohe Fehler können Befehlsargumente, Text oder URLs mit Schlüssel enthalten: nur der Name
  return e instanceof Error ? e.name : typeof e;
}
