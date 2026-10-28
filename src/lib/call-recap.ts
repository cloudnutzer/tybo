/**
 * Telefongespräch als Kontext für den nächsten getippten Turn (Issue #260).
 *
 * Der Telefonhörer denkt mit dem eigenen Gehirn (Entscheidung 0024), nicht
 * mit dem Motor des Gesprächs. Mit SESSION_MODE=resume bekäme der nächste
 * getippte Turn nur einen schlanken Prompt und wüsste nichts vom Gespräch.
 * Deshalb merkt sich der Anschluss (src/web/bot-call.ts) je Gespräch, was
 * gesagt wurde, und der nächste Turn des Chat-Kerns (src/lib/chat-turn.ts)
 * nimmt es genau einmal als Turn-Hinweis mit: bei jedem Motor, voll wie
 * fortgesetzt. Denkaufträge aus dem Gespräch nehmen es nicht (skipCallRecap).
 *
 * - Schlüssel ist der Session-Schlüssel des Gesprächs (sessionKeyFor).
 * - Der ganze Hinweis mit Überschrift und Erläuterung hat höchstens
 *   CALL_RECAP_MAX_CHARS Zeichen; zu viel: die ältesten Zeilen fallen weg,
 *   die jüngsten bleiben.
 * - Nur im Speicher des Bot-Prozesses: nach einem Neustart ist der Hinweis
 *   weg, die Äußerungen stehen aber im Verlauf.
 */

export const CALL_RECAP_MAX_CHARS = 4_000;
export const CALL_RECAP_HEADING = "Vorhin am Telefon:";
const CALL_RECAP_NOTE =
  "Das hat der Nutzer vorhin in diesem Gespräch mit dem Telefonhörer gesprochen (erkannter Text, kann Verhörer enthalten). Nutze es als Kontext, wiederhole es nicht.";
/** Zeilen je Gespräch höchstens (Schutz, falls nie getippt wird) */
const MAX_LINES = 400;

const recaps = new Map<string, string[]>();

/** Ein Turn des Telefonhörers: Äußerung und gesprochene Antwort */
export function addCallRecap(key: string, turn: { userText: string; replyText: string; agentLabel: string }): void {
  const lines = recaps.get(key) ?? [];
  const user = turn.userText.replace(/\s+/g, " ").trim();
  const reply = turn.replyText.replace(/\s+/g, " ").trim();
  if (user) lines.push(`Du: ${user}`);
  if (reply) lines.push(`${turn.agentLabel}: ${reply}`);
  if (!lines.length) return;
  recaps.set(key, lines.slice(-MAX_LINES));
}

/**
 * Hinweis für den nächsten Turn, danach vergessen. undefined, wenn es keinen
 * gibt. Die jüngsten Zeilen bleiben, solange sie zusammen in die Grenze passen;
 * eine einzelne zu lange jüngste Zeile wird von vorn gekürzt.
 */
export function takeCallRecap(key: string): string | undefined {
  const lines = recaps.get(key);
  recaps.delete(key);
  if (!lines?.length) return undefined;
  return formatCallRecap(lines);
}

const CALL_RECAP_DROPPED = "(Ältere Äußerungen weggelassen)\n";

/** Der ganze Hinweis (Überschrift, Kürzungshinweis, Zeilen, Erläuterung) hat höchstens max Zeichen */
export function formatCallRecap(lines: string[], max = CALL_RECAP_MAX_CHARS): string {
  const head = `${CALL_RECAP_HEADING}\n`;
  const tail = `\n\n${CALL_RECAP_NOTE}`;
  const whole = `${head}${lines.join("\n")}${tail}`;
  if (whole.length <= max) return whole;
  // Gekürzt: Platz für die Zeilen ist, was Überschrift, Kürzungshinweis und Erläuterung übrig lassen
  const budget = Math.max(0, max - head.length - CALL_RECAP_DROPPED.length - tail.length);
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const cost = line.length + (kept.length ? 1 : 0);
    if (used + cost > budget) {
      // Eine einzige zu lange jüngste Zeile: von vorn gekürzt, das Ende bleibt
      if (!kept.length && budget > 1) kept.unshift(`…${line.slice(line.length - (budget - 1))}`);
      break;
    }
    kept.unshift(line);
    used += cost;
  }
  return `${head}${CALL_RECAP_DROPPED}${kept.join("\n")}${tail}`.slice(0, max);
}

/** Nur für Tests */
export function resetCallRecapsForTests(): void {
  recaps.clear();
}
