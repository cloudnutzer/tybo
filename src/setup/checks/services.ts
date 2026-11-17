/**
 * Dienstprüfung von `tybo pruefen` (Issue #372, vorher in setup/verify.ts):
 * ob der Bot und die Routinen als Dienst eingetragen sind und laufen, dazu
 * Supabase auf diesem Rechner.
 *
 * Alles läuft über den Kontext des Berichts: Befehle über ctx.run im
 * Projektordner mit Zeitlimit, Pfade aus ctx.root und ctx.systemdUserDir,
 * Plattform und Anmeldename aus ctx. PM2 wird nur aufgerufen, wenn es
 * installiert ist, nie über npx (das würde es erst herunterladen).
 *
 * Erkannt werden nur die eigenen Namen ai.tybo.<dienst> und tybo-<dienst>,
 * exakt verglichen (Issue #101, #142).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KILL_MODE, KILL_MODE_LINE, lingerCheckCommand, lingerCommand, parseShow } from "../../../setup/configure-systemd";
import { BRAND } from "../../brand";
import { BOT_SERVICE, findLaunchctlLine, pm2Name, SUPABASE_SERVICE, SUPABASE_START_STATE, systemdUnit, systemdUnitFile } from "../../lib/service-names";
import type { SetupContext } from "../context";
import { DB_CONTAINER, isLocalSupabaseUrl, PROJECT_LABEL } from "../local-supabase";
import type { Finding } from "./report";

/** Was die Dienstprüfung vom Kontext braucht */
export type ServiceCheckContext = Pick<SetupContext, "run" | "root" | "platform" | "systemdUserDir" | "user">;

/** Dienste, nach denen der Bericht fragt: Bot, Check-in, Briefing */
export const REPORTED_SERVICES = [BOT_SERVICE, "smart-checkin", "morning-briefing"] as const;

const COMMAND_TIMEOUT_MS = 15_000;
const PM2 = "pm2";
const AUTOSTART = "supabase (Autostart)";
const DATABASE = "supabase (Datenbank)";

interface Output {
  ok: boolean;
  text: string;
}

async function exec(ctx: ServiceCheckContext, cmd: string[]): Promise<Output> {
  const r = await ctx.run(cmd, { cwd: ctx.root, timeoutMs: COMMAND_TIMEOUT_MS });
  return { ok: r.code === 0, text: r.stdout.trim() };
}

const pass = (label: string, detail: string): Finding => ({ label, status: "pass", detail });
const warn = (label: string, detail: string): Finding => ({ label, status: "warn", detail });
const fail = (label: string, detail: string): Finding => ({ label, status: "fail", detail });
const skip = (label: string, detail: string): Finding => ({ label, status: "skip", detail });

// ---------------------------------------------------------------------------
// launchd
// ---------------------------------------------------------------------------

/** Spalten einer Zeile von launchctl list: PID ("-", wenn nichts läuft) und letzter Exit-Code */
function launchdColumns(listing: string, service: string): { pid: string; exit: string } | null {
  const line = findLaunchctlLine(listing, service);
  if (line === null) return null;
  const [pid = "-", exit = ""] = line.trim().split(/\s+/);
  return { pid, exit };
}

/** Dauerdienste (KeepAlive): ohne Prozess antwortet niemand, egal mit welchem Exit-Code (Issue #567) */
const LAUNCHD_DAEMONS: ReadonlySet<string> = new Set([BOT_SERVICE]);

/**
 * ai.tybo.<dienst> für jeden Dienst; ein einziges launchctl list. Ein
 * geladener Dauerdienst ohne PID ist ein Fehler, wie unter systemd (Issue
 * #567), auch mit letztem Exit 0; zeitgesteuerte Dienste stehen zwischen zwei
 * Läufen ohne PID in der Liste und bleiben wie bisher.
 */
