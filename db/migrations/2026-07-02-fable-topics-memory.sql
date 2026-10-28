-- Sessions pro Topic: native Topic-Spalten + Memory-Embeddings (docs/topic-sessions.md)
-- Ausfuehren: Supabase Dashboard → SQL Editor → New query → einfuegen → Run.
-- Idempotent: kann gefahrlos mehrfach ausgefuehrt werden.

-- 1) messages: topic_id + session_key als echte, indizierte Spalten
--    (bisher steckt die Topic-Info nur im metadata-JSONB)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS topic_id BIGINT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS session_key TEXT;

-- Backfill aus metadata.topicId; session_key-Schema:
--   topic:{chat_id}:{topic_id} | group:{chat_id} | dm:{chat_id}
UPDATE messages SET
  topic_id = NULLIF(metadata->>'topicId', '')::BIGINT,
  session_key = CASE
    WHEN COALESCE(metadata->>'topicId', '') <> ''
      THEN 'topic:' || chat_id || ':' || (metadata->>'topicId')
    WHEN chat_id LIKE '-%' THEN 'group:' || chat_id
    ELSE 'dm:' || chat_id
  END
WHERE session_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_messages_session_key
  ON messages (session_key, created_at DESC);

-- 2) memory: Embedding-Spalte, damit Facts vektorbasiert statt lexikalisch
--    gerankt werden koennen
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE memory ADD COLUMN IF NOT EXISTS embedding VECTOR(1536);

-- Verifikation (beide Zeilen einzeln ausfuehren):
-- SELECT count(*) FILTER (WHERE session_key IS NULL) AS ohne_key, count(*) AS gesamt FROM messages;
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'memory' AND column_name = 'embedding';
