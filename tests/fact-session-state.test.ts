/**
 * Issue #523: Welche Fakten eine Session kennt. Der ganze Turn läuft über
 * chat-turn und die echte Session-Ablage (Temp-Datei), Motoren und Prompt-Bau
 * sind Attrappen. Der Prompt-Bau selbst: tests/fact-followup-pg.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJsonTurn, type ChatTurnDeps } from "../src/lib/chat-turn";
import { setEngineForTests, type Engine, type EngineId, type EngineRequest, type EngineResult } from "../src/lib/engines";
import type { ResumePromptOptions } from "../src/lib/prompt-builder";
import { getSessionsForKey, normalizeSession, recordSessionTurn, resetSession, setSessionsFileForTests } from "../src/lib/session-manager";

const CHAT = "4711";
const KEY = `dm:${CHAT}`;

let dir: string;
let file: string;
let requests: EngineRequest[];
let resumes: ResumePromptOptions[];
/** Was der Motor als Nächstes antwortet; danach gilt der Standard */
let replies: Partial<EngineResult>[];

function engine(id: EngineId): Engine {
  return {
    id,
    describe: () => `Attrappe ${id}`,
    async run(req) {
      requests.push(req);
      return { engine: id, text: "antwort", isError: false, sessionId: req.resumeSessionId ?? `S-${requests.length}`, ...replies.shift() };
    },
  };
}

const deps = (overrides: Partial<ChatTurnDeps> = {}): Partial<ChatTurnDeps> => ({
  isSessionModeEnabled: () => true,
  buildPromptContext: async () => ({ fullPrompt: "voll", fallbackContext: "kontext", shownFactIds: ["1", "2"] }),
  buildResumePrompt: async opts => {
    resumes.push(opts);
    opts.onFactsShown?.([...(opts.shownFactIds ?? []), "3"]);
    return "weiter";
  },
  runFallbackChain: async () => ({ text: "ersatz", source: "openrouter", model: "ersatz" }),
  log: async () => {},
  getAgentConfig: () => ({ model: "modell" }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
  getSettings: () => ({}) as ReturnType<ChatTurnDeps["getSettings"]>,
  ...overrides,
});

const turn = (engineId: EngineId = "claude", overrides: Partial<ChatTurnDeps> = {}) =>
  runJsonTurn({
    userMessage: "Frage",
    chatId: CHAT,
    agentName: "general",
    engine: engineId,
    sink: { progress() {}, notice() {}, start() {}, finish() {} },
    deps: deps(overrides),
  });

const stored = async () => (await getSessionsForKey(KEY))[0];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tybo-gezeigt-"));
  file = join(dir, "sessions.json");
  setSessionsFileForTests(file);
  requests = [];
  resumes = [];
  replies = [];
  setEngineForTests();
  setEngineForTests("claude", engine("claude"));
  setEngineForTests("codex", engine("codex"));
});

afterEach(async () => {
  setEngineForTests();
  setSessionsFileForTests(null);
  await rm(dir, { recursive: true, force: true });
});

describe("Gezeigte Fakten je Session", () => {
  test("erster Turn: die Fakten des vollen Prompts gelten nach dem Lauf als gezeigt", async () => {
    await turn();
    expect((await stored())?.shownFactIds).toEqual(["1", "2"]);
  });

  test("Folgenachricht: Der Prompt-Bau kennt den Stand, danach kommen die neuen Fakten dazu", async () => {
    await turn();
    await turn();
    expect(resumes[0]?.shownFactIds).toEqual(["1", "2"]);
    expect(requests[1]?.resumeSessionId).toBe("S-1");
    expect((await stored())?.shownFactIds).toEqual(["1", "2", "3"]);
  });

  test("Fortsetzung nach einem Neustart: Der Stand liegt in der Datei", async () => {
    await turn();
    setSessionsFileForTests(file);
    await turn();
    expect(resumes[0]?.shownFactIds).toEqual(["1", "2"]);
  });

  test("Abbruch: Der Fakt der Folgenachricht bleibt ungezeigt", async () => {
    await turn();
    replies.push({ aborted: true, text: "" });
    await turn();
    expect((await stored())?.shownFactIds).toEqual(["1", "2"]);
  });

  test("gescheiterte Fortsetzung: neue Session, sie kennt nur den vollen Prompt", async () => {
    await turn();
    replies.push({ isError: true, text: "kaputt" });
    await turn();
    const session = await stored();
    expect(requests[2]?.resumeSessionId).toBeUndefined();
    expect(session?.engineSessionId).toBe("S-3");
    expect(session?.shownFactIds).toEqual(["1", "2"]);
    expect(session?.shownFactIds).not.toContain("3");
  });

  test("alle Läufe gescheitert: nichts wird verbucht", async () => {
    replies.push({ isError: true, text: "" }, { isError: true, text: "" });
    await turn();
    expect(await stored()).toBeUndefined();
  });

  test("/new: Die nächste Session beginnt ohne Stand und mit vollem Prompt", async () => {
    await turn();
    await turn();
    await resetSession(KEY);
    expect(await stored()).toBeUndefined();
    resumes = [];
    await turn();
    expect(resumes).toEqual([]);
    expect((await stored())?.shownFactIds).toEqual(["1", "2"]);
  });

  test("Motorwechsel: frische Session unter dem neuen Motor, der alte Stand zählt nicht", async () => {
    await turn("claude");
    await turn("claude");
    resumes = [];
    await turn("codex", {
      buildPromptContext: async () => ({ fullPrompt: "voll", fallbackContext: "", shownFactIds: ["8"] }),
      getAgentConfig: () => ({ model: "modell" }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
    });
    expect(resumes).toEqual([]);
    const session = await stored();
    expect(session?.engine).toBe("codex");
    expect(session?.shownFactIds).toEqual(["8"]);
  });

  test("Turn ohne Angabe (Rückfrage, Routine): dieselbe Session behält den Stand, eine neue beginnt leer", async () => {
    await recordSessionTurn(KEY, "general", "m", "claude", "S-a", 1, undefined, ["1"]);
    await recordSessionTurn(KEY, "general", "m", "claude", "S-a");
    expect((await stored())?.shownFactIds).toEqual(["1"]);
    await recordSessionTurn(KEY, "general", "m", "claude", "S-b");
    expect((await stored())?.shownFactIds).toBeUndefined();
  });

  test("alte oder kaputte Einträge: ohne Liste kein Stand", () => {
    const base = { key: "k:general", agentName: "general", model: "m", startedAt: 1, lastActivity: 1, messageCount: 1 };
    expect(normalizeSession(base).shownFactIds).toBeUndefined();
    expect(normalizeSession({ ...base, shownFactIds: "kaputt" as unknown as string[] }).shownFactIds).toBeUndefined();
    expect(normalizeSession({ ...base, shownFactIds: ["1"] }).shownFactIds).toEqual(["1"]);
  });
});
