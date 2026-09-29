/**
 * Issue #163: Ablauf „Supabase in der Cloud“ gegen eine Attrappe der
 * Management-API (Aufzeichnung aller Anfragen, tests/supabase-api-fixture.ts).
 * Gewartet wird über ctx.sleep (sofort, oder mit Abbruch), geschrieben nur in
 * die .env des Testordners.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cp, readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RunEvent, SetupValues } from "../src/setup/model";
import { CLOUD_NAME, CLOUD_ORG, CLOUD_REGION, CLOUD_TOKEN, organizationChoices, READY_TIMEOUT_MS, runSupabaseCloud } from "../src/setup/supabase-cloud";
import { loadSchemaFiles, migrationName, SCHEMA_FILES } from "../src/setup/supabase-schema";
import { backupsOf, cleanup, FAKE, makeCtx } from "./setup-fixture";
import { defaultKeys, fakeSupabaseApi, SB, type FakeApi, type FakeState } from "./supabase-api-fixture";

afterAll(cleanup);

const REPO = resolve(import.meta.dir, "..");
const BASE_ENV = `TELEGRAM_BOT_TOKEN=${FAKE.token}\nTELEGRAM_USER_ID=${FAKE.userId}\n`;
const ACTIVE = { ref: SB.ref, name: "tybo", organization_slug: "org-alpha", status: "ACTIVE_HEALTHY" };
const ALL_MIGRATIONS = SCHEMA_FILES.map((f, i) => ({ version: String(20260101000000 + i), name: migrationName(f) }));

interface Setup {
  ctx: Awaited<ReturnType<typeof makeCtx>>;
  api: FakeApi;
  events: RunEvent[];
  /** Für einen weiteren Lauf nach Abbruch durch einen neuen ersetzbar */
  controller: AbortController;
  run(values?: SetupValues): ReturnType<typeof runSupabaseCloud>;
}

async function setup(options: { env?: string; state?: Partial<FakeState>; sleep?: (ms: number, signal?: AbortSignal, s?: Setup) => Promise<void>; now?: () => Date } = {}): Promise<Setup> {
  const api = fakeSupabaseApi(options.state);
  const holder: { s?: Setup } = {};
  const ctx = await makeCtx({
    env: options.env ?? BASE_ENV,
    overrides: {
      fetch: api.fetch,
      ...(options.sleep ? { sleep: (ms: number, signal?: AbortSignal) => options.sleep!(ms, signal, holder.s) } : {}),
      ...(options.now ? { now: options.now } : {}),
    },
  });
  // Die Schema-Dateien liegen im Projektordner des Kontexts
  await cp(join(REPO, "db"), join(ctx.root, "db"), { recursive: true });
  const events: RunEvent[] = [];
  const s: Setup = {
    ctx: ctx as Setup["ctx"],
    api,
    events,
    controller: new AbortController(),
    run: (values = {}) =>
      runSupabaseCloud({ [CLOUD_TOKEN]: SB.token, [CLOUD_ORG]: "org-alpha", [CLOUD_NAME]: "tybo", [CLOUD_REGION]: "eu-central-1", ...values }, ctx, e => events.push(e), s.controller.signal),
  };
  holder.s = s;
  return s;
}

async function envOf(s: Setup): Promise<string> {
  try {
    return await readFile(s.ctx.envPath, "utf8");
  } catch {
    return "";
  }
}

/** Alle Dateien im Testordner (rekursiv) als ein Text */
async function allFiles(dir: string): Promise<string> {
  let out = "";
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out += await allFiles(p);
    else if ((await stat(p)).size < 5_000_000) out += await readFile(p, "utf8");
  }
  return out;
}

function tokenFree(s: Setup, result: unknown) {
  const text = JSON.stringify({ result, events: s.events });
  expect(text.includes(SB.token)).toBe(false);
  expect(text.includes("sbp_")).toBe(false);
}

