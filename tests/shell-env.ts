/**
 * Hilfe für Tests, deren Erwartung von Variablen abhängt, die eine Shell mit
 * laufendem tybo vererbt (etwa CLAUDE_EFFORT=medium, WEB_*). Die Preload-Datei
 * (tests/preload-env.ts) entfernt sie zwar vor jeder Testdatei; ein Test, der
 * davon abhängt, sorgt aber selbst dafür: so besteht er auch mit `bun test`
 * ohne Preload oder wenn ein anderer Test den Wert setzt.
 *
 * Vor jedem Test der Datei gelöscht bzw. auf den angegebenen Wert gesetzt,
 * danach wiederhergestellt.
 */
import { afterEach, beforeEach } from "bun:test";

export function isolateShellEnv(values: Record<string, string | undefined>): void {
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const [name, value] of Object.entries(values)) {
      saved.set(name, process.env[name]);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved.clear();
  });
}
