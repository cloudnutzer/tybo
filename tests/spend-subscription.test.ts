/**
 * Abo-Zyklus in der Kosten-Ablage (Issue #313, src/lib/spend/subscription.ts):
 * Zyklusbeginn, Buchen, Warnstatus, gelerntes Limit, Fail-open und die
 * Trennung vom Tagesbudget. Die Übernahme von credit-tally.json prüft
 * tests/spend-tally-import.test.ts.
 */
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remainingBudget, reserveBudget, settleBudget } from "../src/lib/daily-budget";
import {
  addCycleSpend,
  cycleStartUtc,
  markCycleWarned,
  readCycle,
  resetSubscriptionStateForTests,
  setObservedCeiling,
} from "../src/lib/spend/subscription";

const KEYS = ["BUDGET_DB_PATH", "DAILY_API_BUDGET", "GO_PROJECT_ROOT", "CONVEX_URL"] as const;
let saved: Record<string, string | undefined> = {};
let folder = "";

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  folder = mkdtempSync(join(tmpdir(), "tybo-abo-"));
  process.env.BUDGET_DB_PATH = join(folder, "data", "budget.sqlite");
  process.env.GO_PROJECT_ROOT = folder;
  process.env.DAILY_API_BUDGET = "5";
  delete process.env.CONVEX_URL;
  resetSubscriptionStateForTests();
  setSystemTime(new Date("2026-05-20T12:00:00Z"));
});

afterEach(() => {
  setSystemTime();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(folder, { recursive: true, force: true });
});

const utc = (iso: string) => Date.parse(iso);

test("Zyklusbeginn in UTC am Reset-Tag, auch über Monats- und Jahreswechsel", () => {
  expect(cycleStartUtc(15, utc("2026-05-20T12:00:00Z"))).toBe(utc("2026-05-15T00:00:00Z"));
  expect(cycleStartUtc(15, utc("2026-05-15T00:00:00Z"))).toBe(utc("2026-05-15T00:00:00Z"));
  expect(cycleStartUtc(15, utc("2026-05-14T23:59:59Z"))).toBe(utc("2026-04-15T00:00:00Z"));
  expect(cycleStartUtc(10, utc("2026-01-03T08:00:00Z"))).toBe(utc("2025-12-10T00:00:00Z"));
  expect(cycleStartUtc(1, utc("2026-01-01T00:00:00Z"))).toBe(utc("2026-01-01T00:00:00Z"));
  expect(cycleStartUtc(1, utc("2025-12-31T23:59:59Z"))).toBe(utc("2025-12-01T00:00:00Z"));
});

test("Reset-Tag wird auf 1 bis 28 begrenzt", () => {
  const now = utc("2026-03-30T10:00:00Z");
  expect(cycleStartUtc(0, now)).toBe(utc("2026-03-01T00:00:00Z"));
  expect(cycleStartUtc(-4, now)).toBe(utc("2026-03-01T00:00:00Z"));
  expect(cycleStartUtc(29, now)).toBe(utc("2026-03-28T00:00:00Z"));
  expect(cycleStartUtc(31, now)).toBe(utc("2026-03-28T00:00:00Z"));
  expect(cycleStartUtc(31, utc("2026-03-27T10:00:00Z"))).toBe(utc("2026-02-28T00:00:00Z"));
  expect(cycleStartUtc(12.4, now)).toBe(utc("2026-03-12T00:00:00Z"));
});

test("Reset-Tag unendlich zählt als 28 bzw. 1, NaN ergibt keinen Zyklus", () => {
  const now = utc("2026-03-30T10:00:00Z");
  expect(cycleStartUtc(Number.POSITIVE_INFINITY, now)).toBe(utc("2026-03-28T00:00:00Z"));
  expect(cycleStartUtc(Number.NEGATIVE_INFINITY, now)).toBe(utc("2026-03-01T00:00:00Z"));
  expect(cycleStartUtc(Number.NaN, now)).toBeNaN();
  expect(addCycleSpend(3, Number.NaN)).toBeNull();
  expect(readCycle(Number.NaN)).toBeNull();
  expect(markCycleWarned(Number.NaN)).toBe(false);
  expect(setObservedCeiling(Number.NaN, 3)).toBe(false);
  expect(readCycle(15)?.cycleSpendUsd).toBe(0);
  const file = new Database(process.env.BUDGET_DB_PATH!);
  expect(file.query("SELECT COUNT(*) AS rows FROM subscription_cycles").get()).toEqual({ rows: 0 });
  file.close();
});

test("Ohne Buchung liefert der laufende Zyklus 0", () => {
  expect(readCycle(15)).toEqual({
    cycleSpendUsd: 0,
    cycleStartMs: utc("2026-05-15T00:00:00Z"),
    warnedThisCycle: false,
    observedCeilingUsd: null,
  });
});

