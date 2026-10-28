/**
 * Issue #437, Wächter: Jede Tabelle, die db/schema.sql oder eine Datei in
 * db/migrations/ anlegt, bekommt in derselben Datei ein GRANT an
 * service_role, jede eigene Sequenz (bigserial, serial, smallserial oder
 * CREATE SEQUENCE) ebenso eins auf die Sequenz. Supabase vergibt diese Rechte
 * nicht mehr von selbst; eine neue Tabelle ohne Recht fällt so schon in
 * `bun run check` auf, nicht erst bei einem Nutzer mit frischem Projekt.
 *
 * Objektbezogen: ein beliebiges GRANT in der Datei reicht nicht. Erkannt
 * werden statische GRANTs (GRANT ... ON [TABLE|SEQUENCE] name, ... TO
 * service_role) und die dynamische Form in einer Schleife über eine feste
 * Liste (FOREACH x IN ARRAY ARRAY['a','b'] LOOP ... EXECUTE format('GRANT ...
 * ON [TABLE|SEQUENCE] public.%I TO service_role', x) ... END LOOP). Andere
 * Formen erkennt der Wächter nicht und meldet die Tabelle als ohne Recht;
 * dann eine der beiden Formen nehmen. Auskommentierte GRANTs (-- oder
 * /* ... *\/) zählen nicht. Tabellen erkennt er als CREATE [UNLOGGED] TABLE
 * name (...) und CREATE [UNLOGGED] TABLE name AS ...; jede andere
 * CREATE-TABLE-Form (auch TEMP) lässt den Test mit „nicht unterstützte
 * Syntax" scheitern.
 *
 * Dass die Rechte in der Datenbank wirklich ankommen, belegt
 * tests/schema-grants-pg.test.ts gegen echtes PostgreSQL.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SCHEMA_FILES } from "../src/setup/supabase-schema";

const REPO = resolve(import.meta.dir, "..");

interface Objects {
  tables: Set<string>;
  sequences: Set<string>;
}

/** Name ohne Schema public und ohne Anführungszeichen, klein */
function bare(name: string): string {
  return name.trim().replace(/"/g, "").replace(/^public\./i, "").toLowerCase();
}

/**
 * Entfernt Zeilenkommentare (--) und Blockkommentare (/* ... *\/, auch
 * verschachtelt wie in PostgreSQL); Zeichenketten in '...' bleiben unberührt
 */
function withoutComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'") {
      const end = /^'(?:[^']|'')*'?/.exec(sql.slice(i))![0].length;
      out += sql.slice(i, i + end);
      i += end;
    } else if (sql.startsWith("--", i)) {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (sql.startsWith("/*", i)) {
      let depth = 0;
      while (i < sql.length) {
        if (sql.startsWith("/*", i)) (depth++, (i += 2));
        else if (sql.startsWith("*/", i)) {
          i += 2;
          if (--depth === 0) break;
        } else i++;
      }
      out += " ";
    } else out += sql[i++];
  }
  return out;
}

/** Inhalt der Klammer, die bei open beginnt (open zeigt auf "(") */
function parenBody(sql: string, open: number): string {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")" && --depth === 0) return sql.slice(open + 1, i);
  }
  return sql.slice(open + 1);
}

/**
 * Tabellen und Sequenzen, die die Datei anlegt. Unterstützt sind CREATE
 * [UNLOGGED] TABLE name (...) und CREATE [UNLOGGED] TABLE name AS ...; jede
 * andere Form (PARTITION OF, OF typ, TEMP, ...) bricht mit Fehler ab, statt
 * die Tabelle zu übersehen.
 */
