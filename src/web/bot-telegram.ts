/**
 * Telegram-Gespräche als zweite Quelle der WebUI (Issue #17): Direktchat und
 * Forum-Topics mit Name, Agent, letzter Aktivität und Verlauf. Geschrieben
 * wird über createTelegramChat in bot-turn.ts (Issue #19).
 *
 * Wie bot-turn.ts bindet nur src/bot.ts diese Datei ein; der Web-Server
 * kennt nur die Schnittstelle TelegramSource aus ./telegram. Alle Zugriffe
 * auf Namen, Zuordnung und Nachrichtenspeicher kommen als Abhängigkeiten
 * herein, damit Tests mit Attrappen auskommen.
 */

import { getTopicConfigChatIds, getTopicMappingForChat } from "../agents/base";
import {
  getConversationHistory,
  getDisplayOnlyPage,
  getLatestDisplayOnlyAt,
  getTopicActivity,
  onMessageSaved,
  sessionKeyFor,
  type DisplayOnlyPageOptions,
  type DisplayOnlyRow,
  type HistoryOptions,
  type HistoryRow,
  type MessageSavedListener,
  type SavedMessageEvent,
  type TopicActivity,
} from "../lib/convex";
import { getTopicNames } from "../lib/topic-names";
import { TopicStateStore, type TopicStateEntry } from "../lib/topic-state";
import { pickApiAttachments } from "./attachments";
import { toApiMessage } from "./chat";
import { isDisplayOnlyMetadata, pickNotice } from "./notice";
import { isChoiceId, pickReplyInfo } from "./store";
import {
  TELEGRAM_HISTORY_LIMIT,
  isWebMessageId,
  normalizeIsoTimestamp,
  parseTelegramConversationId,
  telegramTopicConversationId,
  type TelegramApiMessage,
  type TelegramConversation,
  type TelegramConversationList,
  type TelegramLiveEvent,
  type TelegramLiveFeed,
  type TelegramSource,
  type TelegramTopicChangeEvent,
} from "./telegram";
import { topicChanges, type TopicChangeListener } from "./topic-changes";

type Env = Record<string, string | undefined>;

/** Zeitraum, in dem die letzte Aktivität gesucht wird; älteres gilt als unbekannt (null) */
export const ACTIVITY_SINCE_DAYS = 60;
export const DM_TITLE = "Direktchat";
export const GENERAL_TITLE = "General";
export const FALLBACK_AGENT = "general";
/** Das Forum-Thema General hat in der Bot-API keine Thread-ID */
export const GENERAL_TOPIC_ID = 1;
/** metadata.channel der im Web geschriebenen Nachrichten (wie WEB_CHANNEL in bot-turn.ts) */
const WEB_CHANNEL = "web";

const AGENT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const GROUP_ID_PATTERN = /^-\d{1,20}$/;
const USER_ID_PATTERN = /^\d{1,20}$/;
const TOPIC_KEY_PATTERN = /^[1-9]\d{0,9}$/;

export interface BotTelegramDeps {
  /** TELEGRAM_USER_ID; ohne gültige ID gibt es keinen Direktchat */
  userId?: string;
  /** Chat-ID der Forum-Gruppe, bei jedem Aufruf neu (topics.json wird live gelesen); null: nur Direktchat */
  groupId(): string | null;
  /** Topic-ID → Name (data/topic-names.json) */
  topicNames(): Promise<Record<string, string>>;
  /** Topic-ID → Agent für die Gruppe (config/topics.json) */
  topicMapping(chatId: string): Record<string, string>;
  history(chatId: string, topicId: number | null, options: HistoryOptions): Promise<HistoryRow[]>;
  activity(chatId: string, sinceDays: number): Promise<TopicActivity[]>;
  /**
   * Topic-Zustand der Gruppe (Issue #29, data/topic-state.json): gelöschte
   * Topics fehlen immer, geschlossene tragen closed. Wirft der Zustand, zeigt
   * die Liste nur General, damit nichts Gelöschtes zurückkommt.
   */
  topicState?(chatId: string): Promise<Map<number, TopicStateEntry>>;
  /** Nie Nachrichtentexte oder Zugangsdaten übergeben */
  log?(message: string): void;
}

/**
 * Forum-Gruppe: TELEGRAM_GROUP_ID, sonst die erste Chat-ID aus
 * config/topics.json, die mit "-" beginnt; sonst null (nur Direktchat).
 */
