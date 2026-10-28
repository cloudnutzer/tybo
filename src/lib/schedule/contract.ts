/**
 * Vertrag der Ablage für Erinnerungen (Issue #321, Übernahme seit #322):
 * Typen und die Prüfungen, die beide Adapter teilen. Beschreibung des
 * Vertrags in store.ts.
 */
import { formatRecurrence, parseRecurrence } from "../recurrence";

export const SCHEDULE_KINDS = ["reminder", "action"] as const;
export const SCHEDULE_STATUSES = ["pending", "running", "done", "failed", "cancelled"] as const;

export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

export interface ScheduledTask {
  id: string;
  chatId: string;
  topicId: number | null;
  kind: ScheduleKind;
  text: string;
  dueAt: string;
  recurrence: string | null;
  status: ScheduleStatus;
  attempts: number;
  lastError: string | null;
  /** Wer die Zeile gerade verschickt (Planer, Issue #322); null: niemand */
  leaseOwner: string | null;
  /** Bis wann die Übernahme gilt, ISO in UTC; null: keine */
  leaseUntil: string | null;
  /**
   * Wann der Besitzer der Übernahme mit dem Versand begonnen hat, ISO in UTC;
   * null: kein Versand begonnen. Unterscheidet nach einem Absturz „nie
   * gesendet" (wird nachgeholt) von „Ausgang unbekannt" (planner.ts)
   */
  sendStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewScheduledTask {
  chatId: string;
  topicId?: number | null;
  kind?: ScheduleKind;
  text: string;
  dueAt: Date;
  recurrence?: string | null;
}

/** Felder, die sich ändern lassen; was fehlt, bleibt */
export interface ScheduleChanges {
  text?: string;
  dueAt?: Date;
  recurrence?: string | null;
  status?: ScheduleStatus;
  attempts?: number;
  lastError?: string | null;
  leaseOwner?: string | null;
  leaseUntil?: Date | null;
  sendStartedAt?: Date | null;
}

/**
 * Bedingung einer Änderung (updateIf): alle gesetzten Felder müssen beim
 * Schreiben zutreffen, geprüft in derselben Änderung. So übernimmt von zwei
 * gleichzeitigen Durchläufen genau einer.
 */
export interface ScheduleCondition {
  status?: ScheduleStatus;
  /** dueAt genau dieser Zeitpunkt */
  dueAt?: Date;
  /** dueAt bis einschließlich dieses Zeitpunkts */
  dueBy?: Date;
  /** leaseOwner genau dieser Wert; null: keiner eingetragen */
  leaseOwner?: string | null;
  /** leaseUntil gesetzt und vor diesem Zeitpunkt (abgelaufen) */
  leaseUntilBefore?: Date;
  /** sendStartedAt null (true: kein Versand begonnen) bzw. gesetzt (false) */
  notSending?: boolean;
}

export interface ScheduleFilter {
  chatId?: string;
  /** Fehlt: alle Topics des Chats; null: nur ohne Topic */
  topicId?: number | null;
  /** Fehlt: jeder Status */
  status?: ScheduleStatus[];
  /**
   * Nur IDs mit diesem Anfang (Groß- und Kleinschreibung egal), für die
   * Kennung aus /erinnerungen (Issue #323). Nur listAll beachtet es.
   */
  idPrefix?: string;
}

/** Ausgang von addOnce: neu angelegt, schon vorhanden (nichts geändert), oder Fehler */
export type AddOnceOutcome = "added" | "exists" | "failed";

/** Feste IDs für addOnce: UUID in Kleinbuchstaben (wie die Spalte id in scheduled_tasks) */
export const FIXED_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ScheduleStore {
  add(task: NewScheduledTask): Promise<ScheduledTask | null>;
  /**
   * Legt den Eintrag mit genau dieser ID an, wenn es sie noch nicht gibt
   * (Issue #323, Altimport). Geprüft in derselben Änderung: von zwei
   * gleichzeitigen Aufrufen legt genau einer an, der andere bekommt
   * "exists". Ein vorhandener Eintrag bleibt unverändert, gleich in welchem
   * Status. Ungültige ID oder Eingabe: "failed".
   */
  addOnce(id: string, task: NewScheduledTask): Promise<AddOnceOutcome>;
  byId(id: string): Promise<ScheduledTask | null>;
  list(filter?: ScheduleFilter): Promise<ScheduledTask[]>;
  /**
   * Wie list, aber für die Verwaltung (Issue #323): vollständig, bei
   * Supabase über alle Antwortseiten (max_rows), und mit Fehlern. null heißt
   * „Ablage nicht lesbar", eine leere Liste heißt wirklich leer.
   */
  listAll(filter?: ScheduleFilter): Promise<ScheduledTask[] | null>;
  /**
   * Wartende Einträge mit dueAt bis einschließlich now, älteste zuerst,
   * höchstens limit; mit kind nur Einträge dieser Art (gefiltert vor dem Limit)
   */
  due(now: Date, limit: number, kind?: ScheduleKind): Promise<ScheduledTask[]>;
  /** Der geänderte Eintrag; null, wenn es ihn nicht gibt oder ein Wert ungültig ist */
  update(id: string, changes: ScheduleChanges): Promise<ScheduledTask | null>;
  /** Setzt einen wartenden Eintrag auf cancelled; false, wenn er nicht (mehr) wartet */
  cancel(id: string): Promise<boolean>;
  /**
   * Ändert nur, wenn die Bedingung beim Schreiben zutrifft (atomar). Der
   * geänderte Eintrag; null, wenn es ihn nicht gibt, die Bedingung nicht
   * zutrifft oder ein Wert ungültig ist.
   */
  updateIf(id: string, condition: ScheduleCondition, changes: ScheduleChanges): Promise<ScheduledTask | null>;
}

// ---------------------------------------------------------------------------
// Prüfungen, die beide Adapter teilen
// ---------------------------------------------------------------------------

/** Neuer Eintrag in Spaltenform (wie scheduled_tasks), ohne die Vorgaben der Ablage */
export interface NewRow {
  chat_id: string;
  topic_id: number | null;
  kind: ScheduleKind;
  text: string;
  due_at: string;
  recurrence: string | null;
}

/** Änderung in Spaltenform; nur die gesetzten Felder */
export type ChangeRow = Partial<Pick<NewRow, "text" | "due_at" | "recurrence">> & {
  status?: ScheduleStatus;
  attempts?: number;
  last_error?: string | null;
  lease_owner?: string | null;
  lease_until?: string | null;
  send_started_at?: string | null;
};

const filledText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function isoOf(value: unknown): string | null {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
  return value.toISOString();
}

/** Wiederholung in kanonischer Form (recurrence.ts) oder null; undefined heißt ungültig */
function recurrenceOf(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  const rule = typeof value === "string" ? parseRecurrence(value) : null;
  return rule ? formatRecurrence(rule) : undefined;
}

const isKind = (value: unknown): value is ScheduleKind => (SCHEDULE_KINDS as readonly unknown[]).includes(value);
const isStatus = (value: unknown): value is ScheduleStatus => (SCHEDULE_STATUSES as readonly unknown[]).includes(value);

/** Spalten eines neuen Eintrags oder null, wenn etwas nicht passt */
export function newRow(task: NewScheduledTask): NewRow | null {
  const due = isoOf(task?.dueAt);
  const topic = task?.topicId ?? null;
  const kind = task?.kind ?? "reminder";
  const recurrence = recurrenceOf(task?.recurrence);
  if (!filledText(task?.chatId) || !filledText(task?.text) || !due || !isKind(kind) || recurrence === undefined) return null;
  if (topic !== null && !Number.isSafeInteger(topic)) return null;
  return { chat_id: task.chatId, topic_id: topic, kind, text: task.text, due_at: due, recurrence };
}

/** Spalten einer Änderung oder null, wenn ein Wert nicht passt */
export function changeRow(changes: ScheduleChanges): ChangeRow | null {
  const row: ChangeRow = {};
  if (changes.text !== undefined) {
    if (!filledText(changes.text)) return null;
    row.text = changes.text;
  }
  if (changes.dueAt !== undefined) {
    const due = isoOf(changes.dueAt);
    if (!due) return null;
    row.due_at = due;
  }
  if (changes.recurrence !== undefined) {
    const recurrence = recurrenceOf(changes.recurrence);
    if (recurrence === undefined) return null;
    row.recurrence = recurrence;
  }
  if (changes.status !== undefined) {
    if (!isStatus(changes.status)) return null;
    row.status = changes.status;
  }
  if (changes.attempts !== undefined) {
    if (!Number.isSafeInteger(changes.attempts) || changes.attempts < 0) return null;
    row.attempts = changes.attempts;
  }
  if (changes.lastError !== undefined) {
    if (changes.lastError !== null && typeof changes.lastError !== "string") return null;
    row.last_error = changes.lastError;
  }
  if (changes.leaseOwner !== undefined) {
    if (changes.leaseOwner !== null && !filledText(changes.leaseOwner)) return null;
    row.lease_owner = changes.leaseOwner;
  }
  if (changes.leaseUntil !== undefined) {
    if (changes.leaseUntil === null) row.lease_until = null;
    else {
      const until = isoOf(changes.leaseUntil);
      if (!until) return null;
      row.lease_until = until;
    }
  }
  if (changes.sendStartedAt !== undefined) {
    if (changes.sendStartedAt === null) row.send_started_at = null;
    else {
      const started = isoOf(changes.sendStartedAt);
      if (!started) return null;
      row.send_started_at = started;
    }
  }
  return row;
}

/** Ob die Bedingung gültig ist: jedes gesetzte Feld mit brauchbarem Wert */
export function validCondition(condition: ScheduleCondition): boolean {
  if (!condition || typeof condition !== "object") return false;
  if (condition.status !== undefined && !isStatus(condition.status)) return false;
  for (const date of [condition.dueAt, condition.dueBy, condition.leaseUntilBefore]) {
    if (date !== undefined && !isoOf(date)) return false;
  }
  if (condition.leaseOwner !== undefined && condition.leaseOwner !== null && !filledText(condition.leaseOwner)) return false;
  if (condition.notSending !== undefined && typeof condition.notSending !== "boolean") return false;
  return true;
}

/** Ob ein Eintrag die Bedingung erfüllt (für den Datei-Adapter und Tests) */
export function meetsCondition(task: ScheduledTask, condition: ScheduleCondition): boolean {
  if (condition.status !== undefined && task.status !== condition.status) return false;
  if (condition.dueAt !== undefined && Date.parse(task.dueAt) !== condition.dueAt.getTime()) return false;
  if (condition.dueBy !== undefined && !(Date.parse(task.dueAt) <= condition.dueBy.getTime())) return false;
  if (condition.leaseOwner !== undefined && task.leaseOwner !== condition.leaseOwner) return false;
  if (condition.leaseUntilBefore !== undefined) {
    if (task.leaseUntil === null || !(Date.parse(task.leaseUntil) < condition.leaseUntilBefore.getTime())) return false;
  }
  if (condition.notSending !== undefined && (task.sendStartedAt === null) !== condition.notSending) return false;
  return true;
}

/** Ob ein Eintrag zum Filter passt (für den Datei-Adapter und Tests) */
export function matchesFilter(task: ScheduledTask, filter: ScheduleFilter = {}): boolean {
  if (filter.chatId !== undefined && task.chatId !== filter.chatId) return false;
  if (filter.topicId !== undefined && task.topicId !== filter.topicId) return false;
  if (filter.status && !filter.status.includes(task.status)) return false;
  if (filter.idPrefix !== undefined && !task.id.toLowerCase().startsWith(filter.idPrefix.toLowerCase())) return false;
  return true;
}

/** Reihenfolge der Listen: Fälligkeit, dann Anlage */
export function byDue(a: ScheduledTask, b: ScheduledTask): number {
  return Date.parse(a.dueAt) - Date.parse(b.dueAt) || Date.parse(a.createdAt) - Date.parse(b.createdAt);
}
