/**
 * Agenten-Katalog (Issue #49) auf temporäre Dateien umlenken: Tests, die über
 * getAgentConfig, die Modell-/Effort-Resolver oder botSettings den Katalog
 * lesen, sollen nie die echte config/agents.json oder config/topics.json sehen.
 * Aufruf auf oberster Ebene einer Testdatei; jede Probe beginnt mit leerem Katalog.
 */
import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setAgentCatalogPaths } from "../src/agents/catalog";

export function isolateAgentCatalog(): { file: () => string } {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tybo-catalog-"));
    setAgentCatalogPaths({
      file: join(dir, "agents.json"),
      backupDir: join(dir, "backups"),
      topicsFile: join(dir, "topics.json"),
    });
  });
  afterEach(() => {
    setAgentCatalogPaths();
    rmSync(dir, { recursive: true, force: true });
  });
  return { file: () => join(dir, "agents.json") };
}
