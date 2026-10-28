/**
 * Einmalige Übernahme der alten Dateien (Issue #361).
 *
 * Quellen im Projektordner: config/schedule.json (Zeitplan) und
 * checkin-state.json (Zustand des alten Check-ins und Tagesmarke des alten
 * Briefings). Ziele: Block proactive in config/settings.json und
 * data/proactive-state.json.
 *
 * - Jede Quelle wird höchstens einmal übernommen; die Marke steht im neuen
 *   Zustand (imported.schedule, imported.checkinState). Ein zweiter Lauf
 *   ändert nichts, auch wenn sich die alte Datei inzwischen geändert hat.
 * - Vorhandene neue Werte haben Vorrang, Feld für Feld; übernommen wird nur,
 *   was dort noch fehlt.
 * - Fehlt eine Quelle, ist sie kaputt oder lässt sich die Einstellungsdatei
 *   nicht schreiben (etwa weil sie ungültig ist), bleibt die Marke weg und der
 *   nächste Lauf versucht es wieder. Einzelne ungültige Felder werden
 *   übersprungen.
 * - Die alten Dateien bleiben liegen: der alte Check-in, das alte Briefing
 *   und die Einrichtung (setup/configure-*.ts) lesen schedule.json noch.
 *
 * Abbildung:
 * - quiet_hours.start/end (volle Stunden) → quietHours
 * - check_in_hours.start/end → checkin.window
 * - check_in_intervals (hour, minute) → checkin.times, sortiert, ohne Doppelte;
 *   eine leere Liste bleibt leer (keine Termine). Eine fehlende Stunde oder
 *   Minute bedeutet, was die bisherige Einrichtung auf dieser Plattform daraus
 *   gemacht hat (legacyStartMinutes in setup-schedule.ts): unter macOS
 *   (launchd) jeden Wert, {minute:30} ergibt 00:30 bis 23:30, {hour:10}
 *   ergibt 10:00 bis 10:59; unter Linux (cron) und Windows
 *   (Aufgabenplanung) 0, {minute:30} ergibt 00:30, {hour:10} ergibt 10:00.
 *   Fehlt die Liste, die Termine, die die bisherige Einrichtung dann nahm
 *   (LEGACY_MISSING_CHECKINS): macOS 10:30, 12:30, 14:30, 16:30, 18:30,
 *   Linux und Windows 10:30, 14:30, 18:30
 * - minimum_gap_minutes → checkin.minGapMinutes
 * - morning_briefing.enabled → briefing.enabled; hour/minute → Beginn von
 *   briefing.window (legacyBriefingStart, wie in der Einrichtung), Ende drei
 *   Stunden später (wie beim Standard 09:00 bis 12:00)
 * - lastCheckinTime → checkin.lastSentAt, pendingItems → checkin.pendingItems
 *   (nur, wenn der neue Zustand noch keine Liste hat, auch keine leere),
 *   lastBriefingDate → briefing.lastDate
 * Nicht übernommen: timezone (es gilt USER_TIMEZONE wie bisher schon) und
 * lastMessageTime (die letzte Nutzernachricht kommt künftig aus dem Verlauf).
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { getSettingsPath, settingsSchema, updateSettings, type Settings } from "../settings";
import { formatClock } from "./clock";
import { legacyBriefingStart, legacyCheckinMinutes, legacyReadingFor, type LegacyReading } from "./setup-schedule";
import { updateProactiveState, type ProactiveState, type StoredFields } from "./state";

type Proactive = NonNullable<Settings["proactive"]>;

export interface LegacyPaths {
  schedule: string;
  checkinState: string;
  settings: string;
  state: string;
}

export function legacyPaths(root: string = process.env.GO_PROJECT_ROOT || process.cwd()): LegacyPaths {
  return {
    schedule: join(root, "config", "schedule.json"),
    checkinState: join(root, "checkin-state.json"),
    settings: getSettingsPath(),
    state: join(root, "data", "proactive-state.json"),
  };
}

export interface ImportReport {
  schedule: "imported" | "done-before" | "missing" | "broken" | "settings-unwritable";
  checkinState: "imported" | "done-before" | "missing" | "broken";
}

async function readJsonObject(path: string): Promise<{ value?: any; status: "ok" | "missing" | "broken" }> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (error: any) {
    return { status: error?.code === "ENOENT" ? "missing" : "broken" };
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "broken" };
    return { value, status: "ok" };
  } catch {
    return { status: "broken" };
  }
}

const isHour = (v: unknown, max = 23): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;

function hourSpan(raw: any): { from: string; to: string } | undefined {
  // Ende 24 heißt Mitternacht
  if (!isHour(raw?.start) || !isHour(raw?.end, 24)) return undefined;
  const from = formatClock(raw.start * 60);
  const to = formatClock(raw.end * 60);
  return from === to ? undefined : { from, to };
}

/** Was schedule.json beitragen kann, schon im Format von proactive; reading: Lesart der Plattform */
export function scheduleToProactive(raw: any, reading: LegacyReading): Proactive {
  const out: Proactive = {};
  const quiet = hourSpan(raw?.quiet_hours);
  if (quiet) out.quietHours = quiet;

  const checkin: NonNullable<Proactive["checkin"]> = {};
  const window = hourSpan(raw?.check_in_hours);
  if (window) checkin.window = window;
  // Dieselben Startzeiten, die die Einrichtung aus der alten Datei erzeugt; [] bleibt leer, fehlende Liste: bisherige Ersatztermine
  const checkins = legacyCheckinMinutes(raw?.check_in_intervals, reading);
  if (checkins) checkin.times = checkins.map(formatClock);
  const gap = raw?.minimum_gap_minutes;
  if (Number.isInteger(gap) && gap >= 0 && gap <= 1440) checkin.minGapMinutes = gap;
  if (Object.keys(checkin).length > 0) out.checkin = checkin;

  const briefing: NonNullable<Proactive["briefing"]> = {};
  const morning = raw?.morning_briefing;
  if (typeof morning?.enabled === "boolean") briefing.enabled = morning.enabled;
  const start = legacyBriefingStart(morning);
  if (start !== null) briefing.window = { from: formatClock(start), to: formatClock(start + 180) };
  if (Object.keys(briefing).length > 0) out.briefing = briefing;
  return out;
}

