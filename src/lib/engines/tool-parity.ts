/** Lesende Bestandsaufnahme je Motor. Kein Programmstart, kein Abgleich und keine Logausgabe. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getSettings } from "../settings";
import { opencodeConfigDir } from "../subprocess-env";
import { loadServerSpecs } from "../mcp/config";
import { claudeNotesDir } from "./claude-notes";
import { codexEnv, codexSandbox, codexSkillLinksInput } from "./codex";
import { currentCodexMcpPlan, readCodexMcpSources, readCodexOwnMcpNames, safeMcpName, type CodexMcpPlan } from "./codex-mcp";
import { inspectCodexSkillLinks, NAME, type CodexSkillLinksInput, type CodexSkillLinksInspection } from "./codex-skills";
import type { EngineId } from "./types";
import { MCP_GAP_REASONS, TOOL_HINT_REASONS, type ToolGaps, type ToolInventory, type ToolItem } from "../../web/tool-parity-types";
export * from "../../web/tool-parity-types";

/** Ersetzbare Pfade und Einstellungen. Tests ersetzen zusätzlich die Eingaben des MCP-Plans. */
export interface ToolParityInput {
  skills: CodexSkillLinksInput;
  opencodeConfig: string;
  extraFile?: string;
  claudeNotes: boolean;
  opencodeClaudeSkills: boolean;
  mcpInput: () => Parameters<typeof currentCodexMcpPlan>[0];
}
function defaultInput(): ToolParityInput {
  const settings = getSettings().engine?.codex;
  const skills = codexSkillLinksInput(settings?.skills !== false);
  // Bei einer gesetzten Abschaltung vorsichtig keine Claude-Skills zusagen.
  const disabled = [process.env.OPENCODE_DISABLE_CLAUDE_CODE, process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS]
    .some(value => !!value && value !== "0" && value.toLowerCase() !== "false");
  return { skills, opencodeConfig: opencodeConfigDir(process.env, skills.home),
    extraFile: process.env.MCP_CONFIG_PATH || undefined, claudeNotes: settings?.claudeNotes !== false,
    opencodeClaudeSkills: !disabled,
    mcpInput: () => ({ cwd: skills.root, sandbox: codexSandbox(), baseEnv: readers.planEnv(skills.root) }) };
}

