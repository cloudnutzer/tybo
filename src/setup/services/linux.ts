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
 *   Scheitert enable oder restart, wird der Timer mit disable --now wieder
 *   abgeschaltet (auch nach dem Hochfahren); cron-Zeilen und ein PM2-Eintrag
 *   bleiben dann unberührt.
 * - Keine Termine (leere Check-in-Liste): Timer abschalten und beide
 *   Einheiten löschen, wie die leere Liste unter launchd nie startet.
 * - Erst wenn der Timer steht, verschwinden die eigenen cron-Zeilen dieses
 *   Diensts (# tybo-<dienst> und die frühere Markierung # go-<dienst>);
 *   fremde Zeilen bleiben. Scheitert das Schreiben der crontab, wird der
 *   Timer wieder abgeschaltet und es gilt die cron-Zeile allein (Fehler mit
 *   Meldung); scheitert auch das, sagt die Meldung „doppelt“ mit Befehl.
 * - Ohne systemd: die eigenen Zeilen des Diensts werden durch die neuen
 *   ersetzt, fremde bleiben; bei gleicher crontab wird nichts geschrieben.
 *   Lässt sich logs/ nicht anlegen, bleibt die crontab unverändert (Fehler).
 *
 * Damit Timer auch ohne Anmeldung laufen, braucht der Benutzer Linger; fehlt
 * es, nennt die Einrichtung den Befehl dazu, ändert aber nichts.
 *
 * Die Routinen-Übersicht (/routinen, tybo routinen, Reiter „Routinen“)
 * zeigt die Timer seit Issue #568 zusammen mit den PM2-Prozessen, nur
 * lesend (src/lib/routines/sources/systemd.ts).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { BRAND } from "../../brand";
import { setupSchedule } from "../../lib/proactive/setup-schedule";
import { serviceDefinition, type ServiceName } from "../../lib/services/catalog";
import { cronLines, isOwnCronLine, serviceUnit, timerSlots, timerTimeZone, timerUnit, UnitError, type LinuxMachine } from "../../lib/services/systemd";
import { parseEnvContent } from "../../lib/env-file";
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
  /** USER_TIMEZONE aus der .env des Projekts (Issue #568); undefined, wenn sie fehlt */
  userTimeZone?(): string | undefined;
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
  | "enable-double"
  | "disable"
  | "crontab-write"
  | "logs-dir"
  | "cron-cleanup"
  | "cron-cleanup-double";

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
      return `Der Timer ${unit}.timer ließ sich nicht einschalten und ist darum wieder abgeschaltet; ein bisheriger Zeitplan (cron, PM2) gilt weiter. Prüfen mit: systemctl --user status ${unit}.timer`;
    case "enable-double":
      return `Der Timer ${unit}.timer ließ sich nicht einschalten und auch nicht wieder abschalten: neben einem bisherigen Zeitplan (cron, PM2) kann der Dienst doppelt starten. Abschalten mit: systemctl --user disable --now ${unit}.timer`;
    case "disable":
      return `Der Timer ${unit}.timer ließ sich nicht abschalten. Einheiten unverändert.`;
    case "crontab-write":
      return "Die crontab ließ sich nicht schreiben (crontab -). Der bisherige Zeitplan gilt weiter.";
    case "logs-dir":
      return "Der Ordner logs/ im Projektordner ließ sich nicht anlegen; ohne ihn bricht die cron-Zeile ab, bevor die Routine startet. crontab unverändert.";
    case "cron-cleanup":
      return `Die alten cron-Zeilen ließen sich nicht entfernen; ${unit}.timer ist darum wieder abgeschaltet, der Dienst läuft weiter über cron. Mit „crontab -e“ die Zeilen mit # go-${service} bzw. # ${unit} löschen, dann erneut einrichten.`;
    case "cron-cleanup-double":
      return `Der Timer ${unit}.timer läuft, aber die alten cron-Zeilen ließen sich nicht entfernen und der Timer nicht wieder abschalten: der Dienst startet doppelt. Mit „crontab -e“ die Zeilen mit # go-${service} bzw. # ${unit} löschen oder den Timer abschalten: systemctl --user disable --now ${unit}.timer`;
  }
}

const COMMAND_TIMEOUT_MS = 30_000;

