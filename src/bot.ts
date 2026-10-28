/**
 * tybo, der laufende Bot (Issue #344): nur noch Verdrahtung. Die Teile
 * stehen in eigenen Modulen:
 *
 * - src/app/lifecycle.ts, bot-shutdown.ts: Sperre, Herzschlag, Beenden
 * - src/app/bot-turns.ts: Modellaufrufe mit und ohne Fortschritt
 * - src/app/bot-choices.ts: alle Arten des Rückfragen-Registers
 * - src/app/bot-telegram-channel.ts, src/channels/telegram/: Telegram-Kanal
 * - src/app/health-server.ts: Health-Port mit /process
 * - src/app/bot-web.ts: WebUI
 * - src/app/bot-start.ts: Startbanner und Hintergrunddienste
 * - src/app/hybrid.ts: Weiterleitung zwischen Server und eigenem Rechner
 *
 * Start: bun run start, auf einem Server bun run vps (--profile server,
 * Issue #352). Fehlt ein Kanal, startet nur der Einrichtungsmodus
 * im Browser (Entscheidung 0011); ohne Telegram läuft nur die WebUI
 * (Entscheidung 0021).
 */
import { join } from "node:path";
import { loadEnv } from "./lib/env";
import { logLegacyDatabaseNotice } from "./lib/legacy-database-notice";
import { logSubprocessEnvFilter } from "./lib/subprocess-env";
import { activeExecutionCount, closeIntake, isAbortError, logAgentCapacity, runExecution } from "./lib/execution-context";
import { createBotRestart } from "./app/bot-restart";
import { clearRestartRequest, detectSupervisor, readRestartRequest } from "./lib/restart-request";
import { createLifecycle, createProcessLock, installSignalHandlers } from "./app/lifecycle";
import { registerBotShutdown } from "./app/bot-shutdown";
import { createLastSessionStore } from "./app/last-session";
import { describeAssetFromReply, healthAddress, loadTelegramPhoto, startHealthServer } from "./app/health-server";
import { createBotTurns, goalAgentCall } from "./app/bot-turns";
import { bootBot } from "./app/bot-boot";
import { createBotCommandServices } from "./app/command-services";
import { wireBotChoices } from "./app/bot-choices";
import { wireTelegramChannel } from "./app/bot-telegram-channel";
import { startBotWeb } from "./app/bot-web";
import { startBackground, startBanner, type Background } from "./app/bot-start";
import { allowedChat } from "./lib/http-security";
import { processInBackground } from "./lib/process-background";
import { createBotNotices } from "./lib/bot-notices";
import { sendAndRecord } from "./lib/outbox";
import { setEdgeFallbackNotifier } from "./lib/store/supabase/edge-warning";
import { dmChatId, isWebChatId, telegramConfigured } from "./lib/channels";
import { chooseStartMode } from "./setup/start-mode";
import { createTelegramRuntime, startAfterFirstSweep } from "./lib/telegram-runtime";
import { createServerRoutes } from "./app/server-routes";
import { startHybrid } from "./app/hybrid";
import { chatProgressMessages, createTelegramProgressSink } from "./lib/telegram-progress";
import { runJsonTurn, runStreamingTurn, SHUTDOWN_ABORT_REPLY } from "./lib/chat-turn";
import { abortAllEngineCalls, activeEngineCallCount } from "./lib/engines";
import { initGoalEngine, onAgentTurnForGoal, runningGoalLoopCount, goalResumeOnStart } from "./lib/goal-engine";
import { GOAL_NO_BUTTONS_HINT } from "./lib/goal-choices";
import { uploadAssetQuick, updateAssetDescription } from "./lib/asset-store";
import { sessionKeyFor } from "./lib/store/message-rules";
import { storeOr } from "./lib/store";
import { turnInfoCollector } from "./lib/turn-collector";
import { mcpManager } from "./lib/mcp-client";
import { isVoiceEnabled } from "./lib/speech";
import { phoneConfigured } from "./lib/phone";
import { getTranscriptionProvider, isTranscriptionEnabled } from "./lib/transcribe";
import { commandRegistry } from "./lib/commands/builtin";
import { routineConversation } from "./lib/routine-choices";
import { stopReminderPlanner } from "./lib/schedule/planner";
import { setCreditNotifier } from "./lib/spend/credit";
import { DEFAULT_CLAUDE_MODEL } from "./lib/default-model";
import { getAgentByTopicId, getAgentConfigOrGeneral } from "./agents";
import { activeCallTurnCount, createBotCall } from "./web/bot-call";
import { botGroupId } from "./web/bot-telegram";
import type { WebServer } from "./web/server";
import type { LogLevel } from "./lib/store/types";

