/**
 * Issue #168, Aufgabe 2: Neuberechnung in Stapeln (src/lib/embedding-reindex.ts)
 * gegen die Attrappe der Datenbank (tests/reindex-fixture.ts, bildet das SQL
 * nach) und eine Anbieter-Attrappe. Geprüft: Texte wie bei den Schreibern,
 * Wartezeit vor dem ersten Vektor, Abbruch und Fortsetzen beim letzten
 * Stapel, Absturz zwischen Schreiben und Fortschritt, HTTP 429 mit
 * Wiederholung desselben Eintrags, nur ein Lauf gleichzeitig, fremde
 * Änderungen während des Laufs, Fehler ohne Umschalten.
 */

import { describe, expect, test } from "bun:test";
import {
  QUEUE_ROUNDS,
  RATE_LIMIT_FIRST_MS,
  REINDEX_LEASE_SECONDS,
  REINDEX_WRITE_DELAY_MS,
  ReindexStoreError,
  restReindexStore,
  runReindex,
  TABLE_SPECS,
  type ReindexOptions,
  type ReindexProgress,
} from "../src/lib/embedding-reindex";
import { retryAfterMs, type EmbeddingConfig } from "../supabase/functions/_shared/embedding";
import { FakeDb, fakeProvider, fakeVector, tagOf, VirtualClock, type Clock } from "./reindex-fixture";

const OPENAI: EmbeddingConfig = { provider: "openai", model: "text-embedding-3-small" };
const GEMINI: EmbeddingConfig = { provider: "gemini", model: "gemini-embedding-2" };
const ENV: Record<string, string> = {
  EMBEDDING_PROVIDER: "gemini",
  EMBEDDING_MODEL: "gemini-embedding-2",
  GEMINI_API_KEY: "AIza-test-reindex-geheim-3131",
  OPENAI_API_KEY: "sk-test-reindex-geheim-3232",
};

/** Datenbank mit OpenAI-Vektoren in allen vier Tabellen, Umstellung auf Gemini begonnen */
function world(setup: { messages?: number } = {}) {
  const clock: Clock = { t: 0 };
  const db = new FakeDb({ settings: OPENAI, clock });
  const n = setup.messages ?? 7;
  for (let i = 1; i <= n; i++) db.seed("messages", { id: i, content: `Nachricht ${i}`, metadata: {} }, fakeVector("openai", `Nachricht ${i}`));
  db.seed("messages", { id: n + 1, content: "Pipeline: Issue 45 gemergt", metadata: { display_only: true, source: "pipeline" } }, fakeVector("openai", "alt"));
  db.seed("messages", { id: n + 2, content: "", metadata: {} }, null);
  db.seed("memory", { id: 1, type: "fact", content: "Mia mag Tee. " + "x".repeat(9000) }, fakeVector("openai", "fakt"));
  db.seed("memory", { id: 2, type: "goal", content: "Marathon laufen" }, fakeVector("openai", "ziel"));
  db.seed("memory", { id: 3, type: "fact", content: "Alex wohnt in Hamburg" }, null);
  db.seed("knowledge", { id: "0a", title: "Router", content: "Passwort steht im Tresor" }, fakeVector("openai", "k"));
  db.seed("assets", { id: "a1", description: "Foto vom Strand", tags: ["urlaub", "meer"] }, null);
  db.seed("assets", { id: "a2", description: "", tags: [] }, fakeVector("openai", "leer"));
  db.startNow(GEMINI);
  const provider = fakeProvider();
  const sleeps: number[] = [];
  const progress: ReindexProgress[] = [];
  const options = (extra: Partial<ReindexOptions> = {}): ReindexOptions => ({
    store: db,
    config: GEMINI,
    env: name => ENV[name],
    fetch: provider.fetch,
    holder: "rechner:1",
    sleep: async ms => {
      sleeps.push(ms);
      clock.t += ms;
    },
    batchSize: 2,
    report: p => progress.push(p),
    ...extra,
  });
  return { db, clock, provider, sleeps, progress, options };
}

