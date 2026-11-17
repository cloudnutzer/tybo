/**
 * Issue #347: der Motor "api" im Chat-Kern. Die gespeicherte Wahl
 * (engine.default bzw. /motor) erreicht den echten API-Motor ohne CLI; der
 * Abruf bei Anthropic ist eine Attrappe (tests/api-fixture.ts). Claude Code
 * ist eine Motor-Attrappe, damit sichtbar wird, wann der Kern ausweicht.
 * Kein Bot-Import, kein Netz, kein echter Prozess.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AskOffer } from "../src/lib/ask-choices";
import { ABORT_REPLY, resolveStreamingLimits, runJsonTurn, runStreamingTurn, type ChatTurnDeps, type TurnInfo, type TurnQuestion } from "../src/lib/chat-turn";
import { DEFAULT_CLAUDE_MODEL } from "../src/lib/default-model";
import { resetEngineChoiceForTests, resolveEngine, setTopicEngine } from "../src/lib/engine-choice";
import { abortEngineCalls, activeEngineCallCount, createApiEngine, type Engine, type EngineId, type EngineRequest } from "../src/lib/engines";
import { setSettingsPath } from "../src/lib/settings";
import {
  getResumableSession,
  getSessionsForKey,
  recordSessionTurn,
  resetSession,
  sessionEpoch,
  setSessionsFileForTests,
  takeExpiredSession,
} from "../src/lib/session-manager";
import { readCycle, resetSubscriptionStateForTests } from "../src/lib/spend/subscription";
import { sessionKeyFor } from "../src/lib/store/message-rules";
import { installApiFake, sse, textReply, until, type ApiFake } from "./api-fixture";

const KEYS = ["ANTHROPIC_API_KEY", "BUDGET_DB_PATH", "CREDIT_GUARD", "CREDIT_RESET_DAY", "GO_PROJECT_ROOT", "TYBO_ENGINE", "CLAUDE_EFFORT"] as const;
const DM = "4711";
const KEY = sessionKeyFor(DM);

let saved: Record<string, string | undefined> = {};
let dir = "";
let fake: ApiFake;
let claudeCalls: EngineRequest[];
let fallbackCalls: number;
let spies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "tybo-347-"));
  process.env.BUDGET_DB_PATH = join(dir, "data", "api-budget.sqlite");
  process.env.GO_PROJECT_ROOT = dir;
  resetSubscriptionStateForTests();
  setSettingsPath(join(dir, "settings.json"));
  setSessionsFileForTests(join(dir, "sessions.json"));
  resetEngineChoiceForTests();
  fake = installApiFake();
  claudeCalls = [];
  fallbackCalls = 0;
  spies = [
    spyOn(console, "log").mockImplementation(() => {}),
    spyOn(console, "warn").mockImplementation(() => {}),
    spyOn(console, "error").mockImplementation(() => {}),
  ];
});

afterEach(() => {
  fake.restore();
  for (const s of spies) s.mockRestore();
  setSettingsPath();
  setSessionsFileForTests(null);
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

const claudeFake: Engine = {
  id: "claude",
  describe: () => "Attrappe Claude",
  async run(req) {
    claudeCalls.push(req);
    return { engine: "claude", text: "antwort-claude", sessionId: "claude-s1", isError: false };
  },
};

function deps(extra: Partial<ChatTurnDeps> = {}): Partial<ChatTurnDeps> {
  const engines: Partial<Record<EngineId, Engine>> = { claude: claudeFake, api: createApiEngine() };
  return {
    getEngine: (id) => {
      const e = engines[id];
      if (!e) throw new Error(`kein Motor ${id}`);
      return e;
    },
    // Echte Motorwahl samt echter Prüfung von api (Schlüssel aus der Attrappe)
    resolveEngine: (key) => resolveEngine(key, { env: () => ({}), log: () => {} }),
    forgetEngineCheck: () => {},
    runFallbackChain: async () => {
      fallbackCalls++;
      return { text: "ersatz-antwort", source: "openrouter", model: "ersatz-modell" };
    },
    buildPromptContext: async () => ({ fullPrompt: "voller-prompt", fallbackContext: "kontext" }),
    buildResumePrompt: async () => "resume-prompt",
    isSessionModeEnabled: () => true,
    getResumableSession,
    takeExpiredSession,
    recordSessionTurn,
    getSessionsForKey,
    sessionEpoch,
    resetSession,
    shouldDistill: () => false,
    distillSession: async () => {},
    log: async () => {},
    getAgentConfig: () => ({ model: "claude-opus-5-5", effort: "high" }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
    resolveStreamingLimits: () => resolveStreamingLimits({}),
    reportSecrets: () => [],
    setTimer: () => 0,
    clearTimer: () => {},
    now: () => 0,
    ...extra,
  };
}

const notices: string[] = [];
const sink = { progress: () => {}, notice: (t: string) => void notices.push(t) };

function turn(kind: "streaming" | "json", d = deps(), infos: TurnInfo[] = []) {
  const run = kind === "streaming" ? runStreamingTurn : runJsonTurn;
  return run({ userMessage: "Frage?", chatId: DM, agentName: "general", sink, onInfo: (i) => infos.push(i), deps: d });
}

function runs(): { engine: string; model: string; cost_usd: number | null; input_tokens: number | null }[] {
  if (!existsSync(process.env.BUDGET_DB_PATH!)) return [];
  const db = new Database(process.env.BUDGET_DB_PATH!);
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'engine_runs'").get()) return [];
    return db.query("SELECT engine, model, cost_usd, input_tokens FROM engine_runs ORDER BY id").all() as any;
  } finally {
    db.close();
  }
}

const putSettings = (s: object) => writeFileSync(join(dir, "settings.json"), JSON.stringify(s));

describe("gespeicherte Wahl erreicht den API-Motor ohne CLI", () => {
  for (const kind of ["streaming", "json"] as const) {
    test(`engine.default = api (${kind}): Antwort von der API, Modell und Effort des Agenten, Session für den Folgeturn`, async () => {
      putSettings({ engine: { default: "api" } });
      fake.respond(textReply("Antwort aus der API"));
      const infos: TurnInfo[] = [];
      expect(await turn(kind, deps(), infos)).toBe("Antwort aus der API");
      expect(claudeCalls).toHaveLength(0);
      expect(fake.calls()).toBe(1);
      expect(fake.lastBody()).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "high" }, messages: [{ role: "user", content: "voller-prompt" }] });
      expect(infos[0]).toMatchObject({ engine: "api", model: "claude-opus-5-5" });
      // Session gespeichert (Issue #348): der nächste Turn setzt mit dem schlanken Prompt fort
      const [stored] = await getSessionsForKey(KEY);
      expect(stored).toMatchObject({ engine: "api" });
      fake.respond(textReply("zweite"));
      expect(await turn(kind)).toBe("zweite");
      expect(fake.lastBody().messages).toEqual([
        { role: "user", content: "voller-prompt" },
        { role: "assistant", content: [{ type: "text", text: "Antwort aus der API" }] },
        { role: "user", content: "resume-prompt" },
      ]);
    });
  }

  test("/motor api im Gespräch wählt die API, Kurzform des Agenten-Modells wird zum Standardmodell", async () => {
    await setTopicEngine(KEY, "api");
    fake.respond(textReply("ok"));
    await turn("streaming", deps({ getAgentConfig: () => ({ model: "opus" }) as ReturnType<ChatTurnDeps["getAgentConfig"]> }));
    expect(fake.lastBody().model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(fake.lastBody()).not.toHaveProperty("output_config");
  });

  test("ohne Schlüssel: Claude Code antwortet, eine Meldung, kein Abruf", async () => {
    putSettings({ engine: { default: "api" } });
    fake.setKey(undefined);
    notices.length = 0;
    expect(await turn("streaming")).toBe("antwort-claude");
    expect(fake.calls()).toBe(0);
    expect(notices.join("\n")).toContain("Anthropic API ist nicht verfügbar");
    expect(notices.join("\n")).toContain("ANTHROPIC_API_KEY");
  });

  test("Schlüssel ungültig (401): sofort Claude Code statt Fallback-Kette", async () => {
    putSettings({ engine: { default: "api" } });
    fake.respondStatus(401, JSON.stringify({ error: { type: "authentication_error", message: "invalid x-api-key" } }));
    expect(await turn("json")).toBe("antwort-claude");
    expect(fallbackCalls).toBe(0);
  });
});

describe("/stop und Zeitlimits", () => {
  test("/stop beendet das wartende Lesen: Abbruch-Antwort, kein neuer Versuch, kein Fallback, Register leer", async () => {
    putSettings({ engine: { default: "api" } });
    fake.hangAfter(sse({ type: "message_start", message: {} }));
    const running = turn("streaming");
    await until(() => fake.reading() && activeEngineCallCount() === 1);
    expect(abortEngineCalls(KEY)).toBeGreaterThanOrEqual(1);
    expect(await running).toBe(ABORT_REPLY);
    expect(fake.calls()).toBe(1);
    expect(fake.aborts()).toBe(1);
    expect(fallbackCalls).toBe(0);
    expect(claudeCalls).toHaveLength(0);
    expect(activeEngineCallCount()).toBe(0);
  });

  test("Leerlauf-Grenze: Abruf beendet, kein neuer Versuch, kein Fallback", async () => {
    putSettings({ engine: { default: "api" } });
    fake.hangAfter(sse({ type: "message_start", message: {} }));
    const reply = await turn("streaming", deps({ resolveStreamingLimits: () => ({ idleMs: 40, maxMs: 60_000 }) }));
    expect(reply).toContain("Anthropic API");
    expect(fake.calls()).toBe(1);
    expect(fake.aborts()).toBe(1);
    expect(fallbackCalls).toBe(0);
    expect(claudeCalls).toHaveLength(0);
    expect(activeEngineCallCount()).toBe(0);
  });

  test("Fehler im Strom: Fallback-Kette wie bei den anderen Motoren", async () => {
    putSettings({ engine: { default: "api" } });
    fake.respond(sse({ type: "message_start", message: {} }) + sse({ type: "error", error: { type: "api_error", message: "kaputt" } }));
    expect(await turn("json")).toContain("ersatz-antwort");
    expect(fallbackCalls).toBe(1);
  });
});

describe("Kosten", () => {
  test("genau eine Buchung je Lauf, mit Kosten samt Cache, nie in den Abo-Zähler", async () => {
    putSettings({ engine: { default: "api" } });
    fake.respond(textReply("ok", [], { start: { input_tokens: 1000, cache_read_input_tokens: 10_000 }, end: { output_tokens: 200 } }));
    await turn("json");
    await until(() => runs().length > 0);
    const rows = runs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ engine: "api", model: "claude-opus-5-5", input_tokens: 11_000 });
    // 1000*4 + 200*20 + 10000*0.4 = 12000 / 1e6
    expect(rows[0]!.cost_usd).toBeCloseTo(0.012, 10);
    expect(readCycle(1)?.cycleSpendUsd ?? 0).toBe(0);
  });

  test("vorzeitiges Streamende nach vorläufiger usage: Buchung mit cost_usd NULL", async () => {
    putSettings({ engine: { default: "api" } });
    fake.respond(
      sse({ type: "message_start", message: { usage: { input_tokens: 1000, output_tokens: 1 } } }) +
        sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Halber Sat" } })
    );
    await turn("json");
    await until(() => runs().some((r) => r.engine === "api"));
    const rows = runs().filter((r) => r.engine === "api");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ engine: "api", model: "claude-opus-5-5", input_tokens: 1000, cost_usd: null });
  });
});

describe("Rückfrage über den Chat-Kern (Issue #348, Verhalten festgehalten)", () => {
  test("Antwort mit [FRAGE: ...]: Rückfrage im Register mit Motor api und Modell, Text lesbar ohne Tag", async () => {
    putSettings({ engine: { default: "api" } });
    fake.respond(textReply("Ich habe zwei Wege. [FRAGE: Welchen Weg? | Kurz | Lang]"));
    const offers: AskOffer[] = [];
    const questions: TurnQuestion[] = [];
    const d = deps({
      offerAsk: async (offer) => {
        offers.push(offer);
        return { status: "unavailable" };
      },
      questionConversation: async (chatId) => ({ type: "telegram", chatId }),
    });
    const reply = await runJsonTurn({ userMessage: "Frage?", chatId: DM, agentName: "general", sink, deps: d, onQuestion: (q) => questions.push(q) });
    expect(reply).not.toContain("[FRAGE:");
    expect(reply).toContain("Welchen Weg?");
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ question: "Welchen Weg?", options: ["Kurz", "Lang"], via: "tag" });
    await questions[0]!.offer();
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      conversation: { type: "telegram", chatId: DM },
      question: "Welchen Weg?",
      options: ["Kurz", "Lang"],
      agent: "general",
      engine: "api",
      model: "claude-opus-5-5",
    });
  });
});
