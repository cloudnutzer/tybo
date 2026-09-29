/**
 * Zustellung der Merk-Vorschläge und Routine-Angebote (Issue #53, seit
 * Issue #117 über das Rückfragen-Register): lange Vorschauen kommen
 * vollständig in mehreren Nachrichten an, die Knöpfe ("ch|<id>|<key>")
 * hängen unter der letzten und nur diese ist an der Rückfrage gemerkt; ein
 * endgültiger Sendefehler erreicht stageMemoryReview, der Vorschlag bleibt
 * liegen. Echte sendChoice und sendAndRecord, Telegram und Speicher als
 * Attrappe; Register und Ablage in Temp-Dateien. src/bot.ts wird nur als Text
 * gelesen, nie importiert.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getChoice, listChoices, setChoicesFileForTests } from "../src/lib/choices";
import { sendAndRecord, type OutboxDeps } from "../src/lib/outbox";
import { createReviewNotifier, REVIEW_MEMORY_OPTIONS, REVIEW_ROUTINE_OPTIONS } from "../src/lib/review-choices";
import {
  REVIEW_MAX_AGE_MS,
  setPendingReviewsFileForTests,
  setReviewNotifier,
  stageMemoryReview,
  stageRoutineReview,
} from "../src/lib/session-distill";
import type { BotSession } from "../src/lib/session-manager";
import type { Message } from "../src/lib/supabase";
import { sendChoice } from "../src/lib/telegram-choices";

const USER = "4711";
const GROUP = "-1001234567890";
const base = mkdtempSync(join(tmpdir(), "review-delivery-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

interface Call {
  method: string;
  json: Record<string, any>;
}

/** sendAndRecord mit Telegram-Attrappe; reject(call) lässt Telegram ablehnen */
function harness(options: { reject?: (call: Call) => boolean; noMessageId?: boolean } = {}) {
  const calls: Call[] = [];
  const delivered: Call[] = [];
  const recorded: Message[] = [];
  const logs: string[] = [];
  let nextId = 500;
  const outbox: OutboxDeps = {
    botToken: "123:test-token",
    userId: USER,
    groupId: GROUP,
    outboxDir: join(base, "outbox"),
    fetch: async (url, init) => {
      const call = { method: url.split("/").pop() ?? "", json: JSON.parse(String(init.body)) };
      calls.push(call);
      // Telegram lehnt Texte über 4096 Zeichen ab
      if (String(call.json.text ?? "").length > 4096 || options.reject?.(call)) {
        return new Response(JSON.stringify({ ok: false, description: "Bad Request" }), { status: 400 });
      }
      delivered.push(call);
      const result = options.noMessageId ? {} : { message_id: nextId++ };
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    },
    record: async m => {
      recorded.push(m);
      return true;
    },
    log: line => logs.push(line),
    newId: () => crypto.randomUUID(),
  };
  const notifier = createReviewNotifier({
    sendChoice: choice =>
      sendChoice(choice, {
        send: input => sendAndRecord(input, outbox),
        refresh: async () => {},
        log: line => logs.push(line),
      }),
    log: line => logs.push(line),
  });
  return { notifier, calls, delivered, recorded, logs };
}

/** Tags, deren Vorschau deutlich über dem Telegram-Limit liegt */
function longTags(): string {
  return Array.from({ length: 60 }, (_, i) => `[REMEMBER: Eintrag ${i} ${"lang ".repeat(15)}ende-${i}]`).join("\n");
}

let counter = 0;
let pendingFile = "";
let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  counter++;
  pendingFile = join(base, `pending-${counter}.json`);
  setPendingReviewsFileForTests(pendingFile);
  setChoicesFileForTests(join(base, `choices-${counter}.json`));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  setReviewNotifier(null);
  logSpy.mockRestore();
});
afterAll(() => {
  setPendingReviewsFileForTests(null);
  setChoicesFileForTests(null);
});

const pendingOnDisk = () => (existsSync(pendingFile) ? JSON.parse(readFileSync(pendingFile, "utf-8")) : {});

describe("Rückfrage zum Vorschlag", () => {
  test("Merk-Vorschlag im Topic: Rückfrage kind review, ref = Review-ID, Frist 7 Tage ab Ablage, festgehalten mit choiceId", async () => {
    const h = harness();
    setReviewNotifier(h.notifier);
    const id = await stageMemoryReview({ chatId: GROUP, topicId: 42, tags: "[REMEMBER: x]", header: "🧠 Merk-Vorschlag:" });
    const review = pendingOnDisk()[id!];
    const [choice] = await listChoices();
    expect(choice).toMatchObject({
      kind: "review",
      ref: id,
      conversation: { type: "telegram", chatId: GROUP, topicId: 42 },
      options: REVIEW_MEMORY_OPTIONS,
      state: "open",
      expiresAt: review.createdAt + REVIEW_MAX_AGE_MS,
      text: "🧠 Merk-Vorschlag:\n\n• Fakt merken: x",
    });
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0].json).toMatchObject({ chat_id: GROUP, message_thread_id: 42 });
    expect(h.delivered[0].json.reply_markup).toEqual({
      inline_keyboard: [[
        { text: "Übernehmen", callback_data: `ch|${choice.id}|ok` },
        { text: "Verwerfen", callback_data: `ch|${choice.id}|no` },
      ]],
    });
    expect(h.recorded).toEqual([
      { chat_id: GROUP, role: "assistant", content: choice.text, metadata: { display_only: true, source: "review", choiceId: choice.id, topicId: 42 } },
    ]);
    expect((await getChoice(choice.id))?.telegram).toEqual([{ chatId: GROUP, messageId: 500 }]);
  });

  test("Routine-Angebot: eigene Knöpfe „Als Routine speichern“/„Verwerfen“, Sitzung in der Ablage", async () => {
    const h = harness();
    setReviewNotifier(h.notifier);
    const session = { key: `dm:${USER}:general`, engine: "claude", engineSessionId: "s1", agentName: "general", messageCount: 9 } as BotSession;
    const id = await stageRoutineReview({ chatId: USER, description: "Wochenbericht bauen", session });
    const [choice] = await listChoices();
    expect(choice).toMatchObject({ kind: "review", ref: id, conversation: { type: "telegram", chatId: USER }, options: REVIEW_ROUTINE_OPTIONS });
    expect(choice.text).toContain('"Wochenbericht bauen"');
    expect(h.delivered[0].json.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data)).toEqual([`ch|${choice.id}|routine`, `ch|${choice.id}|no`]);
    expect(pendingOnDisk()[id]).toMatchObject({ type: "routine", routineDescription: "Wochenbericht bauen", session: { engine: "claude", engineSessionId: "s1" } });
  });
});

