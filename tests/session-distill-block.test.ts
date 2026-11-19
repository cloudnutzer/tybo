import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { distillSession, shouldDistill, type DistillDeps } from "../src/lib/session-distill";
import { getSessionsForKey, recordSessionTurn, resetSessionOrThrow, setSessionsFileForTests, type BotSession } from "../src/lib/session-manager";
import { setSwitchStateFileForTests, updateSwitchState } from "../src/lib/engine-switch-state";
import type { SwitchBlock } from "../src/lib/engine-switch";
import { setSettingsPath } from "../src/lib/settings";
import { engineLabel } from "../src/lib/engine-choice";
import { createConversationSessionReset } from "../src/web/session-reset";
import { prepareClaudeCall } from "../src/lib/chat-turn";
import type { EngineId, EngineRequest } from "../src/lib/engines";
import * as credit from "../src/lib/spend/credit";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const UNTIL = "2026-11-17T13:00:00.000Z";
const KEY = "dm:123";
let dir: string;
let deps: DistillDeps;
let log: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
let booking: ReturnType<typeof spyOn>;
let aux: ReturnType<typeof mock>;
let run: ReturnType<typeof mock>;

function session(engine: EngineId): BotSession {
  return { key: `${KEY}:general`, engine, engineSessionId: "alte-session", agentName: "general",
    model: engine === "claude" ? "claude-fable-5-2" : "gpt-test", startedAt: NOW - 10_000,
    lastActivity: NOW - 1_000, messageCount: 6 };
}

async function block(engine: EngineId, cause: SwitchBlock["cause"], scope: Partial<SwitchBlock> = {}) {
  await updateSwitchState(state => ({ ...state, blocks: [{
    engine, cause, since: new Date(NOW - 1_000).toISOString(), until: UNTIL, resetKnown: true,
    ...scope,
  } as SwitchBlock] }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-distill-block-"));
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({ engine: { backups: [{ engine: "codex" }] }, aux: { distill: "claude:claude-haiku-5-5" } }));
  setSettingsPath(settings);
  setSwitchStateFileForTests(join(dir, "switch.json"));
  setSessionsFileForTests(join(dir, "sessions.json"));
  log = spyOn(console, "log").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
  booking = spyOn(credit, "bookRunOutcome").mockResolvedValue(undefined);
  aux = mock(async () => ({ text: "NONE", isError: false }));
  run = mock(async (_request: EngineRequest) => ({ engine: "codex" as const, text: "NONE", isError: false }));
  deps = {
    callAux: aux,
    processIntents: mock(async () => { throw new Error("Keine Merk-Tags erwartet"); }),
    getEngine: id => ({ id, describe: () => id, run }),
    now: () => NOW,
  };
});

