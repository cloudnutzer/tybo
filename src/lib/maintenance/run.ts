/**
 * Ablauf der Wartung (Issue #485): Posten aus items.ts nacheinander prüfen
 * und abräumen, Meldung schicken, Ergebnis in data/wartung.json festhalten.
 *
 *   tybo wartung              aufräumen, melden, Ergebnis festhalten
 *   tybo wartung --dry-run    nur zeigen, was gelöscht würde, mit Größen
 *
 * Der Probelauf löscht nichts, kürzt keine Logs, sendet nichts, nimmt keine
 * Sperre und schreibt keine Datei; data/wartung.json behält das letzte echte
 * Ergebnis.
 *
 * Ein Fehler bei einem Posten (Bestand unklar, Löschen scheitert) bricht den
 * Lauf nicht ab: die übrigen Posten laufen weiter, der Fehler steht in
 * Meldung und Zustand, der Exit-Code ist am Ende 1. Ebenso, wenn die Meldung
 * nicht rausgeht oder die Zustandsdatei nicht geschrieben werden kann. Eine
 * ungültige config/wartung.json hält den Lauf vor dem ersten Posten an.
 *
 * Eine Sperre (data/wartung.lock über file-lock.ts: atomar veröffentlicht,
 * mit Besitzerkennung) verhindert, dass geplante und manuelle Wartung
 * gleichzeitig laufen; eine liegengebliebene Sperre eines beendeten
 * Prozesses wird übernommen, entfernt wird nur die eigene. Ein echter Lauf
 * nimmt die Sperre vor allem anderen, auch vor dem Lesen der Konfiguration:
 * ohne Sperre gibt es weder Meldung noch Zustand.
 *
 * Zwei Messwerte: die Größe der Posten (Summe dessen, was vorher belegt war)
 * und der freie Platz vorher und nachher. Sie weichen voneinander ab (APFS,
 * Schnappschüsse, andere Programme schreiben gleichzeitig).
 *
 * Nach den Posten prüft die Wartung die Dienste aus "dienste" in
 * config/wartung.json (Issue #486, services.ts): läuft einer älter als
 * installiert, startet sie ihn neu und prüft nach; im Probelauf nur, was
 * neu gestartet würde. Ohne Liste wird kein Dienst angefasst. Ein Fehler
 * dabei steht in Meldung und Zustand (services) und ergibt Exit 1.
 *
 * Zustandsformat für den Nachtcheck (W3-3), MaintenanceState: version 1,
 * lastRun mit Beginn, Ende, Status ("ok" oder "fehler"), freiem Platz vorher
 * und nachher, je Posten Status, Anzahl, Bytes, Hinweise und Fehler, dazu
 * Abbruchgrund (error) und Versand der Meldung (notify). Geschrieben wird
 * atomar (temporäre Datei, dann umbenennen).
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../atomic-file";
import { releaseFileLock, tryAcquireFileLock, type FileLockOptions, type LockOwner } from "../file-lock";
import { BRAND } from "../../brand";
import { loadMaintenanceConfig, MaintenanceConfigError, type MaintenanceConfig } from "./config";
import { itemsFor, MAINTENANCE_ITEMS, type MaintenanceDeps, type MaintenanceItem } from "./items";
import { checkServices, serviceReportLines, type ServiceCheckRun, type ServiceOutcome } from "./services";

export const MAINTENANCE_STATE_FILE = join("data", "wartung.json");
export const MAINTENANCE_LOCK_FILE = join("data", "wartung.lock");
export const MAINTENANCE_SOURCE = "wartung";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export type EntryOutcome = "geloescht" | "wuerde-geloescht" | "gemeldet" | "uebersprungen" | "fehler";

export interface ItemEntry {
  label: string;
  bytes: number | null;
  outcome: EntryOutcome;
  detail?: string;
}

/** ok: etwas abgeräumt; nichts: nichts zu tun; gemeldet: nur Meldungen; fehler: mindestens ein Fehler */
export type ItemStatus = "ok" | "nichts" | "gemeldet" | "fehler";

