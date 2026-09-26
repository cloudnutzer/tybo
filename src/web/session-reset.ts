/**
 * Session eines Gesprächs frisch starten wie /new in Telegram (Issue #61):
 * POST /api/conversations/<id>/reset. Der Verlauf im Nachrichtenspeicher
 * bleibt, nur die Claude-Session des Gesprächs (alle Agenten unter seinem
 * Schlüssel) wird verworfen. Wie in Telegram werden endende Sessions mit
 * genug Inhalt vorher destilliert (Session-Rückblick).
 *
 * Anders als /new in Telegram lehnt der Reset ab, solange im Gespräch eine
 * Antwort läuft (auch eine aus Telegram): sonst schriebe die laufende
 * Antwort ihre Session danach wieder zurück. Die Sperre des Hubs im Server
 * deckt Turns aus Web und Terminal ab, isActive und block die übrigen:
 * Prüfen und Sperren geschehen ohne await dazwischen, und die Sperre hält
 * bis nach dem Reset. Eine Telegram-Ausführung, die währenddessen startet,
 * endet sofort wie nach /stop (wie beim Löschen eines Topics, Issue #29).
 *
 * Importiert nichts aus src/lib; die echten Funktionen reicht
 * bot-session-reset.ts aus src/bot.ts herein.
 */

export type SessionResetResult =
  | { status: "done"; reset: number; sessionMode: boolean }
  | { status: "busy" }
  /** Kein Session-Schlüssel ermittelbar (z. B. Gruppe nicht eingerichtet) */
  | { status: "unavailable" };

/** Setzt die Session eines Gesprächs zurück; wirft bei Lese- oder Schreibfehlern */
export type ConversationSessionReset = (conversationId: string) => Promise<SessionResetResult>;

export interface SessionResetDeps<S> {
  /** Session-Schlüssel wie bei einer Nachricht in diesem Gespräch; null, wenn keiner ermittelbar ist */
  sessionKey(conversationId: string): string | null;
  /** Läuft unter dem Schlüssel gerade eine Ausführung? */
  isActive(sessionKey: string): boolean;
  /** Sperrt neue Ausführungen unter dem Schlüssel bis zur zurückgegebenen Freigabe */
  block(sessionKey: string): () => void;
  sessionsForKey(sessionKey: string): Promise<S[]>;
  shouldDistill(session: S): boolean;
  /** Läuft im Hintergrund weiter, wirft nie in den Reset hinein */
  distill(session: S): Promise<void>;
  /** Alle Sessions des Schlüssels entfernen, Anzahl zurück; wirft bei Fehlern */
  reset(sessionKey: string): Promise<number>;
  sessionModeEnabled(): boolean;
  log?(message: string): void;
}

export const SESSION_RESET_TEXT = {
  notConfigured: "Session-Reset ist nicht eingerichtet",
  busy: "In diesem Gespräch läuft gerade eine Antwort. Erst stoppen, dann die Session neu starten.",
  unavailable: "Für dieses Gespräch lässt sich keine Session ermitteln",
  failed: "Die Session konnte nicht zurückgesetzt werden",
  // Wie die Antworten auf /new in Telegram
  done: "Session zurückgesetzt. Die nächste Nachricht startet mit frischem Kontext, der Verlauf bleibt.",
  none: "Keine aktive Session in diesem Gespräch. Die nächste Nachricht startet ohnehin frisch.",
  off: "Session-Modus ist aus (SESSION_MODE=resume nicht gesetzt). Jede Nachricht startet ohnehin frisch.",
} as const;

/** Hinweistext zum Ergebnis, wie in Telegram */
export function sessionResetNote(result: { reset: number; sessionMode: boolean }): string {
  if (!result.sessionMode) return SESSION_RESET_TEXT.off;
  return result.reset > 0 ? SESSION_RESET_TEXT.done : SESSION_RESET_TEXT.none;
}

export function createConversationSessionReset<S>(deps: SessionResetDeps<S>): ConversationSessionReset {
  const log = deps.log ?? ((m: string) => console.log(`[web] ${m}`));
  return async conversationId => {
    const key = deps.sessionKey(conversationId);
    if (!key) return { status: "unavailable" };
    // Prüfen und Sperren ohne await dazwischen: keine Ausführung schlüpft durch
    if (deps.isActive(key)) return { status: "busy" };
    const release = deps.block(key);
    try {
      for (const session of await deps.sessionsForKey(key)) {
        if (!deps.shouldDistill(session)) continue;
        void deps.distill(session).catch(e => log(`Session-Rückblick fehlgeschlagen (${e instanceof Error ? e.name : typeof e})`));
      }
      const reset = await deps.reset(key);
      return { status: "done", reset, sessionMode: deps.sessionModeEnabled() };
    } finally {
      release();
    }
  };
}
