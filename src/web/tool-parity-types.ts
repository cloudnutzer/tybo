/** Gemeinsamer Vertrag für Werkzeug-Bestand und Anzeigen, ohne Laufzeit-Abhängigkeiten. */
export const MCP_GAP_REASONS = [
  "disabled", "user_skip", "sandbox", "codex_config_unreadable", "transport", "invalid_name",
  "invalid_value", "secret_in_command", "secret_in_url", "placeholder_unresolved", "reserved_env",
  "env_conflict", "auth_unknown", "not_in_engine",
] as const;
export const TOOL_HINT_REASONS = [...MCP_GAP_REASONS, "unsupported_source"] as const;
export const SKILL_GAP_REASONS = ["name", "head", "skills_off", "link_missing", "not_in_engine"] as const;
export const TOOL_GAP_IDS = ["connectors", "plugins", "hooks", "builtin", "skills"] as const;
export const TOOL_ORIGINS = ["tybo", "engine"] as const;
export const TOOL_NOTES = ["self", "passed", "none", "off"] as const;
export const TOOL_STATES = ["ok", "unknown"] as const;
export type ToolGapId = typeof TOOL_GAP_IDS[number];
export type McpGapReason = typeof MCP_GAP_REASONS[number];
export type ToolHintReason = typeof TOOL_HINT_REASONS[number];
export type SkillGapReason = typeof SKILL_GAP_REASONS[number];
export type ToolReason = ToolHintReason | SkillGapReason;
export interface ToolItem { name: string; origin: typeof TOOL_ORIGINS[number] }
export interface ToolInventory {
  mcp: ToolItem[];
  skills: ToolItem[];
  notes: typeof TOOL_NOTES[number];
  state: typeof TOOL_STATES[number];
}
export interface ToolGap<R extends ToolReason = ToolReason> { name: string; reason: R }
export interface ToolGaps {
  mcp: ToolGap<McpGapReason>[];
  hints: ToolGap<ToolHintReason>[];
  skills: ToolGap<SkillGapReason>[];
  notes: boolean;
  plugins: number | null;
  fixed: ToolGapId[];
}
export interface ToolGapsResponse {
  mcp: (ToolGap<McpGapReason> & { text: string })[];
  hints: (ToolGap<ToolHintReason> & { text: string })[];
  skills: (ToolGap<SkillGapReason> & { text: string })[];
  notes: boolean;
  plugins: number | null;
  fixed: { id: ToolGapId; text: string }[];
}
export interface EngineTools { inventory: ToolInventory; gaps: ToolGaps }
export interface EngineToolsResponse { inventory: ToolInventory; gaps: ToolGapsResponse }

export const TOOL_GAP_TEXT: Record<ToolReason | ToolGapId, string> = {
  auth_unknown: "ohne Zugangsdaten eingetragen: braucht keine Anmeldung oder eine über OAuth. Wenn keine, in `engine.codex.mcp.public` eintragen",
  sandbox: "Rechte-Stufe von Codex ist nicht ‚Voller Zugriff‘",
  secret_in_command: "Zugangsdaten im Befehl oder in den Argumenten",
  secret_in_url: "Zugangsdaten in der Adresse",
  transport: "Transport-Art SSE, die Codex nicht kennt",
  user_skip: "in den Einstellungen ausgenommen",
  not_in_engine: "im Motor nicht eingerichtet",
  invalid_name: "Name enthält Zeichen, die Codex in einem Aufrufparameter nicht annimmt; angezeigt wird ein Ersatzname",
  link_missing: "Link von tybo fehlt; er entsteht beim nächsten Start des Bots oder vor der nächsten neuen Codex-Session neu",
  skills_off: "Skills für Codex sind in den Einstellungen abgeschaltet",
  connectors: "Konnektoren des Claude-Kontos lassen sich keinem anderen Motor mitgeben",
  disabled: "Weitergabe von MCP-Servern an Codex ist in den Einstellungen abgeschaltet",
  codex_config_unreadable: "Konfiguration von Codex ist nicht lesbar; tybo gibt vorsichtshalber keine Server mit",
  invalid_value: "Eintrag enthält ungültige oder fehlende Angaben",
  placeholder_unresolved: "ein Platzhalter für Zugangsdaten lässt sich nicht auflösen",
  reserved_env: "Eintrag greift auf geschützte Umgebungsvariablen zu",
  env_conflict: "Umgebungswerte widersprechen denen des Motors oder eines anderen Servers",
  unsupported_source: "in einer Einstellungsdatei von Claude Code eingetragen; tybo übernimmt diese Quelle nicht",
  name: "Ordnername ist unzulässig oder der Name im Kopf ist bereits durch einen anderen Skill belegt",
  head: "Skill hat keinen lesbaren Kopf mit Beschreibung",
  plugins: "Skills und MCP-Server aus Plugins von Claude Code werden nicht mitgegeben",
  hooks: "Hooks von Claude Code werden nicht mitgegeben",
  builtin: "eingebaute Werkzeuge können abweichen; siehe die Tabelle „Eingebaute Werkzeuge von Claude Code und ihr Gegenstück in Codex“ in der Erweiterungsanleitung",
  skills: "dieser Motor kennt keine Skills",
};

/** Texte erst an der Antwortgrenze ergänzen, intern bleiben feste Kennungen. */
export function toolGapsResponse(gaps: ToolGaps): ToolGapsResponse {
  const withText = <R extends ToolReason>(items: ToolGap<R>[]) => items.map(({ name, reason }) => ({ name, reason, text: TOOL_GAP_TEXT[reason] }));
  return { mcp: withText(gaps.mcp), hints: withText(gaps.hints), skills: withText(gaps.skills),
    notes: gaps.notes, plugins: gaps.plugins, fixed: gaps.fixed.map(id => ({ id, text: TOOL_GAP_TEXT[id] })) };
}
