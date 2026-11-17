/**
 * Issue #316, Aufgabe 2: Datei-Adapter für Fakten und Ziele
 * (src/lib/store/file/memory.ts) und die ID-Änderungen beider Adapter.
 * Altbestand aus memory.json und aus memory.json.sqlite bleibt lesbar,
 * gleiche Texte sind über IDs unterscheidbar, gleichzeitige Prozesse
 * verlieren nichts. Supabase ohne Netz gegen memory-fixture.ts.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileMemory, memoryFilePath } from "../src/lib/store/file/memory";
import { getStore, resetStore } from "../src/lib/store";
import { updateJsonState } from "../src/lib/json-state";
import { useMemoryTable, type Row } from "./memory-fixture";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetStore();
});

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "tybo-memfile-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "memory.json");
}

/** Gespeicherter Stand, so wie er in der SQLite-Ablage liegt */
function stored(file: string): any {
  const db = new Database(`${file}.sqlite`);
  try {
    return JSON.parse((db.query("SELECT value FROM state").get() as { value: string }).value);
  } finally {
    db.close();
  }
}

/** Adapter auf einer eigenen, leeren Datei */
function freshMemory() {
  const file = tempFile();
  return fileMemory(() => file);
}

const LEGACY = {
  facts: ["Alex trinkt Tee", "Mia spielt Cello"],
  goals: [
    { text: "Bericht schreiben", createdAt: "2026-10-01T08:00:00.000Z" },
    { text: "Steuer abgeben", deadline: "2026-11-30T22:59:59.000Z", createdAt: "2026-10-02T08:00:00.000Z" },
  ],
  completedGoals: [{ text: "Umzug", completedAt: "2026-09-01T08:00:00.000Z" }],
};

describe("Ort der Ablage", () => {
  test("MEMORY_FILE_PATH, sonst memory.json in GO_PROJECT_ROOT bzw. im Arbeitsordner", () => {
    expect(memoryFilePath({ MEMORY_FILE_PATH: "/x/m.json", GO_PROJECT_ROOT: "/p" })).toBe("/x/m.json");
    expect(memoryFilePath({ GO_PROJECT_ROOT: "/p" })).toBe("/p/memory.json");
    expect(memoryFilePath({ MEMORY_FILE_PATH: "" })).toBe(join(process.cwd(), "memory.json"));
  });

  test("ohne Datenbank nimmt getStore().memory die Datei aus MEMORY_FILE_PATH", async () => {
    const file = tempFile();
    const saved = process.env.MEMORY_FILE_PATH;
    process.env.MEMORY_FILE_PATH = file;
    cleanups.push(() => void (process.env.MEMORY_FILE_PATH = saved));
    resetStore();
    expect(getStore().backend).toBe("file");
    expect(await getStore().memory.addFact("Alex mag Jazz")).toBe(true);
    expect(stored(file).facts.map((f: any) => f.text)).toEqual(["Alex mag Jazz"]);
  });
});

describe("Altbestand", () => {
  test("memory.json: Erstimport mit IDs, Reihenfolge und Fristen bleiben, die Datei selbst unverändert", async () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify(LEGACY));
    const memory = fileMemory(() => file);
    const facts = await memory.facts();
    expect(facts.map(f => f.content)).toEqual(["Alex trinkt Tee", "Mia spielt Cello"]);
    const goals = await memory.activeGoals();
    expect(goals.map(g => [g.content, g.deadline ?? null, g.created_at])).toEqual([
      ["Bericht schreiben", null, "2026-10-01T08:00:00.000Z"],
      ["Steuer abgeben", "2026-11-30T22:59:59.000Z", "2026-10-02T08:00:00.000Z"],
    ]);
    for (const item of [...facts, ...goals]) expect(typeof item.id).toBe("string");
    // IDs bleiben über Aufrufe gleich (gespeichert), memory.json wird nicht angefasst
    expect((await memory.facts()).map(f => f.id)).toEqual(facts.map(f => f.id));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(LEGACY);
    expect(stored(file).completedGoals).toEqual(LEGACY.completedGoals);
  });

  test("schon importierte Ablage im alten Format (ohne IDs, ohne completedGoals)", async () => {
    const file = tempFile();
    updateJsonState(file, () => ({}), (value: any) => Object.assign(value, { facts: ["alt"], goals: [{ text: "Ziel alt", createdAt: "2026-10-01T08:00:00.000Z" }] }));
    const memory = fileMemory(() => file);
    expect((await memory.facts()).map(f => f.content)).toEqual(["alt"]);
    expect(await memory.completeGoal("ziel")).toBe(true);
    expect(stored(file).completedGoals.map((g: any) => g.text)).toEqual(["Ziel alt"]);
  });

  test("Delta: Altbestand ohne Zeitpunkt zählt nicht, Neues schon", async () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify(LEGACY));
    const memory = fileMemory(() => file);
    await memory.addFact("neu");
    const since = new Date("2026-10-01T12:00:00.000Z");
    expect((await memory.changedSince(since)).map(i => [i.type, i.content])).toEqual([
      ["fact", "neu"],
      ["goal", "Steuer abgeben"],
    ]);
  });
});

