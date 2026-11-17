/**
 * Dienste unter launchd einrichten (macOS, Issue #369, Nachfolger von
 * setup/configure-launchd.ts). Die Plist kommt aus dem Dienstkatalog
 * (src/lib/services/catalog.ts) und dem Generator (src/lib/services/plist.ts),
 * landet in ~/Library/LaunchAgents/ai.tybo.<dienst>.plist und wird mit
 * launchctl geladen.
 *
 * Regeln beim Einrichten eines Diensts:
 * - Dienste der Art external (whatsapp-gateway, cloudflare-tunnel) richtet
 *   tybo nicht ein: keine Datei, kein launchctl.
 * - Gleiche Plist schon da: launchctl list entscheidet. Geladen heißt nichts
 *   tun (neu laden würde den Dienst neu starten), nicht geladen heißt laden,
 *   unbekannt heißt abbrechen, bevor irgendetwas passiert.
 * - Andere Plist da: erst entladen. Scheitert das und ist der Dienst noch
 *   (oder vielleicht noch) geladen, bleibt die alte Datei liegen und nichts
 *   wird geladen. ai.tybo.supabase bekommt fürs Entladen eine längere Frist
 *   (SUPABASE_UNLOAD_TIMEOUT_MS), weil launchd einem laufenden Start bis zu
 *   ExitTimeOut Zeit lässt.
 * - Keine Plist da: schreiben und laden.
 * Andere Labels (frühere Namen, eigene Watcher) fasst das Modul nie an.
 *
 * Das Ergebnis ist ein LaunchdOutcome mit fester Fehlerart; Meldungen dazu
 * liefert failureMessage, ohne Ausgaben von launchctl (stderr kann
 * Geheimnisse aus der Umgebung enthalten). Alles Äußere steckt in
 * LaunchdDeps, Tests reichen Attrappen herein.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readEnvFile } from "../../lib/env-file";
import { setupSchedule } from "../../lib/proactive/setup-schedule";
import { isServiceName, SERVICE_NAMES, serviceDefinition, type ServiceName } from "../../lib/services/catalog";
import { PlistError, servicePlist } from "../../lib/services/plist";
import { labelInLaunchctlList, launchdLabel, SUPABASE_SERVICE } from "../../lib/service-names";
import { isLocalSupabaseUrl, LAUNCHD_EXIT_TIMEOUT_S } from "../local-supabase";
import { runWithTimeout } from "./run";

export type { ServiceName };

/** Ergebnis eines Befehls; ok heißt Exit-Code 0 */
export interface LaunchdRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Zugriffe nach außen */
export interface LaunchdDeps {
  projectRoot: string;
  launchAgentsDir: string;
  home: string;
  /** timeoutMs: eigene Frist für diesen Aufruf (Entladen von ai.tybo.supabase) */
  run(cmd: string[], options?: { timeoutMs?: number }): Promise<LaunchdRun>;
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  mkdir(path: string): void;
  log(line: string): void;
}

/** Frist für launchctl unload ai.tybo.supabase: ExitTimeOut plus eine Minute */
export const SUPABASE_UNLOAD_TIMEOUT_MS = (LAUNCHD_EXIT_TIMEOUT_S + 60) * 1000;

/** Frist für alle übrigen Befehle im echten Betrieb */
export const COMMAND_TIMEOUT_MS = 30_000;

/** Wenn `which claude` nichts findet: Verzeichnis für den PATH der Plist */
const CLAUDE_DIR_DEFAULT = "/usr/local/bin";

export type LaunchdFailure = "external" | "no-bun" | "plist-invalid" | "state-unknown" | "unload-failed" | "load-failed";

/**
 * unchanged: gleiche Plist, schon geladen, nichts getan
 * reloaded: gleiche Plist, war nicht geladen, jetzt geladen
 * written: Plist neu oder geändert geschrieben und geladen
 */
export type LaunchdAction = "unchanged" | "reloaded" | "written";

export type LaunchdOutcome =
  | { ok: true; service: ServiceName; label: string; action: LaunchdAction; running: boolean }
  | { ok: false; service: ServiceName; label: string; failure: LaunchdFailure };

export function plistFile(service: ServiceName, launchAgentsDir: string): string {
  return join(launchAgentsDir, `${launchdLabel(service)}.plist`);
}

/**
 * Feste Meldung zu einer Fehlerart, ohne Befehlsausgaben. Gilt für
 * `tybo dienste` und `tybo setup autostart`.
 */
export function failureMessage(failure: LaunchdFailure, label: string): string {
  switch (failure) {
    case "external":
      return `${label} richtet tybo nicht ein (eigener Dienst, nicht von tybo eingerichtet).`;
    case "no-bun":
      return "Bun wurde nicht im PATH gefunden.";
    case "plist-invalid":
      return "Die Dienstdatei ließ sich nicht erzeugen: ein Pfad enthält Steuerzeichen.";
    case "state-unknown":
      return `Ob der Dienst ${label} geladen ist, ließ sich nicht feststellen (launchctl list). Nichts geändert.`;
    case "unload-failed":
      return `Der Dienst ${label} ließ sich nicht entladen. Dienstdateien unverändert, kein weiterer Dienst geladen.`;
    case "load-failed":
      return "launchctl konnte den Dienst nicht laden. Die Dienstdatei liegt da; ein erneuter Versuch lädt sie noch einmal.";
  }
}

/**
 * Welche Dienste ein Aufruf meint: ein Name aus dem Katalog nur sich selbst,
 * „all“ alle außer den nur einzeln einrichtbaren (software-update, wartung); supabase
 * bei „all“ nur, wenn SUPABASE_URL in der .env unter envPath auf das
 * Supabase dieses Rechners zeigt (fehlt die Datei: nie). Sonst null.
 * Dienste der Art external stehen mit drin und werden beim Einrichten
 * abgelehnt, wie bisher.
 */