export interface ItemResult {
  id: string;
  title: string;
  status: ItemStatus;
  /** gelöschte (im Probelauf: zu löschende) Ziele */
  count: number;
  /** deren Größe vorher, soweit bekannt */
  bytes: number;
  /** nur gemeldete Ziele und ihre Größe */
  reported: number;
  reportedBytes: number;
  entries: ItemEntry[];
  notes: string[];
  errors: string[];
}

export interface MaintenanceRun {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  status: "ok" | "fehler";
  freeBefore: number | null;
  freeAfter: number | null;
  items: ItemResult[];
  /** Dienst-Versionen (Issue #486); fehlt ohne Dienste in config/wartung.json */
  services?: ServiceCheckRun;
  /** Abbruch vor den Posten (Konfiguration, Sperre) */
  error?: string;
  notify?: { status: "gesendet" | "fehlgeschlagen"; detail?: string };
}

export interface MaintenanceState {
  version: 1;
  lastRun: MaintenanceRun;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Läuft einen Posten ab; wirft nie */
async function runItem(item: MaintenanceItem, deps: MaintenanceDeps, config: MaintenanceConfig, dryRun: boolean): Promise<ItemResult> {
  const result: ItemResult = { id: item.id, title: item.title, status: "nichts", count: 0, bytes: 0, reported: 0, reportedBytes: 0, entries: [], notes: [], errors: [] };
  let plan;
  try {
    plan = await item.plan({ deps, config });
  } catch (error) {
    result.errors.push(message(error));
    result.status = "fehler";
    return result;
  }
  result.notes.push(...plan.notes);
  result.errors.push(...(plan.errors ?? []));
  for (const target of plan.targets) {
    const entry: ItemEntry = { label: target.label, bytes: target.bytes, outcome: "gemeldet" };
    if (target.reportOnly) {
      result.reported++;
      result.reportedBytes += target.bytes ?? 0;
    } else if (dryRun) {
      entry.outcome = "wuerde-geloescht";
      result.count++;
      result.bytes += target.bytes ?? 0;
    } else {
      try {
        const outcome = await target.remove();
        if ("removed" in outcome) {
          entry.outcome = "geloescht";
          result.count++;
          result.bytes += target.bytes ?? 0;
        } else {
          entry.outcome = "uebersprungen";
          entry.detail = outcome.skipped;
        }
      } catch (error) {
        entry.outcome = "fehler";
        entry.detail = message(error);
        result.errors.push(`${target.label}: ${message(error)}`);
      }
    }
    result.entries.push(entry);
  }
  result.status = result.errors.length > 0 ? "fehler" : result.count > 0 ? "ok" : result.reported > 0 ? "gemeldet" : "nichts";
  return result;
}

/** Alle Posten der Plattform nacheinander; ein Fehler hält die übrigen nicht auf */
export async function runMaintenance(deps: MaintenanceDeps, config: MaintenanceConfig, dryRun: boolean, items: readonly MaintenanceItem[] = MAINTENANCE_ITEMS): Promise<MaintenanceRun> {
  const startedAt = new Date(deps.now()).toISOString();
  const freeBefore = await deps.freeBytes().catch(() => null);
  const results: ItemResult[] = [];
  for (const item of itemsFor(deps.platform, items)) results.push(await runItem(item, deps, config, dryRun));
  const freeAfter = dryRun ? freeBefore : await deps.freeBytes().catch(() => null);
  const services = await runServices(deps, config, dryRun);
  return {
    startedAt,
    finishedAt: new Date(deps.now()).toISOString(),
    dryRun,
    status: results.some(r => r.status === "fehler") || services?.status === "fehler" ? "fehler" : "ok",
    freeBefore,
    freeAfter,
    items: results,
    ...(services ? { services } : {}),
  };
}

/** Dienst-Versionen nach den Posten; im Probelauf nur prüfen */
async function runServices(deps: MaintenanceDeps, config: MaintenanceConfig, dryRun: boolean): Promise<ServiceCheckRun | undefined> {
  if (config.services.length === 0) return undefined;
  const mode = dryRun ? "pruefen" : "neustart";
  if (!deps.services) {
    const at = new Date(deps.now()).toISOString();
    return { mode, startedAt: at, finishedAt: at, status: "fehler", services: [], error: "keine Zugriffe auf die Dienste eingerichtet" };
  }
  return checkServices(config.services, deps.services, mode);
}

// ---------------------------------------------------------------------------
// Text

/** Größe in deutscher Schreibweise: 1,5 GB, 300 MB, 12 KB */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "Größe unbekannt";
  const units = [
    ["GB", 1024 ** 3],
    ["MB", 1024 ** 2],
    ["KB", 1024],
  ] as const;
  for (const [unit, size] of units) {
    if (bytes >= size) {
      const value = bytes / size;
      return `${value.toLocaleString("de-DE", { maximumFractionDigits: value < 10 ? 1 : 0 })} ${unit}`;
    }
  }
  return `${bytes} B`;
}

