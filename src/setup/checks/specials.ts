/**
 * Spezialprüfungen von `tybo pruefen` (Issue #371): was über die Zustände
 * der Einrichtungsschritte hinausgeht. Alle Anfragen laufen über den
 * Kontext des Berichts (reportContext in ./report.ts), Befehle über ctx.run,
 * Pfade aus ctx.root.
 *
 * Telegram und Datenbank sind hier neu geschrieben und fragen jede
 * Gegenstelle höchstens einmal: getMe je Token, messages einmal (bei
 * lokaler Supabase aus dem Zwischenspeicher des Schritts Datenbank). Den
 * Speichertest über getStore() gibt es nicht mehr, er las dieselbe Tabelle
 * ein zweites Mal.
 *
 * Dienste stehen in ./services.ts, lokales Hören und Telefonhörer in
 * ./speech.ts (Issue #372), beide mit Runner, Projektordner und .env des
 * Berichts. Claude Code für den Telefonhörer mit CLAUDE_PATH, CLAUDE_AUTH und
 * ANTHROPIC_API_KEY aus der .env des Projekts, nicht aus der Shell.
 */

import { BRAND } from "../../brand";
import { legacyDatabaseNotice } from "../../lib/legacy-database-notice";
import type { EngineStatus } from "../../lib/engines/check";
import { supabaseHeaders } from "../../lib/supabase-keys";
import type { CallModelDeps } from "../../lib/voice-brain/call-model";
import { checkChannels } from "../channels";
import type { SetupContext } from "../context";
import { presentValue } from "../model";
import { claudeRunContext, type Finding, type SpecialCheck } from "./report";
import { serviceFindings } from "./services";
import { callFinding, speechFindings } from "./speech";

type Env = Record<string, string>;

const AGENT_TOKEN_PREFIX = "TELEGRAM_BOT_TOKEN_";
const TABLE_TIMEOUT_MS = 10_000;
/** Zeitlimit je Claude-Befehl (wie inspectEngine) */
const CLAUDE_TIMEOUT_MS = 5_000;

/** Hauptbot und eigene Bots der Agenten; ohne eingerichtetes Telegram keine Anfrage */
export const telegramCheck: SpecialCheck = {
  id: "telegram",
  section: "Telegram",
  async run({ ctx, env }) {
    if (checkChannels(env).telegram.state !== "ok") {
      return [{ label: "Verbindung", status: "skip", detail: "Übersprungen: Telegram ist nicht eingerichtet" }];
    }
    const found: Finding[] = [];
    const main = await ctx.providers.telegramGetMe(env.TELEGRAM_BOT_TOKEN.trim());
    found.push({ label: "Verbindung", status: main.ok ? "pass" : "fail", detail: main.message });
    const agents = Object.keys(env)
      .filter(name => name.startsWith(AGENT_TOKEN_PREFIX) && presentValue(env, name))
      .sort();
    for (const name of agents) {
      const id = name.slice(AGENT_TOKEN_PREFIX.length).toLowerCase().replace(/_/g, "-");
      const bot = await ctx.providers.telegramGetMe(env[name].trim());
      found.push({ label: `Agenten-Bot ${id}`, status: bot.ok ? "pass" : "fail", detail: bot.ok ? bot.message : `${name}: ${bot.message}` });
    }
    return found;
  },
};

/** messages muss lesbar sein, memory sollte es; dazu der Hinweis auf alte Datenbank-Einstellungen */
export const databaseCheck: SpecialCheck = {
  id: "datenbank",
  section: "Datenbank",
  async run({ ctx, env }) {
    const found: Finding[] = [];
    const legacy = legacyDatabaseNotice(env);
    if (legacy) found.push({ label: "Alte Einstellung", status: "warn", detail: legacy });
    const url = presentValue(env, "SUPABASE_URL");
    const key = presentValue(env, "SUPABASE_SERVICE_ROLE_KEY") ?? presentValue(env, "SUPABASE_ANON_KEY");
    if (!url || !key) {
      found.push({ label: "Verbindung", status: "skip", detail: `Übersprungen: Supabase ist nicht vollständig eingetragen (${BRAND.cli} setup datenbank)` });
      return found;
    }
    const messages = await ctx.providers.supabaseQuery(url, key);
    found.push({ label: "Verbindung", status: messages.ok ? "pass" : "fail", detail: messages.message });
    if (messages.ok) found.push(await memoryTable(ctx, url, key));
    return found;
  },
};

async function memoryTable(ctx: SetupContext, url: string, key: string): Promise<Finding> {
  const label = "Tabelle memory";
  try {
    const res = await ctx.fetch(`${url.replace(/\/+$/, "")}/rest/v1/memory?select=id&limit=1`, { headers: supabaseHeaders(key), timeoutMs: TABLE_TIMEOUT_MS });
    await res.body?.cancel().catch(() => {});
    if (res.ok) return { label, status: "pass", detail: "lesbar" };
    if (res.status === 404) return { label, status: "warn", detail: "fehlt: das Gedächtnis (Fakten, Ziele) ist nicht verfügbar, db/schema.sql ausführen" };
    return { label, status: "warn", detail: `nicht lesbar (HTTP ${res.status})` };
  } catch (e) {
    return { label, status: "warn", detail: `nicht erreichbar (${e instanceof Error ? e.name : "Fehler"})` };
  }
}

