/**
 * Dienst-Versionen (Issue #486): Läuft ein Dienst noch mit einer älteren
 * Version, als installiert ist, startet tybo ihn neu und prüft danach, dass
 * er wieder läuft und die neue Version meldet.
 *
 * Anlass (installationsbezogen, im Repo nicht belegt): Homebrew hatte
 * cloudflared aktualisiert, der Dienst ai.tybo.cloudflare-tunnel lief aber
 * noch tagelang mit der alten Version, weil niemand ihn neu startete.
 *
 * Welche Dienste: nur die aus "dienste" in config/wartung.json
 * (config.ts). Ohne Eintrag wird kein Dienst angefasst.
 *
 * Je Dienst:
 * 1. installierte Version: versionBefehl ausführen, erste Versionsnummer
 *    aus der Ausgabe
 * 2. Zustand beim Dienstmanager: launchctl list <label>, systemctl --user
 *    show <unit>, pm2 jlist. Läuft er nicht: kein Neustart, nur Meldung.
 * 3. laufende Version:
 *    - metrik: Prometheus-Text von einer Adresse auf diesem Rechner, Zeile
 *      <name>{…<label>="1.2.3"…}, etwa build_info{version="…"} bei
 *      cloudflared
 *    - binaer (Ersatz, beweist keine Versionsnummer): Prozess des Diensts
 *      (PID vom Dienstmanager) und sein Programmpfad gegen die Binärdatei
 *      samt Symlink-Ziel. Läuft der Prozess aus einem anderen Pfad mit
 *      gleichem Programmnamen (alter Homebrew-Cellar) oder hat sich die
 *      Datei bzw. ihr Symlink nach dem Prozessstart geändert, gilt er als
 *      veraltet. Gehört der Prozess zu einem anderen Programm: unbekannt.
 *    Unbekannte Version, fehlende Metrik oder unlesbarer Prozess lösen nie
 *    einen Neustart aus.
 * 4. nur wenn die laufende Version älter ist und der Aufruf Neustarts
 *    erlaubt (mode "neustart"): launchctl kickstart -k gui/<uid>/<label>,
 *    systemctl --user restart <unit> bzw. pm2 restart <name>. Danach bis
 *    wartezeitSek alle zwei Sekunden frisch messen: Dienst läuft, neue PID,
 *    neue Version. Jede Messung bekommt höchstens die restliche Wartezeit
 *    als Zeitlimit; was erst nach der Frist ankommt, zählt nicht. Bleibt
 *    etwas aus, steht es als Fehler in Meldung und Zustand.
 *
 * Der Bot selbst (TYBO_LAUNCHD_LABEL, ai.tybo.telegram-relay,
 * TYBO_SYSTEMD_UNIT, tybo-telegram-relay.service, PM2 tybo-telegram-relay)
 * wird nie über den Dienstmanager neu gestartet: dabei fielen alle
 * laufenden Antworten weg. Für ihn gibt es nur die Anfrage über
 * data/restart-requested (wie bun run restart:request), der Bot startet
 * neu, sobald keine Antwort mehr läuft.
 *
 * Fehlertexte nennen vom Versionsbefehl nur das Programm, nie die
 * Argumente. Bevor ein Ergebnis gespeichert, gezeigt oder gemeldet wird,
 * fallen bekannte Geheimnisse heraus (maskServiceText): Werte geheim
 * benannter Variablen (isSecretName, samt Projekt-.env), Zugangsdaten aus
 * den Argumenten der Versionsbefehle und Muster wie token=…, Bearer … oder
 * ein Passwort in einer Adresse.
 *
 * Neustarts laufen unter der Sperre data/dienste.lock, die
 * `bun run updates --apply` und `tybo wartung` teilen; ist sie belegt,
 * prüft der zweite Lauf nicht und startet nichts. Der Nachtcheck, --smoke
 * und die Probeläufe nutzen mode "pruefen": kein Neustart, keine Sperre.
 */

import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tryAcquireFileLock, releaseFileLock, type FileLockOptions } from "../file-lock";
import { SYSTEMD_UNIT_ENV, supervisorLabels } from "../restart-request";
import { BOT_SERVICE, pm2Name, systemdUnitFile } from "../service-names";
import { isSecretName } from "../subprocess-env";
import { isNewer, parseVersion } from "../version";
import { loadMaintenanceConfig, MaintenanceConfigError, type ServiceManager, type WatchedService } from "./config";

