/**
 * Zeitgesteuerte Dienste unter PM2 (Issue #568): auf Linux-Rechnern ohne
 * systemd läuft der Nachtcheck (Katalog: pm2Schedule) als PM2-Prozess
 * tybo-<dienst> mit cron_restart statt als cron-Zeile. Genutzt von
 * `tybo dienste` unter Linux (src/setup/services/command.ts).
 *
 * Aufruf wie unter launchd und systemd: über den Routinen-Wrapper
 * src/routine-run.ts mit der Kennung ai.tybo.<dienst>, also mit Verlauf in
 * data/routines/ und Fehlermeldung über die Outbox. `--no-autorestart`:
 * PM2 startet den Prozess nach seinem Ende nicht neu, nur zum nächsten
 * Termin. PM2 startet ihn beim Einrichten einmal sofort; der erste Bericht
 * kommt also gleich.
 *
 * Nie doppelt, auch bei Fehlern (Prüfer-Hinweise zu #568):
 * - PM2-Weg: erst wenn der Prozess läuft, verschwinden die eigenen
 *   cron-Zeilen des Diensts (wie beim Timer). Ist die crontab nicht lesbar,
 *   ändert sich nichts. Lassen sich die cron-Zeilen nicht entfernen, nimmt
 *   die Einrichtung den neuen PM2-Prozess wieder heraus; es gilt dann die
 *   cron-Zeile allein. Lief der Dienst vorher nicht unter PM2, stand aber
 *   in dessen Sicherung, wird er dort gestrichen (fremde Einträge bleiben),
 *   sonst kämen nach dem Hochfahren PM2 und cron.
 * - Timer-Weg (mit systemd): vor dem Timer prüft findPm2Schedule, ob ein
 *   PM2-Prozess desselben Namens läuft oder in der gesicherten Liste
 *   (dump.pm2) steht, die pm2 resurrect beim Hochfahren liest. Gefragt wird
 *   der laufende Daemon über seinen Socket (Pm2Deps.query, echt
 *   queryPm2Daemon), nie über die PM2-CLI, die sonst einen Daemon startete.
 *   Ist Liste oder Sicherung nicht lesbar, entsteht kein Timer. Läuft der
 *   Prozess, entfernt removePm2Schedule ihn nach dem Timer und der Aufrufer
 *   sichert sofort; steht er nur in der Sicherung, streicht ihn
 *   removeSavedPm2Schedule dort. Scheitert eins davon, schaltet der
 *   Aufrufer den Timer wieder ab (src/setup/services/command.ts).
 * - cron-Weg (ohne systemd, pm2-CLI antwortet nicht): dieselbe Prüfung;
 *   steht der Dienst unter PM2 oder ist das unklar, entsteht keine
 *   cron-Zeile (eine fehlende CLI beendet den Daemon nicht).
 *
 * PM2 rechnet cron_restart in der Zeitzone des Systems, nicht in
 * USER_TIMEZONE. Meldungen nennen nie Ausgaben von PM2 (sie können
 * Geheimnisse aus der Umgebung enthalten).
 */

import { dirname, join } from "node:path";
import { setupSchedule } from "../../lib/proactive/setup-schedule";
import { serviceDefinition, type ServiceName } from "../../lib/services/catalog";
import { programArguments } from "../../lib/services/plist";
import { isOwnCronLine, linuxSearchPath, pm2CronExpression, UnitError, type LinuxMachine } from "../../lib/services/systemd";
import { pm2Name } from "../../lib/service-names";
import { readCrontab, whichPath, writeCrontab, type LinuxDeps } from "./linux";
import { pm2ProcessNames, type Pm2Deps } from "./pm2";

export type Pm2ScheduleFailure = "not-a-schedule" | "no-bun" | "unsafe-path" | "crontab-unreadable" | "list-unreadable" | "delete-failed" | "start-failed" | "logs-dir" | "cron-cleanup";

/**
 * Bei einem Fehler: pm2Removed, wenn dabei ein früherer Prozess aus PM2
 * verschwand (der Aufrufer muss die Liste dann auch leer sichern)
 */
export type Pm2ScheduleOutcome =
  | { ok: true; service: ServiceName; cron: string; replaced: boolean; cronLinesRemoved: number }
  | { ok: false; service: ServiceName; failure: Pm2ScheduleFailure; pm2Removed?: boolean };

