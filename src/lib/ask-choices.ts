/**
 * Rückfragen des Modells ("Soll ich ...?") als Art "ask" im
 * Rückfragen-Register (Issue #335, Entscheidung 0017).
 *
 * Anbieten (offerAsk): Erst steht der Auftrag in async_tasks, dann wird die
 * Frage entscheidbar. Am Auftrag liegen Gespräch (chat_id, thread_id; reine
 * Web-Gespräche als chat_id web:<id>), Session der Frage (session_id), Agent,
 * Motor und Modell (metadata.agent_name, engine, model; model "" heißt
 * Standard des Motors und bleibt so), die vollständigen Antworten
 * (pending_options, label ungekürzt, value = Knopf) und eine frische Kennung
 * der Frage (metadata.ask_id). Scheitert das Speichern, entsteht keine
 * Rückfrage. Der Bezug der Rückfrage (ref) ist "<taskId>:<askId>": eine
 * Folgefrage am selben Auftrag bekommt eine neue askId, ein alter Knopf passt
 * dann nicht mehr und setzt nichts fort. Knöpfe zeigen eine gekürzte
 * Beschriftung (Anfang und Ende); sind zwei davon oder zwei Antworten gleich,
 * ist die Eingabe unbrauchbar.
 *
 * Folgefrage ohne Session: Die Session des Auftrags bleibt nur, wenn die
 * Folgefrage denselben Motor nutzt (Vererbung nur innerhalb eines Motors).
 * Bei einem Motorwechsel wird sie entfernt (session_id ""), eine
 * Claude-Session geht so nie an Codex.
 *
 * Sperre je Auftrag (Datei neben dem Register, gilt über Prozesse hinweg):
 * Auftrag festhalten und Frage anlegen (samt Ablauf älterer offener Fragen
 * desselben Auftrags), Beanspruchen beim Entscheiden und jeder Abschluss
 * laufen darunter. Zwei überlappende Angebote hinterlassen so genau eine
 * offene Frage, deren Kennung am Auftrag steht; ein Abschluss oder Scheitern
 * schreibt nur, solange am Auftrag noch die eigene askId steht, und
 * überschreibt nie eine inzwischen neuere Frage.
 *
 * Wem ein Auftrag gehört, steht mit seiner Anlage fest und ändert sich nie:
 * Aufträge, die offerAsk anlegt, tragen ab dem ersten Speichern eine askId
 * und gehören dem Register; Aufträge des atask-Wegs (ask_user der
 * Prozessoren und Aufträge aus der Zeit vor dem Register) haben keine und
 * bekommen nie eine. Eine Folgefrage geht deshalb nur an einen
 * Auftrag mit askId, ein alter Auftrag wird nie übernommen (invalid). So
 * greifen Register und alter Weg nie auf denselben Auftrag zu, gleich ob der
 * alte Weg sein Beanspruchen speichern konnte oder nicht. Das Angebot setzt
 * reminder_sent im selben Schreiben wie die askId, deshalb liefert stale()
 * den Auftrag nicht und die Erinnerung an alte Aufträge (task-reminders.ts)
 * schickt keine atask-Knöpfe; an die Rückfrage selbst erinnert dasselbe
 * Modul über das Register. Ein atask-Knopf läuft in src/bot.ts über
 * claimLegacyTaskButton (legacy-task-buttons.ts) und damit über
 * claimLegacyTaskCallback: hat der Auftrag eine askId oder ist er nicht
 * lesbar, wird er abgewiesen, sonst unter der Sperre des Auftrags
 * beansprucht. Die Prüfung auf die askId selbst braucht keine Sperre, das
 * Ergebnis kann sich später nicht mehr ändern.
 *
 * Zustellung wie bei mehrdeutigen Merk-Tags (memory/choices.ts):
 * Telegram-Gespräch per sendChoice, reines Web-Gespräch im Gespräch selbst
 * (Meldung mit choiceId) und als Kopie im Direktchat. Kommt sie nirgends an,
 * läuft sie ab und der Auftrag gilt als gescheitert.
 *
 * Entscheiden (Handler): läuft nur im Gewinnerprozess von decideChoice, also
 * höchstens einmal je Rückfrage. Er prüft am Auftrag Zustand needs_input,
 * askId und Gespräch, setzt ihn auf running (scheitert das Speichern, ruft er
 * keinen Motor) und setzt über resumeMacTask (task-resume.ts) die Session der
 * Frage mit deren Motor und Modell fort, mit der vollständigen Antwort.
 * Abschluss: Antwort speichern, Merk-Tags für das Gespräch der Frage
 * auswerten, im Gespräch zeigen und den Auftrag auf completed setzen.
 * Zeigt der Zustellweg die Antwort nicht (Telegram scheitert, das
 * Web-Gespräch nimmt sie nicht an, im Web-Direktchat ohne Telegram ist sie
 * nicht gespeichert), geht sie über den Meldeweg (notify). Kommt sie auch dort
 * nicht an, gilt der Auftrag als gescheitert, die Antwort steht dann im
 * Ergebnis des Auftrags. Speicher- und Zustellfehler enden als Handlerfehler
 * an der Rückfrage, ein nicht gespeicherter Verlauf oder Status des Auftrags
 * (false, Lesefehler, Ausnahme) zusätzlich mit einem Hinweis im Gespräch; eine
 * inzwischen neuere Frage am Auftrag bleibt unberührt und ist kein Fehler.
 * Der Motor läuft dafür nie ein zweites Mal.
 * Folgefrage (Issue #336): endet die gezeigte Antwort wieder mit einer
 * Rückfrage (turn-questions.ts), entsteht nach dem Abschluss eine neue
 * Rückfrage an einem neuen Auftrag, mit Session, Motor und Modell der
 * Fortsetzung. Der Auftrag dieser Frage bleibt so erledigt, auch wenn die
 * Folgefrage nicht ankommt; die Antwort zeigt Frage und Antworten als Text. /stop, fehlende Session, „Abbrechen", Motorfehler, Zeitlimit und Ausnahmen enden
 * jeweils mit einer Meldung und einem passenden Status; ein Motorfehler wird
 * nie als Antwort gezeigt oder auf Merk-Tags ausgewertet.
 *
 * Getippte Antwort (settleTypedAnswer, Issue #348): Beantwortet eine
 * Nachricht im Gespräch die Rückfrage (der Motor api meldet das), läuft die
 * Frage ab und der Auftrag wird completed (metadata.answered_by "text"). Ein
 * Klick danach oder ein Klick, der schon auf die Session wartete, setzt
 * nichts fort, meldet das im Gespräch und lässt den Auftrag completed.
 *
 * Ins Log kommen nur Kennungen, nie Frage- oder Antworttexte.
 */

