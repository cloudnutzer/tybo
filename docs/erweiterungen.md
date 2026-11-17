# tybo erweitern

`tybo setup` richtet das ein, was jeder braucht (siehe
[einrichtung.md](einrichtung.md)). Alles Weitere steht hier, je ein Abschnitt:
was es bringt, was du brauchst, wie du es einrichtest und wie du prüfst, ob es
geht. Werte für die `.env` sind in [`.env.example`](../.env.example) erklärt.
Nach einer Änderung an der `.env` braucht der Bot einen Neustart.

## Agenten anpassen

**Was es bringt:** Jeder der acht Agenten (General, Research, Content,
Finance, Strategy, Critic, CTO, COO) bekommt dauerhaft eigene Anweisungen,
etwa kürzere Antworten oder eine feste Form, ohne dass du Code änderst.

**Was du brauchst:** nichts außer dem laufenden Bot.

**Einrichten:** In Telegram, im Browser oder im Terminal-Chat
`/agent <name>: <anweisung>` schicken, zum Beispiel
`/agent research: antworte kürzer`. Die Anweisungen landen je Agent als Liste
in `config/agent-overrides.json` und werden an dessen System-Prompt gehängt.
Du kannst die Datei auch von Hand bearbeiten.

**Prüfen:** Eine Änderung greift ab der nächsten frischen Sitzung; `/new` im
Gespräch erzwingt das sofort. Danach eine Frage an den Agenten stellen.

## Topics zuordnen

**Was es bringt:** In einer Telegram-Forum-Gruppe antwortet in jedem Topic
ein fester Agent, etwa Research im Topic „Recherche“.

**Was du brauchst:** die Forum-Gruppe aus dem Schritt `gruppe` von
`tybo setup`, mit dem Bot als Admin, und ein Topic je Agent.

**Einrichten:** `config/topics.example.json` nach `config/topics.json`
kopieren. Außen stehen Chat-IDs (oder `*` für alle Chats), innen Topic-IDs,
als Wert der Agent (`general`, `research`, `content`, `finance`, `strategy`,
`critic`, `cto`, `coo`). Die Topic-ID zeigt `/topics`, im jeweiligen Topic
geschickt. Schreibst du in einem Topic ohne Zuordnung, fragt tybo einmal mit
Knöpfen, welcher Agent es übernimmt, und trägt die Antwort ein.

**Prüfen:** `/topics` im Topic nennt die Zuordnung für diesen Chat.

## Eigener Bot je Agent

**Was es bringt:** Antworten eines Agenten kommen von einem eigenen
Telegram-Bot mit eigenem Namen. Eine Erwähnung wie `@deinresearchbot` holt
diesen Agenten in ein beliebiges Topic.

