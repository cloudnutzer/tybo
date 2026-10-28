/**
 * Vorlage für eine eigene Quelle (Issue #354). Sie steht in keiner Liste
 * und läuft deshalb nie von selbst.
 *
 * So wird daraus eine Quelle:
 * 1. Datei kopieren, etwa nach src/lib/sources/wetter.ts
 * 2. id, label, die Variablen in ready() und den Abruf in collect() anpassen
 * 3. Die Variablen in .env eintragen
 * 4. Die Quelle in src/lib/sources/list.ts in SOURCES aufnehmen; die
 *    Stelle in der Liste ist die Stelle des Abschnitts
 *
 * Regeln:
 * - ready() prüft nur, ob Zugangsdaten da sind: kein Netz, keine Datei
 * - collect() liefert Einträge, kein fertiges Markdown; wie sie aussehen,
 *   entscheidet der Aufrufer
 * - ctx.fetch und ctx.signal benutzen, damit das Zeitlimit greift und
 *   Tests eine Attrappe einsetzen können
 * - Bei Fehlern werfen, mit einer Meldung ohne Schlüssel und ohne
 *   Antworttext des Dienstes; der Lauf macht daraus den Ausgang „failed"
 * - Nichts zu melden: leere items, gern mit note
 */
import { dayIn } from "./run";
import type { Env, Section, SectionItem, Source, SourceContext } from "./types";

/** Antwort des gedachten Dienstes: eine Liste von Meldungen */
interface ExampleEntry {
  title?: string;
  date?: string;
  url?: string;
}

export const exampleSource: Source = {
  id: "example",
  label: "Example",
  // Ohne Angabe gilt DEFAULT_SOURCE_TIMEOUT_MS aus run.ts
  timeoutMs: 10_000,
  ready: (env: Env) => !!env.EXAMPLE_API_KEY?.trim(),
  async collect(ctx: SourceContext): Promise<Section> {
    const today = dayIn(ctx.now, ctx.timeZone);
    const response = await ctx.fetch(`https://api.example.com/entries?day=${today}`, {
      signal: ctx.signal,
      headers: { Authorization: `Bearer ${ctx.env.EXAMPLE_API_KEY!.trim()}` },
    });
    if (response.status === 401) throw new Error("Example lehnt den Schlüssel ab (401), EXAMPLE_API_KEY prüfen");
    if (!response.ok) throw new Error(`Example antwortet mit HTTP ${response.status}`);

    const entries = (await response.json()) as ExampleEntry[];
    const items: SectionItem[] = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry.title) continue;
      const item: SectionItem = { text: entry.title };
      if (entry.date) item.due = entry.date.slice(0, 10);
      if (entry.url) item.link = entry.url;
      items.push(item);
    }
    if (items.length === 0) return { items, note: "Nothing new today" };
    return { items };
  },
};