export async function whichPath(program: string, deps: Pick<LinuxDeps, "run">): Promise<string | null> {
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

/** Zustand eines Timers; reachable false, wenn der Benutzer-Manager nicht antwortet */
export async function timerState(unit: string, deps: Pick<LinuxDeps, "run">): Promise<TimerState> {
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
  // Zeitzone aus USER_TIMEZONE (Issue #568); cron kennt keine eigene, dort gilt die des Systems
  const zone = withSystemd ? timerTimeZone(deps.userTimeZone?.()) : { zone: null, warning: null };
  if (withSystemd && slots.length > 0) {
    deps.log(`    Zeitzone: ${zone.zone ?? "die des Systems"}`);
    if (zone.warning) deps.log(`    ! ${zone.warning}`);
  }
  try {
    if (withSystemd) {
      wantedService = serviceUnit(def, machine);
      if (slots.length > 0) wantedTimer = timerUnit(def, schedule, zone.zone);
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
      const enabled = (await deps.run(["systemctl", "--user", "enable", `${unit}.timer`])).ok;
      if (!enabled || !(await deps.run(["systemctl", "--user", "restart", `${unit}.timer`])).ok) {
        // Nie zwei Zeitpläne, auch nicht nach dem Hochfahren: den Timer dauerhaft zurücknehmen
        // (disable --now), der bisherige Zeitplan (cron-Zeile, PM2) gilt weiter
        if ((await deps.run(["systemctl", "--user", "disable", "--now", `${unit}.timer`])).ok) return fail("enable");
        return fail("enable-double");
      }
      action = "written";
      deps.log(`  ✓ Eingerichtet: ${unit}.timer`);
    }

    // Alte cron-Zeilen dieses Diensts erst jetzt entfernen, wo der Timer steht (bzw. keine Termine gelten)
    const kept = crontab.filter(line => !isOwnCronLine(line, service));
    const removed = crontab.length - kept.length;
    if (removed > 0) {
      if (!(await writeCrontab(kept, deps))) {
        // Ohne Termine läuft kein Timer: es gilt die cron-Zeile allein
        if (action === "removed" || action === "none") return fail("crontab-write");
        // Nie zwei Zeitpläne: den Timer wieder abschalten, cron gilt weiter
        if ((await deps.run(["systemctl", "--user", "disable", "--now", `${unit}.timer`])).ok) return fail("cron-cleanup");
        return fail("cron-cleanup-double");
      }
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

/**
 * Schaltet den Timer eines Diensts wieder ab (disable --now), etwa wenn der
 * frühere Zeitplan unter PM2 nicht weichen will (Issue #568). Die Einheiten
 * bleiben liegen; die nächste Einrichtung schaltet ihn wieder ein. false:
 * auch das scheiterte, beide Zeitpläne laufen (mit Meldung).
 */
export async function disableTimer(service: ServiceName, deps: Pick<LinuxDeps, "run" | "log">, remaining = "der Dienst läuft weiter unter PM2."): Promise<boolean> {
  const unit = systemdUnit(service);
  if ((await deps.run(["systemctl", "--user", "disable", "--now", `${unit}.timer`])).ok) {
    deps.log(`    ${unit}.timer wieder abgeschaltet; ${remaining}`);
    return true;
  }
  deps.log(`  ✗ ${unit}.timer ließ sich nicht wieder abschalten: der Dienst startet doppelt (Timer und PM2). Abschalten mit: systemctl --user disable --now ${unit}.timer`);
  return false;
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
    userTimeZone: () => readUserTimeZone(root),
  };
}

/** USER_TIMEZONE aus <root>/.env; undefined, wenn Datei oder Wert fehlen */
export function readUserTimeZone(root: string): string | undefined {
  try {
    return parseEnvContent(readFileSync(join(root, ".env"), "utf8")).USER_TIMEZONE || undefined;
  } catch {
    return undefined;
  }
}

/** Kurzer Hinweis für die Ausgabe von tybo dienste */
export const LINUX_SERVICES_HINT = `Zustand: systemctl --user list-timers 'tybo-*' und pm2 status; Übersicht: /routinen bzw. ${BRAND.cli} routinen (Timer und PM2-Dienste)`;
