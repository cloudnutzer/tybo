/**
 * Datenvertrag der Routinen-Zentrale (Issue #284, Entscheidung 0025).
 */

import type { RoutineRun } from "./runs";
import type { RoutineKind, RoutineSchedule } from "./schedule";

export type { RoutineRun } from "./runs";

/**
 * Zustand einer Routine. Zeitgesteuert: active, paused, not-loaded.
 * Dauerdienste: running, stopped. unknown, wenn sich der Zustand nicht
 * feststellen lässt (Plist unlesbar, launchctl gescheitert).
 */
export type RoutineState = "active" | "paused" | "not-loaded" | "running" | "stopped" | "unknown";
/** systemd: Timer und Dienste tybo-* unter Linux (Issue #568), nur lesend */
export type RoutineSource = "launchd" | "pm2" | "systemd";

/**
 * Rohangaben aus launchctl (Issue #288): true, false oder null (Befehl
 * gescheitert, unbekannt). Die Aktionen prüfen damit Teilerfolge, die der
 * zusammengefasste Zustand verdeckt (deaktiviert, aber noch geladen).
 */
export interface RoutineFacts {
  /** In `launchctl list` aufgeführt */
  loaded: boolean | null;
  /** Mit PID in `launchctl list` (nur sinnvoll, wenn loaded true) */
  running: boolean | null;
  /** In `print-disabled` als deaktiviert */
  disabled: boolean | null;
}

export interface Routine {
  /** launchd-Label, PM2-Name bzw. systemd-Einheit ohne Endung (tybo-<dienst>) */
  id: string;
  /** Label ohne ai.tybo. (PM2 und systemd: ohne tybo-), fremde Labels ganz */
  name: string;
  kind: RoutineKind;
  /** Rohdaten des Zeitplans; null, wenn der Plist nicht lesbar ist */
  schedule: RoutineSchedule | null;
  scheduleText: string;
  state: RoutineState;
  /** Letzter Exit-Code laut launchd, systemd oder PM2; null heißt unbekannt */
  lastExit: number | null;
  /** StandardOutPath bzw. pm_out_log_path, absolut wie im Plist */
  logPath: string | null;
  /** StandardErrorPath bzw. pm_err_log_path */
  errorLogPath: string | null;
  source: RoutineSource;
  /** true für ai.tybo.* und tybo-*, false für Einträge aus config/routines.json */
  own: boolean;
  /** Plist bzw. systemd-Dienst ruft den Wrapper src/routine-run.ts (Issue #285); PM2 immer false */
  wrapped: boolean;
  /** Letzter Lauf aus data/routines/<id>.json (systemd: unter ai.tybo.<dienst>); null ohne Protokoll */
  lastRun: RoutineRun | null;
  /**
   * Nächster Lauf (ISO) laut Zeitplan, nur für aktive zeitgesteuerte
   * launchd-Routinen; kann bei StartInterval in der Vergangenheit liegen
   * (fällig). Sonst null.
   */
  nextRun: string | null;
  /** Nur launchd (Issue #288): tatsächliche Plist-Datei, gefunden über ihr Label; null ohne lesbaren Plist */
  plistPath?: string | null;
  /** launchd: PID laut `launchctl list`; systemd: MainPID des Diensts; null wenn kein Prozess läuft oder unbekannt */
  pid?: number | null;
  /** Nur launchd: Rohangaben, aus denen state abgeleitet ist */
  facts?: RoutineFacts;
}

/**
 * Ergebnis von listRoutines. available false: weder launchd noch systemd
 * noch PM2. source: launchd, unter Linux systemd, wenn der Rechner mit
 * systemd läuft, sonst PM2; sources nennt alle gelesenen Quellen.
 * notes: Hinweise ohne absolute Pfade (ungültige Konfiguration, gescheiterte
 * Befehle), die die Übersicht unter der Liste zeigt.
 */
export interface RoutineList {
  available: boolean;
  source: RoutineSource | null;
  /** Alle gelesenen Quellen (unter Linux systemd und PM2); fehlt: nur source */
  sources?: RoutineSource[];
  routines: Routine[];
  notes: string[];
}

/** Verlauf einer Routine für /routinen <name> und die API, neueste Läufe zuerst */
export interface RoutineHistory {
  routine: Routine;
  runs: RoutineRun[];
  /** Home-Ordner, gegen den Pfade in der Anzeige gekürzt werden */
  home: string;
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type RunCommand = (cmd: string[]) => Promise<RunResult>;