describe("neues Projekt", () => {
  test("Anfragen in Reihenfolge, .env mit Adresse und Schlüsseln, Verbindungstest", async () => {
    const s = await setup();
    const result = await s.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain("angelegt");
    expect(s.api.trail()).toEqual([
      "GET /v1/organizations",
      "GET /v1/projects",
      "GET /v1/organizations/org-alpha",
      "POST /v1/projects",
      // Status bis bereit: zweimal COMING_UP, dann bereit und Dienste gesund
      `GET /v1/projects/${SB.ref}`,
      `GET /v1/projects/${SB.ref}`,
      `GET /v1/projects/${SB.ref}`,
      `GET /v1/projects/${SB.ref}/health`,
      `GET /v1/projects/${SB.ref}/database/migrations`,
      ...SCHEMA_FILES.map(() => `POST /v1/projects/${SB.ref}/database/migrations`),
      `POST /v1/projects/${SB.ref}/database/query`,
      `POST /v1/projects/${SB.ref}/database/query`,
      `GET /v1/projects/${SB.ref}/api-keys`,
    ]);
    const create = s.api.calls.find(c => c.method === "POST" && c.path === "/v1/projects")!;
    expect(create.body.organization_slug).toBe("org-alpha");
    expect(create.body.region_selection).toEqual({ type: "specific", code: "eu-central-1" });
    expect("region" in create.body).toBe(false);
    expect("plan" in create.body).toBe(false);
    expect(create.body.db_pass).toHaveLength(32);
    // Schema-Dateien in Reihenfolge, mit Namen und stabilem Idempotency-Key
    const migrations = s.api.calls.filter(c => c.method === "POST" && c.path.endsWith("/database/migrations"));
    expect(migrations.map(c => c.body.name)).toEqual(SCHEMA_FILES.map(migrationName));
    expect(migrations.every(c => c.headers["Idempotency-Key"]?.startsWith(`tybo-${SB.ref}-`))).toBe(true);
    // Ohne eigene BEGIN/COMMIT-Zeilen
    expect(migrations.some(c => /^\s*(BEGIN|COMMIT);\s*$/im.test(c.body.query))).toBe(false);
    // Bilder-Ordner privat, Standardname
    expect(s.api.state.buckets[SB.ref]).toEqual({ "tybo-assets": false });
    const env = await envOf(s);
    expect(env).toContain(`SUPABASE_URL=https://${SB.ref}.supabase.co`);
    expect(env).toContain(`SUPABASE_SERVICE_ROLE_KEY=${SB.secret}`);
    expect(env).toContain(`SUPABASE_ANON_KEY=${SB.publishable}`);
    expect(result.changed.sort()).toEqual(["SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL"]);
    const probe = s.ctx.providers.calls.find(c => c.method === "supabaseQuery")!;
    expect(probe.args).toEqual([`https://${SB.ref}.supabase.co`, SB.secret]);
    // Fortschritt 1 bis 9, beim Warten mit verstrichener Zeit
    expect([...new Set(s.events.map(e => e.at))]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(s.events.filter(e => e.at === 4).map(e => e.waitedMs)).toEqual([0, 5000, 10000]);
    tokenFree(s, result);
    expect((await allFiles(s.ctx.root)).includes(SB.token)).toBe(false);
    // Nie in der Umgebung, die Unterprozesse erben würden
    expect(Object.values(process.env).some(v => v?.includes(SB.token))).toBe(false);
    // Das Datenbank-Passwort steht nirgends
    expect((await allFiles(s.ctx.root)).includes(create.body.db_pass)).toBe(false);
    expect(JSON.stringify(s.events).includes(create.body.db_pass)).toBe(false);
  });

  test("gleicher Name in einer anderen Organisation zählt nicht: neues Projekt", async () => {
    const s = await setup({ state: { projects: [{ ...ACTIVE, ref: SB.otherRef, organization_slug: "org-beta" }], orgs: [{ slug: "org-alpha", name: "Alpha", plan: "free" }, { slug: "org-beta", name: "Beta", plan: "free" }] } });
    const result = await s.run();
    expect(result.ok).toBe(true);
    expect(s.api.trail()).toContain("POST /v1/projects");
  });

  test("Organisation nicht im kostenlosen Tarif: nichts angelegt", async () => {
    const s = await setup({ state: { orgs: [{ slug: "org-alpha", name: "Alpha", plan: "pro" }] } });
    const result = await s.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("kostenlosen Tarif");
    expect(s.api.trail()).not.toContain("POST /v1/projects");
    expect(await envOf(s)).toBe(BASE_ENV);
  });
});

describe("zweiter Lauf", () => {
  test("Projekt aus SUPABASE_URL: kein Anlegen, keine Migration doppelt, .env nicht geschrieben", async () => {
    const s = await setup();
    expect((await s.run()).ok).toBe(true);
    const backups = await backupsOf(s.ctx);
    const envBefore = await envOf(s);
    s.api.calls.length = 0;
    s.events.length = 0;
    const second = await s.run();
    expect(second.ok).toBe(true);
    expect(second.changed).toEqual([]);
    expect(second.message).toContain("schon eingerichtet");
    expect(s.api.trail()).not.toContain("POST /v1/projects");
    expect(s.api.trail()).not.toContain("GET /v1/projects");
    expect(s.api.calls.filter(c => c.method === "POST" && c.path.endsWith("/database/migrations"))).toEqual([]);
    expect(s.api.state.migrations[SB.ref].map(m => m.name)).toEqual(SCHEMA_FILES.map(migrationName));
    expect(await envOf(s)).toBe(envBefore);
    expect(await backupsOf(s.ctx)).toEqual(backups);
  });

  test("nur die fehlende Migration wird eingespielt", async () => {
    const s = await setup({
      env: `${BASE_ENV}SUPABASE_URL=https://${SB.ref}.supabase.co\n`,
      state: { projects: [ACTIVE], migrations: { [SB.ref]: ALL_MIGRATIONS.slice(0, -1) }, keys: { [SB.ref]: defaultKeys() } },
    });
    const result = await s.run();
    expect(result.ok).toBe(true);
    const posted = s.api.calls.filter(c => c.method === "POST" && c.path.endsWith("/database/migrations"));
    expect(posted.map(c => c.body.name)).toEqual([migrationName(SCHEMA_FILES[SCHEMA_FILES.length - 1])]);
    expect(result.message).toContain("ergänzt");
  });

  test("nach Abbruch vor dem Schreiben: findet das Projekt per Name (auch noch COMING_UP), legt nie neu an", async () => {
    const s = await setup({ state: { projects: [{ ...ACTIVE, comingUpPolls: 1 }], keys: { [SB.ref]: defaultKeys() } } });
    const result = await s.run();
    expect(result.ok).toBe(true);
    expect(s.api.trail()).not.toContain("POST /v1/projects");
    expect(s.events.some(e => e.label === "Projekt gefunden, nichts anzulegen")).toBe(true);
    // Weiter beobachtet, bis bereit
    expect(s.api.trail().filter(t => t === `GET /v1/projects/${SB.ref}`)).toHaveLength(2);
  });

  test("abweichender Projektname lässt sich angeben", async () => {
    const s = await setup({ state: { projects: [{ ...ACTIVE, name: "mein-bot" }], keys: { [SB.ref]: defaultKeys() } } });
    const result = await s.run({ [CLOUD_NAME]: "mein-bot" });
    expect(result.ok).toBe(true);
    expect(s.api.trail()).not.toContain("POST /v1/projects");
  });

  test("mehrere Treffer mit gleichem Namen: Abbruch, kein Anlegen", async () => {
    const s = await setup({ state: { projects: [ACTIVE, { ...ACTIVE, ref: SB.otherRef }] } });
    const result = await s.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("mehrere Projekte");
    expect(s.api.trail()).not.toContain("POST /v1/projects");
  });

  test("gespeicherte Ref nicht zugänglich: Abbruch, kein Ersatz", async () => {
    const s = await setup({ env: `${BASE_ENV}SUPABASE_URL=https://${SB.otherRef}.supabase.co\n`, state: { projects: [ACTIVE] } });
    const result = await s.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("nicht erreichbar");
    expect(s.api.trail()).not.toContain("POST /v1/projects");
    expect(s.api.trail()).not.toContain("GET /v1/projects");
  });
});

describe("Fehler mit klarer Meldung", () => {
  test("401: Token abgelehnt, auch im Fehlerfall kein Token in Meldung oder Fortschritt", async () => {
    const s = await setup();
    const result = await s.run({ [CLOUD_TOKEN]: SB.otherToken });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("lehnt das Zugangstoken ab");
    expect(JSON.stringify({ result, events: s.events }).includes(SB.otherToken)).toBe(false);
    expect(await envOf(s)).toBe(BASE_ENV);
  });

  test("Token ohne sbp_: keine Anfrage", async () => {
    const s = await setup();
    const result = await s.run({ [CLOUD_TOKEN]: "falsch-123456" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("sbp_");
    expect(s.api.calls).toEqual([]);
  });

  test("Projektgrenze: Satz mit zwei kostenlosen Projekten und dem Ausweg", async () => {
    const s = await setup();
    s.api.hooks.push(r =>
      r.method === "POST" && r.path === "/v1/projects" ? new Response(`{"message":"maximum limit of free projects ${SB.token}"}`, { status: 400 }) : undefined,
    );
    const result = await s.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("zwei aktive Projekte");
    expect(result.message).toContain("Zugangsdaten selbst eintragen");
    tokenFree(s, result);
  });

  test("INACTIVE: pausiert, kein Anlegen", async () => {
    const s = await setup({ state: { projects: [{ ...ACTIVE, status: "INACTIVE" }] } });
    const result = await s.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("pausiert");
    expect(s.api.trail()).not.toContain("POST /v1/projects");
  });

  test("INIT_FAILED beim Warten: Hinweis aufs Dashboard", async () => {
    const s = await setup();
    s.api.hooks.push(r => {
      if (r.method === "GET" && r.path === `/v1/projects/${SB.ref}`) {
        return new Response(JSON.stringify({ ...ACTIVE, status: "INIT_FAILED" }), { status: 200 });
      }
      return undefined;
    });
    const result = await s.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("nicht starten");
    expect(result.message).toContain("Dashboard");
    // Schritte im Dashboard und die anschließende Wiederaufnahme
    expect(result.message).toContain("neu starten");
    expect(result.message).toContain("setup datenbank");
    expect(result.message).toContain("dieselbe Organisation und derselbe Projektname");
    expect(await envOf(s)).toBe(BASE_ENV);
  });

  test("Zeitlimit beim Warten: angelegt, aber nicht bereit, zweiter Lauf genannt", async () => {
    let clock = Date.parse("2026-09-26T10:00:00Z");
    const s = await setup({
      now: () => new Date(clock),
      sleep: async ms => {
        clock += ms;
      },
      state: { healthComingUp: 10_000 },
    });
    const result = await s.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("noch nicht bereit");
    expect(result.message).toContain("setup datenbank");
    expect(Math.max(...s.events.map(e => e.waitedMs ?? 0))).toBeGreaterThanOrEqual(READY_TIMEOUT_MS);
    expect(Math.max(...s.events.map(e => e.waitedMs ?? 0))).toBeLessThan(READY_TIMEOUT_MS + 10_000);
    expect(await envOf(s)).toBe(BASE_ENV);
  });

  /** Uhr, die Schlafen und langsame Antworten vorrückt; Antworten über dem Zeitlimit enden wie bei defaultFetch mit Fehler */
  function slowClock() {
    const start = Date.parse("2026-09-26T10:00:00Z");
    const c = { start, now: start, waits: [] as number[] };
    return {
      c,
      now: () => new Date(c.now),
      sleep: async (ms: number) => {
        c.waits.push(ms);
        c.now += ms;
      },
      /** Antwort braucht delay ms; mehr als timeoutMs: Zeitlimit */
      respond(timeoutMs: number | undefined, delay: number) {
        const limit = timeoutMs ?? Number.POSITIVE_INFINITY;
        c.now += Math.min(delay, limit);
        if (delay > limit) throw new DOMException("Zeitlimit", "TimeoutError");
      },
    };
  }

  test("Frist mit langsamen Antworten: Zeitlimit jeder Anfrage höchstens die Restzeit, Ende genau nach zehn Minuten, kein Schema", async () => {
    const clock = slowClock();
    const s = await setup({ now: clock.now, sleep: clock.sleep, state: { healthComingUp: 10_000 } });
    const limits: Array<{ at: number; timeoutMs?: number }> = [];
    s.api.hooks.push(r => {
      if (r.path.startsWith(`/v1/projects/${SB.ref}`)) {
        limits.push({ at: clock.c.now, timeoutMs: r.timeoutMs });
        clock.respond(r.timeoutMs, 7_000);
      }
      return undefined;
    });
    const result = await s.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("noch nicht bereit");
    // Verbindlich: keine Minute, keine Sekunde darüber
    expect(clock.c.now - clock.c.start).toBe(READY_TIMEOUT_MS);
    for (const l of limits) expect(l.timeoutMs!).toBeLessThanOrEqual(READY_TIMEOUT_MS - (l.at - clock.c.start));
    // Die letzte Anfrage bekam nur die Restzeit (unter dem Standard von 15 s)
    expect(limits.at(-1)!.timeoutMs!).toBeLessThan(7_000);
    expect(s.api.calls.some(c => c.path.includes("/database/"))).toBe(false);
    expect(await envOf(s)).toBe(BASE_ENV);
  });

  test("Frist: gesund gemeldet erst zum Fristende, kein Übergang zum Schema", async () => {
    const clock = slowClock();
    const s = await setup({
      env: `${BASE_ENV}SUPABASE_URL=https://${SB.ref}.supabase.co\n`,
      now: clock.now,
      sleep: clock.sleep,
      // 119 Abfragen noch COMING_UP, dazwischen je 5 s: bereit nach 595 s
      state: { projects: [{ ...ACTIVE, comingUpPolls: 119 }], keys: { [SB.ref]: defaultKeys() } },
    });
    s.api.hooks.push(r => {
      // Die Antwort braucht genau die Restzeit (5 s, unter dem Zeitlimit)
      if (r.path.startsWith(`/v1/projects/${SB.ref}/health`)) clock.respond(r.timeoutMs, READY_TIMEOUT_MS - (clock.c.now - clock.c.start));
      return undefined;
    });
    const result = await s.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("noch nicht bereit");
    expect(clock.c.now - clock.c.start).toBe(READY_TIMEOUT_MS);
    expect(s.api.state.healthPolls).toBe(1);
    expect(s.api.calls.some(c => c.path.includes("/database/"))).toBe(false);
  });

  for (const kind of ["status", "health"] as const) {
    test(`Frist: Kopfzeilen der ${kind === "status" ? "Status" : "Health"}-Antwort rechtzeitig, Inhalt am Fristende abgebrochen`, async () => {
      const clock = slowClock();
      const s = await setup({
        env: `${BASE_ENV}SUPABASE_URL=https://${SB.ref}.supabase.co\n`,
        now: clock.now,
        sleep: clock.sleep,
        state: { projects: [{ ...ACTIVE, comingUpPolls: 119 }], keys: { [SB.ref]: defaultKeys() } },
      });
      const envBefore = await envOf(s);
      const path = kind === "status" ? `/v1/projects/${SB.ref}` : `/v1/projects/${SB.ref}/health`;
      s.api.hooks.push(r => {
        const [p] = r.path.split("?");
        // Erst die letzte Status-Abfrage (bereit), bzw. die Health-Abfrage danach
        if (p !== path || (kind === "status" && s.api.state.projects[0].comingUpPolls! > 0)) return undefined;
        const stream = new ReadableStream({
          pull: c => {
            // Das Lesen dauert bis zum Fristende, dann greift das Zeitlimit
            clock.c.now = clock.c.start + READY_TIMEOUT_MS;
            c.error(new DOMException("Zeitlimit", "TimeoutError"));
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } });
      });
      const result = await s.run();
      expect(result.ok).toBe(false);
      expect(result.message).toContain("noch nicht bereit");
      expect(result.message).toContain("setup datenbank");
      expect(result.message).toContain(".env ist unverändert");
      expect(await envOf(s)).toBe(envBefore);
      expect(s.api.calls.some(c => c.path.includes("/database/"))).toBe(false);
    });
  }

  test("Frist: 429 kurz vor Fristende wartet nicht über die Frist hinaus", async () => {
    const clock = slowClock();
    const s = await setup({ now: clock.now, sleep: clock.sleep, state: { healthComingUp: 10_000 } });
    s.api.hooks.push(r =>
      r.path === `/v1/projects/${SB.ref}` && clock.c.now - clock.c.start >= READY_TIMEOUT_MS - 6_000
        ? new Response("", { status: 429, headers: { "X-RateLimit-Reset": "9" } })
        : undefined,
    );
    const result = await s.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("noch nicht bereit");
    expect(clock.c.waits).not.toContain(9_000);
    expect(clock.c.now - clock.c.start).toBeLessThanOrEqual(READY_TIMEOUT_MS);
    expect(s.api.calls.some(c => c.path.includes("/database/"))).toBe(false);
  });

  test("429 beim Warten: wartet X-RateLimit-Reset Sekunden, dann weiter", async () => {
    const waits: number[] = [];
    const s = await setup({ sleep: async ms => void waits.push(ms) });
    let limited = 1;
    s.api.hooks.push(r => (r.path === `/v1/projects/${SB.ref}` && limited-- > 0 ? new Response("", { status: 429, headers: { "X-RateLimit-Reset": "9" } }) : undefined));
    const result = await s.run();
    expect(result.ok).toBe(true);
    expect(waits).toContain(9000);
  });

  test("429 bleibt: klare Meldung, nach dem Anlegen mit Hinweis auf den zweiten Lauf", async () => {
    const s = await setup();
    s.api.hooks.push(r => (r.path === `/v1/projects/${SB.ref}` ? new Response("", { status: 429, headers: { "X-RateLimit-Reset": "1" } }) : undefined));
    const result = await s.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("bremst");
    expect(result.message).toContain("setup datenbank");
    expect(await envOf(s)).toBe(BASE_ENV);
  });

  test("Abbruch beim Warten: Ablauf endet, .env unverändert, Hinweis auf den zweiten Lauf", async () => {
    const s = await setup({
      sleep: async (_ms, _signal, st) => {
        st!.controller.abort();
      },
    });
    const result = await s.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Abgebrochen");
    expect(result.message).toContain("setup datenbank");
    expect(s.api.calls.some(c => c.path.includes("/database/"))).toBe(false);
    expect(await envOf(s)).toBe(BASE_ENV);
    expect(await backupsOf(s.ctx)).toEqual([]);
    tokenFree(s, result);
  });

  test("Abbruch vor dem Anlegen: nichts angelegt", async () => {
    const s = await setup();
    s.api.hooks.push(r => {
      if (r.path === "/v1/projects") s.controller.abort();
      return undefined;
    });
    const result = await s.run();
    expect(result.message).toContain("nichts angelegt");
    expect(s.api.trail()).not.toContain("POST /v1/projects");
  });

  /** Legt das Projekt auf dem Server an wie die Attrappe, die Antwort kommt aber nicht an */
  function createThenLose(s: Setup, lose: () => never) {
    let once = true;
    s.api.hooks.push(r => {
      if (once && r.method === "POST" && r.path === "/v1/projects") {
        once = false;
        s.api.state.projects.push({ ref: SB.ref, name: r.body.name, organization_slug: r.body.organization_slug, status: "ACTIVE_HEALTHY", comingUpPolls: 1 });
        s.api.state.keys[SB.ref] = defaultKeys();
        lose();
      }
      return undefined;
    });
  }

  async function resumes(s: Setup) {
    s.api.calls.length = 0;
    const second = await s.run();
    expect(second.ok).toBe(true);
    expect(s.api.trail()).not.toContain("POST /v1/projects");
    expect(s.api.state.projects).toHaveLength(1);
    expect(await envOf(s)).toContain(`SUPABASE_URL=https://${SB.ref}.supabase.co`);
  }

  test("Anlage auf dem Server erfolgreich, Antwort verloren: ungewiss, nie nichts angelegt, Wiederaufnahme mit gleichem Namen", async () => {
    const s = await setup();
    createThenLose(s, () => {
      throw new TypeError("Verbindung getrennt");
    });
    const result = await s.run();
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("nichts angelegt");
    expect(result.message).toContain("unklar");
    expect(result.message).toContain("setup datenbank");
    expect(result.message).toContain("dieselbe Organisation und derselbe Projektname");
    expect(await envOf(s)).toBe(BASE_ENV);
    tokenFree(s, result);
    await resumes(s);
  });

  test("Strg+C während der Anlage: ungewiss, nie nichts angelegt, Wiederaufnahme mit gleichem Namen", async () => {
    const s = await setup();
    createThenLose(s, () => {
      s.controller.abort();
      throw new DOMException("Abgebrochen", "AbortError");
    });
    const result = await s.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Abgebrochen");
    expect(result.message).not.toContain("nichts angelegt");
    expect(result.message).toContain("unklar");
    expect(result.message).toContain("dieselbe Organisation und derselbe Projektname");
    expect(await envOf(s)).toBe(BASE_ENV);
    s.controller = new AbortController();
    await resumes(s);
  });

  test("Anlage abgelehnt (Projektgrenze): eindeutig, kein Hinweis auf Ungewissheit", async () => {
    const s = await setup();
    s.api.hooks.push(r => (r.method === "POST" && r.path === "/v1/projects" ? new Response('{"message":"maximum limit of free projects"}', { status: 400 }) : undefined));
    const result = await s.run();
    expect(result.message).not.toContain("unklar");
  });
});

describe("Schema", () => {
  test("Migrations-Endpunkt fehlt: Rückfall auf database/query mit Verbuchung in derselben Transaktion; zweiter Lauf spielt nichts doppelt ein", async () => {
    const s = await setup({ state: { noMigrationsEndpoint: true } });
    const first = await s.run();
    expect(first.ok).toBe(true);
    const recorded = s.api.state.queries.filter(q => q.includes("insert into supabase_migrations.schema_migrations"));
    expect(recorded).toHaveLength(SCHEMA_FILES.length);
    for (const q of recorded) {
      expect(q.startsWith("begin;")).toBe(true);
      expect(q.trim().endsWith("commit;")).toBe(true);
    }
    expect(s.api.state.migrations[SB.ref].map(m => m.name)).toEqual(SCHEMA_FILES.map(migrationName));
    s.api.state.queries.length = 0;
    const second = await s.run();
    expect(second.ok).toBe(true);
    expect(s.api.state.queries.filter(q => q.includes("insert into supabase_migrations.schema_migrations"))).toEqual([]);
  });

  test("Rückfall: Migrationsliste bricht nach HTTP 200 ab, keine Migration erneut gesendet", async () => {
    const s = await setup({
      env: `${BASE_ENV}SUPABASE_URL=https://${SB.ref}.supabase.co\n`,
      state: { projects: [ACTIVE], noMigrationsEndpoint: true, migrations: { [SB.ref]: [...ALL_MIGRATIONS] }, keys: { [SB.ref]: defaultKeys() } },
    });
    s.api.hooks.push(r => {
      if (r.method === "POST" && r.path.endsWith("/database/query") && r.body.query.startsWith("select version, name from supabase_migrations")) {
        // Kopfzeilen kommen, der Inhalt reißt ab
        const stream = new ReadableStream({ pull: c => c.error(new TypeError("Verbindung getrennt")) });
        return new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return undefined;
    });
    const result = await s.run();
    expect(result.ok).toBe(false);
    expect(s.api.state.queries.filter(q => q.includes("insert into supabase_migrations.schema_migrations"))).toEqual([]);
    expect(s.api.calls.filter(c => c.method === "POST" && c.path.endsWith("/database/migrations"))).toEqual([]);
    expect(s.api.state.migrations[SB.ref]).toEqual(ALL_MIGRATIONS);
    expect(s.api.trail().at(-1)).toBe(`POST /v1/projects/${SB.ref}/database/query`);
    expect(await envOf(s)).toBe(`${BASE_ENV}SUPABASE_URL=https://${SB.ref}.supabase.co\n`);
  });

  const fallbackInsert = (name: string) => new RegExp(`insert into supabase_migrations\\.schema_migrations \\(version, name\\) values \\('(\\d+)', '${name}'\\)`);

  test("Rückfall: Transaktion scheitert vor der Verbuchung, der nächste Lauf holt die Datei vollständig nach", async () => {
    const s = await setup({ state: { noMigrationsEndpoint: true } });
    const target = migrationName(SCHEMA_FILES[1]);
    let fail = true;
    s.api.hooks.push(r => {
      if (fail && r.method === "POST" && r.path.endsWith("/database/query") && fallbackInsert(target).test(r.body.query)) {
        fail = false;
        // Fehler in der Transaktion: nichts eingespielt, nichts verbucht
        return new Response('{"message":"statement failed"}', { status: 500 });
      }
      return undefined;
    });
    const first = await s.run();
    expect(first.ok).toBe(false);
    expect(first.message).toContain("setup datenbank");
    expect(s.api.state.migrations[SB.ref].map(m => m.name)).toEqual([migrationName(SCHEMA_FILES[0])]);
    s.api.state.queries.length = 0;
    const second = await s.run();
    expect(second.ok).toBe(true);
    const files = await loadSchemaFiles(s.ctx.root);
    const sent = s.api.state.queries.filter(q => q.includes("insert into supabase_migrations.schema_migrations"));
    // Die gescheiterte Datei vollständig (SQL und Verbuchung in einer Transaktion), die erste nicht erneut
    expect(sent).toHaveLength(SCHEMA_FILES.length - 1);
    expect(fallbackInsert(target).test(sent[0])).toBe(true);
    expect(sent[0]).toContain(files[1].sql);
    expect(sent[0].startsWith("begin;")).toBe(true);
    expect(sent.some(q => fallbackInsert(migrationName(SCHEMA_FILES[0])).test(q))).toBe(false);
    expect(s.api.state.migrations[SB.ref].map(m => m.name)).toEqual(SCHEMA_FILES.map(migrationName));
  });

  test("Rückfall: Antwort nach dem Commit verloren, der nächste Lauf überspringt die verbuchte Datei", async () => {
    const s = await setup({ state: { noMigrationsEndpoint: true } });
    const target = migrationName(SCHEMA_FILES[1]);
    let lose = true;
    s.api.hooks.push(r => {
      const m = r.method === "POST" && r.path.endsWith("/database/query") ? fallbackInsert(target).exec(r.body.query) : null;
      if (lose && m) {
        lose = false;
        // Auf dem Server eingespielt und verbucht (commit), die Antwort geht verloren
        s.api.state.queries.push(r.body.query);
        s.api.state.migrations[SB.ref].push({ version: m[1], name: target });
        throw new TypeError("Verbindung getrennt");
      }
      return undefined;
    });
    const first = await s.run();
    expect(first.ok).toBe(false);
    expect(first.message).toContain("setup datenbank");
    expect(await envOf(s)).toBe(BASE_ENV);
    s.api.state.queries.length = 0;
    const second = await s.run();
    expect(second.ok).toBe(true);
    const sent = s.api.state.queries.filter(q => q.includes("insert into supabase_migrations.schema_migrations"));
    // Nur die Dateien nach der verbuchten
    expect(sent).toHaveLength(SCHEMA_FILES.length - 2);
    SCHEMA_FILES.slice(2).forEach((file, i) => expect(fallbackInsert(migrationName(file)).test(sent[i])).toBe(true));
    expect(s.api.state.migrations[SB.ref].filter(m => m.name === target)).toHaveLength(1);
    expect(s.api.state.migrations[SB.ref].map(m => m.name)).toEqual(SCHEMA_FILES.map(migrationName));
  });

  test("Abbruch zwischen Einspielen und Antwort: zweiter Lauf erkennt die verbuchte Migration oder schickt denselben Idempotency-Key", async () => {
    const s = await setup();
    let lose = true;
    const keys: string[] = [];
    s.api.hooks.push(async r => {
      if (r.method === "POST" && r.path.endsWith("/database/migrations")) {
        keys.push(r.headers["Idempotency-Key"]);
        if (lose && r.body.name === migrationName(SCHEMA_FILES[1])) {
          lose = false;
          // Auf dem Server eingespielt und verbucht, die Antwort geht verloren
          s.api.state.migrations[SB.ref].push({ version: "20260926999999", name: r.body.name });
          throw new TypeError("Verbindung getrennt");
        }
      }
      return undefined;
    });
    const first = await s.run();
    expect(first.ok).toBe(false);
    expect(first.message).toContain("setup datenbank");
    expect(await envOf(s)).toBe(BASE_ENV);
    const firstKeys = [...keys];
    keys.length = 0;
    const second = await s.run();
    expect(second.ok).toBe(true);
    // Die verbuchte zweite Datei nicht erneut, nur die folgenden
    expect(firstKeys).toHaveLength(2);
    expect(keys).toHaveLength(SCHEMA_FILES.length - 2);
    expect(keys[0]).toContain(migrationName(SCHEMA_FILES[2]));
    expect(s.api.state.migrations[SB.ref].filter(m => m.name === migrationName(SCHEMA_FILES[1]))).toHaveLength(1);

    // Ohne Verbuchung (Antwort vor dem Einspielen verloren): derselbe Schlüssel wie beim ersten Versuch
    const t = await setup();
    const seen: string[] = [];
    let drop = true;
    t.api.hooks.push(r => {
      if (r.method === "POST" && r.path.endsWith("/database/migrations") && r.body.name === migrationName(SCHEMA_FILES[0])) {
        seen.push(r.headers["Idempotency-Key"]);
        if (drop) {
          drop = false;
          throw new TypeError("Verbindung getrennt");
        }
      }
      return undefined;
    });
    expect((await t.run()).ok).toBe(false);
    expect((await t.run()).ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });
});

describe("Bilder-Ordner", () => {
  test("abweichender SUPABASE_ASSETS_BUCKET wird privat angelegt", async () => {
    const s = await setup({ env: `${BASE_ENV}SUPABASE_ASSETS_BUCKET=bilder-ablage\n` });
    expect((await s.run()).ok).toBe(true);
    expect(s.api.state.buckets[SB.ref]).toEqual({ "bilder-ablage": false });
  });

  test("vorhandener öffentlicher Ordner: verständlicher Abbruch, bleibt unverändert, .env unverändert", async () => {
    const env = `${BASE_ENV}SUPABASE_ASSETS_BUCKET=bilder-ablage\nSUPABASE_URL=https://${SB.ref}.supabase.co\n`;
    const s = await setup({ env, state: { projects: [ACTIVE], migrations: { [SB.ref]: [...ALL_MIGRATIONS] }, buckets: { [SB.ref]: { "bilder-ablage": true } }, keys: { [SB.ref]: defaultKeys() } } });
    const result = await s.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("öffentlich");
    expect(s.api.state.buckets[SB.ref]["bilder-ablage"]).toBe(true);
    expect(await envOf(s)).toBe(env);
  });

  test("ungültiger Name: Abbruch vor der ersten Anfrage", async () => {
    const s = await setup({ env: `${BASE_ENV}SUPABASE_ASSETS_BUCKET=Nicht Gültig\n` });
    const result = await s.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("SUPABASE_ASSETS_BUCKET");
    expect(s.api.calls).toEqual([]);
  });
});

describe("Schlüssel", () => {
  async function withKeys(keys: FakeState["keys"][string]) {
    const s = await setup({ env: `${BASE_ENV}SUPABASE_URL=https://${SB.ref}.supabase.co\n`, state: { projects: [ACTIVE], migrations: { [SB.ref]: [...ALL_MIGRATIONS] }, keys: { [SB.ref]: keys } } });
    const result = await s.run();
    const env = await envOf(s);
    return { s, result, env, created: s.api.calls.filter(c => c.method === "POST" && c.path.includes("/api-keys")) };
  }
  const legacy = defaultKeys().filter(k => k.type === "legacy");

  test("neue bevorzugt", async () => {
    const { env, created } = await withKeys(defaultKeys());
    expect(env).toContain(`SUPABASE_SERVICE_ROLE_KEY=${SB.secret}`);
    expect(env).toContain(`SUPABASE_ANON_KEY=${SB.publishable}`);
    expect(created).toEqual([]);
  });

  test("nur alte: alte, nichts angelegt", async () => {
    const { env, created } = await withKeys(legacy);
    expect(env).toContain(`SUPABASE_SERVICE_ROLE_KEY=${SB.legacyService}`);
    expect(env).toContain(`SUPABASE_ANON_KEY=${SB.legacyAnon}`);
    expect(created).toEqual([]);
  });

  test("neue ohne secret: genau einer wird angelegt (Name tybo)", async () => {
    const { s, env, created } = await withKeys([...legacy, { type: "publishable", name: "default", api_key: SB.publishable }]);
    expect(created).toHaveLength(1);
    expect(created[0].body).toEqual({ type: "secret", name: "tybo" });
    expect(env).toContain(`SUPABASE_SERVICE_ROLE_KEY=${SB.created}`);
    expect(env).toContain(`SUPABASE_ANON_KEY=${SB.publishable}`);
    // Zweiter Lauf: der angelegte wird gefunden, kein weiterer
    s.api.calls.length = 0;
    expect((await s.run()).ok).toBe(true);
    expect(s.api.calls.filter(c => c.method === "POST" && c.path.includes("/api-keys"))).toEqual([]);
  });

  test("secret ohne publishable: secret und alter anon", async () => {
    const { env, created } = await withKeys([...legacy, { type: "secret", name: "default", api_key: SB.secret }]);
    expect(env).toContain(`SUPABASE_SERVICE_ROLE_KEY=${SB.secret}`);
    expect(env).toContain(`SUPABASE_ANON_KEY=${SB.legacyAnon}`);
    expect(created).toEqual([]);
  });

  test("mehrere secrets: der aus der .env bleibt", async () => {
    const s = await setup({
      env: `${BASE_ENV}SUPABASE_URL=https://${SB.ref}.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=${SB.secret2}\n`,
      state: {
        projects: [ACTIVE],
        migrations: { [SB.ref]: [...ALL_MIGRATIONS] },
        keys: { [SB.ref]: [...defaultKeys(), { type: "secret", name: "zweiter", api_key: SB.secret2 }] },
      },
    });
    const result = await s.run();
    expect(result.changed).toEqual(["SUPABASE_ANON_KEY"]);
    expect(await envOf(s)).toContain(`SUPABASE_SERVICE_ROLE_KEY=${SB.secret2}`);
  });
});

describe("Wechsel von Convex", () => {
  const convexEnv = `${BASE_ENV}CONVEX_URL=${FAKE.convexUrl}\nCONVEX_AUTH_TOKEN=${FAKE.convexToken}\n`;

  test("ohne Bestätigung: keine Anfrage", async () => {
    const s = await setup({ env: convexEnv });
    const result = await s.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("nicht bestätigt");
    expect(s.api.calls).toEqual([]);
  });

  test("mit Bestätigung: CONVEX_URL entfernt", async () => {
    const s = await setup({ env: convexEnv });
    const result = await s.run({ DB_SWITCH_CONFIRM: "true" });
    expect(result.ok).toBe(true);
    expect(result.changed).toContain("CONVEX_URL");
    expect(await envOf(s)).not.toContain("CONVEX_URL=");
  });
});

describe("Auswahl der Organisation", () => {
  test("nur Organisationen im kostenlosen Tarif, Name als Anzeige, slug als Wert", async () => {
    const s = await setup({
      state: {
        orgs: [
          { slug: "org-alpha", name: "Alpha", plan: "free" },
          { slug: "org-pro", name: "Firma", plan: "pro" },
          { slug: "org-ohne", name: "Unbekannt" },
        ],
      },
    });
    expect(await organizationChoices({ [CLOUD_TOKEN]: SB.token }, s.ctx)).toEqual({ choices: [{ value: "org-alpha", label: "Alpha" }] });
  });

  test("leere Liste, nur bezahlte, falsches Token, fehlendes Token: klare Meldungen ohne Token", async () => {
    const empty = await setup({ state: { orgs: [] } });
    const r1 = await organizationChoices({ [CLOUD_TOKEN]: SB.token }, empty.ctx);
    expect("error" in r1 && r1.error).toContain("keine Organisation");
    const paid = await setup({ state: { orgs: [{ slug: "o", name: "O", plan: "team" }] } });
    const r2 = await organizationChoices({ [CLOUD_TOKEN]: SB.token }, paid.ctx);
    expect("error" in r2 && r2.error).toContain("kostenlosen Tarif");
    const r3 = await organizationChoices({ [CLOUD_TOKEN]: SB.otherToken }, empty.ctx);
    expect("error" in r3 && r3.error).toContain("lehnt das Zugangstoken ab");
    expect(JSON.stringify([r1, r2, r3]).includes("sbp_")).toBe(false);
    expect("error" in (await organizationChoices({}, empty.ctx))).toBe(true);
  });
});
