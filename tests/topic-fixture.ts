/**
 * Gemeinsame Attrappen für die Tests zu Issue #29 (Topics verwalten).
 * Kein Test selbst (kein .test.ts). Echte Dateien nur in temporären
 * Verzeichnissen: Topic-Zustand, config/topics.json und topic-names.json
 * laufen über die echten Module, Telegram und Supabase sind Attrappen.
 */

import { expect } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HistoryRow, TopicActivity } from "../src/lib/convex";
import type { MessageSavedListener, SavedMessageEvent } from "../src/lib/convex";
import { createTopicNameStore } from "../src/lib/topic-names";
import { removeTopicMapping, setTopicMapping } from "../src/lib/topic-setup";
import { TopicStateStore } from "../src/lib/topic-state";
import type { RunTurnOptions, TurnResult, WebChat } from "../src/web/chat";
import { createTelegramLiveFeed, createTelegramSource } from "../src/web/bot-telegram";
import { createWebServer, type WebServer, type WebServerDeps } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import {
  createTopicManager,
  type ExecutionPort,
  type TelegramTopicApi,
  type TopicManager,
  type TopicManagerDeps,
  type TopicRights,
} from "../src/web/topics";

export const PASSWORD = "test-passwort-lang";
export const GROUP = "-1001234567890";
export const USER = "4242";
export const BOT_TOKEN = "123456:AAH-GEHEIMES-BOT-TOKEN";

/** Fehler wie grammY GrammyError: description, error_code, method */
export function telegramError(description: string, code = 400, method = "x"): Error {
  const e = new Error(`Call to '${method}' failed! (${code}: ${description}) https://api.telegram.org/bot${BOT_TOKEN}/${method}`);
  Object.assign(e, { description, error_code: code, method, name: "GrammyError" });
  return e;
}

export type ApiCall = [string, ...unknown[]];

/** Telegram-Attrappe: merkt sich Aufrufe; fail[method] wirft beim nächsten Aufruf */
export class FakeTopicApi implements TelegramTopicApi {
  calls: ApiCall[] = [];
  nextTopicId = 500;
  rights: TopicRights = { manageTopics: true, deleteMessages: true };
  rightsError: Error | null = null;
  fail: Partial<Record<string, Error>> = {};
  /** Wird vor dem Aufruf abgewartet (Rennen) */
  gate: Partial<Record<string, Promise<void>>> = {};

  private async step(method: string, ...args: unknown[]): Promise<void> {
    this.calls.push([method, ...args]);
    const gate = this.gate[method];
    if (gate) await gate;
    const err = this.fail[method];
    if (err) throw err;
  }
  callsOf(method: string): ApiCall[] {
    return this.calls.filter(c => c[0] === method);
  }
  async createForumTopic(chatId: string, name: string) {
    await this.step("createForumTopic", chatId, name);
    return { topicId: this.nextTopicId++ };
  }
  async editForumTopic(chatId: string, topicId: number, name: string) {
    await this.step("editForumTopic", chatId, topicId, name);
  }
  async closeForumTopic(chatId: string, topicId: number) {
    await this.step("closeForumTopic", chatId, topicId);
  }
  async reopenForumTopic(chatId: string, topicId: number) {
    await this.step("reopenForumTopic", chatId, topicId);
  }
  async deleteForumTopic(chatId: string, topicId: number) {
    await this.step("deleteForumTopic", chatId, topicId);
  }
  async getMyRights(chatId: string) {
    this.calls.push(["getMyRights", chatId]);
    if (this.rightsError) throw this.rightsError;
    return { ...this.rights };
  }
}

/** Ausführungen als Attrappe; die echten Hilfsfunktionen testet execution-context */
export class FakeExecutions implements ExecutionPort {
  active = new Set<string>();
  blocked: string[] = [];
  released: string[] = [];
  aborted: string[] = [];
  idleResult = true;
  isActive(key: string) {
    return this.active.has(key);
  }
  block(key: string) {
    this.blocked.push(key);
    return () => {
      this.released.push(key);
    };
  }
  abort(key: string) {
    this.aborted.push(key);
    return 0;
  }
  async waitIdle(_key: string, _ms: number) {
    return this.idleResult;
  }
}