test("Buchen summiert, 0 oder negativ bucht nichts, der Plan bleibt erhalten", () => {
  expect(addCycleSpend(1.5, 15, "max5")?.cycleSpendUsd).toBe(1.5);
  expect(addCycleSpend(0, 15)).toBeNull();
  expect(addCycleSpend(-2, 15)).toBeNull();
  expect(addCycleSpend(Number.NaN, 15)).toBeNull();
  const row = addCycleSpend(0.25, 15);
  expect(row).toMatchObject({ cycleSpendUsd: 1.75, plan: "max5", warnedThisCycle: false });
  expect(readCycle(15)?.cycleSpendUsd).toBe(1.75);
  expect(addCycleSpend(0.25, 15, "pro")?.plan).toBe("pro");
});

test("Ein neuer Zyklus beginnt bei 0 mit frischem Warnstatus und Limit", () => {
  addCycleSpend(4, 15);
  markCycleWarned(15);
  setObservedCeiling(15, 4);
  setSystemTime(new Date("2026-06-15T00:00:01Z"));
  expect(readCycle(15)).toEqual({
    cycleSpendUsd: 0,
    cycleStartMs: utc("2026-06-15T00:00:00Z"),
    warnedThisCycle: false,
    observedCeilingUsd: null,
  });
  setSystemTime(new Date("2026-06-14T23:59:59Z"));
  expect(readCycle(15)).toMatchObject({ cycleSpendUsd: 4, warnedThisCycle: true, observedCeilingUsd: 4 });
});

test("Warnstatus wird genau einmal je Zyklus frei", () => {
  expect(markCycleWarned(15)).toBe(true);
  expect(markCycleWarned(15)).toBe(false);
  expect(readCycle(15)?.warnedThisCycle).toBe(true);
  setSystemTime(new Date("2026-06-16T00:00:00Z"));
  expect(markCycleWarned(15)).toBe(true);
});

test("Gelerntes Limit wird nur einmal je Zyklus gesetzt", () => {
  addCycleSpend(3, 15);
  expect(setObservedCeiling(15, 3)).toBe(true);
  expect(setObservedCeiling(15, 9)).toBe(false);
  expect(readCycle(15)?.observedCeilingUsd).toBe(3);
  expect(addCycleSpend(1, 15)?.observedCeilingUsd).toBe(3);
});

test("Tagesbudget und Abo-Verbrauch zählen getrennt in derselben Datei", () => {
  addCycleSpend(2, 15);
  expect(remainingBudget()).toBe(5);
  settleBudget(reserveBudget("probe", 1), 0.75);
  expect(remainingBudget()).toBe(4.25);
  expect(readCycle(15)?.cycleSpendUsd).toBe(2);
});

test("Fail-open: Speicherfehler werden zu kein Wert bzw. nichts gebucht", () => {
  const blocker = join(folder, "blocker");
  writeFileSync(blocker, "keine Ablage");
  process.env.BUDGET_DB_PATH = join(blocker, "budget.sqlite");
  resetSubscriptionStateForTests();
  expect(readCycle(15)).toBeNull();
  expect(addCycleSpend(1, 15)).toBeNull();
  expect(markCycleWarned(15)).toBe(false);
  expect(setObservedCeiling(15, 1)).toBe(false);
});

test("Fail-open: beschädigte Ablage (keine SQLite-Datei) wirft nicht", () => {
  const broken = join(folder, "kaputt.sqlite");
  writeFileSync(broken, "das ist keine Datenbank, sondern Text ".repeat(200));
  process.env.BUDGET_DB_PATH = broken;
  resetSubscriptionStateForTests();
  expect(readCycle(15)).toBeNull();
  expect(addCycleSpend(1, 15)).toBeNull();
});

test("Gleichzeitiges Buchen aus getrennten Prozessen verliert nichts", async () => {
  readCycle(15);
  const module = join(import.meta.dir, "..", "src", "lib", "spend", "subscription.ts");
  const script = `
    const { addCycleSpend } = await import(${JSON.stringify(module)});
    for (let i = 0; i < 20; i++) addCycleSpend(0.25, 15, undefined, ${utc("2026-05-20T12:00:00Z")});`;
  const workers = Array.from({ length: 4 }, () =>
    Bun.spawn(["bun", "-e", script], { env: { ...process.env }, stdout: "ignore", stderr: "ignore" }),
  );
  await Promise.all(workers.map((worker) => worker.exited));
  expect(readCycle(15)?.cycleSpendUsd).toBe(20);
}, 30_000);
