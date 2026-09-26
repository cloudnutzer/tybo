# Hintergrund-Jobs

Lange Aufträge laufen als eigener Claude-Prozess neben dem Bot, ohne das
Zeitlimit einer Antwort (Entscheidung `docs/webui/decisions/0016-hintergrund-jobs.md`,
Issue #103). Ein Wächter-Prozess startet Claude, wartet auf das Ende und
meldet sich immer, auch wenn Claude abstürzt oder keinen Bericht schreibt.

## Befehle

```bash
bun run job start --title "<Titel>" (--brief <datei> | --text "<Auftrag>") \
  [--topic <id>] [--max-hours <n>] [--model <modell>] [--effort <stufe>] [--full-access]
bun run job list          # laufende und die letzten 20 beendeten Jobs
bun run job stop <id>     # Job beenden, Meldung „gestoppt"
bun run job log <id>      # Log des Jobs, Werte aus .env verborgen
```

Dasselbe geht mit `tybo job …`, auch aus einem anderen Ordner. `/jobs` zeigt
die Liste in Telegram, im Browser und im Terminal-Chat.

- `--brief` liest den Auftrag aus einer Datei (relativ zum aktuellen Ordner),
  `--text` nimmt ihn direkt. Genau eins von beiden.
- `--topic` legt fest, wohin die Rückmeldung geht (1 ist General). Ohne
  `--topic` gilt das Gespräch, aus dem der Job gestartet wurde
  (`TYBO_TOPIC_ID`/`TYBO_CHAT_ID`, setzt tybo seinen Claude-Subprozessen),
  sonst der Direktchat. Ungültige Werte dort oder ein Topic ohne Forum-Gruppe
  brechen den Start ab (Exit 2), statt still in den Direktchat zu melden.
- `--max-hours`: Zeitlimit, Standard 6, höchstens 72, auch Bruchteile (0.5).
- `--model` und `--effort`: ohne Angabe wie der Bot (`MODEL_IDS.opus` aus
  `src/lib/model-router.ts`, Effort wie `defaultEffort` in `src/lib/claude.ts`).
- `--full-access`: siehe Werkzeugrechte.

Exit-Codes: 0 erledigt, 1 gescheitert, 2 falscher Aufruf.

## Werkzeugrechte

Ein Job läuft ohne Rückfragen. Deshalb gilt:

- Ohne `--full-access` läuft Claude mit `--permission-mode acceptEdits`: Dateien
  im Projekt lesen und schreiben (auch den Bericht) geht, Befehle ausführen nicht.
- Mit `--full-access` läuft Claude mit `bypassPermissions` und darf alles.
  Das ist nur für Aufträge gedacht, die tybo selbst formuliert hat. Inhalte aus
  Mails, Webseiten oder fremden Dateien gehören nie ungeprüft in einen solchen
  Auftrag.

## Ablauf

1. `job start` prüft Aufruf und Rückmeldeziel, legt `data/jobs/<id>/` an
   (`brief.md`, `job.log`, `status.json`) und startet den Wächter in einer
   eigenen Prozess-Session mit stdin `/dev/null`. Er wartet bis zu 15 Sekunden,
   bis der Wächter Claude gestartet hat, und gibt die Job-ID aus.
2. Der Wächter startet Claude im Projektordner in einer eigenen Prozessgruppe,
   hinter einer Startsperre: Zuerst läuft nur ein kleiner `sh`, der auf eine
   Freigabe über stdin wartet. Erst wenn PID und Startzeit in `status.json`
   stehen, gibt der Wächter frei, und `sh` wird per `exec` zu Claude (gleiche
   PID, gleiche Startzeit). Stirbt der Wächter vorher, endet `sh`, ohne Claude
   zu starten. Der Auftrag geht über stdin, mit dem Zusatz „Schreibe am Ende
   einen kurzen Bericht nach data/jobs/<id>/report.md". Claude bekommt die
   Umgebung ohne Geheimnisse (`subprocessEnv()`), dazu
   `TYBO_CHAT_ID`/`TYBO_TOPIC_ID` des gespeicherten Ziels und
   `TYBO_JOB_ID`. Ausgabe von Claude landet maskiert in `job.log` (siehe
   Geheimnisse), die des Wächters in `watcher.log`.
3. Am Ende meldet der Wächter über `sendAndRecord` (Telegram und WebUI, Absender
   `job`):
   - Exit 0 und `report.md` nicht leer: Titel, Dauer und Bericht (lange Berichte
     gekürzt, mit Verweis auf die Datei).
   - Exit 0 ohne Bericht: „Job ohne Bericht" mit den letzten 20 Log-Zeilen.
   - Exit-Code ungleich 0 oder Signal: „Job fehlgeschlagen" mit Exit-Code und
     den letzten 20 Log-Zeilen.
   - Zeitlimit erreicht: Claudes Prozessgruppe wird beendet (SIGTERM, nach
     5 Sekunden SIGKILL), Meldung „Zeit überschritten" mit Log-Auszug.
4. `job stop` beendet Claudes Prozessgruppe auf dieselbe Weise und meldet
   „Job gestoppt". Der Wächter schweigt danach.

Der Wächter hängt nicht am Bot. Ein Neustart des Bots beendet laufende Jobs
nicht.

## Genau eine Meldung

Wer einen Job beendet (Wächter, `job stop`, Zeitlimit, Aufräumen beim
Bot-Start), muss in `status.json` den Übergang nach `ended` gewinnen. Das
passiert unter einer Datei-Sperre (`status.lock`, `src/lib/file-lock.ts`), weil
mehrere Prozesse beteiligt sind. Nur der Gewinner meldet sich. Kommen Stopp und
Prozessende gleichzeitig, gibt es trotzdem nur eine Meldung.

Die Meldung ist ein einziger Aufruf von `sendAndRecord`. Bericht bzw.
Log-Auszug werden so weit gekürzt, bis die gesendete Darstellung (Markdown als
HTML, `&` wird dabei zu `&amp;`) in eine Telegram-Nachricht passt. Sie zerfällt
also nie in Stücke, und eine Wiederholung schickt kein Stück doppelt.
Zustellung:

- Versandfehler: bis zu drei Versuche (Pausen 5 und 30 Sekunden).
- Telegram lehnt ab (etwa fehlendes Topic): kein weiterer Versuch.
- Gesendet, aber nicht für die WebUI festgehalten: kein weiterer Versuch, sonst
  käme die Meldung in Telegram doppelt. Hinweis in `watcher.log`.
- Scheitert die Zustellung ganz, zeigt `job list` „Meldung nicht zugestellt".

## Nach einem Absturz

Beim Start prüft der Bot alle Jobs (`recoverJobs` in `src/lib/jobs/control.ts`):

- Steht ein Job auf „läuft", aber sein Wächter lebt nicht mehr (Absturz,
  Neustart des Rechners), wird ein noch laufender Claude beendet und der Job
  als „abgebrochen" gemeldet, mit Log-Auszug.
