/**
 * Issue #353: Hybrid-Relay mit Peer-Health. Server und eigener Rechner
 * laufen hier im selben Testprozess: zwei echte grammY-Bots (Bot-API über
 * einen Transformer abgefangen, kein Netz zu Telegram), der echte
 * Health-Server mit /relay auf freiem Port, die echte Middleware des
 * Servers. Attrappen sind nur Herzschlag-Ablage, Uhr, Zeitgeber und, wo ein
 * Netzfehler gebraucht wird, fetch. src/bot.ts wird nie importiert.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Bot, Composer, type Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { startHybrid, type Hybrid } from "../src/app/hybrid";
import { startHealthServer, type HealthServer } from "../src/app/health-server";
import { wireTelegramChannel } from "../src/app/bot-telegram-channel";
import { createBotCommandServices } from "../src/app/command-services";
import type { BotTurns } from "../src/app/bot-turns";
import {
  attachChoiceTelegram,
  choiceCallbackData,
  createChoice,
  onChoiceChange,
  parseChoiceCallbackData,
  setChoicesFileForTests,
  useChoiceIdPrefix,
  CALLBACK_DATA_MAX_BYTES,
} from "../src/lib/choices";
import { installTelegramChoices } from "../src/lib/telegram-choices";
import { createTelegramRuntime, type TelegramRuntime } from "../src/lib/telegram-runtime";
import { resolveRuntimeProfile } from "../src/lib/runtime-profile";
import { sessionKeyFor } from "../src/lib/store/message-rules";
import { watchPeer, startPeerBeat, type HeartbeatStore, type Timers } from "../src/lib/hybrid/peer-health";
import { createRelayEndpoint, RELAY_HEADER } from "../src/lib/hybrid/relay-endpoint";
import {
  createRelayClient,
  createRelayMiddleware,
  PEER_CHOICE_AWAY_HINT,
  UNCLEAR_CALLBACK_HINT,
  UNCLEAR_MESSAGE_HINT,
} from "../src/lib/hybrid/relay";
import { isolateAgentCatalog } from "./catalog-fixture";

isolateAgentCatalog();

const TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghijklmn";
const OWNER = "4242";
const GROUP = "-1001234567890";
const STRANGER_CHAT = "999";
const STRANGER = "777";
const SECRET = "relay-geheimnis-fuer-tests-0123456789";
const me = { id: 123456789, is_bot: true, first_name: "tybo", username: "tybo_bot" } as UserFromGetMe;
const DB = { SUPABASE_URL: "https://beispiel.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-nur-fuer-tests" };
const PEER_ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_USER_ID: OWNER, TYBO_PROFILE: "peer", GATEWAY_SECRET: SECRET, ...DB };
const serverEnv = (peerUrl: string, extra: Record<string, string> = {}) => ({
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_USER_ID: OWNER,
  TYBO_PROFILE: "server",
  TELEGRAM_WEBHOOK_SECRET: "webhook-secret-fuer-tests_0123456789",
  HYBRID_PEER_URL: peerUrl,
  GATEWAY_SECRET: SECRET,
  ...DB,
  ...extra,
});
const allowChat = (chatId: string) => chatId === OWNER || chatId === GROUP;

const base = mkdtempSync(join(tmpdir(), "hybrid-relay-"));
let counter = 0;
const cleanups: (() => unknown)[] = [];

beforeEach(() => setChoicesFileForTests(join(base, `choices-${++counter}.json`)));
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
  useChoiceIdPrefix("");
});
afterAll(() => {
  setChoicesFileForTests(null);
  rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Attrappen
// ---------------------------------------------------------------------------

type ApiCall = { method: string; payload: Record<string, unknown> };

/** Echter grammY-Bot ohne Netz: jeder Api-Aufruf wird aufgezeichnet und beantwortet */
function fakeBot(token: string, calls: ApiCall[], options: { botInfo?: boolean } = {}): Bot {
  const bot = new Bot(token, options.botInfo === false ? {} : { botInfo: me });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result =
      method === "getMe" ? me
      : method === "sendMessage" ? { message_id: 99, date: 0, chat: { id: Number(OWNER), type: "private" } }
      : true;
    return { ok: true, result } as never;
  });
  return bot;
}

/** Herzschlag-Ablage wie node_heartbeat, mit eigener Uhr */
function fakeStore(clock: { now: number }) {
  const beats = new Map<string, number>();
  const state = { reads: 0, writes: 0, failRead: false };
  const store: HeartbeatStore = {
    async heartbeat(nodeId) {
      state.writes++;
      beats.set(nodeId, clock.now);
      return true;
    },
    async nodeStatus(nodeId, maxAgeMs) {
      state.reads++;
      if (state.failRead) throw new Error("Datenbank weg");
      const at = beats.get(nodeId);
      if (at === undefined) return { online: false, lastHeartbeat: null };
      return { online: clock.now - at < maxAgeMs, lastHeartbeat: new Date(at).toISOString() };
    },
  };
  return { store, beats, state };
}