function itemLine(r: ItemResult, dryRun: boolean): string {
  const parts: string[] = [];
  if (r.count > 0) parts.push(`${r.count} ${dryRun ? "würden gelöscht" : "gelöscht"}, ${formatBytes(r.bytes)}`);
  if (r.reported > 0) parts.push(`${r.reported} nur gemeldet, ${formatBytes(r.reportedBytes)}`);
  const skipped = r.entries.filter(e => e.outcome === "uebersprungen").length;
  if (skipped > 0) parts.push(`${skipped} übersprungen`);
  if (r.errors.length > 0) parts.push(`Fehler: ${r.errors.join("; ")}`);
  if (parts.length === 0) parts.push("nichts");
  return `- ${r.title}: ${parts.join(" · ")}`;
}

/** Meldung bzw. Ausgabe eines Laufs */
export function reportText(run: MaintenanceRun, detailed = false): string {
  const lines: string[] = [];
  const total = run.items.reduce((sum, r) => sum + r.bytes, 0);
  if (run.error) {
    lines.push(`${BRAND.name}-Wartung abgebrochen: ${run.error}`, "Nichts gelöscht.");
    return lines.join("\n");
  }
  lines.push(run.dryRun ? `${BRAND.name}-Wartung, Probelauf: ${formatBytes(total)} würden frei` : `${BRAND.name}-Wartung: ${formatBytes(total)} abgeräumt${run.status === "fehler" ? ", mit Fehlern" : ""}`);
  if (run.dryRun) lines.push(`Frei jetzt: ${formatBytes(run.freeBefore)}`);
  else lines.push(`Frei vorher: ${formatBytes(run.freeBefore)}, nachher: ${formatBytes(run.freeAfter)}`);
  for (const r of run.items) {
    lines.push(itemLine(r, run.dryRun));
    if (detailed) {
      for (const e of r.entries) lines.push(`    ${e.label}: ${formatBytes(e.bytes)} (${OUTCOME_TEXT[e.outcome]}${e.detail ? `: ${e.detail}` : ""})`);
    } else {
      // In der Meldung stehen übersprungene Ziele mit Grund (etwa: Cache inzwischen benutzt)
      for (const e of r.entries) if (e.outcome === "uebersprungen") lines.push(`    ${e.label}: übersprungen${e.detail ? `, ${e.detail}` : ""}`);
    }
    if (detailed || r.status !== "nichts") for (const note of r.notes) lines.push(`    Hinweis: ${note}`);
  }
  lines.push(...serviceReportLines(run.services));
  if (run.dryRun) lines.push(`Probelauf: nichts gelöscht, nichts gekürzt,${run.services ? " nichts neu gestartet," : ""} nichts gesendet.`);
  return lines.join("\n");
}

const OUTCOME_TEXT: Record<EntryOutcome, string> = {
  geloescht: "gelöscht",
  "wuerde-geloescht": "würde gelöscht",
  gemeldet: "nur gemeldet",
  uebersprungen: "übersprungen",
  fehler: "Fehler",
};

// ---------------------------------------------------------------------------
// Sperre und Zustand

export interface MaintenanceLock {
  owner: LockOwner;
  /** Entfernt die Sperre, aber nur, wenn dort noch die eigene liegt */
  release(): Promise<void>;
}

