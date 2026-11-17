/**
 * Einstellungen der Wartung (Issue #485) aus config/wartung.json, Vorlage
 * config/wartung.example.json. Die Datei ist nicht im Repo; fehlt sie, gelten
 * die Standards (kein Simulator-Muster, Laufzeiten nur melden, alle Caches
 * der Positivliste, Logs ab 50 MB kürzen).
 *
 * Die Datei kann nur auswählen, nie erweitern: Caches stehen als feste
 * Kennungen aus CACHE_IDS darin (die Pfade legt items.ts je Plattform fest),
 * beliebige Pfade oder Befehle gibt es nicht. Ist die Datei da, aber
 * ungültig (kaputtes JSON, unbekannter Schlüssel, unbekannte Cache-Kennung,
 * zu breites Muster), bricht die Wartung ab, ohne etwas anzufassen: lieber
 * einmal nicht aufräumen als etwas anderes, als der Nutzer meinte.
 *
 * "dienste" (Issue #486) nennt Dienste, deren laufende Version die Wartung
 * und `bun run updates --apply` mit der installierten vergleichen
 * (src/lib/maintenance/services.ts). Fehlt der Schlüssel, wird kein Dienst
 * angefasst. Je Eintrag genau ein Dienstmanager mit exaktem Ziel (launchd
 * ai.tybo.*, systemd tybo-*.service, PM2 tybo-*: dieselbe Regel wie
 * service-names.ts, fremde Dienste fasst tybo nicht an), der Versionsbefehl
 * als Argumentliste ohne Shell und genau ein Weg zur laufenden Version:
 * eine Metrik auf diesem Rechner (http://127.0.0.1, localhost oder [::1])
 * oder die Binärdatei für den Zeitstempel-Ersatz.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LAUNCHD_PREFIX, PM2_PREFIX } from "../service-names";

/** Positivliste der Download- und Build-Caches; Pfade in items.ts */
export const CACHE_IDS = ["homebrew-downloads", "go-build", "pip", "node-gyp", "npm", "bun"] as const;
export type CacheId = (typeof CACHE_IDS)[number];

export const MAINTENANCE_CONFIG_FILE = join("config", "wartung.json");

export interface MaintenanceConfig {
  /** Namensmuster für Test-Simulatoren, `*` und `?` als Platzhalter; leer: keine */
  simulatorPatterns: string[];
  /** Simulator-Laufzeiten ohne Gerät löschen statt nur melden */
  deleteRuntimes: boolean;
  /** Caches aus CACHE_IDS, die geleert werden */
  caches: CacheId[];
  /** Logs unter logs/: ab dieser Größe kürzen */
  logMaxBytes: number;
  /** so viele Bytes vom Ende bleiben als <name>.log.1 */
  logKeepBytes: number;
  /** überwachte Dienste (Issue #486); leer: keine Dienstaktionen */
  services: WatchedService[];
}

export type ServiceManager = "launchd" | "systemd" | "pm2";
export const SERVICE_MANAGERS: readonly ServiceManager[] = ["launchd", "systemd", "pm2"];

/** Woher die laufende Version kommt */
export type RunningSource =
  /** Prometheus-Text, Zeile <metric>{…,<label>="1.2.3",…} */
  | { kind: "metric"; url: string; metric: string; label: string }
  /** Ersatz: Prozess des Diensts gegen diese Binärdatei (Pfad, Symlink-Ziel, Änderungszeit) */
  | { kind: "binary"; path: string };

export interface WatchedService {
  name: string;
  manager: ServiceManager;
  /** exaktes Ziel: launchd-Label, systemd-Unit (mit .service) oder PM2-Name */
  target: string;
  /** Befehl für die installierte Version, ohne Shell */
  versionCommand: string[];
  running: RunningSource;
  /** so lange wartet die Nachprüfung nach einem Neustart höchstens */
  waitMs: number;
}

const MB = 1024 * 1024;

export const DEFAULT_CONFIG: MaintenanceConfig = {
  simulatorPatterns: [],
  deleteRuntimes: false,
  caches: [...CACHE_IDS],
  logMaxBytes: 50 * MB,
  logKeepBytes: 5 * MB,
  services: [],
};

/** Standard für wartezeitSek */
export const SERVICE_WAIT_DEFAULT_S = 60;

/** Frische Kopie der Standards */
export function defaultMaintenanceConfig(): MaintenanceConfig {
  return { ...DEFAULT_CONFIG, caches: [...DEFAULT_CONFIG.caches], services: [] };
}

/** Mindestzahl fester Zeichen in einem Muster, damit `*` allein nie alle Geräte trifft */
export const PATTERN_MIN_LITERALS = 3;
const PATTERN_ALLOWED = /^[\p{L}\p{N} ._()\-*?]+$/u;

export class MaintenanceConfigError extends Error {}

