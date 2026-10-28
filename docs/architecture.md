# Architektur

Wie tybo aufgebaut ist: welche Prozesse laufen, wie eine Nachricht zur
Antwort wird und wo Sessions, Gedächtnis und Einstellungen liegen. Wie man
am Code arbeitet und testet, steht im [Developer Guide](developer-guide.md),
die Sessions pro Topic im Detail in [topic-sessions.md](topic-sessions.md),
die WebUI in [webui/README.md](webui/README.md).

## Prozesse

tybo ist kein einzelnes Programm, sondern ein dauerhafter Bot und einige
kurze Läufe daneben. Sie rufen sich nicht gegenseitig auf, sondern teilen
den Speicher, ein paar Dateien unter `data/` und die Outbox.

| Prozess | Einstieg | Lebensdauer |
|---|---|---|
| Bot | `src/bot.ts` | dauerhaft; Telegram, WebUI, Health-Port, Planer |
| Routinen | `src/routines/checkin.ts`, `src/routines/briefing.ts`, `src/health-check.ts`, `src/software-update.ts` | zu festen Zeiten, über den Wrapper `src/routine-run.ts` |
| Hintergrund-Jobs | `scripts/job.ts` | ein Wächter je Auftrag, bis zum Bericht ([mehr](hintergrund-jobs.md)) |
| Terminal-Chat | `scripts/tybo.ts`, `src/terminal/` | solange das Terminal offen ist; Client der WebUI-API |
| Einrichtung | `src/setup/` | `tybo setup`, Prüfbericht, Dienste |
| Sprach-Brücke | `src/voice-bridge.ts` | optional, dauerhaft |
| WhatsApp | `src/whatsapp-gateway.ts` | optional, dauerhaft |

Welche Dienste es gibt und wie sie starten, beschreibt ein Katalog
(`src/lib/services/catalog.ts`): unter macOS als launchd-Dienste
`ai.tybo.*`, unter Linux als systemd-Benutzerdienste
(`src/lib/services/systemd.ts`) oder unter PM2 mit Namen `tybo-*`. Dauerdienste
wie den Bot startet der Dienstverwalter nach jedem Ende neu, Routinen nur zu
ihren Terminen.

### Der Bot-Prozess

`src/bot.ts` verdrahtet nur; die Teile stehen in `src/app/`:

1. **Start** (`src/app/bot-boot.ts`): `.env` laden, Betriebsprofil lesen,
   Startmodus wählen. Fehlt jeder Kanal, läuft nur der Einrichtungsmodus im
   Browser (`src/setup/web-mode.ts`) und der Prozess endet danach.
2. **Lebenszyklus** (`src/app/lifecycle.ts`): Sperrdatei `bot.lock` gegen
   einen zweiten Bot, Herzschlag, Signale. Beim Beenden arbeitet
   `src/app/bot-shutdown.ts` eine feste Reihenfolge ab: laufende Aufrufe
   abbrechen, Planer anhalten, Telegram und WebUI schließen.
3. **Kanäle**: Telegram (`src/app/bot-telegram-channel.ts`), WebUI
   (`src/app/bot-web.ts`) und der Health-Port (`src/app/health-server.ts`,
   standardmäßig nur lokal, mit `/health` und `POST /process`).
4. **Hintergrund** (`src/app/bot-start.ts`): Embedding-Prüfung,
   Log-Rotation, verwaiste Jobs, Routinen-Wache, Erinnerungen an offene
   Fäden, Erinnerungsplaner und die erste Ablauf-Prüfung der Rückfragen.
   Erst danach beginnt Telegram zu lesen und aktive Ziele laufen weiter.
5. **Neustart** (`src/app/bot-restart.ts`): Ein Subprozess beendet den Bot
   nie selbst. Er legt mit `bun run restart:request` eine Markierung an;
   der Bot endet, sobald keine Antwort mehr läuft, und der Dienstverwalter
   startet ihn neu (`src/lib/restart-request.ts`).

### Betriebsprofile

Derselbe Prozess läuft auf dem eigenen Rechner oder auf einem Server
(`src/lib/runtime-profile.ts`, Variable `TYBO_PROFILE`):

