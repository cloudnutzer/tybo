# Sessions pro Topic

Beschreibt, wie tybo Gespräche pro Telegram-Topic (und pro Direktchat oder
Web-Gespräch) als fortlaufende Claude-CLI-Session führt. Der Code verweist
auf die Abschnitte `F-1` bis `F-6`.

Einschalten: `SESSION_MODE=resume` in `.env`. Ohne diese Einstellung baut
tybo den Kontext bei jeder Nachricht neu auf (klassischer Pfad, siehe F-6).

---

## Grundidee: Session statt Prompt-Neubau

Ohne Sessions geht jede Nachricht als vollständiger Prompt an Claude:
System-Prompt, Profil, Memory, Verlauf, Suchtreffer und die Nachricht selbst,
mehrere tausend Tokens, auch für ein „Hallo".

Mit Sessions gilt:

- **Erste Nachricht einer Session:** voller Kontext-Prompt (F-3). Die
  Session-ID aus der Antwort der CLI wird am Session-Schlüssel gespeichert.
- **Folgenachrichten:** `claude -p --resume <sessionId>` mit einem schlanken
  Prompt: aktuelle Zeit, neue Suchtreffer, Memory-Änderungen seit
  Session-Start und die Nachricht (`buildResumePrompt()` in
  `src/lib/prompt-builder.ts`).
- **Verdichtung:** übernimmt die CLI selbst (Auto-Compact). Prompt Caching
  greift über die ganze Session.

Daraus folgt die Topic-Isolation: eine Claude-Session pro Session-Schlüssel.
Das Research-Topic hat seine Session, General seine eigene.

## F-1: Session-Manager

Session-Schlüssel (`sessionKeyFor()` in `src/lib/supabase.ts`):

```
topic:{chatId}:{topicId}    Forum-Topic
group:{chatId}              Gruppe ohne Topics
dm:{chatId}                 Direktchat
web:{id}                    Web-Gespräch (WebUI)
```

`src/lib/session-manager.ts` speichert die Sessions je Schlüssel und Agent
(`{sessionKey}:{agentName}`) in `data/sessions.json`, jeweils mit Motor
(`engine`, Entscheidung 0018) und Session-ID des Motors (`engineSessionId`).
Einträge aus der Zeit davor (`claudeSessionId`, ohne `engine`) gelten als
Claude-Sessions und werden beim nächsten Schreiben im neuen Format
gespeichert. Die Session-Dateien der
Claude CLI liegen nur auf diesem Rechner, deshalb ist der Zustand lokal. So
übernimmt eine Rückfrage an einen anderen Agenten (`[INVOKE:]`) nicht die
Session des Topics.

Eine neue Session beginnt, wenn

- noch keine Session-ID gespeichert ist,
- die letzte Aktivität länger als `SESSION_IDLE_HOURS` (Standard 18) zurückliegt (F-4),
- der Nutzer `/new` schickt,
- das eingestellte Modell nicht mehr dem Modell der Session entspricht,
- das Gespräch mit einem anderen Motor weiterläuft als die Session. Eine
  Session gehört zu genau einem Motor und wird nie an einen anderen
  übergeben; der nächste Turn baut den vollen Prompt, das Gedächtnis bleibt.

Destillat (F-4), `/routine` und Knopf-Antworten setzen eine Session immer
über ihren eigenen Motor fort: bei Claude das Destillat auf dem Aux-Modell
`distill` und `/routine` mit dem Modell der Session, bei anderen Motoren
beides mit dem Modell der Session. Ist der Motor nicht verfügbar, fällt der
Schritt aus; die Session-ID geht nie an einen anderen Motor. `/new` setzt die
Sessions aller Agenten und Motoren des Gesprächs zurück.

Schlägt `--resume` fehl (Session-Datei weg, CLI-Update), startet tybo
still eine neue Session. Fehler im Session-Manager blockieren nie eine
Nachricht.

Rückfragen mit Knöpfen (Human-in-the-loop, `src/lib/task-resume.ts`): Eine
Knopf-Antwort setzt die Session fort, in der die Frage gestellt wurde
(`async_tasks.session_id`), über deren Motor mit deren Modell
(`metadata.engine`, `metadata.model` an der Aufgabe; ältere Aufgaben ohne
Angabe gelten als Claude mit dem jetzigen Modell des Agenten). Fehlt die ID,
nimmt sie die Topic-Session desselben Motors und Modells. Als Turn der
Topic-Session zählt die Antwort nur, wenn genau diese Session fortgesetzt
wurde.

Für Convex gibt es die Tabelle `sessions` (`convex/sessions.ts`).

## F-2: Topic-Isolation im Schema

