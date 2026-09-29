/**
 * OpenCode als Motor (Entscheidung 0019, Issue #127): die OpenCode-CLI V1
 * (npm `opencode-ai`) mit `opencode run --format json`, mit Anbieter und
 * Modell, die in OpenCode angemeldet sind (`opencode auth login`).
 *
 * Aufbau (wie src/lib/engines/codex.ts):
 * - parseOpenCodeEvent: eine JSONL-Zeile in ein Ereignis übersetzen (rein)
 * - OpenCodeTurn: Ereignisse eines Laufs sammeln, daraus Antwort, Session,
 *   Werkzeuge, Nutzung und Fehler ableiten (rein)
 * - createLineReader (aus codex.ts): Bytes aus stdout in ganze Zeilen zerlegen
 * - opencodeArgs: Kommandozeile für neuen Lauf und Fortsetzen
 * - checkOpenCodeVersion: `opencode --version` vor dem ersten Lauf, nur V1
 * - listOpenCodeModels: `opencode models` für die Einstellungsseite (#129)
 * - createOpenCodeEngine: Prozess starten, Zeitlimits, Abbruch
 *
 * Format des Ereignisstroms nach packages/opencode/src/cli/cmd/run.ts und
 * packages/schema/src/v1/session.ts im Stand v1.18.33: je Zeile
 * `{ type, timestamp, sessionID, part | error }` mit den Typen step_start,
 * text, reasoning, tool_use, step_finish und error. Ein Ende-Ereignis gibt es
 * nicht: fertig ist der Lauf mit dem Prozessende. tool_use kommt erst, wenn
 * das Werkzeug abgeschlossen ist (oder mit Fehler endete).
 *
 * Werkzeuge erscheinen mit Claude-Namen, damit die Regeln in
 * src/lib/turn-tools.ts unverändert greifen. Rechte (--auto), Umgebung und
 * Anmeldeprüfung seit #128, Auswahl und Oberfläche seit #129.
 */

import { spawn } from "bun";
import { checkAborted, currentExecution } from "../execution-context";
import { firstTextSnippet, friendlyToolName, IDLE_CHECK_INTERVAL_MS, MAX_RUN_STEPS, type RunStep } from "../claude";
import {
  DEFAULT_OPENCODE_PERMISSION,
  getSettings,
  OPENCODE_MODEL_PATTERN,
  OPENCODE_VARIANT_PATTERN,
  type OpenCodePermission,
} from "../settings";
import { subprocessEnv } from "../subprocess-env";
import type { ToolUse, TurnTools } from "../turn-tools";
import { registerEngineCall, unregisterEngineCall, type EngineProc } from "./calls";
import { codexErrorKind, createLineReader, redactCodexDiagnostic, signalProcessGroup, type CodexRuntime } from "./codex";
import type { Engine, EngineErrorKind, EngineRequest, EngineResult, EngineUsage } from "./types";

const IS_MACOS = process.platform === "darwin";
const IS_WINDOWS = process.platform === "win32";
const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "";

/** Pfad der OpenCode-CLI, wie CODEX_PATH für Codex */
export function opencodePath(): string {
  return process.env.OPENCODE_PATH || "opencode";
}

/**
 * Umgebung eines OpenCode-Prozesses (Issue #128): subprocessEnv mit engine
 * "opencode", also Geheimnisse nur über TYBO_SUBPROCESS_ENV_ALLOW oder einen
 * {env:NAME}-Verweis eines MCP-Servers in opencode.json(c); Anbieter-Schlüssel
 * und Telegram nur über die Freigabeliste. Dazu HOME, PATH und PWD. PWD ist
 * das Arbeitsverzeichnis, weil OpenCode es aus process.env.PWD vor
 * process.cwd() liest (davon hängt ab, welche CLAUDE.md oder AGENTS.md es
 * findet). Für den Projekt-Kontext setzt tybo nichts: OpenCode V1 liest die
 * CLAUDE.md des Projekts von selbst, eine AGENTS.md hat Vorrang;
 * OPENCODE_DISABLE_CLAUDE_CODE* setzt tybo nie (eine vom Nutzer gesetzte
 * Variable wird wie jede gewöhnliche Variable vererbt).
 */
export function opencodeEnv(cwd: string, conversationKey?: string): Record<string, string> {
  return {
    ...subprocessEnv({ cwd, home: HOME_DIR, conversationKey, engine: "opencode" }),
    HOME: HOME_DIR,
    PATH: process.env.PATH || "",
    PWD: cwd,
  };
}

/** Text aus stderr und Fehler-Ereignissen ohne Zugangsdaten (dieselben Regeln wie bei Codex) */
export const redactOpenCodeDiagnostic = redactCodexDiagnostic;

// ---------------------------------------------------------------------------
// Ereignisse
// ---------------------------------------------------------------------------

/** Fehler aus einem error-Ereignis (NamedError von OpenCode: name, data) */
export interface OpenCodeError {
  /** ProviderAuthError, APIError, ContextOverflowError, MessageOutputLengthError, MessageAbortedError, UnknownError, ... */
  name: string;
  message: string;
  statusCode?: number;
}

export type OpenCodeEvent =
  | { type: "step_start"; sessionId?: string }
  | { type: "text"; sessionId?: string; id?: string; text: string }
  | { type: "reasoning"; sessionId?: string }
  | { type: "tool_use"; sessionId?: string; id?: string; tool: string; tools: ToolUse[]; step: RunStep }
  | { type: "step_finish"; sessionId?: string; usage?: EngineUsage; costUsd?: number }
  | { type: "error"; sessionId?: string; error: OpenCodeError }
  | { type: "unknown"; sessionId?: string };

const MAX_COMMAND_CHARS = 2000;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Eingebaute Werkzeuge von OpenCode V1 ohne Inhalte von außen: sie behalten
 * ihren Namen und gelten in turn-tools.ts nicht als fremd.
 */
const LOCAL_TOOLS = new Set(["todowrite", "todoread", "skill", "question", "plan_enter", "plan_exit", "invalid", "batch"]);

/**
 * Werkzeuge, deren Herkunft sich nicht sicher bestimmen lässt: lsp liefert
 * je nach Operation Inhalte aus beliebigen Dateien (hover, Definitionen,
 * Symbole im ganzen Arbeitsbereich). Sie gelten immer als fremd.
 */
