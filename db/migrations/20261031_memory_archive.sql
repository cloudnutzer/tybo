-- Archiv für Fakten (Issue #520). Archivierte Fakten bleiben in memory, kommen
-- aber in keinen Prompt und keine Suche und lassen sich zurückholen.
--
-- embedding_fact_vectors liefert nur noch nicht archivierte Fakten. Den Vektor
-- behält ein archivierter Fakt, er gilt nach dem Zurückholen wieder; eine
-- Umstellung des Anbieters rechnet ihn wie jeden Fakt mit neu.
--
-- revised_at setzen nur Umschreiben und Zurückholen: Daran erkennt das Delta
-- fortgesetzter Sessions geänderte Fakten. updated_at taugt dafür nicht, es
-- steht bei importierten Zeilen auf dem Zeitpunkt des Imports.

ALTER TABLE public.memory ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.memory ADD COLUMN IF NOT EXISTS revised_at timestamptz;

CREATE OR REPLACE FUNCTION public.embedding_fact_vectors(p_provider text, p_model text)
RETURNS TABLE (id bigint, embedding vector(1536))
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  k text := p_provider || ':' || p_model;
BEGIN
  IF public.embedding_current_key() IS DISTINCT FROM k THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT m.id, m.embedding FROM public.memory m
  WHERE m.type = 'fact' AND m.archived_at IS NULL AND m.embedding IS NOT NULL AND m.embedding_model = k;
END $$;
