/**
 * Telefongespräch im Verlauf (Issue #260). Jeder Turn des Telefonhörers
 * landet sofort im gewählten Gespräch, nicht erst nach dem Auflegen:
 *
 * - die Äußerung als Nutzernachricht (Markierung call, Metazeile „am Telefon
 *   gesagt“), die gesprochene Antwort als Nachricht des Agenten (Metazeile
 *   „Telefonhörer · <Modell>“). Gespeichert wird nur Gesprochenes, bei einer
 *   Unterbrechung mit dem Zusatz „(unterbrochen)“. Ohne gesprochene Antwort
 *   (Fehler, sofort unterbrochen) steht nur die Äußerung da.
 * - beim Auflegen eine Meldung „Telefongespräch, 4 Min.“ (Absender
 *   Telefonhörer, Quelle telefonhoerer: kein Push).
 * - Ablage wie bei Web-Turns: reine Web-Gespräche im Gesprächsspeicher
 *   (store.ts) und zusätzlich im gemeinsamen Gedächtnis unter web:<id>
 *   (memory.save, saveMessage wie bei Web-Turns), damit history_search und
 *   die semantische Suche sie finden. Telegram-Gespräche nur im Gedächtnis
 *   (memory.save mit Chat-ID und Topic); offene Seiten bekommen sie über den
 *   Live-Feed (bot-telegram.ts). Nichts geht nach Telegram, kein Push.
 * - Läuft im Gespräch gerade ein Turn (Denkauftrag), wartet die Ablage auf
 *   sein Ende (Sperre des ChatHub); die Nachrichten tragen trotzdem die
 *   Uhrzeit, zu der sie gesagt wurden. Die Reihenfolge je Gespräch bleibt.
 *
 * Reine Web-Seite: nichts aus src/lib (der Anschluss ans Gedächtnis kommt
 * aus bot.ts über CallMemoryPort, ./bot-call.ts).
 */

import { CALL_NOTICE_SOURCE } from "./call-protocol";
import type { StoredMessage, NewMessage } from "./store";

/** Zusatz einer unterbrochenen Antwort im Verlauf */
export const CALL_INTERRUPTED_SUFFIX = "(unterbrochen)";

/** Ein abgeschlossener Turn des Telefonhörers für den Verlauf */
export interface CallHistoryTurn {
  conversationId: string;
  agent: string;
  model: string;
  userText: string;
  /** Zeitpunkt der Äußerung (ISO) */
  userAt: string;
  /** Nur bestätigt Gesprochenes */
  spokenText: string;
  interrupted: boolean;
  /** Zeitpunkt der Antwort (ISO) */
  replyAt: string;
}

export interface CallHistoryPort {
  turn(turn: CallHistoryTurn): void;
  /** Gespräch aufgelegt; seconds ist die Dauer ab „bereit“ */
  ended(o: { conversationId: string; seconds: number; at: string }): void;
  /** Wartet, bis alles abgelegt ist (Tests, geordnetes Beenden) */
  idle(): Promise<void>;
}

/** Eintrag im gemeinsamen Gedächtnis (Bot-Seite: saveMessage) */
export interface CallMemoryEntry {
  role: "user" | "assistant";
  text: string;
  at: string;
  agent: string;
  model?: string;
}

/**
 * Anschluss ans gemeinsame Gedächtnis (bot.ts: createCallMemory aus
 * ./bot-call.ts). save legt eine Äußerung oder Antwort als normale
 * Nachricht ab (mit Embedding, nicht display_only), notice eine Meldung als
 * Nur-Anzeige-Eintrag (nur für Telegram-Gespräche). false: nicht abgelegt.
 */
export interface CallMemoryPort {
  save(conversationId: string, entry: CallMemoryEntry): Promise<boolean>;
  notice(conversationId: string, o: { text: string; at: string }): Promise<boolean>;
}

export interface CallHistoryDeps {
  /** Reines Web-Gespräch (Gesprächsspeicher) statt Telegram-Gespräch */
  isWeb(conversationId: string): boolean;
  /** Erfüllt, sobald im Gespräch kein Turn mehr läuft (ChatHub-Sperre) */
  whenIdle(conversationId: string): Promise<void>;
  /** Web-Gespräch: Nachricht im Gesprächsspeicher ablegen */
  append(conversationId: string, message: NewMessage): Promise<StoredMessage>;
  /** Web-Gespräch: abgelegte Nachricht an die offenen Seiten */
  publish(conversationId: string, message: StoredMessage): void;
  memory?: CallMemoryPort;
  /** Nie Inhalte übergeben */
  log(line: string): void;
}

