/**
 * Ehrliche Erwartung je Weg des Telefonhörers (Issue #256): Zeit bis zum
 * ersten vollständigen Satz laut Messung vom 30.09.2026 auf einem Mac mit
 * Apple M4 (Median und Spanne, Messdatei beim Maintainer). Die Texte stehen
 * nur hier; Einstellung und Einrichtung (#260) zeigen sie an.
 */

export const CALL_MEASUREMENT = "Messung vom 30.09.2026 auf einem Mac mit Apple M4";

export type CallExpectationKey = "api" | "cli" | "cli-haiku" | "openrouter" | "ollama" | "none";

const TEXTS: Record<CallExpectationKey, string> = {
  // Messages API direkt, claude-sonnet-5-5: 1,40 s (1,11 bis 1,94), nie mit Vordenken
  api: "erster Satz nach rund 1,5 Sekunden, gleichmäßig",
  // Offene CLI-Sitzung, claude-sonnet-5-5 effort low: 1,46 s (0,85 bis 4,72), in 14 von 60 Turns Vordenken mit 2,4 bis 4,7 s
  cli: "erster Satz nach rund 1,5 Sekunden, bei Überlegfragen bis 5 Sekunden",
  // Haiku mit MAX_THINKING_TOKENS=0: 1,17 s
  "cli-haiku": "erster Satz nach rund 1,2 Sekunden",
  // OpenRouter mit reasoning effort low, anthropic/claude-sonnet-5.5: 1,61 s (1,12 bis 2,23)
  openrouter: "erster Satz nach rund 1,6 Sekunden, bis gut 2 Sekunden",
  // Ollama qwen3:8b ohne Denken: 3,20 s (1,11 bis 5,50), ganze Antwort nach 12 s
  ollama: "zäh: rund 3 Sekunden bis zum ersten Satz, bis 5,5 Sekunden",
  none: "kein Telefonhörer: es ist kein passender Weg eingerichtet",
};

/** Erwartungstext mit Herkunft der Messung */
export function callExpectation(key: CallExpectationKey): string {
  return key === "none" ? TEXTS.none : `${TEXTS[key]} (${CALL_MEASUREMENT})`;
}
