/**
 * Kleine Ports zu den Anbietern der Einrichtung. Jede Prüfung liefert ein
 * Ergebnis in Klartext und reicht nie ein Geheimnis oder eine rohe
 * Anbieter-Antwort durch (redact). Netz und Befehle kommen von außen, damit
 * Tests ohne Netz laufen.
 *
 * Alle Prüfungen lesen nur. Ausnahme: sendTelegramTest schickt eine
 * Testnachricht an die eigene Nutzer-ID, darum geht es dort.
 */

import { claudeAuthProblem } from "../lib/engines/claude-auth";
import { openCodeProviderKeysIn, parseOpenCodeAuthList } from "../lib/engines/check";
import { parseOpenCodeVersion } from "../lib/engines/opencode";
import { filterSubprocessEnv, SUBPROCESS_MARKER } from "../lib/subprocess-env";
import { supabaseHeaders } from "../lib/supabase-keys";
import type { CommandRunner, HttpFetch } from "./context";
import { redact } from "./model";

export interface ProbeResult {
  ok: boolean;
  message: string;
}

export interface ClaudeVersionResult extends ProbeResult {
  /**
   * Nur gesetzt, wenn der Befehl in keinem PATH-Ordner liegt (spawnError
   * „ENOENT“). Startet er, meldet aber keine Version, fehlt das Feld: dann ist
   * die CLI da, aber defekt, kein bloßes PATH-Problem.
   */
  notFound?: boolean;
}

export interface TelegramBotInfo extends ProbeResult {
  username?: string;
}

