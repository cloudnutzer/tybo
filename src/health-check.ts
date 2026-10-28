#!/usr/bin/env bun
/**
 * Nachtcheck (`bun run health`): prüft die wichtigen Funktionen von tybo und
 * schickt einen kurzen Report mit ✅ / ⚠️ / ❌ je Punkt über die Outbox
 * (Telegram und WebUI). Läuft täglich um 03:30 als launchd-Dienst
 * ai.tybo.health-check (Dienstkatalog src/lib/services/catalog.ts).
 *
 * Anlass: vom 9. bis 30.9.2026 lehnte die Edge Function store-telegram-message
 * den Bot mit 401 ab, saveMessage schrieb still ohne Embedding. Die Prüfung
 * „Embeddings Nachrichten 24h“ hätte das nach einem Tag gemeldet.
 *
 * Jede Prüfung hat ein Zeitlimit, ein Fehler stoppt die anderen nicht. Nicht
 * eingerichtete Teile stehen als „–“ im Report, nie als Fehler. Nichts wird
 * in die Datenbank geschrieben; die Edge Functions bekommen nur `{}` (400 =
 * erreichbar und Schlüssel angenommen). Geheimnisse landen nie im Report
 * (redact), Adressen mit Token nie in Fehlertexten.
 *
 *   bun run health               prüfen und Report senden
 *   bun run health --no-send     nur ausgeben
 *   bun run health --no-model    ohne Mini-Aufruf an Haiku
 *
 * Exit-Code: 0 Report gesendet bzw. ausgegeben (auch mit Problemen), 1 Senden scheiterte.
 */

import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadEnv, PROJECT_ROOT } from "./lib/env";
import { atomicWriteFile } from "./lib/atomic-file";
import { supabaseHeaders } from "./lib/supabase-keys";
import { findLaunchctlLine, LAUNCHD_PREFIX, BOT_SERVICE } from "./lib/service-names";
import { isSecretName } from "./lib/subprocess-env";
import { loadWebConfig } from "./web/config";
import type { JobStatus } from "./lib/jobs/store";
import { UPDATE_STATE_FILE, type UpdateState } from "./software-update";
import { readRoutinesSummary, type RoutinesSummary } from "./lib/routines/alerts";
import { defaultRoutinesDeps, listRoutines } from "./lib/routines/catalog";
import { whenText } from "./lib/routines/format";
import { summarizePunctuality, type PunctualSummary } from "./lib/routines/punctual";
import { systemTimeZone } from "./lib/routines/schedule";

// ---------------------------------------------------------------------------
// Typen und Rahmen
// ---------------------------------------------------------------------------

export type CheckStatus = "ok" | "warn" | "fail" | "na";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  /** Kurzer Befund, bei warn/fail der Grund */
  detail?: string;
  /** Nächster Schritt bei warn/fail */
  hint?: string;
}

type Env = Record<string, string | undefined>;

export const DEFAULT_TIMEOUT_MS = 15_000;
export const CLAUDE_TIMEOUT_MS = 120_000;
/** Mindestanteil an Vektoren, darunter ❌ */
export const EMBEDDING_MIN_RATIO = 0.9;
export const MIN_FREE_BYTES = 10 * 1024 ** 3;
/** Unter diesem freien Platz ⚠️ */
export const WARN_FREE_BYTES = 25 * 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Software-Updates: älter als das ⚠️ (Dienst läuft täglich) */
const UPDATE_MAX_AGE_MS = 3 * DAY_MS;
/** Laufende Jobs gelten erst so lange nach ihrer Frist als hängend */
const JOB_GRACE_MS = 15 * 60 * 1000;
const STATE_FILE = join(PROJECT_ROOT, "data", "health-check-state.json");
const HEALTH_SERVICE = "health-check";
const TUNNEL_SERVICE = "cloudflare-tunnel";
const UPDATE_SERVICE = "software-update";

const ICON: Record<CheckStatus, string> = { ok: "✅", warn: "⚠️", fail: "❌", na: "–" };

/** Werte geheimer Variablen (…_TOKEN, …_KEY, …) aus Texten entfernen */
export function redact(text: string, env: Env = process.env): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !isSecretName(name)) continue;
    out = out.split(value).join("***");
  }
  return out;
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return "Zeitlimit überschritten";
    return `${err.name}: ${err.message}`.slice(0, 160);
  }
  return String(err).slice(0, 160);
}

class CheckTimeout extends Error {
  name = "CheckTimeout";
}

