/**
 * Telegram-Topics aus der WebUI verwalten (Issue #29, Entscheidung 0005):
 * Rechte abfragen, anlegen, umbenennen, schließen, öffnen, löschen und die
 * automatische Titelvergabe aus der ersten Nutzernachricht.
 *
 * Wie server.ts lädt diese Datei zur Laufzeit nichts aus src/lib und nichts
 * aus src/bot.ts. Telegram (TelegramTopicApi), Zustand, Zuordnung, Namen,
 * Sessions und Ausführungen kommen als Abhängigkeiten herein; in bot.ts
 * die echten, in Tests und Demo Attrappen.
 *
 * Telegram-Fehler werden nie roh weitergegeben: TOPIC_NOT_MODIFIED gilt als
 * Erfolg, „not enough rights" ergibt 403 mit dem fehlenden Recht, alles
 * andere 502. Im Log stehen nur Methode und Fehlercode.
 */

import type { MessageSavedListener, SavedMessageEvent } from "../lib/convex";
import type { TopicStateEntry } from "../lib/topic-state";
import { DEFAULT_TITLE, titleFrom } from "./store";
import { telegramTopicConversationId, type TelegramConversation } from "./telegram";

/** Titel eines frisch angelegten Topics, bis die erste Nachricht ihn setzt */
export const NEW_TOPIC_TITLE = DEFAULT_TITLE;
/** Telegram erlaubt 1 bis 128 Zeichen für Topic-Namen */
export const TOPIC_TITLE_MAX_CHARS = 128;
export const RIGHTS_CACHE_MS = 60_000;
/** So lange wartet das Löschen auf das Ende abgebrochener Ausführungen */
export const DELETE_DRAIN_MS = 30_000;
/** Danach gibt ein aufgeschobener Session-Reset auf (nur Log) */
export const DEFERRED_RESET_MS = 10 * 60_000;
/** General hat in der Bot-API keine Thread-ID und lässt sich nicht verwalten */
const GENERAL_TOPIC_ID = 1;

/**
 * setMapping: der gewählte Agent ist inzwischen gelöscht (Issue #50). Die
 * Prüfung liegt in der Schreibkette von config/topics.json, dieselbe Kette
 * stellt beim Löschen eines Agenten dessen Topics um.
 */
export class TopicAgentGone extends Error {
  constructor() {
    super("Agent inzwischen gelöscht");
    this.name = "TopicAgentGone";
  }
}

export const TEXT = {
  notConfigured: "Topics verwalten ist nicht eingerichtet",
  noGroup: "Keine Forum-Gruppe eingerichtet (TELEGRAM_GROUP_ID)",
  noManageTopics: "Dem Bot fehlt in der Gruppe das Recht ‚Topics verwalten'",
  noDeleteMessages: "Dem Bot fehlt in der Gruppe das Recht ‚Nachrichten löschen'",
  rejected: "Telegram hat die Aktion abgelehnt",
  rightsFailed: "Telegram hat die Rechte des Bots nicht geliefert",
  partialCreate: "Topic angelegt, Agent-Zuordnung nicht gespeichert",
  busy: "In diesem Topic läuft gerade eine Antwort",
  notFound: "Gespräch nicht gefunden",
  stateFailed: "Der Topic-Zustand konnte nicht gespeichert werden",
  renamedNotSaved: "In Telegram umbenannt, Name in der WebUI nicht gespeichert",
  closedNotSaved: "In Telegram geändert, Zustand in der WebUI nicht gespeichert",
  closed: "Das Topic ist geschlossen. Erst wieder öffnen.",
  confirmMismatch: "Zum Löschen den genauen Namen des Topics angeben",
  nameUnreadable: "Der Name des Topics konnte nicht gelesen werden",
  agentNotSaved: "Agent-Zuordnung nicht gespeichert",
  agentGone: "Dieser Agent wurde inzwischen gelöscht, die Zuordnung ist nicht gespeichert",
  renamedAgentNotSaved: "Umbenannt, Agent-Zuordnung nicht gespeichert",
  /**
   * Sessions liegen je Topic und Agent (src/lib/session-manager.ts): der neue
   * Agent beginnt frisch, ein früherer Agent dieses Topics kann seine alte
   * Session fortsetzen, solange sie nicht abgelaufen ist.
   */
  agentChanged:
    "Gilt ab der nächsten Nachricht in diesem Topic. War der Agent hier schon einmal aktiv, kann er seine frühere Session fortsetzen; /new in Telegram beginnt frisch.",
} as const;

