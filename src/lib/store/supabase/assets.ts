/**
 * Supabase-Adapter für Bilder und Dateien (Issue #318): Tabelle assets und
 * der private Speicherordner aus src/lib/assets/bucket.ts.
 *
 * Hochladen legt die Datei unter <art>s/<Tag>/<UUID><Endung> ab und schreibt
 * danach die Zeile. In der Spalte public_url steht nie ein Link: der Ordner
 * ist privat, jeder Link wird beim Lesen (upload, byId, recent, search) frisch
 * signiert und gilt LINK_LIFETIME_SECONDS. Scheitert das Signieren, ist
 * public_url null, nie ein alter Link.
 *
 * Beschreibung setzen rechnet einen Vektor aus Beschreibung und Schlagwörtern
 * mit dem Anbieter der Datenbank (embedWithConfig, EMBEDDING_PROVIDER) und
 * schreibt embedding_model dazu. Fehlt die Spalte (Datenbank vor Migration
 * 20260928), folgt ein zweiter Versuch ohne sie; ohne Vektor wird die
 * Beschreibung trotzdem gespeichert. Den Text bildet assetEmbeddingText,
 * genauso wie die Neuberechnung in src/lib/embedding-reindex.ts.
 *
 * Suche nach Text: Wörter aus dem Suchtext (knowledgeTerms, nur Buchstaben,
 * Zeichen und Ziffern, deshalb nichts, was in PostgREST-Filtern oder
 * LIKE-Mustern etwas bedeutet); ein Bild passt, wenn die Beschreibung eines
 * der Wörter enthält oder ein Schlagwort ihm gleicht. Neueste zuerst.
 *
 * Fehler werfen nicht, sie ergeben null, leere Listen bzw. eine Logzeile; nur die
 * Suche mit strict wirft, damit das Nachschlagen sie von „nichts gefunden“ trennen kann.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { embeddingColumns, MISSING_COLUMN_CODES } from "../../../../supabase/functions/_shared/embedding";
import { containsPattern } from "../../../../supabase/functions/_shared/like-pattern";
import { assetsBucket, LINK_LIFETIME_SECONDS } from "../../assets/bucket";
import { extensionOf, kindForExtension, mimeForExtension } from "../../assets/file-types";
import { embedWithConfig, type ConfiguredEmbedding } from "../../embedding";
import { knowledgeTerms } from "../knowledge-terms";
import type { AssetStore } from "../ports";
import type { Asset, AssetUpload } from "../types";
import type { ClientSource } from "./messages";

const TABLE = "assets";
/** Alle Spalten außer dem Vektor, der beim Lesen nur Last wäre */
const COLUMNS =
  "id,created_at,storage_path,public_url,original_filename,file_type,mime_type,file_size_bytes,description,user_caption,conversation_context,related_project,tags,channel,metadata";
/** So viele Wörter zählen bei der Suche höchstens */
const SEARCH_TERMS = { minLength: 2, max: 5 };

export interface AssetDeps {
  /** Vektor samt Anbieter und Modell; null: Beschreibung ohne Vektor speichern */
  embed?: (text: string) => Promise<ConfiguredEmbedding | null>;
  /** Name des Speicherordners, bei jedem Zugriff neu gelesen */
  bucket?: () => string;
  now?: () => Date;
  uuid?: () => string;
}

