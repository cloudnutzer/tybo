# Motorwechsel von Hand abnehmen

Diese Abnahme läuft am echten, bereits laufenden tybo nach Übernahme der
Änderungen in `master`: WebUI unter `http://<Mac-IP>:3100` im Heimnetz und,
wenn eingerichtet, dasselbe Gespräch in Telegram. Ein Entwickler-Testserver
ist dafür nicht geeignet. Es wird kein weiterer Bot gestartet.

Geprüft werden die eingerichteten Motorstufen, ihre Werkzeuge, ein Wechsel
mit Gesprächsverlauf und der Fall „keine Stufe frei“. Die Ersatzmodelle mit
eingeschränktem Werkzeugumfang sind das letzte Netz, keine Motorstufe.
Einrichtung: [Ersatzstufen und Automatik](../erweiterungen.md#ersatzstufen-und-automatik).

## Vorbereitung und Ausgangsstand

1. WebUI öffnen, anmelden und mit „Neues Gespräch“ ein Test-Gespräch mit
   dem Agenten General anlegen, etwa „Motorabnahme“. Andere Aufträge während
   der Übungen ruhen lassen: Motorreihenfolge und Automatik gelten allgemein.
2. Unter Einstellungen, „Modelle“, „Motor“ den bisherigen Stand abschreiben
   oder als Bildschirmfoto festhalten: Standard-Motor, alle Ersatzstufen in
   ihrer Reihenfolge samt Modell und Effort, Automatik, „Wechseln ab (%)“
   und „Zurück unter (%)“, einschließlich leerer Felder. Auch die Modelle,
   Effort und Rechte von Codex und OpenCode sowie „Standard für alle Agenten“
   notieren. Unter „Agenten“ Motor, Modell und Effort von General notieren.
3. Für den vollständigen Lauf diese Reihenfolge einstellen und speichern:
   Claude Code mit dem Standardmodell, Claude Code mit einem anderen Modell
   (Beispiel `claude-opus-5-5`), Codex, OpenCode. Die erste Stufe verwendet
   zum Beispiel `claude-fable-5-2`. Nicht installierte Motoren erst nach ihrer
   Einrichtung prüfen; eine ausgelassene Stufe im Protokoll vermerken. Für
   die Übung „keine Stufe frei“ müssen Claude Code und Codex bereit sein.
   General für die Abnahme bei Motor, Modell und Effort auf den allgemeinen
   Standard stellen und speichern, damit seine eigenen Werte die erste
   Stufe nicht verändern. Die ursprünglichen Werte bleiben im Protokoll.
4. Für Codex und OpenCode ein vorhandenes Modell ausdrücklich auswählen und
   speichern. Sonst kann die Metazeile nur den Motor nennen, weil tybo das
   intern gewählte Modell nicht kennt. Bei OpenCode über OpenRouter vorher
   das Limit am Schlüssel beim Anbieter prüfen: Diese Stufe kostet je
   Verbrauch. Für die letzte Übung muss außerdem ein Ersatzmodell über
   OpenRouter oder Ollama eingerichtet und erreichbar sein, siehe
   [Modelle und Fallback](../einrichtung.md#7-modelle-und-fallback-optional).
5. Automatik einschalten, Schwelle auf 95 setzen und „Zurück unter (%)“ leer
   lassen, damit 80 gilt; speichern. Im Test-Gespräch `/motor auto an`,
   `/motor standard`, `/motor` und `/motor werkzeuge` nacheinander senden.
   Die Ausgaben aufheben. Erwartet: die eingerichtete Reihenfolge, Automatik
   an und der Werkzeugbestand samt Lücken. Unter Einstellungen, „Status“,
   die Zeilen „Werkzeuge“ vergleichen. Codex bekommt MCP-Server nur bei
   „Voller Zugriff“; vorhandene Einschränkungen nicht für ein grünes Ergebnis
   aufheben, sondern im Protokoll nennen.
6. Einen echten Codex-Stand holen: `/motor codex` senden, dann „Antworte nur
   mit bereit.“ Nach der Antwort `/motor standard` und `/motor pruefen`
   senden und die Prüfung abwarten. Diese misst Claude Code; Codex misst
   erst nach seinem eigenen Chat-Lauf. Ist eine echte Sperre aktiv oder
   liegt ein benötigtes Fenster bei oder über der Rückkehrschwelle, die
   künstlichen Sperrübungen bis zum echten Reset verschieben.
7. Ein Terminal am Rechner des Bots öffnen und in den **Projektordner der
   laufenden Installation** wechseln. Beim Installer ist das gewöhnlich
   `~/tybo`; bei anderem Installationsort dessen Pfad einsetzen:

   ```sh
   cd ~/tybo
   bun run limits show
   ```

   `data/` wird relativ zu diesem Arbeitsordner gelesen. Die Befehle weder
   in einem zweiten Checkout noch in einem Arbeitsordner einer Pipeline
   ausführen. Die komplette Ausgabe aufheben. Sie ist JSON mit Listen unter
   `claude` und `codex`. Für jedes später veränderte Fenster `id`, `percent`
   und `resetsAt` notieren, dazu `measuredAt`, `source` und `state` zur
   Einordnung. `state: "expired"` hat keinen gültigen Prozentwert. Fehlt ein
   Fenster ganz, „kein Stand“ notieren. Keine Messdatei von Hand bearbeiten.

Erfundenes Protokoll, **keine Werte zum ungeprüften Zurückschreiben**:

| Motor | Fenster (`id`) | `percent` | `resetsAt` | `measuredAt` | `source` |
|---|---|---|---|---|---|
| Claude Code | `weekly_all` | 42 | `2027-01-17T18:00:00Z` | `2027-01-15T10:00:00Z` | `report` |
| Claude Code | `weekly_scoped:fable` | 30 | `2027-01-17T18:00:00Z` | `2027-01-15T10:00:00Z` | `report` |
| Codex | `weekly_all` | 31 | `2027-01-17T18:00:00Z` | `2027-01-15T10:00:00Z` | `session-file` |

Vor jeder Sperrübung eine neue Reset-Zeit zwei Stunden in der Zukunft
erzeugen. Unter macOS diesen Befehl im selben Terminal ausführen:

```sh
MOTOR_RESET=$(date -u -v+2H +%Y-%m-%dT%H:%M:%SZ)
printf '%s\n' "$MOTOR_RESET"
```

Unter Linux stattdessen:

```sh
MOTOR_RESET=$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)
printf '%s\n' "$MOTOR_RESET"
```

Am erfundenen Prüftermin 15.01.2027 um 10:00 UTC wäre das
`2027-01-15T12:00:00Z`. Die folgenden Sperrbefehle verwenden die frisch
erzeugte Variable. `--resets-at` verlangt ISO-Zeit mit `Z` oder einem Offset
wie `+01:00`. Chat-Zeiten folgen der Nutzerzeitzone, Terminal-Zeiten der
Systemzeitzone; 12:00 UTC wäre im deutschen Winter 13:00 Uhr.

Die Motorwahl folgt dem Vorrang Gespräch, Agent, Standard. `/motor standard`
entfernt nur die Gesprächswahl. Deshalb bleibt General während dieser
Abnahme beim Motor „Standard“; nach der Abnahme auch dessen ursprüngliche
Motorwahl wiederherstellen.

## So kontrollierst du jede Stufe

Vor jedem der acht Aufträge `/motor` senden. Die erste Zeile sagt
„antwortet“, „springt ein“, bei einem Agentenwunsch „für diesen Agenten
eingestellt“ oder bei einem Gesprächswunsch „von Hand gewählt“;
in der Reihenfolge steht an der ausgewählten Stufe „antwortet“. Nach der
Antwort in der **WebUI** die Metazeile darunter lesen und Motor und Modell
mit dem Protokoll vergleichen. Die Pille und `/motor` zeigen die aktuelle
Wahl für die nächste Nachricht; sie allein belegen keine ältere Antwort.

In **Telegram** gibt es unter normalen Antworten keine Motor-Modell-Zeile.
Dort `/motor` vor dem Auftrag verwenden und die konkrete Antwort zusätzlich
im selben Gespräch der WebUI kontrollieren. Fehlt dort trotz ausdrücklich
eingestelltem Modell die passende Kennzeichnung oder antwortet eine andere
Stufe, zählt der Versuch nicht für die gewünschte Stufe. Zustand notieren,
Ursache klären und erst dann wiederholen.

| Zu prüfende Stufe | Auswahlweg und Kontrolle |
|---|---|
| A: Standard-Motor mit Standardmodell | Ohne aktive Sperre `/motor standard`. `/motor` nennt die erste Stufe als „antwortet“. Metazeile: Claude Code und das protokollierte Standardmodell. |
| B: Claude Code mit eigenem Ersatzmodell | Den stabilen Weg im folgenden Abschnitt verwenden. Metazeile muss genau das Ersatzmodell nennen. |
| C: Codex | `/motor codex`, dann `/motor`. Codex steht vorn, „von Hand gewählt“ und in der Reihenfolge „antwortet“. Metazeile: Codex und das ausdrücklich eingestellte Modell. |
| D: OpenCode | `/motor opencode`, dann `/motor`. Kontrolle wie bei Codex, mit OpenCode und dem eingestellten Anbietermodell. |
| Weitere Claude-Stufe | Den Weg B mit deren Modell und Effort wiederholen, eine weitere Protokolltabelle anlegen. |

### Claude-Ersatzmodell über alle acht Aufgaben prüfen

Eine künstliche Teil-Limit-Sperre ist dafür zu kurzlebig: Schon ein weiterer
Claude-Lauf kann echte Messwerte liefern und sie wieder lösen. Deshalb:

1. Modell und Effort unmittelbar vor diesem Teiltest nochmals notieren.
   Unter Einstellungen, „Agenten“, General prüfen. Hat er ein eigenes
   Modell oder Effort, für die Prüfung auf den allgemeinen Standard stellen
   und speichern; die bisherigen Werte sind jetzt notiert.
2. Unter „Modelle“, **„Standard für alle Agenten“**, Modell vorübergehend auf
   das Modell der Ersatzstufe stellen, etwa `claude-opus-5-5`. Auch deren
   Effort einstellen, sofern sie einen hat; sonst den bisherigen Effort
   beibehalten. In diesem Abschnitt speichern.
3. Im Test-Gespräch `/motor claude`, danach `/motor` senden. Claude Code muss
   antworten können. Alle acht Aufgaben stellen und bei jeder Antwort die
   Metazeile auf das Ersatzmodell prüfen. Das prüft Motor, Modell und
   Werkzeuge dieser Stufe; das automatische Einspringen folgt getrennt.
4. Standardmodell und Effort sowie General auf die Werte vor diesem Teiltest
   zurückstellen und jeweils speichern. `/motor standard` senden und mit
   einer kurzen Antwort die ursprüngliche erste Stufe kontrollieren.

Dieser Weg funktioniert auch, wenn erste und zweite Claude-Stufe dieselbe
Modellfamilie nutzen. `/motor` nimmt nur einen Motornamen, kein zusätzliches
Modellargument.

### Kurze Kontrolle „springt ein“ mit einem Teil-Limit

Nur wenn die erste Stufe zum Beispiel Fable und die direkt folgende
Claude-Stufe Opus verwendet und beide sonst frei sind:

1. `bun run limits show` ausführen und den echten Stand von
   `weekly_scoped:fable` sichern. Im Gespräch `/motor standard` und direkt
   vor dem Sperren `/motor pruefen` senden, dessen Ende abwarten.
2. Eine frische Variable `MOTOR_RESET` wie oben erzeugen, dann im Terminal:

   ```sh
   bun run limits set --engine claude --window weekly_scoped:fable --percent 96 --resets-at "$MOTOR_RESET"
   ```

   Vollständig ausgeschrieben am erfundenen Prüftermin wäre der Befehl:

   ```sh
   bun run limits set --engine claude --window weekly_scoped:fable --percent 96 --resets-at 2027-01-15T12:00:00Z
   ```

3. Zügig `/motor standard`, `/motor` und „Antworte nur mit Prüfantwort.“
   senden. Erwartet: Fable „gesperrt bis …“, Claude Code „springt ein“, die
   Opus-Stufe in der Reihenfolge „antwortet“, in der Metazeile Opus. Bei einer
   anderen ersten Familie die Fensterkennung entsprechend ersetzen. Ein
   Teil-Limit derselben Familie sperrt beide Stufen und eignet sich nicht.
4. Den echten Stand als jüngere Messung wieder einliefern. Für das erfundene
   Protokoll oben, solange dessen echter Reset noch bevorsteht:

   ```sh
   bun run limits set --engine claude --window weekly_scoped:fable --percent 30 --resets-at 2027-01-17T18:00:00Z
   ```

   Eigene Werte einsetzen. Ohne gültigen alten Stand oder bei inzwischen
   abgelaufenem Reset stattdessen `--percent 0` mit einer frisch erzeugten
   künftigen Reset-Zeit verwenden. Die Regeln unter „Messwerte sicher
   wiederherstellen“ gelten auch hier. Danach `/motor pruefen` und
   `/motor standard`; die ursprüngliche Stufe muss wieder antworten, sofern
   kein echtes Limit vorliegt.

Die acht Aufgaben nicht auf diese künstliche Sperre stützen. Nach einem
Claude-Turn wird bei mehr als zehn Minuten seit dem letzten Bericht erneut
gemessen, während einer Sperre prüft der Bot alle fünf Minuten auf einen
mindestens 30 Minuten alten Bericht. Außerdem können Messwerte aus dem
Claude-Lauf selbst eintreffen. Eine frühere Meldung „ist wieder frei“ ist
deshalb erwartbar. Dann ist die kurze Einspringkontrolle zu wiederholen,
nicht ein falsches Modell als bestanden einzutragen.

## Acht feste Aufgaben je Stufe

In jedem Wortlaut `STUFE` durch A, B, C oder D ersetzen. Für weitere Stufen
eine neue Kennung nehmen. Nur erfundene Testdaten verwenden. Bei jeder
Aufgabe Motor und Modell wie oben kontrollieren, Dauer und Ergebnis unten
eintragen. Die Texte sind Aufträge an tybo im Test-Gespräch, keine Befehle
für das eigene Terminal.

| Nr. | Wortlaut zum Senden | Erwartetes Ergebnis | Benötigtes Werkzeug |
|---|---|---|---|
| 1 | „Recherchiere in der offiziellen Bun-Dokumentation, wie man eine einzelne Testdatei ausführt. Nenne den Befehl, zwei kurze belegte Aussagen und den Link zur Quelle.“ | Quelle lässt sich öffnen und belegt die Aussagen; keine erfundene Recherche. | Websuche und Lesen einer Webseite, eingebaut, über Shell oder MCP. |
| 2 | „Erzeuge im neuen Testordner tmp/motorabnahme/STUFE eine Datei bericht.txt mit dem Inhalt Motorprobe STUFE. Sende sie mir mit bun run notify --source motorabnahme --file tmp/motorabnahme/STUFE/bericht.txt --caption Motorprobe. Verwende den Gesprächskontext für das Ziel.“ | Herunterladbare Datei im selben Web-Gespräch; mit Telegram auch dort. Inhalt stimmt. | Datei schreiben, Shell und `bun run notify`. |
| 3 | „Lies meinen Kalender für morgen in meiner Zeitzone. Nenne Beginn und Titel jedes Termins, sonst ausdrücklich keine Termine. Ändere nichts.“ | Vergleich mit dem eigenen Kalender stimmt, einschließlich Zeitzone; bei fehlendem Zugriff eine klare Meldung. | Eingerichteter lesender Kalenderzugang, etwa MCP oder ein Kalender-Skill mit Anmeldung. |
| 4 | „Erinnere mich in zwei Minuten hier an Motorprobe STUFE.“ | Bestätigung und genau eine Erinnerung im Gespräch; mit `/erinnerungen` nachsehbar. | Eingebauter Erinnerungsdienst über sein Werkzeug, Skript oder den eingerichteten Skill; siehe [Erinnerungen](../erinnerungen.md). |
| 5 | „Merke dir mit einem Merk-Tag für diesen Test: Das erfundene Prüfwort für Motorprobe STUFE ist Blaubeere.“ Danach `/new`, dann „Welches Prüfwort gehört zu Motorprobe STUFE?“ | Merk-Tag wird verarbeitet, ein etwaiger Merk-Vorschlag wird bestätigt; nach neuer Session wird Blaubeere aus dem Gedächtnis gefunden. | `[REMEMBER:]` und tybos Gedächtnis; bei einem Vorschlag dessen Knopf. |
| 6 | „Frage mich mit den zwei echten Knöpfen Kurz und Ausführlich, wie lang der Testbericht sein soll. Warte auf meine Auswahl.“ Dann „Kurz“ anklicken. | Zwei bedienbare Knöpfe; genau eine Fortsetzung passend zur Auswahl, Entscheidung auch im anderen Kanal sichtbar. | Rückfrage-Tags und gemeinsames Rückfragen-Register, fortsetzbare Motor-Session. |
| 7 | „Arbeite nur im Testordner tmp/motorabnahme/STUFE/code. Lege dort gruss.ts mit einer Funktion gruss(name) an, die Hallo plus den Namen liefert, und prüfe sie mit einem kleinen Bun-Test. Ändere die Funktion anschließend so, dass ein leerer Name Hallo Welt ergibt, und führe beide Fälle aus. Berichte die Ergebnisse. Ändere keine verwalteten Projektdateien.“ | Beide Fälle bestehen, nur Dateien im Testordner wurden verändert, tatsächliche Testausgabe wird genannt. | Datei lesen und schreiben, Shell mit Bun. |
| 8 | „Erstelle in diesem Chat einen kurzen Vergleich von drei frei zugänglichen offiziellen Dokumentationsseiten zu Markdown-Tabellen. Lies die Quellen, vergleiche fünf Eigenschaften und gib vor der Recherche sowie nach zwei Quellen einen kurzen Zwischenstand. Bleibe bei einer Chat-Aufgabe unter 15 Minuten; am Ende brauche ich die Tabelle mit Links.“ | Sichtbarer Fortschritt beziehungsweise Zwischenmeldungen vor dem Ergebnis; vollständige Tabelle mit Quellen. Kein Hintergrund-Job als Ersatz für die geprüfte Chat-Stufe. | Webzugang und Fortschrittsausgabe des Motors, gegebenenfalls `bun run notify` für Zwischenmeldungen. |

Ein unterbrochener Versuch kann bereits etwas bewirkt haben, etwa eine Datei
gesendet oder eine Erinnerung angelegt. Vor einer Wiederholung nachsehen.
Die Übergabe nennt höchstens 20 Werkzeugaufrufe je Versuch mit je 80 Zeichen,
maskiert und bei unlesbarer Geheimnisquelle nur mit Werkzeugnamen. Sie
verhindert doppelte Wirkungen nicht. Details:
[Der Motor hat gewechselt](../troubleshooting.md#der-motor-hat-gewechselt).

## Ergebnisprotokoll

Diese Tabelle **für jede Stufe kopieren**, auch für eine weitere Claude-Stufe.
Eintrag: **bestanden**, **Lücke** oder **nicht bestanden**. „Lücke“ gilt nur,
wenn das benötigte Werkzeug für diesen Motor in `/motor werkzeuge` als
fehlend ausgewiesen ist; den Namen und Grund aus der Anzeige übernehmen und
mit „Status“, „Werkzeuge“ vergleichen. Das ist kein Fehler des Wechsels.
Fehlende Anmeldung, unlesbarer Bestand, bloß schlechte Antwort oder eine
andere antwortende Stufe gelten nicht automatisch als Lücke. Ungeprüfte
Aufgaben ausdrücklich so vermerken, nicht als bestanden zählen.

Stufe/Kennung: ______  Motor: ______  Modell: ______  Effort/Rechte: ______
Datum: ______  Werkzeugbestand gesichert: ______

| Aufgabe | bestanden, Lücke oder nicht bestanden | Dauer | Motor/Modell unter der Antwort | Bemerkung, fehlendes Werkzeug und Grund |
|---|---|---|---|---|
| 1 Recherche | | | | |
| 2 Datei senden | | | | |
| 3 Kalender | | | | |
| 4 Erinnerung | | | | |
| 5 Merken | | | | |
| 6 Knöpfe | | | | |
| 7 Code-Änderung | | | | |
| 8 Längere Aufgabe | | | | |

## Wechsel ohne echtes Limit üben

Nach der Modellprüfung zuerst die ursprünglichen Modelle zurückstellen.
Für diese Übung Standard-Motor Claude Code, mindestens Codex als freie
Ersatzstufe und Automatik an verwenden. Die anderen Claude-Stufen dürfen
bleiben: `weekly_all` sperrt sie mit. Die folgenden Nachrichten bleiben im
selben Test-Gespräch, ohne `/new` dazwischen. Die Übergabe ist begrenzt auf
höchstens 30 Nachrichten und 24.000 Zeichen; auch jüngste lange Nachrichten
können gekürzt werden. Deshalb verwendet die Übung einen kurzen Gesprächsfakt.

1. `/motor standard` senden. Danach: „Nur für dieses Gespräch: Unser
   Testpaket heißt Kiefer und enthält sieben blaue Karten. Wiederhole das
   kurz.“ Die Antwort muss von der ersten Stufe kommen.
2. Direkt vor dem Sperren `/motor pruefen` senden, Ende abwarten und im
   Terminal `bun run limits show` ausführen. Den echten Stand von Claude
   `weekly_all` samt Reset festhalten. Nach erfolgreicher Prüfung wird der
   Hintergrundwächter rund 30 Minuten nicht erneut messen, solange kein
   Claude-Chat-Lauf dazukommt. Schritte 3 und 4 zügig erledigen.
3. Eine neue Variable `MOTOR_RESET` erzeugen, dann:

   ```sh
   bun run limits set --engine claude --window weekly_all --percent 96 --resets-at "$MOTOR_RESET"
   ```

   Erwartet: `claude weekly_all: 96 %, übernommen` und `Sperre bis …`.
   Mit den erfundenen Zeiten wäre es vollständig:

   ```sh
   bun run limits set --engine claude --window weekly_all --percent 96 --resets-at 2027-01-15T12:00:00Z
   ```

4. `/motor` zeigt Claude-Stufen gesperrt und Codex „springt ein“. Im
   Direktchat erscheint über den Wächter die Meldung „Motorwechsel: Claude
   Code steht bei 96 % (Woche, alle Modelle). Ab der nächsten Nachricht
   antwortet Codex. …“, auch ohne Chatnachricht. Dann senden: „Wie heißt
   unser Testpaket und was enthält es?“ Erwartet: Codex nennt Kiefer und
   sieben blaue Karten, die WebUI-Metazeile nennt Codex und sein Modell.
   Vor der ersten Antwort steht der Wechselhinweis; bei übergebenem
   Sessionverlauf auch „Der Verlauf ist übergeben.“ Die Pille zeigt Codex.
5. Den echten Stand mit seiner gültigen Reset-Zeit als jüngeren Wert
   einliefern, Beispiel aus dem erfundenen Protokoll:

   ```sh
   bun run limits set --engine claude --window weekly_all --percent 42 --resets-at 2027-01-17T18:00:00Z
   ```

   Eigene Werte und die Sonderfälle im Abschnitt zum Wiederherstellen
   beachten. Erst danach `/motor pruefen` und `/motor standard`. Bei echtem
   niedrigen Stand ist Claude wieder frei; die nächste Nachricht „Nenne
   noch einmal das Testpaket.“ beantwortet die erste Stufe, mit passender
   Metazeile. Meldung und Gesprächshinweis nennen die Rückkehr.

Wenn Claude Code schon vorher „ist wieder frei“ meldet, wurde ein echter
niedrigerer Wert gemessen. Das ist erwartbar, aber noch kein Nachweis eines
Wechsels zu Codex. Ausgangsstand herstellen und den kurzen Ablauf erneut
ausführen. Codex hat keinen solchen Hintergrundmesslauf; es misst erst nach
einem eigenen Chat-Lauf. Ein wieder eingelieferter Wert erscheint zunächst
als „gerade gemessen“ in `/motor`, als `source: "extern"` in `limits show`
und als „eingeliefert“ in der WebUI. Claude ersetzt ihn bei `/motor pruefen`,
Codex beim nächsten eigenen Chat-Lauf.

### Alternative: Schwelle vorübergehend senken

Nur bei einem echten aktuellen Claude-Stand **über 50 % und unter der
bisherigen Rückkehrschwelle**, beispielsweise 60 % bei 95/80, und leerem
Feld „Zurück unter (%)“. Bei einem fest gesetzten `engine.auto.returnBelow`
gilt 80 nicht; die neue Schwelle muss mindestens fünf Punkte darüber liegen.
Dann besser den Messwertweg oben verwenden.

1. Den Stand und die bisherigen Einstellungen sichern, Automatik an und
   die Gesprächsmarke aus Schritt 1 verwenden. `/motor pruefen` senden.
2. Im Abschnitt „Motor“ die Schwelle unter den Stand setzen, beispielsweise
   55 bei 60 %, und speichern; Rückkehrschwelle leer lassen. **Das Senken
   allein setzt noch keine neue Sperre.** Anschließend `/motor pruefen`
   senden. Erst diese Messung sperrt, sofern der echte Stand weiterhin
   mindestens 55 % beträgt. Eine weitere Claude-Antwort kann ebenfalls eine
   Messung liefern, ist aber weniger verlässlich.
3. Wechsel und Verlauf wie in Schritt 4 oben kontrollieren. Danach Schwelle
   und leeres Rückkehrfeld wieder auf den Ausgangsstand setzen, speichern
   und `/motor pruefen` senden. Nur wenn der echte Stand weiter unter der
   ursprünglichen Rückkehrschwelle liegt, wird Claude frei. Für einen
   eingelieferten Stand von 96 % reicht das Zurückstellen der Schwelle
   ausdrücklich **nicht**; dafür den echten niedrigeren Stand neu
   einliefern oder den Reset abwarten.

## Übung „keine Stufe frei“

Alle Ersatzstufen abzuwählen führt nicht dorthin: Ohne Ersatzstufen gilt
die Wechselregel nicht. Stattdessen werden beide Motoren einer kurzen
Reihenfolge gesperrt. Schritte 3 bis 6 ohne Pause und ohne weitere Messung
dazwischen ausführen.

1. **Ausgangsstand festhalten.** `/motor` und Einstellungen, „Modelle“,
   „Motor“ öffnen. Standard-Motor, alle Ersatzstufen mit Modell und Effort,
   Reihenfolge und alle Automatikwerte notieren. Mit `bun run limits show`
   die echten Claude- und Codex-Stände sichern, besonders `weekly_all` mit
   `percent` und `resetsAt`. Vorherige Übungswerte müssen bereits ersetzt
   sein. Bei echten hohen Werten erst nach deren Reset weiterprüfen.
2. **Reihenfolge für die Übung einstellen.** Standard-Motor Claude Code,
   einzige Ersatzstufe Codex, Automatik an, Schwelle 95, Rückkehrfeld leer
   für 80. Alle anderen Ersatzstufen vorübergehend entfernen, insbesondere
   OpenCode: Es hat keine Prozentfenster und würde frei bleiben. Speichern.
   Im Test-Gespräch `/motor standard` senden, damit kein Gesprächswunsch
   vorn steht. Beide Stufen müssen bereit und frei sein.
3. **Beide Motoren sperren.** Unmittelbar vorher im Gespräch `/motor pruefen`
   senden und das Ende abwarten. Bei erfolgreichem Claude-Bericht bleiben
   rund 30 Minuten bis zur nächsten Hintergrundmessung, sofern Claude nicht
   im Chat läuft. Eine neue Variable `MOTOR_RESET` wie oben erzeugen. Die
   beiden Befehle zusammen ausführen:

   ```sh
   bun run limits set --engine claude --window weekly_all --percent 96 --resets-at "$MOTOR_RESET" &&
   bun run limits set --engine codex --window weekly_all --percent 96 --resets-at "$MOTOR_RESET"
   ```

   Vollständiges Beispiel mit erfundenen Zeiten:

   ```sh
   bun run limits set --engine claude --window weekly_all --percent 96 --resets-at 2027-01-15T12:00:00Z &&
   bun run limits set --engine codex --window weekly_all --percent 96 --resets-at 2027-01-15T12:00:00Z
   ```

   Erwartet: beide nennen `96 %, übernommen` und jeweils `Sperre bis …`.
   Bei „nicht übernommen“ oder fehlender Sperre nicht fortfahren, sondern
   Zeit, Automatik und Ausgangsstand prüfen. Der Wächter meldet unabhängig
   von Chatnachrichten ungefähr nach 15 Sekunden „Alle Motoren sind am Limit
   oder nicht bereit. Bis … Uhr antworten Ersatzmodelle mit eingeschränktem
   Werkzeugumfang.“ Verstreicht zwischen den Aufrufen ein Wächterdurchgang,
   kann davor zusätzlich „Motorwechsel: Claude Code steht bei 96 % …“
   erscheinen. `&&` verkürzt den Abstand, schließt diese Zwischenmeldung
   aber nicht aus. Jede tatsächliche Änderung wird einmal gemeldet.
4. **Mit `/motor` kontrollieren.** Erste Zeile: „Motor in diesem Gespräch:
   keiner frei“. Der Grund: „Bis … Uhr antworten Ersatzmodelle mit
   eingeschränktem Werkzeugumfang.“ Beide Stufen stehen auf „gesperrt bis …“;
   ohne bekannte Reset-Zeit würde dort „pausiert bis …“ stehen. Die WebUI-Pille
   zeigt „Kein Motor frei“. Kein `/motor pruefen` dazwischenschieben: Es
   könnte die Übungssperren wieder aufheben.
5. **Erste Nachricht senden:** „Was ergibt drei plus vier? Antworte kurz.“
   Erwartet: Kein Motor startet. Vor der Antwort steht einmal „Gerade ist
   kein Motor frei (Limit erreicht oder nicht bereit). Es antwortet ein
   Ersatzmodell mit eingeschränktem Werkzeugumfang. Frühestens wieder frei:
   … Uhr.“ Ein Ersatzmodell antwortet mit sieben und Herkunftszusatz, etwa
   „(Antwort über kimi-k3)“, „(Antwort über openrouter)“ oder „(Antwort über
   ollama)“. In der WebUI nennt die Metazeile das Ersatzmodell ohne Motor.
   Die globale Meldung aus Schritt 3 darf schon vorher angekommen sein;
   sie wird nicht erst von dieser Nachricht ausgelöst. Scheitert auch das
   Ersatzmodell, steht stattdessen „Gerade ist kein Motor frei, und auch die
   Ersatzmodelle haben nicht geantwortet.“ samt frühester Freigabe und
   Bitte zum späteren Versuch. Das prüft den Fehlerweg, besteht aber nicht
   den vorgesehenen Antworttest mit eingerichtetem Ersatzmodell.
6. **Zweite Nachricht senden:** „Was ergibt vier plus vier?“ Erwartet:
   wieder ein Ersatzmodell mit Herkunftszusatz, aber kein zweiter Hinweis
   und keine doppelte globale Meldung, solange keine Stufe zwischenzeitlich
   frei wurde. Meldet Claude von selbst „ist wieder frei“, hat eine echte
   Nachmessung die Sperre aufgehoben. Diesen erwartbaren Sonderfall notieren,
   aufräumen und die kurze Übung für den vollständigen Nachweis wiederholen.
7. **Wiederherstellen.** Für beide Motoren den echten Stand aus Schritt 1
   mit dessen echter, noch künftiger Reset-Zeit neu einliefern. Kein altes
   `--measured-at` einsetzen. Für das erfundene Protokoll lautet das:

   ```sh
   bun run limits set --engine claude --window weekly_all --percent 42 --resets-at 2027-01-17T18:00:00Z &&
   bun run limits set --engine codex --window weekly_all --percent 31 --resets-at 2027-01-17T18:00:00Z
   ```

   Ohne festgehaltenen Stand oder bei inzwischen abgelaufenem echtem Reset
   für den betroffenen Motor 0 einsetzen. Solange die Reset-Zeit aus Schritt
   3 noch bevorsteht, kann dieselbe Variable verwendet werden, sonst eine
   neue erzeugen. Falls beide Stände fehlen, lautet der vollständige Weg:

   ```sh
   bun run limits set --engine claude --window weekly_all --percent 0 --resets-at "$MOTOR_RESET" &&
   bun run limits set --engine codex --window weekly_all --percent 0 --resets-at "$MOTOR_RESET"
   ```

   Erwartet: `übernommen` und bei noch aktiver Übungssperre `Sperre
   aufgehoben`. Ist sie durch echte Nachmessung schon weg, genügt
   `übernommen`. Liegt ein echter Stand selbst bei oder über 80 %, bleibt
   die Sperre zu Recht; dann den echten Reset abwarten, keine 0 erfinden.
   Reihenfolge und Automatikwerte aus Schritt 1 wieder einstellen und
   speichern. Bei gültigem niedrigen Stand anschließend `/motor pruefen`
   und `/motor standard` senden. `/motor` zeigt die ursprüngliche Reihenfolge
   ohne Übungssperre; eine weitere kurze Nachricht beantwortet wieder die
   erste Stufe. Beim Wiederherstellen können je nach Reihenfolge und
   Zeitpunkt bis zu zwei Meldungen „ist wieder frei“ eintreffen.

## Messwerte sicher wiederherstellen

Diese Regeln gelten nach **jedem** eingelieferten Übungswert, auch nach einer
abgebrochenen Übung:

- Den echten Prozentwert mit dessen noch künftiger Reset-Zeit über denselben
  `limits set`-Befehl einliefern. Ohne `--measured-at` verwendet er die jetzige
  Zeit und ist jünger als die Sperre. War der echte Reset unbekannt, den
  Schalter `--resets-at` beim echten Wert weglassen.
- Fehlt ein echter Stand oder ist dessen Reset inzwischen vorbei, 0 mit
  einer künftigen Reset-Zeit verwenden. Die abgelaufene Zeit würde mit
  „nicht übernommen, die Reset-Zeit ist vorbei“ abgewiesen, obwohl der
  Befehl Exit-Code 0 liefert; die künstlichen 96 % blieben dann gespeichert.
  Deshalb den Text der Ausgabe lesen und mit `bun run limits show` prüfen.
- Ein echter Wert **unter** der geltenden Rückkehrschwelle löst die
  Fenstersperre. Bei oder darüber bleibt sie bis zum Reset oder einer
  echten niedrigeren Messung. Das ist ein erwartbarer Fall. Dann erst den
  Reset abwarten und danach `/motor pruefen` ausführen. Insbesondere Codex
  hat beim Prüfbefehl keine eigene frische Messung; die Prüfung könnte
  dessen Sperre mangels frischer Messung freigeben, ohne ein freies Limit
  nachzuweisen. Der nächste Codex-Chat-Lauf entscheidet.
- Die alte Messdatei nicht zurückkopieren. Wieder eingelieferte Werte haben
  Quelle `extern` und gelten bis zur nächsten echten Messung. Claude misst
  bei `/motor pruefen`, Codex nach seinem nächsten eigenen Chat-Lauf.

## Aufräumen und Abschluss

1. Für jedes veränderte Fenster den echten Stand wie oben als jüngeren Wert
   wieder einliefern: gegebenenfalls `weekly_scoped:fable`, Claude
   `weekly_all` und Codex `weekly_all`. Auch nach vorzeitigem Abbruch keinen
   künstlichen Wert zurücklassen. Bei echtem hohen Stand den Reset abwarten.
2. Standard-Motor, Ersatzstufen samt Reihenfolge, Modell und Effort,
   Automatik, Schwelle, Rückkehrfeld und alle vorübergehend veränderten
   Modellwerte auf den ersten Ausgangsstand zurückstellen. Leere Felder
   wieder leeren. Jeden geänderten Abschnitt speichern.
3. `/motor pruefen` und `/motor standard` senden. `bun run limits show`
   kontrollieren. `/motor` darf keine Übungssperre mehr zeigen; eine echte
   Sperre braucht einen echten Stand bei oder über der geltenden
   Rückkehrschwelle. Eine bestehende Limit- oder Ausfallsperre separat nach
   [Störungen](../troubleshooting.md#der-motor-hat-gewechselt) prüfen. Eine
   kurze Nachricht muss wieder die ursprüngliche erste freie Stufe zeigen.
4. Mit `/erinnerungen` nur noch offene Erinnerungen namens „Motorprobe“
   suchen und mit `/erinnerungen absagen <kennung>` deren Kennung absagen.
   tybo ausdrücklich bitten, nur die erfundenen Prüfwort-Fakten dieses
   Laufs zu vergessen. Nur die selbst erzeugten Unterordner unter
   `tmp/motorabnahme/` entfernen lassen. Echte Kalendertermine bleiben
   unverändert. Protokoll und heruntergeladene Belege vorher aufheben.
5. Die Tabellen und beide Wechselübungen auswerten. Zu jedem Fehler Stufe,
   Aufgabe, tatsächlichen Motor und Modell, sichtbare Meldung und Uhrzeit
   notieren. Persönliche Kalenderinhalte oder Zugangsdaten gehören nicht in
   einen Fehlerbericht. Den Abschnitt
   [Der Motor hat gewechselt](../troubleshooting.md#der-motor-hat-gewechselt)
   mit dem beobachteten Ablauf vergleichen.
