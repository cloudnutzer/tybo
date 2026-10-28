/**
 * /goal "Weiter?" über das Rückfragen-Register (Issue #118): Budget-Frage als
 * Rückfrage kind "goal" mit goalId, Handler über runGoalAction, Ablauf bei
 * Ende, Ersatz und Fortsetzen des Ziels, Telegram-Nachziehen.
 * Echte Goal-Engine und echtes Register (je eine Datei im Temp-Verzeichnis),
 * echte Telegram-Seite der Rückfragen mit Api- und Sende-Attrappe; wie in
 * src/bot.ts verdrahtet, src/bot.ts wird nie geladen.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Composer, Context } from "grammy";
import {
  createChoice,
  decideChoice,
  getChoice,
  listChoices,
  onChoiceDecided,
  setChoicesFileForTests,
  type Choice,
  type CreateChoiceInput,
} from "../src/lib/choices";
import { createTelegramGoalStatus, GOAL_CALLBACK_TEXT, handleGoalCallback, runGoalAction } from "../src/lib/goal-actions";
import { createGoalChoices, GOAL_BUDGET_OPTIONS, GOAL_NO_BUTTONS_HINT, goalIdOf, type GoalChoices } from "../src/lib/goal-choices";
import {
  clearGoal,
  configureGoalStore,
  getGoal,
  initGoalEngine,
  isGoalLoopRunning,
  onGoalChange,
  setGoal,
  startGoalWork,
  updateGoal,
} from "../src/lib/goal-engine";
import type { SendAndRecordInput } from "../src/lib/outbox";
import { createTelegramChoices, installTelegramChoices, type TelegramChoices } from "../src/lib/telegram-choices";

const OWNER = "4711";
const GROUP = "-1001234567890";
const dir = mkdtempSync(join(tmpdir(), "tybo-goal-choices-"));
const env = { judge: process.env.AUX_MODEL_JUDGE, key: process.env.OPENROUTER_API_KEY };
const realFetch = globalThis.fetch;
let verdict = "continue";

let calls: { method: string; args: unknown[] }[] = [];
const fakeApi = {
  answerCallbackQuery: async (...args: unknown[]) => void calls.push({ method: "answerCallbackQuery", args }),
  editMessageText: async (...args: unknown[]) => void calls.push({ method: "editMessageText", args }),
  editMessageReplyMarkup: async (...args: unknown[]) => void calls.push({ method: "editMessageReplyMarkup", args }),
};

/** Gesendete Rückfragen (sendAndRecord-Attrappe) */
let sends: SendAndRecordInput[] = [];
/** Statusmeldungen ohne Rückfrage (send der Telegram-Ausgabe) */
let plain: string[] = [];
let recorded: string[] = [];
let aborts: string[] = [];
let messageId = 100;
let pendingTurn: ((r: { text: string; aborted: boolean }) => void) | null = null;
let turns = 0;
/** Solange gesetzt, wartet das Anlegen der Budget-Frage darauf */
let createGate: Promise<void> | null = null;
let createHeld = false;

let telegram: TelegramChoices;
let goalChoices: GoalChoices;
let composer: Composer<Context>;
let cleanup: (() => void)[] = [];
let logSpy: ReturnType<typeof spyOn>;

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(2);
  }
}

