# Troubleshooting

> This document covers common issues, their solutions, debugging commands,
> log file locations, and how to report problems.

---

## Setup Issues

### Installation mit einem Befehl

Meldungen von `curl -fsSL https://tybo.ai/install | sh` und was hilft. Der
Installer schreibt jede Meldung mit `tybo:` davor; `…` steht für Ordner und
Programmnamen, die je nach Rechner anders lauten. Vor dem Holen von tybo kann
er nach deinem Ja schon Bun installieren oder mit `bun upgrade` aktualisieren;
der offizielle Bun-Installer trägt Bun dabei auch in deine Shell-Startdatei
ein. Das nimmt der Installer bei einem späteren Fehler nicht zurück. Derselbe
Befehl kann nach der Abhilfe trotzdem einfach noch einmal laufen und findet
das vorhandene Bun. Anleitung: [einrichtung.md](einrichtung.md#schnellweg-ein-befehl).

#### `tybo: command not found` nach der Installation

**Symptom:** `tybo: command not found` (bash) bzw. `zsh: command not found: tybo`.
Das meldet die Shell, nicht der Installer.

**Meldung**, eine von zwei:

- `tybo: …/bin ist in diesem Terminal noch nicht im PATH. In ~/.bashrc steht schon ein Eintrag dafür: …` (danach als Rückfall die zwei Zeilen)
- `tybo: …/bin ist nicht im PATH, der Befehl tybo wird sonst nicht gefunden.`

**Abhilfe:** `bun link` legt `tybo` in `~/.bun/bin` ab, und dieser Ordner
fehlt im `PATH` der laufenden Sitzung. Bei der ersten Meldung steht in der
genannten Startdatei schon ein Eintrag dafür, meist vom Bun-Installer (der
tybo-Installer liest `~/.zshrc` für zsh bzw. `~/.bashrc` und
`~/.bash_profile` für bash, führt sie aber nicht aus; Kontrollfluss wie
`if`-Zweige oder Funktionen und spätere Zuweisungen, auch auf derselben
Zeile, wertet er nicht vollständig aus, deshalb verspricht die Meldung
keinen Erfolg): neues Terminal bzw.
neue SSH-Sitzung öffnen oder `source ~/.bashrc` (die genannte Datei). Erst
wenn `tybo` danach immer noch fehlt, die zwei Rückfall-Zeilen eintragen, die
der Installer darunter ausgibt (ob der Eintrag wirkt, kann der Installer ohne
Ausführen der Datei nicht sicher sagen). Bei der
zweiten Meldung die zwei Zeilen, die der Installer darunter ausgibt, in
`~/.zshrc` (zsh, macOS) bzw. `~/.bashrc` (bash, Linux) eintragen und ein
neues Terminal öffnen. Bis dahin geht es im Projektordner mit
`bun run setup` statt `tybo setup`.

#### Claude CLI liegt in ~/.local/bin, ist aber nicht im PATH

**Meldung:** `Claude CLI liegt in ~/.local/bin, das ist noch nicht im PATH: neue Sitzung öffnen.`
(vom Installer oder von `tybo setup voraussetzungen`)

**Abhilfe:** Der native Claude-Installer
(`curl -fsSL https://claude.ai/install.sh | bash`) legt `claude` in
`~/.local/bin` ab. Viele Linux-Systeme (Debian, Raspberry Pi OS) nehmen den
Ordner erst bei der nächsten Anmeldung in den `PATH`. Nichts neu
installieren: neues Terminal bzw. neue SSH-Sitzung öffnen. Hilft das nicht
(etwa unter macOS mit zsh), die angezeigte Zeile
`export PATH="$HOME/.local/bin:$PATH"` in `~/.zshrc` bzw. `~/.bashrc`
eintragen. Steht `CLAUDE_PATH` in der `.env`, prüft `tybo setup` nur diesen
Pfad.

#### Lokale Änderungen, nichts geändert

**Meldung:** `tybo: lokale Änderungen in …, nichts geändert. Anzeigen mit: cd … && git status`

**Abhilfe:** Beim Aktualisieren hat der Zielordner geänderte, von Git
verwaltete Dateien. Der Installer überschreibt sie nicht. Mit `git status`
nachsehen, was geändert ist, die Änderungen sichern oder mit
`git restore <datei>` verwerfen, dann den Befehl erneut ausführen. Die `.env`
und `config/profile.md` zählen nicht dazu, die verwaltet Git nicht.

Verwandt, gleiche Abhilfe nach Anzeige:

**Meldung:** `tybo: … weicht vom Stand auf origin/… ab (eigene Commits), nichts geändert.`

**Meldung:** `tybo: … steht auf Branch …, nicht auf …, nichts geändert.`

#### Gehört nicht zu tybo

**Meldung:** `tybo: … gehört nicht zu tybo, nichts geändert. Einen anderen Ordner wählen: --dir <pfad>`

**Abhilfe:** Den Zielordner (Standard `~/tybo`) gibt es schon, aber er ist
kein Klon von tybo: eine Datei, ein Ordner mit anderem Inhalt, ein
Unterordner eines anderen Git-Repos oder ein Klon eines anderen Repos. Der
Installer fasst ihn nicht an. Einen anderen Ordner wählen:

```bash
curl -fsSL https://tybo.ai/install | sh -s -- --dir ~/apps/tybo
```

Beim Aktualisieren denselben Ordner angeben wie bei der ersten Installation.

#### Kein Terminal: Einrichtung startet nicht

**Meldung:** `tybo: tybo ist installiert. Weiter mit: cd … && tybo setup`

**Abhilfe:** Ohne Terminal für Rückfragen (etwa per `ssh` ohne `-t`, in
einem Skript oder einer CI) installiert der Installer, startet aber den
Assistenten nicht. Die Einrichtung dann in einem normalen Terminal von Hand
starten, mit dem Befehl aus der Meldung. Dasselbe gilt, wenn der Assistent
abgebrochen wurde:

**Meldung:** `tybo: Einrichtung nicht abgeschlossen. Später weiter mit: cd … && tybo setup`

Fehlt außerdem Bun, kann der Installer ohne Terminal nicht fragen:

**Meldung:** `tybo: Bun fehlt oder ist zu alt, und ohne Terminal kann ich nicht fragen.`

Dann Bun selbst installieren (`curl -fsSL https://bun.sh/install | bash`) oder
den Installer mit `--yes` starten (`… | sh -s -- --yes`).

#### Linux ohne `unzip`

**Meldung:** `tybo: … fehlt, der Bun-Installer braucht bash, curl und unzip.`

**Abhilfe:** Der offizielle Bun-Installer braucht `unzip`, das auf schlanken
Linux-Systemen oft fehlt. Nachinstallieren, etwa `sudo apt install unzip`
(Debian, Ubuntu) oder `sudo dnf install unzip` (Fedora), dann den Befehl
erneut ausführen.

#### Firmen-Proxy oder gesperrter Download

**Symptom:** `curl` meldet einen Fehler, bevor der Installer etwas ausgibt,
oder eine der folgenden Meldungen erscheint:

**Meldung:** `tybo: Bun-Installer ließ sich nicht laden (…). Internetverbindung prüfen und erneut versuchen.`

**Meldung:** `tybo: git clone ist fehlgeschlagen. Internetverbindung prüfen und erneut versuchen.`

**Abhilfe:** Der Installer umgeht keinen Proxy. Braucht dein Netz einen,
die Adresse bei der IT erfragen und vorher setzen (`curl` und `git` lesen
sie), etwa `export HTTPS_PROXY=http://proxy.example:8080`. Um das Skript vor
dem Ausführen anzusehen, es erst herunterladen, lesen und nur nach
erfolgreichem Download starten:

```bash
curl -fsSL https://tybo.ai/install -o install.sh
less install.sh
sh install.sh
```

Optionen gehen dabei direkt dahinter, etwa `sh install.sh --dir ~/apps/tybo`.
Lässt sich gar nichts laden, bleibt der Weg von Hand in
[einrichtung.md](einrichtung.md#von-hand-einrichten).

#### Großer Ordner `~/.cache/puppeteer` nach einer älteren Installation

**Symptom:** Wenig Platz auf der Festplatte, SD-Karte oder SSD, und
`du -sh ~/.cache/puppeteer` zeigt mehrere hundert MB (auf dem Raspberry Pi
etwa 652 MB).

**Abhilfe:** Frühere tybo-Versionen hatten Puppeteer als Abhängigkeit, und
`bun install` lud dabei einen Chrome-Browser in diesen Ordner. tybo braucht
ihn nicht; auf dem Raspberry Pi ist es sogar ein x86-64-Programm, das dort
nicht startet. Neue Installationen und Updates laden ihn nicht mehr, ein
schon vorhandener Ordner bleibt aber liegen. Der Ordner ist ein gemeinsamer
Zwischenspeicher: Nutzt ein anderes Programm auf dem Rechner Puppeteer,
braucht es den Ordner womöglich noch, dann nicht löschen. Sonst:

```bash
rm -rf ~/.cache/puppeteer
```

---

### Bun Not Found After Installation

**Symptoms:** Running `bun install` returns "command not found" after installing Bun.

**Fix:** Bun installs to `~/.bun/bin/` which is not yet in the PATH of the shell you installed it from. The official Bun installer usually adds it to your shell startup file (`~/.zshrc`, `~/.bashrc` or `~/.bash_profile`), so first open a new terminal (or SSH session) or run `source ~/.bashrc` (or `source ~/.zshrc`). If `bun` is still not found after that, add these two lines to that file:

```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```

---

### Supabase Key Format Changed

**Symptoms:** Claude Code questions the format of your Supabase key, or setup fails with key validation errors.

**Explanation:** Supabase recently renamed their API keys:
- **"anon public key"** is now called **"Publishable key"** and may start with `sb_publishable_` instead of `eyJ`
- **"service_role secret key"** is now called **"Secret key"** and may start with `sb_secret_` instead of `eyJ`

**Fix:** Both formats work, in the same variables: `SUPABASE_SERVICE_ROLE_KEY` takes the secret key (`sb_secret_…`) or the old `service_role`, `SUPABASE_ANON_KEY` the publishable key (`sb_publishable_…`) or the old `anon`. Paste whatever your Supabase dashboard shows. The setup assistant rejects a `sb_publishable_…` in the field for the writing key, because it cannot write. If Claude Code questions the format, tell it that Supabase updated their key format and it's correct. With a `sb_secret_…` key the Edge Functions must be deployed with `--no-verify-jwt`, see [Semantische Suche fällt still auf Textsuche zurück](#semantische-suche-fällt-still-auf-textsuche-zurück-semantic-search-silently-falls-back).

---

### macOS "Background Items" Notification

**Symptoms:** After setting up always-on services, macOS shows a popup saying *"Software from 'Jared Sumner' can run in the background"*.

**Fix:** This is normal. Jared Sumner is the creator of the Bun runtime, which powers the bot services. Click **Allow** to let the services run on schedule. You can manage background items later in System Settings > General > Login Items.

---

### Claude Code Permission Prompts

**Symptoms:** Claude Code asks for permission before running commands during setup.

**Fix:** This is normal — Claude Code asks before executing shell commands or editing files. You can:
- Select **"Allow for this session"** to approve all similar actions during setup
- Or approve each action individually

---

## Common Issues and Fixes

### Startmeldung „Telegram nicht eingerichtet: nur WebUI"

**Was es heißt:** In der `.env` stehen weder `TELEGRAM_BOT_TOKEN` noch
`TELEGRAM_USER_ID`, die WebUI ist eingerichtet. tybo läuft dann absichtlich
ohne Telegram (Entscheidung 0021): kein Polling, keine Agenten-Bots,
Antworten, Meldungen und Rückfragen nur in der WebUI und per Push. Die
Startübersicht zeigt `Telegram: nicht eingerichtet (nur WebUI)`.

**Wenn du Telegram willst:** `tybo setup telegram`, danach tybo neu starten
(in der WebUI: Neustart anfordern). Übrig gebliebene `TELEGRAM_GROUP_ID` oder
`TELEGRAM_BOT_TOKEN_<AGENT>` stören ohne Telegram nicht; `bun run setup:verify`
meldet sie als übersprungen.

### Startmeldung „Telegram halb eingerichtet"

**Symptom:** Der Bot startet nicht normal, sondern im Einrichtungsmodus; im
Log steht etwa `Einrichtungsmodus: Telegram halb eingerichtet:
TELEGRAM_BOT_TOKEN ist gesetzt, TELEGRAM_USER_ID fehlt. Beide Werte setzen
oder beide entfernen.`

**Ursache:** Nur einer der beiden Telegram-Werte steht in der `.env` (oder
noch der Platzhalter aus `.env.example`), oder die Nutzer-ID ist keine Zahl.
Das gilt auch mit gültiger WebUI als Fehler, damit ein Tippfehler nicht still
zu einem Bot ohne Telegram führt.

**Lösung:** Beide Werte setzen (`tybo setup telegram`) oder beide aus der
`.env` entfernen, wenn du nur die WebUI nutzt. launchd bzw. PM2 starten den
Bot nach „Fertig“ im Einrichtungsmodus neu. `bun run setup:verify` zeigt den
Grund unter „Channels“.

### Bot Not Responding

**Symptoms:** You send a message on Telegram and get no reply.

**Check 1: Is the service running?**

```bash
launchctl list | grep ai.tybo.telegram-relay
```

Expected output:
```
1234    0    ai.tybo.telegram-relay
```

If the PID column shows `-`, the service is loaded but not running.
If the line is missing entirely, the service is not installed.

**Check 2: Is there a stale lock file?**

```bash
ls -la ~/tybo/bot.lock
```

If the file exists and the bot is not running, delete it:

```bash
rm ~/tybo/bot.lock
```

Then restart the service:

```bash
launchctl unload ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
launchctl load ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
```

**Check 3: Check the logs**

```bash
tail -50 ~/tybo/logs/telegram-relay.log
tail -50 ~/tybo/logs/telegram-relay.error.log
```

Look for error messages about missing tokens, connection failures,
or uncaught exceptions.

**Check 4: Is your bot token still valid?**

```bash
curl "https://api.telegram.org/bot<YOUR_TOKEN>/getMe"
```

If this returns an error, your token may have been revoked. Create
a new token with BotFather.

**Check 5: Is your user ID correct?**

The bot silently ignores messages from unauthorized users.
Double-check `TELEGRAM_USER_ID` in `.env` matches your actual ID.

---

### Claude Timeout (Lange Läufe und Zeitlimit)

**Symptoms:** The bot shows "typing..." for a long time. Im Chat stehen
Hinweise „⏳ Läuft seit … Minuten" und am Ende eine Antwort, die mit
„⏱ Zeitlimit: …" beginnt und die zuletzt aufgerufenen Schritte auflistet.

**Cause:** Claude Code CLI is taking too long to respond, oder der Lauf
hängt und liefert nichts mehr.

**Fix 1: Zeitlimits prüfen und anpassen**

Chat-Turns über den Streaming-Weg (Telegram und WebUI) haben zwei Grenzen
(`src/lib/chat-turn.ts`, Issue #178):

- **Leerlauf, Standard 15 Minuten:** Jede Zeile, die die CLI im
  stream-json-Format schreibt, zählt als Aktivität, auch Werkzeug-Ergebnisse
  und Ereignisse von Hilfs-Agenten. Während ein Werkzeug oder ein
  Hilfs-Agent läuft, schickt die CLI alle 30 Sekunden eine
  `tool_progress`-Zeile. Kommt 15 Minuten lang gar nichts, hängt der Lauf und
  wird beendet: „⏱ Zeitlimit: seit 15 Minuten keine Aktivität".
- **Obergrenze, Standard 90 Minuten:** beendet auch einen Lauf, der noch
  arbeitet: „⏱ Zeitlimit: Obergrenze von 90 Minuten erreicht".

Der Hinweis „⏳ Läuft seit …" kommt nach 20 Minuten und dann alle 20 Minuten
bis zur Obergrenze. `/stop` bricht jederzeit sofort ab.

Beide Grenzen lassen sich in `.env` in ganzen Minuten (1 bis 1440) ändern,
wirksam nach einem Neustart des Bots:

```bash
TYBO_CLAUDE_IDLE_MIN=15
TYBO_CLAUDE_MAX_MIN=90
```

Ein ungültiger Wert (etwa `15m` oder `0`) fällt auf den Standard zurück; im
Log steht dann `[chat-turn] TYBO_CLAUDE_IDLE_MIN ungültig …` (ohne den Wert
selbst). Beim Abbruch nennt das Log Art, Laufzeit und Sekunden seit der
letzten Aktivität, etwa
`[Claude streaming] timeout (idle) after 1830s, last activity 900s ago …`.

Der JSON-Weg (Aufrufe ohne Fortschrittsanzeige) liefert erst am Ende
Ausgabe und kennt deshalb keine Leerlauf-Grenze; er bleibt bei 30 Minuten
Gesamtzeit. Aufträge, die länger als die Obergrenze brauchen, gehören in einen
Hintergrund-Job (`bun run job start`, `docs/hintergrund-jobs.md`).

**Nach dem Zeitlimit: Stand statt Fallback (Issue #179)**

Früher hat der Bot nach einem Zeitlimit die Fallback-Kette (Opus 5 über die
CLI, dann OpenRouter, dann Ollama) mit der ursprünglichen Nachricht
aufgerufen. Das ging schief: Die zweite Stufe begann den Auftrag in einer
frischen Session von vorn und führte Seiteneffekte doppelt aus (Commits,
GitHub-Issues), und OpenRouter antwortete ohne Zugriff auf den Rechner
„das kann ich nicht", obwohl die Arbeit schon erledigt war.

Jetzt startet der Bot nach einem Zeitlimit nichts neu. Die Antwort ist ein
fester Bericht, ohne Modell erzeugt (`formatTimeoutReport()` in
`src/lib/chat-turn.ts`), in Telegram und in der WebUI gleich:

- Art des Abbruchs (Leerlauf oder Obergrenze) mit tatsächlicher Laufzeit und
  Leerlaufdauer, soweit bekannt;
- die letzten 8 aufgerufenen Werkzeuge in Reihenfolge, Befehle und Pfade auf
  80 Zeichen gekürzt. Ob ein Schritt fertig wurde, ist offen: der Bericht
  nennt Aufrufe, keine Ergebnisse;
- der letzte Zwischentext von Claude, auf 400 Zeichen gekürzt;
- mit `SESSION_MODE=resume`: „Schreib **weiter**, dann setze ich die Session
  fort, oder /new für einen Neustart". Die Topic-Session zeigt dafür auf die
  abgebrochene Session, „weiter" läuft mit `--resume` dort weiter. Ohne
  Session-Modus, wenn die CLI keine Session-ID gemeldet hat oder wenn
  `data/sessions.json` nicht gelesen oder geschrieben werden konnte, bittet
  der Bericht stattdessen, den Stand zu prüfen, bevor der Auftrag noch einmal
  geschickt wird.

Werte aus `.env` und geheim benannte Umgebungsvariablen stehen maskiert
(`[verborgen]`) im Bericht, wie bei `bun run job log`; maskiert wird vor dem
Kürzen. Ist die `.env` vorhanden, aber nicht lesbar (Rechte, Ordner statt
Datei), nennt der Bericht nur die Werkzeugnamen, ohne Befehle, Pfade und
Zwischentext, und `logs/telegram-relay.error.log` enthält
„Geheimnisse für den Stand-Bericht nicht lesbar". Steuer-Tags wie `[REMEMBER:]` aus Befehlen oder Zwischentext werden
entschärft und lösen nichts aus. Im Log steht
`Claude streaming timeout/idle, kein Fallback`.

Der JSON-Weg meldet beim Zeitlimit weder Schritte noch Session-ID; sein
Bericht sagt das offen und bietet kein „weiter" an.

Andere Fehler (Anmeldung abgelaufen, Limit erreicht, CLI fehlt) laufen
weiterhin über die Fallback-Kette.

**Fix 2: Check Claude authentication**

```bash
claude --version
claude -p "Hello" --output-format text
```

If Claude returns an auth error, re-authenticate:

```bash
claude
# Follow the OAuth flow
```

**Fix 3: Check for rate limiting**

Look for these patterns in the log:

```
API Error: 429
rate_limit_error
overloaded_error
```

These mean you have hit Anthropic's rate limits. Wait a few minutes
and try again, or configure a fallback LLM.

---

### Antwort wartet: „Warte auf einen freien Platz"

**Symptoms:** Statt einer Antwort steht im Chat „⏳ Warte auf einen freien
Platz, gerade laufen 3 andere Aufträge (…)". Die Tippen-Anzeige läuft weiter.

**Cause:** tybo arbeitet mehrere Topics absichtlich parallel, aber höchstens
`MAX_AGENT_PROCESSES` Ausführungen gleichzeitig (`src/lib/execution-context.ts`).
Ohne die Variable richtet sich die Grenze nach dem Arbeitsspeicher des
Rechners (`src/lib/agent-capacity.ts`, gerechnet in GiB, also 1024³ Byte, wie
`free -g` es anzeigt): unter 3 GiB 1 Platz, unter 6 GiB 2 Plätze, sonst 3.
Ein Raspberry Pi mit 4 GB meldet etwa 3,8 GiB und bekommt 2 Plätze, einer mit
8 GB und jeder übliche Mac oder Server 3. Welche Grenze gilt, steht einmal
beim Start im Log, etwa `[agents] Gleichzeitige Aufträge: 2, 3,8 GiB
Arbeitsspeicher`, `… 3, Standard` oder `… 5, MAX_AGENT_PROCESSES`. Gezählt werden die Bereiche von
`runExecution`: Chat-Turns aus Telegram und WebUI, Rückfragen an andere
Agenten und auch die Quality Gates und der Judge eines `/goal`. Weitere Turns
warten der Reihe nach (wer zuerst kommt, ist zuerst dran), ohne Prioritäten
zwischen Topics. Innerhalb eines Topics läuft pro Agent ohnehin nur ein Turn
nach dem anderen (Session-Sperre).

Wartet ein Turn länger als 3 Sekunden auf einen Platz, sagt tybo das einmal im
Gespräch: in Telegram als Nachricht, im Browser als Hinweis über der Antwort.
Die Zahl nennt die belegten Plätze, in Klammern die Gespräche dahinter
(Topic-Name, sonst „Topic <id>", „Direktchat", „General", „Web-Gespräch",
„Hintergrundaufgabe"). Der Hinweis landet nicht im Gedächtnis. Sobald ein Platz
frei wird, startet der Turn mit dem normalen Fortschritt.

**Fix:**

- Warten. Ein Platz wird frei, sobald eine der genannten Antworten fertig ist.
- `/stop` (oder der Stopp-Knopf im Browser) im wartenden Gespräch nimmt den
  Turn sofort aus der Schlange, auch wenn alle Plätze belegt bleiben. Er
  endet mit „⏹️ Abgebrochen." und wird nie mehr ausgeführt. Ausnahme wie
  bisher: das erste `/stop` während einer `/board`-Sitzung beendet sie erst
  nach dem laufenden Beitrag.
- Die Grenze in `.env` ändern, z.B. `MAX_AGENT_PROCESSES=4`, und den Bot neu
  starten (der Wert wird beim Start gelesen, zur Laufzeit ändert sich die
  Grenze nicht). Ein gesetzter Wert gilt immer, auch über der Vorgabe nach
  Arbeitsspeicher. Gültig ist nur eine ganze Zahl ab 1; bei einem leeren Wert
  gilt die Vorgabe nach Arbeitsspeicher, bei einem ungültigen (Text, 0,
  negativ, Kommazahl) ebenso, und das Log sagt dann „MAX_AGENT_PROCESSES
  ungültig". Mehr Plätze heißen mehr gleichzeitige Claude-Prozesse: mehr
  Speicher (jeder `claude -p` braucht einige hundert MB, mit Werkzeugen und
  MCP-Servern mehr) und schnellerer Verbrauch des Abo-Kontingents bzw. höhere
  API-Kosten. Die Vorgabe nach Arbeitsspeicher ist vorsichtig gewählt,
  garantiert aber nicht, dass jeder Auftrag in den Speicher passt: gezählt
  werden nur Ausführungen von tybo, nicht andere Programme auf dem Rechner.
- Tests (`bun run check`) hängen nicht von dieser Einstellung ab: sie
  entfernen geerbte Variablen und rechnen mit festen 8 GiB
  (`tests/preload-env.ts`); Tests, die Plätze füllen, setzen ihre Zahl selbst
  (`tests/agent-capacity-fixture.ts`).

---

### Supabase Connection Failed

**Symptoms:** Messages are not being saved, goals/facts are not
persisting, or the verify script shows Supabase errors.

**Fix 1: Check your credentials**

```bash
bun run test:supabase
```

Common issues:
- URL missing the `https://` prefix (`http://` is only accepted for Supabase on this machine, `127.0.0.1` or `localhost`)
- Keys still contain placeholder values
- Wrong key type: `SUPABASE_SERVICE_ROLE_KEY` needs the secret key (`sb_secret_…`) or `service_role`, not the publishable key or `anon`

**Fix 2: Check the schema**

Go to your Supabase dashboard > Table Editor. Verify these tables exist:
- `messages`
- `memory`
- `logs`
- `call_transcripts`

If they are missing, run `db/schema.sql` in the SQL Editor.

**Fix 3: Check RLS policies**

If you can read but not write, the RLS policies may be misconfigured.
The simplest fix is to use the `SUPABASE_SERVICE_ROLE_KEY` (which
bypasses RLS entirely) instead of the anon key.

**Fix 4: Network connectivity**

```bash
curl -s -o /dev/null -w "%{http_code}" "https://your-project.supabase.co/rest/v1/"
```

Should return `200`. If it returns an error, check your network
connection or Supabase service status.

---

### Lokales Supabase startet nicht

Gilt für den Weg „Supabase auf diesem Rechner“ (`tybo setup datenbank`, in
Docker). Die Befehle unten laufen im Projektordner; die CLI kommt über Bun in
der Version, die tybo nutzt (`bunx --bun supabase@2.118.0`; ohne `--bun`
verlangt der Starter der CLI Node).

**Erst nachsehen:**

```bash
docker info --format '{{.ServerVersion}}'            # läuft Docker?
bunx --bun supabase@2.118.0 status --workdir .        # läuft Supabase?
docker ps --filter label=com.supabase.cli.project=tybo --format '{{.Names}}  {{.Ports}}'   # nur 127.0.0.1:544xx?
docker network inspect supabase_network_tybo --format '{{json .Options}}'                # host_binding_ipv4 127.0.0.1?
```

| Meldung oder Zeichen | Ursache und Abhilfe |
|---|---|
| „Docker fehlt. …“ | Kein `docker`-Befehl. Auf dem Mac OrbStack, Docker Desktop oder Colima (`brew install colima docker`, `colima start`) installieren, unter Linux die Docker Engine. tybo installiert Docker nie selbst. |
| „Docker läuft nicht: …“ | Docker Desktop bzw. OrbStack öffnen oder `colima start`. Zeigt `docker context ls` auf einen anderen Docker: `docker context use <name>`. |
| „… keine Berechtigung …“ | Linux: `sudo usermod -aG docker $USER`, ab- und wieder anmelden. |
| „Die Supabase-CLI ließ sich nicht laden. …“ | Bun lädt die CLI beim ersten Mal aus dem npm-Verzeichnis (rund 130 MB). Internet prüfen; `bunx --bun supabase@2.118.0 --version` zeigt den eigentlichen Fehler. Node.js ist nicht nötig. |
| „… ein Port im Bereich 54420 bis 54429 belegt …“ | Ein anderes Programm oder ein altes Supabase nutzt einen Port von tybo. `docker ps` zeigt, welcher Container; ein anderes Supabase-Projekt mit `supabase stop` in dessen Ordner anhalten. Die Ports stehen in `supabase/config.toml`. |
| „… Speicherplatz für die Docker-Images fehlt …“ | `docker system prune` löscht ungenutzte Images und Container (nicht die Volumes von tybo). Bei Docker Desktop unter Settings, Resources die virtuelle Festplatte vergrößern. |
| „Supabase ist nach 20 Minuten noch nicht gestartet. …“ | Beim ersten Start lädt Docker mehrere GB. Einfach erneut; schon geladene Images bleiben. |
| „Supabase war nicht nur auf diesem Rechner erreichbar …“ | Ein Port war nicht an `127.0.0.1` gebunden oder aus dem Heimnetz erreichbar. Die Docker-Einstellung `"ip"` (`daemon.json`) hilft hier nicht, sie gilt nur für das Standard-Netz `bridge`. Supabase läuft im Netz `supabase_network_tybo`, das der Assistent mit der Option `com.docker.network.bridge.host_binding_ipv4=127.0.0.1` anlegt. Fehlt sie (zweiter Befehl oben): `bunx --bun supabase@2.118.0 stop --workdir .`, `docker network rm supabase_network_tybo`, erneut einrichten. |
| „Das Docker-Netz supabase_network_tybo gibt es schon, aber ohne Bindung an 127.0.0.1 …“ | Wie in der Zeile darüber: anhalten, Netz entfernen, erneut einrichten; der Assistent legt es richtig an. |
| „Achtung: Supabase-Dienste laufen womöglich noch …“ | Der Schutz-Stopp ist gescheitert. Sofort `bunx --bun supabase@2.118.0 stop --workdir .`; zeigt `docker ps --filter label=com.supabase.cli.project=tybo` danach noch Container, `docker stop <name>`. |
| Nach einem Neustart des Rechners antwortet die Datenbank nicht | Siehe „Nach Neustart kein Gedächtnis“ unten. Kurz: Docker starten, dann `tybo datenbank start`. |
| Rechner wird sehr langsam | Weniger als 8 GB Arbeitsspeicher, oder die Docker-VM hat zu wenig. Bei Docker Desktop unter Settings, Resources mehr geben, bei Colima `colima start --memory 6`. |

**Daten:** Sie liegen in Docker-Volumes `supabase_<dienst>_tybo`.
`supabase stop` hält an und behält sie. `supabase stop --no-backup` und
`docker volume rm` **löschen** Gespräche, Gedächtnis und Bilder; beides nur,
wenn du wirklich neu anfangen willst. `project_id` in `supabase/config.toml`
nicht ändern: eine andere ID heißt neue, leere Volumes.

### Nach Neustart kein Gedächtnis

Gilt für Supabase auf diesem Rechner. Zeichen: nach einem Neustart oder dem
Aufwachen des Rechners weiß tybo nichts mehr von früheren Gesprächen, oder
`tybo setup` meldet bei der Datenbank „antwortet aber nicht“. Die Daten sind
in der Regel nicht weg; Docker oder Supabase laufen nur noch nicht.

**Nachsehen:**

```bash
tybo datenbank status        # läuft es? fehlt die Edge Runtime?
tail -20 logs/supabase.log   # was der Autostart beim Anmelden gemacht hat
```

| Zeichen | Ursache und Abhilfe |
|---|---|
| „läuft nicht (Docker läuft nicht)“ | Docker startet nicht beim Anmelden. Docker Desktop: Settings, General, „Start Docker Desktop when you sign in to your computer“. OrbStack: „Start at login“. Colima: `brew services start colima`. Linux: `sudo systemctl enable docker`. Danach `tybo datenbank start`. |
| „läuft nicht“, Docker läuft | Der Supabase-Autostart fehlt oder ist gescheitert. `tybo setup autostart` richtet `ai.tybo.supabase` bzw. `tybo-supabase` ein; `bun run setup:verify` zeigt ihn unter „supabase (Autostart)“. Sofort: `tybo datenbank start`. |
| „Edge Runtime fehlt“ | Nach einem Neustart üblich (die Edge Runtime hat keine Neustart-Regel). `tybo datenbank start` startet Supabase einmal vollständig neu. |
| In `logs/supabase.log`: „Docker läuft nach 5 Minuten noch nicht“ | Docker kam beim Anmelden zu spät. Den Start von Docker beim Anmelden einschalten (Zeile oben) und `tybo datenbank start` aufrufen. |
| `setup:verify` meldet „Letzter Aufruf fehlgeschlagen“ (Mac) bzw. „Letzter Start fehlgeschlagen“ (PM2, auch wenn `tybo-supabase` `online` ist) | Die Ursache steht in `logs/supabase.log`; die Meldungen dort entsprechen denen aus „Lokales Supabase startet nicht“ oben. |
| „läuft“, tybo erinnert sich trotzdem nicht | Zeigt `SUPABASE_URL` in der `.env` auf `http://127.0.0.1:54421`? Mit `tybo setup datenbank` prüfen. Waren die Volumes gelöscht (etwa durch `supabase stop --no-backup`), hilft nur die letzte Sicherung, siehe `docs/einrichtung.md`, „Supabase lokal im Alltag“, Wiederherstellen. |

Nachrichten, die ankamen, während Supabase stand, hat tybo ohne Gedächtnis
beantwortet und nicht im Verlauf gespeichert.

---

### Semantische Suche fällt still auf Textsuche zurück (Semantic Search Silently Falls Back)

**Symptome:** Der Bot speichert Nachrichten und findet frühere Gespräche,
aber nur bei wörtlichen Treffern. Wissenseinträge bekommen kein Embedding.
Im Log steht kein Fehler.

**Warum still:** `saveMessage()` und `searchMessages()` in
`src/lib/supabase.ts` versuchen zuerst die Edge Functions
`store-telegram-message` und `search-memory`. Antworten diese nicht mit
Erfolg, speichert der Bot direkt (ohne Embedding) bzw. sucht mit einfacher
Textsuche. Das hält den Bot am Laufen, verdeckt aber den Fehler.

**Häufige Ursachen:**

- Die Edge Functions sind nicht deployt, oder auf Supabase fehlt das Secret
  `OPENAI_API_KEY` bzw. bei `EMBEDDING_PROVIDER=gemini` das Secret
  `GEMINI_API_KEY` (dann gibt es Speicherung ohne Embedding).
- Der eingestellte Anbieter passt nicht zur Anbieterkennung der Datenbank
  (Tabelle `embedding_settings`, Issue #167): etwa `EMBEDDING_PROVIDER=gemini`
  in der `.env`, die Datenbank hält aber OpenAI fest, oder Bot und Functions
  haben verschiedene Einstellungen. Dann entsteht absichtlich kein Embedding,
  damit keine unvergleichbaren Werte gemischt werden. Beim Start steht im Log
  `[embedding] ACHTUNG: …`, die Functions schreiben die Meldung einmal in ihr
  Log, und `tybo setup pruefung` meldet es. Nachsehen:
  `select * from embedding_settings;` im SQL-Editor. Den Anbieter wirklich
  wechseln: `tybo setup suche` und „Alles neu berechnen“ (Issue #168).
- Eine Neuberechnung nach einem Anbieterwechsel läuft oder ist unterbrochen
  (Issue #168). Solange sucht tybo absichtlich nur nach Text. Stand:
  `tybo suche status`; steht sie still, setzt `tybo suche neu-berechnen`
  beim letzten Stapel fort (Ausgabe im Hintergrund:
  `logs/embedding-reindex.log`). Nach dem Ende tybo neu starten (WebUI:
  Neustart anfordern), damit der Bot die neue `.env` liest.
- Mit Ollama auf diesem Rechner: die Functions laufen in Docker und erreichen
  `localhost:11434` nicht. In `supabase/functions/.env` muss
  `OLLAMA_URL=http://host.docker.internal:11434` stehen (macht
  `tybo setup suche`); unter Linux muss Ollama dafür auf mehr als 127.0.0.1
  hören (`OLLAMA_HOST=0.0.0.0`).
- In der `.env` steht ein neuer Schlüssel (`sb_secret_…`) und die Functions
  wurden ohne `--no-verify-jwt` deployt. Der Supabase-Gateway prüft dann ein
  JWT, der neue Schlüssel ist keins, die Anfrage endet mit 401.
- Eine ältere Fassung der Functions ist deployt, die nur
  `Authorization: Bearer <service_role>` kennt. Mit `sb_secret_…` schickt der
  Bot den Schlüssel nur im Kopf `apikey`.
- In `SUPABASE_SERVICE_ROLE_KEY` steht der Publishable- oder anon-Schlüssel.
  Die Functions lassen nur Secret- bzw. service_role-Schlüssel durch.

**Prüfen:** Aus dem Projektordner, der Schlüssel wird aus der `.env` gelesen
und nicht angezeigt:

```bash
set -a; . ./.env; set +a
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$SUPABASE_URL/functions/v1/search-memory" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"chat_id":"0","query":"test"}'
```

Mit einem alten `service_role`-Schlüssel zusätzlich
`-H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"` angeben. 200 heißt:
die Function antwortet. 401: Schlüssel falsch oder `verify_jwt` noch an.
404: Function nicht deployt. 503: der Function fehlen ihre Schlüssel
(`SUPABASE_SECRET_KEYS` bzw. `SUPABASE_SERVICE_ROLE_KEY` in ihrer Umgebung).

**Fix:** Die Functions aus `supabase/functions/` neu deployen, jeweils mit
`--no-verify-jwt` (die Prüfung macht jede Function selbst, siehe
`supabase/functions/_shared/auth.ts`; `supabase/config.toml` setzt
`verify_jwt = false` für alle drei):

```bash
supabase functions deploy store-telegram-message --no-verify-jwt
supabase functions deploy search-memory --no-verify-jwt
supabase functions deploy embed-knowledge --no-verify-jwt
```

Alte `service_role`-Schlüssel funktionieren danach weiter.

---

### launchd Service Not Starting

**Symptoms:** `launchctl list | grep ai.tybo` shows no entries or
the service keeps exiting.

**Fix 1: Validate the plist XML**

```bash
plutil ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
```

Should output: `OK`. If it shows errors, the XML is malformed.
Regenerate with:

```bash
bun run setup:launchd -- --service telegram-relay
```

**Fix 2: Check paths in the plist**

Open the plist and verify all paths are absolute and the files exist:

```bash
cat ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
```

Check that:
- The bun path exists: `which bun`
- The project root exists
- The script file exists

**Fix 3: Unload and reload**

```bash
launchctl unload ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
launchctl load ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
```

**Important:** You must unload before loading. Running `load` on an
already-loaded service will fail silently.

**Fix 4: Check for errors in launchd's own logs**

```bash
log show --predicate 'subsystem == "com.apple.xpc.launchd"' --last 5m | grep ai.tybo
```

---

### systemd-Dienst startet nicht (Linux, Raspberry Pi)

Gilt für den Autostart als systemd-Benutzerdienst `tybo-telegram-relay`
(`tybo setup autostart` unter Linux mit systemd, Issue #207). Alle Befehle
als dein Benutzer ausführen, nie mit `sudo`: `systemctl --user` braucht die
eigene Sitzung (`XDG_RUNTIME_DIR`), unter `sudo` fehlt sie.

**Zustand ansehen:**

```bash
systemctl --user status tybo-telegram-relay
tail -50 logs/telegram-relay.error.log
loginctl show-user $USER -p Linger      # Linger=yes: startet auch ohne Anmeldung
```

**„Failed to connect to bus“ bzw. „antwortet nicht (systemctl --user)“:**
`tybo setup` lief über `sudo`, `su` oder ohne Anmeldesitzung. Als normaler
Benutzer per SSH oder am Gerät anmelden und erneut ausführen.

**Nach einem Neustart läuft der Bot erst, wenn du dich anmeldest:** Linger ist
aus. Einmal `sudo loginctl enable-linger $USER`, dann `tybo setup autostart`;
der Assistent prüft es.

**Bot antwortet nur über Fallback-Modelle oder gar nicht:** der Dienst findet
Bun oder die Claude CLI nicht. Die Dienstdatei setzt `PATH` selbst (Ordner von
Bun, Ordner der Claude CLI, `~/.bun/bin`, `~/.local/bin`). Wurde die CLI erst
danach installiert oder verschoben, den Dienst neu anlegen:

```bash
systemctl --user disable --now tybo-telegram-relay
rm ~/.config/systemd/user/tybo-telegram-relay.service
tybo setup autostart
```

**Dienst startet ständig neu:** `Restart=always` startet ihn nach jedem Ende
neu, auch nach Fehlern in der `.env`. Ursache steht in
`logs/telegram-relay.error.log`. Zum Anhalten:
`systemctl --user stop tybo-telegram-relay`.

**Zwei Bots gleichzeitig:** steht `tybo-telegram-relay` auch in `pm2 list` (oder in PM2s Sicherungsliste `~/.pm2/dump.pm2`, die PM2 beim Hochfahren wiederherstellt),
holen sich beide dieselben Nachrichten. Einen entfernen, etwa PM2:
`pm2 delete tybo-telegram-relay; pm2 save --force`. `tybo setup autostart` legt nie
einen zweiten an.

---

### Voice Not Working

**Symptoms:** Voice messages are not transcribed, or the bot does not
reply with audio.

**Fix 1: Check API keys**

```bash
bun run setup:verify
```

Look for the ElevenLabs and Gemini status in the output.

**Fix 2: Check voice is enabled**

In the bot startup log:

```
Voice:       enabled
Transcribe:  enabled
```

If either shows "disabled", the corresponding API keys are missing.

**Fix 3: Test ElevenLabs directly**

```bash
curl -X POST "https://api.elevenlabs.io/v1/text-to-speech/<VOICE_ID>" \
  -H "xi-api-key: <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello", "model_id": "eleven_turbo_v2_5"}' \
  --output test.mp3
```

If this fails, your API key or voice ID may be invalid.

**Fix 4: Check your Gemini key**

For transcription issues:

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models?key=<GEMINI_KEY>"
```

Should return a list of models. If it returns an error, your key is invalid.

---

### Multiple Bot Instances

**Symptoms:** You receive duplicate responses to messages, or the bot
behaves erratically.

**Fix 1: Check for running processes**

```bash
ps aux | grep "bun run src/bot.ts"
```

If you see multiple processes, kill them all:

```bash
pkill -f "bun run src/bot.ts"
```

**Fix 2: Delete the lock file**

```bash
rm ~/tybo/bot.lock
```

**Fix 3: Restart the service**

```bash
launchctl unload ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
launchctl load ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
```

**Fix 4: Check launchctl for duplicate entries**

```bash
launchctl list | grep ai.tybo.telegram-relay
```

There should be exactly one entry. If there are multiple, unload all
and reload once.

---

### MCP Servers Not Available in Subprocess

**Symptoms:** Claude does not have access to MCP tools (Google Calendar,
Notion, etc.) when called from the bot, even though they work in
direct Claude Code sessions.

**Explanation:** Claude Code picks up MCP server configuration based on
the current working directory. When spawned as a subprocess from the bot,
the working directory may differ from where your MCP servers are configured.

**Fix 1: Use global MCP scope**

Configure MCP servers in the global `~/.claude.json` under the top-level
`mcpServers` key, not in a project-scoped config.

**Fix 2: Set the working directory**

The bot sets `cwd: PROJECT_ROOT` when spawning Claude. Ensure your
MCP configuration is accessible from that path.

---

### JSON Parse Errors from Claude

**Symptoms:** The bot logs JSON parse errors or returns garbled responses.

**Explanation:** Claude Code subprocesses sometimes wrap JSON output in
markdown code fences:

````
```json
{"result": "Hello!", "session_id": "abc123"}
```
````

**Fix:** The bot already handles this in `src/lib/claude.ts` with the
`extractJSON()` function. If you encounter this in custom code:

```typescript
export function extractJSON(output: string, key: string): any | null {
  const cleaned = output.replace(/```(?:json)?\s*/g, "").replace(/```/g, "");
  const jsonMatch = cleaned.match(new RegExp(`\\{[\\s\\S]*"${key}"[\\s\\S]*\\}`));
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
  return null;
}
```

Always strip code fences before parsing JSON from Claude subprocesses.

---

### Bot Answers About Something Else (Hook Continuation)

**Symptoms:** You ask a question and the reply is about a different, earlier
task from the same topic: design fixes, a deploy, "what the hook really
meant". The bot may also edit or deploy files you did not ask about. The
error log looks normal (`[Claude streaming] result: text=... chars`).

**Cause:** A Claude Code `Stop` hook (for example the impeccable design
detector in `.claude/settings.local.json`) returns `additionalContext` when
Claude finishes its answer. Claude then keeps working and writes a second
final message. With `SESSION_MODE=resume` a topic session lives for hours and
touches many files, so such hooks re-report old findings on every turn, no
matter what you asked. The CLI's `result` event only carries the last
message, so the real answer was dropped before it reached Telegram.

**Diagnosis:** Take the topic's session id from `data/sessions.json`, open
`~/.claude/projects/<project-dir>/<session-id>.jsonl` and look for
`hook_additional_context` entries between two assistant text messages.

**Fix (built in since 9 Sep 2026):**

- Every CLI subprocess tybo spawns carries `TYBO_SUBPROCESS=1` in its
  environment (`subprocessEnv()` in `src/lib/subprocess-env.ts`).
  Hooks inherit the environment, so gate any hook that can push context back
  into the conversation:

  ```json
  "command": "[ -n \"$TYBO_SUBPROCESS\" ] || node path/to/your-stop-hook.mjs"
  ```

  PostToolUse hooks that only report on the file just edited are harmless
  and can stay active; they run inside the turn.
- `callClaudeStreaming()` groups text blocks by API turn (`message.id`) and
  relays every final turn, joined by a blank line, instead of trusting the
  `result` event alone. The error log then shows
  `[Claude streaming] N final turns in one call (hook continuation?)`.
- The non-streaming path (`--output-format json`) has no such protection,
  so the environment-variable gate is the primary fix.

### Reply Replaced by "Abgebrochen." After a Code Change (Self-Restart)

**Symptoms:** You ask the bot to change its own code. A few minutes later
Telegram shows only `⏹️ Abgebrochen.` (since 14 Sep 2026: an explicit
"Der Bot wurde waehrend der Verarbeitung beendet" notice), the explanation
never arrives, and `logs/telegram-relay.log` shows `Received SIGTERM`
followed by a fresh `Go Telegram Bot - Starting` block.

**Cause:** The Claude subprocess that handled your message restarted the bot
(`launchctl kickstart -k`, `kill <pid>`) to activate its change. `shutdown()`
calls `abortAllEngineCalls()`, which kills every running subprocess,
including the one that was about to send the answer. launchd (`KeepAlive`)
then started the bot again with the new code, so the change itself is live;
only the reply was lost.

**Fix (built in since 14 Sep 2026):** request the restart instead of forcing it:

```bash
bun run restart:request "Tabellen-Fix aktivieren"   # creates data/restart-requested
```

The bot checks the marker 3 s after every delivered reply and every 30 s
while idle. It exits only when no Claude subprocess or agent execution is
running, posts "🔄 Neustart mit neuem Code" to Telegram first, and lets
launchd, PM2 or systemd start it again. Under systemd (Linux, Issue #207) the
bot counts as supervised only when it runs as the user service
`tybo-telegram-relay` with `Restart=always` and systemd reports its own PID
as the service's main PID. If the bot is not supervised (started with
`nohup`), it keeps running, clears the marker and asks for a manual restart.

**Manual restart** (from a terminal, never from inside a bot subprocess):

```bash
launchctl kickstart -k gui/$(id -u)/ai.tybo.telegram-relay  # macOS
pm2 restart tybo-telegram-relay                              # Linux/Windows (PM2)
systemctl --user restart tybo-telegram-relay                 # Linux (systemd)
```

### Subprozess vermisst eine Variable (Subprocess Is Missing a Variable)

**Symptoms:** Something that works in your own terminal fails when the bot
does it: a `curl` or deploy inside a Claude answer reports a missing token,
`gh` asks for a login, or a script says `X_API_KEY is not set`.

**Cause (since issue #54):** Claude subprocesses no longer inherit every
secret from the bot's environment. `subprocessEnv()` in
`src/lib/subprocess-env.ts` removes variables whose name looks like a secret
(`*_TOKEN`, `*_KEY`, `*_SECRET`, `*PASSWORD*`, `*_PASS`, `SUPABASE_*`,
`TELEGRAM_*`) before starting `claude -p` or the Agent SDK. This blocks the
typical injection `env | curl …`. Network, Bash and tool permissions are
unchanged, and `.env` itself stays readable.

These pass automatically:

- `ANTHROPIC_API_KEY` when set (the CLI in API mode). Other login tokens
  such as `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_AUTH_TOKEN` need
  `TYBO_SUBPROCESS_ENV_ALLOW` or an MCP reference
- variables referenced as `${VAR}` or `$VAR` inside `mcpServers` of
  `~/.claude.json` (global and the bot's project entry), `.mcp.json`,
  `.claude/settings.json`, `.claude/settings.local.json` or
  `~/.claude/settings.json`. Hooks and permission rules do not count
- the Agent SDK's OpenRouter fallback gets the OpenRouter key only as
  `ANTHROPIC_AUTH_TOKEN`

`WEB_PASSWORD`, `CLAUDECODE` and inherited `TYBO_CHAT_ID`/`TYBO_TOPIC_ID`
are always removed; `TYBO_SUBPROCESS=1` is always set.

**Diagnosis:** At startup the bot logs the names (never the values) once:

```bash
grep "subprocess-env" logs/telegram-relay.log | tail -1
```

**Fix:** Release the variable by name in `.env`, comma-separated, then
restart the bot (`bun run restart:request "Freigabe"`):

```bash
TYBO_SUBPROCESS_ENV_ALLOW=GH_TOKEN,CLOUDFLARE_API_TOKEN
```

Only `TYBO_SUBPROCESS_ENV_ALLOW` counts.

Release only what the subprocess really needs: every released value is
visible to the whole Claude process, not just to one tool.

---

### Codex als Motor (Codex as Engine)

Codex liest nichts aus der Claude-Konfiguration: keine Hooks, keine
Claude-Skills, keine MCP-Server aus `~/.claude.json` oder `.mcp.json`.
tybo schreibt nichts in die Codex-Konfiguration; alles Folgende richtet der
Nutzer selbst ein.

**Anmeldung:** einmal im Terminal `codex login` (ChatGPT-Konto im Browser,
ohne Browser `codex login --device-auth`). Prüfen mit `codex login status`
(Exit 0 heißt angemeldet). tybo prüft dasselbe mit `checkEngine("codex")`
(`src/lib/engines/check.ts`: `codex --version` und `codex login status`, je
5 s Zeitlimit, Ergebnis 60 s zwischengespeichert). Meldung „Codex ist nicht
angemeldet": `codex login` ausführen. Meldung „Codex ist nicht installiert":
Codex installieren oder den Pfad mit `CODEX_PATH` in `.env` setzen. Eine
Anmeldung per API-Schlüssel (`OPENAI_API_KEY`, `CODEX_API_KEY`) rechnet zu
API-Preisen ab und erreicht Codex nur über `TYBO_SUBPROCESS_ENV_ALLOW`.

**Projekt-Kontext:** tybo startet Codex mit
`-c project_doc_fallback_filenames=["CLAUDE.md"]` und
`-c project_doc_max_bytes=65536`, Codex liest also dieselbe `CLAUDE.md` wie
Claude Code. Liegt im Projekt eine `AGENTS.md` oder `AGENTS.override.md`,
hat sie Vorrang; eine globale `~/.codex/AGENTS.md` kommt dazu.

**Rechte:** Einstellung `engine.codex.sandbox` in `config/settings.json`,
bei jedem Aufruf neu gelesen; der Wert steht beim ersten Aufruf im Log
(`[Codex] Rechte-Stufe: …`).

| Wert | Bedeutung |
|------|-----------|
| `full` (Standard) | alles erlaubt, ohne Sandbox (`--dangerously-bypass-approvals-and-sandbox`) |
| `workspace-write` | schreiben im Projektordner, mit Netz |
| `read-only` | nur lesen |

Nachfragen gibt es nie (`approval_policy="never"`), es sitzt niemand am
Terminal.

**MCP-Server:** in `~/.codex/config.toml` (oder `$CODEX_HOME/config.toml`)
eintragen, etwa:

```toml
[mcp_servers.notion]
command = "bunx"
args = ["notion-mcp"]
env_vars = ["NOTION_TOKEN"]
startup_timeout_sec = 60
```

Geheime Variablen erreichen Codex, wenn ein Eintrag unter `[mcp_servers.*]`
sie nennt: in `env_vars`, als `${VAR}` in `env`, in `bearer_token_env_var`
oder als Wert von `env_http_headers`. Projektdateien (`.codex/config.toml`)
zählen dafür nicht, dann hilft `TYBO_SUBPROCESS_ENV_ALLOW`. `OPENAI_API_KEY`,
`CODEX_API_KEY` und die Telegram-Bot-Tokens kommen nie über einen
MCP-Eintrag durch, nur über die Freigabeliste; `WEB_PASSWORD` nie.
`CODEX_HOME` wird durchgereicht. Die übrigen Regeln stehen oben unter
„Subprozess vermisst eine Variable".

**Langsame MCP-Server:** Codex wartet standardmäßig 10 s auf den Start eines
Servers. Braucht er länger (etwa `bunx` beim ersten Mal), im Eintrag
`startup_timeout_sec` erhöhen.

**Skills:** Codex liest Skills aus `~/.agents/skills` und `.agents/skills`,
nicht aus `~/.claude/skills`. Wer einen Skill in beiden Motoren braucht,
legt ihn in beiden Ordnern ab.

---

### OpenCode als Motor (OpenCode as Engine)

tybo unterstützt OpenCode 1 (npm-Paket `opencode-ai`, Aufruf
`opencode run --format json`). OpenCode 2 (`@opencode/cli`) wird erkannt und
abgelehnt, bis es eigens eingeplant ist. tybo schreibt nichts in die
OpenCode-Konfiguration und meldet nicht selbst an; alles Folgende richtet
der Nutzer im Terminal ein.

**Installieren:**

```bash
npm i -g opencode-ai@1
opencode --version        # muss mit 1. beginnen
```

Liegt `opencode` nicht im `PATH` des Bots, den Pfad mit `OPENCODE_PATH` in
`.env` setzen.

**Anmeldung und Anbieter:** empfohlen ist OpenRouter:

```bash
opencode auth login -p openrouter
opencode auth list        # zeigt die Anmeldungen
opencode models openrouter
```

Der Schlüssel liegt danach in `~/.local/share/opencode/auth.json` von
OpenCode; tybo reicht keinen Anbieter-Schlüssel automatisch durch. Ebenfalls
möglich sind die ChatGPT-Anmeldung (Plus/Pro), GitHub Copilot, OpenCode Zen
oder ein API-Schlüssel. Claude Pro/Max ist in OpenCode nicht erlaubt,
Anthropic geht dort nur mit API-Schlüssel.

tybo prüft das mit `checkEngine("opencode")` (`src/lib/engines/check.ts`):
`opencode --version` (Hauptversion 1) und `opencode auth list` (mindestens
eine Anmeldung), je 5 s Zeitlimit, Ergebnis 60 s zwischengespeichert.
Meldungen:

| Meldung | Abhilfe |
|---------|---------|
| „OpenCode ist nicht installiert" | installieren (oben) oder `OPENCODE_PATH` setzen |
| „OpenCode 2 wird noch nicht unterstützt" | `npm i -g opencode-ai@1` |
| „OpenCode ist nicht angemeldet" | `opencode auth login -p openrouter` |
| „OpenCode-Anmeldung nicht prüfbar" | `opencode auth list` im Terminal ausführen und die Ausgabe prüfen |

Eine gespeicherte Anmeldung heißt nicht, dass der Schlüssel gilt. Lehnt der
Anbieter ihn beim Antworten ab, antwortet Claude Code mit einem Hinweis und
tybo prüft beim nächsten Mal neu.

Anbieter-Schlüssel aus der Umgebung (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `OPENCODE_API_KEY`, `GEMINI_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`,
`MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`) erreichen OpenCode nur über
`TYBO_SUBPROCESS_ENV_ALLOW`. Viele davon nutzt tybo selbst (Fallback,
Embeddings, Transkription); ohne Freigabe zahlt also nie versehentlich tybos
Schlüssel für OpenCode. Ein freigegebener Schlüssel zählt in der Prüfung als
Anmeldung.

Dasselbe gilt für die Zugangsdaten aller anderen Anbieter, die OpenCode
kennt, etwa `CLOUDFLARE_API_TOKEN`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` oder `HF_TOKEN`: Quelle ist die Anbieterliste von
models.dev (Stand in `src/lib/engines/opencode-provider-env.ts`, dazu
OpenCodes Zwischenspeicher `~/.cache/opencode/models.json` und eigene
Anbieter unter `"provider"` in `opencode.json(c)` im Projekt, in allen
übergeordneten Ordnern und deren `.opencode`-Ordnern, in `~/.opencode/`, in
`~/.config/opencode/` (auch `config.json`), in der Datei aus
`OPENCODE_CONFIG`, im Ordner `OPENCODE_CONFIG_DIR` und in
`OPENCODE_CONFIG_CONTENT`). Reine Einstellungen wie
`AWS_REGION` oder `CLOUDFLARE_ACCOUNT_ID` bleiben erhalten. Variablen, die
ein eigener Anbieter ausdrücklich als Zugangsdatum nennt (`"env": [...]` des
Anbieters oder ein `{env:NAME}` in `apiKey`, `headers.Authorization` und
ähnlichen Feldern), gelten immer als Zugangsdaten, egal wie sie heißen, und
brauchen die Freigabe. Gelesen werden auch die systemweiten Dateien
(`/Library/Application Support/opencode/` auf macOS, `/etc/opencode/` auf
Linux, `%ProgramData%\opencode` auf Windows). Grenzen: Was ein
OpenCode-Plugin selbst aus der Umgebung liest, per MDM-Profil verwaltete
Einstellungen und entfernte Organisations-Konfigurationen sieht tybo nicht;
dort genannte Variablen gelten nach der Namensregel (Entscheidung 0008). In der Prüfung zählen nur die zehn Namen oben.

**Projekt-Kontext:** OpenCode sucht vom Projektordner aufwärts eine
`AGENTS.md`, sonst die `CLAUDE.md`, und liest global `~/.config/opencode/AGENTS.md`,
sonst `~/.claude/CLAUDE.md`. tybo setzt dafür nichts und startet OpenCode
im Projektordner (`--dir`, `PWD`). Liegt im Projekt eine `AGENTS.md`, hat sie
Vorrang. Wer `OPENCODE_DISABLE_CLAUDE_CODE` oder
`OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` selbst setzt, schaltet das Lesen der
`CLAUDE.md` ab; tybo setzt diese Variablen nie.

**Auswählen:** als Standard mit `TYBO_ENGINE=opencode` in `.env` oder auf
der Einstellungsseite (Reiter Agenten, Abschnitt Motor, `engine.default`),
für ein einzelnes Gespräch mit `/motor opencode`. Im Abschnitt OpenCode
stehen Modell, Variante und Rechte (`engine.opencode` in
`config/settings.json`). Die Modell-Liste kommt aus `opencode models`
(10 s Zeitlimit, 10 Minuten zwischengespeichert), OpenRouter-Modelle stehen
vorn. Scheitert der Abruf, steht der Grund unter dem Feld und das Modell
lässt sich frei eingeben (`<anbieter>/<modell>`, etwa
`openrouter/anthropic/claude-opus-5.5`). Leeres Modell heißt: OpenCode nimmt
das Modell aus seiner eigenen Konfiguration, tybo übergibt dann kein
`--model`. Die Variante (`--variant`, der Effort von OpenCode) hängt vom
Anbieter ab und ist frei: 1 bis 20 Zeichen aus Kleinbuchstaben, Ziffern und
Bindestrich (etwa `high`, `max`, `thinking-8k`). tybo übergibt sie als ein
Argument `--variant=<wert>`, damit auch ein Wert mit Bindestrich vorn nie als
eigene Option gelesen wird.

**Rechte:** Einstellung `engine.opencode.permission` in
`config/settings.json`, bei jedem Aufruf neu gelesen; der Wert steht beim
ersten Aufruf im Log (`[OpenCode] Rechte: …`).

| Wert | Bedeutung |
|------|-----------|
| `auto` (Standard) | mit `--auto`: jede Frage (`ask`) wird bestätigt, auch für Dateien außerhalb des Projekts (`external_directory`); Regeln mit `deny` aus der OpenCode-Konfiguration gelten weiter |
| `ask-deny` | ohne `--auto`: jede Frage wird abgelehnt, erlaubt ist nur, was die OpenCode-Konfiguration mit `allow` freigibt |

Eigene Regeln stehen in `opencode.json` unter `"permission"` (siehe
[Permissions](https://opencode.ai/docs/permissions/)); tybo setzt dort und
per `OPENCODE_PERMISSION` nichts.

**MCP-Server:** in `~/.config/opencode/opencode.json` (oder `.jsonc`, bei
gesetztem `XDG_CONFIG_HOME` in `$XDG_CONFIG_HOME/opencode/`) oder im Projekt
in `opencode.json(c)`, etwa:

```json
{
  "mcp": {
    "notion": {
      "type": "local",
      "command": ["bunx", "notion-mcp"],
      "environment": { "NOTION_TOKEN": "{env:NOTION_TOKEN}" }
    }
  }
}
```

Geheime Variablen erreichen OpenCode, wenn ein Eintrag unter `"mcp"` sie als
`{env:NAME}` nennt (in `environment`, `command`, `headers` oder `url`).
Andere Abschnitte der Datei zählen nicht, ebenso wenig MCP-Einträge aus
`OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`, `.opencode`-Ordnern,
übergeordneten Ordnern oder `config.json` und die MCP-Server aus
`~/.claude.json` oder `.mcp.json`. Anbieter-Zugangsdaten (siehe oben) und alle
`TELEGRAM_*`-Variablen kommen nie über einen MCP-Eintrag durch, nur über die
Freigabeliste; `WEB_PASSWORD` nie. Die übrigen Regeln stehen oben unter
„Subprozess vermisst eine Variable".

**Skills:** OpenCode liest Skills aus `.opencode/skills/`,
`~/.config/opencode/skills/`, `.claude/skills/`, `~/.claude/skills/`,
`.agents/skills/` und `~/.agents/skills/`, Claude-Skills also mit.

**Fortschritt:** OpenCode meldet ein Werkzeug erst, wenn es fertig ist; die
Fortschrittsanzeige kommt deshalb etwas später als bei Claude und Codex.

---

### Pipeline nach Netzausfall (interne Werkstatt, nicht Teil von tybo)

Nur für die interne Issue-Pipeline der Werkstatt, in der tybo entwickelt
wird. Pipeline und Startskript gehören nicht zum veröffentlichten tybo; der
Bot selbst ist nicht betroffen und liest keine der Variablen hier.

**Symptome:** Im Protokoll `logs/pipeline.log` stehen `NETZ`- und
`NETZ-WARTEN`-Zeilen, oder per Telegram kommt „Netz war von … bis … weg,
Pipeline macht mit Issue #… weiter“ bzw. „Pipeline hält an, das Netz kam
nicht zurück“.

**Ursache (Issue #197):** Ein DNS-, Verbindungs- oder Zeitüberschreitungsfehler
(auch HTTP 502/503/504, „overloaded“) bei gh, git, Worker oder Prüfer. Die
Pipeline steigt dann nicht aus, sondern sichert halbe Stände per `git stash`,
prüft in steigenden Abständen, ob GitHub und Anthropic erreichbar sind, und
setzt neu an.

**Diagnose:**

```bash
grep -E "NETZ|GESICHERT" logs/pipeline.log | tail -20
git stash list | grep "pipeline "
```

**Fix:** Wartet sie noch, nichts tun. Hat sie nach Ablauf der Wartezeit
angehalten: Netz prüfen und die Pipeline neu starten. Gesicherte Stände wendet
sie nie selbst an; ansehen mit `git stash show -p --include-untracked <oid>`.

**Wartezeit einstellen:** `PIPELINE_NET_WAIT_MINUTES` (Standard 120,
höchstens 1440, ungültige Werte ergeben 120 mit Warnung). Die Pipeline liest
keine `.env`. Nur das Startskript übernimmt den Wert: zuerst aus der Umgebung
beim Start, sonst als Zeile aus der Datei in `PIPELINE_ENV_FILE` (Standard:
die `.env` des laufenden tybo-Checkouts, siehe Startskript):

```bash
PIPELINE_NET_WAIT_MINUTES=30 bash <Startskript der Pipeline>
```

Ausführlich steht der Ablauf in der Pipeline-Anleitung der Werkstatt,
Abschnitt „Fehler und Neustart“.

---

## Debugging Commands Cheatsheet

```bash
# ---- Service Status ----
launchctl list | grep ai.tybo            # Check all services
launchctl list ai.tybo.telegram-relay    # Check specific service

# ---- Force-Run a Service ----
launchctl kickstart gui/$(id -u)/ai.tybo.smart-checkin
launchctl kickstart gui/$(id -u)/ai.tybo.morning-briefing

# ---- View Logs (Real-time) ----
tail -f logs/telegram-relay.log           # Bot main log
tail -f logs/smart-checkin.log            # Check-in log
tail -f logs/morning-briefing.log         # Briefing log
tail -f logs/watchdog.log                 # Watchdog log
tail -f logs/*.log                        # All logs at once

# ---- View Error Logs ----
tail -50 logs/telegram-relay.error.log
tail -50 logs/smart-checkin.error.log

# ---- Process Management ----
ps aux | grep "bun run src"               # Find running processes
cat bot.lock                              # Check lock file PID
rm bot.lock                               # Remove stale lock

# ---- Service Restart ----
launchctl unload ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
launchctl load ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist

# ---- Full Reset ----
bun run uninstall                         # Unload all services
rm bot.lock session-state.json            # Remove state files
bun run setup:launchd -- --service all    # Reinstall all services

# ---- Health Check ----
curl http://localhost:3000/health          # Bot health endpoint
bun run setup:verify                       # Full system health check

# ---- Test Individual Components ----
bun run test:telegram                      # Test Telegram connectivity
bun run test:supabase                      # Test Supabase connectivity
bun run checkin                            # Run check-in manually
bun run briefing                           # Run briefing manually

# ---- Claude CLI ----
claude --version                           # Check CLI version
claude -p "Hello" --output-format text     # Test Claude directly
```

---

## Log File Locations

All logs are in the `logs/` directory within the project root:

| File | Source | Content |
|------|--------|---------|
| `telegram-relay.log` | Main bot stdout | Message processing, startup/shutdown |
| `telegram-relay.error.log` | Main bot stderr | Errors, stack traces |
| `smart-checkin.log` | Check-in stdout | Decision logs, message sends |
| `smart-checkin.error.log` | Check-in stderr | Errors |
| `morning-briefing.log` | Briefing stdout | Data gathering, send status |
| `morning-briefing.error.log` | Briefing stderr | Errors |
| `watchdog.log` | Watchdog stdout | Health check results |
| `watchdog.error.log` | Watchdog stderr | Errors |

Supabase also stores structured logs in the `logs` table, queryable
from the Supabase dashboard or via the REST API.

---

## When to Reset

If nothing else works, a clean reset often helps:

```bash
# 1. Stop all services
bun run uninstall

# 2. Remove state files
rm -f bot.lock session-state.json checkin-state.json

# 3. Clear logs (optional)
rm -f logs/*.log

# 4. Reinstall dependencies
bun install

# 5. Verify configuration
bun run setup:verify

# 6. Test the bot manually
bun run start
# Send a test message on Telegram
# Ctrl+C to stop

# 7. If manual test works, reinstall services
bun run setup:launchd -- --service all
```

---

## VPS Hardening & Access Recovery

### SSH Locked Out (fail2ban)

**Symptoms:** SSH connection refused or times out, even though the VPS is running.

**Cause:** fail2ban bans your IP after too many failed SSH attempts (default: 5 failures = 10min ban). This commonly happens when:
- You have a passphrase-protected SSH key and ssh-agent isn't running
- Your IP changed (dynamic IP from ISP)
- You tried multiple keys before the right one

**Recovery via hosting panel:**
1. Log into your VPS hosting panel (DigitalOcean, Hetzner, etc.)
2. Open the **web terminal / console** (browser-based SSH)
3. Check if you're banned:
   ```bash
   sudo fail2ban-client status sshd
   ```
4. Unban your IP:
   ```bash
   sudo fail2ban-client set sshd unbanip YOUR_IP_HERE
   ```
5. Find your current IP: visit `https://ifconfig.me` in your browser

**Prevention — whitelist your IP range:**

Create `/etc/fail2ban/jail.local`:
```ini
[sshd]
ignoreip = 127.0.0.1/8 ::1 YOUR_IP_RANGE/24
maxretry = 10
bantime = 3600
```

Then restart: `sudo systemctl restart fail2ban`

**Tip:** Use a `/24` subnet (e.g., `95.91.246.0/24`) instead of a single IP, since residential IPs change frequently.

---

### SSH Key Issues

**Symptoms:** `Permission denied (publickey)` or `Too many authentication failures`

**Common causes:**
- **Passphrase-protected key**: ssh-agent isn't running or key isn't loaded. Fix: `ssh-add ~/.ssh/your_key` or generate a new key without passphrase for server access
- **Wrong key**: SSH tries all keys by default. Use `IdentitiesOnly yes` in `~/.ssh/config` to force a specific key
- **Key not on server**: Your public key isn't in `~/.ssh/authorized_keys` on the VPS

**Recommended SSH config:**
```
Host my-vps
  HostName your-server-ip
  User ubuntu
  IdentityFile ~/.ssh/id_ed25519_vps
  IdentitiesOnly yes
```

**Generate a new key (no passphrase):**
```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_vps -N "" -C "my-vps"
```

Then add the public key to your VPS via the hosting panel's web terminal:
```bash
echo "YOUR_PUBLIC_KEY" >> /home/ubuntu/.ssh/authorized_keys
```

---

### UFW Firewall Rules

The VPS needs these ports open:
```bash
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP (for webhooks)
sudo ufw allow 443/tcp   # HTTPS (if using SSL)
sudo ufw allow 3000/tcp  # Bot gateway (if not behind reverse proxy)
```

Check status: `sudo ufw status verbose`

---

### API Budget & Cost Management

**How the budget system works:**
- `DAILY_API_BUDGET` in `.env` sets your daily spend limit (default: $5)
- When remaining budget drops below $1, Opus requests auto-downgrade to Sonnet
- When budget hits $0, all requests get a "budget exceeded" message
- Budget resets at midnight (server time)

**Recommended budgets:**
| Usage Level | Budget | Notes |
|------------|--------|-------|
| Light (5-10 msgs/day) | $5 | Mostly Haiku/Sonnet |
| Moderate (10-30 msgs/day) | $15 | Mix of all tiers |
| Heavy (30+ msgs/day, research) | $50+ | Frequent Opus usage |

**Monitor spending:** Check the gateway logs for `[COST]` entries:
```bash
grep COST /tmp/gateway.log | tail -20
```

---

## VPS-Specific Issues

If you deployed to a VPS, these additional issues may apply.

### Claude Subprocesses Fail on VPS

**Symptoms:** Bot returns fallback responses or errors for every message.

**Fix:** Claude Code on a headless VPS cannot use OAuth. You must set
`ANTHROPIC_API_KEY` in `.env`:

```bash
grep ANTHROPIC_API_KEY .env
# Should show your API key, not a placeholder
```

Test Claude directly:

```bash
claude -p "Hello" --output-format text
```

### PM2 Services Not Starting After Reboot

**Fix:** Ensure PM2 startup was configured:

```bash
pm2 startup
# Follow the printed command
pm2 save
```

### Cron Jobs Silent Failures

**Fix:** Check cron logs:

```bash
grep CRON /var/log/syslog | tail -20
```

Common issue: `bun` not in cron's PATH. The `setup:services` script uses
`cd /path/to/project && bun run script.ts` to handle this.

### VPS Debugging Cheatsheet

```bash
# ---- PM2 Service Status ----
pm2 status                                # All services
pm2 logs tybo-telegram-relay --lines 50   # Bot logs
pm2 logs tybo-telegram-relay --err        # Error logs only

# ---- Cron Schedule ----
crontab -l                                # View all cron entries
grep CRON /var/log/syslog | tail -20      # Cron execution log

# ---- System Resources ----
htop                                      # Interactive process viewer
free -h                                   # Memory usage
df -h                                     # Disk usage

# ---- Network ----
curl -I https://api.telegram.org          # Test Telegram API access
curl -I https://api.anthropic.com         # Test Anthropic API access

# ---- Restart Everything ----
pm2 restart all                           # Restart all PM2 services
```

---

## How to Report Issues

When reporting a problem, include:

1. **What you expected** vs **what happened**
2. **Relevant log output** (last 50 lines of the appropriate log file)
3. **Your environment:**
   ```bash
   bun --version
   claude --version
   sw_vers                   # macOS version
   bun run setup:verify      # Health check output
   ```
4. **Steps to reproduce** the issue
5. **Any recent changes** you made (new API keys, code edits, etc.)

---

## Relevant Source Files

| File | Purpose |
|------|---------|
| `src/bot.ts` | Main bot with lock file, shutdown, health server |
| `src/lib/claude.ts` | Subprocess management, timeout, JSON extraction |
| `src/lib/supabase.ts` | Database connection test function |
| `src/lib/fallback-llm.ts` | Fallback chain with error logging |
| `src/lib/execution-context.ts` | Plätze (`MAX_AGENT_PROCESSES`), Warteschlange, `/stop`, AbortError |
| `src/lib/agent-capacity.ts` | Grenze gleichzeitiger Aufträge nach Arbeitsspeicher oder `MAX_AGENT_PROCESSES` |
| `src/lib/queue-notice.ts` | Text des Wartehinweises |
| `setup/verify.ts` | Full system health check |
| `setup/configure-launchd.ts` | Service installer |
| `.env.example` | Environment variable reference |

---

**Back to start:** [Einrichtung](./einrichtung.md)
