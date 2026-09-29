/**
 * /goal "Weiter?" über das Rückfragen-Register (Issue #118, Entscheidung 0017).
 *
 * Ist das Turn-Budget eines Ziels aufgebraucht, fragt tybo nicht mehr mit
 * eigenen goalkb|-Knöpfen, sondern mit einer Rückfrage kind "goal":
 * - ref ist die Kennung des Ziels (goalId = createdAt), das Gespräch der Frage
 *   ist Chat und Topic des Ziels. Beides zusammen bestimmt das Ziel: zwei
 *   Gespräche können dasselbe createdAt haben, der Session-Schlüssel ergibt
 *   sich aus dem Gespräch (sessionKeyFor).
 * - Optionen "more" (Weiter +5) und "stop" (Beenden), zugestellt über
 *   sendChoice: in Telegram mit "ch|"-Knöpfen, im Browser mit Knöpfen im
 *   Verlauf (festgehalten mit choiceId, source "ziel").
 *
 * Genau einmal: Der Handler der Art "goal" läuft nur im Gewinnerprozess von
 * decideChoice und ruft runGoalAction mit der gespeicherten goalId auf; die
 * Goal-Engine prüft die Kennung und den Budget-Zustand (atBudget) unmittelbar
 * vor der Änderung, ein Knopf eines alten Ziels wirkt also nie auf ein neues,
 * und eine überholte Entscheidung hebt keine manuelle Pause auf. Die Knöpfe der Ziel-Karte im
 * Browser entscheiden eine offene Budget-Frage desselben Ziels zuerst im
 * Register (decideFromCard, via "web"); nur der Gewinner ändert das Ziel.
 * Ist die Frage schon entschieden, der Handler des Gewinners aber noch nicht
 * fertig (etwa weil Telegram gerade die Nachricht nachzieht), handelt die
 * Karte nicht selbst, sondern meldet "already". Läuft die Frage ab, während
 * die Karte sie entscheiden will, meldet sie "expired" und handelt ebenfalls
 * nicht selbst.
 *
 * Ablauf: Offen bleibt die Frage nur, solange ihr Ziel vom Turn-Budget
 * pausiert ist (budgetPaused, von workLoop gesetzt). Jede andere Änderung
 * (Stopp, Ersatz durch ein neues Ziel, Judge fertig, /goal weiter, /goal max,
 * /goal pause) lässt sie ablaufen (listener auf
 * onGoalChange). Weil onGoalChange asynchrone Zuhörer nicht abwartet, prüft
 * die Zustellung nach dem Anlegen noch einmal selbst; der Handler verlässt
 * sich ohnehin nie auf den Ablauf, sondern auf goalId und atBudget.
 *
 * Ins Log kommen nur IDs, nie Zieltexte.
 */

import {
  createChoice,
  decideChoice,
  expireChoice,
  listChoices,
  type Choice,
  type ChoiceConversation,
  type ChoiceHandler,
  type ChoiceOption,
  type CreateChoiceInput,
  type DecideOutcome,
  type ExpireOutcome,
} from "./choices";
import { runGoalAction, type GoalActionResult } from "./goal-actions";
import { GOAL_EXTEND_TURNS, type ActiveGoal, type GoalChange, type GoalTarget } from "./goal-engine";
import { sessionKeyFor } from "./supabase";

export const GOAL_CHOICE_MORE = "more";
export const GOAL_CHOICE_STOP = "stop";

/** Knöpfe der Budget-Frage; Schlüssel wie die Aktionen von runGoalAction */
export const GOAL_BUDGET_OPTIONS: ChoiceOption[] = [
  { key: GOAL_CHOICE_MORE, label: `Weiter (+${GOAL_EXTEND_TURNS})` },
  { key: GOAL_CHOICE_STOP, label: "Beenden" },
];

/** Hinweis, wenn die Frage nicht ins Register kam: ohne Knöpfe, mit den Befehlen */
export const GOAL_NO_BUTTONS_HINT =
  "(Knöpfe gerade nicht verfügbar. Weiter: /goal max <n>, dann /goal weiter · Beenden: /goal stop)";

const GOAL_ID = /^[1-9]\d{0,15}$/;