const UNCERTAIN_TOOLS = new Set(["lsp"]);

/**
 * MCP-Werkzeuge heißen in OpenCode `<server>_<werkzeug>` (beide Teile mit
 * `_` statt Sonderzeichen). Enthält der Server selbst `_`, ist die Trennung
 * nicht eindeutig; getrennt wird am ersten `_`. Für die Einstufung zählt nur
 * das Präfix mcp__: jedes Werkzeug, das OpenCode nicht eingebaut hat, gilt so
 * als fremd, auch Plugins und der Code-Modus.
 */
export function mcpToolName(tool: string): string {
  const i = tool.indexOf("_");
  if (i <= 0 || i === tool.length - 1) return `mcp__${tool}__${tool}`;
  return `mcp__${tool.slice(0, i)}__${tool.slice(i + 1)}`;
}

/** Werkzeug eines tool_use mit Claude-Namen, samt Schritt für den Timeout-Bericht */
export function openCodeToolUse(tool: string, rawInput: unknown): { tools: ToolUse[]; step: RunStep } {
  const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? (rawInput as Record<string, unknown>) : {};
  const filePath = str(input.filePath) ?? str(input.file_path) ?? str(input.path);
  const withPath = (name: string, path: string | undefined): { tools: ToolUse[]; step: RunStep } => ({
    tools: [path ? { name, path } : { name }],
    step: path ? { name, input: path } : { name },
  });
  switch (tool) {
    case "webfetch": {
      const url = str(input.url);
      return { tools: [{ name: "WebFetch" }], step: url ? { name: "WebFetch", input: url } : { name: "WebFetch" } };
    }
    case "websearch":
    case "codesearch": {
      const query = str(input.query);
      return { tools: [{ name: "WebSearch" }], step: query ? { name: "WebSearch", input: query } : { name: "WebSearch" } };
    }
    case "read":
      return withPath("Read", filePath);
    case "list":
      return withPath("LS", filePath);
    case "glob":
      return withPath("Glob", str(input.path));
    case "grep":
      return withPath("Grep", str(input.path));
    case "bash": {
      const command = str(input.command);
      return {
        tools: [command ? { name: "Bash", command: command.slice(0, MAX_COMMAND_CHARS) } : { name: "Bash" }],
        step: command ? { name: "Bash", input: command } : { name: "Bash" },
      };
    }
    case "edit":
    case "multiedit":
    case "patch":
    case "apply_patch":
      return withPath("Edit", filePath);
    case "write":
      return withPath("Write", filePath);
    case "task": {
      const prompt = str(input.prompt) ?? str(input.description);
      return { tools: [{ name: "Task" }], step: prompt ? { name: "Task", input: prompt } : { name: "Task" } };
    }
    default: {
      if (LOCAL_TOOLS.has(tool)) return { tools: [{ name: tool }], step: { name: tool } };
      if (UNCERTAIN_TOOLS.has(tool)) {
        return { tools: [{ name: tool, external: true }], step: filePath ? { name: tool, input: filePath } : { name: tool } };
      }
      const name = mcpToolName(tool);
      return { tools: [{ name }], step: { name } };
    }
  }
}

/** Tokens eines step_finish; input ohne Cache (OpenCode) wird wie bei Codex zur Summe mit Cache */
function usageOf(raw: any): EngineUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const input = num(raw.input);
  const output = num(raw.output);
  const reasoning = num(raw.reasoning);
  const cacheRead = num(raw.cache?.read);
  const cacheWrite = num(raw.cache?.write);
  if (input === undefined && output === undefined && reasoning === undefined && cacheRead === undefined) return undefined;
  const usage: EngineUsage = {};
  if (input !== undefined || cacheRead !== undefined || cacheWrite !== undefined) {
    usage.inputTokens = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  }
  if (cacheRead !== undefined) usage.cachedInputTokens = cacheRead;
  if (output !== undefined) usage.outputTokens = output;
  if (reasoning !== undefined) usage.reasoningOutputTokens = reasoning;
  return usage;
}

function errorOf(raw: any): OpenCodeError {
  const name = str(raw?.name) ?? "UnknownError";
  const data = raw?.data && typeof raw.data === "object" ? raw.data : {};
  const message = str(data.message) ?? str(raw?.message) ?? name;
  const statusCode = num(data.statusCode) ?? num(raw?.statusCode);
  return statusCode !== undefined ? { name, message, statusCode } : { name, message };
}

/**
 * Eine Zeile aus `opencode run --format json` als Ereignis. null bei leeren
 * oder kaputten Zeilen und bei JSON, das kein Ereignis ist; unbekannte Typen
 * und unvollständige Teile ergeben { type: "unknown" } (zählen als
 * Lebenszeichen). sessionId steht in jedem Ereignis, das eine sessionID hat.
 */
