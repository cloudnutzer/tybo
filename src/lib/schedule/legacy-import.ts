/**
 * Einmaliger Import alter Erinnerungen (Issue #323) aus config/reminders.json,
 * der Datei eines früheren Shell-Skripts außerhalb von tybo.
 *
 * Format der Altdatei: ein Array von Objekten
 *   { "id": …, "date": "YYYY-MM-DD", "time": "HH:MM", "message": "…",
 *     "sent": false, "sent_at": "…" (optional) }
 *
 * Regeln:
 * - Übernommen werden nur ungesendete Einträge: sent false und kein
 *   sent_at. sent true oder ein sent_at gelten als zugestellt (lieber eine
 *   alte Erinnerung weniger als eine doppelte).
 * - Datum und Uhrzeit sind Ortszeit in USER_TIMEZONE. Fehlt die Uhrzeit
 *   (oder ist sie leer), gilt 9 Uhr wie bei [REMIND:] mit nur einem Tag.
 * - Liegt der Zeitpunkt schon zurück, kommt die Erinnerung im nächsten
 *   Durchlauf des Planers, mit Hinweis auf die Verspätung.
 * - Ziel ist der Direktchat (TELEGRAM_USER_ID, ohne Telegram der
 *   Web-Direktchat): dorthin schickte das alte Skript.
 * - Ungültige Einträge (kein Objekt, Datum oder Uhrzeit unlesbar, leerer
 *   Text, sent kein Wahrheitswert) werden nicht übernommen und mit Position
 *   und Grund gemeldet.
 *
 * Genau einmal: Jeder Eintrag bekommt eine feste ID, berechnet aus seinen
 * Feldern (id, date, time, message), und wird mit addOnce angelegt. Die
 * Ablage prüft beim Schreiben, ob es die ID schon gibt (Datei: in derselben
 * Transaktion, Supabase: ON CONFLICT DO NOTHING). Ein zweiter Import, ein
 * Import nach einem Neustart, nach einem Teilfehler oder zwei gleichzeitige
 * Importe legen deshalb nichts doppelt an; auch eine inzwischen abgesagte
 * oder zugestellte Erinnerung kommt nicht wieder.
 */
import { createHash } from "node:crypto";
import { effectiveTimeZone, fromLocal } from "../when";
import type { ScheduleStore } from "./contract";
import { REMIND_DEFAULT_HOUR } from "./remind";

export interface LegacyImportOptions {
  /** Chat des Direktchats */
  chatId: string;
  /** IANA-Zeitzone; Standard USER_TIMEZONE */
  timeZone?: string;
  now?: number;
}

export interface LegacyInvalid {
  /** Position im Array, ab 1 */
  position: number;
  reason: string;
}

export interface LegacyImportReport {
  /** Neu angelegt */
  added: Array<{ id: string; text: string; dueAt: string; overdue: boolean }>;
  /** Schon früher importiert, nichts geändert */
  existing: number;
  /** Laut Altdatei schon zugestellt */
  sent: number;
  invalid: LegacyInvalid[];
  /** Ablage hat nicht angenommen; derselbe Import kann wiederholt werden */
  failed: number;
}

export const LEGACY_TEXT = {
  notArray: "Die Datei enthält kein Array von Erinnerungen.",
  unreadable: "Die Datei ist kein gültiges JSON.",
  notObject: "kein Objekt",
  badDate: "Datum fehlt oder ist nicht JJJJ-MM-TT",
  badTime: "Uhrzeit ist nicht HH:MM",
  noText: "Text (message) fehlt",
  badSent: "sent ist weder true noch false",
} as const;

/** Feste ID eines Alteintrags: UUID-Form aus SHA-256 der Felder */
export function legacyTaskId(entry: { id?: unknown; date: string; time: string; message: string }): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(["tybo-reminders-import-v1", entry.id ?? null, entry.date, entry.time, entry.message]))
    .digest("hex");
  // Version 5 und Variante 10xx wie eine namensbasierte UUID
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{1,2}):(\d{2})$/;

type Parsed = { kind: "sent" } | { kind: "invalid"; reason: string } | { kind: "open"; date: string; time: string; message: string; due: Date };

function parseEntry(raw: unknown, zone: string): Parsed {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { kind: "invalid", reason: LEGACY_TEXT.notObject };
  const e = raw as Record<string, unknown>;
  if (e.sent !== true && e.sent !== false) return { kind: "invalid", reason: LEGACY_TEXT.badSent };
  const sentAt = typeof e.sent_at === "string" ? e.sent_at.trim() : e.sent_at;
  if (e.sent === true || (sentAt !== undefined && sentAt !== null && sentAt !== "")) return { kind: "sent" };
  const message = typeof e.message === "string" ? e.message.trim() : "";
  if (!message) return { kind: "invalid", reason: LEGACY_TEXT.noText };
  const date = typeof e.date === "string" ? e.date.trim() : "";
  const d = DATE.exec(date);
  if (!d) return { kind: "invalid", reason: LEGACY_TEXT.badDate };
  const [year, month, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  // Kalendertag prüfen (kein 31.02.)
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return { kind: "invalid", reason: LEGACY_TEXT.badDate };
  const time = e.time === undefined || e.time === null ? "" : typeof e.time === "string" ? e.time.trim() : null;
  if (time === null) return { kind: "invalid", reason: LEGACY_TEXT.badTime };
  let hour = REMIND_DEFAULT_HOUR;
  let minute = 0;
  if (time !== "") {
    const t = TIME.exec(time);
    if (!t || Number(t[1]) > 23 || Number(t[2]) > 59) return { kind: "invalid", reason: LEGACY_TEXT.badTime };
    [hour, minute] = [Number(t[1]), Number(t[2])];
  }
  const ms = fromLocal(year, month, day, hour, minute, 0, zone);
  if (!Number.isFinite(ms)) return { kind: "invalid", reason: LEGACY_TEXT.badDate };
  return { kind: "open", date, time, message, due: new Date(ms) };
}

/** Liest die Altdatei; wirft mit verständlicher Meldung, wenn sie kein Array ist */
export function parseLegacyFile(content: string): unknown[] {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    throw new Error(LEGACY_TEXT.unreadable);
  }
  if (!Array.isArray(data)) throw new Error(LEGACY_TEXT.notArray);
  return data;
}

/** Übernimmt die ungesendeten Einträge (siehe Kopf); nie doppelt */
export async function importLegacyReminders(store: ScheduleStore, entries: unknown[], o: LegacyImportOptions): Promise<LegacyImportReport> {
  const zone = effectiveTimeZone(o.timeZone);
  const now = o.now ?? Date.now();
  const report: LegacyImportReport = { added: [], existing: 0, sent: 0, invalid: [], failed: 0 };
  for (const [index, raw] of entries.entries()) {
    const parsed = parseEntry(raw, zone);
    if (parsed.kind === "sent") {
      report.sent++;
      continue;
    }
    if (parsed.kind === "invalid") {
      report.invalid.push({ position: index + 1, reason: parsed.reason });
      continue;
    }
    const id = legacyTaskId({ id: (raw as Record<string, unknown>).id, date: parsed.date, time: parsed.time, message: parsed.message });
    const outcome = await store.addOnce(id, { chatId: o.chatId, text: parsed.message, dueAt: parsed.due });
    if (outcome === "added") report.added.push({ id, text: parsed.message, dueAt: parsed.due.toISOString(), overdue: parsed.due.getTime() < now });
    else if (outcome === "exists") report.existing++;
    else report.failed++;
  }
  return report;
}
