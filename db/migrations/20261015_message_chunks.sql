-- Abschnitte langer Nachrichten für die semantische Suche.
--
-- Das Embedding einer Nachricht sieht nur ihre ersten 8000 Zeichen; die
-- WebUI nimmt aber bis zu 200.000. Nachrichten mit mehr als 8000 Zeichen
-- bekommen darum zusätzlich Abschnitte von rund 6000 Zeichen mit 500 Zeichen
-- Überlappung, jeder mit eigenem Embedding (Teilen:
-- supabase/functions/_shared/chunks.ts). Kurze Nachrichten bleiben ohne.
--
-- Anbieter und Modell wie bei messages (Issue #167/#168,
-- 20260928_embedding_reindex.sql): jeder Abschnitt trägt in embedding_model,
-- womit sein Vektor entstand. Geprüft wird beim Schreiben
-- (message_chunks_write und der Trigger message_chunks_guard, gleiche Sperre
-- wie embedding_reindex_guard) und beim Suchen
-- (match_messages_chunked_checked): während einer Umstellung entsteht kein
-- Abschnitt und die Suche liefert nichts. Nach dem Umschalten tragen die
-- alten Abschnitte die alte Kennung, die Suche übergeht sie, und der Nachzug
-- (message_chunks_pending, src/lib/message-chunks.ts) rechnet sie mit dem
-- neuen Anbieter neu. Ändert sich der Text einer Nachricht, verschwinden
-- ihre Abschnitte (message_chunks_invalidate) und entstehen im Nachzug neu.
--
-- Kein Vektorindex, wie bei messages: exakte Suche über wenige Zeilen; ein
-- HNSW-Index filtert erst nach der Suche und würde mit den Filtern auf
-- Anbieter und Chat Treffer verlieren.
--
-- Nur für Supabase; Convex hat keine Abschnitte. Wiederholbar (IF NOT EXISTS,
-- CREATE OR REPLACE). Setzt 20260928_embedding_reindex.sql voraus.
BEGIN;

