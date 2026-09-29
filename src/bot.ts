import { rotateServiceLogs } from "./lib/log-retention";
import { checkEmbeddingAtStartup } from "./lib/embedding";
import { drainEmbeddingQueue, DRAIN_INTERVAL_MS } from "./lib/embedding";
import { runExecution, runCancelable, activeExecutionCount, logAgentCapacity, isAbortError, closeIntake, isRestartPendingError, RESTART_PENDING_REPLY, isExecutionActive, blockExecutions } from "./lib/execution-context";
import { createRestartControl } from "./lib/restart-control";
import { resumeMacTask, taskResumeRecord } from "./lib/task-resume";
import { turnInfoCollector } from "./lib/turn-collector";
import { readRestartRequest, clearRestartRequest, detectSupervisor } from "./lib/restart-request";
import { atomicWriteFile } from "./lib/atomic-file";
import { allowedChat } from "./lib/http-security";
import { createProcessHandler } from "./lib/process-handler";
import { processInBackground, type ProcessBackgroundDeps } from "./lib/process-background";
import { createWebServer, type WebServer } from "./web/server";
import { createApprovalTurns, createBotChat, createTelegramChat, webMediaDir } from "./web/bot-turn";
import { createBotSessionReset } from "./web/bot-session-reset";
import { createBotCommands } from "./web/bot-commands";
import { createVoiceSynthesis } from "./lib/voice-message";
import { createBotGoals } from "./web/bot-goals";
import { createBotChoices } from "./web/bot-choices";
import { sendAndRecord } from "./lib/outbox";
import { dmChatId, isWebChatId, telegramConfigured } from "./lib/channels";
import { createUserNotifier } from "./lib/user-notify";
import type { IntentTurn } from "./web/bot-turn";
import { createBotTelegram, createBotTelegramLive, botGroupId } from "./web/bot-telegram";
import { startWebUi } from "./web/startup";
import { chooseStartMode } from "./setup/start-mode";
import { BRAND } from "./brand";
import { createBotTopics } from "./web/bot-topics";
import { botInstructions, botSettings } from "./web/bot-settings";
import { createBotStatus } from "./web/bot-status";
import { createBotEngines } from "./web/bot-engines";
import { createBotKeys } from "./web/bot-keys";
import { prepareBotPush } from "./web/bot-push";
import { createBotFiles } from "./web/bot-files";
import { UploadStore } from "./web/uploads";
import { handleTopicServiceMessage, topicChanges } from "./web/topic-changes";
import { botAgentCatalog } from "./web/bot-agents";
import { setToolApprovalHandler } from "./lib/tools/registry";
import { createChoiceToolApproval, expireOrphanedToolChoices } from "./lib/tool-approval";
/**
 * Go - Telegram Bot Daemon
 *
 * Core relay that connects Telegram to Claude Code.
 * Handles text, voice, photo, video, and document messages with
 * multi-agent routing, persistent memory, and fallback LLM chain.
 *
 * Usage: bun run src/bot.ts
 */

import { Composer, Context, InputFile } from "grammy";
import { join } from "path";
import { readFile, writeFile, mkdir, unlink, stat } from "fs/promises";
import { createWriteStream, existsSync } from "fs";

// ---------------------------------------------------------------------------
// Local Modules
// ---------------------------------------------------------------------------

import { loadEnv } from "./lib/env";
import { logSubprocessEnvFilter } from "./lib/subprocess-env";
import {
  markdownToTelegramHTML,
  chunkForTelegram,
  stripHtmlTags,
  sendResponse,
  createTypingIndicator,
  installTelegramOutputGuard,
  NO_LINK_PREVIEW,
  sanitizeModelOutput,
} from "./lib/telegram";
import { createTelegramProgressSink } from "./lib/telegram-progress";
import { cleanupMedia, finishMedia, prepareMedia, uploadName } from "./lib/media-turn";
import { ABORT_REPLY, SHUTDOWN_ABORT_REPLY, runJsonTurn, runStreamingTurn, type SessionIdListener, type SessionMetaListener, type TurnInfo, type TurnSessionMeta, type TurnSink } from "./lib/chat-turn";
import { isClaudeErrorResponse } from "./lib/claude";
import { abortEngineCalls, abortAllEngineCalls, activeEngineCallCount, type EngineId } from "./lib/engines";
import { listOpenCodeModels } from "./lib/engines/opencode";
import {
  getMemoryContext,
  addFact,
  addGoal,
  completeGoal,
  deleteFact,
  cancelGoal,
  listGoals,
  listFacts,
} from "./lib/memory";
import { uploadAssetQuick, updateAssetDescription, parseAssetDescTag, stripAssetDescTag } from "./lib/asset-store";
import { sessionKeyFor } from "./lib/convex";
import {
  isSessionModeEnabled,
  getSessionsForKey,
  resetSession,
  sessionEpoch,
  type BotSession,
} from "./lib/session-manager";
import {
  shouldDistill,
  distillSession,
  setReviewNotifier,
} from "./lib/session-distill";
import { decideReview, processTurnIntents } from "./lib/intent-gate";
import { createReviewNotifier, createReviewResults, type PostWeb } from "./lib/review-choices";
import { onChoiceDecided } from "./lib/choices";
import type { TurnTools } from "./lib/turn-tools";
import { createRoutineFromSession } from "./lib/session-routine";
import {
  addAgentOverride,
  clearAgentOverrides,
  removeLastAgentOverride,
  getAgentOverrides,
  listAllOverrides,
} from "./lib/agent-overrides";
import {
  initGoalEngine,
  getGoal,
  setGoal,
  clearGoal,
  pauseGoal,
  updateGoal,
  resumeGoalWork,
  startGoalWork,
  onAgentTurnForGoal,
  formatGoalStatus,
  isGoalLoopRunning,
  onGoalChange,
  runningGoalLoopCount,
  goalResumeOnStart,
} from "./lib/goal-engine";
import { createTelegramGoalStatus, handleGoalCallback, runGoalAction } from "./lib/goal-actions";
import { createGoalChoices, GOAL_NO_BUTTONS_HINT } from "./lib/goal-choices";
import { legacyToolApprovalMiddleware } from "./lib/telegram-tool-approval";
import { installTelegramChoices } from "./lib/telegram-choices";
import { createTelegramRuntime, startAfterFirstSweep } from "./lib/telegram-runtime";
import { learnFromSource } from "./lib/learn";
import { captureTopicName, getTopicNames, recordTopicName, recordTopicNameIfMissing } from "./lib/topic-names";
import { createQueueNotifier } from "./lib/queue-notice";
import {
  claimTopicMappingQuestion,
  onTopicMappingSet,
} from "./lib/topic-setup";
import { createTopicChoices, legacyButtonPages, TOPIC_MAP_TEXT } from "./lib/topic-choices";
import { callFallbackLLM } from "./lib/fallback-llm";
import { mcpManager } from "./lib/mcp-client";
import { textToSpeech, initiatePhoneCall, isVoiceEnabled, isCallEnabled, waitForTranscript, summarizeTranscript, extractTaskFromTranscript } from "./lib/voice";
import { isTranscriptionEnabled, getTranscriptionProvider } from "./lib/transcribe";
import {
  saveMessage,
  getDisplayOnlyPage,
  onMessageSaved,
  searchMessages,
  getRecentMessages,
  log as sbLog,
  createTask,
  updateTask,
} from "./lib/convex";

// Task Queue (Human-in-the-Loop)
import {
  parseClaudeResponse,
  buildTaskKeyboard,
  handleTaskCallback,
  formatTaskStatus,
  checkStaleTasks,
} from "./lib/task-queue";

// VPS Anthropic Processor (for resuming VPS tasks)
import {
  processWithAnthropic,
  type ResumeState,
} from "./lib/anthropic-processor";
import {
  processWithAgentSDK,
  type AgentResumeState,
} from "./lib/agent-session";

// Model Router (UX-only on Mac — controls progress updates, not model selection)
import { classifyComplexity } from "./lib/model-router";
import * as creditGuard from "./lib/credit-guard";

// Multi-Bot Agent Identity
import { capInvocations, parseInvocationTags, stripInvocationTags, executeVisibleInvocation } from "./lib/cross-agent";

// Agents
import {
  getAgentConfigOrGeneral,
  getAgentByTopicId,
  getTopicMappingForChat,
  formatCrossAgentContext,
  getUserProfile,
} from "./agents";
import { boardAgentNames, isActiveAgent, listAgentNames } from "./agents/catalog";
import { gatherBoardData } from "./lib/board-data";
import { createTelegramBoardOutput, requestBoardStop, runBoardMeeting as runBoardCore } from "./lib/board-meeting";
import { engineCommandServices } from "./lib/engine-choice";
import { commandRegistry } from "./lib/commands/builtin";
import { recoverJobsUntilSettled } from "./lib/jobs/control";
import { createJobDeps } from "./lib/jobs/default-deps";
import { createTelegramSessionReset, runTelegramCommand, type TelegramCommandInput } from "./lib/commands/telegram";
import type { CommandMatch, CommandServices } from "./lib/commands/types";

// ---------------------------------------------------------------------------
// 1. Load Environment
// ---------------------------------------------------------------------------

await loadEnv(join(process.cwd(), ".env"));
// Grenze gleichzeitiger Aufträge erst nach .env bestimmen, einmal ins Log (Issue #208)
logAgentCapacity();
// Einmal beim Start: welche Geheimnisse Claude-Subprozesse nicht erben (nur Namen, Issue #54)
logSubprocessEnvFilter();

// ---------------------------------------------------------------------------
// 2. Configuration
// ---------------------------------------------------------------------------

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID;
const PROJECT_ROOT = process.cwd();
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const TIMEZONE = process.env.USER_TIMEZONE || "UTC";
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || "3000", 10);
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || "";

// Einrichtungsmodus (Issue #66, Entscheidung 0011): fehlt ein Telegram-Pflichtwert,
// startet statt FATAL nur der Assistent im Browser (127.0.0.1, Einmal-Code im Log).
// Kein Telegram, keine Claude-Aufrufe, kein bot.lock. Nach „Fertig" endet der
// Prozess; launchd/PM2 starten ihn neu, sonst steht der Startbefehl im Log.
const startMode = chooseStartMode(process.env);
if (startMode.mode === "setup") {
  const { runSetupMode } = await import("./setup/web-mode");
  process.exit(await runSetupMode({ root: PROJECT_ROOT, env: process.env, startMode, supervisor: () => detectSupervisor() }));
}

// Telegram-Teil (Issue #228, Entscheidung 0021): mit Telegram grammY-Bot samt
// Output-Guard (Issue #52), Agenten-Bots und Rückfragen; ohne Telegram (nur
// WebUI) kein Bot, kein Polling, keine Handler, keine Agenten-Bots, kein getMe.
// Halbes Telegram kommt nicht bis hier: das erledigt chooseStartMode oben
const telegramRuntime = createTelegramRuntime({ env: process.env });

// ABORT_REPLY (lib/chat-turn): sentinel returned by callClaude/
// callClaudeWithProgress when the subprocess was killed via /stop; callers
// skip fallback, retry, and persistence.

// SHUTDOWN_ABORT_REPLY (lib/chat-turn): shown instead of ABORT_REPLY when the
// kill came from shutdown(); the WebUI uses the same text.


// Cross-agent reply budget: max [INVOKE:] consultations executed per turn
// (Buzz-Lehre: mechanischer Loop-Schutz statt nur Prompt-Regeln)
const INVOKE_BUDGET = Math.max(
  1,
  parseInt(process.env.AGENT_INVOKE_BUDGET || "3", 10) || 3
);

// Agents the /agent command accepts: aktive Agenten aus dem Katalog
// (src/agents/catalog.ts, Issue #49) plus common aliases
const AGENT_NAME_ALIASES: Record<string, string> = {
  ceo: "strategy",
  cfo: "finance",
  cmo: "content",
  outreach: "content",
  researcher: "research",
  dev: "cto",
  tech: "cto",
  ops: "coo",
  operations: "coo",
};

function resolveAgentName(raw: string): string | undefined {
  const lower = raw.toLowerCase();
  const canonical = AGENT_NAME_ALIASES[lower] || lower;
  return isActiveAgent(canonical) ? canonical : undefined;
}

