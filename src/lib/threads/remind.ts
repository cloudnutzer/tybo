/**
 * Erinnerungen an offene Fäden (Issue #292, Entscheidung 0025): Zeitgeber im
 * Bot-Prozess, alle 15 Minuten ein Durchgang.
 *
 * Zustellung höchstens einmal: Ist nach einem Versand unklar, ob die
 * Erinnerung ankam, gilt sie als zugestellt und wird nicht wiederholt. Neu
 * gesendet wird nur, wenn sicher ist, dass nichts ankam. Dafür trägt der Faden
 * einen persistenten Versandauftrag (Thread.reminder, Zustand "ready" oder
 * "sending"); jede Änderung läuft unter der Sperre der Ablage (updateThreads).
 *
 * Je fälligem offenem Faden (nextReminderAt <= jetzt):
 * 1. Unter Sperre: noch offen und fällig, kein Auftrag in "sending". Hat er
 *    schon zwei Erinnerungen, wird er still geschlossen ("keine Antwort").
 *    Telegram-Gespräch ohne Telegram: nur verschoben, einmal ins Log. Sonst
 *    reminder = { step: reminders + 1, attempts (erhalten), state "ready" }.
 * 2. Rückfrage anlegen (Art thread, ref Faden-ID).
 * 3. Unter Sperre den Auftrag exklusiv übernehmen: Rückfrage noch offen,
 *    Faden noch offen, derselbe Auftrag (Stufe, Versuche, "ready") und
 *    derselbe Termin. Sonst nicht senden und die eigene Rückfrage ablaufen
 *    lassen. Dann choiceId, attempts + 1, state "sending". Erst danach laufen
 *    die übrigen offenen Rückfragen desselben Fadens ab (alte Erinnerung,
 *    verwaiste Rückfrage nach einem Absturz, Rückfrage eines zweiten
 *    Durchgangs). Das Ersetzen geschieht also nach der Übernahme statt beim
 *    Anlegen: so kann ein zweiter, gleichzeitiger Durchgang nie die Rückfrage
 *    des Übernehmenden ablaufen lassen.
 * 4. Senden (sendThreadReminder in thread-choices.ts).
 * 5. Unter Sperre auswerten, nur wenn der Auftrag noch derselbe ist (ein
 *    Klick oder ein Schließen dazwischen wird nie überschrieben):
 *    zugestellt oder unklar: reminders = step, neuer Termin, hintPending;
 *    sicher nicht zugestellt: zurück auf "ready", nach 3 Versuchen gilt die
 *    Stufe als verbraucht (ohne Hinweis), die Rückfrage läuft ab.
 *
 * Wiederaufnahme: "ready" wird fortgesetzt, "sending" heißt Ausgang unbekannt
 * und wird wie unklar ausgewertet, nie neu gesendet.
 *
 * Gespräch weg (still schließen): nur ein Web-Gespräch, das es im Speicher
 * sicher nicht mehr gibt, oder ein Topic mit dem Merker deleted. Ein
 * Sendefehler, ein geschlossenes Topic oder ein fehlender Name beweisen das nicht.
 *
 * Höchstens 5 Versände je Durchgang. Zur Ruhezeit (Standard 21 bis 8 Uhr Ortszeit, einstellbar)
 * sendet ein Durchgang nichts; geprüft wird vor jedem Faden, bei der
 * Übernahme und unmittelbar vor dem Versand. Dort wird unter Sperre auch
 * geprüft, ob der Auftrag noch derselbe ist (Schließen oder Verschieben
 * während des Abräumens: kein Versand). Beginnt sie nach der Übernahme,
 * geht der Auftrag mit den Versuchen von vorher zurück auf "ready", die
 * eigene Rückfrage läuft ab und die Stufe bleibt offen.
 * Jeder Durchgang gibt Altbeständen ohne Termin einen (fillMissingReminders)
 * und räumt Rückfragen geschlossener Fäden ab (sweepThreadChoices).
 * Ins Log kommen nur Faden- und Rückfrage-IDs.
 */

