/**
 * Issue #168, Aufgabe 3: Übergang. Während der Neuberechnung entsteht für
 * niemanden ein Embedding (Textsuche), auch nicht für Prozesse mit noch
 * gepufferter Freigabe oder einer Anfrage, die vor dem Beginn losging; es
 * werden nie Vektoren verschiedener Anbieter verglichen. Am Ende schaltet die
 * Kennung um, der Funktionsnachweis läuft (mit Wiederholung), und eine reine
 * Anzeige-Meldung geht an Telegram und WebUI, auch im Fehlerfall; kein
 * automatischer Neustart. Dazu: die Migration enthält, was die Attrappe
 * nachbildet.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkProviderSetup,
  clearRegistryCache,
  embedForDatabase,
  REGISTRY_TTL_MS,
  UNREADABLE_TTL_MS,
  type EmbeddingConfig,
  type EnvReader,
} from "../supabase/functions/_shared/embedding";
import { REINDEX_TABLES, REINDEX_WRITE_DELAY_MS, runReindex } from "../src/lib/embedding-reindex";
import { finalMessage, NOTIFY_SOURCE, PROBE_ATTEMPTS, PROBE_PAUSE_MS, runSearchCommand, type ProbeOutcome } from "../src/setup/search-reindex";
import { SCHEMA_FILES } from "../src/setup/supabase-schema";
import { runTybo } from "../scripts/tybo";
import { FakeDb, fakeProvider, fakeVector, tagOf, type Clock } from "./reindex-fixture";

const URL_ = "https://projekt.supabase.co";
const SERVICE = "sb_secret_attrappe_uebergang";
const target = { url: URL_, key: SERVICE };
const OPENAI: EmbeddingConfig = { provider: "openai", model: "text-embedding-3-small" };
const GEMINI: EmbeddingConfig = { provider: "gemini", model: "gemini-embedding-2" };
const KEYS = { OPENAI_API_KEY: "sk-test-uebergang-geheim-4141", GEMINI_API_KEY: "AIza-test-uebergang-geheim-4242" };
const oldEnv: EnvReader = name => ({ ...KEYS })[name as keyof typeof KEYS];
const newEnv: EnvReader = name => ({ ...KEYS, EMBEDDING_PROVIDER: "gemini", EMBEDDING_MODEL: "gemini-embedding-2" })[name as keyof typeof KEYS];

// Auch vorher: eine andere Testdatei kann dieselbe Adresse zwischengespeichert haben
beforeEach(() => clearRegistryCache());
afterEach(() => clearRegistryCache());

function seeded(clock: Clock) {
  const db = new FakeDb({ settings: OPENAI, clock });
  for (let i = 1; i <= 6; i++) db.seed("messages", { id: i, content: `Nachricht ${i}`, metadata: {} }, fakeVector("openai", `Nachricht ${i}`));
  db.seed("memory", { id: 1, type: "fact", content: "Mia mag Tee" }, fakeVector("openai", "Mia mag Tee"));
  return db;
}

describe("Sperre während der Umstellung", () => {
  test("Status „umstellung“: weder alter noch neuer Anbieter bekommt einen Vektor, keine Anfrage beim Anbieter", async () => {
    const db = seeded({ t: 0 });
    db.startNow(GEMINI);
    const provider = fakeProvider(db, URL_);
    for (const env of [oldEnv, newEnv]) {
      const r = await embedForDatabase("Urlaub am Meer", env, provider.fetch, target);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toBe("gesperrt");
      expect(!r.ok && r.message).toContain("neu berechnet");
    }
    expect(provider.calls).toBe(0);
  });

  test("Anfrage, die vor dem Beginn losging (Datenbank noch leer), wird beim Festhalten verworfen", async () => {
    const clock = { t: 0 };
    const db = new FakeDb({ settings: null, clock });
    const provider = fakeProvider(db, URL_);
    // Während die Anbieter-Anfrage läuft, beginnt die Umstellung
    provider.onCall = () => db.startNow(GEMINI);
    const r = await embedForDatabase("Hallo", oldEnv, provider.fetch, target);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("gesperrt");
    expect(db.settings).toBeNull();
  });

  test("Startprüfung und Gesamtprüfung melden die laufende Neuberechnung", async () => {
    const db = seeded({ t: 0 });
    db.startNow(GEMINI);
    const check = await checkProviderSetup(newEnv, target, fakeProvider(db, URL_).fetch);
    expect(check.ok).toBe(false);
    expect(check.reindex).toEqual(GEMINI);
    expect(check.message).toContain("Google Gemini (gemini-embedding-2) neu berechnet");
  });

  test("Sperre wird nur eine Minute gemerkt: nach dem Umschalten sucht der neue Anbieter bald wieder", async () => {
    const db = seeded({ t: 0 });
    db.startNow(GEMINI);
    const provider = fakeProvider(db, URL_);
    expect((await embedForDatabase("x", newEnv, provider.fetch, target, 0)).ok).toBe(false);
    db.run = null;
    db.settings = GEMINI;
    expect((await embedForDatabase("x", newEnv, provider.fetch, target, UNREADABLE_TTL_MS - 1)).ok).toBe(false);
    expect((await embedForDatabase("x", newEnv, provider.fetch, target, UNREADABLE_TTL_MS + 1)).ok).toBe(true);
  });

  test("Zeitleiste: Suchvektoren und Schreibvorgänge, die vor dem Beginn entstanden, über Beginn, Wartezeit und Abschluss hinaus verzögert: nie ein Vergleich verschiedener Anbieter", async () => {
    const clock: Clock = { t: 0 };
    const db = seeded(clock);
    const provider = fakeProvider(db, URL_);
    const violations: string[] = [];
    const semanticHits: string[] = [];
    /** Suche wie match_messages_checked bzw. das Ranking der Fakten (embedding_fact_vectors): mit Anbieter und Modell des Suchvektors */
    function search(config: EmbeddingConfig, query: number[], who: string) {
      for (const table of ["messages", "memory"] as const) {
        const hits = db.matchChecked(table, config, query);
        for (const h of hits) {
          const tag = tagOf(db.tables[table].get(h.id)!.embedding);
          if (tag !== config.provider || tag !== tagOf(query)) violations.push(`${who} bei ${clock.t} ms: ${tagOf(query)} gegen ${tag}`);
        }
        if (hits.length) semanticHits.push(`${who}@${clock.t}`);
      }
    }
    // Vor dem Beginn: der laufende Bot (alte Einstellung) hat eine Freigabe gepuffert,
    // einen Suchvektor gerechnet und einen Vektor für eine neue Nachricht, beide noch nicht verwendet
    const before = await embedForDatabase("Urlaub am Meer", oldEnv, provider.fetch, target, 1_000_000);
    expect(before.ok && before.config).toEqual(OPENAI);
    const staleQuery = before.ok ? before.vector : [];
    const staleWrite = fakeVector("openai", "Später geschrieben");
    search(OPENAI, staleQuery, "vor dem Beginn");
    expect(semanticHits).toEqual(["vor dem Beginn@0", "vor dem Beginn@0"]);
    semanticHits.length = 0;

    clock.t += 1000;
    db.startNow(GEMINI);
    // Unmittelbar nach dem Beginn: gepufferte Freigabe liefert noch einen Suchvektor, die Datenbank vergleicht ihn mit nichts
    const buffered = await embedForDatabase("Urlaub am Meer", oldEnv, provider.fetch, target, 1_000_000 + clock.t);
    expect(buffered.ok).toBe(true);
    search(OPENAI, buffered.ok ? buffered.vector : [], "gepuffert nach Beginn");
    search(OPENAI, staleQuery, "alter Suchvektor nach Beginn");
    // Verspäteter Schreiber mit altem Vektor direkt nach dem Beginn
    db.foreignWrite("messages", { id: 101, content: "Später geschrieben", metadata: {} }, staleWrite, "openai:text-embedding-3-small");
    expect(db.tables.messages.get("101")!.embedding).toBeNull();

    let afterWait = false;
    const outcome = await runReindex({
      store: db,
      config: GEMINI,
      env: newEnv,
      fetch: provider.fetch,
      holder: "rechner:1",
      batchSize: 2,
      sleep: async ms => {
        clock.t += ms;
        search(OPENAI, staleQuery, "alter Suchvektor in der Wartezeit");
      },
      report: p => {
        if (p.phase === "haupt" && !afterWait) {
          afterWait = true;
          // Nach den sechs Minuten: der alte Suchvektor und ein weiterer verspäteter Schreiber
          search(OPENAI, staleQuery, "alter Suchvektor nach der Wartezeit");
          db.foreignWrite("memory", { id: 102, type: "fact", content: "Später gemerkt" }, fakeVector("openai", "Später gemerkt"), "openai:text-embedding-3-small");
        }
        search(OPENAI, staleQuery, "alter Suchvektor im Lauf");
        search(GEMINI, fakeVector("gemini", "Urlaub am Meer"), "neue Functions im Lauf");
      },
    });
    expect(outcome.state).toBe("fertig");
    expect(afterWait).toBe(true);
    // Während des ganzen Laufs keine semantische Suche
    expect(semanticHits).toEqual([]);

    // Nach dem Abschluss: alter Suchvektor und ein weiterer verspäteter Schreiber mit altem Vektor
    clock.t += 10 * 60_000;
    search(OPENAI, staleQuery, "alter Suchvektor nach Abschluss");
    expect(semanticHits).toEqual([]);
    db.foreignWrite("messages", { id: 103, content: "Sehr spät geschrieben", metadata: {} }, fakeVector("openai", "Sehr spät geschrieben"), "openai:text-embedding-3-small");
    expect(db.tables.messages.get("103")!.embedding).toBeNull();
    // Ohne Angabe (ältere Function) zählt als das Verhalten vor der Anbieterwahl: ebenfalls verworfen
    db.foreignWrite("messages", { id: 104, content: "Alte Function", metadata: {} }, fakeVector("openai", "Alte Function"));
    expect(db.tables.messages.get("104")!.embedding).toBeNull();
    // Die neuen Functions suchen wieder, nur unter Gemini-Vektoren
    search(GEMINI, fakeVector("gemini", "Urlaub am Meer"), "neue Functions nach Abschluss");
    expect(semanticHits.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
    // Die im Lauf verspätet geschriebenen Zeilen wurden nachgezogen
    expect(tagOf(db.tables.messages.get("101")!.embedding)).toBe("gemini");
    expect(tagOf(db.tables.memory.get("102")!.embedding)).toBe("gemini");
    for (const table of REINDEX_TABLES) for (const row of db.tables[table].values()) if (row.embedding) expect(row.model).toBe("gemini:gemini-embedding-2");
  });

  test("Abschluss prüft die Angabe jedes Vektors: ein Vektor mit anderer Angabe (Schreiber, der vor dem Beginn losging) wird nachgezogen statt umgeschaltet", async () => {
    const clock: Clock = { t: 0 };
    const db = seeded(clock);
    db.startNow(GEMINI);
    let once = false;
    db.hooks.beforeFinish = () => {
      if (once) return;
      once = true;
      // Wie eine Transaktion, die den Trigger vor dem Beginn passiert hat und erst jetzt sichtbar wird
      db.tables.messages.set("7", { data: { id: 7, content: "Durchgerutscht", metadata: {} }, embedding: fakeVector("openai", "Durchgerutscht"), model: "openai:text-embedding-3-small" });
    };
    const provider = fakeProvider(db, URL_);
    const outcome = await runReindex({ store: db, config: GEMINI, env: newEnv, fetch: provider.fetch, holder: "h", sleep: async ms => void (clock.t += ms) });
    expect(outcome.state).toBe("fertig");
    expect(tagOf(db.tables.messages.get("7")!.embedding)).toBe("gemini");
    expect(provider.texts).toContain("Durchgerutscht");
  });
});