function fakeTimers() {
  const intervals: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const timers: Timers = {
    setInterval(fn, ms) {
      const entry = { fn, ms, cleared: false };
      intervals.push(entry);
      return entry;
    },
    clearInterval(handle) {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
  return { timers, intervals };
}

let nextUpdate = 1000;
function textUpdate(text = "Wie wird das Wetter?", chatId = OWNER, threadId?: number, fromId = OWNER): Update {
  const id = ++nextUpdate;
  const from = { id: Number(fromId), is_bot: false, first_name: fromId === OWNER ? "Alex" : "Mia" };
  const chat = chatId === OWNER ? { id: Number(OWNER), type: "private", first_name: "Alex" } : { id: Number(chatId), type: "supergroup", title: "tybo", is_forum: true };
  const message = { message_id: id, date: 0, chat, from, text, ...(threadId ? { message_thread_id: threadId, is_topic_message: true } : {}) };
  return { update_id: id, message } as Update;
}

function clickUpdate(data: string, messageId = 77, chatId = OWNER, fromId = OWNER): Update {
  const id = ++nextUpdate;
  const from = { id: Number(fromId), is_bot: false, first_name: fromId === OWNER ? "Alex" : "Mia" };
  return {
    update_id: id,
    callback_query: { id: `cb-${id}`, from, chat_instance: "x", data, message: { message_id: messageId, date: 0, chat: { id: Number(chatId), type: "private", first_name: "Alex" }, text: "Frage" } },
  } as Update;
}

async function waitFor(check: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

/** Was ein Handler zu sehen bekommt */
type Seen = { updateId: number; chatId: string; threadId: number | null; text: string };
function recorder(seen: Seen[]): Composer<Context> {
  const composer = new Composer<Context>();
  composer.on("message", ctx => {
    seen.push({ updateId: ctx.update.update_id, chatId: String(ctx.chat.id), threadId: ctx.msg.message_thread_id ?? null, text: ctx.msg.text ?? "" });
  });
  composer.on("callback_query:data", async (ctx, next) => {
    if (ctx.callbackQuery.data.startsWith("ch|")) return next();
    seen.push({ updateId: ctx.update.update_id, chatId: String(ctx.chat?.id ?? ""), threadId: null, text: ctx.callbackQuery.data });
  });
  return composer;
}

// ---------------------------------------------------------------------------
// Eigener Rechner und Server
// ---------------------------------------------------------------------------

interface Peer {
  url: string;
  runtime: TelegramRuntime;
  hybrid: Hybrid;
  health: HealthServer;
  calls: ApiCall[];
  seen: Seen[];
  logs: string[];
  intervals: ReturnType<typeof fakeTimers>["intervals"];
  shutdown(): void;
  closeIntake(): void;
}

async function startPeer(store: HeartbeatStore, options: { allow?: (chatId: string) => boolean; choices?: boolean; channel?: (runtime: TelegramRuntime) => void } = {}): Promise<Peer> {
  const calls: ApiCall[] = [];
  const seen: Seen[] = [];
  const logs: string[] = [];
  let shuttingDown = false;
  let intakeClosed = false;
  const runtime = createTelegramRuntime({ env: PEER_ENV, createBot: token => fakeBot(token, calls, { botInfo: false }), log: line => logs.push(line) });
  const { timers, intervals } = fakeTimers();
  const hybrid = startHybrid({
    env: PEER_ENV,
    runtime,
    isShuttingDown: () => shuttingDown,
    isIntakeClosed: () => intakeClosed,
    store: () => store,
    allowChat: options.allow ?? allowChat,
    timers,
    log: line => logs.push(line),
  });
  const health = startHealthServer({
    port: 0,
    session: () => ({ sessionId: null, engine: null }),
    secret: () => SECRET,
    allowChat: () => true,
    process: async () => {},
    relay: hybrid.relayRoute,
  });
  if (options.choices) installTelegramChoices(runtime.bot!, runtime.choices);
  if (options.channel) options.channel(runtime);
  else runtime.bot!.use(recorder(seen));
  await runtime.start(() => {});
  cleanups.push(() => health.stop(), () => hybrid.stop(), () => runtime.stop());
  return {
    url: `http://127.0.0.1:${health.port}`,
    runtime,
    hybrid,
    health,
    calls,
    seen,
    logs,
    intervals,
    shutdown: () => void (shuttingDown = true),
    closeIntake: () => void (intakeClosed = true),
  };
}

interface Server {
  bot: Bot;
  hybrid: Hybrid;
  calls: ApiCall[];
  seen: Seen[];
  logs: string[];
  fetches: () => number;
  feed(update: Update): Promise<void>;
}

function startServer(
  peerUrl: string,
  store: HeartbeatStore,
  clock: { now: number },
  options: { fetch?: typeof fetch; ownsChoice?: (id: string) => Promise<boolean>; env?: Record<string, string> } = {},
): Server {
  const calls: ApiCall[] = [];
  const seen: Seen[] = [];
  const logs: string[] = [];
  let fetches = 0;
  const realFetch = options.fetch ?? fetch;
  const countingFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    fetches++;
    return realFetch(input, init);
  }) as typeof fetch;
  const bot = fakeBot(TOKEN, calls);
  const hybrid = startHybrid({
    env: options.env ?? serverEnv(peerUrl),
    runtime: { bot, relayIntake: () => null },
    isShuttingDown: () => false,
    store: () => store,
    allowChat,
    ownsChoice: options.ownsChoice ?? (async () => false),
    fetch: countingFetch,
    now: () => clock.now,
    log: line => logs.push(line),
  });
  bot.use(recorder(seen));
  // Knöpfe des Registers, die beim Server bleiben, landen hier
  bot.on("callback_query:data", ctx => {
    seen.push({ updateId: ctx.update.update_id, chatId: String(ctx.chat?.id ?? ""), threadId: null, text: ctx.callbackQuery.data });
  });
  cleanups.push(() => hybrid.stop());
  return { bot, hybrid, calls, seen, logs, fetches: () => fetches, feed: update => bot.handleUpdate(update) };
}

/** Rechner gesund: Herzschlag jetzt */
async function healthyPair(options: Parameters<typeof startServer>[3] & { peer?: Parameters<typeof startPeer>[1] } = {}) {
  const clock = { now: 1_000_000 };
  const db = fakeStore(clock);
  const peer = await startPeer(db.store, options.peer);
  await waitFor(() => db.state.writes > 0);
  const server = startServer(peer.url, db.store, clock, options);
  return { clock, db, peer, server };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Gesunder eigener Rechner", () => {
  test("Update geht genau einmal an /relay, der Rechner führt es aus, der Server keinen Handler", async () => {
    const { peer, server } = await healthyPair();
    const update = textUpdate("Hallo vom Handy");
    await server.feed(update);
    await waitFor(() => peer.seen.length > 0);
    await Bun.sleep(20);
    expect(server.fetches()).toBe(1);
    expect(server.seen).toEqual([]);
    expect(server.calls).toEqual([]);
    expect(peer.seen).toEqual([{ updateId: update.update_id, chatId: OWNER, threadId: null, text: "Hallo vom Handy" }]);
  });

  test("echter Telegram-Kanal auf dem Rechner: Turn mit Agent general im Direktchat, Antwort über die Bot-API", async () => {
    const turns: string[] = [];
    const fakeTurns: BotTurns<Context> = {
      ask: async () => "nicht erwartet",
      askWithProgress: async (_ctx, prompt, chatId, agent, topicId) => {
        turns.push(`${chatId}|${agent}|${topicId ?? "-"}|${prompt}`);
        return "Sonnig.";
      },
      trackSession: () => async () => {},
    };
    const channel = (runtime: TelegramRuntime) => {
      const wired = wireTelegramChannel({
        env: PEER_ENV,
        runtime,
        turns: fakeTurns,
        choices: { topicChoices: {} as never, proactiveChoices: {} as never, reviewResults: {} as never },
        services: createBotCommandServices({ routineMenu: async () => false }),
        isShuttingDown: () => false,
        afterTurn: () => {},
        invokeBudget: 3,
        parts: {
          saveMessage: async () => true,
          processIntents: async () => undefined as never,
          onGoalTurn: () => {},
          noteThreads: () => {},
          threadHint: async () => undefined,
          captureTopicName: async () => {},
        },
      });
      runtime.bot!.use(wired.channel.handlers);
    };
    const { peer, server } = await healthyPair({ peer: { channel } });
    await server.feed(textUpdate("Wie wird das Wetter?"));
    await waitFor(() => peer.calls.some(c => c.method === "sendMessage" && c.payload.text === "Sonnig."));
    expect(turns).toEqual([`${OWNER}|general|-|Wie wird das Wetter?`]);
    expect(server.calls).toEqual([]);
  });

  test("Topic bleibt erhalten: derselbe Handler sieht dieselbe chatId und message_thread_id wie beim Polling", async () => {
    const { peer, server } = await healthyPair();
    const update = textUpdate("Neue Idee", GROUP, 4366);
    await server.feed(update);
    await waitFor(() => peer.seen.length > 0);

    // Vergleich: derselbe Handler an einem Bot im Polling-Weg, dasselbe Update direkt eingespeist
    const pollingSeen: Seen[] = [];
    const polling = createTelegramRuntime({ env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_USER_ID: OWNER }, intake: { mode: "polling" }, createBot: t => fakeBot(t, []), log: () => {} });
    polling.bot!.use(recorder(pollingSeen));
    await polling.bot!.handleUpdate(update);

    expect(peer.seen).toEqual(pollingSeen);
    expect(peer.seen[0]).toMatchObject({ chatId: GROUP, threadId: 4366 });
  });

  test("Updates aus nicht freigegebenen Chats und andere Arten bleiben auf dem Server", async () => {
    const { server } = await healthyPair();
    await server.feed(textUpdate("fremd", STRANGER_CHAT));
    await server.feed({ update_id: ++nextUpdate, my_chat_member: {} } as unknown as Update);
    expect(server.fetches()).toBe(0);
    expect(server.seen.map(s => s.text)).toEqual(["fremd"]);
  });
});

