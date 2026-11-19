/** Ausschließlich erfundene Notizen unter dem übergebenen Temp-Heimatverzeichnis. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeNotesDir, claudeNotesSection } from "../src/lib/engines/claude-notes";

export function notesFixture(home: string, projectRoot = "/test-projekt") {
  const dir = claudeNotesDir(projectRoot, home);
  const index = "Notizmarker-664: Für Beispiele immer blaue Tassen verwenden.";
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "MEMORY.md"), index);
  return { dir, index, section: claudeNotesSection({ projectRoot, home, secrets: [] }) };
}
