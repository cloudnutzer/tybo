# 0023 Sprache in tybo: V1 eigener ElevenLabs-Agent, V2 Sprechmodus ohne Abo

Datum: 30.09.2026. Entschieden von: Maintainer (Milestones V1 und V2,
30.09.2026), Abschnitt zur Sprach-Schnittstelle aus Issue #248.

## Zusammenhang

- `SPEC.md` schließt unter „Nicht im Umfang“ die Sprachausgabe aus. Der
  Maintainer hat den Umfang am 30.09.2026 mit zwei Milestones erweitert:
  „V1“ (Sprechen mit dem eigenen ElevenLabs-Agenten in der App) und „V2
  Sprechmodus ohne Abo“.
- Diese Entscheidung nimmt die Sprachausgabe für genau diese beiden
  Milestones von dem SPEC-Punkt aus. `SPEC.md` bleibt unverändert; die
  Ausnahme steht hier (Muster wie 0022).

## Entscheidung

- **V1 eigener ElevenLabs-Agent:** Ein Knopf „Sprechen“ in WebUI und
  Handy-App verbindet per WebRTC mit dem eigenen ElevenLabs-Agenten, der über
  die Sprach-Brücke tybos Kontext nutzt. Der Schlüssel bleibt auf dem Server
  (Conversation Token nur hinter Login), die Brücke prüft Rufnummern und von
  tybo signierte Web-Gespräche, Verlauf und Denkaufträge landen im Gespräch.
- **V2 Sprechmodus ohne Abo:** Standard für alle ohne ElevenLabs oder
  Anthropic-API, mit jedem Motor, in drei austauschbaren Stufen:
  Hören (Spracherkennung) → Denken (der gewählte Motor, Claude Code, Codex
  oder OpenCode) → Sprechen (Sprachausgabe). Pausenerkennung im Browser,
  Vorlesen, Antippen unterbricht, derselbe Knopf wie V1.
- **Kein Advanced Voice Mode**, also kein Sprach-zu-Sprach-Modell ohne
  Motor dazwischen.

## Standardwahl

- **Hören:** lokal Parakeet TDT 0.6B v3. Deutsch im Open ASR Leaderboard
  (Stand 25.09.2026): FLEURS 4,16 % und Common Voice 4,07 % Wortfehlerrate,
  gleichauf mit Whisper large-v3 bei einem Viertel der Größe. Lizenz
  CC-BY-4.0.
- **Sprechen:** die Browser-Stimme. Optional lokal Kyutai Pocket TTS (Deutsch
  seit 21.04.2026, Code MIT, Gewichte CC-BY-4.0) und ElevenLabs mit eigenem
  Schlüssel.

## Sprach-Schnittstelle (Issue #248)

- Hören und Sprechen sind Anbieter hinter zwei Schnittstellen in
  `src/lib/speech/` (`SttProvider`, `TtsProvider`), einzeln wählbar in
  `config/settings.json` (Abschnitt `speech`: `stt`, `tts`, `language`) und
  in der WebUI (Reiter „Sprechen“). Vorrang wie bei allen Einstellungen:
  Datei vor `.env` (`SPEECH_STT`, `SPEECH_TTS`) vor Code (`auto`).
- `auto` beim Hören probiert Parakeet, whisper.cpp, ElevenLabs und Gemini in
  dieser Reihenfolge; nicht verfügbare werden übersprungen, Fehler und leere
  Ergebnisse schalten weiter. Eine feste Wahl nutzt nur diesen Anbieter, nie
  still einen anderen.
- Telegram-Sprachantworten und `/voice` bleiben bei den Server-Stimmen
  (Qwen3-TTS, ElevenLabs, Gemini). Die Browser-Stimme gilt für Telegram als
  `auto`, weil Telegram keine Browser-Stimme hat, und macht die Sprachausgabe
  dort nie „eingerichtet“.
- Der Sprechmodus nutzt ohne eigene Wahl die Browser-Stimme. Den Status
  liefert `GET /api/voice` als `modes.local` (nur hinter Login).
