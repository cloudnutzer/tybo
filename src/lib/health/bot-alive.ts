/**
 * Läuft der Bot? Zwei Zeilen des Nachtchecks (Issue #568):
 *
 * - „Bot-Prozess“ fragt den Dienstverwalter: unter macOS launchd
 *   (`launchctl list`), unter Linux erst systemd (`systemctl --user show
 *   tybo-telegram-relay.service`), dann PM2. PM2 wird nie über die CLI
 *   gefragt, denn `pm2 jlist` startet einen Daemon, wenn keiner läuft;
 *   stattdessen der laufende Daemon über seinen Socket (queryPm2Daemon aus
 *   src/lib/routines/sources/pm2-rpc.ts).
 * - „Bot antwortet“ fragt den Health-Server des Bots
 *   (src/app/health-server.ts) unter http://127.0.0.1:<HEALTH_PORT>/health,
 *   mit Zeitlimit und ohne Weiterleitungen. Als Antwort zählt nur HTTP 200
 *   mit der Dienstkennung HEALTH_SERVICE_ID; alles andere ist ein fremder
 *   Dienst auf dem Port.
 *
 * Zustände getrennt: Dienst fehlt (❌ mit „tybo setup autostart“), Dienst
 * steht (❌ mit dem Befehl zum Nachsehen), Dienstverwalter nicht prüfbar
 * (⚠️, nie „läuft“). Steht der Bot, landet das als ❌-Zeile im Bericht des
 * Nachtchecks; der Bericht geht wie jeder Lauf genau einmal über die Outbox
 * (WebUI und, falls eingerichtet, Telegram). Eine eigene Meldung gibt es
 * nicht.
 *
 * Alles Äußere steckt in BotAliveDeps; Tests reichen Attrappen herein und
 * rufen nie systemctl, launchctl, pm2 oder den Health-Port des laufenden
 * Bots auf.
 */

import type { CheckResult } from "../../health-check";
import type { Pm2Query } from "../routines/sources/pm2-rpc";
import { BOT_SERVICE, findLaunchctlLine, HEALTH_SERVICE_ID, launchdLabel, pm2Name, systemdUnitFile } from "../service-names";
import { BRAND } from "../../brand";

export const BOT_PROCESS_CHECK = "Bot-Prozess";
export const BOT_HEALTH_CHECK = "Bot antwortet";
/** Zeitlimit der Abfrage am Health-Port */
export const HEALTH_FETCH_TIMEOUT_MS = 5_000;
/** Höchstens so viel der Antwort wird gelesen */
const HEALTH_BODY_MAX = 16 * 1024;

export interface CommandResult {
  ok: boolean;
  stdout: string;
  /** true: der Befehl ließ sich gar nicht starten (fehlt im PATH) */
  missing?: boolean;
}

export interface BotAliveDeps {
  platform: NodeJS.Platform;
  /** Ausgabe von `launchctl list`; wirft, wenn der Befehl scheitert */
  launchctlList(): Promise<string>;
  /** /run/systemd/system gibt es: der Rechner läuft mit systemd */
  systemdBooted(): boolean;
  /** `systemctl --user show <unit> --property=…` */
  systemctlShow(unit: string, properties: string[]): Promise<CommandResult>;
  /** Prozessliste des laufenden PM2-Daemons über den Socket; startet nie einen */
  pm2Query(): Promise<Pm2Query>;
  /** Abfrage des Health-Ports; Tests geben eine Attrappe */
  fetch(url: string, init: RequestInit): Promise<Response>;
}

// ---------------------------------------------------------------------------
// Bot-Prozess
// ---------------------------------------------------------------------------

/** Felder aus `systemctl show`, Zeilen „Name=Wert“ */
export function parseSystemctlShow(stdout: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) props[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return props;
}

const SYSTEMD_PROPS = ["LoadState", "ActiveState", "SubState", "MainPID", "ExecMainStatus"];

type Verdict = { found: true; result: CheckResult } | { found: false } | { found: "unknown"; why: string };

