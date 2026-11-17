import { trackEngineTermination } from "./engines/calls";
import { CLAUDE_STOP_PLAN, stopTree, type TreeProc } from "./engines/platform";

/**
 * Beendet einen Prozessbaum wie bei Claude: SIGTERM an die Prozessgruppe,
 * nach 1,5 Sekunden SIGKILL (Windows: taskkill /T /F). Alle Aufrufer starten
 * ihre Prozesse mit eigener Gruppe (startsOwnGroup in engines/platform.ts).
 * Bis zum SIGKILL verfolgt (trackEngineTermination), damit das Beenden des
 * Bots auch auf Gruppen wartet, deren Aufruf schon abgemeldet ist (Issue
 * #561). Hintergrund-Jobs beenden ihre Gruppen selbst (jobs/process.ts).
 */
export function terminateProcessTree(proc: TreeProc): void {
  if (!(proc.pid > 1)) return;
  stopTree(proc, CLAUDE_STOP_PLAN, undefined, trackEngineTermination(proc));
}
