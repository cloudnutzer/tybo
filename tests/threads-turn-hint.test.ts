// Hinweis im nächsten Turn nach einer Erinnerung (Issue #292, Aufgabe 7): über
// den Web-Weg (createBotChat und createTelegramChat) mit echter Ablage im
// Temp-Ordner; Attrappen statt Claude und Telegram, src/bot.ts wird nicht geladen.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnOptions, TurnSink } from "../src/lib/chat-turn";
import type { ChoiceConversation } from "../src/lib/choices";
import { abortAllExecutions } from "../src/lib/execution-context";
import { joinTurnHints, reminderHintText, takeThreadTurnHint } from "../src/lib/threads/hint";
import { createThread, getThread, setThreadsFileForTests, updateThreads } from "../src/lib/threads/store";
import { createBotChat, createTelegramChat, type BotChatDeps } from "../src/web/bot-turn";
import type { RunTurnOptions } from "../src/web/chat";

const GROUP = "-1001234567890";
const USER = "4242";
const CONV_A = "0c1a2b3c-0000-4000-8000-00000000000a";
const CONV_B = "0c1a2b3c-0000-4000-8000-00000000000b";
const HINT = "Du hast den Nutzer an eine offene Frage erinnert: Reiseziel: Hamburg oder München? Seine Nachricht kann die Antwort darauf sein.";

const root = await mkdtemp(join(tmpdir(), "tybo-threads-hint-"));
let counter = 0;
let logSpy: ReturnType<typeof spyOn>;
afterAll(() => rm(root, { recursive: true, force: true }));
beforeEach(() => {
  setThreadsFileForTests(join(root, `threads-${++counter}.json`));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  abortAllExecutions();
  setThreadsFileForTests(null);
  logSpy.mockRestore();
});

const nullSink: TurnSink = { progress() {}, notice() {} };

/** Offener Faden mit ausstehendem Hinweis (wie nach einer zugestellten Erinnerung) */
async function remindedThread(conversation: ChoiceConversation, question = "Hamburg oder München?"): Promise<string> {
  const r = await createThread({ conversation, topic: "Reiseziel", context: "Wohin?", question });
  if (r.status !== "created") throw new Error("nicht angelegt");
  await updateThreads(threads => {
    threads[r.thread.id].reminders = 1;
    threads[r.thread.id].hintPending = true;
    return { result: null, changed: true };
  });
  return r.thread.id;
}

function deps(turns: TurnOptions[], extra: Partial<BotChatDeps> = {}): BotChatDeps {
  return {
    runStreamingTurn: async o => {
      turns.push(o);
      return "Alles klar.";
    },
    saveMessage: async () => true,
    processIntents: async () => {},
    abortEngineCalls: () => 0,
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    log: () => {},
    threadHint: conversation => takeThreadTurnHint(conversation, { env: {} }),
    ...extra,
  };
}

const turn = (conversationId: string, noTelegram = false): RunTurnOptions => ({ conversationId, agent: "general", text: "Hamburg.", sink: nullSink, ...(noTelegram ? { noTelegram } : {}) });

