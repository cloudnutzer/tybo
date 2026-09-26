/**
 * Issue #52, Nachbesserung: weitere Stellen, die Modelltext vor dem Versand
 * an Telegram kürzen, bereinigen vorher. Ein Bild an der Kürzungsgrenze
 * verlöre sonst seine schließende Klammer und bliebe für den Guard unsichtbar.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import {
  clearGoal,
  configureGoalStore,
  formatGoalStatus,
  getGoal,
  initGoalEngine,
  onAgentTurnForGoal,
  setGoal,
  type ActiveGoal,
} from "../src/lib/goal-engine";
import { sendTelegramMessage } from "../src/lib/telegram";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installTelegramToolApproval } from "../src/lib/telegram-tool-approval";
import { authorizeTool, setToolApprovalHandler, type BuiltinTool } from "../src/lib/tools/registry";
import { decideChoice, setChoicesFileForTests, type Choice } from "../src/lib/choices";
import { runExecution } from "../src/lib/execution-context";
import { createChoiceToolApproval, toolApprovalText } from "../src/lib/tool-approval";

/** Präzisierung zu #52: keine versteckte Adresse (Link oder ganzes Bild), sichtbarer Text ist erlaubt */
const hidesSecret = (s: string) => /href=\\?"https:\/\/a\.b\/geheim|!\[[^\]]*\]\(https:\/\/a\.b\/geheim[^)]*\)/.test(s);

const SECRET = "https://a.b/geheim";
/** Bild, dessen Adresse über die Kürzungsgrenze reicht */
const cutImage = (before: number) => "a".repeat(before) + `![x](${SECRET}${"z".repeat(300)}) Ende`;

afterAll(() => setToolApprovalHandler(async () => false));

describe("Goal-Status: Befund des Judge-Modells", () => {
  test("auf 300 Zeichen gekürzt, ohne Bildadresse", () => {
    const goal: ActiveGoal = {
      sessionKey: "dm:1",
      chatId: "1",
      agentName: "general",
      goal: "Ziel",
      gates: [],
      maxTurns: 10,
      turnsUsed: 1,
      status: "active",
      createdAt: 0,
      updatedAt: 0,
      lastNote: cutImage(250),
      judgeFailures: 0,
    };
    const status = formatGoalStatus(goal);
    expect(status).not.toContain("a.b/geheim");
    expect(status).toContain(`**Letzter Befund:** ${"a".repeat(250)}x Ende`);
  });
});

describe("Werkzeug-Freigabe in Telegram (VPS-Gateway, installTelegramToolApproval)", () => {
  test("Vorschau der Argumente auf 800 Zeichen gekürzt, ohne Bildadresse", async () => {
    const bot = new Bot("123:test", { botInfo: { id: 42, is_bot: true, first_name: "T", username: "t_bot" } as UserFromGetMe });
    const sent: Record<string, any>[] = [];
    bot.api.config.use(async (_prev, method, payload) => {
      if (method === "sendMessage") sent.push(payload as Record<string, any>);
      // Versand scheitert: die Freigabe gilt sofort als abgelehnt, der Test wartet nicht
      throw new Error("Attrappe");
    });
    installTelegramToolApproval(bot, "1");

    const tool: BuiltinTool = {
      name: "schreiben",
      description: "Schreibt etwas",
      inputSchema: { type: "object", properties: {} },
      requiresApproval: true,
      isAvailable: () => true,
      handler: async () => "ok",
    };
    const result = await authorizeTool(tool, { text: cutImage(700), liste: [cutImage(10)] });
    expect(result?.isError).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).not.toContain("a.b/geheim");
    expect(sent[0].text).toContain("x Ende");
    expect(sent[0].link_preview_options).toEqual({ is_disabled: true });
  });
});