export async function launchdFindings(ctx: ServiceCheckContext, services: readonly string[]): Promise<Finding[]> {
  const listing = await exec(ctx, ["launchctl", "list"]);
  if (!listing.ok) return [fail("launchctl", "launchctl list ließ sich nicht abfragen")];
  return services.map(service => {
    const cols = launchdColumns(listing.text, service);
    if (!cols) return skip(service, "Nicht eingerichtet");
    if (cols.pid !== "-") return pass(service, `Läuft (PID: ${cols.pid})`);
    if (LAUNCHD_DAEMONS.has(service)) {
      const exit = cols.exit && cols.exit !== "-" ? `letzter Exit-Code ${cols.exit}` : "letzter Exit-Code unbekannt";
      return fail(
        service,
        `Geladen, läuft aber nicht (${exit}), ${BRAND.name} antwortet so nicht. Ursache in logs/${service}.error.log, Abhilfe in docs/troubleshooting.md unter „Bot-Dienst startet nicht (macOS)“`
      );
    }
    // Zeitgesteuerte Dienste stehen zwischen zwei Läufen mit Exit 0 in der Liste
    if (cols.exit === "0") return pass(service, "Geladen, letzter Exit 0 (wartet auf den Zeitplan)");
    return warn(service, `Geladen, letzter Exit-Code ${cols.exit}`);
  });
}

// ---------------------------------------------------------------------------
// PM2
// ---------------------------------------------------------------------------

interface Pm2Process {
  name?: string;
  pid?: number;
  pm2_env?: { status?: string };
}

type Pm2Listing = { state: "missing" } | { state: "unreadable" } | { state: "ok"; procs: Pm2Process[] };

/** pm2 jlist des installierten PM2; startet es nicht, gilt PM2 als nicht installiert */
async function pm2Listing(ctx: ServiceCheckContext): Promise<Pm2Listing> {
  const out = await exec(ctx, [PM2, "jlist"]);
  if (!out.ok) return { state: "missing" };
  try {
    const parsed: unknown = JSON.parse(out.text);
    return Array.isArray(parsed) ? { state: "ok", procs: parsed as Pm2Process[] } : { state: "unreadable" };
  } catch {
    return { state: "unreadable" };
  }
}

const pm2Entry = (procs: Pm2Process[], service: string) => procs.find(p => p?.name === pm2Name(service));

/** tybo-<dienst> für jeden Dienst; ein einziges pm2 jlist */
export async function pm2Findings(ctx: ServiceCheckContext, services: readonly string[]): Promise<Finding[]> {
  const listing = await pm2Listing(ctx);
  if (listing.state === "missing") {
    return [skip("PM2", "PM2 nicht installiert (npm install -g pm2)"), ...services.map(s => skip(s, "Kein Dienstverwalter gefunden"))];
  }
  if (listing.state === "unreadable") return [warn("PM2", "Ausgabe von PM2 nicht lesbar")];
  return services.map(service => {
    const entry = pm2Entry(listing.procs, service);
    if (!entry) return skip(service, "Nicht in PM2 eingetragen");
    const status = entry.pm2_env?.status ?? "unbekannt";
    return status === "online" ? pass(service, `Läuft über PM2 (PID: ${entry.pid})`) : warn(service, `PM2-Status: ${status}`);
  });
}

// ---------------------------------------------------------------------------
// systemd (Issue #207)
// ---------------------------------------------------------------------------

/**
 * Bot als systemd-Benutzerdienst: Lauf, Aktivierung und Linger (Start nach
 * einem Neustart ohne Anmeldung). null, wenn es keine Dienstdatei gibt;
 * dann gilt für den Bot PM2.
 */
