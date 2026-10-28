/**
 * Text, den Prompts aus gespeicherten Nachrichten bekommen (Issue #309):
 * der Gesprächskontext ("[vor wann] Sprecher: Text") und der Überblick für
 * /board. Eine Fassung für alle Speicher; vorher stand der Kontext doppelt
 * in der früheren Fassade und in supabase.ts.
 *
 * Der Wortlaut ist englisch, weil die Prompts ihn seit jeher so bekommen;
 * Änderungen daran ändern, was das Modell sieht.
 */
import { withoutDisplayOnly } from "./store/message-rules";
import type { MessageStore } from "./store/ports";
import type { BoardRow, Message } from "./store/types";
import { relativeTime } from "./when";

/** Antworten von tybo im Kontext höchstens so lang */
export const CONTEXT_ASSISTANT_MAX_CHARS = 800;
/**
 * Nutzernachrichten höchstens so lang (die frühere Grenze der WebUI): eine
 * Nachricht mit 200.000 Zeichen stünde sonst in den nächsten zehn Prompts
 * noch einmal ganz.
 */
export const CONTEXT_USER_MAX_CHARS = 20_000;

/** /board: Beiträge je Topic und Länge der Vorschau */
export const BOARD_PER_CHANNEL = 15;
export const BOARD_PREVIEW_CHARS = 200;

export const BOARD_EMPTY = "\n\nNo recent conversations across topics.";
/** /board ohne Datenbank bzw. wenn das Laden wirft (Issue #314, Wortlaut wie bisher) */
export const BOARD_NO_DATA = "\n\nNo conversation data available.";
export const BOARD_LOAD_FAILED = "\n\nFailed to load conversation context.";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Schneidet nach `max` Zeichen ab und hängt dann "..." an */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/**
 * Alter eines Zeitpunkts auf Englisch ("just now", "5 minutes ago"); ab
 * 30 Tagen und bei ungültigem Zeitpunkt das Datum im Format des Systems,
 * wie es Prompts schon immer bekommen.
 */
function ageLabel(createdAt: string | undefined, now: Date): string {
  if (!createdAt) return "";
  const date = new Date(createdAt);
  const age = now.getTime() - date.getTime();
  if (Number.isNaN(age) || age >= THIRTY_DAYS_MS) return date.toLocaleDateString();
  return relativeTime(date, { now, locale: "en" });
}

/**
 * Gesprächskontext aus Nachrichten (älteste zuerst), eine Zeile je
 * Nachricht: "[2 minutes ago] User: ..." bzw. "Bot: ...". Lange Inhalte
 * werden gekürzt (siehe oben). Keine Nachrichten: leerer Text.
 */
export function formatConversationContext(
  messages: Pick<Message, "role" | "content" | "created_at">[],
  now: Date = new Date()
): string {
  const lines = messages.map(message => {
    const assistant = message.role === "assistant";
    const speaker = message.role === "user" ? "User" : "Bot";
    const text = clip(message.content, assistant ? CONTEXT_ASSISTANT_MAX_CHARS : CONTEXT_USER_MAX_CHARS);
    return `[${ageLabel(message.created_at, now)}] ${speaker}: ${text}`;
  });
  return lines.join("\n");
}

/** Zeile, die /board braucht; Rohzeilen aus jedem Speicher passen */
type BoardInput = Pick<BoardRow, "role" | "content"> & { metadata?: unknown };

/** Kanal einer Zeile: "topic_<thread_id>" oder "general" */
function channelOf(metadata: unknown): string {
  const thread = metadata && typeof metadata === "object" ? (metadata as { thread_id?: unknown }).thread_id : undefined;
  return thread ? `topic_${thread}` : "general";
}

/**
 * Überblick für /board aus Rohzeilen (neueste zuerst): je Kanal die ersten
 * 15 Beiträge mit Vorschau, Meldungen fallen heraus. Ohne Beiträge ein
 * fester Hinweis (BOARD_EMPTY).
 */
export function formatBoardContext(rows: BoardInput[], days: number): string {
  const channels = new Map<string, string[]>();
  for (const row of withoutDisplayOnly(rows)) {
    const name = channelOf(row.metadata);
    const lines = channels.get(name) ?? [];
    if (lines.length >= BOARD_PER_CHANNEL) continue;
    const who = row.role === "user" ? "User" : "Agent";
    lines.push(`- ${who}: ${clip(row.content, BOARD_PREVIEW_CHARS)}`);
    channels.set(name, lines);
  }
  if (channels.size === 0) return BOARD_EMPTY;

  const head = `\n\n## BOARD MEETING CONTEXT (Last ${days} days)\nReview of conversations across all agents:\n\n`;
  const blocks = [...channels].map(([name, lines]) => `### ${name}\n${lines.join("\n")}\n\n`);
  return head + blocks.join("");
}

/**
 * /board-Kontext aus dem Nachrichtenspeicher (Issue #314). messages null:
 * keine Datenbank, fester Hinweis BOARD_NO_DATA. Wirft das Laden, kommt
 * BOARD_LOAD_FAILED statt eines Fehlers.
 */
export async function loadBoardContext(messages: Pick<MessageStore, "boardRows"> | null, days: number): Promise<string> {
  if (!messages) return BOARD_NO_DATA;
  try {
    return formatBoardContext(await messages.boardRows(days), days);
  } catch {
    return BOARD_LOAD_FAILED;
  }
}
