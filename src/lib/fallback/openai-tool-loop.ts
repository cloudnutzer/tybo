/**
 * Tool-Loop für alle OpenAI-kompatiblen Stufen der Fallback-Kette
 * (OpenRouter, Kimi K3, Ollama), Issue #331.
 *
 * Ablauf je Runde: Anfrage schicken, kommt Text zurück, ist er die Antwort;
 * verlangt das Modell Werkzeuge, laufen sie nacheinander über callTool (dort
 * sitzt die Freigabe schreibender Werkzeuge), ihre Ergebnisse gehen mit der
 * passenden tool_call_id in die nächste Runde. Nach maxRounds ohne Text: null.
 *
 * Abhängigkeiten (fetch, Werkzeugaufruf, Budget) kommen herein, damit Tests
 * ohne Netz, MCP-Server und echte Budgetdatei auskommen.
 */
import { reserveBudget, settleBudget } from "../daily-budget";
import { checkAborted, executionSignal } from "../execution-context";
import { mcpManager, type OpenAITool } from "../mcp/manager";

/** Höchstlänge eines Werkzeugergebnisses im Gespräch mit dem Modell */
export const TOOL_RESULT_LIMIT = 4000;
/** Höchstzahl Runden einer Stufe */
export const MAX_TOOL_ROUNDS = 10;

export interface ToolLoopDeps {
  fetch(url: string, init: RequestInit): Promise<Response>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }>;
  /** Reserviert vorab im Tagesbudget, liefert die Kennung der Reservierung */
  reserve(provider: string, amountUsd: number): string;
  /** Verbucht die Reservierung; ohne bekannte Kosten zählt die Reservierung */
  settle(id: string, costUsd?: number): void;
}

export interface ToolLoopRequest {
  url: string;
  /** Leer: kein Authorization-Kopf, keine Budget-Reservierung (Ollama) */
  apiKey: string;
  model: string;
  system: string;
  question: string;
  tools?: OpenAITool[];
  headers?: Record<string, string>;
  timeoutMs: number;
  maxTokens: number;
  /** Zusätzliche Felder im Anfragekörper (Provider-Pinning bei K3) */
  extraBody?: Record<string, unknown>;
  maxRounds?: number;
}

export const realToolLoopDeps: ToolLoopDeps = {
  fetch: (url, init) => fetch(url, init),
  callTool: (name, args) => mcpManager.callTool(name, args),
  reserve: reserveBudget,
  settle: settleBudget,
};

interface ToolCall {
  id?: string;
  function?: { name?: string; arguments?: unknown };
}

interface ChatMessage {
  role: string;
  content?: string | null;
  reasoning?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

function reservationUsd(): number {
  return Number(process.env.FALLBACK_REQUEST_RESERVATION_USD || "1");
}

/** Argumente eines Werkzeugaufrufs; Unlesbares wird zu {} */
function toolArguments(raw: unknown, name: string): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || raw === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    console.error(`[Fallback] Unlesbare Argumente für Werkzeug ${name}, rufe es ohne auf`);
    return {};
  }
}

/** Eine Anfrage samt Budget; liefert die Antwort oder null bei HTTP-Fehler */
async function sendRound(
  req: ToolLoopRequest,
  messages: ChatMessage[],
  tools: OpenAITool[] | undefined,
  deps: ToolLoopDeps
): Promise<{ status: number; data?: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...req.headers };
  if (req.apiKey) headers.Authorization = `Bearer ${req.apiKey}`;
  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    max_tokens: req.maxTokens,
    ...req.extraBody,
  };
  if (tools?.length) body.tools = tools;

  const hold = req.apiKey ? deps.reserve("openrouter", reservationUsd()) : undefined;
  let cost: number | undefined;
  try {
    const res = await deps.fetch(req.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: executionSignal(req.timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[Fallback] ${req.model}: HTTP ${res.status} ${detail.slice(0, 200)}`);
      return { status: res.status };
    }
    const data = await res.json();
    if (typeof data?.usage?.cost === "number") cost = data.usage.cost;
    return { status: res.status, data };
  } finally {
    if (hold !== undefined) deps.settle(hold, cost);
  }
}

/**
 * Fragt ein OpenAI-kompatibles Modell, mit Werkzeugen, wenn vorhanden.
 * Text der Antwort, oder null (HTTP-Fehler, keine Auswahl, Rundenlimit).
 * Scheitert Runde 1 mit Werkzeugen am HTTP-Status, folgt genau ein
 * Neuversuch ohne Werkzeuge (manche Modelle können keine).
 */
export async function runToolLoop(
  req: ToolLoopRequest,
  deps: ToolLoopDeps = realToolLoopDeps
): Promise<string | null> {
  const rounds = req.maxRounds ?? MAX_TOOL_ROUNDS;
  const tools = req.tools?.length ? req.tools : undefined;
  const messages: ChatMessage[] = [
    { role: "system", content: req.system },
    { role: "user", content: req.question },
  ];

  for (let round = 0; round < rounds; round++) {
    checkAborted();
    const { status, data } = await sendRound(req, messages, tools, deps);
    if (!data) {
      if (tools && round === 0) {
        console.log(`[Fallback] ${req.model}: neuer Versuch ohne Werkzeuge (HTTP ${status})`);
        return runToolLoop({ ...req, tools: undefined, maxRounds: 1 }, deps);
      }
      return null;
    }

    const reply: ChatMessage | undefined = data.choices?.[0]?.message;
    if (!reply) return null;
    const calls = reply.tool_calls ?? [];
    if (calls.length === 0) return reply.content || reply.reasoning || "";

    console.log(`[Fallback] ${req.model} ruft Werkzeuge: ${calls.map((c) => c.function?.name).join(", ")}`);
    messages.push(reply);
    for (const call of calls) {
      checkAborted();
      const name = call.function?.name ?? "";
      const result = await deps.callTool(name, toolArguments(call.function?.arguments, name));
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result.content.slice(0, TOOL_RESULT_LIMIT),
      });
    }
  }

  console.log(`[Fallback] ${req.model}: ${rounds} Runden ohne Antwort, gebe auf`);
  return null;
}
