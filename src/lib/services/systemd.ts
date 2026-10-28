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
 *   dort, wie unter launchd, für jeden Wert und wird hier `*`. Die Einrichtung
 *   liest schedule.json in der Lesart „zero“ wie die bisherige cron-Einrichtung.
 * - OnCalendar und cron rechnen in der Zeitzone des Systems, nicht in
 *   USER_TIMEZONE; genauso wie launchd unter macOS.
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

/** Termin als OnCalendar-Ausdruck, täglich; fehlendes Feld heißt jeder Wert */
export function onCalendar(slot: SetupInterval): string {
  return `*-*-* ${two(slot.hour)}:${two(slot.minute)}:00`;
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

/** Inhalt von tybo-<dienst>.timer; wirft ohne Termine (systemd lehnt einen Timer ohne OnCalendar ab) */
export function timerUnit(def: ServiceDefinition, schedule: SetupSchedule): string {
  requireRoutine(def);
  const slots = timerSlots(def, schedule);
  if (slots.length === 0) throw new UnitError(`${def.name} hat keine Termine`);
  return [
    HEADER,
    "[Unit]",
    `Description=${BRAND.name}: Zeitplan für ${def.summary}`,
    "",
    "[Timer]",
    "# Zeitzone des Systems; verpasste Termine einmal nachholen",
    ...slots.map(slot => `OnCalendar=${onCalendar(slot)}`),
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
  return cronTimes(timerSlots(def, schedule)).map(time => `${time} * * * ${command}`);
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
