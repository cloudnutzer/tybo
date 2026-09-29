/**
 * Schritt „autostart“: der Bot startet mit dem Rechner und nach Abstürzen.
 * macOS über launchd; Linux mit systemd standardmäßig über einen
 * systemd-Benutzerdienst (Issue #207, setup/configure-systemd.ts), PM2 bleibt
 * wählbar; sonst über PM2. Nutzt die Funktionen aus setup/configure-launchd.ts,
 * setup/configure-services.ts und setup/configure-systemd.ts statt Kopien.
 *
 * Auswahl (Issue #207, autostartPlan): Ist der Bot schon unter systemd oder
 * PM2 eingerichtet, bleibt es bei diesem Weg; ein Wechsel wird abgelehnt, mit
 * den Befehlen zum Entfernen des alten Diensts, damit nie zwei Bots
 * gleichzeitig laufen. dump.pm2 wird dabei immer gelesen, auch wenn die
 * PM2-CLI im PATH fehlt. Steht er in beiden, oder lässt sich die PM2-Liste
 * oder dump.pm2 nicht lesen, startet nichts. Antwortet der systemd-Benutzerdienst nicht (etwa über
 * sudo gestartet), gibt es keinen Standard: PM2 nur ausdrücklich gewählt.
 *
 * Eingerichtet wird nur der Bot selbst (telegram-relay), kein pauschales
 * „all“: das würde Check-in, Briefing, Watchdog und auf macOS auch den
 * Cloudflare-Tunnel mit anlegen. Ist der Dienst schon aktiv (launchd: geladen,
 * PM2: in der Liste), bleibt er unberührt; ein Neuladen würde den laufenden
 * Bot beenden. Unter PM2 zählt der Dienst erst als eingerichtet, wenn er auch
 * in PM2s Sicherungsliste (dump.pm2, geschrieben von „pm2 save“) steht; läuft
 * er nur, holt apply() allein das Speichern nach, ohne ihn neu zu starten.
 * Liegt auf macOS nur die Plist da (etwa nach einem
 * gescheiterten Laden), gilt das nicht als eingerichtet, und apply() lädt sie
 * erneut. Lässt sich der Zustand nicht lesen, ändert apply() nichts. PM2 wird
 * ohne npx aufgerufen, damit nichts nachinstalliert wird.
 *
 * Dienste heißen ai.tybo.telegram-relay bzw. tybo-telegram-relay (Issue
 * #101). Dienste anderer Namen zählen nicht und werden nie angefasst (Issue
 * #142).
 *
 * Meldungen enthalten nie rohe Befehlsausgaben (stderr kann Geheimnisse aus
 * der Umgebung enthalten), nur feste Texte je Fehlerart.
 *
 * Supabase auf diesem Rechner (Issue #165): Zeigt die .env auf das lokale
 * Supabase (Weg „supabase-lokal“, Convex nicht aktiv), richtet der Schritt
 * zusätzlich ai.tybo.supabase bzw. tybo-supabase ein (einmal
 * `tybo datenbank start` beim Anmelden bzw. bei jedem Start von PM2; unter
 * PM2 über die Hülle run-once-and-stay, die danach stehen bleibt), mit eigener Zeile im
 * Status. Nach denselben Regeln wie beim Bot, unabhängig von ihm: ein schon
 * eingerichteter Bot überspringt den Supabase-Dienst nicht, und der Bot bleibt
 * dabei unberührt.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configureService, plistPathFor, type LaunchdDeps } from "../../../setup/configure-launchd";
import { configurePM2Service, ONCE_WRAPPER, type Pm2Deps } from "../../../setup/configure-services";
import {
  enableSystemdService,
  ensureLinger,
  installSystemdService,
  lingerCheckCommand,
  lingerCommand,
  lingerState,
  startSystemdService,
  SYSTEMD_UNIT,
  systemdBooted,
  systemdUnitPath,
  systemdUnitState,
  type ConfigureResult,
  type LingerOutcome,
  type SystemdDeps,
} from "../../../setup/configure-systemd";
import { BRAND } from "../../brand";
import { BOT_SERVICE, labelInLaunchctlList, launchdLabel, pm2Name, SUPABASE_SERVICE } from "../../lib/service-names";
import { readSetupEnv, type CommandResult, type SetupContext } from "../context";
import { envValues } from "./common";
import type { ApplyResult, SetupStep, StatusItem, StepStatus } from "../model";
import { setupPath } from "./database";

export const AUTOSTART_SERVICE = BOT_SERVICE;
type Service = typeof BOT_SERVICE | typeof SUPABASE_SERVICE;

/** Supabase-Dienst gehört dazu: .env zeigt auf das Supabase dieses Rechners (und Convex ist nicht aktiv) */
export async function wantsSupabaseService(ctx: SetupContext): Promise<boolean> {
  try {
    return setupPath(await readSetupEnv(ctx)) === "supabase-lokal";
  } catch {
    return false;
  }
}
export const PM2_INSTALL = "npm install -g pm2";

