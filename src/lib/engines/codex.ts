/**
 * Codex als Motor (Entscheidung 0018, Issue #123): die Codex-CLI von OpenAI
 * mit `codex exec --json`, angemeldet über `codex login` (ChatGPT-Konto).
 *
 * Aufbau:
 * - parseCodexEvent: eine JSONL-Zeile in ein Ereignis übersetzen (rein)
 * - CodexTurn: Ereignisse eines Laufs sammeln, daraus Antwort, Session,
 *   Werkzeuge und Nutzung ableiten (rein)
 * - createLineReader: Bytes aus stdout in ganze Zeilen zerlegen
 * - codexArgs: Kommandozeile für neuen Lauf und Fortsetzen, mit
 *   Projekt-Kontext (CLAUDE.md) und Rechte-Stufe (Issue #124)
 * - createCodexEngine: Prozess starten, Zeitlimits, Abbruch
 *
 * Werkzeuge erscheinen mit Claude-Namen (WebSearch, mcp__<server>__<tool>,
 * Bash, Edit, Task), damit die Regeln in src/lib/turn-tools.ts unverändert
 * greifen. Modell und Effort werden nur gesetzt, wenn angegeben; sonst gilt
 * die Konfiguration von Codex (~/.codex/config.toml).
 */

import { spawn } from "bun";
import { checkAborted, currentExecution } from "../execution-context";
import { firstTextSnippet, friendlyToolName, IDLE_CHECK_INTERVAL_MS, MAX_RUN_STEPS, type RunStep } from "../claude";
import { subprocessEnv } from "../subprocess-env";
import { terminateProcessTree } from "../process-tree";
import type { ToolUse, TurnTools } from "../turn-tools";
import { MASK, maskSecrets, projectSecrets } from "../jobs/mask";
import { registerEngineCall, unregisterEngineCall, type EngineProc } from "./calls";
import type { Engine, EngineErrorKind, EngineRequest, EngineResult, EngineUsage } from "./types";
import { DEFAULT_CODEX_SANDBOX, getSettings, type CodexSandbox } from "../settings";

const IS_MACOS = process.platform === "darwin";
const IS_WINDOWS = process.platform === "win32";
const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "";

/** Pfad der Codex-CLI, wie CLAUDE_PATH für Claude */
export function codexPath(): string {
  return process.env.CODEX_PATH || "codex";
}

/**
 * Umgebung eines Codex-Prozesses (Issue #124): Geheimnisse gefiltert mit den
 * Codex-Regeln (MCP-Verweise aus der config.toml von Codex), CODEX_HOME
 * bleibt, dazu HOME und PATH.
 */
export function codexEnv(cwd: string, conversationKey?: string): Record<string, string> {
  return {
    ...subprocessEnv({ cwd, home: HOME_DIR, conversationKey, engine: "codex" }),
    HOME: HOME_DIR,
    PATH: process.env.PATH || "",
  };
}

// ---------------------------------------------------------------------------
// Ereignisse
// ---------------------------------------------------------------------------

/** Ein Item des Ereignisstroms, auf das reduziert, was tybo braucht */
export interface CodexItem {
  id: string;
  /** agent_message, reasoning, command_execution, file_change, mcp_tool_call, web_search, ... */
  kind: string;
  /** Nur agent_message */
  text?: string;
  /** Werkzeugaufrufe mit Claude-Namen; leer bei Items ohne Werkzeug */
  tools: ToolUse[];
  /** Schritt für den Timeout-Bericht; nur bei Werkzeug-Items */
  step?: RunStep;
}

export type CodexEvent =
  | { type: "thread.started"; sessionId: string }
  | { type: "turn.started" }
  | { type: "item"; phase: "started" | "updated" | "completed"; item: CodexItem }
  | { type: "turn.completed"; usage?: EngineUsage }
  | { type: "turn.failed"; message: string }
  | { type: "error"; message: string }
  | { type: "unknown" };

/** Item-Arten, die ein Werkzeug sind (beenden eine Zwischenmeldung) */
const TOOL_ITEM_KINDS = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search", "collab_tool_call"]);

