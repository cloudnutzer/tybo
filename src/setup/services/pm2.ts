/**
 * Dauerdienste unter PM2 (Issue #370, Nachfolger von
 * setup/configure-services.ts): der Bot (tybo-telegram-relay) und Supabase
 * auf diesem Rechner (tybo-supabase, Issue #165). Genutzt von
 * `tybo dienste` unter Linux und von `tybo setup autostart`.
 *
 * Regeln beim Einrichten eines Prozesses:
 * - Erst `pm2 jlist`. Ist die Liste nicht lesbar, ändert sich nichts.
 * - Steht tybo-<dienst> schon drin, wird er entfernt (`pm2 delete`); scheitert
 *   das, startet nichts, denn der alte Prozess läuft womöglich noch.
 *   tybo-supabase bekommt dafür SUPABASE_DELETE_TIMEOUT_MS, weil PM2 ihm beim
 *   Beenden bis zu PM2_KILL_TIMEOUT_MS lässt.
 * - Prozesse anderer Namen (frühere Namen, fremde Programme) fasst das Modul
 *   nie an (Issue #142).
 * - Danach `pm2 start` mit allen PM2-Optionen vor dem Trenner „--“; dahinter
 *   stehen nur die Argumente für bun. Der Bot bekommt BOT_PM2_OPTIONS
 *   (Frist zum Beenden, Issue #564).
 * `pm2 save` ist ein eigener Schritt (savePm2), damit der Aufrufer erst alle
 * Dienste einrichtet und dann einmal speichert.
 *
 * tybo-supabase läuft über die Hülle scripts/run-once-and-stay.ts: sie führt
 * `tybo datenbank start` einmal aus, bleibt dann stehen (sonst sicherte
 * `pm2 save` den Eintrag als „stopped“, und er käme beim Hochfahren nicht
 * wieder) und hält Startzustand und Exit-Code in --state fest.
 *
 * Ergebnisse mit fester Fehlerart; Meldungen dazu liefert
 * pm2FailureMessage, nie mit Ausgaben von PM2 (stderr kann Geheimnisse aus
 * der Umgebung enthalten). Alles Äußere steckt in Pm2Deps.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { pm2RpcSocketPath, queryPm2Daemon, type Pm2Query } from "../../lib/routines/sources/pm2-rpc";
import { pm2Name, SUPABASE_SERVICE, SUPABASE_START_STATE } from "../../lib/service-names";
import { serviceDefinition } from "../../lib/services/catalog";
import { PM2_KILL_TIMEOUT_MS } from "../local-supabase";
import { runWithTimeout, type ServiceRun } from "./run";

/** Dienste, die unter PM2 laufen */
export type Pm2Service = "telegram-relay" | "supabase";
export const PM2_SERVICES: readonly Pm2Service[] = ["telegram-relay", "supabase"];

/** Hülle für tybo-supabase: einmal ausführen, dann stehen bleiben */
export const ONCE_WRAPPER = "scripts/run-once-and-stay.ts";

/**
 * PM2-Optionen für tybo-supabase: kein Neustart durch PM2, und beim Beenden
 * die volle Frist für Bereinigung, Schutz-Stopp und Nachprüfung, bevor PM2
 * SIGKILL schickt (Nachweis: scripts/pm2-stop-proof.ts)
 */
export const SUPABASE_PM2_OPTIONS = ["--no-autorestart", "--kill-timeout", String(PM2_KILL_TIMEOUT_MS)];

/**
 * Frist zum Beenden des Bots unter PM2 (Issue #564). PM2 schickt sonst nach
 * 1,6 Sekunden SIGKILL; der Bot braucht für seine Closer und das Freigeben
 * von bot.lock länger, und die Sperre bliebe bei jedem Neustart liegen.
 * deploy.sh setzt denselben Wert als kill_timeout (Test in tests/deploy.test.ts).
 */
