/**
 * Motor in der Einrichtung (Issue #566): welcher Standard-Motor gilt und ob
 * er bereit ist.
 *
 * Vorrang wie zur Laufzeit (src/lib/engine-choice.ts): engine.default in
 * config/settings.json, dann TYBO_ENGINE aus der .env des Projekts, dann
 * Claude Code. Eine ungültige settings.json zählt hier nicht (die Laufzeit
 * nähme ihre letzte gültige Fassung, die kennt die Einrichtung nicht).
 *
 * Geprüft wird über ctx.providers.engineCheck mit dem Befehlsläufer der
 * Einrichtung, im Projektordner und mit CODEX_PATH bzw. OPENCODE_PATH aus
 * der .env des Projekts. checkEngine selbst liest die Umgebung des
 * Prozesses und gälte damit für die Shell, nicht für das Projekt.
 */

import { readFile } from "node:fs/promises";
import { auxPlan, withoutClaudeSentence } from "../lib/claude-availability";
import { filterSubprocessEnv, SUBPROCESS_MARKER } from "../lib/subprocess-env";
import { SELECTABLE_ENGINES, settingsSchema, type SelectableEngine, type Settings } from "../lib/settings";
import { readSetupEnv, type SetupContext } from "./context";
import { presentValue, type StatusItem } from "./model";
import type { CheckedEngine } from "./providers";

/** Anzeigenamen wie ENGINE_LABELS in src/lib/engine-choice.ts (ohne dessen Abhängigkeiten zu laden) */
export const SETUP_ENGINE_LABELS: Record<SelectableEngine, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  api: "Anthropic API",
};

export function isSetupEngine(value: unknown): value is SelectableEngine {
  return typeof value === "string" && (SELECTABLE_ENGINES as readonly string[]).includes(value);
}

/** Gültige config/settings.json, sonst null (fehlt die Datei: leer) */
export async function readSetupSettings(ctx: SetupContext): Promise<Settings | null> {
  let raw: string;
  try {
    raw = await readFile(ctx.settingsPath, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? {} : null;
  }
  try {
    const parsed = settingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Standard-Motor des Projekts, mit Herkunft */
export async function setupEngine(ctx: SetupContext): Promise<{ engine: SelectableEngine; source: "settings" | "env" | "code" }> {
  const settings = await readSetupSettings(ctx);
  const fromSettings = settings?.engine?.default;
  if (fromSettings) return { engine: fromSettings, source: "settings" };
  const env = await readSetupEnv(ctx);
  const raw = presentValue(env, "TYBO_ENGINE")?.toLowerCase();
  if (isSetupEngine(raw)) return { engine: raw, source: "env" };
  return { engine: "claude", source: "code" };
}

const PATH_VAR: Record<CheckedEngine, string | undefined> = { codex: "CODEX_PATH", opencode: "OPENCODE_PATH", api: undefined };

/**
 * Prüfeintrag für einen Motor außer Claude Code. Umgebung: die Shell,
 * überlagert von der .env des Projekts, gefiltert wie beim Motor selbst.
 * path ersetzt den PATH (Issue #567: PATH aus der Dienstdatei des Bots),
 * ohne path gilt im Prüfbericht ctx.enginePath.
 */
export async function engineItem(ctx: SetupContext, engine: CheckedEngine, path?: string): Promise<StatusItem> {
  const env = await readSetupEnv(ctx);
  const source: Record<string, string | undefined> = { ...process.env };
  for (const [k, v] of Object.entries(env)) if (presentValue(env, k) !== undefined) source[k] = v;
  const servicePath = path ?? ctx.enginePath;
  if (servicePath !== undefined) source.PATH = servicePath;
  const filtered = { ...filterSubprocessEnv({ env: source, cwd: ctx.root, home: ctx.home, engine: engine === "api" ? "claude" : engine }).env, ...SUBPROCESS_MARKER };
  // Der Motor api braucht den Schlüssel selbst; geprüft wird nur, ob er da ist
  if (engine === "api") {
    const key = presentValue(env, "ANTHROPIC_API_KEY") ?? process.env.ANTHROPIC_API_KEY?.trim();
    if (key) filtered.ANTHROPIC_API_KEY = key;
    else delete filtered.ANTHROPIC_API_KEY;
  }
  const pathVar = PATH_VAR[engine];
  const command = pathVar ? presentValue(env, pathVar) : undefined;
  const result = await ctx.providers.engineCheck(engine, { cwd: ctx.root, env: filtered, ...(command ? { path: command } : {}) });
  return {
    label: SETUP_ENGINE_LABELS[engine],
    ok: result.ok,
    detail: result.message,
    ...(result.ok ? {} : { fix: ENGINE_FIX[engine] }),
  };
}

const ENGINE_FIX: Record<CheckedEngine, string> = {
  codex: "npm install -g @openai/codex  (dann: codex login)",
  opencode: "opencode auth login",
  api: "ANTHROPIC_API_KEY in der .env eintragen",
};

/**
 * Was ohne Claude fehlt, für die Warnung im Schritt „voraussetzungen“:
 * Nebenaufgaben je aufgelöstem Ziel (Einstellungen vor AUX_MODEL_* vor
 * Standard), damit eine über OpenRouter oder Ollama laufende nie als
 * abgeschaltet gilt.
 */
export async function withoutClaudeText(ctx: SetupContext): Promise<string> {
  const settings = (await readSetupSettings(ctx)) ?? {};
  return withoutClaudeSentence(auxPlan(settings, await readSetupEnv(ctx)));
}
