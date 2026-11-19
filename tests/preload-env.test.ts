/**
 * Prüflauf aus einem laufenden tybo heraus (PR #198, Prüfrunde 1): die vom
 * Bot vererbten Variablen fehlen in den Tests (tests/preload-env.ts).
 */

import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { inheritedNames } from "./preload-env";
import { createToolParitySnapshot } from "../src/lib/engines/tool-parity";
import { ENGINE_IDS } from "../src/lib/engines/types";
import * as settings from "../src/lib/settings";
import { readSwitchState, setSwitchStateFileForTests } from "../src/lib/engine-switch-state";
import { tmpdir } from "node:os";

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

test("Werkzeugbestand bleibt mit Standardeingaben von echten Dateien und Verzeichnissen fern", () => {
  const settingsReader = spyOn(settings, "getSettings").mockReturnValue({});
  const readers = ["readFileSync", "readdirSync", "statSync", "lstatSync", "openSync", "readlinkSync"] as const;
  const spies = readers.map(name => spyOn(fs, name).mockImplementation(() => {
    throw Object.assign(new Error("Echter Dateizugriff im Test"), { code: "ENOENT" });
  }));
  try {
    const snapshot = createToolParitySnapshot();
    for (const engine of ENGINE_IDS) {
      expect(snapshot.inventory(engine).mcp).toEqual([]);
      expect(snapshot.inventory(engine).skills).toEqual([]);
      expect(snapshot.gaps(engine).plugins).toBeNull();
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally {
    for (const spy of spies) spy.mockRestore();
    settingsReader.mockRestore();
  }
});

test("Standard der Wechselregel bleibt auch nach Rückstellen im leeren Temp-Ordner", () => {
  setSwitchStateFileForTests(null);
  expect(process.env.ENGINE_SWITCH_FILE_PATH).toStartWith(join(tmpdir(), "tybo-test-switch-"));
  const stat = spyOn(fs, "statSync");
  try {
    expect(readSwitchState()).toEqual({ version: 1, blocks: [], counters: [] });
    expect(stat).toHaveBeenCalledWith(process.env.ENGINE_SWITCH_FILE_PATH);
  } finally {
    stat.mockRestore();
  }
});
