/**
 * Issue #259, Prüfung zu PR #274: Ein Denkauftrag aus dem Telefonhörer
 * (noTelegram) erreicht Telegram auch über die Nebenwege nicht. Echte Wege:
 * Freigabe-Handler (createChoiceToolApproval mit createApprovalTurns),
 * Rückfragen-Register, Merk-Tor (processTurnIntents), Ablage der Vorschläge
 * und ihre Zustellung (createReviewNotifier, createReviewResults). Attrappen
 * nur am Rand: das Modell, die Outbox (sendAndRecord) und der Web-Server.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { decideChoice, getChoice, setChoicesFileForTests } from "../src/lib/choices";
import { decideReview, processTurnIntents } from "../src/lib/intent-gate";
import type { SendAndRecordInput } from "../src/lib/outbox";
import type { Message } from "../src/lib/store/types";
import { createReviewNotifier, createReviewResults, REVIEW_APPLY, REVIEW_DISCARD, REVIEW_TEXT, type WebPost } from "../src/lib/review-choices";
import { setPendingReviewsFileForTests, setReviewNotifier, takePendingReview } from "../src/lib/session-distill";
import { createTelegramChoices } from "../src/lib/telegram-choices";
import { createChoiceToolApproval, TOOL_ALLOW, TOOL_APPROVAL_TIMEOUT_MS, type ChoiceToolApproval } from "../src/lib/tool-approval";
import { callBuiltinTool, registerBuiltinTool, setToolApprovalHandler } from "../src/lib/tools/registry";
import { onChoiceDecided } from "../src/lib/choices";
import type { TurnOptions } from "../src/lib/chat-turn";
import { createApprovalTurns, createTelegramChat, createTelegramNoticeRecorder, type TelegramChatDeps, type WebSavedMessage } from "../src/web/bot-turn";
import { createTelegramSource } from "../src/web/bot-telegram";
import type { FollowUpOutput } from "../src/web/chat";
import { parseTelegramConversationId } from "../src/web/telegram";

const OWNER = "4242";
const GROUP = "-100123";
const TOOL = "test_issue259_schreiben";
const WEBFETCH = { uses: [{ name: "WebFetch" }] };

const base = mkdtempSync(join(tmpdir(), "tybo-call-no-telegram-"));
let counter = 0;
let executions = 0;
registerBuiltinTool({
  name: TOOL,
  description: "Schreibt etwas (Test Issue 259)",
  inputSchema: { type: "object", properties: {} },
  requiresApproval: true,
  isAvailable: () => true,
  handler: async () => {
    executions++;
    return "geschrieben";
  },
});

/** Zeile im Nachrichtenspeicher (Attrappe von Supabase) */
type Row = Required<Pick<Message, "chat_id" | "role" | "content" | "created_at">> & { id: number; metadata: Record<string, unknown> };

interface World {
  /** Nachrichtenspeicher: was dauerhaft im Verlauf steht */
  db: Row[];
  /** Alles, was über die Outbox nach Telegram ginge */
  sends: SendAndRecordInput[];
  telegramPlain: unknown[];
  telegramAgent: unknown[];
  telegramDirect: unknown[];
  posted: Array<{ conversationId: string; post: WebPost }>;
  applied: string[];
  asked: Array<{ choiceId: string; record?: boolean }>;
  scheduled: number[];
  /** Antwort des Hauptturns mit [INVOKE:critic|…] */
  invoke?: boolean;
  approval: ChoiceToolApproval;
  off: () => void;
  deps: TelegramChatDeps;
}

let world: World;
const t0 = Date.now();