export function parseOpenCodeEvent(line: string): OpenCodeEvent | null {
  if (!line.trim()) return null;
  let e: any;
  try {
    e = JSON.parse(line);
  } catch {
    return null;
  }
  if (!e || typeof e !== "object" || typeof e.type !== "string") return null;
  const sid = str(e.sessionID);
  const base = sid ? { sessionId: sid } : {};
  const part = e.part && typeof e.part === "object" ? e.part : undefined;
  switch (e.type) {
    case "step_start":
      return { type: "step_start", ...base };
    case "reasoning":
      return { type: "reasoning", ...base };
    case "text": {
      if (!part || typeof part.text !== "string") return { type: "unknown", ...base };
      // Von OpenCode selbst eingefügte oder verworfene Teile sind keine Antwort
      if (part.synthetic === true || part.ignored === true) return { type: "unknown", ...base };
      const id = str(part.id);
      return { type: "text", ...base, ...(id ? { id } : {}), text: part.text };
    }
    case "tool_use": {
      const tool = str(part?.tool);
      if (!tool) return { type: "unknown", ...base };
      const id = str(part.callID) ?? str(part.id);
      return { type: "tool_use", ...base, ...(id ? { id } : {}), tool, ...openCodeToolUse(tool, part.state?.input) };
    }
    case "step_finish": {
      const usage = usageOf(part?.tokens);
      const costUsd = num(part?.cost);
      return {
        type: "step_finish",
        ...base,
        ...(usage ? { usage } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
      };
    }
    case "error":
      return { type: "error", ...base, error: errorOf(e.error) };
    default:
      return { type: "unknown", ...base };
  }
}

// ---------------------------------------------------------------------------
// Fehlerarten
// ---------------------------------------------------------------------------

export const OPENCODE_NOT_LOGGED_IN = "OpenCode ist nicht angemeldet: im Terminal `opencode auth login -p openrouter` ausführen";
export const OPENCODE_NOT_INSTALLED =
  "OpenCode ist nicht installiert: der Befehl opencode wurde nicht gefunden (anderer Pfad über OPENCODE_PATH in .env)";

/**
 * Art eines OpenCode-Fehlers aus seinem Namen, dem HTTP-Status und zuletzt
 * der Meldung (dieselben Muster wie bei Codex).
 */
export function openCodeErrorKind(error: OpenCodeError): EngineErrorKind {
  switch (error.name) {
    case "ProviderAuthError":
      return "auth";
    case "ContextOverflowError":
      return "context";
    case "APIError":
      if (error.statusCode === 429) return "rate_limit";
      if (error.statusCode === 401 || error.statusCode === 403) return "auth";
      if (error.statusCode === 402) return "quota";
      if (error.statusCode === 503 || error.statusCode === 529) return "capacity";
      break;
  }
  return codexErrorKind(error.message);
}

/** Start gescheitert: OpenCode fehlt (nur prüfen, wenn kein Ereignis kam) */
const NOT_INSTALLED = /no such file or directory|command not found|enoent|not found in path/i;

// ---------------------------------------------------------------------------
// Ein Lauf
// ---------------------------------------------------------------------------

export interface OpenCodeTurnCallbacks {
  /** tool_use gesehen (Anzeigename); ungedrosselt, drosseln tut der Aufrufer */
  onTool?: (displayName: string) => void;
  /** Erster text-Teil mit mehr als 30 Zeichen */
  onFirstText?: (snippet: string, fullText: string) => void;
}

export interface OpenCodeTurnResult {
  text: string;
  sessionId?: string;
  isError: boolean;
  errorKind?: EngineErrorKind;
  usage?: EngineUsage;
  costUsd?: number;
  tools: TurnTools;
  steps: RunStep[];
  /** Letzter text-Teil, ungekürzt (Timeout-Bericht) */
  lastText?: string;
}

interface Step {
  /** text-Teile nach ID; ein späterer Stand ersetzt den früheren */
  texts: Map<string, string>;
}

/**
 * Sammelt die Ereignisse eines Laufs.
 *
 * Session: die sessionID der ersten Zeile, die eine hat.
 * Antworttext: die text-Teile des letzten Schritts (step_start bis
 * step_finish), mit Leerzeile verbunden. Hat der letzte Schritt keinen Text,
 * gibt es keine Antwort (ein früherer Zwischenstand ist keine). Werkzeuge, Nutzung und Kosten zählen
 * über alle Schritte (Nutzung und Kosten summiert).
 * Fehler: ein error-Ereignis oder Exit-Code ungleich 0, auch wenn schon Text
 * kam; ebenso ein Lauf ohne jeden Text.
 */
export class OpenCodeTurn {
  sessionId?: string;
  usage?: EngineUsage;
  costUsd?: number;
  errors: OpenCodeError[] = [];
  /** Mindestens eine gültige Zeile gesehen */
  sawEvent = false;
  private readonly stepList: Step[] = [];
  private readonly uses: ToolUse[] = [];
  private readonly runSteps: RunStep[] = [];
  private readonly seenTools = new Set<string>();
  private last?: string;
  private firstTextSent = false;
  /** Ersatz-IDs für Teile ohne ID: jeder zählt einzeln */
  private anonymous = 0;

  constructor(private readonly callbacks: OpenCodeTurnCallbacks = {}) {}

  private current(): Step {
    let step = this.stepList.at(-1);
    if (!step) {
      step = { texts: new Map() };
      this.stepList.push(step);
    }
    return step;
  }

  apply(event: OpenCodeEvent): void {
    this.sawEvent = true;
    if (!this.sessionId && event.sessionId) this.sessionId = event.sessionId;
    switch (event.type) {
      case "step_start":
        this.stepList.push({ texts: new Map() });
        return;
      case "text": {
        this.current().texts.set(event.id ?? `#${this.anonymous++}`, event.text);
        if (event.text.trim()) this.last = event.text;
        if (!this.firstTextSent && event.text.length > 30) {
          this.firstTextSent = true;
          this.callbacks.onFirstText?.(firstTextSnippet(event.text), event.text);
        }
        return;
      }
      case "tool_use": {
        // Dasselbe Werkzeug zweimal gemeldet (Aktualisierung): nur einmal zählen
        const id = event.id ?? `#${this.anonymous++}`;
        if (this.seenTools.has(id)) return;
        this.seenTools.add(id);
        this.uses.push(...event.tools);
        this.runSteps.push(event.step);
        if (this.runSteps.length > MAX_RUN_STEPS) this.runSteps.shift();
        const name = event.tools[0]?.name;
        if (name) this.callbacks.onTool?.(friendlyToolName(name));
        return;
      }
      case "step_finish": {
        if (event.usage) this.usage = addUsage(this.usage, event.usage);
        if (event.costUsd !== undefined) this.costUsd = (this.costUsd ?? 0) + event.costUsd;
        return;
      }
      case "error":
        this.errors.push(event.error);
        return;
      default:
        return;
    }
  }

  toolUses(): ToolUse[] {
    return [...this.uses];
  }

  /** Die letzten Werkzeugschritte (höchstens MAX_RUN_STEPS) */
  steps(): RunStep[] {
    return [...this.runSteps];
  }

  lastText(): string | undefined {
    return this.last;
  }

  /** Antworttext nach der Regel oben */
  answer(): string {
    const lastStep = this.stepList.at(-1);
    const finals = lastStep ? [...lastStep.texts.values()].map((t) => t.trim()).filter(Boolean) : [];
    return finals.join("\n\n");
  }

  /**
   * Ergebnis nach Prozessende; stderr nur für Fehlermeldungen. Die
   * Fehlermeldung ist bereinigt, die Fehlerart kommt aus dem ungekürzten Fehler.
   */
  result(o: { exitCode: number | null; stderr?: string; cwd: string }): OpenCodeTurnResult {
    const tools: TurnTools = { uses: this.toolUses(), cwd: o.cwd };
    const base = {
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.costUsd !== undefined ? { costUsd: this.costUsd } : {}),
      tools,
      steps: this.steps(),
      ...(this.last ? { lastText: this.last } : {}),
    };
    const text = this.answer();
    if (this.errors.length === 0 && o.exitCode === 0 && text) return { ...base, text, isError: false };

    // Der letzte Fehler zählt; MessageAbortedError nach einem anderen Fehler ist nur die Folge
    const error = [...this.errors].reverse().find((e) => e.name !== "MessageAbortedError") ?? this.errors.at(-1);
    if (error) {
      const kind = openCodeErrorKind(error);
      const message = kind === "auth" ? OPENCODE_NOT_LOGGED_IN : redactOpenCodeDiagnostic(`OpenCode: ${error.message}`);
      return { ...base, text: message, isError: true, errorKind: kind };
    }
    const stderr = (o.stderr ?? "").trim();
    if (!this.sawEvent && NOT_INSTALLED.test(stderr)) {
      return { ...base, text: OPENCODE_NOT_INSTALLED, isError: true, errorKind: "not_installed" };
    }
    const message =
      (stderr ? lastLines(redactOpenCodeDiagnostic(stderr), 5) : undefined) ??
      (o.exitCode === 0 ? "OpenCode hat keine Antwort geliefert" : `OpenCode endete mit Exit-Code ${o.exitCode}`);
    return { ...base, text: redactOpenCodeDiagnostic(message), isError: true, errorKind: codexErrorKind(message) };
  }
}

