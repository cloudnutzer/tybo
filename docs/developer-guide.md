# Developer Guide

Für alle, die an tybo entwickeln statt es nur zu betreiben: Arbeitsumgebung,
Tests, Konfiguration, Datenbank und Git. Wie die Teile zusammenspielen,
steht in der [Architektur](architecture.md), Betrieb und Störungen in der
[README](../README.md) und unter [Störungen](troubleshooting.md).

## Arbeitsumgebung

- `bun install` im Projektordner. Bun ab der Version aus `package.json`
  (`engines`), dazu für echte Turns die Claude CLI.
- `src/bot.ts` nie starten oder importieren, solange auf demselben Rechner
  ein Bot mit demselben Telegram-Token läuft: zwei Bots stören sich.
- Zum Ausprobieren der WebUI ohne Bot und ohne Telegram:
  `WEB_ENABLED=true WEB_PORT=3199 WEB_PASSWORD=<passwort> bun run web:dev`
  (`scripts/web-dev.ts`). Antworten kommen dort von einer Attrappe, nicht
  von einem Modell. Danach mit `pkill -f scripts/web-dev.ts` beenden.
- Den laufenden Bot startet man nach einer Änderung nicht selbst neu,
  sondern mit `bun run restart:request "Grund"`, sobald die Änderung
  übernommen werden soll.

## Testen

- `bun run check` führt die Typprüfung (`tsc --noEmit`) und alle Tests aus.
  Beides muss vor jedem Commit grün sein; Fehler der Typprüfung werden nicht
  geduldet, auch keine alten.
- Einzelne Tests: `bun test --preload ./tests/preload-env.ts tests/<datei>.test.ts`.
  Die Preload-Datei entfernt Variablen, die ein laufender tybo vererbt
  (`TYBO_*`, `WEB_*`, alle Namen aus `.env.example`), damit ein Lauf aus
  einem Bot-Gespräch dasselbe prüft wie die CI.
- Tests liegen in `tests/` und importieren `src/bot.ts` nie. Module nehmen
  ihre Abhängigkeiten (Dateisystem, Uhr, Netz, Motor) als Parameter, damit
  Tests ohne Telegram, ohne Datenbank und ohne Claude CLI auskommen.
- Neue Funktionen bekommen Verhaltens-Tests, die auch die Gegenprobe zeigen
  (was abgelehnt, übersprungen oder nicht gesendet wird).
- Für die Oberfläche gibt es Browser-Durchläufe mit Screenshots, etwa
  `bun run scripts/web-browser-check.ts --screenshots` und
  `bun run scripts/web-handy-check.ts --screenshots`; sie starten ihren
  eigenen Web-Server ohne Bot.
- MCP-Server prüft `bun run test:tools`.

## Wo man anfängt