beforeAll(() => {
  configureGoalStore({ file: join(dir, "goals.json") });
  process.env.AUX_MODEL_JUDGE = "openrouter:test/judge";
  process.env.OPENROUTER_API_KEY = "test";
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).includes("openrouter.ai")) {
      return Response.json({ choices: [{ message: { content: JSON.stringify({ verdict, reason: "Befund" }) } }] });
    }
    return Response.json({ ok: true, result: {} });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (env.judge === undefined) delete process.env.AUX_MODEL_JUDGE;
  else process.env.AUX_MODEL_JUDGE = env.judge;
  if (env.key === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = env.key;
  setChoicesFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
let topic = 0;
let key = "";
beforeEach(() => {
  setChoicesFileForTests(join(dir, `choices-${++n}.json`));
  topic = 500 + n;
  key = `topic:${GROUP}:${topic}`;
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  calls = [];
  sends = [];
  plain = [];
  recorded = [];
  aborts = [];
  pendingTurn = null;
  turns = 0;
  verdict = "continue";
  createGate = null;
  createHeld = false;
  cleanup = [];

  telegram = createTelegramChoices({
    api: fakeApi,
    owner: OWNER,
    send: async input => {
      sends.push(input);
      const id = ++messageId;
      return { sent: true, recorded: true, messages: [{ chatId: input.chatId ?? OWNER, messageId: id, part: "text", buttons: true }] };
    },
    log: () => {},
  });
  composer = new Composer<Context>();
  cleanup.push(installTelegramChoices(composer, telegram));

  // Wie in src/bot.ts
  goalChoices = createGoalChoices({
    getGoal,
    abort: k => (aborts.push(k), 0),
    sendChoice: choice => telegram.sendChoice(choice),
    createChoice: async (input: CreateChoiceInput) => {
      const gate = createGate;
      if (gate) {
        createGate = null;
        createHeld = true;
        await gate;
      }
      return createChoice(input);
    },
    log: () => {},
  });
  cleanup.push(onChoiceDecided("goal", goalChoices.handler));
  cleanup.push(onGoalChange(goalChoices.listener));
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
      record: async (_t, m) => void recorded.push(m.text),
      ask: (target, text) => goalChoices.ask(target, text),
      noButtonsHint: GOAL_NO_BUTTONS_HINT,
    }),
  });
});
afterEach(async () => {
  await clearGoal(key);
  pendingTurn?.({ text: "", aborted: true });
  await waitUntil(() => !isGoalLoopRunning(key));
  await goalChoices.settled();
  for (const off of cleanup) off();
  logSpy.mockRestore();
});

async function newGoal(goal = "Bericht schreiben", patch: Parameters<typeof updateGoal>[1] = {}) {
  const g = await setGoal({ sessionKey: key, chatId: GROUP, topicId: topic, agentName: "research", goal });
  if (Object.keys(patch).length) await updateGoal(key, patch);
  return g.createdAt;
}

/** Ziel am Budget: Schleife läuft bis zur Budget-Frage */
async function atBudget(goal = "Bericht schreiben"): Promise<{ goalId: number; choice: Choice }> {
  const goalId = await newGoal(goal, { turnsUsed: 3, maxTurns: 3 });
  await startGoalWork(key);
  await goalChoices.settled();
  const open = (await listChoices()).filter(c => c.kind === "goal" && c.state === "open");
  expect(open).toHaveLength(1);
  return { goalId, choice: open[0] };
}

async function click(data: string, id: number) {
  const update = {
    update_id: 1,
    callback_query: {
      id: "q1",
      from: { id: Number(OWNER), is_bot: false, first_name: "E" },
      chat_instance: "ci",
      data,
      message: { message_id: id, date: 0, chat: { id: Number(GROUP), type: "supergroup", title: "G" } },
    },
  };
  const ctx = new Context(update as any, fakeApi as any, { id: 1, is_bot: true, first_name: "Bot", username: "bot" } as any);
  await composer.middleware()(ctx, async () => {});
}

const answers = () => calls.filter(c => c.method === "answerCallbackQuery").map(c => (c.args[1] as { text?: string } | undefined)?.text);
const editedTexts = () => calls.filter(c => c.method === "editMessageText").map(c => String(c.args[2]));
const state = async (id: string) => (await getChoice(id))?.state;

