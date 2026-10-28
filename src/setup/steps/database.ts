/**
 * Schritt „datenbank“: drei Wege zu Supabase. In der Cloud (Standard, Ablauf
 * aus src/setup/supabase-cloud.ts), auf diesem Rechner in Docker (Ablauf aus
 * src/setup/local-supabase.ts, Issue #164) oder mit selbst eingetragenen
 * Zugangsdaten. Gespeichert wird, wie die Laufzeit es liest (src/lib/store:
 * Supabase, wenn SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY gesetzt sind,
 * alter service_role oder neuer sb_secret_…).
 *
 * Andere Datenbanken bietet der Schritt nicht mehr an (Issue #324). Eine
 * Adresse aus früheren Versionen liest er nicht und fasst sie nicht an; auf
 * sie weist der Bot beim Start hin (src/lib/legacy-database-notice.ts).
 *
 * Der Verbindungstest deployt nichts. Er liest messages und macht danach eine
 * Schreibprobe (Issue #305): eine Testzeile in memory, die gleich wieder
 * gelöscht wird. Die Statusanzeige bleibt lesend. Ein Publishable-Schlüssel
 * als Schreibschlüssel verhindert jede Testanfrage, auch wenn er schon
 * gespeichert ist.
 *
 * Weg und Laufzeit sind getrennt (Issue #163): activeBackend() sagt, ob die
 * Laufzeit eine Datenbank hat, setupPath(), welcher Weg beim erneuten
 * Einrichten vorgewählt ist (Adresse auf *.supabase.co: supabase-cloud; genau
 * die lokale Adresse aus src/setup/local-supabase.ts: supabase-lokal). Beide
 * Wege laufen als Ablauf, Speichern ist dort gesperrt.
 *
 * Supabase-Adressen dürfen http:// nur für 127.0.0.1 und localhost nutzen
 * (lokales Supabase), sonst gilt https://.
 */

import { fieldStates, mergeValues, resolveValues, type SetupField, type SetupStep, type SetupValues, type TestResult } from "../model";
import type { SetupContext } from "../context";
import { enteredChanges, envValues, invalid, writeEnv } from "./common";
import { isPublishableSupabaseKey } from "../../lib/supabase-keys";
import {
  CLOUD_NAME,
  CLOUD_ORG,
  CLOUD_REGION,
  CLOUD_TOKEN,
  cloudPlan,
  DEFAULT_PROJECT_NAME,
  DEFAULT_REGION,
  organizationChoices,
  projectNameProblem,
  runSupabaseCloud,
  SUPABASE_REGIONS,
  tokenProblem,
} from "../supabase-cloud";
import { isSupabaseCloudUrl, SUPABASE_TOKEN_PAGE } from "../supabase-management";
import { isLocalSupabaseUrl, localPlan, runSupabaseLocal, startHint } from "../local-supabase";

export type DbBackend = "supabase";
/** Wege im Assistenten; supabase ist „Zugangsdaten selbst eintragen“ */
export type DbSetupPath = "supabase-cloud" | "supabase-lokal" | "supabase";

const HTTPS_URL = /^https:\/\/[^\s/]+(\/.*)?$/;
/** http:// nur zu diesem Rechner: Host genau 127.0.0.1 oder localhost, dahinter nur Port und Pfad */
const LOOPBACK_HTTP_URL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?(\/[^\s]*)?$/i;
/** Supabase: https://, oder http:// zu 127.0.0.1/localhost (Supabase auf diesem Rechner) */
export const supabaseUrlRule = (label: string) => (v: string) =>
  HTTPS_URL.test(v) || LOOPBACK_HTTP_URL.test(v) ? null : `${label} muss mit https:// beginnen (http:// nur für 127.0.0.1 oder localhost)`;

/** Genau die Adresse, die der lokale Ablauf schreibt; liegt seit Issue #165 in local-supabase.ts */
export { isLocalSupabaseUrl };

