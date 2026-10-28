/**
 * Bestätigter Auftrag aus einem Anruf als vollständiger Chat-Turn ohne
 * Telegram-Context (Issue #366, src/lib/phone/task-turn.ts): Antwort im
 * Verlauf (WebUI), Merk-Tags, /goal, Agenten-Aufrufe, Rückfrage mit Knöpfen,
 * Abbruch und Fehler. Motor, Speicher, Aufträge und Agenten-Bots sind ersetzt.
 * Der Turn läuft über den Streaming-Turn des Chat-Kerns: mit Motor-Attrappe
 * belegt, dass Leerlauf- und Obergrenze (TYBO_CLAUDE_IDLE_MIN/MAX_MIN) beim
 * Motor ankommen und die Statusnachricht ohne Telegram-Context im Topic
 * erscheint und wieder verschwindet.
 */

import { describe, expect, test } from "bun:test";
import { ABORT_REPLY, runStreamingTurn, type ChatTurnDeps, type TurnOptions } from "../src/lib/chat-turn";
import type { Engine, EngineRequest } from "../src/lib/engines";
import { PROGRESS_HEADER, type ProgressMessages } from "../src/lib/telegram-progress";
import { isolateShellEnv } from "./shell-env";
import { phoneDelivery } from "../src/lib/phone";
import { CALL_TASK_AGENT, CALL_TASK_TEXT, createCallTaskTurn, type CallTaskTurnDeps } from "../src/lib/phone/task-turn";
import type { ChoiceConversation } from "../src/lib/choices";

const TOPIC: ChoiceConversation = { type: "telegram", chatId: "4711", topicId: 42 };

interface Run {
  turn: (chatId: string, task: string, topicId?: number) => Promise<void>;
  claude: { prompt: string; chatId: string; agent: string; topicId?: number; streaming: boolean }[];
  saved: any[];
  intents: { response: string; tools: unknown; target: unknown }[];
  goals: unknown[][];
  sent: { agent: string; chatId: string | number; text: string; threadId?: number; keyboard?: any }[];
  tasks: { created: unknown[][]; updated: { id: string; changes: any }[] };
  notices: { chatId: string; text: string; topicId?: number }[];
  after: unknown[][];
}

function run(
  replies: Record<string, string | Error>,
  opts: { createdTask?: { id: string } | null; streamingTurn?: (opts: TurnOptions) => Promise<string>; progress?: ProgressMessages } = {},
): Run {
  const r = { claude: [], saved: [], intents: [], goals: [], sent: [], tasks: { created: [], updated: [] }, notices: [], after: [] } as unknown as Run;
  const deps: CallTaskTurnDeps = {
    runStreamingTurn:
      opts.streamingTurn ??
      (async turn => {
        r.claude.push({ prompt: turn.userMessage, chatId: turn.chatId, agent: turn.agentName, topicId: turn.topicId, streaming: true });
        const reply = replies[turn.agentName] ?? "";
        if (reply instanceof Error) throw reply;
        turn.onInfo?.({ model: "claude-test", engine: "claude", durationMs: 5 } as any);
        turn.onTools?.(["WebSearch"] as any);
        await turn.onSessionId?.("sess-1", { engine: "claude", model: "claude-test" } as any);
        return reply;
      }),
    ...(opts.progress ? { progressMessages: () => opts.progress } : {}),
    callClaude: async (prompt, chatId, agent, topicId) => {
      r.claude.push({ prompt, chatId, agent, topicId, streaming: false });
      const reply = replies[agent] ?? "";
      if (reply instanceof Error) throw reply;
      return reply;
    },
    saveMessage: async message => {
      r.saved.push(message);
      return true;
    },
    processIntents: async (response, tools, target) => {
      r.intents.push({ response, tools, target });
    },
    onAgentTurn: (...args) => {
      r.goals.push(args);
    },
    registry: {
      sendAsAgent: async (agent, chatId, text, options) => {
        r.sent.push({ agent, chatId, text, threadId: options?.threadId });
      },
      sendWithKeyboardAsAgent: async (agent, chatId, text, keyboard, options) => {
        r.sent.push({ agent, chatId, text, threadId: options?.threadId, keyboard });
      },
      sendTypingAsAgent: async () => {},
    },
    createTask: async (...args) => {
      r.tasks.created.push(args);
      return opts.createdTask === undefined ? { id: "task-1" } : opts.createdTask;
    },
    updateTask: async (id, changes) => {
      r.tasks.updated.push({ id, changes });
      return true;
    },
    notice: async (chatId, text, topicId) => {
      r.notices.push({ chatId, text, topicId });
    },
    isShuttingDown: () => false,
    invokeBudget: 3,
    afterTurn: (...args) => {
      r.after.push(args);
    },
    log: () => {},
  };
  r.turn = createCallTaskTurn(deps);
  return r;
}

