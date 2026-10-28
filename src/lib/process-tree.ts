import { CLAUDE_STOP_PLAN, stopTree, type TreeProc } from "./engines/platform";

/**
 * Beendet einen Prozessbaum wie bei Claude: SIGTERM an die Prozessgruppe,
 * nach 1,5 Sekunden SIGKILL (Windows: taskkill /T /F). Alle Aufrufer starten
 * ihre Prozesse mit eigener Gruppe (startsOwnGroup in engines/platform.ts).
 */
export function terminateProcessTree(proc: TreeProc): void {
  stopTree(proc, CLAUDE_STOP_PLAN);
}