async function systemdVerdict(deps: BotAliveDeps): Promise<Verdict> {
  if (!deps.systemdBooted()) return { found: false };
  const unit = systemdUnitFile(BOT_SERVICE);
  const shown = await deps.systemctlShow(unit, SYSTEMD_PROPS).catch((): CommandResult => ({ ok: false, stdout: "" }));
  if (shown.missing) return { found: false };
  const props = parseSystemctlShow(shown.stdout);
  if (!shown.ok || !props.LoadState) return { found: "unknown", why: "systemctl --user antwortet nicht" };
  if (props.LoadState !== "loaded") return { found: false };
  const pid = Number(props.MainPID);
  if (props.ActiveState === "active" && Number.isInteger(pid) && pid > 0) {
    return { found: true, result: { name: BOT_PROCESS_CHECK, status: "ok", detail: `läuft unter systemd (PID ${pid})` } };
  }
  if (props.ActiveState === "activating" || props.ActiveState === "reloading") {
    return { found: true, result: { name: BOT_PROCESS_CHECK, status: "warn", detail: `systemd startet ihn gerade (${props.SubState || props.ActiveState})`, hint: `später erneut prüfen: systemctl --user status ${unit}` } };
  }
  const exit = props.ExecMainStatus && props.ExecMainStatus !== "0" ? `, letzter Exit ${props.ExecMainStatus}` : "";
  return {
    found: true,
    result: {
      name: BOT_PROCESS_CHECK,
      status: "fail",
      detail: `systemd-Dienst ${unit} läuft nicht (${props.ActiveState || "?"}${props.SubState ? `/${props.SubState}` : ""}${exit})`,
      hint: `systemctl --user status ${unit} und logs/telegram-relay.error.log ansehen`,
    },
  };
}

interface Pm2Proc {
  name?: unknown;
  pid?: unknown;
  pm2_env?: { status?: unknown; restart_time?: unknown };
}

async function pm2Verdict(deps: BotAliveDeps): Promise<Verdict> {
  const name = pm2Name(BOT_SERVICE);
  const listed = await deps.pm2Query().catch((): Pm2Query => ({ status: "failed" }));
  if (listed.status === "not-running") return { found: false };
  if (listed.status === "failed") return { found: "unknown", why: "PM2 liefert keine lesbare Prozessliste" };
  const proc = (listed.processes as Pm2Proc[]).find(p => p && typeof p === "object" && p.name === name);
  if (!proc) return { found: false };
  const status = typeof proc.pm2_env?.status === "string" ? proc.pm2_env.status : "unbekannt";
  const pid = typeof proc.pid === "number" ? proc.pid : 0;
  if (status === "online" && pid > 0) return { found: true, result: { name: BOT_PROCESS_CHECK, status: "ok", detail: `läuft unter PM2 (PID ${pid})` } };
  return {
    found: true,
    result: { name: BOT_PROCESS_CHECK, status: "fail", detail: `PM2-Prozess ${name} läuft nicht (Status ${status.slice(0, 20)})`, hint: `pm2 logs ${name} ansehen` },
  };
}

/** Eintrag des Bots in `launchctl list` (PID, Status, Label) */
function launchdResult(stdout: string): CheckResult {
  const line = findLaunchctlLine(stdout, BOT_SERVICE);
  if (!line) return { name: BOT_PROCESS_CHECK, status: "fail", detail: `${launchdLabel(BOT_SERVICE)} nicht geladen`, hint: `${BRAND.cli} setup autostart` };
  const parts = line.trim().split(/\s+/);
  const pid = /^\d+$/.test(parts[0] ?? "") ? Number(parts[0]) : null;
  const lastExit = /^-?\d+$/.test(parts[1] ?? "") ? parts[1] : "?";
  if (!pid) return { name: BOT_PROCESS_CHECK, status: "fail", detail: `geladen, läuft aber nicht (letzter Exit ${lastExit})`, hint: "logs/telegram-relay.error.log ansehen" };
  return { name: BOT_PROCESS_CHECK, status: "ok", detail: `läuft (PID ${pid})` };
}

/**
 * Zeile „Bot-Prozess“. Linux: was systemd über den Bot weiß, hat Vorrang;
 * kennt systemd ihn nicht, zählt PM2. Kennt ihn keiner, obwohl beide
 * prüfbar waren: ❌ Dienst fehlt. War einer nicht prüfbar und der andere
 * kennt ihn nicht: ⚠️ nicht prüfbar.
 */