describe("Abschluss: Befehl tybo suche neu-berechnen", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  async function command(db: FakeDb, probes: ProbeOutcome[], extra: { signal?: AbortSignal; script?: ReturnType<typeof fakeProvider>["script"] } = {}) {
    dir = await mkdtemp(join(tmpdir(), "tybo-suche-"));
    const provider = fakeProvider(db, URL_);
    provider.script.push(...(extra.script ?? []));
    const out: string[] = [];
    const err: string[] = [];
    const notes: string[] = [];
    const sleeps: number[] = [];
    let probeCalls = 0;
    const code = await runSearchCommand(["neu-berechnen"], {
      root: dir,
      env: { SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: SERVICE, EMBEDDING_PROVIDER: "gemini", EMBEDDING_MODEL: "gemini-embedding-2", ...KEYS },
      out: l => out.push(l),
      err: l => err.push(l),
      fetch: provider.fetch,
      store: db,
      holder: "rechner:1",
      sleep: async ms => {
        sleeps.push(ms);
        db.clock.t += ms;
      },
      probe: async () => probes[Math.min(probeCalls++, probes.length - 1)],
      notify: async text => {
        notes.push(text);
        return true;
      },
      signal: extra.signal,
    });
    return { code, out, err, notes, sleeps, probeCalls: () => probeCalls, provider };
  }

  test("fertig: umgeschaltet, Nachweis bestanden, eine Meldung mit Hinweis auf den Neustart; kein Neustart ausgelöst", async () => {
    const db = seeded({ t: 0 });
    db.startNow(GEMINI);
    const r = await command(db, [{ state: "aktiv", text: "Die Probe wurde nach Bedeutung gefunden." }]);
    expect(r.code).toBe(0);
    expect(db.settings).toEqual(GEMINI);
    expect(db.run).toBeNull();
    for (const t of REINDEX_TABLES) for (const row of db.tables[t].values()) if (row.embedding) expect(tagOf(row.embedding)).toBe("gemini");
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toContain("Neuberechnung auf Google Gemini (gemini-embedding-2) fertig, 7 Einträge neu berechnet");
    expect(r.notes[0]).toContain("Funktionsnachweis: aktiv");
    expect(r.notes[0]).toContain("Neustart anfordern");
    expect(r.out.join("\n")).toContain("Umgeschaltet");
    expect(existsSync(join(dir, "data", "restart-requested"))).toBe(false);
    expect(JSON.stringify(r)).not.toContain(KEYS.GEMINI_API_KEY);
  });

  test("Functions merken die Sperre noch: Nachweis wird nach einer Pause wiederholt", async () => {
    const db = seeded({ t: 0 });
    db.startNow(GEMINI);
    const r = await command(db, [
      { state: "textsuche", text: "Die Probe wurde nur per Textsuche gefunden." },
      { state: "aktiv", text: "Die Probe wurde nach Bedeutung gefunden." },
    ]);
    expect(r.code).toBe(0);
    expect(r.probeCalls()).toBe(2);
    expect(r.sleeps).toContain(PROBE_PAUSE_MS);
    expect(PROBE_PAUSE_MS).toBeGreaterThan(UNREADABLE_TTL_MS);
    expect(r.notes[0]).toContain("Funktionsnachweis: aktiv");
  });

  test("Nachweis scheitert dreimal: Meldung sagt es, Kennung bleibt umgestellt", async () => {
    const db = seeded({ t: 0 });
    db.startNow(GEMINI);
    const r = await command(db, [{ state: "textsuche", text: "Nur Textsuche." }]);
    expect(r.code).toBe(1);
    expect(r.probeCalls()).toBe(PROBE_ATTEMPTS);
    expect(r.notes[0]).toContain("Funktionsnachweis nicht bestanden");
    expect(db.settings).toEqual(GEMINI);
  });

  test("Fehlerfall: Meldung „nicht fertig“ mit Grund und Fortsetzen, Kennung unverändert, kein Nachweis", async () => {
    const db = seeded({ t: 0 });
    db.startNow(GEMINI);
    const r = await command(db, [{ state: "aktiv", text: "" }], { script: [{ status: 401 }] });
    expect(r.code).toBe(1);
    expect(r.probeCalls()).toBe(0);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toContain("Neuberechnung nicht fertig");
    expect(r.notes[0]).toContain("lehnt den Schlüssel ab");
    expect(r.notes[0]).toContain("tybo suche neu-berechnen");
    expect(r.notes[0]).not.toContain(KEYS.GEMINI_API_KEY);
    expect(db.settings).toEqual(OPENAI);
    expect(db.run).not.toBeNull();
  });

  test("Abbruch (Strg+C): Meldung, Exit 130, Stand bleibt zum Fortsetzen", async () => {
    const db = seeded({ t: 0 });
    db.startNow(GEMINI);
    const controller = new AbortController();
    controller.abort();
    const r = await command(db, [{ state: "aktiv", text: "" }], { signal: controller.signal });
    expect(r.code).toBe(130);
    expect(r.notes[0]).toContain("Abgebrochen");
    expect(db.settings).toEqual(OPENAI);
  });

  test("Meldung geht als reine Anzeige über sendAndRecord (Absender suche)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "setup", "search-reindex.ts"), "utf8");
    expect(src).toContain('sendAndRecord({ source: NOTIFY_SOURCE, text, format: "plain" }');
    expect(NOTIFY_SOURCE).toBe("suche");
    // Kein automatischer Neustart
    expect(src).not.toContain("restart-requested");
    expect(src).not.toContain("restart:request");
    expect(finalMessage({ state: "fertig", target: GEMINI, written: 3, withoutVector: 1 })).toContain("1 ohne Vektor");
  });

  test("status: zeigt Ziel, Fortschritt je Tabelle und Nachzuziehendes; ohne Umstellung den festgehaltenen Anbieter", async () => {
    const db = seeded({ t: 0 });
    const provider = fakeProvider(db, URL_);
    const env = { SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: SERVICE };
    const lines: string[] = [];
    await runSearchCommand(["status"], { root: "/", env, out: l => lines.push(l), err: l => lines.push(l), fetch: provider.fetch, store: db });
    expect(lines.join("\n")).toContain("Keine Neuberechnung. Die Datenbank hält OpenAI (text-embedding-3-small) fest.");
    db.startNow(GEMINI);
    db.progress.set("messages", { lastId: "4", done: 4, finished: false });
    db.foreignWrite("messages", { id: 50, content: "neu", metadata: {} }, null);
    lines.length = 0;
    await runSearchCommand(["status"], { root: "/", env, out: l => lines.push(l), err: l => lines.push(l), fetch: provider.fetch, store: db });
    const text = lines.join("\n");
    expect(text).toContain("Neuberechnung auf Google Gemini (gemini-embedding-2)");
    expect(text).toContain("Verlauf: 4");
    expect(text).toContain("Erinnerungen: noch nicht begonnen");
    expect(text).toContain("Nachzuziehen (während der Neuberechnung geändert): 1");
    expect(text).toContain("tybo suche neu-berechnen --hintergrund");
  });

  test("Aufruf: unbekannte Argumente, Convex und fehlende Supabase-Werte ergeben Exit 2 ohne Anfrage", async () => {
    const provider = fakeProvider();
    const quiet = { out: () => {}, err: () => {}, fetch: provider.fetch, root: "/" };
    expect(await runSearchCommand(["neu-berechnen", "--los"], { ...quiet, env: {} })).toBe(2);
    expect(await runSearchCommand(["neu-berechnen"], { ...quiet, env: { CONVEX_URL: "https://x.convex.cloud" } })).toBe(2);
    expect(await runSearchCommand(["neu-berechnen"], { ...quiet, env: {} })).toBe(2);
    expect(await runSearchCommand(["irgendwas"], { ...quiet, env: {} })).toBe(2);
    expect(provider.calls).toBe(0);
  });

  test("--hintergrund startet losgelöst mit Ausgabe in logs/embedding-reindex.log", async () => {
    const launches: Array<{ cmd: string[]; logFile: string }> = [];
    const lines: string[] = [];
    const code = await runSearchCommand(["neu-berechnen", "--hintergrund"], {
      root: "/projekt",
      env: {},
      out: l => lines.push(l),
      err: l => lines.push(l),
      startBackground: async (cmd, o) => {
        launches.push({ cmd, logFile: o.logFile });
        return true;
      },
    });
    expect(code).toBe(0);
    expect(launches[0].cmd.slice(-3)).toEqual(["/projekt/scripts/tybo.ts", "suche", "neu-berechnen"]);
    expect(launches[0].logFile).toBe("/projekt/logs/embedding-reindex.log");
  });
});

