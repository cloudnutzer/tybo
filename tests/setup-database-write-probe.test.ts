/**
 * Issue #305, Checkbox 2: Schreibprobe im Schritt datenbank. Der
 * Verbindungstest liest messages und legt danach eine Testzeile in memory an,
 * die er über ihre id wieder löscht. Die Statusanzeige schreibt nie, ein
 * Publishable-Schlüssel als Schreibschlüssel löst keine Anfrage aus.
 * Netz ist eine Attrappe hinter den echten Anbietern (createProviders).
 */

import { afterAll, describe, expect, test } from "bun:test";
import type { HttpFetch, HttpRequest } from "../src/setup/context";
import { LOCAL_SUPABASE_URL } from "../src/setup/local-supabase";
import { createProviders, GRANTS_MIGRATION, missingRightMessage, WRITE_PROBE_PREFIX } from "../src/setup/providers";
import { checkStep } from "../src/setup/steps";
import { databaseStep } from "../src/setup/steps/database";
import { supabaseHeaders } from "../src/lib/supabase-keys";
import { allText, cleanup, FAKE, fakeRun, makeCtx } from "./setup-fixture";

afterAll(cleanup);

// Erfundene Werte in der Form der echten Schlüssel
const SECRET = "sb_secret_schreibprobe789geheim";
const PUBLISHABLE = "sb_publishable_schreibprobe012geheim";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.schreibprobetest";
const CLOUD_URL = "https://abcdefghijklmnopqrst.supabase.co";
const ROW_ID = 4711;

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: any;
}

type Answer = (seen: Seen) => Response | Promise<Response>;

/**
 * Supabase-Attrappe: messages lesbar, memory nimmt eine Zeile an (id 4711)
 * und löscht sie. Einzelne Antworten lassen sich je Methode ersetzen.
 */
function fakeSupabase(base: string, answers: Partial<Record<"GET" | "POST" | "DELETE", Answer>> = {}) {
  const seen: Seen[] = [];
  const fetch: HttpFetch = async (url: string, request: HttpRequest = {}) => {
    if (!url.startsWith(`${base}/`)) throw new Error(`unerwarteter Aufruf: ${url}`);
    const u = new URL(url);
    const method = request.method ?? "GET";
    const entry: Seen = {
      method,
      path: `${u.pathname}${u.search}`,
      headers: request.headers ?? {},
      body: typeof request.body === "string" ? JSON.parse(request.body) : undefined,
    };
    seen.push(entry);
    const custom = answers[method as "GET" | "POST" | "DELETE"];
    if (custom) return custom(entry);
    if (method === "POST") return Response.json([{ id: ROW_ID, ...entry.body }], { status: 201 });
    if (method === "DELETE") return Response.json([{ id: ROW_ID }], { status: 200 });
    return Response.json([], { status: 200 });
  };
  return { fetch, seen, lines: () => seen.map(s => `${s.method} ${s.path}`) };
}

async function ctxWith(base: string, options: { env?: string; answers?: Parameters<typeof fakeSupabase>[1] } = {}) {
  const net = fakeSupabase(base, options.answers);
  const ctx = await makeCtx({
    env: options.env,
    overrides: { providers: createProviders({ fetch: net.fetch, run: fakeRun(), subprocessEnv: () => ({}) }) as any },
  });
  return { ctx, net };
}

const READ_WRITE_DELETE = [
  "GET /rest/v1/messages?select=id&limit=1",
  "POST /rest/v1/memory",
  `DELETE /rest/v1/memory?id=eq.${ROW_ID}`,
];

