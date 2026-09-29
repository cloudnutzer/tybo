/**
 * Ablauf „Supabase auf diesem Rechner“ (Issue #164): Supabase läuft in
 * Docker aus dem Ordner supabase/ des Projekts (--workdir <projektordner>);
 * die Daten liegen in Docker-Volumes supabase_<dienst>_tybo, nicht im
 * Ordner. Die Supabase-CLI kommt über bunx in einer festen, getesteten
 * Version (beim ersten Mal lädt Bun sie in seinen Zwischenspeicher); Docker
 * ist Voraussetzung, die der Assistent erklärt, aber nie selbst installiert.
 *
 *   1. Prüfen: Docker-Befehl, laufendes Docker, Supabase-CLI, Arbeitsspeicher
 *   2. Docker-Netz supabase_network_tybo mit Bindung an 127.0.0.1 sicherstellen
 *      (LOCAL_NETWORK), dann supabase start mit den ausgelassenen Diensten
 *      (EXCLUDED_SERVICES). Danach und auch nach einem gescheiterten oder
 *      abgebrochenen Start: Portbindungen der Container prüfen und die Ports
 *      über die Adressen im Heimnetz probieren; ist etwas offen oder nicht
 *      prüfbar, wird gestoppt (Schutz-Stopp, Erfolg wird nachgeprüft)
 *   3. supabase status -o json: Adressen und Schlüssel
 *   4. Bilder-Ordner vorab prüfen (ein öffentlicher führt zum Abbruch, bevor
 *      das Schema ihn umstellt), dann SCHEMA_FILES per SqlRunner, dann
 *      PostgREST das Schema neu laden lassen
 *   5. Bilder-Ordner privat anlegen (bucketSql wie in der Cloud)
 *   6. .env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
 *      nur was abweicht
 *   7. Verbindungstest (mit kurzem Warten, bis die REST-API das Schema kennt)
 *
 * Wiederholbar: Läuft schon alles, ist start schnell und ändert nichts, das
 * Schema ist wiederholbar, die .env bleibt, wenn nichts abweicht.
 *
 * Schlüssel und DB_URL erscheinen nie in Meldungen, Fortschritt oder Log:
 * alle Sätze stehen fest in diesem Code, Ausgaben der CLI und Fehler von
 * Postgres werden nur eingeordnet, nie weitergereicht. Jeder Befehl geht als
 * Liste an ctx.run, nie als Shell-Zeile. Nie --no-backup (löscht die Daten),
 * nie --all (träfe fremde Supabase-Projekte).
 *
 * Dauerbetrieb (Issue #165): tybo datenbank start|stop|status|sichern, mit
 * derselben Dienstauswahl, demselben Netz und derselben Schutzprüfung; der
 * Dienst ai.tybo.supabase bzw. tybo-supabase ruft tybo datenbank start auf.
 * Abschnitt „Dauerbetrieb“ am Ende dieser Datei.
 */

import { readFileSync } from "node:fs";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { networkInterfaces, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { BRAND } from "../brand";
import { assetsBucket } from "../lib/asset-store";
import { isSecretName } from "../lib/subprocess-env";
import { readSetupEnv, type CommandResult, type SetupContext } from "./context";
import type { ApplyResult, RunReport, SetupValues } from "./model";
import { trackSafetyWork, writeEnv } from "./steps/common";
import { isSupabaseCloudUrl } from "./supabase-management";
import { bucketSql, isValidBucketName, RELOAD_SCHEMA_SQL, SCHEMA_FILES } from "./supabase-schema";

// ---------------------------------------------------------------------------
// Feste Werte
// ---------------------------------------------------------------------------

/**
 * Getestete Version der Supabase-CLI, per bunx geladen. Fest statt „latest“,
 * damit jeder Rechner dieselbe CLI nutzt; Updates kommen mit tybo.
 */
export const SUPABASE_CLI_VERSION = "2.118.0";

/**
 * Älteste CLI, mit der der Ablauf funktioniert: 2.45.0 ist die erste Version,
 * deren `status -o json` SECRET_KEY und PUBLISHABLE_KEY liefert
 * (internal/status/status.go); `mailpit` kennt --exclude schon früher (das
 * Image heißt seit 2.44 axllent/mailpit). Greift, falls bunx eine andere CLI
 * findet, etwa über SUPABASE_CLI_BINARY_OVERRIDE.
 */
export const MIN_SUPABASE_CLI = "2.45.0";

/** Dienste, die tybo nicht braucht (weniger Arbeitsspeicher, schnellerer Start) */
export const EXCLUDED_SERVICES = ["studio", "imgproxy", "logflare", "vector", "realtime", "supavisor", "mailpit", "postgres-meta"] as const;
export const AUSGELASSEN = EXCLUDED_SERVICES.join(",");

/** Ports aus supabase/config.toml (ein Test hält sie fest) */
export const LOCAL_API_PORT = 54421;
export const LOCAL_DB_PORT = 54422;
export const LOCAL_STUDIO_PORT = 54423;
export const LOCAL_SUPABASE_URL = `http://127.0.0.1:${LOCAL_API_PORT}`;
export const LOCAL_STUDIO_URL = `http://127.0.0.1:${LOCAL_STUDIO_PORT}`;
/** Ports, die nie aus dem Heimnetz erreichbar sein dürfen (Studio mit, Issue #165) */
export const GUARDED_PORTS = [LOCAL_API_PORT, LOCAL_DB_PORT, LOCAL_STUDIO_PORT];

/**
 * Docker-Netz, in dem die CLI die Container startet: ohne --network-id heißt
 * es supabase_network_<project_id>. Die CLI setzt bei Portbindungen keine
 * Adresse, es gilt also die Vorgabe des Netzes. Die Docker-Einstellung "ip"
 * (daemon.json) gilt nur für das Standard-Netz bridge, nicht für dieses; für
 * eigene Netze zählt die Netz-Option LOOPBACK_OPTION. Der Assistent legt das
 * Netz darum vor dem Start selbst mit dieser Option an. Ohne Label der CLI
 * übersteht es supabase stop (die CLI räumt nur Netze mit ihrem Label weg),
 * und ein späteres supabase start nimmt das vorhandene Netz.
 */
export const LOCAL_NETWORK = "supabase_network_tybo";
export const LOOPBACK_OPTION = "com.docker.network.bridge.host_binding_ipv4";
/** Label, mit dem die CLI ihre Container markiert (project_id aus config.toml) */
export const PROJECT_LABEL = "com.supabase.cli.project=tybo";

export const START_TIMEOUT_MS = 20 * 60 * 1000;
/** Erster Aufruf lädt die CLI (rund 130 MB) */
export const CLI_TIMEOUT_MS = 5 * 60 * 1000;
export const STATUS_TIMEOUT_MS = 2 * 60 * 1000;
export const DOCKER_TIMEOUT_MS = 30_000;
/**
 * Frist, die PM2 tybo-supabase beim Beenden (pm2 stop, pm2 delete) lässt,
 * bevor es SIGKILL schickt (--kill-timeout, Issue #165; ohne die Option
 * 1,6 Sekunden). So lange kann ein abgebrochenes `tybo datenbank start` im
 * ungünstigsten Fall brauchen: Bereinigung des abgebrochenen CLI-Aufrufs,
 * ein laufendes Anhalten für den Neustart (STATUS_TIMEOUT_MS), docker ps,
 * Heimnetz-Prüfung, Schutz-Stopp (STATUS_TIMEOUT_MS) und Nachprüfung, jeweils
 * mit Schonfrist; zusammen rund sechs Minuten, dazu Reserve.
 */
export const PM2_KILL_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Dieselbe Frist für launchd (ExitTimeOut in ai.tybo.supabase, in Sekunden;
 * ohne den Schlüssel 20 Sekunden): so lange wartet launchd nach SIGTERM beim
 * Entladen, bevor es SIGKILL schickt
 */
export const LAUNCHD_EXIT_TIMEOUT_S = PM2_KILL_TIMEOUT_MS / 1000;
/** Empfehlung der Supabase-Doku sind 7 GB für alle Dienste */
export const MIN_RAM_BYTES = 8 * 1024 ** 3;
/** Fortschritt beim langen Start */
export const TICK_MS = 10_000;
/** Warten, bis die REST-API das neue Schema kennt */
export const REST_READY_ATTEMPTS = 10;
export const REST_READY_INTERVAL_MS = 1_500;

const TOTAL = 7;

// ---------------------------------------------------------------------------
// Ports für Tests: Postgres, Heimnetz-Prüfung, Arbeitsspeicher
// ---------------------------------------------------------------------------

/** Eine Verbindung zur lokalen Datenbank; Fehler tragen nie Werte nach außen */
export interface SqlSession {
  /** Führt eine Datei aus (mehrere Anweisungen, ohne Parameter) */
  file(path: string): Promise<void>;
  query(text: string): Promise<Array<Record<string, unknown>>>;
  /** Schließt die Verbindung; wirft nie */
  close(): Promise<void>;
}

/** Öffnet eine Sitzung; signal beendet sie sofort (auch mitten in einer Anweisung) */
export type SqlRunner = (dbUrl: string, signal: AbortSignal) => SqlSession;

export interface LocalSupabaseDeps {
  sql: SqlRunner;
  /** Welche der Ports über eine Adresse im Heimnetz dieses Rechners antworten */
  lanReachable(ports: number[]): Promise<number[]>;
  totalMem(): number;
}

/** Postgres über Bun.SQL (sql.file() führt ohne Parameter mehrere Anweisungen aus) */
export const bunSqlRunner: SqlRunner = (dbUrl, signal) => {
  const sql = new Bun.SQL(dbUrl, { max: 1, connectionTimeout: 30 });
  let closed: Promise<void> | null = null;
  const close = (timeout: number) => (closed ??= sql.close({ timeout }).catch(() => {}));
  const onAbort = () => void close(0);
  signal.addEventListener("abort", onAbort, { once: true });
  return {
    async file(path) {
      await sql.file(path);
    },
    async query(text) {
      return [...(await sql.unsafe(text))] as Array<Record<string, unknown>>;
    },
    async close() {
      signal.removeEventListener("abort", onAbort);
      await close(5);
    },
  };
};

function canConnect(host: string, port: number, timeoutMs = 1_500): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Verbindet sich mit den eigenen Adressen im Netz (nicht 127.0.0.1). Antwortet
 * ein Port dort, lauscht er auf allen Schnittstellen und ist aus dem
 * Heimnetz erreichbar (Docker veröffentlicht Ports sonst auf 0.0.0.0).
 */
export async function defaultLanReachable(ports: number[]): Promise<number[]> {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter(a => a && !a.internal && (a.family === "IPv4" || (a.family === "IPv6" && !a.address.startsWith("fe80"))))
    .map(a => a!.address);
  const out: number[] = [];
  for (const port of ports) {
    for (const address of addresses) {
      if (await canConnect(address, port)) {
        out.push(port);
        break;
      }
    }
  }
  return out;
}

export function localDeps(ctx: SetupContext): LocalSupabaseDeps {
  return { sql: bunSqlRunner, lanReachable: defaultLanReachable, totalMem: totalmem, ...ctx.localSupabase };
}

// ---------------------------------------------------------------------------
// Befehle
// ---------------------------------------------------------------------------

/** bun x --bun supabase@<Version> …: läuft auch ohne Node (die CLI ist ein JS-Starter) */
export function supabaseCli(args: string[]): string[] {
  return [process.execPath, "x", "--bun", `supabase@${SUPABASE_CLI_VERSION}`, ...args];
}

/**
 * So steht der Befehl in Anleitungen (im Projektordner auszuführen). --bun vor
 * dem Paket: der Starter der CLI hat den Shebang node, ohne --bun bräuchte
 * bunx dafür Node.
 */
export function cliHint(args: string): string {
  return `bunx --bun supabase@${SUPABASE_CLI_VERSION} ${args}`;
}

/** Wiederanlauf mit derselben Dienstauswahl wie der Assistent */
export function startHint(root: string): string {
  return cliHint(`start --workdir ${root} -x ${AUSGELASSEN}`);
}

export function stopHint(root: string): string {
  return cliHint(`stop --workdir ${root}`);
}

/**
 * Umgebung der CLI: ohne Geheimnisse und ohne SUPABASE_* aus der Umgebung
 * von tybo (die CLI deutet SUPABASE_<abschnitt>_<feld> als Einstellung).
 */
export function cliEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || isSecretName(name) || name.startsWith("SUPABASE_")) continue;
    out[name] = value;
  }
  return out;
}

