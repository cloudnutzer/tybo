/**
 * Issue #340: Web-Turns enden im gemeinsamen Abschluss (src/lib/turn-finish.ts).
 * Vertrag für createBotChat (reine Web-Gespräche) und createTelegramChat
 * (Telegram-Gespräche aus dem Browser): beide Einstiege laufen über
 * createTurnStages, die Antwort wird genau einmal gespeichert, IDs und
 * Metadaten bleiben, Abbruch endet vor dem Abschluss, Fehler beim Speichern,
 * bei Merk-Tags und beim Senden kosten den Turn nicht, Konsultationen werden
 * genau einmal gespeichert, Rückfrage vor Fäden. Das bisherige Web-Verhalten
 * bleibt: erst nach Telegram senden, dann Merk-Tags; eine Konsultationsantwort,
 * deren Speichern wirft, erscheint nicht; nach gescheitertem Anbieten der
 * Rückfrage keine Fäden. src/bot.ts wird nie importiert.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ABORT_REPLY, type TurnOptions, type TurnQuestion, type TurnSink } from "../src/lib/chat-turn";
import { abortAllExecutions, abortExecutions, currentExecution } from "../src/lib/execution-context";
import { createTurnStages, type FinishedTurn } from "../src/lib/turn-finish";
import type { AskOfferOutcome } from "../src/lib/ask-choices";
import type { FollowUpOutput, RunTurnOptions } from "../src/web/chat";
import { createBotChat, createTelegramChat, type BotChatDeps, type IntentTurn, type TelegramChatDeps, type WebSavedMessage } from "../src/web/bot-turn";
import { isWebMessageId } from "../src/web/telegram";

const GROUP = "-1001234567890";
const USER = "4242";
const WEB_UUID = "0c1a2b3c-0000-4000-8000-000000000000";
const nullSink: TurnSink = { progress() {}, notice() {} };

afterEach(() => abortAllExecutions());

function untilAborted(): Promise<void> {
  const signal = currentExecution()!.controller.signal;
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

function question(steps: string[], fails = false): TurnQuestion {
  return {
    question: "Soll ich?",
    options: ["Ja", "Nein"],
    offer: async () => {
      steps.push("offer");
      if (fails) throw new Error("Register kaputt");
      return { status: "offered" } as unknown as AskOfferOutcome;
    },
  } as unknown as TurnQuestion;
}

function setup(core: (o: TurnOptions) => Promise<string> = async () => "Antwort") {
  const state = {
    steps: [] as string[],
    saved: [] as WebSavedMessage[],
    intents: [] as { text: string; turn: IntentTurn }[],
    finished: [] as FinishedTurn[],
    goals: [] as [string, string, string][],
    agentSends: [] as { agent: string; text: string }[],
    logs: [] as string[],
    failSave: undefined as ((m: WebSavedMessage) => boolean) | undefined,
    failIntents: false,
    failSend: false,
    core,
  };
  const deps: TelegramChatDeps = {
    userId: USER,
    groupId: () => GROUP,
    agentForTopic: topicId => ({ 30: "general", 443: "cto" } as Record<number, string>)[topicId],
    runStreamingTurn: o => {
      state.steps.push(`claude:${o.agentName}`);
      return state.core(o);
    },
    saveMessage: async m => {
      if (state.failSave?.(m)) throw new Error("Speicher weg");
      state.steps.push(`save:${m.role}`);
      state.saved.push(m);
      return true;
    },
    processIntents: async (text, turn) => {
      if (state.failIntents) throw new Error("Tor kaputt");
      state.steps.push("intents");
      state.intents.push({ text, turn });
    },
    abortEngineCalls: key => abortExecutions(key),
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    sendPlain: async () => void state.steps.push("mirror"),
    sendAsAgent: async (agent, _chatId, text) => {
      if (state.failSend) throw new Error("Telegram 429");
      state.steps.push(`send:${agent}`);
      state.agentSends.push({ agent, text });
    },
    sendTypingAsAgent: async () => {},
    onAgentTurn: (key, agent, reply) => {
      state.steps.push("goal");
      state.goals.push([key, agent, reply]);
    },
    noteThreads: () => void state.steps.push("threads"),
    // Beweis, dass beide Einstiege den gemeinsamen Abschluss nehmen
    finishStages: d => {
      const commit = createTurnStages(d);
      return turn => {
        state.steps.push("finish");
        state.finished.push(turn);
        return commit(turn);
      };
    },
    log: m => state.logs.push(m),
  };
  return { state, deps };
}

function webTurn(text = "Hallo", extra: Partial<RunTurnOptions> = {}): RunTurnOptions {
  return { conversationId: WEB_UUID, agent: "general", text, sink: nullSink, ...extra };
}

function tgTurn(id = "topic-443", text = "Hallo", extra: Partial<RunTurnOptions> = {}): RunTurnOptions {
  return { conversationId: id, agent: "general", text, sink: nullSink, messageId: "web-user-1", ...extra };
}

function followUpOutput(answers: { text: string; messageId?: string }[]): FollowUpOutput {
  return {
    signal: new AbortController().signal,
    answer: async (text, _info, messageId) => void answers.push({ text, messageId }),
    notice: async () => {},
  };
}

describe("createBotChat über den gemeinsamen Abschluss", () => {
  test("läuft über createTurnStages, Antwort einmal gespeichert, Metadaten unverändert", async () => {
    const { state, deps } = setup(async () => "Antwort [REMEMBER: Alex mag Tee]");
    const result = await createBotChat({ ...deps, noteThreads: undefined }).runTurn(webTurn());
    expect(result).toEqual({ text: "Antwort [REMEMBER: Alex mag Tee]", info: { agent: "general" } });
    expect(state.finished).toHaveLength(1);
    expect(state.finished[0]).toMatchObject({ chatId: `web:${WEB_UUID}`, agentName: "general", origin: "Web-Gespräch" });
    expect(state.saved.filter(m => m.role === "assistant")).toEqual([
      { chat_id: `web:${WEB_UUID}`, role: "assistant", content: "Antwort [REMEMBER: Alex mag Tee]", metadata: { agent: "general", channel: "web" } },
    ]);
    expect(state.intents).toEqual([{ text: "Antwort [REMEMBER: Alex mag Tee]", turn: { tools: undefined, chatId: `web:${WEB_UUID}`, origin: "Web-Gespräch" } }]);
    // Reines Web-Gespräch: weder /goal noch Telegram (wie vor Issue #340)
    expect(state.steps).toEqual(["save:user", "claude:general", "finish", "save:assistant", "intents"]);
  });

  test("[INVOKE:] im reinen Web-Gespräch: keine Konsultation, keine Rückfrage", async () => {
    const { state, deps } = setup(async o => {
      o.onQuestion?.(question(state.steps));
      return "Ich frage. [INVOKE:critic|Was dagegen?]";
    });
    const result = await createBotChat({ ...deps, noteThreads: undefined }).runTurn(webTurn());
    expect(result.followUp).toBeUndefined();
    expect(result.afterReply).toBeUndefined();
    expect(state.steps).not.toContain("claude:critic");
  });

  test("Abbruch vor der Antwort: kein Abschluss, nichts gespeichert außer der Nutzernachricht", async () => {
    const { state, deps } = setup(async () => {
      await untilAborted();
      return ABORT_REPLY;
    });
    const chat = createBotChat(deps);
    const running = chat.runTurn(webTurn());
    await waitUntil(() => state.steps.includes("claude:general"));
    expect(chat.stop(WEB_UUID)).toBe(true);
    expect((await running).aborted).toBe(true);
    expect(state.finished).toEqual([]);
    expect(state.saved.map(m => m.role)).toEqual(["user"]);
  });

  test("Speichern und Merk-Tags scheitern: Antwort kommt trotzdem, beides geloggt", async () => {
    const { state, deps } = setup();
    state.failSave = m => m.role === "assistant";
    state.failIntents = true;
    const result = await createBotChat(deps).runTurn(webTurn());
    expect(result.text).toBe("Antwort");
    expect(state.logs.some(l => l.includes("Gedächtnis-Speichern"))).toBe(true);
    expect(state.logs.some(l => l.includes("Merk-Tags"))).toBe(true);
  });

  test("Turn ohne Telegram: Merk-Vorschlag nur im Gespräch, keine Fäden", async () => {
    const { state, deps } = setup();
    const result = await createBotChat(deps).runTurn(webTurn("Hallo", { noTelegram: true }));
    expect(state.intents[0].turn.noTelegram).toEqual({ conversationId: WEB_UUID });
    expect(result.afterReply).toBeUndefined();
  });

  test("Rückfrage vor Fäden", async () => {
    const { state, deps } = setup(async o => {
      o.onQuestion?.(question(state.steps));
      return "Soll ich?";
    });
    const result = await createBotChat(deps).runTurn(webTurn());
    result.afterReply!();
    await waitUntil(() => state.steps.includes("threads"));
    expect(state.steps.slice(-2)).toEqual(["offer", "threads"]);
  });

  test("scheitert das Anbieten der Rückfrage: keine Fäden, Fehler geloggt", async () => {
    const { state, deps } = setup(async o => {
      o.onQuestion?.(question(state.steps, true));
      return "Soll ich?";
    });
    const result = await createBotChat(deps).runTurn(webTurn());
    result.afterReply!();
    await waitUntil(() => state.logs.some(l => l.includes("[Rückfrage] nicht angeboten")));
    await Bun.sleep(10);
    expect(state.steps).toContain("offer");
    expect(state.steps).not.toContain("threads");
  });
});

describe("createTelegramChat über den gemeinsamen Abschluss", () => {
  test("läuft über createTurnStages; Reihenfolge wie bisher: speichern, senden, Merk-Tags, /goal", async () => {
    const { state, deps } = setup(async () => "Erledigt. [REMEMBER: Alex mag Topics]");
    const result = await createTelegramChat(deps).runTurn(tgTurn());
    expect(state.finished).toHaveLength(1);
    expect(state.finished[0]).toMatchObject({ chatId: GROUP, topicId: 443, agentName: "cto", origin: "WebUI" });
    expect(state.steps).toEqual(["mirror", "claude:cto", "save:user", "finish", "save:assistant", "send:cto", "intents", "goal"]);
    expect(state.goals).toEqual([[`topic:${GROUP}:443`, "cto", "Erledigt. [REMEMBER: Alex mag Topics]"]]);
    expect(state.agentSends).toEqual([{ agent: "cto", text: "Erledigt." }]);
  });

  test("Nachrichten-IDs und Metadaten unverändert, Antwort genau einmal gespeichert", async () => {
    const { state, deps } = setup();
    const result = await createTelegramChat(deps).runTurn(tgTurn());
    const assistant = state.saved.filter(m => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(isWebMessageId(result.messageId)).toBe(true);
    expect(assistant[0]).toEqual({
      chat_id: GROUP,
      role: "assistant",
      content: "Antwort",
      metadata: { topicId: 443, channel: "web", msgId: result.messageId, agent: "cto" },
    });
    expect(state.saved[0].metadata).toMatchObject({ msgId: "web-user-1" });
  });

  test("Senden, Speichern und Merk-Tags scheitern: Turn liefert die Antwort, Fehler geloggt", async () => {
    const { state, deps } = setup();
    state.failSend = true;
    state.failIntents = true;
    state.failSave = m => m.role === "assistant";
    const result = await createTelegramChat(deps).runTurn(tgTurn());
    expect(result.text).toBe("Antwort");
    expect(state.steps).toContain("goal");
    expect(state.logs.some(l => l.includes("nicht gesendet"))).toBe(true);
    expect(state.logs.some(l => l.includes("Merk-Tags"))).toBe(true);
  });

  test("Abbruch: kein Abschluss, nichts gespeichert", async () => {
    const { state, deps } = setup(async () => {
      await untilAborted();
      return ABORT_REPLY;
    });
    const chat = createTelegramChat(deps);
    const running = chat.runTurn(tgTurn());
    await waitUntil(() => state.steps.includes("claude:cto"));
    expect(chat.stop("topic-443")).toBe(true);
    expect(await running).toEqual({ text: "", aborted: true });
    expect(state.finished).toEqual([]);
    expect(state.saved).toEqual([]);
  });

  test("Konsultation in der Nacharbeit: genau einmal gespeichert, mit der ID aus dem Browser", async () => {
    const { state, deps } = setup(async o => (o.agentName === "critic" ? "Drei Risiken." : "Ich hole Kritik. [INVOKE:critic|Was dagegen?]"));
    const result = await createTelegramChat({ ...deps, invokeBudget: 3 }).runTurn(tgTurn("topic-30"));
    expect(typeof result.followUp).toBe("function");
    const answers: { text: string; messageId?: string }[] = [];
    await result.followUp!(followUpOutput(answers));
    const critic = state.saved.filter(m => m.metadata?.agent === "critic");
    expect(critic).toHaveLength(1);
    expect(answers).toEqual([{ text: "Drei Risiken.", messageId: critic[0].metadata!.msgId as string }]);
    expect(critic[0].metadata).toMatchObject({ topicId: 30, channel: "web", invokedBy: "general" });
    expect(state.agentSends.map(s => s.agent)).toEqual(["general", "critic"]);
  });

  test("Konsultation, deren Speichern wirft: nicht gezeigt, nicht gesendet, geloggt; die nächste läuft", async () => {
    const { state, deps } = setup(async o =>
      o.agentName === "general" ? "Ich hole zwei Stimmen. [INVOKE:critic|Was dagegen?] [INVOKE:finance|Was kostet das?]" : `Antwort von ${o.agentName}.`
    );
    state.failSave = m => m.metadata?.agent === "critic";
    const result = await createTelegramChat({ ...deps, invokeBudget: 3 }).runTurn(tgTurn("topic-30"));
    const answers: { text: string; messageId?: string }[] = [];
    await result.followUp!(followUpOutput(answers));
    expect(answers.map(a => a.text)).toEqual(["Antwort von finance."]);
    expect(state.agentSends.map(s => s.agent)).toEqual(["general", "finance"]);
    expect(state.saved.filter(m => m.metadata?.invokedBy === "general").map(m => m.metadata?.agent)).toEqual(["finance"]);
    expect(state.logs.some(l => l.includes("Rückfrage in topic-30 fehlgeschlagen"))).toBe(true);
  });

  test("ohne Budget: keine Nacharbeit, keine Rückfrage bei [INVOKE:]", async () => {
    const { state, deps } = setup(async o => {
      o.onQuestion?.(question(state.steps));
      return "Ich frage. [INVOKE:critic|Was dagegen?]";
    });
    const result = await createTelegramChat({ ...deps, noteThreads: undefined }).runTurn(tgTurn("topic-30"));
    expect(result.followUp).toBeUndefined();
    expect(result.afterReply).toBeUndefined();
  });

  test("Turn ohne Telegram: nichts gesendet, Vorschlag nur in der WebUI", async () => {
    const { state, deps } = setup();
    await createTelegramChat(deps).runTurn(tgTurn("topic-443", "Hallo", { noTelegram: true }));
    expect(state.agentSends).toEqual([]);
    expect(state.intents[0].turn).toMatchObject({ origin: "WebUI", noTelegram: { conversationId: "topic-443" } });
  });
});
