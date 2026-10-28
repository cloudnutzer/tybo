/**
 * Erzeugt die launchd-Plist eines Diensts aus dem Katalog (Issue #368).
 *
 * Zwei Schichten: writePlist schreibt einen Wert (Text, Zahl, Wahrheitswert,
 * Liste, Wörterbuch) als XML-Plist und maskiert dabei jeden Text, damit ein
 * Pfad mit `&`, `<` oder `>` gültiges XML bleibt und launchd genau den
 * ursprünglichen Pfad liest. servicePlist baut den Wert aus einem
 * Katalogeintrag, den Pfaden dieses Rechners und dem Zeitplan.
 *
 * Die Ausgabe hängt nur von den Eingaben ab (feste Reihenfolge der
 * Schlüssel, feste Einrückung): src/setup/services/launchd.ts vergleicht die
 * neue Plist Zeichen für Zeichen mit der vorhandenen und lädt einen
 * unveränderten, geladenen Dienst nicht neu.
 */

import { dirname } from "node:path";
import { launchdLabel } from "../service-names";
import type { SetupInterval, SetupSchedule } from "../proactive/setup-schedule";
import type { CalendarPlan, PathProfile, ServiceDefinition } from "./catalog";

export type PlistValue = string | number | boolean | PlistValue[] | PlistDict;
export interface PlistDict {
  [key: string]: PlistValue;
}

/** Zeichen, die XML 1.0 nicht erlaubt; ein Pfad damit lässt sich nicht als Plist schreiben */
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

export class PlistError extends Error {}

/** Maskiert Text für ein XML-Element */
export function escapeXml(text: string): string {
  if (FORBIDDEN.test(text)) throw new PlistError("Steuerzeichen im Text, als XML nicht darstellbar");
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function render(value: PlistValue, depth: number, out: string[]): void {
  const pad = "\t".repeat(depth);
  if (typeof value === "string") {
    out.push(`${pad}<string>${escapeXml(value)}</string>`);
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new PlistError(`keine ganze Zahl: ${value}`);
    out.push(`${pad}<integer>${value}</integer>`);
  } else if (typeof value === "boolean") {
    out.push(`${pad}<${value}/>`);
  } else if (Array.isArray(value)) {
    if (value.length === 0) return void out.push(`${pad}<array/>`);
    out.push(`${pad}<array>`);
    for (const item of value) render(item, depth + 1, out);
    out.push(`${pad}</array>`);
  } else {
    const keys = Object.keys(value);
    if (keys.length === 0) return void out.push(`${pad}<dict/>`);
    out.push(`${pad}<dict>`);
    for (const key of keys) {
      out.push(`${pad}\t<key>${escapeXml(key)}</key>`);
      render(value[key], depth + 1, out);
    }
    out.push(`${pad}</dict>`);
  }
}

const HEAD = [
  `<?xml version="1.0" encoding="UTF-8"?>`,
  `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
  `<!-- Erzeugt von tybo aus src/lib/services/catalog.ts; die nächste Einrichtung überschreibt Änderungen -->`,
];

/** Ganze Plist-Datei mit dem Wörterbuch als Wurzel, endet mit Zeilenumbruch */
export function writePlist(root: PlistDict): string {
  const out = [...HEAD, `<plist version="1.0">`];
  render(root, 0, out);
  out.push(`</plist>`, "");
  return out.join("\n");
}

/** Pfade dieses Rechners, die in die Plist eingehen */
export interface MachinePaths {
  /** Pfad zu bun laut `which bun` */
  bun: string;
  /** Ordner der Claude CLI */
  claudeDir: string;
  home: string;
  projectRoot: string;
  /** Wert für ExitTimeOut (LAUNCHD_EXIT_TIMEOUT_S) */
  exitTimeoutS: number;
}

function searchPath(profile: PathProfile, m: MachinePaths): string {
  const bunDir = dirname(m.bun);
  const system = ["/usr/bin", "/bin"];
  const dirs: Record<PathProfile, string[]> = {
    short: [bunDir, m.claudeDir, "/opt/homebrew/bin", "/usr/local/bin", ...system],
    long: [bunDir, m.claudeDir, `${m.home}/.local/bin`, `${m.home}/.bun/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/usr/sbin", "/bin", "/sbin"],
    docker: [`${m.home}/.local/bin`, `${m.home}/.bun/bin`, bunDir, "/opt/homebrew/bin", "/usr/local/bin", `${m.home}/.orbstack/bin`, ...system, "/usr/sbin", "/sbin"],
  };
  return dirs[profile].join(":");
}

/** Ein Termin als Wörterbuch; ein fehlendes Feld heißt für launchd jeder Wert */
function slotDict(slot: SetupInterval): PlistDict {
  const dict: PlistDict = {};
  if (slot.hour !== undefined) dict.Hour = slot.hour;
  if (slot.minute !== undefined) dict.Minute = slot.minute;
  return dict;
}

function calendarValue(plan: CalendarPlan): PlistValue {
  return plan.form === "single" ? slotDict(plan.slot) : plan.slots.map(slotDict);
}

/**
 * Aufruf des Diensts: Routinen über den Wrapper aus A1 mit genau dem Label
 * als --id, `--` trennt den Wrapper vom Befehl; die übrigen direkt.
 */
export function programArguments(def: ServiceDefinition, m: MachinePaths): string[] {
  // Ersetzung als Funktion: ein Text würde $& oder $$ im Projektpfad als Muster lesen
  const own = def.args.map(arg => arg.replaceAll("{root}", () => m.projectRoot));
  if (!def.wrapped) return [m.bun, ...own];
  return [m.bun, "--no-env-file", "src/routine-run.ts", "--id", launchdLabel(def.name), "--", m.bun, ...own];
}

/** Plist-Inhalt eines Katalogeintrags als Wert (vor dem Schreiben) */
export function servicePlistValue(def: ServiceDefinition, m: MachinePaths, schedule: SetupSchedule): PlistDict {
  if (def.kind === "external") throw new PlistError(`${launchdLabel(def.name)} richtet tybo nicht ein`);
  const env: PlistDict = { PATH: searchPath(def.path, m), HOME: m.home };
  if (def.projectRootEnv) env.GO_PROJECT_ROOT = m.projectRoot;

  const plist: PlistDict = {
    Label: launchdLabel(def.name),
    ProgramArguments: programArguments(def, m),
    WorkingDirectory: m.projectRoot,
    EnvironmentVariables: env,
  };
  if (def.calendar) plist.StartCalendarInterval = calendarValue(def.calendar(schedule));
  if (def.kind === "daemon" || def.kind === "once") plist.RunAtLoad = true;
  if (def.kind === "daemon") {
    plist.KeepAlive = true;
    plist.ThrottleInterval = 10;
  }
  if (def.exitTimeout) plist.ExitTimeOut = m.exitTimeoutS;
  // Aneinanderhängen statt join: der Projektordner bleibt Zeichen für Zeichen erhalten
  plist.StandardOutPath = `${m.projectRoot}/${def.logs.out}`;
  plist.StandardErrorPath = `${m.projectRoot}/${def.logs.err}`;
  return plist;
}

/** Fertige Plist-Datei eines Katalogeintrags */
export function servicePlist(def: ServiceDefinition, m: MachinePaths, schedule: SetupSchedule): string {
  return writePlist(servicePlistValue(def, m, schedule));
}