import { randomBytes } from "crypto";
import { mkdir } from "fs/promises";
import { join } from "path";
import {
  choicesDir,
  createChoice as realCreateChoice,
  expireChoice as realExpireChoice,
  listChoices,
  type Choice,
  type ChoiceChannel,
  type ChoiceConversation,
  type ChoiceHandler,
  type ChoiceOption,
  type CreateChoiceInput,
  type CreateChoiceOptions,
} from "./choices";
import type { PromptChannel } from "../agents/prompt-parts";
import { isWebChatId } from "./channels";
import type { EngineId } from "./engines";
import { acquireFileLock, releaseFileLock } from "./file-lock";
import type { PostWeb } from "./review-choices";
import { getStore } from "./store";
import type { TaskStore } from "./store/ports";
import type { AsyncTask, TaskChanges } from "./store/types";
import { resumeMacTask, taskEngine, taskResumeRecord, type MacResumeOutcome } from "./task-resume";
import type { TurnTools } from "./turn-tools";
import { processTurnIntents, type IntentTarget } from "./intent-gate";
import { scanForQuestion } from "./turn-questions";

/** source der Fragen und Meldungen, wie CHOICE_SOURCES.ask */
export const ASK_SOURCE = "rueckfrage";
/** Knopf „Abbrechen", immer als letzter */
export const ASK_CANCEL = "cancel";
/** Höchstzahl der Antwortknöpfe (ohne „Abbrechen") */
export const ASK_OPTIONS_MAX = 8;
const LABEL_MAX = 60;
/** So viele Zeichen vom Ende bleiben in einer gekürzten Beschriftung stehen */
const LABEL_TAIL = 20;
const RESULT_MAX = 10_000;

export const ASK_TEXT = {
  cancelLabel: "Abbrechen",
  cancelled: "Abgebrochen, nichts fortgesetzt.",
  aborted: "Abgebrochen.",
  noted: (label: string) => `Notiert: ${label}. Es gab keine Sitzung zum Fortsetzen.`,
  empty: "Erledigt.",
  stale: "Diese Rückfrage gilt nicht mehr, nichts fortgesetzt.",
  gone: "Den Auftrag zu dieser Rückfrage gibt es nicht mehr.",
  notSaved: "Die Antwort ließ sich nicht speichern, nichts fortgesetzt.",
  failed: "Das Fortsetzen hat nicht geklappt.",
  timedOut: "Das Fortsetzen hat zu lange gedauert und wurde beendet.",
  notStored: "Die Antwort oben ließ sich nicht im Verlauf speichern.",
  statusNotSaved: "Der Stand des Auftrags ließ sich nicht speichern.",
  answeredByText: "Diese Rückfrage ist schon mit deiner Nachricht beantwortet, nichts fortgesetzt.",
} as const;

/** Ergebnis am Auftrag, wenn eine getippte Nachricht die Rückfrage beantwortet hat */
export const ASK_ANSWERED_BY_TEXT = "Per Nachricht beantwortet";

type Log = (line: string) => void;
const defaultLog: Log = line => console.log(line);
const errorName = (e: unknown) => (e instanceof Error ? e.name : "Fehler");
/** Handlerfehler, wenn der Abschluss den Status des Auftrags nicht speichern konnte */
const STATUS_NOT_SAVED = "Status des Auftrags nicht gespeichert";

// ---------------------------------------------------------------------------
// Bezug zwischen Rückfrage und Auftrag
// ---------------------------------------------------------------------------

const ASK_ID = /^[a-f0-9]{12}$/;
const TASK_ID = /^[A-Za-z0-9-]{1,64}$/;

/** "<taskId>:<askId>" */
export function askRef(taskId: string, askId: string): string {
  return `${taskId}:${askId}`;
}

/** Zerlegt den Bezug; null, wenn er nicht von offerAsk stammt */
export function parseAskRef(ref: unknown): { taskId: string; askId: string } | null {
  if (typeof ref !== "string") return null;
  const cut = ref.lastIndexOf(":");
  if (cut <= 0) return null;
  const taskId = ref.slice(0, cut);
  const askId = ref.slice(cut + 1);
  return TASK_ID.test(taskId) && ASK_ID.test(askId) ? { taskId, askId } : null;
}