describe("Peer-Health", () => {
  test("fehlender Herzschlag: Server verarbeitet selbst, keine Weiterleitung", async () => {
    const clock = { now: 5_000 };
    const db = fakeStore(clock);
    const server = startServer("http://127.0.0.1:1", db.store, clock);
    await server.feed(textUpdate("ohne Rechner"));
    expect(server.fetches()).toBe(0);
    expect(server.seen.map(s => s.text)).toEqual(["ohne Rechner"]);
  });

  test("veralteter Herzschlag (90 s und älter): Server verarbeitet selbst", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeStore(clock);
    db.beats.set("local", clock.now - 90_000);
    const server = startServer("http://127.0.0.1:1", db.store, clock);
    await server.feed(textUpdate("alt"));
    expect(server.fetches()).toBe(0);
    expect(server.seen.map(s => s.text)).toEqual(["alt"]);
  });

  test("Lesefehler zählt als nicht gesund", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeStore(clock);
    db.beats.set("local", clock.now);
    db.state.failRead = true;
    const server = startServer("http://127.0.0.1:1", db.store, clock);
    await server.feed(textUpdate("Datenbank weg"));
    expect(server.fetches()).toBe(0);
    expect(server.seen.map(s => s.text)).toEqual(["Datenbank weg"]);
  });

  test("Abfrage höchstens alle 15 s, gleichzeitige Nachrichten teilen eine; Grenze 90 s", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeStore(clock);
    db.beats.set("local", clock.now);
    const watch = watchPeer({ store: () => db.store, nodeId: "local", now: () => clock.now });
    expect(await Promise.all([watch.healthy(), watch.healthy(), watch.healthy()])).toEqual([true, true, true]);
    expect(db.state.reads).toBe(1);
    clock.now += 14_999;
    expect(await watch.healthy()).toBe(true);
    expect(db.state.reads).toBe(1);
    clock.now += 1;
    await watch.healthy();
    expect(db.state.reads).toBe(2);
  });

  test("Grenze 90 s gilt auch zwischen zwei Abfragen: dieselbe Sicht, 89,999 s gesund, 90 s nicht, ohne neue Abfrage", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeStore(clock);
    db.beats.set("local", 1_000_000);
    const watch = watchPeer({ store: () => db.store, nodeId: "local", now: () => clock.now });
    clock.now = 1_000_000 + 80_000;
    expect(await watch.healthy()).toBe(true);
    expect(db.state.reads).toBe(1);
    clock.now = 1_000_000 + 89_999;
    expect(await watch.healthy()).toBe(true);
    clock.now = 1_000_000 + 90_000;
    expect(await watch.healthy()).toBe(false);
    // Beide Antworten aus dem festgehaltenen Stand, die Abfrage-Sperre von 15 s gilt weiter
    expect(db.state.reads).toBe(1);
  });

  test("Knotenkennung aus HYBRID_PEER_NODE_ID bzw. HYBRID_NODE_ID", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeStore(clock);
    const { timers } = fakeTimers();
    const beat = startPeerBeat({ store: () => db.store, nodeId: "werkbank", timers });
    await waitFor(() => db.state.writes === 1);
    beat.stop();
    const server = startServer("http://127.0.0.1:1", db.store, clock, { env: serverEnv("http://127.0.0.1:1", { HYBRID_PEER_NODE_ID: "werkbank" }) });
    const spy = startServer("http://127.0.0.1:1", db.store, clock);
    // Server mit passender Kennung hält den Rechner für gesund und versucht zu senden
    await server.feed(textUpdate("an werkbank"));
    await spy.feed(textUpdate("an local"));
    expect(server.fetches()).toBe(1);
    expect(spy.fetches()).toBe(0);
  });

  test("Herzschlag des Rechners: sofort, dann alle 30 s mit profile peer", async () => {
    const clock = { now: 0 };
    const db = fakeStore(clock);
    const written: unknown[] = [];
    const store: HeartbeatStore = { ...db.store, heartbeat: async (id, meta) => (written.push([id, meta]), true) };
    const peer = await startPeer(store);
    await waitFor(() => written.length === 1);
    expect(written).toEqual([["local", { profile: "peer" }]]);
    expect(peer.intervals.map(i => i.ms)).toEqual([30_000]);
    peer.intervals[0].fn();
    await waitFor(() => written.length === 2);
  });

  test("stop() nach dem Einplanen, vor dem Ausführen: kein weiterer Schreibaufruf", async () => {
    const clock = { now: 0 };
    const db = fakeStore(clock);
    // Start und sofortiges stop() im selben Takt: der erste Herzschlag ist eingeplant, läuft aber nie
    const first = fakeTimers();
    startPeerBeat({ store: () => db.store, nodeId: "local", timers: first.timers }).stop();
    await Bun.sleep(20);
    expect(db.state.writes).toBe(0);

    // Zeitgeber feuert, stop() folgt im selben Takt, bevor der eingeplante Schreibaufruf dran ist
    const second = fakeTimers();
    const beat = startPeerBeat({ store: () => db.store, nodeId: "local", timers: second.timers });
    await waitFor(() => db.state.writes === 1);
    second.intervals[0].fn();
    beat.stop();
    await Bun.sleep(20);
    expect(db.state.writes).toBe(1);
    expect(second.intervals.every(i => i.cleared)).toBe(true);
  });
});

