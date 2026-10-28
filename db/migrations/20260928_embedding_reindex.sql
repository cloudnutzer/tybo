-- Neuberechnung der Embeddings nach einem Anbieterwechsel (Issue #168).
--
-- Vektoren verschiedener Modelle sind nicht vergleichbar. Wechselt der
-- Anbieter oder das Modell, rechnet `tybo suche neu-berechnen` alle Zeilen der
-- Spalten embedding (messages, memory, knowledge, assets) neu.
--
-- Trennung der Anbieter, geprüft beim tatsächlichen Schreiben und Vergleichen
-- (nicht über Wartezeiten oder zwischengespeicherte Freigaben):
--
-- Zwei Stände entscheiden, ob ein Ergebnis noch gilt; beide führt die
-- Datenbank selbst, keiner wird aus Zeileninhalt oder Standardwerten erraten:
--
-- - Herkunft: jede Zeile trägt in embedding_model, womit ihr Vektor entstand
--   („anbieter:modell“). Schreiber und Suchen geben das an; geprüft wird nur
--   diese Angabe (embedding_accepted_key). Beim UPDATE zählt nur eine Angabe
--   in SET (embedding_reindex_declared), nie die Kennung, die die Zeile schon
--   trägt. Ohne Angabe gilt das Verhalten vor der Anbieterwahl (OpenAI
--   text-embedding-3-small) nur, solange die Datenbank nie umgeschaltet hat
--   (embedding_settings.generation = 0): danach kann ein Vektor ohne Angabe
--   von jedem früheren Anbieter stammen, auch nach einem Wechsel zurück.
-- - Inhalt: die seq einer vorgemerkten Zeile (embedding_reindex_queue) ist
--   ihr Stand; jede Änderung ihres Textes vergibt eine neue. Nachzug und
--   Neuberechnung schreiben ein Ergebnis nur, wenn der Stand beim Schreiben
--   noch der gelesene ist (embedding_row_current, unter Zeilensperre).
--   Beide wenden ein Ergebnis über dieselbe Funktion an
--   (embedding_apply_result): der Vektor ist danach genau das Ergebnis, auch
--   NULL für Anzeige-Meldungen, leere Texte und Ablehnungen.
-- - Ein Trigger je Tabelle (embedding_reindex_guard) prüft jedes Schreiben:
--   Läuft eine Umstellung, wird ein fremd geschriebener Vektor NULL und die
--   Zeile vorgemerkt (embedding_reindex_queue). Sonst bleibt ein Vektor nur,
--   wenn seine Angabe dem gilt, was die Datenbank festhält
--   (embedding_current_key). Ein verspäteter Schreiber mit dem alten Anbieter
--   ändert bei unverändertem Text nichts (der gültige Vektor bleibt); bei
--   neuem oder geändertem Text wird die Zeile ohne Vektor vorgemerkt und
--   außerhalb einer Umstellung nachgezogen (embedding_queue_write, drainQueue
--   im Bot). Nur die Neuberechnung selbst schreibt ohne diese Prüfung
--   (embedding_reindex_write setzt tybo.embedding_reindex für die eigene
--   Transaktion).
-- - Jeder Schreiber hält im Trigger bis zum Ende seiner Transaktion eine
--   gemeinsame Sperre (Advisory Lock tybo_embedding_reindex), auch wenn noch
--   kein Lauf existiert; Beginn und Umschalten nehmen sie exklusiv. Eine vor
--   dem Beginn offene Schreibtransaktion ist also bestätigt, bevor der Lauf
--   entsteht, und der Hauptdurchgang sieht ihre Zeilen.
-- - Gesucht wird mit Angabe von Anbieter und Modell des Suchvektors
--   (match_messages_checked, embedding_fact_vectors für das Ranking der Fakten
--   im Bot). Beide liefern nur etwas, wenn keine Umstellung läuft und die
--   Datenbank genau diesen Anbieter festhält, und nur Zeilen mit demselben
--   embedding_model. match_messages, match_assets und match_knowledge ohne
--   Angabe (ältere Functions) gelten nur für das Verhalten vor der Anbieterwahl.
--   Während einer Umstellung gibt es also keine semantische Suche, auch nicht
--   für Prozesse mit zwischengespeicherter Freigabe.
-- - embedding_provider_status und claim_embedding_provider melden
--   „umstellung“ mit dem Ziel; Bot und Edge Functions erzeugen dann kein
--   Embedding mehr.
--
-- Ablauf der Neuberechnung:
--
-- - embedding_reindex_start beginnt bzw. reserviert den Lauf atomar, vor jeder
--   Änderung an Functions, Geheimnissen und .env: hält ein anderer Prozess
--   einen Lauf auf ein anderes Ziel, lautet die Antwort „belegt“ und nichts
--   ändert sich.
-- - Ein Lauf gehört einem Prozess (holder, lease_until); der Prozess verlängert
--   die Frist laufend, ein zweiter wartet, bis sie abläuft.
-- - Neue Vektoren entstehen erst ab write_after (sechs Minuten nach dem
--   Beginn); das ist nur noch eine Schonfrist, die Trennung hängt nicht daran.
-- - Fortschritt je Lauf und Tabelle (letzte bestätigte ID) im selben Aufruf
--   wie das Schreiben: ein Abbruch setzt beim nächsten Stapel fort.
-- - Texte, die der Anbieter ablehnt, bleiben als „failed“ vorgemerkt: kein
--   Umschalten, bis sie gerechnet sind; ein neuer Lauf (neuer Inhaber)
--   versucht sie erneut.
-- - embedding_reindex_finish schaltet erst um, wenn alle Tabellen durch sind,
--   jeder Vektor das Ziel als embedding_model trägt und die Warteschlange leer
--   ist. Die exklusive Sperre wartet auf Schreiber, die gerade im Trigger sind.
--
-- Nur für Supabase; Convex bleibt unverändert. Wiederholbar (IF NOT EXISTS,
-- CREATE OR REPLACE).
BEGIN;

CREATE TABLE IF NOT EXISTS public.embedding_reindex (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  run_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('openai','gemini','ollama')),
  model text NOT NULL CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  started_at timestamptz NOT NULL DEFAULT now(),
  write_after timestamptz NOT NULL,
  holder text CHECK (holder IS NULL OR length(holder) <= 200),
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.embedding_reindex_progress (
  run_id uuid NOT NULL,
  tab text NOT NULL CHECK (tab IN ('messages','memory','knowledge','assets')),
  last_id text,
  done bigint NOT NULL DEFAULT 0,
  finished boolean NOT NULL DEFAULT false,
  PRIMARY KEY (run_id, tab)
);

CREATE SEQUENCE IF NOT EXISTS public.embedding_reindex_seq;

CREATE TABLE IF NOT EXISTS public.embedding_reindex_queue (
  tab text NOT NULL CHECK (tab IN ('messages','memory','knowledge','assets')),
  row_id text NOT NULL,
  seq bigint NOT NULL,
  -- vom Anbieter abgelehnt: in diesem Lauf nicht erneut, aber kein Umschalten
  failed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tab, row_id)
);
ALTER TABLE public.embedding_reindex_queue ADD COLUMN IF NOT EXISTS failed boolean NOT NULL DEFAULT false;