export async function checkBotProcess(deps: BotAliveDeps): Promise<CheckResult> {
  if (deps.platform === "darwin") return launchdResult(await deps.launchctlList());
  if (deps.platform !== "linux") return { name: BOT_PROCESS_CHECK, status: "na", detail: "nur macOS (launchd) und Linux (systemd, PM2)" };
  const systemd = await systemdVerdict(deps);
  if (systemd.found === true) return systemd.result;
  const pm2 = await pm2Verdict(deps);
  if (pm2.found === true) return pm2.result;
  const unknown = [systemd, pm2].filter((v): v is Extract<Verdict, { found: "unknown" }> => v.found === "unknown");
  if (unknown.length) {
    return {
      name: BOT_PROCESS_CHECK,
      status: "warn",
      detail: `nicht prüfbar: ${unknown.map(u => u.why).join(", ")}`,
      hint: `${BRAND.cli} pruefen zeigt den Dienst; die Zeile „${BOT_HEALTH_CHECK}“ sagt, ob er antwortet`,
    };
  }
  return {
    name: BOT_PROCESS_CHECK,
    status: "fail",
    detail: `kein Dienst für den Bot (weder systemd ${systemdUnitFile(BOT_SERVICE)} noch PM2 ${pm2Name(BOT_SERVICE)})`,
    hint: `${BRAND.cli} setup autostart`,
  };
}

// ---------------------------------------------------------------------------
// Health-Port
// ---------------------------------------------------------------------------

/** Adressen, unter denen der Health-Server auch auf 127.0.0.1 lauscht */
const LOOPBACK_HOSTS = new Set(["", "127.0.0.1", "localhost", "0.0.0.0"]);

/** Port aus HEALTH_PORT (Standard 3000 wie der Health-Server); null bei ungültigem Wert */
export function healthPort(env: Record<string, string | undefined>): number | null {
  const raw = (env.HEALTH_PORT ?? "").trim();
  if (!raw) return 3000;
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Zeile „Bot antwortet“: GET http://127.0.0.1:<HEALTH_PORT>/health. ✅ nur
 * mit HTTP 200 und service = HEALTH_SERVICE_ID; Weiterleitungen werden nicht
 * verfolgt. Lauscht der Health-Server laut HEALTH_HOST nicht auf
 * 127.0.0.1, bleibt die Zeile „–“.
 */
export async function checkHealthPort(env: Record<string, string | undefined>, deps: Pick<BotAliveDeps, "fetch">): Promise<CheckResult> {
  const name = BOT_HEALTH_CHECK;
  const host = (env.HEALTH_HOST ?? "").trim();
  if (!LOOPBACK_HOSTS.has(host)) return { name, status: "na", detail: "Health-Server nicht auf 127.0.0.1 (HEALTH_HOST)" };
  const port = healthPort(env);
  if (port === null) return { name, status: "fail", detail: "HEALTH_PORT ist keine gültige Portnummer", hint: "HEALTH_PORT in .env prüfen" };
  let res: Response;
  try {
    res = await deps.fetch(`http://127.0.0.1:${port}/health`, { redirect: "manual", signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS) });
  } catch (err) {
    if (isTimeout(err)) {
      return { name, status: "fail", detail: `Port ${port}: keine Antwort nach ${HEALTH_FETCH_TIMEOUT_MS / 1000} s`, hint: "Bot hängt? logs/telegram-relay.error.log ansehen" };
    }
    return { name, status: "fail", detail: `Port ${port}: keine Verbindung, der Bot läuft nicht`, hint: `Zeile „${BOT_PROCESS_CHECK}“ und logs/telegram-relay.error.log ansehen` };
  }
  let body: unknown = null;
  try {
    const text = await res.text();
    body = text.length <= HEALTH_BODY_MAX ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const data = body && typeof body === "object" ? (body as { service?: unknown; status?: unknown; uptime?: unknown }) : null;
  const ours = res.status === 200 && data?.service === HEALTH_SERVICE_ID;
  if (!ours) {
    const what = res.status === 200 ? "unbekannte Antwort" : `HTTP ${res.status}`;
    return { name, status: "fail", detail: `Port ${port}: ${what}, nicht der Health-Server von ${BRAND.name}`, hint: "anderes Programm auf HEALTH_PORT? Port in .env prüfen" };
  }
  if (data.status !== "ok") return { name, status: "warn", detail: `Port ${port}: meldet Zustand ${String(data.status).slice(0, 20)}` };
  const uptime = typeof data.uptime === "number" && Number.isFinite(data.uptime) ? `, läuft seit ${uptimeText(data.uptime)}` : "";
  return { name, status: "ok", detail: `Port ${port}${uptime}` };
}

function uptimeText(seconds: number): string {
  const min = Math.floor(seconds / 60);
  if (min < 60) return `${min} Min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} Std` : `${Math.floor(h / 24)} Tagen`;
}
