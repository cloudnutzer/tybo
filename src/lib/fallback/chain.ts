/**
 * Fallback-Kette (Issue #331): springt ein, wenn der Hauptmotor mit Fehler
 * oder leerer Antwort endet (nicht nach seinem Zeitlimit, das entscheidet
 * chat-turn.ts). Die Stufen stehen als Liste, eine Schleife geht sie durch:
 *
 * 1. Kimi K3 über OpenRouter, Anbieter gepinnt (FALLBACK_K3=false schaltet ab)
 * 2. Claude-CLI mit eigenem Modell (FALLBACK_CLAUDE_MODEL), ohne Tool-Loop:
 *    die CLI bringt ihre Werkzeuge selbst mit
 * 3. OpenRouter mit einstellbarem Modell
 * 4. Ollama auf diesem Rechner
 *
 * Ohne OPENROUTER_API_KEY entfallen 1 und 3, „nur offline" lässt nur 4 übrig.
 * Die HTTP-Stufen bekommen Werkzeuge aus MCP und den Built-ins.
 *
 * Abbruch (/stop): keine weitere Stufe, kein weiteres Werkzeug, und statt
 * einer Fehlerantwort wirft die Kette einen AbortError.
 */
import { BRAND, OPENROUTER_APP_HEADERS } from "../../brand";
import { callClaude, type ClaudeOptions, type ClaudeResult } from "../claude";
import { abortError, checkAborted, currentExecution, isAbortError } from "../execution-context";
import { mcpManager, type OpenAITool } from "../mcp/manager";
import { getSettings, type Settings } from "../settings";
import { bookRunOutcome } from "../spend/credit";
import { TELEGRAM_FORMAT_RULES } from "../telegram";
import { fallbackTryLogLine } from "../log-lines";
import { realToolLoopDeps, runToolLoop, type ToolLoopDeps } from "./openai-tool-loop";

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------

type Sourced<T> = { value: T; source: "settings" | "env" | "code" };

export interface FallbackSettings {
  openrouterModel: Sourced<string>;
  ollamaModel: Sourced<string>;
  offlineOnly: Sourced<boolean>;
}

function sourced(fromFile: string | undefined, fromEnv: string | undefined, standard: string): Sourced<string> {
  if (fromFile !== undefined) return { value: fromFile, source: "settings" };
  if (fromEnv) return { value: fromEnv, source: "env" };
  return { value: standard, source: "code" };
}

/**
 * Die drei einstellbaren Werte mit Herkunft (WebUI, Issue #36): Datei
 * (fallback.*) vor .env vor Standard. offlineOnly aus der Datei gilt auch
 * als false, damit es ein FALLBACK_OFFLINE_ONLY=true schlagen kann.
 */
export function describeFallback(settings: Settings): FallbackSettings {
  const file = settings.fallback;
  const offlineEnv = process.env.FALLBACK_OFFLINE_ONLY;
  let offlineOnly: Sourced<boolean>;
  if (file?.offlineOnly !== undefined) offlineOnly = { value: file.offlineOnly, source: "settings" };
  else if (offlineEnv) offlineOnly = { value: offlineEnv === "true", source: "env" };
  else offlineOnly = { value: false, source: "code" };
  return {
    openrouterModel: sourced(file?.openrouterModel, process.env.OPENROUTER_MODEL, "minimax/minimax-m2.7"),
    ollamaModel: sourced(file?.ollamaModel, process.env.OLLAMA_MODEL, "qwen3:8b"),
    offlineOnly,
  };
}

// Je Aufruf frisch gelesen: eine geänderte Einstellungsdatei wirkt ohne Neustart
export const OPENROUTER_MODEL = () => describeFallback(getSettings()).openrouterModel.value;
export const OLLAMA_MODEL = () => describeFallback(getSettings()).ollamaModel.value;
export const FALLBACK_OFFLINE_ONLY = () => describeFallback(getSettings()).offlineOnly.value;

const openrouterKey = () => process.env.OPENROUTER_API_KEY || "";
const k3Enabled = () => process.env.FALLBACK_K3 !== "false";
// K3 kostet bei allen Anbietern gleich viel, Fireworks antwortet aber deutlich
// schneller; allow_fallbacks lässt OpenRouter ausweichen, wenn er ausfällt
const k3Model = () => process.env.FALLBACK_K3_MODEL || "moonshotai/kimi-k3";
const k3Provider = () => process.env.FALLBACK_K3_PROVIDER || "Fireworks";
// effort high statt xhigh: im Ersatzweg zählt die Antwortzeit
const cliModel = () => process.env.FALLBACK_CLAUDE_MODEL || "claude-opus-5[1m]";
const cliEffort = () => process.env.FALLBACK_CLAUDE_EFFORT || "high";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OLLAMA_URL = "http://localhost:11434/v1/chat/completions";
const HTTP_TIMEOUT_MS = 60_000;
const HTTP_MAX_TOKENS = 4096;
// K3 denkt immer und lange; Denk-Tokens zählen zur Ausgabe
const K3_TIMEOUT_MS = 240_000;
const K3_MAX_TOKENS = 16_000;
const CLI_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Schnittstelle
// ---------------------------------------------------------------------------

