/**
 * Eingang des WhatsApp-Kanals (Issue #345): verteilt eine geprüfte Nachricht
 * auf Gruppenbefehl, Gruppe, Direktnachricht des Besitzers oder Gast.
 *
 * Grenze zwischen Besitzer und Gästen: Nur eine Direktnachricht (auch /dm aus
 * einer Gruppe) von der Besitzernummer erreicht den Chat-Kern samt Gedächtnis.
 * Gäste und jede Gruppe, auch eine Nachricht des Besitzers dort, gehen an
 * den Gäste-Assistenten (answerGuest, src/lib/guest-assistant.ts) mit seinem
 * eigenen Verlauf; ihre Antworten setzen keine Merk-Tags um.
 */
import { ABORT_REPLY, SHUTDOWN_ABORT_REPLY } from "../../lib/chat-turn";
import { sessionKeyFor } from "../../lib/store/message-rules";
import { stripControlTags } from "../../web/markdown";
import { bareNumber, type WhatsAppSender } from "./twilio";
import { whatsAppChatId } from "./owner-turn";

/** Fehlerantworten an den Absender, wörtlich wie vor der Umstellung (Gäste und Gruppen sehen sie unverändert) */
export const WHATSAPP_TEXT = {
  directFailed: "Sorry, something went wrong processing your message. Please try again.",
  groupFailed: "Sorry, I couldn't process that. Try again.",
} as const;

/** Gruppe aus config/whatsapp-groups.json, wie findGroupForNumber sie liefert */
export interface WhatsAppGroupMatch {
  groupId: string;
  group: { name: string; members: Record<string, string> };
  senderName: string;
}

export interface WhatsAppGroups {
  find(number: string): WhatsAppGroupMatch | null;
  /** Frage an den Bot (/ask, /frag, @tybo), sonst null */
  botQuestion(body: string): { question: string } | null;
  /** /dm aus einer Gruppe, sonst null */
  directPart(body: string): { message: string } | null;
  /** Antwort auf /group … */
  command(number: string, body: string): string;
}

export interface WhatsAppGuest {
  answer(scope: string, text: string): Promise<string>;
  save(scope: string, role: "user" | "assistant", content: string): void;
}

export interface WhatsAppInboundDeps {
  sender: WhatsAppSender;
  isOwner(number: string): boolean;
  /** Besitzer-Turn (createOwnerTurn); Antwort oder ABORT_REPLY */
  ownerTurn(number: string, text: string): Promise<string>;
  guest: WhatsAppGuest;
  groups: WhatsAppGroups;
  /** Warteschlange je Gespräch für Gäste-Antworten (runExecution) */
  queue<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Name vor Bot-Antworten in Gruppen */
  botName: string;
  isShuttingDown(): boolean;
  log?(line: string): void;
}

const failureName = (err: unknown) => (err instanceof Error ? err.name : "Fehler");

export function createWhatsAppInbound(deps: WhatsAppInboundDeps): (from: string, body: string) => Promise<void> {
  const log = deps.log ?? (line => console.log(line));

  async function guestReply(scope: string, question: string): Promise<string> {
    return deps.queue(sessionKeyFor(scope, null), () => deps.guest.answer(scope, question));
  }

  async function direct(from: string, number: string, text: string): Promise<void> {
    try {
      if (deps.isOwner(number)) {
        const reply = await deps.ownerTurn(number, text);
        if (reply === ABORT_REPLY) {
          await deps.sender.sendOne(from, deps.isShuttingDown() ? SHUTDOWN_ABORT_REPLY : ABORT_REPLY);
          return;
        }
        const visible = stripControlTags(reply);
        if (visible) await deps.sender.send(from, visible);
        return;
      }
      const scope = whatsAppChatId(number);
      deps.guest.save(scope, "user", text);
      const reply = await guestReply(scope, text);
      deps.guest.save(scope, "assistant", reply);
      await deps.sender.send(from, reply);
    } catch (err) {
      log(`[WhatsApp] Direktnachricht gescheitert (${failureName(err)})`);
      await deps.sender.sendOne(from, WHATSAPP_TEXT.directFailed);
    }
  }

  async function inGroup(from: string, number: string, text: string, match: WhatsAppGroupMatch): Promise<void> {
    const scope = whatsAppChatId(`group:${match.groupId}`);
    const signed = `[${match.senderName}]: ${text}`;
    deps.guest.save(scope, "user", signed);
    const others = Object.keys(match.group.members).filter(member => member !== number);
    for (const member of others) await deps.sender.sendOne(member, signed);

    const ask = deps.groups.botQuestion(text);
    if (!ask) return;
    try {
      const reply = await guestReply(scope, ask.question);
      deps.guest.save(scope, "assistant", reply);
      for (const member of Object.keys(match.group.members)) await deps.sender.send(member, `[${deps.botName}]: ${reply}`);
    } catch (err) {
      log(`[WhatsApp] Gruppenfrage gescheitert (${failureName(err)})`);
      await deps.sender.sendOne(from, WHATSAPP_TEXT.groupFailed);
    }
  }

  return async (from, body) => {
    const number = bareNumber(from);
    // Wie bisher: alles, was mit /group beginnt, ist ein Gruppenbefehl
    if (body.trim().slice(0, 6).toLowerCase() === "/group") {
      await deps.sender.send(from, deps.groups.command(number, body));
      return;
    }
    const match = deps.groups.find(number);
    if (!match) return direct(from, number, body);
    const privately = deps.groups.directPart(body);
    if (privately) return direct(from, number, privately.message);
    return inGroup(from, number, body, match);
  };
}
