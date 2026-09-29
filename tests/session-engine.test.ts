import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getResumableSession,
  getSessionsForKey,
  normalizeSession,
  recordSessionTurn,
  resetSession,
  setSessionsFileForTests,
  takeExpiredSession,
  type BotSession,
} from "../src/lib/session-manager";
import { runJsonTurn, type ChatTurnDeps } from "../src/lib/chat-turn";
import { createClaudeEngine, type Engine, type EngineId, type EngineRequest } from "../src/lib/engines";
import type { ClaudeOptions, ClaudeResult } from "../src/lib/claude";
import { sessionKeyFor } from "../src/lib/supabase";

// Issue #122: Sessions merken ihren Motor. Echte Ablage (sessions.json) in
// einem Temp-Ordner über setSessionsFileForTests; Motoren sind Attrappen.

const CHAT = "-100122";
const MODEL = "test-modell";
const NOW = Date.now();

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tybo-122-"));
  file = join(dir, "sessions.json");
  setSessionsFileForTests(file);
});

afterEach(async () => {
  setSessionsFileForTests(null);
  await rm(dir, { recursive: true, force: true });
});

/** Eintrag im Format vor Issue #122: claudeSessionId, kein engine */
function legacyEntry(sessionKey: string, agent: string, id: string, extra: Record<string, unknown> = {}) {
  return {
    key: `${sessionKey}:${agent}`,
    agentName: agent,
    claudeSessionId: id,
    model: MODEL,
    memoryWatermark: NOW - 1000,
    startedAt: NOW - 5000,
    lastActivity: NOW - 1000,
    messageCount: 7,
    ...extra,
  };
}

async function writeLegacy(entries: ReturnType<typeof legacyEntry>[]) {
  await writeFile(file, JSON.stringify(Object.fromEntries(entries.map((e) => [e.key, e])), null, 2));
}

const onDisk = async () => JSON.parse(await readFile(file, "utf8")) as Record<string, Record<string, unknown>>;