/** Ort des Auftrags zum Gespräch: Telegram-Chat mit Topic, reines Web-Gespräch als web:<id> */
export function askTaskPlace(conversation: ChoiceConversation): { chatId: string; threadId?: number } {
  if (conversation.type === "web") return { chatId: `web:${conversation.conversationId}` };
  return conversation.topicId !== undefined
    ? { chatId: conversation.chatId, threadId: conversation.topicId }
    : { chatId: conversation.chatId };
}

/** Gehört der Auftrag zu genau diesem Gespräch? */
function samePlace(task: AsyncTask, conversation: ChoiceConversation): boolean {
  const place = askTaskPlace(conversation);
  const thread = typeof task.thread_id === "number" ? task.thread_id : undefined;
  return task.chat_id === place.chatId && thread === place.threadId;
}

/**
 * Knopf des alten atask-Wegs (atask:<taskId>:<auswahl>) zu einem Auftrag des
 * Registers? Dann darf der alte Weg (legacy-task-buttons.ts) ihn nicht
 * entscheiden. Lässt sich der Auftrag nicht lesen, gilt der Knopf
 * vorsichtshalber als solcher: auch bei null, denn der Supabase-Speicher
 * meldet Lesefehler so statt mit einer Ausnahme. Ein fehlender Auftrag wäre
 * für den alten Weg ohnehin abgelaufen.
 */
export async function isRegisterAskCallback(data: string, tasks: () => TaskStore = () => getStore().tasks): Promise<boolean> {
  const parts = data.split(":");
  if (parts.length < 3 || parts[0] !== "atask") return false;
  try {
    const task = await tasks().byId(parts[1]);
    return task === null || typeof task.metadata?.ask_id === "string";
  } catch {
    return true;
  }
}

export type LegacyTaskCallback<T> = { register: true } | { register: false; result: T };

/**
 * Knopf des alten atask-Wegs: claim (in legacy-task-buttons.ts, liest und
 * beansprucht den Auftrag) läuft nur für Aufträge ohne askId. Die Prüfung
 * gilt dauerhaft, weil ein Auftrag ohne askId nie eine bekommt (offerAsk
 * übernimmt keine alten Aufträge). register: true heißt, der Knopf gehört dem
 * Register oder der Auftrag ist nicht lesbar, claim läuft dann nicht.
 */
export async function claimLegacyTaskCallback<T>(
  data: string,
  claim: (data: string) => Promise<T>,
  tasks: () => TaskStore = () => getStore().tasks
): Promise<LegacyTaskCallback<T>> {
  const parts = data.split(":");
  // Keine atask-Daten oder eine Kennung, die offerAsk nie annimmt: kein Register-Auftrag möglich
  if (parts.length < 3 || parts[0] !== "atask" || !TASK_ID.test(parts[1])) return { register: false, result: await claim(data) };
  if (await isRegisterAskCallback(data, tasks)) return { register: true };
  return { register: false, result: await claim(data) };
}

/**
 * Sperre je Auftrag neben dem Register; wirft, wenn sie nicht zu bekommen ist.
 * Auch die Erinnerungen (task-reminders.ts) und alte atask-Knöpfe
 * (legacy-task-buttons.ts) schreiben nur darunter.
 */
export async function withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const dir = choicesDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `ask-${taskId}.lock`);
  const lock = await acquireFileLock(path);
  try {
    return await fn();
  } finally {
    await releaseFileLock(path, lock).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Anbieten
// ---------------------------------------------------------------------------

export interface AskOffer {
  conversation: ChoiceConversation;
  /** Fragetext, wie er über den Knöpfen steht */
  question: string;
  /** Antwortmöglichkeiten; „Abbrechen" kommt immer dazu */
  options: string[];
  /** Auftrag des Nutzers, aus dem die Frage entstand (original_prompt) */
  originalPrompt: string;
  agent: string;
  engine: EngineId;
  /** Modell des Motors; "" heißt Standard des Motors */
  model: string;
  /** Session, in der die Frage gestellt wurde */
  sessionId?: string;
  /** Folgefrage an einem bestehenden Auftrag desselben Gesprächs */
  taskId?: string;
}

export type AskOfferOutcome =
  | { status: "offered"; choice: Choice; taskId: string }
  /** Eingabe unbrauchbar (leere Frage, keine, doppelte oder ununterscheidbare Optionen) */
  | { status: "invalid" }
  /** Auftrag nicht gespeichert: keine Rückfrage angelegt */
  | { status: "not-saved" }
  /** Angelegt, aber nirgends gezeigt: abgelaufen */
  | { status: "not-shown" }
  /** In diesem Prozess ist kein Zustellweg eingerichtet (installAskOffer) */
  | { status: "unavailable" };

export interface AskOfferDeps {
  /** Frage in Telegram zeigen (createTelegramChoices().sendChoice); Web-Gespräche als Kopie im Direktchat */
  sendChoice(choice: Choice): Promise<{ sent: boolean }>;
  /** Nur im Bot-Prozess mit WebUI */
  postWeb?: PostWeb;
  /** Standard getStore().tasks */
  tasks?: () => TaskStore;
  createChoice?(input: CreateChoiceInput, options?: CreateChoiceOptions): Promise<Choice>;
  expireChoice?(id: string): Promise<unknown>;
  log?: Log;
}

/** Beschriftung eines Knopfs: Anfang und Ende, damit Antworten mit gleichem Anfang unterscheidbar bleiben */
function shortLabel(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= LABEL_MAX) return line;
  return `${line.slice(0, LABEL_MAX - LABEL_TAIL - 1).trimEnd()}…${line.slice(-LABEL_TAIL).trimStart()}`;
}

