/** Reine Darstellung der bereinigten Bestandsdaten, gemeinsam für Chat und Prüfbericht. */
import { toolGapsResponse, type EngineTools, type ToolGapId, type ToolGaps, type ToolItem } from "../../web/tool-parity-types";
import { safeMcpName } from "./codex-mcp";
import { safeSkillName } from "./tool-parity";
import type { EngineId } from "./types";

export const MOTOR_TOOL_TEXT = {
  toolsUnknown: "Werkzeuge: nicht ermittelbar",
  inventoryUnknown: "Bestand unvollständig lesbar",
  baseline: "Maßstab, keine Lücken",
  pluginsUnknown: "Plugins von Claude Code: Zahl unbekannt",
  notesMissing: "Notizen von Claude Code fehlen",
  moreTools: "Mehr mit /motor werkzeuge",
  shortened: "Weitere Angaben gekürzt.",
  noEngineReady: "Kein Motor bereit.",
} as const;

export const FIXED_SHORT: Record<ToolGapId, string> = {
  connectors: "Konnektoren des Claude-Kontos", plugins: "Plugins", hooks: "Hooks",
  builtin: "eingebaute Werkzeuge", skills: "Skills",
};

export function hasToolGaps(gaps: ToolGaps): boolean {
  return !!(gaps.mcp.length || gaps.skills.length || gaps.hints.length || gaps.fixed.length || gaps.notes);
}

export interface MotorToolsEntry { engine: EngineId; label: string; tools?: EngineTools }

const NOTES_TEXT = { self: "im Motor", passed: "von tybo", none: "keine vorhanden", off: "nicht mitgegeben" } as const;
const originText = (origin: ToolItem["origin"]) => origin === "tybo" ? "von tybo" : "im Motor";

function toolDetails(entry: MotorToolsEntry, skillNames: boolean, otherNames: boolean): string {
  if (!entry.tools) return `${entry.label}\n${MOTOR_TOOL_TEXT.toolsUnknown}`;
  const { inventory, gaps } = entry.tools;
  const lines = [entry.label];
  if (inventory.state === "unknown") lines.push(MOTOR_TOOL_TEXT.inventoryUnknown);
  const items = (label: string, values: ToolItem[], names: boolean, safe: (name: string) => string) => {
    if (names) lines.push(`${label}: ${values.map(item => `${safe(item.name)} (${originText(item.origin)})`).join(", ") || "keine"}`);
    else lines.push(`${label}: ${values.filter(v => v.origin === "tybo").length} von tybo, ${values.filter(v => v.origin === "engine").length} im Motor`);
  };
  items("MCP-Server", inventory.mcp, otherNames, safeMcpName);
  items("Skills", inventory.skills, skillNames, safeSkillName);
  lines.push(`Notizen: ${NOTES_TEXT[inventory.notes]}`);
  if (entry.engine === "claude") return [...lines, MOTOR_TOOL_TEXT.baseline].join("\n");
  const response = toolGapsResponse(gaps);
  const grouped = (label: string, values: { name: string; reason: string; text: string }[], names: boolean, safe: (name: string) => string) => {
    const groups = new Map<string, { text: string; names: string[] }>();
    for (const value of values) {
      const group = groups.get(value.reason) ?? { text: value.text, names: [] };
      group.names.push(safe(value.name));
      groups.set(value.reason, group);
    }
    for (const group of groups.values()) lines.push(`${label} (${names ? group.names.join(", ") : group.names.length}): ${group.text}`);
  };
  grouped("Fehlende MCP-Server", response.mcp, otherNames, safeMcpName);
  grouped("Fehlende Skills", response.skills, skillNames, safeSkillName);
  grouped("Hinweise", response.hints, otherNames, safeMcpName);
  if (gaps.notes) lines.push(MOTOR_TOOL_TEXT.notesMissing);
  lines.push(...response.fixed.map(gap => gap.text));
  lines.push(gaps.plugins === null ? MOTOR_TOOL_TEXT.pluginsUnknown : `Plugins von Claude Code: ${gaps.plugins}`);
  return lines.join("\n");
}

/** Erst alle Skill-Listen auf Zahlen kürzen, danach auch andere Listen. */
export function motorToolsText(entries: MotorToolsEntry[]): string {
  for (const [skillNames, otherNames] of [[true, true], [false, true], [false, false]] as const) {
    const text = entries.map(entry => toolDetails(entry, skillNames, otherNames)).join("\n\n");
    if (text.length <= 4_000) return text;
  }
  // Selbst sehr viele unterschiedliche Gründe dürfen keine zweite Nachricht
  // erzwingen. Alle Motoren behalten ihren Abschnitt, gekürzt an Zeilengrenzen.
  const budget = Math.floor((4_000 - 2 * (entries.length - 1)) / entries.length);
  return entries.map(entry => {
    const lines = toolDetails(entry, false, false).split("\n");
    const kept: string[] = [];
    for (const line of lines) {
      if ([...kept, line, MOTOR_TOOL_TEXT.shortened].join("\n").length > budget) break;
      kept.push(line);
    }
    if (kept.length < lines.length) kept.push(MOTOR_TOOL_TEXT.shortened);
    return kept.join("\n");
  }).join("\n\n");
}

export function toolSummary({ inventory, gaps }: EngineTools): string {
  const have = [`${inventory.mcp.length} MCP-Server`, `${inventory.skills.length} Skills`];
  if (inventory.notes === "self" || inventory.notes === "passed") have.push("Notizen");
  const missing = [
    ...(gaps.mcp.length ? [`${gaps.mcp.length} MCP-Server`] : []),
    ...(gaps.skills.length ? [`${gaps.skills.length} Skills`] : []),
    ...(gaps.notes ? ["Notizen"] : []),
    ...gaps.fixed.map(id => FIXED_SHORT[id]),
  ];
  return [
    ...(inventory.state === "unknown" ? [`${MOTOR_TOOL_TEXT.inventoryUnknown}.`] : []),
    `${have.join(", ")}.`,
    ...(missing.length ? [`Fehlt: ${missing.join(", ")}.`] : []),
    ...(gaps.hints.length ? [`${gaps.hints.length} Hinweise.`] : []),
  ].join(" ");
}
