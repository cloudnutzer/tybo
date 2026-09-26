/**
 * /goal im Befehls-Register (Issue #76): Telegram-Antworten wortgleich mit
 * der früheren if-Kette in src/bot.ts (Texte aus dem Stand vor dem Umzug
 * kopiert), gleiche Erkennung in Browser und Terminal, gemeinsame Aktionen.
 * Echte Goal-Engine mit eigenem Zustand im Temp-Verzeichnis; die Arbeit am
 * Ziel (start) ist eine Attrappe, src/bot.ts wird nie geladen.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { commandRegistry } from "../src/lib/commands/builtin";
import { runTelegramCommand } from "../src/lib/commands/telegram";
import type { CommandServices, GoalCommandServices } from "../src/lib/commands/types";
import { runGoalAction } from "../src/lib/goal-actions";
import { configureGoalStore, formatGoalStatus, getGoal, initGoalEngine, setGoal, updateGoal } from "../src/lib/goal-engine";
import { markdownToTelegramHTML } from "../src/lib/telegram";
import { createChoice, getChoice, setChoicesFileForTests } from "../src/lib/choices";
import { createGoalChoices, GOAL_BUDGET_OPTIONS } from "../src/lib/goal-choices";
import { onGoalChange } from "../src/lib/goal-engine";

const dir = mkdtempSync(join(tmpdir(), "bot-commands-goal-"));
const file = join(dir, "goals.json");
const aborts: string[] = [];
const started: string[] = [];

beforeAll(() => {
  configureGoalStore({ file });
  // Die Engine arbeitet hier nie selbst (start ist eine Attrappe); nur für resume nötig
  initGoalEngine({
    callAgent: async () => ({ text: "", aborted: true }),
    sendAsAgent: async () => {},
    sendStatus: async () => {},
  });
});
afterAll(() => {
  setChoicesFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  aborts.length = 0;
  started.length = 0;
});

const goals: GoalCommandServices = {
  get: getGoal,
  set: setGoal,
  update: updateGoal,
  action: (key, action) => runGoalAction(key, action, { abort: k => (aborts.push(k), 0) }),
  start: key => void started.push(key),
  formatStatus: formatGoalStatus,
};

function services(): CommandServices {
  return {
    isSessionModeEnabled: () => true,
    getGoal,
    pauseGoal: async () => {},
    abortClaudeCalls: key => (aborts.push(key), 0),
    goals,
  } as unknown as CommandServices;
}

let topic = 100;
type Sent = { text: string; other?: Record<string, unknown> };

async function run(text: string, topicId: number, opts: { htmlFails?: boolean } = {}): Promise<Sent[]> {
  const sent: Sent[] = [];
  const match = commandRegistry.match(text, "telegram");
  if (!match) throw new Error(`kein Befehl: ${text}`);
  await runTelegramCommand({
    chat: {
      async reply(t, other) {
        if (opts.htmlFails && other?.parse_mode === "HTML") throw new Error("400");
        sent.push(other ? { text: t, other } : { text: t });
      },
    },
    chatId: "-1001",
    topicId,
    sessionKey: `topic:-1001:${topicId}`,
    agent: "research",
    text,
    match,
    services: services(),
    working: () => () => {},
    resetSession: async () => ({ status: "done", reset: 0, sessionMode: true }),
    agentTurn: async () => {},
    boardMeeting: async () => {},
  });
  return sent;
}

const html = (md: string) => ({ text: markdownToTelegramHTML(md), other: { parse_mode: "HTML" } });

describe("/goal in Telegram, wortgleich mit der früheren if-Kette", () => {
  test("ohne Ziel: Status, pause, weiter, stop, gate, max", async () => {
    const t = ++topic;
    const none =
      "Kein aktives Ziel in diesem Topic.\n\nSo geht's: `/goal <was erreicht werden soll>`: ich arbeite dann selbststaendig weiter, bis es erreicht ist (oder das Turn-Budget aufgebraucht ist und ich nachfrage).";
    expect(await run("/goal", t)).toEqual([html(none)]);
    expect(await run("/goal status", t)).toEqual([html(none)]);
    expect(await run("/goal", t, { htmlFails: true })).toEqual([{ text: none }]);
    expect(await run("/goal pause", t)).toEqual([{ text: "Kein aktives Ziel in diesem Topic." }]);
    expect(await run("/goal weiter", t)).toEqual([{ text: "Kein Ziel in diesem Topic. Neu setzen: /goal <text>" }]);
    expect(await run("/goal stop", t)).toEqual([{ text: "Kein Ziel in diesem Topic." }]);
    // Wie bisher bricht /goal stop auch ohne Ziel laufende Aufrufe ab
    expect(aborts).toEqual([`topic:-1001:${t}`]);
    expect(await run("/goal gate add bun test", t)).toEqual([{ text: "Erst ein Ziel setzen (/goal <text>), dann Gates hinzufuegen." }]);
    expect(await run("/goal max 5", t)).toEqual([{ text: "Kein Ziel in diesem Topic. Neu setzen: /goal <text>" }]);
    expect(await run("/goal max 0", t)).toEqual([{ text: "Nutzung: /goal max <1-100>" }]);
  });

  test("Ziel setzen, Gates, Budget, pausieren, fortsetzen, beenden", async () => {
    const t = ++topic;
    const key = `topic:-1001:${t}`;
    expect(await run("/goal Bericht schreiben", t)).toEqual([
      {
        text: '🎯 Ziel gesetzt (Agent: research, Budget: 10 Turns):\n"Bericht schreiben"\n\nIch lege los und arbeite selbststaendig weiter, bis es erreicht ist. Nach jedem Schritt prueft ein Judge den Stand. Bei Budget-Ende frage ich nach.\n\n/stop bricht ab · /goal pause pausiert · /goal gate add <cmd> ergaenzt einen harten Check.',
      },
    ]);
    expect(started).toEqual([key]);
    expect(await getGoal(key)).toMatchObject({ chatId: "-1001", topicId: t, agentName: "research", goal: "Bericht schreiben", status: "active" });

    expect(await run("/goal gate list", t)).toEqual([{ text: "Keine Gates gesetzt. Hinzufuegen: /goal gate add <shell-kommando>" }]);
    expect(await run("/goal gate add bun test", t)).toEqual([
      { text: 'Gate hinzugefuegt: `bun test`\nEs muss mit Exit 0 durchlaufen, bevor der Judge "fertig" sagen darf.' },
    ]);
    expect(await run("/goal gate add", t)).toEqual([{ text: "Nutzung: /goal gate add <cmd> · /goal gate list · /goal gate clear" }]);
    expect(await run("/goal gate add   ", t)).toEqual([{ text: "Nutzung: /goal gate add <cmd> · /goal gate list · /goal gate clear" }]);
    expect(await run("/goal gate list", t)).toEqual([{ text: "Gates:\n1. bun test" }]);
    expect(await run("/goal gate foo", t)).toEqual([{ text: "Nutzung: /goal gate add <cmd> · /goal gate list · /goal gate clear" }]);
    expect(await run("/goal gate clear", t)).toEqual([{ text: "Alle Gates entfernt." }]);
    expect(await run("/goal max 7", t)).toEqual([{ text: "Turn-Budget: 7." }]);

    const status = await run("/goal status", t);
    expect(status[0].text).toContain("aktiv, Turn 0/7");

    expect(await run("/goal pause", t)).toEqual([{ text: "⏸️ Ziel pausiert. /goal weiter setzt fort." }]);
    expect((await getGoal(key))?.status).toBe("paused");
    expect(await run("/goal weiter", t)).toEqual([{ text: "▶️ Weiter geht's, ich arbeite am Ziel." }]);
    // /goal weiter gibt keine zusätzlichen Turns (der Telegram-Knopf gibt +5)
    expect((await getGoal(key))?.maxTurns).toBe(7);

    expect(await run("/goal abbrechen", t)).toEqual([{ text: '🛑 Ziel beendet: "Bericht schreiben"' }]);
    expect(await getGoal(key)).toBeUndefined();
    expect(aborts).toEqual([key]);
  });

  test("Aliase resume, continue, cancel, done", async () => {
    for (const [word, text] of [
      ["resume", "▶️ Weiter geht's, ich arbeite am Ziel."],
      ["continue", "▶️ Weiter geht's, ich arbeite am Ziel."],
      ["cancel", '🛑 Ziel beendet: "Z"'],
      ["done", '🛑 Ziel beendet: "Z"'],
    ]) {
      const t = ++topic;
      await run("/goal Z", t);
      await updateGoal(`topic:-1001:${t}`, {});
      await run("/goal pause", t);
      expect(await run(`/goal ${word}`, t)).toEqual([{ text }]);
    }
  });

  test("im Direktchat bzw. General: Agent general, Schlüssel ohne Topic", async () => {
    const sent: Sent[] = [];
    const text = "/goal Inbox leeren";
    await runTelegramCommand({
      chat: { reply: async t => void sent.push({ text: t }) },
      chatId: "4711",
      sessionKey: "dm:4711",
      agent: "general",
      text,
      match: commandRegistry.match(text, "telegram")!,
      services: services(),
      working: () => () => {},
      resetSession: async () => ({ status: "done", reset: 0, sessionMode: true }),
      agentTurn: async () => {},
      boardMeeting: async () => {},
    });
    expect(sent[0].text).toStartWith("🎯 Ziel gesetzt (Agent: general, Budget: 10 Turns)");
    const g = await getGoal("dm:4711");
    expect(g).toMatchObject({ chatId: "4711", agentName: "general" });
    expect(g!.topicId).toBeUndefined();
  });
});

describe("Erkennung in allen Kanälen", () => {
  test("/goal mit und ohne Argument; /goals bleibt ein eigener Befehl", () => {
    for (const channel of ["telegram", "web", "terminal"] as const) {
      expect(commandRegistry.match("/goal", channel)?.command.name).toBe("goal");
      expect(commandRegistry.match("/Goal pause", channel)).toMatchObject({ command: { name: "goal" }, args: "pause" });
      expect(commandRegistry.match("/goals", channel)?.command.name).toBe("goals");
      expect(commandRegistry.match("/goalie", channel)).toBeNull();
    }
    // Telegram wie bisher nur mit Leerzeichen als Trenner
    expect(commandRegistry.match("/goal\nX", "telegram")).toBeNull();
    expect(commandRegistry.match("/goal\nX", "web")?.command.name).toBe("goal");
    expect(commandRegistry.list("web").some(c => c.name === "goal")).toBe(true);
    expect(commandRegistry.list("terminal").some(c => c.name === "goal")).toBe(true);
  });

  test("pause und stop (samt Aliasen) laufen in Browser und Terminal ohne Update-Bereich", () => {
    const goal = commandRegistry.get("goal")!;
    for (const args of ["pause", "stop", "Stop", "cancel", "done", "abbrechen"]) expect(goal.unscoped?.(args)).toBe(true);
    for (const args of ["", "status", "weiter", "Bericht schreiben", "max 3"]) expect(goal.unscoped?.(args)).toBe(false);
  });

  test("ältere Web-Gespräche: kein Ziel, verständliche Antwort", async () => {
    const replies: string[] = [];
    const match = commandRegistry.match("/goal X", "web")!;
    await match.command.run({
      channel: "web",
      chatId: "web:abc",
      sessionKey: "web:abc",
      agent: "general",
      name: "goal",
      args: match.args,
      text: "/goal X",
      reply: async t => void replies.push(t),
      notice: async () => {},
      buttons: async () => {},
      working: () => () => {},
      resetSession: async () => ({ status: "unavailable" }),
      agentTurn: async () => {},
      boardMeeting: async () => {},
      services: services(),
    });
    expect(replies).toEqual(["Ziele gehen nur im Direktchat und in Telegram-Topics, nicht in älteren Web-Gesprächen."]);
    expect(await getGoal("web:abc")).toBeUndefined();
  });

  test("offene Budget-Frage (Issue #118): /goal stop, neues /goal, /goal weiter, /goal max und /goal pause lassen sie ablaufen", async () => {
    setChoicesFileForTests(join(dir, "choices.json"));
    const goalChoices = createGoalChoices({ getGoal, abort: () => 0, sendChoice: async () => ({ sent: true }), log: () => {} });
    const off = onGoalChange(goalChoices.listener);
    try {
      /** Ziel am Budget mit offener Budget-Frage, wie nach workLoop */
      const atBudget = async (t: number) => {
        const key = `topic:-1001:${t}`;
        const g = await setGoal({ sessionKey: key, chatId: "-1001", topicId: t, agentName: "research", goal: "Budget" });
        await updateGoal(key, { status: "paused", budgetPaused: true, turnsUsed: 10, maxTurns: 10 });
        const choice = await createChoice({
          kind: "goal",
          conversation: { type: "telegram", chatId: "-1001", topicId: t },
          text: "Weitermachen?",
          options: GOAL_BUDGET_OPTIONS,
          ref: String(g.createdAt),
        });
        await goalChoices.settled();
        return choice.id;
      };
      const stateAfter = async (id: string) => {
        await goalChoices.settled();
        return (await getChoice(id))?.state;
      };
      for (const [command, expected] of [
        ["/goal stop", "expired"],
        ["/goal Neues Ziel", "expired"],
        ["/goal weiter", "expired"],
        ["/goal max 20", "expired"],
        // Manuelle Pause: kein Budget-Stopp mehr, Weiter (+5) passt nicht mehr
        ["/goal pause", "expired"],
        ["/goal status", "open"],
        ["/goal gate add bun test", "open"],
      ] as const) {
        const t = ++topic;
        const id = await atBudget(t);
        await run(command, t);
        expect([command, await stateAfter(id)]).toEqual([command, expected]);
        await run("/goal stop", t);
      }
    } finally {
      off();
      await goalChoices.settled();
    }
  });

  test("Zustand in der eingestellten Datei", () => {
    expect(readFileSync(file, "utf-8")).toContain("topic:-1001:");
  });
});
