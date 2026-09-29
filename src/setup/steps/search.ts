/**
 * Schritt „suche“ (Issue #166): semantische Suche für Supabase, direkt nach
 * der Datenbank. Läuft immer als Ablauf (src/setup/semantic-search.ts);
 * überspringbar, ohne Schlüssel bleibt es bei der Textsuche. Seit #167 mit
 * Wahl des Anbieters (OpenAI, Gemini, Ollama); ein anderes Modell als der
 * Standard geht nur über EMBEDDING_MODEL in der .env.
 *
 * Erledigt heißt: der letzte Funktionsnachweis für genau diese Supabase-
 * Adresse war erfolgreich, nicht nur „Schlüssel gesetzt“. Die Gesamtprüfung
 * wiederholt den Nachweis (test).
 */

import { BRAND } from "../../brand";
import { readSetupEnv, type SetupContext } from "../context";
import { fieldStates, presentValue, type SetupField, type SetupStep, type SetupValues, type StepStatus } from "../model";
import {
  checkDatabaseProvider,
  geminiKeyProblem,
  GEMINI_KEYS_PAGE,
  keyProblem,
  lastProvenActive,
  OLLAMA_PAGE,
  OLLAMA_PULL,
  OLLAMA_URL_ENV,
  OPENAI_KEYS_PAGE,
  probeSearch,
  probeText,
  PROVIDER_ENV,
  readRecord,
  REINDEX_FIELD,
  REINDEX_LABEL,
  reindexChoices,
  runSemanticSearch,
  searchPlan,
  SEARCH_GEMINI_KEY,
  SEARCH_KEY,
  targetHash,
  writeRecord,
} from "../semantic-search";
import { configFromEnv } from "../search-record";
import { DEFAULT_OLLAMA_URL, describeConfig, ollamaProblem } from "../../../supabase/functions/_shared/embedding";
import { CLOUD_TOKEN, tokenProblem } from "../supabase-cloud";
import { SUPABASE_TOKEN_PAGE } from "../supabase-management";
import { setupPath } from "./database";

const isCloud = (v: SetupValues) => v.DB_BACKEND === "supabase-cloud";
const isSupabasePath = (v: SetupValues) => v.DB_BACKEND === "supabase-cloud" || v.DB_BACKEND === "supabase-lokal" || v.DB_BACKEND === "supabase";
/** Gewählter Anbieter; ohne Wahl OpenAI wie vor #167 */
const providerOf = (v: SetupValues) => (v[PROVIDER_ENV] ?? "openai").trim().toLowerCase();
const uses = (provider: string) => (v: SetupValues) => isSupabasePath(v) && providerOf(v) === provider;