- `local` (Standard): Telegram per Polling.
- `server`: Telegram per Webhook, dazu `/health` und optionale Wege für
  Deploy und Anrufprotokolle am selben Listener (`src/app/server-routes.ts`,
  [Webhook](telegram-webhook.md)).
- `peer`: der eigene Rechner hinter einem Server. Der Server reicht Updates
  weiter, solange der Rechner sich gesund meldet (`src/app/hybrid.ts`,
  `src/lib/hybrid/`).

Ein ungültiges Profil ergibt keinen Eingang, nie stillschweigend Polling.

## Kanäle

Alle Kanäle enden im selben Chat-Kern. Ob Telegram eingerichtet ist,
entscheidet eine einzige Funktion (`src/lib/channels.ts`); ohne Telegram
ist der Direktchat ein Web-Gespräch mit der Chat-ID `web`.

- **Telegram** (`src/channels/telegram/`, `src/lib/telegram-runtime.ts`):
  Texte (`src/channels/telegram/text-inbox.ts`), Medien
  (`src/channels/telegram/media-inbox.ts`), Antworten
  (`src/channels/telegram/reply-turn.ts`), Knöpfe
  (`src/channels/telegram/callbacks.ts`). Ein Topic der Forum-Gruppe gehört
  zu einem Agenten; hat ein Agent einen eigenen Bot, antwortet der
  (`src/channels/telegram/identities.ts`).
- **WebUI** (`src/web/`): Der Web-Server (`src/web/server.ts`) lädt nichts
  aus `src/lib/`; die Verbindung zum Chat-Kern legt `src/web/bot-turn.ts` an.
  Antworten und Fortschritt gehen per Server-Sent Events an den Browser
  (`src/web/chat.ts`). Direktchat und Topics teilen die Session mit
  Telegram; eine Nachricht aus dem Browser erscheint im Topic gespiegelt.
- **Terminal** (`src/terminal/`): spricht nur mit der API der WebUI,
  angemeldet mit einem lokalen Schlüssel, der nur von Loopback gilt
  (`src/web/cli-token.ts`).
- **Telefonhörer** (`src/web/call.ts`): WebSocket hinter dem WebUI-Login,
  mit eigenem Gesprächskern für kurze, sprechbare Antworten
  (`src/lib/voice-brain/`), Hören und Sprechen über `src/lib/speech/`
  ([mehr](sprechen.md)).
- **WhatsApp** (`src/whatsapp-gateway.ts`, `src/channels/whatsapp/`):
  eigener Prozess, Antworten über denselben Chat-Kern.

Befehle wie `/new`, `/stop` oder `/agent` laufen für alle Kanäle durch eine
Befehls-Schicht (`src/lib/commands/`); die Dienste dafür stellt
`src/app/command-services.ts` bereit.

## Ein Turn von Eingang bis Antwort

Ein Turn ist eine Nachricht des Nutzers und die Antwort darauf. Der Weg ist
für jeden Kanal gleich; nur Eingang und Zustellung unterscheiden sich.

1. **Eingang**: Telegram lässt nur Nachrichten von `TELEGRAM_USER_ID` durch,
   die WebUI nur angemeldete Browser. Die Nachricht kommt in den Speicher.
2. **Agent und Schlüssel**: Das Gespräch bestimmt den Agenten
   (`src/agents/base.ts`, Zuordnung aus `config/topics.json`) und den
   Session-Schlüssel (`sessionKeyFor` in `src/lib/store/message-rules.ts`):
   `dm:<chat>`, `topic:<chat>:<topic>`, `group:<chat>` oder `web:<id>`.
3. **Ausführung** (`src/lib/execution-context.ts`): Je Schlüssel läuft ein
   Turn nach dem anderen. Wie viele Turns insgesamt gleichzeitig laufen,
   begrenzt `src/lib/agent-capacity.ts`. `/stop` bricht alles unter dem
   Schlüssel ab (`src/lib/engines/calls.ts`).
