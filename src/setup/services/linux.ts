/**
 * Routinen unter Linux einrichten (Issue #370): Check-in und Briefing als
 * systemd-Benutzer-Timer, auf Rechnern ohne systemd als cron-Zeilen. Die
 * Einheiten kommen aus src/lib/services/systemd.ts und liegen unter
 * ~/.config/systemd/user (XDG_CONFIG_HOME); alles über `systemctl --user`,
 * nie über sudo.
 *
 * Regeln für einen Dienst:
 * - systemd läuft (es gibt /run/systemd/system), aber der Benutzer-Manager
 *   antwortet nicht (keine Anmeldesitzung, über sudo oder su gestartet):
 *   Abbruch, nichts geändert. Kein stiller Wechsel zu cron, sonst liefe der
 *   Dienst nach der nächsten Einrichtung doppelt.
 * - Vor jeder Änderung wird die crontab gelesen. Ist sie nicht lesbar (und
 *   nicht bloß leer oder crontab nicht installiert), ändert sich nichts.
 * - Gleiche Einheiten, Timer aktiv und aktiviert: nichts tun. Sonst
 *   schreiben, daemon-reload, enable und restart des Timers (restart setzt
 *   geänderte Termine sofort in Kraft; der Dienst selbst startet dabei nicht).
 * - Keine Termine (leere Check-in-Liste): Timer abschalten und beide
 *   Einheiten löschen, wie die leere Liste unter launchd nie startet.
 * - Erst wenn der Timer steht, verschwinden die eigenen cron-Zeilen dieses
 *   Diensts (# tybo-<dienst> und die frühere Markierung # go-<dienst>);
 *   fremde Zeilen bleiben. Scheitert das Schreiben der crontab, ist das ein
 *   Fehler mit Meldung, nie ein stiller Doppellauf.
 * - Ohne systemd: die eigenen Zeilen des Diensts werden durch die neuen
 *   ersetzt, fremde bleiben; bei gleicher crontab wird nichts geschrieben.
 *   Lässt sich logs/ nicht anlegen, bleibt die crontab unverändert (Fehler).
 *
 * Damit Timer auch ohne Anmeldung laufen, braucht der Benutzer Linger; fehlt
 * es, nennt die Einrichtung den Befehl dazu, ändert aber nichts.
 *
 * Die Routinen-Übersicht (/routinen, tybo routinen) liest weiter nur
 * launchd und PM2; systemd-Timer erscheinen dort nicht.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { BRAND } from "../../brand";
import { setupSchedule } from "../../lib/proactive/setup-schedule";
import { serviceDefinition, type ServiceName } from "../../lib/services/catalog";
import { cronLines, isOwnCronLine, serviceUnit, timerSlots, timerUnit, UnitError, type LinuxMachine } from "../../lib/services/systemd";
import { systemdUnit } from "../../lib/service-names";
import { lingerCommand } from "../../../setup/configure-systemd";
import { runWithTimeout, type ServiceRun } from "./run";

export interface LinuxDeps {
  projectRoot: string;
  home: string;
  /** Ordner der Benutzereinheiten, ~/.config/systemd/user */
  unitDir: string;
  /** /run/systemd/system: gibt es nur, wenn der Rechner mit systemd läuft */
  runDir: string;
  user: string;
  run(cmd: string[], options?: { timeoutMs?: number; stdin?: string }): Promise<ServiceRun>;
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  remove(path: string): void;
  mkdir(path: string): void;
  log(line: string): void;
}

export type TimerFailure =
  | "not-a-timer"
  | "no-bun"
  | "unsafe-path"
  | "user-manager"
  | "crontab-unreadable"
  | "write"
  | "reload"
  | "enable"
  | "disable"
  | "crontab-write"
  | "logs-dir"
  | "cron-cleanup";

/**
 * unchanged: alles stand schon so; written: Einheiten bzw. cron-Zeilen neu
 * oder geändert; removed: keine Termine, Timer abgeschaltet und gelöscht;
 * none: keine Termine und nichts da
 */
export type TimerAction = "unchanged" | "written" | "removed" | "none";

