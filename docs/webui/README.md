# tybo WebUI

Chat mit tybo im Browser, am Mac oder auf dem Handy im Heimnetz. Was die
WebUI am Ende können soll, steht in `SPEC.md`, die Gründe für Sicherheit und
Aufbau in `decisions/`.

## WebUI

### Einschalten

Die WebUI läuft im Bot-Prozess auf einem eigenen Port (Standard 3100) und ist
aus, solange nichts in `.env` steht. Zum Einschalten in `.env` eintragen:

```
WEB_ENABLED=true
WEB_PASSWORD=<mindestens 12 Zeichen, z. B. aus: openssl rand -base64 18>
```

Danach den Bot neu starten:

```bash
bun run restart:request "WebUI aktivieren"
```

Im Log (`logs/telegram-relay.log`) steht dann eine Zeile wie
`[web] WebUI läuft: http://127.0.0.1:3100`. Die Adresse im Browser öffnen und
mit dem Passwort anmelden. Man bleibt 30 Tage angemeldet.

Steht dort stattdessen `WebUI startet nicht: ...`, nennt die Zeile den Grund
(Passwort fehlt oder zu kurz, Port belegt, ungültiger Port). Der Telegram-Bot
läuft in jedem Fall normal weiter. Ist die WebUI aus, steht nur
`WebUI aus (WEB_ENABLED ist nicht true)` im Log.

Alle Einstellungen:

| Variable | Standard | Bedeutung |
|---|---|---|
| `WEB_ENABLED` | aus | `true` schaltet die WebUI ein |
| `WEB_PASSWORD` | keins | Pflicht, mindestens 12 Zeichen |
| `WEB_HOST` | `127.0.0.1` | nur dieser Rechner; `0.0.0.0` für das Heimnetz |
| `WEB_PORT` | `3100` | Port der WebUI (nicht der Health-Port) |
| `WEB_ALLOWED_HOSTS` | leer | weitere Host-Namen, z. B. `mein-mac.local` |
| `WEB_PUBLIC_ORIGIN` | leer | öffentliche Adresse hinter dem Cloudflare Tunnel, genau `https://<domain>` ohne Port und Pfad, z. B. `https://app.tybo.ai` (Entscheidung 0014). Getunnelt ist eine Anfrage nur, wenn sie von 127.0.0.1/::1 kommt und `CF-Connecting-IP` trägt; dann braucht sie einen gültigen Cloudflare-Access-Nachweis, es gelten nur dieser Host und dieser Origin, die Login-Bremse zählt pro Besucher-IP, das Cookie bekommt `Secure`, der Terminal-Schlüssel gilt nicht und Schlüssel sind nur lesbar. Ohne Einstellung bleibt alles wie im Heimnetz. Einrichtung: [fernzugang.md](fernzugang.md) |
| `WEB_ACCESS_TEAM` | leer | Team-Name von Cloudflare Zero Trust (`meinteam` für `meinteam.cloudflareaccess.com`), nur zusammen mit `WEB_ACCESS_AUD`. Fehlen beide bei gesetztem `WEB_PUBLIC_ORIGIN`, werden getunnelte Anfragen immer abgelehnt |
| `WEB_ACCESS_AUD` | leer | Application Audience (AUD) Tag der Access-Anwendung für app.tybo.ai |
| `WEB_ALLOW_KEY_EDIT` | aus | `true` erlaubt, Schlüssel in der WebUI zu setzen und zu löschen (`PUT`/`DELETE /api/keys/<name>`); einschalten wirkt nach einem Neustart, ausschalten sofort. `WEB_*`, `TELEGRAM_BOT_TOKEN` und `TELEGRAM_USER_ID` bleiben immer gesperrt. Vor jeder Änderung liegt eine Sicherung in `data/backups/env-<zeit>` |
| `TELEGRAM_GROUP_ID` | aus `config/topics.json` | Chat-ID der Forum-Gruppe (`-100…`), deren Topics die WebUI zeigt; ohne Angabe die erste Chat-ID mit `-` aus `config/topics.json`, ohne Gruppe nur der Direktchat |

### Im Heimnetz (Handy)

Mit `WEB_HOST=0.0.0.0` ist die WebUI von anderen Geräten im selben WLAN
erreichbar. Die Log-Zeile beim Start nennt dann alle Adressen, etwa
`[web] WebUI läuft: http://localhost:3100, http://192.168.1.20:3100`. Auf dem
Handy die Adresse mit der `192.168...`-IP öffnen. Wer den Mac über einen
Namen aufruft (`http://mein-mac.local:3100`), trägt diesen Namen in
`WEB_ALLOWED_HOSTS` ein, sonst antwortet die WebUI mit „Misdirected Request".

