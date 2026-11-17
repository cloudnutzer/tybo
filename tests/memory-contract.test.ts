/**
 * Issue #311: Vertrag für Fakten und Ziele über Supabase. Hielt fest, was die
 * alten Einstiege in supabase.ts taten (entfallen mit Issue #382, es bleibt
 * der Weg über getStore().memory): Anlegen mit asynchronem Embedding
 * samt embedding_model (Rückfall ohne die Spalte), Lesen in fester
 * Reihenfolge, Löschen, Erledigen und Streichen per Teiltext (erster
 * Treffer), Ziele mit Frist, Delta nach created_at und leere bzw. falsche
 * Antworten ohne Supabase oder bei Fehlern (Fehler beim Ändern von Zielen werfen
 * seit #518). Das echte Schema prüft memory-goals-pg.test.ts. Jeder Fall läuft gegen
 * jeden Weg in WAYS; kein Netz, supabase-js gegen die Attrappe aus
 * memory-fixture.ts.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { FACT_DATE_NOTE, memoryDelta } from "../src/lib/memory/context";
import { getStore, resetStore } from "../src/lib/store";
import { supabaseMemory } from "../src/lib/store/supabase/memory";
import type { MemoryItem } from "../src/lib/store/types";
import { pad, useMemoryTable, type MemoryTableOptions, type Row } from "./memory-fixture";

/** Ein Weg zu Fakten und Zielen, in der Sprache des Stores */
interface Way {
  name: string;
  addFact(content: string): Promise<boolean>;
  facts(): Promise<MemoryItem[]>;
  deleteFact(text: string): Promise<boolean>;
  addGoal(content: string, deadline?: Date): Promise<boolean>;
  activeGoals(): Promise<MemoryItem[]>;
  completeGoal(text: string): Promise<boolean>;
  cancelGoal(text: string): Promise<boolean>;
  /** Delta als Text im Format der Resume-Prompts */
  delta(since: Date): Promise<string>;
}

const WAYS: Way[] = [
  {
    name: "getStore().memory",
    addFact: c => freshMemory().addFact(c),
    facts: () => freshMemory().facts(),
    deleteFact: t => freshMemory().deleteFact(t),
    addGoal: (c, d) => freshMemory().addGoal(c, d),
    activeGoals: () => freshMemory().activeGoals(),
    completeGoal: t => freshMemory().completeGoal(t),
    cancelGoal: t => freshMemory().cancelGoal(t),
    delta: async since => memoryDelta(await freshMemory().changedSince(since)),
  },
];

/** Store neu wählen, damit die Umgebung der Attrappe gilt */
function freshMemory() {
  resetStore();
  const store = getStore();
  expect(store.backend).toBe("supabase");
  return store.memory;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetStore();
});

function table(options: MemoryTableOptions = {}) {
  const fake = useMemoryTable(options);
  cleanups.push(() => fake.restore());
  return fake;
}

const SEED: Row[] = [
  { type: "fact", content: "Alex trinkt morgens Tee" },
  { type: "goal", content: "Steuererklärung abgeben", deadline: "2026-11-30T23:59:59.000Z" },
  { type: "fact", content: "Mia wohnt in Hamburg" },
  { type: "goal", content: "Fahrrad reparieren" },
  { type: "completed_goal", content: "Keller aufräumen" },
  { type: "fact", content: "Lieblingsfarbe ist Grün" },
];

const contents = (items: MemoryItem[]) => items.map(i => i.content);