type Log = (line: string) => void;
const defaultLog: Log = line => console.log(line);

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : "Fehler";
}

/** goalId aus ref; null, wenn ref keine gültige Kennung ist */
export function goalIdOf(ref: unknown): number | null {
  if (typeof ref !== "string" || !GOAL_ID.test(ref)) return null;
  const id = Number(ref);
  return Number.isSafeInteger(id) ? id : null;
}

/** Telegram-Chat oder, ohne Telegram, der Web-Direktchat "web" (Issue #227, Session dm:web) */
const TELEGRAM_CHAT = /^(-?\d{1,20}|web)$/;

/**
 * Gespräch der Frage: Chat und Topic des Ziels; null bei allem anderen (Ziele
 * gibt es nur im Direktchat und in Telegram-Topics; ohne Telegram ist der
 * Direktchat "web", der als type "telegram" wie der Telegram-Direktchat läuft)
 */
export function goalConversation(chatId: string, topicId?: number): ChoiceConversation | null {
  if (!TELEGRAM_CHAT.test(chatId)) return null;
  return Number.isInteger(topicId) ? { type: "telegram", chatId, topicId } : { type: "telegram", chatId };
}

/** Session-Schlüssel des Gesprächs einer Frage, wie ihn die Goal-Engine führt */
export function goalSessionKeyOf(conversation: ChoiceConversation): string {
  return conversation.type === "web"
    ? sessionKeyFor(`web:${conversation.conversationId}`)
    : sessionKeyFor(conversation.chatId, conversation.topicId ?? null);
}

/**
 * Das Ziel steht vom Turn-Budget pausiert: nur dann gilt die Budget-Frage.
 * Eine manuelle Pause (/goal pause, /stop) setzt budgetPaused zurück.
 */
export function atBudget(goal: ActiveGoal | null | undefined, goalId: number): boolean {
  return (
    !!goal &&
    goal.createdAt === goalId &&
    goal.status === "paused" &&
    goal.budgetPaused === true &&
    goal.turnsUsed >= goal.maxTurns
  );
}

export interface GoalChoicesDeps {
  getGoal(sessionKey: string): Promise<ActiveGoal | undefined>;
  /** abortEngineCalls aus src/lib/engines (Beenden bricht laufende Aufrufe ab) */
  abort(sessionKey: string): number;
  /** Frage in Telegram zeigen und festhalten (createTelegramChoices().sendChoice) */
  sendChoice(choice: Choice): Promise<{ sent: boolean }>;
  /** Standard aus dem Register; Tests reichen Attrappen herein */
  createChoice?(input: CreateChoiceInput): Promise<Choice>;
  listChoices?(): Promise<Choice[]>;
  decideChoice?(id: string, key: string, via: "web"): Promise<DecideOutcome>;
  expireChoice?(id: string): Promise<ExpireOutcome>;
  /** Standard runGoalAction */
  runGoalAction?: typeof runGoalAction;
  log?: Log;
}

export type CardDecision =
  /** Keine offene und keine gerade laufende Budget-Frage dieses Ziels: die Karte handelt selbst */
  | "none"
  /** Im Register gewonnen, der Handler hat das Ziel geändert */
  | "decided"
  /** Schon anders entschieden (Telegram, Browser-Verlauf, Terminal), auch wenn dessen Handler noch läuft */
  | "already"
  /** Gewonnen, aber das Ziel war nicht mehr in dem Zustand (ersetzt, weg) */
  | "failed"
  /** Die Frage lief ab oder verschwand, während die Karte sie entscheiden wollte: der Knopf ist veraltet */
  | "expired";

export interface GoalChoices {
  /** Budget-Frage anlegen und zeigen; false: nicht im Register, Aufrufer zeigt die Meldung ohne Knöpfe */
  ask(target: GoalTarget, text: string): Promise<boolean>;
  /** Handler der Art "goal" (onChoiceDecided) */
  handler: ChoiceHandler;
  /** Zuhörer für onGoalChange: lässt Budget-Fragen ablaufen, die nicht mehr gelten */
  listener(change: GoalChange): void;
  /** Knopf der Ziel-Karte (more/stop): offene Budget-Frage desselben Ziels zuerst im Register entscheiden */
  decideFromCard(sessionKey: string, goalId: number, action: string): Promise<CardDecision>;
  /** Für Tests: bis alle angestoßenen Abläufe fertig sind */
  settled(): Promise<void>;
}

