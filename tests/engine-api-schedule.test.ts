/**
 * Issue #348, Checkbox 5: Planungswerkzeuge des Motors "api"
 * (schedule_task, list_scheduled_tasks, cancel_scheduled_task) gegen einen
 * Datei-ScheduleStore im Temp-Ordner. Gespräch aus dem Ausführungsschlüssel
 * (runExecution), Freigabe über authorizeTool mit einem Test-Handler. Der
 * Abruf bei Anthropic ist eine Attrappe. Turns ohne Telegram
 * (EngineRequest.noTelegram) legen wie [REMIND:] nur für die WebUI an; die
 * Zustellung prüft der echte Erinnerungs-Versand mit Attrappen der Wege.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWebChatId } from "../src/lib/channels";
import { createApiEngine, type EngineRequest, type EngineResult } from "../src/lib/engines";
import { CANCEL_SCHEDULED, LIST_SCHEDULED, OWN_TOOL_NAMES, realScheduleToolDeps, SCHEDULE_TASK } from "../src/lib/engines/api-tools";
import { runExecution } from "../src/lib/execution-context";
import { createReminderSender } from "../src/lib/reminder-choices";
import { fileScheduleStore } from "../src/lib/schedule/file";
import type { ScheduledTask, ScheduleStore } from "../src/lib/schedule/contract";
import { reminderChat } from "../src/lib/schedule/remind";
import { reminderRef } from "../src/lib/schedule/overview";
import { getAllBuiltinTools, setToolApprovalHandler, type BuiltinTool } from "../src/lib/tools/registry";
import { resolveStreamingLimits, runStreamingTurn, type ChatTurnDeps, type TurnOptions } from "../src/lib/chat-turn";
import { abortExecutions } from "../src/lib/execution-context";
import { getResumableSession, getSessionsForKey, recordSessionTurn, resetSession, sessionEpoch, setSessionsFileForTests, takeExpiredSession } from "../src/lib/session-manager";
import { createBotChat, createTelegramChat } from "../src/web/bot-turn";
import { installApiFake, textReply, toolReply, type ApiFake } from "./api-fixture";

const GROUP = "-100200300";
const DM = "4711";
const WEB = "0f0e0d0c-0b0a-4908-8706-050403020100";
const NOW = Date.parse("2026-10-21T10:00:00Z");
const base = mkdtempSync(join(tmpdir(), "tybo-348-schedule-"));
let n = 0;

let fake: ApiFake;
let store: ScheduleStore;
let approvals: { tool: string; args: Record<string, unknown> }[];
let approve: boolean;
let spies: { mockRestore(): void }[];

beforeEach(() => {
  const path = join(base, `reminders-${++n}.json`);
  store = fileScheduleStore(() => path);
  approvals = [];
  approve = true;
  setToolApprovalHandler(async (tool: BuiltinTool, args) => {
    approvals.push({ tool: tool.name, args });
    return approve;
  });
  spies = [spyOn(console, "log").mockImplementation(() => {})];
  fake = installApiFake();
  // Echte Gesprächsbestimmung und echte Freigabe, nur Ablage, Uhr und Zeitzone fest
  fake.use({ schedule: { ...realScheduleToolDeps, store: () => store, now: () => NOW, timeZone: () => "Europe/Berlin" } });
});

afterEach(() => {
  fake.restore();
  setToolApprovalHandler(null);
  for (const s of spies) s.mockRestore();
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

/** Ein Lauf, in dem das Modell genau ein Werkzeug ruft; zurück kommt dessen tool_result */
async function callTool(key: string | null, name: string, input: Record<string, unknown>, extra: Partial<EngineRequest> = {}): Promise<{ result: any; run: EngineResult }> {
  fake.respond(toolReply([{ id: "s1", name, input }]));
  fake.respond(textReply("ok"));
  const go = () => createApiEngine().run({ prompt: "Plane", streaming: false, timeoutMs: 60_000, cwd: base, ...extra });
  const run = key ? await runExecution(key, "general", go) : await go();
  return { result: fake.lastBody().messages.at(-1).content[0], run };
}

