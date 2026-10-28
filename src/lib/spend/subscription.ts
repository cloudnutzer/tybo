/**
 * Abo-Zähler (Issue #313): was tybo im laufenden Abrechnungszyklus des
 * Claude-Abos selbst gemessen hat, in derselben SQLite-Datei wie das
 * Tagesbudget (spend/ledger.ts), aber in eigenen Tabellen und getrennt
 * ausgewertet. Je Zyklus eine Zeile: Beginn, Betrag, Warnstatus, gelerntes
 * Limit, Plan.
 *
 * Ein Zyklus beginnt am Reset-Tag (auf 1 bis 28 begrenzt) um 0 Uhr UTC.
 *
 * Fail-open: Der Zähler darf keine Antwort aufhalten. Jeder Speicherfehler
 * wird zu „kein Wert" (null) bzw. „nichts gebucht" (null, false), nie zu einer
 * Ausnahme beim Aufrufer; jeder solche Fehler hinterlässt eine Logzeile.
 *
 * Übernahme: Beim ersten Zugriff je Prozess holt das Modul einmalig den
 * früheren Zählerstand aus credit-tally.json (GO_PROJECT_ROOT, sonst das
 * Arbeitsverzeichnis). Zeile und Importmarker entstehen in einer
 * Schreibtransaktion, der Marker wird darin geprüft, also übernimmt auch bei
 * zwei gleichzeitigen Starts nur einer. Die Datei bleibt liegen und wird nicht
 * mehr geschrieben. Fehlt sie, gibt es nichts zu übernehmen (Marker gesetzt).
 * Ist sie unlesbar oder beschädigt, bleibt der Marker aus, und der nächste
 * Start versucht es erneut; was in der Zwischenzeit gebucht wurde, addiert die
 * Übernahme dann dazu. Die Übernahme richtet sich nur nach der Datei und dem
 * Marker, nie nach der Datenbank-Konfiguration (Issue #314). Schutz vor einem veralteten Zählerstand
 * wie früher beim Lesen der Datei: Jeder Stand zählt nur für seinen eigenen
 * Zyklus (cycleStartMs), eine Datei aus einem älteren Zyklus ändert den
 * laufenden also nie, er beginnt bei 0. Ein Stand aus dem laufenden Zyklus,
 * den eine frühere Installation hinterließ, ist höchstens zu niedrig, nie zu
 * hoch. Ein schon gesetzter Marker (auch der Wert „convex" aus einem früheren
 * Start) bleibt gültig, es wird nichts nachgeholt.
 */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openSpendFile, spendFilePath } from "./ledger";

/** Stand eines Zyklus, wie ihn spend/credit.ts liest (Issue #346) */
export interface CycleSpend {
  cycleSpendUsd: number; // gebucht in diesem Zyklus, Dollar
  cycleStartMs: number; // Zyklusbeginn, UTC-Millisekunden
  warnedThisCycle: boolean; // 80-%-Warnung schon verschickt
  observedCeilingUsd: number | null; // gelerntes Limit, sonst null
  plan?: string;
}

const CYCLE_TABLES = `
CREATE TABLE IF NOT EXISTS subscription_cycles (
  cycle_start_ms INTEGER PRIMARY KEY,
  spend_usd REAL NOT NULL DEFAULT 0,
  warned INTEGER NOT NULL DEFAULT 0,
  observed_ceiling_usd REAL,
  plan TEXT,
  updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS spend_imports (
  source TEXT PRIMARY KEY,
  outcome TEXT NOT NULL,
  done_ms INTEGER NOT NULL
);`;

/** Name der Altdatei, zugleich Schlüssel des Importmarkers */
export const TALLY_FILE = "credit-tally.json";

/** Ort der Altdatei: GO_PROJECT_ROOT, sonst das Arbeitsverzeichnis */
export function tallyFilePath(): string {
  return join(process.env.GO_PROJECT_ROOT || process.cwd(), TALLY_FILE);
}

