# 0024 Telefonhörer: flüssiges Gespräch mit tybo ohne ElevenLabs

Datum: 30.09.2026. Entschieden von: Maintainer (Milestone „V3 Telefonhörer“,
30.09.2026), Umsetzungsdetails aus der Planung V3 und aus der Prüfung vor dem
Bau von Issue #255.

## Zusammenhang

- `SPEC.md` schließt unter „Nicht im Umfang“ die Sprachausgabe aus;
  Entscheidung 0023 hat sie für V1 und V2 aufgenommen. Der Maintainer hat den
  Umfang am 30.09.2026 um den Milestone „V3 Telefonhörer“ erweitert.
- `SPEC.md` schließt außerdem Token-Streaming der Antwort aus und verlangt,
  dass Web, Telegram und Terminal denselben Chat-Kern nutzen. Diese
  Entscheidung nimmt für genau den Telefonhörer zwei Punkte davon aus (Muster
  wie 0022 und 0023, `SPEC.md` bleibt unverändert):
  - **Schlanker Gesprächskern statt Chat-Kern:** Der Telefonhörer denkt mit
    dem Gehirn der Sprach-Brücke (`src/lib/voice-brain/`), nicht mit dem
    Motor des Gesprächs. Getippte Nachrichten, Sprechmodus (V2), Telegram und
    Terminal laufen unverändert über den gemeinsamen Chat-Kern.
  - **Gestreamte Sprachantwort:** Die Antwort des Telefonhörers kommt Satz
    für Satz, damit die Stimme früh beginnt. Das gilt nur für diese
    gesprochene Antwort. Der Text im Chat kommt weiter am Stück.

## Entscheidung

- Neben „Sprechen“ gibt es einen eigenen Knopf „Telefonhörer“: ein flüssiges
  Gespräch mit tybo ohne ElevenLabs und ohne Telefonnummer. Das Telefon
  (Sprach-Brücke hinter einem ElevenLabs-Agenten) bleibt, wie es ist.
- Gehirn ist der schlanke Kontext der Sprach-Brücke (Agent-Prompt, Profil,
  Memory, letzte Nachrichten, 10 Minuten Cache) in einem gemeinsamen Modul
  `src/lib/voice-brain/`, nicht der volle Motor. Arbeit geht als Denkauftrag
  an den vollen Bot und landet im Gespräch.
- Modell im Format `<claude|openrouter|ollama>:<modell>`, Standard
  `claude:claude-sonnet-5-5`: mit `VOICE_ANTHROPIC_API_KEY` über die Messages
  API, sonst über eine offene Claude-Code-Sitzung im Abo (`--safe-mode`).
  Ohne bereiten Weg gibt es keinen Knopf, der Sprechmodus bleibt. Kein stilles
  Ausweichen auf ein anderes Modell.
- Hören und Sprechen lokal mit den Anbietern aus V2 (Parakeet, Pocket TTS,
  Browser-Stimme als Rückfall), Verbindung über WebSocket hinter dem
  WebUI-Login mit Origin-Prüfung, ein Gespräch zur Zeit.
- Werkzeuge im Gespräch als Tags im Text (Suche im Verlauf, Rechnen,
  Denkauftrag), keine schreibenden Werkzeuge; Freigaben nur per Knopf, nie per
  Stimme; Merk-Tags wie in der Brücke.
- Das Gespräch steht sofort im Verlauf des gewählten Gesprächs, nicht in
  Telegram.
- Ehrliche Erwartung: rund zwei bis drei Sekunden vom Ende der Äußerung bis
  zum ersten Ton, kein Advanced Voice Mode; Oberfläche und Doku sagen das.

## Gemeinsames Gehirn (Issue #255)

- `src/lib/voice-brain/` enthält die Bausteine, die Telefon und Telefonhörer
  teilen: Kontext (`context.ts`, Cache je Chat-ID und Topic), Sprechstil
  (`style.ts`, `channel: "phone"` ist der bisherige Text der Brücke,
  `channel: "call"` verlangt meist ein bis zwei Sätze, höchstens rund 300
  Zeichen), Tag-Filter (`tags.ts`), Effort-Wahl (`plan.ts`), der Abruf der
  Messages API (`backends/anthropic.ts`), der Satz-Strom (`sentences.ts`) und
  der Gesprächs-Turn (`turn.ts`). Die Brücke importiert von dort; am Telefon
  ändert sich nichts, auch kein Prompt-Caching.
- **Satzgrenze, eine Regel:** `.`, `!`, `?` oder `…` (auch mit schließender
  Anführung oder Klammer) plus Leerraum, oder ein Zeilenumbruch. Keine Grenze
  vor einem Kleinbuchstaben, nach einer Zahl („30. September“), einem
  einzelnen Buchstaben oder einer Abkürzung („z. B.“, „bzw.“, „Dr.“). Die
  Regel steht in `src/web/sentence-boundary.ts` (der Web-Server lädt nichts
  außerhalb von `src/web`); die Vorlese-Fassung aus V2 (`splitSentences`)
  und der Satz-Strom nutzen dieselbe Funktion. V2 behält seine
  600-Zeichen-Segmente und das Verbinden kurzer Sätze.