function addUsage(a: EngineUsage | undefined, b: EngineUsage): EngineUsage {
  if (!a) return { ...b };
  const out: EngineUsage = { ...a };
  for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens"] as const) {
    if (b[key] !== undefined) out[key] = (out[key] ?? 0) + b[key]!;
  }
  return out;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function lastLines(text: string, n: number): string {
  return text.split("\n").slice(-n).join("\n").slice(-1000);
}

// ---------------------------------------------------------------------------
// Kommandozeile
// ---------------------------------------------------------------------------

/**
 * Effort-Stufe (Variante), anbieterabhängig (minimal, low, high, max,
 * thinking-8k, ...): dieselbe Prüfung wie engine.opencode.variant im Schema.
 * Erlaubt auch einen Bindestrich vorn; opencodeArgs übergibt sie deshalb nur
 * als ein Argument `--variant=<wert>`, sodass `-x` oder `--auto` Wert bleiben
 * und nie als eigene Option gelesen werden.
 */
const EFFORT = OPENCODE_VARIANT_PATTERN;
/** Modell als anbieter/modell: kein führender Bindestrich, keine Leer- oder Sonderzeichen */
const MODEL = OPENCODE_MODEL_PATTERN;
/** Session-ID (etwa ses_...), nie mit Bindestrich vorn */
const SESSION_ID = /^[A-Za-z0-9][\w.:-]*$/;

/**
 * Rechte-Argumente: `--auto` bei auto, nichts bei ask-deny. Mit `--auto`
 * bestätigt OpenCode jede Frage (ask) selbst, auch für external_directory;
 * Regeln mit deny aus der OpenCode-Konfiguration bleiben wirksam. Ohne
 * `--auto` lehnt `opencode run` jede Frage ab. tybo setzt keine eigenen
 * Regeln (kein OPENCODE_PERMISSION, keine opencode.json).
 */
export function opencodePermissionArgs(permission: OpenCodePermission): string[] {
  switch (permission) {
    case "auto":
      return ["--auto"];
    case "ask-deny":
      return [];
    default:
      throw new Error("Ungültige OpenCode-Rechte-Stufe");
  }
}

/** Rechte aus den Einstellungen (engine.opencode.permission), sonst auto; bei jedem Lauf neu gelesen */
export function opencodePermission(): OpenCodePermission {
  return getSettings().engine?.opencode?.permission ?? DEFAULT_OPENCODE_PERMISSION;
}

const PERMISSION_TEXT: Record<OpenCodePermission, string> = {
  auto: "Fragen automatisch bestätigen (--auto), deny aus der OpenCode-Konfiguration gilt",
  "ask-deny": "Fragen ablehnen",
};

let loggedPermission: OpenCodePermission | undefined;

/** Schreibt die Rechte beim ersten Lauf ins Log und wieder, wenn sie sich ändern */
function logPermission(permission: OpenCodePermission): void {
  if (loggedPermission === permission) return;
  loggedPermission = permission;
  console.log(`[OpenCode] Rechte: ${permission} (${PERMISSION_TEXT[permission]}), Einstellung engine.opencode.permission`);
}

/** Nur für Tests: das Log der Rechte zurücksetzen */
export function resetOpenCodePermissionLogForTests(): void {
  loggedPermission = undefined;
}

/**
 * Argumente nach `opencode`: `run --format json`, Modell und Variante nur,
 * wenn angegeben (sonst gilt die Konfiguration von OpenCode), die Rechte
 * (Standard auto, also `--auto`), `--dir` mit dem Arbeitsverzeichnis, beim
 * Fortsetzen `--session <id>`. Kein Positionsargument: der Prompt kommt über
 * stdin (OpenCode nimmt stdin als Nachricht, wenn keine angegeben ist).
 * Projekt-Kontext braucht kein Argument: OpenCode V1 liest vom
 * Arbeitsverzeichnis aufwärts AGENTS.md, sonst CLAUDE.md. Wirft bei
 * ungültigen Angaben, statt sie als Option durchzureichen.
 */
