/**
 * Einstellungen der proaktiven Meldungen (Issue #361): Block proactive in
 * config/settings.json, ergänzt um die Standards im Code. Gelesen wird bei
 * jedem Aufruf (getSettings liest die Datei nur bei Änderung neu).
 *
 * Arten: briefing (Morgenbriefing) und checkin (Check-in). Jede Art hat ihr
 * eigenes Zeitfenster; die Ruhezeit gilt für beide.
 *
 * - quietHours: Standard 21:00 bis 08:00 (bis ausschließlich)
 * - briefing.enabled: Standard an; briefing.window: Standard 09:00 bis 12:00
 * - checkin.enabled: Standard an; checkin.window: Standard 10:00 bis 19:00
 * - checkin.times: Startzeiten des Dienstes, Standard stündlich 10:30 bis
 *   18:30 (neun Termine); [] heißt ausdrücklich keine Termine. Nur für die
 *   Einrichtung des Zeitplans, die Regeln lesen sie nicht
 * - checkin.minGapMinutes: Mindestabstand zwischen zwei Check-ins, Standard 90
 *
 * Das Briefing kommt höchstens einmal je Kalendertag (Ortszeit) und hat
 * keinen Mindestabstand. Mindestabstand und Snooze gelten nur für ihre Art.
 */

import { getSettings, type Settings } from "../settings";
import type { ClockSpan } from "./clock";

export const PROACTIVE_KINDS = ["briefing", "checkin"] as const;
export type ProactiveKind = (typeof PROACTIVE_KINDS)[number];

export interface KindConfig {
  enabled: boolean;
  window: ClockSpan;
  /** 0: kein Mindestabstand */
  minGapMinutes: number;
  /** höchstens einmal je Kalendertag der Ortszeit */
  oncePerDay: boolean;
}

export interface ProactiveConfig {
  quietHours: ClockSpan;
  briefing: KindConfig;
  checkin: KindConfig & { times: string[] };
}

export const PROACTIVE_DEFAULTS: Readonly<ProactiveConfig> = Object.freeze({
  quietHours: { from: "21:00", to: "08:00" },
  briefing: { enabled: true, window: { from: "09:00", to: "12:00" }, minGapMinutes: 0, oncePerDay: true },
  checkin: {
    enabled: true,
    window: { from: "10:00", to: "19:00" },
    minGapMinutes: 90,
    oncePerDay: false,
    times: ["10:30", "11:30", "12:30", "13:30", "14:30", "15:30", "16:30", "17:30", "18:30"],
  },
});

/** Wirksame Einstellungen: Datei vor Standard, Feld für Feld */
export function proactiveConfig(settings: Settings = getSettings()): ProactiveConfig {
  const own = settings.proactive ?? {};
  const base = PROACTIVE_DEFAULTS;
  return {
    quietHours: { ...(own.quietHours ?? base.quietHours) },
    briefing: {
      ...base.briefing,
      enabled: own.briefing?.enabled ?? base.briefing.enabled,
      window: { ...(own.briefing?.window ?? base.briefing.window) },
    },
    checkin: {
      ...base.checkin,
      enabled: own.checkin?.enabled ?? base.checkin.enabled,
      window: { ...(own.checkin?.window ?? base.checkin.window) },
      minGapMinutes: own.checkin?.minGapMinutes ?? base.checkin.minGapMinutes,
      times: [...(own.checkin?.times ?? base.checkin.times)],
    },
  };
}
