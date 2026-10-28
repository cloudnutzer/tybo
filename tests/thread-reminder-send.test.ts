import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createChoice, decideChoice, getChoice, setChoicesFileForTests, type Choice, type ChoiceConversation } from "../src/lib/choices";
import { sendAndRecord, textChunks, type OutboxDeps, type SendAndRecordInput, type SendAndRecordResult } from "../src/lib/outbox";
import type { Message } from "../src/lib/store/types";
import { classifyReminderResult, reminderText, sendThreadReminder, THREAD_OPTIONS } from "../src/lib/thread-choices";

// Issue #292, Aufgabe 5: Versandweg der Erinnerung nur ins Gespräch des Fadens.

const CONV_ID = "0b7c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const TOPIC: ChoiceConversation = { type: "telegram", chatId: "-1001234567890", topicId: 7 };
const DM: ChoiceConversation = { type: "telegram", chatId: "4711" };
const WEB: ChoiceConversation = { type: "web", conversationId: CONV_ID };
const WEB_DM: ChoiceConversation = { type: "telegram", chatId: "web" };
const THREAD = { createdAt: Date.parse("2026-10-12T10:00:00Z"), context: "Wohin geht die Reise im Dezember?", question: "Hamburg oder München?" };

let dir: string;
let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-thread-send-"));
  setChoicesFileForTests(join(dir, "choices.json"));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  setChoicesFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

const choiceIn = (conversation: ChoiceConversation): Promise<Choice> =>
  createChoice({ kind: "thread", conversation, text: reminderText(THREAD, 1, "Europe/Berlin"), options: THREAD_OPTIONS, ref: "Faden12345" });

/** Echte Outbox mit Attrappen für Telegram und den Nachrichtenspeicher */
function outbox(telegram: boolean, record?: (m: Message) => Promise<boolean>) {
  const fetched: string[] = [];
  const recorded: Message[] = [];
  const deps: OutboxDeps = {
    botToken: telegram ? "123:test" : "",
    userId: telegram ? "4711" : "",
    groupId: "-1001234567890",
    outboxDir: join(dir, "outbox"),
    fetch: async url => {
      fetched.push(url);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { status: 200 });
    },
    record: record ?? (async m => {
      recorded.push(m);
      return true;
    }),
    log: () => {},
    newId: () => crypto.randomUUID(),
  };
  return { deps, fetched, recorded, send: (input: SendAndRecordInput) => sendAndRecord(input, deps) };
}

describe("Text", () => {
  test("erst Kontext, dann Frage, bei Frist die Frist; zweite Erinnerung mit „Noch einmal“", () => {
    expect(reminderText(THREAD, 1, "Europe/Berlin")).toBe("🧵 Offen seit 12.10.2026: Wohin geht die Reise im Dezember?\nFrage: Hamburg oder München?");
    expect(reminderText({ ...THREAD, deadline: "2026-10-20" }, 2, "Europe/Berlin")).toBe(
      "🧵 Noch einmal, offen seit 12.10.2026: Wohin geht die Reise im Dezember?\nFrage: Hamburg oder München?\nFrist: 20.10.2026"
    );
  });

  test("lange Felder gekürzt: Kontext höchstens 300, Frage höchstens 500 Zeichen, ein Telegram-Stück", () => {
    const text = reminderText({ ...THREAD, context: "k".repeat(2000), question: "f".repeat(3000), deadline: "2026-10-20" }, 2, "UTC");
    const [first, second] = text.split("\n");
    expect(first.endsWith("k".repeat(299) + "…")).toBe(true);
    expect(second).toBe(`Frage: ${"f".repeat(499)}…`);
    expect(textChunks(text, "plain").length).toBe(1);
  });
});