/** Listener-Liste wie onMessageSaved in src/lib/convex.ts */
export class SavedFeed {
  listeners = new Set<MessageSavedListener>();
  onMessageSaved = (listener: MessageSavedListener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  emit(event: Partial<SavedMessageEvent> & { chatId: string; content: string }) {
    const full: SavedMessageEvent = {
      role: "user",
      metadata: {},
      createdAt: new Date().toISOString(),
      ...event,
    };
    for (const l of [...this.listeners]) void l(full);
  }
}

/** Supabase-Attrappe: Aktivität und Verlauf pro Topic, bleibt auch nach dem Löschen */
export class FakeMessages {
  activity: TopicActivity[] = [];
  rows = new Map<string, HistoryRow[]>();
  add(topicId: number, content: string, at = "2026-09-23T10:00:00.000Z") {
    const key = `topic:${GROUP}:${topicId}`;
    this.activity = this.activity.filter(a => a.sessionKey !== key);
    this.activity.push({ sessionKey: key, lastActivity: at });
    const list = this.rows.get(key) ?? [];
    list.push({ id: `r${list.length}-${topicId}`, created_at: at, role: "user", content, metadata: { topicId, msgId: 1000 + list.length } });
    this.rows.set(key, list);
  }
}

export interface TopicEnv {
  dir: string;
  stateFile: string;
  mappingFile: string;
  namesFile: string;
  state: TopicStateStore;
  names: ReturnType<typeof createTopicNameStore>;
  api: FakeTopicApi;
  executions: FakeExecutions;
  feed: SavedFeed;
  messages: FakeMessages;
  resets: string[];
  logs: string[];
  group: { id: string | null };
  deps: TopicManagerDeps;
  manager: TopicManager;
  now: { t: number };
}

let envCounter = 0;

/** Frische Umgebung; overrides ersetzen einzelne Abhängigkeiten des Managers */
export async function topicEnv(root: string, overrides: Partial<TopicManagerDeps> = {}): Promise<TopicEnv> {
  const dir = join(root, `env-${++envCounter}`);
  await mkdir(dir, { recursive: true });
  const stateFile = join(dir, "topic-state.json");
  const mappingFile = join(dir, "topics.json");
  const namesFile = join(dir, "topic-names.json");
  const env = {
    dir,
    stateFile,
    mappingFile,
    namesFile,
    state: new TopicStateStore({ file: stateFile }),
    names: createTopicNameStore(namesFile),
    api: new FakeTopicApi(),
    executions: new FakeExecutions(),
    feed: new SavedFeed(),
    messages: new FakeMessages(),
    resets: [] as string[],
    logs: [] as string[],
    group: { id: GROUP as string | null },
    now: { t: 1_000_000 },
  } as TopicEnv;
  env.deps = {
    api: env.api,
    groupId: () => env.group.id,
    state: env.state,
    setMapping: (chatId, topicId, agent) => setTopicMapping(chatId, topicId, agent, mappingFile),
    removeMapping: (chatId, topicId) => removeTopicMapping(chatId, topicId, mappingFile),
    saveName: (topicId, name) => env.names.saveTopicName(topicId, name),
    forgetName: topicId => env.names.forgetTopicName(topicId),
    getName: topicId => env.names.getTopicName(topicId),
    resetSession: async key => {
      env.resets.push(key);
    },
    executions: env.executions,
    onMessageSaved: env.feed.onMessageSaved,
    now: () => env.now.t,
    log: m => env.logs.push(m),
    ...overrides,
  };
  env.manager = createTopicManager(env.deps);
  return env;
}

export async function readMapping(env: TopicEnv): Promise<Record<string, Record<string, string>>> {
  try {
    return JSON.parse(await readFile(env.mappingFile, "utf-8"));
  } catch {
    return {};
  }
}

export async function readNames(env: TopicEnv): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(env.namesFile, "utf-8"));
  } catch {
    return {};
  }
}

/** Echte Telegram-Quelle über die Dateien der Umgebung; neue Instanzen lesen neu (Neustart) */
export function topicSource(env: TopicEnv, fresh = false) {
  const state = fresh ? new TopicStateStore({ file: env.stateFile }) : env.state;
  const names = fresh ? createTopicNameStore(env.namesFile) : env.names;
  return createTelegramSource({
    userId: USER,
    groupId: () => env.group.id,
    topicNames: () => names.getTopicNames(),
    topicMapping: chatId => {
      try {
        return JSON.parse(require("node:fs").readFileSync(env.mappingFile, "utf-8"))[chatId] ?? {};
      } catch {
        return {};
      }
    },
    topicState: chatId => state.forChat(chatId),
    history: async (chatId, topicId) => env.messages.rows.get(topicId === null ? `group:${chatId}` : `topic:${chatId}:${topicId}`) ?? [],
    activity: async chatId => (chatId === GROUP ? env.messages.activity : []),
    log: m => env.logs.push(m),
  });
}

export function topicLive(env: TopicEnv, fresh = false) {
  const state = fresh ? new TopicStateStore({ file: env.stateFile }) : env.state;
  return createTelegramLiveFeed({
    userId: USER,
    groupId: () => env.group.id,
    onMessageSaved: env.feed.onMessageSaved,
    topicState: chatId => state.forChat(chatId),
    log: m => env.logs.push(m),
  });
}

/** Chat-Attrappe für Telegram-Gespräche; hold hält den Turn offen */
export class HoldChat implements WebChat {
  turns: RunTurnOptions[] = [];
  private releases: (() => void)[] = [];
  hold = false;
  async runTurn(opts: RunTurnOptions): Promise<TurnResult> {
    this.turns.push(opts);
    if (this.hold) await new Promise<void>(resolve => this.releases.push(resolve));
    return { text: "ok" };
  }
  release() {
    for (const r of this.releases.splice(0)) r();
  }
  stop() {
    this.release();
  }
}

export interface ServerCtx {
  server: WebServer;
  origin: string;
  cookie: string;
  logs: string[];
  store: ConversationStore;
  api(path: string, method?: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
}

/** Server mit Umgebung; env null: ohne Topic-Verwaltung */
export async function topicServer(
  root: string,
  servers: WebServer[],
  env: TopicEnv | null,
  deps: Partial<WebServerDeps> = {}
): Promise<ServerCtx> {
  const dir = join(root, `srv-${++envCounter}`);
  const logs: string[] = [];
  const store = new ConversationStore({ dir: join(dir, "web") });
  await store.load();
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    {
      sessionFile: join(dir, "sessions.json"),
      dataDir: join(dir, "web"),
      conversationStore: store,
      telegram: env ? topicSource(env) : undefined,
      telegramLive: env ? topicLive(env) : undefined,
      topics: env?.manager,
      log: m => logs.push(m),
      ...deps,
    }
  );
  servers.push(server);
  const origin = server.url;
  const login = await fetch(`${origin}/api/login`, { method: "POST", headers: { origin }, body: JSON.stringify({ password: PASSWORD }) });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  return {
    server,
    origin,
    cookie,
    logs,
    store,
    api(path, method = "GET", body, headers = {}) {
      return fetch(`${origin}${path}`, {
        method,
        headers: { cookie, origin, "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
    },
  };
}
