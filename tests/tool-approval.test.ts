/**
 * Issue #116, Schritt 1: gemeinsamer Freigabe-Handler über das
 * Rückfragen-Register. Echtes Register mit eigener Datei, Telegram über
 * createTelegramChoices mit Api- und Sende-Attrappe; gezählt werden echte
 * Werkzeugaufrufe über callBuiltinTool, nicht nur Register-Entscheidungen.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Composer, Context } from "grammy";
import {
  createChoice,
  decideChoice,
  expireLapsedChoices,
  getChoice,
  listChoices,
  setChoicesFileForTests,
  type Choice,
} from "../src/lib/choices";
import { abortExecutions, runExecution } from "../src/lib/execution-context";
import { createTelegramChoices, installTelegramChoices, type TelegramChoices } from "../src/lib/telegram-choices";
import {
  conversationForExecution,
  createChoiceToolApproval,
  expireOrphanedToolChoices,
  TOOL_APPROVAL_TIMEOUT_MS,
  webCopyNote,
  type ChoiceToolApproval,
  type ToolApprovalPresenter,
} from "../src/lib/tool-approval";
import { legacyToolApprovalMiddleware, LEGACY_EXPIRED_TEXT } from "../src/lib/telegram-tool-approval";
import { callBuiltinTool, registerBuiltinTool, setToolApprovalHandler } from "../src/lib/tools/registry";
import type { SendAndRecordInput } from "../src/lib/outbox";

const OWNER = "4711";
const GROUP = "-100200300";
const WEB_ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const WEB_ID_2 = "1f0e0d0c-0b0a-4908-8706-050403020100";

const base = mkdtempSync(join(tmpdir(), "tool-approval-"));
let counter = 0;
let logSpy: ReturnType<typeof spyOn>;

// Werkzeug mit Freigabe, zählt echte Ausführungen
let executions: Record<string, unknown>[] = [];
registerBuiltinTool({
  name: "test_issue116_write",
  description: "Schreibt etwas (Test Issue 116)",
  inputSchema: { type: "object", properties: {} },
  requiresApproval: true,
  isAvailable: () => true,
  handler: async args => {
    executions.push(args);
    return "geschrieben";
  },
});

interface ApiCall {
  method: string;
  args: unknown[];
}
let calls: ApiCall[] = [];
const fakeApi = {
  answerCallbackQuery: async (...args: unknown[]) => {
    calls.push({ method: "answerCallbackQuery", args });
    return true;
  },
  editMessageText: async (...args: unknown[]) => {
    calls.push({ method: "editMessageText", args });
    return true;
  },
  editMessageReplyMarkup: async (...args: unknown[]) => {
    calls.push({ method: "editMessageReplyMarkup", args });
    return true;
  },
};

let sends: SendAndRecordInput[] = [];
let failSend = false;
let messageId = 100;
let telegram: TelegramChoices;
let composer: Composer<Context>;
let approval: ChoiceToolApproval;
let presenters: Map<string, ToolApprovalPresenter>;
let timers: { fn: () => void; ms: number; cancelled: boolean }[];
let cleanup: (() => void)[] = [];

function setup(options: { fakeTimers?: boolean } = {}) {
  approval?.dispose();
  approval = createChoiceToolApproval({
    sendChoice: choice => telegram.sendChoice(choice),
    presenter: key => presenters.get(key),
    log: () => {},
    ...(options.fakeTimers
      ? {
          schedule: (fn: () => void, ms: number) => {
            const t = { fn, ms, cancelled: false };
            timers.push(t);
            return () => {
              t.cancelled = true;
            };
          },
        }
      : {}),
  });
  setToolApprovalHandler(approval.handler);
}

beforeEach(() => {
  setChoicesFileForTests(join(base, `choices-${++counter}.json`));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  executions = [];
  calls = [];
  sends = [];
  failSend = false;
  presenters = new Map();
  timers = [];
  cleanup = [];
  telegram = createTelegramChoices({
    api: fakeApi,
    owner: OWNER,
    log: () => {},
    send: async input => {
      sends.push(input);
      if (failSend) return { sent: false, recorded: false, error: { kind: "send", message: "kaputt" } };
      const chatId = input.chatId ?? OWNER;
      return { sent: true, recorded: true, messages: [{ chatId, messageId: ++messageId, buttons: true }] } as any;
    },
  });
  composer = new Composer<Context>();
  composer.use(async (ctx, next) => {
    if (String(ctx.from?.id || "") !== OWNER) return;
    await next();
  });
  composer.on("callback_query:data", legacyToolApprovalMiddleware(OWNER));
  cleanup.push(installTelegramChoices(composer, telegram));
  setup();
});
afterEach(() => {
  approval.dispose();
  setToolApprovalHandler(null);
  for (const off of cleanup) off();
  logSpy.mockRestore();
});
afterAll(() => {
  setChoicesFileForTests(null);
  rmSync(base, { recursive: true, force: true });
});

async function waitUntil(fn: () => boolean | Promise<boolean>, ms = 2000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung");
    await new Promise(r => setTimeout(r, 5));
  }
}

/** Werkzeug unter einem Ausführungsschlüssel aufrufen, wie ein Fallback-Turn */
function callTool(key: string, args: Record<string, unknown> = { text: "hallo" }) {
  return runExecution(key, "general", () => callBuiltinTool("test_issue116_write", args));
}

