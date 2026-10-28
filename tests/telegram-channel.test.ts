// Issue #344: createTelegramChannel als Verhalten: Besitzerprüfung vor allen
// Handlern, Text und Medien im Bereich des Gesprächs, Service-Nachrichten
// zu Topics, Knöpfe über die Kette. Ohne Netz: Updates gehen direkt an den
// Composer, bot.ts wird nie importiert.
import { describe, expect, test } from "bun:test";
import { Context, type Api } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { createTelegramChannel, MEDIA_UPDATES, type TelegramChannelDeps } from "../src/channels/telegram/channel";
import type { MediaInboxDeps } from "../src/channels/telegram/media-inbox";
import type { TextInboxDeps } from "../src/channels/telegram/text-inbox";

const OWNER = 1000;
const me = { id: 1, is_bot: true, first_name: "tybo", username: "tybo_bot" } as UserFromGetMe;

function textUpdate(text: string, from = OWNER, threadId?: number): Update {
  return {
    update_id: 1,
    message: { message_id: 5, date: 0, chat: { id: -100, type: "supergroup", title: "G" }, from: { id: from, is_bot: false, first_name: "Alex" }, text, ...(threadId ? { message_thread_id: threadId } : {}) },
  } as Update;
}

function setup(overrides: Partial<TelegramChannelDeps> = {}) {
  const events: string[] = [];
  const api = { sendMessage: async () => ({}), sendChatAction: async () => true } as unknown as Api;
  const text: TextInboxDeps<Context> = {
    captureTopicName: async () => {},
    saveMessage: async m => void events.push(`save:${m.content}`),
    matchCommand: () => null,
    runCommand: async () => {},
    agentForMention: () => null,
    isActiveAgent: () => true,
    topicAgent: () => undefined,
    claimTopicQuestion: async () => false,
    askTopicAgent: async () => true,
    agentNames: () => [],
    reply: async r => void events.push(`reply:${r.agentName}:${r.userMessage}`),
  };
  const deps: TelegramChannelDeps = {
    owner: String(OWNER),
    scope: async (ctx, run) => {
      events.push(`scope:${ctx.chat?.id}`);
      await run();
    },
    text,
    media: {} as MediaInboxDeps,
    callbacks: {
      toolApproval: async (_ctx, next) => next(),
      router: async ctx => void events.push(`router:${ctx.callbackQuery?.data}`),
    },
    topicService: (chatId, message) => events.push(`topic:${chatId}:${(message as { forum_topic_created?: { name: string } }).forum_topic_created?.name}`),
    ...overrides,
  };
  const channel = createTelegramChannel(deps);
  const handle = async (update: Update) => {
    await channel.handlers.middleware()(new Context(update, api, me), async () => {});
    // Text und Knöpfe laufen ohne Warten; einen Takt geben
    await new Promise(r => setTimeout(r, 5));
  };
  return { events, handle, channel };
}

describe("createTelegramChannel", () => {
  test("Text des Besitzers: im Bereich gespeichert und beantwortet", async () => {
    const s = setup();
    await s.handle(textUpdate("hallo"));
    expect(s.events).toEqual(["scope:-100", "save:hallo", "reply:general:hallo"]);
  });

  test("fremde Absender bekommen nichts, auch keine Knöpfe", async () => {
    const s = setup();
    await s.handle(textUpdate("hallo", 999));
    await s.handle({ update_id: 2, callback_query: { id: "q", from: { id: 999, is_bot: false, first_name: "X" }, chat_instance: "c", data: "goal:x" } } as Update);
    expect(s.events).toEqual([]);
  });

  test("ohne Besitzer-ID nimmt der Kanal nichts an", async () => {
    const s = setup({ owner: "" });
    await s.handle(textUpdate("hallo"));
    expect(s.events).toEqual([]);
  });

  test("Knopf des Besitzers geht im Bereich an die Weiche", async () => {
    const s = setup();
    await s.handle({
      update_id: 3,
      callback_query: { id: "q", from: { id: OWNER, is_bot: false, first_name: "Alex" }, chat_instance: "c", data: "goal:pause" },
    } as Update);
    expect(s.events).toEqual(["scope:undefined", "router:goal:pause"]);
  });

  test("Topic angelegt: an den Empfänger, ohne Bereich", async () => {
    const s = setup();
    await s.handle({
      update_id: 4,
      message: { message_id: 6, date: 0, chat: { id: -100, type: "supergroup", title: "G" }, from: { id: OWNER, is_bot: false, first_name: "Alex" }, message_thread_id: 9, forum_topic_created: { name: "Reisen", icon_color: 1 } },
    } as Update);
    expect(s.events).toEqual(["topic:-100:Reisen"]);
  });

  test("Fehler im Text-Handler landen im Log, nicht bei grammY", async () => {
    const logged: string[] = [];
    const s = setup({ scope: async () => { throw new Error("kaputt"); }, logError: message => logged.push(message) });
    await s.handle(textUpdate("hallo"));
    expect(logged).toEqual(["Text handler error:"]);
  });

  test("Medienarten wie bisher", () => {
    expect([...MEDIA_UPDATES]).toEqual(["message:voice", "message:photo", "message:document", "message:video", "message:video_note"]);
  });

  test("Medien laufen im Bereich durch den Medien-Eingang", async () => {
    const logged: string[] = [];
    const s = setup({ logError: message => logged.push(message) });
    await s.handle({
      update_id: 5,
      message: { message_id: 8, date: 0, chat: { id: -100, type: "supergroup", title: "G" }, from: { id: OWNER, is_bot: false, first_name: "Alex" }, voice: { file_id: "f", file_unique_id: "u", duration: 1 } },
    } as Update);
    expect(s.events[0]).toBe("scope:-100");
    // Die leeren Medien-Attrappen scheitern; der Fehler bleibt im Log
    expect(logged.length).toBeLessThanOrEqual(1);
  });
});
