import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getResumableSession,
  getSessionsForKey,
  normalizeSession,
  noteHandover,
  recordSessionTurn,
  resetSession,
  resetSessionOrThrow,
  retainHandover,
  sessionEpoch,
  SESSION_IDLE_MS,
  takeHandover,
  setSessionsFileForTests,
  takeExpiredSession,
  type BotSession,
} from "../src/lib/session-manager";
import { prepareClaudeCall, runJsonTurn, type ChatTurnDeps } from "../src/lib/chat-turn";
import { createClaudeEngine, type Engine, type EngineId, type EngineRequest } from "../src/lib/engines";
import type { ClaudeOptions, ClaudeResult } from "../src/lib/claude";
import { sessionKeyFor } from "../src/lib/store/message-rules";
import { setSwitchStateFileForTests, updateSwitchState } from "../src/lib/engine-switch-state";
import { setUsageFileForTests } from "../src/lib/engines/usage";

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
  setSwitchStateFileForTests(join(dir, "switch.json"));
  setUsageFileForTests(join(dir, "usage.json"));
});

afterEach(async () => {
  setSessionsFileForTests(null);
  setSwitchStateFileForTests(null);
  setUsageFileForTests(null);
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

describe("Übergabenotizen (Issue #658)", () => {
  const key = "topic:-100658:1";
  const other = "topic:-100658:2";
  const notesFile = () => join(dir, "session-handover.json");
  const notesOnDisk = async () => JSON.parse(await readFile(notesFile(), "utf8"));
  const peek = (agent = "general") => takeHandover(key, agent, { preserveUntilRecorded: true });
  async function seed() {
    await writeLegacy([legacyEntry(key, "general", "geheime-session-id"), legacyEntry(key, "research", "zweite-session-id"), legacyEntry(other, "general", "fremde-session-id")]);
    await noteHandover(key, "user");
    await noteHandover(other, "user");
  }

  test("nur Herkunft, atomare Datei, einmal entnehmen und Neustart", async () => {
    await seed();
    const notes = await notesOnDisk();
    expect(Object.keys(notes[`${key}:general`]).sort()).toEqual(["agentName", "engine", "model", "notedAt", "reason", "since"]);
    expect(JSON.stringify(notes)).not.toContain("session-id");
    setSessionsFileForTests(file);
    expect(await takeHandover(key, "general")).toMatchObject({ engine: "claude", model: MODEL, since: NOW - 5000, reason: "user" });
    expect(await takeHandover(key, "general")).toBeUndefined();
    expect((await notesOnDisk())[`${other}:general`]).toBeDefined();
  });

  test("ohne neue Session bleibt ursprüngliche Notiz, mit Session wird sie ersetzt", async () => {
    await seed();
    const first = await peek();
    await resetSession(key, undefined, { preserveHandover: true });
    await noteHandover(key, "changed");
    expect(await peek()).toEqual(first);
    await recordSessionTurn(key, "general", "codex-modell", "codex", "neu");
    expect(await peek()).toBeUndefined();
    await noteHandover(key, "user");
    expect(await peek()).toMatchObject({ engine: "codex", model: "codex-modell" });
  });

  test("18 Stunden ruhende Session und veraltete Notiz werden nicht übergeben", async () => {
    await writeLegacy([legacyEntry(key, "general", "alt", { lastActivity: Date.now() - SESSION_IDLE_MS - 1000 })]);
    await noteHandover(key, "user");
    expect(await peek()).toBeUndefined();
    await retainHandover(key, { agentName: "general", engine: "claude", model: MODEL, since: NOW, reason: "user", notedAt: Date.now() - SESSION_IDLE_MS - 1 });
    expect(await peek()).toBeUndefined();
    expect(await notesOnDisk()).toEqual({});
  });

  test.each([
    ["resetSession", false], ["resetSession", true], ["resetSessionOrThrow", false], ["resetSessionOrThrow", true], ["Agent", false],
  ] as const)("%s preserve=%s: Gesprächsgrenzen und alle Agenten", async (kind, preserveHandover) => {
    await seed();
    const before = await notesOnDisk();
    if (kind === "resetSessionOrThrow") await resetSessionOrThrow(key, { preserveHandover });
    else await resetSession(key, kind === "Agent" ? "general" : undefined, { preserveHandover });
    const kept = preserveHandover || kind === "Agent";
    for (const agent of ["general", "research"]) expect(!!(await peek(agent))).toBe(kept);
    const after = await notesOnDisk();
    expect(after[`${other}:general`]).toEqual(before[`${other}:general`]);
    expect((await getSessionsForKey(other))[0]!.engineSessionId).toBe("fremde-session-id");
    expect(await getSessionsForKey(key)).toHaveLength(kind === "Agent" ? 1 : 0);
  });

  test("/new ohne Session entfernt trotzdem alle Notizen, Epoche gilt sofort", async () => {
    await seed();
    const note = (await peek())!;
    await resetSession(key, undefined, { preserveHandover: true });
    const epoch = sessionEpoch(key);
    const reset = resetSession(key);
    expect(sessionEpoch(key)).toBe(epoch + 1);
    await reset;
    await retainHandover(key, note, epoch);
    expect(await peek()).toBeUndefined();
    expect(await peek("research")).toBeUndefined();
  });

  test("/new bei Schreibfehler: gelöschte Notiz lebt im Arbeitsspeicher nicht wieder auf", async () => {
    await seed();
    const oldFile = await readFile(notesFile(), "utf8");
    await rm(notesFile());
    await mkdir(notesFile());
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await resetSession(key);
      expect(errors.mock.calls.length).toBeGreaterThan(0);
      await rm(notesFile(), { recursive: true });
      await writeFile(notesFile(), oldFile);
      expect(await peek()).toBeUndefined();
      expect(await peek("research")).toBeUndefined();
      expect(await getSessionsForKey(key)).toEqual([]);
    } finally { errors.mockRestore(); }
  });

  test("Lese- und Schreibfehler kosten keine Antwort und ergeben keine Übergabe", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeFile(notesFile(), "kaputt");
      expect(await peek()).toBeUndefined();
      await recordSessionTurn(key, "general", MODEL, "claude", "s");
      await rm(notesFile());
      await mkdir(notesFile());
      await noteHandover(key, "user");
      expect(await peek()).toBeUndefined();
      expect(errors.mock.calls).toHaveLength(2);
    } finally { errors.mockRestore(); }
  });

  test("Notiz bleibt bei fehlgeschlagener Session-Ablage und endet erst beim erfolgreichen Speichern", async () => {
    await seed();
    await resetSession(key, undefined, { preserveHandover: true });
    await rm(file);
    await mkdir(file);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await recordSessionTurn(key, "general", "", "codex", "neu")).toBe(false);
      expect(await peek()).toBeDefined();
      await rm(file, { recursive: true });
      expect(await recordSessionTurn(key, "general", "", "codex", "neu")).toBe(true);
      expect(await peek()).toBeUndefined();
    } finally { errors.mockRestore(); }
  });
});

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
    runFallbackChain: async () => {
      throw new Error("Fallback aufgerufen");
    },
    setTimer: () => 0,
    clearTimer: () => {},
  };
}

