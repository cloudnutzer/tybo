-- Erinnerungen und geplante Aufträge (Issue #321, Entscheidung E2): eine
-- eigene Tabelle, unabhängig von Convex. Eine Zeile ist eine Erinnerung
-- (kind 'reminder': Text an den Nutzer) oder ein Auftrag (kind 'action':
-- der Text ist eine Anweisung an tybo), fällig zum Zeitpunkt due_at.
--
-- chat_id ist Text, damit neben Telegram-Chats auch Gespräche der WebUI
-- passen; topic_id ist das Forum-Topic (leer: Direktchat bzw. kein Topic).
-- recurrence hält die Wiederholung im Format von src/lib/recurrence.ts
-- (leer: einmalig). status: pending (wartet), running (wird gerade
-- verschickt), done, failed, cancelled. attempts zählt Versandversuche,
-- last_error hält den letzten Fehler.
--
-- Zugriff nur für service_role (der Bot): RLS an, keine Policy, anon und
-- authenticated ohne jedes Recht. service_role umgeht RLS.
--
-- Rein additiv und wiederholbar (IF NOT EXISTS); ein zweiter Lauf lässt alle
-- Zeilen stehen.
BEGIN;

CREATE TABLE IF NOT EXISTS public.scheduled_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id text NOT NULL CHECK (btrim(chat_id) <> ''),
  topic_id bigint,
  kind text NOT NULL DEFAULT 'reminder' CHECK (kind IN ('reminder', 'action')),
  text text NOT NULL CHECK (btrim(text) <> ''),
  due_at timestamptz NOT NULL,
  recurrence text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Fällige finden: status = 'pending' und due_at <= jetzt
CREATE INDEX IF NOT EXISTS scheduled_tasks_status_due_at ON public.scheduled_tasks (status, due_at);
-- Liste je Gespräch (WebUI, /erinnerungen)
CREATE INDEX IF NOT EXISTS scheduled_tasks_chat_topic ON public.scheduled_tasks (chat_id, topic_id);

ALTER TABLE public.scheduled_tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scheduled_tasks FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.scheduled_tasks TO service_role;

COMMIT;
