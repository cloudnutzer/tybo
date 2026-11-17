/**
 * Log-Zeilen, die der Nachtcheck zählt (Issue #568), und ihre Muster an
 * einer Stelle. Der Bot schreibt sie mit den Funktionen hier, die Zeile
 * „Fehler im Log (24h)“ in src/health-check.ts zählt sie mit LOG_PATTERNS.
 * Ändert jemand den Text, ändert er beides; vorher passten drei von fünf
 * Mustern auf keine Zeile mehr, die der Bot schrieb.
 *
 * Ohne Abhängigkeiten, damit der Nachtcheck nichts vom Bot-Code lädt.
 */

/** Zusatz der Zeile, wenn ein Motor ins Zeitlimit lief: dann springt kein Ersatzmodell ein (chat-turn.ts) */
export const TIMEOUT_NO_FALLBACK = "kein Fallback";

/**
 * Zeile, wenn der Hauptmotor ins Zeitlimit lief, etwa
 * „Claude streaming timeout/idle, kein Fallback (steps=8, sessionId=ja)“
 */
export function engineTimeoutLogLine(label: string, kind: string | undefined, detail: string): string {
  return `${label} timeout${kind ? `/${kind}` : ""}, ${TIMEOUT_NO_FALLBACK} (${detail})`;
}

/** Anfang der Zeile, mit der die Ersatzkette eine Stufe versucht (fallback/chain.ts) */
export const FALLBACK_TRY = "Fallback: versuche";

/** „🔄 Fallback: versuche OpenRouter (minimax/minimax-m2.7)“ */
export function fallbackTryLogLine(stage: string, model: string): string {
  return `🔄 ${FALLBACK_TRY} ${stage} (${model})`;
}

/** Anfang aller Zeilen, wenn eine Nachricht ohne Embedding gespeichert wurde (store/supabase/edge-warning.ts) */
export const EDGE_FALLBACK_PREFIX = "[saveMessage] Edge Function";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Muster mit Beschriftung für den Bericht. label bekommt den Treffer, damit
 * Zeitlimit-Art und Stufe der Ersatzkette im Bericht stehen
 * („2x Ersatzmodell OpenRouter“). Eine Zeile zählt höchstens einmal.
 */
export const LOG_PATTERNS: readonly { pattern: RegExp; label(match: RegExpExecArray): string }[] = [
  {
    pattern: new RegExp(` timeout(?:/([a-z-]+))?, ${escape(TIMEOUT_NO_FALLBACK)} \\(`),
    label: m => (m[1] ? `Zeitlimit (${m[1]})` : "Zeitlimit"),
  },
  {
    pattern: new RegExp(`${escape(FALLBACK_TRY)} (.+?) \\(`),
    label: m => `Ersatzmodell ${m[1].slice(0, 40)}`,
  },
  {
    pattern: new RegExp(escape(EDGE_FALLBACK_PREFIX)),
    label: () => "saveMessage ohne Embedding",
  },
];

/** Treffer je Beschriftung in einem Log-Ausschnitt */
export function countLogIssues(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    for (const { pattern, label } of LOG_PATTERNS) {
      const m = pattern.exec(line);
      if (!m) continue;
      const key = label(m);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      break;
    }
  }
  return counts;
}
