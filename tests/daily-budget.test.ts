/**
 * Tagesbudget über die Fassade src/lib/daily-budget.ts (Issue #313): gleiche
 * Signaturen, gleiche Fehlertexte, gleiches Verhalten wie vor dem Umbau auf
 * src/lib/spend/ledger.ts. Jeder Fall bekommt eine eigene Datei.
 */
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remainingBudget, reserveBudget, settleBudget } from "../src/lib/daily-budget";

const KEYS = ["BUDGET_DB_PATH", "DAILY_API_BUDGET"] as const;
let saved: Record<string, string | undefined> = {};
let folder = "";
let ledgerFile = "";

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  folder = mkdtempSync(join(tmpdir(), "tybo-tagesbudget-"));
  ledgerFile = join(folder, "nested", "budget.sqlite");
  process.env.BUDGET_DB_PATH = ledgerFile;
  process.env.DAILY_API_BUDGET = "3";
});

afterEach(() => {
  setSystemTime();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(folder, { recursive: true, force: true });
});

const near = (value: number, expected: number) => expect(value).toBeCloseTo(expected, 9);

test("Reservieren mindert den Rest, die Datei liegt unter BUDGET_DB_PATH mit Rechten 0600", () => {
  near(remainingBudget(), 3);
  reserveBudget("probe", 1.25);
  near(remainingBudget(), 1.75);
  expect(statSync(ledgerFile).mode & 0o777).toBe(0o600);
});

test("Istkosten ersetzen die Reservierung, auch Istkosten 0", () => {
  const first = reserveBudget("probe", 2);
  settleBudget(first, 0.5);
  near(remainingBudget(), 2.5);
  const second = reserveBudget("probe", 1);
  settleBudget(second, 0);
  near(remainingBudget(), 2.5);
});

test("Unbekannte Kosten verbuchen die Reservierung", () => {
  for (const unknown of [undefined, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    process.env.DAILY_API_BUDGET = "10";
    const before = remainingBudget();
    settleBudget(reserveBudget("probe", 0.5), unknown);
    near(remainingBudget(), before - 0.5);
  }
});

test("Zweites Verbuchen ändert nichts, ein verbuchter Eintrag öffnet sich nicht wieder", () => {
  const id = reserveBudget("probe", 2);
  settleBudget(id, 0.25);
  settleBudget(id, 1.5);
  settleBudget(id);
  near(remainingBudget(), 2.75);
  const zero = reserveBudget("probe", 1);
  settleBudget(zero, 0);
  settleBudget(zero);
  near(remainingBudget(), 2.75);
});

test("Verbuchen einer unbekannten Kennung ist ohne Wirkung", () => {
  reserveBudget("probe", 1);
  settleBudget("gibt-es-nicht", 0.1);
  near(remainingBudget(), 2);
});

test("Wirft bei ausgeschöpftem Budget, ungültigem Betrag und ungültigem DAILY_API_BUDGET", () => {
  reserveBudget("probe", 2.5);
  expect(() => reserveBudget("probe", 0.6)).toThrow("Daily API budget reached");
  expect(reserveBudget("probe", 0.5)).toBeString();
  near(remainingBudget(), 0);
  for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() => reserveBudget("probe", amount)).toThrow("Invalid cost reservation");
  for (const limit of ["-1", "abc"]) {
    process.env.DAILY_API_BUDGET = limit;
    expect(() => reserveBudget("probe", 0.1)).toThrow("Invalid DAILY_API_BUDGET");
    expect(() => remainingBudget()).toThrow("Invalid DAILY_API_BUDGET");
  }
});

test("Ohne DAILY_API_BUDGET gelten 5 Dollar", () => {
  delete process.env.DAILY_API_BUDGET;
  near(remainingBudget(), 5);
});

test("Speicherfehler werfen: Pfad, dessen Ordner eine Datei ist", () => {
  const blocker = join(folder, "blocker");
  writeFileSync(blocker, "keine Ablage");
  process.env.BUDGET_DB_PATH = join(blocker, "budget.sqlite");
  expect(() => remainingBudget()).toThrow();
  expect(() => reserveBudget("probe", 0.1)).toThrow();
  expect(() => settleBudget("egal", 0.1)).toThrow();
});

test("UTC-Tageswechsel: die Reservierung von gestern zählt heute nicht", () => {
  setSystemTime(new Date("2026-03-04T23:59:30Z"));
  reserveBudget("probe", 2);
  near(remainingBudget(), 1);
  setSystemTime(new Date("2026-03-05T00:00:30Z"));
  near(remainingBudget(), 3);
});

test("Vorhandene Datei aus dem alten Schema behält Rest und offene Reservierungen", () => {
  const today = new Date().toISOString().slice(0, 10);
  const oldFile = join(folder, "alt.sqlite");
  const old = new Database(oldFile, { create: true });
  process.env.BUDGET_DB_PATH = oldFile;
  old.exec("CREATE TABLE IF NOT EXISTS costs (id TEXT PRIMARY KEY, day TEXT, provider TEXT, reserved REAL, spent REAL)");
  const put = old.query("INSERT INTO costs VALUES (?,?,?,?,?)");
  put.run("verbucht", today, "alt", 0, 0.4);
  put.run("offen", today, "alt", 1.1, 0);
  put.run("gestern", "2000-01-01", "alt", 0, 2);
  old.close();
  near(remainingBudget(), 1.5);
  settleBudget("offen", 0.1);
  near(remainingBudget(), 2.5);
  settleBudget("offen", 0.9);
  near(remainingBudget(), 2.5);
});

test("Konkurrierende Reservierungen aus getrennten Prozessen überschreiten das Budget nicht", async () => {
  process.env.DAILY_API_BUDGET = "2";
  remainingBudget();
  const facade = join(import.meta.dir, "..", "src", "lib", "daily-budget.ts");
  const script = `
    const { reserveBudget } = await import(${JSON.stringify(facade)});
    let won = 0;
    for (let i = 0; i < 15; i++) { try { reserveBudget("p", 0.25); won++; } catch {} }
    console.log(won);`;
  const workers = Array.from({ length: 4 }, () =>
    Bun.spawn(["bun", "-e", script], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" }),
  );
  const counts = await Promise.all(workers.map(async (worker) => Number((await new Response(worker.stdout).text()).trim())));
  expect(counts.reduce((sum, n) => sum + n, 0)).toBe(8);
  near(remainingBudget(), 0);
}, 30_000);
