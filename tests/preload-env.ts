/**
 * Läuft vor jeder Testdatei (bun test --preload, Skript "test" in package.json): entfernt
 * Variablen, die ein laufender tybo an seine Unterprozesse vererbt. Startet
 * jemand `bun run check` aus einem Bot-Gespräch heraus, stehen sonst etwa
 * MAX_AGENT_PROCESSES=5, WEB_ENABLED oder TYBO_CHAT_ID in der Umgebung; die
 * Warteschlangen- und Abbruchtests rechnen dann mit fünf statt drei Plätzen,
 * scheitern und hängen bis zum Zeitlimit. Die CI hat keine dieser Variablen,
 * nach dem Entfernen prüft der lokale Lauf also dasselbe wie die CI.
 *
 * Entfernt werden alle Namen aus .env.example (auch auskommentierte), dazu
 * TYBO_*, WEB_*, die Variablen der Claude-CLI (CLAUDECODE, CLAUDE_*) und
 * die entfallenen CONVEX_* und USE_AGENT_SDK.
 * PATH, HOME und die übrige Umgebung bleiben.
 *
 * Außerdem gilt für die Grenze gleichzeitiger Aufträge ein fester
 * Arbeitsspeicher von 8 GiB (Issue #208): ohne MAX_AGENT_PROCESSES also
 * 3 Plätze wie in der CI, auch auf einem Raspberry Pi mit 2 oder 4 GB.
 *
 * MEMORY_FILE_PATH zeigt, wenn nicht gesetzt, auf eine frische Datei im
 * Temp-Ordner (Issue #316): ohne Datenbank schreibt das Gedächtnis sonst
 * memory.json.sqlite in den Arbeitsordner. Ebenso BUDGET_DB_PATH (Issue
 * #346): jeder Motorlauf wird gebucht, auch in Tests mit Motor-Attrappen,
 * sonst landete das in data/api-budget.sqlite des Arbeitsordners.
 *
 * Vor jedem Test ist der Merker fürs Telefongespräch leer (Issue #260): ein
 * Test mit dem echten Anschluss (createBotCall) hinterließe sonst einen
 * Hinweis, den ein späterer Turn-Test im selben Prozess mitnähme.
 *
 * Ebenso zählt vor jedem Test kein Telefonhörer-Turn als laufend (#332): bun
 * führt alle Testdateien in einem Prozess aus, in einer Reihenfolge, die vom
 * Dateisystem abhängt (in der CI eine andere als lokal). Ein offen gelassenes
 * Gespräch einer früheren Datei stellte sonst die Neustart-Tests auf „busy“.
 * Aus demselben Grund wählt jeder Test den Speicher neu (resetStore,
 * resetSupabaseClient): die Wahl gilt sonst für den ganzen Prozess, und eine
 * frühere Datei ohne SUPABASE_URL ließ spätere Supabase-Tests am Platzhalter
 * scheitern. Gewählt wird erst beim ersten getStore() im Test, mit dessen
 * Umgebung.
 *
 * Ebenso gilt vor jedem Test das Beenden als nicht begonnen (Issue #561):
 * abortAllEngineCalls sperrt danach jede Motor-Prüfung, und viele Dateien
 * rufen es zum Aufräumen auf.
 *
 * Und Claude gilt vor jedem Test als nicht geprüft (Issue #566): ein Test,
 * der „Claude fehlt“ setzt, schaltete sonst später Nebenaufgaben ab.
 */

import { beforeEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIB } from "../src/lib/agent-capacity";
import { resetCallRecapsForTests } from "../src/lib/call-recap";
import { resetClaudeAvailabilityForTests } from "../src/lib/claude-availability";
import { resetEngineShutdownForTests } from "../src/lib/engines/calls";
import { resetCodexMcpLogForTests } from "../src/lib/engines/codex";
import { setCodexMcpInputsForTests, setCodexMcpReaderForTests } from "../src/lib/engines/codex-mcp";
import { setToolParityReadersForTests } from "../src/lib/engines/tool-parity";
import { resetAgentCapacity } from "../src/lib/execution-context";
import { setClaudeNotesSourceForTests } from "../src/lib/prompt-builder";
import { resetStore } from "../src/lib/store";
import { resetSupabaseClient } from "../src/lib/supabase";
import { resetCallTurnsForTests } from "../src/web/call-turns";

/** Arbeitsspeicher, mit dem die Tests rechnen (3 Plätze) */
export const TEST_TOTALMEM = () => 8 * GIB;