export interface TopicRights {
  manageTopics: boolean;
  deleteMessages: boolean;
}

/** Telegram-Zugriffe; in bot.ts ein Adapter um grammY bot.api, in Tests eine Attrappe */
export interface TelegramTopicApi {
  createForumTopic(chatId: string, name: string): Promise<{ topicId: number }>;
  editForumTopic(chatId: string, topicId: number, name: string): Promise<void>;
  closeForumTopic(chatId: string, topicId: number): Promise<void>;
  reopenForumTopic(chatId: string, topicId: number): Promise<void>;
  deleteForumTopic(chatId: string, topicId: number): Promise<void>;
  /** Rechte des Haupt-Bots in der Gruppe (getChatMember) */
  getMyRights(chatId: string): Promise<TopicRights>;
}

/**
 * Rechte aus einem ChatMember der Bot-API: creator hat alles, administrator
 * nach can_manage_topics und can_delete_messages, alle anderen nichts.
 */
export function rightsFromChatMember(member: unknown): TopicRights {
  const m = (member && typeof member === "object" ? member : {}) as Record<string, unknown>;
  if (m.status === "creator") return { manageTopics: true, deleteMessages: true };
  if (m.status === "administrator") {
    return { manageTopics: m.can_manage_topics === true, deleteMessages: m.can_delete_messages === true };
  }
  return { manageTopics: false, deleteMessages: false };
}

/** Was die Verwaltung vom Topic-Zustand braucht (src/lib/topic-state.ts) */
export interface TopicStatePort {
  forChat(chatId: string): Promise<Map<number, TopicStateEntry>>;
  get(chatId: string, topicId: number): Promise<TopicStateEntry>;
  setFlag(chatId: string, topicId: number, flag: keyof TopicStateEntry, on: boolean): Promise<void>;
  claimAutoTitle(chatId: string, topicId: number): Promise<boolean>;
}

/** Ausführungen eines Session-Schlüssels (src/lib/execution-context.ts) */
export interface ExecutionPort {
  /** Läuft oder wartet irgendeine Ausführung für den Schlüssel (jeder Agent, auch Update-Bereiche)? */
  isActive(key: string): boolean;
  /** Sperrt neue Ausführungen des Schlüssels; gibt die Freigabe zurück */
  block(key: string): () => void;
  abort(key: string): number;
  /** true, sobald keine Ausführung mehr läuft; false nach Ablauf der Frist */
  waitIdle(key: string, timeoutMs: number): Promise<boolean>;
}

export interface TopicManagerDeps {
  api: TelegramTopicApi;
  /** Forum-Gruppe, bei jedem Aufruf neu (wie in bot-telegram.ts) */
  groupId(): string | null;
  state: TopicStatePort;
  /** config/topics.json (setTopicMapping, removeTopicMapping) */
  setMapping(chatId: string, topicId: number, agent: string): Promise<void>;
  removeMapping(chatId: string, topicId: number): Promise<void>;
  /** data/topic-names.json; beide werfen Schreibfehler */
  saveName(topicId: number, name: string): Promise<void>;
  forgetName(topicId: number): Promise<void>;
  /** Gespeicherter Name, unverändert (ohne Trimmen); ohne ihn gilt der Anzeigetitel */
  getName?(topicId: number): Promise<string | undefined>;
  /** Alle Agenten-Sessions des Schlüssels zurücksetzen; wirft bei Fehlern */
  resetSession(sessionKey: string): Promise<unknown>;
  executions: ExecutionPort;
  /** Für die automatische Titelvergabe; ohne ihn gibt es keine */
  onMessageSaved?(listener: MessageSavedListener): () => void;
  now?: () => number;
  /** Nie Token, URL oder Rohdaten übergeben */
  log?: (message: string) => void;
  drainMs?: number;
  deferredResetMs?: number;
}

export interface TopicResult {
  status: number;
  body: Record<string, unknown>;
}

class TopicError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(String(body.error ?? status));
  }
  result(): TopicResult {
    return { status: this.status, body: this.body };
  }
}

type Right = "manage" | "delete";

function forbidden(right: Right): TopicError {
  return right === "delete"
    ? new TopicError(403, { error: TEXT.noDeleteMessages, reason: "no_delete_messages" })
    : new TopicError(403, { error: TEXT.noManageTopics, reason: "no_manage_topics" });
}

