// Issue #344: wireTelegramChannel als Verhalten. Text und Medien aus Telegram
// laufen durch den echten Kanal bis in den gemeinsamen Abschluss: Antwort
// speichern, Merk-Tor, /goal, Versand, Rückfrage, offene Fäden. Modell,
// Ablage, Merk-Tor und Medien-Kern sind Attrappen; ohne Netz gehen Updates
// direkt an den Composer. bot.ts wird nie importiert.
import { describe, expect, test } from "bun:test";
import { Context, type Api } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import type { BotTurns } from "../src/app/bot-turns";
import { wireTelegramChannel } from "../src/app/bot-telegram-channel";
import { createBotCommandServices } from "../src/app/command-services";
import type { TurnQuestion } from "../src/lib/chat-turn";
import type { PreparedMedia } from "../src/lib/media-turn";
import { sessionKeyFor } from "../src/lib/store/message-rules";
import { createTelegramRuntime } from "../src/lib/telegram-runtime";
import type { TurnTools } from "../src/lib/turn-tools";

const OWNER = "4242";
const GROUP = -1001234567890;
const me = { id: 1, is_bot: true, first_name: "tybo", username: "tybo_bot" } as UserFromGetMe;
const from = { id: Number(OWNER), is_bot: false, first_name: "Alex" };

async function waitFor(check: () => boolean): Promise<void> {
  const end = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

function setup(reply = "Antwort") {
  const events: string[] = [];
  const tools = { names: ["WebSearch"] } as unknown as TurnTools;
  const targets: unknown[] = [];
  const intentTools: unknown[] = [];
  const sent: { chatId: unknown; text: string; threadId?: number }[] = [];
  const api = {
    sendChatAction: async () => true,
    sendMessage: async (chatId: unknown, text: string, other?: { message_thread_id?: number }) => {
      sent.push({ chatId, text, threadId: other?.message_thread_id });
      return { message_id: 2, date: 0, chat: { id: chatId } };
    },
  } as unknown as Api;

  const question = { question: "Weiter?", options: ["Ja", "Nein"], via: "tag", offer: async () => void events.push("offer") } as unknown as TurnQuestion;
  const turns: BotTurns<Context> = {
    ask: async () => "nicht erwartet",
    askWithProgress: async (_ctx, prompt, chatId, agent, topicId, extras) => {
      events.push(`turn:${agent}:${chatId}:${topicId ?? "-"}:${prompt}`);
      extras?.onTools?.(tools);
      extras?.onQuestion?.(question);
      return reply;
    },
    trackSession: () => async () => {},
  };

  const base = createTelegramRuntime({ env: {}, log: () => {} });
  const runtime = {
    ...base,
    agents: {
      ...base.agents,
      sendAsAgent: async (agent: string, chatId: string, text: string, options?: { threadId?: number }) =>
        void events.push(`send:${agent}:${chatId}:${options?.threadId ?? "-"}:${text}`),
    },
  };

  const prepared: PreparedMedia = {
    kind: "photo",
    localPath: "/tmp/tybo-test/foto.jpg",
    prompt: "Foto mit Frage: Was ist das?",
    classifyText: "Was ist das?",
    userContent: "[Foto] Was ist das?",
    userMetadata: { type: "photo" },
    replyMetadata: { type: "photo_reply" },
    foreignInput: "Foto",
  };

  const { channel } = wireTelegramChannel({
    env: { TELEGRAM_USER_ID: OWNER, TELEGRAM_BOT_TOKEN: "123:test" },
    runtime,
    turns,
    choices: { topicChoices: {} as never, proactiveChoices: {} as never, reviewResults: {} as never },
    services: createBotCommandServices({ routineMenu: async () => false }),
    isShuttingDown: () => false,
    afterTurn: (chatId, topicId) => void events.push(`afterTurn:${chatId}:${topicId ?? "-"}`),
    invokeBudget: 3,
    parts: {
      saveMessage: async message => (events.push(`save:${message.role}:${message.content}`), true),
      processIntents: async (text, turnTools, target) => {
        events.push(`intents:${text}`);
        intentTools.push(turnTools);
        targets.push(target);
        return undefined as never;
      },
      onGoalTurn: (key, agent, text) => void events.push(`goal:${key}:${agent}:${text}`),
      noteThreads: (chatId, topicId, userText, text) => void events.push(`threads:${chatId}:${topicId ?? "-"}:${userText}:${text}`),
      threadHint: async () => undefined,
      captureTopicName: async () => {},
      download: async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3]), filePath: "photos/foto.jpg" }),
      prepareMedia: async () => (events.push("prepare"), prepared),
      finishMedia: (_p, raw) => `${raw} (nachbereitet)`,
      cleanupMedia: async () => void events.push("cleanup"),
    },
  });

  const handle = (update: Update) => channel.handlers.middleware()(new Context(update, api, me), async () => {});
  return { events, handle, tools, targets, intentTools, sent };
}

