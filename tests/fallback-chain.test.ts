/**
 * Fallback-Kette (Issue #331): Reihenfolge, Schalter, Tool-Loop, Budget,
 * Abbruch und Kontext. Kein Netz, keine CLI, keine MCP-Server: fetch, der
 * Claude-Aufruf, Werkzeugliste, Werkzeugaufruf und Budget kommen als
 * Abhängigkeiten herein. Die Einstellungsdatei liegt im Temp-Ordner.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENROUTER_APP_HEADERS } from "../src/brand";
import { setSettingsPath } from "../src/lib/settings";
import { abortExecutions, isAbortError, runCancelable } from "../src/lib/execution-context";
import type { ClaudeOptions, ClaudeResult } from "../src/lib/claude";
import type { OpenAITool } from "../src/lib/mcp/manager";
import {
  NO_BACKEND_REPLY,
  fallbackReplyText,
  runFallbackChain,
  type ChainDeps,
} from "../src/lib/fallback/chain";
import { runToolLoop, type ToolLoopDeps } from "../src/lib/fallback/openai-tool-loop";

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "OLLAMA_MODEL",
  "FALLBACK_OFFLINE_ONLY",
  "FALLBACK_K3",
  "FALLBACK_K3_MODEL",
  "FALLBACK_K3_PROVIDER",
  "FALLBACK_CLAUDE_MODEL",
  "FALLBACK_CLAUDE_EFFORT",
  "FALLBACK_REQUEST_RESERVATION_USD",
] as const;
const saved: Record<string, string | undefined> = {};
let dir: string;
let spies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "tybo-fallback-chain-"));
  setSettingsPath(join(dir, "settings.json"));
  spies = [
    spyOn(console, "log").mockImplementation(() => {}),
    spyOn(console, "warn").mockImplementation(() => {}),
    spyOn(console, "error").mockImplementation(() => {}),
  ];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const s of spies) s.mockRestore();
  setSettingsPath();
  rmSync(dir, { recursive: true, force: true });
});

const K3_URL = "https://openrouter.ai/api/v1/chat/completions";
const OLLAMA_URL = "http://localhost:11434/v1/chat/completions";

interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: any;
}

type Reply = Response | ((req: SentRequest, signal?: AbortSignal) => Response | Promise<Response>);

const textReply = (content: string, cost?: number) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content } }],
      ...(cost !== undefined ? { usage: { cost } } : {}),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

const toolReply = (calls: { id: string; name: string; args: unknown }[]) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })),
          },
        },
      ],
    }),
    { status: 200 }
  );

const httpError = (status = 500) => new Response("kaputt", { status });

/** fetch-Attrappe: Antworten je Modell der Reihe nach, ohne Eintrag ein 500. Hält das Signal ein. */
function scriptedFetch(byModel: Record<string, Reply[]>) {
  const sent: SentRequest[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req: SentRequest = {
      url: String(input),
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(String(init?.body ?? "{}")),
    };
    sent.push(req);
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw signal.reason;
    const next = byModel[req.body.model]?.shift();
    if (!next) return httpError();
    const res = typeof next === "function" ? next(req, signal) : next;
    if (!(res instanceof Promise)) return res;
    return new Promise<Response>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      res.then(resolve, reject);
    });
  }) as typeof fetch;
  return { fn, sent };
}

/** Claude-Aufruf-Attrappe */
function fakeClaude(results: (ClaudeResult | (() => Promise<ClaudeResult>))[]) {
  const calls: ClaudeOptions[] = [];
  const fn = async (req: ClaudeOptions): Promise<ClaudeResult> => {
    calls.push(req);
    const next = results.shift() ?? { text: "", isError: true };
    return typeof next === "function" ? next() : next;
  };
  return { fn, calls };
}

interface BudgetLog {
  reserved: { provider: string; amount: number; id: string }[];
  settled: { id: string; cost?: number }[];
}

