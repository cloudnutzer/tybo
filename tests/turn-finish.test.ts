/**
 * Issue #339: gemeinsamer Abschluss eines Telegram-Turns
 * (src/lib/turn-finish.ts); Issue #340: dieselben Stufen einzeln, wie die
 * WebUI sie aufruft (createTurnStages). Geprüft wird das Verhalten mit Attrappen:
 * einmal speichern mit Metadaten, Merk-Tags mit Ziel und fremdem Inhalt,
 * /goal mit dem Session-Schlüssel des Gesprächs, begrenzte Konsultationen
 * ohne Rückfrage, genau eine Rückfrage nach der Antwort, Fäden zuletzt.
 * src/bot.ts wird nie importiert.
 */
import { describe, expect, test } from "bun:test";
import { ABORT_REPLY, type TurnQuestion } from "../src/lib/chat-turn";
import type { AskOfferOutcome } from "../src/lib/ask-choices";
import { createTurnFinish, createTurnStages, type FinishedTurn, type TurnFinishDeps } from "../src/lib/turn-finish";
import type { TurnTools } from "../src/lib/turn-tools";

const GROUP = "-100777";
const DM = "4711";

function question(events: string[], fails = false): TurnQuestion {
  return {
    question: "Soll ich?",
    options: ["Ja", "Nein"],
    offer: async () => {
      events.push("offer");
      if (fails) throw new Error("Register kaputt");
      return { status: "offered" } as unknown as AskOfferOutcome;
    },
  } as unknown as TurnQuestion;
}

function setup(budget = 3, answer: (target: string) => string = target => `Antwort von ${target}`) {
  const events: string[] = [];
  const saved: { chat_id: string; role: string; content: string; metadata?: unknown }[] = [];
  const intents: { text: string; tools: unknown; target: unknown }[] = [];
  const goals: [string, string, string][] = [];
  const invoked: string[] = [];
  const threads: unknown[][] = [];
  const errors: string[] = [];
  const finish = createTurnFinish({
    saveMessage: async m => {
      events.push("save");
      saved.push(m as never);
    },
    processIntents: async (text, tools, target) => {
      events.push("intents");
      intents.push({ text, tools, target });
    },
    onGoalTurn: (key, agent, reply) => {
      events.push("goal");
      goals.push([key, agent, reply]);
    },
    // wie consultViaAgentBots: Antwort zustellen, dann delivered
    invoke: async (from, invocation, chatId, topicId, delivered) => {
      events.push(`invoke:${invocation.targetAgent}`);
      invoked.push(`${from}->${invocation.targetAgent}@${chatId}:${topicId ?? "-"}:${invocation.question}`);
      await delivered(invocation.targetAgent, answer(invocation.targetAgent));
    },
    invokeBudget: budget,
    noteThreads: (...args) => {
      events.push("threads");
      threads.push(args);
    },
    logError: message => void errors.push(message),
  });
  const send = async (text: string) => void events.push(`send:${text}`);
  return { finish, events, saved, intents, goals, invoked, threads, errors, send };
}

function turn(s: ReturnType<typeof setup>, extra: Partial<FinishedTurn> = {}): FinishedTurn {
  return { chatId: GROUP, topicId: 7, agentName: "research", reply: "Antwort", metadata: { agent: "research", topicId: 7 }, send: s.send, ...extra };
}