export const SEARCH_FIELDS: SetupField[] = [
  {
    name: PROVIDER_ENV,
    label: "Anbieter der Embeddings",
    kind: "choice",
    default: "openai",
    choices: [
      { value: "openai", label: "OpenAI (Standard): text-embedding-3-small, kostet Cent-Beträge (0,02 US-Dollar pro Million Tokens), braucht einen OpenAI-Schlüssel" },
      { value: "gemini", label: "Google Gemini: gemini-embedding-2, im kostenlosen Kontingent gratis, braucht einen Gemini-Schlüssel" },
      { value: "ollama", label: "Ollama: bge-m3 auf diesem Rechner, kostenlos, braucht laufendes Ollama und Supabase auf diesem Rechner" },
    ],
    help: `Wer aus deinen Nachrichten die Vektoren für die Suche nach Bedeutung rechnet. Die Datenbank merkt sich den Anbieter beim ersten Embedding; ein späterer Wechsel rechnet Verlauf, Wissen, Erinnerungen und Bilder neu, nur nach Rückfrage. Bei OpenAI und Gemini gehen die Texte zum Anbieter, bei Ollama bleiben sie für die Suche auf diesem Rechner. Im kostenlosen Kontingent darf Google Eingaben laut seinen Bedingungen zur Verbesserung seiner Produkte verwenden.`,
    visible: isSupabasePath,
  },
  {
    name: SEARCH_KEY,
    label: "OpenAI-Schlüssel für die semantische Suche",
    kind: "secret",
    transient: true,
    help: `Damit findet ${BRAND.name} im Verlauf auch, was nur sinngemäß passt (Suche nach Bedeutung). Kostet sehr wenig: Embeddings mit text-embedding-3-small kosten 0,02 US-Dollar pro Million Tokens, auch viele tausend Nachrichten im Monat bleiben bei wenigen Cent. Leer lassen: nur Textsuche, nachholen mit ${BRAND.cli} setup suche.`,
    link: OPENAI_KEYS_PAGE,
    visible: uses("openai"),
    validate: v => keyProblem(v),
  },
  {
    name: SEARCH_GEMINI_KEY,
    label: "Gemini-Schlüssel für die semantische Suche",
    kind: "secret",
    transient: true,
    help: `Ein Schlüssel aus Google AI Studio. Im kostenlosen Kontingent entstehen keine Kosten, solange die Grenzen pro Minute und Tag reichen. ${BRAND.name} speichert ihn als GEMINI_API_KEY (auch Spracherkennung nutzt diesen Namen). Leer lassen: nur Textsuche, nachholen mit ${BRAND.cli} setup suche.`,
    link: GEMINI_KEYS_PAGE,
    visible: uses("gemini"),
    validate: v => geminiKeyProblem(v),
  },
  {
    name: OLLAMA_URL_ENV,
    label: "Adresse von Ollama",
    kind: "text",
    default: DEFAULT_OLLAMA_URL,
    help: "Wo Ollama auf diesem Rechner läuft. Die Edge Functions in Docker bekommen dieselbe Adresse mit host.docker.internal statt localhost.",
    link: OLLAMA_PAGE,
    visible: uses("ollama"),
    validate: v => ollamaProblem(v),
  },
  {
    name: OLLAMA_PULL,
    label: "Fehlt das Ollama-Modell: jetzt mit ollama pull herunterladen?",
    kind: "yesno",
    transient: true,
    help: "Standard ist bge-m3: etwa 1,2 GB, rechnet gut mit deutschen Texten. Ja: der Assistent lädt das Modell über Ollama herunter, falls es fehlt. Nein: er bricht in dem Fall ab und nennt den Befehl zum Selbermachen.",
    visible: uses("ollama"),
  },
  {
    name: CLOUD_TOKEN,
    label: "Supabase-Zugangstoken (für die Functions)",
    kind: "secret",
    transient: true,
    help: "Dasselbe persönliche Zugangstoken wie im Schritt Datenbank (beginnt mit sbp_). Damit liefert der Assistent die Edge Functions aus und setzt die Geheimnisse. Es gilt nur für diesen Lauf und wird nirgends gespeichert.",
    link: SUPABASE_TOKEN_PAGE,
    visible: v => isCloud(v) && providerOf(v) !== "ollama",
    validate: v => tokenProblem(v),
  },
  {
    name: REINDEX_FIELD,
    label: REINDEX_LABEL,
    kind: "choice",
    transient: true,
    help: `Vektoren verschiedener Anbieter oder Modelle sind nicht vergleichbar. Hält die Datenbank schon einen anderen fest, müssen alle Einträge neu berechnet werden; die Auswahl nennt Umfang, Dauer und Kosten. Während der Neuberechnung sucht ${BRAND.name} nur nach Text, am Ende kommt eine Meldung. Ohne Wechsel gibt es nur „Weiter“.`,
    choicesFrom: reindexChoices,
    // Selbst eingetragenes Supabase: kein Wechsel über den Assistenten (die Functions dort kennt er nicht)
    visible: v => (isCloud(v) && providerOf(v) !== "ollama") || v.DB_BACKEND === "supabase-lokal",
  },
];

/** Weg der Datenbank wie im Schritt Datenbank (für Sichtbarkeit und Plan) */
export async function searchPathValues(ctx: SetupContext): Promise<SetupValues> {
  const env = await readSetupEnv(ctx);
  const values: SetupValues = {};
  for (const name of ["CONVEX_URL", "SUPABASE_URL"]) {
    const v = presentValue(env, name);
    if (v !== undefined) values[name] = v;
  }
  const path = setupPath(values);
  return path ? { DB_BACKEND: path } : {};
}