/** Vergleicht a.b.c; -1, 0, 1 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(n => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Prüfen
// ---------------------------------------------------------------------------

export function dockerMissing(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return [
      "Docker fehlt. Supabase auf diesem Rechner läuft in Docker; tybo installiert es nicht selbst. Drei Wege, einer genügt:",
      "OrbStack (https://orbstack.dev), braucht wenig Arbeitsspeicher;",
      "Docker Desktop (https://docs.docker.com/desktop/), für größere Firmen lizenzpflichtig;",
      "Colima: im Terminal brew install colima docker, dann colima start.",
      "Danach nochmal prüfen: die Einrichtung erneut starten.",
    ].join(" ");
  }
  return "Docker fehlt. Supabase auf diesem Rechner läuft in Docker; tybo installiert es nicht selbst. Docker Engine nach https://docs.docker.com/engine/install/ installieren, danach nochmal prüfen: die Einrichtung erneut starten.";
}

export const DOCKER_NOT_RUNNING =
  "Docker läuft nicht: Docker Desktop bzw. OrbStack öffnen oder colima start. Zeigt docker context ls auf einen anderen Docker, mit docker context use umstellen. Danach nochmal prüfen: die Einrichtung erneut starten.";
export const DOCKER_NO_PERMISSION =
  "Docker läuft, aber dieser Benutzer darf es nicht verwenden (keine Berechtigung). Unter Linux: sudo usermod -aG docker $USER, dann ab- und wieder anmelden. Danach nochmal prüfen: die Einrichtung erneut starten.";

export function cliUnavailable(): string {
  return `Die Supabase-CLI ließ sich nicht laden. tybo holt sie beim ersten Mal über Bun (${cliHint("--version")}, rund 130 MB aus dem npm-Verzeichnis, danach im Zwischenspeicher von Bun). Internetverbindung prüfen, dann nochmal prüfen: die Einrichtung erneut starten. Hilft das nicht: im Projektordner ${cliHint("--version")} ausführen und die Meldung ansehen.`;
}

export function cliTooOld(): string {
  return `Die gefundene Supabase-CLI ist älter als ${MIN_SUPABASE_CLI}. tybo nutzt ${SUPABASE_CLI_VERSION} über Bun. Ist SUPABASE_CLI_BINARY_OVERRIDE gesetzt, entfernen; sonst den Zwischenspeicher leeren (bun pm cache rm) und nochmal prüfen: die Einrichtung erneut starten.`;
}

export const LOW_RAM =
  "Hinweis: Dieser Rechner hat weniger als 8 GB Arbeitsspeicher. Supabase läuft trotzdem mit weniger Diensten, der Rechner kann aber langsam werden. Bei Docker Desktop und Colima zählt der Speicher, den die Docker-VM bekommt.";

export type CheckResult = { ok: true; warnings: string[] } | { ok: false; message: string; aborted?: boolean };

/** Prüft Docker, die CLI und den Arbeitsspeicher; installiert nichts */
export async function checkLocalPrerequisites(ctx: SetupContext, signal: AbortSignal, deps: LocalSupabaseDeps = localDeps(ctx)): Promise<CheckResult> {
  const docker = await ctx.run(["docker", "--version"], { timeoutMs: DOCKER_TIMEOUT_MS, signal });
  if (docker.aborted || signal.aborted) return { ok: false, message: "", aborted: true };
  if (docker.code !== 0) return { ok: false, message: dockerMissing(ctx.platform) };

  const info = await ctx.run(["docker", "info", "--format", "{{.ServerVersion}}"], { timeoutMs: DOCKER_TIMEOUT_MS, signal });
  if (info.aborted || signal.aborted) return { ok: false, message: "", aborted: true };
  if (info.code !== 0) {
    return { ok: false, message: /permission denied/i.test(`${info.stderr} ${info.stdout}`) ? DOCKER_NO_PERMISSION : DOCKER_NOT_RUNNING };
  }

  const cli = await ctx.run(supabaseCli(["--version"]), { timeoutMs: CLI_TIMEOUT_MS, signal, cwd: ctx.root, env: cliEnv() });
  if (cli.aborted || signal.aborted) return { ok: false, message: "", aborted: true };
  const version = cli.code === 0 ? /(\d+\.\d+\.\d+)/.exec(cli.stdout)?.[1] : undefined;
  if (!version) return { ok: false, message: cliUnavailable() };
  if (compareVersions(version, MIN_SUPABASE_CLI) < 0) return { ok: false, message: cliTooOld() };

  const warnings: string[] = [];
  if (deps.totalMem() < MIN_RAM_BYTES) warnings.push(LOW_RAM);
  return { ok: true, warnings };
}

// ---------------------------------------------------------------------------
// Start, Status
// ---------------------------------------------------------------------------

export type StartProblem = "port" | "speicher" | "zeitlimit" | "abgebrochen" | "sonst";

/** Ordnet einen gescheiterten Start ein; die Ausgabe selbst geht nie weiter */
export function startProblem(r: CommandResult): StartProblem {
  if (r.aborted) return "abgebrochen";
  if (r.timedOut) return "zeitlimit";
  const text = `${r.stderr}\n${r.stdout}`;
  if (/no space left on device|not enough space|disk quota/i.test(text)) return "speicher";
  if (/port is already allocated|address already in use|bind for .* failed|ports? .*(in use|already)/i.test(text)) return "port";
  return "sonst";
}

/** retryCmd: Befehl für den zweiten Versuch; ohne ihn die Einrichtung (tybo datenbank start nennt sich selbst) */
export function startProblemText(problem: StartProblem, root: string, retryCmd?: string): string {
  const retry = retryCmd ? `Danach erneut: ${retryCmd}.` : `Danach die Einrichtung erneut starten (${BRAND.cli} setup datenbank).`;
  switch (problem) {
    case "port":
      return `Supabase startet nicht, weil ein Port im Bereich 54420 bis 54429 belegt ist: ein anderes Programm oder ein altes Supabase auf 544xx. Mit docker ps nachsehen, was dort läuft, und es beenden. ${retry}`;
    case "speicher":
      return `Supabase startet nicht, weil der Speicherplatz für die Docker-Images fehlt (einige GB). Platz schaffen, etwa mit docker system prune (löscht nur ungenutzte Images und Container), bei Docker Desktop auch die Größe der virtuellen Festplatte erhöhen. ${retry}`;
    case "zeitlimit":
      return `Supabase ist nach 20 Minuten noch nicht gestartet. Beim ersten Mal lädt Docker mehrere GB; bei langsamer Leitung dauert das. Die schon geladenen Teile bleiben, ein zweiter Versuch macht dort weiter. ${retry}`;
    case "abgebrochen":
      return retryCmd ? `Abgebrochen. ${retry}` : `Abgebrochen. Die .env ist unverändert. ${retry}`;
    default:
      return `Supabase ließ sich nicht starten. Genauer zeigt es im Projektordner: ${startHint(root)} --debug. ${retry}`;
  }
}

