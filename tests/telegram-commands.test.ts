// Issue #344: Befehle aus Telegram als Verhalten: Gespräch und Agent je
// Befehl, /voice (Hinweis, Sprachnachricht, Text-Rückfall), /board mit den
// Agenten-Bots, Agenten-Turn ohne Rückgabe. Ersetzt die Quelltext-Prüfungen
// von telegramCommandInput, voiceReplyTelegram und runBoardMeeting in bot.ts.
import { describe, expect, test } from "bun:test";
import type { InputFile } from "grammy";
import { createTelegramBoard, createTelegramCommands, createVoiceReply, VOICE_TEXT, type CommandChat, type TelegramBoardDeps, type VoiceReplyDeps } from "../src/channels/telegram/commands";
import { ABORT_REPLY } from "../src/lib/chat-turn";
import type { CommandContext, CommandMatch, CommandServices } from "../src/lib/commands/types";
import { createTelegramBoardOutput, runBoardMeeting } from "../src/lib/board-meeting";
import { sessionKeyFor } from "../src/lib/store/message-rules";
import { turnInfoCollector } from "../src/lib/turn-collector";
import type { Message } from "../src/lib/store/types";

interface FakeChat extends CommandChat {
  log: string[];
}

function chat(): FakeChat {
  const log: string[] = [];
  return {
    log,
    reply: async text => void log.push(`reply:${text}`),
    replyWithVoice: async (voice: InputFile) => void log.push(`voice:${(voice as unknown as { filename?: string }).filename}`),
  };
}

const typing = (log: string[]) => () => ({ start: () => log.push("typing:start"), stop: () => log.push("typing:stop") });

function voiceDeps(overrides: Partial<VoiceReplyDeps<FakeChat>> = {}, saved: Message[] = [], intents: string[] = []): VoiceReplyDeps<FakeChat> {
  return {
    enabled: () => true,
    newTurn: turnInfoCollector,
    runTurn: async (_ctx, prompt, _chatId, agent, _topicId, turn) => {
      turn.onInfo({ agent, model: "m1", engine: "claude", durationMs: 12 } as never);
      return `Antwort auf ${prompt}`;
    },
    saveMessage: async m => void saved.push(m),
    processIntents: async (text, _tools, target) => void intents.push(`${text}|${target.chatId}|${target.topicId}|${target.origin}`),
    speak: async () => Buffer.from("mp3"),
    sendText: async (ctx, text) => void ctx.log.push(`text:${text}`),
    ...overrides,
  };
}

describe("/voice", () => {
  test("ohne Stimme nur der Hinweis, kein Modellaufruf", async () => {
    const ctx = chat();
    let turns = 0;
    await createVoiceReply(voiceDeps({ enabled: () => false, runTurn: async () => (turns++, "") }), typing(ctx.log))(ctx, "1", undefined, "general", "hi");
    expect(ctx.log).toEqual([`reply:${VOICE_TEXT.off}`]);
    expect(turns).toBe(0);
  });

  test("Antwort gespeichert (voice_reply, Modell), Merk-Tags, dann Sprachnachricht", async () => {
    const ctx = chat();
    const saved: Message[] = [];
    const intents: string[] = [];
    await createVoiceReply(voiceDeps({}, saved, intents), typing(ctx.log))(ctx, "1", 4, "research", "Wetter");
    expect(saved).toEqual([
      { chat_id: "1", role: "assistant", content: "Antwort auf Wetter", metadata: { agent: "research", type: "voice_reply", topicId: 4, model: "m1", engine: "claude", durationMs: 12 } },
    ]);
    expect(intents).toEqual(["Antwort auf Wetter|1|4|Telegram"]);
    expect(ctx.log).toEqual(["typing:start", "voice:response.mp3", "typing:stop"]);
  });

  test("ohne Audio: Hinweis und Text", async () => {
    const ctx = chat();
    await createVoiceReply(voiceDeps({ speak: async () => null }), typing(ctx.log))(ctx, "1", undefined, "general", "x");
    expect(ctx.log).toEqual(["typing:start", `reply:${VOICE_TEXT.noAudio}`, "text:Antwort auf x", "typing:stop"]);
  });

  test("Fehler: Entschuldigung, Tippen endet", async () => {
    const ctx = chat();
    const errors: string[] = [];
    await createVoiceReply(voiceDeps({ runTurn: async () => { throw new Error("weg"); }, logError: m => errors.push(m) }), typing(ctx.log))(ctx, "1", undefined, "general", "x");
    expect(ctx.log).toEqual(["typing:start", `reply:${VOICE_TEXT.failed}`, "typing:stop"]);
    expect(errors).toEqual(["/voice command error:"]);
  });
});

