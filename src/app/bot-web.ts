/**
 * WebUI im Bot-Prozess (Issue #344, docs/webui/README.md): eigener Port,
 * derselbe Chat-Kern wie Telegram. Aus, ungültig oder nicht startbar: eine
 * Log-Zeile, der Bot läuft weiter (startWebUi).
 *
 * Gespräche: reine Web-Gespräche (createBotChat, nichts nach Telegram) und
 * Direktchat bzw. Topics (createTelegramChat, gleiche Session wie Telegram,
 * Nachricht vom Haupt-Bot gespiegelt, Antwort vom Agenten-Bot). Befehle aus
 * Browser und Terminal gehen durch dieselbe Befehls-Schicht wie Telegram.
 */
import { join } from "node:path";
import { getAgentByTopicId, getAgentConfigOrGeneral } from "../agents";
import { stripConsultTags } from "../lib/agent-consult";
import { boardAgentNames } from "../agents/catalog";
import { gatherBoardData } from "../lib/board/data";
import { runStreamingTurn } from "../lib/chat-turn";
import { dmChatId } from "../lib/channels";
import type { CommandRegistry } from "../lib/commands/registry";
import type { CommandServices } from "../lib/commands/types";
import { abortEngineCalls } from "../lib/engines";
import { listOpenCodeModels } from "../lib/engines/opencode";
import { getGoal, isGoalLoopRunning, onAgentTurnForGoal, onGoalChange } from "../lib/goal-engine";
import { runGoalAction } from "../lib/goal-actions";
import { processTurnIntents } from "../lib/intent-gate";
import { sendAndRecord } from "../lib/outbox";
import { resetSession } from "../lib/session-manager";
import { isVoiceEnabled, textToSpeech } from "../lib/speech";
import { storeOr } from "../lib/store";
import { onMessageSaved } from "../lib/store/events";
import type { Message } from "../lib/store/types";
import type { TelegramRuntime } from "../lib/telegram-runtime";
import { noteTurnForThreads } from "../lib/threads/detect";
import { takeThreadTurnHint } from "../lib/threads/hint";
import { getTopicNames } from "../lib/topic-names";
import { createVoiceSynthesis } from "../lib/voice-message";
import type { BotChoices } from "./bot-choices";
import { botAgentCatalog } from "../web/bot-agents";
import { createCallMemory, type BotCallPort } from "../web/bot-call";
import { createBotChoices } from "../web/bot-choices";
import { createBotCommands } from "../web/bot-commands";
import { createBotEngines } from "../web/bot-engines";
import { syncEngineAuto } from "../lib/engine-auto-sync";
import { createBotFiles } from "../web/bot-files";
import { createBotGoals } from "../web/bot-goals";
import { createBotKeys } from "../web/bot-keys";
import { prepareBotPush } from "../web/bot-push";
import { createBotReminders } from "../web/bot-reminders";
import { createBotJobs } from "../web/bot-jobs";
import { createBotPipelines } from "../web/bot-pipelines";
import { createJobDeps } from "../lib/jobs/default-deps";
import { createBotRoutines } from "../web/bot-routines";
import { createBotSessionReset } from "../web/bot-session-reset";
import { botInstructions, botSettings, botVoice } from "../web/bot-settings";
import { createBotSpeech } from "../web/bot-speech";
import { createVoiceAgentAdmin } from "../web/bot-voice-agent-admin";
import { createVoiceAgentSessions } from "../web/bot-voice-agent-session";
import { createVoiceAgentWizard, elevenLabsSpeak } from "../web/bot-voice-agent-wizard";
import { listProviderVoices } from "../lib/voice-agents/voice-catalog";
import { callAux } from "../lib/aux-model";
import { loadPriceBasis } from "../lib/voice-agents/cost";
import { createBotStatus } from "../web/bot-status";
import { createBotTelegram, createBotTelegramLive, botGroupId } from "../web/bot-telegram";
import { createBotThreads } from "../web/bot-threads";
import { createBotTopics } from "../web/bot-topics";
import { createBotChat, createTelegramChat, webMediaDir } from "../web/bot-turn";
import type { IntentTurn, TelegramChatDeps } from "../web/bot-turn";
import { createBotVoiceClone } from "../web/bot-voice-clone";
import { createWebServer, type WebServer } from "../web/server";
import { startWebUi } from "../web/startup";
import { createOpenRouterKey, type OpenRouterKeyOptions } from "../web/openrouter-key";
import { UploadStore } from "../web/uploads";

type Env = Record<string, string | undefined>;

