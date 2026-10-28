/**
 * Startzeiten für die Einrichtung der Dienste (Issue #361), Übergang bis zum
 * Zeitplan aus den Einstellungen (U2h): src/setup/services/launchd.ts und
 * src/setup/services/linux.ts legen damit fest, wann Check-in und Briefing
 * starten. Die frühere Vorlage config/schedule.example.json gibt es nicht
 * mehr.
 *
 * Vorrang, Feld für Feld:
 * 1. config/schedule.json einer bestehenden Installation (wie bisher)
 * 2. Block proactive in config/settings.json
 * 3. Standards aus config.ts: neun Check-ins 10:30 bis 18:30, Briefing 09:00
 * Eine kaputte schedule.json oder ungültige settings.json zählt wie eine
 * fehlende, mit einer Zeile im Log. Eine ausdrücklich leere Liste
 * check_in_intervals ([]) in schedule.json bleibt leer: keine Check-ins, wie
 * bisher; ebenso checkin.times: [] in den Einstellungen. Fehlt
 * check_in_intervals in einer vorhandenen schedule.json, gelten
 * checkin.times aus den Einstellungen, sonst die bisherigen Ersatztermine
 * der Plattform (LEGACY_MISSING_CHECKINS), nicht die neun Standardtermine.
 *
 * Ein Zeitplan durchläuft drei Darstellungen: Einträge aus schedule.json,
 * checkin.times in den Einstellungen und die Ausgabe für launchd, cron und
 * die Aufgabenplanung. Damit dabei keine Startzeit dazukommt oder verloren
 * geht, gilt:
 * - Welche Startzeiten ein alter Eintrag hat, legt allein legacyStartMinutes
 *   fest (für das Briefing legacyBriefingStart), und zwar so, wie die
 *   bisherige Einrichtung ihn auf der jeweiligen Plattform gelesen hat: ein
 *   fehlendes Feld ist unter launchd jeder Wert ("wildcard"), unter cron und
 *   in der Aufgabenplanung 0 ("zero"). Die Einrichtung mit schedule.json und
 *   die Übernahme (migrate.ts) rechnen beide damit; nach der Übernahme
 *   startet ein Dienst also zu denselben Zeiten wie vorher mit der alten
 *   Datei.
 * - setupSchedule liefert nur feste Termine (ClockSlot, Stunde und Minute
 *   gesetzt), einen je Startzeit. cron und die Aufgabenplanung bekommen damit
 *   genau diese Startzeiten.
 * - Platzhalter entstehen nur in compactForLaunchd, die allein die
 *   launchd-Ausgabe aufruft; dort bedeuten sie dieselben Startzeiten.
 */

import { join } from "path";
import { settingsSchema, type Settings } from "../settings";
import { clockMinutes } from "./clock";
import { proactiveConfig } from "./config";

/** Ein Termin wie in launchd StartCalendarInterval: ein fehlendes Feld steht für jeden Wert */
export interface SetupInterval {
  hour?: number;
  minute?: number;
}

/** Ein fester Termin: eine Startzeit, Stunde und Minute gesetzt */
export interface ClockSlot {
  hour: number;
  minute: number;
}

/**
 * Wie die bisherige Einrichtung ein fehlendes Feld in einem Eintrag von
 * check_in_intervals las: launchd (macOS) als jeden Wert, cron (Linux) und
 * die Aufgabenplanung (Windows) als 0.
 */
export type LegacyReading = "wildcard" | "zero";

/** Lesart der Plattform, auf der die bisherige Einrichtung lief */
export function legacyReadingFor(platform: NodeJS.Platform = process.platform): LegacyReading {
  return platform === "darwin" ? "wildcard" : "zero";
}

const ALL_HOURS = Array.from({ length: 24 }, (_, i) => i);
const ALL_MINUTES = Array.from({ length: 60 }, (_, i) => i);
const inRange = (v: unknown, max: number): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;