describe("Turn-Abschluss: Speichern, Merk-Tags, Goal", () => {
  test("Antwort genau einmal gespeichert, mit den Metadaten des Kanals", async () => {
    const s = setup();
    await s.finish(turn(s, { metadata: { agent: "research", topicId: 7, type: "photo_reply", model: "m" } }));
    expect(s.saved).toEqual([{ chat_id: GROUP, role: "assistant", content: "Antwort", metadata: { agent: "research", topicId: 7, type: "photo_reply", model: "m" } }]);
  });

  test("Merk-Tags mit Werkzeugen, Ziel und fremdem Inhalt", async () => {
    const s = setup();
    const tools = { uses: [] } as unknown as TurnTools;
    await s.finish(turn(s, { tools, foreignInput: "Foto" }));
    expect(s.intents).toEqual([{ text: "Antwort", tools, target: { chatId: GROUP, topicId: 7, origin: "Telegram", foreignInput: "Foto" } }]);
  });

  test("ohne fremden Inhalt: kein foreignInput im Ziel", async () => {
    const s = setup();
    await s.finish(turn(s, { chatId: DM, topicId: undefined }));
    expect(s.intents[0].target).toStrictEqual({ chatId: DM, topicId: undefined, origin: "Telegram" });
  });

  test("Goal-Hook mit dem Session-Schlüssel von Topic, Gruppe und Direktchat", async () => {
    const s = setup();
    await s.finish(turn(s));
    await s.finish(turn(s, { chatId: GROUP, topicId: undefined, agentName: "general" }));
    await s.finish(turn(s, { chatId: DM, topicId: undefined, agentName: "general" }));
    expect(s.goals).toEqual([
      [`topic:${GROUP}:7`, "research", "Antwort"],
      [`group:${GROUP}`, "general", "Antwort"],
      [`dm:${DM}`, "general", "Antwort"],
    ]);
  });
});

describe("Turn-Abschluss: Reihenfolge, Rückfrage und Fäden", () => {
  test("Normalfall: speichern, Merk-Tags, Goal, senden, Rückfrage, Fäden", async () => {
    const s = setup();
    await s.finish(turn(s, { question: question(s.events), threads: { userText: "Frage", startedAt: 5 } }));
    expect(s.events).toEqual(["save", "intents", "goal", "send:Antwort", "offer", "threads"]);
    expect(s.threads).toEqual([[GROUP, 7, "Frage", "Antwort", 5]]);
  });

  test("ohne threads (Befehl): keine Fäden", async () => {
    const s = setup();
    await s.finish(turn(s));
    expect(s.events).toEqual(["save", "intents", "goal", "send:Antwort"]);
  });

  test("Anbieten scheitert: Fehler geloggt, Fäden laufen trotzdem", async () => {
    const s = setup();
    await s.finish(turn(s, { question: question(s.events, true), threads: { userText: "x", startedAt: 1 } }));
    expect(s.events).toEqual(["save", "intents", "goal", "send:Antwort", "offer", "threads"]);
    expect(s.errors).toEqual(["[Rückfrage] nicht angeboten:"]);
  });
});

