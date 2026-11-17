/**
 * Postenliste der Wartung (Issue #485): feste Liste, je Posten eine Prüfung
 * (plan), die Größe vorher und ein Löschbefehl je Ziel (remove), der vor dem
 * Löschen noch einmal prüft. Was nicht hier steht, fasst die Wartung nie an:
 * ~/Downloads, Projektordner, tmp/ im Projekt, der Homebrew-Cellar,
 * Ollama- und Sprachmodelle, ~/Library/Caches als Ganzes.
 *
 * Posten in dieser Reihenfolge:
 * 1. test-simulatoren (nur macOS): Geräte im Zustand Shutdown, deren Name
 *    auf ein Muster aus config/wartung.json passt und deren Geräteordner
 *    sich seit mindestens 12 Stunden nicht geändert hat (jüngste Zeit aus
 *    Ordner, device.plist, data/ und lastBootedAt). Ohne Muster: keine.
 *    Unbekanntes Alter, unklarer Bestand: nichts löschen. Vor `simctl
 *    delete` liest die Wartung den Bestand neu und löscht nur, wenn das
 *    Gerät noch da, ausgeschaltet, gleich benannt und nach dem neu gelesenen
 *    Stand weiterhin mindestens 12 Stunden unverändert ist.
 * 2. nicht-verfuegbare-simulatoren (nur macOS): `xcrun simctl delete
 *    unavailable`, ausdrücklich ohne Muster (Geräte, deren Laufzeit fehlt,
 *    lassen sich ohnehin nicht mehr starten). Posten 1 zählt diese Geräte
 *    nicht mit, damit nichts doppelt in der Summe steht.
 * 3. simulator-laufzeiten (nur macOS): Laufzeiten aus `simctl runtime list`,
 *    auf denen kein einziges Gerät steht. Nur melden; löschen nur mit
 *    "runtimesLoeschen": true und nur, wenn simctl sie als löschbar führt.
 *    Vor dem Löschen wird der Gerätebestand neu gelesen.
 * 4. caches: Inhalt der Caches aus der Positivliste (CACHE_IDS), Pfade je
 *    Plattform fest. Abgewiesen wird ein Cache, der eine Verknüpfung ist
 *    oder dessen echter Pfad aus dem Home-Ordner herausführt. Hat sich darin
 *    in der letzten Stunde etwas geändert, läuft vermutlich gerade ein Build:
 *    dann bleibt er diesmal stehen. Geprüft wird beim Planen und noch einmal
 *    unmittelbar vor dem Löschen; gelöscht werden nur Einträge, die schon
 *    beim Planen da waren. Der Ordner selbst bleibt, nur sein Inhalt geht.
 *    Gelöscht wird im geprüften Ordner selbst (inDir), nicht über seinen
 *    Pfad: wird der Pfad unterwegs umgeleitet, trifft nichts das neue Ziel.
 * 5. logs: Dateien `*.log` direkt unter logs/ über der Schwelle, nur
 *    einfache Dateien mit einem einzigen Namen (kein Hardlink). Die Dienste
 *    halten sie offen; Umbenennen oder Löschen gäbe den Platz erst nach
 *    einem Neustart frei. Deshalb: das Ende (logKeepBytes) als
 *    `<name>.log.1` sichern (ersetzt die vorige Sicherung), dann die Datei
 *    über ihren geöffneten Deskriptor auf 0 kürzen. Vorher prüft die Wartung,
 *    dass logs/ und die Datei noch dieselben wie beim Planen sind. Sichern,
 *    Aufräumen und Kürzen laufen im geprüften Ordner selbst (inDir). Die
 *    Dienste schreiben im Anhängemodus weiter, kein Neustart nötig.
 *
 * Verknüpfungen und Nicht-Ordner sind erwartbare Ablehnungen (Hinweis);
 * Zugriffsfehler wie EACCES oder ein scheiterndes realpath sind Fehler und
 * landen in Meldung, Zustand und Exit-Code.
 */

import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { matchesPattern, type CacheId, type MaintenanceConfig } from "./config";
import type { ServiceDeps } from "./services";

export interface CommandResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

