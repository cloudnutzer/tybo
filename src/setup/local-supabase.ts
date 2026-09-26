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
 */

import { connect } from "node:net";
import { networkInterfaces, totalmem } from "node:os";
import { join } from "node:path";
import { BRAND } from "../brand";
import { assetsBucket } from "../lib/asset-store";
import { isSecretName } from "../lib/subprocess-env";
import { readSetupEnv, type CommandResult, type SetupContext } from "./context";
import type { ApplyResult, RunReport, SetupValues } from "./model";
import { trackSafetyWork, writeEnv } from "./steps/common";
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
export const LOCAL_SUPABASE_URL = `http://127.0.0.1:${LOCAL_API_PORT}`;
/** Ports, die nie aus dem Heimnetz erreichbar sein dürfen */
export const GUARDED_PORTS = [LOCAL_API_PORT, LOCAL_DB_PORT];

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

export function startProblemText(problem: StartProblem, root: string): string {
  const retry = `Danach die Einrichtung erneut starten (${BRAND.cli} setup datenbank).`;
  switch (problem) {
    case "port":
      return `Supabase startet nicht, weil ein Port im Bereich 54420 bis 54429 belegt ist: ein anderes Programm oder ein altes Supabase auf 544xx. Mit docker ps nachsehen, was dort läuft, und es beenden. ${retry}`;
    case "speicher":
      return `Supabase startet nicht, weil der Speicherplatz für die Docker-Images fehlt (einige GB). Platz schaffen, etwa mit docker system prune (löscht nur ungenutzte Images und Container), bei Docker Desktop auch die Größe der virtuellen Festplatte erhöhen. ${retry}`;
    case "zeitlimit":
      return `Supabase ist nach 20 Minuten noch nicht gestartet. Beim ersten Mal lädt Docker mehrere GB; bei langsamer Leitung dauert das. Die schon geladenen Teile bleiben, ein zweiter Versuch macht dort weiter. ${retry}`;
    case "abgebrochen":
      return `Abgebrochen. Die .env ist unverändert. ${retry}`;
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

function exposedText(guard: Guard, root: string): string {
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
  return { ok: true, message: `${done} ${probe.message}`, changed };
}

/** Zustand eines Bilder-Ordners, ohne ihn anzulegen (keine Zeile: gibt es nicht) */
export function bucketStateSql(name: string): string {
  if (!isValidBucketName(name)) throw new Error("Ungültiger Name für den Bilder-Ordner");
  return `select public from storage.buckets where id = '${name}';`;
}

function publicBucketText(): string {
  return "Der Bilder-Ordner aus SUPABASE_ASSETS_BUCKET ist in der lokalen Supabase öffentlich. tybo braucht einen privaten und stellt ihn nicht still um: einen anderen Namen in SUPABASE_ASSETS_BUCKET eintragen, dann die Einrichtung erneut starten. Die .env ist unverändert.";
}
