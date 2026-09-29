/**
 * Merk-Vorschläge und Routine-Angebote über das Rückfragen-Register
 * (Issue #117, Entscheidung 0017).
 *
 * Zustellung (createReviewNotifier, der ReviewNotifier aus session-distill.ts):
 * Zum abgelegten Vorschlag in data/pending-reviews.json kommt eine Rückfrage
 * kind "review" mit ref = Review-ID und Frist 7 Tage ab dem Ablegen.
 * - Telegram-Gespräch (Direktchat, Topic, General): sendChoice schickt die
 *   Frage mit "ch|"-Knöpfen dorthin und hält sie fest, der Browser zeigt sie
 *   darüber im selben Gespräch.
 * - Reines Web-Gespräch (web:<id>): die Frage steht als Meldung mit choiceId im
 *   Web-Gespräch selbst (postWeb, nach einem laufenden Turn) und über
 *   sendChoice als Kopie im Direktchat; beide gehören zu derselben Frage.
 * Das Register und die Ablage der Vorschläge sind getrennte Dateien. Erst
 * wird abgelegt, dann gefragt: scheitert die Frage, liegt der Vorschlag nur
 * ungefragt herum und läuft nach 7 Tagen ab, geschrieben wird nie etwas.
 *
 * Entscheidung (createReviewResults): Der Handler der Art "review" läuft nur
 * im Gewinnerprozess von decideChoice, nachdem die Entscheidung gespeichert
 * ist; er ruft decideReview (nimmt den Vorschlag genau einmal heraus) und
 * meldet das Ergebnis als Nachricht im Gespräch der Frage, in Telegram und im
 * Browser; bei Web-Gesprächen im Web-Gespräch und als Kopie im Direktchat.
 * Routinen werden eingefroren, der Bericht landet wie bisher als
 * routine_report im Gedächtnis des Gesprächs.
 *
 * Alte Knöpfe "rev|<aktion>|<id>" (legacy): Gibt es zur Review-ID eine
 * Rückfrage, entscheidet decideChoice zuerst, nur der Gewinner wendet an.
 * Ohne Rückfrage (Vorschläge von vor dem Update) direkt über decideReview,
 * mit derselben 7-Tage-Grenze.
 *
 * Ins Log kommen nur IDs, nie Vorschlagstexte oder Merk-Einträge.
 */

import {
  createChoice,
  decideChoice,
  listChoices,
  type Choice,
  type ChoiceConversation,
  type ChoiceHandler,
  type ChoiceOption,
  type CreateChoiceInput,
  type DecideOutcome,
} from "./choices";
import type { ReviewDecision } from "./intent-gate";
import { outboxDelivered } from "./channels";
import type { SendAndRecordInput, SendAndRecordResult } from "./outbox";
import { REVIEW_MAX_AGE_MS, type ReviewNotifier, type ReviewProposal } from "./session-distill";
import { sessionEpochSnapshot, type BotSession } from "./session-manager";
import { alreadyText, choiceStatusLine } from "./telegram-choices";

export const REVIEW_APPLY = "ok";
export const REVIEW_DISCARD = "no";
export const REVIEW_ROUTINE = "routine";

/** Knöpfe eines Merk-Vorschlags; Schlüssel wie die Aktionen der alten rev|-Knöpfe */
export const REVIEW_MEMORY_OPTIONS: ChoiceOption[] = [
  { key: REVIEW_APPLY, label: "Übernehmen" },
  { key: REVIEW_DISCARD, label: "Verwerfen" },
];

/** Knöpfe eines Routine-Angebots */
export const REVIEW_ROUTINE_OPTIONS: ChoiceOption[] = [
  { key: REVIEW_ROUTINE, label: "Als Routine speichern" },
  { key: REVIEW_DISCARD, label: "Verwerfen" },
];

/** source der Meldungen in Telegram und im Browser, wie CHOICE_SOURCES.review */
export const REVIEW_SOURCE = "review";

