/**
 * Alte Knöpfe atask:<taskId>:<auswahl> im Bot-Prozess (Issue #337). Neue
 * Rückfragen laufen über das Register (ask-choices.ts); diese Knöpfe stammen
 * aus Erinnerungen an alte Aufträge (task-reminders.ts), vom früheren Agent
 * SDK und aus der Zeit des früheren Gateways (Aufträge mit messages_snapshot).
 *
 * Beanspruchen (claimLegacyTaskButton): Aufträge des Registers (mit askId)
 * und nicht lesbare Aufträge weist claimLegacyTaskCallback ab wie bisher; ein
 * unbekannter Auftrag ist für den Speicher dasselbe (byId liefert null) und
 * bekommt dieselbe Meldung. Danach unter der Sperre des Auftrags (dieselbe
 * wie im Register): frisch lesen, Gespräch prüfen (task-place.ts: die
 * Nachricht mit dem Knopf muss im Gespräch des Auftrags stehen), Zustand
 * prüfen (nur needs_input ist entscheidbar), Auswahl gegen pending_options
 * prüfen und erst dann auf running bzw. bei „Abbrechen" auf failed setzen.
 * Ein zweiter Klick, auch gleichzeitig, findet running und wird abgewiesen,
 * der Motor läuft genau einmal. Lässt sich das Beanspruchen nicht speichern,
 * läuft kein Motor, der Auftrag bleibt entscheidbar und die Nachricht
 * behält ihre Knöpfe (keepButtons).
 *
 * Fortsetzen im Mac-Zweig (resumeLegacyMacTask): über resumeMacTask
 * (task-resume.ts), wie die Rückfragen des Registers. Endet die Antwort
 * wieder mit einer Rückfrage, entscheidet scanForQuestion (turn-questions.ts)
 * vor dem Speichern; die Folgefrage geht per offerAsk als Rückfrage des
 * Registers an einem neuen Auftrag, mit Session, Motor und Modell der
 * Fortsetzung, der alte Auftrag wird completed. Neue atask-Knöpfe entstehen
 * hier nicht. Ein Motorfehler oder Zeitlimit wird nie als Antwort gezeigt,
 * gespeichert oder auf Merk-Tags ausgewertet. Gezeigt ist die Antwort nur,
 * wenn der Zustellweg mindestens einen angekommenen Teil meldet; sonst gibt
 * es keine Folgefrage und keinen offenen Faden.
 *
 * Der Zweig für messages_snapshot steht in der Knopf-Weiche
 * (src/channels/telegram/callbacks.ts, Issue #338). Aufträge mit
 * messages_snapshot setzt seit Issue #348 der Motor api fort und schließt
 * über resumeLegacyMacTask ab. Alte Aufträge des Agent SDK laufen seit
 * Issue #349 wie alle übrigen über resumeLegacyMacTask; das SDK selbst ist
 * seit Issue #352 entfernt.
 *
 * Ins Log kommen nur Kennungen, nie Frage-, Antwort- oder Auftragstexte.
 */

import type { Context } from "grammy";
import { ASK_TEXT, claimLegacyTaskCallback, offerAsk, withTaskLock, type AskOffer, type AskOfferOutcome } from "./ask-choices";
import type { ChoiceConversation } from "./choices";
import { processTurnIntents, type IntentTarget } from "./intent-gate";
import { getStore } from "./store";
import type { TaskStore } from "./store/ports";
import type { AsyncTask, TaskChanges } from "./store/types";
import { placeOfTask, samePlace, type TaskPlace } from "./task-place";
import { resumeMacTask, taskEngine, taskResumeRecord, type MacResumeOutcome } from "./task-resume";
import type { TurnTools } from "./turn-tools";
import { scanForQuestion } from "./turn-questions";

export const LEGACY_TASK_TEXT = {
  answered: "Diese Frage ist bereits beantwortet, der Auftrag läuft. Nichts fortgesetzt.",
  done: "Dieser Auftrag ist bereits erledigt, nichts fortgesetzt.",
  foreign: "Dieser Knopf gehört zu einem anderen Gespräch, nichts fortgesetzt.",
  unknownOption: "Diese Auswahl gibt es nicht, nichts fortgesetzt.",
  notSaved: "Die Auswahl ließ sich gerade nicht speichern, nichts fortgesetzt. Bitte gleich nochmal tippen.",
  cancelLabel: "Abbrechen",
  question: "Rückfrage",
  cancelled: (question: string) => `${question}\n\nAbgebrochen.`,
  chosen: (question: string, answer: string) => `${question}\n\nGewählt: ${answer}`,
  completed: "Erledigt.",
} as const;