// ---------------------------------------------------------------------------
// Nur auf diesem Rechner: Netz, Portbindungen, Schutz-Stopp
// ---------------------------------------------------------------------------

export type NetworkResult = { ok: true } | { ok: false; message: string; aborted?: boolean; open?: boolean };

/** Legt LOCAL_NETWORK mit Bindung an 127.0.0.1 an; ein vorhandenes muss sie schon haben */
export async function ensureLoopbackNetwork(ctx: SetupContext, signal: AbortSignal): Promise<NetworkResult> {
  const inspect = await ctx.run(["docker", "network", "inspect", LOCAL_NETWORK, "--format", "{{json .Options}}"], { timeoutMs: DOCKER_TIMEOUT_MS, signal });
  if (inspect.aborted || signal.aborted) return { ok: false, message: "", aborted: true };
  if (inspect.code === 0) {
    let options: Record<string, unknown> | null = null;
    try {
      options = JSON.parse(inspect.stdout.trim() || "null");
    } catch {}
    if (options?.[LOOPBACK_OPTION] === "127.0.0.1") return { ok: true };
    return { ok: false, message: openNetworkText(ctx.root), open: true };
  }
  if (!/not found|no such network/i.test(`${inspect.stderr}\n${inspect.stdout}`)) {
    return { ok: false, message: "Docker ließ sich nach dem Netz für Supabase nicht fragen. Läuft Docker noch? Danach die Einrichtung erneut starten. Es wurde nichts gestartet." };
  }
  const create = await ctx.run(["docker", "network", "create", "--driver", "bridge", "-o", `${LOOPBACK_OPTION}=127.0.0.1`, LOCAL_NETWORK], { timeoutMs: DOCKER_TIMEOUT_MS, signal });
  if (create.aborted || signal.aborted) return { ok: false, message: "", aborted: true };
  if (create.code !== 0) {
    return { ok: false, message: `Das Docker-Netz ${LOCAL_NETWORK} ließ sich nicht anlegen. Mit docker network ls nachsehen, ob Docker Netze anlegen kann, dann die Einrichtung erneut starten. Es wurde nichts gestartet.` };
  }
  return { ok: true };
}

function openNetworkText(root: string): string {
  return `Das Docker-Netz ${LOCAL_NETWORK} gibt es schon, aber ohne Bindung an 127.0.0.1 (Option ${LOOPBACK_OPTION}). Darin wären die Ports von Supabase aus dem Heimnetz erreichbar. Im Projektordner Supabase anhalten (${stopHint(root)}, die Daten bleiben), dann docker network rm ${LOCAL_NETWORK} (meldet das „not found“, hat supabase stop das Netz schon entfernt), dann die Einrichtung erneut starten; der Assistent legt das Netz richtig an. Der Assistent hat nichts gestartet.`;
}

/**
 * Portbindungen der Container des Projekts: keine (nichts läuft), sicher
 * (alle Ports nur an 127.0.0.1 bzw. ::1), offen oder unbekannt (docker ps
 * scheiterte). Die Prüfung braucht keine Adresse im Heimnetz.
 */
export type Bindings = "keine" | "sicher" | "offen" | "unbekannt";

/** Adresse vor dem Port in docker ps: 127.0.0.1:54421->8000/tcp, [::]:54421->…, :::54421->… */
export function bindingsOf(portsColumn: string): Bindings {
  const hosts: string[] = [];
  for (const entry of portsColumn.split(/,\s*|\n/)) {
    const m = /^\s*(.*):(\d+(?:-\d+)?)->/.exec(entry);
    if (m) hosts.push(m[1]);
  }
  if (!hosts.length) return "sicher";
  const loopback = (h: string) => {
    const x = h.replace(/^\[|\]$/g, "");
    return x === "::1" || /^127\.\d+\.\d+\.\d+$/.test(x);
  };
  return hosts.every(loopback) ? "sicher" : "offen";
}

export async function containerBindings(ctx: SetupContext): Promise<Bindings> {
  // Eine Zeile je laufendem Container: Name, Tab, Ports (auch leer)
  const ps = await ctx.run(["docker", "ps", "--filter", `label=${PROJECT_LABEL}`, "--format", "{{.Names}}\t{{.Ports}}"], { timeoutMs: DOCKER_TIMEOUT_MS });
  if (ps.code !== 0 || ps.timedOut) return "unbekannt";
  const lines = ps.stdout.split("\n").filter(l => l.trim());
  if (!lines.length) return "keine";
  return bindingsOf(lines.map(l => l.slice(l.indexOf("\t") + 1)).join("\n"));
}

export type Guard = { state: "keine" | "sicher" } | { state: "gestoppt" | "stopp-gescheitert" };

/**
 * Prüft laufende Container des Projekts (Bindungen, dann Heimnetz). Ist etwas
 * offen oder nicht prüfbar: supabase stop (ohne --no-backup, ohne Signal,
 * damit es auch nach einem Abbruch läuft), danach nachsehen, ob wirklich
 * nichts mehr läuft. Nur dann gilt der Stopp als gelungen.
 *
 * Angemeldet als Schutzschritt (trackSafetyWork): ein Abbruch im Terminal
 * oder im Browser-Einrichtungsmodus wartet darauf auch nach der Schonfrist
 * und zeigt bis dahin guardPendingText, danach den Ausgang (guardText).
 */
export function guardExposure(ctx: SetupContext, deps: LocalSupabaseDeps): Promise<Guard> {
  return trackSafetyWork(checkAndStop(ctx, deps), guardPendingText(ctx.root), guard => ({
    text: guardText(guard, ctx.root),
    alert: guard.state === "stopp-gescheitert",
  }));
}

/** Warnung, solange Portprüfung und Schutz-Stopp nicht fertig sind */
export function guardPendingText(root: string): string {
  return `Achtung: Noch nicht bestätigt, dass Supabase nur auf diesem Rechner erreichbar ist. Der Assistent prüft die Ports und hält Supabase nötigenfalls an; das kann einige Minuten dauern. Endet die Einrichtung vorher (etwa weil das Terminal geschlossen wird), Supabase sofort von Hand anhalten: im Projektordner ${stopHint(root)}; zeigt docker ps --filter label=${PROJECT_LABEL} danach noch Container, diese mit docker stop <name> anhalten.`;
}

/**
 * Prüfung und Schutz-Stopp ohne Anmeldung als Schutzschritt: für
 * tybo datenbank (Issue #165), das als eigener Prozess läuft und den Ausgang
 * selbst meldet (guardText). Der Einrichtungsablauf nutzt guardExposure.
 */
export function checkExposure(ctx: SetupContext, deps: LocalSupabaseDeps = localDeps(ctx)): Promise<Guard> {
  return checkAndStop(ctx, deps);
}

async function checkAndStop(ctx: SetupContext, deps: LocalSupabaseDeps): Promise<Guard> {
  const bindings = await containerBindings(ctx);
  if (bindings === "keine") return { state: "keine" };
  if (bindings === "sicher") {
    const reachable = await deps.lanReachable(GUARDED_PORTS).catch(() => GUARDED_PORTS);
    if (!reachable.length) return { state: "sicher" };
  }
  const stop = await ctx.run(supabaseCli(["stop", "--workdir", ctx.root]), { timeoutMs: STATUS_TIMEOUT_MS, cwd: ctx.root, env: cliEnv() });
  const after = await containerBindings(ctx);
  return { state: stop.code === 0 && !stop.timedOut && after === "keine" ? "gestoppt" : "stopp-gescheitert" };
}

/** Satz zum Schutz-Stopp; leer, wenn nichts lief */
export function guardText(guard: Guard, root: string): string {
  switch (guard.state) {
    case "keine":
      return "";
    case "sicher":
      return "Schon gestartete Supabase-Dienste laufen weiter, nur auf diesem Rechner erreichbar.";
    case "gestoppt":
      return "Schon gestartete Supabase-Dienste waren nicht sicher nur auf diesem Rechner erreichbar; der Assistent hat sie wieder gestoppt (die Daten bleiben).";
    case "stopp-gescheitert":
      return `Achtung: Supabase-Dienste laufen womöglich noch und sind vielleicht aus dem Heimnetz erreichbar, das Anhalten ist fehlgeschlagen. Sofort von Hand anhalten: im Projektordner ${stopHint(root)}; zeigt docker ps --filter label=${PROJECT_LABEL} danach noch Container, diese mit docker stop <name> anhalten.`;
  }
}

export interface LocalStatus {
  apiUrl: string;
  dbUrl: string;
  service: string;
  anon: string;
}

/**
 * Genau die Adresse, die der lokale Ablauf schreibt (Port aus
 * supabase/config.toml). Nur dann gelten tybo datenbank und der Dienst
 * ai.tybo.supabase (Issue #165); ein anderer Server auf 127.0.0.1 bleibt
 * unberührt.
 */
export function isLocalSupabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url.trim());
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === String(LOCAL_API_PORT);
  } catch {
    return false;
  }
}

/** Nur lokale Adressen: die Datenbank soll auf diesem Rechner laufen */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

