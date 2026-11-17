// Issue #560: Schemaprobe gegen eine Attrappe der REST-Schnittstelle (PostgREST).
// Kein Test greift auf eine echte Datenbank zu.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isServerKey, probeSchema, schemaGapNotice, SCHEMA_MARKERS, SCHEMA_REPAIR_COMMAND, type SchemaFileName } from "../src/lib/schema-probe";
import { SCHEMA_FILES } from "../src/setup/supabase-schema";
import { fakeDb, fakeFetch } from "./schema-probe-fixture";

const ROOT = join(import.meta.dir, "..");
const URL = "https://beispiel.supabase.co";
const KEY = "sb_secret_attrappe";

describe("Merkmale je Datei", () => {
  test("jede Datei in SCHEMA_FILES hat mindestens ein Merkmal, und es gibt keine fremden", () => {
    expect(Object.keys(SCHEMA_MARKERS).sort()).toEqual([...SCHEMA_FILES].sort());
    for (const file of SCHEMA_FILES) expect(SCHEMA_MARKERS[file]?.length ?? 0).toBeGreaterThan(0);
  });

  test("jedes Merkmal steht in seiner Datei", () => {
    for (const file of SCHEMA_FILES) {
      const sql = readFileSync(join(ROOT, file), "utf8").toLowerCase();
      for (const m of SCHEMA_MARKERS[file]) {
        if (m.kind === "columns") for (const c of m.columns) expect(sql, `${file}: ${m.table}.${c}`).toContain(c);
        else if (m.kind === "function") expect(sql, `${file}: ${m.name}`).toMatch(new RegExp(`function public\\.${m.name}\\(`));
        else {
          expect(sql).toContain("grant all on table");
          for (const t of m.tables) expect(sql).toContain(`'${t}'`);
        }
      }
    }
  });

  test("Parameter der Einzelabfrage passen zur Funktion: nur echte Namen, alle Pflichtparameter dabei", () => {
    for (const file of SCHEMA_FILES) {
      const sql = readFileSync(join(ROOT, file), "utf8");
      for (const m of SCHEMA_MARKERS[file]) {
        if (m.kind !== "function") continue;
        const head = new RegExp(`FUNCTION public\\.${m.name}\\(([\\s\\S]*?)\\)\\s*RETURNS`, "i").exec(sql);
        expect(head, `${file}: ${m.name}`).not.toBeNull();
        const params = head![1]
          .replace(/\([^()]*\)/g, "")
          .split(",")
          .map(p => p.trim())
          .filter(Boolean)
          .map(p => ({ name: p.split(/\s+/)[0], required: !/\bdefault\b/i.test(p) }));
        const names = params.map(p => p.name);
        for (const arg of Object.keys(m.args)) expect(names, `${m.name}: ${arg}`).toContain(arg);
        for (const p of params.filter(p => p.required)) expect(Object.keys(m.args), `${m.name}: Pflichtparameter ${p.name}`).toContain(p.name);
      }
    }
  });

  test("message_chunks prüft eine Funktion, die db/schema.sql nicht anlegt", () => {
    const schema = readFileSync(join(ROOT, "db/schema.sql"), "utf8");
    const [marker] = SCHEMA_MARKERS["db/migrations/20261015_message_chunks.sql"];
    expect(marker.kind).toBe("function");
    if (marker.kind === "function") expect(schema).not.toContain(marker.name);
  });
});

