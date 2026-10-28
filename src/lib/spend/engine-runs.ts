/**
 * Motorläufe (Issue #346): jeder Lauf eines Motors mit Zeitpunkt, Motor,
 * Modell, Herkunft, Tokens und Kosten, in derselben SQLite-Datei wie
 * Tagesbudget und Abo-Zähler (spend/ledger.ts), Tabelle `engine_runs`.
 *
 * Es gibt keine Preistabelle: Dollar stehen nur dort, wo der Motor sie
 * meldet. Fehlt die Meldung (Codex immer, Claude im Textformat), steht in
 * `cost_usd` NULL, nie 0. Eine gemeldete 0 bleibt 0.
 *
 * Fail-open wie spend/subscription.ts: ein Speicherfehler heißt „nichts
 * gebucht" (Logzeile), nie eine Ausnahme beim Aufrufer.
 */
import type { Database } from "bun:sqlite";
import type { EngineId, EngineUsage } from "../engines/types";
import { openSpendFile } from "./ledger";

/** Motor eines Laufs; "openrouter" nur für das Agent SDK über OpenRouter */
export type RunEngine = EngineId | "openrouter";

/** Wo der Lauf gestartet wurde */
export type RunOrigin = "chat" | "routine" | "task-resume" | "aux" | "fallback" | "voice" | "agent-sdk";

/** Ein abgeschlossener Lauf, wie er gebucht wird */
export interface EngineRun {
  engine: RunEngine;
  origin: RunOrigin;
  /** Modell wie übergeben; fehlt es, wird "" gespeichert */
  model?: string;
  usage?: EngineUsage;
  /** Kosten laut Motor; fehlt: nicht gemeldet */
  costUsd?: number;
}

const RUNS_SCHEMA = `
CREATE TABLE IF NOT EXISTS engine_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  engine TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_input_tokens INTEGER,
  reasoning_output_tokens INTEGER,
  cost_usd REAL
);
CREATE INDEX IF NOT EXISTS engine_runs_at ON engine_runs (at_ms);`;

/** Endliche Zahl ab 0, sonst null (nicht gemeldet) */
function amountOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

const tokensOrNull = (value: unknown): number | null => {
  const amount = amountOrNull(value);
  return amount === null ? null : Math.round(amount);
};

/** Öffnet die Ablage samt Tabelle; Fehler gehen an den Aufrufer dieser Hilfsfunktion */
function withRuns<T>(work: (handle: Database) => T): T {
  const handle = openSpendFile();
  try {
    handle.exec(RUNS_SCHEMA);
    return work(handle);
  } finally {
    handle.close();
  }
}

const reason = (problem: unknown): string => (problem instanceof Error ? problem.message : String(problem));

/** Bucht einen Lauf. true, wenn er gespeichert wurde; bei einem Speicherfehler false und eine Logzeile */
export function storeEngineRun(run: EngineRun, atMs: number = Date.now()): boolean {
  try {
    withRuns((handle) =>
      handle
        .query(
          `INSERT INTO engine_runs
             (at_ms, engine, model, origin, input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens, cost_usd)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .run(
          atMs,
          run.engine,
          run.model ?? "",
          run.origin,
          tokensOrNull(run.usage?.inputTokens),
          tokensOrNull(run.usage?.outputTokens),
          tokensOrNull(run.usage?.cachedInputTokens),
          tokensOrNull(run.usage?.reasoningOutputTokens),
          amountOrNull(run.costUsd),
        ),
    );
    return true;
  } catch (problem) {
    console.warn(`[spend] Motorlauf nicht gebucht (${run.engine}, ${run.origin}): ${reason(problem)}`);
    return false;
  }
}

/** Summe der Läufe eines Motors ab einem Zeitpunkt */
export interface EngineTally {
  engine: string;
  runs: number;
  /** Summe der gemeldeten Eingabe-Tokens; null, wenn kein Lauf sie meldete */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Summe der gemeldeten Dollar (0, wenn keiner meldete) */
  reportedUsd: number;
  /** Läufe mit Kostenmeldung (auch gemeldete 0 $) */
  pricedRuns: number;
}

interface TallyRow {
  engine: string;
  runs: number;
  input_tokens: number | null;
  output_tokens: number | null;
  usd: number;
  priced: number;
}

/** Läufe je Motor seit `sinceMs`, nach Motor sortiert; null, wenn die Ablage nicht lesbar ist */
export function engineTallies(sinceMs: number): EngineTally[] | null {
  try {
    const rows = withRuns(
      (handle) =>
        handle
          .query(
            `SELECT engine, COUNT(*) AS runs, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                    TOTAL(cost_usd) AS usd, COUNT(cost_usd) AS priced
             FROM engine_runs WHERE at_ms >= ? GROUP BY engine ORDER BY engine`,
          )
          .all(sinceMs) as TallyRow[],
    );
    return rows.map((row) => ({
      engine: row.engine,
      runs: row.runs,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      reportedUsd: row.usd,
      pricedRuns: row.priced,
    }));
  } catch (problem) {
    console.warn(`[spend] Motorläufe nicht lesbar: ${reason(problem)}`);
    return null;
  }
}