/** Prüfung mit Zeitlimit; wirft sie oder läuft sie zu lange, wird sie ❌ */
export async function runCheck(
  name: string,
  fn: () => Promise<CheckResult | CheckResult[]>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<CheckResult[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CheckTimeout()), timeoutMs);
      }),
    ]);
    return Array.isArray(result) ? result : [result];
  } catch (err) {
    const detail = err instanceof CheckTimeout ? `keine Antwort nach ${Math.round(timeoutMs / 1000)} s` : errorText(err);
    return [{ name, status: "fail", detail }];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS - 2_000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function run(cmd: string[], options: { cwd?: string; env?: Env; timeoutMs?: number } = {}): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd ?? PROJECT_ROOT,
    env: (options.env ?? process.env) as Record<string, string>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS - 2_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code: proc.signalCode ? null : code, stdout: stdout.trim(), stderr: stderr.trim() };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export function shortDate(now: Date, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "numeric", timeZone }).format(now);
  } catch {
    return new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "numeric" }).format(now);
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Erste Zeile Gesamtstatus, dann eine Zeile pro Prüfung */
export function formatReport(results: CheckResult[], now: Date, timeZone?: string): string {
  const fails = results.filter(r => r.status === "fail").length;
  const warns = results.filter(r => r.status === "warn").length;
  const summary =
    fails + warns === 0
      ? "alles grün"
      : [fails ? plural(fails, "Problem", "Probleme") : "", warns ? plural(warns, "Warnung", "Warnungen") : ""]
          .filter(Boolean)
          .join(", ");
  const lines = [`tybo Nachtcheck ${shortDate(now, timeZone)}: ${summary}`];
  // Probleme zuerst, dann Warnungen, dann der Rest in fester Reihenfolge
  const order: Record<CheckStatus, number> = { fail: 0, warn: 1, ok: 2, na: 3 };
  const sorted = results.map((r, i) => ({ r, i })).sort((a, b) => order[a.r.status] - order[b.r.status] || a.i - b.i);
  for (const { r } of sorted) {
    let line = `${ICON[r.status]} ${r.name}`;
    if (r.detail) line += `: ${r.detail}`;
    if (r.hint && (r.status === "fail" || r.status === "warn")) line += `. ${r.hint}`;
    lines.push(line);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// launchd
// ---------------------------------------------------------------------------

export interface LaunchdEntry {
  service: string;
  pid: number | null;
  lastExit: number | null;
}

/** Zeilen von `launchctl list` (PID, Status, Label) für ai.tybo.* */
export function parseLaunchctlList(stdout: string): LaunchdEntry[] {
  const entries: LaunchdEntry[] = [];
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const label = parts[parts.length - 1];
    if (!label.startsWith(LAUNCHD_PREFIX)) continue;
    const pid = /^\d+$/.test(parts[0]) ? Number(parts[0]) : null;
    const lastExit = /^-?\d+$/.test(parts[1]) ? Number(parts[1]) : null;
    entries.push({ service: label.slice(LAUNCHD_PREFIX.length), pid, lastExit });
  }
  return entries;
}

let launchctlCache: Promise<string> | null = null;
function launchctlList(): Promise<string> {
  launchctlCache ??= run(["launchctl", "list"]).then(r => {
    if (r.code !== 0) throw new Error("launchctl list scheiterte");
    return r.stdout;
  });
  return launchctlCache;
}

function plistExists(service: string): boolean {
  return existsSync(join(process.env.HOME ?? "", "Library", "LaunchAgents", `${LAUNCHD_PREFIX}${service}.plist`));
}

async function checkBotProcess(): Promise<CheckResult> {
  const name = "Bot-Prozess";
  if (process.platform !== "darwin") return { name, status: "na", detail: "nur macOS (launchd)" };
  const line = findLaunchctlLine(await launchctlList(), BOT_SERVICE);
  if (!line) return { name, status: "fail", detail: "ai.tybo.telegram-relay nicht geladen", hint: "tybo setup autostart" };
  const [entry] = parseLaunchctlList(line);
  if (!entry?.pid) {
    return {
      name,
      status: "fail",
      detail: `geladen, läuft aber nicht (letzter Exit ${entry?.lastExit ?? "?"})`,
      hint: "logs/telegram-relay.error.log ansehen",
    };
  }
  return { name, status: "ok", detail: `läuft (PID ${entry.pid})` };
}

async function checkTunnel(): Promise<CheckResult> {
  const name = "Cloudflare-Tunnel";
  if (process.platform !== "darwin") return { name, status: "na" };
  const line = findLaunchctlLine(await launchctlList(), TUNNEL_SERVICE);
  if (!line) {
    if (!plistExists(TUNNEL_SERVICE)) return { name, status: "na", detail: "nicht eingerichtet" };
    return { name, status: "fail", detail: "Dienst nicht geladen", hint: `launchctl load ~/Library/LaunchAgents/${LAUNCHD_PREFIX}${TUNNEL_SERVICE}.plist` };
  }
  const [entry] = parseLaunchctlList(line);
  if (!entry?.pid) return { name, status: "fail", detail: `läuft nicht (letzter Exit ${entry?.lastExit ?? "?"})`, hint: "logs/cloudflare-tunnel.error.log ansehen" };
  return { name, status: "ok", detail: `läuft (PID ${entry.pid})` };
}

/** Übrige ai.tybo.*-Dienste: laufend oder letzter Exit 0 */
export function evaluateOtherServices(entries: LaunchdEntry[]): CheckResult {
  const name = "Weitere Dienste";
  const others = entries.filter(e => ![BOT_SERVICE, TUNNEL_SERVICE, HEALTH_SERVICE, UPDATE_SERVICE].includes(e.service));
  if (others.length === 0) return { name, status: "na", detail: "keine" };
  const bad = others.filter(e => e.pid === null && e.lastExit !== 0);
  if (bad.length === 0) return { name, status: "ok", detail: others.map(e => e.service).join(", ") };
  return {
    name,
    status: "warn",
    detail: bad.map(e => `${e.service} Exit ${e.lastExit ?? "?"}`).join(", "),
    hint: `logs/${bad[0].service}.error.log ansehen`,
  };
}

async function checkOtherServices(): Promise<CheckResult> {
  if (process.platform !== "darwin") return { name: "Weitere Dienste", status: "na" };
  return evaluateOtherServices(parseLaunchctlList(await launchctlList()));
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

const BOT_LOG = join(PROJECT_ROOT, "logs", "telegram-relay.log");
const BOT_ERROR_LOG = join(PROJECT_ROOT, "logs", "telegram-relay.error.log");

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "gerade eben";
  if (min < 60) return `vor ${min} Min`;
  const h = Math.round(min / 60);
  return h < 48 ? `vor ${h} Std` : `vor ${Math.round(h / 24)} Tagen`;
}

async function checkLogFresh(now: number): Promise<CheckResult> {
  const name = "Bot-Log frisch";
  if (!existsSync(BOT_LOG)) return { name, status: "na", detail: "logs/telegram-relay.log fehlt" };
  const age = now - statSync(BOT_LOG).mtimeMs;
  if (age > DAY_MS) {
    return {
      name,
      status: "warn",
      detail: `zuletzt ${ago(age)} geschrieben`,
      hint: "Läuft der Bot, schreibt aber nicht? Neustart aus dem Terminal oder bun run restart:request",
    };
  }
  return { name, status: "ok", detail: `zuletzt ${ago(age)} geschrieben` };
}

/**
 * Log-Stände für das 24-Stunden-Fenster: die Logs haben keine Zeitstempel
 * pro Zeile. Jeder Lauf merkt sich die Dateigröße; gezählt wird ab dem Stand,
 * der mindestens 24 Stunden alt ist (sonst ab dem ältesten), neue Datei oder
 * kleiner geworden: ab Anfang.
 */
export interface LogSnapshot {
  at: number;
  size: number;
}

export interface HealthState {
  logs: Record<string, LogSnapshot[]>;
}

export function pickBaseline(snapshots: LogSnapshot[], size: number, now: number): { offset: number; since: number | null } {
  const sorted = [...snapshots].sort((a, b) => a.at - b.at);
  const older = sorted.filter(s => s.at <= now - DAY_MS);
  const base = older.length ? older[older.length - 1] : sorted[0];
  if (!base || base.size > size) return { offset: 0, since: null };
  return { offset: base.size, since: base.at };
}

/**
 * Neuen Stand anhängen; behalten werden die letzten 3 Tage und der jüngste
 * ältere Stand. Ist die Datei kleiner geworden (neu angelegt), zählen die
 * alten Stände nicht mehr.
 */
export function nextSnapshots(snapshots: LogSnapshot[], size: number, now: number): LogSnapshot[] {
  const valid = snapshots.some(s => s.size > size) ? [] : snapshots;
  const sorted = [...valid, { at: now, size }].sort((a, b) => a.at - b.at);
  const cutoff = now - 3 * DAY_MS;
  const recent = sorted.filter(s => s.at >= cutoff);
  const older = sorted.filter(s => s.at < cutoff);
  return older.length ? [older[older.length - 1], ...recent] : recent;
}

export function readState(path: string = STATE_FILE): HealthState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed.logs === "object") return parsed as HealthState;
  } catch {
    // erster Lauf oder kaputt: von vorn
  }
  return { logs: {} };
}