export function resolveGroupId(env: Env, configuredChatIds: string[]): string | null {
  const fromEnv = env.TELEGRAM_GROUP_ID?.trim();
  if (fromEnv && GROUP_ID_PATTERN.test(fromEnv)) return fromEnv;
  return configuredChatIds.find(id => GROUP_ID_PATTERN.test(id)) ?? null;
}

/** Forum-Gruppe des laufenden Bots: .env und config/topics.json (live gelesen) */
export function botGroupId(env: Env): string | null {
  return resolveGroupId(env, getTopicConfigChatIds());
}

/** Topic-ID aus einem Session-Schlüssel der Gruppe; General (group:<id>) ist 1. */
function topicIdFromSessionKey(sessionKey: string, groupId: string): number | null {
  if (sessionKey === `group:${groupId}`) return GENERAL_TOPIC_ID;
  const prefix = `topic:${groupId}:`;
  if (!sessionKey.startsWith(prefix)) return null;
  const rest = sessionKey.slice(prefix.length);
  return TOPIC_KEY_PATTERN.test(rest) ? Number(rest) : null;
}

/** Mikrosekunden bleiben erhalten, sie dienen als Cursor für ?before= */
function isoOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const precise = normalizeIsoTimestamp(value);
  if (precise) return precise;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** Einheitlich sechs Nachkommastellen, damit .123Z nicht hinter .123001Z sortiert (Date.parse verliert Mikrosekunden) */
function activitySortKey(value: string): string {
  return value.replace(/\.(\d{3})Z$/, ".$1000Z");
}

