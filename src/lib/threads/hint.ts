/**
 * Hinweis im nächsten Turn nach einer Erinnerung (Issue #292): Ging eine
 * Erinnerung an einen offenen Faden raus (zugestellt oder unklar), steht am
 * Faden hintPending. Der nächste normale Nutzer-Turn in diesem Gespräch
 * (Telegram in bot.ts, Browser in web/bot-turn.ts; nicht /goal, nicht die
 * Sprach-Brücke) holt ihn vor dem Turn genau einmal ab (takeReminderHints)
 * und bekommt ihn über TurnOptions.turnHint. Danach läuft das Auflösen aus
 * #291 wie gewohnt.
 *
 * THREADS=off: kein Hinweis. Fehler beim Abholen: kein Hinweis, eine
 * Log-Zeile mit Gesprächskennung, der Turn läuft normal.
 */

import type { ChoiceConversation } from "../choices";
import { conversationKey } from "./detect";
import { takeReminderHints as realTake, threadsEnabled, type Thread } from "./store";

/** Satz für einen Faden; ohne doppelten Satzpunkt nach einem Fragezeichen */
function sentence(thread: Pick<Thread, "topic" | "question">): string {
  const question = thread.question.trim();
  const end = /[.?!…]$/u.test(question) ? "" : ".";
  return `Du hast den Nutzer an eine offene Frage erinnert: ${thread.topic.trim()}: ${question}${end} Seine Nachricht kann die Antwort darauf sein.`;
}

/** Text des Hinweises, je Faden ein Satz; undefined ohne Fäden */
export function reminderHintText(threads: Pick<Thread, "topic" | "question">[]): string | undefined {
  return threads.length ? threads.map(sentence).join("\n") : undefined;
}

/** Hinweise verbinden (etwa Sprech-Turn und Faden); undefined, wenn keiner da ist */
export function joinTurnHints(...hints: (string | undefined)[]): string | undefined {
  const parts = hints.map(h => h?.trim()).filter((h): h is string => !!h);
  return parts.length ? parts.join("\n\n") : undefined;
}

export interface ThreadHintDeps {
  env?: Record<string, string | undefined>;
  take?: (conversation: ChoiceConversation) => Promise<Thread[]>;
  log?: (line: string) => void;
}

/** Holt den Hinweis eines Gesprächs einmal ab (siehe oben); wirft nie */
export async function takeThreadTurnHint(conversation: ChoiceConversation | null, deps: ThreadHintDeps = {}): Promise<string | undefined> {
  if (!conversation || !threadsEnabled(deps.env ?? process.env)) return undefined;
  try {
    return reminderHintText(await (deps.take ?? realTake)(conversation));
  } catch {
    (deps.log ?? (line => console.log(line)))(`[threads] kein Hinweis für Gespräch ${conversationKey(conversation)} (fehler)`);
    return undefined;
  }
}