-- Nur der Server (service_role) liest und schreibt
DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['embedding_reindex','embedding_reindex_progress','embedding_reindex_queue'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', tab);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', tab);
  END LOOP;
END $$;
REVOKE ALL ON SEQUENCE public.embedding_reindex_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.embedding_reindex_seq TO service_role;

-- Womit der Vektor einer Zeile entstand, „anbieter:modell“
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['messages','memory','knowledge','assets'] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'embedding'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS embedding_model text CHECK (embedding_model IS NULL OR embedding_model ~ ''^(openai|gemini|ollama):[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'')', t);
    END IF;
  END LOOP;
END $$;

-- Wie oft die Datenbank schon umgeschaltet hat (embedding_reindex_finish).
-- Nur bei 0 kann ein Vektor ohne Angabe noch sicher aus dem Verhalten vor der
-- Anbieterwahl stammen (embedding_accepted_key)
ALTER TABLE public.embedding_settings ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 0;

-- Das Verhalten vor der Anbieterwahl (Issue #167)
CREATE OR REPLACE FUNCTION public.embedding_legacy_key()
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public
AS $$ SELECT 'openai:text-embedding-3-small'::text $$;

-- Womit gerade geschrieben und gesucht werden darf; NULL während einer Umstellung.
-- Festgehalten: dieser Anbieter; noch nichts oder Altbestand: das Verhalten vor der Anbieterwahl
CREATE OR REPLACE FUNCTION public.embedding_current_key()
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  s public.embedding_settings%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM public.embedding_reindex WHERE id) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO s FROM public.embedding_settings WHERE id;
  IF FOUND AND s.state = 'festgehalten' THEN
    RETURN s.provider || ':' || s.model;
  END IF;
  RETURN public.embedding_legacy_key();
END $$;

-- Herkunft eines Vektors (beim Schreiben) bzw. Suchvektors (beim Suchen)
-- prüfen: die Kennung, die er bekommt, oder NULL, wenn er nicht zu dem passt,
-- was die Datenbank gerade festhält. Mit Angabe nur genau die festgehaltene.
-- Ohne Angabe (Schreiber und Suchen von vor #168) nur, solange die Datenbank
-- nie umgeschaltet hat und das Verhalten vor der Anbieterwahl gilt: nach einem
-- Wechsel, auch zurück auf OpenAI, kann ein Vektor ohne Angabe von jedem
-- früheren Anbieter stammen
CREATE OR REPLACE FUNCTION public.embedding_accepted_key(p_declared text)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  current_key text := public.embedding_current_key();
BEGIN
  IF current_key IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_declared IS NOT NULL THEN
    RETURN CASE WHEN p_declared = current_key THEN current_key END;
  END IF;
  IF current_key = public.embedding_legacy_key()
     AND coalesce((SELECT s.generation FROM public.embedding_settings s WHERE s.id), 0) = 0 THEN
    RETURN current_key;
  END IF;
  RETURN NULL;
END $$;

-- Angabe beim UPDATE: nur was dieser Schreibvorgang in SET nennt, zählt als
-- Herkunft. Läuft vor embedding_reindex_guard (Trigger in Namensreihenfolge)
-- und markiert den Wert; ohne Nennung steht in NEW nur die Kennung der Zeile,
-- und die ist kein Nachweis für einen neuen Vektor
CREATE OR REPLACE FUNCTION public.embedding_reindex_declared()
RETURNS trigger
LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  NEW.embedding_model := '!' || coalesce(NEW.embedding_model, '');
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.embedding_reindex_declared() FROM PUBLIC, anon, authenticated;

-- Trigger: jedes fremde Schreiben prüfen. TG_ARGV: die Spalten, aus denen der
-- Text für das Embedding entsteht
CREATE OR REPLACE FUNCTION public.embedding_reindex_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  r public.embedding_reindex%ROWTYPE;
  k text;
  new_row jsonb;
  old_row jsonb;
  text_changed boolean := false;
  vector_set boolean := false;
  allowed text;
  declared text;
BEGIN
  -- Gemeinsame Sperre bis zum Ende der Transaktion, auch wenn noch kein Lauf
  -- existiert: Beginn und Umschalten (exklusiv) warten auf jeden Schreiber,
  -- der den Trigger schon passiert hat. Danach frisch lesen (READ COMMITTED)
  PERFORM pg_advisory_xact_lock_shared(hashtext('tybo_embedding_reindex'));
  -- Herkunft dieses Schreibvorgangs: INSERT nennt sie, UPDATE nur mit
  -- embedding_model in SET (embedding_reindex_declared)
  IF TG_OP = 'INSERT' THEN
    declared := NEW.embedding_model;
  ELSIF left(NEW.embedding_model, 1) = '!' THEN
    declared := nullif(substr(NEW.embedding_model, 2), '');
  END IF;
  SELECT * INTO r FROM public.embedding_reindex WHERE id FOR SHARE;
  IF FOUND AND current_setting('tybo.embedding_reindex', true) = r.run_id::text THEN
    NEW.embedding_model := declared;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    text_changed := true;
    vector_set := NEW.embedding IS NOT NULL;
  ELSE
    vector_set := NEW.embedding IS NOT NULL AND NEW.embedding IS DISTINCT FROM OLD.embedding;
    new_row := to_jsonb(NEW) - 'embedding' - 'embedding_model';
    old_row := to_jsonb(OLD) - 'embedding' - 'embedding_model';
    FOREACH k IN ARRAY TG_ARGV LOOP
      IF (new_row -> k) IS DISTINCT FROM (old_row -> k) THEN
        text_changed := true;
      END IF;
    END LOOP;
  END IF;

  IF r.id IS NOT NULL THEN
    -- Umstellung: fremde Vektoren nie, geänderte Zeilen vormerken
    IF text_changed OR vector_set THEN
      NEW.embedding := NULL;
      NEW.embedding_model := NULL;
      INSERT INTO public.embedding_reindex_queue (tab, row_id, seq)
      VALUES (TG_TABLE_NAME, NEW.id::text, nextval('public.embedding_reindex_seq'))
      ON CONFLICT (tab, row_id) DO UPDATE SET seq = EXCLUDED.seq, failed = false;
    ELSIF TG_OP = 'UPDATE' THEN
      NEW.embedding := OLD.embedding;
      NEW.embedding_model := OLD.embedding_model;
    END IF;
    RETURN NEW;
  END IF;

  IF vector_set THEN
    -- Geteilte Sperre: Festhalten und Umschalten ändern die Kennung erst nach diesem Schreiber
    PERFORM 1 FROM public.embedding_settings WHERE id FOR SHARE;
    allowed := public.embedding_accepted_key(declared);
    IF allowed IS NOT NULL THEN
      NEW.embedding_model := allowed;
    ELSIF TG_OP = 'UPDATE' AND NOT text_changed THEN
      -- Fremder Vektor für unveränderten Text (verspäteter Schreiber): die
      -- Zeile bleibt, wie sie war, ein gültiger Zielvektor also erhalten
      NEW.embedding := OLD.embedding;
      NEW.embedding_model := OLD.embedding_model;
    ELSE
      -- Fremder Vektor für neuen oder geänderten Text: ohne Vektor und
      -- vorgemerkt; drainQueue (src/lib/embedding-reindex.ts) zieht nach
      NEW.embedding := NULL;
      NEW.embedding_model := NULL;
      INSERT INTO public.embedding_reindex_queue (tab, row_id, seq)
      VALUES (TG_TABLE_NAME, NEW.id::text, nextval('public.embedding_reindex_seq'))
      ON CONFLICT (tab, row_id) DO UPDATE SET seq = EXCLUDED.seq, failed = false;
      RETURN NEW;
    END IF;
  ELSIF NEW.embedding IS NULL THEN
    NEW.embedding_model := NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Vektor unverändert: die Angabe bleibt, wie sie war
    NEW.embedding_model := OLD.embedding_model;
  END IF;
  IF text_changed AND TG_OP = 'UPDATE' THEN
    -- Die seq ist der Stand einer vorgemerkten Zeile: jede Änderung ihres
    -- Textes, auch mit gültigem oder ganz ohne Vektor, macht eine Berechnung
    -- ungültig, die den alten Text gelesen hat (embedding_queue_write und
    -- embedding_reindex_write schreiben nur bei gleicher seq)
    UPDATE public.embedding_reindex_queue
    SET seq = nextval('public.embedding_reindex_seq'), failed = false
    WHERE tab = TG_TABLE_NAME AND row_id = NEW.id::text;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.embedding_reindex_guard() FROM PUBLIC, anon, authenticated;

-- Trigger neu anlegen; vorhandene Vektoren ohne Angabe vorher kennzeichnen
-- (nur ohne laufende Umstellung: dann gilt jeder vorhandene Vektor für den
-- festgehaltenen Anbieter bzw. das Verhalten vor der Anbieterwahl; während
-- einer Umstellung bleiben sie ohne Angabe und damit aus jeder Suche heraus)
DO $$
DECLARE
  t text;
  cols text;
  current_key text := public.embedding_current_key();
BEGIN
  -- Vorhandene Vektoren stammen vom festgehaltenen Anbieter nur, solange die
  -- Datenbank nie umgeschaltet hat; danach wird keiner ohne Angabe umgedeutet
  IF coalesce((SELECT s.generation FROM public.embedding_settings s WHERE s.id), 0) > 0 THEN
    current_key := NULL;
  END IF;
  FOR t, cols IN SELECT * FROM (VALUES
    ('messages', '''content'', ''metadata'''),
    ('memory', '''content'', ''type'''),
    ('knowledge', '''title'', ''content'''),
    ('assets', '''description'', ''tags''')
  ) AS v(t, c) LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'embedding'
    ) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS embedding_reindex_declared ON public.%I', t);
      EXECUTE format('DROP TRIGGER IF EXISTS embedding_reindex_guard ON public.%I', t);
      IF current_key IS NOT NULL THEN
        EXECUTE format('UPDATE public.%I SET embedding_model = %L WHERE embedding IS NOT NULL AND embedding_model IS NULL', t, current_key);
      END IF;
      EXECUTE format('CREATE TRIGGER embedding_reindex_declared BEFORE UPDATE OF embedding_model ON public.%I FOR EACH ROW EXECUTE FUNCTION public.embedding_reindex_declared()', t);
      EXECUTE format('CREATE TRIGGER embedding_reindex_guard BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.embedding_reindex_guard(%s)', t, cols);
    END IF;
  END LOOP;
END $$;

-- Status wie 20260927_embedding_provider.sql, dazu „umstellung“
CREATE OR REPLACE FUNCTION public.embedding_provider_status()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  s public.embedding_settings%ROWTYPE;
  r public.embedding_reindex%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.embedding_reindex WHERE id;
  IF FOUND THEN
    RETURN jsonb_build_object('state', 'umstellung', 'provider', r.provider, 'model', r.model);
  END IF;
  SELECT * INTO s FROM public.embedding_settings WHERE id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'leer', 'vectors', public.embedding_vectors_exist());
  END IF;
  RETURN jsonb_build_object('state', s.state, 'provider', s.provider, 'model', s.model);