- Logs nennen Anbieter, Dauer und Ergebnis, nie Transkript, Eingabetext,
  Fehlerausgaben oder Antworttexte der Anbieter.

## Sprechmodus im Server (Issue #249)

- **Äußerung:** `POST /api/conversations/<id>/speech` (hinter Login, mit
  Origin-Prüfung) nimmt eine Aufnahme als Rohdaten an: WAV (PCM16, 16 kHz,
  mono aus dem Browser), dazu WebM/Opus, Ogg/Opus, MP3 und MP4/M4A (AAC-LC
  oder Opus). Der Typ kommt nur aus den Bytes. Grenzen: 2 MB und 60 Sekunden.
- **Gezählt wird, was weitergeht:** Für die 60 Sekunden gilt eine Regel in
  allen Formaten. Der Server zählt die Ton-Einheiten, deren Dauer im Codec
  selbst steht (WAV: Blöcke aus unkomprimiertem PCM oder Gleitkomma; Opus:
  Pakete, Dauer aus dem TOC-Byte; MP3: Frames, Länge und Dauer aus dem
  Frame-Kopf; AAC-LC: Frames zu 1024 Abtastwerten), und schreibt aus genau
  diesen Einheiten eine neue Datei: ein WAV aus Kopf, `fmt` und dem ersten
  `data`-Block, ein Ogg/Opus mit den gezählten Paketen (auch für WebM und
  für Opus im MP4, verkettete Ogg-Streams bleiben hintereinander), die
  MP3-Frames lückenlos ohne ID3 und Reste, ein M4A mit den gezählten
  AAC-Frames. Nur diese Datei geht an die Erkennung, nie der Upload. Die
  Dauer ist die Summe der Einheiten. Zeitangaben, Tabellen und Reste des
  hochgeladenen Containers (Granule-Position, Duration, Zeitstempel,
  `mvhd`, `stts`, `tfdt`, weitere `data`-Blöcke) erreichen die Erkennung
  nicht und zählen weder nach unten noch nach oben. Pre-Skip und gekürztes
  Ende bei Opus, Vor- und Nachlauf bei AAC werden nicht abgezogen, die Dauer
  ist damit eine Obergrenze (wenige Millisekunden zur vorsichtigen Seite).
- **AAC im MP4:** Ein AAC-Frame trägt keine Längenangabe, und der Container
  zeigt nicht, ob ein MP4-Sample einen oder mehrere Frames enthält. Der
  Server liest deshalb die Syntax jedes Frames bis zu seinem Ende
  (`src/web/aac-frame.ts`: Abschnitte, Skalenfaktoren, Pulse, TNS,
  Spektralwerte mit den Huffman-Codebüchern aus ISO/IEC 14496-3), ohne
  Abtastwerte zu berechnen. Ein Sample zählt nur, wenn es genau ein Frame
  ist; steht ein zweiter Frame oder ein Rest dahinter, ist die Aufnahme
  nicht bestimmbar. Weiter geht je Frame nur sein Kanal-Element mit der
  Ende-Kennung. Füll- und Datenelemente (SBR, Dynamik, Encoder-Vermerk)
  bleiben zurück, weil der Server ihren Inhalt nicht liest: HE-AAC mit
  AAC-LC-Kern kommt als dieser Kern an. Vom Container liest der Server nur,
  wo die Samples liegen (`stsz`, `stsc`, `stco`, `trun`).
- **Nicht bestimmbar, also abgelehnt statt geraten** (400 `dauer-unbekannt`,
  vor der Erkennung): komprimierte Codecs im WAV wie ADPCM, WebM oder Ogg mit
  einem anderen Codec als Opus, ungültige Opus-Pakete, abgeschnittene
  Dateien, MP4 mit einem anderen Codec als AAC-LC oder Opus (ALAC, MP3,
  AAC Main, SBR als eigener Objekttyp, 960 Abtastwerte je Frame, mehr als
  zwei Kanäle), mit mehr als einer Spur, mit einem Sample, das nicht genau
  ein Frame ist, oder mit Samples, die sich überlappen oder außerhalb der
  Datei liegen. Der Browser schickt WAV.
