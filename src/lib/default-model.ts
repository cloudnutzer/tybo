/**
 * Claude-Modell, das gilt, wenn nichts anderes eingestellt ist (Issue #304).
 * Vorrang haben Einstellung je Agent, dann defaults aus config/settings.json,
 * dann das Modell der Agenten-Konfiguration (describeAgentModel in
 * src/agents/base.ts). Seit 22.9.2026 Opus 5.5, Effort dazu in defaultEffort.
 */
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