END $$;

-- Festhalten wie 20260927_embedding_provider.sql; während einer Umstellung nie
CREATE OR REPLACE FUNCTION public.claim_embedding_provider(p_provider text, p_model text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  s public.embedding_settings%ROWTYPE;
  r public.embedding_reindex%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tybo_embedding_settings'));
  SELECT * INTO r FROM public.embedding_reindex WHERE id;
  IF FOUND THEN
    RETURN jsonb_build_object('state', 'umstellung', 'provider', r.provider, 'model', r.model);
  END IF;
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
  RETURN jsonb_build_object('state', s.state, 'provider', s.provider, 'model', s.model);
END $$;

-- Suche nach Bedeutung mit Angabe, womit der Suchvektor entstand. Nur ohne
-- Umstellung, nur wenn die Datenbank genau das festhält, nur Zeilen mit
-- demselben embedding_model. STABLE: Prüfung und Suche sehen denselben Stand
CREATE OR REPLACE FUNCTION public.match_messages_checked(
  p_provider text,
  p_model text,
  query_embedding vector(1536),
  filter_chat_id text DEFAULT NULL,
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 5
)
RETURNS TABLE (id bigint, content text, role text, chat_id text, created_at timestamptz, similarity float)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  k text := p_provider || ':' || p_model;
BEGIN
  IF public.embedding_current_key() IS DISTINCT FROM k THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT m.id, m.content, m.role, m.chat_id, m.created_at, 1 - (m.embedding <=> query_embedding) AS similarity
  FROM public.messages m
  WHERE m.embedding IS NOT NULL
    AND m.embedding_model = k
    AND (filter_chat_id IS NULL OR m.chat_id = filter_chat_id)
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT greatest(1, least(match_count, 200));
END $$;

-- Vektoren der Fakten für das Ranking im Bot, mit derselben Prüfung
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
  WHERE m.type = 'fact' AND m.embedding IS NOT NULL AND m.embedding_model = k;
END $$;

-- Ältere Aufrufer ohne Angabe (Functions von vor der Anbieterwahl): nur das
-- Verhalten vor der Anbieterwahl, mit derselben Prüfung
CREATE OR REPLACE FUNCTION public.match_messages(
  query_embedding vector(1536),
  filter_chat_id text DEFAULT NULL,
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 5
)
RETURNS TABLE (id bigint, content text, role text, chat_id text, created_at timestamptz, similarity float)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public
AS $$
BEGIN
  IF public.embedding_accepted_key(NULL) IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM public.match_messages_checked('openai', 'text-embedding-3-small', query_embedding, filter_chat_id, match_threshold, match_count);
END $$;

DO $$
BEGIN
  IF to_regclass('public.assets') IS NOT NULL AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'assets' AND column_name = 'embedding_model'
  ) THEN
    EXECUTE $f$
      CREATE OR REPLACE FUNCTION public.match_assets(
        query_embedding vector(1536),
        match_threshold float DEFAULT 0.7,
        match_count int DEFAULT 5
      )
      RETURNS TABLE (id uuid, description text, tags text[], file_type text, public_url text, created_at timestamptz, similarity float)
      LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public
      AS $b$
      BEGIN
        IF public.embedding_accepted_key(NULL) IS NULL THEN
          RETURN;
        END IF;
        RETURN QUERY
        SELECT a.id, a.description, a.tags, a.file_type, a.public_url, a.created_at, 1 - (a.embedding <=> query_embedding) AS similarity
        FROM public.assets a
        WHERE a.embedding IS NOT NULL
          AND a.embedding_model = public.embedding_legacy_key()
          AND 1 - (a.embedding <=> query_embedding) > match_threshold
        ORDER BY a.embedding <=> query_embedding
        LIMIT match_count;
      END $b$
    $f$;
  END IF;
  IF to_regclass('public.knowledge') IS NOT NULL THEN
    EXECUTE $f$
      CREATE OR REPLACE FUNCTION public.match_knowledge(query_embedding vector(1536), match_threshold float DEFAULT 0.7, match_count int DEFAULT 5)
      RETURNS TABLE (id uuid, title text, content text, category text, similarity float)
      LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public
      AS $b$
      BEGIN
        IF public.embedding_accepted_key(NULL) IS NULL THEN
          RETURN;
        END IF;
        RETURN QUERY
        SELECT k.id, k.title, k.content, k.category, 1 - (k.embedding <=> query_embedding)
        FROM public.knowledge k
        WHERE k.status = 'active' AND k.superseded_by IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > now()) AND k.embedding IS NOT NULL
          AND k.embedding_model = public.embedding_legacy_key()
          AND 1 - (k.embedding <=> query_embedding) > match_threshold
        ORDER BY k.embedding <=> query_embedding
        LIMIT greatest(1, least(match_count, 50));
      END $b$
    $f$;
    REVOKE ALL ON FUNCTION public.match_knowledge(vector, float, int) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.match_knowledge(vector, float, int) TO service_role;
  END IF;