export function opencodeArgs(
  req: Pick<EngineRequest, "model" | "effort" | "resumeSessionId" | "cwd"> & { permission?: OpenCodePermission }
): string[] {
  // Fehlermeldungen ohne den Wert: er kann Zugangsdaten enthalten
  if (req.model !== undefined && req.model !== "" && !MODEL.test(req.model)) throw new Error("Ungültiges OpenCode-Modell");
  if (req.effort !== undefined && req.effort !== "" && !EFFORT.test(req.effort)) throw new Error("Ungültige Effort-Stufe");
  if (req.resumeSessionId && !SESSION_ID.test(req.resumeSessionId)) throw new Error("Ungültige OpenCode-Session");
  return [
    "run",
    "--format",
    "json",
    ...(req.model ? ["--model", req.model] : []),
    ...(req.effort ? [`--variant=${req.effort}`] : []),
    ...opencodePermissionArgs(req.permission ?? DEFAULT_OPENCODE_PERMISSION),
    "--dir",
    req.cwd,
    ...(req.resumeSessionId ? ["--session", req.resumeSessionId] : []),
  ];
}

// ---------------------------------------------------------------------------
// Prozess, Zeitlimits, Abbruch
// ---------------------------------------------------------------------------

/** So lange nach SIGINT, bis der Prozessbaum mit SIGKILL beendet wird */
export const OPENCODE_KILL_GRACE_MS = 3_000;
/** Zeitlimit für `opencode --version` */
export const OPENCODE_VERSION_TIMEOUT_MS = 5_000;
/** Höchstens ein Werkzeug-Rückruf so oft (wie bei Claude) */
const TOOL_THROTTLE_MS = 5_000;

/** Prozessstart, Uhr, Timer und Signale; Aufbau wie bei Codex */
export type OpenCodeRuntime = CodexRuntime;

const defaultRuntime: OpenCodeRuntime = {
  spawn,
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  signal: signalProcessGroup,
};

let runtime: OpenCodeRuntime = defaultRuntime;

/** Aktuelle Laufzeit (Prozessstart, Uhr, Timer), auch für checkEngine("opencode") */
export function opencodeRuntime(): OpenCodeRuntime {
  return runtime;
}

/** Nur für Tests: Prozessstart, Uhr, Timer und Signale ersetzen, null stellt zurück (auch die Versionsprüfung). */
export function setOpenCodeRuntimeForTests(r: Partial<OpenCodeRuntime> | null): void {
  runtime = r ? { ...defaultRuntime, ...r } : defaultRuntime;
  forgetOpenCodeVersion();
}

const terminating = new WeakSet<object>();

/**
 * Beendet einen OpenCode-Lauf: erst SIGINT an die Prozessgruppe, nach
 * OPENCODE_KILL_GRACE_MS SIGKILL. Mehrfache Aufrufe für denselben Prozess
 * (/stop zweimal, Abbruch und Zeitlimit) senden nichts doppelt.
 */
export function terminateOpenCodeProcess(proc: EngineProc, rt: OpenCodeRuntime = runtime): void {
  if (terminating.has(proc)) return;
  terminating.add(proc);
  rt.signal(proc, "SIGINT");
  const timer = rt.setTimeout(() => rt.signal(proc, "SIGKILL"), OPENCODE_KILL_GRACE_MS);
  (timer as { unref?: () => void } | undefined)?.unref?.();
}

// ---------------------------------------------------------------------------
// Versionsprüfung
// ---------------------------------------------------------------------------

export type OpenCodeVersionCheck =
  | { ok: true; version: string }
  | { ok: false; errorKind: EngineErrorKind; message: string; version?: string }
  /** Zeitlimit von `opencode --version`: wie ein Zeitlimit des Laufs, kein Fallback */
  | { ok: false; timedOut: true; message: string }
  /** Prüfung abgebrochen (/stop beim Auftrag, der sie gestartet hat) */
  | { ok: false; aborted: true; message: string };

interface VersionProbe {
  result: Promise<OpenCodeVersionCheck>;
  /** Beendet `opencode --version` (SIGINT, dann SIGKILL); Ergebnis wird aborted */
  cancel: () => void;
}

/** Versionsnummer aus der Ausgabe von `opencode --version` (etwa „1.18.33" oder „opencode v1.18.33") */
export function parseOpenCodeVersion(output: string): { version: string; major: number } | null {
  const m = /(?:^|[^\d.])v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?/.exec(output.trim());
  if (!m) return null;
  return { version: `${m[1]}.${m[2]}.${m[3]}`, major: Number(m[1]) };
}

export const OPENCODE_VERSION_UNKNOWN = "Version von OpenCode nicht erkennbar (opencode --version)";

/** Meldung für eine andere Hauptversion als 1 (V2 wird erkannt und abgelehnt, Entscheidung 0019) */
export function openCodeUnsupported(parsed: { version: string; major: number }): string {
  return `OpenCode ${parsed.major} wird noch nicht unterstützt (gefunden: ${parsed.version}); tybo braucht OpenCode 1 (npm i -g opencode-ai@1)`;
}

/** Bestandene Prüfung je Pfad; Ablehnungen werden nicht gemerkt (Aktualisierung wirkt sofort) */
const versionOk = new Map<string, Promise<OpenCodeVersionCheck>>();

/** Vergisst die bestandene Versionsprüfung (Tests, nach Neuinstallation) */
export function forgetOpenCodeVersion(): void {
  versionOk.clear();
}

/**
 * `opencode --version` vor dem ersten Lauf: nur Hauptversion 1 wird
 * unterstützt (Entscheidung 0019). Zeitlimit OPENCODE_VERSION_TIMEOUT_MS,
 * danach wird der Prozess beendet. stdout liefert nur die Versionsnummer,
 * stderr geht nirgends hin.
 */
export function checkOpenCodeVersion(cwd: string): Promise<OpenCodeVersionCheck> {
  return startVersionCheck(cwd).result;
}

/**
 * Wie checkOpenCodeVersion; cancel gibt es nur, wenn dieser Aufruf die
 * Prüfung gestartet hat. Wer auf eine fremde Prüfung wartet, beendet sie
 * nicht (sie gehört einem anderen Auftrag).
 */
function startVersionCheck(cwd: string): { result: Promise<OpenCodeVersionCheck>; cancel?: () => void } {
  const path = opencodePath();
  const hit = versionOk.get(path);
  if (hit) return { result: hit };
  const probe = probeVersion(cwd);
  const pending = probe.result;
  versionOk.set(path, pending);
  void pending.then(
    (r) => {
      if (!r.ok && versionOk.get(path) === pending) versionOk.delete(path);
    },
    () => versionOk.delete(path)
  );
  return probe;
}