const isSupabase = (v: SetupValues) => v.DB_BACKEND === "supabase";
const isCloud = (v: SetupValues) => v.DB_BACKEND === "supabase-cloud";
const isLocal = (v: SetupValues) => v.DB_BACKEND === "supabase-lokal";
/** Wege, die als Ablauf laufen (Speichern gesperrt) */
const isFlow = (v: SetupValues) => isCloud(v) || isLocal(v);

/** Meldung, wenn als Schreibschlüssel der öffentliche Schlüssel steht; nennt den Wert nie */
const PUBLISHABLE_AS_WRITER =
  "Das ist der öffentliche Publishable-Schlüssel (sb_publishable_…), er darf nicht schreiben. Hier gehört der Secret-Schlüssel (sb_secret_…) oder service_role hin.";

/**
 * Verbindungstest Supabase: erst lesen, nur danach die Schreibprobe. Ein
 * Publishable-Schlüssel kommt gar nicht erst ans Netz.
 */
async function testSupabase(ctx: SetupContext, url: string, key: string): Promise<TestResult> {
  if (isPublishableSupabaseKey(key.trim())) return { ok: false, message: PUBLISHABLE_AS_WRITER };
  const read = await ctx.providers.supabaseQuery(url, key);
  if (!read.ok) return { ok: false, message: read.message };
  const write = await ctx.providers.supabaseWriteProbe(url, key);
  return { ok: write.ok, message: `${read.message} ${write.message}` };
}

export const DATABASE_FIELDS: SetupField[] = [
  {
    name: "DB_BACKEND",
    label: "Datenbank",
    kind: "choice",
    required: true,
    help: "Supabase in der Cloud ist der einfachste Weg: du brauchst nur ein kostenloses Konto und ein Zugangstoken, den Rest macht der Assistent. Wer seine Gespräche nicht in eine Cloud geben will, nimmt Supabase auf diesem Rechner (braucht Docker). Ein vorhandenes Projekt oder einen eigenen Supabase-Server trägst du selbst ein.",
    default: "supabase-cloud",
    choices: [
      { value: "supabase-cloud", label: "Supabase in der Cloud, der Assistent richtet alles ein (Standard)" },
      { value: "supabase-lokal", label: "Supabase auf diesem Rechner, in Docker, der Assistent richtet alles ein" },
      { value: "supabase", label: "Supabase, Zugangsdaten selbst eintragen (vorhandenes Projekt)" },
    ],
  },
  {
    name: CLOUD_TOKEN,
    label: "Supabase-Zugangstoken",
    kind: "secret",
    transient: true,
    required: true,
    help: "Persönliches Zugangstoken (beginnt mit sbp_): bei Supabase unter Account, Access Tokens, „Generate new token“. Ablaufdatum setzen, nach der Einrichtung darfst du es löschen. Es gilt nur für diesen Lauf und wird nirgends gespeichert.",
    link: SUPABASE_TOKEN_PAGE,
    visible: isCloud,
    validate: v => tokenProblem(v),
  },
  {
    name: CLOUD_ORG,
    label: "Supabase-Organisation",
    kind: "choice",
    required: true,
    help: "Organisation, in der das Projekt liegt. Angeboten werden nur Organisationen im kostenlosen Tarif; gibt es nur eine, ist sie vorausgewählt.",
    visible: isCloud,
    choicesFrom: organizationChoices,
  },
  {
    name: CLOUD_NAME,
    label: "Projektname bei Supabase",
    kind: "text",
    default: DEFAULT_PROJECT_NAME,
    help: "Unter diesem Namen sucht der Assistent ein vorhandenes Projekt in der Organisation; gibt es keins, legt er es an.",
    visible: isCloud,
    validate: v => projectNameProblem(v),
  },
  {
    name: CLOUD_REGION,
    label: "Region",
    kind: "choice",
    default: DEFAULT_REGION,
    help: "Wo die Daten liegen. Standard ist Frankfurt; die Regionen in der EU stehen oben.",
    visible: isCloud,
    choices: SUPABASE_REGIONS,
  },
  {
    name: "SUPABASE_URL",
    label: "Supabase-Adresse",
    kind: "text",
    required: true,
    help: "Supabase, Project Settings, API: Project URL. Ein eigener Server auf diesem Rechner darf http://127.0.0.1 oder http://localhost nutzen.",
    link: "https://supabase.com/dashboard",
    visible: isSupabase,
    validate: supabaseUrlRule("Supabase-Adresse"),
  },
  {
    name: "SUPABASE_SERVICE_ROLE_KEY",
    label: "Supabase service_role- oder Secret-Schlüssel",
    kind: "secret",
    required: true,
    help: "Supabase, Project Settings, API Keys: Secret key (sb_secret_…), bei älteren Projekten service_role. Der Bot braucht ihn zum Schreiben.",
    link: "https://supabase.com/dashboard",
    visible: isSupabase,
    validate: v => (isPublishableSupabaseKey(v.trim()) ? PUBLISHABLE_AS_WRITER : null),
  },
  {
    name: "SUPABASE_ANON_KEY",
    label: "Supabase anon- oder Publishable-Schlüssel (optional)",
    kind: "secret",
    help: "Supabase, Project Settings, API Keys: Publishable key (sb_publishable_…), bei älteren Projekten anon public. Wird nur als Rückfall gelesen.",
    visible: isSupabase,
  },
];