import {
  createChoice as realCreateChoice,
  expireChoice as realExpireChoice,
  getChoice,
  listChoices as realListChoices,
  type Choice,
  type ChoiceConversation,
  type ChoiceTelegramRef,
  type CreateChoiceInput,
  type CreateChoiceOptions,
} from "../choices";
import type { SendAndRecordInput, SendAndRecordResult } from "../outbox";
import { isWebConversation, reminderText, sendThreadReminder, sweepThreadChoices, THREAD_OPTIONS } from "../thread-choices";
import { isQuietTime, nextReminderTime, quietHours, reminderTimeZone } from "./schedule";
import {
  CLOSED_REASON,
  closeThreadIn,
  fillMissingReminders,
  listAllThreadsChecked,
  threadsEnabled,
  updateThreads,
  type Thread,
  type ThreadReminder,
} from "./store";

type Env = Record<string, string | undefined>;

export const REMIND_INTERVAL_MS = 15 * 60_000;
/** Erster Durchgang kurz nach dem Start */
export const REMIND_FIRST_DELAY_MS = 30_000;
export const REMIND_BATCH_MAX = 5;
export const REMIND_MAX_ATTEMPTS = 3;
export const REMIND_MAX_STEPS = 2;

export interface RemindDeps {
  now(): number;
  env(): Env;
  /** Telegram eingerichtet? (in bot.ts telegramConfigured) */
  telegram(): boolean;
  send(input: SendAndRecordInput): Promise<SendAndRecordResult>;
  /** Zieht eine Telegram-Nachricht nach, wenn die Rückfrage während des Sendens erledigt wurde */
  refresh?(choice: Choice, refs: ChoiceTelegramRef[]): Promise<unknown>;
  /** true: Gespräch sicher weg; false: da; null: unbekannt (Lesefehler) */
  conversationGone(conversation: ChoiceConversation): Promise<boolean | null>;
  createChoice?(input: CreateChoiceInput, options?: CreateChoiceOptions): Promise<Choice>;
  expireChoice?(id: string): Promise<unknown>;
  listChoices?(): Promise<Choice[]>;
  log?(line: string): void;
}

export interface TickResult {
  sent: number;
  closed: number;
  deferred: number;
  quiet: boolean;
}

// Fäden ohne Telegram: einmal je Faden ins Log
const deferredLogged = new Set<string>();

function sameReminder(r: ThreadReminder | undefined, step: number, attempts: number, state: ThreadReminder["state"]): boolean {
  return !!r && r.step === step && r.attempts === attempts && r.state === state;
}

/**
 * Wertet einen Faden nach einer zugestellten oder unklaren Erinnerung aus
 * (unter der Sperre): Stufe gezählt, neuer Termin, Hinweis für den nächsten Turn.
 */
function finishDelivered(t: Thread, step: number, now: number, env: Env): void {
  t.reminders = Math.max(t.reminders, step);
  t.nextReminderAt = nextReminderTime(now, t.deadline, env);
  t.hintPending = true;
  delete t.reminder;
}