/** Zugriffe nach außen; Dateien gehen über node:fs unter home und root */
export interface MaintenanceDeps {
  platform: NodeJS.Platform;
  home: string;
  /** Projektordner (logs/, data/, config/) */
  root: string;
  now(): number;
  /** Befehl ohne Shell; hier nur xcrun */
  run(cmd: string[]): Promise<CommandResult>;
  /** Freier Platz auf dem Laufwerk des Projektordners; null, wenn unbekannt */
  freeBytes(): Promise<number | null>;
  /** Sendet die Meldung (bun run notify); wirft bei Fehlschlag */
  notify(text: string): Promise<void>;
  /**
   * Löscht den Eintrag name im aktuellen Arbeitsordner, ohne Verknüpfungen
   * zu folgen; recursive samt Inhalt (Standard: rm bzw. rm -rf). Aufgerufen
   * nur innerhalb von inDir, name ist immer relativ.
   */
  removeEntry?(name: string, recursive: boolean): Promise<void>;
  /** Zugriffe für die Dienst-Versionen (Issue #486, services.ts); nötig, sobald config/wartung.json Dienste nennt */
  services?: ServiceDeps;
}

export interface ItemContext {
  deps: MaintenanceDeps;
  config: MaintenanceConfig;
}

/** Ergebnis eines remove: gelöscht, oder ein Grund, warum es nicht mehr passt */
export type RemoveOutcome = { removed: true } | { skipped: string };

export interface Target {
  label: string;
  /** Größe vorher; null, wenn unbekannt */
  bytes: number | null;
  /** nur melden, nie löschen */
  reportOnly?: boolean;
  remove(): Promise<RemoveOutcome>;
}

export interface ItemPlan {
  targets: Target[];
  /** Hinweise ohne Ziel (übersprungen, nicht eingerichtet) */
  notes: string[];
  /** Fehler einzelner Teile, die die übrigen Ziele des Postens nicht aufhalten */
  errors?: string[];
}

export interface MaintenanceItem {
  id: string;
  title: string;
  macOnly: boolean;
  /** Wirft, wenn der Bestand unklar ist; dann wird bei diesem Posten nichts gelöscht */
  plan(ctx: ItemContext): Promise<ItemPlan>;
}

/** Mindestalter eines Test-Simulators seit seiner letzten Änderung */
export const SIMULATOR_MIN_AGE_MS = 12 * 3600_000;
/** Ein Cache mit Änderungen in dieser Zeit gilt als in Benutzung */
export const CACHE_QUIET_MS = 3600_000;

const removed: RemoveOutcome = { removed: true };
const removeEntry = (deps: MaintenanceDeps, name: string, recursive: boolean) =>
  deps.removeEntry ? deps.removeEntry(name, recursive) : rm(name, { recursive, force: true });

// ---------------------------------------------------------------------------
// Belegter Platz

/** Belegter Platz (Blöcke) und jüngste Änderung, ohne Verknüpfungen zu folgen; wirft bei unlesbaren Ordnern */
export async function diskUsage(path: string): Promise<{ bytes: number; newestMs: number }> {
  const st = await lstat(path);
  let bytes = st.blocks !== undefined ? st.blocks * 512 : st.size;
  let newestMs = st.mtimeMs;
  if (st.isDirectory()) {
    for (const entry of await readdir(path)) {
      const sub = await diskUsage(join(path, entry));
      bytes += sub.bytes;
      newestMs = Math.max(newestMs, sub.newestMs);
    }
  }
  return { bytes, newestMs };
}

async function sizeOrNull(path: string): Promise<number | null> {
  try {
    return (await diskUsage(path)).bytes;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Simulatoren

export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
  /** Schlüssel der Laufzeit in simctl list devices */
  runtime: string;
  dataPath?: string;
  lastBootedAt?: string;
}

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

export class InventoryError extends Error {}

/** Ist simctl da? Ohne Xcode bzw. Kommandozeilenwerkzeuge gibt es keine Simulator-Posten */
async function hasSimctl(deps: MaintenanceDeps): Promise<boolean> {
  return (await deps.run(["xcrun", "--find", "simctl"])).ok;
}

const NO_SIMCTL = "Xcode-Simulatoren nicht installiert";

/** Bestand aus `xcrun simctl list devices --json`; wirft InventoryError bei jeder Unklarheit */
export function parseDevices(stdout: string): SimDevice[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new InventoryError("Gerätebestand nicht lesbar (kein JSON)");
  }
  const devices = (raw as { devices?: unknown })?.devices;
  if (!devices || typeof devices !== "object" || Array.isArray(devices)) throw new InventoryError("Gerätebestand ohne devices");
  const list: SimDevice[] = [];
  for (const [runtime, entries] of Object.entries(devices)) {
    if (!Array.isArray(entries)) throw new InventoryError("Gerätebestand unklar");
    for (const e of entries as Record<string, unknown>[]) {
      if (!e || typeof e.udid !== "string" || !UDID.test(e.udid) || typeof e.name !== "string" || typeof e.state !== "string" || typeof e.isAvailable !== "boolean") {
        throw new InventoryError("Gerätebestand mit unvollständigem Eintrag");
      }
      list.push({
        udid: e.udid,
        name: e.name,
        state: e.state,
        isAvailable: e.isAvailable,
        runtime,
        ...(typeof e.dataPath === "string" && { dataPath: e.dataPath }),
        ...(typeof e.lastBootedAt === "string" && { lastBootedAt: e.lastBootedAt }),
      });
    }
  }
  return list;
}