// Bot-interne Meldungen an den Nutzer (Issue #227): Neustart, Credit-Guard, liegengebliebene
// Aufgaben, Goal-Status. Alles ueber die Outbox: mit Telegram dorthin und einmal fuer die WebUI
// festgehalten, ohne Telegram nur in der WebUI. Rueckfall fuer Ziele, die die Outbox ablehnt:
// der Haupt-Bot wie bisher (sendStatusMessage)
const notifyUser = createUserNotifier({
  telegram: () => telegramConfigured(process.env),
  send: (input) => sendAndRecord(input),
  sendTelegram: (chatId, text, topicId, buttons) =>
    sendStatusMessage(chatId, text, topicId, buttons ? { inline_keyboard: buttons } : undefined),
  dmChatId: () => String(ALLOWED_USER_ID),
});

// Deliver the credit-guard's 80% warning + plan-change nudge to the owner's chat (Klartext wie bisher).
creditGuard.setNotifier((msg) => void notifyUser(msg, { format: "plain" }));

// Multi-bot registry (agent-specific bots for visible identities); ohne Telegram ohne Netz
const botRegistry = telegramRuntime.agents;

// Befehls-Schicht (Issue #74): gemeinsame Funktionen fuer Telegram, Browser
// und Terminal; Telegram-eigene Teile setzt telegramCommandInput dazu
const commandServices: CommandServices = {
  isSessionModeEnabled,
  getGoal,
  pauseGoal,
  abortEngineCalls,
  listAllOverrides: () => listAllOverrides(isActiveAgent),
  listAgentNames,
  resolveAgentName,
  getAgentOverrides,
  clearAgentOverrides: (agent, onWriteStart) => clearAgentOverrides(agent, undefined, onWriteStart),
  removeLastAgentOverride: (agent, onWriteStart) => removeLastAgentOverride(agent, undefined, onWriteStart),
  addAgentOverride,
  topicMapping: getTopicMappingForChat,
  topicNames: getTopicNames,
  listGoals,
  learn: learnFromSource,
  formatPlan: creditGuard.formatPlan,
  sessionsForKey: getSessionsForKey,
  sessionEpoch,
  createRoutine: (session, hint, epoch) => createRoutineFromSession(session as BotSession, hint, {}, epoch),
  requestBoardStop,
  // /motor (Issue #125): Motor pro Gespräch in config/settings.json
  engines: engineCommandServices,
  // /goal (Issue #76): gleiche Aktionen wie die Knoepfe in Telegram und im Browser
  goals: {
    get: getGoal,
    set: setGoal,
    update: updateGoal,
    action: (sessionKey, action) => runGoalAction(sessionKey, action, { abort: abortEngineCalls }),
    start: (sessionKey) => void startGoalWork(sessionKey),
    formatStatus: formatGoalStatus,
  },
};

function telegramCommandInput(
  ctx: Context,
  chatId: string,
  topicId: number | undefined,
  text: string,
  match: CommandMatch
): TelegramCommandInput {
  const sessionKey = sessionKeyFor(chatId, topicId ?? null);
  return {
    chat: ctx,
    chatId,
    topicId,
    sessionKey,
    agent: topicId ? getAgentByTopicId(topicId, chatId) || "general" : "general",
    text,
    match,
    services: { ...commandServices, voiceReply: (_cmd, voiceText) => voiceReplyTelegram(ctx, chatId, topicId, voiceText) },
    working: () => {
      const typing = createTypingIndicator(ctx);
      typing.start();
      return () => typing.stop();
    },
    // /new wie bisher ohne Sperre; /motor (whileBlocked) lehnt bei laufender Antwort ab und sperrt bis nach dem Schreiben
    resetSession: createTelegramSessionReset(sessionKey, {
      isActive: isExecutionActive,
      block: blockExecutions,
      sessionsForKey: getSessionsForKey,
      shouldDistill,
      distill: distillSession,
      reset: key => resetSession(key),
      sessionModeEnabled: isSessionModeEnabled,
    }),
    // Antwort geht wie bisher selbst nach Telegram; kein Rueckgabewert (Issue #78)
    agentTurn: async (agent, prompt) => {
      await callClaudeAndReply(ctx, chatId, prompt, agent, topicId);
      return undefined;
    },
    boardMeeting: (extraContext) => runBoardMeeting(ctx, chatId, topicId, extraContext),
  };
}

/** /voice (nur Telegram): Claude-Antwort als Sprachnachricht */
async function voiceReplyTelegram(ctx: Context, chatId: string, topicId: number | undefined, voiceText: string): Promise<void> {
  if (!isVoiceEnabled()) {
    await ctx.reply("Voice is not configured. Set ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID or GEMINI_API_KEY in .env");
    return;
  }
  const typing = createTypingIndicator(ctx);
  typing.start();
  try {
    const agentName = topicId ? getAgentByTopicId(topicId, chatId) || "general" : "general";
    const tier = classifyComplexity(voiceText);
    let claudeResponse: string;
    const turn = turnInfoCollector();

    if (tier !== "haiku") {
      claudeResponse = await callClaudeWithProgress(ctx, voiceText, chatId, agentName, topicId, turn.onInfo, turn.onTools);
    } else {
      claudeResponse = await callClaude(voiceText, chatId, agentName, topicId, turn.onInfo, turn.onTools);
    }

    await saveMessage({
      chat_id: chatId,
      role: "assistant",
      content: claudeResponse,
      metadata: { agent: agentName, type: "voice_reply", topicId, ...turn.metadata() },
    });

    await processTurnIntents(claudeResponse, turn.tools(), { chatId, topicId, origin: "Telegram" });

    const audioBuffer = await textToSpeech(claudeResponse);
    if (audioBuffer) {
      await ctx.replyWithVoice(new InputFile(audioBuffer, "response.mp3"));
    } else {
      await ctx.reply("Could not generate voice. Here's the text response:");
      await sendResponse(ctx, claudeResponse);
    }
  } catch (error) {
    console.error("/voice command error:", error);
    await ctx.reply("Something went wrong processing your voice request.");
  } finally {
    typing.stop();
  }
}

// ---------------------------------------------------------------------------
// 3. Session State Management
// ---------------------------------------------------------------------------

interface SessionState {
  sessionId: string | null;
  /** Motor der letzten Session (Issue #122), nur Anzeige */
  engine: EngineId | null;
  pendingFiles: string[];
}

const SESSION_STATE_PATH = join(PROJECT_ROOT, "session-state.json");

let sessionState: SessionState = {
  sessionId: null,
  engine: null,
  pendingFiles: [],
};

async function loadSessionState(): Promise<void> {
  try {
    const raw = await readFile(SESSION_STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    sessionState = {
      sessionId: parsed.sessionId || null,
      engine: parsed.engine || (parsed.sessionId ? "claude" : null),
      pendingFiles: Array.isArray(parsed.pendingFiles) ? parsed.pendingFiles : [],
    };
  } catch {
    // No saved state, use defaults
  }
}

async function saveSessionState(): Promise<void> {
  try {
    await atomicWriteFile(SESSION_STATE_PATH, JSON.stringify(sessionState, null, 2));
  } catch {
    // Silent failure
  }
}

await loadSessionState();

// ---------------------------------------------------------------------------
// 4. Process Lock (Prevent Multiple Instances)
// ---------------------------------------------------------------------------

const LOCK_FILE = join(PROJECT_ROOT, "bot.lock");

async function acquireLock(): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(LOCK_FILE, String(process.pid), { flag: "wx", mode: 0o600 });
      return true;
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const owner = await readFile(LOCK_FILE, "utf8").catch(() => "");
      const pid = Number(owner);
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      try { process.kill(pid, 0); return false; }
      catch (e: any) { if (e.code !== "ESRCH") return false; }
      if (await readFile(LOCK_FILE, "utf8").catch(() => "") === owner) await unlink(LOCK_FILE).catch(() => {});
    }
  }
  return false;
}

async function releaseLock(): Promise<void> {
  if (await readFile(LOCK_FILE, "utf8").catch(() => "") === String(process.pid))
    await unlink(LOCK_FILE).catch(() => {});
}

// Heartbeat: touch lock file every 60s to signal we're alive
const heartbeatInterval = setInterval(async () => {
  try {
    if (await readFile(LOCK_FILE, "utf8").catch(() => "") === String(process.pid))
      await writeFile(LOCK_FILE, String(process.pid), { mode: 0o600 });
  } catch {
    // Non-critical
  }
}, 60_000);

// Stale task reminders: check every 15 minutes
const staleTaskInterval = setInterval(async () => {
  try {
    // Gemeinsamer Meldeweg (Issue #227): mit Telegram samt Knoepfen wie bisher und fuer die WebUI
    // festgehalten, ohne Telegram nur in der WebUI. Aufgaben des Direktchats: Telegram-Nutzer-ID
    // (auch uebrig gebliebene nach dem Abschalten von Telegram) oder "web"
    const owners = [...new Set([ALLOWED_USER_ID, dmChatId(process.env)].filter((id): id is string => !!id))];
    if (owners.length) {
      const reminded = await checkStaleTasks(BOT_TOKEN ?? "", owners, undefined, {
        notify: (text, target) => notifyUser(text, target),
      });
      if (reminded > 0) {
        console.log(`Sent ${reminded} stale task reminder(s)`);
      }
    }
  } catch (err) {
    console.error("Stale task check error:", err);
  }
}, 15 * 60 * 1000);

// Deferred restart: data/restart-requested is honoured only while idle
// (see maybeRestart below and src/lib/restart-request.ts)
const restartCheckInterval = setInterval(() => {
  void maybeRestart("idle");
}, 30_000);