function compareTopics(a: TelegramConversation, b: TelegramConversation): number {
  if (a.lastActivity && b.lastActivity) {
    const ka = activitySortKey(a.lastActivity);
    const kb = activitySortKey(b.lastActivity);
    if (ka !== kb) return ka < kb ? 1 : -1;
  } else if (a.lastActivity) return -1;
  else if (b.lastActivity) return 1;
  return a.title.localeCompare(b.title, "de") || a.id.localeCompare(b.id);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * ID aus metadata.msgId: Telegram-Nachrichten-ID (Vertrag aus Issue #17),
 * web-<uuid> für im Browser geschriebene Nachrichten (Issue #19, dieselbe ID
 * wie in POST und SSE) oder die UUID, die saveMessage seit Issue #20 jeder
 * Nachricht gibt (dieselbe ID in SSE und Verlauf); sonst null
 */
function telegramMessageId(metadata: Record<string, unknown> | null): string | null {
  const v = metadata?.msgId;
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return String(v);
  if (typeof v === "string" && /^\d{1,20}$/.test(v)) return v;
  if (isWebMessageId(v)) return v;
  if (typeof v === "string" && UUID_PATTERN.test(v)) return v;
  return null;
}

/**
 * Zeile aus dem Nachrichtenspeicher im Format der Web-Gespräche; nur erlaubte
 * Felder. Mit conversationId bekommen eigene Nachrichten ihre Anhänge
 * (Issue #72, metadata.attachments) samt Download-Adressen in diesem Gespräch;
 * der Text ist dann der im Browser geschriebene (metadata.webText), nicht
 * der für den Speicher um Anhang-Zeilen ergänzte.
 */
export function toTelegramApiMessage(row: HistoryRow, seen: Set<string> = new Set(), conversationId?: string): TelegramApiMessage | null {
  if (row.role !== "user" && row.role !== "assistant") return null;
  if (typeof row.content !== "string") return null;
  const createdAt = isoOrNull(row.created_at);
  if (!createdAt) return null;
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : null;
  let id = telegramMessageId(metadata);
  if (!id || seen.has(id)) id = `db-${row.id}`;
  seen.add(id);
  // Rückfrage (Issue #114/#115): metadata.choiceId nur bei Antworten und Meldungen, nur gültig;
  // den Zustand ergänzt der Server aus dem Register
  const choice = row.role === "assistant" && isChoiceId(metadata?.choiceId) ? { choiceId: metadata!.choiceId as string } : {};
  // Meldungen (Issue #47): nur display_only === true, nur geprüfte source und file, nie lokale Pfade
  const notice = pickNotice(metadata);
  if (notice) return toApiMessage({ id, role: "assistant", text: row.content, createdAt, ...notice, ...choice });
  if (row.role === "user" && conversationId) {
    const attachments = pickApiAttachments(metadata?.attachments, conversationId);
    if (attachments.length) {
      const text = typeof metadata?.webText === "string" ? metadata.webText : row.content;
      return toApiMessage({ id, role: "user", text, createdAt, attachments });
    }
  }
  // Agent, Modell und Dauer (Issue #22) nur bei Antworten und nur geprüft; ältere Zeilen haben sie nicht
  return toApiMessage({ id, role: row.role, text: row.content, createdAt, ...(row.role === "assistant" ? { ...pickReplyInfo(metadata), ...choice } : {}) });
}

export function createTelegramSource(deps: BotTelegramDeps): TelegramSource {
  const log = deps.log ?? ((m: string) => console.log(`[web] ${m}`));
  const userId = deps.userId && USER_ID_PATTERN.test(deps.userId) ? deps.userId : null;

  async function listConversations(): Promise<TelegramConversationList> {
    let groupId: string | null = null;
    try {
      groupId = deps.groupId();
    } catch {
      log("Telegram-Gruppe nicht ermittelbar, nur Direktchat");
    }

    const safe = async <T>(what: string, fn: () => Promise<T> | T, fallback: T): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        log(`Telegram-${what} nicht lesbar (${e instanceof Error ? e.name : typeof e})`);
        return fallback;
      }
    };
    const noMap: Record<string, string> = {};
    const noActivity: TopicActivity[] = [];
    const [names, mapping, groupActivity, dmActivity] = await Promise.all([
      groupId ? safe("Namen", () => deps.topicNames(), noMap) : noMap,
      groupId ? safe("Zuordnung", () => deps.topicMapping(groupId!), noMap) : noMap,
      groupId ? safe("Aktivität", () => deps.activity(groupId!, ACTIVITY_SINCE_DAYS), noActivity) : noActivity,
      userId ? safe("Aktivität", () => deps.activity(userId, ACTIVITY_SINCE_DAYS), noActivity) : noActivity,
    ]);

    let dm: TelegramConversation | null = null;
    if (userId) {
      const key = sessionKeyFor(userId, null);
      dm = {
        id: "dm",
        title: DM_TITLE,
        agent: FALLBACK_AGENT,
        lastActivity: isoOrNull(dmActivity.find(a => a.sessionKey === key)?.lastActivity),
      };
    }

    let states = new Map<number, TopicStateEntry>();
    let statesUnreadable = false;
    if (groupId && deps.topicState) {
      try {
        states = await deps.topicState(groupId);
      } catch (e) {
        statesUnreadable = true;
        log(`Topic-Zustand nicht lesbar (${e instanceof Error ? e.name : typeof e}), nur General`);
      }
    }

    const topics: TelegramConversation[] = [];
    if (groupId) {
      // Bestand: General, alle benannten, alle zugeordneten und alle mit Aktivität
      const lastActivity = new Map<number, string | null>([[GENERAL_TOPIC_ID, null]]);
      for (const key of [...Object.keys(names), ...Object.keys(mapping)]) {
        if (TOPIC_KEY_PATTERN.test(key) && !lastActivity.has(Number(key))) lastActivity.set(Number(key), null);
      }
      for (const a of groupActivity) {
        const topicId = topicIdFromSessionKey(a.sessionKey, groupId);
        if (topicId !== null && !lastActivity.get(topicId)) lastActivity.set(topicId, isoOrNull(a.lastActivity));
      }
      for (const [topicId, activity] of lastActivity) {
        const isGeneral = topicId === GENERAL_TOPIC_ID;
        const state = states.get(topicId);
        // Gelöscht bleibt gelöscht, auch bei Aktivität, Name oder Zuordnung
        if (!isGeneral && (statesUnreadable || state?.deleted)) continue;
        const key = String(topicId);
        const raw = typeof names[key] === "string" ? names[key] : "";
        const name = raw.trim();
        const agent = mapping[key];
        topics.push({
          id: telegramTopicConversationId(topicId),
          title: name || (topicId === GENERAL_TOPIC_ID ? GENERAL_TITLE : `Topic ${topicId}`),
          agent: typeof agent === "string" && AGENT_PATTERN.test(agent) ? agent : FALLBACK_AGENT,
          lastActivity: activity,
          ...(!isGeneral && state?.closed ? { closed: true as const } : {}),
          ...(name && raw !== name ? { exactTitle: raw } : {}),
        });
      }
      topics.sort(compareTopics);
    }
    return { dm, topics };
  }

  async function getConversation(id: string): Promise<TelegramConversation | null> {
    const ref = parseTelegramConversationId(id);
    if (!ref) return null;
    const list = await listConversations();
    return ref.kind === "dm" ? list.dm : (list.topics.find(t => t.id === id) ?? null);
  }

  return {
    listConversations,
    groupChatId: () => deps.groupId(),
    getConversation,
    async history(id: string, before?: string) {
      const ref = parseTelegramConversationId(id);
      if (!ref || !(await getConversation(id))) return null;
      let chatId: string | null;
      let topicId: number | null = null;
      if (ref.kind === "dm") {
        chatId = userId;
      } else {
        try {
          chatId = deps.groupId();
        } catch {
          chatId = null;
        }
        // General liegt als group:<chatId> (topicId null), nicht als topic:<chatId>:1
        topicId = ref.topicId === GENERAL_TOPIC_ID ? null : ref.topicId;
      }
      if (!chatId) return null;
      // Eine Zeile mehr lesen: zeigt, ob es noch ältere gibt. Lesefehler wirft
      // weiter statt leerer Liste: der Server meldet 503, Browser und tybo versuchen es erneut
      const rows = await deps.history(chatId, topicId, { limit: TELEGRAM_HISTORY_LIMIT + 1, before });
      const hasMore = rows.length > TELEGRAM_HISTORY_LIMIT;
      const seen = new Set<string>();
      const messages = rows
        .slice(hasMore ? rows.length - TELEGRAM_HISTORY_LIMIT : 0)
        .map(row => toTelegramApiMessage(row, seen, id))
        .filter((m): m is TelegramApiMessage => m !== null);
      return { messages, hasMore };
    },
  };
}

