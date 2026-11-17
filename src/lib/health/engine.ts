/**
 * Zeile „Motor“ des Nachtchecks (Issue #568, gemeinsam mit #567): geprüft
 * wird der eingestellte Standard-Motor, nicht immer Claude Code.
 *
 * - Welcher Motor: wie zur Laufzeit defaultEngineSetting aus
 *   src/lib/engine-choice.ts, also engine.default in config/settings.json
 *   vor TYBO_ENGINE vor Claude Code.
 * - Wie: checkEngine aus src/lib/engines/check.ts (Version und Anmeldung,
 *   ohne Modellaufruf), dieselbe Prüfung wie /motor und die Statusseite.
 *   Nicht installiert, abgemeldet oder Anmeldung nicht prüfbar ist ❌: ob
 *   der Bot antwortet, ist dann offen (wie bei `tybo pruefen`). Eine nicht
 *   prüfbare Anmeldung heißt nie „abgemeldet“.
 * - Probeaufruf: nur für Claude Code und nur ohne --no-model ein Mini-Aufruf
 *   mit Haiku, ohne MCP, Werkzeuge, Einstellungen und Sitzung, in einem
 *   fremden Ordner. Die Umgebung ist gefiltert wie bei jedem
 *   Claude-Subprozess (subprocessEnv: keine Tokens und Schlüssel, der
 *   API-Schlüssel nur nach CLAUDE_AUTH); vorher bekam der Aufruf die ganze
 *   Umgebung des Nachtchecks. Andere Motoren bekommen keinen Probeaufruf.
 *
 * Alles Äußere steckt in EngineLineDeps; Tests rufen keinen Motor auf.
 */

import { tmpdir } from "node:os";
import type { CheckResult } from "../../health-check";
import type { EngineStatus } from "../engines/check";
import type { SelectableEngine } from "../settings";

export const ENGINE_CHECK = "Motor";
/** Zeitlimit des Probeaufrufs */
export const ENGINE_PROBE_TIMEOUT_MS = 115_000;

const LABELS: Record<SelectableEngine, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", api: "Anthropic API" };
const SOURCE_TEXT = { settings: "aus config/settings.json", env: "aus TYBO_ENGINE", code: "Standard" } as const;

export interface ProbeOutcome {
  ok: boolean;
  /** Grund bei !ok, ohne Ausgaben, die Geheimnisse enthalten könnten */
  why?: string;
  seconds: number;
}

export interface EngineLineDeps {
  standard(): Promise<{ engine: SelectableEngine; source: "settings" | "env" | "code" }>;
  check(engine: SelectableEngine): Promise<EngineStatus>;
  /** Mini-Aufruf an Claude Code; nur ohne --no-model und nur für Claude */
  probeClaude(): Promise<ProbeOutcome>;
}

/** Abhilfe je Motor, wenn er nicht bereit ist */
function hintFor(engine: SelectableEngine, status: EngineStatus): string {
  if (!status.installed) return engine === "claude" ? "claude --version im Terminal, PATH im Dienst prüfen (tybo pruefen)" : "tybo pruefen zeigt den Motor mit dem PATH des Diensts";
  if (engine === "codex") return "im Terminal codex login status, sonst codex login";
  if (engine === "opencode") return "im Terminal opencode auth list, sonst opencode auth login";
  if (engine === "api") return "ANTHROPIC_API_KEY in .env setzen";
  return "im Terminal claude auth status, sonst claude und /login";
}

/** Anmeldung ließ sich nicht feststellen (Zeitlimit, unlesbare Ausgabe), nicht „abgemeldet“ */
function loginUnknown(status: EngineStatus): boolean {
  return status.loginUnknown === true || /nicht prüfbar|nicht feststellen/.test(status.message ?? "");
}

export async function checkEngineLine(withModel: boolean, deps: EngineLineDeps): Promise<CheckResult> {
  const { engine, source } = await deps.standard();
  const label = LABELS[engine];
  const origin = `(${SOURCE_TEXT[source]})`;
  const status = await deps.check(engine);
  const name = status.version ? `${label} ${status.version}` : label;
  if (!status.installed) return { name: ENGINE_CHECK, status: "fail", detail: `${label} ${origin}: ${status.message ?? "nicht installiert"}`, hint: hintFor(engine, status) };
  if (!status.loggedIn) {
    const what = loginUnknown(status) ? `Anmeldung nicht prüfbar, heißt nicht abgemeldet (${status.message ?? "ohne Grund"})` : (status.message ?? "nicht angemeldet");
    return { name: ENGINE_CHECK, status: "fail", detail: `${name} ${origin}: ${what}`, hint: hintFor(engine, status) };
  }
  if (!withModel) return { name: ENGINE_CHECK, status: "ok", detail: `${name} ${origin}, angemeldet` };
  if (engine !== "claude") return { name: ENGINE_CHECK, status: "ok", detail: `${name} ${origin}, angemeldet (Probeaufruf nur bei Claude Code)` };
  const probe = await deps.probeClaude();
  if (!probe.ok) {
    return { name: ENGINE_CHECK, status: "fail", detail: `${name} ${origin}, angemeldet, Haiku-Aufruf scheitert (${probe.why ?? "ohne Grund"})`, hint: "Anmeldung/Limit prüfen: echo test | claude -p" };
  }
  return { name: ENGINE_CHECK, status: "ok", detail: `${name} ${origin}, Haiku antwortet (${probe.seconds} s)` };
}

export interface ProbeRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Befehl des Probeaufrufs (ohne MCP, Werkzeuge, Einstellungen, Sitzung) */
export function claudeProbeCommand(bin: string): string[] {
  return [
    bin, "-p", "Antworte nur mit: OK",
    "--model", "haiku",
    "--output-format", "json",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--no-session-persistence", "--disable-slash-commands",
    "--tools", "", "--setting-sources", "",
  ];
}

/**
 * Umgebung des Probeaufrufs: gefiltert wie jeder Claude-Subprozess, dazu
 * HOME und PATH; TYBO_SUBPROCESS=1 setzt subprocessEnv selbst.
 */
export function claudeProbeEnv(filtered: Record<string, string>, env: Record<string, string | undefined>): Record<string, string> {
  return { ...filtered, HOME: env.HOME ?? "", PATH: env.PATH ?? "", TYBO_SUBPROCESS: "1" };
}

/** Mini-Aufruf mit Haiku; run führt den Befehl im Ordner cwd aus */
export async function probeClaude(
  bin: string,
  env: Record<string, string>,
  run: (cmd: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number }) => Promise<ProbeRun>,
  now: () => number = Date.now
): Promise<ProbeOutcome> {
  const started = now();
  const call = await run(claudeProbeCommand(bin), { cwd: tmpdir(), env, timeoutMs: ENGINE_PROBE_TIMEOUT_MS });
  const seconds = Math.round((now() - started) / 1000);
  let parsed: { is_error?: boolean; result?: string; api_error_status?: number | null } | null = null;
  try {
    parsed = JSON.parse(call.stdout);
  } catch {
    parsed = null;
  }
  if (call.code === 0 && parsed && !parsed.is_error) return { ok: true, seconds };
  const why = parsed?.api_error_status ? `HTTP ${parsed.api_error_status}` : (parsed?.result ?? "").slice(0, 100) || `Exit ${call.code ?? "Zeitlimit"}`;
  return { ok: false, why, seconds };
}