const ANSI = /\x1b\[[0-9;]*m/g;

function runOk(ctx: SetupContext) {
  return async (cmd: string[], options?: { timeoutMs?: number }) => {
    const r = await ctx.run(cmd, { cwd: ctx.root, timeoutMs: options?.timeoutMs ?? 30_000 });
    return { ok: r.code === 0, stdout: r.stdout, stderr: r.stderr };
  };
}

export function launchdDeps(ctx: SetupContext, log: string[]): LaunchdDeps {
  return {
    projectRoot: ctx.root,
    launchAgentsDir: ctx.launchAgentsDir,
    home: ctx.home,
    run: runOk(ctx),
    exists: existsSync,
    readFile: path => readFileSync(path, "utf-8"),
    writeFile: (path, content) => writeFileSync(path, content, { encoding: "utf-8", mode: 0o644 }),
    mkdir: path => mkdirSync(path, { recursive: true }),
    log: line => log.push(line.replace(ANSI, "").trim()),
  };
}

export function pm2Deps(ctx: SetupContext, log: string[]): Pm2Deps {
  return { projectRoot: ctx.root, pm2: ["pm2"], run: runOk(ctx), log: line => log.push(line.replace(ANSI, "").trim()) };
}

export function systemdDeps(ctx: SetupContext): SystemdDeps {
  return {
    projectRoot: ctx.root,
    home: ctx.home,
    unitDir: ctx.systemdUserDir,
    runDir: ctx.systemdRunDir,
    user: ctx.user,
    run: runOk(ctx),
    exists: existsSync,
    writeFile: (path, content) => writeFileSync(path, content, { encoding: "utf-8", mode: 0o644 }),
    mkdir: path => mkdirSync(path, { recursive: true }),
  };
}

function plistPath(ctx: SetupContext, service: Service = AUTOSTART_SERVICE): string {
  return plistPathFor(service, ctx.launchAgentsDir);
}

const LAUNCHD_LABEL = launchdLabel(AUTOSTART_SERVICE);
const PM2_NAME = pm2Name(AUTOSTART_SERVICE);

/**
 * Fehlerart aus dem Skript-Protokoll als fester Text. Die Protokollzeilen
 * selbst (mit stderr von launchctl oder PM2) gehen nie nach außen.
 */
function failureReason(log: string[], service: Service = AUTOSTART_SERVICE): string {
  const text = log.join("\n");
  const label = launchdLabel(service);
  const name = pm2Name(service);
  if (/Template not found/.test(text)) return "Die launchd-Vorlage fehlt im Projektordner.";
  if (/Could not find bun/.test(text)) return "Bun wurde nicht im PATH gefunden.";
  if (/Existing unload failed/.test(text)) return `Der Dienst ${label} ließ sich nicht entladen. Dienstdateien unverändert, kein weiterer Dienst geladen.`;
  if (/State unknown/.test(text)) return `Ob der Dienst ${label} geladen ist, ließ sich nicht feststellen (launchctl list). Nichts geändert.`;
  if (/Existing delete failed/.test(text)) return `Der PM2-Prozess ${name} ließ sich nicht neu starten, weil er sich nicht entfernen ließ. Kein weiterer Prozess gestartet.`;
  if (/PM2 list unreadable/.test(text)) return "Die Liste der PM2-Dienste ließ sich nicht lesen (pm2 jlist). Nichts geändert.";
  if (/Load failed/.test(text)) return "launchctl konnte den Dienst nicht laden. Die Dienstdatei liegt da; ein erneuter Versuch lädt sie noch einmal.";
  if (/Start failed/.test(text)) return `PM2 konnte ${service === AUTOSTART_SERVICE ? "den Bot" : name} nicht starten. Details mit: pm2 logs ${name}`;
  return "Unbekannter Fehler.";
}

/** Zustand unter launchd: keine Plist, geladen, nur Datei, nicht lesbar */
type LaunchdState = "missing" | "loaded" | "not-loaded" | "unknown";

/**
 * „loaded“ heißt: das Label steht in launchctl list. Für ai.tybo.supabase
 * (kein KeepAlive) bleibt es dort auch nach dem Ende des Aufrufs stehen.
 */
async function launchdState(ctx: SetupContext, service: Service = AUTOSTART_SERVICE): Promise<LaunchdState> {
  if (!existsSync(plistPath(ctx, service))) return "missing";
  const list = await ctx.run(["launchctl", "list"], { timeoutMs: 15_000 });
  if (list.code !== 0) return "unknown";
  return labelInLaunchctlList(list.stdout, launchdLabel(service)) ? "loaded" : "not-loaded";
}

/**
 * Zustand unter PM2; „unknown“, wenn die vorhandene CLI nicht antwortet
 * (pm2 --version scheitert oder läuft in die Zeitüberschreitung) oder jlist
 * scheitert bzw. unlesbar ist.
 * „running“: läuft, fehlt aber in dump.pm2 (pm2 save steht noch aus).
 * „renew“ (nur tybo-supabase): gestoppt oder ohne die Hülle eingetragen;
 * so startet PM2 es beim Hochfahren nicht (mehr), es muss neu eingetragen werden.
 */
type Pm2State = "not-installed" | "saved" | "running" | "renew" | "absent" | "unknown";

/**
 * Steht der Dienst in dump.pm2? tybo-supabase zählt nur mit Status „online“:
 * pm2 resurrect trägt gespeicherte „stopped“-Einträge ein, startet sie aber
 * nicht. Gelesen werden nur Name und Status, nie ausgegeben.
 */
function pm2Saved(ctx: SetupContext, service: Service = AUTOSTART_SERVICE): boolean {
  const dump = readPm2Dump(ctx);
  if (!Array.isArray(dump)) return false;
  const entry: any = dump.find((p: any) => p?.name === pm2Name(service));
  if (!entry) return false;
  return service !== SUPABASE_SERVICE || entry.status === "online";
}

/**
 * Inhalt von dump.pm2; „missing“ nur, wenn die Datei fehlt. Nicht lesbar
 * (Rechte, Ordner statt Datei) oder kein JSON-Array: „unreadable“.
 */
function readPm2Dump(ctx: SetupContext): unknown[] | "missing" | "unreadable" {
  let text: string;
  try {
    text = readFileSync(ctx.pm2DumpPath, "utf-8");
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "unreadable";
  }
  try {
    const dump = JSON.parse(text);
    return Array.isArray(dump) ? dump : "unreadable";
  } catch {
    return "unreadable";
  }
}

/**
 * Steht der Bot in dump.pm2, unabhängig davon, ob die PM2-CLI im PATH liegt?
 * pm2 resurrect holt ihn dann beim Hochfahren zurück. „unknown“: Datei da,
 * aber nicht lesbar oder ungültig.
 */
function pm2DumpBot(ctx: SetupContext): "yes" | "no" | "unknown" {
  const dump = readPm2Dump(ctx);
  if (dump === "missing") return "no";
  if (dump === "unreadable") return "unknown";
  return dump.some((p: any) => p?.name === PM2_NAME) ? "yes" : "no";
}

/**
 * tybo-supabase läuft über die Hülle run-once-and-stay und bleibt nach dem
 * Supabase-Start „online“. Gestoppt (oder ohne Hülle eingetragen, dann endet
 * es nach dem Start) würde der nächste pm2 save es als „stopped“ sichern.
 */
function supabaseNeedsRenew(proc: any): boolean {
  if (proc?.pm2_env?.status !== "online") return true;
  const args = proc?.pm2_env?.args;
  // Ohne --state kann die Gesamtprüfung das Ergebnis des Starts nicht lesen
  return Array.isArray(args) && !(args.some((a: unknown) => String(a).endsWith(ONCE_WRAPPER)) && args.includes("--state"));
}

/**
 * pm2 fehlt wirklich: der Befehl startete nicht, weil er in keinem PATH-Ordner
 * liegt (spawnError „ENOENT“). Alles andere ist ein unbekannter Zustand: eine
 * nicht ausführbare CLI, ein fehlender Interpreter (Exit 127 von env), eine
 * defekte oder hängende CLI. Dort kann schon ein Bot laufen, der noch nicht in
 * dump.pm2 steht.
 */
function pm2Missing(r: CommandResult): boolean {
  if (r.timedOut || r.aborted) return false;
  return r.code === -1 && r.spawnError === "ENOENT";
}

async function pm2State(ctx: SetupContext, service: Service = AUTOSTART_SERVICE): Promise<Pm2State> {
  const version = await ctx.run(["pm2", "--version"], { timeoutMs: 15_000 });
  if (version.code !== 0) return pm2Missing(version) ? "not-installed" : "unknown";
  const list = await ctx.run(["pm2", "jlist"], { timeoutMs: 15_000 });
  if (list.code !== 0) return "unknown";
  let parsed: unknown;
  try {
    parsed = JSON.parse(list.stdout);
  } catch {
    return "unknown";
  }
  if (!Array.isArray(parsed)) return "unknown";
  const proc = parsed.find((p: any) => p?.name === pm2Name(service));
  if (!proc) return "absent";
  if (service === SUPABASE_SERVICE && supabaseNeedsRenew(proc)) return "renew";
  return pm2Saved(ctx, service) ? "saved" : "running";
}

const ALREADY: ApplyResult = { ok: true, message: "Autostart ist schon eingerichtet, nichts geändert.", changed: [] };

async function applyLaunchd(ctx: SetupContext): Promise<ApplyResult> {
  const path = plistPath(ctx);
  const state = await launchdState(ctx);
  if (state === "loaded") return ALREADY;
  if (state === "unknown") {
    return { ok: false, message: "Ob der Dienst schon läuft, ließ sich nicht prüfen (launchctl list schlug fehl). Nichts geändert.", changed: [] };
  }
  if (state === "not-loaded") {
    // Plist liegt da, ist aber nicht geladen: nur erneut laden, Datei bleibt
    const load = await ctx.run(["launchctl", "load", path], { cwd: ctx.root, timeoutMs: 30_000 });
    if (load.code !== 0) {
      return { ok: false, message: "Autostart ließ sich nicht einrichten: launchctl konnte den Dienst nicht laden. Die Dienstdatei liegt unverändert da.", changed: [] };
    }
    return { ok: true, message: `Autostart eingerichtet: ${BRAND.name} läuft jetzt und startet mit dem Rechner.`, changed: [path] };
  }

  // „missing“: Plist schreiben und laden
  /** Geänderte Dateien: die neue Plist, falls da */
  const touched = () => (existsSync(path) ? [path] : []);
  const log: string[] = [];
  let ok: boolean;
  try {
    ok = await configureService(AUTOSTART_SERVICE, launchdDeps(ctx, log));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return {
      ok: false,
      message: `Autostart ließ sich nicht einrichten: die Dienstdatei konnte nicht geschrieben werden${code ? ` (${code})` : ""}.`,
      changed: touched(),
    };
  }
  if (!ok) return { ok: false, message: `Autostart ließ sich nicht einrichten: ${failureReason(log)}`, changed: touched() };
  return { ok: true, message: `Autostart eingerichtet: ${BRAND.name} läuft jetzt und startet mit dem Rechner.`, changed: touched() };
}

const PM2_SAVE_FAILED = `aber „pm2 save“ ist gescheitert: nach einem Neustart des Rechners fehlt der Dienst. Einmal „pm2 save“ ausführen, dann „pm2 startup“.`;
const PM2_STARTUP_HINT = "Damit PM2 nach einem Neustart des Rechners mitstartet, einmal „pm2 startup“ ausführen und die ausgegebene Zeile übernehmen.";

async function savePm2(ctx: SetupContext): Promise<boolean> {
  const save = await ctx.run(["pm2", "save"], { cwd: ctx.root, timeoutMs: 30_000 });
  return save.code === 0;
}

async function applyPm2(ctx: SetupContext): Promise<ApplyResult> {
  const state = await pm2State(ctx);
  if (state === "not-installed") return { ok: false, message: `PM2 fehlt. Erst installieren mit: ${PM2_INSTALL}`, changed: [] };
  if (state === "saved") return ALREADY;
  if (state === "unknown") {
    // Nie auf Verdacht löschen und neu starten: der Bot könnte laufen
    return { ok: false, message: "Die Liste der PM2-Dienste ließ sich nicht lesen (pm2 jlist). Nichts geändert; mit „pm2 list“ prüfen.", changed: [] };
  }
  if (state === "running") {
    // Läuft schon, nur das Speichern fehlt: nicht neu starten, nur pm2 save wiederholen
    if (!(await savePm2(ctx))) return { ok: false, message: `${BRAND.name} läuft unter PM2, ${PM2_SAVE_FAILED}`, changed: [] };
    return { ok: true, message: `${BRAND.name} läuft unter PM2 und ist jetzt gespeichert. ${PM2_STARTUP_HINT}`, changed: [`pm2:${PM2_NAME}`] };
  }
  // „absent“: starten, danach speichern
  const log: string[] = [];
  const ok = await configurePM2Service(AUTOSTART_SERVICE, pm2Deps(ctx, log));
  if (!ok) return { ok: false, message: `Autostart ließ sich nicht einrichten: ${failureReason(log)}`, changed: [] };
  if (!(await savePm2(ctx))) {
    return { ok: false, message: `${BRAND.name} läuft jetzt unter PM2, ${PM2_SAVE_FAILED}`, changed: [`pm2:${PM2_NAME}`] };
  }
  return { ok: true, message: `${BRAND.name} läuft jetzt unter PM2. ${PM2_STARTUP_HINT}`, changed: [`pm2:${PM2_NAME}`] };
}

// ---------------------------------------------------------------------------
// systemd-Benutzerdienst (Issue #207)
// ---------------------------------------------------------------------------

export type AutostartManager = "launchd" | "systemd" | "pm2";
export const AUTOSTART_MANAGERS: readonly AutostartManager[] = ["launchd", "systemd", "pm2"];

export const MANAGER_LABEL: Record<AutostartManager, string> = {
  launchd: "launchd",
  systemd: "systemd-Benutzerdienst",
  pm2: "PM2",
};

const UNIT_PATH_TEXT = `~/.config/systemd/user/${SYSTEMD_UNIT}.service`;
export const SYSTEMD_UNREACHABLE = `Der systemd-Benutzerdienst antwortet nicht (systemctl --user). ${BRAND.cli} setup als normaler Benutzer in einer Anmeldesitzung starten, nicht über sudo oder su.`;
/**
 * Befehle zum Entfernen, damit nie zwei Bots laufen. PM2: „save --force“
 * schreibt dump.pm2 auch dann neu, wenn der Bot nur noch dort steht (delete
 * findet ihn dann nicht, ein leeres „pm2 save“ überschriebe nichts).
 */
const REMOVE_PM2 = `pm2 delete ${PM2_NAME}; pm2 save --force`;
const REMOVE_SYSTEMD = `systemctl --user disable --now ${SYSTEMD_UNIT} && rm ${UNIT_PATH_TEXT}`;

/** Was „Autostart einrichten“ tun kann */
export interface AutostartPlan {
  /** Wählbare Wege; leer, wenn nichts geht */
  managers: AutostartManager[];
  /** Ohne Auswahl genommen; null: nur ausdrücklich gewählt */
  default: AutostartManager | null;
  /** Schon eingerichteter Weg, der bleibt */
  existing?: AutostartManager;
  /** Warum gerade nichts eingerichtet wird */
  blocked?: string;
  /** Hinweis zur Auswahl */
  note?: string;
}

/** Bot fehlt in pm2 jlist (oder die CLI fehlt), steht aber in dump.pm2 */
function pm2StoredOnly(ctx: SetupContext, state: Pm2State): boolean {
  return (state === "absent" || state === "not-installed") && pm2DumpBot(ctx) === "yes";
}

const DUMP_UNREADABLE = "PM2s Sicherungsliste (dump.pm2) ließ sich nicht lesen; ob PM2 den Bot beim Hochfahren startet, ist unklar.";

function linuxWithSystemd(ctx: SetupContext): boolean {
  return ctx.platform === "linux" && systemdBooted(systemdDeps(ctx));
}

export async function autostartPlan(ctx: SetupContext): Promise<AutostartPlan> {
  if (ctx.platform === "darwin") return { managers: ["launchd"], default: "launchd" };
  if (!linuxWithSystemd(ctx)) return { managers: ["pm2"], default: "pm2" };
  const unit = await systemdUnitState(systemdDeps(ctx));
  const pm2 = await pm2State(ctx);
  const unitThere = unit.fileExists || (unit.reachable && unit.loaded);
  // dump.pm2 immer lesen, auch ohne PM2-CLI im PATH: pm2 resurrect holt den Bot beim Hochfahren zurück
  const dump = pm2DumpBot(ctx);
  const pm2Bot = pm2 === "saved" || pm2 === "running" || dump === "yes";
  const blocked = (why: string): AutostartPlan => ({ managers: [], default: null, blocked: why });
  if (unitThere && pm2Bot) {
    return blocked(`${BRAND.name} ist sowohl als systemd-Benutzerdienst als auch unter PM2 eingetragen; dann holen sich zwei Bots dieselben Nachrichten. Nichts geändert. Einen davon entfernen, etwa PM2 mit: ${REMOVE_PM2}`);
  }
  // Unter PM2 unklar: nur ein schon laufender systemd-Dienst bleibt, nichts startet neu
  if (!pm2Bot && !(unit.reachable && unit.active)) {
    if (pm2 === "unknown") {
      return blocked("PM2 antwortete nicht (pm2 --version oder pm2 jlist scheiterte); ob dort schon ein Bot läuft, ist unklar. Nichts gestartet; mit „pm2 list“ prüfen.");
    }
    if (dump === "unknown") return blocked(`${DUMP_UNREADABLE} Nichts gestartet; Datei prüfen (Rechte, Inhalt).`);
  }
  if (unitThere) return { managers: ["systemd"], default: "systemd", existing: "systemd" };
  if (pm2Bot) return { managers: ["pm2"], default: "pm2", existing: "pm2" };
  if (!unit.reachable) return { managers: ["pm2"], default: null, note: `${SYSTEMD_UNREACHABLE} Sonst geht PM2.` };
  return { managers: ["systemd", "pm2"], default: "systemd" };
}

/** Gewählter Weg oder eine Meldung, warum nichts eingerichtet wird */
export async function chooseManager(ctx: SetupContext, requested?: string): Promise<{ manager: AutostartManager } | { error: string }> {
  if (requested !== undefined && !AUTOSTART_MANAGERS.includes(requested as AutostartManager)) return { error: "Unbekannte Art des Autostarts." };
  const wanted = requested as AutostartManager | undefined;
  // Ohne systemd wie bisher: PM2 ohne zusätzliche Abfragen
  if (ctx.platform !== "darwin" && !linuxWithSystemd(ctx) && wanted !== "systemd" && wanted !== "launchd") return { manager: "pm2" };
  const plan = await autostartPlan(ctx);
  if (plan.blocked) return { error: plan.blocked };
  if (wanted && !plan.managers.includes(wanted)) {
    if (plan.existing === "pm2") return { error: `${BRAND.name} ist schon unter PM2 eingerichtet und bleibt dort. Für den systemd-Dienst erst den PM2-Eintrag entfernen (${REMOVE_PM2}), dann erneut ${BRAND.cli} setup autostart.` };
    if (plan.existing === "systemd") return { error: `${BRAND.name} ist schon als systemd-Benutzerdienst eingerichtet und bleibt dort. Für PM2 erst den Dienst entfernen (${REMOVE_SYSTEMD}), dann erneut ${BRAND.cli} setup autostart.` };
    return { error: wanted === "systemd" ? "Dieser Rechner läuft nicht mit systemd; Autostart geht hier über PM2." : `${MANAGER_LABEL[wanted]} gibt es auf diesem Rechner nicht.` };
  }
  const manager = wanted ?? plan.default;
  if (!manager) return { error: plan.note ?? SYSTEMD_UNREACHABLE };
  return { manager };
}

const SYSTEMD_RUNNING = `${BRAND.name} läuft als systemd-Benutzerdienst ${SYSTEMD_UNIT} und startet nach Abstürzen von selbst neu. Protokoll in logs/telegram-relay.log.`;

/** Hinweis, wenn Linger fehlt und sich ohne Administratorrechte nicht einschalten ließ */
export function lingerHint(user: string): string {
  return `Noch offen: nach einem Neustart des Rechners startet ${BRAND.name} erst, wenn du dich anmeldest. Das einzuschalten braucht Administratorrechte, einmal im Terminal ausführen: ${lingerCommand(user)} Danach prüft „${BRAND.cli} setup autostart“ es erneut.`;
}

function lingerUnverified(user: string): string {
  return `Noch offen: „loginctl enable-linger“ lief durch, aber ob ${BRAND.name} nach einem Neustart ohne Anmeldung startet, ließ sich nicht nachprüfen. Prüfen mit: ${lingerCheckCommand(user)} (erwartet: Linger=yes).`;
}

/** loginctl scheiterte nicht an der Berechtigung: kein sudo-Vorschlag, sondern Prüfhinweis */
export function lingerFailed(user: string): string {
  return `Noch offen: Linger ließ sich nicht einschalten, und das lag nicht an fehlenden Rechten (etwa systemd-logind nicht erreichbar oder Benutzer unbekannt); ohne Linger startet ${BRAND.name} nach einem Neustart erst mit der Anmeldung. Prüfen mit: ${lingerCheckCommand(user)} und systemctl status systemd-logind. Danach prüft „${BRAND.cli} setup autostart“ es erneut.`;
}

function systemdFailure(r: Exclude<ConfigureResult, { ok: true }>): string {
  switch (r.reason) {
    case "no-bun":
      return "Bun wurde nicht im PATH gefunden.";
    case "unsafe-path":
      return "Der Projektordner oder der Pfad zu Bun oder Claude enthält Leerzeichen oder Zeichen wie % $ : oder Anführungszeichen, die eine systemd-Dienstdatei nicht sicher aufnimmt. Projekt in einen Ordner ohne solche Zeichen legen oder PM2 wählen.";
    case "write":
      return `die Dienstdatei konnte nicht geschrieben werden${r.code ? ` (${r.code})` : ""}.`;
    case "reload":
      return "systemctl --user daemon-reload schlug fehl. Die Dienstdatei liegt da; ein erneuter Versuch startet den Dienst.";
    case "enable":
      return `systemd konnte den Dienst nicht starten. Details mit: systemctl --user status ${SYSTEMD_UNIT} und in logs/telegram-relay.error.log`;
  }
}

async function applySystemd(ctx: SetupContext): Promise<ApplyResult> {
  const deps = systemdDeps(ctx);
  const unit = await systemdUnitState(deps);
  if (!unit.reachable) return { ok: false, message: `Autostart ließ sich nicht einrichten: ${SYSTEMD_UNREACHABLE} Nichts geändert.`, changed: [] };
  const path = systemdUnitPath(ctx.systemdUserDir);
  let changed: string[] = [];
  let intro: string;
  if (unit.active && unit.enabled) {
    intro = "";
  } else if (unit.active) {
    // Läuft schon: nur aktivieren, enable ohne --now startet nichts neu
    if (!(await enableSystemdService(deps))) {
      return { ok: false, message: `${BRAND.name} läuft als ${SYSTEMD_UNIT}, ließ sich aber nicht für den Start mit dem Rechner aktivieren (systemctl --user enable). Nichts neu gestartet.`, changed: [], running: true };
    }
    changed = [`systemd:${SYSTEMD_UNIT}`];
    intro = `${BRAND.name} lief schon als ${SYSTEMD_UNIT} und startet jetzt auch mit dem Rechner, ohne Neustart.`;
  } else {
    const fresh = !unit.fileExists && !unit.loaded;
    const env = await envValues(ctx, ["CLAUDE_PATH"]);
    let result: ConfigureResult;
    try {
      result = fresh ? await installSystemdService(deps, env.CLAUDE_PATH) : await startSystemdService(deps, unit.loaded);
    } catch {
      result = { ok: false, reason: "write" };
    }
    const touched = existsSync(path) && fresh ? [path] : [];
    if (!result.ok) return { ok: false, message: `Autostart ließ sich nicht einrichten: ${systemdFailure(result)}`, changed: touched };
    changed = fresh ? touched : [`systemd:${SYSTEMD_UNIT}`];
    intro = `Autostart eingerichtet: ${SYSTEMD_RUNNING}`;
  }
  const linger: LingerOutcome = await ensureLinger(deps);
  if (linger === "already" && !intro) return ALREADY;
  if (linger === "already" || linger === "enabled") {
    const text = linger === "enabled" ? "Linger ist jetzt an: er startet auch nach einem Neustart des Rechners ohne Anmeldung." : "Er startet auch nach einem Neustart des Rechners ohne Anmeldung.";
    if (linger === "enabled") changed = [...changed, `linger:${ctx.user}`];
    return { ok: true, message: `${intro || `${BRAND.name} läuft schon als ${SYSTEMD_UNIT}.`} ${text}`, changed };
  }
  const open = linger === "needs-sudo" ? lingerHint(ctx.user) : linger === "failed" ? lingerFailed(ctx.user) : lingerUnverified(ctx.user);
  return { ok: false, message: `${intro || `${BRAND.name} läuft als ${SYSTEMD_UNIT}.`} ${open}`, changed, running: true };
}

/** Status unter systemd, wenn die Dienstdatei da ist oder der Dienst geladen */
async function systemdStatus(ctx: SetupContext, unit: Awaited<ReturnType<typeof systemdUnitState>>): Promise<StepStatus> {
  if (!unit.reachable) return { state: "teilweise", detail: `Die Dienstdatei ${SYSTEMD_UNIT}.service liegt da. ${SYSTEMD_UNREACHABLE}`, fields: [] };
  if (!unit.active) return { state: "teilweise", detail: `Die Dienstdatei ${SYSTEMD_UNIT}.service liegt da, der Dienst läuft aber nicht. Einrichten startet ihn.`, fields: [] };
  if (!unit.enabled) return { state: "teilweise", detail: `${SYSTEMD_UNIT} läuft, startet aber nicht mit dem Rechner (nicht aktiviert). Einrichten aktiviert ihn, ohne ihn neu zu starten.`, fields: [] };
  const linger = await lingerState(systemdDeps(ctx));
  if (linger === "yes") return { state: "erledigt", detail: `systemd-Benutzerdienst ${SYSTEMD_UNIT} läuft und startet mit dem Rechner, auch ohne Anmeldung.`, fields: [] };
  return {
    state: "teilweise",
    detail:
      linger === "no"
        ? `systemd-Benutzerdienst ${SYSTEMD_UNIT} läuft, startet nach einem Neustart aber erst mit der Anmeldung (Linger ist aus).`
        : `systemd-Benutzerdienst ${SYSTEMD_UNIT} läuft; ob er nach einem Neustart ohne Anmeldung startet (Linger), ließ sich nicht prüfen.`,
    fields: [],
    // Nur „Linger ist aus“ braucht sudo; ließ es sich nicht lesen, erst prüfen
    items: [{ label: "Linger", ok: false, detail: "Start ohne Anmeldung ist nicht bestätigt.", fix: linger === "no" ? lingerCommand(ctx.user) : lingerCheckCommand(ctx.user) }],
  };
}

// ---------------------------------------------------------------------------
// Supabase auf diesem Rechner (Issue #165)
// ---------------------------------------------------------------------------

const SUPA_LABEL = launchdLabel(SUPABASE_SERVICE);
const SUPA_PM2 = pm2Name(SUPABASE_SERVICE);
const SUPA_ALREADY: ApplyResult = { ok: true, message: "Supabase-Autostart ist schon eingerichtet, nichts geändert.", changed: [] };
const SUPA_DONE_LAUNCHD = `Supabase-Autostart eingerichtet: ${SUPA_LABEL} startet Supabase beim Anmelden (wartet bis zu 5 Minuten auf Docker), Protokoll in logs/supabase.log.`;
const SUPA_DONE_PM2 = `Supabase-Autostart eingerichtet: PM2 startet ${SUPA_PM2} einmal mit (wartet bis zu 5 Minuten auf Docker), Protokoll in logs/supabase.log.`;

/** launchd legt den Ordner der Protokolldatei nicht selbst an */
function ensureLogsDir(ctx: SetupContext) {
  mkdirSync(join(ctx.root, "logs"), { recursive: true });
}

async function applySupabaseLaunchd(ctx: SetupContext): Promise<ApplyResult> {
  const path = plistPath(ctx, SUPABASE_SERVICE);
  const state = await launchdState(ctx, SUPABASE_SERVICE);
  if (state === "loaded") return SUPA_ALREADY;
  if (state === "unknown") {
    return { ok: false, message: `Ob ${SUPA_LABEL} schon eingerichtet ist, ließ sich nicht prüfen (launchctl list schlug fehl). Nichts geändert.`, changed: [] };
  }
  try {
    ensureLogsDir(ctx);
  } catch {
    return { ok: false, message: "Supabase-Autostart ließ sich nicht einrichten: der Ordner logs/ ließ sich nicht anlegen.", changed: [] };
  }
  if (state === "not-loaded") {
    const load = await ctx.run(["launchctl", "load", path], { cwd: ctx.root, timeoutMs: 30_000 });
    if (load.code !== 0) {
      return { ok: false, message: "Supabase-Autostart ließ sich nicht einrichten: launchctl konnte den Dienst nicht laden. Die Dienstdatei liegt unverändert da.", changed: [] };
    }
    return { ok: true, message: SUPA_DONE_LAUNCHD, changed: [path] };
  }
  const touched = () => (existsSync(path) ? [path] : []);
  const log: string[] = [];
  let ok: boolean;
  try {
    ok = await configureService(SUPABASE_SERVICE, launchdDeps(ctx, log));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return { ok: false, message: `Supabase-Autostart ließ sich nicht einrichten: die Dienstdatei konnte nicht geschrieben werden${code ? ` (${code})` : ""}.`, changed: touched() };
  }
  if (!ok) return { ok: false, message: `Supabase-Autostart ließ sich nicht einrichten: ${failureReason(log, SUPABASE_SERVICE)}`, changed: touched() };
  return { ok: true, message: SUPA_DONE_LAUNCHD, changed: touched() };
}

async function applySupabasePm2(ctx: SetupContext): Promise<ApplyResult> {
  const state = await pm2State(ctx, SUPABASE_SERVICE);
  if (state === "not-installed") return { ok: false, message: `Supabase-Autostart braucht PM2. Erst installieren mit: ${PM2_INSTALL}`, changed: [] };
  if (state === "saved") return SUPA_ALREADY;
  if (state === "unknown") return { ok: false, message: "Supabase-Autostart: die Liste der PM2-Dienste ließ sich nicht lesen (pm2 jlist). Nichts geändert.", changed: [] };
  const changed = [`pm2:${SUPA_PM2}`];
  // „renew“: configurePM2Service entfernt den alten Eintrag und startet die Hülle
  // (tybo datenbank start ist wiederholbar); „running“ wird nie neu gestartet
  if (state === "absent" || state === "renew") {
    try {
      ensureLogsDir(ctx);
    } catch {
      return { ok: false, message: "Supabase-Autostart ließ sich nicht einrichten: der Ordner logs/ ließ sich nicht anlegen.", changed: [] };
    }
    const log: string[] = [];
    if (!(await configurePM2Service(SUPABASE_SERVICE, pm2Deps(ctx, log)))) {
      return { ok: false, message: `Supabase-Autostart ließ sich nicht einrichten: ${failureReason(log, SUPABASE_SERVICE)}`, changed: [] };
    }
  }
  // danach immer speichern, damit dump.pm2 den laufenden Eintrag enthält
  if (!(await savePm2(ctx))) return { ok: false, message: `${SUPA_PM2} ist in PM2 eingetragen, ${PM2_SAVE_FAILED}`, changed };
  return { ok: true, message: `${SUPA_DONE_PM2} ${PM2_STARTUP_HINT}`, changed };
}

/** Eigene Statuszeile des Supabase-Diensts */
async function supabaseItem(ctx: SetupContext): Promise<StatusItem & { state: "erledigt" | "fehlt" | "teilweise" }> {
  const label = "Supabase-Autostart";
  if (ctx.platform === "darwin") {
    const state = await launchdState(ctx, SUPABASE_SERVICE);
    if (state === "loaded") return { label, ok: true, state: "erledigt", detail: `${SUPA_LABEL} ist eingerichtet und startet Supabase beim Anmelden.` };
    if (state === "missing") return { label, ok: false, state: "fehlt", detail: `Noch kein ${SUPA_LABEL}: nach einem Neustart fehlt Supabase, bis ${BRAND.cli} datenbank start läuft.` };
    return {
      label,
      ok: false,
      state: "teilweise",
      detail: state === "not-loaded" ? `Die Dienstdatei ${SUPA_LABEL} liegt da, ist aber nicht geladen. Einrichten lädt sie erneut.` : `Ob ${SUPA_LABEL} geladen ist, ließ sich nicht prüfen (launchctl list).`,
    };
  }
  const state = await pm2State(ctx, SUPABASE_SERVICE);
  if (state === "saved") return { label, ok: true, state: "erledigt", detail: `${SUPA_PM2} ist in PM2 eingetragen und gespeichert.` };
  if (state === "running") return { label, ok: false, state: "teilweise", detail: `${SUPA_PM2} ist in PM2 eingetragen, aber nicht als laufend gespeichert (pm2 save). Einrichten speichert.` };
  if (state === "renew") return { label, ok: false, state: "teilweise", detail: `${SUPA_PM2} ist in PM2 gestoppt oder in alter Form eingetragen; so startet PM2 Supabase nach einem Neustart nicht. Einrichten trägt es neu ein und speichert.` };
  if (state === "unknown") return { label, ok: false, state: "teilweise", detail: "Die Liste der PM2-Dienste ließ sich nicht lesen (pm2 jlist)." };
  return { label, ok: false, state: "fehlt", detail: `Noch kein ${SUPA_PM2} in PM2.` };
}

/** Status des Bots allein (wie vor Issue #165) */
async function botStatus(ctx: SetupContext): Promise<StepStatus> {
  if (ctx.platform === "darwin") {
    const state = await launchdState(ctx);
    if (state === "loaded") return { state: "erledigt", detail: "launchd-Dienst ist eingerichtet und geladen.", fields: [] };
    if (state === "missing") return { state: "fehlt", detail: "Noch kein Autostart über launchd.", fields: [] };
    return {
      state: "teilweise",
      detail:
        state === "not-loaded"
          ? "Die Dienstdatei liegt da, der Dienst ist aber nicht geladen. Einrichten lädt ihn erneut."
          : "Die Dienstdatei liegt da; ob der Dienst geladen ist, ließ sich nicht prüfen (launchctl list).",
      fields: [],
    };
  }
  if (linuxWithSystemd(ctx)) {
    const unit = await systemdUnitState(systemdDeps(ctx));
    if (unit.fileExists || (unit.reachable && unit.loaded)) return systemdStatus(ctx, unit);
    const pm2 = await pm2State(ctx);
    if (pm2StoredOnly(ctx, pm2)) {
      const how = pm2 === "not-installed" ? `PM2 selbst wurde aber nicht gefunden (${PM2_INSTALL}).` : "Einrichten startet ihn unter PM2.";
      return { state: "teilweise", detail: `${PM2_NAME} steht in PM2s Sicherungsliste (dump.pm2), läuft aber gerade nicht. ${how}`, fields: [] };
    }
    if (pm2 === "unknown" && pm2DumpBot(ctx) === "yes") {
      return { state: "teilweise", detail: `${PM2_NAME} steht in PM2s Sicherungsliste (dump.pm2); ob er gerade läuft, ließ sich nicht prüfen, PM2 antwortete nicht.`, fields: [] };
    }
    if ((pm2 === "not-installed" || pm2 === "absent") && pm2DumpBot(ctx) === "unknown") {
      return { state: "teilweise", detail: DUMP_UNREADABLE, fields: [] };
    }
    if (pm2 === "not-installed" || pm2 === "absent") {
      return {
        state: "fehlt",
        detail: unit.reachable
          ? "Noch kein Autostart. Vorschlag: systemd-Benutzerdienst (PM2 geht auch)."
          : `Noch kein Autostart. ${SYSTEMD_UNREACHABLE}`,
        fields: [],
      };
    }
  }
  const pm2 = await pm2State(ctx);
  if (pm2 === "not-installed") {
    return {
      state: "fehlt",
      detail: "PM2 ist nicht installiert.",
      fields: [],
      items: [{ label: "PM2", ok: false, detail: "PM2 nicht gefunden.", fix: PM2_INSTALL }],
    };
  }
  if (pm2 === "unknown") {
    return { state: "teilweise", detail: "Die Liste der PM2-Dienste ließ sich nicht lesen (pm2 jlist).", fields: [] };
  }
  if (pm2 === "running") {
    return {
      state: "teilweise",
      detail: "Der PM2-Dienst läuft, ist aber nicht gespeichert (pm2 save). Einrichten speichert ihn, ohne ihn neu zu starten.",
      fields: [],
    };
  }
  return {
    state: pm2 === "saved" ? "erledigt" : "fehlt",
    detail: pm2 === "saved" ? "PM2-Dienst ist eingerichtet und gespeichert." : "Noch kein Autostart über PM2.",
    fields: [],
  };
}

export const autostartStep: SetupStep = {
  id: "autostart",
  title: "Autostart",
  description: `${BRAND.name} startet mit dem Rechner und nach Abstürzen von selbst.`,
  optional: false,
  fields: [],

  async status(ctx) {
    const bot = await botStatus(ctx);
    if (!(await wantsSupabaseService(ctx))) return bot;
    // Eigene Zeile für Supabase; erledigt erst, wenn beide eingerichtet sind
    const { state: supa, ...item } = await supabaseItem(ctx);
    const botItem: StatusItem = { label: `${BRAND.name}-Autostart`, ok: bot.state === "erledigt", detail: bot.detail };
    const state = bot.state === supa ? bot.state : "teilweise";
    return { ...bot, state, detail: `${bot.detail} ${item.detail}`, items: [...(bot.items ?? [botItem]), item] };
  },

  /**
   * Prüft, ob sich der Autostart einrichten lässt; ist er schon aktiv, genügt
   * das. values.manager: gewählter Weg (Issue #207), sonst der Standard.
   */
  async test(values, ctx) {
    if ((await autostartStep.status(ctx)).state === "erledigt") {
      return { ok: true, message: "Autostart ist eingerichtet." };
    }
    const items: StatusItem[] = [];
    if (ctx.platform === "darwin") {
      const state = await launchdState(ctx);
      if (state === "unknown") {
        items.push({ label: "launchd", ok: false, detail: "launchctl list schlug fehl, der Zustand des Diensts ist unbekannt." });
      } else if (state === "not-loaded") {
        items.push({ label: "Dienstdatei", ok: true, detail: "Dienstdatei vorhanden, wird beim Einrichten erneut geladen." });
      } else {
        const template = existsSync(join(ctx.root, "launchd", `${LAUNCHD_LABEL}.plist.template`));
        items.push({ label: "Vorlage", ok: template, detail: template ? "launchd-Vorlage vorhanden." : "launchd-Vorlage fehlt im Projektordner." });
        const bun = await ctx.run(["which", "bun"], { timeoutMs: 10_000 });
        items.push({ label: "Bun im PATH", ok: bun.code === 0, detail: bun.code === 0 ? "Bun gefunden." : "Bun nicht im PATH gefunden." });
      }
    } else {
      const chosen = await chooseManager(ctx, values.manager);
      if ("error" in chosen) {
        items.push({ label: "Autostart", ok: false, detail: chosen.error });
      } else if (chosen.manager === "systemd") {
        const unit = await systemdUnitState(systemdDeps(ctx));
        items.push({ label: "systemd", ok: unit.reachable, detail: unit.reachable ? "systemd-Benutzerdienst erreichbar." : SYSTEMD_UNREACHABLE });
        if (unit.reachable && !unit.fileExists && !unit.loaded) {
          const bun = await ctx.run(["which", "bun"], { timeoutMs: 10_000 });
          items.push({ label: "Bun im PATH", ok: bun.code === 0, detail: bun.code === 0 ? "Bun gefunden." : "Bun nicht im PATH gefunden." });
        }
        // Supabase auf diesem Rechner bleibt bei PM2 (Issue #207)
        if ((await wantsSupabaseService(ctx)) && (await pm2State(ctx, SUPABASE_SERVICE)) === "not-installed") {
          items.push({ label: "PM2 für Supabase", ok: false, detail: "Supabase-Autostart braucht PM2, PM2 nicht gefunden.", fix: PM2_INSTALL });
        }
      } else {
        const pm2 = await pm2State(ctx);
        const installed = pm2 !== "not-installed";
        items.push({
          label: "PM2",
          ok: installed,
          detail: installed ? "PM2 gefunden." : "PM2 nicht gefunden.",
          fix: installed ? undefined : PM2_INSTALL,
        });
        if (pm2 === "running") {
          items.push({ label: "PM2-Speicherung", ok: true, detail: "Dienst läuft, „pm2 save“ fehlt noch und wird beim Einrichten nachgeholt." });
        }
        if (pm2 === "unknown") items.push({ label: "PM2-Dienste", ok: false, detail: "Die Liste der PM2-Dienste ließ sich nicht lesen (pm2 jlist)." });
      }
    }
    if (ctx.platform === "darwin" && (await wantsSupabaseService(ctx)) && (await launchdState(ctx, SUPABASE_SERVICE)) === "missing") {
      const template = existsSync(join(ctx.root, "launchd", `${SUPA_LABEL}.plist.template`));
      items.push({ label: "Vorlage Supabase", ok: template, detail: template ? "launchd-Vorlage für Supabase vorhanden." : "launchd-Vorlage für Supabase fehlt im Projektordner." });
    }
    const failed = items.filter(i => !i.ok);
    return { ok: failed.length === 0, message: failed.length ? failed.map(i => i.detail).join(" ") : "Autostart kann eingerichtet werden.", items };
  },

  /** values.manager: gewählter Weg (Issue #207); fehlt er, der Standard */
  async apply(values, ctx) {
    let bot: ApplyResult;
    if (ctx.platform === "darwin") {
      bot = await applyLaunchd(ctx);
    } else {
      const chosen = await chooseManager(ctx, values.manager);
      if ("error" in chosen) bot = { ok: false, message: chosen.error, changed: [] };
      else bot = chosen.manager === "systemd" ? await applySystemd(ctx) : await applyPm2(ctx);
    }
    if (!(await wantsSupabaseService(ctx))) return bot;
    // Unabhängig vom Bot: auch wenn er schon eingerichtet war oder scheiterte
    const supa = ctx.platform === "darwin" ? await applySupabaseLaunchd(ctx) : await applySupabasePm2(ctx);
    const botMessage = supa.message.includes(PM2_STARTUP_HINT) ? bot.message.replace(` ${PM2_STARTUP_HINT}`, "") : bot.message;
    const result: ApplyResult = { ok: bot.ok && supa.ok, message: `${botMessage} ${supa.message}`, changed: [...bot.changed, ...supa.changed] };
    // Der Bot läuft (eingerichtet oder nur Linger offen), auch wenn Supabase scheiterte
    if (bot.running || (bot.ok && !supa.ok)) result.running = true;
    return result;
  },
};
