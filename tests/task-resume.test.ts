import { test, expect, describe } from "bun:test";
import { resumeMacTask, type TaskResumeDeps, taskResumePrompt, taskResumeRecord, taskTarget, taskHandoverPrompt } from "../src/lib/task-resume";
import { runExecution, abortExecutions } from "../src/lib/execution-context";
import { sessionKeyFor } from "../src/lib/store/message-rules";
import type { ClaudeOptions, ClaudeResult } from "../src/lib/claude";
import type { BotSession } from "../src/lib/session-manager";
import { createClaudeEngine } from "../src/lib/engines";
import { processTurnIntents } from "../src/lib/intent-gate";
import { currentExecution } from "../src/lib/execution-context";
import { ABORT_REPLY, type TurnOptions } from "../src/lib/chat-turn";

const handover = { originalPrompt: "Notiz anlegen", question: "Wie lang?", options: ["Kurz", "Ausführlich"] };

describe("Übergabe einer Knopf-Antwort (Issue #659)", () => {
  test("feste Nachricht mit Auftrag, Frage, Beschriftungen und unveränderter Antwort", () => {
    expect(taskHandoverPrompt(handover, "Ausführlich")).toBe([
      "Der Nutzer hat eine Rückfrage aus diesem Gespräch per Knopf beantwortet.",
      "Ursprünglicher Auftrag: Notiz anlegen", "Rückfrage: Wie lang?",
      "Zur Auswahl standen: Kurz | Ausführlich", "Antwort des Nutzers: Ausführlich",
      "Setze den Auftrag mit dieser Antwort fort.",
    ].join("\n"));
    const prompt = taskHandoverPrompt({ ...handover, originalPrompt: "x".repeat(2_001), options: [] }, " Ja\nBitte ");
    expect(prompt).toContain(`Ursprünglicher Auftrag: ${"x".repeat(2_000)}\n`);
    expect(prompt).not.toContain("Zur Auswahl standen:");
    expect(prompt).toContain("Antwort des Nutzers:  Ja\nBitte \n");
  });

  for (const errorKind of ["usage_limit", "capacity", "other"] as const) {
    test(`${errorKind}: erst Lauf auswerten, dann genau einmal in derselben Sperre übergeben`, async () => {
      const s = setup({ result: () => ({ text: "Fehler", isError: true, errorKind }) });
      const transfers: TurnOptions[] = [];
      const notes: unknown[][] = [];
      Object.assign(s.deps, {
        getSettings: () => ({ engine: { backups: [{ engine: "codex" }] } }),
        readSwitchState: () => ({ version: 1, blocks: [], counters: [] }),
        checkEngine: async () => ({ installed: true, loggedIn: false, loginUnknown: true }),
        noteStageRun: async (...args: unknown[]) => { notes.push(args); },
        handoverTurn: async (opts: TurnOptions) => {
          expect(notes).toHaveLength(1);
          expect(currentExecution()).toMatchObject({ key: `topic:${CHAT}:49`, agent: "research", sessionLock: true });
          transfers.push(opts);
          opts.onInfo?.({ agent: "research", engine: "codex", model: "codex-test", durationMs: 1 });
          opts.onSessionId?.("codex-neu", { engine: "codex", model: "codex-test" });
          return "Notiz fertig";
        },
      });
      const outcome = await resumeMacTask({ chat_id: CHAT, thread_id: 49, session_id: "claude-alt", metadata: { agent_name: "research" } },
        CHAT, "Kurz", s.deps, "web", handover);
      expect(s.calls).toHaveLength(1);
      expect(s.calls[0].resumeSessionId).toBe("claude-alt");
      expect(transfers).toHaveLength(1);
      expect(transfers[0]).toMatchObject({ userMessage: taskHandoverPrompt(handover, "Kurz"), chatId: CHAT, topicId: 49, agentName: "research", channel: "web" });
      expect(notes[0][6]).toEqual({ abandoned: errorKind !== "other" });
      expect(outcome).toMatchObject({ status: "done", engine: "codex", resumeId: "codex-neu", result: { text: "Notiz fertig", sessionId: "codex-neu" } });
    });
  }

  for (const kind of ["engine", "fallback", "none", "timeout", "abort"] as const) {
    test(`Übergabe meldet ${kind} mit sicheren Session-Angaben`, async () => {
      const s = setup({});
      Object.assign(s.deps, {
        getSettings: () => ({ engine: { backups: [{ engine: "codex" }] } }),
        readSwitchState: () => ({ version: 1, blocks: [], counters: [] }),
        checkEngine: async () => ({ installed: false, loggedIn: false }),
        handoverTurn: async (opts: TurnOptions) => {
          expect(opts.longRunNotices).toBe(false);
          opts.sink.notice("Codex übernimmt.");
          opts.onSessionId?.("codex-id", { engine: "codex", model: "" });
          opts.onTools?.({ uses: [{ name: "Write" }] });
          opts.onQuestion?.({ question: "Noch eine Notiz?", options: ["Ja", "Nein"], via: "tag", offer: async () => { throw new Error("Nicht anbieten"); } });
          opts.onInfo?.({ agent: "general", durationMs: 1, ...(kind === "engine" ? { engine: "codex" }
            : kind === "fallback" ? { model: "ersatz" } : kind === "timeout" ? { timedOut: true } : {}) });
          return kind === "abort" ? ABORT_REPLY : "Antwort";
        },
      });
      const result = await resumeMacTask({ session_id: "claude-alt" }, CHAT, "Kurz", s.deps, "web", handover);
      if (kind === "abort") { expect(result).toEqual({ status: "aborted" }); return; }
      expect(result).toMatchObject({ status: "done", via: "handover", notices: ["Codex übernimmt."] });
      if (result.status !== "done") throw new Error("Übergabe erwartet");
      expect(result.result.tools).toEqual({ uses: [{ name: "Write" }] });
      if (kind === "engine") {
        expect(result).toMatchObject({ engine: "codex", model: "", resumeId: "codex-id", followUp: { question: "Noch eine Notiz?", options: ["Ja", "Nein"] } });
      } else {
        expect(result.engine).toBeUndefined();
        expect(result.resumeId).toBe("");
        expect(result.result.sessionId).toBeUndefined();
        expect("followUp" in result).toBe(false);
        expect(result.result.isError).toBe(kind !== "fallback");
        expect(!!result.result.timedOut).toBe(kind === "timeout");
      }
    });
  }
});

