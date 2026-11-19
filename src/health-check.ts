#!/usr/bin/env bun
/**
 * Nachtcheck (`bun run health`): prüft die wichtigen Funktionen von tybo und
 * schickt einen kurzen Report mit ✅ / ⚠️ / ❌ je Punkt über die Outbox
 * (Telegram und WebUI). Läuft täglich um 03:30 als launchd-Dienst
 * ai.tybo.health-check, unter Linux (Issue #568) als systemd-Timer
 * tybo-health-check in der Zeitzone aus USER_TIMEZONE, ohne systemd unter
 * PM2 (Dienstkatalog src/lib/services/catalog.ts).
 *
 * Ob der Bot läuft, sagen zwei Zeilen (src/lib/health/bot-alive.ts): der
 * Dienstverwalter (launchd, systemd, PM2) und der Health-Port des Bots
 * (127.0.0.1, HEALTH_PORT). Steht der Bot, ist das ❌ im Bericht; der
 * Bericht geht wie jede Nacht genau einmal über die Outbox, ohne Telegram
 * nur in die WebUI, die mit dem Bot steht und ihn erst danach zeigt.
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
 *   bun run health --no-model    ohne Mini-Aufruf an Haiku (Motor nur Version und Anmeldung)
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
import { countLogIssues } from "./lib/log-lines";
import { BOT_HEALTH_CHECK, BOT_PROCESS_CHECK, checkBotProcess, checkHealthPort, type BotAliveDeps } from "./lib/health/bot-alive";
import { pm2RpcSocketPath, queryPm2Daemon } from "./lib/routines/sources/pm2-rpc";
import { checkEngineLine, claudeProbeEnv, ENGINE_CHECK, probeClaude, type EngineLineDeps } from "./lib/health/engine";
import { isSecretName } from "./lib/subprocess-env";
import { loadWebConfig } from "./web/config";
import type { JobStatus } from "./lib/jobs/store";
import { UPDATE_STATE_FILE, type UpdateState } from "./software-update";
import { formatBytes, loadMaintenanceState, type MaintenanceRun, type MaintenanceStateRead } from "./lib/maintenance/run";
import { checkConfiguredServices, serviceLine, type ServiceCheckRun, type ServiceDeps } from "./lib/maintenance/services";
import { realServiceDeps } from "./lib/maintenance/service-deps";
import { detectScheduledService, realDetectDeps, type ScheduledServiceState } from "./setup/services/detect";
import { BRAND } from "./brand";
import { readRoutinesSummary, type RoutinesSummary } from "./lib/routines/alerts";
import { defaultRoutinesDeps, listRoutines } from "./lib/routines/catalog";
import { whenText } from "./lib/routines/format";
import { summarizePunctuality, type PunctualSummary } from "./lib/routines/punctual";
import { systemTimeZone } from "./lib/routines/schedule";
import { evaluateTokenScan, scanLogsForTokens } from "./lib/log-token-scan";
import { telegramTokensFromEnv } from "./lib/telegram-token-mask";
import { outboxDelivered } from "./lib/channels";
import type { SendAndRecordInput, SendAndRecordResult } from "./lib/outbox";
import { describeStatus, fetchRelayStatus, STATUS_TIMEOUT_MS, type CommandRunner as RelayRunner, type RelayStatus } from "./lib/sip-relay/status";

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
/** Unter diesem Anteil freier Platte ❌ bzw. ⚠️ */
export const MIN_FREE_PERCENT = 5;
export const WARN_FREE_PERCENT = 15;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Software-Updates: älter als das ⚠️ (Dienst läuft täglich) */
const UPDATE_MAX_AGE_MS = 3 * DAY_MS;
/** Wartung: älter als das ⚠️ (Dienst läuft wöchentlich) */
export const MAINTENANCE_MAX_AGE_MS = 8 * DAY_MS;
/** Längste Fehlerangabe einer Wartung im Report */
const MAINTENANCE_ERRORS_MAX = 200;
/** Laufende Jobs gelten erst so lange nach ihrer Frist als hängend */
const JOB_GRACE_MS = 15 * 60 * 1000;
const STATE_FILE = join(PROJECT_ROOT, "data", "health-check-state.json");
const HEALTH_SERVICE = "health-check";
const TUNNEL_SERVICE = "cloudflare-tunnel";
const UPDATE_SERVICE = "software-update";
const MAINTENANCE_SERVICE = "wartung";

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

