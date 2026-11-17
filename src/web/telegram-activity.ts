/**
 * Letzte Aktivität je Sitzung eines Chats, im Prozess gehalten (Issue #684).
 *
 * Bis dahin lud jede Telegram-Liste der WebUI die jüngsten 1.000 Zeilen der
 * letzten 60 Tage, nur um je Sitzung den jüngsten Zeitpunkt zu finden, und
 * das bei jedem einzelnen Nachschlagen eines Gesprächs: rund 211 MB Egress am
 * Tag. Hier wird der Zeitraum einmal ganz gelesen und danach nur noch
 * fortgeschrieben: Jede weitere Abfrage beginnt kurz hinter der jüngsten
 * bekannten Nachricht und bringt im Ruhezustand eine Zeile zurück.
 *
 * Dazu die Zeitpunkt-Helfer, die Liste und Meldungs-Abholer in
 * bot-telegram.ts teilen.
 */
import type { TopicActivity, TopicActivityChanges } from "../lib/store/types";
import { normalizeIsoTimestamp } from "./telegram";

/** Mikrosekunden bleiben erhalten, sie dienen als Cursor für ?before= */
export function isoOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const precise = normalizeIsoTimestamp(value);
  if (precise) return precise;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** Einheitlich sechs Nachkommastellen, damit .123Z nicht hinter .123001Z sortiert (Date.parse verliert Mikrosekunden) */
export function activitySortKey(value: string): string {
  return value.replace(/\.(\d{3})Z$/, ".$1000Z");
}

/** Einheitlich sechs Nachkommastellen für Vergleiche; null bei ungültigem Zeitpunkt */
export function preciseKey(value: string): string | null {
  const iso = isoOrNull(value);
  return iso ? activitySortKey(iso) : null;
}

