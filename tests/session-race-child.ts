// Kindprozess für tests/session-race.test.ts (Issue #189): läuft im
// Temp-Verzeichnis, damit data/sessions.json dort landet. Echter
// Session-Speicher, Claude und Kontext sind Fakes. Ausgabe: JSON mit den
// Ergebnissen der Szenarien.
import { runJsonTurn, type ChatTurnDeps } from "../src/lib/chat-turn";
import { createRoutineFromSession } from "../src/lib/session-routine";
import { commandRegistry } from "../src/lib/commands/builtin";
import { runTelegramCommand } from "../src/lib/commands/telegram";
import type { CommandServices } from "../src/lib/commands/types";
import { getResumableSession, getSessionsForKey, recordSessionTurn, resetSession, resetSessionOrThrow, sessionEpoch, type BotSession } from "../src/lib/session-manager";
import { sessionKeyFor } from "../src/lib/supabase";
import type { ClaudeOptions, ClaudeResult } from "../src/lib/claude";
import { createReviewResults } from "../src/lib/review-choices";
import type { SendAndRecordResult } from "../src/lib/outbox";
import { createClaudeEngine } from "../src/lib/engines";

// Routine über den echten Claude-Motor mit gefälschtem Prozess (Issue #122)
const claudeEngine = (call: (o: ClaudeOptions) => Promise<ClaudeResult>) => () => createClaudeEngine({ callClaude: call, callClaudeStreaming: call });

const CHAT = "-100777";
const MODEL = "test-model";