// CONVEX_* und USE_AGENT_SDK stehen seit Issue #380 nicht mehr in .env.example,
// eine alte .env kann sie aber noch vererben
const PREFIXES = ["TYBO_", "WEB_", "CLAUDE_", "CONVEX_"];
const EXTRA = ["CLAUDECODE", "USE_AGENT_SDK"];

export function inheritedNames(example: string, env: Record<string, string | undefined>): string[] {
  const names = new Set<string>(EXTRA);
  for (const line of example.split("\n")) {
    const m = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (m) names.add(m[1]);
  }
  return Object.keys(env).filter(name => names.has(name) || PREFIXES.some(p => name.startsWith(p)));
}

let example = "";
try {
  example = readFileSync(join(import.meta.dir, "..", ".env.example"), "utf8");
} catch {
  // Ohne .env.example bleiben nur die Präfixe
}
for (const name of inheritedNames(example, process.env)) delete process.env[name];
// Gedächtnis ohne Datenbank (Issue #316) nie im Arbeitsordner: eine Datei je Testlauf
if (!process.env.MEMORY_FILE_PATH) {
  process.env.MEMORY_FILE_PATH = join(mkdtempSync(join(tmpdir(), "tybo-test-memory-")), "memory.json");
}
// Kosten-Ablage (Issue #346) ebenso nie im Arbeitsordner
if (!process.env.BUDGET_DB_PATH) {
  process.env.BUDGET_DB_PATH = join(mkdtempSync(join(tmpdir(), "tybo-test-spend-")), "api-budget.sqlite");
}
// Limit-Messwerte (Issue #651) auch bei einem geerbten Pfad nie im Arbeitsordner.
process.env.ENGINE_USAGE_FILE_PATH = join(mkdtempSync(join(tmpdir(), "tybo-test-usage-")), "engine-usage.json");
// Sperren (Issue #669): auch nach setSwitchStateFileForTests(null) nie den echten Zustand lesen.
const switchStateDir = mkdtempSync(join(tmpdir(), "tybo-test-switch-"));
let switchTestNo = 0;
process.env.ENGINE_SWITCH_FILE_PATH = join(switchStateDir, "engine-switch-0.json");
// Zeitzone immer gesetzt, nie gelöscht: Unter bun 1.3 (CI) bleibt die
// Zeitzone nach einem `delete process.env.TZ` für den Rest des Prozesses
// stehen, ein späteres Setzen wirkt nicht mehr. Tests, die TZ sichern und
// zurückstellen (store-switch, Zeitstempel im Verlauf), löschten sie sonst
// bei leerem TZ, und je nach Reihenfolge der Dateien sahen spätere Tests mit
// Europe/Berlin weiter UTC. UTC entspricht der Zeitzone der CI.
if (!process.env.TZ) process.env.TZ = "UTC";
resetAgentCapacity({ totalmem: TEST_TOTALMEM });
beforeEach(() => {
  // Ein frischer Standard je Test; ausdrückliche setSwitchStateFileForTests-Pfade gehen weiter vor.
  process.env.ENGINE_SWITCH_FILE_PATH = join(switchStateDir, `engine-switch-${++switchTestNo}.json`);
  // Auch Codex-Turns mit nur teilweise ersetzten Prompt-Quellen bleiben vom echten ~/.claude fern.
  setClaudeNotesSourceForTests(() => "");
  // MCP-Anbindung: weder private MCP-Dateien noch Credentials oder .env lesen.
  // Jeder Test beginnt leer; nur gezielte MCP-Tests setzen eigene Quellen ein.
  const missingFile = () => { throw Object.assign(new Error("Testdatei fehlt"), { code: "ENOENT" }); };
  setCodexMcpReaderForTests(missingFile);
  // Der Werkzeugbestand ersetzt auch seine Plan-Umgebung, ohne den globalen MCP-Leser zu ändern (Issue #665).
  setToolParityReadersForTests({ text: missingFile, children: missingFile, stat: missingFile,
    inspectSkills: missingFile, planEnv: () => ({}) });
  setCodexMcpInputsForTests({ parentEnv: () => ({}), projectRoot: () => "/test-projekt",
    settings: () => ({}), lookup: () => undefined, secrets: () => [] });
  resetCodexMcpLogForTests();
  resetEngineShutdownForTests();
  // Issue #566: „Claude fehlt“ aus einem Test schaltet sonst in späteren Dateien Nebenaufgaben ab
  resetClaudeAvailabilityForTests();
  resetCallRecapsForTests();
  resetCallTurnsForTests();
  resetStore();
  resetSupabaseClient();
});
