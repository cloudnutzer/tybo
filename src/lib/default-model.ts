/**
 * Claude-Modell, das gilt, wenn nichts anderes eingestellt ist (Issue #304).
 * Vorrang haben Einstellung je Agent, dann defaults aus config/settings.json,
 * dann das Modell der Agenten-Konfiguration (describeAgentModel in
 * src/agents/base.ts). Opus 5.5 seit 22.9.2026, dazwischen 9.-11.11.2026
 * Fable 5.2 (Guthaben leer). Effort dazu in defaultEffort: high.
 */
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
