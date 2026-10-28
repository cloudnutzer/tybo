/**
 * Telegram-Medien-Eingang (Issue #334): ein Ablauf für Sprache, Foto,
 * Dokument und Video (auch Rundvideo). Früher standen dafür vier fast gleiche
 * Handler in src/bot.ts.
 *
 * Ablauf je Nachricht: Art und Datei bestimmen, Datei über
 * downloadTelegramFile holen (höchstens 20 MB, auch wenn Telegram keine oder
 * eine falsche Größe meldet), Medien-Kern (src/lib/media-turn.ts) vorbereiten
 * lassen, Nutzernachricht speichern, Turn mit Fortschritt, bei Abbruch nur
 * die Abbruch-Meldung, sonst Antwort nachbereiten und an den gemeinsamen
 * Abschluss geben (src/lib/turn-finish.ts, Issue #339: speichern, Merk-Tags,
 * /goal, [INVOKE:] oder Antwort mit Rückfrage, offene Fäden), zuletzt
 * aufräumen. Den Turn selbst, das Speichern und Senden liefert der Bot als
 * Abhängigkeit.
 */

import type { Context } from "grammy";
import { ABORT_REPLY, SHUTDOWN_ABORT_REPLY, type TurnInfo, type TurnQuestion } from "../../lib/chat-turn";
import { isAbortError } from "../../lib/execution-context";
import type { MediaInput, MediaKind, PreparedMedia } from "../../lib/media-turn";
import type { FinishedTurn } from "../../lib/turn-finish";
import type { TurnTools } from "../../lib/turn-tools";

/** Mehr liefert die Bot API über getFile nicht aus */
export const TELEGRAM_FILE_LIMIT = 20 * 1024 * 1024;

const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export interface TelegramFileApi {
  getFile(fileId: string): Promise<{ file_path?: string; file_size?: number }>;
}

export interface TelegramDownloadOptions {
  token: string;
  /** Größe laut Nachricht; ungültige Werte zählen als unbekannt */
  declaredSize?: unknown;
  limit?: number;
  fetch?: (url: string) => Promise<Response>;
}

export type TelegramDownload =
  | { ok: true; bytes: Uint8Array; filePath: string }
  | { ok: false; reason: "too_large"; size?: number }
  | { ok: false; reason: "no_path" };

/** Fehler beim Laden; die Meldung enthält nie den Bot-Token */
export class TelegramDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramDownloadError";
  }
}

function knownSize(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function withoutToken(text: string, token: string): string {
  return token ? text.split(token).join("<token>") : text;
}

/**
 * Neuer Fehler nur aus der bereinigten Meldung. Den ursprünglichen Fehler
 * nicht anhängen: ein grammY-HttpError trägt unter error den Fehler von
 * fetch, dessen Meldung und Stack die URL samt Token enthalten können.
 */
function downloadFailure(step: string, err: unknown, token: string): TelegramDownloadError {
  const reason = err instanceof Error ? err.message : String(err);
  return new TelegramDownloadError(`Telegram-Download fehlgeschlagen (${step}): ${withoutToken(reason, token)}`);
}

/**
 * Datei von Telegram laden. Zu groß ist sie, wenn schon die gemeldete Größe
 * (Nachricht, getFile, Content-Length) über der Grenze liegt oder beim Lesen
 * mehr Bytes ankommen; dann wird abgebrochen, bevor mehr gelesen wird.
 */
export async function downloadTelegramFile(
  api: TelegramFileApi,
  fileId: string,
  options: TelegramDownloadOptions,
): Promise<TelegramDownload> {
  const limit = options.limit ?? TELEGRAM_FILE_LIMIT;
  const declared = knownSize(options.declaredSize);
  if (declared !== undefined && declared > limit) return { ok: false, reason: "too_large", size: declared };

  let info: { file_path?: string; file_size?: number };
  try {
    info = await api.getFile(fileId);
  } catch (err) {
    throw downloadFailure("getFile", err, options.token);
  }
  const reported = knownSize(info.file_size);
  if (reported !== undefined && reported > limit) return { ok: false, reason: "too_large", size: reported };
  if (!info.file_path) return { ok: false, reason: "no_path" };

  const load = options.fetch ?? ((url: string) => fetch(url));
  let response: Response;
  try {
    response = await load(`https://api.telegram.org/file/bot${options.token}/${info.file_path}`);
  } catch (err) {
    throw downloadFailure("Abruf", err, options.token);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new TelegramDownloadError(`Telegram-Download fehlgeschlagen: HTTP ${response.status}`);
  }

  const header = knownSize(Number(response.headers.get("content-length") ?? NaN));
  if (header !== undefined && header > limit) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, reason: "too_large", size: header };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read().catch((err: unknown) => {
        throw downloadFailure("Lesen", err, options.token);
      });
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes, filePath: info.file_path };
}

