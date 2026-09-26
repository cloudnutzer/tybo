/**
 * Issue #117: Merk-Vorschläge und Routine-Angebote als Rückfrage im Register.
 *
 * Echt: Rückfragen-Register und Vorschlags-Ablage (Temp-Dateien), Tor
 * (processTurnIntents), decideReview, Telegram-Seite des Registers
 * (createTelegramChoices mit Middleware und Zuhörer), ChoicePort der WebUI.
 * Attrappen: Telegram-API (Senden und Bearbeiten), Gedächtnis
 * (processIntents, saveMessage), Routine-Erstellung, Web-Gespräch (postWeb).
 * src/bot.ts wird nie importiert; die Verdrahtung dort wird als Text geprüft.
 */
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Composer, Context } from "grammy";
import {
  decideChoice,
  expireLapsedChoices,
  getChoice,
  getChoiceChecked,
  listChoices,
  onChoiceChange,
  onChoiceDecided,
  setChoicesFileForTests,
  type Choice,
} from "../src/lib/choices";
import { decideReview, processTurnIntents, type IntentGateDeps } from "../src/lib/intent-gate";
import type { ProcessedIntents } from "../src/lib/memory";
import type { SendAndRecordInput, SendAndRecordResult } from "../src/lib/outbox";
import {
  createReviewNotifier,
  createReviewResults,
  REVIEW_TEXT,
  routineStartText,
  type ReviewResults,
  type WebPost,
} from "../src/lib/review-choices";
import {
  distillSession,
  parseStorageKey,
  REVIEW_MAX_AGE_MS,
  setPendingReviewsFileForTests,
  setReviewNotifier,
  stagePendingReview,
  stageRoutineReview,
  takePendingReview,
} from "../src/lib/session-distill";
import type { BotSession } from "../src/lib/session-manager";
import { createTelegramChoices, EXPIRED_LINE, installTelegramChoices } from "../src/lib/telegram-choices";
import { createChoicePort, type ChoiceChange, type ChoicePort } from "../src/web/choices";

const USER = "4711";
const GROUP = "-1001234567890";
const WEB_ID = "0b8f2a3c-1d2e-4f50-8a6b-7c8d9e0f1a2b";
const PROJECT = "/tmp/tybo-projekt";
const WEBFETCH = { uses: [{ name: "WebFetch" }], cwd: PROJECT };
const EMPTY: ProcessedIntents = { goalsAdded: [], goalsCompleted: [], goalsCancelled: [], factsAdded: [], factsRemoved: [] };