describe("Sichere Ablehnung", () => {
  test("Verbindung abgelehnt: Server verarbeitet genau einmal selbst", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeStore(clock);
    db.beats.set("local", clock.now);
    const server = startServer(`http://127.0.0.1:${freePort()}`, db.store, clock);
    await server.feed(textUpdate("Rechner aus"));
    expect(server.fetches()).toBe(1);
    expect(server.seen.map(s => s.text)).toEqual(["Rechner aus"]);
  });

  test("401 (falsches Geheimnis), 403 (fremder Chat beim Rechner), 503 (Rechner fährt herunter): je genau einmal auf dem Server", async () => {
    // 401
    let pair = await healthyPair({ env: undefined });
    const wrongSecret = startServer(pair.peer.url, pair.db.store, pair.clock, { env: serverEnv(pair.peer.url, { GATEWAY_SECRET: "falsch-falsch-falsch" }) });
    await wrongSecret.feed(textUpdate("401"));
    expect(wrongSecret.fetches()).toBe(1);
    expect(wrongSecret.seen.map(s => s.text)).toEqual(["401"]);

    // 403: der Rechner gibt den Chat nicht frei, der Server schon
    pair = await healthyPair({ peer: { allow: chatId => chatId === OWNER } });
    await pair.server.feed(textUpdate("403", GROUP, 5));
    expect(pair.server.fetches()).toBe(1);
    expect(pair.server.seen.map(s => s.text)).toEqual(["403"]);
    expect(pair.peer.seen).toEqual([]);

    // 503: Herunterfahren begonnen; danach gilt der Rechner sofort als nicht gesund
    pair = await healthyPair();
    pair.peer.shutdown();
    await pair.server.feed(textUpdate("503"));
    await pair.server.feed(textUpdate("gleich danach"));
    expect(pair.server.fetches()).toBe(1);
    expect(pair.server.seen.map(s => s.text)).toEqual(["503", "gleich danach"]);
    expect(pair.peer.seen).toEqual([]);
  });

  test("429 (voll) mit Kenner des Rechners: Server verarbeitet selbst", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeStore(clock);
    db.beats.set("local", clock.now);
    const busy = (async () => new Response(null, { status: 429, headers: { [RELAY_HEADER]: "1" } })) as unknown as typeof fetch;
    const server = startServer("http://rechner.example", db.store, clock, { fetch: busy });
    await server.feed(textUpdate("voll"));
    expect(server.fetches()).toBe(1);
    expect(server.seen.map(s => s.text)).toEqual(["voll"]);
  });
});

describe("Unklarer Ausgang", () => {
  /** Reicht an den echten Rechner weiter und verliert die Antwort, die ersten n Male */
  const losingAnswers = (times: number): typeof fetch => {
    let lost = 0;
    return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = await fetch(input, init);
      if (lost < times) {
        lost++;
        throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
      }
      return response;
    }) as typeof fetch;
  };

  test("verlorene Annahmeantwort: Wiederholung ergibt duplicate, Rechner führt genau einmal aus, Server gar nicht", async () => {
    const { peer, server } = await healthyPair({ fetch: losingAnswers(1) });
    await server.feed(textUpdate("einmal bitte"));
    await waitFor(() => peer.seen.length > 0);
    await Bun.sleep(20);
    expect(server.fetches()).toBe(2);
    expect(peer.seen.map(s => s.text)).toEqual(["einmal bitte"]);
    expect(server.seen).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  test("bleibt unklar: keine Ausführung auf dem Server, Hinweis in denselben Chat und dasselbe Topic", async () => {
    const { peer, server } = await healthyPair({ fetch: losingAnswers(2) });
    await server.feed(textUpdate("verloren", GROUP, 77));
    await waitFor(() => peer.seen.length > 0);
    expect(server.fetches()).toBe(2);
    expect(server.seen).toEqual([]);
    expect(server.calls).toEqual([{ method: "sendMessage", payload: { chat_id: GROUP, text: UNCLEAR_MESSAGE_HINT, message_thread_id: 77 } }]);
    expect(peer.seen.map(s => s.text)).toEqual(["verloren"]);
  });

  test("nach unklarem ersten Versuch beweisen 503 oder Verbindungsfehler nichts: nie lokal ausführen", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeStore(clock);
    db.beats.set("local", clock.now);
    for (const second of [
      async () => new Response(null, { status: 503, headers: { [RELAY_HEADER]: "1" } }),
      async () => {
        throw Object.assign(new Error("Unable to connect"), { code: "ECONNREFUSED" });
      },
    ]) {
      let attempt = 0;
      const flaky = (async () => {
        attempt++;
        if (attempt === 1) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
        return second();
      }) as unknown as typeof fetch;
      const server = startServer("http://rechner.example", db.store, clock, { fetch: flaky });
      await server.feed(textUpdate("unklar"));
      expect(server.fetches()).toBe(2);
      expect(server.seen).toEqual([]);
      expect(server.calls.map(c => c.payload.text)).toEqual([UNCLEAR_MESSAGE_HINT]);
    }
  });

  test("Antwort eines Proxys ohne Kenner des Rechners (502, 503) gilt als unklar", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeStore(clock);
    db.beats.set("local", clock.now);
    const proxy = (async () => new Response("Bad Gateway", { status: 503 })) as unknown as typeof fetch;
    const server = startServer("http://rechner.example", db.store, clock, { fetch: proxy });
    await server.feed(textUpdate("Tunnel"));
    expect(server.fetches()).toBe(2);
    expect(server.seen).toEqual([]);
    expect(server.calls.map(c => c.payload.text)).toEqual([UNCLEAR_MESSAGE_HINT]);
  });
});

