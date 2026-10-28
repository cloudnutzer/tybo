/**
 * Issue #314, umgestellt in Issue #372: die Verbindung zur Datenbank wird in
 * tybo pruefen nach ok bewertet, nicht nach dem Text. Die frühere zweite
 * Prüfung über getStore().logs.ping() gibt es nicht mehr (sie las messages
 * ein zweites Mal); messages wird genau einmal gelesen, auch zusammen mit
 * dem Schritt Datenbank. Kein Netz: Fetch-Attrappe.
 */
import { afterAll, expect, test } from "bun:test";
import { collectReport } from "../src/setup/checks/report";
import { databaseCheck } from "../src/setup/checks/specials";
import type { HttpFetch } from "../src/setup/context";
import { createProviders } from "../src/setup/providers";
import { databaseStep } from "../src/setup/steps/database";
import { cleanup, FAKE, fakeRun, makeCtx } from "./setup-fixture";

afterAll(cleanup);

const ENV = `WEB_ENABLED=true\nWEB_PASSWORD=${FAKE.webPassword}\nSUPABASE_URL=${FAKE.supabaseUrl}\nSUPABASE_SERVICE_ROLE_KEY=${FAKE.serviceKey}\n`;

async function run(respond: () => Response, env = ENV) {
  const requests: string[] = [];
  const fetch: HttpFetch = async (url, init) => {
    requests.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    return respond();
  };
  const ctx = await makeCtx({ env, overrides: { fetch } });
  const providers = createProviders({ fetch, run: fakeRun(), subprocessEnv: () => ({}) });
  const report = await collectReport({ ctx: { ...ctx, providers }, steps: [databaseStep], specials: [databaseCheck] });
  return { requests, line: report.lines.find(l => l.section === "Datenbank" && l.label === "Verbindung"), labels: report.lines.map(l => l.label) };
}

test("Supabase erreichbar: bestanden, messages einmal gelesen, keine Speicherprüfung dazu", async () => {
  const r = await run(() => Response.json([]));
  expect(r.line).toMatchObject({ status: "pass" });
  expect(r.requests.filter(x => x === "GET /rest/v1/messages")).toHaveLength(1);
  expect(r.requests.some(x => !x.startsWith("GET "))).toBe(false);
  expect(r.labels).not.toContain("Store connection");
});

test("Supabase antwortet mit Fehler: Fehler, auch wenn der Text „OK“ enthält", async () => {
  const r = await run(() => Response.json({ message: "OK" }, { status: 500 }));
  expect(r.line?.status).toBe("fail");
});

test("ohne Schlüssel: übersprungen, keine Anfrage", async () => {
  const r = await run(() => Response.json([]), `WEB_ENABLED=true\nWEB_PASSWORD=${FAKE.webPassword}\nSUPABASE_URL=${FAKE.supabaseUrl}\n`);
  expect(r.line?.status).toBe("skip");
  expect(r.requests).toEqual([]);
});