function readFrom(path: string, offset: number): string {
  const size = statSync(path).size;
  const length = size - offset;
  if (length <= 0) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, offset);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Muster im Log mit Beschriftung für den Report */
export const LOG_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "timeout (idle)", pattern: /timeout \(idle\)/ },
  { label: "kein Fallback", pattern: /kein Fallback/ },
  { label: "Fallback OpenRouter", pattern: /Fallback: trying OpenRouter/ },
  { label: "Fallback Ollama", pattern: /Fallback: trying Ollama/ },
  { label: "saveMessage ohne Embedding", pattern: /\[saveMessage\] Edge Function/ },
];

export function countLogIssues(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    for (const { label, pattern } of LOG_PATTERNS) {
      if (pattern.test(line)) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return counts;
}

async function checkErrorLog(now: number, state: HealthState, nextState: HealthState): Promise<CheckResult> {
  const name = "Fehler im Log (24h)";
  const files = [BOT_LOG, BOT_ERROR_LOG].filter(p => existsSync(p));
  if (files.length === 0) return { name, status: "na", detail: "keine Logs" };
  const total = new Map<string, number>();
  let since: number | null = now - DAY_MS;
  for (const path of files) {
    const key = path.slice(PROJECT_ROOT.length + 1);
    const size = statSync(path).size;
    const snaps = state.logs[key] ?? [];
    const base = pickBaseline(snaps, size, now);
    if (base.since === null) since = null;
    else if (since !== null && base.since > since) since = base.since;
    for (const [label, n] of countLogIssues(readFrom(path, base.offset))) total.set(label, (total.get(label) ?? 0) + n);
    nextState.logs[key] = nextSnapshots(snaps, size, now);
  }
  const window = since === null ? " (ganzes Log, erster Lauf)" : since > now - DAY_MS + 60_000 ? ` (seit dem Lauf ${ago(now - since)})` : "";
  if (total.size === 0) return { name, status: "ok", detail: `keine Auffälligkeiten${window}` };
  const parts = [...total].map(([label, n]) => `${n}x ${label}`);
  return {
    name,
    status: "warn",
    detail: parts.join(", ") + window,
    hint: "Details in logs/telegram-relay.error.log",
  };
}

// ---------------------------------------------------------------------------
// Telegram, Claude
// ---------------------------------------------------------------------------

async function checkTelegram(env: Env): Promise<CheckResult> {
  const name = "Telegram";
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { name, status: "na", detail: "nicht eingerichtet" };
  const res = await fetchWithTimeout(`https://api.telegram.org/bot${token}/getMe`);
  const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: { username?: string } } | null;
  if (!res.ok || !data?.ok) {
    return {
      name,
      status: "fail",
      detail: `getMe HTTP ${res.status}`,
      hint: res.status === 401 ? "TELEGRAM_BOT_TOKEN ungültig, neuen bei @BotFather holen" : "später erneut prüfen",
    };
  }
  return { name, status: "ok", detail: `@${data.result?.username ?? "?"}` };
}

