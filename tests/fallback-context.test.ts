/**
 * Kontext für die Fallback-Kette (Issue #331): der Helfer baut ihn je
 * Unterhaltung (chatId, Topic, Agent, Nachricht), die Fortsetzungs-Funktion
 * nimmt die Unterhaltung des Tasks. Prompt-Bau und Kette sind ersetzt.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { abortError, isAbortError } from "../src/lib/execution-context";
import type { PromptContextOptions } from "../src/lib/prompt-builder";
import type { FallbackRequest, FallbackResult } from "../src/lib/fallback/chain";
import {
  fallbackContextFor,
  fallbackReplyFor,
  fallbackReplyForTask,
  setFallbackHelperForTests,
  type FallbackConversation,
} from "../src/lib/fallback/context";

afterEach(() => setFallbackHelperForTests());

/** Prompt-Bau-Attrappe: Kontext aus chatId, Topic und Agent */
function fakeBuild() {
  const calls: PromptContextOptions[] = [];
  const build = async (o: PromptContextOptions) => {
    calls.push(o);
    return { fullPrompt: "voll", fallbackContext: `## RECENT CONVERSATION\nchat=${o.chatId} topic=${o.topicId ?? "-"} agent=${o.agentName}` };
  };
  return { build, calls };
}

/** Helfer mit ersetztem Kontext und ersetzter Kette */
function captureHelper() {
  const loads: FallbackConversation[] = [];
  const chains: FallbackRequest[] = [];
  const { build } = fakeBuild();
  setFallbackHelperForTests({
    loadContext: async (c) => {
      loads.push(c);
      return fallbackContextFor(c, build);
    },
    runChain: async (r): Promise<FallbackResult> => {
      chains.push(r);
      return { text: "Ersatz", source: "openrouter", model: "m" };
    },
  });
  return { loads, chains };
}

