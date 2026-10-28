/**
 * Dienste der Befehls-Schicht (Issue #74) für den laufenden Bot (Issue #344):
 * dieselben Funktionen für Telegram, Browser und Terminal. Was erst nach dem
 * Start der Rückfragen feststeht (Routinen-Menü, Anrufe), reicht der Bot
 * herein; Telegram ergänzt pro Befehl nur noch /voice.
 */
import { addAgentOverride, clearAgentOverrides, getAgentOverrides, listAllOverrides, removeLastAgentOverride } from "../lib/agent-overrides";
import { isActiveAgent, listAgentNames } from "../agents/catalog";
import { resolveCommandAgentName } from "../agents/command-agent";
import { getTopicMappingForChat } from "../agents";
import { requestBoardStop } from "../lib/board-meeting";
import type { CommandServices } from "../lib/commands/types";
import { engineCommandServices } from "../lib/engine-choice";
import { abortEngineCalls } from "../lib/engines";
import { formatGoalStatus, getGoal, pauseGoal, setGoal, startGoalWork, updateGoal } from "../lib/goal-engine";
import { runGoalAction } from "../lib/goal-actions";
import { learnFromSource } from "../lib/learn";
import { addFact, addGoal, cancelGoal, completeGoal, deleteFact, listGoals } from "../lib/memory";
import { createRoutineFromSession } from "../lib/session-routine";
import { getSessionsForKey, isSessionModeEnabled, sessionEpoch, type BotSession } from "../lib/session-manager";
import { creditReport, planReport } from "../lib/spend/credit";
import { storeOr } from "../lib/store";
import { getTopicNames } from "../lib/topic-names";

export interface BotCommandServicesDeps {
  /** /routinen <name> (Issue #288): Menü mit „Jetzt testen", „Pausieren" bzw. „Fortsetzen" */
  routineMenu: NonNullable<CommandServices["routineMenu"]>;
}

export function createBotCommandServices(deps: BotCommandServicesDeps): CommandServices {
  return {
    isSessionModeEnabled,
    sessionsForKey: getSessionsForKey,
    sessionEpoch,
    createRoutine: (session, hint, epoch) => createRoutineFromSession(session as BotSession, hint, {}, epoch),
    routineMenu: deps.routineMenu,
    getGoal,
    pauseGoal,
    listGoals,
    abortEngineCalls,
    // /agent: nur aktive Agenten, Namen wie in der Befehls-Schicht aufgelöst
    listAgentNames,
    resolveAgentName: raw => resolveCommandAgentName(raw, isActiveAgent),
    listAllOverrides: () => listAllOverrides(isActiveAgent),
    getAgentOverrides,
    addAgentOverride,
    clearAgentOverrides: (agent, onWriteStart) => clearAgentOverrides(agent, undefined, onWriteStart),
    removeLastAgentOverride: (agent, onWriteStart) => removeLastAgentOverride(agent, undefined, onWriteStart),
    topicMapping: getTopicMappingForChat,
    topicNames: getTopicNames,
    learn: learnFromSource,
    // /credit und /plan (Issue #346): Abo-Zähler und Motorläufe aus spend/credit.ts
    formatCredit: async () => creditReport(),
    formatPlan: async () => planReport(),
    requestBoardStop,
    // /motor (Issue #125): Motor pro Gespräch in config/settings.json
    engines: engineCommandServices,
    // /remember, /recall und Co. (Issue #333)
    memory: {
      addFact,
      deleteFact,
      addGoal,
      completeGoal,
      cancelGoal,
      facts: () => storeOr([], store => store.memory.facts()),
      searchMessages: (chatId, query, limit) => storeOr([], store => store.messages.search(chatId, query, limit)),
    },
    // /goal (Issue #76): dieselben Aktionen wie die Knöpfe in Telegram und im Browser
    goals: {
      get: getGoal,
      set: setGoal,
      update: updateGoal,
      action: (sessionKey, action) => runGoalAction(sessionKey, action, { abort: abortEngineCalls }),
      start: sessionKey => void startGoalWork(sessionKey),
      formatStatus: formatGoalStatus,
    },
  };
}
