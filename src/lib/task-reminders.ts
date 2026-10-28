/**
 * Erinnerungen an Aufträge, die auf eine Antwort warten (Issue #337). Ein
 * Lauf alle 15 Minuten aus src/bot.ts erledigt zwei Arten:
 *
 * Rückfragen des Registers (Art "ask", ask-choices.ts): fällig, wenn die
 * Frage offen und nicht abgelaufen ist, mindestens 2 Stunden alt, und ihr
 * Auftrag (ref) noch auf needs_input mit derselben askId steht. Erinnert
 * wird höchstens einmal je Frage, auch über Neustarts: unter der Sperre des
 * Auftrags (withTaskLock, dieselbe wie beim Entscheiden) kommt zuerst der
 * Merker metadata.ask_reminded = <askId> an den frisch gelesenen Auftrag,
 * gesendet wird erst danach und außerhalb der Sperre. Lässt sich der Merker
 * nicht speichern, wird nicht gesendet. Kommt die Erinnerung sicher nirgends
 * an, wird nur der eigene Merker wieder entfernt und die nächste Runde
 * versucht es erneut; bei unklarem Ausgang (Netzfehler, keine Antwort von
 * Telegram) bleibt er stehen, lieber keine Erinnerung als zwei. Ein Absturz
 * zwischen Merker und Senden heißt ebenso: keine Erinnerung.
 * Die Erinnerung ist dieselbe Rückfrage (gleiche choiceId) mit einem
 * Erinnerungssatz davor, auf dem Weg der Frage selbst (createAskReminderShow):
 * Telegram mit Knöpfen, die neue Nachricht wird am Eintrag gemerkt und beim
 * Entscheiden mit nachgezogen; reines Web-Gespräch als Meldung mit choiceId
 * und Kopie im Direktchat; Web-Direktchat ohne Telegram über die WebUI. Es
 * entsteht keine neue Rückfrage und kein neuer Auftrag. Nicht in der
 * Ruhezeit der offenen Fäden (threads/schedule.ts, Standard 21 bis 8 Uhr):
 * fällige Erinnerungen kommen dann in der ersten Runde danach.
 *
 * Alte Aufträge (ohne askId, aus der Zeit vor dem Register und von den
 * Prozessoren mit ask_user): wartend, noch nicht erinnert (reminder_sent),
 * älter als 2 Stunden und im Direktchat: einmal mit atask-Knöpfen über den
 * Meldeweg (bot-notices.ts), danach reminder_sent. Ein Auftrag mit askId
 * bekommt nie atask-Knöpfe.
 *
 * Ins Log kommen nur Kennungen, nie Frage- oder Auftragstexte.
 */

import { ASK_SOURCE, askTaskPlace, parseAskRef, withTaskLock } from "./ask-choices";
import { getChoice as realGetChoice, listChoices as realListChoices, type Choice, type ChoiceTelegramRef } from "./choices";
import type { SendAndRecordInput, SendAndRecordResult } from "./outbox";
import type { PostWeb } from "./review-choices";
import { storeOr } from "./store";
import type { TaskStore } from "./store/ports";
import type { AsyncTask } from "./store/types";
import { isDirectPlace, placeOfTask } from "./task-place";
import { sendChoice } from "./telegram-choices";
import { isQuietTime, quietHours, reminderTimeZone } from "./threads/schedule";

/** Ab diesem Alter wird an eine wartende Frage erinnert */
export const TASK_REMINDER_AFTER_MS = 2 * 3_600_000;

export const TASK_REMINDER_TEXT = {
  ask: (question: string) => `Erinnerung: Ich warte noch auf deine Antwort.\n\n${question}`,
  legacy: (question: string) => `Erinnerung: Bei diesem Auftrag warte ich noch auf deine Antwort.\n\n${question}`,
  cancelLabel: "Abbrechen",
} as const;

/** So viele Zeichen des Auftrags stehen in der Erinnerung, wenn keine Frage gespeichert ist */
const PROMPT_MAX = 200;

/** Ausgang einer Zustellung: gezeigt, sicher nirgends angekommen oder unklar */
export type ReminderDelivery = "shown" | "failed" | "unclear";

