/**
 * Routinen pünktlich (Issue #365, Entscheidung E10): Prüfung im Nachtcheck,
 * ob jede aktive zeitgesteuerte launchd-Routine ihren letzten fälligen
 * Termin wahrgenommen hat. Ersetzt den früheren Watchdog, der nur den
 * Check-in kannte.
 *
 * Nur lesend: keine Meldung, kein Schreiben in alerts.json, unabhängig vom
 * Wächter im Bot (watch.ts). Die Fälligkeit ergibt sich allein aus dem
 * Zeitplan im Plist und der Spur des letzten Laufs.
 *
 * Spur des letzten Laufs: das Protokoll des Wrappers (data/routines/, A1)
 * hat Vorrang. Nur ohne Protokoll zählt die Änderungszeit der Log-Dateien
 * aus dem Plist; sie zeigt, dass etwas lief, nicht dass es gelang (Fehler
 * meldet die Prüfung „Routinen“).
 *
 * - Kalender (StartCalendarInterval): fällig ist der letzte Termin, der
 *   mindestens CALENDAR_GRACE_MS zurückliegt; um 03:30 ist das für einen
 *   Tageslauf um 09:00 der gestrige. Begann der letzte Lauf nicht nach
 *   diesem Termin (eine Minute Spielraum), ist er ausgeblieben.
 * - Intervall (StartInterval): ausgeblieben, wenn der letzte Lauf länger als
 *   dreimal das Intervall plus INTERVAL_SLACK_MS zurückliegt.
 * - Beides im selben Plist: launchd startet bei jedem der beiden Auslöser,
 *   jede Frist gilt; ausgeblieben ist die Routine, wenn eine verfehlt ist.
 *
 * Termine gelten in der Zeitzone des Systems, in der launchd sie auswertet,
 * nicht in USER_TIMEZONE. Die Ruhezeit des Nutzers spielt keine Rolle:
 * launchd startet die Routine trotzdem, sie entscheidet selbst, ob sie
 * schweigt, und ihr Lauf steht im Protokoll.
 *
 * Nie ausgeblieben: pausierte und nicht geladene Routinen, Dauerdienste,
 * Routinen ohne Zeitplan (nur RunAtLoad, WatchPaths) und solche, die gerade
 * laufen (PID laut launchctl). Nicht prüfbar, also nie „pünktlich“:
 * unbekannter Zustand, unlesbarer oder nicht auswertbarer Zeitplan (auch nur
 * ein Eintrag einer Liste), letzter Termin älter als das Suchfenster, keine
 * Spur eines Laufs.
 *
 * Hinweise der Übersicht (list.notes: LaunchAgents unlesbar, launchctl
 * gescheitert, ungültige config/routines.json, konfigurierte Dienste nicht
 * gefunden) machen das Ergebnis unvollständig: sie stehen in notes, und die
 * Zeile im Nachtcheck wird nie grün.
 */

import { lastCalendarRun } from "./schedule";
import type { Routine, RoutineList } from "./types";
import { CALENDAR_GRACE_MS, INTERVAL_SLACK_MS } from "./watch";

/** Ein Lauf darf so viel vor dem Termin beginnen (Uhren, Rundung) */
export const EARLY_START_MS = 60_000;
/**
 * Suchfenster für den letzten Termin: vier Jahre und ein Tag, damit auch der
 * 29.2. gefunden wird. Liegt der letzte Termin trotzdem davor, ist die Routine
 * nicht prüfbar, nie pünktlich.
 */
const LOOKBACK_DAYS = 4 * 366 + 1;

export type Evidence = "protocol" | "log";

export type Verdict =
  | { kind: "on-time"; evidence: Evidence }
  | { kind: "running" }
  | { kind: "missed"; due: number; evidence: Evidence }
  | { kind: "unchecked"; reason: string }
  /** Kann nicht ausbleiben: pausiert, nicht geladen, Dauerdienst, ohne Zeitplan */
  | { kind: "exempt"; paused: boolean };

export interface PunctualDeps {
  now: number;
  /** Zeitzone des Systems (launchd) */
  timeZone: string;
  /** Änderungszeit einer Datei in ms; null, wenn sie fehlt oder unlesbar ist */
  mtime(path: string): number | null;
}

/**
 * Letzter Termin eines Kalender-Zeitplans bis einschließlich until. null:
 * kein Termin im Suchfenster; "invalid": Zeitplan oder einer seiner
 * Einträge nicht auswertbar.
 */
export function lastCalendarSlot(calendar: unknown, until: number, timeZone: string): number | null | "invalid" {
  return lastCalendarRun(calendar, until, timeZone, LOOKBACK_DAYS);
}

