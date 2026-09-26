BEGIN;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS public.knowledge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  category text NOT NULL CHECK (category IN ('project','person','preference','learning','process','decision','reference','tool')),
  title text NOT NULL,
  content text NOT NULL,
  source text,
  related_project text,
  related_entities text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  confidence double precision NOT NULL DEFAULT 1,
  expires_at timestamptz,
  superseded_by uuid REFERENCES public.knowledge(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  metadata jsonb NOT NULL DEFAULT '{}',
  embedding vector(1536)
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_category_title_unique ON public.knowledge(category,title);
CREATE INDEX IF NOT EXISTS knowledge_status_updated ON public.knowledge(status,updated_at DESC);

-- Personal data is only accessible by the server; service_role bypasses RLS.
DO $$
DECLARE tab text; pol record;
BEGIN
  FOREACH tab IN ARRAY ARRAY['messages','memory','logs','async_tasks','node_heartbeat','assets','knowledge','call_transcripts'] LOOP
    IF to_regclass('public.' || tab) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tab);
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', tab);
      EXECUTE format('GRANT ALL ON public.%I TO service_role', tab);
      FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=tab LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, tab);
      END LOOP;
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.match_knowledge(query_embedding vector(1536), match_threshold float DEFAULT 0.7, match_count int DEFAULT 5)
RETURNS TABLE(id uuid, title text, content text, category text, similarity float)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$ SELECT k.id,k.title,k.content,k.category,1-(k.embedding <=> query_embedding)
FROM knowledge k WHERE k.status='active' AND k.superseded_by IS NULL
AND (k.expires_at IS NULL OR k.expires_at>now()) AND k.embedding IS NOT NULL
AND 1-(k.embedding <=> query_embedding)>match_threshold
ORDER BY k.embedding <=> query_embedding LIMIT greatest(1,least(match_count,50)) $$;
REVOKE ALL ON FUNCTION public.match_knowledge(vector,float,int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_knowledge(vector,float,int) TO service_role;

-- Buckets are private; application generates short-lived download URLs.
-- Other bucket name: create it in the dashboard (private) and set SUPABASE_ASSETS_BUCKET.
INSERT INTO storage.buckets(id,name,public) VALUES ('tybo-assets','tybo-assets',false)
ON CONFLICT(id) DO UPDATE SET public=false;
COMMIT;