async function listDevices(deps: MaintenanceDeps): Promise<SimDevice[]> {
  const r = await deps.run(["xcrun", "simctl", "list", "devices", "--json"]);
  if (!r.ok) throw new InventoryError("Gerätebestand nicht abrufbar (simctl list devices)");
  return parseDevices(r.stdout);
}

/** Geräteordner, wenn dataPath die übliche Form <…>/<udid>/data hat */
function deviceDir(d: SimDevice): string | null {
  if (!d.dataPath || basename(d.dataPath) !== "data") return null;
  const dir = dirname(d.dataPath);
  return basename(dir) === d.udid ? dir : null;
}

/** Jüngste Änderung des Geräts; null, wenn sie sich nicht sicher feststellen lässt */
export async function deviceChangedMs(d: SimDevice): Promise<number | null> {
  const dir = deviceDir(d);
  if (!dir) return null;
  const times: number[] = [];
  for (const path of [dir, join(dir, "device.plist"), join(dir, "data")]) {
    try {
      times.push((await lstat(path)).mtimeMs);
    } catch {
      return null;
    }
  }
  if (d.lastBootedAt !== undefined) {
    const booted = Date.parse(d.lastBootedAt);
    if (Number.isNaN(booted)) return null;
    times.push(booted);
  }
  return Math.max(...times);
}

const testSimulators: MaintenanceItem = {
  id: "test-simulatoren",
  title: "Test-Simulatoren",
  macOnly: true,
  async plan({ deps, config }) {
    const patterns = config.simulatorPatterns;
    if (patterns.length === 0) return { targets: [], notes: ["kein Muster eingestellt (config/wartung.json, simulatorMuster)"] };
    if (!(await hasSimctl(deps))) return { targets: [], notes: [NO_SIMCTL] };
    const devices = await listDevices(deps);
    const notes: string[] = [];
    const targets: Target[] = [];
    for (const d of devices) {
      // Nicht verfügbare Geräte räumt der nächste Posten ab, laufende bleiben immer
      if (!d.isAvailable || d.state !== "Shutdown" || !matchesPattern(d.name, patterns)) continue;
      const changed = await deviceChangedMs(d);
      if (changed === null) {
        notes.push(`${d.name}: Alter unbekannt, bleibt`);
        continue;
      }
      if (deps.now() - changed < SIMULATOR_MIN_AGE_MS) continue;
      const dir = deviceDir(d)!;
      targets.push({
        label: d.name,
        bytes: await sizeOrNull(dir),
        async remove() {
          const now = (await listDevices(deps)).find(x => x.udid === d.udid);
          if (!now) return { skipped: "schon weg" };
          if (now.state !== "Shutdown") return { skipped: `inzwischen ${now.state}` };
          if (!now.isAvailable || now.name !== d.name || !matchesPattern(now.name, patterns)) return { skipped: "Bestand geändert" };
          // Seit dem Planen gestartet und wieder ausgeschaltet? Alter am neu gelesenen Gerät
          const changedNow = await deviceChangedMs(now);
          if (changedNow === null) return { skipped: "Alter unbekannt" };
          if (deps.now() - changedNow < SIMULATOR_MIN_AGE_MS) return { skipped: "inzwischen benutzt" };
          const r = await deps.run(["xcrun", "simctl", "delete", d.udid]);
          if (!r.ok) throw new Error(`simctl delete scheiterte (Exit ${r.code})`);
          return removed;
        },
      });
    }
    return { targets, notes };
  },
};