- **Erkennung:** `speech.stt` hat 30 Sekunden für alle Anbieter zusammen;
  danach bricht ein Signal die Arbeit ab, und ein spätes Ergebnis startet
  keinen Turn mehr. Antwort `202 { transcript, messageId }`, die Antwort des
  Agenten kommt über die Ereignisse des Gesprächs.
- **Fehler** tragen `reason`: `beschaeftigt` (409), `nichts-verstanden` (422:
  leer, unter zwei Buchstaben oder Ziffern, nur Verzögerungslaute wie „äh“
  oder nur Geräusch-Anmerkungen in Klammern; auch wenn der Anbieter selbst
  leeren Text liefert, was `recognize()` als Grund `empty` vom technischen
  Fehler `failed` trennt), `zu-gross` und `zu-lang` (413),
  `format` (415), `dauer-unbekannt` und `leer` (400), `kein-anbieter` (503),
  `erkennung-fehlgeschlagen` (502), `zeitlimit` (504). Ein Platzhaltertext der
  Erkennung wird nie zur Nachricht.
- **Wie eine getippte Nachricht:** derselbe Weg, dieselbe Warteschlange,
  Spiegelung nach Telegram, Agent und Motor des Gesprächs. Die
  Nutzernachricht ist der erkannte Text mit `source: "speech"`. Gesprochenes
  ist nie ein Befehl: ein erkannter Text, der mit „/“ beginnt, geht als Text
  an den Motor.
- **Beschäftigt statt stapeln:** Läuft im Gespräch schon etwas (Turn im
  Browser, Turn aus Telegram über den gemeinsamen Ausführungsschlüssel, eine
  andere Äußerung in der Erkennung), antwortet die Route mit 409, vor und
  noch einmal nach der Erkennung. Die letzte Prüfung reserviert im selben
  Schritt den Platz des Sprech-Turns in der gemeinsamen Warteschlange des
  Gesprächs (`reserveExecution` mit Ausführungsschlüssel und Agent), bis der
  Sprech-Turn fertig ist: Ein Turn aus Telegram, der davor begann, ergibt
  409; einer, der danach beginnt, wartet hinter dem Sprech-Turn, auch wenn
  dieser seine Nachricht noch ablegt oder spiegelt und den Motor erst später
  aufruft. Der Sprech-Turn übernimmt den reservierten Platz, statt sich
  hinten anzustellen. Zwischen Prüfung und Belegung liegt kein Zeitfenster
  mehr, und ein angenommener Sprech-Turn steht nie hinter einem späteren
  Telegram-Turn.
- **Audio wird nicht aufbewahrt:** Es lebt nur im Speicher der Anfrage.
  whisper.cpp braucht eine Temp-Datei, die nach jedem Lauf gelöscht wird,
  auch nach Fehler und Zeitlimit. Logs nennen nie den erkannten Text.
- **Hinweis an den Motor:** `TurnOptions.turnHint` hängt an jedem Prompt des
  Turns (voll, fortgesetzt, neuer Versuch, Wechsel auf Claude Code, Frage an
  die Fallback-Kette), nie an der gespeicherten Nachricht.
- **Vorlesbare Fassung:** Antworten auf Sprech-Turns tragen im API-Format
  `speakable` und `speakSegments`, berechnet aus dem Text (im Speicher steht
  nur die Markierung `speech`). Tabellen und Codeblöcke werden durch je einen
  Satz ersetzt, Links behalten nur ihren Text, höchstens 2.000 Zeichen samt
  „Der Rest steht im Chat.“. Segmente sind Sätze bis 600 Zeichen; sehr kurze
  Sätze teilen sich ein Segment.
