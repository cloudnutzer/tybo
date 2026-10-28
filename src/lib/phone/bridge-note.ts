/**
 * Anlass eines ausgehenden Anrufs für die Sprach-Brücke (Issue #366).
 *
 * Die Brücke ist ein eigener Prozess. Sie erkennt den Anruf an zwei Headern,
 * die bei ElevenLabs unter custom_llm.request_headers eingetragen werden:
 *   x-voice-call-ref        Wert {{tybo_call_ref}}: eigene Kennung, die
 *                           startCall als dynamische Variable mitgibt
 *   x-voice-conversation-id Wert {{system__conversation_id}}: Kennung beim
 *                           Anbieter
 * Gesucht wird erst nach der eigenen Kennung (steht in der Anrufliste, bevor
 * das Telefon klingelt), dann nach der Kennung beim Anbieter. Nicht
 * aufgelöste Platzhalter ("{{...}}") gelten als fehlend. Ohne Treffer kein
 * Hinweis: dann ist es ein eingehender Anruf oder die Header fehlen.
 *
 * Der Hinweis wird je Turn frisch gelesen, nicht im zehnminütigen
 * Kontext-Cache der Brücke gehalten.
 */

import type { PhoneLedger } from "./ledger";

export const CALL_REF_HEADER = "x-voice-call-ref";
export const CONVERSATION_ID_HEADER = "x-voice-conversation-id";
/** Länge des Anlasses im Hinweis */
export const NOTE_REASON_CHARS = 1_000;

export interface CallIds {
  ref?: string;
  conversationId?: string;
}

function cleanId(raw: string | null | undefined): string | undefined {
  const value = raw?.trim() ?? "";
  if (!value || value.includes("{{") || value.length > 200) return undefined;
  return value;
}

/** Kennungen des Anrufs aus den Request-Headern */
export function callIdsFrom(headers: Headers): CallIds {
  const ids: CallIds = {};
  const ref = cleanId(headers.get(CALL_REF_HEADER));
  const conversationId = cleanId(headers.get(CONVERSATION_ID_HEADER));
  if (ref) ids.ref = ref;
  if (conversationId) ids.conversationId = conversationId;
  return ids;
}

/** Hinweis für den Systemprompt, null ohne bekannten Anruf */
export function callNote(ledger: PhoneLedger, ids: CallIds): string | null {
  const call = (ids.ref ? ledger.get(ids.ref) : undefined) ?? (ids.conversationId ? ledger.byConversationId(ids.conversationId) : undefined);
  if (!call) return null;
  const reason = call.reason.replace(/\s+/g, " ").trim().slice(0, NOTE_REASON_CHARS);
  return reason
    ? `Anlass dieses Gesprächs: Du hast den Nutzer angerufen, weil: ${reason}\nGeh auf diesen Anlass ein, falls er noch nicht besprochen ist.`
    : "Anlass dieses Gesprächs: Du hast den Nutzer ohne besonderen Anlass angerufen, um dich kurz zu melden.";
}