afterEach(() => {
  for (const spy of [log, error, booking]) spy.mockRestore();
  setSettingsPath();
  setSwitchStateFileForTests(null);
  setSessionsFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

/** Reset mit echter Session-Ablage und echtem Destillat, ohne Server oder Netz. */
async function resetSession(s: BotSession) {
  for (let i = 0; i < s.messageCount; i++) await recordSessionTurn(KEY, "general", s.model, s.engine, s.engineSessionId);
  const pending: Promise<void>[] = [];
  const reset = createConversationSessionReset({
    sessionKey: () => KEY, isActive: () => false, block: () => () => {},
    sessionsForKey: getSessionsForKey, shouldDistill,
    distill: (old: BotSession) => {
      const result = distillSession(old, deps);
      pending.push(result);
      return result;
    },
    reset: resetSessionOrThrow, sessionModeEnabled: () => true,
  });
  expect(await reset("dm")).toEqual({ status: "done", reset: 1, sessionMode: true });
  await Promise.all(pending);
  expect(await getSessionsForKey(KEY)).toEqual([]);
  return reset;
}

describe.each(["direkt", "Reset"])("Destillat %s", route => {
  async function distill(s: BotSession) {
    if (route === "direkt") await distillSession(s, deps);
    else await resetSession(s);
  }

  for (const engine of ["claude", "codex", "opencode", "api"] as const) {
    test.each(["threshold", "limit", "outage"] as const)(`${engine}: %s verhindert jeden Modellaufruf, genau eine Zeile`, async cause => {
      const scope = engine === "claude" || engine === "codex" ? { window: "weekly_all" as const } : {};
      await block(engine, cause, scope);
      const s = session(engine);
      await distill(s);
      expect(aux).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(deps.processIntents).not.toHaveBeenCalled();
      expect(booking).not.toHaveBeenCalled();
      expect(log.mock.calls).toEqual([[`[Distill] ${s.key}: entfällt, ${engineLabel(engine)} gesperrt bis ${UNTIL}`]]);
      expect(error).not.toHaveBeenCalled();
    });
  }

  test.each(["threshold", "limit"] as const)("nur %s für Fable: Haiku-Destillat der Claude-Session läuft", async cause => {
    await block("claude", cause, { window: "weekly_scoped:fable" });
    await distill(session("claude"));
    expect(aux).toHaveBeenCalledTimes(1);
    expect(aux).toHaveBeenCalledWith("distill", expect.any(String), { resumeSessionId: "alte-session", timeoutMs: 300_000 });
    expect(run).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  test("Codex bei gesperrtem Claude: eigener Motor mit Session-Modell", async () => {
    await block("claude", "outage");
    await distill(session("codex"));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-test", resumeSessionId: "alte-session" }));
    expect(aux).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  test.each(["gpt-test", "anderes-modell"])("Codex-Modellsperre für %s", async model => {
    await block("codex", "limit", { model });
    await distill(session("codex"));
    expect(run).toHaveBeenCalledTimes(model === "gpt-test" ? 0 : 1);
  });
});

test.each(["claude", "codex"] as const)("%s ohne Ersatzstufen: alte Sperre hat keine Wirkung", async engine => {
  await block(engine, "limit");
  for (const settings of [{}, { engine: { backups: [] } }]) {
    await distillSession(session(engine), { ...deps, getSettings: () => settings });
  }
  expect(engine === "claude" ? aux : run).toHaveBeenCalledTimes(2);
  expect(log).not.toHaveBeenCalled();
});

test("Zustand, Uhr und Destillat-Modell sind unabhängig einschleusbar", async () => {
  const injected: DistillDeps = { ...deps, readSwitchState: () => ({ version: 1, counters: [], blocks: [{
    engine: "claude", cause: "limit", family: "opus", since: new Date(NOW).toISOString(), until: UNTIL, resetKnown: false,
  }] }), resolveAuxTarget: (purpose, resume) => {
    expect([purpose, resume]).toEqual(["distill", true]);
    return { kind: "claude", model: "claude-opus-5-5" };
  } };
  await distillSession(session("claude"), injected);
  expect(aux).not.toHaveBeenCalled();
  await distillSession(session("claude"), { ...injected, now: () => Date.parse(UNTIL) });
  expect(aux).toHaveBeenCalledTimes(1);
});

test("Reset bewahrt die gesperrte Session nicht auf und holt kein Destillat nach", async () => {
  await block("claude", "limit");
  const reset = await resetSession(session("claude"));
  await updateSwitchState(state => ({ ...state, blocks: [] }));
  expect(await reset("dm")).toEqual({ status: "done", reset: 0, sessionMode: true });
  expect(aux).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledTimes(1);
});

test("prepareClaudeCall lässt über das echte distillSession das gesperrte Destillat entfallen", async () => {
  await block("claude", "outage");
  const s = session("claude");
  await recordSessionTurn(KEY, "general", s.model, s.engine, s.engineSessionId);
  const prepared = await prepareClaudeCall("weiter", "123", "general", undefined, "gpt-test", {
    isSessionModeEnabled: () => true, shouldDistill: () => true,
    distillSession: old => distillSession(old, deps),
    buildPromptContext: async () => ({ fullPrompt: "neuer Kontext", fallbackContext: "" }),
  }, "codex");
  expect(prepared.fullPrompt).toBe("neuer Kontext");
  expect(await getSessionsForKey(KEY)).toEqual([]);
  expect(aux).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(log.mock.calls).toEqual([[`[Distill] ${s.key}: entfällt, Claude Code gesperrt bis ${UNTIL}`]]);
});

test("Destillat wirft auch bei Fehlern der eingeschleusten Prüfung nicht", async () => {
  await expect(distillSession(session("claude"), { ...deps, readSwitchState: () => { throw new Error("nicht lesbar"); } })).resolves.toBeUndefined();
  expect(aux).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledTimes(1);
});