const root = process.cwd();
const env = process.env;
const started = await bootBot({
  root,
  env,
  loadEnv,
  logCapacity: () => logAgentCapacity(),
  logSubprocessEnv: () => logSubprocessEnvFilter(),
  logLegacyDatabase: () => logLegacyDatabaseNotice(),
  chooseStartMode,
  runSetup: async startMode => (await import("./setup/web-mode")).runSetupMode({ root, env, startMode, supervisor: () => detectSupervisor() }),
  exit: code => process.exit(code),
  args: process.argv.slice(2),
});
if (!started) process.exit(0);

const log = (level: LogLevel, message: string, metadata?: Record<string, unknown>) =>
  storeOr(undefined, store => store.logs.write(level, "bot", message, metadata));

// Mit Telegram grammY-Bot, Agenten-Bots und Rückfrage-Knöpfe; ohne (Issue #228)
// kein Bot, kein Polling, kein getMe
// Im Server-Profil hängen /health, /deploy und /webhook/elevenlabs am
// Webhook-Listener (Issue #351); den Anrufdienst gibt es erst weiter unten
const runtime = createTelegramRuntime({ env, routes: createServerRoutes({ env, root, transcripts: () => choices.phone }) });
const owner = env.TELEGRAM_USER_ID ?? "";
const timezone = env.USER_TIMEZONE || "UTC";
// Höchstens so viele [INVOKE:]-Konsultationen je Antwort (Schutz vor Schleifen)
const invokeBudget = Math.max(1, Number.parseInt(env.AGENT_INVOKE_BUDGET ?? "", 10) || 3);

// Meldungen des Bots (Issue #227, #322): über die Outbox nach Telegram und in
// die WebUI, ohne Telegram nur in die WebUI; Rückfall der Haupt-Bot
const notices = createBotNotices({
  telegram: () => telegramConfigured(env),
  send: input => sendAndRecord(input),
  sendStatusMessage: (chatId, text, topicId, keyboard) => runtime.sendStatus(chatId, text, topicId, keyboard),
  sendMessage: (chatId, text, options) =>
    runtime.bot ? runtime.bot.api.sendMessage(chatId, text, options) : Promise.reject(new Error("Telegram nicht verbunden")),
  dmChatId: () => owner,
});
// Guthaben-Warnung und Planhinweis (Issue #346) über denselben Meldeweg
setCreditNotifier(notices.plain);
// Rückfall beim Speichern ohne Embedding: höchstens stündlich Bescheid
setEdgeFallbackNotifier(notices.plain);

// Letzte Session nur zur Anzeige (Health-Antwort, Startbanner)
const lastSession = createLastSessionStore({ path: join(root, "session-state.json") });
await lastSession.load();

// Lebenszyklus: bot.lock gegen einen zweiten Bot, Herzschlag, Beenden, Signale.
// Dieselbe Prozess-ID steht im Lock, im Startbanner und im Startlog
const pid = process.pid;
const lock = createProcessLock({ path: join(root, "bot.lock"), pid });
if (!(await lock.acquire())) process.exit(1);
const lifecycle = createLifecycle({
  lock,
  exit: code => process.exit(code),
  afterRelease: reason => log("info", `Shutdown: ${reason}`),
});
const isShuttingDown = () => lifecycle.isShuttingDown();
lifecycle.startHeartbeat();

// Hybrid (Issue #353): Middleware vor allen Handlern bzw. /relay; beim Beenden zuerst
const hybrid = startHybrid({ env, runtime, isShuttingDown });
lifecycle.onShutdown("Hybrid", () => hybrid.stop());