const unavailableSimulators: MaintenanceItem = {
  id: "nicht-verfuegbare-simulatoren",
  title: "Nicht verfügbare Simulatoren",
  macOnly: true,
  async plan({ deps }) {
    if (!(await hasSimctl(deps))) return { targets: [], notes: [NO_SIMCTL] };
    const unavailable = (await listDevices(deps)).filter(d => !d.isAvailable);
    if (unavailable.length === 0) return { targets: [], notes: [] };
    if (unavailable.some(d => d.state !== "Shutdown")) return { targets: [], notes: ["ein nicht verfügbares Gerät ist nicht ausgeschaltet, diesmal nichts gelöscht"] };
    let bytes: number | null = 0;
    for (const d of unavailable) {
      const dir = deviceDir(d);
      const size = dir ? await sizeOrNull(dir) : null;
      bytes = bytes === null || size === null ? null : bytes + size;
    }
    const n = unavailable.length;
    return {
      notes: [],
      targets: [
        {
          label: `${n} ${n === 1 ? "Gerät" : "Geräte"}`,
          bytes,
          async remove() {
            const now = (await listDevices(deps)).filter(d => !d.isAvailable);
            if (now.length === 0) return { skipped: "schon weg" };
            if (now.some(d => d.state !== "Shutdown")) return { skipped: "ein Gerät ist nicht mehr ausgeschaltet" };
            const r = await deps.run(["xcrun", "simctl", "delete", "unavailable"]);
            if (!r.ok) throw new Error(`simctl delete unavailable scheiterte (Exit ${r.code})`);
            return removed;
          },
        },
      ],
    };
  },
};

export interface SimRuntime {
  /** Kennung für simctl runtime delete */
  identifier: string;
  /** Schlüssel in simctl list devices */
  runtimeIdentifier: string;
  label: string;
  bytes: number | null;
  deletable: boolean;
}

/** Bestand aus `xcrun simctl runtime list -j`; wirft InventoryError bei jeder Unklarheit */
export function parseRuntimes(stdout: string): SimRuntime[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new InventoryError("Laufzeiten nicht lesbar (kein JSON)");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new InventoryError("Laufzeiten unklar");
  return Object.values(raw as Record<string, Record<string, unknown>>).map(e => {
    if (!e || typeof e.identifier !== "string" || !UDID.test(e.identifier) || typeof e.runtimeIdentifier !== "string") throw new InventoryError("Laufzeit mit unvollständigem Eintrag");
    const platform = typeof e.platformIdentifier === "string" ? e.platformIdentifier.replace(/^com\.apple\.platform\./, "") : "";
    const version = typeof e.version === "string" ? e.version : "";
    return {
      identifier: e.identifier,
      runtimeIdentifier: e.runtimeIdentifier,
      label: [platform, version].filter(Boolean).join(" ") || e.runtimeIdentifier.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, ""),
      bytes: typeof e.sizeBytes === "number" && e.sizeBytes >= 0 ? e.sizeBytes : null,
      deletable: e.deletable === true,
    };
  });
}

const unusedRuntimes: MaintenanceItem = {
  id: "simulator-laufzeiten",
  title: "Simulator-Laufzeiten ohne Gerät",
  macOnly: true,
  async plan({ deps, config }) {
    if (!(await hasSimctl(deps))) return { targets: [], notes: [NO_SIMCTL] };
    const r = await deps.run(["xcrun", "simctl", "runtime", "list", "-j"]);
    if (!r.ok) throw new InventoryError("Laufzeiten nicht abrufbar (simctl runtime list)");
    const runtimes = parseRuntimes(r.stdout);
    const used = new Set((await listDevices(deps)).map(d => d.runtime));
    const targets = runtimes
      .filter(rt => !used.has(rt.runtimeIdentifier))
      .map(
        (rt): Target => ({
          label: rt.label,
          bytes: rt.bytes,
          reportOnly: !config.deleteRuntimes || !rt.deletable,
          async remove() {
            const devices = await listDevices(deps);
            if (devices.some(d => d.runtime === rt.runtimeIdentifier)) return { skipped: "inzwischen mit Gerät" };
            const del = await deps.run(["xcrun", "simctl", "runtime", "delete", rt.identifier]);
            if (!del.ok) throw new Error(`simctl runtime delete scheiterte (Exit ${del.code})`);
            return removed;
          },
        }),
      );
    const notes: string[] = [];
    if (!config.deleteRuntimes && targets.length > 0) notes.push("nur gemeldet; löschen mit \"runtimesLoeschen\": true in config/wartung.json");
    if (config.deleteRuntimes && targets.some(t => t.reportOnly)) notes.push("nicht löschbare Laufzeiten nur gemeldet");
    return { targets, notes };
  },
};