describe("Turn-Abschluss: Konsultation", () => {
  const reply = "Ich frage nach.\n[INVOKE:finance|Was kostet das?]\n[INVOKE:critic|Was spricht dagegen?]";

  test("eigener Text ohne Tags, dann die Agenten im Gespräch des Turns, keine Rückfrage", async () => {
    const s = setup();
    await s.finish(turn(s, { reply, question: question(s.events), threads: { userText: "x", startedAt: 1 } }));
    expect(s.events).toEqual(["save", "intents", "goal", "send:Ich frage nach.", "invoke:finance", "save", "invoke:critic", "save", "threads"]);
    expect(s.invoked).toEqual([`research->finance@${GROUP}:7:Was kostet das?`, `research->critic@${GROUP}:7:Was spricht dagegen?`]);
    // gespeichert wird die ganze Antwort, dann je befragtem Agenten seine Antwort mit Absender
    expect(s.saved).toEqual([
      { chat_id: GROUP, role: "assistant", content: reply, metadata: { agent: "research", topicId: 7 } },
      { chat_id: GROUP, role: "assistant", content: "Antwort von finance", metadata: { agent: "finance", topicId: 7, invokedBy: "research" } },
      { chat_id: GROUP, role: "assistant", content: "Antwort von critic", metadata: { agent: "critic", topicId: 7, invokedBy: "research" } },
    ]);
  });

  test("leere oder abgebrochene Antwort eines befragten Agenten wird nicht gespeichert", async () => {
    const s = setup(3, target => (target === "finance" ? "  " : ABORT_REPLY));
    await s.finish(turn(s, { reply }));
    expect(s.saved.map(m => m.content)).toEqual([reply]);
  });

  test("Speichern der Konsultationsantwort scheitert: geloggt, Ablauf läuft weiter", async () => {
    const s = setup();
    const save = async () => {
      throw new Error("Speicher weg");
    };
    let first = true;
    const finish = createTurnFinish({
      saveMessage: async () => {
        if (first) {
          first = false;
          return;
        }
        await save();
      },
      processIntents: async () => {},
      onGoalTurn: () => {},
      invoke: async (_from, invocation, _chat, _topic, delivered) => {
        s.events.push(`invoke:${invocation.targetAgent}`);
        await delivered(invocation.targetAgent, "x");
      },
      invokeBudget: 3,
      noteThreads: () => void s.events.push("threads"),
      logError: message => void s.errors.push(message),
    });
    await finish(turn(s, { reply, threads: { userText: "x", startedAt: 1 } }));
    expect(s.events).toEqual(["send:Ich frage nach.", "invoke:finance", "invoke:critic", "threads"]);
    expect(s.errors).toEqual(["[Konsultation] Antwort nicht gespeichert:", "[Konsultation] Antwort nicht gespeichert:"]);
  });

  test("höchstens invokeBudget Konsultationen", async () => {
    const s = setup(1);
    const warn = console.warn;
    console.warn = () => {};
    try {
      await s.finish(turn(s, { reply }));
    } finally {
      console.warn = warn;
    }
    expect(s.invoked).toHaveLength(1);
    expect(s.saved).toHaveLength(2);
  });

  test("nur Tags ohne eigenen Text: nichts Leeres gesendet", async () => {
    const s = setup();
    await s.finish(turn(s, { reply: "[INVOKE:finance|Zahlen?]" }));
    expect(s.events).toEqual(["save", "intents", "goal", "invoke:finance", "save"]);
  });
});