function describe(e: unknown): { text: string; code: number | null } {
  const err = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
  const text = typeof err.description === "string" ? err.description : typeof err.message === "string" ? err.message : "";
  const code = typeof err.error_code === "number" ? err.error_code : null;
  return { text, code };
}

export function isTopicNotModified(e: unknown): boolean {
  return /TOPIC_NOT_MODIFIED/.test(describe(e).text);
}

export function isNotEnoughRights(e: unknown): boolean {
  return /not enough rights/i.test(describe(e).text);
}

/** Validierter Titel für Umbenennen: außen ohne Leerraum, 1 bis 128 Zeichen, keine Steuerzeichen; sonst null */
export function normalizeTopicTitle(title: unknown): string | null {
  if (typeof title !== "string") return null;
  const clean = title.trim();
  const length = [...clean].length;
  if (length < 1 || length > TOPIC_TITLE_MAX_CHARS) return null;
  if (/\p{Cc}/u.test(clean)) return null;
  return clean;
}

export function topicSessionKey(chatId: string, topicId: number): string {
  return `topic:${chatId}:${topicId}`;
}

export interface TopicManager {
  /** Rechte des Bots; ohne Gruppe group: false. Wirft TopicError 502 bei Abfragefehlern */
  rights(): Promise<TopicResult>;
  create(agent: string): Promise<TopicResult>;
  rename(conversation: TelegramConversation, topicId: number, title: unknown): Promise<TopicResult>;
  setClosed(conversation: TelegramConversation, topicId: number, closed: boolean): Promise<TopicResult>;
  /**
   * Agent des Topics ändern (Issue #36): nur config/topics.json, kein
   * Telegram-Aufruf. Unter derselben Topic-Sperre wie Löschen, ein gelöschtes
   * Topic ergibt 404. Den Agentennamen prüft der Aufrufer.
   */
  setAgent(conversation: TelegramConversation, topicId: number, agent: string): Promise<TopicResult>;
  /**
   * Name, den DELETE exakt bestätigen muss: der gespeicherte Name unverändert,
   * auch mit Leerraum an den Rändern; ohne gespeicherten Namen der Anzeigetitel
   */
  exactName(topicId: number, displayTitle: string): Promise<string>;
  /** Vor der Sperre des Hubs: Recht „Nachrichten löschen" vorhanden? null wenn ja, sonst Fehlerantwort */
  checkDeleteRights(): Promise<TopicResult | null>;
  /**
   * Schritte 2 bis 6 des Löschens; der Aufrufer hält die Sperre des Hubs.
   * `confirmed` prüft den bestätigten Namen gegen den aktuellen, innerhalb
   * derselben Topic-Sperre wie Umbenennen; false ergibt 400.
   */
  delete(topicId: number, confirmed: () => Promise<boolean>): Promise<TopicResult>;
  /** Automatische Titelvergabe einschalten; gibt die Abmeldung zurück */
  startAutoTitle(): () => void;
  /** Wartet auf laufende Titelvergaben (Tests) */
  idle(): Promise<void>;
}

