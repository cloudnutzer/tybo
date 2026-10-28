// Kindprozess für tests/hybrid-relay.test.ts (Issue #353): Server mit der
// echten Weiterleitung und eigener Rechner mit dem echten Telegram-Kanal
// (wireTelegramChannel), verbunden über den echten Health-Server mit /relay.
// Läuft im übergebenen Arbeitsverzeichnis, weil src/agents/base.ts die
// Topic-Zuordnung beim Import aus config/topics.json dort liest. Modell,
// Ablage und Medien-Kern sind Attrappen, die Bot-API wird abgefangen.
// Gibt je Schritt eine JSON-Zeile aus; src/bot.ts wird nie importiert.
import { Bot, type Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { startHybrid } from "../src/app/hybrid";
import { startHealthServer } from "../src/app/health-server";
import { wireTelegramChannel } from "../src/app/bot-telegram-channel";
import { createBotCommandServices } from "../src/app/command-services";
import type { BotTurns } from "../src/app/bot-turns";
import type { PreparedMedia } from "../src/lib/media-turn";
import { createTelegramRuntime } from "../src/lib/telegram-runtime";
import type { HeartbeatStore, Timers } from "../src/lib/hybrid/peer-health";

const TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghijklmn";
const OWNER = "4242";
const GROUP = process.argv[2]!;
const TOPIC = Number(process.argv[3]);
const SECRET = "relay-geheimnis-fuer-tests-0123456789";
const DB = { SUPABASE_URL: "https://beispiel.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-nur-fuer-tests" };
const me = { id: 123456789, is_bot: true, first_name: "tybo", username: "tybo_bot" } as UserFromGetMe;
const allowChat = (chatId: string) => chatId === OWNER || chatId === GROUP;

type ApiCall = { method: string; chat?: unknown; thread?: unknown; text?: unknown };
const peerCalls: ApiCall[] = [];
const serverCalls: ApiCall[] = [];
const events: string[] = [];

function fakeBot(calls: ApiCall[], botInfo: boolean): Bot {
  const bot = new Bot(TOKEN, botInfo ? { botInfo: me } : {});
  bot.api.config.use(async (_prev, method, payload) => {
    const p = payload as Record<string, unknown>;
    if (method !== "getMe" && method !== "sendChatAction") calls.push({ method, chat: p.chat_id, thread: p.message_thread_id, text: p.text });
    const result =
      method === "getMe" ? me
      : method === "sendMessage" ? { message_id: 99, date: 0, chat: { id: Number(p.chat_id), type: "private" } }
      : true;
    return { ok: true, result } as never;
  });
  return bot;
}

// Herzschlag-Ablage wie node_heartbeat, mit echter Uhr
const beats = new Map<string, number>();
const store: HeartbeatStore = {
  async heartbeat(nodeId) {
    beats.set(nodeId, Date.now());
    return true;
  },
  async nodeStatus(nodeId, maxAgeMs) {
    const at = beats.get(nodeId);
    if (at === undefined) return { online: false, lastHeartbeat: null };
    return { online: Date.now() - at < maxAgeMs, lastHeartbeat: new Date(at).toISOString() };
  },
};
const timers: Timers = { setInterval: () => 0, clearInterval: () => {} };

// --- eigener Rechner: echter Kanal ---
const PEER_ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_USER_ID: OWNER, TYBO_PROFILE: "peer", GATEWAY_SECRET: SECRET, ...DB };
const runtime = createTelegramRuntime({ env: PEER_ENV, createBot: () => fakeBot(peerCalls, false), log: () => {} });
const peerHybrid = startHybrid({ env: PEER_ENV, runtime, isShuttingDown: () => false, isIntakeClosed: () => false, store: () => store, allowChat, timers, log: () => {} });
const health = startHealthServer({
  port: 0,
  session: () => ({ sessionId: null, engine: null }),
  secret: () => SECRET,
  allowChat: () => true,
  process: async () => {},
  relay: peerHybrid.relayRoute,
});