describe("Auftrag aus einem Anruf als Chat-Turn", () => {
  test("Antwort im Verlauf, Merk-Tags, /goal, vom Bot des Agenten ins Topic", async () => {
    const r = run({ general: "Folien sind vorbereitet. [REMEMBER: Folien für Freitag]" });
    await r.turn("4711", "Folien für Freitag vorbereiten", 42);

    expect(r.claude).toEqual([{ prompt: "Folien für Freitag vorbereiten", chatId: "4711", agent: CALL_TASK_AGENT, topicId: 42, streaming: true }]);
    expect(r.saved).toEqual([
      {
        chat_id: "4711",
        role: "assistant",
        content: "Folien sind vorbereitet. [REMEMBER: Folien für Freitag]",
        metadata: { agent: "general", topicId: 42, model: "claude-test", engine: "claude", durationMs: 5 },
      },
    ]);
    expect(r.intents).toEqual([{ response: "Folien sind vorbereitet. [REMEMBER: Folien für Freitag]", tools: ["WebSearch"], target: { chatId: "4711", topicId: 42, origin: "Anruf" } }]);
    expect(r.goals).toEqual([["topic:4711:42", "general", "Folien sind vorbereitet. [REMEMBER: Folien für Freitag]"]]);
    expect(r.sent).toEqual([{ agent: "general", chatId: "4711", text: "Folien sind vorbereitet. [REMEMBER: Folien für Freitag]", threadId: 42 }]);
    expect(r.notices).toEqual([]);
    expect(r.after).toEqual([["4711", 42]]);
  });

  test("Agenten-Aufruf: Text ohne Tag, Antwort des gefragten Agenten gesendet und gespeichert", async () => {
    const r = run({ general: "Ich frage nach. [INVOKE:research|Welche Folien gibt es?]", research: "Drei Folien." });
    await r.turn("4711", "Folien prüfen", 42);

    expect(r.claude.map(c => [c.agent, c.streaming])).toEqual([["general", true], ["research", false]]);
    expect(r.claude[1]).toMatchObject({ chatId: "4711", topicId: 42 });
    expect(r.sent).toEqual([
      { agent: "general", chatId: "4711", text: "Ich frage nach.", threadId: 42 },
      { agent: "research", chatId: "4711", text: "Drei Folien.", threadId: 42 },
    ]);
    expect(r.saved.map(m => [m.content, m.metadata.agent, m.metadata.invokedBy])).toEqual([
      ["Ich frage nach. [INVOKE:research|Welche Folien gibt es?]", "general", undefined],
      ["Drei Folien.", "research", "general"],
    ]);
  });

  test("Rückfrage mit Optionen: Auftrag needs_input mit Session, Antwort mit Knöpfen", async () => {
    const reply = "Zwei Wege:\n1. Kurz\n2. Ausführlich\nWhich option?";
    const r = run({ general: reply });
    await r.turn("4711", "Folien vorbereiten", 42);

    expect(r.tasks.created).toEqual([["4711", "Folien vorbereiten", 42]]);
    expect(r.tasks.updated).toHaveLength(1);
    expect(r.tasks.updated[0].id).toBe("task-1");
    expect(r.tasks.updated[0].changes).toMatchObject({
      status: "needs_input",
      session_id: "sess-1",
      pending_question: "Which option?",
      pending_options: [{ label: "1. Kurz", value: "1" }, { label: "2. Ausführlich", value: "2" }],
      metadata: { agent_name: "general", engine: "claude", model: "claude-test" },
    });
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatchObject({ agent: "general", chatId: "4711", text: reply, threadId: 42 });
    const buttons = JSON.stringify(r.sent[0].keyboard);
    expect(buttons).toContain("atask:task-1:1");
    expect(buttons).toContain("atask:task-1:cancel");
    expect(r.saved).toHaveLength(1);
  });

  test("Rückfrage ohne gespeicherten Auftrag: Antwort ohne Knöpfe", async () => {
    const r = run({ general: "1. Kurz\n2. Lang\nWhich option?" }, { createdTask: null });
    await r.turn("4711", "Folien", 42);
    expect(r.tasks.updated).toEqual([]);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0].keyboard).toBeUndefined();
  });

  test("Abbruch: Meldung im Gespräch, nichts gespeichert, keine Merk-Tags", async () => {
    const r = run({ general: ABORT_REPLY });
    await r.turn("4711", "Folien", 42);
    expect(r.notices).toEqual([{ chatId: "4711", text: ABORT_REPLY, topicId: 42 }]);
    expect(r.saved).toEqual([]);
    expect(r.intents).toEqual([]);
    expect(r.sent).toEqual([]);
    expect(r.after).toEqual([["4711", 42]]);
  });

  test("Motorfehler: eigene Meldung, nichts gesendet, Neustart-Prüfung läuft", async () => {
    const r = run({ general: new Error("kaputt") });
    await r.turn("4711", "Folien");
    expect(r.notices).toEqual([{ chatId: "4711", text: CALL_TASK_TEXT.failed, topicId: undefined }]);
    expect(r.saved).toEqual([]);
    expect(r.after).toEqual([["4711", undefined]]);
  });

  test("über die Wege des Bots: Auftrag im Chat samt Topic landet im Verlauf", async () => {
    const r = run({ general: "Erledigt." });
    const d = phoneDelivery({ send: async () => ({ sent: true, recorded: true }), sendChoice: async () => ({ sent: true }), runTask: r.turn }, () => {});
    await d.runTask(TOPIC, "Folien");
    expect(r.saved.map(m => [m.chat_id, m.content, m.metadata.topicId])).toEqual([["4711", "Erledigt.", 42]]);
    expect(r.sent.map(s => s.threadId)).toEqual([42]);
  });
});