if (!(await acquireLock())) {
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 5. Graceful Shutdown
// ---------------------------------------------------------------------------

let isShuttingDown = false;
// WebUI (docs/webui), gesetzt nach dem Start des Health-Servers
let webServer: WebServer | null = null;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\nReceived ${signal}. Shutting down gracefully...`);

  abortAllEngineCalls();
  clearInterval(heartbeatInterval);
  clearInterval(staleTaskInterval);
  clearInterval(restartCheckInterval);

  try {
    telegramRuntime.stop();
  } catch {
    // Bot may not have started
  }

  // WebUI: keine neuen Turns, abgebrochene Turns speichern ihre Meldung
  // (begrenzt), dann SSE-Verbindungen und Server schliessen
  try {
    await webServer?.stop({ graceMs: 1500, abortText: SHUTDOWN_ABORT_REPLY });
  } catch (err) {
    console.error("[web] Stop fehlgeschlagen:", err instanceof Error ? err.name : typeof err);
  }

  try {
    mcpManager.shutdown(); // synchronous, returns void
  } catch {
    // MCP manager may not be initialized
  }
  try {
    await saveSessionState();
  } catch {
    // Best effort — never block lock release
  }
  await new Promise(resolve => setTimeout(resolve, 1600));
  await releaseLock(); // critical: must run so the next start isn't blocked
  try {
    await sbLog("info", "bot", `Shutdown: ${signal}`);
  } catch {
    // Logging is best effort
  }

  console.log("Shutdown complete.");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ---------------------------------------------------------------------------
// 5b. Deferred restart ("Neustart nach Antwort")
//
// A subprocess that changed the bot's code must never SIGTERM the bot itself:
// shutdown() kills every running subprocess, including the one writing the
// answer. Instead it creates data/restart-requested (bun run restart:request)
// and the bot exits once nothing is running; launchd/PM2 start it again.
// ---------------------------------------------------------------------------

// Entscheidung mit erneuter Prüfung und Annahmesperre: src/lib/restart-control.ts (Issue #190)
const restartControl = createRestartControl({
  readRequest: () => readRestartRequest(),
  clearRequest: () => clearRestartRequest(),
  // Aktive Ziel-Schleifen zählen auch zwischen ihren Turns (Issue #190)
  busyCount: () => activeEngineCallCount() + activeExecutionCount() + runningGoalLoopCount(),
  detectSupervisor: () => detectSupervisor(),
  closeIntake,
  // Gemeinsamer Weg (Issue #227): mit Telegram wie bisher, ohne nur in die WebUI
  send: async (text, chatId, topicId) => {
    await notifyUser(text, { chatId, topicId });
  },
  shutdown: reason => shutdown(reason),
  isShuttingDown: () => isShuttingDown,
});

async function maybeRestart(trigger: string, chatId?: string, topicId?: number): Promise<void> {
  await restartControl.maybeRestart(trigger, chatId, topicId);
}

/** Check shortly after a reply, once the update's execution scope has closed. */
function scheduleRestartCheck(trigger: string, chatId?: string, topicId?: number): void {
  setTimeout(() => {
    void maybeRestart(trigger, chatId, topicId);
  }, 3000).unref();
}
process.on("SIGHUP", () => shutdown("SIGHUP"));
process.on("uncaughtException", async (error) => {
  console.error("Uncaught exception:", error);
  await sbLog("error", "bot", `Uncaught exception: ${error.message}`, {
    stack: error.stack,
  });
  await shutdown("uncaughtException");
});

// ---------------------------------------------------------------------------
// 6. Security Middleware
// ---------------------------------------------------------------------------

// Alle Telegram-Handler sammeln sich hier und hängen erst beim Start am Bot
// (telegramRuntime.bot, Issue #228): ohne Telegram gibt es keinen Bot, also
// auch keine Handler. Den globalen Fehler-Handler setzt telegramRuntime
const telegramHandlers = new Composer<Context>();

telegramHandlers.use(async (ctx, next) => {
  const userId = String(ctx.from?.id || "");
  if (userId !== ALLOWED_USER_ID) {
    // Silently ignore messages from unauthorized users
    return;
  }
  await next();
});

// Freigabe-Knöpfe "toolapproval:" aus der Zeit vor dem Rückfragen-Register (Issue #116)
telegramHandlers.on("callback_query:data", legacyToolApprovalMiddleware(ALLOWED_USER_ID ?? ""));

// Rückfragen-Register (Issue #114): "ch|"-Knöpfe nach der Besitzerprüfung und
// vor dem allgemeinen Callback-Handler; der Zuhörer zieht Telegram-Nachrichten
// nach, wenn eine Frage im Browser/Terminal entschieden wird oder abläuft
// Ohne Telegram (Issue #227) halten Rückfragen nur für die WebUI fest, ohne Knöpfe in Telegram
const telegramChoices = telegramRuntime.choices;
if (telegramRuntime.telegram) installTelegramChoices(telegramHandlers, telegramChoices);

// Merk-Vorschlaege und Routine-Angebote (Issue #117): eine Entscheidung aus
// Telegram, Browser oder Terminal nimmt den Vorschlag genau einmal heraus
// (decideReview) und meldet das Ergebnis im Gespraech der Frage. Reine
// Web-Gespraeche erreicht es ueber die WebUI, sobald sie laeuft
const postReviewToWeb: PostWeb = async (conversationId, post) =>
  webServer ? webServer.postToConversation(conversationId, post) : false;
const reviewResults = createReviewResults({
  decideReview: (action, reviewId) => decideReview(action, reviewId),
  createRoutine: (session, hint, epoch) => createRoutineFromSession(session, hint, {}, epoch),
  sendAndRecord: (input) => sendAndRecord(input),
  // Web-Direktchat ohne Telegram (Issue #227): der Bericht kommt ueber saveMessage in den Verlauf
  sendTelegram: (chatId, text, topicId) => (isWebChatId(chatId) ? Promise.resolve() : sendDirectMessage(chatId, text, topicId)),
  saveMessage: (message) => saveMessage(message),
  postWeb: postReviewToWeb,
  // Kopie im Direktchat nur mit Telegram; ohne zeigt das Web-Gespraech selbst (und Push)
  dmChatId: () => (telegramConfigured(process.env) ? ALLOWED_USER_ID || undefined : undefined),
});
onChoiceDecided("review", reviewResults.handler);

// /goal "Weiter?" (Issue #118): Budget-Frage als Rückfrage mit goalId; der
// Handler wirkt nur auf das Ziel der Frage, die Karte im Browser entscheidet
// eine offene Frage zuerst im Register, jede andere Änderung am Ziel lässt sie ablaufen
const goalChoices = createGoalChoices({
  getGoal,
  abort: abortEngineCalls,
  sendChoice: (choice) => telegramChoices.sendChoice(choice),
});
onChoiceDecided("goal", goalChoices.handler);
onGoalChange(goalChoices.listener);

// Topic-Zuordnung "Welcher Agent?" (Issue #119): Rückfrage mit einer Option
// je aktivem Agenten; der Handler schreibt nur, solange das Topic noch keinen
// Agenten hat. Jede geschriebene Zuordnung lässt offene Fragen des Topics
// ablaufen und meldet die Änderung an die WebUI (Kopfzeilen-Chip)
const topicChoices = createTopicChoices({
  sendChoice: (choice) => telegramChoices.sendChoice(choice),
  notify: (input) => sendAndRecord(input),
  topicChanged: (change) => topicChanges.emit(change),
});
onChoiceDecided("topicmap", topicChoices.handler);
onTopicMappingSet(topicChoices.listener);

// Werkzeug-Freigaben (Issue #116): eine Rückfrage im Gespräch des Turns, in
// Telegram per sendChoice, im Browser/Terminal über den laufenden Turn
// (approvalTurns, unten an Web- und Telegram-Chat der WebUI gegeben)
const approvalTurns = createApprovalTurns();
const toolApproval = createChoiceToolApproval({
  sendChoice: (choice) => telegramChoices.sendChoice(choice),
  presenter: (key) => approvalTurns.presenter(key),
});
setToolApprovalHandler(toolApproval.handler);
// Offene Freigaben eines früheren Laufs: auf sie wartet nichts mehr
void expireOrphanedToolChoices()
  .then(n => { if (n) console.log(`[freigabe] ${n} offene Freigaben aus dem letzten Lauf abgelaufen`); })
  .catch(e => console.error(`[freigabe] Aufräumen beim Start gescheitert (${e instanceof Error ? e.name : "Fehler"})`));

// ---------------------------------------------------------------------------
// 7. Message Handlers
// ---------------------------------------------------------------------------

// --- Topic angelegt oder umbenannt (Issue #32) ---
// Service-Nachrichten ohne Text: Name merken und offene WebUI-Browser
// benachrichtigen, nur fuer die Forum-Gruppe der WebUI. Fehler loggt
// handleTopicServiceMessage selbst.
telegramHandlers.on(["message:forum_topic_created", "message:forum_topic_edited"], (ctx) => {
  void handleTopicServiceMessage(
    {
      groupId: () => botGroupId(process.env),
      store: { recordTopicName, recordTopicNameIfMissing },
      notify: topicChanges.emit,
    },
    String(ctx.chat?.id ?? ""),
    ctx.message
  );
});

// --- Text Messages ---

telegramHandlers.on("message:text", (ctx) => {
  // Fire-and-forget: don't block Grammy's update loop
  handleUpdateScope(ctx, () => handleTextMessage(ctx)).catch((err) => {
    console.error("Text handler error:", err);
  });
});

/**
 * Zitat aus der Telegram-Reply-Funktion extrahieren. In Forum-Topics haengt
 * an jeder Nachricht technisch ein reply_to_message auf die Topic-Service-
 * Nachricht, die traegt keinen Text und wird hier uebersprungen.
 */
function quotedReplyText(msg: any): { text: string; fromBot: boolean } | undefined {
  const replied = msg?.reply_to_message;
  if (!replied || replied.forum_topic_created) return undefined;
  const raw: string | undefined = replied.text || replied.caption;
  if (!raw) return undefined;
  const text = raw.length > 3000 ? `${raw.slice(0, 3000)}\n[... gekuerzt]` : raw;
  return { text, fromBot: Boolean(replied.from?.is_bot) };
}

async function handleTextMessage(ctx: Context): Promise<void> {
  const text = ctx.message?.text?.trim();
  if (!text) return;

  const chatId = String(ctx.chat?.id || "");
  const topicId = (ctx.message as any)?.message_thread_id as number | undefined;
  const lowerText = text.toLowerCase();

  // Passively capture the topic's name. The creation name riding along in
  // reply_to_message only fills gaps; it is stale after a rename.
  if (topicId !== undefined) {
    void captureTopicName({ recordTopicName, recordTopicNameIfMissing }, topicId, ctx.message);
  }

  // Telegram-Reply: zitierte Nachricht festhalten, damit die Session weiss,
  // worauf sich der User bezieht, auch wenn die zitierte Nachricht aus einem
  // anderen Prozess kam und nie im eigenen Session-Transkript stand.
  const quotedReply = quotedReplyText(ctx.message);

  // Persist user message
  await saveMessage({
    chat_id: chatId,
    role: "user",
    content: text,
    metadata: {
      topicId,
      messageId: ctx.message?.message_id,
      replyTo: quotedReply ? quotedReply.text.slice(0, 300) : undefined,
    },
  });

  // ----- Memory Commands -----

  // remember: <fact>
  if (lowerText.startsWith("remember:")) {
    const fact = text.slice("remember:".length).trim();
    if (fact) {
      const success = await addFact(fact);
      const reply = success ? `Noted. I'll remember that.` : `Failed to save that. Try again?`;
      await ctx.reply(reply);
      return;
    }
  }

  // track: <goal> [| deadline: <deadline>]
  if (lowerText.startsWith("track:")) {
    const raw = text.slice("track:".length).trim();
    const deadlineMatch = raw.match(/\|\s*deadline:\s*(.+)$/i);
    const goalText = deadlineMatch ? raw.slice(0, deadlineMatch.index).trim() : raw;
    const deadline = deadlineMatch ? deadlineMatch[1].trim() : undefined;

    if (goalText) {
      const success = await addGoal(goalText, deadline);
      const deadlineNote = deadline ? ` (deadline: ${deadline})` : "";
      const reply = success
        ? `Goal tracked: "${goalText}"${deadlineNote}`
        : `Failed to track that goal.`;
      await ctx.reply(reply);
      return;
    }
  }

  // done: <partial goal match>
  if (lowerText.startsWith("done:")) {
    const search = text.slice("done:".length).trim();
    if (search) {
      const success = await completeGoal(search);
      const reply = success
        ? `Goal completed! Nice work.`
        : `Couldn't find an active goal matching "${search}".`;
      await ctx.reply(reply);
      return;
    }
  }

  // forget: <partial fact match>
  if (lowerText.startsWith("forget:")) {
    const search = text.slice("forget:".length).trim();
    if (search) {
      const success = await deleteFact(search);
      const reply = success
        ? `Done. I've forgotten that.`
        : `Couldn't find a stored fact matching "${search}".`;
      await ctx.reply(reply);
      return;
    }
  }

  // cancel: <partial goal match>
  if (lowerText.startsWith("cancel:")) {
    const search = text.slice("cancel:".length).trim();
    if (search) {
      const success = await cancelGoal(search);
      const reply = success
        ? `Goal cancelled and removed.`
        : `Couldn't find an active goal matching "${search}".`;
      await ctx.reply(reply);
      return;
    }
  }

  // ----- Gemeinsame Befehls-Schicht (Issue #74): /goal, /goals, /topics, /new,
  // /routine, /plan, /help, /stop, /agent, /learn, /critic, /board, /voice; dieselben
  // Befehle gehen im Browser und im Terminal (src/lib/commands) -----

  const command = commandRegistry.match(text, "telegram");
  if (command) {
    await runTelegramCommand(telegramCommandInput(ctx, chatId, topicId, text, command));
    return;
  }

  // memory / facts
  if (lowerText === "memory" || lowerText === "facts" || lowerText === "/memory") {
    const facts = await listFacts();
    await ctx.reply(markdownToTelegramHTML(`**Stored Facts:**\n${facts}`), { parse_mode: "HTML" }).catch(() =>
      ctx.reply(`Stored Facts:\n${facts}`)
    );
    return;
  }

  // /tasks — show active async tasks
  if (lowerText === "/tasks" || lowerText === "tasks") {
    const status = await formatTaskStatus(chatId);
    await ctx.reply(markdownToTelegramHTML(status), { parse_mode: "HTML" }).catch(() => ctx.reply(status));
    return;
  }

  // /credit — Agent SDK credit usage this billing cycle (self-metered)
  if (lowerText === "/credit" || lowerText === "credit") {
    const status = await creditGuard.formatStatus();
    await ctx.reply(markdownToTelegramHTML(status), { parse_mode: "HTML" }).catch(() => ctx.reply(status));
    return;
  }

  // ----- Semantic Search -----

  if (
    lowerText.startsWith("recall ") ||
    lowerText.startsWith("search ") ||
    lowerText.startsWith("find ")
  ) {
    const query = text.split(/\s+/).slice(1).join(" ");
    if (query) {
      const typing = createTypingIndicator(ctx);
      typing.start();
      try {
        const results = await searchMessages(chatId, query, 5);
        if (results.length === 0) {
          await ctx.reply(`No results found for "${query}".`);
        } else {
          const formatted = results
            .map((msg, i) => {
              const time = msg.created_at
                ? new Date(msg.created_at).toLocaleDateString()
                : "unknown";
              const speaker = msg.role === "user" ? "User" : "Bot";
              // Gespeicherte Bot-Antworten: vor dem Kürzen bereinigt (Issue #52)
              const content = sanitizeModelOutput(msg.content);
              const snippet = content.length > 200
                ? content.substring(0, 200) + "..."
                : content;
              return `${i + 1}. [${time}] ${speaker}: ${snippet}`;
            })
            .join("\n\n");
          await ctx.reply(markdownToTelegramHTML(`**Search results for "${query}":**\n\n${formatted}`), {
            parse_mode: "HTML",
          }).catch(() => ctx.reply(`Search results for "${query}":\n\n${formatted}`));
        }
      } finally {
        typing.stop();
      }
      return;
    }
  }

  // ----- Phone Call -----

  if (lowerText.includes("call me") && isCallEnabled()) {
    const context = text.replace(/call me/i, "").trim();
    const profile = await getUserProfile();
    const userName = extractUserName(profile);
    await ctx.reply("Initiating call...");
    const result = await initiatePhoneCall(context, userName);

    if (result.success) {
      await ctx.reply(`Call started! ${result.message}`);

      // Wait for transcript in the background
      if (result.conversationId) {
        waitForTranscript(result.conversationId).then(async (transcript) => {
          if (transcript) {
            // Summarize and save transcript
            const summary = await summarizeTranscript(transcript);
            await saveMessage({
              chat_id: chatId,
              role: "assistant",
              content: `[Phone call transcript]\n${transcript}\n\n[Summary]\n${summary}`,
              metadata: { type: "call_transcript", conversationId: result.conversationId },
            });
            await ctx.reply(markdownToTelegramHTML(`**Call Summary**\n\n${summary}`), { parse_mode: "HTML" })
              .catch(() => ctx.reply(`Call Summary\n\n${summary}`));

            // Extract and auto-execute any tasks from the call
            try {
              const task = await extractTaskFromTranscript(transcript, summary);
              if (task) {
                console.log(`Task detected from call: "${task.length} chars"`);
                await ctx.reply(`<b>Starting task from call:</b>\n${task}`, { parse_mode: "HTML" })
                  .catch(() => ctx.reply(`Starting task from call:\n${task}`));

                // Use the full callClaudeAndReply flow (handles streaming, intents, HITL)
                await callClaudeAndReply(ctx, chatId, task, "general", topicId);
              }
            } catch (taskErr) {
              console.error("Call task extraction/execution failed:", taskErr);
            }
          }
        }).catch((err) => {
          console.error("Transcript polling failed:", err);
        });
      }
    } else {
      await ctx.reply(`Could not start call: ${result.message}`);
    }
    return;
  }

  // ----- Default: Claude Processing -----

  // Bei Telegram-Replies den zitierten Text vor den Prompt setzen. Ohne das
  // sieht die Session nur die Antwort, nicht den Bezug.
  const withQuote = (prompt: string): string =>
    quotedReply
      ? `[Der User antwortet per Telegram-Reply auf diese Nachricht von ${quotedReply.fromBot ? "dir (dem Bot)" : "sich selbst"}:]\n"""\n${quotedReply.text}\n"""\n\n${prompt}`
      : prompt;

  // Mention-Routing: @agentbot in einer
  // Nachricht holt diesen Agenten ins Topic — er antwortet statt des
  // Topic-Agenten, unter seiner eigenen Bot-Identitaet. Geloeschte Agenten
  // (Issue #49) werden nicht mehr geholt, auch wenn ihr Bot-Token noch gilt.
  const mention = botRegistry.agentForMention(text);
  if (mention && isActiveAgent(mention.agent)) {
    await callClaudeAndReply(ctx, chatId, withQuote(mention.cleanedText), mention.agent, topicId);
    return;
  }

  // Unmapped topic → ask once which agent owns it (answer via inline button
  // writes config/topics.json; until then "general" handles the topic).
  if (
    topicId !== undefined &&
    !getAgentByTopicId(topicId, chatId) &&
    (await claimTopicMappingQuestion(chatId, topicId))
  ) {
    // Über das Rückfragen-Register (Issue #119), damit auch der Browser die
    // Frage zeigt; klappt das nicht, wie früher mit topicmap:-Knöpfen
    // (höchstens 100 je Nachricht, der Rest in Folge-Nachrichten)
    if (!(await topicChoices.ask(chatId, topicId))) {
      const pages = legacyButtonPages(topicId, listAgentNames());
      for (const [i, keyboard] of pages.entries()) {
        await ctx
          .reply(i === 0 ? TOPIC_MAP_TEXT.question(topicId) : TOPIC_MAP_TEXT.legacyMore(i + 1, pages.length), {
            reply_markup: { inline_keyboard: keyboard },
            message_thread_id: topicId,
          } as any)
          .catch(() => {});
      }
    }
  }

  // Determine agent from topic (if forum mode)
  const agentName = topicId ? getAgentByTopicId(topicId, chatId) || "general" : "general";
  await callClaudeAndReply(ctx, chatId, withQuote(text), agentName, topicId);
}