function createdObjects(sql: string): Objects {
  const text = withoutComments(sql);
  const tables = new Set<string>();
  const sequences = new Set<string>();
  const table =
    /\bcreate\s+(?:((?:(?:global|local)\s+)?temp(?:orary)?|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:"?public"?\.)?"?\w+"?)\s*(\(|as\b)?/gi;
  for (const m of text.matchAll(table)) {
    const name = bare(m[2]);
    const unsupported = !m[3] || (m[1] !== undefined && m[1].toLowerCase() !== "unlogged");
    if (unsupported) throw new Error(`nicht unterstützte Syntax: "${text.slice(m.index!, m.index! + m[0].length + 30).trim()}"`);
    tables.add(name);
    if (m[3] !== "(") continue;
    const body = parenBody(text, m.index! + m[0].length - 1);
    for (const col of body.matchAll(/(?:^|,)\s*"?(\w+)"?\s+(?:big|small)?serial\b/gi)) sequences.add(`${name}_${col[1].toLowerCase()}_seq`);
  }
  for (const m of text.matchAll(/\bcreate\s+sequence\s+(?:if\s+not\s+exists\s+)?((?:"?public"?\.)?"?\w+"?)/gi)) sequences.add(bare(m[1]));
  return { tables, sequences };
}

/** Objekte, die service_role in der Datei per GRANT bekommt */
function grantedToServiceRole(sql: string): Objects {
  const text = withoutComments(sql);
  const tables = new Set<string>();
  const sequences = new Set<string>();
  const add = (kind: string | undefined, name: string) => (kind?.toLowerCase() === "sequence" ? sequences : tables).add(bare(name));

  // Statisch; Zeichenketten zuerst entfernt, damit Text in format('...') nicht zählt
  const plain = text.replace(/'(?:[^']|'')*'/g, "''");
  for (const m of plain.matchAll(/\bgrant\s+[\w\s,]+?\s+on\s+([^;]*?)\s+to\s+([^;]*?)\s*;/gi)) {
    if (!/\bservice_role\b/i.test(m[2])) continue;
    const on = /^(?:(table|sequence)\s+)?(.+)$/is.exec(m[1].trim());
    if (!on || /^(function|functions|schema|all|routine|procedure|database|type|large)\b/i.test(on[2])) continue;
    for (const name of on[2].split(",")) if (/^\s*(?:"?public"?\.)?"?\w+"?\s*$/.test(name)) add(on[1], name);
  }

  // Dynamisch: Schleife über eine feste Liste, GRANT per EXECUTE format mit der Schleifenvariable
  const loop = /\bforeach\s+(\w+)\s+in\s+array\s+array\s*\[([^\]]*)\]\s+loop\b([\s\S]*?)\bend\s+loop\b/gi;
  for (const m of text.matchAll(loop)) {
    const variable = m[1].toLowerCase();
    const items = [...m[2].matchAll(/'(\w+)'/g)].map(i => i[1]);
    const grant = /\bexecute\s+format\s*\(\s*'(grant\s[^']*)'\s*,\s*(\w+)\s*\)/gi;
    for (const g of m[3].matchAll(grant)) {
      if (g[2].toLowerCase() !== variable) continue;
      const target = /\bon\s+(?:(table|sequence)\s+)?(?:public\.)?%I\s+to\s+([^']*)$/i.exec(g[1]);
      if (!target || !/\bservice_role\b/i.test(target[2])) continue;
      for (const item of items) add(target[1], item);
    }
  }
  return { tables, sequences };
}

/** Was in der Datei angelegt, aber nicht an service_role freigegeben wird */
function missingGrants(sql: string): string[] {
  const created = createdObjects(sql);
  const granted = grantedToServiceRole(sql);
  return [
    ...[...created.tables].filter(t => !granted.tables.has(t)).map(t => `Tabelle ${t}`),
    ...[...created.sequences].filter(s => !granted.sequences.has(s)).map(s => `Sequenz ${s}`),
  ];
}

async function read(file: string): Promise<string> {
  return readFile(join(REPO, file), "utf8");
}

/** Entfernt genau eine Zeile, die needle enthält; scheitert, wenn es sie nicht genau einmal gibt */
function dropLine(sql: string, needle: string): string {
  const lines = sql.split("\n");
  const hits = lines.filter(l => l.includes(needle));
  if (hits.length !== 1) throw new Error(`"${needle}" steht ${hits.length}-mal da`);
  return lines.filter(l => !l.includes(needle)).join("\n");
}

