/**
 * Gemeinsame Aktionen fuer /goal (Issue #76): Telegram-Knoepfe, Befehle und
 * die Knoepfe der Status-Karte im Browser nutzen dieselben Funktionen.
 *
 * Semantik, durch Regressionstests festgehalten:
 *  - "more" (Weiter-Knopf nach dem Turn-Budget): nur ein pausiertes Ziel,
 *    Budget +GOAL_EXTEND_TURNS; ein Doppelklick erhoeht es nicht zweimal.
 *  - "resume" (/goal weiter): setzt fort ohne zusaetzliche Turns.
 *  - "pause" (/goal pause): der laufende Turn laeuft aus, danach Pause.
 *  - "stop" (/goal stop, Beenden-Knopf): Ziel loeschen und laufende
 *    Claude-Aufrufe des Gespraechs abbrechen.
 *
 * Ausserdem die Telegram-Ausgabe der Goal-Engine: Knoepfe als Inline-Keyboard
 * wie frueher mit grammYs InlineKeyboard gebaut; die Budget-Frage laeuft seit
 * Issue #118 ueber das Rueckfragen-Register (src/lib/goal-choices.ts).
 */

import type { UserNotifier } from "./user-notify";
import {
  clearGoal,
  extendGoal,
  getGoal,
  GOAL_EXTEND_TURNS,
  pauseGoal,
  resumeGoalWork,
  type ActiveGoal,
  type GoalButton,
  type GoalStatusMessage,
  type GoalTarget,
} from "./goal-engine";

/** Absender der festgehaltenen Statusmeldungen (metadata.source, Meldung in der WebUI) */
export const GOAL_NOTICE_SOURCE = "ziel";

export type GoalAction = "more" | "resume" | "pause" | "stop";

export const GOAL_ACTIONS: readonly GoalAction[] = ["more", "resume", "pause", "stop"];

export type GoalActionResult =
  /** Ausgefuehrt; goal ist der Stand davor (stop) bzw. danach */
  | { status: "ok"; goal: ActiveGoal }
  /** Kein Ziel (mehr) oder ein anderes als das der Karte */
  | { status: "missing" }
  /** "more" auf ein Ziel, das schon wieder arbeitet: nichts geaendert */
  | { status: "active"; goal: ActiveGoal };

export interface GoalActionOptions {
  /** createdAt des Ziels, auf das sich der Knopf bezieht; fehlt bei Befehlen */
  goalId?: number;
  /** abortEngineCalls aus src/lib/engines */
  abort(sessionKey: string): number;
  /**
   * Nur "more" und "stop": weitere Bedingung an das Ziel, die Goal-Engine
   * prueft sie im selben Schritt wie die Kennung, unmittelbar vor der Aenderung
   * (Budget-Frage: nur solange das Ziel am Budget steht)
   */
  onlyIf?(goal: ActiveGoal): boolean;
}

export async function runGoalAction(sessionKey: string, action: GoalAction, options: GoalActionOptions): Promise<GoalActionResult> {
  const before = await getGoal(sessionKey);
  if (!before || (options.goalId !== undefined && before.createdAt !== options.goalId)) return { status: "missing" };
  // Die Goal-Engine prueft die Kennung erneut unmittelbar vor der Aenderung:
  // ein Ziel, das seit der Pruefung oben ersetzt wurde, bleibt unberuehrt
  const goalId = before.createdAt;

  if (action === "more") {
    const result = await extendGoal(sessionKey, GOAL_EXTEND_TURNS, goalId, options.onlyIf);
    const goal = await getGoal(sessionKey);
    if (result === "missing" || !goal) return { status: "missing" };
    return result === "active" ? { status: "active", goal } : { status: "ok", goal };
  }
  if (action === "resume") {
    if (!(await resumeGoalWork(sessionKey, 0, goalId))) return { status: "missing" };
    const goal = await getGoal(sessionKey);
    return goal ? { status: "ok", goal } : { status: "missing" };
  }
  if (action === "pause") {
    const goal = await pauseGoal(sessionKey, "Vom User pausiert", goalId);
    return goal ? { status: "ok", goal } : { status: "missing" };
  }
  // stop: loeschen und im selben Schritt abbrechen (vor dem Speichern); die
  // abgebrochene Schleife findet kein Ziel mehr. Ein Nachfolger kann erst
  // danach gesetzt werden, seine Arbeit laeuft weiter
  if (!(await clearGoal(sessionKey, "stopped", goalId, () => options.abort(sessionKey), options.onlyIf))) return { status: "missing" };
  return { status: "ok", goal: before };
}

/** Knoepfe als Telegram-Inline-Keyboard (gleiches JSON wie grammYs InlineKeyboard) */
export function goalKeyboard(rows: GoalButton[][]): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return { inline_keyboard: rows.map(row => row.map(b => ({ text: b.label, callback_data: b.action }))) };
}