describe("lange Vorschläge", () => {
  test("Vorschau vollständig in mehreren Nachrichten, Knöpfe nur unter der letzten, nur sie gemerkt", async () => {
    const h = harness();
    setReviewNotifier(h.notifier);
    const id = await stageMemoryReview({ chatId: USER, tags: longTags(), header: "🧠 Merk-Vorschlag:" });
    expect(id).toBeTruthy();

    expect(h.delivered.length).toBeGreaterThan(1);
    for (const m of h.delivered) {
      expect(m.json.text.length).toBeLessThanOrEqual(4096);
      expect(m.json.chat_id).toBe(USER);
      expect(m.json.link_preview_options).toEqual({ is_disabled: true });
    }
    // jede Zeile der Vorschau kommt an
    const all = h.delivered.map(m => m.json.text).join("\n");
    for (let i = 0; i < 60; i++) expect(all).toContain(`• Fakt merken: Eintrag ${i} `);
    for (let i = 0; i < 60; i++) expect(all).toContain(`ende-${i}`);

    const withButtons = h.delivered.filter(m => m.json.reply_markup);
    expect(withButtons).toEqual([h.delivered[h.delivered.length - 1]]);
    const [choice] = await listChoices();
    expect((await getChoice(choice.id))?.telegram).toEqual([{ chatId: USER, messageId: 500 + h.delivered.length - 1 }]);
  });
});

describe("Zustellung scheitert", () => {
  test("Telegram lehnt ab: stageMemoryReview protokolliert, Vorschlag und offene Frage bleiben, nichts angewendet", async () => {
    const h = harness({ reject: () => true });
    setReviewNotifier(h.notifier);
    const errors: unknown[][] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    let id: string | null;
    try {
      id = await stageMemoryReview({ chatId: USER, tags: "[REMEMBER: x]", header: "Kopf" });
    } finally {
      spy.mockRestore();
    }
    expect(h.delivered).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(String(errors[0][0])).toContain(`Vorschlag ${id!} abgelegt, Zustellung fehlgeschlagen`);
    expect(String(errors[0][1])).toContain("nirgends zugestellt");
    expect(Object.keys(pendingOnDisk())).toEqual([id!]);
    const [choice] = await listChoices();
    expect(choice.state).toBe("open");
    expect(choice.telegram).toBeUndefined();
  });

  test("Telegram liefert keine message_id: gesendet, aber Knöpfe nicht gemerkt (Klick meldet „noch nicht bereit“), Log", async () => {
    const h = harness({ noMessageId: true });
    setReviewNotifier(h.notifier);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await stageMemoryReview({ chatId: USER, tags: "[REMEMBER: x]", header: "Kopf" });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
    const [choice] = await listChoices();
    expect(choice.telegram).toBeUndefined();
    expect(h.logs.join("\n")).toContain("ohne message_id");
  });

  test("Chat weder Telegram noch Web-Gespräch: keine Rückfrage, Zustellfehler im Log, Vorschlag bleibt", async () => {
    const h = harness();
    setReviewNotifier(h.notifier);
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await stageMemoryReview({ chatId: "voice:unbekannt", tags: "[REMEMBER: x]", header: "Kopf" });
      expect(String(spy.mock.calls[0]?.[1])).toContain("Gespräch des Vorschlags unbekannt");
    } finally {
      spy.mockRestore();
    }
    expect(await listChoices()).toEqual([]);
    expect(Object.keys(pendingOnDisk())).toHaveLength(1);
  });
});

describe("Verdrahtung im Bot", () => {
  test("bot.ts stellt Vorschläge als Rückfrage zu (Telegram über sendChoice, Web-Gespräch über die WebUI)", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "bot.ts"), "utf-8");
    expect(source).toContain("setReviewNotifier(createReviewNotifier({");
    expect(source).toContain("sendChoice: (choice) => telegramChoices.sendChoice(choice),");
    expect(source).toContain("postWeb: postReviewToWeb,");
    expect(source).toContain("webServer ? webServer.postToConversation(conversationId, post) : false;");
    expect(source).not.toContain("telegramReviewNotifier");
  });
});