/** Eintrag aus check_in_intervals; null, wenn Stunde oder Minute ungültig ist */
export function legacyInterval(raw: unknown): SetupInterval | null {
  if (!raw || typeof raw !== "object") return null;
  const { hour, minute } = raw as Record<string, unknown>;
  if (hour !== undefined && !inRange(hour, 23)) return null;
  if (minute !== undefined && !inRange(minute, 59)) return null;
  return { ...(hour !== undefined && { hour }), ...(minute !== undefined && { minute }) };
}

/** Startzeiten eines Termins in Minuten nach Mitternacht, mit launchd-Platzhaltern */
export function intervalMinutes(slot: SetupInterval): number[] {
  const hours = slot.hour === undefined ? ALL_HOURS : [slot.hour];
  const minutes = slot.minute === undefined ? ALL_MINUTES : [slot.minute];
  return hours.flatMap(h => minutes.map(m => h * 60 + m));
}

/** Startzeiten eines Eintrags aus check_in_intervals in der Lesart der Plattform; null bei ungültigem Eintrag */
export function legacyStartMinutes(raw: unknown, reading: LegacyReading): number[] | null {
  const slot = legacyInterval(raw);
  if (!slot) return null;
  if (reading === "wildcard") return intervalMinutes(slot);
  return [(slot.hour ?? 0) * 60 + (slot.minute ?? 0)];
}

const sortedUnique = (minutes: Iterable<number>): number[] => [...new Set(minutes)].sort((a, b) => a - b);

/**
 * Check-in-Termine, die die bisherige Einrichtung nahm, wenn schedule.json
 * kein check_in_intervals hatte (`schedule.check_in_intervals || [...]`):
 * die launchd-Einrichtung fünf, die frühere setup/configure-services.ts für cron und
 * die Aufgabenplanung drei. Nur für bestehende Installationen; ohne
 * schedule.json gelten die neun Standardtermine aus config.ts.
 */
export const LEGACY_MISSING_CHECKINS: Record<LegacyReading, readonly number[]> = {
  wildcard: [10, 12, 14, 16, 18].map(h => h * 60 + 30),
  zero: [10, 14, 18].map(h => h * 60 + 30),
};

/** Fehlt check_in_intervals in der Lesart der bisherigen Einrichtung (jeder falsche Wert, wie `||`)? */
export const legacyCheckinsMissing = (list: unknown): boolean => !list;

/**
 * Startzeiten der ganzen Liste check_in_intervals, sortiert und ohne
 * Doppelte. [] bleibt leer (keine Check-ins); fehlt die Liste, die
 * bisherigen Ersatztermine der Plattform (LEGACY_MISSING_CHECKINS); null,
 * wenn sie keine Liste ist oder nur ungültige Einträge hat (dann gilt, was
 * sonst gilt). Einzelne ungültige Einträge fallen weg.
 */
export function legacyCheckinMinutes(list: unknown, reading: LegacyReading): number[] | null {
  if (legacyCheckinsMissing(list)) return [...LEGACY_MISSING_CHECKINS[reading]];
  if (!Array.isArray(list)) return null;
  if (list.length === 0) return [];
  const valid = list.map(entry => legacyStartMinutes(entry, reading)).filter((m): m is number[] => m !== null);
  return valid.length === 0 ? null : sortedUnique(valid.flat());
}

/** Beginn des Briefings aus morning_briefing in Minuten nach Mitternacht; fehlende Minute ist 0, null bei ungültiger Zeit */
export function legacyBriefingStart(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const { hour, minute } = raw as Record<string, unknown>;
  if (!inRange(hour, 23)) return null;
  if (minute !== undefined && !inRange(minute, 59)) return null;
  return hour * 60 + ((minute as number | undefined) ?? 0);
}

const toSlot = (minutes: number): ClockSlot => ({ hour: Math.floor(minutes / 60), minute: minutes % 60 });