- **Vorlesen:** `POST /api/speech/tts` mit `{ text, voice? }`, höchstens 600
  Zeichen, liefert WAV, Ogg oder MP3 des gewählten serverseitigen Anbieters
  (`speech.tts`), nie zwischengespeichert. Mit der Browser-Stimme (auch bei
  `auto`) 409 mit `reason: "browser"`. Rate-Limit: 120 Aufrufe in 10 Minuten
  für den ganzen Server (gleitendes Fenster, alle Sitzungen zusammen, weil
  alle denselben Anbieter treffen), danach 429 mit `Retry-After`. `voice`
  gilt nur für diesen Aufruf und besteht aus Buchstaben, Ziffern, `_` und `-`.
- **Kennzeichnung:** Erzeugte WAV-Dateien tragen im `LIST/INFO`-Block den
  Hinweis „KI-generiert (tybo)“ (Feld `ICMT`, dazu `ISFT`), als
  maschinenlesbare Kennzeichnung nach Art. 50 Abs. 2 KI-Verordnung, soweit
  das Format es erlaubt. Ogg und MP3 der Anbieter bleiben unverändert.
- **Modell für gesprochene Fragen:** `speech.model` (leer = wie das Gespräch)
  und `speech.effort` (Standard medium) gelten nur für Sprech-Turns. Beim
  Motor Claude läuft der Turn mit diesem Modell in derselben Session weiter;
  die Session bleibt unter dem Modell des Gesprächs gespeichert, getippte
  Turns laufen unverändert. Bei Codex und OpenCode gilt der Wert als
  Modellname dieses Motors, die Stufe des Motors bleibt. Ob ein Modell zum
  Motor passt, entscheidet die Form des Namens (Claude-Namen, `<anbieter>/<modell>`
  für OpenCode, alles andere Codex), weil es keine gemeinsame Modell-Liste
  gibt. Passt es nicht, antwortet das Modell des Gesprächs, und ein Hinweis
  erscheint einmal je Gespräch, Motor und Modell (bis zum nächsten Neustart).

## Sprechmodus im Browser (Issue #250)

- **Eigene Pausenerkennung, keine Abhängigkeit:** Ein AudioWorklet
  (`src/web/public/speech-worklet.js`) mischt zu Mono, rechnet von der Rate
  des Geräts auf 16 kHz um und wertet 20-ms-Blöcke aus: Sprechbeginn nach
  150 ms über einer mitlaufenden Rauschschwelle, Ende nach 800 ms Pause (pro
  Gerät 500, 800 oder 1.300), 300 ms Vorlauf, unter 300 ms Sprechzeit
  verworfen. Die Rauschschätzung lernt ausschließlich aus Blöcken ohne
  Sprache, also aus Blöcken unter der Schwelle; ein Block über der Schwelle
  verändert sie nie. Das gilt auch direkt nach dem Öffnen des Mikrofons:
  Die ersten zehn stillen Blöcke setzen die Schätzung in einem Schritt,
  Sprache davor wird mit der Anfangsschwelle erkannt und zählt voll zur
  Sprechzeit. Wer sofort losspricht, wird also gehört. So bleibt leise, anhaltende Sprache ohne Lücken eine
  Äußerung bis zur Pause. Rauschen, das allmählich lauter wird, bleibt unter
  der mitwachsenden Schwelle und wird gelernt. Die Kehrseite: Ein Geräusch,
  das auf einen Schlag über der Schwelle liegt (ein Lüfter, der anläuft),
  zählt als Sprache, bis es endet oder die 58-Sekunden-Grenze die Äußerung
  schließt.
- **58 Sekunden:** Die WAV enthält Vorlauf, Sprache und höchstens 200 ms der
  Endpause und ist nie länger als 58 Sekunden (928.000 Werte). Das liegt
  sicher unter den 60 Sekunden und 2 MB des Servers, die die ganze Datei
  zählen. Wird beim Sprechen die Grenze erreicht, wird die Äußerung dort
  geschlossen und gesendet, mit Hinweis.
- **Beschäftigt heißt verwerfen:** Bei 409 mit `reason: "beschaeftigt"` ist
  die Aufnahme weg. Sie wird nie aufbewahrt und nie später gesendet. Dasselbe
  gilt, wenn die Antwort auf den Upload verloren geht: nie ein zweiter
  Versuch, der Turn könnte schon laufen.