/** Liest status -o json; null, wenn etwas fehlt oder nicht passt (ohne Werte zu nennen) */
export function parseStatus(stdout: string): LocalStatus | { problem: "json" | "felder" | "anon" | "fremd" } {
  let data: any;
  try {
    // Ausgabe kann Hinweise vor dem JSON enthalten: ab der ersten Klammer lesen
    const start = stdout.indexOf("{");
    data = JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
  } catch {
    return { problem: "json" };
  }
  if (!data || typeof data !== "object") return { problem: "json" };
  const str = (k: string) => (typeof data[k] === "string" && data[k].trim() ? (data[k].trim() as string) : null);
  const apiUrl = str("API_URL");
  const dbUrl = str("DB_URL");
  const service = str("SECRET_KEY") ?? str("SERVICE_ROLE_KEY");
  const anon = str("PUBLISHABLE_KEY") ?? str("ANON_KEY");
  if (!apiUrl || !dbUrl || !service) return { problem: "felder" };
  // Ohne öffentlichen Schlüssel bliebe ein alter (etwa aus der Cloud) neben den lokalen stehen
  if (!anon) return { problem: "anon" };
  try {
    const api = new URL(apiUrl);
    const db = new URL(dbUrl);
    if (!isLoopbackHost(api.hostname) || api.port !== String(LOCAL_API_PORT)) return { problem: "fremd" };
    if (!isLoopbackHost(db.hostname) || db.port !== String(LOCAL_DB_PORT)) return { problem: "fremd" };
  } catch {
    return { problem: "felder" };
  }
  return { apiUrl, dbUrl, service, anon };
}

// ---------------------------------------------------------------------------
// Plan und Ablauf
// ---------------------------------------------------------------------------

export function localPlan(values: SetupValues): string[] {
  const out = [
    `Prüfen: Docker installiert und gestartet, Supabase-CLI ${SUPABASE_CLI_VERSION} (lädt Bun beim ersten Mal selbst), Arbeitsspeicher. Installiert wird nichts.`,
    "Supabase in Docker starten, aus dem Ordner supabase/ des Projekts, ohne Dienste, die tybo nicht braucht. Beim ersten Mal lädt Docker einige GB, das dauert einige Minuten.",
    `Prüfen, dass Supabase nur auf diesem Rechner erreichbar ist, nicht aus dem Heimnetz: eigenes Docker-Netz ${LOCAL_NETWORK}, das alle Ports an 127.0.0.1 bindet, nach dem Start die Bindungen nachsehen und die Ports aus dem Heimnetz probieren.`,
    "Tabellen einspielen (db/schema.sql und db/migrations), wiederholbar.",
    "Privaten Bilder-Ordner anlegen (SUPABASE_ASSETS_BUCKET, sonst tybo-assets).",
    `SUPABASE_URL (${LOCAL_SUPABASE_URL}), SUPABASE_SERVICE_ROLE_KEY und SUPABASE_ANON_KEY in die .env schreiben.`,
  ];
  if (values.CONVEX_URL) out.push("CONVEX_URL aus der .env entfernen (Wechsel zu Supabase, Sicherung bleibt in data/backups).");
  out.push("Verbindung testen.", "Die Daten liegen in Docker-Volumes, nicht im Projektordner; ein git pull berührt sie nicht.");
  return out;
}

function fail(message: string, changed: string[] = []): ApplyResult {
  return { ok: false, message, changed };
}

export function exposedText(guard: Guard, root: string): string {
  const stopped = guard.state === "stopp-gescheitert" ? guardText(guard, root) : "Der Assistent hat Supabase darum wieder gestoppt (die Daten bleiben).";
  return `Supabase war nicht nur auf diesem Rechner erreichbar (Ports nicht an 127.0.0.1 gebunden oder aus dem Heimnetz erreichbar), und die lokalen Schlüssel sind allgemein bekannte Standardwerte. ${stopped} Die .env ist unverändert. Eigentlich bindet das Docker-Netz ${LOCAL_NETWORK}, das der Assistent anlegt, alle Ports an 127.0.0.1 (Netz-Option ${LOOPBACK_OPTION}; die Docker-Einstellung "ip" gilt nur für das Standard-Netz und hilft hier nicht). Nachsehen: docker network inspect ${LOCAL_NETWORK} muss bei Options 127.0.0.1 zeigen, docker ps --filter label=${PROJECT_LABEL} die Ports mit 127.0.0.1 davor. Fehlt die Option: Supabase anhalten (${stopHint(root)}), docker network rm ${LOCAL_NETWORK} („not found“ heißt: schon entfernt), dann die Einrichtung erneut starten (${BRAND.cli} setup datenbank). Hält sich die Docker-Umgebung nicht daran, Docker Desktop, OrbStack, Colima oder die Docker Engine nutzen.`;
}

const STATUS_TEXT: Record<"json" | "felder" | "anon" | "fremd" | "befehl", string> = {
  befehl: "Supabase ist gestartet, aber supabase status antwortet nicht. Die Einrichtung erneut starten; bleibt es so, Docker neu starten.",
  json: "Supabase ist gestartet, aber supabase status liefert keine lesbare Antwort. Die Einrichtung erneut starten; bleibt es so, die Supabase-CLI prüfen.",
  felder: "Supabase ist gestartet, liefert aber keine Adresse oder keinen Schlüssel. Die Einrichtung erneut starten; bleibt es so, Docker neu starten.",
  anon: "Supabase ist gestartet, liefert aber keinen öffentlichen Schlüssel (PUBLISHABLE_KEY oder ANON_KEY). Ohne ihn stünde in der .env ein alter Schlüssel neben den lokalen, darum bricht der Assistent vor den Tabellen ab. Die .env ist unverändert. Die Einrichtung erneut starten; bleibt es so, läuft der Auth-Dienst (gotrue) vermutlich nicht: Supabase anhalten und neu einrichten (die Daten bleiben).",
  fremd: `Supabase meldet eine Adresse, die nicht auf diesem Rechner liegt (DOCKER_HOST zeigt auf einen anderen Rechner?). tybo richtet Supabase nur hier ein, auf Port ${LOCAL_API_PORT}. Die .env ist unverändert.`,
};

/**
 * Der Ablauf. values: Auswahl und bei Wechsel von Convex die Bestätigung.
 * Keine weiteren Felder.
 */