async function checkClaude(env: Env, withModel: boolean): Promise<CheckResult> {
  const name = "Claude CLI";
  const bin = env.CLAUDE_PATH || "claude";
  const version = await run([bin, "--version"], { timeoutMs: 20_000 }).catch(err => ({ code: -1, stdout: "", stderr: errorText(err) }));
  if (version.code !== 0) {
    return { name, status: "fail", detail: "claude --version scheitert", hint: "PATH im Plist und claude --version im Terminal prüfen" };
  }
  const v = version.stdout.split(/\s+/)[0] ?? version.stdout;
  if (!withModel) return { name, status: "ok", detail: v };

  // Mini-Aufruf mit Haiku: ohne MCP, Werkzeuge, Einstellungen und Sitzung, in
  // einem fremden Ordner (kein CLAUDE.md); TYBO_SUBPROCESS=1 für Hook-Gates
  const started = Date.now();
  const call = await run(
    [
      bin, "-p", "Antworte nur mit: OK",
      "--model", "haiku",
      "--output-format", "json",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--no-session-persistence", "--disable-slash-commands",
      "--tools", "", "--setting-sources", "",
    ],
    { cwd: tmpdir(), env: { ...process.env, TYBO_SUBPROCESS: "1" }, timeoutMs: CLAUDE_TIMEOUT_MS - 5_000 }
  );
  const secs = Math.round((Date.now() - started) / 1000);
  let parsed: { is_error?: boolean; result?: string; api_error_status?: number | null } | null = null;
  try {
    parsed = JSON.parse(call.stdout);
  } catch {
    parsed = null;
  }
  if (call.code !== 0 || !parsed || parsed.is_error) {
    const why = parsed?.api_error_status ? `HTTP ${parsed.api_error_status}` : (parsed?.result ?? call.stderr ?? "").slice(0, 100) || `Exit ${call.code ?? "Zeitlimit"}`;
    return {
      name,
      status: "fail",
      detail: `${v}, Haiku-Aufruf scheitert (${why})`,
      hint: "Anmeldung/Limit prüfen: echo test | claude -p",
    };
  }
  return { name, status: "ok", detail: `${v}, Haiku antwortet (${secs} s)` };
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

interface Supa {
  url: string;
  headers: Record<string, string>;
}

function supabaseFrom(env: Env): Supa | null {
  const url = env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, headers: supabaseHeaders(key) };
}

/** Anzahl Zeilen über PostgREST (HEAD, count=exact); wirft bei Fehler */
async function countRows(sb: Supa, query: string): Promise<number> {
  const res = await fetchWithTimeout(`${sb.url}/rest/v1/${query}`, {
    method: "HEAD",
    headers: { ...sb.headers, Prefer: "count=exact" },
  });
  if (!res.ok) throw new Error(`REST HTTP ${res.status}`);
  const range = res.headers.get("content-range") ?? "";
  const total = Number(range.split("/")[1]);
  if (!Number.isFinite(total)) throw new Error("keine Anzahl in der Antwort");
  return total;
}

const NOT_DISPLAY_ONLY = "or=(metadata->>display_only.is.null,metadata->>display_only.neq.true)";

async function checkSupabaseRest(sb: Supa | null, env: Env): Promise<CheckResult> {
  const name = "Supabase REST";
  if (!sb) return { name, status: "na", detail: "nicht eingerichtet" };
  const res = await fetchWithTimeout(`${sb.url}/rest/v1/memory?select=id&limit=1`, { headers: sb.headers });
  if (!res.ok) {
    return {
      name,
      status: "fail",
      detail: `memory HTTP ${res.status}`,
      hint: res.status === 401 || res.status === 403 ? "SUPABASE_SERVICE_ROLE_KEY prüfen" : "Supabase-Status prüfen",
    };
  }
  return { name, status: "ok", detail: "memory lesbar" };
}

export const EDGE_FUNCTIONS = ["store-telegram-message", "search-memory", "embed-knowledge"] as const;

/** Leerer Body: 400 heißt erreichbar und Schlüssel angenommen */
export function evaluateEdgeStatuses(statuses: Record<string, number | string>): CheckResult {
  const name = "Edge Functions";
  const bad = Object.entries(statuses).filter(([, s]) => s !== 400);
  if (bad.length === 0) return { name, status: "ok", detail: `${Object.keys(statuses).length}/${Object.keys(statuses).length} erreichbar, Schlüssel angenommen` };
  const detail = bad.map(([fn, s]) => `${fn} ${typeof s === "number" ? `HTTP ${s}` : s}`).join(", ");
  const auth = bad.some(([, s]) => s === 401 || s === 403);
  const missing = bad.some(([, s]) => s === 404);
  return {
    name,
    status: "fail",
    detail,
    hint: auth
      ? "Schlüssel abgelehnt: SUPABASE_SERVICE_ROLE_KEY und Secrets der Functions abgleichen (tybo setup suche)"
      : missing
        ? "Function fehlt: tybo setup suche liefert sie aus"
        : "Logs der Functions im Supabase-Dashboard ansehen",
  };
}

async function checkEdgeFunctions(sb: Supa | null): Promise<CheckResult> {
  if (!sb) return { name: "Edge Functions", status: "na" };
  const statuses: Record<string, number | string> = {};
  await Promise.all(
    EDGE_FUNCTIONS.map(async fn => {
      try {
        const res = await fetchWithTimeout(`${sb.url}/functions/v1/${fn}`, {
          method: "POST",
          headers: { ...sb.headers, "Content-Type": "application/json" },
          body: "{}",
        });
        statuses[fn] = res.status;
        await res.body?.cancel().catch(() => {});
      } catch (err) {
        statuses[fn] = errorText(err);
      }
    })
  );
  return evaluateEdgeStatuses(statuses);
}