describe("Einstieg tybo suche", () => {
  test("tybo help nennt suche, tybo suche help die Unterbefehle; unbekannt: Exit 2", async () => {
    const out: string[] = [];
    expect(await runTybo({ args: ["help"], env: {}, root: "/nirgends", out: l => out.push(l), err: () => {} })).toBe(0);
    expect(out.join("\n")).toContain("tybo suche <neu-berechnen|status>");
    out.length = 0;
    expect(await runTybo({ args: ["suche", "help"], env: {}, root: "/nirgends", out: l => out.push(l), err: () => {} })).toBe(0);
    expect(out.join("\n")).toContain("tybo suche neu-berechnen --hintergrund");
    expect(await runTybo({ args: ["suche", "loeschen"], env: {}, root: "/nirgends", out: () => {}, err: () => {} })).toBe(2);
    // Ohne Supabase in der .env: Hinweis, keine Anfrage
    const err: string[] = [];
    expect(await runTybo({ args: ["suche", "neu-berechnen"], env: {}, root: "/nirgends", out: () => {}, err: l => err.push(l) })).toBe(2);
    expect(err.join("\n")).toContain("SUPABASE_URL");
  });
});

describe("Migration 20260928_embedding_reindex.sql", () => {
  // Verhalten des SQL: tests/embedding-reindex-pg.test.ts gegen echtes PostgreSQL mit pgvector
  test("in der Schema-Liste nach der Anbieterkennung", () => {
    const files = [...SCHEMA_FILES];
    expect(files.indexOf("db/migrations/20260928_embedding_reindex.sql")).toBe(files.indexOf("db/migrations/20260927_embedding_provider.sql") + 1);
  });
});
