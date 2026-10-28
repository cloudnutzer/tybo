/**
 * Issue #336: Antwort auf eine Nachricht direkt aus Telegram
 * (src/channels/telegram/reply-turn.ts mit dem gemeinsamen Abschluss aus
 * src/lib/turn-finish.ts, verdrahtet als telegramReply in src/bot.ts).
 * Geprüft wird das Verhalten ohne bot.ts: erst die Antwort, dann genau eine
 * Rückfrage im Gespräch des Turns über offerAsk, kein eigener
 * Auftrag mit Knöpfen, keine Rückfrage bei [INVOKE:] oder Abbruch, und ein
 * scheiterndes Anbieten kostet die Antwort nicht.
 *
 * Der Turn läuft durch den echten Chat-Kern (runStreamingTurn); Motor,
 * Prompt-Bau und offerAsk sind Attrappen, Session-Ablage und Einstellungen
 * echte Temp-Dateien.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelegramReply, type TelegramReplyDeps } from "../src/channels/telegram/reply-turn";
import { createTurnFinish } from "../src/lib/turn-finish";
import { ABORT_REPLY, SHUTDOWN_ABORT_REPLY, resolveStreamingLimits, runStreamingTurn, type ChatTurnDeps, type TurnQuestion } from "../src/lib/chat-turn";
import type { AskOffer, AskOfferOutcome } from "../src/lib/ask-choices";
import { resetEngineChoiceForTests, resolveEngine } from "../src/lib/engine-choice";
import type { Engine, EngineId, EngineResult } from "../src/lib/engines";
import {
  getResumableSession,
  getSessionsForKey,
  recordSessionTurn,
  resetSession,
  sessionEpoch,
  setSessionsFileForTests,
  takeExpiredSession,
} from "../src/lib/session-manager";
import { getSettings, setSettingsPath } from "../src/lib/settings";
import { threadConversation } from "../src/lib/threads/detect";
import type { TurnTools } from "../src/lib/turn-tools";

const DM = "4711";
const GROUP = "-1001234567890";
const TAGGED = "Entwurf fertig.\n\n[FRAGE: Soll ich ihn verschicken? | Ja, verschicken | Nein]";
const READABLE = "Entwurf fertig.\n\nSoll ich ihn verschicken?\n- Ja, verschicken\n- Nein";
const OFFERED = { status: "offered", taskId: "t1" } as unknown as AskOfferOutcome;

let dir: string;
let replies: Partial<EngineResult>[];
let spies: ReturnType<typeof spyOn>[];

function fakeEngine(id: EngineId): Engine {
  let n = 0;
  return {
    id,
    describe: () => `Attrappe ${id}`,
    async run() {
      n++;
      return { engine: id, text: `antwort-${id}`, sessionId: `${id}-s${n}`, isError: false, ...replies.shift() };
    },
  };
}

interface Ctx {
  name: string;
}

function setup(
  opts: {
    offer?: (o: AskOffer) => Promise<AskOfferOutcome>;
    shuttingDown?: boolean;
    question?: (q: TurnQuestion) => TurnQuestion;
    afterTurn?: () => void;
    hint?: string;
  } = {}
) {
  const events: string[] = [];
  const offers: AskOffer[] = [];
  const invoked: string[] = [];
  const saved: string[] = [];
  const metadata: unknown[] = [];
  const intents: unknown[] = [];
  const goals: string[] = [];
  const threadTexts: string[] = [];
  const hints: { asked: string[]; passed: (string | undefined)[] } = { asked: [], passed: [] };
  const engine = fakeEngine("claude");
  const turnDeps: Partial<ChatTurnDeps> = {
    getEngine: () => engine,
    resolveEngine: (key, d) => resolveEngine(key, { ...d, env: () => ({}), checkEngine: async id => ({ engine: id, checked: true, installed: true, loggedIn: true }), log: () => {} }),
    forgetEngineCheck: () => {},
    runFallbackChain: async () => ({ text: "Ersatz.", source: "none" }),
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
    offerAsk: async o => {
      offers.push(o);
      events.push("offer");
      return opts.offer ? opts.offer(o) : OFFERED;
    },
    questionConversation: async (chatId, topicId) => threadConversation(chatId, topicId),
  };
  const deps: TelegramReplyDeps<Ctx> = {
    // Wie callClaudeWithProgressUnlocked in bot.ts: der Turn bekommt die Rückmeldungen des Sammlers und onQuestion
    runTurn: async (_ctx, run) => {
      hints.passed.push(run.turnHint);
      const text = await runStreamingTurn({
        userMessage: run.userMessage,
        chatId: run.chatId,
        agentName: run.agentName,
        ...(run.topicId !== undefined ? { topicId: run.topicId } : {}),
        sink: { progress: () => {}, notice: () => {} },
        onInfo: run.collector.onInfo,
        onTools: run.collector.onTools,
        onSessionId: run.collector.onSessionId,
        onSessionMeta: run.collector.onSessionMeta,
        onQuestion: q => run.onQuestion(opts.question ? opts.question(q) : q),
        deps: turnDeps,
      });
      // Abbruch, der erst nach dem Turn als Ausnahme ankommt (etwa aus der Warteschlange)
      opts.afterTurn?.();
      return text;
    },
    typing: () => ({ start: () => {}, stop: () => {} }),
    reply: async (ctx, text) => void events.push(`reply:${ctx.name}:${text}`),
    sendAsAgent: async (agent, chatId, text, options) => void events.push(`send:${agent}:${chatId}:${options.threadId ?? "-"}:${text}`),
    // Der echte gemeinsame Abschluss (Issue #339), Attrappen nur für Speicher, Tor, Goal und Konsultation
    finishTurn: createTurnFinish({
      invoke: async (from, invocation, _chatId, _topicId, delivered) => {
        invoked.push(`${from}->${invocation.targetAgent}`);
        await delivered(invocation.targetAgent, `Antwort von ${invocation.targetAgent}`);
      },
      invokeBudget: 3,
      saveMessage: async m => {
        saved.push(m.content);
        metadata.push(m.metadata);
      },
      processIntents: async (text, tools, target) => void intents.push({ text, tools, target }),
      onGoalTurn: (key, agent) => void goals.push(`${key}:${agent}`),
      noteThreads: (chatId, topicId, userText) => {
        events.push(`threads:${chatId}:${topicId ?? "-"}`);
        threadTexts.push(userText);
      },
      logError: () => {},
    }),
    threadTurnHint: async (chatId, topicId) => {
      hints.asked.push(`${chatId}:${topicId ?? "-"}`);
      return opts.hint;
    },
    isShuttingDown: () => opts.shuttingDown ?? false,
    afterTurn: () => void events.push("after"),
    logError: () => {},
  };
  return { reply: createTelegramReply(deps), events, offers, invoked, saved, metadata, hints, intents, goals, threadTexts };
}

const ctx: Ctx = { name: "nachricht" };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tybo-336-telegram-"));
  setSettingsPath(join(dir, "settings.json"));
  setSessionsFileForTests(join(dir, "sessions.json"));
  resetEngineChoiceForTests();
  replies = [];
  spies = [spyOn(console, "error").mockImplementation(() => {}), spyOn(console, "warn").mockImplementation(() => {})];
});

afterEach(async () => {
  for (const s of spies) s.mockRestore();
  setSettingsPath();
  setSessionsFileForTests(null);
  await rm(dir, { recursive: true, force: true });
});

describe("Telegram: Antwort und Rückfrage (ohne bot.ts)", () => {
  test("Topic: erst die Antwort, dann genau eine Rückfrage im Topic, dann die Fäden", async () => {
    const s = setup();
    const tools = { uses: [{ name: "WebFetch", input: { url: "https://example.org" } }] } as unknown as TurnTools;
    replies = [{ text: TAGGED, sessionId: "S-7", tools }];
    await s.reply({ ctx, chatId: GROUP, topicId: 7, userMessage: "Schreib den Entwurf", agentName: "research", threads: true });
    expect(s.events).toEqual([`send:research:${GROUP}:7:${READABLE}`, "offer", `threads:${GROUP}:7`, "after"]);
    expect(s.offers).toEqual([
      {
        conversation: { type: "telegram", chatId: GROUP, topicId: 7 },
        question: "Soll ich ihn verschicken?",
        options: ["Ja, verschicken", "Nein"],
        originalPrompt: "Schreib den Entwurf",
        agent: "research",
        engine: "claude",
        model: "claude-agent-modell",
        sessionId: "S-7",
      },
    ]);
    expect(s.saved).toEqual([READABLE]);
    // Merk-Tags durchs Tor, mit Werkzeugen und Ziel des Turns
    expect(s.intents).toEqual([{ text: READABLE, tools, target: { chatId: GROUP, topicId: 7, origin: "Telegram" } }]);
    // Modell, Motor und Dauer der Antwort am gespeicherten Verlauf
    expect(s.metadata).toEqual([{ agent: "research", topicId: 7, model: "claude-agent-modell", engine: "claude", durationMs: 0 }]);
  });

  test("Direktchat: Rückfrage im Direktchat, ohne Topic", async () => {
    const s = setup();
    replies = [{ text: TAGGED }];
    await s.reply({ ctx, chatId: DM, userMessage: "Schreib den Entwurf", agentName: "general" });
    expect(s.offers.map(o => o.conversation)).toEqual([{ type: "telegram", chatId: DM }]);
    expect(s.events).toEqual([`send:general:${DM}:-:${READABLE}`, "offer", "after"]);
  });

  test("kein zusätzlicher atask-Auftrag: einziger Weg ist offerAsk, eine Nachricht ohne Knöpfe", async () => {
    const s = setup();
    replies = [{ text: TAGGED }];
    await s.reply({ ctx, chatId: GROUP, topicId: 7, userMessage: "x", agentName: "research" });
    const sends = s.events.filter(e => e.startsWith("send:") || e.startsWith("reply:"));
    expect(sends).toHaveLength(1);
    expect(s.events.join("\n")).not.toContain("atask:");
    expect(s.offers).toHaveLength(1);
  });

  test("Hinweis auf einen offenen Faden nur bei Nachrichten (threads), an den Turn durchgereicht", async () => {
    const s = setup({ hint: "Offen: Reiseziel" });
    replies = [{ text: "a" }, { text: "b" }];
    await s.reply({ ctx, chatId: GROUP, topicId: 7, userMessage: "x", agentName: "research", threads: true });
    await s.reply({ ctx, chatId: GROUP, topicId: 7, userMessage: "/befehl", agentName: "research" });
    expect(s.hints.asked).toEqual([`${GROUP}:7`]);
    expect(s.hints.passed).toEqual(["Offen: Reiseziel", undefined]);
  });

  test("Antwort ohne Rückfrage: nichts angeboten", async () => {
    const s = setup();
    replies = [{ text: "Warum ist das wichtig? Weil sonst die Daten verloren gehen." }];
    await s.reply({ ctx, chatId: DM, userMessage: "x", agentName: "general", threads: true });
    expect(s.offers).toHaveLength(0);
    expect(s.events).toEqual([`send:general:${DM}:-:Warum ist das wichtig? Weil sonst die Daten verloren gehen.`, `threads:${DM}:-`, "after"]);
  });

  test("[INVOKE:]: keine Rückfrage, erst antworten die befragten Agenten", async () => {
    const s = setup();
    replies = [{ text: `${TAGGED}\n[INVOKE:finance|Was kostet das?]` }];
    await s.reply({ ctx, chatId: GROUP, topicId: 7, userMessage: "x", agentName: "research", threads: true });
    expect(s.offers).toHaveLength(0);
    expect(s.invoked).toEqual(["research->finance"]);
    expect(s.events).toEqual([`send:research:${GROUP}:7:${READABLE}`, `threads:${GROUP}:7`, "after"]);
    // Antwort des befragten Agenten zusätzlich gespeichert, mit Absender
    expect(s.saved.at(-1)).toBe("Antwort von finance");
    expect(s.metadata.at(-1)).toEqual({ agent: "finance", topicId: 7, invokedBy: "research" });
  });

  test("Goal-Hook mit dem Session-Schlüssel des Gesprächs, Fäden mit dem Text der Nachricht", async () => {
    const s = setup();
    replies = [{ text: "a" }, { text: "b" }];
    await s.reply({ ctx, chatId: GROUP, topicId: 7, userMessage: "im Topic", agentName: "research", threads: true });
    await s.reply({ ctx, chatId: DM, userMessage: "im Direktchat", agentName: "general", threads: true });
    expect(s.goals).toEqual([`topic:${GROUP}:7:research`, `dm:${DM}:general`]);
    expect(s.threadTexts).toEqual(["im Topic", "im Direktchat"]);
  });

  test("Abbruch: kein Goal-Hook, keine Merk-Tags, keine Fäden", async () => {
    const s = setup();
    replies = [{ aborted: true, text: TAGGED }];
    await s.reply({ ctx, chatId: GROUP, topicId: 7, userMessage: "x", agentName: "research", threads: true });
    expect(s.goals).toEqual([]);
    expect(s.intents).toEqual([]);
    expect(s.events.some(e => e.startsWith("threads:"))).toBe(false);
  });

  test("Abbruch (/stop): keine Rückfrage, nichts gespeichert, nur die Abbruch-Meldung", async () => {
    const s = setup();
    replies = [{ aborted: true, text: TAGGED }];
    await s.reply({ ctx, chatId: GROUP, topicId: 7, userMessage: "x", agentName: "research", threads: true });
    expect(s.offers).toHaveLength(0);
    expect(s.saved).toHaveLength(0);
    expect(s.events).toEqual([`reply:nachricht:${ABORT_REPLY}`, "after"]);
  });

  test("Abbruch durch Neustart: ehrliche Meldung, keine Rückfrage", async () => {
    const s = setup({ shuttingDown: true });
    replies = [{ aborted: true, text: TAGGED }];
    await s.reply({ ctx, chatId: DM, userMessage: "x", agentName: "general" });
    expect(s.offers).toHaveLength(0);
    expect(s.events).toEqual([`reply:nachricht:${SHUTDOWN_ABORT_REPLY}`, "after"]);
  });

  test("Abbruch, der erst als Ausnahme ankommt: keine Rückfrage, keine Fehlermeldung", async () => {
    const s = setup({
      afterTurn: () => {
        throw Object.assign(new Error("abgebrochen"), { name: "AbortError" });
      },
    });
    replies = [{ text: TAGGED }];
    await s.reply({ ctx, chatId: DM, userMessage: "x", agentName: "general", threads: true });
    expect(s.offers).toHaveLength(0);
    expect(s.events).toEqual([`reply:nachricht:${ABORT_REPLY}`, "after"]);
  });

  test("Angebot scheitert im Register: Antwort bleibt, die Fäden laufen trotzdem", async () => {
    const s = setup({
      offer: async () => {
        throw new Error("Register kaputt");
      },
    });
    replies = [{ text: TAGGED }];
    await s.reply({ ctx, chatId: GROUP, topicId: 7, userMessage: "x", agentName: "research", threads: true });
    expect(s.saved).toEqual([READABLE]);
    expect(s.events).toEqual([`send:research:${GROUP}:7:${READABLE}`, "offer", `threads:${GROUP}:7`, "after"]);
  });

  test("offer() wirft trotzdem: Antwort bleibt, keine Fehlermeldung, die Fäden laufen", async () => {
    const s = setup({
      question: q => ({
        ...q,
        offer: async () => {
          throw new Error("kaputt");
        },
      }),
    });
    replies = [{ text: TAGGED }];
    await s.reply({ ctx, chatId: DM, userMessage: "x", agentName: "general", threads: true });
    expect(s.events).toEqual([`send:general:${DM}:-:${READABLE}`, `threads:${DM}:-`, "after"]);
  });
});
