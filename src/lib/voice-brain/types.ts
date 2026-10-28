/**
 * Schnittstelle zwischen Gesprächs-Turn und Modell (Issue #255). Ein Weg
 * (Backend) liefert nur Text; Kontext, Sprechstil, Satz-Strom und Tag-Filter
 * liegen im Turn. Wege: Messages API (#255), offene Claude-Code-Sitzung und
 * Chat-Completions für OpenRouter und Ollama (#256).
 *
 * Lebenszyklus (#256): Ein Weg gehört zu genau einem Gespräch. Der Aufrufer
 * erzeugt ihn zu Beginn (createCallBackend in call-model.ts), ruft stream()
 * je Äußerung nacheinander auf (nie zwei gleichzeitig) und am Ende close().
 */

export interface BrainMessage {
  role: "user" | "assistant";
  content: string;
}

export interface BrainCall {
  system: string;
  /** Verlauf samt der aktuellen Äußerung als letzte Nutzer-Nachricht */
  messages: BrainMessage[];
  /**
   * Zustand des Turns (#256): abgebrochen heißt, kein weiteres Textstück und
   * kein weiterer Abschnitt. runVoiceTurn übergibt hier sein eigenes Signal,
   * das alle Abbruchwege zusammenführt.
   */
  signal?: AbortSignal;
  /**
   * Turn von der Seite des Wegs aus beenden: setzt signal (Grund als reason).
   * Wege rufen das für jeden Abbruch, der bei ihnen entsteht (interrupt(),
   * /stop, close()), damit der Turn denselben Zustand sieht wie bei einem
   * Abbruch über das Signal. Ein BrainError als Grund wird zum error-Ereignis
   * (etwa "ended" nach /stop), alles andere zu done mit aborted: true.
   */
  abort?(reason?: unknown): void;
}

export interface BrainBackend {
  id: string;
  label: string;
  /** Textstücke, sobald sie kommen; Fehler als geworfene Ausnahme (der Turn macht daraus ein Ereignis) */
  stream(call: BrainCall): AsyncIterable<{ text: string }>;
  /**
   * Laufende Antwort abbrechen (für Wege mit offener Sitzung, #256). Beendet
   * den Turn über call.abort() sofort; das Promise wartet, bis die Sitzung
   * den Turn wirklich beendet hat, und der nächste stream() wartet ebenso.
   */
  interrupt?(): void | Promise<void>;
  /**
   * Vor dem ersten Turn vorbereiten (Issue #257): bei der offenen
   * CLI-Sitzung den Prozess mit diesem System-Prompt starten. Wege ohne
   * Sitzung brauchen das nicht. Wirft BrainError wie stream().
   */
  prepare?(system: string): Promise<void>;
  /**
   * Gespräch zu Ende: Sitzung beenden, ein laufender Turn endet über
   * call.abort() mit BrainError "ended"; danach liefert stream() nur noch Fehler
   */
  close?(): void;
}

/**
 * Gründe für ein error-Ereignis: budget (Tagesbudget erschöpft, keine Anfrage
 * gesendet), api (Antwort mit Fehlerstatus oder Fehler im Strom), network
 * (keine Antwort), setup (der Weg lässt sich so nicht starten, etwa ein
 * fehlendes CLI-Flag oder zu wenig Kontext bei Ollama; Grund in message),
 * ended (das Gespräch ist beendet: zweimal hintereinander ausgefallen, /stop
 * oder close()).
 */
export type BrainErrorReason = "budget" | "api" | "network" | "setup" | "ended";

export class BrainError extends Error {
  constructor(
    readonly reason: BrainErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "BrainError";
  }
}