describe("/relay auf dem eigenen Rechner", () => {
  const post = (url: string, body: unknown, secret: string | null = SECRET) =>
    fetch(`${url}/relay`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret === null ? {} : { authorization: `Bearer ${secret}` }) },
      body: JSON.stringify(body),
    });

  test("ohne oder mit falschem Bearer 401, fremder Chat 403, jeweils mit Kenner und ohne Ausführung", async () => {
    const db = fakeStore({ now: 0 });
    const peer = await startPeer(db.store);
    const update = textUpdate("x");
    const none = await post(peer.url, { updateId: update.update_id, update }, null);
    const wrong = await post(peer.url, { updateId: update.update_id, update }, "falsch-falsch-falsch");
    const foreign = textUpdate("fremd", STRANGER_CHAT);
    const forbidden = await post(peer.url, { updateId: foreign.update_id, update: foreign });
    expect([none.status, wrong.status, forbidden.status]).toEqual([401, 401, 403]);
    expect([none, wrong, forbidden].map(r => r.headers.get(RELAY_HEADER))).toEqual(["1", "1", "1"]);
    await Bun.sleep(20);
    expect(peer.seen).toEqual([]);
  });

  test("doppelte updateId erreicht die Handler nicht erneut, auch gleichzeitig", async () => {
    const db = fakeStore({ now: 0 });
    const peer = await startPeer(db.store);
    const update = textUpdate("doppelt");
    const body = { updateId: update.update_id, update };
    const [a, b] = await Promise.all([post(peer.url, body), post(peer.url, body)]);
    const c = await post(peer.url, body);
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    expect(c.status).toBe(200);
    expect(await c.json()).toEqual({ duplicate: true });
    await waitFor(() => peer.seen.length > 0);
    await Bun.sleep(20);
    expect(peer.seen.map(s => s.updateId)).toEqual([update.update_id]);
  });

  test("über 100.000 Annahmen hinaus: eine verspätete, nie angenommene kleinere Kennung wird angenommen, nicht als doppelt verworfen", async () => {
    const taken: number[] = [];
    const handle = createRelayEndpoint({
      secret: () => SECRET,
      allowChat,
      closing: () => false,
      intake: () => async update => void taken.push(update.update_id),
      capacity: Number.POSITIVE_INFINITY,
    });
    const from = { id: Number(OWNER), is_bot: false, first_name: "Alex" };
    const chat = { id: Number(OWNER), type: "private", first_name: "Alex" };
    const request = (id: number) =>
      new Request("http://x/relay", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ updateId: id, update: { update_id: id, message: { message_id: id, date: 0, chat, from, text: "x" } } }),
      });
    // Klein genug, dass eine Untergrenze aus den ältesten 50 Kennungen sie fälschlich abdecken würde
    const LATE = 10;
    for (let id = 1; id <= 100_050; id++) {
      if (id === LATE) continue;
      expect((await handle(request(id))).status).toBe(202);
    }
    await waitFor(() => taken.length === 100_049);
    // Nie angenommen: wird jetzt angenommen und erreicht die Handler
    const late = await handle(request(LATE));
    expect(late.status).toBe(202);
    await waitFor(() => taken.includes(LATE));
    // Wirklich angenommene Kennungen bleiben doppelt, die älteste wie die verspätete
    expect((await handle(request(1))).status).toBe(200);
    expect((await handle(request(LATE))).status).toBe(200);
    expect(taken.filter(id => id === LATE || id === 1)).toEqual([1, LATE]);
  }, 60_000);

  test("abgelehnte Kennung (403) ist nicht angenommen: ein späterer Versuch wird angenommen", async () => {
    let allow = false;
    const handle = createRelayEndpoint({ secret: () => SECRET, allowChat: () => allow, closing: () => false, intake: () => async () => {} });
    const update = textUpdate("erst gesperrt");
    const request = () => new Request("http://x/relay", { method: "POST", headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ updateId: update.update_id, update }) });
    expect((await handle(request())).status).toBe(403);
    allow = true;
    expect((await handle(request())).status).toBe(202);
    expect((await handle(request())).status).toBe(200);
  });

  test("updateId muss zur update_id passen, sonst 400", async () => {
    const db = fakeStore({ now: 0 });
    const peer = await startPeer(db.store);
    const update = textUpdate("falsche Kennung");
    expect((await post(peer.url, { updateId: update.update_id + 1, update })).status).toBe(400);
    expect((await post(peer.url, { update })).status).toBe(400);
  });

  test("nach Beginn des Herunterfahrens und bei angefordertem Neustart 503", async () => {
    const db = fakeStore({ now: 0 });
    const restarting = await startPeer(db.store);
    restarting.closeIntake();
    const u1 = textUpdate("Neustart");
    expect((await post(restarting.url, { updateId: u1.update_id, update: u1 })).status).toBe(503);

    const stopping = await startPeer(db.store);
    stopping.shutdown();
    const u2 = textUpdate("Ende");
    const response = await post(stopping.url, { updateId: u2.update_id, update: u2 });
    expect(response.status).toBe(503);
    expect(response.headers.get(RELAY_HEADER)).toBe("1");
    await Bun.sleep(20);
    expect([...restarting.seen, ...stopping.seen]).toEqual([]);
  });

  test("429, wenn zu viele Updates gleichzeitig in die Handler gehen", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const handle = createRelayEndpoint({
      secret: () => SECRET,
      allowChat,
      closing: () => false,
      intake: () => () => gate,
      capacity: 1,
    });
    const request = (update: Update) =>
      new Request("http://x/relay", { method: "POST", headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ updateId: update.update_id, update }) });
    expect((await handle(request(textUpdate("eins")))).status).toBe(202);
    const full = await handle(request(textUpdate("zwei")));
    expect(full.status).toBe(429);
    expect(full.headers.get(RELAY_HEADER)).toBe("1");
    release();
  });

  test("Health-Server mit /relay nimmt Updates bis 1 MiB an (/process bleibt bei 64 KiB)", async () => {
    const db = fakeStore({ now: 0 });
    const peer = await startPeer(db.store);
    const big = textUpdate("x".repeat(200 * 1024));
    expect((await post(peer.url, { updateId: big.update_id, update: big })).status).toBe(202);
    const processResponse = await fetch(`${peer.url}/process`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ chatId: OWNER, text: "x".repeat(100 * 1024) }),
    });
    expect(processResponse.status).toBe(413);
  });
});

