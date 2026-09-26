/**
 * Umgebung eines Einrichtungslaufs: Pfade, Befehle, Anbieter.
 *
 * Alles, was nach außen greift (Dateien, Befehle, Netz), kommt über den
 * Kontext. Tests setzen temporäre Pfade und Attrappen ein und berühren nie
 * die echte .env, config/profile.md, launchd oder PM2.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { EnvFileIo } from "../lib/env-file";
import { readEnvFile } from "../lib/env-file";
import type { LocalSupabaseDeps } from "./local-supabase";
import { createProviders, type Providers } from "./providers";

export interface CommandResult {
  /** Exit-Code; -1, wenn der Befehl nicht startete oder abgebrochen wurde */
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /** Über RunOptions.signal abgebrochen */
  aborted?: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
  /**
   * Abbruch (Issue #161): beendet den Befehl samt Kindprozessen (eigene
   * Prozessgruppe). Ist er schon ausgelöst, startet nichts.
   */
  signal?: AbortSignal;
}

export type CommandRunner = (cmd: string[], options?: RunOptions) => Promise<CommandResult>;

export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Abbruch zusätzlich zum Zeitlimit */
  signal?: AbortSignal;
}

export type HttpFetch = (url: string, request?: HttpRequest) => Promise<Response>;

export interface SetupContext {
  /** Projektordner (dort liegen launchd/, src/) */
  root: string;
  envPath: string;
  /** Ordner der .env-Sicherungen und Profil-Sicherungen */
  backupDir: string;
  profilePath: string;
  settingsPath: string;
  home: string;
  platform: NodeJS.Platform;
  /** Version der laufenden Bun-Laufzeit */
  bunVersion: string;
  /** ~/Library/LaunchAgents auf macOS */
  launchAgentsDir: string;
  /** Sicherungsliste von PM2 (dump.pm2), wie PM2 sie findet: PM2_HOME oder ~/.pm2 */
  pm2DumpPath: string;
  run: CommandRunner;
  /**
   * Netz für Abläufe (Issue #163, Management-API von Supabase). Die Ports in
   * providers bekommen ihr eigenes fetch; Tests setzen hier eine Attrappe ein.
   */
  fetch: HttpFetch;
  providers: Providers;
  /**
   * Einrichtungsmodus im Browser (Issue #66): nie ein Modell aufrufen. Dann
   * prüft „voraussetzungen“ die Anmeldung der Claude CLI nicht und sagt das.
   */
  noModelCalls?: boolean;
  /** Nur für Tests: Dateioperationen beim Schreiben der .env */
  envIo?: Partial<EnvFileIo>;
  /**
   * Nur für Tests (Issue #164): Postgres, Heimnetz-Prüfung und
   * Arbeitsspeicher beim Weg „Supabase auf diesem Rechner“
   */
  localSupabase?: Partial<LocalSupabaseDeps>;
  now(): Date;
  /**
   * Warten (Issue #161), endet vorzeitig, sobald signal ausgelöst ist (ohne
   * Fehler; der Aufrufer prüft signal.aborted). Tests ersetzen es, damit
   * nichts echt wartet.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /**
   * Nur im Einrichtungsmodus des Browsers: reiht Schreibabschnitte in die
   * Warteschlange des Servers ein (writeEnv nutzt das). Ein Ablauf läuft
   * selbst außerhalb der Warteschlange, nur sein Schreiben geht hindurch.
   */
  writeLock?<T>(fn: () => Promise<T>): Promise<T>;
}

export const PROJECT_ROOT = dirname(dirname(import.meta.dir));

export const DEFAULT_TIMEOUT_MS = 15_000;
/** Schonfrist nach SIGTERM, danach SIGKILL (auch für Befehle, die SIGTERM ignorieren) */
export const KILL_GRACE_MS = 2_000;

/**
 * Sendet sig an die Prozessgruppe (Kindprozesse eingeschlossen), ohne
 * eigene Gruppe oder wenn sie nicht mehr besteht an den Prozess allein.
 */
function signalProc(proc: ReturnType<typeof Bun.spawn>, group: boolean, sig: NodeJS.Signals) {
  if (group) {
    try {
      process.kill(-proc.pid, sig);
      return;
    } catch {
      // Gruppe schon weg: auf den Prozess allein zurückfallen
    }
  }
  try {
    proc.kill(sig);
  } catch {
    // schon beendet
  }
}

/**
 * Startet einen Befehl ohne Shell; nie mit Zugangsdaten auf der Befehlszeile.
 * Mit signal läuft der Befehl in einer eigenen Prozessgruppe, damit der
 * Abbruch auch seine Kindprozesse trifft (etwa Docker-Aufrufe eines CLI).
 */
export const defaultRun: CommandRunner = async (cmd, options = {}) => {
  const signal = options.signal;
  if (signal?.aborted) return { code: -1, stdout: "", stderr: "Abgebrochen", aborted: true };
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(signal ? { detached: true } : {}),
    });
  } catch {
    return { code: -1, stdout: "", stderr: "Befehl nicht gefunden" };
  }
  const group = !!signal;
  let timedOut = false;
  let aborted = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  // Erst SIGTERM, nach der Schonfrist SIGKILL an alles, was noch läuft
  const stop = () => {
    signalProc(proc, group, "SIGTERM");
    killTimer ??= setTimeout(() => signalProc(proc, group, "SIGKILL"), KILL_GRACE_MS);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => {
    aborted = true;
    stop();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    const result: CommandResult = { code: timedOut || aborted ? -1 : code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut };
    if (aborted) result.aborted = true;
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (killTimer) {
      clearTimeout(killTimer);
      // Nach Abbruch oder Zeitlimit bleibt nichts aus der Gruppe übrig, auch
      // kein Kindprozess, der SIGTERM ignoriert und seine Ausgabe umgeleitet hat
      if (group) signalProc(proc, group, "SIGKILL");
    }
  }
};

export const defaultFetch: HttpFetch = (url, request = {}) => {
  const timeout = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return fetch(url, {
    method: request.method ?? "GET",
    headers: request.headers,
    body: request.body,
    signal: request.signal ? AbortSignal.any([timeout, request.signal]) : timeout,
  });
};

/** Wartet ms oder bis signal ausgelöst ist; wirft nie */
export const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/** Kontext mit echten Pfaden und Befehlen; einzelne Teile lassen sich ersetzen */
export function createSetupContext(overrides: Partial<SetupContext> = {}): SetupContext {
  const root = overrides.root ?? PROJECT_ROOT;
  const home = overrides.home ?? homedir();
  const run = overrides.run ?? defaultRun;
  const fetch = overrides.fetch ?? defaultFetch;
  return {
    root,
    envPath: join(root, ".env"),
    backupDir: join(root, "data", "backups"),
    profilePath: join(root, "config", "profile.md"),
    settingsPath: join(root, "config", "settings.json"),
    home,
    platform: process.platform,
    bunVersion: Bun.version,
    launchAgentsDir: join(home, "Library", "LaunchAgents"),
    pm2DumpPath: join(process.env.PM2_HOME || join(home, ".pm2"), "dump.pm2"),
    now: () => new Date(),
    sleep: defaultSleep,
    ...overrides,
    run,
    fetch,
    providers: overrides.providers ?? createProviders({ fetch, run }),
  };
}

/** Aktuelle .env des Kontexts (fehlt sie: leer) */
export function readSetupEnv(ctx: SetupContext): Promise<Record<string, string>> {
  return readEnvFile(ctx.envPath);
}