const TASK_ID = /^[A-Za-z0-9-]{1,64}$/;
const QUESTION_MAX = 500;
const RESULT_MAX = 10_000;

type Log = (line: string) => void;
const defaultLog: Log = line => console.log(line);
const errorName = (e: unknown) => (e instanceof Error ? e.name : "Fehler");

export type LegacyTaskClaim =
  /** Abgewiesen; keepButtons: die Knöpfe bleiben gültig, die Meldung kommt als neue Nachricht */
  | { status: "rejected"; text: string; keepButtons: boolean }
  | { status: "cancelled"; text: string }
  /** Beansprucht (running); answer ist die Beschriftung der Auswahl, text die nachgezogene Nachricht */
  | { status: "claimed"; task: AsyncTask; answer: string; text: string };

export interface LegacyTaskButtonDeps {
  /** Chat-IDs des Direktchats (task-place.ts directChatIds) */
  directChatIds(): string[];
  /** Standard getStore().tasks */
  tasks?: () => TaskStore;
  /** Standard withTaskLock aus ask-choices.ts */
  lock?: <T>(taskId: string, fn: () => Promise<T>) => Promise<T>;
  log?: Log;
}

/** atask:<taskId>:<auswahl>; null, wenn die Daten so nicht von einem Auftrag stammen */
export function parseLegacyTaskButton(data: string): { taskId: string; choice: string } | null {
  const match = /^atask:([^:]*):(.+)$/s.exec(data);
  if (!match || !TASK_ID.test(match[1])) return null;
  return { taskId: match[1], choice: match[2] };
}

const reject = (text: string, keepButtons = false): LegacyTaskClaim => ({ status: "rejected", text, keepButtons });

function questionOf(task: AsyncTask): string {
  const question = typeof task.pending_question === "string" ? task.pending_question.trim() : "";
  return (question || LEGACY_TASK_TEXT.question).slice(0, QUESTION_MAX);
}

/** Knopf eines alten Auftrags beanspruchen; wirft nicht */
export async function claimLegacyTaskButton(data: string, place: TaskPlace, deps: LegacyTaskButtonDeps): Promise<LegacyTaskClaim> {
  const log = deps.log ?? defaultLog;
  const tasks = deps.tasks ?? (() => getStore().tasks);
  const lock = deps.lock ?? withTaskLock;
  const parsed = parseLegacyTaskButton(data);
  // Eine Kennung, die nie ein Auftrag war: wie ein unbekannter Auftrag
  if (!parsed) return reject(ASK_TEXT.stale);
  const { taskId, choice } = parsed;

  async function update(changes: TaskChanges): Promise<boolean> {
    try {
      return (await tasks().update(taskId, changes)) === true;
    } catch (e) {
      log(`[atask] Auftrag ${taskId} nicht gespeichert (${errorName(e)})`);
      return false;
    }
  }

  const claim = async (): Promise<LegacyTaskClaim> =>
    lock<LegacyTaskClaim>(taskId, async () => {
      const task = await tasks().byId(taskId);
      if (!task || typeof task.metadata?.ask_id === "string") return reject(ASK_TEXT.stale);
      if (!samePlace(placeOfTask(task), place, deps.directChatIds())) {
        log(`[atask] Knopf zu Auftrag ${taskId} aus einem anderen Gespräch`);
        return reject(LEGACY_TASK_TEXT.foreign);
      }
      if (task.status === "running") return reject(LEGACY_TASK_TEXT.answered);
      if (task.status !== "needs_input") return reject(LEGACY_TASK_TEXT.done);
      const question = questionOf(task);
      if (choice === "cancel") {
        if (!(await update({ status: "failed", result: "Vom Nutzer abgebrochen", user_response: LEGACY_TASK_TEXT.cancelLabel }))) {
          return reject(LEGACY_TASK_TEXT.notSaved, true);
        }
        log(`[atask] Auftrag ${taskId} abgebrochen`);
        return { status: "cancelled", text: LEGACY_TASK_TEXT.cancelled(question) };
      }
      const option = Array.isArray(task.pending_options)
        ? task.pending_options.find(o => o?.value === choice && typeof o.label === "string" && o.label !== "")
        : undefined;
      if (!option) return reject(LEGACY_TASK_TEXT.unknownOption, true);
      if (!(await update({ status: "running", user_response: option.label }))) return reject(LEGACY_TASK_TEXT.notSaved, true);
      return { status: "claimed", task, answer: option.label, text: LEGACY_TASK_TEXT.chosen(question, option.label) };
    });

  try {
    const outcome = await claimLegacyTaskCallback<LegacyTaskClaim>(data, claim, tasks);
    return outcome.register ? reject(ASK_TEXT.stale) : outcome.result;
  } catch (e) {
    log(`[atask] Auftrag ${taskId} nicht beansprucht (${errorName(e)})`);
    return reject(LEGACY_TASK_TEXT.notSaved, true);
  }
}

