/**
 * Issue #311: Welchen Weg src/lib/memory (Dienst):getMemoryContext nimmt. Mit
 * Supabase baut src/lib/memory/context.ts den Kontext aus getStore().memory,
 * seit #314 auch bei gesetztem CONVEX_URL; ohne Datenbank bleibt es beim
 * Datei-Fallback (bis #316); seit #316 aus dem Datei-Adapter, weiterhin
 * vollständig und ohne Embedding-Anfrage. Den Convex-Weg
 * (buildMemoryContextString in supabase.ts) gibt es seit Issue #382 nicht
 * mehr (Entscheidung E1).
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMemoryContext } from "../src/lib/memory";
import { FACT_DATE_NOTE } from "../src/lib/memory/context";
import { resetStore } from "../src/lib/store";
import { pad, useMemoryTable, type Row } from "./memory-fixture";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetStore();
});

const FILLER = "ipsum ".repeat(100).trim();
const QUESTION = "Wohin geht der Urlaub nach Italien?";
/** Zwölf Fakten über dem Budget; Fakt 02 passt wörtlich, Fakt 00 der Bedeutung nach */
const FACTS: Row[] = Array.from({ length: 12 }, (_, i) => ({
  type: "fact",
  content: `Fakt ${String(i).padStart(2, "0")}: ${i === 2 ? "Urlaub in Italien, " : ""}${FILLER}`,
}));
const firstFact = (context: string) => /^- \[[^\]]+\] (Fakt \d\d):/m.exec(context)?.[1];

function supabaseTable() {
  resetStore();
  const fake = useMemoryTable({
    rows: FACTS,
    embed: () => pad([1, 0]),
    factVectors: () => new Response(JSON.stringify(FACTS.map((_, i) => ({ id: i + 1, embedding: JSON.stringify(pad(i === 0 ? [1, 0] : [0, 1])) })))),
  });
  cleanups.push(() => fake.restore());
  process.env.OPENAI_API_KEY = "sk-test-wege";
  return fake;
}

describe("Gedächtnis-Dienst: getMemoryContext, Wahl des Weges", () => {
  test("Supabase ohne CONVEX_URL: Kontext aus dem Store, nach Vektor", async () => {
    const fake = supabaseTable();
    expect(firstFact(await getMemoryContext(QUESTION))).toBe("Fakt 00");
    expect(fake.factVectorRequests()).toHaveLength(1);
  });

  test("Budget aus MEMORY_CONTEXT_CHARS beim Aufruf gelesen", async () => {
    supabaseTable();
    const saved = process.env.MEMORY_CONTEXT_CHARS;
    cleanups.push(() => (saved === undefined ? delete process.env.MEMORY_CONTEXT_CHARS : (process.env.MEMORY_CONTEXT_CHARS = saved)));
    process.env.MEMORY_CONTEXT_CHARS = "100000";
    const context = await getMemoryContext(QUESTION);
    expect(firstFact(context)).toBe("Fakt 11");
    expect(context).not.toContain("facts shown");
  });

  test("unlesbares Budget (abc) beim Aufruf: wie bisher nie gekürzt, keine Embedding-Anfrage", async () => {
    const fake = supabaseTable();
    const saved = process.env.MEMORY_CONTEXT_CHARS;
    cleanups.push(() => (saved === undefined ? delete process.env.MEMORY_CONTEXT_CHARS : (process.env.MEMORY_CONTEXT_CHARS = saved)));
    process.env.MEMORY_CONTEXT_CHARS = "abc";
    const context = await getMemoryContext(QUESTION);
    expect(context.match(/^- \[[^\]]+\] Fakt \d\d:/gm)).toHaveLength(12);
    expect(firstFact(context)).toBe("Fakt 11");
    expect(context).not.toContain("facts shown");
    expect(fake.embeddingRequests()).toEqual([]);
    expect(fake.factVectorRequests()).toEqual([]);
  });

  test("CONVEX_URL neben Supabase zählt nicht (Issue #314): Kontext aus dem Store, nach Vektor", async () => {
    const fake = supabaseTable();
    process.env.CONVEX_URL = "https://beispiel.convex.cloud";
    cleanups.push(() => delete process.env.CONVEX_URL);
    expect(firstFact(await getMemoryContext(QUESTION))).toBe("Fakt 00");
    expect(fake.factVectorRequests()).toHaveLength(1);
    expect(fake.requests.every(r => !r.url.host.includes("convex"))).toBe(true);
  });

  test("ohne Datenbank: Datei-Fallback wie bisher (eigener Prozess mit MEMORY_FILE_PATH)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tybo-memory-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "memory.json");
    writeFileSync(file, JSON.stringify({ facts: ["Alex mag Tee"], goals: [{ text: "Mehr lesen", createdAt: "2026-10-01T00:00:00.000Z" }], completedGoals: [] }));
    const script = `import { getMemoryContext } from ${JSON.stringify(join(import.meta.dir, "../src/lib/memory/index.ts"))};
let calls = 0;
globalThis.fetch = (async () => { calls++; throw new Error("kein Netz"); }) as typeof fetch;
process.stdout.write(JSON.stringify({ context: await getMemoryContext(${JSON.stringify(QUESTION)}), calls }));`;
    const proc = Bun.spawnSync(["bun", "-e", script], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: dir, MEMORY_FILE_PATH: file },
    });
    expect(proc.stderr.toString()).toBe("");
    expect(JSON.parse(proc.stdout.toString())).toEqual({
      context: `**Known Facts:**\n${FACT_DATE_NOTE}\n- [Anlagedatum unbekannt] Alex mag Tee\n\n**Active Goals:**\n1. Mehr lesen`,
      calls: 0,
    });
  });

  test("ohne Datenbank über dem Budget, Embedding-Zugang gesetzt: alle Fakten, keine Anbieteranfrage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tybo-memory-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "memory.json");
    const facts = FACTS.map(row => row.content);
    expect(facts.reduce((sum, fact) => sum + fact.length, 0)).toBeGreaterThan(6000);
    writeFileSync(file, JSON.stringify({ facts, goals: [], completedGoals: [] }));
    const script = `import { getMemoryContext } from ${JSON.stringify(join(import.meta.dir, "../src/lib/memory/index.ts"))};
let calls = 0;
globalThis.fetch = (async () => { calls++; throw new Error("kein Netz"); }) as typeof fetch;
process.stdout.write(JSON.stringify({ context: await getMemoryContext(${JSON.stringify(QUESTION)}), calls }));`;
    const proc = Bun.spawnSync(["bun", "-e", script], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: dir, MEMORY_FILE_PATH: file, OPENAI_API_KEY: "sk-test-datei" },
    });
    expect(proc.stderr.toString()).toBe("");
    const { context, calls } = JSON.parse(proc.stdout.toString());
    expect(context).toBe(["**Known Facts:**", FACT_DATE_NOTE, ...facts.map(fact => "- [Anlagedatum unbekannt] " + fact)].join("\n"));
    expect(calls).toBe(0);
  });
});