describe("Budget-Frage als Rückfrage", () => {
  test("Budget erreicht: Rückfrage kind goal mit goalId im Gespräch des Ziels, gesendet mit ch|-Knöpfen, einmal festgehalten", async () => {
    const { goalId, choice } = await atBudget();
    expect(choice).toMatchObject({
      kind: "goal",
      ref: String(goalId),
      conversation: { type: "telegram", chatId: GROUP, topicId: topic },
      options: GOAL_BUDGET_OPTIONS,
      text: '⏸️ Turn-Budget erreicht (3/3) fuer das Ziel:\n"Bericht schreiben"\n\nWeitermachen?',
      telegram: [{ chatId: GROUP, messageId }],
    });
    expect(GOAL_BUDGET_OPTIONS).toEqual([
      { key: "more", label: "Weiter (+5)" },
      { key: "stop", label: "Beenden" },
    ]);
    // sendChoice sendet und hält fest (source ziel, choiceId); send/record der Statusmeldung laufen nicht
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ chatId: GROUP, topicId: topic, source: "ziel", choiceId: choice.id, format: "plain" });
    expect(sends[0].buttons!.flat().map(b => b.callback_data)).toEqual([`ch|${choice.id}|more`, `ch|${choice.id}|stop`]);
    expect(JSON.stringify(sends)).not.toContain("goalkb|");
    expect(plain).toEqual([]);
    expect(recorded).toEqual([]);
    // Budget-Pause lässt die Frage offen, auch nach dem Ende der Schleife
    expect(await getGoal(key)).toMatchObject({ status: "paused", turnsUsed: 3, maxTurns: 3 });
    expect(await state(choice.id)).toBe("open");
  });

  test("Weiter im Browser: genau 5 Turns dazu, Telegram zeigt „(im Browser)“, zweiter Klick in Telegram ändert nichts und meldet „Schon erledigt“", async () => {
    const { choice } = await atBudget();
    const outcome = await decideChoice(choice.id, "more", "web");
    expect(outcome.status).toBe("decided");
    expect(await getGoal(key)).toMatchObject({ status: "active", maxTurns: 8, turnsUsed: 3 });
    await waitUntil(() => !!pendingTurn);
    expect(editedTexts()).toEqual(['⏸️ Turn-Budget erreicht (3/3) fuer das Ziel:\n"Bericht schreiben"\n\nWeitermachen?\n\n✓ Weiter (+5) (im Browser)']);

    await click(`ch|${choice.id}|more`, messageId);
    await click(`ch|${choice.id}|stop`, messageId);
    expect(answers()).toEqual(["Schon erledigt: Weiter (+5) im Browser", "Schon erledigt: Weiter (+5) im Browser"]);
    expect(await getGoal(key)).toMatchObject({ status: "active", maxTurns: 8 });
    expect(aborts).toEqual([]);
    expect(turns).toBe(1);
  });

  test("Beenden in Telegram: Ziel gelöscht, laufende Aufrufe abgebrochen, Nachricht nachgezogen", async () => {
    const { choice } = await atBudget();
    await click(`ch|${choice.id}|stop`, messageId);
    expect(answers()).toEqual(["✓ Beenden"]);
    expect(await getGoal(key)).toBeUndefined();
    expect(aborts).toEqual([key]);
    expect(editedTexts().at(-1)).toEndWith("\n\n✓ Beenden (in Telegram)");
    expect(await state(choice.id)).toBe("done");
  });

  test("gleichzeitig Weiter in Telegram und Beenden im Browser: genau ein Gewinner, das Ziel passt zu ihm", async () => {
    for (let round = 0; round < 4; round++) {
      calls = [];
      const { choice } = await atBudget(`Runde ${round}`);
      await Promise.all([click(`ch|${choice.id}|more`, messageId), decideChoice(choice.id, "stop", "web")]);
      const stored = await getChoice(choice.id);
      expect(stored?.state).toBe("done");
      const g = await getGoal(key);
      if (stored!.result!.key === "more") expect(g).toMatchObject({ status: "active", maxTurns: 8 });
      else expect(g).toBeUndefined();
      expect(editedTexts()).toHaveLength(1);
      pendingTurn?.({ text: "", aborted: true });
      pendingTurn = null;
      await clearGoal(key);
      await waitUntil(() => !isGoalLoopRunning(key));
      await goalChoices.settled();
    }
  });
});