/** Wenn `which claude` nichts findet: Ordner für den PATH (wie beim Timer) */
const CLAUDE_DIR_DEFAULT = "/usr/local/bin";

export function pm2ScheduleFailureMessage(failure: Pm2ScheduleFailure, service: string): string {
  const name = pm2Name(service);
  switch (failure) {
    case "not-a-schedule":
      return `${service} läuft unter PM2 nicht als Zeitplan.`;
    case "no-bun":
      return "Bun wurde nicht im PATH gefunden.";
    case "unsafe-path":
      return "Ein Pfad (Projektordner, Bun, Claude CLI) enthält Leerzeichen oder Zeichen wie % oder $, oder die Termine passen nicht in einen Zeitplan; so lässt sich der Dienst nicht sicher unter PM2 eintragen.";
    case "crontab-unreadable":
      return "Die crontab ließ sich nicht lesen (crontab -l). Nichts geändert.";
    case "list-unreadable":
      return "Die Liste der PM2-Dienste ließ sich nicht lesen (pm2 jlist). Nichts geändert.";
    case "delete-failed":
      return `Der PM2-Prozess ${name} ließ sich nicht entfernen. Kein neuer gestartet.`;
    case "start-failed":
      return `PM2 konnte ${name} nicht starten. Details mit: pm2 logs ${name}`;
    case "logs-dir":
      return "Der Ordner logs/ im Projektordner ließ sich nicht anlegen. Nichts geändert.";
    case "cron-cleanup":
      return `Die alten cron-Zeilen ließen sich nicht entfernen; ${name} ist darum wieder aus PM2 entfernt, der Dienst läuft weiter über cron. Mit „crontab -e“ die Zeilen mit # ${name} löschen, dann erneut einrichten.`;
  }
}

/** Wenn nach gescheiterter cron-Bereinigung auch das Zurücknehmen scheitert */
export function pm2ScheduleDoubleMessage(service: string): string {
  const name = pm2Name(service);
  return `${name} läuft unter PM2, aber die alten cron-Zeilen ließen sich nicht entfernen und der PM2-Prozess nicht wieder herausnehmen: der Dienst startet doppelt. Mit „crontab -e“ die Zeilen mit # ${name} löschen.`;
}

/**
 * Vollständiger Aufruf von `pm2 start` für einen Zeitplan-Dienst: Bun als
 * Programm, alle PM2-Optionen vor „--“, dahinter der Wrapper mit dem
 * eigentlichen Befehl (programArguments ohne das erste Wort).
 */
export function pm2ScheduleCommand(service: ServiceName, m: LinuxMachine, cron: string, pm2: string[]): string[] {
  const def = serviceDefinition(service);
  const [bun, ...args] = programArguments(def, { ...m, exitTimeoutS: 0 });
  return [
    ...pm2,
    "start",
    bun,
    "--name",
    pm2Name(service),
    "--cron-restart",
    cron,
    "--no-autorestart",
    "--cwd",
    m.projectRoot,
    "--output",
    join(m.projectRoot, def.logs.out),
    "--error",
    join(m.projectRoot, def.logs.err),
    "--",
    ...args,
  ];
}

/**
 * Richtet einen Zeitplan-Dienst unter PM2 ein (entfernen, falls da, dann
 * starten) und räumt danach seine cron-Zeilen ab. Speichert nicht
 * (`pm2 save` macht der Aufrufer einmal am Ende).
 */
