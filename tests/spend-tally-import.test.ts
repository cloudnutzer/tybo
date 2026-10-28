/**
 * Einmalige Übernahme von credit-tally.json in die Kosten-Ablage (Issue #313,
 * src/lib/spend/subscription.ts). Ein „Neustart" ist hier
 * resetSubscriptionStateForTests(): der Prozess vergisst, dass er die
 * Übernahme schon versucht hat, die Datei auf der Platte bleibt.
 */
import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCycleSpend, readCycle, resetSubscriptionStateForTests } from "../src/lib/spend/subscription";

const KEYS = ["BUDGET_DB_PATH", "GO_PROJECT_ROOT", "CONVEX_URL"] as const;
const NOW = Date.parse("2026-05-20T12:00:00Z");
const CURRENT_CYCLE = Date.parse("2026-05-15T00:00:00Z");
const RESET_DAY = 15;

let saved: Record<string, string | undefined> = {};
let folder = "";
let ledgerFile = "";
let tallyFile = "";
let warnings: string[] = [];
let infos: string[] = [];
let spies: { mockRestore(): void }[] = [];

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  folder = mkdtempSync(join(tmpdir(), "tybo-uebernahme-"));
  ledgerFile = join(folder, "data", "api-budget.sqlite");
  tallyFile = join(folder, "credit-tally.json");
  process.env.BUDGET_DB_PATH = ledgerFile;
  process.env.GO_PROJECT_ROOT = folder;
  delete process.env.CONVEX_URL;
  resetSubscriptionStateForTests();
  setSystemTime(new Date(NOW));
  warnings = [];
  infos = [];
  spies = [
    spyOn(console, "warn").mockImplementation((...parts: unknown[]) => void warnings.push(parts.join(" "))),
    spyOn(console, "log").mockImplementation((...parts: unknown[]) => void infos.push(parts.join(" "))),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  setSystemTime();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(folder, { recursive: true, force: true });
});

const tally = (fields: Record<string, unknown>) => JSON.stringify(fields, null, 2);
const fullTally = tally({
  cycleSpendUsd: 42.5,
  cycleStartMs: CURRENT_CYCLE,
  warnedThisCycle: true,
  observedCeilingUsd: 90,
  plan: "max5",
  lastUpdatedMs: NOW - 60_000,
});

function markers(): { source: string; outcome: string }[] {
  const handle = new Database(ledgerFile, { readonly: true });
  try {
    return handle.query("SELECT source, outcome FROM spend_imports").all() as { source: string; outcome: string }[];
  } finally {
    handle.close();
  }
}

function restart(): void {
  resetSubscriptionStateForTests();
}

test("Alle Felder einer gültigen Datei kommen an, die Datei bleibt unverändert", () => {
  writeFileSync(tallyFile, fullTally);
  expect(readCycle(RESET_DAY)).toEqual({
    cycleSpendUsd: 42.5,
    cycleStartMs: CURRENT_CYCLE,
    warnedThisCycle: true,
    observedCeilingUsd: 90,
    plan: "max5",
  });
  expect(markers()).toEqual([{ source: "credit-tally.json", outcome: "uebernommen" }]);
  expect(infos.some((line) => line.includes("übernommen"))).toBe(true);
  addCycleSpend(1, RESET_DAY);
  expect(readFileSync(tallyFile, "utf8")).toBe(fullTally);
});

test("Neustart nach der Übernahme bucht nicht doppelt, auch wenn die Datei sich ändert", () => {
  writeFileSync(tallyFile, fullTally);
  addCycleSpend(0.5, RESET_DAY);
  restart();
  expect(readCycle(RESET_DAY)?.cycleSpendUsd).toBe(43);
  writeFileSync(tallyFile, tally({ cycleStartMs: CURRENT_CYCLE, cycleSpendUsd: 7 }));
  restart();
  expect(readCycle(RESET_DAY)?.cycleSpendUsd).toBe(43);
  expect(markers()).toHaveLength(1);
});

test("Datei aus einem älteren Zyklus: übernommen für ihren Zyklus, der laufende beginnt bei 0", () => {
  const april = Date.parse("2026-04-15T00:00:00Z");
  writeFileSync(tallyFile, tally({ cycleStartMs: april, cycleSpendUsd: 19, warnedThisCycle: true, observedCeilingUsd: null }));
  expect(readCycle(RESET_DAY)).toMatchObject({ cycleSpendUsd: 0, cycleStartMs: CURRENT_CYCLE, warnedThisCycle: false });
  expect(readCycle(RESET_DAY, Date.parse("2026-05-01T00:00:00Z"))).toMatchObject({
    cycleSpendUsd: 19,
    cycleStartMs: april,
    warnedThisCycle: true,
    observedCeilingUsd: null,
  });
});