function dateText(iso: string): string {
  return iso.slice(0, 10).split("-").reverse().join(".");
}

export async function searchStatus(ctx: SetupContext): Promise<StepStatus> {
  const env = await readSetupEnv(ctx);
  // Anbieter und Ollama-Adresse stehen in der .env; Schlüssel und Token sind transient
  const fields = fieldStates(SEARCH_FIELDS, env);
  const path = (await searchPathValues(ctx)).DB_BACKEND;
  if (path === "convex") {
    return { state: "fehlt", detail: "Gilt nur für Supabase; mit Convex läuft die semantische Suche über Convex selbst.", fields };
  }
  const url = presentValue(env, "SUPABASE_URL");
  if (!path || !url) return { state: "fehlt", detail: "Erst die Datenbank einrichten (Supabase), dann die Suche.", fields };
  const config = configFromEnv(env);
  const active = await lastProvenActive(ctx, url, config);
  if (active) return { state: "erledigt", detail: `Semantische Suche: aktiv mit ${describeConfig(active)} (zuletzt nachgewiesen am ${dateText(active.checkedAt)}).`, fields };
  const record = await readRecord(ctx);
  const known = record && record.target === targetHash(url);
  return {
    state: "fehlt",
    detail: known
      ? `Semantische Suche: nur Textsuche (Test vom ${dateText(record.checkedAt)}). Einrichten mit ${BRAND.cli} setup suche.`
      : `Semantische Suche: nur Textsuche (nicht eingerichtet oder nicht nachgewiesen). Einrichten mit ${BRAND.cli} setup suche.`,
    fields,
  };
}

export const searchStep: SetupStep = {
  id: "suche",
  title: "Semantische Suche",
  description: `Verlauf nach Bedeutung durchsuchen: Edge Functions und ein Anbieter für Embeddings (OpenAI, Google Gemini oder Ollama) für Supabase. Ohne das sucht ${BRAND.name} nur nach Text.`,
  optional: true,
  fields: SEARCH_FIELDS,

  status: searchStatus,

  /** Gesamtprüfung: Nachweis mit den gespeicherten Werten wiederholen */
  async test(_values, ctx, signal) {
    const env = await readSetupEnv(ctx);
    const url = presentValue(env, "SUPABASE_URL");
    const key = presentValue(env, "SUPABASE_SERVICE_ROLE_KEY");
    const path = (await searchPathValues(ctx)).DB_BACKEND;
    if (!url || !key || path === "convex" || !path) return { ok: false, message: "Semantische Suche: nur mit Supabase prüfbar." };
    // Erst die Anbieterkennung (Issue #167): passt die Einstellung nicht, sucht die Datenbank nur nach Text
    const provider = await checkDatabaseProvider(ctx, env, url, key, signal);
    if (!provider.ok) return { ok: false, message: provider.unreadable ? `Semantische Suche nicht prüfbar: ${provider.message}` : `Semantische Suche: nur Textsuche. ${provider.message}` };
    // Gültig, sonst hätte checkDatabaseProvider schon abgelehnt
    const config = configFromEnv(env);
    if (!config) return { ok: false, message: "Semantische Suche: EMBEDDING_PROVIDER oder EMBEDDING_MODEL in der .env ist ungültig." };
    // Abbruch (Strg+C) kommt von der Oberfläche; aufgeräumt wird trotzdem (waitForProbes).
    // Die Probe bestätigt auch, dass die Functions mit genau dieser Einstellung rechnen
    const probe = await probeSearch(url, key, ctx, signal ?? new AbortController().signal, config);
    if (probe.state === "aktiv" || probe.state === "textsuche") await writeRecord(ctx, url, probe.state, config);
    if (probe.state === "aktiv") return { ok: probe.cleaned, message: `Semantische Suche: aktiv. ${probeText(probe)} ${provider.message}` };
    if (probe.state === "textsuche") return { ok: false, message: `Semantische Suche: nur Textsuche. ${probeText(probe)} Einrichten mit ${BRAND.cli} setup suche.` };
    return { ok: false, message: `Semantische Suche nicht prüfbar: ${probeText(probe)}` };
  },

  plan: searchPlan,
  run: runSemanticSearch,
};
