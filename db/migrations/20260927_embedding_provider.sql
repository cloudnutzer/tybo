-- Anbieter und Modell der Embeddings je Datenbank (Issue #167).
--
-- Vektoren verschiedener Modelle sind nicht vergleichbar. Darum hält die
-- Datenbank fest, womit ihre Spalten embedding (messages, memory, knowledge,
-- assets) befüllt werden. Bot und Edge Functions lesen vor jedem Embedding
-- embedding_provider_status und schreiben bzw. suchen nur, wenn die eigene
-- Einstellung (EMBEDDING_PROVIDER, EMBEDDING_MODEL) dazu passt. Nach dem
-- ersten gelungenen Embedding halten sie mit claim_embedding_provider fest.
--
-- Zustände der einen Zeile:
-- - festgehalten: Anbieter und Modell stehen fest (erstes gelungenes
--   Embedding auf einer Datenbank ohne Vektoren).
-- - altbestand: bei der ersten Nutzung lagen schon Vektoren ohne Kennung vor
--   (Installationen vor #167). Sie werden nicht umgedeutet; weiter passt nur
--   das Verhalten vor #167 (OpenAI text-embedding-3-small).
-- Keine Zeile: noch nie genutzt.
--
-- Wiederholbar (IF NOT EXISTS, CREATE OR REPLACE).
BEGIN;

CREATE TABLE IF NOT EXISTS public.embedding_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  state text NOT NULL CHECK (state IN ('festgehalten','altbestand')),
  provider text CHECK (provider IN ('openai','gemini','ollama')),
  model text CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  dimensions int NOT NULL DEFAULT 1536 CHECK (dimensions = 1536),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'festgehalten') = (provider IS NOT NULL AND model IS NOT NULL))
);

-- Nur der Server (service_role) liest und schreibt
ALTER TABLE public.embedding_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.embedding_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.embedding_settings TO service_role;

-- Gibt es irgendwo schon Vektoren? Fehlende Tabellen oder Spalten zählen nicht
CREATE OR REPLACE FUNCTION public.embedding_vectors_exist()
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  tab text;
  found boolean;
BEGIN
  FOREACH tab IN ARRAY ARRAY['messages','memory','knowledge','assets'] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = tab AND column_name = 'embedding'
    ) THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE embedding IS NOT NULL)', tab) INTO found;
      IF found THEN
        RETURN true;
      END IF;
    END IF;
  END LOOP;
  RETURN false;
END $$;

-- Nur lesen: Zustand für Start und Prüfung, ohne etwas festzuhalten
CREATE OR REPLACE FUNCTION public.embedding_provider_status()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  s public.embedding_settings%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.embedding_settings WHERE id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'leer', 'vectors', public.embedding_vectors_exist());
  END IF;
  RETURN jsonb_build_object('state', s.state, 'provider', s.provider, 'model', s.model);
END $$;

-- Festhalten nach dem ersten gelungenen Embedding, atomar: parallele Aufrufe warten auf die
-- Sperre und bekommen danach alle dieselbe Zeile zurück
CREATE OR REPLACE FUNCTION public.claim_embedding_provider(p_provider text, p_model text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  s public.embedding_settings%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.embedding_settings WHERE id;
  IF NOT FOUND THEN
    PERFORM pg_advisory_xact_lock(hashtext('tybo_embedding_settings'));
    SELECT * INTO s FROM public.embedding_settings WHERE id;
    IF NOT FOUND THEN
      IF public.embedding_vectors_exist() THEN
        INSERT INTO public.embedding_settings (id, state) VALUES (true, 'altbestand')
        ON CONFLICT (id) DO NOTHING;
      ELSE
        INSERT INTO public.embedding_settings (id, state, provider, model) VALUES (true, 'festgehalten', p_provider, p_model)
        ON CONFLICT (id) DO NOTHING;
      END IF;
      SELECT * INTO s FROM public.embedding_settings WHERE id;
    END IF;
  END IF;
  RETURN jsonb_build_object('state', s.state, 'provider', s.provider, 'model', s.model);
END $$;

REVOKE ALL ON FUNCTION public.embedding_vectors_exist() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.embedding_provider_status() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_embedding_provider(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.embedding_vectors_exist() TO service_role;
GRANT EXECUTE ON FUNCTION public.embedding_provider_status() TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_embedding_provider(text, text) TO service_role;

COMMIT;
