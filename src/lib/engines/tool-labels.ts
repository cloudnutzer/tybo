/**
 * Deutsche Bezeichnungen für Werkzeuge im Fortschritt (Issue #326), für alle
 * Motoren: Codex und OpenCode übersetzen ihre Werkzeuge vorher in die Namen
 * der Claude-CLI. Die Texte erscheinen so in Telegram; WebUI und Terminal
 * reichen sie unverändert bzw. als Tätigkeit weiter.
 *
 * Nur die Anzeige ist deutsch: die rohen Namen in tools und steps eines
 * Ergebnisses bleiben, wie die CLI sie meldet.
 */

/** Bezeichnung je Werkzeugname der Claude-CLI */
export const TOOL_LABELS: Readonly<Record<string, string>> = {
  Read: "Datei lesen",
  Write: "Datei schreiben",
  Edit: "Datei bearbeiten",
  Glob: "Dateien suchen",
  Grep: "Code durchsuchen",
  Bash: "Befehl ausführen",
  WebSearch: "Websuche",
  WebFetch: "Seite abrufen",
  Task: "Aufgabe weitergeben",
  AskUserQuestion: "Rückfrage",
};

/** Vorsilbe für MCP-Werkzeuge und Werkzeuge ohne eigene Bezeichnung */
export const OTHER_TOOL_PREFIX = "Werkzeug: ";

/**
 * Bezeichnung für den Fortschritt: aus der Tabelle, bei MCP-Werkzeugen
 * (mcp__server__aktion) der Server mit Leerzeichen statt Bindestrichen,
 * sonst der Name selbst, jeweils mit „Werkzeug: " davor.
 */
export function toolLabel(name: string): string {
  if (Object.hasOwn(TOOL_LABELS, name)) return TOOL_LABELS[name];
  if (name.startsWith("mcp__")) {
    const server = name.split("__")[1] || "MCP";
    return OTHER_TOOL_PREFIX + server.replaceAll("-", " ");
  }
  return OTHER_TOOL_PREFIX + name;
}