/** Knöpfe o0, o1, … in der Reihenfolge der Optionen, dazu „Abbrechen" */
export function askOptions(labels: string[]): ChoiceOption[] {
  return [
    ...labels.map((label, i) => ({ key: `o${i}`, label: shortLabel(label) })),
    { key: ASK_CANCEL, label: ASK_TEXT.cancelLabel },
  ];
}

/** Antworten und Knöpfe; null, wenn zwei Antworten oder zwei Beschriftungen gleich wären */
function answerOptions(labels: string[]): { options: ChoiceOption[]; answers: { label: string; value: string }[] } | null {
  const answers = labels.map((label, i) => ({ label: label.trim(), value: `o${i}` }));
  const options = askOptions(labels);
  const shown = options.map(o => o.label);
  const full = answers.map(a => a.label);
  if (new Set(shown).size !== shown.length || new Set(full).size !== full.length) return null;
  return { options, answers };
}

/** Vollständige Antwort zum Knopf, wie am Auftrag gespeichert */
function answerFor(task: AsyncTask, key: string): string | undefined {
  const found = Array.isArray(task.pending_options) ? task.pending_options.find(o => o?.value === key) : undefined;
  return typeof found?.label === "string" && found.label !== "" ? found.label : undefined;
}

export function createAskOffer(deps: AskOfferDeps): (offer: AskOffer) => Promise<AskOfferOutcome> {
  const log = deps.log ?? defaultLog;
  const tasks = deps.tasks ?? (() => getStore().tasks);
  const create = deps.createChoice ?? realCreateChoice;
  const expire = deps.expireChoice ?? realExpireChoice;

  async function toWeb(choice: Choice, conversationId: string): Promise<boolean> {
    if (!deps.postWeb) return false;
    try {
      return await deps.postWeb(conversationId, { text: choice.text, kind: "notice", source: ASK_SOURCE, choiceId: choice.id });
    } catch (e) {
      log(`[Rückfrage] ${choice.id} nicht ins Web-Gespräch gelegt (${errorName(e)})`);
      return false;
    }
  }

  async function show(choice: Choice): Promise<boolean> {
    let shown = choice.conversation.type === "web" ? await toWeb(choice, choice.conversation.conversationId) : false;
    try {
      shown = (await deps.sendChoice(choice)).sent || shown;
    } catch (e) {
      log(`[Rückfrage] ${choice.id} nicht nach Telegram gesendet (${errorName(e)})`);
    }
    return shown;
  }

  /** Der Auftrag bleibt nicht als wartend stehen, wenn die Frage nie ankam; eine neuere Frage bleibt unberührt */
  async function giveUp(store: TaskStore, taskId: string, askId: string, why: string): Promise<void> {
    try {
      await withTaskLock(taskId, async () => {
        const current = await store.byId(taskId);
        if (!current || current.metadata?.ask_id !== askId) return;
        await store.update(taskId, { status: "failed", result: why });
      });
    } catch (e) {
      log(`[Rückfrage] Auftrag ${taskId} nicht als gescheitert vermerkt (${errorName(e)})`);
    }
  }

  /** Session-Feld der Folgefrage: eigene Session, geerbte nur beim selben Motor, sonst entfernt */
  function sessionChange(task: AsyncTask, offer: AskOffer): Pick<TaskChanges, "session_id"> {
    const own = typeof offer.sessionId === "string" ? offer.sessionId.trim() : "";
    if (own) return { session_id: own };
    if (!task.session_id) return {};
    return taskEngine(task).engine === offer.engine ? {} : { session_id: "" };
  }

  return async offer => {
    const labels = Array.isArray(offer.options) ? offer.options.filter(o => typeof o === "string" && o.trim() !== "") : [];
    if (typeof offer.question !== "string" || offer.question.trim() === "" || labels.length === 0 || labels.length > ASK_OPTIONS_MAX) {
      return { status: "invalid" };
    }
    const built = answerOptions(labels);
    if (!built) return { status: "invalid" };
    if (offer.taskId !== undefined && !TASK_ID.test(offer.taskId)) return { status: "invalid" };
    const place = askTaskPlace(offer.conversation);
    let store: TaskStore;
    let task: AsyncTask | null;
    try {
      store = tasks();
      task = offer.taskId ? await store.byId(offer.taskId) : await store.create(place.chatId, offer.originalPrompt, place.threadId);
    } catch (e) {
      log(`[Rückfrage] Auftrag nicht gespeichert (${errorName(e)})`);
      return { status: "not-saved" };
    }
    if (!task) {
      log("[Rückfrage] Auftrag nicht gespeichert");
      return { status: "not-saved" };
    }
    if (!TASK_ID.test(task.id)) {
      log("[Rückfrage] Auftrag mit unbrauchbarer Kennung");
      return { status: "not-saved" };
    }

    const taskId = task.id;
    const askId = randomBytes(6).toString("hex");
    type Locked = { status: "created"; choice: Choice } | { status: "invalid" } | { status: "not-saved" };
    let locked: Locked;
    try {
      // Festhalten und Anlegen unter derselben Sperre: kein anderes Angebot dazwischen
      locked = await withTaskLock<Locked>(taskId, async () => {
        const current = await store.byId(taskId);
        if (!current) return { status: "not-saved" };
        if (!samePlace(current, offer.conversation)) {
          log(`[Rückfrage] Auftrag ${taskId} gehört zu einem anderen Gespräch`);
          return { status: "invalid" };
        }
        // Folgefrage nur an einem Auftrag des Registers: ein alter Auftrag bleibt beim atask-Weg
        if (offer.taskId && typeof current.metadata?.ask_id !== "string") {
          log(`[Rückfrage] Auftrag ${taskId} gehört nicht dem Register`);
          return { status: "invalid" };
        }
        let saved = false;
        try {
          saved = await store.update(taskId, {
            status: "needs_input",
            // Keine Erinnerung mit atask-Knöpfen (task-reminders.ts): entschieden wird nur im Register
            reminder_sent: true,
            ...sessionChange(current, offer),
            pending_question: offer.question,
            pending_options: built.answers,
            metadata: { ...(current.metadata ?? {}), agent_name: offer.agent, engine: offer.engine, model: offer.model, ask_id: askId },
          });
        } catch (e) {
          log(`[Rückfrage] Auftrag ${taskId} nicht aktualisiert (${errorName(e)})`);
        }
        if (!saved) return { status: "not-saved" };
        try {
          const choice = await create(
            { kind: "ask", conversation: offer.conversation, text: offer.question, options: built.options, ref: askRef(taskId, askId) },
            // Ältere offene Fragen desselben Auftrags gelten nicht mehr
            { replace: c => c.kind === "ask" && parseAskRef(c.ref)?.taskId === taskId }
          );
          return { status: "created", choice };
        } catch (e) {
          log(`[Rückfrage] zu Auftrag ${taskId} nicht angelegt (${errorName(e)})`);
          await store.update(taskId, { status: "failed", result: "Rückfrage nicht angelegt" }).catch(() => false);
          return { status: "not-saved" };
        }
      });
    } catch (e) {
      log(`[Rückfrage] Auftrag ${taskId} gesperrt (${errorName(e)})`);
      return { status: "not-saved" };
    }
    if (locked.status !== "created") return locked;

    const choice = locked.choice;
    if (await show(choice)) return { status: "offered", choice, taskId };
    log(`[Rückfrage] ${choice.id} nirgends zugestellt, abgelaufen`);
    await Promise.resolve(expire(choice.id)).catch(() => {});
    await giveUp(store, taskId, askId, "Rückfrage nicht zugestellt");
    return { status: "not-shown" };
  };
}

