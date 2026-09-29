/**
 * Issue #227, Schritt 3: Rückfragen und bot-interne Meldungen ohne Telegram.
 * Ende zu Ende: echte Goal-Engine und echtes Register (Temp-Dateien), echte
 * Telegram-Seite der Rückfragen mit telegram: false, echte Outbox ohne
 * Bot-Token mit Attrappen für fetch und Nachrichtenspeicher, echter
 * Web-Server mit Telegram-Quelle und Live-Feed für den Direktchat "web".
 * Die Goal-„Weiter?"-Frage erscheint im Browser mit Knöpfen, ist nur im
 * Direktchat entscheidbar und setzt das Ziel fort; nie ein Aufruf an
 * api.telegram.org. Dazu die
 * Zuordnung der Chat-ID web in den Rückfrage-Bausteinen. src/bot.ts wird nie
 * geladen.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { onChoiceDecided, setChoicesFileForTests, getChoice, createChoice } from "../src/lib/choices";
import type { MessageSavedListener, SavedMessageEvent } from "../src/lib/convex";
import { createTelegramGoalStatus } from "../src/lib/goal-actions";
import { createGoalChoices, GOAL_NO_BUTTONS_HINT, goalConversation } from "../src/lib/goal-choices";
import { clearGoal, configureGoalStore, getGoal, initGoalEngine, isGoalLoopRunning, onGoalChange, setGoal, startGoalWork, updateGoal } from "../src/lib/goal-engine";
import { sendAndRecord, type OutboxDeps } from "../src/lib/outbox";
import { processTurnIntents, decideReview } from "../src/lib/intent-gate";
import { createReviewNotifier, createReviewResults, reviewConversation } from "../src/lib/review-choices";
import { setPendingReviewsFileForTests, setReviewNotifier, takePendingReview } from "../src/lib/session-distill";
import type { HistoryRow, Message } from "../src/lib/supabase";
import { createTelegramChoices, sendChoice } from "../src/lib/telegram-choices";
import { conversationForExecution } from "../src/lib/tool-approval";
import { createTelegramLiveFeed, createTelegramSource } from "../src/web/bot-telegram";
import type { RunTurnOptions, WebChat } from "../src/web/chat";
import { createWebServer, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import { testChoices } from "./choices-fixture";

const PASSWORD = "test-passwort-lang";
const dir = mkdtempSync(join(tmpdir(), "tybo-rueckfragen-web-"));
const servers: WebServer[] = [];
const cleanup: (() => void)[] = [];
let logSpy: ReturnType<typeof spyOn>;

beforeAll(() => {
  configureGoalStore({ file: join(dir, "goals.json") });
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  for (const off of cleanup.splice(0)) off();
  for (const s of servers.splice(0)) await s.stop();
});
afterAll(() => {
  logSpy.mockRestore();
  setChoicesFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(2);
  }
}

class QuietChat implements WebChat {
  async runTurn(_opts: RunTurnOptions) {
    return { text: "Antwort" };
  }
  stop() {
    return false;
  }
}

describe("Zuordnung der Chat-ID web", () => {
  test("Goal, Merk-Vorschlag und Werkzeug-Freigabe kennen den Web-Direktchat", () => {
    expect(goalConversation("web")).toEqual({ type: "telegram", chatId: "web" });
    expect(reviewConversation("web")).toEqual({ type: "telegram", chatId: "web" });
    expect(conversationForExecution("dm:web")).toEqual({ type: "telegram", chatId: "web" });
    expect(goalConversation("web:abc")).toBeNull();
  });
});

describe("sendChoice ohne Telegram", () => {
  test("Direktchat web: nur festgehalten mit choiceId, ohne Knöpfe, kein Nachziehen; Web-Gespräch: keine Kopie", async () => {
    setChoicesFileForTests(join(dir, "choices-send.json"));
    const inputs: unknown[] = [];
    const refreshed: unknown[] = [];
    const send = async (input: any) => {
      inputs.push(input);
      return { sent: false, recorded: true };
    };
    const dm = await createChoice({ kind: "goal", conversation: { type: "telegram", chatId: "web" }, text: "Weiter?", options: [{ key: "more", label: "Weiter" }], ref: "1" });
    const result = await sendChoice(dm, { send, refresh: async (...a) => void refreshed.push(a), telegram: () => false });
    expect(result).toEqual({ sent: true, recorded: true, messages: [] });
    expect(inputs).toEqual([{ chatId: "web", text: "Weiter?", format: "plain", source: "ziel", choiceId: dm.id }]);
    expect((await getChoice(dm.id))?.telegram).toBeUndefined();

    const web = await createChoice({ kind: "review", conversation: { type: "web", conversationId: "0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a4b" }, text: "Merken?", options: [{ key: "ok", label: "Ja" }], ref: "r1" });
    expect((await sendChoice(web, { send, refresh: async () => {}, telegram: () => false })).sent).toBe(false);
    expect(inputs).toHaveLength(1);
    expect(refreshed).toEqual([]);
  });

  test("Festhalten gescheitert: nicht zugestellt", async () => {
    setChoicesFileForTests(join(dir, "choices-fail.json"));
    const c = await createChoice({ kind: "goal", conversation: { type: "telegram", chatId: "web" }, text: "Weiter?", options: [{ key: "more", label: "Weiter" }], ref: "1" });
    const result = await sendChoice(c, {
      send: async () => ({ sent: false, recorded: false, error: { kind: "record", message: "nicht festgehalten" } }),
      refresh: async () => {},
      telegram: () => false,
    });
    expect(result.sent).toBe(false);
  });
});

// Gemeinsamer Meldeweg „an den Nutzer melden": tests/user-notify.test.ts

describe("Goal „Weiter?“ ohne Telegram im Browser", () => {
  test("erscheint mit Knöpfen im Direktchat, nur dort entscheidbar, Weiter setzt das Ziel fort", async () => {
    const choiceFile = join(dir, "choices-e2e.json");
    const choices = testChoices(choiceFile, { userId: "web" });
    const key = "dm:web";

    // Nachrichtenspeicher-Attrappe mit Hook wie saveDisplayOnlyMessage
    const rows: (HistoryRow & { chat_id: string })[] = [];
    let hook: MessageSavedListener | null = null;
    let n = 0;
    const fetched: string[] = [];
    const outboxDeps: OutboxDeps = {
      botToken: "",
      userId: "",
      groupId: "-1001234567890",
      outboxDir: join(dir, "outbox"),
      fetch: async url => {
        fetched.push(url);
        return new Response("{}");
      },
      record: async (m: Message) => {
        const metadata = { ...(m.metadata ?? {}), msgId: crypto.randomUUID() };
        const row = { id: String(++n), chat_id: m.chat_id, created_at: new Date(Date.now() + n).toISOString(), role: m.role, content: m.content, metadata };
        rows.push(row as any);
        const event: SavedMessageEvent = { chatId: m.chat_id, role: m.role as "assistant", content: m.content, metadata, createdAt: row.created_at };
        await hook?.(event);
        return true;
      },
      log: () => {},
      newId: () => crypto.randomUUID(),
    };
    const telegram = createTelegramChoices({
      api: {
        editMessageText: async () => {
          throw new Error("kein Telegram");
        },
        editMessageReplyMarkup: async () => {
          throw new Error("kein Telegram");
        },
      } as any,
      owner: "",
      telegram: () => false,
      send: input => sendAndRecord(input, outboxDeps),
      log: () => {},
    });
    const goalChoices = createGoalChoices({ getGoal, abort: () => 0, sendChoice: c => telegram.sendChoice(c), log: () => {} });
    cleanup.push(onChoiceDecided("goal", goalChoices.handler));
    cleanup.push(onGoalChange(goalChoices.listener));
    let pendingTurn: ((r: { text: string; aborted: boolean }) => void) | null = null;
    let turns = 0;
    const plain: string[] = [];
    initGoalEngine({
      callAgent: () => {
        turns++;
        return new Promise(resolve => {
          pendingTurn = resolve;
        });
      },
      sendAsAgent: async () => {},
      sendStatus: createTelegramGoalStatus({
        send: async (_chatId, text) => void plain.push(text),
        ask: (target, text) => goalChoices.ask(target, text),
        noButtonsHint: GOAL_NO_BUTTONS_HINT,
      }),
    });

    const store = new ConversationStore({ dir: join(dir, "web") });
    await store.load();
    const other = await store.createConversation("general");
    const source = createTelegramSource({
      userId: "web",
      groupId: () => null,
      topicNames: async () => ({}),
      topicMapping: () => ({}),
      history: async chatId => rows.filter(r => r.chat_id === chatId),
      activity: async () => [],
      log: () => {},
    });
    const live = createTelegramLiveFeed({
      userId: "web",
      groupId: () => null,
      onMessageSaved: l => {
        hook = l;
        return () => {
          hook = null;
        };
      },
      log: () => {},
    });
    const server = await createWebServer(
      { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
      {
        sessionFile: join(dir, "sessions.json"),
        conversationStore: store,
        chat: new QuietChat(),
        telegram: source,
        telegramChat: new QuietChat(),
        telegramLive: live,
        choices: choices.port,
        cliTokenFile: join(dir, "cli-token"),
        keepaliveMs: 60_000,
        log: () => {},
      }
    );
    servers.push(server);
    const login = await fetch(`${server.url}/api/login`, { method: "POST", headers: { origin: server.url }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const api = (path: string, method = "GET", body?: unknown) =>
      fetch(`${server.url}${path}`, { method, headers: { cookie, origin: server.url, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

    try {
      // Ziel im Direktchat am Budget: die Schleife stellt die Budget-Frage
      await setGoal({ sessionKey: key, chatId: "web", agentName: "general", goal: "Bericht schreiben" });
      await updateGoal(key, { turnsUsed: 3, maxTurns: 3 });
      await startGoalWork(key);
      await goalChoices.settled();

      const messages = (await (await api("/api/conversations/dm/messages")).json()).messages;
      const question = messages.find((m: any) => m.choice);
      expect(question).toMatchObject({ kind: "notice", source: "ziel", choice: { state: "open" } });
      expect(question.choice.options.map((o: any) => o.key)).toEqual(["more", "stop"]);
      expect(question.text).toContain("Weitermachen?");
      // Nur die Rückfrage, keine Statusmeldung ohne Knöpfe, nichts an Telegram
      expect(plain).toEqual([]);
      expect(fetched).toEqual([]);

      // Aus einem anderen Gespräch nicht entscheidbar
      const foreign = await api(`/api/conversations/${other.id}/choices/${question.choice.id}`, "POST", { option: "more" });
      expect(foreign.status).toBe(404);
      expect((await getChoice(question.choice.id))?.state).toBe("open");

      // Im Direktchat: Weiter, das Ziel läuft mit 5 Turns mehr weiter
      const res = await api(`/api/conversations/dm/choices/${question.choice.id}`, "POST", { option: "more" });
      expect(res.status).toBe(200);
      expect((await res.json()).choice).toMatchObject({ state: "done", result: { key: "more", via: "web" } });
      await waitUntil(async () => (await getGoal(key))?.maxTurns === 8);
      expect(await getGoal(key)).toMatchObject({ status: "active", maxTurns: 8 });
      await waitUntil(() => turns === 1);
      expect(fetched).toEqual([]);
    } finally {
      await clearGoal(key);
      (pendingTurn as ((r: { text: string; aborted: boolean }) => void) | null)?.({ text: "", aborted: true });
      await waitUntil(() => !isGoalLoopRunning(key));
      await goalChoices.settled();
    }
  });
});

describe("Merk-Vorschlag im Web-Direktchat ohne Telegram (Prüfer-Runde 2)", () => {
  test("kein Token, verbliebene TELEGRAM_USER_ID: Rückfrage unter web, dort entscheidbar, nie Telegram, erst nach Zustimmung angewendet", async () => {
    const saved = { token: process.env.TELEGRAM_BOT_TOKEN, user: process.env.TELEGRAM_USER_ID };
    delete process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_USER_ID = "4242";
    const choices = testChoices(join(dir, "choices-review.json"), { userId: "web" });
    setPendingReviewsFileForTests(join(dir, "pending-reviews.json"));

    const records: Message[] = [];
    const fetched: string[] = [];
    const outboxDeps: OutboxDeps = {
      botToken: "",
      userId: "4242",
      groupId: "",
      outboxDir: join(dir, "outbox-review"),
      fetch: async url => {
        fetched.push(url);
        return new Response("{}");
      },
      record: async (m: Message) => {
        records.push(m);
        return true;
      },
      log: () => {},
      newId: () => crypto.randomUUID(),
    };
    const telegramCalls: string[] = [];
    const telegram = createTelegramChoices({
      api: {
        editMessageText: async () => void telegramCalls.push("edit"),
        editMessageReplyMarkup: async () => void telegramCalls.push("markup"),
      } as any,
      owner: "",
      telegram: () => false,
      send: input => sendAndRecord(input, outboxDeps),
      log: () => {},
    });
    setReviewNotifier(createReviewNotifier({ sendChoice: c => telegram.sendChoice(c), log: () => {} }));
    const applied: string[] = [];
    const results = createReviewResults({
      decideReview: (action, id) =>
        decideReview(action, id, {
          takePendingReview,
          processIntents: async t => {
            applied.push(t);
            return { goalsAdded: [], goalsCompleted: [], goalsCancelled: [], factsAdded: ["x"], factsRemoved: [] };
          },
        }),
      createRoutine: async () => ({ isError: true }),
      sessionEpochSnapshot: () => () => 0,
      sendAndRecord: input => sendAndRecord(input, outboxDeps),
      sendTelegram: async chatId => void telegramCalls.push(chatId),
      saveMessage: async () => {},
      dmChatId: () => undefined,
      log: () => {},
    });
    cleanup.push(onChoiceDecided("review", results.handler));

    try {
      const outcome = await processTurnIntents(
        "Gelesen. [REMEMBER: Alex mag Tee]",
        { uses: [{ name: "WebFetch" }], cwd: process.cwd() },
        { chatId: "web", origin: "Web-Direktchat" },
        { processIntents: async t => void applied.push(t), log: () => {} }
      );
      expect(outcome).toBe("staged");
      expect(applied).toEqual([]);

      // Rückfrage unter web, festgehalten für den Direktchat, kein Ziel 4242
      expect(records).toHaveLength(1);
      expect(records[0].chat_id).toBe("web");
      const choiceId = (records[0].metadata as Record<string, unknown>).choiceId as string;
      const choice = await getChoice(choiceId);
      expect(choice?.conversation).toEqual({ type: "telegram", chatId: "web" });

      // Im Web-Direktchat sichtbar und entscheidbar
      expect((await choices.port.view(choiceId, "dm")).state).toBe("open");
      const decided = await choices.port.decide("dm", choiceId, "ok", "web");
      expect(decided).toMatchObject({ status: "decided", choice: { state: "done", result: { key: "ok", via: "web" } } });
      expect(applied).toEqual(["[REMEMBER: Alex mag Tee]"]);
      expect(records.at(-1)?.chat_id).toBe("web");

      expect(fetched).toEqual([]);
      expect(telegramCalls).toEqual([]);
      expect(records.every(r => r.chat_id === "web")).toBe(true);
    } finally {
      setReviewNotifier(null);
      setPendingReviewsFileForTests(null);
      if (saved.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = saved.token;
      if (saved.user === undefined) delete process.env.TELEGRAM_USER_ID;
      else process.env.TELEGRAM_USER_ID = saved.user;
    }
  });
});