describe("schedule_task", () => {
  test("Topic: nach Freigabe angelegt, Kennung und Fälligkeit zurück, Chat und Topic wie [REMIND:]", async () => {
    const { result, run } = await callTool(`topic:${GROUP}:5`, SCHEDULE_TASK, { text: "Müll rausbringen", when: "morgen 9 Uhr" });
    expect(result.is_error).toBeUndefined();
    const [task] = (await store.listAll())!;
    expect(task).toMatchObject({ chatId: GROUP, topicId: 5, kind: "reminder", text: "Müll rausbringen", status: "pending", recurrence: null });
    // morgen 9 Uhr in Europe/Berlin (Sommerzeit bis 25.10.) = 07:00 UTC
    expect(task.dueAt).toBe("2026-10-22T07:00:00.000Z");
    expect(result.content).toContain(reminderRef(task.id));
    expect(approvals).toEqual([{ tool: SCHEDULE_TASK, args: { text: "Müll rausbringen", when: "2026-10-22T07:00:00.000Z" } }]);
    expect(run.tools?.uses).toEqual([{ name: SCHEDULE_TASK }]);
  });

  test("Direktchat und reines Web-Gespräch", async () => {
    await callTool(`dm:${DM}`, SCHEDULE_TASK, { text: "A", when: "in 2 Stunden" });
    await callTool(`web:${WEB}`, SCHEDULE_TASK, { text: "B", when: "in 2 Stunden" });
    const all = (await store.listAll())!;
    expect(all.map((t) => [t.chatId, t.topicId, t.text])).toEqual([
      [DM, null, "A"],
      [`web:${WEB}`, null, "B"],
    ]);
  });

  test("Freigabe abgelehnt: nichts angelegt, is_error", async () => {
    approve = false;
    const { result } = await callTool(`dm:${DM}`, SCHEDULE_TASK, { text: "A", when: "morgen" });
    expect(result.is_error).toBe(true);
    expect(await store.listAll()).toEqual([]);
  });

  test("unlesbare Zeit: is_error mit Grund, keine Freigabe, nichts angelegt", async () => {
    const { result } = await callTool(`dm:${DM}`, SCHEDULE_TASK, { text: "A", when: "irgendwann mal" });
    expect(result).toMatchObject({ is_error: true });
    expect(result.content).toContain("nicht lesbar");
    expect(approvals).toEqual([]);
    expect(await store.listAll()).toEqual([]);
  });

  test("Ablage nicht erreichbar: is_error mit Grund", async () => {
    store = { ...store, add: async () => null };
    const { result } = await callTool(`dm:${DM}`, SCHEDULE_TASK, { text: "A", when: "morgen" });
    expect(result).toMatchObject({ is_error: true });
    expect(result.content).toContain("nicht erreichbar");
  });

  test("ohne bestimmbares Gespräch: abgelehnt, nichts angelegt", async () => {
    const without = await callTool(null, SCHEDULE_TASK, { text: "A", when: "morgen" });
    expect(without.result).toMatchObject({ is_error: true });
    const unknownKey = await callTool("irgendwas:1", SCHEDULE_TASK, { text: "A", when: "morgen" });
    expect(unknownKey.result).toMatchObject({ is_error: true });
    expect(await store.listAll()).toEqual([]);
    expect(approvals).toEqual([]);
  });
});

describe("list_scheduled_tasks", () => {
  test("nur wartende Einträge dieses Gesprächs, ohne Freigabe; leer: ein Satz", async () => {
    const empty = await callTool(`topic:${GROUP}:5`, LIST_SCHEDULED, {});
    expect(empty.result).toMatchObject({ content: "In diesem Gespräch ist nichts geplant." });
    const mine = await store.add({ chatId: GROUP, topicId: 5, text: "Meins", dueAt: new Date(NOW + 3_600_000) });
    await store.add({ chatId: GROUP, topicId: 6, text: "Anderes Topic", dueAt: new Date(NOW + 3_600_000) });
    await store.add({ chatId: GROUP, topicId: null, text: "General", dueAt: new Date(NOW + 3_600_000) });
    const gone = await store.add({ chatId: GROUP, topicId: 5, text: "Abgesagt", dueAt: new Date(NOW + 3_600_000) });
    await store.cancel(gone!.id);
    const { result } = await callTool(`topic:${GROUP}:5`, LIST_SCHEDULED, {});
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain(reminderRef(mine!.id));
    expect(result.content).toContain("Meins");
    expect(result.content).not.toContain("Anderes Topic");
    expect(result.content).not.toContain("General");
    expect(result.content).not.toContain("Abgesagt");
    expect(approvals).toEqual([]);
  });
});