export const SERVICES_LOCK_FILE = join("data", "dienste.lock");

/** Zeitlimits der Messungen */
export const VERSION_TIMEOUT_MS = 15_000;
export const METRIC_TIMEOUT_MS = 5_000;
export const PROCESS_TIMEOUT_MS = 10_000;
export const FILE_TIMEOUT_MS = 5_000;
export const RESTART_TIMEOUT_MS = 60_000;
/** Abstand der Messungen nach einem Neustart */
export const POLL_MS = 2_000;
/** Spielraum zwischen Prozessstart und Änderungszeit der Binärdatei */
export const CLOCK_SLACK_MS = 2_000;

export interface ServiceCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface FileTimes {
  /** Ziel nach allen Symlinks */
  realPath: string;
  /** jüngste Änderung (mtime, ctime) am Pfad selbst und an seinem Ziel */
  changedMs: number;
}

export interface ProcessInfo {
  startedMs: number;
  /** Programmpfad des Prozesses */
  exe: string;
}

/** Zugriffe nach außen; Tests setzen Attrappen ein, nie echte Dienstbefehle */
export interface ServiceDeps {
  platform: NodeJS.Platform;
  uid: number;
  env: Record<string, string | undefined>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Befehl ohne Shell; code 127, wenn das Programm fehlt */
  run(cmd: string[], timeoutMs: number): Promise<ServiceCommandResult>;
  /** Text einer Adresse; wirft bei Fehler oder Status außer 2xx */
  fetchText(url: string, timeoutMs: number): Promise<string>;
  /** Startzeit und Programmpfad; null, wenn nicht lesbar oder nicht in timeoutMs */
  processInfo(pid: number, timeoutMs: number): Promise<ProcessInfo | null>;
  /** Symlink-Ziel und Änderungszeit; null, wenn die Datei fehlt oder nicht in timeoutMs lesbar ist */
  fileTimes(path: string, timeoutMs: number): Promise<FileTimes | null>;
  /** Neustart des Bots nach der laufenden Antwort anfordern (data/restart-requested) */
  requestBotRestart(note: string): Promise<void>;
  /** Pfad der gemeinsamen Sperre */
  lockPath: string;
  lock?: FileLockOptions;
}

export type ServiceMode = "pruefen" | "neustart";

export type ServiceOutcome =
  /** läuft mit der installierten Version */
  | "aktuell"
  /** läuft älter als installiert; im Modus pruefen: würde neu gestartet */
  | "veraltet"
  /** neu gestartet, läuft und meldet die neue Version */
  | "neu-gestartet"
  /** Bot: Neustart nach der laufenden Antwort angefordert */
  | "neustart-angefordert"
  /** Dienst läuft nicht (gestoppt oder nicht geladen); nicht angefasst */
  | "gestoppt"
  /** Version nicht feststellbar; nicht angefasst */
  | "unbekannt"
  /** läuft neuer als installiert; nicht angefasst */
  | "abweichend"
  /** Neustart gescheitert oder danach noch alt bzw. nicht gestartet */
  | "fehler";

export interface ServiceResult {
  name: string;
  manager: ServiceManager;
  target: string;
  outcome: ServiceOutcome;
  installed?: string;
  /** gemessene laufende Version (nur mit Metrik); bei neu-gestartet die nach dem Neustart */
  running?: string;
  /** bei neu-gestartet: Version vor dem Neustart (nur mit Metrik bekannt) */
  previous?: string;
  /** Befund in Worten, bei unbekannt und fehler der Grund */
  detail?: string;
}

