# 0027 Motorwechsel: Ersatzmotoren, Automatik am Limit und Werkzeug-Gleichstand

Datum: 16.11.2026. Entschieden von: Maintainer (Werkzeug-Gleichstand am
15.11.2026, die fünf offenen Punkte E1 bis E5 des Plans am 16.11.2026 nach den
Empfehlungen des Plans), Umsetzungsdetails Plan-Session.

Die Belege zu den Messquellen und zu den Werkzeugen von Codex liegen beim
Maintainer und nicht im Repo. Was der Bau davon braucht (Formate,
Beispieldaten), steht anonymisiert in den Issues des Meilensteins.

- Anlass: Das Wochenlimit des Claude-Abos läuft voll. Dann antworten heute die
  Ersatzmodelle der Fallback-Kette, also Ersatzmodelle mit eingeschränktem
  Werkzeugumfang. Ein zweiter Motor mit vollem Werkzeugumfang (Codex,
  OpenCode) ist die bessere Vertretung. Diese Entscheidung baut auf 0018 und 0019 auf und
  schreibt 0018 in einem Punkt fort (siehe „Werkzeug-Gleichstand“).
- Begriffe: Ein **Motor** ist ein Programm, das eine Anfrage mit Werkzeugen
  bearbeitet (Claude Code, Codex, OpenCode, Anthropic API). Eine **Stufe** ist
  ein Motor mit optionalem Modell und Effort, etwa „Claude Code mit Opus 5.5“.
  Ein **Fenster** ist ein Limit eines Abos mit Stand in Prozent und Zeitpunkt
  der Rücksetzung (Reset), etwa die Woche oder fünf Stunden.
- Reihenfolge: `engine.default` bleibt der erste Motor. Neu ist
  `engine.backups`, die Liste der Ersatzstufen in ihrer Reihenfolge, je
  Eintrag `{ engine, model?, effort? }`, höchstens vier. Als Ersatzstufe
  gelten nur `claude`, `codex` und `opencode`, nie `api`; Datei und API
  lehnen `api` dort ab. `model` und `effort` gelten nur für eine
  Claude-Stufe; Codex und OpenCode nehmen Modell und Effort aus
  `engine.codex` und `engine.opencode` wie bisher. Ohne `engine.backups`
  bleibt alles, wie es ist.
- Reihenfolge eines Turns: zuerst der gewünschte Motor (Gespräch mit
  `/motor`, sonst Agent, sonst Standard), danach die übrigen Stufen der
  allgemeinen Reihenfolge ohne Doppelte. `api` steht nur dann in der
  Reihenfolge, wenn es der gewünschte Motor ist; als Ersatz rückt es nie
  nach, auch nicht als Standard hinter einem Wunsch aus `/motor`. Dahinter
  bleiben die Ersatzmodelle der Fallback-Kette als letztes Netz.
- Empfohlene Reihenfolge (E1, entschieden: ja): Claude Code mit dem
  Standardmodell (seit 16.11.2026 Fable 5.2 mit Effort `high`), dann Claude
  Code mit Opus 5.5, dann Codex, dann OpenCode. Grund für die zweite Stufe:
  Das Abo führt ein eigenes Wochenlimit je Modellfamilie (am 15.11.2026 für
  Fable, mit höchstens der Hälfte des Wochenlimits). Ist nur dieses Teil-Limit
  voll, bleibt Claude Code mit einem anderen Modell nutzbar, und Werkzeuge,
  Skills und Regeln bleiben dieselben.
- OpenRouter ist ein Anbieter, kein Motor. Als Motor läuft er über OpenCode
  mit einem OpenRouter-Modell (0019); als Ersatzmodell mit eingeschränktem Werkzeugumfang bleibt er in
  der Fallback-Kette.
