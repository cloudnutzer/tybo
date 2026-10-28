/**
 * Sichert process.env vollständig und stellt sie wieder her (#332). bun führt
 * alle Testdateien in einem Prozess aus; was ein Test oder der Code unter Test
 * in der Umgebung stehen lässt, sieht jede später laufende Datei. Eine Liste
 * einzelner Namen übersieht Nebenwirkungen fremder Bibliotheken: das Agent SDK
 * setzt beim Start CLAUDE_AGENT_SDK_VERSION, und tests/preload-env.test.ts
 * schlug in der CI fehl, sobald die Reihenfolge der Dateien sich änderte.
 */

type Env = Record<string, string | undefined>;

/** Merkt sich die Umgebung; die Rückgabe stellt genau diesen Stand wieder her */
export function snapshotEnv(env: Env = process.env): () => void {
  const saved = { ...env };
  return () => {
    for (const name of Object.keys(env)) {
      if (!(name in saved)) delete env[name];
    }
    for (const [name, value] of Object.entries(saved)) {
      if (env[name] !== value) env[name] = value;
    }
  };
}
