/**
 * Versionsnummern für Stände, die die WebUI anzeigt (Einstellungen und
 * Anweisungen, PR #43 zu Issue #38).
 *
 * Die Nummer gehört zum Inhalt, nicht zum Weg, auf dem er sich geändert hat:
 * Sie steigt genau dann, wenn der Server beim Lesen einen anderen Stand
 * sieht als beim letzten Mal, gleich ob über die WebUI gespeichert, per
 * /agent in Telegram, in einem anderen Browser oder von Hand in der Datei.
 * Gleiche Nummer heißt also gleicher Inhalt, höhere Nummer heißt später
 * gelesen. Voraussetzung: Die Aufrufer lesen und stempeln in der Reihenfolge,
 * in der die Stände entstehen (Schreibkette oder synchrones Lesen).
 *
 * boot ist der Startzeitpunkt des Prozesses in Millisekunden. Ein Stand aus
 * einem späteren Prozess ist neuer, einer aus einem früheren älter; so ordnet
 * der Browser auch Antworten über einen Neustart hinweg. Die Regel dazu
 * steht als isNotOlder in src/web/public/settings.js.
 */

export interface Revision {
  boot: number;
  seq: number;
}

export interface RevisionClock {
  /** Version für den Stand content unter key (z.B. "settings" oder ein Agentenname) */
  stamp(key: string, content: unknown): Revision;
}

export function createRevisionClock(boot: number = Date.now()): RevisionClock {
  let seq = 0;
  const seen = new Map<string, { text: string; seq: number }>();
  return {
    stamp(key, content) {
      const text = JSON.stringify(content) ?? "";
      const last = seen.get(key);
      if (last && last.text === text) return { boot, seq: last.seq };
      seq++;
      seen.set(key, { text, seq });
      return { boot, seq };
    },
  };
}