// ---------------------------------------------------------------------------
// Was in der Nachricht steckt
// ---------------------------------------------------------------------------

export interface IncomingMedia {
  kind: MediaKind;
  fileId: string;
  size?: number;
  caption?: string;
  /** Dateiname laut Telegram (Dokument, Video) */
  fileName?: string;
  durationSec?: number;
}

/**
 * Art und Datei einer Telegram-Nachricht. Foto: die größte Auflösung. Ein als
 * Dokument geschicktes Bild bleibt ein Dokument. Video und Rundvideo sind
 * beide Video.
 */
export function incomingMedia(message: any): IncomingMedia | null {
  if (!message) return null;
  const caption: string | undefined = message.caption;
  if (message.voice) {
    return { kind: "audio", fileId: message.voice.file_id, size: message.voice.file_size };
  }
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const biggest = message.photo[message.photo.length - 1];
    return { kind: "image", fileId: biggest.file_id, size: biggest.file_size, caption };
  }
  if (message.document) {
    const doc = message.document;
    return { kind: "document", fileId: doc.file_id, size: doc.file_size, caption, fileName: doc.file_name };
  }
  const clip = message.video ?? message.video_note;
  if (clip) {
    return {
      kind: "video",
      fileId: clip.file_id,
      size: clip.file_size,
      caption,
      fileName: message.video?.file_name,
      durationSec: clip.duration,
    };
  }
  return null;
}

