-- tybo: Grundschema der Supabase-Datenbank
--
-- Diese Datei legt die Tabellen an, die tybo von Anfang an braucht. Danach
-- folgen die Dateien in db/migrations/ in der Reihenfolge von SCHEMA_FILES
-- (src/setup/supabase-schema.ts). `tybo setup datenbank` spielt alles ein;
-- von Hand geht es im SQL-Editor des Supabase-Dashboards.
--
-- Wiederholbar: Tabellen und Indizes nur, wenn sie fehlen, Funktionen per
-- create or replace. Ein zweiter Lauf auf einer bestehenden Datenbank lässt
-- alle Zeilen stehen; er setzt nur die Policies unten neu.
--
-- Bilder und Dateien liegen nicht hier, sondern in einem privaten
-- Storage-Bucket (Standardname tybo-assets, anderer Name über
-- SUPABASE_ASSETS_BUCKET). Den legt `tybo setup datenbank` an.

-- pgvector für die Spalten embedding und die Bedeutungssuche
create extension if not exists vector;


-- ---------------------------------------------------------------------------
-- Gesprächsverlauf
-- ---------------------------------------------------------------------------

-- Jede Nachricht zwischen Nutzer (user) und tybo (assistant), je Chat.
create table if not exists messages (
  id bigserial,
  created_at timestamptz default now(),
  chat_id text not null,
  role text not null,
  content text not null,
  metadata jsonb default '{}'::jsonb,
  -- Vektor der Nachricht (1536 Werte), füllt die Edge Function store-telegram-message
  embedding vector(1536),
  constraint messages_pkey primary key (id),
  constraint messages_role_check check (role in ('user', 'assistant'))
);

create index if not exists idx_messages_chat_id on messages (chat_id);
create index if not exists idx_messages_created_at on messages (created_at desc);
create index if not exists idx_messages_role on messages (role);

