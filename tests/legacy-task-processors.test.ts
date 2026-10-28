/**
 * Issue #337, Nachbesserung, und Issue #348: alte atask-Knöpfe mit ask_user
 * im Topic. Alte Aufträge des Agent SDK laufen seit Issue #349 über den
 * Mac-Zweig; das SDK selbst gibt es seit Issue #352 nicht mehr. Aufträge mit messages_snapshot
 * (früheres Gateway) setzt seit #348 der Motor api fort (API-Attrappe aus
 * tests/api-fixture.ts); eine Folgefrage wird Rückfrage des Registers im
 * Topic des Auftrags, keine neuen atask-Knöpfe. Echter grammY-Context mit
 * Api-Attrappe, echter Auftragsspeicher über die Supabase-Attrappe, echte
 * Sperre, echte Knopf-Weiche (src/channels/telegram/callbacks.ts).
 * src/bot.ts wird nie geladen.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "grammy";
import { createAskOffer, installAskOffer, parseAskRef } from "../src/lib/ask-choices";
import { setChoicesFileForTests, type Choice } from "../src/lib/choices";
import { SNAPSHOT_TEXT } from "../src/lib/engines/api-legacy";
import type { ApiToolHost } from "../src/lib/engines/api-tools";
import { processTurnIntents } from "../src/lib/intent-gate";
import { classifyTurnTools } from "../src/lib/turn-tools";
import { createCallbackRouter, type TaskButtonDeps } from "../src/channels/telegram/callbacks";
import { claimLegacyTaskButton, LEGACY_TASK_TEXT } from "../src/lib/legacy-task-buttons";
import { getStore } from "../src/lib/store";
import { installApiFake, textReply, toolReply, type ApiFake } from "./api-fixture";
import { useChoiceFile } from "./choices-fixture";
import { useTaskTables, type Row } from "./tasks-fixture";

const OWNER = "4711";
const GROUP = "-1001234567890";
const TOPIC = 443;
const KEYS = ["BUDGET_DB_PATH", "DAILY_API_BUDGET", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "TELEGRAM_USER_ID"] as const;
const saved: Record<string, string | undefined> = {};
let dir: string;
let spies: { mockRestore(): void }[] = [];
let tables: ReturnType<typeof useTaskTables>;
let sent: { chatId: unknown; text: string; other: Record<string, any> }[];
let messageId: number;
let fake: ApiFake;
let offered: Choice[];
let uninstallOffer: () => void;

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "tybo-legacy-processors-"));
  process.env.BUDGET_DB_PATH = join(dir, "budget.sqlite");
  process.env.DAILY_API_BUDGET = "5";
  process.env.TELEGRAM_USER_ID = OWNER;
  useChoiceFile(join(dir, "choices.json"));
  spies = [spyOn(console, "log").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {})];
  tables = useTaskTables();
  sent = [];
  messageId = 900;
  fake = installApiFake();
  offered = [];
  // Wie im Bot: Rückfragen des Registers über offerAsk, Telegram als Attrappe
  uninstallOffer = installAskOffer(
    createAskOffer({ sendChoice: async (choice) => (offered.push(choice), { sent: true }), tasks: () => getStore().tasks, log: () => {} })
  );
});

afterEach(() => {
  uninstallOffer();
  fake.restore();
  tables.restore();
  for (const s of spies) s.mockRestore();
  setChoicesFileForTests(null);
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Telegram-Api wie grammY sie nutzt; sendMessage merkt sich Ziel und Knöpfe */
const fakeApi = {
  sendMessage: async (chatId: unknown, text: string, other: Record<string, any> = {}) => {
    sent.push({ chatId, text, other });
    return { message_id: ++messageId, date: 0, chat: { id: Number(GROUP), type: "supergroup" }, text };
  },
  sendChatAction: async () => true,
  editMessageText: async () => true,
  answerCallbackQuery: async () => true,
};

