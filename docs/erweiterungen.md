# tybo erweitern

`tybo setup` richtet das ein, was jeder braucht (siehe
[einrichtung.md](einrichtung.md)). Alles Weitere steht hier, je ein Abschnitt:
was es bringt, was du brauchst, wie du es einrichtest und wie du prüfst, ob es
geht. Werte für die `.env` sind in [`.env.example`](../.env.example) erklärt.
Nach einer Änderung an der `.env` braucht der Bot einen Neustart.

## Agenten anpassen

**Was es bringt:** Jeder der acht Agenten (General, Research, Content,
Finance, Strategy, Critic, CTO, COO) bekommt dauerhaft eigene Anweisungen,
etwa kürzere Antworten oder eine feste Form, ohne dass du Code änderst.

**Was du brauchst:** nichts außer dem laufenden Bot.

**Einrichten:** In Telegram, im Browser oder im Terminal-Chat
`/agent <name>: <anweisung>` schicken, zum Beispiel
`/agent research: antworte kürzer`. Die Anweisungen landen je Agent als Liste
in `config/agent-overrides.json` und werden an dessen System-Prompt gehängt.
Du kannst die Datei auch von Hand bearbeiten.

**Prüfen:** Eine Änderung greift ab der nächsten frischen Sitzung; `/new` im
Gespräch erzwingt das sofort. Danach eine Frage an den Agenten stellen.

**Motor je Agent:** In der WebUI unter Einstellungen, „Agenten“ den Agenten
aufklappen, im Feld „Motor“ wählen und bei diesem Agenten speichern. Zur
Auswahl stehen „Standard“, Claude Code, Codex, OpenCode und Anthropic API.
Es gilt der Vorrang Gespräch (`/motor`), Agent, Standard. `/motor standard`
entfernt nur die Gesprächswahl und kehrt zum Motor des Agenten zurück, sonst
zum Standard. Änderungen gelten ohne Neustart; ein anderer Motor beginnt
mit der nächsten Nachricht eine neue Session mit Übergabe des Verlaufs.
Die Pille im offenen Gespräch aktualisiert sich auch ohne Nachricht.

Modell und Effort des Agenten gelten für Claude Code und die Anthropic API.
Die API nimmt nur volle Modellnamen wie `claude-opus-5-5`; bei `opus` gilt ihr
Standardmodell, unbekannter Effort entfällt. Sie zahlt je Verbrauch. Bei
Codex und OpenCode kommen Modell und Effort aus den Einstellungen des Motors;
die Agentenfelder sind ausgegraut, ihre Werte bleiben gespeichert. Springt
Claude Code ein, gelten sie wieder, sofern die Ersatzstufe keine eigenen
Werte vorgibt. Auch „Standard“ richtet die Felder nach dem Standard-Motor.

Die Limit-Regel gilt ebenso für den Wunschmotor eines Agenten: Mit
Ersatzstufen nimmt tybo bei einer Sperre oder fehlender Bereitschaft die
nächste freie Stufe der allgemeinen Reihenfolge. Die Anthropic API bleibt
auch als Agentenmotor eine Wahl von Hand und springt niemals automatisch
als Ersatz ein. Nebenaufgaben, Jobs und Routinen nutzen diese Agentenwahl
nicht.

## Topics zuordnen

**Was es bringt:** In einer Telegram-Forum-Gruppe antwortet in jedem Topic
ein fester Agent, etwa Research im Topic „Recherche“.

**Was du brauchst:** die Forum-Gruppe aus dem Schritt `gruppe` von
`tybo setup`, mit dem Bot als Admin, und ein Topic je Agent.

**Einrichten:** `config/topics.example.json` nach `config/topics.json`
kopieren. Außen stehen Chat-IDs (oder `*` für alle Chats), innen Topic-IDs,
als Wert der Agent (`general`, `research`, `content`, `finance`, `strategy`,
`critic`, `cto`, `coo`). Die Topic-ID zeigt `/topics`, im jeweiligen Topic
geschickt. Schreibst du in einem Topic ohne Zuordnung, fragt tybo einmal mit
Knöpfen, welcher Agent es übernimmt, und trägt die Antwort ein.

**Prüfen:** `/topics` im Topic nennt die Zuordnung für diesen Chat.

## Eigener Bot je Agent

**Was es bringt:** Antworten eines Agenten kommen von einem eigenen
Telegram-Bot mit eigenem Namen. Eine Erwähnung wie `@deinresearchbot` holt
diesen Agenten in ein beliebiges Topic.