describe("BotSession mit Motor", () => {
  test("alter Eintrag ohne engine wird als Claude-Session gelesen", async () => {
    const key = sessionKeyFor(CHAT, 1);
    await writeLegacy([legacyEntry(key, "general", "S-alt")]);
    const s = await getResumableSession(key, "general", MODEL, "claude");
    expect(s).toMatchObject({ engine: "claude", engineSessionId: "S-alt", messageCount: 7 });
    expect(s).not.toHaveProperty("claudeSessionId");
  });

  test("Motor passt nicht: nicht fortsetzbar, wie bei einem Modellwechsel", async () => {
    const key = sessionKeyFor(CHAT, 2);
    await writeLegacy([legacyEntry(key, "general", "S-claude")]);
    expect(await getResumableSession(key, "general", MODEL, "codex")).toBeUndefined();
    expect(await getResumableSession(key, "general", "anderes-modell", "claude")).toBeUndefined();
    expect(await getResumableSession(key, "general", MODEL, "claude")).toMatchObject({ engineSessionId: "S-claude" });
  });

  test("Schreiben nach der Übernahme: nur noch engine und engineSessionId, kein claudeSessionId", async () => {
    const key = sessionKeyFor(CHAT, 3);
    await writeLegacy([legacyEntry(key, "general", "S-a"), legacyEntry(key, "research", "S-b")]);
    expect(await recordSessionTurn(key, "general", MODEL, "claude", "S-a")).toBe(true);
    const stored = await onDisk();
    expect(JSON.stringify(stored)).not.toContain("claudeSessionId");
    expect(stored[`${key}:general`]).toMatchObject({ engine: "claude", engineSessionId: "S-a", messageCount: 8 });
    // Nicht angefasster Eintrag wird ebenfalls im neuen Format geschrieben
    expect(stored[`${key}:research`]).toMatchObject({ engine: "claude", engineSessionId: "S-b", messageCount: 7 });
  });

  test("gleiche Session-ID unter anderem Motor ist eine neue Session", async () => {
    const key = sessionKeyFor(CHAT, 4);
    await recordSessionTurn(key, "general", MODEL, "claude", "S-x");
    await recordSessionTurn(key, "general", MODEL, "claude", "S-x");
    expect((await getSessionsForKey(key))[0]).toMatchObject({ engine: "claude", messageCount: 2 });
    await recordSessionTurn(key, "general", MODEL, "codex", "S-x");
    expect((await getSessionsForKey(key))[0]).toMatchObject({ engine: "codex", engineSessionId: "S-x", messageCount: 1 });
  });

  test("takeExpiredSession gibt die Session eines anderen Motors einmal heraus (zum Destillieren)", async () => {
    const key = sessionKeyFor(CHAT, 5);
    await writeLegacy([legacyEntry(key, "general", "S-alt")]);
    // Gleicher Motor, noch gültig: bleibt
    expect(await takeExpiredSession(key, "general", MODEL, "claude")).toBeUndefined();
    const taken = await takeExpiredSession(key, "general", MODEL, "codex");
    expect(taken).toMatchObject({ engine: "claude", engineSessionId: "S-alt" });
    expect(await getSessionsForKey(key)).toEqual([]);
    expect(await takeExpiredSession(key, "general", MODEL, "codex")).toBeUndefined();
  });

  test("/new löscht Sessions aller Motoren und Agenten nur im betroffenen Gespräch", async () => {
    const key = sessionKeyFor(CHAT, 6);
    const other = sessionKeyFor(CHAT, 60);
    await writeLegacy([legacyEntry(key, "general", "S-claude-alt")]);
    await recordSessionTurn(key, "research", MODEL, "codex", "S-codex");
    await recordSessionTurn(key, "finance", MODEL, "opencode", "S-opencode");
    await recordSessionTurn(other, "general", MODEL, "codex", "S-anderes-gespraech");
    await recordSessionTurn(other, "research", MODEL, "claude", "S-anderes-claude");

    expect(await resetSession(key)).toBe(3);
    expect(await getSessionsForKey(key)).toEqual([]);
    const rest = (await getSessionsForKey(other)).map((s) => `${s.agentName}=${s.engine}:${s.engineSessionId}`).sort();
    expect(rest).toEqual(["general=codex:S-anderes-gespraech", "research=claude:S-anderes-claude"]);
    // Auch auf der Platte
    expect(Object.keys(await onDisk()).sort()).toEqual([`${other}:general`, `${other}:research`]);
  });

  test("Test-Pfad umlenken leert den Speicher-Cache", async () => {
    const key = sessionKeyFor(CHAT, 7);
    await recordSessionTurn(key, "general", MODEL, "claude", "S-datei-1");
    const second = join(dir, "zweite.json");
    setSessionsFileForTests(second);
    expect(await getSessionsForKey(key)).toEqual([]);
    await recordSessionTurn(key, "general", MODEL, "codex", "S-datei-2");
    setSessionsFileForTests(file);
    expect((await getSessionsForKey(key))[0]).toMatchObject({ engine: "claude", engineSessionId: "S-datei-1" });
  });

  test("normalizeSession: fremder Motor übernimmt nie eine claudeSessionId", () => {
    const s = normalizeSession({ ...legacyEntry("dm:1", "general", "S-c"), engine: "codex" } as never);
    expect(s.engine).toBe("codex");
    expect(s.engineSessionId).toBeUndefined();
    expect(s).not.toHaveProperty("claudeSessionId");
    const neu = normalizeSession({ ...legacyEntry("dm:1", "general", "S-alt"), engine: "codex", engineSessionId: "S-neu" } as never);
    expect(neu).toMatchObject({ engine: "codex", engineSessionId: "S-neu" });
    expect(neu).not.toHaveProperty("claudeSessionId");
  });
});

// ---------------------------------------------------------------------------
// Chat-Kern mit echter Ablage: Motor vor der Prompt-Auswahl
// ---------------------------------------------------------------------------

interface EngineCall {
  engine: EngineId;
  prompt: string;
  resumeSessionId?: string;
  model?: string;
}