const turns: BotTurns<Context> = {
  ask: async () => "nicht erwartet",
  askWithProgress: async (_ctx, prompt, chatId, agent, topicId) => {
    events.push(`turn:${agent}:${chatId}:${topicId ?? "-"}:${prompt}`);
    return `Antwort von ${agent}`;
  },
  trackSession: () => async () => {},
};
const services = {
  ...createBotCommandServices({ routineMenu: async () => false }),
  getGoal: async () => null,
  abortEngineCalls: (sessionKey: string) => (events.push(`stop:${sessionKey}`), 1),
};
const { channel } = wireTelegramChannel({
  env: PEER_ENV,
  runtime,
  turns,
  choices: { topicChoices: {} as never, proactiveChoices: {} as never, reviewResults: {} as never },
  services: services as never,
  isShuttingDown: () => false,
  afterTurn: (chatId, topicId) => void events.push(`afterTurn:${chatId}:${topicId ?? "-"}`),
  invokeBudget: 3,
  parts: {
    saveMessage: async () => true,
    processIntents: async () => undefined as never,
    onGoalTurn: (key, agent) => void events.push(`session:${key}:${agent}`),
    noteThreads: () => {},
    threadHint: async () => undefined,
    captureTopicName: async () => {},
    download: async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3]), filePath: "files/datei" }),
    prepareMedia: async input => {
      events.push(`prepare:${input.kind}`);
      return { kind: input.kind, localPath: "/tmp/tybo-test/datei", prompt: `${input.kind}-Prompt`, classifyText: "", userContent: `[${input.kind}]`, userMetadata: {}, replyMetadata: {} } as unknown as PreparedMedia;
    },
    finishMedia: (_prepared, raw) => raw,
    cleanupMedia: async () => void events.push("cleanup"),
  },
});
runtime.bot!.use(channel.handlers);
await runtime.start(() => {});
await store.heartbeat("local");

// --- Server: echte Weiterleitung, dahinter nur ein Zähler für eigene Handler ---
let fetches = 0;
const serverBot = fakeBot(serverCalls, true);
const serverHybrid = startHybrid({
  env: {
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_USER_ID: OWNER,
    TYBO_PROFILE: "server",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret-fuer-tests_0123456789",
    HYBRID_PEER_URL: `http://127.0.0.1:${health.port}`,
    GATEWAY_SECRET: SECRET,
    ...DB,
  },
  runtime: { bot: serverBot, relayIntake: () => null },
  isShuttingDown: () => false,
  store: () => store,
  allowChat,
  ownsChoice: async () => false,
  fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => (fetches++, fetch(input, init))) as typeof fetch,
  log: () => {},
});
let serverHandled = 0;
serverBot.use(() => void serverHandled++);

// --- Schritte ---
let nextId = 5000;
const from = { id: Number(OWNER), is_bot: false, first_name: "Alex" };
const dm = { id: Number(OWNER), type: "private", first_name: "Alex" };
const group = { id: Number(GROUP), type: "supergroup", title: "tybo", is_forum: true };
const inTopic = { chat: group, message_thread_id: TOPIC, is_topic_message: true };
const message = (fields: Record<string, unknown>) => ({ message_id: ++nextId, date: 0, from, chat: dm, ...fields });

async function step(name: string, update: Record<string, unknown>, done: () => boolean): Promise<void> {
  const before = { events: events.length, peer: peerCalls.length, server: serverCalls.length, fetches, handled: serverHandled };
  await serverBot.handleUpdate({ update_id: ++nextId, ...update } as Update);
  const end = Date.now() + 3000;
  while (!done() && Date.now() < end) await Bun.sleep(5);
  // Nachlauf: kommt danach noch etwas, soll es im Ergebnis stehen
  await Bun.sleep(100);
  console.log(
    JSON.stringify({
      name,
      fetches: fetches - before.fetches,
      serverHandled: serverHandled - before.handled,
      serverCalls: serverCalls.slice(before.server),
      events: events.slice(before.events),
      peerCalls: peerCalls.slice(before.peer),
    }),
  );
}

const nextEvent = (prefix: string) => {
  const at = events.length;
  return () => events.slice(at).some(e => e.startsWith(prefix));
};
await step("topic", { message: message({ ...inTopic, text: "Was gibt es Neues?" }) }, nextEvent("afterTurn"));
await step("stop", { message: message({ ...inTopic, text: "/stop", entities: [{ type: "bot_command", offset: 0, length: 5 }] }) }, () => peerCalls.some(c => c.method === "sendMessage"));
await step("photo", { message: message({ ...inTopic, caption: "Was ist das?", photo: [{ file_id: "f1", file_unique_id: "u1", width: 10, height: 10, file_size: 100 }] }) }, nextEvent("cleanup"));
await step("voice", { message: message({ voice: { file_id: "f2", file_unique_id: "u2", duration: 3, mime_type: "audio/ogg", file_size: 100 } }) }, nextEvent("cleanup"));
await step("document", { message: message({ document: { file_id: "f3", file_unique_id: "u3", file_name: "notiz.pdf", mime_type: "application/pdf", file_size: 100 } }) }, nextEvent("cleanup"));
await step("edited", { edited_message: message({ edit_date: 1, text: "Wie wird das Wetter? (bearbeitet)" }) }, () => true);

serverHybrid.stop();
peerHybrid.stop();
health.stop();
runtime.stop();
process.exit(0);
