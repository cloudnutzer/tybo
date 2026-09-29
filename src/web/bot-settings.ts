/**
 * Echte Abhängigkeiten der Einstellungen-API (Issue #36) für src/bot.ts:
 * Agenten-Anweisungen aus src/lib/agent-overrides.ts sowie
 * config/settings.json mit Schema aus src/lib/settings.ts und die wirksamen
 * Werte aus denselben Resolvern, die an den Aufrufstellen gelten
 * (describeAgentModel/describeAgentEffort, describeAux, describeFallback,
 * defaultEffort). Wie bot-topics.ts bindet nur src/bot.ts diese Datei ein;
 * Tests nutzen sie mit temporären Dateien (setSettingsPath).
 */

import { readFile } from "node:fs/promises";
import { describeAgentEffort, describeAgentModel } from "../agents/base";
import { listAgentNames } from "../agents/catalog";
import { addAgentOverride, AgentOverridesChanged, clearAgentOverrides, getAgentOverrides, removeLastAgentOverride } from "../lib/agent-overrides";
import { describeAux } from "../lib/aux-model";
import { defaultEffort } from "../lib/claude";
import { defaultEngineSetting, engineLabel } from "../lib/engine-choice";
import { describeFallback } from "../lib/fallback-llm";
import {
  CODEX_EFFORT_LEVELS,
  CODEX_SANDBOX_LEVELS,
  DEFAULT_CODEX_SANDBOX,
  DEFAULT_OPENCODE_PERMISSION,
  EFFORT_LEVELS,
  getSettings,
  getSettingsPath,
  OPENCODE_PERMISSION_LEVELS,
  SELECTABLE_ENGINES,
  settingsSchema,
  withSettingsLock,
  writeSettings,
  type Settings,
} from "../lib/settings";
import { InstructionsChanged, type InstructionsPort } from "./instructions";
import {
  AUX_PURPOSES,
  SettingsFileInvalid,
  type EffectiveSettings,
  type SettingsData,
  type SettingsIssue,
  type SettingsPort,
  type ValidateResult,
} from "./settings";

/** Zod-Meldungen ohne Werte: eigene Texte aus dem Schema, sonst feste Hinweise */
function issueMessage(issue: { code: string; message: string } & Record<string, unknown>): string {
  switch (issue.code) {
    case "invalid_enum_value":
      return `erlaubt: ${(issue.options as unknown[]).map(String).join(", ")}`;
    case "custom":
    case "too_small":
    // Regex-Prüfung mit eigenem Text im Schema (Codex-Modellname), nie der Wert
    case "invalid_string":
      return issue.message;
    case "invalid_type":
      return "falscher Typ";
    case "unrecognized_keys":
      return "unbekanntes Feld";
    default:
      return "ungültiger Wert";
  }
}

export function validateSettings(value: unknown): ValidateResult {
  const parsed = settingsSchema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data as SettingsData };
  const issues: SettingsIssue[] = parsed.error.issues.map(i => ({
    path: i.path.join(".") || "(Wurzel)",
    message: issueMessage(i as any),
  }));
  return { ok: false, issues };
}

/** Wirksame Werte für einen Stand, über die Resolver der Aufrufstellen */
export function effectiveSettings(settings: SettingsData): EffectiveSettings {
  const s = settings as Settings;
  const deps = { getSettings: () => s };
  const agents: EffectiveSettings["agents"] = {};
  for (const name of listAgentNames()) {
    const model = describeAgentModel(name, deps);
    const effort = describeAgentEffort(name, deps);
    agents[name] = {
      model,
      // Ohne Effort entscheidet defaultEffort in claude.ts (CLAUDE_EFFORT ist oben schon berücksichtigt)
      effort:
        effort.value !== undefined
          ? { value: effort.value, source: effort.source }
          : { value: defaultEffort(model.value) ?? null, source: "code" },
    };
  }
  const aux = {} as EffectiveSettings["aux"];
  for (const purpose of AUX_PURPOSES) {
    const { target, source } = describeAux(purpose, s, true);
    aux[purpose] = { value: `${target.kind}:${target.model}`, source };
  }
  // Standard-Motor wie bei der Motor-Wahl (Issue #126): Datei, TYBO_ENGINE, Claude Code
  const engine = defaultEngineSetting({ getSettings: () => s });
  return { agents, aux, fallback: describeFallback(s), engine: { default: { value: engine.engine, source: engine.source } } };
}

async function readForWrite(): Promise<SettingsData> {
  let raw: string;
  try {
    raw = await readFile(getSettingsPath(), "utf-8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return {};
    throw e;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new SettingsFileInvalid();
  }
  const checked = validateSettings(json);
  if (!checked.ok) throw new SettingsFileInvalid();
  return checked.value;
}

export const botSettings: SettingsPort = {
  // Getter: aktive Agenten aus dem Katalog bei jedem Zugriff (Issue #49)
  get agents() {
    return listAgentNames();
  },
  effortLevels: EFFORT_LEVELS,
  current: () => getSettings() as SettingsData,
  readForWrite,
  validate: validateSettings,
  write: value => writeSettings(value as Settings),
  lock: withSettingsLock,
  effective: effectiveSettings,
  engineOptions: {
    engines: SELECTABLE_ENGINES.map(id => ({ id, label: engineLabel(id) })),
    codexEffortLevels: CODEX_EFFORT_LEVELS,
    codexSandboxLevels: CODEX_SANDBOX_LEVELS,
    codexDefaultSandbox: DEFAULT_CODEX_SANDBOX,
    opencodePermissionLevels: OPENCODE_PERMISSION_LEVELS,
    opencodeDefaultPermission: DEFAULT_OPENCODE_PERMISSION,
  },
};

/** AgentOverridesChanged aus src/lib wird zu InstructionsChanged der WebUI */
async function unlessChanged<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof AgentOverridesChanged) throw new InstructionsChanged();
    throw e;
  }
}

/** Agenten-Anweisungen wie /agent in Telegram (config/agent-overrides.json) */
export const botInstructions: InstructionsPort = {
  list: getAgentOverrides,
  add: addAgentOverride,
  clear: (agent, unchanged) => unlessChanged(() => clearAgentOverrides(agent, unchanged)),
  removeLast: (agent, unchanged) => unlessChanged(() => removeLastAgentOverride(agent, unchanged)),
};
