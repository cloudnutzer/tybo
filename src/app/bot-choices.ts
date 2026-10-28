/**
 * Rückfragen des laufenden Bots (Issue #344): jede Art des
 * Rückfragen-Registers (Entscheidung 0017) bekommt hier ihren Handler und
 * ihre Zustellwege. Eine Entscheidung aus Telegram, Browser oder Terminal
 * wirkt genau einmal; die Antwort kommt ins Gespräch der Frage.
 *
 * Ohne Telegram (Issue #227) hält das Register die Fragen nur für die WebUI
 * fest. Meldungen zu Telegram-Gesprächen aus einem Denkauftrag ohne Telegram
 * (Issue #259) landen als display_only im Nachrichtenspeicher, damit der
 * Browser sie live und nach dem Neuladen sieht.
 */
import { getAgentByTopicId, getUserProfile } from "../agents";
import { ASK_SOURCE, createAskChoices, createAskDeliver, createAskOffer, installAskOffer } from "../lib/ask-choices";
import type { BotNotices } from "../lib/bot-notices";
import { onChoiceDecided } from "../lib/choices";
import { dmChatId, isWebChatId, outboxDelivered, telegramConfigured } from "../lib/channels";
import { abortEngineCalls } from "../lib/engines";
import { getGoal, onGoalChange } from "../lib/goal-engine";
import { createGoalChoices } from "../lib/goal-choices";
import { decideReview } from "../lib/intent-gate";
import { setMemoryAsker } from "../lib/memory";
import { createMemoryAsker, createMemoryChoices } from "../lib/memory/choices";
import { sendAndRecord } from "../lib/outbox";
import { createPhone, phoneAccess, proactiveCall, type PhoneBotDeps } from "../lib/phone";
import { createProactiveChoices } from "../lib/proactive/choices";
import { proactiveStatePath } from "../lib/proactive/state";
import { profileDisplayName } from "../lib/profile-name";
import { createReminderChoices, REMINDER_SOURCE } from "../lib/reminder-choices";
import { createReviewNotifier, createReviewResults, WEB_COPY_PREFIX, type PostWeb } from "../lib/review-choices";
import { createRoutineChoices, ROUTINE_SOURCE } from "../lib/routine-choices";
import { defaultRoutinesDeps } from "../lib/routines/catalog";
import { getScheduleStore } from "../lib/schedule/store";
import { createRoutineFromSession } from "../lib/session-routine";
import { setReviewNotifier } from "../lib/session-distill";
import { storeOr } from "../lib/store";
import { applyThreadButton } from "../lib/threads/store";
import { createTaskReminders } from "../lib/task-reminders";
import { directChatIds } from "../lib/task-place";
import type { TelegramRuntime } from "../lib/telegram-runtime";
import { refreshChoiceMessages } from "../lib/telegram-choices";
import { createThreadChoices, installThreadChoiceExpiry, threadTarget, THREAD_SOURCE } from "../lib/thread-choices";
import { createChoiceToolApproval, expireOrphanedToolChoices } from "../lib/tool-approval";
import { setPhoneCallService } from "../lib/tools/phone-call";
import { setToolApprovalHandler } from "../lib/tools/registry";
import { createTopicChoices } from "../lib/topic-choices";
import { onTopicMappingSet } from "../lib/topic-setup";
import { botGroupId } from "../web/bot-telegram";
import { createApprovalTurns, createTelegramNoticeRecorder } from "../web/bot-turn";
import type { WebServer } from "../web/server";
import { topicChanges } from "../web/topic-changes";
import { parseTelegramConversationId } from "../web/telegram";
import type { Message } from "../lib/store/types";
import type { CommandServices } from "../lib/commands/types";

type Env = Record<string, string | undefined>;

