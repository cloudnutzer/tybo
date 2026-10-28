-- Issue #437: ausdrückliche Rechte für die Grundtabellen aus db/schema.sql
--
-- Supabase gibt Tabellen und Sequenzen im Schema public nicht mehr von selbst
-- für die Data API frei: neue Projekte seit 30.05.2026, bestehende ab
-- 30.10.2026. Ohne GRANT antworten PostgREST und supabase-js mit
-- "permission denied" (Fehlercode 42501). tybo arbeitet nur mit service_role.
--
-- Diese Datei setzt für bestehende Installationen dieselben Rechte wie
-- db/schema.sql: nichts für PUBLIC, anon, authenticated; service_role alle
-- Tabellenrechte und USAGE, SELECT auf den Sequenzen der bigserial-Spalten.
-- Sie legt nichts an und ändert keine Zeilen, Policies oder Funktionen. Fehlt
-- eine Tabelle oder Sequenz, wird sie übersprungen. Mehrfaches Einspielen
-- schadet nicht.
--
-- Von Hand reparieren: den Inhalt dieser Datei im SQL-Editor des
-- Supabase-Dashboards ausführen. Nicht db/schema.sql neu einspielen, das
-- setzt Policies und Suchfunktionen auf die Grundfassung zurück.
BEGIN;
DO $$
DECLARE
  tab text;
  seq text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['messages','memory','logs','call_transcripts','async_tasks','node_heartbeat','assets'] LOOP
    IF to_regclass('public.' || tab) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tab);
      EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', tab);
    END IF;
  END LOOP;
  FOREACH seq IN ARRAY ARRAY['messages_id_seq','memory_id_seq','logs_id_seq','call_transcripts_id_seq'] LOOP
    IF to_regclass('public.' || seq) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM PUBLIC, anon, authenticated', seq);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO service_role', seq);
    END IF;
  END LOOP;
END $$;
NOTIFY pgrst, 'reload schema';
COMMIT;