export async function setUpPm2Schedule(service: ServiceName, timers: LinuxDeps, pm2: Pm2Deps): Promise<Pm2ScheduleOutcome> {
  const def = serviceDefinition(service);
  const name = pm2Name(service);
  const fail = (failure: Pm2ScheduleFailure, pm2Removed = false): Pm2ScheduleOutcome => {
    timers.log(`  ✗ ${pm2ScheduleFailureMessage(failure, service)}`);
    return { ok: false, service, failure, ...(pm2Removed ? { pm2Removed } : {}) };
  };
  timers.log(`\n  ${service} (Zeitplan unter PM2, kein systemd auf diesem Rechner)`);
  if (def.linux !== "timer" || def.kind !== "routine" || !def.pm2Schedule) return fail("not-a-schedule");

  const bun = await whichPath("bun", timers);
  if (bun === null) return fail("no-bun");
  const claude = await whichPath("claude", timers);
  const machine: LinuxMachine = { bun, claudeDir: claude === null ? CLAUDE_DIR_DEFAULT : dirname(claude), home: timers.home, projectRoot: timers.projectRoot };
  let cron: string;
  let command: string[];
  try {
    cron = pm2CronExpression(def, setupSchedule(timers.projectRoot, timers, "zero"));
    // Pfade prüfen wie beim Timer, auch wenn PM2 sie ohne Shell bekommt
    linuxSearchPath(machine);
    command = pm2ScheduleCommand(service, machine, cron, pm2.pm2);
  } catch (error) {
    if (error instanceof UnitError) return fail("unsafe-path");
    throw error;
  }
  timers.log(`    Zeitplan: ${cron} (Zeitzone des Systems)`);

  const crontab = await readCrontab(timers);
  if (crontab === null) return fail("crontab-unreadable");
  const names = await pm2ProcessNames(pm2);
  if (names === null) return fail("list-unreadable");
  const replaced = names.includes(name);
  if (replaced && !(await pm2.run([...pm2.pm2, "delete", name])).ok) return fail("delete-failed");
  try {
    timers.mkdir(join(timers.projectRoot, "logs"));
  } catch {
    return fail("logs-dir");
  }
  if (!(await pm2.run(command)).ok) return fail("start-failed");
  timers.log(`  ✓ ${replaced ? "Neu eingerichtet" : "Eingerichtet"}: ${name}, erster Lauf jetzt, danach zum Termin`);

  const kept = crontab.filter(line => !isOwnCronLine(line, service));
  const removed = crontab.length - kept.length;
  if (removed > 0 && !(await writeCrontab(kept, timers))) {
    // Nie zwei Zeitpläne: den neuen PM2-Prozess wieder herausnehmen, cron gilt weiter
    if ((await pm2.run([...pm2.pm2, "delete", name])).ok) {
      // Lief er vorher nicht, stand aber in der Sicherung, holte pm2 resurrect ihn neben cron zurück:
      // dort gezielt streichen (ersetzt sichert der Aufrufer die Liste ohnehin mit --force)
      if (!replaced && !dropSavedPm2Schedule(service, pm2, timers)) {
        timers.log(`  ✗ Nach dem nächsten Start von PM2 (pm2 resurrect) liefe der Dienst doppelt (PM2 und cron). Den Eintrag ${name} aus der gesicherten PM2-Liste (dump.pm2) entfernen, dann erneut einrichten.`);
      }
      return fail("cron-cleanup", replaced);
    }
    timers.log(`  ✗ ${pm2ScheduleDoubleMessage(service)}`);
    return { ok: false, service, failure: "cron-cleanup" };
  }
  if (removed > 0) timers.log(`    Alte cron-Zeilen entfernt: ${removed}`);
  return { ok: true, service, cron, replaced, cronLinesRemoved: removed };
}

/** Zugriff auf die gesicherte PM2-Liste: Dateien und Ausgabe aus LinuxDeps */
type DumpFiles = Pick<LinuxDeps, "exists" | "readFile" | "writeFile" | "log">;

/**
 * Die gesicherte Liste, die pm2 resurrect lesen würde: dump.pm2, fehlt sie,
 * dump.pm2.bak (wie bei tybo deinstallieren). entries: [] wenn beide fehlen,
 * null wenn die Datei da, aber nicht lesbar oder kein JSON-Array ist.
 */
function readPm2Dump(dumpPath: string, files: DumpFiles): { path: string; entries: unknown[] | null } {
  const backup = `${dumpPath}.bak`;
  const path = files.exists(dumpPath) ? dumpPath : files.exists(backup) ? backup : null;
  if (path === null) return { path: dumpPath, entries: [] };
  try {
    const parsed: unknown = JSON.parse(files.readFile(path));
    return { path, entries: Array.isArray(parsed) ? parsed : null };
  } catch {
    return { path, entries: null };
  }
}

const entryName = (entry: unknown) => (entry as { name?: unknown } | null)?.name;

/**
 * Vor einem neuen Zeitplan (Timer, ohne systemd auch cron): gibt es denselben
 * Dienst schon unter PM2?
 * - present: der laufende Daemon führt ihn (nach dem Timer mit
 *   removePm2Schedule entfernen und sichern)
 * - saved: er läuft nicht, steht aber in der gesicherten Liste; pm2
 *   resurrect holte ihn beim Hochfahren zurück (nach dem Timer mit
 *   removeSavedPm2Schedule aus der Sicherung streichen)
 * - none: weder noch
 * - failed: Daemon oder Sicherung nicht lesbar; dann keinen Zeitplan
 *   einrichten (nothing nennt, was ausbleibt), sonst liefe der Dienst
 *   womöglich doppelt
 */