**Was du brauchst:** je Agent einen Bot von
[@BotFather](https://t.me/BotFather) (`/newbot`).

**Einrichten:** Das Token je Agent in die `.env`:
`TELEGRAM_BOT_TOKEN_<KENNUNG>`, die Kennung des Agenten groß geschrieben,
ein Bindestrich wird zum Unterstrich (`TELEGRAM_BOT_TOKEN_RESEARCH`,
`TELEGRAM_BOT_TOKEN_CTO` usw.). Die Bots senden nur, einen Webhook brauchen
sie nicht; wer erwähnt werden soll, muss in der Gruppe sein. Fehlt ein Token,
schreibt dieser Agent über den Haupt-Bot. Wie oft sich Agenten in einer
Antwort gegenseitig fragen dürfen, begrenzt `AGENT_INVOKE_BUDGET`
(Standard 3).

**Prüfen:** Nach dem Neustart eine Frage im Topic des Agenten stellen; die
Antwort kommt vom neuen Bot.

## Ersatzstufen und Automatik

Ein Motor bearbeitet einen Auftrag mit seinen Werkzeugen. Eine Stufe ist ein
Motor mit optionalem Modell und Effort. Wenn eine Stufe am Limit oder nicht
bereit ist, nimmt tybo die nächste freie. Erst danach kommen die
Ersatzmodelle mit eingeschränktem Werkzeugumfang der Fallback-Kette. Diese
haben MCP-Werkzeuge und eingebaute Werkzeuge, aber nicht den Umfang eines
Motors.

**Einrichten:** In der WebUI Einstellungen öffnen, dann „Modelle“ und dort
den Abschnitt „Motor“. Standard-Motor wählen, „Stufe hinzufügen“
anklicken, Motor und bei Claude Code gegebenenfalls Modell und Effort wählen.
Mit „Hoch“ und „Runter“ ordnen, dann im Abschnitt speichern. Ein möglicher
Aufbau: Claude Code mit dem Standardmodell, Claude Code mit Opus 5.5, Codex,
OpenCode. Ein Teil-Limit der ersten Claude-Modellfamilie lässt eine andere
Claude-Familie frei; Woche für alle Modelle und Fünf-Stunden-Limit treffen
beide. Vorher Anmeldung und [Werkzeuge im Ersatzmotor](#werkzeuge-im-ersatzmotor)
prüfen. Ein Ersatzmotor arbeitet mit den Rechten, die für ihn eingestellt
sind; mit der Automatik läuft er öfter.

Die Werte stehen in `config/settings.json` und wirken ohne Neustart:

| Einstellung | Bedeutung |
|---|---|
| `engine.default` | Standard-Motor, vor `TYBO_ENGINE` aus der Umgebung. |
| `engine.backups` | Geordnete Liste mit höchstens vier Einträgen `{ engine, model?, effort? }`. Erlaubt sind `claude`, `codex`, `opencode`; nur Claude-Stufen haben eigenes Modell und Effort. Codex und OpenCode verwenden `engine.codex` und `engine.opencode`. Keine doppelten Stufen; `api` ist kein Ersatz. |
| `engine.auto.enabled` | Standard an, sobald Ersatzstufen vorhanden sind. Aus verhindert neue Schwellen-Sperren und hebt bestehende auf; bei Limit-Fehlern und Ausfällen wird weiter gewechselt. |
| `engine.auto.threshold` | „Wechseln ab (%)“: ganze Zahl von 50 bis 99, Standard 95. Erst eine Messung an oder über der Schwelle sperrt. |
| `engine.auto.returnBelow` | „Zurück unter (%)“: Standard Schwelle minus 15, also 80 bei 95. Ein eigener Wert ist mindestens 0 und mindestens 5 Punkte unter der Schwelle. Leer im Browser verwendet wieder den Standard. |

Ohne Ersatzstufen gilt die Wechselregel nicht: Der gewählte Motor arbeitet
wie vorher, mit dem bisherigen Rückfall bei Fehlern. Eine leere Liste erzeugt
deshalb nicht „keine Stufe frei“. Mit Ersatzstufen steht die Wahl des Gesprächs, sonst die des Agenten,
sonst der Standard-Motor vorn; dahinter folgen die übrigen Stufen ohne Doppelte.

**Bedienen:** `/motor` zeigt die Reihenfolge, den Grund der Wahl sowie Stand
und Alter der Messwerte. `/motor claude`, `/motor codex`, `/motor opencode`
oder `/motor api` setzen einen Wunsch für dieses Gespräch; eine Sperre wird
damit nicht umgangen. `/motor standard` entfernt nur die Gesprächswahl; dann gilt der Motor
des Agenten, sonst der Standard. Eine Modellwahl
als zweites Argument gibt es nicht. `/motor auto an` und `/motor auto aus`
ändern die allgemeine Automatik. `/motor pruefen` und „Jetzt messen“ messen
neu und bewerten Sperren. `/motor werkzeuge` zeigt Bestand und Lücken.

**Schwelle und Rückkehr:** Messwerte stehen in `data/engine-usage.json`,
Sperren und Fehlerzähler in `data/engine-switch.json`. Eine Messung an oder
über der Schwelle sperrt ihr Fenster bis zum Reset, ohne bekannte Reset-Zeit
für 60 Minuten ab der Messung. Eine jüngere Messung **unter** der
Rückkehrschwelle hebt diese Fenstersperre vorzeitig auf; genau 80 % reichen
bei einer Rückkehrschwelle von 80 nicht. So vermeidet tybo ständiges Hin und
Her. Beim Ändern der Schwelle werden bestehende Schwellen-Sperren neu
bewertet. Neue entstehen erst mit einer Messung. Die Schwelle auf 95
zurückzustellen gibt einen Stand von 96 % nicht frei. Nach dem Ende einer
Sperre nutzt die nächste Nachricht wieder die erste freie Stufe.

Ein Limit-Fehler oder Ausfall kann auch bei ausgeschalteter Automatik sperren.
Welche Sperre was aufhebt, erklärt
[Der Motor hat gewechselt](troubleshooting.md#der-motor-hat-gewechselt).
Eigene Messwerte und Übungen gehen über `bun run limits set`; `bun run limits
show` zeigt den Stand als JSON. Format und Grenzen stehen unter
[Eigene Messwerte für Limits](#eigene-messwerte-für-limits).

**Bezahlte Stufen:** OpenCode mit einem OpenRouter-Modell zahlt je Verbrauch
und kann als letzte Ersatzstufe automatisch einspringen. Die Bremse ist das
Limit am Schlüssel bei OpenRouter; tybo führt dafür kein eigenes Budget.
Die WebUI zeigt Guthaben und Schlüssellimit, diese Anzeige sperrt aber kein
Fenster. Den Schlüssel beim Anbieter begrenzen, bevor diese Stufe verwendet
wird. Die direkte Anthropic API (`api`) bezahlt ebenfalls je Verbrauch und
ist nur von Hand wählbar, nie als Ersatzstufe.

**Meldungen und Geltung:** Ein Wechsel der allgemeinen Reihenfolge wird im
Direktchat und in der WebUI gemeldet; im betroffenen Gespräch steht vor der
ersten Antwort ein eigener Hinweis. Der nächste Turn übernimmt den Verlauf,
eine laufende Antwort wird nicht umgeschaltet. Nach einem gescheiterten
Versuch kann im selben Turn die nächste freie Stufe einspringen, höchstens
drei Stufenversuche. `/stop` und ein Zeitlimit lösen keinen Wechsel aus.
Die Automatik gilt für Chat, Knopf-Fortsetzungen und `/goal`, nicht für Jobs,
Routinen, Check-in, Morgenbriefing oder Sprachagenten. Wortlaute und Grenzen
stehen unter [Der Motor hat gewechselt](troubleshooting.md#der-motor-hat-gewechselt).
Ein vollständiger Prüflauf mit festen Aufgaben steht in der
[Motorwechsel-Abnahme](webui/motorwechsel-abnahme.md).

## Eigene Messwerte für Limits

**Was es bringt:** Ein eigenes Skript kann den Stand eines Abo-Limits an tybo
übergeben. Dieselben Werte lassen sich für eine Übung zum Motorwechsel nutzen.
tybo selbst liest und erneuert keine Anmelde-Token eines Motors und ruft keine
undokumentierten Endpunkte auf (Entscheidung 0027, Punkt E2:
[`docs/webui/decisions/0027-motorwechsel.md`](webui/decisions/0027-motorwechsel.md)).
Das Abholen bei einer weiteren Quelle bleibt Sache deines Skripts.

**Was du brauchst:** Bun und den Projektordner der verwendeten Installation.
Der Befehl startet keinen Bot und braucht weder Zugangsdaten noch eine `.env`.
Er liest die Automatik aus `config/settings.json`. Damit ein hoher Wert eine
neue Sperre erzeugt, müssen die Automatik und mindestens eine Ersatzstufe
eingestellt sein. Ohne laufenden Bot werden Messwerte und Sperren trotzdem
gespeichert; Wechselmeldungen übernimmt der Bot nach seinem nächsten Start.

**Ein Wert mit Schaltern:** Im Projektordner ausführen, die Reset-Zeit durch
die tatsächliche Zeit deiner Quelle ersetzen:

```sh
bun run limits set --engine claude --window weekly_scoped:fable --percent 96 --resets-at 2026-11-22T15:00:00Z
```

Ohne `--measured-at` gilt die Zeit des Aufrufs. Mit
`--measured-at 2026-11-17T08:05:00Z` wird die Zeit der Messung ausdrücklich
mitgegeben. `--resets-at` ist freiwillig; unbekannte Zeiten weglassen.
Dezimalzahlen nutzen einen Punkt, etwa `62.5`, keine Prozentzeichen, Exponenten
oder Hexadezimalzahlen.

**Mehrere Werte als JSON:** Ein Objekt für einen Motor, hier zwei Fenster.
Die Beispielzeiten durch die tatsächlichen Mess- und Reset-Zeiten ersetzen:

```sh
bun run limits set --stdin <<'JSON'
{
  "engine": "claude",
  "windows": [
    { "id": "weekly_all", "percent": 62, "resetsAt": "2026-11-22T15:00:00Z", "measuredAt": "2026-11-17T08:05:00Z" },
    { "id": "weekly_scoped:fable", "percent": 96, "resetsAt": "2026-11-22T15:00:00Z", "measuredAt": "2026-11-17T08:05:00Z" }
  ]
}
JSON
```

Ein fremdes Skript muss denselben Projektordner verwenden wie der Bot. Zum
Beispiel aus einem beliebigen Arbeitsordner:

```sh
bun run --cwd /pfad/zu/tybo limits set --stdin < messwerte.json
```

Die Standardpfade hängen am Arbeitsordner. `data/engine-usage.json` nie von
Hand ändern: Der Befehl prüft zuerst die ganze Eingabe und schreibt dann mit
der gemeinsamen Dateisperre atomar, immer mit Quelle `extern`.

**Format und Regeln:**

- `engine`: nur `claude` oder `codex`, keine Fenster für OpenCode oder API.
- Claude: `weekly_all`, `session`, `weekly_scoped:<familie>`. Die Familie
  besteht aus 1 bis 40 Kleinbuchstaben, Ziffern oder Bindestrichen. Bekannte
  Familien sind `fable`, `opus`, `sonnet`, `haiku`. Eine beliebige andere
  Familie wie `xyz` kann eine Sperre erzeugen, trifft aber keine Stufe.
- Codex: `weekly_all`, `session`, `window_<minuten>` mit ganzen Minuten von
  1 bis 525600, ohne führende Null. Für 10080 Minuten `weekly_all`, für
  300 Minuten `session` verwenden; `window_10080` und `window_300` werden
  abgelehnt. Sonst entstünden doppelte Fenster, die eine eigene Messung des
  Bots nicht wieder aufheben würde.
- `percent`: eine Zahl von 0 bis 100, in JSON kein Text wie `"96"`.
- Zeiten sind ISO-Zeiten mit `Z` (UTC) oder Offset, etwa `+01:00`.
  `measuredAt` ist in JSON Pflicht und darf höchstens **60 Sekunden** in der
  Zukunft liegen, entsprechend der Ablage der Messwerte. `resetsAt` ist
  freiwillig; kein `null` als Ersatz für eine unbekannte Zeit.
- Pro Aufruf 1 bis 10 Fenster, keine doppelte Kennung. Unbekannte Felder
  (auch `source`) und Schalter werden abgelehnt. `--stdin` lässt sich nicht
  mit anderen Schaltern kombinieren. Ein Prüfungsfehler nennt das Feld,
  endet mit Exit-Code 1 und ändert keine Datei.
- Die jüngste Messung je Motor und Fenster gewinnt, unabhängig von der
  Quelle. Eine ältere Lieferung ersetzt nichts; bei gleicher Messzeit darf
  der Wert ersetzen. Eine spätere eigene Messung des Bots ersetzt `extern`.
  Eine bereits erreichte Reset-Zeit wird vor dem Schreiben aussortiert;
  der bisher gespeicherte Wert dieses Fensters bleibt unverändert.

**Wirkung und Ausgabe:** Je Fenster erscheint `claude weekly_all: 62 %,
übernommen` oder entsprechend `nicht übernommen, es gibt eine jüngere Messung`
bzw. `nicht übernommen, die Reset-Zeit ist vorbei`. Diese Fälle enden mit
Exit-Code 0. Kann der Messwert nicht gespeichert werden, erscheint
`nicht gespeichert`, Exit-Code 1; der Sperrzustand wird dann nicht angefasst.

Nach dem Speichern gilt dieselbe Sperrregel wie im Bot. Ab der Schwelle
(Standard 95 %) entsteht eine Sperre bis zum Reset. Ohne Reset endet sie
60 Minuten nach der **Messzeit**, nicht nach dem Aufruf; eine schon 90 Minuten
alte Messung wird gespeichert, sperrt aber nicht. Die Ausgabe ergänzt bei
einer Änderung `Sperre bis <Zeit>`, ohne Reset mit dem Zusatz
`(60 Minuten ab der Messung, Reset-Zeit unbekannt)`. Zeiten erscheinen in der
Zeitzone des Systems als `So, 22.11., 16:00`, unabhängig von `USER_TIMEZONE`
in der `.env`.

Ein Wert unter der Rückkehrschwelle (Standard 80 %) hebt die Fenstersperre
auf, wenn seine Messzeit echt nach dem Beginn der Sperre liegt. Dann steht
`Sperre aufgehoben` darunter. Das Aufheben geht auch bei ausgeschalteter
Automatik. Messungen vor der letzten Freigabe durch `/motor pruefen` erzeugen
keine neue Sperre; dann steht nur `übernommen` da.

Der Befehl ändert nur die Sperren, keine Fehlerzähler, Freigaben oder Meldungen.
Ist die Zustandsdatei nicht schreibbar, versucht er es noch zweimal mit je
einer Sekunde Abstand. Scheitern alle drei Versuche, bleibt Exit-Code 0:
`Messwert gespeichert. Der Sperrzustand ließ sich gerade nicht schreiben; der
Bot wertet den Messwert mit der nächsten Nachricht aus.` Der Befehl meldet
selbst nichts an Telegram oder die WebUI. Der laufende Bot bemerkt geänderte
Sperren selbst, ohne Nachricht im Chat und ohne offenen Browser.

**Prüfen und Übung beenden:** `bun run limits show` zeigt `readUsage()` als
JSON, je Motor mit Quelle und Messzeit. Es schreibt nichts; bereits
abgelaufene Fenster stehen als `expired` ohne Prozentwert darin. Vor der
Übung `id`, `percent` und `resetsAt` der betroffenen Fenster festhalten. Zum
Beenden denselben `set`-Aufruf mit dem echten Stand und dessen Reset-Zeit
ausführen, ohne `--measured-at`: So ist der Wert jünger als die Sperre. Ohne
bekannten Stand oder bei inzwischen vergangener Reset-Zeit `--percent 0`
mit einer künftigen Reset-Zeit verwenden. Ein abgelaufener Reset wird
abgelehnt und lässt den Übungswert stehen. Liegt der echte Stand bei oder
über der Rückkehrschwelle, bleibt die Sperre zu Recht bis zum Reset oder
einer echten niedrigeren Messung. `/motor pruefen` bewertet neu; Claude Code
misst dabei frisch, Codex erst nach seinem nächsten Chat-Lauf. Bis dahin
zeigt `/motor` den wieder eingelieferten Stand, `limits show` dessen Quelle
`extern` und die WebUI „eingeliefert“.

Übungen zügig durchführen: Während einer Claude-Sperre prüft der Bot alle
fünf Minuten, ob sein letzter Bericht mindestens 30 Minuten alt ist; nach
einem Claude-Turn misst er bei einem mindestens zehn Minuten alten Bericht
nach. Auch eine Antwort der Ersatzstufe Opus kann das auslösen. Ein echter
niedriger Wert kann die Übungssperre daher schon vorher aufheben und „wieder
frei“ melden. Dann liefert der abschließende Aufruf nur `übernommen` statt
zusätzlich `Sperre aufgehoben`; beide Abläufe sind möglich.

## Check-in und Morgenbriefing

**Was es bringt:** tybo meldet sich von selbst: morgens mit einem Briefing
(Ziele, Termine, Mails, Aufgaben, News aus den Datenquellen) und tagsüber mit
kurzen Check-ins, wenn es etwas zu sagen gibt.

**Was du brauchst:** macOS (launchd) oder Linux (systemd-Timer, ohne systemd
cron). Unter Windows gibt es keine Dienste dafür. Die Timer laufen in der
Zeitzone aus `USER_TIMEZONE`, auch wenn der Server auf UTC steht.

**Einrichten:** `tybo dienste` richtet alle Dienste ein, einzeln mit
`tybo dienste smart-checkin` bzw. `tybo dienste morning-briefing`.
Standard: Check-ins stündlich von 10:30 bis 18:30 mit mindestens 90 Minuten
Abstand, das Briefing einmal am Tag zwischen 9 und 12 Uhr, Ruhezeit 21 bis
8 Uhr. Ändern lässt sich das im Block `proactive` von `config/settings.json`.
Nach einer Änderung der Zeiten `tybo dienste` noch einmal ausführen.

**Prüfen:** `bun run briefing --dry-run` bzw. `bun run checkin --dry-run`
zeigen, was gerade käme, ohne etwas zu senden. `/routinen` zeigt die Dienste
mit ihren letzten Läufen.

## Nachtcheck

**Was es bringt:** Jede Nacht um 03:30 ein kurzer Bericht mit ✅, ⚠️ und ❌:
ob der Bot läuft und antwortet, ob der eingestellte Motor (Claude Code,
Codex, OpenCode oder die Anthropic API) installiert und angemeldet ist,
Telegram, Datenbank, Ersatzmodelle, Plattenplatz und ob Check-in, Briefing
und Wartung pünktlich liefen. Gerade auf einem Server ohne Bildschirm
erfährst du so von selbst, dass der Bot steht.

**Was du brauchst:** macOS (launchd) oder Linux. Unter Linux läuft er als
systemd-Timer in der Zeitzone aus `USER_TIMEZONE`, auf Rechnern ohne systemd
unter PM2 (Zeitplan in der Zeitzone des Systems), ohne PM2 als cron-Zeile.

**Einrichten:** `tybo dienste health-check` (in `tybo dienste` ohne Angabe
enthalten). Unter PM2 läuft der erste Bericht sofort beim Einrichten. Wer
den Nachtcheck vorher unter PM2 hatte und jetzt systemd nutzt: `tybo
dienste` entfernt den PM2-Eintrag `tybo-health-check` und sichert die
PM2-Liste mit `pm2 save --force`, auch wenn sie danach leer ist. Läuft PM2
gerade nicht, streicht `tybo dienste` den Eintrag aus der gesicherten Liste
(`dump.pm2`), damit er beim Hochfahren nicht zurückkommt. Lässt sich die
PM2-Liste oder ihre Sicherung nicht lesen, der Eintrag nicht entfernen oder
die Liste nicht sichern, bleibt es beim Zeitplan unter PM2, und `tybo
dienste` meldet einen Fehler; nie laufen beide. Lassen sich alte
cron-Zeilen nicht entfernen, wird der Timer wieder abgeschaltet und es gilt
die cron-Zeile. Ohne systemd und ohne antwortende PM2-CLI entsteht keine
cron-Zeile, solange PM2 den Nachtcheck führt oder gesichert hat oder das
unklar ist.

**Wie er den Bot prüft:** Die Zeile „Bot-Prozess“ fragt launchd, systemd
(`tybo-telegram-relay.service`) oder PM2 (`tybo-telegram-relay`), ohne PM2
zu starten. Die Zeile „Bot antwortet“ fragt den Health-Port des Bots
(`http://127.0.0.1:<HEALTH_PORT>/health`, Standard 3000). Steht der Bot,
stehen beide als ❌ im Bericht. Der Bericht kommt wie jede Nacht genau
einmal, über Telegram, falls eingerichtet, und in der WebUI. Ohne Telegram
liegt er nur in der WebUI, und die steht mit dem Bot: Du siehst ihn erst,
wenn der Bot wieder läuft.

**Prüfen:** `bun run health -- --no-send` zeigt den Bericht, ohne ihn zu
senden; `--no-model` lässt den kurzen Probeaufruf an Claude Haiku weg.
`/routinen health-check` zeigt die letzten Läufe.

## Wartung

**Was es bringt:** tybo räumt einmal die Woche Posten weg, die sich
gefahrlos neu erzeugen lassen: Test-Simulatoren von Xcode, Download- und
Build-Caches, zu große eigene Logs. Danach kommt eine Meldung, wie viel
Platz frei wurde.

**Was du brauchst:** macOS (launchd) oder Linux (systemd-Timer, ohne systemd
cron). Unter Linux fallen die Xcode-Posten weg.

**Einrichten:** `tybo dienste wartung` (sonntags 03:15; `tybo dienste` ohne
Angabe lässt sie weg). Welche Simulatoren als Test-Geräte gelten, legst du
in `config/wartung.json` fest (Vorlage `config/wartung.example.json`); ohne
Muster bleiben alle Geräte bis auf die nicht verfügbaren.

**Dienste nach Updates:** Nennt `config/wartung.json` unter `dienste` einen
Dauerdienst (die Vorlage: den Cloudflare-Tunnel), startet die Wartung ihn
neu, wenn er älter läuft als installiert, ebenso `bun run updates --apply`.
Ohne Eintrag wird kein Dienst angefasst
([mehr](routinen.md#dienste-nach-updates-neu-starten)).

**Prüfen:** `tybo wartung --dry-run` zeigt, was gelöscht bzw. neu gestartet
würde, mit Größen, ohne etwas zu löschen, zu starten oder zu senden. Was
genau angefasst wird und was nie:
[Routinen, Abschnitt Wartung](routinen.md#wartung).

## Datenquellen

**Was es bringt:** Mehr Inhalt fürs Briefing. Ziele sind immer dabei,
Kalender und Gmail richtet der Schritt `google` ein. Hier geht es um die
übrigen Quellen.

**Was du brauchst und wie du es einrichtest:**

- **News:** Standard ist xAI mit `XAI_API_KEY` (Schlüssel von
  [x.ai](https://x.ai)). Mit `NEWS_PROVIDER=openrouter` kommen die News über
  OpenRouter mit `OPENROUTER_API_KEY`. Das Modell legt `NEWS_MODEL` fest.
  Es erscheinen nur Meldungen mit Quelle.
- **Notion:** eine Integration unter
  [notion.so/my-integrations](https://www.notion.so/my-integrations) anlegen,
  die Aufgaben-Datenbank mit ihr teilen, dann `NOTION_TOKEN` und
  `NOTION_DATABASE_ID` setzen. Die Datenbank braucht eine Datumseigenschaft
  „Due“ und eine Status-Eigenschaft „Status“ mit dem Wert „Done“. Das
  Briefing zeigt fällige und überfällige Aufgaben.
- **Eigene Quelle:** `src/lib/sources/example.ts` kopieren, etwa nach
  `src/lib/sources/wetter.ts`, Kennung, Zugangsdaten und Abruf anpassen und
  die Quelle in `SOURCES` in `src/lib/sources/list.ts` aufnehmen. Die Regeln
  stehen oben in der Vorlage.

Jede Quelle schaltet sich ein, sobald ihre Variablen gesetzt sind.

**Prüfen:** `bun run briefing --dry-run`. Scheitert eine eingerichtete
Quelle, steht an ihrer Stelle „Konnte nicht abgerufen werden“, und der Lauf
endet mit Exit-Code 1; eine nicht eingerichtete Quelle fehlt still.

## Sprachnachrichten und Cloud-Stimmen

**Was es bringt:** Sprachnachrichten in Telegram werden in Text umgewandelt,
und tybo kann mit Stimme antworten. Im Browser hören und sprechen
Sprechmodus und Telefonhörer.

**Was du brauchst:** Den lokalen Weg (Parakeet zum Hören, Pocket TTS oder
Piper zum Vorlesen) richtet `tybo setup sprache` ein. Für Anbieter in der
Cloud brauchst du deren Schlüssel: Gemini (`GEMINI_API_KEY`, hört und
spricht) oder ElevenLabs (`ELEVENLABS_API_KEY`, als Stimme dazu
`ELEVENLABS_VOICE_ID`). Text bzw. Aufnahme gehen dann an den Anbieter.

**Einrichten:** Schlüssel in die `.env`. Die Wahl treffen `SPEECH_STT` und
`SPEECH_TTS` (Standard `auto`) oder die WebUI unter Einstellungen, Reiter
„Sprechen“; die WebUI hat Vorrang. Sprachantworten in Telegram kommen nur von
Anbietern auf dem Server (Qwen3-TTS auf dem Mac, ElevenLabs, Gemini), nicht
von der Stimme des Browsers. Alles Weitere: [sprechen.md](sprechen.md).

**Prüfen:** In Telegram eine Sprachnachricht schicken; tybo antwortet auf
ihren Inhalt. `tybo pruefen` meldet den Stand der Sprache.

## Anrufe

**Was es bringt:** tybo ruft dich übers Telefonnetz an, auf `/anruf [anlass]`
oder über den Knopf „Anrufen“ unter Check-in und Briefing. Nach dem Gespräch
kommt eine Zusammenfassung in den Chat.

**Was du brauchst:** ein ElevenLabs-Konto mit Agent und einer Telefonnummer
(etwa über Twilio), dazu `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`,
`ELEVENLABS_PHONE_NUMBER_ID` und deine Nummer in `USER_PHONE_NUMBER`.

**Einrichten:** Die vier Werte in die `.env`. Damit der Agent den Anlass
kennt, braucht er unter „Custom LLM“ zwei Request-Header; beschrieben in
[sprechen.md](sprechen.md#anruf-von-tybo-elevenlabs-und-twilio). Liegt die
Nummer an einem SIP-Trunk (etwa an der eigenen Vermittlung für einen
easybell-Anschluss), dazu `ELEVENLABS_PHONE_PROVIDER=sip_trunk`; siehe
[sprechen.md](sprechen.md#anrufannahme-über-eigene-vermittlung).

**Prüfen:** `/anruf Test` schicken. Fehlt eine Variable, nennt tybo sie und
ruft nicht an.

## MCP-Server

**Was es bringt:** MCP-Server geben tybo Werkzeuge, etwa für Mail, Kalender
oder Aufgaben. Claude Code nutzt seine eingerichteten Server selbst. Codex
bekommt die übertragbaren Server von tybo je Lauf mit; für die Ersatzmodelle
(OpenRouter, Ollama) startet tybo die Server selbst.

### Codex

In der Rechte-Stufe **„Voller Zugriff“** bekommt jeder Codex-Lauf die Server
als Aufrufparameter. Das gilt für neue und fortgesetzte Chat-Antworten, für
das Destillat beim Session-Ende, `/routine` und fortgesetzte Aufgaben über
diesen Motor. Jeder dieser Aufrufe startet die Server neu. Hintergrund-Jobs
bekommen sie nur mit `--engine codex --full-access`; die Rechte-Stufe des
Chats gilt für Jobs nicht.

Die Quellen haben diese Rangfolge, bei gleichem Namen gewinnt die frühere:

1. `config/mcp-servers.json` im tybo-Projekt (Vorlage
   `config/mcp-servers.example.json`).
2. Die Datei aus `MCP_CONFIG_PATH`.
3. Der Eintrag des Laufordners in `~/.claude.json`.
4. `.mcp.json` im Laufordner, sofern in Claude Code zugestimmt wurde.
5. Die globalen Server in `~/.claude.json`.

Lokale Server brauchen `command` und `args`, HTTP-Server `type: "http"` und
`url`. Platzhalter wie `${NAME}` in `env` und HTTP-Kopfzeilen werden aus den
Zugangsdaten aufgelöst. Von Claude abgeschaltete Server bleiben aus. Eigene
Server in Codex haben bei gleichem Namen Vorrang und bleiben so, wie Codex
sie lädt. tybo schreibt keine Codex-Konfiguration und ruft weder
`codex mcp add` noch `codex mcp login` auf.

Geheimnisse gehen nur über die Umgebung des Codex-Prozesses (`env_vars`,
`bearer_token_env_var`, `env_http_headers`), nie über Befehlsargumente.
**Damit kann auch die Shell des Modells diese Werte lesen.** In „Voller
Zugriff“ sind alle Werkzeuge eines mitgegebenen Servers ohne Rückfrage
freigegeben, auch schreibende. Die Rückfrage mit Knöpfen unten gilt nur für
die Ersatzmodelle; bei Claude Code und Codex entscheidet der Motor.

In `config/settings.json` lässt sich die Übergabe steuern:

```json
{
  "engine": {
    "codex": {
      "mcp": { "enabled": true, "skip": [], "public": [] }
    }
  }
}
```

- `enabled`: Standard an; `false` lässt die Übergabe durch tybo weg.
- `skip`: Servernamen, die tybo nicht mitgeben soll, etwa `["firecrawl"]`.
- `public`: HTTP-Server aus Claude-Quellen, die ohne Anmeldung erreichbar
  sind. Ohne diesen Eintrag überspringt tybo solche Server ohne Kopfzeilen,
  weil Claude dafür über den Browser angemeldet sein könnte. Diese Anmeldung
  lässt sich nicht übertragen. Nur nachweislich offene Server eintragen.

In „Projekt schreiben“ und „Nur lesen“ gibt tybo keine Server mit: MCP
läuft außerhalb der Codex-Sandbox. Eingeschränkte Codex-Jobs schalten auch
eigene Codex-Server ab. Pipeline-Worker bekommen keine Server von tybo,
weil auch der Claude-Worker nur Datei- und Shell-Werkzeuge hat. SSE-Server,
Claude-Plugins und Konnektoren werden nicht übertragen. Weitere Gründe:
[Störungen](troubleshooting.md#mcp-werkzeuge-fehlen-in-einer-antwort).

Dateien werden vor jedem Lauf neu gelesen, ohne Zwischenspeicher der
MCP-Leser. Änderungen wirken ab der nächsten Antwort, auch beim Fortsetzen,
ohne Neustart. Die Logzeile `[Codex] MCP-Server: …` nennt beim ersten Lauf
und bei Änderungen nur Namen und Gründe. Scheitert die Planung oder die
Prüfung der Umgebung, läuft Codex ohne die Server von tybo weiter, mit einer
festen Fehlermeldung im Log. Eigene Codex-Server bleiben davon unberührt.

Diagnosen und Fehlermeldungen maskieren zusätzlich die übergebenen Werte,
auch solche, die nur in einer MCP-Datei stehen. Reiner Leerraum entfällt;
kurze Werte werden auch mitten in Wörtern maskiert und können die Lesbarkeit
mindern. Die Modellantwort im Chat bleibt wie bei den anderen Motoren
unverändert. Für Job-Berichte gelten die
[Maskierung und ihre Grenzen](hintergrund-jobs.md#geheimnisse).

### Ersatzmodelle

**Einrichten:** tybo nimmt drei Quellen, bei gleichem Namen gilt die frühere:
`config/mcp-servers.json` im Projekt (Vorlage
`config/mcp-servers.example.json`, lokale Server mit `command` und `args`,
entfernte mit `"type": "http"`), dann die Datei aus `MCP_CONFIG_PATH`, dann
`~/.claude.json` (lokale Server nur, wenn sie mit Bun laufen). Platzhalter
wie `${NAME}` ersetzt tybo aus der `.env`. Schreibende Werkzeuge fragen vor
jedem Aufruf mit Knöpfen nach; rein lesende dürfen in `MCP_READ_ONLY_TOOLS`
als `server/werkzeug` stehen. Die Server liest der Bot nur beim Start ein:
Nach einer Änderung an `config/mcp-servers.json` (oder der Datei aus
`MCP_CONFIG_PATH`) braucht er einen Neustart.

**Prüfen:** `bun run test:tools` startet die Server in einem eigenen Prozess
und meldet, welche Werkzeuge ein Ersatzmodell bekommt. Den laufenden Bot
ändert der Test nicht; dort greift die neue Liste erst nach dem Neustart.
Der Befehl prüft nicht das Angebot eines Codex-Laufs.

## Skills für Codex

**Was es bringt:** Codex kann dieselben Skill-Anleitungen wie Claude Code
lesen, etwa einen erfundenen Skill `tagesgruss`. tybo legt dafür symbolische
Links unter `<projekt>/.agents/skills/` an, keine Kopien. Du pflegst weiterhin
nur die ursprüngliche `SKILL.md`; tybo schreibt weder ihren Inhalt noch die
Konfiguration von Claude Code oder Codex um.

**Welche Skills dazugehören:** unmittelbare Ordner mit eigener `SKILL.md`
unter `<projekt>/.claude/skills/` und `~/.claude/skills/`, auch wenn ein
Quellordner selbst ein Link ist. Bei gleichem Ordnernamen geht das Projekt vor,
ohne Unterscheidung der Großschreibung. Ordner wie `synced` ohne eigene
`SKILL.md` werden übergangen; tybo sucht darin nicht weiter.

Der Ordnername muss aus 1 bis 64 Buchstaben (`A-Z`, `a-z`), Ziffern,
Punkten, Unterstrichen oder Bindestrichen bestehen und darf nicht mit einem
Punkt beginnen. Der YAML-Kopf zwischen den ersten beiden `---`-Zeilen muss
innerhalb der ersten 8 KiB liegen und eine nicht leere `description`
enthalten. Mehrzeilige Beschreibungen, BOM und Windows-Zeilenenden sind
erlaubt. `name` darf fehlen; Codex nimmt dann den Ordnernamen. Ist `name`
vorhanden, zeigt Codex diesen Namen, auch wenn der Ordner anders heißt.
Die Claude-Felder `allowed-tools`, `user-invocable` und `argument-hint`
verhindern das Laden nicht (geprüft mit Codex CLI 0.169.0). Das macht
Claude-spezifische Werkzeuge innerhalb der Anleitung noch nicht verfügbar.

**Eigene Einträge gehen vor:** Ein vorhandener Ordner oder Link unter
`.agents/skills/` gehört dir, auch ein von Hand angelegter Link auf dieselbe
Quelle. tybo ersetzt ihn nicht und vermerkt ihn nicht als eigenen Link.
Im Log steht einmal je Name „im Projekt selbst vorhanden“. Skills, die du
in `~/.agents/skills/`, `<projekt>/.codex/skills/` oder im Ordner `skills/`
unter `CODEX_HOME` (sonst `~/.codex`) eingerichtet hast, gehen ebenfalls vor:
tybo liest dort nur die Köpfe und übergeht gleichnamige Quell-Skills. Der
Abgleich nutzt dafür den Namen im Kopf, sonst den Ordnernamen. Auch unter
den Quellen verlinkt tybo denselben Kopf-Namen nur einmal. Solche Konflikte
zählen wie unzulässige Ordnernamen zum Rückgabegrund `name`; fehlende oder
unlesbare Köpfe zu `head`, fehlgeschlagenes Anlegen zu `error`.

**Ablage und Abschalten:** `data/codex-skill-links.json` hält Ziel und
Anlegezeit der Links von tybo fest. Nur wenn der Link noch genau auf das
vermerkte Ziel zeigt, darf tybo ihn ändern oder entfernen. Änderst du sein
Ziel oder seinen Namen, bleibt er stehen und nur der Vermerk entfällt.
Löschst du einen eigenen Link von tybo, legt der nächste Abgleich ihn wieder
an, solange die Quelle vorhanden ist. Verschwindet die Quelle, räumt tybo
seinen Link auf. Die Ordner `.agents/skills/` bleiben stehen und sind in Git
ausgenommen. Ist `.agents` oder `.agents/skills` selbst ein Link oder eine
Datei, bricht der Abgleich ohne Änderungen mit einer Logzeile ab.

Geht die Ablage verloren oder wird sie unlesbar, gelten **alle vorhandenen
Links als fremd**. Sie funktionieren weiter, werden aber auch beim
Abschalten nicht mehr von tybo entfernt. tybo übernimmt sie später nicht
automatisch wieder. Ohne Änderungen schreibt der Abgleich nichts.

Standardmäßig ist die Funktion an. Zum Abschalten in der bestehenden
`config/settings.json` unter `engine.codex` das Feld `"skills": false`
ergänzen. Beim nächsten Bot-Start oder einer neuen Codex-Session entfernt
tybo seine eigenen Links und leert die Ablage; deine Einträge bleiben.
`"skills": true` oder das Entfernen des Felds schaltet sie wieder ein.
Die WebUI bietet dafür keinen Schalter; eine Modelländerung dort erhält
die Einstellung.

**Wann es wirkt und wie du prüfst:** Beim Bot-Start wird nur mit
installiertem Codex abgeglichen, unabhängig von dessen Anmeldung. Vor jeder
neuen Codex-Chat-Session folgt ein weiterer Abgleich, immer für tybos
Projektordner. Im Gespräch `/motor codex`, dann `/new` und das Stichwort
deines Skills senden. Codex soll nach seiner Anleitung antworten.

Die Links sind für Codex-Läufe mit diesem Projektordner als Arbeitsordner
sichtbar: Chat, Hintergrund-Jobs mit `--engine codex --full-access` und
ein dort von Hand gestartetes `codex`. Jobs und von Hand gestartete Läufe
gleichen die Links nicht selbst ab; sie sehen den Stand vom letzten
Bot-Start oder neuen Codex-Chat. Eingeschränkte Codex-Jobs können keine
Dateien lesen und nutzen diese Skills deshalb nicht. Pipeline-Worker
arbeiten in einem anderen Ordner und sehen die Links nicht.

Skills aus Claude-Plugins bleiben ausgenommen. Ein abweichendes
`CLAUDE_CONFIG_DIR` wird nicht berücksichtigt; die Quellen sind die oben
genannten `.claude/skills/`-Ordner. Für OpenCode, das die Skills selbst
findet, und den Motor `api` ändert sich nichts.

## Was Codex an Kontext bekommt

Codex liest die `CLAUDE.md` des Projekts über seine Projektanweisungen
(`project_doc_fallback_filenames`, höchstens 65.536 Bytes). Im Chat bekommt
es außerdem denselben Kontext von tybo wie die anderen Motoren: Profil,
festen Kern, Fakten und Ziele, Wissensbasis, Verlauf und Suchtreffer.
Hintergrund-Jobs bekommen ihren Auftrag mit Berichtsanweisung und Job-Regeln;
das Chat-Gedächtnis wird dort nicht zusätzlich geladen.

Bei einer **neuen Codex-Chat-Session** gibt tybo auch die Übersicht der
Projekt-Notizen von Claude Code mit. Sie steht als `CLAUDE CODE NOTES` nach
der Wissensbasis und vor dem Verlauf, auch vor einem Übergabe-Verlauf beim
Motorwechsel. Das gilt in jeder Rechte-Stufe. Folgenachrichten tragen sie
nicht erneut; nach `/new`, einem Motorwechsel oder einem Neuversuch ohne
Session wird sie wieder gelesen. Ohne `SESSION_MODE=resume` ist jede
Nachricht eine neue Session und bekommt bis zu 25.000 Zeichen Notizen.

**Codex-Jobs mit `--full-access`** erhalten denselben Abschnitt hinter dem
Auftrag, vor der Trennlinie zur Berichtsanweisung. Eingeschränkte Codex-Jobs
und Pipeline-Worker bekommen ihn nicht. Claude Code lädt seine Notizen selbst;
für Claude Code, OpenCode, `api` und die Ersatzmodelle fügt tybo keinen
Abschnitt ein.

**Quelle und Grenzen:** Gelesen wird nur
`~/.claude/projects/<kennung>/memory/MEMORY.md`. Die Kennung entsteht aus dem
absoluten Projektpfad: Jedes Zeichen außer `A-Z`, `a-z` und `0-9` wird zu `-`,
auch Punkte, Unterstriche, Leerzeichen und Umlaute. Aus `/projekte/demo.app`
wird `-projekte-demo-app`. Bei Jobs zählen der Projektordner des Jobs und
das `HOME` seiner Umgebung. Fehlende, leere oder unlesbare Übersichten
ergeben keinen Abschnitt; bei einem Lesefehler steht nur der Fehlercode im Log.

Die Übersicht wird zuerst maskiert, dann auf 200 Zeilen und 25.000 Zeichen
begrenzt. Bei Kürzung folgt `(truncated)`. Möglichst bleiben ganze Zeilen
erhalten; eine einzelne überlange Zeile wird am Zeichenlimit abgeschnitten.
Als Leseschutz werden höchstens 1 MiB Dateidaten gelesen. Maskiert werden
Werte ab acht Zeichen aus der `.env` und geheim benannten Umgebungsvariablen,
bei Jobs auch die Werte des MCP-Plans. Kurze Werte wie `true` bleiben im
Notizkontext stehen. Auch harmlose lange Werte wie Modellnamen, URLs oder
Pfade werden zu `[verborgen]`, gelegentlich mitten in einem Dateiverweis.
Die Zeile mit dem Notizenordner bleibt unmaskiert.

Der Abschnitt kennzeichnet die Notizen als möglicherweise veralteten
Hintergrund, verlangt die Prüfung genannter Dateien, Befehle und Einstellungen
und untersagt das Anlegen, Ändern und Löschen im Notizenordner. Einzelne
Notizdateien stehen nicht im Prompt. Codex kann sie bei Bedarf lesen; lassen
seine Rechte das nicht zu, soll es mit der Übersicht weiterarbeiten.
Die Übersicht geht damit an den Anbieter von Codex. Sie wird über stdin
übergeben und steht nicht in der Befehlszeile. Die CLI kann sie in ihrer
Ausgabe wiederholen, siehe [Job-Logs](hintergrund-jobs.md#geheimnisse).
tybo schreibt keine Notizen und schaltet Codex-eigene Memories nicht ein.

**Abschalten:** In der bestehenden `config/settings.json` unter
`engine.codex` das Feld `"claudeNotes": false` ergänzen. `true` oder das
Entfernen des Felds schaltet die Funktion wieder ein; Standard ist an.
Die WebUI hat dafür keinen Schalter. Die Änderung wirkt ohne Neustart beim
nächsten vollen Prompt oder Job. Bereits geladene Notizen bleiben im Kontext
einer laufenden Session; zum Prüfen nach der Änderung `/new` senden.

tybo löst Git-Worktrees nicht auf den Hauptcheckout auf. Liegen die Notizen
dort unter dessen Kennung, findet der Worktree keinen passenden Ordner.
Ein abweichendes `CLAUDE_CONFIG_DIR` und umgelenkte Notizenordner werden
ebenfalls nicht berücksichtigt. Die Abnahme erfolgt deshalb im laufenden
Hauptcheckout, nicht im Arbeitsordner der Pipeline.

## Werkzeuge im Ersatzmotor

`/motor` zeigt unter den Motoren eine Kurzfassung für jeden bereiten
Ersatzmotor mit Lücken. `/motor werkzeuge` zeigt die Namen der MCP-Server
und Skills, jeweils „von tybo“ oder „im Motor“, und den Stand der Notizen.
Danach folgen fehlende Werkzeuge und Hinweise mit ihrem Grund, die festen
Unterschiede und die Zahl der Plugins von Claude Code. Claude Code ist der
Maßstab. Beide Befehle gehen in Telegram, WebUI und Terminal auch während
einer Antwort und ändern nichts. Bei langen Listen werden Skills nur noch
gezählt; sehr große Ausgaben werden zusätzlich sichtbar gekürzt.

Codex bekommt von tybo MCP-Server als Parameter des jeweiligen Laufs,
Skills über Links unter `.agents/skills/` und die Projektnotizen von Claude
Code als Kontext. MCP und Notizen werden im Chat und in Hintergrund-Jobs mit
`--full-access` mitgegeben. MCP braucht dabei die Rechte-Stufe „Voller
Zugriff“, denn die Server laufen außerhalb der Sandbox. Eingeschränkte
Jobs behalten ihre Werkzeuggrenzen und bekommen keine MCP-Server;
Pipeline-Worker bekommen ebenfalls keine MCP-Server von tybo. Eigene
Einträge in Codex haben Vorrang. Die Einzelheiten stehen unter
[MCP-Server](#mcp-server), [Skills für Codex](#skills-für-codex) und
[Kontext für Codex](#was-codex-an-kontext-bekommt).

`tybo pruefen` zeigt im Abschnitt „Motor“ dieselbe Kurzfassung unter
„Werkzeuge Codex“ und für andere bereite Ersatzmotoren. Bekannte Lücken
bleiben ein bestandener Hinweis. Zusätzlich fragt der Bericht ohne Modell
nach, ob die von tybo vorgesehenen MCP-Server und Skill-Links bei Codex
ankommen. „Nicht angekommen“ ist eine Warnung, auch bei einem gelöschten
Link. Der Exit-Code bleibt dadurch 0; am Ende steht dann, dass die Zeilen
mit `~` anzusehen sind. Andere Fehler im Bericht können weiterhin Exit-Code
1 ergeben.

„Nicht geprüft“ bedeutet, dass der Vergleich gescheitert ist, nach
15 Sekunden abgebrochen wurde oder Codex ein unbekanntes Ausgabeformat
liefert. Daraus folgt keine fehlende Einrichtung. Gibt tybo keine Server
oder Skills mit, entfällt der jeweilige Vergleich. Für die Skill-Abfrage
werden eigene MCP-Server vorübergehend nur im Prüfaufruf abgeschaltet,
ebenso automatische Erweiterungen. Ist der dafür nötige Bestand unlesbar
oder enthält er Ersatznamen, startet diese Abfrage vorsichtshalber nicht.
„Bestand unvollständig lesbar“ und „Plugins von Claude Code: Zahl unbekannt“ sind ebenfalls
keine Aussage, dass es nichts gibt. „Werkzeuge: nicht ermittelbar“ heißt,
dass schon die Bestandsaufnahme scheiterte.

Die Anzeige enthält ausschließlich bereinigte Namen, Zahlen und Gründe.
Schlüssel, Adressen, Aufrufparameter, Umgebungswerte und private Pfade bleiben
verborgen. tybo meldet niemanden an und schreibt keine Motor-Konfiguration.
Eine OAuth-Anmeldung für einen selbst in Codex eingerichteten MCP-Server
erfolgt von Hand mit `codex mcp login <server>` im eigenen Terminal. Nur wenn
ein HTTP-Server wirklich ohne Anmeldung erreichbar sein soll, darf sein Name
in `engine.codex.mcp.public` stehen. Ein fehlender Schlüssel ist dafür kein
Nachweis.

Die Kennungen hinter den Gründen bedeuten:

| Kennung | Bedeutung und mögliche Abhilfe |
|---|---|
| `disabled` | Weitergabe von MCP ist abgeschaltet. Bei Bedarf `engine.codex.mcp.enabled` einschalten. |
| `user_skip` | Der Server steht in `engine.codex.mcp.skip`. Die Ausnahme bei Bedarf entfernen. |
| `sandbox` | Die Rechte-Stufe erlaubt keine Weitergabe. Nur bewusst „Voller Zugriff“ wählen. |
| `codex_config_unreadable` | Eine Codex-Konfiguration ist unlesbar. Erst deren Lesbarkeit und Format reparieren. |
| `transport` | SSE wird nicht übernommen. Falls der Anbieter es unterstützt, einen HTTP-Zugang einrichten. |
| `invalid_name` | Der Servername passt nicht in einen Codex-Aufrufparameter. Die Quelle umbenennen; angezeigt wird `unzulaessig-<h>`. |
| `invalid_value` | Angaben im Eintrag fehlen oder haben das falsche Format. Den Eintrag korrigieren. |
| `secret_in_command` | Befehl oder Argumente enthalten Zugangsdaten. Diese über die Umgebung übergeben. |
| `secret_in_url` | Die Adresse enthält Zugangsdaten. Diese über Kopfzeilen oder die Umgebung übergeben. |
| `placeholder_unresolved` | Ein Platzhalter lässt sich nicht auflösen. Die zugehörigen Zugangsdaten im Projekt prüfen. |
| `reserved_env` | Der Eintrag greift auf geschützte Umgebungswerte zu. Den Eintrag korrigieren, nicht den Schutz umgehen. |
| `env_conflict` | Umgebungswerte widersprechen dem Motor oder einem anderen Server. Die Quellen aufeinander abstimmen. |
| `auth_unknown` | Keine Zugangsdaten im HTTP-Eintrag belegen keinen öffentlichen Zugang. OAuth in Codex selbst anmelden oder einen nachweislich öffentlichen Server ausdrücklich freigeben. |
| `not_in_engine` | Das Werkzeug ist in diesem Motor nicht eingerichtet. Bei Bedarf selbst ein entsprechendes Werkzeug einrichten. |
| `unsupported_source` | Der Server steht nur in einer nicht übernommenen Claude-Einstellungsdatei. Eine unterstützte MCP-Quelle verwenden. |
| `name` | Der Skill-Ordnername ist unzulässig oder sein Kopfname bereits belegt. Namen prüfen und Kollision auflösen. |
| `head` | Der Skill hat keinen lesbaren Kopf mit Beschreibung. Seine `SKILL.md` korrigieren. |
| `skills_off` | Die Skill-Weitergabe ist abgeschaltet. Bei Bedarf `engine.codex.skills` einschalten. |
| `link_missing` | Der Link von tybo fehlt. Er entsteht beim nächsten Bot-Start oder vor der nächsten neuen Codex-Session neu. |
| `connectors` | Konnektoren des Claude-Kontos sind nicht übertragbar. Ein eigener MCP-Zugang kann eine Alternative sein. |
| `plugins` | Skills und MCP-Server aus Claude-Plugins werden nicht mitgegeben. Falls verfügbar, selbst eine passende Codex-Erweiterung einrichten. |
| `hooks` | Claude-Hooks werden nicht mitgegeben. Es gibt keine automatische Übertragung. |
| `builtin` | Eingebaute Werkzeuge unterscheiden sich. Die folgende Tabelle nennt Gegenstücke und Grenzen. |
| `skills` | Dieser Motor kennt keine Skills, etwa der direkte Anthropic-API-Motor. |

Fehlende Notizen werden gesondert genannt. Bei Codex kann die Weitergabe mit
`engine.codex.claudeNotes` abgeschaltet sein; andere Ersatzmotoren bekommen
sie nicht automatisch. Hinweise können auch Server nennen, die nur tybo
kennt. Sie sind deshalb nicht immer eine Lücke gegenüber Claude Code.
Die Kurzfassung nennt neben Konnektoren auch Hooks, eingebaute Werkzeuge und,
wenn zutreffend, Plugins und fehlende Skills. Ein bereiter Ersatzmotor hat
dadurch immer mindestens diese festen Unterschiede.

### Eingebaute Werkzeuge von Claude Code und ihr Gegenstück in Codex

Stand: 17.11.2026. Geprüfte Programme: Claude Code **2.1.326**, Codex CLI
**0.169.0**. Die Zuordnung bezieht sich auf die Werkzeuglisten dieser Probe,
nicht auf die Qualität einer Antwort oder auf jede mögliche Konfiguration.
„Ja“ heißt ein vergleichbarer eigener Aufruf, „teilweise“ eine Teilfunktion
oder ein Weg über andere Werkzeuge, „nein“ kein Gegenstück in der geprüften Liste.

Quelle für Claude Code: `tools` im Ereignis `system` eines Laufs mit
`claude -p --output-format stream-json --verbose --safe-mode --strict-mcp-config --no-session-persistence --permission-mode dontAsk`.
Der Lauf in einem leeren temporären Ordner antwortete einmal mit „ok“ und
benutzte kein Werkzeug. Der sichere Modus schaltet persönliche Anpassungen
aus; eingebaute Werkzeuge bleiben aktiv. Die vorhandene Vorlage
`tests/fixtures/claude-rate-limit-stream.jsonl` enthielt nur `tools: []` und
keine Version, deshalb war diese zusätzliche Probe nötig.

Quelle für Codex: `codex debug prompt-input "hallo"`, ohne Modelllauf. In
dieser Ausgabe stehen die Aufrufe unter `functions`, `clock` und
`collaboration`; `functions.exec` nennt zusätzlich die darin aufrufbaren
Werkzeuge. Ein eigenes Web-Werkzeug war in dieser Ausgabe nicht enthalten.
Die auf Datum, Versionen und Werkzeugnamen reduzierte Probe steht in
[`tests/fixtures/tool-parity-builtins.json`](../tests/fixtures/tool-parity-builtins.json).

| Werkzeug von Claude Code | Gegenstück in Codex | Einordnung anhand der Probe |
|---|---|---|
| `Task` | ja | `collaboration.spawn_agent` und `followup_task` |
| `Bash` | ja | `exec_command` über `functions.exec` |
| `CronCreate` | nein | kein eigener Aufruf für wiederkehrende Zeitpläne |
| `CronDelete` | nein | kein eigener Aufruf zum Löschen solcher Zeitpläne |
| `CronList` | nein | kein eigener Aufruf zum Auflisten solcher Zeitpläne |
| `DesignSync` | nein | kein entsprechender Aufruf in der Liste |
| `Edit` | ja | `apply_patch` |
| `EnterWorktree` | teilweise | Git-Befehle über `exec_command`, kein eigener Worktree-Aufruf |
| `ExitWorktree` | teilweise | Git-Befehle über `exec_command`, kein eigener Worktree-Aufruf |
| `ListAgents` | ja | `collaboration.list_agents` |
| `Monitor` | teilweise | laufende Befehle über `write_stdin` abfragen; kein eigener Monitor-Aufruf |
| `NotebookEdit` | teilweise | Dateiänderung über Shell oder Patch, kein eigener Notebook-Aufruf |
| `PushNotification` | nein | kein entsprechender Aufruf in der Liste |
| `Read` | teilweise | Text über `exec_command`, Bilder über `view_image` |
| `RemoteTrigger` | nein | kein entsprechender Aufruf in der Liste |
| `ReportFindings` | nein | kein entsprechender Aufruf in der Liste |
| `ScheduleWakeup` | teilweise | `clock.sleep` wartet in der Sitzung, kein dauerhafter Weckauftrag |
| `SendMessage` | ja | `collaboration.send_message` |
| `Skill` | teilweise | Skill-Anweisungen sind lesbar, kein eigener Skill-Aufruf in der Liste |
| `TaskStop` | teilweise | `collaboration.interrupt_agent` für Agenten, Prozesssteuerung über Shell |
| `ToolSearch` | teilweise | Werkzeug-Metadaten über `ALL_TOOLS` in `functions.exec`, MCP-Ressourcen über eigene Leser |
| `WebFetch` | teilweise | Abruf über Shell, kein eigenes Web-Werkzeug in dieser Probe |
| `WebSearch` | nein | kein eigenes Suchwerkzeug in dieser Probe |
| `Workflow` | nein | kein entsprechender Aufruf in der Liste |
| `Write` | teilweise | Datei schreiben über `exec_command` oder `apply_patch` |

## Server und Hybrid

**Was es bringt:** tybo läuft auf einem Server rund um die Uhr. Im
Hybrid-Betrieb nimmt der Server alle Nachrichten an und reicht sie an deinen
eigenen Rechner weiter, solange der wach ist; sonst antwortet der Server.

**Was du brauchst:** einen Server mit Bun und einem Motor: Claude CLI (für
Claude Code dort `CLAUDE_AUTH=apiKey` mit `ANTHROPIC_API_KEY`) oder Codex
ohne Claude-Konto ([server.md](server.md), mit der Tabelle, was dann geht).
Nur für den Webhook (Profil `server`) und damit für Hybrid eine öffentliche
`https`-Adresse (Reverse-Proxy oder Tunnel); ein Server, der wie zu Hause
per Polling abholt, braucht keine. Für Hybrid dasselbe Supabase-Projekt auf
beiden Rechnern.

**Einrichten:** Auf dem Server `TYBO_PROFILE=server` mit
`TELEGRAM_WEBHOOK_SECRET` und `TELEGRAM_WEBHOOK_URL`; der Bot trägt den
Webhook dann selbst bei Telegram ein. Für Hybrid zusätzlich
`HYBRID_PEER_URL` und `GATEWAY_SECRET` auf dem Server, `TYBO_PROFILE=peer`
und dasselbe `GATEWAY_SECRET` auf dem eigenen Rechner. Alle Variablen,
Ausrollen und der Weg zurück zum Polling:
[telegram-webhook.md](telegram-webhook.md). `USE_AGENT_SDK` aus älteren
Anleitungen liest tybo nicht mehr (Issue #352).

**Prüfen:** vom Server aus `curl <HYBRID_PEER_URL>/health`; beim Start nennt
das Log `[hybrid] Hybrid aus: …`, wenn etwas fehlt.

## Linux: Dienste nach Neustart

**Was es bringt:** Der Bot startet nach einem Neustart des Rechners von
selbst, auch ohne dass du dich anmeldest.

**Was du brauchst:** je nach Weg im Schritt `autostart` PM2 oder systemd.

**Einrichten:**

- **PM2:** einmal `pm2 startup` und die Zeile ausführen, die PM2 dann
  ausgibt (meist mit `sudo`). Die Dienstliste speichert `tybo setup` bzw.
  `tybo dienste` selbst mit `pm2 save`.
- **systemd-Benutzerdienst:** Linger muss an sein, sonst startet der Dienst
  erst bei der Anmeldung. Der Assistent versucht es ohne Administratorrechte;
  klappt das nicht, einmal `sudo loginctl enable-linger <dein-name>`.

**Prüfen:** `loginctl show-user $USER -p Linger` zeigt `Linger=yes`; unter
PM2 `pm2 list` nach einem Neustart. Mehr:
[einrichtung.md](einrichtung.md#autostart-mit-systemd).

## Prüfbericht

**Was es bringt:** Ein Bericht über alles auf einmal: jeden Schritt der
Einrichtung, die Kanäle, den Motor, Telegram, Datenbank, Dienste und Sprache.
Der Abschnitt „Motor“ prüft den Standard-Motor (Einstellungen, sonst
`TYBO_ENGINE`, sonst Claude Code): installiert und angemeldet, mit dem `PATH`
aus der Dienstdatei des Bots. Unter macOS ist ein Bot, der geladen ist, aber
nicht läuft, ein Fehler wie unter Linux.

**Was du brauchst:** nichts; der Befehl schickt keine Testnachricht, schreibt
nichts in die Datenbank und ruft kein Modell auf.

**Einrichten:** nichts. `tybo pruefen` ausführen (gleich:
`bun run setup:verify`).

**Prüfen:** Exit-Code 0 heißt in Ordnung (auch mit Warnungen), 1 heißt, dass
etwas fehlgeschlagen ist; die Zeilen mit ✗ sagen, was.