/** Klick auf einen Knopf einer Nachricht im Topic, wie grammY ihn zustellt (ohne ctx.message) */
function click(data: string, msg: number): Context {
  const update = {
    update_id: 1,
    callback_query: {
      id: "q1",
      from: { id: Number(OWNER), is_bot: false, first_name: "Alex" },
      chat_instance: "ci",
      data,
      message: {
        message_id: msg,
        date: 0,
        chat: { id: Number(GROUP), type: "supergroup", title: "G", is_forum: true },
        message_thread_id: TOPIC,
        is_topic_message: true,
        text: "Frage",
      },
    },
  };
  return new Context(update as any, fakeApi as any, { id: 1, is_bot: true, first_name: "Bot", username: "bot" } as any);
}

/** Wie die Knopf-Weiche: Ort aus dem Klick, dann beanspruchen */
async function claimFrom(ctx: Context) {
  const chatId = String(ctx.chat!.id);
  const topicId = ctx.msg?.message_thread_id;
  const place = topicId !== undefined ? { chatId, threadId: topicId } : { chatId };
  return { chatId, claim: await claimLegacyTaskButton(ctx.callbackQuery!.data!, place, { directChatIds: () => [OWNER, "web"], log: () => {} }) };
}

/** Klick durch die echte Weiche: echte Prozessoren, echtes Beanspruchen, Speicher der Attrappe */
async function routerClick(ctx: Context, over: Partial<TaskButtonDeps> = {}, saved: unknown[] = []): Promise<string[]> {
  const shown: string[] = [];
  const router = createCallbackRouter({
    topicMap: async () => "",
    checkin: async () => null,
    goal: async () => null,
    review: async () => ({ text: "" }),
    task: {
      directChatIds: () => [OWNER, "web"],
      fallbackReply: async () => "Ersatz",
      // Wie sendResponse: über ctx.reply, damit der Zustellweg mitzählt
      send: async (ctx, text) => {
        shown.push(text);
        await ctx.reply(text);
      },
      saveMessage: async (message) => void saved.push(message),
      processIntents: async () => {},
      updateTask: (id, changes) => getStore().tasks.update(id, changes),
      noteThreads: () => {},
      abortedText: () => "Abgebrochen.",
      typing: () => ({ start() {}, stop() {} }),
      ...over,
    },
  });
  await router(ctx);
  return shown;
}

function oldTask(metadata: Record<string, unknown>, options: { label: string; value: string }[]): Row {
  const row: Row = {
    id: crypto.randomUUID(),
    chat_id: GROUP,
    thread_id: TOPIC,
    original_prompt: "Plane die Woche",
    status: "needs_input",
    pending_question: "Montag?",
    pending_options: options,
    processed_by: "vps",
    metadata,
  };
  tables.tables.async_tasks.push({ created_at: new Date().toISOString(), updated_at: new Date().toISOString(), reminder_sent: false, ...row });
  return row;
}

/** Stand eines alten Auftrags aus dem Gateway: Verlauf, Antwort mit ask_user, dessen ID */
function snapshotMeta(): Record<string, any> {
  return {
    messages_snapshot: [{ role: "user", content: "Plane die Woche" }],
    assistant_content: [{ type: "tool_use", id: "tu-1", name: "ask_user", input: { question: "Montag?" } }],
    tool_use_id: "tu-1",
  };
}
const yesNo = [
  { label: "Ja", value: "ja" },
  { label: "Nein", value: "nein" },
];

test("Auftrag des früheren Agent SDK (Issue #349, #352): Klick durch die Weiche läuft über den Mac-Zweig", async () => {
  const first = oldTask({ use_agent_sdk: true, agent_sdk_session_id: "sdk-sess-1" }, [
    { label: "Ja", value: "Ja" },
    { label: "Nein", value: "Nein" },
  ]);
  const macCalls: { taskId: string; answer: string }[] = [];
  await routerClick(click(`atask:${first.id}:Ja`, 10), {
    resumeMac: async (task, answer) => {
      macCalls.push({ taskId: task.id, answer });
      return { status: "ended" };
    },
  });
  expect(macCalls).toEqual([{ taskId: first.id as string, answer: "Ja" }]);
});

