/**
 * Issue #568 (mit #567): Die Zeile „Motor“ des Nachtchecks prüft den
 * eingestellten Standard-Motor. Motor-Prüfung und Probeaufruf sind
 * Attrappen; kein Test startet claude, codex oder opencode.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plannedChecks, probeEnvFor, realEngineLineDeps, runCheck, type MaintenanceCheckDeps } from "../src/health-check";
import { checkEngineLine, claudeProbeCommand, probeClaude, type EngineLineDeps } from "../src/lib/health/engine";
import { CLAUDE_LOGIN_UNKNOWN, CLAUDE_NOT_INSTALLED, CLAUDE_NOT_LOGGED_IN, CODEX_NOT_LOGGED_IN, type EngineStatus } from "../src/lib/engines/check";
import { setSettingsPath } from "../src/lib/settings";
import type { SelectableEngine } from "../src/lib/settings";

function engineDeps(engine: SelectableEngine, status: Partial<EngineStatus>, source: "settings" | "env" | "code" = "settings") {
  const calls: string[] = [];
  const deps: EngineLineDeps = {
    standard: async () => ({ engine, source }),
    check: async id => {
      calls.push(`check ${id}`);
      return { engine: id, checked: true, installed: true, loggedIn: true, ...status };
    },
    probeClaude: async () => {
      calls.push("probe");
      return { ok: true, seconds: 3 };
    },
  };
  return { deps, calls };
}

describe("Zeile Motor", () => {
  test("Codex aus config/settings.json, angemeldet: ✅, kein Probeaufruf, Claude wird nicht gefragt", async () => {
    const { deps, calls } = engineDeps("codex", { version: "0.155.1" });
    expect(await checkEngineLine(true, deps)).toEqual({ name: "Motor", status: "ok", detail: "Codex 0.155.1 (aus config/settings.json), angemeldet (Probeaufruf nur bei Claude Code)" });
    expect(calls).toEqual(["check codex"]);
  });

  test("Codex abgemeldet: ❌ mit codex login", async () => {
    const { deps } = engineDeps("codex", { version: "0.155.1", loggedIn: false, message: CODEX_NOT_LOGGED_IN }, "env");
    const r = await checkEngineLine(true, deps);
    expect(r.status).toBe("fail");
    expect(r.detail).toBe(`Codex 0.155.1 (aus TYBO_ENGINE): ${CODEX_NOT_LOGGED_IN}`);
    expect(r.hint).toContain("codex login");
  });

  test("Anmeldung nicht prüfbar (Claude und Codex): ❌, aber nie als abgemeldet beschrieben", async () => {
    const claude = await checkEngineLine(false, engineDeps("claude", { version: "2.1.0", loggedIn: false, loginUnknown: true, message: CLAUDE_LOGIN_UNKNOWN }, "code").deps);
    expect(claude.status).toBe("fail");
    expect(claude.detail).toStartWith("Claude Code 2.1.0 (Standard): Anmeldung nicht prüfbar, heißt nicht abgemeldet");
    const codex = await checkEngineLine(false, engineDeps("codex", { loggedIn: false, message: "Codex-Anmeldung nicht prüfbar: codex login status brauchte länger als 5 s" }).deps);
    expect(codex.status).toBe("fail");
    expect(codex.detail).toContain("Anmeldung nicht prüfbar, heißt nicht abgemeldet");
    expect(codex.detail).not.toContain(CODEX_NOT_LOGGED_IN);
  });

  test("nicht installiert: ❌ mit Meldung der Prüfung", async () => {
    const r = await checkEngineLine(true, engineDeps("claude", { installed: false, loggedIn: false, message: CLAUDE_NOT_INSTALLED }, "code").deps);
    expect(r.status).toBe("fail");
    expect(r.detail).toBe(`Claude Code (Standard): ${CLAUDE_NOT_INSTALLED}`);
  });

  test("Claude Code abgemeldet: ❌ ohne Probeaufruf", async () => {
    const { deps, calls } = engineDeps("claude", { loggedIn: false, message: CLAUDE_NOT_LOGGED_IN });
    expect((await checkEngineLine(true, deps)).status).toBe("fail");
    expect(calls).toEqual(["check claude"]);
  });

  test("Claude Code angemeldet: mit Modell genau ein Probeaufruf, mit --no-model keiner", async () => {
    const withModel = engineDeps("claude", { version: "2.1.0" }, "code");
    expect(await checkEngineLine(true, withModel.deps)).toEqual({ name: "Motor", status: "ok", detail: "Claude Code 2.1.0 (Standard), Haiku antwortet (3 s)" });
    expect(withModel.calls).toEqual(["check claude", "probe"]);
    const noModel = engineDeps("claude", { version: "2.1.0" }, "code");
    expect(await checkEngineLine(false, noModel.deps)).toEqual({ name: "Motor", status: "ok", detail: "Claude Code 2.1.0 (Standard), angemeldet" });
    expect(noModel.calls).toEqual(["check claude"]);
  });

  test("--no-model über plannedChecks: die Zeile Motor ruft kein Modell", async () => {
    const { deps, calls } = engineDeps("claude", {});
    const check = plannedChecks({ withModel: false, env: {}, now: 0, state: { logs: {} }, nextState: { logs: {} }, maintenance: {} as MaintenanceCheckDeps, engine: deps }).find(c => c.name === "Motor")!;
    const [r] = await runCheck(check.name, check.fn, check.timeoutMs);
    expect(r.status).toBe("ok");
    expect(calls).toEqual(["check claude"]);
  });

  test("Probeaufruf scheitert: ❌ mit HTTP-Status, ohne Ausgabe von stderr", async () => {
    const { deps } = engineDeps("claude", {});
    deps.probeClaude = async () => probeClaude("claude", {}, async () => ({ code: 1, stdout: JSON.stringify({ is_error: true, api_error_status: 429 }), stderr: "token=geheim" }));
    const r = await checkEngineLine(true, deps);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("Haiku-Aufruf scheitert (HTTP 429)");
    expect(r.detail).not.toContain("geheim");
  });
});

describe("Probeaufruf", () => {
  test("ohne MCP, Werkzeuge, Einstellungen und Sitzung, in einem fremden Ordner", async () => {
    expect(claudeProbeCommand("claude")).toEqual(["claude", "-p", "Antworte nur mit: OK", "--model", "haiku", "--output-format", "json", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence", "--disable-slash-commands", "--tools", "", "--setting-sources", ""]);
    let seen: { cwd: string; env: Record<string, string> } | null = null;
    const r = await probeClaude("claude", { PATH: "/usr/bin" }, async (_cmd, o) => {
      seen = o;
      return { code: 0, stdout: JSON.stringify({ is_error: false, result: "OK" }), stderr: "" };
    });
    expect(r.ok).toBe(true);
    expect(seen!.cwd).toBe(tmpdir());
  });

  test("Umgebung gefiltert: keine Tokens und Schlüssel, im Abo kein API-Schlüssel; PATH, HOME, TYBO_SUBPROCESS gesetzt", async () => {
    const home = mkdtempSync(join(tmpdir(), "tybo-probe-home-"));
    try {
      const env = await probeEnvFor({
        HOME: home,
        PATH: "/usr/local/bin:/usr/bin",
        CLAUDE_AUTH: "subscription",
        ANTHROPIC_API_KEY: "sk-ant-test-nicht-echt-123456",
        TELEGRAM_BOT_TOKEN: "123456:test-token-nicht-echt",
        SUPABASE_SERVICE_ROLE_KEY: "test-service-role-nicht-echt",
        OPENROUTER_API_KEY: "sk-or-test-nicht-echt",
        USER_TIMEZONE: "Europe/Berlin",
      });
      for (const secret of ["ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN", "SUPABASE_SERVICE_ROLE_KEY", "OPENROUTER_API_KEY"]) expect(env[secret]).toBeUndefined();
      expect(env.PATH).toBe("/usr/local/bin:/usr/bin");
      expect(env.HOME).toBe(home);
      expect(env.TYBO_SUBPROCESS).toBe("1");
      expect(env.USER_TIMEZONE).toBe("Europe/Berlin");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Welcher Motor: wie zur Laufzeit", () => {
  let dir: string;
  const saved = process.env.TYBO_ENGINE;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tybo-motor-settings-"));
  });
  afterEach(() => {
    setSettingsPath();
    if (saved === undefined) delete process.env.TYBO_ENGINE;
    else process.env.TYBO_ENGINE = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  test("config/settings.json vor TYBO_ENGINE vor Claude Code", async () => {
    const path = join(dir, "settings.json");
    process.env.TYBO_ENGINE = "opencode";
    writeFileSync(path, JSON.stringify({ engine: { default: "codex" } }));
    setSettingsPath(path);
    expect(await realEngineLineDeps().standard()).toEqual({ engine: "codex", source: "settings" });
    writeFileSync(path, "{}");
    setSettingsPath(path);
    expect(await realEngineLineDeps().standard()).toEqual({ engine: "opencode", source: "env" });
    delete process.env.TYBO_ENGINE;
    expect(await realEngineLineDeps().standard()).toEqual({ engine: "claude", source: "code" });
  });
});
