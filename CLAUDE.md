# tybo

tybo ([tybo.ai](https://tybo.ai), Befehl `tybo`) ist ein Assistent, der rund um
die Uhr läuft. Er nimmt Nachrichten aus Telegram, dem Browser (WebUI) und dem
Terminal an, lässt sie von Claude Code beantworten und merkt sich Fakten, Ziele
und Verlauf. Dazu gehören acht Agenten, Erinnerungen, Routinen, Check-ins, ein
Morgenbriefing und Sprache. Name, Befehl, Domain und Repo stehen in
`src/brand.ts` (`BRAND`); Variablen heißen `TYBO_*`, Dienste `ai.tybo.*`
(launchd) bzw. `tybo-*` (PM2, systemd).

Überblick und Betrieb: [`README.md`](README.md). Einrichtung Schritt für
Schritt: [`docs/einrichtung.md`](docs/einrichtung.md). Was danach von Hand
dazukommt: [`docs/erweiterungen.md`](docs/erweiterungen.md).

Die Abschnitte bis „Erinnerungen“ gelten nur, wenn jemand tybo mit Claude Code
einrichten will. Im laufenden Bot ist dafür nichts zu tun.

## Anmeldung von Claude Code

`CLAUDE_AUTH` in der `.env` legt fest, wie Claude Code abrechnet (Code:
`src/lib/engines/claude-auth.ts`, Erklärung: `.env.example`):

- `subscription`: über das Claude-Abo. `ANTHROPIC_API_KEY` gelangt in keinen
  Claude-Subprozess und bleibt für den Motor `api` und Bildbeschreibungen.
- `apiKey`: nach Verbrauch mit `ANTHROPIC_API_KEY`. Fehlt der Schlüssel,
  startet Claude Code nicht; einen stillen Rückfall aufs Abo gibt es nicht.
- ohne Wert: `apiKey`, wenn `ANTHROPIC_API_KEY` gesetzt ist, sonst
  `subscription`. Ein ungültiger Wert zählt wie keiner, mit Warnung im Log.

Im Abo zählt `/credit` den Verbrauch mit. Vor dem Limit des Abos schützt das
nicht.

## Einrichten mit Claude Code

Erst die Bestandsaufnahme (nächster Abschnitt), dann einer der beiden Wege:

1. **Neuer Rechner** (macOS, Linux, WSL): `curl -fsSL https://tybo.ai/install | sh`.
   Der Installer prüft Git und Bun, klont nach `~/tybo` (anderer Ordner mit
   `--dir`), führt `bun install` und `bun link` aus und startet danach den
   Assistenten. Node.js, die Claude CLI und PM2 installiert er nicht.
   Optionen und Updates: [`docs/einrichtung.md`](docs/einrichtung.md),
   „Schnellweg: ein Befehl“.
2. **Vorhandener Checkout:** `bun install`, `bun link`, dann `tybo setup`
   (ohne `bun link`: `bun run setup`). `tybo setup --web` führt im Browser
   durch, `tybo setup <schritt>` nur durch einen Schritt, `tybo setup --liste`
   zeigt die Übersicht.

Die Schritte stehen in `src/setup/steps.ts`. Pflicht sind `voraussetzungen`,
`datenbank`, `profil` und `autostart`; außerdem muss Telegram oder die WebUI
eingerichtet sein (`src/setup/channels.ts`).

- `voraussetzungen`: prüft Bun, Claude CLI und Git, installiert nichts
- `telegram`: Bot-Token von @BotFather, eigene Nutzer-ID, Testnachricht
- `gruppe`: ID einer Telegram-Forum-Gruppe für Topics
- `datenbank`: Supabase in der Cloud (Standard, mit einem Zugangstoken `sbp_…`,
  das nirgends gespeichert wird), auf diesem Rechner in Docker oder mit
  eigenen Zugangsdaten
- `suche`: semantische Suche über Embeddings; ohne sie gibt es Textsuche
- `profil`: Name, Zeitzone und Beruf in `config/profile.md`
- `modelle`: Standardmodell, Effort und Ersatzmodelle (OpenRouter, Ollama)
- `sprache`: Hören mit Parakeet auf diesem Rechner, Stimme fürs Vorlesen,
  Telefonhörer
- `webui`: Chat im Browser mit Passwort
- `zugang`: die WebUI vom Handy aus, über Tailscale, einen Cloudflare Tunnel
  oder nur auf diesem Rechner
- `google`: Google-Kalender und Gmail, nur lesend
- `autostart`: der Bot als Dienst, unter macOS mit launchd, unter Linux als
  systemd-Benutzerdienst (PM2 wählbar), sonst mit PM2

Am Ende fasst die Gesamtprüfung zusammen. Denselben Bericht mit Exit-Code
liefert `tybo pruefen`.

## Bestandsaufnahme vor der Einrichtung

Vorher prüfen und kurz berichten, ohne Werte aus der `.env` zu zeigen:

1. **Git:** `git remote get-url origin` zeigt auf `BRAND.repo`
   (`cloudnutzer/tybo`, HTTPS oder SSH). Ohne `.git` (ZIP-Download) oder mit
   anderem Remote kommen keine Updates. Dann frisch installieren:
   `curl -fsSL https://tybo.ai/install | sh -s -- --dir ~/tybo-neu --no-setup`.
   Der Nutzer entfernt die Dienste des alten Ordners mit
   `TYBO_ROOT=<alter-absoluter-Pfad> tybo deinstallieren` (Daten bleiben).
   Ohne `TYBO_ROOT` nimmt der Befehl den Ordner, auf den `tybo` verlinkt ist,
   und das ist nach dem Installer schon der neue; die Schutzliste
   `config/routines.json` des alten Ordners bliebe dann unbeachtet. Erst
   danach kopiert er `.env`, `data/`, das lokale Gedächtnis und aus `config/`
   die Dateien, die es im neuen Ordner noch nicht gibt. Zum Gedächtnis gehören
   `memory.json` und `memory.json.sqlite`; mit eigenem `MEMORY_FILE_PATH`
   dieser Pfad und `<MEMORY_FILE_PATH>.sqlite`, denn die aktuellen Fakten und
   Ziele stehen in der `.sqlite`-Datei, die JSON-Datei dient nur dem
   Erstimport. Liegt der Pfad im alten Ordner oder ist er relativ, beide
   Dateien in den neuen Ordner kopieren und `MEMORY_FILE_PATH` in der neuen
   `.env` anpassen, falls er noch auf den alten Ordner zeigt. Danach im neuen
   Ordner `tybo setup`.
2. **`.env`:** Welche Werte sind gesetzt (keine Platzhalter)? `tybo setup`
   erkennt sie und zeigt sie nur als „gesetzt“.
3. **Laufende Dienste:** `launchctl list | grep ai.tybo` (macOS),
   `pm2 list` (Namen `tybo-*`), `systemctl --user list-units 'tybo-*'`
   (Linux). Zwei Bots mit demselben Telegram-Token: der zweite pausiert nur den Eingang (409,
   `tybo pruefen` meldet Fehler, [mehr](docs/troubleshooting.md#zwei-bots-laufen-gleichzeitig)); anhalten nur nach Rückfrage.
4. **`CONVEX_URL`:** Convex wird nicht mehr unterstützt, der Bot übergeht den
   Wert. Umstieg: [`docs/einrichtung.md`](docs/einrichtung.md), „Umzug von
   Convex“.

Danach nur die Schritte durchgehen, die `tybo setup --liste` als offen zeigt.

## Was `tybo setup` nicht macht

- Agenten anpassen: `/agent <name>: <anweisung>`, gespeichert in
  `config/agent-overrides.json` ([mehr](docs/erweiterungen.md#agenten-anpassen))
- Topics zuordnen: `config/topics.json` nach `config/topics.example.json`,
  `/topics` zeigt die Zuordnung ([mehr](docs/erweiterungen.md#topics-zuordnen))
- Eigener Telegram-Bot je Agent: `TELEGRAM_BOT_TOKEN_<KENNUNG>` in der `.env`
  ([mehr](docs/erweiterungen.md#eigener-bot-je-agent))
- Check-in und Morgenbriefing als Dienste: `tybo dienste`
  ([mehr](docs/erweiterungen.md#check-in-und-morgenbriefing))
- Datenquellen außer Google: News, Notion, eigene unter `src/lib/sources/`
  ([mehr](docs/erweiterungen.md#datenquellen))
- Sprachnachrichten und Stimmen aus der Cloud: Gemini, ElevenLabs
  ([mehr](docs/erweiterungen.md#sprachnachrichten-und-cloud-stimmen))
- Anrufe von tybo: `/anruf` mit ElevenLabs und Twilio
  ([mehr](docs/erweiterungen.md#anrufe))
- MCP-Server: `config/mcp-servers.json` oder `~/.claude.json`, Test mit
  `bun run test:tools` ([mehr](docs/erweiterungen.md#mcp-server))
- Server-Betrieb und Hybrid: `TYBO_PROFILE`, `docs/telegram-webhook.md`
  ([mehr](docs/erweiterungen.md#server-und-hybrid))
- Linux-Dienste nach Neustart und Abmelden: `pm2 startup` bzw.
  `sudo loginctl enable-linger` ([mehr](docs/erweiterungen.md#linux-dienste-nach-neustart))
- Prüfbericht: `tybo pruefen` ([mehr](docs/erweiterungen.md#prüfbericht))

## Erinnerungen

Erinnerungen sind eingebaut, einzurichten ist nichts, Convex ist nicht nötig.
Sie liegen in Supabase oder, ohne Datenbank, in einer Datei unter `data/`.
Eine Erinnerung kommt nur, solange der Bot läuft; eine verpasste kommt nach
dem nächsten Start und ist als verspätet markiert. `/erinnerungen` listet,
`/erinnerungen absagen <kennung>` sagt ab, `tybo erinnerungen importieren`
übernimmt eine alte `config/reminders.json`. Mehr:
[`docs/erinnerungen.md`](docs/erinnerungen.md).

## Regeln im Betrieb

Diese Datei liest auch der laufende Bot: Jeder Claude-Subprozess startet im
Projektordner. Für ihn gilt:

- **Neustart:** nie `launchctl kickstart`, `launchctl unload/load` oder
  `kill` gegen den Bot. Beim Beenden fallen alle Subprozesse, auch der, der
  gerade antwortet; beim Nutzer käme nur „Abgebrochen.“ an. Stattdessen
  `bun run restart:request "Grund"`: Der Bot startet neu, sobald keine
  Antwort mehr läuft, launchd, systemd oder PM2 holen ihn zurück
  ([mehr](docs/troubleshooting.md#antwort-nach-einer-code-änderung-durch-abgebrochen-ersetzt)).
- **Dateien und Meldungen** an den Nutzer gehen mit `bun run notify`, nicht
  mit eigenem `curl`. Ziel ist das Gespräch aus `TYBO_CONVERSATION_ID`,
  `TYBO_TOPIC_ID` und `TYBO_CHAT_ID`, ohne sie der Direktchat. Über die
  Outbox (`src/lib/outbox.ts`) erscheint alles auch in der WebUI, ohne
  Telegram nur dort.
- **Lange Aufträge** laufen als Hintergrund-Job (`bun run job start`, auch
  `--engine codex`), nie per `setsid` oder `claude -p` im Hintergrund; der Bot
  bietet sie nur mit Claude Code an ([Server](docs/server.md)). Ein Job meldet sich
  immer, auch nach Absturz. `--full-access` nur für selbst formulierte Aufträge ([mehr](docs/hintergrund-jobs.md)).
- **Hooks:** Subprozesse tragen `TYBO_SUBPROCESS=1`. Liefert ein `Stop`-Hook
  `additionalContext`, antwortet Claude ein zweites Mal und nur das Letzte
  kommt an. Solche Hooks in `.claude/settings.local.json` mit
  `[ -n "$TYBO_SUBPROCESS" ] ||` davor ausschalten
  ([mehr](docs/troubleshooting.md#antwort-handelt-von-etwas-anderem)).
- **Geheimnisse:** Namen wie `*_TOKEN`, `*_KEY`, `*_SECRET`, `SUPABASE_*`
  oder `TELEGRAM_*` erbt ein Subprozess nur, wenn eine MCP-Konfiguration sie
  nennt oder `TYBO_SUBPROCESS_ENV_ALLOW` sie freigibt. `ANTHROPIC_API_KEY`
  richtet sich bei Claude allein nach `CLAUDE_AUTH`; für Codex und OpenCode
  gelten eigene Regeln (`src/lib/subprocess-env.ts`,
  [mehr](docs/troubleshooting.md#subprozess-vermisst-eine-variable)).
- **Daten für Hintergrundskripte** (Mail, Kalender) kommen über REST, nie über
  einen Claude-Subprozess: der startet erst minutenlang alle MCP-Server.
- **launchd-Plists** führen `~/.local/bin` als absoluten Pfad im `PATH`, sonst
  fehlt die Claude CLI und der Bot weicht still auf Ersatzmodelle aus.
- **Neue Routinen** rufen den Wrapper `src/routine-run.ts` auf und halten
  die Regel „keine alten Daten“ ein
  ([Muster](docs/routinen.md#neue-routine-anlegen)).

## Arbeit am Code

Wer an tybo entwickelt, statt es zu betreiben, startet oder importiert
`src/bot.ts` nie (er würde mit demselben Telegram-Token pollen wie der laufende
Bot) und ruft weder `restart:request` noch `launchctl` auf. Ausprobieren
geht mit `bun run web:dev`, vor jedem Commit läuft `bun run check`. Die
Befehle im nächsten Abschnitt dienen dem Betrieb; sie sind keine
Aufforderung zum Testen.

## Befehle

| Befehl | Wozu |
|---|---|
| `tybo` | Chat im Terminal; `tybo help` zeigt alle Unterbefehle |
| `tybo routinen` | Routinen wie `/routinen`; `einbinden`, `ausbinden` je Label (macOS) |
| `tybo dienste` | Dienste einrichten; `software-update` und `wartung` nur, wenn genannt |
| `tybo pruefen` | Prüfbericht über die Einrichtung, mit Exit-Code |
| `tybo deinstallieren` | Dienste entfernen; Ordner, `.env` und Daten bleiben |
| `bun run start` | Bot im Profil `local` (Polling); `bun run vps` im Profil `server` |
| `bun run web:dev` | nur der Web-Server, ohne Telegram und ohne Bot |
| `bun run check` | Typprüfung und alle Tests |
| `bun run notify` | `--source <name>` mit `--text` oder `--file`, dazu `--caption`, `--topic` |
| `bun run nachschlagen` | `"<suchtext>"` sucht in Fakten, Nachrichten, Wissensbasis und Bildern, Ausgabe als JSON; nur lesend |
| `bun run job` | `start --title <titel> --brief <datei>`, `list`, `stop <id>`, `resume <id>`, `log <id>` |
| `bun run limits` | `set --engine <motor> --window <kennung> --percent <zahl>` oder `set --stdin` liefert eigene Messwerte; `show` liest den Stand ([Format](docs/erweiterungen.md#eigene-messwerte-für-limits)) |
| `bun run restart:request` | Neustart, sobald die laufende Antwort fertig ist |
| `bun run checkin`, `bun run briefing` | Check-in bzw. Morgenbriefing einmal von Hand |
| `bun run health` | Nachtcheck; `--no-send` nur anzeigen, `--no-model` ohne Modell |
| `bun run updates` | Claude Code und Codex aktualisieren; `--apply` auch Bun und Homebrew, `--smoke` nur prüfen |

Logs liegen in `logs/`, Fehler der Claude CLI in `logs/telegram-relay.error.log`. Kommt keine Antwort oder eine vom Ersatzmodell, scheitert meist die Claude
CLI (Anmeldung, Abo-Limit, `PATH`); mehr in [Störungen](docs/troubleshooting.md).

## Wo was steht

- Ein Turn: `src/lib/chat-turn.ts`; Merk-Tags, `/goal` und Fäden: `src/lib/turn-finish.ts`
- Motoren: `src/lib/engines/`; Ersatzmodelle mit eingeschränktem Werkzeugumfang: `src/lib/fallback/`
- Motorwechsel: `src/lib/engine-switch.ts`; Messwerte: `src/lib/engines/usage.ts`
- Werkzeuge für Codex: `src/lib/engines/codex-mcp.ts`, `src/lib/engines/codex-skills.ts`, `src/lib/engines/claude-notes.ts`, `src/lib/engines/tool-parity.ts`
- Sessions pro Topic (`SESSION_MODE=resume`, `/new`):
  `src/lib/session-manager.ts`, [Konzept](docs/topic-sessions.md)
- Gedächtnis und Tags wie `[REMEMBER:]`: `src/lib/memory/`; Tags nach
  fremden Inhalten nur als Vorschlag: `src/lib/intent-gate.ts`
- Vorschläge beim Session-Ende: `src/lib/session-distill.ts`; `/kern`: `src/lib/memory/core.ts`; Geheimnisse: `src/lib/memory/secrets.ts`
- `/goal`: `src/lib/goal-engine.ts`; `/stop`: `src/lib/engines/calls.ts`
- `/agent`: `src/lib/agent-overrides.ts`; Erwähnung eines Agenten-Bots:
  `src/channels/telegram/identities.ts`
- Nebenaufgaben auf eigenen Modellen: `src/lib/aux-model.ts`
- Rückfragen mit Knöpfen, in Telegram und im Browser: `src/lib/choices.ts`
- Werkzeuge und ihre Freigabe: `src/lib/tools/registry.ts`
- `/routine` (Session wird Routine): `src/lib/session-routine.ts`;
  Übersicht und Verlauf: `src/lib/routines/`, [Doku](docs/routinen.md)
- Offene Fäden (`/faeden`): `src/lib/threads/`; Erinnerungen: `src/lib/schedule/`; Proaktives: `src/lib/proactive/`; Speicher: `src/lib/store/`
- Hintergrund-Jobs: `src/lib/jobs/`; Neustart: `src/lib/restart-request.ts`

## Projektstruktur

- `src/bot.ts`: Einstieg des Bots, nur Verdrahtung
- `src/app/`: Start, Beenden, Neustart, Health-Server, Hybrid
- `src/channels/`: Telegram und WhatsApp
- `src/agents/`: die acht Agenten, Prompts, Zuordnung zu Topics
- `src/lib/`: Kern (Turns, Motoren, Gedächtnis, Werkzeuge, Sprache)
- `src/web/`: WebUI, Server und Oberfläche ([Doku](docs/webui/README.md))
- `src/terminal/`: Chat im Terminal
- `src/setup/`: `tybo setup`, Prüfbericht, Dienste
- `src/routines/`: Check-in und Morgenbriefing
- `scripts/`: Befehl `tybo`, `notify`, `job`; `tests/`: für `bun run check`
- `config/`: eigene Einstellungen, Vorlagen als `*.example.*`
- `db/`: Datenbankschema; `supabase/`: Edge Functions
- `docs/`: [Architektur](docs/architecture.md), [Entwickler](docs/developer-guide.md)
- `data/`, `logs/`: Laufzeitdaten und Logs, nicht im Repo