/**
 * Reset-Tag als Kalendertag 1 bis 28 (gerundet). Unendlich zählt als 28,
 * minus unendlich als 1, NaN bleibt NaN: dafür gibt es keinen Zyklus.
 */
function clampResetDay(resetDay: number): number {
  return Math.min(28, Math.max(1, Math.round(resetDay)));
}

/** Zyklusbeginn für die Ablage; null, wenn der Reset-Tag keinen Zyklus ergibt (NaN) */
function storedCycleStart(resetDay: number, nowMs: number): number | null {
  const start = cycleStartUtc(resetDay, nowMs);
  return Number.isFinite(start) ? start : null;
}

/** Beginn des Zyklus, in dem `nowMs` liegt, als UTC-Millisekunden (NaN ohne gültigen Reset-Tag) */
export function cycleStartUtc(resetDay: number, nowMs: number): number {
  const day = clampResetDay(resetDay);
  const at = new Date(nowMs);
  const monthOffset = at.getUTCDate() >= day ? 0 : -1;
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + monthOffset, day);
}

// ---------------------------------------------------------------------------
// Übernahme aus credit-tally.json
// ---------------------------------------------------------------------------

interface TallyFields {
  cycleStartMs: number; // Pflichtfeld
  cycleSpendUsd: number; // fehlt: 0
  warnedThisCycle: boolean; // fehlt: false
  observedCeilingUsd: number | null; // fehlt: null
  plan: string | null;
  lastUpdatedMs: number | null;
}

type TallyRead =
  | { state: "absent" }
  | { state: "damaged"; why: string }
  | { state: "valid"; fields: TallyFields };

const isAmount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isUnset = (value: unknown): value is null | undefined => value === null || value === undefined;

/** Prüft Felder und Typen; null heißt beschädigt */
function tallyFields(data: unknown): TallyFields | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const source = data as Record<string, unknown>;
  const { cycleStartMs, cycleSpendUsd, warnedThisCycle, observedCeilingUsd, plan, lastUpdatedMs } = source;
  if (!Number.isSafeInteger(cycleStartMs)) return null;
  if (!isUnset(cycleSpendUsd) && !isAmount(cycleSpendUsd)) return null;
  if (!isUnset(warnedThisCycle) && typeof warnedThisCycle !== "boolean") return null;
  if (!isUnset(observedCeilingUsd) && !isAmount(observedCeilingUsd)) return null;
  if (!isUnset(plan) && typeof plan !== "string") return null;
  if (!isUnset(lastUpdatedMs) && !Number.isSafeInteger(lastUpdatedMs)) return null;
  return {
    cycleStartMs: cycleStartMs as number,
    cycleSpendUsd: isAmount(cycleSpendUsd) ? cycleSpendUsd : 0,
    warnedThisCycle: warnedThisCycle === true,
    observedCeilingUsd: isAmount(observedCeilingUsd) ? observedCeilingUsd : null,
    plan: typeof plan === "string" ? plan : null,
    lastUpdatedMs: typeof lastUpdatedMs === "number" ? lastUpdatedMs : null,
  };
}

