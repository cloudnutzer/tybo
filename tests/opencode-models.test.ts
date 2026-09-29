/**
 * `opencode models` für die Einstellungsseite (Issue #129): Befehl mit
 * OPENCODE_PATH und gefilterter Umgebung, ohne Shell, Zeitlimit 10 s mit
 * Beenden des Prozesses, nur feste Fehlertexte. Prozessstart, Uhr und
 * Signale sind eine Attrappe (tests/opencode-fixture.ts); kein echtes opencode.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import {
  listOpenCodeModels,
  OPENCODE_KILL_GRACE_MS,
  OPENCODE_MODELS_MAX_OUTPUT,
  OPENCODE_MODELS_TEXT,
  OPENCODE_MODELS_TIMEOUT_MS,
  parseOpenCodeModels,
} from "../src/lib/engines/opencode";
import { setSettingsPath } from "../src/lib/settings";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { until } from "./codex-fixture";
import { installOpenCodeFake, type OpenCodeFake } from "./opencode-fixture";

let fake: OpenCodeFake;
const saved: Record<string, string | undefined> = {};
const VARS = ["OPENCODE_PATH", "OPENROUTER_API_KEY", "TYBO_SUBPROCESS_ENV_ALLOW", "TELEGRAM_BOT_TOKEN"];

beforeAll(() => {
  setMcpReaderForTests(() => new Set());
  setSettingsPath(join(tmpdir(), "tybo-opencode-models-keine-einstellungen.json"));
});
afterAll(() => {
  setMcpReaderForTests(null);
  setSettingsPath();
});
beforeEach(() => {
  for (const k of VARS) saved[k] = process.env[k];
  fake = installOpenCodeFake();
});
afterEach(() => {
  fake.restore();
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/**
 * Endloser Strom wie ein Prozess, der ohne Ende schreibt: je Abruf ein Stück,
 * mit einer Pause dazwischen (echter Timer), damit der Test weiterläuft.
 * Zählt, wie viel gelesen wurde und ob das Lesen abgebrochen wurde.
 */
function endless(line = "openai/gpt-5.5\n", chunkBytes = 64 * 1024) {
  const chunk = new TextEncoder().encode(line.repeat(Math.ceil(chunkBytes / line.length)));
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(c) {
        await new Promise((r) => setTimeout(r, 0));
        if (state.cancelled) return;
        state.pulled += chunk.byteLength;
        c.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 }
  );
  return { stream, state, chunkBytes: chunk.byteLength };
}

describe("parseOpenCodeModels", () => {
  test("je Zeile <anbieter>/<modell>, weitere Schrägstriche bleiben, Rest fällt weg", () => {
    const out = [
      "openai/gpt-5.5",
      "  openrouter/anthropic/claude-opus-5.5  ",
      "\x1b[32mopenrouter/openai/gpt-5.5\x1b[0m",
      "",
      "Hinweis: 3 Anbieter",
      "openai/gpt-5.5",
      "--model/x",
      "ollama/qwen3:8b",
      "a b/c",
      `x/${"y".repeat(250)}`,
    ].join("\n");
    expect(parseOpenCodeModels(out)).toEqual(["openai/gpt-5.5", "openrouter/anthropic/claude-opus-5.5", "openrouter/openai/gpt-5.5", "ollama/qwen3:8b"]);
  });
});

describe("listOpenCodeModels", () => {
  test("Befehl opencode models ohne Shell, gefilterte Umgebung, Zeilen der Attrappe", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test-nicht-weitergeben";
    process.env.TELEGRAM_BOT_TOKEN = "123:geheim";
    delete process.env.TYBO_SUBPROCESS_ENV_ALLOW;
    fake.next({ stdout: "openai/gpt-5.5\nopenrouter/anthropic/claude-opus-5.5\n" });
    expect(await listOpenCodeModels()).toEqual({ ok: true, models: ["openai/gpt-5.5", "openrouter/anthropic/claude-opus-5.5"] });
    const call = fake.spawns.at(-1)!;
    expect(call.cmd).toEqual(["opencode", "models"]);
    expect(call.detached).toBe(process.platform !== "win32");
    expect(call.env?.OPENROUTER_API_KEY).toBeUndefined();
    expect(call.env?.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(call.env?.TYBO_SUBPROCESS).toBe("1");
  });

  test("OPENCODE_PATH ersetzt opencode; Anbieter-Schlüssel nur über TYBO_SUBPROCESS_ENV_ALLOW", async () => {
    process.env.OPENCODE_PATH = "/opt/oc/bin/opencode";
    process.env.OPENROUTER_API_KEY = "sk-or-v1-freigegeben";
    process.env.TYBO_SUBPROCESS_ENV_ALLOW = "OPENROUTER_API_KEY";
    fake.next({ stdout: "openrouter/openai/gpt-5.5\n" });
    await listOpenCodeModels();
    const call = fake.spawns.at(-1)!;
    expect(call.cmd).toEqual(["/opt/oc/bin/opencode", "models"]);
    expect(call.env?.OPENROUTER_API_KEY).toBe("sk-or-v1-freigegeben");
  });

  test("nicht installiert: Start wirft oder Exit 127, fester Text", async () => {
    fake.next({ throws: "ENOENT: no such file or directory, posix_spawn '/Users/x/bin/opencode'" });
    expect(await listOpenCodeModels()).toEqual({ ok: false, error: OPENCODE_MODELS_TEXT.notInstalled });
    fake.next({ exitCode: 127, stderr: "opencode: command not found" });
    expect(await listOpenCodeModels()).toEqual({ ok: false, error: OPENCODE_MODELS_TEXT.notInstalled });
  });

  test("Fehler-Exit: fester Text, stderr kommt nirgends an", async () => {
    fake.next({ exitCode: 1, stderr: "Error: token sk-or-v1-abc ungültig in /Users/x/.local/share/opencode/auth.json" });
    const r = await listOpenCodeModels();
    expect(r).toEqual({ ok: false, error: OPENCODE_MODELS_TEXT.failed });
    expect(JSON.stringify(r)).not.toContain("sk-or");
  });

  test("keine Modelle in der Ausgabe: fester Text", async () => {
    fake.next({ stdout: "Keine Anbieter angemeldet\n" });
    expect(await listOpenCodeModels()).toEqual({ ok: false, error: OPENCODE_MODELS_TEXT.empty });
  });

  test("hängt: nach 10 s Zeitlimit, Prozess wird beendet (SIGINT, dann SIGKILL)", async () => {
    fake.next({ hang: true, ignoreSigint: true });
    const pending = listOpenCodeModels();
    await until(() => fake.spawns.length === 1);
    fake.advance(OPENCODE_MODELS_TIMEOUT_MS - 1);
    expect(fake.signals).toEqual([]);
    fake.advance(1);
    expect(await pending).toEqual({ ok: false, error: OPENCODE_MODELS_TEXT.timeout });
    expect(fake.signals).toEqual(["SIGINT"]);
    fake.advance(OPENCODE_KILL_GRACE_MS);
    expect(fake.signals).toEqual(["SIGINT", "SIGKILL"]);
  });
});

