// Issue #344: Text-Eingang des Telegram-Kanals als Verhalten (Zitat,
// Erwähnung, Topic-Frage, Befehle). Ersetzt die Quelltext-Prüfungen von
// handleTextMessage in src/bot.ts; bot.ts wird nie importiert.
import { describe, expect, test } from "bun:test";
import {
  createTelegramTextInbox,
  promptWithQuote,
  QUOTE_MAX_CHARS,
  replyQuote,
  type TextInboxDeps,
  type TextReplyRequest,
  type TextUpdate,
} from "../src/channels/telegram/text-inbox";
import { TOPIC_MAP_TEXT } from "../src/lib/topic-choices";
import { commandRegistry } from "../src/lib/commands/builtin";
import type { CommandMatch } from "../src/lib/commands/types";
import type { Message } from "../src/lib/store/types";

interface FakeCtx extends TextUpdate {
  replies: { text: string; other?: Record<string, unknown> }[];
}

function ctxFor(text: string, extra: { topicId?: number; replyTo?: unknown; chatId?: number } = {}): FakeCtx {
  const replies: FakeCtx["replies"] = [];
  return {
    chat: { id: extra.chatId ?? 42 },
    message: { text, message_id: 7, message_thread_id: extra.topicId, reply_to_message: extra.replyTo },
    replies,
    reply: async (t, other) => {
      replies.push({ text: t, other });
      return {};
    },
  };
}

function setup(overrides: Partial<TextInboxDeps<FakeCtx>> = {}) {
  const saved: Message[] = [];
  const answers: TextReplyRequest<FakeCtx>[] = [];
  const commands: string[] = [];
  const captured: number[] = [];
  const asked: string[] = [];
  let claims = 0;
  const deps: TextInboxDeps<FakeCtx> = {
    captureTopicName: async topicId => void captured.push(topicId),
    saveMessage: async m => void saved.push(m),
    matchCommand: text => (text.startsWith("/help") ? ({ command: { name: "help" }, args: "" } as unknown as CommandMatch) : null),
    runCommand: async (_ctx, chatId, topicId, text) => void commands.push(`${chatId}|${topicId}|${text}`),
    agentForMention: text => (text.includes("@research_bot") ? { agent: "research", cleanedText: text.replace("@research_bot", "").trim() } : null),
    isActiveAgent: agent => agent !== "deleted",
    topicAgent: topicId => (topicId === 5 ? "finance" : undefined),
    claimTopicQuestion: async () => ++claims === 1,
    askTopicAgent: async (chatId, topicId) => (asked.push(`${chatId}:${topicId}`), true),
    agentNames: () => ["general", "research"],
    reply: async request => void answers.push(request),
    ...overrides,
  };
  return { deps, saved, answers, commands, captured, asked, inbox: createTelegramTextInbox(deps) };
}

describe("replyQuote", () => {
  test("Text und Bildunterschrift zählen, Absender Bot oder Nutzer", () => {
    expect(replyQuote({ reply_to_message: { text: "Hallo", from: { is_bot: true } } })).toEqual({ text: "Hallo", byBot: true });
    expect(replyQuote({ reply_to_message: { caption: "Foto vom Strand" } })).toEqual({ text: "Foto vom Strand", byBot: false });
  });

  test("Service-Nachricht der Topic-Anlage und leere Nachrichten sind kein Zitat", () => {
    expect(replyQuote({ reply_to_message: { forum_topic_created: { name: "Reisen" }, text: "x" } })).toBeUndefined();
    expect(replyQuote({ reply_to_message: { from: { is_bot: true } } })).toBeUndefined();
    expect(replyQuote({})).toBeUndefined();
    expect(replyQuote(undefined)).toBeUndefined();
  });

  test("lange Zitate werden nach 3000 Zeichen gekürzt", () => {
    const long = "a".repeat(QUOTE_MAX_CHARS + 50);
    const quote = replyQuote({ reply_to_message: { text: long } })!;
    expect(quote.text).toBe(`${"a".repeat(QUOTE_MAX_CHARS)}\n[... gekuerzt]`);
    expect(replyQuote({ reply_to_message: { text: "a".repeat(QUOTE_MAX_CHARS) } })!.text).toHaveLength(QUOTE_MAX_CHARS);
  });

  test("promptWithQuote stellt das Zitat voran und nennt den Absender", () => {
    expect(promptWithQuote("Und jetzt?", undefined)).toBe("Und jetzt?");
    expect(promptWithQuote("Und jetzt?", { text: "Plan A", byBot: true })).toBe(
      '[Der User antwortet per Telegram-Reply auf diese Nachricht von dir (dem Bot):]\n"""\nPlan A\n"""\n\nUnd jetzt?'
    );
    expect(promptWithQuote("ok", { text: "Notiz", byBot: false })).toContain("von sich selbst:]");
  });
});