export function createThreadReminders(deps: RemindDeps) {
  const log = deps.log ?? ((line: string) => console.log(line));
  const create = deps.createChoice ?? realCreateChoice;
  const expire = deps.expireChoice ?? realExpireChoice;
  const list = deps.listChoices ?? realListChoices;
  // Fäden, die gerade ein Durchgang dieses Prozesses bearbeitet
  const busy = new Set<string>();

  const expireQuietly = async (id: string) => {
    await Promise.resolve(expire(id)).catch(() => log(`[faeden] Rückfrage ${id} nicht abgelaufen`));
  };

  /** Ein fälliger Faden; gibt zurück, ob gesendet wurde und was mit ihm geschah */
  async function processThread(id: string, sendingAllowed: boolean): Promise<"sent" | "closed" | "deferred" | "quiet" | "none"> {
    const env = deps.env();
    const now = deps.now();

    // Wiederaufnahme: Auftrag in "sending" heißt Ausgang unbekannt, also wie unklar
    const resumed = await updateThreads<boolean>(threads => {
      const t = threads[id];
      if (!t || t.state !== "open" || t.reminder?.state !== "sending") return { result: false, changed: false };
      finishDelivered(t, t.reminder.step, now, env);
      return { result: true, changed: true };
    });
    if (resumed) {
      log(`[faeden] Faden ${id}: Zustellung unklar, nicht wiederholt`);
      return "none";
    }
    if (!sendingAllowed) return "none";

    // Gespräch weg? Nur sicher bewiesen
    const before = (await listAllThreadsChecked()).find(t => t.id === id);
    if (!before || before.state !== "open" || before.nextReminderAt === undefined || before.nextReminderAt > now) return "none";
    let gone: boolean | null = null;
    try {
      gone = await deps.conversationGone(before.conversation);
    } catch {
      gone = null;
    }
    if (gone === true) {
      const closed = await updateThreads<boolean>(threads => {
        const t = threads[id];
        if (!t || t.state !== "open") return { result: false, changed: false };
        closeThreadIn(t, CLOSED_REASON.gone, now);
        return { result: true, changed: true };
      });
      if (closed) log(`[faeden] Faden ${id} geschlossen (Gespräch weg)`);
      return closed ? "closed" : "none";
    }

    // 1. Auftrag anlegen
    type Start =
      | { kind: "skip" }
      | { kind: "closed" }
      | { kind: "deferred" }
      | { kind: "start"; step: 1 | 2; attempts: number; since: number; due: number; thread: Thread };
    const start = await updateThreads<Start>(threads => {
      const t = threads[id];
      if (!t || t.state !== "open" || t.reminder?.state === "sending") return { result: { kind: "skip" }, changed: false };
      if (t.nextReminderAt === undefined || t.nextReminderAt > now) return { result: { kind: "skip" }, changed: false };
      if (t.reminders >= REMIND_MAX_STEPS) {
        closeThreadIn(t, CLOSED_REASON.noAnswer, now);
        return { result: { kind: "closed" }, changed: true };
      }
      if (!isWebConversation(t.conversation) && !deps.telegram()) {
        t.nextReminderAt = nextReminderTime(now, t.deadline, env);
        delete t.reminder;
        return { result: { kind: "deferred" }, changed: true };
      }
      const step = (t.reminders + 1) as 1 | 2;
      const attempts = t.reminder?.step === step ? t.reminder.attempts : 0;
      const since = t.reminder?.step === step ? t.reminder.since : now;
      t.reminder = { step, attempts, state: "ready", since };
      return { result: { kind: "start", step, attempts, since, due: t.nextReminderAt, thread: { ...t } }, changed: true };
    });
    if (start.kind === "skip") return "none";
    if (start.kind === "closed") {
      log(`[faeden] Faden ${id} still geschlossen (keine Antwort nach ${REMIND_MAX_STEPS} Erinnerungen)`);
      return "closed";
    }
    if (start.kind === "deferred") {
      if (!deferredLogged.has(id)) {
        deferredLogged.add(id);
        log(`[faeden] Faden ${id}: Telegram nicht eingerichtet, Erinnerung verschoben`);
      }
      return "deferred";
    }

    // 2. Rückfrage anlegen; ältere desselben Fadens laufen erst nach der Übernahme ab
    const text = reminderText(start.thread, start.step, reminderTimeZone(env));
    let choice: Choice;
    try {
      choice = await create({ kind: "thread", conversation: start.thread.conversation, text, options: THREAD_OPTIONS, ref: id });
    } catch {
      log(`[faeden] Faden ${id}: Rückfrage nicht angelegt, nächster Durchgang`);
      return "none";
    }

    // 3. Auftrag exklusiv übernehmen. Hat ein anderer Durchgang die Rückfrage
    // inzwischen ersetzt (oder wurde sie entschieden), sendet dieser nicht
    const live = await getChoice(choice.id).catch(() => undefined);
    if (live?.state !== "open") {
      await expireQuietly(choice.id);
      return "none";
    }
    // Ruhezeit auch hier: Anlegen der Rückfrage und Gesprächsprüfung können über 21:00 hinaus dauern
    const zone = reminderTimeZone(env);
    const quiet = quietHours(env);
    const taken = await updateThreads<"taken" | "lost" | "closed" | "quiet">(threads => {
      const t = threads[id];
      if (!t || t.state !== "open") return { result: "closed", changed: false };
      if (!sameReminder(t.reminder, start.step, start.attempts, "ready") || t.nextReminderAt !== start.due) return { result: "lost", changed: false };
      if (isQuietTime(deps.now(), zone, quiet)) return { result: "quiet", changed: false };
      t.reminder = { step: start.step, choiceId: choice.id, attempts: start.attempts + 1, state: "sending", since: deps.now() };
      return { result: "taken", changed: true };
    });
    if (taken !== "taken") {
      await expireQuietly(choice.id);
      return taken === "quiet" ? "quiet" : "none";
    }
    try {
      for (const c of await list()) {
        if (c.kind === "thread" && c.ref === id && c.state === "open" && c.id !== choice.id) await expireQuietly(c.id);
      }
    } catch {
      log(`[faeden] Faden ${id}: ältere Rückfragen nicht abgelaufen`);
    }

    // Unmittelbar vor dem Versand unter Sperre: Während des Abräumens kann der
    // Faden geschlossen oder verschoben worden sein (Klick, Textauflösung), dann
    // nicht senden und nichts überschreiben. Ruhezeit: begonnen, nichts gesendet,
    // also zurück auf "ready" mit den Versuchen von vorher; die Stufe bleibt offen
    const ready = await updateThreads<"send" | "lost" | "quiet">(threads => {
      const t = threads[id];
      const r = t?.reminder;
      if (!t || t.state !== "open" || !r || r.choiceId !== choice.id || r.state !== "sending") return { result: "lost", changed: false };
      if (!isQuietTime(deps.now(), zone, quiet)) return { result: "send", changed: false };
      t.reminder = { step: r.step, attempts: start.attempts, state: "ready", since: start.since };
      return { result: "quiet", changed: true };
    });
    if (ready !== "send") {
      await expireQuietly(choice.id);
      if (ready === "quiet") {
        log(`[faeden] Faden ${id}: Ruhezeit begonnen, Erinnerung nicht gesendet`);
        return "quiet";
      }
      log(`[faeden] Faden ${id}: vor dem Versand geändert, Erinnerung nicht gesendet`);
      return "none";
    }

    // 4. Senden
    const { outcome } = await sendThreadReminder(choice, text, {
      send: input => deps.send(input),
      telegram: deps.telegram,
      ...(deps.refresh ? { refresh: deps.refresh } : {}),
      log,
    });

    // 5. Auswerten, nur wenn der Auftrag noch derselbe ist
    const after = deps.now();
    type Done = "delivered" | "unclear" | "retry" | "exhausted" | "late";
    const done = await updateThreads<Done>(threads => {
      const t = threads[id];
      const r = t?.reminder;
      if (!t || t.state !== "open" || !r || r.choiceId !== choice.id || r.state !== "sending") return { result: "late", changed: false };
      if (outcome === "delivered" || outcome === "unclear") {
        finishDelivered(t, r.step, after, env);
        return { result: outcome, changed: true };
      }
      // Sicher nicht zugestellt (rejected; deferred, falls Telegram währenddessen wegfiel)
      if (r.attempts >= REMIND_MAX_ATTEMPTS) {
        t.reminders = Math.max(t.reminders, r.step);
        t.nextReminderAt = nextReminderTime(after, t.deadline, env);
        delete t.reminder;
        return { result: "exhausted", changed: true };
      }
      t.reminder = { ...r, state: "ready", since: after };
      return { result: "retry", changed: true };
    });
    if (done === "unclear") log(`[faeden] Faden ${id}: Zustellung unklar, nicht wiederholt`);
    if (done === "exhausted") {
      log(`[faeden] Faden ${id}: Erinnerung nach ${REMIND_MAX_ATTEMPTS} Versuchen nicht zugestellt, Stufe verbraucht`);
      await expireQuietly(choice.id);
    }
    if (done === "late") log(`[faeden] Faden ${id}: Versandergebnis kam nach einer Änderung, nichts überschrieben`);
    return "sent";
  }

  /** Ein Durchgang (für Tests direkt aufrufbar) */
  async function tick(): Promise<TickResult> {
    const result: TickResult = { sent: 0, closed: 0, deferred: 0, quiet: false };
    const env = deps.env();
    if (!threadsEnabled(env)) return result;
    const zone = reminderTimeZone(env);
    const quiet = quietHours(env);
    try {
      await fillMissingReminders(env, deps.now());
    } catch {
      log("[faeden] Termine für alte Fäden nicht gesetzt");
    }
    try {
      await sweepThreadChoices({ log });
    } catch {
      log("[faeden] Rückfragen geschlossener Fäden nicht abgeräumt");
    }
    let threads: Thread[];
    try {
      threads = await listAllThreadsChecked();
    } catch {
      log("[faeden] Ablage nicht lesbar, keine Erinnerungen");
      return result;
    }
    const now = deps.now();
    const due = threads
      .filter(t => t.state === "open" && (t.reminder?.state === "sending" || (t.nextReminderAt !== undefined && t.nextReminderAt <= now)))
      .sort((a, b) => (a.reminder?.state === "sending" ? 0 : 1) - (b.reminder?.state === "sending" ? 0 : 1) || (a.nextReminderAt ?? 0) - (b.nextReminderAt ?? 0));
    for (const t of due) {
      if (busy.has(t.id)) continue;
      // Ruhezeit unmittelbar vor jedem Faden prüfen: ein Durchgang über 21:00 hinweg hört auf
      const isQuiet = isQuietTime(deps.now(), zone, quiet);
      if (isQuiet) result.quiet = true;
      const sendingAllowed = !isQuiet && result.sent < REMIND_BATCH_MAX;
      // Aufträge in "sending" werden immer ausgewertet (es wird dabei nichts gesendet)
      if (!sendingAllowed && t.reminder?.state !== "sending") continue;
      busy.add(t.id);
      try {
        const r = await processThread(t.id, sendingAllowed);
        if (r === "sent") result.sent++;
        else if (r === "closed") result.closed++;
        else if (r === "deferred") result.deferred++;
        else if (r === "quiet") result.quiet = true;
      } catch {
        log(`[faeden] Faden ${t.id}: Durchgang gescheitert`);
      } finally {
        busy.delete(t.id);
      }
    }
    return result;
  }

  return { tick };
}