export type TimerOutcome =
  | { ok: true; service: ServiceName; via: "systemd" | "cron"; action: TimerAction; cronLinesRemoved: number }
  | { ok: false; service: ServiceName; failure: TimerFailure };

/** Wenn `which claude` nichts findet: Ordner für den PATH */
const CLAUDE_DIR_DEFAULT = "/usr/local/bin";

export function timerFailureMessage(failure: TimerFailure, service: string): string {
  const unit = systemdUnit(service);
  switch (failure) {
    case "not-a-timer":
      return `${service} läuft unter Linux nicht als Zeitplan.`;
    case "no-bun":
      return "Bun wurde nicht im PATH gefunden.";
    case "unsafe-path":
      return "Ein Pfad (Projektordner, Bun, Claude CLI) enthält Leerzeichen oder Zeichen wie % oder $; so lässt er sich nicht sicher als Zeitplan eintragen.";
    case "user-manager":
      return "Der systemd-Benutzerdienst antwortet nicht (systemctl --user). Als normaler Benutzer in einer Anmeldesitzung ausführen, nicht über sudo oder su. Nichts geändert.";
    case "crontab-unreadable":
      return "Die crontab ließ sich nicht lesen (crontab -l). Nichts geändert.";
    case "write":
      return `Die Einheiten ${unit}.service und ${unit}.timer ließen sich nicht schreiben.`;
    case "reload":
      return "systemctl --user daemon-reload ist gescheitert.";
    case "enable":
      return `Der Timer ${unit}.timer ließ sich nicht einschalten. Prüfen mit: systemctl --user status ${unit}.timer`;
    case "disable":
      return `Der Timer ${unit}.timer ließ sich nicht abschalten. Einheiten unverändert.`;
    case "crontab-write":
      return "Die crontab ließ sich nicht schreiben (crontab -). Der bisherige Zeitplan gilt weiter.";
    case "logs-dir":
      return "Der Ordner logs/ im Projektordner ließ sich nicht anlegen; ohne ihn bricht die cron-Zeile ab, bevor die Routine startet. crontab unverändert.";
    case "cron-cleanup":
      return `Der Timer ${unit}.timer läuft, aber die alten cron-Zeilen ließen sich nicht entfernen: der Dienst startet doppelt. Mit „crontab -e“ die Zeilen mit # go-${service} bzw. # ${unit} löschen.`;
  }
}

const COMMAND_TIMEOUT_MS = 30_000;

async function whichPath(program: string, deps: LinuxDeps): Promise<string | null> {
  const found = await deps.run(["which", program]);
  const path = found.stdout.split("\n")[0]?.trim() ?? "";
  return found.ok && path.startsWith("/") ? path : null;
}

/**
 * Zeilen der crontab. Keine crontab („no crontab for …“) oder kein crontab
 * installiert heißt leer; jeder andere Fehler null.
 */
export async function readCrontab(deps: Pick<LinuxDeps, "run">): Promise<string[] | null> {
  const listed = await deps.run(["crontab", "-l"]);
  if (listed.ok) return listed.stdout === "" ? [] : listed.stdout.split("\n");
  if (listed.missing || /no crontab/i.test(listed.stderr)) return [];
  return null;
}

/** Schreibt die crontab neu (auch von tybo deinstallieren genutzt) */
export async function writeCrontab(lines: string[], deps: Pick<LinuxDeps, "run">): Promise<boolean> {
  return (await deps.run(["crontab", "-"], { stdin: lines.length === 0 ? "" : `${lines.join("\n")}\n` })).ok;
}

const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((line, i) => line === b[i]);

type TimerState = { reachable: false } | { reachable: true; active: boolean; enabled: boolean };

async function timerState(unit: string, deps: LinuxDeps): Promise<TimerState> {
  const shown = await deps.run(["systemctl", "--user", "show", `${unit}.timer`, "--property=LoadState,ActiveState,UnitFileState"]);
  if (!shown.ok) return { reachable: false };
  const props = new Map(
    shown.stdout
      .split("\n")
      .map(line => line.split("=", 2) as [string, string?])
      .filter((pair): pair is [string, string] => pair[1] !== undefined),
  );
  if (!props.get("LoadState")) return { reachable: false };
  return { reachable: true, active: props.get("ActiveState") === "active", enabled: props.get("UnitFileState") === "enabled" };
}