export async function runSupabaseLocal(values: SetupValues, ctx: SetupContext, report: RunReport, signal: AbortSignal): Promise<ApplyResult> {
  const deps = localDeps(ctx);
  const root = ctx.root;
  const retry = `${BRAND.cli} setup datenbank`;
  const abortedBefore = () => fail("Abgebrochen. Es wurde nichts gestartet, die .env ist unverändert.");
  const abortedAfterStart = () => fail(`Abgebrochen. Supabase läuft (die Daten bleiben), die .env ist unverändert. Weiter mit: ${retry}, der Assistent macht dort weiter.`);

  // Alles ohne Nebenwirkung zuerst
  let env: Record<string, string>;
  try {
    env = await readSetupEnv(ctx);
  } catch {
    return fail("Die .env ließ sich nicht lesen. Es wurde nichts gestartet.");
  }
  const bucket = assetsBucket(env);
  if (!isValidBucketName(bucket)) {
    return fail("SUPABASE_ASSETS_BUCKET in der .env ist kein gültiger Name für den Bilder-Ordner (3 bis 63 Zeichen: Kleinbuchstaben, Ziffern, Punkt, Bindestrich, Unterstrich). Es wurde nichts gestartet.");
  }
  if (env.CONVEX_URL?.trim() && values.DB_SWITCH_CONFIRM !== "true") return fail("Wechsel von Convex zu Supabase ist nicht bestätigt. Es wurde nichts gestartet.");
  if (signal.aborted) return abortedBefore();

  // 1. Prüfen
  report({ at: 1, total: TOTAL, label: "Prüfe Docker und die Supabase-CLI" });
  const check = await checkLocalPrerequisites(ctx, signal, deps);
  if (!check.ok) return check.aborted ? abortedBefore() : fail(check.message);
  for (const warning of check.warnings) report({ at: 1, total: TOTAL, label: "Prüfe Docker und die Supabase-CLI", detail: warning });
  if (signal.aborted) return abortedBefore();

  // 2. Netz mit Bindung an 127.0.0.1, dann starten
  const startLabel = "Lade und starte Supabase (beim ersten Mal einige Minuten)";
  report({ at: 2, total: TOTAL, label: startLabel, detail: `Docker-Netz ${LOCAL_NETWORK}, nur 127.0.0.1` });
  const network = await ensureLoopbackNetwork(ctx, signal);
  if (!network.ok && network.aborted) return abortedBefore();
  if (!network.ok && network.open) {
    // Laufen schon Container in diesem Netz (von Hand gestartet), sind sie offen
    const guard = await guardExposure(ctx, deps);
    return fail([network.message, guardText(guard, root)].filter(Boolean).join(" "));
  }
  if (!network.ok) return fail(network.message);
  if (signal.aborted) return abortedBefore();

  const startedAt = ctx.now().getTime();
  const tick = () => report({ at: 2, total: TOTAL, label: startLabel, waitedMs: ctx.now().getTime() - startedAt });
  tick();
  const ticker = setInterval(tick, TICK_MS);
  let start: CommandResult;
  try {
    start = await ctx.run(supabaseCli(["start", "--workdir", root, "-x", AUSGELASSEN]), { timeoutMs: START_TIMEOUT_MS, signal, cwd: root, env: cliEnv() });
  } finally {
    clearInterval(ticker);
  }
  if (start.code !== 0 || signal.aborted) {
    // Halb gestartete Container nicht ungeprüft zurücklassen
    report({ at: 2, total: TOTAL, label: startLabel, detail: "Prüfe, was schon läuft" });
    const guard = await guardExposure(ctx, deps);
    const text = startProblemText(signal.aborted || start.aborted ? "abgebrochen" : startProblem(start), root);
    return fail([text, guardText(guard, root)].filter(Boolean).join(" "));
  }

  // Nur auf diesem Rechner erreichbar? (Bindungen, dann Heimnetz)
  const guard = await guardExposure(ctx, deps);
  if (guard.state !== "sicher") return fail(exposedText(guard, root));
  if (signal.aborted) return abortedAfterStart();

  // 3. Status
  report({ at: 3, total: TOTAL, label: "Lese Adresse und Schlüssel" });
  const status = await ctx.run(supabaseCli(["status", "--workdir", root, "-o", "json"]), { timeoutMs: STATUS_TIMEOUT_MS, signal, cwd: root, env: cliEnv() });
  if (status.aborted || signal.aborted) return abortedAfterStart();
  if (status.code !== 0) return fail(STATUS_TEXT.befehl);
  const parsed = parseStatus(status.stdout);
  if ("problem" in parsed) return fail(STATUS_TEXT[parsed.problem]);

  // 4. und 5. Schema und Bilder-Ordner, eine Sitzung, zuverlässig geschlossen
  const session = deps.sql(parsed.dbUrl, signal);
  let stage: "bucket-check" | "schema" | "reload" | "bucket" = "bucket-check";
  try {
    report({ at: 4, total: TOTAL, label: "Spiele die Tabellen ein" });
    // Vorab: ein öffentlicher Ordner führt zum Abbruch, bevor das Schema ihn umstellt
    const before = await session.query(bucketStateSql(bucket));
    if (signal.aborted) return abortedAfterStart();
    if (before[0]?.public === true) return fail(publicBucketText());
    stage = "schema";
    for (const file of SCHEMA_FILES) {
      if (signal.aborted) return abortedAfterStart();
      report({ at: 4, total: TOTAL, label: "Spiele die Tabellen ein", detail: file });
      await session.file(join(root, file));
    }
    stage = "reload";
    await session.query(RELOAD_SCHEMA_SQL);
    if (signal.aborted) return abortedAfterStart();

    stage = "bucket";
    report({ at: 5, total: TOTAL, label: "Lege den Bilder-Ordner an" });
    const rows = await session.query(bucketSql(bucket));
    if (signal.aborted) return abortedAfterStart();
    const isPublic = rows[0]?.public;
    if (isPublic === true) return fail(publicBucketText());
    if (isPublic !== false) return fail("Der Bilder-Ordner ließ sich nicht prüfen. Die Einrichtung erneut starten. Die .env ist unverändert.");
  } catch {
    if (signal.aborted) return abortedAfterStart();
    // Fehlertext von Postgres geht nie weiter (könnte Teile der Verbindung nennen)
    const what =
      stage === "schema"
        ? "Die Tabellen ließen sich nicht einspielen."
        : stage === "bucket" || stage === "bucket-check"
          ? "Der Bilder-Ordner ließ sich nicht prüfen oder anlegen (läuft der Storage-Dienst?)."
          : "Die REST-API ließ sich nicht neu laden.";
    return fail(`${what} Die .env ist unverändert. Die Einrichtung erneut starten; bleibt der Fehler, Supabase mit ${cliHint("stop --workdir " + root)} anhalten und neu einrichten (die Daten bleiben).`);
  } finally {
    await session.close();
  }

  // 6. .env, nur was abweicht
  if (signal.aborted) return abortedAfterStart();
  report({ at: 6, total: TOTAL, label: "Schreibe die .env" });
  const wanted: Array<[string, string | null]> = [
    ["SUPABASE_URL", LOCAL_SUPABASE_URL],
    ["SUPABASE_SERVICE_ROLE_KEY", parsed.service],
    ["SUPABASE_ANON_KEY", parsed.anon],
  ];
  if (env.CONVEX_URL !== undefined) wanted.push(["CONVEX_URL", null]);
  const changes = wanted.filter(([k, v]) => (v === null ? k in env : env[k] !== v));
  let changed: string[] = [];
  if (changes.length) {
    // Nicht abbrechbar: das Schreiben läuft zu Ende
    const written = await writeEnv(ctx, changes);
    if (!written.ok) return fail(written.message);
    changed = written.changed;
  }

  // 7. Verbindungstest, mit kurzem Warten auf die REST-API
  report({ at: 7, total: TOTAL, label: "Teste die Verbindung" });
  let probe = await ctx.providers.supabaseQuery(LOCAL_SUPABASE_URL, parsed.service);
  for (let i = 1; !probe.ok && i < REST_READY_ATTEMPTS && !signal.aborted; i++) {
    await ctx.sleep(REST_READY_INTERVAL_MS, signal);
    if (signal.aborted) break;
    probe = await ctx.providers.supabaseQuery(LOCAL_SUPABASE_URL, parsed.service);
  }
  const done = changed.length ? "Supabase läuft auf diesem Rechner und ist eingerichtet." : "Supabase läuft auf diesem Rechner, alles war schon eingerichtet.";
  if (!probe.ok) return { ok: false, message: `${done} Der Verbindungstest ist aber fehlgeschlagen: ${probe.message}`, changed };
  // Einmal am Ende (Issue #165): startet Docker nach einem Neustart von selbst?
  const login = await dockerLoginHint(ctx);
  return { ok: true, message: `${done} ${probe.message} ${login}`, changed };
}

// ---------------------------------------------------------------------------
// Docker beim Anmelden (Issue #165)
// ---------------------------------------------------------------------------

export type DockerKind = "desktop" | "orbstack" | "colima" | "engine" | "unbekannt";

/** Welche Docker-Umgebung antwortet: Betriebssystem laut docker info, sonst der Kontext */
export async function dockerKind(ctx: SetupContext): Promise<DockerKind> {
  const info = await ctx.run(["docker", "info", "--format", "{{.OperatingSystem}}"], { timeoutMs: DOCKER_TIMEOUT_MS });
  const os = info.code === 0 ? info.stdout : "";
  if (/docker desktop/i.test(os)) return "desktop";
  if (/orbstack/i.test(os)) return "orbstack";
  const context = await ctx.run(["docker", "context", "show"], { timeoutMs: DOCKER_TIMEOUT_MS });
  const name = context.code === 0 ? context.stdout.trim() : "";
  if (name.startsWith("desktop")) return "desktop";
  if (name === "orbstack") return "orbstack";
  if (name.startsWith("colima")) return "colima";
  if (ctx.platform === "linux") return "engine";
  return "unbekannt";
}

/**
 * Einstellung „Start Docker Desktop when you sign in“ aus
 * ~/Library/Group Containers/group.com.docker/settings-store.json (neuere
 * Versionen, Schlüssel AutoStart) bzw. settings.json (ältere, autoStart);
 * null, wenn keine Datei den Schlüssel hat
 */
export function desktopAutoStart(home: string): boolean | null {
  const dir = join(home, "Library", "Group Containers", "group.com.docker");
  for (const [file, key] of [["settings-store.json", "AutoStart"], ["settings.json", "autoStart"]] as const) {
    try {
      const value = JSON.parse(readFileSync(join(dir, file), "utf8"))?.[key];
      if (typeof value === "boolean") return value;
    } catch {}
  }
  return null;
}

const AFTER_REBOOT = `Supabase selbst startet danach der Autostart (Schritt Autostart, Dienst ai.tybo.supabase bzw. tybo-supabase) oder von Hand ${BRAND.cli} datenbank start.`;

/** Ein Absatz: startet Docker nach dem Anmelden von selbst, und wenn nicht, wie man es einschaltet */
export async function dockerLoginHint(ctx: SetupContext): Promise<string> {
  const kind = await dockerKind(ctx);
  switch (kind) {
    case "desktop": {
      const on = ctx.platform === "darwin" ? desktopAutoStart(ctx.home) : null;
      if (on === true) return `Docker Desktop startet beim Anmelden von selbst (Einstellung ist an). ${AFTER_REBOOT}`;
      const how = "In Docker Desktop unter Settings, General „Start Docker Desktop when you sign in to your computer“ einschalten.";
      if (on === false) return `Achtung: Docker Desktop startet beim Anmelden nicht von selbst, nach einem Neustart hätte ${BRAND.name} dann kein Gedächtnis. ${how} ${AFTER_REBOOT}`;
      return `Ob Docker Desktop beim Anmelden startet, ließ sich nicht lesen. ${how} ${AFTER_REBOOT}`;
    }
    case "orbstack":
      return `Damit nach einem Neustart alles wieder läuft: in OrbStack unter Settings „Start at login“ einschalten (${BRAND.name} prüft das nicht). ${AFTER_REBOOT}`;
    case "colima":
      return `Colima startet nicht von selbst. Damit es beim Anmelden startet, einmal im Terminal: brew services start colima (${BRAND.name} prüft das nicht). ${AFTER_REBOOT}`;
    case "engine": {
      const enabled = await ctx.run(["systemctl", "is-enabled", "docker"], { timeoutMs: DOCKER_TIMEOUT_MS });
      if (enabled.code === 0 && enabled.stdout.trim() === "enabled") return `Docker startet mit dem Rechner (systemd). ${AFTER_REBOOT}`;
      return `Docker startet womöglich nicht mit dem Rechner. Einschalten mit: sudo systemctl enable docker. ${AFTER_REBOOT}`;
    }
    default:
      return `Damit ${BRAND.name} nach einem Neustart sein Gedächtnis hat, muss Docker beim Anmelden von selbst starten: Docker Desktop „Start Docker Desktop when you sign in“, OrbStack „Start at login“, Colima brew services start colima. ${AFTER_REBOOT}`;
  }
}