| Vorhaben | Einstieg |
|---|---|
| Neuer Befehl für alle Kanäle | `src/lib/commands/builtin.ts` |
| Neuer Agent | `src/agents/custom-agent.example.ts`, [Erweiterungen](erweiterungen.md#agenten-anpassen) |
| Neue Datenquelle fürs Briefing | `src/lib/sources/example.ts` |
| Neue Routine | [Routinen](routinen.md#neue-routine-anlegen) |
| Eingebautes Werkzeug | `src/lib/tools/registry.ts` |
| Neuer Motor | `src/lib/engines/types.ts`, `src/lib/engines/index.ts` |
| Oberfläche | `src/web/public/`, verbindlich ist `src/web/DESIGN.md` |

## Konfiguration

Vorrang überall: `config/settings.json` (was die WebUI schreibt) vor `.env`
vor dem Standard im Code (`src/lib/settings.ts`). Die Datei wird beim
nächsten Zugriff neu gelesen, ein Neustart ist dafür nicht nötig. Alle
Variablen der `.env` mit Erklärung stehen in `.env.example`; hier die, die
beim Entwickeln am häufigsten zählen:

| Variable | Standard | Wirkung |
|---|---|---|
| `SESSION_MODE` | aus | `resume` behält eine Session je Gespräch |
| `SESSION_IDLE_HOURS` | 18 | Verfall einer Session ohne Nachricht |
| `SESSION_DISTILL_MIN_TURNS` | 6 | ab so vielen Turns läuft das Destillat |
| `DISTILL_AUTO_APPLY` | aus | `true` übernimmt Vorschläge ohne Knopf |
| `CLAUDE_EFFORT` | je Modell | Effort für Claude Code |
| `AUX_MODEL_<ZWECK>` | je Zweck | Modell für Nebenaufgaben, Format `claude:`, `openrouter:` oder `ollama:` mit Modellname (`src/lib/aux-model.ts`) |
| `GOAL_MAX_TURNS` | 10 | Turns je `/goal`, danach die Frage „Weiter?“ |
| `AGENT_INVOKE_BUDGET` | 3 | Befragungen anderer Agenten je Antwort |
| `TYBO_PROFILE` | `local` | Betriebsprofil, siehe [Architektur](architecture.md#betriebsprofile) |

Topics ordnet `config/topics.json` Agenten zu, Vorlage
`config/topics.example.json`:

```json
{
  "*":              { "3": "research", "4": "content" },
  "-1001234567890": { "988": "research" }
}
```

Außen stehen Chat-IDs oder `"*"` für alle Chats, innen Topic-IDs. Eine
Angabe zum Chat geht vor `"*"`, beide vor der eingebauten Zuordnung in
`src/agents/base.ts`. Änderungen gelten ohne Neustart.

Laufzeitdateien (Sessions, Rückfragen, Fäden, Jobs) liegen unter `data/`,
eigene Einstellungen unter `config/`; beides ist nicht im Repo.

## Datenbank

- Schema: `db/schema.sql`, Änderungen als neue Datei in `db/migrations/`.
  `tybo setup datenbank` spielt beides ein.
- Edge Functions in `supabase/functions/`: `store-telegram-message`
  (speichern mit Embedding), `search-memory` (semantische Suche) und
  `embed-knowledge`. Sie werden mit `--no-verify-jwt` ausgerollt
  (`supabase/config.toml`); die Prüfung des Schlüssels macht
  `supabase/functions/_shared/auth.ts`, den gemeinsamen Rahmen
  (Preflight, Pflichtfelder, Fehlerantworten)
  `supabase/functions/_shared/handler.ts`. Neue Schlüssel (`sb_…`) schickt
  der Bot nur als `apikey` (`src/lib/supabase-keys.ts`).
- Die Verträge der drei Functions halten `tests/edge-functions.test.ts` fest.
- Embeddings für ältere Fakten trägt
  `bun run scripts/backfill-fact-embeddings.ts` nach; der Lauf lässt sich
  wiederholen.

## Git-Workflow

- **Repo:** github.com/cloudnutzer/tybo (`BRAND.repo` in `src/brand.ts`).
- **Mitwirken:** Repo forken, eigenen Branch anlegen, `bun run check` grün
  laufen lassen, Pull Request gegen `master` öffnen.
- **Veröffentlichen:** Das öffentliche Repo bekommt je Version genau einen
  Commit „tybo <version>“ mit Tag `v<version>`. Das Export-Werkzeug prüft
  vorher Pfade, Texte, Geheimnisse (gitleaks mit `.gitleaks.toml`) und
  `bun run check`. Auf `master` wird nicht direkt gepusht; Beiträge aus Pull
  Requests kommen mit dem nächsten Export.
- **Updates für Installationen:** Ein zweiter Lauf des Installers holt den
  neuesten Stand und installiert die Pakete neu. ZIP-Downloads, fremde Klone
  und Ordner mit lokalen Änderungen lehnt er ab; dann hilft eine frische
  Installation in einen eigenen Ordner, siehe [Einrichtung](einrichtung.md).
