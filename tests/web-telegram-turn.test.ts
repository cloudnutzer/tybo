// Schreiben in Telegram-Gespräche (Issue #19): Schlüssel, Agent, Speichern,
// Spiegeln, Antwort senden und Stopp, mit Attrappen statt Telegram und Claude.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { ABORT_REPLY, type TurnOptions, type TurnSink } from "../src/lib/chat-turn";
import { abortAllExecutions, abortExecutions, currentExecution, runExecution } from "../src/lib/execution-context";
import type { RunTurnOptions } from "../src/web/chat";
import {
  MIRROR_FAILED_TEXT,
  TELEGRAM_UNAVAILABLE_TEXT,
  createApprovalTurns,
  createTelegramChat,
  mirrorChunks,
  resolveTelegramTarget,
  type ApprovalTurns,
  type TelegramChatDeps,
  type WebSavedMessage,
} from "../src/web/bot-turn";
import { isWebMessageId } from "../src/web/telegram";
import { callBuiltinTool, registerBuiltinTool, setToolApprovalHandler } from "../src/lib/tools/registry";
import { getChoice, setChoicesFileForTests, type Choice } from "../src/lib/choices";
import { createChoiceToolApproval } from "../src/lib/tool-approval";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startWebUi } from "../src/web/startup";
import type { WebServer, WebServerDeps } from "../src/web/server";

const GROUP = "-1001234567890";
const USER = "4242";

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

function untilAborted(): Promise<void> {
  const signal = currentExecution()!.controller.signal;
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function setup(core: (o: TurnOptions) => Promise<string> = async () => "Antwort") {
  const state = {
    /** Reihenfolge aller Schritte nach außen */
    steps: [] as string[],
    saved: [] as WebSavedMessage[],
    plain: [] as { chatId: string; text: string; threadId?: number }[],
    agentSends: [] as { agent: string; chatId: string; text: string; threadId?: number }[],
    intents: [] as string[],
    aborts: [] as string[],
    logs: [] as string[],
    coreCalls: [] as (TurnOptions & { key?: string; lockAgent?: string })[],
    group: GROUP as string | null,
    plainFails: false,
    agentSendFails: false,
    beforeSave: undefined as ((m: WebSavedMessage) => Promise<void>) | undefined,
    beforePlain: undefined as (() => Promise<void>) | undefined,
    core,
  };
  const deps: TelegramChatDeps = {
    userId: USER,
    groupId: () => state.group,
    agentForTopic: topicId => ({ 443: "cto", 1: "research" } as Record<number, string>)[topicId],
    runStreamingTurn: o => {
      state.steps.push("claude");
      state.coreCalls.push({ ...o, key: currentExecution()?.key, lockAgent: currentExecution()?.agent });
      return state.core(o);
    },
    saveMessage: async m => {
      await state.beforeSave?.(m);
      state.steps.push(`save:${m.role}`);
      state.saved.push(m);
      return true;
    },
    processIntents: async t => {
      state.steps.push("intents");
      state.intents.push(t);
    },
    abortEngineCalls: key => {
      state.aborts.push(key);
      return abortExecutions(key);
    },
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    sendPlain: async (chatId, text, threadId) => {
      if (state.plainFails) throw new Error("Telegram 400");
      await state.beforePlain?.();
      state.steps.push("mirror");
      state.plain.push({ chatId, text, threadId });
    },
    sendAsAgent: async (agent, chatId, text, threadId) => {
      if (state.agentSendFails) throw new Error("Telegram 429");
      state.steps.push("send");
      state.agentSends.push({ agent, chatId, text, threadId });
    },
    log: m => state.logs.push(m),
  };
  return { state, deps, chat: createTelegramChat(deps) };
}

/** Wie setup, aber mit gemeinsamen Freigabe-Turns (Issue #116) */
function setupWith(approvals: ApprovalTurns, core?: (o: TurnOptions) => Promise<string>) {
  const made = setup(core);
  return { ...made, chat: createTelegramChat({ ...made.deps, approvals }) };
}

const nullSink: TurnSink = { progress() {}, notice() {} };
const USER_MSG_ID = "web-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function turn(id: string, text = "Frage"): RunTurnOptions {
  return { conversationId: id, agent: "general", text, messageId: USER_MSG_ID, sink: nullSink };
}

