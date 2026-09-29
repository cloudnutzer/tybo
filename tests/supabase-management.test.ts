/**
 * Issue #163: Port zur Management-API von Supabase und Schema-Liste.
 * Nur Attrappen (tests/supabase-api-fixture.ts), nichts geht ins Netz.
 */

import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createSupabaseManagement,
  isSupabaseCloudUrl,
  looksLikeProjectLimit,
  refFromUrl,
  SupabaseManagementError,
} from "../src/setup/supabase-management";
import {
  bucketSql,
  isValidBucketName,
  loadSchemaFiles,
  migrationName,
  recordedMigrationSql,
  SCHEMA_FILES,
  stripOuterTransaction,
} from "../src/setup/supabase-schema";
import { fakeSupabaseApi, SB } from "./supabase-api-fixture";

const ROOT = resolve(import.meta.dir, "..");
const noSleep = async () => {};

function mgmt(api = fakeSupabaseApi(), token = SB.token, sleep: (ms: number, signal?: AbortSignal) => Promise<void> = noSleep) {
  return { api, m: createSupabaseManagement(token, { fetch: api.fetch, sleep }) };
}

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof SupabaseManagementError ? e.kind : `anders: ${String(e)}`;
  }
}

describe("SCHEMA_FILES", () => {
  test("im Gleichlauf mit db/schema.sql und db/migrations/*.sql, schema.sql zuerst, Migrationen nach Namen", async () => {
    const migrations = (await readdir(join(ROOT, "db", "migrations"))).filter(f => f.endsWith(".sql")).sort();
    expect([...SCHEMA_FILES]).toEqual(["db/schema.sql", ...migrations.map(f => `db/migrations/${f}`)]);
  });

  test("Namen beim Anbieter: tybo_<dateiname>, eindeutig", () => {
    expect(SCHEMA_FILES.map(migrationName)).toEqual([
      "tybo_schema",
      "tybo_2026_07_02_fable_topics_memory",
      "tybo_20260909_security_knowledge",
      "tybo_20260927_embedding_provider",
      "tybo_20260928_embedding_reindex",
    ]);
  });

  test("äußere Transaktion wird entfernt, BEGIN in DO-Blöcken bleibt", async () => {
    const files = await loadSchemaFiles(ROOT);
    const security = files.find(f => f.file.endsWith("security_knowledge.sql"))!;
    const raw = await readFile(join(ROOT, security.file), "utf8");
    expect(raw).toMatch(/^BEGIN;$/m);
    expect(security.sql).not.toMatch(/^\s*BEGIN;\s*$/m);
    expect(security.sql).not.toMatch(/^\s*COMMIT;\s*$/m);
    expect(security.sql).toMatch(/^BEGIN$/m);
    expect(stripOuterTransaction("BEGIN;\nselect 1;\ncommit;\n")).toBe("select 1;");
    // Hash stabil (für Idempotency-Keys)
    const again = await loadSchemaFiles(ROOT);
    expect(again.map(f => f.hash)).toEqual(files.map(f => f.hash));
  });

  test("Verbuchung im Rückfall liegt in derselben Transaktion wie die Datei", () => {
    const sql = recordedMigrationSql("create table x();", "20260926100000", "tybo_schema");
    expect(sql.startsWith("begin;")).toBe(true);
    expect(sql.trim().endsWith("commit;")).toBe(true);
    expect(sql.indexOf("create table x()")).toBeLessThan(sql.indexOf("insert into supabase_migrations.schema_migrations"));
    expect(() => recordedMigrationSql("x", "1'; drop", "tybo_schema")).toThrow();
  });
});

describe("Bilder-Ordner", () => {
  test("Namensregel", () => {
    for (const ok of ["tybo-assets", "bilder-ablage", "abc", "a.b_c-1"]) expect(isValidBucketName(ok)).toBe(true);
    for (const bad of ["", "ab", "Tybo", "-abc", "a'b", "a b", "x".repeat(64)]) expect(isValidBucketName(bad)).toBe(false);
  });

  test("SQL legt privat an und ändert einen vorhandenen nicht; ungültiger Name wirft", () => {
    const sql = bucketSql("tybo-assets");
    expect(sql).toContain("values ('tybo-assets', 'tybo-assets', false)");
    expect(sql).toContain("on conflict (id) do nothing");
    expect(sql).not.toContain("do update");
    expect(() => bucketSql("x'); drop table y; --")).toThrow();
  });
});

