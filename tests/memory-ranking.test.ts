/**
 * Issue #311: Auswahl der Fakten im Gedächtnis-Kontext über den Weg, den
 * der Betrieb nimmt: src/lib/memory (Dienst):getMemoryContext(userMessage) mit
 * Supabase. Liegen die Fakten über MEMORY_CONTEXT_CHARS, entscheidet bei
 * einem Suchtext der Vektor (geprüft über embedding_fact_vectors), sonst die
 * Wortüberlappung; mindestens zehn Fakten, Ziele immer vollständig. Kein
 * Netz: Tabelle, RPCs und OpenAI kommen aus memory-fixture.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getMemoryContext } from "../src/lib/memory";
import { resetStore } from "../src/lib/store";
import { pad, useMemoryTable, type MemoryTableOptions, type Row } from "./memory-fixture";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetStore();
});

/** Tabelle mit Fakten und Zielen; mit Schlüssel für Embeddings */
function table(options: MemoryTableOptions, withKey = true) {
  resetStore();
  const fake = useMemoryTable(options);
  cleanups.push(() => fake.restore());
  if (withKey) process.env.OPENAI_API_KEY = "sk-test-ranking";
  return fake;
}

/** Füllwort ohne Bezug zur Frage, damit jeder Fakt das Budget belastet */
const FILLER = "ipsum ".repeat(100).trim();
const QUESTION = "Wohin geht der Urlaub nach Italien?";
const GOALS: Row[] = [
  { type: "goal", content: "Sprachkurs abschließen", completed: false },
  { type: "goal", content: "Zwölf Bücher lesen", completed: false },
  { type: "goal", content: "Balkon bepflanzen", completed: false },
];

/** Zwölf Fakten, älteste zuerst angelegt; Fakt 02 passt wörtlich zur Frage */
function factRows(withVectors = false): Row[] {
  return Array.from({ length: 12 }, (_, i) => {
    const label = `Fakt ${String(i).padStart(2, "0")}`;
    const content = i === 2 ? `${label}: Urlaub in Italien, ${FILLER}` : `${label}: ${FILLER}`;
    const row: Row = { type: "fact", content };
    // Rohe Vektoren der Zeilen: Fakt 00 und 01 passen der Bedeutung nach
    if (withVectors) row.embedding = JSON.stringify(pad(i === 0 ? [1, 0] : i === 1 ? [0.9, 0.1] : [0, 1]));
    return row;
  });
}

/** Antwort der RPC embedding_fact_vectors: Vektoren je id wie PostgREST sie liefert */
function rpcVectors(vectors: Record<string, number[]>) {
  return () => new Response(JSON.stringify(Object.entries(vectors).map(([id, v]) => ({ id: Number(id), embedding: JSON.stringify(pad(v)) }))));
}

/** Labels der Fakten in der Reihenfolge des Kontexts */
function factOrder(context: string): string[] {
  return [...context.matchAll(/^- (Fakt \d\d):/gm)].map(m => m[1]);
}

const GOAL_SECTION = "**Active Goals:**\n1. Sprachkurs abschließen\n2. Zwölf Bücher lesen\n3. Balkon bepflanzen";
const NOTE = (shown: number, total: number) => `_(${shown} of ${total} facts shown — most relevant to the current message)_`;

/** Lexikalisch: Fakt 02 vorn, dann neueste zuerst; Fakt 01 und 00 fallen heraus */
const LEXICAL = ["Fakt 02", "Fakt 11", "Fakt 10", "Fakt 09", "Fakt 08", "Fakt 07", "Fakt 06", "Fakt 05", "Fakt 04", "Fakt 03"];
/** Nach Vektor: Fakt 00 und 01 vorn, der Rest (gleich weit weg) neueste zuerst */
const BY_VECTOR = ["Fakt 00", "Fakt 01", "Fakt 11", "Fakt 10", "Fakt 09", "Fakt 08", "Fakt 07", "Fakt 06", "Fakt 05", "Fakt 04"];

/** Vektoren der RPC: Ids 1 bis 12 sind Fakt 00 bis 11 (Ziele kommen danach) */
const RPC_VECTORS = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), i === 0 ? [1, 0] : i === 1 ? [0.9, 0.1] : [0, 1]]));

