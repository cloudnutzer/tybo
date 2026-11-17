/**
 * Issue #521: die Zeile „Neue Fakten 7 Tage“ im Nachtcheck gegen das echte
 * Schema (tests/pg-harness.ts). Die Prüfung läuft wie im Nachtcheck über
 * plannedChecks und runCheck; es wird nur diese eine gestartet, kein Bot und
 * kein Live-Nachtcheck. Alle Daten sind erfunden.
 *
 * Braucht TEST_PG_URL oder TEST_PG_BIN; ohne beide übersprungen, in der CI
 * ein Fehler (wie tests/schema-basis-pg.test.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { formatReport, plannedChecks, runCheck, type CheckResult, type MaintenanceCheckDeps } from "../src/health-check";
import { pgAvailable, respondViaPg, startPg, type PgServer } from "./pg-harness";
import { FAKE_SUPABASE_URL, useFakeSupabase } from "./supabase-fixture";

const available = pgAvailable();

if (!available.ok && process.env.CI) {
  test("PostgreSQL für den Nachtcheck ist in der CI eingerichtet", () => {
    throw new Error(`${available.reason}: der Dienst pgvector in .github/workflows/check.yml fehlt`);
  });
}

const NOW = Date.parse("2026-10-31T03:30:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ENV = { SUPABASE_URL: FAKE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: "test-service-key" };
const NAME = "Neue Fakten 7 Tage";

/** Nur diese eine Prüfung, wie sie der Nachtcheck plant und startet */
async function newFacts(env: Record<string, string> = ENV): Promise<CheckResult> {
  const check = plannedChecks({ withModel: false, env, now: NOW, state: { logs: {} }, nextState: { logs: {} }, maintenance: {} as MaintenanceCheckDeps }).find(c => c.name === NAME);
  expect(check).toBeDefined();
  const [result] = await runCheck(check!.name, check!.fn, check!.timeoutMs);
  return result;
}

describe("ohne Datenbank", () => {
  test("nicht anwendbar, nie als 0", async () => {
    const result = await newFacts({});
    expect(result).toEqual({ name: NAME, status: "na", detail: "ohne Datenbank" });
  });
});

describe.skipIf(!available.ok)("Neue Fakten gegen das echte Schema", () => {
  let pg: PgServer;
  let service: SQL;
  let fake: ReturnType<typeof useFakeSupabase>;

  beforeAll(async () => {
    pg = await startPg();
    await pg.applySchema();
    service = await pg.connect("service_role");
  }, 60_000);

  afterAll(async () => {
    await pg?.close();
  });

  beforeEach(async () => {
    await pg.admin.unsafe("TRUNCATE public.memory RESTART IDENTITY");
    fake = useFakeSupabase({ respond: respondViaPg(service, FAKE_SUPABASE_URL) });
  });

  afterEach(async () => {
    fake.restore();
    await pg.admin.unsafe("ALTER TABLE IF EXISTS public.memory_weg RENAME TO memory");
  });

  const seed = (type: string, at: number, archived = false) =>
    pg.admin.unsafe("INSERT INTO public.memory (type, content, created_at, archived_at) VALUES ($1, 'erfunden', $2::timestamptz, $3::timestamptz)", [type, new Date(at).toISOString(), archived ? new Date(NOW).toISOString() : null]);

  test("keine neuen Fakten: 0 und in Ordnung", async () => {
    expect(await newFacts()).toEqual({ name: NAME, status: "ok", detail: "0 neue Fakten" });
  });

  test("Zeitgrenze: genau 7 Tage zählen mit, eine Millisekunde älter nicht", async () => {
    await seed("fact", NOW - 7 * DAY);
    await seed("fact", NOW - 7 * DAY - 1);
    await seed("fact", NOW - 30 * DAY);
    expect((await newFacts()).detail).toBe("1 neuer Fakt");
  });

  test("nur Fakten: Vorlieben und Ziele zählen nicht, anders als die Embedding-Zeile", async () => {
    await seed("fact", NOW - DAY);
    await seed("fact", NOW - 2 * DAY);
    await seed("preference", NOW - DAY);
    await seed("goal", NOW - DAY);
    await seed("completed_goal", NOW - DAY);
    expect((await newFacts()).detail).toBe("2 neue Fakten");
  });

  test("archivierte zählen mit: gemessen wird der Zugang", async () => {
    await seed("fact", NOW - DAY);
    await seed("fact", NOW - DAY, true);
    expect((await newFacts()).detail).toBe("2 neue Fakten");
  });

  test("Abfragefehler: ❌ mit Grund, nie 0 neue Fakten", async () => {
    await seed("fact", NOW - DAY);
    await pg.admin.unsafe("ALTER TABLE public.memory RENAME TO memory_weg");
    const result = await newFacts();
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("REST HTTP");
    expect(result.detail).not.toContain("neue Fakten");
  });

  test("Antwort ohne Anzahl: ❌, nie 0 neue Fakten", async () => {
    fake.restore();
    fake = useFakeSupabase({ respond: () => new Response(null, { status: 200 }) });
    const result = await newFacts();
    expect(result.status).toBe("fail");
    expect(result.detail).not.toContain("neue Fakten");
  });

  test("steht im Bericht", async () => {
    await seed("fact", NOW - DAY);
    expect(formatReport([await newFacts()], new Date(NOW), "UTC")).toContain("Neue Fakten 7 Tage: 1 neuer Fakt");
  });
});