/**
 * Telegram-Gespräch einer gespeicherten Nachricht (Issue #20), nur für die
 * konfigurierte Nutzer- und Gruppen-ID: Direktchat ohne Topic ist "dm", die
 * Gruppe ohne Topic (oder Topic 1) "topic-1", sonst "topic-<n>". Fremde
 * Chats und unerwartete topicId-Werte ergeben null.
 */
export function liveConversationId(
  event: Pick<SavedMessageEvent, "chatId" | "metadata">,
  userId: string | null,
  groupId: string | null
): string | null {
  const raw = event.metadata?.topicId;
  let topicId: number | null = null;
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) return null;
    topicId = raw;
  }
  if (userId && event.chatId === userId) return topicId === null ? "dm" : null;
  if (groupId && event.chatId === groupId) {
    const id = telegramTopicConversationId(topicId ?? GENERAL_TOPIC_ID);
    return parseTelegramConversationId(id) ? id : null;
  }
  return null;
}

/**
 * Abholen von Meldungen anderer Prozesse (Issue #47, Entscheidung 0006):
 * Pipeline, Briefing oder `bun run notify` speichern ohne den Hook dieses
 * Prozesses. Beide Abfragen werfen bei Fehlern (siehe src/lib/supabase.ts).
 */
export interface DisplayOnlyPollDeps {
  /** created_at der jüngsten Meldung dieser Chats, null ohne Meldung */
  latestAt(chatIds: string[]): Promise<string | null>;
  /** Meldungen dieser Chats, älteste zuerst (created_at, dann id) */
  page(chatIds: string[], options: DisplayOnlyPageOptions): Promise<DisplayOnlyRow[]>;
  /** Abstand der Abfragen, Standard 15 Sekunden */
  intervalMs?: number;
  /**
   * Zeitgeber: ruft fn alle ms Millisekunden, gibt das Anhalten zurück.
   * Standard setInterval; Tests schalten eine eigene Uhr weiter.
   */
  every?(ms: number, fn: () => Promise<void>): () => void;
  /** Aktuelle Zeit als ISO-Zeitpunkt, Standard die Uhr des Macs; Tests nehmen die Datenbank-Uhr */
  now?(): string;
}

