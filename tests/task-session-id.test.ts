import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { runJsonTurn, runStreamingTurn, resolveStreamingLimits, type ChatTurnDeps } from "../src/lib/chat-turn";
import { turnInfoCollector } from "../src/lib/turn-collector";
import type { ClaudeOptions, ClaudeResult } from "../src/lib/claude";
import { createClaudeEngine } from "../src/lib/engines";

// Issue #189, Schritt 4: eine Rückfrage mit Knöpfen merkt sich die Session
// des Turns, der sie gestellt hat. Früher: Suche mit Opus statt dem Modell
// des Agenten, Rückfall auf die globale letzte Session (anderes Topic).
// src/bot.ts wird nur als Text gelesen, nie importiert.

const CHAT = "-100888";

function deps(opts: { sessionMode: boolean; model: string; call: (o: ClaudeOptions) => Promise<ClaudeResult> }): Partial<ChatTurnDeps> {
  return {
    getEngine: () => createClaudeEngine({ callClaude: opts.call, callClaudeStreaming: opts.call }),
    buildPromptContext: async () => ({ fullPrompt: "voll", fallbackContext: "" }),
    buildResumePrompt: async () => "resume",
    isSessionModeEnabled: () => opts.sessionMode,
    getResumableSession: async () => undefined,
    takeExpiredSession: async () => undefined,
    recordSessionTurn: async () => true,
    getSessionsForKey: async () => [],
    resetSession: async () => 0,
    sessionEpoch: () => 0,
    shouldDistill: () => false,
    distillSession: async () => {},
    log: async () => {},
    getAgentConfig: () => ({ model: opts.model }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
    getSettings: () => ({}),
    resolveStreamingLimits: () => resolveStreamingLimits({}),
    reportSecrets: () => [],
  };
}

const sink = { progress() {}, notice() {} };

describe("Session-ID je Turn statt globaler letzter Session", () => {
  for (const sessionMode of [true, false]) {
    test(`zwei Topics gleichzeitig, Nicht-Opus-Modell, Session-Modus ${sessionMode ? "an" : "aus"}`, async () => {
      // Topic 1 startet zuerst, endet aber nach Topic 2: die globale letzte
      // Session wäre dann die von Topic 1, auch für die Frage aus Topic 2
      let finishFirst!: () => void;
      const firstGate = new Promise<void>((r) => (finishFirst = r));
      const models: string[] = [];
      const global: string[] = [];
      const call = (id: string, gate?: Promise<void>) => async (o: ClaudeOptions): Promise<ClaudeResult> => {
        models.push(o.model!);
        await gate;
        return { text: "Welche Option?", sessionId: id };
      };
      const t1 = turnInfoCollector();
      const t2 = turnInfoCollector();
      const track = (c: ReturnType<typeof turnInfoCollector>) => (id: string) => {
        c.onSessionId(id);
        global.push(id);
      };

      const first = runStreamingTurn({
        userMessage: "a", chatId: CHAT, agentName: "research", topicId: 1, sink,
        onSessionId: track(t1),
        deps: deps({ sessionMode, model: "claude-sonnet-test", call: call("S-topic-1", firstGate) }),
      });
      const second = runJsonTurn({
        userMessage: "b", chatId: CHAT, agentName: "finance", topicId: 2, sink,
        onSessionId: track(t2),
        deps: deps({ sessionMode, model: "claude-haiku-test", call: call("S-topic-2") }),
      });
      await second;
      finishFirst();
      await first;

      expect(global.at(-1)).toBe("S-topic-1"); // die alte globale Quelle zeigte auf Topic 1
      expect(t2.sessionId()).toBe("S-topic-2");
      expect(t1.sessionId()).toBe("S-topic-1");
      expect(models.sort()).toEqual(["claude-haiku-test", "claude-sonnet-test"]);
    });
  }

  test("abgebrochener Turn meldet keine Session", async () => {
    const t = turnInfoCollector();
    await runJsonTurn({
      userMessage: "a", chatId: CHAT, agentName: "general", topicId: 3, sink,
      onSessionId: t.onSessionId,
      deps: deps({ sessionMode: true, model: "m", call: async () => ({ text: "", aborted: true, sessionId: "S-x" }) }),
    });
    expect(t.sessionId()).toBeUndefined();
  });
});

describe("Bot (src/bot.ts, src/app/, Telegram-Kanal): Rückfrage und Knopf-Antwort", () => {
  const files = ["src/bot.ts", ...new Bun.Glob("src/{app,channels/telegram}/*.ts").scanSync({ cwd: "." })];
  const source = files.map(f => readFileSync(f, "utf-8")).join("\n");

  test("ohne Opus-Suche", () => {
    // Issue #336: Rückfrage mit der Session genau dieses Turns, ohne globalen Rückfall und ohne eigenen
    // Auftrag, als Verhalten geprüft in tests/telegram-reply-turn.test.ts und tests/chat-turn-question.test.ts
    expect(source).not.toContain("MODEL_IDS.opus");
  });

  // Knopf-Antwort im Mac-Modus (Issue #337): nur über resumeMacTask unter der Sperre, Antwort mit
  // Topic gespeichert, als Verhalten geprüft in tests/legacy-task-buttons.test.ts („Fortsetzen im Mac-Zweig")
});
