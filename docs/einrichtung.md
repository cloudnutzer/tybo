# tybo einrichten

Diese Anleitung führt auf einem frischen Rechner bis zur ersten Antwort in
Telegram. Du brauchst dafür weder Claude Code als Gesprächspartner noch die
`CLAUDE.md`. Der Assistent `tybo setup` fragt alles ab, prüft jede Angabe
gleich mit einem Verbindungstest und schreibt die `.env` erst nach deiner
Bestätigung.

Was der Assistent nicht übernimmt, steht am Ende unter
[Was der Assistent nicht erledigt](#was-der-assistent-nicht-erledigt).

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
7. Nennt am Ende, was noch fehlt: Bun im `PATH`, Node.js, Claude CLI.

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
und ändert nichts. `tybo setup` startet beim Aktualisieren nicht noch einmal,
und ein laufender Bot wird nicht von selbst neu gestartet; den Befehl dafür
nennt der Installer am Ende.

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
  Danach das Terminal neu öffnen oder Bun in den `PATH` holen:
  ```bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  ```
  Dauerhaft: die beiden Zeilen in `~/.zshrc` (macOS) bzw. `~/.bashrc`
  (Linux) eintragen. Zu alt: `bun upgrade`.
- **Node.js** 20.0.0 oder neuer, mit `npm` und `npx`. Beides wird unten für die
  Claude CLI, PM2 und die Convex-Vorbereitung gebraucht. Installieren:
  auf macOS `brew install node` (mit [Homebrew](https://brew.sh)) oder das
  LTS-Paket von [nodejs.org](https://nodejs.org), auf Linux (Debian, Ubuntu)
  das LTS-Paket über [NodeSource](https://github.com/nodesource/distributions)
  oder den Paketmanager (`sudo apt install nodejs npm`, auf älteren
  Distributionen oft zu alt), auf Windows den Installer von
  [nodejs.org](https://nodejs.org). Prüfen mit `node --version` und
  `npm --version`. Zeigt `node --version` eine ältere Version als 20 an,
  zuerst Node.js aktualisieren und erst dann die Convex-Vorbereitung
  starten: Convex lehnt Node.js 18 ab. Der Assistent prüft Node.js nicht
  selbst.
- **Claude CLI**, installiert und angemeldet:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude          # einmal starten, dann /login
  ```
  tybo nutzt dein Claude-Abo (oder einen `ANTHROPIC_API_KEY`) über die CLI.
- **Git**: auf macOS `xcode-select --install`, auf Linux etwa
  `sudo apt install git`.
- **Linux und Windows:** PM2 für den Autostart: `npm install -g pm2`.
- Ein **Telegram**-Konto.

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
`telegram`, `gruppe`, `datenbank`, `profil`, `modelle`, `webui`,
`autostart`, `pruefung`.

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

**Optionale Schritte** (Forum-Gruppe, Modelle und Fallback, WebUI) beginnen
mit der Frage „Jetzt einrichten? [J/n]“. Mit `n` wird der Schritt
übersprungen; die Einrichtung ist trotzdem vollständig.

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
Telegram, Datenbank, Profil und Autostart.

### 1. Voraussetzungen

Prüft Bun, Claude CLI und Git (siehe oben). Dieser Schritt hat keine Felder.
Sind alle drei da, zählt er als erledigt und kommt nur in der Gesamtprüfung
wieder vor. Dort startet der Assistent zusätzlich einen kurzen Probeaufruf
der Claude CLI, um die Anmeldung zu prüfen. Fehlt etwas, steht der Befehl zum
Nachholen daneben; nach dem Installieren „Nochmal prüfen“.

### 2. Telegram

Der Bot, über den tybo mit dir spricht.

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

Gedächtnis, Verlauf und Ziele liegen in Supabase oder Convex. Es gibt vier
Wege; der erste ist der Standard und der einfachste.

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
  4. „Convex (für Fortgeschrittene, eigener Token-Aussteller nötig)“: siehe
     [Convex vorbereiten](#convex-vorbereiten).

  Steht schon eine Supabase-Adresse auf `….supabase.co` in der `.env`,
  zeigt der Assistent beim erneuten Einrichten „Supabase in der Cloud“ an,
  bei genau `http://127.0.0.1:54421` „Supabase auf diesem Rechner“, bei jeder
  anderen Adresse „Zugangsdaten selbst eintragen“. Zwischen den Wegen
  zieht der Assistent keine Daten um; von Supabase zu Convex geht das mit
  `scripts/migrate-to-convex.ts`.

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
   `SUPABASE_ANON_KEY`, nur was abweicht. Steht noch Convex darin, gilt
   dieselbe Bestätigung wie beim Wechsel unten.
9. Verbindung testen.

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
4. Tabellen einspielen: `db/schema.sql` und die Dateien aus `db/migrations/`.
   Alle sind wiederholbar.
5. Den privaten Bilder-Ordner anlegen: `SUPABASE_ASSETS_BUCKET` aus der
   `.env`, sonst `tybo-assets`. Ist er schon da und öffentlich, bricht der
   Assistent ab, statt ihn umzustellen.
6. In die `.env` schreiben: `SUPABASE_URL=http://127.0.0.1:54421`,
   `SUPABASE_SERVICE_ROLE_KEY` und `SUPABASE_ANON_KEY`, nur was abweicht.
   Steht noch Convex darin, gilt dieselbe Bestätigung wie beim Wechsel unten.
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
  gestartet ist. Nach einem Neustart des Rechners startest du Supabase mit
  `tybo setup datenbank` (prüft auch das Netz und die Bindungen) oder im
  Projektordner mit derselben Dienstauswahl wie der Assistent:
  `bunx --bun supabase@2.118.0 start --workdir . -x studio,imgproxy,logflare,vector,realtime,supavisor,mailpit,postgres-meta`
  (ohne `-x` starten auch die Dienste, die tybo nicht braucht). Ein eigener
  Befehl und Autostart folgen.
- Updates der Container und Sicherungen machst du vorerst von Hand.

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

Bei **Convex** fragt er:

- **Convex-Adresse:** endet auf `.convex.cloud`.
- **Convex-Zugangstoken:** das Dienst-Token (`CONVEX_AUTH_TOKEN`), siehe
  unten.

Steht schon Convex in der `.env` und du wählst einen Supabase-Weg, kommt
zusätzlich:

- **Von Convex zu Supabase wechseln:** Mit Ja entfernt der Assistent
  `CONVEX_URL` aus der `.env`, sonst hätte Convex weiter Vorrang. Die alte
  `.env` bleibt als Sicherung in `data/backups/`.

Convex verlangt einen eigenen Aussteller für Anmelde-Tokens und ein Token,
das abläuft und erneuert werden muss; darum ist es der Weg für
Fortgeschrittene.

#### Supabase vorbereiten

Nur für „Zugangsdaten selbst eintragen“; in der Cloud erledigt der Assistent
das selbst.

1. Auf [supabase.com](https://supabase.com) ein kostenloses Konto und ein
   neues Projekt anlegen.
2. Im Dashboard **SQL Editor**, neue Abfrage, den Inhalt von `db/schema.sql`
   aus dem Projektordner einfügen und ausführen. Das legt unter anderem die
   Tabelle `messages` an, die der Verbindungstest liest. Die Datei ist
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

#### Convex vorbereiten

1. Auf [convex.dev](https://convex.dev) ein kostenloses Konto anlegen.
2. Im Projektordner:
   ```bash
   npx convex dev --once --configure=new
   ```
   Das legt das Deployment an und spielt Schema und Server-Funktionen aus
   `convex/` auf. Die Adresse (`https://…convex.cloud`) steht danach in der
   Ausgabe bzw. in `.env.local`.
3. **Dienstidentität (OIDC).** Das Deployment nimmt nur Anfragen einer
   einzigen, verifizierten Dienstidentität an. Du brauchst einen
   OIDC-Aussteller (etwa einen eigenen Identity-Provider), der ein JWT für
   tybo ausstellt. Auf Convex setzt du:
   ```bash
   npx convex env set CONVEX_AUTH_ISSUER https://dein-aussteller.example
   npx convex env set CONVEX_AUTH_AUDIENCE tybo
   npx convex env set CONVEX_OWNER_TOKEN_IDENTIFIER "https://dein-aussteller.example|<subject des Dienstes>"
   npx convex dev --once     # Anmeldeeinstellungen neu aufspielen
   ```
   `CONVEX_OWNER_TOKEN_IDENTIFIER` ist Aussteller und Subject des Tokens,
   getrennt durch `|`.
4. Das JWT deines Ausstellers ist das **Convex-Zugangstoken**
   (`CONVEX_AUTH_TOKEN` in der `.env`). Es **läuft ab**; danach lehnt Convex
   die Anmeldung ab, bis du ein neues einträgst (`tybo setup datenbank`,
   Enter bei der Adresse, neues Token).

Beispiele für die Werte stehen auch in `.env.example`.

### 5. Profil

Wer du bist und wo du lebst, damit Antworten und Zeiten passen.

- **Dein Name:** So spricht dich der Bot an.
- **Zeitzone:** IANA-Name wie `Europe/Berlin` oder `America/New_York`.
- **Beruf (optional):** steht nur in `config/profile.md`.

Name und Zeitzone kommen in die `.env` (`USER_NAME`, `USER_TIMEZONE`), dazu
entsteht `config/profile.md`. Gibt es die Datei schon, passt der Assistent nur
Überschrift, Zeitzone und Beruf an und legt vorher eine Sicherung an. Mehr
über dich (Arbeitsstil, Vorlieben) trägst du später selbst in
`config/profile.md` ein.

### 6. Modelle und Fallback (optional)

Welches Claude-Modell antwortet und was einspringt, wenn Claude nicht
erreichbar ist. Leer lassen heißt jeweils: Standard aus dem Code.

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

### 7. WebUI (optional)

Mit dem Bot im Browser chatten, auch vom Handy im Heimnetz. Der
Terminal-Chat `tybo` braucht sie ebenfalls.

- **WebUI einschalten:** Ja oder Nein. Nur bei Ja folgen die weiteren
  Felder.
- **Passwort der WebUI:** mindestens 12 Zeichen.
- **Erreichbar von:** „Nur dieser Rechner“ (am sichersten) oder „Heimnetz“
  (Handy im selben WLAN).
- **Port (optional):** Standard 3100.

### 8. Autostart

tybo startet mit dem Rechner und nach Abstürzen von selbst. Keine Felder,
nur die Frage „Autostart jetzt einrichten? [j/N]“. Eingerichtet wird nur der
Bot selbst (Dienst `telegram-relay`), keine Check-ins, kein Briefing, kein
Watchdog.

- **macOS:** launchd-Dienst `ai.tybo.telegram-relay` in
  `~/Library/LaunchAgents/`. Er startet sofort.
- **Linux und Windows:** PM2-Dienst `tybo-telegram-relay`, danach speichert der
  Assistent die Liste mit `pm2 save`. Damit PM2 nach einem Neustart des
  Rechners selbst mitstartet, einmal von Hand:
  ```bash
  pm2 startup
  ```
  und die Zeile ausführen, die PM2 dann ausgibt (sie beginnt meist mit
  `sudo`).

Läuft tybo schon in einem anderen Fenster (`bun run start`), dort erst
beenden. Zwei Bots mit demselben Token holen sich dieselben Nachrichten.

Ohne Autostart startest du tybo von Hand im Projektordner mit
`bun run start`; er läuft, bis das Fenster geschlossen wird.

### 9. Gesamtprüfung

Fasst zusammen, was eingerichtet ist und was noch fehlt, und testet jeden
eingerichteten Schritt mit den gespeicherten Werten. „Alles eingerichtet und
erreichbar.“ heißt: fertig.

## Die erste Antwort

Schreib deinem Bot in Telegram eine normale Nachricht, etwa „Hallo, bist du
da?“. Nach einigen Sekunden antwortet tybo über Claude. Die Testnachricht
aus der Einrichtung zählt nicht; erst eine Antwort auf deine eigene
Nachricht zeigt, dass alles läuft.

Kommt keine Antwort: Läuft tybo (Autostart oder `bun run start`)? Dann
`logs/telegram-relay.log` und `logs/telegram-relay.error.log` im
Projektordner ansehen.

## Der Weg im Browser

```bash
tybo setup --web         # ohne bun link: bun run tybo setup --web
```

Das Terminal zeigt eine Adresse (`http://127.0.0.1:3100`) und einen
**Einmal-Code**. Die Seite ist nur auf diesem Rechner erreichbar; dort den
Code eingeben. Die Schritte und Felder sind dieselben wie im Terminal. Den
Autostart richtet der Browser erst bei „Fertig“ ein (Häkchen „Autostart
einrichten und tybo danach gleich starten“).

Fehlen beim Start des Bots Token oder Nutzer-ID, startet er von selbst in
diesem Einrichtungsmodus, ohne Telegram; Adresse und Code stehen dann im Log.

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
| „Das ist der öffentliche Publishable-Schlüssel …“ | Im Dashboard unter API Keys den Secret key kopieren, nicht den Publishable key. |
| „Convex lehnt die Anmeldung ab. CONVEX_AUTH_TOKEN prüfen.“ | Token abgelaufen oder passt nicht zu `CONVEX_OWNER_TOKEN_IDENTIFIER`; siehe [Convex vorbereiten](#convex-vorbereiten). |
| „Auf dem Convex-Projekt fehlen die Server-Funktionen. …“ | Im Projektordner `npx convex dev --once` ausführen. |
| „Claude CLI nicht gefunden.“ | `npm install -g @anthropic-ai/claude-code`, Terminal neu öffnen. |
| „Claude CLI ist nicht angemeldet. …“ | `claude` starten, `/login`. |
| „PM2 fehlt. Erst installieren mit: npm install -g pm2“ | PM2 installieren, dann `tybo setup autostart`. |

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

- Alte Installationen suchen und übernehmen (Umgebungs-Scan aus Phase 0 der
  `CLAUDE.md`).
- Datenbank anlegen außer beim Weg „Supabase in der Cloud“: Für
  „Zugangsdaten selbst eintragen“ legst du Supabase-Projekt, Schema und
  Bilder-Ordner selbst an, für Convex Deployment und OIDC-Aussteller (siehe
  oben). Zwischen den Wegen zieht der Assistent keine Daten um.
- Supabase auf diesem Rechner (Docker) und Dauerbetrieb dafür.
- Semantische Suche (OpenAI-Schlüssel für Embeddings).
- Agenten anpassen, Topic-IDs zuordnen, eigene Bots pro Agent.
- Check-ins, Morgen-Briefing, Watchdog und Datenquellen (Gmail, Kalender,
  Notion, News).
- Sprache, Anrufe, Transkription, Erinnerungen über Convex, VPS.
- `pm2 startup` unter Linux (siehe Autostart).

Diese Punkte beschreibt die `CLAUDE.md` in ihren Phasen.