function deps(onCall: (o: ClaudeOptions, n: number) => Promise<ClaudeResult>): Partial<ChatTurnDeps> {
  let n = 0;
  return {
    getEngine: () => createClaudeEngine({ callClaude: async (o) => onCall(o, ++n) }),
    buildPromptContext: async () => ({ fullPrompt: "voll", fallbackContext: "" }),
    buildResumePrompt: async () => "resume",
    isSessionModeEnabled: () => true,
    shouldDistill: () => false,
    distillSession: async () => {},
    log: async () => {},
    getAgentConfig: () => ({ model: MODEL }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
    getSettings: () => ({}),
    reportSecrets: () => [],
    callFallbackLLMWithSource: async () => ({ text: "fallback", source: "none" }),
  };
}

const sink = { progress() {}, notice() {} };
const turn = (topicId: number, agentName: string, d: Partial<ChatTurnDeps>) =>
  runJsonTurn({ userMessage: "Frage", chatId: CHAT, agentName, topicId, sink, deps: d });
const stored = async (topicId: number) =>
  (await getSessionsForKey(sessionKeyFor(CHAT, topicId))).map((s) => `${s.agentName}=${s.engineSessionId}`).sort();

const out: Record<string, unknown> = {};

// A: bestehende Session S, /new während des Turns, Turn endet mit S
{
  const key = sessionKeyFor(CHAT, 1);
  await recordSessionTurn(key, "general", MODEL, "claude", "S-alt");
  let resumed: string | undefined;
  await turn(1, "general", deps(async (o) => {
    resumed = o.resumeSessionId;
    await resetSession(key); // /new wie in src/bot.ts
    return { text: "antwort", sessionId: "S-alt" };
  }));
  out.a = { resumed, stored: await stored(1), resumable: (await getResumableSession(key, "general", MODEL, "claude"))?.engineSessionId ?? null };
}

// B: erster Turn ohne gespeicherte Session, /new während des Turns
{
  const key = sessionKeyFor(CHAT, 2);
  await turn(2, "general", deps(async () => {
    await resetSession(key);
    return { text: "antwort", sessionId: "S-neu" };
  }));
  out.b = await stored(2);
}

// C: /new setzt alle Agenten zurück, auch einen laufenden Turn eines anderen Agenten
{
  const key = sessionKeyFor(CHAT, 3);
  await recordSessionTurn(key, "general", MODEL, "claude", "S-general");
  await recordSessionTurn(key, "research", MODEL, "claude", "S-research");
  await turn(3, "research", deps(async () => {
    await resetSession(key);
    return { text: "antwort", sessionId: "S-research" };
  }));
  out.c = await stored(3);
}

// D: Gegenprobe ohne /new: der Turn speichert seine Session
{
  await turn(4, "general", deps(async () => ({ text: "antwort", sessionId: "S-normal" })));
  out.d = await stored(4);
}

// E: Resume scheitert, Neustart im selben Turn (reset nur dieses Agenten): Session wird gespeichert
{
  const key = sessionKeyFor(CHAT, 5);
  await recordSessionTurn(key, "general", MODEL, "claude", "S-kaputt");
  await turn(5, "general", deps(async (_o, n) => (n === 1 ? { text: "", isError: true } : { text: "antwort", sessionId: "S-frisch" })));
  out.e = await stored(5);
}

// F: nach dem /new speichert der nächste Turn wieder normal
{
  await turn(2, "general", deps(async () => ({ text: "antwort", sessionId: "S-danach" })));
  out.f = await stored(2);
}

// G: Löschen aus der WebUI (resetSessionOrThrow) wirkt genauso
{
  const key = sessionKeyFor(CHAT, 6);
  await turn(6, "general", deps(async () => {
    await resetSessionOrThrow(key);
    return { text: "antwort", sessionId: "S-web" };
  }));
  out.g = await stored(6);
}

// H: bestehende Session S, laufende /routine, /new, Routine endet mit neuer Session
{
  const key = sessionKeyFor(CHAT, 7);
  await recordSessionTurn(key, "general", MODEL, "claude", "S-routine");
  const session = (await getSessionsForKey(key)).find((s) => s.agentName === "general")!;
  let resumed: string | undefined;
  const result = await createRoutineFromSession(session, "", {
    getEngine: claudeEngine(async (o) => {
      resumed = o.resumeSessionId;
      await resetSession(key); // /new während der Routine
      return { text: "bericht", sessionId: "S-routine-neu" };
    }),
    log: async () => {},
  });
  out.h = { resumed, text: result.text, stored: await stored(7), resumable: (await getResumableSession(key, "general", MODEL, "claude"))?.engineSessionId ?? null };
}

// I: /routine über den Befehlsablauf: S ausgewählt, Startmeldung wartet,
// /new, Routine läuft weiter und endet mit neuer Session
{
  const key = sessionKeyFor(CHAT, 8);
  await recordSessionTurn(key, "general", MODEL, "claude", "S-befehl");
  let resumed: string | undefined;
  const sent: string[] = [];
  const services = {
    isSessionModeEnabled: () => true,
    sessionsForKey: getSessionsForKey,
    sessionEpoch,
    createRoutine: (session, hint, epoch) =>
      createRoutineFromSession(session as BotSession, hint, {
        getEngine: claudeEngine(async (o) => {
          resumed = o.resumeSessionId;
          return { text: "bericht", sessionId: "S-befehl-neu" };
        }),
        log: async () => {},
      }, epoch),
  } as Partial<CommandServices> as CommandServices;
  await runTelegramCommand({
    chat: {
      async reply(text) {
        // Die Startmeldung wartet, währenddessen kommt /new
        if (!sent.length) await resetSession(key);
        sent.push(text);
      },
    },
    chatId: CHAT,
    topicId: 8,
    sessionKey: key,
    agent: "general",
    text: "/routine",
    match: commandRegistry.match("/routine", "telegram")!,
    services,
    working: () => () => {},
    resetSession: async () => ({ status: "done", reset: 1, sessionMode: true }),
    agentTurn: async () => {},
    boardMeeting: async () => {},
  });
  out.i = { resumed, replies: sent.length, stored: await stored(8), resumable: (await getResumableSession(key, "general", MODEL, "claude"))?.engineSessionId ?? null };
}

// J: Routine-Knopf aus dem Session-Review: Entscheidung für S, Startmeldung
// wartet, /new, Routine setzt S fort und endet mit neuer Session
{
  const key = sessionKeyFor(CHAT, 9);
  await recordSessionTurn(key, "general", MODEL, "claude", "S-knopf");
  const session = (await getSessionsForKey(key)).find((s) => s.agentName === "general")!;
  let resumed: string | undefined;
  const sent: string[] = [];
  const work: Promise<void>[] = [];
  const results = createReviewResults({
    decideReview: async () => ({
      kind: "routine",
      review: { id: "rev-j", type: "routine", chatId: CHAT, topicId: 9, routineDescription: "Ablauf", session, createdAt: Date.now() },
      session,
    }),
    createRoutine: (s, hint, epoch) =>
      createRoutineFromSession(s, hint, {
        getEngine: claudeEngine(async (o) => {
          resumed = o.resumeSessionId;
          return { text: "bericht", sessionId: "S-knopf-neu" };
        }),
        log: async () => {},
      }, epoch),
    sendAndRecord: async (input) => {
      // Die Startmeldung wartet, währenddessen kommt /new
      if (!sent.length) await resetSession(key);
      sent.push(input.text);
      return { sent: true, recorded: true } as SendAndRecordResult;
    },
    sendTelegram: async () => {},
    saveMessage: async () => {},
    dmChatId: () => undefined,
    background: (p) => work.push(p),
    log: () => {},
  });
  await results.handler({
    ref: "rev-j",
    result: { key: "routine" },
    conversation: { type: "telegram", chatId: CHAT, topicId: 9 },
  } as Parameters<typeof results.handler>[0]);
  await Promise.all(work);
  out.j = { resumed, notices: sent.length, stored: await stored(9), resumable: (await getResumableSession(key, "general", MODEL, "claude"))?.engineSessionId ?? null };
}

// K und L: /new, während decideReview die Session der Routine auswählt
// (Handler und alter rev|-Knopf ohne Rückfrage). decideReview liefert S erst
// nach dem Zurücksetzen, die Routine endet mit neuer Session
async function reviewDuringDecide(topicId: number, prefix: string, via: "handler" | "legacy") {
  const key = sessionKeyFor(CHAT, topicId);
  await recordSessionTurn(key, "general", MODEL, "claude", prefix);
  const session = (await getSessionsForKey(key)).find((s) => s.agentName === "general")!;
  let resumed: string | undefined;
  const work: Promise<void>[] = [];
  const results = createReviewResults({
    decideReview: async () => {
      // Die Session ist ausgewählt, der Abschluss wartet, währenddessen /new
      await resetSession(key);
      return {
        kind: "routine",
        review: { id: `rev-${prefix}`, type: "routine", chatId: CHAT, topicId, routineDescription: "Ablauf", session, createdAt: Date.now() },
        session,
      };
    },
    createRoutine: (s, hint, epoch) =>
      createRoutineFromSession(s, hint, {
        getEngine: claudeEngine(async (o) => {
          resumed = o.resumeSessionId;
          return { text: "bericht", sessionId: `${prefix}-neu` };
        }),
        log: async () => {},
      }, epoch),
    sendAndRecord: async () => ({ sent: true, recorded: true }) as SendAndRecordResult,
    sendTelegram: async () => {},
    saveMessage: async () => {},
    dmChatId: () => undefined,
    listChoices: async () => [],
    background: (p) => work.push(p),
    log: () => {},
  });
  if (via === "handler") {
    await results.handler({
      ref: `rev-${prefix}`,
      result: { key: "routine" },
      conversation: { type: "telegram", chatId: CHAT, topicId },
    } as Parameters<typeof results.handler>[0]);
  } else {
    await results.legacy("routine", `rev-${prefix}`);
  }
  await Promise.all(work);
  return { resumed, stored: await stored(topicId), resumable: (await getResumableSession(key, "general", MODEL, "claude"))?.engineSessionId ?? null };
}
out.k = await reviewDuringDecide(10, "S-wahl", "handler");
out.l = await reviewDuringDecide(11, "S-alt-knopf", "legacy");

console.log(JSON.stringify(out));