export interface ServiceCheckRun {
  mode: ServiceMode;
  startedAt: string;
  finishedAt: string;
  /** ok: nichts zu tun oder alles neu gestartet; warn: Abweichung ohne Fehler; fehler */
  status: "ok" | "warn" | "fehler";
  services: ServiceResult[];
  /** Abbruch vor den Diensten (Konfiguration, Sperre) */
  error?: string;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Zeitlimit einer Messung: höchstens limit, nach einem Neustart höchstens bis zur Frist */
type Budget = (limit: number) => number;
const fullBudget: Budget = limit => limit;

// ---------------------------------------------------------------------------
// Bot-Schutz

/** Ist das Ziel der Dienst des Bots? Dann nie über den Dienstmanager neu starten */
export function isBotTarget(manager: ServiceManager, target: string, env: Record<string, string | undefined>): boolean {
  if (manager === "launchd") return supervisorLabels(env).includes(target);
  if (manager === "systemd") {
    const configured = env[SYSTEMD_UNIT_ENV]?.trim();
    return target === systemdUnitFile(BOT_SERVICE) || (!!configured && target === configured);
  }
  return target === pm2Name(BOT_SERVICE);
}

// ---------------------------------------------------------------------------
// Dienstmanager

export interface ServiceStatus {
  state: "running" | "stopped" | "missing";
  pid: number | null;
}

/** Ausgabe von `launchctl list <label>`; code ungleich 0: nicht geladen */
export function parseLaunchctlStatus(r: ServiceCommandResult): ServiceStatus {
  if (r.code !== 0) return { state: "missing", pid: null };
  const pid = r.stdout.match(/"PID"\s*=\s*(\d+)/);
  return pid ? { state: "running", pid: Number(pid[1]) } : { state: "stopped", pid: null };
}

/** Ausgabe von `systemctl --user show <unit> --property=LoadState,ActiveState,MainPID` */
export function parseSystemctlStatus(r: ServiceCommandResult): ServiceStatus {
  if (r.code !== 0) throw new Error(`systemctl: ${lastLine(r) || `Exit ${r.code}`}`);
  const props: Record<string, string> = {};
  for (const line of r.stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) props[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  if (props.LoadState === "not-found" || props.LoadState === undefined) return { state: "missing", pid: null };
  const pid = Number(props.MainPID);
  return props.ActiveState === "active" && pid > 0 ? { state: "running", pid } : { state: "stopped", pid: null };
}

/** Ausgabe von `pm2 jlist` für den Prozess name */
export function parsePm2Status(r: ServiceCommandResult, name: string): ServiceStatus {
  if (r.code !== 0) throw new Error(`pm2: ${lastLine(r) || `Exit ${r.code}`}`);
  let list: unknown;
  try {
    list = JSON.parse(r.stdout.slice(r.stdout.indexOf("[")));
  } catch {
    throw new Error("pm2 jlist nicht lesbar");
  }
  if (!Array.isArray(list)) throw new Error("pm2 jlist nicht lesbar");
  const entries = list.filter(p => p && typeof p === "object" && (p as { name?: unknown }).name === name) as Array<{ pid?: unknown; pm2_env?: { status?: unknown } }>;
  if (entries.length === 0) return { state: "missing", pid: null };
  if (entries.length > 1) throw new Error(`${name} steht ${entries.length}-mal in pm2 jlist`);
  const pid = Number(entries[0].pid);
  return entries[0].pm2_env?.status === "online" && pid > 0 ? { state: "running", pid } : { state: "stopped", pid: null };
}

/** Letzte Zeile der Ausgabe; ungekürzt, damit das Maskieren kein halbes Geheimnis stehen lässt (gekürzt wird in maskResult) */
function lastLine(r: ServiceCommandResult): string {
  return `${r.stderr}\n${r.stdout}`.split("\n").map(l => l.trim()).filter(Boolean).at(-1) ?? "";
}

export async function serviceStatus(s: WatchedService, deps: ServiceDeps, budget: Budget = fullBudget): Promise<ServiceStatus> {
  const t = budget(VERSION_TIMEOUT_MS);
  if (s.manager === "launchd") return parseLaunchctlStatus(await deps.run(["launchctl", "list", s.target], t));
  if (s.manager === "systemd") return parseSystemctlStatus(await deps.run(["systemctl", "--user", "show", s.target, "--property=LoadState,ActiveState,MainPID"], t));
  return parsePm2Status(await deps.run(["pm2", "jlist"], t), s.target);
}

/** Neustartbefehl; nie für den Bot (isBotTarget) */
export function restartCommand(s: WatchedService, uid: number): string[] {
  if (s.manager === "launchd") return ["launchctl", "kickstart", "-k", `gui/${uid}/${s.target}`];
  if (s.manager === "systemd") return ["systemctl", "--user", "restart", s.target];
  return ["pm2", "restart", s.target];
}

// ---------------------------------------------------------------------------
// Versionen

/** Wert des Labels label in der ersten Zeile der Metrik metric; null, wenn es keine gibt */
export function parseMetricVersion(text: string, metric: string, label: string): string | null {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith(`${metric}{`)) continue;
    const labels = line.slice(metric.length + 1, line.indexOf("}") > 0 ? line.indexOf("}") : undefined);
    for (const m of labels.matchAll(/([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
      if (m[1] === label) return parseVersion(m[2]) ?? null;
    }
  }
  return null;
}

/** Nur das Programm des Versionsbefehls: die Argumente können Zugangsdaten enthalten */
const program = (s: WatchedService) => basename(s.versionCommand[0]);

async function installedVersion(s: WatchedService, deps: ServiceDeps): Promise<string> {
  const r = await deps.run(s.versionCommand, VERSION_TIMEOUT_MS);
  if (r.code !== 0) throw new Error(`${program(s)}: ${r.code === 127 ? "nicht gefunden" : lastLine(r) || `Exit ${r.code}`}`);
  const v = parseVersion(`${r.stdout}\n${r.stderr}`);
  if (!v) throw new Error(`${program(s)}: keine Versionsnummer in der Ausgabe`);
  return v;
}

/** Laufende Version im Vergleich zu installed: aktuell, veraltet, abweichend oder unbekannt (mit Grund) */
type Measure = { outcome: "aktuell" | "veraltet" | "abweichend"; running?: string; detail?: string } | { outcome: "unbekannt"; detail: string };

async function measureRunning(s: WatchedService, status: ServiceStatus, installed: string, deps: ServiceDeps, budget: Budget = fullBudget): Promise<Measure> {
  if (s.running.kind === "metric") {
    let text: string;
    try {
      text = await deps.fetchText(s.running.url, budget(METRIC_TIMEOUT_MS));
    } catch (error) {
      return { outcome: "unbekannt", detail: `Metrik nicht erreichbar (${message(error)})` };
    }
    const running = parseMetricVersion(text, s.running.metric, s.running.label);
    if (!running) return { outcome: "unbekannt", detail: `Metrik ohne ${s.running.metric}{${s.running.label}=…}` };
    if (isNewer(installed, running)) return { outcome: "veraltet", running };
    if (isNewer(running, installed)) return { outcome: "abweichend", running };
    return { outcome: "aktuell", running };
  }

  // Zeitstempel-Ersatz: Prozess des Diensts gegen die Binärdatei
  if (status.pid === null) return { outcome: "unbekannt", detail: "keine PID vom Dienstmanager" };
  const proc = await deps.processInfo(status.pid, budget(PROCESS_TIMEOUT_MS)).catch(() => null);
  if (!proc) return { outcome: "unbekannt", detail: `Prozess ${status.pid} nicht lesbar` };
  const binary = await deps.fileTimes(s.running.path, budget(FILE_TIMEOUT_MS)).catch(() => null);
  if (!binary) return { outcome: "unbekannt", detail: `${s.running.path} fehlt` };
  const exe = proc.exe.replace(/ \(deleted\)$/, "");
  const exeReal = (await deps.fileTimes(exe, budget(FILE_TIMEOUT_MS)).catch(() => null))?.realPath ?? exe;
  if (exeReal === binary.realPath) {
    if (binary.changedMs > proc.startedMs + CLOCK_SLACK_MS) {
      return { outcome: "veraltet", detail: `Datei nach dem Start geändert (Start ${iso(proc.startedMs)}, geändert ${iso(binary.changedMs)})` };
    }
    return { outcome: "aktuell", detail: "Prozess jünger als die Datei" };
  }
  if (basename(exeReal) === basename(binary.realPath)) return { outcome: "veraltet", detail: `läuft aus ${exeReal}, installiert ist ${binary.realPath}` };
  return { outcome: "unbekannt", detail: `Prozess ${status.pid} (${exeReal}) gehört nicht zu ${s.running.path}` };
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

// ---------------------------------------------------------------------------
// Ablauf

/**
 * Nach dem Neustart: bis waitMs frisch messen, bis der Dienst mit neuer PID
 * und neuer Version läuft. Schlafen und jede Messung bekommen höchstens die
 * restliche Wartezeit; ein Ergebnis nach der Frist zählt nicht (auch wenn
 * eine Messung ihr Zeitlimit nicht einhält).
 */
async function verifyRestart(s: WatchedService, oldPid: number | null, installed: string, deps: ServiceDeps): Promise<ServiceResult> {
  const base = { name: s.name, manager: s.manager, target: s.target, installed };
  const deadline = deps.now() + s.waitMs;
  const left = () => deadline - deps.now();
  // mindestens 1 ms: ein Zeitlimit von 0 hieße bei Bun.spawn „ohne Grenze“
  const budget: Budget = limit => Math.max(1, Math.min(limit, left()));
  const late = () => deps.now() > deadline;
  const lateDetail = (what: string) => `${what} kam erst nach Ablauf der Wartezeit`;
  let last = "läuft nach dem Neustart nicht";
  let lastRunning: string | undefined;
  while (left() > 0) {
    await deps.sleep(Math.min(POLL_MS, left()));
    if (left() <= 0) break;
    let status: ServiceStatus;
    try {
      status = await serviceStatus(s, deps, budget);
    } catch (error) {
      last = late() ? lateDetail("Zustand") : `Zustand nicht lesbar: ${message(error)}`;
      continue;
    }
    if (late()) {
      last = lateDetail("Zustand");
      break;
    }
    if (status.state !== "running") {
      last = "läuft nach dem Neustart nicht";
      continue;
    }
    if (oldPid !== null && status.pid === oldPid) {
      last = `kein Prozesswechsel (PID ${oldPid})`;
      continue;
    }
    const m = await measureRunning(s, status, installed, deps, budget);
    if (late()) {
      last = lateDetail("Messung");
      break;
    }
    if (m.outcome === "aktuell") {
      // Zeitstempel-Ersatz: keine laufende Versionsnummer, nur die bestandene Prozess- und Dateiprüfung
      return m.running ? { ...base, outcome: "neu-gestartet", running: m.running } : { ...base, outcome: "neu-gestartet", detail: `danach: ${m.detail ?? "Prozess und Datei passen"} (keine Versionsnummer gemessen)` };
    }
    lastRunning = m.outcome === "unbekannt" ? undefined : m.running;
    last = m.outcome === "unbekannt" ? `Version danach unbekannt: ${m.detail}` : `meldet danach ${m.running ?? "weiter die alte Version"}${m.detail ? `, ${m.detail}` : ""}`;
  }
  return { ...base, outcome: "fehler", running: lastRunning, detail: `neu gestartet, aber ${last} (nach ${Math.round(s.waitMs / 1000)} s)` };
}

/** Prüft einen Dienst und startet ihn im Modus neustart bei Bedarf neu; wirft nie */
export async function checkService(s: WatchedService, deps: ServiceDeps, mode: ServiceMode): Promise<ServiceResult> {
  const base = { name: s.name, manager: s.manager, target: s.target };
  let installed: string;
  try {
    installed = await installedVersion(s, deps);
  } catch (error) {
    return { ...base, outcome: "unbekannt", detail: `installierte Version unbekannt: ${message(error)}` };
  }
  let status: ServiceStatus;
  try {
    status = await serviceStatus(s, deps);
  } catch (error) {
    return { ...base, installed, outcome: "unbekannt", detail: `Zustand nicht lesbar: ${message(error)}` };
  }
  if (status.state !== "running") return { ...base, installed, outcome: "gestoppt", detail: status.state === "missing" ? "nicht geladen" : "läuft nicht" };

  const m = await measureRunning(s, status, installed, deps);
  if (m.outcome === "unbekannt") return { ...base, installed, outcome: "unbekannt", detail: m.detail };
  if (m.outcome !== "veraltet" || mode === "pruefen") return { ...base, installed, outcome: m.outcome, running: m.running, detail: m.detail };

  if (isBotTarget(s.manager, s.target, deps.env)) {
    try {
      await deps.requestBotRestart(`${s.name}: neue Version ${installed}`);
    } catch (error) {
      return { ...base, installed, running: m.running, outcome: "fehler", detail: `Neustart des Bots nicht angefordert: ${message(error)}` };
    }
    return { ...base, installed, running: m.running, outcome: "neustart-angefordert", detail: "Bot startet neu, sobald keine Antwort mehr läuft" };
  }

  const r = await deps.run(restartCommand(s, deps.uid), RESTART_TIMEOUT_MS).catch(error => ({ code: -1, stdout: "", stderr: message(error) }));
  if (r.code !== 0) return { ...base, installed, running: m.running, outcome: "fehler", detail: `Neustart gescheitert: ${lastLine(r) || `Exit ${r.code}`}` };
  const verified = await verifyRestart(s, status.pid, installed, deps);
  if (verified.outcome !== "neu-gestartet") return { ...verified, running: verified.running ?? m.running };
  return m.running ? { ...verified, previous: m.running } : { ...verified, detail: [`vorher: ${m.detail}`, verified.detail].filter(Boolean).join(", ") };
}

// ---------------------------------------------------------------------------
// Geheimnisse aus Fehlertexten

const MASK = "[verborgen]";
/** Schlüssel, deren Wert als Zugangsdaten gilt (in Argumenten und Ausgaben) */
const CREDENTIAL_KEY = "(?:token|secret|passw(?:or)?d|pwd|api[-_]?key|access[-_]?key|private[-_]?key|auth\\w*|credentials?|cookie|session)";
/** Längste Fehlerangabe in Meldung und Zustand */
const DETAIL_MAX = 300;

/**
 * Bekannte Geheimnisse: Werte geheim benannter Variablen (isSecretName) aus
 * env und Zugangsdaten aus den Argumenten der Versionsbefehle
 * (--token=…, --password …), längste zuerst
 */
export function serviceSecrets(services: readonly WatchedService[], env: Record<string, string | undefined>): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) if (value && isSecretName(name)) values.add(value.trim());
  const key = new RegExp(`^-*[\\w.-]*${CREDENTIAL_KEY}[\\w.-]*$`, "i");
  for (const s of services) {
    const args = s.versionCommand;
    args.forEach((arg, i) => {
      const at = arg.indexOf("=");
      if (at > 0 && key.test(arg.slice(0, at))) values.add(arg.slice(at + 1));
      else if (arg.startsWith("-") && key.test(arg) && i + 1 < args.length) values.add(args[i + 1]);
    });
  }
  return [...values].filter(v => v.length >= 4).sort((a, b) => b.length - a.length);
}

/** Text ohne die Geheimnisse (auch URL-kodiert) und ohne Zugangsdaten nach üblichem Muster */
export function maskServiceText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const v of secrets) {
    out = out.split(v).join(MASK);
    const encoded = encodeURIComponent(v);
    if (encoded !== v) out = out.split(encoded).join(MASK);
  }
  return out
    .replace(/(\/\/[^/\s:@]+:)[^@\s/]+@/g, `$1${MASK}@`)
    .replace(/\b(bearer|basic)\s+(?!\[verborgen\])\S+/gi, `$1 ${MASK}`)
    .replace(new RegExp(`(${CREDENTIAL_KEY}["']?\\s*[=:]\\s*["']?)(?!\\[verborgen\\])[^\\s"',;&]+`, "gi"), `$1${MASK}`);
}