export interface BotWebDeps {
  root: string;
  env: Env;
  runtime: TelegramRuntime;
  choices: Pick<BotChoices, "approvalTurns" | "routineChoices" | "goalChoices" | "voiceAgents" | "voiceDrafts">;
  commands: { registry: CommandRegistry; services: CommandServices };
  call: BotCallPort;
  isShuttingDown(): boolean;
  /** Neustart prüfen, sobald die Antwort draußen ist; ohne Chat-ID, sonst ginge die Meldung an eine Telegram-ID */
  scheduleRestartCheck(trigger: string): void;
  /** Höchstzahl der [INVOKE:]-Konsultationen je Antwort */
  invokeBudget: number;
  /** Nur für Tests: Start der WebUI (Standard startWebUi) */
  start?: typeof startWebUi;
  /** Nur für Tests: Chat-Kern, Speicher, Merk-Tor, /goal und Fäden der Turns (Standard die echten) */
  parts?: Partial<BotWebParts>;
  /** Nur für Tests: Abruf des Ersatzmodell-Schlüssels ohne echtes Netz. */
  openrouterKeyFetch?: OpenRouterKeyOptions["fetch"];
}

type BotWebParts = Required<Pick<TelegramChatDeps, "runStreamingTurn" | "saveMessage" | "processIntents" | "noteThreads" | "threadHint" | "onAgentTurn">>;

const saveMessage = (message: Message) => storeOr(false, store => store.messages.save(message));
const saveDisplayOnly = (message: Message) => storeOr(false, store => store.messages.saveDisplayOnly(message));