describe("Ziel A wirkt nie auf Ziel B", () => {
  test("Knopf von Ziel A nach Ersatz durch Ziel B (auch am Budget): abgelaufen, B unverändert", async () => {
    const a = await atBudget("Ziel A");
    const b = await atBudget("Ziel B");
    expect(b.goalId).not.toBe(a.goalId);
    expect(await state(a.choice.id)).toBe("expired");
    await click(`ch|${a.choice.id}|more`, a.choice.telegram![0].messageId);
    await click(`ch|${a.choice.id}|stop`, a.choice.telegram![0].messageId);
    expect(answers()).toEqual(["Abgelaufen", "Abgelaufen"]);
    expect(await getGoal(key)).toMatchObject({ createdAt: b.goalId, goal: "Ziel B", status: "paused", maxTurns: 3 });
    expect(aborts).toEqual([]);
    expect(await state(b.choice.id)).toBe("open");
  });

  test("auch wenn die Frage von A noch offen wäre (Ablauf verpasst): der Handler prüft die goalId und lässt B in Ruhe", async () => {
    const a = await atBudget("Ziel A");
    // Ersatz ohne Zuhörer, wie ein Rennen, das der Ablauf nicht mehr erwischt
    for (const off of cleanup.splice(0)) off();
    cleanup.push(onChoiceDecided("goal", goalChoices.handler));
    cleanup.push(installTelegramChoices(new Composer<Context>(), telegram));
    const bId = await newGoal("Ziel B", { turnsUsed: 3, maxTurns: 3, status: "paused" });
    expect(await state(a.choice.id)).toBe("open");
    for (const option of ["more", "stop"]) {
      const choice = option === "more" ? a.choice : await createChoice({ kind: "goal", conversation: a.choice.conversation, text: "A", options: GOAL_BUDGET_OPTIONS, ref: String(a.goalId) });
      const outcome = await decideChoice(choice.id, option, "web");
      expect(outcome.status).toBe("decided");
      // Entschieden, aber als Handlerfehler vermerkt: am Ziel änderte sich nichts
      expect((outcome as { choice: Choice }).choice.handlerError?.message).toContain("nicht mehr am Budget");
    }
    expect(await getGoal(key)).toMatchObject({ createdAt: bId, goal: "Ziel B", status: "paused", maxTurns: 3 });
    expect(aborts).toEqual([]);
  });

  test("dieselbe goalId in einem anderen Gespräch: die Frage wirkt nur auf ihr eigenes", async () => {
    const { goalId, choice } = await atBudget();
    const otherKey = `topic:${GROUP}:${topic + 1000}`;
    await setGoal({ sessionKey: otherKey, chatId: GROUP, topicId: topic + 1000, agentName: "research", goal: "Anderes" });
    await updateGoal(otherKey, { createdAt: goalId, status: "paused", turnsUsed: 3, maxTurns: 3 });
    await decideChoice(choice.id, "stop", "web");
    expect(await getGoal(key)).toBeUndefined();
    expect(await getGoal(otherKey)).toMatchObject({ goal: "Anderes", maxTurns: 3 });
    await clearGoal(otherKey);
  });

  test("ref ohne gültige Kennung: Handler ändert nichts", async () => {
    expect(goalIdOf("12a")).toBeNull();
    expect(goalIdOf("0")).toBeNull();
    expect(goalIdOf(undefined)).toBeNull();
    expect(goalIdOf("1727300000000")).toBe(1727300000000);
    await newGoal("Bleibt", { turnsUsed: 3, maxTurns: 3, status: "paused" });
    const bad = await createChoice({ kind: "goal", conversation: { type: "telegram", chatId: GROUP, topicId: topic }, text: "x", options: GOAL_BUDGET_OPTIONS, ref: "kaputt" });
    const outcome = await decideChoice(bad.id, "stop", "web");
    expect((outcome as { choice: Choice }).choice.handlerError).toBeDefined();
    expect(await getGoal(key)).toMatchObject({ goal: "Bleibt" });
  });
});