afterEach(() => abortAllExecutions());

describe("resolveTelegramTarget", () => {
  const deps = { userId: USER, groupId: () => GROUP, agentForTopic: (t: number) => (t === 443 ? "cto" : undefined) };

  test("topic-443, topic-1, dm, unbekanntes Topic", () => {
    expect(resolveTelegramTarget("topic-443", deps)).toEqual({ chatId: GROUP, topicId: 443, sessionKey: `topic:${GROUP}:443`, agent: "cto" });
    expect(resolveTelegramTarget("topic-1", deps)).toEqual({ chatId: GROUP, sessionKey: `group:${GROUP}`, agent: "general" });
    expect(resolveTelegramTarget("dm", deps)).toEqual({ chatId: USER, sessionKey: `dm:${USER}`, agent: "general" });
    expect(resolveTelegramTarget("topic-7", deps)?.agent).toBe("general");
  });

  test("ohne gültige Chat-ID oder bei fremder ID: null", () => {
    expect(resolveTelegramTarget("dm", { ...deps, userId: undefined })).toBeNull();
    expect(resolveTelegramTarget("dm", { ...deps, userId: "abc" })).toBeNull();
    expect(resolveTelegramTarget("topic-3", { ...deps, groupId: () => null })).toBeNull();
    expect(resolveTelegramTarget("topic-3", { ...deps, groupId: () => "12345" })).toBeNull();
    expect(resolveTelegramTarget("topic-3", { ...deps, groupId: () => { throw new Error("x"); } })).toBeNull();
    expect(resolveTelegramTarget("0c1a2b3c-0000-4000-8000-000000000000", deps)).toBeNull();
  });
});