describe("Verbindungstest: Lesen, Insert, Cleanup", () => {
  for (const [name, key, bearer] of [
    ["sb_secret_", SECRET, false],
    ["Legacy-JWT", JWT, true],
  ] as const) {
    test(`${name}: Reihenfolge der Anfragen, Köpfe, keine Ausgabe nennt den Schlüssel`, async () => {
      const { ctx, net } = await ctxWith(FAKE.supabaseUrl);
      const result = await databaseStep.test!({ DB_BACKEND: "supabase", SUPABASE_URL: FAKE.supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: key }, ctx);
      expect(result.ok).toBe(true);
      expect(result.message).toBe(
        "Supabase erreichbar, Tabelle messages lesbar. Schreibprobe bestanden: Testzeile in memory angelegt und wieder gelöscht.",
      );
      expect(net.lines()).toEqual(READ_WRITE_DELETE);
      for (const { headers } of net.seen) {
        expect(headers.apikey).toBe(key);
        expect(headers.Authorization).toBe(bearer ? `Bearer ${key}` : undefined);
      }
      // Testzeile: gültiger Typ, erkennbarer Inhalt
      const insert = net.seen.find(s => s.method === "POST")!;
      expect(insert.body.type).toBe("fact");
      expect(insert.body.content).toStartWith(`${WRITE_PROBE_PREFIX} `);
      expect(insert.headers.Prefer).toBe("return=representation");
      expect(allText(result)).not.toContain(key);
    });
  }

  test("sb_publishable_ als SUPABASE_ANON_KEY: nur apikey, kein Bearer", () => {
    expect(supabaseHeaders(PUBLISHABLE)).toEqual({ apikey: PUBLISHABLE });
  });

  test("alle drei Supabase-Wege: Cloud, lokal und selbst eingetragen lesen und schreiben", async () => {
    for (const [base, env] of [
      [CLOUD_URL, `SUPABASE_URL=${CLOUD_URL}\nSUPABASE_SERVICE_ROLE_KEY=${SECRET}\n`],
      [LOCAL_SUPABASE_URL, `SUPABASE_URL=${LOCAL_SUPABASE_URL}\nSUPABASE_SERVICE_ROLE_KEY=${SECRET}\n`],
      [FAKE.supabaseUrl, `SUPABASE_URL=${FAKE.supabaseUrl}\nSUPABASE_SERVICE_ROLE_KEY=${SECRET}\n`],
    ]) {
      const { ctx, net } = await ctxWith(base, { env });
      const result = await databaseStep.test!({}, ctx);
      expect(result.ok).toBe(true);
      expect(net.lines()).toEqual(READ_WRITE_DELETE);
    }
  });

  test("Leseprobe schlägt fehl: keine Schreibprobe", async () => {
    const { ctx, net } = await ctxWith(FAKE.supabaseUrl, { answers: { GET: () => new Response("", { status: 401 }) } });
    const result = await databaseStep.test!({ DB_BACKEND: "supabase", SUPABASE_URL: FAKE.supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: SECRET }, ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("lehnt den Schlüssel ab");
    expect(net.lines()).toEqual(["GET /rest/v1/messages?select=id&limit=1"]);
  });
});

describe("Publishable-Schlüssel als Schreibschlüssel", () => {
  test("eingegeben: abgelehnt, keine Schreibprobe, keine Anfrage", async () => {
    const { ctx, net } = await ctxWith(FAKE.supabaseUrl);
    const result = await databaseStep.test!({ DB_BACKEND: "supabase", SUPABASE_URL: FAKE.supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: PUBLISHABLE }, ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Publishable");
    expect(result.message).not.toContain(PUBLISHABLE);
    expect(net.seen).toEqual([]);
  });

  test("gespeichert, in allen drei Wegen: abgelehnt, keine Anfrage", async () => {
    for (const base of [CLOUD_URL, LOCAL_SUPABASE_URL, FAKE.supabaseUrl]) {
      const { ctx, net } = await ctxWith(base, { env: `SUPABASE_URL=${base}\nSUPABASE_SERVICE_ROLE_KEY=${PUBLISHABLE}\n` });
      const result = await databaseStep.test!({}, ctx);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Publishable");
      expect(allText(result)).not.toContain(PUBLISHABLE);
      expect(net.seen).toEqual([]);
    }
  });
});

describe("Statusanzeige", () => {
  test("schreibt nicht, in keinem Weg", async () => {
    for (const base of [CLOUD_URL, LOCAL_SUPABASE_URL, FAKE.supabaseUrl]) {
      const { ctx, net } = await ctxWith(base, { env: `SUPABASE_URL=${base}\nSUPABASE_SERVICE_ROLE_KEY=${SECRET}\n` });
      expect((await databaseStep.status(ctx)).state).toBe("erledigt");
      expect(net.seen.filter(s => s.method !== "GET")).toEqual([]);
    }
  });
});

describe("Fehler der Schreibprobe", () => {
  const values = { DB_BACKEND: "supabase", SUPABASE_URL: FAKE.supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: SECRET };

  test("Löschen schlägt fehl (HTTP 500): Meldung sagt das, kein Erfolg", async () => {
    const { ctx } = await ctxWith(FAKE.supabaseUrl, { answers: { DELETE: () => new Response("", { status: 500 }) } });
    const result = await databaseStep.test!(values, ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Testzeile ließ sich nicht löschen (HTTP 500)");
    expect(result.message).toContain(WRITE_PROBE_PREFIX);
  });

  test("Löschen ohne bestätigte Zeile (etwa ohne Löschrecht): kein Erfolg", async () => {
    const { ctx } = await ctxWith(FAKE.supabaseUrl, { answers: { DELETE: () => Response.json([], { status: 200 }) } });
    const result = await databaseStep.test!(values, ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("ließ sich nicht löschen");
  });

  test("Löschen nicht erreichbar: Meldung ohne Schlüssel", async () => {
    const { ctx } = await ctxWith(FAKE.supabaseUrl, {
      answers: {
        DELETE: () => {
          throw new Error(`Verbindung abgebrochen, apikey=${SECRET}`);
        },
      },
    });
    const result = await databaseStep.test!(values, ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("beim Löschen der Testzeile");
    expect(result.message).not.toContain(SECRET);
  });

  test("Insert ohne gültige id: kein DELETE, kein Erfolg", async () => {
    for (const rows of [[], [{}], [{ id: "abc" }], [{ id: -1 }], [{ id: 1 }, { id: 2 }], { id: 1 }]) {
      const { ctx, net } = await ctxWith(FAKE.supabaseUrl, { answers: { POST: () => Response.json(rows, { status: 201 }) } });
      const result = await databaseStep.test!(values, ctx);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("keine id der Testzeile");
      expect(net.seen.some(s => s.method === "DELETE")).toBe(false);
    }
  });

  test("id als Zahl in Textform wird angenommen", async () => {
    const { ctx, net } = await ctxWith(FAKE.supabaseUrl, {
      answers: { POST: () => Response.json([{ id: "4711" }], { status: 201 }) },
    });
    expect((await databaseStep.test!(values, ctx)).ok).toBe(true);
    expect(net.lines().at(-1)).toBe(`DELETE /rest/v1/memory?id=eq.${ROW_ID}`);
  });

  test("Insert abgelehnt, Tabelle fehlt, anderer Fehler, nicht erreichbar: Klartext ohne Schlüssel und ohne Anbietertext", async () => {
    for (const [answer, expected] of [
      [() => new Response(`{"message":"denied ${SECRET}"}`, { status: 403 }), "nicht in memory schreiben"],
      [() => new Response("", { status: 404 }), "Die Tabelle memory fehlt"],
      [() => new Response(`{"message":"check constraint ${SECRET}"}`, { status: 400 }), "Schreibprobe in memory ist fehlgeschlagen (HTTP 400)"],
      [
        () => {
          throw new Error(`fetch failed ${SECRET}`);
        },
        "beim Schreiben nicht erreichbar",
      ],
    ] as const) {
      const { ctx, net } = await ctxWith(FAKE.supabaseUrl, { answers: { POST: answer } });
      const result = await databaseStep.test!(values, ctx);
      expect(result.ok).toBe(false);
      expect(result.message).toContain(expected);
      expect(result.message).not.toContain(SECRET);
      expect(result.message).not.toContain("constraint");
      expect(net.seen.some(s => s.method === "DELETE")).toBe(false);
    }
  });

  test("Gesamtprüfung zeigt die fehlgeschlagene Bereinigung", async () => {
    const { ctx } = await ctxWith(FAKE.supabaseUrl, {
      env: `SUPABASE_URL=${FAKE.supabaseUrl}\nSUPABASE_SERVICE_ROLE_KEY=${SECRET}\n`,
      answers: { DELETE: () => new Response("", { status: 500 }) },
    });
    const check = await checkStep.test!({}, ctx);
    const db = check.items!.find(i => i.label === "Datenbank")!;
    expect(db.ok).toBe(false);
    expect(db.detail).toContain("ließ sich nicht löschen");
  });
});

/** PostgREST-Antwort auf ein fehlendes Recht (Postgres-Fehlercode 42501) */
const denied = (object: string, status = 403) => () =>
  Response.json({ code: "42501", details: null, hint: null, message: `permission denied for ${object}` }, { status });

describe("Fehlendes Recht (Issue #437): permission denied verständlich, je Schritt", () => {
  const values = { DB_BACKEND: "supabase", SUPABASE_URL: FAKE.supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: SECRET };

  test("Lesen verweigert: Ursache und gezielte Reparatur, keine Schreibprobe", async () => {
    const { ctx, net } = await ctxWith(FAKE.supabaseUrl, { answers: { GET: denied("table messages") } });
    const result = await databaseStep.test!(values, ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("das Recht, aus der Tabelle messages zu lesen");
    expect(result.message).toContain("permission denied for table messages");
    expect(result.message).toContain(GRANTS_MIGRATION);
    expect(result.message).toContain("SQL-Editor");
    // Nicht der alte Hinweis auf den falschen Schlüssel allein, nicht schema.sql neu einspielen
    expect(result.message).not.toContain("lehnt den Schlüssel ab");
    expect(result.message).not.toContain("db/schema.sql");
    expect(net.lines()).toEqual(["GET /rest/v1/messages?select=id&limit=1"]);
  });

  test("Schreiben verweigert, auch nur wegen der Sequenz: genannt, kein Löschen", async () => {
    for (const object of ["table memory", "sequence memory_id_seq"]) {
      const { ctx, net } = await ctxWith(FAKE.supabaseUrl, { answers: { POST: denied(object) } });
      const result = await databaseStep.test!(values, ctx);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("das Recht, in die Tabelle memory zu schreiben");
      expect(result.message).toContain(`permission denied for ${object}`);
      expect(result.message).toContain(GRANTS_MIGRATION);
      expect(net.seen.some(s => s.method === "DELETE")).toBe(false);
    }
  });

  test("Löschen verweigert: eigene Testzeile bleibt, Hinweis zum Aufräumen, nur die eigene id angefragt", async () => {
    const { ctx, net } = await ctxWith(FAKE.supabaseUrl, { answers: { DELETE: denied("table memory") } });
    const result = await databaseStep.test!(values, ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Testzeile ließ sich nicht löschen");
    expect(result.message).toContain("das Recht, aus der Tabelle memory zu löschen");
    expect(result.message).toContain(GRANTS_MIGRATION);
    expect(result.message).toContain(WRITE_PROBE_PREFIX);
    expect(net.lines()).toEqual(READ_WRITE_DELETE);
  });

  test("auch mit HTTP 401; nur ein geprüfter Name aus der Antwort, nie der Rest", async () => {
    const { ctx } = await ctxWith(FAKE.supabaseUrl, {
      answers: { POST: () => Response.json({ code: "42501", message: `permission denied for sequence memory_id_seq; ${SECRET}` }, { status: 401 }) },
    });
    const result = await databaseStep.test!(values, ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("permission denied for sequence memory_id_seq)");
    expect(result.message).not.toContain(SECRET);
  });

  test("ohne Objektname in der Antwort: trotzdem die Rechte-Meldung", async () => {
    const { ctx } = await ctxWith(FAKE.supabaseUrl, { answers: { POST: () => Response.json({ code: "42501", message: "anders formuliert" }, { status: 403 }) } });
    const result = await databaseStep.test!(values, ctx);
    expect(result.message).toContain("(permission denied).");
    expect(result.message).not.toContain("anders formuliert");
  });

  test("403 ohne Fehlercode 42501 bleibt der Hinweis auf den Schlüssel", async () => {
    const { ctx } = await ctxWith(FAKE.supabaseUrl, { answers: { GET: () => Response.json({ message: "Invalid API key" }, { status: 401 }) } });
    const result = await databaseStep.test!(values, ctx);
    expect(result.message).toContain("lehnt den Schlüssel ab");
    expect(result.message).not.toContain(GRANTS_MIGRATION);
  });

  test("missingRightMessage: kein Gedankenstrich, nennt die Migration, die es gibt", async () => {
    expect(await Bun.file(`${import.meta.dir}/../${GRANTS_MIGRATION}`).exists()).toBe(true);
    const text = missingRightMessage("in die Tabelle memory zu schreiben", null);
    expect(text).not.toContain("—");
    expect(text).toContain(GRANTS_MIGRATION);
  });
});
