/**
 * Ablauf „Supabase in der Cloud“ (Issue #163): Der Nutzer gibt nur ein
 * persönliches Zugangstoken (sbp_…), eine Organisation, einen Projektnamen
 * und eine Region an; alles Weitere macht dieser Ablauf über die
 * Management-API (src/setup/supabase-management.ts):
 *
 *   1. Token prüfen
 *   2. Projekt suchen: zuerst das aus SUPABASE_URL der .env, sonst eines mit
 *      gleichem Namen in der gewählten Organisation
 *   3. Anlegen (nur in einer Organisation im kostenlosen Tarif), mit einem
 *      zufälligen Datenbank-Passwort, das nirgends erscheint
 *   4. Warten, bis Projekt und Dienste db, rest, storage bereit sind,
 *      höchstens READY_TIMEOUT_MS: keine Anfrage und kein Schema nach
 *      Fristende, Anfragen und Wartezeiten höchstens so lang wie die Restzeit
 *   5. Schema (SCHEMA_FILES) als Migrationen, schon eingespielte überspringen
 *   6. Privaten Bilder-Ordner anlegen
 *   7. Schlüssel holen: neue (secret, publishable) vor alten
 *   8. .env schreiben, nur was abweicht
 *   9. Verbindungstest
 *
 * Wiederholbar: ein zweiter Lauf findet das Projekt und ergänzt nur, was
 * fehlt. Ein gefundenes Projekt wird nie ersetzt: Ist es nicht erreichbar,
 * gibt es mehrere mit gleichem Namen oder ist es pausiert, bricht der
 * Ablauf mit einem Hinweis ab, statt ein neues anzulegen.
 *
 * Das Zugangstoken lebt nur im Speicher dieses Laufs: nie in .env, data/,
 * Logs, Fortschritt, Meldungen oder der Umgebung von Unterprozessen. Alle
 * Meldungen sind feste Sätze aus diesem Code.
 */

import { randomBytes } from "node:crypto";
import { BRAND } from "../brand";
import { assetsBucket } from "../lib/asset-store";
import { readSetupEnv, type SetupContext } from "./context";
import type { ApplyResult, ChoicesResult, FieldChoice, RunReport, SetupValues } from "./model";
import { writeEnv } from "./steps/common";
import {
  createSupabaseManagement,
  projectUrl,
  refFromUrl,
  SupabaseManagementError,
  type SupabaseApiKey,
  type SupabaseManagement,
  type SupabaseProject,
} from "./supabase-management";
import {
  bucketSql,
  isValidBucketName,
  LIST_MIGRATIONS_SQL,
  loadSchemaFiles,
  migrationVersion,
  MIGRATIONS_TABLE_SQL,
  recordedMigrationSql,
  RELOAD_SCHEMA_SQL,
} from "./supabase-schema";

/** Feldnamen des Wegs (keine .env-Variablen; nur das Token ist transient) */
export const CLOUD_TOKEN = "SUPABASE_SETUP_TOKEN";
export const CLOUD_ORG = "SUPABASE_ORG";
export const CLOUD_NAME = "SUPABASE_PROJECT_NAME";
export const CLOUD_REGION = "SUPABASE_REGION";

export const DEFAULT_PROJECT_NAME = "tybo";
export const DEFAULT_REGION = "eu-central-1";

/**
 * Regionen, EU zuerst, danach die übrigen in der Reihenfolge der OpenAPI.
 * Feste Liste, weil /v1/projects/available-regions als experimentell gilt;
 * ein Test gleicht sie mit tests/fixtures/supabase-regions.json ab.
 */
export const SUPABASE_REGIONS: FieldChoice[] = [
  { value: "eu-central-1", label: "Frankfurt (eu-central-1)" },
  { value: "eu-central-2", label: "Zürich (eu-central-2)" },
  { value: "eu-west-1", label: "Irland (eu-west-1)" },
  { value: "eu-west-3", label: "Paris (eu-west-3)" },
  { value: "eu-north-1", label: "Stockholm (eu-north-1)" },
  { value: "eu-west-2", label: "London (eu-west-2)" },
  { value: "us-east-1", label: "Nord-Virginia, USA (us-east-1)" },
  { value: "us-east-2", label: "Ohio, USA (us-east-2)" },
  { value: "us-west-1", label: "Nordkalifornien, USA (us-west-1)" },
  { value: "us-west-2", label: "Oregon, USA (us-west-2)" },
  { value: "ap-east-1", label: "Hongkong (ap-east-1)" },
  { value: "ap-southeast-1", label: "Singapur (ap-southeast-1)" },
  { value: "ap-northeast-1", label: "Tokio (ap-northeast-1)" },
  { value: "ap-northeast-2", label: "Seoul (ap-northeast-2)" },
  { value: "ap-southeast-2", label: "Sydney (ap-southeast-2)" },
  { value: "ca-central-1", label: "Kanada, Montreal (ca-central-1)" },
  { value: "ap-south-1", label: "Mumbai (ap-south-1)" },
  { value: "sa-east-1", label: "São Paulo (sa-east-1)" },
];

