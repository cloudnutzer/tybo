/**
 * Ziele (/goal) in der WebUI (Issue #76): Status-Karte und Knöpfe für
 * Direktchat und Topics. Nur src/bot.ts bindet diese Datei ein; Goal-Engine
 * und gemeinsame Aktionen (src/lib/goal-actions.ts, dieselben wie die
 * Telegram-Knöpfe) kommen als Abhängigkeiten herein, damit Tests ohne
 * src/bot.ts auskommen.
 *
 * Ein Gespräch gehört zu genau dem Session-Schlüssel, unter dem auch
 * Telegram das Ziel führt (resolveTelegramTarget). Ältere reine
 * Web-Gespräche haben keine Ziele. Änderungen kommen aus der Goal-Engine
 * (onGoalChange), egal ob Browser, Terminal, Telegram oder die laufende
 * Arbeit sie ausgelöst hat.
 *
 * Steht am Turn-Budget eine offene Rückfrage "Weiter?" (Issue #118), gehen
 * "Weiter +5" und "Stopp" der Karte über diese Frage (decideBudget): so steht
 * in Telegram und im Verlauf danach "erledigt im Browser", und ein Klick auf
 * die Frage selbst wirkt nicht noch einmal.
 */

import type { GoalAction, GoalActionResult } from "../lib/goal-actions";
import type { ActiveGoal, GoalChange } from "../lib/goal-engine";
import { sanitizeModelOutput } from "../lib/telegram";
import { GOAL_NOTE_MAX_CHARS, goalCardActions, type GoalActOutcome, type GoalCard, type GoalCardAction, type GoalPort } from "./goals";
import { resolveTelegramTarget, type TelegramChatDeps } from "./bot-turn";
import { telegramTopicConversationId } from "./telegram";

export interface BotGoalsDeps extends Pick<TelegramChatDeps, "userId" | "groupId" | "agentForTopic"> {
  get(sessionKey: string): Promise<ActiveGoal | undefined>;
  /** Läuft die Arbeits-Schleife (isGoalLoopRunning) */
  isRunning(sessionKey: string): boolean;
  /**
   * runGoalAction mit goalId: nur für das Ziel, auf das sich der Knopf bezieht.
   * onlyIf reicht runGoalAction durch (wirkt bei "more" und "stop"): die
   * Goal-Engine prüft es unmittelbar vor der Änderung
   */
  action(sessionKey: string, action: GoalAction, goalId: number, onlyIf?: (goal: ActiveGoal) => boolean): Promise<GoalActionResult>;
  /**
   * Offene Budget-Frage desselben Ziels zuerst im Rückfragen-Register
   * entscheiden (Issue #118, decideFromCard aus src/lib/goal-choices.ts, via
   * "web"): nur der Gewinner ändert das Ziel, Telegram und Verlauf ziehen nach.
   * "none": keine offene und keine gerade entschiedene Frage, deren Handler
   * noch läuft; nur dann handelt die Karte selbst über action, und zwar nur,
   * solange das Ziel noch im Zustand steht, in dem sie den Knopf zeigte
   * (Status und budgetPaused, geprüft unmittelbar vor der Änderung). Alles außer
   * "decided" und "none" (auch eine gerade abgelaufene Frage) ist veraltet.
   */
  decideBudget?(sessionKey: string, goalId: number, action: GoalAction): Promise<"none" | "decided" | "already" | "failed" | "expired">;
  onChange(listener: (change: GoalChange) => void): () => void;
  /** Nie Zieltexte oder Zugangsdaten übergeben */
  log?(message: string): void;
}

/** Karte aus dem gespeicherten Ziel; null ohne (laufendes oder pausiertes) Ziel */
export function goalCardFrom(goal: ActiveGoal | null | undefined, running: boolean): GoalCard | null {
  if (!goal || (goal.status !== "active" && goal.status !== "paused")) return null;
  const note = goal.lastNote ? sanitizeModelOutput(goal.lastNote).substring(0, GOAL_NOTE_MAX_CHARS).trim() : "";
  return {
    goalId: goal.createdAt,
    goal: goal.goal,
    agent: goal.agentName,
    status: goal.status,
    running,
    turnsUsed: goal.turnsUsed,
    maxTurns: goal.maxTurns,
    ...(note ? { note } : {}),
    actions: goalCardActions(goal),
  };
}