export function createGoalChoices(deps: GoalChoicesDeps): GoalChoices {
  const log = deps.log ?? defaultLog;
  const create = deps.createChoice ?? createChoice;
  const list = deps.listChoices ?? listChoices;
  const decide = deps.decideChoice ?? ((id: string, key: string, via: "web") => decideChoice(id, key, via));
  const expire = deps.expireChoice ?? expireChoice;
  const act = deps.runGoalAction ?? runGoalAction;

  // Entscheidungen, deren Handler in diesem Prozess durchgelaufen ist (auch
  // mit Fehler). Handler laufen nur im Prozess, der entschieden hat: eine
  // Entscheidung von vor startedAt hat hier keinen Handler mehr vor sich
  const startedAt = Date.now();
  const handled = new Set<string>();

  /** Budget-Fragen eines Session-Schlüssels (alle Zustände) */
  async function goalChoicesFor(sessionKey: string): Promise<Choice[]> {
    return (await list()).filter(c => c.kind === "goal" && goalSessionKeyOf(c.conversation) === sessionKey);
  }

  /** Offene Budget-Fragen eines Session-Schlüssels */
  async function openFor(sessionKey: string): Promise<Choice[]> {
    return (await goalChoicesFor(sessionKey)).filter(c => c.state === "open");
  }

  /** Entschieden, aber der Handler des Gewinners hat noch nicht gewirkt */
  function inFlight(c: Choice): boolean {
    return c.state === "done" && !c.handlerError && !handled.has(c.id) && (c.result?.at ?? 0) >= startedAt;
  }

  /** Offene Budget-Fragen ablaufen lassen, außer denen des Ziels keep (am Budget) */
  async function expireStale(sessionKey: string, goal: ActiveGoal | null | undefined): Promise<void> {
    let open: Choice[];
    try {
      open = await openFor(sessionKey);
    } catch (e) {
      log(`[Ziel] Register nicht lesbar, Budget-Fragen von ${sessionKey} nicht geprüft (${errorName(e)})`);
      return;
    }
    for (const c of open) {
      const goalId = goalIdOf(c.ref);
      if (goalId !== null && atBudget(goal, goalId)) continue;
      try {
        await expire(c.id);
      } catch (e) {
        log(`[Ziel] Budget-Frage ${c.id} nicht abgelaufen (${errorName(e)})`);
      }
    }
  }

  // Abläufe je Session-Schlüssel nacheinander, damit ein später Zuhörer
  // nicht vor einem früheren prüft
  const tails = new Map<string, Promise<void>>();
  function queue(sessionKey: string, work: () => Promise<void>): Promise<void> {
    const next = (tails.get(sessionKey) ?? Promise.resolve()).then(work, work);
    const tail = next.catch(() => {});
    tails.set(sessionKey, tail);
    void tail.then(() => {
      if (tails.get(sessionKey) === tail) tails.delete(sessionKey);
    });
    return next;
  }

  async function ask(target: GoalTarget, text: string): Promise<boolean> {
    const goalId = target.createdAt;
    const conversation = goalConversation(target.chatId, target.topicId);
    if (!conversation || goalSessionKeyOf(conversation) !== target.sessionKey || !Number.isSafeInteger(goalId) || goalId <= 0) {
      log(`[Ziel] Budget-Frage für ${target.sessionKey}: Gespräch passt nicht zum Ziel, ohne Knöpfe`);
      return false;
    }
    // Eine ältere Frage desselben Gesprächs (auch desselben Ziels) gilt nicht mehr
    await queue(target.sessionKey, async () => {
      let open: Choice[] = [];
      try {
        open = await openFor(target.sessionKey);
      } catch (e) {
        log(`[Ziel] Register nicht lesbar, ältere Budget-Fragen von ${target.sessionKey} nicht geprüft (${errorName(e)})`);
      }
      for (const c of open) await expire(c.id).catch(e => log(`[Ziel] Budget-Frage ${c.id} nicht abgelaufen (${errorName(e)})`));
    });

    let choice: Choice;
    try {
      choice = await create({ kind: "goal", conversation, text, options: GOAL_BUDGET_OPTIONS, ref: String(goalId) });
    } catch (e) {
      log(`[Ziel] Budget-Frage für ${target.sessionKey} nicht angelegt (${errorName(e)})`);
      return false;
    }
    // Während des Anlegens gestoppt, ersetzt oder fortgesetzt: der Zuhörer
    // fand die Frage vielleicht noch nicht, also hier nachsehen
    if (!atBudget(await deps.getGoal(target.sessionKey), goalId)) {
      await expire(choice.id).catch(e => log(`[Ziel] Budget-Frage ${choice.id} nicht abgelaufen (${errorName(e)})`));
      return true;
    }
    try {
      if ((await deps.sendChoice(choice)).sent) return true;
    } catch (e) {
      log(`[Ziel] Budget-Frage ${choice.id} nicht gesendet (${errorName(e)})`);
    }
    // Nirgends gezeigt: Frage zurückziehen, der Aufrufer meldet ohne Knöpfe
    await expire(choice.id).catch(() => {});
    return false;
  }

  const handler: ChoiceHandler = async choice => {
    try {
      const goalId = goalIdOf(choice.ref);
      const key = choice.result?.key;
      if (goalId === null || (key !== GOAL_CHOICE_MORE && key !== GOAL_CHOICE_STOP)) {
        throw new Error("Budget-Frage ohne gültiges Ziel oder Ergebnis");
      }
      const sessionKey = goalSessionKeyOf(choice.conversation);
      // Nur das Ziel dieser Frage und nur, solange es noch am Budget steht: die
      // Goal-Engine prüft beides unmittelbar vor der Änderung. Eine inzwischen
      // manuell gesetzte Pause (/goal pause, /stop) hebt die alte Entscheidung
      // damit nicht auf
      const result: GoalActionResult = await act(sessionKey, key, {
        goalId,
        abort: deps.abort,
        onlyIf: g => atBudget(g, goalId),
      });
      if (result.status !== "ok") throw new Error(`Ziel nicht mehr am Budget (${result.status})`);
      log(`[Ziel] Budget-Frage ${choice.id}: ${key} (${choice.result?.via})`);
    } finally {
      handled.add(choice.id);
    }
  };

  const listener = (change: GoalChange): void => {
    void queue(change.sessionKey, () => expireStale(change.sessionKey, change.goal));
  };

  async function decideFromCard(sessionKey: string, goalId: number, action: string): Promise<CardDecision> {
    if (action !== GOAL_CHOICE_MORE && action !== GOAL_CHOICE_STOP) return "none";
    let mine: Choice[];
    try {
      mine = (await goalChoicesFor(sessionKey)).filter(c => goalIdOf(c.ref) === goalId);
    } catch (e) {
      // Ohne lesbares Register nie am Register vorbei: die Karte meldet einen Fehler
      log(`[Ziel] Register nicht lesbar, Kartenknopf für ${sessionKey} nicht ausgeführt (${errorName(e)})`);
      throw e;
    }
    const choice = mine.find(c => c.state === "open");
    if (!choice) {
      // Schon entschieden, der Gewinner wirkt gleich: nie daneben selbst handeln.
      // Bei "none" handelt die Karte nur unter der Bedingung, dass das Ziel noch
      // im gezeigten Zustand steht (bot-goals): lief die Frage während der
      // Suche ab (/goal pause), ist der Knopf dort veraltet
      return mine.some(inFlight) ? "already" : "none";
    }
    const outcome = await decide(choice.id, action, "web");
    switch (outcome.status) {
      case "decided":
        return outcome.choice.handlerError ? "failed" : "decided";
      case "already":
        return "already";
      default:
        // Gerade abgelaufen oder verschwunden: das Ziel hat sich inzwischen
        // geändert (/goal pause, Stopp, Ersatz), der Knopf ist veraltet. Nie
        // selbst handeln, sonst höbe er etwa eine bestätigte Pause auf
        return "expired";
    }
  }

  async function settled(): Promise<void> {
    while (tails.size > 0) await Promise.all([...tails.values()]);
  }

  return { ask, handler, listener, decideFromCard, settled };
}
