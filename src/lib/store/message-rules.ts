/**
 * Regeln für Nachrichten, die jeder Adapter gleich anwendet (Issue #309):
 * Sitzungsschlüssel, Topic aus den Metadaten, Meldungen erkennen und der
 * Ablauf rund ums Speichern (msgId, Zeitpunkt, Ereignis). Unabhängig von
 * Supabase, damit der Datei-Adapter (#316) dieselben Regeln nutzt.
 */
import { acceptedCreatedAt } from "../../../supabase/functions/_shared/created-at";
import { emitMessageSaved } from "./events";
import type { Message } from "./types";

/**
 * Schlüssel, unter dem eine Sitzung ihre Nachrichten findet
 * (docs/topic-sessions.md): Web-Gespräche ("web:<ID>") sind schon der
 * Schlüssel; mit Topic-Nummer "topic:<chat>:<topic>", sonst "group:<chat>"
 * für Gruppen (negative IDs) und "dm:<chat>" für den Direktchat.
 */
export function sessionKeyFor(chatId: string, topicId?: number | null): string {
  if (chatId.startsWith("web:")) return chatId;
  if (typeof topicId === "number") return `topic:${chatId}:${topicId}`;
  const kind = chatId.startsWith("-") ? "group" : "dm";
  return `${kind}:${chatId}`;
}

/** metadata.topicId, wenn es eine Zahl ist; Text, null oder fehlend ergeben null */
export function topicOf(metadata: Message["metadata"]): number | null {
  const value = metadata?.topicId;
  return typeof value === "number" ? value : null;
}

/** Meldung (Entscheidung 0006) nur bei metadata.display_only === true, als JSON-Boolean */
export function isDisplayOnly(metadata: unknown): boolean {
  if (metadata === null || typeof metadata !== "object") return false;
  return (metadata as { display_only?: unknown }).display_only === true;
}

/** Interne Job-Eingabe: Kontext beim Motorwechsel, aber keine Nutzeraussage oder zweite Browserblase. */
export function isJobReport(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const report = (metadata as { job_report?: unknown }).job_report;
  return report !== null && typeof report === "object";
}

export function withoutJobReports<T extends { metadata?: unknown }>(rows: T[]): T[] {
  return rows.filter(row => !isJobReport(row.metadata));
}

/** Wirft Meldungen aus einer Trefferliste, als Sicherung nach der Abfrage */
export function withoutDisplayOnly<T extends { metadata?: unknown }>(rows: T[]): T[] {
  return rows.filter(row => !isDisplayOnly(row?.metadata));
}

function hasMsgId(metadata: Record<string, unknown>): boolean {
  const id = metadata.msgId;
  return id !== undefined && id !== null && id !== "";
}

/**
 * Speichert über `write` und meldet die Nachricht danach genau einmal an
 * die Zuhörer aus events.ts, nur wenn `write` true liefert. Vorher bekommt
 * metadata eine msgId (UUID), falls keine da ist; eine vorhandene (etwa
 * "web-<uuid>" aus der WebUI) bleibt. Ein ungültiges oder zukünftiges
 * created_at wird gar nicht erst weitergegeben (Issue #69); das Ereignis
 * trägt dann den Moment nach dem Speichern. Wirft `write`, kommt der Fehler
 * beim Aufrufer an und es gibt kein Ereignis. Die Nachricht des Aufrufers
 * bleibt unverändert.
 */
export async function saveAndAnnounce(
  message: Message,
  write: (prepared: Message) => Promise<boolean>
): Promise<boolean> {
  const metadata: Record<string, unknown> = { ...message.metadata };
  if (!hasMsgId(metadata)) metadata.msgId = crypto.randomUUID();
  const createdAt = acceptedCreatedAt(message.created_at);
  const prepared: Message = { ...message, metadata };
  delete prepared.created_at;
  if (createdAt) prepared.created_at = createdAt;

  const ok = await write(prepared);
  if (ok !== true) return ok;
  emitMessageSaved({
    chatId: prepared.chat_id,
    role: prepared.role,
    content: prepared.content,
    metadata,
    createdAt: createdAt ?? new Date().toISOString(),
  });
  return true;
}