describe("Werkzeug-Freigabe über das Rückfragen-Register (Issue #116)", () => {
  test("Fragetext in Register, Telegram und Browser bereinigt vor dem Kürzen, ohne Bildadresse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tybo-approval-issue52-"));
    setChoicesFileForTests(join(dir, "choices.json"));
    const sent: Choice[] = [];
    const shown: string[] = [];
    const approval = createChoiceToolApproval({
      sendChoice: async choice => {
        sent.push(choice);
        // Versand und Browser gelingen, dann sofort ablehnen: der Test wartet nicht
        queueMicrotask(() => void decideChoice(choice.id, "deny", "telegram"));
        return { sent: true };
      },
      presenter: () => ({ ask: async (_c, question) => void shown.push(question), end: () => {} }),
      log: () => {},
    });
    setToolApprovalHandler(approval.handler);
    try {
      const tool: BuiltinTool = {
        name: "schreiben",
        description: "Schreibt etwas",
        inputSchema: { type: "object", properties: {} },
        requiresApproval: true,
        isAvailable: () => true,
        handler: async () => "ok",
      };
      const result = await runExecution("web:0c1a2b3c-0000-4000-8000-000000000000", "general", () =>
        authorizeTool(tool, { text: cutImage(700), liste: [cutImage(10)] })
      );
      expect(result?.isError).toBe(true);
      expect(sent).toHaveLength(1);
      for (const text of [sent[0].text, shown[0]]) {
        expect(text).not.toContain("a.b/geheim");
        expect(text).toContain("x Ende");
      }
      expect(toolApprovalText(tool, { text: cutImage(700) })).not.toContain("a.b/geheim");
    } finally {
      approval.dispose();
      setChoicesFileForTests(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Goal-Engine: Befund des Judge-Modells bis zur Versandnutzlast", () => {
  /** Judge-Befund, dessen Bildadresse über die 500-Zeichen-Grenze reicht */
  const REASON = `Befund: ![x](${SECRET}${"z".repeat(550)}) Ende`;
  /** Kurzer Befund mit Bild und Link: bleibt als Original gespeichert */
  const SHORT = `Kurz ![Logo](${SECRET}) und [Doku](https://ok.example/doku)`;
  let reason = REASON;
  const telegram: Record<string, any>[] = [];
  const env = { judge: process.env.AUX_MODEL_JUDGE, key: process.env.OPENROUTER_API_KEY };
  const realFetch = globalThis.fetch;
  let verdict = "done";
  /** Gespeicherter Befund, wenn der nächste Arbeits-Turn beginnt, und dessen Prompt */
  let noteAtNextTurn: string | undefined;
  let nextPrompt = "";
  // Eigener Zustand statt data/goals.json des Arbeitsverzeichnisses (Issue #76)
  const goalsDir = mkdtempSync(join(tmpdir(), "bot-goals-issue52-"));

  beforeAll(() => {
    configureGoalStore({ file: join(goalsDir, "goals.json") });
    process.env.AUX_MODEL_JUDGE = "openrouter:test/judge";
    process.env.OPENROUTER_API_KEY = "test";
    // fetch-Attrappe: Judge antwortet per OpenRouter, Telegram-Aufrufe werden festgehalten
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("openrouter.ai")) {
        const content = JSON.stringify({ verdict, reason });
        return Response.json({ choices: [{ message: { content } }] });
      }
      if (target.includes("api.telegram.org")) telegram.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: {} });
    }) as typeof fetch;
    initGoalEngine({
      // Abbruch beendet die Schleife nach dem Judge ohne weiteren Turn
      callAgent: async (prompt) => {
        noteAtNextTurn = (await getGoal("test-issue52:continue"))?.lastNote;
        nextPrompt = prompt;
        return { text: "", aborted: true };
      },
      sendAsAgent: async () => {},
      // wie sendStatusMessage im Bot: Markdown als Telegram-HTML
      sendStatus: async (target, message) => {
        await sendTelegramMessage("123:test", target.chatId, message.text, { parseMode: "HTML" });
      },
    });
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (env.judge === undefined) delete process.env.AUX_MODEL_JUDGE;
    else process.env.AUX_MODEL_JUDGE = env.judge;
    if (env.key === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = env.key;
    for (const v of ["done", "wait", "continue"]) await clearGoal(`test-issue52:${v}`);
    rmSync(goalsDir, { recursive: true, force: true });
  });

  async function judge(v: string, r = REASON) {
    verdict = v;
    reason = r;
    telegram.length = 0;
    const sessionKey = `test-issue52:${v}`;
    await setGoal({ sessionKey, chatId: "1", agentName: "general", goal: "Ziel" });
    await onAgentTurnForGoal(sessionKey, "general", "Antwort des Agenten");
    return sessionKey;
  }

  test("done: finishGoal sendet den Befund ohne Bildadresse", async () => {
    await judge("done");
    expect(telegram).toHaveLength(1);
    expect(telegram[0].parse_mode).toBe("HTML");
    expect(hidesSecret(JSON.stringify(telegram))).toBe(false);
    expect(telegram[0].text).toContain("Befund:");
  });

  test("wait: Pause-Meldung und gespeicherter Befund ohne Bildadresse", async () => {
    const sessionKey = await judge("wait");
    expect(hidesSecret(JSON.stringify(telegram))).toBe(false);
    expect(telegram.some(b => String(b.text).includes("Befund:"))).toBe(true);
    const g = await getGoal(sessionKey);
    expect(g?.lastNote).toStartWith("Befund: ");
  });

  test("continue: gespeicherter Befund und /goal-Status ohne Bildadresse", async () => {
    const sessionKey = await judge("continue");
    expect(noteAtNextTurn).toStartWith("Befund: ");
    const g = await getGoal(sessionKey);
    telegram.length = 0;
    await sendTelegramMessage("123:test", "1", formatGoalStatus({ ...g!, lastNote: noteAtNextTurn }), { parseMode: "HTML" });
    expect(hidesSecret(JSON.stringify(telegram))).toBe(false);
    expect(telegram[0].text).toContain("Letzter Befund:");
  });

  // Hinweis der Prüfung, Runde 5: Original und Telegram-Ausgabe getrennt halten
  test("kurzer Befund: gespeichert und im Prompt als Original, in Telegram ohne Bildadresse", async () => {
    const sessionKey = await judge("wait", SHORT);
    expect((await getGoal(sessionKey))?.lastNote).toBe(SHORT);
    expect(JSON.stringify(telegram)).not.toContain("a.b/geheim");
    expect(telegram.some(b => String(b.text).includes('Kurz Logo und <a href="https://ok.example/doku">Doku</a>'))).toBe(true);

    await judge("continue", SHORT);
    expect(noteAtNextTurn).toBe(SHORT);
    expect(nextPrompt).toContain(SHORT);
  });
});
