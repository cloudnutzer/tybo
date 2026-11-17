/**
 * Issue #308: Store-Grundgerüst (src/lib/store/index.ts): Auswahl des
 * Backends, Singleton und Platzhalter, die laut scheitern. Seit #310 trägt
 * Supabase alle Nachrichten-Methoden, seit #311 alle Gedächtnis-Methoden,
 * seit #312 Aufträge, Lebenszeichen und Protokoll, seit #317 das Wissen und
 * seit #318 Bilder (BUILT); ihr Verhalten
 * prüfen tests/messages-contract.test.ts, tests/messages-read-contract.test.ts,
 * tests/memory-contract.test.ts, tests/tasks-contract.test.ts und
 * tests/logs-contract.test.ts, tests/knowledge-store.test.ts und
 * tests/asset-store.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getStore, resetStore, selectBackend, STORE_METHODS, StoreNotReadyError, type StorePart } from "../src/lib/store";
import { emitMessageSaved, onMessageSaved } from "../src/lib/store/events";
import { resetSupabaseClient } from "../src/lib/supabase";

const NAMES = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CONVEX_URL"] as const;

/** Setzt die drei Variablen für die Dauer von fn und stellt danach den alten Stand her */
function withEnv<T>(values: Partial<Record<(typeof NAMES)[number], string>>, fn: () => T): T {
  const saved = Object.fromEntries(NAMES.map(n => [n, process.env[n]]));
  try {
    for (const n of NAMES) {
      if (values[n] === undefined) delete process.env[n];
      else process.env[n] = values[n];
    }
    return fn();
  } finally {
    for (const n of NAMES) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
}

/** Methoden, die unter Supabase schon gebaut sind und deshalb nicht werfen */
const BUILT: Partial<Record<StorePart, string[]>> = {
  messages: [
    "save",
    "saveDisplayOnly",
    "recent",
    "boardRows",
    "lastUserMessageAt",
    "search",
    "searchWithFacts",
    "history",
    "topicActivity",
    "topicActivitySince",
    "displayOnlyPage",
    "displayOnlyHeads",
    "displayOnlyRows",
    "latestDisplayOnlyAt",
    "findDisplayOnlyFile",
  ],
  memory: [
    "searchFacts",
    "addFact",
    "facts",
    "deleteFact",
    "addGoal",
    "activeGoals",
    "completeGoal",
    "cancelGoal",
    "changedSince",
    "factVectors",
    "matchingFacts",
    "matchingGoals",
    "archivedFacts",
    "archiveFact",
    "restoreFact",
    "rewriteFact",
    "deleteFactById",
    "completeGoalById",
    "cancelGoalById",
  ],
  tasks: ["create", "update", "byId", "pending", "running", "stale", "heartbeat", "nodeStatus"],
  logs: ["write", "ping"],
  knowledge: ["add", "search", "recent", "context"],
  assets: ["upload", "setDescription", "byId", "recent", "search"],
};

/** Unter file gebaut: das Gedächtnis (Datei-Adapter, #316) */
const BUILT_FILE: Partial<Record<StorePart, string[]>> = { memory: BUILT.memory };

const SUPABASE = { SUPABASE_URL: "https://beispiel.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test-schluessel" };

afterEach(() => {
  resetStore();
});

describe("selectBackend", () => {
  test("beide Supabase-Variablen gesetzt: supabase", () => {
    expect(selectBackend(SUPABASE)).toBe("supabase");
  });

  test("nur eine der beiden: file", () => {
    expect(selectBackend({ SUPABASE_URL: SUPABASE.SUPABASE_URL })).toBe("file");
    expect(selectBackend({ SUPABASE_SERVICE_ROLE_KEY: SUPABASE.SUPABASE_SERVICE_ROLE_KEY })).toBe("file");
  });

  test("leere oder nur aus Leerraum bestehende Werte zählen nicht", () => {
    expect(selectBackend({ SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "x" })).toBe("file");
    expect(selectBackend({ SUPABASE_URL: "https://beispiel.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "" })).toBe("file");
    expect(selectBackend({ SUPABASE_URL: "  ", SUPABASE_SERVICE_ROLE_KEY: "  " })).toBe("file");
  });

  test("nur CONVEX_URL: file, CONVEX_URL wird nicht beachtet", () => {
    expect(selectBackend({ CONVEX_URL: "https://beispiel.convex.cloud" })).toBe("file");
    expect(selectBackend({ CONVEX_URL: "https://beispiel.convex.cloud", ...SUPABASE })).toBe("supabase");
  });

  test("ohne Argument gilt process.env", () => {
    withEnv(SUPABASE, () => expect(selectBackend()).toBe("supabase"));
    withEnv({}, () => expect(selectBackend()).toBe("file"));
  });
});

describe("getStore und resetStore", () => {
  test("zweiter Aufruf liefert dasselbe Objekt, auch nach Umgebungswechsel", () => {
    const first = withEnv(SUPABASE, () => getStore());
    expect(first.backend).toBe("supabase");
    const second = withEnv({}, () => getStore());
    expect(second).toBe(first);
    expect(second.backend).toBe("supabase");
  });

  test("nach resetStore gilt die neue Umgebung", () => {
    const first = withEnv({}, () => getStore());
    expect(first.backend).toBe("file");
    resetStore();
    const second = withEnv(SUPABASE, () => getStore());
    expect(second).not.toBe(first);
    expect(second.backend).toBe("supabase");
  });

  test("resetStore lässt die Zuhörer-Liste in events.ts unberührt", () => {
    let calls = 0;
    const off = onMessageSaved(() => {
      calls++;
    });
    try {
      getStore();
      resetStore();
      emitMessageSaved({ chatId: "1", role: "user", content: "x", metadata: {}, createdAt: "2026-10-16T15:00:00.000Z" });
      expect(calls).toBe(1);
    } finally {
      off();
    }
  });
});

describe("Platzhalter werfen StoreNotReadyError", () => {
  const parts = Object.keys(STORE_METHODS) as StorePart[];

  test("alle sechs Teile sind da", () => {
    expect([...parts].sort()).toEqual(["assets", "knowledge", "logs", "memory", "messages", "tasks"]);
  });

  for (const backend of ["supabase", "file"] as const) {
    for (const part of parts) {
      const built = backend === "supabase" ? (BUILT[part] ?? []) : (BUILT_FILE[part] ?? []);
      test(`${part} (${backend}): jede noch nicht gebaute Methode wirft mit Teil und Backend`, () => {
        const store = withEnv(backend === "supabase" ? SUPABASE : {}, () => getStore());
        expect(store.backend).toBe(backend);
        const methods = STORE_METHODS[part].filter(name => !built.includes(name as string));
        // Ganz gebaute Teile (messages seit #310, memory seit #311, tasks und logs seit #312 unter Supabase,
        // memory seit #316 auch unter file) haben keinen Platzhalter mehr; unter file werfen alle übrigen
        expect(methods.length).toBe(STORE_METHODS[part].length - built.length);
        for (const name of methods) {
          const fn = (store[part] as unknown as Record<string, (...args: unknown[]) => unknown>)[name as string];
          expect(typeof fn).toBe("function");
          let caught: unknown;
          try {
            fn("a", 1);
          } catch (err) {
            caught = err;
          }
          expect(caught).toBeInstanceOf(StoreNotReadyError);
          const err = caught as StoreNotReadyError;
          expect(err.part).toBe(part);
          expect(err.backend).toBe(backend);
          expect(err.message).toBe(`${part} (${backend}) noch nicht gebaut`);
        }
      });
    }
  }

  test("Meldung im Wortlaut des Issues", () => {
    const file = withEnv({}, () => {
      resetStore();
      return getStore();
    });
    expect(() => file.messages.save({ chat_id: "1", role: "user", content: "x" })).toThrow("messages (file) noch nicht gebaut");
  });
});

describe("Nachrichten unter Supabase (#309, #310)", () => {
  test("alle fünfzehn Methoden sind gebaut (lastUserMessageAt seit #364, searchWithFacts seit #523, drei schlanke Leser seit #684)", () => {
    expect([...BUILT.messages!].sort()).toEqual([...STORE_METHODS.messages].sort() as string[]);
  });

  test("die gebauten Methoden sind Funktionen und werfen keinen StoreNotReadyError", async () => {
    const store = withEnv(SUPABASE, () => getStore());
    resetSupabaseClient();
    const messages = store.messages as unknown as Record<string, unknown>;
    for (const name of BUILT.messages!) expect(typeof messages[name]).toBe("function");
    // Ohne erreichbaren Client (Umgebung schon zurückgesetzt) speichert nichts und liest leer
    expect(await store.messages.save({ chat_id: "1", role: "user", content: "x" })).toBe(false);
    expect(await store.messages.saveDisplayOnly({ chat_id: "1", role: "user", content: "x" })).toBe(false);
    expect(await store.messages.recent("1", 5, null)).toEqual([]);
    expect(await store.messages.boardRows(7)).toEqual([]);
    expect(await store.messages.search("1", "x", 5)).toEqual([]);
    expect(await store.messages.history("1", null, { limit: 5 })).toEqual([]);
    expect(await store.messages.topicActivity("1", 30)).toEqual([]);
    expect(await store.messages.topicActivitySince("1", "2026-11-16T10:00:00.000Z")).toEqual({ activity: [], truncated: false });
    // Die Meldungsleser und lastUserMessageAt werfen ohne Client absichtlich, aber nicht StoreNotReadyError
    for (const read of [
      () => store.messages.displayOnlyPage(["1"], { limit: 5 }),
      () => store.messages.displayOnlyHeads(["1"], { limit: 5 }),
      () => store.messages.displayOnlyRows(["1"], ["7"]),
      () => store.messages.latestDisplayOnlyAt(["1"]),
      () => store.messages.findDisplayOnlyFile("f", ["1"]),
      // #364: die letzte Nutzernachricht ebenso, „unbekannt" ist nie „keine"
      () => store.messages.lastUserMessageAt(),
    ]) {
      const error = await read().catch(e => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(StoreNotReadyError);
      expect(error.message).toBe("Supabase nicht eingerichtet");
    }
  });

  test("gebaute Liste deckt nur Methoden ab, die es gibt", () => {
    for (const [part, names] of Object.entries(BUILT)) {
      for (const name of names!) expect(STORE_METHODS[part as StorePart] as string[]).toContain(name);
    }
  });
});

describe("Fakten und Ziele unter Supabase (#311)", () => {
  test("alle Methoden von MemoryStore sind gebaut, auch factVectors", () => {
    expect([...BUILT.memory!].sort()).toEqual([...STORE_METHODS.memory].sort() as string[]);
    expect(STORE_METHODS.memory as string[]).toContain("factVectors");
  });

  test("die gebauten Methoden werfen keinen StoreNotReadyError und antworten ohne Client leer", async () => {
    const store = withEnv(SUPABASE, () => getStore());
    resetSupabaseClient();
    const memory = store.memory as unknown as Record<string, unknown>;
    for (const name of BUILT.memory!) expect(typeof memory[name]).toBe("function");
    expect(await store.memory.addFact("x")).toBe(false);
    expect(await store.memory.facts()).toEqual([]);
    expect(await store.memory.deleteFact("x")).toBe(false);
    expect(await store.memory.addGoal("x", new Date("2026-12-01T00:00:00.000Z"))).toBe(false);
    expect(await store.memory.activeGoals()).toEqual([]);
    expect(await store.memory.completeGoal("x")).toBe(false);
    expect(await store.memory.cancelGoal("x")).toBe(false);
    expect(await store.memory.changedSince(new Date(0))).toEqual([]);
    expect(await store.memory.factVectors({ vector: [1], config: { provider: "openai", model: "text-embedding-3-small" } })).toBeNull();
    expect(await store.memory.matchingFacts("x", 5)).toEqual([]);
    expect(await store.memory.matchingGoals("x", 5)).toEqual([]);
    expect(await store.memory.deleteFactById("1")).toBe(false);
    expect(await store.memory.completeGoalById("1")).toBe(false);
    expect(await store.memory.cancelGoalById("1")).toBe(false);
  });
});

describe("Wissen unter Supabase (#317)", () => {
  test("alle Methoden von KnowledgeStore sind gebaut", () => {
    expect([...BUILT.knowledge!].sort()).toEqual([...STORE_METHODS.knowledge].sort() as string[]);
  });

  test("ohne Client: Schreibfehler mit Grund, Lesen leer", async () => {
    const store = withEnv(SUPABASE, () => getStore());
    resetSupabaseClient();
    expect(await store.knowledge.add({ category: "learning", title: "x", content: "y" })).toEqual({ ok: false, message: "⚠️ Supabase not configured" });
    expect(await store.knowledge.search("Größe", 5)).toEqual([]);
    expect(await store.knowledge.recent(5)).toEqual([]);
    expect(await store.knowledge.context({ terms: ["Größe"], embedding: null, perCategory: 3, perTerm: 3, matches: 5 })).toEqual([]);
  });

  test("unter file bleibt das Wissen Platzhalter", () => {
    const store = withEnv({}, () => getStore());
    expect(() => store.knowledge.recent(1)).toThrow("knowledge (file) noch nicht gebaut");
  });
});

describe("Bilder unter Supabase (#318)", () => {
  test("alle Methoden von AssetStore sind gebaut", () => {
    expect([...BUILT.assets!].sort()).toEqual([...STORE_METHODS.assets].sort() as string[]);
  });

  test("ohne Client: nichts gespeichert, Lesen leer", async () => {
    const store = withEnv(SUPABASE, () => getStore());
    resetSupabaseClient();
    expect(await store.assets.upload({ data: new Uint8Array([1]), filename: "a.png", description: "x" })).toBeNull();
    await expect(store.assets.setDescription("1", "x")).resolves.toBeUndefined();
    expect(await store.assets.byId("1")).toBeNull();
    expect(await store.assets.recent(5)).toEqual([]);
    expect(await store.assets.search("Hund", 5)).toEqual([]);
  });

  test("unter file bleiben Bilder Platzhalter", () => {
    const store = withEnv({}, () => getStore());
    expect(() => store.assets.byId("1")).toThrow("assets (file) noch nicht gebaut");
  });
});

describe("Aufträge, Lebenszeichen und Protokoll unter Supabase (#312)", () => {
  test("alle Methoden von TaskStore und LogStore sind gebaut", () => {
    expect([...BUILT.tasks!].sort()).toEqual([...STORE_METHODS.tasks].sort() as string[]);
    expect([...BUILT.logs!].sort()).toEqual([...STORE_METHODS.logs].sort() as string[]);
  });

  test("die gebauten Methoden werfen keinen StoreNotReadyError und antworten ohne Client still", async () => {
    const store = withEnv(SUPABASE, () => getStore());
    resetSupabaseClient();
    expect(await store.tasks.create("1", "x")).toBeNull();
    expect(await store.tasks.update("t1", { status: "completed" })).toBe(false);
    expect(await store.tasks.byId("t1")).toBeNull();
    expect(await store.tasks.pending("1")).toEqual([]);
    expect(await store.tasks.running("1")).toEqual([]);
    expect(await store.tasks.stale(1000)).toEqual([]);
    expect(await store.tasks.heartbeat("mac")).toBe(false);
    expect(await store.tasks.nodeStatus("mac", 90_000)).toEqual({ online: false, lastHeartbeat: null });
    await expect(store.logs.write("info", "test", "x")).resolves.toBeUndefined();
    expect(await store.logs.ping()).toEqual({
      ok: false,
      message: "Supabase nicht eingerichtet (SUPABASE_URL oder SUPABASE_SERVICE_ROLE_KEY fehlt).",
    });
  });

  test("unter file bleiben tasks und logs Platzhalter (Datei-Adapter erst mit #316)", () => {
    const store = withEnv({}, () => getStore());
    expect(store.backend).toBe("file");
    expect(() => store.tasks.pending("1")).toThrow("tasks (file) noch nicht gebaut");
    expect(() => store.logs.ping()).toThrow("logs (file) noch nicht gebaut");
  });
});
