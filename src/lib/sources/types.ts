/**
 * Quellen für Briefing und Board (Issue #354): jede Quelle liefert einen
 * Abschnitt mit Einträgen, kein fertiges Markdown. Wie ein Abschnitt
 * aussieht (Telegram, Browser), entscheidet der Aufrufer.
 */

export type Env = Record<string, string | undefined>;

/** Ein Eintrag eines Abschnitts */
export interface SectionItem {
  /** Der Inhalt in einer Zeile, ohne Aufzählungszeichen */
  text: string;
  /** Fälliger Tag als YYYY-MM-DD in der Zeitzone des Nutzers */
  due?: string;
  /** Der Tag liegt vor heute */
  overdue?: boolean;
  /** Beleg oder Ziel des Eintrags (Adresse) */
  link?: string;
  /** Beginn eines Termins als ISO-Zeitpunkt */
  start?: string;
  /** Ende eines Termins als ISO-Zeitpunkt */
  end?: string;
  /** Termin ohne Uhrzeit, gilt den ganzen Tag */
  allDay?: boolean;
}

/** Ergebnis einer Quelle */
export interface Section {
  /** Leer heißt: die Quelle lief, hat aber nichts zu melden */
  items: SectionItem[];
  /** Hinweis zum Abschnitt, etwa warum Einträge fehlen */
  note?: string;
  /** Gesamtzahl, wenn items nur einen Ausschnitt zeigt (etwa ungelesene Mails) */
  total?: number;
}

/** Was eine Quelle beim Sammeln bekommt */
export interface SourceContext {
  env: Env;
  /** Zeitpunkt des Laufs; „heute" ergibt sich daraus in timeZone */
  now: Date;
  /** USER_TIMEZONE, sonst UTC */
  timeZone: string;
  /** Wird beim Zeitlimit ausgelöst; an HTTP-Aufrufe weiterreichen */
  signal: AbortSignal;
  /** fetch für HTTP-Aufrufe (in Tests eine Attrappe) */
  fetch: typeof fetch;
}

export interface Source {
  /** Feste Kennung, z.B. "goals" */
  id: string;
  /** Anzeigename des Abschnitts */
  label: string;
  /** Sind Zugangsdaten und Einstellungen da? Ohne Netz, ohne Nebenwirkung */
  ready(env: Env): boolean;
  /** Sammelt den Abschnitt; wirft bei Fehlern */
  collect(ctx: SourceContext): Promise<Section>;
  /** Eigenes Zeitlimit in Millisekunden, sonst das des Laufs */
  timeoutMs?: number;
}

/** Ausgang einer Quelle in einem Lauf */
export type SourceOutcome =
  | { source: Source; status: "ok"; section: Section; ms: number }
  | { source: Source; status: "skipped" }
  | { source: Source; status: "failed"; error: string; ms: number }
  | { source: Source; status: "timeout"; ms: number };
