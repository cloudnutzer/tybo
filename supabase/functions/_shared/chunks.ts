/**
 * Abschnitte langer Nachrichten für die semantische Suche, gemeinsam für die
 * Edge Functions und den Bot (src/lib/message-chunks.ts). Wie embedding.ts
 * ohne relative Importe und ohne Deno- und Bun-Abhängigkeiten: Embedding und
 * Schreiben kommen als Funktionen herein.
 *
 * Das Embedding einer Nachricht sieht nur ihre ersten EMBED_MAX_CHARS Zeichen
 * (das Modell nimmt rund 8000 Tokens). Längere Nachrichten (Web bis 200.000
 * Zeichen) bekommen zusätzlich Abschnitte von rund CHUNK_SIZE Zeichen mit
 * CHUNK_OVERLAP Zeichen Überlappung, geschnitten möglichst an Absatz-, dann
 * Satz-, dann Wortgrenzen. Jeder Abschnitt hat ein eigenes Embedding in der
 * Tabelle message_chunks (db/migrations/20261015_message_chunks.sql); die
 * Suche (match_messages_chunked_checked) liefert die Nachricht einmal, mit der
 * besten Ähnlichkeit aus Nachricht und Abschnitten. Kurze Nachrichten bleiben
 * wie bisher, ohne Abschnitte.
 *
 * Treffer langer Nachrichten gehen nie als ganzer Text hinaus, sondern als
 * Ausschnitt um die Suchbegriffe (excerptFor, shapeHits): die Treffer landen
 * im Prompt (SEMANTIC SEARCH RESULTS, src/lib/prompt-builder.ts).
 */

/** Bis zu dieser Länge reicht das Embedding der Nachricht selbst (sie wird darauf gekürzt) */
export const EMBED_MAX_CHARS = 8000;
/** Ziellänge eines Abschnitts */
export const CHUNK_SIZE = 6000;
/** So viele Zeichen am Ende eines Abschnitts stehen auch am Anfang des nächsten */
export const CHUNK_OVERLAP = 500;
/** So weit vor der Ziellänge sucht ein Abschnitt nach einer Absatz-, Satz- oder Wortgrenze */
export const BOUNDARY_WINDOW = 1500;
/** Der letzte Abschnitt darf so viel länger sein, statt einen winzigen Rest abzutrennen */
export const LAST_CHUNK_SLACK = 500;
/** Länge eines Ausschnitts in Suchtreffern */
export const EXCERPT_CHARS = 1200;
/** Zeichen vor dem ersten Suchbegriff im Ausschnitt (der Prompt zeigt nur die ersten 300) */
export const EXCERPT_LEAD = 100;
/** Gleichzeitige Anfragen beim Anbieter für die Abschnitte einer Nachricht */
export const CHUNK_CONCURRENCY = 4;

