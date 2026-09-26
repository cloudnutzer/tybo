/**
 * Data Source Types
 *
 * Interface and types for pluggable morning briefing data sources.
 * Sources auto-detect availability from environment variables.
 */

export interface DataSourceResult {
  /** Formatted lines to include in the briefing (Telegram Markdown) */
  lines: string[];
  /** Optional metadata for debugging */
  meta?: Record<string, unknown>;
}

export interface DataSource {
  /** Unique identifier, e.g. "gmail", "calendar", "grok-news" */
  id: string;
  /** Display name, e.g. "Gmail (Unread)" */
  name: string;
  /** Emoji prefix for the briefing section */
  emoji: string;
  /** Check if required env vars are present */
  isAvailable(): boolean;
  /** Fetch data and return formatted lines */
  fetch(): Promise<DataSourceResult>;
}

export interface FetchAllResult {
  /** Source ID → result (only successful fetches) */
  results: Map<string, { source: DataSource; result: DataSourceResult }>;
  /** Source ID → error (only failed fetches) */
  errors: Map<string, { source: DataSource; error: Error }>;
  /** Total fetch duration in ms */
  durationMs: number;
}