- **Beschäftigt-Abfrage:** `GET /api/conversations/<id>/speech` liefert
  `{ busy }` aus derselben Prüfung wie die POST-Route (laufende Erkennung,
  ChatHub, Ausführungsschlüssel für Turns aus Telegram), nur lesend. Für
  Turns aus Telegram und fremde Erkennungen gibt es kein Ereignis; der
  Browser fragt deshalb im Zustand „Wartet" alle 2 Sekunden und sofort bei
  einem Abschlussereignis. Nach 2 Minuten ohne freies Gespräch pausiert der
  Modus. 409 mit `closed` (geschlossenes Topic) wartet nicht, sondern endet
  mit Fehler.
- **Welche Antwort vorgelesen wird:** nur die erste Nachricht mit
  `speakable` hinter der eigenen Nachricht (`messageId` aus der 202), genau
  einmal, gleich ob sie als Ereignis oder über den Abgleich kommt. Die Suche
  endet an einer Fehlermeldung und an einer fremden gesprochenen Nachricht.
  „Keine Antwort" gilt erst, wenn kein Turn mehr läuft und der Verlauf nach
  der Annahme erfolgreich abgeglichen wurde; ein Abriss der Live-Verbindung
  ist kein Turn-Fehler.
- **Kein stiller Stimmwechsel:** Fällt die Server-Stimme aus (429, 502, 503,
  Netz), steht „Vorlesen fehlgeschlagen. Die Antwort steht im Verlauf.", und
  der Modus hört wieder zu. Er wechselt nicht von sich aus auf die
  Browser-Stimme. Einzige Ausnahme ist 409 mit `reason: "browser"`: dann hat
  der Nutzer die Browser-Stimme inzwischen selbst gewählt.
- **Mikrofon stumm beim Vorlesen, Kopfhörer-Einstellung:** Über Lautsprecher
  würde der Modus die eigene Antwort hören. Während „Spricht" ist das
  Mikrofon deshalb stumm, unterbrochen wird per Tipp. Nur mit der
  Geräte-Einstellung „Mit Kopfhörer: per Stimme unterbrechen" (Standard aus)
  bleibt es offen, mit strengerem Sprechbeginn (300 ms); erkannte Sprache
  stoppt die Ausgabe, und die begonnene Äußerung wird samt Vorlauf
  übernommen und gesendet. Ob ein Kopfhörer steckt, prüft tybo nicht.
- **Einstellungen pro Gerät** (Pause, Stimme, Tempo, Kopfhörer) liegen nur in
  `localStorage` des Browsers, getrennt von den globalen
  `speech`-Einstellungen, und gehen nie an den Server.
- **Späte Ergebnisse:** Jede Sitzung und jede Äußerung trägt eine
  Laufnummer. Mikrofon, Worklet, Upload, Sprachausgabe, Wake Lock und
  Zeitgeber, die nach Unterbrechen, Pause oder Auflegen noch etwas liefern,
  starten weder Aufnahme noch Ausgabe und fassen auch die Zeitgeber einer
  neuen Ausgabe nicht an. Wer beim Denken „Antwort abbrechen?" bestätigt,
  bekommt die Antwort dieses Turns nie vorgelesen, auch wenn sie den Abbruch
  überholt; sie steht im Verlauf. Auflegen bricht einen laufenden Turn
  nicht ab; seine Antwort steht im Verlauf und wird nicht vorgelesen. Auch
  das Öffnen der Einstellungen legt auf, damit kein Mikrofon unsichtbar
  offen bleibt.