function fakeBudget(): { log: BudgetLog; reserve: ToolLoopDeps["reserve"]; settle: ToolLoopDeps["settle"] } {
  const log: BudgetLog = { reserved: [], settled: [] };
  return {
    log,
    reserve: (provider, amount) => {
      const id = `r${log.reserved.length + 1}`;
      log.reserved.push({ provider, amount, id });
      return id;
    },
    settle: (id, cost) => {
      log.settled.push({ id, cost });
    },
  };
}

const TOOL: OpenAITool = { type: "function", function: { name: "suche", description: "sucht", parameters: {} } };

function deps(over: {
  fetch?: typeof fetch;
  claude?: ChainDeps["callClaude"];
  tools?: OpenAITool[];
  callTool?: ToolLoopDeps["callTool"];
  budget?: ReturnType<typeof fakeBudget>;
}): Partial<ChainDeps> {
  const budget = over.budget ?? fakeBudget();
  return {
    callClaude: over.claude ?? (async () => ({ text: "", isError: true })),
    tools: () => over.tools,
    loop: {
      fetch: over.fetch ?? scriptedFetch({}).fn,
      callTool: over.callTool ?? (async () => ({ content: "", isError: false })),
      reserve: budget.reserve,
      settle: budget.settle,
    },
  };
}

const REQ = { question: "Wie wird das Wetter?", context: "## MEMORY\nAlex mag Regen." };