/** Schlüssel für Zusatzfunktionen: nur ob gesetzt, kein Aufruf */
const EXTRA_KEYS = [
  { key: "ELEVENLABS_API_KEY", label: "ElevenLabs (Stimme)" },
  { key: "GEMINI_API_KEY", label: "Gemini (Transkription)" },
  { key: "OPENROUTER_API_KEY", label: "OpenRouter (Ersatzmodell)" },
];

export const extrasCheck: SpecialCheck = {
  id: "zusatz",
  section: "Zusatzfunktionen",
  async run({ env }) {
    return EXTRA_KEYS.map(({ key, label }) =>
      presentValue(env, key) ? { label, status: "pass" as const, detail: "eingerichtet" } : { label, status: "skip" as const, detail: "nicht eingerichtet" },
    );
  },
};

export const servicesCheck: SpecialCheck = {
  id: "dienste",
  section: "Dienste",
  run: ({ ctx, env }) => serviceFindings(ctx, env),
};

export const speechCheck: SpecialCheck = {
  id: "sprache",
  section: "Sprache",
  run: async ({ ctx, env }) => speechFindings(ctx, env),
};

/**
 * Claude Code für den Telefonhörer, geprüft wie inspectEngine und
 * checkCliFlags, aber wie jeder Claude-Aufruf des Berichts mit
 * claudeRunContext: CLAUDE_PATH, CLAUDE_AUTH und ANTHROPIC_API_KEY aus der .env des
 * Projekts, im Projektordner, über ctx.run. Die Version kommt aus dem
 * Anbieter des Berichts (schon vom Schritt Voraussetzungen gefragt, mit
 * demselben Ordner und derselben Umgebung), Anmeldung und Flags je einmal.
 */
export async function claudeCallDeps(ctx: SetupContext, env: Env): Promise<Pick<CallModelDeps, "inspectClaude" | "cliFlags">> {
  const { CLAUDE_NOT_INSTALLED, CLAUDE_NOT_LOGGED_IN, CLAUDE_LOGIN_UNKNOWN, parseClaudeLogin } = await import("../../lib/engines/check");
  const { missingCliFlags } = await import("../../lib/voice-brain/backends/claude-cli");
  const { claudeAuthProblem } = await import("../../lib/engines/claude-auth");
  const path = presentValue(env, "CLAUDE_PATH") ?? "claude";
  const run = claudeRunContext(ctx, env);
  const claude = (args: string[]) => ctx.run([path, ...args], { ...run, timeoutMs: CLAUDE_TIMEOUT_MS });
  let status: Promise<EngineStatus> | undefined;
  let flags: Promise<{ missing: string[] } | null> | undefined;
  return {
    inspectClaude: () =>
      (status ??= (async (): Promise<EngineStatus> => {
        const base = { engine: "claude" as const, checked: true };
        const version = await ctx.providers.claudeVersion(path, run);
        if (!version.ok) return { ...base, installed: false, loggedIn: false, message: version.notFound ? CLAUDE_NOT_INSTALLED : version.message };
        // CLAUDE_AUTH=apiKey ohne Schlüssel in der .env: nicht angemeldet, ohne die CLI zu fragen (Issue #349)
        const authProblem = claudeAuthProblem(run.env);
        if (authProblem) return { ...base, installed: true, loggedIn: false, message: authProblem };
        const loggedIn = parseClaudeLogin((await claude(["auth", "status", "--json"])).stdout);
        if (loggedIn === true) return { ...base, installed: true, loggedIn: true };
        if (loggedIn === false) return { ...base, installed: true, loggedIn: false, message: CLAUDE_NOT_LOGGED_IN };
        return { ...base, installed: true, loggedIn: false, loginUnknown: true, message: CLAUDE_LOGIN_UNKNOWN };
      })()),
    cliFlags: () =>
      (flags ??= (async () => {
        const help = await claude(["--help"]);
        return help.code === 0 ? { missing: missingCliFlags(help.stdout) } : null;
      })()),
  };
}

/** Telefonhörer: nur ob ein Modellweg bereit ist, nie ein Modellaufruf; deps ersetzen in Tests einzelne Prüfungen */
export function callCheck(deps: Partial<CallModelDeps> = {}): SpecialCheck {
  return {
    id: "telefonhoerer",
    section: "Sprache",
    run: async ({ ctx, env }) => [await callFinding(ctx, env, { ...(await claudeCallDeps(ctx, env)), ...deps })],
  };
}

/** Alle Spezialprüfungen in der Reihenfolge des Berichts */
export function defaultSpecials(options: { callModel?: Partial<CallModelDeps> } = {}): SpecialCheck[] {
  return [telegramCheck, databaseCheck, servicesCheck, extrasCheck, speechCheck, callCheck(options.callModel)];
}
