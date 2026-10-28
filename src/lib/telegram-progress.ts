/**
 * Fortschritt eines Turns in Telegram (Issue #329, zuvor #52): eine
 * Statusnachricht „Arbeite daran …“, darunter je Werkzeug und für den ersten
 * Textanfang eine Zeile. Sobald der Turn fertig ist (Antwort, Abbruch oder
 * Fallback), wird die Nachricht gelöscht.
 *
 * Bearbeitet wird gedrosselt: zwischen zwei Aufrufen an Telegram (Senden oder
 * Bearbeiten) liegen mindestens PROGRESS_EDIT_INTERVAL_MS. Meldungen innerhalb
 * dieses Fensters werden gebündelt und mit einer Bearbeitung nachgereicht,
 * auch wenn danach keine Meldung mehr kommt. Ablauf im Einzelnen:
 * - start sendet die Statusnachricht sofort; die erste Bearbeitung folgt
 *   frühestens ein Intervall nach Beginn dieses Sendens.
 * - Läuft ein Aufruf noch (langsame API), wartet die nächste Bearbeitung auf
 *   sein Ende und auf das Intervall, nie zwei Aufrufe gleichzeitig.
 * - progress gibt kein Promise zurück: guardSink in chat-turn.ts wartet vor
 *   finish auf alle Promises aus progress, eine wartende Bearbeitung würde
 *   sonst Antwort, Abbruch und Fallback verzögern.
 * - finish verwirft noch nicht gezeigte Zeilen (die Nachricht verschwindet
 *   ohnehin), hält den Zeitgeber an, wartet einen laufenden Aufruf ab und
 *   löscht dann die Nachricht. So überholt keine späte Bearbeitung das Löschen.
 *
 * Fehler von Telegram (zu alte Nachricht, Netz) werden geschluckt; derselbe
 * Text wird nicht erneut versucht, erst eine neue Meldung löst wieder einen
 * Aufruf aus. Textanfänge kommen aus telegramText (vor der Kürzung bereinigt,
 * Issue #52), sonst aus text; die WebUI bekommt ihre Meldungen unverändert
 * über ihren eigenen Sink.
 */
import type { Api, Context } from "grammy";
import { escapeTelegramHtml, TELEGRAM_TEXT_MAX } from "../channels/telegram/format";
import type { TurnProgress, TurnSink } from "./chat-turn";
import { NO_LINK_PREVIEW } from "./telegram";

/** Mindestabstand zwischen zwei Aufrufen an Telegram für dieselbe Statusnachricht */
export const PROGRESS_EDIT_INTERVAL_MS = 1500;

/** Kopfzeile der Statusnachricht */
export const PROGRESS_HEADER = "<i>Arbeite daran …</i>";

/** Längster Werkzeug- oder Textanteil einer Zeile vor dem Maskieren */
const LINE_TEXT_MAX = 300;