async function openChoice(): Promise<Choice> {
  await waitUntil(async () => (await listChoices()).some(c => c.state === "open" && (c.telegram?.length ?? 0) > 0));
  return (await listChoices()).find(c => c.state === "open")!;
}

async function click(data: string, msg: { chatId: string; messageId: number }) {
  const update = {
    update_id: 1,
    callback_query: {
      id: "q1",
      from: { id: Number(OWNER), is_bot: false, first_name: "E" },
      chat_instance: "ci",
      data,
      message: { message_id: msg.messageId, date: 0, chat: { id: Number(msg.chatId), type: "private", first_name: "E" } },
    },
  };
  const ctx = new Context(update as any, fakeApi as any, { id: 1, is_bot: true, first_name: "Bot", username: "bot" } as any);
  await composer.middleware()(ctx, async () => {});
}

describe("Gespräch aus dem Ausführungsschlüssel", () => {
  test("web, Direktchat, Topic, General; alles andere unbekannt", () => {
    expect(conversationForExecution(`web:${WEB_ID}`)).toEqual({ type: "web", conversationId: WEB_ID });
    expect(conversationForExecution(`dm:${OWNER}`)).toEqual({ type: "telegram", chatId: OWNER });
    expect(conversationForExecution(`topic:${GROUP}:7`)).toEqual({ type: "telegram", chatId: GROUP, topicId: 7 });
    expect(conversationForExecution(`group:${GROUP}`)).toEqual({ type: "telegram", chatId: GROUP });
    for (const key of [undefined, "", "web:abc", "dm:-1", "group:123", "topic:123:7", `topic:${GROUP}:0`, `topic:${GROUP}:x`, "goal:1", `dm:${OWNER}:x`, "cli"]) {
      expect(conversationForExecution(key)).toBeNull();
    }
  });

  test("Hinweis an der Kopie im Direktchat", () => {
    expect(webCopyNote("Reise planen")).toBe("(Web-Gespräch „Reise planen“)");
    expect(webCopyNote(undefined)).toBe("(Web-Gespräch)");
    expect(webCopyNote("a\u0000„b“")).toBe("(Web-Gespräch „a b“)");
  });
});