export const TOKEN_PREFIX = "sbp_";
export const POLL_INTERVAL_MS = 5_000;
export const READY_TIMEOUT_MS = 10 * 60 * 1000;
export const HEALTH_SERVICES = ["db", "rest", "storage"];
/** Name eines neu angelegten Secret-Schlüssels */
export const SECRET_KEY_NAME = "tybo";
const DB_PASSWORD_LENGTH = 32;
const TOTAL = 9;

/** Projektnamen: 1 bis 64 Zeichen ohne Steuerzeichen */
export function projectNameProblem(name: string): string | null {
  const t = name.trim();
  if (!t) return "Projektname fehlt";
  if (t.length > 64) return "Projektname: höchstens 64 Zeichen";
  if (/[\u0000-\u001f\u007f]/.test(t)) return "Projektname: keine Steuerzeichen";
  return null;
}

export function tokenProblem(token: string): string | null {
  return token.trim().startsWith(TOKEN_PREFIX) ? null : `Das Zugangstoken beginnt mit ${TOKEN_PREFIX}`;
}

function management(token: string, ctx: SetupContext, deps: { sleep?: SetupContext["sleep"]; remainingMs?: () => number } = {}): SupabaseManagement {
  return createSupabaseManagement(token.trim(), { fetch: ctx.fetch, sleep: deps.sleep ?? ctx.sleep, remainingMs: deps.remainingMs });
}

function problemText(e: unknown): string {
  return e instanceof SupabaseManagementError ? e.message : "Die Anfrage an Supabase ist fehlgeschlagen.";
}

// ---------------------------------------------------------------------------
// Auswahl der Organisation
// ---------------------------------------------------------------------------

/**
 * Organisationen zum Token, nur im kostenlosen Tarif (tybo legt keine
 * kostenpflichtigen Projekte an; der Tarif gilt je Organisation). Angezeigt
 * mit Namen, Wert ist der slug.
 */