- Messwerte: tybo führt je Motor und Fenster den Stand in Prozent (0 bis 100),
  die Reset-Zeit, den Zeitpunkt der Messung und die Quelle. Ablage in
  `data/engine-usage.json`, nicht in `config/settings.json`. Kennungen der
  Fenster: `weekly_all` (Woche, alle Modelle), `weekly_scoped:<familie>`
  (Woche einer Modellfamilie: fable, opus, sonnet, haiku), `session` (fünf
  Stunden), `window_<minuten>` (ein Fenster, das nur über seine Dauer bekannt
  ist, etwa bei Codex). Je Motor und Fenster gilt die jüngste Messung; eine
  ältere überschreibt nie eine jüngere. Fehler beim Lesen oder Schreiben der
  Ablage kosten nie eine Antwort.
- Quellen der Messung:
  - Claude Code: das Ereignis `rate_limit_event` im Ereignisstrom jedes
    Laufs (`claude -p --output-format stream-json`). Es kostet nichts
    zusätzlich und ist frisch, solange Claude Code läuft. Es nennt die Woche
    und, wenn vorhanden, das Fenster über fünf Stunden, bisher aber kein
    Teil-Limit für Fable. Die Dokumentation kennt eigene Arten nur für Opus
    und Sonnet; treten sie auf, werden sie als Teil-Limit gespeichert.
  - Claude Code, Teil-Limits je Modell: der Verbrauchsbericht, den Claude
    Code auf `/usage` liefert (`usage_report`, laut Dokumentation
    experimentell). Geprüft am 16.11.2026 mit Claude Code 2.1.325: Der
    Bericht kommt auch ohne Bildschirm (`claude -p` mit Ereignisstrom), ohne
    Turn und ohne Kosten, mit den Fenstern `session`, `weekly_all` und
    `weekly_scoped`.
  - Claude Code während einer Sperre: Ein gesperrter Motor läuft nicht und
    misst deshalb nicht selbst. Solange ein Fenster von Claude Code gesperrt
    ist, misst tybo alle 30 Minuten mit einem eigenen Messlauf nach, über den
    Verbrauchsbericht. So fällt auf, wenn der Anbieter ein Limit mitten im
    Fenster zurücksetzt.
  - Codex: nach jedem Lauf das letzte Ereignis `token_count` in der
    Sitzungsdatei des Laufs (`rate_limits`). Der Strom von
    `codex exec --json` enthält den Stand nicht. Fenster werden nach ihrer
    Dauer eingeordnet (`window_minutes`), nicht nach ihrer Position.
  - OpenCode: keine Messung in Prozent. Für OpenRouter zeigt tybo das
    Guthaben und das Limit des Schlüssels, als Anzeige ohne Wirkung auf die
    Regel.
- Anmeldedaten (E2, entschieden: nein zum inoffiziellen Endpunkt): tybo liest
  kein Anmelde-Token eines Motors, erneuert keines und ruft keinen
  undokumentierten Endpunkt auf. tybo ist ein öffentliches Repo, und das Token
  verfällt nach rund acht Stunden, wenn Claude Code nicht läuft. Wer eine
  weitere Quelle hat, etwa ein privates Werkstatt-Skript, darf Messwerte im
  dokumentierten Format mit `bun run limits set` in `data/engine-usage.json`
  einliefern (Quelle `extern`); `bun run limits show` zeigt den Stand.
- Sperren: Es gibt drei Arten. `threshold`: Eine Messung erreicht die Schwelle
  (Standard 95 %, einstellbar von 50 bis 99); gesperrt ist das Fenster bis zu
  seiner Reset-Zeit. `limit`: Ein Lauf endet mit einem Limit-Fehler. Nennt der
  Fehler sein Fenster oder zeigt eine frische Messung genau ein Fenster bei
  100 %, gilt die Sperre für dieses Fenster bis zu dessen Reset-Zeit. Sonst
  gilt sie nur für die Modellfamilie des Laufs, als Pause von 60 Minuten, die
  sich bei jedem weiteren Limit-Fehler verdoppelt, höchstens 6 Stunden. Die Reset-Zeit
  eines Fensters, das nicht belegt ist, wird nie übernommen. `outage`: Der
  Motor fällt aus (siehe „Einspringen“). Die Fehlerzähler für das Verdoppeln
  stehen getrennt von den Sperren, je Motor und Modellfamilie; sie überdauern
  das Ende einer Sperre, und erst ein gelungener Lauf derselben Stufe setzt
  sie zurück. Ablage in `data/engine-switch.json`. Lässt sich die Datei nicht
  lesen, sperren oder schreiben, gilt der Zustand im Arbeitsspeicher weiter;
  eine Antwort geht deshalb nie verloren.