// --- Voice Messages ---

telegramHandlers.on("message:voice", (ctx) => {
  handleUpdateScope(ctx, () => handleVoiceMessage(ctx)).catch((err) => {
    console.error("Voice handler error:", err);
  });
});

async function handleVoiceMessage(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id || "");
  // Vor dem ersten saveMessage: beide Nachrichten landen im richtigen Topic-Verlauf (Issue #20)
  const topicId = (ctx.message as any)?.message_thread_id as number | undefined;
  const typing = createTypingIndicator(ctx);
  typing.start();

  try {
    // Download voice file
    const file = await ctx.getFile();
    const filePath = file.file_path;
    if (!filePath) {
      await ctx.reply("Could not download voice message.");
      return;
    }

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());

    // Ablegen und transkribieren (Medien-Kern, Issue #71)
    const prepared = await prepareMedia({ kind: "audio", bytes: buffer, ext: "ogg", chatId, topicId, source: { channel: "telegram" } });

    // Persist user message (transcribed)
    await saveMessage({
      chat_id: chatId,
      role: "user",
      content: prepared.userContent,
      metadata: prepared.userMetadata,
    });

    // Process with Claude (uses same complexity-aware routing as text messages)
    const agentName = topicId ? getAgentByTopicId(topicId, chatId) || "general" : "general";

    const tier = classifyComplexity(prepared.classifyText);
    let claudeResponse: string;
    const turn = turnInfoCollector();

    if (tier !== "haiku") {
      // Complex task → streaming subprocess with live progress
      claudeResponse = await callClaudeWithProgress(ctx, prepared.prompt, chatId, agentName, topicId, turn.onInfo, turn.onTools);
    } else {
      // Simple task → standard subprocess (fast, no progress needed)
      claudeResponse = await callClaude(prepared.prompt, chatId, agentName, topicId, turn.onInfo, turn.onTools);
    }
    claudeResponse = finishMedia(prepared, claudeResponse);

    // Persist bot response
    await saveMessage({
      chat_id: chatId,
      role: "assistant",
      content: claudeResponse,
      metadata: { ...prepared.replyMetadata, agent: agentName, ...turn.metadata() },
    });

    // Process intents
    await processTurnIntents(claudeResponse, turn.tools(), { chatId, topicId, origin: "Telegram", foreignInput: prepared.foreignInput });

    // Always reply with text to voice messages (user preference).
    // Voice replies only when explicitly requested via /voice command.
    await sendResponse(ctx, claudeResponse);

    // Cleanup temp file
    await cleanupMedia(prepared);
  } catch (error) {
    console.error("Voice processing error:", error);
    await ctx.reply("Sorry, I couldn't process that voice message. Please try again.");
  } finally {
    typing.stop();
  }
}

// --- Photo Messages ---

telegramHandlers.on("message:photo", (ctx) => {
  handleUpdateScope(ctx, () => handlePhotoMessage(ctx)).catch((err) => {
    console.error("Photo handler error:", err);
  });
});

async function handlePhotoMessage(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id || "");
  // Vor dem ersten saveMessage: beide Nachrichten landen im richtigen Topic-Verlauf (Issue #20)
  const topicId = (ctx.message as any)?.message_thread_id as number | undefined;
  const typing = createTypingIndicator(ctx);
  typing.start();

  try {
    // Get highest resolution photo
    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) {
      await ctx.reply("Could not process photo.");
      return;
    }

    const largest = photos[photos.length - 1];
    const file = await ctx.api.getFile(largest.file_id);
    const filePath = file.file_path;
    if (!filePath) {
      await ctx.reply("Could not download photo.");
      return;
    }

    // Download photo locally (Claude Code reads from filesystem)
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());

    // Ablegen und in den Asset-Speicher mit Platzhalter (Medien-Kern, Issue #71)
    const prepared = await prepareMedia({
      kind: "image",
      bytes: buffer,
      ext: filePath.split(".").pop() || "jpg",
      chatId,
      topicId,
      caption: ctx.message?.caption,
      source: { channel: "telegram", telegramFileId: largest.file_id },
    });

    // Persist user message
    await saveMessage({
      chat_id: chatId,
      role: "user",
      content: prepared.userContent,
      metadata: prepared.userMetadata,
    });

    // Process with Claude (uses same complexity-aware routing as text messages)
    const agentName = topicId ? getAgentByTopicId(topicId, chatId) || "general" : "general";

    const tier = classifyComplexity(prepared.classifyText);
    let claudeResponse: string;
    const turn = turnInfoCollector();

    if (tier !== "haiku") {
      // Complex task → streaming subprocess with live progress
      claudeResponse = await callClaudeWithProgress(ctx, prepared.prompt, chatId, agentName, topicId, turn.onInfo, turn.onTools);
    } else {
      // Simple task → standard subprocess (fast, no progress needed)
      claudeResponse = await callClaude(prepared.prompt, chatId, agentName, topicId, turn.onInfo, turn.onTools);
    }

    // Beschreibung aus [ASSET_DESC] nachtragen, Tag vor dem Senden entfernen
    const cleanResponse = finishMedia(prepared, claudeResponse);

    // Persist bot response
    await saveMessage({
      chat_id: chatId,
      role: "assistant",
      content: cleanResponse,
      metadata: { ...prepared.replyMetadata, agent: agentName, ...turn.metadata() },
    });

    await processTurnIntents(cleanResponse, turn.tools(), { chatId, topicId, origin: "Telegram", foreignInput: prepared.foreignInput });
    await sendResponse(ctx, cleanResponse);
    await cleanupMedia(prepared);
  } catch (error) {
    console.error("Photo processing error:", error);
    await ctx.reply("Sorry, I couldn't process that image. Please try again.");
  } finally {
    typing.stop();
  }
}

// --- Document Messages ---

telegramHandlers.on("message:document", (ctx) => {
  handleUpdateScope(ctx, () => handleDocumentMessage(ctx)).catch((err) => {
    console.error("Document handler error:", err);
  });
});

