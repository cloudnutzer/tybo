# tybo Developer Guide

> Architektur, Betrieb und Erweiterung von tybo mit Sessions pro Topic
> (Stand: Juli 2026). Nutzersicht: [User Guide](user-guide.md).
> Architektur der Sessions pro Topic: [topic-sessions.md](topic-sessions.md).

## Ueberblick: Nachrichtenfluss

```
Telegram (grammY, Polling)
  └─ bot.ts handleTextMessage()
       ├─ saveMessage() → Supabase (Edge Function erzeugt Embedding)
       ├─ Befehle (remember:, /new, /topics, /board, ...)
       ├─ Topic-Setup: unbekanntes Topic → einmalige Agent-Nachfrage (Inline-Keyboard)
       ├─ Routing: topicId → Agent (config/topics.json, Hot-Reload) → sessionKey
       └─ callClaudeAndReply()
            ├─ prepareClaudeCall()
            │    ├─ Session vorhanden? → buildResumePrompt() (schlank) + --resume
            │    └─ sonst → buildPromptContext() (voll) + ggf. Destillat der alten Session
            ├─ claude -p Subprocess (claude.ts; Streaming-Progress bei komplexen Tasks)
            │    └─ Resume-Fehler → Session-Reset + 1x Retry mit vollem Prompt
            ├─ finalizeClaudeSession() → data/sessions.json
            ├─ Fallback-Kette bei Claude-Fehler: OpenRouter → Ollama (immer mit vollem Kontext)
            └─ Response-Processing: Intent-Tags, Cross-Agent [INVOKE:], HITL-Buttons, Senden via BotRegistry
```

## Kernmodule (Sessions pro Topic)