export async function systemdFindings(ctx: ServiceCheckContext, exists: (path: string) => boolean = existsSync): Promise<Finding[] | null> {
  const unitFile = systemdUnitFile(BOT_SERVICE);
  if (!exists(join(ctx.systemdUserDir, unitFile))) return null;
  const unit = systemdUnit(BOT_SERVICE);
  const show = await exec(ctx, ["systemctl", "--user", "show", unitFile, "--property=ActiveState,SubState,UnitFileState,MainPID,KillMode"]);
  if (!show.ok) {
    return [fail(BOT_SERVICE, "systemd-Benutzerdienst antwortet nicht (systemctl --user); als normaler Benutzer prüfen, nicht über sudo")];
  }
  const props = parseShow(show.text);
  const found: Finding[] = [];
  switch (props.ActiveState) {
    case "active":
      found.push(pass(BOT_SERVICE, `Läuft als systemd-Benutzerdienst ${unit} (PID: ${props.MainPID ?? "?"})`));
      break;
    case "activating":
      found.push(warn(BOT_SERVICE, `systemd startet ${unit} gerade (neu), siehe logs/telegram-relay.error.log`));
      break;
    default:
      found.push(fail(BOT_SERVICE, `systemd-Status ${props.ActiveState ?? "unbekannt"}: systemctl --user start ${unit}, Ursache in logs/telegram-relay.error.log`));
  }
  if (props.UnitFileState !== "enabled") {
    found.push(warn(`${BOT_SERVICE} (Autostart)`, `Nicht aktiviert, startet nicht mit dem Rechner: systemctl --user enable ${unit}`));
  }
  // Issue #561: alte Dienstdatei ohne KillMode=process (wirksamer Wert samt Drop-ins); fehlt der Wert, keine Zeile
  if (props.KillMode && props.KillMode !== KILL_MODE) {
    found.push(
      warn(
        `${BOT_SERVICE} (Hintergrund-Jobs)`,
        `Ein Neustart des Bots beendet auch laufende Hintergrund-Jobs (KillMode=${props.KillMode}, nötig ist ${KILL_MODE_LINE}). Nachziehen ohne Neustart: ${BRAND.cli} setup autostart`
      )
    );
  }
  found.push(await lingerFinding(ctx));
  return found;
}

async function lingerFinding(ctx: ServiceCheckContext): Promise<Finding> {
  const label = `${BOT_SERVICE} (Linger)`;
  const out = await exec(ctx, ["loginctl", "show-user", ctx.user, "--property=Linger", "--value"]);
  if (out.ok && out.text === "yes") return pass(label, "Startet nach einem Neustart auch ohne Anmeldung");
  if (out.ok && out.text === "no") return warn(label, `Startet nach einem Neustart erst mit der Anmeldung: ${lingerCommand(ctx.user)}`);
  // loginctl scheiterte: sudo hilft nicht zwingend, also nur der Prüfweg
  return warn(label, `Ob er nach einem Neustart ohne Anmeldung startet, ließ sich nicht prüfen. Prüfen mit: ${lingerCheckCommand(ctx.user)} und systemctl status systemd-logind`);
}

// ---------------------------------------------------------------------------
// Supabase auf diesem Rechner (Issue #165)
// ---------------------------------------------------------------------------

/**
 * Zustandsdatei der Hülle run-once-and-stay (SUPABASE_START_STATE). Sie zählt
 * nur, wenn sie zur PID des PM2-Eintrags gehört: die Hülle bleibt auch nach
 * einem gescheiterten Start „online“.
 */
function startState(root: string): { pid?: unknown; state?: unknown; exitCode?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, SUPABASE_START_STATE), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** ai.tybo.supabase ist ein Einmalaufruf: beendet mit Exit 0 ist Erfolg, kein Absturz */
async function supabaseLaunchd(ctx: ServiceCheckContext): Promise<Finding> {
  const listing = await exec(ctx, ["launchctl", "list"]);
  if (!listing.ok) return fail(AUTOSTART, "launchctl list schlug fehl");
  const cols = launchdColumns(listing.text, SUPABASE_SERVICE);
  if (!cols) return warn(AUTOSTART, "Nicht eingerichtet: nach einem Neustart fehlt Supabase (tybo setup autostart)");
  if (cols.pid !== "-") return pass(AUTOSTART, `Startet gerade (PID: ${cols.pid})`);
  if (cols.exit === "0") return pass(AUTOSTART, "Eingerichtet, letzter Aufruf erfolgreich (Exit 0)");
  return warn(AUTOSTART, `Letzter Aufruf fehlgeschlagen (Exit ${cols.exit}), siehe logs/supabase.log`);
}

