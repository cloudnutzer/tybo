/**
 * Issue #260, Checkbox 1: Telefongespräch im Verlauf. Äußerung und
 * gesprochene Antwort landen sofort im gewählten Gespräch und nirgends sonst,
 * beim Auflegen eine Meldung; nichts geht nach Telegram, kein Push; ein
 * laufender Denkauftrag hält die Ablage auf, die Uhrzeiten bleiben.
 * Attrappen für Erkenner, Gehirn, Stimme, Gedächtnis und Telegram; kein
 * echtes Modell, kein sherpa-onnx, keine Stimme, kein Telegram.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CALL_CHANNEL, callTarget, createCallMemory } from "../src/web/bot-call";
import type { WebSavedMessage } from "../src/web/bot-turn";
import { toTelegramApiMessage } from "../src/web/bot-telegram";
import { CALL_PATH, type CallTurnEvent } from "../src/web/call";
import { callEndedText, callReplyText, createCallHistory, type CallHistoryPort, type CallHistoryTurn, type CallMemoryEntry, type CallMemoryPort } from "../src/web/call-history";
import { CallSession } from "../src/web/call-session";
import { CALL_SOURCE, toApiMessage, type RunTurnOptions, type TurnResult, type WebChat } from "../src/web/chat";
import { createPushNotifier } from "../src/web/push-triggers";
import { createWebServer, type WebServer } from "../src/web/server";
import { ConversationStore, type StoredMessage } from "../src/web/store";
import type { VoicePort } from "../src/web/voice";
import { fakeClock, fakeLine, fakePort, fakeSocket, flush, gate, pcmFrame, type FakeLineOptions } from "./call-fixture";

const dirs: string[] = [];
const servers: WebServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map(s => s.stop()));
  for (const d of dirs) await rm(d, { recursive: true, force: true });
}, 30_000);

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), "tybo-call-history-"));
  dirs.push(dir);
  const store = new ConversationStore({ dir: join(dir, "web") });
  await store.load();
  return { dir, store };
}

/** Gedächtnis-Attrappe: was über saveMessage ins gemeinsame Gedächtnis ginge */
function fakeMemory() {
  const saved: Array<{ conversationId: string; entry: CallMemoryEntry }> = [];
  const notices: Array<{ conversationId: string; text: string; at: string }> = [];
  const memory: CallMemoryPort = {
    save: async (conversationId, entry) => {
      saved.push({ conversationId, entry });
      return true;
    },
    notice: async (conversationId, o) => {
      notices.push({ conversationId, ...o });
      return true;
    },
  };
  return { memory, saved, notices };
}

function turnAt(o: Partial<CallHistoryTurn> & { conversationId: string }): CallHistoryTurn {
  return {
    agent: "general",
    model: "claude-sonnet-5-5",
    userText: "Wie wird das Wetter?",
    userAt: "2026-10-02T09:00:00.000Z",
    spokenText: "Sonnig und mild.",
    interrupted: false,
    replyAt: "2026-10-02T09:00:02.000Z",
    ...o,
  };
}

describe("Texte", () => {
  test("Dauer und unterbrochene Antwort", () => {
    expect(callEndedText(240)).toBe("Telefongespräch, 4 Min.");
    expect(callEndedText(45)).toBe("Telefongespräch, 45 Sek.");
    expect(callEndedText(89)).toBe("Telefongespräch, 1 Min.");
    expect(callReplyText("Erster Satz.", true)).toBe("Erster Satz. (unterbrochen)");
    expect(callReplyText("  ", true)).toBe("");
    expect(callReplyText("Fertig.", false)).toBe("Fertig.");
  });
});