export interface BotChoicesDeps {
  root: string;
  env: Env;
  runtime: TelegramRuntime;
  /** WebUI, sobald sie läuft */
  web(): WebServer | null;
  notices: BotNotices;
  /** Auftrag aus einem Anruf (Issue #366): Turn wie eine Telegram-Nachricht */
  phoneTask: PhoneBotDeps["task"];
  /** Befehls-Dienste; bekommen hier den Anruf-Zugang (Issue #367) */
  services: CommandServices;
  /** Nur für Tests: prozessweite Anmeldungen ersetzen (Standard CHOICE_INSTALLERS) */
  installers?: Partial<ChoiceInstallers>;
  /** Nur für Tests: Bausteine mit Ablage oder Versand ersetzen (Standard die echten) */
  parts?: Partial<ChoiceParts>;
}

interface ChoiceParts {
  decideReview: typeof decideReview;
  createRoutine: typeof createRoutineFromSession;
  sendAndRecord: typeof sendAndRecord;
  saveMessage(message: Message): Promise<boolean>;
  applyThreadButton: typeof applyThreadButton;
}

/** Prozessweite Anmeldungen der Rückfragen; Tests ersetzen sie, damit nichts im Prozess hängen bleibt */
export const CHOICE_INSTALLERS = {
  onChoiceDecided,
  onGoalChange,
  onTopicMappingSet,
  installThreadChoiceExpiry,
  setPhoneCallService,
  setToolApprovalHandler,
  expireOrphanedToolChoices,
  setReviewNotifier,
  setMemoryAsker,
  installAskOffer,
  /** Offene Anrufe nach einem Neustart weiter abholen */
  resumeCalls: (phone: { resume(): void }) => phone.resume(),
};
export type ChoiceInstallers = typeof CHOICE_INSTALLERS;

export interface ChoicePostWebDeps {
  web(): Pick<WebServer, "postToConversation" | "postLive"> | null;
  /** Telegram-Gespräch: Meldung dauerhaft als display_only; false, wenn das nicht ging */
  recordNotice(conversationId: string, post: { text: string; source?: string; choiceId?: string }): Promise<boolean>;
}

/**
 * Meldung in ein Gespräch der WebUI. Web-Gespräche über die WebUI (abgelegt),
 * Telegram-Gespräche zuerst dauerhaft im Nachrichtenspeicher, sonst nur live.
 */
export function createChoicePostWeb(deps: ChoicePostWebDeps): PostWeb {
  return async (conversationId, post) => {
    const web = deps.web();
    if (!parseTelegramConversationId(conversationId)) return web ? web.postToConversation(conversationId, post) : false;
    const kept = await deps.recordNotice(conversationId, {
      text: post.text,
      ...(post.source ? { source: post.source } : {}),
      ...(post.choiceId ? { choiceId: post.choiceId } : {}),
    });
    return kept || (web ? web.postLive(conversationId, post) : false);
  };
}

const saveMessage = (message: Message) => storeOr(false, store => store.messages.save(message));

const CHOICE_PARTS: ChoiceParts = { decideReview, createRoutine: createRoutineFromSession, sendAndRecord, saveMessage, applyThreadButton };

