/**
 * Umgebung eines Einrichtungslaufs: Pfade, Befehle, Anbieter.
 *
 * Alles, was nach außen greift (Dateien, Befehle, Netz), kommt über den
 * Kontext. Tests setzen temporäre Pfade und Attrappen ein und berühren nie
 * die echte .env, config/profile.md, launchd oder PM2.
 */

import { spawn } from "node:child_process";
import { closeSync, openSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
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
  /**
   * Warum der Befehl nicht startete (Fehlercode von spawn, etwa „EACCES“).
   * „ENOENT“ nur, wenn die Datei in keinem PATH-Ordner liegt; eine vorhandene,
   * aber nicht ausführbare Datei meldet „EACCES“.
   */
  spawnError?: string;
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
  /** Text, oder FormData für multipart (Issue #166: Edge Functions ausliefern) */
  body?: string | FormData;
  timeoutMs?: number;
  /** Abbruch zusätzlich zum Zeitlimit */
  signal?: AbortSignal;
  /** manual: Weiterleitungen nicht folgen (Issue #231: prüfen, ob Cloudflare Access davor liegt) */
  redirect?: "manual" | "follow";
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
  /**
   * systemd (Issue #207, nur Linux): Ordner der Benutzerdienste
   * (~/.config/systemd/user) und der Ordner, den es nur gibt, wenn der Rechner
   * mit systemd läuft (/run/systemd/system). Tests setzen Temp-Ordner ein.
   */
  systemdUserDir: string;
  systemdRunDir: string;
  /** Anmeldename (für loginctl enable-linger) */
  user: string;
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
  /**
   * Einrichtung läuft im Browser (Issue #231): der Assistent belegt dann den
   * Port der WebUI, ein Test über HTTPS träfe ihn statt tybo.
   */
  browserSetup?: boolean;
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
  /**
   * Startet einen Befehl losgelöst im Hintergrund, der das Ende der
   * Einrichtung überlebt (Issue #168: tybo suche neu-berechnen); Ausgabe an
   * logFile angehängt. false: Start gescheitert. Fehlt es (Tests), startet
   * nichts und der Assistent nennt den Befehl zum Selbststarten.
   */
  startBackground?(cmd: string[], options: { cwd: string; logFile: string }): Promise<boolean>;
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
 * Fehlercode eines gescheiterten Starts. Bun meldet „ENOENT“ auch, wenn die
 * Datei im PATH liegt, aber nicht ausführbar ist; dann „EACCES“, denn der
 * Befehl ist vorhanden.
 */
function spawnErrorCode(e: unknown, bin: string, path: string): string {
  const code = (e as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
  if (code !== "ENOENT" || bin.includes("/")) return code;
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    try {
      if (!statSync(join(dir, bin)).isDirectory()) return "EACCES";
    } catch {
      // hier nicht vorhanden
    }
  }
  return "ENOENT";
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
  } catch (e) {
    const spawnError = spawnErrorCode(e, cmd[0] ?? "", options.env?.PATH ?? process.env.PATH ?? "");
    return { code: -1, stdout: "", stderr: spawnError === "ENOENT" ? "Befehl nicht gefunden" : "Befehl ließ sich nicht starten", spawnError };
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
    redirect: request.redirect ?? "follow",
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

/** Losgelöster Hintergrundprozess mit Ausgabe in eine Logdatei (Rechte 0600) */
export const defaultStartBackground: NonNullable<SetupContext["startBackground"]> = async (cmd, options) => {
  try {
    await mkdir(dirname(options.logFile), { recursive: true });
    const fd = openSync(options.logFile, "a", 0o600);
    try {
      const child = spawn(cmd[0], cmd.slice(1), { cwd: options.cwd, detached: true, stdio: ["ignore", fd, fd], env: process.env });
      child.unref();
      return typeof child.pid === "number";
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
};

function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? "";
  }
}

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
    systemdUserDir: join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user"),
    systemdRunDir: "/run/systemd/system",
    user: currentUser(),
    now: () => new Date(),
    sleep: defaultSleep,
    startBackground: defaultStartBackground,
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