macOS fragt beim ersten Start eventuell, ob `bun` eingehende Verbindungen
annehmen darf. Ohne „Erlauben" kommt das Handy nicht durch.

### Sicherheit

- Der Web-Chat startet Claude Code mit allen Werkzeugen (Bash, Dateien, MCP).
  Wer das Passwort kennt, kann also Befehle auf dem Mac ausführen. Deshalb gibt
  es die WebUI nur mit Passwort, auch auf `127.0.0.1`.
- Im Heimnetz läuft die WebUI über HTTP, also unverschlüsselt. Wer im selben
  WLAN mitschneidet, sieht Passwort und Chat. Nur im eigenen WLAN nutzen, nie
  in einem öffentlichen. Aus dem Internet ist sie nicht erreichbar und soll es
  auch nicht werden (keine Portfreigabe im Router).
- Nach 10 falschen Passwörtern in 15 Minuten nimmt die WebUI von dieser IP
  keine Anmeldung mehr an, bis die Fehlversuche älter als 15 Minuten sind.
- Passwort und Schlüssel stehen nie im Log. Das Log nennt nur Adressen,
  Anmeldungen (mit IP) und Fehlertypen.
- Details: `decisions/0002-sicherheit.md`.

### Terminal-Zugang: Befehl `tybo` (M7)

`tybo` ist der Chat im Terminal über den laufenden Bot (Entscheidung 0010),
mit denselben Gesprächen wie Telegram und Browser. Voraussetzung ist die
eingeschaltete WebUI (siehe oben), denn `tybo` spricht mit ihr. Die
Einrichtung im Terminal (`tybo setup`) steht im nächsten Abschnitt.

Einmal im Projektordner ausführen, dann gibt es `tybo` in jedem Ordner:

```bash
bun link
tybo help
```

`bun link` legt `tybo` in `~/.bun/bin` ab, das bei der Bun-Installation in
den `PATH` kommt (siehe CLAUDE.md, Prerequisites). Ohne `bun link` geht es im
Projektordner mit `bun run tybo`. Wieder entfernen: `bun unlink` im
Projektordner.

Wie die Anmeldung funktioniert:

- Bei jedem Start der WebUI legt der Bot einen neuen zufälligen Schlüssel in
  `data/cli-token` ab (Rechte 0600, nur dieser Benutzer darf lesen). Beim
  Beenden wird die Datei gelöscht; nach einem Absturz bleibt sie liegen, gilt
  aber nicht mehr.
- `tybo` liest den Schlüssel und schickt ihn als `Authorization: Bearer`. Der
  Server nimmt ihn nur von Verbindungen über 127.0.0.1 oder ::1 an. Aus dem
  Heimnetz geht es nur mit dem WebUI-Passwort.
- `tybo` findet Projektordner, `.env` und Schlüssel über den Ort des Skripts,
  egal aus welchem Ordner man es aufruft. Die `.env` des aktuellen Ordners
  liest es nicht.
- Mit `WEB_HOST` auf einer festen Heimnetz-Adresse (etwa `192.168.1.20`)
  lauscht die WebUI nicht auf 127.0.0.1, `tybo` meldet das. Für Handy und
  Terminal zugleich `WEB_HOST=0.0.0.0` verwenden.
- Im Terminal geschriebene Nachrichten erscheinen in Telegram als
  „Du (Terminal): …", im Browser geschriebene als „Du (Web): …".

Läuft der Bot nicht, sagt `tybo` das und nennt den Startbefehl, statt selbst
einen Bot zu starten (zwei Bots mit demselben Telegram-Token stören sich).

