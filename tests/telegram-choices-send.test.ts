/**
 * Issue #114, Schritt 1: sendChoice sendet eine Rückfrage mit Knöpfen, merkt
 * die Nachricht am Register-Eintrag und hält sie mit metadata.choiceId fest.
 * Register in einer temporären Datei, Telegram und Speicher als Attrappe.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  attachChoiceTelegram,
  createChoice,
  decideChoice,
  getChoice,
  onChoiceChange,
  setChoicesFileForTests,
  type Choice,
  type ChoiceChangeType,
  type CreateChoiceInput,
} from "../src/lib/choices";
import { sendAndRecord, type OutboxDeps, type SendAndRecordInput } from "../src/lib/outbox";
import { CHOICE_SOURCES, choiceButtons, sendChoice, type SendChoiceDeps } from "../src/lib/telegram-choices";
import type { Message } from "../src/lib/supabase";

const USER = "4711";
const GROUP = "-1001234567890";

const base = mkdtempSync(join(tmpdir(), "telegram-choices-send-"));
let file = "";
let counter = 0;
let logSpy: ReturnType<typeof spyOn>;
let cleanup: (() => void)[] = [];

beforeEach(() => {
  file = join(base, `choices-${++counter}.json`);
  setChoicesFileForTests(file);
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  cleanup = [];
});
afterEach(() => {
  logSpy.mockRestore();
  for (const off of cleanup) off();
});
afterAll(() => {
  setChoicesFileForTests(null);
  rmSync(base, { recursive: true, force: true });
});

const input = (over: Partial<CreateChoiceInput> = {}): CreateChoiceInput => ({
  kind: "tool",
  conversation: { type: "telegram", chatId: USER },
  text: "Tool-Freigabe: notion_write\nSeite anlegen",
  options: [{ key: "y", label: "Erlauben" }, { key: "n", label: "Ablehnen" }],
  ...over,
});

interface Call {
  method: string;
  json: Record<string, any>;
}

/** Echte sendAndRecord mit Telegram- und Speicher-Attrappe; before läuft vor der Antwort auf sendMessage */
function harness(options: { before?: () => Promise<void>; status?: number; firstId?: number } = {}) {
  const calls: Call[] = [];
  const recorded: Message[] = [];
  const refreshed: { choice: Choice; refs: unknown[] }[] = [];
  const logs: string[] = [];
  let nextId = options.firstId ?? 900;
  const outbox: OutboxDeps = {
    botToken: "123:test-token",
    userId: USER,
    groupId: GROUP,
    outboxDir: join(base, "outbox"),
    fetch: async (url, init) => {
      calls.push({ method: url.split("/").pop() ?? "", json: JSON.parse(String(init.body)) });
      if (options.before) await options.before();
      if (options.status && options.status !== 200) return new Response("{}", { status: options.status });
      return new Response(JSON.stringify({ ok: true, result: { message_id: nextId++ } }), { status: 200 });
    },
    record: async m => {
      recorded.push(m);
      return true;
    },
    log: line => logs.push(line),
    newId: () => crypto.randomUUID(),
  };
  const deps: SendChoiceDeps = {
    send: (i: SendAndRecordInput) => sendAndRecord(i, outbox),
    refresh: async (choice, refs) => {
      refreshed.push({ choice, refs });
    },
    log: line => logs.push(line),
  };
  return { deps, calls, recorded, refreshed, logs };
}