describe("listOpenCodeModels: Ausgabe begrenzt (Speicher des Bot-Prozesses)", () => {
  test("übergroße Ausgabe auf einmal: fester Text, Prozess wird beendet, keine Modelle", async () => {
    const line = "openrouter/anthropic/claude-opus-5.5\n";
    fake.next({ stdout: line.repeat(Math.ceil((OPENCODE_MODELS_MAX_OUTPUT + 1) / line.length)), hang: true });
    const r = await listOpenCodeModels();
    expect(r).toEqual({ ok: false, error: OPENCODE_MODELS_TEXT.tooLarge });
    expect(fake.signals).toEqual(["SIGINT"]);
  });

  test("genau an der Grenze: wird noch gelesen", async () => {
    const line = "openai/gpt-5.5\n";
    const out = line.repeat(Math.floor(OPENCODE_MODELS_MAX_OUTPUT / line.length));
    expect(out.length).toBeLessThanOrEqual(OPENCODE_MODELS_MAX_OUTPUT);
    fake.next({ stdout: out });
    expect(await listOpenCodeModels()).toEqual({ ok: true, models: ["openai/gpt-5.5"] });
  });

  test("fortlaufende Ausgabe auf stdout: Lesen endet kurz nach der Grenze, Prozess wird beendet (SIGINT, dann SIGKILL)", async () => {
    const src = endless();
    fake.next({ stdoutStream: src.stream, hang: true, ignoreSigint: true });
    const r = await listOpenCodeModels();
    expect(r).toEqual({ ok: false, error: OPENCODE_MODELS_TEXT.tooLarge });
    // Gelesen wird höchstens ein Stück über die Grenze hinaus, dann ist Schluss
    expect(src.state.pulled).toBeGreaterThan(OPENCODE_MODELS_MAX_OUTPUT);
    expect(src.state.pulled).toBeLessThanOrEqual(OPENCODE_MODELS_MAX_OUTPUT + src.chunkBytes);
    expect(src.state.cancelled).toBe(true);
    const pulled = src.state.pulled;
    await new Promise((r) => setTimeout(r, 20));
    expect(src.state.pulled).toBe(pulled);
    expect(fake.signals).toEqual(["SIGINT"]);
    fake.advance(OPENCODE_KILL_GRACE_MS);
    expect(fake.signals).toEqual(["SIGINT", "SIGKILL"]);
  });

  test("fortlaufende Ausgabe auf stderr: wird verworfen, nicht gesammelt; nach dem Ende hört das Lesen auf", async () => {
    const err = endless("Warnung: sk-or-v1-geheim\n");
    fake.next({ stdout: "openai/gpt-5.5\n", stderrStream: err.stream, hang: true });
    const pending = listOpenCodeModels();
    // Weit mehr als die stdout-Grenze auf stderr: kein Abbruch, kein Fehler
    await until(() => err.state.pulled > 3 * OPENCODE_MODELS_MAX_OUTPUT, 10_000);
    fake.finish(0);
    const r = await pending;
    expect(r).toEqual({ ok: true, models: ["openai/gpt-5.5"] });
    expect(JSON.stringify(r)).not.toContain("sk-or");
    expect(err.state.cancelled).toBe(true);
    const pulled = err.state.pulled;
    await new Promise((r) => setTimeout(r, 20));
    expect(err.state.pulled).toBe(pulled);
  });

  test("hängt mit fortlaufendem stderr: Zeitlimit greift, beide Ströme werden abgebrochen", async () => {
    const out = endless("openai/gpt-5.5\n", 16);
    const err = endless("x\n");
    fake.next({ stdoutStream: out.stream, stderrStream: err.stream, hang: true });
    const pending = listOpenCodeModels();
    await until(() => err.state.pulled > 0 && out.state.pulled > 0);
    fake.advance(OPENCODE_MODELS_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, error: OPENCODE_MODELS_TEXT.timeout });
    expect(out.state.cancelled).toBe(true);
    expect(err.state.cancelled).toBe(true);
    expect(fake.signals).toEqual(["SIGINT"]);
  });
});