const MAX_COMMAND_CHARS = 2000;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Werkzeuge und Schritt eines Items mit Claude-Namen */
function toolsOf(kind: string, raw: any): { tools: ToolUse[]; step?: RunStep } {
  switch (kind) {
    case "web_search": {
      const query = str(raw.query);
      return { tools: [{ name: "WebSearch" }], step: query ? { name: "WebSearch", input: query } : { name: "WebSearch" } };
    }
    case "mcp_tool_call": {
      const name = `mcp__${str(raw.server) ?? "unbekannt"}__${str(raw.tool) ?? "unbekannt"}`;
      return { tools: [{ name }], step: { name } };
    }
    case "command_execution": {
      const command = str(raw.command);
      return {
        tools: [command ? { name: "Bash", command: command.slice(0, MAX_COMMAND_CHARS) } : { name: "Bash" }],
        step: command ? { name: "Bash", input: command } : { name: "Bash" },
      };
    }
    case "file_change": {
      const paths = (Array.isArray(raw.changes) ? raw.changes : []).map((c: any) => str(c?.path)).filter(Boolean) as string[];
      return {
        tools: paths.length > 0 ? paths.map((path) => ({ name: "Edit", path })) : [{ name: "Edit" }],
        step: paths.length > 0 ? { name: "Edit", input: paths.join(", ") } : { name: "Edit" },
      };
    }
    case "collab_tool_call": {
      const prompt = str(raw.prompt);
      return { tools: [{ name: "Task" }], step: prompt ? { name: "Task", input: prompt } : { name: "Task" } };
    }
    default:
      return { tools: [] };
  }
}

function usageOf(raw: any): EngineUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage: EngineUsage = {};
  const input = num(raw.input_tokens);
  const cached = num(raw.cached_input_tokens);
  const output = num(raw.output_tokens);
  const reasoning = num(raw.reasoning_output_tokens);
  if (input !== undefined) usage.inputTokens = input;
  if (cached !== undefined) usage.cachedInputTokens = cached;
  if (output !== undefined) usage.outputTokens = output;
  if (reasoning !== undefined) usage.reasoningOutputTokens = reasoning;
  return usage;
}

/**
 * Eine Zeile aus `codex exec --json` als Ereignis. null bei leeren oder
 * kaputten Zeilen und bei JSON, das kein Ereignis ist; unbekannte
 * Ereignistypen ergeben { type: "unknown" } (zählen als Lebenszeichen).
 */
export function parseCodexEvent(line: string): CodexEvent | null {
  if (!line.trim()) return null;
  let e: any;
  try {
    e = JSON.parse(line);
  } catch {
    return null;
  }
  if (!e || typeof e !== "object" || typeof e.type !== "string") return null;
  switch (e.type) {
    case "thread.started": {
      const id = str(e.thread_id);
      return id ? { type: "thread.started", sessionId: id } : { type: "unknown" };
    }
    case "turn.started":
      return { type: "turn.started" };
    case "turn.completed": {
      const usage = usageOf(e.usage);
      return usage ? { type: "turn.completed", usage } : { type: "turn.completed" };
    }
    case "turn.failed":
      return { type: "turn.failed", message: str(e.error?.message) ?? "turn failed" };
    case "error":
      return { type: "error", message: str(e.message) ?? "error" };
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const raw = e.item;
      if (!raw || typeof raw !== "object" || !str(raw.id) || !str(raw.type)) return { type: "unknown" };
      const kind = raw.type as string;
      const item: CodexItem = { id: raw.id, kind, ...toolsOf(kind, raw) };
      if (kind === "agent_message" && typeof raw.text === "string") item.text = raw.text;
      return { type: "item", phase: e.type.slice("item.".length) as "started" | "updated" | "completed", item };
    }
    default:
      return { type: "unknown" };
  }
}

// ---------------------------------------------------------------------------
// Fehlerarten
// ---------------------------------------------------------------------------

/** Erkennungsmuster, in dieser Reihenfolge geprüft (Text klein, ’ als ') */
const ERROR_PATTERNS: [EngineErrorKind, RegExp][] = [
  ["usage_limit", /hit your usage limit|usage limit/],
  ["quota", /quota exceeded|insufficient_quota|exceeded your current quota/],
  ["rate_limit", /rate limit|too many requests|\b429\b/],
  ["capacity", /at capacity|overloaded|server_is_overloaded/],
  ["context", /context window|context_length_exceeded|maximum context length/],
  [
    "auth",
    /not logged in|codex login|please log in|log in again|sign in again|unauthorized|\b401\b|authentication|refresh token|access token could not be refreshed/,
  ],
];