export type FallbackSource = "kimi-k3" | "opus5" | "openrouter" | "ollama" | "none";

/** Ergebnis der Kette; model ist das Modell, das geantwortet hat, und fehlt bei source "none" */
export type FallbackResult = { text: string; source: FallbackSource; model?: string };

export interface FallbackRequest {
  /** Die Frage, wie sie das Modell bekommt */
  question: string;
  /**
   * Gesprächskontext (Profil, Gedächtnis, Verlauf, Suchtreffer), Pflicht:
   * ohne ihn antwortet das Ersatzmodell ins Blaue (fallback/context.ts)
   */
  context: string;
}

export interface ChainDeps {
  callClaude(request: ClaudeOptions): Promise<ClaudeResult>;
  /** Werkzeuge für die HTTP-Stufen; undefined, wenn keine bereitstehen */
  tools(): OpenAITool[] | undefined;
  loop: ToolLoopDeps;
}

const realDeps: ChainDeps = {
  callClaude: (request) => callClaude(request),
  tools: () => (mcpManager.isReady && mcpManager.toolCount > 0 ? mcpManager.getOpenAITools() : undefined),
  loop: realToolLoopDeps,
};

/** Antwort, wenn keine Stufe geantwortet hat */
export const NO_BACKEND_REPLY =
  "Gerade erreiche ich keines meiner Ersatzmodelle. Bitte versuch es in ein paar Minuten noch einmal.";

/** Text für den Nutzer: mit Herkunftszusatz, wenn eine Stufe geantwortet hat */
export function fallbackReplyText(result: FallbackResult): string {
  if (result.source === "none") return result.text;
  return `${result.text}\n\n_(Antwort über ${result.source})_`;
}

// ---------------------------------------------------------------------------
// Stufen
// ---------------------------------------------------------------------------

interface StageInput {
  model: string;
  request: FallbackRequest;
  tools?: OpenAITool[];
  deps: ChainDeps;
}

interface Stage {
  source: Exclude<FallbackSource, "none">;
  name: string;
  /** Beim Erreichen der Stufe geprüft (Einstellungen frisch) */
  active(): boolean;
  /** Einmal je Stufe aufgelöst: die gemeldete Herkunft bleibt stabil */
  model(): string;
  ask(input: StageInput): Promise<string | null>;
}

function systemPrompt(context: string, tools: OpenAITool[] | undefined): string {
  const timezone = process.env.USER_TIMEZONE || "UTC";
  const now = new Intl.DateTimeFormat("de-DE", { timeZone: timezone, dateStyle: "full", timeStyle: "short" }).format(new Date());
  const user = process.env.USER_NAME;
  const parts = [
    `Du bist ${process.env.BOT_NAME || BRAND.name}, ${user ? `der persönliche KI-Assistent von ${user}` : "ein persönlicher KI-Assistent"}, und antwortest in einem Chat (Telegram oder Browser).`,
    `Jetzt ist ${now} (${timezone}).`,
    "Das Hauptmodell ist gerade nicht erreichbar, du springst als Ersatz ein.",
  ];
  if (tools?.length) {
    parts.push(
      `Dir stehen ${tools.length} Werkzeuge zur Verfügung (MCP-Server und eingebaute Werkzeuge, etwa Websuche, Dateien oder Sprachnachrichten an den Nutzer). Nutze sie, wenn die Frage es verlangt.`
    );
  }
  if (context) {
    parts.push(`${context}\n\nDer Kontext oben stammt aus dem Gespräch, dem Gedächtnis und dem Profil des Nutzers. Beziehe ihn in die Antwort ein.`);
  }
  parts.push("Antworte knapp und fürs Handy lesbar.", TELEGRAM_FORMAT_RULES);
  return parts.join("\n\n");
}

