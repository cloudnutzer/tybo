/**
 * Register der Motoren (Issue #121, #123, #127): Claude Code, Codex und
 * OpenCode sind registriert; Tests können einen Motor ersetzen oder als nicht
 * verfügbar spielen.
 * Außerdem: der Claude-Motor baut dieselben Optionen wie vorher der Chat-Kern.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  claudeOptionsFor,
  createClaudeEngine,
  EngineNotAvailableError,
  getEngine,
  registeredEngineIds,
  setEngineForTests,
  type Engine,
} from "../src/lib/engines";
import {
  abortAllClaudeCalls,
  abortClaudeCalls,
  activeClaudeCallCount,
  type ClaudeResult,
  type ClaudeStreamOptions,
} from "../src/lib/claude";
import { abortAllEngineCalls, abortEngineCalls, activeEngineCallCount } from "../src/lib/engines/calls";

afterEach(() => setEngineForTests());

describe("getEngine", () => {
  test("claude, codex und opencode registriert", () => {
    expect(registeredEngineIds()).toEqual(["claude", "codex", "opencode"]);
    const engine = getEngine("claude");
    expect(engine.id).toBe("claude");
    expect(engine.describe()).toBe("Claude Code");
    const codex = getEngine("codex");
    expect(codex.id).toBe("codex");
    expect(codex.describe()).toBe("Codex");
    // Nur erzeugt, nicht gestartet: kein Prozess
    const opencode = getEngine("opencode");
    expect(opencode.id).toBe("opencode");
    expect(opencode.describe()).toBe("OpenCode");
  });

  test("ein als nicht verfügbar gespielter Motor wird klar abgelehnt", () => {
    setEngineForTests("opencode", "unavailable");
    expect(registeredEngineIds()).toEqual(["claude", "codex"]);
    expect(() => getEngine("opencode")).toThrow(EngineNotAvailableError);
    expect(() => getEngine("opencode")).toThrow(`Motor "opencode" ist nicht verfügbar (registriert: claude, codex)`);
  });

  test("setEngineForTests ersetzt und setzt zurück", () => {
    const fake: Engine = { id: "codex", describe: () => "Attrappe", run: async () => ({ engine: "codex", text: "", isError: false }) };
    setEngineForTests("codex", fake);
    expect(getEngine("codex")).toBe(fake);
    setEngineForTests("codex", null);
    expect(getEngine("codex")).not.toBe(fake);
    expect(getEngine("codex").describe()).toBe("Codex");
    setEngineForTests("opencode", { ...fake, id: "opencode" });
    expect(getEngine("opencode").describe()).toBe("Attrappe");
    setEngineForTests("opencode", null);
    expect(getEngine("opencode").describe()).toBe("OpenCode");
    setEngineForTests("claude", { ...fake, id: "claude" });
    setEngineForTests();
    expect(getEngine("claude").describe()).toBe("Claude Code");
  });
});

describe("Aliase", () => {
  test("die Claude-Namen sind dieselben Funktionen wie die allgemeinen", () => {
    expect(abortClaudeCalls).toBe(abortEngineCalls);
    expect(abortAllClaudeCalls).toBe(abortAllEngineCalls);
    expect(activeClaudeCallCount).toBe(activeEngineCallCount);
  });
});

describe("Claude-Motor", () => {
  const base = { prompt: "p", timeoutMs: 1000, cwd: "/tmp/x", model: "m", effort: "high", abortKey: "k" };

  test("JSON: outputFormat json, keine Rückrufe, keine Leerlauf-Grenze", () => {
    expect(claudeOptionsFor({ ...base, streaming: false, idleTimeoutMs: 5, onToolStart: () => {} })).toEqual({
      prompt: "p",
      outputFormat: "json",
      model: "m",
      effort: "high",
      cwd: "/tmp/x",
      abortKey: "k",
      timeoutMs: 1000,
    });
  });

  test("Streaming: Rückrufe, Leerlauf-Grenze, Resume, Werkzeuge, maxTurns als Text", () => {
    const onToolStart = () => {};
    const onFirstText = () => {};
    expect(
      claudeOptionsFor({
        ...base,
        streaming: true,
        idleTimeoutMs: 5,
        resumeSessionId: "s1",
        allowedTools: ["WebSearch"],
        maxTurns: 3,
        onToolStart,
        onFirstText,
      })
    ).toEqual({
      prompt: "p",
      resumeSessionId: "s1",
      allowedTools: ["WebSearch"],
      model: "m",
      effort: "high",
      cwd: "/tmp/x",
      abortKey: "k",
      maxTurns: "3",
      timeoutMs: 1000,
      idleTimeoutMs: 5,
      onToolStart,
      onFirstText,
    });
  });

  test("Ergebnis: alle Felder bleiben, tools undefined bleibt unbekannt, engine claude", async () => {
    const timeout: ClaudeResult = {
      text: "",
      sessionId: "s",
      isError: true,
      timedOut: true,
      timeoutKind: "idle",
      steps: [{ name: "Bash", input: "ls" }],
      lastText: "zuletzt",
      stoppedAfterMs: 10,
      idleForMs: 5,
      costUsd: 0.5,
    };
    const seen: ClaudeStreamOptions[] = [];
    const engine = createClaudeEngine({
      callClaudeStreaming: async (o) => (seen.push(o), timeout),
      callClaude: async () => ({ text: "json", isError: false }),
    });
    const r = await engine.run({ prompt: "p", streaming: true, timeoutMs: 1, cwd: "/" });
    expect(r).toEqual({ ...timeout, engine: "claude" });
    expect("tools" in r).toBe(false);
    expect(seen).toHaveLength(1);
    expect(await engine.run({ prompt: "p", streaming: false, timeoutMs: 1, cwd: "/" })).toEqual({
      text: "json",
      isError: false,
      engine: "claude",
    });
  });
});
