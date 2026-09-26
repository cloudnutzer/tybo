/**
 * Schritt „datenbank“: Supabase in der Cloud (Standard, Ablauf aus
 * src/setup/supabase-cloud.ts), Supabase mit selbst eingetragenen
 * Zugangsdaten oder Convex. Gespeichert wird, wie die Laufzeit es liest
 * (src/lib/convex.ts: Convex braucht CONVEX_URL und CONVEX_AUTH_TOKEN und
 * hat Vorrang, sobald CONVEX_URL gesetzt ist; Supabase schreibt mit
 * SUPABASE_SERVICE_ROLE_KEY, alter service_role oder neuer sb_secret_…).
 *
 * Wechsel von Convex zu Supabase entfernt CONVEX_URL, sonst bliebe Convex
 * aktiv. Das passiert nur mit ausdrücklicher Bestätigung; die alte .env
 * liegt als Sicherung in data/backups. Der Verbindungstest liest nur, legt
 * nichts an und deployt nichts.
 *
 * Weg und Laufzeit sind getrennt (Issue #163): activeBackend() sagt, welche
 * Datenbank die Laufzeit nutzt (convex oder supabase), setupPath(), welcher
 * Weg beim erneuten Einrichten vorgewählt ist (Adresse auf *.supabase.co:
 * supabase-cloud; genau die lokale Adresse aus src/setup/local-supabase.ts:
 * supabase-lokal, Issue #164). Beide Wege laufen als Ablauf, Speichern ist
 * dort gesperrt.
 *
 * Supabase-Adressen dürfen http:// nur für 127.0.0.1 und localhost nutzen
 * (lokales Supabase), sonst gilt https://; Convex bleibt bei https://.
 */

import { fieldStates, mergeValues, resolveValues, type SetupField, type SetupStep, type SetupValues } from "../model";
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
import { LOCAL_API_PORT, localPlan, runSupabaseLocal, startHint } from "../local-supabase";

export type DbBackend = "convex" | "supabase";
/** Wege im Assistenten; supabase ist „Zugangsdaten selbst eintragen“ */
export type DbSetupPath = "supabase-cloud" | "supabase-lokal" | "supabase" | "convex";

const HTTPS_URL = /^https:\/\/[^\s/]+(\/.*)?$/;
/** http:// nur zu diesem Rechner: Host genau 127.0.0.1 oder localhost, dahinter nur Port und Pfad */
const LOOPBACK_HTTP_URL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?(\/[^\s]*)?$/i;
const httpsRule = (label: string) => (v: string) => (HTTPS_URL.test(v) ? null : `${label} muss mit https:// beginnen`);
/** Supabase: https://, oder http:// zu 127.0.0.1/localhost (Supabase auf diesem Rechner) */
export const supabaseUrlRule = (label: string) => (v: string) =>
  HTTPS_URL.test(v) || LOOPBACK_HTTP_URL.test(v) ? null : `${label} muss mit https:// beginnen (http:// nur für 127.0.0.1 oder localhost)`;

/** Genau die Adresse, die der lokale Ablauf schreibt (Port aus supabase/config.toml) */
export function isLocalSupabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url.trim());
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === String(LOCAL_API_PORT);
  } catch {
    return false;
  }
}

