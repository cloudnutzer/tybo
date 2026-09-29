/**
 * Issue #166: Schritt „Semantische Suche“ (tybo setup suche). Felder und
 * Einordnung, Überspringen ohne Schlüssel, Cloud über die Management-API,
 * Supabase auf diesem Rechner (supabase/functions/.env, Neustart mit
 * Portschutz), selbst eingetragenes Supabase, der Funktionsnachweis samt
 * Aufräumen und die Anzeige in Übersicht und Gesamtprüfung. Alles gegen
 * Attrappen (tests/search-fixture.ts, tests/local-supabase-fixture.ts).
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SetupContext } from "../src/setup/context";
import { fieldDefinitionProblems, isTransientName, runsAsFlow, type RunEvent } from "../src/setup/model";
import {
  EDGE_FUNCTIONS,
  functionsEnvPath,
  PROBE_PREFIX,
  probeSearch,
  REINDEX_FIELD,
  readRecord,
  RECHECK_MS,
  recordPath,
  restartMarkerPath,
  runSemanticSearch,
  SEARCH_KEY,
  storeSettled,
  TEXT_ONLY,
  UNCERTAIN_WINDOW_MS,
  writeRecord,
} from "../src/setup/semantic-search";
import { checkStep, existingFieldValues, getStep, SETUP_STEPS } from "../src/setup/steps";
import { SEARCH_FIELDS, searchStep } from "../src/setup/steps/search";
import { cleanup, FAKE, makeCtx } from "./setup-fixture";
import { fakeLocal, LOCAL, SAFE_CONTAINERS, type FakeLocal } from "./local-supabase-fixture";
import { GEMINI, localRuntime, OPENAI, searchFake, type SearchFake } from "./search-fixture";
import { SB } from "./supabase-api-fixture";
import { CTRL_C, runWith, scripted } from "./setup-terminal-fixture";
import { get, login, post, PROFILE, startSetup, type Started, type TestCtx } from "./setup-web-fixture";

const running: Started[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.server.stop();
});
afterAll(cleanup);

const REPO = resolve(import.meta.dir, "..");
const BASE = `TELEGRAM_BOT_TOKEN=${FAKE.token}\nTELEGRAM_USER_ID=${FAKE.userId}\n`;
const CLOUD_URL = `https://${SB.ref}.supabase.co`;
const CLOUD_ENV = `${BASE}SUPABASE_URL=${CLOUD_URL}\nSUPABASE_SERVICE_ROLE_KEY=${SB.secret}\n`;
const LOCAL_ENV = `${BASE}SUPABASE_URL=${LOCAL.apiUrl}\nSUPABASE_SERVICE_ROLE_KEY=${LOCAL.secret}\n`;
const SELF_ENV = `${BASE}SUPABASE_URL=https://db.example.org\nSUPABASE_SERVICE_ROLE_KEY=${SB.secret}\n`;
const CONVEX_ENV = `${BASE}CONVEX_URL=${FAKE.convexUrl}\nCONVEX_AUTH_TOKEN=${FAKE.convexToken}\n`;

const never = new AbortController().signal;
/** Verhalten vor #167: OpenAI mit Standardmodell */
const LEGACY_CONFIG = { provider: "openai" as const, model: "text-embedding-3-small" };

/** Kontext mit Kopie von supabase/ (Functions, config.toml) und der Attrappe als fetch */
async function searchCtx(env: string, fake: SearchFake = searchFake(), overrides: Partial<SetupContext> = {}) {
  const ctx = (await makeCtx({ env, profile: PROFILE, overrides: { fetch: fake.fetch, ...overrides } })) as TestCtx;
  await cp(join(REPO, "supabase", "functions"), join(ctx.root, "supabase", "functions"), { recursive: true });
  await cp(join(REPO, "supabase", "config.toml"), join(ctx.root, "supabase", "config.toml"));
  return { ctx, fake };
}

async function run(ctx: SetupContext, values: Record<string, string>, signal = never) {
  const events: RunEvent[] = [];
  const result = await runSemanticSearch(values, ctx, e => events.push(e), signal);
  return { result, events };
}

/** Alle Dateien unter dir als Text (für Suche nach Geheimnissen) */
async function allFiles(dir: string, skip: (p: string) => boolean = () => false): Promise<string> {
  let out = "";
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, entry.name);
    if (skip(p)) continue;
    if (entry.isDirectory()) out += await allFiles(p, skip);
    else if ((await stat(p)).size < 5_000_000) out += await readFile(p, "utf8");
  }
  return out;
}

const envText = (ctx: SetupContext) => readFile(ctx.envPath, "utf8").catch(() => "");

// ---------------------------------------------------------------------------
// Checkbox 1: Schritt, Überspringen, tybo setup suche
// ---------------------------------------------------------------------------

describe("Schritt und Felder", () => {
  test("direkt nach der Datenbank, optional, als Ablauf, mit gültigen Felddefinitionen", () => {
    const ids = SETUP_STEPS.map(s => s.id);
    expect(ids.indexOf("suche")).toBe(ids.indexOf("datenbank") + 1);
    expect(getStep("suche")).toBe(searchStep);
    expect(searchStep.optional).toBe(true);
    expect(searchStep.title).toBe("Semantische Suche");
    expect(runsAsFlow(searchStep, {})).toBe(true);
    expect(fieldDefinitionProblems(SEARCH_FIELDS)).toEqual([]);
  });

  test("OpenAI-Schlüssel unter eigenem, transientem Namen; OPENAI_API_KEY bleibt speicherbar", () => {
    const key = SEARCH_FIELDS.find(f => f.name === SEARCH_KEY)!;
    expect(key).toMatchObject({ kind: "secret", transient: true });
    expect(isTransientName(SEARCH_KEY)).toBe(true);
    expect(isTransientName("SUPABASE_SETUP_TOKEN")).toBe(true);
    expect(isTransientName("OPENAI_API_KEY")).toBe(false);
    expect(key.validate!("abc", {})).toContain("sk-");
    expect(key.validate!(OPENAI.good, {})).toBeNull();
    expect(key.help).toContain("0,02 US-Dollar");
    expect(key.help).toContain("tybo setup suche");
  });

  test("Sichtbarkeit nach dem Weg der Datenbank: Token nur in der Cloud, bei Convex keine Felder", async () => {
    const visible = async (env: string) => {
      const { ctx } = await searchCtx(env);
      const existing = await existingFieldValues(searchStep, ctx);
      return SEARCH_FIELDS.filter(f => !f.visible || f.visible(existing)).map(f => f.name);
    };
    // Ohne Wahl gilt OpenAI (Standard des Felds EMBEDDING_PROVIDER, Issue #167)
    // Rückfrage beim Anbieterwechsel (Issue #168) nur, wo der Assistent die Functions einrichtet
    expect(await visible(CLOUD_ENV)).toEqual(["EMBEDDING_PROVIDER", SEARCH_KEY, "SUPABASE_SETUP_TOKEN", REINDEX_FIELD]);
    expect(await visible(LOCAL_ENV)).toEqual(["EMBEDDING_PROVIDER", SEARCH_KEY, REINDEX_FIELD]);
    expect(await visible(SELF_ENV)).toEqual(["EMBEDDING_PROVIDER", SEARCH_KEY]);
    expect(await visible(CONVEX_ENV)).toEqual([]);
  });

  test("Plan je Weg, ohne Werte", () => {
    expect(searchStep.plan!({ DB_BACKEND: "supabase-cloud" }).join(" ")).toContain("store-telegram-message, search-memory, embed-knowledge");
    expect(searchStep.plan!({ DB_BACKEND: "supabase-lokal" }).join(" ")).toContain("supabase/functions/.env");
    expect(searchStep.plan!({ DB_BACKEND: "supabase" }).join(" ")).toContain("ändert der Assistent nichts");
    expect(searchStep.plan!({ DB_BACKEND: "convex" }).join(" ")).toContain("nur für Supabase");
    expect(searchStep.plan!({ DB_BACKEND: "supabase-cloud" }).join(" ")).toContain("keine Embeddings nachträglich");
  });
});

describe("Ohne Schlüssel: nur Textsuche, kein Fehler", () => {
  test("Cloud ohne Schlüssel und ohne Token: ok, „nur Textsuche“, keine Anfrage, nichts geschrieben", async () => {
    const { ctx, fake } = await searchCtx(CLOUD_ENV);
    const { result } = await run(ctx, {});
    expect(result).toEqual({ ok: true, message: TEXT_ONLY, changed: [] });
    expect(result.message).toContain("nur Textsuche");
    expect(fake.sent).toEqual([]);
    expect(await envText(ctx)).toBe(CLOUD_ENV);
  });

  test("lokal und selbst eingetragen ohne Schlüssel: ebenso", async () => {
    for (const env of [LOCAL_ENV, SELF_ENV]) {
      const { ctx, fake } = await searchCtx(env);
      const { result } = await run(ctx, {});
      expect(result.ok).toBe(true);
      expect(result.message).toContain("nur Textsuche");
      expect(fake.sent).toEqual([]);
    }
  });

  test("Überspringen stuft eine nachgewiesen funktionierende Einrichtung nicht herab", async () => {
    const { ctx } = await searchCtx(CLOUD_ENV);
    await writeRecord(ctx, CLOUD_URL, "aktiv");
    const { result } = await run(ctx, {});
    expect(result.ok).toBe(true);
    expect(result.message).toContain("bleibt es");
    expect(result.message).not.toContain("nur Textsuche");
    expect((await readRecord(ctx))?.state).toBe("aktiv");
    expect((await searchStep.status(ctx)).state).toBe("erledigt");
  });

  test("Terminal: tybo setup suche mit leerem Schlüssel und Token endet mit dem Hinweis", async () => {
    const { ctx, fake } = await searchCtx(CLOUD_ENV);
    // Anbieter (Enter: OpenAI), Schlüssel, Token, Neuberechnung (Enter: Weiter), Bestätigung
    const prompter = scripted(["", "", "", "", ""]);
    const r = await runWith({ mode: "step", step: "suche" }, ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.left()).toBe(0);
    expect(prompter.asked.map(a => a.secret)).toEqual([false, true, true, false, false]);
    expect(r.out).toContain("Das passiert jetzt:");
    expect(r.out).toContain("nur Textsuche");
    expect(r.out).toContain("Semantische Suche: unverändert");
    expect(fake.sent).toEqual([]);
  });

  test("Terminal, ganzer Lauf: „Jetzt einrichten?“ nein überspringt den Schritt", async () => {
    const { ctx } = await searchCtx(CLOUD_ENV);
    // Erledigt sind Telegram und Datenbank; offen: Gruppe, Suche, Modelle, WebUI, Autostart; Profil aus PROFILE fehlt in .env
    const r = await runWith({ mode: "all" }, ctx, scripted(["", "n", "n", CTRL_C]));
    expect(r.out).toContain("Semantische Suche (optional)");
    expect(r.out).toContain("Stand: Semantische Suche: nur Textsuche");
  });

  test("Convex: Ablauf endet mit Hinweis, Status nennt den Grund", async () => {
    const { ctx, fake } = await searchCtx(CONVEX_ENV);
    const { result } = await run(ctx, { [SEARCH_KEY]: OPENAI.good });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("nur für Supabase");
    expect(fake.sent).toEqual([]);
    expect((await searchStep.status(ctx)).detail).toContain("nur für Supabase");
  });

  test("keine Datenbank: Hinweis auf tybo setup datenbank", async () => {
    const { ctx } = await searchCtx(BASE);
    expect((await run(ctx, { [SEARCH_KEY]: OPENAI.good })).result.message).toContain("setup datenbank");
    expect((await searchStep.status(ctx)).state).toBe("fehlt");
  });

  test("ungültig aussehender Schlüssel: nichts angefragt", async () => {
    const { ctx, fake } = await searchCtx(CLOUD_ENV);
    const { result } = await run(ctx, { [SEARCH_KEY]: "falsch", SUPABASE_SETUP_TOKEN: SB.token });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("sk-");
    expect(fake.sent).toEqual([]);
  });
});