describe("Reihenfolge K3 → Opus-CLI → OpenRouter → Ollama", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-schluessel-nicht-echt";
  });

  test("K3 gewinnt: kein CLI-Aufruf, keine weitere Anfrage", async () => {
    const f = scriptedFetch({ "moonshotai/kimi-k3": [textReply("von k3")] });
    const c = fakeClaude([]);
    const result = await runFallbackChain(REQ, deps({ fetch: f.fn, claude: c.fn }));
    expect(result).toEqual({ text: "von k3", source: "kimi-k3", model: "moonshotai/kimi-k3" });
    expect(c.calls).toHaveLength(0);
    expect(f.sent).toHaveLength(1);
  });

  test("Opus-CLI gewinnt nach gescheitertem K3", async () => {
    const f = scriptedFetch({});
    const c = fakeClaude([{ text: "von opus", isError: false }]);
    const result = await runFallbackChain(REQ, deps({ fetch: f.fn, claude: c.fn }));
    expect(result).toEqual({ text: "von opus", source: "opus5", model: "claude-opus-5[1m]" });
    expect(f.sent.map((r) => r.body.model)).toEqual(["moonshotai/kimi-k3"]);
    expect(c.calls[0]).toMatchObject({ model: "claude-opus-5[1m]", effort: "high", timeoutMs: 300_000 });
  });

  test("OpenRouter gewinnt nach K3 und CLI", async () => {
    const f = scriptedFetch({ "minimax/minimax-m2.7": [textReply("von openrouter")] });
    const c = fakeClaude([{ text: "Fehler", isError: true }]);
    const result = await runFallbackChain(REQ, deps({ fetch: f.fn, claude: c.fn }));
    expect(result).toEqual({ text: "von openrouter", source: "openrouter", model: "minimax/minimax-m2.7" });
    expect(f.sent.map((r) => r.body.model)).toEqual(["moonshotai/kimi-k3", "minimax/minimax-m2.7"]);
  });

  test("Ollama gewinnt als letzte Stufe; Reihenfolge aller Versuche", async () => {
    const order: string[] = [];
    const f = scriptedFetch({ "qwen3:8b": [textReply("von ollama")] });
    const recording = (async (input: any, init?: RequestInit) => {
      order.push(`http:${JSON.parse(String(init?.body)).model}`);
      return f.fn(input, init);
    }) as typeof fetch;
    const c = fakeClaude([]);
    const claude = async (r: ClaudeOptions) => {
      order.push("cli");
      return c.fn(r);
    };
    const result = await runFallbackChain(REQ, deps({ fetch: recording, claude }));
    expect(result).toEqual({ text: "von ollama", source: "ollama", model: "qwen3:8b" });
    expect(order).toEqual(["http:moonshotai/kimi-k3", "cli", "http:minimax/minimax-m2.7", "http:qwen3:8b"]);
    expect(f.sent[2].url).toBe(OLLAMA_URL);
  });

  test("alle scheitern: source none mit deutschem Text, ohne Zusatz", async () => {
    const result = await runFallbackChain(REQ, deps({}));
    expect(result).toEqual({ text: NO_BACKEND_REPLY, source: "none" });
    expect(NO_BACKEND_REPLY).not.toMatch(/trouble|backends|Please/i);
    expect(fallbackReplyText(result)).toBe(NO_BACKEND_REPLY);
  });

  test("leere Antwort zählt als Scheitern", async () => {
    const f = scriptedFetch({ "moonshotai/kimi-k3": [textReply("")], "minimax/minimax-m2.7": [textReply("ok")] });
    const c = fakeClaude([{ text: "", isError: false }]);
    expect((await runFallbackChain(REQ, deps({ fetch: f.fn, claude: c.fn }))).source).toBe("openrouter");
  });

  test("FALLBACK_K3=false überspringt K3", async () => {
    process.env.FALLBACK_K3 = "false";
    const f = scriptedFetch({});
    const c = fakeClaude([]);
    await runFallbackChain(REQ, deps({ fetch: f.fn, claude: c.fn }));
    expect(f.sent.map((r) => r.body.model)).toEqual(["minimax/minimax-m2.7", "qwen3:8b"]);
    expect(c.calls).toHaveLength(1);
  });

  test("ohne OPENROUTER_API_KEY entfallen K3 und OpenRouter", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const f = scriptedFetch({});
    const c = fakeClaude([]);
    await runFallbackChain(REQ, deps({ fetch: f.fn, claude: c.fn }));
    expect(f.sent.map((r) => r.url)).toEqual([OLLAMA_URL]);
    expect(c.calls).toHaveLength(1);
  });

  test("offline-only lässt nur Ollama übrig", async () => {
    process.env.FALLBACK_OFFLINE_ONLY = "true";
    const f = scriptedFetch({ "qwen3:8b": [textReply("lokal")] });
    const c = fakeClaude([]);
    expect(await runFallbackChain(REQ, deps({ fetch: f.fn, claude: c.fn }))).toEqual({
      text: "lokal",
      source: "ollama",
      model: "qwen3:8b",
    });
    expect(f.sent).toHaveLength(1);
    expect(c.calls).toHaveLength(0);
  });

  test("Env-Namen für Modelle und Effort wirken", async () => {
    process.env.FALLBACK_K3_MODEL = "anbieter/k3-variante";
    process.env.FALLBACK_CLAUDE_MODEL = "claude-test";
    process.env.FALLBACK_CLAUDE_EFFORT = "medium";
    process.env.OPENROUTER_MODEL = "env/openrouter";
    process.env.OLLAMA_MODEL = "env-ollama";
    const f = scriptedFetch({});
    const c = fakeClaude([]);
    await runFallbackChain(REQ, deps({ fetch: f.fn, claude: c.fn }));
    expect(f.sent.map((r) => r.body.model)).toEqual(["anbieter/k3-variante", "env/openrouter", "env-ollama"]);
    expect(c.calls[0]).toMatchObject({ model: "claude-test", effort: "medium" });
  });

  test("HTTP-Zeitlimit einer Stufe führt zur nächsten", async () => {
    const timeout = () => {
      throw new DOMException("Zeit abgelaufen", "TimeoutError");
    };
    const f = scriptedFetch({ "moonshotai/kimi-k3": [timeout as any], "minimax/minimax-m2.7": [timeout as any], "qwen3:8b": [textReply("lokal")] });
    const c = fakeClaude([{ text: "", isError: true, timedOut: true }]);
    const result = await runFallbackChain(REQ, deps({ fetch: f.fn, claude: c.fn }));
    expect(result.source).toBe("ollama");
    expect(c.calls).toHaveLength(1);
  });

  test("CLI-Zeitlimit (timedOut) führt zur nächsten Stufe", async () => {
    process.env.FALLBACK_K3 = "false";
    const f = scriptedFetch({ "minimax/minimax-m2.7": [textReply("weiter")] });
    const c = fakeClaude([{ text: "", isError: true, timedOut: true }]);
    expect((await runFallbackChain(REQ, deps({ fetch: f.fn, claude: c.fn }))).source).toBe("openrouter");
  });
});

