/**
 * /routinen als Klartext (Issue #284): erst zeitgesteuerte Routinen, dann
 * Dauerdienste, je Zeile Name, Zeitplan, Status, letzter und nächster Lauf
 * (Issue #285). /routinen <name> zeigt die letzten 20 Läufe einer Routine.
 *
 * Zeiten in der Zeitzone des Systems (wie launchd), relativ zu heute
 * („heute 06:30", „gestern 06:30", „morgen 06:30").
 */

import { sortRoutines } from "./catalog";
import { systemTimeZone, wallTime } from "./schedule";
import type { Routine, RoutineHistory, RoutineList, RoutineRun, RoutineState } from "./types";

export const ROUTINES_TEXT = {
  none: "Keine Routinen gefunden.",
  unavailable: "Routinen: auf diesem System nicht verfügbar (weder launchd noch PM2).",
  scheduled: "Zeitgesteuert:",
  daemons: "Dauerdienste:",
  notWrapped: "kein Verlauf (nicht eingebunden)",
  noRunYet: "noch keiner",
  noRunsYet: "Noch kein Lauf festgehalten.",
  unknownRoutine: (name: string) => `Keine Routine ${name}. /routinen zeigt alle.`,
} as const;

/**
 * Hinweis unter der Liste: wo die Knöpfe sind (Issue #288, vorher „folgen").
 */
export const ROUTINES_PENDING_HINT: string | null = "Pausieren, Fortsetzen und Testen: /routinen <name>.";

export const STATE_TEXT: Record<RoutineState, string> = {
  active: "aktiv",
  paused: "pausiert",
  "not-loaded": "nicht geladen",
  running: "läuft",
  stopped: "läuft nicht",
  unknown: "Status unbekannt",
};

/** Letzter Exit-Code: 0 ok, sonst Fehler; null heißt unbekannt (nicht „noch kein Lauf") */
export function exitText(code: number | null): string {
  if (code === null) return "unbekannt";
  return code === 0 ? "ok" : `Fehler (Exit ${code})`;
}

const SOURCE_TEXT = { launchd: "launchd", pm2: "PM2" } as const;

export interface FormatOptions {
  /** Jetzt in ms; Standard Date.now() */
  now?: number;
  /** Zeitzone der Anzeige; Standard die des Systems */
  timeZone?: string;
}

interface Clock {
  now: number;
  timeZone: string;
}

function clock(o: FormatOptions = {}): Clock {
  return { now: o.now ?? Date.now(), timeZone: o.timeZone ?? systemTimeZone() };
}

const pad = (n: number) => String(n).padStart(2, "0");
const WEEKDAY_SHORT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