END $$;

-- Umfang für die Rückfrage: Zeilen mit Text und Zeichen, nach denselben Regeln
-- wie die Schreiber (src/lib/embedding-reindex.ts, REINDEX_TABLES)
CREATE OR REPLACE FUNCTION public.embedding_reindex_estimate()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'messages', (SELECT jsonb_build_object('rows', count(*), 'chars', coalesce(sum(length(content)), 0))
      FROM public.messages WHERE content <> '' AND (metadata->>'display_only') IS DISTINCT FROM 'true'),
    'memory', (SELECT jsonb_build_object('rows', count(*), 'chars', coalesce(sum(least(length(content), 8000)), 0))
      FROM public.memory WHERE type = 'fact' AND content <> ''),
    'knowledge', (SELECT jsonb_build_object('rows', count(*), 'chars', coalesce(sum(length(title) + 2 + length(content)), 0))
      FROM public.knowledge),
    'assets', (SELECT jsonb_build_object('rows', count(*), 'chars', coalesce(sum(length(description) + 1 + length(array_to_string(tags, ' '))), 0))
      FROM public.assets WHERE description <> '')
  )
$$;

-- Frühere Fassung ohne Inhaber
DROP FUNCTION IF EXISTS public.embedding_reindex_start(text, text);

-- Lauf beginnen bzw. reservieren, atomar vor jeder Änderung an der
-- Konfiguration. Gleiches Ziel: der vorhandene Lauf (fortsetzen; active:
-- gerade hält ihn ein anderer). Anderes Ziel: nur, wenn gerade niemand
-- anderes ihn hält; dann von vorn. Schon festgehalten auf dem Ziel: nichts zu
-- tun. p_seconds > 0: der Aufrufer hält den Lauf so lange (Übergabe an den
-- Prozess, der rechnet, mit demselben Inhaber)
CREATE OR REPLACE FUNCTION public.embedding_reindex_start(p_provider text, p_model text, p_holder text DEFAULT NULL, p_seconds int DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  r public.embedding_reindex%ROWTYPE;
  s public.embedding_settings%ROWTYPE;
  fresh boolean := true;
  busy boolean;
BEGIN
  -- Exklusiv: wartet auf jeden Schreiber, der den Trigger schon passiert hat
  -- (auch vor diesem Beginn); danach sieht jeder Schreiber den Lauf
  PERFORM pg_advisory_xact_lock(hashtext('tybo_embedding_reindex'));
  PERFORM pg_advisory_xact_lock(hashtext('tybo_embedding_settings'));
  SELECT * INTO r FROM public.embedding_reindex WHERE id FOR UPDATE;
  IF FOUND THEN
    busy := r.lease_until IS NOT NULL AND r.lease_until > now() AND r.holder IS DISTINCT FROM p_holder;
    IF r.provider = p_provider AND r.model = p_model THEN
      IF busy THEN
        RETURN jsonb_build_object('state', 'umstellung', 'run_id', r.run_id, 'provider', r.provider, 'model', r.model, 'fresh', false, 'active', true);
      END IF;
      fresh := false;
    ELSIF busy THEN
      RETURN jsonb_build_object('state', 'belegt', 'provider', r.provider, 'model', r.model);
    ELSE
      DELETE FROM public.embedding_reindex_progress WHERE run_id = r.run_id;
      DELETE FROM public.embedding_reindex_queue;
      UPDATE public.embedding_reindex
      SET run_id = gen_random_uuid(), provider = p_provider, model = p_model, started_at = now(),
          write_after = now() + interval '6 minutes', updated_at = now()
      WHERE id
      RETURNING * INTO r;
    END IF;
  ELSE
    SELECT * INTO s FROM public.embedding_settings WHERE id;
    IF FOUND AND s.state = 'festgehalten' AND s.provider = p_provider AND s.model = p_model THEN
      RETURN jsonb_build_object('state', 'festgehalten', 'provider', s.provider, 'model', s.model);
    END IF;
    DELETE FROM public.embedding_reindex_queue;
    INSERT INTO public.embedding_reindex (id, run_id, provider, model, write_after)
    VALUES (true, gen_random_uuid(), p_provider, p_model, now() + interval '6 minutes')
    RETURNING * INTO r;
  END IF;
  -- Abgelehnte Texte beim nächsten Lauf erneut versuchen
  UPDATE public.embedding_reindex_queue SET failed = false WHERE failed;
  UPDATE public.embedding_reindex
  SET holder = CASE WHEN p_seconds > 0 THEN p_holder END,
      lease_until = CASE WHEN p_seconds > 0 THEN now() + make_interval(secs => least(p_seconds, 3600)) END,
      updated_at = now()
  WHERE id
  RETURNING * INTO r;
  RETURN jsonb_build_object('state', 'umstellung', 'run_id', r.run_id, 'provider', r.provider, 'model', r.model, 'fresh', fresh, 'active', false);
END $$;

-- Lauf übernehmen bzw. Frist verlängern (p_seconds = 0 gibt ihn frei). Ein
-- neuer Inhaber versucht abgelehnte Texte erneut. Antwort mit Wartezeit bis
-- write_after und Fortschritt je Tabelle
CREATE OR REPLACE FUNCTION public.embedding_reindex_lease(p_holder text, p_seconds int)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  r public.embedding_reindex%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.embedding_reindex WHERE id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'kein-lauf');
  END IF;
  IF r.holder IS DISTINCT FROM p_holder AND r.lease_until IS NOT NULL AND r.lease_until > now() THEN
    RETURN jsonb_build_object('state', 'belegt', 'provider', r.provider, 'model', r.model);
  END IF;
  IF p_seconds > 0 AND r.holder IS DISTINCT FROM p_holder THEN
    UPDATE public.embedding_reindex_queue SET failed = false WHERE failed;
  END IF;
  UPDATE public.embedding_reindex
  SET holder = CASE WHEN p_seconds > 0 THEN p_holder END,
      lease_until = CASE WHEN p_seconds > 0 THEN now() + make_interval(secs => least(p_seconds, 3600)) END,
      updated_at = now()
  WHERE id
  RETURNING * INTO r;
  RETURN jsonb_build_object(
    'state', 'umstellung',
    'run_id', r.run_id,
    'provider', r.provider,
    'model', r.model,
    'wait_ms', greatest(0, floor(extract(epoch FROM (r.write_after - now())) * 1000)),
    'progress', coalesce((
      SELECT jsonb_object_agg(p.tab, jsonb_build_object('last_id', p.last_id, 'done', p.done, 'finished', p.finished))
      FROM public.embedding_reindex_progress p WHERE p.run_id = r.run_id
    ), '{}'::jsonb),
    'queued', (SELECT count(*) FROM public.embedding_reindex_queue)
  );
