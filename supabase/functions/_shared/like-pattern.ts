/**
 * Suchtext für LIKE/ILIKE-Muster (Issue #310). Gilt für die Edge Function
 * search-memory und für den Supabase-Adapter in src/lib/store, damit beide
 * Textsuchen dieselben Zeichen wörtlich nehmen. Ohne Deno- und
 * Bun-Abhängigkeiten.
 *
 * In Postgres sind `%` (beliebig viele Zeichen) und `_` (genau ein Zeichen)
 * Platzhalter, `\` ist das Escape-Zeichen. Jedes Zeichen wird genau einmal
 * betrachtet, ein eingefügter Backslash also nie ein zweites Mal maskiert
 * (dasselbe Ergebnis wie: erst `\` verdoppeln, dann `%` und `_`).
 *
 * Nicht abgedeckt: PostgREST liest `*` in like/ilike als Ersatz für `%`,
 * noch bevor Postgres das Muster sieht. Ein Escape hilft dagegen nicht
 * (aus `\*` würde `\%`, also ein wörtliches Prozentzeichen).
 */
export function escapeLikePattern(text: string): string {
  let escaped = "";
  for (const char of text) {
    escaped += char === "\\" || char === "%" || char === "_" ? `\\${char}` : char;
  }
  return escaped;
}

/** Muster „enthält den Text wörtlich“ für ilike */
export function containsPattern(text: string): string {
  return `%${escapeLikePattern(text)}%`;
}