/** Liest die Altdatei. Nur „gibt es nicht" zählt als fehlend, jeder andere Lesefehler als beschädigt */
function readTally(file: string): TallyRead {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (problem) {
    const code = (problem as { code?: unknown }).code;
    if (code === "ENOENT") return { state: "absent" };
    return { state: "damaged", why: `nicht lesbar, ${typeof code === "string" ? code : "unbekannter Fehler"}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: "damaged", why: "kein gültiges JSON" };
  }
  const fields = tallyFields(parsed);
  return fields ? { state: "valid", fields } : { state: "damaged", why: "Felder fehlen oder haben einen falschen Typ" };
}

const importDone = (handle: Database): boolean =>
  handle.query("SELECT 1 FROM spend_imports WHERE source = ?").get(TALLY_FILE) !== null;

/**
 * Trägt die Übernahme ein. Liegt für den Zyklus schon eine Zeile vor (Buchungen,
 * während eine frühere Übernahme scheiterte), wird addiert statt ersetzt.
 * Gibt zurück, ob dieser Aufruf den Marker gesetzt hat.
 */
function commitImport(handle: Database, outcome: string, fields: TallyFields | null): boolean {
  const apply = handle.transaction(() => {
    if (importDone(handle)) return false;
    const now = Date.now();
    if (fields) {
      handle
        .query(
          `INSERT INTO subscription_cycles (cycle_start_ms, spend_usd, warned, observed_ceiling_usd, plan, updated_ms)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (cycle_start_ms) DO UPDATE SET
             spend_usd = spend_usd + excluded.spend_usd,
             warned = MAX(warned, excluded.warned),
             observed_ceiling_usd = COALESCE(observed_ceiling_usd, excluded.observed_ceiling_usd),
             plan = COALESCE(plan, excluded.plan),
             updated_ms = MAX(updated_ms, excluded.updated_ms)`,
        )
        .run(
          fields.cycleStartMs,
          fields.cycleSpendUsd,
          fields.warnedThisCycle ? 1 : 0,
          fields.observedCeilingUsd,
          fields.plan,
          fields.lastUpdatedMs ?? now,
        );
    }
    handle.query("INSERT INTO spend_imports (source, outcome, done_ms) VALUES (?1, ?2, ?3)").run(TALLY_FILE, outcome, now);
    return true;
  });
  return apply.immediate();
}

/** Einmal je Prozess: Übernahme versuchen. Fehler landen im Log, nie beim Aufrufer */
function importTallyOnce(handle: Database): void {
  if (importDone(handle)) return;
  try {
    const tally = readTally(tallyFilePath());
    if (tally.state === "damaged") {
      console.warn(`[spend] ${TALLY_FILE} nicht übernommen (${tally.why}); nächster Versuch beim nächsten Start`);
      return;
    }
    const fields = tally.state === "valid" ? tally.fields : null;
    if (commitImport(handle, fields ? "uebernommen" : "keine-datei", fields) && fields)
      console.log(`[spend] Abo-Zähler aus ${TALLY_FILE} übernommen`);
  } catch {
    console.warn(`[spend] Übernahme aus ${TALLY_FILE} gescheitert; nächster Versuch beim nächsten Start`);
  }
}

// ---------------------------------------------------------------------------
// Zugriff
// ---------------------------------------------------------------------------

/** Kombinationen aus Ablage und Altdatei, für die dieser Prozess die Übernahme schon versucht hat */
const attempted = new Set<string>();

/** Nur für Tests: vergisst die Übernahmeversuche dieses Prozesses (wie ein Neustart) */
export function resetSubscriptionStateForTests(): void {
  attempted.clear();
}

/**
 * Öffnet die Ablage mit Abo-Tabellen; bei jedem Fehler kommt `fallback`
 * zurück und eine Logzeile mit `action` (Issue #346: ein Speicherfehler darf
 * nicht still als „kein Wert" verschwinden)
 */
function withCycles<T>(action: string, fallback: T, work: (handle: Database) => T): T {
  let handle: Database | null = null;
  try {
    handle = openSpendFile();
    handle.exec(CYCLE_TABLES);
    const key = `${spendFilePath()}\u0000${tallyFilePath()}`;
    if (!attempted.has(key)) {
      attempted.add(key);
      importTallyOnce(handle);
    }
    return work(handle);
  } catch (problem) {
    console.warn(`[spend] Abo-Zähler: ${action} gescheitert: ${problem instanceof Error ? problem.message : String(problem)}`);
    return fallback;
  } finally {
    handle?.close();
  }
}

interface StoredCycle {
  spend_usd: number;
  warned: number;
  observed_ceiling_usd: number | null;
  plan: string | null;
}

function cycleAt(handle: Database, start: number): CycleSpend {
  const stored = handle
    .query("SELECT spend_usd, warned, observed_ceiling_usd, plan FROM subscription_cycles WHERE cycle_start_ms = ?")
    .get(start) as StoredCycle | null;
  const view: CycleSpend = {
    cycleSpendUsd: stored?.spend_usd ?? 0,
    cycleStartMs: start,
    warnedThisCycle: stored?.warned === 1,
    observedCeilingUsd: stored?.observed_ceiling_usd ?? null,
  };
  if (stored?.plan != null) view.plan = stored.plan;
  return view;
}

/** Stand des laufenden Zyklus (ohne Buchung: 0); null, wenn die Ablage nicht erreichbar ist oder kein Zyklus besteht */
export function readCycle(resetDay: number, nowMs: number = Date.now()): CycleSpend | null {
  const start = storedCycleStart(resetDay, nowMs);
  if (start === null) return null;
  return withCycles<CycleSpend | null>("Stand lesen", null, (handle) => cycleAt(handle, start));
}

/**
 * Bucht Kosten in den laufenden Zyklus und gibt den neuen Stand zurück. Nur
 * positive, endliche Beträge zählen, sonst null. `plan` ersetzt einen
 * gespeicherten Plan, fehlt er, bleibt der alte.
 */
export function addCycleSpend(
  costUsd: number,
  resetDay: number,
  plan?: string,
  nowMs: number = Date.now(),
): CycleSpend | null {
  if (!(Number.isFinite(costUsd) && costUsd > 0)) return null;
  const start = storedCycleStart(resetDay, nowMs);
  if (start === null) return null;
  return withCycles<CycleSpend | null>("Buchen", null, (handle) => {
    const book = handle.transaction(() => {
      handle
        .query(
          `INSERT INTO subscription_cycles (cycle_start_ms, spend_usd, plan, updated_ms) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (cycle_start_ms) DO UPDATE SET
             spend_usd = spend_usd + excluded.spend_usd,
             plan = COALESCE(excluded.plan, plan),
             updated_ms = excluded.updated_ms`,
        )
        .run(start, costUsd, plan ?? null, Date.now());
      return cycleAt(handle, start);
    });
    return book.immediate();
  });
}

/**
 * Setzt den Warnstatus des laufenden Zyklus. true nur für den Aufruf, der ihn
 * tatsächlich gesetzt hat; war er schon gesetzt oder ging es schief: false.
 */
export function markCycleWarned(resetDay: number, nowMs: number = Date.now()): boolean {
  const start = storedCycleStart(resetDay, nowMs);
  if (start === null) return false;
  return withCycles("Warnstatus setzen", false, (handle) => {
    const outcome = handle
      .query(
        `INSERT INTO subscription_cycles (cycle_start_ms, warned, updated_ms) VALUES (?1, 1, ?2)
         ON CONFLICT (cycle_start_ms) DO UPDATE SET warned = 1, updated_ms = excluded.updated_ms
         WHERE warned = 0`,
      )
      .run(start, Date.now());
    return outcome.changes > 0;
  });
}

/**
 * Hält fest, bei welchem Betrag das Abo im laufenden Zyklus tatsächlich
 * ausging. Nur der erste Wert je Zyklus gilt; true, wenn dieser Aufruf ihn
 * gesetzt hat.
 */
export function setObservedCeiling(resetDay: number, spendUsd: number, nowMs: number = Date.now()): boolean {
  const start = storedCycleStart(resetDay, nowMs);
  if (!Number.isFinite(spendUsd) || start === null) return false;
  return withCycles("Limit lernen", false, (handle) => {
    const outcome = handle
      .query(
        `INSERT INTO subscription_cycles (cycle_start_ms, observed_ceiling_usd, updated_ms) VALUES (?1, ?2, ?3)
         ON CONFLICT (cycle_start_ms) DO UPDATE SET
           observed_ceiling_usd = excluded.observed_ceiling_usd, updated_ms = excluded.updated_ms
         WHERE observed_ceiling_usd IS NULL`,
      )
      .run(start, Math.max(0, spendUsd), Date.now());
    return outcome.changes > 0;
  });
}