describe("fallbackContextFor", () => {
  test("gibt chatId, Topic, Agent und Nachricht an den Prompt-Bau und liefert dessen fallbackContext", async () => {
    const { build, calls } = fakeBuild();
    const ctx = await fallbackContextFor({ chatId: "42", topicId: 7, agent: "research", message: "Frage" }, build);
    expect(calls).toEqual([{ chatId: "42", topicId: 7, agentName: "research", userMessage: "Frage" }]);
    expect(ctx).toBe("## RECENT CONVERSATION\nchat=42 topic=7 agent=research");
  });

  test("Topic-Isolation: zwei Topics derselben chatId und der Direktchat bekommen je eigenen Kontext", async () => {
    const { build, calls } = fakeBuild();
    const a = await fallbackContextFor({ chatId: "42", topicId: 7, agent: "general", message: "x" }, build);
    const b = await fallbackContextFor({ chatId: "42", topicId: 8, agent: "general", message: "x" }, build);
    const dm = await fallbackContextFor({ chatId: "42", agent: "general", message: "x" }, build);
    expect(new Set([a, b, dm]).size).toBe(3);
    expect(calls.map((c) => c.topicId)).toEqual([7, 8, undefined]);
  });

  test("ohne Agent: general", async () => {
    const { build, calls } = fakeBuild();
    await fallbackContextFor({ chatId: "42", message: "x" }, build);
    expect(calls[0].agentName).toBe("general");
  });

  test("Prompt-Bau wirft: derselbe Fehler geht an den Aufrufer, kein leerer Kontext", async () => {
    const fehler = new Error("kein Speicher");
    await expect(
      fallbackContextFor({ chatId: "42", message: "x" }, async () => {
        throw fehler;
      })
    ).rejects.toBe(fehler);
  });

  test("Abbruch beim Prompt-Bau: AbortError geht unverändert weiter", async () => {
    const abbruch = abortError();
    let error: unknown;
    try {
      await fallbackContextFor({ chatId: "42", message: "x" }, async () => {
        throw abbruch;
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBe(abbruch);
    expect(isAbortError(error)).toBe(true);
  });
});

describe("fallbackReplyFor", () => {
  test("Kontext der Unterhaltung geht in die Kette, Antwort mit deutschem Zusatz", async () => {
    const { chains } = captureHelper();
    const reply = await fallbackReplyFor({ chatId: "42", topicId: 3, agent: "general", message: "Wie spät?" });
    expect(reply).toBe("Ersatz\n\n_(Antwort über openrouter)_");
    expect(chains).toEqual([{ question: "Wie spät?", context: "## RECENT CONVERSATION\nchat=42 topic=3 agent=general" }]);
  });

  test.each([
    ["Fehler", () => new Error("kein Speicher")],
    ["Abbruch", () => abortError()],
  ])("Kontextaufbau scheitert (%s): Kette startet nicht, Fehler geht an den Aufrufer", async (_name, makeError) => {
    const fehler = makeError();
    const chains: FallbackRequest[] = [];
    setFallbackHelperForTests({
      loadContext: (c) =>
        fallbackContextFor(c, async () => {
          throw fehler;
        }),
      runChain: async (r): Promise<FallbackResult> => {
        chains.push(r);
        return { text: "Ersatz", source: "openrouter", model: "m" };
      },
    });
    await expect(fallbackReplyFor({ chatId: "42", topicId: 3, message: "Wie spät?" })).rejects.toBe(fehler);
    expect(chains).toHaveLength(0);
  });
});

describe("fallbackReplyForTask (Fortsetzungszweige in bot.ts)", () => {
  test("nimmt chat_id, thread_id und metadata.agent_name des Tasks, nicht die aktuelle Unterhaltung", async () => {
    const { loads, chains } = captureHelper();
    await fallbackReplyForTask(
      { chat_id: "100", thread_id: 9, metadata: { agent_name: "finance" }, original_prompt: "Was kostet das?" },
      "999"
    );
    expect(loads).toEqual([{ chatId: "100", topicId: 9, agent: "finance", message: "Was kostet das?" }]);
    expect(chains[0].context).toBe("## RECENT CONVERSATION\nchat=100 topic=9 agent=finance");
    expect(chains[0].context).not.toContain("999");
  });

  test("zwei Tasks aus verschiedenen Topics bekommen je ihren Kontext", async () => {
    const { chains } = captureHelper();
    await fallbackReplyForTask({ chat_id: "100", thread_id: 1, original_prompt: "a" }, "100");
    await fallbackReplyForTask({ chat_id: "100", thread_id: 2, original_prompt: "b" }, "100");
    expect(chains.map((c) => c.context)).toEqual([
      "## RECENT CONVERSATION\nchat=100 topic=1 agent=general",
      "## RECENT CONVERSATION\nchat=100 topic=2 agent=general",
    ]);
  });

  test("ohne chat_id die Unterhaltung des Knopfdrucks, ohne thread_id der Direktchat", async () => {
    const { loads } = captureHelper();
    await fallbackReplyForTask({ original_prompt: "c", thread_id: null }, "555");
    expect(loads).toEqual([{ chatId: "555", topicId: undefined, agent: "general", message: "c" }]);
  });
});

describe("Altauftrag mit messages_snapshot (Knopf atask:, Issue #348)", () => {
  // Scheitert das Fortsetzen eines alten Auftrags aus dem Gateway, antwortet
  // das Ersatzmodell im Gespräch des Auftrags: Chat und Topic vom Auftrag,
  // ohne agent_name der Agent general. Gilt mit und ohne alten Prozessor.
  test("Ersatzantwort mit chatId und Topic des Auftrags, Agent general", async () => {
    const { loads, chains } = captureHelper();
    await fallbackReplyForTask(
      {
        chat_id: "77",
        thread_id: 12,
        original_prompt: "Hilfe",
        metadata: { messages_snapshot: [{ role: "user", content: "Hilfe" }], tool_use_id: "tu-1" },
      },
      "999"
    );
    expect(loads).toEqual([{ chatId: "77", topicId: 12, agent: "general", message: "Hilfe" }]);
    expect(chains[0].context).toContain("chat=77 topic=12 agent=general");
  });
});