4. **Prompt** (`src/lib/prompt-builder.ts`): Eine neue Session bekommt den
   vollen Prompt mit Agent, Profil, Gedächtnis, Verlauf des eigenen Topics
   und Suchtreffern. Eine fortgesetzte bekommt nur Zeit, Kanal, neue
   Merk-Einträge, Suchtreffer und die Nachricht.
5. **Motor**: `src/lib/engine-choice.ts` wählt den Motor des Gesprächs,
   `src/lib/engines/` führt ihn aus: Claude Code (Standard), Codex, OpenCode
   oder die Anthropic API. Ein Motor, der nicht bereit ist, wird
   übersprungen; dann antwortet Claude Code.
6. **Chat-Kern** (`src/lib/chat-turn.ts`): `runStreamingTurn` meldet
   Fortschritt (welches Werkzeug läuft), `runJsonTurn` arbeitet ohne. Der
   Kern setzt die Session fort und speichert ihre ID. Scheitert eine
   Fortsetzung, beginnt er einmal mit vollem Prompt neu. Erst danach
   antwortet die Fallback-Kette.
7. **Abschluss** (`src/lib/turn-finish.ts`): Antwort speichern, Merk-Tags
   durch das Tor (`src/lib/intent-gate.ts`), `/goal` anstoßen, andere Agenten
   befragen (`[INVOKE:]`, `src/lib/agent-consult.ts`) oder eine Rückfrage
   stellen, zuletzt offene Fäden erkennen. Telegram führt das am Stück aus;
   die WebUI zeigt die Antwort nach dem ersten Schritt und erledigt den Rest
   danach.
8. **Zustellung**: Telegram bekommt HTML in Stücken
   (`src/channels/telegram/send.ts`), Browser und Terminal die Nachricht als
   Ereignis.

Bilder, Dokumente, Sprache und Video bereitet `src/lib/media-turn.ts` vor
dem Turn auf (Ablage unter `uploads/`, Transkription, Bild in den Speicher)
und nach dem Turn nach.

### Zeitlimits und Abbruch

Ein Turn mit Fortschritt endet nach 15 Minuten ohne Lebenszeichen oder nach
90 Minuten insgesamt, einer ohne Fortschritt nach 30 Minuten
(`src/lib/turn-limits.ts`). Nach einem Zeitlimit kommt ein Stand-Bericht,
kein Ersatzmodell; nach `/stop` kommt „Abgebrochen.“ und ebenfalls keines.

## Sessions

Mit `SESSION_MODE=resume` behält jedes Gespräch eine Session des Motors
(`src/lib/session-manager.ts`). Die Zuordnung steht in `data/sessions.json`,
der Schlüssel ist Session-Schlüssel plus Agent, damit eine Befragung im
selben Topic die Session des Topics nicht übernimmt.

- Eine Session verfällt nach `SESSION_IDLE_HOURS` (Standard 18) ohne
  Nachricht, bei einem Wechsel von Modell oder Motor und mit `/new`.
- Hatte sie genug Substanz, liest `src/lib/session-distill.ts` sie ein
  letztes Mal und schlägt Merk-Einträge und Routinen vor, die der Nutzer
  per Knopf annimmt.
- Fehler im Session-Speicher führen zu einer frischen Session, nie zu einer
  blockierten Nachricht.

`session-state.json` im Projektordner hält nur die zuletzt gemeldete Session
für Health-Antwort und Startzeile (`src/app/last-session.ts`).

## Gedächtnis und Suche

Alle Teile lesen und schreiben über einen Speicher (`getStore()` in
`src/lib/store/index.ts`, Schnittstellen in `src/lib/store/ports.ts`):

- **Mit Supabase** (`src/lib/store/supabase/`): Nachrichten, Fakten und
  Ziele, Wissen, Bilder, Aufträge und Protokoll. Das Schema steht in
  `db/schema.sql` und `db/migrations/`. Beim Speichern einer Nachricht
  erzeugt die Edge Function `store-telegram-message` das Embedding, die
  Suche läuft über `search-memory` (`supabase/functions/`). Nachrichten über
  8.000 Zeichen bekommen zusätzlich überlappende Abschnitte von rund 6.000
  Zeichen mit eigenem Embedding (Tabelle `message_chunks`, Teilen in
  `supabase/functions/_shared/chunks.ts`, Nachzug im Bot in
  `src/lib/message-chunks.ts`); die Suche liefert jede Nachricht einmal und
  lange nur als Ausschnitt um die Suchbegriffe.