export interface TelegramLiveDeps {
  /** TELEGRAM_USER_ID */
  userId?: string;
  /** Wie in BotTelegramDeps, bei jedem Ereignis neu gelesen */
  groupId(): string | null;
  /** In bot.ts onMessageSaved aus src/lib/convex.ts; gibt die Abmeldung zurück */
  onMessageSaved(listener: MessageSavedListener): () => void;
  /** Wie in BotTelegramDeps: Ereignisse gelöschter Topics werden verworfen (Issue #29) */
  topicState?(chatId: string): Promise<Map<number, TopicStateEntry>>;
  /** In bot.ts topicChanges.on aus ./topic-changes (Issue #32); gibt die Abmeldung zurück */
  onTopicChanged?(listener: TopicChangeListener): () => void;
  /** Meldungen anderer Prozesse abholen (Issue #47); ohne sie nur Meldungen dieses Prozesses */
  displayOnly?: DisplayOnlyPollDeps;
  /** Nie Nachrichtentexte oder Zugangsdaten übergeben */
  log?(message: string): void;
}

export const DISPLAY_ONLY_POLL_MS = 15_000;
/**
 * Rückblick jeder Abfrage hinter die jüngste gesehene Meldung: Supabase
 * vergibt created_at beim Beginn der Transaktion, eine etwas früher
 * begonnene Zeile kann also nach einer späteren sichtbar werden.
 */
export const DISPLAY_ONLY_LOOKBACK_MS = 60_000;
export const DISPLAY_ONLY_PAGE_SIZE = 100;
/** Höchstens so viele Seiten pro Abfrage; der Rest folgt bei der nächsten */
const DISPLAY_ONLY_MAX_PAGES = 10;
/** So viele gemeldete msgIds merkt sich der Feed für die Entdopplung */
const DELIVERED_LIMIT = 5000;
/** So viele Meldungen mit unlesbarem Topic-Zustand hält die Abfrage für einen neuen Versuch */
const RETRY_LIMIT = 1000;

/** Einheitlich sechs Nachkommastellen für Vergleiche; null bei ungültigem Zeitpunkt */
function preciseKey(value: string): string | null {
  const iso = isoOrNull(value);
  return iso ? activitySortKey(iso) : null;
}

/** Millisekunden eines Zeitpunkts aus preciseKey */
function keyMs(key: string): number {
  return Date.parse(`${key.slice(0, 23)}Z`);
}

/** Kennung für die Entdopplung: metadata.msgId (vergibt saveMessageWith immer) */
function dedupKey(metadata: Record<string, unknown> | null | undefined): string | null {
  const v = metadata?.msgId;
  return typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null;
}

/**
 * Gespeicherte Nachrichten als Live-Ereignisse für die WebUI. Im Web
 * geschriebene (channel "web") liefern nur die Aktivität, ihren Inhalt kennt
 * der Browser schon. Die Nachricht hat genau die Felder des Verlaufs
 * (toTelegramApiMessage, Antworten mit serverseitig gerendertem HTML) und
 * dieselbe ID wie beim Nachladen (metadata.msgId).
 *
 * Meldungen (Issue #47) kommen auf zwei Wegen: über den Hook, wenn dieser
 * Prozess sie gespeichert hat, und über die Abfrage alle 15 Sekunden, wenn
 * ein anderer Prozess es war. Ein gemeinsamer Hook und ein gemeinsamer
 * Zeitgeber für alle Zuhörer, gestartet mit dem ersten und angehalten mit dem
 * letzten. Jede Meldung (metadata.msgId) wird genau einmal gemeldet, als
 * Nachricht und als Aktivität, egal welcher Weg sie zuerst sieht.
 */