/**
 * Telegram-Ausgabe der Goal-Engine: Statusmeldung vom Haupt-Bot wie bisher
 * (send ist sendStatusMessage in src/bot.ts), danach fuer die WebUI
 * festhalten, ausser dem Zwischenstand vor jedem Turn (den zeigt die Karte).
 *
 * Die Budget-Frage (kind "budget") geht seit Issue #118 an ask (Rueckfrage im
 * Register, createGoalChoices in src/lib/goal-choices.ts): sendChoice sendet
 * und haelt sie selbst fest, deshalb hier weder send noch record, sonst stuende
 * sie doppelt im Verlauf. Kam sie nicht ins Register (ask false), geht sie wie
 * die anderen Meldungen raus, ohne Knoepfe und mit dem Hinweis auf die Befehle.
 *
 * Mit notify (Issue #227, gemeinsamer Meldeweg aus src/lib/user-notify.ts)
 * ersetzt ein einziger Aufruf send und record: mit Telegram gesendet und
 * genau einmal festgehalten, ohne Telegram nur festgehalten; der Zwischenstand
 * ("turn") nur in Telegram.
 */
export function createTelegramGoalStatus(deps: {
  send?(chatId: string, text: string, threadId?: number, keyboard?: unknown): Promise<void>;
  record?(target: GoalTarget, message: GoalStatusMessage): Promise<unknown>;
  notify?: UserNotifier;
  ask?(target: GoalTarget, text: string): Promise<boolean>;
  /** Hinweis unter der Budget-Meldung, wenn ask fehlt oder scheitert */
  noButtonsHint?: string;
}): (target: GoalTarget, message: GoalStatusMessage) => Promise<void> {
  return async (target, original) => {
    let message = original;
    if (message.kind === "budget") {
      let asked = false;
      try {
        asked = !!deps.ask && (await deps.ask(target, message.text));
      } catch (err) {
        console.error("[GoalEngine] Budget-Frage nicht gestellt:", err instanceof Error ? err.name : typeof err);
      }
      if (asked) return;
      const { buttons: _none, ...rest } = message;
      message = deps.noButtonsHint ? { ...rest, text: `${rest.text}\n\n${deps.noButtonsHint}` } : rest;
    }
    if (deps.notify) {
      await deps.notify(message.text, {
        chatId: target.chatId,
        ...(target.topicId !== undefined ? { topicId: target.topicId } : {}),
        source: GOAL_NOTICE_SOURCE,
        ...(message.buttons ? { buttons: goalKeyboard(message.buttons).inline_keyboard } : {}),
        ...(message.kind === "turn" ? { telegramOnly: true } : {}),
      });
      return;
    }
    await deps.send?.(target.chatId, message.text, target.topicId, message.buttons ? goalKeyboard(message.buttons) : undefined);
    if (message.kind !== "turn" && deps.record) {
      try {
        await deps.record(target, message);
      } catch (err) {
        console.error("[GoalEngine] Statusmeldung nicht festgehalten:", err instanceof Error ? err.name : typeof err);
      }
    }
  };
}

export const GOAL_CALLBACK_TEXT = {
  more: `▶️ Weiter (+${GOAL_EXTEND_TURNS} Turns).`,
  alreadyActive: "▶️ Das Ziel läuft bereits.",
  gone: "Kein Ziel mehr aktiv.",
  stopped: (goal: string) => `🛑 Ziel beendet: "${goal.substring(0, 100)}"`,
} as const;

/**
 * Alter Telegram-Knopf goalkb|more|<key> bzw. goalkb|stop|<key> aus der Zeit
 * vor Issue #118 (neue Budget-Fragen haben "ch|"-Knoepfe). Er traegt keine
 * goalId und wirkt deshalb auf das Ziel, das gerade im Gespraech steht; ohne
 * Ziel "Kein Ziel mehr aktiv.". Den Schutz "Knopf von Ziel A wirkt nie auf
 * Ziel B" haben nur die Register-Knoepfe. Gibt den Text
 * zurueck, der die Knopf-Nachricht ersetzt; null, wenn data kein Goal-Knopf ist.
 */
export async function handleGoalCallback(data: string, options: Pick<GoalActionOptions, "abort">): Promise<string | null> {
  if (!data.startsWith("goalkb|")) return null;
  const [, action, sessionKey] = data.split("|");
  if (!sessionKey) return GOAL_CALLBACK_TEXT.gone;
  if (action === "more") {
    const result = await runGoalAction(sessionKey, "more", options);
    if (result.status === "ok") return GOAL_CALLBACK_TEXT.more;
    return result.status === "active" ? GOAL_CALLBACK_TEXT.alreadyActive : GOAL_CALLBACK_TEXT.gone;
  }
  if (action === "stop") {
    const result = await runGoalAction(sessionKey, "stop", options);
    return result.status === "ok" ? GOAL_CALLBACK_TEXT.stopped(result.goal.goal) : GOAL_CALLBACK_TEXT.gone;
  }
  return "";
}
