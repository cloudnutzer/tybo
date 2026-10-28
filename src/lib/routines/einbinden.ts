/**
 * tybo routinen einbinden|ausbinden <label> (Issue #286, Entscheidung 0025):
 * setzt den Wrapper src/routine-run.ts vor die ProgramArguments einer
 * bestehenden Plist bzw. entfernt ihn wieder. Nur im Terminal, nie als
 * Chat-Befehl, immer nur ein Dienst.
 *
 * Ablauf: prüfen (Katalog, Pfad, Label eindeutig, geladen und aktiv, läuft
 * gerade nicht, Plan aus wrap.ts), Änderung zeigen und fragen, sichern nach
 * data/launchd-backup/<label>.<zeit>.plist, neue Plist als Kopie neben der
 * alten bauen (`plutil -replace`, nur ProgramArguments ändert sich) und
 * prüfen (`plutil -lint`, alle übrigen Felder gleich), den Dienstzustand
 * erneut prüfen, dann `launchctl bootout`, Kopie per rename an ihren Platz,
 * `launchctl bootstrap` und Nachkontrolle. Scheitert ein Schritt nach dem bootout, kommt die Sicherung
 * zurück und der alte Dienst wird wieder geladen; scheitert auch das, bleibt
 * die Sicherung und die Meldung nennt den tatsächlichen Zustand.
 *
 * Alles Äußere steckt in WrapCommandDeps; Tests rufen nie launchctl oder plutil.
 */

import { copyFileSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { defaultRoutinesDeps, listRoutines, type RoutinesDeps } from "./catalog";
import { safeRoutineId } from "./runs";
import { parseLaunchctlList, readPlist } from "./sources/launchd";
import { unwrapProgramArguments, wrapProgramArguments, type WrapPlan } from "./wrap";

export type WrapMode = "einbinden" | "ausbinden";

export interface WrapCommandDeps extends RoutinesDeps {
  /** Absoluter Pfad zu bun für den Vorsatz; null: nicht gefunden */
  bunPath: string | null;
  /** Art des Pfads ohne Symlinks aufzulösen; null, wenn er fehlt */
  lstat(path: string): { symlink: boolean; file: boolean } | null;
  exists(path: string): boolean;
  /** Kopie; wirft, wenn das Ziel schon existiert */
  copyFile(src: string, dst: string): void;
  rename(src: string, dst: string): void;
  remove(path: string): void;
  mkdir(path: string): void;
  /** Antwort auf eine Frage; null bei Eingabeende */
  ask(question: string): Promise<string | null>;
  sleep(ms: number): Promise<void>;
  out(line: string): void;
  err(line: string): void;
}

export interface WrapCommandOptions {
  /** --ja: ohne Rückfrage */
  yes?: boolean;
}

/** Ordner der Sicherungen, relativ zum Projekt */
export const BACKUP_DIR = join("data", "launchd-backup");
const BOOTSTRAP_ATTEMPTS = 3;
const BOOTSTRAP_WAIT_MS = 1000;

export const EINBINDEN_TEXT = {
  macOnly: "tybo routinen einbinden und ausbinden gibt es nur unter macOS (launchd). Auf diesem System wird nichts geändert.",
  badLabel: (label: string) => `${label} ist kein gültiges Label.`,
  notInCatalog: (label: string) =>
    `${label} ist keine Routine. Eingebunden werden nur ai.tybo.* und Dienste aus config/routines.json (tybo routinen zeigt alle).`,
  notInAgents: (label: string) => `Die Plist ${label}.plist liegt nicht direkt in ~/Library/LaunchAgents. Nur Plists von dort werden geändert.`,
  symlink: (label: string) => `~/Library/LaunchAgents/${label}.plist ist ein symbolischer Link. Nur echte Dateien werden geändert.`,
  ambiguous: (label: string, files: string[]) => `Das Label ${label} steht in mehreren Plists (${files.join(", ")}). Bitte erst aufräumen, nichts geändert.`,
  unreadable: (label: string) => `Die Plist von ${label} ist nicht lesbar (plutil), nichts geändert.`,
  noBun: "bun wurde nicht gefunden (PATH). Ohne bun kann der Wrapper nicht starten, nichts geändert.",
  paused: (label: string) => `${label} ist pausiert. Erst fortsetzen, dann noch einmal; nichts geändert.`,
  notLoaded: (label: string) => `${label} ist nicht geladen. Geändert werden nur geladene Dienste, nichts geändert.`,
  unknownState: (label: string) => `Der Zustand von ${label} ist unbekannt (launchctl). Nichts geändert.`,
  running: (label: string) => `${label} läuft gerade. Bitte warten, bis der Lauf fertig ist, und dann noch einmal; nichts geändert.`,
  question: (mode: WrapMode) => (mode === "einbinden" ? "Einbinden? [j/N] " : "Ausbinden? [j/N] "),
  aborted: "Abgebrochen, nichts geändert.",
  backupFailed: (reason: string) => `Sicherung gescheitert (${reason}), nichts geändert.`,
  prepareFailed: (reason: string) => `Neue Plist nicht erstellt (${reason}), nichts geändert.`,
  runAtLoad: "Hinweis: RunAtLoad ist gesetzt, das Neuladen startet die Routine sofort einmal.",
  unchangedFields: "Unverändert bleiben WorkingDirectory, Umgebung, Zeitplan und Log-Pfade.",
  done: (label: string, mode: WrapMode) => `${label} ${mode === "einbinden" ? "eingebunden" : "ausgebunden"}.`,
  doneHint: "Den Verlauf zeigt /routinen bzw. tybo routinen, sobald die Routine einmal gelaufen ist.",
} as const;

function backupStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "").replace("T", "-");
}