describe("Anlegen und Teiltext", () => {
  test("gleicher Fakt nur einmal, Ziel mit Frist als ISO, ungültiges Datum: false", async () => {
    const memory = freshMemory();
    expect(await memory.addFact("Tee")).toBe(true);
    expect(await memory.addFact("Tee")).toBe(true);
    expect((await memory.facts()).length).toBe(1);
    expect(await memory.addGoal("Urlaub", new Date("2026-12-01T10:00:00.000Z"))).toBe(true);
    expect((await memory.activeGoals())[0].deadline).toBe("2026-12-01T10:00:00.000Z");
    expect(await memory.addGoal("kaputt", new Date(NaN))).toBe(false);
    expect((await memory.activeGoals()).length).toBe(1);
  });

  test("erster Treffer ohne Rücksicht auf Groß- und Kleinschreibung; erledigte Ziele unter completedGoals", async () => {
    const file = tempFile();
    const memory = fileMemory(() => file);
    await memory.addGoal("Bericht A");
    await memory.addGoal("Bericht B");
    expect(await memory.completeGoal("BERICHT")).toBe(true);
    expect((await memory.activeGoals()).map(g => g.content)).toEqual(["Bericht B"]);
    expect(stored(file).completedGoals).toEqual([{ id: expect.any(String), text: "Bericht A", completedAt: expect.any(String) }]);
    expect(await memory.cancelGoal("bericht")).toBe(true);
    expect(await memory.cancelGoal("bericht")).toBe(false);
  });
});

describe("Treffer und Änderung per ID (Datei)", () => {
  test("alle Treffer, älteste zuerst, höchstens limit, nur offene Ziele", async () => {
    const memory = freshMemory();
    for (const t of ["Bericht 1", "Steuer", "bericht 2", "Bericht 3"]) await memory.addGoal(t);
    await memory.completeGoal("Bericht 1");
    expect((await memory.matchingGoals("BERICHT", 10)).map(g => g.content)).toEqual(["bericht 2", "Bericht 3"]);
    expect((await memory.matchingGoals("bericht", 1)).map(g => g.content)).toEqual(["bericht 2"]);
    expect(await memory.matchingGoals("Urlaub", 10)).toEqual([]);
  });

  test("gleiche Texte: zwei IDs, genau der gewählte Eintrag ändert sich", async () => {
    const memory = freshMemory();
    await memory.addGoal("Bericht", new Date("2026-11-01T00:00:00.000Z"));
    await memory.addGoal("Bericht", new Date("2026-12-01T00:00:00.000Z"));
    const [first, second] = await memory.matchingGoals("Bericht", 10);
    expect(first.id).not.toBe(second.id);
    expect(await memory.completeGoalById(String(second.id))).toBe(true);
    expect((await memory.activeGoals()).map(g => g.deadline)).toEqual(["2026-11-01T00:00:00.000Z"]);
    // Zweimal dieselbe ID: beim zweiten Mal gibt es das offene Ziel nicht mehr
    expect(await memory.completeGoalById(String(second.id))).toBe(false);
    expect(await memory.cancelGoalById(String(second.id))).toBe(false);
    expect(await memory.cancelGoalById(String(first.id))).toBe(true);
    expect(await memory.activeGoals()).toEqual([]);
  });

  test("Fakt per ID löschen; unbekannte oder schon gelöschte ID: false", async () => {
    const memory = freshMemory();
    await memory.addFact("Alex trinkt Tee");
    await memory.addFact("Mia trinkt Tee");
    const [alex] = await memory.matchingFacts("tee", 10);
    expect(await memory.deleteFactById(String(alex.id))).toBe(true);
    expect(await memory.deleteFactById(String(alex.id))).toBe(false);
    expect(await memory.deleteFactById("gibt-es-nicht")).toBe(false);
    expect((await memory.facts()).map(f => f.content)).toEqual(["Mia trinkt Tee"]);
  });
});