function httpStage(
  source: "kimi-k3" | "openrouter" | "ollama",
  name: string,
  active: () => boolean,
  model: () => string,
  shape: { url: string; key: () => string; headers?: Record<string, string>; timeoutMs: number; maxTokens: number; extraBody?: () => Record<string, unknown> }
): Stage {
  return {
    source,
    name,
    active,
    model,
    ask: ({ model, request, tools, deps }) =>
      runToolLoop(
        {
          url: shape.url,
          apiKey: shape.key(),
          model,
          system: systemPrompt(request.context, tools),
          question: request.question,
          tools,
          headers: shape.headers ? { ...shape.headers } : undefined,
          timeoutMs: shape.timeoutMs,
          maxTokens: shape.maxTokens,
          extraBody: shape.extraBody?.(),
        },
        deps.loop
      ),
  };
}

const cliStage: Stage = {
  source: "opus5",
  name: "Claude-CLI",
  active: () => !FALLBACK_OFFLINE_ONLY(),
  model: cliModel,
  async ask({ model, request, deps }) {
    const prompt = request.context ? `${request.context}\n\n---\n\n${request.question}` : request.question;
    const result = await deps.callClaude({
      prompt,
      model,
      effort: cliEffort(),
      timeoutMs: CLI_TIMEOUT_MS,
      abortKey: currentExecution()?.key,
    });
    // Textformat: die CLI meldet keine Kosten, der Lauf zählt als „nicht gemeldet" (Issue #346)
    void bookRunOutcome("fallback", "claude", model, result);
    if (result.aborted) throw abortError();
    if (!result.isError && result.text) return result.text;
    const why = result.timedOut ? `Zeitlimit (${CLI_TIMEOUT_MS / 1000} s)` : result.text?.slice(0, 150) || "leere Antwort";
    console.error(`[Fallback] Claude-CLI (${model}) ohne Antwort: ${why}`);
    return null;
  },
};

const online = () => !!openrouterKey() && !FALLBACK_OFFLINE_ONLY();

/** Reihenfolge der Kette */
const STAGES: Stage[] = [
  httpStage("kimi-k3", "Kimi K3", () => k3Enabled() && online(), k3Model, {
    url: OPENROUTER_URL,
    key: openrouterKey,
    headers: OPENROUTER_APP_HEADERS,
    timeoutMs: K3_TIMEOUT_MS,
    maxTokens: K3_MAX_TOKENS,
    extraBody: () => ({ provider: { order: [k3Provider()], allow_fallbacks: true } }),
  }),
  cliStage,
  httpStage("openrouter", "OpenRouter", online, OPENROUTER_MODEL, {
    url: OPENROUTER_URL,
    key: openrouterKey,
    headers: OPENROUTER_APP_HEADERS,
    timeoutMs: HTTP_TIMEOUT_MS,
    maxTokens: HTTP_MAX_TOKENS,
  }),
  httpStage("ollama", "Ollama", () => true, OLLAMA_MODEL, {
    url: OLLAMA_URL,
    key: () => "",
    timeoutMs: HTTP_TIMEOUT_MS,
    maxTokens: HTTP_MAX_TOKENS,
  }),
];

const userAborted = () => currentExecution()?.controller.signal.aborted === true;

/**
 * Geht die Stufen der Reihe nach durch und liefert die erste nicht leere
 * Antwort, sonst NO_BACKEND_REPLY mit source "none". Wirft AbortError nach
 * einem Nutzerabbruch.
 */
export async function runFallbackChain(
  request: FallbackRequest,
  overrides: Partial<ChainDeps> = {}
): Promise<FallbackResult> {
  const deps: ChainDeps = { ...realDeps, ...overrides };
  checkAborted();
  const tools = deps.tools();
  if (tools) console.log(`[Fallback] ${tools.length} Werkzeuge verfügbar (MCP und eingebaute)`);

  for (const stage of STAGES) {
    checkAborted();
    if (!stage.active()) continue;
    const model = stage.model();
    // Text aus log-lines.ts: der Nachtcheck zählt genau diese Zeile (Issue #568)
    console.log(fallbackTryLogLine(stage.name, model));
    try {
      const text = await stage.ask({ model, request, tools, deps });
      // /stop während der Stufe: auch eine noch gelieferte Antwort verwerfen
      if (userAborted()) throw abortError();
      if (text) {
        console.log(`✅ ${stage.name} hat geantwortet (${model})`);
        return { text, source: stage.source, model };
      }
    } catch (err) {
      // Ein Zeitlimit der Stufe (TimeoutError) ist kein Abbruch: weiter zur nächsten
      if (userAborted() || isAbortError(err)) throw abortError();
      console.error(`❌ ${stage.name} gescheitert:`, err);
    }
  }

  checkAborted();
  return { text: NO_BACKEND_REPLY, source: "none" };
}
