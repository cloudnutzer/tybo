-- Wissensbasis (Issue #317): geprüfte Bedeutungssuche und der Kontext für
-- den Prompt in einem einzigen Aufruf.
--
-- match_knowledge_checked sucht nach Bedeutung wie match_messages_checked:
-- nur wenn keine Umstellung läuft und die Datenbank genau Anbieter und Modell
-- des Suchvektors festhält (embedding_current_key), und nur in Zeilen mit
-- demselben embedding_model. Das alte match_knowledge ohne Angabe bleibt für
-- ältere Aufrufer unverändert.
--
-- knowledge_context liefert in einer Antwort, was der Prompt braucht:
-- - je Vorrang-Kategorie (project, decision, preference) die neuesten
--   Einträge (Spalte reason = 'priority'),
-- - Treffer nach Bedeutung (reason = 'semantic'), wenn ein passender
--   Suchvektor mitkommt,
-- - sonst Treffer nach Text (reason = 'text'): Titel oder Inhalt enthalten
--   ein Suchwort (ILIKE, %, _ und \ wörtlich) oder ein Schlagwort gleicht ihm.
-- Ohne Suchwörter gibt es keine Texttreffer, nie eine unbegrenzte Menge.
-- Archivierte, ersetzte und abgelaufene Einträge bleiben überall draußen.
-- Die Antwort ist nach stage sortiert; doppelte Einträge entfernt der Bot.
--
-- Wiederholbar (CREATE OR REPLACE).
BEGIN;

CREATE OR REPLACE FUNCTION public.match_knowledge_checked(
  p_provider text,
  p_model text,
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 5,
  p_category text DEFAULT NULL
)
RETURNS TABLE (id uuid, category text, title text, content text, related_project text, tags text[], updated_at timestamptz, similarity float)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  wanted text := p_provider || ':' || p_model;
BEGIN
  IF query_embedding IS NULL OR wanted IS NULL OR public.embedding_current_key() IS DISTINCT FROM wanted THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT k.id, k.category, k.title, k.content, k.related_project, k.tags, k.updated_at,
         1 - (k.embedding <=> query_embedding) AS similarity
  FROM public.knowledge k
  WHERE k.status = 'active' AND k.superseded_by IS NULL
    AND (k.expires_at IS NULL OR k.expires_at > now())
    AND k.embedding IS NOT NULL
    AND k.embedding_model = wanted
    AND (p_category IS NULL OR k.category = p_category)
    AND 1 - (k.embedding <=> query_embedding) > match_threshold
  ORDER BY k.embedding <=> query_embedding
  LIMIT greatest(1, least(match_count, 50));
END $$;

REVOKE ALL ON FUNCTION public.match_knowledge_checked(text, text, vector, float, int, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_knowledge_checked(text, text, vector, float, int, text) TO service_role;

CREATE OR REPLACE FUNCTION public.knowledge_context(
  p_terms text[] DEFAULT '{}',
  p_provider text DEFAULT NULL,
  p_model text DEFAULT NULL,
  query_embedding vector(1536) DEFAULT NULL,
  p_per_category int DEFAULT 3,
  p_per_term int DEFAULT 3,
  p_matches int DEFAULT 5,
  match_threshold float DEFAULT 0.7
)
RETURNS TABLE (id uuid, category text, title text, content text, related_project text, updated_at timestamptz, reason text, similarity float, stage int)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  WITH live AS (
    SELECT k.id, k.category, k.title, k.content, k.related_project, k.tags, k.updated_at
    FROM public.knowledge k
    WHERE k.status = 'active' AND k.superseded_by IS NULL
      AND (k.expires_at IS NULL OR k.expires_at > now())
  ),
  priority AS (
    SELECT l.*, array_position(ARRAY['project', 'decision', 'preference'], l.category) AS grp,
           row_number() OVER (PARTITION BY l.category ORDER BY l.updated_at DESC, l.id) AS nth
    FROM live l
    WHERE l.category IN ('project', 'decision', 'preference')
  ),
  semantic AS (
    SELECT m.*, row_number() OVER (ORDER BY m.similarity DESC, m.id) AS nth
    FROM public.match_knowledge_checked(p_provider, p_model, query_embedding, match_threshold, least(greatest(p_matches, 1), 20)) m
  ),
  words AS (
    SELECT w.term, w.pos,
           '%' || replace(replace(replace(w.term, '\', '\\'), '%', '\%'), '_', '\_') || '%' AS pattern
    FROM unnest(coalesce(p_terms, '{}')) WITH ORDINALITY AS w(term, pos)
    WHERE w.pos <= 5 AND length(trim(w.term)) > 0
  ),
  textual AS (
    SELECT l.*, w.pos,
           row_number() OVER (PARTITION BY w.pos ORDER BY l.updated_at DESC, l.id) AS nth
    FROM live l
    JOIN words w ON l.title ILIKE w.pattern OR l.content ILIKE w.pattern
                 OR EXISTS (SELECT 1 FROM unnest(l.tags) t WHERE lower(t) = lower(w.term))
    WHERE NOT EXISTS (SELECT 1 FROM semantic)
  ),
  picked AS (
    SELECT p.id, p.category, p.title, p.content, p.related_project, p.updated_at, 'priority'::text AS reason,
           NULL::float AS similarity, 1 AS stage, p.grp::bigint AS a, p.nth AS b
    FROM priority p WHERE p.nth <= least(greatest(p_per_category, 0), 10)
    UNION ALL
    SELECT s.id, s.category, s.title, s.content, s.related_project, s.updated_at, 'semantic', s.similarity, 2, 0, s.nth
    FROM semantic s
    UNION ALL
    SELECT t.id, t.category, t.title, t.content, t.related_project, t.updated_at, 'text', NULL, 3, t.pos, t.nth
    FROM textual t WHERE t.nth <= least(greatest(p_per_term, 0), 10)
  )
  SELECT picked.id, picked.category, picked.title, picked.content, picked.related_project, picked.updated_at,
         picked.reason, picked.similarity, picked.stage
  FROM picked
  ORDER BY picked.stage, picked.a, picked.b
$$;

REVOKE ALL ON FUNCTION public.knowledge_context(text[], text, text, vector, int, int, int, float) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.knowledge_context(text[], text, text, vector, int, int, int, float) TO service_role;

COMMIT;