/** Rückfrage erneut zeigen, mit anderem Text, aber derselben choiceId */
export type AskReminderShow = (choice: Choice, text: string) => Promise<ReminderDelivery>;

/** Meldeweg aus bot-notices.ts: mit Telegram samt Knöpfen, ohne nur in der WebUI. true, wenn zugestellt */
export type LegacyTaskNotify = (
  text: string,
  target: { chatId: string; buttons: { text: string; callback_data: string }[][] }
) => Promise<boolean>;

type Log = (line: string) => void;
const errorName = (e: unknown) => (e instanceof Error ? e.name : "Fehler");

// ---------------------------------------------------------------------------
// Zustellweg der Register-Erinnerung
// ---------------------------------------------------------------------------

export interface AskReminderShowDeps {
  /** Telegram eingerichtet? */
  telegram(): boolean;
  /** sendAndRecord aus outbox.ts */
  send(input: SendAndRecordInput): Promise<SendAndRecordResult>;
  /** Zieht die neue Nachricht nach, wenn die Frage während des Sendens entschieden wurde (refreshChoiceMessages) */
  refresh(choice: Choice, refs: ChoiceTelegramRef[]): Promise<unknown>;
  /** Reines Web-Gespräch; nur im Bot-Prozess mit WebUI */
  postWeb?: PostWeb;
  log?: Log;
}

/**
 * Zeigt die Frage wie offerAsk: reines Web-Gespräch als Meldung mit choiceId
 * und Kopie im Direktchat, sonst über sendChoice (Telegram samt Merken der
 * Nachricht, ohne Telegram für die WebUI festgehalten). Gezeigt heißt: an
 * einer Stelle angekommen, eine gescheiterte Kopie ändert daran nichts;
 * ebenso, wenn von einer langen Erinnerung schon ein Stück ankam und erst
 * ein späteres scheiterte. Unklar ist der Ausgang, wenn Telegram nicht
 * sicher abgelehnt hat.
 */
export function createAskReminderShow(deps: AskReminderShowDeps): AskReminderShow {
  const log = deps.log ?? (line => console.log(line));
  return async (choice, text) => {
    let web = false;
    if (choice.conversation.type === "web" && deps.postWeb) {
      try {
        web = await deps.postWeb(choice.conversation.conversationId, { text, kind: "notice", source: ASK_SOURCE, choiceId: choice.id });
      } catch (e) {
        log(`[Erinnerung] ${choice.id} nicht ins Web-Gespräch gelegt (${errorName(e)})`);
      }
    }
    // Erstes Senden festhalten: sendChoice sagt nur gesendet oder nicht, nicht ob sicher abgelehnt
    let first: SendAndRecordResult | "threw" | undefined;
    const send = async (input: SendAndRecordInput) => {
      try {
        const result = await deps.send(input);
        first ??= result;
        return result;
      } catch (e) {
        first ??= "threw";
        throw e;
      }
    };
    const result = await sendChoice({ ...choice, text }, { send, telegram: deps.telegram, refresh: deps.refresh, log });
    if (web || result.sent) return "shown";
    // Nichts versucht (Frage nicht mehr offen, ohne Telegram keine Kopie eines Web-Gesprächs)
    if (first === undefined) return "failed";
    if (first === "threw") return "unclear";
    // Ein Stück kam an, ein späteres nicht: die Erinnerung ist zu sehen, der Merker bleibt
    if (first.messages?.length) {
      log(`[Erinnerung] ${choice.id} nur teilweise zugestellt`);
      return "shown";
    }
    return first.error?.kind === "send" && !first.error.rejected ? "unclear" : "failed";
  };
}

// ---------------------------------------------------------------------------
// Lauf
// ---------------------------------------------------------------------------

export interface TaskReminderDeps {
  showAsk: AskReminderShow;
  notifyLegacy: LegacyTaskNotify;
  /** Chat-IDs des Direktchats (task-place.ts directChatIds) */
  directChatIds(): string[];
  /** Standard getStore().tasks, ohne Datenbank leer */
  tasks?: () => Pick<TaskStore, "byId" | "update" | "stale">;
  /** Standard listChoices aus choices.ts */
  listChoices?: () => Promise<Choice[]>;
  /** Standard getChoice aus choices.ts */
  getChoice?: (id: string) => Promise<Choice | undefined>;
  now?: () => number;
  /** Standard: Ruhezeit der offenen Fäden in USER_TIMEZONE */
  isQuiet?: (now: number) => boolean;
  /** Standard withTaskLock aus ask-choices.ts */
  lock?: <T>(taskId: string, fn: () => Promise<T>) => Promise<T>;
  log?: Log;
}