async function checkSemanticSearch(sb: Supa | null, env: Env): Promise<CheckResult> {
  const name = "Semantische Suche";
  if (!sb) return { name, status: "na" };
  const chatId = env.TELEGRAM_USER_ID;
  if (!chatId) return { name, status: "na", detail: "ohne TELEGRAM_USER_ID" };
  const res = await fetchWithTimeout(`${sb.url}/functions/v1/search-memory`, {
    method: "POST",
    headers: { ...sb.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, query: "Wie heißt mein Bot?", limit: 3 }),
  });
  if (res.status !== 200) return { name, status: "fail", detail: `search-memory HTTP ${res.status}`, hint: "siehe Edge Functions" };
  const hits = (await res.json().catch(() => null)) as { similarity?: number }[] | null;
  if (!Array.isArray(hits) || hits.length === 0) {
    return { name, status: "fail", detail: "kein Treffer", hint: "Embeddings der Nachrichten und OPENAI_API_KEY der Functions prüfen" };
  }
  // Ohne similarity kamen die Treffer aus der Textsuche: der Suchvektor fehlte
  if (typeof hits[0].similarity !== "number") {
    return { name, status: "warn", detail: `${hits.length} Treffer, aber nur aus der Textsuche`, hint: "Embedding der Frage scheitert: Schlüssel der Functions prüfen (tybo setup suche)" };
  }
  return { name, status: "ok", detail: `${hits.length} Treffer (Ähnlichkeit ${hits[0].similarity.toFixed(2).replace(".", ",")})` };
}

/** Anteil mit Vektor; unter EMBEDDING_MIN_RATIO ❌ */
export function evaluateEmbeddingRatio(name: string, withVector: number, total: number, emptyText: string): CheckResult {
  if (total === 0) return { name, status: "ok", detail: emptyText };
  const ratio = withVector / total;
  const detail = `${withVector}/${total} mit Vektor (${Math.floor(ratio * 100)}%)`;
  if (ratio < EMBEDDING_MIN_RATIO) {
    return {
      name,
      status: "fail",
      detail,
      hint: "saveMessage fällt auf den Direkt-Insert zurück? Edge Functions und Fehler-Log prüfen, danach nachberechnen",
    };
  }
  return { name, status: "ok", detail };
}

async function checkEmbeddingQuota(sb: Supa | null, now: number): Promise<CheckResult[]> {
  if (!sb) return [{ name: "Embeddings", status: "na" }];
  const day = new Date(now - DAY_MS).toISOString();
  const week = new Date(now - 7 * DAY_MS).toISOString();
  const msgBase = `messages?select=id&created_at=gte.${day}&${NOT_DISPLAY_ONLY}&content=neq.`;
  const memBase = `memory?select=id&created_at=gte.${week}`;
  const [msgTotal, msgVec, memTotal, memVec] = await Promise.all([
    countRows(sb, msgBase),
    countRows(sb, `${msgBase}&embedding=not.is.null`),
    countRows(sb, memBase),
    countRows(sb, `${memBase}&embedding=not.is.null`),
  ]);
  return [
    evaluateEmbeddingRatio("Embeddings Nachrichten 24h", msgVec, msgTotal, "keine neuen Nachrichten"),
    evaluateEmbeddingRatio("Embeddings Memory 7 Tage", memVec, memTotal, "keine neuen Einträge"),
  ];
}

async function checkMemoryTotal(sb: Supa | null): Promise<CheckResult> {
  const name = "Memory gesamt";
  if (!sb) return { name, status: "na" };
  const [total, missing] = await Promise.all([countRows(sb, "memory?select=id"), countRows(sb, "memory?select=id&embedding=is.null")]);
  if (missing > 0) {
    return { name, status: "warn", detail: `${total} Einträge, ${missing} ohne Vektor`, hint: "nachberechnen: bun run scripts/backfill-fact-embeddings.ts" };
  }
  return { name, status: "ok", detail: `${total} Einträge, alle mit Vektor` };
}

// ---------------------------------------------------------------------------
// Schlüssel für Embeddings und Fallback
// ---------------------------------------------------------------------------

async function checkOpenAI(env: Env): Promise<CheckResult> {
  const name = "OpenAI-Schlüssel (Embeddings)";
  const provider = (env.EMBEDDING_PROVIDER || "openai").trim().toLowerCase();
  if (provider !== "openai") return { name, status: "na", detail: `Anbieter ${provider}` };
  if (!env.OPENAI_API_KEY) return { name, status: "na", detail: "OPENAI_API_KEY nicht in .env" };
  const res = await fetchWithTimeout("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: env.EMBEDDING_MODEL || "text-embedding-3-small", input: "ok" }),
  });
  await res.body?.cancel().catch(() => {});
  if (res.ok) return { name, status: "ok", detail: "gültig" };
  return {
    name,
    status: "fail",
    detail: `HTTP ${res.status}`,
    hint: res.status === 401 ? "Schlüssel ungültig, neuen auf platform.openai.com anlegen" : res.status === 429 ? "Guthaben oder Limit bei OpenAI prüfen" : "später erneut prüfen",
  };
}

interface FallbackSettings {
  ollamaModel?: string;
  offlineOnly?: boolean;
}

function fallbackSettings(): FallbackSettings {
  try {
    const raw = JSON.parse(readFileSync(join(PROJECT_ROOT, "config", "settings.json"), "utf8"));
    return (raw?.fallback ?? {}) as FallbackSettings;
  } catch {
    return {};
  }
}