describe("cancel_scheduled_task", () => {
  const due = () => new Date(NOW + 3_600_000);

  test("eigener wartender Eintrag: nach Freigabe abgesagt", async () => {
    const task = (await store.add({ chatId: DM, text: "Zahnarzt", dueAt: due() }))!;
    const { result } = await callTool(`dm:${DM}`, CANCEL_SCHEDULED, { id: reminderRef(task.id) });
    expect(result.is_error).toBeUndefined();
    expect((await store.byId(task.id))!.status).toBe("cancelled");
    expect(approvals.map((a) => a.tool)).toEqual([CANCEL_SCHEDULED]);
  });

  test("Freigabe abgelehnt: bleibt wartend", async () => {
    approve = false;
    const task = (await store.add({ chatId: DM, text: "Zahnarzt", dueAt: due() }))!;
    const { result } = await callTool(`dm:${DM}`, CANCEL_SCHEDULED, { id: reminderRef(task.id) });
    expect(result.is_error).toBe(true);
    expect((await store.byId(task.id))!.status).toBe("pending");
  });

  test("kein Treffer, mehrere Treffer, fremdes Gespräch, nicht mehr wartend: is_error, nichts geändert", async () => {
    const unknown = await callTool(`dm:${DM}`, CANCEL_SCHEDULED, { id: "abcd1234" });
    expect(unknown.result).toMatchObject({ is_error: true });

    // Mehrere Treffer: zwei Einträge, Kennung "0" passt (fast) nie eindeutig, daher die gemeinsame Vorsilbe erzwingen
    const a = (await store.addOnce("aaaa1111-0000-4000-8000-000000000001", { chatId: DM, text: "A", dueAt: due() }))!;
    const b = (await store.addOnce("aaaa1111-0000-4000-8000-000000000002", { chatId: DM, text: "B", dueAt: due() }))!;
    expect([a, b]).toEqual(["added", "added"]);
    const many = await callTool(`dm:${DM}`, CANCEL_SCHEDULED, { id: "aaaa1111" });
    expect(many.result).toMatchObject({ is_error: true });
    expect(many.result.content).toContain("mehrere");

    const foreign = (await store.add({ chatId: GROUP, topicId: 9, text: "Fremd", dueAt: due() }))!;
    const other = await callTool(`dm:${DM}`, CANCEL_SCHEDULED, { id: reminderRef(foreign.id) });
    expect(other.result).toMatchObject({ is_error: true });
    expect(other.result.content).toContain("anderen Gespräch");
    expect((await store.byId(foreign.id))!.status).toBe("pending");

    const done = (await store.add({ chatId: DM, text: "Vorbei", dueAt: due() }))!;
    await store.cancel(done.id);
    const late = await callTool(`dm:${DM}`, CANCEL_SCHEDULED, { id: reminderRef(done.id) });
    expect(late.result).toMatchObject({ is_error: true });
    expect(late.result.content).toContain("wartet nicht mehr");

    expect(approvals).toEqual([]);
    expect((await store.byId("aaaa1111-0000-4000-8000-000000000001"))!.status).toBe("pending");
  });

  test("ohne Gespräch abgelehnt", async () => {
    const task = (await store.add({ chatId: DM, text: "X", dueAt: due() }))!;
    const { result } = await callTool(null, CANCEL_SCHEDULED, { id: reminderRef(task.id) });
    expect(result).toMatchObject({ is_error: true });
    expect((await store.byId(task.id))!.status).toBe("pending");
  });
});

test("Planungswerkzeuge stehen nicht in der Registry (Fallback-Modelle und Sprach-Brücke sehen sie nicht)", () => {
  const registered = getAllBuiltinTools().map((t) => t.name);
  for (const name of OWN_TOOL_NAMES) expect(registered).not.toContain(name);
});

