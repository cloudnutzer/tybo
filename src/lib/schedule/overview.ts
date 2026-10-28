/**
 * Übersicht und Absage von Erinnerungen (Issue #323): gemeinsam für
 * /erinnerungen (alle Kanäle) und die Liste in der WebUI.
 *
 * Offen ist ein Eintrag der Art "reminder" mit Status pending (wartet) oder
 * running (wird gerade zugestellt). Erledigte, fehlgeschlagene und
 * abgesagte stehen nicht in der Liste; die Absage nennt ihren Zustand.
 * Die Liste umfasst alle Gespräche, wie /faeden; abgesagt werden kann aus
 * jedem Gespräch, weil die Kennung den Eintrag eindeutig nennt.
 *
 * Kennung: die ersten 8 Zeichen der ID (bei einer UUID der erste Block).
 * Abgesagt wird über cancel() der Ablage, also nur, solange der Eintrag
 * noch wartet (in derselben Änderung geprüft). Hat der Planer ihn
 * inzwischen übernommen, meldet die Absage das statt eines Erfolgs. Eine
 * Serie wird ganz abgesagt. Ein Knopf an einer früher zugestellten
 * Erinnerung findet danach nur noch „gibt es nicht mehr" (reminder-choices.ts).
 *
 * Gelesen wird mit listAll: vollständig (bei Supabase über alle
 * Antwortseiten) und mit Fehlern. Ist die Ablage nicht lesbar, sagt die
 * Liste das, statt „keine offenen" zu melden, und die Absage sagt nichts ab.
 */
import { parseRecurrence, type Recurrence } from "../recurrence";
import { webConversationOf, WEB_DM_CHAT_ID } from "../channels";
import { effectiveTimeZone } from "../when";
import type { ScheduledTask, ScheduleStore } from "./contract";
import { shortStamp } from "./planner";
import { webOnlyChatOf } from "./remind";

/** So viele Zeichen der ID zeigt die Liste */
export const REMINDER_REF_LENGTH = 8;

export const REMINDERS_TEXT = {
  none: "Keine offenen Erinnerungen.",
  heading: (n: number) => `Offene Erinnerungen (${n}):`,
  cancelHint: "Absagen: /erinnerungen absagen <kennung>",
  usage: "So geht es: /erinnerungen zeigt die offenen Erinnerungen, /erinnerungen absagen <kennung> sagt eine ab (die Kennung steht in der Liste).",
  cancelled: (text: string) => `Abgesagt: ${text}`,
  cancelledSeries: (text: string, rule: string) => `Serie abgesagt: ${text} (${rule}). Es kommen keine weiteren Termine.`,
  unknown: (ref: string) => `Keine Erinnerung mit der Kennung ${ref}. /erinnerungen zeigt alle offenen.`,
  ambiguous: (ref: string) => `Die Kennung ${ref} passt auf mehrere Erinnerungen. Bitte mehr Zeichen angeben.`,
  sending: (text: string) => `„${text}“ wird gerade zugestellt und lässt sich jetzt nicht absagen. Eine Serie kannst du gleich danach absagen.`,
  alreadyCancelled: (text: string) => `„${text}“ ist schon abgesagt.`,
  alreadyDone: (text: string) => `„${text}“ ist schon zugestellt, da gibt es nichts mehr abzusagen.`,
  alreadyFailed: (text: string) => `„${text}“ ließ sich nicht zustellen und wartet nicht mehr.`,
  failed: "Das Absagen hat nicht geklappt, die Erinnerung bleibt, wie sie ist.",
  unreadable: "Die Erinnerungen lassen sich gerade nicht lesen. Bitte später noch einmal versuchen.",
  unreadableCancel: "Die Erinnerungen lassen sich gerade nicht lesen, nichts abgesagt. Bitte später noch einmal versuchen.",
  direct: "Direktchat",
  general: "General",
  web: "Web-Gespräch",
  webOnly: "nur WebUI",
  sendingState: "wird gerade zugestellt",
  overdue: "überfällig",
} as const;

