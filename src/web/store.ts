/**
 * Gesprächsspeicher der WebUI (Issue #4).
 *
 * <dataDir>/conversations.json: Liste der Gespräche
 * <dataDir>/<id>.jsonl: eine Zeile pro Nachricht
 *
 * Alle Schreibvorgänge laufen nacheinander über eine Kette, damit sich
 * gleichzeitige Änderungen an der gemeinsamen Liste nicht überschreiben.
 * Die Liste wird atomar geschrieben (temporäre Datei, dann umbenennen).
 */

import type { EngineId } from "../lib/engines/types";
import { appendFile, chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pickApiAttachments, pickAttachment, type ApiAttachment, type MessageAttachment } from "./attachments";
import { pickNoticeFile, type NoticeFile } from "./notice";

export const DEFAULT_DATA_DIR = join(process.env.GO_PROJECT_ROOT || process.cwd(), "data", "web");
export const DEFAULT_TITLE = "Neues Gespräch";
export const TITLE_MAX_CHARS = 60;
/** Obergrenze für einen von Hand gesetzten Titel (Issue #21), getrennt von der Automatik */
export const CUSTOM_TITLE_MAX_CHARS = 80;

const LIST_FILE = "conversations.json";
/** Nur IDs aus crypto.randomUUID() werden als Dateiname benutzt */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type MessageRole = "user" | "assistant" | "error";

export interface Conversation {
  id: string;
  title: string;
  agent: string;
  createdAt: string;
  updatedAt: string;
  /** Von Hand umbenannt: die erste Nachricht setzt den Titel dann nicht mehr */
  customTitle?: boolean;
}

/**
 * Angaben unter einer Antwort (Issue #22): welcher Agent, welches Modell
 * (bei Fallback das Fallback-Modell), wie lange. Jedes Feld ist optional,
 * ältere Nachrichten haben keins.
 */
export interface ReplyInfo {
  agent?: string;
  model?: string;
  /** Motor der Antwort (Issue #125), nur wenn einer der bekannten; fehlt bei Fallback-Antworten */
  engine?: EngineId;
  durationMs?: number;
}

export interface StoredMessage extends ReplyInfo {
  id: string;
  role: MessageRole;
  text: string;
  createdAt: string;
  /** Nur bei einer Freigabe-Frage: Kennung, mit der die Antwort zurückkommen muss */
  approvalId?: string;
  /** Meldung statt Antwort (Issue #74: Antwort eines Befehls), nie Gesprächskontext */
  kind?: "notice";
  /** Absender der Meldung, z. B. befehl */
  source?: string;
  /** Anhänge einer eigenen Nachricht (Issue #72, in Web-Gesprächen seit #112) */
  attachments?: ApiAttachment[];
  /** Rückfrage aus dem Register, deren Knöpfe unter der Nachricht stehen (Issue #115) */
  choiceId?: string;
  /** Datei einer Meldung aus der Outbox (Issue #227, nur bei kind "notice"), Download über /api/files */
  file?: NoticeFile;
}

export interface NewMessage extends ReplyInfo {
  role: MessageRole;
  text: string;
  approvalId?: string;
  kind?: "notice";
  source?: string;
  attachments?: ApiAttachment[];
  choiceId?: string;
  file?: NoticeFile;
}

/** Kennung einer übernommenen Meldung (Issue #227): msgId aus dem Nachrichtenspeicher */
const NOTICE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Wie ID_RE in src/lib/choices.ts: Kennung einer Rückfrage aus dem Register */
export const CHOICE_ID_PATTERN = /^[A-Za-z0-9]{1,12}$/;

export function isChoiceId(value: unknown): value is string {
  return typeof value === "string" && CHOICE_ID_PATTERN.test(value);
}

/**
 * Motoren wie ENGINE_IDS in src/lib/engines/types.ts (Issue #125); hier als
 * eigene Liste, weil src/web zur Laufzeit nichts außerhalb von src/web lädt.
 * tests/web-reply-info.test.ts hält beide gleich.
 */
export const REPLY_ENGINES: readonly EngineId[] = ["claude", "codex", "opencode"];

/** Gültige Agentennamen (wie AGENT_NAME_PATTERN in agents.ts) */
const REPLY_AGENT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const MODEL_MAX_CHARS = 100;
/** Obergrenze für eine plausible Dauer: ein Tag */
const MAX_DURATION_MS = 86_400_000;