describe("Turns ohne Telegram und Web-Gespräche: Ziel wie reminderChat, keine Telegram-Zustellung", () => {
  const due = () => new Date(NOW + 3_600_000);

  /** Zustellung durch den echten Versand bei eingerichtetem Telegram; Wege als Attrappen */
  async function deliveredTo(task: ScheduledTask) {
    const deliver: { chatId?: string; buttons?: unknown }[] = [];
    const web: string[] = [];
    const send = createReminderSender({
      telegram: () => true,
      deliver: (async (_text: string, target: any) => (deliver.push(target), { delivered: true, outcome: "delivered", telegram: [] })) as any,
      postWeb: async (conversationId) => (web.push(conversationId), true),
      createChoice: (async (input: any) => ({ ...input, id: "c1", state: "open", createdAt: NOW })) as any,
      attach: async () => undefined,
      expire: async () => ({ status: "unknown" }) as any,
      log: () => {},
    });
    expect(await send(task, "Erinnerung")).toBe("delivered");
    return { deliver, web };
  }

  const cases: { label: string; key: string; noTelegram?: { conversationId: string }; chatId: string; topicId: number | null; web?: string }[] = [
    { label: "reines Web-Gespräch", key: `web:${WEB}`, chatId: `web:${WEB}`, topicId: null },
    { label: "reines Web-Gespräch, Turn ohne Telegram", key: `web:${WEB}`, noTelegram: { conversationId: WEB }, chatId: `web:${WEB}`, topicId: null },
    { label: "Web-Direktchat dm:web", key: "dm:web", chatId: "web", topicId: null },
    { label: "Web-Direktchat dm:web, Turn ohne Telegram", key: "dm:web", noTelegram: { conversationId: "dm" }, chatId: "webui:web", topicId: null },
    { label: "Turn ohne Telegram im Topic", key: `topic:${GROUP}:5`, noTelegram: { conversationId: "topic-5" }, chatId: `webui:${GROUP}`, topicId: 5, web: "topic-5" },
    { label: "Turn ohne Telegram im Direktchat", key: `dm:${DM}`, noTelegram: { conversationId: "dm" }, chatId: `webui:${DM}`, topicId: null, web: "dm" },
  ];

  for (const c of cases) {
    test(`${c.label}: anlegen, auflisten, absagen`, async () => {
      const extra = c.noTelegram ? { noTelegram: c.noTelegram } : {};
      // Anlegen: dieselbe Zielbestimmung wie [REMIND:]
      const made = await callTool(c.key, SCHEDULE_TASK, { text: "Blumen gießen", when: "in 2 Stunden" }, extra);
      expect(made.result.is_error).toBeUndefined();
      const [task] = (await store.listAll())!;
      expect({ chatId: task.chatId, topicId: task.topicId }).toEqual({ chatId: c.chatId, topicId: c.topicId });
      const conversation =
        c.key.startsWith("web:") ? { type: "web" as const, conversationId: WEB } : c.key.startsWith("topic:") ? { type: "telegram" as const, chatId: GROUP, topicId: 5 } : { type: "telegram" as const, chatId: c.key.slice(3) };
      expect({ chatId: task.chatId, topicId: task.topicId }).toEqual(reminderChat({ conversation, ...extra }));

      // Keine Telegram-Zustellung: nur WebUI-Gespräch bzw. Web-Chat, keine Knöpfe für Telegram
      const { deliver, web } = await deliveredTo(task);
      if (c.web) {
        expect(web).toEqual([c.web]);
        expect(deliver).toEqual([]);
      } else {
        expect(deliver).toHaveLength(1);
        expect(isWebChatId(deliver[0].chatId!)).toBe(true);
        expect(deliver[0].buttons).toBeUndefined();
      }

      // Auflisten: der Eintrag dieses Turns; ein Telegram-Eintrag desselben Topics gehört nicht dazu
      const telegramTwin = c.noTelegram && !c.key.startsWith("web:") ? await store.add({ chatId: c.key.split(":")[1], topicId: c.topicId, text: "Über Telegram", dueAt: due() }) : null;
      const listed = await callTool(c.key, LIST_SCHEDULED, {}, extra);
      expect(listed.result.content).toContain(reminderRef(task.id));
      expect(listed.result.content).not.toContain("Über Telegram");

      // Absagen: der eigene nach Freigabe; der Telegram-Eintrag bleibt unberührt
      if (telegramTwin) {
        const foreign = await callTool(c.key, CANCEL_SCHEDULED, { id: reminderRef(telegramTwin.id) }, extra);
        expect(foreign.result).toMatchObject({ is_error: true });
        expect((await store.byId(telegramTwin.id))!.status).toBe("pending");
      }
      const cancelled = await callTool(c.key, CANCEL_SCHEDULED, { id: reminderRef(task.id) }, extra);
      expect(cancelled.result.is_error).toBeUndefined();
      expect((await store.byId(task.id))!.status).toBe("cancelled");
      expect(approvals.map((a) => a.tool)).toEqual([SCHEDULE_TASK, CANCEL_SCHEDULED]);
    });
  }
});

