/**
 * Mitgegebenes created_at einer Nachricht prüfen (Issue #69). Gilt für die
 * Edge-Function store-telegram-message und für src/lib/supabase.ts, damit
 * beide Wege dieselben Werte annehmen. Ohne Deno- und Bun-Abhängigkeiten.
 *
 * Angenommen wird nur ein ISO-Zeitstempel mit Datum, Uhrzeit und Zeitzone
 * (Z oder ±hh:mm), der ein echtes Datum ist und nicht in der Zukunft liegt.
 * Rückgabe normalisiert (toISOString), sonst null: dann lässt der Aufrufer
 * das Feld weg und die Datenbank setzt ihren Default.
 */
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

export function acceptedCreatedAt(value: unknown, now: number = Date.now()): string | null {
  if (typeof value !== "string") return null;
  const m = ISO_TIMESTAMP.exec(value);
  if (!m) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  // Date.parse rollt Tage wie 2026-02-31 still weiter; das Datum muss genau so existieren
  const [, y, mo, d] = m;
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (day.getUTCFullYear() !== Number(y) || day.getUTCMonth() !== Number(mo) - 1 || day.getUTCDate() !== Number(d)) return null;
  if (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59) return null;
  if (ms > now) return null;
  return new Date(ms).toISOString();
}