async function handleDocumentMessage(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id || "");
  // Vor dem ersten saveMessage: beide Nachrichten landen im richtigen Topic-Verlauf (Issue #20)
  const topicId = (ctx.message as any)?.message_thread_id as number | undefined;
  const typing = createTypingIndicator(ctx);
  typing.start();

  try {
    const doc = ctx.message?.document;
    if (!doc) {
      await ctx.reply("Could not process document.");
      return;
    }

    const file = await ctx.api.getFile(doc.file_id);
    const filePath = file.file_path;
    if (!filePath) {
      await ctx.reply("Could not download document.");
      return;
    }

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());

    // Jede Dateiart bleibt ein Dokument, auch als Dokument gesendete Bilder (Issue #71)
    const prepared = await prepareMedia({
      kind: "document",
      bytes: buffer,
      ext: doc.file_name?.match(/\.([a-zA-Z0-9]{1,10})$/)?.[1] || "",
      chatId,
      topicId,
      caption: ctx.message?.caption,
      fileName: doc.file_name,
      source: { channel: "telegram", telegramFileId: doc.file_id },
    });

    // Persist user message
    await saveMessage({
      chat_id: chatId,
      role: "user",
      content: prepared.userContent,
      metadata: prepared.userMetadata,
    });

    // Process with Claude (uses same complexity-aware routing as text messages)
    const agentName = topicId ? getAgentByTopicId(topicId, chatId) || "general" : "general";

    const tier = classifyComplexity(prepared.classifyText);
    let claudeResponse: string;
    const turn = turnInfoCollector();

    if (tier !== "haiku") {
      claudeResponse = await callClaudeWithProgress(ctx, prepared.prompt, chatId, agentName, topicId, turn.onInfo, turn.onTools);
    } else {
      claudeResponse = await callClaude(prepared.prompt, chatId, agentName, topicId, turn.onInfo, turn.onTools);
    }
    claudeResponse = finishMedia(prepared, claudeResponse);

    // Persist bot response
    await saveMessage({
      chat_id: chatId,
      role: "assistant",
      content: claudeResponse,
      metadata: { ...prepared.replyMetadata, agent: agentName, ...turn.metadata() },
    });

    await processTurnIntents(claudeResponse, turn.tools(), { chatId, topicId, origin: "Telegram", foreignInput: prepared.foreignInput });
    await sendResponse(ctx, claudeResponse);
    await cleanupMedia(prepared);
  } catch (error) {
    console.error("Document processing error:", error);
    await ctx.reply("Sorry, I couldn't process that document. Please try again.");
  } finally {
    typing.stop();
  }
}

// --- Video Messages ---

telegramHandlers.on(["message:video", "message:video_note"], (ctx) => {
  handleUpdateScope(ctx, () => handleVideoMessage(ctx)).catch((err) => {
    console.error("Video handler error:", err);
  });
});

async function handleVideoMessage(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id || "");
  // Vor dem ersten saveMessage: beide Nachrichten landen im richtigen Topic-Verlauf (Issue #20)
  const topicId = (ctx.message as any)?.message_thread_id as number | undefined;
  const typing = createTypingIndicator(ctx);
  typing.start();

  try {
    const video = ctx.message?.video || ctx.message?.video_note;
    if (!video) {
      await ctx.reply("Could not process video.");
      return;
    }

    // Bot API getFile is hard-capped at 20 MB
    const MAX_BOT_FILE_SIZE = 20 * 1024 * 1024;
    if (video.file_size && video.file_size > MAX_BOT_FILE_SIZE) {
      const sizeMb = (video.file_size / 1024 / 1024).toFixed(1);
      await ctx.reply(
        `Das Video ist ${sizeMb} MB gross — Telegram-Bots koennen nur Dateien bis 20 MB herunterladen. ` +
          `Schick es komprimiert (unter 20 MB) oder als Link (YouTube, Drive, etc.).`
      );
      return;
    }

    const file = await ctx.api.getFile(video.file_id);
    const filePath = file.file_path;
    if (!filePath) {
      await ctx.reply("Could not download video.");
      return;
    }

    const uploadsDir = join(PROJECT_ROOT, "uploads");
    await mkdir(uploadsDir, { recursive: true });

    const ext = filePath.split(".").pop() || "mp4";
    const fileName = (ctx.message?.video as any)?.file_name || `video_${Date.now()}.${ext}`;
    const localPath = join(uploadsDir, uploadName("video", Date.now(), crypto.randomUUID(), `.${ext}`));
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(localPath, buffer);

    const caption = ctx.message?.caption || "User sent a video. Analyze it and respond.";

    // Persist user message
    await saveMessage({
      chat_id: chatId,
      role: "user",
      content: `[Video: ${fileName}] ${caption}`,
      metadata: { topicId, type: "video", filePath: localPath, fileName },
    });

    // Process with Claude (uses same complexity-aware routing as text messages)
    const agentName = topicId ? getAgentByTopicId(topicId, chatId) || "general" : "general";

    const duration = video.duration ? `, duration: ${video.duration}s` : "";
    const videoPrompt = `[User sent a video saved at: ${localPath}${duration}. Use the watch skill (local path) or ffmpeg frame extraction to analyze it.]\n\n${caption}`;
    const tier = classifyComplexity(caption);
    let claudeResponse: string;
    const turn = turnInfoCollector();

    if (tier !== "haiku") {
      claudeResponse = await callClaudeWithProgress(ctx, videoPrompt, chatId, agentName, topicId, turn.onInfo, turn.onTools);
    } else {
      claudeResponse = await callClaude(videoPrompt, chatId, agentName, topicId, turn.onInfo, turn.onTools);
    }

    // Persist bot response
    await saveMessage({
      chat_id: chatId,
      role: "assistant",
      content: claudeResponse,
      metadata: { topicId, type: "video_reply", agent: agentName, ...turn.metadata() },
    });

    await processTurnIntents(claudeResponse, turn.tools(), { chatId, topicId, origin: "Telegram", foreignInput: "Video" });
    await sendResponse(ctx, claudeResponse);
  } catch (error) {
    console.error("Video processing error:", error);
    await ctx.reply("Sorry, I couldn't process that video. Please try again.");
  } finally {
    typing.stop();
  }
}

// --- Callback Queries (Human-in-the-Loop Buttons) ---

telegramHandlers.on("callback_query:data", (ctx) => {
  handleUpdateScope(ctx, () => handleCallbackQuery(ctx)).catch((err) => {
    console.error("Callback query error:", err);
  });
});

async function handleCallbackQuery(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  // Acknowledge the button press immediately
  await ctx.answerCallbackQuery().catch(() => {});

  // ---- Topic→Agent mapping (one-time setup ask) ----

  // Knöpfe aus der Zeit vor dem Rückfragen-Register (Issue #119): wirken wie
  // bisher; die geschriebene Zuordnung lässt eine offene Rückfrage ablaufen
  if (data.startsWith("topicmap:")) {
    const [, topicIdStr, agent] = data.split(":");
    const text = await topicChoices.legacy(String(ctx.chat?.id || ""), topicIdStr ?? "", agent ?? "");
    await ctx.editMessageText(text).catch(() => {});
    return;
  }

  // ---- Check-in button handlers ----

  if (data === "call_yes") {
    await ctx.editMessageText("📞 Calling you now...").catch(() => {});
    try {
      const { initiatePhoneCall } = await import("./lib/voice");
      const originalText = (ctx.callbackQuery.message as any)?.text || "";
      const context = originalText.replace(/^.*?about:\n\n/s, "").trim();
      await initiatePhoneCall(context || "Check-in call");
    } catch (err: any) {
      await ctx.editMessageText("Failed to initiate call: " + err.message).catch(() => {});
    }
    return;
  }

  if (data === "call_no" || data === "dismiss") {
    await ctx.editMessageText("✓").catch(() => {});
    return;
  }

  if (data === "snooze") {
    await ctx.editMessageText("😴 Snoozed for 30 minutes").catch(() => {});
    return;
  }

  if (data === "call_request") {
    await ctx.editMessageText("📞 Calling you now...").catch(() => {});
    try {
      const { initiatePhoneCall } = await import("./lib/voice");
      await initiatePhoneCall("You requested a call from the check-in");
    } catch (err: any) {
      await ctx.editMessageText("Failed to initiate call: " + err.message).catch(() => {});
    }
    return;
  }

  // ---- Goal: alte Weiter?-Buttons goalkb| von vor Issue #118 (neue laufen als "ch|" ueber das Register) ----

  const goalReply = await handleGoalCallback(data, { abort: abortEngineCalls });
  if (goalReply !== null) {
    if (goalReply) await ctx.editMessageText(goalReply).catch(() => {});
    return;
  }

  // ---- Session-Review: gestagte Memory-Vorschlaege + Routine-Angebot ----

  if (data.startsWith("rev|")) {
    const [, action = "", reviewId = ""] = data.split("|");
    // Knoepfe von vor Issue #117: mit Rueckfrage entscheidet das Register
    // zuerst, ohne wendet decideReview an (7-Tage-Grenze); das Ergebnis kommt
    // als eigene Nachricht, die geklickte Nachricht bekommt nur den Stand
    const { text } = await reviewResults.legacy(action, reviewId);
    if (text) await ctx.editMessageText(text).catch(() => {});
    return;
  }

  if (!data.startsWith("atask:")) return;

  const result = await handleTaskCallback(data);
  if (!result) {
    await ctx.editMessageText("Task not found or expired.").catch(() => {});
    return;
  }

  if (result.cancelled) {
    await ctx.editMessageText("Task cancelled.").catch(() => {});
    return;
  }

  const chatId = String(ctx.chat?.id || "");
  const task = result.task!;

  // Edit the button message to show the user's choice
  await ctx
    .editMessageText(
      `${task.pending_question || "Question"}\n\n✅ You chose: ${result.choice}`
    )
    .catch(() => {});

  // --- Agent SDK resume: task has session_id from Agent SDK ---
  if (task.metadata?.use_agent_sdk && task.metadata?.agent_sdk_session_id) {
    const typing = createTypingIndicator(ctx);
    typing.start();

    try {
      const agentResume: AgentResumeState = {
        taskId: result.taskId,
        sessionId: task.metadata.agent_sdk_session_id,
        userChoice: result.choice,
        originalPrompt: task.original_prompt,
      };

      const response = await processWithAgentSDK(
        task.original_prompt,
        chatId,
        ctx,
        agentResume
      );

      if (response) {
        // Mit dem Topic der Rueckfrage speichern (Issue #189)
        const record = taskResumeRecord(task, chatId, {
          taskId: result.taskId,
          response,
          kind: "agent_sdk_resume",
          origin: "Telegram (Agent SDK)",
        });
        await saveMessage(record.message);
        await processTurnIntents(response, undefined, record.intents);
        await sendResponse(ctx, response);
      }

      await updateTask(result.taskId, {
        status: "completed",
        result: response ? response.substring(0, 10000) : "Continued in new task",
      });
    } catch (err) {
      console.error("Agent SDK resume error:", err);
      // Try fallback before giving up
      try {
        const fallbackResponse = await callFallbackLLM(task.original_prompt);
        await sendResponse(ctx, fallbackResponse);
      } catch {
        await ctx.reply("Error resuming task. Please try again.");
      }
      await updateTask(result.taskId, { status: "failed", result: String(err) });
    } finally {
      typing.stop();
    }
    return;
  }

  // --- VPS mode resume: task has messages_snapshot from Anthropic API ---
  if (task.metadata?.messages_snapshot) {
    const typing = createTypingIndicator(ctx);
    typing.start();

    try {
      const resumeState: ResumeState = {
        taskId: result.taskId,
        messagesSnapshot: task.metadata.messages_snapshot,
        assistantContent: task.metadata.assistant_content,
        userChoice: result.choice,
        toolUseId: task.metadata.tool_use_id,
      };

      const response = await processWithAnthropic(
        task.original_prompt,
        chatId,
        ctx,
        resumeState
      );

      // processWithAnthropic returns "" if another ask_user was triggered (new task created)
      if (response) {
        const record = taskResumeRecord(task, chatId, {
          taskId: result.taskId,
          response,
          kind: "task_resume",
          origin: "Telegram (Anthropic API)",
        });
        await saveMessage(record.message);
        await processTurnIntents(response, undefined, record.intents);
        await sendResponse(ctx, response);
      }

      // Mark the original task as completed (new task was created if another ask_user fired)
      await updateTask(result.taskId, {
        status: "completed",
        result: response ? response.substring(0, 10000) : "Continued in new task",
      });
    } catch (err) {
      console.error("VPS resume error:", err);
      // Try fallback before giving up
      try {
        const fallbackResponse = await callFallbackLLM(task.original_prompt);
        await sendResponse(ctx, fallbackResponse);
      } catch {
        await ctx.reply("Error resuming task. Please try again.");
      }
      await updateTask(result.taskId, { status: "failed", result: String(err) });
    } finally {
      typing.stop();
    }
    return;
  }

  // --- Mac mode resume: continue the Claude Code session ---
  // Session mode (docs/topic-sessions.md F-1): the question was asked inside the
  // topic's session, so the button answer resumes that session and counts as
  // a turn. Issue #189: runs under the same session lock, model, effort and
  // tools as a normal turn (src/lib/task-resume.ts); /stop works while waiting.
  const typing = createTypingIndicator(ctx);
  typing.start();
  try {
    const outcome = await resumeMacTask(task, chatId, result.choice);
    if (outcome.status === "aborted") {
      await ctx.reply(isShuttingDown ? SHUTDOWN_ABORT_REPLY : ABORT_REPLY).catch(() => {});
      await updateTask(result.taskId, { status: "failed", result: "Abgebrochen" });
      return;
    }
    if (outcome.status === "done") {
      const claudeResult = outcome.result;
      const response = claudeResult.text || "Task completed.";
      const record = taskResumeRecord(task, chatId, {
        taskId: result.taskId,
        response,
        kind: "task_resume",
        origin: "Telegram",
        agent: outcome.agent,
      });
      await saveMessage(record.message);
      await processTurnIntents(response, claudeResult.tools, record.intents);

      // Check if the resumed response also contains questions
      const parsed = parseClaudeResponse(response);
      if (parsed.needsInput && parsed.options.length > 0) {
        await updateTask(result.taskId, {
          status: "needs_input",
          session_id: claudeResult.sessionId || outcome.resumeId,
          // Folgefrage bleibt beim Motor und Modell der Rueckfrage (Issue #122)
          metadata: { ...(task.metadata ?? {}), engine: outcome.engine, model: outcome.model },
          pending_question: parsed.question || undefined,
          pending_options: parsed.options,
          current_step: parsed.text.substring(0, 500),
        });
        const keyboard = buildTaskKeyboard(result.taskId, parsed.options);
        await ctx
          .reply(markdownToTelegramHTML(response), { reply_markup: keyboard, parse_mode: "HTML" })
          .catch(() => ctx.reply(response, { reply_markup: keyboard }));
      } else {
        await updateTask(result.taskId, {
          status: "completed",
          result: response.substring(0, 10000),
        });
        await sendResponse(ctx, response);
      }
      return;
    }
  } catch (err) {
    console.error("Mac resume error:", err);
    await ctx.reply("Error resuming task. Please try again.");
    await updateTask(result.taskId, { status: "failed", result: String(err) });
    return;
  } finally {
    typing.stop();
  }

  // --- No resume context: just acknowledge ---
  await ctx.reply(`Noted: ${result.choice}. Task marked complete.`);
  await updateTask(result.taskId, { status: "completed" });
}

