/**
 * Laufende Turns des Telefonhörers (Issue #257), prozessweit gezählt: bot.ts
 * rechnet sie über activeCallTurnCount in busyCount ein, damit ein Neustart
 * keinen laufenden Modellabruf abschneidet. Gezählt wird über ein Zeichen je
 * Turn statt über eine Zahl: das Ende eines Turns entfernt genau sein Zeichen,
 * auch doppelt aufgerufen oder nach resetCallTurnsForTests nur einmal bzw. gar
 * nicht. Ohne eigene Importe, damit tests/preload-env.ts die Datei laden kann.
 */

const turns = new Set<object>();

/** Zählt einen Turn; die Rückgabe beendet ihn (mehrfach aufrufbar) */
export function beginCallTurn(): () => void {
  const turn = {};
  turns.add(turn);
  return () => {
    turns.delete(turn);
  };
}

/** Laufende Telefonhörer-Turns (bot.ts zählt sie für den Neustart mit) */
export function activeCallTurnCount(): number {
  return turns.size;
}

/**
 * Nur für Tests: vergisst alle offenen Turns. tests/preload-env.ts ruft das vor
 * jedem Test auf, damit ein Test, der ein Gespräch offen lässt, die
 * Neustart-Tests einer später laufenden Datei nicht auf „busy“ stellt.
 */
export function resetCallTurnsForTests(): void {
  turns.clear();
}