// Issue #189: Knopf-Antworten laufen über runExecution (echte Sperre), mit
// dem Modell, Effort und den Werkzeugen des Agenten; die Session wird erst in
// der Sperre gewählt. Claude und der Session-Speicher sind Fakes.

const CHAT = "-100555";
let nextTopic = 100;

function setup(opts: {
  sessionMode?: boolean;
  /** Gespeicherte Topic-Sessions: "<sessionKey>:<agent>" -> Session-ID (Modell MODEL) */
  store?: Map<string, string>;
  model?: string;
  result?: (o: ClaudeOptions) => Promise<ClaudeResult> | ClaudeResult;
}) {
  const model = opts.model ?? "claude-sonnet-test";
  const store = opts.store ?? new Map<string, string>();
  const events: string[] = [];
  const calls: ClaudeOptions[] = [];
  const lookups: [string, string, string][] = [];
  const finalized: unknown[][] = [];
  const deps: Partial<TaskResumeDeps> = {
    runExecution,
    isSessionModeEnabled: () => opts.sessionMode ?? true,
    getResumableSession: async (key, agent, m, engine) => {
      lookups.push([key, agent, m]);
      const id = store.get(`${key}:${agent}`);
      return id && m === model && engine === "claude"
        ? ({ key, agentName: agent, engine: "claude", engineSessionId: id, model: m, startedAt: 1, lastActivity: 1, messageCount: 1 } as BotSession)
        : undefined;
    },
    sessionEpoch: () => 7,
    finalizeClaudeSession: async (...args) => {
      finalized.push(args);
      return true;
    },
    // Echter Claude-Motor mit gefälschtem Prozess: die Optionen bleiben wie vor Issue #122
    getEngine: () => {
      const call = async (o: ClaudeOptions) => {
        calls.push(o);
        events.push(`resume:${o.resumeSessionId}`);
        return opts.result ? opts.result(o) : { text: "weiter", sessionId: o.resumeSessionId };
      };
      return createClaudeEngine({ callClaude: call, callClaudeStreaming: call });
    },
    resolveModel: () => model,
    resolveEffort: () => "high",
    allowedTools: (agent) => (agent === "research" ? ["WebSearch", "Read"] : undefined),
    cwd: "/tmp/projekt",
  };
  return { deps, store, events, calls, lookups, finalized, model };
}

function topic() {
  const topicId = nextTopic++;
  return { topicId, key: sessionKeyFor(CHAT, topicId) };
}

test("Knopf-Fortsetzung fordert nach Claude ebenfalls eine Messung an, nach Abbruch nicht", async () => {
  for (const aborted of [false, true]) {
    const s = setup({ result: () => ({ text: "Antwort", isError: false, aborted }) }); let requested = 0;
    s.deps.scheduleClaudeUsageAfterChat = () => { requested++; expect(s.calls).toHaveLength(1); };
    await resumeMacTask({ session_id: "fortsetzen" }, CHAT, "Ja", s.deps);
    expect(requested).toBe(aborted ? 0 : 1);
  }
});