export async function selectServices(request: string, envPath: string): Promise<ServiceName[] | null> {
  if (request !== "all") return isServiceName(request) ? [request] : null;
  let supabaseUrl: string | undefined;
  try {
    supabaseUrl = (await readEnvFile(envPath)).SUPABASE_URL;
  } catch {
    supabaseUrl = undefined;
  }
  const localDatabase = isLocalSupabaseUrl(supabaseUrl);
  return SERVICE_NAMES.filter(name => {
    if (serviceDefinition(name).onlyExplicit) return false;
    return name !== SUPABASE_SERVICE || localDatabase;
  });
}

/** Ladezustand laut launchctl list; null, wenn die Liste nicht lesbar ist */
async function loadedState(label: string, deps: LaunchdDeps): Promise<boolean | null> {
  const listing = await deps.run(["launchctl", "list"]);
  return listing.ok ? labelInLaunchctlList(listing.stdout, label) : null;
}

async function whichPath(program: string, deps: LaunchdDeps): Promise<string | null> {
  const found = await deps.run(["which", program]);
  const path = found.stdout.trim();
  return found.ok && path !== "" ? path : null;
}

const clock = (hour: number, minute: number) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

/** Richtet einen Dienst ein; wirft nur, wenn Dateizugriffe scheitern */
export async function setUpService(service: ServiceName, deps: LaunchdDeps): Promise<LaunchdOutcome> {
  const label = launchdLabel(service);
  const definition = serviceDefinition(service);
  const target = plistFile(service, deps.launchAgentsDir);
  const failed = (failure: LaunchdFailure): LaunchdOutcome => {
    deps.log(`  ✗ ${failureMessage(failure, label)}`);
    return { ok: false, service, label, failure };
  };
  const succeeded = async (action: LaunchdAction): Promise<LaunchdOutcome> => {
    // Nach dem Laden: steht das Label in der Liste? Routinen erscheinen dort
    // manchmal erst zum ersten Termin
    const running = action === "unchanged" || (await loadedState(label, deps)) === true;
    if (action === "unchanged") deps.log(`  ✓ Unverändert und geladen: ${label}`);
    else deps.log(running ? `  ✓ Geladen: ${label}` : `  ! Geladen, aber noch nicht in launchctl list: ${label} (startet evtl. erst zum Termin)`);
    return { ok: true, service, label, action, running };
  };

  deps.log(`\n  ${service}`);
  if (definition.kind === "external") return failed("external");

  const bun = await whichPath("bun", deps);
  if (bun === null) return failed("no-bun");
  const claude = await whichPath("claude", deps);

  const schedule = setupSchedule(deps.projectRoot, deps, "wildcard");
  let wanted: string;
  try {
    wanted = servicePlist(
      definition,
      {
        bun,
        claudeDir: claude === null ? CLAUDE_DIR_DEFAULT : dirname(claude),
        home: deps.home,
        projectRoot: deps.projectRoot,
        exitTimeoutS: LAUNCHD_EXIT_TIMEOUT_S,
      },
      schedule,
    );
  } catch (error) {
    if (error instanceof PlistError) return failed("plist-invalid");
    throw error;
  }

  if (definition.calendar) {
    const plan = definition.calendar(schedule);
    if (plan.form === "list") deps.log(`    Zeitplan: ${plan.slots.length} Termine`);
    else if (plan.slot.hour !== undefined && plan.slot.minute !== undefined) deps.log(`    Zeitplan: täglich um ${clock(plan.slot.hour, plan.slot.minute)}`);
  }

  const present = deps.exists(target);
  if (present && deps.readFile(target) === wanted) {
    const loaded = await loadedState(label, deps);
    if (loaded === null) return failed("state-unknown");
    if (loaded) return succeeded("unchanged");
    if (!(await deps.run(["launchctl", "load", target])).ok) return failed("load-failed");
    return succeeded("reloaded");
  }

  if (present) {
    deps.log(`    Plist geändert, entlade ${label}`);
    const timeout = service === SUPABASE_SERVICE ? { timeoutMs: SUPABASE_UNLOAD_TIMEOUT_MS } : undefined;
    const unload = await deps.run(["launchctl", "unload", target], timeout);
    // launchctl unload scheitert auch bei einem gar nicht geladenen Dienst;
    // weiter geht es nur, wenn er sicher nicht mehr in der Liste steht
    if (!unload.ok && (await loadedState(label, deps)) !== false) return failed("unload-failed");
  }

  if (!deps.exists(deps.launchAgentsDir)) deps.mkdir(deps.launchAgentsDir);
  deps.writeFile(target, wanted);
  deps.log(`    Geschrieben: ${target}`);
  if (!(await deps.run(["launchctl", "load", target])).ok) return failed("load-failed");
  return succeeded("written");
}

/** Echte Zugriffe für den Projektordner root; Frist je Aufruf wie verlangt, sonst COMMAND_TIMEOUT_MS */
export function realLaunchdDeps(root: string, home: string = process.env.HOME || homedir()): LaunchdDeps {
  return {
    projectRoot: root,
    launchAgentsDir: join(home, "Library", "LaunchAgents"),
    home,
    run: (cmd, options) => runWithTimeout(cmd, root, options?.timeoutMs ?? COMMAND_TIMEOUT_MS),
    exists: path => existsSync(path),
    readFile: path => readFileSync(path, "utf8"),
    writeFile: (path, content) => writeFileSync(path, content, { encoding: "utf8", mode: 0o644 }),
    mkdir: path => void mkdirSync(path, { recursive: true }),
    log: line => console.log(line),
  };
}