let web: WebServer | null = null;
let background: Background | null = null;
registerBotShutdown(lifecycle, {
  abortRunning: abortAllEngineCalls,
  routineWatch: () => background?.routineWatch ?? null,
  threadReminders: () => background?.threadReminders ?? null,
  stopReminders: () => (background ? stopReminderPlanner(background.reminderPlanner) : null),
  telegram: runtime,
  web: () => web,
  webAbortText: SHUTDOWN_ABORT_REPLY,
  mcp: mcpManager,
  saveSession: () => lastSession.save(),
});
installSignalHandlers(lifecycle, {
  on: (event, handler) => void process.on(event, handler),
  report: error => log("error", `Uncaught exception: ${error.message}`, { stack: error.stack }),
});

// Telefonhörer (Issue #257): ein Port für WebUI und Neustart-Steuerung
const call = createBotCall({ userId: dmChatId(env), groupId: () => botGroupId(env), agentForTopic: getAgentByTopicId });

// Neustart nach Antwort (Issue #190): data/restart-requested wirkt erst in Ruhe (src/app/bot-restart.ts)
const restart = createBotRestart({
  readRequest: () => readRestartRequest(),
  clearRequest: () => clearRestartRequest(),
  busy: [activeEngineCallCount, activeExecutionCount, runningGoalLoopCount, activeCallTurnCount],
  farewell: () => call.farewellAll(),
  detectSupervisor: () => detectSupervisor(),
  closeIntake,
  send: notices.restart,
  shutdown: reason => lifecycle.shutdown(reason),
  isShuttingDown,
});
const scheduleRestartCheck = restart.afterReply;
lifecycle.every(30_000, () => void restart.maybeRestart("idle"));

const turns = createBotTurns({
  runJson: runJsonTurn,
  runStreaming: runStreamingTurn,
  runExecution,
  isAbort: isAbortError,
  allowedTools: agent => getAgentConfigOrGeneral(agent)?.allowedTools,
  rememberSession: (id, engine) => lastSession.remember(id, engine),
  sendAsAgent: (agent, chatId, text, options) => runtime.agents.sendAsAgent(agent, chatId, text, options),
  progressSink: createTelegramProgressSink,
});

const services = createBotCommandServices({
  routineMenu: async (target, id) => {
    const conversation = routineConversation(target.chatId, target.topicId);
    return !!conversation && (await choices.routineChoices.offerMenu(conversation, id)).status === "sent";
  },
});
const afterTurn = (chatId: string, topicId?: number) => scheduleRestartCheck("nach Antwort", chatId, topicId);

const choices = wireBotChoices({
  root,
  env,
  runtime,
  web: () => web,
  notices,
  services,
  // Auftrag aus einem Anruf (Issue #366): Streaming-Turn mit Statusnachricht über die Bot-API
  phoneTask: {
    runStreamingTurn,
    progressMessages: (chatId, topicId) => (runtime.bot ? chatProgressMessages(runtime.bot.api, chatId, topicId) : undefined),
    onSessionId: turns.trackSession(),
    allowedTools: agent => getAgentConfigOrGeneral(agent)?.allowedTools,
    callClaude: (prompt, chatId, agent, topicId) => turns.ask(prompt, chatId, agent, topicId),
    onAgentTurn: (sessionKey, agent, response) => void onAgentTurnForGoal(sessionKey, agent, response),
    registry: runtime.agents,
    isShuttingDown,
    invokeBudget,
    afterTurn,
  },
});

// Erinnerungen an wartende Aufträge alle 15 Minuten (Issue #337), erster Lauf nach dem Start
lifecycle.every(15 * 60 * 1000, () =>
  choices.taskReminders.run().then(
    sent => {
      if (sent.asks + sent.legacy > 0) console.log(`[Erinnerung] erinnert: ${sent.asks} Rückfrage(n), ${sent.legacy} alte(r) Auftrag/Aufträge`);
    },
    error => console.error(`[Erinnerung] Lauf gescheitert (${error instanceof Error ? error.name : "Fehler"})`)
  )
);

