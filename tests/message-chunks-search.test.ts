/**
 * Issue #479: Suche des Bots über den Store (getStore().messages.search,
 * src/lib/store/supabase/message-reads.ts) mit Abschnitten langer
 * Nachrichten. Treffer langer Nachrichten kommen nur als Ausschnitt um die
 * Suchbegriffe, auch wenn eine ältere Edge Function den Volltext liefert oder
 * die eigene Textsuche einspringt. Die Fälle „Suche des Bots“ aus master
 * (tests/message-chunks.test.ts, Commit c68c0e9), dazu der Rückfall bei einer
 * Meldung unter den Treffern. Kein Netz: supabase-js gegen die Fetch-Attrappe.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EXCERPT_CHARS } from "../supabase/functions/_shared/chunks";
import { getStore } from "../src/lib/store";
import { useFakeSupabase } from "./supabase-fixture";

/** Satz mit fortlaufender Nummer, damit jede Stelle im Text eindeutig ist */
function sentences(chars: number, prefix = "Satz"): string {
  let out = "";
  for (let i = 0; out.length < chars; i++) out += `${prefix} ${i} erzählt etwas über das Wetter in Hamburg. `;
  return out.slice(0, chars);
}

describe("Suche des Bots", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });
  const long = sentences(15_000) + " Das Codewort lautet Zitronenfalter. " + sentences(5_000);

  test("Treffer einer älteren Edge Function mit Volltext: nur Ausschnitt um den Begriff", async () => {
    const f = useFakeSupabase({
      edge: name => (name === "search-memory" ? [{ id: 7, chat_id: "1", role: "user", content: long, similarity: 0.8 }, { id: 8, chat_id: "1", role: "user", content: "kurz", similarity: 0.7 }] : undefined),
    });
    cleanups.push(() => f.restore());
    const result = await getStore().messages.search("1", "Zitronenfalter", 5);
    expect(result).toHaveLength(2);
    expect(result[0].content.length).toBeLessThanOrEqual(EXCERPT_CHARS + 2);
    expect(result[0].content).toContain("Zitronenfalter");
    expect((result[0] as { excerpt?: boolean }).excerpt).toBe(true);
    expect(result[1].content).toBe("kurz");
  });

  test("Treffer einer neuen Edge Function, schon gekürzt: unverändert", async () => {
    const hit = { id: 7, chat_id: "1", role: "user", content: "…Das Codewort lautet Zitronenfalter…", similarity: 0.6, chunk_index: 2, content_length: 20_000, excerpt: true };
    const f = useFakeSupabase({ edge: name => (name === "search-memory" ? [hit] : undefined) });
    cleanups.push(() => f.restore());
    expect(await getStore().messages.search("1", "Zitronenfalter", 5)).toEqual([hit as never]);
  });

  test("Textsuche ohne Edge Function: lange Nachricht als Ausschnitt", async () => {
    const f = useFakeSupabase({ rows: () => [{ id: 7, chat_id: "1", role: "user", content: long, metadata: {}, created_at: "2026-10-15T08:00:00.000Z" }] });
    cleanups.push(() => f.restore());
    const result = await getStore().messages.search("1", "Zitronenfalter", 5);
    expect(result).toHaveLength(1);
    expect(result[0].content.length).toBeLessThanOrEqual(EXCERPT_CHARS + 2);
    expect(result[0].content).toContain("Zitronenfalter");
  });

  test("Meldung unter den Treffern der Edge Function: eigene Textsuche, ebenfalls gekürzt", async () => {
    const f = useFakeSupabase({
      edge: name => (name === "search-memory" ? [{ id: 9, chat_id: "1", role: "assistant", content: "Meldung", metadata: { display_only: true } }] : undefined),
      rows: () => [{ id: 7, chat_id: "1", role: "user", content: long, metadata: {}, created_at: "2026-10-15T08:00:00.000Z" }],
    });
    cleanups.push(() => f.restore());
    const result = await getStore().messages.search("1", "Zitronenfalter", 5);
    expect(result.map(m => m.content)).toHaveLength(1);
    expect(result[0].content).toContain("Zitronenfalter");
    expect(result[0].content.length).toBeLessThanOrEqual(EXCERPT_CHARS + 2);
  });
});
