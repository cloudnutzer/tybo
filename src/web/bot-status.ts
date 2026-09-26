/**
 * Echte Quellen der Status-API (Issue #37) für src/bot.ts: Neustart-Marker
 * und Supervisor aus src/lib/restart-request.ts, Sessions aus
 * src/lib/session-manager.ts, Zähler aus execution-context.ts und claude.ts.
 * Wie bot-settings.ts bindet nur src/bot.ts diese Datei ein; web:dev und
 * Demo nutzen createDemoStatus aus ./demo, damit dort nie ein echter Marker
 * entsteht. Tests reichen Attrappen für Git, Supervisor und Marker herein.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveAgentModel } from "../agents/base";
import { activeClaudeCallCount } from "../lib/claude";
import { activeExecutionCount } from "../lib/execution-context";
import { detectSupervisor, RESTART_MARKER, requestRestart } from "../lib/restart-request";
import { isSessionModeEnabled, listStoredSessions, SESSION_IDLE_MS } from "../lib/session-manager";
import {
  countResumableSessions,
  keyStatus,
  storageBackend,
  type SessionCounts,
  type StatusPort,
  type StoredSession,
  type Supervisor,
} from "./status";

const execFileAsync = promisify(execFile);

type Env = Record<string, string | undefined>;

/** Prozessstart, nicht Modul-Ladezeit und nicht der erste Statusabruf */
export function processStartedAt(now = Date.now(), uptimeSeconds = process.uptime()): number {
  return Math.round(now - uptimeSeconds * 1000);
}

/** Kurzer Hash aus `git rev-parse --short HEAD`; null ohne Git, außerhalb eines Repos oder bei komischer Ausgabe */
export async function readGitCommit(run: () => Promise<string>): Promise<string | null> {
  try {
    const hash = (await run()).trim();
    return /^[0-9a-f]{7,40}$/.test(hash) ? hash : null;
  } catch {
    return null;
  }
}

/** Version aus package.json; "unbekannt", wenn sie fehlt oder nicht lesbar ist */
export function readPackageVersion(read: () => string): string {
  try {
    const version = JSON.parse(read())?.version;
    return typeof version === "string" && version.trim() ? version.trim() : "unbekannt";
  } catch {
    return "unbekannt";
  }
}

/**
 * Liegt der Neustart-Marker vor? Nur ein fehlender Marker ergibt false.
 * Andere Fehler (keine Rechte, Ordner statt Datei, ...) werfen, die
 * Status-API meldet dann null ("unbekannt"). readRestartRequest() in
 * src/lib/restart-request.ts bleibt für den Bot unverändert: dort heißt
 * jeder Lesefehler "kein Neustart".
 */
export async function restartMarkerPresent(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw e;
  }
}

export interface BotStatusDeps {
  env: Env;
  projectRoot: string;
  gitHead(): Promise<string>;
  readPackageJson(): string;
  startedAt: number;
  detectSupervisor(): Promise<Supervisor | null>;
  listSessions(): Promise<StoredSession[]>;
  sessionMode(): boolean;
  idleMs: number;
  modelFor(agentName: string): string;
  activeExecutions(): number;
  activeClaudeCalls(): number;
  /** Pfad des Neustart-Markers, Standard RESTART_MARKER */
  restartMarker: string;
  requestRestart(note: string): Promise<void>;
  now(): number;
}

export function createBotStatus(env: Env = process.env, overrides: Partial<BotStatusDeps> = {}): StatusPort {
  const root = overrides.projectRoot ?? (env.GO_PROJECT_ROOT || process.cwd());
  const d: BotStatusDeps = {
    env,
    projectRoot: root,
    gitHead: async () =>
      (await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, timeout: 5000 })).stdout,
    readPackageJson: () => readFileSync(join(root, "package.json"), "utf8"),
    startedAt: processStartedAt(),
    detectSupervisor: () => detectSupervisor(),
    listSessions: listStoredSessions,
    sessionMode: isSessionModeEnabled,
    idleMs: SESSION_IDLE_MS,
    modelFor: agentName => resolveAgentModel(agentName),
    activeExecutions: activeExecutionCount,
    activeClaudeCalls: activeClaudeCallCount,
    restartMarker: RESTART_MARKER,
    requestRestart: note => requestRestart(note),
    now: Date.now,
    ...overrides,
  };
  // Version und Hash beim Start festhalten: sie beschreiben den laufenden
  // Code, auch wenn im Checkout inzwischen neuer Code liegt
  const version = readPackageVersion(d.readPackageJson);
  const commit = readGitCommit(d.gitHead);
  // Ein erkannter Supervisor bleibt für die Lebensdauer des Prozesses;
  // "keiner" wird jedes Mal neu geprüft (launchctl kann kurz hängen)
  let knownSupervisor: Supervisor | null = null;

  return {
    version: () => version,
    commit: () => commit,
    startedAt: () => d.startedAt,
    async supervisor() {
      knownSupervisor ??= await d.detectSupervisor();
      return knownSupervisor;
    },
    storage: () => storageBackend(d.env),
    async sessions(): Promise<SessionCounts> {
      const list = await d.listSessions();
      const sessionMode = d.sessionMode();
      return {
        mode: sessionMode ? "resume" : "off",
        stored: list.length,
        resumable: countResumableSessions(list, {
          sessionMode,
          idleMs: d.idleMs,
          modelFor: d.modelFor,
          now: d.now(),
        }),
      };
    },
    activeExecutions: () => d.activeExecutions(),
    activeClaudeCalls: () => d.activeClaudeCalls(),
    restartRequested: () => restartMarkerPresent(d.restartMarker),
    requestRestart: note => d.requestRestart(note),
    keys: () => keyStatus(d.env),
    now: () => d.now(),
  };
}
