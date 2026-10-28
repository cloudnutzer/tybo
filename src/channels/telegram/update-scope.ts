/**
 * Bereich eines Telegram-Updates (Issue #344): jede Nachricht und jeder Knopf
 * läuft unter dem Session-Schlüssel ihres Gesprächs (derselbe wie bei
 * Web-Turns), damit /stop sie abbrechen kann und die Grenze gleichzeitiger
 * Aufträge greift.
 *
 * Ausnahmen laufen sofort und ohne Bereich: /stop, /new, /motor, /engine und
 * /goal pause|stop. Hinter einem laufenden Turn eingereiht kämen sie zu spät,
 * und der Reset von /motor prüft, ob im Gespräch eine Antwort läuft, und
 * träfe sonst sich selbst.
 */
import { sessionKeyFor } from "../../lib/store/message-rules";
import type { CancelableOptions } from "../../lib/execution-context";

const IMMEDIATE = /^\/(?:stop|new|motor|engine|goal\s+(?:pause|stop))\b/i;

/** Muss der Text sofort laufen, statt hinter einem Turn zu warten? */
export function runsImmediately(text: string): boolean {
  return IMMEDIATE.test(text);
}

export interface ScopedUpdate {
  chat?: { id: number | string };
  /** Nur die eingehende Nachricht zählt als Befehl, nie die Nachricht unter einem Knopf */
  message?: { text?: string };
  msg?: { message_thread_id?: number };
  reply(text: string, other?: Record<string, unknown>): Promise<unknown>;
}

export interface UpdateScopeDeps {
  runCancelable(key: string, run: () => Promise<void>, options: CancelableOptions): Promise<void>;
  /** Hinweis, wenn der Turn auf einen freien Platz wartet (Issue #188) */
  queueNotice(send: (text: string) => Promise<unknown>): NonNullable<CancelableOptions["onQueueWait"]>;
  isRestartPending(error: unknown): boolean;
  isAbort(error: unknown): boolean;
  restartPendingText: string;
}

export function createUpdateScope(deps: UpdateScopeDeps): (ctx: ScopedUpdate, run: () => Promise<void>) => Promise<void> {
  return async (ctx, run) => {
    const text = ctx.message?.text ?? "";
    if (runsImmediately(text)) return run();
    const threadId = ctx.msg?.message_thread_id;
    const key = sessionKeyFor(String(ctx.chat?.id ?? ""), threadId ?? null);
    try {
      await deps.runCancelable(key, run, { onQueueWait: deps.queueNotice(notice => ctx.reply(notice)) });
    } catch (error) {
      // Während des Neustarts (Issue #190): Bescheid statt stillem Abbruch
      if (deps.isRestartPending(error)) {
        await ctx.reply(deps.restartPendingText, { message_thread_id: threadId }).catch(() => {});
        return;
      }
      // Abbruch per /stop ist kein Fehler
      if (!deps.isAbort(error)) throw error;
    }
  };
}
