/**
 * Plattform-Details der Motor-Prozesse (Issue #325), gemeinsam für Claude,
 * Codex und OpenCode: Befehlszeile mit Wachhalten (macOS), eigene
 * Prozessgruppe (alles außer Windows) und Beenden des ganzen Prozessbaums.
 *
 * Welches Signal zuerst kommt und wie lange bis SIGKILL gewartet wird,
 * bestimmt der Motor (StopPlan); hier wird es nur ausgeführt. Betriebssystem,
 * Signalversand, taskkill und Timer sind Parameter, damit Tests ohne echte
 * Prozesse auskommen.
 */

export type TreeSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

/** Was zum Beenden eines Prozessbaums gebraucht wird; real oder als Attrappe */
export interface ProcessPlatform {
  os: NodeJS.Platform;
  /**
   * POSIX: Hat die Prozessgruppe mit dieser ID noch Mitglieder? Geprüft
   * direkt vor jedem Gruppensignal (process.kill(-pgid, 0)).
   */
  groupAlive: (pgid: number) => boolean;
  /** Signal an die Prozessgruppe mit dieser ID (POSIX: process.kill(-pgid)) */
  signalGroup: (pgid: number, signal: TreeSignal) => void;
  /** Windows: Baum ab dieser PID hart beenden */
  taskkill: (pid: number) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/** Ein Prozess, wie Bun.spawn ihn liefert, reduziert auf das Nötige */
export interface TreeProc {
  pid: number;
  kill: (...args: any[]) => void;
  /** Wie bei Bun gesetzt, sobald der Prozess beendet ist; null solange er läuft */
  exitCode?: number | null;
  signalCode?: string | null;
}

/** Erstes Signal und Wartezeit bis SIGKILL, je Motor */
export interface StopPlan {
  first: "SIGINT" | "SIGTERM";
  killAfterMs: number;
}

/** Claude: SIGTERM, nach 1,5 Sekunden SIGKILL */
export const CLAUDE_STOP_PLAN: StopPlan = { first: "SIGTERM", killAfterMs: 1_500 };

const SIGNAL_NUMBERS: Record<TreeSignal, number> = { SIGINT: 2, SIGTERM: 15, SIGKILL: 9 };

/** Signal 0 prüft nur: ESRCH heißt leer, EPERM heißt bewohnt (aber nicht von uns signalisierbar) */
function hostGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string } | null)?.code === "EPERM";
  }
}

export const hostPlatform: ProcessPlatform = {
  os: process.platform,
  groupAlive: hostGroupAlive,
  signalGroup: (pgid, signal) => process.kill(-pgid, signal),
  taskkill: (pid) => void Bun.spawnSync(["taskkill", "/pid", String(pid), "/T", "/F"]),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Auf macOS läuft der Befehl unter caffeinate -i, damit der Rechner während der Arbeit nicht einschläft */
export function keepAwakeCommand(command: string[], os: NodeJS.Platform = process.platform): string[] {
  return os === "darwin" ? ["/usr/bin/caffeinate", "-i", ...command] : command;
}

/** Eigene Prozessgruppe (detached), damit sich der ganze Baum beenden lässt; Windows kennt das so nicht */
export function startsOwnGroup(os: NodeJS.Platform = process.platform): boolean {
  return os !== "win32";
}

/** Heimatverzeichnis für die Umgebung der Motoren: HOME, unter Windows USERPROFILE */
export function homeDirectory(env: Record<string, string | undefined> = process.env): string {
  return env.HOME || env.USERPROFILE || "";
}

/** Ist der Prozess selbst schon beendet? Ohne Angaben gilt er als laufend */
function leaderEnded(proc: TreeProc): boolean {
  return (proc.exitCode !== undefined && proc.exitCode !== null) || (proc.signalCode !== undefined && proc.signalCode !== null);
}

/**
 * Ein Signal an den ganzen Baum.
 *
 * POSIX: an die Prozessgruppe, deren ID die PID des Prozesses ist, aber nur,
 * wenn die Gruppe im selben Schritt noch Mitglieder hat. Das gilt auch nach
 * dem Ende des Prozesses selbst: Kinder, die SIGTERM ignorieren, bekommen so
 * noch ihr SIGKILL. Restrisiko (Issue #325, Entscheidung A): die Gruppe wird
 * leer und ihre Nummer wird in der Wartezeit bis SIGKILL neu vergeben. Hat
 * die Gruppe keine Mitglieder oder scheitert das Signal, bekommt nur ein noch
 * laufender Prozess das Signal selbst (etwa ohne eigene Gruppe).
 *
 * Windows kennt keine Signale an Gruppen: jedes Signal wird zu taskkill /T
 * /F, aber nur, solange der Prozess läuft; nach seinem Ende fände taskkill
 * unter seiner PID womöglich einen fremden Baum.
 *
 * PID 0 und 1 bekommen nie etwas: -0 wäre die eigene Gruppe, -1 jeder
 * erreichbare Prozess.
 */
export function signalTree(proc: TreeProc, signal: TreeSignal, platform: ProcessPlatform = hostPlatform): void {
  if (!(proc.pid > 1)) return;
  if (platform.os === "win32") {
    if (leaderEnded(proc)) return;
    try {
      platform.taskkill(proc.pid);
    } catch {}
    return;
  }
  try {
    if (platform.groupAlive(proc.pid)) {
      platform.signalGroup(proc.pid, signal);
      return;
    }
  } catch {}
  if (leaderEnded(proc)) return;
  try {
    proc.kill(SIGNAL_NUMBERS[signal]);
  } catch {}
}

/**
 * Erst plan.first, nach plan.killAfterMs SIGKILL, beides über signalTree
 * (also je mit Prüfung der Gruppe im selben Schritt). Das SIGKILL kommt auch
 * dann, wenn der Prozess selbst inzwischen beendet ist; der Nachlauf hält den
 * Bot-Prozess nicht am Leben. afterKill läuft nach dem SIGKILL (Ende des
 * Nachlaufs).
 */
export function stopTree(proc: TreeProc, plan: StopPlan, platform: ProcessPlatform = hostPlatform, afterKill?: () => void): void {
  if (!(proc.pid > 1)) return;
  signalTree(proc, plan.first, platform);
  const later = platform.setTimeout(() => {
    try {
      signalTree(proc, "SIGKILL", platform);
    } finally {
      afterKill?.();
    }
  }, plan.killAfterMs);
  (later as { unref?: () => void } | undefined)?.unref?.();
}
