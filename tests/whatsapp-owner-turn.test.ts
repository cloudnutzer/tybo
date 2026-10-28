/**
 * Issue #345, Checkbox 1: Der Besitzer-Turn in WhatsApp läuft über den
 * Chat-Kern (runJsonTurn) mit dem Agenten General, ausdrücklich mit Claude,
 * dem WhatsApp-Hinweis an jedem Prompt (auch an der Frage für die
 * Fallback-Kette), Gedächtnis und Verlauf aus dem Prompt-Bau des Kerns, ohne
 * Sessions (das Gateway ist ein eigener Prozess). Nachricht und Antwort
 * werden genau einmal gespeichert, Merk-Tags genau einmal durchs Tor.
 *
 * Motor, Prompt-Bau und Fallback sind Attrappen; Warteschlange und Kern echt.
 *
 * Merk-Tags mit dem echten Tor (processTurnIntents) und den Zustellwegen des
 * Gateways (installWhatsAppChoices): echtes Register, echte Vorschlagsablage
 * und echtes Gedächtnis in Temp-Dateien, echte sendChoice und sendAndRecord;
 * nur die Telegram-Bot-API ist eine Attrappe. Fremde Inhalte ergeben einen
 * Vorschlag im Direktchat (mit Telegram per Knöpfen, ohne in der WebUI),
 * Zustimmung wirkt genau einmal, mehrere Treffer ergeben eine Auswahl.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installWhatsAppChoices } from "../src/channels/whatsapp/choices";
import { decideChoice, listChoices, onChoiceDecided, setChoicesFileForTests, type Choice } from "../src/lib/choices";
import { decideReview, processTurnIntents } from "../src/lib/intent-gate";
import { addFact, addGoal, listFacts, listGoals, setMemoryAsker } from "../src/lib/memory";
import { createMemoryChoices } from "../src/lib/memory/choices";
import { sendAndRecord, type OutboxDeps, type SendAndRecordInput } from "../src/lib/outbox";
import { createReviewResults } from "../src/lib/review-choices";
import { setPendingReviewsFileForTests, setReviewNotifier, takePendingReview } from "../src/lib/session-distill";
import { resetStore } from "../src/lib/store";
import { ABORT_REPLY, resolveStreamingLimits, runJsonTurn, TURN_HINT_HEADING, type ChatTurnDeps } from "../src/lib/chat-turn";
import type { Engine, EngineRequest, EngineResult } from "../src/lib/engines";
import { currentExecution, runExecution } from "../src/lib/execution-context";
import type { IntentTarget } from "../src/lib/intent-gate";
import type { Message } from "../src/lib/store/types";
import type { TurnTools } from "../src/lib/turn-tools";
import {
  createOwnerTurn,
  GATEWAY_CORE_DEPS,
  WHATSAPP_AGENT,
  WHATSAPP_ORIGIN,
  WHATSAPP_TURN_HINT,
  type OwnerTurnDeps,
} from "../src/channels/whatsapp/owner-turn";

const OWNER = "+4915100000001";
const CHAT = `wa:${OWNER}`;

const forbidden = (name: string) => () => {
  throw new Error(`${name} darf im Gateway nicht laufen`);
};

function harness(opts: { reply?: Partial<EngineResult>; abortInEngine?: boolean; processIntents?: OwnerTurnDeps["processIntents"] } = {}) {
  const requests: EngineRequest[] = [];
  const built: { userMessage: string; chatId: string; agentName: string; topicId?: number }[] = [];
  const fallbacks: { question: string; context?: string }[] = [];
  const saved: Message[] = [];
  const intents: { response: string; tools: TurnTools | undefined; target: IntentTarget }[] = [];
  const notices: string[] = [];
  const queueKeys: string[] = [];
  const order: string[] = [];

  const claude: Engine = {
    id: "claude",
    describe: () => "Attrappe",
    async run(req) {
      requests.push(req);
      order.push("motor");
      if (opts.abortInEngine) return { engine: "claude", text: "", isError: true, aborted: true };
      return { engine: "claude", text: "Notiert. [REMEMBER: Lieblingsfarbe Blau]", isError: false, tools: { uses: [{ name: "Read", path: "src/brand.ts" }] }, ...opts.reply } as EngineResult;
    },
  };

  const coreDeps: Partial<ChatTurnDeps> = {
    getEngine: () => claude,
    resolveEngine: forbidden("resolveEngine"),
    forgetEngineCheck: () => {},
    runFallbackChain: async ({ question, context }) => {
      fallbacks.push({ question, context });
      return { text: "ersatz", source: "openrouter", model: "ersatz-modell" };
    },
    buildPromptContext: async o => {
      built.push(o);
      return { fullPrompt: `PROFIL+GEDÄCHTNIS+VERLAUF ${o.chatId}\n${o.userMessage}`, fallbackContext: `kontext ${o.chatId}` };
    },
    buildResumePrompt: forbidden("buildResumePrompt"),
    getResumableSession: forbidden("getResumableSession"),
    takeExpiredSession: forbidden("takeExpiredSession"),
    recordSessionTurn: forbidden("recordSessionTurn"),
    getSessionsForKey: forbidden("getSessionsForKey"),
    resetSession: forbidden("resetSession"),
    distillSession: forbidden("distillSession"),
    log: async () => {},
    getAgentConfig: () => ({ name: "General", model: "claude-test-modell" }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
    getSettings: () => ({}),
    resolveStreamingLimits: () => resolveStreamingLimits({}),
    reportSecrets: () => [],
    setTimer: () => 0,
    clearTimer: () => {},
    now: () => 0,
    takeCallRecap: () => undefined,
    ...GATEWAY_CORE_DEPS,
  };

  const deps: OwnerTurnDeps = {
    runJsonTurn,
    runExecution: (key, agent, fn, tools) => {
      queueKeys.push(key);
      return runExecution(key, agent, fn, tools);
    },
    saveMessage: async m => {
      saved.push(m);
      order.push(`speichern ${m.role}`);
    },
    processIntents: async (response, tools, target) => {
      intents.push({ response, tools, target });
      order.push("intents");
      await opts.processIntents?.(response, tools, target);
    },
    notice: async (_number, text) => void notices.push(text),
    coreDeps,
  };
  return { turn: createOwnerTurn(deps), requests, built, fallbacks, saved, intents, notices, queueKeys, order };
}

describe("Besitzer-Turn über den Chat-Kern", () => {
  test("Prompt aus dem Kern (Gedächtnis, Verlauf) samt WhatsApp-Hinweis, Motor Claude, Agent General", async () => {
    const h = harness();
    const reply = await h.turn(OWNER, "Merk dir: meine Lieblingsfarbe ist Blau");
    expect(reply).toBe("Notiert. [REMEMBER: Lieblingsfarbe Blau]");
    expect(h.built).toEqual([{ userMessage: "Merk dir: meine Lieblingsfarbe ist Blau", chatId: CHAT, agentName: WHATSAPP_AGENT, topicId: undefined }]);
    expect(h.requests).toHaveLength(1);
    const prompt = h.requests[0].prompt;
    expect(prompt.startsWith(`PROFIL+GEDÄCHTNIS+VERLAUF ${CHAT}`)).toBe(true);
    expect(prompt.endsWith(`${TURN_HINT_HEADING}\n${WHATSAPP_TURN_HINT}`)).toBe(true);
    expect(h.requests[0].model).toBe("claude-test-modell");
    expect(h.requests[0].resumeSessionId).toBeUndefined();
    // Kein eigener Prompt mehr
    expect(prompt).not.toContain("You are Go");
  });

  test("Nachricht und Antwort genau einmal gespeichert, Merk-Tags genau einmal durchs Tor", async () => {
    const h = harness();
    await h.turn(OWNER, "Hallo");
    expect(h.order).toEqual(["speichern user", "motor", "speichern assistant", "intents"]);
    expect(h.saved.map(m => [m.chat_id, m.role, m.content])).toEqual([
      [CHAT, "user", "Hallo"],
      [CHAT, "assistant", "Notiert. [REMEMBER: Lieblingsfarbe Blau]"],
    ]);
    expect(h.saved[0].metadata).toEqual({ channel: "whatsapp", from: OWNER });
    expect(h.saved[1].metadata).toMatchObject({ channel: "whatsapp", agent: "general", model: "claude-test-modell", engine: "claude" });
    expect(h.intents).toEqual([
      { response: "Notiert. [REMEMBER: Lieblingsfarbe Blau]", tools: { uses: [{ name: "Read", path: "src/brand.ts" }] }, target: { chatId: CHAT, origin: WHATSAPP_ORIGIN } },
    ]);
  });

  test("Warteschlange und Abbruch nutzen denselben Schlüssel (sessionKeyFor)", async () => {
    const h = harness();
    await h.turn(OWNER, "Hallo");
    expect(h.queueKeys).toEqual([`dm:${CHAT}`]);
    expect(h.requests[0].abortKey).toBe(`dm:${CHAT}`);
  });

  test("Fallback: Frage samt WhatsApp-Hinweis, Kontext des WhatsApp-Gesprächs", async () => {
    const h = harness({ reply: { text: "", isError: true } });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const reply = await h.turn(OWNER, "Wie spät ist es?");
      expect(reply).toContain("ersatz");
    } finally {
      errorSpy.mockRestore();
    }
    expect(h.fallbacks).toHaveLength(1);
    expect(h.fallbacks[0].question.startsWith("Wie spät ist es?")).toBe(true);
    expect(h.fallbacks[0].question.endsWith(WHATSAPP_TURN_HINT)).toBe(true);
    expect(h.fallbacks[0].context).toBe(`kontext ${CHAT}`);
    // Fallback-Antwort wird gespeichert, Werkzeuge unbekannt
    expect(h.saved.map(m => m.role)).toEqual(["user", "assistant"]);
    expect(h.intents[0].tools).toBeUndefined();
  });

  test("Sessions bleiben aus, auch mit SESSION_MODE=resume", async () => {
    const before = process.env.SESSION_MODE;
    process.env.SESSION_MODE = "resume";
    try {
      expect(GATEWAY_CORE_DEPS.isSessionModeEnabled!()).toBe(false);
      const h = harness();
      // Jede Session-Funktion würfe; der Turn läuft trotzdem durch
      await h.turn(OWNER, "eins");
      await h.turn(OWNER, "zwei");
      expect(h.requests.map(r => r.resumeSessionId)).toEqual([undefined, undefined]);
    } finally {
      if (before === undefined) delete process.env.SESSION_MODE;
      else process.env.SESSION_MODE = before;
    }
  });

  test("Abbruch: ABORT_REPLY, nichts gespeichert außer der Nachricht, keine Merk-Tags", async () => {
    const h = harness({ abortInEngine: true });
    expect(await h.turn(OWNER, "lange Aufgabe")).toBe(ABORT_REPLY);
    expect(h.saved.map(m => m.role)).toEqual(["user"]);
    expect(h.intents).toEqual([]);
  });

  test("Abbruch der Warteschlange (AbortError) ergibt ebenfalls ABORT_REPLY", async () => {
    const h = harness();
    const turn = createOwnerTurn({
      runJsonTurn: async () => {
        currentExecution()!.controller.abort();
        throw new DOMException("abgebrochen", "AbortError");
      },
      runExecution,
      saveMessage: async () => {},
      processIntents: async () => {
        throw new Error("darf nicht laufen");
      },
      notice: async () => {},
    });
    expect(await turn(OWNER, "x")).toBe(ABORT_REPLY);
    expect(h.saved).toEqual([]);
  });

  test("Hinweise des Kerns gehen an die Nummer des Besitzers", async () => {
    const sent: [string, string][] = [];
    const turn = createOwnerTurn({
      runJsonTurn: async o => {
        await o.sink.notice("läuft lange");
        return "fertig";
      },
      runExecution,
      saveMessage: async () => {},
      processIntents: async () => {},
      notice: async (number, text) => void sent.push([number, text]),
    });
    expect(await turn(OWNER, "x")).toBe("fertig");
    expect(sent).toEqual([[OWNER, "läuft lange"]]);
  });
});

describe("Merk-Tags mit dem echten Tor und den Zustellwegen des Gateways", () => {
  const DM = "4711";
  const WEBFETCH: TurnTools = { uses: [{ name: "WebFetch" }] };

  interface World {
    /** Aufrufe an die Telegram-Bot-API (Attrappe) */
    calls: { method: string; json: Record<string, any> }[];
    /** Für die WebUI festgehaltene Meldungen */
    recorded: Message[];
    notes: SendAndRecordInput[];
  }
  let world: World;
  const cleanups: (() => void)[] = [];

  /** Gateway-Umgebung mit oder ohne Telegram, Zustellwege wie in whatsapp-gateway.ts */
  function setup(telegram: boolean): void {
    const dir = mkdtempSync(join(tmpdir(), "tybo-wa-merk-"));
    const saved = { token: process.env.TELEGRAM_BOT_TOKEN, user: process.env.TELEGRAM_USER_ID, memory: process.env.MEMORY_FILE_PATH };
    if (telegram) {
      process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
      process.env.TELEGRAM_USER_ID = DM;
    } else {
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_USER_ID;
    }
    process.env.MEMORY_FILE_PATH = join(dir, "memory.json");
    setChoicesFileForTests(join(dir, "choices.json"));
    setPendingReviewsFileForTests(join(dir, "pending-reviews.json"));
    resetStore();
    world = { calls: [], recorded: [], notes: [] };
    let nextId = 900;
    const outbox: OutboxDeps = {
      botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
      userId: process.env.TELEGRAM_USER_ID ?? "",
      groupId: null,
      outboxDir: join(dir, "outbox"),
      fetch: async (url, init) => {
        world.calls.push({ method: url.split("/").pop() ?? "", json: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true, result: { message_id: nextId++ } }), { status: 200 });
      },
      record: async m => {
        world.recorded.push(m);
        return true;
      },
      log: () => {},
      newId: () => crypto.randomUUID(),
    };
    installWhatsAppChoices(process.env, {
      send: input => sendAndRecord(input, outbox),
      createApi: () => ({ editMessageText: async () => true, editMessageReplyMarkup: async () => true }),
    });
    // Den Klick beantwortet im Betrieb der Bot (bot-choices.ts); hier dieselben Handler
    const offReview = onChoiceDecided(
      "review",
      createReviewResults({
        decideReview,
        createRoutine: async () => ({}),
        sendAndRecord: async input => {
          world.notes.push(input);
          return { sent: true, recorded: true };
        },
        sendTelegram: async () => {},
        saveMessage: async () => true,
        dmChatId: () => (telegram ? DM : undefined),
        log: () => {},
      }).handler
    );
    const offMemory = onChoiceDecided(
      "memory",
      createMemoryChoices({
        sendAndRecord: async input => {
          world.notes.push(input);
          return { sent: true, recorded: true };
        },
        dmChatId: () => (telegram ? DM : undefined),
        log: () => {},
      }).handler
    );
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    cleanups.push(() => {
      log.mockRestore();
      warn.mockRestore();
      offReview();
      offMemory();
      setReviewNotifier(null);
      setMemoryAsker(null);
      setChoicesFileForTests(null);
      setPendingReviewsFileForTests(null);
      for (const [name, value] of [["TELEGRAM_BOT_TOKEN", saved.token], ["TELEGRAM_USER_ID", saved.user], ["MEMORY_FILE_PATH", saved.memory]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      resetStore();
      rmSync(dir, { recursive: true, force: true });
    });
  }

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  test("das Gateway richtet die Zustellwege ein, bevor ein Besitzer-Turn laufen kann (nur als Text gelesen)", async () => {
    const source = await Bun.file(join(import.meta.dir, "..", "src", "whatsapp-gateway.ts")).text();
    const installed = source.indexOf("installWhatsAppChoices(process.env)");
    expect(installed).toBeGreaterThan(0);
    expect(installed).toBeLessThan(source.indexOf("Bun.serve("));
  });

  const choicesOf = async (kind: Choice["kind"]) => (await listChoices()).filter(c => c.kind === kind);
  const buttonsOf = (call: { json: Record<string, any> }): string[] =>
    (call.json.reply_markup?.inline_keyboard ?? []).flat().map((b: { callback_data: string }) => b.callback_data);

  test("mit Telegram: WebFetch und REMEMBER ergeben einen Vorschlag mit Knöpfen im Direktchat, nichts gespeichert", async () => {
    setup(true);
    const h = harness({ reply: { text: "Laut Seite gilt X. [REMEMBER: Testwort ist Kiwi]", tools: WEBFETCH }, processIntents: processTurnIntents });
    await h.turn(OWNER, "Lies die Seite und merk dir das Testwort");

    expect(await listFacts()).not.toContain("Kiwi");
    const [choice, ...more] = await choicesOf("review");
    expect(more).toEqual([]);
    expect(choice).toMatchObject({ state: "open", conversation: { type: "telegram", chatId: DM } });
    expect(choice.text).toContain("(WhatsApp)");
    expect(choice.text).toContain("Testwort ist Kiwi");
    // Gesendet in den Direktchat, die Knöpfe sind an der Frage gemerkt
    const sends = world.calls.filter(c => c.method === "sendMessage");
    expect(sends).toHaveLength(1);
    expect(String(sends[0].json.chat_id)).toBe(DM);
    expect(buttonsOf(sends[0])).toEqual([`ch|${choice.id}|ok`, `ch|${choice.id}|no`]);
    expect(choice.telegram).toEqual([{ chatId: DM, messageId: 900 }]);
  });

  test("Zustimmung wirkt genau einmal", async () => {
    setup(true);
    const h = harness({ reply: { text: "[REMEMBER: Testwort ist Kiwi]", tools: WEBFETCH }, processIntents: processTurnIntents });
    await h.turn(OWNER, "x");
    const [choice] = await choicesOf("review");

    expect((await decideChoice(choice.id, "ok", "telegram")).status).toBe("decided");
    expect(await listFacts()).toContain("Testwort ist Kiwi");
    // Zweiter Klick (auch aus dem Browser) und ein alter Knopf ändern nichts mehr
    expect((await decideChoice(choice.id, "ok", "web")).status).toBe("already");
    expect((await decideReview("ok", choice.ref!)).kind).toBe("expired");
    expect(await takePendingReview(choice.ref!)).toBeUndefined();
    expect((await listFacts()).split("Testwort ist Kiwi")).toHaveLength(2);
    expect(world.notes.map(n => [n.chatId, n.text])).toEqual([[DM, expect.stringContaining("Übernommen: 1 Fakt(en)")]]);
  });

  test("ohne Telegram: der Vorschlag steht im Web-Direktchat der WebUI, Zustimmung dort wirkt", async () => {
    setup(false);
    const h = harness({ reply: { text: "[REMEMBER: Testwort ist Kiwi]", tools: WEBFETCH }, processIntents: processTurnIntents });
    await h.turn(OWNER, "x");

    expect(await listFacts()).not.toContain("Kiwi");
    const [choice] = await choicesOf("review");
    expect(choice).toMatchObject({ state: "open", conversation: { type: "telegram", chatId: "web" } });
    expect(world.calls).toEqual([]);
    expect(world.recorded).toHaveLength(1);
    expect(world.recorded[0]).toMatchObject({ chat_id: "web", metadata: { choiceId: choice.id } });

    expect((await decideChoice(choice.id, "ok", "web")).status).toBe("decided");
    expect((await decideChoice(choice.id, "ok", "web")).status).toBe("already");
    expect((await listFacts()).split("Testwort ist Kiwi")).toHaveLength(2);
  });

  test("mehrere FORGET-, DONE- und CANCEL-Treffer ergeben je eine erreichbare Auswahl, vorher ändert sich nichts", async () => {
    setup(true);
    await addFact("Testwort Kiwi");
    await addFact("Testwort Mango");
    for (const goal of ["Bericht A schreiben", "Bericht B schreiben", "Urlaub Juni planen", "Urlaub Juli planen"]) await addGoal(goal);
    const before = { facts: await listFacts(), goals: await listGoals() };
    const h = harness({
      // Bekannte Werkzeuge ohne fremde Inhalte: das Tor wendet direkt an
      reply: { text: "Mache ich. [FORGET: Testwort] [DONE: Bericht] [CANCEL: Urlaub]", tools: { uses: [] } },
      processIntents: processTurnIntents,
    });
    await h.turn(OWNER, "Vergiss das Testwort, Bericht ist fertig, Urlaub fällt aus");

    expect({ facts: await listFacts(), goals: await listGoals() }).toEqual(before);
    const asked = await choicesOf("memory");
    expect(asked.map(c => c.action).sort()).toEqual(["cancel", "done", "forget"]);
    const sends = world.calls.filter(c => c.method === "sendMessage");
    expect(sends).toHaveLength(3);
    for (const choice of asked) {
      expect(choice).toMatchObject({ state: "open", conversation: { type: "telegram", chatId: DM } });
      expect(choice.options.map(o => o.key)).toEqual(["e0", "e1", "none"]);
      expect(choice.telegram).toHaveLength(1);
      const send = sends.find(c => c.json.reply_markup && buttonsOf(c)[0] === `ch|${choice.id}|e0`);
      expect(send && String(send.json.chat_id)).toBe(DM);
      expect(buttonsOf(send!)).toEqual(["e0", "e1", "none"].map(key => `ch|${choice.id}|${key}`));
    }

    // Die Auswahl wirkt genau einmal, auf genau den gewählten Eintrag
    const forget = asked.find(c => c.action === "forget")!;
    const picked = forget.options[0].label.replace(/^\d+\.\s*/, "");
    expect((await decideChoice(forget.id, "e0", "telegram")).status).toBe("decided");
    expect((await decideChoice(forget.id, "e1", "telegram")).status).toBe("already");
    const after = await listFacts();
    expect(after).not.toContain(picked);
    expect(after.split("Testwort")).toHaveLength(2);
  });
});
