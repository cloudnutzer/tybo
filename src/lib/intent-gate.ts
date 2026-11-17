/**
 * Tor fuer Merk-Tags aus einem Turn (Issue #53, Entscheidung 0008 Punkt 2).
 *
 * Hat der Turn fremde Inhalte gelesen (Web, Mail, lesende MCP-Werkzeuge,
 * curl und Co., gh gegen fremde oder unklare Repos, siehe turn-tools.ts;
 * Dateien auf diesem Rechner zaehlen seit Issue #525 nicht mehr), werden seine
 * [REMEMBER:]/[GOAL:]/[FORGET:]/[DONE:]/[CANCEL:]/[KNOWLEDGE:] (#317)/[REMIND:] (#322) nicht angewendet, sondern
 * als Vorschlag mit Knoepfen gestellt (derselbe Weg wie der Session-Review,
 * data/pending-reviews.json). Das gilt immer, auch ohne Zustellweg und bei
 * DISTILL_AUTO_APPLY=true. Ohne fremde Inhalte wie bisher direkt; mit
 * unbekannter Werkzeugliste ebenfalls direkt, aber mit Log-Zeile.
 *
 * Erinnerungen im Vorschlag (#322): jede Zeitangabe wird beim Ablegen in
 * einen festen Zeitpunkt umgerechnet (fixReminderTimes), "in 2 Stunden"
 * zaehlt also ab der Antwort, nicht ab der Zustimmung; ein REMIND mit
 * unlesbarer Zeit faellt weg und legt auch spaeter nichts an.
 *
 * Der Knopf "Uebernehmen" wendet einen bereits bestaetigten Vorschlag an
 * (decideReview), der laeuft bewusst nicht noch einmal durch dieses Tor.
 * Zustellung und Knoepfe: Rueckfragen-Register (review-choices.ts, Issue #117).
 *
 * Angewendet wird immer mit dem Gespraech des Turns bzw. des Vorschlags
 * (Issue #316): treffen DONE, CANCEL oder FORGET mehrere Eintraege, kommt
 * die Auswahl als Rueckfrage dorthin (memory/choices.ts), nach denselben
 * Regeln wie ein Vorschlag (Topic, Web-Gespraech, Direktchat, ohne Telegram).
 */

import { memoryFailureText, processIntents as applyIntents, reportMemoryFailures, type IntentConversation, type ProcessedIntents } from "./memory";
import { fixReminderTimes } from "./schedule/remind";
import { reviewConversation } from "./review-choices";
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
  /**
   * Turn ohne Telegram (Denkauftrag aus dem Telefonhoerer, Issue #259): ein
   * Vorschlag erscheint nur im WebUI-Gespraech conversationId, nie in Telegram
   */
  noTelegram?: { conversationId: string };
}

export interface IntentGateDeps {
  processIntents(text: string, where?: IntentConversation): Promise<unknown>;
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

const INTENT_TAG = /\[(?:REMEMBER|GOAL|DONE|CANCEL|FORGET|KNOWLEDGE|REMIND):[^\]]*\]/gi;
const TELEGRAM_CHAT_ID = /^-?\d{1,20}$/;

/** Nur die Intent-Tags eines Texts, je Zeile einer; leer ohne Tags. */
export function extractIntentTags(text: string): string {
  return (text.match(INTENT_TAG) ?? []).join("\n");
}

export type IntentOutcome = "none" | "applied" | "staged";

/** Ergebnis samt dem, was tatsaechlich uebernommen wurde (Issue #259: Meldung nach dem Telefonat) */
export interface TurnIntentResult {
  outcome: IntentOutcome;
  /** Nur bei applied und wenn processIntents die Angaben liefert */
  processed?: ProcessedIntents;
}

function isProcessedIntents(v: unknown): v is ProcessedIntents {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return ["goalsAdded", "goalsCompleted", "goalsCancelled", "factsAdded", "factsRemoved"].every(k => Array.isArray(p[k]));
}

/** Gespraech fuer Rueckfragen aus Chat und Topic; undefined, wenn der Chat unbekannt ist */
function conversationOf(chatId: string, topicId: number | undefined, noTelegram?: { conversationId: string }): IntentConversation | undefined {
  const conversation = reviewConversation(chatId, topicId);
  if (!conversation) return undefined;
  return noTelegram ? { conversation, noTelegram: { conversationId: noTelegram.conversationId } } : { conversation };
}

/**
 * Gespraech eines Turns fuer Rueckfragen, wie beim Ablegen eines Vorschlags:
 * Telegram-Chat mit Topic, Web-Gespraech bzw. Web-Direktchat, sonst der Direktchat
 */
export function turnConversation(target: IntentTarget, dmChatId: () => string | undefined): IntentConversation | undefined {
  const own = TELEGRAM_CHAT_ID.test(target.chatId) || isWebChatId(target.chatId);
  const chatId = own ? target.chatId : dmChatId() || target.chatId;
  const topicId = TELEGRAM_CHAT_ID.test(chatId) && chatId === target.chatId ? target.topicId : undefined;
  return conversationOf(chatId, topicId, target.noTelegram);
}

