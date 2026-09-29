/**
 * Meldungen für reine Web-Gespräche (Issue #227): `bun run notify`, Jobs und
 * pipeline-say halten Meldungen mit TYBO_CONVERSATION_ID im
 * Nachrichtenspeicher unter der Chat-ID web:<uuid> fest (src/lib/outbox.ts).
 * Die Web-Gespräche selbst liegen aber im Gesprächsspeicher (store.ts). Der
 * Bot-Prozess übernimmt solche Meldungen in das Web-Gespräch und bleibt so der
 * einzige Schreiber dort.
 *
 * - Zwei Wege wie beim Live-Feed der Telegram-Gespräche: der Hook für
 *   Einträge dieses Prozesses (sofort) und eine Abfrage alle 15 Sekunden für
 *   Einträge anderer Prozesse.
 * - Nachholen: Die Abfrage merkt sich den jüngsten übernommenen Zeitpunkt in
 *   einer Datei (cursor) und liest nach einem Neustart ab dort (mit Rückblick),
 *   ohne Datei alles; Meldungen aus einer Ausfallzeit gehen also nicht verloren.
 * - Entdopplung: Jede Meldung trägt ihre msgId als Nachrichten-ID ins
 *   Gespräch; post übernimmt eine ID höchstens einmal, auch über Neustarts.
 * - Übernommen werden nur Nur-Anzeige-Einträge (metadata.display_only) aus
 *   Web-Gesprächen, die es gibt; Text, Absender, Datei und Rückfrage-ID
 *   bleiben erhalten, alles andere fällt weg.
 *
 * Reine Web-Seite: nichts aus src/lib (Tests und web:dev laden die Datei auch).
 */

import { isDisplayOnlyMetadata, pickNotice, type NoticeFile } from "./notice";
import { isChoiceId, isConversationId } from "./store";

/** Zeile einer Meldung aus dem Nachrichtenspeicher (wie DisplayOnlyRow in src/lib/supabase.ts) */
export interface WebNoticeRow {
  id: string | number;
  created_at: string;
  chat_id: string;
  role: string;
  content: string;
  metadata: Record<string, unknown> | null;
}

