import { atomicWriteFile } from "./atomic-file";
/**
 * Topic Names — forum topic ID → human-readable name.
 *
 * The Bot API cannot list forum topics, so names come from two sources:
 * - scripts/fetch-forum-topics.ts (one-off MTProto dump of all topics)
 * - passive capture: a message in a topic carries the topic-creation
 *   service message in reply_to_message.forum_topic_created.name
 *
 * Stored in data/topic-names.json (id → name). Fail-open: missing file or
 * write errors must never affect message handling (recordTopicName).
 * saveTopicName and forgetTopicName (WebUI, Issue #29) throw instead.
 */

import { dirname, join } from "path";
import { mkdir, readFile } from "fs/promises";

const NAMES_FILE = join(process.cwd(), "data", "topic-names.json");

export interface TopicNameStore {
  getTopicName(topicId: number | string): Promise<string | undefined>;
  getTopicNames(): Promise<Record<string, string>>;
  recordTopicName(topicId: number, name: string): Promise<void>;
  /** Wie recordTopicName, aber nur wenn für das Topic noch kein Name bekannt ist */
  recordTopicNameIfMissing(topicId: number, name: string): Promise<void>;
  saveTopicName(topicId: number, name: string): Promise<void>;
  forgetTopicName(topicId: number): Promise<void>;
}

/** Namensspeicher für eine Datei; die Modul-Funktionen unten nutzen data/topic-names.json. `file` anders nur in Tests. */
export function createTopicNameStore(file: string = NAMES_FILE): TopicNameStore {
  let cache: Record<string, string> | null = null;
  // false: cache ist nur der tolerante Ersatz für eine unlesbare Datei, kein gültiger Stand
  let cacheValid = false;
  // Gleichzeitige erste Lesezugriffe teilen sich ein Lesen
  let loading: Promise<ReadResult> | null = null;
  // Änderungen (Lesen, Ändern, Schreiben) laufen nacheinander
  let chain: Promise<unknown> = Promise.resolve();

  type ReadResult = { names: Record<string, string>; valid: boolean; error?: unknown };

  async function readNames(): Promise<ReadResult> {
    try {
      const parsed = JSON.parse(await readFile(file, "utf-8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("topic-names.json ist kein Objekt");
      return { names: parsed, valid: true };
    } catch (e: any) {
      return { names: {}, valid: e?.code === "ENOENT", error: e?.code === "ENOENT" ? undefined : e };
    }
  }

  async function load(): Promise<Record<string, string>> {
    if (cache) return cache;
    if (!loading) loading = readNames().finally(() => (loading = null));
    const read = await loading;
    // Nur übernehmen, wenn inzwischen keine Änderung einen Stand gesetzt hat
    if (!cache) {
      cache = read.names;
      cacheValid = read.valid;
    }
    return cache;
  }

  /** Wie load, aber eine vorhandene, unlesbare Datei ist ein Fehler (nie überschreiben). Nur innerhalb von serialize */
  async function loadStrict(): Promise<Record<string, string>> {
    if (cache && cacheValid) return cache;
    const read = await readNames();
    if (!read.valid) throw read.error;
    cache = read.names;
    cacheValid = true;
    return cache;
  }

  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.catch(() => {}).then(fn);
    chain = run.catch(() => {});
    return run;
  }

  async function write(names: Record<string, string>): Promise<void> {
    await mkdir(dirname(file), { recursive: true }).catch(() => {});
    await atomicWriteFile(file, JSON.stringify(names, null, 2));
  }

  return {
    async getTopicName(topicId) {
      return (await load())[String(topicId)];
    },
    async getTopicNames() {
      return { ...(await load()) };
    },
    /** Record a topic name seen in an incoming message (new or renamed topic). */
    recordTopicName: (topicId, name) =>
      serialize(async () => {
        try {
          const names = await load();
          if (names[String(topicId)] === name) return;
          names[String(topicId)] = name;
          await write(names);
        } catch (err) {
          console.error("[TopicNames] record failed:", err);
        }
      }),
    recordTopicNameIfMissing: (topicId, name) =>
      serialize(async () => {
        try {
          const names = await load();
          if (names[String(topicId)] !== undefined) return;
          names[String(topicId)] = name;
          await write(names);
        } catch (err) {
          console.error("[TopicNames] record failed:", err);
        }
      }),
    /** Wie recordTopicName, wirft aber Schreibfehler (WebUI, Issue #29); der Stand ändert sich erst nach dem Schreiben */
    saveTopicName: (topicId, name) =>
      serialize(async () => {
        const names = await loadStrict();
        const key = String(topicId);
        if (names[key] === name) return;
        const next = { ...names, [key]: name };
        await write(next);
        cache = next;
      }),
    /** Vergisst den Namen eines gelöschten Topics (Issue #29); wirft Schreibfehler */
    forgetTopicName: topicId =>
      serialize(async () => {
        const names = await loadStrict();
        const key = String(topicId);
        if (!(key in names)) return;
        const next = { ...names };
        delete next[key];
        await write(next);
        cache = next;
      }),
  };
}

const defaultStore = createTopicNameStore();

export const getTopicName = defaultStore.getTopicName;
export const getTopicNames = defaultStore.getTopicNames;
export const recordTopicName = defaultStore.recordTopicName;
export const recordTopicNameIfMissing = defaultStore.recordTopicNameIfMissing;
export const saveTopicName = defaultStore.saveTopicName;
export const forgetTopicName = defaultStore.forgetTopicName;

/**
 * Extract the topic name from a Telegram message object, if present.
 * Direct messages in a topic reply to the forum_topic_created service
 * message; topic create/edit service messages carry the name directly.
 */
export function topicNameFromMessage(msg: any): string | undefined {
  return (
    msg?.reply_to_message?.forum_topic_created?.name ||
    msg?.forum_topic_created?.name ||
    msg?.forum_topic_edited?.name ||
    undefined
  );
}

/**
 * Name aus einer Nachricht und ob er den aktuellen Stand beschreibt.
 * `current`: Service-Nachricht zum Anlegen oder Umbenennen (forum_topic_created
 * bzw. forum_topic_edited direkt an der Nachricht). Nicht aktuell: der
 * Erstellungsname, der in reply_to_message jeder Topic-Nachricht mitreist; er
 * bleibt nach einer Umbenennung alt und darf einen bekannten Namen nie
 * überschreiben (Codex-Befund zu PR #31).
 */
export function topicNameCapture(msg: any): { name: string; current: boolean } | undefined {
  const edited = msg?.forum_topic_edited?.name;
  if (edited) return { name: edited, current: true };
  const created = msg?.forum_topic_created?.name;
  if (created) return { name: created, current: true };
  const replied = msg?.reply_to_message?.forum_topic_created?.name;
  if (replied) return { name: replied, current: false };
  return undefined;
}

/** Merkt sich den Namen aus einer Nachricht nach den Regeln von topicNameCapture. */
export async function captureTopicName(
  store: Pick<TopicNameStore, "recordTopicName" | "recordTopicNameIfMissing">,
  topicId: number,
  msg: any
): Promise<void> {
  const captured = topicNameCapture(msg);
  if (!captured) return;
  if (captured.current) await store.recordTopicName(topicId, captured.name);
  else await store.recordTopicNameIfMissing(topicId, captured.name);
}
