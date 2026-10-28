/**
 * Ein Sendeweg für Telegram (Issue #328). sendRendered macht aus einem Text
 * die Stücke, die Telegram annimmt, und schickt sie nacheinander über eine
 * Übertragungsfunktion für genau ein sendMessage: grammY-Api, ctx.reply oder
 * direkter fetch an die Bot-API. Alle Sendewege (Antwort im Chat, Laufzeit,
 * Agenten-Bots, Outbox, Dienste ohne Bot) sind dünne Hüllen darum und tragen
 * nur ihren eigenen Vertrag bei: Ziel, wann auf Klartext zurückgefallen wird,
 * ob nach einem gescheiterten Stück weitergemacht wird, was sie zurückgeben.
 *
 * Für jedes Stück gilt:
 * - Markdown wird mit renderTelegram zu gültigem HTML geteilt, Klartext mit
 *   splitPlainText nach sanitizeModelOutput (ohne parse_mode).
 * - Link-Vorschau aus, auch im Klartext-Rückfall (Issue #52).
 * - message_thread_id nur, wenn eine Thread-ID angegeben ist.
 * - Knöpfe hängen nur am letzten Stück, bestimmt über die Position, nie über
 *   den Text: gleiche Stücke bekommen sie also nicht mehrfach. Der
 *   Klartext-Rückfall dieses Stücks trägt sie ebenfalls.
 * - Der Bericht nennt je Stück, ob Telegram es angenommen hat (mit
 *   Nachrichten-ID, wenn lesbar), sicher abgelehnt hat (4xx mit ok: false)
 *   oder ob es unklar ist (Netzfehler, Zeitüberschreitung, 5xx, unlesbar).
 *
 * Außerdem hier: die Antwort im Chat (sendResponse, mit Sprach- und
 * Bildzweig), der Versand ohne grammY (sendTelegramMessage) und der
 * Tipp-Indikator, der nur sendChatAction kennt und mit sendRendered nichts zu
 * tun hat.
 *
 * Importregel: src/lib/telegram.ts wird von format.ts gebraucht und darf
 * dieses Modul weder importieren noch weiterreichen; Aufrufer holen sich die
 * Sendefunktionen direkt hier.
 */

import { GrammyError, InputFile, type Api, type Context } from "grammy";
import { htmlToPlainText, renderTelegram, splitPlainText } from "./format";
import { guardTelegramPayload, NO_LINK_PREVIEW, sanitizeModelOutput } from "../../lib/telegram";

// ------------------------------------------------------------
// Bausteine
// ------------------------------------------------------------

/** markdown: als Telegram-HTML; plain: unverändert (nur bereinigt), ohne parse_mode */
export type TextFormat = "markdown" | "plain";

/** Nutzlast für genau einen sendMessage-Aufruf */
export interface OutgoingMessage {
  chat_id: string | number;
  text: string;
  message_thread_id?: number;
  parse_mode?: "HTML";
  link_preview_options: typeof NO_LINK_PREVIEW;
  reply_markup?: unknown;
}

/** Was aus einem einzelnen sendMessage wurde */
export type Delivery =
  | { outcome: "accepted"; messageId?: number }
  /** Telegram hat geantwortet: 4xx mit ok: false, das Stück kam sicher nicht an */
  | { outcome: "rejected"; status: number; detail?: string }
  /** Ob etwas ankam, ist offen: Netzfehler, Zeitüberschreitung, 5xx, unlesbare Antwort */
  | { outcome: "unclear"; status?: number; error?: unknown; detail?: string };

/** Schickt genau eine Nachricht; wirft eine Übertragung trotzdem, zählt das als unklar */
export type Transmit = (message: OutgoingMessage) => Promise<Delivery>;

/** Wann ein gescheitertes HTML-Stück noch einmal als Klartext geht */
export type PlainRetry = "on-any-failure" | "on-bad-request";

export interface RenderedSend {
  text: string;
  format: TextFormat;
  chatId: string | number;
  threadId?: number;
  /** reply_markup des letzten Stücks, unverändert weitergegeben */
  keyboard?: unknown;
  transmit: Transmit;
  /** Standard: bei jedem Fehler */
  plainRetry?: PlainRetry;
  /** Standard: mit dem nächsten Stück weitermachen */
  afterFailure?: "continue" | "stop";
}

export interface PieceResult {
  /** Position des Stücks, ab 0 */
  index: number;
  /** Endgültiger Ausgang, beim Rückfall der des Klartexts */
  delivery: Delivery;
  /** Ausgang des HTML-Versuchs, wenn danach der Klartext ging */
  htmlAttempt?: Delivery;
  /** Trug die Knöpfe */
  keyboard: boolean;
}

export interface SendReport {
  /** Anzahl der Stücke, in die der Text geteilt wurde */
  total: number;
  /** Nur die versuchten Stücke; nach einem Abbruch fehlen die übrigen */
  pieces: PieceResult[];
  /** Kein Stück gescheitert oder ausgelassen (auch bei null Stücken) */
  complete: boolean;
}