export async function organizationChoices(values: SetupValues, ctx: SetupContext): Promise<ChoicesResult> {
  const token = values[CLOUD_TOKEN]?.trim() ?? "";
  if (!token) return { error: "Erst das Zugangstoken eingeben." };
  if (tokenProblem(token)) return { error: `Das Zugangstoken beginnt mit ${TOKEN_PREFIX}. Unter supabase.com/dashboard/account/tokens erzeugen.` };
  const api = management(token, ctx);
  try {
    const orgs = await api.organizations();
    if (orgs.length === 0) return { error: "Zu diesem Zugangstoken gibt es keine Organisation. Im Supabase-Dashboard eine anlegen (kostenloser Tarif), dann neu laden." };
    const free: FieldChoice[] = [];
    for (const org of orgs) {
      const detail = await api.organization(org.slug);
      if (detail.plan === "free") free.push({ value: org.slug, label: org.name });
    }
    if (free.length === 0) {
      return {
        error:
          "Keine Organisation im kostenlosen Tarif gefunden. tybo legt nur kostenlose Projekte an. Im Supabase-Dashboard eine kostenlose Organisation anlegen oder „Zugangsdaten selbst eintragen“ wählen.",
      };
    }
    return { choices: free };
  } catch (e) {
    return { error: problemText(e) };
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export function cloudPlan(values: SetupValues): string[] {
  const out = [
    "Zugangstoken bei Supabase prüfen.",
    "Projekt suchen: das aus SUPABASE_URL der .env, sonst eines mit diesem Namen in der Organisation.",
    "Fehlt es: im kostenlosen Tarif anlegen, mit einem zufälligen Datenbank-Passwort, das tybo nicht braucht und nirgends speichert.",
    "Warten, bis das Projekt bereit ist (meist ein bis drei Minuten, höchstens zehn).",
    "Tabellen einspielen (db/schema.sql und db/migrations), schon eingespielte überspringen.",
    "Privaten Bilder-Ordner anlegen (SUPABASE_ASSETS_BUCKET, sonst tybo-assets).",
    "Schlüssel holen und SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY und SUPABASE_ANON_KEY in die .env schreiben.",
  ];
  if (values.CONVEX_URL) out.push("CONVEX_URL aus der .env entfernen (Wechsel zu Supabase, Sicherung bleibt in data/backups).");
  out.push("Verbindung testen.", "Das Zugangstoken gilt nur für diesen Lauf und wird nirgends gespeichert.");
  return out;
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------

const ABORTED_NOTHING = "Abgebrochen. Bei Supabase wurde nichts angelegt, die .env ist unverändert.";

function resumeHint(): string {
  return `Weiter mit: ${BRAND.cli} setup datenbank, dieselbe Organisation und derselbe Projektname; der Assistent erkennt das Projekt und ergänzt nur, was fehlt.`;
}

function fail(message: string): ApplyResult {
  return { ok: false, message, changed: [] };
}

/** Zufälliges Datenbank-Passwort (32 Zeichen), wird weder angezeigt noch gespeichert */
export function randomDbPassword(): string {
  return randomBytes(48).toString("base64url").slice(0, DB_PASSWORD_LENGTH);
}

/** Ein Schlüssel der Art: bevorzugt der aus der .env, dann einer namens tybo, dann der erste */
function pickKey(keys: SupabaseApiKey[], current: string | undefined): string | null {
  const usable = keys.filter(k => k.apiKey);
  return (usable.find(k => k.apiKey === current) ?? usable.find(k => k.name === SECRET_KEY_NAME) ?? usable[0])?.apiKey ?? null;
}

type ProjectState = "bereit" | "warten" | "pausiert" | "fehlgeschlagen";

function projectState(status: string): ProjectState {
  if (status === "ACTIVE_HEALTHY") return "bereit";
  if (status === "INACTIVE" || status === "PAUSING" || status === "GOING_DOWN") return "pausiert";
  if (status === "INIT_FAILED" || status === "RESTORE_FAILED" || status === "PAUSE_FAILED" || status === "REMOVED") return "fehlgeschlagen";
  return "warten";
}

const PAUSED =
  "Das Projekt bei Supabase ist pausiert. Im Dashboard (supabase.com/dashboard) fortsetzen, dann die Einrichtung erneut starten.";
const INIT_FAILED = `Supabase meldet, dass das Projekt nicht starten konnte. Im Dashboard (supabase.com/dashboard) das Projekt öffnen und neu starten. Danach ${BRAND.cli} setup datenbank erneut ausführen, dieselbe Organisation und derselbe Projektname: der Assistent erkennt das Projekt und ergänzt nur, was fehlt. Lässt es sich nicht starten, im Dashboard löschen und beim nächsten Lauf einen anderen Projektnamen angeben. Die .env ist unverändert.`;
const NOT_READY = `Das Projekt ist angelegt, aber noch nicht bereit. In ein paar Minuten ${BRAND.cli} setup datenbank erneut ausführen (dieselbe Organisation, derselbe Projektname), der Assistent macht dort weiter. Die .env ist unverändert.`;

/** Anlage abgeschickt, Antwort verloren (Netz, Abbruch): ob es das Projekt gibt, ist offen */
function creationUncertain(prefix: string): string {
  return `${prefix} Ob Supabase das Projekt trotzdem angelegt hat, ist unklar, weil die Antwort nicht ankam. Die .env ist unverändert. Weiter mit: ${BRAND.cli} setup datenbank, dieselbe Organisation und derselbe Projektname. Gibt es das Projekt, erkennt der Assistent es und ergänzt nur, was fehlt; sonst legt er es an. Einen anderen Namen zu wählen könnte ein zweites Projekt anlegen.`;
}

/**
 * Der Ablauf. values: Eingaben samt Standards (Token, Organisation,
 * Projektname, Region, bei Wechsel von Convex die Bestätigung).
 */
export async function runSupabaseCloud(values: SetupValues, ctx: SetupContext, report: RunReport, signal: AbortSignal): Promise<ApplyResult> {
  const token = values[CLOUD_TOKEN]?.trim() ?? "";
  const org = values[CLOUD_ORG]?.trim() ?? "";
  const name = (values[CLOUD_NAME]?.trim() || DEFAULT_PROJECT_NAME).trim();
  const region = values[CLOUD_REGION]?.trim() || DEFAULT_REGION;

  // Alles, was sich ohne Netz prüfen lässt, vor der ersten Anfrage
  if (!token) return fail("Das Zugangstoken fehlt.");
  if (tokenProblem(token)) return fail(`Das Zugangstoken beginnt mit ${TOKEN_PREFIX}. Unter supabase.com/dashboard/account/tokens erzeugen.`);
  if (!org) return fail("Die Organisation fehlt.");
  const nameProblem = projectNameProblem(name);
  if (nameProblem) return fail(`${nameProblem}.`);
  if (!SUPABASE_REGIONS.some(r => r.value === region)) return fail("Diese Region kennt der Assistent nicht.");
  let env: Record<string, string>;
  try {
    env = await readSetupEnv(ctx);
  } catch {
    return fail("Die .env ließ sich nicht lesen. Nichts wurde angelegt.");
  }
  const bucket = assetsBucket(env);
  if (!isValidBucketName(bucket)) {
    return fail("SUPABASE_ASSETS_BUCKET in der .env ist kein gültiger Name für den Bilder-Ordner (3 bis 63 Zeichen: Kleinbuchstaben, Ziffern, Punkt, Bindestrich, Unterstrich). Nichts wurde angelegt.");
  }
  if (env.CONVEX_URL?.trim() && values.DB_SWITCH_CONFIRM !== "true") return fail("Wechsel von Convex zu Supabase ist nicht bestätigt. Nichts wurde angelegt.");

  const api = management(token, ctx);
  /** Ab hier gibt es ein Projekt bei Supabase, das (noch) nicht in der .env steht */
  let project: SupabaseProject | null = null;
  let createdNow = false;
  /** Anlage abgeschickt, Antwort noch offen: ein Abbruch oder Netzfehler lässt den Ausgang ungewiss */
  let creating = false;

  const aborted = (): ApplyResult => {
    if (creating) return fail(creationUncertain("Abgebrochen."));
    return fail(project ? `Abgebrochen. Das Projekt bei Supabase bleibt bestehen, die .env ist unverändert. ${resumeHint()}` : ABORTED_NOTHING);
  };
  const failed = (message: string): ApplyResult =>
    fail(project && createdNow ? `${message} Das Projekt ist bei Supabase angelegt, die .env ist unverändert. ${resumeHint()}` : message);

  try {
    // 1. Token
    report({ at: 1, total: TOTAL, label: "Prüfe das Zugangstoken" });
    const orgs = await api.organizations(signal);
    if (signal.aborted) return aborted();
    if (!orgs.some(o => o.slug === org)) return fail("Die gewählte Organisation gehört nicht zu diesem Zugangstoken. Auswahl neu laden.");

    // 2. Suchen
    report({ at: 2, total: TOTAL, label: "Suche das Projekt" });
    const envRef = refFromUrl(env.SUPABASE_URL);
    if (envRef) {
      project = await api.project(envRef, signal);
      if (signal.aborted) return aborted();
      if (!project) {
        return fail(
          "Das Projekt aus SUPABASE_URL der .env ist mit diesem Zugangstoken nicht erreichbar (anderes Konto oder gelöscht). Ein Token des passenden Kontos nehmen, oder „Zugangsdaten selbst eintragen“ wählen. Es wurde nichts angelegt.",
        );
      }
    } else {
      const all = await api.projects(signal);
      if (signal.aborted) return aborted();
      // Gleicher Name in einer anderen Organisation zählt nicht
      const same = all.filter(p => p.organizationSlug === org && p.name === name);
      if (same.length > 1) {
        return fail(
          "In dieser Organisation gibt es mehrere Projekte mit diesem Namen. Einen eindeutigen Projektnamen eingeben, oder „Zugangsdaten selbst eintragen“ wählen. Es wurde nichts angelegt.",
        );
      }
      project = same[0] ?? null;
    }

    if (project) {
      const state = projectState(project.status);
      if (state === "pausiert") return fail(PAUSED);
      if (state === "fehlgeschlagen") return fail(INIT_FAILED);
      report({ at: 3, total: TOTAL, label: "Projekt gefunden, nichts anzulegen" });
    } else {
      // 3. Anlegen, nur im kostenlosen Tarif
      report({ at: 3, total: TOTAL, label: "Lege das Projekt an" });
      const detail = await api.organization(org, signal);
      if (signal.aborted) return aborted();
      if (detail.plan !== "free") {
        return fail(
          "Die Organisation ist nicht im kostenlosen Tarif; ein Projekt dort würde Geld kosten. tybo legt nur kostenlose an. Eine kostenlose Organisation wählen oder „Zugangsdaten selbst eintragen“. Es wurde nichts angelegt.",
        );
      }
      creating = true;
      project = await api.createProject({ name, organizationSlug: org, region, dbPass: randomDbPassword() }, signal);
      creating = false;
      createdNow = true;
      if (signal.aborted) return aborted();
    }
    const ref = project.ref;

    // 4. Warten, mit verbindlicher Frist
    const start = ctx.now().getTime();
    /** Auch Wartezeiten zählen, falls die Uhr (Tests) beim Schlafen stehen bleibt */
    let slept = 0;
    const elapsed = () => Math.max(ctx.now().getTime() - start, slept);
    const remainingMs = () => READY_TIMEOUT_MS - elapsed();
    const sleep = async (ms: number, s?: AbortSignal) => {
      await ctx.sleep(ms, s);
      slept += ms;
    };
    const waitApi = management(token, ctx, { sleep, remainingMs });
    for (;;) {
      report({ at: 4, total: TOTAL, label: "Warte, bis das Projekt bereit ist", waitedMs: elapsed() });
      if (remainingMs() <= 0) return fail(NOT_READY);
      const current = await waitApi.project(ref, signal);
      if (signal.aborted) return aborted();
      if (!current) return failed("Supabase findet das Projekt nicht mehr.");
      const state = projectState(current.status);
      // Kein Hinweis auf einen zweiten Lauf: der hilft hier nicht
      if (state === "pausiert") return fail(PAUSED);
      if (state === "fehlgeschlagen") return fail(INIT_FAILED);
      if (state === "bereit") {
        const health = await waitApi.health(ref, HEALTH_SERVICES, signal);
        if (signal.aborted) return aborted();
        const healthy = HEALTH_SERVICES.every(s => health.some(h => h.name === s && h.status === "ACTIVE_HEALTHY"));
        // Erst zum Schema, wenn die Frist noch läuft
        if (remainingMs() <= 0) return fail(NOT_READY);
        if (healthy) break;
      }
      if (remainingMs() <= 0) return fail(NOT_READY);
      await sleep(Math.min(POLL_INTERVAL_MS, remainingMs()), signal);
      if (signal.aborted) return aborted();
    }

    // 5. Schema
    report({ at: 5, total: TOTAL, label: "Spiele die Tabellen ein" });
    const files = await loadSchemaFiles(ctx.root);
    let listed = await api.migrations(ref, signal);
    if (signal.aborted) return aborted();
    let viaQuery = listed === null;
    const loadRecorded = async () => {
      await api.query(ref, MIGRATIONS_TABLE_SQL, signal);
      const rows = await api.query(ref, LIST_MIGRATIONS_SQL, signal);
      return rows.map(r => ({ version: String((r as any)?.version ?? ""), name: typeof (r as any)?.name === "string" ? (r as any).name : undefined }));
    };
    if (viaQuery) listed = await loadRecorded();
    const applied = new Set((listed ?? []).map(m => m.name).filter(Boolean));
    let appliedNow = 0;
    for (const [i, file] of files.entries()) {
      if (applied.has(file.name)) continue;
      appliedNow++;
      if (signal.aborted) return aborted();
      report({ at: 5, total: TOTAL, label: "Spiele die Tabellen ein", detail: file.file });
      if (!viaQuery) {
        // Stabiler Schlüssel: ein wiederholter Versuch (etwa nach Abbruch) spielt nichts doppelt ein
        const ok = await api.applyMigration(ref, { name: file.name, query: file.sql, idempotencyKey: `tybo-${ref}-${file.name}-${file.hash}` }, signal);
        if (ok) continue;
        viaQuery = true;
        const recorded = await loadRecorded();
        if (recorded.some(m => m.name === file.name)) continue;
      }
      await api.query(ref, recordedMigrationSql(file.sql, migrationVersion(ctx.now(), i), file.name), signal);
    }
    if (signal.aborted) return aborted();
    // Neue Tabellen sofort über die REST-API sichtbar (sonst schlägt der Verbindungstest anfangs fehl)
    if (appliedNow) await api.query(ref, RELOAD_SCHEMA_SQL, signal);
    if (signal.aborted) return aborted();

    // 6. Bilder-Ordner
    report({ at: 6, total: TOTAL, label: "Lege den Bilder-Ordner an" });
    const rows = await api.query(ref, bucketSql(bucket), signal);
    if (signal.aborted) return aborted();
    const isPublic = (rows[0] as any)?.public;
    if (isPublic === true) {
      return failed(
        "Der Bilder-Ordner aus SUPABASE_ASSETS_BUCKET ist bei Supabase öffentlich. tybo braucht einen privaten: im Dashboard unter Storage auf privat stellen oder einen anderen Namen in SUPABASE_ASSETS_BUCKET eintragen, dann erneut. Die .env ist unverändert.",
      );
    }
    if (isPublic !== false) return failed("Der Bilder-Ordner ließ sich nicht prüfen. Erneut versuchen.");

    // 7. Schlüssel: neue vor alten
    report({ at: 7, total: TOTAL, label: "Hole die Schlüssel" });
    const keys = await api.apiKeys(ref, signal);
    if (signal.aborted) return aborted();
    const secrets = keys.filter(k => k.type === "secret" && k.apiKey);
    const publishables = keys.filter(k => k.type === "publishable" && k.apiKey);
    const legacy = (n: string) => keys.find(k => k.type === "legacy" && k.name === n && k.apiKey)?.apiKey ?? null;
    let service: string | null;
    if (secrets.length) service = pickKey(secrets, env.SUPABASE_SERVICE_ROLE_KEY);
    else if (publishables.length) {
      // Neue Schlüssel sind an, aber kein Secret: genau einen anlegen
      const created = await api.createSecretKey(ref, SECRET_KEY_NAME, signal);
      if (signal.aborted) return aborted();
      service = created.apiKey;
    } else service = legacy("service_role");
    const anon = publishables.length ? pickKey(publishables, env.SUPABASE_ANON_KEY) : legacy("anon");
    if (!service) return failed("Supabase hat keinen Schlüssel zum Schreiben geliefert. Im Dashboard unter Project Settings, API Keys nachsehen, dann erneut.");

    // 8. .env, nur was abweicht
    if (signal.aborted) return aborted();
    report({ at: 8, total: TOTAL, label: "Schreibe die .env" });
    const url = projectUrl(ref);
    const wanted: Array<[string, string | null]> = [
      ["SUPABASE_URL", url],
      ["SUPABASE_SERVICE_ROLE_KEY", service],
    ];
    if (anon) wanted.push(["SUPABASE_ANON_KEY", anon]);
    if (env.CONVEX_URL !== undefined) wanted.push(["CONVEX_URL", null]);
    const changes = wanted.filter(([k, v]) => (v === null ? k in env : env[k] !== v));
    let changed: string[] = [];
    if (changes.length) {
      // Nicht abbrechbar: das Schreiben läuft zu Ende
      const written = await writeEnv(ctx, changes);
      if (!written.ok) return failed(written.message);
      changed = written.changed;
    }

    // 9. Verbindungstest
    report({ at: 9, total: TOTAL, label: "Teste die Verbindung" });
    const probe = await ctx.providers.supabaseQuery(url, service);
    const done = createdNow ? "Supabase-Projekt angelegt und eingerichtet." : changed.length ? "Supabase-Projekt gefunden und ergänzt." : "Supabase-Projekt gefunden, alles war schon eingerichtet.";
    if (!probe.ok) return { ok: false, message: `${done} Der Verbindungstest ist aber fehlgeschlagen: ${probe.message}`, changed };
    return { ok: true, message: `${done} ${probe.message}`, changed };
  } catch (e) {
    if (signal.aborted || (e instanceof SupabaseManagementError && e.kind === "abgebrochen")) return aborted();
    // Nur die Anfragen beim Warten haben eine Frist
    if (e instanceof SupabaseManagementError && e.kind === "frist") return fail(NOT_READY);
    // Antwort auf die Anlage verloren (Netz, 5xx, unlesbar): angelegt oder nicht, ist offen
    if (creating && e instanceof SupabaseManagementError && e.kind === "netz") return fail(creationUncertain(problemText(e)));
    return failed(problemText(e));
  }
}
