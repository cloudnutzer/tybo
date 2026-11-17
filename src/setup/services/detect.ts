/**
 * Ist ein Zeitplan-Dienst auf diesem Rechner eingerichtet? Nur lesend, für
 * den Nachtcheck (Issue #487, Zeile „Wartung“): launchd unter macOS, unter
 * Linux systemd-Timer oder cron, so wie setUpService und setUpTimer sie
 * anlegen.
 *
 * - eingerichtet: der Dienstmanager führt ihn (launchd geladen, Timer aktiv
 *   und aktiviert, cron-Zeile vorhanden)
 * - aus: die Datei liegt da, läuft aber nicht (Plist nicht geladen, Timer
 *   abgeschaltet)
 * - fehlt: keine Spur von ihm
 * - unbekannt: nicht feststellbar (launchctl scheitert, systemd antwortet
 *   nicht, crontab unlesbar)
 * - nicht-verfuegbar: auf diesem System gibt es den Dienst nicht
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { launchdLabel, labelInLaunchctlList, systemdUnit } from "../../lib/service-names";
import { isOwnCronLine } from "../../lib/services/systemd";
import { readCrontab, timerState, userUnitDir } from "./linux";
import { runWithTimeout, type ServiceRun } from "./run";

/** Je Befehl; zwei hintereinander passen in das Zeitlimit einer Prüfung des Nachtchecks */
const DETECT_TIMEOUT_MS = 6_000;

export type ScheduledServiceState = "eingerichtet" | "aus" | "fehlt" | "unbekannt" | "nicht-verfuegbar";

export interface DetectDeps {
  platform: NodeJS.Platform;
  launchAgentsDir: string;
  /** Ordner der Benutzereinheiten, ~/.config/systemd/user */
  unitDir: string;
  /** /run/systemd/system: gibt es nur, wenn der Rechner mit systemd läuft */
  runDir: string;
  exists(path: string): boolean;
  run(cmd: string[]): Promise<ServiceRun>;
}

async function detectLaunchd(service: string, deps: DetectDeps): Promise<ScheduledServiceState> {
  const label = launchdLabel(service);
  const listed = await deps.run(["launchctl", "list"]);
  if (listed.ok && labelInLaunchctlList(listed.stdout, label)) return "eingerichtet";
  if (!deps.exists(join(deps.launchAgentsDir, `${label}.plist`))) return "fehlt";
  return listed.ok ? "aus" : "unbekannt";
}

async function detectLinux(service: string, deps: DetectDeps): Promise<ScheduledServiceState> {
  const unit = systemdUnit(service);
  const withSystemd = deps.exists(deps.runDir);
  const timer = withSystemd ? await timerState(unit, deps) : null;
  if (timer?.reachable && timer.active && timer.enabled) return "eingerichtet";

  const crontab = await readCrontab(deps);
  // Eine auskommentierte Zeile trägt die Markierung auch, läuft aber nie
  if (crontab?.some(line => isOwnCronLine(line, service) && !line.trimStart().startsWith("#"))) return "eingerichtet";

  if (withSystemd && deps.exists(join(deps.unitDir, `${unit}.timer`))) return timer?.reachable ? "aus" : "unbekannt";
  return crontab === null ? "unbekannt" : "fehlt";
}

/** Zustand des Diensts; wirft nicht, Befehle kommen über deps */
export async function detectScheduledService(service: string, deps: DetectDeps): Promise<ScheduledServiceState> {
  if (deps.platform === "darwin") return detectLaunchd(service, deps);
  if (deps.platform === "linux") return detectLinux(service, deps);
  return "nicht-verfuegbar";
}

/** Echte Zugriffe für den Projektordner root; nur lesende Befehle */
export function realDetectDeps(root: string, home: string = process.env.HOME || homedir()): DetectDeps {
  return {
    platform: process.platform,
    launchAgentsDir: join(home, "Library", "LaunchAgents"),
    unitDir: userUnitDir(process.env, home),
    runDir: "/run/systemd/system",
    exists: path => existsSync(path),
    run: cmd => runWithTimeout(cmd, root, DETECT_TIMEOUT_MS),
  };
}