**Was du brauchst:** je Agent einen Bot von
[@BotFather](https://t.me/BotFather) (`/newbot`).

**Einrichten:** Das Token je Agent in die `.env`:
`TELEGRAM_BOT_TOKEN_<KENNUNG>`, die Kennung des Agenten groß geschrieben,
ein Bindestrich wird zum Unterstrich (`TELEGRAM_BOT_TOKEN_RESEARCH`,
`TELEGRAM_BOT_TOKEN_CTO` usw.). Die Bots senden nur, einen Webhook brauchen
sie nicht; wer erwähnt werden soll, muss in der Gruppe sein. Fehlt ein Token,
schreibt dieser Agent über den Haupt-Bot. Wie oft sich Agenten in einer
Antwort gegenseitig fragen dürfen, begrenzt `AGENT_INVOKE_BUDGET`
(Standard 3).

**Prüfen:** Nach dem Neustart eine Frage im Topic des Agenten stellen; die
Antwort kommt vom neuen Bot.

## Check-in und Morgenbriefing

**Was es bringt:** tybo meldet sich von selbst: morgens mit einem Briefing
(Ziele, Termine, Mails, Aufgaben, News aus den Datenquellen) und tagsüber mit
kurzen Check-ins, wenn es etwas zu sagen gibt.

**Was du brauchst:** macOS (launchd) oder Linux (systemd-Timer, ohne systemd
cron). Unter Windows gibt es keine Dienste dafür. Die Timer laufen in der
Zeitzone aus `USER_TIMEZONE`, auch wenn der Server auf UTC steht.

**Einrichten:** `tybo dienste` richtet alle Dienste ein, einzeln mit
`tybo dienste smart-checkin` bzw. `tybo dienste morning-briefing`.
Standard: Check-ins stündlich von 10:30 bis 18:30 mit mindestens 90 Minuten
Abstand, das Briefing einmal am Tag zwischen 9 und 12 Uhr, Ruhezeit 21 bis
8 Uhr. Ändern lässt sich das im Block `proactive` von `config/settings.json`.
Nach einer Änderung der Zeiten `tybo dienste` noch einmal ausführen.

**Prüfen:** `bun run briefing --dry-run` bzw. `bun run checkin --dry-run`
zeigen, was gerade käme, ohne etwas zu senden. `/routinen` zeigt die Dienste
mit ihren letzten Läufen.

## Nachtcheck

**Was es bringt:** Jede Nacht um 03:30 ein kurzer Bericht mit ✅, ⚠️ und ❌:
ob der Bot läuft und antwortet, ob der eingestellte Motor (Claude Code,
Codex, OpenCode oder die Anthropic API) installiert und angemeldet ist,
Telegram, Datenbank, Ersatzmodelle, Plattenplatz und ob Check-in, Briefing
und Wartung pünktlich liefen. Gerade auf einem Server ohne Bildschirm
erfährst du so von selbst, dass der Bot steht.

**Was du brauchst:** macOS (launchd) oder Linux. Unter Linux läuft er als
systemd-Timer in der Zeitzone aus `USER_TIMEZONE`, auf Rechnern ohne systemd
unter PM2 (Zeitplan in der Zeitzone des Systems), ohne PM2 als cron-Zeile.

**Einrichten:** `tybo dienste health-check` (in `tybo dienste` ohne Angabe
enthalten). Unter PM2 läuft der erste Bericht sofort beim Einrichten. Wer
den Nachtcheck vorher unter PM2 hatte und jetzt systemd nutzt: `tybo
dienste` entfernt den PM2-Eintrag `tybo-health-check` und sichert die
PM2-Liste mit `pm2 save --force`, auch wenn sie danach leer ist. Läuft PM2
gerade nicht, streicht `tybo dienste` den Eintrag aus der gesicherten Liste
(`dump.pm2`), damit er beim Hochfahren nicht zurückkommt. Lässt sich die
PM2-Liste oder ihre Sicherung nicht lesen, der Eintrag nicht entfernen oder
die Liste nicht sichern, bleibt es beim Zeitplan unter PM2, und `tybo
dienste` meldet einen Fehler; nie laufen beide. Lassen sich alte
cron-Zeilen nicht entfernen, wird der Timer wieder abgeschaltet und es gilt
die cron-Zeile. Ohne systemd und ohne antwortende PM2-CLI entsteht keine
cron-Zeile, solange PM2 den Nachtcheck führt oder gesichert hat oder das
unklar ist.

**Wie er den Bot prüft:** Die Zeile „Bot-Prozess“ fragt launchd, systemd
(`tybo-telegram-relay.service`) oder PM2 (`tybo-telegram-relay`), ohne PM2
zu starten. Die Zeile „Bot antwortet“ fragt den Health-Port des Bots
(`http://127.0.0.1:<HEALTH_PORT>/health`, Standard 3000). Steht der Bot,
stehen beide als ❌ im Bericht. Der Bericht kommt wie jede Nacht genau
einmal, über Telegram, falls eingerichtet, und in der WebUI. Ohne Telegram
liegt er nur in der WebUI, und die steht mit dem Bot: Du siehst ihn erst,
wenn der Bot wieder läuft.

**Prüfen:** `bun run health -- --no-send` zeigt den Bericht, ohne ihn zu
senden; `--no-model` lässt den kurzen Probeaufruf an Claude Haiku weg.
`/routinen health-check` zeigt die letzten Läufe.

## Wartung

**Was es bringt:** tybo räumt einmal die Woche Posten weg, die sich
gefahrlos neu erzeugen lassen: Test-Simulatoren von Xcode, Download- und
Build-Caches, zu große eigene Logs. Danach kommt eine Meldung, wie viel
Platz frei wurde.

**Was du brauchst:** macOS (launchd) oder Linux (systemd-Timer, ohne systemd
cron). Unter Linux fallen die Xcode-Posten weg.

**Einrichten:** `tybo dienste wartung` (sonntags 03:15; `tybo dienste` ohne
Angabe lässt sie weg). Welche Simulatoren als Test-Geräte gelten, legst du
in `config/wartung.json` fest (Vorlage `config/wartung.example.json`); ohne
Muster bleiben alle Geräte bis auf die nicht verfügbaren.

**Dienste nach Updates:** Nennt `config/wartung.json` unter `dienste` einen
Dauerdienst (die Vorlage: den Cloudflare-Tunnel), startet die Wartung ihn
neu, wenn er älter läuft als installiert, ebenso `bun run updates --apply`.
Ohne Eintrag wird kein Dienst angefasst
([mehr](routinen.md#dienste-nach-updates-neu-starten)).

**Prüfen:** `tybo wartung --dry-run` zeigt, was gelöscht bzw. neu gestartet
würde, mit Größen, ohne etwas zu löschen, zu starten oder zu senden. Was
genau angefasst wird und was nie:
[Routinen, Abschnitt Wartung](routinen.md#wartung).

## Datenquellen

**Was es bringt:** Mehr Inhalt fürs Briefing. Ziele sind immer dabei,
Kalender und Gmail richtet der Schritt `google` ein. Hier geht es um die
übrigen Quellen.

**Was du brauchst und wie du es einrichtest:**

- **News:** Standard ist xAI mit `XAI_API_KEY` (Schlüssel von
  [x.ai](https://x.ai)). Mit `NEWS_PROVIDER=openrouter` kommen die News über
  OpenRouter mit `OPENROUTER_API_KEY`. Das Modell legt `NEWS_MODEL` fest.
  Es erscheinen nur Meldungen mit Quelle.
- **Notion:** eine Integration unter
  [notion.so/my-integrations](https://www.notion.so/my-integrations) anlegen,
  die Aufgaben-Datenbank mit ihr teilen, dann `NOTION_TOKEN` und
  `NOTION_DATABASE_ID` setzen. Die Datenbank braucht eine Datumseigenschaft
  „Due“ und eine Status-Eigenschaft „Status“ mit dem Wert „Done“. Das
  Briefing zeigt fällige und überfällige Aufgaben.
- **Eigene Quelle:** `src/lib/sources/example.ts` kopieren, etwa nach
  `src/lib/sources/wetter.ts`, Kennung, Zugangsdaten und Abruf anpassen und
  die Quelle in `SOURCES` in `src/lib/sources/list.ts` aufnehmen. Die Regeln
  stehen oben in der Vorlage.

Jede Quelle schaltet sich ein, sobald ihre Variablen gesetzt sind.

**Prüfen:** `bun run briefing --dry-run`. Scheitert eine eingerichtete
Quelle, steht an ihrer Stelle „Konnte nicht abgerufen werden“, und der Lauf
endet mit Exit-Code 1; eine nicht eingerichtete Quelle fehlt still.

## Sprachnachrichten und Cloud-Stimmen

**Was es bringt:** Sprachnachrichten in Telegram werden in Text umgewandelt,
und tybo kann mit Stimme antworten. Im Browser hören und sprechen
Sprechmodus und Telefonhörer.

**Was du brauchst:** Den lokalen Weg (Parakeet zum Hören, Pocket TTS oder
Piper zum Vorlesen) richtet `tybo setup sprache` ein. Für Anbieter in der
Cloud brauchst du deren Schlüssel: Gemini (`GEMINI_API_KEY`, hört und
spricht) oder ElevenLabs (`ELEVENLABS_API_KEY`, als Stimme dazu
`ELEVENLABS_VOICE_ID`). Text bzw. Aufnahme gehen dann an den Anbieter.

**Einrichten:** Schlüssel in die `.env`. Die Wahl treffen `SPEECH_STT` und
`SPEECH_TTS` (Standard `auto`) oder die WebUI unter Einstellungen, Reiter
„Sprechen“; die WebUI hat Vorrang. Sprachantworten in Telegram kommen nur von
Anbietern auf dem Server (Qwen3-TTS auf dem Mac, ElevenLabs, Gemini), nicht
von der Stimme des Browsers. Alles Weitere: [sprechen.md](sprechen.md).

**Prüfen:** In Telegram eine Sprachnachricht schicken; tybo antwortet auf
ihren Inhalt. `tybo pruefen` meldet den Stand der Sprache.

## Anrufe

**Was es bringt:** tybo ruft dich übers Telefonnetz an, auf `/anruf [anlass]`
oder über den Knopf „Anrufen“ unter Check-in und Briefing. Nach dem Gespräch
kommt eine Zusammenfassung in den Chat.

**Was du brauchst:** ein ElevenLabs-Konto mit Agent und einer Telefonnummer
(etwa über Twilio), dazu `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`,
`ELEVENLABS_PHONE_NUMBER_ID` und deine Nummer in `USER_PHONE_NUMBER`.

**Einrichten:** Die vier Werte in die `.env`. Damit der Agent den Anlass
kennt, braucht er unter „Custom LLM“ zwei Request-Header; beschrieben in
[sprechen.md](sprechen.md#anruf-von-tybo-elevenlabs-und-twilio). Liegt die
Nummer an einem SIP-Trunk (etwa an der eigenen Vermittlung für einen
easybell-Anschluss), dazu `ELEVENLABS_PHONE_PROVIDER=sip_trunk`; siehe
[sprechen.md](sprechen.md#anrufannahme-über-eigene-vermittlung).

**Prüfen:** `/anruf Test` schicken. Fehlt eine Variable, nennt tybo sie und
ruft nicht an.

## MCP-Server

**Was es bringt:** MCP-Server geben tybo Werkzeuge, etwa für Mail, Kalender
oder Aufgaben. Claude Code nutzt die Server aus deiner Claude-Code-Einrichtung
von selbst. Damit auch die Ersatzmodelle (OpenRouter, Ollama) sie haben,
startet tybo sie selbst.

**Was du brauchst:** die Server, die du nutzen willst, und ihre Schlüssel in
der `.env`.

**Einrichten:** tybo nimmt drei Quellen, bei gleichem Namen gilt die frühere:
`config/mcp-servers.json` im Projekt (Vorlage
`config/mcp-servers.example.json`, lokale Server mit `command` und `args`,
entfernte mit `"type": "http"`), dann die Datei aus `MCP_CONFIG_PATH`, dann
`~/.claude.json` (lokale Server nur, wenn sie mit Bun laufen). Platzhalter
wie `${NAME}` ersetzt tybo aus der `.env`. Schreibende Werkzeuge fragen vor
jedem Aufruf mit Knöpfen nach; rein lesende dürfen in `MCP_READ_ONLY_TOOLS`
als `server/werkzeug` stehen. Die Server liest der Bot nur beim Start ein:
Nach einer Änderung an `config/mcp-servers.json` (oder der Datei aus
`MCP_CONFIG_PATH`) braucht er einen Neustart.

**Prüfen:** `bun run test:tools` startet die Server in einem eigenen Prozess
und meldet, welche Werkzeuge ein Ersatzmodell bekommt. Den laufenden Bot
ändert der Test nicht; dort greift die neue Liste erst nach dem Neustart.

## Server und Hybrid

**Was es bringt:** tybo läuft auf einem Server rund um die Uhr. Im
Hybrid-Betrieb nimmt der Server alle Nachrichten an und reicht sie an deinen
eigenen Rechner weiter, solange der wach ist; sonst antwortet der Server.

**Was du brauchst:** einen Server mit Bun und einem Motor: Claude CLI (für
Claude Code dort `CLAUDE_AUTH=apiKey` mit `ANTHROPIC_API_KEY`) oder Codex
ohne Claude-Konto ([server.md](server.md), mit der Tabelle, was dann geht).
Nur für den Webhook (Profil `server`) und damit für Hybrid eine öffentliche
`https`-Adresse (Reverse-Proxy oder Tunnel); ein Server, der wie zu Hause
per Polling abholt, braucht keine. Für Hybrid dasselbe Supabase-Projekt auf
beiden Rechnern.

**Einrichten:** Auf dem Server `TYBO_PROFILE=server` mit
`TELEGRAM_WEBHOOK_SECRET` und `TELEGRAM_WEBHOOK_URL`; der Bot trägt den
Webhook dann selbst bei Telegram ein. Für Hybrid zusätzlich
`HYBRID_PEER_URL` und `GATEWAY_SECRET` auf dem Server, `TYBO_PROFILE=peer`
und dasselbe `GATEWAY_SECRET` auf dem eigenen Rechner. Alle Variablen,
Ausrollen und der Weg zurück zum Polling:
[telegram-webhook.md](telegram-webhook.md). `USE_AGENT_SDK` aus älteren
Anleitungen liest tybo nicht mehr (Issue #352).

**Prüfen:** vom Server aus `curl <HYBRID_PEER_URL>/health`; beim Start nennt
das Log `[hybrid] Hybrid aus: …`, wenn etwas fehlt.

## Linux: Dienste nach Neustart

**Was es bringt:** Der Bot startet nach einem Neustart des Rechners von
selbst, auch ohne dass du dich anmeldest.

**Was du brauchst:** je nach Weg im Schritt `autostart` PM2 oder systemd.

**Einrichten:**

- **PM2:** einmal `pm2 startup` und die Zeile ausführen, die PM2 dann
  ausgibt (meist mit `sudo`). Die Dienstliste speichert `tybo setup` bzw.
  `tybo dienste` selbst mit `pm2 save`.
- **systemd-Benutzerdienst:** Linger muss an sein, sonst startet der Dienst
  erst bei der Anmeldung. Der Assistent versucht es ohne Administratorrechte;
  klappt das nicht, einmal `sudo loginctl enable-linger <dein-name>`.

**Prüfen:** `loginctl show-user $USER -p Linger` zeigt `Linger=yes`; unter
PM2 `pm2 list` nach einem Neustart. Mehr:
[einrichtung.md](einrichtung.md#autostart-mit-systemd).

## Prüfbericht

**Was es bringt:** Ein Bericht über alles auf einmal: jeden Schritt der
Einrichtung, die Kanäle, den Motor, Telegram, Datenbank, Dienste und Sprache.
Der Abschnitt „Motor“ prüft den Standard-Motor (Einstellungen, sonst
`TYBO_ENGINE`, sonst Claude Code): installiert und angemeldet, mit dem `PATH`
aus der Dienstdatei des Bots. Unter macOS ist ein Bot, der geladen ist, aber
nicht läuft, ein Fehler wie unter Linux.

**Was du brauchst:** nichts; der Befehl schickt keine Testnachricht, schreibt
nichts in die Datenbank und ruft kein Modell auf.

**Einrichten:** nichts. `tybo pruefen` ausführen (gleich:
`bun run setup:verify`).

**Prüfen:** Exit-Code 0 heißt in Ordnung (auch mit Warnungen), 1 heißt, dass
etwas fehlgeschlagen ist; die Zeilen mit ✗ sagen, was.