const KEYS = new Set(["simulatorMuster", "runtimesLoeschen", "caches", "logs", "dienste"]);
const SERVICE_KEYS = new Set(["name", "launchd", "systemd", "pm2", "versionBefehl", "metrik", "binaer", "wartezeitSek"]);
const METRIC_KEYS = new Set(["url", "name", "label"]);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TARGET_PATTERN: Record<ServiceManager, RegExp> = {
  launchd: new RegExp(`^${escape(LAUNCHD_PREFIX)}[A-Za-z0-9._-]+$`),
  systemd: new RegExp(`^${escape(PM2_PREFIX)}[A-Za-z0-9@._-]+\\.service$`),
  pm2: new RegExp(`^${escape(PM2_PREFIX)}[A-Za-z0-9._-]+$`),
};
const TARGET_EXAMPLE: Record<ServiceManager, string> = { launchd: `${LAUNCHD_PREFIX}<dienst>`, systemd: `${PM2_PREFIX}<dienst>.service`, pm2: `${PM2_PREFIX}<dienst>` };
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const LOG_KEYS = new Set(["abMb", "behaltenMb"]);

function checkPattern(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new MaintenanceConfigError("simulatorMuster: nur nicht leere Texte");
  if (value.length > 100) throw new MaintenanceConfigError("simulatorMuster: Muster länger als 100 Zeichen");
  if (!PATTERN_ALLOWED.test(value)) throw new MaintenanceConfigError(`simulatorMuster: unerlaubtes Zeichen in „${value}“ (erlaubt: Buchstaben, Ziffern, Leerzeichen, . _ - ( ), * und ?)`);
  if (value.replace(/[*?]/g, "").length < PATTERN_MIN_LITERALS) throw new MaintenanceConfigError(`simulatorMuster: „${value}“ ist zu breit, mindestens ${PATTERN_MIN_LITERALS} feste Zeichen`);
  return value;
}

function megabytes(value: unknown, key: string, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > 100_000) throw new MaintenanceConfigError(`logs.${key}: Zahl von ${min} bis 100000 erwartet`);
  return Math.round(value * MB);
}

function parseMetric(value: unknown, where: string): RunningSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MaintenanceConfigError(`${where}.metrik: Objekt erwartet`);
  const m = value as Record<string, unknown>;
  for (const key of Object.keys(m)) if (!METRIC_KEYS.has(key)) throw new MaintenanceConfigError(`${where}.metrik: unbekannter Schlüssel ${key}`);
  if (typeof m.url !== "string") throw new MaintenanceConfigError(`${where}.metrik.url fehlt`);
  let url: URL;
  try {
    url = new URL(m.url);
  } catch {
    throw new MaintenanceConfigError(`${where}.metrik.url ist keine Adresse`);
  }
  if (url.protocol !== "http:" || !LOCAL_HOSTS.has(url.hostname) || url.username || url.password) {
    throw new MaintenanceConfigError(`${where}.metrik.url: nur http://127.0.0.1, http://localhost oder http://[::1] auf diesem Rechner`);
  }
  const metric = m.name ?? "build_info";
  const label = m.label ?? "version";
  if (typeof metric !== "string" || !/^[A-Za-z_:][A-Za-z0-9_:]*$/.test(metric)) throw new MaintenanceConfigError(`${where}.metrik.name: Name einer Metrik erwartet`);
  if (typeof label !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(label)) throw new MaintenanceConfigError(`${where}.metrik.label: Name eines Labels erwartet`);
  return { kind: "metric", url: url.toString(), metric, label };
}

