/**
 * Modellaufrufe des Bots (Issue #344). Zwei Wege über den Chat-Kern
 * (src/lib/chat-turn.ts):
 *
 * - ask: JSON-Subprozess ohne Fortschritt, nur Hinweise bei langen Läufen
 *   vom Bot des Agenten. Für /goal, /board, [INVOKE:], /process und Anrufe.
 * - askWithProgress: Streaming-Subprozess mit Fortschrittsnachricht im
 *   Gespräch. Für Nachrichten, Medien und /voice aus Telegram.
 *
 * Beide laufen unter dem Session-Schlüssel des Gesprächs (runExecution) mit
 * den Werkzeugen des Agenten; ein Abbruch per /stop ergibt ABORT_REPLY statt
 * eines Fehlers. Jede Session-ID geht an den Turn und an den globalen Stand
 * (Status, Startzeile).
 */
import { ABORT_REPLY, type SessionIdListener, type SessionMetaListener, type TurnInfo, type TurnOptions, type TurnQuestion, type TurnSessionMeta, type TurnSink } from "../lib/chat-turn";
import type { EngineId } from "../lib/engines";
import type { GoalTarget } from "../lib/goal-engine";
import { sessionKeyFor } from "../lib/store/message-rules";
import type { TurnTools } from "../lib/turn-tools";

export interface TurnExtras {
  onInfo?(info: TurnInfo): void;
  onTools?(tools: TurnTools | undefined): void;
  onSessionId?: SessionIdListener;
  onSessionMeta?: SessionMetaListener;
  turnHint?: string;
  onQuestion?(question: TurnQuestion): void;
}

export interface BotTurnsDeps<Ctx> {
  runJson(options: TurnOptions): Promise<string>;
  runStreaming(options: TurnOptions): Promise<string>;
  runExecution<T>(key: string, agent: string, run: () => Promise<T>, allowedTools?: string[]): Promise<T>;
  isAbort(error: unknown): boolean;
  allowedTools(agent: string): string[] | undefined;
  /** Letzte Session für Status und Startzeile */
  rememberSession(id: string, engine: EngineId): Promise<void>;
  sendAsAgent(agent: string, chatId: string, text: string, options: { threadId?: number }): Promise<unknown>;
  /** Fortschritt im Gespräch der Nachricht */
  progressSink(ctx: Ctx, notice: (text: string) => Promise<unknown>): TurnSink;
}

export interface BotTurns<Ctx> {
  ask(prompt: string, chatId: string, agent?: string, topicId?: number, extras?: TurnExtras): Promise<string>;
  askWithProgress(ctx: Ctx, prompt: string, chatId: string, agent: string, topicId?: number, extras?: TurnExtras): Promise<string>;
  /** Session-ID an den Turn und den globalen Stand melden */
  trackSession(listener?: SessionIdListener): (id: string, meta: TurnSessionMeta) => Promise<void>;
}

export function createBotTurns<Ctx>(deps: BotTurnsDeps<Ctx>): BotTurns<Ctx> {
  const trackSession = (listener?: SessionIdListener) => async (id: string, meta: TurnSessionMeta) => {
    listener?.(id, meta);
    await deps.rememberSession(id, meta.engine);
  };

  const options = (prompt: string, chatId: string, agent: string, topicId: number | undefined, extras: TurnExtras, sink: TurnSink): TurnOptions => ({
    userMessage: prompt,
    chatId,
    agentName: agent,
    topicId,
    ...(extras.turnHint ? { turnHint: extras.turnHint } : {}),
    sink,
    onSessionId: trackSession(extras.onSessionId),
    onSessionMeta: extras.onSessionMeta,
    onInfo: extras.onInfo,
    onTools: extras.onTools,
    ...(extras.onQuestion ? { onQuestion: extras.onQuestion } : {}),
  });

  const notice = (agent: string, chatId: string, topicId: number | undefined) => (text: string) =>
    deps.sendAsAgent(agent, chatId, text, { threadId: topicId });

  const guarded = async (chatId: string, agent: string, topicId: number | undefined, run: () => Promise<string>): Promise<string> => {
    try {
      return await deps.runExecution(sessionKeyFor(chatId, topicId ?? null), agent, run, deps.allowedTools(agent));
    } catch (error) {
      if (deps.isAbort(error)) return ABORT_REPLY;
      throw error;
    }
  };

  return {
    trackSession,
    ask: (prompt, chatId, agent = "general", topicId, extras = {}) => {
      const sink: TurnSink = { progress() {}, notice: text => notice(agent, chatId, topicId)(text).then(() => {}) };
      return guarded(chatId, agent, topicId, () => deps.runJson(options(prompt, chatId, agent, topicId, extras, sink)));
    },
    askWithProgress: (ctx, prompt, chatId, agent, topicId, extras = {}) =>
      guarded(chatId, agent, topicId, () =>
        deps.runStreaming(options(prompt, chatId, agent, topicId, extras, deps.progressSink(ctx, notice(agent, chatId, topicId))))
      ),
  };
}

/**
 * Agenten-Aufruf der Goal-Engine (/goal): JSON-Turn ohne Fortschritt, die
 * Werkzeuge des Turns gehen an das Tor für fremde Inhalte (Issue #53). Ein
 * Abbruch liefert leeren Text mit aborted.
 */
export function goalAgentCall<Ctx>(turns: Pick<BotTurns<Ctx>, "ask">, newTurn: () => { onTools(tools: TurnTools | undefined): void; tools(): TurnTools | undefined }) {
  return async (prompt: string, goal: Pick<GoalTarget, "chatId" | "agentName" | "topicId">) => {
    const turn = newTurn();
    const text = await turns.ask(prompt, goal.chatId, goal.agentName, goal.topicId, { onTools: turn.onTools });
    const aborted = text === ABORT_REPLY;
    return { text: aborted ? "" : text, aborted, tools: turn.tools() };
  };
}
