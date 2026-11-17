/**
 * Dynamische Variablen für den Sprachagenten beim Anruf (Issue #366).
 *
 * Die Namen sind Schnittstelle zum bei ElevenLabs hinterlegten Agenten und
 * bleiben: user_name, current_time, call_reason, memory, recent_telegram.
 * Gedächtnis und letzte Nachrichten kommen aus dem Speicher (ohne Datenbank
 * leer); scheitert das Lesen, steht ein Platzhalter da, der Anruf geht
 * trotzdem raus. Gekürzt wird das Gedächtnis nur um ganze Einträge, der
 * Vorbehalt zu den Daten der Fakten bleibt (Issue #519).
 */

import { fitMemoryContext } from "../memory/context";
import type { CallRecord } from "./ledger";

export const MEMORY_MAX_CHARS = 1_000;
export const RECENT_MAX_CHARS = 2_000;
const RECENT_COUNT = 10;
const RECENT_LINE_CHARS = 200;

const EMPTY = {
  memory: "No stored memory available. Start fresh.",
  recent: "No recent messages. This is a new conversation.",
  reason: "general check-in",
};

export interface CallContextSource {
  memory(): Promise<string>;
  recent(chatId: string, limit: number): Promise<{ role: string; content: string }[]>;
  timeZone?: string;
  now?: () => Date;
}

/** Chat, dessen letzte Nachrichten mitgehen: das Zielgespräch des Anrufs */
function chatOf(call: Pick<CallRecord, "conversation">): string | null {
  return call.conversation.type === "telegram" ? call.conversation.chatId : null;
}

export async function callVariables(call: Pick<CallRecord, "reason" | "userName" | "conversation">, source: CallContextSource): Promise<Record<string, string>> {
  const clock = (source.now ?? (() => new Date()))().toLocaleString("en-US", {
    timeZone: source.timeZone || "UTC",
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  let memory = "";
  let recent = "";
  try {
    memory = fitMemoryContext(await source.memory(), MEMORY_MAX_CHARS);
  } catch {
    // Platzhalter unten
  }
  const chatId = chatOf(call);
  if (chatId) {
    try {
      const messages = await source.recent(chatId, RECENT_COUNT);
      recent = messages
        .map(m => `${m.role === "user" ? call.userName : "Bot"}: ${m.content.slice(0, RECENT_LINE_CHARS)}`)
        .join("\n")
        .slice(0, RECENT_MAX_CHARS);
    } catch {
      // Platzhalter unten
    }
  }
  return {
    user_name: call.userName,
    current_time: clock,
    call_reason: call.reason || EMPTY.reason,
    memory: memory || EMPTY.memory,
    recent_telegram: recent || EMPTY.recent,
  };
}