describe("wireTelegramChannel", () => {
  test("Text: Turn, dann gemeinsamer Abschluss mit Merk-Tor, /goal, Versand vom Agenten, Rückfrage und Fäden", async () => {
    const s = setup();
    await s.handle({ update_id: 1, message: { message_id: 5, date: 0, chat: { id: Number(OWNER), type: "private", first_name: "Alex" }, from, text: "Wie wird das Wetter?" } } as Update);
    await waitFor(() => s.events.some(e => e.startsWith("afterTurn")));

    expect(s.events).toEqual([
      "save:user:Wie wird das Wetter?",
      `turn:general:${OWNER}:-:Wie wird das Wetter?`,
      "save:assistant:Antwort",
      "intents:Antwort",
      `goal:${sessionKeyFor(OWNER, null)}:general:Antwort`,
      `send:general:${OWNER}:-:Antwort`,
      "offer",
      `threads:${OWNER}:-:Wie wird das Wetter?:Antwort`,
      `afterTurn:${OWNER}:-`,
    ]);
    // Das Merk-Tor sieht die Werkzeuge des Turns und das Gespräch
    expect(s.intentTools).toEqual([s.tools]);
    expect(s.targets).toEqual([{ chatId: OWNER, topicId: undefined, origin: "Telegram" }]);
  });

  test("Medien: Medien-Kern, derselbe Abschluss mit fremdem Inhalt fürs Merk-Tor, Antwort im Topic", async () => {
    const s = setup();
    await s.handle({
      update_id: 2,
      message: {
        message_id: 6,
        date: 0,
        chat: { id: GROUP, type: "supergroup", title: "G", is_forum: true },
        from,
        message_thread_id: 9,
        is_topic_message: true,
        caption: "Was ist das?",
        photo: [{ file_id: "f", file_unique_id: "u", width: 10, height: 10 }],
      },
    } as Update);
    await waitFor(() => s.events.includes("cleanup"));

    expect(s.events).toEqual([
      "prepare",
      "save:user:[Foto] Was ist das?",
      `turn:general:${GROUP}:9:Foto mit Frage: Was ist das?`,
      "save:assistant:Antwort (nachbereitet)",
      "intents:Antwort (nachbereitet)",
      `goal:${sessionKeyFor(String(GROUP), 9)}:general:Antwort (nachbereitet)`,
      "offer",
      `threads:${GROUP}:9:Was ist das?:Antwort (nachbereitet)`,
      "cleanup",
    ]);
    expect(s.intentTools).toEqual([s.tools]);
    expect(s.targets).toEqual([{ chatId: String(GROUP), topicId: 9, origin: "Telegram", foreignInput: "Foto" }]);
    // Versand im Gespräch der Nachricht, vor der Rückfrage
    expect(s.sent.map(m => ({ chatId: m.chatId, threadId: m.threadId, text: m.text }))).toEqual([{ chatId: GROUP, threadId: 9, text: "Antwort (nachbereitet)" }]);
  });

  test("fremder Absender: kein Turn, kein Abschluss", async () => {
    const s = setup();
    await s.handle({ update_id: 3, message: { message_id: 7, date: 0, chat: { id: 999, type: "private", first_name: "X" }, from: { id: 999, is_bot: false, first_name: "X" }, text: "Hallo" } } as Update);
    await Bun.sleep(20);
    expect(s.events).toEqual([]);
  });
});