/**
 * Antwort mit Ergebnis: schickt über send (in Telegram sendResponse, das
 * verlorene Stücke nur loggt und normal zurückkehrt) mit einem Context, der
 * mitzählt, was Telegram angenommen hat. true, wenn mindestens eine
 * Nachricht (Text, Foto oder Sprache) ankam; Ausnahmen von send gehen weiter.
 */
export async function replyWithReceipt<C extends Context>(ctx: C, text: string, send: (ctx: C, text: string) => Promise<unknown>): Promise<boolean> {
  let delivered = false;
  const counted = (name: "reply" | "replyWithPhoto" | "replyWithVoice"): PropertyDescriptor => ({
    value: async (...args: unknown[]) => {
      const sent = await (ctx[name] as (...a: unknown[]) => Promise<unknown>).apply(ctx, args);
      delivered = true;
      return sent;
    },
  });
  const tracked = Object.create(ctx, { reply: counted("reply"), replyWithPhoto: counted("replyWithPhoto"), replyWithVoice: counted("replyWithVoice") }) as C;
  await send(tracked, text);
  return delivered;
}

// ---------------------------------------------------------------------------
// Fortsetzen im Mac-Zweig
// ---------------------------------------------------------------------------

export interface LegacyMacResumeDeps {
  /** Gespräch der Nachricht mit dem Knopf; dort landet eine Folgefrage */
  conversation: ChoiceConversation;
  /**
   * Antwort des Modells zeigen (in Telegram replyWithReceipt um
   * sendResponse); true nur, wenn mindestens ein Teil ankam. false oder eine
   * Ausnahme heißt: nicht gezeigt
   */
  reply(text: string): Promise<boolean>;
  /** Kurze Meldung (Abbruch, Fehler); Fehler dabei werden nur geloggt */
  notice(text: string): Promise<void>;
  /** saveMessage aus dem Nachrichtenspeicher */
  saveMessage(message: ReturnType<typeof taskResumeRecord>["message"]): Promise<unknown>;
  /** Meldung nach /stop bzw. beim Herunterfahren */
  abortedText(): string;
  /** Standard getStore().tasks */
  tasks?: () => Pick<TaskStore, "update">;
  /** Standard resumeMacTask */
  resume?: (task: AsyncTask, fallbackChatId: string, answer: string) => Promise<MacResumeOutcome>;
  /** Standard processTurnIntents */
  processIntents?(text: string, tools: TurnTools | undefined, target: IntentTarget): Promise<unknown>;
  /** Folgefrage anbieten; Standard offerAsk */
  offer?: (offer: AskOffer) => Promise<AskOfferOutcome>;
  log?: Log;
}

export type LegacyMacOutcome =
  /** Antwort gezeigt; für die offenen Fäden (src/channels/telegram/callbacks.ts) */
  | { status: "replied"; response: string }
  | { status: "ended" };

