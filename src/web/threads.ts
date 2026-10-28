/**
 * Fäden-API der WebUI (Issue #293, Entscheidung 0025): GET /api/threads für
 * den Bereich „Offene Fäden", POST /api/threads/<id>/close zum Schließen.
 *
 * - GET liefert die offenen Fäden, neueste zuerst; mit ?alle=1 dazu die in
 *   den letzten 7 Tagen geschlossenen. Sind die Fäden ausgeschaltet (Einstellung
 *   bzw. THREADS=off), ist enabled false und beide Listen sind leer; die
 *   Seitenleiste zeigt dann keinen Eintrag. pending ist true, solange nach
 *   einer Antwort noch Auflösen oder Erkennung läuft oder wartet; die Seite
 *   fragt dann weiter nach.
 * - POST nimmt {"reason": "erledigt" | "nicht mehr wichtig"} (sonst 400) und
 *   schließt genau einmal: die Quelle prüft unter der Sperre der Ablage, ob der
 *   Faden noch offen ist. Unbekannt oder schon geschlossen ergibt 404. Offene
 *   Rückfragen der Art thread zu diesem Faden laufen über den Zuhörer der
 *   Ablage ab (installThreadChoiceExpiry in src/bot.ts), wie beim Knopf.
 *
 * Diese Datei importiert nichts aus src/lib; src/bot.ts übergibt die echte
 * Quelle als ThreadsPort (src/web/bot-threads.ts), web:dev und Demo eine
 * Attrappe (createDemoThreads in ./demo). Die Texte (Alter, Frist, nächste
 * Erinnerung, Grund) bildet die Quelle mit denselben Funktionen wie /faeden.
 * Ins Log kommen nur Faden-IDs.
 */

import type { ApiResult } from "./settings";

/** Art des Gesprächs eines Fadens */
export type ThreadConversationType = "dm" | "general" | "topic" | "web";

/** Ein Faden, wie die Quelle ihn liefert */
export interface ThreadRecord {
  id: string;
  nr: number;
  state: "open" | "closed";
  topic: string;
  context: string;
  question: string;
  conversation: {
    type: ThreadConversationType;
    /** Gespräch der WebUI ("dm", "topic-<nr>" oder Web-UUID); null, wenn die WebUI es nicht zeigt */
    id: string | null;
    /** Ort wie in /faeden (Topic-Name, General, Direktchat, Web-Gespräch) */
    place: string;
  };
  createdAt: number;
  /** "seit 3 Tagen" */
  ageText: string;
  /** YYYY-MM-DD */
  deadline?: string;
  /** TT.MM.JJJJ */
  deadlineText?: string;
  nextReminderAt?: number;
  /** "Erinnerung am 19.10.2026" usw. wie /faeden */
  reminderText?: string;
  reminders: number;
  closedAt?: number;
  /** Grund für die Anzeige ("erledigt", "Obergrenze erreicht" …) */
  closedReason?: string;
}

/** Gründe beim Schließen aus der WebUI, wie die Knöpfe der Erinnerung */
export const THREAD_CLOSE_REASONS = { erledigt: "done", "nicht mehr wichtig": "drop" } as const;
export type ThreadCloseReason = (typeof THREAD_CLOSE_REASONS)[keyof typeof THREAD_CLOSE_REASONS];

export interface ThreadsPort {
  /** Fäden an? (Einstellung vor THREADS in .env), bei jeder Anfrage frisch */
  enabled(): boolean;
  /** Nacharbeit nach Antworten (Auflösen, Erkennung) läuft oder wartet noch; fehlt: false */
  pending?(): boolean;
  /** Offene Fäden; mit includeClosed dazu die der letzten 7 Tage. Wirft, wenn die Ablage nicht lesbar ist */
  list(includeClosed: boolean): Promise<{ open: ThreadRecord[]; closed: ThreadRecord[] }>;
  /** Schließt einen offenen Faden unter der Sperre der Ablage; "not-open" bei unbekannt oder geschlossen */
  close(id: string, reason: ThreadCloseReason): Promise<"closed" | "not-open">;
}

export const THREADS_API_TEXT = {
  notConfigured: "Offene Fäden sind hier nicht eingerichtet.",
  off: "Offene Fäden sind ausgeschaltet.",
  failed: "Fäden konnten nicht gelesen werden.",
  invalidReason: "Grund muss „erledigt“ oder „nicht mehr wichtig“ sein.",
  unknown: "Kein offener Faden mit dieser Kennung.",
  closeFailed: "Der Faden konnte nicht geschlossen werden.",
} as const;