/** Zustand eines Bilder-Ordners, ohne ihn anzulegen (keine Zeile: gibt es nicht) */
export function bucketStateSql(name: string): string {
  if (!isValidBucketName(name)) throw new Error("Ungültiger Name für den Bilder-Ordner");
  return `select public from storage.buckets where id = '${name}';`;
}

function publicBucketText(): string {
  return "Der Bilder-Ordner aus SUPABASE_ASSETS_BUCKET ist in der lokalen Supabase öffentlich. tybo braucht einen privaten und stellt ihn nicht still um: einen anderen Namen in SUPABASE_ASSETS_BUCKET eintragen, dann die Einrichtung erneut starten. Die .env ist unverändert.";
}

// ---------------------------------------------------------------------------
// Dauerbetrieb: tybo datenbank start|stop|status|sichern (Issue #165)
// ---------------------------------------------------------------------------

/** Container der CLI heißen supabase_<dienst>_<project_id> */
export const DB_CONTAINER = "supabase_db_tybo";
export const STORAGE_CONTAINER = "supabase_storage_tybo";
export const EDGE_CONTAINER = "supabase_edge_runtime_tybo";
export const STUDIO_CONTAINER = "supabase_studio_tybo";
/** Pfad der Bilddateien im Storage-Container (FILE_STORAGE_BACKEND_PATH, Mount des Volumes) */
export const STORAGE_PATH = "/mnt";

/** So lange wartet start auf Docker (etwa direkt nach dem Anmelden) */
export const DOCKER_WAIT_MS = 5 * 60 * 1000;
export const DOCKER_POLL_MS = 5_000;
/** Ein Dump oder das Kopieren der Bilder */
export const BACKUP_STEP_TIMEOUT_MS = 30 * 60 * 1000;
/** Exit-Code nach Strg+C */
export const EXIT_ABORTED = 130;

/** Studio braucht postgres-meta für die Datenbankverwaltung; beide nur mit --studio */
const STUDIO_SERVICES = ["studio", "postgres-meta"];

/** Ausgelassene Dienste; mit Studio ohne studio und postgres-meta */
export function excludedFor(studio: boolean): string {
  return studio ? EXCLUDED_SERVICES.filter(s => !STUDIO_SERVICES.includes(s)).join(",") : AUSGELASSEN;
}

const DB_CLI = `${BRAND.cli} datenbank`;

export type DatabaseArgs =
  | { command: "help" }
  | { command: "start"; studio: boolean }
  | { command: "stop" }
  | { command: "status" }
  | { command: "sichern"; ziel?: string };

/** Liest die Argumente nach „datenbank“; null bei allem Unbekannten */
export function parseDatabaseArgs(args: string[]): DatabaseArgs | null {
  const [command, ...rest] = args;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") return rest.length ? null : { command: "help" };
  if (command === "start") {
    if (rest.length === 0) return { command, studio: false };
    return rest.length === 1 && rest[0] === "--studio" ? { command, studio: true } : null;
  }
  if (command === "stop" || command === "status") return rest.length ? null : { command };
  if (command === "sichern") {
    if (rest.length === 0) return { command };
    if (rest.length === 2 && rest[0] === "--ziel" && rest[1].trim()) return { command, ziel: rest[1] };
    if (rest.length === 1 && rest[0].startsWith("--ziel=") && rest[0].length > "--ziel=".length) return { command, ziel: rest[0].slice("--ziel=".length) };
  }
  return null;
}

export function databaseUsage(): string {
  return [
    `${DB_CLI}: Supabase auf diesem Rechner (nur wenn SUPABASE_URL auf ${LOCAL_SUPABASE_URL} zeigt)`,
    "",
    `  ${DB_CLI} start             starten; wartet bis zu 5 Minuten auf Docker`,
    `  ${DB_CLI} start --studio    mit Studio, um die Daten im Browser anzusehen (${LOCAL_STUDIO_URL})`,
    `  ${DB_CLI} stop              anhalten, die Daten bleiben`,
    `  ${DB_CLI} status            läuft es, Adresse, Platz der Docker-Volumes`,
    `  ${DB_CLI} sichern           Sicherung nach data/backups/supabase-<Datum>`,
    `  ${DB_CLI} sichern --ziel <Ordner>   Sicherung nach <Ordner>/supabase-<Datum>`,
  ].join("\n");
}

export interface DatabaseCommandOptions {
  ctx: SetupContext;
  /** Umgebung samt .env des Projekts (Werte aus der .env gehen vor) */
  env: Record<string, string | undefined>;
  out(line: string): void;
  err(line: string): void;
  /** Strg+C; bricht Warten, Start und Sicherung ab */
  signal?: AbortSignal;
  /** Bezug für ein relatives --ziel; Standard process.cwd() */
  cwd?: string;
  deps?: LocalSupabaseDeps;
}

/**
 * Warum tybo datenbank hier nichts tut; null, wenn SUPABASE_URL genau auf
 * das Supabase dieses Projekts zeigt
 */
export function notLocalText(url: string | undefined): string | null {
  if (isLocalSupabaseUrl(url)) return null;
  const setup = `${BRAND.cli} setup datenbank, Weg „Supabase auf diesem Rechner“`;
  if (!url?.trim()) return `Diese Installation nutzt kein Supabase auf diesem Rechner (SUPABASE_URL fehlt in der .env). ${DB_CLI} gilt nur dafür; einrichten mit ${setup}.`;
  let host = "";
  try {
    host = new URL(url.trim()).hostname;
  } catch {}
  if (isSupabaseCloudUrl(url) || !isLoopbackHost(host)) {
    return `Diese Installation nutzt Supabase in der Cloud (SUPABASE_URL zeigt nicht auf diesen Rechner). ${DB_CLI} gilt nur für Supabase auf diesem Rechner (${setup}).`;
  }
  return `SUPABASE_URL zeigt auf ein anderes Supabase auf diesem Rechner, nicht auf das von ${BRAND.name} eingerichtete (${LOCAL_SUPABASE_URL}). ${DB_CLI} fasst es nicht an.`;
}

/** Namen der laufenden Container des Projekts; null, wenn docker ps scheitert */
export async function runningContainers(ctx: SetupContext): Promise<Set<string> | null> {
  const ps = await ctx.run(["docker", "ps", "--filter", `label=${PROJECT_LABEL}`, "--format", "{{.Names}}\t{{.Ports}}"], { timeoutMs: DOCKER_TIMEOUT_MS });
  if (ps.code !== 0 || ps.timedOut) return null;
  return new Set(
    ps.stdout
      .split("\n")
      .map(l => l.split("\t")[0].trim())
      .filter(Boolean),
  );
}

/** Edge Runtime an laut supabase/config.toml (Standard der CLI: an) */
export function edgeRuntimeEnabled(root: string): boolean {
  try {
    const config = Bun.TOML.parse(readFileSync(join(root, "supabase", "config.toml"), "utf8")) as any;
    return config?.edge_runtime?.enabled !== false;
  } catch {
    return true;
  }
}

type DockerWait = { ok: true } | { ok: false; message: string; aborted?: boolean };

const DOCKER_NOT_THERE = `Docker fehlt (kein docker-Befehl im PATH). Supabase auf diesem Rechner läuft in Docker; ${BRAND.cli} installiert es nicht selbst. Siehe docs/einrichtung.md, „Supabase auf diesem Rechner“.`;
const DOCKER_TIMEOUT_TEXT = `Docker läuft nach 5 Minuten noch nicht, Supabase wurde nicht gestartet. Docker Desktop bzw. OrbStack öffnen oder colima start, dann: ${DB_CLI} start. Damit Docker beim Anmelden von selbst startet: docs/einrichtung.md, „Supabase lokal im Alltag“.`;
const DOCKER_PERMISSION_TEXT = "Docker läuft, aber dieser Benutzer darf es nicht verwenden (keine Berechtigung). Unter Linux: sudo usermod -aG docker $USER, dann ab- und wieder anmelden.";

/**
 * Wartet bis zu DOCKER_WAIT_MS auf Docker: docker info alle DOCKER_POLL_MS.
 * Gemessen an der Uhr, nicht an der Zahl der Versuche: auch ein hängendes
 * docker info zählt mit und wird am Ende der Frist abgebrochen.
 */
export async function waitForDocker(ctx: SetupContext, out: (line: string) => void, signal?: AbortSignal): Promise<DockerWait> {
  const version = await ctx.run(["docker", "--version"], { timeoutMs: DOCKER_TIMEOUT_MS, signal });
  if (version.aborted || signal?.aborted) return { ok: false, message: "", aborted: true };
  if (version.code !== 0) return { ok: false, message: DOCKER_NOT_THERE };
  const deadline = ctx.now().getTime() + DOCKER_WAIT_MS;
  let announced = false;
  for (;;) {
    const left = deadline - ctx.now().getTime();
    const info = await ctx.run(["docker", "info", "--format", "{{.ServerVersion}}"], { timeoutMs: Math.max(1_000, Math.min(DOCKER_TIMEOUT_MS, left)), signal });
    if (info.aborted || signal?.aborted) return { ok: false, message: "", aborted: true };
    if (info.code === 0) return { ok: true };
    if (/permission denied/i.test(`${info.stderr} ${info.stdout}`)) return { ok: false, message: DOCKER_PERMISSION_TEXT };
    const rest = deadline - ctx.now().getTime();
    if (rest <= 0) return { ok: false, message: DOCKER_TIMEOUT_TEXT };
    if (!announced) {
      out("Warte auf Docker (bis zu 5 Minuten) …");
      announced = true;
    }
    await ctx.sleep(Math.min(DOCKER_POLL_MS, rest), signal);
    if (signal?.aborted) return { ok: false, message: "", aborted: true };
  }
}