function boardDeps(log: string[], overrides: Partial<TelegramBoardDeps<FakeChat>> = {}): TelegramBoardDeps<FakeChat> {
  return {
    agents: () => ["research", "critic"],
    gatherData: async () => ({ agentData: {}, sharedSummary: "", fetchDurationMs: 1, errors: [] }),
    stripInvocationTags: t => t,
    ask: async (_prompt, chatId, agent, topicId, onInfo) => {
      onInfo({ agent, model: "m2", engine: "claude", durationMs: 3 } as never);
      return `${agent}@${chatId}/${topicId}`;
    },
    saveMessage: async m => void log.push(`save:${m.chat_id}:${(m.metadata as { agent?: string }).agent}`),
    sendAsAgent: async (agent, chatId, text, options) => void log.push(`send:${agent}:${chatId}:${options.threadId}:${text.slice(0, 20)}`),
    sendTypingAsAgent: async agent => void log.push(`typing:${agent}`),
    notice: async (ctx, text) => void ctx.log.push(`notice:${text}`),
    run: (deps, input, output) => runBoardMeeting({ ...deps, pauseMs: 0 }, input, output),
    output: createTelegramBoardOutput,
    ...overrides,
  };
}

describe("/board", () => {
  test("Beiträge vom Bot jedes Agenten im Topic, gespeichert im Gespräch", async () => {
    const log: string[] = [];
    await createTelegramBoard(boardDeps(log))(chat(), "-100", 7, "Thema");
    expect(log).toContain("typing:research");
    expect(log.some(l => l.startsWith("send:research:-100:7:research@-100/7"))).toBe(true);
    expect(log.some(l => l.startsWith("send:critic:-100:7:"))).toBe(true);
    expect(log).toContain("save:-100:research");
  });

  test("Abbruch eines Agenten beendet die Sitzung ohne Speichern seines Beitrags", async () => {
    const log: string[] = [];
    const ctx = chat();
    await createTelegramBoard(boardDeps(log, { ask: async () => ABORT_REPLY }))(ctx, "1", undefined, "");
    expect(log.filter(l => l.startsWith("save:"))).toEqual([]);
  });

  test("Sitzung läuft unter dem Session-Schlüssel des Gesprächs, leeres Thema ohne Zusatz", async () => {
    let seen: unknown;
    const deps = boardDeps([], { run: async (_d, input) => ((seen = input), { contributions: 0, synthesis: false, stopped: false, aborted: false, empty: true }) });
    await createTelegramBoard(deps)(chat(), "-100", 7, "");
    expect(seen).toEqual({ extraContext: undefined, sessionKey: sessionKeyFor("-100", 7), topicId: 7 });
  });
});

describe("createTelegramCommands", () => {
  test("Befehl bekommt Gespräch, Agent des Topics, Reset und Agenten-Turn", async () => {
    let context: CommandContext | undefined;
    const replies: string[] = [];
    const resets: string[] = [];
    const match = { command: { name: "probe", run: async (c: CommandContext) => void (context = c) }, args: "x" } as unknown as CommandMatch;
    const run = createTelegramCommands<FakeChat, { id: string }>({
      services: { listAgentNames: () => [] } as unknown as CommandServices,
      agentFor: (_c, topicId) => (topicId === 7 ? "finance" : "general"),
      typing: ctx => typing(ctx.log)(),
      sessionReset: {
        isActive: () => false,
        block: () => () => {},
        sessionsForKey: async () => [],
        shouldDistill: () => false,
        distill: async () => {},
        reset: async key => (resets.push(key), 1),
        sessionModeEnabled: () => true,
      },
      // Befehle starten Agenten-Turns ohne offene Fäden (Issue #290)
      agentReply: async r => void replies.push(`${r.agentName}:${r.userMessage}:${r.topicId}:${"threads" in r}`),
      voice: voiceDeps(),
      board: boardDeps([]),
    });
    const ctx = chat();
    await run(ctx, "-100", 7, "/probe x", match);
    expect(context!.channel).toBe("telegram");
    expect(context!.agent).toBe("finance");
    expect(context!.sessionKey).toBe(sessionKeyFor("-100", 7));
    expect(context!.services.voiceReply).toBeFunction();
    expect(await context!.agentTurn("critic", "prüf das")).toBeUndefined();
    expect(replies).toEqual(["critic:prüf das:7:false"]);
    expect(await context!.resetSession()).toEqual({ status: "done", reset: 1, sessionMode: true });
    expect(resets).toEqual([sessionKeyFor("-100", 7)]);
    const stop = context!.working();
    stop();
    expect(ctx.log).toEqual(["typing:start", "typing:stop"]);
  });
});