export function createTelegramLiveFeed(deps: TelegramLiveDeps): TelegramLiveFeed {
  const log = deps.log ?? ((m: string) => console.log(`[web] ${m}`));
  const userId = deps.userId && USER_ID_PATTERN.test(deps.userId) ? deps.userId : null;
  const listeners = new Set<(event: TelegramLiveEvent) => void>();
  let stopHook: (() => void) | null = null;
  let stopPoll: (() => void) | null = null;
  /** Schon gemeldete Meldungen (msgId), älteste zuerst */
  const delivered = new Set<string>();
  /** Meldungen (msgId), deren Topic-Zustand gerade geprüft wird; Ergebnis wie handleSaved */
  const inFlight = new Map<string, Promise<boolean>>();

  function currentGroupId(): string | null {
    try {
      return deps.groupId();
    } catch {
      return null;
    }
  }

  /** Ereignis und, bei echten Topics der Gruppe, die zu prüfende Topic-ID (gelöscht?) */
  function toLiveEvent(event: SavedMessageEvent): { live: TelegramLiveEvent; check: { groupId: string; topicId: number } | null } | null {
    if (event.role !== "user" && event.role !== "assistant") return null;
    const groupId = currentGroupId();
    const conversationId = liveConversationId(event, userId, groupId);
    if (!conversationId) return null;
    const ref = parseTelegramConversationId(conversationId);
    const check = groupId && ref?.kind === "topic" && ref.topicId !== GENERAL_TOPIC_ID ? { groupId, topicId: ref.topicId } : null;
    const live = buildLive(event, conversationId);
    return live ? { live, check } : null;
  }

  function buildLive(event: SavedMessageEvent, conversationId: string): TelegramLiveEvent | null {
    const at = isoOrNull(event.createdAt);
    if (!at) return null;
    if (event.metadata?.channel === WEB_CHANNEL) return { conversationId, at };
    const metadata = event.metadata && typeof event.metadata === "object" ? event.metadata : null;
    const id = telegramMessageId(metadata);
    if (!id) return { conversationId, at };
    const message = toTelegramApiMessage({ id, created_at: at, role: event.role, content: event.content, metadata }, new Set(), conversationId);
    return message ? { conversationId, at, message } : { conversationId, at };
  }

  /**
   * Gelöschte Topics verwerfen; unlesbarer Zustand: nicht melden, lieber als
   * ein gelöschtes zurückzubringen. true: erledigt (gemeldet oder gelöscht),
   * false: Zustand nicht lesbar, nichts gemeldet.
   */
  function unlessDeleted(check: { groupId: string; topicId: number } | null, deliver: () => void, what: string): boolean | Promise<boolean> {
    if (!check || !deps.topicState) {
      deliver();
      return true;
    }
    return deps.topicState(check.groupId).then(
      states => {
        if (!states.get(check.topicId)?.deleted) deliver();
        return true;
      },
      e => {
        log(`${what} nicht gemeldet, Topic-Zustand nicht lesbar (${e instanceof Error ? e.name : typeof e})`);
        return false;
      }
    );
  }

  function broadcast(live: TelegramLiveEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(live);
      } catch (e) {
        log(`Live-Zuhörer fehlgeschlagen (${e instanceof Error ? e.name : typeof e})`);
      }
    }
  }

  function markDelivered(key: string): void {
    delivered.add(key);
    if (delivered.size > DELIVERED_LIMIT) delivered.delete(delivered.values().next().value!);
  }

  /**
   * Meldet eine gespeicherte Nachricht. Meldungen (msgId) höchstens einmal:
   * gemerkt wird erst, wenn sie erledigt ist; läuft dieselbe gerade auf dem
   * anderen Weg, wird deren Ergebnis abgewartet. true: erledigt, false: Topic-
   * Zustand nicht lesbar, ein späterer Versuch darf sie noch melden.
   */
  function handleSaved(event: SavedMessageEvent): boolean | Promise<boolean> {
    let key: string | null;
    let result: ReturnType<typeof toLiveEvent>;
    try {
      key = isDisplayOnlyMetadata(event.metadata) ? dedupKey(event.metadata) : null;
      if (key) {
        if (delivered.has(key)) return true;
        const pending = inFlight.get(key);
        if (pending) return pending.then(done => done || handleSaved(event));
      }
      result = toLiveEvent(event);
    } catch (e) {
      log(`Live-Nachricht nicht zuordenbar (${e instanceof Error ? e.name : typeof e})`);
      return true;
    }
    if (!result) return true;
    const { live, check } = result;
    const outcome = unlessDeleted(check, () => broadcast(live), "Live-Nachricht");
    if (!key) return outcome;
    const dedup = key;
    if (outcome === true) {
      markDelivered(dedup);
      return true;
    }
    if (outcome === false) return false;
    const pending = outcome.then(done => {
      if (done) markDelivered(dedup);
      return done;
    });
    inFlight.set(dedup, pending);
    void pending.finally(() => {
      if (inFlight.get(dedup) === pending) inFlight.delete(dedup);
    });
    return pending;
  }

  function startPolling(poll: DisplayOnlyPollDeps): () => void {
    /** Zeitpunkt, ab dem die WebUI Meldungen live erwartet (preciseKey) */
    const startKey = preciseKey(poll.now ? poll.now() : new Date().toISOString());
    /**
     * Grenze für alte Meldungen, einmal ermittelt und dann behalten: jüngste
     * Meldung laut Datenbank, höchstens der Startzeitpunkt. Was danach
     * gespeichert wird, gilt als neu, auch wenn die erste Abfrage erst später
     * gelingt. undefined: noch nicht ermittelt, null: keine Meldung vorhanden.
     */
    let baseline: string | null | undefined;
    /** Jüngste gesehene Meldung (preciseKey); null: noch keine */
    let watermark: string | null = null;
    /** Nach dem ersten vollständigen Durchlauf (alle Seiten): ältere Meldungen gelten als bekannt */
    let primed = false;
    /** Zeilen-IDs der Meldungen im Rückblick-Fenster → Millisekunden */
    const seenRows = new Map<string, number>();
    /** Meldungen mit unlesbarem Topic-Zustand (Zeilen-ID → Ereignis), älteste zuerst */
    const retryRows = new Map<string, SavedMessageEvent>();
    /** Nächste Seite, wenn die letzte Abfrage beim Seitenlimit aufhörte */
    let resumeAfter: { createdAt: string; id: string } | null = null;
    let running: Promise<void> | null = null;
    let failing = false;
    let stopped = false;

    async function pass(): Promise<void> {
      const groupId = currentGroupId();
      const chatIds = [userId, groupId].filter((c): c is string => !!c);
      if (chatIds.length === 0) return;
      // Startstand: alles bis zur jüngsten Meldung ist schon im Verlauf
      if (baseline === undefined) {
        const latest = await poll.latestAt(chatIds);
        const key = latest ? preciseKey(latest) : null;
        if (latest && !key) throw new Error("ungültiger Zeitpunkt");
        baseline = key && startKey && startKey < key ? startKey : key;
        if (baseline && (!watermark || baseline > watermark)) watermark = baseline;
      }
      // Bis alle Seiten der Initialisierung gelesen sind, bleiben ältere Meldungen still
      const silentUpTo = primed ? null : baseline;
      // Meldungen, deren Topic-Zustand zuletzt nicht lesbar war
      for (const [rowId, event] of [...retryRows]) {
        if (stopped) return;
        if (await handleSaved(event)) retryRows.delete(rowId);
      }
      const since = watermark ? new Date(keyMs(watermark) - DISPLAY_ONLY_LOOKBACK_MS).toISOString() : undefined;
      let after = resumeAfter;
      resumeAfter = null;
      for (let pageNo = 0; pageNo < DISPLAY_ONLY_MAX_PAGES && !stopped; pageNo++) {
        const rows = await poll.page(chatIds, { ...(since ? { since } : {}), ...(after ? { after } : {}), limit: DISPLAY_ONLY_PAGE_SIZE });
        for (const row of rows) {
          const rowId = String(row?.id ?? "");
          const key = typeof row?.created_at === "string" ? preciseKey(row.created_at) : null;
          if (!rowId || !key) continue;
          after = { createdAt: row.created_at, id: rowId };
          if (seenRows.has(rowId)) continue;
          seenRows.set(rowId, keyMs(key));
          if (!watermark || key > watermark) watermark = key;
          if (silentUpTo && key <= silentUpTo) continue;
          if (row.role !== "user" && row.role !== "assistant") continue;
          if (typeof row.chat_id !== "string" || typeof row.content !== "string") continue;
          const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
          if (!isDisplayOnlyMetadata(metadata)) continue;
          const event: SavedMessageEvent = { chatId: row.chat_id, role: row.role, content: row.content, metadata, createdAt: row.created_at };
          if (await handleSaved(event)) continue;
          retryRows.set(rowId, event);
          if (retryRows.size > RETRY_LIMIT) {
            retryRows.delete(retryRows.keys().next().value!);
            log("Meldung aufgegeben, Topic-Zustand zu lange nicht lesbar");
          }
        }
        if (rows.length < DISPLAY_ONLY_PAGE_SIZE) {
          after = null;
          break;
        }
        if (pageNo === DISPLAY_ONLY_MAX_PAGES - 1) resumeAfter = after;
      }
      if (!resumeAfter && !stopped) primed = true;
      if (watermark) {
        const oldest = keyMs(watermark) - 2 * DISPLAY_ONLY_LOOKBACK_MS;
        for (const [id, ms] of seenRows) if (ms < oldest) seenRows.delete(id);
      }
    }

    /** Eine Abfrage zur Zeit; überschneidet sich der Zeitgeber, zählt die laufende */
    function tick(): Promise<void> {
      if (stopped) return Promise.resolve();
      if (running) return running;
      running = pass()
        .then(
          () => {
            if (failing) log("Meldungen werden wieder abgeholt");
            failing = false;
          },
          e => {
            // Stand bleibt, die nächste Abfrage versucht es erneut; nur einmal pro Störung loggen
            if (!failing) log(`Meldungen nicht abrufbar (${e instanceof Error ? e.name : typeof e})`);
            failing = true;
          }
        )
        .finally(() => {
          running = null;
        });
      return running;
    }

    const every =
      poll.every ??
      ((ms: number, fn: () => Promise<void>) => {
        const timer = setInterval(() => void fn(), ms);
        (timer as { unref?: () => void }).unref?.();
        return () => clearInterval(timer);
      });
    const stopTimer = every(poll.intervalMs ?? DISPLAY_ONLY_POLL_MS, tick);
    // Sofort den Startstand holen, damit die erste echte Abfrage nur Neues meldet
    void tick();
    return () => {
      stopped = true;
      stopTimer();
    };
  }

  function start(): void {
    stopHook = deps.onMessageSaved(event => {
      const outcome = handleSaved(event);
      return typeof outcome === "boolean" ? undefined : outcome.then(() => undefined);
    });
    if (deps.displayOnly) {
      try {
        stopPoll = startPolling(deps.displayOnly);
      } catch (e) {
        log(`Meldungen anderer Prozesse nicht verfügbar (${e instanceof Error ? e.name : typeof e})`);
      }
    }
  }

  function stop(): void {
    stopHook?.();
    stopHook = null;
    stopPoll?.();
    stopPoll = null;
  }

  const feed: TelegramLiveFeed = {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        try {
          start();
        } catch (e) {
          listeners.delete(listener);
          stop();
          throw e;
        }
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
  };
  const onTopicChanged = deps.onTopicChanged;
  if (onTopicChanged) {
    // Nur Topics der aktuellen Forum-Gruppe; General hat keinen Namen aus Telegram
    feed.subscribeTopicChanges = listener =>
      onTopicChanged(change => {
        const groupId = currentGroupId();
        if (!groupId || change.chatId !== groupId || change.topicId === GENERAL_TOPIC_ID) return;
        const conversationId = telegramTopicConversationId(change.topicId);
        if (!parseTelegramConversationId(conversationId)) return;
        const event: TelegramTopicChangeEvent = { conversationId };
        void unlessDeleted({ groupId, topicId: change.topicId }, () => listener(event), "Topic-Änderung");
      });
  }
  return feed;
}