type AskOfferFn = (offer: AskOffer) => Promise<AskOfferOutcome>;
let installed: AskOfferFn | null = null;

/** Zustellweg des Bot-Prozesses (createAskOffer); gibt die Abmeldung zurück */
export function installAskOffer(fn: AskOfferFn): () => void {
  installed = fn;
  return () => {
    if (installed === fn) installed = null;
  };
}

/** Rückfrage des Modells anbieten, kanalübergreifend über den eingerichteten Zustellweg */
export function offerAsk(offer: AskOffer): Promise<AskOfferOutcome> {
  return installed ? installed(offer) : Promise.resolve({ status: "unavailable" });
}

// ---------------------------------------------------------------------------
// Getippte Antwort
// ---------------------------------------------------------------------------

/** Vom Text-Weg erledigt (settleTypedAnswer): dann gilt kein Klick mehr als Fehlschlag */
const answeredByText = (task: AsyncTask, askId: string) =>
  task.status === "completed" && task.metadata?.ask_id === askId && task.metadata?.answered_by === "text";

export interface TypedAnswer {
  conversation: ChoiceConversation;
  /** Session der beantworteten Rückfrage (EngineResult.answeredQuestion), wie session_id am Auftrag */
  sessionId: string;
  /** Die getippte Nachricht */
  answer: string;
}

export interface TypedAnswerDeps {
  tasks?: () => TaskStore;
  list?: () => Promise<Choice[]>;
  expireChoice?(id: string): Promise<unknown>;
  log?: Log;
}

/**
 * Eine getippte Nachricht hat eine Rückfrage beantwortet (Motor api: der
 * Lauf meldet answeredQuestion). Unter der Sperre des Auftrags läuft die
 * Frage ab (ein späterer Klick setzt nichts fort) und der Auftrag wird
 * completed, auch wenn ein gleichzeitiger Klick ihn schon beansprucht hat
 * (running): dessen Fortsetzung findet die Frage beantwortet und lässt den
 * Auftrag so stehen. Betroffen sind nur Aufträge dieses Gesprächs mit genau
 * dieser Session, deren Frage noch aussteht. Gibt die Zahl der erledigten
 * Aufträge zurück; wirft nicht.
 */
