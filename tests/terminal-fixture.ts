/**
 * Gemeinsame Attrappen für die Terminal-Tests (Issue #60): ein echter
 * Web-Server nur im Test, mit Terminal-Schlüssel in einem temporären Ordner,
 * Telegram-Gesprächen aus der Demo-Quelle (Eingänge per receive + emit, nie
 * echtes Telegram) und einem steuerbaren Turn. src/bot.ts wird nie geladen.
 */
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunTurnOptions, TurnResult, WebChat } from "../src/web/chat";
import { createDemoInstructions, createDemoTelegram, createDemoTopics, DEMO_GROUP_ID, type DemoTelegram } from "../src/web/demo";
import { createChoicePort, type ChoicePort, type ChoiceRegister, type ChoiceVia, type RegisterChoice, type RegisterDecideOutcome } from "../src/web/choices";
import { parseTelegramConversationId } from "../src/web/telegram";
import type { InstructionsPort } from "../src/web/instructions";
import type { SessionResetResult } from "../src/web/session-reset";
import { ConversationStore } from "../src/web/store";
import { createWebServer, type WebServer } from "../src/web/server";
import type { TelegramLiveEvent } from "../src/web/telegram";
import { ApiClient, tokenFromFile } from "../src/terminal/api";
import { commandRegistry } from "../src/lib/commands/builtin";
import type { CommandPort, CommandRequest } from "../src/web/commands";
import { stripStyle } from "../src/terminal/render";

export const TEST_PASSWORD = "test-passwort-lang";

interface OpenTurn {
  opts: RunTurnOptions;
  finish(result: TurnResult): void;
}

/** Turn, den der Test selbst beendet; merkt sich Aufrufe und Stopps */
export interface ScriptedChat extends WebChat {
  calls: RunTurnOptions[];
  stops: string[];
  /** Wartet, bis im Gespräch ein Turn läuft */
  turn(id: string): Promise<OpenTurn>;
  finish(id: string, text: string): void;
}

export function createScriptedChat(): ScriptedChat {
  const calls: RunTurnOptions[] = [];
  const stops: string[] = [];
  const open = new Map<string, OpenTurn>();
  const waiters = new Map<string, ((t: OpenTurn) => void)[]>();
  return {
    calls,
    stops,
    runTurn(opts) {
      calls.push(opts);
      return new Promise<TurnResult>(resolve => {
        const turn: OpenTurn = {
          opts,
          finish: result => {
            open.delete(opts.conversationId);
            resolve(result);
          },
        };
        open.set(opts.conversationId, turn);
        for (const w of waiters.get(opts.conversationId)?.splice(0) ?? []) w(turn);
      });
    },
    stop(id) {
      stops.push(id);
      open.get(id)?.finish({ text: "", aborted: true });
    },
    turn(id) {
      const current = open.get(id);
      if (current) return Promise.resolve(current);
      return new Promise(resolve => {
        const list = waiters.get(id) ?? [];
        list.push(resolve);
        waiters.set(id, list);
      });
    },
    finish(id, text) {
      open.get(id)?.finish({ text, info: { agent: "general", model: "attrappe", durationMs: 1200 } });
    },
  };
}

/** Chat-ID des Direktchats in der Rückfragen-Attrappe (TELEGRAM_USER_ID) */
export const CHOICE_TEST_USER = "4711";

/**
 * Rückfragen-Attrappe (Issue #120): Register nur im Speicher mit denselben
 * Regeln wie src/lib/choices.ts (erster Klick gewinnt, unbekannte Option
 * lässt offen), dahinter der echte ChoicePort. Fragen gehören zu Telegram-
 * Gesprächen der Demo (dm, topic-<n>). Nie data/choices.json.
 */