describe("Ablage (createCallHistory)", () => {
  async function webWorld(o: { idle?: () => Promise<void> } = {}) {
    const { store } = await tempStore();
    const conversation = await store.createConversation("general");
    const other = await store.createConversation("research");
    const m = fakeMemory();
    const published: Array<{ id: string; message: StoredMessage }> = [];
    const history = createCallHistory({
      isWeb: () => true,
      whenIdle: o.idle ?? (async () => {}),
      append: (id, msg) => store.appendMessage(id, msg),
      publish: (id, message) => published.push({ id, message }),
      memory: m.memory,
      log: () => {},
    });
    return { store, conversation, other, history, published, ...m };
  }

  test("Web-Gespräch: zwei Turns ergeben vier Nachrichten und eine Meldung, in Reihenfolge, nur dort", async () => {
    const w = await webWorld();
    w.history.turn(turnAt({ conversationId: w.conversation.id }));
    w.history.turn(
      turnAt({ conversationId: w.conversation.id, userText: "Und morgen?", userAt: "2026-10-02T09:00:10.000Z", spokenText: "Regen.", replyAt: "2026-10-02T09:00:12.000Z" })
    );
    w.history.ended({ conversationId: w.conversation.id, seconds: 240, at: "2026-10-02T09:04:00.000Z" });
    await w.history.idle();
    const messages = await w.store.getMessages(w.conversation.id);
    expect(messages.map(m => [m.role, m.text, m.kind ?? null, m.source ?? null])).toEqual([
      ["user", "Wie wird das Wetter?", null, null],
      ["assistant", "Sonnig und mild.", null, null],
      ["user", "Und morgen?", null, null],
      ["assistant", "Regen.", null, null],
      ["assistant", "Telefongespräch, 4 Min.", "notice", "telefonhoerer"],
    ]);
    // Herkunft dauerhaft markiert, Uhrzeit wie gesagt, Modell an der Antwort
    expect(messages.slice(0, 4).every(m => m.call === true)).toBe(true);
    expect(messages.map(m => m.createdAt)).toEqual([
      "2026-10-02T09:00:00.000Z",
      "2026-10-02T09:00:02.000Z",
      "2026-10-02T09:00:10.000Z",
      "2026-10-02T09:00:12.000Z",
      "2026-10-02T09:04:00.000Z",
    ]);
    expect(messages[1]).toMatchObject({ agent: "general", model: "claude-sonnet-5-5" });
    // Live an offene Seiten, nur in diesem Gespräch
    expect(w.published.map(p => p.id)).toEqual(Array(5).fill(w.conversation.id));
    expect(await w.store.getMessages(w.other.id)).toEqual([]);
    // Zusätzlich ins gemeinsame Gedächtnis (Suche), die Meldung nicht
    expect(w.saved.map(s => [s.conversationId, s.entry.role, s.entry.text, s.entry.at])).toEqual([
      [w.conversation.id, "user", "Wie wird das Wetter?", "2026-10-02T09:00:00.000Z"],
      [w.conversation.id, "assistant", "Sonnig und mild.", "2026-10-02T09:00:02.000Z"],
      [w.conversation.id, "user", "Und morgen?", "2026-10-02T09:00:10.000Z"],
      [w.conversation.id, "assistant", "Regen.", "2026-10-02T09:00:12.000Z"],
    ]);
    expect(w.notices).toEqual([]);
  });

  test("API-Format und Nachladen: source call an Äußerung und Antwort, Modell bleibt", async () => {
    const w = await webWorld();
    w.history.turn(turnAt({ conversationId: w.conversation.id }));
    await w.history.idle();
    const api = (await w.store.getMessages(w.conversation.id)).map(toApiMessage);
    expect(api[0]).toMatchObject({ role: "user", source: CALL_SOURCE, text: "Wie wird das Wetter?" });
    expect(api[1]).toMatchObject({ role: "assistant", source: CALL_SOURCE, model: "claude-sonnet-5-5", agent: "general" });
    expect(api[0]).not.toHaveProperty("call");
  });

  test("unterbrochene Antwort trägt den Zusatz und nur Gesprochenes, ohne Gesprochenes keine Antwort", async () => {
    const w = await webWorld();
    w.history.turn(turnAt({ conversationId: w.conversation.id, spokenText: "Das Wetter wird", interrupted: true }));
    w.history.turn(turnAt({ conversationId: w.conversation.id, userText: "Halt.", spokenText: "", interrupted: true }));
    await w.history.idle();
    expect((await w.store.getMessages(w.conversation.id)).map(m => [m.role, m.text])).toEqual([
      ["user", "Wie wird das Wetter?"],
      ["assistant", "Das Wetter wird (unterbrochen)"],
      ["user", "Halt."],
    ]);
  });

  test("laufender Denkauftrag: Ablage danach, mit der Uhrzeit, zu der gesprochen wurde", async () => {
    const busy = gate();
    let running = true;
    const w = await webWorld({ idle: () => (running ? busy.promise : Promise.resolve()) });
    w.history.turn(turnAt({ conversationId: w.conversation.id }));
    await flush();
    expect(await w.store.getMessages(w.conversation.id)).toEqual([]);
    // Der Denkauftrag legt seine Nachrichten ab, dann endet er
    await w.store.appendMessage(w.conversation.id, { role: "user", text: "Denkauftrag aus dem Telefongespräch: X" });
    await w.store.appendMessage(w.conversation.id, { role: "assistant", text: "Ausgearbeitet." });
    running = false;
    busy.open();
    await w.history.idle();
    const messages = await w.store.getMessages(w.conversation.id);
    expect(messages.map(m => m.text)).toEqual(["Denkauftrag aus dem Telefongespräch: X", "Ausgearbeitet.", "Wie wird das Wetter?", "Sonnig und mild."]);
    expect(messages[2]!.createdAt).toBe("2026-10-02T09:00:00.000Z");
    expect(messages[3]!.createdAt).toBe("2026-10-02T09:00:02.000Z");
  });

  test("Telegram-Gespräch: nur ins Gedächtnis (Live-Feed zeigt es), Meldung als Nur-Anzeige-Eintrag", async () => {
    const m = fakeMemory();
    const appended: unknown[] = [];
    const history = createCallHistory({
      isWeb: () => false,
      whenIdle: async () => {},
      append: async (id, msg) => {
        appended.push([id, msg]);
        throw new Error("darf nicht passieren");
      },
      publish: () => appended.push("publish"),
      memory: m.memory,
      log: () => {},
    });
    history.turn(turnAt({ conversationId: "topic-7" }));
    history.turn(turnAt({ conversationId: "topic-7", userText: "Danke.", spokenText: "Gern." }));
    history.ended({ conversationId: "topic-7", seconds: 61, at: "2026-10-02T09:01:01.000Z" });
    await history.idle();
    expect(appended).toEqual([]);
    expect(m.saved.map(s => [s.conversationId, s.entry.role, s.entry.text])).toEqual([
      ["topic-7", "user", "Wie wird das Wetter?"],
      ["topic-7", "assistant", "Sonnig und mild."],
      ["topic-7", "user", "Danke."],
      ["topic-7", "assistant", "Gern."],
    ]);
    expect(m.notices).toEqual([{ conversationId: "topic-7", text: "Telefongespräch, 1 Min.", at: "2026-10-02T09:01:01.000Z" }]);
  });
});

