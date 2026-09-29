/**
 * Tor fuer Merk-Tags aus einem Turn (Issue #53, Entscheidung 0008 Punkt 2).
 *
 * Hat der Turn fremde Inhalte gelesen (Web, Mail, lesende MCP-Werkzeuge,
 * Dateien ausserhalb des Projekts, siehe turn-tools.ts), werden seine
 * [REMEMBER:]/[GOAL:]/[FORGET:]/[DONE:]/[CANCEL:] nicht angewendet, sondern
 * als Vorschlag mit Knoepfen gestellt (derselbe Weg wie der Session-Review,
 * data/pending-reviews.json). Das gilt immer, auch ohne Zustellweg und bei
 * DISTILL_AUTO_APPLY=true. Ohne fremde Inhalte wie bisher direkt; mit
 * unbekannter Werkzeugliste ebenfalls direkt, aber mit Log-Zeile.
 *
 * Der Knopf "Uebernehmen" wendet einen bereits bestaetigten Vorschlag an
 * (decideReview), der laeuft bewusst nicht noch einmal durch dieses Tor.
 * Zustellung und Knoepfe: Rueckfragen-Register (review-choices.ts, Issue #117).
 */

import { processIntents as applyIntents, type ProcessedIntents } from "./memory";
import { stageMemoryReview, takePendingReview, type PendingReview } from "./session-distill";
import type { BotSession } from "./session-manager";
import { classifyTurnTools, type TurnTools } from "./turn-tools";
import { dmChatId, isWebChatId } from "./channels";

const PROJECT_ROOT = process.cwd();

export interface IntentTarget {
  /**
   * Chat des Turns. web:<id> (reines Web-Gespraech, Issue #117): Vorschlag im
   * Web-Gespraech, Kopie im Direktchat. web (Web-Direktchat ohne Telegram,
   * Issue #227): Vorschlag dort. Sonst ohne Telegram-ID: in den Direktchat
   */
  chatId: string;
  topicId?: number;
  /** Herkunft fuer Nachricht und Log, z.B. "Telegram", "Web-Gespraech", "Sprach-Bruecke" */
  origin: string;
  /**
   * Der Turn verarbeitete fremde Inhalte, die nicht in der Werkzeugliste
   * stehen (hochgeladene Datei, Foto, Video): Grund fuer die Einstufung.
   */
  foreignInput?: string;
}

export interface IntentGateDeps {
  processIntents(text: string): Promise<unknown>;
  stageMemoryReview: typeof stageMemoryReview;
  log(line: string): void;
  projectRoot: string;
  /**
   * Direktchat fuer Vorschlaege aus Chats ohne Telegram-ID: mit Telegram die
   * Nutzer-ID, ohne Telegram "web" (Kanal-Weiche, channels.ts)
   */
  dmChatId(): string | undefined;
}

const defaultDeps: IntentGateDeps = {
  processIntents: applyIntents,
  stageMemoryReview,
  log: line => console.log(line),
  projectRoot: PROJECT_ROOT,
  dmChatId: () => dmChatId(process.env),
};

const INTENT_TAG = /\[(?:REMEMBER|GOAL|DONE|CANCEL|FORGET):[^\]]*\]/gi;
const TELEGRAM_CHAT_ID = /^-?\d{1,20}$/;

/** Nur die Intent-Tags eines Texts, je Zeile einer; leer ohne Tags. */
export function extractIntentTags(text: string): string {
  return (text.match(INTENT_TAG) ?? []).join("\n");
}

export type IntentOutcome = "none" | "applied" | "staged";

/**
 * Merk-Tags einer Turn-Antwort verarbeiten. tools undefined heisst unbekannt.
 * Wirft nie wegen des Stagings: scheitert das Ablegen, wird nichts angewendet.
 */