beforeEach(() => {
  counter++;
  setChoicesFileForTests(join(base, `choices-${counter}.json`));
  setPendingReviewsFileForTests(join(base, `reviews-${counter}.json`));
  executions = 0;
  const w = { db: [], sends: [], telegramPlain: [], telegramAgent: [], telegramDirect: [], posted: [], applied: [], asked: [], scheduled: [] } as unknown as World;
  let messageId = 100;
  // Wie saveDisplayOnlyMessage: Zeile mit msgId, sonst nichts (kein Browser verbunden)
  const recordNotice = async (m: WebSavedMessage) => {
    w.db.push({ id: w.db.length + 1, chat_id: m.chat_id, role: m.role, content: m.content, metadata: { ...m.metadata, msgId: crypto.randomUUID() }, created_at: new Date(Date.now() + w.db.length).toISOString() });
    return true;
  };
  // Wie postReviewToWeb in bot.ts: Telegram-Gespräche über den Nachrichtenspeicher, reine Web-Gespräche angenommen
  const recordTelegramNotice = createTelegramNoticeRecorder({ userId: OWNER, groupId: () => GROUP, agentForTopic: () => "research", recordNotice, log: () => {} });
  const send = async (input: SendAndRecordInput) => {
    w.sends.push(input);
    return { sent: true, recorded: true, messages: [{ chatId: input.chatId ?? OWNER, messageId: ++messageId, part: "text" as const, buttons: !!input.buttons }] };
  };
  const telegramChoices = createTelegramChoices({ owner: OWNER, send, log: () => {} });
  const postWeb = async (conversationId: string, post: WebPost) => {
    w.posted.push({ conversationId, post });
    if (!parseTelegramConversationId(conversationId)) return true;
    return recordTelegramNotice(conversationId, { text: post.text, ...(post.source ? { source: post.source } : {}), ...(post.choiceId ? { choiceId: post.choiceId } : {}) });
  };
  setReviewNotifier(createReviewNotifier({ sendChoice: c => telegramChoices.sendChoice(c), postWeb, log: () => {} }));
  const results = createReviewResults({
    decideReview: (action, reviewId) =>
      decideReview(action, reviewId, {
        takePendingReview,
        processIntents: async text => {
          w.applied.push(text);
          return { goalsAdded: [], goalsCompleted: [], goalsCancelled: [], factsAdded: ["von einer Webseite"], factsRemoved: [] };
        },
      }),
    createRoutine: async () => ({ text: "" }),
    sendAndRecord: send,
    sendTelegram: async (...a) => void w.telegramDirect.push(a),
    saveMessage: async () => true,
    postWeb,
    dmChatId: () => OWNER,
    log: () => {},
  });
  w.off = onChoiceDecided("review", results.handler);
  const approvalTurns = createApprovalTurns();
  w.approval = createChoiceToolApproval({
    sendChoice: c => telegramChoices.sendChoice(c),
    presenter: key => approvalTurns.presenter(key),
    now: () => t0,
    schedule: (_fn, ms) => {
      w.scheduled.push(ms);
      return () => {};
    },
    log: () => {},
  });
  setToolApprovalHandler(w.approval.handler);
  w.deps = {
    approvals: approvalTurns,
    runStreamingTurn: async (o: TurnOptions) => {
      // Befragter Agent im Folgeauftrag: ebenfalls ein Werkzeug mit Freigabepflicht
      if (o.agentName === "critic") {
        const result = await callBuiltinTool(TOOL, {});
        return `Gegenprüfung (${result.isError ? "abgelehnt" : "erledigt"}).`;
      }
      // Werkzeug mit Freigabepflicht, danach eine Antwort mit Merk-Tag nach einem Web-Abruf
      const result = await callBuiltinTool(TOOL, {});
      o.onTools?.(WEBFETCH);
      return `Ausgearbeitet (${result.isError ? "abgelehnt" : "erledigt"}). [REMEMBER: von einer Webseite]${w.invoke ? " [INVOKE:critic|Stimmt das?]" : ""}`;
    },
    recordNotice,
    saveMessage: async () => true,
    processIntents: (text, turn) =>
      processTurnIntents(text, turn.tools, turn, {
        processIntents: async t => void w.applied.push(t),
        log: () => {},
        projectRoot: process.cwd(),
        dmChatId: () => OWNER,
      }),
    abortEngineCalls: () => 0,
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    log: () => {},
    userId: OWNER,
    groupId: () => GROUP,
    agentForTopic: () => "research",
    sendPlain: async (...a: unknown[]) => void w.telegramPlain.push(a),
    sendAsAgent: async (...a: unknown[]) => void w.telegramAgent.push(a),
    sendTypingAsAgent: async (...a: unknown[]) => void w.telegramAgent.push(a),
    invokeBudget: 3,
  } as TelegramChatDeps;
  world = w;
});

afterEach(() => {
  world.approval.dispose();
  world.off();
  setToolApprovalHandler(null);
  setReviewNotifier(null);
});

