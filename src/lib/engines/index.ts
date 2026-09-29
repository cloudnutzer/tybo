/**
 * Register der Motoren (Entscheidung 0018): Claude Code, Codex (Issue #123)
 * und OpenCode (Entscheidung 0019, Issue #127). Welcher Motor ein Gespräch
 * bekommt, entscheidet src/lib/engine-choice.ts (Issue #125); OpenCode ist
 * dort seit #129 wählbar.
 */

import { createClaudeEngine } from "./claude";
import { createCodexEngine } from "./codex";
import { createOpenCodeEngine } from "./opencode";
import type { Engine, EngineId } from "./types";

export type { Engine, EngineErrorKind, EngineId, EngineRequest, EngineResult, EngineUsage } from "./types";
export { ENGINE_IDS } from "./types";
export { createClaudeEngine, claudeOptionsFor, type ClaudeEngineDeps } from "./claude";
export { createCodexEngine } from "./codex";
export { createOpenCodeEngine } from "./opencode";
export { checkEngine, forgetEngineCheck, inspectEngine, type EngineStatus } from "./check";
export {
  abortEngineCalls,
  abortAllEngineCalls,
  activeEngineCallCount,
  registerEngineCall,
  unregisterEngineCall,
} from "./calls";

export const DEFAULT_ENGINE: EngineId = "claude";

/** Wird ausgelöst, wenn ein Motor angefragt wird, der (noch) nicht registriert ist */
export class EngineNotAvailableError extends Error {
  constructor(readonly engineId: string) {
    super(`Motor "${engineId}" ist nicht verfügbar (registriert: ${registeredEngineIds().join(", ")})`);
    this.name = "EngineNotAvailableError";
  }
}

const factories: Partial<Record<EngineId, () => Engine>> = {
  claude: () => createClaudeEngine(),
  codex: () => createCodexEngine(),
  opencode: () => createOpenCodeEngine(),
};

/** Ersatz für Tests; "unavailable" spielt einen nicht registrierten Motor */
const overrides = new Map<EngineId, Engine | "unavailable">();

export function registeredEngineIds(): EngineId[] {
  return (Object.keys(factories) as EngineId[]).filter((id) => overrides.get(id) !== "unavailable");
}

/** Motor zu einer ID; wirft EngineNotAvailableError für nicht registrierte Motoren */
export function getEngine(id: EngineId): Engine {
  const override = overrides.get(id);
  if (override === "unavailable") throw new EngineNotAvailableError(id);
  if (override) return override;
  const factory = factories[id];
  if (!factory) throw new EngineNotAvailableError(id);
  return factory();
}

/**
 * Nur für Tests: einen Motor ersetzen (auch einen sonst nicht registrierten),
 * "unavailable" lässt ihn wie nicht registriert abgelehnt werden (kein echter
 * Prozess), engine null nimmt den Ersatz zurück, ohne Argumente alle Ersetzungen.
 */
export function setEngineForTests(id?: EngineId, engine?: Engine | "unavailable" | null): void {
  if (id === undefined) overrides.clear();
  else if (engine) overrides.set(id, engine);
  else overrides.delete(id);
}
