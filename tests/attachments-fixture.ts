// Gemeinsamer Aufbau für die Anhang-Tests (Issue #72): echter Web-Server mit
// Ablage in einem temporären Ordner und echter Telegram-Quelle; Claude,
// Supabase, Telegram und Mediendienste sind Attrappen.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TopicStateEntry } from "../src/lib/topic-state";
import type { HistoryRow } from "../src/lib/supabase";
import type { WebChat } from "../src/web/chat";
import type { CommandPort } from "../src/web/commands";
import { createTelegramSource } from "../src/web/bot-telegram";
import { createTelegramChat, type IntentTurn, type MirrorFile, type WebSavedMessage } from "../src/web/bot-turn";
import type { TurnOptions } from "../src/lib/chat-turn";
import { abortExecutions } from "../src/lib/execution-context";
import { createWebServer, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import { UploadStore } from "../src/web/uploads";

export const PASSWORD = "test-passwort-lang";
export const GROUP = "-1001234567890";
export const USER = "4711";
/** Topic 443 (Finanzen, offen), 444 (Alt, geschlossen) */
export const TOPIC = "topic-443";
export const CLOSED_TOPIC = "topic-444";

export interface AttachmentCtx {
  origin: string;
  cookie: string;
  server: WebServer;
  uploads: UploadStore;
  uploadsDir: string;
  rows: HistoryRow[];
  /** ID eines älteren Web-Gesprächs (Agent general) */
  webConversationId: string;
  /** Zweites Web-Gespräch (Agent research), für die Trennung der Anhänge */
  otherWebConversationId: string;
  store: ConversationStore;
  upload(conversationId: string, body: Uint8Array | null, headers?: Record<string, string>): Promise<Response>;
  api(path: string, init?: { method?: string; body?: unknown; cookie?: string | null }): Promise<Response>;
}

export async function makeRoot(prefix: string): Promise<{ next(): string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  let counter = 0;
  return { next: () => join(root, `case-${++counter}`), cleanup: () => rm(root, { recursive: true, force: true }) };
}

export interface StartOptions {
  dir: string;
  /** Telegram-Turn; ohne ihn antwortet POST .../messages mit 503 */
  telegramChat?: (rows: HistoryRow[], uploads: UploadStore) => WebChat;
  /** Chat der reinen Web-Gespräche (Issue #112); ohne ihn antworten sie mit 503 */
  webChat?: (uploads: UploadStore) => WebChat;
  /** Arbeitskopien des Medien-Kerns für Web-Gespräche (UploadStore.mediaDir) */
  mediaDir?: string;
  commands?: CommandPort;
  uploads?: false;
  now?: () => number;
  servers: WebServer[];
}

export async function startAttachmentServer(options: StartOptions): Promise<AttachmentCtx> {
  const { dir } = options;
  const uploadsDir = join(dir, "uploads");
  const uploads = new UploadStore({ dir: uploadsDir, mediaDir: options.mediaDir, now: options.now, log: () => {} });
  const rows: HistoryRow[] = [];
  const telegram = createTelegramSource({
    userId: USER,
    groupId: () => GROUP,
    topicNames: async () => ({ "443": "Finanzen", "444": "Alt" }),
    topicMapping: () => ({ "443": "finance" }),
    history: async (chatId, topicId) =>
      rows.filter(r => (r as any).chat_id === chatId && ((r.metadata as any)?.topicId ?? null) === topicId),
    activity: async () => [],
    topicState: async () => new Map<number, TopicStateEntry>([[444, { closed: true }]]),
    log: () => {},
  });
  const store = new ConversationStore({ dir: join(dir, "web") });
  await store.load();
  const web = await store.createConversation("general");
  const otherWeb = await store.createConversation("research");
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    {
      sessionFile: join(dir, "web-sessions.json"),
      conversationStore: store,
      telegram,
      ...(options.telegramChat ? { telegramChat: options.telegramChat(rows, uploads) } : {}),
      ...(options.webChat ? { chat: options.webChat(uploads) } : {}),
      ...(options.commands ? { commands: options.commands } : {}),
      ...(options.uploads === false ? {} : { uploads }),
      log: () => {},
    }
  );
  options.servers.push(server);
  const origin = server.url;
  const res = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { origin },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  return {
    origin,
    cookie,
    server,
    uploads,
    uploadsDir,
    rows,
    webConversationId: web.id,
    otherWebConversationId: otherWeb.id,
    store,
    upload(conversationId, body, headers = {}) {
      return fetch(`${origin}/api/conversations/${conversationId}/attachments`, {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/octet-stream", ...headers },
        body,
      });
    },
    api(path, init = {}) {
      const c = init.cookie === undefined ? cookie : init.cookie;
      return fetch(`${origin}${path}`, {
        method: init.method ?? "GET",
        headers: { origin, "content-type": "application/json", ...(c ? { cookie: c } : {}) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    },
  };
}

/** Was der Telegram-Turn mit Attrappen nach außen getan hat */
export interface TurnRecord {
  turns: TurnOptions[];
  saved: WebSavedMessage[];
  plain: { chatId: string; text: string; threadId?: number }[];
  /** Gespiegelte Anhänge in Reihenfolge, auch abgelehnte Versuche (ok: false) */
  files: { chatId: string; name: string; mime: string; size: number; as: "photo" | "document"; caption: string; threadId?: number; ok: boolean }[];
  /** Telegram-Verhalten beim Anhang; wirft = abgelehnt */
  sendFile: (file: MirrorFile, as: "photo" | "document") => Promise<void>;
  agentSends: { agent: string; chatId: string; text: string; threadId?: number }[];
  intents: { text: string; turn: IntentTurn }[];
  /** Asset-Speicher: hochgeladene Pfade und nachgetragene Beschreibungen */
  assets: { path: string; options: Record<string, unknown> }[];
  descriptions: { assetId: string; description: string; tags?: string[] }[];
  written: string[];
  unlinked: string[];
  transcribed: string[];
  /** Was Claude tut; Standard: sofort antworten */
  core: (opts: TurnOptions) => Promise<string>;
  transcribe: (path: string) => Promise<string>;
}

/** Echter Telegram-Turn (createTelegramChat) mit Attrappen für Claude, Speicher, Telegram und Medien */
export function fakeTelegramChat(mediaDir: string, extra: Partial<Parameters<typeof createTelegramChat>[0]> = {}) {
  const rec: TurnRecord = {
    turns: [],
    saved: [],
    plain: [],
    files: [],
    sendFile: async () => {},
    agentSends: [],
    intents: [],
    assets: [],
    descriptions: [],
    written: [],
    unlinked: [],
    transcribed: [],
    core: async () => "Antwort",
    transcribe: async () => "Hallo aus der Sprachdatei",
  };
  let assetCounter = 0;
  let rowCounter = 0;
  const factory = (rows: HistoryRow[], uploads: UploadStore) =>
    createTelegramChat({
      userId: USER,
      groupId: () => GROUP,
      agentForTopic: topicId => (topicId === 443 ? "finance" : undefined),
      runStreamingTurn: async opts => {
        rec.turns.push(opts);
        return rec.core(opts);
      },
      saveMessage: async m => {
        rec.saved.push(m);
        rows.push({
          id: `row-${++rowCounter}`,
          created_at: new Date(Date.now() + rowCounter).toISOString(),
          role: m.role,
          content: m.content,
          metadata: m.metadata ?? null,
          chat_id: m.chat_id,
        } as HistoryRow);
        return true;
      },
      processIntents: async (text, turn) => {
        rec.intents.push({ text, turn });
      },
      abortClaudeCalls: key => abortExecutions(key),
      isShuttingDown: () => false,
      scheduleRestartCheck: () => {},
      sendPlain: async (chatId, text, threadId) => {
        rec.plain.push({ chatId, text, threadId });
      },
      sendAsAgent: async (agent, chatId, text, threadId) => {
        rec.agentSends.push({ agent, chatId, text, threadId });
      },
      sendFile: async (chatId, file, options) => {
        const entry = { chatId, name: file.name, mime: file.mime, size: file.bytes.length, ...options, ok: false };
        rec.files.push(entry);
        await rec.sendFile(file, options.as);
        entry.ok = true;
      },
      uploads,
      media: {
        uploadsDir: mediaDir,
        mkdir: async () => undefined,
        writeFile: async path => {
          rec.written.push(path);
        },
        unlink: async path => {
          rec.unlinked.push(path);
        },
        uploadAssetQuick: async (path, options) => {
          rec.assets.push({ path, options });
          return { id: `asset-${++assetCounter}` } as any;
        },
        updateAssetDescription: async (assetId, description, tags) => {
          rec.descriptions.push({ assetId, description, ...(tags ? { tags } : {}) });
          return true;
        },
        transcribeAudio: async path => {
          rec.transcribed.push(path);
          return rec.transcribe(path);
        },
        logError: () => {},
      },
      log: () => {},
      ...extra,
    });
  return { rec, factory };
}

export async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

/** Liest SSE-Ereignisse eines Gesprächs mit */
export async function listen(ctx: AttachmentCtx, id: string) {
  const controller = new AbortController();
  const res = await fetch(`${ctx.origin}/api/conversations/${id}/events`, {
    headers: { cookie: ctx.cookie, origin: ctx.origin },
    signal: controller.signal,
  });
  const events: { event: string; data: any }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const done = (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      buffer += decoder.decode(value);
      let i: number;
      while ((i = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const event = /^event: (.+)$/m.exec(chunk)?.[1];
        const data = /^data: (.+)$/m.exec(chunk)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
    }
  })();
  await waitUntil(() => events.length > 0);
  return {
    events,
    async close() {
      controller.abort();
      await reader.cancel().catch(() => {});
      await done;
    },
  };
}