function listing(args: string[]): string[] {
  return args.map((a, i) => `  ${i + 1}. ${JSON.stringify(a)}`);
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Ist das Label laut `launchctl list` geladen und mit welcher PID? undefined: Befehl gescheitert */
async function loadedEntry(deps: WrapCommandDeps, label: string): Promise<{ loaded: boolean; pid: number | null } | undefined> {
  const res = await deps.run(["launchctl", "list"]).catch(() => null);
  if (!res?.ok) return undefined;
  const entry = parseLaunchctlList(res.stdout).get(label);
  return entry ? { loaded: true, pid: entry.pid } : { loaded: false, pid: null };
}

/** Plist als Objekt über plutil; null, wenn nicht lesbar */
async function plistJson(deps: WrapCommandDeps, path: string): Promise<Record<string, unknown> | null> {
  const res = await deps.run(["plutil", "-convert", "json", "-o", "-", path]).catch(() => null);
  if (!res?.ok) return null;
  try {
    const data = JSON.parse(res.stdout);
    return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function bootstrap(deps: WrapCommandDeps, path: string): Promise<boolean> {
  for (let i = 0; i < BOOTSTRAP_ATTEMPTS; i++) {
    if (i > 0) await deps.sleep(BOOTSTRAP_WAIT_MS);
    const res = await deps.run(["launchctl", "bootstrap", `gui/${deps.uid}`, path]).catch(() => null);
    if (res?.ok) return true;
  }
  return false;
}

/** Prüfungen bis zum Plan; Ergebnis ist der Plan oder ein Exit-Code */
async function prepare(mode: WrapMode, label: string, deps: WrapCommandDeps): Promise<{ plan: Extract<WrapPlan, { changed: true }>; plist: Record<string, unknown>; path: string } | number> {
  if (deps.platform !== "darwin") return fail(deps, EINBINDEN_TEXT.macOnly);
  if (!safeRoutineId(label)) return fail(deps, EINBINDEN_TEXT.badLabel(label));
  const list = await listRoutines(deps);
  const routine = list.routines.find(r => r.id === label && r.source === "launchd");
  if (!routine) return fail(deps, EINBINDEN_TEXT.notInCatalog(label));

  const agentsDir = join(deps.home, "Library", "LaunchAgents");
  const file = `${label}.plist`;
  const path = join(agentsDir, file);
  const stat = deps.lstat(path);
  if (!stat) return fail(deps, EINBINDEN_TEXT.notInAgents(label));
  if (stat.symlink) return fail(deps, EINBINDEN_TEXT.symlink(label));
  if (!stat.file) return fail(deps, EINBINDEN_TEXT.notInAgents(label));

  // Ein Label in mehreren Plists: welcher launchd lädt, ist offen
  let files: string[];
  try {
    files = deps.listDir(agentsDir).filter(f => f.endsWith(".plist") && f !== file);
  } catch {
    files = [];
  }
  const others = await Promise.all(files.map(f => readPlist({ launchAgentsDir: agentsDir, uid: deps.uid, run: deps.run, listDir: deps.listDir }, f)));
  const twins = others.filter(o => o.label === label).map(o => o.file);
  if (twins.length) return fail(deps, EINBINDEN_TEXT.ambiguous(label, [file, ...twins]));

  const plist = await plistJson(deps, path);
  if (!plist) return fail(deps, EINBINDEN_TEXT.unreadable(label));

  let plan: WrapPlan;
  if (mode === "einbinden") {
    if (!deps.bunPath) return fail(deps, EINBINDEN_TEXT.noBun);
    plan = wrapProgramArguments(plist, label, deps.bunPath, deps.projectRoot);
  } else {
    plan = unwrapProgramArguments(plist, label);
  }
  if (!plan.ok) return fail(deps, plan.reason);
  if (!plan.changed) {
    deps.out(plan.reason);
    return 0;
  }

  const blocked = await stateBlocks(deps, label, routine.state);
  if (blocked) return fail(deps, blocked);
  return { plan, plist, path };
}

/**
 * Darf der Dienst jetzt angefasst werden? Nur geladen, aktiv und gerade ohne
 * Lauf. Gibt den Grund zurück, warum nicht, sonst null. Ohne state wird er
 * frisch aus dem Katalog gelesen (erneute Prüfung nach der Rückfrage).
 */
async function stateBlocks(deps: WrapCommandDeps, label: string, state?: string): Promise<string | null> {
  if (state === undefined) {
    const routine = (await listRoutines(deps)).routines.find(r => r.id === label && r.source === "launchd");
    if (!routine) return EINBINDEN_TEXT.unknownState(label);
    state = routine.state;
  }
  if (state === "paused") return EINBINDEN_TEXT.paused(label);
  if (state === "not-loaded") return EINBINDEN_TEXT.notLoaded(label);
  if (state !== "active") return EINBINDEN_TEXT.unknownState(label);
  const entry = await loadedEntry(deps, label);
  if (!entry) return EINBINDEN_TEXT.unknownState(label);
  if (!entry.loaded) return EINBINDEN_TEXT.notLoaded(label);
  if (entry.pid !== null) return EINBINDEN_TEXT.running(label);
  return null;
}

function fail(deps: WrapCommandDeps, line: string): number {
  deps.err(line);
  return 1;
}

/**
 * Alten Zustand wiederherstellen: Sicherung über eine Kopie zurück an ihren
 * Platz, Dienst neu laden, prüfen. Meldet den tatsächlichen Zustand.
 * Wiederhergestellt ist nur, was nachweislich so ist: alte Plist an ihrem
 * Platz, bootstrap genau dieser Plist erfolgreich und der Dienst danach in
 * launchctl list. Steht das Label nur in der Liste (bootout und bootstrap
 * gescheitert), kann dort weiter die geänderte Konfiguration geladen sein.
 * Scheitert das Zurückkopieren, zählt der Inhalt, der tatsächlich an seinem
 * Platz liegt (etwa noch das Original, wenn schon das erste rename scheiterte);
 * ist er weder alt noch geändert oder nicht lesbar, heißt er unbekannt.
 */
async function restore(
  deps: WrapCommandDeps,
  label: string,
  path: string,
  tmp: string,
  backup: string,
  cause: string,
  plists: { old: Record<string, unknown>; changed: Record<string, unknown> },
): Promise<number> {
  let fileRestored = false;
  try {
    if (deps.exists(tmp)) deps.remove(tmp);
    deps.copyFile(backup, tmp);
    deps.rename(tmp, path);
    fileRestored = true;
  } catch {
    try {
      if (deps.exists(tmp)) deps.remove(tmp);
    } catch {
      // bleibt liegen, die Meldung unten nennt die Sicherung
    }
  }
  let fileState: "old" | "changed" | "unknown" = "old";
  if (!fileRestored) {
    const current = await plistJson(deps, path);
    fileState = !current ? "unknown" : Bun.deepEquals(current, plists.old) ? "old" : Bun.deepEquals(current, plists.changed) ? "changed" : "unknown";
  }
  // Ergebnis von bootout zählt nicht: war der Dienst schon entladen, scheitert es zu Recht
  await deps.run(["launchctl", "bootout", `gui/${deps.uid}/${label}`]).catch(() => null);
  const reloaded = await bootstrap(deps, path);
  const entry = await loadedEntry(deps, label);
  const loaded = entry?.loaded === true;
  if (fileState === "old" && reloaded && loaded) {
    deps.err(`${cause} Alter Zustand wiederhergestellt: alte Plist an ihrem Platz, Dienst wieder geladen. Sicherung: ${backup}`);
    return 1;
  }
  const fileText =
    fileState === "old" ? "die Plist ist wieder die alte" : fileState === "changed" ? "die Plist ist noch die geänderte" : "der Inhalt der Plist ist unbekannt";
  const loadText =
    entry === undefined
      ? "ob der Dienst geladen ist, ist unbekannt"
      : !loaded
        ? "der Dienst ist nicht geladen"
        : reloaded
          ? fileState === "old"
            ? "der Dienst ist mit der alten Plist geladen"
            : fileState === "changed"
              ? "der Dienst ist mit der geänderten Plist geladen"
              : "der Dienst ist geladen, mit welcher Plist, ist unbekannt"
          : "der Dienst ist geladen, aber nicht nachweislich mit der alten Plist (womöglich noch mit der geänderten)";
  deps.err(`${cause} Wiederherstellung unvollständig: ${fileText}, ${loadText}.`);
  deps.err(`Sicherung: ${backup}`);
  deps.err(`Von Hand zurück: cp "${backup}" "${path}" && launchctl bootout gui/${deps.uid}/${label}; launchctl bootstrap gui/${deps.uid} "${path}"`);
  return 1;
}

/** einbinden bzw. ausbinden; gibt den Exit-Code zurück */
export async function changeRoutineWrapper(mode: WrapMode, label: string, deps: WrapCommandDeps, options: WrapCommandOptions = {}): Promise<number> {
  const prepared = await prepare(mode, label, deps);
  if (typeof prepared === "number") return prepared;
  const { plan, plist, path } = prepared;
  const plists = { old: plist, changed: { ...plist, ProgramArguments: plan.after } };

  deps.out(`Routine: ${label}`);
  deps.out(`Plist: ${path}`);
  deps.out("Bisherige ProgramArguments:");
  for (const l of listing(plan.before)) deps.out(l);
  deps.out("Neue ProgramArguments:");
  for (const l of listing(plan.after)) deps.out(l);
  deps.out(EINBINDEN_TEXT.unchangedFields);
  if (plist.RunAtLoad === true) deps.out(EINBINDEN_TEXT.runAtLoad);

  if (!options.yes) {
    const answer = (await deps.ask(EINBINDEN_TEXT.question(mode)))?.trim().toLowerCase() ?? "";
    if (answer !== "j" && answer !== "ja") {
      deps.out(EINBINDEN_TEXT.aborted);
      return 1;
    }
  }

  // Sicherung, bevor irgendetwas geschrieben wird
  const backupDir = join(deps.projectRoot, BACKUP_DIR);
  const stamp = backupStamp(deps.now());
  let backup = join(backupDir, `${label}.${stamp}.plist`);
  for (let n = 2; deps.exists(backup); n++) backup = join(backupDir, `${label}.${stamp}-${n}.plist`);
  try {
    deps.mkdir(backupDir);
    deps.copyFile(path, backup);
  } catch (e) {
    return fail(deps, EINBINDEN_TEXT.backupFailed(describeError(e)));
  }
  const saved = await plistJson(deps, backup);
  if (!saved || !Bun.deepEquals(saved, plist)) return fail(deps, EINBINDEN_TEXT.backupFailed("Sicherung weicht ab"));

  // Neue Plist als Kopie im selben Ordner (rename bleibt atomar), nur ProgramArguments ersetzt
  const tmp = join(path, "..", `.${label}.plist.tybo-neu`);
  const discardTmp = () => {
    try {
      if (deps.exists(tmp)) deps.remove(tmp);
    } catch {
      // nichts weiter, die Kopie heißt nicht .plist und lädt nie
    }
  };
  const prepareFailed = (reason: string) => {
    discardTmp();
    return fail(deps, EINBINDEN_TEXT.prepareFailed(reason));
  };
  try {
    if (deps.exists(tmp)) deps.remove(tmp);
    deps.copyFile(path, tmp);
  } catch (e) {
    return prepareFailed(describeError(e));
  }
  const replaced = await deps.run(["plutil", "-replace", "ProgramArguments", "-json", JSON.stringify(plan.after), tmp]).catch(() => null);
  if (!replaced?.ok) return prepareFailed("plutil -replace gescheitert");
  const lint = await deps.run(["plutil", "-lint", tmp]).catch(() => null);
  if (!lint?.ok) return prepareFailed("plutil -lint meldet einen Fehler");
  const written = await plistJson(deps, tmp);
  if (!written || !Bun.deepEquals(written, plists.changed)) return prepareFailed("Inhalt weicht vom Plan ab");

  // Erneut prüfen, unmittelbar vor dem Eingriff: Während der Rückfrage kann ein Lauf begonnen haben oder der Dienst pausiert worden sein
  const blocked = await stateBlocks(deps, label);
  if (blocked) {
    discardTmp();
    return fail(deps, `${blocked} Sicherung: ${backup}`);
  }

  // Ab hier wird der laufende Dienst angefasst
  const out = await deps.run(["launchctl", "bootout", `gui/${deps.uid}/${label}`]).catch(() => null);
  if (!out?.ok) {
    discardTmp();
    const entry = await loadedEntry(deps, label);
    if (entry?.loaded) return fail(deps, `launchctl bootout ist gescheitert, nichts geändert (Dienst weiter geladen). Sicherung: ${backup}`);
    return restore(deps, label, path, tmp, backup, "launchctl bootout ist gescheitert.", plists);
  }
  try {
    deps.rename(tmp, path);
  } catch (e) {
    discardTmp();
    return restore(deps, label, path, tmp, backup, `Neue Plist nicht geschrieben (${describeError(e)}).`, plists);
  }
  if (!(await bootstrap(deps, path))) return restore(deps, label, path, tmp, backup, "launchctl bootstrap der neuen Plist ist gescheitert.", plists);
  const entry = await loadedEntry(deps, label);
  if (!entry?.loaded) return restore(deps, label, path, tmp, backup, "Nach dem Neuladen ist der Dienst nicht geladen.", plists);

  deps.out(EINBINDEN_TEXT.done(label, mode));
  deps.out(`Sicherung: ${backup}`);
  if (mode === "einbinden") deps.out(EINBINDEN_TEXT.doneHint);
  return 0;
}

/** Eine Zeile von stdin; null bei Eingabeende */
function askLine(question: string): Promise<string | null> {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    let answered = false;
    process.stdout.write(question);
    rl.once("line", line => {
      answered = true;
      rl.close();
      resolve(line);
    });
    rl.once("close", () => {
      if (!answered) resolve(null);
    });
  });
}

export function defaultWrapCommandDeps(projectRoot: string, env: Record<string, string | undefined> = process.env): WrapCommandDeps {
  const base = defaultRoutinesDeps(projectRoot, env);
  return {
    ...base,
    bunPath: Bun.which("bun") ?? (process.execPath.startsWith("/") ? process.execPath : null),
    lstat(path) {
      try {
        const s = lstatSync(path);
        return { symlink: s.isSymbolicLink(), file: s.isFile() };
      } catch {
        return null;
      }
    },
    exists: path => existsSync(path),
    copyFile: (src, dst) => copyFileSync(src, dst, fsConstants.COPYFILE_EXCL),
    rename: (src, dst) => renameSync(src, dst),
    remove: path => rmSync(path, { force: true }),
    mkdir: path => void mkdirSync(path, { recursive: true }),
    ask: askLine,
    sleep: ms => Bun.sleep(ms),
    out: line => console.log(line),
    err: line => console.error(line),
  };
}
