/**
 * Zeitgesteuerte Dienste unter Linux (Issue #370): erzeugt aus einem
 * Katalogeintrag der Art routine die systemd-Benutzereinheiten
 * `tybo-<dienst>.service` und `tybo-<dienst>.timer`, ohne systemd die
 * cron-Zeilen als Ausweichlösung. Rein, ohne Zugriffe nach außen; die
 * Einrichtung steht in src/setup/services/linux.ts.
 *
 * Aufruf wie unter launchd (programArguments aus plist.ts): über den
 * Routinen-Wrapper src/routine-run.ts mit der Kennung ai.tybo.<dienst>, die
 * der Wrapper zulässt; so landet der Lauf auch unter Linux im Verlauf
 * data/routines/ und meldet Fehlschläge.
 *
 * Zeiten:
 * - Termine kommen aus dem Katalog (def.calendar). Ein fehlendes Feld steht
 *   dort, wie unter launchd, für jeden Wert und wird hier `*`. Ein Wochentag
 *   (weekday, 0 = Sonntag) wird zu `Sun …` in OnCalendar bzw. zum fünften
 *   cron-Feld. Die Einrichtung
 *   liest schedule.json in der Lesart „zero“ wie die bisherige cron-Einrichtung.
 * - Zeitzone (Issue #568): OnCalendar trägt die Zeitzone aus USER_TIMEZONE
 *   (`OnCalendar=*-*-* 03:30:00 Europe/Berlin`), denn Check-in, Briefing
 *   und Nachtcheck meinen die Uhrzeit des Nutzers, nicht die des Servers
 *   (oft UTC). Fehlt USER_TIMEZONE oder ist der Wert keine gültige
 *   Zeitzone, gilt die des Systems; der Timer sagt das in einem Kommentar,
 *   die Einrichtung warnt bei einem ungültigen Wert (timerTimeZone). cron
 *   und PM2 rechnen immer in der Zeitzone des Systems.
 * - Persistent=true: ein Termin, den der Rechner verpasst hat (aus oder im
 *   Ruhezustand), läuft einmal nach dem nächsten Start nach, wie launchd
 *   StartCalendarInterval nach dem Aufwachen. cron holt nichts nach.
 *
 * Pfade gehen nur durch, wenn systemd und die Shell von cron sie nicht als
 * Syntax lesen (keine Leerzeichen, Anführungszeichen, %, $, \); andere lehnt
 * der Generator mit UnitError ab, statt sie halb richtig zu maskieren.
 */

import { dirname } from "node:path";
import { BRAND } from "../../brand";
import { systemdUnit } from "../service-names";
import type { SetupInterval, SetupSchedule } from "../proactive/setup-schedule";
import type { ServiceDefinition } from "./catalog";
import { programArguments } from "./plist";

export class UnitError extends Error {}

/** Pfade dieses Rechners, die in Einheit und cron-Zeile eingehen */
export interface LinuxMachine {
  bun: string;
  /** Ordner der Claude CLI */
  claudeDir: string;
  home: string;
  projectRoot: string;
}

/** Ein Wort in ExecStart oder einer cron-Zeile */
const SAFE_WORD = /^[\p{L}\p{N}_.\/+@,=~:-]+$/u;
/** Ein absoluter Ordner im PATH (ohne Doppelpunkt, der trennt) */
const SAFE_DIR = /^\/[\p{L}\p{N}_.\/+@,=~-]*$/u;

function checkWord(word: string): string {
  if (!SAFE_WORD.test(word)) throw new UnitError("Pfad mit Zeichen, die systemd oder cron als Syntax lesen");
  return word;
}

function checkDir(dir: string): string {
  if (!SAFE_DIR.test(dir)) throw new UnitError("Ordner mit Zeichen, die systemd oder cron als Syntax lesen");
  return dir;
}

/** Markierung am Ende einer cron-Zeile von tybo */
export function cronMarker(service: string): string {
  return `# ${systemdUnit(service)}`;
}

/** Markierung der früheren Einrichtung (setup/configure-services.ts), nur noch zum Aufräumen */
export function legacyCronMarker(service: string): string {
  return `# go-${service}`;
}

/** Gehört die crontab-Zeile zu diesem Dienst (eigene oder frühere Markierung am Zeilenende)? */
export function isOwnCronLine(line: string, service: string): boolean {
  const end = line.trimEnd();
  return [cronMarker(service), legacyCronMarker(service)].some(marker => end === marker || end.endsWith(` ${marker}`) || end.endsWith(`\t${marker}`));
}

