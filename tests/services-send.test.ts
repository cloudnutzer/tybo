/**
 * Issue #46, Aufgabe 3: Briefing und Check-in (beide Pfade) senden
 * über sendAndRecord (das Briefing seit Issue #363 als Routine über den Kern
 * der proaktiven Meldungen). Geprüft wird die Quelle, der festgehaltene Text und die
 * Telegram-Payload im Vergleich zum bisherigen Versand (sendTelegramMessage),
 * jeweils gegen Attrappen. Der Watchdog ist seit Issue #365 eine Prüfung im
 * Nachtcheck und sendet nicht mehr selbst.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sendAndRecord, sendViaOutbox, type OutboxDeps, type SendAndRecordInput } from "../src/lib/outbox";
import { sendTelegramMessage } from "../src/channels/telegram/send";
import { defaultSend as defaultProactiveSend } from "../src/lib/proactive/deliver";
import type { Message } from "../src/lib/store/types";

/** Präzisierung zu #52: keine versteckte Adresse (Link oder ganzes Bild), sichtbarer Text ist erlaubt */
const hidesSecret = (s: string) => /href=\\?"https:\/\/a\.b\/geheim|!\[[^\]]*\]\(https:\/\/a\.b\/geheim[^)]*\)/.test(s);

const USER = "4711";
const TOKEN = "123:t";

let briefing: typeof import("../src/routines/briefing");
let checkin: typeof import("../src/routines/checkin");

beforeAll(async () => {
  briefing = await import("../src/routines/briefing");
  checkin = await import("../src/routines/checkin");
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

test("Kern (Briefing, Check-in) nutzt standardmäßig sendAndRecord", async () => {
  // Briefing und Check-in senden seit #363 bzw. #364 über den Kern der proaktiven Meldungen
  expect(await defaultProactiveSend()).toBe(sendViaOutbox);
});

describe("Briefing", () => {
  // Donnerstag, 24. September 2026, 9:30 in Berlin
  const MORNING = new Date("2026-09-24T07:30:00.000Z");
  const calendar = {
    id: "calendar",
    label: "Kalender",
    ready: () => true,
    collect: async () => ({ items: [{ text: "Call <Team> & Co", start: "2026-09-24T08:00:00Z", end: "2026-09-24T08:30:00Z" }] }),
  };
  const TEXT = [
    "☀️ **Guten Morgen, Alex!**\n_Donnerstag, 24. September_",
    "📅 **Termine heute** (1)\n• 10:00 bis 10:30: Call <Team> & Co",
    "_Antworte einfach, wenn du etwas davon besprechen willst._",
  ].join("\n\n");

  async function run(o: ReturnType<typeof outbox>) {
    const dir = mkdtempSync(join(tmpdir(), "services-send-briefing-"));
    dirs.push(dir);
    return briefing.runBriefing({
      sources: [calendar],
      send: o.send,
      env: { USER_TIMEZONE: "Europe/Berlin" },
      now: () => MORNING,
      settings: {},
      statePath: join(dir, "state.json"),
      legacy: null,
      renewMs: 0,
      name: "Alex",
      wait: async () => {},
    });
  }

  test("Quelle briefing, festgehalten wird der Text", async () => {
    const o = outbox();
    expect(await run(o)).toBe(0);
    expect(o.inputs).toEqual([{ text: TEXT, source: "briefing" }]);
    expect(o.recorded).toEqual([
      { chat_id: USER, role: "assistant", content: TEXT, metadata: { display_only: true, source: "briefing" } },
    ]);
  });

  test("Payload wie bei sendTelegramMessage, auch beim Klartext-Rückfall", async () => {
    for (const status of [() => 200, HTML_400_FIRST]) {
      const o = outbox(status);
      await run(o);
      expect(o.payloads).toEqual(await legacyPayloads(TEXT, { parseMode: "HTML" }, status));
    }
  });

  test("Telegram scheitert: Exit 1", async () => {
    expect(await run(outbox(() => 500))).toBe(1);
  });
});

describe("Check-in (Routine seit Issue #364)", () => {
  // 14:00 in Berlin, im Zeitfenster des Check-ins
  const NOW = new Date("2026-09-24T12:00:00.000Z");
  const goals = { id: "goals", label: "Ziele", ready: () => true, collect: async () => ({ items: [] }) };
  const BUTTONS = [[{ text: "Erledigt", callback_data: "ch|c1|done" }, { text: "30 Minuten später", callback_data: "ch|c1|snooze" }]];

  async function run(answer: object, o: ReturnType<typeof outbox>, callAvailable = false) {
    const dir = mkdtempSync(join(tmpdir(), "services-send-checkin-"));
    dirs.push(dir);
    const statePath = join(dir, "data", "proactive-state.json");
    const code = await checkin.runCheckin({
      send: o.send,
      env: { USER_TIMEZONE: "Europe/Berlin" },
      now: () => NOW,
      settings: {},
      statePath,
      legacy: null,
      renewMs: 0,
      wait: async () => {},
      choices: {
        create: async (_kind, text) => ({ id: "c1", text, options: [{ key: "done", label: "Erledigt" }, { key: "snooze", label: "30 Minuten später" }] }) as never,
        attach: async () => undefined,
        expire: async () => undefined,
        refresh: async () => undefined,
      },
      lastUserMessageAt: async () => "2026-09-24T06:00:00.000Z",
      recentRows: async () => [],
      goals,
      profile: async () => "",
      callAvailable: () => callAvailable,
      aux: async () => ({ text: JSON.stringify(answer), isError: false }),
    });
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    return { code, lastSentAt: state.checkin.lastSentAt as string | undefined };
  }

  const MSG = "Wie läuft **Issue 46**? <Frage>";

  test("Quelle checkin, Markdown wie sendTelegramMessage mit den Knöpfen der Rückfrage, auch beim Rückfall", async () => {
    for (const status of [() => 200, HTML_400_FIRST]) {
      const o = outbox(status);
      expect((await run({ action: "text", message: MSG }, o)).code).toBe(0);
      expect(o.inputs).toEqual([{ text: MSG, source: "checkin", buttons: BUTTONS, choiceId: "c1" }]);
      expect(o.payloads).toEqual(await legacyPayloads(MSG, { parseMode: "HTML", buttons: BUTTONS }, status));
      expect(o.recorded.map(m => m.content)).toEqual([MSG]);
    }
  });

  test("Versandzeit nur bei Zustellung; zugestellt ohne Festhalten zählt", async () => {
    const ok = await run({ action: "text", message: MSG }, outbox(() => 200, false));
    expect(ok).toEqual({ code: 0, lastSentAt: NOW.toISOString() });
    const failed = await run({ action: "text", message: MSG }, outbox(() => 500));
    expect(failed).toEqual({ code: 1, lastSentAt: undefined });
  });

  test("Anruf angeboten: Text mit Hinweis, Knöpfe der Rückfrage, festgehalten wird das Original", async () => {
    const o = outbox();
    const msg = "Rechnung ![Scan](https://a.b/geheim) prüfen, siehe [Portal](https://ok.example)";
    expect((await run({ action: "call", message: msg }, o, true)).code).toBe(0);
    expect(o.inputs[0].text).toBe(`${checkin.CALL_OFFER_PREFIX}${msg}`);
    // Issue #52: Telegram bereinigt, keine versteckte Adresse
    expect(hidesSecret(JSON.stringify(o.payloads))).toBe(false);
    expect(o.recorded.map(m => m.content)).toEqual([`${checkin.CALL_OFFER_PREFIX}${msg}`]);
  });
});