describe("createTelegramTextInbox", () => {
  test("gezielter Job-Reply wird vor Speicherung, Befehl und normalem Turn abgefangen", async () => {
    let calls = 0;
    const s = setup({ jobReply: async ctx => { calls++; return !!ctx.message?.reply_to_message; } });
    await s.inbox(ctxFor("/help", { replyTo: { message_id: 42 } }));
    expect(calls).toBe(1);
    expect(s.saved).toEqual([]);
    expect(s.commands).toEqual([]);
    expect(s.answers).toEqual([]);
    await s.inbox(ctxFor("Gewöhnlicher Text", { topicId: 5 }));
    expect(s.saved).toHaveLength(1);
    expect(s.answers).toHaveLength(1);
  });
  test("leere Nachricht: nichts gespeichert, keine Antwort", async () => {
    const s = setup();
    await s.inbox(ctxFor("   "));
    expect(s.saved).toHaveLength(0);
    expect(s.answers).toHaveLength(0);
  });

  test("speichert die Nachricht mit Topic, Nachrichten-ID und kurzem Zitat-Vermerk", async () => {
    const s = setup();
    await s.inbox(ctxFor("  Wie weiter?  ", { topicId: 5, replyTo: { text: "b".repeat(500) } }));
    expect(s.saved[0]).toEqual({
      chat_id: "42",
      role: "user",
      content: "Wie weiter?",
      metadata: { topicId: 5, messageId: 7, replyTo: "b".repeat(300) },
    });
    expect(s.captured).toEqual([5]);
    // Prompt an den Topic-Agenten mit vollem Zitat
    expect(s.answers[0].agentName).toBe("finance");
    expect(s.answers[0].userMessage).toContain("b".repeat(500));
    expect(s.answers[0].threads).toBe(true);
  });

  test("Topic-Name wird nur in Topics gemerkt; ein Fehler dabei stört nicht", async () => {
    const s = setup({ captureTopicName: async () => { throw new Error("kaputt"); } });
    await s.inbox(ctxFor("hallo", { topicId: 5 }));
    expect(s.answers).toHaveLength(1);
    const dm = setup();
    await dm.inbox(ctxFor("hallo"));
    expect(dm.captured).toEqual([]);
  });

  test("Befehl läuft über die Befehls-Schicht, ohne Agenten-Antwort", async () => {
    const s = setup();
    await s.inbox(ctxFor("/help", { topicId: 9 }));
    expect(s.commands).toEqual(["42|9|/help"]);
    expect(s.answers).toHaveLength(0);
    expect(s.saved).toHaveLength(1);
  });

  test("/credit und credit (auch groß geschrieben) laufen seit Issue #346 über die Befehls-Schicht, kein eigener Weg", async () => {
    const s = setup({ matchCommand: text => commandRegistry.match(text, "telegram") });
    for (const text of ["/credit", "credit", "Credit"]) {
      const ctx = ctxFor(text);
      await s.inbox(ctx);
      expect(ctx.replies).toEqual([]);
    }
    expect(s.commands).toEqual(["42|undefined|/credit", "42|undefined|credit", "42|undefined|Credit"]);
    expect(s.answers).toHaveLength(0);
  });

  test("Erwähnung holt den Agenten vor dem Topic-Agenten, mit bereinigtem Text und Zitat", async () => {
    const s = setup();
    await s.inbox(ctxFor("@research_bot such mal", { topicId: 5, replyTo: { text: "Artikel", from: { is_bot: false } } }));
    expect(s.answers).toHaveLength(1);
    expect(s.answers[0].agentName).toBe("research");
    expect(s.answers[0].userMessage).toBe(promptWithQuote("such mal", { text: "Artikel", byBot: false }));
    expect(s.asked).toEqual([]);
  });

  test("Erwähnung eines gelöschten Agenten wird ignoriert", async () => {
    const s = setup({ agentForMention: text => ({ agent: "deleted", cleanedText: text }) });
    await s.inbox(ctxFor("@alt_bot hallo", { topicId: 5 }));
    expect(s.answers[0].agentName).toBe("finance");
    expect(s.answers[0].userMessage).toBe("@alt_bot hallo");
  });

  test("Topic ohne Agent: einmal über das Register gefragt, general antwortet", async () => {
    const s = setup();
    await s.inbox(ctxFor("erste", { topicId: 11 }));
    await s.inbox(ctxFor("zweite", { topicId: 11 }));
    expect(s.asked).toEqual(["42:11"]);
    expect(s.answers.map(a => a.agentName)).toEqual(["general", "general"]);
  });

  test("Topic mit Agent und Direktchat: keine Frage", async () => {
    const claimed: number[] = [];
    const s = setup({ claimTopicQuestion: async (_c, t) => (claimed.push(t), true) });
    await s.inbox(ctxFor("hallo", { topicId: 5 }));
    await s.inbox(ctxFor("hallo"));
    expect(claimed).toEqual([]);
    expect(s.answers.map(a => a.agentName)).toEqual(["finance", "general"]);
  });

  test("Register scheitert: alte topicmap:-Knöpfe im Topic, auf Seiten zu 100", async () => {
    const names = Array.from({ length: 130 }, (_, i) => `agent${i}`);
    const s = setup({ askTopicAgent: async () => false, agentNames: () => names });
    const ctx = ctxFor("hallo", { topicId: 11 });
    await s.inbox(ctx);
    expect(ctx.replies).toHaveLength(2);
    expect(ctx.replies[0].text).toBe(TOPIC_MAP_TEXT.question(11));
    expect(ctx.replies[1].text).toBe(TOPIC_MAP_TEXT.legacyMore(2, 2));
    const firstKeyboard = (ctx.replies[0].other!.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
    expect(firstKeyboard.flat()).toHaveLength(100);
    expect(firstKeyboard[0][0].callback_data).toBe("topicmap:11:agent0");
    expect(ctx.replies[0].other!.message_thread_id).toBe(11);
    expect(s.answers[0].agentName).toBe("general");
  });

  test("Fehler beim Senden der alten Knöpfe hält die Antwort nicht auf", async () => {
    const s = setup({ askTopicAgent: async () => false });
    const ctx = ctxFor("hallo", { topicId: 11 });
    ctx.reply = async () => { throw new Error("Telegram weg"); };
    await s.inbox(ctx);
    expect(s.answers).toHaveLength(1);
  });
});