test("Anthropic API (Motor api): Folgefrage nach dem Klick als Rückfrage des Registers im Topic, keine atask-Knöpfe", async () => {
  const first = oldTask(snapshotMeta(), yesNo);
  // Das Modell fragt gleich wieder nach (ask_user)
  fake.respond(toolReply([{ id: "tu-2", name: "ask_user", input: { question: "Auch Dienstag?", options: [{ label: "Ja" }, { label: "Nein" }] } }]));
  const shown = await routerClick(click(`atask:${first.id}:ja`, 10));
  expect(fake.calls()).toBe(1);
  // Stand des Auftrags plus Antwort als tool_result, wie früher „User chose: <Antwort>“
  expect(fake.lastBody().messages).toEqual([
    { role: "user", content: "Plane die Woche" },
    { role: "assistant", content: [{ type: "tool_use", id: "tu-1", name: "ask_user", input: { question: "Montag?" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "User chose: Ja" }] },
  ]);
  expect(shown).toHaveLength(1);
  expect(shown[0]).toContain("Auch Dienstag?");
  expect(tables.tables.async_tasks.find((r) => r.id === first.id)).toMatchObject({ status: "completed" });
  // Folgefrage: Rückfrage des Registers im Topic des Auftrags, an einem neuen Auftrag mit Motor api
  expect(offered).toHaveLength(1);
  expect(offered[0]).toMatchObject({ kind: "ask", state: "open", conversation: { type: "telegram", chatId: GROUP, topicId: TOPIC } });
  expect(offered[0].options.map((o) => o.label)).toEqual(["Ja", "Nein", "Abbrechen"]);
  const nextId = parseAskRef(offered[0].ref)!.taskId;
  expect(nextId).not.toBe(first.id);
  const next = tables.tables.async_tasks.find((r) => r.id === nextId)!;
  expect(next).toMatchObject({ chat_id: GROUP, thread_id: TOPIC, status: "needs_input", pending_question: "Auch Dienstag?" });
  expect(next.metadata).toMatchObject({ engine: "api", agent_name: "general" });
  expect(String(next.session_id)).toMatch(/^[0-9a-f-]{36}\.[0-9a-f]{12}$/);
  // Keine neuen atask-Knöpfe
  expect(JSON.stringify(sent)).not.toContain("atask:");
});

describe("Altknopf mit messages_snapshot über den Motor api (Issue #348)", () => {
  test("zwei Klicks gleichzeitig: genau ein Fortsetzen, Antwort im Topic des Auftrags gespeichert, Auftrag completed", async () => {
    const first = oldTask(snapshotMeta(), yesNo);
    fake.respond(textReply("Montag passt."));
    const saved: any[] = [];
    const shown = await Promise.all([routerClick(click(`atask:${first.id}:ja`, 10), {}, saved), routerClick(click(`atask:${first.id}:ja`, 10), {}, saved)]);
    expect(fake.calls()).toBe(1);
    expect(shown.flat()).toEqual(["Montag passt."]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ chat_id: GROUP, role: "assistant", content: "Montag passt.", metadata: { type: "task_resume", topicId: TOPIC } });
    expect(tables.tables.async_tasks.find((r) => r.id === first.id)).toMatchObject({ status: "completed", result: "Montag passt." });
    expect(offered).toHaveLength(0);
  });

  test("Abbrechen: Auftrag failed, kein Abruf", async () => {
    const first = oldTask(snapshotMeta(), yesNo);
    await routerClick(click(`atask:${first.id}:cancel`, 10));
    expect(fake.calls()).toBe(0);
    expect(tables.tables.async_tasks.find((r) => r.id === first.id)).toMatchObject({ status: "failed", result: "Vom Nutzer abgebrochen" });
  });

  test("Motorfehler: Ersatzantwort mit dem Auftrag und dem Chat des Klicks, Auftrag failed", async () => {
    const first = oldTask(snapshotMeta(), yesNo);
    fake.respondStatus(529, JSON.stringify({ error: { type: "overloaded_error", message: "Overloaded" } }));
    const asked: { taskId: unknown; chatId: string }[] = [];
    const shown = await routerClick(click(`atask:${first.id}:ja`, 10), {
      fallbackReply: async (task, chatId) => {
        asked.push({ taskId: task.id, chatId });
        return "Ersatz";
      },
    });
    expect(asked).toEqual([{ taskId: first.id, chatId: GROUP }]);
    expect(shown).toEqual(["Ersatz"]);
    expect(tables.tables.async_tasks.find((r) => r.id === first.id)).toMatchObject({ status: "failed" });
  });

  test("ohne Schlüssel: kein Abruf, Ersatzantwort, Auftrag failed", async () => {
    const first = oldTask(snapshotMeta(), yesNo);
    fake.setKey(undefined);
    const shown = await routerClick(click(`atask:${first.id}:ja`, 10));
    expect(fake.calls()).toBe(0);
    expect(shown).toEqual(["Ersatz"]);
    expect(tables.tables.async_tasks.find((r) => r.id === first.id)).toMatchObject({ status: "failed" });
  });

  test("unvollständiger Stand: kein Abruf, Auftrag failed, Meldung im Topic", async () => {
    const meta = snapshotMeta() as Record<string, unknown>;
    delete meta.tool_use_id;
    const first = oldTask(meta, yesNo);
    const shown = await routerClick(click(`atask:${first.id}:ja`, 10));
    expect(fake.calls()).toBe(0);
    expect(shown).toEqual([]);
    expect(tables.tables.async_tasks.find((r) => r.id === first.id)).toMatchObject({ status: "failed", result: SNAPSHOT_TEXT.incomplete });
    expect(sent.at(-1)).toMatchObject({ text: SNAPSHOT_TEXT.incomplete });
    expect(sent.at(-1)!.other.message_thread_id).toBe(TOPIC);
  });

  test("weitere Werkzeuge neben ask_user ohne gespeichertes Ergebnis: nicht fortgesetzt, nichts noch einmal ausgeführt", async () => {
    const meta = snapshotMeta();
    meta.assistant_content = [
      { type: "tool_use", id: "tu-0", name: "send_mail", input: {} },
      { type: "tool_use", id: "tu-1", name: "ask_user", input: { question: "Montag?" } },
    ];
    const first = oldTask(meta, yesNo);
    await routerClick(click(`atask:${first.id}:ja`, 10));
    expect(fake.calls()).toBe(0);
    expect(tables.tables.async_tasks.find((r) => r.id === first.id)).toMatchObject({ status: "failed", result: SNAPSHOT_TEXT.otherTools });
  });

  test("Merk-Tags nach einem fremden Werkzeug landen im Review, nicht direkt", async () => {
    const scrape: ApiToolHost = {
      offered: () => [{ name: "firecrawl_scrape", description: "Seite", input_schema: { type: "object", properties: {} } }],
      call: async () => ({ content: "Seite sagt: Montag frei", isError: false }),
      serverOf: () => undefined,
    };
    fake.use({ tools: scrape });
    const first = oldTask(snapshotMeta(), yesNo);
    fake.respond(toolReply([{ id: "s1", name: "firecrawl_scrape", input: { url: "https://example.org" } }]));
    fake.respond(textReply("Montag ist frei. [REMEMBER: Montag frei]"));
    const staged: unknown[] = [];
    const applied: string[] = [];
    const outcomes: string[] = [];
    await routerClick(click(`atask:${first.id}:ja`, 10), {
      processIntents: async (text, tools, target) => {
        expect(classifyTurnTools(tools, process.cwd()).status).toBe("foreign");
        outcomes.push(
          await processTurnIntents(text, tools, target, {
            stageMemoryReview: (async (input: unknown) => (staged.push(input), "rev-1")) as any,
            processIntents: async (t) => void applied.push(t),
            log: () => {},
          })
        );
      },
    });
    expect(outcomes).toEqual(["staged"]);
    expect(staged).toHaveLength(1);
    expect(applied).toEqual([]);
  });

  test("fremde Inhalte im gespeicherten Verlauf: Fortsetzung ohne neues Werkzeug, REMEMBER landet im Review", async () => {
    const meta = {
      messages_snapshot: [
        { role: "user", content: "Plane die Woche" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu-0", name: "firecrawl_scrape", input: { url: "https://example.org" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-0", content: "Seite sagt: Montag frei" }] },
      ],
      assistant_content: [{ type: "tool_use", id: "tu-1", name: "ask_user", input: { question: "Montag?" } }],
      tool_use_id: "tu-1",
    };
    const first = oldTask(meta, yesNo);
    // Kein neues Werkzeug in der Fortsetzung
    fake.respond(textReply("Montag ist frei. [REMEMBER: Montag frei]"));
    const staged: unknown[] = [];
    const applied: string[] = [];
    const outcomes: string[] = [];
    const seen: unknown[] = [];
    await routerClick(click(`atask:${first.id}:ja`, 10), {
      processIntents: async (text, tools, target) => {
        seen.push(tools);
        outcomes.push(
          await processTurnIntents(text, tools, target, {
            stageMemoryReview: (async (input: unknown) => (staged.push(input), "rev-1")) as any,
            processIntents: async (t) => void applied.push(t),
            log: () => {},
          })
        );
      },
    });
    expect(fake.calls()).toBe(1);
    expect(fake.lastBody().messages.slice(0, 3)).toEqual(meta.messages_snapshot);
    expect((seen[0] as any).uses).toEqual([{ name: "firecrawl_scrape", external: true }]);
    expect(classifyTurnTools(seen[0] as any, process.cwd()).status).toBe("foreign");
    expect(outcomes).toEqual(["staged"]);
    expect(staged).toHaveLength(1);
    expect(applied).toEqual([]);
    expect(tables.tables.async_tasks.find((r) => r.id === first.id)).toMatchObject({ status: "completed" });
  });

  const brokenSnapshots: [string, (m: Record<string, any>) => void][] = [
    ["tool_use ohne ID, Name und Eingabe im Verlauf", (m) => m.messages_snapshot.push({ role: "assistant", content: [{ type: "tool_use" }] }, { role: "user", content: "weiter" })],
    ["Frage ohne Eingabe", (m) => delete m.assistant_content[0].input],
    ["Verlauf beginnt beim Modell", (m) => m.messages_snapshot.unshift({ role: "assistant", content: "Hallo" })],
    ["zwei Nutzernachrichten hintereinander", (m) => m.messages_snapshot.push({ role: "user", content: "noch was" })],
    ["leerer Verlauf", (m) => (m.messages_snapshot = [])],
    ["Rolle unbekannt", (m) => (m.messages_snapshot[0].role = "system")],
    ["tool_use im Verlauf ohne tool_result", (m) => m.messages_snapshot.push({ role: "assistant", content: [{ type: "tool_use", id: "tu-0", name: "firecrawl_scrape", input: {} }] }, { role: "user", content: "weiter" })],
    ["tool_result ohne passendes tool_use", (m) => (m.messages_snapshot[0].content = [{ type: "tool_result", tool_use_id: "tu-9", content: "x" }])],
    ["Block ohne Typ in der Antwort", (m) => m.assistant_content.unshift({ text: "ohne Typ" })],
    ["Textblock ohne Text in der Antwort", (m) => m.assistant_content.unshift({ type: "text" })],
    ["Frage-Kennung doppelt im Verlauf", (m) => m.messages_snapshot.push({ role: "assistant", content: [{ type: "tool_use", id: "tu-1", name: "x", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "y" }] })],
  ];
  for (const [label, harm] of brokenSnapshots) {
    test(`ungültiger Stand (${label}): kein Abruf, keine Sitzungsdatei, Auftrag failed`, async () => {
      const meta = snapshotMeta();
      harm(meta);
      const first = oldTask(meta, yesNo);
      await routerClick(click(`atask:${first.id}:ja`, 10));
      expect(fake.calls()).toBe(0);
      expect(readdirSync(fake.sessionDir)).toEqual([]);
      expect(tables.tables.async_tasks.find((r) => r.id === first.id)).toMatchObject({ status: "failed", result: SNAPSHOT_TEXT.incomplete });
    });
  }
});