END $$;

-- Gilt der Stand noch, aus dem ein Ergebnis gerechnet wurde? Die seq einer
-- vorgemerkten Zeile ist ihr Stand: der Trigger vergibt eine neue bei jeder
-- Änderung ihres Textes. p_item mit seq (Nachzug): die Zeile ist noch mit
-- genau dieser seq vorgemerkt. Ohne seq (Hauptdurchgang): die Zeile ist nicht
-- vorgemerkt; wurde sie seit dem Lesen geändert, rechnet der Nachzug sie aus
-- dem neuen Text. Sperrt erst die Zeile, dann die Vormerkung (Reihenfolge wie
-- ein Schreiber im Trigger) bis zum Ende der Transaktion, also ändert sich
-- zwischen Prüfung und Schreiben nichts
CREATE OR REPLACE FUNCTION public.embedding_row_current(p_tab text, p_item jsonb)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  current_seq bigint;
BEGIN
  IF p_tab NOT IN ('messages','memory','knowledge','assets') THEN
    RAISE EXCEPTION 'unbekannte Tabelle';
  END IF;
  EXECUTE format('SELECT 1 FROM public.%I WHERE id = CAST($1 AS %s) FOR UPDATE', p_tab,
    CASE WHEN p_tab IN ('messages','memory') THEN 'bigint' ELSE 'uuid' END)
    USING p_item->>'id';
  SELECT q.seq INTO current_seq FROM public.embedding_reindex_queue q
  WHERE q.tab = p_tab AND q.row_id = p_item->>'id' FOR UPDATE;
  RETURN current_seq IS NOT DISTINCT FROM (p_item->>'seq')::bigint;
