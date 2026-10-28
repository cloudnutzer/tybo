/**
 * Topic-Zustand für die Verwaltung aus der WebUI (Issue #29, Entscheidung 0005).
 *
 * data/topic-state.json, Schlüssel "<chatId>:<topicId>":
 *   closed     zuletzt in der WebUI geschlossen (Schließen direkt in Telegram
 *              wird nicht nachgeführt)
 *   deleted    dauerhaft gelöscht: taucht nie wieder in der WebUI auf, auch
 *              wenn Supabase, topic-names.json oder topics.json das Topic
 *              noch kennen
 *   autoTitle  die erste Nutzernachricht setzt den Titel (genau einmal)
 *
 * Nur eine fehlende Datei gilt als leerer Anfang. Eine unlesbare oder
 * beschädigte Datei ist ein Fehler, sonst kämen gelöschte Topics zurück.
 * Ändern läuft über eine Schreibkette (Lesen, Ändern, Schreiben am Stück),
 * atomar geschrieben; Schreibfehler werden geworfen. Nach einem Fehler
 * bleibt die Kette benutzbar.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-file";

export interface TopicStateEntry {
  closed?: true;
  deleted?: true;
  autoTitle?: true;
}

export type TopicStateMap = Record<string, TopicStateEntry>;

export const DEFAULT_TOPIC_STATE_FILE = join(process.cwd(), "data", "topic-state.json");

const FLAGS = ["closed", "deleted", "autoTitle"] as const;

export function topicStateKey(chatId: string, topicId: number): string {
  return `${chatId}:${topicId}`;
}

/** Nur bekannte Felder mit Wert true; leere Einträge fallen weg */
function cleanEntry(value: unknown): TopicStateEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry: TopicStateEntry = {};
  for (const flag of FLAGS) if ((value as Record<string, unknown>)[flag] === true) entry[flag] = true;
  return Object.keys(entry).length ? entry : null;
}

export class TopicStateStore {
  private readonly file: string;
  private cache: TopicStateMap | null = null;
  private loading: Promise<TopicStateMap> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly readText: (file: string) => Promise<string>;

  /** readText nur für Tests (Lesen verzögern), sonst readFile */
  constructor(options: { file?: string; readText?: (file: string) => Promise<string> } = {}) {
    this.file = options.file ?? DEFAULT_TOPIC_STATE_FILE;
    this.readText = options.readText ?? (file => readFile(file, "utf-8"));
  }

  /**
   * Gleichzeitige erste Lesezugriffe teilen sich ein Lesen. Ein Leseergebnis
   * ersetzt nie einen schon vorhandenen Cache, sonst gingen dort inzwischen
   * gespeicherte Änderungen verloren. Nach einem Lesefehler wird beim
   * nächsten Zugriff neu gelesen.
   */
  private load(): Promise<TopicStateMap> {
    if (this.cache) return Promise.resolve(this.cache);
    if (!this.loading) {
      const loading = this.readFromDisk().then(
        map => {
          if (this.loading === loading) this.loading = null;
          return (this.cache ??= map);
        },
        e => {
          if (this.loading === loading) this.loading = null;
          throw e;
        },
      );
      this.loading = loading;
    }
    return this.loading;
  }

  private async readFromDisk(): Promise<TopicStateMap> {
    let raw: string;
    try {
      raw = await this.readText(this.file);
    } catch (e: any) {
      if (e?.code === "ENOENT") return {};
      throw e;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Topic-Zustand ist kein Objekt");
    const map: TopicStateMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      const entry = cleanEntry(value);
      if (entry) map[key] = entry;
    }
    return map;
  }

  /** Alle Einträge (Kopie). Wirft, wenn die Datei unlesbar oder beschädigt ist. */
  async all(): Promise<TopicStateMap> {
    const map = await this.load();
    const copy: TopicStateMap = {};
    for (const [key, entry] of Object.entries(map)) copy[key] = { ...entry };
    return copy;
  }

  /** Einträge einer Gruppe, nach Topic-ID */
  async forChat(chatId: string): Promise<Map<number, TopicStateEntry>> {
    const prefix = `${chatId}:`;
    const out = new Map<number, TopicStateEntry>();
    for (const [key, entry] of Object.entries(await this.load())) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (/^[1-9]\d{0,9}$/.test(rest)) out.set(Number(rest), { ...entry });
    }
    return out;
  }

  async get(chatId: string, topicId: number): Promise<TopicStateEntry> {
    return { ...((await this.load())[topicStateKey(chatId, topicId)] ?? {}) };
  }

  /**
   * Ändert einen Eintrag in der Schreibkette. fn bekommt eine Kopie und gibt
   * den neuen Eintrag zurück (leer oder null löscht ihn) samt Ergebnis.
   * Der Speicher im Arbeitsspeicher ändert sich erst nach erfolgreichem Schreiben.
   */
  update<T>(chatId: string, topicId: number, fn: (entry: TopicStateEntry) => { entry: TopicStateEntry | null; result: T }): Promise<T> {
    const run = async (): Promise<T> => {
      const map = await this.load();
      const key = topicStateKey(chatId, topicId);
      const { entry, result } = fn({ ...(map[key] ?? {}) });
      const clean = cleanEntry(entry);
      const before = map[key];
      if (JSON.stringify(before ?? null) === JSON.stringify(clean)) return result;
      const next: TopicStateMap = { ...map };
      if (clean) next[key] = clean;
      else delete next[key];
      await atomicWriteFile(this.file, JSON.stringify(next, null, 2));
      this.cache = next;
      return result;
    };
    const pending = this.chain.catch(() => {}).then(run);
    this.chain = pending;
    return pending;
  }

  /** Setzt oder entfernt ein Feld */
  async setFlag(chatId: string, topicId: number, flag: keyof TopicStateEntry, on: boolean): Promise<void> {
    await this.update(chatId, topicId, entry => {
      if (on) entry[flag] = true;
      else delete entry[flag];
      return { entry, result: undefined };
    });
  }

  /**
   * Beansprucht die automatische Titelvergabe: true genau dann, wenn
   * autoTitle gesetzt war und das Topic nicht gelöscht ist. Prüfen und
   * Entfernen sind eine Operation, ein zweiter Aufruf bekommt false.
   */
  claimAutoTitle(chatId: string, topicId: number): Promise<boolean> {
    return this.update(chatId, topicId, entry => {
      if (!entry.autoTitle) return { entry, result: false };
      delete entry.autoTitle;
      return { entry, result: !entry.deleted };
    });
  }
}
