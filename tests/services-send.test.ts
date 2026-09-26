/**
 * Issue #46, Aufgabe 3: Briefing, Check-in (beide Pfade) und Watchdog senden
 * über sendAndRecord. Geprüft wird die Quelle, der festgehaltene Text und die
 * Telegram-Payload im Vergleich zum bisherigen Versand (sendTelegramMessage
 * bzw. der eigene fetch des Watchdogs), jeweils gegen Attrappen.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sendAndRecord, sendViaOutbox, type OutboxDeps, type SendAndRecordInput } from "../src/lib/outbox";
import { markdownToTelegramHTML, sendTelegramMessage, stripHtmlTags } from "../src/lib/telegram";
import type { Message } from "../src/lib/supabase";

/** Präzisierung zu #52: keine versteckte Adresse (Link oder ganzes Bild), sichtbarer Text ist erlaubt */
const hidesSecret = (s: string) => /href=\\?"https:\/\/a\.b\/geheim|!\[[^\]]*\]\(https:\/\/a\.b\/geheim[^)]*\)/.test(s);

const USER = "4711";
const TOKEN = "123:t";

let briefing: typeof import("../src/morning-briefing");
let checkin: typeof import("../src/smart-checkin");
let watchdog: typeof import("../src/watchdog");

beforeAll(async () => {
  briefing = await import("../src/morning-briefing");
  checkin = await import("../src/smart-checkin");
  watchdog = await import("../src/watchdog");
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Sender über sendAndRecord mit Attrappen; status(i) bestimmt die Antwort je Aufruf */
function outbox(status: (i: number) => number = () => 200, recordOk = true) {
  const dir = mkdtempSync(join(tmpdir(), "services-send-"));
  dirs.push(dir);
  const payloads: Record<string, unknown>[] = [];
  const recorded: Message[] = [];
  const inputs: SendAndRecordInput[] = [];
  const deps: OutboxDeps = {
    botToken: TOKEN,
    userId: USER,
    groupId: null,
    outboxDir: join(dir, "outbox"),
    fetch: async (_url, init) => {
      payloads.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: status(payloads.length - 1) });
    },
    record: async m => {
      recorded.push(m);
      return recordOk;
    },
    log: () => {},
    newId: () => crypto.randomUUID(),
  };
  const send = async (input: SendAndRecordInput) => {
    inputs.push(input);
    return sendAndRecord(input, deps);
  };
  return { send, payloads, recorded, inputs };
}

/** Payloads des bisherigen sendTelegramMessage mit Attrappe für den globalen fetch */
async function legacyPayloads(
  text: string,
  options: Parameters<typeof sendTelegramMessage>[3],
  status: (i: number) => number = () => 200
): Promise<Record<string, unknown>[]> {
  const original = globalThis.fetch;
  const payloads: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    payloads.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: status(payloads.length - 1) });
  }) as typeof fetch;
  try {
    await sendTelegramMessage(TOKEN, USER, text, options);
  } finally {
    globalThis.fetch = original;
  }
  return payloads;
}

const HTML_400_FIRST = (i: number) => (i === 0 ? 400 : 200);

test("alle drei nutzen standardmäßig sendAndRecord", () => {
  expect(briefing.defaultSend).toBe(sendViaOutbox);
  expect(checkin.defaultSend).toBe(sendViaOutbox);
  expect(checkin.defaultDeliveryDeps().send).toBe(sendViaOutbox);
  expect(watchdog.defaultSend).toBe(sendViaOutbox);
  expect(watchdog.defaultAlertDeps().send).toBe(sendViaOutbox);
});