/** Stücke, wie sie an Telegram gehen */
export function piecesFor(text: string, format: TextFormat): string[] {
  if (format === "plain") return splitPlainText(sanitizeModelOutput(text));
  return renderTelegram(text);
}

function wantsPlainRetry(rule: PlainRetry, delivery: Delivery): boolean {
  if (delivery.outcome === "accepted") return false;
  if (rule === "on-any-failure") return true;
  return delivery.status === 400;
}

async function attempt(transmit: Transmit, message: OutgoingMessage): Promise<Delivery> {
  try {
    return await transmit(message);
  } catch (error) {
    return { outcome: "unclear", error };
  }
}

/** Teilt, sendet Stück für Stück, fällt nach Regel auf Klartext zurück; wirft nicht */
export async function sendRendered(request: RenderedSend): Promise<SendReport> {
  const asHtml = request.format === "markdown";
  const pieces = piecesFor(request.text, request.format);
  const retry = request.plainRetry ?? "on-any-failure";
  const lastIndex = pieces.length - 1;
  const results: PieceResult[] = [];

  for (let index = 0; index <= lastIndex; index++) {
    const withKeyboard = index === lastIndex && Boolean(request.keyboard);
    const frame = {
      chat_id: request.chatId,
      ...(request.threadId ? { message_thread_id: request.threadId } : {}),
      link_preview_options: NO_LINK_PREVIEW,
      ...(withKeyboard ? { reply_markup: request.keyboard } : {}),
    };
    const piece = pieces[index];
    let delivery = await attempt(request.transmit, { ...frame, text: piece, ...(asHtml ? { parse_mode: "HTML" as const } : {}) });
    let htmlAttempt: Delivery | undefined;
    if (asHtml && wantsPlainRetry(retry, delivery)) {
      htmlAttempt = delivery;
      delivery = await attempt(request.transmit, { ...frame, text: htmlToPlainText(piece) });
    }
    results.push({ index, delivery, keyboard: withKeyboard, ...(htmlAttempt ? { htmlAttempt } : {}) });
    if (delivery.outcome !== "accepted" && request.afterFailure === "stop") break;
  }

  return {
    total: pieces.length,
    pieces: results,
    complete: results.length === pieces.length && results.every(r => r.delivery.outcome === "accepted"),
  };
}

/** Kurzer Grund für Logs: HTTP-Status oder Name des Fehlers, nie Inhalt */
export function deliveryReason(delivery: Delivery): string {
  if (delivery.outcome === "accepted") return "angenommen";
  if (delivery.status !== undefined) return `HTTP ${delivery.status}`;
  const error = delivery.outcome === "unclear" ? delivery.error : undefined;
  return error instanceof Error ? error.name : "unbekannt";
}

/** Schreibt jedes Stück, das auch im Rückfall nicht ankam, ins Fehlerlog */
export function logLostPieces(report: SendReport, label: string): void {
  for (const piece of report.pieces) {
    if (piece.delivery.outcome === "accepted") continue;
    const first = piece.htmlAttempt ? `, HTML zuvor ${deliveryReason(piece.htmlAttempt)}` : "";
    console.error(`[${label}] Stück ${piece.index + 1}/${report.total} nicht zugestellt (${deliveryReason(piece.delivery)}${first})`);
  }
}

// ------------------------------------------------------------
// Übertragungen
// ------------------------------------------------------------

/** Fehler aus grammY: GrammyError trägt die Antwort von Telegram, alles andere ist unklar */
export function deliveryFromError(error: unknown): Delivery {
  if (error instanceof GrammyError) {
    const status = error.error_code;
    if (status >= 400 && status < 500) return { outcome: "rejected", status, detail: error.description };
    return { outcome: "unclear", status, error, detail: error.description };
  }
  return { outcome: "unclear", error };
}

function readMessageId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Antwort der Bot-API: 2xx angenommen (ID, wenn lesbar), 4xx mit ok: false abgelehnt, sonst unklar */
export async function deliveryFromResponse(response: Response): Promise<Delivery> {
  let parsed: { ok?: unknown; description?: unknown; result?: { message_id?: unknown } } | undefined;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    parsed = undefined;
  }
  if (response.ok) return { outcome: "accepted", messageId: readMessageId(parsed?.result?.message_id) };
  const detail = typeof parsed?.description === "string" ? parsed.description : undefined;
  if (response.status >= 400 && response.status < 500 && parsed?.ok === false) return { outcome: "rejected", status: response.status, detail };
  return { outcome: "unclear", status: response.status, detail };
}

/** Über eine grammY-Api (Haupt- oder Agenten-Bot, Output-Guard hängt an der Api) */
export function transmitViaApi(api: Pick<Api, "sendMessage">): Transmit {
  return async ({ chat_id, text, ...rest }) => {
    try {
      const sent = await api.sendMessage(chat_id, text, rest as Parameters<Api["sendMessage"]>[2]);
      return { outcome: "accepted", messageId: readMessageId(sent?.message_id) };
    } catch (error) {
      return deliveryFromError(error);
    }
  };
}

