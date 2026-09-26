/**
 * Issue #46, Aufgabe 2: Briefing, Check-in und Watchdog lassen sich ohne
 * Seiteneffekte importieren (kein .env-Lesen, kein Warten, kein Netz, kein
 * Schreiben); der Versand liegt in exportierten Funktionen mit übergebbarem
 * Sender. Die Arbeit startet nur unter import.meta.main.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SendAndRecordInput } from "../src/lib/outbox";

const fetchCalls: string[] = [];
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
let timers = 0;
let briefing: typeof import("../src/morning-briefing");
let checkin: typeof import("../src/smart-checkin");
let watchdog: typeof import("../src/watchdog");
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
  briefing = await fresh("../src/morning-briefing.ts");
  checkin = await fresh("../src/smart-checkin.ts");
  watchdog = await fresh("../src/watchdog.ts");
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
    expect(typeof briefing.sendBriefing).toBe("function");
    expect(typeof checkin.deliverCheckin).toBe("function");
    expect(typeof watchdog.sendAlert).toBe("function");
  });
});

describe("Briefing", () => {
  test("sendBriefing übergibt Text und Quelle an den Sender", async () => {
    const r = recorder();
    expect(await briefing.sendBriefing("☀️ **GOOD MORNING**", r.send)).toBe(true);
    expect(r.calls).toEqual([{ text: "☀️ **GOOD MORNING**", source: "briefing" }]);
  });

  test("meldet Misserfolg des Senders", async () => {
    expect(await briefing.sendBriefing("x", recorder(false).send)).toBe(false);
  });
});

describe("Check-in", () => {
  function state() {
    return { lastMessageTime: "", lastCheckinTime: "", lastCallTime: "", pendingItems: [] as string[], context: "" };
  }
  const NOW = new Date("2026-09-24T10:00:00.000Z");

  test("keine Aktion: nichts gesendet, nichts gespeichert", async () => {
    const r = recorder();
    const saved: unknown[] = [];
    const sent = await checkin.deliverCheckin({ action: "none", message: "none" }, state(), {
      send: r.send,
      saveState: async s => void saved.push(s),
      now: () => NOW,
    });
    expect(sent).toBe(false);
    expect(r.calls).toEqual([]);
    expect(saved).toEqual([]);
  });

  test("Text mit Snooze/Got it über den übergebenen Sender", async () => {
    const r = recorder();
    const saved: unknown[] = [];
    const s = state();
    await checkin.deliverCheckin({ action: "text", message: "Wie läuft's?" }, s, {
      send: r.send,
      saveState: async x => void saved.push(structuredClone(x)),
      now: () => NOW,
    });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].buttons).toEqual(checkin.CHECKIN_BUTTONS);
    expect(saved).toEqual([{ ...state(), lastCheckinTime: NOW.toISOString() }]);
  });
});

describe("Watchdog", () => {
  test("sendAlert übergibt Text und Quelle an den Sender", async () => {
    const r = recorder();
    const logs: string[] = [];
    expect(await watchdog.sendAlert("🚨 *Alarm*", { send: r.send, log: l => void logs.push(l), hasCredentials: true })).toBe(true);
    expect(r.calls).toEqual([{ text: "🚨 *Alarm*", source: "watchdog" }]);
    expect(logs).toEqual(["✅ Alert sent"]);
  });

  test("ohne Zugangsdaten nichts gesendet", async () => {
    const r = recorder();
    const logs: string[] = [];
    expect(await watchdog.sendAlert("x", { send: r.send, log: l => void logs.push(l), hasCredentials: false })).toBe(false);
    expect(r.calls).toEqual([]);
    expect(logs).toEqual(["Missing Telegram credentials"]);
  });

  test("Fehler des Senders werden geloggt, nicht geworfen", async () => {
    const logs: string[] = [];
    const send = async () => {
      throw new Error("kaputt");
    };
    expect(await watchdog.sendAlert("x", { send, log: l => void logs.push(l), hasCredentials: true })).toBe(false);
    expect(logs[0]).toContain("Alert error");
  });
});