describe("Briefing", () => {
  const TEXT = "☀️ **GOOD MORNING ALEX**\n_Thursday, September 24_\n\n📅 **CALENDAR** (2)\n- 10:00 Call <Team> & Co\n\n---\n_Reply to chat with me_";

  test("Quelle briefing, festgehalten wird der Text", async () => {
    const o = outbox();
    expect(await briefing.sendBriefing(TEXT, o.send)).toBe(true);
    expect(o.inputs).toEqual([{ text: TEXT, source: "briefing" }]);
    expect(o.recorded).toEqual([
      { chat_id: USER, role: "assistant", content: TEXT, metadata: { display_only: true, source: "briefing" } },
    ]);
  });

  test("Payload wie bisher, auch beim Klartext-Rückfall", async () => {
    for (const status of [() => 200, HTML_400_FIRST]) {
      const o = outbox(status);
      await briefing.sendBriefing(TEXT, o.send);
      expect(o.payloads).toEqual(await legacyPayloads(TEXT, { parseMode: "HTML" }, status));
    }
  });

  test("Telegram scheitert: false", async () => {
    expect(await briefing.sendBriefing(TEXT, outbox(() => 500).send)).toBe(false);
  });
});

describe("Check-in", () => {
  const NOW = new Date("2026-09-24T10:00:00.000Z");
  function freshState() {
    return { lastMessageTime: "x", lastCheckinTime: "", lastCallTime: "", pendingItems: [] as string[], context: "" };
  }
  function run(decision: { action: "text" | "call" | "none"; message: string }, o: ReturnType<typeof outbox>) {
    const saved: unknown[] = [];
    const state = freshState();
    const done = checkin.deliverCheckin(decision, state, {
      send: o.send,
      saveState: async s => void saved.push(structuredClone(s)),
      now: () => NOW,
    });
    return { done, saved, state };
  }

  describe("Text-Pfad", () => {
    const MSG = "Wie läuft **Issue 46**? <Frage>";

    test("Quelle checkin, HTML mit Snooze/Got it wie bisher, auch beim Rückfall", async () => {
      for (const status of [() => 200, HTML_400_FIRST]) {
        const o = outbox(status);
        const r = run({ action: "text", message: MSG }, o);
        expect(await r.done).toBe(true);
        expect(o.inputs).toEqual([{ text: MSG, source: "checkin", buttons: checkin.CHECKIN_BUTTONS }]);
        const legacy = await legacyPayloads(MSG, { parseMode: "HTML", buttons: checkin.CHECKIN_BUTTONS }, status);
        expect(o.payloads).toEqual(legacy);
        expect((o.payloads.at(-1)?.reply_markup as any).inline_keyboard[0].map((b: any) => b.callback_data)).toEqual(["snooze", "dismiss"]);
        expect(o.recorded.map(m => m.content)).toEqual([MSG]);
      }
    });

    test("Zustand nur bei sent; sent ohne Festhalten zählt als gesendet", async () => {
      const ok = run({ action: "text", message: MSG }, outbox(() => 200, false));
      expect(await ok.done).toBe(true);
      expect(ok.saved).toEqual([{ ...freshState(), lastCheckinTime: NOW.toISOString() }]);

      const failed = run({ action: "text", message: MSG }, outbox(() => 500));
      expect(await failed.done).toBe(false);
      expect(failed.saved).toEqual([]);
      expect(failed.state.lastCheckinTime).toBe("");
    });
  });

  describe("Anruf-Pfad", () => {
    const MSG = "Deadline <heute> & **morgen**";
    const ASK = `📞 I'd like to call you about:\n\n${MSG}`;

    test("Quelle checkin, Klartext ohne parse_mode mit call_yes/call_no wie bisher", async () => {
      const o = outbox();
      const r = run({ action: "call", message: MSG }, o);
      expect(await r.done).toBe(true);
      expect(o.inputs).toEqual([{ text: ASK, source: "checkin", format: "plain", buttons: checkin.CALL_BUTTONS }]);
      expect(o.payloads).toEqual(await legacyPayloads(ASK, { buttons: checkin.CALL_BUTTONS }));
      expect(o.payloads[0]).toEqual({
        chat_id: USER,
        text: ASK,
        // Issue #52: Vorschau immer aus
        link_preview_options: { is_disabled: true },
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Yes, call me", callback_data: "call_yes" },
              { text: "❌ Not now", callback_data: "call_no" },
            ],
          ],
        },
      });
      expect(o.recorded.map(m => m.content)).toEqual([ASK]);
    });

    test("Zustand nur bei sent (gewollte Änderung), auch wenn das Festhalten scheitert", async () => {
      const ok = run({ action: "call", message: MSG }, outbox(() => 200, false));
      expect(await ok.done).toBe(true);
      expect(ok.saved).toEqual([{ ...freshState(), pendingItems: [`PENDING_CALL: ${MSG}`], lastCheckinTime: NOW.toISOString() }]);

      const failed = run({ action: "call", message: MSG }, outbox(() => 400));
      expect(await failed.done).toBe(false);
      expect(failed.saved).toEqual([]);
      expect(failed.state.pendingItems).toEqual([]);
    });

    test("Issue #52: Telegram bereinigt, festgehalten wird das Original mit Links", async () => {
      const o = outbox();
      const msg = "Rechnung ![Scan](https://a.b/geheim) prüfen, siehe [Portal](https://ok.example)";
      expect(await run({ action: "call", message: msg }, o).done).toBe(true);
      expect(o.payloads).toHaveLength(1);
      expect(o.payloads[0].text).toBe(`📞 I'd like to call you about:\n\nRechnung Scan prüfen, siehe [Portal](https://ok.example)`);
      expect(o.recorded.map(m => m.content)).toEqual([`📞 I'd like to call you about:\n\n${msg}`]);
    });

    test("Issue #52: Bild an der 500er-Grenze: keine versteckte Adresse", async () => {
      const o = outbox();
      const msg = "a".repeat(480) + "![x](https://a.b/geheim" + "z".repeat(100) + ") Ende";
      await run({ action: "call", message: msg }, o).done;
      // Angeschnittene Bildsyntax bleibt sichtbarer Text, keine versteckte Adresse
      expect(hidesSecret(JSON.stringify(o.payloads))).toBe(false);
      expect(String(o.payloads[0].text)).toStartWith(`📞 I'd like to call you about:\n\n${"a".repeat(480)}`);
      expect(o.recorded[0].content).toStartWith(`📞 I'd like to call you about:\n\n${"a".repeat(480)}`);
    });

    test("lange Nachricht wird wie bisher auf 500 Zeichen gekürzt", async () => {
      const o = outbox();
      const long = "a".repeat(800);
      await run({ action: "call", message: long }, o).done;
      expect(o.inputs[0].text).toBe(`📞 I'd like to call you about:\n\n${"a".repeat(500)}`);
    });
  });
});