/** Nimmt die Sperre ohne Warten (file-lock.ts); null, wenn schon eine Wartung läuft */
export async function acquireLock(root: string, options: FileLockOptions = {}): Promise<MaintenanceLock | null> {
  const path = join(root, MAINTENANCE_LOCK_FILE);
  await mkdir(join(root, "data"), { recursive: true });
  const owner = await tryAcquireFileLock(path, options);
  if (!owner) return null;
  return {
    owner,
    async release() {
      await releaseFileLock(path, owner);
    },
  };
}

/** Ergebnis beim Lesen: fehlt ist etwas anderes als ungültig (Nachtcheck, Issue #487) */
export type MaintenanceStateRead = { status: "fehlt" } | { status: "ungueltig" } | { status: "ok"; state: MaintenanceState };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isOptionalString = (value: unknown) => value === undefined || typeof value === "string";

/** Record statt Liste: einen neuen Ausgang verlangt die Typprüfung auch hier */
const SERVICE_OUTCOMES: Record<ServiceOutcome, true> = {
  aktuell: true,
  veraltet: true,
  "neu-gestartet": true,
  "neustart-angefordert": true,
  gestoppt: true,
  unbekannt: true,
  abweichend: true,
  fehler: true,
};

function isServiceResult(value: unknown): boolean {
  if (!isRecord(value) || typeof value.name !== "string") return false;
  if (typeof value.outcome !== "string" || !Object.hasOwn(SERVICE_OUTCOMES, value.outcome)) return false;
  return [value.installed, value.running, value.previous, value.detail].every(isOptionalString);
}

function isServiceCheckRun(value: unknown): boolean {
  if (!isRecord(value) || (value.mode !== "pruefen" && value.mode !== "neustart")) return false;
  return isOptionalString(value.error) && Array.isArray(value.services) && value.services.every(isServiceResult);
}

function isNotify(value: unknown): boolean {
  if (!isRecord(value) || (value.status !== "gesendet" && value.status !== "fehlgeschlagen")) return false;
  return isOptionalString(value.detail);
}

function isItemResult(value: unknown): boolean {
  if (!isRecord(value) || typeof value.title !== "string") return false;
  if (typeof value.bytes !== "number" || !Number.isFinite(value.bytes)) return false;
  return Array.isArray(value.errors) && value.errors.every(error => typeof error === "string");
}

/** Prüft die Felder, die der Nachtcheck auswertet, auch die verschachtelten */
function isMaintenanceRun(run: unknown): run is MaintenanceRun {
  if (!isRecord(run)) return false;
  if (typeof run.finishedAt !== "string" || !Number.isFinite(Date.parse(run.finishedAt))) return false;
  if (run.status !== "ok" && run.status !== "fehler") return false;
  if (!isOptionalString(run.error)) return false;
  if (run.notify !== undefined && !isNotify(run.notify)) return false;
  if (run.services !== undefined && !isServiceCheckRun(run.services)) return false;
  return Array.isArray(run.items) && run.items.every(isItemResult);
}

/** Zustand aus data/wartung.json; eine unlesbare Datei gilt als ungültig, nur eine fehlende als fehlend */
export async function loadMaintenanceState(root: string): Promise<MaintenanceStateRead> {
  let text: string;
  try {
    text = await readFile(join(root, MAINTENANCE_STATE_FILE), "utf8");
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "fehlt" : "ungueltig" };
  }
  try {
    const raw = JSON.parse(text);
    if (isRecord(raw) && raw.version === 1 && isMaintenanceRun(raw.lastRun)) return { status: "ok", state: raw as unknown as MaintenanceState };
  } catch {
    // kein JSON
  }
  return { status: "ungueltig" };
}

/** Zustand aus data/wartung.json; null, wenn es keinen gültigen gibt */
export async function readMaintenanceState(root: string): Promise<MaintenanceState | null> {
  const read = await loadMaintenanceState(root);
  return read.status === "ok" ? read.state : null;
}