describe("Browser: Einrichtungsmodus", () => {
  async function json(res: Response) {
    const text = await res.text();
    return { status: res.status, text, data: JSON.parse(text) };
  }

  async function untilDone(s: Started, cookie: string, runId: string) {
    for (let i = 0; i < 400; i++) {
      const res = await json(await get(s, `/api/setup/runs/${runId}`, cookie));
      if (res.data.state !== "laeuft") return res;
      await Bun.sleep(5);
    }
    throw new Error("Ablauf endet nicht");
  }

  test("Ablauf mit Plan, Felder nach Weg; Schlüssel und Token in keiner Antwort, keinem Log, nicht in data/", async () => {
    const { ctx, fake } = await searchCtx(CLOUD_ENV);
    const s = await startSetup({ ctx });
    running.push(s);
    const cookie = await login(s);
    const texts: string[] = [];
    const view = await json(await post(s, "/api/setup/steps/suche/view", { values: {} }, cookie));
    texts.push(view.text);
    expect(view.data.mode).toBe("ablauf");
    expect(view.data.fields.filter((f: any) => f.visible).map((f: any) => f.name)).toEqual(["EMBEDDING_PROVIDER", SEARCH_KEY, "SUPABASE_SETUP_TOKEN", REINDEX_FIELD]);
    const started = await json(await post(s, "/api/setup/steps/suche/run", { values: { [SEARCH_KEY]: OPENAI.good, SUPABASE_SETUP_TOKEN: SB.token } }, cookie));
    expect(started.status).toBe(202);
    const done = await untilDone(s, cookie, started.data.runId);
    texts.push(done.text);
    expect(done.data.state).toBe("fertig");
    expect(done.data.result.message).toContain("Semantische Suche: aktiv");
    expect(done.data.result.changed).toEqual(["OPENAI_API_KEY"]);
    const overview = await json(await get(s, "/api/setup/overview", cookie));
    texts.push(overview.text);
    expect(overview.data.steps.find((x: any) => x.id === "suche")).toMatchObject({ state: "erledigt", optional: true });
    for (const t of [...texts, s.logs.join("\n")]) {
      expect(t.includes(OPENAI.good)).toBe(false);
      expect(t.includes(SB.token)).toBe(false);
    }
    // data/: Sicherungen der .env (0600) ausgenommen, sonst nirgends
    const data = await allFiles(join(ctx.root, "data"), p => p.startsWith(ctx.backupDir));
    expect(data).toContain('"state": "aktiv"');
    expect(data.includes(OPENAI.good)).toBe(false);
    expect((await allFiles(ctx.root)).includes(SB.token)).toBe(false);
    expect(fake.deploys.map(d => d.slug)).toEqual([...EDGE_FUNCTIONS]);
  });
});

// ---------------------------------------------------------------------------
// Checkbox 2: Cloud (Management-API), lokal (Datei, Neustart), selbst eingetragen
// ---------------------------------------------------------------------------

describe("Cloud: Functions ausliefern, Geheimnis setzen", () => {
  test("alle drei Functions mit der Projekt-Referenz, verify_jwt aus, samt _shared; dann secrets", async () => {
    const { ctx, fake } = await searchCtx(CLOUD_ENV);
    const { result, events } = await run(ctx, { [SEARCH_KEY]: OPENAI.good, SUPABASE_SETUP_TOKEN: SB.token });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Semantische Suche: aktiv");

    expect(fake.deploys.map(d => [d.ref, d.slug])).toEqual(EDGE_FUNCTIONS.map(slug => [SB.ref, slug]));
    for (const d of fake.deploys) {
      expect(d.metadata).toEqual({ entrypoint_path: `supabase/functions/${d.slug}/index.ts`, name: d.slug, verify_jwt: false });
      expect(d.files).toContain(`supabase/functions/${d.slug}/index.ts`);
      expect(d.files).toContain("supabase/functions/_shared/auth.ts");
      expect(d.files).toContain("supabase/functions/_shared/admin-key.ts");
    }
    expect(fake.deploys.find(d => d.slug === "store-telegram-message")!.files).toContain("supabase/functions/store-telegram-message/row.ts");
    expect(fake.secrets[SB.ref]).toEqual({ OPENAI_API_KEY: OPENAI.good });

    const mgmt = fake.api.trail();
    expect(mgmt).toEqual([
      `GET /v1/projects/${SB.ref}`,
      // Namen der Geheimnisse: steht dort noch eine frühere Anbieterwahl? (Issue #167)
      `GET /v1/projects/${SB.ref}/secrets`,
      ...EDGE_FUNCTIONS.map(() => `POST /v1/projects/${SB.ref}/functions/deploy`),
      `POST /v1/projects/${SB.ref}/secrets`,
    ]);
    // Token nur im Kopf an api.supabase.com; der Schlüssel nur an OpenAI und im Geheimnis
    for (const s of fake.sent) {
      const text = JSON.stringify(s);
      if (text.includes(SB.token)) expect(new URL(s.url).host).toBe("api.supabase.com");
      if (text.includes(OPENAI.good)) expect(s.url === "https://api.openai.com/v1/embeddings" || s.url.endsWith("/secrets")).toBe(true);
      expect(s.url.includes(SB.token) || s.url.includes(OPENAI.good)).toBe(false);
    }
    expect(events.map(e => e.label)).toContain("Liefere die Edge Functions aus");
    expect(JSON.stringify(events).includes(OPENAI.good)).toBe(false);
    expect(result.message.includes(OPENAI.good)).toBe(false);
    // .env: OPENAI_API_KEY, nie das Token, nie der transiente Name
    const env = await envText(ctx);
    expect(env).toContain(`OPENAI_API_KEY=${OPENAI.good}`);
    expect(env).not.toContain(SEARCH_KEY);
    expect(env).not.toContain(SB.token);
    // Probe aufgeräumt, Ergebnis gemerkt
    expect(fake.project.rows).toEqual([]);
    expect((await readRecord(ctx))?.state).toBe("aktiv");
  });

  test("Schlüssel aus der .env reicht, wenn keiner eingegeben ist", async () => {
    const { ctx, fake } = await searchCtx(`${CLOUD_ENV}OPENAI_API_KEY=${OPENAI.good}\n`);
    const { result } = await run(ctx, { SUPABASE_SETUP_TOKEN: SB.token });
    expect(result.ok).toBe(true);
    expect(result.changed).toEqual([]);
    expect(fake.secrets[SB.ref]).toEqual({ OPENAI_API_KEY: OPENAI.good });
  });

  test("Geheimnis bei Supabase schon gesetzt, keine Kopie in der .env: ausliefern und prüfen, ohne secrets set", async () => {
    const fake = searchFake();
    fake.secrets[SB.ref] = { OPENAI_API_KEY: OPENAI.other };
    const { ctx } = await searchCtx(CLOUD_ENV, fake);
    const { result } = await run(ctx, { SUPABASE_SETUP_TOKEN: SB.token });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("war bei Supabase schon gesetzt");
    expect(fake.api.trail()).toContain(`GET /v1/projects/${SB.ref}/secrets`);
    expect(fake.api.trail()).not.toContain(`POST /v1/projects/${SB.ref}/secrets`);
    expect(fake.sent.some(s => s.url.startsWith("https://api.openai.com"))).toBe(false);
    expect(await envText(ctx)).toBe(CLOUD_ENV);
  });

  test("Token ohne Schlüssel und ohne Geheimnis: nur Textsuche, nichts ausgeliefert", async () => {
    const { ctx, fake } = await searchCtx(CLOUD_ENV);
    const { result } = await run(ctx, { SUPABASE_SETUP_TOKEN: SB.token });
    expect(result).toEqual({ ok: true, message: TEXT_ONLY, changed: [] });
    expect(fake.deploys).toEqual([]);
  });

  test("Schlüssel ohne Token: klarer Hinweis, nichts geändert", async () => {
    const { ctx, fake } = await searchCtx(CLOUD_ENV);
    const { result } = await run(ctx, { [SEARCH_KEY]: OPENAI.good });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Zugangstoken");
    expect(fake.sent).toEqual([]);
    expect(await envText(ctx)).toBe(CLOUD_ENV);
  });

  test("OpenAI lehnt den Schlüssel ab: feste Meldung ohne Antworttext, bei Supabase nichts angefragt", async () => {
    const { ctx, fake } = await searchCtx(CLOUD_ENV);
    const { result } = await run(ctx, { [SEARCH_KEY]: OPENAI.bad, SUPABASE_SETUP_TOKEN: SB.token });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("OpenAI lehnt den Schlüssel ab");
    expect(result.message.includes(OPENAI.bad)).toBe(false);
    expect(fake.api.calls).toEqual([]);
    expect(await envText(ctx)).toBe(CLOUD_ENV);
  });

  test("Projekt mit diesem Token nicht erreichbar: Abbruch vor dem Ausliefern", async () => {
    const fake = searchFake({ state: { projects: [] } });
    const { ctx } = await searchCtx(CLOUD_ENV, fake);
    const { result } = await run(ctx, { [SEARCH_KEY]: OPENAI.good, SUPABASE_SETUP_TOKEN: SB.token });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("nicht erreichbar");
    expect(fake.deploys).toEqual([]);
    expect(await envText(ctx)).toBe(CLOUD_ENV);
  });

  test("Fehler beim Ausliefern: sagt, was schon erledigt ist, ohne Werte", async () => {
    const fake = searchFake();
    fake.api.hooks.unshift(r => (r.path.includes("slug=search-memory") ? new Response(`{"message":"${SB.token}"}`, { status: 500 }) : undefined));
    const { ctx } = await searchCtx(CLOUD_ENV, fake);
    const { result } = await run(ctx, { [SEARCH_KEY]: OPENAI.good, SUPABASE_SETUP_TOKEN: SB.token });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Function store-telegram-message ausgeliefert");
    expect(result.message).toContain("setup suche");
    expect(result.message.includes(SB.token)).toBe(false);
    expect(fake.secrets[SB.ref]).toBeUndefined();
  });

  test("alte Schlüssel (JWT) gehen in apikey und Authorization, neue nur in apikey", async () => {
    const legacyEnv = `${BASE}SUPABASE_URL=${CLOUD_URL}\nSUPABASE_SERVICE_ROLE_KEY=${SB.legacyService}\n`;
    for (const [env, key] of [
      [CLOUD_ENV, SB.secret],
      [legacyEnv, SB.legacyService],
    ] as const) {
      const fake = searchFake({ project: { serviceKeys: [key] } });
      const { ctx } = await searchCtx(env, fake);
      const { result } = await run(ctx, { [SEARCH_KEY]: OPENAI.good, SUPABASE_SETUP_TOKEN: SB.token });
      expect(result.ok).toBe(true);
      const fn = fake.sent.find(s => s.url.includes("/functions/v1/store-telegram-message"))!;
      expect(fn.headers.apikey).toBe(key);
      if (key.startsWith("sb_")) expect(fn.headers.Authorization).toBeUndefined();
      else expect(fn.headers.Authorization).toBe(`Bearer ${key}`);
    }
  });
});

