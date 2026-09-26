# 0004 Telegram-Topics in der WebUI, gespiegelt

Datum: 23.09.2026. Entschieden von: Maintainer (Variante A).

Die Seitenleiste zeigt die echten Telegram-Topics, nicht nur Web-Gespräche.
Ein Topic im Browser ist dieselbe Unterhaltung wie in Telegram:

- Verlauf kommt aus dem Nachrichtenspeicher (Supabase, `topic_id`), weil die
  Bot-API keinen Verlauf herausgibt. Namen aus `src/lib/topic-names.ts`.
- Schreiben nutzt den Session-Schlüssel `topic:<chatId>:<topicId>` und damit
  dieselbe Claude-Session wie Telegram; `runExecution` hält beide Kanäle in Reihe.
- Gespiegelt: Die Web-Nachricht postet der Haupt-Bot ins Topic als
  „Du (Web): …", die Antwort sendet der Agenten-Bot wie bei Telegram. So zeigen
  beide Seiten immer dasselbe Gespräch.

Verworfen: Variante B (Antwort nur im Browser). Dann fehlten in Telegram Teile
des Gesprächs.