`topicId` und `sessionKey` sind eigene Spalten der Nachrichten-Tabelle
(Supabase: `topic_id`, `session_key`), nicht nur Felder im `metadata`-Blob.
Beim Speichern leiten beide Schreibwege (Edge Function und direkter Insert)
die Spalten aus `metadata.topicId` ab. Für ältere Nachrichten gibt es eine
Backfill-Migration (`convex/migrations.ts`, `db/migrations/`).

Isoliert ist nur der Gesprächskontext: Der Verlauf im Prompt enthält nur
Nachrichten desselben Topics. Die Suche über alle Nachrichten bleibt
topic-übergreifend, Wissen aus anderen Topics geht also nicht verloren.

## F-3: Schlanker Start-Prompt

Der volle Prompt entsteht nur beim Session-Start (`src/lib/prompt-builder.ts`,
von beiden Claude-Aufrufen in `src/bot.ts` genutzt):

1. **Memory nach Relevanz.** Ziele immer, Fakten nach Relevanz zur Nachricht
   sortiert und auf ein Zeichenbudget begrenzt (`MEMORY_CONTEXT_CHARS`).
   Auf Supabase ist das Ranking lexikalisch (Wortüberlappung plus Aktualität).
2. **Knowledge Base.** Passende Einträge kommen in den Kontext.
3. **Semantische Suche bei jeder Nachricht**, ohne Filter für kurze
   Nachrichten.
4. **Feste Anweisungen** (Merk-Tags, Bildkatalog) gehören in den
   System-Prompt, einmal pro Session.

Folgenachrichten bekommen nur, was sich geändert hat: Zeit, neue Suchtreffer,
Memory-Änderungen seit Session-Start.

## F-4: Ablauf nach Inaktivität

- Eine Session gilt nach `SESSION_IDLE_HOURS` Stunden ohne Nachricht als
  abgelaufen. Geprüft wird beim nächsten Eingang, ohne zeitgesteuerten Dienst.
- Wer abends aufhört und morgens weiterschreibt, beginnt frisch; ein
  Gespräch mitten in der Nacht wird nicht abgeschnitten.
- `/new` setzt die Session des aktuellen Topics sofort zurück, für alle
  Agenten des Topics. Ein Turn, der dabei noch läuft, antwortet zu Ende,
  speichert seine Session aber nicht mehr (Epoche je Session-Schlüssel,
  `sessionEpoch` in `src/lib/session-manager.ts`); die nächste Nachricht
  beginnt frisch.
- Knopf-Antworten auf Rückfragen setzen die Session fort, in der die Frage
  gestellt wurde, mit Sperre, Modell und Werkzeugen des Agenten wie ein
  normaler Turn, und landen im Topic der Rückfrage (`src/lib/task-resume.ts`).
- **Session-Review:** Endet eine Session mit genug Inhalt
  (`SESSION_DISTILL_MIN_TURNS`, Standard 6), setzt tybo sie ein letztes Mal
  auf dem Nebenmodell fort und fragt nach Merk-Einträgen und erkannten
  Routinen (`src/lib/session-distill.ts`). Die Vorschläge kommen mit Knöpfen
  zur Bestätigung; `DISTILL_AUTO_APPLY=true` schreibt sie direkt.

## F-5: Topic-Zuordnung aus der Konfiguration

Welcher Agent in welchem Topic antwortet, steht in `config/topics.json`
(`src/agents/base.ts`), pro Gruppe oder mit `"*"` für alle Gruppen:

```json
{
  "-1001234567890": {
    "3": "research",
    "4": "content"
  }
}
```

Die Datei wird bei Änderung neu geladen, ein Neustart ist nicht nötig.
`/topics` zeigt die Zuordnung. Schreibt jemand in ein Topic ohne Zuordnung,
fragt tybo einmal, welcher Agent es übernimmt (`src/lib/topic-setup.ts`),
und schreibt die Antwort in `config/topics.json`.

## F-6: Was gleich bleibt

Unverändert durch Sessions: `claude -p` als Hauptweg, Credit Guard,
Fallback-Kette (OpenRouter, Ollama, immer mit Kontext), Agenten-Bots,
`[INVOKE:]`-Rückfragen, Board Meetings, Rückfragen mit Knöpfen,
Sprache und Transkription, Merk-Tags.

Immer das beste Modell: Der Model Router (`src/lib/model-router.ts`) bleibt
als Struktur bestehen, weil Credit Guard und Fortschrittsanzeige daran
hängen, gibt aber für jede Nachricht dieselbe Stufe zurück.

Für den Fallback-Pfad ohne `--resume` bleibt der klassische Kontext-Neubau,
gespeist aus demselben `prompt-builder.ts`, mit Verlauf nur aus dem Topic
(dank F-2).