/** Wo und mit welcher Umgebung claude --version läuft (Standard: wie der Aufrufer) */
export interface ClaudeRunContext {
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Motor außer Claude Code (Issue #566): Pfad, Ordner und Umgebung der
 * Prüfung, aus der .env des Projekts (CODEX_PATH, OPENCODE_PATH), nicht aus
 * der Shell der Einrichtung
 */
export interface EngineRunContext {
  signal?: AbortSignal;
  path?: string;
  cwd?: string;
  env?: Record<string, string>;
}

/** Motoren, die die Einrichtung selbst prüft; Claude Code prüft der Schritt „voraussetzungen“ */
export type CheckedEngine = "codex" | "opencode" | "api";

export interface OllamaResult extends ProbeResult {
  models?: string[];
}

export interface Providers {
  telegramGetMe(token: string): Promise<TelegramBotInfo>;
  telegramSendTest(token: string, userId: string, text: string): Promise<ProbeResult>;
  telegramCheckGroup(token: string, chatId: string): Promise<ProbeResult>;
  supabaseQuery(url: string, key: string): Promise<ProbeResult>;
  /**
   * Schreibprobe (Issue #305): Testzeile in memory anlegen und über ihre id
   * wieder löschen. Stichprobe für die Rechte (Issue #437): memory braucht
   * Tabellenrecht und die Sequenz; dass alle Tabellen ihre Rechte bekommen,
   * belegt tests/schema-grants-pg.test.ts.
   */
  supabaseWriteProbe(url: string, key: string): Promise<ProbeResult>;
  /** context: Ordner und Umgebung des Aufrufs (ohne: gefilterte Umgebung dieses Prozesses) */
  claudeVersion(claudePath: string, context?: ClaudeRunContext): Promise<ClaudeVersionResult>;
  /** Echter Probeaufruf; context wie bei claudeVersion */
  claudeProbe(claudePath: string, context?: ClaudeRunContext): Promise<ProbeResult>;
  /**
   * Ist der Motor installiert und angemeldet (Issue #566)? Wie checkEngine
   * aus src/lib/engines/check.ts, aber mit dem Befehlsläufer der
   * Einrichtung und dem Kontext oben: Codex mit `codex --version` und
   * `codex login status`, OpenCode mit `opencode --version` und
   * `opencode auth list`, die Anthropic API über den Schlüssel in der
   * Umgebung. Kein Modellaufruf; von den Ausgaben gehen nur
   * Versionsnummer und Anbieternamen weiter.
   */
  engineCheck(engine: CheckedEngine, context?: EngineRunContext): Promise<ProbeResult>;
  openrouterKey(key: string): Promise<ProbeResult>;
  ollamaTags(): Promise<OllamaResult>;
}

export interface ProviderDeps {
  fetch: HttpFetch;
  run: CommandRunner;
  /** Umgebung des Claude-Probeaufrufs, Standard: gefilterte Subprozess-Umgebung */
  subprocessEnv?(): Record<string, string>;
}

export const TELEGRAM_API = "https://api.telegram.org";
export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
export const OLLAMA_TAGS_URL = "http://localhost:11434/api/tags";
const CLAUDE_PROBE_TIMEOUT_MS = 90_000;
const ENGINE_CHECK_TIMEOUT_MS = 10_000;

export const CODEX_MISSING = "Codex nicht gefunden (anderer Pfad über CODEX_PATH in .env). Installieren: npm install -g @openai/codex";
export const CODEX_LOGGED_OUT = "Codex ist nicht angemeldet. Im Terminal „codex login“ ausführen.";
export const OPENCODE_MISSING = "OpenCode nicht gefunden (anderer Pfad über OPENCODE_PATH in .env).";
export const OPENCODE_LOGGED_OUT = "OpenCode ist nicht angemeldet. Im Terminal „opencode auth login“ ausführen.";
export const API_KEY_ABSENT = "Für den Motor Anthropic API fehlt ANTHROPIC_API_KEY in der .env.";

/**
 * Nur die Versionsnummer aus einer Befehlsausgabe (etwa „2.1.300“), sonst
 * nichts. Der Rest der Ausgabe kann alles enthalten, auch Geheimnisse aus
 * einem Wrapper-Skript, und wird deshalb nie weitergereicht.
 */
export function versionOnly(output: string): string | null {
  return /\b\d+\.\d+(?:\.\d+)?\b/.exec(output)?.[0] ?? null;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function jsonOf(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Inhalt der Testzeile; die Zufallszahl hält zwei Proben auseinander */
export const WRITE_PROBE_PREFIX = "tybo-einrichtung: Schreibprobe";

/** Migration, die die Rechte der Grundtabellen setzt (Issue #437) */
export const GRANTS_MIGRATION = "db/migrations/20261021_base_grants.sql";

/**
 * Ob Supabase mit „permission denied“ antwortet (Postgres-Fehlercode 42501,
 * PostgREST: HTTP 401 oder 403). Liefert dann das genannte Objekt, etwa
 * „sequence memory_id_seq“, aber nur in dieser geprüften Form, nie die rohe
 * Antwort. Sonst null.
 */
async function permissionDenied(res: Response): Promise<{ object: string | null } | null> {
  if (res.status !== 401 && res.status !== 403) return null;
  const data = await jsonOf(res);
  if (String(data?.code ?? "") !== "42501") return null;
  const match = /permission denied for (table|sequence|schema) ([A-Za-z0-9_.]{1,127})\b/.exec(String(data?.message ?? ""));
  return { object: match ? `${match[1]} ${match[2]}` : null };
}

/**
 * Meldung bei fehlendem Recht: Ursache (Supabase vergibt Rechte nicht mehr
 * von selbst) und die gezielte Reparatur. Nicht db/schema.sql neu einspielen,
 * das setzt Policies und Suchfunktionen auf die Grundfassung zurück.
 */
export function missingRightMessage(doing: string, object: string | null): string {
  return [
    `Supabase verweigert dem Schlüssel das Recht, ${doing} (permission denied${object ? ` for ${object}` : ""}).`,
    "Supabase gibt Tabellen seit 2026 nicht mehr von selbst für den Zugriff frei.",
    `Abhilfe: den Inhalt von ${GRANTS_MIGRATION} im SQL-Editor von Supabase ausführen; bei Supabase in der Cloud erledigt das auch „tybo setup datenbank“ mit „Supabase in der Cloud“.`,
    "Bleibt der Fehler, ist der Schlüssel nicht der Secret-Schlüssel (sb_secret_…) bzw. service_role.",
  ].join(" ");
}

/** id einer neu angelegten Zeile (memory.id ist BIGSERIAL), sonst null */
function insertedId(rows: unknown): number | null {
  const id = Array.isArray(rows) && rows.length === 1 ? (rows[0] as { id?: unknown })?.id : undefined;
  const n = typeof id === "string" && /^\d+$/.test(id) ? Number(id) : id;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function createProviders(deps: ProviderDeps): Providers {
  const { fetch, run } = deps;
  const probeEnv = deps.subprocessEnv ?? (() => ({ ...filterSubprocessEnv().env, ...SUBPROCESS_MARKER }));

  async function telegram(token: string, method: string, body?: Record<string, unknown>) {
    const url = `${TELEGRAM_API}/bot${token}/${method}`;
    const res = await fetch(
      url,
      body
        ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : { method: "GET" },
    );
    const data = await jsonOf(res);
    return { status: res.status, data };
  }

  function telegramDown(e: unknown, token: string): ProbeResult {
    return { ok: false, message: `Telegram ist nicht erreichbar (${redact(errorText(e), [token], 120)}). Internetverbindung prüfen.` };
  }

  return {
    async telegramGetMe(token) {
      try {
        const { status, data } = await telegram(token, "getMe");
        if (data?.ok && data.result?.username) {
          return { ok: true, message: `Verbunden mit @${data.result.username}`, username: String(data.result.username) };
        }
        if (status === 401 || status === 404) {
          return { ok: false, message: "Telegram lehnt das Token ab. Bitte das Token bei @BotFather prüfen oder neu erzeugen." };
        }
        return { ok: false, message: `Telegram antwortet mit einem Fehler (HTTP ${status}).` };
      } catch (e) {
        return telegramDown(e, token);
      }
    },

    async telegramSendTest(token, userId, text) {
      try {
        const { status, data } = await telegram(token, "sendMessage", { chat_id: userId, text });
        if (data?.ok) return { ok: true, message: "Testnachricht verschickt. Sie sollte jetzt in Telegram zu sehen sein." };
        const description = String(data?.description ?? "").toLowerCase();
        if (description.includes("chat not found")) {
          return {
            ok: false,
            message: "Telegram kennt diese Nutzer-ID nicht, oder du hast dem Bot noch nie geschrieben. Öffne den Bot in Telegram, tippe auf Start und teste erneut.",
          };
        }
        if (status === 403) {
          return { ok: false, message: "Der Bot darf dir nicht schreiben (blockiert oder falsche Nutzer-ID). Bot in Telegram entsperren und Start tippen." };
        }
        if (status === 401 || status === 404) {
          return { ok: false, message: "Telegram lehnt das Token ab. Bitte das Token bei @BotFather prüfen." };
        }
        return { ok: false, message: `Die Testnachricht ging nicht raus (HTTP ${status}).` };
      } catch (e) {
        return telegramDown(e, token);
      }
    },

    async telegramCheckGroup(token, chatId) {
      try {
        const chat = await telegram(token, "getChat", { chat_id: chatId });
        if (!chat.data?.ok) {
          if (chat.status === 401 || chat.status === 404) {
            return { ok: false, message: "Telegram lehnt das Token ab. Erst den Schritt Telegram einrichten." };
          }
          return { ok: false, message: "Gruppe nicht gefunden. Ist der Bot Mitglied der Gruppe, und stimmt die Gruppen-ID?" };
        }
        if (!chat.data.result?.is_forum) {
          return { ok: false, message: "Die Gruppe hat keine Themen. In Telegram unter Gruppe bearbeiten „Themen“ einschalten." };
        }
        const botId = token.split(":")[0];
        const member = await telegram(token, "getChatMember", { chat_id: chatId, user_id: Number(botId) });
        const role = member.data?.result?.status;
        if (role !== "administrator" && role !== "creator") {
          return { ok: false, message: "Der Bot ist in der Gruppe kein Admin. Ohne Admin-Rechte kann er keine Themen anlegen." };
        }
        return { ok: true, message: "Forum-Gruppe gefunden, der Bot ist Admin." };
      } catch (e) {
        return telegramDown(e, token);
      }
    },

    async supabaseQuery(url, key) {
      const base = url.replace(/\/+$/, "");
      try {
        const res = await fetch(`${base}/rest/v1/messages?select=id&limit=1`, {
          headers: supabaseHeaders(key),
        });
        if (res.ok) return { ok: true, message: "Supabase erreichbar, Tabelle messages lesbar." };
        const denied = await permissionDenied(res);
        if (denied) return { ok: false, message: missingRightMessage("aus der Tabelle messages zu lesen", denied.object) };
        if (res.status === 401 || res.status === 403) {
          return { ok: false, message: "Supabase lehnt den Schlüssel ab. Den Secret-Schlüssel (sb_secret_…) oder service_role aus Project Settings, API Keys nehmen." };
        }
        if (res.status === 404 || res.status === 406) {
          return { ok: false, message: "Die Tabelle messages fehlt. db/schema.sql im SQL-Editor von Supabase ausführen." };
        }
        return { ok: false, message: `Supabase antwortet mit einem Fehler (HTTP ${res.status}).` };
      } catch (e) {
        return { ok: false, message: `Supabase ist nicht erreichbar (${redact(errorText(e), [key], 120)}). Adresse prüfen.` };
      }
    },

    async supabaseWriteProbe(url, key) {
      const table = `${url.replace(/\/+$/, "")}/rest/v1/memory`;
      const headers = { ...supabaseHeaders(key), "Content-Type": "application/json", Prefer: "return=representation" };
      const content = `${WRITE_PROBE_PREFIX} ${crypto.randomUUID()}`;
      let id: number | null;
      try {
        const res = await fetch(table, { method: "POST", headers, body: JSON.stringify({ type: "fact", content }) });
        const denied = await permissionDenied(res);
        if (denied) return { ok: false, message: missingRightMessage("in die Tabelle memory zu schreiben", denied.object) };
        if (res.status === 401 || res.status === 403) {
          return { ok: false, message: "Supabase lässt mit diesem Schlüssel nicht in memory schreiben. Den Secret-Schlüssel (sb_secret_…) oder service_role nehmen." };
        }
        if (res.status === 404) {
          return { ok: false, message: "Die Tabelle memory fehlt. db/schema.sql im SQL-Editor von Supabase ausführen." };
        }
        if (!res.ok) return { ok: false, message: `Die Schreibprobe in memory ist fehlgeschlagen (HTTP ${res.status}).` };
        id = insertedId(await jsonOf(res));
      } catch (e) {
        return { ok: false, message: `Supabase ist beim Schreiben nicht erreichbar (${redact(errorText(e), [key], 120)}).` };
      }
      const leftover = `In der Tabelle memory die Zeile, die mit „${WRITE_PROBE_PREFIX}“ beginnt, von Hand löschen.`;
      if (id === null) {
        return { ok: false, message: `Schreiben in memory geht, aber Supabase nannte keine id der Testzeile, sie wurde nicht gelöscht. ${leftover}` };
      }
      try {
        const res = await fetch(`${table}?id=eq.${id}`, { method: "DELETE", headers });
        const denied = await permissionDenied(res);
        if (denied) {
          return { ok: false, message: `Schreiben in memory geht, aber die Testzeile ließ sich nicht löschen. ${missingRightMessage("aus der Tabelle memory zu löschen", denied.object)} ${leftover}` };
        }
        // Ohne Löschrecht antwortet Supabase mit 200 und leerer Liste: nur eine zurückgegebene Zeile bestätigt das Löschen
        if (res.ok && insertedId(await jsonOf(res)) === id) {
          return { ok: true, message: "Schreibprobe bestanden: Testzeile in memory angelegt und wieder gelöscht." };
        }
        return { ok: false, message: `Schreiben in memory geht, aber die Testzeile ließ sich nicht löschen${res.ok ? "" : ` (HTTP ${res.status})`}. ${leftover}` };
      } catch (e) {
        return { ok: false, message: `Schreiben in memory geht, aber beim Löschen der Testzeile ist Supabase nicht erreichbar (${redact(errorText(e), [key], 120)}). ${leftover}` };
      }
    },

    async claudeVersion(claudePath, context = {}) {
      // Ohne Kontext die gefilterte Umgebung wie bei der Probe, nie die ungefilterte dieses Prozesses (Issue #349)
      const res = await run([claudePath, "--version"], { timeoutMs: 15_000, env: context.env ?? probeEnv(), ...(context.cwd ? { cwd: context.cwd } : {}) });
      if (res.code === 0 && res.stdout) {
        const version = versionOnly(res.stdout);
        return { ok: true, message: version ? `Claude CLI ${version}` : "Claude CLI gefunden." };
      }
      if (res.code === -1 && res.spawnError === "ENOENT") return { ok: false, message: "Claude CLI nicht gefunden.", notFound: true };
      return { ok: false, message: "Die Claude CLI ist da, startet aber nicht richtig („claude --version“ scheitert). Neu installieren." };
    },

    async claudeProbe(claudePath, context = {}) {
      // CLAUDE_AUTH=apiKey ohne Schlüssel: kein Aufruf, sonst liefe die Probe still über das Abo
      const problem = claudeAuthProblem(context.env ?? process.env);
      if (problem) return { ok: false, message: problem };
      const res = await run(
        [claudePath, "-p", "Antworte nur mit OK", "--output-format", "json", "--model", "haiku", "--max-turns", "1"],
        { timeoutMs: CLAUDE_PROBE_TIMEOUT_MS, env: context.env ?? probeEnv(), ...(context.cwd ? { cwd: context.cwd } : {}) },
      );
      if (res.timedOut) return { ok: false, message: "Claude CLI antwortet nicht (Zeitlimit überschritten)." };
      let data: any = null;
      try {
        data = JSON.parse(res.stdout);
      } catch {
        // keine JSON-Antwort, unten nach stderr entscheiden
      }
      const text = `${data?.result ?? ""} ${res.stderr}`.toLowerCase();
      if (res.code === 0 && data && data.is_error !== true) return { ok: true, message: "Claude CLI ist angemeldet und antwortet." };
      if (text.includes("login") || text.includes("logged in") || text.includes("api key") || text.includes("authentication")) {
        return { ok: false, message: "Claude CLI ist nicht angemeldet. Im Terminal „claude“ starten und /login ausführen." };
      }
      if (text.includes("limit")) return { ok: false, message: "Claude CLI ist angemeldet, aber das Nutzungslimit ist erreicht." };
      return { ok: false, message: "Der Probeaufruf der Claude CLI ist fehlgeschlagen. Im Terminal „claude“ starten und prüfen." };
    },

    async engineCheck(engine, context = {}) {
      const env = context.env ?? probeEnv();
      if (engine === "api") {
        return env.ANTHROPIC_API_KEY?.trim() ? { ok: true, message: "Anthropic API: Schlüssel ist gesetzt." } : { ok: false, message: API_KEY_ABSENT };
      }
      const name = engine === "codex" ? "Codex" : "OpenCode";
      const path = context.path || engine;
      const options = { timeoutMs: ENGINE_CHECK_TIMEOUT_MS, env, ...(context.cwd ? { cwd: context.cwd } : {}), ...(context.signal ? { signal: context.signal } : {}) };
      const version = await run([path, "--version"], options);
      if (version.code === -1 && version.spawnError === "ENOENT") return { ok: false, message: engine === "codex" ? CODEX_MISSING : OPENCODE_MISSING };
      if (version.timedOut) return { ok: false, message: `${name} antwortet nicht („${engine} --version“ brauchte zu lange).` };
      if (version.code !== 0) return { ok: false, message: `${name} ist da, startet aber nicht richtig („${engine} --version“ scheitert).` };
      if (engine === "codex") {
        const v = versionOnly(version.stdout);
        const login = await run([path, "login", "status"], options);
        if (login.code === 0) return { ok: true, message: `Codex${v ? ` ${v}` : ""} ist angemeldet.` };
        if (login.timedOut) return { ok: false, message: "Codex-Anmeldung nicht prüfbar („codex login status“ brauchte zu lange)." };
        return { ok: false, message: CODEX_LOGGED_OUT };
      }
      const parsed = parseOpenCodeVersion(version.stdout.slice(0, 200));
      if (!parsed) return { ok: false, message: "OpenCode meldet keine erkennbare Version." };
      if (parsed.major !== 1) return { ok: false, message: `OpenCode ${parsed.version} wird nicht unterstützt, nötig ist Version 1.` };
      const login = await run([path, "auth", "list"], options);
      const list = login.code === 0 ? parseOpenCodeAuthList(login.stdout) : null;
      if ((list && list.count > 0) || openCodeProviderKeysIn(env).length > 0) return { ok: true, message: `OpenCode ${parsed.version} ist angemeldet.` };
      return { ok: false, message: list ? OPENCODE_LOGGED_OUT : "OpenCode-Anmeldung nicht prüfbar („opencode auth list“ scheitert)." };
    },

    async openrouterKey(key) {
      try {
        const res = await fetch(OPENROUTER_KEY_URL, { headers: { Authorization: `Bearer ${key}` } });
        if (res.ok) return { ok: true, message: "OpenRouter nimmt den Schlüssel an." };
        if (res.status === 401 || res.status === 403) return { ok: false, message: "OpenRouter lehnt den Schlüssel ab." };
        return { ok: false, message: `OpenRouter antwortet mit einem Fehler (HTTP ${res.status}).` };
      } catch (e) {
        return { ok: false, message: `OpenRouter ist nicht erreichbar (${redact(errorText(e), [key], 120)}).` };
      }
    },

    async ollamaTags() {
      try {
        const res = await fetch(OLLAMA_TAGS_URL, { timeoutMs: 3_000 });
        if (!res.ok) return { ok: false, message: `Ollama antwortet mit einem Fehler (HTTP ${res.status}).` };
        const data = await jsonOf(res);
        const models = Array.isArray(data?.models)
          ? data.models.map((m: any) => String(m?.name ?? "")).filter(Boolean)
          : [];
        return { ok: true, message: `Ollama läuft (${models.length} Modelle).`, models };
      } catch {
        return { ok: false, message: "Ollama läuft nicht auf diesem Rechner (localhost:11434). Ollama starten oder installieren: https://ollama.com" };
      }
    },
  };
}