/** Läuft Docker jetzt? (ohne Warten, für stop, status, sichern) */
async function dockerRunning(ctx: SetupContext): Promise<boolean> {
  const info = await ctx.run(["docker", "info", "--format", "{{.ServerVersion}}"], { timeoutMs: DOCKER_TIMEOUT_MS });
  return info.code === 0;
}

function stopCommandText(root: string): string {
  return `Von Hand anhalten: im Projektordner ${stopHint(root)}; zeigt docker ps --filter label=${PROJECT_LABEL} danach noch Container, diese mit docker stop <name> anhalten.`;
}

async function databaseStart(o: DatabaseCommandOptions, studio: boolean): Promise<number> {
  const { ctx, out, err, signal } = o;
  const deps = o.deps ?? localDeps(ctx);
  const root = ctx.root;
  const retry = `${DB_CLI} start${studio ? " --studio" : ""}`;

  const docker = await waitForDocker(ctx, out, signal);
  if (!docker.ok) {
    err(docker.aborted ? "Abgebrochen, Supabase wurde nicht gestartet." : docker.message);
    return docker.aborted ? EXIT_ABORTED : 1;
  }

  // Läuft die Datenbank schon, kehrt supabase start sofort zurück und holt
  // keine fehlenden Dienste nach: Edge Runtime hat keine Neustart-Regel und
  // fehlt nach einem Neustart des Rechners, Studio lässt sich nicht zuschalten.
  // Dann einmal anhalten (die Daten bleiben) und neu starten.
  const running = await runningContainers(ctx);
  if (running?.has(DB_CONTAINER)) {
    const missing: string[] = [];
    if (edgeRuntimeEnabled(root) && !running.has(EDGE_CONTAINER)) missing.push("Edge Runtime");
    if (studio && !running.has(STUDIO_CONTAINER)) missing.push("Studio");
    if (missing.length) {
      out(`Supabase läuft ohne ${missing.join(" und ")}. ${BRAND.name} hält es kurz an und startet es neu, die Daten bleiben.`);
      const stop = await ctx.run(supabaseCli(["stop", "--workdir", root]), { timeoutMs: STATUS_TIMEOUT_MS, cwd: root, env: cliEnv() });
      if (stop.code !== 0 || stop.timedOut) {
        // Womöglich halb angehalten oder in einem offenen Netz: was noch läuft,
        // muss nur auf diesem Rechner erreichbar sein, sonst Schutz-Stopp
        const guard = await checkExposure(ctx, deps);
        const state =
          guard.state === "sicher"
            ? "Es läuft weiter, nur auf diesem Rechner erreichbar."
            : guard.state === "keine"
              ? "Es läuft jetzt gar nicht mehr."
              : guardText(guard, root);
        err(`Supabase ließ sich für den Neustart nicht anhalten. ${state} Docker neu starten, dann: ${retry}.`);
        return 1;
      }
    }
  }
  if (signal?.aborted) {
    err("Abgebrochen, Supabase wurde nicht gestartet.");
    return EXIT_ABORTED;
  }

  const network = await ensureLoopbackNetwork(ctx, signal ?? new AbortController().signal);
  if (!network.ok) {
    if (network.aborted) {
      err("Abgebrochen, Supabase wurde nicht gestartet.");
      return EXIT_ABORTED;
    }
    // Laufen schon Container in einem offenen Netz, sind sie erreichbar: anhalten
    const guard = network.open ? await checkExposure(ctx, deps) : null;
    err([network.message, guard ? guardText(guard, root) : ""].filter(Boolean).join(" "));
    return 1;
  }

  out(studio ? "Starte Supabase mit Studio (beim ersten Mal lädt Docker einige GB) …" : "Starte Supabase (beim ersten Mal lädt Docker einige GB) …");
  // Ausgabe der CLI geht nie weiter: start nennt Schlüssel und DB_URL
  const start = await ctx.run(supabaseCli(["start", "--workdir", root, "-x", excludedFor(studio)]), { timeoutMs: START_TIMEOUT_MS, signal, cwd: root, env: cliEnv() });
  if (start.code !== 0 || signal?.aborted) {
    const guard = await checkExposure(ctx, deps);
    const problem = signal?.aborted || start.aborted ? "abgebrochen" : startProblem(start);
    err([startProblemText(problem, root, retry), guardText(guard, root)].filter(Boolean).join(" "));
    return problem === "abgebrochen" ? EXIT_ABORTED : 1;
  }

  // Nur auf diesem Rechner erreichbar? (Bindungen, dann Heimnetz, Studio eingeschlossen)
  const guard = await checkExposure(ctx, deps);
  if (guard.state !== "sicher") {
    err(exposedText(guard, root));
    return 1;
  }
  out(`Supabase läuft auf diesem Rechner: ${LOCAL_SUPABASE_URL}`);
  const after = await runningContainers(ctx);
  if (studio) {
    out(`Studio (Daten im Browser ansehen): ${LOCAL_STUDIO_URL}. Ohne Anmeldung, nur auf diesem Rechner erreichbar. Ausschalten: ${DB_CLI} stop, dann ${DB_CLI} start.`);
  } else if (after?.has(STUDIO_CONTAINER)) {
    out(`Studio läuft noch (${LOCAL_STUDIO_URL}). Ausschalten: ${DB_CLI} stop, dann ${DB_CLI} start.`);
  }
  return 0;
}

async function databaseStop(o: DatabaseCommandOptions): Promise<number> {
  const { ctx, out, err } = o;
  const root = ctx.root;
  if (!(await dockerRunning(ctx))) {
    out("Docker läuft nicht, also läuft auch Supabase nicht. Nichts zu tun.");
    return 0;
  }
  // Nie --no-backup (löscht die Daten), nie --all (träfe andere Projekte); ohne Signal, damit es zu Ende läuft
  const stop = await ctx.run(supabaseCli(["stop", "--workdir", root]), { timeoutMs: STATUS_TIMEOUT_MS, cwd: root, env: cliEnv() });
  const after = await containerBindings(ctx);
  if (stop.code === 0 && !stop.timedOut && after === "keine") {
    out("Supabase ist angehalten. Die Daten bleiben in den Docker-Volumes supabase_<dienst>_tybo.");
    out(`Wieder starten: ${DB_CLI} start`);
    return 0;
  }
  err(`Supabase ließ sich nicht vollständig anhalten. ${stopCommandText(root)}`);
  return 1;
}

// Größen aus docker system df (go-units, Basis 1000: B, kB, MB, GB, TB)
const SIZE_UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15 };

export function parseDockerSize(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([kmgtp]?b)$/i.exec(text.trim());
  if (!m) return null;
  return Math.round(Number(m[1]) * SIZE_UNITS[m[2].toLowerCase()]);
}

/** 1234567 → „1,2 MB“ (Basis 1000 wie Docker) */
export function formatBytes(bytes: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i++;
  }
  const shown = i === 0 ? String(Math.round(value)) : value.toFixed(1).replace(".", ",");
  return `${shown} ${units[i]}`;
}

/**
 * Volumes von tybo aus `docker system df -v` (Abschnitt „Local Volumes space
 * usage“, Name endet auf _tybo). Nur Name und Größe, nichts sonst.
 */
export function tyboVolumes(dfOutput: string): Array<{ name: string; size: string; bytes: number | null }> {
  const out: Array<{ name: string; size: string; bytes: number | null }> = [];
  let inVolumes = false;
  for (const line of dfOutput.split("\n")) {
    if (/^local volumes space usage/i.test(line.trim())) {
      inVolumes = true;
      continue;
    }
    if (!inVolumes) continue;
    if (/space usage:?$|usage:$/i.test(line.trim())) break;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2 || !parts[0].endsWith("_tybo")) continue;
    const size = parts[parts.length - 1];
    out.push({ name: parts[0], size, bytes: parseDockerSize(size) });
  }
  return out;
}

async function databaseStatus(o: DatabaseCommandOptions): Promise<number> {
  const { ctx, out } = o;
  if (!(await dockerRunning(ctx))) {
    out("Supabase auf diesem Rechner: läuft nicht (Docker läuft nicht).");
    out(`Starten: ${DB_CLI} start`);
    return 1;
  }
  // Nur docker ps und docker system df: supabase status nennt Schlüssel und wird hier nicht gebraucht
  const running = await runningContainers(ctx);
  if (running === null) {
    out("Supabase auf diesem Rechner: unbekannt (docker ps antwortet nicht).");
    return 1;
  }
  const up = running.has(DB_CONTAINER);
  out(`Supabase auf diesem Rechner: ${up ? "läuft" : "läuft nicht"}`);
  out(`Adresse: ${LOCAL_SUPABASE_URL}`);
  if (up) {
    out(`Dienste: ${running.size} Container laufen`);
    if (running.has(STUDIO_CONTAINER)) out(`Studio: ${LOCAL_STUDIO_URL}`);
    if (edgeRuntimeEnabled(ctx.root) && !running.has(EDGE_CONTAINER)) out(`Edge Runtime fehlt (nach einem Neustart des Rechners üblich); ${DB_CLI} start holt sie zurück.`);
    const bindings = await containerBindings(ctx);
    if (bindings === "offen") out(`Achtung: Ports sind nicht nur an 127.0.0.1 gebunden, Supabase ist womöglich aus dem Heimnetz erreichbar. ${DB_CLI} stop, dann ${DB_CLI} start (prüft das Netz).`);
  } else {
    out(`Starten: ${DB_CLI} start`);
  }
  const df = await ctx.run(["docker", "system", "df", "-v"], { timeoutMs: 2 * 60 * 1000 });
  const volumes = df.code === 0 ? tyboVolumes(df.stdout) : null;
  if (volumes === null) {
    out("Platz der Docker-Volumes: nicht lesbar (docker system df -v).");
  } else if (!volumes.length) {
    out("Docker-Volumes von tybo: keine (noch nie gestartet?)");
  } else {
    out("Docker-Volumes (Daten von tybo):");
    for (const v of volumes) out(`  ${v.name.padEnd(28)} ${v.size}`);
    const total = volumes.reduce((sum, v) => sum + (v.bytes ?? 0), 0);
    out(`  ${"zusammen".padEnd(28)} ${formatBytes(total)}`);
  }
  return up ? 0 : 1;
}

