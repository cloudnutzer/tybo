/**
 * Status-Karte eines Ziels (/goal) im Browser (Issue #76, M5).
 *
 * Der Web-Server kennt nur diesen Port: Karte lesen, Knopf drücken, Änderungen
 * abonnieren. src/bot.ts bindet createBotGoals aus ./bot-goals.ts ein
 * (Goal-Engine, gemeinsame Aktionen wie die Telegram-Knöpfe). Ohne Port gibt
 * es keine Karte und die Knopf-Route antwortet mit 503.
 *
 * Nur Typen, Texte und reine Funktionen, nichts aus src/lib.
 */

/** Knöpfe der Karte: Pause, Weiter (/goal weiter), Weiter +5 (nach dem Turn-Budget), Stopp */
export type GoalCardAction = "pause" | "resume" | "more" | "stop";

export const GOAL_CARD_ACTIONS: readonly GoalCardAction[] = ["pause", "resume", "more", "stop"];

export interface GoalCard {
  /** Kennung des Ziels (Zeitpunkt des Setzens); Knöpfe eines früheren Ziels sind veraltet */
  goalId: number;
  goal: string;
  agent: string;
  status: "active" | "paused";
  /** Gerade läuft eine Runde (Arbeits-Turn, Gates oder Judge) */
  running: boolean;
  turnsUsed: number;
  maxTurns: number;
  /** Letzter Befund (Judge, Gate oder Pause-Grund), bereinigt und gekürzt */
  note?: string;
  /** Knöpfe, die in diesem Zustand gelten */
  actions: GoalCardAction[];
}

export type GoalActOutcome =
  /** Ausgeführt; card ist der neue Stand, null nach Stopp */
  | { status: "ok"; card: GoalCard | null }
  /** Knopf passt nicht mehr (anderes Ziel, schon gedrückt, Zustand gewechselt); card ist der aktuelle Stand */
  | { status: "stale"; card: GoalCard | null }
  /** Für dieses Gespräch gibt es keine Ziele (Chat-ID fehlt) */
  | { status: "unavailable" };

export interface GoalPort {
  /** Karte des Gesprächs, null ohne Ziel */
  get(conversationId: string): Promise<GoalCard | null>;
  act(conversationId: string, action: GoalCardAction, goalId: number): Promise<GoalActOutcome>;
  /** Jede Änderung an einem Ziel, auch aus Telegram und aus der laufenden Arbeit; gibt die Abmeldung zurück */
  subscribe(listener: (conversationId: string, card: GoalCard | null) => void): () => void;
}

export const GOAL_CARD_TEXT = {
  notConfigured: "Ziele sind hier nicht eingerichtet.",
  unavailable: "Für dieses Gespräch gibt es keine Ziele.",
  stale: "Der Knopf passt nicht mehr zum Stand des Ziels. Die Karte zeigt jetzt den aktuellen Stand.",
  failed: "Die Aktion ist fehlgeschlagen.",
  invalid: "Ungültige Anfrage",
} as const;

/** Längster Befund auf der Karte, wie im /goal-Status */
export const GOAL_NOTE_MAX_CHARS = 300;

/** Welche Knöpfe in einem Zustand gelten: aktiv Pause und Stopp; pausiert Weiter (am Budget +5) und Stopp */
export function goalCardActions(goal: { status: string; turnsUsed: number; maxTurns: number }): GoalCardAction[] {
  if (goal.status === "active") return ["pause", "stop"];
  return goal.turnsUsed >= goal.maxTurns ? ["more", "stop"] : ["resume", "stop"];
}

/** Aktion aus einer Anfrage prüfen */
export function isGoalCardAction(value: unknown): value is GoalCardAction {
  return typeof value === "string" && (GOAL_CARD_ACTIONS as readonly string[]).includes(value);
}
