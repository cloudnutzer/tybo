/** Echte CLI-Prozesse, nur in temporären Ordnern; kein Bot und kein Netz. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { formatSwitchTime } from "../src/lib/engine-switch";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = join(ROOT, "scripts", "engine-usage.ts");
const script = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts.limits as string;
let directory: string;
let usageFile: string;
let stateFile: string;
const iso = (time: number) => new Date(time).toISOString();

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "engine-usage-process-"));
  usageFile = join(directory, "data", "engine-usage.json");
  stateFile = join(directory, "data", "engine-switch.json");
  // Derselbe Skripteintrag, nur sein Dateipfad zeigt auf die getestete Fassung.
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    scripts: { limits: script.replace("scripts/engine-usage.ts", `'${ENTRY.replaceAll("'", "'\\''")}'`) },
  }));
  mkdirSync(join(directory, "config"));
  writeFileSync(join(directory, "config", "settings.json"), JSON.stringify({
    engine: { backups: [{ engine: "codex" }], auto: { enabled: true, threshold: 95, returnBelow: 80 } },
  }));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function run(args: string[], stdin?: string) {
  const child = Bun.spawnSync([process.execPath, "run", "--cwd", directory, "limits", ...args], {
    cwd: directory,
    env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, TZ: "UTC" },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe", stderr: "pipe", timeout: 15_000,
  });
  expect(child.signalCode ?? null).toBeNull();
  return { code: child.exitCode, out: child.stdout.toString(), err: child.stderr.toString() };
}
const setArgs = (percent = "96") => ["set", "--engine", "claude", "--window", "weekly_scoped:fable", "--percent", percent];
function snapshot() {
  return Object.fromEntries(readdirSync(directory, { recursive: true }).map(String).sort().map(name => {
    const file = join(directory, name);
    const stat = statSync(file);
    return [name, stat.isFile() ? { text: readFileSync(file, "utf8"), mtime: stat.mtimeMs, ino: stat.ino } : "Ordner"];
  }));
}
const readState = () => JSON.parse(readFileSync(stateFile, "utf8"));

test("Paketbefehl lädt keine .env; show legt nichts an, set nutzt nur die normalen Dateien", () => {
  expect(script).toBe("bun --no-env-file scripts/engine-usage.ts");
  const trap = join(directory, "nicht-lesen.json");
  const trapState = join(directory, "nicht-schreiben.json");
  writeFileSync(trap, JSON.stringify({ version: 1, engines: { claude: { windows: [
    { id: "weekly_all", percent: 23, measuredAt: "2026-01-01T00:00:00Z", source: "extern" },
  ] } } }));
  writeFileSync(join(directory, ".env"), `ENGINE_USAGE_FILE_PATH=${trap}\nENGINE_SWITCH_FILE_PATH=${trapState}\nUSER_TIMEZONE=Pacific/Honolulu\n`);
  const before = snapshot();
  const shown = run(["show"]);
  expect(shown.code).toBe(0);
  expect(JSON.parse(shown.out)).toEqual({ claude: [], codex: [], opencode: [], api: [] });
  expect(shown.err).not.toContain("[EngineUsage]");
  expect(snapshot()).toEqual(before);
  const until = iso(Date.now() + 3_600_000);
  const result = run([...setArgs(), "--resets-at", until]);
  expect(result.code).toBe(0);
  expect(result.out).toBe(`claude weekly_scoped:fable: 96 %, übernommen\nSperre bis ${formatSwitchTime(until, "UTC")}\n`);
  expect(readState().blocks[0]).toMatchObject({ window: "weekly_scoped:fable", cause: "threshold", until, resetKnown: true });
  expect(JSON.parse(readFileSync(usageFile, "utf8")).engines.claude.windows[0].source).toBe("extern");
  expect(readFileSync(trap, "utf8")).toBe((before["nicht-lesen.json"] as { text: string }).text);
  expect(existsSync(trapState)).toBe(false);
  expect(readdirSync(join(directory, "data")).sort()).toEqual(["engine-switch.json", "engine-usage.json"]);
});

test("JSON über echte Standardeingabe, mehrere Codex-Fenster; show ist einschließlich Dateimetadaten nur lesend", () => {
  const measuredAt = iso(Date.now());
  const windows = [
    { id: "weekly_all", percent: 50, measuredAt },
    { id: "window_1440", percent: 96, measuredAt },
  ];
  const result = run(["set", "--stdin"], JSON.stringify({ engine: "codex", windows }));
  expect(result.code).toBe(0);
  expect(result.out).toContain("codex weekly_all: 50 %, übernommen\ncodex window_1440: 96 %, übernommen\n");
  expect(result.out).toContain("(60 Minuten ab der Messung, Reset-Zeit unbekannt)");
  expect(readState().blocks[0]).toMatchObject({ engine: "codex", window: "window_1440", resetKnown: false });
  const before = snapshot();
  const shown = run(["show"]);
  expect(shown.code).toBe(0);
  expect(JSON.parse(shown.out).codex).toEqual(windows.map(w => ({ ...w, source: "extern", state: "known" })));
  expect(snapshot()).toEqual(before);
});

test("echte Exit-Codes: 150 Prozent und kaputtes JSON scheitern ohne Dateiänderung", () => {
  expect(run(setArgs("10")).code).toBe(0);
  const before = snapshot();
  const invalid = run(setArgs("150"));
  expect(invalid.code).toBe(1);
  expect(invalid.err).toContain("percent");
  expect(invalid.out).toBe("");
  expect(snapshot()).toEqual(before);
  const json = run(["set", "--stdin"], "{kaputt");
  expect(json.code).toBe(1);
  expect(json.err).toContain("JSON");
  expect(snapshot()).toEqual(before);
});

test("echter Prozess mit belegter Zustandsdatei wartet, endet mit 0 und behält den Messwert", () => {
  mkdirSync(join(directory, "data"));
  const state = JSON.stringify({ version: 1, blocks: [], counters: [], future: "bleibt" });
  writeFileSync(stateFile, state);
  writeFileSync(`${stateFile}.lock`, JSON.stringify({ pid: process.pid, token: "test" }));
  const started = performance.now();
  const result = run(setArgs());
  expect(performance.now() - started).toBeGreaterThanOrEqual(3_900);
  expect(result.code).toBe(0);
  expect(result.out).toBe("claude weekly_scoped:fable: 96 %, übernommen\n"
    + "Messwert gespeichert. Der Sperrzustand ließ sich gerade nicht schreiben; der Bot wertet den Messwert mit der nächsten Nachricht aus.\n");
  expect(readFileSync(stateFile, "utf8")).toBe(state);
  expect(JSON.parse(readFileSync(usageFile, "utf8")).engines.claude.windows[0]).toMatchObject({ percent: 96, source: "extern" });
});