/** JJJJMMTT-HHMM in Ortszeit */
export function backupStamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

/**
 * Legt den Ordner der Sicherung exklusiv an (0700): supabase-<stamp>, ist der
 * Name belegt, supabase-<stamp>-2, -3 … Eine vorhandene Sicherung wird nie
 * überschrieben, auch nicht bei zwei Läufen in derselben Minute.
 */
export async function claimBackupDir(parent: string, stamp: string): Promise<string> {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  for (let i = 1; i <= 99; i++) {
    const dir = join(parent, i === 1 ? `supabase-${stamp}` : `supabase-${stamp}-${i}`);
    try {
      await mkdir(dir, { mode: 0o700 });
      await chmod(dir, 0o700);
      return dir;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
    }
  }
  throw Object.assign(new Error("Zu viele Sicherungen in dieser Minute"), { code: "EEXIST" });
}

/** Teile der Sicherung in der Reihenfolge, in der sie entstehen */
export const BACKUP_PARTS = ["schema.sql", "daten.sql", "storage.sql", "bilder.tar.gz"] as const;
export const BACKUP_MANIFEST = "sicherung.txt";

const PART_TEXT: Record<(typeof BACKUP_PARTS)[number], string> = {
  "schema.sql": "Tabellen, Funktionen und Rechte von tybo (ohne auth, storage und die anderen Supabase-Schemas)",
  "daten.sql": "Inhalte der Tabellen von tybo im Schema public: Gespräche, Gedächtnis, Ziele (ohne auth und storage)",
  "storage.sql": "Einträge der Bilder (storage.buckets, storage.objects; ohne storage.migrations)",
  "bilder.tar.gz": `die Bilddateien selbst (Volume supabase_storage_tybo, ${STORAGE_PATH} im Storage-Container)`,
};

async function databaseBackup(o: DatabaseCommandOptions, ziel: string | undefined): Promise<number> {
  const { ctx, out, err, signal } = o;
  const root = ctx.root;
  const parent = ziel ? resolve(o.cwd ?? process.cwd(), ziel) : join(root, "data", "backups");

  if (!(await dockerRunning(ctx))) {
    err(`Docker läuft nicht, so lässt sich nichts sichern. Docker starten, dann ${DB_CLI} start und erneut ${DB_CLI} sichern.`);
    return 1;
  }
  const running = await runningContainers(ctx);
  if (!running?.has(DB_CONTAINER) || !running.has(STORAGE_CONTAINER)) {
    err(`Supabase läuft nicht (Datenbank oder Storage fehlt), so lässt sich nichts sichern. Erst ${DB_CLI} start, dann erneut ${DB_CLI} sichern.`);
    return 1;
  }

  let dir: string;
  try {
    dir = await claimBackupDir(parent, backupStamp(ctx.now()));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    err(`Der Ordner für die Sicherung ließ sich in ${parent} nicht anlegen${code ? ` (${code})` : ""}. Einen anderen Ort mit --ziel <Ordner> angeben.`);
    return 1;
  }
  out(`Sichere nach ${dir} …`);

  const cli = { cwd: root, env: cliEnv(), timeoutMs: BACKUP_STEP_TIMEOUT_MS, signal };
  const file = (name: string) => join(dir, name);
  // Reihenfolge verbindlich (Konsistenz bei laufendem Bot): erst die Tabellen
  // von tybo, dann die Einträge der Bilder, zuletzt die Dateien. Ein Bild lädt
  // tybo erst hoch und trägt es dann ein; so fehlt zu keinem gesicherten
  // Eintrag die Datei, höchstens liegt eine neuere Datei ohne Eintrag bei.
  const steps: Array<{ label: string; name: string; cmds: string[][] }> = [
    { label: "Schema", name: "schema.sql", cmds: [supabaseCli(["db", "dump", "--local", "--workdir", root, "-f", file("schema.sql")])] },
    // -s public: ohne -s nimmt die CLI 2.118.0 auch auth, storage und
    // supabase_functions mit (im Handversuch gemessen); tybo hat nur public,
    // storage steht getrennt in storage.sql
    { label: "Daten", name: "daten.sql", cmds: [supabaseCli(["db", "dump", "--local", "--workdir", root, "--data-only", "-s", "public", "-f", file("daten.sql")])] },
    { label: "Einträge der Bilder", name: "storage.sql", cmds: [supabaseCli(["db", "dump", "--local", "--workdir", root, "--data-only", "-s", "storage", "-f", file("storage.sql")])] },
    {
      label: "Bilddateien",
      name: "bilder.tar.gz",
      cmds: [
        ["docker", "cp", `${STORAGE_CONTAINER}:${STORAGE_PATH}/.`, file(".bilder")],
        // COPYFILE_DISABLE: kein ._-Beiwerk von macOS im Archiv
        ["tar", "-czf", file("bilder.tar.gz"), "-C", file(".bilder"), "."],
      ],
    },
  ];

  const failed = async (text: string, aborted = false): Promise<number> => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    err(aborted ? "Abgebrochen. Die unvollständige Sicherung ist gelöscht." : `${text} Die unvollständige Sicherung ist gelöscht; nichts Älteres wurde angefasst.`);
    return aborted ? EXIT_ABORTED : 1;
  };

  for (const [i, step] of steps.entries()) {
    out(`  ${i + 1}/${steps.length} ${step.label}`);
    for (const cmd of step.cmds) {
      const env = cmd[0] === "tar" ? { ...cliEnv(), COPYFILE_DISABLE: "1" } : cli.env;
      const r = await ctx.run(cmd, { ...cli, env });
      if (r.aborted || signal?.aborted) return failed("", true);
      // Ausgabe von CLI und Docker geht nie weiter
      if (r.code !== 0) {
        const why = r.timedOut ? "hat nach 30 Minuten nicht geantwortet" : "ist fehlgeschlagen";
        return failed(`Die Sicherung (${step.label}) ${why}. Läuft Supabase? ${DB_CLI} status zeigt es.`);
      }
    }
    const size = await stat(file(step.name)).then(s => (s.isFile() ? s.size : 0), () => 0);
    if (size <= 0) return failed(`Die Sicherung (${step.label}) hat keine Datei ${step.name} geschrieben.`);
  }
  await rm(file(".bilder"), { recursive: true, force: true }).catch(() => {});

  // Inhaltsverzeichnis zuletzt: liegt es da, ist die Sicherung vollständig
  let total = 0;
  const lines = [
    `${BRAND.name}: Sicherung von Supabase auf diesem Rechner`,
    `Zeit: ${ctx.now().toISOString()}`,
    `Supabase-CLI: ${SUPABASE_CLI_VERSION}`,
    "Reihenfolge: schema.sql, daten.sql, storage.sql, bilder.tar.gz",
    "",
  ];
  try {
    for (const name of BACKUP_PARTS) {
      const size = (await stat(file(name))).size;
      total += size;
      await chmod(file(name), 0o600);
      lines.push(`${name.padEnd(14)} ${formatBytes(size).padStart(9)}  ${PART_TEXT[name]}`);
    }
    lines.push("", "Wiederherstellen: docs/einrichtung.md, Abschnitt „Supabase lokal im Alltag“.", "");
    await writeFile(file(BACKUP_MANIFEST), lines.join("\n"), { mode: 0o600 });
    const extra = (await readdir(dir)).filter(n => ![...BACKUP_PARTS, BACKUP_MANIFEST].includes(n as any));
    if (extra.length) throw new Error("unerwartete Dateien");
  } catch {
    return failed("Die Sicherung ließ sich nicht abschließen (Dateien nicht lesbar).");
  }
  out(`Sicherung fertig: ${dir} (${formatBytes(total)})`);
  out("Die Dateien enthalten alle Gespräche und das Gedächtnis: nur an einem sicheren Ort aufbewahren.");
  return 0;
}

/**
 * tybo datenbank … (Issue #165). Tut nur etwas, wenn SUPABASE_URL genau auf
 * das Supabase dieses Projekts zeigt; sonst ein Hinweis und Exit 1. Gibt nie
 * Ausgaben der CLI weiter (start und status nennen Schlüssel).
 */
export async function runDatabaseCommand(args: string[], o: DatabaseCommandOptions): Promise<number> {
  const parsed = parseDatabaseArgs(args);
  if (!parsed) {
    o.err(`Unbekannter Aufruf: ${DB_CLI} ${args.join(" ")}`);
    o.err(databaseUsage());
    return 2;
  }
  if (parsed.command === "help") {
    o.out(databaseUsage());
    return 0;
  }
  const notLocal = notLocalText(o.env.SUPABASE_URL);
  if (notLocal) {
    o.err(notLocal);
    return 1;
  }
  switch (parsed.command) {
    case "start":
      return databaseStart(o, parsed.studio);
    case "stop":
      return databaseStop(o);
    case "status":
      return databaseStatus(o);
    case "sichern":
      return databaseBackup(o, parsed.ziel);
  }
}