describe("Knopf-Antwort über runExecution", () => {
  test("zwei gleichzeitige Turns im selben Topic: Knopf-Antwort wartet und nimmt die neue Session", async () => {
    const { topicId, key } = topic();
    const s = setup({});
    s.store.set(`${key}:research`, "S1");

    // Normaler Turn hält die Sperre und schreibt beim Ende die Nachfolgesession
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const normal = runExecution(key, "research", async () => {
      s.events.push("normal:start");
      await gate;
      s.store.set(`${key}:research`, "S2");
      s.events.push("normal:end");
    });

    const task = { chat_id: CHAT, thread_id: topicId, metadata: { agent_name: "research" } };
    const resume = resumeMacTask(task, CHAT, "Ja", s.deps);
    await Bun.sleep(20);
    // Kein zweites --resume, solange der normale Turn läuft
    expect(s.calls).toHaveLength(0);
    expect(s.lookups).toHaveLength(0);

    release();
    await normal;
    const outcome = await resume;
    expect(s.events).toEqual(["normal:start", "normal:end", "resume:S2"]);
    expect(outcome).toMatchObject({ status: "done", resumeId: "S2", agent: "research" });
  });

  test("Aufrufoptionen wie ein normaler Turn: Modell, Effort, Werkzeuge, /stop-Schlüssel", async () => {
    const { topicId, key } = topic();
    const s = setup({ model: "claude-sonnet-5" });
    s.store.set(`${key}:research`, "S-topic");
    const outcome = await resumeMacTask(
      { chat_id: CHAT, thread_id: topicId, metadata: { agent_name: "research" } },
      CHAT,
      "Option B",
      s.deps
    );
    expect(outcome.status).toBe("done");
    expect(s.lookups).toEqual([[key, "research", "claude-sonnet-5"]]);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toEqual({
      prompt: taskResumePrompt("Option B"),
      outputFormat: "json",
      resumeSessionId: "S-topic",
      timeoutMs: 1_800_000,
      cwd: "/tmp/projekt",
      model: "claude-sonnet-5",
      effort: "high",
      allowedTools: ["WebSearch", "Read"],
      abortKey: key,
    });
    // Topic-Session fortgesetzt: zählt als Turn, mit Modell und Epoche von vor dem Aufruf
    expect(s.finalized).toHaveLength(1);
    expect(s.finalized[0]![0]).toBe(key);
    expect(s.finalized[0]![1]).toBe("research");
    expect(s.finalized[0]![4]).toBe("claude-sonnet-5");
    expect(s.finalized[0]![6]).toBe(7);
  });

  test("/stop während die Knopf-Antwort wartet: kein Aufruf, Ergebnis abgebrochen", async () => {
    const { topicId, key } = topic();
    const s = setup({});
    s.store.set(`${key}:general`, "S1");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const normal = runExecution(key, "general", () => gate).catch((e) => e);

    const resume = resumeMacTask({ chat_id: CHAT, thread_id: topicId }, CHAT, "Ja", s.deps);
    await Bun.sleep(20);
    abortExecutions(key); // wie /stop (abortEngineCalls)
    expect(await resume).toEqual({ status: "aborted" });
    release();
    await normal;
    expect(s.calls).toHaveLength(0);
  });

  test("vom Nutzer abgebrochener Aufruf: nicht als Turn gezählt", async () => {
    const { topicId, key } = topic();
    const s = setup({ result: () => ({ text: "", aborted: true, sessionId: "S1" }) });
    s.store.set(`${key}:general`, "S1");
    expect(await resumeMacTask({ chat_id: CHAT, thread_id: topicId }, CHAT, "Ja", s.deps)).toEqual({ status: "aborted" });
    expect(s.finalized).toHaveLength(0);
  });
});

describe("Session-Auswahl ohne globalen Rückfall", () => {
  test("alte task.session_id nach /new oder Modellwechsel: fortgesetzt, aber nie als Topic-Session gespeichert", async () => {
    const { topicId, key } = topic();
    const s = setup({});
    s.store.set(`${key}:general`, "S-neu");
    const outcome = await resumeMacTask({ chat_id: CHAT, thread_id: topicId, session_id: "S-alt" }, CHAT, "Ja", s.deps);
    expect(outcome).toMatchObject({ status: "done", resumeId: "S-alt" });
    expect(s.finalized).toHaveLength(0);
  });

  test("Session-Modus aus: nur die Session der Rückfrage, keine Topic-Suche", async () => {
    const { topicId, key } = topic();
    const s = setup({ sessionMode: false });
    s.store.set(`${key}:general`, "S-topic");
    const outcome = await resumeMacTask({ chat_id: CHAT, thread_id: topicId, session_id: "S-frage" }, CHAT, "Ja", s.deps);
    expect(outcome).toMatchObject({ status: "done", resumeId: "S-frage" });
    expect(s.lookups).toHaveLength(0);
    expect(s.finalized).toHaveLength(0);
  });

  test("keine Session der Rückfrage und keine im Topic: kein Rückfall auf die Session eines anderen Topics", async () => {
    const a = topic();
    const b = topic();
    const s = setup({});
    s.store.set(`${a.key}:general`, "S-anderes-topic");
    const outcome = await resumeMacTask({ chat_id: CHAT, thread_id: b.topicId }, CHAT, "Ja", s.deps);
    expect(outcome).toEqual({ status: "no-session" });
    expect(s.calls).toHaveLength(0);
    expect(s.lookups).toEqual([[b.key, "general", s.model]]);
  });

  test("Session-Suche mit dem Modell des Agenten statt Opus", async () => {
    const { topicId, key } = topic();
    const s = setup({ model: "claude-haiku-test" });
    s.store.set(`${key}:general`, "S-haiku");
    const outcome = await resumeMacTask({ chat_id: CHAT, thread_id: topicId }, CHAT, "Ja", s.deps);
    expect(outcome).toMatchObject({ status: "done", resumeId: "S-haiku" });
    expect(s.lookups[0]![2]).toBe("claude-haiku-test");
  });
});