function maskDetail(detail: string, secrets: readonly string[]): string {
  const out = maskServiceText(detail, secrets);
  return out.length > DETAIL_MAX ? `${out.slice(0, DETAIL_MAX)}…` : out;
}

function maskResult(r: ServiceResult, secrets: readonly string[]): ServiceResult {
  return r.detail === undefined ? r : { ...r, detail: maskDetail(r.detail, secrets) };
}

function overall(services: ServiceResult[]): ServiceCheckRun["status"] {
  if (services.some(s => s.outcome === "fehler")) return "fehler";
  if (services.some(s => ["veraltet", "gestoppt", "unbekannt", "abweichend"].includes(s.outcome))) return "warn";
  return "ok";
}

/**
 * Alle Dienste nacheinander. Im Modus neustart unter der Sperre
 * data/dienste.lock; ist sie belegt, wird nichts geprüft und nichts
 * gestartet.
 */
export async function checkServices(services: readonly WatchedService[], deps: ServiceDeps, mode: ServiceMode): Promise<ServiceCheckRun> {
  const startedAt = new Date(deps.now()).toISOString();
  const secrets = serviceSecrets(services, deps.env);
  // Vor Speicherung, Ausgabe und Meldung: Fehlertexte ohne Geheimnisse
  const done = (results: ServiceResult[], error?: string): ServiceCheckRun => ({
    mode,
    startedAt,
    finishedAt: new Date(deps.now()).toISOString(),
    status: error ? "fehler" : overall(results),
    services: results.map(r => maskResult(r, secrets)),
    ...(error ? { error: maskDetail(error, secrets) } : {}),
  });
  if (services.length === 0) return done([]);
  if (mode === "pruefen") {
    const results: ServiceResult[] = [];
    for (const s of services) results.push(await checkService(s, deps, mode));
    return done(results);
  }
  let owner;
  try {
    await mkdir(dirname(deps.lockPath), { recursive: true });
    owner = await tryAcquireFileLock(deps.lockPath, deps.lock);
  } catch (error) {
    return done([], `Sperre ${SERVICES_LOCK_FILE} nicht nutzbar: ${message(error)}`);
  }
  if (!owner) return done([], `Dienstprüfung läuft schon (${SERVICES_LOCK_FILE}), nichts neu gestartet`);
  try {
    const results: ServiceResult[] = [];
    for (const s of services) results.push(await checkService(s, deps, mode));
    return done(results);
  } finally {
    await releaseFileLock(deps.lockPath, owner).catch(() => false);
  }
}