/** Millisekunden eines Zeitpunkts aus preciseKey */
export function keyMs(key: string): number {
  return Date.parse(`${key.slice(0, 23)}Z`);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Nach so langer Zeit liest die nächste Liste den ganzen Zeitraum neu. Das
 * hält den Stand ehrlich, falls Zeilen gelöscht wurden oder eine Zeile dem
 * Fortschreiben entging, und kostet höchstens vier volle Abfragen je Chat am Tag.
 */
export const ACTIVITY_FULL_RELOAD_MS = 6 * 60 * 60 * 1000;
/**
 * Rückblick beim Fortschreiben hinter die jüngste bekannte Nachricht, wie
 * beim Meldungs-Abholer: Supabase vergibt created_at beim Beginn der
 * Transaktion, eine etwas früher begonnene Zeile kann nach einer späteren
 * sichtbar werden.
 */
export const ACTIVITY_LOOKBACK_MS = 60_000;

export interface ActivityCacheDeps {
  /** Aktivität eines Chats ab einem Zeitpunkt (einschließlich); wirft bei Fehlern */
  since(chatId: string, since: string): Promise<TopicActivityChanges>;
  /** Zeitraum in Tagen; älteres gilt als unbekannt */
  sinceDays: number;
  /** Aktuelle Zeit in Millisekunden, Standard Date.now */
  now?(): number;
  /** Auffrischen gescheitert, der Stand von vorher gilt weiter; nie Nachrichtentexte oder Zugangsdaten */
  onStale?(error: unknown): void;
}

export interface ActivityCache {
  /**
   * Stand eines Chats auffrischen und liefern, jüngste zuerst. Scheitert die
   * Abfrage, gilt der Stand von vorher (onStale); gibt es noch keinen, wirft sie.
   */
  fresh(chatId: string): Promise<TopicActivity[]>;
  /** Stand ohne Abfrage; leer, solange der Chat noch nie gelesen wurde */
  known(chatId: string): TopicActivity[];
}

interface Entry {
  /** Zeitpunkt, wie ihn die Datenbank lieferte */
  at: string;
  /** Vergleichsschlüssel aus preciseKey */
  key: string;
}

interface ChatState {
  latest: Map<string, Entry>;
  /** Jüngster bekannter Zeitpunkt (preciseKey); null: nichts bekannt */
  newest: string | null;
  /** Beginn der letzten gelungenen vollen Abfrage; null: noch keine */
  loadedAt: number | null;
  /** Laufende volle Abfrage, die sich alle gleichzeitigen Aufrufe teilen */
  loading: Promise<void> | null;
}

export function createActivityCache(deps: ActivityCacheDeps): ActivityCache {
  const now = deps.now ?? Date.now;
  const windowMs = deps.sinceDays * DAY_MS;
  const chats = new Map<string, ChatState>();

  function stateOf(chatId: string): ChatState {
    let state = chats.get(chatId);
    if (!state) {
      state = { latest: new Map(), newest: null, loadedAt: null, loading: null };
      chats.set(chatId, state);
    }
    return state;
  }

  /** Je Sitzung gilt der jüngere Zeitpunkt; gibt den jüngsten aller Einträge zurück */
  function merge(latest: Map<string, Entry>, newest: string | null, activity: TopicActivity[]): string | null {
    for (const { sessionKey, lastActivity } of activity) {
      const key = typeof lastActivity === "string" ? preciseKey(lastActivity) : null;
      if (typeof sessionKey !== "string" || !key) continue;
      const old = latest.get(sessionKey);
      if (!old || key > old.key) latest.set(sessionKey, { at: lastActivity, key });
      if (!newest || key > newest) newest = key;
    }
    return newest;
  }

  /** Ganzer Zeitraum: ersetzt den Stand, damit auch Gelöschtes verschwindet */
  async function loadAll(state: ChatState, chatId: string): Promise<void> {
    const startedAt = now();
    const changes = await deps.since(chatId, new Date(startedAt - windowMs).toISOString());
    const latest = new Map<string, Entry>();
    state.newest = merge(latest, null, changes.activity);
    state.latest = latest;
    state.loadedAt = startedAt;
  }

  function reload(state: ChatState, chatId: string): Promise<void> {
    if (!state.loading) {
      const run: Promise<void> = loadAll(state, chatId).finally(() => {
        if (state.loading === run) state.loading = null;
      });
      state.loading = run;
    }
    return state.loading;
  }

  /**
   * Fortschreiben ab kurz hinter der jüngsten bekannten Nachricht. Kommt
   * nichts zurück, fehlt die bekannte jüngste Zeile (gelöscht); greift das
   * Zeilenlimit, fehlen womöglich Sitzungen. Beides heilt nur der ganze Zeitraum.
   */
  async function advance(state: ChatState, chatId: string, newest: string): Promise<void> {
    const changes = await deps.since(chatId, new Date(keyMs(newest) - ACTIVITY_LOOKBACK_MS).toISOString());
    state.newest = merge(state.latest, state.newest, changes.activity);
    if (changes.truncated || changes.activity.length === 0) await reload(state, chatId);
  }

  function snapshot(state: ChatState): TopicActivity[] {
    const oldest = now() - windowMs;
    return [...state.latest]
      .filter(([, entry]) => keyMs(entry.key) >= oldest)
      .sort(([, a], [, b]) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
      .map(([sessionKey, entry]) => ({ sessionKey, lastActivity: entry.at }));
  }

  async function refresh(state: ChatState, chatId: string): Promise<void> {
    // Ohne bekannte Nachricht fehlt dem Fortschreiben der Anfang: dann der ganze Zeitraum
    const due = state.loadedAt === null || state.newest === null || now() - state.loadedAt >= ACTIVITY_FULL_RELOAD_MS;
    if (!due) return advance(state, chatId, state.newest!);
    // Wer auf eine schon laufende volle Abfrage wartet, schreibt danach selbst fort:
    // sie begann vor diesem Aufruf und kennt eine eben gespeicherte Nachricht vielleicht nicht
    const joined = state.loading !== null;
    await reload(state, chatId);
    if (joined && state.newest) await advance(state, chatId, state.newest);
  }

  return {
    async fresh(chatId) {
      const state = stateOf(chatId);
      try {
        await refresh(state, chatId);
      } catch (error) {
        if (state.loadedAt === null) throw error;
        deps.onStale?.(error);
      }
      return snapshot(state);
    },
    known(chatId) {
      const state = chats.get(chatId);
      return state ? snapshot(state) : [];
    },
  };
}
