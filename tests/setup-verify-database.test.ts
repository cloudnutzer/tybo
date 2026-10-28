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

afterAll(cleanup);

const ANON = "sb_publishable_attrappe456geheim";
const ENV = `WEB_ENABLED=true\nWEB_PASSWORD=${FAKE.webPassword}\nSUPABASE_URL=${FAKE.supabaseUrl}\nSUPABASE_ANON_KEY=${ANON}\n`;

async function report(respond: (path: string) => Response) {
  const paths: string[] = [];
  const fetch: HttpFetch = async url => {
    const path = new URL(url).pathname;
    paths.push(path);
    return respond(path);
  };
  const ctx = await makeCtx({ env: ENV, overrides: { fetch } });
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
    expect(r.paths).toEqual(["/rest/v1/messages"]);
    expect(r.lines).toEqual([{ label: "Verbindung", status: "fail", detail: "Supabase antwortet mit einem Fehler (HTTP 500)." }]);
    expect(r.exit).toBe(1);
  });

  test("messages lesbar, memory mit HTTP-Fehler: Warnung mit Status, Exit 0", async () => {
    const r = await report(path => (path === "/rest/v1/messages" ? Response.json([]) : new Response("", { status: 500 })));
    expect(r.paths).toEqual(["/rest/v1/messages", "/rest/v1/memory"]);
    expect(r.lines).toEqual([
      { label: "Verbindung", status: "pass", detail: "Supabase erreichbar, Tabelle messages lesbar." },
      { label: "Tabelle memory", status: "warn", detail: "nicht lesbar (HTTP 500)" },
    ]);
    expect(r.exit).toBe(0);
  });

  test("memory nicht erreichbar: Warnung nur mit Fehlerart", async () => {
    const r = await report(path => {
      if (path === "/rest/v1/memory") throw new TypeError(`fetch failed ${ANON}`);
      return Response.json([]);
    });
    expect(r.lines[1]).toEqual({ label: "Tabelle memory", status: "warn", detail: "nicht erreichbar (TypeError)" });
  });
});
