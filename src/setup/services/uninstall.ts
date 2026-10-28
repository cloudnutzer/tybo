/**
 * `tybo deinstallieren` (Issue #373, Entscheidung E12, Nachfolger von
 * setup/uninstall.ts): nimmt die Hintergrunddienste von tybo von diesem
 * Rechner. `bun run uninstall` ist derselbe Befehl.
 *
 *   tybo deinstallieren        Dienste entfernen, dann Rückfrage zu models/speech/
 *   tybo deinstallieren help
 *
 * Was entfernt wird:
 * - macOS: jede Plist ai.tybo.*.plist in ~/Library/LaunchAgents, auch solche,
 *   die nicht im Dienstkatalog stehen (frühere wie watchdog, eigene Routinen
 *   aus /routine, external-Dienste mit tybo-Label).
 * - Linux mit systemd: der Bot (tybo-telegram-relay.service aus
 *   tybo setup autostart) und die Zeitpläne aus dem Katalog
 *   (tybo-<dienst>.timer und .service). Auch ein Dienst, dessen Datei schon
 *   fehlt, der aber noch geladen ist, wird gestoppt. Alles über
 *   `systemctl --user`, nie über sudo; Linger bleibt eingeschaltet.
 * - Linux, immer: die eigenen cron-Zeilen (# tybo-<dienst> und die frühere
 *   Markierung # go-<dienst>); fremde Zeilen bleiben, ebenso die Zeilen eines
 *   Diensts, dessen Namen (tybo-<dienst>, go-<dienst>, Einheiten) die
 *   Schutzliste nennt.
 * - Linux und Windows: PM2-Prozesse tybo-*, nur wenn das installierte pm2
 *   antwortet (nie über npx); danach streicht der Befehl ihre Einträge aus
 *   der gespeicherten Liste (dump.pm2), damit `pm2 resurrect` nichts
 *   zurückholt. Alle anderen Einträge bleiben wörtlich stehen, auch fremde
 *   und übergebene, die gerade nicht laufen (kein `pm2 save --force`, das die
 *   Liste durch die laufenden Prozesse ersetzte). Das läuft auch dann, wenn
 *   nur noch dump.pm2 tybo-* nennt, etwa nach einem gescheiterten Schreiben
 *   im Lauf davor. Ist dump.pm2 da, aber nicht lesbar, bleibt PM2 unverändert.
 *   Fehlt dump.pm2, gilt wie bei pm2 resurrect die Sicherung dump.pm2.bak:
 *   sie wird ebenso bereinigt, ist sie nicht lesbar, bleibt PM2 unverändert.
 *   Fehlt pm2, gibt es nichts zu tun; scheitert `pm2 --version` oder läuft
 *   seine Frist ab, bleibt PM2 unverändert (Exit 1).
 *
 * Was bleibt: Dienste anderer Namen und alles, was config/routines.json
 * nennt (Entscheidung 0025), Projektordner, .env, data/, andere Modelle
 * unter models/, Supabase auf diesem Rechner samt Containern und Daten (die
 * Ausgabe nennt `tybo datenbank stop`). models/speech/ nur nach „Ja“ auf die
 * Rückfrage; ohne Terminal bleibt der Ordner.
 *
 * Sicherheitsregel: Lässt sich ein Dienst nicht sicher stoppen (Entladen
 * scheitert und er steht noch in der Liste, systemctl --user antwortet
 * nicht, eine Einheit läuft oder stoppt nach dem Stoppen noch), bleibt seine
 * Datei liegen. Eine Einheit, die schon stoppt (deactivating), bekommt ein
 * eigenes stop, das auf das Ende wartet.
 * Unter systemd wird jede Einheit unmittelbar vor dem Stoppen neu gelesen: ein
 * Timer kann seinen Dienst seit der Vorabprüfung gestartet haben. Sonst liefe er ohne Datei weiter, und
 * kein späterer Aufruf fände ihn.
 *
 * Exit-Codes: 0 alles entfernt oder nichts da (ein zweiter Aufruf ist
 * harmlos), 1 mindestens ein Schritt gescheitert, 2 unbekannter Aufruf.
 * Alles Äußere steckt in UninstallDeps; Tests reichen Attrappen herein.
 */

