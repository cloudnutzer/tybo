/**
 * Große Bestände für die Erinnerungs-Tests (Issue #323): viele Einträge auf
 * einmal, für die Datei-Ablage als vorhandene data/reminders.json
 * (Erstimport, file.ts), für die Supabase-Attrappe als Startzeilen in
 * Spaltenform (tasks-fixture.ts). So geht es ohne tausende Einzelaufrufe.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ScheduledTask, ScheduleStatus } from "../src/lib/schedule/contract";
import type { Row } from "./tasks-fixture";

/** n Erinnerungen ab dem Zeitpunkt start, je eine Minute später, mit zufälliger UUID */
export function bulkTasks(n: number, o: { start: number; status: ScheduleStatus; chatId: string; text: string }): ScheduledTask[] {
  return Array.from({ length: n }, (_, i) => {
    const at = new Date(o.start + i * 60_000).toISOString();
    return {
      id: crypto.randomUUID(),
      chatId: o.chatId,
      topicId: null,
      kind: "reminder",
      text: `${o.text} ${i + 1}`,
      dueAt: at,
      recurrence: null,
      status: o.status,
      attempts: 0,
      lastError: null,
      leaseOwner: null,
      leaseUntil: null,
      sendStartedAt: null,
      createdAt: at,
      updatedAt: at,
    };
  });
}

/** Eintrag in der Spaltenform von scheduled_tasks */
export function asRow(t: ScheduledTask): Row {
  return {
    id: t.id,
    chat_id: t.chatId,
    topic_id: t.topicId,
    kind: t.kind,
    text: t.text,
    due_at: t.dueAt,
    recurrence: t.recurrence,
    status: t.status,
    attempts: t.attempts,
    last_error: t.lastError,
    lease_owner: t.leaseOwner,
    lease_until: t.leaseUntil,
    send_started_at: t.sendStartedAt,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

/** Legt data/reminders.json an, wie sie vor dem ersten Zugriff schon da war */
export function writeFileSeed(path: string, tasks: ScheduledTask[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ tasks }));
}