/** Als Antwort im Chat des Updates; grammY setzt die Thread-ID eines Topics selbst */
export function transmitViaReply(ctx: Pick<Context, "reply">): Transmit {
  return async ({ chat_id: _chat, text, ...rest }) => {
    try {
      const sent = await ctx.reply(text, rest as Parameters<Context["reply"]>[1]);
      return { outcome: "accepted", messageId: readMessageId(sent?.message_id) };
    } catch (error) {
      return deliveryFromError(error);
    }
  };
}

export interface BotApiPost {
  token: string;
  /** Standard der globale fetch */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Zeitlimit je Aufruf in Millisekunden; ohne Angabe keins */
  timeoutMs?: number;
}

/** Direkt an die Bot-API, ohne grammY; die Nutzlast läuft durch guardTelegramPayload */
export function transmitViaBotApi(post: BotApiPost): Transmit {
  return async message => {
    const doFetch = post.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
    const response = await doFetch(`https://api.telegram.org/bot${post.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(guardTelegramPayload("sendMessage", message)),
      ...(post.timeoutMs ? { signal: AbortSignal.timeout(post.timeoutMs) } : {}),
    });
    return deliveryFromResponse(response);
  };
}

// ------------------------------------------------------------
// Antwort im Chat (früher sendResponse in src/lib/telegram.ts)
// ------------------------------------------------------------

/** [IMAGE:pfad] oder [IMAGE:pfad|Bildtext] in einer Antwort */
const IMAGE_TAG = /\[IMAGE:([^\]|]+)(?:\|([^\]]+))?\]/;

/**
 * Antwort auf ein Update. Mit Sprachwunsch und Sprachfunktion geht nur die
 * Sprachnachricht, solange die Funktion Audio liefert. Ein Bild-Tag wird als
 * Foto geschickt (Bildtext bereinigt, Fehler still), der übrige Text danach.
 * Text als Markdown in Stücken, Rückfall bei jedem Fehler, ein verlorenes
 * Stück wird geloggt und das nächste versucht.
 */
export async function sendResponse(ctx: Context, reply: string, speak?: boolean, toSpeech?: (text: string) => Promise<Buffer | null>): Promise<void> {
  if (speak && toSpeech) {
    const audio = await toSpeech(reply);
    if (audio) {
      await ctx.replyWithVoice(new InputFile(audio, "response.wav"));
      return;
    }
  }

  let rest = reply;
  const image = IMAGE_TAG.exec(reply);
  if (image) {
    const label = image[2]?.trim() ? sanitizeModelOutput(image[2].trim()) : "";
    try {
      await ctx.replyWithPhoto(new InputFile(image[1].trim()), { caption: label || undefined });
    } catch {
      // Ohne Foto geht es mit dem Text weiter
    }
    rest = reply.replace(image[0], "").trim();
    if (!rest) return;
  }

  const report = await sendRendered({ text: rest, format: "markdown", chatId: ctx.chat?.id ?? 0, transmit: transmitViaReply(ctx) });
  logLostPieces(report, "Telegram");
}

// ------------------------------------------------------------
// Versand ohne grammY (früher sendTelegramMessage in src/lib/telegram.ts)
// ------------------------------------------------------------

export interface DirectSendOptions {
  /** Gesetzt: Markdown als HTML mit Rückfall bei 400; sonst Klartext ohne Rückfall */
  parseMode?: "HTML";
  buttons?: { text: string; callback_data: string }[][];
}

/**
 * Schickt über die Bot-API per fetch, ohne Bot-Prozess. Ein gescheitertes
 * Stück hält die übrigen nicht auf; true nur, wenn jedes ankam.
 */
export async function sendTelegramMessage(token: string, chat: string, text: string, options: DirectSendOptions = {}): Promise<boolean> {
  const report = await sendRendered({
    text,
    format: options.parseMode ? "markdown" : "plain",
    chatId: chat,
    keyboard: options.buttons?.length ? { inline_keyboard: options.buttons } : undefined,
    transmit: transmitViaBotApi({ token }),
    plainRetry: "on-bad-request",
  });
  logLostPieces(report, "Telegram");
  return report.complete;
}

// ------------------------------------------------------------
// Tipp-Indikator
// ------------------------------------------------------------

/** Telegram zeigt "schreibt …" rund 5 s; so oft wird es erneuert */
export const TYPING_REFRESH_MS = 4000;

export interface TypingIndicator {
  start(): void;
  stop(): void;
}

/**
 * "schreibt …" im Chat (und Topic) des Updates, sofort und dann alle 4 s bis
 * stop(). Nur sendChatAction, nie eine Textnachricht; Fehler werden
 * geschluckt.
 */
export function createTypingIndicator(ctx: Pick<Context, "replyWithChatAction">): TypingIndicator {
  let timer: ReturnType<typeof setInterval> | undefined;
  const signal = () => {
    ctx.replyWithChatAction("typing").catch(() => undefined);
  };
  const halt = () => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };
  return {
    start() {
      halt();
      signal();
      timer = setInterval(signal, TYPING_REFRESH_MS);
    },
    stop: halt,
  };
}