describe("Supabase auf diesem Rechner", () => {
  async function localCtx(extraFnEnv?: string) {
    const local: FakeLocal = fakeLocal();
    // Supabase läuft schon (mit Edge Runtime)
    local.containers = [...SAFE_CONTAINERS, "supabase_edge_runtime_tybo\t"];
    const fake = searchFake({ project: { serviceKeys: [LOCAL.secret], deployed: new Set(EDGE_FUNCTIONS) } });
    const { ctx } = await searchCtx(LOCAL_ENV, fake, { run: local.run as any, localSupabase: local.deps });
    const runtime = localRuntime(functionsEnvPath(ctx.root));
    fake.project.runtimeKey = runtime.key;
    if (extraFnEnv !== undefined) await writeFile(functionsEnvPath(ctx.root), extraFnEnv, { mode: 0o600 });
    await runtime.start();
    local.answers["supabase start"] = async () => {
      await runtime.start();
      return { stdout: "Started" };
    };
    return { ctx, fake, local };
  }

  test("Schlüssel in supabase/functions/.env (0600, andere Werte bleiben), Neustart mit Portschutz, Nachweis", async () => {
    const { ctx, fake, local } = await localCtx("# eigener Eintrag\nANDERER_WERT=bleibt\n");
    const { result } = await run(ctx, { [SEARCH_KEY]: OPENAI.good });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Supabase neu gestartet");
    expect(result.message).toContain("Semantische Suche: aktiv");
    const fnEnv = await readFile(functionsEnvPath(ctx.root), "utf8");
    expect(fnEnv).toContain("# eigener Eintrag");
    expect(fnEnv).toContain("ANDERER_WERT=bleibt");
    expect(fnEnv).toContain(`OPENAI_API_KEY=${OPENAI.good}`);
    expect((await stat(functionsEnvPath(ctx.root))).mode & 0o777).toBe(0o600);
    expect(result.changed).toEqual([functionsEnvPath(ctx.root), "OPENAI_API_KEY"]);
    // Anhalten, dann Start über tybo datenbank start: Loopback-Netz, Start, Portprüfung
    const trail = local.trail();
    expect(trail[0]).toBe("supabase stop");
    expect(trail).toContain("docker network inspect");
    expect(trail.indexOf("supabase start")).toBeGreaterThan(trail.indexOf("supabase stop"));
    expect(trail.lastIndexOf("docker ps")).toBeGreaterThan(trail.indexOf("supabase start"));
    // Nie --no-backup oder --all; Umgebung der CLI ohne Geheimnisse
    for (const c of local.run.calls) {
      expect(c.cmd).not.toContain("--no-backup");
      expect(c.cmd).not.toContain("--all");
      expect(JSON.stringify(c).includes(OPENAI.good)).toBe(false);
    }
    // Die Datei gehört nicht ins Repo
    const ignored = Bun.spawnSync(["git", "check-ignore", "-q", "supabase/functions/.env"], { cwd: REPO });
    expect(ignored.exitCode).toBe(0);
    expect(fake.project.rows).toEqual([]);
  });

  test("Schlüssel schon eingetragen: kein Neustart, nur Nachweis", async () => {
    const { ctx, local } = await localCtx(`OPENAI_API_KEY=${OPENAI.good}\n`);
    const { result } = await run(ctx, { [SEARCH_KEY]: OPENAI.good });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("hatte den Schlüssel schon");
    expect(local.trail()).not.toContain("supabase stop");
  });

  test("ohne Eingabe, aber Schlüssel in supabase/functions/.env: Nachweis ohne Änderung", async () => {
    const { ctx, local } = await localCtx(`OPENAI_API_KEY=${OPENAI.good}\n`);
    const { result } = await run(ctx, {});
    expect(result.ok).toBe(true);
    expect(result.changed).toEqual([]);
    expect(local.trail()).toEqual([]);
  });

  test("Neustart offen im Heimnetz: Schutz-Stopp, Meldung, kein „aktiv“", async () => {
    const { ctx, local } = await localCtx();
    local.lan = [54421];
    const { result } = await run(ctx, { [SEARCH_KEY]: OPENAI.good });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("nicht wieder gestartet");
    expect(result.message).not.toContain("aktiv.");
    expect(local.trail().filter(t => t === "supabase stop").length).toBeGreaterThanOrEqual(2);
    expect(await readRecord(ctx)).toBeNull();
  });

  test("Edge Runtime in config.toml aus: Hinweis, nichts geändert", async () => {
    const { ctx } = await localCtx();
    const config = join(ctx.root, "supabase", "config.toml");
    await writeFile(config, (await readFile(config, "utf8")).replace("[edge_runtime]\nenabled = true", "[edge_runtime]\nenabled = false"));
    const { result } = await run(ctx, { [SEARCH_KEY]: OPENAI.good });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("die Edge Runtime ausgeschaltet");
    expect(await envText(ctx)).toBe(LOCAL_ENV);
  });

  test("Edge Runtime aus und kein Schlüssel (weder eingegeben noch in der .env): ok, nur Textsuche", async () => {
    const { ctx, fake, local } = await localCtx();
    const config = join(ctx.root, "supabase", "config.toml");
    await writeFile(config, (await readFile(config, "utf8")).replace("[edge_runtime]\nenabled = true", "[edge_runtime]\nenabled = false"));
    const { result } = await run(ctx, {});
    expect(result).toEqual({ ok: true, message: TEXT_ONLY, changed: [] });
    expect(fake.sent).toEqual([]);
    expect(local.trail()).toEqual([]);
    expect(await envText(ctx)).toBe(LOCAL_ENV);
  });

  const marker = (ctx: SetupContext) => stat(restartMarkerPath(ctx.root)).then(() => true, () => false);

  test("Wiederholung nach Abbruch vor dem Neustart: der nächste Lauf startet neu, obwohl der Schlüssel schon in der Datei steht", async () => {
    const { ctx, fake, local } = await localCtx();
    const controller = new AbortController();
    // Abbruch nach dem Eintragen, vor dem Neustart
    const first = await runSemanticSearch({ [SEARCH_KEY]: OPENAI.good }, ctx, e => e.at === 3 && controller.abort(), controller.signal);
    expect(first.ok).toBe(false);
    expect(first.message).toContain("erst nach einem Neustart");
    expect(await readFile(functionsEnvPath(ctx.root), "utf8")).toContain(`OPENAI_API_KEY=${OPENAI.good}`);
    expect(local.trail()).not.toContain("supabase stop");
    expect(fake.project.runtimeKey()).toBeUndefined();
    expect(await marker(ctx)).toBe(true);

    // Derselbe Schlüssel noch einmal: Datei gleich, Neustart trotzdem
    const again = await run(ctx, { [SEARCH_KEY]: OPENAI.good });
    expect(again.result.ok).toBe(true);
    expect(again.result.message).toContain("Supabase neu gestartet");
    expect(again.result.message).toContain("Semantische Suche: aktiv");
    expect(local.trail()).toContain("supabase stop");
    expect(fake.project.runtimeKey()).toBe(OPENAI.good);
    expect(await marker(ctx)).toBe(false);
    // Danach wieder ohne Neustart
    local.run.calls.length = 0;
    const third = await run(ctx, { [SEARCH_KEY]: OPENAI.good });
    expect(third.result.message).toContain("hatte den Schlüssel schon");
    expect(local.trail()).not.toContain("supabase stop");
  });

  test("Wiederholung nach Abbruch, diesmal ohne Eingabe: Schlüssel aus der .env, Neustart nachgeholt", async () => {
    const { ctx, fake, local } = await localCtx();
    const controller = new AbortController();
    await runSemanticSearch({ [SEARCH_KEY]: OPENAI.good }, ctx, e => e.at === 3 && controller.abort(), controller.signal);
    expect(await marker(ctx)).toBe(true);
    const again = await run(ctx, {});
    expect(again.result.ok).toBe(true);
    expect(local.trail()).toContain("supabase stop");
    expect(fake.project.runtimeKey()).toBe(OPENAI.good);
    expect(await marker(ctx)).toBe(false);
  });

  test("Wiederholung nach fehlgeschlagenem Schreiben der Bot-.env: Hinweis, dann Neustart im nächsten Lauf", async () => {
    const { ctx, fake, local } = await localCtx();
    ctx.envIo = {
      rename: async (from, to) => {
        if (to === ctx.envPath) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        await rename(from, to);
      },
    };
    const first = await run(ctx, { [SEARCH_KEY]: OPENAI.good });
    expect(first.result.ok).toBe(false);
    expect(first.result.message).toContain(".env konnte nicht geschrieben werden");
    expect(first.result.message).toContain("startet Supabase dann neu");
    expect(await readFile(functionsEnvPath(ctx.root), "utf8")).toContain(`OPENAI_API_KEY=${OPENAI.good}`);
    expect(local.trail()).not.toContain("supabase stop");
    expect(await marker(ctx)).toBe(true);

    ctx.envIo = undefined;
    const again = await run(ctx, { [SEARCH_KEY]: OPENAI.good });
    expect(again.result.ok).toBe(true);
    expect(again.result.message).toContain("Semantische Suche: aktiv");
    expect(local.trail()).toContain("supabase stop");
    expect(fake.project.runtimeKey()).toBe(OPENAI.good);
    expect(await envText(ctx)).toContain(`OPENAI_API_KEY=${OPENAI.good}`);
    expect(await marker(ctx)).toBe(false);
  });

  test("Neustart scheitert: Merker bleibt, der nächste Lauf versucht es wieder", async () => {
    const { ctx, local } = await localCtx();
    local.lan = [54421];
    const first = await run(ctx, { [SEARCH_KEY]: OPENAI.good });
    expect(first.result.ok).toBe(false);
    expect(await marker(ctx)).toBe(true);
    local.lan = [];
    local.run.calls.length = 0;
    const again = await run(ctx, { [SEARCH_KEY]: OPENAI.good });
    expect(again.result.ok).toBe(true);
    expect(local.trail()).toContain("supabase start");
    expect(await marker(ctx)).toBe(false);
  });

  test("Stopp gelingt, Start scheitert, Datenbank aus: der nächste Lauf startet zuerst, prüft dann die Anbieterkennung", async () => {
    const { ctx, fake, local } = await localCtx();
    // Die REST-Schnittstelle antwortet nur, solange die Datenbank läuft
    const inner = ctx.fetch!;
    let restCalls = 0;
    ctx.fetch = async (url, request) => {
      if (new URL(url).host === "127.0.0.1:54421") {
        restCalls++;
        if (!local.containers.some(c => c.startsWith("supabase_db_tybo"))) throw new TypeError("Unable to connect");
      }
      return inner(url, request);
    };
    const start = local.answers["supabase start"];
    local.answers["supabase start"] = { code: 1, stderr: "failed to start" };
    const first = await run(ctx, { [SEARCH_KEY]: OPENAI.good });
    expect(first.result.ok).toBe(false);
    expect(first.result.message).toContain("nicht wieder gestartet");
    expect(local.containers).toEqual([]);
    expect(await marker(ctx)).toBe(true);

    local.answers["supabase start"] = start;
    local.run.calls.length = 0;
    restCalls = 0;
    const again = await run(ctx, { [SEARCH_KEY]: OPENAI.good });
    expect(again.result.ok).toBe(true);
    expect(again.result.message).toContain("Supabase neu gestartet");
    expect(again.result.message).toContain("Semantische Suche: aktiv");
    expect(local.trail()).toContain("supabase start");
    expect(restCalls).toBeGreaterThan(0);
    expect(fake.project.runtimeKey()).toBe(OPENAI.good);
    expect(await marker(ctx)).toBe(false);
  });
});