export const REVIEW_TEXT = {
  expired: "Der Vorschlag ist abgelaufen.",
  discarded: "Verworfen, nichts gespeichert.",
  routineFailed: "Die Routine-Erstellung ist fehlgeschlagen. Details: logs/telegram-relay.error.log",
  notNow: "Gerade nicht möglich, bitte gleich nochmal",
  invalid: "Diese Auswahl gibt es nicht.",
} as const;

/** Vorsatz der Kopie im Direktchat bei Vorschlägen aus reinen Web-Gesprächen */
export const WEB_COPY_PREFIX = "(Web-Gespräch) ";

export function routineStartText(description: string): string {
  return `🔁 Ich friere die Routine ein ("${description}"), das kann ein paar Minuten dauern...`;
}

/** Telegram-Chat oder der Web-Direktchat "web" ohne Telegram (Issue #227) */
const TELEGRAM_CHAT = /^(-?\d{1,20}|web)$/;
const WEB_CHAT = /^web:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

/** Gespräch eines Vorschlags aus Chat und Topic; null, wenn der Chat unbekannt ist */
export function reviewConversation(chatId: string, topicId?: number): ChoiceConversation | null {
  const web = WEB_CHAT.exec(chatId);
  if (web) return { type: "web", conversationId: web[1] };
  if (!TELEGRAM_CHAT.test(chatId)) return null;
  return Number.isInteger(topicId) ? { type: "telegram", chatId, topicId } : { type: "telegram", chatId };
}

/** Nachricht in ein reines Web-Gespräch (Browser) */
export interface WebPost {
  text: string;
  /** Meldung statt Antwort; Routine-Berichte kommen als Antwort, sie gehören zum Gespräch */
  kind?: "notice";
  source?: string;
  choiceId?: string;
}

/**
 * Nachricht in ein reines Web-Gespräch legen, nach einem dort laufenden Turn.
 * true: angenommen (das Gespräch gibt es und die WebUI läuft), gezeigt wird
 * sie, sobald der Turn fertig ist. Wartet nie auf den Turn.
 */
export type PostWeb = (conversationId: string, post: WebPost) => Promise<boolean>;

type Log = (line: string) => void;
const defaultLog: Log = line => console.log(line);

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : "Fehler";
}

// ---------------------------------------------------------------------------
// Zustellung
// ---------------------------------------------------------------------------

export interface ReviewNotifierDeps {
  /** Standard createChoice aus dem Register */
  createChoice?(input: CreateChoiceInput): Promise<Choice>;
  /** Frage in Telegram zeigen (createTelegramChoices().sendChoice); Web-Gespräche als Kopie im Direktchat */
  sendChoice(choice: Choice): Promise<{ sent: boolean }>;
  /** Nur im Bot-Prozess mit WebUI */
  postWeb?: PostWeb;
  log?: Log;
}

/**
 * Zustellweg für session-distill.ts: legt die Rückfrage an und zeigt sie.
 * Wirft, wenn die Frage nicht angelegt werden konnte oder nirgends ankam;
 * stageMemoryReview und stageRoutineReview protokollieren das.
 */
export function createReviewNotifier(deps: ReviewNotifierDeps): ReviewNotifier {
  const log = deps.log ?? defaultLog;
  const create = deps.createChoice ?? createChoice;
  return async (proposal: ReviewProposal) => {
    const conversation = reviewConversation(proposal.chatId, proposal.topicId);
    if (!conversation) throw new Error("Gespräch des Vorschlags unbekannt");
    const choice = await create({
      kind: "review",
      conversation,
      text: proposal.text,
      options: proposal.type === "routine" ? REVIEW_ROUTINE_OPTIONS : REVIEW_MEMORY_OPTIONS,
      expiresAt: proposal.createdAt + REVIEW_MAX_AGE_MS,
      ref: proposal.reviewId,
    });

    let shown = false;
    if (conversation.type === "web" && deps.postWeb) {
      try {
        shown = await deps.postWeb(conversation.conversationId, {
          text: proposal.text,
          kind: "notice",
          source: REVIEW_SOURCE,
          choiceId: choice.id,
        });
        if (!shown) log(`[Review] Vorschlag ${proposal.reviewId}: Web-Gespräch nicht erreichbar, nur die Kopie im Direktchat`);
      } catch (e) {
        log(`[Review] Vorschlag ${proposal.reviewId} nicht ins Web-Gespräch gelegt (${errorName(e)})`);
      }
    }
    let sent = false;
    try {
      sent = (await deps.sendChoice(choice)).sent;
    } catch (e) {
      log(`[Review] Vorschlag ${proposal.reviewId} nicht nach Telegram gesendet (${errorName(e)})`);
    }
    if (!shown && !sent) throw new Error(`Rückfrage ${choice.id} nirgends zugestellt`);
  };
}