describe("Wächter: jede angelegte Tabelle und Sequenz hat ein GRANT an service_role", () => {
  for (const file of SCHEMA_FILES) {
    test(file, async () => {
      expect(missingGrants(await read(file))).toEqual([]);
    });
  }

  test("erkennt, was die Dateien anlegen (Grundtabellen, Sequenzen der bigserial-Spalten, CREATE SEQUENCE)", async () => {
    const base = createdObjects(await read("db/schema.sql"));
    expect([...base.tables].sort()).toEqual(["assets", "async_tasks", "call_transcripts", "logs", "memory", "message_chunks", "messages", "node_heartbeat"]);
    expect([...base.sequences].sort()).toEqual(["call_transcripts_id_seq", "logs_id_seq", "memory_id_seq", "message_chunks_id_seq", "messages_id_seq"]);
    const reindex = createdObjects(await read("db/migrations/20260928_embedding_reindex.sql"));
    expect([...reindex.tables].sort()).toEqual(["embedding_reindex", "embedding_reindex_progress", "embedding_reindex_queue"]);
    expect([...reindex.sequences]).toEqual(["embedding_reindex_seq"]);
    const chunks = createdObjects(await read("db/migrations/20261015_message_chunks.sql"));
    expect([...chunks.tables]).toEqual(["message_chunks"]);
    expect([...chunks.sequences]).toEqual(["message_chunks_id_seq"]);
  });
});

