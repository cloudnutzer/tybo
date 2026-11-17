# Hintergrund-Jobs

Lange Aufträge laufen als eigener Claude-Prozess neben dem Bot, ohne das
Zeitlimit einer Antwort (Entscheidung `docs/webui/decisions/0016-hintergrund-jobs.md`,
Issue #103). Ein Wächter-Prozess startet Claude, wartet auf das Ende und
meldet sich immer, auch wenn Claude abstürzt oder keinen Bericht schreibt.

Jobs brauchen deshalb Claude Code. Fehlt es (etwa auf einem Server nur mit
Codex), stellt der Bot das beim Start fest; dann gibt es keine Jobs, und der
Block `LONG TASKS` bittet statt um einen Job darum, die Arbeit auf mehrere
Antworten zu verteilen ([Server und Codex](server.md)).

## Wann ein Job statt einer Chat-Antwort

Ein Chat-Turn endet nach einer Zeit ohne Aktivität und spätestens an einer
Obergrenze (`src/lib/turn-limits.ts`, einstellbar über `TYBO_CLAUDE_IDLE_MIN`
und `TYBO_CLAUDE_MAX_MIN`). Der Block `LONG TASKS` im Basis-Prompt aller
Agenten (`LONG_TASK_RULES` in `src/agents/base.ts`, Issue #180) sagt Claude
deshalb:

- Aufträge, die voraussichtlich länger als 15 Minuten dauern oder mehrere
  Hilfs-Agenten nacheinander abwarten, als Job starten: kurze Antwort mit
  Plan, eigenständiger Auftrag in einer Datei, dann `bun run job start`.
  Bestätigt wird erst, wenn der Start eine Job-ID ausgegeben hat.
- Nie länger als 2 Minuten in einem Befehl mit `sleep` oder Polling warten.
- Hilfs-Agenten im Vordergrund starten und ihr Ergebnis direkt nutzen.
- Bei längeren Turns früh den Plan melden (`bun run notify --source agent --text …`).

Die Regel ist ein Hinweis im Prompt, keine Sperre. Bestehende Sessions sehen
sie erst ab der nächsten frischen Session (`/new`).

## Befehle

```bash
bun run job start --title "<Titel>" (--brief <datei> | --text "<Auftrag>") \
  [--topic <id>] [--max-hours <n>] [--model <modell>] [--effort <stufe>] [--full-access] \
  [--allow-duplicate]
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
  (`TYBO_CONVERSATION_ID` für ein reines Web-Gespräch, sonst
  `TYBO_TOPIC_ID`/`TYBO_CHAT_ID`, setzt tybo seinen Claude-Subprozessen),
  sonst der Direktchat. Ungültige Werte dort oder ein Topic ohne Forum-Gruppe
  brechen den Start ab (Exit 2), statt still in den Direktchat zu melden.
  Ohne Telegram geht die Rückmeldung nur in die WebUI (Issue #227).
- `--max-hours`: Zeitlimit, Standard 6, höchstens 72, auch Bruchteile (0.5).
- `--model` und `--effort`: ohne Angabe wie der Bot (`MODEL_IDS.opus` aus
  `src/lib/model-router.ts`, Effort wie `defaultEffort` in `src/lib/claude.ts`).
- `--full-access`: siehe Werkzeugrechte.
- `--allow-duplicate`: siehe „Keine doppelten Jobs".

Exit-Codes: 0 erledigt, 1 gescheitert, 2 falscher Aufruf oder abgelehnt
(unzustellbares Ziel, Doppel).

## Keine doppelten Jobs

Läuft schon ein Job mit demselben Titel (Groß- und Kleinschreibung und
Leerzeichen egal) oder demselben Auftrag, startet `job start` nicht und nennt
den laufenden Job (Exit 2). Geprüft und angelegt wird unter einer Sperre
(`data/jobs/start.lock`), zwei gleichzeitige Starts sehen einander also.
Absichtlich doppelt: `--allow-duplicate`. Anlass: Nach dem Mac-Neustart am
30.9.2026 lasen zwei Sessions (Regelzeit-Topic und Direktchat) denselben
Merk-Eintrag „Jobs neu starten" und starteten die Fortsetzungen je zweimal,
parallel im selben Arbeitsbaum.

## Keine Hintergrund-Befehle

Ein Job ist `claude -p`: Er endet, sobald Claude seinen Turn beendet. Befehle,
die Claude in den Hintergrund schiebt (`run_in_background`, oder die
Bash-Shell der CLI nach 10 Minuten von selbst), beendet die CLI dabei ohne
Ergebnis, und eine Meldung „Befehl fertig" kommt nie an. So endeten am 28.9.,
30.9. und 1.10.2026 drei Jobs mit „Ich warte auf das Ergebnis" ohne Bericht
(nachgestellt: ohne Sperre ist der Job nach 12 Sekunden zu Ende und der
Hintergrund-Befehl tot, mit Sperre läuft er im Vordergrund zu Ende).
Deshalb bekommt Claude im Job:

- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (für alle Claude-Subprozesse von
  tybo, `NO_BACKGROUND_TASKS` in `src/lib/subprocess-env.ts`):
  `run_in_background` fehlt im Bash-Werkzeug, ein zu langer Befehl endet am
  Zeitlimit mit Fehler statt im Hintergrund.
- `BASH_MAX_TIMEOUT_MS=3600000`: ein Befehl darf bis 60 Minuten im
  Vordergrund laufen (Standard der CLI: 10). Ein Wert in der Umgebung des
  Bots geht vor.
- `--disallowedTools Monitor,ScheduleWakeup,CronCreate`: Monitor bleibt sonst
  trotz Sperre verfügbar und lässt Claude nur warten; die beiden anderen
  wirken erst nach dem Ende des Prozesses.
- Im Auftrag nach der Berichtsanweisung die Regeln aus `JOB_RULES`
  (`src/lib/jobs/runner.ts`): alles im Vordergrund, nichts mit `&` oder
  `nohup` starten, auf dessen Ergebnis gewartet wird, Turn erst nach dem
  Bericht beenden.

## Werkzeugrechte

Ein Job läuft ohne Rückfragen. Deshalb gilt:

- Ohne `--full-access` läuft Claude mit `--permission-mode acceptEdits`: Dateien
  im Projekt lesen und schreiben (auch den Bericht) geht, Befehle ausführen nicht.
- Mit `--full-access` läuft Claude mit `bypassPermissions` und darf alles.
  Das ist nur für Aufträge gedacht, die tybo selbst formuliert hat. Inhalte aus
  Mails, Webseiten oder fremden Dateien gehören nie ungeprüft in einen solchen
  Auftrag.
- Aus dem Programm heraus (nicht über die Befehlszeile) kann ein Job zusätzlich
  erlaubte Werkzeuge (`allowedTools`, etwa `WebSearch` und `WebFetch` für eine
  Recherche) und gesperrte Werkzeuge (`deniedTools`) bekommen. Sie stehen in
  `status.json` und gehen als `--allowedTools` bzw. zusätzlich zu den festen
  Sperren als `--disallowedTools` an Claude; `acceptEdits` bleibt.
- Ebenfalls nur aus dem Programm: ein eigener Arbeitsordner (`workDir`, absoluter
  Pfad, echter Ordner, nie mit `--full-access`). Claude startet dann dort statt
  im Projektordner, mit `--restricted` (Einstellungsdateien bleiben aus,
  Dateiwerkzeuge reichen nicht über den Arbeitsordner hinaus,
  `bypassPermissions` geht nicht), `--strict-mcp-config` (keine MCP-Server) und
  `--tools` mit Read, Write, Edit, Glob, Grep und den erlaubten Werkzeugen. Den
  Bericht schreibt der Job als `bericht.md` in den Arbeitsordner; der Wächter
  kopiert ihn nach dem Ende nach `data/jobs/<id>/report.md`, nur als normale
  Datei bis 256 KB. So recherchiert der Entwurf eines Sprachagenten ohne
  `--full-access` und kann nur in seinem Arbeitsordner schreiben (Issue #493,
  `docs/sprechen.md`).

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
   einen kurzen Bericht nach data/jobs/<id>/report.md" und den Regeln aus
   „Keine Hintergrund-Befehle". Claude bekommt die
   Umgebung ohne Geheimnisse (`subprocessEnv()`), dazu
   `TYBO_CHAT_ID`/`TYBO_TOPIC_ID` bzw. `TYBO_CONVERSATION_ID` des
   gespeicherten Ziels und
   `TYBO_JOB_ID`. Ausgabe von Claude landet maskiert in `job.log` (siehe
   Geheimnisse), die des Wächters in `watcher.log`.
3. Am Ende meldet der Wächter über `sendAndRecord` (Telegram und WebUI, Absender
   `job`):
   - Exit 0 und `report.md` nicht leer: Titel, Dauer und Bericht (lange Berichte
     gekürzt, mit Verweis auf die Datei).
   - Exit 0 ohne Bericht: „Job ohne Bericht" mit den letzten 20 Log-Zeilen und
     dem Hinweis, dass nichts mehr nachkommt, auch wenn im Log „läuft noch"
     oder „ich melde mich" steht.
   - Exit-Code ungleich 0 oder Signal: „Job fehlgeschlagen" mit Exit-Code und
     den letzten 20 Log-Zeilen.
   - Zeitlimit erreicht: Claudes Prozessgruppe wird beendet (SIGTERM, nach
     5 Sekunden SIGKILL), Meldung „Zeit überschritten" mit Log-Auszug.
   - Liefen nach Claudes Ende noch Prozesse, die Claude gestartet hatte (etwa
     ein mit `&` gestarteter Testlauf), stehen sie mit PID und Befehl in der
     Meldung und als `leftovers` in `status.json`. Der Wächter hält dafür alle
     10 Sekunden fest, was unter Claude läuft (`ProcessTracker`, `ps -A`), und
     prüft nach dem Ende, was davon noch lebt (gleiche PID und Startzeit).
     Beendet werden sie nicht, es kann Absicht sein (etwa eine neu gestartete
     Pipeline).
4. `job stop` beendet Claudes Prozessgruppe auf dieselbe Weise und meldet
   „Job gestoppt". Der Wächter schweigt danach.

Der Wächter hängt nicht am Bot. Ein Neustart des Bots beendet laufende Jobs
nicht. Unter launchd und PM2 reicht dafür die eigene Prozess-Session. Unter
systemd nicht: systemd beendet beim Stoppen eines Dienstes von sich aus alle
Prozesse seiner Kontrollgruppe (cgroup), und eine eigene Session verlässt
die Kontrollgruppe nicht. Deshalb steht in der Dienstdatei, die
`tybo setup autostart` anlegt, `KillMode=process`: systemd beendet dann nur
den Bot selbst. Seine Motor-Aufrufe (Claude, Codex, OpenCode) und die
Prüfbefehle der Motoren (Versionsprüfung von OpenCode, `opencode models`
für die Modell-Liste, die Prüfungen wie `codex --version` und
`codex login status` sowie `claude --help` des Telefonhörers) beendet der Bot
unter systemd beim Herunterfahren samt Kindern selbst; danach startet keine
Prüfung mehr einen Prozess. Er wartet bis zu 5 Sekunden auf ihr Ende; wer dann
noch läuft, bekommt SIGKILL (`waitForEngineExit` in
`src/lib/engines/calls.ts`). Die gemeinsame Prozessverwaltung verfolgt jede
Motor-Gruppe, bis sie nachweislich leer ist. Das Ende des Hauptprozesses,
eine Abmeldung und das SIGKILL des Abbruch-Nachlaufs geben die Gruppe noch
nicht frei. So werden beim Herunterfahren auch Kinder bereits erfolgreicher,
abgebrochener oder zeitlich begrenzter Aufrufe und Prüfungen beendet, ohne
den abgeschlossenen Auftrag erneut abzubrechen. Unter launchd und PM2
wartet er nicht und lässt Prüfprozesse samt Kindern unberührt, dort
bleibt das Beenden wie vorher. Die Kehrseite: Stürzt der Bot ab, bleiben auch
seine übrigen Kindprozesse stehen, bis sie von selbst enden; systemd räumt
sie nicht mehr ab.

Eine Dienstdatei von vor dieser Änderung hat die Zeile nicht. `tybo pruefen`
meldet das als Warnung „telegram-relay (Hintergrund-Jobs)“,
`tybo setup autostart` trägt die Zeile nach (siehe
[Einrichtung](einrichtung.md#autostart-mit-systemd)).

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

- Versandfehler: bis zu sechs Versuche (Pausen 5 s, 30 s, 2, 10 und 30 Minuten),
  ein Netzausfall wie am 27.9.2026 (17 Minuten) verschluckt die Meldung also
  nicht.
- Zugestellt: Zeile „Meldung zugestellt (Versuch n, Telegram ja/nein, WebUI ja)"
  in `watcher.log`, in `status.json` `notice.state` `sent`.
- Telegram lehnt ab (etwa fehlendes Topic): kein weiterer Versuch.
- Gesendet, aber nicht für die WebUI festgehalten: kein weiterer Versuch, sonst
  käme die Meldung in Telegram doppelt. Hinweis in `watcher.log`.
- Scheitert die Zustellung ganz, zeigt `job list` „Meldung nicht zugestellt".

## Nach einem Absturz

Beim Start prüft der Bot alle Jobs (`recoverJobs` in `src/lib/jobs/control.ts`):

- Steht ein Job auf „läuft", aber sein Wächter lebt nicht mehr (Absturz,
  Neustart des Rechners, unter systemd mit einer alten Dienstdatei auch der
  Neustart des Bots), wird ein noch laufender Claude beendet und der Job
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
außer `/jobs`. Eine Obergrenze für parallele Jobs und volle Testläufe ist
nach dem Mac-Hänger vom 30.9.2026 als Issue #266 geplant.