for (const way of WAYS) {
  describe(`Gedächtnis-Vertrag: ${way.name}`, () => {
    test("Fakten neueste zuerst, aktive Ziele älteste zuerst, erledigte fehlen", async () => {
      table({ rows: SEED });
      expect(contents(await way.facts())).toEqual(["Lieblingsfarbe ist Grün", "Mia wohnt in Hamburg", "Alex trinkt morgens Tee"]);
      const goals = await way.activeGoals();
      expect(contents(goals)).toEqual(["Steuererklärung abgeben", "Fahrrad reparieren"]);
      expect(goals[0].deadline).toBe("2026-11-30T23:59:59.000Z");
      expect(goals.every(g => g.type === "goal" && typeof g.id === "string" && typeof g.created_at === "string")).toBe(true);
    });

    test("addFact legt den Fakt an und schreibt das Embedding danach samt embedding_model", async () => {
      let release!: () => void;
      const held = new Promise<void>(resolve => (release = resolve));
      cleanups.push(() => release());
      const fake = table({ embed: () => pad([0.25, 0.5]), holdEmbedding: held });
      process.env.OPENAI_API_KEY = "sk-test-gedaechtnis";
      // Solange der Anbieter nicht antwortet, muss addFact schon fertig sein
      const settled = await Promise.race([way.addFact("Alex mag Jazz"), Bun.sleep(2000).then(() => "wartet auf das Embedding")]);
      expect(settled).toBe(true);
      const insert = fake.tableRequests().find(r => r.method === "POST")!;
      expect(JSON.parse(insert.body)).toEqual({ type: "fact", content: "Alex mag Jazz" });
      await fake.until(() => fake.embeddingRequests().length === 1);
      expect(fake.tableRequests().some(r => r.method === "PATCH")).toBe(false);
      release();
      await fake.until(() => fake.tableRequests().some(r => r.method === "PATCH"));
      const patch = fake.tableRequests().find(r => r.method === "PATCH")!;
      expect(patch.url.searchParams.get("id")).toBe(`eq.${fake.table[0].id}`);
      expect(JSON.parse(patch.body)).toEqual({ embedding: pad([0.25, 0.5]), embedding_model: "openai:text-embedding-3-small" });
      expect(fake.embeddingRequests().map(r => JSON.parse(r.body).input)).toEqual(["Alex mag Jazz"]);
    });

    test("addFact: fehlt die Spalte embedding_model, nur embedding", async () => {
      const fake = table({ embed: () => pad([0.5, 0.5]), missingModelColumn: true });
      process.env.OPENAI_API_KEY = "sk-test-gedaechtnis";
      expect(await way.addFact("Mia spielt Cello")).toBe(true);
      await fake.until(() => fake.tableRequests().filter(r => r.method === "PATCH").length === 2);
      const patches = fake.tableRequests().filter(r => r.method === "PATCH").map(r => JSON.parse(r.body));
      expect(patches).toEqual([{ embedding: pad([0.5, 0.5]), embedding_model: "openai:text-embedding-3-small" }, { embedding: pad([0.5, 0.5]) }]);
      expect(fake.table[0].embedding).toEqual(pad([0.5, 0.5]));
    });

    test("addFact ohne Embedding-Schlüssel: Fakt gespeichert, kein Update", async () => {
      const fake = table();
      expect(await way.addFact("Alex fährt Rad")).toBe(true);
      await Bun.sleep(30);
      expect(fake.tableRequests().map(r => r.method)).toEqual(["POST"]);
      expect(fake.table.map(r => r.content)).toEqual(["Alex fährt Rad"]);
    });

    test("addGoal mit und ohne Frist", async () => {
      const fake = table();
      expect(await way.addGoal("Urlaub buchen", new Date("2026-12-01T10:00:00.000Z"))).toBe(true);
      expect(await way.addGoal("Mehr lesen")).toBe(true);
      const bodies = fake.tableRequests().filter(r => r.method === "POST").map(r => JSON.parse(r.body));
      expect(bodies).toEqual([
        { type: "goal", content: "Urlaub buchen", deadline: "2026-12-01T10:00:00.000Z" },
        { type: "goal", content: "Mehr lesen" },
      ]);
    });

    test("deleteFact löscht den ersten Treffer per Teiltext, ohne Groß- und Kleinschreibung", async () => {
      const fake = table({ rows: [{ type: "fact", content: "Tee am Morgen" }, { type: "fact", content: "Tee am Abend" }, { type: "goal", content: "Tee kaufen" }] });
      expect(await way.deleteFact("tee")).toBe(true);
      expect(fake.table.map(r => r.content)).toEqual(["Tee am Abend", "Tee kaufen"]);
      expect(await way.deleteFact("Kaffee")).toBe(false);
      expect(fake.table).toHaveLength(2);
    });

    test("completeGoal markiert den ersten offenen Treffer mit Zeitpunkt", async () => {
      const fake = table({ rows: [{ type: "completed_goal", content: "Bericht schreiben" }, { type: "goal", content: "Bericht lesen" }, { type: "fact", content: "Bericht ist lang" }] });
      expect(await way.completeGoal("bericht")).toBe(true);
      const done = fake.table.find(r => r.content === "Bericht lesen")!;
      expect(done.type).toBe("completed_goal");
      expect(Number.isNaN(Date.parse(String(done.completed_at)))).toBe(false);
      expect(fake.table.find(r => r.content === "Bericht ist lang")!.type).toBe("fact");
      expect(await way.completeGoal("bericht")).toBe(false);
    });

    test("cancelGoal löscht den ersten offenen Treffer, Fakten und erledigte Ziele bleiben", async () => {
      const fake = table({ rows: [{ type: "completed_goal", content: "Garten gießen" }, { type: "fact", content: "Garten ist groß" }, { type: "goal", content: "Garten mähen" }] });
      expect(await way.cancelGoal("Garten")).toBe(true);
      expect(fake.table.map(r => r.content)).toEqual(["Garten gießen", "Garten ist groß"]);
      expect(await way.cancelGoal("Garten")).toBe(false);
    });

    test("Delta: nur nach dem Zeitpunkt angelegte Fakten und aktive Ziele, Ziele mit Frist", async () => {
      table({
        rows: [
          { type: "fact", content: "alter Fakt", created_at: "2026-10-01T10:00:00.000Z" },
          { type: "fact", content: "neuer Fakt", created_at: "2026-10-02T10:00:00.000Z" },
          { type: "goal", content: "altes Ziel", created_at: "2026-10-01T09:00:00.000Z" },
          { type: "goal", content: "neues Ziel", deadline: "2026-12-24T18:00:00.000Z", created_at: "2026-10-03T10:00:00.000Z" },
          { type: "completed_goal", content: "neu und erledigt", created_at: "2026-10-03T11:00:00.000Z" },
          { type: "fact", content: "genau am Zeitpunkt", created_at: "2026-10-01T12:00:00.000Z" },
        ],
      });
      expect(await way.delta(new Date("2026-10-01T12:00:00.000Z"))).toBe(
        [FACT_DATE_NOTE, "- [fact] [2026-10-02] neuer Fakt", "- [goal] neues Ziel (due: 2026-12-24T18:00:00.000Z)"].join("\n"),
      );
      expect(await way.delta(new Date("2026-10-05T00:00:00.000Z"))).toBe("");
    });

    test("bei Fehlern der Datenbank: Lesen leer, Anlegen false, Ändern von Zielen wirft", async () => {
      const error = spyOn(console, "error").mockImplementation(() => {});
      cleanups.push(() => error.mockRestore());
      table({ failTable: true, rows: SEED });
      expect(await way.facts()).toEqual([]);
      expect(await way.activeGoals()).toEqual([]);
      expect(await way.addFact("x")).toBe(false);
      expect(await way.addGoal("x")).toBe(false);
      expect(await way.deleteFact("Tee")).toBe(false);
      await expect(way.completeGoal("Fahrrad")).rejects.toThrow("Supabase: Ziele suchen gescheitert");
      await expect(way.cancelGoal("Fahrrad")).rejects.toThrow("Supabase: Ziele suchen gescheitert");
      expect(await way.delta(new Date(0))).toBe("");
    });
  });
}