describe("Gedächtnis-Kontext über den Gedächtnis-Dienst mit Supabase", () => {
  // Vor dem Umbau rot (bis Checkbox 4 als test.failing): der Betriebsweg rankte immer nur lexikalisch (Issue #311)
  test("Fakten über Budget: Reihenfolge nach Vektor entgegen der lexikalischen, Ziele vollständig", async () => {
    const fake = table({ rows: [...factRows(), ...GOALS], embed: () => pad([1, 0]), factVectors: rpcVectors(RPC_VECTORS) });
    const context = await getMemoryContext(QUESTION);
    expect(factOrder(context)).toEqual(BY_VECTOR);
    expect(context).toContain(GOAL_SECTION);
    expect(context).toContain(NOTE(10, 12));
    expect(fake.embeddingRequests().map(r => JSON.parse(r.body).input)).toEqual([QUESTION]);
    expect(JSON.parse(fake.factVectorRequests()[0].body)).toEqual({ p_provider: "openai", p_model: "text-embedding-3-small" });
  });

  // Vor dem Umbau ebenso rot: rohe Vektoren wurden im Betrieb nie gelesen
  test("RPC meldet fehlende Migration: rohe Vektoren der Zeilen entscheiden", async () => {
    table({
      rows: [...factRows(true), ...GOALS],
      embed: () => pad([1, 0]),
      factVectors: () => new Response(JSON.stringify({ code: "PGRST202" }), { status: 404 }),
    });
    const context = await getMemoryContext(QUESTION);
    expect(factOrder(context)).toEqual(BY_VECTOR);
    expect(context).toContain(GOAL_SECTION);
  });

  for (const [name, answer] of [
    ["leere Antwort (Anbieterwechsel, laufende Umstellung)", () => new Response("[]")],
    ["Fehler", () => new Response("boom", { status: 503 })],
  ] as const) {
    test(`RPC ${name}: lexikalische Reihenfolge, rohe Vektoren bleiben unbeachtet`, async () => {
      table({ rows: [...factRows(true), ...GOALS], embed: () => pad([1, 0]), factVectors: answer });
      const context = await getMemoryContext(QUESTION);
      expect(factOrder(context)).toEqual(LEXICAL);
      expect(context).toContain(GOAL_SECTION);
      expect(context).toContain(NOTE(10, 12));
    });
  }

  test("ohne Embedding-Schlüssel: lexikalisch", async () => {
    table({ rows: [...factRows(true), ...GOALS], factVectors: rpcVectors(RPC_VECTORS) }, false);
    expect(factOrder(await getMemoryContext(QUESTION))).toEqual(LEXICAL);
  });

  test("unter Budget mit Suchtext: alle Fakten neueste zuerst, keine Embedding-Anfrage, kein Hinweis", async () => {
    const fake = table({
      rows: [{ type: "fact", content: "Alex mag Tee" }, { type: "fact", content: "Urlaub in Italien" }, ...GOALS],
      factVectors: rpcVectors({ "1": [1, 0] }),
    });
    const context = await getMemoryContext(QUESTION);
    expect(context).toBe(`**Known Facts:**\n- Urlaub in Italien\n- Alex mag Tee\n\n${GOAL_SECTION}`);
    expect(fake.embeddingRequests()).toEqual([]);
    expect(fake.factVectorRequests()).toEqual([]);
  });

  test("ohne Suchtext über Budget: gekürzt in Speicherreihenfolge, keine Embedding-Anfrage", async () => {
    const fake = table({ rows: [...factRows(true), ...GOALS], factVectors: rpcVectors(RPC_VECTORS) });
    const context = await getMemoryContext();
    expect(factOrder(context)).toEqual(["Fakt 11", "Fakt 10", "Fakt 09", "Fakt 08", "Fakt 07", "Fakt 06", "Fakt 05", "Fakt 04", "Fakt 03", "Fakt 02"]);
    expect(context).toContain(NOTE(10, 12));
    expect(context).toContain(GOAL_SECTION);
    expect(fake.embeddingRequests()).toEqual([]);
    expect(fake.factVectorRequests()).toEqual([]);
  });

  test("mindestens zehn Fakten, auch wenn schon einer das Budget sprengt; Hinweiszeile wortgleich", async () => {
    const big = "lang ".repeat(1400).trim();
    const rows: Row[] = Array.from({ length: 12 }, (_, i) => ({ type: "fact", content: `Fakt ${String(i).padStart(2, "0")}: ${big}` }));
    table({ rows }, false);
    const context = await getMemoryContext(QUESTION);
    expect(factOrder(context)).toHaveLength(10);
    expect(context.endsWith(`\n${NOTE(10, 12)}`)).toBe(true);
    expect(context.startsWith("**Known Facts:**\n- Fakt 11: ")).toBe(true);
  });

  test("nur Ziele: nur der Zielabschnitt; nichts gespeichert: leerer Text", async () => {
    table({ rows: GOALS });
    expect(await getMemoryContext(QUESTION)).toBe(GOAL_SECTION);
    cleanups.pop()!();
    table({ rows: [] });
    expect(await getMemoryContext(QUESTION)).toBe("");
  });
});