describe("Anfragen der HTTP-Stufen", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-schluessel-nicht-echt";
  });

  test("K3: Provider-Pinning, Tokengrenze, Kopfzeilen", async () => {
    const f = scriptedFetch({ "moonshotai/kimi-k3": [textReply("k3")] });
    await runFallbackChain(REQ, deps({ fetch: f.fn }));
    const [k3] = f.sent;
    expect(k3.url).toBe(K3_URL);
    expect(k3.body.provider).toEqual({ order: ["Fireworks"], allow_fallbacks: true });
    expect(k3.body.max_tokens).toBe(16000);
    expect(k3.headers).toMatchObject(OPENROUTER_APP_HEADERS);
    expect(k3.headers.Authorization).toBe("Bearer test-schluessel-nicht-echt");
  });

  test("FALLBACK_K3_PROVIDER pinnt einen anderen Anbieter", async () => {
    process.env.FALLBACK_K3_PROVIDER = "Moonshot";
    const f = scriptedFetch({ "moonshotai/kimi-k3": [textReply("k3")] });
    await runFallbackChain(REQ, deps({ fetch: f.fn }));
    expect(f.sent[0].body.provider).toEqual({ order: ["Moonshot"], allow_fallbacks: true });
  });

  test("OpenRouter sendet OPENROUTER_APP_HEADERS, Ollama keine Kopfzeilen der App und keinen Schlüssel", async () => {
    process.env.FALLBACK_K3 = "false";
    const f = scriptedFetch({});
    await runFallbackChain(REQ, deps({ fetch: f.fn }));
    const [openrouter, ollama] = f.sent;
    expect(openrouter.url).toBe(K3_URL);
    expect(openrouter.headers).toMatchObject(OPENROUTER_APP_HEADERS);
    expect(openrouter.body.max_tokens).toBe(4096);
    expect(openrouter.body.provider).toBeUndefined();
    expect(ollama.url).toBe(OLLAMA_URL);
    expect(ollama.headers.Authorization).toBeUndefined();
    expect(ollama.headers["HTTP-Referer"]).toBeUndefined();
  });

  test("Kontext steht im Systemprompt der HTTP-Stufen, die Frage als Nutzernachricht", async () => {
    const f = scriptedFetch({});
    await runFallbackChain(REQ, deps({ fetch: f.fn }));
    expect(f.sent).toHaveLength(3);
    for (const r of f.sent) {
      expect(r.body.messages[0].role).toBe("system");
      expect(r.body.messages[0].content).toContain(REQ.context);
      expect(r.body.messages[1]).toEqual({ role: "user", content: REQ.question });
    }
  });

  test("Systemprompt auf Deutsch mit Namen aus BOT_NAME und USER_NAME", async () => {
    const saved = [process.env.BOT_NAME, process.env.USER_NAME];
    process.env.BOT_NAME = "Testbot";
    process.env.USER_NAME = "Mia";
    try {
      const f = scriptedFetch({ "moonshotai/kimi-k3": [textReply("ok")] });
      await runFallbackChain(REQ, deps({ fetch: f.fn }));
      const system = f.sent[0].body.messages[0].content as string;
      expect(system).toContain("Du bist Testbot, der persönliche KI-Assistent von Mia");
      expect(system).toContain("Ersatz");
      expect(system).not.toMatch(/You are|Fallback mode|Keep responses/);
    } finally {
      for (const [k, v] of [["BOT_NAME", saved[0]], ["USER_NAME", saved[1]]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("Kontext steht im CLI-Prompt vor der Frage", async () => {
    const c = fakeClaude([{ text: "ok", isError: false }]);
    await runFallbackChain(REQ, deps({ claude: c.fn }));
    const prompt = c.calls[0].prompt;
    expect(prompt.indexOf(REQ.context)).toBe(0);
    expect(prompt.indexOf(REQ.question)).toBeGreaterThan(REQ.context.length);
  });

  test("Werkzeuge gehen an die HTTP-Stufen, nicht an die CLI", async () => {
    const f = scriptedFetch({});
    const c = fakeClaude([]);
    await runFallbackChain(REQ, deps({ fetch: f.fn, claude: c.fn, tools: [TOOL] }));
    // je Stufe ein 500 in Runde 1 mit Werkzeugen, dann genau ein Neuversuch ohne
    expect(f.sent.map((r) => [r.body.model, r.body.tools?.length ?? 0])).toEqual([
      ["moonshotai/kimi-k3", 1],
      ["moonshotai/kimi-k3", 0],
      ["minimax/minimax-m2.7", 1],
      ["minimax/minimax-m2.7", 0],
      ["qwen3:8b", 1],
      ["qwen3:8b", 0],
    ]);
    expect(c.calls[0]).not.toHaveProperty("tools");
  });
});

describe("Tool-Loop", () => {
  const loopReq = (over: Partial<Parameters<typeof runToolLoop>[0]> = {}) => ({
    url: OLLAMA_URL,
    apiKey: "",
    model: "m",
    system: "System",
    question: "Frage",
    tools: [TOOL],
    timeoutMs: 1000,
    maxTokens: 100,
    ...over,
  });

  test("Ergebnis landet mit passender tool_call_id in der nächsten Anfrage, gekürzt auf 4000 Zeichen; kaputte Argumente werden {}", async () => {
    const f = scriptedFetch({
      m: [
        toolReply([
          { id: "c1", name: "suche", args: '{"q":"wetter"}' },
          { id: "c2", name: "suche", args: "{kaputt" },
          { id: "c3", name: "suche", args: { q: "objekt" } },
        ]),
        textReply("fertig"),
      ],
    });
    const toolCalls: { name: string; args: Record<string, unknown> }[] = [];
    const callTool = async (name: string, args: Record<string, unknown>) => {
      toolCalls.push({ name, args });
      return { content: toolCalls.length === 1 ? "x".repeat(5000) : `ergebnis ${toolCalls.length}`, isError: false };
    };
    const text = await runToolLoop(loopReq(), { fetch: f.fn, callTool, ...fakeBudget() });
    expect(text).toBe("fertig");
    expect(toolCalls).toEqual([
      { name: "suche", args: { q: "wetter" } },
      { name: "suche", args: {} },
      { name: "suche", args: { q: "objekt" } },
    ]);
    const second = f.sent[1].body.messages;
    const toolMsgs = second.filter((m: any) => m.role === "tool");
    expect(toolMsgs.map((m: any) => m.tool_call_id)).toEqual(["c1", "c2", "c3"]);
    expect(toolMsgs[0].content).toHaveLength(4000);
    expect(toolMsgs[1].content).toBe("ergebnis 2");
    // die Anfrage des Modells steht vor den Ergebnissen
    expect(second[2].role).toBe("assistant");
    expect(second[2].tool_calls).toHaveLength(3);
  });

  test("nach 10 Runden ohne Antwort: null, in der Kette weiter zur nächsten Stufe", async () => {
    const endless = Array.from({ length: 10 }, (_, i) => toolReply([{ id: `c${i}`, name: "suche", args: "{}" }]));
    const f = scriptedFetch({ m: [...endless] });
    expect(await runToolLoop(loopReq(), { fetch: f.fn, callTool: async () => ({ content: "", isError: false }), ...fakeBudget() })).toBeNull();
    expect(f.sent).toHaveLength(10);

    process.env.OPENROUTER_API_KEY = "test-schluessel-nicht-echt";
    process.env.FALLBACK_K3 = "false";
    const chainFetch = scriptedFetch({
      "minimax/minimax-m2.7": Array.from({ length: 10 }, (_, i) => toolReply([{ id: `c${i}`, name: "suche", args: "{}" }])),
      "qwen3:8b": [textReply("lokal")],
    });
    const result = await runFallbackChain(REQ, deps({ fetch: chainFetch.fn, tools: [TOOL] }));
    expect(result.source).toBe("ollama");
    expect(chainFetch.sent.filter((r) => r.body.model === "minimax/minimax-m2.7")).toHaveLength(10);
  });

  test("HTTP-Fehler in Runde 1 mit Werkzeugen: genau ein Neuversuch ohne Werkzeuge", async () => {
    const f = scriptedFetch({ m: [httpError(400), textReply("ohne werkzeuge")] });
    expect(await runToolLoop(loopReq(), { fetch: f.fn, callTool: async () => ({ content: "", isError: false }), ...fakeBudget() })).toBe("ohne werkzeuge");
    expect(f.sent.map((r) => r.body.tools)).toEqual([[TOOL], undefined]);

    const twice = scriptedFetch({ m: [httpError(400), httpError(400)] });
    expect(await runToolLoop(loopReq(), { fetch: twice.fn, callTool: async () => ({ content: "", isError: false }), ...fakeBudget() })).toBeNull();
    expect(twice.sent).toHaveLength(2);
  });

  test("HTTP-Fehler ohne Werkzeuge oder in späterer Runde: kein Neuversuch", async () => {
    const plain = scriptedFetch({ m: [httpError()] });
    expect(await runToolLoop(loopReq({ tools: undefined }), { fetch: plain.fn, callTool: async () => ({ content: "", isError: false }), ...fakeBudget() })).toBeNull();
    expect(plain.sent).toHaveLength(1);

    const later = scriptedFetch({ m: [toolReply([{ id: "c1", name: "suche", args: "{}" }]), httpError()] });
    expect(await runToolLoop(loopReq(), { fetch: later.fn, callTool: async () => ({ content: "", isError: false }), ...fakeBudget() })).toBeNull();
    expect(later.sent).toHaveLength(2);
  });

  test("reasoning statt content wird als Antwort genommen", async () => {
    const f = scriptedFetch({
      m: [new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "", reasoning: "gedacht" } }] }))],
    });
    expect(await runToolLoop(loopReq({ tools: undefined }), { fetch: f.fn, callTool: async () => ({ content: "", isError: false }), ...fakeBudget() })).toBe("gedacht");
  });
});

