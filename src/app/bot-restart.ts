/**
 * Neustart nach Antwort (Issue #190, #344): ein Subprozess, der den Code des
 * Bots geändert hat, darf den Bot nie selbst beenden, denn das Beenden killt
 * auch den Subprozess, der gerade die Antwort schreibt. Er legt stattdessen
 * data/restart-requested an (bun run restart:request); der Bot endet, sobald
 * nichts mehr läuft, und launchd bzw. PM2 starten ihn neu.
 *
 * Beschäftigt ist der Bot, solange Motor-Aufrufe, Ausführungen,
 * Ziel-Schleifen (auch zwischen ihren Turns) oder Turns eines Telefonhörers
 * laufen; ein offenes Telefonat zwischen den Turns zählt nicht. Vor dem Exit
 * verabschieden sich die Telefonhörer.
 */
import { createRestartControl, type RestartControlDeps } from "../lib/restart-control";

export interface BotRestartDeps extends Pick<RestartControlDeps, "readRequest" | "clearRequest" | "detectSupervisor" | "closeIntake" | "send" | "shutdown" | "isShuttingDown"> {
  /** Je eine Zahl laufender Arbeit: Motor-Aufrufe, Ausführungen, Ziel-Schleifen, Telefonhörer-Turns */
  busy: Array<() => number>;
  /** Telefonhörer vor dem Exit verabschieden */
  farewell(): Promise<unknown> | unknown;
  /** Verzögerung nach einer Antwort, bis der Bereich des Updates geschlossen ist */
  delayMs?: number;
  schedule?(run: () => void, ms: number): void;
}

export function createBotRestart(deps: BotRestartDeps) {
  const control = createRestartControl({
    readRequest: deps.readRequest,
    clearRequest: deps.clearRequest,
    busyCount: () => deps.busy.reduce((sum, count) => sum + count(), 0),
    detectSupervisor: deps.detectSupervisor,
    closeIntake: deps.closeIntake,
    send: deps.send,
    beforeShutdown: async () => void (await deps.farewell()),
    shutdown: deps.shutdown,
    isShuttingDown: deps.isShuttingDown,
  });
  const schedule = deps.schedule ?? ((run: () => void, ms: number) => void setTimeout(run, ms).unref());
  return {
    maybeRestart: (trigger: string, chatId?: string, topicId?: number) => control.maybeRestart(trigger, chatId, topicId),
    /** Kurz nach einer Antwort prüfen */
    afterReply: (trigger: string, chatId?: string, topicId?: number) =>
      schedule(() => void control.maybeRestart(trigger, chatId, topicId), deps.delayMs ?? 3000),
  };
}