export function createTopicManager(deps: TopicManagerDeps): TopicManager {
  const log = deps.log ?? ((m: string) => console.log(`[web] ${m}`));
  const now = deps.now ?? Date.now;
  const drainMs = deps.drainMs ?? DELETE_DRAIN_MS;
  const deferredResetMs = deps.deferredResetMs ?? DEFERRED_RESET_MS;
  const rightsCache = new Map<string, { at: number; rights: TopicRights }>();
  const locks = new Map<number, Promise<unknown>>();
  const pending = new Set<Promise<unknown>>();

  function errorName(e: unknown): string {
    return e instanceof Error ? e.name : typeof e;
  }

  /** Ein Vorgang pro Topic zur Zeit: Titelvergabe, Umbenennen, Schließen und Löschen überholen sich nicht */
  function withTopicLock<T>(topicId: number, fn: () => Promise<T>): Promise<T> {
    const run = (locks.get(topicId) ?? Promise.resolve()).catch(() => {}).then(fn);
    locks.set(topicId, run);
    void run.finally(() => {
      if (locks.get(topicId) === run) locks.delete(topicId);
    }).catch(() => {});
    return run;
  }

  /** Telegram-Fehler abbilden; TOPIC_NOT_MODIFIED nur dort, wo es Erfolg bedeutet */
  async function telegram(method: string, right: Right, call: () => Promise<unknown>, notModifiedOk = false): Promise<void> {
    try {
      await call();
    } catch (e) {
      if (notModifiedOk && isTopicNotModified(e)) return;
      const { code } = describe(e);
      log(`Telegram ${method} fehlgeschlagen (Code ${code ?? "unbekannt"})`);
      if (isNotEnoughRights(e)) throw forbidden(right);
      throw new TopicError(502, { error: TEXT.rejected });
    }
  }

  function currentGroup(): string | null {
    try {
      return deps.groupId();
    } catch {
      return null;
    }
  }

  /** Höchstens 60 s zwischengespeichert, getrennt nach Gruppe; Fehler nie */
  async function rightsFor(chatId: string): Promise<TopicRights> {
    const cached = rightsCache.get(chatId);
    if (cached && now() - cached.at < RIGHTS_CACHE_MS) return cached.rights;
    let rights: TopicRights;
    try {
      const raw = await deps.api.getMyRights(chatId);
      rights = { manageTopics: raw?.manageTopics === true, deleteMessages: raw?.deleteMessages === true };
    } catch (e) {
      log(`Telegram getChatMember fehlgeschlagen (Code ${describe(e).code ?? "unbekannt"})`);
      throw new TopicError(502, { error: TEXT.rightsFailed });
    }
    rightsCache.set(chatId, { at: now(), rights });
    return rights;
  }

  async function guard(fn: () => Promise<TopicResult>): Promise<TopicResult> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof TopicError) return e.result();
      throw e;
    }
  }

  function requireGroup(): string {
    const chatId = currentGroup();
    // Ohne Gruppe gibt es kein Topic außer General; der Server findet es dann gar nicht
    if (!chatId) throw new TopicError(404, { error: TEXT.notFound });
    return chatId;
  }

  async function stillExists(chatId: string, topicId: number): Promise<void> {
    let entry: TopicStateEntry;
    try {
      entry = await deps.state.get(chatId, topicId);
    } catch (e) {
      log(`Topic-Zustand nicht lesbar (${errorName(e)})`);
      throw new TopicError(500, { error: TEXT.stateFailed });
    }
    if (entry.deleted) throw new TopicError(404, { error: TEXT.notFound });
  }

  async function autoTitle(event: SavedMessageEvent): Promise<void> {
    if (event.role !== "user" || typeof event.content !== "string") return;
    const chatId = currentGroup();
    if (!chatId || event.chatId !== chatId) return;
    const topicId = event.metadata?.topicId;
    if (typeof topicId !== "number" || !Number.isSafeInteger(topicId) || topicId <= GENERAL_TOPIC_ID) return;
    const title = titleFrom(event.content);
    await withTopicLock(topicId, async () => {
      // Beanspruchen vor dem Telegram-Aufruf: genau einmal, auch wenn Telegram scheitert
      if (!(await deps.state.claimAutoTitle(chatId, topicId))) return;
      if (title === NEW_TOPIC_TITLE) return;
      try {
        await telegram("editForumTopic", "manage", () => deps.api.editForumTopic(chatId, topicId, title), true);
      } catch {
        log(`Automatischer Titel für Topic ${topicId} nicht gesetzt, es bleibt „${NEW_TOPIC_TITLE}"`);
        return;
      }
      try {
        await deps.saveName(topicId, title);
      } catch (e) {
        log(`Automatischer Titel für Topic ${topicId} nicht gespeichert (${errorName(e)})`);
      }
    });
  }

  return {
    rights: () =>
      guard(async () => {
        const chatId = currentGroup();
        if (!chatId) return { status: 200, body: { manageTopics: false, deleteMessages: false, group: false } };
        const rights = await rightsFor(chatId);
        return { status: 200, body: { ...rights, group: true } };
      }),

    create: agent =>
      guard(async () => {
        const chatId = currentGroup();
        if (!chatId) throw new TopicError(409, { error: TEXT.noGroup, reason: "no_group" });
        if (!(await rightsFor(chatId)).manageTopics) throw forbidden("manage");
        let topicId = 0;
        await telegram("createForumTopic", "manage", async () => {
          topicId = (await deps.api.createForumTopic(chatId, NEW_TOPIC_TITLE))?.topicId;
        });
        if (!Number.isSafeInteger(topicId) || topicId <= GENERAL_TOPIC_ID) {
          log("Telegram createForumTopic lieferte keine gültige Topic-ID");
          throw new TopicError(502, { error: TEXT.rejected });
        }
        const conversation: TelegramConversation = { id: telegramTopicConversationId(topicId), title: NEW_TOPIC_TITLE, agent, lastActivity: null };
        // Jeder Schritt für sich: ein Fehler verhindert die anderen nicht; das Topic bleibt bestehen
        const failed: string[] = [];
        const attempt = async (what: string, fn: () => Promise<unknown>) => {
          try {
            await fn();
          } catch (e) {
            failed.push(`${what} (${errorName(e)})`);
          }
        };
        await attempt("Zuordnung", () => deps.setMapping(chatId, topicId, agent));
        await attempt("Name", () => deps.saveName(topicId, NEW_TOPIC_TITLE));
        await attempt("Zustand", () => deps.state.setFlag(chatId, topicId, "autoTitle", true));
        if (failed.length) {
          log(`Topic ${topicId} angelegt, nicht gespeichert: ${failed.join(", ")}`);
          return { status: 500, body: { error: TEXT.partialCreate, conversation } };
        }
        log(`Topic ${topicId} angelegt (Agent ${agent})`);
        return { status: 201, body: { conversation } };
      }),

    rename: (conversation, topicId, rawTitle) =>
      guard(async () => {
        const title = normalizeTopicTitle(rawTitle);
        if (title === null) {
          return { status: 400, body: { error: `Titel muss 1 bis ${TOPIC_TITLE_MAX_CHARS} Zeichen lang sein, ohne Steuerzeichen` } };
        }
        const chatId = requireGroup();
        return withTopicLock(topicId, async () => {
          await stillExists(chatId, topicId);
          await telegram("editForumTopic", "manage", () => deps.api.editForumTopic(chatId, topicId, title), true);
          // Nach dem Umbenennen gilt der neue, bereinigte Name auch für die Bestätigung
          const { exactTitle: _exact, ...rest } = conversation;
          const renamed = { ...rest, title };
          const failed: string[] = [];
          try {
            await deps.saveName(topicId, title);
          } catch (e) {
            failed.push(`Name (${errorName(e)})`);
          }
          try {
            await deps.state.setFlag(chatId, topicId, "autoTitle", false);
          } catch (e) {
            failed.push(`Zustand (${errorName(e)})`);
          }
          if (failed.length) {
            log(`Topic ${topicId} in Telegram umbenannt, nicht gespeichert: ${failed.join(", ")}`);
            return { status: 500, body: { error: TEXT.renamedNotSaved, conversation: renamed } };
          }
          return { status: 200, body: { conversation: renamed } };
        });
      }),

    setClosed: (conversation, topicId, closed) =>
      guard(async () => {
        const chatId = requireGroup();
        return withTopicLock(topicId, async () => {
          await stillExists(chatId, topicId);
          if (closed) await telegram("closeForumTopic", "manage", () => deps.api.closeForumTopic(chatId, topicId), true);
          else await telegram("reopenForumTopic", "manage", () => deps.api.reopenForumTopic(chatId, topicId), true);
          const { closed: _old, ...rest } = conversation;
          const updated: TelegramConversation = closed ? { ...rest, closed: true } : rest;
          try {
            await deps.state.setFlag(chatId, topicId, "closed", closed);
          } catch (e) {
            log(`Topic ${topicId} in Telegram ${closed ? "geschlossen" : "geöffnet"}, Zustand nicht gespeichert (${errorName(e)})`);
            return { status: 500, body: { error: TEXT.closedNotSaved, conversation: updated } };
          }
          return { status: 200, body: { conversation: updated } };
        });
      }),

    setAgent: (conversation, topicId, agent) =>
      guard(async () => {
        const chatId = requireGroup();
        return withTopicLock(topicId, async () => {
          await stillExists(chatId, topicId);
          try {
            await deps.setMapping(chatId, topicId, agent);
          } catch (e) {
            if (e instanceof TopicAgentGone) return { status: 409, body: { error: TEXT.agentGone } };
            log(`Topic ${topicId}: Agent-Zuordnung nicht gespeichert (${errorName(e)})`);
            return { status: 500, body: { error: TEXT.agentNotSaved } };
          }
          log(`Topic ${topicId}: Agent ${agent}`);
          return { status: 200, body: { conversation: { ...conversation, agent }, note: TEXT.agentChanged } };
        });
      }),

    async exactName(topicId, displayTitle) {
      const stored = deps.getName ? await deps.getName(topicId) : undefined;
      return typeof stored === "string" && stored.trim() ? stored : displayTitle;
    },

    async checkDeleteRights() {
      const result = await guard(async () => {
        const chatId = requireGroup();
        if (!(await rightsFor(chatId)).deleteMessages) throw forbidden("delete");
        return { status: 200, body: {} };
      });
      return result.status === 200 ? null : result;
    },

    delete: (topicId, confirmed) =>
      guard(async () => {
        const chatId = requireGroup();
        return withTopicLock(topicId, async () => {
          await stillExists(chatId, topicId);
          // Aktuellen Namen neu prüfen: ein Umbenennen davor darf den alten Namen nicht mehr gelten lassen
          let nameOk: boolean;
          try {
            nameOk = await confirmed();
          } catch (e) {
            log(`Topic ${topicId}: Name zum Löschen nicht lesbar (${errorName(e)}), nichts gelöscht`);
            return { status: 500, body: { error: TEXT.nameUnreadable } };
          }
          if (!nameOk) return { status: 400, body: { error: TEXT.confirmMismatch } };
          const key = topicSessionKey(chatId, topicId);
          const exec = deps.executions;
          // Prüfen und Sperren ohne await dazwischen: nichts schlüpft durch
          if (exec.isActive(key)) return { status: 409, body: { error: TEXT.busy } };
          let release: (() => void) | null = exec.block(key);
          try {
            try {
              await deps.state.setFlag(chatId, topicId, "deleted", true);
            } catch (e) {
              log(`Topic ${topicId}: Löschen nicht vermerkt (${errorName(e)}), nichts gelöscht`);
              return { status: 500, body: { error: TEXT.stateFailed } };
            }
            try {
              await telegram("deleteForumTopic", "delete", () => deps.api.deleteForumTopic(chatId, topicId));
            } catch (e) {
              try {
                await deps.state.setFlag(chatId, topicId, "deleted", false);
              } catch (rollback) {
                log(`Topic ${topicId}: Löschen in Telegram gescheitert, bleibt aber in der WebUI ausgeblendet (${errorName(rollback)})`);
              }
              throw e;
            }
            log(`Topic ${topicId} in Telegram gelöscht`);
            // Was seit der Prüfung aus Telegram hereinkam: abbrechen und auf das Ende warten
            exec.abort(key);
            const idle = await exec.waitIdle(key, drainMs);
            const failed: string[] = [];
            const attempt = async (what: string, fn: () => Promise<unknown>) => {
              try {
                await fn();
              } catch (e) {
                failed.push(`${what} (${errorName(e)})`);
              }
            };
            await attempt("Zuordnung", () => deps.removeMapping(chatId, topicId));
            await attempt("Name", () => deps.forgetName(topicId));
            if (idle) {
              await attempt("Session", () => deps.resetSession(key));
            } else {
              // Nie ungeschützt gegen eine noch laufende Ausführung zurücksetzen:
              // Sperre halten, erst nach deren Ende zurücksetzen
              failed.push("Session (Ausführung läuft noch, Reset folgt)");
              const hold = release;
              release = null;
              const deferred = exec
                .waitIdle(key, deferredResetMs)
                .then(async done => {
                  if (!done) {
                    log(`Topic ${topicId}: Ausführung endet nicht, Session nicht zurückgesetzt`);
                    return;
                  }
                  await deps.resetSession(key);
                  log(`Topic ${topicId}: Session nachträglich zurückgesetzt`);
                })
                .catch(e => log(`Topic ${topicId}: Session nicht zurückgesetzt (${errorName(e)})`))
                .finally(() => hold());
              pending.add(deferred);
              void deferred.finally(() => pending.delete(deferred));
            }
            if (failed.length) {
              log(`Topic ${topicId} gelöscht, Aufräumen unvollständig: ${failed.join(", ")}`);
              return { status: 200, body: { deleted: true, cleanup: "unvollständig" } };
            }
            return { status: 200, body: { deleted: true } };
          } finally {
            release?.();
          }
        });
      }),

    startAutoTitle() {
      if (!deps.onMessageSaved) return () => {};
      return deps.onMessageSaved(event => {
        const run = autoTitle(event).catch(e => log(`Automatischer Titel fehlgeschlagen (${errorName(e)})`));
        pending.add(run);
        void run.finally(() => pending.delete(run));
      });
    },

    async idle() {
      while (pending.size) await Promise.allSettled([...pending]);
      while (locks.size) await Promise.allSettled([...locks.values()]);
    },
  };
}