/** tybo-supabase bleibt über die Hülle „online“; ob der Start gelang, sagt erst die Zustandsdatei */
async function supabasePm2(ctx: ServiceCheckContext): Promise<Finding> {
  const listing = await pm2Listing(ctx);
  if (listing.state === "missing") return skip(AUTOSTART, "PM2 nicht gefunden: ob Supabase nach einem Neustart startet, ist nicht prüfbar (tybo setup autostart)");
  if (listing.state === "unreadable") return skip(AUTOSTART, "PM2-Liste nicht lesbar");
  const entry = pm2Entry(listing.procs, SUPABASE_SERVICE);
  if (!entry) return warn(AUTOSTART, "Nicht in PM2 eingetragen: nach einem Neustart fehlt Supabase (tybo setup autostart)");
  const status = entry.pm2_env?.status;
  if (status !== "online") {
    return warn(AUTOSTART, `PM2-Status ${status ?? "unbekannt"}: so startet PM2 Supabase nach einem Neustart nicht. Neu eintragen mit tybo setup autostart`);
  }
  const state = startState(ctx.root);
  if (!state || state.pid !== entry.pid) {
    return warn(AUTOSTART, "Eingerichtet, aber das Ergebnis des letzten Starts ist unbekannt (keine passende Zustandsdatei). Neu eintragen mit tybo setup autostart");
  }
  if (state.state === "läuft") return pass(AUTOSTART, "Eingerichtet, Supabase startet gerade (Protokoll logs/supabase.log)");
  if (state.exitCode === 0) {
    return pass(AUTOSTART, "Eingerichtet, letzter Start erfolgreich (Exit 0), startet Supabase bei jedem Hochfahren einmal (Protokoll logs/supabase.log)");
  }
  return warn(AUTOSTART, `Letzter Start fehlgeschlagen (Exit ${String(state.exitCode)}): Ursache in logs/supabase.log, danach von Hand tybo datenbank start`);
}

/** Läuft der Datenbank-Container in Docker? */
async function supabaseContainer(ctx: ServiceCheckContext): Promise<Finding> {
  const ps = await exec(ctx, ["docker", "ps", "--filter", `label=${PROJECT_LABEL}`, "--format", "{{.Names}}"]);
  if (!ps.ok) return warn(DATABASE, "Docker antwortet nicht");
  const names = ps.text.split("\n").map(n => n.trim());
  return names.includes(DB_CONTAINER) ? pass(DATABASE, `Container ${DB_CONTAINER} läuft`) : fail(DATABASE, "Datenbank-Container läuft nicht: tybo datenbank start");
}

/** Autostart und Container, nur wenn SUPABASE_URL auf diesen Rechner zeigt; sonst kein Befehl */
export async function localSupabaseFindings(ctx: ServiceCheckContext, env: Record<string, string | undefined>): Promise<Finding[]> {
  if (!isLocalSupabaseUrl(env.SUPABASE_URL)) return [];
  const autostart = ctx.platform === "darwin" ? await supabaseLaunchd(ctx) : await supabasePm2(ctx);
  return [autostart, await supabaseContainer(ctx)];
}

// ---------------------------------------------------------------------------
// Gesamt
// ---------------------------------------------------------------------------

/**
 * Alle Dienstzeilen des Berichts: macOS über launchd; Linux mit Dienstdatei
 * den Bot über systemd und die übrigen über ein installiertes PM2; sonst
 * alles über PM2. Danach Supabase auf diesem Rechner.
 */
export async function serviceFindings(ctx: ServiceCheckContext, env: Record<string, string | undefined>): Promise<Finding[]> {
  const found: Finding[] = [];
  if (ctx.platform === "darwin") found.push(...(await launchdFindings(ctx, REPORTED_SERVICES)));
  else {
    const viaSystemd = ctx.platform === "linux" ? await systemdFindings(ctx) : null;
    if (!viaSystemd) found.push(...(await pm2Findings(ctx, REPORTED_SERVICES)));
    else {
      found.push(...viaSystemd);
      const others = REPORTED_SERVICES.filter(s => s !== BOT_SERVICE);
      if ((await exec(ctx, [PM2, "--version"])).ok) found.push(...(await pm2Findings(ctx, others)));
      else found.push(...others.map(s => skip(s, "Nicht eingerichtet (PM2 nicht installiert)")));
    }
  }
  found.push(...(await localSupabaseFindings(ctx, env)));
  return found;
}