describe("Adressen", () => {
  test("Ref und Cloud-Erkennung", () => {
    expect(refFromUrl(`https://${SB.ref}.supabase.co`)).toBe(SB.ref);
    expect(refFromUrl(`https://${SB.ref}.supabase.co/`)).toBe(SB.ref);
    expect(refFromUrl("https://abcdefgh.supabase.co")).toBeNull();
    expect(refFromUrl("https://db.example.org")).toBeNull();
    expect(refFromUrl(undefined)).toBeNull();
    expect(isSupabaseCloudUrl("https://abcdefgh.supabase.co")).toBe(true);
    expect(isSupabaseCloudUrl("https://supabase.example.org")).toBe(false);
    expect(isSupabaseCloudUrl("http://x.supabase.co")).toBe(false);
  });
});

describe("createSupabaseManagement", () => {
  test("Token nur im Kopf Authorization, nie in der Adresse", async () => {
    const { api, m } = mgmt();
    await m.organizations();
    expect(api.calls[0].headers.Authorization).toBe(`Bearer ${SB.token}`);
    expect(api.calls.every(c => !c.path.includes(SB.token))).toBe(true);
  });

  test("Projekt anlegen: organization_slug und region_selection, ohne region, plan, organization_id", async () => {
    const { api, m } = mgmt();
    const p = await m.createProject({ name: "tybo", organizationSlug: "org-alpha", region: "eu-central-1", dbPass: "x".repeat(32) });
    expect(p.ref).toBe(SB.ref);
    const body = api.calls.at(-1)!.body;
    expect(Object.keys(body).sort()).toEqual(["db_pass", "name", "organization_slug", "region_selection"]);
    expect(body.region_selection).toEqual({ type: "specific", code: "eu-central-1" });
  });

  test("401, 403, 404, 5xx und Netzfehler als feste Fehlerarten ohne Antworttext", async () => {
    expect(await kindOf(mgmt(undefined, SB.otherToken).m.organizations())).toBe("token");
    const api = fakeSupabaseApi();
    api.hooks.push(r => (r.path === "/v1/projects" ? new Response(`{"message":"geheime Antwort ${SB.token}"}`, { status: 403 }) : undefined));
    const e = await mgmt(api).m.projects().catch(x => x as SupabaseManagementError);
    expect((e as SupabaseManagementError).kind).toBe("verboten");
    expect((e as Error).message).not.toContain("geheime Antwort");
    expect((e as Error).message).not.toContain(SB.token);
    expect(await mgmt().m.project(SB.ref)).toBeNull();
    const down = fakeSupabaseApi();
    down.hooks.push(() => new Response("oops", { status: 503 }));
    expect(await kindOf(mgmt(down).m.organizations())).toBe("netz");
    const offline = createSupabaseManagement(SB.token, {
      fetch: async () => {
        throw new Error(`fetch failed with ${SB.token}`);
      },
      sleep: noSleep,
    });
    const err = await offline.organizations().catch(x => x as Error);
    expect((err as SupabaseManagementError).kind).toBe("netz");
    expect((err as Error).message).not.toContain(SB.token);
  });

  test("429: wartet X-RateLimit-Reset Sekunden (verbleibend), dann erneut; nach drei Versuchen Fehler", async () => {
    const api = fakeSupabaseApi();
    let limited = 2;
    api.hooks.push(() => (limited-- > 0 ? new Response("", { status: 429, headers: { "X-RateLimit-Reset": "7" } }) : undefined));
    const waits: number[] = [];
    const { m } = mgmt(api, SB.token, async ms => {
      waits.push(ms);
    });
    expect((await m.organizations()).map(o => o.slug)).toEqual(["org-alpha"]);
    expect(waits).toEqual([7000, 7000]);

    const always = fakeSupabaseApi();
    always.hooks.push(() => new Response("", { status: 429, headers: { "X-RateLimit-Reset": "7" } }));
    const waits2: number[] = [];
    const r = mgmt(always, SB.token, async ms => {
      waits2.push(ms);
    });
    expect(await kindOf(r.m.organizations())).toBe("rate");
    expect(waits2).toEqual([7000, 7000, 7000]);
    expect(always.calls).toHaveLength(4);
  });

  test("429 mit Reset=600: keine Wiederholung vor dem Reset, sofort verständlicher Abbruch mit Wartezeit", async () => {
    const api = fakeSupabaseApi();
    api.hooks.push(() => new Response("", { status: 429, headers: { "X-RateLimit-Reset": "600" } }));
    const waits: number[] = [];
    const { m } = mgmt(api, SB.token, async ms => void waits.push(ms));
    const e = (await m.organizations().catch(x => x)) as SupabaseManagementError;
    expect(e.kind).toBe("rate");
    expect(e.message).toContain("in etwa 10 Minuten");
    expect(waits).toEqual([]);
    expect(api.calls).toHaveLength(1);
  });

  test("429 ohne Kopf: eine Minute Pause je Versuch", async () => {
    const api = fakeSupabaseApi();
    api.hooks.push(() => new Response("", { status: 429 }));
    const waits: number[] = [];
    const { m } = mgmt(api, SB.token, async ms => void waits.push(ms));
    expect(await kindOf(m.organizations())).toBe("rate");
    expect(waits).toEqual([60_000, 60_000, 60_000]);
  });

  test("Frist: Zeitlimit höchstens Restzeit, nach Fristende keine Anfrage, 429 über die Frist hinaus ohne Warten", async () => {
    let left = 4_000;
    const api = fakeSupabaseApi();
    const waits: number[] = [];
    const m = createSupabaseManagement(SB.token, { fetch: api.fetch, sleep: async ms => void waits.push(ms), remainingMs: () => left });
    await m.organizations();
    expect(api.calls.at(-1)!.timeoutMs).toBe(4_000);
    left = 60_000;
    await m.organizations();
    // Standard-Zeitlimit bleibt, wenn die Restzeit länger ist
    expect(api.calls.at(-1)!.timeoutMs).toBe(15_000);
    left = 5_000;
    api.hooks.push(() => new Response("", { status: 429, headers: { "X-RateLimit-Reset": "9" } }));
    expect(await kindOf(m.organizations())).toBe("frist");
    expect(waits).toEqual([]);
    left = 0;
    const before = api.calls.length;
    expect(await kindOf(m.organizations())).toBe("frist");
    expect(api.calls).toHaveLength(before);
  });

  test("Abbruch beim Warten auf 429", async () => {
    const api = fakeSupabaseApi();
    api.hooks.push(() => new Response("", { status: 429, headers: { "X-RateLimit-Reset": "5" } }));
    const controller = new AbortController();
    const { m } = mgmt(api, SB.token, async () => controller.abort());
    expect(await kindOf(m.organizations(controller.signal))).toBe("abgebrochen");
  });

  test("Projektgrenze an Status und Stichwort erkannt", async () => {
    expect(looksLikeProjectLimit(400, "The following organization members have reached their maximum limits for the number of active free projects")).toBe(true);
    expect(looksLikeProjectLimit(402, "free project limit")).toBe(true);
    expect(looksLikeProjectLimit(500, "limit")).toBe(false);
    expect(looksLikeProjectLimit(400, "invalid name")).toBe(false);
    const api = fakeSupabaseApi();
    api.hooks.push(r => (r.method === "POST" && r.path === "/v1/projects" ? new Response('{"message":"reached the maximum limit of free projects"}', { status: 400 }) : undefined));
    expect(await kindOf(mgmt(api).m.createProject({ name: "tybo", organizationSlug: "org-alpha", region: "eu-central-1", dbPass: "p" }))).toBe("grenze");
  });

  test("Migrationen: Idempotency-Key im Kopf, 404 heißt Endpunkt fehlt", async () => {
    const api = fakeSupabaseApi({ projects: [{ ref: SB.ref, name: "tybo", organization_slug: "org-alpha", status: "ACTIVE_HEALTHY" }] });
    const { m } = mgmt(api);
    expect(await m.applyMigration(SB.ref, { name: "tybo_schema", query: "select 1", idempotencyKey: "k-1" })).toBe(true);
    expect(api.calls.at(-1)!.headers["Idempotency-Key"]).toBe("k-1");
    expect(await m.migrations(SB.ref)).toEqual([{ version: "20260926000000", name: "tybo_schema" }]);
    api.state.noMigrationsEndpoint = true;
    expect(await m.migrations(SB.ref)).toBeNull();
    expect(await m.applyMigration(SB.ref, { name: "tybo_schema", query: "select 1", idempotencyKey: "k-1" })).toBe(false);
  });

  test("Schlüssel mit reveal=true, neuer Secret-Schlüssel mit Namen", async () => {
    const api = fakeSupabaseApi({ projects: [{ ref: SB.ref, name: "tybo", organization_slug: "org-alpha", status: "ACTIVE_HEALTHY" }], keys: { [SB.ref]: [] } });
    const { m } = mgmt(api);
    expect(await m.apiKeys(SB.ref)).toEqual([]);
    expect(api.calls.at(-1)!.path).toBe(`/v1/projects/${SB.ref}/api-keys?reveal=true`);
    const k = await m.createSecretKey(SB.ref, "tybo");
    expect(k).toEqual({ type: "secret", name: "tybo", apiKey: SB.created });
    expect(api.calls.at(-1)!.body).toEqual({ type: "secret", name: "tybo" });
  });

  test("ungültige Ref geht nie ins Netz", async () => {
    const { api, m } = mgmt();
    expect(await kindOf(m.project("../organizations"))).toBe("nichtGefunden");
    expect(api.calls).toEqual([]);
  });
});