/** Ergänzt current um die Felder aus legacy, die dort fehlen; true, wenn sich etwas geändert hat */
export function fillMissing(current: Proactive, legacy: Proactive): boolean {
  let changed = false;
  if (legacy.quietHours && !current.quietHours) {
    current.quietHours = legacy.quietHours;
    changed = true;
  }
  for (const kind of ["briefing", "checkin"] as const) {
    const from = legacy[kind] as Record<string, unknown> | undefined;
    if (!from) continue;
    const into = (current[kind] ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(from)) {
      if (into[key] === undefined) {
        into[key] = value;
        changed = true;
      }
    }
    if (Object.keys(into).length > 0) (current as Record<string, unknown>)[kind] = into;
  }
  return changed;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function fillState(state: ProactiveState, stored: StoredFields, raw: any): void {
  const last = raw?.lastCheckinTime;
  if (!state.checkin.lastSentAt && typeof last === "string" && Number.isFinite(Date.parse(last))) {
    state.checkin.lastSentAt = new Date(last).toISOString();
  }
  // Nur, wenn der neue Zustand noch keine Liste hat; eine bewusst geleerte bleibt leer
  if (!stored.pendingItems && Array.isArray(raw?.pendingItems)) {
    state.checkin.pendingItems = raw.pendingItems.filter((i: unknown) => typeof i === "string" && i !== "");
  }
  const day = raw?.lastBriefingDate;
  if (!state.briefing.lastDate && typeof day === "string" && ISO_DATE.test(day)) state.briefing.lastDate = day;
}

/**
 * Übernimmt, was noch nicht übernommen ist. Der ganze Ablauf läuft unter der
 * Sperre des neuen Zustands: Marke lesen, Einstellungen ergänzen, Marke
 * setzen. Zwei Übernahmen zugleich (zwei Routinen) laufen so nacheinander,
 * und die zweite sieht die Marke der ersten. Sie ergänzt also nichts mehr,
 * auch wenn der Nutzer in der Zwischenzeit ein übernommenes Feld wieder
 * entfernt hat.
 *
 * Die Einstellungen schreibt die Übernahme innerhalb dieser Sperre über
 * updateSettings: Lesen, Ergänzen und Schreiben geschehen dort zusätzlich
 * unter der Sperre der Einstellungsdatei über Prozesse (withSettingsLock),
 * eine gleichzeitige Änderung durch Bot oder Einrichtung geht also nicht
 * verloren. Die Reihenfolge der Sperren ist immer erst Zustand, dann
 * Einstellungen; kein anderer Schreiber der Einstellungen nimmt die Sperre
 * des Zustands. Ist nichts zu ergänzen, bleibt die Datei unberührt (sie wird
 * auch nicht neu angelegt).
 *
 * testHooks laufen nur in Tests: onStart zu Beginn, afterReadMarks mit den
 * frisch gelesenen Marken unter der Sperre, whileWritingSettings zwischen
 * Lesen und Schreiben der Einstellungen.
 *
 * reading ist die Lesart von schedule.json auf dieser Plattform (Standard:
 * die des laufenden Systems), Tests geben sie fest vor.
 */
export async function importLegacyProactive(
  paths: LegacyPaths = legacyPaths(),
  now: Date = new Date(),
  testHooks: {
    onStart?: () => void;
    afterReadMarks?: (marks: ProactiveState["imported"]) => void;
    whileWritingSettings?: () => void;
  } = {},
  reading: LegacyReading = legacyReadingFor(),
): Promise<ImportReport> {
  testHooks.onStart?.();
  const schedule = await readJsonObject(paths.schedule);
  const checkin = await readJsonObject(paths.checkinState);
  const report: ImportReport = { schedule: "missing", checkinState: "missing" };

  await updateProactiveState(paths.state, async (state, stored) => {
    testHooks.afterReadMarks?.({ ...state.imported });
    if (state.imported.schedule) report.schedule = "done-before";
    else if (schedule.status !== "ok") report.schedule = schedule.status;
    else if (!(await fillSettings(paths.settings, scheduleToProactive(schedule.value, reading), testHooks.whileWritingSettings))) {
      report.schedule = "settings-unwritable";
    } else {
      state.imported.schedule = now.toISOString();
      report.schedule = "imported";
    }

    if (state.imported.checkinState) report.checkinState = "done-before";
    else if (checkin.status !== "ok") report.checkinState = checkin.status;
    else {
      fillState(state, stored, checkin.value);
      state.imported.checkinState = now.toISOString();
      report.checkinState = "imported";
    }
  });

  if (report.schedule === "broken") console.log(`[proactive] ${paths.schedule} ist kaputt, nicht übernommen`);
  if (report.checkinState === "broken") console.log(`[proactive] ${paths.checkinState} ist kaputt, nicht übernommen`);
  return report;
}

/** Ergänzt die Einstellungen um legacy; false, wenn die Datei ungültig oder nicht schreibbar ist */
async function fillSettings(path: string, legacy: Proactive, whileWriting?: () => void): Promise<boolean> {
  const needed = await settingsNeedFill(path, legacy);
  if (needed === "invalid") {
    console.log(`[proactive] Zeitplan nicht übernommen, ${path} ist ungültig`);
    return false;
  }
  if (!needed) return true;
  try {
    await updateSettings(current => {
      whileWriting?.();
      const proactive = structuredClone(current.proactive ?? {});
      if (fillMissing(proactive, legacy)) current.proactive = proactive;
      return current;
    }, { path });
    return true;
  } catch (error) {
    console.log(`[proactive] Zeitplan nicht übernommen, ${path} nicht schreibbar: ${error instanceof Error ? error.name : "Fehler"}`);
    return false;
  }
}

/** Fehlt in der Einstellungsdatei etwas, das legacy liefern kann? "invalid": Datei ungültig */
async function settingsNeedFill(path: string, legacy: Proactive): Promise<boolean | "invalid"> {
  let raw: string | undefined;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") return "invalid";
  }
  let current: Settings = {};
  if (raw !== undefined) {
    try {
      const parsed = settingsSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return "invalid";
      current = parsed.data;
    } catch {
      return "invalid";
    }
  }
  return fillMissing(structuredClone(current.proactive ?? {}), legacy);
}