describe("Gedächtnis (createCallMemory)", () => {
  const deps = { userId: "4242", groupId: () => "-1001234567890", agentForTopic: () => "research" };

  test("Web, Direktchat, General und Topic: richtige Chat-ID, Topic, Markierung, created_at", async () => {
    const rows: WebSavedMessage[] = [];
    const memory = createCallMemory({ ...deps, saveMessage: async m => void rows.push(m) || true });
    const entry: CallMemoryEntry = { role: "assistant", text: "Gern.", at: "2026-10-02T09:00:02.000Z", agent: "research", model: "claude-sonnet-5-5" };
    const web = "0b3c6a2e-1f00-4c1a-9d0e-2a4b6c8d0e1f";
    await memory.save(web, entry);
    await memory.save("dm", { ...entry, role: "user", model: "x" });
    await memory.save("topic-1", entry);
    await memory.save("topic-7", entry);
    expect(rows).toEqual([
      { chat_id: `web:${web}`, role: "assistant", content: "Gern.", created_at: entry.at, metadata: { type: "voice_call", channel: CALL_CHANNEL, call: true, agent: "research", model: "claude-sonnet-5-5" } },
      { chat_id: "4242", role: "user", content: "Gern.", created_at: entry.at, metadata: { topicId: null, type: "voice_call", channel: CALL_CHANNEL, call: true, agent: "research" } },
      { chat_id: "-1001234567890", role: "assistant", content: "Gern.", created_at: entry.at, metadata: { topicId: null, type: "voice_call", channel: CALL_CHANNEL, call: true, agent: "research", model: "claude-sonnet-5-5" } },
      { chat_id: "-1001234567890", role: "assistant", content: "Gern.", created_at: entry.at, metadata: { topicId: 7, type: "voice_call", channel: CALL_CHANNEL, call: true, agent: "research", model: "claude-sonnet-5-5" } },
    ]);
    // Jede Zeile als Telefongespräch gekennzeichnet (Web, Direktchat, General, Topic)
    expect(rows.map(r => r.metadata?.type)).toEqual(["voice_call", "voice_call", "voice_call", "voice_call"]);
    // Nie display_only: die Suche soll sie finden
    expect(rows.some(r => r.metadata?.display_only)).toBe(false);
  });

  test("Meldung als Nur-Anzeige-Eintrag mit Quelle telefonhoerer; unerreichbares Telegram-Gespräch: nichts", async () => {
    const rows: WebSavedMessage[] = [];
    const memory = createCallMemory({ ...deps, saveMessage: async m => void rows.push(m) || true });
    expect(await memory.notice("topic-7", { text: "Telefongespräch, 4 Min.", at: "2026-10-02T09:04:00.000Z" })).toBe(true);
    expect(rows[0]).toEqual({
      chat_id: "-1001234567890",
      role: "assistant",
      content: "Telefongespräch, 4 Min.",
      created_at: "2026-10-02T09:04:00.000Z",
      metadata: { display_only: true, source: "telefonhoerer", topicId: 7 },
    });
    const none = createCallMemory({ userId: "", groupId: () => null, agentForTopic: () => "x", saveMessage: async m => void rows.push(m) || true });
    expect(await none.save("dm", { role: "user", text: "x", at: "2026-10-02T09:00:00.000Z", agent: "general" })).toBe(false);
    expect(rows).toHaveLength(1);
    expect(callTarget("topic-7", { userId: "", groupId: () => null, agentForTopic: () => "x" })).toBeNull();
  });

  test("Nachladen aus dem Nachrichtenspeicher: Telegram-Zeilen mit metadata.call tragen source call", () => {
    const user = toTelegramApiMessage({ id: 1, created_at: "2026-10-02T09:00:00.000Z", role: "user", content: "Hallo", metadata: { call: true, channel: "call", msgId: crypto.randomUUID() } });
    const reply = toTelegramApiMessage({ id: 2, created_at: "2026-10-02T09:00:02.000Z", role: "assistant", content: "Hi", metadata: { call: true, channel: "call", agent: "research", model: "claude-sonnet-5-5", msgId: crypto.randomUUID() } });
    expect(user).toMatchObject({ role: "user", source: CALL_SOURCE });
    expect(reply).toMatchObject({ role: "assistant", source: CALL_SOURCE, model: "claude-sonnet-5-5", agent: "research" });
  });
});

