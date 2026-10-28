/**
 * Issue #341: Konsultation anderer Agenten (src/lib/agent-consult.ts).
 * Festgehalten wird das Verhalten aus Doku und Aufrufern: der Tag
 * [INVOKE:agent|Frage] wortgleich, Budget, Rechte aus dem Katalog, keine
 * Ketten, und der befragte Agent bekommt einen Auszug des Gesprächs statt
 * der doppelten Frage. Der Telegram-Weg läuft über den gemeinsamen Abschluss
 * (createTurnFinish) mit consultViaAgentBots; den Web-Weg prüft
 * tests/web-invoke.test.ts. src/bot.ts wird nie importiert.
 */
import { describe, expect, test } from "bun:test";
import {
  CONSULT_EXCERPT_MAX_CHARS,
  CONSULT_EXCERPT_MESSAGES,
  CONSULT_HEADING,
  CONSULT_NO_HISTORY,
  buildConsultExcerpt,
  consult,
  consultViaAgentBots,
  extractConsults,
  formatConsultPrompt,
  limitConsults,
  stripConsultTags,
  type ConsultChannel,
  type RecentMessages,
} from "../src/lib/agent-consult";
import { BUILTIN_AGENTS, createAgent, deleteAgent, mayConsult } from "../src/agents/catalog";
import { createTurnFinish } from "../src/lib/turn-finish";
import type { Message } from "../src/lib/store/types";
import { isolateAgentCatalog } from "./catalog-fixture";

isolateAgentCatalog();

const GROUP = "-100555";
const NOW = new Date("2026-10-21T12:00:00Z");
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

function recordingChannel(answer = "Antwort") {
  const events: string[] = [];
  const prompts: string[] = [];
  const channel: ConsultChannel = {
    typing: async target => void events.push(`typing ${target}`),
    ask: async (prompt, target) => {
      events.push(`ask ${target}`);
      prompts.push(prompt);
      return answer;
    },
    deliver: async (target, text) => void events.push(`deliver ${target} ${text}`),
  };
  return { channel, events, prompts };
}

describe("Tags", () => {
  test("[INVOKE:agent|Frage] wortgleich: Kennung klein, mit Bindestrich, Frage ohne Rand, Reihenfolge bleibt", () => {
    const reply = "Vorab. [INVOKE:Research|  Was kostet das? ] Dann [INVOKE:projekt-planer|Welche Schritte?] Ende";
    expect(extractConsults(reply)).toEqual([
      { targetAgent: "research", question: "Was kostet das?" },
      { targetAgent: "projekt-planer", question: "Welche Schritte?" },
    ]);
    expect(stripConsultTags(reply)).toBe("Vorab.  Dann  Ende");
  });

  test("ohne Tag: nichts gefunden, Text unverändert bis auf den Rand", () => {
    expect(extractConsults("  [INVOKE:] und [INVOKE:x] zählen nicht ")).toEqual([]);
    expect(stripConsultTags("  Nur Text  ")).toBe("Nur Text");
  });

  test("Budget: höchstens so viele, die ersten bleiben", () => {
    const list = ["a", "b", "c", "d"].map(q => ({ targetAgent: "critic", question: q }));
    expect(limitConsults(list, 2).map(r => r.question)).toEqual(["a", "b"]);
    expect(limitConsults(list, 4)).toBe(list);
  });
});