const VERSION_ABORTED = "Versionsprüfung von OpenCode abgebrochen";
const VERSION_TIMED_OUT = "OpenCode hat seine Version nicht rechtzeitig genannt (opencode --version)";

function probeVersion(cwd: string): VersionProbe {
  const rt = runtime;
  let proc: ReturnType<typeof rt.spawn>;
  try {
    proc = rt.spawn({
      detached: !IS_WINDOWS,
      cmd: [opencodePath(), "--version"],
      cwd,
      env: opencodeEnv(cwd),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return { result: Promise.resolve({ ok: false, errorKind: "not_installed", message: OPENCODE_NOT_INSTALLED }), cancel: () => {} };
  }
  let cancelled = false;
  let onCancel = () => {};
  const cancelledPromise = new Promise<{ kind: "aborted" }>((resolve) => (onCancel = () => resolve({ kind: "aborted" })));
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    terminateOpenCodeProcess(proc, rt);
    onCancel();
  };
  return { result: readVersion(proc, rt, cancelledPromise, () => cancelled), cancel };
}

async function readVersion(
  proc: ReturnType<OpenCodeRuntime["spawn"]>,
  rt: OpenCodeRuntime,
  cancelledPromise: Promise<{ kind: "aborted" }>,
  isCancelled: () => boolean
): Promise<OpenCodeVersionCheck> {
  // stderr lesen, damit eine volle Pipe nicht blockiert; nur für die Erkennung „nicht installiert"
  const stderrPromise = new Response(proc.stderr as ReadableStream<Uint8Array>).text().catch(() => "");
  const done = Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text().catch(() => ""),
    proc.exited.catch(() => null),
  ]).then(([stdout, code]) => ({ kind: "done" as const, stdout, code }));
  let timer: unknown;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = rt.setTimeout(() => resolve({ kind: "timeout" }), OPENCODE_VERSION_TIMEOUT_MS);
  });
  const result = await Promise.race([done, timeout, cancelledPromise]);
  rt.clearTimeout(timer);
  // Auch eine Antwort nach dem Abbruch zählt nicht: der Auftrag ist beendet
  if (result.kind === "aborted" || isCancelled()) return { ok: false, aborted: true, message: VERSION_ABORTED };
  if (result.kind === "timeout") {
    terminateOpenCodeProcess(proc, rt);
    return { ok: false, timedOut: true, message: VERSION_TIMED_OUT };
  }
  const { stdout, code } = result;
  if (code !== 0) {
    if (code === 127 || NOT_INSTALLED.test(await stderrPromise)) return { ok: false, errorKind: "not_installed", message: OPENCODE_NOT_INSTALLED };
    return { ok: false, errorKind: "other", message: `opencode --version endete mit Exit-Code ${code}` };
  }
  const parsed = parseOpenCodeVersion(stdout);
  if (!parsed) return { ok: false, errorKind: "other", message: OPENCODE_VERSION_UNKNOWN };
  if (parsed.major !== 1) {
    return { ok: false, errorKind: "not_installed", version: parsed.version, message: openCodeUnsupported(parsed) };
  }
  return { ok: true, version: parsed.version };
}

// ---------------------------------------------------------------------------
// Modell-Liste (Issue #129)
// ---------------------------------------------------------------------------

/** Zeitlimit für `opencode models`, danach wird der Prozess beendet */
export const OPENCODE_MODELS_TIMEOUT_MS = 10_000;
/** Höchstens so viele Modelle und so viele Zeichen je Kennung */
const MAX_MODELS = 2_000;
const MAX_MODEL_CHARS = 200;
/** Höchstens so viele Bytes stdout; mehr bricht die Abfrage ab und beendet den Prozess */
export const OPENCODE_MODELS_MAX_OUTPUT = 1_000_000;

/** Feste Texte für die Einstellungsseite, nie rohe Ausgaben */
export const OPENCODE_MODELS_TEXT = {
  notInstalled: "OpenCode ist nicht installiert",
  timeout: "OpenCode antwortet nicht (Zeitüberschreitung)",
  failed: "opencode models endete mit einem Fehler",
  empty: "OpenCode nennt keine Modelle",
  tooLarge: "opencode models liefert zu viel Ausgabe",
} as const;

export type OpenCodeModelsResult = { ok: true; models: string[] } | { ok: false; error: string };

/**
 * Zeilen von `opencode models`: je Zeile `<anbieter>/<modell>`, auch mit
 * weiteren Schrägstrichen (openrouter/anthropic/claude-opus-5.5). Übernommen
 * wird nur, was als Modell auch durch die Prüfung von Schema und Motor
 * ginge; Farbcodes, Leerzeilen und Hinweise fallen weg, Doppelte ebenso.
 */
export function parseOpenCodeModels(stdout: string): string[] {
  const out = new Set<string>();
  for (const raw of stdout.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.includes("/") || line.length > MAX_MODEL_CHARS || !MODEL.test(line)) continue;
    out.add(line);
    if (out.size >= MAX_MODELS) break;
  }
  return [...out];
}

/**
 * `opencode models` für die Einstellungsseite: OPENCODE_PATH, gefilterte
 * Umgebung (opencodeEnv), Argumente ohne Shell, Zeitlimit
 * OPENCODE_MODELS_TIMEOUT_MS, danach wird der Prozess beendet (SIGINT, dann
 * SIGKILL). stdout wird schon beim Lesen auf OPENCODE_MODELS_MAX_OUTPUT
 * begrenzt: mehr bricht das Lesen ab und beendet den Prozess, damit eine
 * fehlerhafte Abfrage den Bot-Prozess nicht mit Speicher füllt. stderr wird
 * stückweise gelesen und verworfen, nie gesammelt. Fehler kommen nur als feste
 * Texte zurück, weder Ausgaben noch Pfade gehen an Browser oder Log.
 * Zwischenspeicher und Zusammenfassen gleichzeitiger Abrufe übernimmt die
 * Modell-Liste der WebUI (src/web/models.ts).
 */