/** Kennung eines Eintrags für Liste und Absage */
export function reminderRef(id: string): string {
  return id.slice(0, REMINDER_REF_LENGTH).toLowerCase();
}

/** Offene Erinnerungen aller Gespräche, nach Fälligkeit; null, wenn die Ablage nicht lesbar ist */
export async function listOpenReminders(store: ScheduleStore): Promise<ScheduledTask[] | null> {
  const tasks = await store.listAll({ status: ["pending", "running"] });
  return tasks && tasks.filter(t => t.kind === "reminder");
}

const WEEKDAYS = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const pad = (n: number) => String(n).padStart(2, "0");

function ruleText(rule: Recurrence): string {
  if (rule.every === "hours") return rule.hours === 1 ? "jede Stunde" : `alle ${rule.hours} Stunden`;
  const clock = `${pad(rule.hour)}:${pad(rule.minute)}`;
  if (rule.every === "day") return `täglich ${clock}`;
  if (rule.every === "weekday") return `werktags ${clock}`;
  return `jeden ${WEEKDAYS[rule.weekday]} ${clock}`;
}

/** Wiederholung in Worten („täglich 08:05"); null bei einmaligen und unlesbaren */
export function recurrenceText(recurrence: string | null): string | null {
  const rule = recurrence ? parseRecurrence(recurrence) : null;
  return rule ? ruleText(rule) : null;
}

/** Ort eines Eintrags in Worten: Direktchat, General, Topic, Web-Gespräch; Zusatz für „nur WebUI" */
export function reminderPlace(task: Pick<ScheduledTask, "chatId" | "topicId">, topicNames: Record<string, string> = {}): string {
  const webOnlyChat = webOnlyChatOf(task.chatId);
  const chatId = webOnlyChat ?? task.chatId;
  let place: string;
  if (chatId === WEB_DM_CHAT_ID) place = REMINDERS_TEXT.direct;
  else if (webConversationOf(chatId)) place = REMINDERS_TEXT.web;
  else if (task.topicId !== null && task.topicId !== 1) {
    const name = topicNames[String(task.topicId)];
    place = name ? `Topic ${name}` : `Topic ${task.topicId}`;
  } else place = chatId.startsWith("-") ? REMINDERS_TEXT.general : REMINDERS_TEXT.direct;
  return webOnlyChat !== null ? `${place} (${REMINDERS_TEXT.webOnly})` : place;
}

export interface ReminderView {
  id: string;
  ref: string;
  text: string;
  dueAt: string;
  /** „18.10. 14:05" in der Zone */
  dueText: string;
  recurrence: string | null;
  /** „täglich 08:05" */
  recurrenceText: string | null;
  status: "pending" | "running";
  overdue: boolean;
  place: string;
  chatId: string;
  topicId: number | null;
}

export interface ViewOptions {
  now: number;
  timeZone?: string;
  topicNames?: Record<string, string>;
}

/** Ansicht eines offenen Eintrags, für Liste und WebUI */
export function reminderView(task: ScheduledTask, o: ViewOptions): ReminderView {
  const zone = effectiveTimeZone(o.timeZone);
  const due = Date.parse(task.dueAt);
  return {
    id: task.id,
    ref: reminderRef(task.id),
    text: task.text,
    dueAt: task.dueAt,
    dueText: shortStamp(due, zone),
    recurrence: task.recurrence,
    recurrenceText: recurrenceText(task.recurrence),
    status: task.status === "running" ? "running" : "pending",
    overdue: task.status === "pending" && due < o.now,
    place: reminderPlace(task, o.topicNames),
    chatId: task.chatId,
    topicId: task.topicId,
  };
}