test("Fehlende Datei: Zähler beginnt bei 0, Marker gesetzt, spätere Datei wird nicht übernommen", () => {
  expect(readCycle(RESET_DAY)?.cycleSpendUsd).toBe(0);
  expect(markers()).toEqual([{ source: "credit-tally.json", outcome: "keine-datei" }]);
  writeFileSync(tallyFile, fullTally);
  restart();
  expect(readCycle(RESET_DAY)?.cycleSpendUsd).toBe(0);
});

test("Beschädigte Datei: kein Marker, keine Ausnahme, Datei unverändert, Log ohne Inhalt; Reparatur plus Neustart übernimmt", () => {
  const broken = '{"cycleSpendUsd": 12.5, "geheim-kennung-im-inhalt", ';
  writeFileSync(tallyFile, broken);
  expect(readCycle(RESET_DAY)?.cycleSpendUsd).toBe(0);
  expect(addCycleSpend(2, RESET_DAY)?.cycleSpendUsd).toBe(2);
  expect(markers()).toEqual([]);
  expect(readFileSync(tallyFile, "utf8")).toBe(broken);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("credit-tally.json nicht übernommen");
  expect(warnings[0]).not.toContain("geheim");
  expect(warnings[0]).not.toContain("12.5");
  restart();
  readCycle(RESET_DAY);
  expect(markers()).toEqual([]);
  writeFileSync(tallyFile, fullTally);
  restart();
  expect(readCycle(RESET_DAY)).toMatchObject({ cycleSpendUsd: 44.5, warnedThisCycle: true, observedCeilingUsd: 90, plan: "max5" });
  expect(markers()).toHaveLength(1);
});

test("Falsche Feldtypen gelten als beschädigt", () => {
  for (const fields of [
    { cycleStartMs: String(CURRENT_CYCLE), cycleSpendUsd: 3 },
    { cycleStartMs: CURRENT_CYCLE, cycleSpendUsd: "3" },
    { cycleStartMs: CURRENT_CYCLE, cycleSpendUsd: -3 },
    { cycleStartMs: CURRENT_CYCLE, warnedThisCycle: "ja" },
    { cycleStartMs: CURRENT_CYCLE, observedCeilingUsd: "90" },
    { cycleStartMs: CURRENT_CYCLE, plan: 5 },
    { cycleSpendUsd: 3 },
  ]) {
    writeFileSync(tallyFile, tally(fields));
    restart();
    expect(readCycle(RESET_DAY)?.cycleSpendUsd).toBe(0);
  }
  writeFileSync(tallyFile, "[1, 2]");
  restart();
  readCycle(RESET_DAY);
  expect(markers()).toEqual([]);
});

test("Unlesbare Datei (Ordner statt Datei) zählt nicht als fehlend", () => {
  mkdirSync(tallyFile);
  expect(readCycle(RESET_DAY)?.cycleSpendUsd).toBe(0);
  expect(markers()).toEqual([]);
  expect(warnings[0]).toContain("nicht lesbar");
});

test("Scheitert der Marker, ist auch die Zeile zurückgerollt; nach Neustart genau einmal übernommen", () => {
  writeFileSync(tallyFile, fullTally);
  mkdirSync(join(folder, "data"));
  const prepared = new Database(ledgerFile, { create: true });
  prepared.exec(`
    CREATE TABLE spend_imports (source TEXT PRIMARY KEY, outcome TEXT NOT NULL, done_ms INTEGER NOT NULL);
    CREATE TRIGGER marker_sperre BEFORE INSERT ON spend_imports BEGIN SELECT RAISE(ABORT, 'gesperrt'); END;`);
  prepared.close();
  expect(readCycle(RESET_DAY)?.cycleSpendUsd).toBe(0);
  expect(markers()).toEqual([]);
  expect(warnings.some((line) => line.includes("gescheitert"))).toBe(true);
  const repair = new Database(ledgerFile);
  repair.exec("DROP TRIGGER marker_sperre");
  repair.close();
  restart();
  expect(readCycle(RESET_DAY)?.cycleSpendUsd).toBe(42.5);
  restart();
  expect(readCycle(RESET_DAY)?.cycleSpendUsd).toBe(42.5);
});