// ---------------------------------------------------------------------------
// 8. callClaude() - Core AI Processing
// ---------------------------------------------------------------------------

/**
 * Call Claude Code subprocess with agent config, memory, and conversation context.
 * Claude Code has access to all configured MCP servers (Calendar, Gmail, Notion, etc.)
 * Falls back to secondary LLMs on error.
 */
/** Sink for the JSON path: no progress message, only the long-run notices. */
function createTelegramNoticeSink(agentName: string, chatId: string, topicId?: number): TurnSink {
  return {
    progress() {},
    notice: (text) =>
      botRegistry.sendAsAgent(agentName, chatId, text, { threadId: topicId }).then(() => {}),
  };
}

async function callClaudeUnlocked(
  userMessage: string,
  chatId: string,
  agentName: string = "general",
  topicId?: number,
  onInfo?: (info: TurnInfo) => void,
  onTools?: (tools: TurnTools | undefined) => void,
  onSessionId?: SessionIdListener,
  onSessionMeta?: SessionMetaListener
): Promise<string> {
  return runJsonTurn({
    userMessage,
    chatId,
    agentName,
    topicId,
    sink: createTelegramNoticeSink(agentName, chatId, topicId),
    onSessionId: trackSessionId(onSessionId),
    onSessionMeta,
    onInfo,
    onTools,
  });
}

/**
 * Letzte Session irgendeines Turns samt Motor, nur noch fuer Status und
 * Anzeige (Issues #189, #122); Rueckfragen merken sich Motor und Modell am Task
 */
async function rememberLastSessionId(id: string, engine: EngineId): Promise<void> {
  sessionState.sessionId = id;
  sessionState.engine = engine;
  await saveSessionState();
}

/** Meldet die Session-ID mit Motor und Modell dem Turn (Rueckfrage) und dem globalen Stand */
function trackSessionId(onSessionId?: SessionIdListener) {
  return async (id: string, meta: TurnSessionMeta) => {
    onSessionId?.(id, meta);
    await rememberLastSessionId(id, meta.engine);
  };
}

/**
 * Full flow: call Claude, persist response, process intents, send reply.
 * Uses streaming subprocess for sonnet/opus tier (live progress updates).
 * Uses standard subprocess for haiku tier (fast, no progress needed).
 */
async function callClaudeAndReply(
  ctx: Context,
  chatId: string,
  userMessage: string,
  agentName: string,
  topicId?: number
): Promise<void> {
  const typing = createTypingIndicator(ctx);
  typing.start();

  try {
    const tier = classifyComplexity(userMessage);
    let response: string;
    const turn = turnInfoCollector();

    if (tier !== "haiku") {
      // Complex task → streaming subprocess with live progress
      response = await callClaudeWithProgress(ctx, userMessage, chatId, agentName, topicId, turn.onInfo, turn.onTools, turn.onSessionId, turn.onSessionMeta);
    } else {
      // Simple task → standard subprocess (fast, no progress needed)
      response = await callClaude(userMessage, chatId, agentName, topicId, turn.onInfo, turn.onTools, turn.onSessionId, turn.onSessionMeta);
    }

    // Vom User per /stop abgebrochen — nichts persistieren, kein Fallback.
    // Kam der Kill von shutdown() (SIGTERM/Neustart), ehrlich sagen, dass die
    // Antwort verloren ging, statt einen User-Abbruch vorzutaeuschen.
    if (response === ABORT_REPLY) {
      await ctx.reply(isShuttingDown ? SHUTDOWN_ABORT_REPLY : ABORT_REPLY).catch(() => {});
      return;
    }

    // Persist bot response
    await saveMessage({
      chat_id: chatId,
      role: "assistant",
      content: response,
      metadata: { agent: agentName, topicId, ...turn.metadata() },
    });

    // Process intents (goals, facts, etc.)
    await processTurnIntents(response, turn.tools(), { chatId, topicId, origin: "Telegram" });

    // Aktives /goal in diesem Topic? Gates + Judge auf diese Antwort, ggf.
    // arbeitet der Bot selbststaendig weiter (fire-and-forget).
    void onAgentTurnForGoal(
      sessionKeyFor(chatId, topicId ?? null),
      agentName,
      response
    );

    // --- Cross-Agent Invocations ---
    let invocations = parseInvocationTags(response);
    if (invocations.length > 0) {
      // Reply budget (Buzz-Lehre): mechanische Grenze statt nur Prompt-Regel
      invocations = capInvocations(invocations, INVOKE_BUDGET);

      // Send pre-invocation text (everything except the tags) via source agent
      const preText = stripInvocationTags(response);
      if (preText) {
        await botRegistry.sendAsAgent(agentName, chatId, preText, { threadId: topicId });
      }

      // Execute each invocation visibly; die Antwort zusaetzlich speichern,
      // damit die WebUI sie als Nachricht des gefragten Agenten zeigt (Issue #76)
      for (const invocation of invocations) {
        await executeVisibleInvocation(
          botRegistry,
          agentName,
          invocation,
          chatId,
          topicId,
          callClaude,
          async (target, text) => {
            if (!text.trim() || text === ABORT_REPLY) return;
            await saveMessage({
              chat_id: chatId,
              role: "assistant",
              content: text,
              metadata: { agent: target, topicId, invokedBy: agentName },
            }).catch(() => {});
          }
        );
      }
      return;
    }

    // Check if Claude is asking a question that needs inline button response
    const parsed = parseClaudeResponse(response);
    if (parsed.needsInput && parsed.options.length > 0) {
      // Create task for human-in-the-loop
      const task = await createTask(chatId, userMessage, topicId, "mac");
      if (task) {
        // Die Frage lebt in der Session genau dieses Turns (Issue #189): nie
        // die globale letzte Session, die zu einem anderen Topic gehoeren kann
        await updateTask(task.id, {
          status: "needs_input",
          session_id: turn.sessionId(),
          pending_question: parsed.question || undefined,
          pending_options: parsed.options,
          current_step: parsed.text.substring(0, 500),
          // Motor und Modell der Session (Issue #122): die Knopf-Antwort
          // laeuft ueber genau diesen Motor, auch nach einem Motorwechsel
          metadata: turn.taskMetadata(agentName),
        });
        const keyboard = buildTaskKeyboard(task.id, parsed.options);
        await botRegistry.sendWithKeyboardAsAgent(agentName, chatId, response, keyboard, { threadId: topicId });
        return;
      }
    }

    // Normal response — send via agent's bot
    await botRegistry.sendAsAgent(agentName, chatId, response, { threadId: topicId });
  } catch (error) {
    // Abbruch (/stop, Neustart), der erst hier ankommt: nie als Fehler melden (Issue #188)
    if (isAbortError(error)) {
      await ctx.reply(isShuttingDown ? SHUTDOWN_ABORT_REPLY : ABORT_REPLY).catch(() => {});
      return;
    }
    console.error("callClaudeAndReply error:", error);
    await ctx.reply("Something went wrong. Please try again.");
  } finally {
    typing.stop();
    // Reply is out (or failed) — a requested restart may now happen safely.
    scheduleRestartCheck("nach Antwort", chatId, topicId);
  }
}

/**
 * Call Claude with streaming subprocess, sends live progress to Telegram.
 * Shows tool usage steps and first text snippet as the subprocess works.
 */
async function callClaudeWithProgressUnlocked(
  ctx: Context,
  userMessage: string,
  chatId: string,
  agentName: string,
  topicId?: number,
  onInfo?: (info: TurnInfo) => void,
  onTools?: (tools: TurnTools | undefined) => void,
  onSessionId?: SessionIdListener,
  onSessionMeta?: SessionMetaListener
): Promise<string> {
  return runStreamingTurn({
    userMessage,
    chatId,
    agentName,
    topicId,
    sink: createTelegramProgressSink(ctx, (text) =>
      botRegistry.sendAsAgent(agentName, chatId, text, { threadId: topicId })
    ),
    onSessionId: trackSessionId(onSessionId),
    onSessionMeta,
    onInfo,
    onTools,
  });
}

// ---------------------------------------------------------------------------
// Board Meeting — Multi-Bot Sequential Discussion (Kern: src/lib/board-meeting.ts)
// ---------------------------------------------------------------------------

/** Teilnehmer, Daten und Speichern fuer Board-Sitzungen, gleich in Telegram, Browser und Terminal */
const boardDeps = {
  // Mitgelieferte (ohne geloeschte und ausgeschaltete) plus eigene mit Board-Schalter
  agents: boardAgentNames,
  gatherData: gatherBoardData,
  stripInvocationTags,
};

/**
 * Run a board meeting with each agent bot posting sequentially.
 * Orchestrator announces → each agent contributes → Orchestrator synthesizes.
 */
