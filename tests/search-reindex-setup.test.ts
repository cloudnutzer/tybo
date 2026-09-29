/**
 * Issue #168, Aufgabe 1: tybo setup suche erkennt einen Anbieterwechsel
 * (Anbieter oder Modell, auch Altbestand ohne Kennung), zählt, schätzt Dauer
 * und Kosten nachvollziehbar und fragt. Ablehnen ändert nichts; Zustimmen
 * reserviert den Lauf in der Datenbank vor jeder Änderung (belegt: nichts
 * ändert sich), richtet dann ein und startet die Neuberechnung im Hintergrund
 * mit demselben Inhaber. Alles gegen Attrappen (tests/search-fixture.ts).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SetupContext } from "../src/setup/context";
import { estimateReindex, estimateText, REINDEX_RESERVE_SECONDS, REINDEX_WRITE_DELAY_MS, type TableCounts } from "../src/lib/embedding-reindex";
import {
  EDGE_FUNCTIONS,
  functionsEnvPath,
  REINDEX_FIELD,
  REINDEX_NO,
  REINDEX_NONE,
  REINDEX_YES,
  reindexChoices,
  runSemanticSearch,
  SEARCH_GEMINI_KEY,
  SEARCH_KEY,
  switchDecision,
} from "../src/setup/semantic-search";
import { SEARCH_FIELDS } from "../src/setup/steps/search";
import { fieldDefinitionProblems, type RunEvent } from "../src/setup/model";
import { cleanup, FAKE, makeCtx } from "./setup-fixture";
import { fakeLocal, LOCAL, SAFE_CONTAINERS } from "./local-supabase-fixture";
import { GEMINI, localRuntime, OPENAI, searchFake, type SearchFake } from "./search-fixture";
import { SB } from "./supabase-api-fixture";
import { PROFILE } from "./setup-web-fixture";

afterAll(cleanup);

const REPO = resolve(import.meta.dir, "..");
const BASE = `TELEGRAM_BOT_TOKEN=${FAKE.token}\nTELEGRAM_USER_ID=${FAKE.userId}\n`;
const CLOUD_URL = `https://${SB.ref}.supabase.co`;
const CLOUD_ENV = `${BASE}SUPABASE_URL=${CLOUD_URL}\nSUPABASE_SERVICE_ROLE_KEY=${SB.secret}\n`;
const LOCAL_ENV = `${BASE}SUPABASE_URL=${LOCAL.apiUrl}\nSUPABASE_SERVICE_ROLE_KEY=${LOCAL.secret}\n`;
const never = new AbortController().signal;

const COUNTS = {
  messages: { rows: 1200, chars: 480_000 },
  memory: { rows: 40, chars: 4_000 },
  knowledge: { rows: 10, chars: 16_000 },
  assets: { rows: 0, chars: 0 },
};

interface Launch {
  cmd: string[];
  cwd: string;
  logFile: string;
}

async function searchCtx(env: string, fake: SearchFake, overrides: Partial<SetupContext> = {}) {
  const launches: Launch[] = [];
  const ctx = await makeCtx({
    env,
    profile: PROFILE,
    overrides: {
      fetch: fake.fetch,
      startBackground: async (cmd, o) => {
        launches.push({ cmd, ...o });
        return true;
      },
      ...overrides,
    },
  });
  await cp(join(REPO, "supabase", "functions"), join(ctx.root, "supabase", "functions"), { recursive: true });
  await cp(join(REPO, "supabase", "config.toml"), join(ctx.root, "supabase", "config.toml"));
  return { ctx, launches };
}

async function run(ctx: SetupContext, values: Record<string, string>) {
  const events: RunEvent[] = [];
  const result = await runSemanticSearch(values, ctx, e => events.push(e), never);
  return { result, events };
}

const rpcCalls = (fake: SearchFake, fn: string) => fake.sent.filter(s => s.url.endsWith(`/rest/v1/rpc/${fn}`));
const functionCalls = (fake: SearchFake) => fake.sent.filter(s => s.url.includes("/functions/v1/"));

describe("Schätzung", () => {
  test("Zahlen nachvollziehbar: Einträge, Tokens (Zeichen / 4), Dauer mit Wartezeit, Kosten aus der Preisliste", () => {
    const e = estimateReindex(COUNTS, { provider: "openai", model: "text-embedding-3-large" });
    expect(e.rows).toBe(1250);
    expect(e.chars).toBe(500_000);
    expect(e.tokens).toBe(125_000);
    // 1250 Anfragen je 0,3 s = 375 s, plus 360 s Wartezeit = 735 s, aufgerundet 13 Minuten
    expect(e.minutes).toBe(Math.ceil((1250 * 0.3 + REINDEX_WRITE_DELAY_MS / 1000) / 60));
    expect(e.minutes).toBe(13);
    // 0,125 Millionen Tokens zu 0,13 US-Dollar
    expect(e.costUsd).toBeCloseTo(0.01625, 6);
    const text = estimateText(e);
    expect(text).toContain("ca. 1.250 Einträge (Verlauf 1.200, Erinnerungen 40, Wissen 10)");
    expect(text).toContain("etwa 125.000 Tokens (ein Token je vier Zeichen)");
    expect(text).toContain("Dauer etwa 13 Minuten (1.250 Anfragen nacheinander, je etwa 0,3 s, plus 6 Minuten Wartezeit am Anfang");
    expect(text).toContain("Kosten: etwa 0,02 US-Dollar (0,13 US-Dollar je Million Tokens)");
  });

  test("Kosten je Anbieter: OpenAI klein unter 1 Cent, Gemini Kontingent, Ollama keine, unbekanntes Modell ehrlich unbekannt", () => {
    const small: TableCounts = { messages: { rows: 100, chars: 40_000 }, memory: { rows: 0, chars: 0 }, knowledge: { rows: 0, chars: 0 }, assets: { rows: 0, chars: 0 } };
    expect(estimateText(estimateReindex(small, { provider: "openai", model: "text-embedding-3-small" }))).toContain("Kosten: unter 1 Cent (0,02 US-Dollar je Million Tokens)");
    expect(estimateText(estimateReindex(small, { provider: "gemini", model: "gemini-embedding-2" }))).toContain("im kostenlosen Kontingent von Gemini keine");
    expect(estimateText(estimateReindex(small, { provider: "ollama", model: "bge-m3" }))).toContain("Kosten: keine");
    expect(estimateReindex(small, { provider: "openai", model: "eigenes-modell" }).costUsd).toBeNull();
    expect(estimateText(estimateReindex(small, { provider: "openai", model: "eigenes-modell" }))).toContain("Preis für eigenes-modell unbekannt");
  });
});

describe("Wechsel erkennen", () => {
  const openai = { provider: "openai" as const, model: "text-embedding-3-small" };
  const gemini = { provider: "gemini" as const, model: "gemini-embedding-2" };
  test("Anbieter UND Modell zählen; Altbestand ohne Kennung ist ein Wechsel; laufende Umstellung: fortsetzen oder anderes Ziel", () => {
    expect(switchDecision({ state: "festgehalten", config: openai }, openai)).toEqual({ kind: "passt" });
    expect(switchDecision({ state: "festgehalten", config: openai }, gemini)).toEqual({ kind: "wechsel", from: "OpenAI (text-embedding-3-small)" });
    expect(switchDecision({ state: "festgehalten", config: openai }, { provider: "openai", model: "text-embedding-3-large" }).kind).toBe("wechsel");
    expect(switchDecision({ state: "altbestand" }, openai)).toEqual({ kind: "passt" });
    expect(switchDecision({ state: "altbestand" }, gemini).kind).toBe("wechsel");
    expect(switchDecision({ state: "leer", vectors: true }, gemini).kind).toBe("wechsel");
    expect(switchDecision({ state: "leer", vectors: false }, gemini)).toEqual({ kind: "passt" });
    expect(switchDecision({ state: "umstellung", target: gemini }, gemini)).toEqual({ kind: "fortsetzen" });
    expect(switchDecision({ state: "umstellung", target: gemini }, openai)).toEqual({ kind: "anderes-ziel", from: "Google Gemini (gemini-embedding-2)" });
    expect(switchDecision({ state: "fehlt" }, gemini)).toEqual({ kind: "fehlt" });
    expect(switchDecision(null, gemini)).toEqual({ kind: "unlesbar" });
  });

  test("Feld: Auswahl vom Anbieter, transient, ohne Standard; nur Cloud (nicht Ollama) und lokal", () => {
    const field = SEARCH_FIELDS.find(f => f.name === REINDEX_FIELD)!;
    expect(field.kind).toBe("choice");
    expect(field.transient).toBe(true);
    expect(typeof field.choicesFrom).toBe("function");
    expect(fieldDefinitionProblems(SEARCH_FIELDS)).toEqual([]);
    expect(field.visible!({ DB_BACKEND: "supabase-cloud" })).toBe(true);
    expect(field.visible!({ DB_BACKEND: "supabase-cloud", EMBEDDING_PROVIDER: "ollama" })).toBe(false);
    expect(field.visible!({ DB_BACKEND: "supabase-lokal", EMBEDDING_PROVIDER: "ollama" })).toBe(true);
    expect(field.visible!({ DB_BACKEND: "supabase" })).toBe(false);
    expect(field.visible!({ DB_BACKEND: "convex" })).toBe(false);
  });

  test("Auswahl bei Wechsel: erst Abbrechen, dann Neuberechnen mit Umfang, Dauer und Kosten", async () => {
    const fake = searchFake({ project: { registry: { provider: "openai", model: "text-embedding-3-small" }, counts: COUNTS } });
    const { ctx } = await searchCtx(CLOUD_ENV, fake);
    const { choices } = await reindexChoices({ EMBEDDING_PROVIDER: "gemini", [SEARCH_GEMINI_KEY]: GEMINI.good }, ctx);
    expect(choices.map(c => c.value)).toEqual([REINDEX_NO, REINDEX_YES]);
    expect(choices[0].label).toContain("es bleibt bei OpenAI (text-embedding-3-small)");
    expect(choices[1].label).toContain("Alles neu berechnen mit Google Gemini (gemini-embedding-2) statt OpenAI (text-embedding-3-small)");
    expect(choices[1].label).toContain("ca. 1.250 Einträge");
    expect(choices[1].label).toContain("Dauer etwa");
    expect(choices[1].label).toContain("Kosten:");
    // Nur gelesen: Kennung und Umfang, kein Beginn
    expect(rpcCalls(fake, "embedding_reindex_start")).toEqual([]);
    expect(fake.project.reindex ?? null).toBeNull();
    expect(JSON.stringify(choices)).not.toContain(GEMINI.good);
  });

  test("Kein Wechsel: nur „weiter“; ohne Schlüssel keine Anfrage an die Datenbank", async () => {
    const fake = searchFake({ project: { registry: { provider: "openai", model: "text-embedding-3-small" } } });
    const { ctx } = await searchCtx(CLOUD_ENV, fake);
    expect((await reindexChoices({ [SEARCH_KEY]: OPENAI.good }, ctx)).choices.map(c => c.value)).toEqual([REINDEX_NONE]);
    const before = fake.sent.length;
    expect((await reindexChoices({ EMBEDDING_PROVIDER: "gemini" }, ctx)).choices.map(c => c.value)).toEqual([REINDEX_NONE]);
    expect(fake.sent.length).toBe(before);
  });

  test("Modellwechsel beim gleichen Anbieter (EMBEDDING_MODEL in der .env) wird angeboten", async () => {
    const fake = searchFake({ project: { registry: { provider: "gemini", model: "gemini-embedding-2" }, counts: COUNTS } });
    const { ctx } = await searchCtx(`${CLOUD_ENV}EMBEDDING_PROVIDER=gemini\nEMBEDDING_MODEL=gemini-embedding-001\n`, fake);
    const { choices } = await reindexChoices({ [SEARCH_GEMINI_KEY]: GEMINI.good }, ctx);
    expect(choices.map(c => c.value)).toEqual([REINDEX_NO, REINDEX_YES]);
    expect(choices[1].label).toContain("Google Gemini (gemini-embedding-001) statt Google Gemini (gemini-embedding-2)");
  });

  test("Altbestand ohne Kennung und Wahl Gemini: Wechsel mit Hinweis auf die Vektoren ohne Kennung", async () => {
    const fake = searchFake({ project: { registry: "altbestand", counts: COUNTS } });
    const { ctx } = await searchCtx(CLOUD_ENV, fake);
    const { choices } = await reindexChoices({ EMBEDDING_PROVIDER: "gemini", [SEARCH_GEMINI_KEY]: GEMINI.good }, ctx);
    expect(choices[1].label).toContain("statt Vektoren ohne Anbieterkennung");
  });

  test("Unterbrochene Umstellung auf dasselbe Ziel: fortsetzen; auf ein anderes: neu beginnen", async () => {
    const fake = searchFake({ project: { registry: { provider: "openai", model: "text-embedding-3-small" }, reindex: { provider: "gemini", model: "gemini-embedding-2" }, counts: COUNTS } });
    const { ctx } = await searchCtx(CLOUD_ENV, fake);
    const same = await reindexChoices({ EMBEDDING_PROVIDER: "gemini", [SEARCH_GEMINI_KEY]: GEMINI.good }, ctx);
    expect(same.choices.map(c => c.value)).toEqual([REINDEX_YES, REINDEX_NO]);
    expect(same.choices[0].label).toContain("Unterbrochene Neuberechnung auf Google Gemini (gemini-embedding-2) fortsetzen");
    const other = await reindexChoices({ [SEARCH_KEY]: OPENAI.good }, ctx);
    expect(other.choices[1].label).toContain("Neu beginnen mit OpenAI (text-embedding-3-small) statt Google Gemini (gemini-embedding-2)");
  });

  test("Migration 20260928 fehlt: nur Abbrechen mit Hinweis auf das Schema", async () => {
    const fake = searchFake({ project: { registry: { provider: "openai", model: "text-embedding-3-small" }, reindexMissing: true } });
    const { ctx } = await searchCtx(CLOUD_ENV, fake);
    const { choices } = await reindexChoices({ EMBEDDING_PROVIDER: "gemini", [SEARCH_GEMINI_KEY]: GEMINI.good }, ctx);
    expect(choices.map(c => c.value)).toEqual([REINDEX_NO]);
    expect(choices[0].label).toContain("20260928_embedding_reindex.sql");
  });
});

describe("Rückfrage beim Ausführen", () => {
  const gemini = { EMBEDDING_PROVIDER: "gemini", [SEARCH_GEMINI_KEY]: GEMINI.good, SUPABASE_SETUP_TOKEN: SB.token };

  for (const answer of [undefined, REINDEX_NO]) {
    test(`Ablehnen (${answer ?? "keine Antwort"}) verändert nichts: keine Functions, keine Geheimnisse, .env gleich, kein Beginn, kein Hintergrund`, async () => {
      const fake = searchFake({ project: { registry: { provider: "openai", model: "text-embedding-3-small" }, counts: COUNTS } });
      const { ctx, launches } = await searchCtx(CLOUD_ENV, fake);
      const { result } = await run(ctx, answer ? { ...gemini, [REINDEX_FIELD]: answer } : gemini);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Nichts wurde geändert");
      expect(result.message).toContain(answer ? "Abgebrochen, wie gewählt" : "nur mit Zustimmung");
      expect(result.changed).toEqual([]);
      expect(fake.deploys).toEqual([]);
      expect(fake.secrets[SB.ref]).toBeUndefined();
      expect(await readFile(ctx.envPath, "utf8")).toBe(CLOUD_ENV);
      expect(rpcCalls(fake, "embedding_reindex_start")).toEqual([]);
      expect(fake.project.registry).toEqual({ provider: "openai", model: "text-embedding-3-small" });
      expect(fake.project.reindex ?? null).toBeNull();
      expect(launches).toEqual([]);
    });
  }

  test("Zustimmen (Cloud): erst den Lauf reservieren, dann Functions, Geheimnisse und .env wie sonst, dann Neuberechnung im Hintergrund mit demselben Inhaber", async () => {
    const fake = searchFake({ project: { registry: { provider: "openai", model: "text-embedding-3-small" }, counts: COUNTS } });
    const { ctx, launches } = await searchCtx(CLOUD_ENV, fake);
    const { result, events } = await run(ctx, { ...gemini, [REINDEX_FIELD]: REINDEX_YES });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Neuberechnung auf Google Gemini (gemini-embedding-2) begonnen");
    expect(result.message).toContain("ca. 1.250 Einträge");
    expect(result.message).toContain("nur Text");
    expect(result.message).toContain("Neustart anfordern");
    expect(fake.deploys.map(d => d.slug)).toEqual([...EDGE_FUNCTIONS]);
    expect(fake.secrets[SB.ref]).toMatchObject({ EMBEDDING_PROVIDER: "gemini", EMBEDDING_MODEL: "gemini-embedding-2", GEMINI_API_KEY: GEMINI.good });
    const env = await readFile(ctx.envPath, "utf8");
    expect(env).toContain("EMBEDDING_PROVIDER=gemini\n");
    expect(env).toContain("EMBEDDING_MODEL=gemini-embedding-2\n");
    const starts = rpcCalls(fake, "embedding_reindex_start").map(c => JSON.parse(String(c.body)));
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ p_provider: "gemini", p_model: "gemini-embedding-2", p_seconds: REINDEX_RESERVE_SECONDS });
    const holder: string = starts[0].p_holder;
    expect(holder).toMatch(/^setup:/);
    // Reserviert, bevor irgendetwas bei Supabase geändert wurde
    const startAt = fake.sent.findIndex(c => c.url.endsWith("/rest/v1/rpc/embedding_reindex_start"));
    const firstChange = fake.sent.findIndex(c => c.method === "POST" && /\/v1\/projects\/[a-z]+\/(functions\/deploy|secrets)/.test(c.url));
    expect(startAt).toBeGreaterThan(-1);
    expect(firstChange).toBeGreaterThan(startAt);
    expect(fake.project.reindex).toEqual({ provider: "gemini", model: "gemini-embedding-2", leased: true, holder });
    // Die Kennung bleibt bis zum Ende der Neuberechnung beim alten Anbieter
    expect(fake.project.registry).toEqual({ provider: "openai", model: "text-embedding-3-small" });
    // Kein Funktionsnachweis jetzt (die Suche ist gesperrt), der folgt nach dem Umschalten
    expect(functionCalls(fake)).toEqual([]);
    expect(launches).toHaveLength(1);
    expect(launches[0].cmd.slice(-4)).toEqual([join(ctx.root, "scripts", "tybo.ts"), "suche", "neu-berechnen", `--inhaber=${holder}`]);
    expect(launches[0].logFile).toBe(join(ctx.root, "logs", "embedding-reindex.log"));
    expect(events.map(e => e.label)).toContain("Starte die Neuberechnung");
    expect(JSON.stringify({ result, events, launches })).not.toContain(GEMINI.good);
  });

  test("Zustimmen ohne Hintergrundstart (etwa ohne startBackground): Befehl zum Selbststarten, Reservierung freigegeben", async () => {
    const fake = searchFake({ project: { registry: { provider: "openai", model: "text-embedding-3-small" }, counts: COUNTS } });
    const { ctx } = await searchCtx(CLOUD_ENV, fake, { startBackground: undefined });
    const { result } = await run(ctx, { ...gemini, [REINDEX_FIELD]: REINDEX_YES });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Starten mit: tybo suche neu-berechnen");
    // Der Befehl von Hand kann sofort übernehmen
    expect(fake.project.reindex).toEqual({ provider: "gemini", model: "gemini-embedding-2" });
  });

  test("Scheitert der Schritt nach der Reservierung (Ausliefern der Functions): Reservierung freigegeben, kein Hintergrund", async () => {
    const fake = searchFake({ project: { registry: { provider: "openai", model: "text-embedding-3-small" }, counts: COUNTS, failDeploy: true } });
    const { ctx, launches } = await searchCtx(CLOUD_ENV, fake);
    const { result } = await run(ctx, { ...gemini, [REINDEX_FIELD]: REINDEX_YES });
    expect(result.ok).toBe(false);
    expect(fake.project.reindex).toEqual({ provider: "gemini", model: "gemini-embedding-2" });
    expect(launches).toEqual([]);
  });

  // Läuft Ziel A (ein Prozess hält den Lauf) und wird Ziel B gewählt, darf sich an
  // Functions, Geheimnissen und .env nichts ändern: sonst schlösse Job A mit der
  // Konfiguration für B ab
  test("Cloud: Ziel A läuft, Ziel B gewählt: belegt, bevor irgendetwas geändert wird (Functions, Geheimnisse, .env unverändert)", async () => {
    const running = { provider: "openai", model: "text-embedding-3-large", leased: true, holder: "rechner:job-a" };
    const fake = searchFake({ project: { registry: { provider: "openai", model: "text-embedding-3-small" }, reindex: { ...running }, counts: COUNTS } });
    const { ctx, launches } = await searchCtx(CLOUD_ENV, fake);
    const { result } = await run(ctx, { ...gemini, [REINDEX_FIELD]: REINDEX_YES });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("rechnet ein anderer Prozess auf OpenAI (text-embedding-3-large)");
    expect(result.message).toContain("Nichts wurde geändert");
    expect(result.changed).toEqual([]);
    expect(fake.deploys).toEqual([]);
    expect(fake.secrets[SB.ref]).toBeUndefined();
    expect(fake.sent.filter(c => c.method === "POST" && /\/v1\/projects\/[a-z]+\/(functions\/deploy|secrets)/.test(c.url))).toEqual([]);
    expect(await readFile(ctx.envPath, "utf8")).toBe(CLOUD_ENV);
    // Der laufende Job A behält seinen Lauf
    expect(fake.project.reindex).toEqual(running);
    expect(launches).toEqual([]);
  });

  test("Lokal: Ziel A läuft, Ziel B gewählt: belegt, supabase/functions/.env und .env unverändert, kein Neustart", async () => {
    const local = fakeLocal();
    local.containers = [...SAFE_CONTAINERS, "supabase_edge_runtime_tybo\t"];
    const running = { provider: "openai", model: "text-embedding-3-large", leased: true, holder: "rechner:job-a" };
    const fake = searchFake({ project: { serviceKeys: [LOCAL.secret], deployed: new Set(EDGE_FUNCTIONS), registry: { provider: "openai", model: "text-embedding-3-small" }, reindex: { ...running }, counts: COUNTS } });
    const { ctx, launches } = await searchCtx(LOCAL_ENV, fake, { run: local.run as any, localSupabase: local.deps });
    const runtime = localRuntime(functionsEnvPath(ctx.root));
    fake.project.runtimeKey = runtime.key;
    fake.project.runtimeEnv = runtime.env;
    await runtime.start();
    const fnEnvBefore = await readFile(functionsEnvPath(ctx.root), "utf8").catch(() => null);
    let restarted = false;
    local.answers["supabase stop"] = async () => {
      restarted = true;
      return { stdout: "Stopped" };
    };
    const { result } = await run(ctx, { EMBEDDING_PROVIDER: "gemini", [SEARCH_GEMINI_KEY]: GEMINI.good, [REINDEX_FIELD]: REINDEX_YES });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("rechnet ein anderer Prozess");
    expect(result.changed).toEqual([]);
    expect(await readFile(functionsEnvPath(ctx.root), "utf8").catch(() => null)).toBe(fnEnvBefore);
    expect(await readFile(ctx.envPath, "utf8")).toBe(LOCAL_ENV);
    expect(restarted).toBe(false);
    expect(fake.project.reindex).toEqual(running);
    expect(launches).toEqual([]);
  });

  test("Dasselbe Ziel läuft schon in einem anderen Prozess: kein zweiter Hintergrundlauf, Hinweis auf den Stand", async () => {
    const running = { provider: "gemini", model: "gemini-embedding-2", leased: true, holder: "rechner:job-a" };
    const fake = searchFake({ project: { registry: { provider: "openai", model: "text-embedding-3-small" }, reindex: { ...running }, counts: COUNTS } });
    const { ctx, launches } = await searchCtx(CLOUD_ENV, fake);
    const { result } = await run(ctx, { ...gemini, [REINDEX_FIELD]: REINDEX_YES });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("läuft schon in einem anderen Prozess");
    expect(fake.project.reindex).toEqual(running);
    expect(launches).toEqual([]);
  });

  test("Supabase auf diesem Rechner: erst reservieren, dann Functions-Umgebung und Neustart, dann Neuberechnung", async () => {
    const local = fakeLocal();
    local.containers = [...SAFE_CONTAINERS, "supabase_edge_runtime_tybo\t"];
    const fake = searchFake({ project: { serviceKeys: [LOCAL.secret], deployed: new Set(EDGE_FUNCTIONS), registry: { provider: "openai", model: "text-embedding-3-small" }, counts: COUNTS } });
    const { ctx, launches } = await searchCtx(LOCAL_ENV, fake, { run: local.run as any, localSupabase: local.deps });
    const runtime = localRuntime(functionsEnvPath(ctx.root));
    fake.project.runtimeKey = runtime.key;
    fake.project.runtimeEnv = runtime.env;
    await runtime.start();
    let reservedBeforeRestart = false;
    local.answers["supabase start"] = async () => {
      await runtime.start();
      reservedBeforeRestart = !!fake.project.reindex?.leased;
      return { stdout: "Started" };
    };
    const { result } = await run(ctx, { EMBEDDING_PROVIDER: "gemini", [SEARCH_GEMINI_KEY]: GEMINI.good, [REINDEX_FIELD]: REINDEX_YES });
    expect(result.ok).toBe(true);
    expect(reservedBeforeRestart).toBe(true);
    expect(await readFile(functionsEnvPath(ctx.root), "utf8")).toContain("EMBEDDING_PROVIDER=gemini");
    expect(fake.project.reindex).toMatchObject({ provider: "gemini", model: "gemini-embedding-2", leased: true });
    expect(launches).toHaveLength(1);
  });

  test("Kein Wechsel: „weiter“ ändert nichts am gewohnten Ablauf (Nachweis, kein Beginn)", async () => {
    const fake = searchFake({ project: { registry: { provider: "openai", model: "text-embedding-3-small" } } });
    const { ctx, launches } = await searchCtx(CLOUD_ENV, fake);
    const { result } = await run(ctx, { [SEARCH_KEY]: OPENAI.good, SUPABASE_SETUP_TOKEN: SB.token, [REINDEX_FIELD]: REINDEX_NONE });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Semantische Suche: aktiv");
    expect(rpcCalls(fake, "embedding_reindex_start")).toEqual([]);
    expect(launches).toEqual([]);
  });
});