END $$;

-- Ein berechnetes Ergebnis auf eine Zeile anwenden. Die einzige Stelle dafür,
-- für Neuberechnung (embedding_reindex_write) und Nachzug
-- (embedding_queue_write) gleich: nur wenn der gelesene Stand noch gilt
-- (embedding_row_current); danach ist der Vektor genau das Ergebnis, auch
-- NULL (Anzeige-Meldung, leerer Text, Nicht-Fakt) und NULL bei Ablehnung,
-- Kennung p_key nur mit Vektor. Die Vormerkung wird mit passender seq
-- ausgetragen bzw. bei Ablehnung als failed behalten. false: Stand veraltet,
-- nichts geschrieben
CREATE OR REPLACE FUNCTION public.embedding_apply_result(p_tab text, p_item jsonb, p_key text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  is_failed boolean := coalesce((p_item->>'failed')::boolean, false);
  result text := CASE WHEN coalesce((p_item->>'failed')::boolean, false) THEN NULL ELSE p_item->>'embedding' END;
BEGIN
  IF NOT public.embedding_row_current(p_tab, p_item) THEN
    RETURN false;
  END IF;
  EXECUTE format('UPDATE public.%I SET embedding = $1::vector, embedding_model = CASE WHEN $1 IS NULL THEN NULL ELSE $3 END WHERE id = CAST($2 AS %s)', p_tab,
    CASE WHEN p_tab IN ('messages','memory') THEN 'bigint' ELSE 'uuid' END)
    USING result, p_item->>'id', p_key;
  IF is_failed THEN
    IF p_item ? 'seq' THEN
      UPDATE public.embedding_reindex_queue q SET failed = true
      WHERE q.tab = p_tab AND q.row_id = p_item->>'id' AND q.seq = (p_item->>'seq')::bigint;
    ELSE
      INSERT INTO public.embedding_reindex_queue (tab, row_id, seq, failed)
      VALUES (p_tab, p_item->>'id', nextval('public.embedding_reindex_seq'), true)
      ON CONFLICT (tab, row_id) DO NOTHING;
    END IF;
  ELSIF p_item ? 'seq' THEN
    DELETE FROM public.embedding_reindex_queue q
    WHERE q.tab = p_tab AND q.row_id = p_item->>'id' AND q.seq = (p_item->>'seq')::bigint;
  END IF;
  RETURN true;
END $$;

-- Ein Stapel: Vektoren mit Angabe des Ziels schreiben (NULL erlaubt),
-- vorgemerkte Zeilen mit passender seq austragen, abgelehnte Texte als failed
-- vormerken und den Fortschritt setzen, alles in einer Transaktion. Nur der
-- Inhaber des Laufs, nur nach write_after
CREATE OR REPLACE FUNCTION public.embedding_reindex_write(
  p_run uuid, p_holder text, p_tab text, p_rows jsonb, p_last_id text, p_done int, p_finished boolean
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  r public.embedding_reindex%ROWTYPE;
  item jsonb;
  n int := 0;
BEGIN
  IF p_tab NOT IN ('messages','memory','knowledge','assets') THEN
    RAISE EXCEPTION 'unbekannte Tabelle';
  END IF;
  -- Reihenfolge wie im Trigger (erst die gemeinsame Sperre, dann die Laufzeile), sonst Verklemmung mit dem Beginn
  PERFORM pg_advisory_xact_lock_shared(hashtext('tybo_embedding_reindex'));
  SELECT * INTO r FROM public.embedding_reindex WHERE id FOR SHARE;
  IF NOT FOUND OR r.run_id <> p_run OR r.holder IS DISTINCT FROM p_holder OR r.lease_until IS NULL OR r.lease_until <= now() THEN
    RETURN jsonb_build_object('ok', false, 'state', 'belegt');
  END IF;
  IF now() < r.write_after THEN
    RETURN jsonb_build_object('ok', false, 'state', 'zu-frueh');
  END IF;
  PERFORM set_config('tybo.embedding_reindex', p_run::text, true);
  FOR item IN SELECT * FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) LOOP
    IF public.embedding_apply_result(p_tab, item, r.provider || ':' || r.model) THEN
      n := n + 1;
    END IF;
  END LOOP;
  PERFORM set_config('tybo.embedding_reindex', '', true);
  IF p_last_id IS NOT NULL OR p_finished THEN
    INSERT INTO public.embedding_reindex_progress (run_id, tab, last_id, done, finished)
    VALUES (p_run, p_tab, p_last_id, coalesce(p_done, 0), coalesce(p_finished, false))
    ON CONFLICT (run_id, tab) DO UPDATE
    SET last_id = coalesce(EXCLUDED.last_id, embedding_reindex_progress.last_id),
        done = embedding_reindex_progress.done + EXCLUDED.done,
        finished = embedding_reindex_progress.finished OR EXCLUDED.finished;
  END IF;
  RETURN jsonb_build_object('ok', true, 'written', n);
END $$;

-- Nachzug ohne Umstellung (drainQueue in src/lib/embedding-reindex.ts):
-- Zeilen, die der Trigger wegen eines fremden Vektors für neuen oder
-- geänderten Text vorgemerkt hat, mit dem festgehaltenen Anbieter schreiben.
-- Nur ohne Lauf und nur, wenn die Datenbank genau p_provider:p_model
-- festhält. Geschrieben und ausgetragen wird nur bei passender seq; wurde die
-- Zeile inzwischen wieder geändert, bleibt sie vorgemerkt. Das Ergebnis wirkt
-- wie in der Neuberechnung (embedding_apply_result), NULL löscht also auch
-- hier einen Vektor, der inzwischen nicht mehr gilt
CREATE OR REPLACE FUNCTION public.embedding_queue_write(p_provider text, p_model text, p_tab text, p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  item jsonb;
  k text := p_provider || ':' || p_model;
  n int := 0;
BEGIN
  IF p_tab NOT IN ('messages','memory','knowledge','assets') THEN
    RAISE EXCEPTION 'unbekannte Tabelle';
  END IF;
  -- Kein Beginn zwischen Prüfung und Schreiben
  PERFORM pg_advisory_xact_lock_shared(hashtext('tybo_embedding_reindex'));
  IF EXISTS (SELECT 1 FROM public.embedding_reindex WHERE id) THEN
    RETURN jsonb_build_object('ok', false, 'state', 'umstellung');
  END IF;
  IF public.embedding_current_key() IS DISTINCT FROM k THEN
    RETURN jsonb_build_object('ok', false, 'state', 'anders');
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) LOOP
    -- Nur vorgemerkte Zeilen, deren Stand seit dem Lesen gleich geblieben ist
    CONTINUE WHEN NOT (item ? 'seq');
    IF public.embedding_apply_result(p_tab, item, k) THEN
      n := n + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'written', n);