describe("Turn-Stufen für die WebUI (Issue #340)", () => {
  const reply = "Ich frage nach.\n[INVOKE:finance|Was kostet das?]\n[INVOKE:critic|Was spricht dagegen?]";

  function stagesSetup(extra: Partial<TurnFinishDeps> = {}) {
    const s = setup();
    const commit = createTurnStages({
      saveMessage: async m => {
        s.events.push("save");
        s.saved.push(m as never);
      },
      processIntents: async (text, tools, target) => {
        s.events.push("intents");
        s.intents.push({ text, tools, target });
      },
      onGoalTurn: () => void s.events.push("goal"),
      invokeBudget: 3,
      noteThreads: () => void s.events.push("threads"),
      logError: message => void s.errors.push(message),
      ...extra,
    });
    return { ...s, commit };
  }

  test("Stufe 1 endet nach dem Zeigen; Konsultation und Fäden erst auf Abruf", async () => {
    const s = stagesSetup();
    const stages = await s.commit(turn(s, { reply, threads: { userText: "x", startedAt: 1 } }));
    expect(s.events).toEqual(["save", "intents", "goal", "send:Ich frage nach."]);
    expect(stages.consultations.map(i => i.targetAgent)).toEqual(["finance", "critic"]);
    expect(stages.settles).toBe(true);
    await stages.settle();
    expect(s.events.at(-1)).toBe("threads");
  });

  test("Herkunft und Turn ohne Telegram gehen ans Merk-Tor", async () => {
    const s = stagesSetup();
    await s.commit(turn(s, { chatId: "web:abc", topicId: undefined, origin: "Web-Gespräch", noTelegram: { conversationId: "abc" }, foreignInput: "Foto" }));
    expect(s.intents[0].target).toStrictEqual({ chatId: "web:abc", topicId: undefined, origin: "Web-Gespräch", foreignInput: "Foto", noTelegram: { conversationId: "abc" } });
  });

  test("eigener Ausführer: Antwort genau einmal gespeichert, mit den Metadaten des Kanals", async () => {
    const s = stagesSetup();
    const stages = await s.commit(turn(s, { reply }));
    await stages.consult(async (invocation, keep) => {
      s.events.push(`run:${invocation.targetAgent}`);
      await keep(invocation.targetAgent, `Antwort von ${invocation.targetAgent}`, { msgId: `m-${invocation.targetAgent}`, channel: "web" });
    });
    expect(s.events).toEqual(["save", "intents", "goal", "send:Ich frage nach.", "run:finance", "save", "run:critic", "save"]);
    expect(s.saved.slice(1)).toEqual([
      { chat_id: GROUP, role: "assistant", content: "Antwort von finance", metadata: { msgId: "m-finance", channel: "web" } },
      { chat_id: GROUP, role: "assistant", content: "Antwort von critic", metadata: { msgId: "m-critic", channel: "web" } },
    ]);
  });

  test("ohne invoke und ohne Ausführer: keine Konsultation", async () => {
    const s = stagesSetup();
    const stages = await s.commit(turn(s, { reply }));
    await stages.consult();
    expect(s.saved).toHaveLength(1);
  });

  test("Budget 0: Tags bleiben ohne Konsultation, die Rückfrage entfällt trotzdem", async () => {
    const s = stagesSetup({ invokeBudget: 0 });
    const stages = await s.commit(turn(s, { reply, question: question(s.events) }));
    expect(stages.consultations).toEqual([]);
    expect(stages.settles).toBe(false);
    await stages.settle();
    expect(s.events).not.toContain("offer");
  });

  test("showBeforeIntents (WebUI): erst zeigen, dann Merk-Tags und /goal", async () => {
    const s = stagesSetup({ showBeforeIntents: true });
    await s.commit(turn(s));
    expect(s.events).toEqual(["save", "send:Antwort", "intents", "goal"]);
    const t = stagesSetup({ showBeforeIntents: true });
    await t.commit(turn(t, { reply }));
    expect(t.events).toEqual(["save", "send:Ich frage nach.", "intents", "goal"]);
  });

  test("saveConsulted (WebUI): der Fehler erreicht den Ausführer, nichts nur geloggt", async () => {
    const s = stagesSetup({ saveConsulted: async () => Promise.reject(new Error("Speicher weg")) });
    const stages = await s.commit(turn(s, { reply }));
    const caught: string[] = [];
    await stages.consult(async (invocation, keep) => {
      try {
        await keep(invocation.targetAgent, "Antwort");
        s.events.push(`shown:${invocation.targetAgent}`);
      } catch (e) {
        caught.push(`${invocation.targetAgent}:${(e as Error).message}`);
      }
    });
    expect(caught).toEqual(["finance:Speicher weg", "critic:Speicher weg"]);
    expect(s.events.some(e => e.startsWith("shown:"))).toBe(false);
    expect(s.saved).toHaveLength(1);
    expect(s.errors).toEqual([]);
  });

  test("skipThreadsAfterFailedOffer (WebUI): gescheitertes Anbieten geloggt, keine Fäden", async () => {
    const s = stagesSetup({ skipThreadsAfterFailedOffer: true });
    const stages = await s.commit(turn(s, { question: question(s.events, true), threads: { userText: "x", startedAt: 1 } }));
    await stages.settle();
    expect(s.events.slice(-1)).toEqual(["offer"]);
    expect(s.errors).toEqual(["[Rückfrage] nicht angeboten:"]);
    // Angebot klappt: Fäden wie gewohnt
    const t = stagesSetup({ skipThreadsAfterFailedOffer: true });
    await (await t.commit(turn(t, { question: question(t.events), threads: { userText: "x", startedAt: 1 } }))).settle();
    expect(t.events.slice(-2)).toEqual(["offer", "threads"]);
  });

  test("nichts zu tun: settles false", async () => {
    const s = stagesSetup();
    expect((await s.commit(turn(s))).settles).toBe(false);
    expect((await s.commit(turn(s, { question: question(s.events) }))).settles).toBe(true);
  });
});