- Eine Stufe ist frei, wenn keine Sperre sie trifft: keines ihrer Fenster,
  nicht ihre Modellfamilie und nicht der ganze Motor. Für Claude Code zählen
  die Woche, die fünf Stunden und das Teil-Limit der Modellfamilie dieser
  Stufe; für Codex jedes gemeldete Fenster. Ein Turn läuft über die
  erste Stufe seiner Reihenfolge, die frei und bereit ist (installiert und
  angemeldet).
- Was eine Sperre aufhebt:
  - Ablauf: immer, bei jeder Art.
  - Messung: Eine Messung, die jünger ist als die Sperre und unter der
    Rückkehrschwelle liegt (Standard: Schwelle minus 15 Punkte), hebt
    `threshold` und `limit` für dieses Fenster auf. Der Abstand zwischen
    Schwelle und Rückkehrschwelle verhindert ein Hin und Her.
  - Neu prüfen (`/motor pruefen`, Knopf „Jetzt messen“): erst messen, dann
    neu bewerten. Ein Fenster mit frischer Messung bleibt gesperrt, wenn der
    Wert bei oder über der Rückkehrschwelle liegt, sonst wird es frei. Sperren
    ohne frische Messung, auch `limit` ohne bekannte Reset-Zeit, werden frei;
    der nächste Lauf entscheidet, und scheitert er, gilt die Pause des
    erhöhten Zählers. `outage` wird frei, wenn der Motor bereit ist.
  - Automatik aus (`/motor auto aus`): hebt alle Sperren `threshold` sofort
    auf und setzt keine neuen. `limit` und `outage` bleiben.
  - Geänderte Schwelle: Sperren `threshold` werden sofort gegen die letzte
    Messung und die neue Rückkehrschwelle neu bewertet.
- Rückwechsel (E5, entschieden: sofort): Sobald die Sperre endet, läuft die
  nächste Nachricht wieder über die frühere Stufe. Scheitert sie am Limit,
  springt im selben Turn die nächste Stufe ein und die Pause verdoppelt sich.
- Fehlt eine Messung oder ist ihr Fenster abgelaufen, gilt der Motor als frei.
  Der nächste Lauf misst neu oder scheitert am Limit; dann greift die Regel
  für Limit-Fehler. Die Anzeige nennt das Alter jeder Messung.
- Eine laufende Antwort wird nie umgeschaltet. Entschieden wird beim Start
  eines Turns.
- Einspringen im selben Turn: Endet ein Lauf mit einem Limit-Fehler oder fällt
  der Motor aus (nicht installiert, nicht angemeldet, Überlast, anderer
  Fehler), antwortet im selben Turn die nächste freie Stufe. Höchstens drei
  Stufenversuche je Turn (eine Stufe ist ein Motor mit Modell), danach die
  Ersatzmodelle der Fallback-Kette. Die Kette erfährt, welche Stufen versucht
  oder gesperrt sind, und lässt sie aus; sie startet also kein Claude Code,
  das eben am Limit gescheitert ist. Nach einem Limit-Fehler gibt es keinen
  zweiten Versuch auf derselben Stufe. Ein Ausfall sperrt den Motor für
  10 Minuten, bei Wiederholung verdoppelt bis 60 Minuten. Das ersetzt den
  bisherigen Sonderfall, bei dem nur Claude Code einsprang. Ein Zeitlimit und
  `/stop` lösen keinen Wechsel aus.