afterAll(() => {
  setChoicesFileForTests(null);
  setPendingReviewsFileForTests(null);
  rmSync(base, { recursive: true, force: true });
});

async function waitFor(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`Zeit abgelaufen: ${what}`);
    await Bun.sleep(5);
  }
}

const sink = { progress() {}, notice() {} };

function run(conversationId: string, noTelegram: boolean) {
  const chat = createTelegramChat(world.deps);
  return chat.runTurn({
    conversationId,
    agent: "research",
    text: "Denkauftrag aus dem Telefongespräch: Vergleiche drei Wärmepumpen",
    sink,
    ...(noTelegram ? { noTelegram: true } : {}),
    ask: async (_question, choiceId, options) => void world.asked.push({ choiceId, record: options?.record }),
    endAsk: () => {},
  });
}

describe("Denkauftrag ohne Telegram: Freigabe und Merk-Vorschlag", () => {
  for (const [conversationId, chatId] of [
    ["topic-9", GROUP],
    ["dm", OWNER],
  ] as const) {
    test(`${conversationId}: Freigabe nur im Browser mit derselben Pflicht und Frist, Vorschlag und Ergebnis nur in der WebUI`, async () => {
      const turn = run(conversationId, true);
      await waitFor(() => world.asked.length === 1, "Freigabe-Frage");
      // Frage dauerhaft im Verlauf (Nur-Anzeige-Eintrag mit choiceId), im Browser nur der Wartezustand; nichts an Telegram
      expect(world.asked[0]!.record).toBe(false);
      expect(world.db).toHaveLength(1);
      expect(world.db[0]).toMatchObject({ chat_id: chatId, role: "assistant", metadata: { display_only: true, source: "freigabe", choiceId: world.asked[0]!.choiceId } });
      expect(world.db[0]!.metadata.topicId).toBe(conversationId === "dm" ? undefined : 9);
      const choice = (await getChoice(world.asked[0]!.choiceId))!;
      expect(choice).toMatchObject({ kind: "tool", state: "open", expiresAt: t0 + TOOL_APPROVAL_TIMEOUT_MS });
      expect(choice.conversation).toEqual(conversationId === "dm" ? { type: "telegram", chatId } : { type: "telegram", chatId, topicId: 9 });
      expect(world.scheduled).toEqual([TOOL_APPROVAL_TIMEOUT_MS]);
      await Bun.sleep(20);
      expect(world.sends).toEqual([]);
      // Ohne Entscheidung läuft nichts
      expect(executions).toBe(0);
      expect((await decideChoice(choice.id, TOOL_ALLOW, "web")).status).toBe("decided");
      const result = await turn;
      expect(result.text).toContain("erledigt");
      expect(executions).toBe(1);

      // Merk-Tag nach Web-Abruf: Vorschlag, nicht angewendet, nur ins WebUI-Gespräch
      await waitFor(() => world.posted.length === 1, "Vorschlag in der WebUI");
      expect(world.applied).toEqual([]);
      expect(world.posted[0]!.conversationId).toBe(conversationId);
      expect(world.posted[0]!.post.text).toContain("von einer Webseite");
      const reviewId = world.posted[0]!.post.choiceId!;
      expect((await getChoice(reviewId))!.kind).toBe("review");
      expect((await decideChoice(reviewId, REVIEW_APPLY, "web")).status).toBe("decided");
      await waitFor(() => world.posted.length === 2, "Ergebnis in der WebUI");
      expect(world.applied).toEqual(["[REMEMBER: von einer Webseite]"]);
      expect(world.posted[1]).toMatchObject({ conversationId, post: { kind: "notice" } });
      expect(world.posted[1]!.post.text).toContain("Übernommen");

      expect(world.sends).toEqual([]);
      expect(world.telegramPlain).toEqual([]);
      expect(world.telegramAgent).toEqual([]);
      expect(world.telegramDirect).toEqual([]);
    });

    test(`${conversationId}: ohne noTelegram gehen Freigabe und Vorschlag wie bisher nach Telegram (Gegenprobe)`, async () => {
      const turn = run(conversationId, false);
      await waitFor(() => world.asked.length === 1 && world.sends.length === 1, "Freigabe in Telegram");
      expect(world.asked[0]!.record).toBe(false);
      expect(world.sends[0]).toMatchObject({ chatId, choiceId: world.asked[0]!.choiceId });
      await decideChoice(world.asked[0]!.choiceId, TOOL_ALLOW, "telegram");
      await turn;
      await waitFor(() => world.sends.length === 2, "Vorschlag in Telegram");
      expect(world.sends[1]!.text).toContain("von einer Webseite");
      expect(world.posted).toEqual([]);
    });
  }
});

