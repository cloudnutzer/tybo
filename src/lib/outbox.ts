/**
 * Senden und festhalten (Entscheidung 0006, Issue #45).
 *
 * sendAndRecord schickt eine Meldung oder Datei an Telegram und hält sie
 * danach im Nachrichten-Speicher des passenden Gesprächs fest, als
 * Nur-Anzeige-Eintrag (metadata.display_only, ohne Embedding). Die WebUI
 * zeigt solche Einträge, kein Kontext-Leser gibt sie an ein Modell weiter.
 *
 * Vertrag:
 * - Ziel: Standard ist der Direktchat (TELEGRAM_USER_ID). topicId wählt ein
 *   Topic der Forum-Gruppe; ohne eingerichtete Gruppe wird abgelehnt, nie in
 *   den Direktchat umgeleitet. Topic 1 (General) geht ohne Thread-ID an die
 *   Gruppe und landet unter group:<chatId>. chatId darf nur der Direktchat
 *   oder die Forum-Gruppe sein.
 * - Inhalt: text, file oder beides (dann zwei Telegram-Nachrichten und zwei
 *   Einträge: erst Text, dann Datei). caption nur mit file, höchstens 1024
 *   Zeichen. Leere Eingabe, Text, der nach der Markdown-Umwandlung leer ist
 *   (etwa "---"), und fehlende oder ungültige source werden abgelehnt.
 * - Text geht als HTML wie sendTelegramMessage (Markdown umgewandelt, lange
 *   Texte in Stücken, bei 400 einmal als reiner Text). Scheitert ein Stück,
 *   bricht der Versand ab und dieser Text wird nicht festgehalten.
 * - format "plain" (Issue #46): Text ohne Umwandlung und ohne parse_mode, in
 *   Stücken wie oben; kein Rückfall bei 400, weil es nichts abzustreifen gibt.
 * - buttons (Issue #46): nur mit text; hängen als inline_keyboard am letzten
 *   Text-Stück, auch beim Klartext-Rückfall. Festgehalten wird nur der Text.
 * - Link-Vorschau (Issue #52): link_preview_options.is_disabled an jedem
 *   Text-Stück, auch im Rückfall, immer. linkPreview false (Issue #46) bleibt
 *   als Angabe erlaubt und ändert nichts mehr.
 * - Bereinigung (Issue #52): Text (auch format "plain") und caption gehen
 *   durch sanitizeModelOutput, Markdown-Bilder also ohne Adresse, ohne
 *   unsichtbare Zeichen. Festgehalten wird der Originaltext.
 * - Datei: höchstens 50 MB, nicht leer. Vor dem Senden nach
 *   data/outbox/<id>/<bereinigter Name> kopiert, gesendet wird die Kopie.
 *   Scheitert das Senden, wird die Kopie wieder entfernt. Scheitert das
 *   Kopieren, wird das Original gesendet, aber nichts festgehalten.
 *   Geprüft wird der Inhalt, der tatsächlich hochgeht: die Kopie bzw. die
 *   gelesenen Bytes des Originals. Ist die Datei inzwischen leer oder über
 *   50 MB (etwa während des Textversands gewachsen), wird sie nicht gesendet
 *   (error invalid; ein vorher gesendeter Text bleibt gesendet).
 * - Nachrichten-IDs (Issue #114): messages listet jede Telegram-Nachricht,
 *   die angenommen wurde, in Sende-Reihenfolge (Text-Stücke, dann Datei),
 *   mit der message_id aus der Antwort, beim Klartext-Rückfall die des
 *   Rückfalls. Auch bei Teilerfolg (sent false) stehen die schon
 *   angenommenen Stücke darin. buttons true trägt nur das Stück mit den
 *   Knöpfen, also das letzte Text-Stück. Liefert Telegram keine lesbare
 *   message_id, fehlt die Nachricht in der Liste; ist die Liste leer, fehlt
 *   das Feld.
 * - Rückfrage (Issue #114): choiceId steht beim Text-Eintrag in
 *   metadata.choiceId, damit die WebUI die Frage im Verlauf findet.
 * - record false (Issue #119): nur senden, nichts festhalten (recorded
 *   false). Für Folge-Nachrichten einer Rückfrage mit mehr Knöpfen, als an
 *   eine Nachricht passen; der Verlauf hat die Frage schon.
 * - Ohne Telegram (Issue #227, telegramConfigured aus channels.ts: Token und
 *   gültige Nutzer-ID): nur festhalten, nie senden, kein Aufruf an
 *   api.telegram.org. Ziel ohne Angabe ist der Web-Direktchat (Chat-ID
 *   "web"); topicId und Telegram-Chat-IDs werden abgelehnt, auch wenn noch
 *   eine Forum-Gruppe konfiguriert ist. Web-Ziele (chatId "web" oder
 *   web:<uuid>) werden auch mit Telegram nur festgehalten. Ergebnis dann
 *   sent false, recorded true ohne error; scheitert das Festhalten oder die
 *   Ablage der Datei, error kind "record" (nichts ist irgendwo angekommen).
 *   buttons fallen dort weg (die WebUI zeigt Rückfragen über choiceId),
 *   record false bewirkt nichts. Zugestellt heißt: outboxDelivered.
 * - Telegram geht vor: Scheitert das Festhalten, bleibt der Versand gültig;
 *   ins Log kommt nur, dass es scheiterte, nie Inhalt oder Zugangsdaten.
 *   Festgehaltenes content ist der Text, bei Dateien die caption oder,
 *   ohne caption, der Dateiname.
 */

