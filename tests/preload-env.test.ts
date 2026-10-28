/**
 * Prüflauf aus einem laufenden tybo heraus (PR #198, Prüfrunde 1): die vom
 * Bot vererbten Variablen fehlen in den Tests (tests/preload-env.ts).
 */

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { inheritedNames } from "./preload-env";

test("entfernt Namen aus .env.example, TYBO_*, WEB_*, CLAUDE*; PATH und HOME bleiben", () => {
  const example = "# Kommentar\nTELEGRAM_BOT_TOKEN=\n# MAX_AGENT_PROCESSES=3\n  # SESSION_MODE=resume\n";
  const env = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    MAX_AGENT_PROCESSES: "5",
    SESSION_MODE: "resume",
    TELEGRAM_BOT_TOKEN: "t",
    TYBO_CHAT_ID: "1",
    WEB_ENABLED: "true",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
  };
  expect(inheritedNames(example, env).sort()).toEqual(
    ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "MAX_AGENT_PROCESSES", "SESSION_MODE", "TELEGRAM_BOT_TOKEN", "TYBO_CHAT_ID", "WEB_ENABLED"].sort(),
  );
});

test("im Testlauf ist nichts davon gesetzt, das Skript test lädt das Preload", async () => {
  const example = await readFile(join(import.meta.dir, "..", ".env.example"), "utf8");
  expect(example).toContain("MAX_AGENT_PROCESSES");
  expect(process.env.MAX_AGENT_PROCESSES).toBeUndefined();
  expect(inheritedNames(example, process.env)).toEqual([]);
  const pkg = JSON.parse(await readFile(join(import.meta.dir, "..", "package.json"), "utf8"));
  expect(pkg.scripts.test).toContain("--preload ./tests/preload-env.ts");
});
