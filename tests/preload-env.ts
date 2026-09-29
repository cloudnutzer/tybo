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
 * TYBO_*, WEB_* und die Variablen der Claude-CLI (CLAUDECODE, CLAUDE_*).
 * PATH, HOME und die übrige Umgebung bleiben.
 *
 * Außerdem gilt für die Grenze gleichzeitiger Aufträge ein fester
 * Arbeitsspeicher von 8 GiB (Issue #208): ohne MAX_AGENT_PROCESSES also
 * 3 Plätze wie in der CI, auch auf einem Raspberry Pi mit 2 oder 4 GB.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GIB } from "../src/lib/agent-capacity";
import { resetAgentCapacity } from "../src/lib/execution-context";

/** Arbeitsspeicher, mit dem die Tests rechnen (3 Plätze) */
export const TEST_TOTALMEM = () => 8 * GIB;

const PREFIXES = ["TYBO_", "WEB_", "CLAUDE_"];
const EXTRA = ["CLAUDECODE"];

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
resetAgentCapacity({ totalmem: TEST_TOTALMEM });