async function runBoardMeeting(ctx: Context, chatId: string, topicId?: number, extraContext?: string): Promise<void> {
  await runBoardCore(
    {
      ...boardDeps,
      callAgent: async (prompt, agent) => {
        let info: TurnInfo | undefined;
        const text = await callClaude(prompt, chatId, agent, topicId, (i) => {
          info = i;
        });
        if (text === ABORT_REPLY) return { text: "", aborted: true };
        return {
          text,
          ...(info?.model ? { model: info.model } : {}),
          ...(info?.engine ? { engine: info.engine } : {}),
          ...(info ? { durationMs: info.durationMs } : {}),
        };
      },
      save: (message) => saveMessage({ chat_id: chatId, ...message }),
      newMessageId: () => crypto.randomUUID(),
    },
    { extraContext: extraContext || undefined, sessionKey: sessionKeyFor(chatId, topicId ?? null), topicId },
    createTelegramBoardOutput(
      {
        sendAsAgent: (agent, target, text, threadId) => botRegistry.sendAsAgent(agent, target, text, { threadId }),
        sendTypingAsAgent: (agent, target, threadId) => botRegistry.sendTypingAsAgent(agent, target, threadId),
        notice: (text) => ctx.reply(text),
      },
      chatId,
      topicId
    )
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a display name from the user profile markdown.
 * Falls back to "User" if no name is found.
 */
function extractUserName(profile: string): string {
  if (!profile) return "User";
  // Try to find a name in common profile patterns
  const nameMatch = profile.match(/(?:^#\s+(.+)|name:\s*(.+)|Name:\s*(.+))/m);
  if (nameMatch) {
    return (nameMatch[1] || nameMatch[2] || nameMatch[3]).trim();
  }
  return "User";
}

// ---------------------------------------------------------------------------
// 9b. Async /process Background Handler
// ---------------------------------------------------------------------------

/**
 * Send a long response directly via the main bot (no Context needed).
 * Markdown als HTML, in Stücken, Rückfall Klartext: telegramRuntime.sendMessage
 * (ohne Telegram abgelehnt, Issue #228).
 */
function sendDirectMessage(
  chatId: string | number,
  text: string,
  threadId?: number
): Promise<void> {
  return telegramRuntime.sendMessage(chatId, text, threadId);
}

/**
 * Process a /process request in the background: typing indicator, Claude,
 * response straight to Telegram. Fire-and-forget from the HTTP handler.
 * Ablauf und Neustart-Schutz: src/lib/process-background.ts (Issue #190).
 */
const processDeps: ProcessBackgroundDeps = {
  sessionKey: (chatId, threadId) => sessionKeyFor(chatId, threadId ?? null),
  send: (chatId, text, threadId) => sendDirectMessage(chatId, text, threadId),
  typing: chatId => telegramRuntime.typing(chatId),
  downloadPhoto: async photoFileId => {
    // VPS forwarded a photo: download from Telegram (ohne Telegram gibt es nichts zu laden)
    if (!telegramRuntime.telegram) return null;
    const file = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${photoFileId}`
    ).then((r) => r.json()) as any;
    const filePath = file?.result?.file_path;
    if (!filePath) return null;

    const uploadsDir = join(PROJECT_ROOT, "uploads");
    await mkdir(uploadsDir, { recursive: true });
    const ext = filePath.split(".").pop() || "jpg";
    const localPath = join(uploadsDir, uploadName("photo", Date.now(), crypto.randomUUID(), `.${ext}`));
    const dlRes = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
    await writeFile(localPath, Buffer.from(await dlRes.arrayBuffer()));
    return localPath;
  },
  uploadAsset: (localPath, caption, photoFileId) =>
    uploadAssetQuick(localPath, { userCaption: caption, channel: "telegram", telegramFileId: photoFileId }),
  callClaude: (prompt, chatId, threadId) => callClaude(prompt, chatId, "general", threadId),
  finishAsset: (assetId, response) => {
    // Parse and update asset description
    if (assetId) {
      const parsed = parseAssetDescTag(response);
      if (parsed) {
        updateAssetDescription(assetId, parsed.description, parsed.tags).catch(() => {});
      } else {
        const sentences = response.match(/[^.!?]+[.!?]+/g);
        if (sentences) {
          updateAssetDescription(assetId, sentences.slice(0, 2).join(" ").trim()).catch(() => {});
        }
      }
    }
    return stripAssetDescTag(response);
  },
};

// ---------------------------------------------------------------------------
// 10. Health Check HTTP Server
// ---------------------------------------------------------------------------

const handleProcessRequest = createProcessHandler({
  secret: () => GATEWAY_SECRET, allowChat: allowedChat,
  process: ({ text, chatId, threadId, photoFileId }) => processInBackground({ text, chatId, threadId, photoFileId }, processDeps),
});
const healthServer = Bun.serve({
  hostname: process.env.HEALTH_HOST || "127.0.0.1",
  maxRequestBodySize: 64 * 1024,
  port: HEALTH_PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(
        JSON.stringify({
          status: "ok",
          service: "tybo-telegram-bot",
          uptime: process.uptime(),
          pid: process.pid,
          sessionId: sessionState.sessionId,
          sessionEngine: sessionState.engine,
          timestamp: new Date().toISOString(),
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Process endpoint — VPS forwards messages here (async: returns 202 immediately)
    if (url.pathname === "/process" && req.method === "POST") {
      return handleProcessRequest(req);
    }

    return new Response("Not Found", { status: 404 });
  },
});

// ---------------------------------------------------------------------------
// 10b. WebUI (docs/webui/README.md): eigener Port, derselbe Chat-Kern wie
// Telegram. Aus, ungueltig oder nicht startbar: Log-Zeile, Bot laeuft weiter.
// ---------------------------------------------------------------------------

const webTurnDeps = {
  runStreamingTurn,
  saveMessage,
  processIntents: (text: string, turn: IntentTurn) => processTurnIntents(text, turn.tools, turn),
  abortEngineCalls,
  isShuttingDown: () => isShuttingDown,
  // Ohne Chat-ID: maybeRestart schickt seine Meldung sonst an eine Telegram-ID
  scheduleRestartCheck: (trigger: string) => scheduleRestartCheck(trigger),
  allowedTools: (agent: string) => getAgentConfigOrGeneral(agent)?.allowedTools,
  // Wartehinweis (Issue #188) nennt Topics beim Namen
  topicNames: getTopicNames,
};
// Anhaenge aus dem Web-Chat (Issue #72): eine Ablage fuer Upload-Route, Telegram- und Web-Turn;
// mediaDir: Arbeitskopien der Web-Gespraeche, beim Loeschen des Gespraechs mit weg (Issue #112)
const webUploads = new UploadStore({ dir: join(PROJECT_ROOT, "data", "uploads"), mediaDir: webMediaDir() });
// Reine Web-Gespraeche (Issue #112): Anhaenge durch den Medien-Kern, nichts nach Telegram
const webChat = createBotChat({ ...webTurnDeps, uploads: webUploads, approvals: approvalTurns });
// Schreiben in Direktchat und Topics (Issue #19): gleiche Session wie
// Telegram, Web-Nachricht als Klartext vom Haupt-Bot gespiegelt, Antwort vom
// Agenten-Bot. Werkzeug-Freigaben als Rueckfrage im Gespraech (Issue #116).
const telegramWebChat = createTelegramChat({
  ...webTurnDeps,
  approvals: approvalTurns,
  userId: dmChatId(process.env),
  groupId: () => botGroupId(process.env),
  agentForTopic: (topicId, chatId) => getAgentByTopicId(topicId, chatId),
  // Klartext ohne HTML-Modus: der Text kommt unveraendert an; Fehler wirft (dann kein Turn)
  sendPlain: (chatId, text, threadId) => telegramRuntime.sendPlain(chatId, text, threadId),
  sendAsAgent: (agent, chatId, text, threadId) => botRegistry.sendAsAgent(agent, chatId, text, { threadId }),
  // Anhaenge (Issue #72): vom Haupt-Bot als Foto bzw. Dokument, Beschriftung als Klartext; Fehler wirft
  sendFile: (chatId, file, options) => telegramRuntime.sendFile(chatId, file, options),
  uploads: webUploads,
  // [INVOKE:] aus Browser-Antworten wie in Telegram (Issue #76): Budget, Rechte, Antwort vom Agenten-Bot
  invokeBudget: INVOKE_BUDGET,
  sendTypingAsAgent: (agent, chatId, threadId) => botRegistry.sendTypingAsAgent(agent, chatId, threadId),
  // Aktives /goal: Gates und Judge auch nach Antworten im Browser
  onAgentTurn: (sessionKey, agent, response) => void onAgentTurnForGoal(sessionKey, agent, response),
});
// Slash-Befehle aus Browser und Terminal (Issue #74): dieselbe Befehls-Schicht
// wie Telegram; Antworten gehen ueber den Haupt-Bot und werden als Meldung festgehalten
const webResetConversation = createBotSessionReset({
  userId: dmChatId(process.env),
  groupId: () => botGroupId(process.env),
  agentForTopic: (topicId, chatId) => getAgentByTopicId(topicId, chatId),
});
const webCommands = createBotCommands({
  ...webTurnDeps,
  registry: commandRegistry,
  services: commandServices,
  userId: dmChatId(process.env),
  groupId: () => botGroupId(process.env),
  agentForTopic: (topicId, chatId) => getAgentByTopicId(topicId, chatId),
  sendPlain: (chatId, text, threadId) => telegramRuntime.sendPlain(chatId, text, threadId),
  sendAndRecord: (input) => sendAndRecord(input),
  resetConversation: webResetConversation,
  sendAsAgent: (agent, chatId, text, threadId) => botRegistry.sendAsAgent(agent, chatId, text, { threadId }),
  // /board (Issue #75): dieselben Teilnehmer und Daten wie in Telegram, Beitraege live und vom Agenten-Bot
  sendTypingAsAgent: (agent, chatId, threadId) => botRegistry.sendTypingAsAgent(agent, chatId, threadId),
  board: boardDeps,
  // /critic und /board: Werkzeug-Freigaben wie bei einem Turn des Gespraechs
  // (aeltere Web-Gespraeche ueber den Web-Chat, Telegram-Gespraeche ueber die Register-Turns)
  withApprovals: webChat.withApprovals,
  approvals: approvalTurns,
  // /voice aus Browser und Terminal (Issue #78): textToSpeech unveraendert, Format aus
  // den Bytes, WAV nach Ogg/Opus (sonst keine Sprachnachricht); Versand per sendVoice ueber
  // den Haupt-Bot, nicht gespeichert
  voice: createVoiceSynthesis({ enabled: isVoiceEnabled, textToSpeech, log: (m) => console.log(`[web] ${m}`) }),
  // Ohne Telegram kein Voice-Sender (Issue #228): /voice meldet dann, dass es nicht geht
  sendVoice: telegramRuntime.voiceSender,
});
webServer = await startWebUi({
  env: process.env,
  createServer: createWebServer,
  chat: webChat,
  telegram: createBotTelegram(process.env),
  telegramChat: telegramWebChat,
  telegramLive: createBotTelegramLive(process.env),
  // Agenten-Katalog (Issue #50): Verwaltung und alle Agentenlisten (neues Gespräch,
  // Topic-Zuordnung), bei jeder Anfrage neu aus config/agents.json
  agentCatalog: botAgentCatalog,
  // Web-Gespräche verwalten (Issue #21): Session-Reset beim Löschen
  resetSession: sessionKey => resetSession(sessionKey),
  // /new aus tybo (Issue #61): gleicher Schluessel wie beim Schreiben, Destillat wie /new
  resetConversation: webResetConversation,
  // Topics aus der WebUI (Issue #29) nur mit Telegram (Issue #228): ohne keine Topic-API, Rechte group: false
  topics: telegramRuntime.topicApi ? createBotTopics(process.env, telegramRuntime.topicApi) : undefined,
  // Einstellungsseiten (Issue #36): config/settings.json und /agent-Anweisungen
  settings: botSettings,
  instructions: botInstructions,
  // Modell-Liste von OpenCode (Issue #129): `opencode models`, 10 s, Liste 10 Minuten zwischengespeichert
  opencodeModels: listOpenCodeModels,
  // Statusseite und "Jetzt neu starten" (Issue #37): Marker data/restart-requested, maybeRestart erledigt den Rest
  status: createBotStatus(process.env),
  // Motor-Wahl in der WebUI (Issue #126): Standard, Codex-Einstellungen, abweichende Gespraeche,
  // Verfuegbarkeit (Claude Code wird dabei wirklich geprueft), Motor-Pille in der Kopfzeile
  engines: createBotEngines({
    userId: dmChatId(process.env),
    groupId: () => botGroupId(process.env),
    agentForTopic: (topicId, chatId) => getAgentByTopicId(topicId, chatId),
  }),
  // Schluessel-Seite (Issue #62): dieselbe .env, die oben geladen wurde; Aendern nur mit WEB_ALLOW_KEY_EDIT=true
  keys: createBotKeys(process.env),
  // Web Push (Issue #225): VAPID-Schluessel aus der .env, fehlen beide, legt der Bot sie hier einmal an
  push: (await prepareBotPush(process.env)) ?? undefined,
  // Dateien aus Meldungen (Issue #47): nur mit festgehaltenem Eintrag, aus data/outbox
  files: createBotFiles(process.env),
  uploads: webUploads,
  commands: webCommands,
  // Status-Karte der Ziele (Issue #76): dieselben Aktionen wie die Telegram-Knoepfe
  goals: createBotGoals({
    userId: dmChatId(process.env),
    groupId: () => botGroupId(process.env),
    agentForTopic: (topicId, chatId) => getAgentByTopicId(topicId, chatId),
    get: getGoal,
    isRunning: isGoalLoopRunning,
    action: (sessionKey, action, goalId, onlyIf) => runGoalAction(sessionKey, action, { goalId, abort: abortEngineCalls, onlyIf }),
    decideBudget: (sessionKey, goalId, action) => goalChoices.decideFromCard(sessionKey, goalId, action),
    onChange: onGoalChange,
  }),
  // Rueckfrage-Knoepfe (Issue #115): dasselbe Register wie die Telegram-Knoepfe (#114)
  choices: createBotChoices(process.env),
  // Meldungen fuer reine Web-Gespraeche (Issue #227): notify, Jobs und pipeline-say mit
  // TYBO_CONVERSATION_ID; der Bot uebernimmt sie ins Web-Gespraech und holt nach Ausfaellen nach
  webNotices: { page: getDisplayOnlyPage, onMessageSaved },
});

// ---------------------------------------------------------------------------
// 11. Bot Startup
// ---------------------------------------------------------------------------

// Initialize multi-bot agent identities (outbound-only, no polling); ohne Telegram nichts
await telegramRuntime.initialize();

// ---------------------------------------------------------------------------
// Goal engine, session review, tool approval — bot-level wiring
// ---------------------------------------------------------------------------

/** Send a plain/HTML status message, optionally with an inline keyboard (telegramRuntime.sendStatus). */
function sendStatusMessage(
  chatId: string,
  text: string,
  threadId?: number,
  keyboard?: unknown
): Promise<void> {
  return telegramRuntime.sendStatus(chatId, text, threadId, keyboard);
}

initGoalEngine({
  callAgent: async (prompt, goalChatId, goalAgent, goalTopicId) => {
    const turn = turnInfoCollector();
    const responseText = await callClaude(prompt, goalChatId, goalAgent, goalTopicId, undefined, turn.onTools);
    return {
      text: responseText === ABORT_REPLY ? "" : responseText,
      aborted: responseText === ABORT_REPLY,
      tools: turn.tools(),
    };
  },
  // Abbruch durch Neustart/SIGTERM pausiert kein Ziel (Issue #190)
  isShuttingDown: () => isShuttingDown,
  // Web-Direktchat ohne Telegram (Issue #227): die Antwort kommt ueber saveMessage in den Verlauf
  sendAsAgent: (goalAgent, goalChatId, goalText, goalTopicId) =>
    isWebChatId(goalChatId) ? Promise.resolve() : botRegistry.sendAsAgent(goalAgent, goalChatId, goalText, { threadId: goalTopicId }),
  // Telegram wie bisher; Pause, Wartet, Fertig zusaetzlich als Meldung fuer die WebUI (Issue #76).
  // Die Budget-Frage als Rueckfrage mit Knoepfen in Telegram und Browser (Issue #118)
  sendStatus: createTelegramGoalStatus({
    // Gemeinsamer Meldeweg (Issue #227): mit Telegram gesendet und genau einmal festgehalten,
    // ohne Telegram nur fuer die WebUI; der Zwischenstand je Turn nur in Telegram
    notify: notifyUser,
    ask: (target, text) => goalChoices.ask(target, text),
    noButtonsHint: GOAL_NO_BUTTONS_HINT,
  }),
});

// Session-Review- und Merk-Vorschlaege (Issue #117): Rueckfrage im Register,
// Knoepfe in Telegram (sendChoice) und im Browser; reine Web-Gespraeche
// bekommen die Frage im Gespraech selbst und als Kopie im Direktchat.
// Bestaetigte Vorschlaege wendet decideReview direkt an, nicht noch einmal
// durch das Tor fuer fremde Inhalte (Issue #53)
setReviewNotifier(createReviewNotifier({
  sendChoice: (choice) => telegramChoices.sendChoice(choice),
  postWeb: postReviewToWeb,
}));

// Initialize MCP tools for fallback LLM (so OpenRouter/Ollama get tool access when Claude fails)
await mcpManager.init().catch((err: any) => {
  console.error("[MCPManager] Init failed (continuing without MCP tools for fallback):", err.message);
});

console.log("=".repeat(50));
console.log(`${BRAND.name} - Starting`);
console.log("=".repeat(50));
console.log(`PID:         ${process.pid}`);
console.log(`Project:     ${PROJECT_ROOT}`);
console.log(`Timezone:    ${TIMEZONE}`);
console.log(`Health:      http://localhost:${HEALTH_PORT}/health`);
console.log(`Telegram:    ${telegramRuntime.telegram ? "an" : "nicht eingerichtet (nur WebUI)"}`);
console.log(`WebUI:       ${webServer ? "an (Adressen in der [web]-Zeile oben)" : "aus"}`);
console.log(`Claude:      ${CLAUDE_PATH}`);
console.log(`Voice:       ${isVoiceEnabled() ? "enabled" : "disabled"}`);
console.log(`Phone:       ${isCallEnabled() ? "enabled" : "disabled"}`);
console.log(`Transcribe:  ${isTranscriptionEnabled() ? `enabled (${getTranscriptionProvider()})` : "disabled"}`);
console.log(`MCP tools:   ${mcpManager.isReady ? mcpManager.getStatus() : "disabled"}`);
console.log(`Session:     ${sessionState.sessionId || "new"}`);
console.log(`HITL:        enabled (inline buttons + task queue)`);
console.log(`Routing:     model tier (haiku→instant, sonnet/opus→streaming progress)`);
console.log("=".repeat(50));

await sbLog("info", "bot", "Bot started", {
  pid: process.pid,
  timezone: TIMEZONE,
});

// Embedding-Anbieter gegen die Kennung der Datenbank prüfen (Issue #167):
// Abweichung laut melden; geschrieben und gesucht wird dann ohne Vektoren
void checkEmbeddingAtStartup().then(check => {
  if (!check) return;
  if (check.ok) console.log(`[embedding] ${check.message}`);
  else console.warn(`[embedding] ACHTUNG: ${check.message}`);
});

// Einträge nachziehen, die die Datenbank nach einem Anbieterwechsel ohne
// Vektor vorgemerkt hat (Issue #168, verspätete Schreiber mit altem Anbieter)
const drainEmbeddings = () => drainEmbeddingQueue()
  .then(r => { if (r?.state === "fertig" && (r.written || r.rejected)) console.log(`[embedding] ${r.written} vorgemerkte Einträge nachgezogen, ${r.rejected} abgelehnt`); })
  .catch(() => {});
void drainEmbeddings();
setInterval(() => { void drainEmbeddings(); }, DRAIN_INTERVAL_MS).unref();

void rotateServiceLogs().catch(error => console.error("Log rotation failed", error));
setInterval(() => { void rotateServiceLogs().catch(() => {}); }, 3_600_000).unref();

// Hintergrund-Jobs (Issue #103): Jobs, deren Wächter nicht mehr lebt, als
// abgebrochen melden; Meldungen, deren Absender mitten im Versand starb, nachholen.
// Gerade erst angelegte Jobs ohne Wächter-Eintrag nach der Schonfrist erneut prüfen
void recoverJobsUntilSettled(createJobDeps({ root: PROJECT_ROOT, env: process.env }))
  .then(r => {
    if (r.aborted.length || r.resent.length) {
      console.log(`[job] Beim Start: ${r.aborted.length} verwaiste Jobs gemeldet, ${r.resent.length} Meldungen nachgeholt`);
    }
  })
  .catch(e => console.error(`[job] Aufräumen beim Start gescheitert (${e instanceof Error ? e.name : "Fehler"})`));

// Rückfragen, deren Frist abgelaufen ist (auch während der Bot aus war):
// Ablauf speichern und Telegram-Nachrichten nachziehen, danach jede Minute
const sweepChoices = () => telegramChoices.sweep()
  .then(expired => { if (expired.length) console.log(`[choices] ${expired.length} Rückfragen abgelaufen`); })
  .catch(e => console.error(`[choices] Ablauf-Prüfung gescheitert (${e instanceof Error ? e.name : "Fehler"})`));
const firstSweep = sweepChoices();
setInterval(() => { void sweepChoices(); }, 60_000).unref();

// Start polling. Aktive Ziele nach einem Neustart erst fortsetzen, wenn grammY
// die Initialisierung abgeschlossen hat (onStart, Issue #190); ohne Telegram
// (Issue #228) genau einmal hier, nach WebUI, Goal-Engine, Review, MCP und der
// ersten Ablauf-Prüfung (startAfterFirstSweep wartet sie ab).
// Die Handler hängen nur mit Telegram am Bot
const resumeGoalsOnStart = goalResumeOnStart();
telegramRuntime.bot?.use(telegramHandlers);
void startAfterFirstSweep(telegramRuntime, firstSweep, resumeGoalsOnStart);

async function callClaude(userMessage: string, chatId: string, agentName = "general", topicId?: number, onInfo?: (info: TurnInfo) => void, onTools?: (tools: TurnTools | undefined) => void, onSessionId?: SessionIdListener, onSessionMeta?: SessionMetaListener): Promise<string> {
  try {
    return await runExecution(sessionKeyFor(chatId, topicId ?? null), agentName,
      () => callClaudeUnlocked(userMessage, chatId, agentName, topicId, onInfo, onTools, onSessionId, onSessionMeta), getAgentConfigOrGeneral(agentName)?.allowedTools);
  } catch (error) {
    if (isAbortError(error)) return ABORT_REPLY;
    throw error;
  }
}

async function callClaudeWithProgress(ctx: Context, userMessage: string, chatId: string, agentName: string, topicId?: number, onInfo?: (info: TurnInfo) => void, onTools?: (tools: TurnTools | undefined) => void, onSessionId?: SessionIdListener, onSessionMeta?: SessionMetaListener): Promise<string> {
  try {
    return await runExecution(sessionKeyFor(chatId, topicId ?? null), agentName,
      () => callClaudeWithProgressUnlocked(ctx, userMessage, chatId, agentName, topicId, onInfo, onTools, onSessionId, onSessionMeta), getAgentConfigOrGeneral(agentName)?.allowedTools);
  } catch (error) {
    if (isAbortError(error)) return ABORT_REPLY;
    throw error;
  }
}

async function handleUpdateScope(ctx: Context, fn: () => Promise<void>): Promise<void> {
  const text = ctx.message?.text || "";
  // /motor und /engine (Issue #125) ohne Bereich: ihr Reset prüft, ob im Gespräch eine Antwort läuft, und träfe sonst sich selbst
  if (/^\/(stop|new|motor|engine|goal\s+(pause|stop))\b/i.test(text)) return fn();
  const key = sessionKeyFor(String(ctx.chat?.id || ""), ctx.msg?.message_thread_id ?? null);
  // Wartet der Turn auf einen freien Platz (MAX_AGENT_PROCESSES), einmal Bescheid geben (Issue #188)
  const onQueueWait = createQueueNotifier(text => ctx.reply(text), getTopicNames);
  try { await runCancelable(key, fn, { onQueueWait }); }
  catch (error) {
    // Während des Neustarts (Issue #190): klare Meldung statt stillem Abbruch
    if (isRestartPendingError(error)) {
      await ctx.reply(RESTART_PENDING_REPLY, { message_thread_id: ctx.msg?.message_thread_id } as any).catch(() => {});
      return;
    }
    if (!isAbortError(error)) throw error;
  }
}