/** Text für /erinnerungen: je Eintrag Zeit und Text, darunter Kennung, Ort, Wiederholung, Zustand */
export function formatReminderList(tasks: ScheduledTask[], o: ViewOptions): string {
  if (tasks.length === 0) return REMINDERS_TEXT.none;
  const blocks = tasks.map(task => {
    const v = reminderView(task, o);
    const meta = [
      `Kennung ${v.ref}`,
      v.place,
      ...(v.recurrenceText ? [v.recurrenceText] : []),
      ...(v.status === "running" ? [REMINDERS_TEXT.sendingState] : v.overdue ? [REMINDERS_TEXT.overdue] : []),
    ];
    return `• ${v.dueText} · ${v.text}\n   ${meta.join(" · ")}`;
  });
  return `${REMINDERS_TEXT.heading(tasks.length)}\n\n${blocks.join("\n\n")}\n\n${REMINDERS_TEXT.cancelHint}`;
}

/** Kennung, wie sie getippt werden darf: Hex und Bindestriche, ab 4 Zeichen, optional mit # */
const REF_INPUT = /^#?([0-9a-z-]{4,36})$/;

/** Gelesene Kennung oder null */
export function parseReminderRef(input: string): string | null {
  const m = REF_INPUT.exec(input.trim().toLowerCase());
  return m ? m[1] : null;
}

export type CancelOutcome =
  | { status: "cancelled"; task: ScheduledTask }
  | { status: "sending" | "already-cancelled" | "done" | "failed-earlier"; task: ScheduledTask }
  | { status: "unknown" | "ambiguous" | "unreadable" }
  | { status: "error"; task: ScheduledTask };

/**
 * Sagt die Erinnerung mit dieser Kennung (Anfang der ID) ab. Passt die
 * Kennung auf mehrere, entscheidet nur ein einziger offener Treffer; sonst
 * "ambiguous". Mit exact zählt nur die ganze ID. Ein Erfolg nur, wenn
 * cancel() der Ablage zutraf; ist die Ablage nicht lesbar, "unreadable".
 */
export async function cancelReminder(store: ScheduleStore, ref: string, o: { exact?: boolean } = {}): Promise<CancelOutcome> {
  const key = ref.toLowerCase();
  const found = await store.listAll({ idPrefix: key });
  if (!found) return { status: "unreadable" };
  const all = found.filter(t => t.kind === "reminder" && (o.exact ? t.id.toLowerCase() === key : t.id.toLowerCase().startsWith(key)));
  if (all.length === 0) return { status: "unknown" };
  const open = all.filter(t => t.status === "pending" || t.status === "running");
  const hit = all.length === 1 ? all[0] : open.length === 1 ? open[0] : null;
  if (!hit) return { status: "ambiguous" };
  if (hit.status === "pending" && (await store.cancel(hit.id))) return { status: "cancelled", task: hit };
  // Nicht (mehr) wartend: frisch lesen, was daraus wurde
  const now = (await store.byId(hit.id)) ?? hit;
  if (now.status === "running") return { status: "sending", task: now };
  if (now.status === "cancelled") return { status: "already-cancelled", task: now };
  if (now.status === "done") return { status: "done", task: now };
  if (now.status === "failed") return { status: "failed-earlier", task: now };
  return { status: "error", task: now };
}

/** Antwort auf eine Absage in Worten */
export function cancelText(outcome: CancelOutcome, ref: string): string {
  switch (outcome.status) {
    case "unknown":
      return REMINDERS_TEXT.unknown(ref);
    case "ambiguous":
      return REMINDERS_TEXT.ambiguous(ref);
    case "unreadable":
      return REMINDERS_TEXT.unreadableCancel;
    case "cancelled": {
      const rule = recurrenceText(outcome.task.recurrence);
      return rule ? REMINDERS_TEXT.cancelledSeries(outcome.task.text, rule) : REMINDERS_TEXT.cancelled(outcome.task.text);
    }
    case "sending":
      return REMINDERS_TEXT.sending(outcome.task.text);
    case "already-cancelled":
      return REMINDERS_TEXT.alreadyCancelled(outcome.task.text);
    case "done":
      return REMINDERS_TEXT.alreadyDone(outcome.task.text);
    case "failed-earlier":
      return REMINDERS_TEXT.alreadyFailed(outcome.task.text);
    case "error":
      return REMINDERS_TEXT.failed;
  }
}