describe("Profil peer", () => {
  test("weder getUpdates noch deleteWebhook noch setWebhook, Anmeldung per getMe, Senden funktioniert", async () => {
    const db = fakeStore({ now: 0 });
    const peer = await startPeer(db.store);
    await peer.runtime.sendMessage(OWNER, "Hallo");
    const methods = peer.calls.map(c => c.method);
    expect(methods).toContain("getMe");
    expect(methods).toContain("sendMessage");
    for (const forbidden of ["getUpdates", "deleteWebhook", "setWebhook"]) expect(methods).not.toContain(forbidden);
    expect(peer.runtime.relayIntake()).not.toBeNull();
    peer.runtime.stop();
    expect(peer.runtime.relayIntake()).toBeNull();
  });

  test("Profil peer im Betriebsprofil: Eingang relay; ohne GATEWAY_SECRET oder Datenbank kein Eingang", () => {
    expect(resolveRuntimeProfile(PEER_ENV)).toEqual({ ok: true, profile: { name: "peer", telegram: { mode: "relay" } } });
    const noSecret = resolveRuntimeProfile({ ...PEER_ENV, GATEWAY_SECRET: " " });
    const noDb = resolveRuntimeProfile({ ...PEER_ENV, SUPABASE_URL: "" });
    expect(noSecret.ok || noDb.ok).toBe(false);
    if (!noSecret.ok) expect(noSecret.reason).toContain("GATEWAY_SECRET");
    if (!noDb.ok) expect(noDb.reason).toContain("Datenbank");
  });

  for (const [what, env] of [
    ["ohne GATEWAY_SECRET", { ...PEER_ENV, GATEWAY_SECRET: "" }],
    ["ohne Datenbank", { ...PEER_ENV, SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" }],
  ] as const) {
    test(`${what}: kein Eingang, kein Polling, kein /relay, kein Herzschlag`, async () => {
      const calls: ApiCall[] = [];
      const logs: string[] = [];
      const runtime = createTelegramRuntime({ env, createBot: token => fakeBot(token, calls, { botInfo: false }), log: line => logs.push(line) });
      const { timers, intervals } = fakeTimers();
      let storeTouched = false;
      const hybrid = startHybrid({
        env,
        runtime,
        isShuttingDown: () => false,
        store: () => ((storeTouched = true), fakeStore({ now: 0 }).store),
        timers,
        log: line => logs.push(line),
      });
      let ready = 0;
      await runtime.start(() => void ready++);
      cleanups.push(() => runtime.stop());
      expect(ready).toBe(1);
      expect(calls).toEqual([]);
      expect(runtime.relayIntake()).toBeNull();
      expect(hybrid.relayRoute).toBeNull();
      expect(intervals).toEqual([]);
      expect(storeTouched).toBe(false);
      expect(logs.some(l => l.includes("Profil peer: kein Telegram-Eingang"))).toBe(true);
    });
  }

  test("eigener Kennungsbereich: Rückfragen im Profil peer mit P und 11 Zeichen, Knopf unter 64 Byte", async () => {
    const db = fakeStore({ now: 0 });
    await startPeer(db.store);
    const choice = await createChoice({ kind: "ask", conversation: { type: "telegram", chatId: OWNER }, text: "Weiter?", options: [{ key: "weiter-machen-bitte", label: "Ja" }] });
    expect(choice.id).toMatch(/^P[A-Za-z0-9]{10}$/);
    const data = choiceCallbackData(choice.id, "weiter-machen-bitte");
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    expect(parseChoiceCallbackData(data)).toEqual({ id: choice.id, key: "weiter-machen-bitte" });
    useChoiceIdPrefix("");
    const own = await createChoice({ kind: "ask", conversation: { type: "telegram", chatId: OWNER }, text: "Server?", options: [{ key: "ja", label: "Ja" }] });
    expect(own.id).toMatch(/^[A-Za-z0-9]{10}$/);
  });
});

describe("Rückfragen über beide Rechner", () => {
  async function peerQuestion() {
    const pair = await healthyPair({ peer: { choices: true } });
    const choice = await createChoice({ kind: "ask", conversation: { type: "telegram", chatId: OWNER }, text: "Weiter?", options: [{ key: "ja", label: "Ja" }, { key: "nein", label: "Nein" }] });
    await attachChoiceTelegram(choice.id, [{ chatId: OWNER, messageId: 77 }]);
    const decided: string[] = [];
    cleanups.push(onChoiceChange(({ type, choice: c }) => void (type === "decided" && decided.push(`${c.id}:${c.result?.key}`))));
    return { ...pair, choice, decided };
  }

  test("Frage des Rechners, Klick beim Server: weitergeleitet und dort genau einmal entschieden", async () => {
    const { server, peer, choice, decided } = await peerQuestion();
    await server.feed(clickUpdate(choiceCallbackData(choice.id, "ja")));
    // Die Antwort auf den Klick kommt vom Rechner, erst nach der Entscheidung
    // und dem Nachziehen der Knöpfe. Darauf warten statt auf eine feste Pause.
    await waitFor(() => peer.calls.some(c => c.method === "answerCallbackQuery"));
    await Bun.sleep(20);
    expect(decided).toEqual([`${choice.id}:ja`]);
    expect(server.fetches()).toBe(1);
    expect(server.seen).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  test("Rechner nicht gesund: Frage bleibt offen, der Klick bekommt den Hinweis, kein Abgelaufen", async () => {
    const { server, choice, decided, clock } = await peerQuestion();
    clock.now += 120_000;
    await server.feed(clickUpdate(choiceCallbackData(choice.id, "ja")));
    expect(server.fetches()).toBe(0);
    expect(server.seen).toEqual([]);
    expect(server.calls.map(c => [c.method, c.payload.text])).toEqual([["answerCallbackQuery", PEER_CHOICE_AWAY_HINT]]);
    expect(decided).toEqual([]);
  });

  test("Rechner lehnt ab (503): Hinweis statt Server-Handler, Frage bleibt offen", async () => {
    const { server, peer, choice, decided } = await peerQuestion();
    peer.shutdown();
    await server.feed(clickUpdate(choiceCallbackData(choice.id, "ja")));
    expect(server.fetches()).toBe(1);
    expect(server.seen).toEqual([]);
    expect(server.calls.map(c => [c.method, c.payload.text])).toEqual([["answerCallbackQuery", PEER_CHOICE_AWAY_HINT]]);
    expect(decided).toEqual([]);
  });

  test("Frage des Servers wird nie weitergeleitet", async () => {
    const own = new Set(["ServerFrage"]);
    const { server, peer } = await healthyPair({ ownsChoice: async id => own.has(id) });
    await server.feed(clickUpdate(choiceCallbackData("ServerFrage", "ja")));
    expect(server.fetches()).toBe(0);
    expect(server.seen.map(s => s.text)).toEqual(["ch|ServerFrage|ja"]);
    expect(peer.seen).toEqual([]);
  });

  test("andere Knöpfe gehen bei gesundem Rechner dorthin; unklarer Ausgang: Hinweis am Klick", async () => {
    const { server, peer } = await healthyPair();
    await server.feed(clickUpdate("rev|abc|ok"));
    await waitFor(() => peer.seen.length > 0);
    expect(peer.seen.map(s => s.text)).toEqual(["rev|abc|ok"]);
    expect(server.seen).toEqual([]);

    const clock = { now: 1_000_000 };
    const db = fakeStore(clock);
    db.beats.set("local", clock.now);
    const lost = (async () => {
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    const unclear = startServer("http://rechner.example", db.store, clock, { fetch: lost });
    await unclear.feed(clickUpdate("rev|abc|ok"));
    expect(unclear.seen).toEqual([]);
    expect(unclear.calls.map(c => [c.method, c.payload.text])).toEqual([["answerCallbackQuery", UNCLEAR_CALLBACK_HINT]]);
  });
});

describe("Fremde Absender", () => {
  test("fremde Nachricht im freigegebenen Gruppenchat: keine Weiterleitung, kein Hinweis, Server-Kanal entscheidet wie bisher", async () => {
    const { server, peer } = await healthyPair();
    await server.feed(textUpdate("Hallo Bot", GROUP, 7, STRANGER));
    await server.feed(textUpdate("im Direktchat", STRANGER, undefined, STRANGER));
    await Bun.sleep(20);
    expect(server.fetches()).toBe(0);
    expect(server.calls).toEqual([]);
    expect(peer.seen).toEqual([]);
    // Fällt in die eigenen Handler; dort verwirft die Besitzerprüfung des Kanals still
    expect(server.seen.map(s => s.text)).toEqual(["Hallo Bot", "im Direktchat"]);
  });

  test("fremde Nachricht bei unklarem Ausgang: nie ein Hinweis, weil gar nicht erst weitergeleitet", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeStore(clock);
    db.beats.set("local", clock.now);
    const lost = (async () => {
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    const server = startServer("http://rechner.example", db.store, clock, { fetch: lost });
    await server.feed(textUpdate("fremd", GROUP, 7, STRANGER));
    expect(server.fetches()).toBe(0);
    expect(server.calls).toEqual([]);
    expect(db.state.reads).toBe(0);
  });

  test("fremder Klick auf eine Frage des Rechners: keine Registerabfrage, keine Weiterleitung, kein Hinweis am Klick", async () => {
    let lookups = 0;
    const ownsChoice = async () => (lookups++, false);
    // Rechner gesund
    const healthy = await healthyPair({ ownsChoice });
    await healthy.server.feed(clickUpdate(choiceCallbackData("PFrageAbc12", "ja"), 77, GROUP, STRANGER));
    await healthy.server.feed(clickUpdate("rev|abc|ok", 77, GROUP, STRANGER));
    // Rechner nicht gesund: der Besitzer bekäme hier PEER_CHOICE_AWAY_HINT
    healthy.clock.now += 120_000;
    await healthy.server.feed(clickUpdate(choiceCallbackData("PFrageAbc12", "ja"), 77, GROUP, STRANGER));
    await Bun.sleep(20);
    expect(lookups).toBe(0);
    expect(healthy.server.fetches()).toBe(0);
    expect(healthy.server.calls).toEqual([]);
    expect(healthy.peer.seen).toEqual([]);
    expect(healthy.peer.calls.filter(c => c.method === "answerCallbackQuery")).toEqual([]);
  });

  test("ohne TELEGRAM_USER_ID leitet die Middleware nichts weiter", async () => {
    let sent = 0;
    const middleware = createRelayMiddleware({
      peer: { healthy: async () => true, markDown: () => {} },
      client: { send: async () => (sent++, "delivered") },
      allowChat,
      owner: "",
      ownsChoice: async () => false,
    });
    let nextCalled = 0;
    await middleware({ update: textUpdate("x") } as unknown as Context, async () => void nextCalled++);
    expect(sent).toBe(0);
    expect(nextCalled).toBe(1);
  });
});

describe("Echter Kanal auf dem Rechner", () => {
  const CHILD = join(import.meta.dir, "hybrid-channel-child.ts");
  const TOPIC = 7;
  type Step = { name: string; fetches: number; serverHandled: number; serverCalls: unknown[]; events: string[]; peerCalls: { method: string; chat: unknown; thread?: unknown; text: unknown }[] };

  /** Server und Rechner im eigenen Prozess; config/topics.json ordnet das Topic dem Agenten research zu */
  function runChild(): Record<string, Step> {
    const dir = mkdtempSync(join(tmpdir(), "hybrid-channel-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "topics.json"), JSON.stringify({ [GROUP]: { [String(TOPIC)]: "research" } }));
    const result = Bun.spawnSync([process.execPath, CHILD, GROUP, String(TOPIC)], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir() },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    const steps: Record<string, Step> = {};
    for (const line of result.stdout.toString().trim().split("\n")) {
      if (!line.startsWith("{")) continue;
      const step = JSON.parse(line) as Step;
      steps[step.name] = step;
    }
    return steps;
  }

  let steps: Record<string, Step> | null = null;
  const stepOf = (name: string) => (steps ??= runChild())[name]!;
  const topicKey = sessionKeyFor(GROUP, TOPIC);
  const dmKey = sessionKeyFor(OWNER, null);

  for (const name of ["topic", "stop", "photo", "voice", "document", "edited"]) {
    test(`${name}: genau einmal weitergeleitet, der Server führt keinen eigenen Handler aus und sendet nichts`, () => {
      const step = stepOf(name);
      expect(step.fetches).toBe(1);
      expect(step.serverHandled).toBe(0);
      expect(step.serverCalls).toEqual([]);
    });
  }

  test("Topic mit zugeordnetem Agenten research: Turn mit research, Session-Schlüssel des Topics, Antwort im Topic", () => {
    const step = stepOf("topic");
    expect(step.events).toEqual([`turn:research:${GROUP}:${TOPIC}:Was gibt es Neues?`, `session:${topicKey}:research`, `afterTurn:${GROUP}:${TOPIC}`]);
    expect(step.peerCalls.map(c => ({ ...c, chat: String(c.chat) }))).toEqual([{ method: "sendMessage", chat: GROUP, thread: TOPIC, text: "Antwort von research" }]);
  });

  test("/stop im Topic: Befehl läuft auf dem Rechner mit dem Session-Schlüssel des Topics, Antwort im Topic", () => {
    const step = stepOf("stop");
    expect(step.events).toEqual([`stop:${topicKey}`]);
    expect(step.peerCalls.map(c => ({ ...c, chat: String(c.chat) }))).toEqual([{ method: "sendMessage", chat: GROUP, thread: TOPIC, text: "⏹️ 1 laufende Verarbeitung abgebrochen." }]);
  });

  test("Foto im Topic, Sprache und Dokument im Direktchat: Medien-Weg des Rechners mit dem richtigen Agenten", () => {
    expect(stepOf("photo").events).toEqual(["prepare:image", `turn:research:${GROUP}:${TOPIC}:image-Prompt`, `session:${topicKey}:research`, "cleanup"]);
    expect(stepOf("voice").events).toEqual(["prepare:audio", `turn:general:${OWNER}:-:audio-Prompt`, `session:${dmKey}:general`, "cleanup"]);
    expect(stepOf("document").events).toEqual(["prepare:document", `turn:general:${OWNER}:-:document-Prompt`, `session:${dmKey}:general`, "cleanup"]);
    expect(stepOf("photo").peerCalls.map(c => [String(c.chat), c.thread, c.text])).toEqual([[GROUP, TOPIC, "Antwort von research"]]);
  });

  test("edited_message: weitergeleitet, aber wie bisher nicht verarbeitet (kein Turn, keine Antwort)", () => {
    const step = stepOf("edited");
    expect(step.events).toEqual([]);
    expect(step.peerCalls).toEqual([]);
  });
});

describe("Beenden", () => {
  test("Server: nach stop() keine Status-Abfrage mehr, Updates bleiben beim Server", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeStore(clock);
    db.beats.set("local", clock.now);
    const server = startServer("http://127.0.0.1:1", db.store, clock);
    server.hybrid.stop();
    const reads = db.state.reads;
    clock.now += 60_000;
    await server.feed(textUpdate("nach stop"));
    expect(db.state.reads).toBe(reads);
    expect(server.fetches()).toBe(0);
  });

  test("Server: stop() während einer Weiterleitung bricht sie ab, ohne sie lokal auszuführen", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeStore(clock);
    db.beats.set("local", clock.now);
    const hanging = ((_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const server = startServer("http://rechner.example", db.store, clock, { fetch: hanging });
    const fed = server.feed(textUpdate("hängt"));
    await waitFor(() => server.fetches() === 1);
    server.hybrid.stop();
    await fed;
    expect(server.fetches()).toBe(1);
    expect(server.seen).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  test("Server: Statusabfrage läuft noch bei stop(), Ergebnis danach: kein Server-Handler, kein Versand", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeStore(clock);
    let finish: (status: { online: boolean; lastHeartbeat: string | null }) => void = () => {};
    const store: HeartbeatStore = {
      heartbeat: db.store.heartbeat,
      nodeStatus: () => (db.state.reads++, new Promise(resolve => (finish = resolve))),
    };
    const server = startServer("http://rechner.example", store, clock);
    const fed = server.feed(textUpdate("Abfrage offen"));
    await waitFor(() => db.state.reads === 1);
    server.hybrid.stop();
    // nicht gesund nach dem Stopp: früher fiel das Update in den eigenen Handler
    finish({ online: false, lastHeartbeat: null });
    await fed;
    expect(server.fetches()).toBe(0);
    expect(server.seen).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  test("Server: markierte 503 trifft ein, stop() vor der Fortsetzung: Ergebnis stopped, kein Server-Handler", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeStore(clock);
    db.beats.set("local", clock.now);
    const pending: ((response: Response) => void)[] = [];
    const controlled = (() => new Promise<Response>(resolve => pending.push(resolve))) as unknown as typeof fetch;
    const refusal = () => new Response(null, { status: 503, headers: { [RELAY_HEADER]: "1" } });

    const client = createRelayClient({ peerUrl: "http://rechner.example", secret: SECRET, fetch: controlled });
    const update = textUpdate("503 beim Stopp");
    const sent = client.send(update.update_id, update);
    await waitFor(() => pending.length === 1);
    pending[0](refusal());
    client.stop();
    expect(await sent).toBe("stopped");

    const server = startServer("http://rechner.example", db.store, clock, { fetch: controlled });
    const fed = server.feed(textUpdate("503 beim Stopp"));
    await waitFor(() => pending.length === 2);
    pending[1](refusal());
    server.hybrid.stop();
    await fed;
    expect(server.fetches()).toBe(1);
    expect(server.seen).toEqual([]);
    expect(server.calls).toEqual([]);
    expect(server.logs.some(line => line.includes("lehnt ab"))).toBe(false);
  });

  test("Rechner: nach stop() kein Herzschlag-Timer mehr, /relay antwortet 503", async () => {
    const clock = { now: 0 };
    const db = fakeStore(clock);
    const peer = await startPeer(db.store);
    await waitFor(() => db.state.writes === 1);
    peer.hybrid.stop();
    expect(peer.intervals.every(i => i.cleared)).toBe(true);
    peer.intervals[0].fn();
    await Bun.sleep(20);
    expect(db.state.writes).toBe(1);
    const update = textUpdate("nach stop");
    const response = await fetch(`${peer.url}/relay`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ updateId: update.update_id, update }),
    });
    expect(response.status).toBe(503);
  });
});

describe("Ohne Hybrid-Konfiguration", () => {
  for (const [what, env] of [
    ["Profil local", { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_USER_ID: OWNER, GATEWAY_SECRET: SECRET, ...DB }],
    ["Profil server", { ...serverEnv(""), HYBRID_PEER_URL: "" }],
  ] as const) {
    test(`${what}: keine Middleware, kein /relay, kein Herzschlag, kein Netz, keine Logzeile`, async () => {
      const calls: ApiCall[] = [];
      const bot = fakeBot(TOKEN, calls);
      let used = 0;
      const spyBot = { use: (...args: Parameters<Bot["use"]>) => (used++, bot.use(...args)) };
      const { timers, intervals } = fakeTimers();
      let storeTouched = false;
      let fetched = 0;
      const logs: string[] = [];
      const hybrid = startHybrid({
        env,
        runtime: { bot: spyBot, relayIntake: () => null },
        isShuttingDown: () => false,
        store: () => ((storeTouched = true), fakeStore({ now: 0 }).store),
        fetch: (async () => (fetched++, new Response())) as unknown as typeof fetch,
        timers,
        log: line => logs.push(line),
      });
      expect(hybrid.role).toBe("off");
      expect(hybrid.relayRoute).toBeNull();
      expect(used).toBe(0);
      expect(intervals).toEqual([]);
      expect(storeTouched).toBe(false);
      expect(fetched).toBe(0);
      expect(logs).toEqual([]);

      const health = startHealthServer({ port: 0, session: () => ({ sessionId: null, engine: null }), secret: () => SECRET, allowChat: () => true, process: async () => {}, relay: hybrid.relayRoute });
      cleanups.push(() => health.stop());
      const update = textUpdate("x");
      const response = await fetch(`http://127.0.0.1:${health.port}/relay`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ updateId: update.update_id, update }) });
      expect(response.status).toBe(404);
    });
  }

  test("HYBRID_PEER_URL ohne Datenbank oder Geheimnis: Hybrid aus mit einer Logzeile", () => {
    for (const [extra, reason] of [
      [{ SUPABASE_URL: "" }, "keine Datenbank"],
      [{ GATEWAY_SECRET: "" }, "GATEWAY_SECRET fehlt"],
      [{ HYBRID_PEER_URL: "ftp://rechner" }, "keine http- oder https-Adresse"],
    ] as const) {
      const logs: string[] = [];
      const bot = fakeBot(TOKEN, []);
      const hybrid = startHybrid({ env: serverEnv("http://rechner.example", extra), runtime: { bot, relayIntake: () => null }, isShuttingDown: () => false, log: line => logs.push(line) });
      expect(hybrid.role).toBe("off");
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain(reason);
    }
  });
});

describe("Weiterleitungs-Client", () => {
  test("Basisadresse mit und ohne Pfad: /relay am Health-Port", async () => {
    const urls: string[] = [];
    const record = (async (input: Parameters<typeof fetch>[0]) => {
      urls.push(String(input));
      return new Response(null, { status: 202, headers: { [RELAY_HEADER]: "1" } });
    }) as unknown as typeof fetch;
    for (const peerUrl of ["http://100.64.0.2:3000", "https://rechner.example/"]) {
      const update = textUpdate("x");
      expect(await createRelayClient({ peerUrl, secret: SECRET, fetch: record }).send(update.update_id, update)).toBe("delivered");
    }
    expect(urls).toEqual(["http://100.64.0.2:3000/relay", "https://rechner.example/relay"]);
  });

  test("Middleware lässt bei Lesefehler im eigenen Register den eigenen Handler antworten", async () => {
    let sent = 0;
    const middleware = createRelayMiddleware({
      peer: { healthy: async () => true, markDown: () => {} },
      client: { send: async () => (sent++, "delivered") },
      allowChat,
      owner: OWNER,
      ownsChoice: async () => {
        throw new Error("Datei kaputt");
      },
    });
    let nextCalled = 0;
    await middleware({ update: clickUpdate("ch|Abc|ja") } as unknown as Context, async () => void nextCalled++);
    expect(sent).toBe(0);
    expect(nextCalled).toBe(1);
  });
});