describe("ohne Supabase: Adapter ohne Client", () => {
  test("getStore().memory-Adapter: false bzw. leer, keine Anfrage", async () => {
    const fake = table({ rows: SEED });
    const memory = supabaseMemory(() => null);
    expect(await memory.addFact("x")).toBe(false);
    expect(await memory.facts()).toEqual([]);
    expect(await memory.deleteFact("x")).toBe(false);
    expect(await memory.addGoal("x", new Date())).toBe(false);
    expect(await memory.activeGoals()).toEqual([]);
    expect(await memory.completeGoal("x")).toBe(false);
    expect(await memory.cancelGoal("x")).toBe(false);
    expect(await memory.changedSince(new Date(0))).toEqual([]);
    expect(await memory.factVectors({ vector: [1], config: { provider: "openai", model: "text-embedding-3-small" } })).toBeNull();
    expect(fake.requests).toEqual([]);
  });
});

describe("Teiltext wörtlich (Maskierung, #311)", () => {
  const TRICKY = [
    { type: "fact", content: "Rabatt 50% auf alles" },
    { type: "fact", content: "Rabatt 50 auf alles" },
    { type: "fact", content: "Datei a_b.txt" },
    { type: "fact", content: "Datei axb.txt" },
    { type: "fact", content: "Pfad C:\\temp" },
  ];

  test("% , _ und \\ im Suchtext stehen maskiert im Request und treffen nur sich selbst", async () => {
    const fake = table({ rows: [...TRICKY].reverse() });
    const memory = freshMemory();
    expect(await memory.deleteFact("%")).toBe(true);
    expect(await memory.deleteFact("a_b")).toBe(true);
    expect(await memory.deleteFact("C:\\")).toBe(true);
    const patterns = fake.tableRequests().filter(r => r.method === "GET").map(r => r.url.searchParams.get("content"));
    expect(patterns).toEqual(["ilike.%\\%%", "ilike.%a\\_b%", "ilike.%C:\\\\%"]);
    expect(fake.table.map(r => r.content).sort()).toEqual(["Datei axb.txt", "Rabatt 50 auf alles"]);
  });

  test("gleiche Maskierung beim Erledigen und Streichen von Zielen", async () => {
    const fake = table({ rows: [{ type: "goal", content: "Quote 100% erreichen" }, { type: "goal", content: "Quote 1000 erreichen" }] });
    const memory = freshMemory();
    expect(await memory.completeGoal("0%")).toBe(true);
    expect(fake.table.find(r => r.content === "Quote 100% erreichen")!.type).toBe("completed_goal");
    expect(await memory.cancelGoal("_")).toBe(false);
    const patterns = fake.tableRequests().filter(r => r.method === "GET").map(r => r.url.searchParams.get("content"));
    expect(patterns).toEqual(["ilike.%0\\%%", "ilike.%\\_%"]);
  });
});

