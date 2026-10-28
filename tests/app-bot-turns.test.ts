// Issue #344: Modellaufrufe des Bots als Verhalten (ersetzt callClaude und
// callClaudeWithProgress in bot.ts): Session-Schlüssel, Werkzeuge des
// Agenten, Abbruch als ABORT_REPLY, Session-ID an Turn und globalen Stand,
// Hinweise vom Bot des Agenten.
import { describe, expect, test } from "bun:test";
import { createBotTurns, goalAgentCall, type BotTurnsDeps } from "../src/app/bot-turns";
import { turnInfoCollector } from "../src/lib/turn-collector";
import { ABORT_REPLY, type TurnOptions, type TurnSink } from "../src/lib/chat-turn";
import { sessionKeyFor } from "../src/lib/store/message-rules";

class Aborted extends Error {}

function setup(overrides: Partial<BotTurnsDeps<string>> = {}) {
  const calls: { kind: string; options: TurnOptions }[] = [];
  const executions: { key: string; agent: string; tools?: string[] }[] = [];
  const remembered: string[] = [];
  const sent: string[] = [];
  const deps: BotTurnsDeps<string> = {
    runJson: async options => (calls.push({ kind: "json", options }), "json-antwort"),
    runStreaming: async options => (calls.push({ kind: "stream", options }), "stream-antwort"),
    runExecution: async (key, agent, run, tools) => (executions.push({ key, agent, tools }), run()),
    isAbort: e => e instanceof Aborted,
    allowedTools: agent => (agent === "research" ? ["WebSearch"] : undefined),
    rememberSession: async (id, engine) => void remembered.push(`${id}/${engine}`),
    sendAsAgent: async (agent, chatId, text, options) => void sent.push(`${agent}:${chatId}:${options.threadId}:${text}`),
    progressSink: (ctx, notice): TurnSink => ({ progress: () => {}, notice: text => notice(`${ctx}:${text}`).then(() => {}) }),
    ...overrides,
  };
  return { turns: createBotTurns(deps), calls, executions, remembered, sent };
}

describe("createBotTurns", () => {
  test("ask: JSON-Turn unter dem Schlüssel des Gesprächs, Standard-Agent general", async () => {
    const s = setup();
    expect(await s.turns.ask("frage", "-100", undefined, 5)).toBe("json-antwort");
    expect(s.executions).toEqual([{ key: sessionKeyFor("-100", 5), agent: "general", tools: undefined }]);
    expect(s.calls[0].kind).toBe("json");
    expect(s.calls[0].options).toMatchObject({ userMessage: "frage", chatId: "-100", agentName: "general", topicId: 5 });
    expect("turnHint" in s.calls[0].options).toBe(false);
  });

  test("Hinweise langer Läufe kommen vom Bot des Agenten im Topic", async () => {
    const s = setup();
    await s.turns.ask("frage", "-100", "research", 5);
    await s.calls[0].options.sink.notice("dauert");
    expect(s.sent).toEqual(["research:-100:5:dauert"]);
    expect(s.executions[0].tools).toEqual(["WebSearch"]);
  });

  test("askWithProgress: Streaming mit Fortschritt im Gespräch, Hinweis und Rückfrage durchgereicht", async () => {
    const s = setup();
    const questions: unknown[] = [];
    expect(await s.turns.askWithProgress("ctx", "hallo", "1", "general", undefined, { turnHint: "faden", onQuestion: q => questions.push(q) })).toBe("stream-antwort");
    const options = s.calls[0].options;
    expect(s.calls[0].kind).toBe("stream");
    expect(options.turnHint).toBe("faden");
    expect(options.onQuestion).toBeFunction();
    await options.sink.notice("lang");
    expect(s.sent).toEqual(["general:1:undefined:ctx:lang"]);
    expect(s.executions[0].key).toBe(sessionKeyFor("1", null));
  });

  test("onInfo und onTools auf beiden Wegen durchgereicht", async () => {
    const s = setup();
    const onInfo = () => {};
    const onTools = () => {};
    await s.turns.ask("x", "1", "general", undefined, { onInfo, onTools });
    await s.turns.askWithProgress("ctx", "x", "1", "general", undefined, { onInfo, onTools });
    for (const call of s.calls) {
      expect(call.options.onInfo).toBe(onInfo);
      expect(call.options.onTools).toBe(onTools);
    }
  });

  test("Ziel-Turn: Werkzeuge des Turns ans Tor, Abbruch als leerer Text", async () => {
    const tools = { names: ["WebFetch"] } as never;
    let seen: TurnOptions | undefined;
    const s = setup({ runJson: async options => ((seen = options), options.onTools?.(tools), "fertig") });
    const call = goalAgentCall(s.turns, turnInfoCollector);
    expect(await call("weiter", { chatId: "1", agentName: "research", topicId: 4 })).toEqual({ text: "fertig", aborted: false, tools });
    // Chat, Agent und Topic kommen aus dem Ziel
    expect(seen).toMatchObject({ userMessage: "weiter", chatId: "1", agentName: "research", topicId: 4 });
    const aborted = goalAgentCall(setup({ runExecution: async () => { throw new Aborted(); } }).turns, turnInfoCollector);
    expect(await aborted("weiter", { chatId: "1", agentName: "research" })).toEqual({ text: "", aborted: true, tools: undefined });
  });

  test("Session-ID geht an den Turn und an den globalen Stand", async () => {
    const s = setup();
    const seen: string[] = [];
    await s.turns.ask("x", "1", "general", undefined, { onSessionId: id => seen.push(id) });
    await s.calls[0].options.onSessionId!("sess-1", { engine: "codex", model: "" } as never);
    expect(seen).toEqual(["sess-1"]);
    expect(s.remembered).toEqual(["sess-1/codex"]);
    await s.turns.trackSession()("sess-2", { engine: "claude", model: "m" } as never);
    expect(s.remembered).toEqual(["sess-1/codex", "sess-2/claude"]);
  });

  test("Abbruch ergibt ABORT_REPLY, andere Fehler gehen weiter", async () => {
    const aborted = setup({ runExecution: async () => { throw new Aborted(); } });
    expect(await aborted.turns.ask("x", "1")).toBe(ABORT_REPLY);
    expect(await aborted.turns.askWithProgress("ctx", "x", "1", "general")).toBe(ABORT_REPLY);
    const broken = setup({ runExecution: async () => { throw new Error("kaputt"); } });
    await expect(broken.turns.ask("x", "1")).rejects.toThrow("kaputt");
  });

  test("Fortschritt entsteht erst im Bereich der Ausführung", async () => {
    const order: string[] = [];
    const s = setup({
      runExecution: async (_k, _a, run) => (order.push("execution"), run()),
      progressSink: () => (order.push("sink"), { progress: () => {}, notice: async () => {} }),
    });
    await s.turns.askWithProgress("ctx", "x", "1", "general");
    expect(order).toEqual(["execution", "sink"]);
  });
});