describe("Supabase selbst eingetragen (etwa eigener Server)", () => {
  test("nicht als lokaler Stack behandelt: kein Docker, kein Ausliefern, Hinweis zum Selbermachen", async () => {
    const local = fakeLocal();
    const fake = searchFake();
    const { ctx } = await searchCtx(SELF_ENV, fake, { run: local.run as any, localSupabase: local.deps });
    const { result } = await run(ctx, { [SEARCH_KEY]: OPENAI.good });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("richtet tybo die Functions nicht ein");
    expect(local.trail()).toEqual([]);
    expect(fake.api.calls).toEqual([]);
    expect(await envText(ctx)).toContain(`OPENAI_API_KEY=${OPENAI.good}`);
    // Ein eigener Server auf 127.0.0.1 mit anderem Port ist ebenfalls nicht der lokale Stack
    const other = `${BASE}SUPABASE_URL=http://127.0.0.1:8000\nSUPABASE_SERVICE_ROLE_KEY=${SB.secret}\n`;
    const second = await searchCtx(other, searchFake(), { run: local.run as any });
    expect((await existingFieldValues(searchStep, second.ctx)).DB_BACKEND).toBe("supabase");
  });

  test("dort schon eingerichtet: Nachweis besteht", async () => {
    const fake = searchFake({ project: { deployed: new Set(EDGE_FUNCTIONS), runtimeKey: () => OPENAI.good } });
    const { ctx } = await searchCtx(SELF_ENV, fake);
    const { result } = await run(ctx, { [SEARCH_KEY]: OPENAI.good });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Semantische Suche: aktiv");
  });
});

// ---------------------------------------------------------------------------
// Checkbox 3: Nachweis (speichern, finden, löschen) und Anzeige
// ---------------------------------------------------------------------------