function expectAllGemini(db: FakeDb) {
  for (const [table, rows] of Object.entries(db.tables)) {
    for (const [id, row] of rows) {
      const text = TABLE_SPECS[table as keyof typeof TABLE_SPECS].text(row.data);
      if (text === null) expect({ table, id, tag: tagOf(row.embedding) }).toEqual({ table, id, tag: null });
      else {
        expect({ table, id, tag: tagOf(row.embedding) }).toEqual({ table, id, tag: "gemini" });
        expect(row.embedding).toEqual(fakeVector("gemini", text));
      }
    }
  }
}

describe("Durchlauf", () => {
  test("alle Tabellen in Stapeln, Texte wie die Schreiber, Anzeige-Meldungen und leere Texte ohne Vektor, danach umgeschaltet", async () => {
    const { db, provider, options } = world();
    const outcome = await runReindex(options());
    expect(outcome).toEqual({ state: "fertig", target: GEMINI, written: 11, withoutVector: 4 });
    expectAllGemini(db);
    expect(db.settings).toEqual(GEMINI);
    expect(db.run).toBeNull();
    // Texte: Fakten auf 8000 Zeichen, Ziele gar nicht, Wissen „Titel: Inhalt“, Bilder mit Tags
    expect(provider.texts).toContain(("Mia mag Tee. " + "x".repeat(9000)).substring(0, 8000));
    expect(provider.texts).not.toContain("Marathon laufen");
    expect(provider.texts).toContain("Router: Passwort steht im Tresor");
    expect(provider.texts).toContain("Foto vom Strand urlaub meer");
    expect(provider.texts).not.toContain("Pipeline: Issue 45 gemergt");
    // Nur Gemini angefragt, Schlüssel nirgends in Meldungen
    expect(JSON.stringify(outcome)).not.toContain(ENV.GEMINI_API_KEY);
  });

  test("kein neuer Vektor vor der Wartezeit (write_after): länger als der Zwischenspeicher der Freigaben", async () => {
    const { db, options, progress } = world();
    await runReindex(options());
    expect(REINDEX_WRITE_DELAY_MS).toBeGreaterThan(5 * 60_000);
    const withVectors = db.writes.filter(w => w.ids.length > 0);
    expect(withVectors.length).toBeGreaterThan(0);
    expect(Math.min(...withVectors.map(w => w.t))).toBeGreaterThanOrEqual(REINDEX_WRITE_DELAY_MS);
    expect(progress.some(p => p.phase === "warten")).toBe(true);
  });

  test("Fortschritt wird gemeldet: je Tabelle erledigt von gesamt", async () => {
    const { options, progress } = world();
    await runReindex(options());
    const messages = progress.filter(p => p.table === "messages" && p.phase === "haupt");
    // 7 Nachrichten mit Text; Stapel zu 2: 2, 4, 6, 8 (Anzeige-Meldung), 9 (leer) bestätigt
    expect(messages.map(p => p.done)).toEqual([0, 2, 4, 6, 8, 9]);
    expect(messages.every(p => p.total === 7)).toBe(true);
  });

  test("Einstellung passt nicht zum Ziel des Laufs: nichts gerechnet, Lauf freigegeben", async () => {
    const { db, provider, options } = world();
    const outcome = await runReindex(options({ config: OPENAI }));
    expect(outcome.state).toBe("konfiguration");
    expect(provider.calls).toBe(0);
    expect(db.run?.holder).toBeNull();
    expect(db.settings).toEqual(OPENAI);
  });

  test("ohne Umstellung: kein Lauf, nichts angefragt", async () => {
    const db = new FakeDb({ settings: OPENAI });
    const provider = fakeProvider();
    const outcome = await runReindex({ store: db, config: GEMINI, env: n => ENV[n], fetch: provider.fetch, holder: "x", sleep: async () => {} });
    expect(outcome.state).toBe("kein-lauf");
    expect(provider.calls).toBe(0);
  });
});