describe("Rechte im Agenten-Katalog", () => {
  test("mitgelieferte Matrix vollständig wie bisher, Critic fragt niemanden, General fragt niemand", () => {
    const names = Object.keys(BUILTIN_AGENTS);
    const allowed = names.flatMap(from => names.filter(to => mayConsult(from, to)).map(to => `${from}>${to}`));
    expect(allowed.sort()).toEqual(
      [
        "general>critic", "general>finance", "general>research", "general>content", "general>strategy", "general>cto", "general>coo",
        "research>critic",
        "content>critic", "content>research",
        "finance>critic",
        "strategy>critic", "strategy>finance", "strategy>research", "strategy>cto",
        "cto>critic", "cto>research",
        "coo>critic", "coo>finance", "coo>cto",
      ].sort(),
    );
    expect(mayConsult("general", "coo")).toBe(true);
    expect(mayConsult("strategy", "cto")).toBe(true);
    expect(mayConsult("finance", "research")).toBe(false);
    expect(mayConsult("critic", "general")).toBe(false);
  });

  test("Aliasse zählen wie die Kennung, unbekannte und gelöschte Agenten nie", async () => {
    expect(mayConsult("orchestrator", "devils-advocate")).toBe(true);
    expect(mayConsult("General", "CRITIC")).toBe(true);
    expect(mayConsult("general", "gibt-es-nicht")).toBe(false);
    expect(mayConsult("constructor", "critic")).toBe(false);
    await deleteAgent("critic");
    expect(mayConsult("research", "critic")).toBe(false);
  });

  test("eigene Agenten: General darf sie fragen, sie selbst nur critic und research", async () => {
    await createAgent({ name: "reise-planer", description: "Plant Reisen", systemPrompt: "Du planst Reisen.", model: "m" });
    expect(mayConsult("general", "reise-planer")).toBe(true);
    expect(mayConsult("strategy", "reise-planer")).toBe(false);
    expect(mayConsult("reise-planer", "research")).toBe(true);
    expect(mayConsult("reise-planer", "finance")).toBe(false);
  });
});

describe("consult", () => {
  test("ohne Recht: keine Tippt-Anzeige, kein Aufruf, null", async () => {
    const { channel, events } = recordingChannel();
    const result = await consult("critic", { targetAgent: "research", question: "?" }, { chatId: GROUP }, channel, { recent: async () => [] });
    expect(result).toBeNull();
    expect(events).toEqual([]);
  });

  test("Ablauf: Tippt-Anzeige, Aufruf als Ziel, Antwort ohne verschachtelte Tags zugestellt", async () => {
    const { channel, events } = recordingChannel("Risiko hoch [INVOKE:research|weiter?]");
    const result = await consult("general", { targetAgent: "critic", question: "Risiko?" }, { chatId: GROUP, topicId: 7 }, channel, { recent: async () => [] });
    expect(result).toBe("Risiko hoch");
    expect(events).toEqual(["typing critic", "ask critic", "deliver critic Risiko hoch"]);
  });

  test("Fehler des Kanals erreichen den Aufrufer", async () => {
    const channel: ConsultChannel = {
      typing: async () => {},
      ask: async () => {
        throw new Error("Modell weg");
      },
      deliver: async () => {},
    };
    await expect(consult("general", { targetAgent: "critic", question: "?" }, { chatId: GROUP }, channel, { recent: async () => [] })).rejects.toThrow("Modell weg");
  });
});