import { randomUUID } from "crypto";
import { copyFile, mkdir, rm, stat } from "fs/promises";
import { join, resolve, sep } from "path";
import { getTopicConfigChatIds } from "../agents/base";
import { resolveGroupId } from "../web/bot-telegram";
import { isWebChatId, telegramConfigured, WEB_DM_CHAT_ID } from "./channels";
export { outboxDelivered } from "./channels";
import { PROJECT_ROOT } from "./env";
import {
  chunkForTelegram,
  guardTelegramPayload,
  markdownToTelegramHTML,
  sanitizeModelOutput,
  stripHtmlTags,
} from "./telegram";
import type { Message } from "./supabase";

/** Telegram-Limit für Uploads über die Bot-API */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_CAPTION_CHARS = 1024;
/** Das Forum-Thema General hat in der Bot-API keine Thread-ID */
export const GENERAL_TOPIC_ID = 1;

const SOURCE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const USER_ID_PATTERN = /^\d{1,20}$/;
const GROUP_ID_PATTERN = /^-\d{1,20}$/;
const CHOICE_ID_PATTERN = /^[A-Za-z0-9]{1,12}$/;
const OUTBOX_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_NAME_CHARS = 120;
const SEND_TIMEOUT_MS = 120_000;

export interface SendAndRecordInput {
  text?: string;
  /** Pfad der zu sendenden Datei */
  file?: string;
  /** Anzeigename statt des Namens aus dem Pfad; wird ebenfalls bereinigt */
  fileName?: string;
  caption?: string;
  chatId?: string;
  topicId?: number;
  /** Absender, z. B. pipeline, briefing, checkin, watchdog, watcher, datei */
  source: string;
  /** Standard "markdown" (als HTML); "plain" sendet den Text unverändert ohne parse_mode */
  format?: "markdown" | "plain";
  /** Inline-Buttons am letzten Text-Stück; nur zusammen mit text */
  buttons?: InlineButton[][];
  /** Veraltet: die Link-Vorschau ist seit Issue #52 immer aus; nur false erlaubt */
  linkPreview?: false;
  /** Rückfrage-ID aus dem Register (Issue #114), landet in metadata.choiceId des Text-Eintrags */
  choiceId?: string;
  /** false: nur senden, nicht festhalten (Issue #119); nur false erlaubt */
  record?: false;
}