describe("Push", () => {
  test("Meldungen des Telefonhörers (Ende, gemerkt) pushen nicht, auch ohne sichtbaren Browser", async () => {
    const sent: unknown[] = [];
    const notifier = createPushNotifier({
      devices: () => [{ id: "d1", label: "Handy", settings: { replies: true, choices: true, notices: true } } as never],
      send: async (...a) => {
        sent.push(a);
        return { ok: true } as never;
      },
      isVisible: () => false,
      title: async () => "Gespräch",
      log: () => {},
    });
    await notifier.notice({ conversationId: "dm", text: "Telefongespräch, 4 Min.", source: "telefonhoerer" });
    await notifier.notice({ conversationId: "dm", text: "Aus dem Telefonat: …", source: "telefonhoerer" });
    expect(sent).toEqual([]);
    // Gegenprobe: eine andere Meldung pusht
    await notifier.notice({ conversationId: "dm", text: "Job fertig", source: "job" });
    expect(sent).toHaveLength(1);
  });
});

describe("Sitzung meldet Turns und Ende an den Verlauf", () => {
  function setup(line: FakeLineOptions = {}) {
    const clock = fakeClock(Date.parse("2026-10-02T09:00:00.000Z"));
    const s = fakeSocket();
    const port = fakePort({ line: () => fakeLine({ speak: null, ...line }) });
    const turns: CallHistoryTurn[] = [];
    const ends: Array<{ conversationId: string; seconds: number }> = [];
    const history: CallHistoryPort = {
      turn: t => turns.push(t),
      ended: e => ends.push({ conversationId: e.conversationId, seconds: e.seconds }),
      idle: async () => {},
    };
    const session = new CallSession({
      socket: s.socket,
      port: port.port,
      checkConversation: async () => ({ ok: true, agent: "research" }),
      clock,
      log: () => {},
      onEnd: () => {},
      history,
    });
    session.begin();
    const send = (msg: Record<string, unknown>) => session.receive(JSON.stringify(msg));
    const utter = async () => {
      for (let i = 0; i < 25; i++) session.receive(pcmFrame());
      await flush();
      send({ type: "utterance_end" });
      await flush();
    };
    const playAll = () => {
      for (const m of s.json("sentence")) send({ type: "played", id: m.id });
    };
    return { clock, s, session, send, utter, playAll, turns, ends };
  }

  test("zwei Turns, Auflegen: zwei Turn-Einträge mit Modell und Agent, dann das Ende mit Dauer", async () => {
    const t = setup();
    t.send({ type: "start", conversationId: "abc", tts: "browser" });
    await flush();
    await t.utter();
    t.playAll();
    await t.clock.advance(5_000);
    await t.utter();
    t.playAll();
    await t.clock.advance(55_000);
    t.send({ type: "hangup" });
    await flush();
    expect(t.turns.map(x => [x.conversationId, x.agent, x.model, x.userText, x.spokenText, x.interrupted])).toEqual([
      ["abc", "research", "claude-sonnet-5-5", "Wie geht es dir heute?", "Mir geht es gut, danke. Und dir?", false],
      ["abc", "research", "claude-sonnet-5-5", "Wie geht es dir heute?", "Mir geht es gut, danke. Und dir?", false],
    ]);
    expect(t.turns[0]!.userAt <= t.turns[0]!.replyAt).toBe(true);
    expect(t.ends).toEqual([{ conversationId: "abc", seconds: 60 }]);
  });

  test("Auflegen mitten in der Antwort: der Turn kommt mit dem bestätigten Teil als unterbrochen, dann das Ende", async () => {
    const t = setup();
    t.send({ type: "start", conversationId: "abc", tts: "browser" });
    await flush();
    await t.utter();
    const first = t.s.json("sentence")[0]!;
    t.send({ type: "played", id: first.id });
    t.send({ type: "hangup" });
    await flush();
    expect(t.turns.map(x => [x.spokenText, x.interrupted])).toEqual([["Mir geht es gut, danke.", true]]);
    expect(t.ends).toHaveLength(1);
  });

  test("Start gescheitert: kein Ende im Verlauf", async () => {
    const clock = fakeClock();
    const s = fakeSocket();
    const ends: unknown[] = [];
    const session = new CallSession({
      socket: s.socket,
      port: fakePort().port,
      checkConversation: async () => ({ ok: false, reason: "gespraech", message: "Gespräch nicht gefunden" }),
      clock,
      log: () => {},
      onEnd: () => {},
      history: { turn: () => {}, ended: e => ends.push(e), idle: async () => {} },
    });
    session.begin();
    session.receive(JSON.stringify({ type: "start", conversationId: "abc", tts: "browser" }));
    await flush();
    expect(ends).toEqual([]);
  });
});