describe("Ablauf, wenn das Ziel anders endet oder weitergeht", () => {
  const expiredLine = "\n\nAbgelaufen, nichts geändert";

  test("/goal stop: offene Budget-Frage läuft ab, Telegram-Knöpfe verschwinden", async () => {
    const { choice } = await atBudget();
    expect((await runGoalAction(key, "stop", { abort: k => (aborts.push(k), 0) })).status).toBe("ok");
    await goalChoices.settled();
    expect(await state(choice.id)).toBe("expired");
    expect(editedTexts()).toEqual([`⏸️ Turn-Budget erreicht (3/3) fuer das Ziel:\n"Bericht schreiben"\n\nWeitermachen?${expiredLine}`]);
    // Ein später Klick ändert nichts mehr
    await click(`ch|${choice.id}|more`, messageId);
    expect(answers()).toEqual(["Abgelaufen"]);
  });

  test("neues /goal ersetzt: die alte Frage läuft ab", async () => {
    const { choice } = await atBudget();
    await newGoal("Nachfolger", { status: "paused" });
    await goalChoices.settled();
    expect(await state(choice.id)).toBe("expired");
  });

  test("Ziel erreicht (Judge fertig) nach /goal weiter: Frage läuft schon beim Fortsetzen ab, keine neue", async () => {
    const { choice } = await atBudget();
    await updateGoal(key, { maxTurns: 4 });
    await goalChoices.settled();
    // /goal max ändert das Budget: die Frage „Weiter (+5)“ gilt nicht mehr
    expect(await state(choice.id)).toBe("expired");
    verdict = "done";
    expect((await runGoalAction(key, "resume", { abort: k => (aborts.push(k), 0) })).status).toBe("ok");
    await waitUntil(() => !!pendingTurn);
    pendingTurn!({ text: "Bericht liegt vor", aborted: false });
    await waitUntil(async () => !(await getGoal(key)) && !isGoalLoopRunning(key));
    await goalChoices.settled();
    expect(plain.some(t => t.startsWith("✅ Ziel erreicht"))).toBe(true);
    expect((await listChoices()).filter(c => c.state === "open")).toEqual([]);
  });

  test("Ziel erreicht, während die Frage offen ist (clearGoal done): Frage läuft ab", async () => {
    const { goalId, choice } = await atBudget();
    await clearGoal(key, "done", goalId);
    await goalChoices.settled();
    expect(await state(choice.id)).toBe("expired");
  });

  test("/goal weiter ohne neue Turns, erneutes Budget-Ende desselben Ziels: alte Frage abgelaufen, genau eine neue offen", async () => {
    const { goalId, choice } = await atBudget();
    expect((await runGoalAction(key, "resume", { abort: k => (aborts.push(k), 0) })).status).toBe("ok");
    await waitUntil(() => !isGoalLoopRunning(key) && sends.length === 2);
    await goalChoices.settled();
    expect(await state(choice.id)).toBe("expired");
    const open = (await listChoices()).filter(c => c.kind === "goal" && c.state === "open");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ ref: String(goalId) });
    expect(open[0].id).not.toBe(choice.id);
    expect(turns).toBe(0);
  });

  test("entschiedene Frage bleibt erledigt, auch wenn das Ziel danach pausiert", async () => {
    const { choice } = await atBudget();
    await decideChoice(choice.id, "more", "telegram");
    await waitUntil(() => !!pendingTurn);
    await updateGoal(key, { turnsUsed: 8 });
    pendingTurn!({ text: "", aborted: true });
    pendingTurn = null;
    await waitUntil(() => !isGoalLoopRunning(key));
    expect(await state(choice.id)).toBe("done");
  });

  test("Weiter in Telegram entschieden, vor dem Handler /goal pause: die Pause bleibt, kein Budget, kein Turn, Entscheidung nicht ausgeführt", async () => {
    const { goalId, choice } = await atBudget();
    // Nachziehen der Telegram-Nachricht anhalten: done ist gespeichert, der Handler wartet dahinter
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    let editHeld = false;
    const edit = fakeApi.editMessageText;
    fakeApi.editMessageText = async (...args: unknown[]) => {
      editHeld = true;
      await gate;
      return edit(...args);
    };
    try {
      const clicking = click(`ch|${choice.id}|more`, messageId);
      await waitUntil(() => editHeld);
      expect(await state(choice.id)).toBe("done");

      const paused = await runGoalAction(key, "pause", { abort: k => (aborts.push(k), 0) });
      expect(paused.status).toBe("ok");
      await goalChoices.settled();
      expect(await getGoal(key)).toMatchObject({ createdAt: goalId, status: "paused", budgetPaused: false });

      release();
      await clicking;
      await goalChoices.settled();
    } finally {
      fakeApi.editMessageText = edit;
      release();
    }
    expect(await getGoal(key)).toMatchObject({ createdAt: goalId, status: "paused", budgetPaused: false, turnsUsed: 3, maxTurns: 3 });
    expect(isGoalLoopRunning(key)).toBe(false);
    expect(turns).toBe(0);
    expect(pendingTurn).toBeNull();
    expect(aborts).toEqual([]);
    const stored = await getChoice(choice.id);
    expect(stored?.state).toBe("done");
    expect(stored?.handlerError).toBeDefined();
  });

  for (const change of ["stop", "Ersatz", "Fortsetzen"] as const) {
    test(`${change} während die Frage angelegt wird: keine veraltete offene Frage, nichts gesendet`, async () => {
      let release!: () => void;
      createGate = new Promise(resolve => (release = resolve));
      const goalId = await newGoal("Rennen", { turnsUsed: 3, maxTurns: 3 });
      const run = startGoalWork(key);
      await waitUntil(() => createHeld);
      if (change === "stop") await runGoalAction(key, "stop", { abort: k => (aborts.push(k), 0), goalId });
      else if (change === "Ersatz") await newGoal("Nachfolger", { status: "paused" });
      else await runGoalAction(key, "resume", { abort: k => (aborts.push(k), 0), goalId });
      await goalChoices.settled();
      release();
      await run;
      await waitUntil(() => !isGoalLoopRunning(key));
      await goalChoices.settled();
      const goalChoicesOf = (await listChoices()).filter(c => c.kind === "goal" && c.ref === String(goalId));
      if (change === "Fortsetzen") {
        // Sofort wieder am Budget: die erste Frage ist abgelaufen, höchstens die neue offen
        expect(goalChoicesOf.filter(c => c.state === "open").length).toBeLessThanOrEqual(1);
        expect(goalChoicesOf.filter(c => c.state === "expired").length).toBeGreaterThanOrEqual(1);
      } else {
        expect(goalChoicesOf.map(c => c.state)).toEqual(["expired"]);
        expect(sends).toEqual([]);
      }
    });
  }
});

