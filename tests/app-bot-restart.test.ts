// Issue #344: Neustart nach Antwort als Verhalten von createBotRestart
// (ersetzt die Quelltext-Prüfungen von busyCount und beforeShutdown in bot.ts).
import { describe, expect, test } from "bun:test";
import { createBotRestart, type BotRestartDeps } from "../src/app/bot-restart";

function setup(busy: number[], overrides: Partial<BotRestartDeps> = {}) {
  const events: string[] = [];
  const scheduled: { ms: number; run: () => void }[] = [];
  const restart = createBotRestart({
    readRequest: async () => "Code geändert",
    clearRequest: async () => void events.push("clear"),
    busy: busy.map(n => () => n),
    farewell: async () => void events.push("farewell"),
    detectSupervisor: async () => "launchd" as never,
    closeIntake: () => () => void events.push("reopen"),
    send: async text => void events.push(`send ${text.slice(0, 10)}`),
    shutdown: async reason => void events.push(`shutdown ${reason}`),
    isShuttingDown: () => false,
    schedule: (run, ms) => void scheduled.push({ run, ms }),
    ...overrides,
  });
  return { restart, events, scheduled };
}

describe("createBotRestart", () => {
  test("zählt alle laufenden Arbeiten, auch Telefonhörer-Turns", async () => {
    for (const busy of [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) {
      const s = setup(busy);
      expect(await s.restart.maybeRestart("idle")).toBe("busy");
      expect(s.events.some(e => e.startsWith("shutdown"))).toBe(false);
    }
  });

  test("in Ruhe: Telefonhörer verabschieden sich vor dem Beenden", async () => {
    const s = setup([0, 0, 0, 0]);
    await s.restart.maybeRestart("idle");
    const farewell = s.events.indexOf("farewell");
    const shutdown = s.events.findIndex(e => e.startsWith("shutdown"));
    expect(farewell).toBeGreaterThan(-1);
    expect(shutdown).toBeGreaterThan(farewell);
  });

  test("nach einer Antwort erst nach 3 Sekunden geprüft", async () => {
    const s = setup([0, 0, 0, 0]);
    s.restart.afterReply("nach Antwort", "1", 2);
    expect(s.scheduled.map(x => x.ms)).toEqual([3000]);
    expect(s.events).toEqual([]);
    s.scheduled[0].run();
    await new Promise(r => setTimeout(r, 5));
    expect(s.events.some(e => e.startsWith("shutdown"))).toBe(true);
  });
});