/** Uhr und Zeitgeber, in Tests durch eine Attrappe ersetzbar */
export interface ProgressClock {
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const realClock: ProgressClock = {
  now: () => Date.now(),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ProgressOptions {
  clock?: ProgressClock;
  intervalMs?: number;
}

/** HTML-Zeile für eine Meldung; leer, wenn Telegram dazu nichts zeigen soll */
export function progressLine(p: TurnProgress): string {
  if (p.kind === "tool") return `→ ${escapeTelegramHtml(p.text.slice(0, LINE_TEXT_MAX))}`;
  // Leerer telegramText: nach dem Bereinigen blieb kein brauchbarer Anfang übrig
  const snippet = p.telegramText ?? p.text;
  if (!snippet) return "";
  return `→ <i>„${escapeTelegramHtml(snippet.slice(0, LINE_TEXT_MAX))} …“</i>`;
}

/**
 * Text der Statusnachricht. Passt er nicht in eine Telegram-Nachricht, fallen
 * die ältesten Zeilen weg und ein Hinweis nennt, wie viele.
 */
export function renderProgress(lines: readonly string[], max = TELEGRAM_TEXT_MAX): string {
  const compose = (from: number): string => {
    const parts = [PROGRESS_HEADER];
    if (from === 1) parts.push("<i>(1 früherer Schritt ausgeblendet)</i>");
    else if (from > 1) parts.push(`<i>(${from} frühere Schritte ausgeblendet)</i>`);
    return [...parts, ...lines.slice(from)].join("\n");
  };
  let from = 0;
  let text = compose(from);
  while (text.length > max && from < lines.length - 1) text = compose(++from);
  return text;
}

/** Optionen der Statusnachricht beim Senden und Bearbeiten */
type ProgressSendOptions = { parse_mode: "HTML"; link_preview_options: typeof NO_LINK_PREVIEW };

/**
 * Die Statusnachricht in einem Chat: senden, bearbeiten, löschen. Über den
 * Context der eingegangenen Nachricht (ctxProgressMessages) oder ohne ihn
 * direkt über die Bot-API (chatProgressMessages, Issue #366: Aufträge aus
 * Anrufen laufen ohne Telegram-Context).
 */
export interface ProgressMessages {
  send(text: string, options: ProgressSendOptions): Promise<{ message_id: number }>;
  edit(messageId: number, text: string, options: ProgressSendOptions): Promise<unknown>;
  remove(messageId: number): Promise<unknown>;
}

/** Statusnachricht als Antwort auf die eingegangene Nachricht (grammY setzt dabei das Topic) */
export function ctxProgressMessages(ctx: Context): ProgressMessages {
  return {
    send: (text, options) => ctx.reply(text, options),
    edit: (messageId, text, options) => ctx.api.editMessageText(ctx.chat!.id, messageId, text, options),
    remove: messageId => ctx.api.deleteMessage(ctx.chat!.id, messageId),
  };
}

/** Statusnachricht im Chat samt Topic über die Bot-API, ohne Telegram-Context */
export function chatProgressMessages(api: Pick<Api, "sendMessage" | "editMessageText" | "deleteMessage">, chatId: string, topicId?: number): ProgressMessages {
  return {
    send: (text, options) => api.sendMessage(chatId, text, { ...options, ...(topicId !== undefined ? { message_thread_id: topicId } : {}) }),
    edit: (messageId, text, options) => api.editMessageText(chatId, messageId, text, options),
    remove: messageId => api.deleteMessage(chatId, messageId),
  };
}

export function createTelegramProgressSink(
  ctx: Context,
  notice: (text: string) => Promise<unknown>,
  options: ProgressOptions = {}
): TurnSink {
  return createProgressSink(ctxProgressMessages(ctx), notice, options);
}

/** Wie createTelegramProgressSink, mit beliebigem Weg für die Statusnachricht */
export function createProgressSink(
  messages: ProgressMessages,
  notice: (text: string) => Promise<unknown>,
  options: ProgressOptions = {}
): TurnSink {
  const clock = options.clock ?? realClock;
  const interval = options.intervalMs ?? PROGRESS_EDIT_INTERVAL_MS;
  const sendOptions = { parse_mode: "HTML" as const, link_preview_options: NO_LINK_PREVIEW };

  const lines: string[] = [];
  let messageId: number | undefined;
  /** Zuletzt an Telegram gegebener Text, auch wenn der Aufruf scheiterte */
  let attempted: string | undefined;
  /** Beginn des letzten Aufrufs */
  let lastCallAt = Number.NEGATIVE_INFINITY;
  let running: Promise<void> | undefined;
  let timer: unknown;
  let hasTimer = false;
  let closed = false;

  const call = (text: string): Promise<void> => {
    attempted = text;
    lastCallAt = clock.now();
    const job = (async () => {
      try {
        if (messageId === undefined) {
          const sent = await messages.send(text, sendOptions);
          messageId = sent.message_id;
        } else {
          await messages.edit(messageId, text, sendOptions);
        }
      } catch {
        // Zu alte Nachricht, gleicher Text, Netz: der Fortschritt ist verzichtbar
      }
    })();
    running = job.then(() => {
      running = undefined;
      plan();
    });
    return running;
  };

  /** Startet den nächsten Aufruf jetzt oder stellt den Zeitgeber, falls es Neues gibt */
  function plan(): void {
    if (closed || running || hasTimer) return;
    const text = renderProgress(lines);
    if (text === attempted) return;
    const wait = lastCallAt + interval - clock.now();
    if (wait <= 0) {
      void call(text);
      return;
    }
    hasTimer = true;
    timer = clock.setTimer(() => {
      hasTimer = false;
      plan();
    }, wait);
  }

  return {
    start() {
      if (closed || running || attempted !== undefined) return running;
      return call(renderProgress(lines));
    },
    progress(p) {
      if (closed) return;
      const line = progressLine(p);
      if (!line) return;
      lines.push(line);
      plan();
    },
    async notice(text) {
      await notice(text);
    },
    async finish() {
      if (closed) return;
      closed = true;
      if (hasTimer) {
        clock.clearTimer(timer);
        hasTimer = false;
      }
      if (running) await running;
      if (messageId === undefined) return;
      try {
        await messages.remove(messageId);
      } catch {
        // Zu alte Nachricht: bleibt eben stehen
      }
    },
  };
}