/** Suchpfad für Routinen: bun, Claude CLI, Bun und lokale Programme des Nutzers, System */
export function linuxSearchPath(m: LinuxMachine): string {
  const dirs = [dirname(m.bun), m.claudeDir, `${m.home}/.local/bin`, `${m.home}/.bun/bin`, "/usr/local/bin", "/usr/bin", "/bin"];
  return [...new Set(dirs)].map(checkDir).join(":");
}

/** Termine eines Diensts als Liste; leer, wenn er keine hat */
export function timerSlots(def: ServiceDefinition, schedule: SetupSchedule): SetupInterval[] {
  if (!def.calendar) return [];
  const plan = def.calendar(schedule);
  return plan.form === "single" ? [plan.slot] : plan.slots;
}

const two = (n: number | undefined) => (n === undefined ? "*" : String(n).padStart(2, "0"));

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Termin als OnCalendar-Ausdruck, täglich oder an einem Wochentag; fehlendes Feld heißt jeder Wert; mit Zeitzone dahinter */
export function onCalendar(slot: SetupInterval, timeZone: string | null = null): string {
  const day = slot.weekday === undefined ? "" : `${WEEKDAYS[slot.weekday]} `;
  return `${day}*-*-* ${two(slot.hour)}:${two(slot.minute)}:00${timeZone ? ` ${timeZone}` : ""}`;
}

/** Name einer Zeitzone, wie systemd ihn als Datei unter zoneinfo sucht: keine Leerzeichen, kein Doppelpunkt, kein .. */
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/**
 * Zeitzone für OnCalendar aus USER_TIMEZONE. zone null heißt Zeitzone des
 * Systems; warning steht nur bei einem gesetzten, aber ungültigen Wert.
 * Gültig ist, was Intl kennt und als Name unter zoneinfo stehen kann
 * (keine festen Abstände wie „+01:00“). Weicht nur die Schreibweise ab
 * („europe/berlin“), gilt die von Intl, denn systemd sucht die Datei mit
 * genau diesem Namen.
 */
export function timerTimeZone(raw: string | undefined): { zone: string | null; warning: string | null } {
  const value = raw?.trim() ?? "";
  if (!value) return { zone: null, warning: null };
  const invalid = { zone: null, warning: `USER_TIMEZONE „${value.slice(0, 40)}“ ist keine gültige Zeitzone; die Timer laufen in der Zeitzone des Systems. Beispiel: USER_TIMEZONE=Europe/Berlin` };
  if (!ZONE_NAME.test(value)) return invalid;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return invalid;
  }
  return { zone: resolved.toLowerCase() === value.toLowerCase() ? resolved : value, warning: null };
}

function requireRoutine(def: ServiceDefinition): void {
  if (def.kind !== "routine") throw new UnitError(`${def.name} ist keine Routine`);
}

/** Befehl des Diensts als geprüfte Wörter */
function commandWords(def: ServiceDefinition, m: LinuxMachine): string[] {
  checkDir(m.projectRoot);
  return programArguments(def, { ...m, exitTimeoutS: 0 }).map(checkWord);
}

const HEADER = `# Erzeugt von ${BRAND.name} aus src/lib/services/catalog.ts; die nächste Einrichtung überschreibt Änderungen`;

/** Inhalt von tybo-<dienst>.service */
export function serviceUnit(def: ServiceDefinition, m: LinuxMachine): string {
  requireRoutine(def);
  const env = [`PATH=${linuxSearchPath(m)}`, ...(def.projectRootEnv ? [`GO_PROJECT_ROOT=${m.projectRoot}`] : [])];
  return [
    HEADER,
    "[Unit]",
    `Description=${BRAND.name}: ${def.summary}`,
    "",
    "[Service]",
    "Type=oneshot",
    `WorkingDirectory=${m.projectRoot}`,
    `ExecStart=${commandWords(def, m).join(" ")}`,
    ...env.map(e => `Environment=${e}`),
    `StandardOutput=append:${checkWord(`${m.projectRoot}/${def.logs.out}`)}`,
    `StandardError=append:${checkWord(`${m.projectRoot}/${def.logs.err}`)}`,
    "",
  ].join("\n");
}

/**
 * Inhalt von tybo-<dienst>.timer; wirft ohne Termine (systemd lehnt einen
 * Timer ohne OnCalendar ab). timeZone: geprüfter Wert aus timerTimeZone,
 * null für die Zeitzone des Systems.
 */