describe("Wiederaufnahme", () => {
  test("Abbruch mitten im Lauf, Neustart setzt beim letzten Stapel fort (nichts doppelt, nichts ausgelassen)", async () => {
    const { db, provider, options } = world();
    const controller = new AbortController();
    // Abbruch während der Anfrage für Nachricht 5: Stapel 1 und 2 (Nachricht 1 bis 4) sind bestätigt,
    // die fertig gerechnete Nachricht 5 wird vor dem Aufhören noch bestätigt (Teilstapel)
    provider.onCall = n => {
      if (n === 5) controller.abort();
    };
    const first = await runReindex(options({ signal: controller.signal }));
    expect(first.state).toBe("abgebrochen");
    expect(first.state !== "fertig" && first.message).toContain("tybo suche neu-berechnen");
    // Textsuche bleibt: Umstellung läuft weiter, Kennung unverändert, Lauf freigegeben
    expect(db.run).not.toBeNull();
    expect(db.run?.holder).toBeNull();
    expect(db.settings).toEqual(OPENAI);
    expect(db.progress.get("messages")?.lastId).toBe("5");
    expect(tagOf(db.tables.messages.get("6")!.embedding)).toBe("openai");
    const before = [...provider.texts];
    provider.onCall = undefined;
    const second = await runReindex(options({ holder: "rechner:2" }));
    expect(second.state).toBe("fertig");
    const again = provider.texts.slice(before.length);
    expect(again).not.toContain("Nachricht 1");
    expect(again).not.toContain("Nachricht 5");
    // Weiter mit dem ersten unbestätigten Eintrag
    expect(again[0]).toBe("Nachricht 6");
    expectAllGemini(db);
  });

  test("Absturz vor dem Bestätigen eines Stapels: derselbe Stapel wird wiederholt", async () => {
    const { db, provider, options } = world();
    let failed = false;
    db.hooks.beforeWrite = input => {
      if (!failed && input.table === "messages" && input.rows.some(r => r.id === "3")) {
        failed = true;
        throw new ReindexStoreError("Die Datenbank ist nicht erreichbar.");
      }
    };
    const first = await runReindex(options());
    expect(first.state).toBe("fehler");
    expect(db.progress.get("messages")?.lastId).toBe("2");
    expect(db.tables.messages.get("3")!.embedding && tagOf(db.tables.messages.get("3")!.embedding)).toBe("openai");
    const second = await runReindex(options());
    expect(second.state).toBe("fertig");
    // Stapel 3/4 zweimal gerechnet, bestätigt erst beim zweiten Mal
    expect(provider.texts.filter(t => t === "Nachricht 3")).toHaveLength(2);
    expectAllGemini(db);
  });

  test("Absturz nach dem Schreiben, bevor die Antwort ankommt: Fortschritt steht schon (atomar), es geht dahinter weiter", async () => {
    const { db, provider, options } = world();
    let lost = false;
    db.hooks.afterWrite = input => {
      if (!lost && input.table === "messages" && input.rows.some(r => r.id === "3")) {
        lost = true;
        throw new ReindexStoreError("Die Datenbank ist nicht erreichbar.");
      }
    };
    expect((await runReindex(options())).state).toBe("fehler");
    expect(db.progress.get("messages")?.lastId).toBe("4");
    expect((await runReindex(options())).state).toBe("fertig");
    expect(provider.texts.filter(t => t === "Nachricht 3")).toHaveLength(1);
    expectAllGemini(db);
  });

  test("nur ein Lauf gleichzeitig; nach Ablauf der Frist eines abgestürzten übernimmt der nächste", async () => {
    const { db, clock, options } = world();
    // Ein anderer Prozess hält den Lauf (etwa abgestürzt, Frist läuft noch)
    await db.lease("anderer:9", REINDEX_LEASE_SECONDS);
    const busy = await runReindex(options());
    expect(busy.state).toBe("belegt");
    expect(db.progress.size).toBe(0);
    clock.t += REINDEX_LEASE_SECONDS * 1000 + 1;
    expect((await runReindex(options())).state).toBe("fertig");
    expectAllGemini(db);
  });

  test("zweiter Prozess übernimmt mitten im Lauf: der erste hört auf, ohne weiterzuschreiben", async () => {
    const { db, clock, options } = world();
    db.hooks.afterBatch = (table, rows) => {
      if (table === "messages" && rows[0]?.id === 3) {
        // Frist des ersten abgelaufen, der zweite übernimmt
        clock.t += REINDEX_LEASE_SECONDS * 1000 + 1;
        void db.lease("zweiter:2", REINDEX_LEASE_SECONDS);
      }
    };
    const outcome = await runReindex(options());
    expect(outcome.state).toBe("belegt");
    expect(db.run?.holder).toBe("zweiter:2");
    expect(db.progress.get("messages")?.lastId).toBe("2");
  });
});