export async function startBotWeb(deps: BotWebDeps): Promise<WebServer | null> {
  const { env, runtime } = deps;
  const agents = runtime.agents;
  const { approvalTurns } = deps.choices;
  // Gespräch aus Chat-ID und Topic, wie in Telegram
  const conversationOf = { userId: dmChatId(env), groupId: () => botGroupId(env), agentForTopic: getAgentByTopicId };
  const sendAsAgent = (agent: string, chatId: string, text: string, threadId?: number) => agents.sendAsAgent(agent, chatId, text, { threadId });
  const sendTypingAsAgent = (agent: string, chatId: string, threadId?: number) => agents.sendTypingAsAgent(agent, chatId, threadId);
  const sendPlain = (chatId: string, text: string, threadId?: number) => runtime.sendPlain(chatId, text, threadId);

  const parts: BotWebParts = {
    runStreamingTurn,
    saveMessage,
    processIntents: (text: string, turn: IntentTurn) => processTurnIntents(text, turn.tools, turn),
    noteThreads: noteTurnForThreads,
    threadHint: conversation => takeThreadTurnHint(conversation),
    onAgentTurn: (sessionKey, agent, response) => void onAgentTurnForGoal(sessionKey, agent, response),
    ...deps.parts,
  };

  const turnBase = {
    runStreamingTurn: parts.runStreamingTurn,
    saveMessage: parts.saveMessage,
    processIntents: parts.processIntents,
    abortEngineCalls,
    isShuttingDown: deps.isShuttingDown,
    scheduleRestartCheck: (trigger: string) => deps.scheduleRestartCheck(trigger),
    allowedTools: (agent: string) => getAgentConfigOrGeneral(agent)?.allowedTools,
    // Wartehinweis (Issue #188) nennt Topics beim Namen
    topicNames: getTopicNames,
    approvals: approvalTurns,
  };
  // Offene Fäden (Issue #290/#292): nur für Nachrichten, nicht für Befehle
  const threads = { noteThreads: parts.noteThreads, threadHint: parts.threadHint };
  // Anhänge (Issue #72, #112): eine Ablage für Upload-Route, Telegram- und Web-Turn
  const uploads = new UploadStore({ dir: join(deps.root, "data", "uploads"), mediaDir: webMediaDir() });
  const webChat = createBotChat({ ...turnBase, ...threads, uploads });
  const telegramChat = createTelegramChat({
    ...turnBase,
    ...threads,
    ...conversationOf,
    sendPlain,
    sendAsAgent,
    sendFile: (chatId, file, options) => runtime.sendFile(chatId, file, options),
    uploads,
    // [INVOKE:] wie in Telegram (Issue #76)
    invokeBudget: deps.invokeBudget,
    sendTypingAsAgent,
    // Aktives /goal: Gates und Judge auch nach Antworten im Browser
    onAgentTurn: parts.onAgentTurn,
    // Denkauftrag aus dem Telefonhörer (Issue #259): Freigaben dauerhaft im Verlauf
    recordNotice: saveDisplayOnly,
  });
  const resetConversation = createBotSessionReset(conversationOf);
  const commands = createBotCommands({
    ...turnBase,
    ...conversationOf,
    registry: deps.commands.registry,
    services: deps.commands.services,
    sendPlain,
    sendAndRecord: input => sendAndRecord(input),
    resetConversation,
    sendAsAgent,
    sendTypingAsAgent,
    // /board (Issue #75): dieselben Teilnehmer und Daten wie in Telegram
    board: { agents: boardAgentNames, gatherData: gatherBoardData, stripInvocationTags: stripConsultTags },
    withApprovals: webChat.withApprovals,
    // /voice (Issue #78): Sprachnachricht über den Haupt-Bot; ohne Telegram kein Sender (Issue #228)
    voice: createVoiceSynthesis({ enabled: isVoiceEnabled, textToSpeech, log: m => console.log(`[web] ${m}`) }),
    sendVoice: runtime.voiceSender,
  });

  // Web-Gespräch und Verwaltung der Sprachagenten: dieselbe Ablage wie /sprachagent (bot-choices.ts)
  const voiceAgentPaths = { configDir: join(deps.root, "config", "voice-agents"), dataDir: join(deps.root, "data", "voice-agents") };
  const voiceAgentSessions = createVoiceAgentSessions({ env, paths: voiceAgentPaths });

  return (deps.start ?? startWebUi)({
    env,
    createServer: createWebServer,
    chat: webChat,
    telegram: createBotTelegram(env),
    telegramChat,
    telegramLive: createBotTelegramLive(env),
    agentCatalog: botAgentCatalog,
    resetSession: sessionKey => resetSession(sessionKey),
    resetConversation,
    // Topics aus der WebUI (Issue #29) nur mit Telegram (Issue #228)
    topics: runtime.topicApi ? createBotTopics(env, runtime.topicApi) : undefined,
    settings: botSettings,
    onSettingsSaved: () => syncEngineAuto(),
    instructions: botInstructions,
    voice: botVoice,
    speech: createBotSpeech(conversationOf),
    call: deps.call,
    callMemory: createCallMemory(conversationOf),
    voiceClone: createBotVoiceClone(),
    // Web-Gespräch je Rezept (Issue #494)
    voiceAgentSessions,
    // Bereich „Sprachagenten“ (Issue #495): derselbe Manager wie /sprachagent,
    // Testergebnisse in den Direktchat (ohne Telegram der der WebUI)
    voiceAgentAdmin: createVoiceAgentAdmin({
      manager: deps.choices.voiceAgents,
      paths: voiceAgentPaths,
      sessions: voiceAgentSessions,
      testResults: () => ({ type: "telegram", chatId: dmChatId(env) }),
    }),
    // Wizard für Sprachagenten (Issue #514): derselbe Entwurfsdienst wie /sprachagent neu,
    // Rückfragen in den Direktchat wie die Testergebnisse oben
    voiceAgentWizard: createVoiceAgentWizard({
      drafts: deps.choices.voiceDrafts,
      paths: voiceAgentPaths,
      ask: (prompt, timeoutMs) => callAux("voice-wizard", prompt, { timeoutMs, quiet: true }),
      conversation: () => ({ type: "telegram", chatId: dmChatId(env) }),
      prices: () => loadPriceBasis(join(deps.root, "config")),
      // Stimmenliste und Hörprobe (Issue #515): Stimmen des Kontos, Ton mit genau der gewählten Stimme
      voices: () => listProviderVoices(env),
      speak: elevenLabsSpeak(env),
    }),
    opencodeModels: listOpenCodeModels,
    status: createBotStatus(env),
    routines: createBotRoutines(env, deps.choices.routineChoices),
    jobs: createBotJobs({ deps: createJobDeps({ root: deps.root, env }), userId: dmChatId(env), groupId: () => botGroupId(env) }),
    pipelines: createBotPipelines({ root: deps.root }),
    threads: createBotThreads({ userId: () => dmChatId(env), groupId: () => botGroupId(env) }),
    reminders: createBotReminders({ topicNames: getTopicNames }),
    engines: createBotEngines(conversationOf),
    // env ist im Bot process.env, wie bei der Fallback-Kette; erst beim Abruf lesen.
    openrouterKey: createOpenRouterKey({ key: () => env.OPENROUTER_API_KEY?.trim(), fetch: deps.openrouterKeyFetch }),
    // Schlüssel-Seite (Issue #62): Ändern nur mit WEB_ALLOW_KEY_EDIT=true
    keys: createBotKeys(env),
    // Web Push (Issue #225): fehlen die VAPID-Schlüssel, legt der Bot sie einmal an
    push: (await prepareBotPush(env)) ?? undefined,
    files: createBotFiles(env),
    uploads,
    commands,
    goals: createBotGoals({
      ...conversationOf,
      get: getGoal,
      isRunning: isGoalLoopRunning,
      action: (sessionKey, action, goalId, onlyIf) => runGoalAction(sessionKey, action, { goalId, abort: abortEngineCalls, onlyIf }),
      decideBudget: (sessionKey, goalId, action) => deps.choices.goalChoices.decideFromCard(sessionKey, goalId, action),
      onChange: onGoalChange,
    }),
    choices: createBotChoices(env),
    // Meldungen für reine Web-Gespräche (Issue #227), nachgeholt nach Ausfällen
    webNotices: {
      page: (chatIds, options) => storeOr([], store => store.messages.displayOnlyPage(chatIds, options)),
      onMessageSaved,
    },
  });
}