describe("Web-Gespräch", () => {
  test("erster Folgeturn bekommt den Hinweis, der zweite nicht, ein anderes Gespräch nicht", async () => {
    const a = await remindedThread({ type: "web", conversationId: CONV_A });
    const turns: TurnOptions[] = [];
    const chat = createBotChat(deps(turns));
    await chat.runTurn(turn(CONV_B));
    await chat.runTurn(turn(CONV_A));
    await chat.runTurn(turn(CONV_A));
    expect(turns.map(t => t.turnHint)).toEqual([undefined, HINT, undefined]);
    // Der Hinweis hängt nie an der Nutzernachricht selbst
    expect(turns[1].userMessage).toBe("Hamburg.");
    expect((await getThread(a))!.hintPending).toBeUndefined();
    expect((await getThread(a))!.state).toBe("open");
  });

  test("der Hinweis des anderen Gesprächs bleibt liegen, bis dort ein Turn kommt", async () => {
    await remindedThread({ type: "web", conversationId: CONV_A });
    const b = await remindedThread({ type: "web", conversationId: CONV_B }, "Zug oder Auto?");
    const turns: TurnOptions[] = [];
    const chat = createBotChat(deps(turns));
    await chat.runTurn(turn(CONV_A));
    expect(turns[0].turnHint).toBe(HINT);
    expect((await getThread(b))!.hintPending).toBe(true);
    await chat.runTurn(turn(CONV_B));
    expect(turns[1].turnHint).toContain("Zug oder Auto?");
  });

  test("zwei gleichzeitige Turns verbrauchen ihn einmal", async () => {
    await remindedThread({ type: "web", conversationId: CONV_A });
    const turns: TurnOptions[] = [];
    const chat = createBotChat(deps(turns));
    await Promise.all([chat.runTurn(turn(CONV_A)), chat.runTurn(turn(CONV_A))]);
    expect(turns.length).toBe(2);
    expect(turns.filter(t => t.turnHint === HINT).length).toBe(1);
  });

  test("Denkauftrag aus dem Telefonhörer: kein Hinweis, er bleibt für den nächsten Turn", async () => {
    const a = await remindedThread({ type: "web", conversationId: CONV_A });
    const turns: TurnOptions[] = [];
    const chat = createBotChat(deps(turns));
    await chat.runTurn(turn(CONV_A, true));
    expect(turns[0].turnHint).toBeUndefined();
    expect((await getThread(a))!.hintPending).toBe(true);
  });

  test("THREADS=off: kein Hinweis", async () => {
    await remindedThread({ type: "web", conversationId: CONV_A });
    const turns: TurnOptions[] = [];
    const chat = createBotChat(deps(turns, { threadHint: c => takeThreadTurnHint(c, { env: { THREADS: "off" } }) }));
    await chat.runTurn(turn(CONV_A));
    expect(turns[0].turnHint).toBeUndefined();
  });
});

describe("Telegram-Gespräch im Browser", () => {
  test("Topic: Hinweis einmal, dieselbe Gesprächskennung wie in Telegram", async () => {
    await remindedThread({ type: "telegram", chatId: GROUP, topicId: 443 });
    const turns: TurnOptions[] = [];
    const chat = createTelegramChat({
      ...deps(turns),
      userId: USER,
      groupId: () => GROUP,
      agentForTopic: () => undefined,
      sendPlain: async () => {},
      sendAsAgent: async () => {},
    });
    await chat.runTurn(turn("topic-7"));
    await chat.runTurn(turn("topic-443"));
    await chat.runTurn(turn("topic-443"));
    expect(turns.map(t => t.turnHint)).toEqual([undefined, HINT, undefined]);
  });
});

describe("Text und Fehler", () => {
  test("Text je Faden, ohne doppelten Punkt; Verbinden mit einem Sprech-Hinweis", () => {
    expect(reminderHintText([{ topic: "Reiseziel", question: "Hamburg oder München?" }])).toBe(HINT);
    expect(reminderHintText([{ topic: "Termin", question: "Passt Dienstag" }])).toBe(
      "Du hast den Nutzer an eine offene Frage erinnert: Termin: Passt Dienstag. Seine Nachricht kann die Antwort darauf sein."
    );
    expect(reminderHintText([])).toBeUndefined();
    expect(joinTurnHints("Sprich kurz.", HINT)).toBe(`Sprich kurz.\n\n${HINT}`);
    expect(joinTurnHints(undefined, " ")).toBeUndefined();
  });

  test("Fehler beim Abholen: kein Hinweis, eine Log-Zeile, nichts geworfen", async () => {
    const logs: string[] = [];
    const hint = await takeThreadTurnHint({ type: "web", conversationId: CONV_A }, { env: {}, take: async () => { throw new Error("kaputt"); }, log: l => logs.push(l) });
    expect(hint).toBeUndefined();
    expect(logs).toEqual([`[threads] kein Hinweis für Gespräch web:${CONV_A} (fehler)`]);
  });
});