/**
 * Nur gültige Angaben übernehmen: Agent nach Namensmuster, Modell als Text
 * ohne Steuerzeichen (höchstens 100 Zeichen), Motor aus ENGINE_IDS, Dauer als ganze Millisekunden
 * zwischen 0 und einem Tag. Alles andere fällt weg, statt etwas zu erfinden.
 */
export function pickReplyInfo(value: unknown): ReplyInfo {
  if (!value || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  const info: ReplyInfo = {};
  if (typeof v.agent === "string" && REPLY_AGENT_PATTERN.test(v.agent)) info.agent = v.agent;
  if (typeof v.model === "string") {
    const model = v.model.trim();
    if (model && [...model].length <= MODEL_MAX_CHARS && !/[\p{Cc}]/u.test(model)) info.model = model;
  }
  if (typeof v.engine === "string" && (REPLY_ENGINES as readonly string[]).includes(v.engine)) info.engine = v.engine as EngineId;
  if (typeof v.durationMs === "number" && Number.isFinite(v.durationMs) && v.durationMs >= 0 && v.durationMs <= MAX_DURATION_MS) {
    info.durationMs = Math.round(v.durationMs);
  }
  return info;
}

export interface ConversationStoreOptions {
  /** Standard: data/web im Projekt */
  dir?: string;
  now?: () => number;
}

export function isConversationId(id: unknown): id is string {
  return typeof id === "string" && ID_PATTERN.test(id);
}

/** Erste 60 Zeichen der Nachricht, Leerraum zusammengezogen. */
export function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const chars = [...clean];
  if (chars.length <= TITLE_MAX_CHARS) return clean || DEFAULT_TITLE;
  // Zu lang: an der letzten Wortgrenze kürzen (wenn sie nicht zu früh liegt),
  // sonst hart, und mit "…" enden; zusammen höchstens TITLE_MAX_CHARS Zeichen
  const head = chars.slice(0, TITLE_MAX_CHARS - 1).join("");
  const space = head.lastIndexOf(" ");
  const cut = space >= head.length / 2 ? head.slice(0, space) : head;
  return cut.trim().replace(/[,;:.!?-]+$/, "") + "…";
}

/**
 * Von Hand gesetzter Titel: erst Leerraum (auch Zeilenumbrüche und
 * Steuerzeichen) zu einem Leerzeichen zusammenziehen und außen abschneiden,
 * dann 1 bis 80 Zeichen (Unicode-Codepoints). null, wenn ungültig.
 */
export function normalizeCustomTitle(title: unknown): string | null {
  if (typeof title !== "string") return null;
  const clean = title.replace(/[\s\p{Cc}]+/gu, " ").trim();
  const length = [...clean].length;
  return length >= 1 && length <= CUSTOM_TITLE_MAX_CHARS ? clean : null;
}

/** Session-Schlüssel eines Web-Gesprächs, zugleich seine Chat-ID im Chat-Kern (sessionKeyFor lässt ihn unverändert). */
export function webSessionKey(conversationId: string): string {
  return `web:${conversationId}`;
}

/**
 * Anhänge einer gelesenen Nachricht geprüft und mit Download-Adressen dieses
 * Gesprächs; ungültige fallen weg, ohne gültige gibt es das Feld nicht.
 */
function withAttachmentUrls(m: StoredMessage | (Omit<StoredMessage, "attachments"> & { attachments?: unknown }), id: string): StoredMessage {
  const { attachments, choiceId, ...base } = m;
  // Rückfrage (Issue #115) nur mit gültiger Kennung bei Antworten
  const rest: StoredMessage = base.role === "assistant" && isChoiceId(choiceId) ? { ...base, choiceId } : base;
  if (attachments === undefined || rest.role !== "user") return rest;
  const list = pickApiAttachments(attachments, id);
  return list.length ? { ...rest, attachments: list } : rest;
}

function isConversation(value: any): value is Conversation {
  return (
    value &&
    isConversationId(value.id) &&
    typeof value.title === "string" &&
    typeof value.agent === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.customTitle === undefined || typeof value.customTitle === "boolean")
  );
}

export class ConversationStore {
  readonly dir: string;
  private readonly now: () => number;
  private conversations = new Map<string, Conversation>();
  private loaded = false;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(options: ConversationStoreOptions = {}) {
    this.dir = options.dir ?? DEFAULT_DATA_DIR;
    this.now = options.now ?? Date.now;
  }