export const BOT_PM2_KILL_TIMEOUT_MS = 10_000;

/** PM2-Optionen für den Bot (tybo-telegram-relay) */
export const BOT_PM2_OPTIONS = ["--kill-timeout", String(BOT_PM2_KILL_TIMEOUT_MS)];

/** Frist für `pm2 delete tybo-supabase`: PM2 wartet bis zu PM2_KILL_TIMEOUT_MS */
export const SUPABASE_DELETE_TIMEOUT_MS = PM2_KILL_TIMEOUT_MS + 60_000;

/** Frist für alle übrigen PM2-Aufrufe im echten Betrieb */
export const PM2_COMMAND_TIMEOUT_MS = 30_000;

export interface Pm2Deps {
  projectRoot: string;
  /** Aufruf von PM2, etwa ["pm2"] */
  pm2: string[];
  /** timeoutMs: eigene Frist für diesen Aufruf */
  run(cmd: string[], options?: { timeoutMs?: number }): Promise<ServiceRun>;
  log(line: string): void;
  /**
   * Prozessliste vom laufenden Daemon über seinen Socket (Issue #568,
   * queryPm2Daemon); startet nie einen. Fehlt: nicht abfragbar.
   */
  query?(): Promise<Pm2Query>;
  /**
   * Gesicherte Liste (PM2_HOME/dump.pm2), die pm2 resurrect beim Hochfahren
   * liest (Issue #568). Fehlt: nicht geprüft.
   */
  dumpPath?: string;
}

export type Pm2Failure = "list-unreadable" | "delete-failed" | "start-failed";

export type Pm2Outcome = { ok: true; service: Pm2Service; name: string; replaced: boolean } | { ok: false; service: Pm2Service; name: string; failure: Pm2Failure };

/** Feste Meldung zu einer Fehlerart, ohne Ausgaben von PM2 */
export function pm2FailureMessage(failure: Pm2Failure, service: Pm2Service): string {
  const name = pm2Name(service);
  switch (failure) {
    case "list-unreadable":
      return "Die Liste der PM2-Dienste ließ sich nicht lesen (pm2 jlist). Nichts geändert.";
    case "delete-failed":
      return `Der PM2-Prozess ${name} ließ sich nicht neu starten, weil er sich nicht entfernen ließ. Kein weiterer Prozess gestartet.`;
    case "start-failed":
      return `PM2 konnte ${service === "telegram-relay" ? "den Bot" : name} nicht starten. Details mit: pm2 logs ${name}`;
  }
}

/** Namen aller Prozesse laut `pm2 jlist`; null, wenn die Ausgabe keine Liste ist */
export async function pm2ProcessNames(deps: Pm2Deps): Promise<string[] | null> {
  const result = await deps.run([...deps.pm2, "jlist"]);
  if (!result.ok) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.map(entry => {
    const name = (entry as { name?: unknown } | null)?.name;
    return typeof name === "string" ? name : "";
  });
}

/** Argumente für bun hinter „--“: Routinen-Hülle bzw. Einstieg aus dem Katalog */
function bunArgs(service: Pm2Service, root: string): string[] {
  if (service === SUPABASE_SERVICE) {
    // Katalog: --no-env-file {root}/scripts/tybo.ts datenbank start; die Hülle davor
    const [noEnv, script, ...rest] = serviceDefinition(service).args.map(arg => arg.replaceAll("{root}", () => root));
    return [noEnv, join(root, ONCE_WRAPPER), "--state", join(root, SUPABASE_START_STATE), script, ...rest];
  }
  // Bot: run <root>/src/bot.ts
  const [verb, entry] = serviceDefinition(service).args;
  return [verb, join(root, entry)];
}

/**
 * Vollständiger Aufruf von `pm2 start` für einen Dienst. Alle PM2-Optionen
 * (Name, Optionen von tybo-supabase, Protokoll) stehen vor „--“. Beide
 * Ströme gehen in logs/<dienst>.log wie bisher unter PM2.
 */
