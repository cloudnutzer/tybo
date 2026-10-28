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
 */

import { beforeEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIB } from "../src/lib/agent-capacity";
import { resetCallRecapsForTests } from "../src/lib/call-recap";
import { resetAgentCapacity } from "../src/lib/execution-context";
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
resetAgentCapacity({ totalmem: TEST_TOTALMEM });
beforeEach(() => {
  resetCallRecapsForTests();
  resetCallTurnsForTests();
  resetStore();
  resetSupabaseClient();
});