const ENV_NAMES = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"];

/** Datenbank der Laufzeit: Supabase, sobald SUPABASE_URL gesetzt ist */
export function activeBackend(env: SetupValues): DbBackend | null {
  if (env.SUPABASE_URL) return "supabase";
  return null;
}

/**
 * Vorgewählter Weg beim erneuten Einrichten: Supabase-Adresse auf
 * *.supabase.co heißt Cloud, genau die lokale Adresse heißt lokal; jede
 * andere (auch ein selbst eingetragener Server auf 127.0.0.1 mit anderem
 * Port) bleibt „selbst eintragen“, damit der lokale Ablauf sie nie ersetzt.
 */
export function setupPath(env: SetupValues): DbSetupPath | null {
  if (!activeBackend(env)) return null;
  if (isSupabaseCloudUrl(env.SUPABASE_URL)) return "supabase-cloud";
  return isLocalSupabaseUrl(env.SUPABASE_URL) ? "supabase-lokal" : "supabase";
}

async function existingValues(ctx: SetupContext): Promise<SetupValues> {
  const env = await envValues(ctx, ENV_NAMES);
  const path = setupPath(env);
  return path ? { ...env, DB_BACKEND: path } : env;
}

/** Gewählter Weg: Eingabe, sonst vorhandener, sonst Standard */
function effectivePath(values: SetupValues, existing: SetupValues): string | undefined {
  return { ...existing, ...resolveValues(DATABASE_FIELDS, values, existing) }.DB_BACKEND;
}