END $$;

-- Umschalten: alle Tabellen durch, jeder Vektor trägt das Ziel, Warteschlange
-- leer, dann den neuen Anbieter festhalten. Vektoren mit anderer Angabe
-- (etwa ein Schreiber, der vor dem Beginn losging) werden vorgemerkt
CREATE OR REPLACE FUNCTION public.embedding_reindex_finish(p_run uuid, p_holder text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  r public.embedding_reindex%ROWTYPE;
  queued bigint;
  failed bigint;
  tables int;
  t text;
  target_key text;
BEGIN
  -- Exklusiv wie beim Beginn: kein Schreiber mehr zwischen Prüfung und Umschalten
  PERFORM pg_advisory_xact_lock(hashtext('tybo_embedding_reindex'));
  PERFORM pg_advisory_xact_lock(hashtext('tybo_embedding_settings'));
  SELECT * INTO r FROM public.embedding_reindex WHERE id FOR UPDATE;
  IF NOT FOUND OR r.run_id <> p_run OR r.holder IS DISTINCT FROM p_holder OR r.lease_until IS NULL OR r.lease_until <= now() THEN
    RETURN jsonb_build_object('state', 'belegt');
  END IF;
  SELECT count(*) INTO tables FROM public.embedding_reindex_progress WHERE run_id = r.run_id AND finished;
  IF tables < 4 THEN
    RETURN jsonb_build_object('state', 'umstellung', 'queued', (SELECT count(*) FROM public.embedding_reindex_queue), 'failed', 0, 'tables', tables);
  END IF;
  target_key := r.provider || ':' || r.model;
  FOREACH t IN ARRAY ARRAY['messages','memory','knowledge','assets'] LOOP
    EXECUTE format(
      'INSERT INTO public.embedding_reindex_queue (tab, row_id, seq) SELECT %L, x.id::text, nextval(''public.embedding_reindex_seq'') FROM public.%I x WHERE x.embedding IS NOT NULL AND x.embedding_model IS DISTINCT FROM %L ON CONFLICT (tab, row_id) DO NOTHING',
      t, t, target_key);
  END LOOP;
  SELECT count(*), count(*) FILTER (WHERE q.failed) INTO queued, failed FROM public.embedding_reindex_queue q;
  IF queued > 0 THEN
    RETURN jsonb_build_object('state', 'umstellung', 'queued', queued, 'failed', failed, 'tables', tables);
  END IF;
  -- generation: ab jetzt wird kein Vektor und keine Suche ohne Angabe mehr umgedeutet
  INSERT INTO public.embedding_settings (id, state, provider, model, generation)
  VALUES (true, 'festgehalten', r.provider, r.model, 1)
  ON CONFLICT (id) DO UPDATE SET state = 'festgehalten', provider = EXCLUDED.provider, model = EXCLUDED.model, created_at = now(),
    generation = embedding_settings.generation + 1;
  DELETE FROM public.embedding_reindex_progress WHERE run_id = r.run_id;
  DELETE FROM public.embedding_reindex WHERE id;
  RETURN jsonb_build_object('state', 'festgehalten', 'provider', r.provider, 'model', r.model);
END $$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.embedding_legacy_key()',
    'public.embedding_current_key()',
    'public.embedding_accepted_key(text)',
    'public.embedding_row_current(text, jsonb)',
    'public.embedding_apply_result(text, jsonb, text)',
    'public.embedding_provider_status()',
    'public.claim_embedding_provider(text, text)',
    'public.match_messages_checked(text, text, vector, text, float, int)',
    'public.embedding_fact_vectors(text, text)',
    'public.embedding_reindex_estimate()',
    'public.embedding_reindex_start(text, text, text, int)',
    'public.embedding_reindex_lease(text, int)',
    'public.embedding_reindex_write(uuid, text, text, jsonb, text, int, boolean)',
    'public.embedding_queue_write(text, text, text, jsonb)',
    'public.embedding_reindex_finish(uuid, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

COMMIT;
