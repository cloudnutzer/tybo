/**
 * Erinnerungen in der WebUI (Issue #323): GET /api/reminders für den Reiter
 * „Erinnerungen" der Einstellungen, POST /api/reminders/<id>/cancel zum
 * Absagen.
 *
 * - GET liefert die offenen Erinnerungen aller Gespräche nach Fälligkeit,
 *   dieselbe Auswahl wie /erinnerungen (src/lib/schedule/overview.ts).
 * - POST sagt genau diesen Eintrag ab, nur solange er wartet (die Ablage
 *   prüft das in derselben Änderung). Erfolg 200; wird er gerade zugestellt,
 *   ist er schon abgesagt, zugestellt oder fehlgeschlagen, 409 mit dem Text
 *   wie /erinnerungen; unbekannt 404. Nie ein Erfolg, der keiner ist.
 *
 * Diese Datei importiert nichts aus src/lib; src/bot.ts übergibt die echte
 * Quelle als RemindersPort (src/web/bot-reminders.ts), web:dev und Demo
 * eine Attrappe (createDemoReminders in ./demo). Ins Log kommen nur IDs.
 */

import type { ApiResult } from "./settings";

/** Eine offene Erinnerung, wie die Quelle sie liefert */
export interface ReminderRecord {
  id: string;
  /** Kennung für /erinnerungen absagen */
  ref: string;
  text: string;
  /** ISO in UTC */
  dueAt: string;
  /** „18.10. 14:05" in USER_TIMEZONE */
  dueText: string;
  /** „täglich 08:05"; null bei einmaligen */
  recurrenceText: string | null;
  status: "pending" | "running";
  overdue: boolean;
  /** Ort wie in /erinnerungen (Direktchat, General, Topic, Web-Gespräch) */
  place: string;
}

/** Ausgang einer Absage, wie die Quelle ihn liefert (CancelOutcome in src/lib/schedule/overview.ts) */
export type ReminderCancelStatus = "cancelled" | "sending" | "already-cancelled" | "done" | "failed-earlier" | "unknown" | "ambiguous" | "unreadable" | "error";

export interface RemindersPort {
  /** Offene Erinnerungen nach Fälligkeit */
  list(): Promise<ReminderRecord[]>;
  /** Sagt den Eintrag mit genau dieser ID ab; text ist die Antwort wie /erinnerungen */
  cancel(id: string): Promise<{ status: ReminderCancelStatus; text: string }>;
}

export const REMINDERS_API_TEXT = {
  notConfigured: "Erinnerungen sind hier nicht eingerichtet.",
  failed: "Erinnerungen konnten nicht gelesen werden.",
  unknown: "Keine Erinnerung mit dieser Kennung.",
  cancelFailed: "Das Absagen hat nicht geklappt, die Erinnerung bleibt, wie sie ist.",
} as const;

/** IDs der Ablage: UUID (Supabase, Datei) bzw. ID aus dem Altimport */
export const REMINDER_ID_PATTERN = /^[0-9A-Za-z-]{8,64}$/;

export interface RemindersApi {
  get(): Promise<ApiResult>;
  cancel(id: string): Promise<ApiResult>;
}

const CONFLICT: ReadonlySet<ReminderCancelStatus> = new Set(["sending", "already-cancelled", "done", "failed-earlier"]);

export function createRemindersApi(port: RemindersPort, log: (message: string) => void): RemindersApi {
  return {
    async get() {
      let reminders: ReminderRecord[];
      try {
        reminders = await port.list();
      } catch (e) {
        log(`Erinnerungen nicht lesbar (${e instanceof Error ? e.name : typeof e})`);
        return { status: 500, body: { error: REMINDERS_API_TEXT.failed } };
      }
      const items = reminders.map(r => ({
        id: r.id,
        ref: r.ref,
        text: r.text,
        dueAt: r.dueAt,
        dueText: r.dueText,
        recurrence: r.recurrenceText,
        status: r.status,
        overdue: r.overdue,
        place: r.place,
      }));
      return { status: 200, body: { count: items.length, reminders: items } };
    },

    async cancel(id) {
      if (!REMINDER_ID_PATTERN.test(id)) return { status: 404, body: { error: REMINDERS_API_TEXT.unknown } };
      let outcome: { status: ReminderCancelStatus; text: string };
      try {
        outcome = await port.cancel(id);
      } catch (e) {
        log(`Erinnerung ${id} nicht abgesagt (${e instanceof Error ? e.name : typeof e})`);
        return { status: 500, body: { error: REMINDERS_API_TEXT.cancelFailed } };
      }
      log(`Erinnerung ${id} in der WebUI absagen: ${outcome.status}`);
      if (outcome.status === "cancelled") return { status: 200, body: { cancelled: true, id, text: outcome.text } };
      if (CONFLICT.has(outcome.status)) return { status: 409, body: { error: outcome.text, status: outcome.status } };
      if (outcome.status === "unknown" || outcome.status === "ambiguous") return { status: 404, body: { error: REMINDERS_API_TEXT.unknown } };
      return { status: 500, body: { error: REMINDERS_API_TEXT.cancelFailed } };
    },
  };
}
