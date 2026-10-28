# Störungen beheben

Hier steht, was zu tun ist, wenn tybo nicht tut, was es soll. Gesucht wird
nach dem, was du siehst: eine Meldung, eine fehlende Antwort, ein Gedächtnis,
das leer wirkt. Jeder Abschnitt nennt zuerst das Zeichen, dann wie du
nachsiehst, was hilft und woran du merkst, dass es wieder geht.

Einen Überblick über die ganze Einrichtung gibt `tybo pruefen`. Der Bericht
zeigt je Teil, ob er in Ordnung ist, und endet mit einem Exit-Code ungleich 0,
wenn etwas fehlt. Wer `bun link` nicht ausgeführt hat, nimmt im Projektordner
`bun run setup:verify`.

Die Befehle unten laufen im Projektordner (Standard `~/tybo`), wenn nichts
anderes dabeisteht. Werte aus der `.env` gehören in keine Nachricht und in
kein Forum; wo ein Befehl einen Schlüssel braucht, liest er ihn selbst aus der
Datei.

---

## Installation

### Installation mit einem Befehl

Meldungen von `curl -fsSL https://tybo.ai/install | sh` und was hilft. Jede
Meldung des Installers beginnt mit `tybo:`. Ein `…` steht für einen Ordner
oder Programmnamen, der auf jedem Rechner anders aussieht. Vor dem Holen von
tybo kann der Installer nach deinem Ja Bun installieren oder mit `bun upgrade`
aktualisieren; der offizielle Bun-Installer schreibt Bun dabei in deine
Shell-Startdatei. Scheitert später etwas, bleibt das so. Nach der Abhilfe
denselben Befehl einfach noch einmal ausführen, er findet das vorhandene Bun
und macht dort weiter. Anleitung: [einrichtung.md](einrichtung.md#schnellweg-ein-befehl).

#### `tybo: command not found` nach der Installation

**Symptom:** `tybo: command not found` (bash) bzw. `zsh: command not found: tybo`.
Das sagt die Shell, nicht der Installer.

**Meldung**, eine von zwei:

- `tybo: …/bin ist in diesem Terminal noch nicht im PATH. In ~/.bashrc steht schon ein Eintrag dafür: …` (danach als Rückfall die zwei Zeilen)
- `tybo: …/bin ist nicht im PATH, der Befehl tybo wird sonst nicht gefunden.`

**Abhilfe:** `bun link` legt den Befehl `tybo` in `~/.bun/bin` ab, und dieser
Ordner fehlt im `PATH` der offenen Sitzung.

- Erste Meldung: Die genannte Startdatei enthält schon einen Eintrag, meist
  vom Bun-Installer. Ein neues Terminal bzw. eine neue SSH-Sitzung öffnen oder
  die Datei neu einlesen, etwa `source ~/.bashrc`. Der Installer liest
  `~/.zshrc` (zsh) bzw. `~/.bashrc` und `~/.bash_profile` (bash) nur, er führt
  sie nicht aus. `if`-Zweige, Funktionen und spätere Zuweisungen wertet er
  nicht vollständig aus; deshalb verspricht die Meldung nicht, dass der
  Eintrag wirkt. Erst wenn `tybo` danach noch fehlt, die zwei Rückfall-Zeilen
  aus der Ausgabe eintragen.
- Zweite Meldung: Die zwei Zeilen, die der Installer darunter ausgibt, in
  `~/.zshrc` (zsh, macOS) bzw. `~/.bashrc` (bash, Linux) eintragen und ein
  neues Terminal öffnen.

Bis dahin geht im Projektordner `bun run setup` statt `tybo setup`.

**Danach:** `tybo help` zeigt die Unterbefehle.

#### Claude CLI liegt in ~/.local/bin, ist aber nicht im PATH

**Meldung:** `Claude CLI liegt in ~/.local/bin, das ist noch nicht im PATH: neue Sitzung öffnen.`
(vom Installer oder von `tybo setup voraussetzungen`)

**Abhilfe:** Der Claude-Installer (`curl -fsSL https://claude.ai/install.sh | bash`)
legt `claude` in `~/.local/bin` ab. Debian, Raspberry Pi OS und andere
Linux-Systeme nehmen diesen Ordner erst bei der nächsten Anmeldung in den
`PATH`. Nichts neu installieren, sondern eine neue Sitzung öffnen. Bleibt es
dabei (etwa unter macOS mit zsh), die angezeigte Zeile
`export PATH="$HOME/.local/bin:$PATH"` in `~/.zshrc` bzw. `~/.bashrc`
eintragen. Steht `CLAUDE_PATH` in der `.env`, prüft `tybo setup` nur diesen
Pfad.

**Danach:** `claude --version` antwortet mit einer Versionsnummer, und
`tybo setup voraussetzungen` meldet die Claude CLI als vorhanden.

#### Lokale Änderungen, nichts geändert

**Meldung:** `tybo: lokale Änderungen in …, nichts geändert. Anzeigen mit: cd … && git status; eigene Änderungen sichern (etwa mit git stash) und diesen Befehl erneut ausführen.`

**Abhilfe:** Beim Aktualisieren sind im Zielordner Dateien geändert, die Git
verwaltet. Der Installer überschreibt sie nicht. `git status` zeigt, welche
es sind. Sichern oder mit `git restore <datei>` verwerfen, dann den Befehl
erneut ausführen. `.env` und `config/profile.md` verwaltet Git nicht, sie
lösen die Meldung nie aus.

Zwei verwandte Meldungen, gleiche Abhilfe nach einem Blick auf `git status`
und `git log`:

**Meldung:** `tybo: … weicht vom Stand auf origin/… ab (eigene Commits), nichts geändert.`

**Meldung:** `tybo: … steht auf Branch …, nicht auf …, nichts geändert.`

**Danach:** Der Befehl läuft durch und meldet den neuen Stand.

#### Historie neu aufgebaut

Mit tybo 2.16.0 wurde die Historie des öffentlichen Repos neu aufgebaut: Es
beginnt mit einem einzigen Commit „tybo 2.16.0“ ohne Vorgänger, die alten
Versionen 2.12.0 bis 2.15.x sind dort nicht mehr. Ein älterer Klon hat mit
dem neuen Stand keinen gemeinsamen Vorfahren mehr, ein einfaches Vorspulen
(`git pull --ff-only`) geht deshalb einmal nicht. Der Installer erkennt das.

**Meldung:** `tybo: die Historie von tybo wurde neu aufgebaut. Setze … auf den neuen Stand; .env, config/, data/, logs/ und models/ bleiben.`

Kein Fehler. Der Klon hatte weder lokale Änderungen noch eigene Commits, der
Installer stellt ihn auf den neuen Stand. Dateien, die Git nicht verwaltet
(`.env`, eigene Dateien in `config/`, `data/`, `logs/`, `models/`), bleiben
unverändert. Danach wie bei jedem Update einmal neu starten; den Befehl nennt
der Installer am Ende.

**Meldung:** `tybo: die Historie von tybo wurde neu aufgebaut, und … enthält eigene Commits auf der alten Historie, nichts geändert. Eigene Commits erst sichern, etwa mit: cd … && git branch meine-sicherung; danach: git reset --hard origin/… und diesen Befehl erneut ausführen.`

**Abhilfe:** Im Klon liegen Commits, die nie aus dem öffentlichen Repo kamen.
Der Installer überschreibt sie nicht. Mit `git branch meine-sicherung` bleiben
sie unter diesem Namen erhalten, `git reset --hard origin/master` stellt
`master` auf den neuen Stand, danach läuft der Installer normal durch. Eigene
Änderungen später gezielt übernehmen, etwa mit
`git cherry-pick <commit>` aus `meine-sicherung`.

**Meldung:** `tybo: die Historie von tybo wurde neu aufgebaut, aber der neue Stand würde Dateien in … überschreiben, die Git dort nicht verwaltet:…. Nichts geändert; diese Dateien wegsichern und diesen Befehl erneut ausführen.`

**Abhilfe:** Der neue Stand bringt Dateien mit, die im Ordner schon als eigene,
nicht verwaltete Dateien liegen. Die genannten Dateien an einen anderen Ort
verschieben, den Befehl erneut ausführen und danach vergleichen, was davon
noch gebraucht wird.

**Von Hand statt mit dem Installer:** erst eigene Änderungen sichern, dann
`git fetch origin && git reset --hard origin/master` und
`bun install --frozen-lockfile`. `.env`, `config/` und `data/` bleiben dabei.

**Danach:** Der Installer meldet „Aktualisiert auf …“, spätere Updates laufen
wieder per Vorspulen.

#### Gehört nicht zu tybo

**Meldung:** `tybo: … gehört nicht zu tybo, nichts geändert. Einen anderen Ordner wählen: --dir <pfad>`

**Abhilfe:** Den Zielordner (Standard `~/tybo`) gibt es schon, aber er ist
kein Klon von tybo: eine Datei, ein Ordner mit anderem Inhalt, ein Ordner
innerhalb eines anderen Git-Repos oder ein Klon eines fremden Repos. Der
Installer lässt ihn in Ruhe. Einen anderen Ordner angeben:

```bash
curl -fsSL https://tybo.ai/install | sh -s -- --dir ~/apps/tybo
```

Für spätere Updates immer denselben Ordner nennen wie bei der ersten
Installation.

#### Kein Terminal: Einrichtung startet nicht

**Meldung:** `tybo: tybo ist installiert. Weiter mit: cd … && tybo setup`

**Abhilfe:** Ohne Terminal für Rückfragen (`ssh` ohne `-t`, ein Skript, eine
CI) installiert der Installer, startet den Assistenten aber nicht. Die
Einrichtung danach in einem normalen Terminal mit dem Befehl aus der Meldung
starten. Dasselbe gilt, wenn der Assistent abgebrochen wurde:

**Meldung:** `tybo: Einrichtung nicht abgeschlossen. Später weiter mit: cd … && tybo setup`

Fehlt zusätzlich Bun, kann der Installer ohne Terminal nicht nachfragen:

**Meldung:** `tybo: Bun fehlt oder ist zu alt, und ohne Terminal kann ich nicht fragen.`

Dann Bun selbst installieren (`curl -fsSL https://bun.sh/install | bash`)
oder den Installer mit `--yes` aufrufen (`… | sh -s -- --yes`).

**Danach:** `tybo setup --liste` zeigt die Schritte und welche noch offen sind.

#### Linux ohne `unzip`

**Meldung:** `tybo: … fehlt, der Bun-Installer braucht bash, curl und unzip.`

**Abhilfe:** Der offizielle Bun-Installer braucht `unzip`, das auf schlanken
Linux-Systemen oft fehlt. Nachinstallieren, etwa `sudo apt install unzip`
(Debian, Ubuntu) oder `sudo dnf install unzip` (Fedora), dann den Befehl
erneut ausführen.

#### Firmen-Proxy oder gesperrter Download

**Symptom:** `curl` meldet einen Fehler, bevor der Installer etwas ausgibt,
oder eine dieser Meldungen erscheint:

**Meldung:** `tybo: Bun-Installer ließ sich nicht laden (…). Internetverbindung prüfen und erneut versuchen.`

**Meldung:** `tybo: git clone ist fehlgeschlagen. Internetverbindung prüfen und erneut versuchen.`

**Abhilfe:** Der Installer umgeht keinen Proxy. Braucht dein Netz einen, die
Adresse bei der IT erfragen und vorher setzen, `curl` und `git` lesen sie
beide: etwa `export HTTPS_PROXY=http://proxy.example:8080`. Wer das Skript
vor dem Ausführen lesen will, lädt es erst herunter und startet es nur, wenn
der Download geklappt hat:

```bash
curl -fsSL https://tybo.ai/install -o install.sh
less install.sh
sh install.sh
```

Optionen kommen direkt dahinter, etwa `sh install.sh --dir ~/apps/tybo`. Lässt
sich gar nichts laden, bleibt der Weg von Hand in
[einrichtung.md](einrichtung.md#von-hand-einrichten).

#### Großer Ordner `~/.cache/puppeteer` nach einer älteren Installation

**Symptom:** Auf Festplatte, SD-Karte oder SSD wird es eng, und
`du -sh ~/.cache/puppeteer` zeigt mehrere hundert MB (auf dem Raspberry Pi
etwa 652 MB).

**Abhilfe:** Ältere tybo-Versionen hatten Puppeteer als Abhängigkeit, und
`bun install` lud dabei einen Chrome-Browser in diesen Ordner. tybo braucht
ihn nicht; auf dem Raspberry Pi ist es sogar ein x86-64-Programm, das dort gar
nicht startet. Neue Installationen und Updates laden ihn nicht mehr, ein
vorhandener Ordner bleibt aber liegen. Er ist ein gemeinsamer
Zwischenspeicher: Nutzt ein anderes Programm auf dem Rechner Puppeteer, nicht
löschen. Sonst:

```bash
rm -rf ~/.cache/puppeteer
```

### `bun` wird nach der Installation nicht gefunden

**Symptom:** Direkt nach dem Installieren von Bun meldet `bun install`
„command not found“.

**Nachsehen:** `ls ~/.bun/bin/bun` zeigt, ob Bun da ist. Ist die Datei da,
fehlt nur der Ordner im `PATH` des Terminals, in dem du installiert hast.

**Abhilfe:** Der Bun-Installer trägt sich in der Regel selbst in `~/.zshrc`,
`~/.bashrc` oder `~/.bash_profile` ein. Ein neues Terminal bzw. eine neue
SSH-Sitzung öffnen oder die Datei mit `source` neu einlesen. Fehlt der
Eintrag, diese Zeile in die Datei schreiben:

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

**Danach:** `bun --version` antwortet mit einer Versionsnummer.

### Supabase-Schlüssel sehen anders aus als erwartet

**Symptom:** Im Supabase-Dashboard stehen Schlüssel, die mit `sb_secret_`
oder `sb_publishable_` beginnen statt mit `eyJ`, oder Claude Code zweifelt
beim Einrichten am Format.

**Abhilfe:** Supabase hat die Schlüssel umbenannt. Der Secret key
(`sb_secret_…`) ersetzt den früheren `service_role`-Schlüssel, der
Publishable key (`sb_publishable_…`) den früheren `anon`. tybo nimmt beide
Generationen in denselben Variablen: `SUPABASE_SERVICE_ROLE_KEY` bekommt den
Secret key oder `service_role`, `SUPABASE_ANON_KEY` den Publishable key oder
`anon`. Einfach eintragen, was das Dashboard zeigt; Claude Code darf man
sagen, dass das Format stimmt. Einen `sb_publishable_…` im Feld für den
schreibenden Schlüssel lehnt `tybo setup datenbank` ab, weil er nicht
schreiben darf.

Mit einem `sb_secret_…` müssen die Edge Functions mit `--no-verify-jwt`
deployt sein, siehe [Semantische Suche fällt still auf Textsuche zurück](#semantische-suche-fällt-still-auf-textsuche-zurück).

**Danach:** Der Verbindungstest von `tybo setup datenbank` meldet Lesen und
Schreiben als erfolgreich.

### macOS meldet neue Hintergrundobjekte

**Symptom:** Nach `tybo setup autostart` oder `tybo dienste` zeigt macOS eine
Mitteilung, dass Software im Hintergrund laufen kann. Als Herkunft steht
dort der Entwickler von Bun, nicht tybo.

**Abhilfe:** Das ist erwartet. Die Dienste von tybo laufen mit Bun, und macOS
nennt den Unterzeichner des Programms. Erlauben, sonst starten die Dienste
nicht nach Plan. Ändern lässt es sich später unter Systemeinstellungen,
Allgemein, Anmeldeobjekte.

**Danach:** `tybo pruefen` meldet die Dienste als eingerichtet.

### Claude Code fragt beim Einrichten um Erlaubnis

**Symptom:** Wer tybo mit Claude Code einrichtet, wird vor Befehlen und
Dateiänderungen gefragt.

**Abhilfe:** Das ist so gewollt: Claude Code fragt, bevor es Befehle ausführt
oder Dateien ändert. Jede Aktion einzeln bestätigen oder „für diese Sitzung
erlauben“ wählen.

---

## Start und Kanäle

### Startmeldung „Telegram nicht eingerichtet: nur WebUI"

**Was es heißt:** In der `.env` stehen weder `TELEGRAM_BOT_TOKEN` noch
`TELEGRAM_USER_ID`, die WebUI ist eingerichtet. Dann läuft tybo mit Absicht
ohne Telegram (Entscheidung 0021): kein Abruf bei Telegram, keine
Agenten-Bots, Antworten, Meldungen und Rückfragen nur im Browser und per
Push. Die Startübersicht zeigt `Telegram: nicht eingerichtet (nur WebUI)`.

**Telegram dazunehmen:** `tybo setup telegram`, danach tybo neu starten (in
der WebUI: Neustart anfordern). Reste wie `TELEGRAM_GROUP_ID` oder
`TELEGRAM_BOT_TOKEN_<AGENT>` stören ohne Telegram nicht; `tybo pruefen` führt
sie als übersprungen.

**Danach:** Die Startübersicht nennt Telegram als eingerichtet, und eine
Nachricht an den Bot bekommt eine Antwort.

### Startmeldung „Telegram halb eingerichtet"

**Symptom:** tybo startet nicht normal, sondern im Einrichtungsmodus. Im Log
steht etwa `Einrichtungsmodus: Telegram halb eingerichtet:
TELEGRAM_BOT_TOKEN ist gesetzt, TELEGRAM_USER_ID fehlt. Beide Werte setzen
oder beide entfernen.`

**Ursache:** Nur einer der beiden Telegram-Werte steht in der `.env`, oder
einer ist noch der Platzhalter aus `.env.example`, oder die Nutzer-ID ist
keine Zahl. Auch mit gültiger WebUI zählt das als Fehler: Ein Tippfehler soll
nicht unbemerkt zu einem Bot ohne Telegram führen.

**Abhilfe:** Beide Werte setzen (`tybo setup telegram`) oder beide aus der
`.env` löschen, wenn du nur die WebUI nutzt. Nach „Fertig“ im
Einrichtungsmodus starten launchd, systemd bzw. PM2 den Bot neu.

**Danach:** `tybo pruefen` zeigt unter „Channels“ keinen Fehler mehr, und
der Bot startet normal.

### Bot antwortet nicht

**Symptom:** Eine Nachricht in Telegram oder im Browser bleibt ohne Antwort,
auch ohne „tippt…“.

**Nachsehen, der Reihe nach:**

1. **Läuft der Dienst?**

   ```bash
   launchctl list | grep ai.tybo.telegram-relay     # macOS
   systemctl --user status tybo-telegram-relay      # Linux mit systemd
   pm2 status                                       # Linux mit PM2
   ```

   Unter macOS steht eine Zeile wie `1234  0  ai.tybo.telegram-relay`. Ein `-`
   statt der Zahl vorn heißt: eingerichtet, läuft aber nicht. Fehlt die Zeile
   ganz, ist der Dienst nicht eingerichtet; dann `tybo setup autostart`.

2. **Was steht im Log?**

   ```bash
   tail -n 50 logs/telegram-relay.log
   tail -n 50 logs/telegram-relay.error.log
   ```

   Gesucht sind fehlende Werte, Verbindungsfehler und Abstürze. Kommt die
   Antwort von einem Ersatzmodell oder gar nicht, scheitert meist die Claude
   CLI selbst (Anmeldung, Abo-Limit, `PATH`); siehe
   [Lange Läufe und Zeitlimit](#lange-läufe-und-zeitlimit).

3. **Gilt der Bot-Token noch, stimmt die Nutzer-ID?** `tybo setup telegram`
   prüft den Token bei Telegram und schickt eine Testnachricht. Nachrichten
   von anderen Nutzer-IDs als `TELEGRAM_USER_ID` übergeht der Bot ohne
   Antwort; eine falsche ID sieht deshalb aus wie ein toter Bot.

4. **Hält ein anderer Prozess die Sperre?** Die Datei `bot.lock` im
   Projektordner enthält die Prozessnummer des Bots, der gerade läuft. Ein
   zweiter Start beendet sich sofort und still, solange dieser Prozess lebt.
   Ist der Besitzer tot, ersetzt der nächste Start die Sperre selbst.

   ```bash
   cat bot.lock && ps -p "$(cat bot.lock)" -o pid,command
   ```

   Zeigt `ps` einen Prozess, läuft schon ein Bot: siehe
   [Zwei Bots laufen gleichzeitig](#zwei-bots-laufen-gleichzeitig). Die
   Sperre nicht von Hand löschen. Das hilft nur, wenn in der Datei keine
   Prozessnummer steht (leer oder kaputt) und nachweislich kein Bot läuft.

**Danach:** Eine Testnachricht bekommt eine Antwort, und im Log steht der
Eingang der Nachricht.

### Zwei Bots laufen gleichzeitig

**Symptom:** Antworten kommen doppelt, abwechselnd von verschiedenen Ständen,
oder Telegram-Nachrichten verschwinden scheinbar. Im Fehler-Log kann ein
`409` mit `Conflict` von Telegram stehen.

**Ursache:** Zwei Prozesse holen mit demselben Bot-Token Nachrichten ab: ein
zweiter Rechner, ein zweiter Ordner, ein von Hand gestarteter Bot neben dem
Dienst oder ein Dienst unter launchd und PM2 zugleich. Auf demselben Rechner
im selben Ordner verhindert `bot.lock` das; über Ordner und Rechner hinweg
nicht.

**Nachsehen:**

Für jeden laufenden Bot zwei Dinge feststellen: welcher Manager ihn startet
und aus welchem Ordner er läuft.

```bash
ps aux | grep '[s]rc/bot.ts'                       # alle Bots mit Prozessnummer
lsof -a -d cwd -p <prozessnummer>                  # Ordner eines Bots
launchctl list | grep ai.tybo.telegram-relay       # macOS: launchd
plutil -extract WorkingDirectory raw ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
systemctl --user status tybo-telegram-relay.service    # Linux: systemd
systemctl --user cat tybo-telegram-relay.service | grep WorkingDirectory
pm2 describe tybo-telegram-relay | grep -E 'exec cwd|script args'   # PM2
```

Ein Bot, den keiner der drei Manager nennt, wurde von Hand gestartet. Auf
anderen Rechnern mit derselben `.env` ebenso nachsehen.

**Abhilfe:** Erst festlegen, welcher Bot bleibt (Rechner und Ordner). Dann nur
den überzähligen Bot-Dienst bei seinem Manager stilllegen, nicht mit `kill`
(der Dienst startet ihn sonst gleich wieder):

- launchd: `launchctl unload ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist`,
  danach die Datei aus `~/Library/LaunchAgents` herausschieben, sonst lädt
  launchd sie bei der nächsten Anmeldung wieder.
- systemd: `systemctl --user disable --now tybo-telegram-relay.service`.
- PM2: `pm2 delete tybo-telegram-relay`, danach `pm2 save`, damit
  `pm2 resurrect` ihn nicht zurückholt (bleibt die Liste leer, verlangt PM2
  `pm2 save --force`).
- Von Hand im Terminal gestartet: dort Strg+C.

Auf einem zweiten Rechner gilt dasselbe. Nicht zum Abstellen eines einzelnen
Bots taugt `tybo deinstallieren`: Es entfernt alle tybo-Dienste des Benutzers
auf diesem Rechner, unter macOS jede `ai.tybo.*`-Plist, auch mit `TYBO_ROOT`.
Das träfe auch den Bot, der bleiben soll, samt Routinen und Morgenbriefing.
Der Befehl passt nur, wenn auf dem Rechner gar nichts von tybo mehr laufen
soll.

**Danach:** `ps` zeigt einen Bot, und jede Nachricht bekommt genau eine
Antwort.

---

## Antworten und Zeitlimits

### Lange Läufe und Zeitlimit

**Symptom:** Lange „tippt…“, zwischendurch „⏳ Läuft seit … Minuten“, am Ende
eine Antwort, die mit „⏱ Zeitlimit: …“ beginnt und die zuletzt aufgerufenen
Schritte aufzählt.

**Grenzen:** Eine Antwort aus Telegram oder dem Browser läuft gestreamt und
hat zwei Grenzen (`src/lib/turn-limits.ts`):

- **Leerlauf, Standard 15 Minuten.** Jede Zeile, die die CLI ausgibt, zählt
  als Lebenszeichen: Text, Werkzeug-Ergebnisse, Ereignisse von
  Hilfs-Agenten, Zwischenstände beim Schreiben und Nachdenken. Während ein
  Werkzeug läuft, meldet sich die CLI alle 30 Sekunden. Kommt 15 Minuten gar
  nichts, gilt der Lauf als hängend: „⏱ Zeitlimit: seit 15 Minuten keine
  Aktivität“.
- **Obergrenze, Standard 90 Minuten.** Beendet auch einen Lauf, der noch
  arbeitet: „⏱ Zeitlimit: Obergrenze von 90 Minuten erreicht“.

„⏳ Läuft seit …“ erscheint nach 20 Minuten und dann alle 20 Minuten. `/stop`
(im Browser der Stopp-Knopf) bricht sofort ab. Aufrufe ohne Fortschritt, die
erst am Ende Text liefern, kennen keinen Leerlauf und enden nach 30 Minuten.

**Nachsehen:** Beim Abbruch schreibt der Bot Art, Laufzeit und Phase ins Log,
dazu `Claude streaming timeout/idle, kein Fallback`. Die Phase steht als ein
Satz auch in der Meldung und sagt, wo es hing:

- `wartet auf API seit …`: die Anfrage an Anthropic kam nicht zurück.
- `Modell generiert …`: die Antwort lief an und blieb mitten im Schreiben
  stehen.
- `Werkzeug <Name> läuft seit …`: ein Werkzeug oder Hilfs-Agent kam nicht
  zurück, etwa eine Suche über sehr große Dateien.
- `CLI-Start seit …`: Hooks oder MCP-Server beim Start der CLI.
- `Nachricht fertig seit …, kein result`: die Antwort war da, die CLI schloss
  nicht ab, oft wegen eines Hooks (siehe
  [Antwort handelt von etwas anderem](#antwort-handelt-von-etwas-anderem)).

**Was der Bot nach dem Zeitlimit tut:** nichts neu starten. Ein zweiter
Anlauf finge den Auftrag in frischer Session von vorn an und könnte Commits,
Issues oder Nachrichten doppelt erzeugen. Die Antwort ist stattdessen ein
fester Bericht ohne Modell, in Telegram und Browser gleich: Art des Abbruchs
mit Laufzeit, die letzten acht aufgerufenen Werkzeuge (Befehle und Pfade
gekürzt; ob sie fertig wurden, ist offen) und der letzte Zwischentext. Werte
aus der `.env` erscheinen dort als `[verborgen]`; ist die `.env` nicht
lesbar, nennt der Bericht nur Werkzeugnamen. Merk-Tags wie `[REMEMBER:]` im
Bericht lösen nichts aus.

**Abhilfe:**

- Mit `SESSION_MODE=resume` steht am Ende „Schreib **weiter** …“: Die
  Antwort `weiter` setzt genau die abgebrochene Session fort, `/new` beginnt
  neu. Ohne Session-Modus, ohne gemeldete Session-ID oder wenn
  `data/sessions.json` nicht schreibbar war, bittet der Bericht, erst den
  Stand zu prüfen und den Auftrag dann noch einmal zu schicken.
- Andere Grenzen in der `.env`, in ganzen Minuten von 1 bis 1440, wirksam
  nach einem Neustart von tybo:

  ```bash
  TYBO_CLAUDE_IDLE_MIN=15
  TYBO_CLAUDE_MAX_MIN=90
  ```

  Ein ungültiger Wert wie `15m` oder `0` gilt als nicht gesetzt; das Log
  meldet `[chat-turn] TYBO_CLAUDE_IDLE_MIN ungültig …`, ohne den Wert zu
  zeigen.
- Aufträge, die länger brauchen als die Obergrenze, gehören in einen
  Hintergrund-Job ([hintergrund-jobs.md](hintergrund-jobs.md)).

**Wenn gar keine Antwort kommt oder nur die eines Ersatzmodells:** Dann ist
meist nicht das Zeitlimit schuld, sondern die Claude CLI scheitert. Solche
Fehler (Anmeldung abgelaufen, Limit erreicht, CLI fehlt) laufen weiter über
die Ersatzmodelle. Im Terminal prüfen:

```bash
claude --version                          # antwortet die CLI?
claude -p "Hallo" --output-format text
```

Meldet das einen Anmeldefehler, `claude` aufrufen und neu anmelden. Stehen in
`logs/telegram-relay.error.log` Zeilen mit `429`, `rate_limit_error` oder
`overloaded_error`, ist das Limit bei Anthropic erreicht: einige Minuten
warten oder Ersatzmodelle einrichten (`tybo setup modelle`).

**Danach:** Die nächste Antwort kommt von Claude, ohne Hinweis auf ein
Ersatzmodell, und ohne Zeitlimit-Bericht.

### Job endet ohne Bericht („Ich warte auf das Ergebnis")

**Symptom:** Ein Hintergrund-Job meldet „Job ohne Bericht“, und die letzte
Zeile im Job-Log klingt nach Weiterarbeit, etwa „der Testlauf läuft im
Hintergrund“ oder „ich melde mich, sobald das Ergebnis da ist“. Danach kommt
nichts mehr; Änderungen bleiben uncommittet, ein Build fehlt.

**Ursache:** Jobs und Antworten laufen als `claude -p`. Dieser Prozess endet,
sobald Claude seinen Turn abschließt, und nimmt Befehle im Hintergrund mit.
Ein Ergebnis, auf das Claude „wartet“, kommt dann nie an.

**Was tybo dagegen tut:**

- Jeder Claude-Subprozess bekommt `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`
  (`src/lib/subprocess-env.ts`): Ein Befehl kann nicht mehr in den
  Hintergrund wechseln, über seinem Zeitlimit endet er mit „Command timed
  out“. Ein eigener Wert in der Umgebung des Bots geht vor, `=0` schaltet die
  Sperre ab.
- Werkzeuge, die nur warten (`Monitor`, `ScheduleWakeup`, `CronCreate`), sind
  in Antworten und Jobs gesperrt.
- In Jobs darf ein einzelner Befehl bis 60 Minuten im Vordergrund laufen, in
  Antworten 10 Minuten.
- „Job ohne Bericht“ sagt ausdrücklich, dass nichts mehr nachkommt, und
  nennt Prozesse aus dem Job, die noch laufen (Prozessnummer und Befehl; tybo
  beendet sie nicht).

**Nachsehen:**

```bash
bun run job log <id> | tail -20
cat data/jobs/<id>/status.json      # outcome, notice.state, leftovers
grep "Meldung zugestellt" data/jobs/<id>/watcher.log
```

**Abhilfe:** Den Job mit demselben Auftrag neu starten. Läuft der alte noch
(`bun run job list`), lehnt `job start` einen gleichen Titel oder Auftrag ab
(Exit 2); bewusst doppelt nur mit `--allow-duplicate`. Mehr:
[hintergrund-jobs.md](hintergrund-jobs.md).

**Danach:** Der neue Job endet mit einem Bericht, und `status.json` zeigt ein
`outcome`.

### Antwort wartet: „Warte auf einen freien Platz"

**Symptom:** Im Chat steht „⏳ Warte auf einen freien Platz, gerade laufen 3
andere Aufträge (…)“, die Tippen-Anzeige läuft weiter.

**Ursache:** tybo arbeitet mehrere Gespräche parallel, aber nur bis zu einer
Zahl gleichzeitiger Aufträge. Ohne `MAX_AGENT_PROCESSES` richtet sie sich
nach dem Arbeitsspeicher (`src/lib/agent-capacity.ts`, gerechnet in GiB wie
bei `free -g`): unter 3 GiB ein Platz, unter 6 GiB zwei, sonst drei. Ein
Raspberry Pi mit 4 GB meldet etwa 3,8 GiB und bekommt zwei Plätze, ein Mac
oder Server mit 8 GB und mehr drei.

Mitgezählt werden Antworten aus Telegram und Browser, Rückfragen an andere
Agenten und die Prüfungen eines `/goal`. Wer zuerst kommt, ist zuerst dran;
Vorrang für einzelne Gespräche gibt es nicht. Im selben Gespräch läuft je
Agent ohnehin nur eine Antwort nach der anderen. Wartet eine Antwort länger
als 3 Sekunden, sagt tybo das einmal: in Telegram als Nachricht, im Browser
als Hinweis über der Antwort. In Klammern stehen die Gespräche, die gerade
laufen. Der Hinweis landet nicht im Gedächtnis.

**Nachsehen:** Welche Grenze gilt, steht einmal beim Start im Log, etwa
`[agents] Gleichzeitige Aufträge: 2, 3,8 GiB Arbeitsspeicher` oder
`… 5, MAX_AGENT_PROCESSES`.

**Abhilfe:**

- Warten. Ist eine der genannten Antworten fertig, geht es los.
- `/stop` (im Browser der Stopp-Knopf) im wartenden Gespräch nimmt die
  Antwort sofort aus der Schlange. Sie endet mit „⏹️ Abgebrochen.“ und läuft
  nie mehr. Ausnahme: das erste `/stop` in einer `/board`-Sitzung beendet sie
  erst nach dem laufenden Beitrag.
- Mehr Plätze: `MAX_AGENT_PROCESSES=4` in der `.env`, dann tybo neu starten;
  der Wert wird nur beim Start gelesen. Ein gesetzter Wert gilt immer, auch
  über der Vorgabe nach Arbeitsspeicher. Gültig ist eine ganze Zahl ab 1; ist
  der Wert leer oder ungültig (Text, 0, negativ, Kommazahl), gilt die
  Vorgabe, und das Log sagt „MAX_AGENT_PROCESSES ungültig“. Jeder Platz mehr
  ist ein Claude-Prozess mehr: einige hundert MB Speicher, mit Werkzeugen und
  MCP-Servern mehr, und schnellerer Verbrauch des Abos bzw. höhere
  API-Kosten. Gezählt werden nur Aufträge von tybo, nicht andere Programme.

**Danach:** Der Hinweis verschwindet, und die Antwort kommt mit dem
gewohnten Fortschritt.

<a id="reply-replaced-by-abgebrochen-after-a-code-change-self-restart"></a>

### Antwort nach einer Code-Änderung durch „Abgebrochen.“ ersetzt

**Symptom:** Du bittest tybo, seinen eigenen Code zu ändern. Ein paar Minuten
später steht im Chat nur „⏹️ Abgebrochen.“ oder „⚠️ Der Bot wurde waehrend
der Verarbeitung beendet (Neustart oder Stop), …“; die Erklärung kommt nie.
Im Log steht ein `SIGTERM` und danach ein neuer Start.

**Ursache:** Der Claude-Prozess, der deine Nachricht bearbeitet hat, hat den
Bot selbst neu gestartet (`launchctl kickstart`, `kill`), um die Änderung zu
laden. Beim Beenden fallen alle laufenden Claude-Prozesse, auch der, der dir
gerade antworten wollte. Der Dienst startet den Bot danach mit dem neuen Code
wieder; die Änderung ist also aktiv, nur die Antwort ist weg.

**Abhilfe:** Einen Neustart anfordern statt ihn zu erzwingen. So steht es
auch in den Regeln für den laufenden Bot (`CLAUDE.md`):

```bash
bun run restart:request "Tabellen-Fix aktivieren"   # legt data/restart-requested an
```

Der Bot sieht nach jeder zugestellten Antwort und alle 30 Sekunden im
Leerlauf nach der Markierung. Er beendet sich erst, wenn keine Antwort und
kein Claude-Prozess mehr läuft, meldet vorher „🔄 Neustart mit neuem Code“ und
überlässt den Start launchd, systemd oder PM2. Unter systemd gilt der Bot nur
als überwacht, wenn er als Benutzerdienst `tybo-telegram-relay` mit
`Restart=always` läuft und systemd seine Prozessnummer als Hauptprozess
führt. Läuft er ohne Dienst (etwa mit `nohup`), bleibt er an, löscht die
Markierung und bittet um einen Neustart von Hand.

Neustart von Hand, nur aus einem eigenen Terminal, nie aus einer Antwort des
Bots heraus:

```bash
launchctl kickstart -k gui/$(id -u)/ai.tybo.telegram-relay  # macOS
systemctl --user restart tybo-telegram-relay                 # Linux mit systemd
pm2 restart tybo-telegram-relay                              # PM2
```

**Danach:** Nach der Antwort kommt „🔄 Neustart mit neuem Code“, kurz darauf
ist tybo wieder da.

<a id="bot-answers-about-something-else-hook-continuation"></a>

### Antwort handelt von etwas anderem

**Symptom:** Du fragst etwas, und die Antwort dreht sich um eine frühere
Aufgabe aus demselben Gespräch: Design-Korrekturen, ein Deploy, „was der Hook
eigentlich meinte“. Manchmal ändert tybo dabei Dateien, um die du nicht
gebeten hast. Das Fehler-Log sieht unauffällig aus.

**Ursache:** Ein `Stop`-Hook von Claude Code (etwa ein Design-Prüfer in
`.claude/settings.local.json`) liefert `additionalContext`, sobald Claude
fertig ist. Claude arbeitet dann weiter und schreibt eine zweite
Schlussantwort. Mit `SESSION_MODE=resume` lebt eine Session stundenlang und
berührt viele Dateien; solche Hooks melden dann bei jeder Frage alte
Befunde.

**Nachsehen:** Die Session-ID des Gesprächs steht in `data/sessions.json`. In
`~/.claude/projects/<projektordner>/<session-id>.jsonl` zwischen zwei
Textantworten nach Einträgen `hook_additional_context` suchen. Gibt der Bot
mehrere Schlussantworten auf einmal weiter, steht im Fehler-Log
`[Claude streaming] … fertige Turns in einem Aufruf (Hook?), alle weitergegeben`.

**Abhilfe:** Jeder Subprozess von tybo trägt `TYBO_SUBPROCESS=1`
(`src/lib/subprocess-env.ts`), und Hooks erben die Umgebung. Jeden Hook, der
Text ins Gespräch zurückgeben kann, damit abschalten:

```json
"command": "[ -n \"$TYBO_SUBPROCESS\" ] || node pfad/zu/deinem-stop-hook.mjs"
```

`PostToolUse`-Hooks, die nur über die gerade bearbeitete Datei berichten,
dürfen bleiben; sie laufen innerhalb der Antwort. Der gestreamte Weg reicht
ohnehin alle Schlussantworten eines Aufrufs weiter statt nur der letzten, der
Weg ohne Streaming tut das nicht. Der Schalter am Hook ist deshalb die
eigentliche Abhilfe.

**Danach:** Die Antwort bezieht sich auf die Frage, und die Session-Datei
enthält keine neuen `hook_additional_context`-Einträge.

### Eigenes Skript kann die JSON-Ausgabe von Claude nicht lesen

**Symptom:** Ein eigenes Skript ruft `claude -p … --output-format json` auf
und scheitert beim Einlesen, oder das Feld `result` enthält JSON in einem
Codeblock mit drei Backticks statt reinem JSON.

**Ursache:** `--output-format json` liefert ein gültiges JSON-Objekt (mit
`--verbose` eine Liste von Ereignissen); die Antwort des Modells steht als
Text in `result`. Bittet das Skript das Modell selbst um JSON, darf das Modell
den Text in einen Codeblock packen.

**Abhilfe:** Erst die äußere Ausgabe einlesen, dann aus `result` einen
umschließenden Codeblock entfernen und den Rest einlesen. Schlägt das fehl,
den Text als Text behandeln. tybo selbst macht es so: Ist die Ausgabe kein
JSON, nimmt `src/lib/claude.ts` sie als Text und prüft sie nur auf bekannte
Fehlermuster.

---

## Datenbank

### Verbindung zu Supabase scheitert

**Symptom:** Gespräche fehlen im Verlauf, Fakten und Ziele bleiben nicht
gespeichert, oder `tybo pruefen` meldet Fehler bei Supabase.

**Nachsehen:**

```bash
tybo setup datenbank        # zeigt die Werte als „gesetzt“ und testet Lesen und Schreiben
tybo pruefen
```

**Häufige Ursachen und Abhilfe:**

- `SUPABASE_URL` ohne `https://`. `http://` nimmt tybo nur für Supabase auf
  diesem Rechner an (`127.0.0.1` oder `localhost`).
- In der `.env` steht noch ein Platzhalter aus `.env.example`.
- Falscher Schlüssel: `SUPABASE_SERVICE_ROLE_KEY` braucht den Secret key
  (`sb_secret_…`) oder `service_role`, nicht den Publishable key oder
  `anon`. Nur der schreibende Schlüssel kommt an den Zeilenschutz (RLS)
  vorbei.
- Tabellen fehlen (`messages`, `memory`, `logs`, `call_transcripts` und
  weitere). Der Cloud-Weg von `tybo setup datenbank` legt das Schema an. Von
  Hand: im Dashboard **SQL Editor** den Inhalt von `db/schema.sql` ausführen,
  aber nur bei einer neuen, leeren Datenbank; bei fehlenden Rechten siehe den
  nächsten Abschnitt.
- Netz: Erreicht der Rechner Supabase überhaupt?

  ```bash
  set -a; . ./.env; set +a
  curl -s -o /dev/null -w "%{http_code}\n" "$SUPABASE_URL/rest/v1/" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY"
  ```

  Jede dreistellige Zahl außer `000` heißt: Supabase ist erreichbar, der
  Fehler liegt bei Schlüssel oder Schema. `000` heißt keine Verbindung: Netz,
  Proxy oder die Statusseite von Supabase prüfen.

**Danach:** Der Verbindungstest in `tybo setup datenbank` meldet Lesen und
Schreiben, und eine neue Nachricht steht im Verlauf.

### Supabase meldet „permission denied“

**Symptom:** Der Verbindungstest von `tybo setup datenbank` meldet
„Supabase verweigert dem Schlüssel das Recht, … (permission denied for
sequence memory_id_seq)“ oder ähnlich, oder im Log steht
`permission denied for table …` (Fehlercode `42501`), obwohl der Secret- bzw.
`service_role`-Schlüssel eingetragen ist.

**Ursache:** Supabase gibt Tabellen und Zähler im Schema `public` nicht mehr
von selbst für die REST-Schnittstelle frei (neue Projekte seit dem
30.05.2026, bestehende ab dem 30.10.2026). Ohne ausdrückliches `GRANT` darf
auch `service_role` nichts. Ältere Fassungen von `db/schema.sql` vergaben
diese Rechte nicht; vor allem die Zähler `messages_id_seq`, `memory_id_seq`,
`logs_id_seq` und `call_transcripts_id_seq` blieben gesperrt, und neue Zeilen
scheiterten.

**Abhilfe:**

- Supabase in der Cloud: `tybo setup datenbank` noch einmal ausführen. Fehlt
  die Migration `20261021_base_grants.sql`, spielt der Ablauf sie ein.
- Sonst: im Dashboard **SQL Editor** den Inhalt von
  `db/migrations/20261021_base_grants.sql` ausführen. Die Datei vergibt nur
  Rechte, ändert keine Daten und darf mehrfach laufen. `db/schema.sql` dafür
  nicht neu einspielen; das setzt Policies und Suchfunktionen zurück.

Bleibt die Meldung, stimmt der Schlüssel nicht (siehe oben). Mehr:
[einrichtung.md](einrichtung.md#rechte-der-tabellen).

**Danach:** Die Schreibprobe in `tybo setup datenbank` gelingt, und das Log
zeigt keine `42501` mehr.

### Lokales Supabase startet nicht

Gilt für „Supabase auf diesem Rechner“ (`tybo setup datenbank`, in Docker).
Die Supabase-CLI kommt über Bun in genau der Version, die tybo nutzt
(`bunx --bun supabase@2.118.0`; ohne `--bun` verlangt ihr Starter Node).

**Nachsehen:**

```bash
docker info --format '{{.ServerVersion}}'            # läuft Docker?
bunx --bun supabase@2.118.0 status --workdir .        # läuft Supabase?
docker ps --filter label=com.supabase.cli.project=tybo --format '{{.Names}}  {{.Ports}}'   # nur 127.0.0.1:544xx?
docker network inspect supabase_network_tybo --format '{{json .Options}}'                # host_binding_ipv4 127.0.0.1?
```

| Meldung oder Zeichen | Ursache und Abhilfe |
|---|---|
| „Docker fehlt. …“ | Es gibt keinen Befehl `docker`. Auf dem Mac OrbStack, Docker Desktop oder Colima installieren (`brew install colima docker`, dann `colima start`), unter Linux die Docker Engine. tybo installiert Docker nie selbst. |
| „Docker läuft nicht: …“ | Docker Desktop bzw. OrbStack öffnen oder `colima start`. Zeigt `docker context ls` auf einen anderen Docker: `docker context use <name>`. |
| „… keine Berechtigung …“ | Linux: `sudo usermod -aG docker $USER`, dann ab- und wieder anmelden. |
| „Die Supabase-CLI ließ sich nicht laden. …“ | Beim ersten Mal lädt Bun die CLI aus npm (rund 130 MB). Internet prüfen; `bunx --bun supabase@2.118.0 --version` zeigt den eigentlichen Fehler. Node.js ist nicht nötig. |
| „… ein Port im Bereich 54420 bis 54429 belegt …“ | Ein anderes Programm oder ein altes Supabase hält einen Port von tybo. `docker ps` zeigt den Container; ein fremdes Supabase-Projekt in dessen Ordner mit `supabase stop` anhalten. Die Ports stehen in `supabase/config.toml`. |
| „… Speicherplatz für die Docker-Images fehlt …“ | `docker system prune` löscht ungenutzte Images und Container, die Volumes von tybo bleiben. Bei Docker Desktop unter Settings, Resources die virtuelle Festplatte vergrößern. |
| „Supabase ist nach 20 Minuten noch nicht gestartet. …“ | Der erste Start lädt mehrere GB. Noch einmal versuchen; geladene Images bleiben. |
| „Supabase war nicht nur auf diesem Rechner erreichbar …“ | Ein Port hing nicht an `127.0.0.1` oder war aus dem Heimnetz erreichbar. Die Docker-Einstellung `"ip"` in `daemon.json` hilft hier nicht, sie gilt nur für das Netz `bridge`. Supabase läuft im Netz `supabase_network_tybo`, das der Assistent mit `com.docker.network.bridge.host_binding_ipv4=127.0.0.1` anlegt. Fehlt die Option (zweiter Befehl oben): `bunx --bun supabase@2.118.0 stop --workdir .`, `docker network rm supabase_network_tybo`, neu einrichten. |
| „Das Docker-Netz supabase_network_tybo gibt es schon, aber ohne Bindung an 127.0.0.1 …“ | Wie eine Zeile darüber: anhalten, Netz entfernen, neu einrichten; der Assistent legt es richtig an. |
| „Achtung: Supabase-Dienste laufen womöglich noch …“ | Der Schutz-Stopp ist gescheitert. Sofort `bunx --bun supabase@2.118.0 stop --workdir .`; zeigt `docker ps --filter label=com.supabase.cli.project=tybo` danach noch Container, diese mit `docker stop <name>` anhalten. |
| Nach einem Neustart des Rechners antwortet die Datenbank nicht | Siehe „Nach Neustart kein Gedächtnis“ unten. Kurz: Docker starten, dann `tybo datenbank start`. |
| Der Rechner wird sehr langsam | Unter 8 GB Arbeitsspeicher, oder die Docker-VM bekommt zu wenig. Bei Docker Desktop unter Settings, Resources mehr zuteilen, bei Colima `colima start --memory 6`. |

**Daten:** Sie liegen in den Docker-Volumes `supabase_<dienst>_tybo`.
`supabase stop` hält an und behält sie. `supabase stop --no-backup` und
`docker volume rm` **löschen** Gespräche, Gedächtnis und Bilder; beides nur,
wenn du wirklich von vorn anfangen willst. `project_id` in
`supabase/config.toml` nicht ändern: Eine andere ID bedeutet neue, leere
Volumes.

**Danach:** `tybo datenbank status` meldet, dass Supabase läuft.

### Nach Neustart kein Gedächtnis

Gilt für Supabase auf diesem Rechner.

**Symptom:** Nach einem Neustart oder nach dem Aufwachen des Rechners weiß
tybo nichts mehr von früheren Gesprächen, oder `tybo setup` meldet bei der
Datenbank „antwortet aber nicht“. Meist sind die Daten nicht weg, Docker oder
Supabase laufen nur noch nicht.

**Nachsehen:**

```bash
tybo datenbank status        # läuft es? fehlt die Edge Runtime?
tail -20 logs/supabase.log   # was der Autostart beim Anmelden gemacht hat
```

| Zeichen | Ursache und Abhilfe |
|---|---|
| „läuft nicht (Docker läuft nicht)“ | Docker startet nicht beim Anmelden. Docker Desktop: Settings, General, „Start Docker Desktop when you sign in to your computer“. OrbStack: „Start at login“. Colima: `brew services start colima`. Linux: `sudo systemctl enable docker`. Dann `tybo datenbank start`. |
| „läuft nicht“, Docker läuft | Der Autostart von Supabase fehlt oder ist gescheitert. `tybo setup autostart` richtet `ai.tybo.supabase` bzw. `tybo-supabase` ein; `tybo pruefen` zeigt ihn unter „supabase (Autostart)“. Sofort: `tybo datenbank start`. |
| „Edge Runtime fehlt“ | Nach einem Neustart üblich, die Edge Runtime hat keine Neustart-Regel. `tybo datenbank start` startet Supabase einmal vollständig neu. |
| In `logs/supabase.log`: „Docker läuft nach 5 Minuten noch nicht“ | Docker kam beim Anmelden zu spät. Den Start beim Anmelden einschalten (erste Zeile) und `tybo datenbank start` aufrufen. |
| `tybo pruefen` meldet „Letzter Aufruf fehlgeschlagen“ (Mac) bzw. „Letzter Start fehlgeschlagen“ (PM2, auch wenn `tybo-supabase` `online` ist) | Der Grund steht in `logs/supabase.log`; die Meldungen dort sind dieselben wie unter „Lokales Supabase startet nicht“. |
| „läuft“, tybo erinnert sich trotzdem nicht | Zeigt `SUPABASE_URL` in der `.env` auf `http://127.0.0.1:54421`? Mit `tybo setup datenbank` prüfen. Wurden die Volumes gelöscht (etwa mit `supabase stop --no-backup`), hilft nur die letzte Sicherung: [einrichtung.md](einrichtung.md), „Supabase lokal im Alltag“, Wiederherstellen. |

Nachrichten, die ankamen, während Supabase stand, hat tybo ohne Gedächtnis
beantwortet und nicht im Verlauf gespeichert.

**Danach:** `tybo datenbank status` meldet „läuft“, und tybo kennt frühere
Gespräche wieder.

### Semantische Suche fällt still auf Textsuche zurück

**Symptom:** tybo speichert Nachrichten und findet frühere Gespräche, aber
nur bei wörtlichen Treffern. Wissenseinträge bekommen kein Embedding. Im Log
steht kein Fehler.

**Warum still:** Speichern und Suchen (`src/lib/supabase.ts`) gehen zuerst
über die Edge Functions `store-telegram-message` und `search-memory`.
Antworten diese nicht mit Erfolg, speichert tybo direkt ohne Embedding bzw.
sucht nur nach Text. So läuft tybo weiter, der Fehler bleibt aber unsichtbar.

**Häufige Ursachen:**

- Die Edge Functions sind nicht deployt, oder in Supabase fehlt das Secret
  `OPENAI_API_KEY` bzw. bei `EMBEDDING_PROVIDER=gemini` das Secret
  `GEMINI_API_KEY`. Dann wird gespeichert, aber ohne Embedding.
- Der eingestellte Anbieter passt nicht zu dem, den die Datenbank festhält
  (Tabelle `embedding_settings`): etwa `EMBEDDING_PROVIDER=gemini` in der
  `.env`, die Datenbank kennt aber OpenAI, oder Bot und Functions sind
  verschieden eingestellt. Dann entsteht mit Absicht kein Embedding, damit
  keine unvergleichbaren Werte gemischt werden. Beim Start steht im Log
  `[embedding] ACHTUNG: …`, und `tybo pruefen` meldet es. Nachsehen:
  `select * from embedding_settings;` im SQL Editor. Den Anbieter wirklich
  wechseln: `tybo setup suche`, dann „Alles neu berechnen“.
- Eine Neuberechnung nach einem Anbieterwechsel läuft noch oder wurde
  unterbrochen. So lange sucht tybo mit Absicht nur nach Text. Stand:
  `tybo suche status`. Steht sie still, macht `tybo suche neu-berechnen` beim
  letzten Stapel weiter (Ausgabe im Hintergrund: `logs/embedding-reindex.log`).
  Danach tybo neu starten (WebUI: Neustart anfordern), damit der Bot die neue
  `.env` liest.
- Ein Begriff steht in einer langen Nachricht weit hinten (nach Zeichen
  8.000) und wird nicht gefunden: dafür gibt es die Abschnitte
  (`message_chunks`, Migration `20261015_message_chunks.sql`). Fehlt die
  Migration, sucht tybo nur in den ersten 8.000 Zeichen. Stand mit
  `tybo suche status`, offene Abschnitte rechnet `tybo suche abschnitte` nach.
- Ollama auf diesem Rechner: Die Functions laufen in Docker und erreichen
  `localhost:11434` nicht. In `supabase/functions/.env` muss
  `OLLAMA_URL=http://host.docker.internal:11434` stehen (das schreibt
  `tybo setup suche`). Unter Linux muss Ollama dafür auf mehr als 127.0.0.1
  hören (`OLLAMA_HOST=0.0.0.0`).
- In der `.env` steht ein neuer Schlüssel (`sb_secret_…`), die Functions
  wurden aber ohne `--no-verify-jwt` deployt. Dann prüft Supabase vorab ein
  JWT, der neue Schlüssel ist keins, und die Anfrage endet mit 401.
- Deployt ist eine ältere Fassung der Functions, die nur
  `Authorization: Bearer <service_role>` kennt. Mit `sb_secret_…` schickt
  tybo den Schlüssel nur im Kopf `apikey`.
- In `SUPABASE_SERVICE_ROLE_KEY` steht der Publishable- oder `anon`-Schlüssel.
  Die Functions lassen nur Secret- bzw. `service_role`-Schlüssel durch.

**Nachsehen:** Im Projektordner; der Schlüssel kommt aus der `.env` und wird
nicht angezeigt:

```bash
set -a; . ./.env; set +a
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$SUPABASE_URL/functions/v1/search-memory" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"chat_id":"0","query":"test"}'
```

Mit einem alten `service_role`-Schlüssel zusätzlich
`-H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"` mitgeben.

| Antwort | Bedeutung |
|---|---|
| `200` | Die Function antwortet. |
| `401` | Schlüssel falsch, oder `verify_jwt` ist noch an. |
| `404` | Die Function ist nicht deployt. |
| `503` | Der Function fehlen ihre eigenen Schlüssel (`SUPABASE_SECRET_KEYS` bzw. `SUPABASE_SERVICE_ROLE_KEY` in ihrer Umgebung). |

**Abhilfe:** Die Functions aus `supabase/functions/` neu deployen, jede mit
`--no-verify-jwt`. Den Schlüssel prüft jede Function selbst
(`supabase/functions/_shared/auth.ts`), und `supabase/config.toml` setzt
`verify_jwt = false` für alle drei:

```bash
supabase functions deploy store-telegram-message --no-verify-jwt
supabase functions deploy search-memory --no-verify-jwt
supabase functions deploy embed-knowledge --no-verify-jwt
```

Alte `service_role`-Schlüssel funktionieren danach weiter.

**Danach:** Der Prüfbefehl oben liefert `200`, und eine Suche nach einem
sinngleichen, aber anders formulierten Satz findet das frühere Gespräch.

---

## Dienste, Sprache und Werkzeuge

### Bot-Dienst startet nicht (macOS)

**Symptom:** `launchctl list | grep ai.tybo.telegram-relay` zeigt keine Zeile,
oder vorn steht dauerhaft `-` und in der Mitte ein Exit-Code ungleich 0. Der
Bot antwortet nicht, obwohl `tybo setup autostart` durchlief.

**Nachsehen:**

```bash
launchctl list | grep ai.tybo                                       # alle Dienste von tybo
plutil -lint ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist    # Datei lesbar?
plutil -extract ProgramArguments xml1 -o - ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
tail -n 50 logs/telegram-relay.error.log
```

Die Plist erzeugt tybo aus seinem Dienstkatalog (`src/lib/services/catalog.ts`):
der erste Eintrag in `ProgramArguments` ist der absolute Pfad zu Bun, dazu
`WorkingDirectory` mit dem Projektordner und ein eigener `PATH`. Die beiden
Logdateien stehen unter `StandardOutPath` und `StandardErrorPath`.

| Zeichen | Ursache und Abhilfe |
|---|---|
| `plutil` meldet einen Fehler | Die Datei wurde von Hand geändert. `tybo dienste telegram-relay` schreibt sie neu und lädt sie. |
| Pfad zu Bun oder Projektordner gibt es nicht mehr | Bun wurde verschoben oder der Ordner umbenannt. Im richtigen Ordner `tybo dienste telegram-relay` ausführen. |
| Fehler-Log nennt eine fehlende Variable oder eine ungültige `.env` | Den Wert in der `.env` korrigieren, dann `tybo pruefen`. launchd startet den Bot von selbst neu (`KeepAlive`). |
| Bot läuft, antwortet aber nur über Ersatzmodelle | Die Claude CLI fehlt im `PATH` der Plist, meist weil sie nach dem Einrichten installiert oder verschoben wurde. `tybo dienste telegram-relay` schreibt den `PATH` mit dem jetzigen Ordner der CLI neu. |
| Zeile fehlt ganz | Der Dienst ist nicht geladen. `tybo dienste telegram-relay` lädt ihn. |

`tybo dienste` lässt unveränderte, schon geladene Dienste in Ruhe und lädt nur
neu, was sich geändert hat oder fehlt. Wer die Ereignisse von launchd selbst
sehen will: `log show --last 10m --predicate 'process == "launchd"' | grep ai.tybo`.

**Danach:** `launchctl list | grep ai.tybo.telegram-relay` zeigt vorn eine
Prozessnummer, und eine Testnachricht bekommt eine Antwort.

---

### systemd-Dienst startet nicht (Linux, Raspberry Pi)

Gilt für den Bot als systemd-Benutzerdienst `tybo-telegram-relay`, den
`tybo setup autostart` unter Linux mit systemd einrichtet. Alle Befehle als
dein Benutzer ausführen, nie mit `sudo`: `systemctl --user` braucht die
eigene Anmeldesitzung (`XDG_RUNTIME_DIR`), unter `sudo` fehlt sie.

**Symptom:** Der Bot antwortet nicht, `tybo pruefen` meldet den Dienst als
gestoppt oder „antwortet nicht (systemctl --user)“.

**Nachsehen:**

```bash
systemctl --user status tybo-telegram-relay
tail -n 50 logs/telegram-relay.error.log
loginctl show-user "$USER" -p Linger        # Linger=yes: startet auch ohne Anmeldung
```

| Zeichen | Ursache und Abhilfe |
|---|---|
| „Failed to connect to bus“ | `tybo setup` lief über `sudo`, `su` oder ohne Anmeldesitzung. Als normaler Benutzer per SSH oder am Gerät anmelden und erneut ausführen. |
| Bot läuft erst, wenn du dich anmeldest | Linger ist aus. Einmal `sudo loginctl enable-linger "$USER"`, dann `tybo setup autostart`; der Schritt prüft es. |
| Antworten nur über Ersatzmodelle oder gar keine | Der Dienst findet Bun oder die Claude CLI nicht. Die Unit-Datei setzt ihren `PATH` beim Anlegen. Wurde die CLI danach installiert oder verschoben, den Dienst neu anlegen (Befehle unten). |
| `status` zeigt ständige Neustarts | `Restart=always` startet den Bot nach jedem Ende neu, auch nach einem Fehler in der `.env`. Der Grund steht im Fehler-Log. Anhalten bis zur Korrektur: `systemctl --user stop tybo-telegram-relay`. |
| `tybo-telegram-relay` steht zusätzlich in `pm2 list` oder in `~/.pm2/dump.pm2` | Zwei Bots holen dieselben Nachrichten. Einen entfernen, siehe [Zwei Bots laufen gleichzeitig](#zwei-bots-laufen-gleichzeitig). `tybo setup autostart` legt nie einen zweiten an. |

Dienst neu anlegen, nachdem sich Pfade geändert haben:

```bash
systemctl --user disable --now tybo-telegram-relay
rm ~/.config/systemd/user/tybo-telegram-relay.service
tybo setup autostart
```

**Danach:** `systemctl --user status tybo-telegram-relay` zeigt
`active (running)`, und eine Testnachricht bekommt eine Antwort.

---

### Dienste unter PM2 fehlen nach einem Neustart

Gilt, wenn der Bot (`tybo-telegram-relay`) oder Supabase (`tybo-supabase`)
unter PM2 laufen, also unter Linux ohne systemd-Benutzerdienst oder auf
einem Server.

**Symptom:** Nach einem Neustart des Rechners zeigt `pm2 list` nichts oder
den Bot als `stopped`.

**Nachsehen:** `pm2 list` und `pm2 startup`. Meldet `pm2 startup` eine Zeile
zum Ausführen, ist PM2 selbst noch nicht als Systemdienst eingetragen.

**Abhilfe:** Die Zeile, die `pm2 startup` ausgibt, einmal ausführen (meist mit
`sudo`). Die Liste der Dienste speichern `tybo setup` und `tybo dienste`
selbst mit `pm2 save`; fehlt der Bot darin, `tybo dienste telegram-relay`.
Nur die Dienste von tybo anfassen, nie alle PM2-Prozesse auf einmal: Auf
einem Server laufen dort oft auch fremde Programme.

**Danach:** Nach dem nächsten Neustart zeigt `pm2 list` den Bot als `online`.
Mehr: [erweiterungen.md](erweiterungen.md#linux-dienste-nach-neustart).

---

### Check-in oder Morgenbriefing kommen nicht

**Symptom:** Zur eingestellten Zeit kommt keine Nachricht, auch keine
Fehlermeldung.

**Nachsehen:** Erst klären, ob der Dienst überhaupt eingerichtet ist und lief.

```bash
launchctl list | grep -E 'ai.tybo.(smart-checkin|morning-briefing)'   # macOS
systemctl --user list-timers 'tybo-*'                                 # Linux mit systemd
crontab -l | grep '# tybo-'                                           # Linux ohne systemd
tail -n 30 logs/smart-checkin.log logs/morning-briefing.log
```

Unter Linux mit systemd laufen beide als Benutzer-Timer `tybo-smart-checkin`
und `tybo-morning-briefing`, ohne systemd als Zeilen in der crontab. Die
Zeilen enthalten den vollen Pfad zu Bun und einen eigenen `PATH`, weil cron
sonst weder Bun noch die Claude CLI findet.

**Abhilfe:**

- Kein Dienst zu sehen: `tybo dienste` richtet beide ein, die Zeiten kommen
  aus den Einstellungen von tybo.
- Dienst da, aber kein Lauf im Log: Der Rechner schlief zur fälligen Zeit, oder
  unter Linux ohne Linger lief keine Sitzung. Siehe die Abschnitte zu
  launchd und systemd oben.
- Lauf im Log, aber keine Nachricht: Der Check-in entscheidet selbst, ob es
  etwas zu sagen gibt; ein Lauf ohne Nachricht ist kein Fehler. Von Hand
  probieren: `bun run checkin` bzw. `bun run briefing`.
- Fehler im Log: siehe [Routine meldet Fehler](#routine-meldet-fehler).

Auch ein Lauf von Hand hält die Regeln ein und kann ohne Nachricht mit Exit 0
enden. Die Ausgabe nennt dann den Grund, beim Briefing etwa
`[briefing] skipped (window)`:

| Grund | Bedeutung |
|---|---|
| `window` | außerhalb des Zeitfensters, beim Briefing Standard 09:00 bis 12:00 |
| `quiet` | in der Ruhezeit, Standard 21:00 bis 08:00 |
| `done-today` | heute schon zugestellt; das Briefing kommt höchstens einmal je Tag |
| `snoozed` | gerade schlummern gelegt |
| `gap` | Check-in: der letzte liegt weniger als 90 Minuten zurück |
| `disabled` | die Art ist ausgeschaltet |

Zeitfenster und Ruhezeit stehen im Block `proactive` von
`config/settings.json`. Nur den Inhalt prüfen, ohne Regeln und ohne Versand:
`bun run briefing --dry-run` zeigt den Text, sendet nichts und merkt sich
nichts.

**Danach:** `bun run briefing --dry-run` zeigt ein Briefing mit allen
eingerichteten Quellen. Im Zeitfenster und noch ohne Briefing an diesem Tag
endet `bun run briefing` mit `[briefing] sent`, und das Briefing steht im
Chat.

---

### Routine meldet Fehler

**Symptom:** Im Direktchat oder in der WebUI steht
`⚠️ Routine <name> fehlgeschlagen (Exit <code>, <dauer>)` oder
`⏰ Routine <name> ist nicht gelaufen (fällig <zeit>)`.

**Nachsehen:**

1. **Die Fehlerzeile lesen.** Die zweite Zeile der Meldung ist die letzte
   Zeile, die die Routine auf stderr geschrieben hat (sonst die letzte Zeile
   der Ausgabe). Oft steht dort schon die Ursache, etwa „Quelldaten fehlen:
   …“ bei einer Routine, die die Regel „keine alten Daten“ einhält.
2. **Das Log öffnen.** Die Meldung nennt den Pfad aus der Plist
   (`StandardErrorPath`, sonst `StandardOutPath`), etwa
   `tail -n 50 logs/health-check.error.log`.
3. **Den Verlauf ansehen.** `/routinen <name>` zeigt die letzten 20 Läufe mit
   Zeit, Dauer, Exit-Code und den letzten Zeilen der Ausgabe. So siehst du,
   seit wann sie scheitert.

**Beispiel: anderer Interpreter nach einem Update.** Eine Routine ruft
`python3` auf. Nach einem Homebrew-Update zeigt `python3` im `PATH` des
Dienstes auf ein anderes Python, dem ein Modul fehlt; die Fehlerzeile lautet
dann etwa `ModuleNotFoundError: No module named '…'`. Im Terminal geht alles,
weil dort ein anderer `PATH` gilt. Welches Python der Dienst sieht:

```bash
plutil -extract EnvironmentVariables.PATH raw ~/Library/LaunchAgents/<label>.plist
PATH="<ausgegebener PATH>" which python3
PATH="<ausgegebener PATH>" python3 --version
```

Abhilfe: in der Plist den absoluten Pfad zum gewünschten Interpreter in
`ProgramArguments` eintragen oder den `PATH` in `EnvironmentVariables`
passend ordnen und den Dienst neu laden.

**„Nicht gelaufen“, obwohl der Rechner an war:** `/routinen` zeigt, ob die
Routine geladen und aktiv ist. Eine Routine mit festem Termin gilt erst
2 Stunden nach dem Termin als ausgeblieben, eine mit Intervall nach dreimal
dem Intervall plus 10 Minuten; nach einem Bot-Start oder Schlaf des Rechners
beginnen die Fristen neu. Die Meldungen ganz abschalten: `ROUTINE_ALERTS=off`
in der `.env`.

**Danach:** Unter der Meldung „▶️ Jetzt testen“ drücken. Gelingt der Lauf,
kommt `✅ Routine <name> läuft wieder`. Bis dahin kommt zu derselben
Fehlerserie keine zweite Meldung. Mehr: [routinen.md](routinen.md).

---

### Routine fehlt in der Übersicht

**Symptom:** `/routinen`, `tybo routinen` oder der Reiter „Routinen“ in der
WebUI zeigt einen Dienst nicht, der auf dem Rechner zeitgesteuert läuft.

**Nachsehen und Abhilfe:**

1. **Label.** Von selbst erscheinen nur Dienste mit Label `ai.tybo.*`:
   `plutil -extract Label raw ~/Library/LaunchAgents/<datei>.plist`.
2. **`config/routines.json`.** Dienste mit anderem Label erscheinen nur, wenn
   ihr genaues Label unter `labels` oder ihr Anfang unter `prefixes` steht
   (Vorlage `config/routines.example.json`). Ist die Datei kein gültiges
   JSON, gilt sie als leer, und die Übersicht zeigt dazu eine Hinweiszeile.
3. **Ort der Plist.** Gezählt werden nur Plists in `~/Library/LaunchAgents`.
   Dienste unter `/Library/LaunchDaemons` oder `/Library/LaunchAgents`,
   systemd-Timer und cron erfasst die Übersicht nicht.

Steht die Routine da, aber mit „kein Verlauf (nicht eingebunden)“, fehlt ihr
nur der Wrapper. `tybo routinen einbinden <label>` schaltet den Verlauf ein.

**Danach:** `/routinen` zeigt die Routine, nach dem nächsten Lauf mit Verlauf.

---

### tybo erinnert an eine längst erledigte Frage

**Symptom:** Eine Erinnerung an einen offenen Faden kommt, obwohl die Frage
längst beantwortet ist.

**Abhilfe:** Unter der Erinnerung „Erledigt“ oder „Nicht mehr wichtig“
drücken, im Browser geht das auch in der Ansicht „Offene Fäden“. Oder im
Gespräch, aus dem der Faden stammt, `/faeden zu <nr>` senden (die Nummer
zeigt `/faeden`). In einem anderen Gespräch geht das nicht; tybo sagt dann,
wo der Faden liegt.

**Nachsehen, woran es lag:** Von selbst geschlossen wird ein Faden nur, wenn
die Antwort im selben Gespräch kam und das Nebenmodell für den Zweck
`threads` sie als Antwort erkannt hat. Kam sie in einem anderen Topic oder
Web-Gespräch oder gar nicht über tybo, bleibt er offen; im Zweifel lässt
tybo ihn absichtlich offen. Das Nebenmodell steht in der WebUI unter
Einstellungen, Modelle, „Nebenmodelle“, Eintrag „Offene Fäden“, sonst in
`AUX_MODEL_THREADS` (Standard Claude Haiku). Ist es nicht erreichbar, steht im
Log:

```bash
grep "\[threads\] kein Auflösen" logs/telegram-relay.log | tail -n 5
```

Ein kleines lokales Modell (`ollama:`) erkennt Antworten schlechter als
Haiku. Das Log nennt nur Kennungen, nie Fragen oder Antworten.

**Danach:** `/faeden` führt den Faden nicht mehr auf, und es kommt keine
Erinnerung mehr dazu.

---

### Fäden werden nie angelegt

**Symptom:** `/faeden` zeigt immer „Keine offenen Fäden.“, obwohl tybo Fragen
stellt, die du nicht beantwortest.

**Nachsehen und Abhilfe:**

1. **Eingeschaltet?** Sagt `/faeden` „Offene Fäden sind ausgeschaltet“, in
   der WebUI unter Einstellungen, Modelle, Abschnitt „Offene Fäden“ auf „An“
   stellen und „Speichern“ klicken. Das gilt sofort, ohne Neustart. Ein
   gespeicherter Wert dort hat Vorrang vor `THREADS` in der `.env`; ohne ihn
   schaltet `THREADS=off` ab.
2. **Zählt die Frage?** Fäden entstehen nur aus Antworten in Telegram oder im
   Browser, die mit einem Fragezeichen oder einer Bitte wie „sag Bescheid“
   enden (Code-Blöcke zählen nicht). Floskeln wie „Soll ich noch etwas
   tun?“ übergeht das Nebenmodell absichtlich. Antworten aus `/goal`, der
   Sprach-Brücke (Telefon, Telefonhörer), automatische Meldungen und Fragen
   mit Knöpfen legen nie Fäden an. Der Sprechmodus im Browser ist ein
   normaler Turn und legt Fäden an wie getippte Nachrichten.
3. **Nebenmodell erreichbar?**

   ```bash
   grep "\[threads\]" logs/telegram-relay.log | tail -n 20
   ```

   `keine Erkennung für Gespräch … (fehler)` oder `(zeitüberschreitung)`: das
   Modell antwortet nicht; prüfen, ob es läuft (bei `ollama:` etwa
   `ollama list`), oder ein anderes wählen. `(ungültige Antwort)`: das Modell
   liefert kein brauchbares JSON, ein größeres hilft.

**Danach:** Im Log steht `Faden … angelegt`, und `/faeden` zeigt ihn.

---

### Sprachnachrichten und Vorlesen

**Symptom:** tybo antwortet auf eine Sprachnachricht mit einer Rückfrage, als
hätte er nichts gehört; im Verlauf steht statt deiner Worte
`[Voice transcription unavailable - …]` oder `[Transcription failed]`. Oder
`/voice` und Sprachantworten bleiben stumm, es kommt nur Text.

**Nachsehen:**

```bash
tybo pruefen                                         # Zeilen zum Hören und zur Stimme
grep "\[Sprache\]" logs/telegram-relay.log | tail -n 20
```

Hören und Sprechen laufen über eine Kette von Anbietern
(`src/lib/speech/`). Was gilt, steht in der WebUI unter Einstellungen,
„Sprechen“; ohne Eintrag dort gelten `SPEECH_STT` und `SPEECH_TTS` aus der
`.env`, beide Standard `auto`. Das Log nennt je Versuch Anbieter, Ergebnis und
Dauer, nie den Inhalt, etwa `[Sprache] Hören parakeet: Fehler (…)` oder
`[Sprache] Sprechen gemini nicht verfügbar: …`.

| Zeichen | Ursache und Abhilfe |
|---|---|
| `no transcription provider configured` | Kein Anbieter fürs Hören eingerichtet. Lokal und ohne Schlüssel: `tybo setup sprache`, Weg Parakeet. Sonst `GEMINI_API_KEY` oder `ELEVENLABS_API_KEY` in der `.env`. |
| `… not available` | Ein Anbieter ist fest gewählt, aber nicht bereit. Im Log steht der Grund; entweder einrichten oder in den Einstellungen auf „auto“ stellen. |
| `[Transcription failed]` | Der Anbieter hat einen Fehler gemeldet. Bei Gemini oder ElevenLabs prüfen, ob der Schlüssel noch gilt (`tybo pruefen` zeigt, ob er gesetzt ist); bei Parakeet `tybo setup sprache` noch einmal ausführen, er prüft nur, wenn alles da ist. |
| `/voice` antwortet mit Text | Kein Server-Anbieter fürs Sprechen bereit. Telegram braucht eine Stimme auf dem Server (Pocket TTS, Piper, Gemini, ElevenLabs, Qwen3-TTS); die Browser-Stimme spricht nur in der WebUI. Steht `SPEECH_TTS` auf `browser` oder `auto`, nimmt Telegram den ersten bereiten Server-Anbieter; ist keiner eingerichtet, bleibt es bei Text. Ist ein Anbieter fest gewählt, nennt das Log den Grund (`[Sprache] Sprechen … nicht verfügbar: …`). |
| Stimme eingerichtet, trotzdem keine Sprachnachricht | Lokale Stimmen liefern WAV, Telegram spielt nur Ogg/Opus ab. Dafür braucht tybo `ffmpeg` (`brew install ffmpeg` bzw. `sudo apt install ffmpeg`). Ohne `ffmpeg` bleibt es bei Text. |
| Qwen3-TTS liest in falscher Sprache | `LOCAL_TTS_LANG` nimmt Kürzel (`de`) und Namen (`german`); tybo gibt dem Modell immer den Namen weiter. Unbekannte Werte zählen als `auto`. |

Sprachnachrichten größer als 20 MB kann ein Telegram-Bot nicht laden; tybo
sagt das dann in der Antwort.

**Danach:** Eine kurze Sprachnachricht erscheint im Verlauf als Text, und
`/voice` schickt eine Sprachnachricht.

---

### Sprechmodus: lokale Stimme (Pocket TTS, Piper)

**Symptom:** Der Reiter „Sprechen“ zeigt Pocket TTS oder Piper als „nicht
verfügbar“, im Sprechmodus steht „Vorlesen fehlgeschlagen. Die Antwort steht
im Verlauf.“, oder der erste Satz kommt erst nach mehreren Sekunden.

**Nachsehen:** `tybo pruefen` nennt „Pocket TTS (lokale Stimme)“ bzw. „Piper
(lokale Stimme)“, wenn das Vorlesen darauf steht; der Bericht startet dabei
keinen Prozess. Im Log steht nur `[Sprache] Sprechen pocket: Fehler (…)` mit
Art und Dauer, nie der Text.

**Nicht verfügbar:** Eine lokale Stimme gilt erst als eingerichtet, wenn
`tybo setup sprache` die Probe bestanden und `models/speech/pocket.ok.json`
(bzw. `piper.ok.json`) geschrieben hat. Den Schritt noch einmal ausführen; ist
alles da, lädt er nichts, sondern prüft nur. Steht `POCKET_TTS_VOICE` in der
`.env`, muss es eine freigegebene Stimme sein (heute `juergen`). Stimmen aus
dem Ordner „expresso“ sind nicht für kommerzielle Nutzung freigegeben; tybo
lehnt sie immer ab, auch je Anfrage (HTTP 400).

**Installation scheitert:**

- `python3 fehlt` oder falsche Version: Pocket TTS braucht Python 3.10 bis
  3.14, Piper ab 3.9.
- „Python-Umgebung ließ sich nicht anlegen“ unter Debian, Ubuntu oder
  Raspberry Pi OS: `sudo apt install python3-venv`, dann noch einmal.
- pip bricht ab (Netz, Zeitlimit): Die halbe Umgebung wird gelöscht, der
  nächste Lauf nimmt schon geladene Pakete aus dem pip-Cache.
- Modell-Download abgebrochen: Vollständig ist das Modell erst mit
  `models/speech/pocket/model.ok`. Fehlt die Datei, setzt der nächste Lauf
  den Download fort, auch wenn `models/speech/pocket/hf/` schon da ist.
- Unter Linux holt pip PyTorch aus dem CPU-Index
  (`https://download.pytorch.org/whl/cpu`). Ist diese Adresse gesperrt,
  scheitert die Installation; ohne den Index kämen rund 3 GB CUDA-Pakete.

**Vorlesen fehlgeschlagen:** Der Bot startet Pocket TTS beim ersten Vorlesen
ohne Netz (`HF_HUB_OFFLINE=1`) über `src/lib/speech/pocket_guard.py`. Dieser
Wächter nimmt auf 127.0.0.1 nur Anfragen mit dem Token des laufenden Starts
an, mit Host `127.0.0.1:<port>`, ohne Origin und nur mit dem Feld `text`; die
Stimme steht beim Start fest. Ein eigener `curl` auf den Port bekommt deshalb
401 oder 421, das ist kein Fehler. Die Regeln prüft
`bun run scripts/pocket-guard-check.ts` (braucht nur `python3`, kein Modell,
kein Netz). Fehlt eine Modelldatei, etwa weil `models/speech/pocket/hf/`
gelöscht wurde, scheitert der Start; dann `tybo setup sprache`. Startet der
Prozess zweimal hintereinander nicht, versucht es der nächste Satz erneut.

**Erster Satz langsam:** Normal. Die Stimme läuft als eigener Prozess, den
tybo beim ersten Vorlesen startet und nach 10 Minuten Ruhe beendet. Der erste
Satz danach wartet, bis das Modell geladen ist (auf einem aktuellen Mac rund
2 Sekunden, unter Last länger). Messwerte: [sprechen.md](sprechen.md),
Abschnitt „Wie lange es dauert“.

**Zu langsam auf dem Raspberry Pi:** `tybo setup sprache` misst den
Echtzeitfaktor. Liegt er über 1, schlägt der Schritt Piper vor und richtet es
nach einem Ja gleich ein.

**Danach:** Der Reiter „Sprechen“ zeigt die Stimme als verfügbar, und im
Sprechmodus wird die Antwort vorgelesen.

---

### Telefonhörer

**Symptom:** Neben „Sprechen“ fehlt der Knopf „Telefonhörer“, das Mikrofon
bleibt aus, das Gespräch bricht nach kurzer Zeit ab, oder Antworten kommen
deutlich später als nach zwei bis drei Sekunden.

**Nachsehen:** Unter Einstellungen, Sprechen, Telefonhörer steht, was fehlt,
mit dem nächsten Schritt. `tybo pruefen` meldet „Telefonhörer“, sobald ein Weg
bereit ist.

| Zeichen | Ursache und Abhilfe |
|---|---|
| Kein Knopf, „kein lokaler Erkenner“ | `tybo setup sprache`, Weg „Sprechmodus lokal“. |
| Kein Knopf, „kein Modellweg“ | `tybo setup sprache`, Weg „Telefonhörer“. Braucht `VOICE_ANTHROPIC_API_KEY`, ein angemeldetes Claude Code, `OPENROUTER_API_KEY` oder ein laufendes Ollama. |
| Kein Knopf, „kein sicherer Zugang“ | `tybo setup zugang`. Über `http://<IP>:3100` aus dem Heimnetz gibt der Browser das Mikrofon nie frei, nur über HTTPS oder `localhost`. |
| Mikrofon verweigert | In den Website-Einstellungen des Browsers für die tybo-Adresse das Mikrofon erlauben. |
| Verbindung bricht ab, im Log `Telefonhörer: aufgelegt (verbindung)` | Der Telefonhörer spricht über einen WebSocket unter `/api/call`. Ein eigener Reverse-Proxy (nginx, Caddy, Traefik) muss `Upgrade: websocket` weiterreichen und mehr als 30 Sekunden Leerlauf erlauben; tybo pingt alle 25 Sekunden. Tailscale Serve und Cloudflare Tunnel brauchen nichts weiter. |
| Antworten spät | Die Probe im Reiter „Sprechen“ misst den eingestellten Weg. Über 4 Sekunden („zäh“) lohnt ein anderer; der API-Schlüssel ist am gleichmäßigsten. |
| Gespräch fehlt im Verlauf | Äußerungen und Antworten erscheinen sofort; läuft dort gerade ein Denkauftrag, erst nach dessen Ende. |

Der Telefonhörer zählt zum Tagesbudget für API-Aufrufe, siehe
[Tagesbudget erreicht](#tagesbudget-erreicht). Wartezeiten und Grenzen:
[sprechen.md](sprechen.md), Abschnitt „Telefonhörer“.

**Danach:** Der Knopf ist da, und auf eine gesprochene Frage kommt nach zwei
bis drei Sekunden die Antwort.

---

### MCP-Werkzeuge fehlen in einer Antwort

**Symptom:** Im eigenen Claude Code gibt es ein Werkzeug (Kalender, Notion,
…), in einer Antwort von tybo nicht. Oder es fehlt nur, wenn ein Ersatzmodell
antwortet.

**Nachsehen:** Wer antwortet gerade? Claude Code, Codex und OpenCode lesen je
ihre eigene MCP-Konfiguration; die Ersatzmodelle bekommen die Server von tybo.

| Wer antwortet | Woher die Server kommen |
|---|---|
| Claude Code | `~/.claude.json` (global oder der Eintrag für den Projektordner von tybo) und `.mcp.json` im Projektordner. Claude Code startet immer im Projektordner. |
| Codex, OpenCode | eigene Dateien, siehe die Abschnitte zu den Motoren unten |
| Ersatzmodelle | `config/mcp-servers.json`, dann `MCP_CONFIG_PATH`, dann `~/.claude.json` (lokale Server dort nur, wenn sie mit Bun laufen) |

**Abhilfe:**

- Nur im Projekt eines anderen Ordners eingetragen: den Server global oder
  für den Projektordner von tybo eintragen.
- Server braucht einen Schlüssel: Er erreicht den Subprozess nur, wenn die
  MCP-Konfiguration ihn als `${NAME}` nennt, siehe nächster Abschnitt.
- Für die Ersatzmodelle: `bun run test:tools` zeigt, welche Werkzeuge sie
  bekommen. Der Bot liest die Liste nur beim Start; nach einer Änderung neu
  starten (WebUI: Neustart anfordern).

**Danach:** Eine Frage, die das Werkzeug braucht, wird mit ihm beantwortet.
Mehr: [erweiterungen.md](erweiterungen.md#mcp-server).

---

### Subprozess vermisst eine Variable

**Symptom:** Was im eigenen Terminal geht, scheitert in einer Antwort von
tybo: ein `curl` oder Deploy meldet ein fehlendes Token, `gh` will eine
Anmeldung, ein Skript sagt `X_API_KEY is not set`.

**Ursache:** Subprozesse der Motoren erben nicht alle Geheimnisse des Bots.
`src/lib/subprocess-env.ts` entfernt Variablen, deren Name nach Geheimnis
aussieht (`*_TOKEN`, `*_KEY`, `*_SECRET`, `*PASSWORD*`, `*_PASS`,
`SUPABASE_*`, `TELEGRAM_*`), bevor Claude Code, Codex oder OpenCode starten.
Das bremst den typischen Angriff „Umgebung auslesen und verschicken“.
Netzzugang, Bash und Werkzeuge bleiben gleich, die `.env` bleibt lesbar.

Ohne Zutun durch kommen:

- bei Claude `ANTHROPIC_API_KEY`, allein nach `CLAUDE_AUTH`: bei `apiKey` ja,
  bei `subscription` nie, auch nicht über Freigabeliste oder MCP-Verweis;
- Variablen, die die MCP-Konfiguration des Motors als `${NAME}` oder `$NAME`
  nennt, für Claude in `mcpServers` von `~/.claude.json`, `.mcp.json`,
  `.claude/settings.json`, `.claude/settings.local.json` oder
  `~/.claude/settings.json` (Hooks und Rechte-Regeln zählen nicht).

Immer entfernt werden `WEB_PASSWORD`, `CLAUDECODE` und geerbte Werte von
`TYBO_CHAT_ID`, `TYBO_TOPIC_ID` und `TYBO_CONVERSATION_ID`; gesetzt wird
immer `TYBO_SUBPROCESS=1`.

**Nachsehen:** Beim Start nennt der Bot einmal die Namen (nie die Werte):

```bash
grep "\[subprocess-env\]" logs/telegram-relay.log | tail -n 3
```

**Abhilfe:** Die Variable in der `.env` mit Namen freigeben, mehrere mit
Komma, dann tybo neu starten (WebUI: Neustart anfordern):

```bash
TYBO_SUBPROCESS_ENV_ALLOW=GH_TOKEN,CLOUDFLARE_API_TOKEN
```

Nur freigeben, was der Subprozess wirklich braucht: Ein freigegebener Wert
ist für den ganzen Prozess sichtbar, nicht nur für ein Werkzeug.

**Danach:** Die Startzeile führt den Namen nicht mehr unter den entfernten
Variablen, und der Befehl in der Antwort läuft durch.

---

### Codex als Motor

Codex liest nichts aus der Claude-Konfiguration: keine Hooks, keine
Claude-Skills, keine MCP-Server aus `~/.claude.json` oder `.mcp.json`. tybo
schreibt nichts in die Codex-Konfiguration; alles hier richtest du selbst ein.

**Symptom:** „Codex ist nicht angemeldet“, „Codex ist nicht installiert“,
oder Codex antwortet ohne Werkzeuge, Skills oder Projektwissen.

**Nachsehen:** `codex --version` und `codex login status` (Exit 0 heißt
angemeldet). Dasselbe prüft tybo mit `checkEngine("codex")`
(`src/lib/engines/check.ts`, je 5 Sekunden Zeitlimit, Ergebnis eine Minute
gemerkt). Die Rechte-Stufe steht beim ersten Aufruf im Log:
`[Codex] Rechte-Stufe: …`.

**Abhilfe:**

- **Anmeldung:** einmal `codex login` (ChatGPT-Konto im Browser, ohne Browser
  `codex login --device-auth`). Nicht installiert: Codex installieren oder
  den Pfad mit `CODEX_PATH` in der `.env` setzen. Eine Anmeldung per
  Schlüssel (`OPENAI_API_KEY`, `CODEX_API_KEY`) rechnet zu API-Preisen ab und
  erreicht Codex nur über `TYBO_SUBPROCESS_ENV_ALLOW`.
- **Projektwissen:** tybo startet Codex mit
  `-c project_doc_fallback_filenames=["CLAUDE.md"]` und
  `-c project_doc_max_bytes=65536`; Codex liest also dieselbe `CLAUDE.md` wie
  Claude Code. Eine `AGENTS.md` oder `AGENTS.override.md` im Projekt hat
  Vorrang, eine globale `~/.codex/AGENTS.md` kommt dazu.
- **Rechte:** `engine.codex.sandbox` in `config/settings.json`, bei jedem
  Aufruf neu gelesen. Nachfragen gibt es nie (`approval_policy="never"`),
  es sitzt niemand am Terminal.

  | Wert | Bedeutung |
  |---|---|
  | `full` (Standard) | alles erlaubt, ohne Sandbox |
  | `workspace-write` | schreiben im Projektordner, mit Netz |
  | `read-only` | nur lesen |

- **MCP-Server:** in `~/.codex/config.toml` (oder `$CODEX_HOME/config.toml`):

  ```toml
  [mcp_servers.notion]
  command = "bunx"
  args = ["notion-mcp"]
  env_vars = ["NOTION_TOKEN"]
  startup_timeout_sec = 60
  ```

  Geheime Variablen erreichen Codex, wenn ein Eintrag unter `[mcp_servers.*]`
  sie nennt: in `env_vars`, als `${NAME}` in `env`, in
  `bearer_token_env_var` oder als Wert von `env_http_headers`. Eine
  `.codex/config.toml` im Projekt zählt dafür nicht. `OPENAI_API_KEY`,
  `CODEX_API_KEY` und die Telegram-Tokens kommen nur über die Freigabeliste
  durch, `WEB_PASSWORD` nie. Codex wartet 10 Sekunden auf den Start eines
  Servers; braucht er länger (etwa `bunx` beim ersten Mal),
  `startup_timeout_sec` erhöhen.
- **Skills:** Codex liest `~/.agents/skills` und `.agents/skills`, nicht
  `~/.claude/skills`. Einen Skill für beide Motoren in beide Ordner legen.

**Danach:** `/motor codex` in einem Gespräch, und die nächste Antwort kommt
von Codex mit den erwarteten Werkzeugen.

---

### OpenCode als Motor

tybo unterstützt OpenCode 1 (npm-Paket `opencode-ai`, Aufruf
`opencode run --format json`). OpenCode 2 (`@opencode/cli`) erkennt tybo und
lehnt es ab, bis es eigens eingeplant ist. tybo schreibt nichts in die
OpenCode-Konfiguration und meldet nicht selbst an.

**Symptom:** Eine der Meldungen aus der Tabelle unten, oder OpenCode antwortet
ohne Werkzeuge.

**Nachsehen:**

```bash
opencode --version        # muss mit 1. beginnen
opencode auth list        # mindestens eine Anmeldung
opencode models openrouter
```

tybo prüft dasselbe mit `checkEngine("opencode")` (je 5 Sekunden Zeitlimit,
Ergebnis eine Minute gemerkt). Die Rechte stehen beim ersten Aufruf im Log:
`[OpenCode] Rechte: …`.

| Meldung | Abhilfe |
|---|---|
| „OpenCode ist nicht installiert“ | `npm i -g opencode-ai@1` oder `OPENCODE_PATH` in der `.env` setzen |
| „OpenCode 2 wird noch nicht unterstützt“ | `npm i -g opencode-ai@1` |
| „OpenCode ist nicht angemeldet“ | `opencode auth login -p openrouter` |
| „OpenCode-Anmeldung nicht prüfbar“ | `opencode auth list` im Terminal ausführen und die Ausgabe ansehen |

Eine gespeicherte Anmeldung heißt nicht, dass der Schlüssel gilt. Lehnt der
Anbieter ihn ab, antwortet Claude Code mit einem Hinweis, und tybo prüft beim
nächsten Mal neu.

**Anmeldung und Anbieter:** Empfohlen ist OpenRouter
(`opencode auth login -p openrouter`). Der Schlüssel liegt danach bei
OpenCode in `~/.local/share/opencode/auth.json`. Möglich sind auch die
ChatGPT-Anmeldung, GitHub Copilot, OpenCode Zen oder ein API-Schlüssel.
Claude Pro und Max sind in OpenCode nicht erlaubt, Anthropic geht dort nur
mit Schlüssel.

**Schlüssel aus der Umgebung:** Anbieter-Schlüssel wie
`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENCODE_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`,
`XAI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY` und `DEEPSEEK_API_KEY`
erreichen OpenCode nur über `TYBO_SUBPROCESS_ENV_ALLOW`. Viele davon nutzt
tybo selbst (Ersatzmodelle, Embeddings, Hören); ohne Freigabe zahlt also nie
versehentlich tybos Schlüssel für OpenCode. Ein freigegebener Schlüssel
zählt in der Prüfung als Anmeldung; gezählt werden nur diese zehn Namen.

Dasselbe gilt für Zugangsdaten aller anderen Anbieter, die OpenCode kennt,
etwa `CLOUDFLARE_API_TOKEN`, `AWS_ACCESS_KEY_ID` oder `HF_TOKEN`. Die Liste
kommt aus models.dev (Stand in `src/lib/engines/opencode-provider-env.ts`),
aus OpenCodes Zwischenspeicher `~/.cache/opencode/models.json` und aus eigenen
Anbietern unter `"provider"` in allen Konfigurationsdateien, die OpenCode
liest: `opencode.json(c)` im Projekt, in übergeordneten Ordnern und deren
`.opencode`-Ordnern, `~/.opencode/`, `~/.config/opencode/` (auch
`config.json`), `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`,
`OPENCODE_CONFIG_CONTENT` und die systemweiten Orte
(`/Library/Application Support/opencode/` unter macOS, `/etc/opencode/` unter
Linux). Was ein eigener Anbieter als Zugangsdatum nennt (`"env": [...]` oder
`{env:NAME}` in `apiKey`, `headers.Authorization` und ähnlichen Feldern),
braucht immer die Freigabe, egal wie es heißt. Reine Einstellungen wie
`AWS_REGION` bleiben erhalten. Was ein Plugin selbst liest, per MDM verwaltete
Einstellungen und entfernte Organisations-Konfigurationen sieht tybo nicht;
dort gilt die Namensregel aus Entscheidung 0008.

**Projektwissen:** OpenCode sucht vom Projektordner aufwärts eine
`AGENTS.md`, sonst die `CLAUDE.md`, und liest global
`~/.config/opencode/AGENTS.md`, sonst `~/.claude/CLAUDE.md`. tybo startet
OpenCode im Projektordner (`--dir`, `PWD`) und setzt dafür nichts.
`OPENCODE_DISABLE_CLAUDE_CODE` oder `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT`, von
dir gesetzt, schalten das Lesen der `CLAUDE.md` ab.

**Auswählen:** als Standard mit `TYBO_ENGINE=opencode` oder in den
Einstellungen (Reiter Agenten, Abschnitt Motor), für ein Gespräch mit
`/motor opencode`. Im Abschnitt OpenCode stehen Modell, Variante und Rechte
(`engine.opencode` in `config/settings.json`). Die Modell-Liste kommt aus
`opencode models` (10 Sekunden Zeitlimit, 10 Minuten gemerkt),
OpenRouter-Modelle vorn. Scheitert der Abruf, steht der Grund unter dem Feld,
und das Modell lässt sich frei eingeben (`<anbieter>/<modell>`). Ein leeres
Modell heißt: OpenCode nimmt sein eigenes. Die Variante (`--variant`, der
Effort von OpenCode) hängt vom Anbieter ab: 1 bis 20 Zeichen aus
Kleinbuchstaben, Ziffern und Bindestrich, etwa `high` oder `thinking-8k`.
tybo übergibt sie als ein Argument `--variant=<wert>`.

**Rechte:** `engine.opencode.permission` in `config/settings.json`, bei jedem
Aufruf neu gelesen.

| Wert | Bedeutung |
|---|---|
| `auto` (Standard) | mit `--auto`: jede Frage (`ask`) wird bestätigt, auch für Dateien außerhalb des Projekts; Regeln mit `deny` aus der OpenCode-Konfiguration gelten weiter |
| `ask-deny` | ohne `--auto`: jede Frage wird abgelehnt, erlaubt ist nur, was die OpenCode-Konfiguration mit `allow` freigibt |

Eigene Regeln stehen in `opencode.json` unter `"permission"`
([Permissions](https://opencode.ai/docs/permissions/)); tybo setzt dort und
in `OPENCODE_PERMISSION` nichts.

**MCP-Server:** in `~/.config/opencode/opencode.json` (oder `.jsonc`, bei
gesetztem `XDG_CONFIG_HOME` dort) oder im Projekt in `opencode.json(c)`:

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
`{env:NAME}` nennt (in `environment`, `command`, `headers` oder `url`), und nur
aus diesen beiden Dateien. Anbieter-Zugangsdaten und alle `TELEGRAM_*`-Werte
kommen nur über die Freigabeliste durch, `WEB_PASSWORD` nie.

**Skills:** OpenCode liest `.opencode/skills/`, `~/.config/opencode/skills/`,
`.claude/skills/`, `~/.claude/skills/`, `.agents/skills/` und
`~/.agents/skills/`, Claude-Skills also mit.

**Fortschritt:** OpenCode meldet ein Werkzeug erst, wenn es fertig ist; die
Anzeige kommt deshalb etwas später als bei Claude und Codex.

**Danach:** `/motor opencode` in einem Gespräch, und die nächste Antwort kommt
von OpenCode.

---

## Befehle zum Nachsehen

Alle lesen nur oder starten einen Lauf von Hand; keiner beendet den Bot.
Neu gestartet wird der Bot über die WebUI (Neustart anfordern) oder, aus
einer Antwort von tybo heraus, mit `bun run restart:request "Grund"`.

```bash
# Gesamtzustand
tybo pruefen                                   # Bericht mit Exit-Code
curl -s http://127.0.0.1:3000/health           # Bot lebt? (HEALTH_PORT, nur lokal)
cat bot.lock && ps -p "$(cat bot.lock)" -o pid,command

# Dienste
launchctl list | grep ai.tybo                  # macOS
systemctl --user status tybo-telegram-relay    # Linux, systemd
systemctl --user list-timers 'tybo-*'          # Linux, Check-in und Briefing
pm2 list                                       # Linux, PM2
/routinen                                      # im Chat: alle Routinen mit Verlauf

# Logs
tail -f logs/telegram-relay.log
tail -n 50 logs/telegram-relay.error.log

# Teile einzeln
tybo setup telegram                            # Token prüfen, Testnachricht
tybo setup datenbank                           # Verbindung zu Supabase
tybo datenbank status                          # Supabase auf diesem Rechner
tybo suche status                              # Embeddings, Neuberechnung
bun run checkin                                # Check-in einmal
bun run briefing                               # Morgenbriefing einmal
bun run health -- --no-send                    # Nachtcheck nur anzeigen
bun run test:tools                             # MCP-Werkzeuge der Ersatzmodelle

# Claude CLI
claude --version
claude -p "Sag hallo" --output-format text     # CLI direkt, ohne tybo
```

`bot.lock` nicht von Hand löschen: Ein Start ersetzt die Sperre selbst, wenn
ihr Prozess nicht mehr lebt (siehe [Bot antwortet nicht](#bot-antwortet-nicht)).

---

## Logs

Alle Logs liegen im Ordner `logs/` des Projekts. Die Namen kommen aus dem
Dienstkatalog (`src/lib/services/catalog.ts`): je Dienst `<name>.log` für die
Ausgabe und `<name>.error.log` für Fehler.

| Datei | Was drinsteht |
|---|---|
| `telegram-relay.log` | der Bot: Start, Eingang und Antworten, `[Sprache]`, `[threads]`, `[subprocess-env]` |
| `telegram-relay.error.log` | Fehler des Bots und der Claude CLI, Zeitlimits |
| `smart-checkin.log`, `smart-checkin.error.log` | Check-in: Entscheidung, Versand |
| `morning-briefing.log`, `morning-briefing.error.log` | Morgenbriefing: Quellen, Versand |
| `health-check.log`, `health-check.error.log` | Nachtcheck um 03:30 |
| `software-update.log`, `software-update.error.log` | Software-Updates um 03:00, nur wenn eingerichtet |
| `supabase.log` | Autostart von Supabase auf diesem Rechner, Ausgabe und Fehler in einer Datei |
| `embedding-reindex.log` | Neuberechnung der Embeddings im Hintergrund |

Unter PM2 schreibt der Bot zusätzlich in PM2s eigene Logs
(`pm2 logs tybo-telegram-relay --lines 50`). Die Logs nennen Kennungen,
Anbieter und Dauer, aber keine Schlüssel. Nachrichteninhalte können in
Fehlerzeilen vorkommen; vor dem Weitergeben durchsehen.

---

## Neu aufsetzen, ohne Daten zu verlieren

Hilft nichts von oben, lässt sich die Einrichtung neu aufsetzen. Gelöscht
wird dabei nichts: `.env`, `config/`, `data/`, das Gedächtnis und die
Datenbank bleiben. Zustandsdateien wie `bot.lock` oder Sessions nicht von
Hand löschen; tybo räumt sie selbst auf, und eine gelöschte Session kostet
den Gesprächsfaden im Topic.

1. Dienste entfernen: `tybo deinstallieren`. Das betrifft alle Dienste von
   tybo auf diesem Rechner, auch Check-in und Briefing.
2. Abhängigkeiten neu holen: `bun install`.
3. Einrichtung prüfen: `tybo pruefen`. Was rot ist, mit `tybo setup <schritt>`
   reparieren.
4. Von Hand probieren, solange kein Dienst läuft: `bun run start`, eine
   Testnachricht schicken, mit Strg+C beenden.
5. Dienste wieder einrichten: `tybo setup autostart` und `tybo dienste`.

**Danach:** `tybo pruefen` endet mit Exit-Code 0, und eine Testnachricht
bekommt eine Antwort.

---

## Server-Betrieb (Webhook)

Auf einem Server läuft tybo im Profil `server`: Telegram schickt jede
Nachricht per Webhook, statt dass der Bot fragt. Drei Dinge sind getrennt
einzustellen:

- **Betriebsprofil** (`TYBO_PROFILE`): `local` holt per Polling ab (Standard),
  `server` nimmt einen Webhook an, `peer` ist der eigene Rechner hinter einem
  Server im Hybrid-Betrieb.
- **Motor**: wer antwortet, Claude Code, Codex, OpenCode oder die API
  (`TYBO_ENGINE`, Einstellungen).
- **Anmeldung von Claude Code** (`CLAUDE_AUTH`): Abo oder eigener Schlüssel.

Anleitung mit allen Variablen: [telegram-webhook.md](telegram-webhook.md).
Gestartet wird auf dem Server mit `bun run vps` bzw. über `deploy.sh` unter
PM2 (Name `tybo`, `DEPLOY_APP`).

### Kein Telegram-Eingang auf dem Server

**Symptom:** WebUI und Erinnerungen laufen, Telegram-Nachrichten kommen nicht
an. Beim Start steht `[telegram] Profil server: kein Telegram-Eingang (…)`.

**Nachsehen:** Der Text in der Klammer nennt den Grund.

| Grund | Abhilfe |
|---|---|
| `braucht TELEGRAM_WEBHOOK_SECRET` | Ein Secret setzen, etwa mit `openssl rand -hex 32` erzeugt. |
| `muss 16 bis 256 Zeichen …` | Nur `A-Z`, `a-z`, `0-9`, `_` und `-`, mindestens 16 Zeichen. |
| `kein gültiger Port` oder `ist schon vergeben (Health-Port oder WebUI)` | `TELEGRAM_WEBHOOK_PORT` auf einen freien Port setzen (Standard 3080; nicht `HEALTH_PORT`, nicht `WEB_PORT`). |
| `muss eine https-Adresse sein` | `TELEGRAM_WEBHOOK_URL` muss mit `https://` beginnen. |
| `TYBO_PROFILE "…" ist unbekannt` | Nur `local`, `server` oder `peer`. |

tybo fällt dann nie stillschweigend auf Polling zurück: Auf einem Server
pollte sonst womöglich ein zweiter Bot mit demselben Token.

**Danach:** Beim Start steht kein „kein Telegram-Eingang“ mehr, und eine
Testnachricht bekommt eine Antwort.

### Telegram stellt nicht zu

**Symptom:** Der Bot startet ohne Fehler, Nachrichten bleiben trotzdem ohne
Antwort.

**Nachsehen:** Bei Telegram nachfragen, was es zuletzt versucht hat. Im
Projektordner ausführen; den Token liest tybos eigener Parser aus der `.env`,
er wird nicht angezeigt und steht in keinem Prozessargument:

```bash
bun -e 'import { readEnvFile } from "./src/lib/env-file";
const token = (await readEnvFile(".env")).TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN fehlt in der .env");
const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`).catch(() => null);
console.log(res ? JSON.stringify((await res.json()).result ?? { status: res.status }, null, 2) : "Telegram nicht erreichbar");'
```

Die `.env` nicht mit `. ./.env` oder `source` in die Shell laden: Sie ist kein
Shell-Skript, und ein Wert in `"…"` mit `$(…)` würde dabei ausgeführt.

`url` muss deine Adresse mit `/telegram` am Ende zeigen;
`last_error_message` sagt, was schiefging.

| `last_error_message` | Abhilfe |
|---|---|
| fehlt, `pending_update_count` wächst nicht | Alles gut; das Problem liegt hinter dem Listener (Fehler-Log). |
| `Wrong response from the webhook: 401 …` | Das Secret bei Telegram passt nicht zu `TELEGRAM_WEBHOOK_SECRET`. Mit `TELEGRAM_WEBHOOK_URL` trägt der Bot es beim Start neu ein; sonst `setWebhook` wie in [telegram-webhook.md](telegram-webhook.md#webhook-bei-telegram-eintragen). |
| `Connection refused`, `Connection timed out` | Der Proxy oder Tunnel erreicht den Listener nicht. Er muss `https://…/telegram` an `http://127.0.0.1:3080/telegram` weitergeben. |
| `SSL error …` | Das Zertifikat des Proxys ist ungültig oder abgelaufen. |
| `url` ist leer | Kein Webhook eingetragen: `TELEGRAM_WEBHOOK_URL` setzen und neu starten. |

Pollt irgendwo noch ein Bot mit demselben Token (etwa der eigene Rechner im
Profil `local`), löscht er den Webhook beim Start. Dann
[Zwei Bots laufen gleichzeitig](#zwei-bots-laufen-gleichzeitig).

**Danach:** `getWebhookInfo` zeigt keine `last_error_message`, und
`pending_update_count` steht auf 0.

### Claude Code antwortet auf dem Server nicht

**Symptom:** Jede Antwort kommt von einem Ersatzmodell oder gar nicht.

**Nachsehen:** `tybo pruefen` probiert Claude Code mit der Anmeldung aus der
`.env`. Ohne Bildschirm lässt sich die Anmeldung im Abo auf einem Server oft nicht
abschließen.

**Abhilfe:** In der `.env` `CLAUDE_AUTH=apiKey` und `ANTHROPIC_API_KEY`
setzen; mit `apiKey` und ohne Schlüssel startet Claude Code nicht, einen
stillen Rückfall aufs Abo gibt es nicht. Ob die CLI selbst geht:
`claude -p "Sag hallo" --output-format text` im Projektordner.

**Danach:** `tybo pruefen` meldet keinen Fehler bei Claude Code, und die nächste
Antwort nennt kein Ersatzmodell.

### Hybrid: der eigene Rechner bekommt nichts

**Symptom:** Im Hybrid-Betrieb antwortet immer der Server, obwohl der eigene
Rechner läuft.

**Nachsehen:**

- Server-Log beim Start: `[hybrid] Hybrid aus: …` nennt, was fehlt
  (`HYBRID_PEER_URL`, `GATEWAY_SECRET`, Datenbank).
- Log des eigenen Rechners: `[telegram] Profil peer: kein Telegram-Eingang (…)`
  heißt, ihm fehlt das Geheimnis oder die Datenbank.
- Vom Server aus: `curl -s <HYBRID_PEER_URL>/health` muss `"status":"ok"`
  liefern.

**Abhilfe:** Beide Rechner brauchen dasselbe Supabase-Projekt und dasselbe
`GATEWAY_SECRET`. Der eigene Rechner meldet sich alle 30 Sekunden in der
Tabelle `node_heartbeat`; älter als 90 Sekunden gilt er als weg. Antwortet
`curl` nicht, lauscht der Health-Port nur auf 127.0.0.1: `HEALTH_HOST` auf die
Adresse im privaten Netz setzen (etwa Tailscale). Nachrichten fremder
Absender bleiben immer auf dem Server.

**Danach:** Eine Nachricht, während der Rechner wach ist, beantwortet der
eigene Rechner mit seinem Motor.

### Deploy über `/deploy` scheitert

**Symptom:** Ein Push löst nichts aus, oder der Server bleibt auf dem alten
Stand.

**Nachsehen:** In GitHub unter Settings, Webhooks, „Recent Deliveries“ steht
die Antwort des Servers. Auf dem Server liegt je Lauf ein Protokoll unter
`.releases/deploy-*.log`.

| Antwort | Bedeutung |
|---|---|
| `503` | `DEPLOY_SECRET` fehlt auf dem Server. |
| `401` | Secret in GitHub und `DEPLOY_SECRET` stimmen nicht überein. |
| `409`, „Deploy läuft schon“ | Es lief gerade ein Deploy; der nächste Push startet wieder einen. |
| `500`, „Deploy nicht gestartet“ | Das Skript (`DEPLOY_SCRIPT`, Standard `deploy.sh`) fehlt oder ist nicht ausführbar; der Grund steht im Log des Bots. |
| `200` mit `skipped` | Kein Push, oder ein Push auf einen anderen Branch als `DEPLOY_BRANCH`. |

Scheitert `bun run check` oder die Prüfung auf `/health` im neuen Release,
kehrt `deploy.sh` zur vorigen Fassung zurück; der Grund steht im Protokoll.

**Danach:** `curl -s http://127.0.0.1:3080/health` auf dem Server zeigt in
`revision` den neuen Stand.

### Tagesbudget erreicht

**Symptom:** Ersatzmodelle, Sprach-Brücke, Telefonhörer oder der
Gast-Assistent lehnen ab; im Log steht `Daily API budget reached`.

**Nachsehen:** Diese Aufrufe zahlen nach Verbrauch und reservieren vorab
einen Betrag aus dem Tagesbudget. Ein Tag ist der UTC-Tag; die Buchungen
liegen in `data/api-budget.sqlite`. Claude Code selbst zählt nicht dazu, im
Abo zählt `/credit` mit.

**Abhilfe:** `DAILY_API_BUDGET` in der `.env` setzen (Dollar, Standard 5) und
tybo neu starten, oder bis zum nächsten UTC-Tag warten. Die Reservierung je
Aufruf stellen `FALLBACK_REQUEST_RESERVATION_USD`,
`VOICE_REQUEST_RESERVATION_USD` und `GUEST_REQUEST_RESERVATION_USD` ein.

**Danach:** Der nächste Aufruf läuft wieder durch, ohne `Daily API budget
reached` im Log.

### Ports und Firewall

**Symptom:** Ein Port-Scan von außen findet 3000, 3080 oder 3100 offen, oder
der Webhook kommt nur an, solange die Firewall aus ist.

**Nachsehen:** `sudo ss -tlnp | grep -E ':(3000|3080|3100)\b'` zeigt, auf
welcher Adresse die Ports lauschen, `sudo ufw status verbose` die Freigaben.
Steht dort `0.0.0.0` statt `127.0.0.1`, ist `HEALTH_HOST`,
`TELEGRAM_WEBHOOK_HOST` oder `WEB_HOST` gesetzt: in der `.env` oder in der
Umgebung, mit der der Prozess gestartet wurde.

Unter welchem Namen der Bot läuft, hängt davon ab, wie er auf den Server kam:

| Betrieb | Name des Prozesses | Prüfen |
|---|---|---|
| Setup (`tybo setup autostart`), Linux mit systemd | `tybo-telegram-relay` | `systemctl --user list-units 'tybo-*'` |
| Setup (`tybo setup autostart`) mit PM2 | `tybo-telegram-relay` | `pm2 list` |
| Deploy (`deploy.sh`, auch über `/deploy`) | `tybo`, mit `DEPLOY_APP` in der `.env` dieser Name | `pm2 list`; `pm2 describe <name>` zeigt in `exec cwd` einen Ordner unter `.releases/` |

**Abhilfe:** Öffentlich erreichbar sein muss auf einem Server nur der
Reverse-Proxy oder Tunnel mit `https` (Port 443) und SSH. Die Ports von tybo
selbst lauschen standardmäßig nur auf 127.0.0.1 und gehören nicht in die
Firewall-Freigabe:

| Port | Wozu | Öffentlich? |
|---|---|---|
| 3080 (`TELEGRAM_WEBHOOK_PORT`) | Webhook-Listener, `/health`, `/deploy` | nein, nur über den Proxy |
| 3000 (`HEALTH_PORT`) | Health-Server, `/process`, im Hybrid `/relay` | nie, höchstens im privaten Netz |
| 3100 (`WEB_PORT`) | WebUI | nein, Zugang über `tybo setup zugang` |

Eine Firewall allein schließt einen offenen Port nicht, solange eine alte
Freigabe ihn durchlässt oder tybo auf `0.0.0.0` lauscht. Deshalb in dieser
Reihenfolge:

1. **Bindung korrigieren.** In der `.env` des Servers alle drei Werte
   ausdrücklich setzen:

   ```bash
   HEALTH_HOST=127.0.0.1
   TELEGRAM_WEBHOOK_HOST=127.0.0.1
   WEB_HOST=127.0.0.1
   ```

   Proxy und Tunnel auf demselben Rechner erreichen tybo so weiter. Die
   Zeilen nur zu löschen reicht nicht: tybo überschreibt beim Start nur die
   Werte, die in der `.env` stehen, ein geerbter Wert bleibt. PM2 hebt die
   Umgebung des ersten `pm2 start` auf und gibt sie bei jedem Neustart und
   jedem Deploy weiter; ein `0.0.0.0` aus einer alten Shell käme so immer
   wieder. Im
   Hybrid-Betrieb muss der Server den Health-Port des eigenen Rechners
   (Profil `peer`) erreichen: Dort steht `HEALTH_HOST` auf der Adresse im
   privaten Netz, etwa der Tailscale-Adresse (`tailscale ip -4`), nie auf
   `0.0.0.0`.
2. **Neu starten**, aus einem eigenen Terminal, damit die neue Bindung gilt,
   und zwar den Prozess aus der Tabelle oben:

   ```bash
   systemctl --user restart tybo-telegram-relay   # Setup, Linux mit systemd
   pm2 restart tybo-telegram-relay                # Setup mit PM2
   pm2 restart tybo                               # Deploy; mit DEPLOY_APP dieser Name
   ```

3. **Öffentliche Freigaben entfernen.** `sudo ufw status numbered` listet
   die Regeln. Jede Regel für 3000, 3080 oder 3100 ohne `on tailscale0`
   (auch die mit `(v6)`) mit `sudo ufw delete <nummer>` löschen, von der
   höchsten Nummer abwärts, weil die übrigen nachrücken. Danach erneut
   listen.
4. **Nur das Nötige freigeben.** `sudo ufw allow OpenSSH` vor
   `sudo ufw enable`, sonst sperrt ufw die laufende SSH-Sitzung aus.
   `sudo ufw allow 443/tcp` nur, wenn der Reverse-Proxy auf diesem Rechner
   läuft; ein Cloudflare Tunnel baut die Verbindung von innen auf und braucht
   keinen offenen Port.
5. **Hybrid privat halten.** Hat der eigene Rechner selbst ufw, den
   Health-Port nur im privaten Netz freigeben:
   `sudo ufw allow in on tailscale0 to any port 3000 proto tcp`.

**Danach:** Ein Port-Scan von außen (nicht über Tailscale) findet 3000, 3080
und 3100 nicht mehr. `sudo ss -tlnp` zeigt die drei Ports nur auf
`127.0.0.1`, im Hybrid auf dem eigenen Rechner 3000 auf der privaten Adresse.
`sudo ufw status numbered` enthält für diese Ports keine Regel außer
`on tailscale0`, und `getWebhookInfo` meldet keinen `last_error_message`.

### SSH-Zugang zum Server verloren

**Symptom:** `ssh` meldet `Permission denied (publickey)`,
`Too many authentication failures` oder läuft in eine Zeitüberschreitung,
obwohl der Server läuft.

**Nachsehen:** Über die Web-Konsole des Hosters anmelden. Ist fail2ban
installiert, zeigt `sudo fail2ban-client status sshd` gesperrte Adressen.

**Abhilfe:**

- Gesperrt: `sudo fail2ban-client set sshd unbanip <deine-adresse>`. Häufiger
  Grund sind mehrere Schlüssel, die `ssh` nacheinander probiert. In
  `~/.ssh/config` für den Server `IdentityFile` und `IdentitiesOnly yes`
  eintragen.
- Schlüssel mit Passphrase: `ssh-add <schlüsseldatei>`, damit der Agent ihn
  kennt.
- Öffentlicher Schlüssel fehlt auf dem Server: über die Web-Konsole in
  `~/.ssh/authorized_keys` des Benutzers eintragen.

**Danach:** `ssh <server>` meldet sich ohne Fehler an.

---

## Fehler melden

Hilft nichts davon, ein Issue im Repo eröffnen
([github.com/cloudnutzer/tybo/issues](https://github.com/cloudnutzer/tybo/issues))
mit:

1. was du erwartet hast und was passiert ist, mit den Schritten dahin;
2. den letzten 50 Zeilen aus dem passenden Log, vorher auf Namen, Nummern und
   Inhalte durchgesehen;
3. Umgebung: `bun --version`, `claude --version`, Betriebssystem und die
   Ausgabe von `tybo pruefen`;
4. was sich zuletzt geändert hat (Update, neue Werte in der `.env`, eigener
   Code).

Werte aus der `.env` gehören nie in ein Issue.

---

## Wo es im Code steht

| Datei | Inhalt |
|---|---|
| `src/app/` | Start, Beenden, Sperre `bot.lock`, Neustart, Health-Server, Hybrid |
| `src/app/health-server.ts` | `/health`, `/process`, `/relay`; `HEALTH_HOST`, `HEALTH_PORT` |
| `src/app/server-routes.ts` | Wege im Profil `server`: `/health`, `/deploy`, `/webhook/elevenlabs` |
| `src/lib/runtime-profile.ts` | Profile `local`, `server`, `peer` und ihre Prüfung |
| `src/lib/telegram-runtime.ts` | Webhook-Listener |
| `src/lib/claude.ts` | Aufruf der Claude CLI, Zeitlimits |
| `src/lib/fallback/chain.ts` | Ersatzmodelle: Stufen, Abbruch, Logzeilen |
| `src/lib/execution-context.ts` | Plätze, Warteschlange, `/stop` |
| `src/lib/agent-capacity.ts` | Grenze gleichzeitiger Aufträge (`MAX_AGENT_PROCESSES`) |
| `src/lib/queue-notice.ts` | Text des Wartehinweises |
| `src/lib/subprocess-env.ts` | Umgebung der Subprozesse, Freigabeliste |
| `src/lib/speech/` | Hören und Sprechen |
| `src/lib/spend/` | Tagesbudget und Abo-Zähler |
| `src/lib/services/catalog.ts` | Dienste, Zeitpläne, Logdateien |
| `src/setup/services/` | `tybo dienste`, `tybo deinstallieren` |
| `src/setup/checks/` | Prüfbericht `tybo pruefen` |
| `.env.example` | alle Variablen mit Erklärung |

---

**Zurück zum Anfang:** [Einrichtung](einrichtung.md)