- Wer mit Stopp, Zeitlimit oder Abbruch gewinnt, trägt zuerst „Beendigung
  ausstehend" in `status.json` ein und beendet dann Claudes Prozessgruppe.
  Starb er dazwischen, beendet der Bot die Gruppe beim Start und meldet erst
  danach. Ließ sie sich nicht sicher beenden, steht das in der Meldung.
- Starb ein Absender mitten im Versand, holt der Bot die Meldung nach. Ob
  Telegram den unterbrochenen Versuch noch angenommen hat, ist dann nicht zu
  erkennen; im Zweifel kommt die Meldung doppelt statt gar nicht.

Ein Job, der gerade erst angelegt wurde und noch keinen Wächter eingetragen
hat, bekommt 60 Sekunden Schonfrist. Fällt der Bot-Start in diese Frist, prüft
der Bot den Job nach ihrem Ablauf noch einmal (`recoverJobsUntilSettled`).

Prozesse werden über PID und Startzeit (`ps -o lstart=`) erkannt. Eine neu
vergebene PID mit anderer Startzeit gilt als fremd und bekommt kein Signal.
Als beendet gilt ein Wächter oder Absender nur, wenn seine PID nicht mehr lebt
oder eine andere Startzeit hat. Lebt die PID und ist die Startzeit nicht
prüfbar, bleibt alles, wie es ist: kein Abbruch, keine Übernahme der Meldung.
Die Identität wird vor SIGTERM und noch einmal vor SIGKILL geprüft.
Ohne Startzeit gibt es nie ein Signal: Ist sie für Claude beim Start nicht
ermittelbar, startet Claude gar nicht (Meldung „nicht gestartet"); ist sie
später nicht abfragbar, bleibt der Prozess stehen und `job stop` sagt das.

## Geheimnisse

Alles, was ein Job meldet, anzeigt oder protokolliert (Titel, Bericht,
Log-Auszug, Grund, `job log`, `job list`, `/jobs`, `job.log`, `watcher.log`,
Fehlertexte in `status.json`), wird vorher maskiert und erscheint als
`[verborgen]`:

- Jeder Wert aus der `.env`, in jeder Länge und überall im Text, auch mitten
  in einem Wort. Kurze Werte treffen so auch harmlose Stellen: steht
  `WEB_PORT=3100` in der `.env`, wird aus `31000` ein `[verborgen]0`.
- Aus der Umgebung die Werte geheim benannter Variablen (`*_TOKEN`, `*_KEY`,
  `*PASSWORD*`, `TELEGRAM_*` und Co.), ebenso überall.

Vor dem Maskieren fallen unsichtbare Zeichen weg (wie beim Versand an
Telegram), damit ein durch ein solches Zeichen getrennter Wert erkannt wird.
Zusätzlich prüft der Wächter den Text, den Telegram von der fertigen Meldung
zeigt: Würden Titel, Grund, Bericht oder Log-Auszug erst durch die Umwandlung
(Markdown-Zeichen, Link-Adressen fallen weg) einen Wert zeigen, wird dieser
Teil ganz verborgen, mit Hinweis auf den Bericht bzw. `job log`.

Die Ausgabe von Claude wird schon beim Schreiben nach `job.log` maskiert, auch
wenn ein Wert über mehrere Ausgabestücke verteilt ankommt. Dafür liest der
Wächter stdout und stderr über Pipes; stirbt er, verliert Claude seine Ausgabe
und endet beim nächsten Schreiben, der Bot meldet den Job dann beim Start als
abgebrochen.

## Aufbau

| Datei | Aufgabe |
|-------|---------|
| `scripts/job.ts` | Einstieg für `bun run job` und `tybo job`, auch der Wächter (`__watch <id>`) |
| `src/lib/jobs/cli.ts` | Aufruf, Rückmeldeziel |
| `src/lib/jobs/runner.ts` | Start und Wächter |
| `src/lib/jobs/notice.ts` | Meldungstext und Zustellung |
| `src/lib/jobs/control.ts` | Liste, Stopp, Log, Aufräumen beim Start |
| `src/lib/jobs/store.ts` | Ordner, Status, Übergänge unter Sperre |
| `src/lib/jobs/process.ts` | Prozess-Identität, Prozessgruppe beenden |
| `src/lib/jobs/mask.ts` | Maskierung |

Tests: `tests/jobs-*.test.ts`, ohne echtes `claude` und ohne Telegram.

Nicht vorgesehen: Warteschlange, Begrenzung paralleler Jobs, eine Oberfläche
außer `/jobs`.