CREATE TABLE IF NOT EXISTS public.message_chunks (
  id bigserial PRIMARY KEY,
  message_id bigint NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  chat_id text NOT NULL,
  chunk_index int NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL,
  embedding vector(1536),
  embedding_model text CHECK (embedding_model IS NULL OR embedding_model ~ '^(openai|gemini|ollama):[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_message_chunks_chat_id ON public.message_chunks (chat_id);

-- Nur der Server (service_role) liest und schreibt, wie messages nach 20260909
ALTER TABLE public.message_chunks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.message_chunks FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.message_chunks TO service_role;
REVOKE ALL ON SEQUENCE public.message_chunks_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.message_chunks_id_seq TO service_role;

-- Jedes Schreiben prüfen wie embedding_reindex_guard: ein Vektor bleibt nur,
-- wenn seine Angabe dem gilt, was die Datenbank gerade festhält (während
-- einer Umstellung nie); sonst ohne Vektor (der Nachzug rechnet neu)
CREATE OR REPLACE FUNCTION public.message_chunks_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  allowed text;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext('tybo_embedding_reindex'));
  IF NEW.embedding IS NULL THEN
    NEW.embedding_model := NULL;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.embedding_settings WHERE id FOR SHARE;
  allowed := public.embedding_accepted_key(NEW.embedding_model);
  IF allowed IS NULL THEN
    NEW.embedding := NULL;
    NEW.embedding_model := NULL;
  ELSE
    NEW.embedding_model := allowed;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.message_chunks_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS message_chunks_guard ON public.message_chunks;
CREATE TRIGGER message_chunks_guard BEFORE INSERT OR UPDATE ON public.message_chunks
FOR EACH ROW EXECUTE FUNCTION public.message_chunks_guard();

-- Text geändert oder zur Anzeige-Meldung geworden: die Abschnitte gelten nicht mehr
CREATE OR REPLACE FUNCTION public.message_chunks_invalidate()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  DELETE FROM public.message_chunks WHERE message_id = NEW.id;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.message_chunks_invalidate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS message_chunks_invalidate ON public.messages;
CREATE TRIGGER message_chunks_invalidate AFTER UPDATE OF content, metadata ON public.messages
FOR EACH ROW
WHEN (OLD.content IS DISTINCT FROM NEW.content OR (OLD.metadata->>'display_only') IS DISTINCT FROM (NEW.metadata->>'display_only'))
EXECUTE FUNCTION public.message_chunks_invalidate();

-- Alle Abschnitte einer Nachricht ersetzen, atomar. Nur wenn die Datenbank
-- genau p_provider:p_model festhält und keine Umstellung läuft (sonst
-- „gesperrt“, nichts geschrieben) und der Text noch der gelesene ist
-- (p_hash: SHA-256 von content als Hex, sonst „geaendert“). p_chunks:
-- [{chunk_index, content, embedding als Text „[…]“}]
CREATE OR REPLACE FUNCTION public.message_chunks_write(p_message_id bigint, p_provider text, p_model text, p_hash text, p_chunks jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  k text := p_provider || ':' || p_model;
  m_chat text;
  m_content text;
  m_meta jsonb;
  n int;
BEGIN
  -- Reihenfolge wie im Trigger: kein Beginn und kein Umschalten bis zum Ende dieser Transaktion
  PERFORM pg_advisory_xact_lock_shared(hashtext('tybo_embedding_reindex'));
  PERFORM 1 FROM public.embedding_settings WHERE id FOR SHARE;
  IF public.embedding_accepted_key(k) IS DISTINCT FROM k THEN
    RETURN jsonb_build_object('ok', false, 'state', 'gesperrt');
  END IF;
  -- Geteilte Zeilensperre: der Text ändert sich bis zum Ende nicht
  SELECT m.chat_id, m.content, m.metadata INTO m_chat, m_content, m_meta
  FROM public.messages m WHERE m.id = p_message_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'state', 'fehlt');
  END IF;
  IF (m_meta->>'display_only') = 'true' THEN
    RETURN jsonb_build_object('ok', false, 'state', 'anzeige');
  END IF;
  IF encode(sha256(convert_to(m_content, 'UTF8')), 'hex') IS DISTINCT FROM p_hash THEN
    RETURN jsonb_build_object('ok', false, 'state', 'geaendert');
  END IF;
  DELETE FROM public.message_chunks WHERE message_id = p_message_id;
  INSERT INTO public.message_chunks (message_id, chat_id, chunk_index, content, embedding, embedding_model)
  SELECT p_message_id, m_chat, (c->>'chunk_index')::int, c->>'content', (c->>'embedding')::vector, k
  FROM jsonb_array_elements(coalesce(p_chunks, '[]'::jsonb)) c;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'written', n);
END $$;

-- Lange Nachrichten (über 8000 Zeichen, keine Anzeige-Meldung) ohne
-- Abschnitte des festgehaltenen Anbieters, aufsteigend nach id ab p_after_id.
-- Nur ohne Umstellung und nur für genau p_provider:p_model
CREATE OR REPLACE FUNCTION public.message_chunks_pending(p_provider text, p_model text, p_after_id bigint DEFAULT 0, p_limit int DEFAULT 20)
RETURNS TABLE (id bigint)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  k text := p_provider || ':' || p_model;
BEGIN
  IF public.embedding_current_key() IS DISTINCT FROM k THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT m.id FROM public.messages m
  WHERE m.id > coalesce(p_after_id, 0)
    AND length(m.content) > 8000
    AND (m.metadata->>'display_only') IS DISTINCT FROM 'true'
    AND NOT EXISTS (SELECT 1 FROM public.message_chunks c WHERE c.message_id = m.id AND c.embedding_model = k)
  ORDER BY m.id
  LIMIT greatest(1, least(p_limit, 200));
END $$;

