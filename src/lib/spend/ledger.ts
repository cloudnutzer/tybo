/**
 * Kosten-Ablage (Issue #313): eine SQLite-Datei für das Tagesbudget der
 * API-Aufrufe und den Abo-Zähler (spend/subscription.ts). Die beiden
 * Auswertungen bleiben getrennt, nur die Datei ist gemeinsam.
 *
 * Tagesbudget: Tabelle `costs` (Schema wie vor dem Umbau, bestehende Zeilen
 * und offene Reservierungen gelten weiter). Ein Tag ist das UTC-Datum. Eine
 * Reservierung zählt, bis sie verbucht ist, auch über Abstürze hinweg: lieber
 * zu vorsichtig als über dem Budget. Alles hier ist streng, jeder Fehler
 * (Betrag, Grenze, Speicher) geht als Ausnahme an den Aufrufer.
 */
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

const DEFAULT_FILE = "data/api-budget.sqlite";
const DEFAULT_DAILY_LIMIT_USD = 5;

const COSTS_TABLE = `CREATE TABLE IF NOT EXISTS costs (
  id TEXT PRIMARY KEY, day TEXT, provider TEXT, reserved REAL, spent REAL
)`;

/** Ort der Ablage: BUDGET_DB_PATH, sonst data/api-budget.sqlite */
export function spendFilePath(): string {
  return process.env.BUDGET_DB_PATH || DEFAULT_FILE;
}

/**
 * Öffnet die Ablage, legt Ordner und Datei bei Bedarf an (Rechte 0600) und
 * wartet bis zu 5 Sekunden auf eine Sperre anderer Prozesse.
 */
export function openSpendFile(): Database {
  const file = spendFilePath();
  mkdirSync(dirname(file), { recursive: true });
  const handle = new Database(file, { create: true });
  try {
    chmodSync(file, 0o600);
    handle.exec("PRAGMA busy_timeout = 5000");
  } catch (error) {
    handle.close();
    throw error;
  }
  return handle;
}

/** Führt `work` mit offener Ablage samt Tabelle `costs` aus und schließt sie danach */
function usingCosts<T>(work: (handle: Database) => T): T {
  const handle = openSpendFile();
  try {
    handle.exec(COSTS_TABLE);
    return work(handle);
  } finally {
    handle.close();
  }
}

const utcDay = (): string => new Date().toISOString().slice(0, 10);

/** Tagesgrenze in Dollar aus DAILY_API_BUDGET (Standard 5) */
export function dailyLimitUsd(): number {
  const raw = process.env.DAILY_API_BUDGET;
  const limit = raw ? Number(raw) : DEFAULT_DAILY_LIMIT_USD;
  if (Number.isFinite(limit) && limit >= 0) return limit;
  throw new Error("Invalid DAILY_API_BUDGET");
}

/** Reserviert plus verbucht am angegebenen Tag */
function committedOn(handle: Database, day: string): number {
  const row = handle
    .query("SELECT TOTAL(reserved) + TOTAL(spent) AS committed FROM costs WHERE day = ?")
    .get(day) as { committed: number };
  return row.committed;
}

/** Was heute noch frei ist, nie unter 0 */
export function dailyRemainingUsd(): number {
  return usingCosts((handle) => Math.max(0, dailyLimitUsd() - committedOn(handle, utcDay())));
}

/**
 * Hält `amountUsd` für einen Aufruf fest und gibt die Kennung zum späteren
 * Verbuchen zurück. Prüfen und Eintragen liegen in einer Schreibtransaktion,
 * so können zwei Prozesse zusammen die Grenze nicht überschreiten.
 */
export function holdDailyBudget(provider: string, amountUsd: number): string {
  if (!(Number.isFinite(amountUsd) && amountUsd > 0)) throw new Error("Invalid cost reservation");
  return usingCosts((handle) => {
    const claim = handle.transaction((day: string) => {
      if (committedOn(handle, day) + amountUsd > dailyLimitUsd()) throw new Error("Daily API budget reached");
      const key = randomUUID();
      handle
        .query("INSERT INTO costs (id, day, provider, reserved, spent) VALUES (?1, ?2, ?3, ?4, 0)")
        .run(key, day, provider, amountUsd);
      return key;
    });
    return claim.immediate(utcDay());
  });
}

/**
 * Schließt eine Reservierung ab. Bekannte Istkosten (endlich, ab 0) ersetzen
 * sie, sonst zählt der reservierte Betrag als verbraucht. Nur offene
 * Einträge (reserved > 0) ändern sich: ein zweiter Abschluss bleibt ohne
 * Wirkung, ein abgeschlossener Eintrag öffnet sich nicht wieder.
 */
export function closeDailyHold(key: string, actualUsd?: number): void {
  const known = typeof actualUsd === "number" && Number.isFinite(actualUsd) && actualUsd >= 0;
  usingCosts((handle) => {
    const statement = known
      ? "UPDATE costs SET spent = ?2, reserved = 0 WHERE id = ?1 AND reserved > 0"
      : "UPDATE costs SET spent = reserved, reserved = 0 WHERE id = ?1 AND reserved > 0";
    if (known) handle.query(statement).run(key, actualUsd);
    else handle.query(statement).run(key);
  });
}
