/**
 * Anwesenheit offener Seiten (Issue #226, Entscheidung 0021): welches
 * Gespräch auf welchem Tab gerade sichtbar offen ist. Grundlage dafür, dass
 * für ein sichtbares Gespräch kein Push rausgeht.
 *
 * Jede Seite meldet POST /api/presence mit einer zufälligen Tab-Kennung, dem
 * offenen Gespräch (null: keines, etwa in den Einstellungen), visible und
 * einer laufenden Nummer seq. Nur im Speicher, nie geschrieben. Ein Eintrag
 * verfällt nach 70 Sekunden ohne Meldung; die Seite meldet alle 30 Sekunden.
 * Eine Meldung mit kleinerer oder gleicher seq als die zuletzt angenommene
 * desselben Tabs ist verspätet und wird verworfen, damit sie einen neueren
 * Gesprächswechsel nicht überschreibt. gone: true (beim Verlassen der Seite)
 * macht den Tab inaktiv: er zählt nicht mehr als sichtbar, seine seq bleibt
 * aber bis zum Verfall stehen, damit eine verspätete ältere Meldung den
 * geschlossenen Tab nicht wiederbelebt. Nach pageshow meldet die Seite mit
 * höherer seq weiter und wird wieder aktiv.
 *
 * Jeder Eintrag hängt an seiner Anmelde-Session: Abmelden entfernt alle Tabs
 * dieser Session, und ein Eintrag zählt nur, solange die Session gültig ist.
 */

import { isConversationId } from "./store";
import { parseTelegramConversationId } from "./telegram";

export const PRESENCE_TTL_MS = 70_000;
/** Obergrenze gleichzeitiger Tabs; darüber fällt der älteste weg */
export const MAX_PRESENCE_TABS = 200;
const TAB_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export interface PresenceReport {
  tab: string;
  conversationId: string | null;
  visible: boolean;
  seq: number;
  /** Seite wird verlassen: Tab entfernen */
  gone?: boolean;
}

interface Entry {
  conversationId: string | null;
  visible: boolean;
  seq: number;
  at: number;
  session: string;
  isAuthorized: () => boolean;
  /** Seite verlassen: nur noch Sperre gegen verspätete Meldungen */
  gone: boolean;
}

/** Prüft den Body von POST /api/presence; null bei ungültigen Angaben */
export function parsePresenceReport(body: string): PresenceReport | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.tab !== "string" || !TAB_PATTERN.test(d.tab)) return null;
  if (typeof d.seq !== "number" || !Number.isSafeInteger(d.seq) || d.seq < 0) return null;
  const conversation = d.conversation ?? null;
  if (conversation !== null && !isConversationId(conversation) && !parseTelegramConversationId(conversation)) return null;
  if (d.visible !== undefined && typeof d.visible !== "boolean") return null;
  if (d.gone !== undefined && typeof d.gone !== "boolean") return null;
  return {
    tab: d.tab,
    conversationId: conversation as string | null,
    visible: d.visible === true,
    seq: d.seq,
    ...(d.gone === true ? { gone: true } : {}),
  };
}

export class PresenceTracker {
  private readonly tabs = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly max: number;

  constructor(options: { now?: () => number; ttlMs?: number; max?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? PRESENCE_TTL_MS;
    this.max = options.max ?? MAX_PRESENCE_TABS;
  }

  /**
   * Meldung eines Tabs. false: verspätet (seq nicht größer) oder von einer
   * anderen Session als der, die den Tab angelegt hat; dann ändert sich nichts.
   */
  report(report: PresenceReport, auth: { session: string; isAuthorized: () => boolean }): boolean {
    this.prune();
    const old = this.tabs.get(report.tab);
    if (old && (old.session !== auth.session || report.seq <= old.seq)) return false;
    // Neu einsortieren: die Map bleibt nach letzter Meldung geordnet, der älteste steht vorn
    this.tabs.delete(report.tab);
    const gone = report.gone === true;
    this.tabs.set(report.tab, {
      conversationId: gone ? null : report.conversationId,
      visible: gone ? false : report.visible,
      seq: report.seq,
      at: this.now(),
      session: auth.session,
      isAuthorized: auth.isAuthorized,
      gone,
    });
    while (this.tabs.size > this.max) this.tabs.delete(this.tabs.keys().next().value!);
    return true;
  }

  /** Mindestens ein Tab meldet dieses Gespräch als sichtbar, frisch und mit gültiger Anmeldung */
  isVisible(conversationId: string): boolean {
    this.prune();
    for (const entry of this.tabs.values()) {
      if (!entry.gone && entry.visible && entry.conversationId === conversationId && entry.isAuthorized()) return true;
    }
    return false;
  }

  /** Abmelden: alle Tabs dieser Session zählen nicht mehr */
  clearSession(session: string): void {
    for (const [tab, entry] of [...this.tabs]) if (entry.session === session) this.tabs.delete(tab);
  }

  /** Anzahl frischer, nicht verlassener Tabs (für Tests) */
  size(): number {
    this.prune();
    let n = 0;
    for (const entry of this.tabs.values()) if (!entry.gone) n++;
    return n;
  }

  private prune(): void {
    const limit = this.now() - this.ttlMs;
    for (const [tab, entry] of [...this.tabs]) if (entry.at <= limit) this.tabs.delete(tab);
  }
}
