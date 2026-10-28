/**
 * Ereignisse des Speichers (Issue #308). Hier liegt die einzige Liste der
 * Zuhörer für gespeicherte Nachrichten; seit Issue #314 melden sich alle
 * Aufrufer direkt hier an.
 */
import type { Message } from "./types";

/**
 * Eine Nachricht, die gerade im Speicher gelandet ist (Live-Anzeige in der
 * WebUI, Issue #20). metadata trägt immer msgId. createdAt ist der Zeitpunkt,
 * der mitgespeichert wurde, oder, wenn keiner mitkam, der Moment direkt nach
 * dem Speichern; den Wert in der Datenbank vergibt dann Supabase, er kann
 * wenige Millisekunden davor liegen.
 */
export interface SavedMessageEvent extends Pick<Message, "role" | "content"> {
  chatId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type MessageSavedListener = (event: SavedMessageEvent) => void | Promise<void>;

const subscribers = new Set<MessageSavedListener>();

/**
 * Meldet einen Zuhörer an. Er hört von jeder erfolgreich gespeicherten
 * Nachricht genau einmal. Rückgabe: Funktion zum Abmelden, mehrfacher Aufruf
 * schadet nicht.
 */
export function onMessageSaved(listener: MessageSavedListener): () => void {
  subscribers.add(listener);
  return () => void subscribers.delete(listener);
}

/**
 * Sagt allen Zuhörern Bescheid, synchron und ohne auf ihre Promises zu
 * warten. Wer sich während der Runde an- oder abmeldet, wirkt erst in der
 * nächsten. Was ein Zuhörer wirft oder ablehnt, bleibt bei ihm.
 */
export function emitMessageSaved(event: SavedMessageEvent): void {
  const snapshot = Array.from(subscribers);
  for (const listener of snapshot) {
    let outcome: void | Promise<void>;
    try {
      outcome = listener(event);
    } catch {
      continue;
    }
    // Abgelehnte Promises nicht als unbehandelten Fehler hochkommen lassen
    if (outcome) Promise.resolve(outcome).catch(() => undefined);
  }
}
