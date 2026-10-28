/**
 * Turn des Besitzers über WhatsApp (Issue #345): derselbe Chat-Kern wie in
 * Telegram und der WebUI (src/lib/chat-turn.ts), kein eigener Prompt mehr.
 *
 * Ablauf eines Turns:
 *   - Nachricht im Verlauf speichern (Gespräch wa:<Nummer>), damit der Kern
 *     sie im Gesprächskontext sieht
 *   - JSON-Turn des Chat-Kerns mit dem Agenten General, ausdrücklich mit dem
 *     Motor Claude (Entscheidung 0018: kein stiller Wechsel auf den Motor des
 *     Gesprächs), in der Warteschlange unter sessionKeyFor; derselbe Schlüssel
 *     ist der Abbruch-Schlüssel des Kerns
 *   - der WhatsApp-Hinweis hängt als turnHint an jedem Prompt des Turns, auch
 *     nach einem neuen Versuch und an der Frage für die Fallback-Kette
 *   - Antwort speichern und ihre Merk-Tags genau einmal durchs Tor
 *     (intent-gate.ts): mit fremden Inhalten nur als Vorschlag
 * Ein abgebrochener Turn (Beenden des Gateways) wird nicht gespeichert und
 * liefert ABORT_REPLY; was der Nutzer dann liest, entscheidet der Eingang.
 *
 * Sessions bleiben aus: das Gateway ist ein eigener Prozess, und
 * session-manager.ts schreibt data/sessions.json als Ganzes aus seinem
 * Prozess-Speicher. Mit SESSION_MODE=resume würden Gateway und Bot einander
 * die Sessions überschreiben. Zusammenhang kommt wie bisher aus Verlauf,
 * Gedächtnis und Suche.
 */
import { ABORT_REPLY, type ChatTurnDeps, type TurnOptions } from "../../lib/chat-turn";
import { isAbortError } from "../../lib/execution-context";
import type { IntentTarget } from "../../lib/intent-gate";
import { sessionKeyFor } from "../../lib/store/message-rules";
import type { Message } from "../../lib/store/types";
import { turnInfoCollector } from "../../lib/turn-collector";
import type { TurnTools } from "../../lib/turn-tools";

/** Agent für WhatsApp, wie bisher */
export const WHATSAPP_AGENT = "general";

/** Kanal-Hinweis an jedem Prompt eines WhatsApp-Turns */
export const WHATSAPP_TURN_HINT = "Kanal WhatsApp: Antworte kurz und mobilfreundlich.";

/** Herkunft für Merk-Vorschläge und Log */
export const WHATSAPP_ORIGIN = "WhatsApp";

/** Gespräch einer Nummer im Verlauf; Schnittstelle zu gespeicherten Nachrichten */
export const whatsAppChatId = (number: string) => `wa:${number}`;

/** Abweichungen vom Chat-Kern für das Gateway: keine Sessions (siehe oben) */
export const GATEWAY_CORE_DEPS: Partial<ChatTurnDeps> = {
  isSessionModeEnabled: () => false,
};

export interface OwnerTurnDeps {
  /** JSON-Turn des Chat-Kerns (runJsonTurn in src/lib/chat-turn.ts) */
  runJsonTurn(opts: TurnOptions): Promise<string>;
  /** Warteschlange je Gespräch (runExecution in src/lib/execution-context.ts) */
  runExecution<T>(key: string, agent: string, fn: () => Promise<T>, allowedTools?: string[]): Promise<T>;
  saveMessage(message: Message): Promise<unknown>;
  /** Merk-Tags durchs Tor (processTurnIntents in src/lib/intent-gate.ts) */
  processIntents(response: string, tools: TurnTools | undefined, target: IntentTarget): Promise<unknown>;
  /** Hinweis des Kerns an den Besitzer (läuft lange, Zeitlimit) */
  notice(number: string, text: string): Promise<unknown>;
  /** Werkzeuge des Agenten für die Warteschlange */
  allowedTools?(agent: string): string[] | undefined;
  /** Abweichende Abhängigkeiten des Kerns; Standard GATEWAY_CORE_DEPS */
  coreDeps?: Partial<ChatTurnDeps>;
}

/** Liefert die Antwort des Besitzer-Turns oder ABORT_REPLY; andere Fehler werfen */
export function createOwnerTurn(deps: OwnerTurnDeps): (number: string, text: string) => Promise<string> {
  const agent = WHATSAPP_AGENT;
  return async (number, text) => {
    const chatId = whatsAppChatId(number);
    await deps.saveMessage({ chat_id: chatId, role: "user", content: text, metadata: { channel: "whatsapp", from: number } });

    const collector = turnInfoCollector();
    let reply: string;
    try {
      reply = await deps.runExecution(
        sessionKeyFor(chatId, null),
        agent,
        () =>
          deps.runJsonTurn({
            userMessage: text,
            chatId,
            agentName: agent,
            engine: "claude",
            turnHint: WHATSAPP_TURN_HINT,
            sink: { progress() {}, notice: hint => void deps.notice(number, hint).catch(() => {}) },
            onInfo: collector.onInfo,
            onTools: collector.onTools,
            deps: deps.coreDeps ?? GATEWAY_CORE_DEPS,
          }),
        deps.allowedTools?.(agent)
      );
    } catch (err) {
      if (isAbortError(err)) return ABORT_REPLY;
      throw err;
    }
    if (reply === ABORT_REPLY) return reply;

    await deps.saveMessage({
      chat_id: chatId,
      role: "assistant",
      content: reply,
      metadata: { channel: "whatsapp", agent, ...collector.metadata() },
    });
    await deps.processIntents(reply, collector.tools(), { chatId, origin: WHATSAPP_ORIGIN });
    return reply;
  };
}