/** Hinweis, wenn Linger fehlt: Timer laufen sonst nur, solange der Benutzer angemeldet ist */
async function lingerHint(deps: LinuxDeps): Promise<void> {
  const linger = await deps.run(["loginctl", "show-user", deps.user, "--property=Linger", "--value"]);
  if (linger.ok && linger.stdout.trim() === "yes") return;
  deps.log(`    ! Ohne Linger laufen die Timer nur, solange du angemeldet bist. Einschalten mit: ${lingerCommand(deps.user)}`);
}

/** Richtet einen Zeitplan-Dienst ein; wirft nicht bei Dateifehlern, sondern meldet sie */
export async function setUpTimer(service: ServiceName, deps: LinuxDeps): Promise<TimerOutcome> {
  const def = serviceDefinition(service);
  const unit = systemdUnit(service);
  const fail = (failure: TimerFailure): TimerOutcome => {
    deps.log(`  ✗ ${timerFailureMessage(failure, service)}`);
    return { ok: false, service, failure };
  };
  deps.log(`\n  ${service} (Zeitplan)`);
  if (def.linux !== "timer" || def.kind !== "routine") return fail("not-a-timer");

  const bun = await whichPath("bun", deps);
  if (bun === null) return fail("no-bun");
  const claude = await whichPath("claude", deps);
  const machine: LinuxMachine = { bun, claudeDir: claude === null ? CLAUDE_DIR_DEFAULT : dirname(claude), home: deps.home, projectRoot: deps.projectRoot };
  const schedule = setupSchedule(deps.projectRoot, deps, "zero");
  const slots = timerSlots(def, schedule);
  deps.log(`    Termine: ${slots.length}`);

  const withSystemd = deps.exists(deps.runDir);
  let wantedService = "";
  let wantedTimer = "";
  let wantedCron: string[] = [];
  try {
    if (withSystemd) {
      wantedService = serviceUnit(def, machine);
      if (slots.length > 0) wantedTimer = timerUnit(def, schedule);
    } else {
      wantedCron = cronLines(def, machine, schedule);
    }
  } catch (error) {
    if (error instanceof UnitError) return fail("unsafe-path");
    throw error;
  }

  if (withSystemd) {
    // Erst prüfen, ob der Benutzer-Manager antwortet, dann die crontab: beides vor jeder Änderung
    const state = await timerState(unit, deps);
    if (!state.reachable) return fail("user-manager");
    const crontab = await readCrontab(deps);
    if (crontab === null) return fail("crontab-unreadable");

    const servicePath = join(deps.unitDir, `${unit}.service`);
    const timerPath = join(deps.unitDir, `${unit}.timer`);
    const current = (path: string) => (deps.exists(path) ? deps.readFile(path) : null);
    let action: TimerAction;

    if (slots.length === 0) {
      const present = deps.exists(servicePath) || deps.exists(timerPath);
      // Ein laufender Timer wird abgeschaltet, auch wenn seine Dateien schon fehlen
      const running = state.active || state.enabled;
      if (running) {
        if (!(await deps.run(["systemctl", "--user", "disable", "--now", `${unit}.timer`])).ok) return fail("disable");
      }
      if (present) {
        try {
          deps.remove(timerPath);
          deps.remove(servicePath);
        } catch {
          return fail("write");
        }
      }
      if (present || running) {
        if (!(await deps.run(["systemctl", "--user", "daemon-reload"])).ok) return fail("reload");
        deps.log(`  ✓ Keine Termine: ${unit}.timer abgeschaltet${present ? " und entfernt" : ""}`);
        action = "removed";
      } else {
        deps.log("  ✓ Keine Termine, kein Timer eingerichtet");
        action = "none";
      }
    } else if (current(servicePath) === wantedService && current(timerPath) === wantedTimer && state.active && state.enabled) {
      action = "unchanged";
      deps.log(`  ✓ Unverändert und aktiv: ${unit}.timer`);
    } else {
      try {
        deps.mkdir(join(deps.projectRoot, "logs"));
        deps.mkdir(deps.unitDir);
        deps.writeFile(servicePath, wantedService);
        deps.writeFile(timerPath, wantedTimer);
      } catch {
        return fail("write");
      }
      if (!(await deps.run(["systemctl", "--user", "daemon-reload"])).ok) return fail("reload");
      if (!(await deps.run(["systemctl", "--user", "enable", `${unit}.timer`])).ok) return fail("enable");
      if (!(await deps.run(["systemctl", "--user", "restart", `${unit}.timer`])).ok) return fail("enable");
      action = "written";
      deps.log(`  ✓ Eingerichtet: ${unit}.timer`);
    }

    // Alte cron-Zeilen dieses Diensts erst jetzt entfernen, wo der Timer steht (bzw. keine Termine gelten)
    const kept = crontab.filter(line => !isOwnCronLine(line, service));
    const removed = crontab.length - kept.length;
    if (removed > 0) {
      if (!(await writeCrontab(kept, deps))) return fail("cron-cleanup");
      deps.log(`    Alte cron-Zeilen entfernt: ${removed}`);
    }
    if (action !== "none" && action !== "removed") await lingerHint(deps);
    return { ok: true, service, via: "systemd", action, cronLinesRemoved: removed };
  }

  // Ohne systemd: cron
  const crontab = await readCrontab(deps);
  if (crontab === null) return fail("crontab-unreadable");
  const others = crontab.filter(line => !isOwnCronLine(line, service));
  const next = [...others, ...wantedCron];
  if (sameLines(next, crontab)) {
    deps.log("  ✓ cron-Zeilen unverändert");
    return { ok: true, service, via: "cron", action: "unchanged", cronLinesRemoved: 0 };
  }
  // Die cron-Zeilen leiten nach logs/ um; fehlt der Ordner, startet die Routine nie
  try {
    deps.mkdir(join(deps.projectRoot, "logs"));
  } catch {
    return fail("logs-dir");
  }
  if (!(await writeCrontab(next, deps))) return fail("crontab-write");
  const replaced = crontab.length - others.length;
  // Gleiche crontab ist oben schon behandelt: ohne neue Zeilen wurden hier nur alte entfernt
  const action: TimerAction = wantedCron.length > 0 ? "written" : "removed";
  deps.log(`  ✓ cron: ${wantedCron.length} Zeilen eingetragen, ${replaced} alte ersetzt (kein systemd auf diesem Rechner)`);
  return { ok: true, service, via: "cron", action, cronLinesRemoved: replaced };
}