// ---------------------------------------------------------------------------
// Caches und Logs

const CACHE_LABELS: Record<CacheId, string> = {
  "homebrew-downloads": "Homebrew-Downloads",
  "go-build": "go-build",
  pip: "pip",
  "node-gyp": "node-gyp",
  npm: "npm",
  bun: "bun",
};

/** Pfad eines Caches relativ zum Home-Ordner, je Plattform fest */
export function cacheRelativePath(id: CacheId, platform: NodeJS.Platform): string {
  const base = platform === "darwin" ? join("Library", "Caches") : ".cache";
  switch (id) {
    case "homebrew-downloads":
      return join(base, "Homebrew", "downloads");
    case "go-build":
      return join(base, "go-build");
    case "pip":
      return join(base, "pip");
    case "node-gyp":
      return join(base, "node-gyp");
    case "npm":
      return join(".npm", "_cacache");
    case "bun":
      return join(".bun", "install", "cache");
  }
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code ?? "Fehler";

export type SafeDir =
  | { path: string; dev: number; ino: number }
  | "missing"
  /** erwartbare Schutzablehnung (Verknüpfung, kein Ordner): Hinweis */
  | { refused: string }
  /** echter Zugriffsfehler (EACCES, realpath scheitert): Fehler */
  | { error: string };

/**
 * Ordner base/rel, wenn er ein echter Ordner ist und sein echter Pfad genau
 * unter dem echten base liegt (keine Verknüpfung unterwegs), mit seiner
 * Identität (dev, ino); "missing", wenn es ihn nicht gibt. Verknüpfungen
 * und Nicht-Ordner werden abgewiesen (refused), Zugriffsfehler sind Fehler.
 */
export async function safeDir(base: string, rel: string): Promise<SafeDir> {
  const path = join(base, rel);
  let st;
  try {
    st = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    return { error: `nicht lesbar (${errorCode(error)})` };
  }
  if (st.isSymbolicLink()) return { refused: "ist eine Verknüpfung, bleibt" };
  if (!st.isDirectory()) return { refused: "kein Ordner, bleibt" };
  let real: string;
  let realBase: string;
  try {
    real = await realpath(path);
    realBase = await realpath(base);
  } catch (error) {
    return { error: `Pfad nicht auflösbar (${errorCode(error)})` };
  }
  if (real !== join(realBase, rel)) return { refused: "Pfad führt über eine Verknüpfung woanders hin, bleibt" };
  return { path, dev: st.dev, ino: st.ino };
}

interface FileId {
  dev: number;
  ino: number;
}

const sameId = (a: FileId, b: FileId) => a.dev === b.dev && a.ino === b.ino;

/** safeDir noch einmal, unmittelbar vor einer Änderung: derselbe Ordner wie beim Planen? */
async function sameDir(base: string, rel: string, planned: FileId): Promise<{ path: string } | RemoveOutcome> {
  const again = await safeDir(base, rel);
  if (again === "missing") return { skipped: "schon weg" };
  if ("refused" in again) return { skipped: again.refused };
  if ("error" in again) throw new Error(again.error);
  if (again.dev !== planned.dev || again.ino !== planned.ino) return { skipped: "Ordner inzwischen ausgetauscht, bleibt" };
  return { path: again.path };
}

/** Der Arbeitsordner gilt für den ganzen Prozess: inDir läuft nie parallel */
let cwdQueue: Promise<unknown> = Promise.resolve();

/**
 * fn im geprüften Ordner base/rel ausführen: erst sameDir, dann in den
 * Ordner wechseln und prüfen, dass "." genau der geplante ist (dev, ino).
 * Der Arbeitsordner hängt am Ordner selbst, nicht an seinem Pfad: wird der
 * Pfad danach umbenannt oder durch eine Verknüpfung ersetzt, treffen
 * relative Namen weiter den geprüften Ordner. fn arbeitet deshalb nur mit
 * Namen relativ zu ".". Danach zurück in den vorigen Arbeitsordner.
 * Gedacht für die Wartung als eigener Prozess (src/maintenance.ts, tybo
 * wartung), nie für den Bot.
 */
async function inDir(base: string, rel: string, planned: FileId, fn: () => Promise<RemoveOutcome>): Promise<RemoveOutcome> {
  const task = cwdQueue.then(async (): Promise<RemoveOutcome> => {
    const again = await sameDir(base, rel, planned);
    if (!("path" in again)) return again;
    const previous = process.cwd();
    try {
      process.chdir(again.path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { skipped: "schon weg" };
      if (errorCode(error) === "ENOTDIR") return { skipped: "kein Ordner, bleibt" };
      throw error;
    }
    try {
      // chdir folgt Verknüpfungen: erst hier steht fest, wo wir sind
      if (!sameId(await lstat("."), planned)) return { skipped: "Ordner inzwischen ausgetauscht, bleibt" };
      return await fn();
    } finally {
      process.chdir(previous);
    }
  });
  cwdQueue = task.catch(() => {});
  return task;
}

const caches: MaintenanceItem = {
  id: "caches",
  title: "Caches",
  macOnly: false,
  async plan({ deps, config }) {
    const targets: Target[] = [];
    const notes: string[] = [];
    const errors: string[] = [];
    for (const id of config.caches) {
      const rel = cacheRelativePath(id, deps.platform);
      const label = CACHE_LABELS[id];
      const dir = await safeDir(deps.home, rel);
      if (dir === "missing") continue;
      if ("refused" in dir) {
        notes.push(`${label}: ${dir.refused}`);
        continue;
      }
      if ("error" in dir) {
        errors.push(`${label}: ${dir.error}, nichts gelöscht`);
        continue;
      }
      let usage: { bytes: number; newestMs: number };
      let ownBlocks: number;
      let entries: string[];
      try {
        entries = await readdir(dir.path);
        if (entries.length === 0) continue;
        usage = await diskUsage(dir.path);
        // Nur der Inhalt zählt, der Ordner bleibt
        ownBlocks = await lstat(dir.path).then(st => (st.blocks !== undefined ? st.blocks * 512 : st.size));
      } catch (error) {
        errors.push(`${label}: nicht lesbar (${(error as NodeJS.ErrnoException).code ?? "Fehler"}), nichts gelöscht`);
        continue;
      }
      if (deps.now() - usage.newestMs < CACHE_QUIET_MS) {
        notes.push(`${label}: in der letzten Stunde benutzt, bleibt diesmal`);
        continue;
      }
      const planned = new Set(entries);
      targets.push({
        label,
        bytes: Math.max(0, usage.bytes - ownBlocks),
        remove: () =>
          inDir(deps.home, rel, dir, async () => {
            // Seit dem Planen benutzt (etwa ein Build): diesmal stehen lassen
            if (deps.now() - (await diskUsage(".")).newestMs < CACHE_QUIET_MS) return { skipped: "inzwischen benutzt, bleibt diesmal" };
            // Nur, was beim Planen schon da war; Namen relativ zum geprüften Ordner
            for (const entry of await readdir(".")) if (planned.has(entry)) await removeEntry(deps, entry, true);
            return removed;
          }),
      });
    }
    return { targets, notes, errors };
  },
};

/**
 * Logdatei kürzen: Ende als <name>.1 sichern (ersetzt die vorige), dann auf
 * 0 kürzen. Alles läuft im geprüften logs/ (inDir) mit Namen relativ dazu:
 * Sicherung, Aufräumen der .tmp und Umbenennen treffen nie einen Ordner, auf
 * den logs/ unterwegs umgeleitet wurde. Geöffnet wird ohne Verknüpfungen zu
 * folgen (O_NOFOLLOW), gekürzt über den geöffneten Deskriptor. Vorher muss
 * der Deskriptor genau die geplante Datei sein (dev, ino), eine einfache
 * Datei mit nur einem Namen (kein Hardlink), und logs/ muss noch derselbe
 * Ordner sein; sonst bleibt alles, wie es ist.
 */
function rotateLog(deps: MaintenanceDeps, logDir: FileId, name: string, planned: FileId, config: MaintenanceConfig): Promise<RemoveOutcome> {
  return inDir(deps.root, "logs", logDir, () => rotateLogHere(deps, logDir, name, planned, config));
}

async function rotateLogHere(deps: MaintenanceDeps, logDir: FileId, name: string, planned: FileId, config: MaintenanceConfig): Promise<RemoveOutcome> {
  let handle: FileHandle;
  try {
    handle = await open(name, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { skipped: "keine Datei mehr" };
    if (code === "ELOOP") return { skipped: "inzwischen eine Verknüpfung, bleibt" };
    throw error;
  }
  try {
    // Gilt der Deskriptor noch? Geprüft vor jeder Änderung
    const check = async (): Promise<RemoveOutcome | null> => {
      const st = await handle.stat();
      if (!st.isFile()) return { skipped: "keine Datei mehr" };
      if (!sameId(st, planned)) return { skipped: "Datei inzwischen ausgetauscht, bleibt" };
      if (st.nlink !== 1) return { skipped: "hat mehrere Namen (Hardlink), bleibt" };
      const named = await lstat(name).catch(() => null);
      if (!named || !sameId(named, planned)) return { skipped: "Datei inzwischen ausgetauscht, bleibt" };
      const dir = await sameDir(deps.root, "logs", logDir);
      return "path" in dir ? null : dir;
    };
    const first = await check();
    if (first) return first;
    const size = (await handle.stat()).size;
    if (size <= config.logMaxBytes) return { skipped: "inzwischen kleiner" };
    const keep = Math.min(config.logKeepBytes, size);
    const tail = Buffer.alloc(keep);
    if (keep > 0) await handle.read(tail, 0, keep, size - keep);
    const backup = `${name}.1`;
    const temp = `${backup}.tmp`;
    // Relativ zum geprüften logs/; rm und rename treffen nur den Eintrag, nie das Ziel einer Verknüpfung
    await removeEntry(deps, temp, false);
    // wx: legt neu an und folgt keiner Verknüpfung
    const out = await open(temp, "wx");
    try {
      await out.write(tail);
    } finally {
      await out.close();
    }
    const second = await check();
    if (second) {
      await removeEntry(deps, temp, false);
      return second;
    }
    await rename(temp, backup);
    const third = await check();
    if (third) return third;
    await handle.truncate(0);
    return removed;
  } finally {
    await handle.close();
  }
}

const logs: MaintenanceItem = {
  id: "logs",
  title: "Logs",
  macOnly: false,
  async plan({ deps, config }) {
    const dir = await safeDir(deps.root, "logs");
    if (dir === "missing") return { targets: [], notes: [] };
    if ("refused" in dir) return { targets: [], notes: [`logs/: ${dir.refused}`] };
    if ("error" in dir) return { targets: [], notes: [], errors: [`logs/: ${dir.error}, nichts gekürzt`] };
    const targets: Target[] = [];
    const notes: string[] = [];
    const errors: string[] = [];
    for (const name of (await readdir(dir.path)).sort()) {
      if (!name.endsWith(".log")) continue;
      let st;
      try {
        st = await lstat(join(dir.path, name));
      } catch (error) {
        if (errorCode(error) !== "ENOENT") errors.push(`${name}: nicht lesbar (${errorCode(error)})`);
        continue;
      }
      if (!st.isFile() || st.size <= config.logMaxBytes) continue;
      if (st.nlink !== 1) {
        notes.push(`${name}: hat mehrere Namen (Hardlink), bleibt`);
        continue;
      }
      const id: FileId = { dev: st.dev, ino: st.ino };
      targets.push({
        label: name,
        bytes: st.size - Math.min(config.logKeepBytes, st.size),
        remove: () => rotateLog(deps, dir, name, id, config),
      });
    }
    return { targets, notes, errors };
  },
};

/** Alle Posten, in der Reihenfolge der Wartung */
export const MAINTENANCE_ITEMS: readonly MaintenanceItem[] = [testSimulators, unavailableSimulators, unusedRuntimes, caches, logs];

/** Posten dieser Plattform: unter Linux ohne die Xcode-Posten */
export function itemsFor(platform: NodeJS.Platform, items: readonly MaintenanceItem[] = MAINTENANCE_ITEMS): MaintenanceItem[] {
  return items.filter(item => platform === "darwin" || !item.macOnly);
}