// ---------------------------------------------------------------------------
// Entscheidung und Ergebnis
// ---------------------------------------------------------------------------

export interface ReviewResultsDeps {
  /** decideReview aus intent-gate.ts */
  decideReview(action: string, reviewId: string): Promise<ReviewDecision>;
  /**
   * createRoutineFromSession aus session-routine.ts; epoch ist die Epoche des
   * Session-Schlüssels bei der Entscheidung (Issue #189): ein /new danach
   * verhindert, dass die Routine die Session wieder anlegt
   */
  createRoutine(session: BotSession, hint: string, epoch: number): Promise<{ isError?: boolean; text?: string }>;
  /**
   * sessionEpochSnapshot aus session-manager.ts (Standard), austauschbar für
   * Tests: Epochen vor decideReview, dessen Session erst danach bekannt ist
   */
  sessionEpochSnapshot?(): (sessionKey: string) => number;
  /** Meldung mit Festhalten (Telegram und Browser), sendAndRecord aus outbox.ts */
  sendAndRecord(input: SendAndRecordInput): Promise<SendAndRecordResult>;
  /** Telegram ohne Festhalten (Routine-Bericht, den saveMessage festhält), Markdown */
  sendTelegram(chatId: string, text: string, topicId?: number): Promise<void>;
  /** Gedächtnis des Gesprächs (saveMessage), für den routine_report */
  saveMessage(message: { chat_id: string; role: "assistant"; content: string; metadata: Record<string, unknown> }): Promise<unknown>;
  postWeb?: PostWeb;
  /** TELEGRAM_USER_ID: Kopie bei reinen Web-Gesprächen */
  dmChatId(): string | undefined;
  /** Standard aus dem Register (alte rev|-Knöpfe) */
  listChoices?(): Promise<Choice[]>;
  decideChoice?(id: string, key: string, via: "telegram"): Promise<DecideOutcome>;
  /**
   * Einfrieren einer Routine dauert Minuten; es läuft nach dem Klick weiter,
   * ohne ihn (Telegram-Update, Browser-Anfrage) aufzuhalten. Standard: Promise
   * laufen lassen, Fehler ins Log. Tests warten darauf.
   */
  background?(work: Promise<void>): void;
  log?: Log;
}

export interface ReviewResults {
  /** Handler der Art "review" (onChoiceDecided) */
  handler: ChoiceHandler;
  /**
   * Ergebnis einer Entscheidung im Gespräch melden (Routine: einfrieren und
   * berichten); wirft nicht. epochs: Schnappschuss von vor decideReview,
   * ohne ihn gelten die Epochen von jetzt
   */
  deliver(decision: ReviewDecision, conversation: ChoiceConversation | null, epochs?: (sessionKey: string) => number): Promise<void>;
  /**
   * Alter Knopf "rev|<aktion>|<id>": Text für die geklickte Nachricht
   * (ersetzt sie samt Knöpfen); null: Nachricht unverändert lassen, damit ein
   * zweiter Versuch möglich bleibt.
   */
  legacy(action: string, reviewId: string): Promise<{ text: string | null }>;
}

/** Beschriftung für das Ergebnis eines alten Knopfs ohne Rückfrage */
const LEGACY_LABELS: Record<Exclude<ReviewDecision["kind"], "expired">, string> = {
  applied: "Übernehmen",
  discarded: "Verwerfen",
  routine: "Als Routine speichern",
};

