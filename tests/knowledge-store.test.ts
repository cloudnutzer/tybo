/**
 * Issue #317: Wissensbasis über den Store. Hält fest, was getKnowledgeContext,
 * addKnowledge und getStore().knowledge tun: Unicode-feste Suchwörter
 * („Größe“ findet den Eintrag), Kontext in einem Datenbankaufruf
 * (knowledge_context), Bedeutungssuche mit Anbieter und Modell des
 * Suchvektors, Textrückfall mit einer Tabellenabfrage je Vorrang-Kategorie
 * und je Suchwort, wenn die Funktion fehlt oder scheitert, und ohne Datenbank leerer Kontext bzw. ein
 * ehrlicher Schreibfehler. Kein Netz: supabase-js gegen eine Attrappe hinter
 * globalThis.fetch. Das SQL selbst prüft tests/knowledge-context-pg.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addKnowledge, CONTEXT_MAX_ENTRIES, getKnowledgeContext } from "../src/lib/knowledge-base";
import { getStore, resetStore } from "../src/lib/store";
import { knowledgeTerms, mentions } from "../src/lib/store/knowledge-terms";
import { supabaseKnowledge } from "../src/lib/store/supabase/knowledge";
import { getSupabase, resetSupabaseClient } from "../src/lib/supabase";

const BASE = "http://supabase.test";
const VARS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "EMBEDDING_PROVIDER", "EMBEDDING_MODEL"];

interface Row {
  id: string;
  category: string;
  title: string;
  content: string;
  tags?: string[];
  related_project?: string | null;
  updated_at: string;
}

interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: Record<string, unknown> | null;
}

/** Wie der Fake auf knowledge_context antwortet */
type RpcMode = "ok" | "missing" | "broken";

let saved: Record<string, string | undefined>;
let realFetch: typeof fetch;
let calls: Call[];
let table: Row[];
let rpcMode: RpcMode;
let semanticRows: Row[];

const lower = (s: string) => s.toLocaleLowerCase();
const newestFirst = (a: Row, b: Row) => b.updated_at.localeCompare(a.updated_at);

/** Nachbau von knowledge_context, so weit der Fake ihn braucht */
function fakeContext(body: Record<string, unknown>): Record<string, unknown>[] {
  const terms = (body.p_terms as string[]) ?? [];
  const perCategory = Number(body.p_per_category);
  const perTerm = Number(body.p_per_term);
  const out: Record<string, unknown>[] = [];
  ["project", "decision", "preference"].forEach(category => {
    for (const row of table.filter(r => r.category === category).sort(newestFirst).slice(0, perCategory)) out.push({ ...row, reason: "priority", similarity: null, stage: 1 });
  });
  const semantic = body.query_embedding ? semanticRows : [];
  for (const row of semantic) out.push({ ...row, reason: "semantic", similarity: 0.9, stage: 2 });
  if (semantic.length === 0) {
    for (const term of terms) {
      const found = table.filter(r => mentions(r, term)).sort(newestFirst).slice(0, perTerm);
      for (const row of found) out.push({ ...row, reason: "text", similarity: null, stage: 3 });
    }
  }
  return out;
}

/** Tabellenabfrage: category=in.(…) und die ilike-Wörter aus or=(…) */
function fakeTable(params: URLSearchParams): Row[] {
  let found = [...table];
  const categories = params.get("category");
  if (categories?.startsWith("in.(")) {
    const wanted = categories.slice(4, -1).split(",");
    found = found.filter(r => wanted.includes(r.category));
  }
  if (categories?.startsWith("eq.")) found = found.filter(r => r.category === categories.slice(3));
  for (const filter of params.getAll("or")) {
    const words = [...filter.matchAll(/title\.ilike\.%([^%,)]*)%/g)].map(m => m[1]);
    if (words.length) found = found.filter(r => words.some(w => lower(r.title).includes(lower(w)) || lower(r.content).includes(lower(w))));
  }
  return found.sort(newestFirst).slice(0, Number(params.get("limit") ?? 1000));
}