export interface ChunkRange {
  start: number;
  end: number;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Schnittstelle nie mitten in einem Ersatzpaar (Emoji und andere Zeichen außerhalb der BMP) */
function safeCut(text: string, at: number): number {
  if (at > 0 && at < text.length && isLowSurrogate(text.charCodeAt(at)) && isHighSurrogate(text.charCodeAt(at - 1))) return at - 1;
  return at;
}

/**
 * Ende eines Abschnitts zwischen min und max: hinter dem letzten Absatz,
 * sonst Zeilenumbruch, sonst Satzende, sonst Leerraum; ohne all das hart bei
 * max (nie in einem Ersatzpaar).
 */
function cutPoint(text: string, min: number, max: number): number {
  const part = text.slice(min, max);
  const paragraph = part.lastIndexOf("\n\n");
  if (paragraph >= 0) return min + paragraph + 2;
  const line = part.lastIndexOf("\n");
  if (line >= 0) return min + line + 1;
  let sentence = -1;
  for (const m of part.matchAll(/[.!?…]["'»«“”‘’)\]]*\s+/g)) sentence = (m.index ?? 0) + m[0].length;
  if (sentence > 0) return min + sentence;
  let space = -1;
  for (const m of part.matchAll(/\s+/g)) space = (m.index ?? 0) + m[0].length;
  if (space > 0) return min + space;
  return safeCut(text, max);
}

/** Beginn des Folgeabschnitts: am Wortanfang nach pos (höchstens 100 Zeichen weiter), sonst pos */
function startPoint(text: string, pos: number, limit: number): number {
  const window = text.slice(pos, Math.min(limit, pos + 100));
  const space = window.search(/\s/);
  if (space >= 0) {
    let at = pos + space;
    while (at < limit && /\s/.test(text[at])) at++;
    if (at < limit) return at;
  }
  return safeCut(text, pos);
}

/**
 * Grenzen der Abschnitte; leer, wenn der Text höchstens EMBED_MAX_CHARS
 * Zeichen hat. Zusammen decken die Abschnitte den ganzen Text ab, je zwei
 * aufeinanderfolgende überlappen um rund overlap Zeichen.
 */
export function chunkRanges(text: string, size: number = CHUNK_SIZE, overlap: number = CHUNK_OVERLAP): ChunkRange[] {
  if (text.length <= EMBED_MAX_CHARS) return [];
  const window = Math.min(BOUNDARY_WINDOW, Math.floor(size / 2));
  const ranges: ChunkRange[] = [];
  let start = 0;
  for (;;) {
    if (text.length - start <= size + LAST_CHUNK_SLACK) {
      ranges.push({ start, end: text.length });
      return ranges;
    }
    const end = cutPoint(text, start + size - window, start + size);
    ranges.push({ start, end });
    // Fortschritt ist sicher: end liegt mindestens size - window hinter start, das ist mehr als overlap
    start = startPoint(text, Math.max(start + 1, end - overlap), end);
  }
}

/** Die Abschnitte eines Textes (leer bis EMBED_MAX_CHARS Zeichen) */
export function splitIntoChunks(text: string, size: number = CHUNK_SIZE, overlap: number = CHUNK_OVERLAP): string[] {
  return chunkRanges(text, size, overlap).map(r => text.slice(r.start, r.end));
}

/** Braucht dieser Text Abschnitte? */
export function needsChunks(text: string): boolean {
  return text.length > EMBED_MAX_CHARS;
}

// ---------------------------------------------------------------------------
// Ausschnitte für Suchtreffer
// ---------------------------------------------------------------------------

/** Suchbegriffe: Wörter ab drei Zeichen, ohne Groß- und Kleinschreibung, höchstens 32 */
export function queryTerms(query: string): string[] {
  const out: string[] = [];
  for (const word of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length >= 3 && !out.includes(word)) out.push(word);
    if (out.length >= 32) break;
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Ausschnitt von höchstens max Zeichen (plus Auslassungszeichen): das
 * Fenster mit den meisten verschiedenen Suchbegriffen (seltene zählen mehr,
 * Begriffe nur am Wortanfang), beginnend kurz vor dem ersten seltenen.
 * Ohne Treffer der Anfang. Kürzere Texte bleiben unverändert.
 */
export function excerptFor(text: string, query: string, max: number = EXCERPT_CHARS): string {
  if (text.length <= max) return text;
  const terms = queryTerms(query);
  const hits: Array<{ pos: number; term: string }> = [];
  if (terms.length) {
    // Nur am Wortanfang: „der“ soll nicht in „Ordner“ zählen, „bienen“ aber in „Bienenvölker“
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map(escapeRegExp).join("|")})`, "giu");
    for (const m of text.matchAll(pattern)) {
      hits.push({ pos: m.index ?? 0, term: m[0].toLowerCase() });
      if (hits.length >= 2000) break;
    }
  }
  let start = 0;
  if (hits.length) {
    // Seltene Begriffe zählen mehr: ein Wort wie „das“ steht überall, der gesuchte Name einmal
    const total = new Map<string, number>();
    for (const h of hits) total.set(h.term, (total.get(h.term) ?? 0) + 1);
    const weight = (term: string) => 1 / (total.get(term) ?? 1);
    let best = { i: 0, j: 0, score: -1, lead: 0 };
    let j = 0;
    let score = 0;
    const seen = new Map<string, number>();
    // Gleitendes Fenster über die Fundstellen: [hits[i].pos, hits[i].pos + max - lead);
    // bei gleicher Punktzahl beginnt es lieber mit einem seltenen Begriff
    for (let i = 0; i < hits.length; i++) {
      while (j < hits.length && hits[j].pos < hits[i].pos + max - EXCERPT_LEAD) {
        const before = seen.get(hits[j].term) ?? 0;
        if (!before) score += weight(hits[j].term);
        seen.set(hits[j].term, before + 1);
        j++;
      }
      const lead = weight(hits[i].term);
      if (score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && lead > best.lead)) best = { i, j, score, lead };
      const left = (seen.get(hits[i].term) ?? 1) - 1;
      if (left) seen.set(hits[i].term, left);
      else {
        seen.delete(hits[i].term);
        score -= weight(hits[i].term);
      }
    }
    // Beginnen am ersten seltenen Begriff des Fensters, nicht an einem Allerweltswort davor
    let top = 0;
    for (let h = best.i; h < best.j; h++) top = Math.max(top, weight(hits[h].term));
    let anchor = hits[best.i].pos;
    for (let h = best.i; h < best.j; h++) {
      if (weight(hits[h].term) >= top / 2) {
        anchor = hits[h].pos;
        break;
      }
    }
    start = Math.max(0, anchor - EXCERPT_LEAD);
  }
  // Steht der Begriff am Ende, wird der Ausschnitt kürzer statt nach vorn verschoben:
  // der Prompt zeigt nur seinen Anfang
  if (start > 0) {
    // Am Wortanfang beginnen, wenn einer in der Nähe ist
    const space = text.slice(start, start + 40).search(/\s/);
    start = space >= 0 ? start + space + 1 : safeCut(text, start);
  }
  let end = Math.min(text.length, start + max);
  if (end < text.length) {
    const space = text.slice(Math.max(start, end - 40), end).search(/\s\S*$/);
    end = space >= 0 ? Math.max(start, end - 40) + space : safeCut(text, end);
  }
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/**
 * Suchtreffer für die Ausgabe: Treffer aus Abschnitten (chunk_index) und
 * Treffer langer Nachrichten (content_length bzw. Textlänge über
 * EMBED_MAX_CHARS) bekommen statt des Textes einen Ausschnitt um die
 * Suchbegriffe und excerpt: true. Kurze Nachrichten und schon gekürzte
 * Treffer bleiben unverändert.
 */
export function shapeHits<T extends object>(rows: T[], query: string): T[] {
  return rows.map(hit => {
    const row = hit as Record<string, unknown>;
    if (row.excerpt === true) return hit;
    const content = typeof row.content === "string" ? row.content : "";
    const length = Number(row.content_length) || content.length;
    const fromChunk = typeof row.chunk_index === "number";
    if (!fromChunk && length <= EMBED_MAX_CHARS) return hit;
    return { ...hit, content: excerptFor(content, query), excerpt: true };
  });
}

// ---------------------------------------------------------------------------
// Abschnitte rechnen und schreiben
// ---------------------------------------------------------------------------

/** Ergebnis eines Embeddings, wie EmbedResult in embedding.ts (strukturgleich, ohne Import) */
export type ChunkEmbedResult =
  | { ok: true; vector: number[]; config?: { provider: string; model: string } }
  | { ok: false; message: string; reason?: string; status?: number; retryAfterMs?: number };

export type ChunkEmbedFailure = Extract<ChunkEmbedResult, { ok: false }>;

export interface ChunkRow {
  chunk_index: number;
  content: string;
  embedding: number[];
}

export type EmbeddedChunks =
  /** configKey: „anbieter:modell“ aus den Ergebnissen, "" ohne Angabe */
  | { ok: true; rows: ChunkRow[]; configKey: string }
  /** failure: das erste gescheiterte Embedding (für Pausen und Meldungen) */
  | { ok: false; message: string; failure?: ChunkEmbedFailure };

/**
 * Embeddings für alle Abschnitte eines Textes, höchstens concurrency
 * gleichzeitig. Alles oder nichts: scheitert ein Abschnitt, gibt es keine
 * Zeilen (die Nachricht bleibt ohne Abschnitte und wird später nachgeholt).
 * Alle Vektoren müssen mit derselben Einstellung entstanden sein.
 */
export async function embedChunks(text: string, embed: (chunk: string) => Promise<ChunkEmbedResult>, concurrency: number = CHUNK_CONCURRENCY): Promise<EmbeddedChunks> {
  const chunks = splitIntoChunks(text);
  if (!chunks.length) return { ok: true, rows: [], configKey: "" };
  const rows: ChunkRow[] = new Array(chunks.length);
  let failure: ChunkEmbedFailure | undefined;
  let configKey: string | undefined;
  let mixed = false;
  let next = 0;
  async function worker(): Promise<void> {
    while (!failure && !mixed && next < chunks.length) {
      const i = next++;
      let result: ChunkEmbedResult;
      try {
        result = await embed(chunks[i]);
      } catch {
        result = { ok: false, message: "Das Embedding eines Abschnitts ist auf einen unerwarteten Fehler gestoßen." };
      }
      if (!result.ok) {
        failure ??= result;
        return;
      }
      const key = result.config ? `${result.config.provider}:${result.config.model}` : "";
      if (configKey === undefined) configKey = key;
      else if (configKey !== key) mixed = true;
      rows[i] = { chunk_index: i, content: chunks[i], embedding: result.vector };
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, chunks.length)) }, worker));
  if (failure) return { ok: false, message: failure.message, failure };
  if (mixed) return { ok: false, message: "Die Abschnitte entstanden mit verschiedenen Einstellungen." };
  return { ok: true, rows, configKey: configKey ?? "" };
}

/** SHA-256 des Textes als Hex, wie encode(sha256(convert_to(content, 'UTF8')), 'hex') in der Datenbank */
export async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

/** Argumente für message_chunks_write: Vektoren als Text „[…]“ wie bei der Neuberechnung */
export function chunkWriteArgs(
  messageId: number | string,
  config: { provider: string; model: string },
  hash: string,
  rows: ChunkRow[],
): Record<string, unknown> {
  return {
    p_message_id: messageId,
    p_provider: config.provider,
    p_model: config.model,
    p_hash: hash,
    p_chunks: rows.map(r => ({ chunk_index: r.chunk_index, content: r.content, embedding: JSON.stringify(r.embedding) })),
  };
}

/**
 * Was beim Schreiben herauskam: ok; gesperrt (Umstellung oder anderer
 * Anbieter festgehalten); geaendert (der Text der Nachricht hat sich seit dem
 * Lesen geändert); anzeige (Nur-Anzeige-Eintrag); fehlt (Nachricht oder
 * Migration fehlt); fehler (Datenbank nicht erreichbar oder unlesbare Antwort)
 */
export type ChunkWriteState = "ok" | "gesperrt" | "geaendert" | "anzeige" | "fehlt" | "fehler";

/** Antwort von message_chunks_write deuten */
export function chunkWriteState(data: unknown): ChunkWriteState {
  const d = data as { ok?: unknown; state?: unknown } | null;
  if (d?.ok === true) return "ok";
  if (d?.state === "gesperrt" || d?.state === "geaendert" || d?.state === "anzeige" || d?.state === "fehlt") return d.state;
  return "fehler";
}

export type StoreChunksOutcome =
  | { state: "ok"; chunks: number }
  /** Keine Abschnitte nötig (kurzer Text) */
  | { state: "kurz" }
  | { state: "kein-embedding"; message: string; failure?: ChunkEmbedFailure }
  | { state: Exclude<ChunkWriteState, "ok"> };

/**
 * Abschnitte einer gespeicherten Nachricht rechnen und ersetzen. config: womit
 * die Vektoren entstehen (die Datenbank prüft es beim Schreiben). Wirft nie.
 */
export async function storeMessageChunks(
  messageId: number | string,
  content: string,
  config: { provider: string; model: string },
  embed: (chunk: string) => Promise<ChunkEmbedResult>,
  write: (args: Record<string, unknown>) => Promise<ChunkWriteState>,
  concurrency: number = CHUNK_CONCURRENCY,
): Promise<StoreChunksOutcome> {
  if (!needsChunks(content)) return { state: "kurz" };
  const embedded = await embedChunks(content, embed, concurrency);
  if (!embedded.ok) return { state: "kein-embedding", message: embedded.message, failure: embedded.failure };
  // Ein Vektor mit Angabe muss zu der Einstellung passen, mit der geschrieben wird
  if (embedded.configKey && embedded.configKey !== `${config.provider}:${config.model}`) {
    return { state: "kein-embedding", message: "Die Abschnitte entstanden mit einer anderen Einstellung als die Nachricht." };
  }
  let state: ChunkWriteState;
  try {
    state = await write(chunkWriteArgs(messageId, config, await contentHash(content), embedded.rows));
  } catch {
    state = "fehler";
  }
  return state === "ok" ? { state: "ok", chunks: embedded.rows.length } : { state };
}