/** Eine von Telegram angenommene Nachricht (Issue #114) */
export interface SentMessage {
  chatId: string;
  messageId: number;
  part: "text" | "file";
  /** Trägt die Knöpfe (nur das letzte Text-Stück) */
  buttons: boolean;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

/** Absender, der wie sendAndRecord sendet; übergebbar, damit Dienste ohne Netz testbar sind */
export type OutboxSender = (
  input: SendAndRecordInput
) => Promise<Pick<SendAndRecordResult, "sent"> & Partial<Pick<SendAndRecordResult, "recorded" | "error">>>;

export interface OutboxFile {
  id: string;
  name: string;
  size: number;
  mime: string;
}

export interface SendAndRecordResult {
  /** Alles an Telegram gesendet; bei Web-Zielen und ohne Telegram immer false */
  sent: boolean;
  /** Alles Gesendete festgehalten (Web-Ziel: alles festgehalten) */
  recorded: boolean;
  /**
   * "invalid": Eingabe abgelehnt, nichts gesendet (Ausnahme: die Datei riss
   * erst nach dem Textversand das Limit); "send": Telegram scheiterte;
   * "record": Web-Ziel, Festhalten oder Ablage scheiterte (Issue #227)
   */
  error?: { kind: "invalid" | "send" | "record"; message: string };
  /** Ablage der Datei, wenn sie kopiert und gesendet wurde */
  file?: OutboxFile & { path: string };
  /** Angenommene Nachrichten mit message_id, siehe Vertrag oben; fehlt, wenn leer */
  messages?: SentMessage[];
}

export interface OutboxDeps {
  botToken: string;
  /** TELEGRAM_USER_ID */
  userId: string;
  /** Chat-ID der Forum-Gruppe, null ohne Gruppe */
  groupId: string | null;
  /** Wurzel der Dateiablage, Standard data/outbox */
  outboxDir: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Hält einen Eintrag fest, Standard saveDisplayOnlyMessage */
  record(message: Message): Promise<boolean>;
  /** Nie Inhalte oder Zugangsdaten übergeben */
  log(line: string): void;
  newId(): string;
}

/**
 * Dateiname ohne Pfadanteil: nur der letzte Teil nach / oder \, ohne
 * Steuerzeichen und führende Punkte, fremde Zeichen als _, höchstens 120
 * Zeichen (Endung bleibt). Leer wird zu "datei".
 */
export function sanitizeFileName(raw: string): string {
  const last = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  let name = last
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N}._ ()+-]/gu, "_")
    .replace(/^[.\s]+/, "")
    .trim();
  if (name.length > MAX_NAME_CHARS) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    name = name.slice(0, MAX_NAME_CHARS - ext.length) + ext;
  }
  return name || "datei";
}

/** Zielpfad der Ablage; wirft, wenn er trotz Bereinigung außerhalb läge. */
export function outboxPath(outboxDir: string, id: string, name: string): string {
  if (!OUTBOX_ID_PATTERN.test(id)) throw new Error("ungültige Ablage-ID");
  const dir = resolve(outboxDir, id);
  const target = resolve(dir, sanitizeFileName(name));
  if (!target.startsWith(dir + sep)) throw new Error("Dateiname verlässt die Ablage");
  return target;
}

function invalid(message: string): SendAndRecordResult {
  return { sent: false, recorded: false, error: { kind: "invalid", message } };
}

interface Target {
  chatId: string;
  /** Nur festhalten, nie an Telegram (Web-Direktchat oder Web-Gespräch, Issue #227) */
  web?: true;
  /** message_thread_id, fehlt bei Direktchat und General */
  threadId?: number;
  /** metadata.topicId, fehlt bei Direktchat und General */
  topicId?: number;
}

/** Telegram eingerichtet, gemessen an den Outbox-Abhängigkeiten (wie telegramConfigured) */
function telegramOf(deps: Pick<OutboxDeps, "botToken" | "userId">): boolean {
  return telegramConfigured({ TELEGRAM_BOT_TOKEN: deps.botToken, TELEGRAM_USER_ID: deps.userId });
}

function resolveTarget(input: SendAndRecordInput, deps: Pick<OutboxDeps, "botToken" | "userId" | "groupId">): Target | string {
  const telegram = telegramOf(deps);
  // Web-Ziele: auch mit Telegram nur festhalten, nie mit Topic
  if (input.chatId !== undefined && isWebChatId(input.chatId)) {
    if (input.topicId !== undefined) return "Topic nur in der Forum-Gruppe, nicht in einem Web-Gespräch";
    return { chatId: input.chatId, web: true };
  }
  // Ohne Telegram zählt eine übrig gebliebene Gruppen-Konfiguration nicht
  const group = telegram && deps.groupId && GROUP_ID_PATTERN.test(deps.groupId) ? deps.groupId : null;
  if (input.topicId !== undefined) {
    if (!Number.isSafeInteger(input.topicId) || input.topicId < 1) return "Topic-ID muss eine positive ganze Zahl sein";
    if (!telegram) return "Telegram ist nicht eingerichtet, Topics gibt es nur in der Forum-Gruppe";
    if (!group) return "Keine Forum-Gruppe eingerichtet (TELEGRAM_GROUP_ID oder config/topics.json)";
    if (input.chatId !== undefined && input.chatId !== group) return "Topic nur in der Forum-Gruppe";
    if (input.topicId === GENERAL_TOPIC_ID) return { chatId: group };
    return { chatId: group, threadId: input.topicId, topicId: input.topicId };
  }
  if (!telegram) {
    if (input.chatId === undefined) return { chatId: WEB_DM_CHAT_ID, web: true };
    return "Telegram ist nicht eingerichtet, Ziel ist nur die WebUI (Chat-ID web oder web:<Gesprächs-ID>)";
  }
  const user = USER_ID_PATTERN.test(deps.userId) ? deps.userId : null;
  if (input.chatId === undefined) return user ? { chatId: user } : "TELEGRAM_USER_ID fehlt";
  if (input.chatId === user || input.chatId === group) return { chatId: input.chatId };
  return "Chat-ID ist weder der Direktchat noch die Forum-Gruppe";
}