export interface TaskReminderRun {
  /** Erinnerte Rückfragen des Registers */
  asks: number;
  /** Erinnerte alte Aufträge */
  legacy: number;
}

const defaultTasks = (): Pick<TaskStore, "byId" | "update" | "stale"> => ({
  byId: id => storeOr(null, store => store.tasks.byId(id)),
  update: (id, changes) => storeOr(false, store => store.tasks.update(id, changes)),
  stale: olderThanMs => storeOr([], store => store.tasks.stale(olderThanMs)),
});

/** Metadaten ohne den eigenen Merker */
function withoutMarker(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const { ask_reminded: _, ...rest } = metadata ?? {};
  return rest;
}

export function createTaskReminders(deps: TaskReminderDeps): {
  run(): Promise<TaskReminderRun>;
  remindAsks(): Promise<number>;
  remindLegacy(): Promise<number>;
} {
  const log = deps.log ?? (line => console.log(line));
  const tasks = deps.tasks ?? defaultTasks;
  const list = deps.listChoices ?? realListChoices;
  const get = deps.getChoice ?? realGetChoice;
  const now = deps.now ?? (() => Date.now());
  const isQuiet = deps.isQuiet ?? (ts => isQuietTime(ts, reminderTimeZone(), quietHours()));
  const lock = deps.lock ?? withTaskLock;

  /** Gehört der Auftrag genau zum Gespräch der Frage? (so legt offerAsk ihn an) */
  function sameConversation(task: AsyncTask, choice: Choice): boolean {
    const place = askTaskPlace(choice.conversation);
    return task.chat_id === place.chatId && placeOfTask(task).threadId === place.threadId;
  }

  type Mark = "marked" | "not-due" | "not-saved";

  async function mark(store: Pick<TaskStore, "byId" | "update">, choice: Choice, taskId: string, askId: string): Promise<Mark> {
    return lock<Mark>(taskId, async () => {
      const task = await store.byId(taskId);
      if (!task || task.status !== "needs_input" || task.metadata?.ask_id !== askId || !sameConversation(task, choice)) return "not-due";
      if (task.metadata?.ask_reminded === askId) return "not-due";
      let saved = false;
      try {
        saved = await store.update(taskId, { metadata: { ...(task.metadata ?? {}), ask_reminded: askId } });
      } catch (e) {
        log(`[Erinnerung] Merker an Auftrag ${taskId} nicht gespeichert (${errorName(e)})`);
      }
      return saved ? "marked" : "not-saved";
    });
  }

  /** Nur den eigenen Merker entfernen; eine neuere Frage oder ein anderer Merker bleibt */
  async function unmark(store: Pick<TaskStore, "byId" | "update">, taskId: string, askId: string): Promise<void> {
    try {
      await lock(taskId, async () => {
        const task = await store.byId(taskId);
        if (!task || task.metadata?.ask_reminded !== askId) return;
        if (!(await store.update(taskId, { metadata: withoutMarker(task.metadata) }))) {
          log(`[Erinnerung] Merker an Auftrag ${taskId} nicht entfernt`);
        }
      });
    } catch (e) {
      log(`[Erinnerung] Merker an Auftrag ${taskId} nicht entfernt (${errorName(e)})`);
    }
  }

  async function remindAsk(store: Pick<TaskStore, "byId" | "update">, choice: Choice): Promise<boolean> {
    const ref = parseAskRef(choice.ref);
    if (!ref) return false;
    let marked: Mark;
    try {
      marked = await mark(store, choice, ref.taskId, ref.askId);
    } catch (e) {
      log(`[Erinnerung] Auftrag ${ref.taskId} gesperrt (${errorName(e)})`);
      return false;
    }
    // Nicht fällig oder Merker nicht gespeichert: nichts senden
    if (marked !== "marked") return false;

    // Inzwischen entschieden oder abgelaufen: keine Erinnerung, der Merker stört nicht
    let current: Choice | undefined;
    try {
      current = await get(choice.id);
    } catch (e) {
      log(`[Erinnerung] ${choice.id} nicht lesbar (${errorName(e)})`);
    }
    if (!current || current.state !== "open") {
      if (!current) await unmark(store, ref.taskId, ref.askId);
      return false;
    }

    let outcome: ReminderDelivery;
    try {
      outcome = await deps.showAsk(current, TASK_REMINDER_TEXT.ask(current.text));
    } catch (e) {
      log(`[Erinnerung] ${choice.id} nicht zugestellt (${errorName(e)})`);
      outcome = "unclear";
    }
    if (outcome === "shown") {
      log(`[Erinnerung] Rückfrage ${choice.id} erinnert`);
      return true;
    }
    if (outcome === "unclear") {
      log(`[Erinnerung] ${choice.id}: Zustellung unklar, keine zweite Erinnerung`);
      return false;
    }
    log(`[Erinnerung] ${choice.id} nirgends zugestellt, nächste Runde erneut`);
    await unmark(store, ref.taskId, ref.askId);
    return false;
  }

  async function remindAsks(): Promise<number> {
    const at = now();
    if (isQuiet(at)) return 0;
    let choices: Choice[];
    try {
      choices = await list();
    } catch (e) {
      log(`[Erinnerung] Register nicht lesbar (${errorName(e)})`);
      return 0;
    }
    const due = choices
      .filter(c => c.kind === "ask" && c.state === "open" && at - c.createdAt >= TASK_REMINDER_AFTER_MS)
      .sort((a, b) => a.createdAt - b.createdAt);
    if (due.length === 0) return 0;
    const store = tasks();
    let reminded = 0;
    for (const choice of due) if (await remindAsk(store, choice)) reminded++;
    return reminded;
  }

  function legacyButtons(task: AsyncTask): { text: string; callback_data: string }[][] {
    const options = Array.isArray(task.pending_options) ? task.pending_options : [];
    const rows = options
      .filter(o => typeof o?.label === "string" && typeof o?.value === "string" && o.label !== "" && o.value !== "")
      .map(o => [{ text: o.label, callback_data: `atask:${task.id}:${o.value}` }]);
    return [...rows, [{ text: TASK_REMINDER_TEXT.cancelLabel, callback_data: `atask:${task.id}:cancel` }]];
  }

  async function remindLegacy(): Promise<number> {
    const store = tasks();
    let stale: AsyncTask[];
    try {
      stale = await store.stale(TASK_REMINDER_AFTER_MS);
    } catch (e) {
      log(`[Erinnerung] wartende Aufträge nicht lesbar (${errorName(e)})`);
      return 0;
    }
    const direct = deps.directChatIds();
    let reminded = 0;
    for (const task of stale) {
      // Aufträge des Registers erinnert remindAsks, nie mit atask-Knöpfen
      if (typeof task.metadata?.ask_id === "string") continue;
      if (task.status !== "needs_input" || task.reminder_sent) continue;
      if (!isDirectPlace(placeOfTask(task), direct)) continue;
      const question = task.pending_question?.trim() || task.original_prompt.slice(0, PROMPT_MAX);
      try {
        if (!(await deps.notifyLegacy(TASK_REMINDER_TEXT.legacy(question), { chatId: task.chat_id, buttons: legacyButtons(task) }))) continue;
      } catch (e) {
        log(`[Erinnerung] Auftrag ${task.id} nicht erinnert (${errorName(e)})`);
        continue;
      }
      reminded++;
      try {
        if (!(await store.update(task.id, { reminder_sent: true }))) log(`[Erinnerung] Auftrag ${task.id}: Erinnerung nicht vermerkt`);
      } catch (e) {
        log(`[Erinnerung] Auftrag ${task.id}: Erinnerung nicht vermerkt (${errorName(e)})`);
      }
    }
    return reminded;
  }

  return {
    remindAsks,
    remindLegacy,
    run: async () => ({ asks: await remindAsks(), legacy: await remindLegacy() }),
  };
}
