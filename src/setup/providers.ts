/**
 * Kleine Ports zu den Anbietern der Einrichtung. Jede Prüfung liefert ein
 * Ergebnis in Klartext und reicht nie ein Geheimnis oder eine rohe
 * Anbieter-Antwort durch (redact). Netz und Befehle kommen von außen, damit
 * Tests ohne Netz laufen.
 *
 * Alle Prüfungen lesen nur. Ausnahme: sendTelegramTest schickt eine
 * Testnachricht an die eigene Nutzer-ID, darum geht es dort.
 */

import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
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

export interface OllamaResult extends ProbeResult {
  models?: string[];
}

export interface Providers {
  telegramGetMe(token: string): Promise<TelegramBotInfo>;
  telegramSendTest(token: string, userId: string, text: string): Promise<ProbeResult>;
  telegramCheckGroup(token: string, chatId: string): Promise<ProbeResult>;
  supabaseQuery(url: string, key: string): Promise<ProbeResult>;
  convexQuery(url: string, token: string): Promise<ProbeResult>;
  claudeVersion(claudePath: string): Promise<ClaudeVersionResult>;
  claudeProbe(claudePath: string): Promise<ProbeResult>;
  openrouterKey(key: string): Promise<ProbeResult>;
  ollamaTags(): Promise<OllamaResult>;
}

/** Lesende Convex-Abfrage; wirft bei Fehlern */
export type ConvexReader = (url: string, token: string) => Promise<void>;

export interface ProviderDeps {
  fetch: HttpFetch;
  run: CommandRunner;
  convex?: ConvexReader;
  /** Umgebung des Claude-Probeaufrufs, Standard: gefilterte Subprozess-Umgebung */
  subprocessEnv?(): Record<string, string>;
}

export const TELEGRAM_API = "https://api.telegram.org";
export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
export const OLLAMA_TAGS_URL = "http://localhost:11434/api/tags";
const CLAUDE_PROBE_TIMEOUT_MS = 90_000;

/** Nur lesen: offene Rückfragen einer Chat-ID, die es nicht gibt */
const defaultConvexReader: ConvexReader = async (url, token) => {
  const client = new ConvexHttpClient(url);
  client.setAuth(token);
  await client.query(anyApi.asyncTasks.getPending, { chatId: "setup-probe" });
};

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

export function createProviders(deps: ProviderDeps): Providers {
  const { fetch, run } = deps;
  const convex = deps.convex ?? defaultConvexReader;
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

    async convexQuery(url, token) {
      try {
        await convex(url, token);
        return { ok: true, message: "Convex erreichbar, Anmeldung angenommen." };
      } catch (e) {
        const text = errorText(e).toLowerCase();
        if (text.includes("auth") || text.includes("unauthenticated") || text.includes("owner")) {
          return { ok: false, message: "Convex lehnt die Anmeldung ab. CONVEX_AUTH_TOKEN prüfen." };
        }
        if (text.includes("could not find") || text.includes("not found")) {
          return { ok: false, message: "Auf dem Convex-Projekt fehlen die Server-Funktionen. Einmal „npx convex dev --once“ im Projektordner ausführen." };
        }
        return { ok: false, message: `Convex ist nicht erreichbar (${redact(errorText(e), [token], 120)}). Adresse prüfen.` };
      }
    },

    async claudeVersion(claudePath) {
      const res = await run([claudePath, "--version"], { timeoutMs: 15_000 });
      if (res.code === 0 && res.stdout) {
        const version = versionOnly(res.stdout);
        return { ok: true, message: version ? `Claude CLI ${version}` : "Claude CLI gefunden." };
      }
      if (res.code === -1 && res.spawnError === "ENOENT") return { ok: false, message: "Claude CLI nicht gefunden.", notFound: true };
      return { ok: false, message: "Die Claude CLI ist da, startet aber nicht richtig („claude --version“ scheitert). Neu installieren." };
    },

    async claudeProbe(claudePath) {
      const res = await run(
        [claudePath, "-p", "Antworte nur mit OK", "--output-format", "json", "--model", "haiku", "--max-turns", "1"],
        { timeoutMs: CLAUDE_PROBE_TIMEOUT_MS, env: probeEnv() },
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