describe("sendChoice", () => {
  test("Direktchat: Knöpfe ch|<id>|<key>, messageId gemerkt, metadata.choiceId festgehalten", async () => {
    const c = await createChoice(input());
    const h = harness();
    const r = await sendChoice(c, h.deps);
    expect(r).toEqual({ sent: true, recorded: true, messages: [{ chatId: USER, messageId: 900 }] });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].method).toBe("sendMessage");
    expect(h.calls[0].json).toEqual({
      chat_id: USER,
      text: c.text,
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[
        { text: "Erlauben", callback_data: `ch|${c.id}|y` },
        { text: "Ablehnen", callback_data: `ch|${c.id}|n` },
      ]] },
    });
    expect((await getChoice(c.id))?.telegram).toEqual([{ chatId: USER, messageId: 900 }]);
    expect(JSON.parse(readFileSync(file, "utf-8")).choices[c.id].telegram).toEqual([{ chatId: USER, messageId: 900 }]);
    expect(h.recorded).toEqual([
      { chat_id: USER, role: "assistant", content: c.text, metadata: { display_only: true, source: "freigabe", choiceId: c.id } },
    ]);
  });

  test("Topic: in die Gruppe mit Thread, topicId im Verlauf", async () => {
    const c = await createChoice(input({ kind: "review", conversation: { type: "telegram", chatId: GROUP, topicId: 42 } }));
    const h = harness();
    await sendChoice(c, h.deps);
    expect(h.calls[0].json).toMatchObject({ chat_id: GROUP, message_thread_id: 42 });
    expect(h.recorded[0]).toMatchObject({ chat_id: GROUP, metadata: { source: "review", choiceId: c.id, topicId: 42 } });
    expect((await getChoice(c.id))?.telegram).toEqual([{ chatId: GROUP, messageId: 900 }]);
  });

  test("General (Topic 1 oder Gruppe ohne Topic): ohne Thread, ohne topicId", async () => {
    for (const conversation of [
      { type: "telegram" as const, chatId: GROUP, topicId: 1 },
      { type: "telegram" as const, chatId: GROUP },
    ]) {
      const c = await createChoice(input({ kind: "goal", conversation }));
      const h = harness();
      await sendChoice(c, h.deps);
      expect(h.calls[0].json.chat_id).toBe(GROUP);
      expect(h.calls[0].json.message_thread_id).toBeUndefined();
      expect(h.recorded[0].metadata).toEqual({ display_only: true, source: "ziel", choiceId: c.id });
    }
  });

  test("reines Web-Gespräch: Kopie in den Direktchat, Bezug bleibt beim Web-Gespräch", async () => {
    const c = await createChoice(input({ kind: "topicmap", conversation: { type: "web", conversationId: "w-1" } }));
    const h = harness();
    await sendChoice(c, h.deps);
    expect(h.calls[0].json.chat_id).toBe(USER);
    expect(h.recorded[0]).toMatchObject({ chat_id: USER, metadata: { source: "topic", choiceId: c.id } });
    const stored = await getChoice(c.id);
    expect(stored?.conversation).toEqual({ type: "web", conversationId: "w-1" });
    expect(stored?.telegram).toEqual([{ chatId: USER, messageId: 900 }]);
  });

  test("source je Art", () => {
    expect(CHOICE_SOURCES).toEqual({ tool: "freigabe", review: "review", goal: "ziel", topicmap: "topic" });
  });

  test("viele Optionen: höchstens drei Knöpfe je Zeile", async () => {
    const options = Array.from({ length: 7 }, (_, i) => ({ key: `a${i}`, label: `Agent ${i}` }));
    const c = await createChoice(input({ kind: "topicmap", options }));
    expect(choiceButtons(c).map(row => row.length)).toEqual([3, 3, 1]);
  });

  test("lange Frage: nur das Stück mit den Knöpfen wird gemerkt", async () => {
    const text = Array.from({ length: 30 }, (_, i) => `Absatz ${i} ` + "x".repeat(300)).join("\n\n");
    const c = await createChoice(input({ text }));
    const h = harness();
    const r = await sendChoice(c, h.deps);
    expect(h.calls.length).toBeGreaterThan(1);
    const last = 900 + h.calls.length - 1;
    expect(r.messages).toEqual([{ chatId: USER, messageId: last }]);
    expect((await getChoice(c.id))?.telegram).toEqual([{ chatId: USER, messageId: last }]);
  });

  test("zweite Kopie wird angehängt, nicht ersetzt", async () => {
    const c = await createChoice(input());
    await sendChoice(c, harness().deps);
    await sendChoice(c, harness({ firstId: 901 }).deps);
    expect((await getChoice(c.id))?.telegram).toEqual([{ chatId: USER, messageId: 900 }, { chatId: USER, messageId: 901 }]);
  });

  test("während des Sendens entschieden: sendChoice zieht die eigene Nachricht nach", async () => {
    const c = await createChoice(input());
    const h = harness({ before: async () => { await decideChoice(c.id, "y", "web"); } });
    const r = await sendChoice(c, h.deps);
    expect(r.sent).toBe(true);
    expect(h.refreshed).toHaveLength(1);
    expect(h.refreshed[0].choice.state).toBe("done");
    expect(h.refreshed[0].choice.result).toMatchObject({ key: "y", via: "web" });
    expect(h.refreshed[0].refs).toEqual([{ chatId: USER, messageId: 900 }]);
  });

  test("Frist lief während des Sendens ab: Ablauf wird gespeichert und gemeldet, mit der Nachricht", async () => {
    const c = await createChoice(input({ expiresAt: Date.now() + 40 }));
    const events: { type: ChoiceChangeType; choice: Choice }[] = [];
    cleanup.push(onChoiceChange(e => { events.push(e); }));
    const h = harness({ before: () => new Promise(r => setTimeout(r, 60)) });
    await sendChoice(c, h.deps);
    const expired = events.filter(e => e.type === "expired");
    expect(expired).toHaveLength(1);
    expect(expired[0].choice.telegram).toEqual([{ chatId: USER, messageId: 900 }]);
    expect(h.refreshed).toHaveLength(0);
  });

  test("nicht mehr offene Frage wird nicht gesendet", async () => {
    const c = await createChoice(input());
    const decided = await decideChoice(c.id, "n", "terminal");
    const h = harness();
    expect(decided.status).toBe("decided");
    const r = await sendChoice((decided as { choice: Choice }).choice, h.deps);
    expect(r.sent).toBe(false);
    expect(h.calls).toHaveLength(0);
    const lapsed = await createChoice(input({ expiresAt: Date.now() - 1 }));
    expect((await sendChoice(lapsed, h.deps)).sent).toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  test("Telegram lehnt ab: nichts gemerkt, nichts festgehalten", async () => {
    const c = await createChoice(input());
    const h = harness({ status: 403 });
    const r = await sendChoice(c, h.deps);
    expect(r.sent).toBe(false);
    expect(h.recorded).toHaveLength(0);
    expect((await getChoice(c.id))?.telegram).toBeUndefined();
  });
});