async function checkOpenRouter(env: Env): Promise<CheckResult> {
  const name = "Fallback OpenRouter";
  if (!env.OPENROUTER_API_KEY) return { name, status: "na", detail: "nicht eingerichtet" };
  const offline = fallbackSettings().offlineOnly ?? env.FALLBACK_OFFLINE_ONLY === "true";
  if (offline) return { name, status: "na", detail: "nur Ollama (offlineOnly)" };
  const res = await fetchWithTimeout("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } });
  const body = (await res.json().catch(() => null)) as { data?: { limit_remaining?: number | null; usage?: number } } | null;
  if (!res.ok) {
    return { name, status: "fail", detail: `HTTP ${res.status}`, hint: res.status === 401 ? "OPENROUTER_API_KEY ungültig" : "später erneut prüfen" };
  }
  const remaining = body?.data?.limit_remaining;
  if (typeof remaining === "number" && remaining < 1) {
    return { name, status: "warn", detail: `Guthaben fast leer (${remaining.toFixed(2).replace(".", ",")} $ übrig)`, hint: "auf openrouter.ai aufladen" };
  }
  return { name, status: "ok", detail: typeof remaining === "number" ? `gültig, ${remaining.toFixed(2).replace(".", ",")} $ übrig` : "gültig" };
}

async function checkOllama(env: Env): Promise<CheckResult> {
  const name = "Fallback Ollama";
  const model = fallbackSettings().ollamaModel || env.OLLAMA_MODEL || "qwen3:8b";
  const installed = ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama", "/Applications/Ollama.app"].some(p => existsSync(p));
  let res: Response;
  try {
    res = await fetchWithTimeout("http://localhost:11434/api/tags", {}, 5_000);
  } catch {
    if (!installed) return { name, status: "na", detail: "nicht installiert" };
    return { name, status: "warn", detail: "installiert, aber nicht erreichbar", hint: "Ollama-App starten (Offline-Rückfall fehlt sonst)" };
  }
  const data = (await res.json().catch(() => null)) as { models?: { name?: string }[] } | null;
  const names = (data?.models ?? []).map(m => m.name ?? "");
  const has = names.some(n => n === model || n === `${model}:latest`);
  if (!has) return { name, status: "warn", detail: `läuft, Modell ${model} fehlt`, hint: `ollama pull ${model}` };
  return { name, status: "ok", detail: `läuft, ${model} da` };
}

// ---------------------------------------------------------------------------
// WebUI, Platte, Jobs
// ---------------------------------------------------------------------------

async function checkWebUI(env: Env): Promise<CheckResult> {
  const name = "WebUI";
  const cfg = loadWebConfig(env);
  if (cfg.status === "disabled") return { name, status: "na", detail: "aus" };
  if (cfg.status === "invalid") return { name, status: "fail", detail: cfg.reason };
  const host = ["0.0.0.0", "::", ""].includes(cfg.config.host) ? "127.0.0.1" : cfg.config.host;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${cfg.config.port}/`;
  const res = await fetchWithTimeout(url, { redirect: "manual" }, 8_000).catch(() => null);
  if (!res) return { name, status: "fail", detail: `Port ${cfg.config.port} antwortet nicht`, hint: "Bot-Log auf [web] prüfen" };
  await res.body?.cancel().catch(() => {});
  if (res.status >= 500) return { name, status: "fail", detail: `HTTP ${res.status}` };
  return { name, status: "ok", detail: `Port ${cfg.config.port} antwortet` };
}

export function parseDfAvailableBytes(stdout: string): number | null {
  return parseDf(stdout)?.available ?? null;
}

/** Letzte Zeile von `df -k`: Größe (Spalte 2) und frei (Spalte 4) in Bytes */
export function parseDf(stdout: string): { total: number; available: number } | null {
  const lines = stdout.trim().split("\n");
  const cols = lines[lines.length - 1]?.trim().split(/\s+/) ?? [];
  const total = Number(cols[1]);
  const available = Number(cols[3]);
  if (!Number.isFinite(available) || cols[3] === undefined) return null;
  return { total: Number.isFinite(total) ? total * 1024 : 0, available: available * 1024 };
}

/** „129 GB von 460 GB frei (28 %)“; unter 25 GB ⚠️, unter 10 GB ❌ */
export function evaluateDisk(total: number, free: number): CheckResult {
  const name = "Plattenplatz";
  const gb = (b: number) => Math.round(b / 1024 ** 3);
  const detail = total > 0 ? `${gb(free)} GB von ${gb(total)} GB frei (${Math.round((free / total) * 100)} %)` : `${gb(free)} GB frei`;
  const hint = "aufräumen (logs/, tmp/, Downloads, brew cleanup)";
  if (free < MIN_FREE_BYTES) return { name, status: "fail", detail: `nur ${detail}`, hint };
  if (free < WARN_FREE_BYTES) return { name, status: "warn", detail: `nur ${detail}`, hint };
  return { name, status: "ok", detail };
}

async function checkDisk(): Promise<CheckResult> {
  const r = await run(["df", "-k", PROJECT_ROOT]);
  const df = r.code === 0 ? parseDf(r.stdout) : null;
  if (!df) return { name: "Plattenplatz", status: "fail", detail: "df nicht lesbar" };
  return evaluateDisk(df.total, df.available);
}

/**
 * Ergebnis von `bun run updates` (data/software-update.json): je Werkzeug
 * neue Version, „aktuell“ oder „wartet auf Okay“ (Bun/brew), gescheiterte
 * Schritte ⚠️, gescheiterte Prüfung nach dem Update ❌, ohne Lauf seit drei
 * Tagen ⚠️ (nur wenn der Dienst eingerichtet ist), nie gelaufen „–“.
 */
export function evaluateSoftwareUpdate(state: UpdateState | null, now: number, scheduled: boolean): CheckResult {
  const name = "Software-Updates";
  if (!state) return scheduled ? { name, status: "warn", detail: "noch kein Lauf", hint: "logs/software-update.error.log ansehen" } : { name, status: "na", detail: "nicht eingerichtet" };
  const age = now - Date.parse(state.finishedAt);
  const steps = state.steps.filter(s => s.status !== "skip");
  const updated = steps.filter(s => s.status === "updated").map(s => (s.before && s.after ? `${s.name} ${s.before} → ${s.after}` : `${s.name} ${s.detail ?? ""}`.trim()));
  const failed = steps.filter(s => s.status === "fail").map(s => `${s.name}: ${s.detail ?? "Fehler"}`);
  const current = steps.filter(s => s.status === "current").map(s => s.name);
  const available = steps.filter(s => s.status === "available").map(s => (s.before && s.after ? `${s.name} ${s.before} → ${s.after}` : `${s.name} ${s.detail ?? ""}`.trim()));
  const parts = [`${ago(age)}`, ...updated, current.length ? `aktuell: ${current.join(", ")}` : "", available.length ? `wartet auf Okay: ${available.join(", ")}` : ""].filter(Boolean);
  const broken = (state.smoke ?? []).filter(s => !s.ok).map(s => `${s.name}: ${s.detail}`);
  if (broken.length) return { name, status: "fail", detail: `${parts.join(", ")}; Prüfung danach: ${broken.join("; ")}`, hint: "bun run updates --smoke im Terminal" };
  if (failed.length) return { name, status: "warn", detail: `${parts.join(", ")}; gescheitert: ${failed.join("; ")}`, hint: "bun run updates im Terminal" };
  if (scheduled && age > UPDATE_MAX_AGE_MS) return { name, status: "warn", detail: `letzter Lauf ${ago(age)}`, hint: `launchctl list | grep ${LAUNCHD_PREFIX}${UPDATE_SERVICE}` };
  return { name, status: "ok", detail: parts.join(", ") };
}

async function checkSoftwareUpdate(now: number): Promise<CheckResult> {
  let state: UpdateState | null = null;
  try {
    const parsed = JSON.parse(readFileSync(UPDATE_STATE_FILE, "utf8"));
    if (parsed?.version === 1 && Array.isArray(parsed.steps)) state = parsed as UpdateState;
  } catch {
    // noch nie gelaufen
  }
  return evaluateSoftwareUpdate(state, now, plistExists(UPDATE_SERVICE));
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Laufende Jobs über ihrer Frist oder ohne lebenden Wächter */
export function findStuckJobs(jobs: JobStatus[], now: number, alive: (pid: number | undefined) => boolean = pidAlive): { running: number; stuck: string[] } {
  const active = jobs.filter(j => j.phase !== "ended");
  const stuck: string[] = [];
  for (const j of active) {
    const start = Date.parse(j.startedAt ?? j.createdAt);
    const over = Number.isFinite(start) && now - start > j.maxHours * 60 * 60 * 1000 + JOB_GRACE_MS;
    const orphaned = j.watcher ? !alive(j.watcher.pid) : false;
    if (over || orphaned) stuck.push(`${j.title.slice(0, 40)} (${over ? "über der Frist" : "Wächter tot"})`);
  }
  return { running: active.length, stuck };
}

async function checkJobs(now: number): Promise<CheckResult> {
  const name = "Hintergrund-Jobs";
  const dir = join(PROJECT_ROOT, "data", "jobs");
  if (!existsSync(dir)) return { name, status: "na", detail: "keine" };
  const jobs: JobStatus[] = [];
  for (const id of readdirSync(dir)) {
    try {
      const status = JSON.parse(readFileSync(join(dir, id, "status.json"), "utf8")) as JobStatus;
      if (status?.version === 1 && typeof status.phase === "string") jobs.push(status);
    } catch {
      // kein oder kaputter Status: kein Job
    }
  }
  const { running, stuck } = findStuckJobs(jobs, now);
  if (stuck.length) return { name, status: "warn", detail: `hängend: ${stuck.join(", ")}`, hint: "bun run job list, dann bun run job stop <id>" };
  return { name, status: "ok", detail: running ? `${running} laufend, keiner hängt` : "keiner läuft" };
}

/**
 * Eine Zeile zu den Routinen (Issue #287) aus data/routines/: „alle ok" oder
 * „2 mit Fehler (a, b)", ausgebliebene dahinter. Keine Einzelmeldungen, die
 * schickt der Wrapper bzw. der Bot selbst.
 */
export function evaluateRoutines(s: RoutinesSummary): CheckResult {
  const name = "Routinen";
  if (!s.any && !s.missed.length) return { name, status: "na", detail: "kein Verlauf (keine Routine eingebunden)" };
  const parts: string[] = [];
  if (s.failed.length) parts.push(`${s.failed.length} mit Fehler (${s.failed.join(", ")})`);
  if (s.missed.length) parts.push(`${s.missed.length} ausgeblieben (${s.missed.join(", ")})`);
  if (!parts.length) return { name, status: "ok", detail: "alle ok" };
  return { name, status: "warn", detail: parts.join(", "), hint: "/routinen <name> zeigt den Verlauf" };
}

/**
 * Routinen pünktlich (Issue #365, ersetzt den Watchdog): je aktive
 * zeitgesteuerte Routine, ob der letzte fällige Termin wahrgenommen wurde
 * (src/lib/routines/punctual.ts). Ausgebliebene und nicht prüfbare ⚠️,
 * Zeiten in der Zeitzone des Systems wie in /routinen.
 */
export function evaluatePunctuality(s: PunctualSummary, now: number, timeZone: string): CheckResult {
  const name = "Routinen pünktlich";
  if (!s.available) return { name, status: "na", detail: "nur mit launchd (macOS)" };
  const paused = s.paused.length ? `${s.paused.length} pausiert oder nicht geladen` : "";
  // Hinweise der Übersicht: was fehlt, ist ungeprüft, also nie grün und nie „keine Routine“
  const notes = s.notes.map(n => n.replace(/\.$/, "")).join("; ");
  const notesHint = "tybo routinen zeigt die Übersicht mit allen Hinweisen";
  if (s.checked === 0) {
    if (notes) return { name, status: "warn", detail: [`nicht prüfbar: ${notes}`, paused].filter(Boolean).join(", "), hint: notesHint };
    return { name, status: "na", detail: ["keine aktive zeitgesteuerte Routine", paused].filter(Boolean).join(", ") };
  }
  const parts: string[] = [];
  if (s.missed.length) {
    const items = s.missed.map(m => `${m.name} (fällig ${whenText(m.due, { now, timeZone })}${m.evidence === "log" ? ", laut Log" : ""})`);
    parts.push(`ausgeblieben: ${items.join(", ")}`);
  }
  if (s.unchecked.length) parts.push(`nicht prüfbar: ${s.unchecked.map(u => `${u.name} (${u.reason})`).join(", ")}`);
  if (parts.length && notes) parts.push(`unvollständig: ${notes}`);
  if (parts.length) {
    // Ohne Protokoll ist das Log nur ein Indiz: eine stille Routine schreibt nichts
    const byLog = s.missed.some(m => m.evidence === "log");
    const hint = byLog ? "ohne Verlauf zählt nur das Log; genauer nach tybo routinen einbinden <label>" : "/routinen <name> zeigt Zeitplan und Verlauf";
    return { name, status: "warn", detail: parts.join("; "), hint };
  }
  const onTime = s.checked - s.running.length;
  const info = [`${onTime} pünktlich`, s.running.length ? `${s.running.length} läuft gerade` : "", paused].filter(Boolean);
  if (notes) return { name, status: "warn", detail: `${info.join(", ")}; unvollständig: ${notes}`, hint: notesHint };
  return { name, status: "ok", detail: info.join(", ") };
}

function fileMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

async function checkPunctuality(now: number): Promise<CheckResult> {
  const timeZone = systemTimeZone();
  const list = await listRoutines({ ...defaultRoutinesDeps(PROJECT_ROOT), now: () => now, timeZone });
  return evaluatePunctuality(summarizePunctuality(list, { now, timeZone, mtime: fileMtime }), now, timeZone);
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------

export async function runHealthChecks(options: { withModel: boolean; env?: Env; now?: number }): Promise<{ results: CheckResult[]; state: HealthState }> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const sb = supabaseFrom(env);
  const state = readState();
  const nextState: HealthState = { logs: { ...state.logs } };

  const groups = await Promise.all([
    runCheck("Bot-Prozess", checkBotProcess),
    runCheck("Bot-Log frisch", () => checkLogFresh(now)),
    runCheck("Fehler im Log (24h)", () => checkErrorLog(now, state, nextState)),
    runCheck("Telegram", () => checkTelegram(env)),
    runCheck("Claude CLI", () => checkClaude(env, options.withModel), CLAUDE_TIMEOUT_MS),
    runCheck("Supabase REST", () => checkSupabaseRest(sb, env)),
    runCheck("Edge Functions", () => checkEdgeFunctions(sb)),
    runCheck("Semantische Suche", () => checkSemanticSearch(sb, env), 25_000),
    runCheck("Embeddings", () => checkEmbeddingQuota(sb, now)),
    runCheck("Memory gesamt", () => checkMemoryTotal(sb)),
    runCheck("OpenAI-Schlüssel (Embeddings)", () => checkOpenAI(env)),
    runCheck("Fallback OpenRouter", () => checkOpenRouter(env)),
    runCheck("Fallback Ollama", () => checkOllama(env)),
    runCheck("WebUI", () => checkWebUI(env)),
    runCheck("Cloudflare-Tunnel", checkTunnel),
    runCheck("Weitere Dienste", checkOtherServices),
    runCheck("Plattenplatz", checkDisk),
    runCheck("Software-Updates", () => checkSoftwareUpdate(now)),
    runCheck("Hintergrund-Jobs", () => checkJobs(now)),
    runCheck("Routinen", async () => evaluateRoutines(readRoutinesSummary(PROJECT_ROOT))),
    runCheck("Routinen pünktlich", () => checkPunctuality(now), 25_000),
  ]);
  const results = groups.flat().map(r => ({
    ...r,
    detail: r.detail === undefined ? undefined : redact(r.detail, env),
    hint: r.hint === undefined ? undefined : redact(r.hint, env),
  }));
  return { results, state: nextState };
}

async function main(argv: string[]): Promise<number> {
  await loadEnv();
  const send = !argv.includes("--no-send");
  const withModel = !argv.includes("--no-model");
  const now = new Date();
  const { results, state } = await runHealthChecks({ withModel, now: now.getTime() });
  const report = formatReport(results, now, process.env.USER_TIMEZONE || undefined);
  console.log(`[${now.toISOString()}] Nachtcheck`);
  console.log(report);
  await atomicWriteFile(STATE_FILE, JSON.stringify(state, null, 2)).catch(err => console.error(`[health] Stand nicht gespeichert: ${errorText(err)}`));
  if (!send) return 0;

  const { defaultOutboxDeps, outboxDelivered, sendAndRecord } = await import("./lib/outbox");
  const sent = await sendAndRecord({ source: "nachtcheck", text: report, format: "plain" }, defaultOutboxDeps());
  if (sent.error || !outboxDelivered(sent)) {
    console.error(`[health] Report nicht zugestellt: ${redact(sent.error?.message ?? "unbekannt")}`);
    return 1;
  }
  console.log("[health] Report gesendet");
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