- **Ohne Datenbank** (`src/lib/store/file/memory.ts`): nur Fakten und Ziele,
  in `memory.json.sqlite` im Projektordner (oder `<MEMORY_FILE_PATH>.sqlite`).
  Eine vorhandene `memory.json` dient nur dem Erstimport. Verlauf, Wissen und
  Suche gibt es dann nicht.

Embeddings erzeugt `src/lib/embedding.ts` mit dem Anbieter aus
`EMBEDDING_PROVIDER`; die Datenbank prüft, dass nur Vektoren desselben
Anbieters verglichen werden. Ohne Embeddings fällt die Suche auf Text
zurück.

Das Modell merkt sich etwas über Tags in der Antwort, etwa `[REMEMBER:]`,
`[GOAL:]`, `[DONE:]` oder `[REMIND:]`. Der Parser steht in
`src/lib/memory/intents.ts`, angewendet wird in `src/lib/memory/service.ts`.
Hat der Turn fremde Inhalte gelesen (Web, Mail, Dateien außerhalb des
Projekts, `src/lib/turn-tools.ts`), werden die Tags nicht angewendet,
sondern als Vorschlag mit Knöpfen gestellt.

## Rückfragen

Jede Frage mit Knöpfen steht genau einmal im Register
(`src/lib/choices.ts`, Ablage `data/choices.json`): Werkzeug-Freigaben,
Merk-Vorschläge, „Weiter?“ bei `/goal`, Topic-Zuordnung, Routinen,
Erinnerungen, offene Fäden und Fragen des Modells. Die erste Entscheidung
gewinnt, auch über Prozessgrenzen; gleich ob der Klick aus Telegram, dem
Browser oder dem Terminal kommt. Der Handler der Art läuft danach genau
einmal. Welche Art welchen Handler hat, verdrahtet `src/app/bot-choices.ts`;
den Browser bedient `src/web/choices.ts`.

## Ersatzmodelle

Endet der Motor mit Fehler oder leerer Antwort, antwortet die
Fallback-Kette (`src/lib/fallback/chain.ts`) in dieser Reihenfolge:

1. Kimi K3 über OpenRouter
2. Claude-CLI mit eigenem Modell (`FALLBACK_CLAUDE_MODEL`)
3. OpenRouter mit einstellbarem Modell
4. Ollama auf diesem Rechner

Ohne `OPENROUTER_API_KEY` entfallen die Stufen 1 und 3, „nur offline“ lässt
nur Ollama übrig. Jede Stufe bekommt den Kontext des Gesprächs
(`src/lib/fallback/context.ts`). Bei den Werkzeugen unterscheiden sich die
Stufen:

- **Kimi K3, OpenRouter, Ollama** bekommen die Werkzeuge der MCP-Server und
  die eingebauten Werkzeuge (`src/lib/tools/registry.ts`) und führen sie
  über tybo aus (`src/lib/fallback/openai-tool-loop.ts`). Ein eingebautes
  Werkzeug mit Freigabepflicht und jedes MCP-Werkzeug, das nicht in
  `MCP_READ_ONLY_TOOLS` steht, wartet auf eine Freigabe per Knopf
  (`src/lib/tool-approval.ts`); ohne Freigabe läuft es nicht.
- **Claude-CLI** führt ihre eigenen Werkzeuge und MCP-Server aus. Was sie
  darf, regeln die Berechtigungen der Claude CLI (ihre Einstellungen und
  `--disallowedTools` in `src/lib/claude.ts`), nicht der Knopf von tybo.

Nebenaufgaben wie der Richter von `/goal`, das Destillat oder die Erkennung
offener Fäden laufen auf eigenen, meist günstigeren Modellen
(`src/lib/aux-model.ts`).

## Hintergrunddienste

Im Bot-Prozess laufen Zeitgeber:

- Erinnerungen (`src/lib/schedule/planner.ts`), alle 30 Sekunden; jeder
  Eintrag wird genau einmal übernommen, verpasste kommen nach dem Start mit
  Hinweis ([mehr](erinnerungen.md))