export async function settleTypedAnswer(input: TypedAnswer, deps: TypedAnswerDeps = {}): Promise<number> {
  const log = deps.log ?? defaultLog;
  const tasks = deps.tasks ?? (() => getStore().tasks);
  const list = deps.list ?? listChoices;
  const expire = deps.expireChoice ?? realExpireChoice;
  let settled = 0;
  try {
    const store = tasks();
    const place = askTaskPlace(input.conversation);
    const here = (c: Choice) => {
      const other = askTaskPlace(c.conversation);
      return other.chatId === place.chatId && other.threadId === place.threadId;
    };
    const asks = (await list()).filter(c => c.kind === "ask" && parseAskRef(c.ref) && here(c));
    for (const choice of asks) {
      const ref = parseAskRef(choice.ref)!;
      const done = await withTaskLock(ref.taskId, async () => {
        const task = await store.byId(ref.taskId);
        if (!task || task.metadata?.ask_id !== ref.askId || task.session_id !== input.sessionId || !samePlace(task, input.conversation)) return false;
        if (task.status !== "needs_input" && task.status !== "running") return false;
        // Erst die Frage, dann der Auftrag: ein Klick dazwischen trifft eine abgelaufene Frage
        if (choice.state === "open") await expire(choice.id);
        const saved = await store.update(task.id, {
          status: "completed",
          result: ASK_ANSWERED_BY_TEXT,
          user_response: input.answer.slice(0, RESULT_MAX),
          metadata: { ...(task.metadata ?? {}), answered_by: "text" },
        });
        if (!saved) log(`[Rückfrage] ${choice.id}: Auftrag ${task.id} nach getippter Antwort nicht gespeichert`);
        return saved;
      });
      if (done) {
        settled++;
        log(`[Rückfrage] ${choice.id}: per Nachricht beantwortet`);
      }
    }
  } catch (e) {
    log(`[Rückfrage] getippte Antwort nicht im Register vermerkt (${errorName(e)})`);
  }
  return settled;
}

// ---------------------------------------------------------------------------
// Entscheiden
// ---------------------------------------------------------------------------

export interface AskDeliverDeps {
  /** Antwort in ein reines Web-Gespräch; true, wenn sie dort steht */
  postWeb(conversationId: string, post: { text: string }): Promise<boolean>;
  /** Telegram mit auswertbarem Ergebnis: true nur, wenn jedes Stück angenommen ist */
  sendTelegram(chatId: string, text: string, threadId?: number): Promise<boolean>;
}

/**
 * Zustellweg der Antwort (deliver in AskChoicesDeps), wie src/bot.ts ihn
 * verdrahtet: reines Web-Gespräch über postWeb, Web-Direktchat ohne Telegram
 * nur über den gespeicherten Verlauf, sonst Telegram mit Ergebnis.
 */
export function createAskDeliver(deps: AskDeliverDeps): AskChoicesDeps["deliver"] {
  return async (conversation, text, saved) => {
    if (conversation.type === "web") return deps.postWeb(conversation.conversationId, { text });
    if (isWebChatId(conversation.chatId)) return saved;
    return deps.sendTelegram(conversation.chatId, text, conversation.topicId);
  };
}

export interface AskChoicesDeps {
  /** Meldung im Gespräch der Frage (Abbruch, Fehler); ohne Telegram nur WebUI */
  notify(conversation: ChoiceConversation, text: string): Promise<void>;
  /**
   * Antwort des Modells im Gespräch der Frage zeigen; saved sagt, ob sie
   * schon im Verlauf steht. true, wenn sie dort sichtbar ist
   */
  deliver(conversation: ChoiceConversation, text: string, saved: boolean): Promise<boolean>;
  /** saveMessage aus dem Nachrichtenspeicher; true, wenn gespeichert */
  saveMessage(message: ReturnType<typeof taskResumeRecord>["message"]): Promise<boolean>;
  /** Standard processTurnIntents (Tor für fremde Inhalte, intent-gate.ts) */
  processIntents?(text: string, tools: TurnTools | undefined, target: IntentTarget): Promise<unknown>;
  /** Standard getStore().tasks */
  tasks?: () => TaskStore;
  /** Standard resumeMacTask; channel ist der Kanal des Klicks (Kanalregeln im Prompt) */
  resume?: (task: AsyncTask, fallbackChatId: string, answer: string, channel: PromptChannel) => Promise<MacResumeOutcome>;
  /** Folgefrage anbieten; Standard offerAsk */
  offer?: (offer: AskOffer) => Promise<AskOfferOutcome>;
  log?: Log;
}

/** Kanalregeln für die Fortsetzung: Telegram nur bei einem Klick in Telegram, Browser und Terminal-Chat zeigen die WebUI-Regeln */
export function clickChannel(via: ChoiceChannel): PromptChannel {
  return via === "telegram" ? "telegram" : "web";
}

type Claim =
  | { status: "gone" }
  /** Schon mit einer getippten Nachricht beantwortet */
  | { status: "answered" }
  | { status: "stale"; why: string }
  | { status: "cancelled" }
  /** „Abbrechen" gewählt, aber der Status des Auftrags ist nicht gespeichert */
  | { status: "cancel-not-saved" }
  | { status: "not-saved" }
  | { status: "claimed"; task: AsyncTask; answer: string };