beforeEach(() => {
  saved = Object.fromEntries(VARS.map(k => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  process.env.SUPABASE_URL = BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  resetSupabaseClient();
  resetStore();
  calls = [];
  rpcMode = "ok";
  semanticRows = [];
  table = [
    { id: "k-size", category: "reference", title: "Rahmen", content: "Die Größe des Rahmens ist 56 cm.", updated_at: "2026-10-01T10:00:00Z" },
    { id: "k-project", category: "project", title: "Umzug", content: "Umzug im Dezember.", updated_at: "2026-10-02T10:00:00Z" },
    { id: "k-pref", category: "preference", title: "Ton", content: "Kurze Antworten.", updated_at: "2026-10-03T10:00:00Z" },
    { id: "k-other", category: "learning", title: "Kaffee", content: "Espresso braucht 9 bar.", updated_at: "2026-10-04T10:00:00Z" },
  ];
  realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request ? request.url : String(input));
      const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
      const raw = init?.body ?? (request ? await request.text() : null);
      const body = typeof raw === "string" && raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      calls.push({ method, path: url.pathname, params: url.searchParams, body });
      if (url.pathname === "/rest/v1/rpc/knowledge_context") {
        if (rpcMode === "missing") return Response.json({ code: "PGRST202", message: "function not found" }, { status: 404 });
        if (rpcMode === "broken") return Response.json({ code: "XX000", message: "kaputt" }, { status: 500 });
        return Response.json(fakeContext(body ?? {}));
      }
      if (url.pathname === "/rest/v1/rpc/match_knowledge_checked") return Response.json(semanticRows.map(r => ({ ...r, similarity: 0.9 })));
      if (url.pathname === "/rest/v1/knowledge" && method === "GET") return Response.json(fakeTable(url.searchParams));
      if (url.pathname === "/rest/v1/knowledge" && method === "POST") return Response.json({ id: "k-new" }, { status: 201 });
      if (url.pathname.startsWith("/functions/v1/")) return Response.json({ ok: true });
      return new Response("unerwartet", { status: 599 });
    },
    { preconnect: realFetch.preconnect },
  ) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetSupabaseClient();
  resetStore();
});

/** Aufrufe an die Datenbank (Tabellen und Funktionen), ohne Edge Functions */
const dbCalls = () => calls.filter(c => c.path.startsWith("/rest/v1/"));

describe("Suchwörter (knowledgeTerms)", () => {
  test("Umlaute und ß bleiben im Wort", () => {
    expect(knowledgeTerms("Größe", { minLength: 4, max: 3 })).toEqual(["Größe"]);
    expect(knowledgeTerms("Welche Größe hat der Fuß?", { minLength: 4, max: 3 })).toEqual(["Welche", "Größe"]);
    expect(knowledgeTerms("Straße, Übergröße!", { minLength: 4, max: 5 })).toEqual(["Straße", "Übergröße"]);
  });

  test("kombinierende Zeichen: zerlegtes ö wird zusammengesetzt und zählt nicht doppelt", () => {
    const decomposed = "Größe";
    expect(decomposed).not.toBe("Größe");
    expect(knowledgeTerms(decomposed, { minLength: 4, max: 3 })).toEqual(["Größe"]);
    // „Bär“ hat drei Zeichen, auch zerlegt
    expect(knowledgeTerms("Bär", { minLength: 4, max: 3 })).toEqual([]);
  });

  test("andere Schriften, Ziffern; Satzzeichen und Filterzeichen trennen", () => {
    expect(knowledgeTerms("Москва 2026 東京タワー", { minLength: 4, max: 5 })).toEqual(["Москва", "2026", "東京タワー"]);
    const terms = knowledgeTerms("a,b.c(d)e:f\"g'h%i_j*k\\l — title.ilike.%x%,or(", { minLength: 1, max: 50 });
    for (const term of terms) expect(term).toMatch(/^[\p{L}\p{M}\p{N}]+$/u);
  });

  test("ohne Wiederholung (Groß und klein egal), höchstens max, Mindestlänge", () => {
    expect(knowledgeTerms("Haus haus HAUS Garten Keller Dach", { minLength: 4, max: 3 })).toEqual(["Haus", "Garten", "Keller"]);
    expect(knowledgeTerms("ja wo bin ich", { minLength: 4, max: 3 })).toEqual([]);
    expect(knowledgeTerms("", { minLength: 1, max: 3 })).toEqual([]);
  });

  test("mentions: Titel, Inhalt oder gleiches Schlagwort, Groß und klein egal", () => {
    expect(mentions({ title: "x", content: "Die GRÖSSE" }, "größe")).toBe(false);
    expect(mentions({ title: "x", content: "Die GRÖßE" }, "größe")).toBe(true);
    expect(mentions({ title: "x", content: "y", tags: ["Größe"] }, "größe")).toBe(true);
    expect(mentions({ title: "x", content: "y", tags: ["Größen"] }, "größe")).toBe(false);
  });
});