- Keine Stufe frei: Ist schon beim Start eines Turns jede Stufe gesperrt oder
  nicht bereit, startet kein Motor. Es antworten die Ersatzmodelle der
  Fallback-Kette mit vollem Kontext und einem Hinweis, der die früheste
  Freigabe nennt. Antwortet auch die Kette nicht, bekommt der Nutzer eine
  feste Antwort mit dieser Zeit.
- Limit-Fehler erkennen: bei Claude Code ein `rate_limit_event` mit Status
  `rejected`, der Fehlercode `credits_required` oder ein Meldungsanfang
  („You've hit your“, „You've reached your“, „You're out of usage credits“);
  bei Codex und OpenCode die Fehlerarten `usage_limit` und `quota`. Das gilt
  auf jedem Weg, auf dem Claude Code antwortet. Meldet Claude Code den Lauf
  als gelungen, braucht es zwei Hinweise zugleich (Status `rejected` und eine
  leere Antwort oder eine Limit-Meldung), damit eine Antwort, die eine solche
  Meldung nur zitiert, kein Fehler wird.
- Automatik: `engine.auto` mit `enabled` (Standard an, sobald es
  Ersatzstufen gibt), `threshold` und `returnBelow`. Aus heißt: keine Sperre
  durch die Schwelle, und bestehende Sperren `threshold` enden sofort. Das
  Einspringen bei Fehlern bleibt, solange Ersatzstufen eingestellt sind.
- Übergabe: Jede Stufe hat ihre eigene Session (0018). Ein Wechsel beginnt
  eine neue Session mit vollem Prompt. Dazu kommt der Übergabe-Verlauf: die
  Nachrichten des Gesprächs ab der Nutzernachricht, mit der die alte Session
  begann, höchstens 30 Nachrichten und 24.000 Zeichen, die jüngsten
  ungekürzt, und eine Zeile, die dem neuen Motor sagt, dass er ein laufendes
  Gespräch übernimmt. Das gilt auch nach `/motor` von Hand: Vor dem Löschen
  der alten Session hält tybo Motor und Beginn fest, ohne die Session
  aufzubewahren. Springt eine Stufe im selben Turn ein, nennt der Prompt die
  Werkzeuge, die der abgebrochene Versuch schon benutzt hat, mit der Bitte,
  den Stand zu prüfen, bevor etwas wiederholt wird.
  Ein Lauf kann nach halber Arbeit abbrechen: Die Werkzeugliste mindert doppelte
  Wirkungen (zweimal gesendete Datei, doppelt angelegter Eintrag), verhindert sie
  aber nicht. Der Absatz nennt je Versuch höchstens 20 Werkzeugaufrufe mit je
  80 Zeichen, erst maskiert, dann gekürzt; weitere Aufrufe werden als Anzahl
  genannt. Ist die Geheimnisquelle nicht lesbar, enthält er nur Werkzeugnamen.
  Diese Grenze gehört auch in die Betriebsanleitung und Abnahme von M14-27.
- Über einen gesperrten Motor läuft kein Destillat; es entfällt mit einer
  Zeile im Log. Die alte Session wird nicht aufbewahrt.
- Rückfragen mit Knöpfen: Die Antwort geht an die Session des Motors, der
  gefragt hat, wenn dessen Stufe frei ist. Ist sie gesperrt oder nicht bereit,
  oder scheitert dieser Lauf am Limit oder an einem Ausfall, gehen Frage und
  Antwort einmal als Übergabe an die Stufe, die nach der Regel dran ist.
- Nebenaufgaben (Judge von `/goal`, Fäden, Review) mit einem Claude-Ziel
  weichen auf das Ersatzmodell über OpenRouter aus
  (`fallback.openrouterModel`), solange die für ihr Modell zählenden Fenster
  gesperrt sind. Ohne Schlüssel gelten sie für die Dauer der Sperre als
  abgeschaltet; `/goal` pausiert dann einmal mit einem eigenen Text.
- Meldung: einmal je Wechsel über den gemeinsamen Meldeweg (Direktchat und
  WebUI) mit altem und neuem Motor, Grund, Stand und Reset-Zeit. Die Meldung
  wird zuerst gespeichert und dann gesendet; nach einer gescheiterten
  Zustellung oder einem Neustart dazwischen wird sie nachgeholt. In jedem
  Gespräch dazu einmal ein Hinweis vor der ersten Antwort des anderen Motors,
  mit und ohne Session-Modus. Auch der Rückwechsel nach einem Limit und der
  Fall „keine Stufe frei“ werden gemeldet. Ein Ausfall ohne Limit wird einmal beim Einspringen gemeldet, die
  Rückkehr danach nicht, und derselbe Motor höchstens einmal je Stunde.
- WebUI: Der Abschnitt „Motor“ zieht vom Reiter „Agenten“ an den Anfang des
  Reiters „Modelle“ und zeigt Reihenfolge, Automatik, Schwelle und den Stand
  je Motor mit Alter der Messung. Im Reiter „Agenten“ bleibt ein Verweis. Im
  Chat zeigt die Motor-Pille immer den Motor des Gesprächs; ein Menü daran
  nennt den Grund und erlaubt den Wechsel für dieses Gespräch.
- `/motor` zeigt den Motor des Gesprächs mit Grund und den Stand je Motor.
  Neu: `/motor auto an`, `/motor auto aus`, `/motor pruefen`. Die bisherigen
  Formen bleiben.
- Motor je Agent (E4, entschieden: ja): `agents.<id>.engine`, Vorrang
  Gespräch, Agent, Standard. Modell und Effort eines Agenten gelten weiter
  für Claude Code und für den Motor `api`; ein Agent mit Codex oder OpenCode
  nutzt die Einstellungen des Motors. Als letztes, abtrennbares Issue des Meilensteins.
- Bezahlte Stufen (E3, entschieden: ja): OpenCode über OpenRouter rechnet
  nach Verbrauch ab und darf trotzdem von selbst einspringen, als letzte Stufe
  der Reihenfolge. Die Bremse ist das Limit am Schlüssel bei OpenRouter; tybo
  führt kein eigenes Budget dafür. Der Motor `api` (der direkte Zugang zu
  Anthropics Programmierschnittstelle, zahlt ebenfalls je Verbrauch) kommt
  nicht in die Automatik und bleibt eine Wahl von Hand: Er lässt sich weder
  über die Datei noch über die API als Ersatzstufe eintragen, und die Regel
  schiebt ihn nie als Ersatz ein.
- Werkzeug-Gleichstand (Maintainer, 15.11.2026): Ein Ersatzmotor vertritt
  Claude Code nur dann gut, wenn er dieselben Werkzeuge hat. Für Codex gilt
  deshalb:
  - Geltung: Chat-Turns über Codex und Hintergrund-Jobs auf Codex mit
    `--full-access`. Eingeschränkte Codex-Jobs (ohne `--full-access`)
    bekommen bewusst keine MCP-Server (MCP, Model Context Protocol: die
    Anbindung fremder Werkzeuge); dort sind sie seit #618 abgeschaltet.
    Pipeline-Worker bekommen von tybo keine MCP-Server, weil auch der
    Claude-Worker der Pipeline keine hat: Seine Werkzeugliste nennt nur
    Datei- und Shell-Werkzeuge. Gleichstand heißt dort „keine“.
  - MCP-Server gibt tybo dem Lauf als Aufrufparameter mit
    (`-c mcp_servers.…`), nichts davon wird gespeichert. Quellen in dieser
    Rangfolge: `config/mcp-servers.json`, die Datei aus `MCP_CONFIG_PATH`,
    der Eintrag des Projektordners in `~/.claude.json`, `<projekt>/.mcp.json`
    und die globalen Server in `~/.claude.json`. Was Claude Code selbst nicht
    lädt, gibt tybo nicht mit: einen Server, der im Eintrag des Projektordners
    abgeschaltet ist, und einen Server aus `.mcp.json`, dem dort nicht
    zugestimmt wurde.
  - Ein Server, den der Nutzer in Codex selbst eingerichtet hat, geht bei
    gleichem Namen vor und bekommt von tybo keinen Parameter. Dafür zählen
    die Konfiguration im Konfigurationsordner von Codex (`CODEX_HOME`, sonst
    `~/.codex`, auch in Profilen) und die Projektdateien `.codex/config.toml`
    im Arbeitsordner und darüber. Lässt sich eine dieser Dateien nicht lesen,
    gibt tybo für diesen Lauf gar keinen Server mit.
  - Rechte: tybo gibt MCP-Server nur in der Rechte-Stufe „Voller Zugriff“
    mit. Ein MCP-Server läuft außerhalb der Sandbox von Codex; in den Stufen
    „Projekt schreiben“ und „Nur lesen“ würde er die Stufe unterlaufen. In
    „Voller Zugriff“ sind die Werkzeuge der mitgegebenen Server für den Lauf
    freigegeben (`default_tools_approval_mode="approve"`), weil tybo Codex
    ohne Rückfragen aufruft und der Aufruf sonst scheitert.
  - Geheimnisse stehen nie in einer Befehlszeile, weder in der von Codex
    noch in der eines Servers, den Codex startet. Werte gehen über die
    Umgebung des Prozesses (`env_vars`, `bearer_token_env_var`,
    `env_http_headers`). Ein Server, dessen Befehl, Argumente oder Adresse
    ein Geheimnis oder einen Platzhalter enthalten, wird übersprungen.
  - Ein MCP-Eintrag kann den Geheimnisfilter der Subprozesse nicht umgehen:
    Er darf keine Variable setzen oder anfordern, die der Filter immer
    entfernt (Gesprächskennungen, `WEB_PASSWORD`, `WEB_PUSH_PRIVATE_KEY`,
    `CLAUDECODE`), keine, die tybo selbst setzt (`TYBO_SUBPROCESS`, `HOME`,
    `PATH`, `CODEX_HOME`), nicht die Schlüssel von Codex und die Bot-Tokens
    von Telegram, und keine, die das Laden fremden Codes steuert. Auch der
    Wert einer solchen Variablen darf nicht unter anderem Namen mitgehen.
    Ein Eintrag, der das versucht, wird übersprungen.
  - Die Werte, die tybo einem Lauf über die Umgebung mitgibt, kommen zur
    Maskierung dazu: Kein Log, keine Fehlermeldung und kein Job-Bericht zeigt
    sie.
  - Ein HTTP-Server aus einer Quelle von Claude Code ohne Zugangsdaten in
    der Datei gilt als „Anmeldung unbekannt“ und geht nicht mit, denn
    fehlende Kopfzeilen belegen nicht, dass er offen ist (Claude Code kann
    für ihn über OAuth angemeldet sein, ein Anmeldeverfahren über den
    Browser). Wer weiß, dass ein solcher Server offen ist, nennt ihn in
    `engine.codex.mcp.public`. Server über SSE (Server-Sent Events, eine
    ältere Transport-Art) gehen nicht mit, weil Codex sie nicht anbindet.
  - Skills liest Codex nur aus festen Orten, ein Aufrufparameter für weitere
    Orte fehlt (geprüft mit Codex 0.169.0). tybo legt deshalb im eigenen
    Projektordner unter `.agents/skills/` Links auf die Skills von Claude Code
    an (`~/.claude/skills/`, `<projekt>/.claude/skills/`). Es sind Links,
    keine Kopien: Gepflegt wird ein Skill weiter an einer Stelle. Welche
    Links von tybo stammen, steht in `data/codex-skill-links.json`; nur diese
    ändert oder entfernt tybo.
  - Die Notizen von Claude Code zum Projekt (`MEMORY.md`) bekommt Codex am
    Anfang einer neuen Session als Kontext, nur lesend, gekürzt und maskiert.
  - Abschalten lässt sich jeder der drei Teile einzeln (`engine.codex.mcp`,
    `engine.codex.skills`, `engine.codex.claudeNotes`).
  - Was nicht übertragbar ist, weist tybo aus statt es zu verschweigen:
    Konnektoren des Claude-Kontos, MCP-Server mit Anmeldung über OAuth oder
    unbekannter Anmeldung, übersprungene Server mit ihrem Grund, Skills und
    Server aus Plugins von Claude Code, Hooks und eingebaute Werkzeuge ohne
    Gegenstück. Der Bestand und die Lücken je Motor kommen aus einer Quelle
    und stehen in `/motor werkzeuge`, in `tybo pruefen` und im Reiter
    „Status“.
- Fortschreibung von 0018: Dort steht „MCP-Server und Skills kommen aus der
  Konfiguration des jeweiligen Motors; tybo schreibt dort nichts.“ Der zweite
  Halbsatz gilt weiter ohne Ausnahme: tybo schreibt nichts in den
  Konfigurationsordner von Codex (`CODEX_HOME`, sonst `~/.codex`), nichts in
  eine `.codex/config.toml` eines Projekts, nichts in `~/.claude` oder
  `~/.claude.json` und nichts in die Konfiguration von OpenCode, und ruft
  weder `codex mcp add` noch `codex mcp login` auf. Der erste Halbsatz ist
  ersetzt: Werkzeuge kommen aus der Konfiguration des Motors **und** aus dem,
  was tybo je Lauf mitgibt. Die Konfiguration des Motors geht dabei vor: Was
  der Nutzer in Codex selbst eingerichtet hat, überschreibt und mischt tybo
  nicht. Der Ordner `.agents/skills/` liegt im Projektordner von tybo und
  steht in der `.gitignore`. tybo ändert und entfernt dort nur Links, die es
  selbst angelegt und in `data/codex-skill-links.json` vermerkt hat, und nur,
  solange der Link noch auf das vermerkte Ziel zeigt. Jeder andere Eintrag
  gehört dem Nutzer, auch ein Link auf dieselbe Quelle, der schon vorher da
  war. Fehlt der Vermerk oder ist er unlesbar, gelten alle vorhandenen
  Einträge als fremd.
- Geltung in M14: Chat-Turns aller Kanäle, Antworten auf Rückfragen und die
  Folgeturns von `/goal`. Der automatische Wechsel gilt noch nicht für
  Hintergrund-Jobs, Routinen, Check-in, Morgenbriefing und den Sprachagenten
  (zweite Ausbaustufe, eigener Meilenstein). Der Werkzeug-Gleichstand hat
  eine eigene Geltung, die auch Codex-Jobs mit `--full-access` einschließt
  (siehe „Werkzeug-Gleichstand“).
- Bezug zu #618: Das Issue macht den Motor für Pipeline-Worker und
  Hintergrund-Jobs von Hand wählbar (`workerEngine`, `bun run job start --engine`).
  Es gehört seit dem 16.11.2026 zum Meilenstein, wird als Erstes gebaut und
  liegt in `webui`, bevor die übrigen Issues gebaut werden; für sie ist es
  eine feste Voraussetzung. Es ist der erste Baustein der
  zweiten Ausbaustufe; die Automatik aus dieser Entscheidung greift dort noch
  nicht. Der Werkzeug-Gleichstand baut darauf auf, ohne die Grenzen von #618
  zu verschieben: Codex-Jobs mit `--full-access` bekommen MCP-Server und
  Notizen wie ein Chat-Turn. Eingeschränkte Codex-Jobs behalten die
  Abschaltung von MCP-Servern, Websuche, Apps und Shell aus #618 vollständig.
  Pipeline-Worker auf Codex bleiben, wie #618 sie gebaut hat, und bekommen
  von tybo keine MCP-Server, weil auch der Claude-Worker der Pipeline keine
  hat.
- Bewusst nicht gebaut: Umschalten mitten in einer Antwort, Verteilen der
  Last nach Prozent, Wettlauf mehrerer Motoren, Erneuern von Anmelde-Tokens,
  Kauf von Zusatzguthaben, Prognose des Verbrauchs, Mitnahme des inneren
  Zustands einer Session zu einem anderen Motor, Einrichten von Werkzeugen in
  der Konfiguration eines Motors.