test("CONVEX_URL entscheidet nichts: dieselbe Übernahme wie ohne, keine Convex-Logzeile (Issue #314)", () => {
  writeFileSync(tallyFile, fullTally);
  process.env.CONVEX_URL = "https://beispiel.convex.cloud";
  expect(readCycle(RESET_DAY)).toEqual({
    cycleSpendUsd: 42.5,
    cycleStartMs: CURRENT_CYCLE,
    warnedThisCycle: true,
    observedCeilingUsd: 90,
    plan: "max5",
  });
  expect(markers()).toEqual([{ source: "credit-tally.json", outcome: "uebernommen" }]);
  expect(warnings.some((line) => line.includes("CONVEX_URL"))).toBe(false);
  addCycleSpend(3, RESET_DAY);
  delete process.env.CONVEX_URL;
  restart();
  expect(readCycle(RESET_DAY)?.cycleSpendUsd).toBe(45.5);
  expect(readFileSync(tallyFile, "utf8")).toBe(fullTally);
});

test("Veralteter Zähler aus einem älteren Zyklus mit CONVEX_URL: der laufende Zyklus beginnt bei 0", () => {
  const april = Date.parse("2026-04-15T00:00:00Z");
  writeFileSync(tallyFile, tally({ cycleStartMs: april, cycleSpendUsd: 19, warnedThisCycle: true, observedCeilingUsd: 80 }));
  process.env.CONVEX_URL = "https://beispiel.convex.cloud";
  expect(readCycle(RESET_DAY)).toEqual({
    cycleSpendUsd: 0,
    cycleStartMs: CURRENT_CYCLE,
    warnedThisCycle: false,
    observedCeilingUsd: null,
  });
  delete process.env.CONVEX_URL;
  restart();
  expect(readCycle(RESET_DAY)?.cycleSpendUsd).toBe(0);
});

test("Marker „convex“ aus einem früheren Start bleibt gültig: nichts nachgeholt, Buchungen bleiben", () => {
  expect(readCycle(RESET_DAY)?.cycleSpendUsd).toBe(0);
  const handle = new Database(ledgerFile);
  handle.query("UPDATE spend_imports SET outcome = 'convex'").run();
  handle.close();
  addCycleSpend(3, RESET_DAY);
  writeFileSync(tallyFile, fullTally);
  restart();
  expect(readCycle(RESET_DAY)?.cycleSpendUsd).toBe(3);
  expect(markers()).toEqual([{ source: "credit-tally.json", outcome: "convex" }]);
});

test("Ohne GO_PROJECT_ROOT liegt die Datei im Arbeitsverzeichnis", () => {
  const elsewhere = join(folder, "projekt");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "credit-tally.json"), fullTally);
  writeFileSync(tallyFile, tally({ cycleStartMs: CURRENT_CYCLE, cycleSpendUsd: 1 }));
  delete process.env.GO_PROJECT_ROOT;
  const previous = process.cwd();
  process.chdir(elsewhere);
  try {
    expect(readCycle(RESET_DAY)?.cycleSpendUsd).toBe(42.5);
  } finally {
    process.chdir(previous);
  }
});

test("Zwei gleichzeitige erste Zugriffe aus getrennten Prozessen übernehmen genau einmal", async () => {
  writeFileSync(tallyFile, fullTally);
  const module = join(import.meta.dir, "..", "src", "lib", "spend", "subscription.ts");
  const script = `
    const { readCycle } = await import(${JSON.stringify(module)});
    console.log(readCycle(${RESET_DAY}, ${NOW})?.cycleSpendUsd);`;
  for (let round = 0; round < 3; round++) {
    rmSync(join(folder, "data"), { recursive: true, force: true });
    const workers = Array.from({ length: 4 }, () =>
      Bun.spawn(["bun", "-e", script], { env: { ...process.env }, stdout: "pipe", stderr: "ignore" }),
    );
    const outputs = await Promise.all(workers.map((worker) => new Response(worker.stdout).text()));
    expect(outputs.map((text) => text.trim().split("\n").at(-1))).toEqual(["42.5", "42.5", "42.5", "42.5"]);
    expect(outputs.join("").split("übernommen").length - 1).toBe(1);
    restart();
    expect(readCycle(RESET_DAY)?.cycleSpendUsd).toBe(42.5);
    expect(markers()).toHaveLength(1);
  }
}, 60_000);
