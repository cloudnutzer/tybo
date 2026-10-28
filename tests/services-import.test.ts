/**
 * Issue #46, Aufgabe 2: Briefing und Check-in lassen sich ohne
 * Seiteneffekte importieren (kein .env-Lesen, kein Warten, kein Netz, kein
 * Schreiben); der Versand liegt in exportierten Funktionen mit übergebbarem
 * Sender. Die Arbeit startet nur unter import.meta.main.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendAndRecordInput } from "../src/lib/outbox";

const fetchCalls: string[] = [];
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
let timers = 0;
let briefing: typeof import("../src/routines/briefing");
let checkin: typeof import("../src/routines/checkin");
let importMs = 0;

beforeAll(async () => {
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetchCalls.push(String(url));
    throw new Error("kein Netz im Test");
  }) as typeof fetch;
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    timers++;
    return originalSetTimeout(fn, ms, ...rest);
  }) as typeof setTimeout;
  // Query-String erzwingt eine frische Modul-Instanz, auch wenn ein anderer
  // Test die Module im selben Prozess schon geladen hat
  const fresh = (path: string) => import(`${path}?import-test=${Date.now()}`);
  const start = Date.now();
  briefing = await fresh("../src/routines/briefing.ts");
  checkin = await fresh("../src/routines/checkin.ts");
  importMs = Date.now() - start;
  globalThis.setTimeout = originalSetTimeout;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

function recorder(sent = true) {
  const calls: SendAndRecordInput[] = [];
  const send = async (input: SendAndRecordInput) => {
    calls.push(input);
    return { sent };
  };
  return { calls, send };
}

describe("Import ohne Seiteneffekte", () => {
  test("kein Netz, keine Wartezeit, keine Timer", () => {
    expect(fetchCalls).toEqual([]);
    expect(timers).toBe(0);
    // Die Dienste warten beim Start bis zu 30 s; der Import darf das nicht
    expect(importMs).toBeLessThan(5000);
  });

  test("Versandfunktionen sind exportiert", () => {
    expect(typeof briefing.runBriefing).toBe("function");
    expect(typeof checkin.runCheckin).toBe("function");
  });
});

describe("Briefing (Routine seit Issue #363)", () => {
  // 9:30 in Berlin, im Zeitfenster des Briefings
  const MORNING = new Date("2027-01-14T08:30:00.000Z");
  const goals = { id: "goals", label: "Ziele", ready: () => true, collect: async () => ({ items: [{ text: "Laufen" }] }) };

  async function run(sent: boolean) {
    const dir = mkdtempSync(join(tmpdir(), "tybo-briefing-import-"));
    try {
      const r = recorder(sent);
      const code = await briefing.runBriefing({
        sources: [goals],
        send: r.send,
        env: { USER_TIMEZONE: "Europe/Berlin" },
        now: () => MORNING,
        settings: {},
        statePath: join(dir, "state.json"),
        legacy: null,
        renewMs: 0,
        name: "Alex",
        wait: async () => {},
      });
      return { code, calls: r.calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("runBriefing übergibt Text und Quelle an den Sender", async () => {
    const { code, calls } = await run(true);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].source).toBe("briefing");
    expect(calls[0].text).toContain("🎯 **Ziele** (1)\n• Laufen");
  });

  test("Misserfolg des Senders: Exit 1", async () => {
    expect((await run(false)).code).toBe(1);
  });
});

describe("Check-in (Routine seit Issue #364)", () => {
  // 14:00 in Berlin, im Zeitfenster des Check-ins
  const NOW = new Date("2026-09-24T12:00:00.000Z");
  const goals = { id: "goals", label: "Ziele", ready: () => true, collect: async () => ({ items: [] }) };

  async function run(answer: string, extra: (dir: string) => Record<string, unknown> = () => ({})) {
    const dir = mkdtempSync(join(tmpdir(), "tybo-checkin-import-"));
    const prompts: string[] = [];
    try {
      const r = recorder();
      const code = await checkin.runCheckin({
        send: r.send,
        env: { USER_TIMEZONE: "Europe/Berlin" },
        now: () => NOW,
        settings: {},
        statePath: join(dir, "data", "proactive-state.json"),
        legacy: null,
        renewMs: 0,
        wait: async () => {},
        choices: {
          create: async (_kind, text) => ({ id: "c1", text, options: [{ key: "done", label: "Erledigt" }] }) as never,
          attach: async () => undefined,
          expire: async () => undefined,
          refresh: async () => undefined,
        },
        lastUserMessageAt: async () => "2026-09-24T06:00:00.000Z",
        recentRows: async () => [],
        goals,
        profile: async () => "",
        callAvailable: () => false,
        aux: async prompt => {
          prompts.push(prompt);
          return { text: answer, isError: false };
        },
        ...extra(dir),
      });
      const state = JSON.parse(readFileSync(join(dir, "data", "proactive-state.json"), "utf-8"));
      return { code, calls: r.calls, prompts, state };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("keine Aktion: nichts gesendet, keine Versandzeit", async () => {
    const { code, calls, state } = await run('{"action": "none"}');
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(state.checkin.lastSentAt).toBeUndefined();
  });

  test("Text über den übergebenen Sender mit Knöpfen, Versandzeit gesetzt", async () => {
    const { code, calls, state } = await run('{"action": "text", "message": "Wie läuft\'s?"}');
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ text: "Wie läuft's?", source: "checkin", choiceId: "c1" });
    expect(calls[0].buttons).toEqual([[{ text: "Erledigt", callback_data: "ch|c1|done" }]]);
    expect(state.checkin.lastSentAt).toBe(NOW.toISOString());
  });

  test("Issue #305: alte Zustandsdatei mit lastCallTime und context wird übernommen, offene Punkte gehen ins Modell", async () => {
    const old = {
      lastMessageTime: "2026-09-20T08:00:00.000Z",
      lastCheckinTime: "2026-09-21T09:30:00.000Z",
      lastCallTime: "2026-09-19T18:00:00.000Z",
      pendingItems: ["Steuer"],
      context: "alter Kontext",
    };
    const { prompts, state } = await run('{"action": "none"}', dir => {
      writeFileSync(join(dir, "checkin-state.json"), JSON.stringify(old));
      return {
        legacy: {
          schedule: join(dir, "config", "schedule.json"),
          checkinState: join(dir, "checkin-state.json"),
          settings: join(dir, "config", "settings.json"),
          state: join(dir, "data", "proactive-state.json"),
        },
      };
    });
    expect(state.checkin.lastSentAt).toBe(old.lastCheckinTime);
    expect(state.checkin.pendingItems).toEqual(["Steuer"]);
    expect(prompts[0]).toContain("- Steuer");
    // lastMessageTime gilt nicht mehr: die Zeit kommt aus dem Verlauf
    expect(prompts[0]).toContain("Letzte Nachricht des Nutzers: vor 6 Stunden");
  });
});