describe("probeSchema", () => {
  test("vollständiges Schema: ok, nur lesende GET-Anfragen mit dem Schlüssel im Kopf", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    expect(await probeSchema({ url: URL, key: KEY, fetch: fakeFetch(fakeDb(), calls) })).toEqual({ state: "ok" });
    for (const c of calls) {
      expect(c.headers.apikey).toBe(KEY);
      expect(c.url.startsWith(`${URL}/rest/v1/`)).toBe(true);
      expect(c.url).not.toContain("/rpc/");
    }
    // Jede Anfrage höchstens einmal, das Verzeichnis der Funktionen genau einmal
    expect(new Set(calls.map(c => c.url)).size).toBe(calls.length);
    expect(calls.filter(c => c.url === `${URL}/rest/v1/`)).toHaveLength(1);
  });

  test("fehlt das Merkmal von 20261018_scheduled_tasks_lease.sql, fehlt genau diese Datei", async () => {
    const result = await probeSchema({ url: URL, key: KEY, fetch: fakeFetch(fakeDb(["db/migrations/20261018_scheduled_tasks_lease.sql"])) });
    expect(result).toEqual({ state: "missing", missing: ["db/migrations/20261018_scheduled_tasks_lease.sql"], unchecked: [] });
  });

  test("mehrere fehlende Dateien, auch Funktionen, in der Reihenfolge von SCHEMA_FILES", async () => {
    const gone: SchemaFileName[] = ["db/migrations/20261031_memory_facts_search.sql", "db/migrations/20261031_memory_archive.sql", "db/migrations/20261015_message_chunks.sql"];
    const result = await probeSchema({ url: URL, key: KEY, fetch: fakeFetch(fakeDb(gone)) });
    expect(result.state === "missing" && result.missing).toEqual(["db/migrations/20261015_message_chunks.sql", "db/migrations/20261031_memory_archive.sql", "db/migrations/20261031_memory_facts_search.sql"]);
  });

  test("Funktion vorhanden, aber ohne EXECUTE-Recht (fehlt im Verzeichnis): nicht prüfbar, keine fehlende Migration", async () => {
    const db = fakeDb();
    db.noExecute.add("match_facts_checked");
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const result = await probeSchema({ url: URL, key: KEY, fetch: fakeFetch(db, calls) });
    expect(result.state).toBe("unknown");
    if (result.state !== "unknown") return;
    expect(result.unchecked).toEqual([
      { file: "db/migrations/20261031_memory_facts_search.sql", reason: "Funktion match_facts_checked vorhanden, aber für diesen Schlüssel nicht ausführbar (fehlendes EXECUTE-Recht)" },
    ]);
    expect(schemaGapNotice(result)).toBeNull();
    // Einzelabfrage nur für diese Funktion, mit ihren Parameternamen und einem ungültigen Vektor
    const rpc = calls.filter(c => c.url.includes("/rpc/"));
    expect(rpc.map(c => c.url)).toEqual([`${URL}/rest/v1/rpc/match_facts_checked?p_provider=tybo-schemaprobe&p_model=tybo-schemaprobe&query_embedding=tybo-schemaprobe`]);
  });

  test("ohne EXECUTE-Recht, Postgres antwortet mit einem anderen Fehler: vorhanden, nicht prüfbar", async () => {
    const db = fakeDb();
    db.noExecute.add("knowledge_context");
    const inner = fakeFetch(db);
    const result = await probeSchema({
      url: URL,
      key: KEY,
      fetch: async (url, init) => (url.includes("/rpc/knowledge_context") ? Response.json({ code: "22P02", message: "invalid input syntax for type vector" }, { status: 400 }) : inner(url, init)),
    });
    expect(result.state).toBe("unknown");
    expect(result.state === "unknown" && result.unchecked.map(u => u.file)).toEqual(["db/migrations/20261017_knowledge_context.sql"]);
  });

  test("Funktion fehlt wirklich (PGRST202 auf die Einzelabfrage): die Datei fehlt", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const result = await probeSchema({ url: URL, key: KEY, fetch: fakeFetch(fakeDb(["db/migrations/20261017_knowledge_context.sql"]), calls) });
    expect(result).toEqual({ state: "missing", missing: ["db/migrations/20261017_knowledge_context.sql"], unchecked: [] });
    expect(calls.filter(c => c.url.includes("/rpc/")).map(c => c.url)).toEqual([`${URL}/rest/v1/rpc/knowledge_context?query_embedding=tybo-schemaprobe`]);
  });

  test("Einzelabfrage ohne Antwort: nicht prüfbar, nie „fehlt“", async () => {
    const db = fakeDb();
    db.noExecute.add("message_chunks_status");
    const inner = fakeFetch(db);
    const result = await probeSchema({
      url: URL,
      key: KEY,
      fetch: async (url, init) => {
        if (url.includes("/rpc/")) throw new TypeError("fetch failed");
        return inner(url, init);
      },
    });
    expect(result).toEqual({ state: "unknown", reason: "Datenbank nicht erreichbar", unchecked: [{ file: "db/migrations/20261015_message_chunks.sql", reason: "Datenbank nicht erreichbar" }] });
  });

  test("fehlende Rechte mit Server-Schlüssel: es fehlt 20261021_base_grants.sql", async () => {
    const result = await probeSchema({ url: URL, key: KEY, fetch: fakeFetch(fakeDb(["db/migrations/20261021_base_grants.sql"])) });
    expect(result.state).toBe("missing");
    if (result.state !== "missing") return;
    expect(result.missing).toEqual(["db/migrations/20261021_base_grants.sql"]);
    // Ohne Leserecht auf messages sind dessen Spalten nicht prüfbar, nie „fehlt“
    expect(result.unchecked.map(u => u.file)).toContain("db/schema.sql");
  });

  test("fehlende Rechte mit öffentlichem Schlüssel: nicht prüfbar, keine fehlende Migration", async () => {
    const db = fakeDb();
    for (const t of db.tables.keys()) db.denied.add(t);
    const result = await probeSchema({ url: URL, key: "sb_publishable_attrappe", fetch: fakeFetch(db) });
    expect(result.state).toBe("unknown");
    expect(result.state === "unknown" && result.reason).toContain("Rechte");
  });

  test("Datenbank nicht erreichbar: „nicht prüfbar“, keine fehlende Migration, keine weitere Anfrage", async () => {
    let calls = 0;
    const result = await probeSchema({
      url: URL,
      key: KEY,
      fetch: async () => {
        calls++;
        throw new TypeError("fetch failed");
      },
    });
    expect(result).toEqual({ state: "unknown", reason: "Datenbank nicht erreichbar", unchecked: [] });
    expect(schemaGapNotice(result)).toBeNull();
    expect(calls).toBe(1);
  });

  test("Zeitüberschreitung bricht die Anfrage ab und heißt „nicht prüfbar“", async () => {
    const result = await probeSchema({
      url: URL,
      key: KEY,
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason));
        }),
    });
    expect(result).toEqual({ state: "unknown", reason: "Zeitüberschreitung", unchecked: [] });
  });

  test("Abbruch von außen beendet die Probe", async () => {
    const controller = new AbortController();
    const pending = probeSchema({
      url: URL,
      key: KEY,
      signal: controller.signal,
      fetch: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))),
    });
    controller.abort();
    expect((await pending).state).toBe("unknown");
  });

  test("abgelehnter Schlüssel (401 ohne Code) und Serverfehler: nicht prüfbar", async () => {
    for (const status of [401, 500, 404]) {
      const result = await probeSchema({ url: URL, key: KEY, fetch: async () => new Response("nein", { status }) });
      expect(result.state).toBe("unknown");
    }
  });

  test("Verzeichnis der Funktionen unlesbar: Funktionsmerkmale nicht prüfbar, Spalten trotzdem geprüft", async () => {
    const inner = fakeFetch(fakeDb(["db/migrations/20261018_scheduled_tasks_lease.sql"]));
    const result = await probeSchema({ url: URL, key: KEY, fetch: async (url, init) => (url.endsWith("/rest/v1/") ? new Response("", { status: 404 }) : inner(url, init)) });
    expect(result.state).toBe("missing");
    if (result.state !== "missing") return;
    expect(result.missing).toEqual(["db/migrations/20261018_scheduled_tasks_lease.sql"]);
    expect(result.unchecked.map(u => u.file).sort()).toEqual(["db/migrations/20261015_message_chunks.sql", "db/migrations/20261017_knowledge_context.sql", "db/migrations/20261031_memory_facts_search.sql"]);
  });

  test("JWT-Schlüssel gehen in beide Köpfe (supabaseHeaders)", async () => {
    const jwt = `x.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.y`;
    const calls: { url: string; headers: Record<string, string> }[] = [];
    await probeSchema({ url: `${URL}/`, key: jwt, fetch: fakeFetch(fakeDb(), calls) });
    expect(calls[0].headers).toEqual({ apikey: jwt, Authorization: `Bearer ${jwt}` });
    expect(calls[0].url).toBe(`${URL}/rest/v1/messages?select=id&limit=0`);
  });
});

describe("isServerKey und Meldung", () => {
  test("Server-Schlüssel beider Arten", () => {
    const jwt = (role: string) => `x.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.y`;
    expect(isServerKey("sb_secret_abc")).toBe(true);
    expect(isServerKey("sb_publishable_abc")).toBe(false);
    expect(isServerKey(jwt("service_role"))).toBe(true);
    expect(isServerKey(jwt("anon"))).toBe(false);
  });

  test("Meldung nennt jede fehlende Datei und den Befehl; nichts bei ok oder unbekannt", () => {
    const text = schemaGapNotice({ state: "missing", missing: ["db/migrations/20261031_memory_archive.sql", "db/migrations/20261031_memory_facts_search.sql"], unchecked: [] });
    expect(text).toContain("2 Migrationen");
    expect(text).toContain("20261031_memory_archive.sql");
    expect(text).toContain("20261031_memory_facts_search.sql");
    expect(text).toContain(SCHEMA_REPAIR_COMMAND);
    expect(text).not.toContain("—");
    expect(schemaGapNotice({ state: "ok" })).toBeNull();
    expect(schemaGapNotice({ state: "unknown", reason: "x", unchecked: [] })).toBeNull();
  });
});