/** Verlauf wie beim Laden im Browser: Quelle der Telegram-Gespräche über den Nachrichtenspeicher */
function loadHistory(conversationId: string) {
  const source = createTelegramSource({
    userId: OWNER,
    groupId: () => GROUP,
    topicNames: async () => ({ "9": "Recherche" }),
    topicMapping: () => ({ "9": "research" }),
    history: async (chatId, topicId) => world.db.filter(r => r.chat_id === chatId && ((r.metadata.topicId as number | undefined) ?? null) === topicId),
    activity: async () => [],
    log: () => {},
  });
  return source.history(conversationId);
}

function expectNoTelegram(): void {
  expect(world.sends).toEqual([]);
  expect(world.telegramPlain).toEqual([]);
  expect(world.telegramAgent).toEqual([]);
  expect(world.telegramDirect).toEqual([]);
}

describe("Denkauftrag ohne Telegram: [INVOKE:]-Folgeauftrag mit Werkzeug-Freigabe", () => {
  for (const [conversationId, chatId] of [
    ["topic-9", GROUP],
    ["dm", OWNER],
  ] as const) {
    test(`${conversationId}: Freigabe des befragten Agenten nur in der WebUI, dauerhaft im Verlauf, mit Pflicht und Frist`, async () => {
      world.invoke = true;
      const turn = run(conversationId, true);
      await waitFor(() => world.asked.length === 1, "Freigabe im Hauptturn");
      await decideChoice(world.asked[0]!.choiceId, TOOL_ALLOW, "web");
      const result = await turn;
      expect(result.followUp).toBeDefined();

      // Die Anmeldung des Hauptturns ist aufgehoben; der Folgeauftrag zeigt seine Freigabe selbst
      const answers: string[] = [];
      const followAsked: Array<{ choiceId: string; record?: boolean }> = [];
      const output: FollowUpOutput = {
        signal: new AbortController().signal,
        answer: async text => void answers.push(text),
        notice: async () => {},
        ask: async (_question, choiceId, options) => void followAsked.push({ choiceId, record: options?.record }),
        endAsk: () => {},
      };
      const follow = result.followUp!(output);
      await waitFor(() => followAsked.length === 1, "Freigabe im Folgeauftrag");
      expect(followAsked[0]!.record).toBe(false);
      const choice = (await getChoice(followAsked[0]!.choiceId))!;
      expect(choice).toMatchObject({ kind: "tool", state: "open", expiresAt: t0 + TOOL_APPROVAL_TIMEOUT_MS });
      expect(world.scheduled).toEqual([TOOL_APPROVAL_TIMEOUT_MS, TOOL_APPROVAL_TIMEOUT_MS]);
      const row = world.db.find(r => r.metadata.choiceId === choice.id);
      expect(row).toMatchObject({ chat_id: chatId, metadata: { display_only: true, source: "freigabe" } });
      await Bun.sleep(20);
      // Ohne Entscheidung läuft das Werkzeug des befragten Agenten nicht
      expect(executions).toBe(1);
      expectNoTelegram();

      expect((await decideChoice(choice.id, TOOL_ALLOW, "web")).status).toBe("decided");
      await follow;
      expect(executions).toBe(2);
      expect(answers).toEqual(["Gegenprüfung (erledigt)."]);
      expectNoTelegram();
    });

    test(`${conversationId}: Folgeauftrag ohne Wartezustand im Browser legt die Freigabe trotzdem nur in den Verlauf`, async () => {
      world.invoke = true;
      const turn = run(conversationId, true);
      await waitFor(() => world.asked.length === 1, "Freigabe im Hauptturn");
      await decideChoice(world.asked[0]!.choiceId, TOOL_ALLOW, "web");
      const result = await turn;
      const follow = result.followUp!({ signal: new AbortController().signal, answer: async () => {}, notice: async () => {} });
      await waitFor(() => world.db.filter(r => r.metadata.source === "freigabe").length === 2, "Freigabe im Verlauf");
      const id = world.db.filter(r => r.metadata.source === "freigabe")[1]!.metadata.choiceId as string;
      expect((await getChoice(id))!.state).toBe("open");
      await decideChoice(id, TOOL_ALLOW, "web");
      await follow;
      expect(executions).toBe(2);
      expectNoTelegram();
    });
  }
});