function turnDeps(calls: EngineCall[], distilled: BotSession[], reply: (engine: EngineId, n: number) => string): Partial<ChatTurnDeps> {
  let n = 0;
  const fakeEngine = (id: EngineId): Engine => {
    if (id === "claude") {
      const call = async (o: ClaudeOptions): Promise<ClaudeResult> => {
        calls.push({ engine: "claude", prompt: o.prompt, resumeSessionId: o.resumeSessionId, model: o.model });
        return { text: "antwort", sessionId: reply("claude", ++n), isError: false };
      };
      return createClaudeEngine({ callClaude: call, callClaudeStreaming: call });
    }
    return {
      id,
      describe: () => id,
      async run(req: EngineRequest) {
        calls.push({ engine: id, prompt: req.prompt, resumeSessionId: req.resumeSessionId, model: req.model });
        return { engine: id, text: "antwort", sessionId: reply(id, ++n), isError: false };
      },
    };
  };
  return {
    getEngine: fakeEngine,
    buildPromptContext: async () => ({ fullPrompt: "voller-prompt", fallbackContext: "" }),
    buildResumePrompt: async () => "resume-prompt",
    isSessionModeEnabled: () => true,
    shouldDistill: () => true,
    distillSession: async (s) => {
      distilled.push(s);
    },
    log: async () => {},
    getAgentConfig: () => ({ model: MODEL }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
    getSettings: () => ({}),
    reportSecrets: () => [],
    callFallbackLLMWithSource: async () => {
      throw new Error("Fallback aufgerufen");
    },
    setTimer: () => 0,
    clearTimer: () => {},
  };
}

const sink = { progress() {}, notice() {} };

describe("Chat-Turn und Motor der Session", () => {
  test("alte sessions.json ohne engine: Turn mit Claude setzt die Session fort (schlanker Prompt)", async () => {
    const key = sessionKeyFor(CHAT, 20);
    await writeLegacy([legacyEntry(key, "general", "S-alt")]);
    const calls: EngineCall[] = [];
    const distilled: BotSession[] = [];
    await runJsonTurn({
      userMessage: "weiter", chatId: CHAT, topicId: 20, agentName: "general", sink,
      deps: turnDeps(calls, distilled, () => "S-alt"),
    });
    expect(calls).toEqual([{ engine: "claude", prompt: "resume-prompt", resumeSessionId: "S-alt", model: MODEL }]);
    expect(distilled).toEqual([]);
    const stored = await onDisk();
    expect(stored[`${key}:general`]).toMatchObject({ engine: "claude", engineSessionId: "S-alt", messageCount: 8 });
    expect(stored[`${key}:general`]).not.toHaveProperty("claudeSessionId");
  });

  test("Motorwechsel: Claude-Session geht nicht an Codex, voller Prompt, alte Session wird destilliert", async () => {
    const key = sessionKeyFor(CHAT, 21);
    await writeLegacy([legacyEntry(key, "general", "S-claude")]);
    const calls: EngineCall[] = [];
    const distilled: BotSession[] = [];
    const sessionIds: [string, unknown][] = [];
    await runJsonTurn({
      userMessage: "Frage", chatId: CHAT, topicId: 21, agentName: "general", engine: "codex", sink,
      onSessionId: (id, meta) => {
        sessionIds.push([id, meta]);
      },
      deps: turnDeps(calls, distilled, () => "T-codex"),
    });
    // Seit Issue #125 kein Agenten-Modell für Codex: ohne engine.codex.model entscheidet die Codex-Konfiguration
    expect(calls).toEqual([{ engine: "codex", prompt: "voller-prompt", resumeSessionId: undefined, model: undefined }]);
    // Die Claude-Session wird einmal über ihren eigenen Motor destilliert
    expect(distilled).toHaveLength(1);
    expect(distilled[0]).toMatchObject({ engine: "claude", engineSessionId: "S-claude" });
    // Gespeichert: die neue Codex-Session, die Claude-Session ist weg
    const stored = await onDisk();
    expect(stored[`${key}:general`]).toMatchObject({ engine: "codex", engineSessionId: "T-codex", messageCount: 1 });
    // "" = bewusst Standard des Motors (Codex-Konfiguration), nicht fehlend
    expect(sessionIds).toEqual([["T-codex", { engine: "codex", model: "" }]]);

    // Nächster Turn mit Codex setzt fort, zurück zu Claude beginnt neu
    await runJsonTurn({
      userMessage: "noch was", chatId: CHAT, topicId: 21, agentName: "general", engine: "codex", sink,
      deps: turnDeps(calls, distilled, () => "T-codex"),
    });
    expect(calls[1]).toEqual({ engine: "codex", prompt: "resume-prompt", resumeSessionId: "T-codex", model: undefined });
    await runJsonTurn({
      userMessage: "wieder Claude", chatId: CHAT, topicId: 21, agentName: "general", sink,
      deps: turnDeps(calls, distilled, () => "S-neu"),
    });
    expect(calls[2]).toEqual({ engine: "claude", prompt: "voller-prompt", resumeSessionId: undefined, model: MODEL });
    expect((await onDisk())[`${key}:general`]).toMatchObject({ engine: "claude", engineSessionId: "S-neu" });
  });
});