/**
 * Art eines Codex-Fehlers aus seiner Meldung. Nur auf Fehlermeldungen
 * anwenden (turn.failed, error, stderr), nie auf Antworttext: eine Antwort,
 * die „usage limit" zitiert, ist kein Fehler.
 */
export function codexErrorKind(message: string): EngineErrorKind {
  const text = message.toLowerCase().replace(/[’‘`´]/g, "'");
  for (const [kind, pattern] of ERROR_PATTERNS) if (pattern.test(text)) return kind;
  return "other";
}

/** Start gescheitert: Codex fehlt (nur prüfen, wenn kein Ereignis kam) */
const NOT_INSTALLED = /no such file or directory|command not found|enoent|not found in path/i;

// ---------------------------------------------------------------------------
// Diagnosen ohne Zugangsdaten
// ---------------------------------------------------------------------------

/** Muster für Zugangsdaten, die in keiner bekannten Liste stehen */
const SECRET_PATTERNS: [RegExp, string][] = [
  // Zugangsdaten in Adressen: https://nutzer:passwort@host
  [/\/\/[^\s/:@]+:[^\s/@]+@/g, `//${MASK}@`],
  // Authorization: Bearer <token>, Basic <daten>
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${MASK}`],
  // Name mit key/token/secret/password/... und ein Wert dahinter
  [
    /\b([\w-]*(?:api[_-]?key|key|token|secret|password|passwd|pwd|auth|authorization|cookie|credential|session)[\w-]*)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
    `$1$2${MASK}`,
  ],
  // JWT
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, MASK],
  // Schlüssel mit bekanntem Vorsatz (sk-..., sess-..., ghp_..., xox...-)
  [/\b(?:sk|sess|rk|pk)-[A-Za-z0-9_-]{8,}/g, MASK],
  [/\b(?:gh[pousr]|github_pat|xox[abprs]|glpat)[-_][A-Za-z0-9_-]{8,}/g, MASK],
  // Lange Zeichenfolgen aus Buchstaben und Ziffern (Schlüssel ohne Vorsatz)
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, MASK],
];

/**
 * Text aus stderr, Startfehlern und Fehler-Ereignissen von Codex, bevor er
 * ins Log oder in eine Fehlermeldung geht: bekannte Werte (.env des
 * Projekts, geheim benannte Variablen der Umgebung) und typische Formen von
 * Zugangsdaten werden ersetzt.
 */
export function redactCodexDiagnostic(text: string): string {
  const root = process.env.GO_PROJECT_ROOT || process.cwd();
  let out = maskSecrets(text, projectSecrets(root));
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

// ---------------------------------------------------------------------------
// Ein Lauf
// ---------------------------------------------------------------------------

export interface CodexTurnCallbacks {
  /** Werkzeug-Item zum ersten Mal gesehen (Anzeigename); ungedrosselt, drosseln tut der Aufrufer */
  onTool?: (displayName: string) => void;
  /** Erste Antwort (agent_message) mit mehr als 30 Zeichen */
  onFirstText?: (snippet: string, fullText: string) => void;
}

export interface CodexTurnResult {
  text: string;
  sessionId?: string;
  isError: boolean;
  errorKind?: EngineErrorKind;
  usage?: EngineUsage;
  tools: TurnTools;
  steps: RunStep[];
  /** Letztes agent_message, ungekürzt (Timeout-Bericht) */
  lastText?: string;
}

/**
 * Sammelt die Ereignisse eines Laufs.
 *
 * Antworttext: alle agent_message-Items nach dem letzten Werkzeug-Item, mit
 * Leerzeile verbunden (wie bei Claude mehrere finale Turns, etwa nach einem
 * Hook). Zwischenmeldungen vor einem Werkzeug gehören nicht dazu. Gibt es
 * nach dem letzten Werkzeug keine Nachricht, gilt das letzte agent_message.
 * Items werden nach ID geführt: item.updated/item.completed desselben Items
 * ersetzen seinen Stand, statt ihn doppelt auszugeben.
 *
 * Fehler: erfolgreich ist ein Lauf nur mit turn.completed, ohne turn.failed
 * und mit Exit-Code 0. Ein error-Ereignis allein ist kein Fehler, wenn der
 * Turn danach abgeschlossen wurde (Codex meldet so auch Wiederholungen).
 */
export class CodexTurn {
  sessionId?: string;
  usage?: EngineUsage;
  completed = false;
  failedMessage?: string;
  errorMessage?: string;
  /** Mindestens eine gültige Zeile gesehen */
  sawEvent = false;
  private readonly items = new Map<string, CodexItem>();
  private readonly announced = new Set<string>();
  private firstTextSent = false;

  constructor(private readonly callbacks: CodexTurnCallbacks = {}) {}

  apply(event: CodexEvent): void {
    this.sawEvent = true;
    switch (event.type) {
      case "thread.started":
        this.sessionId = event.sessionId;
        return;
      case "turn.completed":
        this.completed = true;
        if (event.usage) this.usage = event.usage;
        return;
      case "turn.failed":
        this.failedMessage = event.message;
        return;
      case "error":
        this.errorMessage = event.message;
        return;
      case "item": {
        const { item } = event;
        const previous = this.items.get(item.id);
        // Späterer Stand ersetzt den früheren; ein Werkzeug ohne Angaben im
        // Abschluss behält die Angaben vom Start
        const keepStart = previous && item.tools.length === 0 && previous.tools.length > 0;
        this.items.set(item.id, keepStart ? { ...item, tools: previous.tools, step: previous.step } : item);
        if (TOOL_ITEM_KINDS.has(item.kind) && !this.announced.has(item.id)) {
          this.announced.add(item.id);
          const name = item.tools[0]?.name;
          if (name) this.callbacks.onTool?.(friendlyToolName(name));
        }
        if (item.kind === "agent_message" && item.text && !this.firstTextSent && item.text.length > 30) {
          this.firstTextSent = true;
          this.callbacks.onFirstText?.(firstTextSnippet(item.text), item.text);
        }
        return;
      }
      default:
        return;
    }
  }

  /** Alle Werkzeugaufrufe, je Item einmal, in Reihenfolge */
  toolUses(): ToolUse[] {
    return [...this.items.values()].flatMap((i) => i.tools);
  }

  /** Die letzten Werkzeugschritte (höchstens MAX_RUN_STEPS) */
  steps(): RunStep[] {
    const all = [...this.items.values()].flatMap((i) => (i.step ? [i.step] : []));
    return all.slice(-MAX_RUN_STEPS);
  }

  lastText(): string | undefined {
    const messages = [...this.items.values()].filter((i) => i.kind === "agent_message" && i.text?.trim());
    return messages.at(-1)?.text;
  }

  /** Antworttext nach der Regel oben */
  answer(): string {
    const finals: string[] = [];
    for (const item of this.items.values()) {
      if (TOOL_ITEM_KINDS.has(item.kind)) finals.length = 0;
      else if (item.kind === "agent_message" && item.text?.trim()) finals.push(item.text.trim());
    }
    if (finals.length > 0) return finals.join("\n\n");
    return this.lastText()?.trim() ?? "";
  }

  /**
   * Ergebnis nach Prozessende; stderr nur für Fehlermeldungen. Die
   * Fehlermeldung ist bereinigt (redactCodexDiagnostic), die Fehlerart kommt
   * aus dem ungekürzten Text.
   */
  result(o: { exitCode: number | null; stderr?: string; cwd: string }): CodexTurnResult {
    const tools: TurnTools = { uses: this.toolUses(), cwd: o.cwd };
    const base = {
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.usage ? { usage: this.usage } : {}),
      tools,
      steps: this.steps(),
      ...(this.lastText() ? { lastText: this.lastText() } : {}),
    };
    const ok = this.completed && !this.failedMessage && o.exitCode === 0;
    if (ok) return { ...base, text: this.answer(), isError: false };
    const stderr = (o.stderr ?? "").trim();
    const message =
      this.failedMessage ??
      this.errorMessage ??
      (stderr ? lastLines(redactCodexDiagnostic(stderr), 5) : undefined) ??
      (this.completed ? `Codex endete mit Exit-Code ${o.exitCode}` : `Codex endete ohne Abschluss (Exit-Code ${o.exitCode})`);
    const errorKind = !this.sawEvent && NOT_INSTALLED.test(stderr) ? "not_installed" : codexErrorKind(message);
    return { ...base, text: redactCodexDiagnostic(message), isError: true, errorKind };
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function lastLines(text: string, n: number): string {
  return text.split("\n").slice(-n).join("\n").slice(-1000);
}

// ---------------------------------------------------------------------------
// Zeilenleser
// ---------------------------------------------------------------------------

/**
 * Zerlegt stdout in Zeilen: Zeilen über mehrere Chunks, geteilte
 * UTF-8-Zeichen und eine letzte Zeile ohne Zeilenumbruch (end) kommen
 * vollständig an.
 */
export function createLineReader(onLine: (line: string) => void): { push(chunk: Uint8Array): void; end(): void } {
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    push(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    },
    end() {
      const rest = buffer + decoder.decode();
      buffer = "";
      if (rest) onLine(rest);
    },
  };
}

// ---------------------------------------------------------------------------
// Kommandozeile
// ---------------------------------------------------------------------------

/** Effort-Stufe als TOML-Wert: nur Kleinbuchstaben (low, medium, high, xhigh, max, ...) */
const EFFORT = /^[a-z]+$/;
/** Modellname: kein führender Bindestrich, keine Leer- oder Sonderzeichen */
const MODEL = /^[A-Za-z0-9][\w.:/-]*$/;
/** Session-ID (UUID oder Thread-Name ohne Leerzeichen), nie mit Bindestrich vorn */
const SESSION_ID = /^[A-Za-z0-9][\w.:-]*$/;

/**
 * Projekt-Kontext (Entscheidung 0018): Codex liest dieselbe CLAUDE.md wie
 * Claude Code, wenn keine AGENTS.md (oder AGENTS.override.md) im Projekt
 * liegt. 64 KiB, weil die CLAUDE.md über dem Codex-Standard von 32 KiB liegt.
 */
export const CODEX_PROJECT_DOC_ARGS: readonly string[] = [
  "-c",
  'project_doc_fallback_filenames=["CLAUDE.md"]',
  "-c",
  "project_doc_max_bytes=65536",
];

/** Nie nachfragen: exec läuft ohne Mensch am Terminal */
const NO_APPROVALS = ["-c", 'approval_policy="never"'];
const NETWORK = ["-c", "sandbox_workspace_write.network_access=true"];

/**
 * Rechte-Argumente einer Stufe. Neuer Lauf mit --sandbox bzw.
 * --dangerously-bypass-approvals-and-sandbox, Fortsetzen mit
 * -c sandbox_mode=… (full entspricht danger-full-access). approval_policy
 * steht immer dabei.
 */
export function codexSandboxArgs(sandbox: CodexSandbox, resume: boolean): string[] {
  switch (sandbox) {
    case "read-only":
      return [...(resume ? ["-c", 'sandbox_mode="read-only"'] : ["--sandbox", "read-only"]), ...NO_APPROVALS];
    case "workspace-write":
      return [
        ...(resume ? ["-c", 'sandbox_mode="workspace-write"'] : ["--sandbox", "workspace-write"]),
        ...NETWORK,
        ...NO_APPROVALS,
      ];
    case "full":
      return [
        ...(resume ? ["-c", 'sandbox_mode="danger-full-access"'] : ["--dangerously-bypass-approvals-and-sandbox"]),
        ...NO_APPROVALS,
      ];
    default:
      throw new Error("Ungültige Codex-Rechte-Stufe");
  }
}

/** Rechte-Stufe aus den Einstellungen (engine.codex.sandbox), sonst full; bei jedem Lauf neu gelesen */
export function codexSandbox(): CodexSandbox {
  return getSettings().engine?.codex?.sandbox ?? DEFAULT_CODEX_SANDBOX;
}

const SANDBOX_TEXT: Record<CodexSandbox, string> = {
  full: "Voller Zugriff, ohne Sandbox",
  "workspace-write": "Projekt schreiben, mit Netz",
  "read-only": "Nur lesen",
};

let loggedSandbox: CodexSandbox | undefined;

/** Schreibt die Rechte-Stufe beim ersten Lauf ins Log und wieder, wenn sie sich ändert */
function logSandbox(sandbox: CodexSandbox): void {
  if (loggedSandbox === sandbox) return;
  loggedSandbox = sandbox;
  console.log(`[Codex] Rechte-Stufe: ${sandbox} (${SANDBOX_TEXT[sandbox]}), Einstellung engine.codex.sandbox`);
}

/** Nur für Tests: das Log der Rechte-Stufe zurücksetzen */
export function resetCodexSandboxLogForTests(): void {
  loggedSandbox = undefined;
}

/**
 * Argumente nach `codex`: neuer Lauf mit -C <cwd>, Fortsetzen mit
 * `exec resume` (kennt kein -C, das Arbeitsverzeichnis kommt aus dem cwd des
 * Prozesses). Jeder Aufruf trägt Projekt-Kontext und Rechte (Standard full).
 * Prompt immer über stdin (`-`). Wirft bei ungültigen Angaben, statt sie als
 * Option durchzureichen.
 */
export function codexArgs(
  req: Pick<EngineRequest, "model" | "effort" | "resumeSessionId" | "cwd"> & { sandbox?: CodexSandbox }
): string[] {
  // Fehlermeldungen ohne den Wert: er kann Zugangsdaten enthalten
  if (req.model !== undefined && req.model !== "" && !MODEL.test(req.model)) throw new Error("Ungültiges Codex-Modell");
  if (req.effort !== undefined && req.effort !== "" && !EFFORT.test(req.effort)) throw new Error("Ungültige Effort-Stufe");
  const resume = Boolean(req.resumeSessionId);
  const options = [
    "--json",
    ...(req.model ? ["-m", req.model] : []),
    ...(req.effort ? ["-c", `model_reasoning_effort="${req.effort}"`] : []),
    ...CODEX_PROJECT_DOC_ARGS,
    ...codexSandboxArgs(req.sandbox ?? DEFAULT_CODEX_SANDBOX, resume),
  ];
  if (req.resumeSessionId) {
    if (!SESSION_ID.test(req.resumeSessionId)) throw new Error("Ungültige Codex-Session");
    return ["exec", "resume", ...options, "--skip-git-repo-check", req.resumeSessionId, "-"];
  }
  return ["exec", ...options, "-C", req.cwd, "--skip-git-repo-check", "-"];
}

// ---------------------------------------------------------------------------
// Prozess, Zeitlimits, Abbruch
// ---------------------------------------------------------------------------

/** So lange nach SIGINT, bis der Prozessbaum mit SIGKILL beendet wird */
export const CODEX_KILL_GRACE_MS = 3_000;
/** Höchstens ein Werkzeug-Rückruf so oft (wie bei Claude) */
const TOOL_THROTTLE_MS = 5_000;

type CodexSignal = "SIGINT" | "SIGKILL";

/**
 * Prozessstart, Uhr, Timer und Signale des Codex-Motors. Tests ersetzen sie
 * (setCodexRuntimeForTests): eine Attrappe darf nie echte Signale bekommen.
 */
export interface CodexRuntime {
  spawn: typeof spawn;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  /** Signal an die Prozessgruppe des Prozesses */
  signal: (proc: EngineProc, signal: CodexSignal) => void;
}

/** Signal an die Prozessgruppe; auch der OpenCode-Motor nutzt es */
export function signalProcessGroup(proc: EngineProc, signal: CodexSignal): void {
  // pid 0 oder 1 träfe die eigene Prozessgruppe bzw. alle Prozesse
  if (!(proc.pid > 1)) return;
  if (IS_WINDOWS) {
    // Kein SIGINT an Prozessgruppen: gleich den Baum beenden
    if (signal === "SIGINT") terminateProcessTree(proc as any);
    return;
  }
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try {
      (proc.kill as (s?: number) => void)(signal === "SIGKILL" ? 9 : 2);
    } catch {}
  }
}

const defaultRuntime: CodexRuntime = {
  spawn,
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  signal: signalProcessGroup,
};

let runtime: CodexRuntime = defaultRuntime;

/** Laufzeit für andere Codex-Aufrufe (Anmeldeprüfung in check.ts) */
export function codexRuntime(): CodexRuntime {
  return runtime;
}

/** Nur für Tests: Prozessstart, Uhr, Timer und Signale ersetzen, null stellt zurück. */
export function setCodexRuntimeForTests(r: Partial<CodexRuntime> | null): void {
  runtime = r ? { ...defaultRuntime, ...r } : defaultRuntime;
}

const terminating = new WeakSet<object>();

/**
 * Beendet einen Codex-Lauf: erst SIGINT an die Prozessgruppe (Codex
 * unterbricht den Turn), nach CODEX_KILL_GRACE_MS SIGKILL. Mehrfache Aufrufe
 * für denselben Prozess (/stop zweimal, Abbruch und Zeitlimit) senden nichts
 * doppelt.
 */
export function terminateCodexProcess(proc: EngineProc, rt: CodexRuntime = runtime): void {
  if (terminating.has(proc)) return;
  terminating.add(proc);
  rt.signal(proc, "SIGINT");
  const timer = rt.setTimeout(() => rt.signal(proc, "SIGKILL"), CODEX_KILL_GRACE_MS);
  (timer as { unref?: () => void } | undefined)?.unref?.();
}

export function createCodexEngine(): Engine {
  return {
    id: "codex",
    describe: () => "Codex",
    run: (req) => runCodex(req),
  };
}

async function runCodex(req: EngineRequest): Promise<EngineResult> {
  const rt = runtime;
  const cwd = req.cwd || process.cwd();
  let args: string[];
  try {
    const sandbox = codexSandbox();
    args = codexArgs({ ...req, cwd, sandbox });
    logSandbox(sandbox);
  } catch (err) {
    return { engine: "codex", text: redactCodexDiagnostic(errorText(err)), isError: true, errorKind: "other" };
  }
  const cmd = IS_MACOS ? ["/usr/bin/caffeinate", "-i", codexPath(), ...args] : [codexPath(), ...args];

  checkAborted();
  const start = () =>
    rt.spawn({
      detached: !IS_WINDOWS,
      cmd,
      cwd,
      env: codexEnv(cwd, currentExecution()?.key),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  let proc: ReturnType<typeof start>;
  try {
    proc = start();
  } catch (err) {
    const reason = redactCodexDiagnostic(errorText(err));
    console.error("[Codex] Start fehlgeschlagen:", reason);
    return { engine: "codex", text: `Codex konnte nicht gestartet werden: ${reason}`, isError: true, errorKind: "not_installed" };
  }

  // stderr parallel lesen, damit eine volle Pipe den Prozess nicht blockiert
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");
  // Nach dem Prozessende ist die PID frei und kann wiederverwendet sein:
  // danach keine Signale und keine Diagnosen mehr für diesen Lauf
  let exited = false;
  const exitedPromise = proc.exited.then(
    (code) => ((exited = true), code),
    () => ((exited = true), null)
  );

  let abortEntry: ReturnType<typeof registerEngineCall>;
  try {
    abortEntry = registerEngineCall(req.abortKey, proc, (p) => terminateCodexProcess(p, rt));
  } catch (err) {
    // Ausführung wurde zwischen Start und Anmeldung abgebrochen: Prozess nicht verwaist lassen
    terminateCodexProcess(proc, rt);
    throw err;
  }

  // Zeitlimits wie bei Claude (Issue #178): Gesamtzeit immer, Leerlauf nur im
  // Streaming. Sie laufen schon während der Prompt-Übergabe, damit auch ein
  // stockendes stdin den Lauf beendet.
  const startedAt = rt.now();
  let lastActivityAt = startedAt;
  let timedOut = false;
  let timeoutKind: "idle" | "total" | undefined;
  let stoppedAfterMs = 0;
  let idleForMs = 0;
  /** Bereinigter Grund, wenn der Prompt nicht übergeben werden konnte */
  let promptError: string | undefined;
  const stopFor = (kind: "idle" | "total") => {
    if (timedOut || abortEntry.aborted || promptError !== undefined) return;
    const now = rt.now();
    timedOut = true;
    timeoutKind = kind;
    stoppedAfterMs = now - startedAt;
    idleForMs = now - lastActivityAt;
    terminateCodexProcess(proc, rt);
  };
  const timeoutId = rt.setTimeout(() => stopFor("total"), req.timeoutMs);
  const idleTimeoutMs = req.streaming ? req.idleTimeoutMs : undefined;
  const idleCheckId =
    idleTimeoutMs && idleTimeoutMs > 0
      ? rt.setInterval(() => {
          if (rt.now() - lastActivityAt >= idleTimeoutMs) stopFor("idle");
        }, Math.min(IDLE_CHECK_INTERVAL_MS, idleTimeoutMs))
      : undefined;
  const clearTimers = () => {
    rt.clearTimeout(timeoutId);
    if (idleCheckId !== undefined) rt.clearInterval(idleCheckId);
  };

  const stopped = () => timedOut || abortEntry.aborted || promptError !== undefined;
  let lastToolAt = -Infinity;
  const turn = new CodexTurn(
    req.streaming
      ? {
          onTool: (name) => {
            if (stopped() || !req.onToolStart) return;
            const now = rt.now();
            if (now - lastToolAt < TOOL_THROTTLE_MS) return;
            lastToolAt = now;
            req.onToolStart(name);
          },
          onFirstText: (snippet, full) => {
            if (!stopped()) req.onFirstText?.(snippet, full);
          },
        }
      : {}
  );
  const reader = createLineReader((line) => {
    const event = parseCodexEvent(line);
    if (!event) return;
    // Lebenszeichen: jede gültige Zeile, auch reasoning und item.updated
    lastActivityAt = rt.now();
    turn.apply(event);
  });

  // Prompt über stdin (keine Längengrenze der Kommandozeile), parallel zum
  // Lesen von stdout. Scheitert das Schreiben (etwa EPIPE, weil Codex schon
  // beendet ist, auch als später abgelehnte Promise), wird der Prozess beendet;
  // eine Ablehnung nach dem Prozessende bleibt folgenlos.
  // Bleibt die Übergabe hängen, greift das Zeitlimit; auf sie wird nie gewartet.
  void (async () => {
    await proc.stdin.write(req.prompt);
    await proc.stdin.end();
  })().catch((err) => {
    if (exited || stopped()) return;
    promptError = redactCodexDiagnostic(errorText(err));
    console.error("[Codex] Prompt konnte nicht übergeben werden:", promptError);
    terminateCodexProcess(proc, rt);
  });

  // Fehlermeldungen aus stdout oder Rückrufen können Zugangsdaten enthalten:
  // nur eine feste Meldung protokollieren
  let streamFailed = false;
  try {
    for await (const chunk of proc.stdout) reader.push(chunk);
    reader.end();
  } catch {
    streamFailed = true;
    if (!stopped()) console.error("[Codex] Lesefehler: Ausgabe oder Rückruf fehlgeschlagen");
  }
  const [exitCode, stderr] = await Promise.all([exitedPromise, stderrPromise]);
  clearTimers();
  unregisterEngineCall(req.abortKey, abortEntry);

  // Was zuerst griff, gilt: stopFor setzt nach einem Abbruch kein Zeitlimit mehr
  if (abortEntry.aborted && !timedOut) return { engine: "codex", text: "", isError: true, aborted: true };
  if (promptError !== undefined) {
    return { engine: "codex", text: `Codex hat den Auftrag nicht angenommen: ${promptError}`, isError: true, errorKind: "other" };
  }

  const r = turn.result({ exitCode: streamFailed ? null : exitCode, stderr, cwd });

  if (timedOut) {
    console.error(
      `[Codex] Zeitlimit (${timeoutKind}) nach ${Math.round(stoppedAfterMs / 1000)}s, ` +
        `letztes Lebenszeichen vor ${Math.round(idleForMs / 1000)}s, sessionId=${r.sessionId || "keine"}`
    );
    if (!req.streaming) return { engine: "codex", text: "", isError: true, timedOut: true };
    return {
      engine: "codex",
      text: "",
      ...(r.sessionId ? { sessionId: r.sessionId } : {}),
      isError: true,
      timedOut: true,
      timeoutKind,
      tools: r.tools,
      steps: r.steps,
      ...(r.lastText ? { lastText: r.lastText } : {}),
      stoppedAfterMs,
      idleForMs,
    };
  }

  console.error(
    `[Codex] Ergebnis: text=${r.text ? r.text.length + " Zeichen" : "LEER"}, sessionId=${r.sessionId || "keine"}, ` +
      `exit=${exitCode}, isError=${r.isError}${r.errorKind ? ` (${r.errorKind})` : ""}`
  );
  if (r.isError && stderr) console.error("[Codex] stderr:", redactCodexDiagnostic(stderr).substring(0, 500));
  return {
    engine: "codex",
    text: r.text,
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    isError: r.isError,
    ...(r.errorKind ? { errorKind: r.errorKind } : {}),
    ...(r.usage ? { usage: r.usage } : {}),
    tools: r.tools,
  };
}