describe("Kette ohne Telegram: WebUI-Turn, Chat-Kern, Motor api, Planungswerkzeug", () => {
  afterEach(() => setSessionsFileForTests(null));

  /** Echte Verdrahtung der WebUI (bot-turn.ts) und echter Chat-Kern mit dem Motor api; nichts geht nach Telegram */
  function chats() {
    setSessionsFileForTests(join(base, `sessions-${++n}.json`));
    const deps: Partial<ChatTurnDeps> = {
      getEngine: (() => createApiEngine()) as unknown as ChatTurnDeps["getEngine"],
      resolveEngine: (async () => ({ engine: "api", requested: "api", source: "code" })) as unknown as ChatTurnDeps["resolveEngine"],
      forgetEngineCheck: () => {},
      runFallbackChain: async () => ({ text: "ersatz", source: "openrouter", model: "m" }),
      buildPromptContext: async (o) => ({ fullPrompt: `voll: ${o.userMessage}`, fallbackContext: "" }),
      buildResumePrompt: async (o) => `weiter: ${o.userMessage}`,
      isSessionModeEnabled: () => true,
      getResumableSession,
      takeExpiredSession,
      recordSessionTurn,
      getSessionsForKey,
      sessionEpoch,
      resetSession,
      shouldDistill: () => false,
      distillSession: async () => {},
      log: async () => {},
      getAgentConfig: () => ({ model: "claude-opus-5-5" }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
      resolveStreamingLimits: () => resolveStreamingLimits({}),
      reportSecrets: () => [],
      setTimer: () => 0,
      clearTimer: () => {},
      now: () => NOW,
    };
    const telegramSent: string[] = [];
    const base_ = {
      runStreamingTurn: (o: TurnOptions) => runStreamingTurn({ ...o, deps }),
      saveMessage: async () => true,
      processIntents: async () => {},
      abortEngineCalls: (key: string) => abortExecutions(key),
      isShuttingDown: () => false,
      scheduleRestartCheck: () => {},
      log: () => {},
    };
    const web = createBotChat(base_);
    const telegram = createTelegramChat({
      ...base_,
      userId: DM,
      groupId: () => GROUP,
      agentForTopic: () => "general",
      sendPlain: async (_chat, text) => void telegramSent.push(text),
      sendAsAgent: async (_agent, _chat, text) => void telegramSent.push(text),
    });
    return { web, telegram, telegramSent, sink: { progress: () => {}, notice: () => {} } };
  }

  test("Denkauftrag im Topic: Erinnerung mit Chat und Topic nur für die WebUI, nichts nach Telegram", async () => {
    const c = chats();
    fake.respond(toolReply([{ id: "s1", name: SCHEDULE_TASK, input: { text: "Pflanzen gießen", when: "morgen 9 Uhr" } }]));
    fake.respond(textReply("Ist notiert."));
    const result = await c.telegram.runTurn({ conversationId: "topic-5", agent: "general", text: "Denkauftrag aus dem Telefongespräch: Erinnere mich", sink: c.sink, noTelegram: true });
    expect(result.text).toBe("Ist notiert.");
    const [task] = (await store.listAll())!;
    expect(task).toMatchObject({ chatId: `webui:${GROUP}`, topicId: 5, text: "Pflanzen gießen" });
    expect(c.telegramSent).toEqual([]);
    expect(approvals.map((a) => a.tool)).toEqual([SCHEDULE_TASK]);
  });

  test("getippter Turn im selben Topic: Erinnerung für Telegram wie bisher", async () => {
    const c = chats();
    fake.respond(toolReply([{ id: "s1", name: SCHEDULE_TASK, input: { text: "Pflanzen gießen", when: "morgen 9 Uhr" } }]));
    fake.respond(textReply("Ist notiert."));
    await c.telegram.runTurn({ conversationId: "topic-5", agent: "general", text: "Erinnere mich", sink: c.sink });
    const [task] = (await store.listAll())!;
    expect(task).toMatchObject({ chatId: GROUP, topicId: 5 });
  });

  test("Denkauftrag im reinen Web-Gespräch: Erinnerung im Web-Gespräch", async () => {
    const c = chats();
    fake.respond(toolReply([{ id: "s1", name: SCHEDULE_TASK, input: { text: "Pflanzen gießen", when: "morgen 9 Uhr" } }]));
    fake.respond(textReply("Ist notiert."));
    await c.web.runTurn({ conversationId: WEB, agent: "general", text: "Denkauftrag aus dem Telefongespräch: Erinnere mich", sink: c.sink, noTelegram: true });
    const [task] = (await store.listAll())!;
    expect(task).toMatchObject({ chatId: `web:${WEB}`, topicId: null });
    expect(c.telegramSent).toEqual([]);
  });
});
