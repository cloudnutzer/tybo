-- Fakten nach Bedeutung finden (Issue #523): für die Fakten einer Folgenachricht
-- und für das Nachschlagen. Liefert nur nicht archivierte Fakten, nur ohne
-- Umstellung des Anbieters und nur Vektoren desselben Modells, wie
-- match_messages_checked. p_exclude_ids sind Fakten, die die Session schon kennt;
-- als Text, weil der Datei-Adapter andere Kennungen hat und der Aufrufer sie nur
-- durchreicht.

CREATE OR REPLACE FUNCTION public.match_facts_checked(
  p_provider text,
  p_model text,
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.4,
  match_count int DEFAULT 5,
  p_exclude_ids text[] DEFAULT '{}'
)
RETURNS TABLE (id bigint, content text, created_at timestamptz, revised_at timestamptz, similarity float)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  k text := p_provider || ':' || p_model;
BEGIN
  IF public.embedding_current_key() IS DISTINCT FROM k THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT m.id, m.content, m.created_at, m.revised_at, 1 - (m.embedding <=> query_embedding) AS similarity
  FROM public.memory m
  WHERE m.type = 'fact'
    AND m.archived_at IS NULL
    AND m.embedding IS NOT NULL
    AND m.embedding_model = k
    AND NOT (m.id::text = ANY (coalesce(p_exclude_ids, '{}')))
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT greatest(1, least(match_count, 200));
END $$;

REVOKE ALL ON FUNCTION public.match_facts_checked(text, text, vector, float, int, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_facts_checked(text, text, vector, float, int, text[]) TO service_role;