/**
 * Sprach-Bruecke: Merk-Tags einer gesprochenen Antwort durchs Tor. Die
 * Vorpruefung nutzt denselben Extraktor wie das Tor, damit jede Tag-Art
 * (auch [KNOWLEDGE:], #317) ankommt; ohne Tags "none" ohne weiteren Aufwand.
 */
export function processVoiceIntents(
  text: string,
  tools: TurnTools | undefined,
  chatId: string,
  deps?: Partial<IntentGateDeps>
): Promise<IntentOutcome> {
  if (!extractIntentTags(text)) return Promise.resolve("none");
  return processTurnIntents(text, tools, { chatId, origin: "Sprach-Brücke" }, deps);
}

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
  return (await gateTurnIntents(text, tools, target, deps)).outcome;
}

/**
 * Wie processTurnIntents, liefert aber zusaetzlich, was uebernommen wurde
 * (Fakten, Ziele samt Text), ohne die Tags ein zweites Mal anzuwenden.
 */
export async function gateTurnIntents(
  text: string,
  tools: TurnTools | undefined,
  target: IntentTarget,
  deps?: Partial<IntentGateDeps>
): Promise<TurnIntentResult> {
  const d = deps ? { ...defaultDeps, ...deps } : defaultDeps;
  const tags = extractIntentTags(text);
  if (!tags) return { outcome: "none" };

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
        tags: fixReminderTimes(tags),
        header:
          `🧠 Merk-Vorschlag${where} aus einem Turn mit fremden Inhalten (${reasons.join(", ")}). ` +
          `Nichts ist gespeichert, bis du zustimmst:`,
        origin: `${target.origin}: fremde Inhalte (${reasons.join(", ")})`,
        ...(target.noTelegram ? { noTelegram: { conversationId: target.noTelegram.conversationId } } : {}),
      });
      d.log(
        id
          ? `[Intents] ${target.origin}: Merk-Tags aus Turn mit fremden Inhalten als Vorschlag ${id} abgelegt (${reasons.join(", ")})`
          : `[Intents] ${target.origin}: Merk-Tags aus Turn mit fremden Inhalten nicht lesbar, verworfen`
      );
    } catch (err) {
      d.log(`[Intents] ${target.origin}: Vorschlag nicht abgelegt, Merk-Tags verworfen (${err instanceof Error ? err.name : "Fehler"})`);
    }
    return { outcome: "staged" };
  }

  if (verdict.status === "unknown") {
    d.log(`[Intents] ${target.origin}: Werkzeuge des Turns unbekannt, Merk-Tags wie bisher direkt angewendet`);
  }
  const where = turnConversation(target, d.dmChatId);
  const processed = await d.processIntents(text, where);
  if (!isProcessedIntents(processed)) return { outcome: "applied" };
  // Issue #518: ein nicht gespeichertes Ziel erfährt der Nutzer im Gespräch des Turns
  await reportMemoryFailures(processed, where);
  return { outcome: "applied", processed };
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
  processIntents(text: string, where?: IntentConversation): Promise<ProcessedIntents>;
}

/** Zusammenfassung nach dem Uebernehmen, alle sieben Tag-Arten (REMIND seit #322) */
export function describeApplied(p: ProcessedIntents): string {
  const parts = [
    `${p.factsAdded.length} Fakt(en)`,
    `${p.goalsAdded.length} Ziel(e)`,
    ...(p.factsRemoved.length ? [`${p.factsRemoved.length} Fakt(en) vergessen`] : []),
    ...(p.goalsCompleted.length ? [`${p.goalsCompleted.length} Ziel(e) erledigt`] : []),
    ...(p.goalsCancelled.length ? [`${p.goalsCancelled.length} Ziel(e) gestrichen`] : []),
    ...(p.knowledgeAdded?.length ? [`${p.knowledgeAdded.length} Wissenseintrag/-einträge`] : []),
    ...(p.remindersAdded?.length ? [`${p.remindersAdded.length} Erinnerung(en)`] : []),
    ...(p.asked?.length ? [`${p.asked.length} Rückfrage(n) zur Auswahl`] : []),
  ];
  const failed = memoryFailureText(p);
  if (!failed) return `✅ Übernommen: ${parts.join(", ")}.`;
  const anything = [p.factsAdded, p.goalsAdded, p.factsRemoved, p.goalsCompleted, p.goalsCancelled, p.knowledgeAdded, p.remindersAdded, p.asked].some(list => list?.length);
  return anything ? `Teilweise übernommen: ${parts.join(", ")}.\n${failed}` : failed;
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
    const processed = await deps.processIntents(review.tags, conversationOf(review.chatId, review.topicId, review.noTelegram));
    return { kind: "applied", text: describeApplied(processed), review };
  }
  if (action === "routine" && review.session) return { kind: "routine", review, session: review.session };
  return { kind: "discarded", review };
}