describe("attachChoiceTelegram", () => {
  test("gleichzeitige Aufrufe verlieren nichts und tragen nichts doppelt ein", async () => {
    const c = await createChoice(input());
    await Promise.all([
      attachChoiceTelegram(c.id, [{ chatId: USER, messageId: 1 }]),
      attachChoiceTelegram(c.id, [{ chatId: GROUP, messageId: 2 }, { chatId: GROUP, messageId: 2 }]),
      attachChoiceTelegram(c.id, [{ chatId: USER, messageId: 1 }]),
    ]);
    expect((await getChoice(c.id))?.telegram).toEqual([{ chatId: USER, messageId: 1 }, { chatId: GROUP, messageId: 2 }]);
  });

  test("unbekannte Frage: undefined; ungültige Bezüge werden verworfen", async () => {
    expect(await attachChoiceTelegram("Unbekannt1", [{ chatId: USER, messageId: 1 }])).toBeUndefined();
    const c = await createChoice(input());
    const r = await attachChoiceTelegram(c.id, [
      { chatId: "abc", messageId: 1 },
      { chatId: USER, messageId: -3 },
      { chatId: USER, messageId: 1.5 },
    ]);
    expect(r?.telegram).toBeUndefined();
  });

  test("entschiedene Frage: Bezug wird trotzdem gemerkt, Zustand bleibt", async () => {
    const c = await createChoice(input());
    await decideChoice(c.id, "y", "web");
    const r = await attachChoiceTelegram(c.id, [{ chatId: USER, messageId: 5 }]);
    expect(r?.state).toBe("done");
    expect(r?.telegram).toEqual([{ chatId: USER, messageId: 5 }]);
  });

  test("kaputte Bezüge in der Datei fallen beim Lesen weg, die Frage bleibt", async () => {
    const c = await createChoice(input());
    const disk = JSON.parse(readFileSync(file, "utf-8"));
    disk.choices[c.id].telegram = [{ chatId: USER, messageId: 7 }, { chatId: 1, messageId: "x" }, "quatsch"];
    writeFileSync(file, JSON.stringify(disk));
    expect((await getChoice(c.id))?.telegram).toEqual([{ chatId: USER, messageId: 7 }]);
    disk.choices[c.id].telegram = "kein array";
    writeFileSync(file, JSON.stringify(disk));
    const read = await getChoice(c.id);
    expect(read?.state).toBe("open");
    expect(read?.telegram).toBeUndefined();
  });
});