-- Stand für tybo suche status: lange Nachrichten, davon mit Abschnitten von p_provider:p_model
CREATE OR REPLACE FUNCTION public.message_chunks_status(p_provider text, p_model text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'long', count(*),
    'done', count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.message_chunks c WHERE c.message_id = m.id AND c.embedding_model = p_provider || ':' || p_model
    )),
    'chunks', (SELECT count(*) FROM public.message_chunks c WHERE c.embedding_model = p_provider || ':' || p_model)
  )
  FROM public.messages m
  WHERE length(m.content) > 8000 AND (m.metadata->>'display_only') IS DISTINCT FROM 'true'
$$;

-- Suche nach Bedeutung in Nachrichten und Abschnitten, mit derselben
-- Prüfung wie match_messages_checked. Jede Nachricht höchstens einmal, mit
-- der besten Ähnlichkeit; content ist bei Treffern aus Abschnitten nur der
-- Abschnitt (chunk_index gesetzt), bei Nachrichten höchstens 8000 Zeichen.
-- content_length: Länge der ganzen Nachricht (für den Ausschnitt in search-memory).
--
-- Für Abschnitte gilt eine um 0,15 niedrigere Schwelle: ein Thema macht in
-- rund 6000 Zeichen oft nur einen Teil aus, die Ähnlichkeit zu einer kurzen
-- Frage liegt darum tiefer. Gemessen mit text-embedding-3-small (15.10.2026):
-- passender Abschnitt 0,40, übrige Abschnitte derselben Nachricht 0,11 bis
-- 0,25, der Absatz allein 0,76. Abschnitt-Treffer stehen so meist hinter
-- starken Treffern ganzer Nachrichten
CREATE OR REPLACE FUNCTION public.match_messages_chunked_checked(
  p_provider text,
  p_model text,
  query_embedding vector(1536),
  filter_chat_id text DEFAULT NULL,
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 5
)
RETURNS TABLE (id bigint, content text, role text, chat_id text, created_at timestamptz, similarity float, chunk_index int, content_length int)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  k text := p_provider || ':' || p_model;
  n int := greatest(1, least(match_count, 200));
  chunk_threshold float := match_threshold - 0.15;
BEGIN
  IF public.embedding_current_key() IS DISTINCT FROM k THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH hits AS (
    -- ganze Nachrichten: dieselbe Suche wie match_messages_checked, daher deren Aufruf
    (SELECT w.id AS mid, left(w.content, 8000) AS body, w.role AS r, w.chat_id AS cid, w.created_at AS at,
            w.similarity AS sim, NULL::int AS idx, length(w.content) AS len
     FROM public.match_messages_checked(p_provider, p_model, query_embedding, filter_chat_id, match_threshold, n) w)
    UNION ALL
    (SELECT c.message_id, c.content, m.role, m.chat_id, m.created_at,
            1 - (c.embedding <=> query_embedding), c.chunk_index, length(m.content)
     FROM public.message_chunks c
     JOIN public.messages m ON m.id = c.message_id
     WHERE c.embedding IS NOT NULL
       AND c.embedding_model = k
       AND (filter_chat_id IS NULL OR c.chat_id = filter_chat_id)
       AND (m.metadata->>'display_only') IS DISTINCT FROM 'true'
       AND 1 - (c.embedding <=> query_embedding) > chunk_threshold
     ORDER BY c.embedding <=> query_embedding
     LIMIT n * 4)
  ), best AS (
    SELECT DISTINCT ON (h.mid) h.mid, h.body, h.r, h.cid, h.at, h.sim, h.idx, h.len
    FROM hits h
    ORDER BY h.mid, h.sim DESC
  )
  SELECT b.mid, b.body, b.r, b.cid, b.at, b.sim, b.idx, b.len
  FROM best b
  ORDER BY b.sim DESC
  LIMIT n;
END $$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.message_chunks_write(bigint, text, text, text, jsonb)',
    'public.message_chunks_pending(text, text, bigint, int)',
    'public.message_chunks_status(text, text)',
    'public.match_messages_chunked_checked(text, text, vector, text, float, int)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

COMMIT;