/** Setzt einen beanspruchten alten Auftrag über resumeMacTask fort; wirft nicht */
export async function resumeLegacyMacTask(task: AsyncTask, answer: string, place: TaskPlace, deps: LegacyMacResumeDeps): Promise<LegacyMacOutcome> {
  const log = deps.log ?? defaultLog;
  const tasks = deps.tasks ?? (() => getStore().tasks);
  const resume = deps.resume ?? ((t, chatId, a) => resumeMacTask(t, chatId, a));
  const processIntents = deps.processIntents ?? processTurnIntents;
  const offerFollowUp = deps.offer ?? offerAsk;

  async function setStatus(changes: TaskChanges): Promise<void> {
    try {
      if (!(await tasks().update(task.id, changes))) log(`[atask] Status von Auftrag ${task.id} nicht gespeichert`);
    } catch (e) {
      log(`[atask] Status von Auftrag ${task.id} nicht gespeichert (${errorName(e)})`);
    }
  }
  async function say(text: string): Promise<void> {
    try {
      await deps.notice(text);
    } catch (e) {
      log(`[atask] Meldung zu Auftrag ${task.id} nicht zugestellt (${errorName(e)})`);
    }
  }

  let outcome: MacResumeOutcome;
  try {
    outcome = await resume(task, place.chatId, answer);
  } catch (e) {
    log(`[atask] Auftrag ${task.id} nicht fortgesetzt (${errorName(e)})`);
    await setStatus({ status: "failed", result: `Fortsetzen gescheitert (${errorName(e)})` });
    await say(ASK_TEXT.failed);
    return { status: "ended" };
  }
  if (outcome.status === "aborted") {
    await setStatus({ status: "failed", result: "Abgebrochen" });
    await say(deps.abortedText());
    return { status: "ended" };
  }
  if (outcome.status === "no-session") {
    await setStatus({ status: "completed", result: "Ohne Sitzung bestätigt" });
    await say(ASK_TEXT.noted(answer));
    return { status: "ended" };
  }
  if (outcome.result.isError || outcome.result.timedOut) {
    const why = outcome.result.timedOut ? "Zeitlimit" : "Motorfehler";
    await setStatus({ status: "failed", result: `Fortsetzen gescheitert (${why})` });
    await say(outcome.result.timedOut ? ASK_TEXT.timedOut : ASK_TEXT.failed);
    return { status: "ended" };
  }

  const done = { ...outcome, engine: outcome.engine ?? taskEngine(task).engine, model: outcome.model ?? taskEngine(task).model ?? "" };
  // Rückfrage-Tag lesbar machen, bevor irgendetwas gespeichert oder gezeigt wird
  const scan = scanForQuestion(done.result.text || "");
  const response = scan.text || LEGACY_TASK_TEXT.completed;
  const sessionId = done.result.sessionId || done.resumeId;
  const record = taskResumeRecord(task, place.chatId, { taskId: task.id, response, kind: "task_resume", origin: "Telegram", agent: done.agent });
  try {
    await deps.saveMessage(record.message);
  } catch (e) {
    log(`[atask] Antwort zu Auftrag ${task.id} nicht gespeichert (${errorName(e)})`);
  }
  try {
    await processIntents(response, done.result.tools, record.intents);
  } catch (e) {
    log(`[atask] Merk-Tags zu Auftrag ${task.id} nicht ausgewertet (${errorName(e)})`);
  }
  let shown = false;
  try {
    shown = (await deps.reply(response)) === true;
    if (!shown) log(`[atask] Antwort zu Auftrag ${task.id} nicht zugestellt`);
  } catch (e) {
    log(`[atask] Antwort zu Auftrag ${task.id} nicht zugestellt (${errorName(e)})`);
  }
  await setStatus({
    status: "completed",
    result: response.slice(0, RESULT_MAX),
    ...(sessionId ? { session_id: sessionId } : {}),
    metadata: { ...(task.metadata ?? {}), engine: done.engine, model: done.model },
  });
  // Folgefrage nur unter einer gezeigten Antwort, als Rückfrage des Registers an einem neuen Auftrag
  if (scan.found && shown) {
    try {
      const next = await offerFollowUp({
        conversation: deps.conversation,
        question: scan.found.question,
        options: scan.found.options,
        originalPrompt: task.original_prompt,
        agent: done.agent,
        engine: done.engine,
        model: done.model,
        ...(sessionId ? { sessionId } : {}),
      });
      log(`[atask] Auftrag ${task.id}: Folgefrage ${next.status}`);
    } catch (e) {
      log(`[atask] Auftrag ${task.id}: Folgefrage nicht angeboten (${errorName(e)})`);
    }
  }
  return shown ? { status: "replied", response } : { status: "ended" };
}
