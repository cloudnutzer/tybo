# tybo einrichten

Diese Anleitung führt auf einem frischen Rechner bis zur ersten Antwort in
Telegram oder in der WebUI. Du brauchst dafür weder Claude Code als Gesprächspartner noch die
`CLAUDE.md`. Der Assistent `tybo setup` fragt alles ab, prüft jede Angabe
gleich mit einem Verbindungstest und schreibt die `.env` erst nach deiner
Bestätigung.

Was der Assistent nicht übernimmt, steht am Ende unter
[Was der Assistent nicht erledigt](#was-der-assistent-nicht-erledigt).

tybo rund um die Uhr auf einem Raspberry Pi 5: [raspberry-pi.md](raspberry-pi.md)
ergänzt diese Anleitung um Hardware, System, Claude CLI ohne Node.js,
Autostart und Betrieb auf dem Pi.

## Schnellweg: ein Befehl

Auf macOS und Linux (auch WSL) holt ein einziger Befehl tybo auf den Rechner
und startet danach den Assistenten:

```bash
curl -fsSL https://tybo.ai/install | sh
```

**Was der Befehl tut**, der Reihe nach:

1. Prüft, dass er nicht als root läuft, und das System (macOS oder Linux).
2. Prüft, ob Git da ist. Fehlt es, bricht er mit dem Befehl zum Nachholen ab
   (`xcode-select --install` bzw. `sudo apt install git`).
3. Prüft, ob Bun 1.3.10 oder neuer da ist. Fehlt Bun oder ist es zu alt,
   fragt er, ob er den offiziellen Installer von bun.sh starten bzw.
   `bun upgrade` ausführen soll. Der Bun-Installer braucht `bash`, `curl` und
   `unzip` und trägt Bun selbst in deine Shell-Startdatei ein.
4. Holt tybo per `git clone` nach `~/tybo`.
5. Installiert die Pakete (`bun install`) und legt den Befehl `tybo` an
   (`bun link`).
6. Startet `tybo setup`, den Assistenten aus dieser Anleitung.
7. Nennt am Ende, was noch fehlt: Bun im `PATH` (steht in der Startdatei
   deiner Shell schon ein Eintrag, empfiehlt er „neues Terminal öffnen oder
   `source …`“ und nennt die zwei Zeilen als Rückfall, falls `tybo` danach
   trotzdem fehlt; sonst nur die zwei Zeilen zum Eintragen), die Claude CLI (nativer Installer;
   liegt sie schon in `~/.local/bin` und meldet dort ihre Version, nur der
   Hinweis auf eine neue Sitzung, sonst der Hinweis zum Neuinstallieren)
   und Node.js nur als Hinweis, wofür es gebraucht wird (PM2, npm).

**Was er nicht tut:** Node.js, die Claude CLI und PM2 installiert er nicht,
die kommen danach von Hand dazu (siehe [Voraussetzungen](#voraussetzungen)).
Er ruft nie `sudo` auf, braucht keine Root-Rechte und ändert selbst keine
Shell-Startdateien.

**Optionen** stehen hinter `sh -s --`:

| Option | Was sie tut | Beispiel |
|---|---|---|
| `--dir <pfad>` | anderer Zielordner statt `~/tybo` | `curl -fsSL https://tybo.ai/install \| sh -s -- --dir ~/apps/tybo` |
| `--yes` | Bun ohne Rückfrage installieren bzw. aktualisieren; bestätigt sonst nichts | `curl -fsSL https://tybo.ai/install \| sh -s -- --yes` |
| `--no-setup` | nur installieren, `tybo setup` später selbst starten | `curl -fsSL https://tybo.ai/install \| sh -s -- --no-setup` |
| `--help` | alle Optionen anzeigen, nichts installieren | `curl -fsSL https://tybo.ai/install \| sh -s -- --help` |

Den Zielordner kann auch die Variable `TYBO_DIR` setzen, wenn `--dir` fehlt.
Sie gehört auf die rechte Seite der Pipe, zu `sh`:

```bash
curl -fsSL https://tybo.ai/install | TYBO_DIR="$HOME/apps/tybo" sh
```

Für Tests und eigene Kopien gibt es noch `TYBO_REPO_URL` (anderes Repo zum
Klonen), `TYBO_BRANCH` (anderer Branch, Standard `master`), `TYBO_TTY`
(Terminal für Rückfragen und Einrichtung, Standard `/dev/tty`) und
`BUN_INSTALL` (Bun-Ordner, Standard `~/.bun`).

**Aktualisieren:** denselben Befehl noch einmal ausführen, mit demselben
Zielordner (also auch mit demselben `--dir` bzw. `TYBO_DIR`). Er holt dann den
neuesten Stand und installiert die Pakete neu. Das geht nur, wenn der Ordner
ein unveränderter Klon von tybo auf dem Branch `master` ist: ohne lokale
Änderungen an verwalteten Dateien und ohne eigene Commits. Sonst bricht er ab
und ändert nichts. Klone von 2.15.x oder älter stellt er einmalig auf die mit
2.16.0 neu aufgebaute Historie um
([mehr](troubleshooting.md#historie-neu-aufgebaut)). `tybo setup` startet beim Aktualisieren nicht noch einmal,
und ein laufender Bot wird nicht von selbst neu gestartet; den Befehl dafür
nennt der Installer am Ende.

**Neue Migrationen nach einem Update:** Ein Update holt neuen Code, aber keine
neuen Tabellen. Hat sich zwischen altem und neuem Stand etwas in `db/`
geändert, nennt der Installer am Ende `tybo setup datenbank`. Das vor dem
Neustart ausführen:

- Supabase in der Cloud: `tybo setup datenbank` braucht wieder ein frisches
  Zugangstoken (`sbp_…`), weil tybo es nie speichert. Der Bot spielt in der
  Cloud nichts von selbst ein.
- Supabase auf diesem Rechner: `tybo datenbank start` (auch der Dienst
  dafür) spielt fehlende Migrationen nach dem Start und der Schutzprüfung
  selbst ein und verbucht sie; beim nächsten Start ist nichts mehr zu tun.
  Jeder Lauf hält vom Lesen der Historie bis zum Ende eine gemeinsame
  Datenbanksperre; ein zweiter wartet und liest danach neu. Vor der ersten
  Datei prüft er unter dieser Sperre die betroffenen Bilder-Ordner. Würde
  eine Migration einen öffentlichen Ordner privat stellen, bricht er mit
  Hinweis und Exit 1 ab, ohne eine Migrationsdatei einzuspielen. Das schützt
  auch den festen Ordner `tybo-assets` aus
  `20260909_security_knowledge.sql`, wenn in der
  `.env` ein anderer Name steht. Auch eine nicht mögliche Prüfung
  beendet den Lauf.
  Jede Datei läuft in einer Transaktion, neue Dateien am Ende zusammen
  mit ihrer Verbuchung. Ab der ersten unverbuchten Datei laufen alle
  späteren noch einmal mit, damit neuere Fassungen von Funktionen erhalten
  bleiben. Bei einer solchen Historienlücke werden die fehlenden Einträge
  erst mit der letzten schon verbuchten Datei festgeschrieben. Scheitert
  der Nachlauf vorher, bleibt die Lücke offen; der nächste Start wiederholt
  ihn, auch wenn einzelne Dateien bereits eingespielt sind.
  `tybo setup datenbank` geht denselben Weg.
- Zugangsdaten selbst eingetragen: die fehlenden Dateien aus
  `db/migrations/` der Reihe nach im SQL-Editor ausführen, nie
  `db/schema.sql` allein.

Ob etwas fehlt, zeigt `tybo pruefen` in der Zeile „Schema“ (siehe
[Schemaprobe](#schemaprobe)). Der Bot prüft das bei jedem Start auch und
meldet eine Lücke einmal in Telegram und der WebUI.

**Windows:** Der Befehl läuft nicht unter Windows selbst (unter WSL schon).
Dort den Weg [Von Hand einrichten](#von-hand-einrichten) nehmen.

Klappt etwas nicht, stehen die Meldungen des Installers mit Abhilfe in
[Troubleshooting](troubleshooting.md#installation-mit-einem-befehl).

## Von Hand einrichten

Ohne den Installer, oder unter Windows, geht es mit diesen beiden Schritten.

### Voraussetzungen

Diese Programme müssen auf dem Rechner sein. Der Assistent prüft sie im
Schritt „Voraussetzungen“, installiert sie aber nicht selbst.

- **Bun** 1.3.10 oder neuer:
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```
  Der Bun-Installer trägt Bun meist selbst in die Startdatei deiner Shell ein
  (`~/.zshrc`, `~/.bashrc` oder `~/.bash_profile`). Öffne danach zuerst ein
  neues Terminal bzw. eine neue SSH-Sitzung oder führe `source ~/.bashrc`
  (bzw. die Datei, die er nennt) aus. Fehlt `bun` danach trotzdem, trag
  den Ordner `~/.bun/bin` selbst in den Suchpfad ein, mit dieser Zeile am
  Ende der Startdatei:
  ```bash
  export PATH="$HOME/.bun/bin:$PATH"
  ```
  Zu alt: `bun upgrade`.
- **Node.js** 20.0.0 oder neuer, mit `npm` und `npx`, nur in zwei Fällen:
  für PM2 (Autostart unter Windows und Linux ohne systemd) und wenn du die
  Claude CLI über npm statt mit dem nativen Installer holst (dann Node.js 22 oder neuer). Für
  tybo selbst und die Claude CLI aus dem nativen Installer ist Node.js nicht
  nötig. Installieren:
  auf macOS `brew install node` (mit [Homebrew](https://brew.sh)) oder das
  LTS-Paket von [nodejs.org](https://nodejs.org), auf Linux (Debian, Ubuntu)
  das LTS-Paket über [NodeSource](https://github.com/nodesource/distributions)
  oder den Paketmanager (`sudo apt install nodejs npm`, auf älteren
  Distributionen oft zu alt), auf Windows den Installer von
  [nodejs.org](https://nodejs.org). Prüfen mit `node --version` und
  `npm --version`. Zeigt `node --version` eine ältere Version als 20 an,
  zuerst Node.js aktualisieren. Der Assistent prüft Node.js nicht selbst.
- **Claude CLI**, installiert und angemeldet. Auf macOS, Linux und in WSL
  mit dem nativen Installer von Anthropic; er braucht weder Node.js noch
  `sudo`, aktualisiert sich selbst und legt `claude` in `~/.local/bin` ab:
  ```bash
  curl -fsSL https://claude.ai/install.sh | bash
  claude          # einmal starten, dann /login
  ```
  Ohne Claude-Konto geht es mit Codex als Motor; dann ist die Claude CLI
  keine Pflicht, siehe [Server und Codex](server.md).
  Findet die Shell `claude` danach nicht, ist `~/.local/bin` in dieser
  Sitzung noch nicht im `PATH`: neues Terminal bzw. neue SSH-Sitzung öffnen.
  Hilft das nicht, `export PATH="$HOME/.local/bin:$PATH"` in `~/.zshrc`
  bzw. `~/.bashrc` eintragen. Unter Windows (ohne WSL), oder wenn du npm
  bevorzugst: `npm install -g @anthropic-ai/claude-code` (braucht Node.js 22
  oder neuer; unter Linux oft nur mit `sudo`, und das automatische Update geht
  dann nicht). Wie Claude Code abrechnet, legt `CLAUDE_AUTH` in der `.env`
  fest: `subscription` über dein Claude-Abo, `apiKey` nach Verbrauch mit
  `ANTHROPIC_API_KEY`. Ohne Wert nimmt tybo den Schlüssel, wenn einer
  gesetzt ist, sonst das Abo ([Kosten](faq.md#was-kostet-das-und-wie-rechnet-claude-code-ab)).
- **Git**: auf macOS `xcode-select --install`, auf Linux etwa
  `sudo apt install git`.
- **Linux mit systemd** (etwa Raspberry Pi OS, Debian, Ubuntu): für den
  Autostart nichts weiter, er läuft als systemd-Benutzerdienst. PM2 nur, wenn
  du lieber PM2 nimmst oder Supabase auf diesem Rechner betreibst. Für einen
  Raspberry Pi 5 siehe [raspberry-pi.md](raspberry-pi.md).
- **Linux ohne systemd und Windows:** PM2 für den Autostart: `npm install -g pm2`.
- Ein **Telegram**-Konto, nur wenn du tybo über Telegram nutzen willst. Für
  die WebUI allein brauchst du keins.

### Starten

Im Projektordner einmal die Pakete holen und den Befehl `tybo` anlegen:

```bash
bun install
bun link          # legt tybo in ~/.bun/bin ab (muss im PATH sein, siehe oben)
tybo setup
```

Ohne `bun link` geht dasselbe im Projektordner mit `bun run setup`.

Weitere Aufrufe:

| Befehl | Was er tut |
|---|---|
| `tybo setup` | Übersicht, dann die offenen Schritte der Reihe nach |
| `tybo setup <schritt>` | nur ein Schritt, auch wenn er erledigt ist, etwa `tybo setup telegram` |
| `tybo setup --liste` | nur die Übersicht, schreibt und testet nichts |
| `tybo setup --web` | Einrichtung im Browser, siehe [Der Weg im Browser](#der-weg-im-browser) |

Die Namen der Schritte für `tybo setup <schritt>`: `voraussetzungen`,
`telegram`, `gruppe`, `datenbank`, `suche`, `profil`, `modelle`, `sprache`,
`webui`, `zugang`, `google`, `autostart`, `pruefung`.

Abbrechen geht jederzeit mit Strg+C. Schon gespeicherte Schritte bleiben, der
laufende Schritt wird nicht halb geschrieben. Weiter geht es später mit
`tybo setup`.

## So fragt der Assistent

**Übersicht.** Zuerst zeigt `tybo setup` alle Schritte mit Stand (erledigt,
teilweise, fehlt). Danach kommt die Frage:

> Erledigte trotzdem bearbeiten? Ihre Nummern eingeben (z. B. 2,5), sonst Enter:

Enter nimmt nur die offenen Schritte. Mit Nummern oder Namen (etwa `2,5` oder
`telegram`) kommen erledigte Schritte dazu, zum Beispiel um ein Token zu
ersetzen.

**Optionale Schritte** (Telegram, Forum-Gruppe, Semantische Suche, Modelle
und Fallback, Sprache, WebUI, Zugang vom Handy, Google-Kalender und Gmail)
beginnen mit der Frage „Jetzt einrichten? [J/n]“. Mit
`n` wird der Schritt übersprungen; die Einrichtung ist trotzdem vollständig,
solange Telegram oder die WebUI eingerichtet ist. Überspringst du Telegram
und die WebUI ist noch aus, kommt die WebUI als nächster Schritt; sie lässt
sich dann nur nach der Rückfrage „Richte Telegram oder die WebUI ein, sonst
erreicht dich tybo nirgends. Trotzdem überspringen? [j/N]“ auslassen. Ohne
Telegram überspringt der Assistent die Forum-Gruppe von selbst, ohne WebUI
den Zugang vom Handy.

**Felder.** Zu jedem Feld stehen Titel, Hilfetext und oft ein Link, wo es den
Wert gibt. Geheime Felder (Tokens, Schlüssel, Passwort) bleiben beim Tippen
unsichtbar, es erscheinen auch keine Sternchen. Ist ein Wert schon gesetzt,
behält Enter ihn; der Assistent zeigt gesetzte Werte nie an, nur „gesetzt“.
Bei Auswahlfeldern gibst du die Nummer ein, bei Ja/Nein `j` oder `n`. Die
Pflicht-Auswahlen „Datenbank“ und „WebUI einschalten“ fragt der Assistent
auch bei erneutem Einrichten immer neu ab, weil von ihnen abhängt, welche
Felder folgen. Leere optionale Felder bleiben leer. Passt
eine Eingabe nicht (etwa ein Token im falschen Format), nennt der Assistent
den Grund und fragt „Nochmal eingeben? [J/n]“; `n` überspringt den Schritt.

**Verbindungstest.** Nach den Feldern testet der Assistent die Angaben, bevor
er etwas speichert. Schlägt der Test fehl, fragt er „Erneut eingeben [E] oder
überspringen [ü]?“. Beim erneuten Eingeben übernimmt Enter deine Eingabe vom
vorigen Versuch. Bei Schritten ohne Felder heißt die Frage
„Nochmal prüfen [E] oder überspringen [ü]?“.

**Speichern.** Dann folgt eine Zusammenfassung ohne Werte (nur welche Felder
neu gesetzt werden) und die Frage „Speichern? [J/n]“. Erst danach schreibt
der Assistent. Vor jedem Schreiben legt er eine Sicherung der `.env` in
`data/backups/` ab; die `.env` bekommt die Rechte 0600. Schlägt das Schreiben
fehl, fragt er wieder „Erneut eingeben [E] oder überspringen [ü]?“ bzw.
„Nochmal versuchen [E] oder überspringen [ü]?“.

**Autostart** fragt stattdessen „Autostart jetzt einrichten? [j/N]“. Hier ist
Nein der Standard, weil der Bot damit sofort im Hintergrund startet.

**Vorschläge und Auswahlen vom Anbieter.** Manche Felder haben einen
Vorschlag, der in Klammern hinter der Frage steht, etwa „Projektname [tybo]:“.
Enter übernimmt ihn, solange noch kein Wert gesetzt ist; ein gesetzter Wert
hat immer Vorrang. Bei manchen Auswahlfeldern kommt die Liste erst vom
Anbieter, abhängig von dem, was du davor eingegeben hast (etwa die
Organisationen zu einem Zugangstoken). Der Assistent lädt sie, wenn er an das
Feld kommt, und zeigt sie nummeriert. Lässt sie sich nicht laden, nennt er den
Grund ohne deine Eingaben und fragt
„Nochmal eingeben [E] oder überspringen [ü]?“; `e` beginnt den Schritt von
vorn, Enter übernimmt dabei das schon Eingegebene. Werte, die nur für den laufenden Vorgang gelten (etwa ein
Passwort, das beim Anlegen gebraucht wird), speichert der Assistent nie und
zeigt sie nirgends an.

**Abläufe.** Schritte, die etwas selbst anlegen statt nur einzutragen, nutzen
statt „Verbindungstest, dann Speichern“ einen Ablauf. Der Assistent zeigt
zuerst unter „Das passiert jetzt:“, was er tun wird, und fragt einmal
„Jetzt ausführen? [J/n]“. Danach erscheint je Teilschritt eine Zeile wie
„[3/7] Warte, bis das Projekt bereit ist (1:20)“; bei langem Warten höchstens
alle 15 Sekunden eine neue. Am Ende stehen das Ergebnis und die geänderten
Namen. Den Verbindungstest macht der Ablauf selbst. Strg+C bricht einen
Ablauf an der nächsten sicheren Stelle ab: der Assistent wartet höchstens
30 Sekunden auf das Ende, zeigt dann, was schon erledigt ist und wie es
weitergeht (meist: den Schritt erneut aufrufen, der Assistent ergänzt nur,
was fehlt), und endet. Ein angefangenes Schreiben der `.env` läuft immer zu
Ende, ebenso die Portprüfung und der Schutz-Stopp bei „Supabase auf diesem
Rechner“: dauern sie länger, zeigt der Assistent eine Warnung mit dem Befehl
zum Anhalten und endet erst nach ihrem Ergebnis. Im Browser heißt der Knopf dann „Einrichten“: erst kommt der Plan, dann
„Jetzt ausführen“, danach die Fortschrittsliste mit „Abbrechen“. Das Fenster
zu schließen bricht nicht ab; das Terminal von `tybo setup --web` meldet
Beginn und Ende. Solange ein Ablauf läuft, gehen „Speichern“ und „Fertig“
nicht.

**Gesamtprüfung.** Am Ende testet der Assistent alle eingerichteten Schritte
noch einmal mit den gespeicherten Werten. Schlägt einer fehl, fragt er
„<Schritt> erneut eingeben [E] oder überspringen [ü]?“ (bei Voraussetzungen
und Autostart „<Schritt> nochmal prüfen …“). Zum Schluss stehen eine
Zusammenfassung und der nächste Schritt da.

## Die Schritte

Die Reihenfolge ist die des Assistenten. Pflicht sind Voraussetzungen,
Datenbank, Profil und Autostart, dazu mindestens ein Kanal: Telegram oder die
WebUI (siehe [Telegram, WebUI oder beides](#telegram-webui-oder-beides)).

### 1. Voraussetzungen

Prüft Bun, Claude CLI und Git (siehe oben). Dieser Schritt hat keine Felder.
Sind alle drei da, zählt er als erledigt und kommt nur in der Gesamtprüfung
wieder vor. Dort startet der Assistent zusätzlich einen kurzen Probeaufruf
der Claude CLI, um die Anmeldung zu prüfen. Fehlt etwas, steht der Befehl zum
Nachholen daneben; nach dem Installieren „Nochmal prüfen“.

**Ohne Claude-Konto:** Ist als Motor nicht Claude Code eingestellt (etwa
Codex, siehe Schritt 7), prüft dieser Schritt statt der Claude CLI den
gewählten Motor: Codex muss installiert und mit `codex login` angemeldet
sein. Eine fehlende Claude CLI oder Anmeldung ist dann nur ein Hinweis, etwa
„Claude ist nicht angemeldet: Hintergrund-Jobs und Nebenaufgaben laufen
nicht.“ Bei einem frischen Lauf gilt zunächst Claude Code; scheitert der
Schritt daran, „überspringen“ wählen. Der Schritt Modelle kommt dann gleich
als nächster, und die Gesamtprüfung prüft die Voraussetzungen am Ende mit
dem gewählten Motor noch einmal. Mehr: [Server und Codex](server.md).

### Telegram, WebUI oder beides

tybo braucht mindestens einen Weg zu dir: Telegram oder die WebUI (Chat im
Browser, auch als App auf dem Handy). Welchen du nimmst, entscheidest du in
der Einrichtung:

- **Nur die Web-App:** Schritt Telegram überspringen, Schritt WebUI
  einrichten. tybo startet dann ohne Telegram; Antworten, Meldungen und
  Rückfragen kommen in die WebUI (und per Push aufs Handy). Beim Start steht
  im Log „Telegram nicht eingerichtet: nur WebUI“.
- **Nur Telegram:** Schritt Telegram einrichten, WebUI überspringen. Den
  Terminal-Chat `tybo` gibt es dann nicht, er braucht die WebUI.
- **Beides:** beide Schritte einrichten. Gespräche aus Telegram siehst du
  auch im Browser und umgekehrt.

Telegram lässt sich jederzeit nachholen (`tybo setup telegram`); Gespräche,
die bis dahin nur in der WebUI liefen, bleiben Web-Gespräche.

**Halb eingerichtetes Telegram** zählt nicht: stehen nur Token oder nur
Nutzer-ID in der `.env` (oder ist die Nutzer-ID keine Zahl), meldet der
Assistent „Telegram halb eingerichtet: … Beide Werte setzen oder beide
entfernen.“ und die Einrichtung ist nicht fertig, auch nicht mit WebUI. Der
Bot startet dann im Einrichtungsmodus statt normal.

### 2. Telegram (optional)

Der Bot, über den tybo in Telegram mit dir spricht. Ohne Telegram erreichst
du tybo über die WebUI (siehe oben).

- **Bot-Token:** In Telegram [@BotFather](https://t.me/BotFather) öffnen,
  `/newbot` senden, Namen vergeben und das Token kopieren (Zahl, Doppelpunkt,
  lange Zeichenfolge).
- **Deine Telegram-Nutzer-ID:** Eine Zahl, nicht der Benutzername.
  [@userinfobot](https://t.me/userinfobot) anschreiben, er antwortet sofort
  mit der ID. Vorsicht vor Nachahmern mit ähnlichem Namen.

**Wichtig vor dem Test:** Öffne deinen neuen Bot in Telegram und tippe auf
**Start**. Ein Telegram-Bot darf dir erst schreiben, wenn du ihn einmal
angeschrieben hast. Der Verbindungstest prüft das Token und schickt dir eine
Testnachricht („tybo ist verbunden. Diese Nachricht kommt aus der
Einrichtung.“). Sie ist nur ein Test, noch keine Antwort von Claude.

### 3. Forum-Gruppe (optional)

Eine Telegram-Gruppe mit Themen, ein Thema pro Agent oder Gespräch. Ohne sie
gibt es nur den Direktchat, und das reicht zum Start.

- **Gruppen-ID der Forum-Gruppe:** So kommst du an die Gruppe und ihre ID:
  1. In Telegram eine Gruppe anlegen und in den Gruppeneinstellungen
     „Themen“ einschalten.
  2. Deinen Bot hinzufügen und zum **Admin** machen (sonst kann er keine
     Themen anlegen).
  3. Die ID beginnt mit `-100`. Am einfachsten öffnest du die Gruppe in
     Telegram Web ([web.telegram.org](https://web.telegram.org)); die Zahl
     am Ende der Adresse ist die ID. Fehlt dort das `-100` am Anfang, setzt
     du es davor.

Der Test prüft, ob die Gruppe existiert, Themen hat und der Bot Admin ist.

### 4. Datenbank

Gedächtnis, Verlauf und Ziele liegen in Supabase. Es gibt drei Wege; der
erste ist der Standard und der einfachste.

- **Datenbank:** Auswahl
  1. „Supabase in der Cloud, der Assistent richtet alles ein (Standard)“:
     Du legst nur ein kostenloses Konto an und erzeugst ein Zugangstoken, den
     Rest macht der Assistent (siehe unten).
  2. „Supabase auf diesem Rechner, in Docker, der Assistent richtet alles ein“:
     für alle, die ihre Gespräche nicht in eine Cloud geben wollen. Braucht
     Docker (siehe [Supabase auf diesem Rechner](#supabase-auf-diesem-rechner)).
  3. „Supabase, Zugangsdaten selbst eintragen (vorhandenes Projekt)“: für ein
     Projekt, das es schon gibt, oder einen eigenen Supabase-Server. Projekt,
     Tabellen und Bilder-Ordner legst du vorher selbst an
     ([Supabase vorbereiten](#supabase-vorbereiten)).

  Convex bietet der Assistent nicht mehr an; wer es bisher genutzt hat, liest
  [Umzug von Convex](#umzug-von-convex).

  Steht schon eine Supabase-Adresse auf `….supabase.co` in der `.env`,
  zeigt der Assistent beim erneuten Einrichten „Supabase in der Cloud“ an,
  bei genau `http://127.0.0.1:54421` „Supabase auf diesem Rechner“, bei jeder
  anderen Adresse „Zugangsdaten selbst eintragen“. Zwischen den Wegen
  zieht der Assistent keine Daten um.

#### Supabase in der Cloud (Standard)

1. Auf [supabase.com](https://supabase.com) ein kostenloses Konto anlegen.
   Eine Organisation im kostenlosen Tarif (Free) entsteht dabei mit.
2. Unter [Account, Access Tokens](https://supabase.com/dashboard/account/tokens)
   „Generate new token“ wählen, einen Namen (etwa `tybo-einrichtung`) und ein
   Ablaufdatum setzen (ein Tag reicht), das Token kopieren. Es beginnt mit
   `sbp_`. Nach der Einrichtung darfst du es dort wieder löschen; tybo
   braucht es danach nicht mehr.
3. `tybo setup datenbank` starten (oder im Browser den Schritt Datenbank),
   „Supabase in der Cloud“ wählen und die Felder ausfüllen:

- **Supabase-Zugangstoken:** das Token aus Schritt 2. Es gilt nur für diesen
  Lauf: der Assistent speichert es nirgends, nicht in der `.env`, nicht in
  `data/`, nicht im Log, und zeigt es nie an. Im Browser liegt es nur im
  Speicher des laufenden Vorgangs. Die Prüfregel verlangt, dass es mit `sbp_`
  beginnt.
- **Supabase-Organisation:** der Assistent lädt die Organisationen zu deinem
  Token und bietet nur die im kostenlosen Tarif an, weil ein Projekt in einer
  bezahlten Organisation Geld kostet. Gibt es nur eine, ist sie
  vorausgewählt (Enter im Terminal).
- **Projektname bei Supabase:** Vorschlag `tybo`. Unter diesem Namen sucht der
  Assistent ein vorhandenes Projekt in der Organisation; gibt es keins, legt er
  es an.
- **Region:** Vorschlag „Frankfurt (eu-central-1)“. Die Regionen in der EU
  stehen oben (Frankfurt, Zürich, Irland, Paris, Stockholm, London), danach
  die übrigen.

Danach zeigt der Assistent unter „Das passiert jetzt:“ den Plan und fragt
„Jetzt ausführen? [J/n]“. Der Ablauf:

1. Zugangstoken prüfen.
2. Projekt suchen: zuerst das aus `SUPABASE_URL` der `.env`, sonst eines mit
   dem Projektnamen in der gewählten Organisation (ein gleichnamiges in einer
   anderen Organisation zählt nicht).
3. Fehlt es, legt er es an, mit einem zufälligen Datenbank-Passwort, das er
   weder anzeigt noch speichert (tybo braucht es nicht; zurücksetzen geht im
   Dashboard unter Project Settings, Database).
4. Warten, bis das Projekt bereit ist, meist ein bis drei Minuten, höchstens
   zehn. Die Zeile zeigt die verstrichene Zeit.
5. Tabellen einspielen: `db/schema.sql` und die Dateien aus `db/migrations/`,
   als Migrationen mit den Namen `tybo_<dateiname>`. Schon eingespielte
   überspringt er.
6. Den privaten Bilder-Ordner anlegen: `SUPABASE_ASSETS_BUCKET` aus der
   `.env`, sonst `tybo-assets`. Gibt es ihn schon und ist er öffentlich,
   bricht er mit einem Hinweis ab, statt ihn umzustellen.
7. Schlüssel holen: bevorzugt die neuen (`sb_secret_…`, `sb_publishable_…`).
   Hat das Projekt neue Schlüssel, aber keinen Secret key, legt er genau einen
   mit dem Namen `tybo` an. Ohne neue Schlüssel nimmt er die alten
   (`service_role`, `anon`).
8. In die `.env` schreiben: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `SUPABASE_ANON_KEY`, nur was abweicht. Andere Zeilen, auch eine alte
   `CONVEX_URL`, bleiben unberührt.
9. Verbindung testen: aus `messages` lesen, dann eine Testzeile in `memory`
   schreiben und über ihre id wieder löschen. So fällt ein fehlendes Recht
   gleich hier auf (siehe [Rechte der Tabellen](#rechte-der-tabellen)).

**Erneut ausführen.** Der Ablauf ist wiederholbar. Bricht er ab (Strg+C,
„Abbrechen“, Zeitlimit), bleibt die `.env` unverändert, ein schon angelegtes
Projekt bleibt bei Supabase. `tybo setup datenbank` mit derselben
Organisation und demselben Projektnamen findet es wieder, wartet, falls es
noch startet, und ergänzt nur, was fehlt; angelegt wird dann nichts neu.
Gibt es in der Organisation mehrere Projekte mit dem Namen oder ist das
Projekt aus der `.env` mit dem Token nicht erreichbar, bricht der Assistent
ab, statt ein weiteres anzulegen.

Meldungen des Ablaufs:

| Meldung | Was zu tun ist |
|---|---|
| „Supabase lehnt das Zugangstoken ab. …“ | Token abgelaufen, gelöscht oder falsch kopiert: ein neues erzeugen. |
| „Supabase legt kein weiteres Projekt an: Kostenlos gibt es zwei aktive Projekte pro Konto. …“ | Im Dashboard ein Projekt pausieren oder löschen, oder „Zugangsdaten selbst eintragen“ wählen und ein vorhandenes nutzen. |
| „Die Organisation ist nicht im kostenlosen Tarif; …“ | Eine kostenlose Organisation wählen. |
| „Das Projekt bei Supabase ist pausiert. …“ | Im Dashboard „Restore project“, dann erneut. |
| „Supabase meldet, dass das Projekt nicht starten konnte. …“ | Im Dashboard nachsehen, das Projekt dort löschen oder neu starten, dann erneut. |
| „Das Projekt ist angelegt, aber noch nicht bereit. …“ | Ein paar Minuten warten, dann `tybo setup datenbank` erneut. |
| „Supabase bremst gerade (zu viele Anfragen in kurzer Zeit). …“ | Eine Minute warten, dann erneut. Der Assistent wartet vorher selbst, wie lange Supabase es verlangt. |
| „Der Bilder-Ordner aus SUPABASE_ASSETS_BUCKET ist bei Supabase öffentlich. …“ | Im Dashboard unter Storage auf privat stellen oder einen anderen Namen eintragen. |
| „… Die Schreibprobe ist aber fehlgeschlagen: Supabase verweigert dem Schlüssel das Recht, … (permission denied …)“ | Siehe [Rechte der Tabellen](#rechte-der-tabellen). |

#### Supabase auf diesem Rechner

Supabase läuft dann in Docker auf deinem Rechner; Gespräche, Gedächtnis und
Bilder verlassen ihn nicht. Weitere Felder gibt es nicht, nur die Auswahl.

**Was du brauchst:**

- **Docker**, einer dieser Wege genügt. Auf dem Mac:
  [OrbStack](https://orbstack.dev) (braucht wenig Arbeitsspeicher),
  [Docker Desktop](https://docs.docker.com/desktop/) (für größere Firmen
  lizenzpflichtig) oder Colima (`brew install colima docker`, dann
  `colima start`). Unter Linux die
  [Docker Engine](https://docs.docker.com/engine/install/). Docker muss
  laufen, wenn du den Assistenten startest.
- **Die Supabase-CLI** brauchst du nicht selbst zu installieren: tybo ruft sie
  über Bun auf (`bunx --bun supabase@2.118.0`; `--bun` vor dem Paket, weil der
  Starter der CLI sonst Node verlangt). Beim ersten Mal lädt Bun sie
  (rund 130 MB, dafür braucht es Internet) und legt sie in seinen
  Zwischenspeicher; Node.js ist dafür nicht nötig.
- **Arbeitsspeicher:** 8 GB oder mehr. Mit weniger zeigt der Assistent einen
  Hinweis und macht trotzdem weiter. Bei Docker Desktop und Colima zählt der
  Speicher, den du der Docker-VM gibst.
- **Speicherplatz:** einige GB für die Docker-Images.

Der Assistent installiert nichts selbst. Fehlt etwas, erklärt er, was zu tun
ist; danach startest du die Einrichtung einfach noch einmal.

**Der Ablauf:**

1. Prüfen: Docker installiert und gestartet, die Supabase-CLI ladbar und neu
   genug, Arbeitsspeicher.
2. Das Docker-Netz `supabase_network_tybo` anlegen, das alle Ports nur an
   `127.0.0.1` bindet (siehe unten), dann Supabase starten, aus dem Ordner
   `supabase/` des Projekts. Dienste, die tybo nicht braucht (Studio,
   Realtime, Mailpit, Logs und andere), bleiben aus. Beim ersten Mal lädt
   Docker die Images, das dauert einige Minuten; die Zeile zeigt die
   verstrichene Zeit, nach 20 Minuten gibt der Assistent auf. Danach prüft
   er, dass Supabase nur auf diesem Rechner erreichbar ist.
3. Adresse und Schlüssel bei Supabase abfragen. Sie erscheinen nirgends in
   der Ausgabe.
4. Tabellen einspielen: `db/schema.sql` (nur in eine leere Datenbank) und
   die Dateien aus `db/migrations/`, über denselben gesperrten Ablauf
   wie bei `tybo datenbank start` (siehe Updates oben). Vor der ersten
   Datei prüft er die Bilder-Ordner. Bei vollständiger Historie läuft keine
   Datei erneut; bei einer Lücke folgt der ganze nötige Nachlauf. Dessen
   Verbuchung bleibt offen, bis alle schon verbuchten Folgedateien erneut
   erfolgreich gelaufen sind.
5. Den privaten Bilder-Ordner anlegen: `SUPABASE_ASSETS_BUCKET` aus der
   `.env`, sonst `tybo-assets`. Ist er schon da und öffentlich, bricht der
   Assistent ab, statt ihn umzustellen.
6. In die `.env` schreiben: `SUPABASE_URL=http://127.0.0.1:54421`,
   `SUPABASE_SERVICE_ROLE_KEY` und `SUPABASE_ANON_KEY`, nur was abweicht.
   Andere Zeilen, auch eine alte `CONVEX_URL`, bleiben unberührt.
7. Verbindung testen.

Der Ablauf ist wiederholbar: Läuft Supabase schon, geht der Start schnell und
ändert nichts, und die `.env` bleibt gleich. Ein Abbruch (Strg+C,
„Abbrechen“) lässt die `.env` unverändert. Scheitert der Start oder wird er
abgebrochen, sieht der Assistent nach, was schon läuft, und hält es an, wenn
es nicht sicher nur auf diesem Rechner erreichbar ist.

**Wo die Daten liegen:** nicht im Projektordner, sondern in Docker-Volumes
mit den Namen `supabase_<dienst>_tybo`. `git pull` und eine Neuinstallation
von tybo berühren sie nicht. `supabase stop` hält Supabase an und behält die
Daten; `supabase stop --no-backup` **löscht sie**. Die Einstellungen stehen in
`supabase/config.toml`, eigene Ports 54420 bis 54429, damit tybo neben
anderen Supabase-Projekten laufen kann.

**Nur auf diesem Rechner erreichbar.** Die lokalen Schlüssel und das
Datenbank-Passwort sind bei jeder lokalen Supabase gleich und allgemein
bekannt. Die Supabase-CLI gibt beim Veröffentlichen der Ports keine Adresse
an; Docker bindet sie dann an alle Netzwerkschnittstellen, bei Docker Desktop
also auch für andere Geräte im Heimnetz. Die Docker-Einstellung `"ip"`
(`daemon.json`) hilft dagegen nicht: sie gilt nur für das Standard-Netz
`bridge`, Supabase startet aber in einem eigenen Netz. Für eigene Netze zählt
die Netz-Option `com.docker.network.bridge.host_binding_ipv4`
([Docker-Doku](https://docs.docker.com/engine/network/port-publishing/#setting-the-default-bind-address-for-containers)).
Der Assistent legt darum das Netz `supabase_network_tybo`, das die CLI für
tybo nimmt, vor dem Start selbst mit dieser Option auf `127.0.0.1` an. Es
bleibt bei `supabase stop` bestehen, und jeder spätere Start nutzt es.

Nach dem Start prüft der Assistent die Portbindungen der Container
(`docker ps`) und probiert die Ports über die Adressen des Rechners im
Heimnetz. Ist etwas offen oder nicht prüfbar, hält er Supabase wieder an (die
Daten bleiben) und sieht nach, ob wirklich nichts mehr läuft. Nur dann meldet
er „wieder gestoppt“; sonst warnt er und nennt den Befehl zum Anhalten.
Selbst nachsehen:

```bash
docker network inspect supabase_network_tybo --format '{{json .Options}}'
# erwartet: {"com.docker.network.bridge.host_binding_ipv4":"127.0.0.1"}
docker ps --filter label=com.supabase.cli.project=tybo --format '{{.Names}}  {{.Ports}}'
# erwartet: nur 127.0.0.1:544xx->…, kein 0.0.0.0 und kein [::]
```

Gibt es das Netz schon ohne diese Option (etwa von einem früheren Start ohne
Assistent), startet der Assistent nichts, hält schon laufende Container
darin an und erklärt die Abhilfe: Supabase anhalten,
`docker network rm supabase_network_tybo` (meldet das „not found“, hat
`supabase stop` das Netz schon entfernt), Einrichtung erneut.

**Grenzen:**

- Kein Zugriff von einem VPS und nicht im Hybrid-Modus: die Adresse zeigt auf
  diesen Rechner.
- tybo hat seine Datenbank nur, solange dieser Rechner läuft und Docker
  gestartet ist. Nach einem Neustart startet der Autostart Supabase wieder
  (Schritt Autostart), von Hand `tybo datenbank start`. Mehr im nächsten Abschnitt.

Meldungen des Ablaufs:

| Meldung | Was zu tun ist |
|---|---|
| „Docker fehlt. …“ | Einen der Docker-Wege oben installieren, dann erneut. |
| „Docker läuft nicht: …“ | Docker Desktop bzw. OrbStack öffnen oder `colima start`, dann erneut. |
| „Die Supabase-CLI ließ sich nicht laden. …“ | Internetverbindung prüfen, dann erneut. |
| „Supabase startet nicht, weil ein Port im Bereich 54420 bis 54429 belegt ist: …“ | Mit `docker ps` nachsehen, was dort läuft, und es beenden. |
| „Supabase startet nicht, weil der Speicherplatz für die Docker-Images fehlt. …“ | Platz schaffen, dann erneut. |
| „Supabase ist nach 20 Minuten noch nicht gestartet. …“ | Erneut; schon geladene Teile bleiben. |
| „Supabase war nicht nur auf diesem Rechner erreichbar …“ | Netz und Bindungen wie oben nachsehen; fehlt die Option: Supabase anhalten, `docker network rm supabase_network_tybo`, dann erneut. |
| „Das Docker-Netz supabase_network_tybo gibt es schon, aber ohne Bindung an 127.0.0.1 …“ | Supabase anhalten, `docker network rm supabase_network_tybo`, dann erneut. |
| „Achtung: Supabase-Dienste laufen womöglich noch …“ | Das Anhalten ist gescheitert. Sofort von Hand anhalten, Befehl steht in der Meldung. |

Mehr unter „Lokales Supabase startet nicht“ in
[troubleshooting.md](troubleshooting.md).

Am Ende sagt der Assistent einmal, ob Docker beim Anmelden von selbst
startet: bei Docker Desktop liest er die Einstellung, bei OrbStack und Colima
nennt er nur den Weg, unter Linux fragt er systemd.

#### Supabase lokal im Alltag

Für jeden Tag gibt es den Befehl `tybo datenbank`. Er tut nur etwas, wenn
`SUPABASE_URL` in der `.env` genau auf `http://127.0.0.1:54421` zeigt; bei
Supabase in der Cloud sagt er das und ändert nichts.

| Befehl | Was er tut |
|---|---|
| `tybo datenbank start` | Startet Supabase mit derselben Dienstauswahl wie der Assistent. Wartet bis zu 5 Minuten auf Docker („Warte auf Docker“). Prüft vorher das Netz und danach, dass nichts aus dem Heimnetz erreichbar ist. Läuft schon alles, ändert er nichts. |
| `tybo datenbank start --studio` | Dasselbe mit Studio, um die Daten im Browser anzusehen: `http://127.0.0.1:54423`, ohne Anmeldung, nur auf diesem Rechner. Läuft Supabase schon ohne Studio, hält er es kurz an und startet es mit Studio neu (die Daten bleiben). Studio wieder aus: `tybo datenbank stop`, dann `tybo datenbank start`. |
| `tybo datenbank stop` | Hält Supabase an. Die Daten bleiben. |
| `tybo datenbank status` | Läuft es, Adresse, Platz der Docker-Volumes. Zeigt keine Schlüssel. |
| `tybo datenbank sichern` | Sicherung nach `data/backups/supabase-<JJJJMMTT-HHMM>/`. |
| `tybo datenbank sichern --ziel <Ordner>` | Sicherung nach `<Ordner>/supabase-<JJJJMMTT-HHMM>/`. |

**Nach einem Neustart des Rechners.** Zwei Dinge müssen von selbst starten:

1. **Docker.** Docker Desktop: Settings, General, „Start Docker Desktop when
   you sign in to your computer“ einschalten. OrbStack: Settings, „Start at
   login“. Colima: einmal `brew services start colima`. Linux: meist schon an,
   sonst `sudo systemctl enable docker`.
2. **Supabase.** Der Schritt Autostart (`tybo setup autostart`) richtet
   dafür einen eigenen Dienst ein: `ai.tybo.supabase` auf dem Mac,
   `tybo-supabase` unter PM2. Er ruft beim Anmelden einmal
   `tybo datenbank start` auf; die Container laufen in Docker weiter.
   Protokoll: `logs/supabase.log`. Auf dem Mac endet der Dienst danach. Unter
   PM2 bleibt `tybo-supabase` danach ohne Arbeit stehen (Status `online`, ein
   kleiner Bun-Prozess): PM2 startet beim Hochfahren nur, was beim letzten
   `pm2 save` lief, ein gestoppter Eintrag bliebe gestoppt. `online` heißt
   darum nicht, dass der Start gelang: das Ergebnis steht in
   `data/supabase-start.json`, `bun run setup:verify` wertet es aus. Wiederholt wird
   der Start nicht, auch nicht, wenn der Prozess endet. Mit
   `pm2 stop tybo-supabase` und danach `pm2 save` fällt er aus dem Autostart;
   `tybo setup autostart` trägt ihn wieder ein. Läuft gerade ein Start, kehrt
   `pm2 stop` erst zurück, wenn er sauber abgebrochen ist: halb gestartete
   Container werden geprüft und nötigenfalls angehalten. PM2 wartet darauf
   bis zu zehn Minuten (`--kill-timeout`), meist dauert es Sekunden. Auf dem
   Mac gilt dasselbe beim Entladen von `ai.tybo.supabase` (`launchctl unload`,
   `tybo deinstallieren`): launchd wartet bis zu zehn Minuten (`ExitTimeOut`).

Warum der Dienst nötig ist, obwohl Docker die meisten Container von selbst
neu startet: die Edge Runtime hat keine Neustart-Regel und fehlt nach einem
Neustart, und `supabase start` holt sie nicht nach, solange die Datenbank
läuft. `tybo datenbank start` erkennt das, hält Supabase kurz an und startet
es vollständig neu (im Versuch 23 Sekunden, die Daten bleiben).
`tybo datenbank status` zeigt „Edge Runtime fehlt“, wenn das noch aussteht.

**Sichern.** `tybo datenbank sichern` legt einen neuen Ordner an (Rechte
0700, nur für dich lesbar) mit vier Teilen und einem Inhaltsverzeichnis
`sicherung.txt`:

| Datei | Inhalt |
|---|---|
| `schema.sql` | Tabellen, Funktionen und Rechte von tybo |
| `daten.sql` | Inhalte der Tabellen von tybo (Schema `public`): Gespräche, Gedächtnis, Ziele, Einträge zu Bildern |
| `storage.sql` | Einträge des Bilder-Ordners in Supabase (`storage.buckets`, `storage.objects`) |
| `bilder.tar.gz` | die Bilddateien selbst, aus dem Docker-Volume `supabase_storage_tybo` |

Nicht dabei sind die übrigen Supabase-Schemas wie `auth` (Benutzerkonten von
Supabase, tybo nutzt sie nicht). Eine vorhandene Sicherung wird nie
überschrieben; zwei Sicherungen in derselben Minute bekommen
`supabase-<Zeit>-2`. Scheitert ein Teil oder brichst du mit Strg+C ab, löscht
der Befehl die unvollständige Sicherung und meldet es. Nur ein Ordner mit
`sicherung.txt` ist vollständig.

Die Sicherung läuft bei laufendem Bot. Die Reihenfolge ist fest: erst die
Tabellen von tybo, dann die Einträge der Bilder, zuletzt die Dateien. So
fehlt zu keinem gesicherten Eintrag die Datei; ein Bild, das während der
Sicherung dazukommt, liegt höchstens als Datei ohne Eintrag bei. Willst du
einen exakt ruhigen Stand, halte vorher den Bot an.

Auf die Docker-Volumes als Sicherung ist kein Verlass: Docker Desktop nimmt
seine Datenträger-Datei in der Regel von Time Machine aus. Lege die Sicherung
darum in einen Ordner, den Time Machine oder dein Sicherungsprogramm
erfasst, etwa `tybo datenbank sichern --ziel ~/Documents/tybo-sicherungen`.
Die Dateien enthalten alle Gespräche und das Gedächtnis; bewahre sie nur an
einem sicheren Ort auf.

**Wiederherstellen.** Das ist für einen neuen Rechner oder nach einem
Datenverlust gedacht, in eine **leere** Supabase. Ein zweiter Projektordner
auf demselben Rechner ist keine eigene Instanz: `project_id = "tybo"` in
`supabase/config.toml` heißt dieselben Docker-Volumes. Zum Ausprobieren also
einen anderen Rechner (oder eine eigene Docker-VM) nehmen.

1. tybo installieren. In die `.env` `SUPABASE_URL=http://127.0.0.1:54421`
   eintragen (oder die alte `.env` zurückkopieren).
2. Supabase leer starten: `tybo datenbank start`. Nicht vorher
   `tybo setup datenbank`: der Assistent legt den Bilder-Ordner an, und
   `storage.sql` würde dann an einem doppelten Eintrag scheitern.
3. Im Ordner der Sicherung die drei SQL-Teile in dieser Reihenfolge einspielen.
   `ON_ERROR_STOP=1` hält beim ersten Fehler an, statt halb weiterzumachen:
   ```bash
   cd ~/Documents/tybo-sicherungen/supabase-20260927-0805
   docker exec -i supabase_db_tybo psql -U postgres -v ON_ERROR_STOP=1 -q < schema.sql
   docker exec -i supabase_db_tybo psql -U postgres -v ON_ERROR_STOP=1 -q < daten.sql
   docker exec -i supabase_db_tybo psql -U postgres -v ON_ERROR_STOP=1 -q < storage.sql
   ```
   Meldet einer davon einen Fehler (etwa „duplicate key“), war die Datenbank
   nicht leer. Dann nicht weitermachen: Schritt 2 auf einer leeren
   Supabase wiederholen.
4. Die Bilddateien zurück in den Storage-Container kopieren und dem
   Container-Benutzer geben:
   ```bash
   mkdir /tmp/tybo-bilder
   tar -xzf bilder.tar.gz -C /tmp/tybo-bilder
   docker cp /tmp/tybo-bilder/. supabase_storage_tybo:/mnt/
   docker exec supabase_storage_tybo chown -R 0:0 /mnt
   rm -rf /tmp/tybo-bilder
   ```
5. `tybo setup datenbank` mit dem Weg „Supabase auf diesem Rechner“: der
   Assistent findet Tabellen und den privaten Bilder-Ordner vor, ändert daran
   nichts, schreibt die Schlüssel in die `.env` und testet die Verbindung.
6. Prüfen: `tybo datenbank status` zeigt „läuft“; im Chat nach etwas fragen,
   das tybo sich gemerkt hatte; ein altes Bild öffnen lassen.

**Updates.** Welche Supabase-CLI tybo nutzt, legt tybo selbst fest
(`SUPABASE_CLI_VERSION` in `src/setup/local-supabase.ts`, heute 2.118.0; sie
steht auch in jeder `sicherung.txt`). Die Versionen der Container hängen an
dieser CLI. Eine neue kommt also nur mit einem Update von tybo; tybo
aktualisiert weder die CLI noch die Container von selbst. Bei einem Update
von tybo, das die Version ändert:

1. `tybo datenbank sichern`
2. `tybo datenbank stop`
3. tybo aktualisieren (Installer erneut oder `git pull` und `bun install`)
4. `tybo datenbank start`: die neue CLI lädt beim ersten Start die neuen
   Images (einige Minuten); danach spielt der Befehl fehlende Migrationen
   ein
5. Prüfen wie oben unter Wiederherstellen, Schritt 6

**Nie** `supabase stop --no-backup` ohne frische Sicherung. Die offizielle
Anleitung von Supabase rät vor Updates dazu, weil dort die lokale Datenbank
eine Entwicklungskopie ist, die sich aus Migrationen neu aufbauen lässt. Bei
tybo ist sie die einzige Kopie von Gedächtnis und Verlauf; `--no-backup`
löscht die Docker-Volumes und damit alles.

**Ressourcen.** Gemessen mit der CLI 2.118.0 in einer Docker-VM mit 4 CPUs
und 6 GB, fast leere Datenbank:

| | ohne Studio | mit Studio |
|---|---|---|
| Container | 6 | 8 (dazu Studio und postgres-meta) |
| Arbeitsspeicher der Container | rund 540 MB | rund 950 MB |
| Docker-Images | 5,0 GB | 6,8 GB |
| Daten (Volumes) | rund 80 MB, wächst mit Verlauf und Bildern | gleich |

Dazu kommt der Speicher der Docker-VM selbst (Docker Desktop, OrbStack,
Colima). Studio nur bei Bedarf einschalten.

**Grenzen.**

- Kein VPS und kein Hybrid-Modus: die Datenbank liegt auf diesem Rechner.
- tybo hat sein Gedächtnis nur, solange dieser Rechner läuft und Docker und
  Supabase gestartet sind. Kommt eine Telegram-Nachricht, während Supabase
  steht (etwa in den ersten Minuten nach dem Anmelden), antwortet der Bot
  ohne Gedächtnis und ohne Verlauf, und das Gespräch landet dann nicht im
  Verlauf (tybo holt das nicht nach).
- Keine zeitgesteuerte Sicherung: `tybo datenbank sichern` rufst du selbst
  auf.

#### Rechte der Tabellen

Supabase gibt Tabellen im Schema `public` nicht mehr von selbst für den
Zugriff über die REST-Schnittstelle frei: neue Projekte seit dem 30.05.2026,
bestehende ab dem 30.10.2026. Ohne ausdrückliches `GRANT` antwortet Supabase
mit „permission denied“, auch für den Secret- bzw. `service_role`-Schlüssel.
Darum vergeben `db/schema.sql` und alle Dateien in `db/migrations/` ihre
Rechte selbst: die Rolle `service_role`, mit der tybo arbeitet, darf lesen und
schreiben und die Zähler (Sequenzen) für neue Zeilen nutzen, `anon` und
`authenticated` dürfen nichts. Bestehende Tabellen behalten ihre Rechte.

Meldet der Verbindungstest „Supabase verweigert dem Schlüssel das Recht, …
(permission denied …)“, fehlt ein Recht, meist auf einem Zähler wie
`memory_id_seq`. Abhilfe:

- **Supabase in der Cloud:** `tybo setup datenbank` erneut ausführen. Der
  Ablauf spielt die Migration `20261021_base_grants.sql` ein, falls sie noch
  fehlt. Ist sie schon eingespielt, wie im nächsten Punkt im SQL-Editor.
- **Zugangsdaten selbst eintragen oder eigener Server:** im Dashboard **SQL
  Editor**, neue Abfrage, den Inhalt von `db/migrations/20261021_base_grants.sql`
  einfügen und ausführen. Sie ändert nur Rechte, keine Zeilen, und lässt sich
  beliebig oft ausführen. Nicht `db/schema.sql` dafür neu einspielen: das setzt
  Policies und Suchfunktionen auf die Grundfassung zurück.

Bleibt die Meldung danach, ist der eingetragene Schlüssel nicht der Secret
key (`sb_secret_…`) bzw. `service_role`.


#### Schemaprobe

Die Schemaprobe (`src/lib/schema-probe.ts`) prüft, ob der Datenbank eine
Datei aus `db/` fehlt. Sie fragt über die REST-Schnittstelle mit dem
eingetragenen Schlüssel je Datei ein Merkmal ab und schreibt nichts:

- Spalten und Tabellen mit `select=<spalten>&limit=0`, also ohne Zeilen
- Funktionen über das Verzeichnis der Schnittstelle (`/rest/v1/`). PostgREST
  listet dort nur, was der Schlüssel ausführen darf. Fehlt eine Funktion,
  fragt die Probe sie darum einzeln mit GET `/rest/v1/rpc/<name>` ab (nur
  lesend, mit Werten, die nichts Nennenswertes ausführen). Fehlend ist sie
  nur, wenn PostgREST sie nicht kennt; ohne Ausführungsrecht heißt es
  „nicht prüfbar“.
- `20261021_base_grants.sql` legt nichts an und vergibt nur Rechte. Geprüft
  wird, ob der Server-Schlüssel die Grundtabellen lesen darf. Schreib- und
  Zählerrechte belegt das nicht; die lassen sich ohne Schreiben nicht prüfen.

`tybo pruefen` zeigt das Ergebnis in der Zeile „Schema“: „fail“ mit den
fehlenden Dateien und dem Befehl `tybo setup datenbank`, bei Netzfehlern,
Zeitüberschreitung, abgelehntem Schlüssel oder fehlenden Rechten nur eine
Warnung „nicht prüfbar“. Scheitert schon die Zeile „Verbindung“, steht
„Schema“ nur da, wenn die Probe etwas sicher vermisst (die Grundtabelle aus
`db/schema.sql` oder die Leserechte aus `20261021_base_grants.sql`).
Der Bot führt dieselbe Probe bei jedem Start aus.
Fehlt etwas, schickt er genau eine Meldung über den Meldeweg (Telegram und
WebUI) und schreibt sie ins Log. Ohne Telegram hält die WebUI die Meldung in
der Tabelle `messages` fest; fehlt gerade diese oder darf tybo dort nicht
schreiben, steht der Hinweis nur im Log (`logs/`) und in `tybo pruefen`.

Wer eine neue Migration anlegt, trägt sie in `SCHEMA_FILES`
(`src/setup/supabase-schema.ts`) und ihr Merkmal in `SCHEMA_MARKERS`
(`src/lib/schema-probe.ts`) ein; `tests/schema-probe.test.ts` scheitert sonst.

#### Zugangsdaten selbst eintragen

Bei **Supabase, Zugangsdaten selbst eintragen** fragt er:

- **Supabase-Adresse:** Project Settings, API: Project URL. Sie muss mit
  `https://` beginnen; `http://` geht nur für einen Server auf diesem Rechner
  (`127.0.0.1` oder `localhost`).
- **Supabase service_role- oder Secret-Schlüssel:** Project Settings, API
  Keys: der Secret key (`sb_secret_…`), bei älteren Projekten der
  `service_role`-Schlüssel. Der Bot braucht ihn zum Schreiben; der
  Publishable- bzw. anon-Schlüssel reicht nicht. Einen `sb_publishable_…` lehnt
  der Assistent in diesem Feld ab.
- **Supabase anon- oder Publishable-Schlüssel (optional):** Project
  Settings, API Keys: Publishable key (`sb_publishable_…`), bei älteren
  Projekten `anon public`. Wird nur als Rückfall gelesen.

#### Supabase vorbereiten

Nur für „Zugangsdaten selbst eintragen“; in der Cloud erledigt der Assistent
das selbst.

1. Auf [supabase.com](https://supabase.com) ein kostenloses Konto und ein
   neues Projekt anlegen.
2. Im Dashboard **SQL Editor**, neue Abfrage, den Inhalt von `db/schema.sql`
   aus dem Projektordner einfügen und ausführen. Das legt unter anderem die
   Tabelle `messages` an, die der Verbindungstest liest, und vergibt die
   nötigen Rechte ([Rechte der Tabellen](#rechte-der-tabellen)). Die Datei ist
   wiederholbar, vorhandene Tabellen bleiben.
3. Unter **Project Settings, API** die Project URL kopieren. Dann unter
   **Project Settings, API Keys** den Secret key kopieren; er beginnt mit
   `sb_secret_`. Neue Projekte haben schon einen (Name `default`) und nur
   noch diese Schlüsselart; fehlt er, dort einen neuen Secret key anlegen. Ältere Projekte haben
   zusätzlich den alten `service_role`-Schlüssel (Reiter „Legacy API Keys“),
   der geht weiterhin. Optional auch den Publishable key (`sb_publishable_…`)
   bzw. `anon public`. Beide Arten stehen in denselben Variablen:
   `SUPABASE_SERVICE_ROLE_KEY` und `SUPABASE_ANON_KEY`.
4. Optional für Bilder: **Storage**, neuer Bucket `tybo-assets`, privat. Ein
   anderer Name geht auch: Bucket privat anlegen und den Namen in `.env` als
   `SUPABASE_ASSETS_BUCKET` eintragen.

#### Umzug von Convex

Frühere Versionen konnten statt Supabase auch Convex nutzen. Das gibt es
nicht mehr: tybo liest `CONVEX_URL` nicht, und der Assistent bietet Convex
nicht mehr an. Steht `CONVEX_URL` noch in der `.env`, schreibt der Bot beim
Start einen Hinweis ins Log. Bis Supabase eingerichtet ist, speichert tybo
nur Fakten und Ziele, lokal in `memory.json`; den Verlauf aus Telegram
speichert es ohne Supabase nicht. Die Gespräche der WebUI liegen davon
unabhängig unter `data/web/`.

1. **Altbestand sichern**, am besten noch vor dem Update: im
   Convex-Dashboard unter Backups einen Export anlegen und herunterladen,
   oder im Ordner, in dem du Convex eingerichtet hast,
   `npx convex export --path convex-sicherung.zip`. Die ZIP-Datei enthält
   je Tabelle eine Datei mit allen Einträgen.
2. **Supabase einrichten:** `tybo setup datenbank`, einer der drei Wege oben.
   Die alten Convex-Zeilen in der `.env` stören dabei nicht; der Assistent
   fasst sie nicht an.
3. **Daten übernehmen, mit Grenzen:** Ein Umzugswerkzeug von Convex nach
   Supabase gibt es nicht; in Supabase beginnen Verlauf, Fakten, Ziele und
   Bilder neu. Das frühere `scripts/migrate-to-convex.ts` arbeitete in die
   Gegenrichtung (Supabase nach Convex) und ist entfernt. Wichtige Fakten
   und Ziele trägst du im Chat neu ein („Merk dir, dass …“), die Sicherung
   bleibt zum Nachschlagen. `tybo erinnerungen importieren` liest nur eine
   alte `config/reminders.json`, keine Convex-Daten; offene Erinnerungen
   aus Convex legst du neu an ([Erinnerungen](erinnerungen.md)).
4. **Aufräumen:** `CONVEX_URL`, `CONVEX_AUTH_TOKEN` und, falls vorhanden,
   `CONVEX_AUTH_ISSUER`, `CONVEX_AUTH_AUDIENCE` und
   `CONVEX_OWNER_TOKEN_IDENTIFIER` aus der `.env` löschen, dann tybo neu
   starten. Danach kommt der Hinweis nicht mehr. Das Deployment bei Convex
   kannst du im Dashboard löschen, sobald du die Sicherung nicht mehr
   brauchst.

Beispiele für die Werte stehen auch in `.env.example`.

### 5. Semantische Suche (optional)

tybo findet im Verlauf dann auch, was nur sinngemäß passt: Die Frage nach dem
„Urlaub am Meer“ findet die Nachricht über „Ferien an der Nordsee“. Dafür
erzeugen die Edge Functions von Supabase zu jeder Nachricht ein Embedding
(eine Zahlenreihe, die die Bedeutung beschreibt). Ohne diesen Schritt
speichert tybo Nachrichten ohne Embedding und sucht nur nach Text; alles
andere läuft genauso.

Der Schritt setzt eine eingerichtete Datenbank voraus (Schritt Datenbank).

Lange Nachrichten: Ein Embedding fasst höchstens die ersten 8.000 Zeichen
einer Nachricht. Längere Nachrichten (in der WebUI bis 200.000 Zeichen) teilt
tybo zusätzlich in Abschnitte von rund 6.000 Zeichen, die sich um rund 500
Zeichen überlappen und möglichst an Absatz- oder Satzgrenzen enden. Jeder
Abschnitt bekommt ein eigenes Embedding (Tabelle `message_chunks`, Migration
`20261015_message_chunks.sql`), die Suche durchsucht Nachrichten und
Abschnitte. Eine Nachricht erscheint dabei nur einmal, mit der besten
Ähnlichkeit, und als Inhalt kommt nur ein Ausschnitt um die Suchbegriffe,
nie der ganze Text. Für Abschnitte gilt eine etwas niedrigere Schwelle (0,35
statt 0,5), weil ein Thema in 6.000 Zeichen oft nur einen Teil ausmacht;
eine Frage findet ihn, wenn sie das Thema ähnlich beschreibt, einzelne
Stichwörter allein reichen oft nicht. Die Abschnitte entstehen beim Speichern in
`store-telegram-message`; was dabei nicht klappt, rechnet der Bot beim Start
und alle zehn Minuten nach. Für ältere lange Nachrichten einmal
`tybo suche abschnitte` ausführen, `tybo suche status` zeigt den Stand.

- **Anbieter der Embeddings:** wer die Embeddings rechnet. Zur Wahl:
  - OpenAI (Standard): text-embedding-3-small, kostet Cent-Beträge (0,02 US-Dollar pro Million Tokens), braucht einen OpenAI-Schlüssel
    (Guthaben auf [platform.openai.com](https://platform.openai.com); eine
    Nachricht hat meist unter hundert Tokens, auch viele tausend Nachrichten
    im Monat bleiben bei wenigen Cent).
  - Google Gemini: gemini-embedding-2, im kostenlosen Kontingent gratis, braucht einen Gemini-Schlüssel
    (aus [Google AI Studio](https://aistudio.google.com/apikey)). Das
    Kontingent hat Grenzen pro Minute und Tag; im kostenlosen Kontingent darf
    Google Eingaben laut seinen Bedingungen zur Verbesserung seiner Produkte
    verwenden. tybo verlangt 1536 Werte (`outputDimensionality`, siehe
    [Embeddings](https://ai.google.dev/gemini-api/docs/embeddings)).
  - Ollama: bge-m3 auf diesem Rechner, kostenlos, braucht laufendes Ollama und Supabase auf diesem Rechner.
    [bge-m3](https://ollama.com/library/bge-m3) ist mehrsprachig und rechnet
    gut mit deutschen Texten (etwa 1,2 GB, 1024 Werte, die tybo mit Nullen
    auf 1536 auffüllt; die Ähnlichkeit zweier Texte ändert sich dadurch
    nicht). Die Texte verlassen für die Suche den Rechner nicht; für die
    Antworten von tybo gilt das nicht, die schreibt weiter Claude. Mit
    Supabase in der Cloud geht Ollama nicht: die Functions dort erreichen
    deinen Rechner nicht, der Assistent lehnt das ab.

  Die Datenbank merkt sich Anbieter und Modell beim ersten gelungenen Embedding (Tabelle
  `embedding_settings`). Passt die Einstellung später nicht mehr dazu, entsteht
  kein Embedding mehr und tybo sucht nur nach Text, bis es wieder passt; beim
  Start steht dann eine Warnung im Log, und die Gesamtprüfung meldet es.
  Datenbanken aus der Zeit vor der Anbieterwahl, die schon Embeddings haben,
  laufen weiter mit OpenAI (text-embedding-3-small); ihre alten Werte
  bekommen keine nachträgliche Kennung. Ein Wechsel (anderer Anbieter oder
  anderes Modell) rechnet alles neu, nur nach Rückfrage, siehe „Anbieter
  wechseln“ unten.
- **OpenAI-Schlüssel für die semantische Suche:** nur bei OpenAI. Beginnt mit
  `sk-`, unter
  [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
  erzeugen. Das Feld gilt nur für diesen Lauf. Gespeichert wird der Schlüssel
  als `OPENAI_API_KEY` dort, wo die Functions ihn lesen (Supabase-Geheimnis
  bzw. `supabase/functions/.env`), und in der `.env`, weil tybo ihn auch
  selbst braucht (Embeddings für Fakten und Bilder). Leer lassen heißt: nur
  Textsuche, nachholen mit `tybo setup suche`. Steht schon ein Schlüssel in
  der `.env`, nimmt der Assistent diesen.
- **Gemini-Schlüssel für die semantische Suche:** nur bei Gemini. Wie der
  OpenAI-Schlüssel, gespeichert als `GEMINI_API_KEY` (denselben Namen nutzt
  auch die Spracherkennung).
- **Adresse von Ollama:** nur bei Ollama, Vorschlag `http://localhost:11434`.
  Die Functions laufen in Docker und bekommen dieselbe Adresse mit
  `host.docker.internal` statt `localhost`.
- **Fehlt das Ollama-Modell: jetzt mit ollama pull herunterladen?:** nur bei
  Ollama. Ja: fehlt das Modell, lädt der Assistent es über Ollama herunter
  (wie `ollama pull bge-m3`). Nein: er bricht in dem Fall ab und nennt den
  Befehl.
- **Supabase-Zugangstoken (für die Functions):** nur bei Supabase in der
  Cloud, dasselbe Token (`sbp_…`) wie im Schritt Datenbank. Es gilt nur für
  diesen Lauf und wird nirgends gespeichert.
- **Neuberechnung beim Anbieterwechsel:** nur bei Supabase in der Cloud und
  auf diesem Rechner. Der Assistent liest die Kennung der Datenbank. Ohne
  Wechsel gibt es nur „Weiter“. Bei einem Wechsel stehen zur Wahl
  „Abbrechen, nichts ändern“ und „Alles neu berechnen“ mit Umfang, Dauer und
  Kosten (siehe „Anbieter wechseln“ unten). Das Feld gilt nur für diesen Lauf.

Ein anderes Modell als den Standard des Anbieters stellt man ohne Assistent
über `EMBEDDING_MODEL` in der `.env` ein (und gleich bei den Functions); der
Assistent übernimmt es dann. Liefert ein Modell mehr als 1536 Werte, lehnt
tybo es ab.

Was der Assistent tut, je nach Weg der Datenbank:

- **Supabase in der Cloud:** Über die Management-API von Supabase liefert er
  die drei Edge Functions `store-telegram-message`, `search-memory` und
  `embed-knowledge` aus
  ([Deploy a function](https://supabase.com/docs/reference/api/v1-deploy-a-function))
  und setzt das Geheimnis `OPENAI_API_KEY`, bei Gemini `GEMINI_API_KEY` samt
  `EMBEDDING_PROVIDER` und `EMBEDDING_MODEL`
  ([Secrets](https://supabase.com/docs/guides/functions/secrets)). Kein
  Programm muss dafür installiert werden. Ist das Geheimnis bei Supabase schon
  gesetzt (etwa von einem anderen Rechner), reicht das Zugangstoken: der
  Assistent liefert die Functions aus und prüft, ohne den Schlüssel zu kennen.
- **Supabase auf diesem Rechner:** Die Functions laufen schon in der Edge
  Runtime von Supabase. Der Assistent trägt den Schlüssel (bei Gemini und
  Ollama auch `EMBEDDING_PROVIDER` und `EMBEDDING_MODEL`, bei Ollama die
  Adresse mit `host.docker.internal`) in `supabase/functions/.env` ein (Rechte
  0600, nicht im Repo, andere Einträge bleiben) und startet Supabase einmal
  neu, damit die Edge Runtime die Werte liest.
  Die Daten bleiben; nach dem Start prüft er wie bei `tybo datenbank start`,
  dass Supabase nur auf diesem Rechner erreichbar ist.
- **Zugangsdaten selbst eingetragen:** An einem eigenen Server ändert der
  Assistent nichts und richtet dort nur OpenAI ein (die Umgebung der
  Functions kennt er nicht). Er schreibt nur `OPENAI_API_KEY` in die `.env` und prüft.
  Functions und Geheimnis richtest du dort selbst ein: für jede der drei
  Functions `supabase functions deploy <name> --no-verify-jwt`, dann
  `supabase secrets set OPENAI_API_KEY=…`.

Am Ende steht ein Test: Der Assistent speichert eine Probe-Nachricht über
`store-telegram-message` (in einem eigenen Probe-Chat, nie in deinem
Verlauf), sucht sie über `search-memory` nach Bedeutung und löscht sie wieder,
auch wenn der Test scheitert oder abgebrochen wird. „Semantische Suche:
aktiv“ steht erst, wenn genau diese Probe mit einer Ähnlichkeit größer 0
gefunden wurde. Das Ergebnis (ohne Schlüssel) merkt sich tybo in
`data/semantic-search.json`; die Übersicht und der Reiter „Status“ in den
Einstellungen der WebUI zeigen „aktiv“ oder „nur Textsuche“, und die
Gesamtprüfung (`tybo setup pruefung`) wiederholt den Test.

#### Anbieter wechseln

Vektoren verschiedener Anbieter oder Modelle sind nicht vergleichbar. Wählt
man in `tybo setup suche` einen anderen Anbieter (oder steht in der `.env` ein
anderes `EMBEDDING_MODEL`) als die Datenbank festhält, erkennt der Assistent
den Wechsel und fragt bei „Neuberechnung beim Anbieterwechsel“:

- „Abbrechen, nichts ändern“: keine Functions, keine Geheimnisse, keine
  Änderung an `.env` und Datenbank. Ohne Antwort gilt dasselbe.
- „Alles neu berechnen“ mit einer Schätzung, etwa „ca. 1.250 Einträge
  (Verlauf 1.200, Erinnerungen 40, Wissen 10), etwa 125.000 Tokens; Dauer etwa
  13 Minuten; Kosten: etwa 0,02 US-Dollar“. Gerechnet wird so: Tokens sind
  Zeichen durch vier; Dauer ist die Zahl der Einträge mal der üblichen Zeit
  je Anfrage (OpenAI 0,3 s, Gemini 0,4 s, Ollama 0,5 s) plus sechs Minuten
  Wartezeit; Kosten nach Preisliste (OpenAI text-embedding-3-small 0,02,
  text-embedding-3-large 0,13 US-Dollar je Million Tokens; Gemini im
  kostenlosen Kontingent keine; Ollama keine; unbekannte Modelle: „unbekannt“).

Mit Zustimmung beginnt der Assistent zuerst die Umstellung in der Datenbank
(sie hält den Lauf für ihn fest). Rechnet gerade ein anderer Prozess auf ein
anderes Ziel, bricht er hier ab, ohne Functions, Geheimnisse oder `.env`
anzufassen. Sonst richtet er alles wie sonst ein und startet
`tybo suche neu-berechnen` im Hintergrund (Ausgabe in
`logs/embedding-reindex.log`), der den Lauf übernimmt. Scheitert die
Einrichtung, gibt er den Lauf wieder frei. Neu berechnet werden Verlauf (`messages`),
Erinnerungen (`memory`, nur Fakten), Wissen (`knowledge`) und Bilder
(`assets`), auch Einträge, die bisher kein Embedding hatten. Anzeige-Meldungen
(Pipeline, Briefing, Dateien) bekommen keins. Die Abschnitte langer
Nachrichten rechnet sie direkt nach dem Umschalten neu; bis dahin übergeht
die Suche die alten Abschnitte, und was offen bleibt, rechnet der Bot nach.

Während der Umstellung:

- sucht tybo nur nach Text. Die Datenbank prüft das selbst: jeder Eintrag
  trägt, womit sein Vektor entstand (Spalte `embedding_model`), und die Suche
  (auch das Ranking der Fakten im Bot) nennt, womit der Suchvektor entstand.
  Während der Umstellung vergleicht die Datenbank gar nichts, danach nur
  gleiche Modelle. Das gilt auch für einen Prozess, der sich die alte
  Freigabe noch merkt, und für eine Anfrage, die vor dem Beginn losging.
- Was in dieser Zeit neu gespeichert oder geändert wird, speichert die
  Datenbank ohne Vektor und merkt es vor; die Neuberechnung zieht es am Ende
  nach. Kommt ein alter Vektor erst nach dem Umschalten an, übernimmt die
  Datenbank ihn nicht: bei unverändertem Text bleibt der neue Vektor, bei
  neuem oder geändertem Text merkt sie den Eintrag vor, und der Bot rechnet
  ihn nach. Ändert sich ein vorgemerkter Eintrag, während nachgerechnet wird,
  verwirft sie das Ergebnis und rechnet aus dem neuen Text.
- Vektoren und Suchen ohne Angabe, womit sie entstanden (Functions und Bot
  von vor dieser Fassung), gelten nur, solange die Datenbank nie umgeschaltet
  hat. Nach dem ersten Wechsel nimmt sie keine mehr an, auch nicht bei einem
  Wechsel zurück zu OpenAI.
- Die ersten sechs Minuten wartet die Neuberechnung, bevor sie neue Vektoren
  schreibt.
- Stapel zu 50 Einträgen; der Fortschritt steht nach jedem Stapel in der
  Datenbank. Bei „zu viele Anfragen“ (HTTP 429) wartet sie, so lange der
  Anbieter sagt (sonst 10 Sekunden, dann länger), und wiederholt denselben
  Eintrag.
- Lehnt der Anbieter einzelne Texte ab (etwa zu lang, HTTP 400), bleiben sie
  vorgemerkt: die Neuberechnung meldet „nicht fertig“ und schaltet nicht um.
  `tybo suche neu-berechnen` versucht sie erneut. Drei Ablehnungen
  hintereinander brechen sofort ab (eher Schlüssel oder Modell falsch).
- Bricht sie ab (Strg+C, Neustart des Rechners, Fehler), bleibt es bei der
  Textsuche und die Kennung beim alten Anbieter. `tybo suche neu-berechnen`
  setzt beim nächsten Stapel fort; `tybo suche status` zeigt den Stand. Es
  rechnet immer nur ein Prozess; er verlängert seine Frist alle 30 Sekunden,
  auch mitten in einem langsamen Stapel. Ein abgestürzter gibt den Lauf nach
  zwei Minuten frei.

Am Ende schaltet die Datenbank auf den neuen Anbieter um, der Assistent prüft
die Suche mit einer Probe-Nachricht, und eine Meldung erscheint in Telegram und
in der WebUI (nur zur Anzeige). Der laufende Bot nutzt die neue `.env` erst
nach einem Neustart: in der WebUI „Neustart anfordern“. Automatisch neu
gestartet wird nicht. Bei selbst eingetragenem Supabase stellt der Assistent
nicht um.

Gut zu wissen:

- Ohne Wechsel bekommt alter Verlauf keine Embeddings nachträglich. Nach
  Bedeutung findet tybo, was ab jetzt gespeichert wird.
- Die Wissensbasis (`embed-knowledge`) bekommt ebenfalls Embeddings, gesucht
  wird darin aber weiter nach Text. Nach Bedeutung sucht tybo im Verlauf.
- Den neuen Schlüssel in der `.env` liest ein laufender Bot erst nach einem
  Neustart.
- Konnte die Probe nicht gelöscht werden, sagt der Assistent das. Der nächste
  Lauf von `tybo setup suche` räumt übrig gebliebene Proben selbst weg.

Typische Meldungen:

| Meldung | Was tun |
|---|---|
| „OpenAI lehnt den Schlüssel ab. …“ | Unter platform.openai.com/api-keys einen neuen Schlüssel erzeugen. |
| „OpenAI nimmt gerade nichts an: Guthaben aufgebraucht …“ | Guthaben bei OpenAI aufladen, dann `tybo setup suche`. |
| „Die Edge Function … fehlt …“ | Cloud: `tybo setup suche` erneut. Auf diesem Rechner: `tybo datenbank start`, dann erneut. |
| „Die Probe wurde nur per Textsuche gefunden …“ | Der Rest der Meldung nennt den Grund: fehlender Schlüssel (`tybo setup suche` mit Schlüssel erneut), Anbieter nicht erreichbar (bei Ollama: läuft es, ist es aus Docker erreichbar?) oder Anbieter passt nicht zur Datenbank. |
| „Die Datenbank ist auf … festgelegt, eingestellt ist …“ | `EMBEDDING_PROVIDER` und `EMBEDDING_MODEL` in der `.env` wieder auf den genannten Anbieter stellen, oder `tybo setup suche` und „Alles neu berechnen“ wählen. |
| „Die Datenbank enthält Vektoren ohne Anbieterkennung …“ | Mit OpenAI (text-embedding-3-small) geht es weiter wie bisher; für einen anderen Anbieter `tybo setup suche` und „Alles neu berechnen“. |
| „Die Embeddings der Datenbank werden gerade auf … neu berechnet …“ | Nichts tun, bis die Meldung „Neuberechnung … fertig“ kommt. Steht sie still: `tybo suche status`, dann `tybo suche neu-berechnen`. |
| „Semantische Suche: Neuberechnung nicht fertig. …“ | Der Rest der Meldung nennt den Grund (etwa Schlüssel abgelehnt oder einzelne Einträge abgelehnt). Beheben, dann `tybo suche neu-berechnen`; es geht beim letzten Stapel weiter, abgelehnte Einträge werden erneut versucht. |
| „Der Datenbank fehlt die Tabelle embedding_settings …“ | `tybo setup datenbank` spielt die fehlende Migration ein, dann erneut. |
| „Der Datenbank fehlt die Migration 20261015_message_chunks.sql …“ | `tybo setup datenbank` spielt sie ein, dann `tybo suche abschnitte`. |
| „Abschnitte langer Nachrichten: … offen …“ | `tybo suche abschnitte` rechnet sie nach (der Bot macht das sonst nach und nach selbst). |
| „Das Modell bge-m3 fehlt in Ollama. …“ | `ollama pull bge-m3` im Terminal, oder die Frage nach dem Herunterladen mit ja beantworten. |
| „Ollama läuft nicht unter …“ | Ollama starten ([ollama.com/download](https://ollama.com/download)), dann erneut. |

### 6. Profil

Wer du bist und wo du lebst, damit Antworten und Zeiten passen.

- **Dein Name:** So spricht dich der Bot an.
- **Zeitzone:** IANA-Name wie `Europe/Berlin` oder `America/New_York`.
- **Beruf (optional):** steht nur in `config/profile.md`.

Name und Zeitzone kommen in die `.env` (`USER_NAME`, `USER_TIMEZONE`), dazu
entsteht `config/profile.md`. Gibt es die Datei schon, passt der Assistent nur
Überschrift, Zeitzone und Beruf an und legt vorher eine Sicherung an. Mehr
über dich (Arbeitsstil, Vorlieben) trägst du später selbst in
`config/profile.md` ein.

### 7. Modelle und Fallback (optional)

Welcher Motor und welches Claude-Modell antworten und was einspringt, wenn
der Motor nicht erreichbar ist. Leer lassen heißt jeweils: Standard aus dem
Code.

- **Motor (optional):** wer die Antworten schreibt: Claude Code (Standard),
  Codex, OpenCode oder Anthropic API (Motor `api`, braucht
  `ANTHROPIC_API_KEY`). Ohne Claude-Konto etwa Codex, vorher installieren und
  mit `codex login` anmelden. Was dann fehlt: [Server und Codex](server.md).
- **Standardmodell (optional):** Claude-Modell für alle Agenten ohne eigene
  Einstellung.
- **Standard-Effort (optional):** wie gründlich Claude nachdenkt (low,
  medium, high, xhigh).
- **OpenRouter-Schlüssel (optional):** Cloud-Fallback, Schlüssel von
  [openrouter.ai/keys](https://openrouter.ai/keys).
- **OpenRouter-Modell (optional):** etwa `anbieter/modell`.
- **Ollama-Modell (optional):** lokales Modell als letzter Rückfall, vorher
  mit `ollama pull <modell>` laden.
- **Nur lokal zurückfallen:** Ja heißt: OpenRouter nie nutzen, nur Ollama.

Modell, Effort und Fallback-Modelle landen in `config/settings.json` (dieselbe
Datei wie die Einstellungen der WebUI), nur der OpenRouter-Schlüssel in der
`.env`. Der Test prüft den OpenRouter-Schlüssel und ob Ollama läuft und das
Modell geladen ist.

Der Motor landet als `engine.default` in `config/settings.json` und gilt
vor `TYBO_ENGINE` aus der `.env`. Ist ein anderer Motor als Claude Code
gewählt, prüft der Test, ob er installiert und angemeldet ist. Ändern geht
auch später in der WebUI unter Einstellungen, Reiter Modelle, Abschnitt Motor, oder je
Gespräch mit `/motor claude`, `/motor codex`, `/motor opencode` oder
`/motor api`. Das wählt einen Motor, kein Modell; `/motor standard` hebt die
Gesprächswahl auf. Ersatzstufen richtet man anschließend im selben Abschnitt
„Motor“ ein. `/motor auto an` und `/motor auto aus` steuern den Wechsel an
der Schwelle, `/motor pruefen` misst und bewertet Sperren neu,
`/motor werkzeuge` zeigt Bestand und Lücken. Nach den Motorstufen bleiben
Ersatzmodelle mit eingeschränktem Werkzeugumfang. Mehr:
[Ersatzstufen und Automatik](erweiterungen.md#ersatzstufen-und-automatik).

### 8. Sprache (optional)

Empfohlen ist der private Weg: Hören mit Parakeet, Vorlesen mit Pocket TTS
und der deutschen Stimme „Jürgen“ (Kyutai, CC-BY-4.0). Beides läuft auf
deinem Rechner, Aufnahme und Text gehen an keinen Sprachdienst, und es kostet
nichts pro Minute. ElevenLabs (Stimme und Erkenner Scribe) ist die optionale
Cloud-Variante mit Kosten je Zeichen bzw. Minute.

Lokales Hören für den Sprechmodus (`tybo setup sprache`): Parakeet TDT 0.6B v3
von NVIDIA (Lizenz CC-BY-4.0) erkennt Sprache auf diesem Rechner, über
sherpa-onnx, ohne Python und ohne Cloud-Schlüssel. Läuft auf einem Mac mit
Apple Silicon, unter Linux x64 und Linux arm64 (etwa Raspberry Pi 5). Auf
einem Intel-Mac, unter Windows und 32-Bit-Linux lädt der Schritt nichts und
nennt whisper.cpp oder Spracherkennung in der Cloud als Alternative.

- **Weg für den Sprechmodus:**
  - „Sprechmodus lokal (empfohlen): Parakeet hört auf diesem Rechner, ohne Cloud-Schlüssel“
    (unten beschrieben).
  - „Telefonhörer: flüssiges Gespräch mit kurzen Antworten (setzt den Sprechmodus lokal voraus)“
    (Abschnitt „Weg Telefonhörer“ am Ende dieses Schritts).
- **Hören fest auf Parakeet stellen (statt auto)?** Nur, wenn Hören auf
  `auto` steht. Mit auto geht eine Aufnahme, die Parakeet nicht versteht oder
  in der es nichts hört, an ElevenLabs oder Gemini weiter, falls
  eingerichtet. Ja (Standard): nur noch Parakeet.
- **Hören von einem anderen Anbieter auf Parakeet umstellen?** Nur, wenn
  Hören fest auf einen anderen Anbieter eingestellt ist.

Zuerst zeigt der Schritt eine Bestandsaufnahme: Plattform, Arbeitsspeicher,
freier Platz, vorhandenes whisper.cpp, ffmpeg und ein schon eingerichtetes
Parakeet. Unter „Das passiert jetzt:“ stehen Download und Platz getrennt:
Download ca. 506 MB auf dem Mac (Modell 487 MB, Laufzeit 18 bis 28 MB je
Plattform, VAD 0,6 MB), auf der Platte danach ca. 733 bis 750 MB, beim
Erkennen ca. 2 GB Arbeitsspeicher. Während des Entpackens braucht es kurz
Archive plus entpackte Dateien; reicht der Platz nicht, lädt der Schritt
nichts und nennt die fehlende Menge. Unter 4 GiB Arbeitsspeicher (etwa ein
Pi 5 mit 2 GB) steht ein deutlicher Hinweis mit vorhandenen Alternativen.

Geladen wird erst nach „Jetzt ausführen?“, mit Fortschritt, in Teildateien
(`.part`) unter `models/speech/`. Reißt das Netz ab, setzt der Download bis zu
dreimal fort. Jede Datei wird gegen ihre SHA-256-Prüfsumme geprüft, erst dann
entpackt und als Ganzes an ihren Platz gelegt. Abbrechen (Strg+C, im Browser
„Abbrechen“) löscht alle halben Dateien; ein neuer Lauf beginnt von vorn.

Danach eine Probe: eine kurze deutsche Aufnahme (`setup/assets/`) muss mit
höchstens 20 % Wortfehlern erkannt werden, zwei Sekunden Stille dürfen keinen
Text ergeben. Erst dann schreibt der Schritt den Nachweis
`models/speech/parakeet.ok.json` und stellt Hören in `config/settings.json`
fest auf Parakeet (`speech.stt`, alle anderen Einstellungen bleiben). Ändert
sich später eine der Dateien, gilt Parakeet wieder als nicht eingerichtet,
bis `tybo setup sprache` die Probe wiederholt. Der Bot nutzt Parakeet ab der
nächsten Aufnahme, ohne Neustart. Ein zweiter Lauf lädt nichts neu: Mit
gültigem Nachweis bleibt alles, wie es ist, sind nur die Dateien da, läuft nur
die Probe. Entfernen: `tybo deinstallieren` fragt, ob `models/speech/`
gelöscht werden soll; andere Modelle unter `models/` bleiben.

Danach folgt der Teil **Stimme**: womit der Sprechmodus vorliest. Im Browser
ist die Stimme vorausgewählt, die schon eingestellt ist; im Terminal übernimmt
Enter „Beibehalten“. Bloßes Bestätigen ändert also nichts, auch nicht eine
Einstellung, die hier nicht zur Wahl steht (Qwen3-TTS, Gemini).

- **Stimme fürs Vorlesen:**
  - „Beibehalten (die bisherige Einstellung bleibt unverändert)“: schreibt
    nichts und installiert nichts.
  - „Browser-Stimme (ohne Installation, klingt je nach Gerät anders)“: braucht
    nichts; ohne Wahl liest der Sprechmodus damit vor.
  - „Lokale Stimme Jürgen, empfohlen: privat, alles auf deinem Rechner (Pocket TTS, Download ca. 170 bis 250 MB Laufzeit plus ca. 220 MB Modell, CC-BY-4.0 Kyutai)“:
    Kyutai Pocket TTS 3.3.0 mit dem deutschen Modell und der Stimme
    „juergen“, in einer eigenen Python-Umgebung unter `models/speech/pocket/`.
    Braucht `python3` 3.10 bis 3.14 und einen Mac mit Apple Silicon oder Linux
    x64 bzw. arm64. Auf Linux kommt PyTorch aus dem CPU-Index, sonst lüde pip
    rund 3 GB CUDA-Pakete.
  - „Piper für schwache Rechner (Download ca. 60 MB Laufzeit plus ca. 63 MB Stimme, GPL-3.0, Stimme Thorsten CC0)“:
    Piper 1.8.0 mit `de_DE-thorsten-medium` unter `models/speech/piper/`, als
    eigener Prozess je Satz.
  - „ElevenLabs, optional (mit vorhandenem Schlüssel und ELEVENLABS_VOICE_ID; Cloud: Text geht an ElevenLabs, kostet Guthaben je Zeichen)“:
    nur wählbar, wenn beide Werte in der `.env` stehen (WebUI: Einstellungen,
    Schlüssel). Nichts wird installiert. Jeder vorzulesende Satz geht als
    Text an ElevenLabs und kostet Guthaben deines ElevenLabs-Kontos.
- **Falls Pocket TTS hier langsamer als Echtzeit ist: stattdessen Piper einrichten?**
  Nur bei der lokalen Stimme. Standard ist Nein.

Bei der lokalen Stimme nennt der Plan Download und Platz (auf der Platte danach
rund 1,2 GB, während der Installation kurz rund 1,6 GB frei). Geladen wird erst
nach „Jetzt ausführen?“: zuerst die Python-Umgebung mit `pocket-tts` (das
dauert einige Minuten), dann das Modell. Abbrechen oder ein Fehler bei pip
löscht die halbe Python-Umgebung; der nächste Lauf nimmt schon geladene Pakete
aus dem pip-Cache. Ein halber Modell-Download bleibt liegen und wird beim
nächsten Lauf fortgesetzt: Vollständig ist das Modell erst mit
`models/speech/pocket/model.ok`.

Danach eine Probe ohne Netz, so wie der Bot die Stimme später startet: Laden
des Modells (Zeit getrennt gemessen), dann ein Satz. Der Echtzeitfaktor RTF ist
die Rechenzeit geteilt durch die Dauer des erzeugten Tons; unter 1 ist
schneller als Echtzeit. Erst nach bestandener Probe schreibt der Schritt den
Nachweis `models/speech/pocket.ok.json` und die Probe zum Anhören
`models/speech/pocket-probe.wav` und stellt das Vorlesen in
`config/settings.json` auf die lokale Stimme (`speech.tts`), ohne Neustart. Im
Terminal stehen danach der Befehl zum Abspielen und
`bun run notify --source datei --file models/speech/pocket-probe.wav` zum
Schicken ans Handy; im Browser lässt sich die Probe direkt unter dem Ergebnis
anhören.

Ist Pocket langsamer als Echtzeit (etwa auf einem Raspberry Pi), bleibt das
Vorlesen unverändert, und das Ergebnis schlägt Piper vor. Mit Ja bei der
Piper-Frage richtet der Lauf Piper gleich ein, prüft es und stellt darauf um.
Die Namensnennung (Kyutai Pocket TTS, CC-BY-4.0, bzw. Piper GPL-3.0 mit
Thorsten CC0) steht im Plan und im Ergebnis. Mehr zum Sprechmodus, mit
Wartezeiten und Datenschutz: [sprechen.md](sprechen.md).

Zum Schluss der Teil **Eigene Stimme** (optional, Issue #253): eine
Klon-Engine, damit tybo im Sprechmodus mit der eigenen Stimme vorliest. Die
Stimme selbst nimmst du danach in der WebUI auf (Einstellungen, Sprechen,
Eigene Stimme), mit Einwilligung; nie für Telegram oder Telefonate.

- **Eigene Stimme klonen (optional)?**
  - „Nein, keine eigene Stimme einrichten“: Standard, nichts passiert.
  - „Pocket TTS mit Stimmenklonen (Kyutai, ca. 219 MB, braucht Hugging-Face-Konto und Zustimmung zu Kyutais Bedingungen)“:
    lädt die gated Klon-Gewichte in den Ordner von Pocket TTS. Braucht die
    lokale Stimme Pocket TTS (oben, auch im selben Lauf).
  - „Qwen3-TTS Base, nur Mac mit Apple Silicon (ca. 4,5 GB Modell plus ca. 120 MB Laufzeit; bessere Qualität, auf einem M4 langsamer als Echtzeit)“:
    eigene Python-Umgebung mit mlx-audio 0.5.7 und das Modell unter
    `models/speech/qwen-clone/`.
- **Stimmst du Kyutais Bedingungen für das Klon-Modell zu?** Nur bei Pocket.
  Vorher auf [huggingface.co/kyutai/pocket-tts](https://huggingface.co/kyutai/pocket-tts)
  anmelden, die Bedingungen lesen und akzeptieren. Ja ist deine bewusste
  Zustimmung; ohne Ja lädt der Schritt nichts.
- **Hugging-Face-Token (Lesezugriff, nur für diesen Download)** Nur bei
  Pocket. Ein Token mit Lesezugriff aus
  [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens),
  beginnt mit `hf_`. Er gilt nur für diesen Lauf und wird nirgends
  gespeichert.

Geladen wird erst nach „Jetzt ausführen?“, der Plan nennt die Größen. Danach
eine Probe ohne Netz (die Engine klont eine Referenz und liest einen Satz);
erst dann der Nachweis (`models/speech/pocket-clone.ok.json` bzw.
`qwen-clone.ok.json`) und `speech.cloneEngine` in `config/settings.json`. Ohne
Freischaltung bei Kyutai meldet der Schritt, dass der Zugang fehlt; ein halber
Download wird beim nächsten Lauf fortgesetzt. Mehr, mit Einwilligung,
Rechtslage und Lizenzen: [sprechen.md](sprechen.md), Abschnitt „Eigene
Stimme“.

#### Weg Telefonhörer

Der zweite Weg richtet den Telefonhörer ein (ein flüssiges Gespräch im
Browser, Entscheidung 0024). Er setzt einen lokalen Erkenner voraus
(Parakeet aus dem Weg „Sprechmodus lokal“ oder whisper.cpp); fehlt er,
verweist der Schritt dorthin und misst nichts. Als Stimme empfiehlt er Pocket
TTS, ohne sie spricht der Browser.

- **Modellweg für den Telefonhörer:**
  - „Automatisch: der erste bereite Weg (API-Schlüssel, dann Claude-Abo, dann OpenRouter)“
  - „Claude Sonnet 5.5 über VOICE_ANTHROPIC_API_KEY: gleichmäßig, kostet pro Turn“
  - „Claude Sonnet 5.5 über dein Claude-Abo (Claude Code): keine Zusatzkosten außer Guthaben, einzelne Antworten langsamer“
  - „OpenRouter: kostet pro Turn, nur mit wenig Vordenken flüssig“
  - „Ollama auf diesem Rechner: kostenlos, aber zäh“

Der Plan zeigt jeden Weg als „Bereit“ oder „Nicht bereit“ mit Grund und
Erklärung. Ist der gewählte Weg nicht bereit (oder bei „Automatisch“ keiner),
sagt der Schritt das klar und speichert nichts: Es bleibt beim Sprechmodus.
Sonst misst er nach „Jetzt ausführen?“ auf diesem Gerät, genau über den
gewählten Weg. Zuerst die Geräteprobe durch die ganze Kette: Die
Probe-Aufnahme aus `setup/assets/` geht durch den Erkenner (Parakeet bzw.
whisper.cpp), der erkannte Text als Frage an das Modell, der erste Abschnitt
der Antwort an Pocket TTS. Gemessen wird je Stufe (Erkennen, Antwort beginnt,
erster Ton) nach dem Laden wie beim Abheben, dazu die Summe mit 0,8 s
Sprechpause. Ohne Pocket spricht der Browser, der erste Ton ist dann nicht
messbar. Scheitert eine Stufe, nennt das Ergebnis sie. Danach drei
Testfragen ans Modell („Antwort beginnt nach 1,3 s (3 Proben: 1,1 bis
1,6 s), flüssig“; bis 2 Sekunden flüssig, bis 4 Sekunden geht, darüber zäh).
Die Probe mit dem API-Schlüssel oder OpenRouter kostet ein paar Cent, im Abo
zählt sie gegen das Guthaben. Danach speichert er den Weg in
`config/settings.json` (`speech.call.model`, bei Claude dazu
`speech.call.claudeVia`); „Automatisch“ lässt einen leeren Wert leer, außer
`SPEECH_CALL_MODEL` in der `.env` wählt einen festen Weg: dann speichert er
`auto` ausdrücklich, damit der gemessene Weg gilt. Ohne Messwert der
Testfragen speichert er nichts. Am Ende der Hinweis, dass das Handy
HTTPS braucht (`tybo setup zugang`). Wartezeiten, Kosten und Grenzen:
[sprechen.md](sprechen.md), Abschnitt „Telefonhörer“.

### 9. WebUI (optional)

Mit dem Bot im Browser chatten, auch vom Handy im Heimnetz. Der
Terminal-Chat `tybo` braucht sie ebenfalls. Ohne Telegram ist sie der
einzige Weg zu tybo und damit nicht mehr optional.

- **WebUI einschalten:** Ja oder Nein. Nur bei Ja folgen die weiteren
  Felder.
- **Passwort der WebUI:** mindestens 12 Zeichen.
- **Erreichbar von:** „Nur dieser Rechner“ (am sichersten) oder „Heimnetz“
  (Handy im selben WLAN).
- **Port (optional):** Standard 3100.

tybo als App auf dem Handy (installieren, Benachrichtigungen, Teilen aus
anderen Apps) braucht zusätzlich eine HTTPS-Adresse, die richtet der nächste
Schritt ein. Mehr zur App: [handy-app.md](handy-app.md).

### 10. Zugang vom Handy (optional)

Die Web-App lässt sich nur über HTTPS aufs Handy legen und nur dann
Benachrichtigungen schicken; über `http://<IP des Rechners>` im Heimnetz geht
das in keinem Browser. Dieser Schritt macht die WebUI über eine
HTTPS-Adresse erreichbar. Er installiert nichts und kommt nur, wenn die WebUI
eingeschaltet ist. Hintergrund und Sicherheit:
[webui/fernzugang.md](webui/fernzugang.md).

- **Weg vom Handy:** eine von drei Auswahlen, Standard ist Tailscale.
  - „Tailscale, privates Netz nur für deine Geräte (empfohlen)“: läuft als
    Ablauf, siehe unten.
  - „Cloudflare Tunnel mit eigener Domain und Cloudflare Access“: für wen
    schon eine Domain bei Cloudflare hat, siehe unten.
  - „Nur auf diesem Rechner, keinen zusätzlichen Zugang einrichten“: ändert
    nichts. Die WebUI bleibt auf diesem Rechner bzw. im Heimnetz, die App
    auf dem Handy und Benachrichtigungen gehen dann nicht. Ein schon
    eingerichteter Zugang bleibt, wie er ist.
- **Vorhandenen Zugang ersetzen:** kommt nur, wenn schon ein anderer Weg
  eingerichtet ist. Ja ersetzt dessen Werte in der `.env`, Nein ändert
  nichts. Den Tunnel oder die Tailscale-Einstellung selbst rührt der
  Assistent nicht an.

#### Weg Tailscale

Tailscale ist ein privates Netz nur für deine Geräte: das Handy erreicht den
Rechner unter einer Adresse wie `https://<gerät>.<tailnet>.ts.net`, niemand
sonst. Vorher selbst erledigen:

1. Tailscale auf diesem Rechner installieren (macOS: Mac App Store oder
   [tailscale.com/download](https://tailscale.com/download); Linux:
   `curl -fsSL https://tailscale.com/install.sh | sh`) und anmelden.
2. Die Tailscale-App auf dem Handy installieren und mit demselben Konto
   anmelden.
3. In der Admin-Konsole unter [DNS](https://login.tailscale.com/admin/dns)
   MagicDNS und „HTTPS Certificates“ einschalten.

Der Assistent zeigt dann unter „Das passiert jetzt:“ den Ablauf und fragt
„Jetzt ausführen? [J/n]“. Er prüft Installation, Anmeldung, MagicDNS und
HTTPS-Zertifikate (`tailscale status --json`), sieht nach, ob Port 443 in
Tailscale frei ist (`tailscale serve status --json`), richtet die
Weiterleitung ein
([`tailscale serve --bg --https=443 http://127.0.0.1:<WEB_PORT>`](https://tailscale.com/docs/reference/tailscale-cli/serve)),
schreibt die Adresse als `WEB_PUBLIC_ORIGIN` in die `.env` und testet über
HTTPS. Fehlt etwas, steht statt eines Fehlers die Anleitung da, etwa
„Tailscale ist nicht angemeldet. …“ oder „HTTPS-Zertifikate sind im Tailnet
aus. …“. Ist Port 443 schon für etwas anderes eingerichtet oder Tailscale
Funnel an (dann wäre die WebUI öffentlich), bricht er ab und ändert nichts.
Unter Linux braucht Serve Administratorrechte; die Meldung nennt dann
einmalig `sudo tailscale set --operator=$USER`.

#### Weg Cloudflare mit eigener Domain

Für wen schon eine Domain bei Cloudflare hat. Tunnel-Eintrag und
Access-Anwendung legst du vorher selbst an, wie in
[webui/fernzugang.md](webui/fernzugang.md) beschrieben. Dann fragt der
Assistent:

- **Adresse von unterwegs (eigene Domain):** etwa `tybo.example.org`, ohne
  Pfad und Port.
- **Cloudflare-Team-Name:** der erste Teil der Team domain
  (`meinteam` aus `meinteam.cloudflareaccess.com`).
- **Application Audience (AUD) Tag:** aus der Access-Anwendung.

Der Test prüft, ob Cloudflare das Team kennt und ob die Adresse zur
Anmeldung dieses Teams weiterleitet (Access davor). Gespeichert werden
`WEB_PUBLIC_ORIGIN`, `WEB_ACCESS_TEAM`, `WEB_ACCESS_AUD` und `WEB_PORT`.

#### Nach dem Einrichten

Die neuen Werte liest tybo erst nach einem Neustart (läuft tybo schon: in
der WebUI unter Einstellungen, Status „Neustart anfordern“). Solange tybo
noch nicht mit ihnen läuft, meldet der Test über HTTPS „ausstehend“ statt
eines Fehlers; im Browser-Assistenten (`tybo setup --web`) ist er immer
ausstehend, weil der Assistent dann den Port der WebUI belegt. Nachholen mit
`tybo setup zugang`, in der Gesamtprüfung oder von Hand:

```bash
curl -s https://<gerät>.<tailnet>.ts.net/manifest.webmanifest
# erwartet: eine Antwort mit "name":"tybo" und "display":"standalone"
curl -sI https://tybo.example.org/manifest.webmanifest
# Cloudflare, erwartet: Status 302, location auf <team>.cloudflareaccess.com
```

### 11. Google-Kalender und Gmail (optional)

Termine von heute und ungelesene Mails im Morgen-Briefing und in der
Board-Sitzung (`/board`), nur lesend. Früher machte das ein eigenes Skript; `bun run setup:google`
ruft jetzt diesen Schritt auf, wie `tybo setup google`.

Vorher einmal in der [Google Cloud Console](https://console.cloud.google.com/apis/credentials):

1. Ein Projekt anlegen oder ein vorhandenes nehmen.
2. „Google Calendar API“ und „Gmail API“ aktivieren.
3. Den OAuth-Zustimmungsbildschirm einrichten (Typ „Extern“ reicht) und die
   eigene Google-Adresse als Testnutzer eintragen. Solange die App im
   Testmodus ist, läuft der Zugang laut Google nach 7 Tagen ab; für
   Dauerbetrieb die App auf „In Produktion“ stellen.
4. Unter APIs und Dienste, Anmeldedaten eine OAuth-Client-ID vom Typ
   „Desktop-App“ erstellen.

Die Felder:

- **Google Client-ID:** endet auf `.apps.googleusercontent.com`.
- **Google Client-Secret:** steht beim selben Desktop-Client, geheim.

Danach läuft der Schritt als Ablauf:

1. Er startet auf diesem Rechner eine Anmeldeseite unter
   `http://127.0.0.1:8976/`, nur von diesem Rechner aus erreichbar.
2. Er öffnet den Browser; dort meldest du dich bei Google an und erlaubst
   das Lesen von Kalender und Gmail. Geht kein Fenster auf, öffnest du die
   Adresse aus der Zeile „[2/5] Warte auf die Anmeldung bei Google im
   Browser“ selbst. Läuft die Einrichtung per SSH auf einem anderen Rechner,
   vorher auf deinem Rechner `ssh -L 8976:127.0.0.1:8976 <dieser Rechner>`
   und dann die Adresse dort im Browser öffnen. Gewartet wird höchstens
   5 Minuten.
3. Er tauscht die Antwort von Google gegen einen Refresh-Token.
4. Er speichert Client-ID, Client-Secret und Refresh-Token zusammen in der
   `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `GOOGLE_REFRESH_TOKEN`). Geht vorher etwas schief (Anmeldung abgelehnt,
   Zeitlimit, Strg+C, Port 8976 belegt), bleibt die `.env`, wie sie war,
   auch ein schon gespeicherter Zugang.
5. Er liest zur Probe einmal Kalender und Gmail. Antwortet Google mit
   HTTP 403, ist meist die API im Projekt nicht aktiviert oder beim
   Anmelden ein Haken nicht gesetzt.

Werte zeigt der Assistent dabei nie an, weder im Terminal noch im Browser.
Meldet Google „keinen Refresh-Token“, unter
[Google-Konto, Drittanbieter-Zugriff](https://myaccount.google.com/permissions)
den Zugriff der App entfernen und den Schritt wiederholen. Neu anmelden geht
jederzeit mit `tybo setup google`; Enter behält Client-ID und Client-Secret.
Die Gesamtprüfung erneuert nur das Zugriffstoken und liest Kalender und
Gmail, eine neue Anmeldung öffnet sie nie. Das Morgen-Briefing liest die
Werte beim nächsten Lauf, der laufende Bot (für `/board`) nach einem Neustart.

### 12. Autostart

tybo startet mit dem Rechner und nach Abstürzen von selbst. Keine Felder,
nur die Frage „Autostart jetzt einrichten? [j/N]“. Eingerichtet wird nur der
Bot selbst (Dienst `telegram-relay`), keine Check-ins und kein Briefing.

- **macOS:** launchd-Dienst `ai.tybo.telegram-relay` in
  `~/Library/LaunchAgents/`. Er startet sofort.
- **Supabase auf diesem Rechner:** zeigt `SUPABASE_URL` auf
  `http://127.0.0.1:54421`, richtet der Schritt zusätzlich
  `ai.tybo.supabase` (macOS) bzw. `tybo-supabase` (PM2) ein, mit eigener
  Zeile in der Übersicht. Der Dienst ruft beim Anmelden einmal
  `tybo datenbank start` auf (unter PM2 bleibt er danach ohne Arbeit stehen,
  siehe „Supabase lokal im Alltag“). Ist der Bot schon eingerichtet, bleibt er unberührt, und nur der
  Supabase-Dienst kommt dazu.
- **Linux mit systemd** (etwa ein Raspberry Pi): Vorschlag ist ein
  systemd-Benutzerdienst, PM2 ist wählbar. Der Assistent fragt vorher:
  ```text
  Wie soll der Autostart laufen?
    1) systemd-Benutzerdienst (Vorschlag)
    2) PM2
  ```
  Enter nimmt den Vorschlag. Mehr dazu unter
  [Autostart mit systemd](#autostart-mit-systemd).
- **Linux ohne systemd und Windows:** PM2-Dienst `tybo-telegram-relay`, danach
  speichert der Assistent die Liste mit `pm2 save`. Damit PM2 nach einem
  Neustart des Rechners selbst mitstartet, einmal von Hand:
  ```bash
  pm2 startup
  ```
  und die Zeile ausführen, die PM2 dann ausgibt (sie beginnt meist mit
  `sudo`). Dasselbe gilt, wenn du unter Linux mit systemd PM2 wählst.

Läuft tybo schon in einem anderen Fenster (`bun run start`), dort erst
beenden. Zwei Bots mit demselben Token holen sich dieselben Nachrichten.

Ohne Autostart startest du tybo von Hand im Projektordner mit
`bun run start`; er läuft, bis das Fenster geschlossen wird.

Alle zeitgesteuerten Dienste dieses Rechners (Nachtcheck, eigene Watcher)
zeigt später `/routinen`, mit letztem und nächstem Lauf; eigene Dienste mit
anderem Label trägst du dafür in `config/routines.json` ein (Vorlage
`config/routines.example.json`). Mehr dazu in [Routinen](routinen.md).

#### Autostart mit systemd

Ergänzt mit Issue #207 (Entscheidung 0011 nannte für Linux nur PM2). Der
Assistent legt `~/.config/systemd/user/tybo-telegram-relay.service` an und
startet ihn mit `systemctl --user enable --now tybo-telegram-relay`. Die
Datei enthält den tatsächlichen Projektordner, den vollen Pfad zu Bun,
`Restart=always` und einen eigenen `PATH` mit dem Ordner von Bun, dem Ordner
der Claude CLI (aus `CLAUDE_PATH` oder dort, wo `claude` gefunden wurde),
dem Ordner von Codex (aus `CODEX_PATH` oder dort, wo `codex` gefunden wurde),
`~/.bun/bin` und `~/.local/bin`. Ein Benutzerdienst bekommt sonst nur die
Systemordner und fände Claude oder Codex nicht. Das Protokoll landet wie auf macOS in
`logs/telegram-relay.log` und `logs/telegram-relay.error.log`, nicht im
Journal: das eigene Journal ist auf Debian ohne die Gruppe `adm` oft nicht
lesbar.

Pfade mit Leerzeichen oder Zeichen wie `%`, `$`, `:` oder Anführungszeichen
nimmt eine systemd-Dienstdatei nicht sicher auf. Liegt das Projekt in so
einem Ordner, lehnt der Assistent ab; dann das Projekt verschieben oder PM2
wählen.

**Start ohne Anmeldung (Linger).** Ein Benutzerdienst startet nach einem
Neustart des Rechners erst, wenn du dich anmeldest, außer Linger ist an. Der
Assistent schaltet es ohne `sudo` ein (`loginctl enable-linger`); das geht,
wenn polkit es erlaubt. Sonst steht am Ende genau ein Befehl da:

```bash
sudo loginctl enable-linger <dein-name>
```

Danach `tybo setup autostart` noch einmal (im Terminal genügt „Nochmal
versuchen“); der Assistent prüft es und meldet „Autostart ist eingerichtet“.
Selbst nachsehen: `loginctl show-user $USER -p Linger` (erwartet `Linger=yes`).

**Im Alltag** (immer als dein Benutzer, nie mit `sudo`):

```bash
systemctl --user status tybo-telegram-relay     # läuft er?
systemctl --user stop tybo-telegram-relay       # anhalten
systemctl --user start tybo-telegram-relay      # starten
systemctl --user restart tybo-telegram-relay    # neu starten (vom Terminal aus)
tail -f logs/telegram-relay.log                 # Protokoll
```

Aus einer Antwort des Bots heraus nie `restart` oder `stop` aufrufen, sondern
`bun run restart:request "Grund"`: der Bot beendet sich nach der laufenden
Antwort, systemd startet ihn neu. Wiederholt man `tybo setup autostart` bei
laufendem Dienst, bleibt er unberührt.

**Hintergrund-Jobs überleben den Neustart.** Die Dienstdatei enthält
`KillMode=process`. Ohne die Zeile beendet systemd beim Stoppen oder
Neustarten alle Prozesse des Dienstes, auch laufende
[Hintergrund-Jobs](hintergrund-jobs.md). Mit ihr beendet systemd nur den Bot,
seine Motor-Aufrufe räumt der Bot beim Beenden selbst ab. Nach einem Absturz
des Bots räumt systemd dafür keine übrig gebliebenen Kindprozesse mehr ab.

Eine Dienstdatei von vor dieser Zeile erkennt `tybo pruefen` und warnt mit
„telegram-relay (Hintergrund-Jobs)“. Nachziehen, ohne dass der Bot neu startet:

```bash
tybo setup autostart
```

Der Assistent trägt `KillMode=process` direkt unter `[Service]` ein, lässt
den Rest der Datei, wie er ist, und lädt sie mit
`systemctl --user daemon-reload` neu. systemd nimmt den Wert beim nächsten
Beenden. Ein zweiter Lauf ändert nichts mehr. Maßgeblich ist der Wert, den
systemd tatsächlich lädt, also samt Zusatzdateien (Drop-ins) unter
`~/.config/systemd/user/tybo-telegram-relay.service.d/`. Setzt die
Dienstdatei selbst einen anderen `KillMode`, bleibt er stehen; setzt ihn eine
Zusatzdatei, nennt der Assistent `systemctl --user cat tybo-telegram-relay`,
damit du die Zeile dort findest. Selbst nachsehen:
`systemctl --user show tybo-telegram-relay -p KillMode` (erwartet
`KillMode=process`).

**Schon unter PM2 eingerichtet?** Dann bleibt es bei PM2; der Assistent legt
nie einen zweiten Dienst daneben an. Wechseln: erst
`pm2 delete tybo-telegram-relay; pm2 save --force`, dann `tybo setup autostart`.
Umgekehrt (systemd zu PM2): erst
`systemctl --user disable --now tybo-telegram-relay` und die Dienstdatei
löschen. Steht der Bot in beiden, oder lässt sich die PM2-Liste nicht lesen,
startet der Assistent nichts.

**Supabase auf diesem Rechner** läuft auch auf dem systemd-Weg weiter über
PM2 (`tybo-supabase`). Dafür braucht es PM2 und `pm2 startup` wie oben.

**Entfernen:** `tybo deinstallieren` (auch `bun run uninstall`) hält den
Bot und die Timer von Check-in und Briefing an, löscht ihre Dateien und lädt
systemd neu; dazu entfernt es die eigenen cron-Zeilen und die PM2-Prozesse
`tybo-*`. Antwortet `systemctl --user` nicht, bleibt alles, wie es ist
(Exit-Code 1). Linger bleibt an, weil andere Benutzerdienste es brauchen
können; ausschalten mit `loginctl disable-linger $USER` (ohne Berechtigung
mit `sudo` davor).

### 13. Gesamtprüfung

Fasst zusammen, was eingerichtet ist und was noch fehlt, und testet jeden
eingerichteten Schritt mit den gespeicherten Werten. „Alles eingerichtet und
erreichbar.“ heißt: fertig. Fehlt ein Kanal, steht dort „Richte Telegram
oder die WebUI ein, sonst erreicht dich tybo nirgends.“ Eine übrig
gebliebene Forum-Gruppe ohne Telegram wird nicht geprüft.

Am Ende nennt der Assistent, wie du tybo erreichst: „Öffne die WebUI unter
http://127.0.0.1:3100.“ (nur WebUI), „Schreib deinem Bot in Telegram.“ (nur
Telegram) oder beides.

## Die erste Antwort

Schreib deinem Bot in Telegram eine normale Nachricht, etwa „Hallo, bist du
da?“, oder öffne die WebUI (Standard `http://127.0.0.1:3100`), melde dich mit
dem Passwort an und schreib dort in den Direktchat. Nach einigen Sekunden
antwortet tybo über Claude. Die Testnachricht aus der Einrichtung zählt
nicht; erst eine Antwort auf deine eigene Nachricht zeigt, dass alles läuft.

Kommt keine Antwort: Läuft tybo (Autostart oder `bun run start`)? Dann
`logs/telegram-relay.log` und `logs/telegram-relay.error.log` im
Projektordner ansehen.

## Deinstallieren

`tybo deinstallieren` (auch `bun run uninstall`) nimmt die
Hintergrunddienste von tybo von diesem Rechner: auf dem Mac jeden
launchd-Dienst `ai.tybo.*`, unter Linux den Bot und die Timer unter systemd,
die eigenen cron-Zeilen und die PM2-Prozesse `tybo-*`, unter Windows die
PM2-Prozesse `tybo-*`. Dienste anderer Namen und alles, was
`config/routines.json` nennt, bleiben. Aus PM2s gespeicherter Liste
(`dump.pm2`) streicht er nur die eigenen Einträge, fremde und geschützte
bleiben dort stehen, auch wenn sie gerade nicht laufen; ist die Liste nicht
lesbar, bleibt PM2 unverändert (Exit-Code 1). Danach fragt der Befehl, ob
`models/speech/` gelöscht werden soll; ohne „j“ (und ohne Terminal) bleibt
der Ordner.

Projektordner, `.env`, `data/` und andere Modelle bleiben. Supabase auf
diesem Rechner läuft samt Containern und Daten weiter; anhalten mit
`tybo datenbank stop`. Lässt sich ein Dienst nicht sicher stoppen, bleibt
seine Datei liegen und der Befehl endet mit Exit-Code 1; ein zweiter Aufruf
ist harmlos. Wieder einrichten: `tybo dienste` bzw. `tybo setup autostart`.

## Der Weg im Browser

```bash
tybo setup --web         # ohne bun link: bun run tybo setup --web
```

Das Terminal zeigt eine Adresse (`http://127.0.0.1:3100`) und einen
**Einmal-Code**. Die Seite ist nur auf diesem Rechner erreichbar; dort den
Code eingeben. Die Schritte und Felder sind dieselben wie im Terminal. Den
Autostart richtet der Browser erst bei „Fertig“ ein (Häkchen „Autostart
einrichten und tybo danach gleich starten“), nachdem die Einrichtungsseite
geschlossen ist. Unter Linux mit systemd steht darunter die Auswahl „Art des
Autostarts“ (systemd-Benutzerdienst oder PM2). Fehlt danach nur noch der
Start ohne Anmeldung, steht der `sudo`-Befehl dafür im Terminal.

Ist beim Start des Bots kein Kanal eingerichtet (weder Telegram noch eine
gültige WebUI) oder Telegram nur halb, startet er von selbst in diesem
Einrichtungsmodus, ohne Telegram; Grund, Adresse und Code stehen dann im Log.
Mit gültiger WebUI und ohne Telegram startet er normal, nur mit der WebUI.

Überspringst du im Browser Telegram („Weiter“) und die WebUI ist noch aus,
öffnet der Assistent als Nächstes die WebUI; danach geht es mit den übrigen
Schritten weiter. „Fertig“ bleibt gesperrt, bis Telegram oder die WebUI
eingerichtet ist. Nach „Fertig“ steht da, wo du tybo erreichst.

Zwei Dinge macht der Browser-Weg nicht, die musst du selbst erledigen:

- **Claude-Anmeldung prüfen.** Der Browser ruft kein Modell auf und prüft
  deshalb nicht, ob die Claude CLI angemeldet ist. Danach im Terminal
  `tybo setup voraussetzungen` ausführen oder `claude` einmal starten.
- **Starten ohne Autostart.** Ohne Häkchen steht nach „Fertig“ nur der
  Startbefehl da (`cd <projektordner> && bun run start`). Den führst du
  selbst aus.

## Typische Fehler

| Meldung des Assistenten | Was zu tun ist |
|---|---|
| „Telegram lehnt das Token ab. Bitte das Token bei @BotFather prüfen oder neu erzeugen.“ | Token komplett kopieren (Zahl, Doppelpunkt, Rest); bei @BotFather mit `/token` ein neues holen. |
| „Telegram kennt diese Nutzer-ID nicht, oder du hast dem Bot noch nie geschrieben. …“ (Telegram meldet „chat not found“) | Den eigenen Bot öffnen, **Start** tippen, dann „Erneut eingeben“ und Enter für die vorigen Werte. Prüfen, ob die ID von @userinfobot stammt. |
| „Der Bot ist in der Gruppe kein Admin. …“ | In der Gruppe den Bot zum Admin machen. |
| „Die Tabelle messages fehlt. db/schema.sql im SQL-Editor von Supabase ausführen.“ | Siehe [Supabase vorbereiten](#supabase-vorbereiten), Schritt 2. |
| „Supabase lehnt den Schlüssel ab. …“ | Den Secret-Schlüssel (`sb_secret_…`) oder `service_role` nehmen, nicht Publishable oder `anon`. |
| „Supabase verweigert dem Schlüssel das Recht, … (permission denied …)“ | Der Tabelle oder ihrem Zähler fehlt ein Recht; siehe [Rechte der Tabellen](#rechte-der-tabellen). |
| „Das ist der öffentliche Publishable-Schlüssel …“ | Im Dashboard unter API Keys den Secret key kopieren, nicht den Publishable key. |
| „CONVEX_URL ist gesetzt, aber Convex wird nicht mehr unterstützt …“ (Log beim Start) | Convex gibt es nicht mehr; siehe [Umzug von Convex](#umzug-von-convex). |
| „Claude CLI nicht gefunden.“ | `curl -fsSL https://claude.ai/install.sh \| bash` (unter Windows ohne WSL `npm install -g @anthropic-ai/claude-code`), danach Terminal neu öffnen. |
| „Claude CLI liegt in ~/.local/bin, das ist noch nicht im PATH: neue Sitzung öffnen. …“ | Nichts neu installieren: neues Terminal bzw. neue SSH-Sitzung öffnen. Hilft das nicht, die angezeigte Zeile `export PATH="$HOME/.local/bin:$PATH"` in `~/.zshrc` bzw. `~/.bashrc` eintragen. |
| „Die Claude CLI ist da, startet aber nicht richtig …“ bzw. „… liegt in ~/.local/bin, startet dort aber nicht …“ (auch vom Installer) | Die CLI ist vorhanden, aber `claude --version` scheitert. Mit dem nativen Installer neu installieren; steht `CLAUDE_PATH` in der `.env`, den Pfad dort prüfen. |
| „Claude CLI ist nicht angemeldet. …“ | `claude` starten, `/login`. |
| „PM2 fehlt. Erst installieren mit: npm install -g pm2“ | PM2 installieren, dann `tybo setup autostart`. Unter Linux mit systemd geht auch der systemd-Benutzerdienst ohne PM2. |
| „Noch offen: nach einem Neustart des Rechners startet tybo erst, wenn du dich anmeldest. …“ | Den genannten Befehl `sudo loginctl enable-linger <name>` ausführen, dann `tybo setup autostart`. |
| „Der systemd-Benutzerdienst antwortet nicht (systemctl --user). …“ | `tybo setup` als normaler Benutzer in einer Anmeldesitzung starten (SSH oder am Gerät), nicht über `sudo` oder `su`. Sonst PM2 wählen. |

**Claude nicht im PATH unter launchd.** Antwortet der Bot über den Autostart
nur mit Fallback-Modellen (OpenRouter, Ollama) oder gar nicht, obwohl
`claude` im Terminal geht, findet der Dienst die Claude CLI nicht. Die CLI
liegt meist in `~/.local/bin`. Der Autostart trägt den Ordner ein, in dem
`claude` beim Einrichten gefunden wurde (sonst `/usr/local/bin`). Wurde die
CLI erst danach installiert oder verschoben, den Dienst neu anlegen:

```bash
launchctl unload ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
rm ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
tybo setup autostart
```

Den genauen Fehler zeigt `logs/telegram-relay.error.log`.

Mehr Fehlerbilder: [`docs/troubleshooting.md`](troubleshooting.md).

## Was der Assistent nicht erledigt

Diese Punkte kommen nach der Einrichtung von Hand dazu, je mit Anleitung in
[erweiterungen.md](erweiterungen.md):

- Agenten anpassen: `/agent <name>: <anweisung>`, gespeichert in
  `config/agent-overrides.json` ([Agenten anpassen](erweiterungen.md#agenten-anpassen))
- Topics zuordnen: `config/topics.json` nach `config/topics.example.json`,
  `/topics` zeigt die Zuordnung ([Topics zuordnen](erweiterungen.md#topics-zuordnen))
- Eigener Telegram-Bot je Agent: `TELEGRAM_BOT_TOKEN_<KENNUNG>`
  ([Eigener Bot je Agent](erweiterungen.md#eigener-bot-je-agent))
- Check-in und Morgenbriefing als Dienste: `tybo dienste`
  ([Check-in und Morgenbriefing](erweiterungen.md#check-in-und-morgenbriefing))
- Datenquellen außer Google: News, Notion, eigene unter `src/lib/sources/`
  ([Datenquellen](erweiterungen.md#datenquellen))
- Sprachnachrichten und Stimmen aus der Cloud: Gemini, ElevenLabs; den
  lokalen Weg richtet der Schritt `sprache` ein
  ([Sprachnachrichten und Cloud-Stimmen](erweiterungen.md#sprachnachrichten-und-cloud-stimmen))
- Anrufe von tybo: `/anruf` mit ElevenLabs und Twilio
  ([Anrufe](erweiterungen.md#anrufe))
- MCP-Server: `config/mcp-servers.json` oder `~/.claude.json`, Test mit
  `bun run test:tools` ([MCP-Server](erweiterungen.md#mcp-server))
- Server-Betrieb und Hybrid: `TYBO_PROFILE`, [telegram-webhook.md](telegram-webhook.md)
  ([Server und Hybrid](erweiterungen.md#server-und-hybrid))
- Linux-Dienste nach Neustart und Abmelden: `pm2 startup` bzw.
  `sudo loginctl enable-linger`, wenn der Assistent Linger ohne
  Administratorrechte nicht einschalten kann
  ([Linux: Dienste nach Neustart](erweiterungen.md#linux-dienste-nach-neustart))
- Prüfbericht: `tybo pruefen` ([Prüfbericht](erweiterungen.md#prüfbericht))

Außerdem: Beim Weg „Zugangsdaten selbst eintragen“ legst du Supabase-Projekt,
Schema und Bilder-Ordner selbst an (siehe oben), und zwischen den
Datenbank-Wegen zieht der Assistent keine Daten um. Erinnerungen sind
eingebaut und brauchen keine Einrichtung ([erinnerungen.md](erinnerungen.md)).