- **Satz-Strom für den Telefonhörer:** Ein Abschnitt hat mindestens 12
  Zeichen; der erste darf schon an Komma, Doppelpunkt oder Semikolon nach 25
  Zeichen enden (`earlyFirst`); über 240 Zeichen wird an der letzten
  Wortgrenze geteilt. Intent-Tags fallen vor der Zerlegung weg, im strengen
  Modus des Tag-Filters: ein angefangenes Tag wird nie vorgelesen, auch nicht
  am Ende oder nach 400 Zeichen. Die Brücke behält den bisherigen Modus.
- **Turn:** liefert Abschnitte, sobald sie fertig sind, und endet mit genau
  einem Abschlussereignis: `done` (mit `rawText` samt Tags, `spokenText` und
  `aborted`) oder `error` (mit `reason`, danach nichts mehr). Ein Abbruch
  beendet den Abruf sofort; schon gelieferte Abschnitte gelten, ein
  angefangener Satz wird verworfen.
- **Budget:** Jeder Abruf reserviert im Tagesbudget „voice“ wie die Brücke
  (`reserveRequest`). Ist das Budget erschöpft, geht keine Anfrage hinaus
  (`error`, `reason: "budget"`). Die Reservierung wird genau einmal
  abgerechnet, bei Erfolg, Fehler und Abbruch. Wie in der Brücke wird die
  ganze Reservierung verbucht, nicht die gemessenen Kosten.

## Modellwahl und weitere Wege (Issue #256)

- **Einstellung:** `speech.call.model` (`auto` oder `<claude|openrouter|ollama>:<modell>`),
  `speech.call.effort` (Standard `low`) und `speech.call.claudeVia` (`api`
  oder `cli`); Vorrang Datei vor `SPEECH_CALL_MODEL` vor `auto`.
  `resolveCallModel()` in `src/lib/voice-brain/call-model.ts` liefert Weg,
  Bereitschaft mit Grund, Erwartung und Abrechnung (`billing`: Abo,
  Anthropic-API, OpenRouter, lokal).