/** Endung für den Speicherpfad: nur Buchstaben und Ziffern, sonst keine */
function safeSuffix(filename: string): string {
  const base = filename.slice(filename.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  const cleaned = base.slice(dot + 1).replace(/[^a-zA-Z0-9]/g, "");
  return cleaned ? `.${cleaned}` : "";
}

/** Text, aus dem der Vektor eines Bildes entsteht: Beschreibung, Leerzeichen, Schlagwörter */
export function assetEmbeddingText(description: string, tags: string[] = []): string {
  return [description, tags.join(" ")].join(" ");
}

/** PostgREST-Filter „Beschreibung enthält eines der Wörter oder ein Schlagwort gleicht ihm“ */
export function assetSearchFilter(terms: string[]): string {
  const parts: string[] = [];
  for (const term of terms) parts.push(`description.ilike.${containsPattern(term)}`, `tags.cs.{${term}}`);
  return parts.join(",");
}

export function supabaseAssets(clientSource: ClientSource, deps: AssetDeps = {}): AssetStore {
  const embed = deps.embed ?? (text => embedWithConfig(text));
  const bucket = deps.bucket ?? (() => assetsBucket());
  const now = deps.now ?? (() => new Date());
  const uuid = deps.uuid ?? (() => crypto.randomUUID());

  /** Frischer Link für eine Zeile; ohne Pfad oder bei Fehler null */
  const withLink = async (client: SupabaseClient, row: Asset): Promise<Asset> => {
    let link: string | null = null;
    if (row.storage_path) {
      try {
        const signed = await client.storage.from(bucket()).createSignedUrl(row.storage_path, LINK_LIFETIME_SECONDS);
        link = signed.error ? null : (signed.data?.signedUrl ?? null);
      } catch {
        link = null;
      }
    }
    return { ...row, public_url: link };
  };

  const withLinks = (client: SupabaseClient, rows: unknown): Promise<Asset[]> =>
    Array.isArray(rows) ? Promise.all((rows as Asset[]).map(row => withLink(client, row))) : Promise.resolve([]);

  /** Liste aus einer Abfrage, jede Zeile mit frischem Link; Fehler: leer, mit strict wirft es */
  const list = async (label: string, run: (client: SupabaseClient) => PromiseLike<{ data: unknown; error: { message?: string } | null }>, strict = false) => {
    const client = clientSource();
    if (!client) {
      if (strict) throw new Error(`${label} gescheitert`);
      return [];
    }
    let detail: string;
    try {
      const answer = await run(client);
      if (!answer.error) return await withLinks(client, answer.data);
      detail = answer.error.message ?? "Fehler";
    } catch (err) {
      detail = err instanceof Error ? err.message : "Fehler";
    }
    console.error(`[Bilder] ${label} gescheitert:`, detail);
    if (strict) throw new Error(`${label} gescheitert`);
    return [];
  };

  return {
    async upload(input: AssetUpload): Promise<Asset | null> {
      const client = clientSource();
      if (!client) return null;
      const ext = extensionOf(input.filename);
      const fileType = input.fileType || kindForExtension(ext);
      const mimeType = input.mimeType || mimeForExtension(ext) || "application/octet-stream";
      const path = `${fileType}s/${now().toISOString().slice(0, 10)}/${uuid()}${safeSuffix(input.filename)}`;
      const record: Record<string, unknown> = {
        storage_path: path,
        public_url: null,
        original_filename: input.filename,
        file_type: fileType,
        mime_type: mimeType,
        file_size_bytes: input.data.byteLength,
        description: input.description,
        user_caption: input.userCaption || null,
        conversation_context: input.conversationContext || null,
        related_project: input.relatedProject || null,
        tags: input.tags ?? [],
        channel: input.channel || "telegram",
        metadata: input.metadata ?? {},
      };
      try {
        const stored = await client.storage.from(bucket()).upload(path, input.data, { contentType: mimeType, upsert: false });
        if (stored.error) {
          console.error("[Bilder] Hochladen gescheitert:", stored.error.message);
          return null;
        }
        const inserted = await client.from(TABLE).insert(record).select(COLUMNS).single();
        if (inserted.error || !inserted.data) {
          console.error("[Bilder] Zeile nicht gespeichert:", inserted.error?.message ?? "keine Antwort");
          return null;
        }
        console.log(`📦 Bild gespeichert: ${path} (${fileType})`);
        return await withLink(client, inserted.data as unknown as Asset);
      } catch (err) {
        console.error("[Bilder] Hochladen gescheitert:", err instanceof Error ? err.message : "Fehler");
        return null;
      }
    },

    async setDescription(assetId, description, tags, relatedProject) {
      const client = clientSource();
      if (!client) return;
      const changes: Record<string, unknown> = { description };
      if (tags && tags.length > 0) changes.tags = tags;
      if (relatedProject) changes.related_project = relatedProject;
      const vector = await embed(assetEmbeddingText(description, tags)).catch(() => null);
      if (vector) Object.assign(changes, embeddingColumns(vector.vector, vector.config));
      try {
        let answer = await client.from(TABLE).update(changes).eq("id", assetId);
        if (answer.error && vector && MISSING_COLUMN_CODES.includes(String(answer.error.code))) {
          // Datenbank ohne Migration 20260928: Vektor ohne Angabe des Modells
          const { embedding_model: _model, ...older } = changes;
          answer = await client.from(TABLE).update(older).eq("id", assetId);
        }
        if (answer.error) console.error("[Bilder] Beschreibung nicht gespeichert:", answer.error.message);
        else console.log(`📝 Beschreibung für Bild ${assetId.slice(0, 8)} gespeichert${vector ? " (mit Vektor)" : ""}`);
      } catch (err) {
        console.error("[Bilder] Beschreibung nicht gespeichert:", err instanceof Error ? err.message : "Fehler");
      }
    },

    async byId(assetId) {
      const client = clientSource();
      if (!client) return null;
      try {
        const answer = await client.from(TABLE).select(COLUMNS).eq("id", assetId).maybeSingle();
        if (answer.error || !answer.data) return null;
        return await withLink(client, answer.data as unknown as Asset);
      } catch {
        return null;
      }
    },

    recent: (limit, fileType) =>
      list("Letzte Bilder lesen", client => {
        const query = client.from(TABLE).select(COLUMNS);
        return (fileType ? query.eq("file_type", fileType) : query).order("created_at", { ascending: false }).limit(limit);
      }),

    async search(query, limit, options = {}) {
      const terms = knowledgeTerms(query, SEARCH_TERMS);
      if (terms.length === 0) return [];
      return list(
        "Bildsuche",
        client => client.from(TABLE).select(COLUMNS).or(assetSearchFilter(terms)).order("created_at", { ascending: false }).limit(limit),
        options.strict,
      );
    },
  };
}