export function createAskChoices(deps: AskChoicesDeps): { handler: ChoiceHandler } {
  const log = deps.log ?? defaultLog;
  const tasks = deps.tasks ?? (() => getStore().tasks);
  const processIntents = deps.processIntents ?? processTurnIntents;
  const resume = deps.resume ?? ((task, chatId, answer, channel) => resumeMacTask(task, chatId, answer, undefined, channel));
  const offerFollowUp = deps.offer ?? offerAsk;

  /** true, wenn die Meldung zugestellt ist */
  async function say(choice: Choice, text: string): Promise<boolean> {
    try {
      await deps.notify(choice.conversation, text);
      return true;
    } catch (e) {
      log(`[Rückfrage] Meldung zu ${choice.id} nicht zugestellt (${errorName(e)})`);
      return false;
    }
  }

  /**
   * Status setzen, solange am Auftrag noch diese Frage steht. changes bekommt
   * den frisch gelesenen Auftrag (Metadaten einer Folgefrage gehen nicht
   * verloren). true, wenn gespeichert oder eine neuere Frage am Auftrag steht
   * (die bleibt unberührt); false bei false, Lesefehler (auch null) oder
   * Ausnahme, dann mit Hinweis im Gespräch: der Aufrufer endet mit einem
   * Handlerfehler.
   */
  async function finish(store: TaskStore, choice: Choice, taskId: string, askId: string, changes: (task: AsyncTask) => TaskChanges): Promise<boolean> {
    let ok = false;
    try {
      ok = await withTaskLock(taskId, async () => {
        const current = await store.byId(taskId);
        if (!current) {
          log(`[Rückfrage] ${choice.id}: Auftrag ${taskId} beim Abschluss nicht lesbar`);
          return false;
        }
        if (current.metadata?.ask_id !== askId) {
          log(`[Rückfrage] ${choice.id}: Auftrag ${taskId} hat eine neuere Rückfrage, Status bleibt`);
          return true;
        }
        if (await store.update(taskId, changes(current))) return true;
        log(`[Rückfrage] ${choice.id}: Status von Auftrag ${taskId} nicht gespeichert`);
        return false;
      });
    } catch (e) {
      log(`[Rückfrage] ${choice.id}: Status von Auftrag ${taskId} nicht gespeichert (${errorName(e)})`);
    }
    if (!ok) await say(choice, ASK_TEXT.statusNotSaved);
    return ok;
  }

  const handler: ChoiceHandler = async choice => {
    const ref = parseAskRef(choice.ref);
    const picked = choice.result;
    if (!ref || !picked) throw new Error("Rückfrage ohne Auftrag oder Auswahl");
    const store = tasks();

    // Prüfen und beanspruchen unter der Sperre des Auftrags: ohne gespeicherten Zustand kein Motoraufruf
    let claim: Claim;
    try {
      claim = await withTaskLock<Claim>(ref.taskId, async () => {
        const task = await store.byId(ref.taskId);
        if (!task) return { status: "gone" };
        if (answeredByText(task, ref.askId) && samePlace(task, choice.conversation)) return { status: "answered" };
        if (task.status !== "needs_input" || task.metadata?.ask_id !== ref.askId || !samePlace(task, choice.conversation)) {
          return { status: "stale", why: task.status };
        }
        if (picked.key === ASK_CANCEL) {
          let stored = false;
          try {
            stored = await store.update(task.id, { status: "failed", result: "Vom Nutzer abgebrochen", user_response: ASK_TEXT.cancelLabel });
          } catch (e) {
            log(`[Rückfrage] ${choice.id}: Status von Auftrag ${task.id} nicht gespeichert (${errorName(e)})`);
          }
          if (!stored) log(`[Rückfrage] ${choice.id}: Status von Auftrag ${task.id} nicht gespeichert`);
          return { status: stored ? "cancelled" : "cancel-not-saved" };
        }
        const answer = answerFor(task, picked.key);
        if (!answer) return { status: "stale", why: "Antwort fehlt" };
        let claimed = false;
        try {
          claimed = await store.update(task.id, { status: "running", user_response: answer });
        } catch (e) {
          log(`[Rückfrage] ${choice.id}: Auftrag ${task.id} nicht beansprucht (${errorName(e)})`);
        }
        return claimed ? { status: "claimed", task, answer } : { status: "not-saved" };
      });
    } catch (e) {
      log(`[Rückfrage] ${choice.id}: Auftrag ${ref.taskId} gesperrt (${errorName(e)})`);
      claim = { status: "not-saved" };
    }

    if (claim.status === "gone") {
      await say(choice, ASK_TEXT.gone);
      throw new Error("Auftrag fehlt");
    }
    if (claim.status === "answered") {
      await say(choice, ASK_TEXT.answeredByText);
      log(`[Rückfrage] ${choice.id}: schon per Nachricht beantwortet (${picked.via})`);
      return;
    }
    if (claim.status === "stale") {
      await say(choice, ASK_TEXT.stale);
      throw new Error(`Rückfrage überholt (${claim.why})`);
    }
    if (claim.status === "cancelled") {
      log(`[Rückfrage] ${choice.id}: abgebrochen (${picked.via})`);
      await say(choice, ASK_TEXT.cancelled);
      return;
    }
    if (claim.status === "cancel-not-saved") {
      await say(choice, ASK_TEXT.cancelled);
      await say(choice, ASK_TEXT.statusNotSaved);
      throw new Error(STATUS_NOT_SAVED);
    }
    if (claim.status === "not-saved") {
      await say(choice, ASK_TEXT.notSaved);
      throw new Error("Auftrag nicht gespeichert");
    }

    const { task, answer } = claim;
    const place = askTaskPlace(choice.conversation);
    /**
     * Während der Klick auf die Sperre der Session wartete, hat eine getippte
     * Nachricht die Frage beantwortet (settleTypedAnswer): der Motor setzt
     * dann nichts fort, der Auftrag bleibt completed. true, wenn so.
     */
    const lostToText = async (): Promise<boolean> => {
      let current: AsyncTask | null = null;
      try {
        current = await withTaskLock(task.id, () => store.byId(task.id));
      } catch {
        return false;
      }
      if (!current || !answeredByText(current, ref.askId)) return false;
      await say(choice, ASK_TEXT.answeredByText);
      log(`[Rückfrage] ${choice.id}: inzwischen per Nachricht beantwortet (${picked.via})`);
      return true;
    };
    let outcome: MacResumeOutcome;
    try {
      outcome = await resume(task, place.chatId, answer, clickChannel(picked.via));
    } catch (e) {
      if (await lostToText()) return;
      await finish(store, choice, task.id, ref.askId, () => ({ status: "failed", result: `Fortsetzen gescheitert (${errorName(e)})` }));
      await say(choice, ASK_TEXT.failed);
      throw e;
    }

    if (outcome.status === "aborted") {
      const stored = await finish(store, choice, task.id, ref.askId, () => ({ status: "failed", result: "Abgebrochen" }));
      await say(choice, ASK_TEXT.aborted);
      log(`[Rückfrage] ${choice.id}: Fortsetzen abgebrochen`);
      if (!stored) throw new Error(STATUS_NOT_SAVED);
      return;
    }
    if (outcome.status === "no-session") {
      const stored = await finish(store, choice, task.id, ref.askId, () => ({ status: "completed", result: "Ohne Sitzung bestätigt" }));
      await say(choice, ASK_TEXT.noted(answer));
      log(`[Rückfrage] ${choice.id}: keine Sitzung zum Fortsetzen`);
      if (!stored) throw new Error(STATUS_NOT_SAVED);
      return;
    }
    // Vom Motor gemeldeter Fehler oder Zeitlimit: keine Antwort, keine Merk-Tags
    if (outcome.result.isError || outcome.result.timedOut) {
      if (await lostToText()) return;
      const why = outcome.result.timedOut ? "Zeitlimit" : "Motorfehler";
      await finish(store, choice, task.id, ref.askId, () => ({ status: "failed", result: `Fortsetzen gescheitert (${why})` }));
      await say(choice, outcome.result.timedOut ? ASK_TEXT.timedOut : ASK_TEXT.failed);
      throw new Error(`Fortsetzen gescheitert (${why})`);
    }

    const done = outcome;
    // Tag einer Folgefrage lesbar machen, bevor irgendetwas gespeichert oder gezeigt wird
    const scan = scanForQuestion(done.result.text || "");
    const response = scan.text || ASK_TEXT.empty;
    const record = taskResumeRecord(task, place.chatId, {
      taskId: task.id,
      response,
      kind: "task_resume",
      origin: choice.conversation.type === "web" ? "Web-Gespraech (Rückfrage)" : "Telegram (Rückfrage)",
      agent: done.agent,
    });
    // Ab hier kein zweiter Motoraufruf: jeder Fehler wird vermerkt, die Antwort nie verworfen
    const problems: string[] = [];
    let saved = false;
    try {
      saved = (await deps.saveMessage(record.message)) === true;
    } catch (e) {
      log(`[Rückfrage] Antwort zu ${choice.id} nicht gespeichert (${errorName(e)})`);
    }
    if (!saved) problems.push("Antwort nicht gespeichert");
    let intentsError: unknown;
    try {
      await processIntents(response, done.result.tools, record.intents);
    } catch (e) {
      intentsError = e;
    }
    let shown = false;
    try {
      shown = (await deps.deliver(choice.conversation, response, saved)) === true;
    } catch (e) {
      log(`[Rückfrage] Antwort zu ${choice.id} nicht zugestellt (${errorName(e)})`);
    }
    if (!shown) {
      problems.push("Antwort nicht zugestellt");
      // Ersatzweg: die Antwort als Meldung (ohne Telegram in der WebUI)
      shown = await say(choice, response);
      log(`[Rückfrage] Antwort zu ${choice.id} ${shown ? "über den Meldeweg gezeigt" : "nirgends gezeigt"}`);
    }
    if (shown && !saved) await say(choice, ASK_TEXT.notStored);

    const finished = await finish(store, choice, task.id, ref.askId, current => ({
      // Gezeigt gilt als erledigt; nirgends gezeigt als gescheitert, die Antwort bleibt im Ergebnis
      status: shown ? "completed" : "failed",
      result: (shown ? response : `Antwort nicht zugestellt: ${response}`).slice(0, RESULT_MAX),
      session_id: done.result.sessionId || done.resumeId,
      // Folgefragen erben Motor und Modell der Fortsetzung ("" bleibt Standard des Motors)
      metadata: { ...(current.metadata ?? {}), engine: done.engine, model: done.model },
    }));
    if (!finished) problems.push(STATUS_NOT_SAVED);
    log(`[Rückfrage] ${choice.id}: fortgesetzt über ${done.engine} (${picked.via})`);
    // Folgefrage nur unter einer gezeigten Antwort, sonst stünde sie ohne Zusammenhang da
    if (scan.found && shown) {
      try {
        const next = await offerFollowUp({
          conversation: choice.conversation,
          question: scan.found.question,
          options: scan.found.options,
          originalPrompt: task.original_prompt,
          agent: done.agent,
          engine: done.engine,
          model: done.model,
          ...(done.result.sessionId || done.resumeId ? { sessionId: done.result.sessionId || done.resumeId } : {}),
        });
        log(`[Rückfrage] ${choice.id}: Folgefrage ${next.status}`);
      } catch (e) {
        log(`[Rückfrage] ${choice.id}: Folgefrage nicht angeboten (${errorName(e)})`);
      }
    }
    if (problems.length > 0) throw new Error(problems.join(", "));
    if (intentsError !== undefined) throw intentsError;
  };

  return { handler };
}
