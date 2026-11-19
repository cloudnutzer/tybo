/** Werkzeuganzeige und lesender Ankunftsvergleich, getrennt vom Zeitbudget der Motor-Anmeldung. */
import { realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { codexEnv, codexSandbox } from "../../lib/engines/codex";
import { applyCodexMcpEnv, currentCodexMcpPlan, safeMcpName } from "../../lib/engines/codex-mcp";
import { inspectCodexSkillLinks } from "../../lib/engines/codex-skills";
import { createToolParitySnapshot, safeSkillName, type ToolParityInput, type ToolParitySnapshot } from "../../lib/engines/tool-parity";
import { MOTOR_TOOL_TEXT, toolSummary } from "../../lib/engines/tool-display";
import { CODEX_JOB_TOOL_ARGS, codexMcpDisableArgs, readCodexMcpServers } from "../../lib/jobs/codex-tools";
import { projectSecrets } from "../../lib/jobs/mask";
import { codexHomeDir, opencodeConfigDir } from "../../lib/subprocess-env";
import type { EngineTools } from "../../web/tool-parity-types";
import { readSetupEnv, type CommandRunner, type SetupContext } from "../context";
import { engineItem, readSetupSettings, SETUP_ENGINE_LABELS } from "../engine";
import type { CheckedEngine } from "../providers";
import type { Finding, SpecialCheck } from "./report";

export const TOOL_COMPARE_TIMEOUT_MS = 15_000;
export interface EngineToolDeps {
  snapshot(input: ToolParityInput): ToolParitySnapshot;
  codexEnv: typeof codexEnv;
  codexSandbox: typeof codexSandbox;
  plan: typeof currentCodexMcpPlan;
  applyEnv: typeof applyCodexMcpEnv;
  inspectSkills: typeof inspectCodexSkillLinks;
  mcpServers: typeof readCodexMcpServers;
  prompt: CommandRunner;
  ready(engine: CheckedEngine, signal: AbortSignal): Promise<boolean>;
  /** Nur Tests verkürzen die Wartezeit. */
  timeoutMs: number;
}

/** Keine globale .env, kein chdir und kein Einstellungs-Singleton im Prüfbericht. */
async function toolContext(ctx: SetupContext, d: EngineToolDeps) {
  const settings = await readSetupSettings(ctx);
  if (!settings) throw new Error("Einstellungen nicht lesbar");
  const source: Record<string, string | undefined> = { ...process.env, ...await readSetupEnv(ctx), HOME: ctx.home, PATH: ctx.enginePath ?? process.env.PATH ?? "" };
  // Relative Pfade gelten beim Bot im Projekt, nie im Aufrufordner von pruefen.
  for (const key of ["MCP_CONFIG_PATH", "CODEX_HOME", "OPENCODE_CONFIG_DIR"] as const) {
    if (source[key]) source[key] = resolve(ctx.root, source[key]);
  }
  const config = settings.engine?.codex;
  const baseEnv = () => d.codexEnv(ctx.root, undefined, { quiet: true, home: ctx.home, env: source });
  const mcpInput = () => ({ cwd: ctx.root, baseEnv: baseEnv(), sandbox: d.codexSandbox(settings), context: {
    parentEnv: () => source, projectRoot: () => ctx.root, settings: () => config?.mcp ?? {},
    lookup: (name: string) => source[name], secrets: projectSecrets,
  } });
  const disabled = [source.OPENCODE_DISABLE_CLAUDE_CODE, source.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS]
    .some(value => !!value && value !== "0" && value.toLowerCase() !== "false");
  const input: ToolParityInput = {
    skills: { root: ctx.root, home: ctx.home, codexHome: codexHomeDir(source, ctx.home), enabled: config?.skills !== false },
    opencodeConfig: opencodeConfigDir(source, ctx.home), extraFile: source.MCP_CONFIG_PATH,
    claudeNotes: config?.claudeNotes !== false, opencodeClaudeSkills: !disabled, mcpInput,
  };
  return { input, baseEnv, codexPath: source.CODEX_PATH || "codex", snapshot: d.snapshot(input) };
}
type ToolContext = Awaited<ReturnType<typeof toolContext>>;
type Comparison = { missing: string[]; checked: boolean } | null;

/** Jeder Vergleich hat sein eigenes Limit und bricht auch seine Kindprozesse ab. */
async function bounded<T>(ms: number, parent: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (parent?.aborted) throw new Error("nicht geprüft");
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, ms);
  let reject!: () => void;
  const expired = new Promise<never>((_, fail) => { reject = () => fail(new Error("nicht geprüft")); });
  controller.signal.addEventListener("abort", reject, { once: true });
  try {
    if (controller.signal.aborted) throw new Error("nicht geprüft");
    return await Promise.race([run(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", reject);
  }
}

async function compareMcp(context: ToolContext, d: EngineToolDeps, parent?: AbortSignal): Promise<Comparison> {
  try {
    return await bounded(d.timeoutMs, parent, async signal => {
      const input = context.input.mcpInput();
      const plan = d.plan(input);
      const env = d.applyEnv(input.baseEnv, plan);
      if (!plan.passed.length) return null;
      // Der Plan bleibt in dieser Funktion. Nur fehlende, bereinigte Namen
      // verlassen sie, niemals CLI-Antwort, Argumente, Umgebung oder Fehler.
      const actual = await d.mcpServers({ codexPath: context.codexPath, root: input.cwd, env, args: plan.args, signal });
      if (!Array.isArray(actual) || actual.some(name => typeof name !== "string")) throw new Error();
      return { checked: true, missing: plan.passed.filter(item => !actual.includes(item.name)).map(item => safeMcpName(item.name)) };
    });
  } catch { return { checked: false, missing: [] }; }
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/**
 * Codex 0.169.0 liefert JSON-Nachrichten mit einem skills_instructions-Block.
 * Die Datei-Orte sind maßgeblich: Kopfname und Linkname dürfen abweichen.
 * Unerwartete oder gekürzte Listen gelten nie als Beleg für fehlende Skills.
 */
export function parseCodexSkillNames(output: string, root: string): string[] {
  if (output.length > 4 * 1024 * 1024) throw new Error();
  const messages: unknown = JSON.parse(output);
  if (!Array.isArray(messages)) throw new Error();
  const blocks = messages.filter(m => m?.type === "message" && m.role === "developer" && Array.isArray(m.content))
    .flatMap(m => m.content).filter(c => c?.type === "input_text" && typeof c.text === "string" && c.text.startsWith("<skills_instructions>\n"));
  if (blocks.length !== 1) throw new Error();
  const text = blocks[0].text as string;
  if (!text.endsWith("</skills_instructions>")) throw new Error();
  const sections = /### Skill roots\n([\s\S]*?)### Available skills\n([\s\S]*?)(?=\n##|\n<\/skills_instructions>)/.exec(text);
  if (!sections) throw new Error();
  const roots = new Map<string, string>();
  for (const line of sections[1]!.trim().split("\n")) {
    const match = /^- `(r\d+)` = `([^`]+)`$/.exec(line);
    if (!match || roots.has(match[1]!)) throw new Error();
    roots.set(match[1]!, match[2]!);
  }
  const names: string[] = [];
  for (const line of sections[2]!.trim().split("\n")) {
    const match = /^- [^\n]+: [^\n]+ \(file: (r\d+)\/([^\n]+\/SKILL\.md)\)$/.exec(line);
    if (!match || !roots.has(match[1]!)) throw new Error();
    // Nicht den Link selbst auflösen: Codex nennt dessen Ort im Projekt.
    const path = resolve(roots.get(match[1]!)!, match[2]!);
    const local = relative(join(canonical(root), ".agents", "skills"), path);
    const folder = /^([^/]+)\/SKILL\.md$/.exec(local);
    if (folder) names.push(folder[1]!);
  }
  return names;
}

async function compareSkills(context: ToolContext, tools: EngineTools, d: EngineToolDeps, parent?: AbortSignal): Promise<Comparison> {
  try {
    return await bounded(d.timeoutMs, parent, async signal => {
      let unreadable = false;
      const inspection = d.inspectSkills(context.input.skills, () => { unreadable = true; });
      if (unreadable) throw new Error();
      if (!inspection.expected.length) return null;
      // debug prompt-input startet sonst eigene MCP-Server. Alle bekannten
      // Namen abschalten; bei unvollständigem Bestand vorsichtig nicht starten.
      if (tools.inventory.state !== "ok" || tools.inventory.mcp.some(item => item.name.startsWith("unzulaessig-") || safeMcpName(item.name) !== item.name)) throw new Error();
      const result = await d.prompt([context.codexPath, "debug", "prompt-input", "hallo", ...CODEX_JOB_TOOL_ARGS,
        ...codexMcpDisableArgs(tools.inventory.mcp.map(item => item.name))],
      { cwd: context.input.skills.root, env: context.baseEnv(), timeoutMs: d.timeoutMs, signal });
      if (result.code !== 0 || result.timedOut || result.aborted) throw new Error();
      const actual = parseCodexSkillNames(result.stdout, context.input.skills.root);
      return { checked: true, missing: inspection.expected.filter(name => !actual.includes(name)).map(safeSkillName) };
    });
  } catch { return { checked: false, missing: [] }; }
}

const shorten = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
function comparisonText(label: string, result: Comparison): string {
  if (!result) return "";
  if (!result.checked) return `${label}: nicht geprüft.`;
  if (!result.missing.length) return "";
  const names = result.missing.slice(0, 3).map(name => shorten(name, 18)).join(", ");
  return `${label} nicht angekommen: ${names}${result.missing.length > 3 ? ` (+${result.missing.length - 3})` : ""}.`;
}

function depsFor(ctx: SetupContext, overrides: Partial<EngineToolDeps>): EngineToolDeps {
  return { snapshot: createToolParitySnapshot, codexEnv, codexSandbox, plan: currentCodexMcpPlan, applyEnv: applyCodexMcpEnv,
    inspectSkills: inspectCodexSkillLinks, mcpServers: readCodexMcpServers, prompt: (cmd, options) => ctx.run(cmd, options),
    ready: async (engine, signal) => (await engineItem(ctx, engine, undefined, signal)).ok,
    timeoutMs: TOOL_COMPARE_TIMEOUT_MS, ...overrides };
}

/** „Installiert“ wird vorsichtig als bereit gewertet, wie bei /motor. */
export async function engineToolFindings(ctx: SetupContext, engine: CheckedEngine, overrides: Partial<EngineToolDeps> = {}, signal?: AbortSignal,
  contextFor?: (d: EngineToolDeps) => Promise<ToolContext>): Promise<Finding[]> {
  const d = depsFor(ctx, overrides);
  try { if (!await bounded(11_000, signal, s => d.ready(engine, s))) return []; }
  catch { return []; }
  const label = `Werkzeuge ${SETUP_ENGINE_LABELS[engine]}`;
  try {
    const context = await (contextFor ? contextFor(d) : toolContext(ctx, d));
    const tools = { inventory: context.snapshot.inventory(engine), gaps: context.snapshot.gaps(engine) };
    const results = engine === "codex" ? await Promise.all([compareMcp(context, d, signal), compareSkills(context, tools, d, signal)]) : [];
    const suffix = [comparisonText("MCP", results[0] ?? null), comparisonText("Skills", results[1] ?? null)].filter(Boolean).join(" ");
    const summary = toolSummary(tools);
    return [{ label, status: results.some(r => r?.missing.length) ? "warn" : "pass",
      detail: suffix ? `${shorten(summary, 299 - suffix.length)} ${suffix}` : shorten(summary, 300) }];
  } catch {
    return [{ label, status: "pass", detail: `${MOTOR_TOOL_TEXT.toolsUnknown}${engine === "codex" ? ". MCP: nicht geprüft. Skills: nicht geprüft." : ""}` }];
  }
}

/** Je Motor maximal 11 s Bereitschaft plus zwei parallele Vergleiche à 15 s. */
export function engineToolChecks(overrides: Partial<EngineToolDeps> = {}): SpecialCheck[] {
  const contexts = new WeakMap<SetupContext, Promise<ToolContext>>();
  return (["codex", "opencode", "api"] as const).map(engine => ({
    id: `werkzeuge-${engine}`, section: "Motor",
    run: ({ ctx, signal }) => engineToolFindings(ctx, engine, overrides, signal, d => {
      if (!contexts.has(ctx)) contexts.set(ctx, toolContext(ctx, d));
      return contexts.get(ctx)!;
    }),
  }));
}