function parseService(value: unknown, index: number): WatchedService {
  const where = `dienste[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MaintenanceConfigError(`${where}: Objekt erwartet`);
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!SERVICE_KEYS.has(key) && !key.startsWith("_")) throw new MaintenanceConfigError(`${where}: unbekannter Schlüssel ${key}`);
  }
  const managers = SERVICE_MANAGERS.filter(m => obj[m] !== undefined);
  if (managers.length !== 1) throw new MaintenanceConfigError(`${where}: genau einer von launchd, systemd oder pm2`);
  const manager = managers[0];
  const target = obj[manager];
  if (typeof target !== "string" || !TARGET_PATTERN[manager].test(target)) {
    throw new MaintenanceConfigError(`${where}.${manager}: „${String(target)}“ passt nicht, erwartet ${TARGET_EXAMPLE[manager]}`);
  }
  const name = obj.name ?? target;
  if (typeof name !== "string" || name.trim() === "" || name.length > 60) throw new MaintenanceConfigError(`${where}.name: Text bis 60 Zeichen`);
  const cmd = obj.versionBefehl;
  if (!Array.isArray(cmd) || cmd.length === 0 || cmd.length > 10 || cmd.some(a => typeof a !== "string" || a === "" || a.length > 200 || a.includes("\0"))) {
    throw new MaintenanceConfigError(`${where}.versionBefehl: Liste mit 1 bis 10 Argumenten, etwa ["cloudflared", "--version"]`);
  }
  const sources = (["metrik", "binaer"] as const).filter(k => obj[k] !== undefined);
  if (sources.length !== 1) throw new MaintenanceConfigError(`${where}: genau einer von metrik oder binaer`);
  let running: RunningSource;
  if (sources[0] === "metrik") running = parseMetric(obj.metrik, where);
  else {
    const path = obj.binaer;
    if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0") || path.length > 500) throw new MaintenanceConfigError(`${where}.binaer: absoluter Pfad erwartet`);
    running = { kind: "binary", path };
  }
  let waitS = SERVICE_WAIT_DEFAULT_S;
  if (obj.wartezeitSek !== undefined) {
    if (typeof obj.wartezeitSek !== "number" || !Number.isInteger(obj.wartezeitSek) || obj.wartezeitSek < 5 || obj.wartezeitSek > 300) {
      throw new MaintenanceConfigError(`${where}.wartezeitSek: ganze Zahl von 5 bis 300`);
    }
    waitS = obj.wartezeitSek;
  }
  return { name: name.trim(), manager, target, versionCommand: [...(cmd as string[])], running, waitMs: waitS * 1000 };
}

/** Prüft die Liste "dienste"; wirft MaintenanceConfigError */
export function parseServices(value: unknown): WatchedService[] {
  if (!Array.isArray(value)) throw new MaintenanceConfigError("dienste: Liste erwartet");
  if (value.length > 20) throw new MaintenanceConfigError("dienste: höchstens 20 Einträge");
  const services = value.map(parseService);
  const seen = new Set<string>();
  for (const s of services) {
    const key = `${s.manager}:${s.target}`;
    if (seen.has(key)) throw new MaintenanceConfigError(`dienste: ${s.target} steht doppelt in der Liste`);
    seen.add(key);
  }
  return services;
}

/** Prüft den Inhalt von config/wartung.json; wirft MaintenanceConfigError */
export function parseMaintenanceConfig(raw: unknown): MaintenanceConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new MaintenanceConfigError("config/wartung.json muss ein Objekt sein");
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KEYS.has(key) && !key.startsWith("_")) throw new MaintenanceConfigError(`unbekannter Schlüssel: ${key}`);
  }
  const config = defaultMaintenanceConfig();

  if (obj.simulatorMuster !== undefined) {
    if (!Array.isArray(obj.simulatorMuster)) throw new MaintenanceConfigError("simulatorMuster: Liste erwartet");
    config.simulatorPatterns = obj.simulatorMuster.map(checkPattern);
  }
  if (obj.runtimesLoeschen !== undefined) {
    if (typeof obj.runtimesLoeschen !== "boolean") throw new MaintenanceConfigError("runtimesLoeschen: true oder false");
    config.deleteRuntimes = obj.runtimesLoeschen;
  }
  if (obj.caches !== undefined) {
    if (!Array.isArray(obj.caches)) throw new MaintenanceConfigError("caches: Liste erwartet");
    const chosen: CacheId[] = [];
    for (const id of obj.caches) {
      if (typeof id !== "string" || !(CACHE_IDS as readonly string[]).includes(id)) {
        throw new MaintenanceConfigError(`caches: „${String(id)}“ ist keine bekannte Kennung (möglich: ${CACHE_IDS.join(", ")})`);
      }
      if (!chosen.includes(id as CacheId)) chosen.push(id as CacheId);
    }
    config.caches = chosen;
  }
  if (obj.logs !== undefined) {
    if (!obj.logs || typeof obj.logs !== "object" || Array.isArray(obj.logs)) throw new MaintenanceConfigError("logs: Objekt erwartet");
    const logs = obj.logs as Record<string, unknown>;
    for (const key of Object.keys(logs)) if (!LOG_KEYS.has(key)) throw new MaintenanceConfigError(`logs: unbekannter Schlüssel ${key}`);
    if (logs.abMb !== undefined) config.logMaxBytes = megabytes(logs.abMb, "abMb", 1);
    if (logs.behaltenMb !== undefined) config.logKeepBytes = megabytes(logs.behaltenMb, "behaltenMb", 0);
    if (config.logKeepBytes >= config.logMaxBytes) throw new MaintenanceConfigError("logs: behaltenMb muss kleiner als abMb sein");
  }
  if (obj.dienste !== undefined) config.services = parseServices(obj.dienste);
  return config;
}

/** Liest config/wartung.json unter root; fehlt sie, die Standards */
export async function loadMaintenanceConfig(root: string): Promise<MaintenanceConfig> {
  let text: string;
  try {
    text = await readFile(join(root, MAINTENANCE_CONFIG_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultMaintenanceConfig();
    throw new MaintenanceConfigError(`config/wartung.json nicht lesbar: ${(error as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new MaintenanceConfigError("config/wartung.json ist kein gültiges JSON");
  }
  return parseMaintenanceConfig(raw);
}

/** Passt der Gerätename vollständig auf eines der Muster? `*` beliebig viele, `?` genau ein Zeichen */
export function matchesPattern(name: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => {
    const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(`^${source}$`, "su").test(name);
  });
}