export async function findPm2Schedule(service: ServiceName, pm2: Pm2Deps, files: DumpFiles, nothing = "Kein Timer eingerichtet"): Promise<"present" | "saved" | "none" | "failed"> {
  const name = pm2Name(service);
  const unclear = (what: string) => {
    files.log(`  ✗ Ob ${name} schon unter PM2 läuft oder gesichert ist, ließ sich nicht prüfen (${what}). ${nothing}, damit der Dienst nicht doppelt läuft. Prüfen mit: pm2 list; einen Eintrag ${name} mit „pm2 delete ${name}“ und „pm2 save --force“ entfernen, dann erneut einrichten.`);
    return "failed" as const;
  };
  if (pm2.query) {
    const listed = await pm2.query().catch(() => ({ status: "failed" as const }));
    if (listed.status === "failed") return unclear("PM2 antwortet nicht lesbar");
    if (listed.status === "ok" && listed.processes.some(p => entryName(p) === name)) return "present";
  }
  if (!pm2.dumpPath) return "none";
  const { path, entries } = readPm2Dump(pm2.dumpPath, files);
  if (entries === null) return unclear(`die gesicherte Liste ${path} ist nicht lesbar`);
  return entries.some(entry => entryName(entry) === name) ? "saved" : "none";
}

/**
 * Nach dem eingerichteten Timer: einen nur gesicherten PM2-Zeitplan aus der
 * Sicherung streichen, ohne PM2-CLI (sie startete einen Daemon, und pm2 save
 * ersetzte die Sicherung durch die leere laufende Liste). Andere Einträge
 * bleiben unverändert. false: nicht lesbar oder nicht schreibbar, der
 * Aufrufer schaltet den Timer wieder ab.
 */
export function removeSavedPm2Schedule(service: ServiceName, pm2: Pm2Deps, files: DumpFiles): boolean {
  const name = pm2Name(service);
  if (!pm2.dumpPath) return false;
  const { path, entries } = readPm2Dump(pm2.dumpPath, files);
  try {
    if (entries === null) throw new Error("nicht lesbar");
    files.writeFile(path, `${JSON.stringify(entries.filter(entry => entryName(entry) !== name), null, 2)}\n`);
  } catch {
    files.log(`  ✗ ${name} steht in der gesicherten PM2-Liste (${path}) und ließ sich dort nicht streichen.`);
    return false;
  }
  files.log(`    Früheren PM2-Zeitplan aus der gesicherten Liste gestrichen: ${name}`);
  return true;
}

/**
 * Rücknahme ohne systemd: einen Eintrag des Diensts aus der Sicherung
 * streichen, falls er dort steht; andere Einträge bleiben. true: stand nicht
 * darin oder ist gestrichen; false: Sicherung nicht lesbar oder nicht
 * schreibbar (mit Meldung).
 */
function dropSavedPm2Schedule(service: ServiceName, pm2: Pm2Deps, files: DumpFiles): boolean {
  if (!pm2.dumpPath) return true;
  const { path, entries } = readPm2Dump(pm2.dumpPath, files);
  if (entries === null) {
    files.log(`  ✗ Ob ${pm2Name(service)} in der gesicherten PM2-Liste (${path}) steht, ließ sich nicht prüfen.`);
    return false;
  }
  if (!entries.some(entry => entryName(entry) === pm2Name(service))) return true;
  return removeSavedPm2Schedule(service, pm2, files);
}

/**
 * Nach dem eingerichteten Timer: den PM2-Prozess desselben Diensts entfernen.
 * true: entfernt (der Aufrufer sichert die PM2-Liste, auch leer); false:
 * gescheitert, der Aufrufer schaltet den Timer wieder ab.
 */
export async function removePm2Schedule(service: ServiceName, pm2: Pm2Deps, log: (line: string) => void): Promise<boolean> {
  const name = pm2Name(service);
  if (!(await pm2.run([...pm2.pm2, "delete", name])).ok) {
    log(`  ✗ ${name} läuft unter PM2 und ließ sich nicht entfernen.`);
    return false;
  }
  log(`    Früheren PM2-Zeitplan entfernt: ${name}`);
  return true;
}