describe("Denkauftrag ohne Telegram: Freigabe, Vorschlag und Ergebnis ohne offenen Browser im Verlauf", () => {
  for (const conversationId of ["topic-9", "dm"] as const) {
    test(`${conversationId}: nach dem Laden mit Knöpfen (choiceId) und Ergebnis da`, async () => {
      const turn = run(conversationId, true);
      await waitFor(() => world.asked.length === 1, "Freigabe");
      const approvalId = world.asked[0]!.choiceId;
      // Kein Browser: nur der Nachrichtenspeicher; der Verlauf trägt die offene Frage
      let history = (await loadHistory(conversationId))!;
      expect(history.messages).toHaveLength(1);
      expect(history.messages[0]).toMatchObject({ role: "assistant", kind: "notice", source: "freigabe", choiceId: approvalId });
      expect(history.messages[0]!.text).toContain(TOOL);

      await decideChoice(approvalId, TOOL_ALLOW, "web");
      await turn;
      await waitFor(() => world.posted.length === 1, "Merk-Vorschlag");
      const reviewId = world.posted[0]!.post.choiceId!;
      history = (await loadHistory(conversationId))!;
      expect(history.messages.map(m => [m.kind, m.source, m.choiceId])).toEqual([
        ["notice", "freigabe", approvalId],
        ["notice", "review", reviewId],
      ]);
      expect(history.messages[1]!.text).toContain("von einer Webseite");

      expect((await decideChoice(reviewId, REVIEW_DISCARD, "web")).status).toBe("decided");
      await waitFor(() => world.posted.length === 2, "Ergebnis");
      history = (await loadHistory(conversationId))!;
      expect(history.messages).toHaveLength(3);
      expect(history.messages[2]).toMatchObject({ kind: "notice", source: "review", text: REVIEW_TEXT.discarded });
      expect(history.messages[2]!.choiceId).toBeUndefined();
      expectNoTelegram();
    });
  }
});

describe("Merk-Vorschlag ohne Telegram: Kanal bleibt, auch wenn der Vorschlag fehlt", () => {
  const webId = crypto.randomUUID();
  for (const [label, target, conversationId] of [
    ["Topic", { chatId: GROUP, topicId: 9 }, "topic-9"],
    ["Direktchat", { chatId: OWNER }, "dm"],
    ["reines Web-Gespräch", { chatId: `web:${webId}` }, webId],
  ] as const) {
    test(`${label}: abgelaufener Vorschlag meldet sich nur im WebUI-Gespräch`, async () => {
      await processTurnIntents("[REMEMBER: von einer Webseite]", WEBFETCH, { ...target, origin: "WebUI", noTelegram: { conversationId } }, {
        processIntents: async t => void world.applied.push(t),
        log: () => {},
        projectRoot: process.cwd(),
        dmChatId: () => OWNER,
      });
      await waitFor(() => world.posted.length === 1, "Vorschlag");
      const choice = (await getChoice(world.posted[0]!.post.choiceId!))!;
      expect(choice.noTelegram).toEqual({ conversationId });
      // Vorschlag weg (abgelaufen oder schon entnommen): decideReview liefert expired
      expect(await takePendingReview(choice.ref!)).toBeDefined();
      expect((await decideChoice(choice.id, REVIEW_APPLY, "web")).status).toBe("decided");
      await waitFor(() => world.posted.length === 2, "Ablauf-Meldung");
      expect(world.posted[1]).toEqual({ conversationId, post: { text: REVIEW_TEXT.expired, kind: "notice", source: "review" } });
      expect(world.applied).toEqual([]);
      if (conversationId !== webId) {
        const history = (await loadHistory(conversationId))!;
        expect(history.messages.at(-1)).toMatchObject({ kind: "notice", source: "review", text: REVIEW_TEXT.expired });
      }
      await Bun.sleep(20);
      expectNoTelegram();
    });
  }
});