export function pm2StartCommand(service: Pm2Service, root: string, pm2: string[]): string[] {
  const logFile = join(root, "logs", `${service}.log`);
  const own = service === SUPABASE_SERVICE ? SUPABASE_PM2_OPTIONS : BOT_PM2_OPTIONS;
  return [...pm2, "start", "bun", "--name", pm2Name(service), ...own, "--output", logFile, "--error", logFile, "--merge-logs", "--", ...bunArgs(service, root)];
}

/** Richtet einen Dienst unter PM2 ein (entfernen, falls da, dann starten); speichert nicht */
export async function configurePM2Service(service: Pm2Service, deps: Pm2Deps): Promise<Pm2Outcome> {
  const name = pm2Name(service);
  const fail = (failure: Pm2Failure): Pm2Outcome => {
    deps.log(`  ✗ ${pm2FailureMessage(failure, service)}`);
    return { ok: false, service, name, failure };
  };
  deps.log(`\n  ${service} (PM2)`);

  const names = await pm2ProcessNames(deps);
  if (names === null) return fail("list-unreadable");
  const replaced = names.includes(name);
  if (replaced) {
    const timeout = service === SUPABASE_SERVICE ? { timeoutMs: SUPABASE_DELETE_TIMEOUT_MS } : undefined;
    if (!(await deps.run([...deps.pm2, "delete", name], timeout)).ok) return fail("delete-failed");
  }
  if (!(await deps.run(pm2StartCommand(service, deps.projectRoot, deps.pm2))).ok) return fail("start-failed");
  deps.log(`  ✓ ${replaced ? "Neu gestartet" : "Gestartet"}: ${name}`);
  return { ok: true, service, name, replaced };
}

/** Meldung, wenn `pm2 save` scheitert */
export const PM2_SAVE_FAILED = "pm2 save ist gescheitert: nach einem Neustart des Rechners fehlen die Dienste. Einmal „pm2 save“ ausführen.";

/**
 * Hält die laufenden Prozesse fest (`pm2 save`), damit `pm2 resurrect` sie
 * beim Hochfahren zurückholt. force (Issue #568): nach einem entfernten
 * Prozess. Ohne --force überschreibt PM2 bei leerer Liste die alte
 * Sicherung nicht, meldet aber Erfolg, und der Prozess käme beim
 * Hochfahren zurück. Nur dann, denn sonst sicherte ein frisch gestarteter
 * Daemon ohne resurrect die leere Liste über fremde Prozesse.
 */
export async function savePm2(deps: Pm2Deps, options: { force?: boolean } = {}): Promise<boolean> {
  const saved = (await deps.run([...deps.pm2, "save", ...(options.force ? ["--force"] : [])])).ok;
  if (!saved) deps.log(`  ✗ ${PM2_SAVE_FAILED}`);
  return saved;
}

/** Ist PM2 aufrufbar? Nur das installierte pm2, nie über npx (lädt sonst nach) */
export async function pm2Installed(deps: Pm2Deps): Promise<boolean> {
  return (await deps.run([...deps.pm2, "--version"])).ok;
}

/** Echte Zugriffe; Frist je Aufruf wie verlangt, sonst PM2_COMMAND_TIMEOUT_MS */
export function realPm2Deps(root: string, log: (line: string) => void = line => console.log(line)): Pm2Deps {
  const pm2Home = process.env.PM2_HOME || join(process.env.HOME || homedir(), ".pm2");
  return {
    projectRoot: root,
    pm2: ["pm2"],
    run: (cmd, options) => runWithTimeout(cmd, root, options?.timeoutMs ?? PM2_COMMAND_TIMEOUT_MS),
    log,
    query: () => queryPm2Daemon(pm2RpcSocketPath(process.platform, pm2Home)),
    dumpPath: join(pm2Home, "dump.pm2"),
  };
}