/** Beginn des letzten Laufs laut Protokoll, sonst jüngste Änderung der Logs */
function lastTrace(r: Routine, deps: PunctualDeps): { at: number; evidence: Evidence } | null {
  const started = r.wrapped && r.lastRun ? Date.parse(r.lastRun.startedAt) : NaN;
  if (Number.isFinite(started)) return { at: started, evidence: "protocol" };
  const times = [r.logPath, r.errorLogPath].filter((p): p is string => !!p).map(p => deps.mtime(p)).filter((t): t is number => t !== null);
  return times.length ? { at: Math.max(...times), evidence: "log" } : null;
}

export function judgeRoutine(r: Routine, deps: PunctualDeps): Verdict {
  if (r.source !== "launchd" || r.kind !== "scheduled") return { kind: "exempt", paused: false };
  if (r.state === "paused" || r.state === "not-loaded") return { kind: "exempt", paused: true };
  if (r.state === "unknown") return { kind: "unchecked", reason: "Zustand unbekannt" };
  const s = r.schedule;
  if (!s || s.type !== "launchd") return { kind: "unchecked", reason: "Zeitplan nicht lesbar" };
  if (s.StartCalendarInterval === undefined && s.StartInterval === undefined) return { kind: "exempt", paused: false };
  if (typeof r.pid === "number") return { kind: "running" };
  const trace = lastTrace(r, deps);
  // Kalender und Intervall zugleich: launchd startet bei jedem der beiden, also gilt jede Frist
  const verdicts: Verdict[] = [];
  if (s.StartCalendarInterval !== undefined) verdicts.push(judgeCalendar(s.StartCalendarInterval, trace, deps));
  if (s.StartInterval !== undefined) verdicts.push(judgeInterval(s.StartInterval, trace, deps));
  const missed = verdicts.filter((v): v is Extract<Verdict, { kind: "missed" }> => v.kind === "missed");
  if (missed.length) return missed.reduce((a, b) => (b.due < a.due ? b : a));
  return verdicts.find(v => v.kind === "unchecked") ?? verdicts[0];
}

function judgeCalendar(calendar: unknown, trace: { at: number; evidence: Evidence } | null, deps: PunctualDeps): Verdict {
  const slot = lastCalendarSlot(calendar, deps.now - CALENDAR_GRACE_MS, deps.timeZone);
  if (slot === "invalid") return { kind: "unchecked", reason: "Zeitplan nicht auswertbar" };
  // Kein Termin im Fenster: der letzte liegt davor, ein alter Lauf beweist nichts
  if (slot === null) return { kind: "unchecked", reason: "letzter Termin außerhalb des Suchfensters" };
  if (!trace) return { kind: "unchecked", reason: "kein Lauf belegt" };
  return trace.at >= slot - EARLY_START_MS ? { kind: "on-time", evidence: trace.evidence } : { kind: "missed", due: slot, evidence: trace.evidence };
}

function judgeInterval(interval: unknown, trace: { at: number; evidence: Evidence } | null, deps: PunctualDeps): Verdict {
  if (typeof interval !== "number" || !Number.isInteger(interval) || interval < 1) return { kind: "unchecked", reason: "Zeitplan nicht auswertbar" };
  if (!trace) return { kind: "unchecked", reason: "kein Lauf belegt" };
  const limit = 3 * interval * 1000 + INTERVAL_SLACK_MS;
  return deps.now - trace.at > limit ? { kind: "missed", due: trace.at + interval * 1000, evidence: trace.evidence } : { kind: "on-time", evidence: trace.evidence };
}

export interface PunctualSummary {
  /** launchd-Übersicht lesbar (macOS) */
  available: boolean;
  /** Geprüfte Routinen: pünktlich, laufend, ausgeblieben oder nicht prüfbar */
  checked: number;
  running: string[];
  missed: { name: string; due: number; evidence: Evidence }[];
  unchecked: { name: string; reason: string }[];
  /** Pausiert oder nicht geladen */
  paused: string[];
  /** Hinweise der Übersicht: Liste unvollständig oder nicht prüfbar */
  notes: string[];
}

/** Alle Routinen der Übersicht beurteilen; PM2 und ohne Übersicht: available false */
export function summarizePunctuality(list: RoutineList, deps: PunctualDeps): PunctualSummary {
  const summary: PunctualSummary = { available: list.available && list.source === "launchd", checked: 0, running: [], missed: [], unchecked: [], paused: [], notes: [...list.notes] };
  if (!summary.available) return summary;
  for (const r of list.routines) {
    const v = judgeRoutine(r, deps);
    if (v.kind === "exempt") {
      if (v.paused) summary.paused.push(r.name);
      continue;
    }
    summary.checked++;
    if (v.kind === "running") summary.running.push(r.name);
    else if (v.kind === "missed") summary.missed.push({ name: r.name, due: v.due, evidence: v.evidence });
    else if (v.kind === "unchecked") summary.unchecked.push({ name: r.name, reason: v.reason });
  }
  return summary;
}