async function writeState(root: string, run: MaintenanceRun): Promise<void> {
  const state: MaintenanceState = { version: 1, lastRun: run };
  await atomicWriteFile(join(root, MAINTENANCE_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Befehl

export function maintenanceUsage(): string {
  return [
    `${BRAND.cli} wartung             sichere Posten aufräumen (Test-Simulatoren, Caches, Logs), veraltete Dienste neu starten, melden`,
    `${BRAND.cli} wartung --dry-run   nur zeigen, was gelöscht bzw. neu gestartet würde; nichts löschen, nichts starten, nichts senden`,
    "",
    "Einstellungen: config/wartung.json (Vorlage config/wartung.example.json).",
    `Als wöchentlicher Dienst (sonntags 03:15): ${BRAND.cli} dienste wartung`,
  ].join("\n");
}

export interface MaintenanceCommandOptions {
  deps: MaintenanceDeps;
  out(line: string): void;
  err(line: string): void;
  /** Einstellungen der Sperre (Tests: isAlive, onStale) */
  lock?: FileLockOptions;
}

/** tybo wartung bzw. bun run src/maintenance.ts; gibt den Exit-Code zurück */
export async function runMaintenanceCommand(args: string[], options: MaintenanceCommandOptions): Promise<number> {
  const { deps, out, err } = options;
  if (args[0] === "--") args = args.slice(1);
  if (args.length === 1 && ["help", "--help", "-h"].includes(args[0])) {
    out(maintenanceUsage());
    return EXIT_OK;
  }
  const dryRun = args.length === 1 && args[0] === "--dry-run";
  if (args.length > 1 || (args.length === 1 && !dryRun)) {
    err(`Unbekannter Aufruf: ${BRAND.cli} wartung ${args.join(" ")}`);
    err(maintenanceUsage());
    return EXIT_USAGE;
  }
  if (deps.platform !== "darwin" && deps.platform !== "linux") {
    err(`${BRAND.cli} wartung gibt es unter macOS und Linux.`);
    return EXIT_FAILED;
  }

  const aborted = async (error: string): Promise<number> => {
    const run: MaintenanceRun = { startedAt: new Date(deps.now()).toISOString(), finishedAt: new Date(deps.now()).toISOString(), dryRun, status: "fehler", freeBefore: null, freeAfter: null, items: [], error };
    err(reportText(run));
    if (!dryRun) await finish(run);
    return EXIT_FAILED;
  };
  // Meldung und Zustand eines echten Laufs; true, wenn beides geklappt hat
  const finish = async (run: MaintenanceRun): Promise<boolean> => {
    let good = true;
    try {
      await deps.notify(reportText(run));
      run.notify = { status: "gesendet" };
    } catch (error) {
      run.notify = { status: "fehlgeschlagen", detail: message(error) };
      run.status = "fehler";
      err(`Meldung nicht gesendet: ${message(error)}`);
      good = false;
    }
    try {
      await writeState(deps.root, run);
    } catch (error) {
      err(`Ergebnis nicht gespeichert (${MAINTENANCE_STATE_FILE}): ${message(error)}`);
      good = false;
    }
    return good;
  };

  // Zahl: Abbruch mit diesem Exit-Code, schon gemeldet (im echten Lauf unter Sperre)
  const loadConfig = async (): Promise<MaintenanceConfig | number> => {
    try {
      return await loadMaintenanceConfig(deps.root);
    } catch (error) {
      if (error instanceof MaintenanceConfigError) return aborted(`config/wartung.json ungültig: ${error.message}`);
      throw error;
    }
  };

  if (dryRun) {
    const config = await loadConfig();
    if (typeof config === "number") return config;
    const run = await runMaintenance(deps, config, true);
    out(reportText(run, true));
    return run.status === "ok" ? EXIT_OK : EXIT_FAILED;
  }

  const lock = await acquireLock(deps.root, options.lock);
  if (!lock) {
    // Keine Meldung und kein Zustand: der laufende Lauf schreibt beides
    err(`Es läuft schon eine Wartung (${MAINTENANCE_LOCK_FILE}). Nichts gestartet.`);
    return EXIT_FAILED;
  }
  try {
    const config = await loadConfig();
    if (typeof config === "number") return config;
    const run = await runMaintenance(deps, config, false);
    out(reportText(run, true));
    const delivered = await finish(run);
    return run.status === "ok" && delivered ? EXIT_OK : EXIT_FAILED;
  } finally {
    await lock.release();
  }
}
