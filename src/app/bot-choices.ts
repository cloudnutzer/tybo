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
import { join } from "node:path";
import { getAgentByTopicId, getUserProfile } from "../agents";
import { ASK_SOURCE, createAskChoices, createAskDeliver, createAskOffer, installAskOffer } from "../lib/ask-choices";
import { callAux } from "../lib/aux-model";
import type { BotNotices } from "../lib/bot-notices";
import { onChoiceDecided } from "../lib/choices";
import { dmChatId, isWebChatId, outboxDelivered, telegramConfigured } from "../lib/channels";
import { abortEngineCalls } from "../lib/engines";
import { getGoal, onGoalChange } from "../lib/goal-engine";
import { createGoalChoices } from "../lib/goal-choices";
import { decideReview } from "../lib/intent-gate";
import { setMemoryAsker, setMemoryFailureNotice } from "../lib/memory";
import { createMemoryAsker, createMemoryChoices, MEMORY_SOURCE } from "../lib/memory/choices";
import { CORE_SOURCE, createCoreChoices } from "../lib/memory/core-choices";
import { createCleanupChoices, factCleanupFile } from "../lib/memory/fact-cleanup";
import { createSecretChoices, secretDecisionsFile } from "../lib/memory/secret-review";
import { sendAndRecord, type SendAndRecordInput, type SendAndRecordResult } from "../lib/outbox";
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
import { getStore, storeOr } from "../lib/store";
import { applyThreadButton } from "../lib/threads/store";
import { createTaskReminders } from "../lib/task-reminders";
import { directChatIds } from "../lib/task-place";
import type { TelegramRuntime } from "../lib/telegram-runtime";
import { refreshChoiceMessages } from "../lib/telegram-choices";
import { classifyReminderResult, createThreadChoices, installThreadChoiceExpiry, threadTarget, THREAD_SOURCE } from "../lib/thread-choices";
import { createChoiceToolApproval, expireOrphanedToolChoices } from "../lib/tool-approval";
import { createAftercall, type Aftercall, type AftercallTarget, type DeliveryOutcome, TRAINING_SOURCE } from "../lib/voice-agents/aftercall";
import { createElevenLabsLayer } from "../lib/voice-agents/elevenlabs";
import { createVoiceAgentManager, VOICE_AGENT_SOURCE } from "../lib/voice-agents/manage";
import { loadPriceBasis } from "../lib/voice-agents/cost";
import { createDraftJobs } from "../lib/voice-agents/draft-jobs";
import { createDraftService, voiceAgentChoiceHandler, type DraftService } from "../lib/voice-agents/drafts";
import { listProviderVoices, suggestVoices } from "../lib/voice-agents/voice-catalog";
import { setPhoneCallService } from "../lib/tools/phone-call";
import { setToolApprovalHandler } from "../lib/tools/registry";
import { createTopicChoices } from "../lib/topic-choices";
import { onTopicMappingSet } from "../lib/topic-setup";
import { botGroupId } from "../web/bot-telegram";
import { webUiBaseUrl } from "../web/startup";
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
  /** Nur für Tests: Bausteine mit Ablage, Versand oder Modell ersetzen (Standard die echten) */
  parts?: Partial<ChoiceParts>;
}

interface ChoiceParts {
  decideReview: typeof decideReview;
  createRoutine: typeof createRoutineFromSession;
  sendAndRecord: typeof sendAndRecord;
  saveMessage(message: Message): Promise<boolean>;
  applyThreadButton: typeof applyThreadButton;
  callAux: typeof callAux;
  /** Hintergrund-Jobs der Entwürfe (Issue #493) */
  createDraftJobs: typeof createDraftJobs;
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
  setMemoryFailureNotice,
  installAskOffer,
  /** Offene Anrufe nach einem Neustart weiter abholen */
  resumeCalls: (phone: { resume(): void }) => phone.resume(),
  /** Nachlauf der Sprachagenten (Issue #496): offene Auswertungen und Meldungen nach einem Neustart fortsetzen */
  resumeAftercall: (aftercall: Pick<Aftercall, "resume">) => {
    void aftercall.resume().catch(e => console.error(`[sprachagent] Nachlauf nach dem Start nicht geprüft (${e instanceof Error ? e.name : "Fehler"})`));
  },
  /** Entwürfe für Sprachagenten (Issue #493): laufende Jobs nach einem Neustart weiter verfolgen, Takt alle 15 Sekunden */
  resumeVoiceDrafts: (drafts: Pick<DraftService, "resume" | "startPolling">): (() => void) => {
    void drafts.resume().catch(e => console.error(`[sprachagent] Entwürfe nach dem Start nicht geprüft (${e instanceof Error ? e.name : "Fehler"})`));
    return drafts.startPolling();
  },
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

/**
 * Meldung des Nachlaufs (Issue #496) an nachlauf.ziel über die Outbox, also
 * display_only im Verlauf und nie Kontext eines Modells. Ohne Telegram gibt es
 * keine Topics: Dann geht auch topic:<n> in den Web-Direktchat, damit die
 * Meldung überhaupt ankommt.
 */
export function aftercallNotify(send: (input: SendAndRecordInput) => Promise<SendAndRecordResult>, env: Env): (target: AftercallTarget, text: string) => Promise<DeliveryOutcome> {
  return async (target, text) => {
    const topic = /^topic:([1-9][0-9]*)$/.exec(target);
    const where = topic && telegramConfigured(env) ? { topicId: Number(topic[1]) } : {};
    return classifyReminderResult(await send({ ...where, text, source: TRAINING_SOURCE, format: "plain" }));
  };
}

const CHOICE_PARTS: ChoiceParts = { decideReview, createRoutine: createRoutineFromSession, sendAndRecord, saveMessage, applyThreadButton, callAux, createDraftJobs };

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
  const { decideReview, createRoutine, sendAndRecord, saveMessage, applyThreadButton, callAux, createDraftJobs } = { ...CHOICE_PARTS, ...deps.parts };
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