/** Kalendertage zwischen zwei Wanduhr-Daten */
function dayDiff(a: { year: number; month: number; day: number }, b: { year: number; month: number; day: number }): number {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

/** „heute 06:30", „gestern 06:30", „morgen 06:30", sonst „Mo 19.10. 06:30" (anderes Jahr mit Jahr) */
export function whenText(ms: number, o: FormatOptions = {}): string {
  const c = clock(o);
  const w = wallTime(ms, c.timeZone);
  const today = wallTime(c.now, c.timeZone);
  const time = `${pad(w.hour)}:${pad(w.minute)}`;
  const diff = dayDiff(today, w);
  if (diff === 0) return `heute ${time}`;
  if (diff === -1) return `gestern ${time}`;
  if (diff === 1) return `morgen ${time}`;
  const date = `${w.day}.${w.month}.${w.year === today.year ? "" : w.year}`;
  return `${WEEKDAY_SHORT[w.weekday]} ${date} ${time}`;
}

/** Dauer: „unter 1 s", „12 s", „2 min 5 s", „1 h 3 min" */
export function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "unter 1 s";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} s`;
  if (total < 3600) {
    const s = total % 60;
    return `${Math.floor(total / 60)} min${s ? ` ${s} s` : ""}`;
  }
  const m = Math.floor((total % 3600) / 60);
  return `${Math.floor(total / 3600)} h${m ? ` ${m} min` : ""}`;
}

/** Ergebnis eines Laufs: „ok", „Fehler (Exit 1)", „abgebrochen (SIGTERM)" */
export function runResultText(run: Pick<RoutineRun, "exitCode" | "signal">): string {
  if (run.signal) return `abgebrochen (${run.signal})`;
  return exitText(run.exitCode);
}

export function runFailed(run: Pick<RoutineRun, "exitCode" | "signal">): boolean {
  return run.exitCode !== 0 || !!run.signal;
}

/** „heute 06:30, 12 s, ok" */
export function runText(run: RoutineRun, o: FormatOptions = {}): string {
  const started = Date.parse(run.startedAt);
  const when = Number.isFinite(started) ? whenText(started, o) : "Zeit unbekannt";
  return `${when}, ${durationText(run.durationMs)}, ${runResultText(run)}`;
}

/**
 * Nächster Lauf in Worten; null, wenn der Zeitplan keinen kennt (nur beim
 * Anmelden, eigener Auslöser) und das nicht am Zustand liegt.
 */
export function nextRunText(r: Routine, o: FormatOptions = {}): string | null {
  if (r.kind !== "scheduled") return null;
  if (r.state === "paused") return "keiner (pausiert)";
  if (r.state === "not-loaded") return "keiner (nicht geladen)";
  if (r.nextRun) {
    const c = clock(o);
    const t = Date.parse(r.nextRun);
    if (Number.isFinite(t)) return t <= c.now ? `fällig seit ${whenText(t, c)}` : whenText(t, c);
  }
  const s = r.schedule;
  const timed = s?.type === "launchd" && (s.StartCalendarInterval !== undefined || s.StartInterval !== undefined);
  return timed || r.state === "unknown" ? "unbekannt" : null;
}

/** Letzter Lauf in Worten; Routinen ohne Wrapper: letzter Exit laut launchd und „kein Verlauf" */
function lastRunParts(r: Routine, o: FormatOptions): string[] {
  if (!r.wrapped) return [`letzter Exit: ${exitText(r.lastExit)}`, ROUTINES_TEXT.notWrapped];
  return [`letzter Lauf: ${r.lastRun ? runText(r.lastRun, o) : ROUTINES_TEXT.noRunYet}`];
}

function line(r: Routine, o: FormatOptions): string {
  if (r.kind === "daemon") return `- ${r.name}: ${STATE_TEXT[r.state]} · letzter Exit: ${exitText(r.lastExit)}`;
  const parts = [r.scheduleText, STATE_TEXT[r.state], ...lastRunParts(r, o)];
  const next = nextRunText(r, o);
  if (next) parts.push(`nächster Lauf: ${next}`);
  return `- ${r.name}: ${parts.join(" · ")}`;
}

export function formatRoutineList(list: RoutineList, options: FormatOptions = {}): string {
  if (!list.available) return ROUTINES_TEXT.unavailable;
  const o = clock(options);
  const blocks: string[] = [];
  const sorted = sortRoutines(list.routines);
  const scheduled = sorted.filter(r => r.kind === "scheduled");
  const daemons = sorted.filter(r => r.kind === "daemon");
  if (!sorted.length) blocks.push(ROUTINES_TEXT.none);
  else blocks.push(`Routinen (${list.source ? SOURCE_TEXT[list.source] : "?"}, ${sorted.length}):`);
  if (scheduled.length) blocks.push([ROUTINES_TEXT.scheduled, ...scheduled.map(r => line(r, o))].join("\n"));
  if (daemons.length) blocks.push([ROUTINES_TEXT.daemons, ...daemons.map(r => line(r, o))].join("\n"));
  if (list.notes.length) blocks.push(list.notes.map(n => `Hinweis: ${n}`).join("\n"));
  if (ROUTINES_PENDING_HINT) blocks.push(ROUTINES_PENDING_HINT);
  return blocks.join("\n\n");
}

/** Text mit „~" statt des Home-Ordners, überall im Text; „/Users/alex" in „/Users/alexander" bleibt */
export function tildePath(text: string, home: string): string {
  const base = home.replace(/\/+$/, "");
  if (!base) return text;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${escaped}(?![\\p{L}\\p{N}_.-])`, "gu"), "~");
}

/**
 * /routinen <name>: Kopf mit Zeitplan und Status, nächster Lauf, dann die
 * letzten Läufe (neueste oben). Endete der neueste Lauf mit Fehler oder
 * Abbruch, folgen seine letzten Zeilen und der Log-Pfad.
 */
export function formatRoutineHistory(history: RoutineHistory | null, query: string, options: FormatOptions = {}): string {
  if (!history) return ROUTINES_TEXT.unknownRoutine(query.trim());
  const o = clock(options);
  const { routine: r, runs, home } = history;
  const head = r.kind === "daemon" ? `${r.name}: Dauerdienst · ${STATE_TEXT[r.state]}` : `${r.name}: ${r.scheduleText} · ${STATE_TEXT[r.state]}`;
  const blocks = [head];
  const next = nextRunText(r, o);
  if (next) blocks[0] += `\nNächster Lauf: ${next}`;
  if (!r.wrapped) {
    blocks[0] += `\nLetzter Exit: ${exitText(r.lastExit)}`;
    blocks.push(`Verlauf: ${ROUTINES_TEXT.notWrapped}.`);
    if (!runs.length) return blocks.join("\n\n");
  }
  if (!runs.length) {
    blocks.push(ROUTINES_TEXT.noRunsYet);
    return blocks.join("\n\n");
  }
  blocks.push([`Letzte Läufe (${runs.length}, neueste oben):`, ...runs.map(run => `- ${runText(run, o)}`)].join("\n"));
  const latest = runs[0];
  if (runFailed(latest)) {
    const detail: string[] = [];
    if (latest.tail.length) detail.push("Letzte Zeilen der Ausgabe:", ...latest.tail.map(l => tildePath(l, home)));
    else detail.push("Keine Ausgabe festgehalten.");
    if (latest.logPath) detail.push(`Log: ${tildePath(latest.logPath, home)}`);
    blocks.push(detail.join("\n"));
  }
  return blocks.join("\n\n");
}
