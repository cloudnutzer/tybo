/**
 * Katalog bekannter Variablen für die Schlüssel-Seite (Issue #62, M6) und
 * später den Einrichtungsassistenten (M8). Nur Daten, keine Werte.
 *
 * Gesperrt (nie über die WebUI änderbar, SPEC.md „Schutzregeln für
 * Schlüssel"): alle WEB_*, TELEGRAM_BOT_TOKEN und TELEGRAM_USER_ID, sonst
 * sperrt man sich aus. Die Agentenbot-Tokens (TELEGRAM_BOT_TOKEN_<AGENT>)
 * sind bewusst nicht gesperrt: ohne sie antwortet der Hauptbot. Der
 * Einrichtungsmodus (M8) darf Sperren nur über den Parameter unlocked von
 * isLockedKey aufheben, nie über Eingaben aus HTTP.
 */

import { ENV_NAME_PATTERN } from "./env-rules";

export const KEY_GROUPS = ["LLM-Anbieter", "Werkzeuge", "Dienste", "Telegram", "WebUI", "Datenbank"] as const;
export type KeyGroup = (typeof KEY_GROUPS)[number];
/** Gruppe für Variablen aus der .env, die der Katalog nicht kennt */
export const OTHER_GROUP = "Weitere";

export interface KeyCatalogEntry {
  name: string;
  group: KeyGroup;
  description: string;
  /** In der WebUI änderbar (sonst nur Handarbeit in .env) */
  editable: boolean;
}

/** Namen, die exakt gesperrt sind; dazu alles mit WEB_ am Anfang */
export const LOCKED_KEY_NAMES: ReadonlySet<string> = new Set(["TELEGRAM_BOT_TOKEN", "TELEGRAM_USER_ID"]);
export const LOCKED_KEY_PREFIX = "WEB_";

/**
 * Gesperrt heißt: über die WebUI weder setzen noch löschen. unlocked ist nur
 * für interne Aufrufer (Einrichtungsmodus M8), nie aus einer Anfrage befüllen.
 */
export function isLockedKey(name: string, unlocked: ReadonlySet<string> = new Set()): boolean {
  if (unlocked.has(name)) return false;
  return name.startsWith(LOCKED_KEY_PREFIX) || LOCKED_KEY_NAMES.has(name);
}

type Row = [name: string, description: string];