import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { BRAND } from "../../brand";
import { parseEnvContent } from "../../lib/env-file";
import { parseRoutinesConfig, ROUTINES_CONFIG_FILE, type RoutinesConfig } from "../../lib/routines/config";
import { SERVICE_CATALOG, SERVICE_NAMES } from "../../lib/services/catalog";
import { cronMarker, isOwnCronLine, legacyCronMarker } from "../../lib/services/systemd";
import { BOT_SERVICE, isServicePlist, labelInLaunchctlList, launchdLabel, PM2_PREFIX, pm2Name, SUPABASE_SERVICE, systemdUnit, systemdUnitFile } from "../../lib/service-names";
import { parseShow } from "../../../setup/configure-systemd";
import { isLocalSupabaseUrl } from "../local-supabase";
import { removeSpeechModels } from "../speech-maintenance";
import { SUPABASE_UNLOAD_TIMEOUT_MS } from "./launchd";
import { readCrontab, userUnitDir, writeCrontab } from "./linux";
import { pm2ProcessNames, SUPABASE_DELETE_TIMEOUT_MS } from "./pm2";
import { runWithTimeout, type ServiceRun } from "./run";

export interface UninstallDeps {
  root: string;
  platform: NodeJS.Platform;
  launchAgentsDir: string;
  /** ~/.config/systemd/user */
  unitDir: string;
  /** /run/systemd/system: gibt es nur, wenn der Rechner mit systemd läuft */
  runDir: string;
  /** Aufruf von PM2, etwa ["pm2"] */
  pm2: string[];
  /** Gespeicherte Liste von PM2 (dump.pm2), wie PM2 sie findet: PM2_HOME oder ~/.pm2 */
  pm2Dump: string;
  run(cmd: string[], options?: { timeoutMs?: number; stdin?: string }): Promise<ServiceRun>;
  exists(path: string): boolean;
  /** Dateinamen eines Ordners; [] wenn er fehlt */
  listDir(path: string): string[];
  /** Inhalt einer Textdatei; null wenn sie fehlt */
  readText(path: string): string | null;
  remove(path: string): void;
  /** Textdatei ersetzen, ohne dass sie halb geschrieben stehen bleibt (dump.pm2) */
  writeText(path: string, content: string): void;
  /** Ordner samt Inhalt löschen (models/speech/) */
  removeTree(path: string): Promise<void>;
  /** Ja/Nein-Frage; ohne Terminal immer Nein */
  ask(question: string): Promise<boolean>;
  out(line: string): void;
  err(line: string): void;
}

/** Hinweis, sobald Supabase auf diesem Rechner im Spiel ist: Container und Daten bleiben */
export const SUPABASE_KEPT = `Supabase auf diesem Rechner bleibt samt Docker-Containern und Daten. Anhalten mit: ${BRAND.cli} datenbank stop`;

/** Hinweis nach dem Entfernen von systemd-Diensten */
export const LINGER_KEPT =
  "Linger bleibt eingeschaltet, andere Benutzerdienste können es brauchen. Ausschalten, wenn nichts anderes es braucht: loginctl disable-linger $USER (ohne Berechtigung mit sudo davor)";

/** Was immer bleibt */
export const KEPT_NOTE = "Projektordner, .env, data/ und andere Modelle unter models/ bleiben unverändert.";

/** cron-Markierungen, nach denen gesucht wird: alle Katalognamen und der frühere watchdog */
const CRON_SERVICES = [...SERVICE_NAMES, "watchdog"];

export function uninstallUsage(): string {
  return [
    `${BRAND.cli} deinstallieren        Hintergrunddienste von ${BRAND.name} entfernen, dann Rückfrage zu models/speech/`,
    "",
    "macOS: alle ai.tybo.*-Dienste (launchd). Linux: systemd-Dienste und -Timer tybo-*, eigene cron-Zeilen, PM2-Prozesse tybo-*.",
    "Windows: PM2-Prozesse tybo-*. Dienste aus config/routines.json und Dienste anderer Namen bleiben.",
    `Projektordner, .env, data/ und Supabase-Daten bleiben. Wieder einrichten: ${BRAND.cli} dienste bzw. ${BRAND.cli} setup autostart`,
  ].join("\n");
}

