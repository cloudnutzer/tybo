/**
 * Issue #326: deutsche Bezeichnungen für Werkzeuge im Fortschritt, für alle
 * Motoren, und ihr Weg durch die Terminal-Anzeige.
 */
import { describe, expect, test } from "bun:test";
import { OTHER_TOOL_PREFIX, TOOL_LABELS, toolLabel } from "../src/lib/engines/tool-labels";
import { progressLabel } from "../src/terminal/view";

describe("toolLabel", () => {
  test("Standard-Werkzeuge der Claude-CLI aus der Tabelle", () => {
    expect(toolLabel("Read")).toBe("Datei lesen");
    expect(toolLabel("Write")).toBe("Datei schreiben");
    expect(toolLabel("Edit")).toBe("Datei bearbeiten");
    expect(toolLabel("Glob")).toBe("Dateien suchen");
    expect(toolLabel("Grep")).toBe("Code durchsuchen");
    expect(toolLabel("Bash")).toBe("Befehl ausführen");
    expect(toolLabel("WebSearch")).toBe("Websuche");
    expect(toolLabel("WebFetch")).toBe("Seite abrufen");
    expect(toolLabel("Task")).toBe("Aufgabe weitergeben");
    expect(toolLabel("AskUserQuestion")).toBe("Rückfrage");
  });

  test("keine englischen Reste in der Tabelle", () => {
    for (const label of Object.values(TOOL_LABELS)) {
      expect(label).not.toMatch(/\b(Reading|Writing|Editing|Searching|Running|Fetching|Delegating|Asking|Using)\b/);
    }
  });

  test("MCP-Werkzeuge: Server mit Leerzeichen statt Bindestrichen", () => {
    expect(toolLabel("mcp__gmail__search_threads")).toBe("Werkzeug: gmail");
    expect(toolLabel("mcp__google-calendar__list_events")).toBe("Werkzeug: google calendar");
    expect(toolLabel("mcp____leer")).toBe("Werkzeug: MCP");
  });

  test("unbekannte Werkzeuge: Name mit Vorsilbe, auch Namen wie Objekt-Eigenschaften", () => {
    expect(toolLabel("NotebookEdit")).toBe("Werkzeug: NotebookEdit");
    expect(toolLabel("history_search")).toBe("Werkzeug: history_search");
    expect(toolLabel("toString")).toBe(`${OTHER_TOOL_PREFIX}toString`);
    expect(toolLabel("constructor")).toBe("Werkzeug: constructor");
  });
});

describe("Terminal-Anzeige", () => {
  test("deutsche Bezeichnungen werden zur Tätigkeit wie vorher die englischen", () => {
    expect(progressLabel("tool", toolLabel("Read"))).toBe("Liest eine Datei …");
    expect(progressLabel("tool", toolLabel("Bash"))).toBe("Führt einen Befehl aus …");
    expect(progressLabel("tool", toolLabel("WebSearch"))).toBe("Durchsucht das Web …");
    expect(progressLabel("tool", toolLabel("AskUserQuestion"))).toBe("Stellt eine Rückfrage …");
    expect(progressLabel("tool", toolLabel("mcp__notion__search"))).toBe("Nutzt notion …");
    expect(progressLabel("tool", toolLabel("NotebookEdit"))).toBe("Nutzt NotebookEdit …");
  });

  test("alte englische Bezeichnungen und rohe Namen gehen weiter", () => {
    expect(progressLabel("tool", "Reading file")).toBe("Liest eine Datei …");
    expect(progressLabel("tool", "Using gmail")).toBe("Nutzt gmail …");
    expect(progressLabel("tool", "Grep")).toBe("Durchsucht den Code …");
  });
});