/** „Telefongespräch, 4 Min.“; unter einer Minute in Sekunden */
export function callEndedText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `Telefongespräch, ${s} Sek.`;
  return `Telefongespräch, ${Math.round(s / 60)} Min.`;
}

/** Text der Antwort im Verlauf: nur Gesprochenes, unterbrochen mit Zusatz; leer heißt keine Antwort */
export function callReplyText(spokenText: string, interrupted: boolean): string {
  const text = spokenText.trim();
  if (!text) return "";
  return interrupted ? `${text} ${CALL_INTERRUPTED_SUFFIX}` : text;
}

/** Antwort nie vor der Äußerung, auch wenn die Uhren gleich stehen */
function after(at: string, before: string): string {
  const a = Date.parse(at);
  const b = Date.parse(before);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) return at;
  return new Date(b + 1).toISOString();
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

export function createCallHistory(deps: CallHistoryDeps): CallHistoryPort {
  /** Je Gespräch eine Kette: Reihenfolge bleibt, auch wenn ein Denkauftrag die Ablage aufhält */
  const chains = new Map<string, Promise<void>>();
  const all = new Set<Promise<void>>();

  function enqueue(conversationId: string, work: () => Promise<void>): void {
    const previous = chains.get(conversationId) ?? Promise.resolve();
    const next = previous
      .then(() => deps.whenIdle(conversationId))
      .then(work)
      .catch(e => deps.log(`Telefonhörer: Verlauf in ${conversationId} nicht abgelegt (${errorName(e)})`));
    chains.set(conversationId, next);
    all.add(next);
    void next.finally(() => {
      all.delete(next);
      if (chains.get(conversationId) === next) chains.delete(conversationId);
    });
  }

  async function remember(conversationId: string, entry: CallMemoryEntry): Promise<void> {
    if (!deps.memory) return;
    try {
      const ok = await deps.memory.save(conversationId, entry);
      if (!ok) deps.log(`Telefonhörer: ${entry.role === "user" ? "Äußerung" : "Antwort"} aus ${conversationId} nicht im Gedächtnis`);
    } catch (e) {
      deps.log(`Telefonhörer: Gedächtnis für ${conversationId} fehlgeschlagen (${errorName(e)})`);
    }
  }

  async function webMessage(conversationId: string, message: NewMessage): Promise<void> {
    const stored = await deps.append(conversationId, message);
    deps.publish(conversationId, stored);
  }

  return {
    turn(t) {
      const userText = t.userText.trim();
      if (!userText) return;
      const reply = callReplyText(t.spokenText, t.interrupted);
      const replyAt = after(t.replyAt, t.userAt);
      const web = deps.isWeb(t.conversationId);
      enqueue(t.conversationId, async () => {
        if (web) await webMessage(t.conversationId, { role: "user", text: userText, call: true, at: t.userAt });
        await remember(t.conversationId, { role: "user", text: userText, at: t.userAt, agent: t.agent });
        if (!reply) return;
        if (web) {
          await webMessage(t.conversationId, { role: "assistant", text: reply, call: true, at: replyAt, agent: t.agent, model: t.model });
        }
        await remember(t.conversationId, { role: "assistant", text: reply, at: replyAt, agent: t.agent, model: t.model });
      });
    },

    ended({ conversationId, seconds, at }) {
      const text = callEndedText(seconds);
      enqueue(conversationId, async () => {
        if (deps.isWeb(conversationId)) {
          await webMessage(conversationId, { role: "assistant", text, kind: "notice", source: CALL_NOTICE_SOURCE, at });
          return;
        }
        if (!deps.memory) return;
        const ok = await deps.memory.notice(conversationId, { text, at });
        if (!ok) deps.log(`Telefonhörer: Meldung zum Gespräch in ${conversationId} nicht abgelegt`);
      });
    },

    async idle() {
      while (all.size) await Promise.allSettled([...all]);
    },
  };
}