/** Faden-IDs aus der Ablage (ID_RE in src/lib/threads/store.ts) */
export const THREAD_ID_PATTERN = /^[A-Za-z0-9]{1,12}$/;

export interface ThreadApiItem {
  id: string;
  nr: number;
  state: "open" | "closed";
  topic: string;
  context: string;
  question: string;
  conversation: { type: ThreadConversationType; id: string | null; name: string };
  createdAt: string;
  age: string;
  deadline: string | null;
  deadlineText: string | null;
  nextReminderAt: string | null;
  reminder: string | null;
  reminders: number;
  closedAt: string | null;
  closedReason: string | null;
}

export interface ThreadsApi {
  get(includeClosed: boolean): Promise<ApiResult>;
  close(id: string, body: string): Promise<ApiResult>;
}

function iso(ts: number | undefined): string | null {
  return typeof ts === "number" && Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

export function createThreadsApi(
  port: ThreadsPort,
  log: (message: string) => void,
  /** Anzeigename eines Gesprächs der WebUI; leer, wenn unbekannt */
  conversationTitle: (id: string) => Promise<string> = async () => ""
): ThreadsApi {
  async function toItem(t: ThreadRecord, titles: Map<string, Promise<string>>): Promise<ThreadApiItem> {
    let name = t.conversation.place;
    const id = t.conversation.id;
    if (id) {
      if (!titles.has(id)) titles.set(id, conversationTitle(id).catch(() => ""));
      const title = (await titles.get(id))?.trim();
      if (title) name = title;
    }
    return {
      id: t.id,
      nr: t.nr,
      state: t.state,
      topic: t.topic,
      context: t.context,
      question: t.question,
      conversation: { type: t.conversation.type, id, name },
      createdAt: iso(t.createdAt)!,
      age: t.ageText,
      deadline: t.deadline ?? null,
      deadlineText: t.deadlineText ?? null,
      nextReminderAt: t.state === "open" ? iso(t.nextReminderAt) : null,
      reminder: t.state === "open" ? t.reminderText ?? null : null,
      reminders: t.reminders,
      closedAt: t.state === "closed" ? iso(t.closedAt) : null,
      closedReason: t.state === "closed" ? t.closedReason ?? null : null,
    };
  }

  return {
    async get(includeClosed) {
      if (!port.enabled()) return { status: 200, body: { enabled: false, count: 0, open: [], closed: [] } };
      // Vor dem Lesen: ist danach keine Nacharbeit mehr offen, enthält die Liste ihr Ergebnis
      let pending = false;
      try {
        pending = port.pending?.() === true;
      } catch {
        pending = false;
      }
      let lists: { open: ThreadRecord[]; closed: ThreadRecord[] };
      try {
        lists = await port.list(includeClosed);
      } catch (e) {
        log(`Fäden nicht lesbar (${e instanceof Error ? e.name : typeof e})`);
        return { status: 500, body: { error: THREADS_API_TEXT.failed } };
      }
      const titles = new Map<string, Promise<string>>();
      const open = await Promise.all([...lists.open].sort((a, b) => b.createdAt - a.createdAt || b.nr - a.nr).map(t => toItem(t, titles)));
      const closed = includeClosed
        ? await Promise.all([...lists.closed].sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).map(t => toItem(t, titles)))
        : [];
      return { status: 200, body: { enabled: true, count: open.length, pending, open, closed } };
    },

    async close(id, body) {
      let reason: unknown;
      try {
        reason = JSON.parse(body || "null")?.reason;
      } catch {
        return { status: 400, body: { error: THREADS_API_TEXT.invalidReason } };
      }
      if (typeof reason !== "string" || !Object.prototype.hasOwnProperty.call(THREAD_CLOSE_REASONS, reason)) {
        return { status: 400, body: { error: THREADS_API_TEXT.invalidReason } };
      }
      if (!port.enabled()) return { status: 409, body: { error: THREADS_API_TEXT.off } };
      if (!THREAD_ID_PATTERN.test(id)) return { status: 404, body: { error: THREADS_API_TEXT.unknown } };
      let outcome: "closed" | "not-open";
      try {
        outcome = await port.close(id, THREAD_CLOSE_REASONS[reason as keyof typeof THREAD_CLOSE_REASONS]);
      } catch (e) {
        log(`Faden ${id} nicht geschlossen (${e instanceof Error ? e.name : typeof e})`);
        return { status: 500, body: { error: THREADS_API_TEXT.closeFailed } };
      }
      if (outcome !== "closed") return { status: 404, body: { error: THREADS_API_TEXT.unknown } };
      log(`Faden ${id} in der WebUI geschlossen (${reason})`);
      return { status: 200, body: { closed: true, id } };
    },
  };
}
