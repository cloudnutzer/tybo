# Hintergrund-Jobs

Lange Aufträge laufen als eigener Claude- oder Codex-Prozess neben dem Bot,
ohne das Zeitlimit einer Antwort (Entscheidung
`docs/webui/decisions/0016-hintergrund-jobs.md`, Issues #103 und #618).
Ein Wächter-Prozess startet den Motor, wartet auf das Ende und meldet sich
immer, auch wenn der Motor abstürzt oder keinen Bericht schreibt.

Jobs brauchen die CLI des gewählten Motors. Standard ist Claude Code, mit
`--engine codex` geht es auch ohne Claude. Der Wächter prüft bei Codex vor dem
Start Installation und Anmeldung (`codex --version`, `codex login status`).
Fehlt die CLI oder die Anmeldung oder scheitert die Prüfung, meldet er
„Job nicht gestartet“ mit dem Grund. Der Block `LONG TASKS` im Bot-Prompt richtet seine automatische
Job-Empfehlung weiterhin nach der Verfügbarkeit von Claude Code; ohne Claude
bittet er darum, die Arbeit auf mehrere Antworten zu verteilen
([Server und Codex](server.md)).

## Wann ein Job statt einer Chat-Antwort

Ein Chat-Turn endet nach einer Zeit ohne Aktivität und spätestens an einer
Obergrenze (`src/lib/turn-limits.ts`, einstellbar über `TYBO_CLAUDE_IDLE_MIN`
und `TYBO_CLAUDE_MAX_MIN`). Der Block `LONG TASKS` im Basis-Prompt aller
Agenten (`LONG_TASK_RULES` und `formatJobRules` in `src/agents/prompt-parts.ts`, Issues #180 und #625) sagt Claude
deshalb:

- Aufträge, die voraussichtlich länger als 15 Minuten dauern oder mehrere
  Hilfs-Agenten nacheinander abwarten, als Job starten: kurze Antwort mit
  Plan, eigenständiger Auftrag in einer Datei, dann `bun run job start`.
  Bestätigt wird erst, wenn der Start eine Job-ID ausgegeben hat.
- Soll tybo mit dem Bericht weiterarbeiten, `--zurueck` ergänzen. Der Auftrag
  muss trotzdem allein verständlich sein; der Job hat eine eigene Session.
- Nie länger als 2 Minuten in einem Befehl mit `sleep` oder Polling warten.
- Hilfs-Agenten im Vordergrund starten und ihr Ergebnis direkt nutzen.
- Bei längeren Turns früh den Plan melden (`bun run notify --source agent --text …`).

Die Regel ist ein Hinweis im Prompt, keine Sperre. Bestehende Sessions sehen
sie erst ab der nächsten frischen Session (`/new`).

## Befehle

```bash
bun run job start --title "<Titel>" (--brief <datei> | --text "<Auftrag>") \
  [--engine claude|codex] [--topic <id>] [--max-hours <n>] \
  [--model <modell>] [--effort <stufe>] [--full-access] \
  [--allow-duplicate] [--zurueck]
bun run job list          # laufende und die letzten 20 beendeten Jobs
bun run job stop <id>     # Job beenden, Meldung „gestoppt"
bun run job resume <id>   # abgebrochenen Claude-Job mit derselben Session fortsetzen
bun run job log <id>      # Log des Jobs, Werte aus .env verborgen
```

Dasselbe geht mit `tybo job …`, auch aus einem anderen Ordner. `/jobs` zeigt
die Liste in Telegram, im Browser und im Terminal-Chat. Wartende Jobs stehen
oben als „wartet auf dich“ mit ihrer Frage. Fortgesetzte Jobs
tragen dort „Lauf 2“, „Lauf 3“ usw.; die Job-ID bleibt gleich.

- `--brief` liest den Auftrag aus einer Datei (relativ zum aktuellen Ordner),
  `--text` nimmt ihn direkt. Genau eins von beiden.
- `--engine`: `claude` (Standard) oder `codex`. Die Motor-Wahl für Chat-Turns
  (`engine.default`) ändert diesen Standard nicht. Neue Statusdateien speichern
  den Motor; bei alten Dateien ohne `engine` gilt `claude`. Startausgabe,
  `job list` und `/jobs` nennen Motor, Modell und Effort, soweit gesetzt;
  die Abschlussmeldung nennt den Motor, das Wächter-Log alle drei Werte.
- `--topic` legt fest, wohin die Rückmeldung geht (1 ist General). Ohne
  `--topic` gilt das Gespräch, aus dem der Job gestartet wurde
  (`TYBO_CONVERSATION_ID` für ein reines Web-Gespräch, sonst
  `TYBO_TOPIC_ID`/`TYBO_CHAT_ID`, setzt tybo seinen Subprozessen),
  sonst der Direktchat. Ungültige Werte dort oder ein Topic ohne Forum-Gruppe
  brechen den Start ab (Exit 2), statt still in den Direktchat zu melden.
  Ohne Telegram geht die Rückmeldung nur in die WebUI (Issue #227).
- `--max-hours`: Arbeitszeitbudget, Standard 6, höchstens 72 Stunden, auch
  Bruchteile (0.5). Antworten auf Fragen verbrauchen nur den Rest des Budgets;
  Wartezeit zählt nicht. Ausdrückliches Fortsetzen nach Abbruch oder
  „Zeit überschritten“ gewährt wie bisher erneut die volle Zeit.
- `--model` und `--effort` gehen jeweils vor den Einstellungen aus
  `config/settings.json`. Für Claude gelten `defaults.model` und
  `defaults.effort`, sonst `DEFAULT_CLAUDE_MODEL` und `defaultEffort(model)`.
  Für Codex gelten `engine.codex.model` und `engine.codex.effort`. Fehlt dort
  ein Wert, wird die entsprechende Option weggelassen und Codex nimmt seine
  eigene Konfiguration. Die erlaubten Effort-Stufen stehen je Motor in
  `src/lib/settings.ts` (`EFFORT_LEVELS`, `CODEX_EFFORT_LEVELS`).
  Einstellungen und `.env` kommen aus dem Projektordner (`TYBO_ROOT`, sonst
  der Ordner über `scripts/job.ts`), nie aus dem Ordner des Aufrufers.
- `--full-access`: siehe Werkzeugrechte.
- `--allow-duplicate`: siehe „Keine doppelten Jobs".
- `--zurueck`: nach erfolgreichem Bericht einen Turn im Zielgespräch starten,
  zusätzlich zur bisherigen Meldung. Ohne Gesprächskontext geht er an den
  Agenten General im Direktchat, ohne Telegram an den Web-Direktchat.
  Gilt für Claude und Codex; nicht für programmatische Jobs mit eigenem `workDir`.

Exit-Codes: 0 erledigt, 1 gescheitert, 2 falscher Aufruf oder abgelehnt
(unzustellbares Ziel, Doppel beim Start). Abgelehntes Fortsetzen hat Exit 1;
eine ungültige Job-ID oder zusätzliche Optionen haben Exit 2.

## Bericht im Gespräch weiterverarbeiten

Mit `--zurueck` verarbeitet tybo den erfolgreichen Bericht im Zielgespräch,
etwa um ihn zu prüfen, zusammenzufassen oder einen Folgeauftrag zu starten.
Ohne diese Option bleibt es bei der bisherigen Meldung an den Nutzer. Es
geht um dasselbe Gespräch, nicht um dieselbe alte Modell-Session: Nach `/new`
kommt der Bericht in die frische Session. Agent und Motor werden beim Abholen
nach den aktuellen Gesprächseinstellungen gewählt.

Der erfolgreiche Abschluss legt `returnDelivery: { run, state: "pending" }`
in `status.json` an. Die Option `returnToChat` und der Kettenzähler `jobChain`
bleiben beim Fortsetzen erhalten; `returnDelivery` wird je Lauf neu angelegt.
Die Übergänge laufen unter `status.lock`, eindeutig über Job-ID und Laufnummer.
Es gibt keine zweite Warteschlangen-Datei. Auch ein Abschluss durch Aufräumen
oder `job stop` verwendet diese Zustandsübergänge; ein Stopp löst keinen Turn aus.
Der Bot holt beim Start und jede Minute ab, in den Profilen `local` und `server`
jeweils nur aus seinem eigenen Projektordner. Im Hybridbetrieb werden keine
Job-Verzeichnisse zwischen den Rechnern abgeholt.

Die Rückgabe wartet auf `notice.state` `sent` oder endgültig `failed`.
Die bisherige Meldung hat bis zu sechs Versuche über rund 40 Minuten.
Erst danach darf die Antwort kommen. Bei `failed` kann der Bericht beim Nutzer
fehlen; der vorhandene Bericht wird trotzdem verarbeitet. Vor dem Web-Turn
holt der Bot gespeicherte Meldungen auch für den offenen Browser nach.
Eine laufende Antwort oder ein belegter ChatHub lässt die Rückgabe warten.
Reine Web-Gespräche, Direktchat und Topics nutzen bei aktiver WebUI den ChatHub;
Telegram ohne WebUI verwendet dieselbe Gesprächssperre und denselben Turn-Abschluss.

Nur `success` mit lesbarem, nicht leerem Bericht ist fällig. Bei `waiting`,
unbeantworteter Frage, erreichtem Fragenlimit, fehlendem Bericht, Fehler,
Abbruch oder Zeitüberschreitung gibt es keinen Turn. Gelöschte Web-Gespräche
und als gelöscht markierte Topics werden verworfen und protokolliert.
Ein vorübergehend unlesbares Gespräch bleibt offen.

Unmittelbar vor dem Modellaufruf wird `claimed` samt Prozessidentität gespeichert,
nach dem Turn `done`. Ein Neustart zwischen Ablage und Abholung verliert keinen
Eintrag und erzeugt keinen doppelten Turn. Ein Absturz **während** der Verarbeitung
hat dagegen einen unbekannten Ausgang: Der nächste Bot verwirft `claimed`,
protokolliert die Unterbrechung und versucht einmal, einen Hinweis zu senden.
Er startet keinen zweiten Modelllauf, der Werkzeuge oder Folge-Jobs verdoppeln
könnte. Scheitert auch dieser Hinweis, bleibt das Log. `/stop` und Abbruch eines
angenommenen Turns zählen als erledigt. Ein angeforderter Neustart vor dem
Modellaufruf und ein belegter ChatHub lassen den Eintrag `pending`.

Die Eingabe lautet `<job-bericht id="…" titel="…">…</job-bericht>`, mit einem
gesonderten Hinweis auf fremde Daten. Sie wird vor der Übergabe mit `maskSecrets`
maskiert und nach XML-Kodierung auf 20.000 Zeichen Berichtstext begrenzt,
zuzüglich Hülle und Kürzungshinweis. Titel und Session-ID werden ebenfalls
maskiert. Wie beim nachträglichen Meldungsversand kennt der Bot zusätzliche
Geheimnisse eines beendeten Codex-MCP-Plans nicht (siehe „Geheimnisse“).
Merk-Tags aus der Antwort laufen mit `foreignInput: "Job-Bericht"` über das
Intent-Gate als Vorschlag. Diese Turns erkennen keine offenen Fäden.

Der Bericht ist als Job-Meldung schon sichtbar. Die zusätzliche Eingabe wird
mit `metadata.job_report` als interne Nachricht gespeichert und im Browser
nicht als Nutzerblase angezeigt. Beim Motorwechsel bleibt sie als
„Job-Bericht (fremde Daten, keine Nutzeraussage)“ im übergebenen Verlauf.
Nachrichtensuche, Board und die Ermittlung der letzten Nutzeraktivität schließen
diese Eingabe aus; sie erhält kein Embedding. Das Session-Destillat bekommt
ausdrücklich die Regel, daraus und aus abgeleiteten Antworten ohne Bestätigung
des Nutzers keine Fakten, Ziele oder Routinen zu übernehmen.

`TYBO_JOB_CHAIN` zählt den ersten `--zurueck`-Job als 1. Sein Rückgabe-Turn und
der Job selbst bekommen diesen Wert; ein weiterer `--zurueck`-Start erhöht ihn.
Höchstens drei solche Jobs dürfen aufeinander folgen, der vierte wird vor dem
Start mit Exit 2 abgelehnt. Zwischen-Jobs ohne Rückgabe erhalten einen geerbten
Zähler ebenfalls. Normale Chat-Turns übernehmen keinen Wert aus der Bot-Umgebung.
Das gilt für Claude, Codex und OpenCode und kann nicht durch die Liste zusätzlich
erlaubter Umgebungsvariablen geändert werden. Die Grenze schützt vor Versehen,
nicht vor Absicht: Ein Modell mit Shell-Zugriff könnte die Variable entfernen.

Nachweis ohne Bot, Telegram oder echte Modellaufrufe:
`bun --no-env-file scripts/job-return-proof.ts`. Das Skript verwendet einen
temporären Projektordner, die echte CLI, den Wächter, den Abholer und den
Web-Chat-Kern; nur Motor und Nachrichtenspeicher sind Attrappen. Es prüft den
erfolgreichen Bericht, einen nachträglich erzeugten Abholer, die Reihenfolge
Bericht/Antwort und wiederholtes Abholen sowie Neuladen ohne Duplikat.
`bun run scripts/web-browser-check.ts --nur jobs --screenshots` prüft zusätzlich
die Live-Anzeige und dieselbe Reihenfolge nach Neuladen bei 390 und 1280 Pixeln,
hell und dunkel. `web:dev` allein verwendet einen Fake-Chat ohne Job-Abholer und
ist dafür kein Ablaufnachweis.

## Keine doppelten Jobs

Läuft schon ein Job mit demselben Titel (Groß- und Kleinschreibung und
Leerzeichen egal) oder demselben Auftrag, startet `job start` nicht und nennt
den laufenden Job (Exit 2). Geprüft und angelegt wird unter einer Sperre
(`data/jobs/start.lock`), zwei gleichzeitige Starts sehen einander also.
Absichtlich doppelt: `--allow-duplicate`. Anlass: Nach dem Mac-Neustart am
30.9.2026 lasen zwei Sessions (Regelzeit-Topic und Direktchat) denselben
Merk-Eintrag „Jobs neu starten" und starteten die Fortsetzungen je zweimal,
parallel im selben Arbeitsbaum.

Auch `job resume` und der Fortsetzen-Knopf prüfen unter `start.lock` auf
gleiche laufende Aufträge, den eigenen Job ausgenommen. Dafür gibt es keinen
Schalter zum Übergehen. Zwei gleichzeitige Fortsetzungen eröffnen nur einen
neuen Lauf. Ein Knopf gehört zu genau einem Lauf; alte Klicks können keinen
späteren Lauf fortsetzen. Ein wartender Job blockiert gleichnamige Starts
weiterhin. Antworten bleiben an Job, Lauf, Fragenummer und Auswahl gebunden.

## Keine Hintergrund-Befehle

Ein Job läuft mit `claude -p` oder `codex exec`: Er endet mit dem letzten Turn.
Bei Claude gilt außerdem: Befehle, die Claude in den Hintergrund schiebt
(`run_in_background`, oder die
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
- Bei beiden Motoren im Auftrag nach der Berichtsanweisung die Regeln aus
  `JOB_RULES`
  (`src/lib/jobs/runner.ts`): alles im Vordergrund, nichts mit `&` oder
  `nohup` starten, auf dessen Ergebnis gewartet wird, Turn erst nach dem
  Bericht oder einer ausdrücklich erlaubten `frage.json` beenden.

## Werkzeugrechte

Werkzeugfreigaben im laufenden Prozess gibt es nicht. Fachliche Rückfragen
sind für geeignete Claude-Jobs über eine Datei möglich (siehe unten), auch
ohne Befehlsrechte. Eine Antwort ändert die Werkzeugrechte nicht:

- Ohne `--full-access` läuft Claude mit `--permission-mode acceptEdits`: Dateien
  im Projekt lesen und schreiben (auch den Bericht) geht, Befehle ausführen nicht.
- Ohne `--full-access` läuft Codex mit `workspace-write` und
  `approval_policy="never"`. Netz ist ausdrücklich aus
  (`sandbox_workspace_write.network_access=false`); zusätzliche Schreibordner
  und die sonst freigegebenen temporären Ordner sind ausgenommen. Der Bericht
  unter `data/jobs/<id>/report.md` liegt im erlaubten Projektordner.
  **Die Sandbox allein würde Shell-Befehle erlauben und begrenzt weder Apps
  noch native Netzwerkwerkzeuge.** Deshalb schaltet der Aufruf diese Werkzeuge
  gesondert ab, ebenso Code-Ausführung, Agenten und konfigurierte MCP-Server
  (Einzelheiten unten). Zum Bearbeiten bleibt `apply_patch` direkt verfügbar.
  Die Rechte-Einstellung `engine.codex.sandbox` für Chat-Turns gilt nicht für Jobs.
- Mit `--full-access` läuft Claude mit `bypassPermissions` und darf alles.
  Codex bekommt `--dangerously-bypass-approvals-and-sandbox` und
  `approval_policy="never"`, also ebenfalls volle Rechte ohne Rückfragen.
  Dazu bekommt Codex die übertragbaren MCP-Server von tybo mit allen ihren
  Werkzeugen ohne Rückfrage. Die Auswahl folgt `engine.codex.mcp`
  (`enabled`, `skip`, `public`), siehe [MCP-Server](erweiterungen.md#mcp-server).
  Eingeschränkte Codex-Jobs bilden diesen Plan nicht und behalten sämtliche
  Werkzeug-Abschaltungen. Pipeline-Worker bekommen keine Server von tybo.
  Ein Planungsfehler oder eine ungültige MCP-Umgebung lässt den vollen Job
  ohne diese Server starten, mit einer festen Zeile in `watcher.log`.
  Volle Codex-Jobs bekommen außerdem die gekürzte, maskierte Übersicht der
  Claude-Code-Notizen als lesenden Kontext hinter dem Auftrag. Quelle sind
  der Projektordner des Jobs und sein `HOME`. Abschalten geht ohne Neustart
  nur in `config/settings.json` mit `engine.codex.claudeNotes: false`, nicht
  über die WebUI. Fehler beim Holen der Notizen lassen den Job ohne Abschnitt
  starten. Eingeschränkte Jobs und Pipeline-Worker bekommen ihn nicht.
  Einzelheiten: [Was Codex an Kontext bekommt](erweiterungen.md#was-codex-an-kontext-bekommt).
  Das ist nur für Aufträge gedacht, die tybo selbst formuliert hat. Inhalte aus
  Mails, Webseiten oder fremden Dateien gehören nie ungeprüft in einen solchen
  Auftrag.
- Aus dem Programm heraus (nicht über die Befehlszeile) kann ein Job zusätzlich
  erlaubte Werkzeuge (`allowedTools`, etwa `WebSearch` und `WebFetch` für eine
  Recherche) und gesperrte Werkzeuge (`deniedTools`) bekommen. Sie stehen in
  `status.json` und gehen als `--allowedTools` bzw. zusätzlich zu den festen
  Sperren als `--disallowedTools` an Claude; `acceptEdits` bleibt.
- Ebenfalls nur aus dem Programm: ein eigener Arbeitsordner (`workDir`, absoluter
  Pfad, echter Ordner, nie mit `--full-access`). Das geht nur mit Claude;
  `startJob` lehnt `workDir` zusammen mit Codex vor dem Anlegen des Jobs ab.
  Claude startet dann dort statt im Projektordner, mit `--restricted`
  (Einstellungsdateien bleiben aus,
  Dateiwerkzeuge reichen nicht über den Arbeitsordner hinaus,
  `bypassPermissions` geht nicht), `--strict-mcp-config` (keine MCP-Server) und
  `--tools` mit Read, Write, Edit, Glob, Grep und den erlaubten Werkzeugen. Den
  Bericht schreibt der Job als `bericht.md` in den Arbeitsordner; der Wächter
  kopiert ihn nach dem Ende nach `data/jobs/<id>/report.md`, nur als normale
  Datei bis 256 KB. So recherchiert der Entwurf eines Sprachagenten ohne
  `--full-access` und kann nur in seinem Arbeitsordner schreiben (Issue #493,
  `docs/sprechen.md`).

### Codex: Lesen und Werkzeuggrenze

**Ohne `--full-access` sieht Codex als Arbeitsmaterial nur das, was im Auftrag
steht, und kann Dateien im Projekt nur schreiben.** Er kann lokale Textdateien
nicht selbst lesen. `--brief` liest zwar die Auftragsdatei vor dem Start, bettet
aber keine darin genannten Dateien ein. Für Aufträge, die im Projekt lesen
müssen, Claude nehmen oder, ausschließlich bei selbst formulierten Aufträgen,
`--full-access`. Automatisch geladene Projektanweisungen wie `CLAUDE.md` sind
weiterhin Kontext der CLI; sie ersetzen kein Lese-Werkzeug.

In `codex features list`, der Konfigurationsreferenz und den angebotenen
Werkzeugen von CLI 0.169.0 wurde kein Werkzeug gefunden, das Textdateien ohne
Shell lesen kann und nachweislich auf den Projektordner begrenzt ist.
`view_image` liest Bilder, ist kein Textdatei-Leser und wird ebenfalls abgeschaltet.

Die Argumente stehen in `src/lib/jobs/codex-tools.ts` und gelten nur für den
eingeschränkten Lauf, ohne Änderungen an persönlichen Codex-Einstellungen:

| Bereich | Abschaltung |
|---|---|
| Shell und Code-Ausführung | `--disable shell_tool`, `unified_exec`, `code_mode_host`, `code_mode_only`; `features.code_mode.enabled=false` |
| Websuche | `-c web_search="disabled"` |
| Apps, Konnektoren und Plugins | `--disable apps`, `plugins`, `remote_plugin`, `skill_mcp_dependency_install`, `tool_suggest` |
| Browser und Computersteuerung | `--disable browser_use`, `browser_use_external`, `browser_use_full_cdp_access`, `in_app_browser`, `computer_use` |
| Bilder | `--disable image_generation`, `view_image` |
| Unteragenten und Agentenverwaltung | `--disable multi_agent`, `multi_agent_v2`, `agent_message_board`, `agent_message_board_mcp`; `agents.enabled=false` |
| Automatische Befehle | `--disable hooks`, `shell_snapshot`; `notify=[]` |
| Ziele, Warten, Rückfragen und Planverwaltung | `--disable goals`, `sleep_tool`; `tools.experimental_request_user_input.enabled=false`, `tools.update_plan.enabled=false`; Uhrzeit aus dem Code-Modus ausgeblendet |
| Konfigurierte MCP-Server | Jeden ermittelten Server mit `enabled=false` überschreiben, etwa `-c 'mcp_servers={"mail"={enabled=false}}'` |

Die MCP-Vorprüfung startet `codex app-server --listen stdio://` im Projektordner
mit derselben Umgebung und denselben Werkzeugabschaltungen. Über dessen
JSON-RPC-Schnittstelle sendet sie nur `initialize`, `initialized` und
`config/read` mit dem Projektordner als `cwd`. Sie eröffnet keinen Thread und
keinen Modell-Turn. `config/read` liefert die wirksame Benutzer- und
Projektkonfiguration ohne Serverkontakt. Alle Namen, auch bereits deaktivierte,
kommen als Sperren in den Job-Aufruf. Fehler, ungültige Ausgabe oder ein
Zeitlimit von fünf Sekunden verhindern den Start. Server-Zugangsdaten aus der
Ausgabe gelangen nicht ins Log. **`mcp_servers={}` reicht nicht:** Leere Tabellen
werden mit vorhandenen Einträgen zusammengeführt. Die Konfiguration darf sich
zwischen Vorprüfung und Prozessstart nicht ändern; beide Schritte sind kein
atomarer Konfigurations-Schnappschuss.

`codex mcp list --json` wird dafür ausdrücklich nicht verwendet: Eine lokale
HTTP-Attrappe zeigte, dass dieser Befehl MCP- und OAuth-Endpunkte kontaktiert.
Dieselbe Probe mit `config/read` fand Benutzer-, Projekt- und HTTP-Server,
ohne eine einzige Anfrage an die HTTP-Attrappe zu senden.

`functions.exec` ist der Code-Modus: JavaScript läuft in einer V8-Isolate,
laut Werkzeugbeschreibung ohne Node, eigenen Dateisystem- oder Netzwerkzugriff.
Der Code kann aber andere angebotene Werkzeuge aufrufen. Das ist also
Code-Ausführung, kein eigenständiges Lese-Werkzeug. In CLI 0.169.0 entfernen
`features.code_mode.enabled=false` und `--disable code_mode_only` das Werkzeug
**nicht** aus der Liste. `--disable code_mode_host` sperrt seine Ausführung;
ein Aufruf endet mit `code-mode host is disabled`. Damit Schreiben weitergeht,
setzt der Job `features.code_mode.direct_only_tool_namespaces=["functions"]`:
`apply_patch` wird direkt aufgerufen und braucht den Code-Modus nicht.

Eine reine Liste mit nur `apply_patch` ließ sich nicht herstellen. Sichtbar
bleiben `functions.exec`, `functions.wait` sowie `list_mcp_resources`,
`list_mcp_resource_templates` und `read_mcp_resource`. Die ersten beiden haben
keinen Code-Host, die Ressourcenwerkzeuge keine aktiven Server. Sie sind keine
Möglichkeit, lokale Textdateien zu lesen.

Auch `unified_exec` bleibt laut `codex features list` in 0.169.0 intern `true`,
trotz `--disable unified_exec` und des zusätzlich untersuchten alten Schalters
`experimental_use_unified_exec_tool=false`. Die wirksame Shell-Sperre ist
`shell_tool=false`: `exec_command` und `write_stdin` fehlen in der Liste;
ein trotzdem angeforderter `exec_command` wird als unbekannt abgewiesen.

### Beleg mit CLI 0.169.0 (16.11.2026)

Geprüft wurden `codex exec --help`, `codex features list`,
`codex debug prompt-input` und Requests an eine lokale API-Attrappe auf
`127.0.0.1`. Die Attrappe beantwortete Requests selbst und lieferte für
Ausführungsproben vorgegebene Werkzeugaufrufe. Es gab keine echte Modellanfrage;
alle Konfigurationsordner, Testdateien und Server lagen in temporären Ordnern.
Die Konfigurationswerte wurden außerdem mit der offiziellen
[Konfigurationsreferenz](https://developers.openai.com/codex/config-reference/)
und dem [Schema](https://developers.openai.com/codex/config-schema.json)
abgeglichen.

| Beobachtete Werkzeugliste | Vorher: bisherige Job-Optionen einschließlich `--disable shell_tool` | Nachher: neue Job-Optionen |
|---|---|---|
| Code-Modus | `functions.exec`, `functions.wait` | Weiter sichtbar, Ausführung gesperrt; keine verschachtelten Werkzeuge |
| Schreiben | `apply_patch` innerhalb von `functions.exec` | `apply_patch` direkt |
| MCP-Ressourcen | `list_mcp_resource_templates`, `list_mcp_resources`, `read_mcp_resource` | Weiter sichtbar, alle konfigurierten Server gesperrt |
| Lokaler MCP-Testserver | Startet, Namespace `mcp__sentinel` wird zur späteren Werkzeugauflösung angeboten | Startet nicht, Namespace fehlt |
| Weitere lokale Werkzeuge | `view_image`, `create_goal`, `get_goal`, `update_goal`, `clock.curr_time`, `clock.sleep`, `request_user_input`, `request_user_input_async` | Fehlen |
| Agentenverwaltung | `followup_task`, `interrupt_agent`, `list_agents`, `send_message`, `spawn_agent`, `wait_agent` | Fehlt |
| Shell | `exec_command` und `write_stdin` fehlen bereits | Fehlen weiterhin |

Die Ausführungsprobe bestätigte: JavaScript über `functions.exec` wird
abgewiesen, ein direktes `apply_patch` schreibt die Berichtsdatei im Projekt,
ein Patch außerhalb des Projekts wird abgelehnt. Die Sandbox meldet
`workspace-write [workdir]`, ohne zusätzliche temporäre Schreibordner.
`functions.wait` scheitert ebenfalls am deaktivierten Code-Host.
Der in einer temporären Konfiguration eingetragene MCP-Testserver startete
vorher, nachher weder bei der Vorprüfung noch beim Job. Die Ressourcenliste
blieb leer, der Leseversuch endete mit `unknown MCP server 'sentinel'`.
Die temporäre Konfigurationsdatei blieb bei allen Proben unverändert.

**Prüfgrenze:** Die temporären `CODEX_HOME`-Ordner hatten keine Anmeldung.
Konto-Apps, Websuche, Bildgenerierung sowie Browser- und Computerwerkzeuge
waren dort schon vor der Nachbesserung nicht angeboten. Ihre Abschaltungen
sind anhand der akzeptierten Schalter belegt, ihre Wirkung mit einem
angemeldeten ChatGPT-Konto konnte so nicht unabhängig nachgewiesen werden.
Der Nutzerbefund mit Anmeldung enthielt unter anderem Apps, Websuche und
Bildgenerierung. Die Belege gelten für 0.169.0; nach einem CLI-Update muss die
Werkzeuggrenze erneut geprüft werden. Die volle Stufe bleibt unverändert.

## Ablauf

1. `job start` prüft Aufruf und Rückmeldeziel, legt `data/jobs/<id>/` an
   (`brief.md`, `job.log`, `status.json`) und startet den Wächter in einer
   eigenen Prozess-Session mit stdin `/dev/null`. Er wartet bis zu 15 Sekunden,
   bis der Wächter den Motor gestartet hat, und gibt die Job-ID aus.
   Claude-Jobs speichern eine neue UUID als `sessionId` und das aufgelöste
   Modell. Ihr erster Aufruf verwendet `claude -p --output-format text
   --session-id <uuid>`. Codex-Jobs bekommen keine Claude-Session-ID.
2. Der Wächter startet den Motor im Projektordner in einer eigenen Prozessgruppe,
   hinter einer Startsperre: Zuerst läuft nur ein kleiner `sh`, der auf eine
   Freigabe über stdin wartet. Erst wenn PID und Startzeit in `status.json`
   stehen, gibt der Wächter frei, und `sh` wird per `exec` zum Motor (gleiche
   PID, gleiche Startzeit). Stirbt der Wächter vorher, endet `sh`, ohne den Motor
   zu starten. Der Auftrag geht über stdin, mit dem Zusatz „Schreibe am Ende
   einen kurzen Bericht nach data/jobs/<id>/report.md" und den Regeln aus
   „Keine Hintergrund-Befehle". Beide Motoren bekommen die
   Umgebung nach ihren Regeln für Geheimnisse (`subprocessEnv()`, bei Codex
   mit `engine: "codex"`), dazu `TYBO_SUBPROCESS=1`,
   `TYBO_CHAT_ID`/`TYBO_TOPIC_ID` bzw. `TYBO_CONVERSATION_ID` des
   gespeicherten Ziels und `TYBO_JOB_ID`. Codex braucht keine Claude-Anmeldung.
   Die Ausgabe des Motors landet maskiert in `job.log` (siehe Geheimnisse),
   die des Wächters in `watcher.log`.
3. Bei Exit 0 und einer gültigen Frage eines geeigneten Claude-Jobs speichert
   der Wächter zuerst `waiting` mit Fragenummer und Frist, sendet die Auswahl
   und endet. Ein gleichzeitig vorhandener Bericht hat dabei keinen Vorrang.
   Bei einer ungültigen Frage meldet er „Job ohne Bericht“ mit Hinweis, auch
   wenn ein Bericht vorhanden ist. Ein Fehlerexit bleibt „Job fehlgeschlagen“.
   Sonst meldet er über `sendAndRecord` (Telegram und WebUI, Absender
   `job`):
   - Exit 0 und `report.md` nicht leer: Titel, Dauer und Bericht (lange Berichte
     gekürzt, mit Verweis auf die Datei).
   - Exit 0 ohne Bericht: „Job ohne Bericht" mit den letzten 20 Log-Zeilen und
     dem Hinweis, dass nichts mehr nachkommt, auch wenn im Log „läuft noch"
     oder „ich melde mich" steht.
   - Exit-Code ungleich 0 oder Signal: „Job fehlgeschlagen" mit Exit-Code und
     den letzten 20 Log-Zeilen.
   - Zeitlimit erreicht: Die Prozessgruppe des Motors wird beendet (SIGTERM, nach
     5 Sekunden SIGKILL), Meldung „Zeit überschritten" mit Log-Auszug.
   - Liefen nach dem Ende noch Prozesse, die der Motor gestartet hatte (etwa
     ein mit `&` gestarteter Testlauf), stehen sie mit PID und Befehl in der
     Meldung und als `leftovers` in `status.json`. Der Wächter hält dafür alle
     10 Sekunden fest, was unter dem Motor läuft (`ProcessTracker`, `ps -A`), und
     prüft nach dem Ende, was davon noch lebt (gleiche PID und Startzeit).
     Beendet werden sie nicht, es kann Absicht sein (etwa eine neu gestartete
     Pipeline).
4. `job stop` beendet die Prozessgruppe auf dieselbe Weise und meldet
   „Job gestoppt". Der Wächter schweigt danach.
5. Nach einem Abbruch oder Zeitlimit kann ein geeigneter Claude-Job ausdrücklich
   fortgesetzt werden (siehe „Nach einem Absturz“). Der neue Wächter nutzt
   `claude -p --output-format text --resume <session-id>` und denselben
   Arbeitsordner, dasselbe Modell, Effort, Werkzeugrechte und Rückmeldeziel.
   Seine Nachricht nennt den Unterbrechungsgrund, fordert zur Prüfung der
   bisherigen Arbeit auf und enthält wieder Berichtspfad und `JOB_RULES`.
   Das erneute volle Zeitlimit steht in der Frage und in der Startbestätigung.

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

## Eine Entscheidung erfragen

Nur Claude-Jobs mit gespeicherter `sessionId` und ohne eigenen `workDir`
dürfen fragen. Codex, ältere Jobs ohne Session und Sprachagenten-Entwürfe
bekommen keinen Zusatz im Auftrag und ignorieren `frage.json`.

Fehlt eine Entscheidung, schreibt Claude mit dem Dateiwerkzeug
`data/jobs/<id>/frage.json` und beendet den Turn ohne Bericht:

```json
{
  "frage": "Soll ich A oder B verwenden?",
  "antworten": ["A", "B"],
  "kontext": "Für den nächsten Arbeitsschritt fehlt diese Auswahl."
}
```

Nur diese drei Felder sind erlaubt. Frage: höchstens 500 Zeichen, Kontext:
1.000, Antworten: 1 bis 8 verschiedene, nicht leere Texte mit je höchstens
80 Zeichen. Datei: höchstens 16 KiB, normale Datei, kein Link oder Verzeichnis.
tybo erzeugt Optionsschlüssel selbst (`a1` bis `a8`) und maskiert Frage,
Kontext, Antworten und Session-ID vor der Ablage im Auswahlregister und vor
jeder Anzeige. Der Folgeauftrag enthält ausschließlich die Antwort als
JSON-Zeichenfolge unter „Antwort des Nutzers“, ausdrücklich als Daten und
ohne neue Werkzeugfreigabe. Der Fragetext wird nicht zum Folgeauftrag.

Im Browser antwortet man mit einem Knopf. In Telegram kann der Besitzer
zusätzlich auf genau die Fragemeldung antworten (Reply, höchstens 2.000
Zeichen). Gewöhnliche Nachrichten im Gespräch bleiben normale Chat-Turns.
Ein Reply lässt zuerst die Knöpfe ablaufen und wird vor dem Laufwechsel
gespeichert. Klick, Reply, Stopp und Fristablauf sind über die Statussperre
abgesichert. Die Antwort startet einen neuen Wächter mit `--resume`, derselben
Session und dem Restbudget. Die Laufnummer steigt; `job.log` und `report.md`
bleiben als `job-run-<n>.log` und `report-run-<n>.md` erhalten. Die geprüfte,
maskierte Frage liegt danach in `fragen/<nummer>.json`. Vor jedem Motorstart
werden alte `frage.json`-Dateien aus dem aktiven Pfad entfernt.

Der Bot prüft beim Start und regelmäßig im Minutentakt die gespeicherte
Frist. Nach 48 Stunden ohne Antwort endet der Job als `unanswered` mit
„Frage unbeantwortet“ und **Fortsetzen**. Die Frage wird archiviert, ihre
Knöpfe laufen ab. Fortsetzen gibt keine Antwort vor und erneuert das Budget
nicht: Claude soll dieselbe Frage erneut stellen, sofern noch Fragen übrig
sind, sonst einen Bericht über die offene Entscheidung schreiben.
Höchstens fünf Fragen je Job, über alle Läufe und Fortsetzungen hinweg;
die fünfte darf beantwortet werden. Schreibt Claude eine sechste, endet der
Job mit „Fragenlimit erreicht“. Der Auftragszusatz nennt bei jedem Lauf,
wie viele Fragen verbleiben. `job stop` beendet auch wartende Jobs samt Frage.

Nachweis ohne Bot: `bun --no-env-file scripts/job-question-proof.ts --real`
verwendet einen temporären Projektordner, zwei echte Claude-Turns, eine
lokale HTTP-Annahme und den echten Antwort-Handler. Es prüft Frage, Auswahl,
Session-Fortsetzung und Bericht. `bun run scripts/web-browser-check.ts --nur
jobs --screenshots` prüft die Knöpfe im Browser bei 390 und 1280 Pixeln, hell
und dunkel. Nur der erste Befehl verbraucht Modellnutzung.

## Genau eine Meldung

Die Regel gilt je Lauf. Wer einen Lauf beendet (Wächter, `job stop`, Zeitlimit,
Aufräumen beim Bot-Start), muss in `status.json` den Übergang nach `ended` gewinnen. Das
passiert unter einer Datei-Sperre (`status.lock`, `src/lib/file-lock.ts`), weil
mehrere Prozesse beteiligt sind. Nur der Gewinner meldet sich. Kommen Stopp und
Prozessende gleichzeitig, gibt es trotzdem nur eine Meldung. Die Laufnummer
schützt einen neuen Lauf vor verspäteten Wächtern und Abschlüssen des alten.

Eine fachliche Frage ist keine Abschlussmeldung. Sie hat einen eigenen
Versandzustand und wird bei Fehlern mit denselben Abständen wiederholt.
Scheitern alle Versuche, endet der Job mit „Frage nicht zugestellt“; seine
Abschlussmeldung nutzt wieder den üblichen Meldeweg. Nach einem Absturz
mitten im Versand kann auch eine Frage doppelt zugestellt werden, sie bleibt
aber dieselbe Auswahl und eröffnet höchstens einen neuen Lauf.

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

Erst nach endgültigem Versandabschluss (`sent` oder `failed`) kann die
separate kurze Frage „Job <id> fortsetzen?“ mit dem Knopf **Fortsetzen**
folgen. Sie gehört zur gemeinsamen Auswahlverwaltung (Art `job`), enthält
nur den maskierten Titel und verändert die geprüfte Markdown-Meldung nicht.
Die Frage und eine Bestätigung des Klicks zählen nicht als zweite
Abschlussmeldung. Scheitert die Frage, wird die Abschlussmeldung nicht
wiederholt; der Befehl `job resume` bleibt möglich. Stirbt der Absender
zwischen Abschlussmeldung und Frage, wird die Frage nicht nachträglich
garantiert. Auch dann hilft der Befehl.

Der Wächter sendet die Frage bei Zeitlimit selbst über die Outbox; beim
Abbruch übernimmt sie die Wiederherstellung. Beide nutzen `data/choices.json`
im Projektordner und das ursprüngliche Ziel, auch reine Web-Gespräche ohne
Telegram. Nur der Bot verarbeitet Entscheidungen; die WebUI benutzt dafür
denselben Handler wie Telegram.

## Jobs in der WebUI

Der Eintrag **Jobs** neben „Offene Fäden“ öffnet die Ansicht `#/jobs`.
Die hervorgehobene Zahl zählt Jobs, die auf den Nutzer warten. Wartet keiner,
steht dort die Zahl der startenden und laufenden Jobs; ohne aktive Jobs
bleibt die Zahl verborgen. Die Liste zeigt wartende Jobs zuerst, dann alle
startenden und laufenden, danach die letzten 20 beendeten. Je Job stehen
Titel, Status wie bei `/jobs`, Arbeitszeit ohne Wartezeit, Laufnummer und
Ursprungsgespräch. „Zum Gespräch“ öffnet dieses Gespräch.

- **Frage beantworten:** aufklappen, Frage und Kontext lesen und einen der
  vorhandenen Knöpfe wählen. Es ist dieselbe Auswahl wie im Gespräch und in
  Telegram: Die erste Antwort gewinnt. Fehlen Auswahl oder zuordenbares
  Gespräch, bleibt die Frage lesbar, ohne Knöpfe.
- **Fortsetzen:** erscheint genau dann, wenn die Vorbedingungen von
  `resumeBlockReason` erfüllt sind, auch nach einer unbeantworteten Frage.
  Eine noch offene Fortsetzen-Frage wird dabei im Register entschieden,
  damit sie in allen Kanälen erledigt ist. Sonst gilt derselbe Weg wie
  `job resume`. Codex, eigene Arbeitsordner, alte Jobs ohne Session,
  unsicher beendete Prozesse und noch ausstehende Abschlussmeldungen
  erlauben keine Fortsetzung.
- **Stoppen:** für startende, laufende und wartende Jobs, erst nach
  Bestätigung. Ein bewusst gestoppter Job lässt sich nicht fortsetzen.
  Die HTTP-Antwort wartet auf den gewonnenen Statusübergang und die
  Beendigung der Prozessgruppe, nicht auf Telegram. Entfernen der Knöpfe
  und Versand der Abschlussmeldung laufen im Hintergrund. Derselbe
  `settleAndDeliver`-Weg hält Besitzer und ausstehende Zustellung dauerhaft
  fest; die Wiederherstellung bleibt zuständig, falls der Bot dabei endet.
- **Log:** höchstens die letzten 200 Zeilen des aktuellen Laufs, maskiert,
  je Zeile höchstens 300 und insgesamt höchstens 60.000 Zeichen. Auch große
  Logs werden nur am Ende gelesen (256 KiB plus Vorlauf gegen abgeschnittene
  Geheimnisse); erst maskieren, dann kürzen.
- **Bericht:** `report.md` des aktuellen Laufs als Markdown, gegen sichtbare
  Geheimnisse auch nach dem Rendern geprüft. Über 128 KiB erscheint ein
  Größenhinweis. Ohne aktuelle Datei fehlt der Knopf; alte archivierte
  Berichte und Logs werden nicht als aktueller Lauf gezeigt. Symlinks sind
  keine angebotenen Berichte oder Logs.

Die offene, sichtbare Ansicht fragt alle zehn Sekunden nach; Meldungen,
Auswahl-Änderungen und die Rückkehr in den Tab lösen ebenfalls einen Abgleich
aus. Bei Fehlern bleibt der letzte Stand mit Hinweis sichtbar. Aktionen
tragen eine einmalige Kennung aus `data/choices.json` und die angezeigte
Laufnummer. Ein alter Tab darf keinen späteren Lauf stoppen oder fortsetzen.
Neue Jobs werden weiterhin im Gespräch oder per Befehl beauftragt.

Die Liste und die Aktionsantworten liefern nur freigegebene Felder, keine
Prozesskennungen, Session-ID, Telegram-Chat-ID, Arbeitsordner oder den Auftrag.
Log und Bericht können Teile des Auftrags und Pfade enthalten. Ihre Werte
werden wie bei `job log` einschließlich der Session-ID maskiert; der
Home-Ordner wird durch `~` ersetzt. Fremder Inhalt im Bericht führt keine
Skripte aus. Die Grenze bei nur im früheren Codex-MCP-Plan bekannten Werten
bleibt wie unter „Geheimnisse“ beschrieben.

## Nach einem Absturz

Beim Start prüft der Bot alle Jobs (`recoverJobs` in `src/lib/jobs/control.ts`):

- `waiting` bleibt wartend, auch ohne lebenden Wächter. Eine noch nicht
  zugestellte Frage wird nachgesendet, ein fehlender oder kaputter
  Register-Eintrag aus dem Status neu angelegt, ohne Frist oder Fragenzähler
  zurückzusetzen. Bereits gespeicherte Klicks und Replies werden nachgeholt,
  wenn ihr Handler vor dem Laufwechsel ausfiel. Der Bot prüft das auch
  regelmäßig während des Betriebs; der Nachtcheck wertet Warten weder als
  toten Wächter noch als überschrittene Arbeitszeit.

- Steht ein Job auf „läuft", aber sein Wächter lebt nicht mehr (Absturz,
  Neustart des Rechners, unter systemd mit einer alten Dienstdatei auch der
  Neustart des Bots), wird der noch laufende Motor beendet und der Job
  als „abgebrochen" gemeldet, mit Log-Auszug.
- Wer mit Stopp, Zeitlimit oder Abbruch gewinnt, trägt zuerst „Beendigung
  ausstehend" in `status.json` ein und beendet dann die Prozessgruppe.
  Starb er dazwischen, beendet der Bot die Gruppe beim Start und meldet erst
  danach. Ließ sie sich nicht sicher beenden, steht das in der Meldung.
- Starb ein Absender mitten im Versand, holt der Bot die Meldung nach. Ob
  Telegram den unterbrochenen Versuch noch angenommen hat, ist dann nicht zu
  erkennen; im Zweifel kommt die Meldung doppelt statt gar nicht.

Ein Lauf, der gerade erst angelegt wurde und noch keinen Wächter eingetragen
hat, bekommt 60 Sekunden Schonfrist, auch nach dem Fortsetzen. Dafür steht
`runCreatedAt` im Status; `createdAt` bleibt das Anlegedatum des Jobs.
Fällt der Bot-Start in diese Frist, prüft
der Bot den Job nach ihrem Ablauf noch einmal (`recoverJobsUntilSettled`).

Prozesse werden über PID und Startzeit (`ps -o lstart=`) erkannt. Eine neu
vergebene PID mit anderer Startzeit gilt als fremd und bekommt kein Signal.
Als beendet gilt ein Wächter oder Absender nur, wenn seine PID nicht mehr lebt
oder eine andere Startzeit hat. Lebt die PID und ist die Startzeit nicht
prüfbar, bleibt alles, wie es ist: kein Abbruch, keine Übernahme der Meldung.
Die Identität wird vor SIGTERM und noch einmal vor SIGKILL geprüft.
Ohne Startzeit gibt es nie ein Signal: Ist sie für den Motor beim Start nicht
ermittelbar, startet er gar nicht (Meldung „nicht gestartet"); ist sie
später nicht abfragbar, bleibt der Prozess stehen und `job stop` sagt das.

### Ausdrücklich fortsetzen

**Fortsetzen** an der Abbruch- oder Zeitmeldung und `bun run job resume <id>`
starten denselben Job als nächsten Lauf. Es gibt kein automatisches
Fortsetzen. Die Frage verfällt nach sieben Tagen; danach geht der Befehl
weiterhin. Fortsetzen per Befehl lässt eine noch offene Frage ablaufen.
Ein Klick während eines bereits gestarteten Laufs antwortet „läuft schon“.

Fortsetzen ist bei `aborted`, `timeout` und `unanswered` erlaubt, wenn Claude im alten
Lauf tatsächlich gestartet war (`claude` und `startedAt` vorhanden).
Bewusst gestoppte Jobs (`stopped`), erfolgreiche oder fehlgeschlagene Jobs
(`success`, `failed`, `no_report`, `start_failed`) bleiben beendet. Codex-Jobs,
alte Jobs ohne gespeicherte Session-ID und Jobs mit eigenem `workDir`
(etwa Sprachagenten-Entwürfe) bekommen keinen Knopf und eine klare Ablehnung
beim Befehl. Die Entwurfsverwaltung kann weiter auf endgültiges `ended` bauen.

Nach Abbruch oder Zeitüberschreitung muss der alte Motor sicher beendet sein: `termination.state` ist `done`,
das Ergebnis `gone` oder `foreign`. Bei `survived` oder `unverified` bleibt
Fortsetzen gesperrt, weil noch ein Prozess in dieselbe Session schreiben
könnte. Auch eine ausstehende oder laufende Meldungszustellung sperrt den
Übergang. Erst nach `notice.state` `sent` oder `failed` setzt `claimResume`
unter `status.lock` den Job von `ended` auf `starting`.

Ein noch als `running` oder `starting` eingetragener Job wird abgelehnt.
Bei `waiting` verweist der Befehl auf die Knöpfe oder den Telegram-Reply.
Lebt sein Wächter, heißt es „läuft schon“. Ist er tot, verlangt der Befehl
zuerst den sicheren Abschluss durch `recoverJobs`; er räumt nicht selbst
nebenläufig auf. Für einen technischen Nachweis ohne Bot-Start kann ein
eigenes Skript `recoverJobs(createJobDeps({ root, env }))` aufrufen. Dabei
unbedingt einen isolierten Projektordner und ein eigenes Nachrichtenziel
verwenden, sonst werden echte Jobs geprüft und echte Meldungen verschickt.

Die Session-Datei muss lesbar und nicht leer sein. Gesucht wird unter
`~/.claude/projects/<kodierter Arbeitsordner>/<uuid>.jsonl`, mit `HOME` aus
der Job-Umgebung und der gemeinsamen Ordnerkodierung aus `claude-notes.ts`.
Fehlt sie, startet kein Wächter. Verschwindet sie nach der Vorprüfung oder
lehnt die CLI `--resume` ab, endet der neue Lauf als fehlgeschlagen. Es gibt
keinen Rückfall auf `--session-id` oder einen frischen Auftrag. Die Session-ID
bleibt im Status; Meldungen, Listen und Logs maskieren sie.

Vor einem neuen Lauf werden `report.md` und `job.log`, soweit vorhanden, zu
`report-run-<n>.md` und `job-run-<n>.log` umbenannt. Ein alter Bericht kann
dadurch keinen erfolgreichen neuen Lauf vortäuschen. Prozessreferenzen,
Beendigungs- und Versandzustand, Ergebnis, Exit-Code, Signal, Details und
Restprozesse werden zurückgesetzt. `startedAt` entsteht erst beim neuen
Motorstart; Schonfrist und Gesundheitscheck berücksichtigen den neuen Lauf.
Die angezeigte Dauer summiert die Arbeitszeit aller neuen Läufe, ohne Wartezeit.

Automatisierungen für Folgeaufträge und Prüfungen lesen den jeweils aktuellen
Status. Ein bereits ausgelöster Folge-Job wird durch das
Fortsetzen eines älteren Jobs nicht zurückgenommen. Die Doppelprüfung findet
gleiche Titel oder Aufträge, sperrt aber nicht den gesamten Arbeitsbaum für
verschiedene Jobs. Vor dem Fortsetzen eines älteren Pipeline-Jobs deshalb
prüfen, ob dort bereits ein anderer Auftrag arbeitet.

Der reproduzierbare Nachweis `bun --no-env-file scripts/job-resume-proof.ts
--real` startet zwei kurze echte Claude-Turns in einem temporären Ordner,
beendet nur den eigenen Testwächter, ruft `recoverJobs` auf und führt die
echte Job-CLI mit `resume` aus. Eine lokale HTTP-Annahme ersetzt die
Nachrichtendatenbank; Telegram und Bot werden nicht gestartet. Geprüft werden
dieselbe Session, ein Bericht mit einer Information aus dem ersten Turn
und genau eine Abschlussmeldung je Lauf. Er braucht eine bestehende
CLI-Anmeldung und verbraucht Modellnutzung; er gehört nicht zum automatischen
Testlauf.

## Geheimnisse

Codex CLI 0.169.0 gibt bei `exec` ohne `--json` den über stdin erhaltenen
Auftrag auf stderr wieder (mit erfundenen Notizen in einer isolierten
Konfiguration geprüft). Dadurch kann auch die Notizenübersicht in
`data/jobs/<id>/job.log` stehen. Diese Datei hat Rechte 0600 und wird vor
dem Schreiben vollständig maskiert, dort auch für Werte unter acht Zeichen.
Das ist strenger als die Maskierung der Übersicht im Prompt.

Alles, was ein Job meldet, anzeigt oder protokolliert (Titel, Bericht,
Log-Auszug, Grund, `job log`, `job list`, `/jobs`, `job.log`, `watcher.log`,
Fehlertexte in `status.json`), wird vorher maskiert und erscheint als
`[verborgen]`:

- Jeder Wert aus der `.env`, in jeder Länge und überall im Text, auch mitten
  in einem Wort. Kurze Werte treffen so auch harmlose Stellen: steht
  `WEB_PORT=3100` in der `.env`, wird aus `31000` ein `[verborgen]0`.
- Aus der Umgebung die Werte geheim benannter Variablen (`*_TOKEN`, `*_KEY`,
  `*PASSWORD*`, `TELEGRAM_*` und Co.), ebenso überall.
- Im Wächter eines vollen Codex-Jobs zusätzlich alle Werte aus dem MCP-Plan,
  auch wenn sie nur in einer MCP-Datei stehen. Das gilt für stdout und stderr
  beim Schreiben des Logs, Abschlussmeldungen und Berichte beim Versand,
  Startfehler sowie die Befehle übrig gebliebener Prozesse. Reiner Leerraum
  entfällt; kurze Werte wie `1` oder `true` treffen auch harmlose Stellen und
  können Logs und Meldungen schlechter lesbar machen.

Der Wächter hält die Planwerte ausschließlich im Speicher, er legt sie
weder in `status.json` noch in einer anderen Job-Datei als Konfiguration ab.
Die Werte liegen in der Umgebung von Codex und sind bei vollem Zugriff auch
für seine Shell lesbar. Schreibt das Modell selbst einen Wert in seinen
Bericht, bleibt die Datei unverändert; der Wächter maskiert den Versand.
Übernimmt ein anderer Prozess die Meldung (`job stop` oder Aufräumen beim
Bot-Start), kennt er den MCP-Plan nicht. Das bereits geschriebene Log ist
maskiert, ein Modellbericht wird dort jedoch nur mit den bisherigen Werten
aus `.env` und der Umgebung maskiert.

Vor dem Maskieren fallen unsichtbare Zeichen weg (wie beim Versand an
Telegram), damit ein durch ein solches Zeichen getrennter Wert erkannt wird.
Zusätzlich prüft der Wächter den Text, den Telegram von der fertigen Meldung
zeigt: Würden Titel, Grund, Bericht oder Log-Auszug erst durch die Umwandlung
(Markdown-Zeichen, Link-Adressen fallen weg) einen Wert zeigen, wird dieser
Teil ganz verborgen, mit Hinweis auf den Bericht bzw. `job log`.

Die Ausgabe des Motors wird schon beim Schreiben nach `job.log` maskiert, auch
wenn ein Wert über mehrere Ausgabestücke verteilt ankommt. Dafür liest der
Wächter stdout und stderr über Pipes; stirbt er, verliert der Motor seine Ausgabe
und endet beim nächsten Schreiben, der Bot meldet den Job dann beim Start als
abgebrochen.

## Aufbau

| Datei | Aufgabe |
|-------|---------|
| `scripts/job.ts` | Einstieg für `bun run job` und `tybo job`, auch der Wächter (`__watch <id> <lauf>`) |
| `src/lib/jobs/cli.ts` | Aufruf, Rückmeldeziel |
| `src/lib/jobs/runner.ts` | Start und Wächter |
| `src/lib/jobs/resume.ts` | Fortsetzen mit Startsperre und Doppelprüfung |
| `src/lib/jobs/session.ts` | Vorhandene Claude-Session prüfen |
| `src/lib/jobs/choices.ts` | Fortsetzen-Frage und gemeinsamer Entscheidungshandler |
| `src/lib/jobs/question-file.ts` | Frageformat, sichere Datei-Prüfung und Auftragszusatz |
| `src/lib/jobs/question-state.ts` | Gesperrte Übergänge in und aus waiting |
| `src/lib/jobs/question-choices.ts` | Frage zustellen, wiederherstellen, gezielte Replies |
| `src/lib/jobs/notice.ts` | Meldungstext und Zustellung |
| `src/lib/jobs/return.ts` | Rückgabe je Lauf, Abholung und Absturzgrenze |
| `src/lib/jobs/report-input.ts` | Maskierte, begrenzte Eingabe mit Herkunft |
| `src/lib/jobs/chain-context.ts` | Kettenzähler je Turn ohne globale Umgebung |
| `src/app/job-reports.ts` | Rückgabe an ChatHub oder Telegram-Turn |
| `src/lib/jobs/control.ts` | Liste, Stopp, Log, Aufräumen beim Start |
| `src/lib/jobs/store.ts` | Ordner, Status, Übergänge unter Sperre |
| `src/lib/jobs/process.ts` | Prozess-Identität, Prozessgruppe beenden |
| `src/lib/jobs/mask.ts` | Maskierung |
| `src/web/jobs.ts`, `src/web/bot-jobs.ts` | Jobs-API mit Positivliste und echter Quelle |
| `src/web/public/jobs.js` | Jobs-Ansicht, Knöpfe und Abgleich |

Tests: `tests/jobs-*.test.ts`, mit Attrappen für beide Motoren und ohne Telegram.

Nicht vorgesehen: Rückfragen für die Pipeline oder für Codex und eigene
Arbeitsordner, eine Übersicht offener Entscheidungen quer über alle Dienste,
Warteschlange für Job-Starts und Begrenzung paralleler Jobs.
Eine Obergrenze für parallele Jobs und volle Testläufe ist
nach dem Mac-Hänger vom 30.9.2026 als Issue #266 geplant.