/** Gespeicherte Nachricht dieses Prozesses (wie SavedMessageEvent in src/lib/convex.ts) */
export interface WebNoticeEvent {
  chatId: string;
  role: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** Was in das Web-Gespräch übernommen wird */
export interface WebNotice {
  /** Nachrichten-ID im Gespräch, zugleich Schlüssel der Entdopplung */
  id: string;
  text: string;
  source?: string;
  file?: NoticeFile;
  choiceId?: string;
}

export interface WebNoticePageOptions {
  since?: string;
  after?: { createdAt: string; id: string };
  limit: number;
}

export interface WebNoticeImportDeps {
  /** Die reinen Web-Gespräche, die es gerade gibt (Gesprächs-IDs) */
  conversationIds(): Promise<string[]>;
  /** Meldungen dieser Chats, älteste zuerst (getDisplayOnlyPage); wirft bei Fehlern */
  page(chatIds: string[], options: WebNoticePageOptions): Promise<WebNoticeRow[]>;
  /** Hook auf gespeicherte Nachrichten dieses Prozesses (onMessageSaved); gibt die Abmeldung zurück */
  onMessageSaved?(listener: (event: WebNoticeEvent) => void | Promise<void>): () => void;
  /** Übernimmt eine Meldung höchstens einmal (Gespräch unbekannt: nichts); wirft bei Schreibfehlern */
  post(conversationId: string, notice: WebNotice): Promise<void>;
  /** Jüngster übernommener Zeitpunkt, über Neustarts gemerkt */
  cursor: { read(): Promise<string | null>; write(at: string): Promise<void> };
  intervalMs?: number;
  every?(ms: number, fn: () => Promise<void>): () => void;
  /** Nie Meldungstexte übergeben */
  log?(message: string): void;
}

export const WEB_NOTICE_POLL_MS = 15_000;
/** Rückblick wie DISPLAY_ONLY_LOOKBACK_MS in bot-telegram.ts */
export const WEB_NOTICE_LOOKBACK_MS = 60_000;
export const WEB_NOTICE_PAGE_SIZE = 100;
const MAX_PAGES = 10;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WEB_CHAT_PATTERN = /^web:(.+)$/;

/** Gesprächs-ID aus der Chat-ID web:<uuid>; null bei allem anderen */
export function webConversationOfChat(chatId: unknown): string | null {
  if (typeof chatId !== "string") return null;
  const id = WEB_CHAT_PATTERN.exec(chatId)?.[1];
  return id && isConversationId(id) ? id : null;
}

/** Übernahme einer Meldung: nur display_only, gültige msgId (sonst Zeilen-ID), geprüfte Felder */
export function toWebNotice(row: Pick<WebNoticeRow, "id" | "role" | "content" | "metadata">): WebNotice | null {
  if (row.role !== "assistant" || typeof row.content !== "string") return null;
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : null;
  if (!isDisplayOnlyMetadata(metadata)) return null;
  const msgId = metadata!.msgId;
  const rowId = String(row.id ?? "");
  const id = typeof msgId === "string" && UUID_PATTERN.test(msgId) ? msgId : /^\d{1,20}$/.test(rowId) ? `db-${rowId}` : null;
  if (!id) return null;
  const info = pickNotice(metadata)!;
  const notice: WebNotice = { id, text: row.content };
  if (info.source) notice.source = info.source;
  if (info.file) notice.file = info.file;
  if (isChoiceId(metadata!.choiceId)) notice.choiceId = metadata!.choiceId as string;
  return notice;
}

function isoMs(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

/** Startet Hook und Abfrage; gibt das Anhalten zurück. Wirft nicht. */
export function startWebNoticeImport(deps: WebNoticeImportDeps): () => void {
  const log = deps.log ?? ((m: string) => console.log(`[web] ${m}`));
  let stopped = false;
  let running: Promise<void> | null = null;
  let failing = false;
  let cursor: string | null | undefined;
  let resumeAfter: { createdAt: string; id: string } | null = null;

  async function pass(): Promise<void> {
    const ids = (await deps.conversationIds()).filter(isConversationId);
    if (ids.length === 0) return;
    if (cursor === undefined) cursor = await deps.cursor.read();
    const chatIds = ids.map(id => `web:${id}`);
    const since = cursor && Number.isFinite(isoMs(cursor)) ? new Date(isoMs(cursor) - WEB_NOTICE_LOOKBACK_MS).toISOString() : undefined;
    let after = resumeAfter;
    resumeAfter = null;
    let newest = cursor;
    for (let pageNo = 0; pageNo < MAX_PAGES && !stopped; pageNo++) {
      const rows = await deps.page(chatIds, { ...(since ? { since } : {}), ...(after ? { after } : {}), limit: WEB_NOTICE_PAGE_SIZE });
      for (const row of rows) {
        if (typeof row?.created_at !== "string" || !Number.isFinite(isoMs(row.created_at))) continue;
        const conversationId = webConversationOfChat(row.chat_id);
        const notice = conversationId ? toWebNotice(row) : null;
        // Schreibfehler werfen: der Zeitpunkt bleibt stehen, die nächste Abfrage versucht es erneut
        if (conversationId && notice) await deps.post(conversationId, notice);
        after = { createdAt: row.created_at, id: String(row.id) };
        if (!newest || isoMs(row.created_at) > isoMs(newest)) newest = row.created_at;
      }
      if (rows.length < WEB_NOTICE_PAGE_SIZE) {
        after = null;
        break;
      }
      if (pageNo === MAX_PAGES - 1) resumeAfter = after;
    }
    if (newest && newest !== cursor) {
      await deps.cursor.write(newest);
      cursor = newest;
    }
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = pass()
      .then(
        () => {
          if (failing) log("Meldungen für Web-Gespräche werden wieder übernommen");
          failing = false;
        },
        e => {
          if (!failing) log(`Meldungen für Web-Gespräche nicht übernehmbar (${e instanceof Error ? e.name : typeof e})`);
          failing = true;
        }
      )
      .finally(() => {
        running = null;
      });
    return running;
  }

  let stopHook: (() => void) | null = null;
  try {
    stopHook =
      deps.onMessageSaved?.(event => {
        const conversationId = webConversationOfChat(event.chatId);
        if (!conversationId) return;
        const notice = toWebNotice({ id: "", role: event.role, content: event.content, metadata: event.metadata });
        if (!notice) return;
        return deps.post(conversationId, notice).catch(e => {
          // Die Abfrage holt sie nach
          log(`Meldung für Web-Gespräch nicht sofort übernommen (${e instanceof Error ? e.name : typeof e})`);
        });
      }) ?? null;
  } catch (e) {
    log(`Meldungen dieses Prozesses für Web-Gespräche nicht verfügbar (${e instanceof Error ? e.name : typeof e})`);
  }

  const every =
    deps.every ??
    ((ms: number, fn: () => Promise<void>) => {
      const timer = setInterval(() => void fn(), ms);
      (timer as { unref?: () => void }).unref?.();
      return () => clearInterval(timer);
    });
  const stopTimer = every(deps.intervalMs ?? WEB_NOTICE_POLL_MS, tick);
  // Sofort nachholen, was während einer Ausfallzeit kam
  void tick();
  return () => {
    stopped = true;
    stopTimer();
    stopHook?.();
  };
}