export interface TestChoiceRegister {
  port: ChoicePort;
  /** Jede Entscheidung, die das Register erreicht hat (auch abgewiesene) */
  decisions: { id: string; key: string; via: ChoiceVia }[];
  /** Offene Frage anlegen; die Nachricht dazu legt TerminalTestServer.ask an */
  create(conversationId: string, options?: { key: string; label: string }[]): string;
  /** Klick in Telegram (oder einem anderen Kanal): Zuhörer erfahren es sofort (SSE choice) */
  decideIn(via: ChoiceVia, id: string, key: string): Promise<RegisterDecideOutcome>;
  /** Wie ein anderer Prozess: Stand ändern, ohne dass dieser Prozess es meldet */
  decideSilently(id: string, key: string, via?: ChoiceVia): void;
  expireSilently(id: string): void;
  get(id: string): RegisterChoice | undefined;
}

export const TEST_CHOICE_OPTIONS = [
  { key: "ok", label: "Erlauben" },
  { key: "no", label: "Ablehnen" },
];

export function createTestChoiceRegister(): TestChoiceRegister {
  const choices = new Map<string, RegisterChoice>();
  const decisions: TestChoiceRegister["decisions"] = [];
  const listeners = new Set<(change: { type: string; choice: RegisterChoice }) => void>();
  let counter = 0;
  const copy = (c: RegisterChoice): RegisterChoice => structuredClone(c);
  function apply(c: RegisterChoice, key: string, via: ChoiceVia): void {
    const option = c.options.find(o => o.key === key)!;
    c.state = "done";
    c.result = { key: option.key, label: option.label, via, at: Date.now() };
  }
  async function decide(id: string, key: string, via: ChoiceVia): Promise<RegisterDecideOutcome> {
    decisions.push({ id, key, via });
    const c = choices.get(id);
    if (!c) return { status: "unknown" };
    if (c.state === "done") return { status: "already", choice: copy(c) };
    if (c.state === "expired") return { status: "expired" };
    if (!c.options.some(o => o.key === key)) return { status: "invalid_key", choice: copy(c) };
    apply(c, key, via);
    for (const listener of [...listeners]) listener({ type: "decided", choice: copy(c) });
    return { status: "decided", choice: copy(c) };
  }
  const register: ChoiceRegister = {
    get: async id => (choices.has(id) ? copy(choices.get(id)!) : undefined),
    list: async () => [...choices.values()].map(copy),
    decide,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const port = createChoicePort({
    register,
    userId: CHOICE_TEST_USER,
    groupId: () => DEMO_GROUP_ID,
    // Kein Abgleich per Zeitgeber: verpasste Änderungen holt nur die Stand-Abfrage
    every: () => () => {},
    log: () => {},
  });
  return {
    port,
    decisions,
    create(conversationId, options = TEST_CHOICE_OPTIONS) {
      const parsed = parseTelegramConversationId(conversationId);
      if (!parsed) throw new Error(`Kein Telegram-Gespräch: ${conversationId}`);
      const id = `Frage${String(++counter).padStart(6, "0")}`;
      const conversation =
        parsed.kind === "dm"
          ? { type: "telegram" as const, chatId: CHOICE_TEST_USER }
          : { type: "telegram" as const, chatId: DEMO_GROUP_ID, topicId: parsed.topicId };
      choices.set(id, { id, conversation, options: options.map(o => ({ ...o })), state: "open" });
      return id;
    },
    decideIn: (via, id, key) => decide(id, key, via),
    decideSilently(id, key, via = "telegram") {
      apply(choices.get(id)!, key, via);
    },
    expireSilently(id) {
      choices.get(id)!.state = "expired";
    },
    get: id => choices.get(id),
  };
}

export interface TerminalTestServer {
  server: WebServer;
  base: string;
  dir: string;
  tokenFile: string;
  telegram: DemoTelegram;
  chat: ScriptedChat;
  telegramChat: ScriptedChat;
  /** Nachricht wie aus Telegram: in den Verlauf der Attrappe und live an offene Verbindungen */
  receiveFromTelegram(id: string, role: "user" | "assistant", text: string): TelegramLiveEvent;
  /** Nur mit manage: Anweisungen im Speicher, Session-Resets (Gesprächs-IDs), ID des älteren Web-Gesprächs */
  instructions: InstructionsPort;
  resets: string[];
  webConversationId: string | null;
  /** Nur mit commands: ausgeführte Befehle */
  commandRuns: CommandRequest[];
  /** Nur mit choices: Rückfragen-Register */
  choices: TestChoiceRegister | null;
  /**
   * Nur mit choices: offene Rückfrage wie aus Telegram anlegen, als Meldung
   * in den Verlauf und live an offene Verbindungen; liefert ihre Kennung
   */
  ask(conversationId: string, text: string, options?: { key: string; label: string }[]): string;
  client(): ApiClient;
  stop(): Promise<void>;
}

export interface TyboServerOptions {
  keepaliveMs?: number;
  /** Liefert true: der Verlauf der Telegram-Quelle wirft wie ein Lesefehler der Datenbank */
  historyFails?: () => boolean;
  /**
   * Issue #61: Topics verwalten (Attrappe aus der Demo, Topic 7 geschlossen),
   * Anweisungen, Session-Reset und ein älteres Web-Gespräch „Altes Web-Gespräch"
   * mit Agent research
   */
  manage?: boolean;
  /** Ergebnis des Session-Resets (Standard: eine Session zurückgesetzt, Session-Modus an) */
  resetResult?: (conversationId: string) => SessionResetResult;
  /**
   * Issue #74: Befehls-Port mit dem echten Register. Ausführung als Attrappe:
   * /stop stoppt den laufenden Turn, jeder Befehl antwortet mit einer
   * Meldung „<name> ausgeführt" (bei /stop „gestoppt").
   */
  commands?: boolean;
  /** Issue #120: Rückfragen-Register im Speicher (siehe createTestChoiceRegister) */
  choices?: boolean;
  /**
   * Issue #228: ohne Telegram bzw. ohne Forum-Gruppe. Nur der Direktchat
   * (API-ID dm, im Bot die Chat-ID "web"), keine Topics, keine Gruppe:
   * „Neues Gespräch" legt ein Web-Gespräch an
   */
  withoutTelegram?: boolean;
}

export async function startTyboServer(options: TyboServerOptions = {}): Promise<TerminalTestServer> {
  const dir = await mkdtemp(join(tmpdir(), "tybo-terminal-srv-"));
  const tokenFile = join(dir, "data", "cli-token");
  const demoTopics = options.manage ? createDemoTopics({ seed: true }) : null;
  const telegram = demoTopics?.telegram ?? createDemoTelegram(Date.now(), { seed: true });
  const instructions = createDemoInstructions();
  const resets: string[] = [];
  let conversationStore: ConversationStore | undefined;
  let webConversationId: string | null = null;
  if (options.manage) {
    conversationStore = new ConversationStore({ dir: join(dir, "web") });
    await conversationStore.load();
    const web = await conversationStore.createConversation("research");
    await conversationStore.renameConversation(web.id, "Altes Web-Gespräch");
    webConversationId = web.id;
  }
  if (options.withoutTelegram) {
    const list = telegram.listConversations.bind(telegram);
    const get = telegram.getConversation.bind(telegram);
    telegram.listConversations = async () => ({ ...(await list()), topics: [] });
    telegram.getConversation = async id => (id === "dm" ? get(id) : null);
    telegram.groupChatId = () => null;
  }
  const historyFails = options.historyFails;
  if (historyFails) {
    const history = telegram.history.bind(telegram);
    telegram.history = async (id, before) => {
      if (historyFails()) throw new Error("Verlauf lesen fehlgeschlagen");
      return history(id, before);
    };
  }
  const listeners = new Set<(event: TelegramLiveEvent) => void>();
  const chat = createScriptedChat();
  const telegramChat = createScriptedChat();
  const commandRuns: CommandRequest[] = [];
  const choices = options.choices ? createTestChoiceRegister() : null;
  const commands: CommandPort = {
    list: channel => commandRegistry.list(channel),
    match(text, channel) {
      const found = commandRegistry.match(text, channel);
      return found ? { name: found.command.name, whileBusy: !!found.command.whileBusy || !!found.command.unscoped?.(found.args) } : null;
    },
    async run(req) {
      commandRuns.push(req);
      const name = commandRegistry.match(req.text, req.source)!.command.name;
      if (name === "stop") {
        const target = req.conversationId.startsWith("topic-") || req.conversationId === "dm" ? telegramChat : chat;
        target.stop(req.conversationId);
        await req.notice("gestoppt");
        return {};
      }
      await req.notice(`${name} ausgeführt`);
      return {};
    },
  };
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: TEST_PASSWORD, allowedHosts: [] },
    {
      sessionFile: join(dir, "sessions.json"),
      dataDir: join(dir, "web"),
      cliTokenFile: tokenFile,
      chat,
      telegram,
      telegramChat,
      ...(options.manage
        ? {
            conversationStore,
            topics: demoTopics!.topics,
            instructions,
            resetConversation: async (id: string) => {
              resets.push(id);
              return options.resetResult?.(id) ?? { status: "done" as const, reset: 1, sessionMode: true };
            },
          }
        : {}),
      telegramLive: {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      ...(options.commands ? { commands } : {}),
      ...(choices ? { choices: choices.port } : {}),
      keepaliveMs: options.keepaliveMs,
      log: () => {},
    }
  );
  const base = server.url.replace(/\/$/, "");
  return {
    server,
    base,
    dir,
    tokenFile,
    telegram,
    chat,
    telegramChat,
    instructions,
    resets,
    webConversationId,
    commandRuns,
    choices,
    ask(id, text, opts) {
      if (!choices) throw new Error("Server ohne choices gestartet");
      const choiceId = choices.create(id, opts);
      const event = telegram.receiveNotice(id, "freigabe", text, undefined, choiceId);
      if (!event) throw new Error(`Unbekanntes Gespräch ${id}`);
      for (const l of [...listeners]) l(event);
      return choiceId;
    },
    receiveFromTelegram(id, role, text) {
      const event = telegram.receive(id, role, text, role === "assistant" ? "general" : undefined);
      if (!event) throw new Error(`Unbekanntes Gespräch ${id}`);
      for (const l of [...listeners]) l(event);
      return event;
    },
    client: () => new ApiClient({ base, getToken: tokenFromFile(tokenFile) }),
    async stop() {
      await server.stop({ graceMs: 200 });
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Wartet, bis cond() wahr ist (höchstens timeoutMs) */
export async function waitFor(cond: () => boolean, timeoutMs = 3000, what = "Bedingung"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Zeitüberschreitung: ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

/** Terminal im Raw-Modus zum Nachbilden (Issues #60, #61) */
export class FakeStdin extends EventEmitter {
  isTTY = true;
  rawModes: boolean[] = [];
  setRawMode(mode: boolean) {
    this.rawModes.push(mode);
    return this;
  }
  resume() {
    return this;
  }
  pause() {
    return this;
  }
  type(data: string) {
    this.emit("data", Buffer.from(data, "utf8"));
  }
  /** Jedes Byte als eigener Block, also auch mitten in Umlauten und Emoji geteilt */
  typeBytewise(data: string) {
    for (const byte of Buffer.from(data, "utf8")) this.emit("data", Buffer.from([byte]));
  }
}

export class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 100;
  chunks: string[] = [];
  write(text: string) {
    this.chunks.push(text);
    return true;
  }
  get all() {
    return this.chunks.join("");
  }
  /** Sichtbarer Text ohne Farben und Cursor-Befehle */
  get text() {
    return stripStyle(this.all).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
  }
}