const base = mkdtempSync(join(tmpdir(), "review-choices-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

interface ApiCall {
  method: string;
  args: unknown[];
}

/** Alles, was ein Test beobachtet */
interface World {
  /** Gedächtnis: angewendete Tag-Texte */
  applied: string[];
  /** Nachrichten an Telegram mit Festhalten (Rückfragen und Meldungen) */
  sent: SendAndRecordInput[];
  /** Telegram ohne Festhalten (Routine-Bericht) */
  plain: { chatId: string; text: string; topicId?: number }[];
  saved: { chat_id: string; role: string; content: string; metadata: Record<string, unknown> }[];
  web: { conversationId: string; post: WebPost }[];
  api: ApiCall[];
  routines: { session: BotSession; hint: string }[];
  background: Promise<void>[];
  changes: ChoiceChange[];
  port: ChoicePort;
  results: ReviewResults;
  /** Klick auf einen Telegram-Knopf an Nachricht messageId (wie in src/bot.ts verkettet) */
  click(data: string, messageId: number, chatId?: string): Promise<void>;
  /** Frage im Browser entscheiden, wie POST /api/conversations/<id>/choices/<choiceId> */
  browser(conversationId: string, choiceId: string, option: string): ReturnType<ChoicePort["decide"]>;
  /** routine: Ergebnis der Attrappe */
  routineResult: { isError?: boolean; text?: string } | Error;
  /** postWeb nimmt an (Gespräch vorhanden) */
  webAvailable: boolean;
}

let w: World;
let cleanup: (() => void)[] = [];
let counter = 0;
let pendingFile = "";
let logSpy: ReturnType<typeof spyOn>;

const gate: Partial<IntentGateDeps> = { log: () => {}, projectRoot: PROJECT, dmChatId: () => USER };

function setup(): World {
  counter++;
  pendingFile = join(base, `pending-${counter}.json`);
  setPendingReviewsFileForTests(pendingFile);
  setChoicesFileForTests(join(base, `choices-${counter}.json`));
  let nextMessage = 100;
  const world = {
    applied: [],
    sent: [],
    plain: [],
    saved: [],
    web: [],
    api: [],
    routines: [],
    background: [],
    changes: [],
    routineResult: { text: "Routine gespeichert: skill wochenbericht" },
    webAvailable: true,
  } as unknown as World;

  // Telegram: sendAndRecord-Attrappe (merkt Nachricht mit Knöpfen) und Bearbeiten
  const send = async (input: SendAndRecordInput): Promise<SendAndRecordResult> => {
    world.sent.push(input);
    const chatId = input.chatId ?? USER;
    return { sent: true, recorded: true, messages: [{ chatId, messageId: nextMessage++, part: "text", buttons: !!input.buttons }] } as SendAndRecordResult;
  };
  const api = {
    answerCallbackQuery: async (...args: unknown[]) => { world.api.push({ method: "answerCallbackQuery", args }); return true; },
    editMessageText: async (...args: unknown[]) => { world.api.push({ method: "editMessageText", args }); return true; },
    editMessageReplyMarkup: async (...args: unknown[]) => { world.api.push({ method: "editMessageReplyMarkup", args }); return true; },
  };
  const telegramChoices = createTelegramChoices({ api, owner: USER, send, log: () => {} });
  const composer = new Composer<Context>();
  cleanup.push(installTelegramChoices(composer, telegramChoices));

  const postWeb = async (conversationId: string, post: WebPost) => {
    if (!world.webAvailable) return false;
    world.web.push({ conversationId, post });
    return true;
  };
  const processIntents = async (t: string) => {
    world.applied.push(t);
    return { ...EMPTY, factsAdded: [...t.matchAll(/\[REMEMBER:/g)].map(() => "x") };
  };
  world.results = createReviewResults({
    decideReview: (action, reviewId) => decideReview(action, reviewId, { takePendingReview, processIntents }),
    createRoutine: async (session, hint) => {
      world.routines.push({ session, hint });
      if (world.routineResult instanceof Error) throw world.routineResult;
      return world.routineResult;
    },
    sendAndRecord: send,
    sendTelegram: async (chatId, text, topicId) => {
      world.plain.push({ chatId, text, ...(topicId !== undefined ? { topicId } : {}) });
    },
    saveMessage: async m => {
      world.saved.push(m);
    },
    postWeb,
    dmChatId: () => USER,
    background: p => world.background.push(p),
    log: () => {},
  });
  cleanup.push(onChoiceDecided("review", world.results.handler));
  setReviewNotifier(createReviewNotifier({ sendChoice: c => telegramChoices.sendChoice(c), postWeb, log: () => {} }));

  world.port = createChoicePort({
    register: { get: getChoiceChecked, list: listChoices, decide: decideChoice, onChange: onChoiceChange },
    userId: USER,
    groupId: () => GROUP,
    every: () => () => {},
    log: () => {},
  });
  cleanup.push(world.port.subscribe(c => world.changes.push(c)));

  world.click = async (data, messageId, chatId = USER) => {
    const update = {
      update_id: 1,
      callback_query: {
        id: "q1",
        from: { id: Number(USER), is_bot: false, first_name: "E" },
        chat_instance: "ci",
        data,
        message: { message_id: messageId, date: 0, chat: { id: Number(chatId), type: chatId.startsWith("-") ? "supergroup" : "private", first_name: "E" } },
      },
    };
    const ctx = new Context(update as any, api as any, { id: 1, is_bot: true, first_name: "Bot", username: "bot" } as any);
    await composer.middleware()(ctx, async () => {});
  };
  world.browser = (conversationId, choiceId, option) => world.port.decide(conversationId, choiceId, option, "web");
  return world;
}

beforeEach(() => {
  cleanup = [];
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  delete process.env.DISTILL_AUTO_APPLY;
  w = setup();
});
afterEach(() => {
  for (const off of cleanup) off();
  setReviewNotifier(null);
  setSystemTime();
  logSpy.mockRestore();
  delete process.env.DISTILL_AUTO_APPLY;
});
afterAll(() => {
  setPendingReviewsFileForTests(null);
  setChoicesFileForTests(null);
});

const pendingOnDisk = () => (existsSync(pendingFile) ? JSON.parse(readFileSync(pendingFile, "utf-8")) : {});
const edits = () => w.api.filter(c => c.method === "editMessageText").map(c => ({ chatId: c.args[0], messageId: c.args[1], text: String(c.args[2]) }));
/** Die Frage im Register und die Nachricht mit ihren Knöpfen */
async function onlyChoice(): Promise<{ choice: Choice; messageId: number; chatId: string }> {
  const list = await listChoices();
  expect(list).toHaveLength(1);
  const ref = list[0].telegram![0];
  return { choice: list[0], messageId: ref.messageId, chatId: ref.chatId };
}
/** Meldungen (source review) ohne Knöpfe, also Ergebnisse */
const notices = () => w.sent.filter(s => !s.buttons).map(s => ({ chatId: s.chatId, topicId: s.topicId, text: s.text }));

/** Merk-Vorschlag aus einem Turn mit fremden Inhalten im Topic 9 */
async function topicProposal(tags = "[REMEMBER: x]"): Promise<{ choice: Choice; messageId: number; chatId: string }> {
  expect(await processTurnIntents(`Laut Seite ${tags}`, WEBFETCH, { chatId: GROUP, topicId: 9, origin: "Telegram" }, gate)).toBe("staged");
  return onlyChoice();
}

describe("Vorschlag als Rückfrage", () => {
  test("Turn mit fremden Inhalten im Topic: Frage im Topic, Knöpfe ch|, ref = Review-ID, nichts angewendet", async () => {
    const { choice } = await topicProposal();
    const [review] = Object.values(pendingOnDisk()) as any[];
    expect(choice).toMatchObject({ kind: "review", ref: review.id, conversation: { type: "telegram", chatId: GROUP, topicId: 9 }, state: "open" });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ chatId: GROUP, topicId: 9, source: "review", choiceId: choice.id, format: "plain" });
    expect(w.sent[0].buttons).toEqual([[
      { text: "Übernehmen", callback_data: `ch|${choice.id}|ok` },
      { text: "Verwerfen", callback_data: `ch|${choice.id}|no` },
    ]]);
    expect(w.applied).toEqual([]);
    // Im Browser: Knöpfe im Topic-Gespräch
    expect(await w.port.view(choice.id, "topic-9")).toEqual({ id: choice.id, state: "open", options: choice.options });
  });

  test("DISTILL_AUTO_APPLY=true: Merk-Tags aus fremden Inhalten bleiben Vorschlag mit Rückfrage", async () => {
    process.env.DISTILL_AUTO_APPLY = "true";
    const { choice } = await topicProposal();
    expect(choice.kind).toBe("review");
    expect(w.applied).toEqual([]);
  });
});

describe("Akzeptanz: Übernehmen im Browser", () => {
  test("schreibt die Einträge genau einmal, Telegram-Nachricht zeigt „(im Browser)“, Ergebnis in Telegram und Browser", async () => {
    const { choice, messageId } = await topicProposal("[REMEMBER: a] [REMEMBER: b]");
    const outcome = await w.browser("topic-9", choice.id, "ok");
    expect(outcome.status).toBe("decided");
    expect(w.applied).toEqual(["[REMEMBER: a]\n[REMEMBER: b]"]);
    expect(pendingOnDisk()).toEqual({});

    // Telegram-Nachricht mit den Knöpfen nachgezogen
    expect(edits()).toEqual([{ chatId: GROUP, messageId, text: `${choice.text}\n\n✓ Übernehmen (im Browser)` }]);
    // Ergebnis als Meldung im Topic (festgehalten: erscheint auch im Browser)
    expect(notices()).toEqual([{ chatId: GROUP, topicId: 9, text: "✅ Übernommen: 2 Fakt(en), 0 Ziel(e)." }]);
    expect(w.sent.at(-1)).toMatchObject({ source: "review", format: "plain" });

    // Danach aus Telegram und nochmal im Browser: schon erledigt, nichts doppelt
    await w.click(`ch|${choice.id}|ok`, messageId, GROUP);
    expect((await w.browser("topic-9", choice.id, "ok")).status).toBe("already");
    expect(w.applied).toHaveLength(1);
    expect(notices()).toHaveLength(1);
  });

  test("Browser und Telegram gleichzeitig: genau eine Entscheidung, genau einmal geschrieben", async () => {
    const { choice, messageId } = await topicProposal();
    const [web] = await Promise.all([w.browser("topic-9", choice.id, "ok"), w.click(`ch|${choice.id}|no`, messageId, GROUP)]);
    const stored = await getChoice(choice.id);
    expect(stored!.state).toBe("done");
    expect(w.applied.length + notices().filter(n => n.text === REVIEW_TEXT.discarded).length).toBe(1);
    if (stored!.result!.via === "web") {
      expect(web.status).toBe("decided");
      expect(w.applied).toEqual(["[REMEMBER: x]"]);
    } else {
      expect(web.status).toBe("already");
      expect(w.applied).toEqual([]);
    }
    expect(notices()).toHaveLength(1);
  });

  test("aus einem anderen Gespräch nicht entscheidbar", async () => {
    const { choice } = await topicProposal();
    expect(await w.browser("dm", choice.id, "ok")).toEqual({ status: "not_found" });
    expect(await w.browser("topic-10", choice.id, "ok")).toEqual({ status: "not_found" });
    expect(w.applied).toEqual([]);
  });
});

describe("Akzeptanz: Verwerfen in Telegram", () => {
  test("Browser bekommt ohne Neuladen „Erledigt: Verwerfen · in Telegram“, nichts gespeichert", async () => {
    const { choice, messageId } = await topicProposal();
    await w.click(`ch|${choice.id}|no`, messageId, GROUP);
    expect(w.applied).toEqual([]);
    expect(pendingOnDisk()).toEqual({});
    // Live-Änderung an das Gespräch (SSE choice), daraus zeigt app.js „Erledigt: Verwerfen · in Telegram“
    const change = w.changes.find(c => c.choice.id === choice.id)!;
    expect(change.conversationId).toBe("topic-9");
    expect(change.choice).toMatchObject({ state: "done", options: [], result: { key: "no", label: "Verwerfen", via: "telegram" } });
    expect(edits()).toEqual([{ chatId: GROUP, messageId, text: `${choice.text}\n\n✓ Verwerfen (in Telegram)` }]);
    expect(notices()).toEqual([{ chatId: GROUP, topicId: 9, text: REVIEW_TEXT.discarded }]);
  });
});

describe("Akzeptanz: nach 7 Tagen abgelaufen", () => {
  test("Browser, Telegram und Ablauf-Lauf: nichts geschrieben, Knöpfe weg", async () => {
    const { choice, messageId } = await topicProposal();
    setSystemTime(new Date(Date.now() + REVIEW_MAX_AGE_MS + 60_000));
    expect((await w.browser("topic-9", choice.id, "ok")).status).toBe("expired");
    await w.click(`ch|${choice.id}|ok`, messageId, GROUP);
    expect(w.applied).toEqual([]);
    expect(notices()).toEqual([]);
    // Klick in Telegram: nur die Knöpfe dieser Nachricht weg
    expect(w.api.filter(c => c.method === "editMessageReplyMarkup").map(c => c.args[1])).toEqual([messageId]);
    // Ablauf-Lauf (im Bot jede Minute): Telegram-Nachricht mit „Abgelaufen“ nachgezogen
    expect((await expireLapsedChoices()).map(c => c.id)).toEqual([choice.id]);
    expect(edits()).toEqual([{ chatId: GROUP, messageId, text: `${choice.text}\n\n${EXPIRED_LINE}` }]);
    // Auch direkt über die Ablage: der Vorschlag gilt als abgelaufen
    const [id] = Object.keys(pendingOnDisk());
    expect(await decideReview("ok", id, { takePendingReview, processIntents: async () => EMPTY })).toEqual({ kind: "expired" });
    expect(pendingOnDisk()).toEqual({});
  });

  test("genau an der Grenze: Rückfrage und Ablage laufen zusammen ab", async () => {
    const { choice } = await topicProposal();
    const [review] = Object.values(pendingOnDisk()) as any[];
    expect(choice.expiresAt).toBe(review.createdAt + REVIEW_MAX_AGE_MS);
    setSystemTime(new Date(review.createdAt + REVIEW_MAX_AGE_MS));
    expect((await w.browser("topic-9", choice.id, "ok")).status).toBe("expired");
    expect(await takePendingReview(review.id)).toBeUndefined();
    expect(w.applied).toEqual([]);
  });
});

describe("Routine-Angebot", () => {
  const session = { key: `topic:${GROUP}:9:research`, claudeSessionId: "s1", agentName: "research", messageCount: 9 } as BotSession;

  async function offer() {
    const id = await stageRoutineReview({ chatId: GROUP, topicId: 9, description: "Wochenbericht bauen", session });
    return { id, ...(await onlyChoice()) };
  }

  test("„Als Routine speichern“ im Browser: Hinweis, Einfrieren, Bericht in Telegram und als routine_report im Gedächtnis", async () => {
    const { choice } = await offer();
    expect(choice.options.map(o => o.label)).toEqual(["Als Routine speichern", "Verwerfen"]);
    expect((await w.browser("topic-9", choice.id, "routine")).status).toBe("decided");
    // Einfrieren läuft im Hintergrund, der Klick wartet nicht darauf
    expect(w.background).toHaveLength(1);
    await Promise.all(w.background);
    expect(w.routines).toHaveLength(1);
    expect(w.routines[0].hint).toBe("Wochenbericht bauen");
    expect(w.routines[0].session.claudeSessionId).toBe("s1");
    expect(notices()).toEqual([{ chatId: GROUP, topicId: 9, text: routineStartText("Wochenbericht bauen") }]);
    expect(w.plain).toEqual([{ chatId: GROUP, text: "Routine gespeichert: skill wochenbericht", topicId: 9 }]);
    expect(w.saved).toEqual([
      { chat_id: GROUP, role: "assistant", content: "Routine gespeichert: skill wochenbericht", metadata: { type: "routine_report", topicId: 9 } },
    ]);
    expect(w.applied).toEqual([]);
  });

  test("Einfrieren scheitert (Fehlermeldung oder Wurf): Fehlerbericht in beiden Kanälen", async () => {
    for (const result of [{ isError: true, text: "kaputt" }, new Error("weg")]) {
      w.routineResult = result;
      const { choice, messageId } = await offer();
      await w.click(`ch|${choice.id}|routine`, messageId, GROUP);
      await Promise.all(w.background.splice(0));
      expect(w.plain.at(-1)!.text).toBe(REVIEW_TEXT.routineFailed);
      expect(w.saved.at(-1)!.content).toBe(REVIEW_TEXT.routineFailed);
      // Nächste Runde mit leerem Register
      for (const off of cleanup.splice(0)) off();
      w = setup();
    }
  });

  test("Verwerfen: nichts eingefroren", async () => {
    const { choice } = await offer();
    await w.browser("topic-9", choice.id, "no");
    await Promise.all(w.background);
    expect(w.routines).toEqual([]);
    expect(notices()).toEqual([{ chatId: GROUP, topicId: 9, text: REVIEW_TEXT.discarded }]);
  });
});

describe("Teilfehler", () => {
  test("Vorschlag fehlt in der Ablage, Frage entschieden: nichts geschrieben, Meldung „abgelaufen“", async () => {
    const { choice } = await topicProposal();
    const [id] = Object.keys(pendingOnDisk());
    await takePendingReview(id);
    expect((await w.browser("topic-9", choice.id, "ok")).status).toBe("decided");
    expect(w.applied).toEqual([]);
    expect(notices()).toEqual([{ chatId: GROUP, topicId: 9, text: REVIEW_TEXT.expired }]);
  });

  test("Gedächtnis wirft beim Übernehmen: Frage bleibt entschieden (handlerError), kein zweiter Versuch", async () => {
    const { choice } = await topicProposal();
    for (const off of cleanup.splice(0)) off();
    const failing = createReviewResults({
      decideReview: (action, reviewId) =>
        decideReview(action, reviewId, { takePendingReview, processIntents: async () => { throw new Error("Speicher weg"); } }),
      createRoutine: async () => ({}),
      sendAndRecord: async () => ({ sent: true, recorded: true }) as SendAndRecordResult,
      sendTelegram: async () => {},
      saveMessage: async () => {},
      dmChatId: () => USER,
      log: () => {},
    });
    cleanup.push(onChoiceDecided("review", failing.handler));
    const outcome = await decideChoice(choice.id, "ok", "web");
    expect(outcome.status).toBe("decided");
    expect((await getChoice(choice.id))!.handlerError?.message).toBe("Speicher weg");
    expect((await decideChoice(choice.id, "ok", "telegram")).status).toBe("already");
    expect(pendingOnDisk()).toEqual({});
  });
});

describe("Ablage ohne Umweg", () => {
  test("alter Vorschlag ohne Rückfrage, älter als 7 Tage, ohne neues Ablegen dazwischen: abgelaufen, nichts angewendet", async () => {
    await stagePendingReview({ id: "alt", type: "memory", chatId: USER, tags: "[REMEMBER: x]", createdAt: Date.now() - REVIEW_MAX_AGE_MS - 1 });
    expect(await decideReview("ok", "alt", { takePendingReview, processIntents: async t => { w.applied.push(t); return EMPTY; } })).toEqual({ kind: "expired" });
    expect(w.applied).toEqual([]);
    expect(pendingOnDisk()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Checkbox 2: reine Web-Gespräche, Session-Ende, alte rev|-Knöpfe, Sprach-Brücke
// ---------------------------------------------------------------------------

describe("Reines Web-Gespräch", () => {
  async function webProposal() {
    expect(await processTurnIntents("Laut Seite [REMEMBER: w]", WEBFETCH, { chatId: `web:${WEB_ID}`, origin: "Web-Gespräch" }, gate)).toBe("staged");
    return onlyChoice();
  }

  test("Frage im Web-Gespräch (Meldung mit choiceId) und als Kopie im Direktchat, beide an dieselbe Frage gebunden", async () => {
    const { choice, chatId } = await webProposal();
    expect(choice.conversation).toEqual({ type: "web", conversationId: WEB_ID });
    expect(choice.text).toContain("(Web-Gespräch)");
    expect(w.web).toEqual([{ conversationId: WEB_ID, post: { text: choice.text, kind: "notice", source: "review", choiceId: choice.id } }]);
    // Kopie im Direktchat mit Knöpfen, festgehalten mit derselben choiceId
    expect(chatId).toBe(USER);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].chatId).toBeUndefined();
    expect(w.sent[0].choiceId).toBe(choice.id);
    // Browser: Knöpfe im Web-Gespräch, im Direktchat nur der Verweis
    expect((await w.port.view(choice.id, WEB_ID)).options).toHaveLength(2);
    expect(await w.port.view(choice.id, "dm")).toEqual({ id: choice.id, state: "open", options: [], elsewhere: WEB_ID });
    expect(await w.browser("dm", choice.id, "ok")).toEqual({ status: "not_found" });
    expect(w.applied).toEqual([]);
  });

  test("Übernehmen im Web-Gespräch: einmal geschrieben, Direktchat-Kopie „(im Browser)“, Ergebnis im Web-Gespräch und als Kopie", async () => {
    const { choice, messageId } = await webProposal();
    expect((await w.browser(WEB_ID, choice.id, "ok")).status).toBe("decided");
    expect(w.applied).toEqual(["[REMEMBER: w]"]);
    expect(edits()).toEqual([{ chatId: USER, messageId, text: `${choice.text}\n\n✓ Übernehmen (im Browser)` }]);
    expect(w.web.at(-1)).toEqual({ conversationId: WEB_ID, post: { text: "✅ Übernommen: 1 Fakt(en), 0 Ziel(e).", kind: "notice", source: "review" } });
    expect(notices()).toEqual([{ chatId: USER, topicId: undefined, text: "(Web-Gespräch) ✅ Übernommen: 1 Fakt(en), 0 Ziel(e)." }]);
  });

  test("Verwerfen über die Telegram-Kopie: Web-Gespräch bekommt den Stand live", async () => {
    const { choice, messageId } = await webProposal();
    await w.click(`ch|${choice.id}|no`, messageId, USER);
    expect(w.applied).toEqual([]);
    const change = w.changes.find(c => c.choice.id === choice.id)!;
    expect(change).toMatchObject({ conversationId: WEB_ID, copyInDm: true, choice: { state: "done", result: { label: "Verwerfen", via: "telegram" } } });
    expect(w.web.at(-1)!.post.text).toBe(REVIEW_TEXT.discarded);
  });

  test("WebUI nicht erreichbar: nur die Kopie im Direktchat, trotzdem entscheidbar", async () => {
    w.webAvailable = false;
    const { choice, messageId } = await webProposal();
    expect(w.web).toEqual([]);
    await w.click(`ch|${choice.id}|ok`, messageId, USER);
    expect(w.applied).toEqual(["[REMEMBER: w]"]);
  });

  test("Routine-Bericht: im Web-Gespräch als Antwort, routine_report im Gedächtnis des Web-Gesprächs, Kopie im Direktchat", async () => {
    const session = { key: `web:${WEB_ID}:general`, claudeSessionId: "s2", agentName: "general", messageCount: 9 } as BotSession;
    await stageRoutineReview({ chatId: `web:${WEB_ID}`, description: "Ablauf", session });
    const { choice } = await onlyChoice();
    await w.browser(WEB_ID, choice.id, "routine");
    await Promise.all(w.background);
    const report = "Routine gespeichert: skill wochenbericht";
    expect(w.web.map(p => p.post)).toContainEqual({ text: report });
    expect(w.saved).toEqual([{ chat_id: `web:${WEB_ID}`, role: "assistant", content: report, metadata: { type: "routine_report" } }]);
    expect(w.sent.at(-1)).toMatchObject({ chatId: USER, text: `(Web-Gespräch) ${report}`, source: "review" });
    expect(w.plain).toEqual([]);
  });
});

describe("Session-Ende im Web-Gespräch", () => {
  const session = { key: `web:${WEB_ID}:research`, claudeSessionId: "s3", agentName: "research", messageCount: 9 } as BotSession;
  const aux = (text: string) => async () => ({ text, isError: false }) as any;

  test("Schlüssel web:<id>:<agent> ergibt das Web-Gespräch; Telegram-Schlüssel wie bisher", () => {
    expect(parseStorageKey(`web:${WEB_ID}:research`)).toEqual({ chatId: `web:${WEB_ID}` });
    expect(parseStorageKey("web:kaputt:research")).toBeNull();
    expect(parseStorageKey(`topic:${GROUP}:9:research`)).toEqual({ chatId: GROUP, topicId: 9 });
    expect(parseStorageKey(`dm:${USER}:general`)).toEqual({ chatId: USER });
  });

  test("Merk-Vorschlag und Routine-Angebot im Web-Gespräch statt direktem Schreiben", async () => {
    const direct: string[] = [];
    await distillSession(session, { callAux: aux("[REMEMBER: a]\n[ROUTINE: Wochenbericht]"), processIntents: async t => { direct.push(t); return EMPTY; } });
    expect(direct).toEqual([]);
    const list = await listChoices();
    expect(list.map(c => [c.conversation, c.options[0].key])).toEqual([
      [{ type: "web", conversationId: WEB_ID }, "ok"],
      [{ type: "web", conversationId: WEB_ID }, "routine"],
    ]);
    expect(w.web.map(p => p.post.choiceId)).toEqual(list.map(c => c.id));
    expect(Object.values(pendingOnDisk()).map((r: any) => r.chatId)).toEqual([`web:${WEB_ID}`, `web:${WEB_ID}`]);
  });

  test("DISTILL_AUTO_APPLY=true: wie bisher direkt geschrieben, keine Rückfrage", async () => {
    process.env.DISTILL_AUTO_APPLY = "true";
    const direct: string[] = [];
    await distillSession(session, { callAux: aux("[REMEMBER: a]"), processIntents: async t => { direct.push(t); return EMPTY; } });
    expect(direct).toEqual(["[REMEMBER: a]"]);
    expect(await listChoices()).toEqual([]);
    expect(pendingOnDisk()).toEqual({});
  });
});

describe("Alte rev|-Knöpfe", () => {
  test("rev|ok|<id> mit Rückfrage: Register entscheidet zuerst, Einträge einmal, Rückfrage erledigt, ihre Nachricht nachgezogen", async () => {
    const { choice, messageId } = await topicProposal();
    expect(await w.results.legacy("ok", choice.ref!)).toEqual({ text: "✓ Übernehmen (in Telegram)" });
    expect(w.applied).toEqual(["[REMEMBER: x]"]);
    expect((await getChoice(choice.id))!.result).toMatchObject({ key: "ok", via: "telegram" });
    expect(edits()).toEqual([{ chatId: GROUP, messageId, text: `${choice.text}\n\n✓ Übernehmen (in Telegram)` }]);
    expect(notices()).toEqual([{ chatId: GROUP, topicId: 9, text: "✅ Übernommen: 1 Fakt(en), 0 Ziel(e)." }]);
    // Zweiter Klick auf den alten Knopf
    expect(await w.results.legacy("ok", choice.ref!)).toEqual({ text: "Schon erledigt: Übernehmen in Telegram" });
    expect(w.applied).toHaveLength(1);
  });

  test("nach Entscheidung im Browser: „Schon erledigt … im Browser“, nichts doppelt", async () => {
    const { choice } = await topicProposal();
    await w.browser("topic-9", choice.id, "no");
    expect(await w.results.legacy("ok", choice.ref!)).toEqual({ text: "Schon erledigt: Verwerfen im Browser" });
    expect(w.applied).toEqual([]);
  });

  test("gleichzeitig alter Knopf, neuer Knopf und Browser: genau einmal", async () => {
    const { choice, messageId } = await topicProposal();
    await Promise.all([
      w.results.legacy("ok", choice.ref!),
      w.click(`ch|${choice.id}|ok`, messageId, GROUP),
      w.browser("topic-9", choice.id, "ok"),
    ]);
    expect(w.applied).toEqual(["[REMEMBER: x]"]);
    expect(notices()).toHaveLength(1);
  });

  test("abgelaufene Rückfrage: „abgelaufen“, nichts geschrieben", async () => {
    const { choice } = await topicProposal();
    setSystemTime(new Date(Date.now() + REVIEW_MAX_AGE_MS + 1000));
    expect(await w.results.legacy("ok", choice.ref!)).toEqual({ text: REVIEW_TEXT.expired });
    expect(w.applied).toEqual([]);
  });

  test("Vorschlag von vor dem Update (keine Rückfrage): wendet genau einmal an, Ergebnis als Meldung", async () => {
    await stagePendingReview({ id: "vorher", type: "memory", chatId: USER, tags: "[REMEMBER: v]", createdAt: Date.now() });
    expect(await w.results.legacy("ok", "vorher")).toEqual({ text: "✓ Übernehmen (in Telegram)" });
    expect(w.applied).toEqual(["[REMEMBER: v]"]);
    expect(notices()).toEqual([{ chatId: USER, topicId: undefined, text: "✅ Übernommen: 1 Fakt(en), 0 Ziel(e)." }]);
    expect(await w.results.legacy("ok", "vorher")).toEqual({ text: REVIEW_TEXT.expired });
    expect(w.applied).toHaveLength(1);

    await stagePendingReview({ id: "nein", type: "memory", chatId: USER, tags: "[REMEMBER: n]", createdAt: Date.now() });
    expect(await w.results.legacy("no", "nein")).toEqual({ text: "✓ Verwerfen (in Telegram)" });
    expect(w.applied).toHaveLength(1);
  });

  test("Vorschlag von vor dem Update, älter als 7 Tage: abgelaufen, nichts geschrieben", async () => {
    await stagePendingReview({ id: "alt", type: "memory", chatId: USER, tags: "[REMEMBER: v]", createdAt: Date.now() - REVIEW_MAX_AGE_MS - 5 });
    expect(await w.results.legacy("ok", "alt")).toEqual({ text: REVIEW_TEXT.expired });
    expect(w.applied).toEqual([]);
    expect(notices()).toEqual([]);
  });

  test("Routine-Angebot von vor dem Update: einfrieren im Hintergrund, Bericht wie bisher", async () => {
    const session = { key: `dm:${USER}:general`, claudeSessionId: "s4", agentName: "general", messageCount: 9 } as BotSession;
    await stagePendingReview({ id: "rout", type: "routine", chatId: USER, routineDescription: "X", session, createdAt: Date.now() });
    expect(await w.results.legacy("routine", "rout")).toEqual({ text: "✓ Als Routine speichern (in Telegram)" });
    await Promise.all(w.background);
    expect(w.routines.map(r => r.hint)).toEqual(["X"]);
    expect(w.saved[0]).toMatchObject({ chat_id: USER, metadata: { type: "routine_report" } });
  });

  test("Register nicht lesbar: nichts angewendet, Nachricht bleibt für einen zweiten Versuch", async () => {
    const { choice } = await topicProposal();
    writeFileSync(join(base, `choices-${counter}.json`), "{kaputt");
    expect(await w.results.legacy("ok", choice.ref!)).toEqual({ text: null });
    expect(w.applied).toEqual([]);
    expect(Object.keys(pendingOnDisk())).toEqual([choice.ref!]);
  });
});

describe("Sprach-Brücke (eigener Prozess)", () => {
  test("Vorschlag aus dem anderen Prozess: Frage im selben Register, Klick im Bot wendet genau einmal an", async () => {
    const script = join(base, "bruecke.ts");
    const src = join(import.meta.dir, "..", "src", "lib");
    writeFileSync(
      script,
      `import { setChoicesFileForTests } from ${JSON.stringify(join(src, "choices.ts"))};
import { setPendingReviewsFileForTests, setReviewNotifier } from ${JSON.stringify(join(src, "session-distill.ts"))};
import { createReviewNotifier } from ${JSON.stringify(join(src, "review-choices.ts"))};
import { createTelegramChoices } from ${JSON.stringify(join(src, "telegram-choices.ts"))};
import { processTurnIntents } from ${JSON.stringify(join(src, "intent-gate.ts"))};
const [choicesFile, pendingFile, user] = process.argv.slice(2);
setChoicesFileForTests(choicesFile);
setPendingReviewsFileForTests(pendingFile);
const api = { editMessageText: async () => true, editMessageReplyMarkup: async () => true };
// Wie src/voice-bridge.ts: Versand über die Bot-API (hier Attrappe mit message_id 777)
const send = async (input) => ({ sent: true, recorded: true, messages: [{ chatId: input.chatId ?? user, messageId: 777, part: "text", buttons: !!input.buttons }] });
const choices = createTelegramChoices({ api, owner: user, send, log: () => {} });
setReviewNotifier(createReviewNotifier({ sendChoice: (choice) => choices.sendChoice(choice), log: () => {} }));
const outcome = await processTurnIntents("[REMEMBER: aus dem Telefonat]", { uses: [{ name: "WebFetch" }], cwd: "/tmp" }, { chatId: user, origin: "Sprach-Brücke" }, { log: () => {}, projectRoot: "/tmp", dmChatId: () => user });
if (outcome !== "staged") process.exit(3);
`
    );
    const child = Bun.spawn(["bun", script, join(base, `choices-${counter}.json`), pendingFile, USER], { stdout: "ignore", stderr: "pipe" });
    expect(await child.exited).toBe(0);

    const { choice, messageId, chatId } = await onlyChoice();
    expect(choice.conversation).toEqual({ type: "telegram", chatId: USER });
    expect([chatId, messageId]).toEqual([USER, 777]);
    // Browser zeigt die Frage im Direktchat mit Knöpfen
    expect((await w.port.view(choice.id, "dm")).options).toHaveLength(2);
    // Klick im Bot-Prozess: Vorschlag aus der Datei des anderen Prozesses
    await w.click(`ch|${choice.id}|ok`, 777, USER);
    expect(w.applied).toEqual(["[REMEMBER: aus dem Telefonat]"]);
    expect(edits()).toEqual([{ chatId: USER, messageId: 777, text: `${choice.text}\n\n✓ Übernehmen (in Telegram)` }]);
    expect((await w.browser("dm", choice.id, "ok")).status).toBe("already");
    expect(w.applied).toHaveLength(1);
  });
});

describe("Verdrahtung in src/bot.ts", async () => {
  const bot = await Bun.file(join(import.meta.dir, "..", "src", "bot.ts")).text();

  test("Handler der Art review über decideReview, Ergebnis über sendAndRecord, Routine wie bisher", () => {
    expect(bot).toContain('onChoiceDecided("review", reviewResults.handler);');
    expect(bot).toContain("createRoutine: (session, hint) => createRoutineFromSession(session, hint),");
    expect(bot).toContain("sendTelegram: (chatId, text, topicId) => sendDirectMessage(chatId, text, topicId),");
    expect(bot).toContain("saveMessage: (message) => saveMessage(message),");
    // Die Routine-Ausführung steht nicht mehr im Callback-Handler
    expect(bot).not.toContain("createRoutineFromSession(\n        decision.session");
  });

  test("alte rev|-Knöpfe über reviewResults.legacy, Ergebnis ersetzt nur die geklickte Nachricht", () => {
    expect(bot).toContain('if (data.startsWith("rev|")) {');
    expect(bot).toContain("const { text } = await reviewResults.legacy(action, reviewId);");
    expect(bot).toContain("if (text) await ctx.editMessageText(text).catch(() => {});");
  });
});