const voice: VoicePort = {
  localMode: () => ({ ready: true, stt: { id: "parakeet", label: "Parakeet", local: true, available: true }, tts: { id: "browser", label: "Browser-Stimme", where: "browser", available: true } }),
};

async function* answer(text: string): AsyncGenerator<CallTurnEvent> {
  yield { type: "segment", text };
  yield { type: "done", rawText: text, spokenText: text, aborted: false };
}

describe("über den echten Web-Server", () => {
  test("zwei Turns und Auflegen: vier Nachrichten und eine Meldung im Web-Gespräch, live und nachgeladen, nichts nach Telegram", async () => {
    const PASSWORD = "test-passwort-verlauf";
    const { dir, store } = await tempStore();
    const conversation = await store.createConversation("general");
    const other = await store.createConversation("research");
    const m = fakeMemory();
    const telegramTurns: RunTurnOptions[] = [];
    const telegramChat: WebChat = {
      async runTurn(opts): Promise<TurnResult> {
        telegramTurns.push(opts);
        return { text: "" };
      },
      stop() {},
    };
    let n = 0;
    const replies = ["Sonnig und mild.", "Morgen regnet es."];
    const port = fakePort({ line: () => fakeLine({ speak: null, turn: () => answer(replies[n++] ?? "…") }) });
    const server = await createWebServer(
      { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
      { sessionFile: join(dir, "sessions.json"), conversationStore: store, voice, call: port.port, callMemory: m.memory, telegramChat, log: () => {} }
    );
    servers.push(server);
    const url = server.url;
    const login = await fetch(`${url}/api/login`, { method: "POST", headers: { origin: url }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    // Zweite offene Seite auf dem Gespräch: bekommt die Nachrichten live
    const events = await fetch(`${url}/api/conversations/${conversation.id}/events`, { headers: { cookie } });
    const reader = events.body!.getReader();
    let streamed = "";
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        streamed += new TextDecoder().decode(value);
      }
    })();

    const ws = new WebSocket(url.replace(/^http/, "ws") + CALL_PATH, { headers: { cookie, origin: url } } as any);
    const messages: Array<Record<string, any>> = [];
    ws.addEventListener("message", e => {
      if (typeof e.data === "string") messages.push(JSON.parse(e.data));
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("Verbindung gescheitert")));
    });
    const waitFor = async (pred: () => boolean, ms = 4000) => {
      const deadline = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > deadline) throw new Error(`Zeit abgelaufen: ${JSON.stringify(messages)}`);
        await Bun.sleep(10);
      }
    };
    ws.send(JSON.stringify({ type: "start", conversationId: conversation.id, tts: "browser" }));
    await waitFor(() => messages.some(x => x.type === "state" && x.state === "hoert-zu"));
    for (let turn = 1; turn <= 2; turn++) {
      for (let i = 0; i < 25; i++) ws.send(new Uint8Array(640).fill(1));
      ws.send(JSON.stringify({ type: "utterance_end" }));
      await waitFor(() => messages.filter(x => x.type === "sentence").length >= turn);
      const sentence = messages.filter(x => x.type === "sentence")[turn - 1]!;
      ws.send(JSON.stringify({ type: "played", id: sentence.id }));
      await waitFor(() => messages.filter(x => x.type === "state" && x.state === "hoert-zu").length > turn);
    }
    ws.send(JSON.stringify({ type: "hangup" }));
    await waitFor(() => messages.some(x => x.type === "ended"));
    const stored = async () => (await store.getMessages(conversation.id)).length;
    const deadline = Date.now() + 3000;
    while ((await stored()) < 5 && Date.now() < deadline) await Bun.sleep(10);

    const loaded = await fetch(`${url}/api/conversations/${conversation.id}/messages`, { headers: { cookie } });
    const body = (await loaded.json()) as { messages: Array<Record<string, any>> };
    expect(body.messages.map(x => [x.role, x.text, x.source ?? null])).toEqual([
      ["user", "Wie geht es dir heute?", "call"],
      ["assistant", "Sonnig und mild.", "call"],
      ["user", "Wie geht es dir heute?", "call"],
      ["assistant", "Morgen regnet es.", "call"],
      ["assistant", expect.stringMatching(/^Telefongespräch, \d+ Sek\.$/), "telefonhoerer"],
    ]);
    expect(body.messages[1]).toMatchObject({ model: "claude-sonnet-5-5" });
    expect(await store.getMessages(other.id)).toEqual([]);
    // Ins Gedächtnis unter dem Web-Gespräch, nichts an den Telegram-Chat
    expect(m.saved).toHaveLength(4);
    expect(m.saved.every(s => s.conversationId === conversation.id)).toBe(true);
    expect(m.notices).toEqual([]);
    expect(telegramTurns).toEqual([]);
    // Live an die zweite Seite
    await Bun.sleep(50);
    expect(streamed).toContain("Sonnig und mild.");
    expect(streamed).toContain("Morgen regnet es.");
    expect(streamed).toContain("Telefongespräch,");
    await reader.cancel();
    ws.close();
  }, 20_000);
});