describe("createTelegramChat", () => {
  test("topic-443: Schlüssel topic:<chatId>:443, gemappter Agent, Spiegeln vor dem Turn, Antwort über sendAsAgent", async () => {
    const reply = "Erledigt.\n[REMEMBER: Alex mag Topics]";
    const { state, chat } = setup(async () => reply);
    const result = await chat.runTurn(turn("topic-443", "Wie weit ist das Deck?"));

    expect(result.text).toBe(reply);
    expect(isWebMessageId(result.messageId)).toBe(true);
    expect(result.messageId).not.toBe(USER_MSG_ID);
    // Reihenfolge: erst Telegram, dann Claude, dann verbindlich speichern und antworten
    expect(state.steps).toEqual(["mirror", "claude", "save:user", "save:assistant", "send", "intents"]);
    expect(state.plain).toEqual([{ chatId: GROUP, text: "Du (Web): Wie weit ist das Deck?", threadId: 443 }]);
    expect(state.coreCalls[0]).toMatchObject({
      userMessage: "Wie weit ist das Deck?",
      chatId: GROUP,
      agentName: "cto",
      topicId: 443,
      key: `topic:${GROUP}:443`,
      lockAgent: "cto",
    });
    expect(state.saved).toEqual([
      {
        chat_id: GROUP,
        role: "user",
        content: "Wie weit ist das Deck?",
        metadata: { topicId: 443, channel: "web", msgId: USER_MSG_ID },
        created_at: expect.any(String),
      },
      { chat_id: GROUP, role: "assistant", content: reply, metadata: { topicId: 443, channel: "web", msgId: result.messageId, agent: "cto" } },
    ]);
    // Telegram ohne Steuer-Tags, Merk-Tags mit dem Rohtext
    expect(state.agentSends).toEqual([{ agent: "cto", chatId: GROUP, text: "Erledigt.", threadId: 443 }]);
    expect(state.intents).toEqual([reply]);
  });

  test("topic-1 (General): group:<chatId> ohne Topic, Agent general, topicId null im Speicher", async () => {
    const { state, chat } = setup();
    await chat.runTurn(turn("topic-1"));
    expect(state.coreCalls[0]).toMatchObject({ chatId: GROUP, agentName: "general", key: `group:${GROUP}` });
    expect(state.coreCalls[0].topicId).toBeUndefined();
    expect(state.plain[0].threadId).toBeUndefined();
    expect(state.agentSends[0]).toMatchObject({ agent: "general", chatId: GROUP, threadId: undefined });
    expect(state.saved.map(m => m.metadata?.topicId)).toEqual([null, null]);
    expect(state.saved.map(m => m.metadata?.channel)).toEqual(["web", "web"]);
  });

  test("dm: Schlüssel dm:<TELEGRAM_USER_ID>, Agent general", async () => {
    const { state, chat } = setup();
    await chat.runTurn(turn("dm"));
    expect(state.coreCalls[0]).toMatchObject({ chatId: USER, agentName: "general", key: `dm:${USER}` });
    expect(state.plain[0]).toEqual({ chatId: USER, text: "Du (Web): Frage", threadId: undefined });
    expect(state.agentSends[0]).toMatchObject({ agent: "general", chatId: USER });
    expect(state.saved.map(m => [m.chat_id, m.metadata?.topicId, m.metadata?.channel])).toEqual([
      [USER, null, "web"],
      [USER, null, "web"],
    ]);
  });

  test("lange Nachricht: in mehreren Klartext-Teilen gespiegelt, nichts geht verloren", async () => {
    const long = Array.from({ length: 900 }, (_, i) => `Wort${i}`).join(" ") + "\n\n" + "x".repeat(5000);
    const chunks = mirrorChunks(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(c => c.length <= 4000)).toBe(true);
    expect(chunks[0].startsWith("Du (Web): Wort0 ")).toBe(true);
    expect(chunks.join("").replace(/\s/g, "")).toBe(("Du (Web): " + long).replace(/\s/g, ""));

    const { state, chat } = setup();
    await chat.runTurn(turn("topic-443", long));
    expect(state.plain.map(p => p.text)).toEqual(chunks);
    expect(state.plain.every(p => p.threadId === 443)).toBe(true);
  });

  test("Spiegeln scheitert: Fehlermeldung, nichts gespeichert, kein Claude, keine Antwort", async () => {
    const { state, chat } = setup();
    state.plainFails = true;
    expect(await chat.runTurn(turn("topic-443"))).toEqual({ text: MIRROR_FAILED_TEXT, failed: true });
    expect(state.saved).toEqual([]);
    expect(state.coreCalls).toEqual([]);
    expect(state.agentSends).toEqual([]);
    expect(state.logs.join("\n")).not.toContain("Frage");
  });

  test("ohne Gruppe: nicht erreichbar, nichts passiert", async () => {
    const { state, chat } = setup();
    state.group = null;
    expect(await chat.runTurn(turn("topic-443"))).toEqual({ text: TELEGRAM_UNAVAILABLE_TEXT, failed: true });
    expect(state.steps).toEqual([]);
  });

  test("Stopp während Claude: keine Antwort nach Telegram, nichts gespeichert, keine Intents", async () => {
    const { state, chat } = setup(async () => {
      await untilAborted();
      return ABORT_REPLY;
    });
    const running = chat.runTurn(turn("topic-443"));
    await waitUntil(() => state.coreCalls.length === 1);
    expect(chat.stop("topic-443")).toBe(true);
    expect(await running).toEqual({ text: "", aborted: true });
    expect(state.aborts).toEqual([`topic:${GROUP}:443`]);
    expect(state.agentSends).toEqual([]);
    expect(state.intents).toEqual([]);
    expect(state.saved).toEqual([]);
    // Nach dem Ende gibt es nichts mehr zu stoppen
    expect(chat.stop("topic-443")).toBe(false);
  });

  test("Stopp während der Spiegelung: kein weiterer Teil, nichts gespeichert, kein Claude", async () => {
    const long = "x".repeat(9000);
    expect(mirrorChunks(long).length).toBeGreaterThan(1);
    const { state, chat } = setup();
    let calls = 0;
    let release!: () => void;
    // Ersten Teil anhalten, bis der Stopp angenommen ist
    state.beforePlain = async () => {
      if (++calls === 1) await new Promise<void>(r => (release = r));
    };
    const running = chat.runTurn(turn("topic-443", long));
    await waitUntil(() => typeof release === "function");
    expect(chat.stop("topic-443")).toBe(true);
    release();
    expect(await running).toEqual({ text: "", aborted: true });
    expect(calls).toBe(1);
    expect(state.steps).toEqual(["mirror"]);
    expect(state.saved).toEqual([]);
    expect(state.coreCalls).toEqual([]);
    expect(state.agentSends).toEqual([]);
    expect(state.intents).toEqual([]);
  });

  test("Warteschlange: wartet hinter einem Telegram-Turn desselben Schlüssels und Agenten, Stopp dort beendet ihn ohne Claude und ohne Speichern", async () => {
    const { state, chat } = setup();
    let started = false;
    // Telegram-Turn im selben Topic mit demselben Agenten hält die Sperre;
    // wie der echte Claude-Aufruf endet er, wenn sein Schlüssel abgebrochen wird
    const telegram = runExecution(`topic:${GROUP}:443`, "cto", async () => {
      started = true;
      await untilAborted();
      throw new DOMException("abgebrochen", "AbortError");
    }).catch(e => e);
    await waitUntil(() => started);

    const queued = chat.runTurn(turn("topic-443"));
    await waitUntil(() => state.plain.length === 1);
    await Bun.sleep(20);
    expect(state.coreCalls).toEqual([]);
    expect(chat.stop("topic-443")).toBe(true);
    expect(await queued).toEqual({ text: "", aborted: true });
    expect(state.coreCalls).toEqual([]);
    expect(state.agentSends).toEqual([]);
    expect(state.saved).toEqual([]);
    // Wie /stop in Telegram: der Schlüssel trifft auch den Telegram-Turn
    expect(((await telegram) as Error).name).toBe("AbortError");
  });

  test("Warteschlange ohne Stopp: der Web-Turn läuft erst nach dem Telegram-Turn", async () => {
    const order: string[] = [];
    const { state, chat } = setup(async () => {
      order.push("web");
      return "ok";
    });
    let releaseTelegram!: () => void;
    const telegram = runExecution(`topic:${GROUP}:443`, "cto", async () => {
      await new Promise<void>(r => (releaseTelegram = r));
      order.push("telegram");
    });
    await waitUntil(() => typeof releaseTelegram === "function");
    const queued = chat.runTurn(turn("topic-443"));
    await waitUntil(() => state.plain.length === 1);
    await Bun.sleep(20);
    expect(order).toEqual([]);
    expect(state.saved).toEqual([]);
    releaseTelegram();
    await telegram;
    expect((await queued).text).toBe("ok");
    expect(order).toEqual(["telegram", "web"]);
  });

  test("Stopp nach Beginn des Abschlusses wird abgelehnt; Antwort geht trotzdem raus", async () => {
    const { state, chat } = setup(async () => "fertig");
    let release!: () => void;
    state.beforeSave = async m => {
      if (m.role === "assistant") await new Promise<void>(r => (release = r));
    };
    const running = chat.runTurn(turn("dm"));
    await waitUntil(() => typeof release === "function");
    expect(chat.stop("dm")).toBe(false);
    expect(state.aborts).toEqual([]);
    release();
    const result = await running;
    expect(result.text).toBe("fertig");
    expect(state.agentSends).toHaveLength(1);
    expect(state.intents).toEqual(["fertig"]);
  });

  test("Claude scheitert: Stopp während des Speicherns der Nutzernachricht wird abgelehnt", async () => {
    const { state, chat } = setup(async () => {
      throw new Error("CLI kaputt");
    });
    let release!: () => void;
    state.beforeSave = async m => {
      if (m.role === "user") await new Promise<void>(r => (release = r));
    };
    const running = chat.runTurn(turn("topic-443")).catch(e => e);
    await waitUntil(() => typeof release === "function");
    expect(chat.stop("topic-443")).toBe(false);
    expect(state.aborts).toEqual([]);
    release();
    expect(((await running) as Error).message).toBe("CLI kaputt");
    expect(state.saved.map(m => m.role)).toEqual(["user"]);
    expect(state.agentSends).toEqual([]);
    expect(state.intents).toEqual([]);
  });

  test("Senden der Antwort scheitert: Log ohne Text, Antwort bleibt im Browser und im Speicher", async () => {
    const { state, chat } = setup(async () => "geheime Antwort");
    state.agentSendFails = true;
    const result = await chat.runTurn(turn("topic-443"));
    expect(result.text).toBe("geheime Antwort");
    expect(state.saved.map(m => m.role)).toEqual(["user", "assistant"]);
    expect(state.logs.some(l => l.includes("nicht gesendet"))).toBe(true);
    expect(state.logs.join("\n")).not.toContain("geheime");
  });

  test("Eingangszeitpunkt aus dem ChatHub: Nutzernachricht mit genau diesem created_at, Antwort ohne", async () => {
    const receivedAt = "2026-09-24T11:50:01.250Z";
    const { state, chat } = setup();
    await chat.runTurn({ ...turn("topic-443"), receivedAt });
    expect(state.saved.map(m => [m.role, m.created_at])).toEqual([
      ["user", receivedAt],
      ["assistant", undefined],
    ]);
  });

  test("ohne gültigen Eingangszeitpunkt: Zeitpunkt vor Spiegeln und Warteschlange", async () => {
    for (const receivedAt of [undefined, "gestern", new Date(Date.now() + 60_000).toISOString()]) {
      const { state, chat } = setup();
      const before = Date.now();
      let mirroredAt = 0;
      state.beforePlain = async () => {
        await Bun.sleep(15);
        mirroredAt = Date.now();
      };
      await chat.runTurn({ ...turn("topic-443"), receivedAt });
      const at = Date.parse(state.saved[0].created_at!);
      expect(at).toBeGreaterThanOrEqual(before);
      expect(at).toBeLessThan(mirroredAt);
    }
  });

  test("Claude scheitert: die Nutzernachricht bleibt mit dem Eingangszeitpunkt", async () => {
    const receivedAt = "2026-09-24T11:50:01.250Z";
    const { state, chat } = setup(async () => {
      throw new Error("CLI kaputt");
    });
    expect(((await chat.runTurn({ ...turn("topic-443"), receivedAt }).catch(e => e)) as Error).message).toBe("CLI kaputt");
    expect(state.saved.map(m => [m.role, m.created_at])).toEqual([["user", receivedAt]]);
  });

  test("Stopp mit Eingangszeitpunkt: weiterhin nichts gespeichert", async () => {
    const { state, chat } = setup(async () => {
      await untilAborted();
      return ABORT_REPLY;
    });
    const running = chat.runTurn({ ...turn("topic-443"), receivedAt: "2026-09-24T11:50:01.250Z" });
    await waitUntil(() => state.coreCalls.length === 1);
    expect(chat.stop("topic-443")).toBe(true);
    expect(await running).toEqual({ text: "", aborted: true });
    expect(state.saved).toEqual([]);
  });

  test("Antwort nur aus Steuer-Tags: nichts nach Telegram, Intents trotzdem", async () => {
    const { state, chat } = setup(async () => "[REMEMBER: nur ein Tag]");
    await chat.runTurn(turn("dm"));
    expect(state.agentSends).toEqual([]);
    expect(state.intents).toEqual(["[REMEMBER: nur ein Tag]"]);
  });
});

