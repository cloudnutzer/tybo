/** Übergabe-Proben: echter Prompt und echte Session-Ablage, nur Quellen und Motoren als Attrappen. */
import { resolveEngine } from "../src/lib/engine-choice";
import { runJsonTurn } from "../src/lib/chat-turn";
import type { EngineId, EngineRequest } from "../src/lib/engines";
import { buildPromptContext, buildResumePrompt, type PromptSources } from "../src/lib/prompt-builder";
import type { Message } from "../src/lib/store/types";

export function handoverSources(chatId: string, since: number): Partial<PromptSources> {
  const messages: Message[] = [
    { chat_id: chatId, role: "user", content: "Erste Frage mit der Zahl 7319", created_at: new Date(since - 60_000).toISOString() },
    ...Array.from({ length: 13 }, (_, i): Message => ({
      chat_id: chatId, role: i % 2 === 0 ? "assistant" : "user", content: `Beitrag ${i + 1}`,
      created_at: new Date(since + i).toISOString(),
    })),
  ];
  return {
    agent: () => ({ name: "General", model: "claude-modell", systemPrompt: "SYSTEM" }),
    overrides: () => "", consultation: () => "", profile: async () => "Profil", core: async () => "Kern",
    memory: async () => "Gedächtnis", knowledge: async () => "Wissen", similar: async () => [],
    followUp: async () => ({ messages: [], facts: [] }), memorySince: async () => "",
    recent: async (_chatId, limit) => messages.slice(-limit), now: () => new Date(since + 1000), timeZone: () => "UTC",
  };
}

export async function handoverProbe(input: { chatId: string; topicId?: number; agentName?: string; engine: EngineId; since: number; configured?: boolean }) {
  const calls: EngineRequest[] = [];
  const sources = handoverSources(input.chatId, input.since);
  await runJsonTurn({
    userMessage: "Was war die erste Frage?", chatId: input.chatId, topicId: input.topicId,
    agentName: input.agentName ?? "general", ...(input.configured ? {} : { engine: input.engine }), sink: { progress() {}, notice() {} },
    deps: {
      resolveEngine: (key, deps, turn) => resolveEngine(key, { ...deps, env: () => ({}),
        checkEngine: async engine => ({ engine, checked: true, installed: true, loggedIn: true }), log: () => {} }, turn),
      getEngine: id => ({ id, describe: () => id, run: async request => {
        if (id !== input.engine) throw new Error(`Unerwarteter Motor: ${id}`);
        calls.push(request);
        return { engine: id, text: "Antwort", sessionId: "neue-session", isError: false };
      } }),
      getAgentConfig: () => ({ name: "General", model: "claude-modell", systemPrompt: "SYSTEM" }),
      buildPromptContext: options => buildPromptContext(options, sources),
      buildResumePrompt: options => buildResumePrompt(options, sources),
      isSessionModeEnabled: () => true, shouldDistill: () => false, log: async () => {},
      reportSecrets: () => [], setTimer: () => 0, clearTimer: () => {},
      runFallbackChain: async () => { throw new Error("Kein Ersatzmodell erwartet"); },
    },
  });
  return calls;
}