export interface ThreadReminderTimer {
  stop(): void;
  /** Für Tests: bis der laufende Durchgang fertig ist */
  idle(): Promise<void>;
}

/**
 * Startet den Zeitgeber (erster Durchgang nach REMIND_FIRST_DELAY_MS, dann
 * alle 15 Minuten). Er läuft auch bei ausgeschalteten Fäden: jeder Durchgang
 * prüft threadsEnabled frisch und tut dann nichts, so wirkt Einschalten in
 * der WebUI ohne Neustart (Issue #293). Ein Durchgang läuft nie zweimal
 * gleichzeitig.
 */
export function startThreadReminders(
  deps: RemindDeps,
  o: { intervalMs?: number; firstDelayMs?: number; setTimeout?: typeof setTimeout; setInterval?: typeof setInterval; clearInterval?: typeof clearInterval; clearTimeout?: typeof clearTimeout } = {}
): ThreadReminderTimer {
  const reminders = createThreadReminders(deps);
  let running: Promise<void> | null = null;
  let stopped = false;
  const run = () => {
    if (stopped || running) return;
    running = reminders
      .tick()
      .then(() => {})
      .catch(() => {})
      .finally(() => {
        running = null;
      });
  };
  const first = (o.setTimeout ?? setTimeout)(run, o.firstDelayMs ?? REMIND_FIRST_DELAY_MS);
  const timer = (o.setInterval ?? setInterval)(run, o.intervalMs ?? REMIND_INTERVAL_MS);
  (first as { unref?: () => void }).unref?.();
  (timer as { unref?: () => void }).unref?.();
  return {
    stop() {
      stopped = true;
      (o.clearTimeout ?? clearTimeout)(first);
      (o.clearInterval ?? clearInterval)(timer);
    },
    idle: () => running ?? Promise.resolve(),
  };
}

/**
 * Prüfung „Gespräch weg" im Bot: Web-Gespräch im Gesprächsspeicher (frisch
 * gelesen; weg nur, wenn eine gültige Liste ohne das Gespräch gelesen wurde),
 * Topic mit Merker deleted. Direktchat, General und Web-Direktchat sind nie
 * weg. Fehlende, unlesbare oder kaputte Ablage (webConversationExists wirft):
 * unbekannt (null).
 */
export function conversationGoneCheck(deps: {
  webConversationExists(conversationId: string): Promise<boolean>;
  topicDeleted(chatId: string, topicId: number): Promise<boolean>;
}): (conversation: ChoiceConversation) => Promise<boolean | null> {
  return async conversation => {
    try {
      if (conversation.type === "web") return !(await deps.webConversationExists(conversation.conversationId));
      if (conversation.topicId === undefined || conversation.topicId === 1) return false;
      return await deps.topicDeleted(conversation.chatId, conversation.topicId);
    } catch {
      return null;
    }
  };
}