const sink = { progress() {}, notice() {} };

describe("Chat-Turn und Motor der Session", () => {
  test("prepareClaudeCall liefert Motor, Modell und Beginn der fortgesetzten und alten Session", async () => {
    const key = sessionKeyFor(CHAT, 20);
    await writeLegacy([legacyEntry(key, "general", "S-alt")]);
    const deps = turnDeps([], [], () => "neu");
    const resumed = await prepareClaudeCall("weiter", CHAT, "general", 20, MODEL, deps, "claude");
    expect(resumed.resumedSession).toMatchObject({ engine: "claude", model: MODEL, startedAt: NOW - 5000 });
    expect(resumed.expiredSession).toBeUndefined();
    const changed = await prepareClaudeCall("weiter", CHAT, "general", 20, "", deps, "codex");
    expect(changed.expiredSession).toMatchObject({ engine: "claude", model: MODEL, startedAt: NOW - 5000 });
    expect(changed.resumedSession).toBeUndefined();
    expect(changed.handover).toMatchObject({ since: NOW - 5000, reason: "changed" });
  });

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

test("prepareClaudeCall delegiert das Destillat trotz Sperre und verwirft die alte Session", async () => {
  const key = sessionKeyFor(CHAT, 50);
  await recordSessionTurn(key, "general", "claude-fable-5-2", "claude", "alte-session");
  await updateSwitchState(state => ({ ...state, blocks: [{
    engine: "claude", cause: "outage", since: new Date().toISOString(),
    until: new Date(Date.now() + 600_000).toISOString(), resetKnown: true,
  }] }));
  const distilled: BotSession[] = [];
  const deps = turnDeps([], distilled, () => "neu");
  const prepared = await prepareClaudeCall("weiter", CHAT, "general", 50, "", deps, "opencode");
  expect(prepared.resumeId).toBeUndefined();
  expect(prepared.fullPrompt).toBe("voller-prompt");
  expect(await getSessionsForKey(key)).toEqual([]);
  expect(distilled).toHaveLength(1);
  expect(distilled[0]).toMatchObject({ engine: "claude", engineSessionId: "alte-session" });
  await prepareClaudeCall("noch einmal", CHAT, "general", 50, "", deps, "opencode");
  expect(distilled).toHaveLength(1);
});
