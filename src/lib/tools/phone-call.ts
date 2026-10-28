/**
 * Werkzeug phone_call (Issue #367, Entscheidung E9): das Modell ruft den
 * Nutzer über das Telefonnetz an. Name wie im alten API-Prozessor, damit der
 * Motor api (#348) es über die Registry bekommt; Fallback-Modelle sehen es
 * ebenfalls.
 *
 * - Angeboten nur mit eingerichteten Anrufen (phoneConfigured) und gesetztem
 *   Anrufdienst; den setzt src/bot.ts beim Start (setPhoneCallService), es ist
 *   dieselbe Instanz wie für /anruf.
 * - Ein Anruf kostet Geld und kommt vom Modell, nicht vom Nutzer: erst nach
 *   Freigabe über das gemeinsame Tor (requiresApproval, src/lib/tool-approval.ts).
 * - Zusammenfassung und Rückfrage gehen in das Gespräch der Ausführung
 *   (conversationForExecution). Ohne erkennbares Gespräch gibt es keine
 *   Freigabe und keinen Anruf; einen Rückfall auf den Direktchat gibt es nicht.
 */

import { currentExecution } from "../execution-context";
import type { PhoneAccess } from "../phone/access";
import { phoneConfigured } from "../phone/provider";
import { conversationForExecution } from "../tool-approval";
import { registerBuiltinTool } from "./registry";

export const PHONE_CALL_TOOL = "phone_call";

let service: PhoneAccess | null = null;

/** Anrufdienst des Bots einhängen (null: Werkzeug nicht verfügbar) */
export function setPhoneCallService(next: PhoneAccess | null): void {
  service = next;
}

registerBuiltinTool({
  name: PHONE_CALL_TOOL,
  description:
    "Call the user on their phone (voice call over the phone network). Use only when the user asks to be called or something is urgent enough to justify a call. The call summary arrives in this conversation afterwards.",
  inputSchema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Short reason for the call, spoken in the first sentence (optional)",
      },
    },
  },
  requiresApproval: true,
  isAvailable: () => service !== null && phoneConfigured(),
  handler: async args => {
    const phone = service;
    if (!phone) return JSON.stringify({ success: false, error: "Anrufe sind in diesem Prozess nicht verfügbar" });
    const conversation = conversationForExecution(currentExecution()?.key);
    if (!conversation) return JSON.stringify({ success: false, error: "Kein Gespräch erkennbar, kein Anruf" });
    const reason = typeof args.reason === "string" ? args.reason : "";
    const result = await phone.call(reason, conversation);
    return JSON.stringify({ success: result.ok, message: result.message });
  },
});