const isConvex = (v: SetupValues) => v.DB_BACKEND === "convex";
const isSupabase = (v: SetupValues) => v.DB_BACKEND === "supabase";
const isCloud = (v: SetupValues) => v.DB_BACKEND === "supabase-cloud";
const isLocal = (v: SetupValues) => v.DB_BACKEND === "supabase-lokal";
/** Wege, die als Ablauf laufen (Speichern gesperrt) */
const isFlow = (v: SetupValues) => isCloud(v) || isLocal(v);
/** Supabase gewählt (ein Weg davon), aber CONVEX_URL steht noch in der .env */
const switchesFromConvex = (v: SetupValues) => (isSupabase(v) || isCloud(v) || isLocal(v)) && !!v.CONVEX_URL;

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
      { value: "convex", label: "Convex (für Fortgeschrittene, eigener Token-Aussteller nötig)" },
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
    name: "CONVEX_URL",
    label: "Convex-Adresse",
    kind: "text",
    required: true,
    help: "Im Projektordner „npx convex dev --once --configure=new“ ausführen, die Adresse endet auf .convex.cloud.",
    link: "https://dashboard.convex.dev",
    visible: isConvex,
    validate: httpsRule("Convex-Adresse"),
  },
  {
    name: "CONVEX_AUTH_TOKEN",
    label: "Convex-Zugangstoken",
    kind: "secret",
    required: true,
    help: "Token, mit dem sich der Bot bei Convex als Besitzer anmeldet (siehe docs/scheduling.md).",
    visible: isConvex,
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
    validate: v =>
      isPublishableSupabaseKey(v.trim())
        ? "Das ist der öffentliche Publishable-Schlüssel (sb_publishable_…), er darf nicht schreiben. Hier gehört der Secret-Schlüssel (sb_secret_…) oder service_role hin."
        : null,
  },
  {
    name: "SUPABASE_ANON_KEY",
    label: "Supabase anon- oder Publishable-Schlüssel (optional)",
    kind: "secret",
    help: "Supabase, Project Settings, API Keys: Publishable key (sb_publishable_…), bei älteren Projekten anon public. Wird nur als Rückfall gelesen.",
    visible: isSupabase,
  },
  {
    name: "DB_SWITCH_CONFIRM",
    label: "Von Convex zu Supabase wechseln",
    kind: "yesno",
    required: true,
    help: "In der .env steht noch Convex, das hätte Vorrang. Mit Ja wird CONVEX_URL entfernt (Sicherung bleibt in data/backups).",
    visible: switchesFromConvex,
    validate: v => (v === "true" ? null : "Wechsel zu Supabase ist nicht bestätigt"),
  },
];

const ENV_NAMES = ["CONVEX_URL", "CONVEX_AUTH_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"];

/** Aktive Datenbank wie in der Laufzeit: CONVEX_URL vor SUPABASE_URL */
export function activeBackend(env: SetupValues): DbBackend | null {
  if (env.CONVEX_URL) return "convex";
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
  const backend = activeBackend(env);
  if (backend === "supabase") {
    if (isSupabaseCloudUrl(env.SUPABASE_URL)) return "supabase-cloud";
    return isLocalSupabaseUrl(env.SUPABASE_URL) ? "supabase-lokal" : "supabase";
  }
  return backend;
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
  description: "Gedächtnis, Verlauf und Ziele liegen in Supabase (in der Cloud, auf diesem Rechner oder selbst eingetragen) oder Convex.",
  optional: false,
  fields: DATABASE_FIELDS,

  async status(ctx) {
    const existing = await existingValues(ctx);
    const fields = fieldStates(DATABASE_FIELDS, existing);
    const backend = existing.DB_BACKEND;
    if (backend === "convex") {
      return existing.CONVEX_AUTH_TOKEN
        ? { state: "erledigt", detail: "Convex ist eingerichtet.", fields }
        : { state: "teilweise", detail: "Convex-Adresse gesetzt, CONVEX_AUTH_TOKEN fehlt.", fields };
    }
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
      const result = await ctx.providers.supabaseQuery(existing.SUPABASE_URL, existing.SUPABASE_SERVICE_ROLE_KEY);
      return { ok: result.ok, message: result.message };
    }
    const problem = invalid(DATABASE_FIELDS, values, existing);
    if (problem) return problem;
    const merged = mergeValues(existing, values);
    const result =
      merged.DB_BACKEND === "convex"
        ? await ctx.providers.convexQuery(merged.CONVEX_URL, merged.CONVEX_AUTH_TOKEN)
        : await ctx.providers.supabaseQuery(merged.SUPABASE_URL, merged.SUPABASE_SERVICE_ROLE_KEY);
    return { ok: result.ok, message: result.message };
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
    const changes: Array<[string, string | null]> = enteredChanges(
      DATABASE_FIELDS.filter(f => ENV_NAMES.includes(f.name)),
      values,
      merged,
    );
    if (switchesFromConvex(merged)) changes.push(["CONVEX_URL", null]);
    return writeEnv(ctx, changes);
  },

  runWhen: isFlow,
  plan: values => (isLocal(values) ? localPlan(values) : cloudPlan(values)),
  run: (values, ctx, report, signal) => (isLocal(values) ? runSupabaseLocal(values, ctx, report, signal) : runSupabaseCloud(values, ctx, report, signal)),
};