export function wireBotChoices(deps: BotChoicesDeps) {
  const { env, runtime } = deps;
  const choices = runtime.choices;
  const sendChoice: typeof choices.sendChoice = choice => choices.sendChoice(choice);
  const owner = env.TELEGRAM_USER_ID;
  // Kopie im Direktchat nur mit Telegram; ohne zeigt das Web-Gespräch selbst (und Push)
  const copyChat = () => (telegramConfigured(env) ? owner || undefined : undefined);
  const conversationOf = { userId: dmChatId(env), groupId: () => botGroupId(env), agentForTopic: getAgentByTopicId };
  const refresh = (choice: Parameters<typeof refreshChoiceMessages>[0], refs?: Parameters<typeof refreshChoiceMessages>[3]) =>
    runtime.bot ? refreshChoiceMessages(choice, runtime.bot.api, undefined, refs) : Promise.resolve([]);

  const install = { ...CHOICE_INSTALLERS, ...deps.installers };
  const { decideReview, createRoutine, sendAndRecord, saveMessage, applyThreadButton } = { ...CHOICE_PARTS, ...deps.parts };
  /** Wirft, wenn die Outbox die Meldung nicht zugestellt hat */
  const deliverOrThrow = async (input: Parameters<typeof sendAndRecord>[0]): Promise<void> => {
    const result = await sendAndRecord(input);
    if (!outboxDelivered(result)) throw new Error(result.error?.message ?? "nicht zugestellt");
  };
  const onChoiceDecided = install.onChoiceDecided;
  const recordNotice = createTelegramNoticeRecorder({
    ...conversationOf,
    recordNotice: message => storeOr(false, store => store.messages.saveDisplayOnly(message)),
  });
  const postWeb = createChoicePostWeb({ web: deps.web, recordNotice });

  // Merk-Vorschläge und Routine-Angebote (Issue #117)
  const reviewResults = createReviewResults({
    decideReview,
    createRoutine: (session, hint, epoch) => createRoutine(session, hint, {}, epoch),
    sendAndRecord: input => sendAndRecord(input),
    // Web-Direktchat ohne Telegram (Issue #227): der Bericht kommt über saveMessage in den Verlauf
    sendTelegram: (chatId, text, topicId) => (isWebChatId(chatId) ? Promise.resolve() : runtime.sendMessage(chatId, text, topicId)),
    saveMessage,
    postWeb,
    dmChatId: copyChat,
  });
  onChoiceDecided("review", reviewResults.handler);

  // /goal „Weiter?" (Issue #118): wirkt nur auf das Ziel der Frage
  const goalChoices = createGoalChoices({ getGoal, abort: abortEngineCalls, sendChoice });
  onChoiceDecided("goal", goalChoices.handler);
  install.onGoalChange(goalChoices.listener);

  // „Welcher Agent?" (Issue #119): schreibt nur, solange das Topic keinen Agenten hat
  const topicChoices = createTopicChoices({ sendChoice, notify: input => sendAndRecord(input), topicChanged: change => topicChanges.emit(change) });
  onChoiceDecided("topicmap", topicChoices.handler);
  install.onTopicMappingSet(topicChoices.listener);

  // Routinen bedienen (Issue #288); gehandelt wird nur hier im Bot
  const routineChoices = createRoutineChoices({
    routines: defaultRoutinesDeps(deps.root, env),
    sendChoice,
    postWeb,
    notify: async (conversation, text) => {
      const base = { text, source: ROUTINE_SOURCE, format: "plain" as const };
      if (conversation.type === "telegram") {
        await sendAndRecord({ ...base, chatId: conversation.chatId, ...(conversation.topicId !== undefined ? { topicId: conversation.topicId } : {}) });
        return;
      }
      await postWeb(conversation.conversationId, { text, kind: "notice", source: ROUTINE_SOURCE });
      const copy = copyChat();
      if (copy) await sendAndRecord({ ...base, chatId: copy, text: `${WEB_COPY_PREFIX}${text}` });
    },
  });
  onChoiceDecided("routine", routineChoices.handler);

  // Offene Fäden (Issue #292): Antwort im Gespräch der Rückfrage, nie als Kopie
  const threadChoices = createThreadChoices({
    apply: applyThreadButton,
    notify: (conversation, text) => deliverOrThrow({ ...threadTarget(conversation), text, source: THREAD_SOURCE, format: "plain" }),
  });
  onChoiceDecided("thread", threadChoices.handler);
  install.installThreadChoiceExpiry();

  // Anrufe (Issue #366): offene Anrufe holt der Bot nach einem Neustart weiter ab
  const phone = createPhone({ send: input => sendAndRecord(input), sendChoice, task: deps.phoneTask });
  onChoiceDecided("call", phone.handler);
  install.resumeCalls(phone);
  // /anruf und Werkzeug phone_call (Issue #367): dieselbe Instanz, Name aus dem Profil
  deps.services.phone = phoneAccess(phone, { userName: async () => profileDisplayName(await getUserProfile()) });
  install.setPhoneCallService(deps.services.phone);

  // Knöpfe unter proaktiven Meldungen (Issue #362)
  const proactiveChoices = createProactiveChoices({
    statePath: proactiveStatePath(),
    call: proactiveCall(phone),
    notify: (conversation, text, kind) => deliverOrThrow({ ...threadTarget(conversation), text, source: kind, format: "plain" }),
  });
  onChoiceDecided("proactive", proactiveChoices.handler);

  // Knöpfe an Erinnerungen (Issue #322)
  const reminderChoices = createReminderChoices({
    store: () => getScheduleStore(),
    now: () => Date.now(),
    postWeb,
    notify: async (conversation, text) => {
      const sent = await deps.notices.notifyUser(text, { ...threadTarget(conversation), source: REMINDER_SOURCE, format: "plain" });
      if (!sent) throw new Error("nicht zugestellt");
    },
  });
  onChoiceDecided("reminder", reminderChoices.handler);

  // Mehrdeutige DONE/CANCEL/FORGET (Issue #316)
  const memoryChoices = createMemoryChoices({ sendAndRecord: input => sendAndRecord(input), postWeb, dmChatId: copyChat });
  onChoiceDecided("memory", memoryChoices.handler);

  // Rückfragen des Modells (Issue #335): Fortsetzen über Session, Motor und Modell der Frage
  const askChoices = createAskChoices({
    notify: (conversation, text) => deliverOrThrow({ ...threadTarget(conversation), text, source: ASK_SOURCE, format: "plain" }),
    deliver: createAskDeliver({
      postWeb: (conversationId, post) => postWeb(conversationId, post),
      sendTelegram: (chatId, text, threadId) => runtime.sendMessageChecked(chatId, text, threadId),
    }),
    saveMessage,
  });
  onChoiceDecided("ask", askChoices.handler);

  // Erinnerungen an wartende Aufträge (Issue #337)
  const taskReminders = createTaskReminders({
    ...deps.notices.taskReminders({ refresh, postWeb }),
    directChatIds: () => directChatIds(env),
  });

  // Werkzeug-Freigaben (Issue #116): Telegram per sendChoice, Browser und Terminal über den laufenden Turn
  const approvalTurns = createApprovalTurns();
  const toolApproval = createChoiceToolApproval({ sendChoice, presenter: key => approvalTurns.presenter(key) });
  install.setToolApprovalHandler(toolApproval.handler);
  void install.expireOrphanedToolChoices()
    .then(n => { if (n) console.log(`[freigabe] ${n} offene Freigaben aus dem letzten Lauf abgelaufen`); })
    .catch(e => console.error(`[freigabe] Aufräumen beim Start gescheitert (${e instanceof Error ? e.name : "Fehler"})`));

  /**
   * Zustellwege für Vorschläge aus Turns: Merk-Vorschläge und Session-Review
   * (Issue #117), mehrdeutige Merk-Tags (Issue #316), Rückfragen des Modells
   * (Issue #335). Bestätigte Vorschläge wendet decideReview direkt an.
   */
  const installNotifiers = () => {
    const ways = { sendChoice, postWeb };
    install.setReviewNotifier(createReviewNotifier(ways));
    install.setMemoryAsker(createMemoryAsker(ways));
    install.installAskOffer(createAskOffer(ways));
  };

  return { postWeb, sendChoice, threadChoices, memoryChoices, askChoices, reminderChoices, reviewResults, goalChoices, topicChoices, routineChoices, proactiveChoices, phone, taskReminders, approvalTurns, refresh, installNotifiers };
}

export type BotChoices = ReturnType<typeof wireBotChoices>;