/** Sammelt, was entfernt wurde und was scheiterte */
interface Tally {
  removed: string[];
  problems: string[];
}

function handedOver(name: string, config: RoutinesConfig): boolean {
  return config.labels.includes(name) || config.prefixes.some(prefix => name.startsWith(prefix));
}

function loadRoutinesConfig(deps: UninstallDeps): RoutinesConfig {
  const parsed = parseRoutinesConfig(deps.readText(join(deps.root, ROUTINES_CONFIG_FILE)));
  if (parsed.note) deps.out(`  ! ${parsed.note}`);
  return parsed.config;
}

function problem(tally: Tally, deps: UninstallDeps, text: string) {
  tally.problems.push(text);
  deps.err(`  ✗ ${text}`);
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

async function removeLaunchd(deps: UninstallDeps, config: RoutinesConfig, tally: Tally) {
  deps.out("\nlaunchd");
  const plists = deps.listDir(deps.launchAgentsDir).filter(isServicePlist).sort();
  const kept = plists.filter(file => handedOver(basename(file, ".plist"), config));
  for (const file of kept) deps.out(`  - ${basename(file, ".plist")} bleibt (steht in ${ROUTINES_CONFIG_FILE})`);
  const targets = plists.filter(file => !kept.includes(file));
  if (targets.length === 0) {
    deps.out("  Keine ai.tybo.*-Dienste eingerichtet.");
    return;
  }
  for (const file of targets) {
    const label = basename(file, ".plist");
    const path = join(deps.launchAgentsDir, file);
    // launchd lässt einem laufenden Supabase-Start bis zu ExitTimeOut Zeit
    const timeout = label === launchdLabel(SUPABASE_SERVICE) ? { timeoutMs: SUPABASE_UNLOAD_TIMEOUT_MS } : undefined;
    const unloaded = await deps.run(["launchctl", "unload", path], timeout);
    if (!unloaded.ok) {
      // Scheitert auch bei einem gar nicht geladenen Dienst; gelöscht wird nur, wenn er sicher nicht mehr in der Liste steht
      const listing = await deps.run(["launchctl", "list"]);
      if (!listing.ok || labelInLaunchctlList(listing.stdout, label)) {
        problem(tally, deps, `${label} ließ sich nicht entladen; die Dienstdatei bleibt: ${path}`);
        continue;
      }
    }
    try {
      deps.remove(path);
    } catch {
      problem(tally, deps, `${label} ist entladen, aber die Dienstdatei ließ sich nicht löschen: ${path}`);
      continue;
    }
    tally.removed.push(label);
    deps.out(`  ✓ Entfernt: ${label}`);
  }
}

// ---------------------------------------------------------------------------
// Linux: systemd und cron
// ---------------------------------------------------------------------------

/** Ein Dienst unter systemd mit seinen Einheiten, Timer vor dem Dienst */
interface UnitGroup {
  name: string;
  units: string[];
}

function unitGroups(): UnitGroup[] {
  const timers = SERVICE_CATALOG.filter(def => def.linux === "timer").map(def => ({ name: def.name, units: [`${systemdUnit(def.name)}.timer`, `${systemdUnit(def.name)}.service`] }));
  return [{ name: BOT_SERVICE, units: [systemdUnitFile(BOT_SERVICE)] }, ...timers];
}

interface UnitState {
  file: boolean;
  loaded: boolean;
  active: boolean;
  /** ActiveState=deactivating: stoppt gerade, ist also noch nicht beendet */
  stopping: boolean;
  enabled: boolean;
}

async function readUnitState(unit: string, deps: UninstallDeps): Promise<UnitState | null> {
  const shown = await deps.run(["systemctl", "--user", "show", unit, "--property=LoadState,ActiveState,UnitFileState"]);
  if (!shown.ok) return null;
  const props = parseShow(shown.stdout);
  if (!props.LoadState) return null;
  return {
    file: deps.exists(join(deps.unitDir, unit)),
    loaded: props.LoadState === "loaded",
    active: ["active", "activating", "reloading"].includes(props.ActiveState ?? ""),
    stopping: props.ActiveState === "deactivating",
    enabled: props.UnitFileState === "enabled",
  };
}

/** Steht der Dienst oder eine seiner Einheiten in config/routines.json, bleibt die ganze Gruppe */
function groupHandedOver(group: UnitGroup, config: RoutinesConfig): boolean {
  return [systemdUnit(group.name), ...group.units].some(name => handedOver(name, config));
}

/**
 * Stoppt eine Einheit nach ihrem Zustand von jetzt (nicht dem der
 * Vorabprüfung) und liest ihn danach noch einmal. "stopped" nur, wenn sie
 * danach sicher nicht mehr läuft und nicht mehr stoppt; sonst eine Meldung
 * für den Nutzer. Stoppt sie schon, wartet ein eigenes stop auf das Ende.
 */
async function stopUnit(unit: string, deps: UninstallDeps): Promise<{ stopped: true } | { stopped: false; reason: string }> {
  const now = await readUnitState(unit, deps);
  if (now === null) return { stopped: false, reason: `Der Zustand von ${unit} ließ sich nicht lesen` };
  const command = now.enabled ? ["disable", "--now", unit] : now.active || now.stopping ? ["stop", unit] : null;
  if (command === null) return { stopped: true };
  if (!(await deps.run(["systemctl", "--user", ...command])).ok) return { stopped: false, reason: `${unit} ließ sich nicht stoppen` };
  const after = await readUnitState(unit, deps);
  if (after === null) return { stopped: false, reason: `Nach dem Stoppen ließ sich der Zustand von ${unit} nicht lesen` };
  if (after.active) return { stopped: false, reason: `${unit} läuft nach dem Stoppen noch` };
  if (after.stopping) return { stopped: false, reason: `${unit} stoppt nach dem Stoppen noch (deactivating), das Ende ist ungeklärt` };
  return { stopped: true };
}

async function removeSystemd(deps: UninstallDeps, config: RoutinesConfig, tally: Tally) {
  deps.out("\nsystemd");
  const all = unitGroups();
  const kept = all.filter(group => groupHandedOver(group, config));
  for (const group of kept) deps.out(`  - ${systemdUnit(group.name)} bleibt (steht in ${ROUTINES_CONFIG_FILE})`);
  const groups = all.filter(group => !kept.includes(group));

  if (!deps.exists(deps.runDir)) {
    // Ohne systemd läuft keine Einheit; übrige Dateien nur wegräumen
    const files = groups.flatMap(g => g.units).filter(unit => deps.exists(join(deps.unitDir, unit)));
    if (files.length === 0) deps.out("  Kein systemd auf diesem Rechner.");
    for (const unit of files) {
      try {
        deps.remove(join(deps.unitDir, unit));
        deps.out(`  ✓ Datei entfernt: ${unit}`);
      } catch {
        problem(tally, deps, `${unit} ließ sich nicht löschen: ${join(deps.unitDir, unit)}`);
      }
    }
    return;
  }

  // Erst alle Zustände lesen, dann ändern: antwortet der Benutzer-Manager nicht, bleibt alles, wie es ist
  const states = new Map<string, UnitState>();
  for (const unit of groups.flatMap(g => g.units)) {
    const state = await readUnitState(unit, deps);
    if (state === null) {
      problem(tally, deps, "systemctl --user antwortet nicht; an systemd wurde nichts geändert. Als normaler Benutzer in einer Anmeldesitzung erneut ausführen, nicht über sudo oder su.");
      return;
    }
    states.set(unit, state);
  }

  let changed = false;
  let failed = false;
  for (const group of groups) {
    const present = group.units.filter(unit => {
      const s = states.get(unit)!;
      return s.file || s.loaded || s.active || s.stopping || s.enabled;
    });
    if (present.length === 0) continue;
    let stopped = true;
    for (const unit of present) {
      const result = await stopUnit(unit, deps);
      if (!result.stopped) {
        problem(tally, deps, `${result.reason}; die Dateien von ${systemdUnit(group.name)} bleiben. Prüfen mit: systemctl --user status ${unit}`);
        stopped = false;
        failed = true;
        break;
      }
    }
    if (!stopped) continue;
    changed = true;
    let deleted = true;
    for (const unit of present.filter(unit => states.get(unit)!.file)) {
      try {
        deps.remove(join(deps.unitDir, unit));
      } catch {
        problem(tally, deps, `${unit} ist gestoppt, aber die Datei ließ sich nicht löschen: ${join(deps.unitDir, unit)}`);
        deleted = false;
      }
    }
    if (deleted) {
      tally.removed.push(systemdUnit(group.name));
      deps.out(`  ✓ Entfernt: ${present.join(", ")}`);
    }
  }
  if (!changed) {
    if (!failed) deps.out("  Keine tybo-Dienste unter systemd.");
    return;
  }
  if (!(await deps.run(["systemctl", "--user", "daemon-reload"])).ok) problem(tally, deps, "systemctl --user daemon-reload ist gescheitert; einmal von Hand ausführen.");
  deps.out(`  ${LINGER_KEPT}`);
}

/** Nennt die Schutzliste einen Namen des Diensts (beide Markierungen, Einheiten), bleiben seine cron-Zeilen */
function cronHandedOver(service: string, config: RoutinesConfig): boolean {
  const names = [cronMarker(service), legacyCronMarker(service)].map(marker => marker.replace(/^# /, ""));
  return [...names, `${systemdUnit(service)}.service`, `${systemdUnit(service)}.timer`].some(name => handedOver(name, config));
}

async function removeCronLines(deps: UninstallDeps, config: RoutinesConfig, tally: Tally) {
  deps.out("\ncron");
  const lines = await readCrontab(deps);
  if (lines === null) {
    problem(tally, deps, "Die crontab ließ sich nicht lesen (crontab -l); cron-Zeilen unverändert.");
    return;
  }
  const kept = CRON_SERVICES.filter(service => cronHandedOver(service, config) && lines.some(line => isOwnCronLine(line, service)));
  for (const service of kept) deps.out(`  - cron-Zeilen von ${systemdUnit(service)} bleiben (steht in ${ROUTINES_CONFIG_FILE})`);
  const targets = CRON_SERVICES.filter(service => !cronHandedOver(service, config));
  const rest = lines.filter(line => !targets.some(service => isOwnCronLine(line, service)));
  const count = lines.length - rest.length;
  if (count === 0) {
    deps.out("  Keine cron-Zeilen von tybo.");
    return;
  }
  if (!(await writeCrontab(rest, deps))) {
    problem(tally, deps, "Die crontab ließ sich nicht schreiben (crontab -); die Zeilen von tybo stehen noch darin.");
    return;
  }
  tally.removed.push("cron");
  deps.out(`  ✓ cron-Zeilen entfernt: ${count}, andere Zeilen unverändert`);
}

// ---------------------------------------------------------------------------
// PM2
// ---------------------------------------------------------------------------

async function removePm2(deps: UninstallDeps, config: RoutinesConfig, tally: Tally) {
  deps.out("\nPM2");
  const version = await deps.run([...deps.pm2, "--version"]);
  if (version.missing) {
    deps.out("  PM2 ist nicht installiert, nichts zu entfernen.");
    return;
  }
  // Installiert, aber gescheitert oder Frist abgelaufen: seine Prozesse können noch laufen
  if (!version.ok) {
    problem(tally, deps, `PM2 antwortet nicht (${deps.pm2.join(" ")} --version: ${version.stderr || "gescheitert"}); PM2 unverändert. PM2 prüfen, dann erneut ausführen: ${BRAND.cli} deinstallieren`);
    return;
  }
  const names = await pm2ProcessNames({ projectRoot: deps.root, pm2: deps.pm2, run: deps.run, log: deps.out });
  if (names === null) {
    problem(tally, deps, "Die Liste der PM2-Prozesse ließ sich nicht lesen (pm2 jlist); PM2 unverändert.");
    return;
  }
  // Vor jeder Änderung lesen: ohne lesbare Liste lassen sich fremde Einträge darin nicht sicher erhalten
  const { path: dumpPath, entries: saved } = readPm2Dump(deps);
  if (saved === null) {
    problem(tally, deps, `Die gespeicherte PM2-Liste (${dumpPath}) ist nicht lesbar; PM2 unverändert, damit keine gespeicherten Prozesse anderer Programme verloren gehen. Datei prüfen, dann erneut ausführen.`);
    return;
  }
  const isTarget = (name: string) => name.startsWith(PM2_PREFIX) && !handedOver(name, config);
  const own = [...new Set(names.filter(name => name.startsWith(PM2_PREFIX)))].sort();
  for (const name of own.filter(name => !isTarget(name))) deps.out(`  - ${name} bleibt (steht in ${ROUTINES_CONFIG_FILE})`);
  const targets = own.filter(isTarget);
  // Nennt die gespeicherte Liste noch tybo-*, etwa weil das Schreiben im Lauf davor scheiterte, wird sie trotzdem bereinigt
  const savedStale = saved.some(entry => isTarget(pm2EntryName(entry) ?? ""));
  if (targets.length === 0 && !savedStale) {
    deps.out("  Keine tybo-*-Prozesse.");
    return;
  }
  if (targets.length === 0) deps.out("  Keine tybo-*-Prozesse mehr, aber die gespeicherte Liste nennt noch welche.");
  const failed: string[] = [];
  for (const name of targets) {
    // PM2 wartet beim Beenden von tybo-supabase bis zu PM2_KILL_TIMEOUT_MS
    const timeout = name === pm2Name(SUPABASE_SERVICE) ? { timeoutMs: SUPABASE_DELETE_TIMEOUT_MS } : undefined;
    if (!(await deps.run([...deps.pm2, "delete", name], timeout)).ok) {
      problem(tally, deps, `${name} ließ sich nicht aus PM2 entfernen.`);
      failed.push(name);
      continue;
    }
    tally.removed.push(name);
    deps.out(`  ✓ Entfernt: ${name}`);
  }
  // Nur die eigenen Einträge streichen statt pm2 save --force: das ersetzte die ganze Liste durch die
  // laufenden Prozesse, gespeicherte fremde und übergebene, die gerade nicht laufen, fielen aus dem Autostart.
  // Ein Prozess, der sich nicht entfernen ließ, läuft weiter und bleibt darum auch gespeichert.
  const dropped = saved.filter(entry => {
    const name = pm2EntryName(entry);
    return name !== null && isTarget(name) && !failed.includes(name);
  });
  if (dropped.length === 0) return;
  try {
    deps.writeText(dumpPath, `${JSON.stringify(saved.filter(entry => !dropped.includes(entry)), null, 2)}\n`);
  } catch {
    problem(tally, deps, `Die gespeicherte PM2-Liste (${dumpPath}) ließ sich nicht schreiben: nach einem Neustart holte pm2 resurrect die entfernten Prozesse zurück. Erneut ausführen: ${BRAND.cli} deinstallieren`);
    return;
  }
  const droppedNames = [...new Set(dropped.map(entry => pm2EntryName(entry)!))].sort();
  if (!droppedNames.some(name => tally.removed.includes(name))) tally.removed.push("pm2-dump");
  const where = dumpPath === deps.pm2Dump ? "" : ` (Sicherung ${basename(dumpPath)}, ${basename(deps.pm2Dump)} fehlt)`;
  deps.out(`  ✓ Aus der gespeicherten PM2-Liste${where} gestrichen: ${droppedNames.join(", ")}; andere Einträge unverändert`);
}

/**
 * Die gespeicherte Liste, die pm2 resurrect lesen würde: dump.pm2, fehlt sie,
 * die Sicherung dump.pm2.bak (auf sie greift PM2 dann zurück). entries: die
 * Einträge unverändert, [] wenn beide fehlen, null wenn die gelesene Datei da,
 * aber nicht lesbar oder kein JSON-Array ist.
 */
function readPm2Dump(deps: UninstallDeps): { path: string; entries: unknown[] | null } {
  if (deps.exists(deps.pm2Dump)) return { path: deps.pm2Dump, entries: readDumpFile(deps, deps.pm2Dump) };
  const backup = `${deps.pm2Dump}.bak`;
  if (deps.exists(backup)) return { path: backup, entries: readDumpFile(deps, backup) };
  return { path: deps.pm2Dump, entries: [] };
}

function readDumpFile(deps: UninstallDeps, path: string): unknown[] | null {
  const text = deps.readText(path);
  if (text === null) return null;
  let dump: unknown;
  try {
    dump = JSON.parse(text);
  } catch {
    return null;
  }
  return Array.isArray(dump) ? dump : null;
}

function pm2EntryName(entry: unknown): string | null {
  const name = (entry as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : null;
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------

function localDatabase(deps: UninstallDeps): boolean {
  const env = deps.readText(join(deps.root, ".env"));
  return env !== null && isLocalSupabaseUrl(parseEnvContent(env).SUPABASE_URL);
}

export async function runUninstallCommand(args: string[], deps: UninstallDeps): Promise<number> {
  if (args[0] === "--") args = args.slice(1);
  if (args.length === 1 && ["help", "--help", "-h"].includes(args[0])) {
    deps.out(uninstallUsage());
    return 0;
  }
  if (args.length > 0) {
    deps.err(`Unbekannter Aufruf: ${BRAND.cli} deinstallieren ${args.join(" ")}`);
    deps.err(uninstallUsage());
    return 2;
  }

  deps.out(`${BRAND.name}: Hintergrunddienste entfernen`);
  deps.out(`Projektordner: ${deps.root}`);
  const tally: Tally = { removed: [], problems: [] };
  const config = loadRoutinesConfig(deps);
  if (deps.platform === "darwin") {
    await removeLaunchd(deps, config, tally);
  } else {
    if (deps.platform === "linux") {
      await removeSystemd(deps, config, tally);
      await removeCronLines(deps, config, tally);
    }
    await removePm2(deps, config, tally);
  }

  const supabaseRemoved = tally.removed.includes(launchdLabel(SUPABASE_SERVICE)) || tally.removed.includes(pm2Name(SUPABASE_SERVICE));
  if (supabaseRemoved || localDatabase(deps)) deps.out(`\n${SUPABASE_KEPT}`);

  deps.out("");
  const speech = await removeSpeechModels(deps.root, deps.ask, line => deps.out(line), deps.removeTree, deps.exists);
  if (speech === "fehler") tally.problems.push("models/speech/");

  deps.out("");
  deps.out(KEPT_NOTE);
  deps.out(`Wieder einrichten: ${BRAND.cli} dienste (alle Dienste) bzw. ${BRAND.cli} setup autostart (nur der Bot)`);
  if (tally.problems.length > 0) {
    deps.err(`\nNicht vollständig entfernt: ${tally.problems.length} ${tally.problems.length === 1 ? "Schritt" : "Schritte"} gescheitert (siehe oben).`);
    return 1;
  }
  deps.out(tally.removed.length > 0 ? `\nFertig: ${tally.removed.length} entfernt.` : "\nFertig: es war nichts eingerichtet.");
  return 0;
}

/** Ja/Nein im Terminal, Standard Nein; ohne Terminal (Pipe, Dienst) immer Nein */
export async function askInTerminal(
  question: string,
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<boolean> {
  if (!input.isTTY) return false;
  const rl = createInterface({ input, output });
  try {
    return /^(j|ja|y|yes)$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

const COMMAND_TIMEOUT_MS = 30_000;

/** Echte Zugriffe für den Projektordner root; Befehle laufen im Projektordner, nie im Arbeitsverzeichnis */
export function realUninstallDeps(root: string, home: string = process.env.HOME || homedir()): UninstallDeps {
  return {
    root,
    platform: process.platform,
    launchAgentsDir: join(home, "Library", "LaunchAgents"),
    unitDir: userUnitDir(process.env, home),
    runDir: "/run/systemd/system",
    pm2: ["pm2"],
    pm2Dump: join(process.env.PM2_HOME || join(home, ".pm2"), "dump.pm2"),
    run: (cmd, options) => runWithTimeout(cmd, root, options?.timeoutMs ?? COMMAND_TIMEOUT_MS, options?.stdin),
    exists: path => existsSync(path),
    listDir: path => (existsSync(path) ? readdirSync(path) : []),
    readText: path => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    remove: path => rmSync(path),
    writeText: (path, content) => {
      // Erst daneben schreiben, dann umbenennen; dump.pm2 enthält Umgebungsvariablen, darum nur für den Besitzer lesbar
      const temp = `${path}.tybo-${process.pid}`;
      try {
        writeFileSync(temp, content, { mode: 0o600 });
        renameSync(temp, path);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
    },
    removeTree: async path => rmSync(path, { recursive: true, force: true }),
    ask: question => askInTerminal(question),
    out: line => console.log(line),
    err: line => console.error(line),
  };
}