describe("Budget", () => {
  test("mit Schlüssel: Reservierung je Anfrage, Abrechnung mit usage.cost", async () => {
    process.env.FALLBACK_REQUEST_RESERVATION_USD = "0.5";
    const budget = fakeBudget();
    const f = scriptedFetch({ m: [toolReply([{ id: "c1", name: "suche", args: "{}" }]), textReply("ok", 0.02)] });
    await runToolLoop(
      { url: K3_URL, apiKey: "k", model: "m", system: "s", question: "q", tools: [TOOL], timeoutMs: 1000, maxTokens: 10 },
      { fetch: f.fn, callTool: async () => ({ content: "", isError: false }), reserve: budget.reserve, settle: budget.settle }
    );
    expect(budget.log.reserved).toEqual([
      { provider: "openrouter", amount: 0.5, id: "r1" },
      { provider: "openrouter", amount: 0.5, id: "r2" },
    ]);
    // erste Antwort ohne usage.cost: die Reservierung zählt (nicht kostenlos freigegeben)
    expect(budget.log.settled).toEqual([{ id: "r1", cost: undefined }, { id: "r2", cost: 0.02 }]);
  });

  test("Neuversuch ohne Werkzeuge hat eine eigene Reservierung, ein HTTP-Fehler gibt seine nicht frei", async () => {
    const budget = fakeBudget();
    const f = scriptedFetch({ m: [httpError(400), textReply("ok", 0.01)] });
    await runToolLoop(
      { url: K3_URL, apiKey: "k", model: "m", system: "s", question: "q", tools: [TOOL], timeoutMs: 1000, maxTokens: 10 },
      { fetch: f.fn, callTool: async () => ({ content: "", isError: false }), reserve: budget.reserve, settle: budget.settle }
    );
    expect(budget.log.reserved).toHaveLength(2);
    expect(budget.log.settled).toEqual([{ id: "r1", cost: undefined }, { id: "r2", cost: 0.01 }]);
  });

  test("Ollama ohne Schlüssel: keine Reservierung", async () => {
    process.env.FALLBACK_OFFLINE_ONLY = "true";
    const budget = fakeBudget();
    const f = scriptedFetch({ "qwen3:8b": [textReply("lokal", 0)] });
    await runFallbackChain(REQ, deps({ fetch: f.fn, budget }));
    expect(budget.log.reserved).toHaveLength(0);
    expect(budget.log.settled).toHaveLength(0);
  });

  test("Kette mit Schlüssel: K3 und OpenRouter reservieren, Ollama nicht", async () => {
    process.env.OPENROUTER_API_KEY = "test-schluessel-nicht-echt";
    const budget = fakeBudget();
    await runFallbackChain(REQ, deps({ budget }));
    expect(budget.log.reserved.map((r) => r.provider)).toEqual(["openrouter", "openrouter"]);
    expect(budget.log.settled.map((s) => s.id)).toEqual(["r1", "r2"]);
  });
});