-- Abschnitte langer Nachrichten (über 8000 Zeichen) für die Bedeutungssuche,
-- jeder mit eigenem Vektor. Trigger, Schreib- und Suchfunktionen legt die
-- Migration 20261015_message_chunks.sql an (sie setzt die Anbieterkennung aus
-- 20260928_embedding_reindex.sql voraus). Nur service_role liest und
-- schreibt, ohne eigene Policy, wie in der Migration.
create table if not exists message_chunks (
  id bigserial primary key,
  message_id bigint not null references messages (id) on delete cascade,
  chat_id text not null,
  chunk_index int not null check (chunk_index >= 0),
  content text not null,
  embedding vector(1536),
  embedding_model text check (embedding_model is null or embedding_model ~ '^(openai|gemini|ollama):[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  created_at timestamptz not null default now(),
  unique (message_id, chunk_index)
);

create index if not exists idx_message_chunks_chat_id on message_chunks (chat_id);

alter table message_chunks enable row level security;
revoke all on table public.message_chunks from public, anon, authenticated;
grant all on table public.message_chunks to service_role;
revoke all on sequence public.message_chunks_id_seq from public, anon, authenticated;
grant usage, select on sequence public.message_chunks_id_seq to service_role;


-- ---------------------------------------------------------------------------
-- Gedächtnis
-- ---------------------------------------------------------------------------

-- Was sich tybo merkt: Fakten und Vorlieben aus [REMEMBER:], Ziele aus
-- [GOAL:] (erledigt per [DONE:] als completed_goal).
create table if not exists memory (
  id bigserial,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  type text not null,
  content text not null,
  deadline timestamptz,
  completed_at timestamptz,
  priority integer default 0,
  metadata jsonb default '{}'::jsonb,
  constraint memory_pkey primary key (id),
  constraint memory_type_check check (type in ('fact', 'goal', 'completed_goal', 'preference'))
);

create index if not exists idx_memory_type on memory (type);
create index if not exists idx_memory_created_at on memory (created_at desc);


-- ---------------------------------------------------------------------------
-- Protokoll
-- ---------------------------------------------------------------------------

-- Ereignisse des Bots zur Fehlersuche; session_id und duration_ms sind optional.
create table if not exists logs (
  id bigserial,
  created_at timestamptz default now(),
  level text not null,
  event text not null,
  message text,
  metadata jsonb default '{}'::jsonb,
  session_id text,
  duration_ms integer,
  constraint logs_pkey primary key (id),
  constraint logs_level_check check (level in ('debug', 'info', 'warn', 'error'))
);

create index if not exists idx_logs_event on logs (event);
create index if not exists idx_logs_level on logs (level);
create index if not exists idx_logs_created_at on logs (created_at desc);


-- ---------------------------------------------------------------------------
-- Anrufe
-- ---------------------------------------------------------------------------

-- Mitschrift und Zusammenfassung eines Sprachanrufs, ein Eintrag je
-- Gespräch des Sprachdienstes (conversation_id).
create table if not exists call_transcripts (
  id bigserial,
  created_at timestamptz default now(),
  conversation_id text not null,
  transcript text,
  summary text,
  action_items text[] default '{}',
  duration_seconds integer,
  metadata jsonb default '{}'::jsonb,
  constraint call_transcripts_pkey primary key (id),
  constraint call_transcripts_conversation_id_key unique (conversation_id)
);


-- ---------------------------------------------------------------------------
-- Rückfragen an den Nutzer
-- ---------------------------------------------------------------------------

-- Ein Auftrag, der auf eine Antwort wartet: die Frage samt Knöpfen
-- (pending_options als Liste von {label, value}) und die Antwort des Nutzers.
-- processed_by nennt den Rechner, der den Auftrag bearbeitet; in metadata
-- liegt, was zum Fortsetzen nötig ist.
create table if not exists async_tasks (
  id uuid default gen_random_uuid(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  chat_id text not null,
  original_prompt text not null,
  status text not null default 'pending',
  result text,
  session_id text,
  current_step text,
  pending_question text,
  pending_options jsonb,
  user_response text,
  thread_id integer,
  processed_by text,
  reminder_sent boolean default false,
  metadata jsonb default '{}'::jsonb,
  constraint async_tasks_pkey primary key (id),
  constraint async_tasks_status_check check (status in ('pending', 'running', 'needs_input', 'completed', 'failed'))
);

create index if not exists idx_async_tasks_chat_id on async_tasks (chat_id);
create index if not exists idx_async_tasks_status on async_tasks (status);
create index if not exists idx_async_tasks_updated_at on async_tasks (updated_at desc);


-- ---------------------------------------------------------------------------
-- Lebenszeichen der Rechner
-- ---------------------------------------------------------------------------

-- Wann sich ein Rechner zuletzt gemeldet hat; daran erkennt ein Server, ob
-- der Rechner zu Hause wach ist und Nachrichten übernehmen kann.
create table if not exists node_heartbeat (
  node_id text,
  last_heartbeat timestamptz default now(),
  metadata jsonb default '{}'::jsonb,
  constraint node_heartbeat_pkey primary key (node_id)
);


-- ---------------------------------------------------------------------------
-- Bilder und Dateien
-- ---------------------------------------------------------------------------

-- Ein Eintrag je gespeicherter Datei im Storage-Bucket (storage_path), mit
-- Beschreibung des Modells, Bildunterschrift des Nutzers und Schlagworten.
-- file_type ist 'image', 'document' oder 'audio'.
create table if not exists assets (
  id uuid default gen_random_uuid(),
  created_at timestamptz default now(),
  storage_path text not null,
  public_url text,
  original_filename text,
  file_type text not null,
  mime_type text,
  file_size_bytes integer,
  description text not null,
  user_caption text,
  conversation_context text,
  related_project text,
  tags text[] default '{}',
  channel text default 'telegram',
  metadata jsonb default '{}',
  -- Vektor der Beschreibung für die Bildsuche
  embedding vector(1536),
  constraint assets_pkey primary key (id)
);

create index if not exists idx_assets_file_type on assets (file_type);
create index if not exists idx_assets_created_at on assets (created_at desc);


-- ---------------------------------------------------------------------------
-- Zugriff
-- ---------------------------------------------------------------------------

-- Row Level Security auf allen Tabellen dieser Datei (message_chunks steht
-- oben bei den Nachrichten). Der Bot arbeitet mit dem
-- service_role-Schlüssel; nur diese Rolle bekommt eine Policy. Die Policy
-- wird bei jedem Lauf entfernt und neu angelegt, damit ein erneutes Einspielen
-- nicht an einer schon vorhandenen scheitert. Die Migration
-- 20260909_security_knowledge.sql zieht die Rechte danach weiter zu.
--
-- Rechte vergibt diese Datei ausdrücklich: Supabase gibt Tabellen und
-- Sequenzen in public seit 2026 nicht mehr von selbst für die Data API frei
-- (neue Projekte ab 30.05., bestehende ab 30.10.). Ohne GRANT antwortet
-- PostgREST mit "permission denied". PUBLIC, anon und authenticated bekommen
-- nichts, service_role alle Tabellenrechte und auf den Sequenzen der
-- bigserial-Spalten USAGE, SELECT (nötig für neue Zeilen). Eine Sequenz, die
-- in einer älteren Datenbank anders heißt oder fehlt, wird übersprungen.
-- Dieselben Rechte setzt die Migration 20261021_base_grants.sql.
do $$
declare
  t text;
  s text;
begin
  foreach t in array array['messages', 'memory', 'logs', 'call_transcripts', 'async_tasks', 'node_heartbeat', 'assets'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', 'Service role full access', t);
    execute format('create policy %I on %I for all using (auth.role() = %L)', 'Service role full access', t, 'service_role');
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
  foreach s in array array['messages_id_seq', 'memory_id_seq', 'logs_id_seq', 'call_transcripts_id_seq'] loop
    if to_regclass('public.' || s) is not null then
      execute format('revoke all on sequence public.%I from public, anon, authenticated', s);
      execute format('grant usage, select on sequence public.%I to service_role', s);
    end if;
  end loop;
end $$;


-- ---------------------------------------------------------------------------
-- Bedeutungssuche
-- ---------------------------------------------------------------------------
-- Ähnlichkeit ist 1 minus Kosinusabstand (Operator <=>). Treffer liegen
-- strikt über match_threshold, ohne Vektor gibt es keinen Treffer, der
-- ähnlichste kommt zuerst. Die Migration 20260928_embedding_reindex.sql
-- ersetzt beide Funktionen durch Fassungen, die Anbieter und Modell prüfen.

-- Nachrichten, wahlweise nur aus einem Chat
create or replace function match_messages(
  query_embedding vector(1536),
  filter_chat_id text default null,
  match_threshold float default 0.7,
  match_count int default 5
)
returns table (
  id bigint,
  content text,
  role text,
  chat_id text,
  created_at timestamptz,
  similarity float
)
language plpgsql
as $$
begin
  return query
  with candidates as (
    select msg.id, msg.content, msg.role, msg.chat_id, msg.created_at,
           msg.embedding <=> query_embedding as distance
    from messages as msg
    where msg.embedding is not null
      and (filter_chat_id is null or msg.chat_id = filter_chat_id)
  )
  select c.id, c.content, c.role, c.chat_id, c.created_at, 1 - c.distance
  from candidates as c
  where 1 - c.distance > match_threshold
  order by c.distance
  limit match_count;
end $$;

-- Bilder und Dateien nach ihrer Beschreibung
create or replace function match_assets(
  query_embedding vector(1536),
  match_threshold float default 0.7,
  match_count int default 5
)
returns table (
  id uuid,
  description text,
  tags text[],
  file_type text,
  public_url text,
  created_at timestamptz,
  similarity float
)
language plpgsql
as $$
begin
  return query
  with candidates as (
    select a.id, a.description, a.tags, a.file_type, a.public_url, a.created_at,
           a.embedding <=> query_embedding as distance
    from assets as a
    where a.embedding is not null
  )
  select c.id, c.description, c.tags, c.file_type, c.public_url, c.created_at, 1 - c.distance
  from candidates as c
  where 1 - c.distance > match_threshold
  order by c.distance
  limit match_count;
end $$;
