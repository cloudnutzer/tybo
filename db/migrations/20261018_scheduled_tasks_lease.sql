-- Übernahme fälliger Erinnerungen durch den Planer (Issue #322). Wer eine
-- Zeile verschickt, trägt sich als lease_owner ein und hält sie bis
-- lease_until. Gesetzt wird beides in derselben bedingten Änderung, die den
-- Status auf 'running' stellt; so gewinnt von zwei gleichzeitigen
-- Durchläufen genau einer. Läuft die Frist ab, ohne dass der Besitzer die
-- Zeile abschließt (Absturz, Neustart), darf ein späterer Durchlauf sie
-- übernehmen und auswerten.
--
-- send_started_at setzt der Besitzer unmittelbar vor dem Versand. Läuft die
-- Frist ab und die Spalte ist leer, wurde nie gesendet: die Zeile geht
-- zurück auf 'pending' und wird nachgeholt. Ist sie gesetzt, ist der
-- Ausgang unbekannt; die Zeile wird abgeschlossen, nicht neu gesendet.
--
-- Rein additiv und wiederholbar (IF NOT EXISTS); vorhandene Zeilen bleiben,
-- die Spalten sind dort leer.
BEGIN;

ALTER TABLE public.scheduled_tasks ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE public.scheduled_tasks ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE public.scheduled_tasks ADD COLUMN IF NOT EXISTS send_started_at timestamptz;

COMMIT;