/**
 * Topic-Zustand (data/topic-state.json, Issue #29): eine Instanz für Quelle,
 * Live-Feed und Verwaltung (bot-topics.ts), damit alle dasselbe sehen.
 */
export const botTopicState = new TopicStateStore();

/** Echte Live-Quelle für src/bot.ts: Nachrichten aus saveMessage und Meldungen anderer Prozesse */
export function createBotTelegramLive(env: Env, log?: (message: string) => void): TelegramLiveFeed {
  return createTelegramLiveFeed({
    userId: env.TELEGRAM_USER_ID,
    groupId: () => botGroupId(env),
    onMessageSaved,
    topicState: chatId => botTopicState.forChat(chatId),
    onTopicChanged: topicChanges.on,
    // Meldungen anderer Prozesse (Pipeline, Briefing, notify) alle 15 Sekunden (Issue #47)
    displayOnly: { latestAt: getLatestDisplayOnlyAt, page: getDisplayOnlyPage },
    log,
  });
}

/** Echte Quelle für src/bot.ts: Supabase über src/lib/convex.ts, Namen und Zuordnung aus data/ und config/. */
export function createBotTelegram(env: Env, log?: (message: string) => void): TelegramSource {
  return createTelegramSource({
    userId: env.TELEGRAM_USER_ID,
    groupId: () => botGroupId(env),
    topicNames: getTopicNames,
    topicMapping: getTopicMappingForChat,
    history: getConversationHistory,
    activity: getTopicActivity,
    topicState: chatId => botTopicState.forChat(chatId),
    log,
  });
}