export async function listOpenCodeModels(): Promise<OpenCodeModelsResult> {
  const rt = runtime;
  const cwd = process.env.GO_PROJECT_ROOT || process.cwd();
  let proc: ReturnType<typeof rt.spawn>;
  try {
    proc = rt.spawn({
      detached: !IS_WINDOWS,
      cmd: [opencodePath(), "models"],
      cwd,
      env: opencodeEnv(cwd),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return { ok: false, error: OPENCODE_MODELS_TEXT.notInstalled };
  }
  const stderr = discardStream(proc.stderr as ReadableStream<Uint8Array>);
  const stdout = readCapped(proc.stdout as ReadableStream<Uint8Array>, OPENCODE_MODELS_MAX_OUTPUT);
  const done = stdout.result.then(async (r) =>
    r.over ? { kind: "overflow" as const } : { kind: "done" as const, stdout: r.text, code: await proc.exited.catch(() => null) }
  );
  let timer: unknown;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = rt.setTimeout(() => resolve({ kind: "timeout" }), OPENCODE_MODELS_TIMEOUT_MS);
  });
  const result = await Promise.race([done, timeout]);
  rt.clearTimeout(timer);
  stderr.cancel();
  if (result.kind !== "done") {
    stdout.cancel();
    terminateOpenCodeProcess(proc, rt);
    return { ok: false, error: result.kind === "timeout" ? OPENCODE_MODELS_TEXT.timeout : OPENCODE_MODELS_TEXT.tooLarge };
  }
  if (result.code === 127) return { ok: false, error: OPENCODE_MODELS_TEXT.notInstalled };
  if (result.code !== 0) return { ok: false, error: OPENCODE_MODELS_TEXT.failed };
  const models = parseOpenCodeModels(result.stdout);
  return models.length ? { ok: true, models } : { ok: false, error: OPENCODE_MODELS_TEXT.empty };
}

/**
 * Liest einen Strom bis höchstens `limit` Bytes. Wird es mehr, endet das Lesen
 * sofort mit over = true, ohne den Rest zu sammeln; ein Lesefehler gilt als
 * leere Ausgabe. cancel bricht das Lesen ab (etwa beim Zeitlimit).
 */
function readCapped(stream: ReadableStream<Uint8Array>, limit: number): { result: Promise<{ text: string; over: boolean }>; cancel: () => void } {
  const reader = stream.getReader();
  const result = (async () => {
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return { text: text + decoder.decode(), over: false };
        size += value.byteLength;
        if (size > limit) {
          void reader.cancel().catch(() => {});
          return { text: "", over: true };
        }
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      return { text: "", over: false };
    }
  })();
  return { result, cancel: () => void reader.cancel().catch(() => {}) };
}

/** Liest einen Strom stückweise und verwirft alles (volle Pipe blockiert sonst den Prozess); cancel beendet das Lesen */
function discardStream(stream: ReadableStream<Uint8Array>): { cancel: () => void } {
  const reader = stream.getReader();
  void (async () => {
    try {
      while (!(await reader.read()).done) {
        // verwerfen
      }
    } catch {
      // Lesefehler: nichts zu tun
    }
  })();
  return { cancel: () => void reader.cancel().catch(() => {}) };
}

// ---------------------------------------------------------------------------
// Motor
// ---------------------------------------------------------------------------

export function createOpenCodeEngine(): Engine {
  return {
    id: "opencode",
    describe: () => "OpenCode",
    run: (req) => runOpenCode(req),
  };
}

/** Platzhalter im Abbruch-Register, solange ein Auftrag auf die Versionsprüfung wartet */
const VERSION_WAITER: EngineProc = {
  pid: 0,
  kill: () => {},
};

/**
 * Versionsprüfung eines Auftrags, abbrechbar und unter seiner Gesamtzeit.
 * Während des Wartens steht der Auftrag im Abbruch-Register: /stop beendet
 * die eigene Prüfung (SIGINT an `opencode --version`) und lässt den Auftrag
 * sofort mit aborted enden, bevor ein Lauf startet. Wurde die Prüfung eines
 * anderen Auftrags abgebrochen, prüft dieser Auftrag einmal selbst.
 */
async function awaitVersion(
  req: EngineRequest,
  cwd: string,
  rt: OpenCodeRuntime,
  startedAt: number
): Promise<OpenCodeVersionCheck | "aborted" | "timeout"> {
  let stop!: (why: "aborted" | "timeout") => void;
  const stopped = new Promise<"aborted" | "timeout">((resolve) => (stop = resolve));
  let cancelProbe: (() => void) | undefined;
  let aborted = false;
  const entry = registerEngineCall(req.abortKey, VERSION_WAITER, () => {
    aborted = true;
    cancelProbe?.();
    stop("aborted");
  });
  const timer = rt.setTimeout(() => {
    cancelProbe?.();
    stop("timeout");
  }, Math.max(0, req.timeoutMs - (rt.now() - startedAt)));
  try {
    for (let attempt = 0; ; attempt++) {
      const check = startVersionCheck(cwd);
      cancelProbe = check.cancel;
      const r = await Promise.race([check.result, stopped]);
      if (aborted) return "aborted";
      if (r === "aborted" || r === "timeout") return r;
      if (!r.ok && "aborted" in r && attempt === 0) continue;
      return r;
    }
  } finally {
    rt.clearTimeout(timer);
    unregisterEngineCall(req.abortKey, entry);
  }
}