Chatten (Issue #60):

```bash
tybo                     # zuletzt genutztes Gespräch, beim ersten Mal der Direktchat
tybo --topic Recherche   # direkt in ein Topic: Name, topic-<n>, <n> oder dm
echo "Frage" | tybo      # aus einer Pipe: senden, Antwort abwarten, beenden
```

- Welches Gespräch: `--topic` vor dem zuletzt genutzten (gemerkt in
  `~/.config/tybo/state.json`) vor dem Direktchat. Gibt es keinen Direktchat,
  General. Heißen zwei Topics gleich, nennt `tybo` beide IDs und wählt keins.
  Ist das gemerkte Gespräch gelöscht oder geschlossen, geht es mit Hinweis im
  Direktchat weiter.
- Oben stehen Gespräch und Agent, darunter die letzten 20 Nachrichten. Neue
  Nachrichten aus Telegram im selben Gespräch erscheinen live.
- Enter sendet, Alt+Enter oder `\` am Zeilenende beginnt eine neue Zeile,
  Pfeil hoch/runter holt frühere Eingaben (nur für diesen Start). Eingefügter
  Text mit mehreren Zeilen wird nicht zeilenweise gesendet.
- Während einer Antwort zeigt eine Statuszeile den Schritt („Durchsucht das
  Web …"). Strg+C stoppt die Antwort wie der Stopp-Knopf, ein zweites Strg+C
  innerhalb von 2 Sekunden beendet `tybo`. Ohne laufende Antwort zeigt Strg+C
  nur einen Hinweis, zweimal beendet. Strg+D bei leerer Eingabe beendet.
- Slash-Befehle im Terminal (Issue #61, seit Issue #74 aufgeteilt): Lokal
  bleiben `/tasten` (Tasten, Terminal-Befehle und die Befehle des Bots),
  `/gespraeche` (Liste mit Nummer, Name, Agent, letzter Aktivität),
  `/wechsel <Nr. oder Name>` (Nummer aus der zuletzt gezeigten Liste, auch
  `topic-<n>` oder `dm`), `/neu [Agent] [Titel]` (neues Topic wie „Neues
  Gespräch"; ist das erste Wort ein Agent, gilt es als Agent),
  `/zuordnen <Agent>` (Agent des Topics ändern, nicht im Direktchat, in
  General und in älteren Web-Gesprächen) und `/quit`. Alles andere mit `/`
  geht an den Bot wie eine Nachricht (siehe „Slash-Befehle in Browser und
  Terminal"). Tab ergänzt lokale Befehle, Befehle des Bots, Gesprächs- und
  Agentennamen. Eine Nachricht, die mit einem lokalen Befehl beginnen soll,
  mit `//` schreiben.
- Slash-Befehle in Browser und Terminal (Issue #74, Entscheidung 0013): Beginnt
  eine Nachricht mit einem Befehl des Bots, führt der Server ihn aus wie in
  Telegram, statt Claude zu fragen: `/new` (bzw. `/reset`), `/stop` (bzw.
  `/abbruch`), `/agent`, `/topics`, `/help` (bzw. `/hilfe`), `/goal`, `/goals`,
  `/learn`, `/plan`, `/critic <idee>`, `/board [thema]`, `/routine`, `/voice <text>`. Die Nachricht erscheint in
  Telegram gespiegelt („Du (Web): /new", „Du (Terminal): …"), die Antwort des
  Befehls kommt als Meldung „Befehl" ins Gespräch und in Telegram. Ältere reine
  Web-Gespräche spiegeln nichts, die Meldung steht nur in ihrem Verlauf.
  `/stop` (bzw. `/abbruch`), `/goal pause` und `/goal stop` (samt Aliasen
  `cancel`, `done`, `abbrechen`) gehen auch, während eine Antwort oder eine
  Rückfrage läuft; alle anderen Befehle warten wie eine Nachricht. Unbekannte Befehle (`/foo`) gehen als Text an Claude.
  `/k3` ist entfallen.
- `/voice <text>` (Issue #78): Antwort wie bei `/critic` als Text in Browser
  bzw. Terminal und in Telegram, danach dieselbe Antwort als Sprachnachricht
  im gespiegelten Telegram-Gespräch (Haupt-Bot). Browser und Terminal zeigen
  „Sprachnachricht in Telegram gesendet." oder, wenn Synthese oder Versand
  scheitern, einen Hinweis; die Antwort bleibt als Text stehen. Ohne
  eingerichtete Stimme (lokales TTS, ElevenLabs oder Gemini) und in älteren
  reinen Web-Gesprächen gibt es nur einen Hinweis, keinen Turn. Kein Audio im
  Browser oder Terminal (SPEC: keine Sprachausgabe). WAV wird mit ffmpeg nach
  Ogg/Opus gewandelt; ohne ffmpeg gibt es nur den Text und einen Hinweis.
  Stopp während der Synthese: Text bleibt, „Sprachnachricht abgebrochen.".
- `/board [thema]` (Issue #75): alle Board-Agenten nacheinander, dann die
  Zusammenfassung von General. Im Browser erscheint jeder Beitrag als eigene
  Nachricht mit Name und Farbe des Agenten, im Terminal mit Sprecher-Zeile;
  der Fortschritt nennt den Agenten, der gerade nachdenkt. In Telegram kommen
  dieselben Beiträge von den Agenten-Bots. Jeder Beitrag wird einzeln
  gespeichert und steht nach dem Neuladen im Verlauf. Stopp-Knopf, Strg+C
  und `/stop` beenden die Sitzung nach dem laufenden Beitrag (ohne
  Zusammenfassung); ein zweites `/stop` bricht sofort ab. Die Liste liefert `GET /api/commands` (Name, Aliasse,
  Beschreibung, Argumente), gefiltert nach Browser oder Terminal.
- `/goal` (Issue #76): `/goal <ziel>`, `/goal status|pause|weiter|stop`,
  `/goal max <n>`, `/goal gate add|list|clear` gehen in Browser und Terminal
  wie in Telegram (nur Direktchat und Topics, nicht ältere Web-Gespräche).
  Über der Eingabe zeigt eine Karte das Ziel: Zustand (aktiv, arbeitet,
  pausiert), „Runde x von n", Agent, letzter Befund und die Knöpfe Pause,
  Weiter bzw. „Weiter (+5)" nach dem Turn-Budget, Stopp. Die Knöpfe wirken wie
  die Telegram-Knöpfe und Befehle (`/goal weiter` gibt keine zusätzlichen
  Runden, „Weiter (+5)" schon; Pause lässt die laufende Runde auslaufen; Stopp
  löscht das Ziel und bricht ab). Jede Änderung, auch aus Telegram, erreicht
  die Karte live (SSE-Ereignis `goal`), nach dem Neuladen holt
  `GET /api/conversations/<id>/goal` den Stand. Knöpfe:
  `POST /api/conversations/<id>/goal` mit `{ action, goalId }`; passt der Knopf
  nicht mehr (anderes Ziel, schon gedrückt), antwortet der Server mit 409 und
  der aktuellen Karte. Pause-, Warte- und Fertig-Meldungen stehen zusätzlich
  als Meldung „Ziel" im Verlauf, die Antworten der Ziel-Runden als Nachricht
  des Agenten.
- Budget-Frage „Weiter?" (seit Issue #118): Ist das Turn-Budget aufgebraucht,
  fragt tybo über das Rückfragen-Register mit den Knöpfen „Weiter (+5)" und
  „Beenden", in Telegram und im Verlauf des Browsers. Die Frage gehört zu
  genau diesem Ziel: ihr Knopf wirkt nie auf ein späteres Ziel im selben
  Gespräch. „Weiter (+5)" und „Stopp" in
  der Karte entscheiden die offene Frage mit, Telegram zeigt danach
  „✓ Weiter (+5) (im Browser)", ein zweiter Klick dort meldet „Schon
  erledigt". Umgekehrt zieht ein Klick in Telegram oder auf die Frage im
  Verlauf die Karte nach. Offen bleibt die Frage nur, solange das Ziel am
  Budget pausiert; `/goal stop`, `/goal pause`, ein neues `/goal`,
  `/goal weiter`, `/goal max` oder ein erreichtes Ziel lassen sie ablaufen.
  Ist die Frage schon entschieden und der Gewinner noch nicht fertig, meldet
  die Karte „veraltet“ statt selbst zu handeln. Alte Knöpfe von
  vor dem Update wirken auf das Ziel, das gerade im Gespräch steht, ohne Ziel
  „Kein Ziel mehr aktiv.".
- `[INVOKE:agent|Frage]` (Issue #76): Rückfragen aus Antworten im Browser
  laufen wie in Telegram (höchstens `AGENT_INVOKE_BUDGET`, nur erlaubte
  Agenten, keine verschachtelten Rückfragen). Die Antwort erscheint als eigene
  Nachricht mit Name und Farbe des gefragten Agenten, in Telegram vom Bot des
  Agenten, und steht nach dem Neuladen im Verlauf. Rückfragen aus Telegram
  werden seitdem ebenfalls gespeichert und erscheinen so im offenen Browser.
  Stopp-Knopf, Strg+C und `/stop` brechen die laufende Rückfrage ab und
  starten keine weitere; die schon gespeicherte Antwort bleibt stehen, danach
  folgt „Abgebrochen.".
- Anhänge (Issue #72, Entscheidung 0012), bisher nur über die Schnittstelle,
  die Oberfläche folgt: `POST /api/conversations/<id>/attachments` nimmt eine
  Datei als Rohdaten an, den Namen prozentkodiert in `X-File-Name`. Erlaubt
  sind Bilder (PNG, JPEG, GIF, WebP, bis 20 MB), PDF (bis 20 MB) und
  Sprachdateien (OGG, MP3, M4A, WebM, WAV, bis 25 MB); die Art erkennt der
  Server an den ersten Bytes, nie an Name oder Content-Type (SVG und HTML
  werden abgelehnt). Antwort `{ id, name, size, mime, kind }`, abgelegt unter
  `data/uploads/<Gespräch>/<id>/`. Danach `POST .../messages` mit
  `{ text, attachments: [id] }` (höchstens 5, Text darf leer sein). Jede Datei
  läuft wie in Telegram durch den Medien-Kern (Bild in den Asset-Speicher mit
  Beschreibung, PDF, Transkription; Arbeitsdateien unter `uploads/web/`,
  getrennt von denen aus Telegram), in Telegram erscheint sie vom Haupt-Bot
  als Foto bzw. Dokument mit „Du (Web): <Text>". Verlauf und Live-Ereignisse
  zeigen die Anhänge der eigenen Nachricht mit Download-Adresse
  (`GET .../attachments/<id>`, bei Bildern `?inline=1` als Vorschau). Nicht
  mit Befehlen und nicht als Antwort auf eine Rückfrage. Nicht abgeschickte
  Anhänge löscht der Bot nach 24 Stunden.
- Anhänge und Aufnahme in reinen Web-Gesprächen (Issue #112): dieselben Wege
  (Büroklammer, Ziehen, Einfügen, `/b64`, Mikrofon im sicheren Kontext),
  Grenzen und Routen wie oben, dieselbe Verarbeitung, aber nichts wird nach
  Telegram gespiegelt. Arbeitsdateien liegen unter `uploads/web/<Gespräch>/`.
  Ein Anhang gehört genau einem Gespräch: in einem anderen lässt er sich weder
  senden noch abrufen. Löschen des Gesprächs löscht seine Anhänge (abgeschickt
  und offen) und die Arbeitsdateien mit; Bilder im Asset-Speicher und der
  Verlauf im gemeinsamen Gedächtnis bleiben, wie beim Löschen eines Topics.
  Merk-Tags aus Turns mit Bild oder PDF kommen als Vorschlag mit Knöpfen ins
  Web-Gespräch (seit Issue #117, vorher nur in den Direktchat), siehe unten.
- Antworten erscheinen formatiert (Überschriften, Listen, Fett, Code). HTML aus
  Antworten bleibt sichtbarer Text, Steuerzeichen (Farben, Fenstertitel,
  Zwischenablage) aus Nachrichten und Topic-Namen werden entfernt.
- Mit `NO_COLOR`, `TERM=dumb` oder ohne Terminal (Pipe) gibt `tybo` schlichten
  Text ohne Escape-Sequenzen aus, auch im Status. Die Eingabe läuft dann
  zeilenweise über das Terminal selbst: mehrzeilig mit `\`, ohne eigenen
  Verlauf und ohne Alt+Enter.

### Einrichtung im Terminal: `tybo setup` (M8)

Führt durch die Einrichtung (Entscheidung 0011), ohne CLAUDE.md zu lesen.
Anleitung für Neulinge mit allen Schritten, Feldern und typischen Fehlern:
[`docs/einrichtung.md`](../einrichtung.md). Schnellstart auf einem frischen
Rechner, im Projektordner:

```bash
bun install
bun link
tybo setup
```

Ohne `bun link` geht es mit `bun run setup`. Das alte Prüfskript
`setup/install.ts` bleibt als `bun run setup:install` aufrufbar, ebenso die
übrigen `setup/*`-Skripte.

- `tybo setup` zeigt alle Schritte mit Stand (Voraussetzungen, Telegram,
  Forum-Gruppe, Datenbank, Profil, Modelle, WebUI, Autostart) und geht dann
  die offenen der Reihe nach durch. Erledigte werden übersprungen, außer man
  gibt nach der Übersicht ihre Nummern ein. Optionale Schritte fragen vorher
  „Jetzt einrichten?".
- `tybo setup <schritt>` nur ein Schritt, auch wenn er erledigt ist
  (`voraussetzungen`, `telegram`, `gruppe`, `datenbank`, `profil`, `modelle`,
  `webui`, `autostart`, `pruefung`). `tybo setup --liste` zeigt nur die
  Übersicht; es schreibt nichts und testet keine Verbindung.
- Gesetzte Werte erscheinen nur als „gesetzt"; Enter behält sie. Geheime
  Eingaben bleiben unsichtbar, auch ohne Sternchen. Auswahlfelder, von denen
  weitere Felder abhängen (Datenbank, WebUI an/aus), werden jedes Mal neu
  beantwortet.
- Reihenfolge je Schritt: Eingaben, Verbindungstest mit den noch nicht
  gespeicherten Werten, Zusammenfassung ohne Werte, Bestätigung, dann erst
  schreiben (`.env` mit Sicherung, atomar, 0600). Schlägt der Test fehl:
  erneut eingeben (Enter übernimmt die vorige Eingabe) oder überspringen.
  Profil und WebUI haben keinen Verbindungstest.
- Autostart startet den Bot sofort über launchd bzw. PM2. Der Schritt warnt
  davor und fragt mit Standard „Nein".
- Am Ende läuft immer die Gesamtprüfung mit den gespeicherten Werten, auch
  für schon erledigte Schritte (dabei kommt eine Testnachricht in Telegram).
  Schlägt ein Schritt dabei fehl, bietet `tybo setup` ihn zum erneuten
  Eingeben bzw. Prüfen oder zum Überspringen an; was danach noch
  fehlschlägt, steht in der Zusammenfassung. Danach: was gespeichert, übersprungen und noch offen ist, der nächste
  Schritt (Bot starten oder Autostart) und, bei eingeschalteter WebUI,
  `tybo` und die Adresse.
- Strg+C bricht jederzeit ab (Exit-Code 130). Während Eingabe, Test und
  Bestätigung ist im laufenden Schritt nichts geschrieben. Kommt Strg+C
  während des Schreibens, läuft es zu Ende, dann ist Schluss. Schon
  gespeicherte Schritte bleiben. Profil und Modelle schreiben zwei Dateien
  nacheinander; einen gemeinsamen Rückbau gibt es nicht, die Meldung nennt,
  was schon gespeichert ist, auch beim Abbruch nach einem Teilfehler.
- Nicht dabei: Installieren von Abhängigkeiten, Convex-Deployments.

### Einrichtung im Browser: Einrichtungsmodus (M8)

Fehlt beim Start `TELEGRAM_BOT_TOKEN` oder `TELEGRAM_USER_ID` (leer oder
noch der Platzhalter aus `.env.example`), beendet sich tybo nicht mehr mit
„FATAL“, sondern startet den Einrichtungsmodus (Entscheidung 0011). Bewusst
geht das auch mit `tybo setup --web`, dann ohne laufenden Bot.

- Kein Telegram, keine Claude-Aufrufe: nur ein kleiner Server mit dem
  Assistenten, immer auf `127.0.0.1` und `WEB_PORT` (Standard 3100), auch wenn
  `WEB_HOST=0.0.0.0` gesetzt ist. Erreichbar nur auf diesem Rechner unter
  `http://127.0.0.1:3100` oder `http://localhost:3100`.
- Im Terminal bzw. im Log (`logs/telegram-relay.log` unter launchd) steht ein
  Einmal-Code aus 8 Zeichen, etwa `K7MP-2QXR`. Groß- und Kleinschreibung,
  Leerzeichen und Bindestrich sind egal. Falsche Codes bremst dieselbe Sperre
  wie beim Login (10 Fehlversuche in 15 Minuten).
- Links die Schritte mit Stand, rechts der aktuelle Schritt mit „Testen“ und
  „Speichern“. Gespeicherte Werte erscheinen nur als „gesetzt“; leere Felder
  behalten sie. `TELEGRAM_*` und `WEB_*` lassen sich hier setzen, im Reiter
  „Schlüssel“ der WebUI bleiben sie gesperrt.
- Ob die Claude CLI angemeldet ist, prüft der Einrichtungsmodus nicht (das
  wäre ein Modellaufruf). Im Terminal mit `claude` prüfen oder `tybo setup
  voraussetzungen` nutzen.
- „Fertig“ geht, sobald Voraussetzungen, Telegram, Datenbank und Profil
  erledigt sind. Danach gelten weder der Code noch offene Browser-Sitzungen.
  Läuft tybo unter launchd oder PM2, startet er neu und diesmal normal.
  Sonst richtet „Fertig“ auf Wunsch den Autostart ein (erst nachdem der
  Assistent geschlossen hat) oder nennt den Startbefehl.
- Strg+C beendet den Einrichtungsmodus ohne Abschluss (Exit-Code 130);
  gespeicherte Schritte bleiben.

### Wie der Web-Chat mit dem Bot zusammenhängt

- Jedes Web-Gespräch hat eine eigene Chat-ID `web:<Gesprächs-ID>` und damit
  eine eigene Claude-Session, getrennt von allen Telegram-Topics. Es nutzt
  denselben Chat-Kern wie Telegram: gleiche Agenten, gleicher Fallback
  (OpenRouter, Ollama), gleiche Warteschlange.
- Dass eine Nachfrage wie „Und kürzer?" in derselben Claude-Session
  weiterläuft, setzt `SESSION_MODE=resume` in `.env` voraus. Ohne diese
  Einstellung bekommt jede Nachricht eine frische Session und sieht die
  vorigen Nachrichten nur über den Verlauf im Prompt.
- Nachrichten und Antworten landen im gemeinsamen Gedächtnis (Supabase bzw.
  Convex, mit `metadata.channel = "web"`). `[REMEMBER:]`- und `[GOAL:]`-Tags in
  Antworten werden wie in Telegram verarbeitet.
- Den Verlauf, den der Browser anzeigt, speichert die WebUI zusätzlich lokal in
  `data/web/`, Anmeldungen in `data/web-sessions.json`.
- Der Stopp-Knopf bricht die laufende Antwort ab, auch wenn sie noch in der
  Warteschlange steht. Abgebrochene Antworten kommen nicht ins Gedächtnis.
- Ein angeforderter Neustart (`bun run restart:request`) wartet auch auf
  laufende Web-Antworten. Wird der Bot trotzdem mitten in einer Antwort
  beendet, zeigt der Web-Chat denselben Hinweis wie Telegram („Der Bot wurde
  waehrend der Verarbeitung beendet ..."), und der Browser verbindet sich nach
  dem Neustart neu. Die Meldung „Neustart mit neuem Code" kommt weiter per
  Telegram.

### Direktchat und Topics im Browser (M2)

- Wer im Browser in den Direktchat oder ein Topic schreibt, führt dieselbe
  Unterhaltung wie in Telegram (`decisions/0004-topics-gespiegelt.md`): gleiche
  Chat-ID, gleiches Topic, gleiche Claude-Session (`dm:<ID>`,
  `topic:<Gruppe>:<Topic>`, General als `group:<Gruppe>`) und dieselbe
  Warteschlange wie eine Telegram-Nachricht an denselben Agenten.
- Zuerst postet der Haupt-Bot die Nachricht als Klartext „Du (Web): …" in
  Telegram. Klappt das nicht, läuft nichts weiter und der Browser meldet es.
  Die Antwort sendet danach der Agenten-Bot wie gewohnt (ohne Steuer-Tags),
  und sie erscheint zugleich im Browser.
- Beide Nachrichten liegen im Nachrichtenspeicher mit `channel = "web"`,
  `topicId` (bei Direktchat und General leer) und einer `msgId` der Form
  `web-<uuid>`. Gespeichert werden sie erst zusammen mit der Antwort; während
  der Turn läuft, fehlt die eigene Nachricht nach dem Neuladen also noch.
  Unter derselben ID zeigen alle offenen Browser beide Nachrichten live,
  deshalb gibt es beim Nachladen keine Doppelungen.
- Stopp beendet den Turn über den Telegram-Schlüssel, wie `/stop` in Telegram:
  Ein gleichzeitig laufender Telegram-Turn in diesem Gespräch endet mit. Nach
  einem angenommenen Stopp geht kein weiterer Teil der Spiegelung und keine
  Antwort nach Telegram, und von diesem Turn wird nichts gespeichert. Schon
  gespiegelte Teile bleiben in Telegram stehen.
- Werkzeug-Freigaben aus solchen Turns (seit Issue #116) erscheinen als
  Rückfrage mit Knöpfen im Telegram-Gespräch des Turns und von dort auch im
  Browser; dort wirkt zusätzlich „ja“ als Text.
- Nachrichten, die direkt in Telegram geschrieben werden, erscheinen im
  Browser erst nach dem Neuladen des Gesprächs (Live-Übertragung folgt).

### Grenzen (Stand M1)

- Ein Gespräch mit dem General-Agenten, noch keine Gesprächsliste (kommt in M2)
  und keine Einstellungsseiten (M3).
- (Stand M1, seit M5 überholt: Befehle, `/board`, `/goal` und `[INVOKE:]`
  gehen im Web, siehe oben.)
- Stellt Claude eine Rückfrage, erscheint sie als normaler Text; die Antwort
  tippt man als nächste Nachricht ein. (Stand M1, für Werkzeug-Freigaben seit
  Issue #116 überholt: Die Frage kommt aus dem Rückfragen-Register, steht im
  Gespräch des Turns mit den Knöpfen „Erlauben“ und „Ablehnen“, bei reinen
  Web-Gesprächen zusätzlich als Kopie im Telegram-Direktchat mit dem Hinweis
  „(Web-Gespräch „<Titel>“)“. Knopf in Telegram, Knopf im Browser oder „ja“
  (auch „ok“, „erlauben“) als Text im Browser oder Terminal entscheiden genau
  einmal; jede andere Text-Antwort, Stopp oder 10 Minuten ohne Entscheidung
  lehnen ab. Alte Knöpfe von vor dem Update melden „Freigabe abgelaufen“.)
- Fakten und Ziele sind zwischen Telegram und Web geteilt. Die Suche nach
  früheren Nachrichten (semantische Suche, Verlauf im Prompt) bleibt dagegen
  pro Chat-ID: Ein Web-Gespräch findet keine Telegram-Nachrichten und
  umgekehrt.
- (Stand M1, seit Issue #117 überholt: Endet die Claude-Session eines
  Web-Gesprächs, fragt das Session-Review jetzt auch dort per Knopf nach.)
- Merk-Vorschläge und Routine-Angebote (seit Issue #117) kommen aus dem
  Rückfragen-Register: Session-Rückblick und Turns mit fremden Inhalten legen
  den Vorschlag in `data/pending-reviews.json` und dazu eine Rückfrage mit den
  Knöpfen „Übernehmen“/„Verwerfen“ bzw. „Als Routine speichern“/„Verwerfen“
  an, gültig 7 Tage. Sie steht im Gespräch, aus dem sie kommt (Topic,
  Direktchat, Web-Gespräch), bei reinen Web-Gesprächen zusätzlich als Kopie
  im Telegram-Direktchat; auch Vorschläge aus der Sprach-Brücke. Ein Klick in
  Telegram oder im Browser entscheidet genau einmal, das Ergebnis
  („Übernommen: …“, „Verworfen, nichts gespeichert.“, Routine-Bericht) kommt
  als Nachricht in Telegram und im Browser. Alte Knöpfe von vor dem Update
  wirken weiter, nach 7 Tagen melden sie „abgelaufen“. Mit
  `DISTILL_AUTO_APPLY=true` schreibt der Session-Rückblick wie bisher direkt;
  Merk-Tags aus fremden Inhalten bleiben immer Vorschlag.
- Topic-Zuordnung „Welcher Agent?" (seit Issue #119): Schreibt der Nutzer in
  Telegram in ein Topic ohne Agenten, fragt tybo einmal über das
  Rückfragen-Register, mit einem Knopf je aktivem Agenten (Anzeigename). Die
  Frage steht in Telegram und im Verlauf des Topics im Browser. Ein Klick
  (egal wo) schreibt die Zuordnung genau einmal nach `config/topics.json`;
  danach steht im Browser „Erledigt: Research Agent (Deep Research) · im
  Browser", in Telegram „✓ Research Agent (Deep Research) (im Browser)", und
  der Chip in der Kopfzeile wechselt ohne Neuladen. Wird das Topic vorher
  anders zugeordnet (Einstellungen, Anlegen im Browser mit Agent, alter
  Knopf), läuft die Frage ab; ein späterer Klick überschreibt nichts. Ist der
  Agent inzwischen gelöscht oder scheitert das Schreiben, kommt eine Meldung
  im Topic (Telegram und Browser). Die Frage hat keine eigene Frist, das
  Register räumt offene Fragen aber nach 7 Tagen ab („Abgelaufen"); dann
  geht die Zuordnung über die Einstellungen. Topics außerhalb der
  Forum-Gruppe der WebUI fragen wie früher nur in Telegram, alte
  `topicmap:`-Knöpfe wirken weiter.
- Die Antwort kommt am Stück, nur der Fortschritt (Werkzeug, erster Satz) läuft
  live mit.
- Dateien, Bilder und Sprachdateien gehen bisher nur über die Schnittstelle
  (Oberfläche folgt in M4), Sprachaufnahme im Browser erst mit HTTPS.

### Ohne Bot ausprobieren (Entwicklung)

```bash
WEB_ENABLED=true WEB_PORT=3199 WEB_PASSWORD=dev-passwort-123 bun run web:dev
pkill -f scripts/web-dev.ts   # beenden
```

`web:dev` startet nur den Web-Server mit einer Attrappe statt Claude, ohne
Telegram. Sein Terminal-Schlüssel liegt in `data/web-dev/cli-token`, nie in
`data/cli-token` des Bots. `tybo` dagegen:

```bash
bun run tybo --dev   # Port 3199 (anders: TYBO_DEV_PORT), Schlüssel aus data/web-dev/cli-token
```

`--dev` liest weder die `.env` noch `data/cli-token` und merkt sich das
Gespräch in `~/.config/tybo/state-dev.json`, getrennt vom echten Stand. Wer an der WebUI baut: nie `src/bot.ts` starten (er würde mit demselben Telegram-Token pollen wie der laufende Bot), ausprobieren mit `bun run web:dev` auf Port 3199, vor jedem Pull Request `bun run check`.
