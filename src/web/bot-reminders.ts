/**
 * Echte Quelle der Erinnerungs-API (Issue #323) für src/bot.ts: Ablage aus
 * src/lib/schedule/store.ts, Auswahl, Texte und Absage wie /erinnerungen
 * (src/lib/schedule/overview.ts). Abgesagt wird nur die genannte ID, nie ein
 * anderer Eintrag mit gleichem Anfang. Ist die Ablage nicht lesbar, wirft
 * list() (die API antwortet 500) und cancel() meldet "unreadable". Wie
 * bot-threads.ts bindet nur src/bot.ts diese Datei ein; Tests geben eine
 * eigene Ablage mit.
 */

import { cancelReminder, cancelText, listOpenReminders, reminderView } from "../lib/schedule/overview";
import { getScheduleStore, type ScheduleStore } from "../lib/schedule/store";
import type { ReminderRecord, RemindersPort } from "./reminders";

export interface BotRemindersDeps {
  store?: () => ScheduleStore;
  now?: () => number;
  /** Topic-Namen für den Ort („Topic Reisen"); fehlt oder scheitert: „Topic <nr>" */
  topicNames?: () => Promise<Record<string, string>>;
  /** IANA-Zeitzone; Standard USER_TIMEZONE */
  timeZone?: () => string | undefined;
}

export function createBotReminders(deps: BotRemindersDeps = {}): RemindersPort {
  const store = deps.store ?? (() => getScheduleStore());
  const now = deps.now ?? (() => Date.now());

  return {
    async list() {
      const tasks = await listOpenReminders(store());
      // Nicht lesbar ist kein Leerzustand: die API antwortet dann mit einem Fehler
      if (!tasks) throw new Error("Ablage der Erinnerungen nicht lesbar");
      let topicNames: Record<string, string> = {};
      if (deps.topicNames && tasks.some(t => t.topicId !== null && t.topicId !== 1)) topicNames = await deps.topicNames().catch(() => ({}));
      const at = now();
      return tasks.map((task): ReminderRecord => {
        const v = reminderView(task, { now: at, timeZone: deps.timeZone?.(), topicNames });
        return { id: v.id, ref: v.ref, text: v.text, dueAt: v.dueAt, dueText: v.dueText, recurrenceText: v.recurrenceText, status: v.status, overdue: v.overdue, place: v.place };
      });
    },
    async cancel(id) {
      // Nur genau diese ID: ein anderer Eintrag mit gleichem Anfang zählt nicht
      const outcome = await cancelReminder(store(), id, { exact: true });
      return { status: outcome.status, text: cancelText(outcome, id) };
    },
  };
}