export interface SetupSchedule {
  morning_briefing: ClockSlot & { enabled: boolean };
  check_in_intervals: ClockSlot[];
}

export interface SetupScheduleIo {
  exists(path: string): boolean;
  readFile(path: string): string;
  log(line: string): void;
}

function readJson(path: string, io: SetupScheduleIo, label: string): unknown {
  if (!io.exists(path)) return undefined;
  try {
    return JSON.parse(io.readFile(path));
  } catch {
    io.log(`  ! ${label} nicht lesbar, Standard-Zeitplan gilt`);
    return undefined;
  }
}

/**
 * Nur für die launchd-Ausgabe: dieselben Startzeiten mit möglichst wenigen
 * Terminen. Volle Reihen werden Platzhalter: alle 24 Stunden zur selben
 * Minute → {minute}, alle 60 Minuten einer Stunde → {hour}, der ganze Tag →
 * {}. cron und die Aufgabenplanung bekommen nie das Ergebnis dieser Funktion.
 */
export function compactForLaunchd(slots: ClockSlot[]): SetupInterval[] {
  const set = new Set(slots.map(s => s.hour * 60 + s.minute));
  if (set.size === 1440) return [{}];
  const everyHour = ALL_MINUTES.filter(m => ALL_HOURS.every(h => set.has(h * 60 + m)));
  const everyMinute = ALL_HOURS.filter(h => ALL_MINUTES.every(m => set.has(h * 60 + m)));
  const rest = sortedUnique(set)
    .filter(t => !everyHour.includes(t % 60) && !everyMinute.includes(Math.floor(t / 60)))
    .map(toSlot);
  return [...everyHour.map(minute => ({ minute })), ...everyMinute.map(hour => ({ hour })), ...rest];
}

/**
 * Zeitplan der Einrichtung. reading ist die Lesart der Plattform, für die
 * eingerichtet wird (launchd "wildcard", cron und Aufgabenplanung "zero");
 * sie zählt nur für eine vorhandene schedule.json.
 */
export function setupSchedule(projectRoot: string, io: SetupScheduleIo, reading: LegacyReading): SetupSchedule {
  let settings: Settings = {};
  const rawSettings = readJson(join(projectRoot, "config", "settings.json"), io, "config/settings.json");
  if (rawSettings !== undefined) {
    const parsed = settingsSchema.safeParse(rawSettings);
    if (parsed.success) settings = parsed.data;
    else io.log("  ! config/settings.json ungültig, Standard-Zeitplan gilt");
  }
  const config = proactiveConfig(settings);
  const fromSettings = (times: string[]) => sortedUnique(times.map(clockMinutes).filter((m): m is number => m !== null));
  const result: SetupSchedule = {
    morning_briefing: { ...toSlot(clockMinutes(config.briefing.window.from) ?? 0), enabled: config.briefing.enabled },
    check_in_intervals: fromSettings(config.checkin.times).map(toSlot),
  };

  const legacy = readJson(join(projectRoot, "config", "schedule.json"), io, "config/schedule.json") as any;
  if (!legacy || typeof legacy !== "object") return result;
  // Fehlt die Liste, gehen ausdrücklich gesetzte checkin.times vor, wie nach der Übernahme
  const keepSettings = legacyCheckinsMissing(legacy.check_in_intervals) && settings.proactive?.checkin?.times !== undefined;
  const checkins = keepSettings ? null : legacyCheckinMinutes(legacy.check_in_intervals, reading);
  if (checkins) result.check_in_intervals = checkins.map(toSlot);
  const briefingStart = legacyBriefingStart(legacy.morning_briefing);
  if (briefingStart !== null) {
    const enabled = legacy.morning_briefing.enabled;
    result.morning_briefing = { ...toSlot(briefingStart), enabled: typeof enabled === "boolean" ? enabled : result.morning_briefing.enabled };
  }
  return result;
}