describe("Gesprächsauszug statt doppelter Frage", () => {
  const history: Message[] = [
    { chat_id: GROUP, role: "user", content: "Wir planen einen Laden in Leipzig.", created_at: at(10), metadata: { topicId: 7 } },
    { chat_id: GROUP, role: "user", content: "Geheimes aus Topic 9", created_at: at(9), metadata: { topicId: 9 } },
    { chat_id: GROUP, role: "assistant", content: "Pipeline fertig", created_at: at(8), metadata: { topicId: 7, display_only: true } },
    { chat_id: GROUP, role: "user", content: "Lohnt sich die Miete von 2.000 Euro?", created_at: at(2), metadata: { topicId: 7 } },
    {
      chat_id: GROUP,
      role: "assistant",
      content: "Ich frage Finance. [INVOKE:finance|Rechnet sich 2.000 Euro Miete bei 30 Kunden am Tag?]",
      created_at: at(1),
      metadata: { topicId: 7, agent: "general" },
    },
  ];

  test("Prompt: Gesprächsinhalt drin, Frage genau einmal, fremdes Topic und Meldungen nicht", async () => {
    const { channel, prompts } = recordingChannel();
    const asked: unknown[] = [];
    const recent: RecentMessages = async (chatId, limit, topicId) => {
      asked.push([chatId, limit, topicId]);
      return history;
    };
    const question = "Rechnet sich 2.000 Euro Miete bei 30 Kunden am Tag?";
    await consult("general", { targetAgent: "finance", question }, { chatId: GROUP, topicId: 7 }, channel, { recent, now: () => NOW });

    expect(asked).toEqual([[GROUP, CONSULT_EXCERPT_MESSAGES * 2, 7]]);
    const prompt = prompts[0];
    expect(prompt.startsWith(CONSULT_HEADING)).toBe(true);
    expect(prompt).toContain("User: Wir planen einen Laden in Leipzig.");
    expect(prompt).toContain("User: Lohnt sich die Miete von 2.000 Euro?");
    expect(prompt).toContain("Bot: Ich frage Finance.");
    expect(occurrences(prompt, question)).toBe(1);
    expect(prompt).not.toContain("[INVOKE:");
    expect(prompt).not.toContain("Geheimes aus Topic 9");
    expect(prompt).not.toContain("Pipeline fertig");
    expect(prompt).not.toContain(CONSULT_NO_HISTORY);
  });

  test("Direktchat ohne Topic liest den topic-losen Verlauf (topicId null)", async () => {
    const { channel } = recordingChannel();
    const asked: unknown[] = [];
    await consult("general", { targetAgent: "critic", question: "?" }, { chatId: "4711" }, channel, {
      recent: async (...args) => {
        asked.push(args);
        return [];
      },
    });
    expect(asked).toEqual([["4711", CONSULT_EXCERPT_MESSAGES * 2, null]]);
  });

  test("ohne Verlauf (leer oder Lesefehler): fester Hinweis, Frage trotzdem genau einmal", async () => {
    for (const recent of [async () => [], async () => Promise.reject(new Error("Datenbank weg"))] as RecentMessages[]) {
      const { channel, prompts } = recordingChannel();
      await consult("general", { targetAgent: "critic", question: "Was kann schiefgehen?" }, { chatId: GROUP, topicId: 7 }, channel, { recent });
      expect(prompts[0]).toContain(CONSULT_NO_HISTORY);
      expect(occurrences(prompts[0], "Was kann schiefgehen?")).toBe(1);
    }
  });

  test("Größe: höchstens CONSULT_EXCERPT_MESSAGES Nachrichten und CONSULT_EXCERPT_MAX_CHARS Zeichen, die neuesten bleiben", () => {
    const many: Message[] = Array.from({ length: 30 }, (_, i) => ({
      chat_id: GROUP,
      role: "user",
      content: `Nachricht ${i} ${"x".repeat(900)}`,
      created_at: at(60 - i),
    }));
    const excerpt = buildConsultExcerpt(many, null, NOW);
    expect(excerpt.length).toBeLessThanOrEqual(CONSULT_EXCERPT_MAX_CHARS);
    expect(excerpt).toContain("Nachricht 29 ");
    expect(excerpt).not.toContain("Nachricht 17 ");
    expect(excerpt.split("\n").length).toBeLessThanOrEqual(CONSULT_EXCERPT_MESSAGES);

    const huge = buildConsultExcerpt([{ chat_id: GROUP, role: "user", content: `Anfang ${"y".repeat(15_000)} Ende`, created_at: at(1) }], null, NOW);
    expect(huge.length).toBe(CONSULT_EXCERPT_MAX_CHARS);
    expect(huge.endsWith("Ende")).toBe(true);
  });

  test("Überlange neueste Nachricht: ihr Ende bleibt, auch über den Grenzen des Gesprächskontexts", () => {
    const cases: Message[] = [
      { chat_id: GROUP, role: "assistant", content: `Anfang ${"a".repeat(7_000)} ENDE-ANTWORT`, created_at: at(1) },
      { chat_id: GROUP, role: "user", content: `Anfang ${"u".repeat(21_000)} ENDE-NUTZER`, created_at: at(1) },
    ];
    for (const message of cases) {
      const marker = message.content.slice(-40);
      const excerpt = buildConsultExcerpt([{ chat_id: GROUP, role: "user", content: "Vorher", created_at: at(2) }, message], null, NOW);
      expect(excerpt.length).toBe(CONSULT_EXCERPT_MAX_CHARS);
      expect(excerpt.endsWith(marker)).toBe(true);
      expect(excerpt).not.toContain("Anfang");
      // Zeitangabe und Sprecher bleiben, die ältere Nachricht passt nicht mehr dazu
      expect(excerpt.startsWith(`[1 minute ago] ${message.role === "user" ? "User" : "Bot"}: ...`)).toBe(true);
      expect(excerpt).not.toContain("Vorher");
    }
  });

  test("Neueste Antwort über 800 Zeichen kommt ganz mit, ältere werden wie im Gesprächskontext gekürzt", () => {
    const older = `Alt ${"o".repeat(1_000)} ALT-ENDE`;
    const newest = `Neu ${"n".repeat(1_000)} NEU-ENDE`;
    const excerpt = buildConsultExcerpt(
      [
        { chat_id: GROUP, role: "assistant", content: older, created_at: at(3) },
        { chat_id: GROUP, role: "assistant", content: newest, created_at: at(1) },
      ],
      null,
      NOW,
    );
    expect(excerpt).toContain(newest);
    expect(excerpt).toContain("Alt ");
    expect(excerpt).not.toContain("ALT-ENDE");
  });

  test("Prompt-Text: Auszug vor der Frage, fragender Agent genannt", () => {
    const prompt = formatConsultPrompt("strategy", "[1 minute ago] User: Hallo", "Was meinst du?");
    expect(prompt.indexOf("User: Hallo")).toBeLessThan(prompt.indexOf("Was meinst du?"));
    expect(prompt).toContain("strategy");
  });

  test("Telegram-Weg: gemeinsamer Abschluss mit consultViaAgentBots, Auszug aus dem Topic, Antwort einmal gespeichert", async () => {
    const saved: Message[] = [...history.slice(0, 4)];
    const sent: string[] = [];
    const prompts: { agent: string; prompt: string; chatId: string; thread?: number }[] = [];
    const bots = {
      sendTypingAsAgent: async (agent: string) => void sent.push(`typing ${agent}`),
      sendAsAgent: async (agent: string, _chat: string | number, text: string, options?: { threadId?: number }) =>
        void sent.push(`send ${agent} ${options?.threadId} ${text}`),
    };
    const recent: RecentMessages = async (chatId, _limit, topicId) =>
      saved.filter(m => m.chat_id === chatId && ((m.metadata?.topicId as number | undefined) ?? null) === topicId);
    const finish = createTurnFinish({
      saveMessage: async m => void saved.push({ ...m, created_at: NOW.toISOString() }),
      processIntents: async () => {},
      onGoalTurn: () => {},
      invoke: (fromAgent, request, chatId, topicId, delivered) =>
        consultViaAgentBots({
          bots,
          fromAgent,
          request,
          chatId,
          threadId: topicId,
          ask: async (prompt, chat, agent, thread) => {
            prompts.push({ agent, prompt, chatId: chat, thread });
            return "Bei 30 Kunden knapp.";
          },
          delivered,
          deps: { recent, now: () => NOW },
        }),
      invokeBudget: 3,
      noteThreads: () => {},
    });
    const question = "Rechnet sich 2.000 Euro Miete bei 30 Kunden am Tag?";
    await finish({
      chatId: GROUP,
      topicId: 7,
      agentName: "general",
      reply: `Ich frage Finance. [INVOKE:finance|${question}]`,
      metadata: { agent: "general", topicId: 7 },
      send: async text => void sent.push(`main ${text}`),
    });

    expect(sent).toEqual(["main Ich frage Finance.", "typing finance", "send finance 7 Bei 30 Kunden knapp."]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ agent: "finance", chatId: GROUP, thread: 7 });
    expect(prompts[0].prompt).toContain("User: Lohnt sich die Miete von 2.000 Euro?");
    expect(prompts[0].prompt).toContain("Bot: Ich frage Finance.");
    expect(occurrences(prompts[0].prompt, question)).toBe(1);
    expect(prompts[0].prompt).not.toContain("Geheimes aus Topic 9");
    expect(prompts[0].prompt).not.toContain("Pipeline fertig");
    const answers = saved.filter(m => m.content === "Bei 30 Kunden knapp.");
    expect(answers).toHaveLength(1);
    expect(answers[0].metadata).toEqual({ agent: "finance", topicId: 7, invokedBy: "general" });
  });
});