- **Modi als Liste:** Der Knopf liest die bereiten Modi aus `modes` von
  `GET /api/voice` (heute nur `local`). Die Auswahl zwischen zwei Modi und
  `modes.agent` gehören zu V1 (#244, #245).

## Eigene Stimme (Issue #253)

- **Optional, nur im Sprechmodus der WebUI:** Eine geklonte Stimme liest
  nur dort vor (`speech.tts = clone` mit `speech.cloneVoice`). Telegram,
  `/voice`, Telefonate und ElevenLabs übernehmen sie nie: Für Telegram gilt
  bei `clone` die Wahl von vor „Verwenden“ (`speech.telegramTts`, ohne sie
  `SPEECH_TTS` bzw. `auto`). Löschen der gewählten Stimme stellt diese Wahl
  wieder als `speech.tts` her. Keine Stimme aus Telegram, aus Dateien
  oder Videos.
- **Einwilligung in tybo:** Pflicht-Häkchen mit festem Wortlaut; ohne es
  öffnet die WebUI das Mikrofon nicht, und der Server nimmt eine Aufnahme nur
  mit `consent=ja` an (sonst 400, nichts abgelegt). Abgelegt wird
  `consent.json` mit Wortlaut, Zeitpunkt und grob dem Gerät. Ohne gültige
  Einwilligung gibt es die Stimme nicht: keine Probe, keine Auswahl, kein
  Vorlesen. Die Freischaltung bei Hugging Face ersetzt diese Einwilligung
  nicht.
- **Aufnahme statt Upload:** Die WebUI nimmt auf, wandelt in WAV (PCM 16
  Bit, mono, 24 kHz) und schickt nur das als `audio/wav`. Formular-Uploads
  und andere Typen weist der Server ab, Aufrufe aus dem Terminal auch. Der
  Server kann Aufnahme-Bytes nicht von gleichen Datei-Bytes unterscheiden;
  geprüft wird deshalb, was prüfbar ist: kein Dateidialog, kein Ziehen,
  kein Mikrofon ohne Häkchen, kein Speichern ohne Einwilligung. Dauer 5 bis
  30 Sekunden, höchstens 3 MB; die Referenz schreibt der Server neu (nur
  Kopf und Abtastwerte).
- **Ablage:** `data/speech/voices/<id>/` (Kennung vom Server, 16 Hex-Zeichen,
  Ordner 0700, Dateien 0600) mit `reference.wav`, `text.txt`,
  `consent.json`, `meta.json`; höchstens zehn Stimmen. Löschen entfernt den
  Ordner samt Abgeleitetem, beendet einen Pocket-Prozess mit dieser Stimme
  und hebt die Auswahl auf (danach Browser-Stimme).
- **Klon-Engines** (eingerichtet mit `tybo setup sprache`, Download erst
  nach Bestätigung mit Größe): Pocket TTS mit den gated Klon-Gewichten
  (`kyutai/pocket-tts`, feste Revision), nach ausdrücklicher Zustimmung zu
  Kyutais Bedingungen und mit einem Hugging-Face-Token nur für diesen Lauf
  (nie gespeichert, nur als `HF_TOKEN` in der Umgebung des Downloads);
  Qwen3-TTS Base über mlx-audio 0.5.7 auf dem Mac mit Apple Silicon (feste
  Revision, offline aus dem eigenen Ordner). Der Pocket-Wächter nimmt für
  eigene Stimmen nur `--clone-dir` und eine geprüfte Kennung, keine
  Symlinks, und endet ohne geladene Klon-Gewichte mit Exit-Code 3. Wahl der
  Engine: `speech.cloneEngine`, wenn eingerichtet, sonst die erste
  eingerichtete.
- **Kennzeichnung:** WAV einer geklonten Stimme tragen im `ICMT` beide
  Hinweise: „KI-generiert (tybo), geklonte Stimme". Die eigene Stimme
  liefert nur WAV, sonst gilt die Ausgabe als gescheitert. Die Metadaten
  sind keine Garantie für alle Transparenzpflichten nach Art. 50; ein
  Wasserzeichen im Ton gehört nicht zu diesem Issue.
- **Routen** (angemeldet, schreibend mit Origin-Prüfung): `GET` und `POST
  /api/speech/voices`, `POST /api/speech/voices/<id>/probe` (zählt gegen
  das Rate-Limit der Sprachausgabe), `POST /api/speech/voices/<id>/use`,
  `DELETE /api/speech/voices/<id>`. Logs nennen nie Namen oder Inhalte.