const telegram = wireTelegramChannel({ env, runtime, turns, choices, services, isShuttingDown, afterTurn, invokeBudget });

// Health-Port mit /process: Aufträge laufen nach der 202-Antwort im Hintergrund
startHealthServer({
  ...healthAddress(env),
  session: () => lastSession.current(),
  secret: () => env.GATEWAY_SECRET || "",
  allowChat: allowedChat,
  relay: hybrid.relayRoute,
  process: request =>
    processInBackground(request, {
      sessionKey: (chatId, threadId) => sessionKeyFor(chatId, threadId ?? null),
      send: (chatId, text, threadId) => runtime.sendMessage(chatId, text, threadId),
      typing: chatId => runtime.typing(chatId),
      downloadPhoto: loadTelegramPhoto({
        api: () => (runtime.telegram ? runtime.bot?.api ?? null : null),
        token: env.TELEGRAM_BOT_TOKEN ?? "",
        dir: join(root, "uploads"),
      }),
      uploadAsset: (localPath, caption, photoFileId) =>
        uploadAssetQuick(localPath, { userCaption: caption, channel: "telegram", telegramFileId: photoFileId }),
      callClaude: (prompt, chatId, threadId) => turns.ask(prompt, chatId, "general", threadId),
      finishAsset: describeAssetFromReply({ describe: updateAssetDescription }),
    }),
});

web = await startBotWeb({
  root,
  env,
  runtime,
  choices,
  commands: { registry: commandRegistry, services },
  call,
  isShuttingDown,
  scheduleRestartCheck: trigger => scheduleRestartCheck(trigger),
  invokeBudget,
});

// Agenten-Bots anmelden (nur senden, kein Polling); ohne Telegram nichts
await runtime.initialize();

initGoalEngine({
  callAgent: goalAgentCall(turns, turnInfoCollector),
  // Abbruch durch Neustart pausiert kein Ziel (Issue #190)
  isShuttingDown,
  // Web-Direktchat ohne Telegram (Issue #227): die Antwort steht schon im Verlauf
  sendAsAgent: (goal, text) =>
    isWebChatId(goal.chatId) ? Promise.resolve() : runtime.agents.sendAsAgent(goal.agentName, goal.chatId, text, { threadId: goal.topicId }),
  // Pause, Wartet, Fertig auch für die WebUI; die Budget-Frage als Rückfrage (Issue #118)
  sendStatus: notices.goalStatus({ ask: (target, text) => choices.goalChoices.ask(target, text), noButtonsHint: GOAL_NO_BUTTONS_HINT }),
});
choices.installNotifiers();

// MCP-Werkzeuge für die Fallback-Modelle; scheitert das, laufen sie ohne
await mcpManager.init().catch((error: Error) => {
  console.error("[MCPManager] Init failed (continuing without MCP tools for fallback):", error.message);
});

for (const line of startBanner({
  root,
  pid,
  timezone,
  healthPort: healthAddress(env).port,
  telegram: runtime.telegram,
  web: web !== null,
  claudePath: env.CLAUDE_PATH || "claude",
  voice: isVoiceEnabled(),
  phone: phoneConfigured(),
  transcription: isTranscriptionEnabled() ? getTranscriptionProvider() : undefined,
  mcp: mcpManager.isReady ? mcpManager.getStatus() : undefined,
  sessionId: lastSession.current().sessionId,
  defaultModel: DEFAULT_CLAUDE_MODEL,
})) {
  console.log(line);
}
await log("info", "Bot started", { pid, timezone });

background = startBackground({
  root,
  env,
  notices,
  choices: runtime.choices,
  routineChoices: choices.routineChoices,
  postWeb: choices.postWeb,
  refresh: choices.refresh,
});

// Polling erst nach WebUI, Goal-Engine, Vorschlägen, MCP und der ersten
// Ablauf-Prüfung; aktive Ziele danach genau einmal fortsetzen (Issue #190).
// Die Handler hängen nur mit Telegram am Bot
const resumeGoals = goalResumeOnStart();
runtime.bot?.use(telegram.channel.handlers);
void startAfterFirstSweep(runtime, background.firstSweep, resumeGoals);
