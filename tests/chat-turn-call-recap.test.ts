/**
 * Issue #260, Checkbox 1: Der nächste getippte Turn im selben Gespräch
 * bekommt das Telefongespräch genau einmal als Kontext („Vorhin am
 * Telefon: …“, höchstens 4.000 Zeichen, jüngste Äußerungen zuerst
 * behalten), bei jedem Motor, voll wie fortgesetzt. Ein Denkauftrag
 * verbraucht ihn nicht, andere Gespräche sehen ihn nie.
 *
 * Motoren, Prompt-Bau und Fallback sind Attrappen; Session-Ablage und
 * Einstellungsdatei echt (Temp-Dateien). Der Anschluss (createBotCall) läuft
 * mit Attrappen für Erkenner und Gehirn. Kein echtes Modell, kein Telegram.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCallRecap, CALL_RECAP_HEADING, CALL_RECAP_MAX_CHARS, formatCallRecap, resetCallRecapsForTests, takeCallRecap } from "../src/lib/call-recap";
import { resolveStreamingLimits, runStreamingTurn, TURN_HINT_HEADING, type ChatTurnDeps, type TurnOptions, type TurnSink } from "../src/lib/chat-turn";
import { resetEngineChoiceForTests, resolveEngine, type EngineChoiceDeps } from "../src/lib/engine-choice";
import type { Engine, EngineId, EngineRequest, EngineResult, EngineStatus } from "../src/lib/engines";
import { abortExecutions } from "../src/lib/execution-context";
import { getResumableSession, getSessionsForKey, recordSessionTurn, resetSession, sessionEpoch, setSessionsFileForTests, takeExpiredSession } from "../src/lib/session-manager";
import { getSettings, setSettingsPath, type Settings } from "../src/lib/settings";
import { createSpeech } from "../src/lib/speech/chain";
import type { SttProvider, WarmStt } from "../src/lib/speech/types";
import type { CallModelResolution } from "../src/lib/voice-brain/call-model";
import type { BrainBackend } from "../src/lib/voice-brain/types";
import { createBotCall, type BotCallDeps } from "../src/web/bot-call";
import { createBotChat, createTelegramChat, type WebSavedMessage } from "../src/web/bot-turn";
import { CallSession } from "../src/web/call-session";
import { fakeClock, fakeSocket, flush } from "./call-fixture";

const DM = "4711";
const GROUP = "-1001234567890";
const WEB_ID = "0b3c6a2e-1f00-4c1a-9d0e-2a4b6c8d0e1f";
const OTHER_WEB_ID = "1c4d7b3f-2a11-4d2b-8e1f-3b5c7d9e1f20";
const READY: EngineStatus = { engine: "codex", checked: true, installed: true, loggedIn: true };

interface Call extends EngineRequest {
  engine: EngineId;
}

let dir: string;
let settingsFile: string;
let calls: Call[];
let errorSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let tick = 5_000;

function fakeEngine(id: EngineId): Engine {
  let n = 0;
  return {
    id,
    describe: () => `Attrappe ${id}`,
    async run(req) {
      calls.push({ ...req, engine: id });
      n++;
      return { engine: id, text: `antwort-${id}`, sessionId: `${id}-s${n}`, isError: false } as EngineResult;
    },
  };
}

async function putSettings(content: Settings): Promise<void> {
  await writeFile(settingsFile, JSON.stringify(content));
  tick += 10;
  await utimes(settingsFile, tick, tick);
}

function setup() {
  const engines: Record<EngineId, Engine> = { claude: fakeEngine("claude"), codex: fakeEngine("codex"), opencode: fakeEngine("opencode") };
  const deps: Partial<ChatTurnDeps> = {
    getEngine: id => engines[id],
    resolveEngine: (key, d: Partial<EngineChoiceDeps> | undefined, turn) =>
      resolveEngine(key, { ...d, env: () => ({}), checkEngine: async id => ({ ...READY, engine: id }), log: () => {} }, turn),
    forgetEngineCheck: () => {},
    runFallbackChain: async () => ({ text: "ersatz", source: "openrouter", model: "ersatz" }),
    buildPromptContext: async o => ({ fullPrompt: `voll: ${o.userMessage}`, fallbackContext: "kontext" }),
    buildResumePrompt: async o => `fortgesetzt: ${o.userMessage}`,
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
    getAgentConfig: () => ({ model: "claude-agent-modell", effort: "high" }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
    getSettings,
    resolveStreamingLimits: () => resolveStreamingLimits({}),
    reportSecrets: () => [],
    setTimer: () => 0,
    clearTimer: () => {},
    now: () => 0,
  };
  const saved: WebSavedMessage[] = [];
  const mirrored: string[] = [];
  const base = {
    runStreamingTurn: (o: TurnOptions) => runStreamingTurn({ ...o, deps }),
    saveMessage: async (m: WebSavedMessage) => {
      saved.push(m);
      return true;
    },
    processIntents: async () => {},
    abortEngineCalls: (key: string) => abortExecutions(key),
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    log: () => {},
  };
  const web = createBotChat(base);
  const telegram = createTelegramChat({
    ...base,
    userId: DM,
    groupId: () => GROUP,
    agentForTopic: () => "research",
    sendPlain: async (_chat, text) => void mirrored.push(text),
    sendAsAgent: async (_agent, _chat, text) => void mirrored.push(text),
  });
  const sink: TurnSink = { progress: () => {}, notice: () => {} };
  return { web, telegram, sink, saved, mirrored };
}

const count = (text: string, part: string) => text.split(part).length - 1;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tybo-260-recap-"));
  settingsFile = join(dir, "settings.json");
  setSettingsPath(settingsFile);
  setSessionsFileForTests(join(dir, "sessions.json"));
  resetEngineChoiceForTests();
  resetCallRecapsForTests();
  calls = [];
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  setSettingsPath();
  setSessionsFileForTests(null);
  resetCallRecapsForTests();
  await rm(dir, { recursive: true, force: true });
});

describe("Merker", () => {
  test("genau einmal, danach leer; Gespräche getrennt", () => {
    addCallRecap("web:a", { userText: "Wie wird das Wetter?", replyText: "Sonnig.", agentLabel: "tybo" });
    addCallRecap("web:b", { userText: "Anderes Gespräch", replyText: "Ja.", agentLabel: "tybo" });
    const a = takeCallRecap("web:a")!;
    expect(a.startsWith(`${CALL_RECAP_HEADING}\nDu: Wie wird das Wetter?\ntybo: Sonnig.`)).toBe(true);
    expect(a).not.toContain("Anderes Gespräch");
    expect(takeCallRecap("web:a")).toBeUndefined();
    expect(takeCallRecap("web:b")).toContain("Anderes Gespräch");
  });

  test("über 4.000 Zeichen: die jüngsten Äußerungen bleiben, die ältesten fallen weg", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Du: Äußerung ${String(i).padStart(3, "0")} ${"x".repeat(80)}`);
    const text = formatCallRecap(lines);
    // Die ganze Rückgabe zählt: Überschrift, Kürzungshinweis, Zeilen und Erläuterung
    expect(text.length).toBeLessThanOrEqual(CALL_RECAP_MAX_CHARS);
    expect(text.length).toBeGreaterThan(CALL_RECAP_MAX_CHARS - 100);
    expect(text.startsWith(`${CALL_RECAP_HEADING}\n(Ältere Äußerungen weggelassen)\n`)).toBe(true);
    expect(text).toContain("Nutze es als Kontext, wiederhole es nicht.");
    const body = text.split("\n").filter(l => l.startsWith("Du: "));
    expect(body.at(-1)).toContain("Äußerung 099");
    expect(text).not.toContain("Äußerung 000");
    // Eine einzige zu lange jüngste Zeile: von vorn gekürzt, das Ende bleibt, der ganze Hinweis passt
    const long = formatCallRecap([`Du: ${"a".repeat(5000)}ENDE`]);
    expect(long.length).toBeLessThanOrEqual(CALL_RECAP_MAX_CHARS);
    expect(long.startsWith(`${CALL_RECAP_HEADING}\n(Ältere Äußerungen weggelassen)\n…`)).toBe(true);
    expect(long).toContain("aENDE\n\nDas hat der Nutzer");
    // Über takeCallRecap genauso, auch bei vielen langen Turns
    for (let i = 0; i < 60; i++) addCallRecap("web:lang", { userText: `Frage ${i} ${"y".repeat(150)}`, replyText: `Antwort ${i} ${"z".repeat(150)}`, agentLabel: "tybo" });
    const taken = takeCallRecap("web:lang")!;
    expect(taken.length).toBeLessThanOrEqual(CALL_RECAP_MAX_CHARS);
    expect(taken).toContain("Antwort 59");
    expect(taken.endsWith("Nutze es als Kontext, wiederhole es nicht.")).toBe(true);
    // Knapp unter der Grenze: nichts gekürzt, kein Kürzungshinweis
    const short = formatCallRecap(["Du: kurz", "tybo: auch kurz"]);
    expect(short).not.toContain("weggelassen");
  });
});

describe("nächster getippter Turn", () => {
  for (const engine of ["claude", "codex", "opencode"] as const) {
    test(`${engine}: voller Prompt trägt den Hinweis einmal, der zweite Turn (fortgesetzt) nicht mehr`, async () => {
      if (engine !== "claude") await putSettings({ engine: { default: engine } });
      const s = setup();
      addCallRecap(`web:${WEB_ID}`, { userText: "Merk dir den Zahnarzt am Freitag.", replyText: "Mach ich.", agentLabel: "tybo" });
      await s.web.runTurn({ conversationId: WEB_ID, agent: "general", text: "Wann war das nochmal?", sink: s.sink });
      await s.web.runTurn({ conversationId: WEB_ID, agent: "general", text: "Danke.", sink: s.sink });
      expect(calls.map(c => c.engine)).toEqual([engine, engine]);
      expect(calls[0]!.prompt.startsWith("voll: Wann war das nochmal?")).toBe(true);
      expect(count(calls[0]!.prompt, CALL_RECAP_HEADING)).toBe(1);
      expect(count(calls[0]!.prompt, TURN_HINT_HEADING)).toBe(1);
      expect(calls[0]!.prompt).toContain("Du: Merk dir den Zahnarzt am Freitag.");
      expect(calls[1]!.prompt).toBe("fortgesetzt: Danke.");
      // Nie in der gespeicherten Nachricht
      expect(s.saved.map(m => m.content).join("\n")).not.toContain(CALL_RECAP_HEADING);
    });
  }

  for (const engine of ["claude", "codex", "opencode"] as const) {
    test(`${engine}: fortgesetzter Prompt trägt den Hinweis ebenfalls genau einmal`, async () => {
      if (engine !== "claude") await putSettings({ engine: { default: engine } });
      const s = setup();
      await s.web.runTurn({ conversationId: WEB_ID, agent: "general", text: "Hallo", sink: s.sink });
      addCallRecap(`web:${WEB_ID}`, { userText: "Ruf morgen den Handwerker an.", replyText: "Notiert.", agentLabel: "tybo" });
      await s.web.runTurn({ conversationId: WEB_ID, agent: "general", text: "Was hatten wir besprochen?", sink: s.sink });
      await s.web.runTurn({ conversationId: WEB_ID, agent: "general", text: "Und sonst?", sink: s.sink });
      expect(calls.map(c => c.engine)).toEqual([engine, engine, engine]);
      expect(calls[1]!.resumeSessionId).toBe(`${engine}-s1`);
      expect(calls[1]!.prompt.startsWith("fortgesetzt: Was hatten wir besprochen?")).toBe(true);
      expect(count(calls[1]!.prompt, CALL_RECAP_HEADING)).toBe(1);
      expect(count(calls[1]!.prompt, "Du: Ruf morgen den Handwerker an.")).toBe(1);
      // Danach verbraucht
      expect(calls[2]!.prompt).toBe("fortgesetzt: Und sonst?");
    });
  }

  test("Sprech-Hinweis und Telefon-Hinweis zusammen unter einer Überschrift", async () => {
    const s = setup();
    addCallRecap(`web:${WEB_ID}`, { userText: "Test", replyText: "Ok.", agentLabel: "tybo" });
    await s.web.runTurn({ conversationId: WEB_ID, agent: "general", text: "Und?", sink: s.sink, speech: true });
    expect(count(calls[0]!.prompt, TURN_HINT_HEADING)).toBe(1);
    expect(calls[0]!.prompt).toContain("vorgelesen");
    expect(count(calls[0]!.prompt, CALL_RECAP_HEADING)).toBe(1);
  });

  test("Denkauftrag (noTelegram) verbraucht ihn nicht, der folgende getippte Turn bekommt ihn", async () => {
    const s = setup();
    addCallRecap(`web:${WEB_ID}`, { userText: "Vergleich bitte drei Wärmepumpen.", replyText: "Das arbeite ich in Ruhe aus.", agentLabel: "tybo" });
    await s.web.runTurn({ conversationId: WEB_ID, agent: "general", text: "Denkauftrag aus dem Telefongespräch: X", sink: s.sink, noTelegram: true });
    expect(calls[0]!.prompt).not.toContain(CALL_RECAP_HEADING);
    await s.web.runTurn({ conversationId: WEB_ID, agent: "general", text: "Und, was kam raus?", sink: s.sink });
    expect(count(calls[1]!.prompt, CALL_RECAP_HEADING)).toBe(1);
  });

  test("anderes Gespräch sieht ihn nie; Telegram-Topic mit eigenem Schlüssel, nichts zusätzlich nach Telegram", async () => {
    const s = setup();
    addCallRecap(`web:${WEB_ID}`, { userText: "Nur hier", replyText: "Ok.", agentLabel: "tybo" });
    addCallRecap(`topic:${GROUP}:7`, { userText: "Im Topic gesagt", replyText: "Gut.", agentLabel: "tybo" });
    await s.web.runTurn({ conversationId: OTHER_WEB_ID, agent: "general", text: "Hallo", sink: s.sink });
    expect(calls[0]!.prompt).not.toContain(CALL_RECAP_HEADING);
    await s.telegram.runTurn({ conversationId: "topic-7", agent: "research", text: "Weiter", sink: s.sink });
    expect(calls[1]!.prompt).toContain("Du: Im Topic gesagt");
    expect(calls[1]!.prompt).not.toContain("Nur hier");
    // Gespiegelt wird nur die getippte Nachricht und die Antwort, nie der Hinweis
    expect(s.mirrored.join("\n")).not.toContain(CALL_RECAP_HEADING);
    expect(s.mirrored.join("\n")).not.toContain("Im Topic gesagt");
  });
});

// --- Anschluss: onTurn merkt sich das Gespräch unter dem Schlüssel des Chat-Kerns ---

const RESOLVED: CallModelResolution = {
  spec: "claude:claude-sonnet-5-5",
  kind: "claude",
  model: "claude-sonnet-5-5",
  via: "api",
  effort: "low",
  ready: true,
  expectation: "erster Satz nach rund 1,5 Sekunden",
  billing: "anthropic-api",
  costsMoney: true,
  setting: "auto",
  source: "code",
};

function botDeps(recaps?: Array<{ key: string; userText: string; replyText: string }>): BotCallDeps {
  const stt: SttProvider = {
    id: "parakeet",
    label: "Parakeet",
    local: true,
    available: () => ({ ok: true }),
    transcribe: async () => "x",
    canWarm: () => true,
    warm: async (): Promise<WarmStt> => ({ transcribe: async () => "Wie wird das Wetter?", close: () => {} }),
  };
  const speech = createSpeech({ stt: [stt], tts: [], getSettings: () => ({}) as Settings, env: () => ({}), log: () => {}, readFile: async () => Buffer.alloc(0) });
  return {
    userId: DM,
    groupId: () => GROUP,
    agentForTopic: () => "research",
    speech: () => speech,
    resolve: async () => RESOLVED,
    createBackend: () =>
      ({
        id: "fake",
        label: "Attrappe",
        async *stream() {
          yield { text: "Sonnig und mild. " };
        },
        prepare: async () => {},
        close: () => {},
      }) as BrainBackend,
    loadContext: async () => "KONTEXT",
    reserveRequest: () => () => {},
    readRestart: async () => null,
    isIntakeClosed: () => false,
    env: {},
    log: () => {},
    searchAvailable: () => false,
    processIntents: async () => ({ outcome: "none" }) as never,
    saveMessage: async () => true,
    // Ohne Liste: der echte Merker (addCallRecap), den der Chat-Kern liest
    ...(recaps ? { addRecap: (key: string, t: { userText: string; replyText: string }) => void recaps.push({ key, userText: t.userText, replyText: t.replyText }) } : {}),
  };
}

/** Ein Telefonat mit einem Turn über den Anschluss: „Wie wird das Wetter?“, „Sonnig und mild.“, auflegen */
async function callOnce(conversationId: string, deps: BotCallDeps): Promise<void> {
  const s = fakeSocket();
  const session = new CallSession({
    socket: s.socket,
    port: createBotCall(deps),
    checkConversation: async () => ({ ok: true, agent: "research" }),
    clock: fakeClock(),
    log: () => {},
    onEnd: () => {},
  });
  session.begin();
  const send = (m: Record<string, unknown>) => session.receive(JSON.stringify(m));
  send({ type: "start", conversationId, tts: "browser" });
  for (let i = 0; i < 20 && !s.json("ready").length; i++) await flush();
  for (let i = 0; i < 25; i++) session.receive(new Uint8Array(640).fill(1));
  send({ type: "utterance_end" });
  await flush(20);
  for (const m of s.json("sentence")) send({ type: "played", id: m.id });
  await flush(20);
  send({ type: "hangup" });
  await flush();
}