- Erinnerungen an offene Fäden (`src/lib/threads/remind.ts`), alle
  15 Minuten, nicht in der Ruhezeit
- Routinen-Wache (`src/lib/routines/watch.ts`), alle 10 Minuten; meldet
  ausgebliebene Läufe
- Ziele mit `/goal` (`src/lib/goal-engine.ts`): Arbeits-Turn, Prüfung,
  Richter, nächster Turn

Außerhalb des Bots laufen die Routinen. Jede ruft der Wrapper
`src/routine-run.ts` auf, der Dauer, Exit-Code und die letzten Zeilen unter
`data/routines/` festhält ([mehr](routinen.md)). Check-in und Briefing
teilen die Regeln für Zeitfenster, Ruhezeit und Snooze
(`src/lib/proactive/`); das Briefing setzt seinen Text ohne Modell aus den
Quellen in `src/lib/sources/` zusammen.

Was ein Dienst dem Nutzer mitteilt, geht über die Outbox
(`src/lib/outbox.ts`, `bun run notify`): nach Telegram und als
Nur-Anzeige-Eintrag ins passende Gespräch der WebUI. Solche Einträge gibt
kein Kontext-Leser an ein Modell weiter.

## Daten und Sicherheit

| Ort | Inhalt |
|---|---|
| `.env` | Schlüssel und Grundeinstellungen, Vorlage `.env.example` |
| `config/settings.json` | Einstellungen aus der WebUI, vor `.env` und Code (`src/lib/settings.ts`) |
| `config/topics.json`, `config/agent-overrides.json` | Topic-Zuordnung, Zusätze zu Agenten-Prompts |
| `config/profile.md` | Profil des Nutzers, Vorlage `config/profile.example.md` |
| `data/` | Sessions, Rückfragen, Fäden, Jobs, Routinen-Protokolle, Outbox-Dateien, Anmeldungen der WebUI |
| `uploads/`, `logs/` | Medien aus Gesprächen, Protokolle der Dienste |

Nichts davon steht im Repo. Für die Sicherheit gilt:

- **Ein Nutzer**: Telegram antwortet nur `TELEGRAM_USER_ID`. Die WebUI
  startet nur mit Passwort, lauscht standardmäßig auf `127.0.0.1:3100` und
  prüft Host und Origin (`src/web/auth.ts`,
  [Entscheidung 0002](webui/decisions/0002-sicherheit.md)). Zugang von
  unterwegs nur über Tailscale oder einen Cloudflare Tunnel mit Access
  ([Entscheidung 0022](webui/decisions/0022-zugang-fuer-alle.md)).
- **Geheimnisse in Subprozessen**: Ein Motor erbt keine Variablen, die nach
  Schlüssel aussehen, außer seine MCP-Konfiguration nennt sie oder
  `TYBO_SUBPROCESS_ENV_ALLOW` gibt sie frei (`src/lib/subprocess-env.ts`).
  Ob Claude Code `ANTHROPIC_API_KEY` bekommt, entscheidet allein
  `CLAUDE_AUTH` (`src/lib/engines/claude-auth.ts`).
- **Fremde Inhalte**: Merk-Tags nach fremden Inhalten werden nur
  vorgeschlagen ([Entscheidung 0008](webui/decisions/0008-sicherheit-s1.md)).
- **Werkzeug-Freigaben**: Der Knopf von tybo gilt nur für Werkzeuge, die
  tybo selbst ausführt, also für die Stufen Kimi K3, OpenRouter und Ollama
  (siehe [Ersatzmodelle](#ersatzmodelle)). Die Ersatzstufe Claude-CLI
  richtet sich nach den Berechtigungen der Claude CLI.
- **Schlüssel im Browser**: schreibbar nur mit `WEB_ALLOW_KEY_EDIT=true`,
  nie lesbar ([Entscheidung 0003](webui/decisions/0003-schluessel-im-browser.md)).
- **Logs**: nur Namen, Kennungen und feste Sätze, keine Werte von
  Schlüsseln und keine Merk-Inhalte.
