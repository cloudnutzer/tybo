/**
 * Datei-Adapter für Erinnerungen (Issue #321): die Ablage ohne Datenbank.
 *
 * Ablage: Der Pfad ist data/reminders.json, gelesen und geschrieben wird
 * aber über updateJsonState (json-state.ts), also in
 * `data/reminders.json.sqlite`, je Änderung in einer Transaktion. So gehen
 * gleichzeitige Änderungen aus Bot, Sprach-Brücke und Terminal nicht
 * verloren. Eine data/reminders.json, die schon vorher da war, wird beim
 * ersten Zugriff einmal übernommen (Erstimport), danach nicht mehr gelesen.
 * Eine Übernahme alter Erinnerungen aus anderen Formaten gibt es hier nicht.
 *
 * Gespeichert wird ein Objekt { tasks: [...] } mit den Einträgen in der Form
 * des Vertrags (contract.ts).
 */
import { randomUUID } from "node:crypto";
import { updateJsonState } from "../json-state";
import {
  byDue,
  changeRow,
  matchesFilter,
  meetsCondition,
  newRow,
  validCondition,
  FIXED_ID_PATTERN,
  type ChangeRow,
  type NewRow,
  type ScheduledTask,
  type ScheduleStore,
} from "./contract";

interface Stored {
  tasks: ScheduledTask[];
}

const empty = (): Stored => ({ tasks: [] });

/** Jetzt als ISO-Zeitpunkt (Date.now(), damit Tests die Uhr stellen können) */
const stampNow = () => new Date(Date.now()).toISOString();

/** Erinnerungen in der Datei; path wird bei jedem Zugriff gefragt */
export function fileScheduleStore(path: () => string): ScheduleStore {
  /** Eine Änderung in einer Transaktion; Fehler der Ablage ergeben fallback */
  const change = <T>(fallback: T, fn: (tasks: ScheduledTask[]) => T): Promise<T> =>
    new Promise(resolve => {
      try {
        resolve(
          updateJsonState(path(), empty, stored => {
            if (!Array.isArray(stored.tasks)) stored.tasks = [];
            return fn(stored.tasks);
          }),
        );
      } catch (err) {
        console.error(`[schedule] Ablage ${path()} nicht lesbar: ${err instanceof Error ? err.message : String(err)}`);
        resolve(fallback);
      }
    });

  /** Alte Einträge (vor #322) ohne Lease-Felder bekommen sie leer */
  const copy = (task: ScheduledTask): ScheduledTask => ({
    ...task,
    leaseOwner: task.leaseOwner ?? null,
    leaseUntil: task.leaseUntil ?? null,
    sendStartedAt: task.sendStartedAt ?? null,
  });

  /** Schreibt die Spalten einer Änderung in den Eintrag */
  const applyRow = (task: ScheduledTask, row: ChangeRow): void => {
    if (row.text !== undefined) task.text = row.text;
    if (row.due_at !== undefined) task.dueAt = row.due_at;
    if (row.recurrence !== undefined) task.recurrence = row.recurrence;
    if (row.status !== undefined) task.status = row.status;
    if (row.attempts !== undefined) task.attempts = row.attempts;
    if (row.last_error !== undefined) task.lastError = row.last_error;
    if (row.lease_owner !== undefined) task.leaseOwner = row.lease_owner;
    if (row.lease_until !== undefined) task.leaseUntil = row.lease_until;
    if (row.send_started_at !== undefined) task.sendStartedAt = row.send_started_at;
    task.updatedAt = stampNow();
  };

  /** Neuer Eintrag aus den Spalten, wartend */
  const fresh = (id: string, row: NewRow): ScheduledTask => {
    const stamp = stampNow();
    return {
      id,
      chatId: row.chat_id,
      topicId: row.topic_id,
      kind: row.kind,
      text: row.text,
      dueAt: row.due_at,
      recurrence: row.recurrence,
      status: "pending",
      attempts: 0,
      lastError: null,
      leaseOwner: null,
      leaseUntil: null,
      sendStartedAt: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
  };

  return {
    addOnce: (id, input) => {
      const row = newRow(input);
      if (!row || !FIXED_ID_PATTERN.test(id)) return Promise.resolve("failed" as const);
      // Prüfen und Anlegen in derselben Transaktion
      return change("failed" as const, tasks => {
        if (tasks.some(t => t.id === id)) return "exists" as const;
        tasks.push(fresh(id, row));
        return "added" as const;
      });
    },
    add: input => {
      const row = newRow(input);
      if (!row) return Promise.resolve(null);
      return change(null, tasks => {
        const task = fresh(randomUUID(), row);
        tasks.push(task);
        return copy(task);
      });
    },
    byId: id =>
      change(null, tasks => {
        const task = tasks.find(t => t.id === id);
        return task ? copy(task) : null;
      }),
    list: filter => change([], tasks => tasks.filter(t => matchesFilter(t, { ...filter, idPrefix: undefined })).sort(byDue).map(copy)),
    listAll: filter => change<ScheduledTask[] | null>(null, tasks => tasks.filter(t => matchesFilter(t, filter)).sort(byDue).map(copy)),
    due: (now, limit, kind) =>
      change([], tasks => {
        const cutoff = now.getTime();
        return tasks
          .filter(t => t.status === "pending" && Date.parse(t.dueAt) <= cutoff && (kind === undefined || t.kind === kind))
          .sort(byDue)
          .slice(0, Math.max(0, limit))
          .map(copy);
      }),
    update: (id, changes) => {
      const row = changeRow(changes);
      if (!row) return Promise.resolve(null);
      return change(null, tasks => {
        const task = tasks.find(t => t.id === id);
        if (!task) return null;
        applyRow(task, row);
        return copy(task);
      });
    },
    updateIf: (id, condition, changes) => {
      const row = changeRow(changes);
      if (!row || !validCondition(condition)) return Promise.resolve(null);
      // Prüfen und Schreiben in derselben Transaktion
      return change(null, tasks => {
        const task = tasks.find(t => t.id === id);
        if (!task || !meetsCondition(copy(task), condition)) return null;
        applyRow(task, row);
        return copy(task);
      });
    },
    cancel: id =>
      change(false, tasks => {
        const task = tasks.find(t => t.id === id);
        if (!task || task.status !== "pending") return false;
        task.status = "cancelled";
        task.updatedAt = stampNow();
        return true;
      }),
  };
}