/** Ordner der Benutzereinheiten nach XDG */
export function userUnitDir(env: Record<string, string | undefined>, home: string): string {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user");
}

/** Echte Zugriffe für den Projektordner root */
export function realLinuxDeps(root: string, home: string = process.env.HOME || homedir(), log: (line: string) => void = line => console.log(line)): LinuxDeps {
  return {
    projectRoot: root,
    home,
    unitDir: userUnitDir(process.env, home),
    runDir: "/run/systemd/system",
    user: process.env.USER || userInfo().username,
    run: (cmd, options) => runWithTimeout(cmd, root, options?.timeoutMs ?? COMMAND_TIMEOUT_MS, options?.stdin),
    exists: path => existsSync(path),
    readFile: path => readFileSync(path, "utf8"),
    writeFile: (path, content) => writeFileSync(path, content, { encoding: "utf8", mode: 0o644 }),
    remove: path => rmSync(path, { force: true }),
    mkdir: path => void mkdirSync(path, { recursive: true }),
    log,
  };
}

/** Kurzer Hinweis für die Ausgabe von tybo dienste */
export const LINUX_SERVICES_HINT = `Zustand: systemctl --user list-timers 'tybo-*' und pm2 status; /routinen bzw. ${BRAND.cli} routinen zeigt unter Linux nur PM2-Dienste`;