describe("alte goalkb|-Knöpfe aus der Zeit vor dem Update", () => {
  test("wirken nur, solange ein Ziel im Gespräch ist, sonst „Kein Ziel mehr aktiv.“", async () => {
    await newGoal("Alt", { turnsUsed: 3, maxTurns: 3, status: "paused" });
    expect(await handleGoalCallback(`goalkb|more|${key}`, { abort: k => (aborts.push(k), 0) })).toBe(GOAL_CALLBACK_TEXT.more);
    expect(await getGoal(key)).toMatchObject({ maxTurns: 8, status: "active" });
    await waitUntil(() => !!pendingTurn);
    expect(await handleGoalCallback(`goalkb|stop|${key}`, { abort: k => (aborts.push(k), 0) })).toBe('🛑 Ziel beendet: "Alt"');
    expect(await handleGoalCallback(`goalkb|more|${key}`, { abort: k => (aborts.push(k), 0) })).toBe(GOAL_CALLBACK_TEXT.gone);
  });
});

describe("Register nicht erreichbar", () => {
  test("Frage lässt sich nicht anlegen: Meldung ohne Knöpfe mit den Befehlen, festgehalten, kein goalkb|", async () => {
    goalChoices = createGoalChoices({
      getGoal,
      abort: () => 0,
      sendChoice: choice => telegram.sendChoice(choice),
      createChoice: async () => {
        throw new Error("Platte voll");
      },
      log: () => {},
    });
    initGoalEngine({
      callAgent: async () => ({ text: "", aborted: true }),
      sendAsAgent: async () => {},
      sendStatus: createTelegramGoalStatus({
        send: async (_c, text, _t, keyboard) => void plain.push(`${text}${keyboard ? " [Knöpfe]" : ""}`),
        record: async (_t, m) => void recorded.push(m.text),
        ask: (target, text) => goalChoices.ask(target, text),
        noButtonsHint: GOAL_NO_BUTTONS_HINT,
      }),
    });
    await newGoal("Ohne Register", { turnsUsed: 3, maxTurns: 3 });
    await startGoalWork(key);
    const expected = `⏸️ Turn-Budget erreicht (3/3) fuer das Ziel:\n"Ohne Register"\n\nWeitermachen?\n\n${GOAL_NO_BUTTONS_HINT}`;
    expect(plain).toEqual([expected]);
    expect(recorded).toEqual([expected]);
    expect(sends).toEqual([]);
  });
});