describe("Topic-Zuordnung", () => {
  test("taskTarget: Topic, Schlüssel und Agent aus dem Task", () => {
    expect(taskTarget({ chat_id: CHAT, thread_id: 42, metadata: { agent_name: "finance" } }, "x")).toEqual({
      chatId: CHAT,
      topicId: 42,
      sessionKey: `topic:${CHAT}:42`,
      agent: "finance",
    });
    expect(taskTarget({ thread_id: null }, "4711")).toEqual({
      chatId: "4711",
      topicId: undefined,
      sessionKey: "dm:4711",
      agent: "general",
    });
  });
});

// Issue #349: alte Aufträge des Agent SDK laufen über den Mac-Zweig und
// speichern mit Art task_resume; eine eigene Art agent_sdk_resume gibt es nicht mehr
describe("Topic beim Speichern und bei Merk-Tags, alle Resume-Pfade", () => {
  const paths = [
    { name: "Mac (Claude Code)", kind: "task_resume", origin: "Telegram", agent: "research" },
    { name: "Alter Auftrag des Agent SDK (über den Mac-Zweig)", kind: "task_resume", origin: "Telegram", agent: "research" },
    { name: "Anthropic API", kind: "task_resume", origin: "Telegram (Anthropic API)" },
  ] as const;

  for (const path of paths) {
    test(`${path.name}: Antwort unter topic:<chat>:<id>, Merk-Vorschlag im Topic`, async () => {
      const task = { chat_id: CHAT, thread_id: 42, metadata: { agent_name: "research" } };
      const response = "Erledigt. [REMEMBER: Alex mag Tee]";
      const record = taskResumeRecord(task, CHAT, {
        taskId: "t-1",
        response,
        kind: path.kind,
        origin: path.origin,
        ...("agent" in path ? { agent: path.agent } : {}),
      });

      expect(record.message).toEqual({
        chat_id: CHAT,
        role: "assistant",
        content: response,
        metadata: { type: path.kind, taskId: "t-1", topicId: 42, ...("agent" in path ? { agent: path.agent } : {}) },
      });
      // saveMessage leitet den Session-Schlüssel genau so ab (metadata.topicId)
      expect(sessionKeyFor(record.message.chat_id, record.message.metadata.topicId as number)).toBe(`topic:${CHAT}:42`);
      expect(record.intents).toEqual({ chatId: CHAT, topicId: 42, origin: path.origin });

      // Merk-Tags aus fremden Inhalten: der Vorschlag geht in das Topic der Rückfrage
      const staged: { chatId: string; topicId?: number }[] = [];
      const outcome = await processTurnIntents(response, { uses: [{ name: "WebFetch" }], cwd: "/tmp/projekt" }, record.intents, {
        stageMemoryReview: async (p) => {
          staged.push({ chatId: p.chatId, topicId: p.topicId });
          return "rev-1";
        },
        processIntents: async () => ({}),
        log: () => {},
        projectRoot: "/tmp/projekt",
      });
      expect(outcome).toBe("staged");
      expect(staged).toEqual([{ chatId: CHAT, topicId: 42 }]);
    });
  }

  test("Rückfrage im Direktchat: kein Topic, Schlüssel wie bisher", () => {
    const record = taskResumeRecord({ chat_id: "4711" }, "4711", { taskId: "t-2", response: "ok", kind: "task_resume", origin: "Telegram" });
    expect(record.message.metadata).toEqual({ type: "task_resume", taskId: "t-2" });
    expect(record.intents).toEqual({ chatId: "4711", origin: "Telegram" });
    expect(sessionKeyFor(record.message.chat_id, undefined)).toBe("dm:4711");
  });
});