describe("Wächter schlägt an, wenn ein GRANT fehlt", () => {
  test("db/schema.sql ohne Tabellen-GRANT: alle sieben Grundtabellen", async () => {
    const sql = dropLine(await read("db/schema.sql"), "grant all on table public.%I to service_role");
    expect(missingGrants(sql)).toEqual(
      ["messages", "memory", "logs", "call_transcripts", "async_tasks", "node_heartbeat", "assets"].map(t => `Tabelle ${t}`),
    );
  });

  test("db/schema.sql ohne Sequenz-GRANT: die vier Sequenzen", async () => {
    const sql = dropLine(await read("db/schema.sql"), "grant usage, select on sequence public.%I to service_role");
    expect(missingGrants(sql)).toEqual(["messages_id_seq", "memory_id_seq", "logs_id_seq", "call_transcripts_id_seq"].map(s => `Sequenz ${s}`));
  });

  test("db/schema.sql: eine Sequenz fehlt in der Liste", async () => {
    const sql = (await read("db/schema.sql")).replace("'logs_id_seq', ", "");
    expect(missingGrants(sql)).toEqual(["Sequenz logs_id_seq"]);
  });

  test("Migration mit statischem GRANT: ohne es fehlt die Tabelle", async () => {
    const sql = dropLine(await read("db/migrations/20261017_scheduled_tasks.sql"), "GRANT ALL ON public.scheduled_tasks TO service_role");
    expect(missingGrants(sql)).toEqual(["Tabelle scheduled_tasks"]);
  });

  test("Migration mit dynamischem GRANT und eigener Sequenz: beides einzeln", async () => {
    const original = await read("db/migrations/20260928_embedding_reindex.sql");
    expect(missingGrants(dropLine(original, "EXECUTE format('GRANT ALL ON public.%I TO service_role', tab);"))).toEqual(
      ["embedding_reindex", "embedding_reindex_progress", "embedding_reindex_queue"].map(t => `Tabelle ${t}`),
    );
    expect(missingGrants(dropLine(original, "GRANT USAGE, SELECT ON SEQUENCE public.embedding_reindex_seq TO service_role"))).toEqual([
      "Sequenz embedding_reindex_seq",
    ]);
  });

  test("Migration mit GRANT in Schleife über eine Liste: Tabelle nicht in der Liste fällt auf", async () => {
    const sql = (await read("db/migrations/20260909_security_knowledge.sql")).replace("'knowledge',", "");
    expect(missingGrants(sql)).toEqual(["Tabelle knowledge"]);
  });

  test("Migration mit GRANT im Blockkommentar: die Tabelle fehlt", async () => {
    const grant = "GRANT ALL ON public.scheduled_tasks TO service_role;";
    const original = await read("db/migrations/20261017_scheduled_tasks.sql");
    expect(original).toContain(grant);
    expect(missingGrants(original.replace(grant, `/* ${grant} */`))).toEqual(["Tabelle scheduled_tasks"]);
    expect(missingGrants(original.replace(grant, `/* außen /* innen */ ${grant} */`))).toEqual(["Tabelle scheduled_tasks"]);
  });

  test("CREATE TABLE ... AS ohne GRANT fällt auf, andere Formen ohne Spaltenklammer brechen ab", () => {
    expect(missingGrants("CREATE TABLE public.a AS SELECT 1 AS id;")).toEqual(["Tabelle a"]);
    expect(missingGrants("CREATE TABLE public.a AS SELECT 1 AS id;\nGRANT ALL ON public.a TO service_role;")).toEqual([]);
    expect(() => missingGrants("CREATE TABLE public.c PARTITION OF public.p FOR VALUES IN (1);")).toThrow("nicht unterstützte Syntax");
    expect(() => missingGrants("CREATE TABLE public.d OF mein_typ;")).toThrow("nicht unterstützte Syntax");
  });

  test("CREATE UNLOGGED TABLE ohne GRANT: Tabelle und SERIAL-Sequenz fallen auf, TEMP bricht ab", () => {
    const sql = "CREATE UNLOGGED TABLE public.a (id bigserial PRIMARY KEY);";
    expect(missingGrants(sql)).toEqual(["Tabelle a", "Sequenz a_id_seq"]);
    expect(missingGrants("create unlogged table if not exists a as select 1 as id;")).toEqual(["Tabelle a"]);
    const granted = [sql, "GRANT ALL ON public.a TO service_role;", "GRANT USAGE, SELECT ON SEQUENCE public.a_id_seq TO service_role;"];
    expect(missingGrants(granted.join("\n"))).toEqual([]);
    expect(() => missingGrants("CREATE TEMP TABLE t (id int);")).toThrow("nicht unterstützte Syntax");
    expect(() => missingGrants("CREATE GLOBAL TEMPORARY TABLE t (id int);")).toThrow("nicht unterstützte Syntax");
  });

  test("objektbezogen: ein GRANT für eine andere Tabelle zählt nicht", () => {
    const sql = [
      "CREATE TABLE IF NOT EXISTS public.a (id uuid PRIMARY KEY);",
      "CREATE TABLE IF NOT EXISTS public.b (id bigserial PRIMARY KEY, n text);",
      "CREATE SEQUENCE IF NOT EXISTS public.zaehler;",
      "GRANT ALL ON public.a TO service_role;",
      "GRANT ALL ON public.b TO anon;",
      "GRANT USAGE ON SEQUENCE public.anderer TO service_role;",
      "-- GRANT ALL ON public.b TO service_role;",
      "DO $$ BEGIN RAISE NOTICE 'GRANT ALL ON public.b TO service_role;'; END $$;",
    ].join("\n");
    expect(missingGrants(sql)).toEqual(["Tabelle b", "Sequenz b_id_seq", "Sequenz zaehler"]);
  });

  test("Tabellenrecht deckt die Sequenz nicht ab, Rechte an anon zählen nicht", () => {
    const sql = [
      "create table if not exists notizen (id bigserial primary key, text text);",
      "grant all on table notizen to service_role;",
      "grant usage, select on sequence notizen_id_seq to anon, authenticated;",
    ].join("\n");
    expect(missingGrants(sql)).toEqual(["Sequenz notizen_id_seq"]);
    expect(missingGrants(`${sql}\ngrant usage, select on sequence public.notizen_id_seq to service_role;`)).toEqual([]);
  });

  test("dynamisch nur mit der Schleifenvariable und an service_role", () => {
    const loop = (grant: string) =>
      [
        "create table if not exists x (id uuid primary key);",
        "do $$ declare t text; other text := 'y'; begin",
        "  foreach t in array array['x'] loop",
        `    ${grant}`,
        "  end loop;",
        "end $$;",
      ].join("\n");
    expect(missingGrants(loop("execute format('grant all on public.%I to service_role', t);"))).toEqual([]);
    expect(missingGrants(loop("execute format('grant all on public.%I to service_role', other);"))).toEqual(["Tabelle x"]);
    expect(missingGrants(loop("execute format('grant all on public.%I to anon', t);"))).toEqual(["Tabelle x"]);
    expect(missingGrants(loop("execute format('revoke all on public.%I from anon', t);"))).toEqual(["Tabelle x"]);
  });
});