describe("Nachweis: Probe speichern, finden, löschen", () => {
  async function ready(project: Parameters<typeof searchFake>[0]["project"] = {}) {
    const fake = searchFake({ project: { deployed: new Set(EDGE_FUNCTIONS), runtimeKey: () => OPENAI.good, ...project } });
    const { ctx } = await searchCtx(CLOUD_ENV, fake);
    return { ctx, fake };
  }

  test("aktiv nur mit genau der eigenen Probe und similarity > 0; Probe danach weg", async () => {
    const { ctx, fake } = await ready();
    // Fremde Zeile im selben Projekt bleibt unberührt
    fake.project.rows.push({ chat_id: "12345", role: "user", content: "echte Nachricht", embedded: true });
    const p = await probeSearch(CLOUD_URL, SB.secret, ctx, never, LEGACY_CONFIG);
    expect(p).toMatchObject({ state: "aktiv", cleaned: true });
    expect(fake.project.rows).toEqual([{ chat_id: "12345", role: "user", content: "echte Nachricht", embedded: true }]);
    const store = fake.sent.find(s => s.url.endsWith("/functions/v1/store-telegram-message"))!;
    const body = JSON.parse(store.body as string);
    expect(body.chat_id.startsWith(PROBE_PREFIX)).toBe(true);
    expect(body.content).toContain(body.chat_id.slice(PROBE_PREFIX.length));
  });

  test("ohne Embedding (Textsuche): „textsuche“, nicht aktiv; Probe gelöscht", async () => {
    const { ctx, fake } = await ready({ runtimeKey: () => undefined });
    const p = await probeSearch(CLOUD_URL, SB.secret, ctx, never, LEGACY_CONFIG);
    expect(p).toMatchObject({ state: "textsuche", cleaned: true });
    expect(fake.project.rows).toEqual([]);
  });

  test("HTTP 200 mit ok:false zählt als Fehler; aufgeräumt wird trotzdem", async () => {
    const { ctx, fake } = await ready({ storeNotOk: true });
    const p = await probeSearch(CLOUD_URL, SB.secret, ctx, never, LEGACY_CONFIG);
    expect(p.state).toBe("fehler");
    expect(p.message).toContain("nicht gespeichert");
    expect(fake.sent.some(s => s.method === "DELETE" && s.url.includes("chat_id=eq.tybo-probe-"))).toBe(true);
  });

  test("Function fehlt (404): verständliche Meldung, Aufräumversuch", async () => {
    const { ctx, fake } = await ready({ deployed: new Set() });
    const p = await probeSearch(CLOUD_URL, SB.secret, ctx, never, LEGACY_CONFIG);
    expect(p.state).toBe("fehler");
    expect(p.message).toContain("store-telegram-message fehlt");
    expect(fake.sent.filter(s => s.method === "DELETE").length).toBe(2);
  });

  test("Abbruch mitten im Test: Probe wird trotzdem gelöscht", async () => {
    const controller = new AbortController();
    const { ctx, fake } = await ready({ onSearch: () => controller.abort() });
    // Abbruch, während search-memory läuft; die Attrappe antwortet dann nicht mehr
    const p = await probeSearch(CLOUD_URL, SB.secret, ctx, controller.signal, LEGACY_CONFIG);
    expect(p.state).toBe("abgebrochen");
    expect(p.cleaned).toBe(true);
    expect(fake.project.rows).toEqual([]);
  });

  test("Zeitlimit (Function hängt): Fehler, Aufräumen mit eigener Frist", async () => {
    const { ctx, fake } = await ready();
    fake.project.rows.push({ chat_id: `${PROBE_PREFIX}alt`, role: "user", content: "Rest", embedded: true });
    const timeout = new AbortController();
    const hanging = { ...ctx, fetch: async (u: string, r: any = {}) => {
      if (u.includes("/functions/v1/")) {
        setTimeout(() => timeout.abort(), 5);
        return fake.fetch(u, { ...r, signal: timeout.signal });
      }
      return fake.fetch(u, r);
    } } as SetupContext;
    fake.project.hangFunctions = true;
    const p = await probeSearch(CLOUD_URL, SB.secret, hanging, never, LEGACY_CONFIG);
    expect(p.state).toBe("fehler");
    expect(p.message).toContain("antwortet nicht");
    expect(p.cleaned).toBe(true);
    const deletes = fake.sent.filter(s => s.method === "DELETE").map(s => decodeURIComponent(s.url.split("?")[1]));
    expect(deletes[0]).toBe(`chat_id=like.${PROBE_PREFIX}*`);
    expect(deletes[1].startsWith(`chat_id=eq.${PROBE_PREFIX}`)).toBe(true);
    // Reste früherer Läufe sind weg
    expect(fake.project.rows).toEqual([]);
  });

  /** fetch, dessen Anfragen an Functions nach kurzer Zeit abbrechen (wie das Zeitlimit) */
  function timingOut(ctx: SetupContext, fake: SearchFake, clock?: { ms: number }): SetupContext {
    return {
      ...ctx,
      fetch: async (u: string, r: any = {}) => {
        if (!u.includes("/functions/v1/")) return fake.fetch(u, r);
        const timeout = new AbortController();
        setTimeout(() => timeout.abort(), 5);
        return fake.fetch(u, { ...r, signal: timeout.signal });
      },
      ...(clock ? { now: () => new Date(clock.ms), sleep: async (ms: number) => void (clock.ms += ms) } : {}),
    } as SetupContext;
  }

  test("Zeitlimit beim Speichern, Function speichert erst nach dem ersten Löschen: wird nachgeräumt", async () => {
    const { ctx, fake } = await ready({ storeAfterDeletes: 1 });
    const p = await probeSearch(CLOUD_URL, SB.secret, timingOut(ctx, fake), never, LEGACY_CONFIG);
    expect(p.state).toBe("fehler");
    expect(p.cleaned).toBe(true);
    expect(fake.project.rows).toEqual([]);
    // Erstes Löschen fand nichts, das nächste die verspätete Probe; danach Schluss
    expect(fake.project.eqDeletes).toBe(2);
  });

  test("Gateway antwortet 504, die Function speichert erst nach dem ersten Löschen: nachgeräumt, kein voreiliges cleaned", async () => {
    const { ctx, fake } = await ready({ storeAfterDeletes: 1, storeGatewayStatus: 504 });
    const clock = { ms: Date.parse("2026-09-25T10:00:00Z") };
    const p = await probeSearch(CLOUD_URL, SB.secret, { ...ctx, now: () => new Date(clock.ms), sleep: async (ms: number) => void (clock.ms += ms) } as SetupContext, never, LEGACY_CONFIG);
    expect(p.state).toBe("fehler");
    expect(p.message).toContain("HTTP 504");
    // Das erste Löschen fand nichts; erst das zweite traf die verspätete Probe
    expect(fake.project.eqDeletes).toBe(2);
    expect(fake.project.rows).toEqual([]);
    expect(p.cleaned).toBe(true);
    expect(clock.ms - Date.parse("2026-09-25T10:00:00Z")).toBe(RECHECK_MS);
  });

  test("4xx beendet die Function sicher, 5xx und 408 nicht", () => {
    for (const s of [200, 201, 400, 401, 404, 429]) expect(storeSettled(s)).toBe(true);
    for (const s of [408, 500, 502, 503, 504]) expect(storeSettled(s)).toBe(false);
  });

  test("verspätetes Speichern erst nach mehreren Löschrunden: Nachräumen, bis die Probe weg ist", async () => {
    const { ctx, fake } = await ready({ storeAfterDeletes: 4 });
    const clock = { ms: Date.parse("2026-09-25T10:00:00Z") };
    const p = await probeSearch(CLOUD_URL, SB.secret, timingOut(ctx, fake, clock), never, LEGACY_CONFIG);
    expect(p.cleaned).toBe(true);
    expect(fake.project.rows).toEqual([]);
    expect(fake.project.eqDeletes).toBe(5);
    expect(clock.ms - Date.parse("2026-09-25T10:00:00Z")).toBe(4 * RECHECK_MS);
  });

  test("Abbruch während des Speicherns, Probe kommt später: ebenfalls nachgeräumt", async () => {
    const controller = new AbortController();
    const { ctx, fake } = await ready({ storeAfterDeletes: 2 });
    const aborting = { ...ctx, fetch: async (u: string, r: any = {}) => {
      if (u.includes("store-telegram-message")) setTimeout(() => controller.abort(), 5);
      return fake.fetch(u, r);
    } } as SetupContext;
    const p = await probeSearch(CLOUD_URL, SB.secret, aborting, controller.signal, LEGACY_CONFIG);
    expect(p.state).toBe("abgebrochen");
    expect(p.cleaned).toBe(true);
    expect(fake.project.rows).toEqual([]);
  });

  test("ungewiss und nie gespeichert: Nachräumen bis zum Ende des Fensters, dann Schluss", async () => {
    // Die Function speichert nie (Anfrage kam nicht an)
    const { ctx, fake } = await ready({ storeAfterDeletes: 1_000_000 });
    const start = Date.parse("2026-09-25T10:00:00Z");
    const clock = { ms: start };
    const p = await probeSearch(CLOUD_URL, SB.secret, timingOut(ctx, fake, clock), never, LEGACY_CONFIG);
    expect(p.cleaned).toBe(true);
    expect(clock.ms - start).toBeGreaterThanOrEqual(UNCERTAIN_WINDOW_MS);
    expect(clock.ms - start).toBeLessThan(UNCERTAIN_WINDOW_MS + 2 * RECHECK_MS);
  });

  test("Löschen scheitert: ausdrücklich gemeldet, mit Weg zur Wiederholung; Ablauf nicht ok", async () => {
    const fake = searchFake({ project: { failDelete: true } });
    const { ctx } = await searchCtx(CLOUD_ENV, fake);
    const { result } = await run(ctx, { [SEARCH_KEY]: OPENAI.good, SUPABASE_SETUP_TOKEN: SB.token });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Die Probe ließ sich nicht löschen");
    expect(result.message).toContain("tybo setup suche");
    expect(result.message).toContain(`like '${PROBE_PREFIX}%'`);
  });

  test("der nächste Lauf räumt übrig gebliebene Proben weg", async () => {
    const fake = searchFake({ project: { failDelete: true } });
    const { ctx } = await searchCtx(CLOUD_ENV, fake);
    await run(ctx, { [SEARCH_KEY]: OPENAI.good, SUPABASE_SETUP_TOKEN: SB.token });
    expect(fake.project.rows.length).toBe(1);
    fake.project.failDelete = false;
    await run(ctx, { [SEARCH_KEY]: OPENAI.good, SUPABASE_SETUP_TOKEN: SB.token });
    expect(fake.project.rows).toEqual([]);
  });

  test("Supabase nicht erreichbar: Fehler statt aktiv, Ergebnis nicht überschrieben", async () => {
    const { ctx } = await ready();
    await writeRecord(ctx, CLOUD_URL, "aktiv");
    const offline = { ...ctx, fetch: async () => { throw new Error("offline"); } } as SetupContext;
    const r = await searchStep.test!({}, offline);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("nicht prüfbar");
    expect((await readRecord(ctx))?.state).toBe("aktiv");
  });
});

