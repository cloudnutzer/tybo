/**
 * Issue #250, Checkbox 2: GET /api/conversations/<id>/speech, die
 * Beschäftigt-Abfrage des Sprechmodus. Echter Web-Server, echter ChatHub,
 * echte Chat-Wege und echte Telegram-Quelle; Erkennung, Chat-Kern und
 * Telegram sind Attrappen. Geprüft: busy bei eigenem Turn, bei einem Turn
 * aus Telegram (isBusy, auch über den echten Ausführungsschlüssel) und bei
 * laufender Erkennung, danach wieder false; die Abfrage reserviert nichts;
 * 401, 404, 409 closed, 503.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { TurnOptions } from "../src/lib/chat-turn";
import { abortExecutions, runCancelable } from "../src/lib/execution-context";
import type { HistoryRow } from "../src/lib/store/types";
import type { TopicStateEntry } from "../src/lib/topic-state";
import { createBotSpeech } from "../src/web/bot-speech";
import { createTelegramSource } from "../src/web/bot-telegram";
import { createBotChat } from "../src/web/bot-turn";
import { createWebServer, type WebServer, type WebServerDeps } from "../src/web/server";
import type { SpeechPort, SpeechRecognition } from "../src/web/speech";
import { ConversationStore } from "../src/web/store";
import { UploadStore } from "../src/web/uploads";
import { CLOSED_TOPIC, fakeTelegramChat, GROUP, makeRoot, PASSWORD, TOPIC, USER, waitUntil } from "./attachments-fixture";
import { wavSilence } from "./speech-fixture";

const root = await makeRoot("web-speech-busy-");
afterAll(() => root.cleanup());
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => (release = resolve));
  return { promise, release };
}

function fakeSpeech() {
  const state = {
    calls: 0,
    gate: undefined as Promise<void> | undefined,
    busy: false,
    busyChecks: [] as string[],
    reserved: 0,
  };
  const port: SpeechPort = {
    async recognize(): Promise<SpeechRecognition> {
      state.calls++;
      if (state.gate) await state.gate;
      return { ok: true, text: "Wie wird das Wetter morgen?", provider: "attrappe" };
    },
    synthesize: async () => ({ ok: false, reason: "browser" }),
    isBusy(id) {
      state.busyChecks.push(id);
      return state.busy;
    },
  };
  return { state, port };
}

async function start(options: { speech?: { port: SpeechPort } | null; chat?: boolean; deps?: Partial<WebServerDeps> } = {}) {
  const dir = root.next();
  const uploads = new UploadStore({ dir: join(dir, "uploads"), log: () => {} });
  const rows: HistoryRow[] = [];
  const store = new ConversationStore({ dir: join(dir, "web") });
  await store.load();
  const conversation = await store.createConversation("general");
  const web = { turns: [] as TurnOptions[], core: async (_o: TurnOptions) => "Morgen wird es sonnig." };
  const chat = createBotChat({
    runStreamingTurn: o => {
      web.turns.push(o);
      return web.core(o);
    },
    saveMessage: async () => true,
    processIntents: async () => {},
    abortEngineCalls: key => abortExecutions(key),
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    log: () => {},
  });
  const tg = fakeTelegramChat(join(dir, "media"));
  const telegram = createTelegramSource({
    userId: USER,
    groupId: () => GROUP,
    topicNames: async () => ({ "443": "Finanzen", "444": "Alt" }),
    topicMapping: () => ({ "443": "finance" }),
    history: async (chatId, topicId) => rows.filter(r => (r as any).chat_id === chatId && ((r.metadata as any)?.topicId ?? null) === topicId),
    activity: async () => [],
    topicState: async () => new Map<number, TopicStateEntry>([[444, { closed: true }]]),
    log: () => {},
  });
  const speech = options.speech === undefined ? fakeSpeech() : options.speech;
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    {
      sessionFile: join(dir, "web-sessions.json"),
      conversationStore: store,
      telegram,
      ...(options.chat === false ? {} : { chat, telegramChat: tg.factory(rows, uploads) }),
      uploads,
      ...(speech ? { speech: speech.port } : {}),
      log: () => {},
      ...options.deps,
    }
  );
  servers.push(server);
  const origin = server.url;
  const login = await fetch(`${origin}/api/login`, { method: "POST", headers: { origin }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const get = (id: string, headers: Record<string, string> = { cookie }) => fetch(`${origin}/api/conversations/${id}/speech`, { headers });
  return {
    origin,
    cookie,
    webId: conversation.id,
    web,
    telegram: tg.rec,
    state: speech && "state" in speech ? (speech as ReturnType<typeof fakeSpeech>).state : fakeSpeech().state,
    get,
    async busy(id: string): Promise<boolean> {
      const res = await get(id);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Object.keys(body)).toEqual(["busy"]);
      return body.busy;
    },
    say: (id: string) =>
      fetch(`${origin}/api/conversations/${id}/speech`, { method: "POST", headers: { origin, cookie, "content-type": "audio/wav" }, body: WAV }),
    type: (id: string, text: string) =>
      fetch(`${origin}/api/conversations/${id}/messages`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ text }) }),
  };
}

const WAV = wavSilence(1.2);

describe("GET /api/conversations/<id>/speech", () => {
  test("frei: busy false im Web-Gespräch, im Topic und im Direktchat, ohne Origin-Kopfzeile", async () => {
    const ctx = await start();
    expect(await ctx.busy(ctx.webId)).toBe(false);
    expect(await ctx.busy(TOPIC)).toBe(false);
    expect(await ctx.busy("dm")).toBe(false);
    // Nur lesend: nichts erkannt, kein Turn
    expect(ctx.state.calls).toBe(0);
    expect(ctx.web.turns).toEqual([]);
  });

  test("eigener Turn (getippt): busy, danach wieder frei", async () => {
    const ctx = await start();
    const hold = gate();
    ctx.web.core = async () => {
      await hold.promise;
      return "Antwort";
    };
    expect((await ctx.type(ctx.webId, "getippt")).status).toBe(202);
    await waitUntil(() => ctx.web.turns.length === 1);
    expect(await ctx.busy(ctx.webId)).toBe(true);
    // Ein anderes Gespräch bleibt frei
    expect(await ctx.busy(TOPIC)).toBe(false);
    hold.release();
    const end = Date.now() + 2000;
    while (await ctx.busy(ctx.webId)) {
      if (Date.now() > end) throw new Error("bleibt beschäftigt");
      await Bun.sleep(5);
    }
    expect(await ctx.busy(ctx.webId)).toBe(false);
  });

  test("Turn aus Telegram (isBusy): busy, danach wieder frei", async () => {
    const speech = fakeSpeech();
    const ctx = await start({ speech });
    speech.state.busy = true;
    expect(await ctx.busy(TOPIC)).toBe(true);
    expect(speech.state.busyChecks).toEqual([TOPIC]);
    speech.state.busy = false;
    expect(await ctx.busy(TOPIC)).toBe(false);
  });

  test("Turn aus Telegram über den echten Ausführungsschlüssel (createBotSpeech): busy, danach frei", async () => {
    const bot = createBotSpeech({ userId: USER, groupId: () => GROUP, agentForTopic: () => undefined });
    const fake = fakeSpeech();
    const ctx = await start({ speech: { port: { ...fake.port, isBusy: id => bot.isBusy!(id), reserve: (id, agent) => bot.reserve!(id, agent) } } });
    expect(await ctx.busy(TOPIC)).toBe(false);
    const hold = gate();
    // Wie ein Telegram-Update in src/bot.ts: runCancelable unter dem Schlüssel des Topics
    const running = runCancelable(`topic:${GROUP}:443`, () => hold.promise);
    expect(await ctx.busy(TOPIC)).toBe(true);
    expect(await ctx.busy("dm")).toBe(false);
    hold.release();
    await running;
    expect(await ctx.busy(TOPIC)).toBe(false);
  });

  test("laufende Erkennung: busy, dann der Sprech-Turn: busy, danach wieder frei", async () => {
    const speech = fakeSpeech();
    const stt = gate();
    speech.state.gate = stt.promise;
    const ctx = await start({ speech });
    const turn = gate();
    ctx.web.core = async () => {
      await turn.promise;
      return "Antwort";
    };
    const spoken = ctx.say(ctx.webId);
    await waitUntil(() => speech.state.calls === 1);
    // Die Äußerung liegt in der Erkennung: kein Turn, aber beschäftigt
    expect(ctx.web.turns).toEqual([]);
    expect(await ctx.busy(ctx.webId)).toBe(true);
    stt.release();
    expect((await spoken).status).toBe(202);
    expect(await ctx.busy(ctx.webId)).toBe(true);
    turn.release();
    const end = Date.now() + 2000;
    while (await ctx.busy(ctx.webId)) {
      if (Date.now() > end) throw new Error("bleibt beschäftigt");
      await Bun.sleep(5);
    }
  });

  test("die Abfrage reserviert nichts: nach vielen Abfragen geht eine Äußerung durch", async () => {
    const ctx = await start();
    for (let i = 0; i < 5; i++) expect(await ctx.busy(ctx.webId)).toBe(false);
    expect((await ctx.say(ctx.webId)).status).toBe(202);
    await waitUntil(() => ctx.web.turns.length === 1);
    expect(ctx.state.calls).toBe(1);
  });

  test("401 ohne Anmeldung, 404 unbekannt, 409 closed im geschlossenen Topic", async () => {
    const ctx = await start();
    const anonymous = await ctx.get(ctx.webId, {});
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "Nicht angemeldet" });
    expect((await ctx.get("0b3c6a2e-1f00-4c1a-9d0e-2a4b6c8d0e1f")).status).toBe(404);
    expect((await ctx.get("topic-999")).status).toBe(404);
    const closed = await ctx.get(CLOSED_TOPIC);
    expect(closed.status).toBe(409);
    const body = await closed.json();
    expect(body.closed).toBe(true);
    // Geschlossen ist nicht beschäftigt: kein reason, kein busy
    expect(body.reason).toBeUndefined();
    expect(body.busy).toBeUndefined();
    expect(ctx.state.busyChecks).toEqual([]);
  });

  test("503 ohne eingerichteten Sprechmodus und ohne Chat", async () => {
    const none = await start({ speech: null });
    expect((await none.get(none.webId)).status).toBe(503);
    expect((await none.get("topic-999")).status).toBe(503);
    const noChat = await start({ chat: false });
    expect((await noChat.get(noChat.webId)).status).toBe(503);
  });

  test("andere Methoden: 405 mit Allow GET, POST", async () => {
    const ctx = await start();
    const res = await fetch(`${ctx.origin}/api/conversations/${ctx.webId}/speech`, { method: "DELETE", headers: { origin: ctx.origin, cookie: ctx.cookie } });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST");
  });
});