/**
 * Prüft ein Ziel wie sendAndRecord, ohne zu senden (Issue #103: Jobs prüfen
 * ihr Rückmeldeziel schon beim Start). null: gültig, sonst der Grund. Ohne
 * botToken-Angabe gilt Telegram als eingerichtet, sobald die Nutzer-ID
 * gültig ist (Aufrufer vor Issue #227 kannten nur Telegram).
 */
export function checkOutboxTarget(
  input: Pick<SendAndRecordInput, "chatId" | "topicId">,
  deps: Pick<OutboxDeps, "groupId" | "userId"> & Partial<Pick<OutboxDeps, "botToken">>
): string | null {
  const target = resolveTarget({ ...input, source: "check" }, { ...deps, botToken: deps.botToken ?? "check" });
  return typeof target === "string" ? target : null;
}

async function postJson(deps: OutboxDeps, method: string, body: Record<string, unknown>): Promise<Response> {
  return deps.fetch(`https://api.telegram.org/bot${deps.botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(guardTelegramPayload(method, body)),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
}

/** message_id aus einer Bot-API-Antwort; undefined, wenn keine lesbar ist */
async function messageIdOf(res: Response): Promise<number | undefined> {
  try {
    const body = (await res.json()) as { result?: { message_id?: unknown } };
    const id = body?.result?.message_id;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : "unbekannt";
}

/** Telegram-Stücke eines Texts: Markdown als HTML bzw. Klartext bereinigt, aufgeteilt (so wie sendAndRecord sendet) */
export function textChunks(text: string, format: "markdown" | "plain" = "markdown"): string[] {
  return chunkForTelegram(format === "plain" ? sanitizeModelOutput(text) : markdownToTelegramHTML(text));
}

interface TextOptions {
  format: "markdown" | "plain";
  buttons?: InlineButton[][];
}

function validButtons(buttons: unknown): buttons is InlineButton[][] {
  return (
    Array.isArray(buttons) &&
    buttons.length > 0 &&
    buttons.every(
      row =>
        Array.isArray(row) &&
        row.length > 0 &&
        row.every(
          b =>
            b !== null &&
            typeof b === "object" &&
            typeof (b as InlineButton).text === "string" &&
            (b as InlineButton).text.trim() !== "" &&
            typeof (b as InlineButton).callback_data === "string" &&
            (b as InlineButton).callback_data !== ""
        )
    )
  );
}

/** Text in Stücken; bricht beim ersten gescheiterten Stück ab. Angenommene Stücke kommen in sent. */
async function sendText(deps: OutboxDeps, target: Target, text: string, options: TextOptions, sent: SentMessage[]): Promise<boolean> {
  const chunks = textChunks(text, options.format);
  // Nie Erfolg ohne gesendetes Stück (sendAndRecord lehnt solche Texte vorher ab)
  if (chunks.length === 0) return false;
  const html = options.format !== "plain";
  const thread = target.threadId !== undefined ? { message_thread_id: target.threadId } : {};
  const preview = { link_preview_options: { is_disabled: true } };
  for (const [i, chunk] of chunks.entries()) {
    const withButtons = i === chunks.length - 1 && !!options.buttons;
    const markup = withButtons ? { reply_markup: { inline_keyboard: options.buttons } } : {};
    const note = async (res: Response) => {
      const messageId = await messageIdOf(res);
      if (messageId !== undefined) sent.push({ chatId: target.chatId, messageId, part: "text", buttons: withButtons });
    };
    try {
      const res = await postJson(deps, "sendMessage", {
        chat_id: target.chatId,
        ...thread,
        text: chunk,
        ...(html ? { parse_mode: "HTML" } : {}),
        ...preview,
        ...markup,
      });
      if (res.ok) {
        await note(res);
        continue;
      }
      if (res.status === 400 && html) {
        const plain = await postJson(deps, "sendMessage", {
          chat_id: target.chatId,
          ...thread,
          text: stripHtmlTags(chunk),
          ...preview,
          ...markup,
        });
        if (plain.ok) {
          await note(plain);
          continue;
        }
        deps.log(`[outbox] Text-Stück ${i + 1}/${chunks.length} nicht gesendet (HTTP ${plain.status})`);
        return false;
      }
      deps.log(`[outbox] Text-Stück ${i + 1}/${chunks.length} nicht gesendet (HTTP ${res.status})`);
      return false;
    } catch (e) {
      deps.log(`[outbox] Text-Stück ${i + 1}/${chunks.length} nicht gesendet (${errorName(e)})`);
      return false;
    }
  }
  return true;
}

async function sendDocument(
  deps: OutboxDeps,
  target: Target,
  document: Blob,
  name: string,
  caption: string | undefined,
  sent: SentMessage[]
): Promise<boolean> {
  try {
    const form = new FormData();
    form.append("chat_id", target.chatId);
    if (target.threadId !== undefined) form.append("message_thread_id", String(target.threadId));
    form.append("document", document, name);
    // Dieselbe Nutzlastbereinigung wie alle anderen Wege (Issue #52, Runde 9)
    if (caption) form.append("caption", guardTelegramPayload("sendDocument", { caption: sanitizeModelOutput(caption) }).caption);
    const res = await deps.fetch(`https://api.telegram.org/bot${deps.botToken}/sendDocument`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res.ok) {
      const messageId = await messageIdOf(res);
      if (messageId !== undefined) sent.push({ chatId: target.chatId, messageId, part: "file", buttons: false });
      return true;
    }
    deps.log(`[outbox] Datei nicht gesendet (HTTP ${res.status})`);
    return false;
  } catch (e) {
    deps.log(`[outbox] Datei nicht gesendet (${errorName(e)})`);
    return false;
  }
}