/** Muster und Zählung stehen bei den Log-Zeilen selbst (Issue #568) */
export { countLogIssues, LOG_PATTERNS } from "./lib/log-lines";

/**
 * Zeile „Fehler im Log (24h)“: zählt die Muster aus src/lib/log-lines.ts in
 * logs/telegram-relay.log und logs/telegram-relay.error.log ab dem Stand vor
 * mindestens 24 Stunden (pickBaseline) und hält in nextState den neuen
 * Stand fest. root nur für Tests (Issue #568), sonst der Projektordner.
 */
export async function checkErrorLog(now: number, state: HealthState, nextState: HealthState, root: string = PROJECT_ROOT): Promise<CheckResult> {
  const name = "Fehler im Log (24h)";
  const files = [join(root, "logs", "telegram-relay.log"), join(root, "logs", "telegram-relay.error.log")].filter(p => existsSync(p));
  if (files.length === 0) return { name, status: "na", detail: "keine Logs" };
  const total = new Map<string, number>();
  let since: number | null = now - DAY_MS;
  for (const path of files) {
    const key = path.slice(root.length + 1);
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

/**
 * Bot-Token in logs/ (Issue #526): alle Dateien samt .gz-Archiven, Muster
 * und bekannte Werte; gemeldet werden nur Datei und Anzahl
 */
export async function checkTokenInLogs(env: Env, logsDir: string = join(PROJECT_ROOT, "logs")): Promise<CheckResult> {
  return { name: "Telegram-Token im Log", ...evaluateTokenScan(await scanLogsForTokens(logsDir, telegramTokensFromEnv(env))) };
}

// ---------------------------------------------------------------------------
// Telegram, Motor
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

/**
 * Messwert für strengeres Merken (Issue #521): Fakten, die in den letzten 7
 * Tagen dazukamen, die Grenze zählt mit. Nur type=fact, anders als die
 * Embedding-Zeile, die alle Arten zählt. Archivierte zählen mit: gemessen wird
 * der Zugang, nicht der Bestand. Eine gescheiterte Abfrage wirft (runCheck
 * macht daraus ❌), sie erscheint nie als 0.
 */
async function checkNewFacts(sb: Supa | null, now: number): Promise<CheckResult> {
  const name = "Neue Fakten 7 Tage";
  if (!sb) return { name, status: "na", detail: "ohne Datenbank" };
  const week = new Date(now - 7 * DAY_MS).toISOString();
  const total = await countRows(sb, `memory?select=id&type=eq.fact&created_at=gte.${week}`);
  return { name, status: "ok", detail: plural(total, "neuer Fakt", "neue Fakten") };
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

/**
 * „129 GB von 460 GB frei (28 %)“. ⚠️ unter 15 % oder unter 25 GB, ❌ unter
 * 5 % oder unter 10 GB, je nachdem, was zuerst greift. Verglichen wird der
 * genaue Anteil, nicht die gerundete Anzeige; ohne bekannte Gesamtgröße
 * (total 0) zählen nur die GB-Grenzen.
 */
export function evaluateDisk(total: number, free: number): CheckResult {
  const name = "Plattenplatz";
  const gb = (b: number) => Math.round(b / 1024 ** 3);
  const detail = total > 0 ? `${gb(free)} GB von ${gb(total)} GB frei (${Math.round((free / total) * 100)} %)` : `${gb(free)} GB frei`;
  const below = (percent: number) => total > 0 && free * 100 < total * percent;
  const hint = `${BRAND.cli} wartung --dry-run zeigt, was sofort ginge, mit der Summe; darüber hinaus tmp/ und Downloads ansehen`;
  if (free < MIN_FREE_BYTES || below(MIN_FREE_PERCENT)) return { name, status: "fail", detail: `nur ${detail}`, hint };
  if (free < WARN_FREE_BYTES || below(WARN_FREE_PERCENT)) return { name, status: "warn", detail: `nur ${detail}`, hint };
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

/**
 * Dienst-Versionen (Issue #486): Dienste aus "dienste" in
 * config/wartung.json nur prüfen, nie neu starten. Läuft einer älter als
 * installiert, ist die Version unbekannt oder läuft er nicht: ⚠️. Ohne
 * Liste „–“.
 */
export function evaluateServiceVersions(run: ServiceCheckRun | null): CheckResult {
  const name = "Dienst-Versionen";
  if (!run) return { name, status: "na", detail: "keine Dienste in config/wartung.json" };
  if (run.error) return { name, status: "warn", detail: run.error, hint: "config/wartung.json prüfen (docs/routinen.md)" };
  const bad = run.services.filter(r => r.outcome !== "aktuell");
  if (bad.length === 0) return { name, status: "ok", detail: run.services.map(r => serviceLine(r, "pruefen")).join("; ") };
  const stale = bad.some(r => r.outcome === "veraltet");
  return {
    name,
    status: "warn",
    detail: bad.map(r => serviceLine(r, "pruefen")).join("; "),
    hint: stale ? `${BRAND.cli} wartung oder bun run updates --apply startet veraltete Dienste neu` : "Dienst und config/wartung.json prüfen",
  };
}

async function checkServiceVersions(deps: MaintenanceCheckDeps): Promise<CheckResult> {
  return evaluateServiceVersions(await checkConfiguredServices(deps.root, deps.services, "pruefen"));
}

/** Fehler eines Wartungslaufs: Abbruch, Posten, Dienste, Meldung */
function maintenanceErrors(run: MaintenanceRun): string[] {
  const errors: string[] = [];
  if (run.error) errors.push(`abgebrochen: ${run.error}`);
  for (const item of run.items) for (const error of item.errors) errors.push(`${item.title}: ${error}`);
  if (run.services?.error) errors.push(`Dienste: ${run.services.error}`);
  for (const service of run.services?.services ?? []) if (service.outcome === "fehler") errors.push(serviceLine(service, run.services!.mode));
  if (run.notify?.status === "fehlgeschlagen") errors.push(`Meldung nicht gesendet${run.notify.detail ? `: ${run.notify.detail}` : ""}`);
  if (errors.length === 0 && run.status === "fehler") errors.push("siehe logs/wartung.log");
  return errors;
}

/**
 * Zeile „Wartung“ (Issue #487) aus data/wartung.json und dem Zustand des
 * Diensts. Die abgeräumte Menge ist die Summe der Posten, nicht freeAfter
 * minus freeBefore (APFS, andere Programme schreiben gleichzeitig). Eine
 * fehlende Datei allein heißt nicht „nicht eingerichtet“: der Dienst kann
 * da sein und noch nie gelaufen sein. Fehlt der Dienst, bleibt die Zeile „–“
 * wie jeder nicht eingerichtete Teil; Angaben zu einem Lauf von Hand stehen
 * trotzdem dabei.
 */
export function evaluateMaintenance(read: MaintenanceStateRead, schedule: ScheduledServiceState, now: number): CheckResult {
  const name = "Wartung";
  if (schedule === "nicht-verfuegbar") return { name, status: "na", detail: "nur unter macOS und Linux" };

  const run = read.status === "ok" ? read.state.lastRun : null;
  const age = run ? now - Date.parse(run.finishedAt) : 0;
  const errors = run ? maintenanceErrors(run) : [];
  const parts: string[] = [];
  if (run) {
    const bytes = run.items.reduce((sum, item) => sum + item.bytes, 0);
    parts.push(`letzter Lauf ${ago(age)}, ${bytes > 0 ? `${formatBytes(bytes)} abgeräumt` : "nichts abgeräumt"}`);
  } else if (read.status === "ungueltig") {
    parts.push("data/wartung.json ungültig");
  }
  const text = (lead?: string) => {
    const joined = errors.join("; ");
    const shown = joined.length > MAINTENANCE_ERRORS_MAX ? `${joined.slice(0, MAINTENANCE_ERRORS_MAX)}…` : joined;
    return [lead, ...parts].filter(Boolean).join(", ") + (errors.length ? `; Fehler: ${shown}` : "");
  };
  const byHand = `${BRAND.cli} wartung startet sie von Hand`;

  if (schedule === "fehlt") return { name, status: "na", detail: text("nicht eingerichtet") };
  if (schedule === "aus") return { name, status: "warn", detail: text("Dienst eingerichtet, aber nicht aktiv"), hint: `${BRAND.cli} dienste wartung schaltet ihn wieder ein` };
  if (schedule === "unbekannt") {
    if (!run && read.status === "fehlt") parts.push("noch kein Lauf");
    return { name, status: "warn", detail: text("Dienst nicht prüfbar"), hint: `${BRAND.cli} pruefen und logs/wartung.error.log ansehen` };
  }
  if (read.status === "fehlt") return { name, status: "warn", detail: "eingerichtet, noch kein Lauf", hint: `läuft sonntags 03:15, ${byHand}` };
  if (read.status === "ungueltig") return { name, status: "warn", detail: text(), hint: `${byHand} und schreibt die Datei neu` };
  if (errors.length) return { name, status: "warn", detail: text(), hint: "Details in logs/wartung.log" };
  if (age > MAINTENANCE_MAX_AGE_MS) return { name, status: "warn", detail: text(), hint: `logs/wartung.error.log ansehen, ${byHand}` };
  return { name, status: "ok", detail: text() };
}

async function checkMaintenance(now: number, deps: MaintenanceCheckDeps): Promise<CheckResult> {
  const [read, schedule] = await Promise.all([loadMaintenanceState(deps.root), deps.schedule()]);
  return evaluateMaintenance(read, schedule, now);
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
  const active = jobs.filter(j => j.phase === "starting" || j.phase === "running");
  const stuck: string[] = [];
  for (const j of active) {
    const start = Date.parse(j.startedAt ?? j.runCreatedAt ?? j.createdAt);
    const over = Number.isFinite(start) && now - start + (j.budgetUsedMs ?? 0) > j.maxHours * 60 * 60 * 1000 + JOB_GRACE_MS;
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
  if (!s.available) return { name, status: "na", detail: "nur mit launchd (macOS) oder systemd (Linux)" };
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

/**
 * SIP-Vermittlung (Issue #511) als Zeile im Bericht: ❌ bei Ausfall, – ohne
 * Einrichtung. Die Einmal-Meldung kommt von `bun run sip-zustand`, nicht von
 * hier; der Nachtcheck schickt seinen Bericht ohnehin jedes Mal.
 */
export function evaluateSipRelay(status: RelayStatus, now: number): CheckResult {
  const name = "SIP-Vermittlung";
  const detail = describeStatus(status, now);
  if (status.state === "nicht-eingerichtet") return { name, status: "na", detail: "nicht eingerichtet" };
  if (status.state === "registriert") return { name, status: "ok", detail };
  return { name, status: "fail", detail, hint: "deploy/sip-vermittlung/README.md, Abschnitt Zustand und Meldung" };
}

async function checkSipRelay(env: Env, now: number, run?: RelayRunner): Promise<CheckResult> {
  return evaluateSipRelay(await fetchRelayStatus(env, run), now);
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------

/** Zugriffe der Prüfungen zu Wartung und Dienst-Versionen; Tests setzen Attrappen ein */
export interface MaintenanceCheckDeps {
  root: string;
  /** Zustand des Diensts ai.tybo.wartung bzw. tybo-wartung */
  schedule(): Promise<ScheduledServiceState>;
  services: ServiceDeps;
}

function realMaintenanceCheckDeps(): MaintenanceCheckDeps {
  return {
    root: PROJECT_ROOT,
    schedule: () => detectScheduledService(MAINTENANCE_SERVICE, realDetectDeps(PROJECT_ROOT)),
    services: realServiceDeps(PROJECT_ROOT),
  };
}

/** Echte Zugriffe für die Zeile „Motor“ (Issue #568); Module erst beim Aufruf laden */
export function realEngineLineDeps(env: Env = process.env): EngineLineDeps {
  return {
    standard: async () => (await import("./lib/engine-choice")).defaultEngineSetting(),
    check: async engine => (await import("./lib/engines/check")).checkEngine(engine),
    probeClaude: async () => probeClaude(env.CLAUDE_PATH || "claude", await probeEnvFor(env), (cmd, o) => run(cmd, o)),
  };
}

/** Umgebung des Haiku-Probeaufrufs: gefiltert wie jeder Claude-Subprozess (Issue #568) */
export async function probeEnvFor(env: Env): Promise<Record<string, string>> {
  const { subprocessEnv } = await import("./lib/subprocess-env");
  return claudeProbeEnv(subprocessEnv({ env, cwd: tmpdir(), home: env.HOME ?? "" }), env);
}

/** Echte Zugriffe für „Bot-Prozess“ und „Bot antwortet“ (Issue #568) */
export function realBotAliveDeps(env: Env = process.env): BotAliveDeps {
  const home = env.HOME ?? "";
  return {
    platform: process.platform,
    launchctlList,
    systemdBooted: () => existsSync("/run/systemd/system"),
    async systemctlShow(unit, properties) {
      try {
        const r = await run(["systemctl", "--user", "show", unit, `--property=${properties.join(",")}`]);
        return { ok: r.code === 0, stdout: r.stdout };
      } catch {
        // systemctl fehlt (Bun.spawn wirft bei unbekanntem Befehl)
        return { ok: false, stdout: "", missing: true };
      }
    },
    pm2Query: () => queryPm2Daemon(pm2RpcSocketPath(process.platform, env.PM2_HOME || join(home, ".pm2"))),
    fetch: (url, init) => fetch(url, init),
  };
}

export interface PlannedCheck {
  name: string;
  fn: () => Promise<CheckResult | CheckResult[]>;
  timeoutMs?: number;
}

/** Alle Prüfungen in Report-Reihenfolge; gestartet wird noch nichts */
export function plannedChecks(options: {
  withModel: boolean;
  env: Env;
  now: number;
  state: HealthState;
  nextState: HealthState;
  maintenance: MaintenanceCheckDeps;
  /** Prozess und Health-Port des Bots; fehlt: echte Zugriffe */
  alive?: BotAliveDeps;
  /** Standard-Motor und Probeaufruf; fehlt: echte Zugriffe */
  engine?: EngineLineDeps;
}): PlannedCheck[] {
  const { withModel, env, now, state, nextState, maintenance } = options;
  const alive = options.alive ?? realBotAliveDeps(env);
  const engine = options.engine ?? realEngineLineDeps(env);
  const sb = supabaseFrom(env);
  return [
    { name: BOT_PROCESS_CHECK, fn: () => checkBotProcess(alive) },
    { name: BOT_HEALTH_CHECK, fn: () => checkHealthPort(env, alive) },
    { name: "Bot-Log frisch", fn: () => checkLogFresh(now) },
    { name: "Fehler im Log (24h)", fn: () => checkErrorLog(now, state, nextState) },
    { name: "Telegram-Token im Log", fn: () => checkTokenInLogs(env), timeoutMs: 60_000 },
    { name: "Telegram", fn: () => checkTelegram(env) },
    { name: ENGINE_CHECK, fn: () => checkEngineLine(withModel, engine), timeoutMs: CLAUDE_TIMEOUT_MS },
    { name: "Supabase REST", fn: () => checkSupabaseRest(sb, env) },
    { name: "Edge Functions", fn: () => checkEdgeFunctions(sb) },
    { name: "Semantische Suche", fn: () => checkSemanticSearch(sb, env), timeoutMs: 25_000 },
    { name: "Embeddings", fn: () => checkEmbeddingQuota(sb, now) },
    { name: "Memory gesamt", fn: () => checkMemoryTotal(sb) },
    { name: "Neue Fakten 7 Tage", fn: () => checkNewFacts(sb, now) },
    { name: "OpenAI-Schlüssel (Embeddings)", fn: () => checkOpenAI(env) },
    { name: "Fallback OpenRouter", fn: () => checkOpenRouter(env) },
    { name: "Fallback Ollama", fn: () => checkOllama(env) },
    { name: "WebUI", fn: () => checkWebUI(env) },
    { name: "SIP-Vermittlung", fn: () => checkSipRelay(env, now), timeoutMs: STATUS_TIMEOUT_MS + 5_000 },
    { name: "Cloudflare-Tunnel", fn: checkTunnel },
    { name: "Weitere Dienste", fn: checkOtherServices },
    { name: "Plattenplatz", fn: checkDisk },
    { name: "Wartung", fn: () => checkMaintenance(now, maintenance) },
    { name: "Software-Updates", fn: () => checkSoftwareUpdate(now) },
    { name: "Dienst-Versionen", fn: () => checkServiceVersions(maintenance), timeoutMs: 60_000 },
    { name: "Hintergrund-Jobs", fn: () => checkJobs(now) },
    { name: "Routinen", fn: async () => evaluateRoutines(readRoutinesSummary(PROJECT_ROOT)) },
    { name: "Routinen pünktlich", fn: () => checkPunctuality(now), timeoutMs: 25_000 },
  ];
}

export async function runHealthChecks(options: { withModel: boolean; env?: Env; now?: number }): Promise<{ results: CheckResult[]; state: HealthState }> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const state = readState();
  const nextState: HealthState = { logs: { ...state.logs } };

  const checks = plannedChecks({ withModel: options.withModel, env, now, state, nextState, maintenance: realMaintenanceCheckDeps() });
  const groups = await Promise.all(checks.map(c => runCheck(c.name, c.fn, c.timeoutMs)));
  const results = groups.flat().map(r => ({
    ...r,
    detail: r.detail === undefined ? undefined : redact(r.detail, env),
    hint: r.hint === undefined ? undefined : redact(r.hint, env),
  }));
  return { results, state: nextState };
}

/** Zugriffe eines Nachtcheck-Laufs; Tests setzen Attrappen ein (Issue #568) */
export interface NightlyDeps {
  runChecks(withModel: boolean, now: number): Promise<{ results: CheckResult[]; state: HealthState }>;
  saveState(state: HealthState): Promise<void>;
  /** Versand über die Outbox (Telegram, falls eingerichtet, und WebUI) */
  send(input: SendAndRecordInput): Promise<SendAndRecordResult>;
  timeZone?: string;
  out(line: string): void;
  err(line: string): void;
}

/**
 * Ein Lauf: prüfen, Bericht bauen, Stand speichern, Bericht genau einmal
 * senden (außer mit --no-send). Ein stehender Bot ist eine ❌-Zeile in
 * diesem Bericht, keine eigene Meldung.
 */
export async function runNightly(argv: string[], deps: NightlyDeps, now: Date = new Date()): Promise<number> {
  const send = !argv.includes("--no-send");
  const withModel = !argv.includes("--no-model");
  const { results, state } = await deps.runChecks(withModel, now.getTime());
  const report = formatReport(results, now, deps.timeZone);
  deps.out(`[${now.toISOString()}] Nachtcheck`);
  deps.out(report);
  await deps.saveState(state).catch(err => deps.err(`[health] Stand nicht gespeichert: ${errorText(err)}`));
  if (!send) return 0;

  const sent = await deps.send({ source: "nachtcheck", text: report, format: "plain" });
  if (sent.error || !outboxDelivered(sent)) {
    deps.err(`[health] Report nicht zugestellt: ${redact(sent.error?.message ?? "unbekannt")}`);
    return 1;
  }
  deps.out("[health] Report gesendet");
  return 0;
}

async function main(argv: string[]): Promise<number> {
  await loadEnv();
  return runNightly(argv, {
    runChecks: (withModel, now) => runHealthChecks({ withModel, now }),
    saveState: state => atomicWriteFile(STATE_FILE, JSON.stringify(state, null, 2)),
    send: async input => {
      const { defaultOutboxDeps, sendAndRecord } = await import("./lib/outbox");
      return sendAndRecord(input, defaultOutboxDeps());
    },
    timeZone: process.env.USER_TIMEZONE || undefined,
    out: line => console.log(line),
    err: line => console.error(line),
  });
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