describe("Ratenlimit (HTTP 429)", () => {
  test("Retry-After abwarten und denselben Eintrag wiederholen, Frist dabei verlängern", async () => {
    const { db, provider, sleeps, options, progress } = world();
    // Erste Anfrage nach der Wartezeit: 429 mit Retry-After 7 s
    provider.script.push({ status: 429, retryAfter: "7" });
    const outcome = await runReindex(options());
    expect(outcome.state).toBe("fertig");
    expect(sleeps).toContain(7000);
    expect(provider.texts.filter(t => t === "Nachricht 1")).toHaveLength(1);
    expect(provider.calls).toBe(provider.texts.length + 1);
    expect(progress.some(p => p.phase === "pause" && p.waitMs === 7000)).toBe(true);
    expectAllGemini(db);
  });

  test("ohne Retry-After: 10 s, dann doppelt so lang", async () => {
    const { provider, sleeps, options } = world();
    provider.script.push({ status: 429 }, { status: 429 });
    expect((await runReindex(options())).state).toBe("fertig");
    const pauses = sleeps.filter(ms => ms < 60_000 || ms === 60_000);
    expect(pauses).toContain(RATE_LIMIT_FIRST_MS);
    expect(pauses).toContain(RATE_LIMIT_FIRST_MS * 2);
  });

  test("Retry-After als Sekunden oder HTTP-Datum, höchstens eine Stunde", () => {
    expect(retryAfterMs("7")).toBe(7000);
    expect(retryAfterMs("Wed, 21 Oct 2026 07:28:30 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))).toBe(30_000);
    expect(retryAfterMs("99999")).toBe(3_600_000);
    expect(retryAfterMs("bald")).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
  });

  test("Netzfehler: erneut versuchen; Schlüssel abgelehnt (401): Abbruch ohne Umschalten, Textsuche bleibt", async () => {
    const a = world();
    a.provider.script.push("netz", "netz");
    expect((await runReindex(a.options())).state).toBe("fertig");

    const b = world();
    b.provider.script.push({ status: 401 });
    const outcome = await runReindex(b.options());
    expect(outcome.state).toBe("fehler");
    expect(outcome.state !== "fertig" && outcome.message).toContain("lehnt den Schlüssel ab");
    expect(JSON.stringify(outcome)).not.toContain("sk-geheim");
    expect(b.db.settings).toEqual(OPENAI);
    expect(b.db.run).not.toBeNull();
  });

  for (const status of [400, 404]) {
    test(`nur ein relevanter Eintrag, vom Anbieter abgelehnt (HTTP ${status}): nicht fertig, kein Umschalten, bleibt offen; der nächste Lauf rechnet ihn`, async () => {
      const clock: Clock = { t: 0 };
      const db = new FakeDb({ settings: OPENAI, clock });
      db.seed("messages", { id: 1, content: "Der einzige Eintrag", metadata: {} }, fakeVector("openai", "Der einzige Eintrag"));
      // Absichtlich ohne Vektor: Anzeige-Meldung, leerer Text, Ziel
      db.seed("messages", { id: 2, content: "Pipeline fertig", metadata: { display_only: true } }, null);
      db.seed("messages", { id: 3, content: "", metadata: {} }, null);
      db.seed("memory", { id: 1, type: "goal", content: "Marathon laufen" }, null);
      db.startNow(GEMINI);
      const provider = fakeProvider();
      provider.script.push({ status });
      const options = (holder: string): ReindexOptions => ({
        store: db,
        config: GEMINI,
        env: name => ENV[name],
        fetch: provider.fetch,
        holder,
        sleep: async ms => {
          clock.t += ms;
        },
      });
      const first = await runReindex(options("rechner:1"));
      expect(first.state).toBe("fehler");
      expect(first.state !== "fertig" && first.message).toContain("abgelehnt");
      expect(first.state !== "fertig" && first.message).toContain("tybo suche neu-berechnen");
      // Nicht umgeschaltet, Textsuche bleibt, der Eintrag ist ohne Vektor, aber offen vorgemerkt
      expect(db.settings).toEqual(OPENAI);
      expect(db.run).not.toBeNull();
      expect(db.tables.messages.get("1")!.embedding).toBeNull();
      expect(db.queue.get("messages:1")).toMatchObject({ failed: true });
      // Die bewusst ausgenommenen Zeilen sind nicht vorgemerkt
      expect([...db.queue.keys()]).toEqual(["messages:1"]);
      // Wiederaufnahme: ein neuer Lauf versucht den abgelehnten Text erneut und schaltet dann um
      const second = await runReindex(options("rechner:2"));
      expect(second).toEqual({ state: "fertig", target: GEMINI, written: 1, withoutVector: 0 });
      expect(tagOf(db.tables.messages.get("1")!.embedding)).toBe("gemini");
      expect(db.settings).toEqual(GEMINI);
      expect(provider.texts.filter(t => t === "Der einzige Eintrag")).toHaveLength(1);
    });
  }

  test("abgelehnter Text mitten im Bestand: der Rest wird gerechnet, der abgelehnte bleibt offen; drei hintereinander brechen ab", async () => {
    const a = world();
    a.provider.script.push({ status: 400 });
    const one = await runReindex(a.options());
    expect(one.state).toBe("fehler");
    expect(a.db.tables.messages.get("1")!.embedding).toBeNull();
    expect(tagOf(a.db.tables.messages.get("2")!.embedding)).toBe("gemini");
    expect(a.db.queue.get("messages:1")?.failed).toBe(true);
    expect(a.db.settings).toEqual(OPENAI);
    expect((await runReindex(a.options({ holder: "rechner:2" }))).state).toBe("fertig");
    expectAllGemini(a.db);

    const b = world();
    b.provider.script.push({ status: 400 }, { status: 400 }, { status: 400 });
    expect((await runReindex(b.options())).state).toBe("fehler");
    expect(b.db.settings).toEqual(OPENAI);
  });
});

describe("Frist während der Berechnung (kontrollierte Uhr)", () => {
  /** Welt mit VirtualClock: langsame Anfragen beim Anbieter, Zeitgeber für das Verlängern */
  function slowWorld(delayMs: (n: number) => number, extra: { every?: boolean } = {}) {
    const clock = new VirtualClock();
    const db = new FakeDb({ settings: OPENAI, clock });
    for (let i = 1; i <= 5; i++) db.seed("messages", { id: i, content: `Nachricht ${i}`, metadata: {} }, fakeVector("openai", `Nachricht ${i}`));
    db.startNow(GEMINI);
    const provider = fakeProvider();
    provider.delay = n => clock.sleep(delayMs(n));
    const batches: Array<{ read: number; written?: number }> = [];
    db.hooks.afterBatch = (table, rows) => {
      if (table === "messages" && rows.length) batches.push({ read: clock.t });
    };
    db.hooks.afterWrite = input => {
      if (input.table === "messages" && input.rows.length && batches.length) batches[batches.length - 1].written ??= clock.t;
    };
    const options: ReindexOptions = {
      store: db,
      config: GEMINI,
      env: name => ENV[name],
      fetch: provider.fetch,
      holder: "rechner:1",
      sleep: clock.sleep,
      ...(extra.every === false ? { every: () => () => {} } : { every: clock.every }),
      batchSize: 5,
    };
    /** Ein anderer Prozess versucht zu diesen Zeiten (ab Beginn der Anfragen) zu übernehmen */
    const attempts: Array<{ t: number; state: string }> = [];
    function competitor(times: number[]) {
      void (async () => {
        await clock.sleep(REINDEX_WRITE_DELAY_MS);
        let last = 0;
        for (const at of times) {
          await clock.sleep(at - last);
          last = at;
          attempts.push({ t: clock.t, state: (await db.lease("fremd:9", REINDEX_LEASE_SECONDS)).state });
        }
      })();
    }
    return { clock, db, provider, batches, options, attempts, competitor };
  }

  test("Stapel über 120 s (5 Anfragen zu je 50 s): Frist wird mittendrin verlängert, Übernahmeversuche scheitern, der Lauf wird fertig", async () => {
    const w = slowWorld(() => 50_000);
    w.competitor([60_000, 130_000, 190_000, 245_000]);
    const outcome = await w.clock.run(runReindex(w.options));
    expect(outcome.state).toBe("fertig");
    // Der Stapel dauerte länger als die Frist
    const [batch] = w.batches;
    expect(batch.written! - batch.read).toBeGreaterThan(REINDEX_LEASE_SECONDS * 1000);
    expect(w.attempts.length).toBe(4);
    expect(w.attempts.every(a => a.state === "belegt")).toBe(true);
    expect(w.db.settings).toEqual(GEMINI);
    expectAllGemini(w.db);
  });

  test("eine einzelne Anfrage dauert 5 Minuten: Frist hält, Übernahme scheitert", async () => {
    const w = slowWorld(n => (n === 1 ? 300_000 : 1_000));
    w.competitor([150_000, 290_000]);
    const outcome = await w.clock.run(runReindex(w.options));
    expect(outcome.state).toBe("fertig");
    expect(w.attempts.map(a => a.state)).toEqual(["belegt", "belegt"]);
  });

  test("Gegenprobe ohne Verlängern im Takt: derselbe langsame Stapel verliert seine Frist, der andere übernimmt", async () => {
    const w = slowWorld(() => 50_000, { every: false });
    w.competitor([130_000]);
    const outcome = await w.clock.run(runReindex(w.options));
    expect(outcome.state).toBe("belegt");
    expect(w.attempts.map(a => a.state)).toEqual(["umstellung"]);
    expect(w.db.run?.holder).toBe("fremd:9");
    expect(w.db.settings).toEqual(OPENAI);
  });

  test("Verlängern im Takt meldet Übernahme: die laufende Anfrage wird abgebrochen, nichts mehr geschrieben", async () => {
    const w = slowWorld(() => 50_000);
    // Frist des Laufs von außen entzogen (etwa durch einen Admin): der nächste Schlag merkt es
    void (async () => {
      await w.clock.sleep(REINDEX_WRITE_DELAY_MS + 20_000);
      w.db.run!.leaseUntil = 0;
      await w.db.lease("fremd:9", REINDEX_LEASE_SECONDS);
    })();
    const outcome = await w.clock.run(runReindex(w.options));
    expect(outcome.state).toBe("belegt");
    expect(w.db.writes.filter(x => x.ids.length)).toEqual([]);
    expect(w.db.run?.holder).toBe("fremd:9");
  });
});

describe("Änderungen während des Laufs", () => {
  test("neue und geänderte Einträge mit alten Vektoren (gepufferte Freigabe) werden verworfen und nachgezogen", async () => {
    const { db, provider, options } = world();
    db.hooks.afterBatch = (table, rows) => {
      if (table === "messages" && rows[0]?.id === 5) {
        // Ein Prozess mit noch gültiger Freigabe für OpenAI schreibt eine neue Nachricht
        db.foreignWrite("messages", { id: 100, content: "Neu während der Umstellung", metadata: {} }, fakeVector("openai", "Neu während der Umstellung"));
        // und ändert eine schon umgerechnete Nachricht samt altem Vektor
        db.foreignWrite("messages", { id: 1, content: "Nachricht 1, geändert", metadata: {} }, fakeVector("openai", "Nachricht 1, geändert"));
        // Wissen wird geändert, ohne Vektor
        db.foreignWrite("knowledge", { id: "0a", title: "Router", content: "Passwort geändert" }, fakeVector("openai", "k"));
      }
    };
    const outcome = await runReindex(options());
    expect(outcome.state).toBe("fertig");
    expect(db.queue.size).toBe(0);
    expectAllGemini(db);
    expect(provider.texts).toContain("Nachricht 1, geändert");
    expect(provider.texts).toContain("Router: Passwort geändert");
  });

  test("Änderung kurz vor dem Umschalten: umgeschaltet wird erst nach dem Nachziehen", async () => {
    const { db, options } = world();
    let once = false;
    db.hooks.beforeFinish = () => {
      if (once) return;
      once = true;
      db.foreignWrite("memory", { id: 7, type: "fact", content: "Neuer Fakt" }, fakeVector("openai", "Neuer Fakt"));
    };
    const outcome = await runReindex(options());
    expect(outcome.state).toBe("fertig");
    expect(tagOf(db.tables.memory.get("7")!.embedding)).toBe("gemini");
    expectAllGemini(db);
  });

  test("kommt immer wieder Neues dazu: nach begrenzten Runden Abbruch, Kennung bleibt", async () => {
    const { db, options } = world({ messages: 1 });
    let n = 1000;
    db.hooks.beforeFinish = () => db.foreignWrite("messages", { id: ++n, content: `Flut ${n}`, metadata: {} }, null);
    const outcome = await runReindex(options());
    expect(outcome.state).toBe("fehler");
    expect(n - 1000).toBe(QUEUE_ROUNDS);
    expect(db.settings).toEqual(OPENAI);
  });
});

describe("Datenbank über REST", () => {
  test("Aufrufe an PostgREST mit Server-Schlüssel; fehlende Migration ergibt einen klaren Hinweis", async () => {
    const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
    const store = restReindexStore({ url: "https://projekt.supabase.co/", key: "sb_secret_attrappe" }, async (url, init = {}) => {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> });
      if (url.endsWith("/rpc/embedding_reindex_write")) return new Response(JSON.stringify({ ok: true, written: 1 }));
      if (url.endsWith("/rpc/embedding_reindex_start")) return new Response(JSON.stringify({ code: "PGRST202" }), { status: 404 });
      if (url.includes("/rest/v1/messages?")) return new Response(JSON.stringify([{ id: 5, content: "x", metadata: {} }]));
      return new Response("[]");
    });
    await store.write({ runId: "r", holder: "h", table: "messages", rows: [{ id: "5", embedding: [0.5, 0.25] }, { id: "6", embedding: null, seq: 3 }], lastId: "6", done: 2 });
    expect(calls[0].url).toBe("https://projekt.supabase.co/rest/v1/rpc/embedding_reindex_write");
    expect(calls[0].headers.apikey).toBe("sb_secret_attrappe");
    expect(calls[0].body).toEqual({
      p_run: "r",
      p_holder: "h",
      p_tab: "messages",
      p_rows: [
        { id: "5", embedding: "[0.5,0.25]" },
        { id: "6", embedding: null, seq: 3 },
      ],
      p_last_id: "6",
      p_done: 2,
      p_finished: false,
    });
    expect(await store.batch("messages", "4", 50)).toEqual([{ id: 5, content: "x", metadata: {} }]);
    expect(calls[1].url).toBe("https://projekt.supabase.co/rest/v1/messages?select=id,content,metadata&order=id.asc&limit=50&id=gt.4");
    await expect(store.start(GEMINI)).rejects.toThrow("20260928_embedding_reindex.sql");
  });
});