describe("getKnowledgeContext", () => {
  test("„Größe“ findet den Eintrag, ohne Embeddings, in genau einem Datenbankaufruf", async () => {
    const context = await getKnowledgeContext("Größe");
    expect(context).toContain("- [reference] Rahmen: Die Größe des Rahmens ist 56 cm.");
    expect(dbCalls().map(c => c.path)).toEqual(["/rest/v1/rpc/knowledge_context"]);
    const args = dbCalls()[0].body!;
    expect(args.p_terms).toEqual(["Größe"]);
    expect(args.query_embedding).toBeNull();
    expect(args.p_provider).toBeNull();
  });

  test("Vorrang-Wissen und Suchtreffer, jeder Eintrag einmal, im Format des Prompts", async () => {
    // Der Vorrang-Eintrag passt auch zum Suchwort: er steht nur einmal da
    const context = await getKnowledgeContext("Umzug und Größe?");
    expect(context.split("\n")).toEqual([
      "**Knowledge Base:**",
      "- [project] Umzug: Umzug im Dezember.",
      "- [preference] Ton: Kurze Antworten.",
      "- [reference] Rahmen: Die Größe des Rahmens ist 56 cm.",
    ]);
    expect(dbCalls()).toHaveLength(1);
  });

  test("begrenzt auf CONTEXT_MAX_ENTRIES und Inhalt auf 200 Zeichen, Projekt in Klammern", async () => {
    table = Array.from({ length: 40 }, (_, i) => ({
      id: `p${i}`,
      category: ["project", "decision", "preference"][i % 3],
      title: `Eintrag ${i}`,
      content: `Haus ${"x".repeat(300)}`,
      related_project: i === 27 ? "Altbau" : null,
      updated_at: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T10:00:${String(i).padStart(2, "0")}Z`,
    }));
    const lines = (await getKnowledgeContext("Haus Garten Keller")).split("\n").slice(1);
    expect(lines.length).toBeLessThanOrEqual(CONTEXT_MAX_ENTRIES);
    expect(new Set(lines).size).toBe(lines.length);
    for (const line of lines) expect(line.length).toBeLessThan(200 + 40);
    expect(lines.find(l => l.startsWith("- [project] Eintrag 27:"))).toEndWith(" (Altbau)");
  });

  test("mit Suchvektor: Anbieter, Modell und Vektor gehen mit, Treffer nach Bedeutung", async () => {
    semanticRows = [table[3]];
    const embed = async () => ({ vector: [0.1, 0.2], config: { provider: "gemini" as const, model: "gemini-embedding-2" } });
    const context = await getKnowledgeContext("Wie stark muss der Druck sein?", { embed });
    expect(context).toContain("- [learning] Kaffee: Espresso braucht 9 bar.");
    expect(dbCalls()).toHaveLength(1);
    const args = dbCalls()[0].body!;
    expect(args).toMatchObject({ p_provider: "gemini", p_model: "gemini-embedding-2", query_embedding: [0.1, 0.2], match_threshold: 0.7 });
  });

  test("Embedding scheitert: Kontext trotzdem, ohne Vektor", async () => {
    const context = await getKnowledgeContext("Größe", { embed: async () => Promise.reject(new Error("Netz")) });
    expect(context).toContain("Rahmen");
    expect(dbCalls()[0].body!.query_embedding).toBeNull();
  });

  const PRIORITY_PARAMS = ["eq.project", "eq.decision", "eq.preference"];

  for (const mode of ["missing", "broken"] as const) {
    const label = mode === "missing" ? "fehlt (Migration nicht eingespielt)" : "scheitert";

    test(`knowledge_context ${label}: Textrückfall mit einer Abfrage je Vorrang-Kategorie und je Suchwort`, async () => {
      rpcMode = mode;
      const context = await getKnowledgeContext("Größe", { embed: async () => ({ vector: [1], config: { provider: "openai" as const, model: "text-embedding-3-small" } }) });
      expect(context).toContain("- [reference] Rahmen: Die Größe des Rahmens ist 56 cm.");
      expect(context).toContain("- [project] Umzug");
      const tables = dbCalls().filter(c => c.path === "/rest/v1/knowledge");
      // knowledge_context, drei Vorrang-Kategorien, ein Suchwort
      expect(dbCalls()).toHaveLength(5);
      expect(tables).toHaveLength(4);
      for (const c of tables) {
        expect(c.params.get("status")).toBe("eq.active");
        expect(c.params.get("superseded_by")).toBe("is.null");
        expect(c.params.getAll("or").some(f => f.startsWith("(expires_at.is.null,expires_at.gt."))).toBe(true);
      }
      expect(tables.map(c => c.params.get("category")).filter(Boolean)).toEqual(PRIORITY_PARAMS);
      for (const c of tables.filter(c => c.params.get("category"))) expect(c.params.get("limit")).toBe("3");
      const text = tables.find(c => c.params.getAll("or").some(f => f.includes("ilike")))!;
      expect(text.params.getAll("or").find(f => f.includes("ilike"))).toBe("(title.ilike.%Größe%,content.ilike.%Größe%,tags.cs.{Größe})");
      expect(text.params.get("limit")).toBe("3");
    });

    test(`knowledge_context ${label}: 36 neuere Projekte verdrängen eine ältere Präferenz nicht`, async () => {
      rpcMode = mode;
      table = [
        ...Array.from({ length: 36 }, (_, i) => ({ id: `p${i}`, category: "project", title: `Projekt ${i}`, content: "läuft", updated_at: `2026-10-10T10:${String(i).padStart(2, "0")}:00Z` })),
        { id: "k-pref", category: "preference", title: "Ton", content: "Kurze Antworten.", updated_at: "2026-01-01T10:00:00Z" },
      ];
      const context = await getKnowledgeContext("ja wo bin ich");
      expect(context).toContain("- [preference] Ton: Kurze Antworten.");
      expect(context.split("\n").filter(l => l.startsWith("- [project]"))).toHaveLength(3);
      // ohne Suchwörter genau die drei Vorrang-Abfragen
      expect(dbCalls().filter(c => c.path === "/rest/v1/knowledge")).toHaveLength(3);
    });

    test(`knowledge_context ${label}: 36 Treffer für ein Wort verdrängen den älteren Treffer eines anderen nicht`, async () => {
      rpcMode = mode;
      table = [
        ...Array.from({ length: 36 }, (_, i) => ({ id: `g${i}`, category: "learning", title: `Garten ${i}`, content: "Beet", updated_at: `2026-10-10T10:${String(i).padStart(2, "0")}:00Z` })),
        { id: "k-keller", category: "reference", title: "Keller", content: "Feucht im Winter.", updated_at: "2026-01-01T10:00:00Z" },
      ];
      const context = await getKnowledgeContext("Garten Keller");
      expect(context).toContain("- [reference] Keller: Feucht im Winter.");
      expect(context.split("\n").filter(l => l.startsWith("- [learning] Garten"))).toHaveLength(3);
      // drei Vorrang-Abfragen und je Suchwort eine
      expect(dbCalls().filter(c => c.path === "/rest/v1/knowledge")).toHaveLength(5);
    });
  }

  test("Rückfall ohne Suchwörter: nur die Vorrang-Abfragen, keine unbegrenzte Textsuche", async () => {
    rpcMode = "missing";
    await getKnowledgeContext("ja wo bin ich");
    const tables = dbCalls().filter(c => c.path === "/rest/v1/knowledge");
    expect(tables.map(c => c.params.get("category"))).toEqual(PRIORITY_PARAMS);
    for (const c of tables) expect(c.params.getAll("or").some(f => f.includes("ilike"))).toBe(false);
  });

  test("ohne Nachricht: nur Vorrang, keine Suchwörter, kein Embedding", async () => {
    let embedded = 0;
    const context = await getKnowledgeContext(undefined, { embed: async () => (embedded++, null) });
    expect(context).toContain("[project] Umzug");
    expect(context).not.toContain("Rahmen");
    expect(embedded).toBe(0);
    expect(dbCalls()[0].body!.p_terms).toEqual([]);
  });

  test("keine Einträge: leerer Abschnitt", async () => {
    table = [];
    expect(await getKnowledgeContext("Größe")).toBe("");
  });

  test("ohne Supabase: leerer Kontext ohne Aufruf, Schreiben scheitert ehrlich", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    resetStore();
    expect(getStore().backend).toBe("file");
    expect(await getKnowledgeContext("Größe")).toBe("");
    expect(await addKnowledge({ category: "learning", title: "T", content: "I" })).toEqual({ ok: false, message: "⚠️ Supabase not configured" });
    expect(calls).toEqual([]);
  });
});

describe("addKnowledge", () => {
  test("Upsert über Kategorie und Titel, aktiv, danach Vektor über embed-knowledge", async () => {
    const result = await addKnowledge({ category: "learning", title: "Größe", content: "56 cm", tags: ["rad"], related_project: "Rad" });
    expect(result).toEqual({ ok: true, message: "📚 Saved: [learning] Größe" });
    const write = calls.find(c => c.method === "POST" && c.path === "/rest/v1/knowledge")!;
    expect(write.params.get("on_conflict")).toBe("category,title");
    expect(write.body).toMatchObject({ category: "learning", title: "Größe", content: "56 cm", status: "active", source: "telegram", tags: ["rad"], related_project: "Rad" });
    for (let i = 0; i < 50 && !calls.some(c => c.path === "/functions/v1/embed-knowledge"); i++) await Bun.sleep(5);
    expect(calls.find(c => c.path === "/functions/v1/embed-knowledge")!.body).toEqual({ knowledge_id: "k-new", text: "Größe: 56 cm" });
  });

  test("Datenbankfehler: ok false, kein Vektor", async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push({ method: "POST", path: new URL(String(input instanceof Request ? input.url : input)).pathname, params: new URLSearchParams(), body: null });
      return Response.json({ message: "synthetisch" }, { status: 503 });
    }) as typeof fetch;
    expect(await addKnowledge({ category: "reference", title: "x", content: "y" })).toEqual({ ok: false, message: "Knowledge storage failed" });
    await Bun.sleep(10);
    expect(calls.some(c => c.path.startsWith("/functions/"))).toBe(false);
  });
});

describe("getStore().knowledge: search und recent", () => {
  const store = (embed: () => Promise<{ vector: number[]; config: { provider: "openai"; model: string } } | null> = async () => null) =>
    supabaseKnowledge(getSupabase, { embed, embedEntry: async () => {}, now: () => Date.parse("2026-10-17T12:00:00Z") });

  test("ohne Suchwort: leer, ohne Abfrage", async () => {
    expect(await store().search("  ,;! ", 5)).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("Bedeutung mit Anbieter und Modell, Kategorie geht mit", async () => {
    semanticRows = [table[3]];
    const hits = await store(async () => ({ vector: [0.5], config: { provider: "openai", model: "text-embedding-3-small" } })).search("Kaffeedruck", 4, "learning");
    expect(hits.map(h => [h.id, h.match])).toEqual([["k-other", "semantic"]]);
    expect(dbCalls().map(c => c.path)).toEqual(["/rest/v1/rpc/match_knowledge_checked"]);
    expect(dbCalls()[0].body).toMatchObject({ p_provider: "openai", p_model: "text-embedding-3-small", match_count: 4, p_category: "learning" });
  });

  test("keine Treffer nach Bedeutung (Anbieterwechsel, fehlende Vektoren): Text", async () => {
    semanticRows = [];
    const hits = await store(async () => ({ vector: [0.5], config: { provider: "openai", model: "text-embedding-3-small" } })).search("Größe", 4);
    expect(hits.map(h => [h.id, h.match])).toEqual([["k-size", "text"]]);
    expect(dbCalls().map(c => c.path)).toEqual(["/rest/v1/rpc/match_knowledge_checked", "/rest/v1/knowledge"]);
  });

  test("recent: nur geltende Einträge, neueste zuerst, Kategorie als Filter", async () => {
    await store().recent(2, "project");
    const c = dbCalls()[0];
    expect(c.params.get("status")).toBe("eq.active");
    expect(c.params.get("superseded_by")).toBe("is.null");
    expect(c.params.get("category")).toBe("eq.project");
    expect(c.params.get("order")).toBe("updated_at.desc");
    expect(c.params.get("limit")).toBe("2");
    expect(c.params.getAll("or")).toEqual(["(expires_at.is.null,expires_at.gt.2026-10-17T12:00:00.000Z)"]);
  });
});

describe("Archiv und Projektfilter entfernt (E15)", () => {
  test("knowledge-base.ts bietet weder Archivieren noch Suche nach Projekt oder im Archiv", async () => {
    const exported = Object.keys(await import("../src/lib/knowledge-base")).sort();
    expect(exported).toEqual([
      "CONTEXT_MATCHES",
      "CONTEXT_MAX_ENTRIES",
      "CONTEXT_PER_CATEGORY",
      "CONTEXT_PER_TERM",
      "CONTEXT_TERMS",
      "KNOWLEDGE_CATEGORIES",
      "addKnowledge",
      "getKnowledgeContext",
      "isKnowledgeCategory",
      "knowledgeLine",
    ]);
    expect(Object.keys(getStore().knowledge).sort()).toEqual(["add", "context", "recent", "search"]);
  });

  test("Schreiben setzt immer aktiv, auch wenn status archived mitkommt (kein Archivieren mehr)", async () => {
    await addKnowledge({ category: "reference", title: "Alt", content: "neu", status: "archived" });
    const write = calls.find(c => c.method === "POST" && c.path === "/rest/v1/knowledge")!;
    expect(write.body!.status).toBe("active");
  });
});
