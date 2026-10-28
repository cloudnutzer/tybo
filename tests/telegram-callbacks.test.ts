/**
 * Issue #338: Knöpfe in Telegram über src/channels/telegram/callbacks.ts.
 * Die echte Kette (Besitzer, alte Werkzeug-Freigaben, Rückfragen-Register,
 * Weiche) hängt an einem grammY-Composer, Telegram ist eine Api-Attrappe,
 * die Routen sind Attrappen mit Protokoll. src/bot.ts wird nie geladen.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Composer, Context } from "grammy";
import {
  CALLBACK_TEXT,
  CHECKIN_BUTTONS,
  callbackRoute,
  createCallbackRouter,
  installCallbackChain,
  type CallbackRouterDeps,
  type TaskButtonDeps,
} from "../src/channels/telegram/callbacks";
import { setChoicesFileForTests } from "../src/lib/choices";
import { resumeLegacyMacTask, type LegacyTaskClaim } from "../src/lib/legacy-task-buttons";
import { resumeMacTask, type TaskResumeDeps, taskResumePrompt } from "../src/lib/task-resume";
import type { EngineRequest, EngineResult } from "../src/lib/engines/types";
import type { AsyncTask } from "../src/lib/store/types";
import { EXPIRED_APPROVAL_TEXT, expiredApprovalButtons } from "../src/channels/telegram/expired-approvals";
import { createTelegramChoices } from "../src/lib/telegram-choices";

const OWNER = "4711";
const STRANGER = "666";
const GROUP = "-1001234567890";
const TOPIC = 443;

const base = mkdtempSync(join(tmpdir(), "telegram-callbacks-"));
let counter = 0;

interface ApiCall {
  method: string;
  args: unknown[];
}

let calls: ApiCall[];
let failing: Set<string>;
let log: string[];
let errors: { message: string; err: unknown }[];
let pending: Promise<void>[];
let scoped: string[];
let unsubscribe: () => void;
let spies: { mockRestore(): void }[];

const fakeApi = new Proxy({}, {
  get: (_t, method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    if (failing.has(method)) throw new Error(`Bad Request: ${method} kaputt`);
    if (method === "sendMessage") return { message_id: 999, date: 0, chat: { id: Number(GROUP), type: "supergroup" }, text: args[1] };
    return true;
  },
});

const task = (metadata: Record<string, unknown> = {}, over: Partial<AsyncTask> = {}): AsyncTask =>
  ({
    id: "t-1",
    chat_id: GROUP,
    thread_id: TOPIC,
    original_prompt: "Plane die Woche",
    status: "running",
    pending_question: "Montag?",
    pending_options: [],
    metadata,
    ...over,
  }) as unknown as AsyncTask;

function routeDeps(over: Partial<CallbackRouterDeps> = {}, taskOver: Partial<TaskButtonDeps> = {}): CallbackRouterDeps {
  const taskDeps: TaskButtonDeps = {
    directChatIds: () => [OWNER],
    resumeSnapshot: async (t, answer, chatId) => {
      log.push(`api ${t.id} ${answer} ${chatId}`);
      return {
        status: "done",
        result: { engine: "api", text: "Antwort API", isError: false, sessionId: "s-api", tools: { uses: [] } },
        sessionId: "s-api",
        agent: "general",
        model: "claude-opus-5-5",
      };
    },
    fallbackReply: async (t, chatId) => {
      log.push(`fallback ${t.id} ${chatId}`);
      return "Ersatzantwort";
    },
    send: async (_ctx, text) => {
      log.push(`send ${text}`);
    },
    saveMessage: async message => {
      log.push(`save ${message.chat_id} ${JSON.stringify(message.metadata)}`);
    },
    processIntents: async (text, tools, target) => {
      log.push(`intents ${text} tools=${tools} ${JSON.stringify(target)}`);
    },
    updateTask: async (id, changes) => {
      log.push(`update ${id} ${JSON.stringify(changes)}`);
    },
    noteThreads: (chatId, topicId, userText, reply, startedAt) => {
      log.push(`threads ${chatId} ${topicId} ${userText} ${reply} ${startedAt}`);
    },
    abortedText: () => "Abgebrochen.",
    typing: () => ({ start: () => log.push("typing start"), stop: () => log.push("typing stop") }),
    now: () => 1234,
    claim: async () => ({ status: "claimed", task: task(), answer: "Ja", text: "Montag?\n\nGewählt: Ja" }),
    logError: (message, err) => errors.push({ message, err }),
    ...taskOver,
  };
  return {
    topicMap: async (chatId, topicId, agent) => {
      log.push(`topicmap ${chatId} ${topicId} ${agent}`);
      return "Topic 5 gehört jetzt zu research";
    },
    checkin: async (data, message) => {
      log.push(`checkin ${data} ${JSON.stringify(message)}`);
      return "Erledigt";
    },
    goal: async data => {
      log.push(`goal ${data}`);
      return "▶️ Weiter";
    },
    review: async (action, reviewId) => {
      log.push(`review ${action} ${reviewId}`);
      return { text: "Übernommen" };
    },
    task: taskDeps,
    ...over,
  };
}

let composer: Composer<Context>;

function setup(deps: CallbackRouterDeps = routeDeps()) {
  unsubscribe();
  composer = new Composer<Context>();
  unsubscribe = installCallbackChain(composer, {
    owner: OWNER,
    toolApproval: expiredApprovalButtons(OWNER),
    choices: createTelegramChoices({ api: fakeApi as any, owner: OWNER, log: () => {} }),
    router: createCallbackRouter(deps),
    scope: (ctx, run) => {
      scoped.push(ctx.callbackQuery?.data ?? "");
      const done = run();
      pending.push(done.catch(() => {}));
      return done;
    },
    logError: (message, err) => errors.push({ message, err }),
  });
}

beforeEach(() => {
  setChoicesFileForTests(join(base, `choices-${++counter}.json`));
  calls = [];
  failing = new Set();
  log = [];
  errors = [];
  pending = [];
  scoped = [];
  unsubscribe = () => {};
  spies = [spyOn(console, "log").mockImplementation(() => {})];
  setup();
});
afterEach(() => {
  unsubscribe();
  for (const s of spies) s.mockRestore();
});
afterAll(() => {
  setChoicesFileForTests(null);
  rmSync(base, { recursive: true, force: true });
});

async function click(data: string, options: { from?: string; topic?: number | null; text?: string; messageId?: number } = {}) {
  const topic = options.topic === undefined ? TOPIC : options.topic;
  const message: Record<string, unknown> = {
    message_id: options.messageId ?? 100,
    date: 0,
    chat: { id: Number(GROUP), type: "supergroup", title: "G", is_forum: true },
    text: options.text ?? "Knopf-Nachricht",
  };
  if (topic !== null) Object.assign(message, { message_thread_id: topic, is_topic_message: true });
  const update = {
    update_id: 1,
    callback_query: { id: "q1", from: { id: Number(options.from ?? OWNER), is_bot: false, first_name: "Alex" }, chat_instance: "ci", data, message },
  };
  const ctx = new Context(update as any, fakeApi as any, { id: 1, is_bot: true, first_name: "Bot", username: "bot" } as any);
  await composer.middleware()(ctx, async () => {});
  await Promise.all(pending);
}

const methods = () => calls.map(c => c.method);
const answers = () => calls.filter(c => c.method === "answerCallbackQuery");
const edits = () => calls.filter(c => c.method === "editMessageText").map(c => c.args[2]);
const sends = () => calls.filter(c => c.method === "sendMessage").map(c => ({ text: c.args[1], thread: (c.args[2] as any)?.message_thread_id }));

describe("Präfix-Tabelle", () => {
  test("jede Route erkennt ihr Präfix, Register und Werkzeug-Freigabe gehören nicht zur Weiche", () => {
    expect(callbackRoute("topicmap:5:research")).toBe("topicmap");
    expect(callbackRoute("goalkb|more|123:4")).toBe("goal");
    expect(callbackRoute("rev|ok|abc")).toBe("review");
    expect(callbackRoute("atask:abc:Ja")).toBe("task");
    for (const data of ["ch|a|b", "toolapproval:y:0f0e", "", "topicmap", "goalkb", "rev", "atask", "CH|a|b", "Rev|ok|a"]) {
      expect(callbackRoute(data)).toBeNull();
    }
  });

  test("Check-in-Knöpfe nur genau die vier Werte, kein offenes Präfix", () => {
    expect([...CHECKIN_BUTTONS].sort()).toEqual(["call_no", "call_yes", "dismiss", "snooze"]);
    for (const data of CHECKIN_BUTTONS) expect(callbackRoute(data)).toBe("checkin");
    for (const data of ["snooze:30", "call_yes_now", "xdismiss", "Snooze", "call_", "dismiss "]) expect(callbackRoute(data)).toBeNull();
  });
});

describe("Routen der Weiche", () => {
  test("topicmap: Zuordnung mit Chat, Topic und Agent, Nachricht ersetzt, einmal beantwortet", async () => {
    await click("topicmap:5:research");
    expect(log).toEqual([`topicmap ${GROUP} 5 research`]);
    expect(edits()).toEqual(["Topic 5 gehört jetzt zu research"]);
    expect(answers()).toHaveLength(1);
    expect(answers()[0].args).toEqual(["q1", undefined]);
    // Antwort vor der Bearbeitung
    expect(methods()).toEqual(["answerCallbackQuery", "editMessageText"]);
  });

  test("topicmap ohne Agent: leere Teile wie bisher", async () => {
    await click("topicmap:");
    expect(log).toEqual([`topicmap ${GROUP}  `]);
  });

  test("Check-in: Knopf mit Chat, Nachricht und deren Text; Nachricht ersetzt", async () => {
    for (const data of CHECKIN_BUTTONS) await click(data, { messageId: 70, text: "Check-in about:\n\nSport" });
    expect(log).toEqual(CHECKIN_BUTTONS.map(d => `checkin ${d} ${JSON.stringify({ chatId: GROUP, messageId: 70, text: "Check-in about:\n\nSport" })}`));
    expect(edits()).toEqual(Array(4).fill("Erledigt"));
  });

  test("Check-in liefert null: Nachricht bleibt", async () => {
    setup(routeDeps({ checkin: async () => null }));
    await click("snooze");
    expect(edits()).toEqual([]);
    expect(answers()).toHaveLength(1);
  });

  test("goalkb|: Text ersetzt; leer oder null lässt die Nachricht stehen", async () => {
    await click("goalkb|more|123:4");
    expect(log).toEqual(["goal goalkb|more|123:4"]);
    expect(edits()).toEqual(["▶️ Weiter"]);
    for (const reply of ["", null]) {
      calls = [];
      setup(routeDeps({ goal: async () => reply }));
      await click("goalkb|was|123:4");
      expect(edits()).toEqual([]);
      expect(answers()).toHaveLength(1);
    }
  });

  test("rev|: Aktion und Kennung getrennt, Text ersetzt; leerer Text lässt stehen", async () => {
    for (const data of ["rev|ok|abc", "rev|no|abc", "rev|routine|abc"]) await click(data);
    expect(log).toEqual(["review ok abc", "review no abc", "review routine abc"]);
    expect(edits()).toEqual(Array(3).fill("Übernommen"));
    calls = [];
    setup(routeDeps({ review: async () => ({ text: "" }) }));
    await click("rev|ok");
    expect(edits()).toEqual([]);
  });

  test("unbekannte und fehlerhafte Daten: nur beantwortet, keine Route, keine Bearbeitung", async () => {
    for (const data of ["foo", "snooze:30", "topicmap", "goalkb", "rev", "atask", "CH|a|b", "chx|a|b"]) await click(data);
    expect(log).toEqual([]);
    expect(methods()).toEqual(Array(8).fill("answerCallbackQuery"));
  });

  test("jeder Klick läuft im Bereich des Updates", async () => {
    await click("rev|ok|abc");
    await click("foo");
    expect(scoped).toEqual(["rev|ok|abc", "foo"]);
  });
});

describe("Kette", () => {
  test("fremder Absender: keine Route, keine Antwort, auch nicht für Register und Freigabe", async () => {
    for (const data of ["topicmap:5:research", "snooze", "atask:t-1:Ja", "ch|abc|y", "toolapproval:y:0f0e0d0c-0b0a-0908-0706-050403020100"]) {
      await click(data, { from: STRANGER });
    }
    expect(log).toEqual([]);
    expect(calls).toEqual([]);
    expect(scoped).toEqual([]);
  });

  test("toolapproval: nur die alte Freigabe antwortet, die Weiche läuft nicht", async () => {
    await click("toolapproval:y:0f0e0d0c-0b0a-0908-0706-050403020100");
    expect(scoped).toEqual([]);
    expect(answers().map(c => (c.args[1] as any)?.text)).toEqual([EXPIRED_APPROVAL_TEXT]);
  });

  test("ch|: das Register antwortet genau einmal, die Weiche läuft nicht", async () => {
    await click("ch|Unbekannt12|y");
    await click("ch|");
    expect(scoped).toEqual([]);
    expect(answers().map(c => (c.args[1] as any)?.text)).toEqual(["Abgelaufen", "Ungültiger Knopf"]);
  });

  test("ohne Register (Telegram ohne Rückfrage-Knöpfe): ch| landet in der Weiche und wird nur beantwortet", async () => {
    unsubscribe();
    composer = new Composer<Context>();
    unsubscribe = installCallbackChain(composer, { owner: OWNER, toolApproval: expiredApprovalButtons(OWNER), router: createCallbackRouter(routeDeps()), scope: (_c, run) => { const d = run(); pending.push(d); return d; } });
    await click("ch|abc|y");
    expect(methods()).toEqual(["answerCallbackQuery"]);
    expect(log).toEqual([]);
  });

  test("Telegram-Fehler beim Beantworten und Bearbeiten: Route läuft, nichts geworfen", async () => {
    failing = new Set(["answerCallbackQuery", "editMessageText"]);
    await click("rev|ok|abc");
    await click("topicmap:5:research");
    expect(log).toEqual(["review ok abc", `topicmap ${GROUP} 5 research`]);
    expect(errors).toEqual([]);
  });

  test("Route wirft: als Callback-Fehler geloggt, nicht weitergeworfen", async () => {
    const boom = new Error("kaputt");
    setup(routeDeps({ review: async () => { throw boom; } }));
    await click("rev|ok|abc");
    expect(errors).toEqual([{ message: "Callback query error:", err: boom }]);
  });
});

describe("atask: alter Auftrag", () => {
  test("Ort des Klicks: Chat und Topic der Knopf-Nachricht; ohne Topic nur der Chat", async () => {
    setup(routeDeps({}, {
      claim: async (data, place) => {
        log.push(`claim ${data} ${JSON.stringify(place)}`);
        return { status: "rejected", text: "x", keepButtons: false };
      },
    }));
    await click("atask:t-1:Ja");
    await click("atask:t-1:Ja", { topic: null });
    const claims = log.filter(l => l.startsWith("claim"));
    expect(claims).toEqual([`claim atask:t-1:Ja {"chatId":"${GROUP}","threadId":${TOPIC}}`, `claim atask:t-1:Ja {"chatId":"${GROUP}"}`]);
  });

  test("abgewiesen mit gültigen Knöpfen: Meldung als neue Nachricht im Topic, nichts ersetzt, nichts fortgesetzt", async () => {
    setup(routeDeps({}, { claim: async () => ({ status: "rejected", text: "Nicht gespeichert", keepButtons: true }) }));
    await click("atask:t-1:Ja");
    expect(sends()).toEqual([{ text: "Nicht gespeichert", thread: TOPIC }]);
    expect(edits()).toEqual([]);
    expect(log).toEqual([]);
  });

  test("abgewiesen oder abgebrochen: Nachricht ersetzt, nichts fortgesetzt", async () => {
    const outcomes: LegacyTaskClaim[] = [
      { status: "rejected", text: "Schon beantwortet", keepButtons: false },
      { status: "cancelled", text: "Montag?\n\nAbgebrochen." },
    ];
    for (const outcome of outcomes) {
      setup(routeDeps({}, { claim: async () => outcome }));
      await click("atask:t-1:Abbrechen");
    }
    expect(edits()).toEqual(["Schon beantwortet", "Montag?\n\nAbgebrochen."]);
    expect(log).toEqual([]);
  });

  // Issue #349: alte Aufträge des Agent SDK laufen wie jeder Auftrag ohne
  // messages_snapshot über resumeLegacyMacTask (echt, mit echtem
  // resumeMacTask); nur Motor, Sitzungsablage und Auftragsspeicher sind
  // Attrappen. agent_sdk_session_id wird nie benutzt.
  const SDK_META = { use_agent_sdk: true, agent_sdk_session_id: "sdk-1", agent_name: "research" };

  function viaMac(o: { session?: string; run?: (req: EngineRequest) => Promise<EngineResult> }) {
    const runs: EngineRequest[] = [];
    const macDeps: Partial<TaskResumeDeps> = {
      runExecution: (async (_key: string, _agent: string, fn: () => Promise<unknown>) => fn()) as TaskResumeDeps["runExecution"],
      getEngine: (() => ({
        id: "claude",
        describe: () => "Claude Code",
        run: async (req: EngineRequest) => {
          runs.push(req);
          return o.run ? o.run(req) : { engine: "claude", text: "Erledigt, Montag steht.", isError: false, sessionId: req.resumeSessionId };
        },
      })) as unknown as TaskResumeDeps["getEngine"],
      isSessionModeEnabled: () => true,
      getResumableSession: (async () => (o.session ? { engine: "claude", engineSessionId: o.session, startedAt: 1, messageCount: 1 } : undefined)) as unknown as TaskResumeDeps["getResumableSession"],
      sessionEpoch: () => 0,
      finalizeClaudeSession: (async () => {}) as unknown as TaskResumeDeps["finalizeClaudeSession"],
      resolveModel: () => "m",
      resolveEffort: () => undefined,
      allowedTools: () => undefined,
      cwd: "/tmp",
    };
    const resumeMac: TaskButtonDeps["resumeMac"] = (t, answer, place, deps) =>
      resumeLegacyMacTask(t, answer, place, {
        ...deps,
        resume: (task, chatId, choice) => resumeMacTask(task, chatId, choice, macDeps),
        tasks: () => ({ update: async (id, changes) => (log.push(`update ${id} ${JSON.stringify(changes)}`), true) }),
        processIntents: async (text, _tools, target) => void log.push(`intents ${text} ${JSON.stringify(target)}`),
        log: () => {},
      });
    return { runs, resumeMac };
  }

  test("Agent SDK, passende lokale Sitzung: über resumeLegacyMacTask, gespeichert als task_resume, SDK-Sitzung unbenutzt", async () => {
    const mac = viaMac({ session: "lokal-1" });
    setup(routeDeps({}, { resumeMac: mac.resumeMac, claim: async () => ({ status: "claimed", task: task(SDK_META), answer: "Ja", text: "Montag?\n\nGewählt: Ja" }) }));
    await click("atask:t-1:Ja");
    expect(edits()).toEqual(["Montag?\n\nGewählt: Ja"]);
    expect(mac.runs).toHaveLength(1);
    expect(mac.runs[0]!.resumeSessionId).toBe("lokal-1");
    expect(mac.runs[0]!.prompt).toBe(taskResumePrompt("Ja"));
    expect(JSON.stringify(mac.runs)).not.toContain("sdk-1");
    const save = log.find(l => l.startsWith("save "))!;
    expect(save).toStartWith(`save ${GROUP} `);
    expect(JSON.parse(save.slice(`save ${GROUP} `.length))).toEqual({ type: "task_resume", taskId: "t-1", agent: "research", topicId: TOPIC });
    expect(log).toContain("send Erledigt, Montag steht.");
    const update = JSON.parse(log.find(l => l.startsWith("update "))!.slice("update t-1 ".length));
    expect(update).toMatchObject({ status: "completed", result: "Erledigt, Montag steht.", session_id: "lokal-1" });
    expect(log.at(-1)).toBe("typing stop");
  });

  test("Agent SDK ohne lokale Sitzung: nur die Auswahl bestätigt, completed, keine Modellantwort gespeichert", async () => {
    const mac = viaMac({});
    setup(routeDeps({}, { resumeMac: mac.resumeMac, claim: async () => ({ status: "claimed", task: task(SDK_META), answer: "Ja", text: "Gewählt" }) }));
    await click("atask:t-1:Ja");
    expect(mac.runs).toHaveLength(0);
    expect(log.some(l => l.startsWith("save "))).toBe(false);
    expect(log.some(l => l.startsWith("send "))).toBe(false);
    expect(log).toContain(`update t-1 ${JSON.stringify({ status: "completed", result: "Ohne Sitzung bestätigt" })}`);
    expect(sends()).toHaveLength(1);
    expect(sends()[0]!.thread).toBe(TOPIC);
    expect(sends()[0]!.text).toContain("Ja");
  });

  test("messages_snapshot: Motor api mit Auftrag, Antwort und Chat, Abschluss wie im Mac-Zweig samt Werkzeugen", async () => {
    const meta = { messages_snapshot: [{ role: "user", content: "Plane die Woche" }], assistant_content: [{ type: "text", text: "x" }], tool_use_id: "tu-1" };
    let conversation: unknown;
    setup(routeDeps({}, {
      claim: async () => ({ status: "claimed", task: task(meta), answer: "nein", text: "Gewählt" }),
      resumeMac: async (t, answer, place, deps) => {
        conversation = deps.conversation;
        const outcome = await deps.resume!(t, place.chatId, answer);
        log.push(`mac ${JSON.stringify(outcome)}`);
        await deps.processIntents!("Antwort API", { uses: [{ name: "firecrawl_scrape", external: true }] }, { chatId: GROUP, topicId: TOPIC, origin: "Telegram" });
        return { status: "replied", response: "Antwort API" };
      },
    }));
    await click("atask:t-1:nein");
    expect(log[1]).toBe(`api t-1 nein ${GROUP}`);
    expect(JSON.parse(log[2].slice("mac ".length))).toEqual({
      status: "done",
      result: { engine: "api", text: "Antwort API", isError: false, sessionId: "s-api", tools: { uses: [] } },
      resumeId: "s-api",
      agent: "general",
      engine: "api",
      model: "claude-opus-5-5",
    });
    // Werkzeuge des Laufs gehen an das Merk-Tag-Tor, nicht undefined
    expect(log[3]).toStartWith("intents Antwort API tools=[object Object]");
    expect(conversation).toEqual({ type: "telegram", chatId: GROUP, topicId: TOPIC });
    expect(log.slice(4)).toEqual([`threads ${GROUP} ${TOPIC} nein Antwort API 1234`, "typing stop"]);
  });

  test("messages_snapshot: Motorfehler ergibt die Ersatzantwort, Auftrag failed", async () => {
    setup(routeDeps({}, {
      claim: async () => ({ status: "claimed", task: task({ messages_snapshot: [] }), answer: "Ja", text: "Gewählt" }),
      resumeSnapshot: async () => ({ status: "done", result: { engine: "api", text: "Anthropic API 529: Overloaded", isError: true, errorKind: "capacity" }, sessionId: "s", agent: "general", model: "m" }),
    }));
    await click("atask:t-1:Ja");
    expect(errors.map(e => e.message)).toEqual(["API resume error:"]);
    expect(log).toEqual(["typing start", `fallback t-1 ${GROUP}`, "send Ersatzantwort", `update t-1 ${JSON.stringify({ status: "failed", result: "Error: Anthropic API 529: Overloaded" })}`, "typing stop"]);
  });

  test("messages_snapshot unvollständig: kein Motor, Auftrag failed, Meldung im Topic", async () => {
    setup(routeDeps({}, {
      claim: async () => ({ status: "claimed", task: task({ messages_snapshot: [] }), answer: "Ja", text: "Gewählt" }),
      resumeSnapshot: async () => ({ status: "invalid", text: "Nicht fortsetzbar" }),
    }));
    await click("atask:t-1:Ja");
    expect(sends()).toEqual([{ text: "Nicht fortsetzbar", thread: TOPIC }]);
    expect(log).toEqual(["typing start", `update t-1 ${JSON.stringify({ status: "failed", result: "Nicht fortsetzbar" })}`, "typing stop"]);
  });

  test("Agent SDK, lange Antwort: Ergebnis im Auftrag auf 10.000 Zeichen gekürzt", async () => {
    const long = "x".repeat(12_000);
    const mac = viaMac({ session: "lokal-1", run: async req => ({ engine: "claude", text: long, isError: false, sessionId: req.resumeSessionId }) });
    setup(routeDeps({}, { resumeMac: mac.resumeMac, claim: async () => ({ status: "claimed", task: task(SDK_META), answer: "Ja", text: "Gewählt" }) }));
    await click("atask:t-1:Ja");
    const update = log.find(l => l.startsWith("update"))!;
    expect(JSON.parse(update.slice("update t-1 ".length)).result).toHaveLength(10_000);
  });

  test("Agent SDK, Motor scheitert: Auftrag failed, Meldung im Topic, nichts gespeichert, kein Faden", async () => {
    const mac = viaMac({ session: "lokal-1", run: async () => ({ engine: "claude", text: "kaputt", isError: true }) });
    setup(routeDeps({}, { resumeMac: mac.resumeMac, claim: async () => ({ status: "claimed", task: task(SDK_META), answer: "Ja", text: "Gewählt" }) }));
    await click("atask:t-1:Ja");
    expect(log).toContain(`update t-1 ${JSON.stringify({ status: "failed", result: "Fortsetzen gescheitert (Motorfehler)" })}`);
    expect(log.some(l => l.startsWith("save ") || l.startsWith("threads "))).toBe(false);
    expect(sends().map(s => s.thread)).toEqual([TOPIC]);
  });

  test("auch der Ersatz scheitert: Fehlermeldung im Chat, Auftrag failed", async () => {
    setup(routeDeps({}, {
      resumeSnapshot: async () => { throw new Error("API weg"); },
      fallbackReply: async () => { throw new Error("Ersatz weg"); },
      claim: async () => ({ status: "claimed", task: task({ messages_snapshot: [] }), answer: "Ja", text: "Gewählt" }),
    }));
    await click("atask:t-1:Ja");
    expect(errors.map(e => e.message)).toEqual(["API resume error:"]);
    expect(sends().map(s => s.text)).toEqual([CALLBACK_TEXT.resumeFailed]);
    expect(log).toContain(`update t-1 ${JSON.stringify({ status: "failed", result: "Error: API weg" })}`);
    expect(log.at(-1)).toBe("typing stop");
  });

  test("Mac-Zweig: Gespräch mit Topic, Antwort über den Zustellweg, Meldungen ins Topic, Faden nach gezeigter Antwort", async () => {
    let seen: { conversation: unknown; place: unknown; answer: string } | undefined;
    setup(routeDeps({}, {
      resumeMac: async (t, answer, place, deps) => {
        seen = { conversation: deps.conversation, place, answer };
        expect(deps.abortedText()).toBe("Abgebrochen.");
        expect(await deps.reply("Antwort Mac")).toBe(false); // send ohne Telegram-Versand: nichts angekommen
        await deps.notice("Kurze Meldung");
        await deps.saveMessage({ chat_id: GROUP, role: "assistant", content: "Antwort Mac", metadata: { kind: "mac" } });
        return { status: "replied", response: "Antwort Mac" };
      },
    }));
    await click("atask:t-1:Ja");
    expect(seen).toEqual({ conversation: { type: "telegram", chatId: GROUP, topicId: TOPIC }, place: { chatId: GROUP, threadId: TOPIC }, answer: "Ja" });
    expect(sends()).toEqual([{ text: "Kurze Meldung", thread: TOPIC }]);
    expect(log).toEqual(["typing start", "send Antwort Mac", `save ${GROUP} {"kind":"mac"}`, `threads ${GROUP} ${TOPIC} Ja Antwort Mac 1234`, "typing stop"]);
  });

  test("Mac-Zweig: Antwort angekommen zählt der Zustellweg; ohne Topic Gespräch ohne topicId; beendet ohne Faden", async () => {
    let delivered: boolean | undefined;
    let conversation: unknown;
    setup(routeDeps({}, {
      send: async (ctx, text) => { await ctx.reply(text); },
      resumeMac: async (_t, _a, _p, deps) => {
        conversation = deps.conversation;
        delivered = await deps.reply("Antwort");
        return { status: "ended" };
      },
    }));
    await click("atask:t-1:Ja", { topic: null });
    expect(delivered).toBe(true);
    expect(conversation).toEqual({ type: "telegram", chatId: GROUP });
    expect(log.filter(l => l.startsWith("threads"))).toEqual([]);
    expect(log).toEqual(["typing start", "typing stop"]);
  });

  test("Mac-Zweig wirft: Tippen endet trotzdem, Fehler als Callback-Fehler geloggt", async () => {
    const boom = new Error("Sperre");
    setup(routeDeps({}, { resumeMac: async () => { throw boom; } }));
    await click("atask:t-1:Ja");
    expect(log).toEqual(["typing start", "typing stop"]);
    expect(errors).toEqual([{ message: "Callback query error:", err: boom }]);
  });
});