async function runOpenCode(req: EngineRequest): Promise<EngineResult> {
  const rt = runtime;
  const cwd = req.cwd || process.cwd();
  let args: string[];
  try {
    const permission = opencodePermission();
    args = opencodeArgs({ ...req, cwd, permission });
    logPermission(permission);
  } catch (err) {
    return { engine: "opencode", text: redactOpenCodeDiagnostic(errorText(err)), isError: true, errorKind: "other" };
  }
  // Ohne Nachricht bricht OpenCode ab („You must provide a message")
  if (!req.prompt.trim()) return { engine: "opencode", text: "Leerer Auftrag für OpenCode", isError: true, errorKind: "other" };

  checkAborted();
  // Die Gesamtzeit läuft ab hier, die Versionsprüfung zählt mit
  const startedAt = rt.now();
  const version = await awaitVersion(req, cwd, rt, startedAt);
  if (version === "aborted") return { engine: "opencode", text: "", isError: true, aborted: true };
  if (version === "timeout" || (!version.ok && "timedOut" in version)) {
    const stoppedAfterMs = rt.now() - startedAt;
    console.error(`[OpenCode] Zeitlimit in der Versionsprüfung nach ${Math.round(stoppedAfterMs / 1000)}s`);
    if (!req.streaming) return { engine: "opencode", text: "", isError: true, timedOut: true };
    return {
      engine: "opencode",
      text: "",
      isError: true,
      timedOut: true,
      timeoutKind: "total",
      tools: { uses: [], cwd },
      steps: [],
      stoppedAfterMs,
      idleForMs: stoppedAfterMs,
    };
  }
  if (!version.ok) {
    console.error(`[OpenCode] ${version.message}`);
    // aborted hier: die Prüfung eines anderen Auftrags wurde zweimal abgebrochen
    return { engine: "opencode", text: version.message, isError: true, errorKind: "errorKind" in version ? version.errorKind : "other" };
  }
  checkAborted();

  const cmd = IS_MACOS ? ["/usr/bin/caffeinate", "-i", opencodePath(), ...args] : [opencodePath(), ...args];
  const start = () =>
    rt.spawn({
      detached: !IS_WINDOWS,
      cmd,
      cwd,
      env: opencodeEnv(cwd, currentExecution()?.key),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  let proc: ReturnType<typeof start>;
  try {
    proc = start();
  } catch (err) {
    console.error("[OpenCode] Start fehlgeschlagen:", redactOpenCodeDiagnostic(errorText(err)));
    return { engine: "opencode", text: OPENCODE_NOT_INSTALLED, isError: true, errorKind: "not_installed" };
  }

  // stderr parallel lesen, damit eine volle Pipe den Prozess nicht blockiert
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");
  // Nach dem Prozessende ist die PID frei: danach keine Diagnosen mehr für diesen Lauf
  let exited = false;
  const exitedPromise = proc.exited.then(
    (code) => ((exited = true), code),
    () => ((exited = true), null)
  );

  let abortEntry: ReturnType<typeof registerEngineCall>;
  try {
    abortEntry = registerEngineCall(req.abortKey, proc, (p) => terminateOpenCodeProcess(p, rt));
  } catch (err) {
    // Ausführung wurde zwischen Start und Anmeldung abgebrochen: Prozess nicht verwaist lassen
    terminateOpenCodeProcess(proc, rt);
    throw err;
  }

  // Zeitlimits wie bei Claude und Codex: Gesamtzeit immer, Leerlauf nur im Streaming
  let lastActivityAt = rt.now();
  let timedOut = false;
  let timeoutKind: "idle" | "total" | undefined;
  let stoppedAfterMs = 0;
  let idleForMs = 0;
  let promptError: string | undefined;
  const stopFor = (kind: "idle" | "total") => {
    if (timedOut || abortEntry.aborted || promptError !== undefined) return;
    const now = rt.now();
    timedOut = true;
    timeoutKind = kind;
    stoppedAfterMs = now - startedAt;
    idleForMs = now - lastActivityAt;
    terminateOpenCodeProcess(proc, rt);
  };
  const timeoutId = rt.setTimeout(() => stopFor("total"), Math.max(0, req.timeoutMs - (rt.now() - startedAt)));
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
  const turn = new OpenCodeTurn(
    req.streaming
      ? {
          // Drosselung nur für den Rückruf; tools sammelt OpenCodeTurn vollständig
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
    const event = parseOpenCodeEvent(line);
    if (!event) return;
    lastActivityAt = rt.now();
    turn.apply(event);
  });

  // Prompt über stdin, parallel zum Lesen von stdout; scheitert die Übergabe,
  // wird der Prozess beendet (wie bei Codex)
  void (async () => {
    await proc.stdin.write(req.prompt);
    await proc.stdin.end();
  })().catch((err) => {
    if (exited || stopped()) return;
    promptError = redactOpenCodeDiagnostic(errorText(err));
    console.error("[OpenCode] Prompt konnte nicht übergeben werden:", promptError);
    terminateOpenCodeProcess(proc, rt);
  });

  let streamFailed = false;
  try {
    for await (const chunk of proc.stdout) reader.push(chunk);
    reader.end();
  } catch {
    streamFailed = true;
    if (!stopped()) console.error("[OpenCode] Lesefehler: Ausgabe oder Rückruf fehlgeschlagen");
  }
  const [exitCode, stderr] = await Promise.all([exitedPromise, stderrPromise]);
  clearTimers();
  unregisterEngineCall(req.abortKey, abortEntry);

  if (abortEntry.aborted && !timedOut) return { engine: "opencode", text: "", isError: true, aborted: true };
  if (promptError !== undefined) {
    return { engine: "opencode", text: `OpenCode hat den Auftrag nicht angenommen: ${promptError}`, isError: true, errorKind: "other" };
  }

  const r = turn.result({ exitCode: streamFailed ? null : exitCode, stderr, cwd });

  if (timedOut) {
    console.error(
      `[OpenCode] Zeitlimit (${timeoutKind}) nach ${Math.round(stoppedAfterMs / 1000)}s, ` +
        `letztes Lebenszeichen vor ${Math.round(idleForMs / 1000)}s, sessionId=${r.sessionId || "keine"}`
    );
    if (!req.streaming) return { engine: "opencode", text: "", isError: true, timedOut: true };
    return {
      engine: "opencode",
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
    `[OpenCode] Ergebnis: text=${r.text ? r.text.length + " Zeichen" : "LEER"}, sessionId=${r.sessionId || "keine"}, ` +
      `exit=${exitCode}, isError=${r.isError}${r.errorKind ? ` (${r.errorKind})` : ""}`
  );
  if (r.isError && stderr) console.error("[OpenCode] stderr:", redactOpenCodeDiagnostic(stderr).substring(0, 500));
  return {
    engine: "opencode",
    text: r.text,
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    isError: r.isError,
    ...(r.errorKind ? { errorKind: r.errorKind } : {}),
    ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
    ...(r.usage ? { usage: r.usage } : {}),
    tools: r.tools,
  };
}