const ROWS: Record<KeyGroup, Row[]> = {
  "LLM-Anbieter": [
    ["ANTHROPIC_API_KEY", "Anthropic-API. Ist er gesetzt, nutzt auch Claude Code die API (Kosten pro Token) statt des Abos"],
    ["OPENROUTER_API_KEY", "OpenRouter, Cloud-Fallback, wenn Claude nicht antwortet"],
    ["OPENAI_API_KEY", "OpenAI: Embeddings der semantischen Suche (Standard-Anbieter) und Bildbeschreibungen, wenn kein Gemini-Schlüssel da ist"],
    ["GEMINI_API_KEY", "Google Gemini: Spracherkennung, Sprachausgabe und Embeddings, wenn EMBEDDING_PROVIDER=gemini"],
    ["XAI_API_KEY", "xAI Grok, KI-Nachrichten im Morgenbriefing"],
  ],
  Werkzeuge: [
    ["FIRECRAWL_API_KEY", "Firecrawl: Webseiten lesen, durchsuchen und crawlen"],
    ["APIFY_API_KEY", "Apify: Scraper, zum Beispiel für X oder LinkedIn"],
    ["CLOUDFLARE_API_TOKEN", "Cloudflare: Deploys von Pages und Workers"],
    ["CLOUDFLARE_ACCOUNT_ID", "Cloudflare-Konto für die Deploys"],
    ["GITHUB_TOKEN", "GitHub: private Repositories, zum Beispiel für MCP-Server oder eigene Skripte"],
  ],
  Dienste: [
    ["ELEVENLABS_API_KEY", "ElevenLabs: Stimme und Telefonanrufe"],
    ["ELEVENLABS_AGENT_ID", "ElevenLabs: Agent für Telefonanrufe"],
    ["ELEVENLABS_PHONE_NUMBER_ID", "ElevenLabs: Telefonnummer für Anrufe"],
    ["ELEVENLABS_WEBHOOK_SECRET", "ElevenLabs: Geheimnis zum Prüfen der Webhooks"],
    ["GOOGLE_CLIENT_ID", "Google OAuth für Gmail und Kalender"],
    ["GOOGLE_CLIENT_SECRET", "Google OAuth für Gmail und Kalender"],
    ["GOOGLE_REFRESH_TOKEN", "Google OAuth für Gmail und Kalender"],
    ["NOTION_TOKEN", "Notion-Integration, Aufgaben im Morgenbriefing"],
    ["NOTION_DATABASE_ID", "Notion-Datenbank mit den Aufgaben"],
    ["TWILIO_ACCOUNT_SID", "Twilio-Konto für WhatsApp"],
    ["TWILIO_AUTH_TOKEN", "Twilio-Zugang für WhatsApp"],
    ["GATEWAY_SECRET", "Gemeinsames Geheimnis für VPS, lokales /process und Sprach-Brücke"],
  ],
  Telegram: [
    ["TELEGRAM_BOT_TOKEN", "Token des Hauptbots von @BotFather"],
    ["TELEGRAM_USER_ID", "Deine Telegram-Nutzer-ID, nur sie darf mit dem Bot sprechen"],
    ["TELEGRAM_BOT_TOKEN_RESEARCH", "Eigener Bot für den Research-Agenten"],
    ["TELEGRAM_BOT_TOKEN_CONTENT", "Eigener Bot für den Content-Agenten"],
    ["TELEGRAM_BOT_TOKEN_FINANCE", "Eigener Bot für den Finance-Agenten"],
    ["TELEGRAM_BOT_TOKEN_STRATEGY", "Eigener Bot für den Strategy-Agenten"],
    ["TELEGRAM_BOT_TOKEN_CRITIC", "Eigener Bot für den Critic-Agenten"],
    ["TELEGRAM_BOT_TOKEN_CTO", "Eigener Bot für den CTO-Agenten"],
    ["TELEGRAM_BOT_TOKEN_COO", "Eigener Bot für den COO-Agenten"],
  ],
  WebUI: [
    ["WEB_ENABLED", "WebUI ein- oder ausschalten"],
    ["WEB_PASSWORD", "Passwort der WebUI"],
    ["WEB_HOST", "Adresse, auf der die WebUI lauscht"],
    ["WEB_PORT", "Port der WebUI"],
    ["WEB_ALLOWED_HOSTS", "Zusätzliche Host-Namen der WebUI"],
    ["WEB_ALLOW_KEY_EDIT", "Erlaubt, Schlüssel in der WebUI zu ändern"],
    ["WEB_PUSH_PUBLIC_KEY", "Öffentlicher Schlüssel für Benachrichtigungen (Web Push), legt tybo selbst an"],
    ["WEB_PUSH_PRIVATE_KEY", "Privater Schlüssel für Benachrichtigungen (Web Push), legt tybo selbst an"],
    ["WEB_PUSH_SUBJECT", "Kontakt für die Push-Dienste (mailto: oder https:), Standard ist die Adresse von tybo"],
  ],
  Datenbank: [
    ["SUPABASE_URL", "Adresse des Supabase-Projekts"],
    ["SUPABASE_ANON_KEY", "Öffentlicher Supabase-Schlüssel (anon oder sb_publishable_…)"],
    ["SUPABASE_SERVICE_ROLE_KEY", "Supabase-Schlüssel mit Schreibrechten (service_role oder sb_secret_…), für den Bot nötig"],
    ["SUPABASE_ACCESS_TOKEN", "Zugang für die Supabase-Kommandozeile"],
    ["CONVEX_URL", "Adresse der Convex-Datenbank (hat Vorrang vor Supabase)"],
    ["CONVEX_AUTH_TOKEN", "Dienst-Token für Convex"],
  ],
};

export const KEY_CATALOG: readonly KeyCatalogEntry[] = KEY_GROUPS.flatMap(group =>
  ROWS[group].map(([name, description]) => ({ name, group, description, editable: !isLockedKey(name) }))
);

const BY_NAME = new Map(KEY_CATALOG.map(e => [e.name, e]));

export function catalogEntry(name: string): KeyCatalogEntry | undefined {
  return BY_NAME.get(name);
}

/** Gruppe für die Einfügeposition in .env (setEnvValue groupOf); unbekannt: undefined */
export function catalogGroup(name: string): KeyGroup | undefined {
  return BY_NAME.get(name)?.group;
}

/** Name, der gesetzt werden darf, wenn er nicht im Katalog steht */
export function isValidKeyName(name: string): boolean {
  return ENV_NAME_PATTERN.test(name);
}