/** Endung aus dem Telegram-Pfad (z. B. photos/file_3.jpg), sonst leer */
function pathExt(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

/** Eingabe für den Medien-Kern; Endungs- und Namensregeln wie bisher je Art */
export function mediaInputFor(
  item: IncomingMedia,
  bytes: Uint8Array,
  filePath: string,
  target: { chatId: string; topicId?: number },
  now: number,
): MediaInput {
  const base = { bytes, chatId: target.chatId, topicId: target.topicId };
  switch (item.kind) {
    case "audio":
      return { ...base, kind: "audio", ext: "ogg", source: { channel: "telegram" } };
    case "image":
      return {
        ...base,
        kind: "image",
        ext: pathExt(filePath) || "jpg",
        caption: item.caption,
        source: { channel: "telegram", telegramFileId: item.fileId },
      };
    case "document":
      return {
        ...base,
        kind: "document",
        ext: item.fileName?.match(/\.([a-zA-Z0-9]{1,10})$/)?.[1] || "",
        caption: item.caption,
        fileName: item.fileName,
        source: { channel: "telegram", telegramFileId: item.fileId },
      };
    case "video": {
      const ext = pathExt(filePath) || "mp4";
      return {
        ...base,
        kind: "video",
        ext,
        caption: item.caption,
        // Rundvideos haben keinen Namen: wie bisher video_<Zeit>.<Endung>
        fileName: item.fileName || `video_${now}.${ext}`,
        durationSec: item.durationSec,
        source: { channel: "telegram" },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Antworttexte
// ---------------------------------------------------------------------------

const WORDS: Record<MediaKind, { noun: string; failed: string; subject: string; pronoun: string }> = {
  audio: { noun: "voice message", failed: "voice message", subject: "Die Sprachnachricht", pronoun: "sie" },
  image: { noun: "photo", failed: "image", subject: "Das Foto", pronoun: "es" },
  document: { noun: "document", failed: "document", subject: "Die Datei", pronoun: "sie" },
  video: { noun: "video", failed: "video", subject: "Das Video", pronoun: "es" },
};

export const MEDIA_INBOX_TEXT = {
  noPath: (kind: MediaKind) => `Could not download ${WORDS[kind].noun}.`,
  failed: (kind: MediaKind) => `Sorry, I couldn't process that ${WORDS[kind].failed}. Please try again.`,
  tooLarge: (kind: MediaKind, size?: number) => {
    const w = WORDS[kind];
    const how = size !== undefined ? `ist ${(size / MB).toFixed(1)} MB groß` : `ist größer als ${TELEGRAM_FILE_LIMIT / MB} MB`;
    return (
      `${w.subject} ${how}. Telegram-Bots können nur Dateien bis ${TELEGRAM_FILE_LIMIT / MB} MB herunterladen. ` +
      `Schick ${w.pronoun} kleiner (unter ${TELEGRAM_FILE_LIMIT / MB} MB) oder als Link (YouTube, Drive usw.).`
    );
  },
};

// ---------------------------------------------------------------------------
// Ein Ablauf für alle Arten
// ---------------------------------------------------------------------------

type TurnCollector = {
  onInfo: (info: TurnInfo) => void;
  onTools: (tools: TurnTools | undefined) => void;
  tools: () => TurnTools | undefined;
  metadata: () => Record<string, unknown>;
};

export interface MediaInboxDeps {
  download: (item: IncomingMedia, ctx: Context) => Promise<TelegramDownload>;
  prepare: (input: MediaInput) => Promise<PreparedMedia>;
  finish: (prepared: PreparedMedia, response: string) => string;
  cleanup: (prepared: PreparedMedia) => Promise<void>;
  /** Nutzernachricht; die Antwort speichert der gemeinsame Abschluss */
  saveMessage: (message: { chat_id: string; role: "user" | "assistant"; content: string; metadata: Record<string, unknown> }) => Promise<unknown>;
  agentFor: (chatId: string, topicId: number | undefined) => string;
  turnHint: (chatId: string, topicId: number | undefined) => Promise<string | undefined>;
  runTurn: (
    ctx: Context,
    prompt: string,
    chatId: string,
    agentName: string,
    topicId: number | undefined,
    turn: TurnCollector,
    hint: string | undefined,
    onQuestion: (question: TurnQuestion) => void,
  ) => Promise<string>;
  newTurn: () => TurnCollector;
  /** Gemeinsamer Abschluss (createTurnFinish), derselbe wie für Text */
  finishTurn: (turn: FinishedTurn) => Promise<void>;
  /** Antwort im Gespräch der Nachricht zeigen */
  send: (ctx: Context, response: string) => Promise<void>;
  isShuttingDown: () => boolean;
  typing: (ctx: Context) => { start(): void; stop(): void };
  now: () => number;
  logError: (message: string, err: unknown) => void;
}

/**
 * Eine Medien-Nachricht aus Telegram verarbeiten. Fehler enden in einer
 * Entschuldigung an den Nutzer; die Tippanzeige endet in jedem Fall. Die
 * Sprachdatei räumt der Medien-Kern nach dem Senden weg, im Fehlerfall
 * bleibt sie wie bisher liegen. Ein Abbruch (/stop, Neustart) meldet sich
 * nur, ohne Nachbereitung, Speichern, Merk-Tags, /goal oder Rückfrage.
 */
export async function handleTelegramMedia(ctx: Context, deps: MediaInboxDeps): Promise<void> {
  const item = incomingMedia(ctx.message);
  if (!item) return;
  const chatId = String(ctx.chat?.id || "");
  // Vor dem ersten Speichern: beide Nachrichten landen im Verlauf des Topics (Issue #20)
  const thread: unknown = (ctx.message as { message_thread_id?: unknown } | undefined)?.message_thread_id;
  const topicId = typeof thread === "number" ? thread : undefined;
  const typing = deps.typing(ctx);
  const aborted = () => ctx.reply(deps.isShuttingDown() ? SHUTDOWN_ABORT_REPLY : ABORT_REPLY).catch(() => {});
  typing.start();
  let prepared: PreparedMedia | undefined;
  try {
    const file = await deps.download(item, ctx);
    if (!file.ok) {
      await ctx.reply(file.reason === "no_path" ? MEDIA_INBOX_TEXT.noPath(item.kind) : MEDIA_INBOX_TEXT.tooLarge(item.kind, file.size));
      return;
    }

    prepared = await deps.prepare(mediaInputFor(item, file.bytes, file.filePath, { chatId, topicId }, deps.now()));
    await deps.saveMessage({ chat_id: chatId, role: "user", content: prepared.userContent, metadata: prepared.userMetadata });

    const agentName = deps.agentFor(chatId, topicId);
    const startedAt = deps.now();
    const turn = deps.newTurn();
    let question: TurnQuestion | undefined;
    const raw = await deps.runTurn(ctx, prepared.prompt, chatId, agentName, topicId, turn, await deps.turnHint(chatId, topicId), q => {
      question = q;
    });
    if (raw === ABORT_REPLY) {
      await aborted();
      await deps.cleanup(prepared);
      return;
    }
    const reply = deps.finish(prepared, raw);

    await deps.finishTurn({
      chatId,
      ...(topicId !== undefined ? { topicId } : {}),
      agentName,
      reply,
      metadata: { ...prepared.replyMetadata, agent: agentName, ...turn.metadata() },
      tools: turn.tools(),
      ...(prepared.foreignInput ? { foreignInput: prepared.foreignInput } : {}),
      ...(question ? { question } : {}),
      threads: { userText: prepared.classifyText, startedAt },
      send: text => deps.send(ctx, text),
    });
    await deps.cleanup(prepared);
  } catch (error) {
    // Abbruch, der erst als Ausnahme ankommt, ist kein Fehler (wie bei Text)
    if (isAbortError(error)) {
      await aborted();
      if (prepared) await deps.cleanup(prepared);
      return;
    }
    deps.logError(`Telegram ${item.kind} processing error:`, error);
    await ctx.reply(MEDIA_INBOX_TEXT.failed(item.kind)).catch(() => {});
  } finally {
    typing.stop();
  }
}