describe("prozessübergreifend", () => {
  test("zwei Prozesse legen gleichzeitig je 15 Fakten an: alle 30 sind da", async () => {
    const file = tempFile();
    const adapter = join(import.meta.dir, "../src/lib/store/file/memory.ts");
    const script = (who: string) =>
      `const { fileMemory } = await import(${JSON.stringify(adapter)});
const memory = fileMemory(() => ${JSON.stringify(file)});
for (let i = 0; i < 15; i++) await memory.addFact("${who} " + i);`;
    const procs = ["A", "B"].map(who => Bun.spawn(["bun", "-e", script(who)], { stderr: "pipe", env: { PATH: process.env.PATH ?? "" } }));
    const codes = await Promise.all(procs.map(p => p.exited));
    expect(codes).toEqual([0, 0]);
    const facts = (await fileMemory(() => file).facts()).map(f => f.content);
    expect(facts).toHaveLength(30);
    expect(new Set(facts).size).toBe(30);
  });
});

describe("Treffer und Änderung per ID (Supabase)", () => {
  function table(rows: Row[]) {
    const fake = useMemoryTable({ rows });
    cleanups.push(() => fake.restore());
    resetStore();
    expect(getStore().backend).toBe("supabase");
    return fake;
  }

  const ROWS: Row[] = [
    { type: "goal", content: "Bericht A" },
    { type: "completed_goal", content: "Bericht erledigt" },
    { type: "fact", content: "Bericht über Tee" },
    { type: "goal", content: "Bericht B" },
  ];

  test("matchingGoals: nur offene Ziele, älteste zuerst, limit in der Abfrage", async () => {
    const fake = table(ROWS);
    expect((await getStore().memory.matchingGoals("bericht", 10)).map(r => r.content)).toEqual(["Bericht A", "Bericht B"]);
    const query = fake.tableRequests().at(-1)!.url.searchParams;
    expect([query.get("type"), query.get("order"), query.get("limit")]).toEqual(["eq.goal", "created_at.asc", "10"]);
    expect((await getStore().memory.matchingGoals("bericht", 1)).map(r => r.content)).toEqual(["Bericht A"]);
    expect((await getStore().memory.matchingFacts("BERICHT", 10)).map(r => r.content)).toEqual(["Bericht über Tee"]);
  });

  test("completeGoalById und cancelGoalById: nur ein offenes Ziel mit genau dieser ID", async () => {
    const fake = table(ROWS);
    const [a, b] = await getStore().memory.matchingGoals("bericht", 10);
    expect(await getStore().memory.completeGoalById(String(b.id))).toBe(true);
    expect(fake.table.find(r => r.id === b.id)).toMatchObject({ type: "completed_goal", completed_at: expect.any(String) });
    expect(fake.table.find(r => r.id === a.id)).toMatchObject({ type: "goal" });
    expect(await getStore().memory.completeGoalById(String(b.id))).toBe(false);
    expect(await getStore().memory.cancelGoalById(String(b.id))).toBe(false);
    const fact = fake.table.find(r => r.type === "fact")!;
    expect(await getStore().memory.cancelGoalById(String(fact.id))).toBe(false);
    expect(await getStore().memory.cancelGoalById(String(a.id))).toBe(true);
    expect(fake.table.map(r => r.content)).toEqual(["Bericht erledigt", "Bericht über Tee", "Bericht B"]);
  });

  test("deleteFactById löscht nur Fakten; zweimal: false", async () => {
    const fake = table(ROWS);
    const goal = fake.table[0];
    expect(await getStore().memory.deleteFactById(String(goal.id))).toBe(false);
    const [fact] = await getStore().memory.matchingFacts("tee", 10);
    expect(await getStore().memory.deleteFactById(String(fact.id))).toBe(true);
    expect(await getStore().memory.deleteFactById(String(fact.id))).toBe(false);
    expect(fake.table.some(r => r.type === "fact")).toBe(false);
  });

  test("Fehler der Datenbank: bei Zielen ein Fehler statt „kein Treffer“, bei Fakten false", async () => {
    const fake = useMemoryTable({ rows: ROWS, failTable: true });
    const error = spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(() => fake.restore(), () => error.mockRestore());
    resetStore();
    await expect(getStore().memory.matchingGoals("bericht", 10)).rejects.toThrow("Supabase: Ziele suchen gescheitert");
    await expect(getStore().memory.completeGoalById("1")).rejects.toThrow("Supabase: Ziel erledigen gescheitert");
    await expect(getStore().memory.cancelGoalById("1")).rejects.toThrow("Supabase: Ziel streichen gescheitert");
    expect(await getStore().memory.deleteFactById("3")).toBe(false);
  });
});