async function record(deps: OutboxDeps, target: Target, content: string, meta: Record<string, unknown>): Promise<boolean> {
  const metadata: Record<string, unknown> = { display_only: true, ...meta };
  if (target.topicId !== undefined) metadata.topicId = target.topicId;
  const what = target.web ? "[outbox] Nicht für die WebUI festgehalten" : "[outbox] Gesendet, aber nicht festgehalten";
  try {
    const ok = await deps.record({ chat_id: target.chatId, role: "assistant", content, metadata });
    if (ok === true) return true;
    deps.log(what);
    return false;
  } catch (e) {
    deps.log(`${what} (${errorName(e)})`);
    return false;
  }
}

interface WebContent {
  text?: string;
  filePath?: string;
  /** Bereinigter Dateiname und geprüfte Größe aus sendAndRecord */
  name: string;
  size: number;
  caption?: string;
  source: string;
  choiceId?: string;
}

function recordFailed(message: string): SendAndRecordResult {
  return { sent: false, recorded: false, error: { kind: "record", message } };
}

/**
 * Web-Ziel (Issue #227): nur festhalten, erst Text, dann Datei. Die Datei
 * muss in die Ablage, sonst gäbe es sie nirgends; scheitert das oder das
 * Festhalten, ist das ein Fehler (kind "record") und die Kopie wird entfernt.
 */
async function recordForWeb(deps: OutboxDeps, target: Target, c: WebContent): Promise<SendAndRecordResult> {
  if (c.text) {
    const meta: Record<string, unknown> = { source: c.source };
    if (c.choiceId !== undefined) meta.choiceId = c.choiceId;
    if (!(await record(deps, target, c.text, meta))) return recordFailed("Meldung nicht für die WebUI festgehalten");
  }
  if (!c.filePath) return { sent: false, recorded: true };
  let stored: OutboxFile & { path: string };
  let dir = "";
  try {
    const id = deps.newId();
    const path = outboxPath(deps.outboxDir, id, c.name);
    dir = resolve(deps.outboxDir, id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await copyFile(c.filePath, path);
    const copied = await stat(path);
    if (copied.size === 0 || copied.size > MAX_FILE_BYTES || copied.size !== c.size) throw new Error("Kopie unvollständig");
    stored = { id, name: c.name, size: c.size, mime: mimeOf(path), path };
  } catch (e) {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    deps.log(`[outbox] Datei nicht abgelegt (${errorName(e)})`);
    return recordFailed("Datei nicht abgelegt, nicht für die WebUI festgehalten");
  }
  const file = { id: stored.id, name: stored.name, size: stored.size, mime: stored.mime };
  if (!(await record(deps, target, c.caption ?? c.name, { source: c.source, file }))) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return recordFailed("Datei nicht für die WebUI festgehalten");
  }
  return { sent: false, recorded: true, file: stored };
}

