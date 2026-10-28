/**
 * Regeln für proaktive Meldungen (Issue #361): darf eine Art jetzt senden?
 *
 * Reihenfolge der Prüfung, der erste Treffer ist der Grund:
 * 1. disabled: die Art ist abgeschaltet
 * 2. quiet: die Ortszeit liegt in der Ruhezeit
 * 3. window: die Ortszeit liegt außerhalb des Zeitfensters der Art
 * 4. snoozed: Snooze der Art läuft noch (bis snoozedUntil ausschließlich)
 * 5. done-today: einmal je Tag und am selben Ortsdatum schon zugestellt
 * 6. gap: seit der letzten Zustellung der Art ist der Mindestabstand noch
 *    nicht vergangen (echte Dauer, genau der Abstand reicht)
 *
 * Reine Funktion ohne Uhr und Dateien: Zeit, Zone, Einstellungen und Zustand
 * kommen herein, damit sich jede Grenze mit einer Uhr-Attrappe prüfen lässt.
 */

import { localMoment, withinSpan } from "./clock";
import type { KindConfig } from "./config";

export type SkipReason = "disabled" | "quiet" | "window" | "snoozed" | "done-today" | "gap";

export interface KindRecord {
  /** Zeitpunkt der letzten bestätigten Zustellung (ISO) */
  lastSentAt?: string;
  /** Ortsdatum der letzten bestätigten Zustellung, YYYY-MM-DD */
  lastDate?: string;
  /** Snooze bis (ISO, ausschließlich) */
  snoozedUntil?: string;
}

export type Verdict = { send: true } | { send: false; reason: SkipReason };

function time(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function judgeKind(input: {
  now: Date;
  zone: string;
  quietHours: { from: string; to: string };
  kind: KindConfig;
  record: KindRecord;
}): Verdict {
  const { now, zone, quietHours, kind, record } = input;
  if (!kind.enabled) return { send: false, reason: "disabled" };

  const local = localMoment(now, zone);
  if (withinSpan(local.minutes, quietHours)) return { send: false, reason: "quiet" };
  if (!withinSpan(local.minutes, kind.window)) return { send: false, reason: "window" };

  const snoozeEnd = time(record.snoozedUntil);
  if (snoozeEnd !== null && now.getTime() < snoozeEnd) return { send: false, reason: "snoozed" };

  if (kind.oncePerDay && record.lastDate === local.date) return { send: false, reason: "done-today" };

  const last = time(record.lastSentAt);
  if (kind.minGapMinutes > 0 && last !== null && now.getTime() - last < kind.minGapMinutes * 60_000) {
    return { send: false, reason: "gap" };
  }
  return { send: true };
}