describe("factVectors (#311)", () => {
  const query = { vector: pad([1, 0]), config: { provider: "openai" as const, model: "text-embedding-3-small" } };

  test("geprüfte Vektoren aus der RPC für Anbieter und Modell des Suchvektors", async () => {
    const fake = table({
      rows: [{ type: "fact", content: "a", embedding: "[9]" }],
      factVectors: () => new Response(JSON.stringify([{ id: 1, embedding: "[0.5,0.5]" }])),
    });
    const vectors = await freshMemory().factVectors(query);
    expect([...vectors!]).toEqual([["1", [0.5, 0.5]]]);
    expect(JSON.parse(fake.factVectorRequests()[0].body)).toEqual({ p_provider: "openai", p_model: "text-embedding-3-small" });
    expect(fake.tableRequests()).toEqual([]);
  });

  test("leere Antwort oder Fehler: null, die Zeilen werden nicht gelesen", async () => {
    for (const answer of [() => new Response("[]"), () => new Response("x", { status: 500 })]) {
      const fake = table({ rows: [{ type: "fact", content: "a", embedding: "[9]" }], factVectors: answer });
      expect(await freshMemory().factVectors(query)).toBeNull();
      expect(fake.tableRequests()).toEqual([]);
      cleanups.pop()!();
    }
  });

  test("fehlende Migration: rohe Vektoren der Fakten aus der Tabelle", async () => {
    const fake = table({
      rows: [{ type: "fact", content: "a", embedding: "[1,2]" }, { type: "fact", content: "b" }, { type: "goal", content: "c", embedding: "[3]" }],
      factVectors: () => new Response(JSON.stringify({ code: "PGRST202" }), { status: 404 }),
    });
    const vectors = await freshMemory().factVectors(query);
    expect([...vectors!]).toEqual([["1", [1, 2]]]);
    expect(fake.tableRequests()[0].url.searchParams.get("select")).toBe("id,embedding");
  });
});