| Modul | Verantwortung |
|---|---|
| `src/lib/prompt-builder.ts` | Einzige Quelle fuer den Prompt-Aufbau. `buildPromptContext()` (voll, parallel gefetcht: Profil, Memory relevanz-gerankt, Knowledge Base, topic-isolierter Verlauf, semantische Suche bei JEDER Nachricht) und `buildResumePrompt()` (schlank: Zeit, Memory-Delta, Suche, Nachricht) |
| `src/lib/session-manager.ts` | Node-lokaler Session-State (`data/sessions.json`), Key = `{sessionKey}:{agentName}`. Idle-Verfall (`SESSION_IDLE_HOURS`, 18h), Invalidierung bei Modellwechsel, `takeExpiredSession()` fuer das Destillat. Fail-open: Fehler ⇒ frische Session, nie Blockade |
| `src/lib/session-distill.ts` | Destillat + Auto-Review beim Session-Ende: alte Session einmal per `--resume` oeffnen (Aux-Modell), `[REMEMBER:]`/`[GOAL:]`-Tags und `[ROUTINE:]`-Erkennung extrahieren. Vorschlaege werden gestaged (`data/pending-reviews.json`) und per Inline-Buttons bestaetigt (`rev\|...`-Callbacks in bot.ts); `DISTILL_AUTO_APPLY=true` schreibt direkt. Fire-and-forget ab `SESSION_DISTILL_MIN_TURNS` (6) |
| `src/lib/goal-engine.ts` | `/goal`: stehendes Ziel pro Session-Key (`data/goals.json`). Zyklus: Quality Gates (Shell, 5-min-Timeout) → Judge (Aux, striktes JSON done/continue/wait) → naechster Arbeits-Turn ueber die Topic-Session. Turn-Budget mit Weiter?-Rueckfrage (seit Issue #118 ueber das Rueckfragen-Register, `src/lib/goal-choices.ts`; alte Knoepfe `goalkb\|...` wirken weiter), 2 Judge-Fehlschlaege in Folge pausieren. Deps via `initGoalEngine()` aus bot.ts injiziert |
| `src/lib/aux-model.ts` | Aux-Modell-Routing fuer Nebenaufgaben (`AUX_MODEL_JUDGE/DISTILL/REVIEW`, Format `claude:\|openrouter:\|ollama:<model>`). Defaults: Judge `claude-opus-5` mit effort high (User-Vorgabe: mindestens Opus; xhigh geht seit 30.8.2026 auch auf Opus 5), Destillat/Review Haiku. Resume-Aufrufe laufen immer ueber die CLI |
| `src/lib/agent-overrides.ts` | `/agent`-Anweisungen pro Agent (`config/agent-overrides.json`, mtime-Hot-Reload), werden im Prompt-Builder an den System-Prompt angehaengt (auch im Fallback-Kontext) |
| `src/lib/learn.ts` | `/learn`: Quelle scrapen (Firecrawl-Built-in, Fetch-Fallback) → Aux-Destillat → `addKnowledge()` |
| `src/lib/engines/calls.ts` (Abort) | `abortEngineCalls(key)` (Alias `abortClaudeCalls` in `src/lib/claude.ts`) killt registrierte Subprozesse samt Prozessbaum (`pkill -P` auf den caffeinate-Wrapper); Ergebnis traegt `aborted: true`, Aufrufer ueberspringen dann Fallback und Fresh-Retry (`/stop`) |
| `src/lib/tools/registry.ts` (HITL) | Phase-3-Gate: `requiresApproval`-Tools warten im `callBuiltinTool()` auf den in bot.ts registrierten Approval-Handler (Inline-Buttons `toolok\|...`, 10-min-Timeout = abgelehnt); `FALLBACK_ALLOW_WRITE_TOOLS=true` umgeht das Gate |
| `src/lib/tools/history-search.ts` | Built-in `history_search`: Fallback-Modelle durchsuchen Historie (Owner-DM + Chats aus topics.json) und Knowledge Base selbst |
| `src/lib/topic-setup.ts` | Einmalige Agent-Nachfrage fuer ungemappte Topics (`data/topics-asked.json`), schreibt Auswahl nach `config/topics.json`; `onTopicMappingSet` meldet jede geschriebene Zuordnung |
| `src/lib/topic-choices.ts` | Die Nachfrage als Rueckfrage `topicmap` (Issue #119): eine Option je aktivem Agenten, Handler ueber `setTopicMappingIfUnmapped`, offene Fragen laufen bei anderweitiger Zuordnung ab; alte `topicmap:`-Knoepfe wirken weiter |
| `src/agents/base.ts` | Topic→Agent-Aufloesung: `config/topics.json` (pro Chat-ID oder `"*"`, mtime-Hot-Reload) vor eingebautem Default-Mapping. `getAgentByTopicId(topicId, chatId)` ist chat-aware |
| `src/lib/model-router.ts` | Per Design auf ein Modell gepinnt (alle Tiers = `claude-fable-5`, Classifier liefert immer `opus`). Tier steuert nur noch den UX-Pfad (instant vs. Streaming-Progress) und haengt am Credit Guard |
| `src/lib/claude.ts` | `claude -p` Subprocess (JSON + Streaming), `--resume`, Effort-Logik (`defaultEffort()`: xhigh bei Opus-Modellen, CLI-Default bei Fable, Override `CLAUDE_EFFORT`) |
| `src/lib/supabase.ts` | Live-DB-Schicht: Nachrichten (Edge Functions fuer Embeddings + semantische Suche), Memory inkl. `buildMemoryContextString()` (Relevanz-Ranking + Budget) und `getMemoryUpdatesSince()` (Delta fuer Resume-Prompts) |
| `src/lib/convex.ts` + `convex/` | Alternatives Backend (aktuell nicht konfiguriert). Schema mit `topicId`/`sessionKey`/`sessions` + Backfill-Migration liegt bereit |

## Session-Mechanik im Detail

- **Session Keys:** `topic:{chatId}:{topicId}` | `group:{chatId}` | `dm:{chatId}`
  (Helper `sessionKeyFor()` in `src/lib/convex.ts`). Storage-Key ergaenzt den
  Agent-Namen, damit Cross-Agent-Invocations im selben Topic die Topic-Session
  nicht kapern.
- **Lebenszyklus:** erste Nachricht → voller Prompt, `result.sessionId` wird am
  Key gespeichert. Folgenachricht → `--resume` + Slim-Prompt. Verfall: Idle >
  18h, Modellwechsel, `/new`. Bei Verfall mit ≥ 6 Turns laeuft vorher das
  Destillat (fire-and-forget).
- **Resume-Fehler** (Session-File weg, CLI-Update, Kontextlimit): Session wird
  zurueckgesetzt und der Aufruf einmal mit frischem vollem Prompt wiederholt;
  erst danach greift die Fallback-LLM-Kette, immer mit vollem Kontext.
- **Bot-Neustarts ueberleben Sessions**: Claude-CLI-Sessions liegen auf Platte,
  `data/sessions.json` persistiert die Zuordnung.

## Konfiguration

### .env (Sessions pro Topic)
| Variable | Default | Wirkung |
|---|---|---|
| `SESSION_MODE` | leer (aus) | `resume` aktiviert Per-Topic-Sessions |
| `SESSION_IDLE_HOURS` | 18 | Idle-Verfall der Sessions |
| `SESSION_DISTILL_MIN_TURNS` | 6 | Mindest-Turns, ab denen das Destillat laeuft |
| `MEMORY_CONTEXT_CHARS` | 6000 | Zeichen-Budget der Facts-Sektion im Prompt |
| `CLAUDE_EFFORT` | modellabhaengig | Reasoning-Effort-Override fuer den Subprocess (Aux-Modelle unterhalb Opus sind davon ausgenommen) |
| `AUX_MODEL_JUDGE` | `claude:claude-opus-5` | Goal-Judge-Modell (mindestens Opus per User-Vorgabe) |
| `AUX_MODEL_DISTILL` / `AUX_MODEL_REVIEW` | `claude:claude-haiku-4-5-20251001` | Destillat- / Review-Modell |
| `GOAL_MAX_TURNS` | 10 | Turn-Budget pro `/goal`, danach Auto-Pause mit Nachfrage |
| `AGENT_INVOKE_BUDGET` | 3 | Max. `[INVOKE:]`-Konsultationen pro Antwort |
| `DISTILL_AUTO_APPLY` | leer (aus) | `true` = Destillat schreibt direkt statt Button-Staging |
| `FALLBACK_ALLOW_WRITE_TOOLS` | leer (aus) | `true` = schreibende Built-ins ohne HITL-Freigabe |

Laufzeit-State (alle in `data/`, gitignored): `sessions.json`, `goals.json`,
`pending-reviews.json`, `topics-asked.json`. `/agent`-Anweisungen liegen in
`config/agent-overrides.json` (nicht committet, siehe .gitignore).

### config/topics.json
```json
{
  "*":              { "3": "research", "4": "content" },
  "-1001234567890": { "988": "research" }
}
```
Aeussere Keys: Chat-IDs oder `"*"` (alle Chats). Innere Keys: Topic-IDs
(`message_thread_id`). Hot-Reload per mtime, kein Neustart noetig. Aufloesung:
Chat-spezifisch > `"*"` > eingebautes Default-Mapping in `base.ts`.

## Datenbank (Supabase, live)

- `messages`: Verlauf mit `embedding VECTOR(1536)` plus native Spalten
  `topic_id`, `session_key` (+ Index `idx_messages_session_key`, Migration
  `2026-07-02-fable-topics-memory.sql`). Schreibpfad: Edge Function v2 und
  Direct-Insert-Fallback befuellen beide Spalten (mit Ableitungs-Fallback aus
  `metadata.topicId` fuer alte Clients). Lesepfad filtert ueber den
  `session_key`-Index.
- `memory`: Facts/Goals mit `embedding VECTOR(1536)`; Bestand backgefuellt,
  `addFact()` erzeugt Embeddings fire-and-forget. Fact-Ranking laeuft ueber
  Cosine-Similarity (Query-Embedding via OpenAI), lexikalischer Fallback ohne
  Key/Embeddings. Nachtraeglicher Backfill: `bun run
  scripts/backfill-fact-embeddings.ts` (idempotent).
- `knowledge`, `async_tasks`, `logs`: unveraendert.
- **Edge Functions** (`supabase/functions/`): `store-telegram-message`
  (Insert + Embedding), `search-memory` (semantische Suche),
  `embed-knowledge`. Deploy mit `--no-verify-jwt` (`supabase/config.toml`),
  die Prüfung macht `_shared/auth.ts`: `apikey` aus `SUPABASE_SECRET_KEYS`
  oder `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`. Der Bot schickt
  neue Schlüssel (`sb_…`) nur als `apikey` (`src/lib/supabase-keys.ts`).

## Betrieb & Troubleshooting

- **Prozessmodell:** launchd-Job `ai.tybo.telegram-relay` (RunAtLoad +
  KeepAlive, Throttle 10 s), Plist in `~/Library/LaunchAgents/` mit korrektem
  PATH (`~/.local/bin` fuer die Claude CLI).
- **Deploy/Neustart:** `kill -TERM $(cat bot.lock) && rm -f bot.lock`, dann
  ~15 s warten; launchd startet automatisch neu. Verifizieren:
  `launchctl list | grep ai.tybo`, `cat bot.lock`, `curl localhost:3000/health`,
  genau EIN `bun run src/bot.ts`-Prozess (zwei Poller ⇒ Telegram 409).
- **NIE manuell per nohup starten**, solange der launchd-Job geladen ist:
  KeepAlive-Retries spammen sonst `FATAL: Another instance is running` ins
  Error-Log. Port-3000-Falle: neuen Prozess erst starten, wenn `lsof -ti :3000`
  leer ist (sonst EADDRINUSE-Zombie).
- **Logs:** `logs/telegram-relay.log` (stdout), `logs/telegram-relay.error.log`
  (stderr; hier landen Claude-CLI-Fehler wie PATH-Probleme). Session-Aktivitaet:
  `grep "\[Session\]\|\[Distill\]" logs/telegram-relay.log`.
- **Health:** `GET localhost:3000/health` liefert PID, Uptime, Session-ID.

## Entwickeln & Testen

- Typecheck: `bunx tsc --noEmit` (Achtung: `vps-gateway.ts`,
  `knowledge-base.ts` u. a. haben vorbestehende Fehler; relevant ist, dass die
  eigenen Aenderungen keine NEUEN Fehler einbringen).
- Schneller Modul-Graph-Check: `bun build src/bot.ts --target=bun --outdir /tmp/x`.
- Smoke-Tests gegen die Live-DB sind gefahrlos read-only moeglich (Muster: env
  laden, `buildPromptContext()` aufrufen, Sektionen pruefen). Resume-Mechanik
  laesst sich mit zwei kleinen `claude -p`-Aufrufen testen (Codewort merken,
  per `--resume` abfragen).

## Git-Workflow

- **Repo:** github.com/cloudnutzer/tybo (`BRAND.repo` in `src/brand.ts`).
- **Veröffentlichen:** Das öffentliche Repo bekommt je Version genau einen
  Export-Commit „tybo <version>" mit Tag `v<version>`, erzeugt von einem
  Export-Werkzeug, das vorher Pfade, Texte, Geheimnisse (gitleaks mit
  `.gitleaks.toml`) und `bun run check` prüft. Auf `master` wird nicht direkt
  gepusht; Beiträge laufen über Fork und Pull Request (siehe „Mitwirken") und
  kommen mit dem nächsten Export ins Repo.
- **Updates fuer Installationen:** `bun run upgrade` verbindet ZIP-Downloads
  und fremde Klone mit diesem Repo (`setup/upgrade.ts`).
- **Mitwirken:** Repo forken, eigenen Branch anlegen, vor dem Pull Request
  `bun run check` (Typprüfung und Tests) grün laufen lassen, Pull Request
  gegen `master` öffnen.

## Offene Arbeiten

1. ~~Native Spalten aktivieren~~ **Erledigt (2. Juli 2026):** Edge Function v2
   schreibt `topic_id`/`session_key` (mit Ableitungs-Fallback fuer alte
   Clients), `saveMessage()` sendet die Felder auf beiden Pfaden, Lesepfad
   filtert ueber den `session_key`-Index.
2. ~~Vector-Ranking fuer Facts~~ **Erledigt (2. Juli 2026):** Bestand
   backgefuellt (`scripts/backfill-fact-embeddings.ts`, idempotent),
   `addFact()` erzeugt Embeddings fire-and-forget, Ranking nutzt
   Cosine-Similarity (Query-Embedding via OpenAI) mit lexikalischem Fallback.
3. **HITL auf Session-Modell:** Task-Queue nutzt eigene Session-IDs; kann auf
   die Topic-Sessions umziehen (kein Handlungsdruck, funktioniert).
4. **Convex-Parität:** Schema liegt bereit; bei Convex-Aktivierung `npx convex
   dev --once` + Backfill-Migration `migrations:backfillSessionKeys` ausfuehren.