export function timerUnit(def: ServiceDefinition, schedule: SetupSchedule, timeZone: string | null = null): string {
  requireRoutine(def);
  const slots = timerSlots(def, schedule);
  if (slots.length === 0) throw new UnitError(`${def.name} hat keine Termine`);
  if (timeZone !== null && !ZONE_NAME.test(timeZone)) throw new UnitError("Zeitzone mit Zeichen, die systemd als Syntax liest");
  return [
    HEADER,
    "[Unit]",
    `Description=${BRAND.name}: Zeitplan für ${def.summary}`,
    "",
    "[Timer]",
    timeZone ? `# Zeitzone aus USER_TIMEZONE; verpasste Termine einmal nachholen` : "# Zeitzone des Systems (USER_TIMEZONE fehlt oder ist ungültig); verpasste Termine einmal nachholen",
    ...slots.map(slot => `OnCalendar=${onCalendar(slot, timeZone)}`),
    "Persistent=true",
    `Unit=${systemdUnit(def.name)}.service`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

/** cron-Zeilen eines Diensts (eine je Termin), jede mit der Markierung # tybo-<dienst> */
export function cronLines(def: ServiceDefinition, m: LinuxMachine, schedule: SetupSchedule): string[] {
  requireRoutine(def);
  const root = m.projectRoot;
  const env = [`PATH=${linuxSearchPath(m)}`, ...(def.projectRootEnv ? [`GO_PROJECT_ROOT=${root}`] : [])];
  const out = checkWord(`${root}/${def.logs.out}`);
  const err = checkWord(`${root}/${def.logs.err}`);
  const command = `cd ${checkWord(root)} && ${env.join(" ")} ${commandWords(def, m).join(" ")} >> ${out} 2>> ${err} ${cronMarker(def.name)}`;
  // Je Wochentag eine eigene Gruppe von Zeilen (cron-Feld 5, 0 = Sonntag); ohne Wochentag jeden Tag
  const groups = new Map<string, SetupInterval[]>();
  for (const slot of timerSlots(def, schedule)) {
    const day = slot.weekday === undefined ? "*" : String(slot.weekday);
    groups.set(day, [...(groups.get(day) ?? []), slot]);
  }
  return [...groups].flatMap(([day, slots]) => cronTimes(slots).map(time => `${time} * * ${day} ${command}`));
}

/**
 * Zeitplan für PM2 (cron_restart, Issue #568): genau ein cron-Ausdruck mit
 * fünf Feldern. PM2 kennt je Prozess nur einen; ergäben die Termine mehrere
 * Zeilen (verschiedene Uhrzeiten oder Wochentage), wirft die Funktion.
 * PM2 rechnet in der Zeitzone des Systems.
 */
export function pm2CronExpression(def: ServiceDefinition, schedule: SetupSchedule): string {
  requireRoutine(def);
  const slots = timerSlots(def, schedule);
  const days = [...new Set(slots.map(slot => (slot.weekday === undefined ? "*" : String(slot.weekday))))];
  const times = cronTimes(slots);
  if (times.length !== 1 || days.length !== 1) throw new UnitError(`${def.name} braucht unter PM2 genau einen Zeitplan`);
  return `${times[0]} * * ${days[0]}`;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/** Werte eines cron-Felds: alle als *, sonst Einzelwerte und Bereiche a-b */
function cronField(values: number[], size: number): string {
  if (values.length === size) return "*";
  const parts: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const start = values[i];
    while (i + 1 < values.length && values[i + 1] === values[i] + 1) i++;
    parts.push(values[i] === start ? String(start) : `${start}-${values[i]}`);
  }
  return parts.join(",");
}

/**
 * Termine als cron-Felder „Minute Stunde“, jeder Zeitpunkt höchstens einmal.
 * Die Termine kommen wie für launchd zusammengefasst aus dem Katalog
 * ({minute: 30} für jede Stunde, {hour: 10} für jede Minute) und dürfen sich
 * überschneiden. launchd und systemd starten dann einmal, cron je Zeile: ein
 * Termin bekommt hier nur die Zeitpunkte, die kein früherer schon hat.
 */
export function cronTimes(slots: SetupInterval[]): string[] {
  const taken = new Set<number>();
  const times: string[] = [];
  for (const slot of slots) {
    const hours = slot.hour === undefined ? range(24) : [slot.hour];
    const minutes = slot.minute === undefined ? range(60) : [slot.minute];
    // Minuten mit denselben freien Stunden teilen sich eine Zeile
    const groups = new Map<string, { minutes: number[]; hours: number[] }>();
    for (const minute of minutes) {
      const free = hours.filter(hour => !taken.has(hour * 60 + minute));
      if (free.length === 0) continue;
      for (const hour of free) taken.add(hour * 60 + minute);
      const key = free.join(",");
      const group = groups.get(key) ?? { minutes: [], hours: free };
      group.minutes.push(minute);
      groups.set(key, group);
    }
    const ordered = [...groups.values()].sort((a, b) => a.hours[0] * 60 + a.minutes[0] - (b.hours[0] * 60 + b.minutes[0]));
    times.push(...ordered.map(g => `${cronField(g.minutes, 60)} ${cronField(g.hours, 24)}`));
  }
  return times;
}