describe("Werkzeug-Freigaben in Telegram-Gesprächen aus dem Browser (Issue #116)", () => {
  let enabled = false;
  registerBuiltinTool({
    name: "web_tg_test_write",
    description: "Schreibt eine Testdatei",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    requiresApproval: true,
    isAvailable: () => enabled,
    handler: async () => {
      executed++;
      return "geschrieben";
    },
  });
  let executed = 0;
  const dir = mkdtempSync(join(tmpdir(), "web-tg-approval-"));
  let n = 0;
  afterAll(() => {
    setChoicesFileForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  async function approvalSetup() {
    setChoicesFileForTests(join(dir, `choices-${++n}.json`));
    enabled = true;
    executed = 0;
    const approvals = createApprovalTurns();
    const sent: Choice[] = [];
    const approval = createChoiceToolApproval({
      sendChoice: async choice => {
        sent.push(choice);
        return { sent: true };
      },
      presenter: key => approvals.presenter(key),
      log: () => {},
    });
    setToolApprovalHandler(approval.handler);
    return { approvals, approval, sent };
  }
  const toolCore = async () => {
    const r = await callBuiltinTool("web_tg_test_write", { path: "a" });
    return r.isError ? "abgelehnt" : `Erledigt: ${r.content}`;
  };

  test("Frage im Topic (sendChoice), Browser nur Status, „ja“ im Terminal gibt frei", async () => {
    const { approval, sent, approvals } = await approvalSetup();
    const asks: { question: string; id: string; record?: boolean }[] = [];
    const ended: string[] = [];
    const { chat } = setupWith(approvals, toolCore);
    try {
      const run = chat.runTurn({
        ...turn("topic-443"),
        ask: async (question, id, options) => {
          asks.push({ question, id, record: options?.record });
        },
        endAsk: id => {
          ended.push(id);
        },
      });
      await waitUntil(() => asks.length === 1 && sent.length === 1);
      expect(sent[0].conversation).toEqual({ type: "telegram", chatId: GROUP, topicId: 443 });
      expect(asks[0].id).toBe(sent[0].id);
      // Keine eigene Nachricht: die Frage kommt über den Nachrichtenspeicher
      expect(asks[0].record).toBe(false);
      // Falsche Kennung oder anderes Gespräch: nichts entschieden
      expect(await chat.answer!("topic-443", "ja", "AAAAAAAAAA", "terminal")).toBe(false);
      expect(await chat.answer!("dm", "ja", sent[0].id, "terminal")).toBe(false);
      expect(await chat.answer!("topic-443", "ja", sent[0].id, "terminal")).toBe(true);
      expect((await run).text).toBe("Erledigt: geschrieben");
      expect(executed).toBe(1);
      expect((await getChoice(sent[0].id))!.result).toMatchObject({ key: "allow", via: "terminal" });
      expect(ended).toEqual([sent[0].id]);
      // Zweite Antwort auf dieselbe Frage: veraltet
      expect(await chat.answer!("topic-443", "ja", sent[0].id, "web")).toBe(false);
      expect(executed).toBe(1);
    } finally {
      enabled = false;
      approval.dispose();
      setToolApprovalHandler(null);
    }
  });

  test("General und Direktchat: Frage im richtigen Gespräch, „nein“ lehnt ab", async () => {
    const { approval, sent, approvals } = await approvalSetup();
    const { chat } = setupWith(approvals, toolCore);
    try {
      for (const [id, conversation] of [
        ["topic-1", { type: "telegram", chatId: GROUP }],
        ["dm", { type: "telegram", chatId: USER }],
      ] as const) {
        const asked: string[] = [];
        const run = chat.runTurn({ ...turn(id), ask: async (_q, choiceId) => void asked.push(choiceId), endAsk: () => {} });
        await waitUntil(() => asked.length === 1);
        const choice = sent[sent.length - 1];
        expect(choice.conversation).toEqual(conversation);
        expect(await chat.answer!(id, "nein", choice.id, "web")).toBe(true);
        expect((await run).text).toBe("abgelehnt");
      }
      expect(executed).toBe(0);
    } finally {
      enabled = false;
      approval.dispose();
      setToolApprovalHandler(null);
    }
  });
});

describe("startWebUi", () => {
  test("reicht den Telegram-Turn an den Server weiter", async () => {
    const telegramChat = { runTurn: async () => ({ text: "" }), stop: () => false };
    let seen: WebServerDeps | undefined;
    const server = await startWebUi({
      env: { WEB_ENABLED: "true", WEB_PASSWORD: "ein-langes-passwort" },
      chat: { runTurn: async () => ({ text: "" }), stop() {} },
      telegramChat,
      createServer: async (_config, deps) => {
        seen = deps;
        return { url: "http://127.0.0.1:3100", eventStreamCount: () => 0, stop: async () => {} } as WebServer;
      },
      log: () => {},
      lanAddresses: () => [],
    });
    expect(server).not.toBeNull();
    expect(seen?.telegramChat).toBe(telegramChat);
  });
});