export function createReviewResults(deps: ReviewResultsDeps): ReviewResults {
  const log = deps.log ?? defaultLog;
  const snapshot = deps.sessionEpochSnapshot ?? sessionEpochSnapshot;
  const list = deps.listChoices ?? listChoices;
  const decide = deps.decideChoice ?? ((id: string, key: string, via: "telegram") => decideChoice(id, key, via));
  const background =
    deps.background ??
    ((work: Promise<void>) => {
      void work.catch(e => log(`[Review] Ergebnis nicht gemeldet (${errorName(e)})`));
    });

  async function record(input: SendAndRecordInput, what: string): Promise<void> {
    try {
      const result = await deps.sendAndRecord(input);
      // Ohne Telegram für die WebUI festgehalten zählt als zugestellt (Issue #227)
      if (!outboxDelivered(result)) log(`[Review] ${what} nicht nach Telegram gesendet`);
    } catch (e) {
      log(`[Review] ${what} nicht nach Telegram gesendet (${errorName(e)})`);
    }
  }

  async function web(conversationId: string, post: WebPost, what: string): Promise<void> {
    if (!deps.postWeb) return;
    try {
      if (!(await deps.postWeb(conversationId, post))) log(`[Review] ${what}: Web-Gespräch nicht erreichbar`);
    } catch (e) {
      log(`[Review] ${what} nicht ins Web-Gespräch gelegt (${errorName(e)})`);
    }
  }

  /** Kurze Meldung ins Gespräch der Frage (bei Web-Gesprächen zusätzlich in den Direktchat) */
  async function notice(conversation: ChoiceConversation, text: string, what: string): Promise<void> {
    if (conversation.type === "telegram") {
      await record(
        { chatId: conversation.chatId, ...(conversation.topicId !== undefined ? { topicId: conversation.topicId } : {}), text, source: REVIEW_SOURCE, format: "plain" },
        what
      );
      return;
    }
    await web(conversation.conversationId, { text, kind: "notice", source: REVIEW_SOURCE }, what);
    const dm = deps.dmChatId();
    if (dm) await record({ chatId: dm, text: `${WEB_COPY_PREFIX}${text}`, source: REVIEW_SOURCE, format: "plain" }, `${what} (Kopie)`);
  }

  /** Routine-Bericht: Telegram bzw. Web-Gespräch plus Kopie, und als routine_report ins Gedächtnis */
  async function report(conversation: ChoiceConversation, text: string, reviewId: string): Promise<void> {
    const what = `Routine-Bericht zu ${reviewId}`;
    const chatId = conversation.type === "telegram" ? conversation.chatId : `web:${conversation.conversationId}`;
    const topicId = conversation.type === "telegram" ? conversation.topicId : undefined;
    if (conversation.type === "telegram") {
      try {
        await deps.sendTelegram(conversation.chatId, text, topicId);
      } catch (e) {
        log(`[Review] ${what} nicht nach Telegram gesendet (${errorName(e)})`);
      }
    } else {
      await web(conversation.conversationId, { text }, what);
      const dm = deps.dmChatId();
      if (dm) await record({ chatId: dm, text: `${WEB_COPY_PREFIX}${text}`, source: REVIEW_SOURCE }, `${what} (Kopie)`);
    }
    // In die Historie schreiben, sonst kennt keine spaetere Session diesen
    // Report (der Freeze laeuft ausserhalb der normalen Antwort-Pipeline).
    try {
      await deps.saveMessage({
        chat_id: chatId,
        role: "assistant",
        content: text,
        metadata: { type: "routine_report", ...(topicId !== undefined ? { topicId } : {}) },
      });
    } catch (e) {
      log(`[Review] ${what} nicht im Gedächtnis gespeichert (${errorName(e)})`);
    }
  }

  async function deliver(
    decision: ReviewDecision,
    conversation: ChoiceConversation | null,
    epochs: (sessionKey: string) => number = snapshot()
  ): Promise<void> {
    const target = conversation ?? (decision.kind === "expired" ? null : reviewConversation(decision.review.chatId, decision.review.topicId));
    const reviewId = decision.kind === "expired" ? "?" : decision.review.id;
    if (!target) {
      log(`[Review] Ergebnis zu Vorschlag ${reviewId} ohne bekanntes Gespräch, nicht gemeldet`);
      return;
    }
    switch (decision.kind) {
      case "expired":
        await notice(target, REVIEW_TEXT.expired, "Ablauf-Meldung");
        return;
      case "discarded":
        await notice(target, REVIEW_TEXT.discarded, `Verwerfen von ${reviewId}`);
        return;
      case "applied":
        await notice(target, decision.text, `Übernahme von ${reviewId}`);
        return;
      case "routine": {
        const description = decision.review.routineDescription || "";
        // Epoche von vor decideReview: ein /new während der Entscheidung
        // oder der Startmeldung verwirft die Session der Routine
        const session = decision.session;
        const epoch = epochs(session.key.slice(0, -(session.agentName.length + 1)));
        await notice(target, routineStartText(description), `Routine-Start zu ${reviewId}`);
        let text: string;
        try {
          const result = await deps.createRoutine(session, description, epoch);
          text = result.isError || !result.text ? REVIEW_TEXT.routineFailed : result.text;
        } catch (e) {
          log(`[Review] Routine zu ${reviewId} nicht eingefroren (${errorName(e)})`);
          text = REVIEW_TEXT.routineFailed;
        }
        await report(target, text, reviewId);
        return;
      }
    }
  }

  /** Ergebnis melden; eine Routine läuft im Hintergrund weiter */
  async function settle(
    decision: ReviewDecision,
    conversation: ChoiceConversation | null,
    epochs: (sessionKey: string) => number
  ): Promise<void> {
    if (decision.kind === "routine") background(deliver(decision, conversation, epochs));
    else await deliver(decision, conversation, epochs);
  }

  const handler: ChoiceHandler = async choice => {
    if (!choice.ref || !choice.result) throw new Error("Rückfrage ohne Vorschlag oder Ergebnis");
    // Epochen vor decideReview (Issue #189): ein /new während der Auswahl
    // der Session soll die Routine ebenso stoppen
    const epochs = snapshot();
    // Genau einmal: decideReview nimmt den Vorschlag aus der Ablage, erst danach wird gemeldet
    const decision = await deps.decideReview(choice.result.key, choice.ref);
    await settle(decision, choice.conversation, epochs);
  };

  async function legacy(action: string, reviewId: string): Promise<{ text: string | null }> {
    let choices: Choice[];
    try {
      choices = await list();
    } catch (e) {
      // Ohne lesbares Register nie am Register vorbei anwenden
      log(`[Review] Register für alten Knopf zu ${reviewId} nicht lesbar (${errorName(e)})`);
      return { text: null };
    }
    const choice = choices.find(c => c.kind === "review" && c.ref === reviewId);
    if (choice) {
      // Erst im Register entscheiden; angewendet wird nur im Handler des Gewinners
      let outcome: DecideOutcome;
      try {
        outcome = await decide(choice.id, action, "telegram");
      } catch (e) {
        log(`[Review] Rückfrage ${choice.id} über alten Knopf nicht entschieden (${errorName(e)})`);
        return { text: null };
      }
      switch (outcome.status) {
        case "decided":
          return { text: choiceStatusLine(outcome.choice) };
        case "already":
          return { text: alreadyText(outcome.choice) };
        case "invalid_key":
          return { text: REVIEW_TEXT.invalid };
        default:
          return { text: REVIEW_TEXT.expired };
      }
    }
    // Vorschlag von vor dem Update: ohne Register, nur die Ablage entscheidet genau einmal
    const epochs = snapshot();
    const decision = await deps.decideReview(action, reviewId);
    if (decision.kind === "expired") return { text: REVIEW_TEXT.expired };
    await settle(decision, null, epochs);
    return { text: `✓ ${LEGACY_LABELS[decision.kind]} (in Telegram)` };
  }

  return { handler, deliver, legacy };
}