  // Bereinigung der Fakten (Issue #520): den Befehl führt ein eigener Prozess aus, die Klicks kommen hier an
  const cleanupChoices = createCleanupChoices({
    file: factCleanupFile(deps.root),
    memory: () => getStore().memory,
    sendChoice,
    notify: (conversation, text) => deliverOrThrow({ ...threadTarget(conversation), text, source: MEMORY_SOURCE, format: "plain" }),
  });
  onChoiceDecided("cleanup", cleanupChoices.handler);

  // Geheimnisse in Fakten (Issue #524): behalten oder archivieren, die Fragen stellt ein eigener Prozess
  const secretChoices = createSecretChoices({
    file: secretDecisionsFile(deps.root),
    memory: () => getStore().memory,
    notify: (conversation, text) => deliverOrThrow({ ...threadTarget(conversation), text, source: MEMORY_SOURCE, format: "plain" }),
  });
  onChoiceDecided("secret", secretChoices.handler);

  // Entwurf für den Kern (Issue #522): strenges Lesen, ein Lesefehler ergibt keinen Entwurf
  const coreChoices = createCoreChoices({
    facts: () => getStore().memory.facts({ strict: true }),
    callAux,
    sendChoice,
    postWeb,
    notify: (conversation, text) => deliverOrThrow({ ...threadTarget(conversation), text, source: CORE_SOURCE, format: "plain" }),
  });
  onChoiceDecided("core", coreChoices.handler);
  deps.services.core = { offerDraft: coreChoices.offerDraft };

  // Sprachagenten (Issue #492): /sprachagent und das Löschen mit Rückfrage. Ohne
  // ELEVENLABS_API_KEY gibt es keine Sprachschicht, Liste und Archiv gehen trotzdem
  const voiceAgentPaths = { configDir: join(deps.root, "config", "voice-agents"), dataDir: join(deps.root, "data", "voice-agents") };
  const voiceLayer = () => (env.ELEVENLABS_API_KEY?.trim() ? createElevenLabsLayer({ env, paths: voiceAgentPaths }) : null);
  const voiceNotify = (conversation: Parameters<typeof threadTarget>[0], text: string) =>
    deliverOrThrow({ ...threadTarget(conversation), text, source: VOICE_AGENT_SOURCE, format: "plain" });
  // Link auf die Gesprächsseite (Issue #494): Adresse der WebUI zum Zeitpunkt des Befehls
  const voiceAgents = createVoiceAgentManager({ layer: voiceLayer, paths: voiceAgentPaths, sendChoice, postWeb, notify: voiceNotify, webBase: () => webUiBaseUrl(env) });
  // Entwürfe (Issue #493): neu und aendern per Hintergrund-Job, Freigabe in derselben Art.
  // Ein Handler für beide, eine zweite Anmeldung ersetzte sonst den Löschhandler
  const voiceDrafts = createDraftService({
    root: deps.root,
    paths: voiceAgentPaths,
    jobs: createDraftJobs(deps.root, env),
    layer: voiceLayer,
    suggestVoices: async description => suggestVoices(description, await listProviderVoices(env)),
    prices: () => loadPriceBasis(join(deps.root, "config")),
    sendChoice,
    postWeb,
    notify: voiceNotify,
  });
  onChoiceDecided("sprachagent", voiceAgentChoiceHandler(voiceAgents.handler, voiceDrafts));
  deps.services.voiceAgents = voiceAgents;
  deps.services.voiceDrafts = voiceDrafts;
  const stopDraftPolling = install.resumeVoiceDrafts(voiceDrafts);

  // Nachlauf-Weiche (Issue #496): Protokolle vom Webhook. Rezept-Agenten werden beim
  // Rezept abgelegt und ausgewertet, alles andere geht wie bisher an den Anrufdienst
  const aftercall = createAftercall({
    paths: voiceAgentPaths,
    phone: () => phone,
    phoneAgentId: () => env.ELEVENLABS_AGENT_ID?.trim() || undefined,
    evaluate: prompt => callAux("voice-training", prompt, { quiet: true }),
    notify: aftercallNotify(input => sendAndRecord(input), env),
    ...(env.USER_TIMEZONE ? { timeZone: env.USER_TIMEZONE } : {}),
  });
  install.resumeAftercall(aftercall);

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
   * (Issue #117), mehrdeutige Merk-Tags (Issue #316), nicht gespeicherte
   * Ziele (Issue #518), Rückfragen des Modells (Issue #335). Bestätigte
   * Vorschläge wendet decideReview direkt an.
   */
  const installNotifiers = () => {
    const ways = { sendChoice, postWeb };
    install.setReviewNotifier(createReviewNotifier(ways));
    install.setMemoryAsker(createMemoryAsker(ways));
    install.setMemoryFailureNotice(memoryChoices.failureNotice);
    install.installAskOffer(createAskOffer(ways));
  };

  return { postWeb, sendChoice, voiceAgents, voiceDrafts, stopDraftPolling, threadChoices, memoryChoices, askChoices, reminderChoices, reviewResults, goalChoices, topicChoices, routineChoices, proactiveChoices, phone, aftercall, taskReminders, approvalTurns, refresh, installNotifiers };
}

export type BotChoices = ReturnType<typeof wireBotChoices>;