// ---------------------------------------------------------------------------
// Streaming-Turn mit Motor-Attrappe
// ---------------------------------------------------------------------------

describe("Auftrag aus einem Anruf über den Streaming-Turn", () => {
  isolateShellEnv({ TYBO_CLAUDE_IDLE_MIN: undefined, TYBO_CLAUDE_MAX_MIN: undefined });

  /** Chat-Kern mit Motor-Attrappe; die Grenzen kommen aus der echten Umgebung (resolveStreamingLimits) */
  function engineTurn(onRun: (req: EngineRequest) => Promise<void> = async () => {}) {
    const requests: EngineRequest[] = [];
    const engine: Engine = {
      id: "claude",
      describe: () => "Attrappe",
      async run(req) {
        requests.push(req);
        await onRun(req);
        return { engine: "claude", text: "Folien sind fertig.", sessionId: "sess-9", isError: false };
      },
    };
    const deps: Partial<ChatTurnDeps> = {
      getEngine: () => engine,
      resolveEngine: async () => ({ engine: "claude" }) as any,
      forgetEngineCheck: () => {},
      runFallbackChain: async () => ({ text: "ersatz", source: "openrouter", model: "ersatz" }) as any,
      buildPromptContext: async () => ({ fullPrompt: "voller-prompt", fallbackContext: "kontext" }) as any,
      buildResumePrompt: async () => "resume-prompt",
      isSessionModeEnabled: () => false,
      getResumableSession: () => null as any,
      takeExpiredSession: () => null as any,
      recordSessionTurn: (async () => {}) as any,
      getSessionsForKey: () => [] as any,
      sessionEpoch: () => 0,
      resetSession: (async () => {}) as any,
      shouldDistill: () => false,
      distillSession: async () => {},
      log: async () => {},
      getAgentConfig: () => ({ model: "claude-agent", allowedTools: ["WebSearch"] }) as any,
      getSettings: () => ({}) as any,
      reportSecrets: () => [],
      setTimer: () => 0,
      clearTimer: () => {},
      now: () => 0,
      takeCallRecap: () => undefined,
    };
    return { requests, streamingTurn: (opts: TurnOptions) => runStreamingTurn({ ...opts, deps }) };
  }

  /** Statusnachricht ohne Telegram-Context: Senden, Bearbeiten, Löschen */
  function progressLog() {
    const log: { op: string; id?: number; text?: string }[] = [];
    let edited!: () => void;
    const firstEdit = new Promise<void>(resolve => (edited = resolve));
    const messages: ProgressMessages = {
      send: async text => {
        log.push({ op: "send", text });
        return { message_id: 77 };
      },
      edit: async (id, text) => {
        log.push({ op: "edit", id, text });
        edited();
      },
      remove: async id => {
        log.push({ op: "remove", id });
      },
    };
    return { log, messages, firstEdit };
  }

  test("Standard: Streaming mit 15 Minuten Leerlauf und 90 Minuten Obergrenze, Statusnachricht kommt und geht", async () => {
    const progress = progressLog();
    const t = engineTurn();
    const r = run({}, { streamingTurn: t.streamingTurn, progress: progress.messages });
    await r.turn("4711", "Folien vorbereiten", 42);

    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]).toMatchObject({ streaming: true, idleTimeoutMs: 15 * 60_000, timeoutMs: 90 * 60_000, allowedTools: ["WebSearch"] });
    expect(progress.log).toEqual([
      { op: "send", text: PROGRESS_HEADER },
      { op: "remove", id: 77 },
    ]);
    expect(r.sent).toEqual([{ agent: "general", chatId: "4711", text: "Folien sind fertig.", threadId: 42 }]);
    expect(r.saved.map(m => m.content)).toEqual(["Folien sind fertig."]);
    expect(r.tasks.updated).toEqual([]);
  });

  test("eigene Grenzen aus TYBO_CLAUDE_IDLE_MIN und TYBO_CLAUDE_MAX_MIN, Werkzeug als Fortschrittszeile im Topic", async () => {
    process.env.TYBO_CLAUDE_IDLE_MIN = "40";
    process.env.TYBO_CLAUDE_MAX_MIN = "240";
    const progress = progressLog();
    const t = engineTurn(async req => {
      req.onToolStart?.("WebSearch");
      // Die Bearbeitung kommt gedrosselt (PROGRESS_EDIT_INTERVAL_MS) nach dem Senden
      await progress.firstEdit;
    });
    const r = run({}, { streamingTurn: t.streamingTurn, progress: progress.messages });
    await r.turn("4711", "Folien vorbereiten", 42);

    expect(t.requests[0]).toMatchObject({ streaming: true, idleTimeoutMs: 40 * 60_000, timeoutMs: 240 * 60_000 });
    expect(progress.log.map(e => e.op)).toEqual(["send", "edit", "remove"]);
    expect(progress.log[1]).toEqual({ op: "edit", id: 77, text: `${PROGRESS_HEADER}\n→ WebSearch` });
    expect(r.sent.map(s => s.text)).toEqual(["Folien sind fertig."]);
  });

  test("ohne Telegram (keine Statusnachricht): Turn läuft trotzdem über den Streaming-Weg", async () => {
    const t = engineTurn();
    const r = run({}, { streamingTurn: t.streamingTurn });
    await r.turn("4711", "Folien vorbereiten");
    expect(t.requests[0]).toMatchObject({ streaming: true, idleTimeoutMs: 15 * 60_000, timeoutMs: 90 * 60_000 });
    expect(r.sent.map(s => [s.text, s.threadId])).toEqual([["Folien sind fertig.", undefined]]);
  });

  test("Statusnachricht im Topic über die Bot-API, ohne Context", async () => {
    const { chatProgressMessages } = await import("../src/lib/telegram-progress");
    const calls: unknown[][] = [];
    const api = {
      sendMessage: async (...args: unknown[]) => {
        calls.push(["send", ...args]);
        return { message_id: 5 };
      },
      editMessageText: async (...args: unknown[]) => {
        calls.push(["edit", ...args]);
        return true;
      },
      deleteMessage: async (...args: unknown[]) => {
        calls.push(["delete", ...args]);
        return true;
      },
    };
    const messages = chatProgressMessages(api as any, "4711", 42);
    const options = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };
    await messages.send("a", options as any);
    await messages.edit(5, "b", options as any);
    await messages.remove(5);
    expect(calls).toEqual([
      ["send", "4711", "a", { ...options, message_thread_id: 42 }],
      ["edit", "4711", 5, "b", options],
      ["delete", "4711", 5],
    ]);
  });
});