- **`auto`:** Sonnet über die Messages API mit `VOICE_ANTHROPIC_API_KEY`,
  sonst über die offene Claude-Code-Sitzung (wirklich geprüft mit
  `inspectEngine("claude")` und `claude --help`), sonst OpenRouter. Ollama
  wählt `auto` nie, auch nicht als letzte Stufe (Zieltext des Issues; der
  Planungs-Nachtrag „dann Ollama" ist damit bewusst nicht umgesetzt).
  `claudeVia` streicht in `auto` die andere Claude-Stufe; bei einem
  ausdrücklichen `claude:`-Modell erzwingt es den Weg, fehlt er, ist der
  Telefonhörer nicht bereit.
- **CLI ist nicht gleich Abo:** Mit `ANTHROPIC_API_KEY` im Bot läuft auch die
  CLI im API-Modus; `billing` sagt das. Wer nur das Abo will, stellt
  `claudeVia: cli` ein und setzt keinen `ANTHROPIC_API_KEY`.
- **Offene Sitzung:** eine CLI je Gespräch mit `--safe-mode`, ohne Werkzeuge
  und ohne jede geheim aussehende Variable außer den Anmeldungen der CLI;
  unterbrechen per `control_request`, nach 2 s ohne `result` wird der Prozess
  beendet. Absturz: einmal neu mit den letzten 12 Äußerungen im
  System-Prompt; kam schon Text, endet der Turn mit Fehler, damit nichts
  doppelt gesprochen wird. `total_cost_usd` ist über die Sitzung kumulativ,
  an den Credit Guard geht der Zuwachs. Die Sitzung steht in
  `engines/calls.ts`; ein laufendes Gespräch hält deshalb einen
  angeforderten Neustart auf, bis es endet.
- **Ein Zustand für jeden Abbruch:** Jeder Turn hat genau ein Abbruchsignal
  (`BrainCall.signal`, von `runVoiceTurn` erzeugt). Alle Quellen setzen es:
  das Signal des Aufrufers, `interrupt()`, `/stop` und `close()`; Wege
  melden Abbrüche, die bei ihnen entstehen, über `BrainCall.abort()`. Danach
  liefert der Turn keinen Abschnitt mehr, auch nicht aus schon gepuffertem
  Text, und der Weg sendet keine Äußerung mehr. `interrupt()` endet mit
  `done` und `aborted: true`, `/stop` und `close()` mit `error` und
  `reason: "ended"`.
- **Kein Ausweichen:** Zwei Turns hintereinander mit Fehler beenden das
  Gespräch; ein erschöpftes Budget und Abbrüche zählen nicht. Die
  Fallback-Kette springt nie ein.
- **Budget:** Jeder Weg reserviert vor jedem Abruf (auch bei Wiederholungen)
  und rechnet genau einmal ab; der Betrag je Reservierung kommt vom Aufrufer
  (#257).

## Verbindung im Server (Issue #257)

- **WebSocket `GET /api/call`** in `src/web/call.ts`, eingehängt in
  `Bun.serve`. Vor dem Upgrade gelten Host, Tunnel- bzw. Access-Nachweis,
  gültige Sitzung (nur Browser, kein Terminal-Schlüssel) und ausdrücklich
  der Origin, obwohl der Handshake ein GET ist; sonst 401 bzw. 403 ohne
  Upgrade. Abmelden und eine abgelaufene Sitzung (geprüft beim Ping alle
  25 s) beenden das Gespräch. Protokoll, Grenzen und Schließcodes:
  `docs/webui/telefonhoerer-protokoll.md`.
- **Kein Chat-Kern nötig:** Das Gespräch muss existieren und beschreibbar
  sein (Topic offen), der Chat-Kern des Gesprächs muss nicht bereit sein;
  der Telefonhörer denkt mit dem eigenen Gehirn.
- **Turn-Abschluss:** Ein Turn endet erst, wenn das Modell fertig, alles
  gesendet und jeder Abschnitt vom Browser mit `played` bestätigt ist, oder
  nach Tondauer plus 3 s, oder bei Unterbrechen, Fehler, Auflegen,
  Verbindungsabbruch. Dann genau einmal `onTurn` mit dem bestätigten Text;
  bei einem unterbrochenen Turn ist auch `rawText` nur dieser Text (der
  abgebrochene Rest samt Merk-Tags verfällt). Der flüchtige Verlauf des
  Gesprächs (für Folgeturns über die API) enthält nur Bestätigtes, mit
  „(unterbrochen)“.
- **Anbieter nur lokal:** Hören mit Parakeet oder whisper.cpp (feste Wahl
  nur, wenn lokal; Cloud-Erkennung nie, Ausnahme seit Issue #279 unten), Sprechen mit Pocket TTS oder Piper,
  sonst die Browser-Stimme. Nie die eigene Stimme (Entscheidung 0023), nie
  Cloud-Stimmen, nie Qwen3-TTS (ein Prozess je Aufruf, mehrere Sekunden).
- **Parakeet im Dauerbetrieb:** ein eigener Bun-Prozess
  (`src/lib/speech/parakeet_worker.ts`) lädt das Modell über die C-API von
  sherpa-onnx (`libsherpa-onnx-c-api`, liegt im schon eingerichteten
  Laufzeitpaket, keine weitere Installation) und erkennt Aufnahmen über
  stdin/stdout. Nicht `sherpa-onnx-offline-websocket-server`: der bindet
  laut Quelle an alle Netzwerkkarten, ohne Anmeldung. Fehlt die
  Bibliothek, wird je Äußerung erkannt; der Status sagt „langsamer“.
- **Pocket gestreamt:** `/tts` von pocket-tts 3.3.0 ist schon eine
  StreamingResponse (WAV-Kopf mit unbekannter Länge, dann PCM16 24 kHz,
  wie erzeugt); der Wächter bleibt unverändert (Token, Host, nur das Feld
  `text`). Der Telefonhörer liest die Antwort, wie sie kommt.
- **Ton an den Browser:** PCM16 LE mono 24 kHz; Piper (22,05 kHz, am Stück)
  wird umgerechnet. Keine WAV-Kennzeichnung: roher Strom, nicht gespeichert.
- **Budget:** Jeder Abruf reserviert `CALL_REQUEST_RESERVATION_USD`
  (Standard 0,05 USD) im Tagesbudget „voice“; wie in der Brücke wird die
  ganze Reservierung verbucht.
- **Neustart (Abweichung vom Abschnitt zu #256):** Ein offenes Gespräch hält
  einen angeforderten Neustart nur noch während eines Turns auf. Die offene
  CLI-Sitzung bleibt für `/stop` angemeldet, zählt zwischen den Turns aber
  nicht mehr als Verarbeitung; Turns über API, OpenRouter und Ollama zählen
  über `activeCallTurnCount`. Steht ein Neustart an, sagt tybo im Zustand
  „hört zu“ „Ich starte kurz neu, ruf gleich wieder an.“ und legt auf; neue
  Gespräche werden bis dahin abgelehnt.

## Werkzeuge, Merk-Tags und Freigaben (Issue #259)

- **Tags statt Function Calling:** `[SUCHE: …]`, `[RECHNE: …]`,
  `[DENKAUFTRAG: …]` (`src/lib/voice-brain/tools.ts`), weil die offene
  CLI-Sitzung mit `--safe-mode` keine MCP-Server hat und Tags mit jedem Weg
  gehen. Ein Tag beginnt mit `[` plus Name plus `:`; ab dann ist es stumm.
  Der Tag-Filter kennt die Werkzeug-Tags nur mit `extraTags`; die Brücke
  am Telefon bleibt bei Function Calling und unverändert.
- **Runden:** Nach `]` einer Suche oder Rechnung endet die Runde (die
  CLI-Sitzung wird dafür unterbrochen, nur die Runde, nicht der Turn); der
  Rest der Runde samt Merk-Tags verfällt. Höchstens zwei Werkzeug-Runden,
  danach der Hinweis „Keine weiteren Werkzeuge“; ein drittes Tag wird weder
  gesprochen noch ausgeführt. Nach `[DENKAUFTRAG:]` endet der Turn (die
  Ansage ersetzt jeden weiteren Satz des Modells).
- **Rechnen:** eigener Auswerter (`src/lib/voice-brain/calc.ts`): deutsches
  Komma, Tausenderpunkt (Punkt mit genau drei Ziffern), `+ - * /`,
  Klammern, `%` als Hundertstel, „X % von Y“; höchstens 200 Zeichen und 20
  Ebenen, Ergebnis endlich, sonst „Rechenfehler“.
- **Suche:** `history_search` über `callBuiltinTool`, 6.000 Zeichen, 8 s.
  Zeitlimit oder Fehler: der feste Satz „Dazu finde ich gerade nichts.“ und
  keine weitere Runde (vorsichtiger als ein Fehlertext an das Modell).
- **Denkauftrag:** `ChatHub.sendQueued` im selben Gespräch, mit
  `noTelegram` (kein Spiegel, keine Antwort und keine `[INVOKE:]`-Antworten
  in Telegram, auch in Telegram-Topics). Belegtes Gespräch, auch mit
  wartender Rückfrage: einreihen, nie als Antwort auf die Rückfrage. Ohne
  bereiten Chat-Kern bietet der Sprechstil kein `[DENKAUFTRAG:]` an.
  Die Rückmeldung hängt an genau diesem Auftrag (`onReply` je Sendung).
- **Ergebnis im Gespräch:** Die ersten 1.500 Zeichen gehen als eigener
  Block (`context`) vor die nächste Äußerung, nicht in die Äußerung selbst,
  damit das Wort „Denkauftrag“ im Block keinen neuen Denkauftrag auslöst.
  Ab dem Ergebnis gilt `foreignInput` bis zum Auflegen.
- **Merk-Tags:** `gateTurnIntents` mit bekannter, leerer Werkzeugliste
  (Suche im eigenen Verlauf ist kein fremder Inhalt) und Herkunft
  „Telefonhörer“; liefert zusätzlich, was übernommen wurde, ohne doppelt
  anzuwenden. Die Meldung nach dem Auflegen legt der Anschluss als
  `display_only` (Quelle `telefonhoerer`) im Nachrichtenspeicher ab, damit
  sie auch in Telegram-Gesprächen im Verlauf bleibt, ohne nach Telegram zu
  gehen; sie wartet auf laufende Merk-Tags.
- **Freigaben:** nur offene Werkzeug-Freigaben (`kind: tool`) des Gesprächs
  erscheinen in der Ansicht (`approval`), auch schon offene beim Anrufen
  (`ChoicePort.pending`). Merk-Vorschläge stehen wie bisher nur im Verlauf.
  Erkannter Text erreicht das Rückfragen-Register nie.
- **Kanal des Denkauftrags:** Werkzeug-Freigaben des Denkauftrags, auch die
  des per `[INVOKE:]` befragten Agenten im Folgeauftrag, gehen nie über
  `sendChoice`. In Telegram-Gesprächen legt `createTelegramNoticeRecorder`
  (bot-turn.ts) Freigaben, Merk-Vorschläge und deren Ergebnisse als
  `display_only` mit Gesprächszuordnung und `choiceId` im
  Nachrichtenspeicher ab: sichtbar ohne offenen Browser und nach dem
  Neuladen. Nur wenn der Speicher das nicht kann (Convex), bleibt es live.
  Die Rückfrage selbst trägt `noTelegram`, damit auch das Ergebnis eines
  abgelaufenen oder fehlenden Vorschlags nur im WebUI-Gespräch erscheint.

## Verlauf, Einstellungen und Einrichtung (Issue #260)

- **Verlauf:** `CallSession` meldet jeden abgeschlossenen Turn mit
  Äußerung, bestätigt Gesprochenem, Modell, Agent und den Uhrzeiten an
  `CallHistoryPort` (`src/web/call-history.ts`), beim Auflegen eines
  bereiten Gesprächs die Dauer. Reine Web-Gespräche: Gesprächsspeicher mit
  der Markierung `call` und der mitgegebenen Uhrzeit (`NewMessage.at`, nie in
  der Zukunft), dazu `saveMessage` unter `web:<id>` wie bei Web-Turns.
  Telegram-Gespräche: nur `saveMessage` mit `metadata.call`, `channel: "call"`
  und `topicId` (`createCallMemory` in `bot-call.ts`); offene Seiten bekommen
  die Nachrichten über den Live-Feed. Die Meldung „Telefongespräch, 4 Min.“
  steht als Meldung (Web) bzw. Nur-Anzeige-Eintrag (Telegram), Quelle
  `telefonhoerer`, die nie pusht. Ohne gesprochene Antwort steht nur die
  Äußerung da.
- **Reihenfolge und Denkauftrag:** je Gespräch eine Kette; sie wartet auf die
  Sperre des ChatHub (`whenIdle`). Ein Telegram-Turn, der direkt in Telegram
  läuft, hält die Ablage nicht auf.
- **Kontext für den nächsten getippten Turn:** `src/lib/call-recap.ts` merkt
  sich je Session-Schlüssel, was gesagt wurde (höchstens 4.000 Zeichen, die
  jüngsten zuerst). `runTurn` im Chat-Kern nimmt es genau einmal als
  Turn-Hinweis, also bei jedem Motor, voll wie fortgesetzt, auch für die
  Fallback-Kette. Denkaufträge (`noTelegram`) und befragte Agenten
  (`[INVOKE:]`) verbrauchen ihn nicht (`skipCallRecap`). Auch ein Turn im
  Sprechmodus nimmt ihn (vorsichtiger als ein Turn, der vom Telefonat nichts
  weiß). Der Merker lebt nur im Bot-Prozess.
- **Probe:** drei Testfragen (`probeCallModel` mit `runs: 1`), gemessen bis
  zum ersten sprechbaren Abschnitt; der kann ein Teilsatz sein, deshalb heißt
  der Wert „Antwort beginnt nach …“. Einordnung nach dem Median: bis 2 s
  flüssig, bis 4 s geht, darüber zäh; ohne Messwert keine Einordnung.
  `POST /api/voice/call/probe` hinter Login und Origin, höchstens drei in
  zehn Minuten für die Installation (429 mit Retry-After), höchstens 90 s
  (504; das Signal bricht die Probe ab und schließt den Weg), nicht während
  eines Gesprächs (409).
- **Einstellungen:** `modes.call` nennt zusätzlich Abrechnung, Einstellung
  und alle Wege mit Bereitschaft (`callWays`). Die Auswahl speichert Modell
  und `claudeVia` zusammen, damit API und Abo getrennt wählbar sind; ein
  fehlender sicherer Kontext wird im Browser geprüft.
- **Einrichtung:** Pfad „Telefonhörer“ im Schritt `sprache`
  (`src/setup/speech-call.ts`): Modellweg vor der Probe wählen, genau diesen
  messen und speichern; Wege, Probe und Geräteprobe über
  `SetupContext.callSetup` ersetzbar. Die Geräteprobe führt die
  Probe-Aufnahme durch Erkenner, gewählten Weg und Pocket TTS und misst jede
  Stufe auf dem Gerät (ohne Pocket: Browser-Stimme, erster Ton nicht
  messbar). „Automatisch“ speichert `auto` ausdrücklich, wenn
  `SPEECH_CALL_MODEL` sonst einen anderen Weg wählen würde.

## Ausnahme: ElevenLabs als Stimme (Issue #276)

Entschieden von: Maintainer (Issue #276, 02.10.2026). Diese Entscheidung
schloss Cloud-Stimmen für den Telefonhörer aus. Issue #276 nimmt genau eine
davon aus, nur fürs Sprechen; Hören bleibt lokal (seit Issue #279 mit einer
eigenen Ausnahme, Abschnitt unten), ElevenLabs Conversational AI und
Telefonnummern bleiben draußen.

- **Einstellung:** `speech.call.tts` (`auto`, `pocket`, `piper`,
  `elevenlabs`, `browser`), `speech.call.elevenlabsVoice` (Stimmen-Kennung,
  Standard die im Issue genannte Stimme) und `speech.call.elevenlabsModel`.
  `auto` und eine fehlende Einstellung verhalten sich wie vor #276 (Pocket
  TTS oder Piper, wenn `speech.tts` so steht, sonst der Browser); ElevenLabs
  spricht also nur, wenn es ausdrücklich gewählt ist. Der Schlüssel bleibt
  `ELEVENLABS_API_KEY` in `.env`; ohne ihn ist `elevenlabs` nicht wählbar
  (Grund in `modes.call.tts.options`), eine gespeicherte Wahl spricht dann
  mit Pocket TTS bzw. dem Browser. `ELEVENLABS_VOICE_ID` gilt nur für
  Telegram und den Sprechmodus und bleibt dort unverändert.
- **Gestreamt:** `POST /v1/text-to-speech/{voice}/stream` mit
  `output_format=pcm_24000` (dieselbe Rate wie Pocket TTS, kein
  Umrechnen); Bytepaare über Stückgrenzen werden zusammengehalten.
  Zeitlimits: 5 s bis zum ersten Stück und 5 s Stillstand. Standardmodell
  `eleven_flash_v2_5` (gemessen am schnellsten). Abbruch beendet die
  Anfrage sofort (`src/lib/speech/elevenlabs.ts`).
- **Rückfall je Abschnitt** (`src/web/call-voice.ts`): Scheitert
  ElevenLabs an einem Satz (HTTP-Fehler wie 401 oder 429, Netz, Zeitlimit,
  leerer Strom), spricht Pocket TTS genau diesen Satz, und der Browser
  bekommt einen Hinweis mit dem Namen der Stimme. Kam schon Ton, verwirft
  der Browser den ungespielten Rest (`audio_restart`) und der Satz kommt
  ganz vom Rückfall; schon Gehörtes lässt sich nicht zurücknehmen. Fehler
  zählen je Gespräch über Turns hinweg; ein erfolgreicher ElevenLabs-Satz
  setzt zurück, ein erfolgreicher Rückfall nicht; nach zwei Fehlern in
  Folge bleibt das Gespräch bei Pocket TTS. Abbruch zählt nicht und startet
  keinen Rückfall. Fehlt Pocket TTS oder scheitert es auch, spricht die
  Browser-Stimme diesen Satz (`speak_browser`), nach zwei Pocket-Fehlern in
  Folge jeden weiteren. Jeder Abschnitt wird genau einmal mit `played`
  bestätigt und verbucht.
- **Hörprobe:** `POST /api/voice/call/voice-probe` spricht einen festen Satz
  mit der Stimme des Telefonhörers, ohne Rückfall und ohne `speech.tts` zu
  ändern; Login, Origin, höchstens sechs in zehn Minuten, 20 s Zeitlimit,
  nicht während eines Gesprächs.
- **Daten und Kosten:** Jeder Antwortsatz geht als Text an ElevenLabs, und
  ElevenLabs berechnet jedes Zeichen; der Reiter „Sprechen“ sagt beides
  an der Auswahl.

## Ausnahme: ElevenLabs Scribe als Erkenner (Issue #279)

Entschieden von: Maintainer (Issue #279, 02.10.2026, mit Zustimmung, dass
die Aufnahmen dafür an ElevenLabs gehen). Diese Entscheidung schloss
Cloud-Erkennung für den Telefonhörer aus. Issue #279 nimmt genau einen
Erkenner davon aus, nur fürs Hören im Telefonhörer; Standard bleibt lokal,
ElevenLabs Conversational AI bleibt draußen. `SPEC.md` bleibt unverändert.

- **Einstellung:** `speech.call.stt` (`auto`, `parakeet`, `whisper-cpp`,
  `elevenlabs`). `auto` und eine fehlende Einstellung verhalten sich wie vor
  #279: die Wahl aus `speech.stt` (samt `SPEECH_STT`), wenn sie lokal ist,
  bei `auto` der erste verfügbare lokale Erkenner; steht `speech.stt` auf
  einem Cloud-Erkenner, ist der Telefonhörer weiter nicht bereit (kein
  stiller Wechsel in die Cloud). `parakeet` bzw. `whisper-cpp` gelten fest,
  unabhängig von `speech.stt`, ohne Ausweichen auf den anderen. Der
  Schlüssel bleibt `ELEVENLABS_API_KEY` in `.env`; ohne ihn ist
  `elevenlabs` nicht wählbar (Grund in `modes.call.stt.options`), eine
  gespeicherte Wahl erkennt dann mit dem ersten lokalen Erkenner (Grund in
  `modes.call.stt.reason`).
- **Weg: Realtime statt Batch.** Eine WebSocket-Verbindung je Gespräch zu
  `wss://api.elevenlabs.io/v1/speech-to-text/realtime` mit
  `scribe_v2_realtime`, `audio_format=pcm_16000`, `commit_strategy=manual`
  und `language_code` aus `speech.language` (`src/lib/speech/scribe.ts`),
  beim Öffnen des Gesprächs aufgebaut. Jedes angenommene Stück der
  Äußerung geht schon beim Sprechen hinaus (`CallLine.hear`); bei
  `utterance_pause` bzw. `utterance_end` committet die Erkennung den Rest
  und wartet auf alle Abschnitte der Äußerung. Kommt nach der Pause weitere
  Sprache, bleibt der erste Abschnitt gültig, der Text ist beide Abschnitte
  zusammen. Hängt bei einer neuen Äußerung noch etwas der alten, wird die
  Verbindung verworfen und neu aufgebaut, damit kein Abschnitt in die
  falsche Äußerung rutscht.
  Gewählt nach einer Messung im Takt des Telefonhörers
  (`scripts/scribe-transport-measure.ts`: Stücke zu 20 ms in Echtzeit,
  `utterance_pause` nach 300 ms, `utterance_end` nach weiteren 500 ms; Batch
  als WAV PCM16 mono 16 kHz bei `utterance_pause` hochgeladen, Realtime mit
  dem Weg des Telefonhörers; zwei Reihen am 02.10.2026, je 20 Läufe). Von
  `utterance_pause` bis zum Text: Realtime im Median 0,23 s, Batch 0,54 s
  bzw. 0,67 s. Nach `utterance_end` blieb zu warten: Realtime nie etwas,
  Batch im Median 0,04 s bzw. 0,17 s und bis 0,58 s. Im ganzen Gespräch
  (`scripts/call-measure.ts`) Ende der Äußerung bis erster Ton 1,93 s mit
  Scribe gegen 2,00 s mit Parakeet; die Streuung kommt dort vom Modell.
- **Nur der Telefonhörer:** Der Anbieter bekommt dafür einen eigenen Weg
  (`openCallStream`); `transcribe` für Telegram und den Sprechmodus sendet
  weiter `scribe_v1` am Stück wie vor #279.
- **Rückfall je Äußerung** (`src/web/call-stt.ts`): Scribe hat ein eigenes
  Zeitlimit von 4 s, getrennt vom Abbruch der Äußerung; Parakeet bekommt ein
  frisches und erkennt dieselbe Aufnahme, die die Sitzung gesammelt hat.
  Scheitert Scribe (Anmeldung 401, Kontingent oder Drosselung 429,
  Verbindung, Zeitlimit, sonstiger Fehler des Servers), erkennt Parakeet
  genau diese Äußerung, und der Browser bekommt einen Hinweis. Fehler
  zählen je Gespräch über Äußerungen hinweg; ein erfolgreiches
  Scribe-Ergebnis setzt zurück, ein erfolgreicher Rückfall nicht; nach zwei
  Fehlern in Folge bleibt das Gespräch bei Parakeet, die Verbindung endet,
  und kein Ton geht mehr an ElevenLabs. Ein inzwischen fehlender Schlüssel
  führt sofort dorthin. Abbruch zählt nicht und startet keinen Rückfall,
  auch nicht während des Rückfalls; ein leeres Ergebnis heißt „nichts
  gehört“, ohne Rückfall und ohne Zählen. Ohne eingerichtetes Parakeet
  endet ein Fehler wie bisher mit dem Fehlersatz der Sitzung. Parakeet wird
  beim Öffnen geladen und beim Auflegen beendet.
- **Gezählt wird nur, was die Sitzung übernimmt:** `recognize` ändert
  weder Zähler noch Bleiben. Erst wenn `utterance_end` ein Ergebnis nimmt,
  ruft die Sitzung `CallLine.adopt`; dann zählt ein Fehler, ein
  Scribe-Erfolg setzt zurück, und der Hinweis geht an den Browser. Eine
  veraltete Pausen-Erkennung (weitere Sprache danach) oder eine
  abgebrochene ändert nichts, auch wenn sie schon fertig war.
- **Frühe Erkennung:** Kommt nach `utterance_pause` weitere Sprache, bricht
  die Sitzung die noch laufende Erkennung sofort ab. Das gilt für jeden
  Erkenner. Bei Scribe endet damit nur das Warten; der schon committete
  Abschnitt gehört weiter zur Äußerung.
- **Log:** Anbieter, Dauer und Ergebnis als Status (ok, leer, Fehlerart,
  abgebrochen), nie Text oder Ton.
- **Daten und Kosten:** Jede Äußerung geht schon beim Sprechen an ElevenLabs,
  ElevenLabs berechnet die Erkennung nach Länge der Aufnahme; der Reiter
  „Sprechen“ sagt beides an der Auswahl.

## Echo-Schutz und Audio-Sitzung (Issue #280)

Entschieden von: Maintainer (Issue #280, 02.10.2026, Umsetzungsdetails aus
der Prüfung vor dem Bau). Über den Lautsprecher eines iPhones ließ sich
tybo per Stimme nicht unterbrechen; nach zwei Fehlalarmen schaltete die
Ansicht auf „nur Antippen“. Das war eine Echo-Vermutung (zweimal „nichts
verstanden“ nach Unterbrechen per Stimme), keine Messung.

- **Audio-Sitzung:** Der Tipp auf den Hörer setzt
  `navigator.audioSession.type = "play-and-record"` (W3C Audio Session,
  Safari), bevor AudioContext und Mikrofon angefragt werden; jedes Ende
  (Auflegen, Fehler beim Start, Ende vom Server, Hintergrund) setzt den
  vorigen Wert zurück. Ohne die API oder wenn sie beim Setzen wirft, ändert
  sich nichts. Eine gesetzte Sitzung ist kein Nachweis einer aktiven
  Echo-Unterdrückung; den liefert nur der Test auf dem Gerät.
- **Wiedergabeweg mit Audio-Sitzung:** Der Spieler schreibt dann in eine
  `MediaStreamAudioDestinationNode`, ein `<audio>`-Element (im Tipp
  gestartet) spielt ihren Strom. Grund: WebKit gibt der
  Sprachverarbeitung des Mikrofons nur den Ton als Referenz, den es für
  MediaStream-Spuren ausgibt (`RemoteAudioMediaStreamTrackRendererInternalUnitManager`
  meldet sich in `CoreAudioCaptureSource.cpp` als
  `CoreAudioSpeakerSamplesProducer` an), nicht die Ausgabe eines
  AudioContext. Weigert sich das Element zu spielen, geht der Spieler wie
  bisher direkt in den AudioContext. Ohne Audio-Sitzung (Chrome, Firefox,
  Android) bleibt der direkte Weg.
- **Puffer des `<audio>`-Wegs (Prüfung von #283):** Das Element puffert
  zusätzlich, das Ende im Worklet ist dort noch nicht das hörbare Ende. Kein
  Browser meldet diesen Puffer, also gilt fest `CALL_ROUTE_BUFFER_MS`
  (300 ms): `played` geht erst so lange nach der Meldung des Spielers
  hinaus, und erst dann beginnt eine wartende Ersatzstimme. Unterbrechen
  leert den Spieler wie bisher, schaltet das Element für dieselbe Zeit stumm
  (nicht `pause()`, ein neues `play()` bräuchte unter iOS einen Tipp) und
  verwirft wartende `played`. Fällt ein Satz auf die Browser-Stimme zurück
  (`speak_browser`), nachdem schon Ton von ihm an den Spieler ging, steckt
  sein Anfang noch im Puffer: die Ersatzstimme wartet dieselbe Zeit, statt
  ihn zu überlagern (zweite Prüfung von #283). Auf dem direkten Weg (ohne
  Sitzung oder wenn das Element nicht spielt) bleibt alles sofort.
- **Lautsprecher statt Hörmuschel:** Keine eigene Umleitung. WebKit setzt
  für `PlayAndRecord` selbst `AVAudioSessionCategoryOptionDefaultToSpeaker`,
  außer die Seite hat die Hörmuschel als Ausgabe gewählt
  (`AudioSessionIOS.mm`, `AudioSessionIOS::setCategory`); eine Web-API, die
  den Lautsprecher ausdrücklich wählt, gibt es auf iOS nicht. Die Lautstärke
  prüft der Test auf dem Gerät.
- **Echo-Schutz im Aufnahme-Worklet:** Nur mit gesetzter Audio-Sitzung
  hängt der Spieler zusätzlich am zweiten Eingang des Aufnahme-Worklets;
  ohne sie erkennt das Worklet genau wie vor #280. Aus dem Ton entsteht eine
  Hüllkurve der eigenen Wiedergabe, die jede Spitze 300 ms hält und dann mit
  250 ms abklingt (Nachhall). Solange sie läuft, sucht das Worklet den Ton
  der letzten 500 ms im Mikrofon (normierte Kreuzkorrelation je 20-ms-Block,
  grob auf 4 kHz, dann fein auf 16 kHz um die beste Stelle, dazu eine
  gemeinsame Anpassung der fünf Nachbarverzögerungen, damit auch ein Echo
  zwischen zwei Rasterpunkten ganz erklärt wird). Das geschieht für bis zu
  drei Echo-Wege (Lautsprecher direkt, dazu Reflexionen): jeder weitere Weg
  wird im Rest nach den bisherigen gesucht, alle werden gemeinsam angepasst,
  und ein Weg zählt nur, wenn er mindestens die Hälfte dieses Rests erklärt
  (ein weiteres Echo passt fast ganz, zufällige Ähnlichkeit mit
  Nutzersprache nicht). Die dritte Prüfung von #283 zeigte, dass zwei Wege
  10 ms auseinander sonst nach 440 ms als Sprache galten; der Fall und eine
  Gegenprobe mit Nutzersprache stehen als Test fest. Der Referenzring hat
  50 ms Reserve, weil die Wiedergabe je Browser-Block vor dem Mikrofon
  verarbeitet wird; so reicht er durchgehend bis 500 ms zurück. Der Anteil,
  den die Wiedergabe erklärt, ist Echo und fällt weg. Ein Block zählt nur
  als Sprache, wenn der Rest über der bisherigen Schwelle und über dem
  Doppelten des erwarteten Rest-Echos liegt (Hüllkurve mal Kopplung). Die
  Kopplung steht für Echo, das der Abgleich nicht erklärt (Nachhall,
  Verzerrung), beginnt bei 0,04 (die Zusatzschwelle liegt damit anfangs
  nahe der strengen Grundschwelle) und lernt aus Blöcken ohne Sprache,
  solange die Wiedergabe läuft: nach oben sofort, aber nur aus Blöcken, die
  der Abgleich mindestens zur Hälfte als Echo erklärt (ein Rest ohne
  erkennbares Echo kann leise Nutzersprache sein); nach unten erst, wenn die
  Wiedergabe länger als 500 ms durchgehend läuft (vorher kann ihr Echo noch
  unterwegs sein). Die zweite Prüfung von #283 zeigte, dass leise frühe
  Sprache (Amplitude 0,04 bis 0,06) sonst als Rest-Echo gelernt wurde und
  dass reines Rauschecho zwischen den 4-kHz-Rasterpunkten oder genau bei
  500 ms auslöste; beides steht als Test fest. Die erste
  Fassung verglich nur Pegel mit Startkopplung 1; die Prüfung von #283 zeigte
  zwei Fehler: leise Nutzersprache zu Beginn wurde als Echo gelernt und nie
  erkannt, und ein um 300 ms verzögertes, gleich lautes Echo unterbrach
  tybo, weil die Kopplung in der Laufzeit schon gesunken war. Beides ist mit
  dem Abgleich ausgeschlossen und als Test festgehalten. Mit Echo lernt die
  Rauschschätzung nicht. `config` setzt den Echo-Schutz nicht
  zurück, die Seite schickt dafür auch keine Pegel; der Vorlauf einer
  Äußerung bleibt wie bisher. Der Schutz greift vor `speechstart`, also
  bevor die Antwort abgebrochen wird.
- **Fehlalarm:** Jedes „nichts verstanden“ nach einem Unterbrechen per
  Stimme verdoppelt die Kopplung und hebt ihre Untergrenze bis zum
  Auflegen. Mit gesetzter Audio-Sitzung schaltet die Ansicht erst nach vier
  Fehlalarmen in Folge auf „nur Antippen“, ohne sie wie bisher nach zwei.
  Browser-Stimme, Ersatzstimme (`speak_browser`) und die Einstellung „Nur
  Antippen“ bleiben beim Unterbrechen nur per Antippen.
- **Quellen:** W3C Audio Session (https://www.w3.org/TR/audio-session/);
  WebKit `Source/WebCore/platform/audio/ios/AudioSessionIOS.mm`,
  `Source/WebCore/platform/mediastream/cocoa/CoreAudioCaptureSource.cpp`,
  `Source/WebKit/GPUProcess/webrtc/RemoteAudioMediaStreamTrackRendererInternalUnitManager.cpp`
  (github.com/WebKit/WebKit, Stand 02.10.2026).