export function createBotGoals(deps: BotGoalsDeps): GoalPort {
  const log = deps.log ?? ((m: string) => console.log(`[web] ${m}`));

  function sessionKeyOf(conversationId: string): string | null {
    return resolveTelegramTarget(conversationId, deps)?.sessionKey ?? null;
  }

  /** Gespräch zu einem Session-Schlüssel; null für fremde Chats und ältere Web-Gespräche */
  function conversationIdOf(sessionKey: string): string | null {
    const userId = deps.userId?.trim();
    if (userId && sessionKey === `dm:${userId}`) return "dm";
    let groupId: string | null;
    try {
      groupId = deps.groupId();
    } catch {
      groupId = null;
    }
    if (!groupId) return null;
    if (sessionKey === `group:${groupId}`) return telegramTopicConversationId(1);
    const prefix = `topic:${groupId}:`;
    if (!sessionKey.startsWith(prefix)) return null;
    const rest = sessionKey.slice(prefix.length);
    if (!/^[1-9]\d{0,9}$/.test(rest)) return null;
    const id = telegramTopicConversationId(Number(rest));
    // Nur, wenn es in dieselbe Richtung zurückführt (Topic 1 ist General ohne Thread)
    return sessionKeyOf(id) === sessionKey ? id : null;
  }

  async function current(sessionKey: string): Promise<GoalCard | null> {
    return goalCardFrom(await deps.get(sessionKey), deps.isRunning(sessionKey));
  }

  async function get(conversationId: string): Promise<GoalCard | null> {
    const key = sessionKeyOf(conversationId);
    return key ? current(key) : null;
  }

  async function act(conversationId: string, action: GoalCardAction, goalId: number): Promise<GoalActOutcome> {
    const key = sessionKeyOf(conversationId);
    if (!key) return { status: "unavailable" };
    const seen = await deps.get(key);
    const before = goalCardFrom(seen, deps.isRunning(key));
    // Veraltet: anderes Ziel, kein Ziel mehr oder der Knopf gilt in diesem Zustand nicht (Doppelklick)
    if (!seen || !before || before.goalId !== goalId || !before.actions.includes(action)) return { status: "stale", card: before };
    // Gezeigter Zustand, sofort kopiert: die Goal-Engine ändert das gelesene Objekt an Ort und Stelle
    const { status, budgetPaused } = seen;
    if (deps.decideBudget) {
      const decided = await deps.decideBudget(key, goalId, action);
      if (decided !== "none") {
        const after = await current(key);
        if (decided !== "decided") return { status: "stale", card: after };
        log(`Ziel in ${conversationId}: ${action} (Budget-Frage)`);
        return { status: "ok", card: after };
      }
    }
    // Nur, solange das Ziel noch in dem Zustand steht, in dem die Karte den
    // Knopf gezeigt hat: während der Registersuche kann etwa /goal pause die
    // Budget-Pause zur manuellen gemacht haben, die darf der Knopf nicht aufheben
    const sameState = (g: ActiveGoal): boolean =>
      g.status === status && !!g.budgetPaused === !!budgetPaused && goalCardFrom(g, false)?.actions.includes(action) === true;
    const result = await deps.action(key, action, goalId, sameState);
    const after = await current(key);
    if (result.status !== "ok") return { status: "stale", card: after };
    log(`Ziel in ${conversationId}: ${action}`);
    return { status: "ok", card: after };
  }

  function subscribe(listener: (conversationId: string, card: GoalCard | null) => void): () => void {
    return deps.onChange(change => {
      const id = conversationIdOf(change.sessionKey);
      if (!id) return;
      listener(id, goalCardFrom(change.goal, change.running));
    });
  }

  return { get, act, subscribe };
}
