/**
 * Topics, die direkt in Telegram angelegt oder umbenannt werden (Issue #32).
 *
 * Telegram schickt dafür Service-Nachrichten (forum_topic_created,
 * forum_topic_edited) ohne Text; der Text-Handler in src/bot.ts sieht sie
 * nie. handleTopicServiceMessage merkt sich den Namen und meldet die
 * Änderung an topicChanges, von dort gehen sie über den Live-Feed
 * (bot-telegram.ts) an die offenen Browser.
 *
 * src/bot.ts ruft nur handleTopicServiceMessage auf (hinter der
 * Nutzer-Prüfung); alles andere kommt als Abhängigkeit herein, damit Tests
 * ohne bot.ts auskommen.
 */

import { captureTopicName, type TopicNameStore } from "../lib/topic-names";

/** Das Forum-Thema General (wie in bot-telegram.ts, hier ohne dessen Supabase-Abhängigkeiten) */
const GENERAL_TOPIC_ID = 1;

/** Name eines Topics der Forum-Gruppe hat sich geändert oder das Topic ist neu */
export interface TopicChange {
  chatId: string;
  topicId: number;
}

export type TopicChangeListener = (change: TopicChange) => void;

export interface TopicChangeHub {
  /** Gibt die Abmeldung zurück */
  on(listener: TopicChangeListener): () => void;
  /** Ein werfender Zuhörer hält die übrigen nicht auf */
  emit(change: TopicChange): void;
}

export function createTopicChangeHub(log: (message: string) => void = m => console.log(`[web] ${m}`)): TopicChangeHub {
  const listeners = new Set<TopicChangeListener>();
  return {
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(change) {
      for (const listener of [...listeners]) {
        try {
          listener(change);
        } catch (e) {
          log(`Topic-Änderung nicht weitergegeben (${e instanceof Error ? e.name : typeof e})`);
        }
      }
    },
  };
}

/** Eine Instanz für bot.ts (Service-Nachrichten) und den Live-Feed der WebUI */
export const topicChanges = createTopicChangeHub();

export interface TopicServiceDeps {
  /** Forum-Gruppe der WebUI, bei jedem Aufruf neu (botGroupId) */
  groupId(): string | null;
  store: Pick<TopicNameStore, "recordTopicName" | "recordTopicNameIfMissing">;
  notify(change: TopicChange): void;
  /** Nie Namen oder Zugangsdaten übergeben */
  log?(message: string): void;
}

/** Größte Topic-ID, die die WebUI kennt (zehn Stellen wie in bot-telegram.ts) */
const MAX_TOPIC_ID = 9_999_999_999;

function validName(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Service-Nachricht zum Anlegen oder Umbenennen eines Topics. Nur für die
 * Forum-Gruppe der WebUI, nur mit gültiger Thread-ID und nur mit Namen:
 * forum_topic_edited ohne Namen (nur Symbol geändert) ist keine Umbenennung.
 * Der Name ist geschrieben, bevor die Änderung gemeldet wird, damit ein
 * sofortiger Listenabruf ihn sieht. Gibt zurück, ob gemeldet wurde; wirft nie.
 */
export async function handleTopicServiceMessage(deps: TopicServiceDeps, chatId: string, msg: any): Promise<boolean> {
  const log = deps.log ?? ((m: string) => console.log(`[web] ${m}`));
  try {
    const topicId = msg?.message_thread_id;
    if (typeof topicId !== "number" || !Number.isSafeInteger(topicId) || topicId <= GENERAL_TOPIC_ID || topicId > MAX_TOPIC_ID) {
      return false;
    }
    // Nur der Name aus der Service-Nachricht selbst; der alte Erstellungsname
    // in reply_to_message darf hier nie hineinrutschen
    const edited = validName(msg?.forum_topic_edited?.name);
    const created = edited ? null : validName(msg?.forum_topic_created?.name);
    if (!edited && !created) return false;

    let groupId: string | null = null;
    try {
      groupId = deps.groupId();
    } catch {
      groupId = null;
    }
    // Der Namensspeicher kennt nur Topic-IDs: fremde Gruppen dürfen nie schreiben
    if (!groupId || chatId !== groupId) return false;

    const service = edited ? { forum_topic_edited: { name: edited } } : { forum_topic_created: { name: created } };
    await captureTopicName(deps.store, topicId, service);
    deps.notify({ chatId: groupId, topicId });
    return true;
  } catch (e) {
    log(`Topic-Name aus Telegram nicht übernommen (${e instanceof Error ? e.name : typeof e})`);
    return false;
  }
}