export const databaseStep: SetupStep = {
  id: "datenbank",
  title: "Datenbank",
  description: "Gedächtnis, Verlauf und Ziele liegen in Supabase (in der Cloud, auf diesem Rechner oder selbst eingetragen).",
  optional: false,
  fields: DATABASE_FIELDS,

  async status(ctx) {
    const existing = await existingValues(ctx);
    const fields = fieldStates(DATABASE_FIELDS, existing);
    const backend = existing.DB_BACKEND;
    if (backend === "supabase-cloud") {
      return existing.SUPABASE_SERVICE_ROLE_KEY
        ? { state: "erledigt", detail: "Supabase in der Cloud ist eingerichtet.", fields }
        : { state: "teilweise", detail: "Supabase-Adresse gesetzt, SUPABASE_SERVICE_ROLE_KEY fehlt. Erneut einrichten, der Assistent holt den Schlüssel.", fields };
    }
    if (backend === "supabase-lokal") {
      if (!existing.SUPABASE_SERVICE_ROLE_KEY) {
        return { state: "teilweise", detail: "Supabase auf diesem Rechner ist eingetragen, SUPABASE_SERVICE_ROLE_KEY fehlt. Erneut einrichten, der Assistent holt den Schlüssel.", fields };
      }
      const probe = await ctx.providers.supabaseQuery(existing.SUPABASE_URL, existing.SUPABASE_SERVICE_ROLE_KEY);
      return probe.ok
        ? { state: "erledigt", detail: "Supabase läuft lokal auf diesem Rechner.", fields }
        : { state: "teilweise", detail: `Supabase auf diesem Rechner ist eingetragen, antwortet aber nicht: ${startHint(ctx.root)}`, fields };
    }
    if (backend === "supabase") {
      return existing.SUPABASE_SERVICE_ROLE_KEY
        ? { state: "erledigt", detail: "Supabase ist eingerichtet.", fields }
        : { state: "teilweise", detail: "Supabase-Adresse gesetzt, SUPABASE_SERVICE_ROLE_KEY fehlt (nötig zum Schreiben).", fields };
    }
    return { state: "fehlt", detail: "Noch keine Datenbank eingerichtet.", fields };
  },

  async test(values, ctx) {
    const existing = await existingValues(ctx);
    // Gesamtprüfung nach einem Ablauf (Cloud, lokal): gespeicherte Werte, ohne Zugangstoken
    const path = effectivePath(values, existing);
    if (path === "supabase-cloud" || path === "supabase-lokal") {
      if (!existing.SUPABASE_URL || !existing.SUPABASE_SERVICE_ROLE_KEY || (path === "supabase-lokal" && !isLocalSupabaseUrl(existing.SUPABASE_URL))) {
        return {
          ok: false,
          message:
            path === "supabase-cloud"
              ? "Supabase in der Cloud ist noch nicht eingerichtet. Den Schritt Datenbank ausführen, der Assistent legt alles an."
              : "Supabase auf diesem Rechner ist noch nicht eingerichtet. Den Schritt Datenbank ausführen, der Assistent startet und richtet es ein.",
        };
      }
      return testSupabase(ctx, existing.SUPABASE_URL, existing.SUPABASE_SERVICE_ROLE_KEY);
    }
    const problem = invalid(DATABASE_FIELDS, values, existing);
    if (problem) return problem;
    const merged = mergeValues(existing, values);
    return testSupabase(ctx, merged.SUPABASE_URL, merged.SUPABASE_SERVICE_ROLE_KEY);
  },

  async apply(values, ctx) {
    const existing = await existingValues(ctx);
    const path = effectivePath(values, existing);
    if (path === "supabase-cloud") {
      return { ok: false, message: "Supabase in der Cloud richtet der Ablauf ein (Einrichten), nicht Speichern.", changed: [] };
    }
    if (path === "supabase-lokal") {
      return { ok: false, message: "Supabase auf diesem Rechner richtet der Ablauf ein (Einrichten), nicht Speichern.", changed: [] };
    }
    const problem = invalid(DATABASE_FIELDS, values, existing);
    if (problem) return { ...problem, changed: [] };
    const merged = mergeValues(existing, values);
    const changes = enteredChanges(
      DATABASE_FIELDS.filter(f => ENV_NAMES.includes(f.name)),
      values,
      merged,
    );
    return writeEnv(ctx, changes);
  },

  runWhen: isFlow,
  plan: values => (isLocal(values) ? localPlan(values) : cloudPlan(values)),
  run: (values, ctx, report, signal) => (isLocal(values) ? runSupabaseLocal(values, ctx, report, signal) : runSupabaseCloud(values, ctx, report, signal)),
};