  /**
   * Liest die Liste. Fehlt die Datei, ist sie leer. Ist sie kaputt, bricht
   * das Laden ab, statt sie beim nächsten Schreiben zu überschreiben.
   */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(join(this.dir, LIST_FILE), "utf8");
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
      this.loaded = true;
      return;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`${LIST_FILE} ist keine Liste`);
    this.conversations = new Map(parsed.filter(isConversation).map(c => [c.id, { ...c }]));
    this.loaded = true;
  }

  async createConversation(agent: string): Promise<Conversation> {
    return this.serialized(async () => {
      const ts = this.timestamp();
      const conversation: Conversation = {
        id: crypto.randomUUID(),
        title: DEFAULT_TITLE,
        agent,
        createdAt: ts,
        updatedAt: ts,
      };
      this.conversations.set(conversation.id, conversation);
      try {
        await this.writeList();
      } catch (e) {
        this.conversations.delete(conversation.id);
        throw e;
      }
      return { ...conversation };
    });
  }

  /** Neueste zuerst */
  async listConversations(): Promise<Conversation[]> {
    await this.ensureLoaded();
    return [...this.conversations.values()]
      .map(c => ({ ...c }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getConversation(id: string): Promise<Conversation | null> {
    if (!isConversationId(id)) return null;
    await this.ensureLoaded();
    const c = this.conversations.get(id);
    return c ? { ...c } : null;
  }

  /** Hängt eine Nachricht an. Unbekannte oder ungültige ID: Fehler. */
  async appendMessage(id: string, msg: NewMessage): Promise<StoredMessage> {
    return (await this.append(id, msg))!;
  }

  /**
   * Meldung aus dem Nachrichtenspeicher übernehmen (Issue #227), höchstens
   * einmal: key wird die ID der Nachricht; gibt es sie im Gespräch schon
   * (auch nach einem Neustart), passiert nichts. null: schon da oder das
   * Gespräch gibt es nicht (mehr).
   */
  async appendNoticeOnce(id: string, msg: NewMessage & { kind: "notice" }, key: string): Promise<StoredMessage | null> {
    if (!NOTICE_KEY_PATTERN.test(key)) throw new Error("Ungültige Kennung");
    return this.append(id, msg, key);
  }

  private async append(id: string, msg: NewMessage, key?: string): Promise<StoredMessage | null> {
    if (!isConversationId(id)) throw new Error("Ungültige Gesprächs-ID");
    // Anhänge (Issue #112) ohne Adressen ablegen; die kommen beim Lesen aus der Gesprächs-ID
    const attached: MessageAttachment[] = (msg.attachments ?? [])
      .map(pickAttachment)
      .filter((a): a is MessageAttachment => a !== null);
    const file = msg.kind === "notice" ? pickNoticeFile(msg.file) : null;
    return this.serialized(async () => {
      const conversation = this.conversations.get(id);
      if (!conversation) {
        if (key !== undefined) return null;
        throw new Error("Unbekanntes Gespräch");
      }
      if (key !== undefined && (await this.readMessages(id)).some(m => m.id === key)) return null;
      const stored: Omit<StoredMessage, "attachments"> & { attachments?: MessageAttachment[] } = {
        id: key ?? crypto.randomUUID(),
        role: msg.role,
        text: msg.text,
        createdAt: this.timestamp(),
        ...(msg.approvalId ? { approvalId: msg.approvalId } : {}),
        // Rückfrage (Issue #115) nur bei Antworten und Meldungen, nur mit gültiger Kennung
        ...(msg.role === "assistant" && isChoiceId(msg.choiceId) ? { choiceId: msg.choiceId } : {}),
        ...(msg.role === "user" && attached.length ? { attachments: attached } : {}),
        ...(msg.kind === "notice"
          ? { kind: "notice" as const, ...(msg.source ? { source: msg.source } : {}), ...(file ? { file } : {}) }
          : msg.role === "assistant"
            ? pickReplyInfo(msg)
            : {}),
      };
      // Titel nur aus der ersten Nutzernachricht; die Datei wird nur gelesen,
      // solange das Gespräch noch den Standardtitel trägt. Ein von Hand
      // gesetzter Titel bleibt, auch wenn er „Neues Gespräch" lautet
      let title = conversation.title;
      if (msg.role === "user" && title === DEFAULT_TITLE && !conversation.customTitle) {
        const earlier = await this.readMessages(id);
        // Nur ein Anhang ohne Text: der Name des ersten Anhangs
        if (!earlier.some(m => m.role === "user")) title = titleFrom(msg.text.trim() ? msg.text : attached[0]?.name ?? "");
      }
      // Endet die Datei nach einem Absturz mitten in einer Zeile, die neue
      // Nachricht in eine eigene Zeile schreiben, sonst geht sie mit verloren
      const prefix = (await this.endsMidLine(id)) ? "\n" : "";
      await appendFile(this.messageFile(id), prefix + JSON.stringify(stored) + "\n", { mode: 0o600 });
      const previous = { ...conversation };
      conversation.title = title;
      conversation.updatedAt = stored.createdAt;
      try {
        await this.writeList();
      } catch (e) {
        Object.assign(conversation, previous);
        throw e;
      }
      return withAttachmentUrls(stored, id);
    });
  }

  /**
   * Setzt einen Titel von Hand (Issue #21). Ungültiger Titel: Fehler;
   * unbekanntes Gespräch: null. updatedAt bleibt, die Reihenfolge der
   * Seitenleiste richtet sich nach Nachrichten, nicht nach Umbenennungen.
   */
  async renameConversation(id: string, title: string): Promise<Conversation | null> {
    const clean = normalizeCustomTitle(title);
    if (clean === null) throw new Error("Ungültiger Titel");
    if (!isConversationId(id)) return null;
    return this.serialized(async () => {
      const conversation = this.conversations.get(id);
      if (!conversation) return null;
      const previous = { ...conversation };
      conversation.title = clean;
      conversation.customTitle = true;
      try {
        await this.writeList();
      } catch (e) {
        this.conversations.set(id, previous);
        throw e;
      }
      return { ...conversation };
    });
  }

  /**
   * Löscht ein Gespräch samt Verlaufsdatei (Issue #21). false, wenn es das
   * Gespräch nicht gibt. Erst die Datei, dann der Eintrag: Scheitert das
   * Löschen der Datei, bleibt alles, wie es war; scheitert danach das
   * Schreiben der Liste, bleibt ein leeres Gespräch stehen, aber nie ein
   * Verlauf ohne Eintrag.
   */
  async deleteConversation(id: string): Promise<boolean> {
    if (!isConversationId(id)) return false;
    return this.serialized(async () => {
      const conversation = this.conversations.get(id);
      if (!conversation) return false;
      try {
        await unlink(this.messageFile(id));
      } catch (e: any) {
        // Neue Gespräche haben vor der ersten Nachricht noch keine Datei
        if (e?.code !== "ENOENT") throw e;
      }
      this.conversations.delete(id);
      try {
        await this.writeList();
      } catch (e) {
        this.conversations.set(id, conversation);
        throw e;
      }
      return true;
    });
  }

  /** Nachrichten in Reihenfolge. Ungültige ID: Fehler; unbekannte: leere Liste. */
  async getMessages(id: string): Promise<StoredMessage[]> {
    if (!isConversationId(id)) throw new Error("Ungültige Gesprächs-ID");
    // Wartet auf laufende Schreibvorgänge, damit keine halbe Zeile gelesen wird
    await this.writeChain;
    return this.readMessages(id);
  }

  private async readMessages(id: string): Promise<StoredMessage[]> {
    let raw: string;
    try {
      raw = await readFile(this.messageFile(id), "utf8");
    } catch (e: any) {
      if (e?.code === "ENOENT") return [];
      throw e;
    }
    const messages: StoredMessage[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m && typeof m.id === "string" && typeof m.text === "string" && typeof m.role === "string") {
          messages.push(withAttachmentUrls(m, id));
        }
      } catch {
        // abgeschnittene Zeile nach einem Absturz: überspringen
      }
    }
    return messages;
  }

  /** true, wenn die Nachrichtendatei existiert und nicht mit einem Zeilenumbruch endet. */
  private async endsMidLine(id: string): Promise<boolean> {
    let handle;
    try {
      handle = await open(this.messageFile(id), "r");
    } catch (e: any) {
      if (e?.code === "ENOENT") return false;
      throw e;
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) return false;
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      return last[0] !== 0x0a;
    } finally {
      await handle.close();
    }
  }

  private messageFile(id: string): string {
    if (!isConversationId(id)) throw new Error("Ungültige Gesprächs-ID");
    return join(this.dir, `${id}.jsonl`);
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async writeList(): Promise<void> {
    const file = join(this.dir, LIST_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify([...this.conversations.values()], null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  }

  /** Führt fn nach allen vorherigen Schreibvorgängen aus. */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      await this.ensureLoaded();
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      return fn();
    };
    const next = this.writeChain.then(run, run);
    this.writeChain = next.catch(() => {});
    return next;
  }
}