export async function processTurnIntents(
  text: string,
  tools: TurnTools | undefined,
  target: IntentTarget,
  deps?: Partial<IntentGateDeps>
): Promise<IntentOutcome> {
  const d = deps ? { ...defaultDeps, ...deps } : defaultDeps;
  const tags = extractIntentTags(text);
  if (!tags) return "none";

  const verdict = classifyTurnTools(tools, d.projectRoot);
  const reasons = [
    ...(target.foreignInput ? [target.foreignInput] : []),
    ...(verdict.status === "foreign" ? verdict.reasons : []),
  ];

  if (reasons.length > 0) {
    const telegramChat = TELEGRAM_CHAT_ID.test(target.chatId);
    const webChat = isWebChatId(target.chatId);
    const chatId = telegramChat || webChat ? target.chatId : d.dmChatId() || target.chatId;
    const topicId = telegramChat ? target.topicId : undefined;
    const where = telegramChat ? "" : ` (${target.origin})`;
    try {
      const id = await d.stageMemoryReview({
        chatId,
        topicId,
        tags,
        header:
          `🧠 Merk-Vorschlag${where} aus einem Turn mit fremden Inhalten (${reasons.join(", ")}). ` +
          `Nichts ist gespeichert, bis du zustimmst:`,
        origin: `${target.origin}: fremde Inhalte (${reasons.join(", ")})`,
      });
      d.log(
        id
          ? `[Intents] ${target.origin}: Merk-Tags aus Turn mit fremden Inhalten als Vorschlag ${id} abgelegt (${reasons.join(", ")})`
          : `[Intents] ${target.origin}: Merk-Tags aus Turn mit fremden Inhalten nicht lesbar, verworfen`
      );
    } catch (err) {
      d.log(`[Intents] ${target.origin}: Vorschlag nicht abgelegt, Merk-Tags verworfen (${err instanceof Error ? err.name : "Fehler"})`);
    }
    return "staged";
  }

  if (verdict.status === "unknown") {
    d.log(`[Intents] ${target.origin}: Werkzeuge des Turns unbekannt, Merk-Tags wie bisher direkt angewendet`);
  }
  await d.processIntents(text);
  return "applied";
}

// ---------------------------------------------------------------------------
// Antwort auf die Knoepfe (Aktion "ok", "no", "routine"; Register oder alte rev|-Knoepfe)
// ---------------------------------------------------------------------------

export type ReviewDecision =
  | { kind: "expired" }
  | { kind: "discarded"; review: PendingReview }
  | { kind: "applied"; text: string; review: PendingReview }
  | { kind: "routine"; review: PendingReview; session: BotSession };

export interface ReviewDecisionDeps {
  takePendingReview: typeof takePendingReview;
  processIntents(text: string): Promise<ProcessedIntents>;
}

/** Zusammenfassung nach dem Uebernehmen, alle fuenf Tag-Arten */
export function describeApplied(p: ProcessedIntents): string {
  const parts = [
    `${p.factsAdded.length} Fakt(en)`,
    `${p.goalsAdded.length} Ziel(e)`,
    ...(p.factsRemoved.length ? [`${p.factsRemoved.length} Fakt(en) vergessen`] : []),
    ...(p.goalsCompleted.length ? [`${p.goalsCompleted.length} Ziel(e) erledigt`] : []),
    ...(p.goalsCancelled.length ? [`${p.goalsCancelled.length} Ziel(e) gestrichen`] : []),
  ];
  return `✅ Übernommen: ${parts.join(", ")}.`;
}

/**
 * Knopfdruck auf einen Vorschlag. Der Vorschlag wird genau einmal
 * herausgenommen: ein zweiter Klick (oder ein Klick nach Ablauf, 7 Tage)
 * bekommt "expired". Uebernehmen wendet die Tags direkt an, sie sind bestaetigt.
 */
export async function decideReview(
  action: string,
  reviewId: string,
  deps: ReviewDecisionDeps = { takePendingReview, processIntents: applyIntents }
): Promise<ReviewDecision> {
  const review = await deps.takePendingReview(reviewId);
  if (!review) return { kind: "expired" };
  if (action === "ok" && review.tags) {
    const processed = await deps.processIntents(review.tags);
    return { kind: "applied", text: describeApplied(processed), review };
  }
  if (action === "routine" && review.session) return { kind: "routine", review, session: review.session };
  return { kind: "discarded", review };
}