const CONVERSATIONS = [
  [WEB_ID, `web:${WEB_ID}`],
  ["dm", `dm:${DM}`],
  ["topic-1", `group:${GROUP}`],
  ["topic-7", `topic:${GROUP}:7`],
] as const;

describe("Anschluss merkt sich den Turn", () => {
  for (const [conversationId, key] of CONVERSATIONS) {
    test(`${conversationId}: Schlüssel ${key}, nur Gesprochenes`, async () => {
      const recaps: Array<{ key: string; userText: string; replyText: string }> = [];
      await callOnce(conversationId, botDeps(recaps));
      expect(recaps).toEqual([{ key, userText: "Wie wird das Wetter?", replyText: "Sonnig und mild." }]);
    });
  }
});

describe("Telefonat über den Anschluss, unmittelbar danach ein getippter Turn", () => {
  for (const engine of ["claude", "codex", "opencode"] as const) {
    for (const [conversationId] of CONVERSATIONS) {
      test(`${engine}, ${conversationId}: der getippte Turn kennt das Telefonat genau einmal, der nächste nicht mehr`, async () => {
        if (engine !== "claude") await putSettings({ engine: { default: engine } });
        const s = setup();
        const chat = conversationId === WEB_ID ? s.web : s.telegram;
        const agent = conversationId === "topic-7" ? "research" : "general";
        // Eine Session gibt es schon: der getippte Turn nach dem Telefonat ist fortgesetzt
        await chat.runTurn({ conversationId, agent, text: "Hallo", sink: s.sink });
        await callOnce(conversationId, botDeps());
        await chat.runTurn({ conversationId, agent, text: "Was hatte ich gefragt?", sink: s.sink });
        await chat.runTurn({ conversationId, agent, text: "Danke.", sink: s.sink });
        expect(calls.map(c => c.engine)).toEqual([engine, engine, engine]);
        expect(calls[1]!.resumeSessionId).toBe(`${engine}-s1`);
        expect(calls[1]!.prompt.startsWith("fortgesetzt: Was hatte ich gefragt?")).toBe(true);
        expect(count(calls[1]!.prompt, CALL_RECAP_HEADING)).toBe(1);
        expect(count(calls[1]!.prompt, "Du: Wie wird das Wetter?")).toBe(1);
        expect(count(calls[1]!.prompt, "Sonnig und mild.")).toBe(1);
        expect(calls[2]!.prompt).toBe("fortgesetzt: Danke.");
        expect(s.mirrored.join("\n")).not.toContain(CALL_RECAP_HEADING);
      });
    }
  }

  test("Telefonat im einen Gespräch, getippter Turn im anderen: kein Hinweis", async () => {
    const s = setup();
    await callOnce(WEB_ID, botDeps());
    await s.web.runTurn({ conversationId: OTHER_WEB_ID, agent: "general", text: "Hallo", sink: s.sink });
    expect(calls[0]!.prompt).not.toContain(CALL_RECAP_HEADING);
    await s.web.runTurn({ conversationId: WEB_ID, agent: "general", text: "Und hier?", sink: s.sink });
    expect(count(calls[1]!.prompt, CALL_RECAP_HEADING)).toBe(1);
  });
});
