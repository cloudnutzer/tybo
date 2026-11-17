/**
 * Issue #324, umgestellt in Issue #372: die Datenbankprüfung von tybo
 * pruefen (databaseCheck in src/setup/checks/specials.ts) mit den echten
 * Anbietern gegen eine Netz-Attrappe. Ein HTTP-Fehler bei messages, auch mit
 * unlesbarem Antwortkörper, ist ein Fehler und bricht den Bericht nicht ab;
 * memory wird dann nicht mehr gelesen (keine Folgeprüfung auf einer
 * Datenbank, die schon scheitert). Ein Fehler bei memory ist eine Warnung.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { collectReport, reportExitCode } from "../src/setup/checks/report";
import { databaseCheck } from "../src/setup/checks/specials";
import type { HttpFetch } from "../src/setup/context";
import { createProviders } from "../src/setup/providers";
import { cleanup, FAKE, fakeRun, makeCtx } from "./setup-fixture";
import { fakeDb, fakeFetch } from "./schema-probe-fixture";

afterAll(cleanup);

const ANON = "sb_publishable_attrappe456geheim";
const ENV = `WEB_ENABLED=true\nWEB_PASSWORD=${FAKE.webPassword}\nSUPABASE_URL=${FAKE.supabaseUrl}\nSUPABASE_ANON_KEY=${ANON}\n`;

const SERVICE_ENV = `WEB_ENABLED=true\nWEB_PASSWORD=${FAKE.webPassword}\nSUPABASE_URL=${FAKE.supabaseUrl}\nSUPABASE_SERVICE_ROLE_KEY=${FAKE.serviceKey}\n`;

async function report(respond: (path: string, url: string) => Response | Promise<Response>, env = ENV) {
  const paths: string[] = [];
  const fetch: HttpFetch = async (url, init) => {
    const path = new URL(url).pathname;
    paths.push(path);
    return respond(path, url);
  };
  const ctx = await makeCtx({ env, overrides: { fetch } });
  const providers = createProviders({ fetch, run: fakeRun(), subprocessEnv: () => ({}) });
  const r = await collectReport({ ctx: { ...ctx, providers }, steps: [], specials: [databaseCheck] });
  return { paths, lines: r.lines.filter(l => l.section === "Datenbank").map(l => ({ label: l.label, status: l.status, detail: l.detail })), exit: reportExitCode(r) };
}

describe("Datenbank im Prüfbericht", () => {
  test("HTTP-Fehler für messages mit unlesbarem Körper: Fehler, memory wird nicht gelesen, Bericht entsteht", async () => {
    const r = await report(path =>
      path === "/rest/v1/messages"
        ? ({ ok: false, status: 500, text: () => Promise.reject(new Error("Verbindung beim Lesen abgerissen")), body: null } as unknown as Response)
        : Response.json([]),
    );
    // Danach nur die erste Frage der Schemaprobe (messages, limit=0): HTTP 500 heißt nicht prüfbar, keine weitere Anfrage, keine Zeile „Schema“
    expect(r.paths).toEqual(["/rest/v1/messages", "/rest/v1/messages"]);
    expect(r.lines).toEqual([{ label: "Verbindung", status: "fail", detail: "Supabase antwortet mit einem Fehler (HTTP 500)." }]);
    expect(r.exit).toBe(1);
  });

  test("messages lesbar, memory mit HTTP-Fehler: Warnung mit Status, Exit 0", async () => {
    const r = await report(path => (path === "/rest/v1/messages" ? Response.json([]) : new Response("", { status: 500 })));
    expect(r.paths.slice(0, 2)).toEqual(["/rest/v1/messages", "/rest/v1/memory"]);
    expect(r.lines.slice(0, 2)).toEqual([
      { label: "Verbindung", status: "pass", detail: "Supabase erreichbar, Tabelle messages lesbar." },
      { label: "Tabelle memory", status: "warn", detail: "nicht lesbar (HTTP 500)" },
    ]);
    // Schemaprobe (Issue #560): HTTP 500 heißt nicht prüfbar, nie „Migration fehlt“
    expect(r.lines[2]).toMatchObject({ label: "Schema", status: "warn" });
    expect(r.lines[2].detail).toContain("nicht prüfbar");
    expect(r.exit).toBe(0);
  });

  test("memory nicht erreichbar: Warnung nur mit Fehlerart", async () => {
    const r = await report(path => {
      if (path === "/rest/v1/memory") throw new TypeError(`fetch failed ${ANON}`);
      return Response.json([]);
    });
    expect(r.lines[1]).toEqual({ label: "Tabelle memory", status: "warn", detail: "nicht erreichbar (TypeError)" });
  });
  // Issue #560: Schemazeile auch, wenn schon messages scheitert; echte Anbieter-Logik (createProviders), Netz-Attrappe von PostgREST
  describe("Schemaprobe, wenn messages scheitert", () => {
    const viaDb = (db: ReturnType<typeof fakeDb>) => {
      const inner = fakeFetch(db);
      return (_path: string, url: string) => inner(url, { headers: {}, signal: new AbortController().signal });
    };

    test("fehlende Leserechte (20261021_base_grants.sql): Verbindung und Schema als Fehler, Datei und Befehl genannt, Exit 1", async () => {
      const r = await report(viaDb(fakeDb(["db/migrations/20261021_base_grants.sql"])), SERVICE_ENV);
      expect(r.lines[0].label).toBe("Verbindung");
      expect(r.lines[0].status).toBe("fail");
      expect(r.lines[0].detail).toContain("permission denied for table messages");
      expect(r.lines[1]).toEqual({ label: "Schema", status: "fail", detail: "Nachholen mit tybo setup datenbank. Es fehlt 1 Datei: 20261021_base_grants.sql" });
      expect(r.lines.slice(2).every(l => l.label === "Schema (weiter)" && l.status === "warn")).toBe(true);
      // memory liest nur die Schemaprobe (Struktur), die Prüfung „Tabelle memory“ entfällt wie bisher
      expect(r.lines.some(l => l.label === "Tabelle memory")).toBe(false);
      expect(r.exit).toBe(1);
    });

    test("fehlende Grundtabelle messages: Schema nennt db/schema.sql und den Befehl", async () => {
      const db = fakeDb();
      db.tables.delete("messages");
      const r = await report(viaDb(db), SERVICE_ENV);
      expect(r.lines[0]).toEqual({ label: "Verbindung", status: "fail", detail: "Die Tabelle messages fehlt. db/schema.sql im SQL-Editor von Supabase ausführen." });
      const schema = r.lines.find(l => l.label === "Schema");
      expect(schema?.status).toBe("fail");
      expect(schema?.detail).toStartWith("Nachholen mit tybo setup datenbank.");
      expect(schema?.detail).toContain("schema.sql");
      expect(r.exit).toBe(1);
    });

    test("Netzfehler: nur die Zeile Verbindung, keine Schemazeile, keine weitere Anfrage", async () => {
      const r = await report(() => {
        throw new TypeError("fetch failed");
      }, SERVICE_ENV);
      expect(r.lines).toHaveLength(1);
      expect(r.lines[0].label).toBe("Verbindung");
      expect(r.lines[0].detail).toContain("Supabase ist nicht erreichbar");
      expect(r.paths).toEqual(["/rest/v1/messages", "/rest/v1/messages"]);
    });

    test("abgelehnter Schlüssel (401 ohne Rechte-Code): nur die Zeile Verbindung", async () => {
      const r = await report(() => Response.json({ message: "Invalid API key" }, { status: 401 }), SERVICE_ENV);
      expect(r.lines).toEqual([{ label: "Verbindung", status: "fail", detail: expect.stringContaining("Supabase lehnt den Schlüssel ab") }]);
      expect(r.paths).toEqual(["/rest/v1/messages", "/rest/v1/messages"]);
    });
  });
});