describe("Anzeige: Übersicht und Gesamtprüfung", () => {
  test("Status: „nur Textsuche“ ohne Nachweis, „aktiv“ nur nach Nachweis für genau diese Adresse", async () => {
    const { ctx } = await searchCtx(`${CLOUD_ENV}OPENAI_API_KEY=${OPENAI.good}\n`);
    // Schlüssel gesetzt heißt noch nicht aktiv
    let s = await searchStep.status(ctx);
    expect(s.state).toBe("fehlt");
    expect(s.detail).toContain("Semantische Suche: nur Textsuche");
    await writeRecord(ctx, CLOUD_URL, "aktiv");
    s = await searchStep.status(ctx);
    expect(s.state).toBe("erledigt");
    expect(s.detail).toBe("Semantische Suche: aktiv mit OpenAI (text-embedding-3-small) (zuletzt nachgewiesen am 25.09.2026).");
    // Nachweis für eine andere Datenbank zählt nicht
    await writeRecord(ctx, "https://zyxwvutsrqponmlkjihg.supabase.co", "aktiv");
    expect((await searchStep.status(ctx)).state).toBe("fehlt");
    expect(s.fields).toEqual(SEARCH_FIELDS.map(f => ({ name: f.name, set: false })));
  });

  test("Gesamtprüfung: Zeile „Semantische Suche“, wiederholt den Nachweis und aktualisiert das Ergebnis", async () => {
    const fake = searchFake({ project: { deployed: new Set(EDGE_FUNCTIONS), runtimeKey: () => OPENAI.good } });
    const { ctx } = await searchCtx(CLOUD_ENV, fake);
    await writeRecord(ctx, CLOUD_URL, "aktiv");
    const summary = await checkStep.status(ctx);
    expect(summary.items?.find(i => i.label === "Semantische Suche")).toMatchObject({ ok: true, detail: expect.stringContaining("aktiv") });
    const result = await checkStep.test!({}, ctx);
    expect(result.items?.find(i => i.label === "Semantische Suche")).toMatchObject({ ok: true, detail: expect.stringContaining("Semantische Suche: aktiv") });
    // Functions verlieren den Schlüssel: die nächste Prüfung meldet nur Textsuche
    fake.project.runtimeKey = () => undefined;
    const again = await checkStep.test!({}, ctx);
    expect(again.items?.find(i => i.label === "Semantische Suche")).toMatchObject({ ok: false, detail: expect.stringContaining("nur Textsuche") });
    expect((await readRecord(ctx))?.state).toBe("textsuche");
    expect((await searchStep.status(ctx)).detail).toContain("nur Textsuche (Test vom 25.09.2026)");
  });

  test("Ergebnisdatei: nur Zustand, Zeit, Hash, Anbieter und Modell; Rechte 0600", async () => {
    const { ctx } = await searchCtx(CLOUD_ENV);
    await mkdir(join(ctx.root, "data"), { recursive: true });
    await writeRecord(ctx, CLOUD_URL, "aktiv");
    const text = await readFile(recordPath(ctx), "utf8");
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["checkedAt", "model", "provider", "state", "target"]);
    expect(JSON.parse(text)).toMatchObject({ provider: "openai", model: "text-embedding-3-small" });
    expect(text).not.toContain(SB.ref);
    expect((await stat(recordPath(ctx))).mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// Issue #167: Anbieter wählbar (OpenAI, Gemini, Ollama)
// ---------------------------------------------------------------------------

describe("Anbieterwahl (#167)", () => {
  async function localOllamaCtx(options: { ollama?: Partial<SearchFake["ollama"]>; env?: string } = {}) {
    const local: FakeLocal = fakeLocal();
    local.containers = [...SAFE_CONTAINERS, "supabase_edge_runtime_tybo\t"];
    const fake = searchFake({ project: { serviceKeys: [LOCAL.secret], deployed: new Set(EDGE_FUNCTIONS) }, ollama: options.ollama });
    const { ctx } = await searchCtx(`${LOCAL_ENV}${options.env ?? ""}`, fake, { run: local.run as any, localSupabase: local.deps });
    const runtime = localRuntime(functionsEnvPath(ctx.root));
    fake.project.runtimeKey = runtime.key;
    fake.project.runtimeEnv = runtime.env;
    await runtime.start();
    local.answers["supabase start"] = async () => {
      await runtime.start();
      return { stdout: "Started" };
    };
    return { ctx, fake, local };
  }

  const ollamaCalls = (fake: SearchFake) => fake.sent.filter(s => s.url.startsWith("http://localhost:11434/"));

  describe("Felder und Plan", () => {
    test("Auswahl mit einem sachlichen Satz je Anbieter, Standard OpenAI; Felder je Anbieter", async () => {
      const provider = SEARCH_FIELDS.find(f => f.name === "EMBEDDING_PROVIDER")!;
      expect(provider.kind).toBe("choice");
      expect(provider.default).toBe("openai");
      expect(provider.choices?.map(c => c.value)).toEqual(["openai", "gemini", "ollama"]);
      expect(provider.choices?.map(c => c.label).join(" ")).not.toContain("beste");
      expect(fieldDefinitionProblems(SEARCH_FIELDS)).toEqual([]);
      const visible = (values: Record<string, string>) => SEARCH_FIELDS.filter(f => !f.visible || f.visible(values)).map(f => f.name);
      expect(visible({ DB_BACKEND: "supabase-cloud", EMBEDDING_PROVIDER: "gemini" })).toEqual(["EMBEDDING_PROVIDER", "SEARCH_GEMINI_KEY", "SUPABASE_SETUP_TOKEN", REINDEX_FIELD]);
      expect(visible({ DB_BACKEND: "supabase-lokal", EMBEDDING_PROVIDER: "ollama" })).toEqual(["EMBEDDING_PROVIDER", "OLLAMA_URL", "SEARCH_OLLAMA_PULL", REINDEX_FIELD]);
      // Ollama in der Cloud: kein Token-Feld, der Plan erklärt die Ablehnung
      expect(visible({ DB_BACKEND: "supabase-cloud", EMBEDDING_PROVIDER: "ollama" })).toEqual(["EMBEDDING_PROVIDER", "OLLAMA_URL", "SEARCH_OLLAMA_PULL"]);
      expect(searchStep.plan!({ DB_BACKEND: "supabase-cloud", EMBEDDING_PROVIDER: "ollama" }).join(" ")).toContain("erreichen es nicht");
      expect(searchStep.plan!({ DB_BACKEND: "supabase-lokal", EMBEDDING_PROVIDER: "ollama" }).join(" ")).toContain("host.docker.internal");
      expect(searchStep.plan!({ DB_BACKEND: "supabase-lokal", EMBEDDING_PROVIDER: "ollama" }).join(" ")).toContain("nur nach deiner Zustimmung");
      // Gemini-Schlüssel und Rückfrage gelten nur für diesen Lauf
      expect(isTransientName("SEARCH_GEMINI_KEY")).toBe(true);
      expect(isTransientName("SEARCH_OLLAMA_PULL")).toBe(true);
    });
  });

  describe("Gemini", () => {
    test("Cloud: Schlüssel prüfen, Geheimnisse samt Anbieter und Modell, .env, Nachweis mit Anbieter", async () => {
      const { ctx, fake } = await searchCtx(CLOUD_ENV);
      const { result, events } = await run(ctx, { EMBEDDING_PROVIDER: "gemini", SEARCH_GEMINI_KEY: GEMINI.good, SUPABASE_SETUP_TOKEN: SB.token });
      expect(result.ok).toBe(true);
      expect(result.message).toContain("Semantische Suche: aktiv (Google Gemini (gemini-embedding-2))");
      expect(fake.secrets[SB.ref]).toEqual({ EMBEDDING_PROVIDER: "gemini", EMBEDDING_MODEL: "gemini-embedding-2", GEMINI_API_KEY: GEMINI.good });
      const env = await envText(ctx);
      expect(env).toContain("EMBEDDING_PROVIDER=gemini");
      expect(env).toContain("EMBEDDING_MODEL=gemini-embedding-2");
      expect(env).toContain(`GEMINI_API_KEY=${GEMINI.good}`);
      expect(env).not.toContain("OPENAI_API_KEY");
      expect(result.changed.sort()).toEqual(["EMBEDDING_MODEL", "EMBEDDING_PROVIDER", "GEMINI_API_KEY"]);
      // Die Datenbank hält Gemini fest; der Nachweis gilt genau dafür
      expect(fake.project.registry).toEqual({ provider: "gemini", model: "gemini-embedding-2" });
      expect(await readRecord(ctx)).toMatchObject({ state: "aktiv", provider: "gemini", model: "gemini-embedding-2" });
      expect((await searchStep.status(ctx)).state).toBe("erledigt");
      // Die Prüfanfrage verlangt 1536 Werte, der Schlüssel steht nie in der Adresse
      const google = fake.sent.filter(s => s.url.startsWith("https://generativelanguage.googleapis.com/"));
      expect(google).toHaveLength(1);
      expect(JSON.parse(String(google[0].body)).outputDimensionality).toBe(1536);
      expect(google[0].url.includes(GEMINI.good)).toBe(false);
      expect(JSON.stringify(events).includes(GEMINI.good)).toBe(false);
      expect(result.message.includes(GEMINI.good)).toBe(false);
    });

    test("abgelehnter Schlüssel: feste Meldung ohne Antworttext, bei Supabase nichts geändert", async () => {
      const { ctx, fake } = await searchCtx(CLOUD_ENV);
      const { result } = await run(ctx, { EMBEDDING_PROVIDER: "gemini", SEARCH_GEMINI_KEY: GEMINI.bad, SUPABASE_SETUP_TOKEN: SB.token });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Google lehnt den Gemini-Schlüssel ab");
      expect(result.message.includes(GEMINI.bad)).toBe(false);
      expect(result.message).not.toContain("API key not valid");
      expect(fake.deploys).toEqual([]);
      expect(await envText(ctx)).toBe(CLOUD_ENV);
    });

    test("ohne Gemini-Schlüssel: nur Textsuche, nichts angefragt", async () => {
      const { ctx, fake } = await searchCtx(CLOUD_ENV);
      const { result } = await run(ctx, { EMBEDDING_PROVIDER: "gemini" });
      expect(result).toMatchObject({ ok: true, changed: [] });
      expect(result.message).toContain("Ohne Gemini-Schlüssel");
      expect(fake.sent).toEqual([]);
    });

    test("selbst eingetragenes Supabase: nur OpenAI, Gemini wird mit Erklärung abgelehnt", async () => {
      const { ctx, fake } = await searchCtx(SELF_ENV);
      const { result } = await run(ctx, { EMBEDDING_PROVIDER: "gemini", SEARCH_GEMINI_KEY: GEMINI.good });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("nur OpenAI");
      expect(fake.sent).toEqual([]);
      expect(await envText(ctx)).toBe(SELF_ENV);
    });

    test("Browser: Felder für Gemini, Ablauf; Schlüssel und Token in keiner Antwort und keinem Log", async () => {
      const { ctx, fake } = await searchCtx(CLOUD_ENV);
      const s = await startSetup({ ctx });
      running.push(s);
      const cookie = await login(s);
      const view = await post(s, "/api/setup/steps/suche/view", { values: { EMBEDDING_PROVIDER: "gemini" } }, cookie);
      const viewText = await view.text();
      const fields = JSON.parse(viewText).fields.filter((f: any) => f.visible).map((f: any) => f.name);
      expect(fields).toEqual(["EMBEDDING_PROVIDER", "SEARCH_GEMINI_KEY", "SUPABASE_SETUP_TOKEN", REINDEX_FIELD]);
      const started = await post(s, "/api/setup/steps/suche/run", { values: { EMBEDDING_PROVIDER: "gemini", SEARCH_GEMINI_KEY: GEMINI.good, SUPABASE_SETUP_TOKEN: SB.token } }, cookie);
      expect(started.status).toBe(202);
      const { runId } = await started.json();
      let done: any;
      for (let i = 0; i < 400; i++) {
        const text = await (await get(s, `/api/setup/runs/${runId}`, cookie)).text();
        expect(text.includes(GEMINI.good)).toBe(false);
        done = JSON.parse(text);
        if (done.state !== "laeuft") break;
        await Bun.sleep(5);
      }
      expect(done.state).toBe("fertig");
      expect(done.result.message).toContain("Semantische Suche: aktiv (Google Gemini");
      expect(s.logs.join("\n").includes(GEMINI.good)).toBe(false);
      expect(s.logs.join("\n").includes(SB.token)).toBe(false);
      expect(fake.secrets[SB.ref].EMBEDDING_PROVIDER).toBe("gemini");
    });
  });

  describe("Ollama", () => {
    test("Cloud: abgelehnt mit Erklärung, nichts angefragt, nichts geschrieben", async () => {
      const { ctx, fake } = await searchCtx(CLOUD_ENV);
      const { result } = await run(ctx, { EMBEDDING_PROVIDER: "ollama", OLLAMA_URL: "http://localhost:11434", SUPABASE_SETUP_TOKEN: SB.token });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("erreichen es nicht");
      expect(result.message).toContain("Nichts wurde geändert");
      expect(fake.sent).toEqual([]);
      expect(await envText(ctx)).toBe(CLOUD_ENV);
    });

    test("lokal: Modell da, Functions bekommen die Docker-Adresse, Neustart, Nachweis; Texte bleiben auf dem Rechner", async () => {
      const { ctx, fake, local } = await localOllamaCtx();
      const { result } = await run(ctx, { EMBEDDING_PROVIDER: "ollama", OLLAMA_URL: "http://localhost:11434" });
      expect(result.ok).toBe(true);
      expect(result.message).toContain("Semantische Suche: aktiv (Ollama (bge-m3))");
      const fnEnv = await readFile(functionsEnvPath(ctx.root), "utf8");
      expect(fnEnv).toContain("EMBEDDING_PROVIDER=ollama");
      expect(fnEnv).toContain("EMBEDDING_MODEL=bge-m3");
      expect(fnEnv).toContain("OLLAMA_URL=http://host.docker.internal:11434");
      const env = await envText(ctx);
      expect(env).toContain("EMBEDDING_PROVIDER=ollama");
      expect(env).toContain("EMBEDDING_MODEL=bge-m3");
      // Standardadresse: nicht eigens in die .env des Bots
      expect(env).not.toContain("OLLAMA_URL");
      expect(local.trail()).toContain("supabase start");
      expect(fake.ollama.pulls).toEqual([]);
      // Kein Aufruf an OpenAI oder Google
      expect(fake.sent.some(s => /openai\.com|googleapis\.com/.test(s.url))).toBe(false);
      expect(fake.project.registry).toEqual({ provider: "ollama", model: "bge-m3" });
    });

    test("Modell fehlt, Rückfrage abgelehnt: Abbruch mit Befehl, kein Download, nichts geschrieben", async () => {
      const { ctx, fake } = await localOllamaCtx({ ollama: { models: [] } });
      const { result } = await run(ctx, { EMBEDDING_PROVIDER: "ollama", OLLAMA_URL: "http://localhost:11434", SEARCH_OLLAMA_PULL: "false" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("ollama pull bge-m3");
      expect(fake.ollama.pulls).toEqual([]);
      expect(ollamaCalls(fake).map(s => new URL(s.url).pathname)).toEqual(["/api/tags"]);
      expect(await readFile(functionsEnvPath(ctx.root), "utf8").catch(() => "")).toBe("");
      expect(await envText(ctx)).toBe(LOCAL_ENV);
    });

    test("Modell fehlt, Rückfrage bestätigt: ollama pull, dann weiter bis zum Nachweis", async () => {
      const { ctx, fake } = await localOllamaCtx({ ollama: { models: [] } });
      const events: RunEvent[] = [];
      const result = await runSemanticSearch({ EMBEDDING_PROVIDER: "ollama", OLLAMA_URL: "http://localhost:11434", SEARCH_OLLAMA_PULL: "true" }, ctx, e => events.push(e), never);
      expect(result.ok).toBe(true);
      expect(fake.ollama.pulls).toEqual(["bge-m3"]);
      const pull = ollamaCalls(fake).find(s => s.url.endsWith("/api/pull"))!;
      expect(JSON.parse(String(pull.body))).toEqual({ model: "bge-m3", stream: false });
      expect(events.map(e => e.label)).toContain("Lade das Modell bge-m3 mit ollama pull (kann dauern)");
    });

    test("Ollama läuft nicht: klare Meldung, nichts geschrieben", async () => {
      const { ctx } = await localOllamaCtx({ ollama: { running: false } });
      const { result } = await run(ctx, { EMBEDDING_PROVIDER: "ollama", OLLAMA_URL: "http://localhost:11434" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Ollama läuft nicht unter http://localhost:11434");
      expect(await envText(ctx)).toBe(LOCAL_ENV);
    });

    test("Modell mit mehr als 1536 Werten: abgelehnt mit Zahl und Vorschlag", async () => {
      const { ctx } = await localOllamaCtx({ ollama: { models: ["grosses-modell:latest"], dims: 3072 }, env: "EMBEDDING_PROVIDER=ollama\nEMBEDDING_MODEL=grosses-modell\n" });
      const { result } = await run(ctx, { EMBEDDING_PROVIDER: "ollama", OLLAMA_URL: "http://localhost:11434" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("3072 Werte");
      expect(result.message).toContain("bge-m3");
    });

    test("Functions erreichen Ollama aus Docker nicht: Test scheitert mit Hinweis auf host.docker.internal", async () => {
      const { ctx, fake } = await localOllamaCtx({ ollama: { reachableFromDocker: false } });
      const { result } = await run(ctx, { EMBEDDING_PROVIDER: "ollama", OLLAMA_URL: "http://localhost:11434" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("erreichen den Anbieter nicht");
      expect(result.message).toContain("host.docker.internal");
      expect((await readRecord(ctx))?.state).toBe("textsuche");
      // Ohne gelungenes Embedding hält die Datenbank nichts fest: ein anderer Anbieter bleibt möglich
      expect(fake.project.registry).toBeNull();
    });

    test("Terminal: Ollama wählen, Download bestätigen (j), Einrichtung läuft durch", async () => {
      const { ctx, fake } = await localOllamaCtx({ ollama: { models: [] } });
      // Anbieter 3 (Ollama), Adresse (Enter: Vorschlag), Download j, Neuberechnung (Enter: Weiter), Bestätigung
      const prompter = scripted(["3", "", "j", "", ""]);
      const r = await runWith({ mode: "step", step: "suche" }, ctx, prompter);
      expect(prompter.left()).toBe(0);
      expect(r.out).toContain("Ollama: bge-m3 auf diesem Rechner");
      expect(r.out).toContain("Semantische Suche: aktiv (Ollama (bge-m3))");
      expect(fake.ollama.pulls).toEqual(["bge-m3"]);
      expect(r.code).toBe(0);
    });

    test("Terminal: Download abgelehnt (n): Abbruch mit Befehl, kein Download", async () => {
      const { ctx, fake } = await localOllamaCtx({ ollama: { models: [] } });
      const prompter = scripted(["3", "", "n", "", ""]);
      const r = await runWith({ mode: "step", step: "suche" }, ctx, prompter);
      expect(r.out).toContain("ollama pull bge-m3");
      expect(fake.ollama.pulls).toEqual([]);
    });

    test("Browser: Download bestätigt bzw. abgelehnt über die Ja/Nein-Frage", async () => {
      for (const [answer, pulled] of [["true", ["bge-m3"]], ["false", []]] as const) {
        const { ctx, fake } = await localOllamaCtx({ ollama: { models: [] } });
        const s = await startSetup({ ctx });
        running.push(s);
        const cookie = await login(s);
        const view = JSON.parse(await (await post(s, "/api/setup/steps/suche/view", { values: { EMBEDDING_PROVIDER: "ollama" } }, cookie)).text());
        const pull = view.fields.find((f: any) => f.name === "SEARCH_OLLAMA_PULL");
        expect(pull).toMatchObject({ kind: "yesno", visible: true });
        const started = await post(s, "/api/setup/steps/suche/run", { values: { EMBEDDING_PROVIDER: "ollama", SEARCH_OLLAMA_PULL: answer } }, cookie);
        expect(started.status).toBe(202);
        const { runId } = await started.json();
        let done: any;
        for (let i = 0; i < 400; i++) {
          done = JSON.parse(await (await get(s, `/api/setup/runs/${runId}`, cookie)).text());
          if (done.state !== "laeuft") break;
          await Bun.sleep(5);
        }
        expect(fake.ollama.pulls).toEqual([...pulled]);
        if (answer === "true") expect(done.result.message).toContain("Semantische Suche: aktiv");
        else expect(done.result.message).toContain("ollama pull bge-m3");
      }
    });
  });

  describe("Anbieterkennung der Datenbank", () => {
    test("Datenbank hält OpenAI fest, gewählt ist Gemini: Abbruch vor jeder Änderung", async () => {
      const fake = searchFake({ project: { registry: { provider: "openai", model: "text-embedding-3-small" } } });
      const { ctx } = await searchCtx(CLOUD_ENV, fake);
      const { result } = await run(ctx, { EMBEDDING_PROVIDER: "gemini", SEARCH_GEMINI_KEY: GEMINI.good, SUPABASE_SETUP_TOKEN: SB.token });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("festgelegt");
      expect(result.message).toContain("Nichts wurde geändert");
      expect(fake.deploys).toEqual([]);
      expect(fake.secrets[SB.ref]).toBeUndefined();
      expect(await envText(ctx)).toBe(CLOUD_ENV);
    });

    test("gleicher Anbieter, anderes Modell (EMBEDDING_MODEL in der .env): ebenfalls abgelehnt", async () => {
      const fake = searchFake({ project: { registry: { provider: "gemini", model: "gemini-embedding-2" } } });
      const { ctx } = await searchCtx(`${CLOUD_ENV}EMBEDDING_PROVIDER=gemini\nEMBEDDING_MODEL=gemini-embedding-001\n`, fake);
      const { result } = await run(ctx, { SEARCH_GEMINI_KEY: GEMINI.good, SUPABASE_SETUP_TOKEN: SB.token });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("gemini-embedding-001");
      expect(fake.deploys).toEqual([]);
    });

    test("Migration fehlt: OpenAI wie bisher geht, Gemini wird abgelehnt", async () => {
      const fake = searchFake({ project: { registryMissing: true } });
      const { ctx } = await searchCtx(CLOUD_ENV, fake);
      expect((await run(ctx, { EMBEDDING_PROVIDER: "gemini", SEARCH_GEMINI_KEY: GEMINI.good, SUPABASE_SETUP_TOKEN: SB.token })).result.message).toContain("embedding_settings");
      expect(fake.deploys).toEqual([]);
      const { result } = await run(ctx, { [SEARCH_KEY]: OPENAI.good, SUPABASE_SETUP_TOKEN: SB.token });
      expect(result.ok).toBe(true);
      // Ohne Wahl bleibt die .env wie vor #167: nur der Schlüssel
      expect(await envText(ctx)).toBe(`${CLOUD_ENV}OPENAI_API_KEY=${OPENAI.good}\n`);
      expect(fake.secrets[SB.ref]).toEqual({ OPENAI_API_KEY: OPENAI.good });
    });

    test("Nachweis gilt nur für Anbieter und Modell: nach Wechsel in der .env nicht mehr aktiv", async () => {
      const { ctx } = await searchCtx(CLOUD_ENV);
      await writeRecord(ctx, CLOUD_URL, "aktiv");
      expect((await searchStep.status(ctx)).state).toBe("erledigt");
      await writeFile(ctx.envPath, `${CLOUD_ENV}EMBEDDING_PROVIDER=gemini\n`);
      expect((await searchStep.status(ctx)).state).toBe("fehlt");
      // Ergebnisdateien von vor #167 ohne Anbieter gelten als OpenAI text-embedding-3-small
      await writeFile(ctx.envPath, CLOUD_ENV);
      await writeFile(recordPath(ctx), JSON.stringify({ state: "aktiv", checkedAt: "2026-09-25T10:00:00.000Z", target: (await readRecord(ctx))!.target }));
      expect((await searchStep.status(ctx)).state).toBe("erledigt");
    });

    test("Gesamtprüfung meldet eine Abweichung zwischen .env und Datenbank, ohne Probe", async () => {
      const fake = searchFake({ project: { deployed: new Set(EDGE_FUNCTIONS), runtimeKey: () => OPENAI.good, registry: { provider: "ollama", model: "bge-m3" } } });
      const { ctx } = await searchCtx(`${CLOUD_ENV}OPENAI_API_KEY=${OPENAI.good}\n`, fake);
      const result = await searchStep.test!({}, ctx);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Ollama (bge-m3)");
      expect(result.message.includes(OPENAI.good)).toBe(false);
      expect(fake.sent.some(s => s.url.includes("/functions/v1/"))).toBe(false);
    });

    test("Probe: Functions ohne Angabe von Anbieter und Modell (ältere Version) gelten nicht als aktiv", async () => {
      const fake = searchFake({ project: { deployed: new Set(EDGE_FUNCTIONS), runtimeKey: () => OPENAI.good, reportsProvider: false } });
      const { ctx } = await searchCtx(CLOUD_ENV, fake);
      const probe = await probeSearch(CLOUD_URL, SB.secret, ctx, never, LEGACY_CONFIG);
      expect(probe.state).toBe("fehler");
      expect(probe.message).toContain("meldet nicht, mit welchem Anbieter");
      expect(probe.cleaned).toBe(true);
    });

    test("Probe mit gesperrtem Anbieter in den Functions: Grund in der Meldung", async () => {
      const fake = searchFake({ project: { deployed: new Set(EDGE_FUNCTIONS), runtimeKey: () => OPENAI.good, registry: { provider: "gemini", model: "gemini-embedding-2" } } });
      const { ctx } = await searchCtx(CLOUD_ENV, fake);
      const probe = await probeSearch(CLOUD_URL, SB.secret, ctx, never, LEGACY_CONFIG);
      expect(probe.state).toBe("textsuche");
      expect(probe.message).toContain("passt nicht zur Anbieterkennung");
    });
  });

  // Prüfung zu #167: eine frühere Wahl bei den Functions darf keinen falschen Aktiv-Nachweis ergeben
  describe("Zurückgebliebene Einstellung der Functions", () => {
    const GEMINI_FN_ENV = `EMBEDDING_PROVIDER=gemini\nEMBEDDING_MODEL=gemini-embedding-2\nGEMINI_API_KEY=${GEMINI.good}\n`;

    async function localLeftover(fnEnv: string) {
      const { ctx, fake, local } = await localOllamaCtx();
      await writeFile(functionsEnvPath(ctx.root), fnEnv, { mode: 0o600 });
      // Die Edge Runtime läuft mit dieser Datei (Stand des früheren Laufs)
      await (local.answers["supabase start"] as () => Promise<unknown>)();
      return { ctx, fake, local };
    }

    test("lokal: .env ohne neue Variablen, leere Datenbank, Functions auf Gemini; gewählt OpenAI: angeglichen, Probe mit OpenAI", async () => {
      const { ctx, fake, local } = await localLeftover(GEMINI_FN_ENV);
      expect(fake.project.runtimeEnv!().EMBEDDING_PROVIDER).toBe("gemini");
      const { result } = await run(ctx, { [SEARCH_KEY]: OPENAI.good });
      expect(result.ok).toBe(true);
      expect(result.message).toContain("Semantische Suche: aktiv (OpenAI (text-embedding-3-small))");
      const fnEnv = await readFile(functionsEnvPath(ctx.root), "utf8");
      expect(fnEnv).toContain("EMBEDDING_PROVIDER=openai");
      expect(fnEnv).toContain("EMBEDDING_MODEL=text-embedding-3-small");
      expect(local.trail()).toContain("supabase stop");
      // Die Functions rechneten wirklich mit OpenAI: die Datenbank hält OpenAI fest
      expect(fake.project.registry).toEqual({ provider: "openai", model: "text-embedding-3-small" });
      expect(await readRecord(ctx)).toMatchObject({ state: "aktiv", provider: "openai", model: "text-embedding-3-small" });
      // Die .env des Bots bleibt wie vor #167: nur der Schlüssel
      expect(await envText(ctx)).toBe(`${LOCAL_ENV}OPENAI_API_KEY=${OPENAI.good}\n`);
    });

    test("lokal, Wiederanlauf nach Teilfehler: Gemini eingetragen, Neustart gescheitert; danach OpenAI gewählt", async () => {
      const { ctx, fake, local } = await localOllamaCtx();
      const restart = local.answers["supabase start"];
      local.answers["supabase start"] = { code: 1, stderr: "Docker antwortet nicht" };
      const first = await run(ctx, { EMBEDDING_PROVIDER: "gemini", SEARCH_GEMINI_KEY: GEMINI.good });
      expect(first.result.ok).toBe(false);
      expect(first.result.message).toContain("nicht wieder gestartet");
      expect(await readFile(functionsEnvPath(ctx.root), "utf8")).toContain("EMBEDDING_PROVIDER=gemini");
      expect(await readRecord(ctx)).toBeNull();
      // Der nächste Lauf: OpenAI ohne neue Variablen; die .env des Bots hat aber EMBEDDING_PROVIDER=gemini vom ersten Lauf
      local.answers["supabase start"] = restart;
      const second = await run(ctx, { EMBEDDING_PROVIDER: "openai", [SEARCH_KEY]: OPENAI.good });
      expect(second.result.ok).toBe(true);
      expect(second.result.message).toContain("Semantische Suche: aktiv (OpenAI (text-embedding-3-small))");
      const fnEnv = await readFile(functionsEnvPath(ctx.root), "utf8");
      expect(fnEnv).toContain("EMBEDDING_PROVIDER=openai");
      expect(fnEnv).toContain("EMBEDDING_MODEL=text-embedding-3-small");
      expect(fake.project.registry).toEqual({ provider: "openai", model: "text-embedding-3-small" });
      expect(await readRecord(ctx)).toMatchObject({ state: "aktiv", provider: "openai" });
    });

    test("lokal, nur die Functions-Datei hat noch Gemini (Bot-.env leer): Wiederanlauf gleicht an", async () => {
      const { ctx, fake, local } = await localOllamaCtx();
      await writeFile(functionsEnvPath(ctx.root), GEMINI_FN_ENV, { mode: 0o600 });
      // Neustart offen (Merker eines abgebrochenen Laufs), die Runtime kennt die Datei noch nicht
      await mkdir(join(ctx.root, "data"), { recursive: true });
      await writeFile(restartMarkerPath(ctx.root), "2026-09-27T10:00:00.000Z\n");
      const { result } = await run(ctx, { [SEARCH_KEY]: OPENAI.good });
      expect(result.ok).toBe(true);
      expect(await readFile(functionsEnvPath(ctx.root), "utf8")).toContain("EMBEDDING_PROVIDER=openai");
      expect(local.trail()).toContain("supabase start");
      expect(fake.project.registry).toEqual({ provider: "openai", model: "text-embedding-3-small" });
    });

    test("Cloud: Geheimnisse noch auf Gemini, gewählt OpenAI ohne neue Variablen: beide Einstellungen neu gesetzt, Probe mit OpenAI", async () => {
      const fake = searchFake();
      fake.secrets[SB.ref] = { EMBEDDING_PROVIDER: "gemini", EMBEDDING_MODEL: "gemini-embedding-2", GEMINI_API_KEY: GEMINI.good };
      const { ctx } = await searchCtx(CLOUD_ENV, fake);
      const { result } = await run(ctx, { [SEARCH_KEY]: OPENAI.good, SUPABASE_SETUP_TOKEN: SB.token });
      expect(result.ok).toBe(true);
      expect(result.message).toContain("Semantische Suche: aktiv (OpenAI (text-embedding-3-small))");
      expect(fake.secrets[SB.ref]).toMatchObject({ EMBEDDING_PROVIDER: "openai", EMBEDDING_MODEL: "text-embedding-3-small", OPENAI_API_KEY: OPENAI.good });
      expect(fake.project.registry).toEqual({ provider: "openai", model: "text-embedding-3-small" });
      expect(await readRecord(ctx)).toMatchObject({ state: "aktiv", provider: "openai" });
      expect(await envText(ctx)).toBe(`${CLOUD_ENV}OPENAI_API_KEY=${OPENAI.good}\n`);
    });

    test("Cloud ohne zurückgebliebene Einstellung: weiter nur der Schlüssel als Geheimnis (wie vor #167)", async () => {
      const { ctx, fake } = await searchCtx(CLOUD_ENV);
      expect((await run(ctx, { [SEARCH_KEY]: OPENAI.good, SUPABASE_SETUP_TOKEN: SB.token })).result.ok).toBe(true);
      expect(fake.secrets[SB.ref]).toEqual({ OPENAI_API_KEY: OPENAI.good });
    });

    test("Gesamtprüfung: .env OpenAI, Functions rechnen mit Gemini: kein Aktiv-Nachweis, Meldung nennt beide", async () => {
      const fake = searchFake({ project: { deployed: new Set(EDGE_FUNCTIONS), runtimeKey: () => OPENAI.good } });
      fake.secrets[SB.ref] = { EMBEDDING_PROVIDER: "gemini", EMBEDDING_MODEL: "gemini-embedding-2", GEMINI_API_KEY: GEMINI.good };
      const { ctx } = await searchCtx(`${CLOUD_ENV}OPENAI_API_KEY=${OPENAI.good}\n`, fake);
      const result = await searchStep.test!({}, ctx);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Google Gemini (gemini-embedding-2)");
      expect(result.message).toContain("OpenAI (text-embedding-3-small)");
      expect(result.message.includes(GEMINI.good) || result.message.includes(OPENAI.good)).toBe(false);
      expect(await readRecord(ctx)).toBeNull();
      expect((await searchStep.status(ctx)).state).toBe("fehlt");
      // Probe trotzdem weggeräumt
      expect(fake.project.rows).toEqual([]);
    });
  });
});