describe("Frage im Gespräch des Turns", () => {
  test("Topic: Frage im Topic, Klick in Telegram gibt frei, Werkzeug läuft genau einmal", async () => {
    const run = callTool(`topic:${GROUP}:7`);
    const c = await openChoice();
    expect(c).toMatchObject({ kind: "tool", conversation: { type: "telegram", chatId: GROUP, topicId: 7 }, ref: "test_issue116_write" });
    expect(c.options.map(o => o.label)).toEqual(["Erlauben", "Ablehnen"]);
    expect(c.text).toContain("Freigabe nötig: Werkzeug test_issue116_write");
    expect(c.text).toContain('{"text":"hallo"}');
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ chatId: GROUP, topicId: 7, choiceId: c.id, source: "freigabe" });
    const ref = c.telegram![0];
    await click(`ch|${c.id}|allow`, ref);
    await click(`ch|${c.id}|allow`, ref);
    expect(await run).toEqual({ content: "geschrieben", isError: false });
    expect(executions).toHaveLength(1);
    expect((await getChoice(c.id))!.result).toMatchObject({ key: "allow", via: "telegram" });
    expect(approval.pendingCount()).toBe(0);
  });

  test("Direktchat ohne Topic", async () => {
    const run = callTool(`dm:${OWNER}`);
    const c = await openChoice();
    expect(c.conversation).toEqual({ type: "telegram", chatId: OWNER });
    expect(sends[0].chatId).toBe(OWNER);
    expect(sends[0].topicId).toBeUndefined();
    await decideChoice(c.id, "allow", "web");
    expect((await run).isError).toBe(false);
    expect(executions).toHaveLength(1);
  });

  test("General: Gruppe ohne Thread-ID", async () => {
    const run = callTool(`group:${GROUP}`);
    const c = await openChoice();
    expect(c.conversation).toEqual({ type: "telegram", chatId: GROUP });
    expect(sends[0]).toMatchObject({ chatId: GROUP });
    expect(sends[0].topicId).toBeUndefined();
    await decideChoice(c.id, "deny", "telegram");
    expect((await run).isError).toBe(true);
    expect(executions).toHaveLength(0);
  });

  test("reines Web-Gespräch: Frage im Browser, Kopie mit Titel im Direktchat, beide an derselben Frage", async () => {
    const asked: { id: string; question: string }[] = [];
    const ended: string[] = [];
    presenters.set(`web:${WEB_ID}`, {
      title: "Reise planen",
      ask: async (choice, question) => {
        asked.push({ id: choice.id, question });
      },
      end: id => {
        ended.push(id);
      },
    });
    const run = callTool(`web:${WEB_ID}`);
    const c = await openChoice();
    expect(c.conversation).toEqual({ type: "web", conversationId: WEB_ID });
    expect(asked).toEqual([{ id: c.id, question: expect.stringContaining("Freigabe nötig: Werkzeug test_issue116_write") }]);
    expect(asked[0].question).toContain("„ja“");
    expect(asked[0].question).not.toContain("Web-Gespräch");
    // Kopie: Direktchat (kein chatId im Auftrag heißt Direktchat), Hinweis mit Titel, dieselbe choiceId
    expect(sends).toHaveLength(1);
    expect(sends[0].chatId).toBeUndefined();
    expect(sends[0].choiceId).toBe(c.id);
    expect(sends[0].text.startsWith("(Web-Gespräch „Reise planen“)\n")).toBe(true);
    // Klick im Browser: Werkzeug frei, Telegram-Kopie nachgezogen
    await decideChoice(c.id, "allow", "web");
    expect((await run).isError).toBe(false);
    expect(executions).toHaveLength(1);
    expect(ended).toEqual([c.id]);
    const edit = calls.find(x => x.method === "editMessageText")!;
    expect(edit.args[0]).toBe(OWNER);
    expect(edit.args[1]).toBe(c.telegram![0].messageId);
    expect(String(edit.args[2])).toContain("✓ Erlauben (im Browser)");
    expect(String(edit.args[2])).toContain("(Web-Gespräch „Reise planen“)");
  });

  test("unbekannter Schlüssel und ohne Ausführung: abgelehnt, keine Frage", async () => {
    expect((await runExecution("goal:x", "general", () => callBuiltinTool("test_issue116_write", {}))).isError).toBe(true);
    expect((await callBuiltinTool("test_issue116_write", {})).isError).toBe(true);
    expect(await listChoices()).toEqual([]);
    expect(sends).toEqual([]);
    expect(executions).toHaveLength(0);
  });

  test("weder Browser noch Telegram erreichbar: sofort abgelaufen und abgelehnt", async () => {
    failSend = true;
    const result = await callTool(`dm:${OWNER}`);
    expect(result.isError).toBe(true);
    const [c] = await listChoices();
    expect(c.state).toBe("expired");
    expect(executions).toHaveLength(0);
  });
});

