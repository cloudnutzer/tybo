/**
 * Data Sources — Public API
 *
 * Usage:
 *   import { fetchAll, getAvailableSources } from "./lib/data-sources";
 *   const result = await fetchAll();
 */

// Import all sources so they register themselves
import "./sources/index";

// Re-export registry functions
export { fetchAll, getAvailableSources, getAllSources } from "./registry";
export type { DataSource, DataSourceResult, FetchAllResult } from "./types";