describe("Watchdog", () => {
  /** Issue #52: Vorschau immer aus */
  const NO_PREVIEW = { is_disabled: true };
  const MSG = "🚨 *Smart Check-in Alert*\n\nService hasn't run in *120 minutes*!\n\nRun: `bun run setup:launchd -- --service smart-checkin`";

  function alert(o: ReturnType<typeof outbox>) {
    const logs: string[] = [];
    const done = watchdog.sendAlert(MSG, { send: o.send, log: l => void logs.push(l), hasCredentials: true });
    return { done, logs };
  }

  test("Quelle watchdog, Payload wie der bisherige eigene fetch", async () => {
    const o = outbox();
    const r = alert(o);
    expect(await r.done).toBe(true);
    expect(o.inputs).toEqual([{ text: MSG, source: "watchdog" }]);
    expect(o.payloads).toEqual([
      { chat_id: USER, text: markdownToTelegramHTML(MSG), parse_mode: "HTML", link_preview_options: NO_PREVIEW },
    ]);
    expect(o.recorded.map(m => m.content)).toEqual([MSG]);
    expect(r.logs).toEqual(["✅ Alert sent"]);
  });

  test("bei 400 einmal als Klartext wie bisher", async () => {
    const o = outbox(HTML_400_FIRST);
    expect(await alert(o).done).toBe(true);
    expect(o.payloads).toEqual([
      { chat_id: USER, text: markdownToTelegramHTML(MSG), parse_mode: "HTML", link_preview_options: NO_PREVIEW },
      { chat_id: USER, text: stripHtmlTags(markdownToTelegramHTML(MSG)), link_preview_options: NO_PREVIEW },
    ]);
  });

  test("Telegram scheitert: geloggt, false", async () => {
    const r = alert(outbox(() => 500));
    expect(await r.done).toBe(false);
    expect(r.logs).toEqual(["❌ Alert failed"]);
  });
});