/**
 * Liest "dienste" aus config/wartung.json unter root und prüft sie. null,
 * wenn keine Dienste eingetragen sind; ungültige Konfiguration als Lauf mit
 * Fehler, ohne einen Dienst anzufassen.
 */
export async function checkConfiguredServices(root: string, deps: ServiceDeps, mode: ServiceMode): Promise<ServiceCheckRun | null> {
  let services: WatchedService[];
  try {
    services = (await loadMaintenanceConfig(root)).services;
  } catch (error) {
    if (!(error instanceof MaintenanceConfigError)) throw error;
    const at = new Date(deps.now()).toISOString();
    return { mode, startedAt: at, finishedAt: at, status: "fehler", services: [], error: `config/wartung.json ungültig: ${error.message}` };
  }
  if (services.length === 0) return null;
  return checkServices(services, deps, mode);
}

// ---------------------------------------------------------------------------
// Text

function versions(r: ServiceResult): string {
  if (r.previous && r.installed) return `${r.previous} → ${r.installed}`;
  if (r.running && r.installed && r.running !== r.installed) return `${r.running} → ${r.installed}`;
  return r.installed ?? r.running ?? "";
}

/** Eine Zeile je Dienst, ohne Spiegelstrich */
export function serviceLine(r: ServiceResult, mode: ServiceMode): string {
  const v = versions(r);
  const parts: string[] = [];
  switch (r.outcome) {
    case "aktuell":
      parts.push(`aktuell${v ? ` (${v})` : ""}`);
      break;
    case "veraltet":
      parts.push(`läuft ${r.running ?? "mit alter Version"}, installiert ${r.installed}`, mode === "pruefen" ? "würde neu gestartet" : "nicht neu gestartet");
      break;
    case "neu-gestartet":
      parts.push(`neu gestartet, ${r.running ? v : `installiert ${r.installed}`}`);
      break;
    case "neustart-angefordert":
      parts.push(`Neustart angefordert, ${v}`);
      break;
    case "gestoppt":
      parts.push(`${r.detail ?? "läuft nicht"}, nicht angefasst`);
      return `${r.name}: ${parts.join(", ")}`;
    case "unbekannt":
      parts.push("Version unbekannt, nicht angefasst");
      break;
    case "abweichend":
      parts.push(`läuft ${r.running}, neuer als installiert (${r.installed}), nicht angefasst`);
      break;
    case "fehler":
      parts.push(`FEHLER${v ? ` (${v})` : ""}`);
      break;
  }
  if (r.detail && r.outcome !== "aktuell") parts.push(r.detail);
  return `${r.name}: ${parts.join(", ")}`;
}

/** Abschnitt für Meldungen: Überschrift und eine Zeile je Dienst */
export function serviceReportLines(run: ServiceCheckRun | null | undefined): string[] {
  if (!run) return [];
  if (run.error) return [`Dienst-Versionen: ${run.error}`];
  if (run.services.length === 0) return [];
  return ["Dienst-Versionen:", ...run.services.map(r => `- ${serviceLine(r, run.mode)}`)];
}

/** Dienste mit Handlungsbedarf (für Überschriften): alles außer aktuell, neu gestartet, angefordert */
export function serviceProblems(run: ServiceCheckRun | null | undefined): ServiceResult[] {
  return (run?.services ?? []).filter(r => !["aktuell", "neu-gestartet", "neustart-angefordert"].includes(r.outcome));
}