function mimeOf(path: string): string {
  const type = Bun.file(path).type || "application/octet-stream";
  return type.split(";")[0].trim() || "application/octet-stream";
}

/**
 * Sendet an Telegram und hält danach fest (siehe Vertrag oben). Wirft nicht;
 * Ergebnis und Fehlerart stehen im Rückgabewert.
 */
export async function sendAndRecord(
  input: SendAndRecordInput,
  deps: OutboxDeps = defaultOutboxDeps()
): Promise<SendAndRecordResult> {
  const source = typeof input.source === "string" ? input.source.trim() : "";
  if (!SOURCE_PATTERN.test(source)) return invalid("source fehlt oder ist ungültig (a-z, 0-9, _ und -, höchstens 32 Zeichen)");
  const text = typeof input.text === "string" && input.text.trim() ? input.text : undefined;
  const filePath = typeof input.file === "string" && input.file.trim() ? input.file : undefined;
  const caption = typeof input.caption === "string" && input.caption.trim() ? input.caption : undefined;
  if (!text && !filePath) return invalid("Weder Text noch Datei angegeben");
  if (input.format !== undefined && input.format !== "markdown" && input.format !== "plain") {
    return invalid("format muss markdown oder plain sein");
  }
  const format = input.format ?? "markdown";
  // Etwa "---" oder nur unsichtbare Zeichen: Umwandlung bzw. Bereinigung
  // lässt nichts Sendbares übrig
  if (text) {
    const visible = (chunk: string) => (format === "plain" ? chunk : stripHtmlTags(chunk)).trim() !== "";
    if (!textChunks(text, format).some(visible)) return invalid("Text ist nach der Formatierung leer");
  }
  if (input.buttons !== undefined) {
    if (!text) return invalid("buttons nur zusammen mit Text");
    if (!validButtons(input.buttons)) return invalid("buttons ungültig (Zeilen aus { text, callback_data })");
  }
  if (input.linkPreview !== undefined && input.linkPreview !== false) return invalid("linkPreview darf nur false sein");
  if (input.choiceId !== undefined) {
    if (typeof input.choiceId !== "string" || !CHOICE_ID_PATTERN.test(input.choiceId)) return invalid("choiceId ungültig");
    if (!text) return invalid("choiceId nur zusammen mit Text");
  }
  if (input.record !== undefined && input.record !== false) return invalid("record darf nur false sein");
  if (caption && !filePath) return invalid("caption nur zusammen mit einer Datei");
  if (caption && caption.length > MAX_CAPTION_CHARS) return invalid(`caption länger als ${MAX_CAPTION_CHARS} Zeichen`);
  const target = resolveTarget(input, deps);
  if (typeof target === "string") return invalid(target);

  let size = 0;
  let name = "";
  if (filePath) {
    try {
      const info = await stat(filePath);
      if (!info.isFile()) return invalid("Pfad ist keine Datei");
      size = info.size;
    } catch {
      return invalid("Datei nicht gefunden oder nicht lesbar");
    }
    if (size === 0) return invalid("Datei ist leer");
    if (size > MAX_FILE_BYTES) return invalid(`Datei größer als 50 MB (${size} Bytes)`);
    name = sanitizeFileName(input.fileName ?? filePath);
  }

  const keep = input.record !== false;
  if (target.web) {
    if (!keep) return { sent: false, recorded: false };
    return recordForWeb(deps, target, { text, filePath, name, size, caption, source, choiceId: input.choiceId });
  }
  const result: SendAndRecordResult = { sent: true, recorded: keep };
  const sent: SentMessage[] = [];
  const done = (r: SendAndRecordResult): SendAndRecordResult => (sent.length > 0 ? { ...r, messages: sent } : r);

  if (text) {
    if (!(await sendText(deps, target, text, { format, buttons: input.buttons }, sent))) {
      return done({ sent: false, recorded: false, error: { kind: "send", message: "Telegram hat den Text nicht angenommen" } });
    }
    const meta: Record<string, unknown> = { source };
    if (input.choiceId !== undefined) meta.choiceId = input.choiceId;
    if (keep && !(await record(deps, target, text, meta))) result.recorded = false;
  }

  if (filePath) {
    let stored: (OutboxFile & { path: string }) | undefined;
    let document: Blob | undefined;
    // Größe des Inhalts, der hochginge, wenn er gegen das Limit verstößt
    let badSize: number | undefined;
    try {
      const id = deps.newId();
      const path = outboxPath(deps.outboxDir, id, name);
      await mkdir(resolve(deps.outboxDir, id), { recursive: true, mode: 0o700 });
      await copyFile(filePath, path);
      const copied = await stat(path);
      if (copied.size === 0 || copied.size > MAX_FILE_BYTES) {
        badSize = copied.size;
        await rm(resolve(deps.outboxDir, id), { recursive: true, force: true }).catch(() => {});
      } else {
        if (copied.size !== size) throw new Error("Kopie unvollständig");
        stored = { id, name, size, mime: mimeOf(path), path };
        document = Bun.file(path);
      }
    } catch (e) {
      deps.log(`[outbox] Ablage fehlgeschlagen, Datei wird trotzdem gesendet (${errorName(e)})`);
    }

    if (!document && badSize === undefined) {
      // Original erneut prüfen: höchstens ein Byte über dem Limit lesen und
      // genau diese Bytes senden, damit nichts Ungeprüftes hochgeht
      try {
        const original = Bun.file(filePath);
        const bytes = await original.slice(0, MAX_FILE_BYTES + 1).arrayBuffer();
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) badSize = bytes.byteLength;
        else document = new Blob([bytes], { type: original.type });
      } catch (e) {
        deps.log(`[outbox] Datei nicht lesbar (${errorName(e)})`);
        return done({ sent: false, recorded: false, error: { kind: "send", message: "Datei nicht lesbar, nicht gesendet" } });
      }
    }

    if (badSize !== undefined || !document) {
      const reason = badSize === 0 ? "inzwischen leer" : "inzwischen größer als 50 MB";
      deps.log(`[outbox] Datei ${reason}, nicht gesendet`);
      return done({ sent: false, recorded: false, error: { kind: "invalid", message: `Datei ${reason}, nicht gesendet` } });
    }

    if (!(await sendDocument(deps, target, document, name, caption, sent))) {
      if (stored) await rm(resolve(deps.outboxDir, stored.id), { recursive: true, force: true }).catch(() => {});
      return done({ sent: false, recorded: false, error: { kind: "send", message: "Telegram hat die Datei nicht angenommen" } });
    }
    if (!stored) {
      result.recorded = false;
    } else {
      result.file = stored;
      const file = { id: stored.id, name: stored.name, size: stored.size, mime: stored.mime };
      if (keep && !(await record(deps, target, caption ?? name, { source, file }))) result.recorded = false;
    }
  }

  return done(result);
}

/**
 * Standard-Sender der Hintergrunddienste (Briefing, Check-in, Watchdog):
 * sendAndRecord mit den Abhängigkeiten aus der Umgebung zum Zeitpunkt des
 * Aufrufs, also nach dem Laden der .env.
 */
export const sendViaOutbox: OutboxSender = input => sendAndRecord(input);

/** Abhängigkeiten aus der Umgebung (.env muss vorher geladen sein). */
export function defaultOutboxDeps(env: Record<string, string | undefined> = process.env): OutboxDeps {
  return {
    botToken: env.TELEGRAM_BOT_TOKEN?.trim() ?? "",
    userId: env.TELEGRAM_USER_ID?.trim() ?? "",
    // Wie die WebUI: TELEGRAM_GROUP_ID, sonst erste Gruppe aus config/topics.json
    groupId: resolveGroupId(env, getTopicConfigChatIds()),
    outboxDir: join(PROJECT_ROOT, "data", "outbox"),
    fetch: (url, init) => fetch(url, init),
    record: async message => (await import("./convex")).saveDisplayOnlyMessage(message),
    log: line => console.warn(line),
    newId: () => randomUUID(),
  };
}