describe("Versand", () => {
  test("Telegram-Topic: Chat und Topic, Klartext, drei Knöpfe, source faeden, choiceId; Nachricht gemerkt", async () => {
    const c = await choiceIn(TOPIC);
    const calls: SendAndRecordInput[] = [];
    const r = await sendThreadReminder(c, c.text, {
      telegram: () => true,
      send: async input => {
        calls.push(input);
        return { sent: true, recorded: true, messages: [{ chatId: "-1001234567890", messageId: 55, part: "text", buttons: true }] };
      },
    });
    expect(r).toEqual({ outcome: "delivered", messages: [{ chatId: "-1001234567890", messageId: 55 }] });
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ chatId: "-1001234567890", topicId: 7, format: "plain", source: "faeden", choiceId: c.id, text: c.text });
    expect(calls[0].buttons!.flat().map(b => b.text)).toEqual(["Erledigt", "Später", "Nicht mehr wichtig"]);
    expect(calls[0].buttons!.flat().map(b => b.callback_data)).toEqual([`ch|${c.id}|done`, `ch|${c.id}|later`, `ch|${c.id}|drop`]);
    expect((await getChoice(c.id))?.telegram).toEqual([{ chatId: "-1001234567890", messageId: 55 }]);
  });

  test("Telegram-Topic über die echte Outbox: genau eine Nachricht an Telegram, im Gespräch des Topics festgehalten", async () => {
    const o = outbox(true);
    const c = await choiceIn(TOPIC);
    const r = await sendThreadReminder(c, c.text, { telegram: () => true, send: o.send });
    expect(r.outcome).toBe("delivered");
    expect(o.fetched.length).toBe(1);
    expect(o.recorded.length).toBe(1);
    expect(o.recorded[0]).toMatchObject({ chat_id: "-1001234567890", metadata: { source: "faeden", choiceId: c.id, topicId: 7 } });
  });

  test("Entschieden, während gesendet wurde: die eigene Nachricht wird nachgezogen", async () => {
    const c = await choiceIn(TOPIC);
    const refreshed: Choice[] = [];
    await sendThreadReminder(c, c.text, {
      telegram: () => true,
      send: async () => {
        await decideChoice(c.id, "done", "web");
        return { sent: true, recorded: true, messages: [{ chatId: "-1001234567890", messageId: 56, part: "text", buttons: true }] };
      },
      refresh: async choice => {
        refreshed.push(choice);
      },
    });
    expect(refreshed.map(x => x.state)).toEqual(["done"]);
  });

  test("Web-Gespräch mit Telegram: nur im Gespräch festgehalten, mit choiceId, keine Kopie im Direktchat, nichts an Telegram", async () => {
    const o = outbox(true);
    const c = await choiceIn(WEB);
    const r = await sendThreadReminder(c, c.text, { telegram: () => true, send: o.send });
    expect(r.outcome).toBe("delivered");
    expect(o.fetched).toEqual([]);
    expect(o.recorded.length).toBe(1);
    expect(o.recorded[0]).toMatchObject({ chat_id: `web:${CONV_ID}`, role: "assistant", content: c.text, metadata: { display_only: true, source: "faeden", choiceId: c.id } });
  });

  test("Web-Gespräch ohne Telegram: ebenso nur im Gespräch", async () => {
    const o = outbox(false);
    const c = await choiceIn(WEB);
    const r = await sendThreadReminder(c, c.text, { telegram: () => false, send: o.send });
    expect(r.outcome).toBe("delivered");
    expect(o.fetched).toEqual([]);
    expect(o.recorded.map(m => [m.chat_id, m.metadata?.choiceId])).toEqual([[`web:${CONV_ID}`, c.id]]);
  });

  test("Web-Direktchat (ohne Telegram): im Web-Direktchat festgehalten, nie verschoben", async () => {
    const o = outbox(false);
    const c = await choiceIn(WEB_DM);
    const r = await sendThreadReminder(c, c.text, { telegram: () => false, send: o.send });
    expect(r.outcome).toBe("delivered");
    expect(o.recorded.map(m => [m.chat_id, m.metadata?.choiceId])).toEqual([["web", c.id]]);
  });

  test("Telegram-Gespräch ohne Telegram: kein Versand", async () => {
    const c = await choiceIn(DM);
    let called = false;
    const r = await sendThreadReminder(c, c.text, { telegram: () => false, send: async () => { called = true; return { sent: true, recorded: true }; } });
    expect(r.outcome).toBe("deferred");
    expect(called).toBe(false);
  });

  test("Web: Eintrag gespeichert, Bestätigung verloren: unklar (kein zweiter Versuch, siehe remind.ts)", async () => {
    const stored: Message[] = [];
    const o = outbox(true, async m => {
      stored.push(m);
      throw new Error("Antwort verloren");
    });
    const c = await choiceIn(WEB);
    const r = await sendThreadReminder(c, c.text, { telegram: () => true, send: o.send });
    expect(r.outcome).toBe("unclear");
    expect(stored.length).toBe(1);
  });

  test("Ausnahme beim Senden: unklar", async () => {
    const c = await choiceIn(TOPIC);
    const r = await sendThreadReminder(c, c.text, { telegram: () => true, send: async () => { throw new Error("weg"); } });
    expect(r.outcome).toBe("unclear");
  });
});

describe("Ausgang", () => {
  const r = (x: Partial<SendAndRecordResult>): SendAndRecordResult => ({ sent: false, recorded: false, ...x });
  test("zugestellt, Teilerfolg, sicher abgelehnt, unklar", () => {
    expect(classifyReminderResult(r({ sent: true, recorded: true }))).toBe("delivered");
    // Telegram angenommen, Festhalten gescheitert
    expect(classifyReminderResult(r({ sent: true, recorded: false }))).toBe("delivered");
    expect(classifyReminderResult(r({ recorded: true }))).toBe("delivered");
    // Angenommene Nachricht trotz Fehler: zählt als zugestellt
    expect(classifyReminderResult(r({ error: { kind: "send", message: "x", rejected: true }, messages: [{ chatId: "1", messageId: 2, part: "text", buttons: false }] }))).toBe("delivered");
    expect(classifyReminderResult(r({ error: { kind: "invalid", message: "x" } }))).toBe("rejected");
    expect(classifyReminderResult(r({ error: { kind: "send", message: "x", rejected: true } }))).toBe("rejected");
    expect(classifyReminderResult(r({ error: { kind: "send", message: "x" } }))).toBe("unclear");
    expect(classifyReminderResult(r({ error: { kind: "record", message: "x" } }))).toBe("unclear");
  });
});