describe("Abbruch (/stop)", () => {
  let n = 0;
  const key = () => `fallback-abbruch-${++n}`;

  async function expectAbort(p: Promise<unknown>) {
    let error: unknown;
    try {
      await p;
    } catch (e) {
      error = e;
    }
    expect(isAbortError(error)).toBe(true);
  }

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-schluessel-nicht-echt";
  });

  test("vor der Kette: kein fetch, kein CLI-Aufruf", async () => {
    const k = key();
    const f = scriptedFetch({});
    const c = fakeClaude([]);
    await expectAbort(
      runCancelable(k, async () => {
        abortExecutions(k);
        return runFallbackChain(REQ, deps({ fetch: f.fn, claude: c.fn }));
      })
    );
    expect(f.sent).toHaveLength(0);
    expect(c.calls).toHaveLength(0);
  });

  test("CLI meldet aborted: AbortError, keine weitere Stufe", async () => {
    process.env.FALLBACK_K3 = "false";
    const k = key();
    const f = scriptedFetch({});
    const c = fakeClaude([{ text: "", isError: true, aborted: true }]);
    await expectAbort(runCancelable(k, () => runFallbackChain(REQ, deps({ fetch: f.fn, claude: c.fn }))));
    expect(f.sent).toHaveLength(0);
    expect(c.calls).toHaveLength(1);
  });

  test("CLI meldet aborted auch ohne Ausführungskontext: AbortError", async () => {
    process.env.FALLBACK_K3 = "false";
    const f = scriptedFetch({});
    const c = fakeClaude([{ text: "", isError: true, aborted: true }]);
    await expectAbort(runFallbackChain(REQ, deps({ fetch: f.fn, claude: c.fn })));
    expect(f.sent).toHaveLength(0);
  });

  test("während eines fetch: AbortError, kein weiterer fetch, kein CLI-Aufruf", async () => {
    const k = key();
    const f = scriptedFetch({
      "moonshotai/kimi-k3": [
        () => {
          setTimeout(() => abortExecutions(k), 5);
          return new Promise<Response>(() => {});
        },
      ] as any,
    });
    const c = fakeClaude([]);
    await expectAbort(runCancelable(k, () => runFallbackChain(REQ, deps({ fetch: f.fn, claude: c.fn }))));
    expect(f.sent).toHaveLength(1);
    expect(c.calls).toHaveLength(0);
  });

  test("zwischen zwei Werkzeugaufrufen: kein zweites Werkzeug, kein weiterer fetch", async () => {
    const k = key();
    const f = scriptedFetch({
      "moonshotai/kimi-k3": [
        toolReply([
          { id: "c1", name: "suche", args: "{}" },
          { id: "c2", name: "suche", args: "{}" },
        ]),
      ],
    });
    const c = fakeClaude([]);
    const toolNames: string[] = [];
    const callTool = async (name: string) => {
      toolNames.push(name);
      abortExecutions(k);
      return { content: "eins", isError: false };
    };
    await expectAbort(runCancelable(k, () => runFallbackChain(REQ, deps({ fetch: f.fn, claude: c.fn, tools: [TOOL], callTool }))));
    expect(toolNames).toEqual(["suche"]);
    expect(f.sent).toHaveLength(1);
    expect(c.calls).toHaveLength(0);
  });

  test("HTTP-Stufe liefert trotz inzwischen gesetztem Abbruch noch Text: AbortError, kein weiterer Aufruf", async () => {
    const k = key();
    const f = scriptedFetch({
      "moonshotai/kimi-k3": [
        () => {
          abortExecutions(k);
          return textReply("zu spät");
        },
      ],
    });
    const c = fakeClaude([]);
    await expectAbort(runCancelable(k, () => runFallbackChain(REQ, deps({ fetch: f.fn, claude: c.fn }))));
    expect(f.sent).toHaveLength(1);
    expect(c.calls).toHaveLength(0);
  });

  test("CLI-Stufe liefert trotz inzwischen gesetztem Abbruch noch Text: AbortError, kein weiterer Aufruf", async () => {
    process.env.FALLBACK_K3 = "false";
    const k = key();
    const f = scriptedFetch({});
    const c = fakeClaude([
      async () => {
        abortExecutions(k);
        return { text: "zu spät", isError: false };
      },
    ]);
    await expectAbort(runCancelable(k, () => runFallbackChain(REQ, deps({ fetch: f.fn, claude: c.fn }))));
    expect(c.calls).toHaveLength(1);
    expect(f.sent).toHaveLength(0);
  });

  test("während der Ollama-Stufe: AbortError statt Text für source none", async () => {
    process.env.FALLBACK_OFFLINE_ONLY = "true";
    const k = key();
    const f = scriptedFetch({
      "qwen3:8b": [
        () => {
          setTimeout(() => abortExecutions(k), 5);
          return new Promise<Response>(() => {});
        },
      ] as any,
    });
    await expectAbort(runCancelable(k, () => runFallbackChain(REQ, deps({ fetch: f.fn }))));
    expect(f.sent).toHaveLength(1);
  });
});

describe("Antworttext", () => {
  test("Herkunftszusatz auf Deutsch", () => {
    expect(fallbackReplyText({ text: "Hallo", source: "openrouter", model: "m" })).toBe("Hallo\n\n_(Antwort über openrouter)_");
    expect(fallbackReplyText({ text: "Hallo", source: "kimi-k3", model: "m" })).toBe("Hallo\n\n_(Antwort über kimi-k3)_");
  });
});