const defaultReaders = {
  text: (path: string) => readFileSync(path, "utf8"),
  children: (path: string) => readdirSync(path),
  stat: (path: string) => statSync(path),
  sources: readCodexMcpSources,
  ownMcp: readCodexOwnMcpNames,
  plan: currentCodexMcpPlan,
  planEnv: (root: string) => codexEnv(root, undefined, { quiet: true }),
  inspectSkills: inspectCodexSkillLinks,
  apiSpecs: loadServerSpecs,
};
let readers = defaultReaders;
export function setToolParityReadersForTests(overrides: Partial<typeof defaultReaders> | null): void {
  readers = overrides ? { ...defaultReaders, ...overrides } : defaultReaders;
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const byName = <T extends { name: string }>(items: T[]): T[] => items.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
export const safeSkillName = (name: string): string => NAME.test(name) ? name : safeMcpName(name);
type JsonReader = (path: string | undefined) => Record<string, unknown> | undefined;

/** Spätere Projekt-Einträge können einen globalen Server auch abschalten. */
export function readOpenCodeMcpNames(configDir: string, root: string, json: JsonReader, onError = () => {}): string[] {
  const servers = new Map<string, boolean>();
  for (const dir of new Set([configDir, root].filter(Boolean))) {
    for (const file of ["opencode.json", "opencode.jsonc"]) {
      const value = json(join(dir, file))?.mcp;
      if (value === undefined) continue;
      const entries = record(value);
      if (!entries) { onError(); continue; }
      for (const [name, raw] of Object.entries(entries)) {
        const server = record(raw);
        if (!server) { onError(); continue; }
        servers.set(safeMcpName(name), server.enabled !== false);
      }
    }
  }
  return [...servers].filter(([, enabled]) => enabled).map(([name]) => name).sort();
}

export function readClaudePluginCount(home: string, json: JsonReader): number | null {
  const plugins = record(json(join(home, ".claude", "plugins", "installed_plugins.json"))?.plugins);
  return plugins ? Object.keys(plugins).length : null;
}

export interface ToolParitySnapshot {
  inventory(engine: EngineId): ToolInventory;
  gaps(engine: EngineId): ToolGaps;
}

/** Ein Snapshot pro Abruf: große Claude-Dateien nur einmal lesen und parsen. */
export function createToolParitySnapshot(input: ToolParityInput = defaultInput()): ToolParitySnapshot {
  const io = readers;
  const { root, home } = input.skills;
  const textCache = new Map<string, { value?: string; error?: unknown }>();
  const jsonCache = new Map<string, { value?: Record<string, unknown>; failed: boolean }>();
  const inventories = new Map<EngineId, ToolInventory>();
  const gapCache = new Map<EngineId, ToolGaps>();
  let plan: CodexMcpPlan | undefined;
  let inspection: CodexSkillLinksInspection | undefined;
  let markUnknown = () => {};
  const text = (path: string): string => {
    const id = resolve(path);
    if (!textCache.has(id)) {
      try { textCache.set(id, { value: io.text(id) }); }
      catch (error) { textCache.set(id, { error }); }
    }
    const result = textCache.get(id)!;
    if (result.error) { if (!missing(result.error)) markUnknown(); throw result.error; }
    return result.value!;
  };
  const json = (path: string | undefined, relaxed = false): Record<string, unknown> | undefined => {
    if (!path) return;
    const id = resolve(path);
    const cacheKey = `${relaxed ? "jsonc" : "json"}:${id}`;
    if (!jsonCache.has(cacheKey)) {
      try {
        const value = record(relaxed ? Bun.JSONC.parse(text(id)) : JSON.parse(text(id)));
        jsonCache.set(cacheKey, { value, failed: !value });
      } catch (error) { jsonCache.set(cacheKey, { failed: !missing(error) }); }
    }
    const result = jsonCache.get(cacheKey)!;
    if (result.failed) markUnknown();
    return result.value;
  };
  const children = (path: string): string[] => {
    try { return io.children(path).sort(); }
    catch (error) { if (!missing(error)) markUnknown(); return []; }
  };
  const is = (path: string, kind: "file" | "directory"): boolean => {
    try { const stat = io.stat(path); return kind === "file" ? stat.isFile() : stat.isDirectory(); }
    catch (error) { if (!missing(error)) markUnknown(); return false; }
  };
  const skillsAt = (paths: string[], excludeSystem = false): string[] => {
    const names = new Map<string, string>();
    for (const path of paths) for (const name of children(path)) {
      if (excludeSystem && name === ".system") continue;
      if (is(join(path, name), "directory") && is(join(path, name, "SKILL.md"), "file")) {
        const safe = safeSkillName(name);
        if (!names.has(safe.toLowerCase())) names.set(safe.toLowerCase(), safe);
      }
    }
    return [...names.values()];
  };
  const items = (names: string[], origin: ToolItem["origin"]): ToolItem[] => names.map(name => ({ name, origin }));
  const unique = (items: ToolItem[], skill = false): ToolItem[] => {
    const found = new Map<string, ToolItem>();
    for (const item of items) {
      const id = skill ? item.name.toLowerCase() : item.name;
      if (!found.has(id)) found.set(id, item);
    }
    return byName([...found.values()]);
  };
  const claudeSkillPaths = [join(root, ".claude", "skills"), join(home, ".claude", "skills")];
  const notes = (): boolean => {
    const path = join(claudeNotesDir(root, home), "MEMORY.md");
    if (!is(path, "file")) return false;
    try { return !!text(path).trim(); } catch { return false; }
  };
  const inventory = (engine: EngineId): ToolInventory => {
    const cached = inventories.get(engine);
    if (cached) return cached;
    const result: ToolInventory = { mcp: [], skills: [], notes: "off", state: "ok" };
    const previous = markUnknown;
    markUnknown = () => { result.state = "unknown"; };
    try {
      if (engine === "claude") {
        const sources = io.sources({ projectFile: "", cwd: root, home }, { json, text });
        result.mcp = items(sources.filter(entry => entry.source !== "claude-settings" && !entry.claudeDisabled
          && (entry.source !== "mcp-json" || entry.mcpJsonApproved)).map(entry => safeMcpName(entry.name)), "engine");
        result.skills = items(skillsAt(claudeSkillPaths), "engine");
        result.notes = notes() ? "self" : "none";
      } else if (engine === "codex") {
        plan = io.plan(input.mcpInput(), { json, text });
        const own = io.ownMcp(input.skills.codexHome ?? join(home, ".codex"), root, text);
        if (!own.readable) markUnknown();
        result.mcp = [...items([...own.names].map(safeMcpName), "engine"), ...items(plan.passed.map(s => safeMcpName(s.name)), "tybo")];
        try { inspection = io.inspectSkills(input.skills, markUnknown); }
        catch { markUnknown(); inspection = { expected: [], linked: [], foreign: [], skipped: [] }; }
        result.skills = [
          ...items(inspection.linked.map(safeSkillName), "tybo"),
          ...items(inspection.foreign.map(safeSkillName), "engine"),
          ...items(skillsAt([join(root, ".codex", "skills"), join(input.skills.codexHome ?? join(home, ".codex"), "skills"),
            join(root, ".agents", "skills"), join(home, ".agents", "skills")], true), "engine"),
        ];
        result.notes = !input.claudeNotes ? "off" : notes() ? "passed" : "none";
      } else if (engine === "opencode") {
        result.mcp = items(readOpenCodeMcpNames(input.opencodeConfig, root, path => json(path, true), markUnknown), "engine");
        result.skills = items(skillsAt([
          ...(input.opencodeClaudeSkills ? claudeSkillPaths : []),
          join(root, ".agents", "skills"), join(home, ".agents", "skills"),
          join(root, ".opencode", "skills"), join(input.opencodeConfig, "skills"),
        ]), "engine");
      } else {
        result.mcp = items([...io.apiSpecs({ projectFile: join(root, "config", "mcp-servers.json"),
          extraFile: input.extraFile, claudeFile: join(home, ".claude.json") }, { quiet: true, readJson: json }).keys()].map(safeMcpName), "tybo");
      }
      result.mcp = unique(result.mcp);
      result.skills = unique(result.skills, true);
      inventories.set(engine, result);
      return result;
    } finally { markUnknown = previous; }
  };
  const gaps = (engine: EngineId): ToolGaps => {
    const cached = gapCache.get(engine);
    if (cached) return cached;
    const result: ToolGaps = { mcp: [], hints: [], skills: [], notes: false, plugins: null, fixed: [] };
    if (engine === "claude") return result;
    const baseline = inventory("claude");
    const current = inventory(engine);
    const haveMcp = new Set(current.mcp.map(s => s.name));
    const haveSkills = new Set(current.skills.map(s => s.name.toLowerCase()));
    const baselineMcp = new Set(baseline.mcp.map(s => s.name));
    for (const { name } of baseline.mcp) {
      if (haveMcp.has(name)) continue;
      const reason = engine === "codex" ? plan?.skipped.find(s => s.name === name)?.reason : "not_in_engine";
      if (MCP_GAP_REASONS.includes(reason as ToolGaps["mcp"][number]["reason"])) {
        result.mcp.push({ name, reason: reason as ToolGaps["mcp"][number]["reason"] });
      }
    }
    if (engine === "codex") {
      for (const skipped of plan!.skipped) {
        if (!["tybo", "extra", "claude-settings"].includes(skipped.source)) continue;
        if (baselineMcp.has(skipped.name) && skipped.reason !== "unsupported_source") continue;
        if (TOOL_HINT_REASONS.includes(skipped.reason as ToolGaps["hints"][number]["reason"])) {
          result.hints.push({ name: safeMcpName(skipped.name), reason: skipped.reason as ToolGaps["hints"][number]["reason"] });
        }
      }
    }
    if (engine !== "api") for (const { name } of baseline.skills) {
      if (haveSkills.has(name.toLowerCase())) continue;
      const skipped = inspection?.skipped.find(s => safeSkillName(s.name).toLowerCase() === name.toLowerCase());
      result.skills.push({ name, reason: engine !== "codex" ? "not_in_engine"
        : skipped?.reason ?? (!input.skills.enabled ? "skills_off" : "link_missing") });
    }
    result.notes = baseline.notes === "self" && !["self", "passed"].includes(current.notes);
    result.plugins = readClaudePluginCount(home, json);
    result.fixed = ["connectors", ...(result.plugins === null || result.plugins > 0 ? ["plugins" as const] : []), "hooks", "builtin",
      ...(engine === "api" ? ["skills" as const] : [])];
    byName(result.mcp); byName(result.hints); byName(result.skills);
    gapCache.set(engine, result);
    return result;
  };
  return { inventory, gaps };
}

export function toolInventory(engine: EngineId, input?: ToolParityInput): ToolInventory {
  return createToolParitySnapshot(input).inventory(engine);
}
export function toolGaps(engine: EngineId, input?: ToolParityInput): ToolGaps {
  return createToolParitySnapshot(input).gaps(engine);
}
