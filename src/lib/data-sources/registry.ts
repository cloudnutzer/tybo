/**
 * Data Source Registry
 *
 * Register, discover, and fetch all available data sources.
 * Sources auto-register on import. Only sources whose env vars
 * are present will be included in fetchAll().
 */

import type { DataSource, FetchAllResult } from "./types";

const sources: Map<string, DataSource> = new Map();

/** Register a data source. Called by each source module on import. */
export function register(source: DataSource): void {
  sources.set(source.id, source);
}

/** Get all registered sources (regardless of availability). */
export function getAllSources(): DataSource[] {
  return Array.from(sources.values());
}

/** Get only sources whose env vars are present. */
export function getAvailableSources(): DataSource[] {
  return Array.from(sources.values()).filter((s) => s.isAvailable());
}

/** Fetch data from all available sources in parallel. One failure doesn't break others. */
export async function fetchAll(): Promise<FetchAllResult> {
  const start = Date.now();
  const available = getAvailableSources();

  const settled = await Promise.allSettled(
    available.map(async (source) => {
      const result = await source.fetch();
      return { source, result };
    })
  );

  const results = new Map<
    string,
    { source: DataSource; result: import("./types").DataSourceResult }
  >();
  const errors = new Map<string, { source: DataSource; error: Error }>();

  settled.forEach((outcome, i) => {
    const source = available[i];
    if (outcome.status === "fulfilled") {
      results.set(source.id, outcome.value);
    } else {
      errors.set(source.id, {
        source,
        error:
          outcome.reason instanceof Error
            ? outcome.reason
            : new Error(String(outcome.reason)),
      });
    }
  });

  return { results, errors, durationMs: Date.now() - start };
}