describe("Ablauf, Abbruch, genau einmal", () => {
  test("nach 10 Minuten (steuerbare Zeit): Frage abgelaufen, Werkzeug abgelehnt, Knöpfe nachgezogen", async () => {
    setup({ fakeTimers: true });
    const before = Date.now();
    const run = callTool(`topic:${GROUP}:7`);
    const c = await openChoice();
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(TOOL_APPROVAL_TIMEOUT_MS);
    expect(TOOL_APPROVAL_TIMEOUT_MS).toBe(600_000);
    expect(c.expiresAt! - before).toBeGreaterThanOrEqual(600_000);
    expect(c.expiresAt! - Date.now()).toBeLessThanOrEqual(600_000);
    timers[0].fn();
    const result = await run;
    expect(result.isError).toBe(true);
    expect(result.content).toContain("abgelehnt");
    expect((await getChoice(c.id))!.state).toBe("expired");
    expect(executions).toHaveLength(0);
    expect(calls.some(x => x.method === "editMessageText" && String(x.args[2]).includes("Abgelaufen"))).toBe(true);
    // Später Klick ändert nichts mehr
    await click(`ch|${c.id}|allow`, c.telegram![0]);
    expect(executions).toHaveLength(0);
  });

  test("Frist über den regelmäßigen Ablauf (expireLapsedChoices) lehnt ebenfalls ab", async () => {
    setup({ fakeTimers: true });
    const run = callTool(`dm:${OWNER}`);
    const c = await openChoice();
    // Wie ein anderer Weg: gespeicherte Frist in der Vergangenheit, dann der Minuten-Lauf
    const file = join(base, `choices-${counter}.json`);
    const data = JSON.parse(readFileSync(file, "utf8"));
    data.choices[c.id].expiresAt = Date.now() - 1;
    writeFileSync(file, JSON.stringify(data));
    await expireLapsedChoices();
    expect((await run).isError).toBe(true);
    expect(executions).toHaveLength(0);
    expect(timers[0].cancelled).toBe(true);
  });

  test("/stop während der offenen Frage: abgelaufen und abgelehnt", async () => {
    const key = `topic:${GROUP}:9`;
    const run = callTool(key).catch(e => ({ thrown: e }));
    const c = await openChoice();
    expect(abortExecutions(key)).toBe(1);
    const result: any = await run;
    // Abgebrochen: entweder Ablehnung oder AbortError, nie Ausführung
    expect(result.thrown?.name === "AbortError" || result.isError === true).toBe(true);
    await waitUntil(async () => (await getChoice(c.id))!.state === "expired");
    expect(executions).toHaveLength(0);
    // Klick danach: nichts passiert
    await click(`ch|${c.id}|allow`, c.telegram![0]);
    expect(executions).toHaveLength(0);
  });

  test("gleichzeitiger Klick in Browser und Telegram: genau eine Entscheidung, Werkzeug einmal", async () => {
    const run = callTool(`topic:${GROUP}:7`);
    const c = await openChoice();
    const [a, b] = await Promise.all([decideChoice(c.id, "allow", "web"), click(`ch|${c.id}|allow`, c.telegram![0]).then(() => null)]);
    expect(a.status === "decided" || a.status === "already").toBe(true);
    expect((await run).isError).toBe(false);
    expect(executions).toHaveLength(1);
    expect(b).toBeNull();
  });

  test("zwei parallele Gespräche: jede Frage gilt nur für ihr Werkzeug", async () => {
    presenters.set(`web:${WEB_ID}`, { ask: async () => {}, end: () => {} });
    presenters.set(`web:${WEB_ID_2}`, { ask: async () => {}, end: () => {} });
    const one = callTool(`web:${WEB_ID}`, { n: 1 });
    const two = callTool(`web:${WEB_ID_2}`, { n: 2 });
    await waitUntil(async () => (await listChoices()).filter(c => c.state === "open").length === 2);
    const all = await listChoices();
    const c1 = all.find(c => c.conversation.type === "web" && c.conversation.conversationId === WEB_ID)!;
    const c2 = all.find(c => c.conversation.type === "web" && c.conversation.conversationId === WEB_ID_2)!;
    await decideChoice(c2.id, "deny", "web");
    expect((await two).isError).toBe(true);
    expect(executions).toHaveLength(0);
    await decideChoice(c1.id, "allow", "terminal");
    expect((await one).isError).toBe(false);
    expect(executions).toEqual([{ n: 1 }]);
  });

  test("zwei Freigaben in einer Ausführung: nacheinander, nie zwei Fragen zugleich", async () => {
    const key = `dm:${OWNER}`;
    const both = runExecution(key, "general", () =>
      Promise.all([callBuiltinTool("test_issue116_write", { n: 1 }), callBuiltinTool("test_issue116_write", { n: 2 })])
    );
    const first = await openChoice();
    expect((await listChoices()).filter(c => c.state === "open")).toHaveLength(1);
    await decideChoice(first.id, "allow", "telegram");
    await waitUntil(async () => (await listChoices()).some(c => c.state === "open" && c.id !== first.id && (c.telegram?.length ?? 0) > 0));
    const second = (await listChoices()).find(c => c.state === "open")!;
    await decideChoice(second.id, "allow", "telegram");
    const results = await both;
    expect(results.every(r => !r.isError)).toBe(true);
    expect(executions).toHaveLength(2);
  });
});

describe("alte Knöpfe und Neustart", () => {
  test("toolapproval:-Knopf von vor dem Update: „Freigabe abgelaufen“, Knöpfe weg, nichts ausgeführt", async () => {
    await click("toolapproval:y:0f0e0d0c-0b0a-0908-0706-050403020100", { chatId: OWNER, messageId: 55 });
    expect(calls.find(x => x.method === "answerCallbackQuery")!.args[1]).toEqual({ text: LEGACY_EXPIRED_TEXT });
    expect(calls.some(x => x.method === "editMessageReplyMarkup")).toBe(true);
    expect(executions).toHaveLength(0);
  });

  test("offene Freigaben aus einem früheren Lauf laufen beim Start ab, andere Arten bleiben", async () => {
    const tool = await createChoice({ kind: "tool", conversation: { type: "telegram", chatId: OWNER }, text: "x", options: [{ key: "allow", label: "Erlauben" }] });
    const review = await createChoice({ kind: "review", conversation: { type: "telegram", chatId: OWNER }, text: "y", options: [{ key: "ok", label: "Ok" }] });
    expect(await expireOrphanedToolChoices()).toBe(1);
    expect((await getChoice(tool.id))!.state).toBe("expired");
    expect((await getChoice(review.id))!.state).toBe("open");
  });
});
