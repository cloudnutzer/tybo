# Mit tybo sprechen

tybo kann zuhören und vorlesen. Diese Seite beschreibt zwei Wege im Browser:
den **Sprechmodus ohne Abo** (jede Frage ein voller Turn, mit jedem Motor:
Claude Code, Codex, OpenCode) und den **Telefonhörer** (ein flüssiges Gespräch
mit kurzen Antworten, weiter unten). Den dritten Weg, das Gespräch mit einem
eigenen ElevenLabs-Agenten, beschreibt ein eigener Abschnitt, sobald er
fertig ist (Entscheidung 0023, Milestone V1).

| | Sprechmodus | Telefonhörer | Telefon über einen ElevenLabs-Agenten |
| --- | --- | --- | --- |
| Was es ist | jede Frage ist ein voller Turn mit allen Werkzeugen (Websuche, Dateien, MCP) | schnelles Gespräch mit schlankem Kontext; Arbeit, die Zeit braucht, geht als Denkauftrag ins Gespräch | eigener Aufbau mit Brücke und Telefonnummer, siehe `src/voice-bridge.ts` |
| Wartezeit | so lange wie ein getippter Turn, oft 5 Sekunden und mehr | rund 2 bis 3 Sekunden bis zum ersten Ton | wie der Telefonhörer (gleiches Gehirn) |
| Braucht | lokales Hören oder einen Cloud-Erkenner | lokales Hören, einen Modellweg (API-Schlüssel, Claude-Abo, OpenRouter oder Ollama), HTTPS fürs Handy | ElevenLabs-Konto, Twilio-Nummer |

## Empfohlen: der private Weg

Für Sprechmodus und Telefonhörer empfiehlt tybo den lokalen Weg: Hören mit
**Parakeet**, Sprechen mit **Pocket TTS und der deutschen Stimme „Jürgen“**
(`juergen`, Kyutai, CC-BY-4.0). `tybo setup sprache` richtet beides ein (Weg
„Sprechmodus lokal“, Stimme „Lokale Stimme Jürgen“). Aufnahme und
vorgelesener Text bleiben auf deinem Rechner; nur das Denken läuft wie bei
jeder getippten Nachricht über den gewählten Motor. Kosten pro Minute fallen
keine an. Der Telefonhörer übernimmt diesen Weg ohne weitere Einstellung:
Erkennen und Stimme im Gespräch stehen auf „Automatisch“, also lokal.

ElevenLabs (Stimme und Erkenner Scribe) ist die optionale Cloud-Stufe: eine
große Auswahl an Stimmen und etwas schnelleres Erkennen, dafür kostet jedes
gesprochene Zeichen bzw. jede Minute Aufnahme Guthaben, und Antworttext bzw.
Aufnahme gehen an ElevenLabs. Siehe „Stimme von ElevenLabs“ und „Erkennen
mit ElevenLabs Scribe“ beim Telefonhörer.

## Sprechmodus ohne Abo

### Was du brauchst

Nichts außer tybo mit eingeschalteter WebUI. Ohne Einrichtung hört tybo mit
whisper.cpp oder einem Cloud-Dienst, falls vorhanden, und liest mit der Stimme
des Browsers vor.

Besser und ganz lokal wird es mit zwei optionalen Bausteinen, beide über
`tybo setup sprache` (auch im Browser mit `tybo setup --web`):

- **Hören mit Parakeet** (NVIDIA Parakeet TDT 0.6B v3): erkennt Deutsch so gut
  wie Whisper large-v3, braucht aber nur ein Viertel davon. Download rund
  500 MB.
- **Vorlesen mit einer lokalen Stimme** (Kyutai Pocket TTS, deutsche Stimme
  „juergen“): klingt auf allen Geräten gleich, nicht wie die jeweilige
  Browser-Stimme. Download rund 170 MB (Mac) bzw. 250 MB (Linux) für die
  Laufzeit plus rund 220 MB Modell, auf der Platte danach rund 1,2 GB.

Auf schwachen Rechnern, etwa einem Raspberry Pi, misst `tybo setup sprache`
nach der Installation, wie schnell Pocket TTS dort vorliest. Ist es langsamer
als Echtzeit, schlägt der Schritt **Piper** vor (Stimme Thorsten, rund 60 MB
Laufzeit plus 63 MB Stimme). Mit ElevenLabs-Schlüssel und
`ELEVENLABS_VOICE_ID` ist auch deren Stimme wählbar, als optionale
Cloud-Variante: jeder vorzulesende Satz geht als Text an ElevenLabs und
kostet Guthaben.

Welche Stimme gerade vorliest, steht in der WebUI unter Einstellungen, Reiter
„Sprechen“. Dort lässt sie sich auch umstellen, ohne Neustart.

### Wie es sich anfühlt

1. Im Gespräch auf „Mit tybo sprechen“ tippen und das Mikrofon freigeben.
2. Sprechen. Nach einer kurzen Pause (normal 0,8 Sekunden, pro Gerät
   einstellbar) schickt tybo das Gesagte ab. Im Verlauf steht es wie eine
   getippte Nachricht.
3. Der Motor denkt wie bei jeder Nachricht, mit allen Werkzeugen.
4. tybo liest die Antwort vor. Tabellen und Code liest es nicht vor, sie
   stehen im Verlauf.
5. Danach hört es wieder zu. Antippen unterbricht das Vorlesen.

Während tybo vorliest, ist das Mikrofon stumm, damit es über den Lautsprecher
nicht die eigene Antwort hört. Mit Kopfhörer lässt sich pro Gerät einstellen,
dass man per Stimme unterbrechen kann.

**Das ist kein Advanced Voice Mode.** Es gibt kein Sprach-zu-Sprach-Modell und
kein Gespräch, bei dem man sich gegenseitig ins Wort fällt. Jede Äußerung ist
ein eigener Turn: hören, denken, vorlesen. Über Lautsprecher kann man tybo
nicht per Stimme unterbrechen, nur per Tippen.

### Wie lange es dauert

Die Wartezeit hat drei Teile. Fast immer bestimmt der mittlere sie.

| Stufe | Wartezeit | Quelle |
| --- | --- | --- |
| Hören mit Parakeet | ca. 0,3 Sekunden für 10 bis 18 Sekunden Sprache | Praxistest 30.09.2026, Mac mit Apple M4 und 24 GB |
| Denken (Motor) | so lange wie ein getippter Turn mit diesem Motor: meist mehrere Sekunden, mit Werkzeugen (Websuche, Dateien) deutlich länger | |
| Vorlesen mit Browser-Stimme | beginnt sofort | |
| Vorlesen mit Pocket TTS, erster Satz nach mehr als 10 Minuten ohne Vorlesen | ca. 2,5 bis 5 Sekunden, bis er zu hören ist (Stimme starten, Modell laden, Satz erzeugen) | Messung 01.10.2026, gleiches Gerät, siehe unten |
| Vorlesen mit Pocket TTS, sonst | ca. 0,2 bis 1 Sekunde, bis der erste Satz zu hören ist; die weiteren erzeugt tybo, während der vorige läuft | Messung 01.10.2026, gleiches Gerät |

Zu Pocket TTS genauer:

- **Das Modell selbst** ist schnell: Im Praxistest vom 30.09.2026 (Mac mit
  Apple M4 und 24 GB, pocket-tts 3.3.0, Deutsch 6 Schichten, nur CPU) brauchte
  es für 10,5 Sekunden Ton 1,07 Sekunden Rechenzeit (RTF 0,10), Laden
  0,5 Sekunden, 1,03 GB Arbeitsspeicher. Im Streaming kam der erste Ton nach
  0,03 Sekunden.
- **Im Sprechmodus** wartet tybo heute auf den ganzen Satz, bevor der Browser
  ihn abspielt (kein Streaming). Der erste Ton nach 0,03 Sekunden aus dem
  Praxistest gilt hier also nicht. Gemessen am 01.10.2026 auf demselben Mac,
  zeitweise durch andere Programme ausgelastet:
  - im Sprechmodus des Browsers (Headless-Chrome, echte Pocket-Stimme,
    `scripts/web-sprechmodus-check.ts --pocket`): von der fertigen Antwort bis
    zum ersten hörbaren Satz 5,3 Sekunden mit Kaltstart; die beiden folgenden
    Sätze (76 und 68 Zeichen) waren nach 1,0 und 0,6 Sekunden fertig, während
    der erste noch lief.
  - direkt über `POST /api/speech/tts` bei mäßiger Last: erster Satz
    2,4 Sekunden mit Kaltstart, danach 0,66 Sekunden für 80 Zeichen
    (6 Sekunden Ton), 0,36 Sekunden für 51 Zeichen und 0,20 Sekunden für
    15 Zeichen. Unter starker Last 4,6, 1,1, 0,5 und 0,3 Sekunden.
  - in der Probe von `tybo setup sprache`: Modell laden 2,0 Sekunden, RTF 0,16
    bei mäßiger Last; unter starker Last 9,0 Sekunden und RTF 0,63.
- Die Stimme läuft als eigener Prozess, den tybo beim ersten Vorlesen startet
  und nach 10 Minuten ohne Vorlesen wieder beendet. Nach einer längeren Pause
  kommt der erste Satz deshalb langsamer.
- **Auf dem Raspberry Pi** ist alles deutlich langsamer, Messwerte von dort
  gibt es noch nicht. Ist Pocket dort langsamer als Echtzeit, ist Piper die
  bessere Wahl.

Piper startet bei jedem Satz neu und braucht damit auf dem Mac rund 0,8 bis 4
Sekunden je Satz samt Laden (gemessen 01.10.2026, unter Last am oberen Ende);
dafür reicht ihm wenig Arbeitsspeicher (0,38 GB im Praxistest, RTF 0,20 ohne
Laden).

### Datenschutz je Stufe

| Stufe | Lokal | Cloud |
| --- | --- | --- |
| Hören | Parakeet, whisper.cpp: die Aufnahme bleibt auf dem Rechner | ElevenLabs, Gemini: die Aufnahme geht an den Dienst |
| Denken | | der gewählte Motor wie bei jeder Nachricht (Claude, Codex, OpenCode mit seinem Anbieter) |
| Vorlesen | Browser-Stimme (auf dem Gerät, je nach Browser auch über dessen Dienst), Pocket TTS, Piper, Qwen3-TTS: der Text bleibt auf dem Rechner | ElevenLabs, Gemini: der vorzulesende Text geht an den Dienst |

Aufnahmen speichert tybo nie, Logs nennen nie das Gesagte oder den
vorgelesenen Text. Vom Server erzeugte WAV-Dateien tragen den Hinweis
„KI-generiert (tybo)“ (Kennzeichnung nach Art. 50 Abs. 2 KI-Verordnung).
Der Ton des Telefonhörers ist dagegen ein roher Strom (PCM), der nur
abgespielt und nirgends gespeichert wird; er hat keinen Dateikopf, in dem
ein solcher Hinweis stehen könnte.

### Lizenzen und Namensnennung

- **Parakeet TDT 0.6B v3** von NVIDIA, Lizenz CC-BY-4.0
  ([Modell](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)), ausgeführt
  mit sherpa-onnx (Apache-2.0).
- **Kyutai Pocket TTS**, Code MIT, Gewichte und die Stimme „juergen“ unter
  CC-BY-4.0 ([Modell ohne Stimmenklonen](https://huggingface.co/kyutai/pocket-tts-without-voice-cloning),
  [Code](https://github.com/kyutai-labs/pocket-tts)). tybo nutzt nur Stimmen
  mit belegter Lizenz CC0 oder CC-BY-4.0, nie Stimmen aus dem Ordner
  „expresso“ (CC-BY-NC-4.0, nicht kommerziell).
- **Piper** (`piper-tts` 1.8.0 aus piper1-gpl) unter GPL-3.0. tybo bettet
  Piper nicht ein, es startet das Programm als eigenen Prozess. Die Stimme
  `de_DE-thorsten-medium` stammt aus dem Datensatz Thorsten-Voice unter CC0
  ([piper-voices](https://huggingface.co/rhasspy/piper-voices)).

### Eigene Stimme (optional, nur mit Einwilligung)

Wer möchte, dass tybo im Sprechmodus mit der eigenen Stimme vorliest (oder
mit der Stimme einer Person, die es ausdrücklich erlaubt hat), kann sie lokal
klonen. Das gilt nur für den Sprechmodus der WebUI: Telegram, `/voice`,
Telefonate und ElevenLabs nutzen eine geklonte Stimme nie.

**1. Klon-Engine einrichten** mit `tybo setup sprache`, Feld „Eigene Stimme
klonen“. Geladen wird erst nach „Jetzt ausführen?“, der Plan nennt die
Größen.

- **Pocket TTS mit Stimmenklonen** (Mac mit Apple Silicon, Linux x64 und
  arm64). Braucht die lokale Stimme Pocket TTS (siehe oben). Die Gewichte
  mit Klonen (`kyutai/pocket-tts`, deutsches Modell rund 219 MB) gibt Kyutai
  nur nach Anmeldung bei Hugging Face und Zustimmung zu seinen Bedingungen
  heraus. Dafür: auf [huggingface.co/kyutai/pocket-tts](https://huggingface.co/kyutai/pocket-tts)
  anmelden, die Bedingungen lesen und akzeptieren, unter
  [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)
  einen Token mit Lesezugriff anlegen. Der Assistent fragt die Zustimmung
  noch einmal ausdrücklich ab; ohne Ja lädt er nichts. Den Token nutzt er
  nur für diesen einen Download, gespeichert wird er nirgends.
- **Qwen3-TTS Base** über mlx-audio, nur auf einem Mac mit Apple Silicon.
  Nicht gated, rund 4,5 GB Modell plus rund 120 MB Laufzeit. Bessere
  Qualität, auf einem M4 aber langsamer als Echtzeit (Praxistest 30.09.2026:
  RTF 1,34, erster Ton nach 2,3 Sekunden, 4,8 GB Arbeitsspeicher).

Nach dem Download prüft eine Probe, ob die Engine wirklich klont; erst dann
gilt sie als eingerichtet (`pocket-clone.ok.json` bzw. `qwen-clone.ok.json`
unter `models/speech/`).

**2. Stimme aufnehmen** in der WebUI: Einstellungen, Reiter „Sprechen“,
Abschnitt „Eigene Stimme“.

1. Das Häkchen setzen: „Das ist meine eigene Stimme, oder die Person hat mir
   ausdrücklich erlaubt, ihre Stimme zu klonen.“ Ohne Häkchen öffnet tybo
   das Mikrofon nicht und speichert nichts; der Server prüft die Einwilligung
   bei jedem Speichern, jeder Probe und jedem Vorlesen erneut.
2. Einen Namen geben und den angezeigten Text vorlesen (etwa 15 Sekunden,
   mindestens 5, höchstens 30). Anhören, bei Bedarf wiederholen, speichern.
   Es gibt bewusst keinen Datei-Upload: Die Stimme entsteht nur aus einer
   Aufnahme in tybo, nicht aus Dateien, Videos oder Sprachnachrichten.
3. „Probe anhören“ liest einen Testsatz mit der geklonten Stimme.
4. „Als Stimme verwenden“ stellt das Vorlesen im Sprechmodus auf diese
   Stimme. In der Auswahl heißt sie „<Name> (KI-Stimme)“. Telegram spricht
   weiter mit der bisherigen Wahl (etwa Pocket TTS oder ElevenLabs).

**Löschen** entfernt Aufnahme, Text und Einwilligung samt allem, was eine
Engine daraus abgeleitet hat. Ein laufender Pocket-Prozess mit dieser Stimme
endet. War sie gewählt, gilt danach wieder die Wahl von vor „Als Stimme
verwenden“, für den Sprechmodus wie für Telegram.

**Wo es liegt:** `data/speech/voices/<id>/` mit `reference.wav` (die
Aufnahme, vom Server neu geschrieben, ohne Metadaten des Browsers),
`text.txt`, `consent.json` (Wortlaut der Einwilligung, Zeitpunkt, grob das
Gerät wie „Safari auf iPhone“) und `meta.json`. Nur auf diesem Rechner,
Rechte nur für den eigenen Benutzer, nie in Git (`data/` ist ignoriert), nie
in Telegram.

**Kennzeichnung:** Jede WAV-Datei einer geklonten Stimme trägt im
`LIST/INFO`-Block den Kommentar „KI-generiert (tybo), geklonte Stimme“.

**Rechtslage kurz** (Stand 01.10.2026, keine Rechtsberatung):

- Die KI-Verordnung verlangt seit 02.08.2026 in Art. 50 Abs. 2, dass
  synthetische Audioinhalte maschinenlesbar als künstlich erzeugt
  gekennzeichnet sind. Die Metadaten in der WAV-Datei sind ein Teil davon,
  soweit das Format es erlaubt; ein Wasserzeichen im Ton selbst setzt tybo
  nicht, und Ogg oder MP3 anderer Anbieter bleiben ohne Kennzeichnung. Die
  Metadaten erfüllen also nicht garantiert alle Pflichten.
- Art. 3 Nr. 60 zählt Audio, das einer existierenden Person ähnelt und echt
  wirkt, zu Deepfakes; wer so etwas veröffentlicht oder weitergibt, muss nach
  Art. 50 Abs. 4 offenlegen, dass es künstlich erzeugt ist. Das bleibt
  Aufgabe dessen, der die Aufnahme nutzt.
- Die Stimme einer anderen Person ohne deren Erlaubnis zu klonen, verletzt
  deren Persönlichkeitsrechte und verstößt gegen Kyutais Bedingungen. Das
  Häkchen in tybo ist deine Bestätigung, nicht der Nachweis; die
  Freischaltung bei Hugging Face ersetzt die Einwilligung der Person nicht.

**Lizenzen:** Kyutai Pocket TTS mit Klon-Gewichten, Gewichte CC-BY-4.0
([Modell](https://huggingface.co/kyutai/pocket-tts), Zugang nach Zustimmung
zu Kyutais Bedingungen, die das Nachahmen oder Klonen von Stimmen ohne
ausdrückliche und rechtmäßige Einwilligung verbieten). Qwen3-TTS Base
Apache-2.0 ([Code](https://github.com/QwenLM/Qwen3-TTS), ausgeführt mit
mlx-audio, MIT). Modelle mit nicht kommerzieller Lizenz (F5-TTS, XTTS-v2,
OmniVoice, Fish Audio) nutzt tybo zum Klonen nicht.

### Wo was liegt

- `models/speech/`: Parakeet, Pocket TTS (`pocket/`, mit eigener
  Python-Umgebung und Modell) und Piper (`piper/`). Die Nachweise
  `parakeet.ok.json`, `pocket.ok.json` und `piper.ok.json` schreibt nur
  `tybo setup sprache` nach bestandener Probe; ohne sie gilt die Stufe als
  nicht eingerichtet.
- `models/speech/pocket-probe.wav` und `piper-probe.wav`: die Probe zum
  Anhören.
- `config/settings.json`, Abschnitt `speech`: welche Stufe gewählt ist,
  dazu `cloneVoice` (gewählte eigene Stimme), `cloneEngine` und
  `telegramTts` (die Wahl für Telegram, solange die eigene Stimme vorliest).
- `data/speech/voices/`: eigene Stimmen (siehe oben). `models/speech/qwen-clone/`:
  Qwen3-TTS Base; die Klon-Gewichte von Pocket liegen im Ordner von Pocket.
- Entfernen: `tybo deinstallieren` (auch `bun run uninstall`) fragt, ob
  `models/speech/` gelöscht werden soll.

Probleme: [troubleshooting.md](troubleshooting.md), Abschnitt „Sprechmodus:
lokale Stimme“.

## Telefonhörer

Neben „Sprechen" gibt es den Knopf „Telefonhörer" (Hörer-Symbol, „Mit tybo
telefonieren"): ein flüssiges Gespräch statt einzelner Turns, ohne ElevenLabs
und ohne Telefonnummer (Entscheidung 0024). Den Knopf gibt es nur, wenn der
Telefonhörer auf dem Rechner bereit ist und der Browser ihn kann (HTTPS oder
localhost, Mikrofon, AudioWorklet, WebSocket).

1. Antippen und das Mikrofon freigeben. Bis alles steht, heißt es
   „Verbindet …", darunter die Erwartung, etwa „Erster Satz nach rund 1,5
   Sekunden".
2. Reden. Während du sprichst, geht der Ton schon in kleinen Stücken an den
   Rechner, bei Stille geht nichts hinaus. Nach der Pause (wie im Sprechmodus
   pro Gerät eingestellt) antwortet tybo Satz für Satz.
3. Das Mikrofon bleibt offen, auch während tybo spricht. Antippen der Ansicht
   oder die Leertaste unterbricht sofort. Per Stimme unterbrechen geht nur
   mit der Stimme vom Rechner (nicht mit der Browser-Stimme) und zuverlässig
   nur mit Kopfhörer; über Lautsprecher hängt es an der Echo-Unterdrückung
   des Browsers. In Safari (auf dem iPhone ab iOS 17) meldet der Hörer
   das Gespräch als Telefonat an und spielt den Ton so ab, dass die
   Echo-Unterdrückung ihn kennen soll; zusätzlich erkennt tybo dann den
   eigenen Ton im Mikrofon wieder und zählt nur, was nicht von ihm kommt.
   Hört tybo sich trotzdem selbst, wird es strenger; nach zwei Fehlalarmen in Folge (in Safari nach vier) schaltet
   die Ansicht für dieses Gespräch auf „nur Antippen". Pro Gerät lässt sich im
   Reiter „Sprechen" unter „Telefonhörer auf diesem Gerät" auch fest „Nur
   Antippen" wählen.
4. „Stumm" schaltet das Mikrofon aus, tybo spricht weiter. „Auflegen"
   beendet das Gespräch. Ein Gesprächswechsel, Abmelden, die Einstellungen,
   Neuladen und das Schließen der Seite legen ebenfalls auf.

Reißt die Verbindung ab, versucht tybo es genau einmal neu („Verbindung
weg"), sonst steht „Aufgelegt" mit dem Grund da. Auf dem iPhone legt tybo auf,
wenn die App in den Hintergrund geht und iOS den Ton anhält.

Gemessen am 2.10.2026 auf einem Mac (Apple M4) im Browser (Headless-Chrome),
Erkennen mit Parakeet, Sprechen mit Pocket TTS, Pause „normal" (0,8 s): vom
tatsächlichen Ende der Sprache bis zum Beginn der Wiedergabe im Browser rund
2,3 Sekunden mit der Anthropic-API und rund 3,1 bis 3,5 Sekunden im Abo
(einzelne Läufe mit langsamem Modellstart länger). Davon sind 0,8 Sekunden
die eingestellte Pause; das Erkennen ist zu dem Zeitpunkt schon fertig (es
beginnt mit der Pause), den Rest braucht das Modell bis zum ersten Satz und
Pocket TTS bis zum ersten Ton (rund 0,05 Sekunden). Dazu kommt die
Ausgabelatenz des Geräts (am Mac rund 0,04 Sekunden).

### Was du brauchst

- **Lokales Hören:** Parakeet (empfohlen) oder whisper.cpp, eingerichtet mit
  `tybo setup sprache`, Weg „Sprechmodus lokal“. Cloud-Erkennung nutzt der
  Telefonhörer nur, wenn du sie ausdrücklich wählst: unter Einstellungen,
  Sprechen, Telefonhörer, „Erkennen im Gespräch“ **ElevenLabs Scribe**
  (siehe „Erkennen mit ElevenLabs Scribe“ unten).
- **Stimme:** Pocket TTS empfohlen (gleicher Schritt, Stimme „Lokale Stimme“).
  Ohne sie spricht die Browser-Stimme; ins Wort fallen geht dann nur per
  Antippen. Piper geht auch, ist aber langsamer (ein Prozess je Satz).
  Wer eine natürlichere Stimme will, wählt unter Einstellungen, Sprechen,
  Telefonhörer, „Stimme im Gespräch“ **ElevenLabs** (braucht
  `ELEVENLABS_API_KEY`, siehe „Stimme von ElevenLabs“ unten).
- **Ein Modellweg** für das Gehirn im Gespräch, Standard
  `claude:claude-sonnet-5-5`:
  - API-Schlüssel `VOICE_ANTHROPIC_API_KEY`: gleichmäßig, kostet pro Turn.
  - Claude-Abo über Claude Code (offene Sitzung, `--safe-mode`): keine
    Zusatzkosten außer dem Agent-SDK-Guthaben des Abos, einzelne Antworten
    langsamer. Steht `ANTHROPIC_API_KEY` in der `.env`, läuft auch die CLI
    über die API und kostet nach Verbrauch.
  - OpenRouter (`OPENROUTER_API_KEY`) oder Ollama auf diesem Rechner.
  Ohne bereiten Weg gibt es keinen Knopf, und es bleibt beim Sprechmodus.
- **HTTPS fürs Handy:** Das Mikrofon gibt der Browser nur in einem sicheren
  Kontext frei (`tybo setup zugang`, siehe
  [webui/fernzugang.md](webui/fernzugang.md)). Am Rechner selbst reicht
  `http://localhost`.

Einrichten und messen: `tybo setup sprache`, Weg „Telefonhörer“ (Terminal
oder `tybo setup --web`). Der Schritt prüft die Voraussetzungen, erklärt die
Wege, misst den gewählten Weg auf diesem Gerät und speichert ihn
(`speech.call.model`, bei Claude dazu `speech.call.claudeVia`). In der WebUI
steht dasselbe unter Einstellungen, Sprechen, Telefonhörer: Stand mit Grund
und nächstem Schritt, Auswahl des Modells, ein freies Feld im Format
`<claude|openrouter|ollama>:<modell>` und der Knopf „Probe“ (höchstens drei
Proben in zehn Minuten). „Automatisch“ speichert `auto`, „Standard“ entfernt
den eigenen Wert.

### Ehrliche Erwartung

**Das ist kein Advanced Voice Mode.** Advanced Voice Mode antwortet in unter
einer Sekunde, beide Seiten fallen sich ins Wort. Der Telefonhörer fühlt sich
eher wie ein Telefonat mit kurzer Denkpause an: rund 2 bis 3 Sekunden vom Ende
deines Satzes bis zum ersten Ton.

Zwei Messungen, getrennt:

- **Planung (30.09.2026):** nur das Gehirn, von „Text liegt vor“ bis „erster
  vollständiger Satz der Antwort ist da“, auf einem Mac mit Apple M4 und
  24 GB, macOS 26.7, Glasfaser, Bun 1.3.10, Claude Code CLI 2.1.283. Kontext:
  der echte Prompt des General-Agenten mit einem erfundenen Profil, zusammen
  rund 14.000 Zeichen. Je Variante 12 Läufe (vier Fragen, je drei Mal), Zeiten
  in Sekunden als Median (kleinster bis größter Wert). Messdatei beim
  Maintainer.
- **Gebaut (02.10.2026):** Ende der Sprache bis zum Beginn der Wiedergabe im
  Browser, siehe den Absatz über diesem Abschnitt (rund 2,3 Sekunden mit der
  Anthropic-API, rund 3,1 bis 3,5 Sekunden im Abo).

**Weg A: Anthropic Messages API direkt** (`VOICE_ANTHROPIC_API_KEY`)

| Variante | erster Satz |
| --- | --- |
| `claude-sonnet-5-5`, effort medium | 1,40 (1,23 bis 1,74) |
| `claude-sonnet-5-5`, effort low | 1,44 (1,11 bis 1,94) |
| `claude-sonnet-5-5` mit Prompt-Caching | 1,40 (1,22 bis 1,73) |
| `claude-haiku-4-5` | 1,27 (0,75 bis 1,74) |

**Weg B: Claude Code im Abo** (kein API-Schlüssel)

| Variante | erster Satz |
| --- | --- |
| `claude -p` pro Turn, Sonnet 5.5 low (ab Prozessstart) | 2,04 (1,50 bis 2,67) |
| offene Sitzung, Sonnet 5.5 low, 60 Turns | 1,46 (0,85 bis 4,72) |
| offene Sitzung, Haiku 4.5 ohne Denken | 1,17 (0,77 bis 1,48) |
| zum Vergleich: ein normaler tybo-Turn mit Claude Code (alle MCP-Server und Werkzeuge) | 4,40 (3,68 bis 4,82) |

In der offenen Sitzung hat Sonnet 5.5 in 14 von 60 Turns vor der Antwort
nachgedacht, dann kam der erste Satz erst nach 2,4 bis 4,7 Sekunden. Das ließ
sich mit keinem getesteten Schalter abstellen. tybo nutzt die offene Sitzung
(sie startet beim Abheben, nicht je Turn).

**Weg C: OpenRouter und Ollama**

| Variante | erster Satz |
| --- | --- |
| OpenRouter, `anthropic/claude-sonnet-5.5` ohne Angabe zum Vordenken | 7,19 (2,73 bis 9,35) |
| OpenRouter, `anthropic/claude-sonnet-5.5` mit `reasoning: { effort: "low" }` (so nutzt es tybo) | 1,61 (1,12 bis 2,23) |
| OpenRouter, Modelle ohne Denkphase (`mistralai/mistral-medium-3.1`, `openai/gpt-4.1-mini`) | 0,78 bis 1,06, rechnen aber falsch |
| Ollama `qwen3:8b` ohne Denken | 3,20 (1,11 bis 5,50) |
| Ollama `qwen3:8b` mit Denken | über eine Minute |

**Geschätzte Gesamtzeit: Ende der Äußerung bis erster Ton** (Planung,
30.09.2026). Summe aus Sprechpause (0,8 Sekunden, Standard), Erkennen
(0,3 Sekunden mit Parakeet über MLX, nicht über das gebaute sherpa-onnx
gemessen), Gehirn (oben) und erstem Ton (0,1 Sekunden mit Pocket TTS im
Streaming). Mobilfunk, Raspberry Pi und die Browser-Stimme sind nicht
enthalten.

| Weg | Ende der Äußerung bis erster Ton | Urteil |
| --- | --- | --- |
| API direkt, Sonnet 5.5 | 2,6 s (2,3 bis 3,1) | flüssig, gleichmäßig |
| Abo, offene Sitzung, Sonnet 5.5 low | 2,7 s (2,1 bis 5,9), in rund jedem vierten Turn 3,6 bis 5,9 | flüssig mit Ausreißern |
| OpenRouter, Sonnet 5.5 mit wenig Vordenken | 2,8 s (2,3 bis 3,4) | flüssig |
| Ollama `qwen3:8b` ohne Denken | 4,4 s (2,3 bis 6,7) | zäh |
| zum Vergleich: Sprechmodus mit Claude Code | 5,6 s und mehr | langsam, dafür volle Kraft |

Mit Pause „kurz“ (0,5 Sekunden) und dem Erkennen schon während der Pause sind
rund 2 Sekunden erreichbar, darunter geht es mit diesem Aufbau nicht. Die
Probe in der WebUI und in `tybo setup sprache` misst auf deinem Gerät, wann
die Antwort beginnt (erster sprechbarer Abschnitt, kann ein Teilsatz sein),
und ordnet ein: bis 2 Sekunden „flüssig“, bis 4 Sekunden „geht“, darüber
„zäh“.

### Grenzen gegenüber ElevenLabs

- **Ende der Äußerung:** tybo erkennt es an der Pause, nicht am Sinn. Wer beim
  Nachdenken stockt, bekommt manchmal schon eine Antwort. Abhilfe: im Reiter
  „Sprechen“ die Sprechpause auf „lang“ stellen.
- **Ins Wort fallen per Stimme** ist über Lautsprecher unzuverlässig (der
  Browser muss das eigene Echo herausrechnen), mit Kopfhörer gut. Antippen
  geht immer.
- **Eine deutsche Stimme:** Pocket TTS spricht standardmäßig mit „juergen“;
  daneben gibt es Piper (Thorsten) und die Browser-Stimme, aber keine Auswahl
  vieler Stimmen wie bei ElevenLabs.
- **Im Abo** kommen einzelne Antworten erst nach 3 bis 5 Sekunden, wenn das
  Modell vor der Antwort nachdenkt.
- **Zahlen** rechnet tybo mit dem Rechenwerkzeug, nicht im Kopf: in der
  Messung lagen Modelle beim Kopfrechnen mit ausgeschriebenen Zahlen oft
  daneben.

### Kosten je Weg

Belegte Preise (platform.claude.com/docs/en/about-claude/pricing, abgerufen
30.09.2026): Sonnet 5.5 kostet 2 $ pro Million Eingabe-Token, 10 $ Ausgabe,
0,20 $ Cache-Lesen. Ein Turn hatte in der Messung rund 7.100 Eingabe- und
226 Ausgabe-Token.

| Weg | pro Turn | pro Gesprächsminute (2 bis 4 Turns) |
| --- | --- | --- |
| API, ohne Zwischenspeicher | 0,0165 $ | 0,03 bis 0,07 $ |
| API, mit Zwischenspeicher | rund 0,004 $ | 0,01 bis 0,02 $ |
| Abo (Claude Code) | rund 0,008 $ Guthaben | 0,02 bis 0,03 $ Guthaben, zählt gegen das monatliche Agent-SDK-Guthaben |
| OpenRouter | 0,0004 bis 0,0186 $ je nach Modell (laut `usage.cost`) | |
| Ollama | nichts außer Strom | |

Zum Vergleich ElevenLabs: 0,08 $ pro Zusatzminute
(elevenlabs.io/pricing/agents, abgerufen 30.09.2026) plus dieselben
Modellkosten. Hören und Sprechen laufen beim Telefonhörer lokal und kosten
nichts. Jeder Abruf reserviert dazu einen festen Betrag im Tagesbudget
„voice“ (`CALL_REQUEST_RESERVATION_USD`, Standard 0,05 $).

### Stimme von ElevenLabs (optional)

Unter Einstellungen, Sprechen, Telefonhörer wählt „Stimme im Gespräch“ die
Stimme: Automatisch (wie oben unter „Sprechen“, also Pocket TTS, Piper oder
der Browser), fest Pocket TTS, Piper, ElevenLabs oder die Browser-Stimme.

- **ElevenLabs** braucht `ELEVENLABS_API_KEY` (Einstellungen, Schlüssel);
  ohne ihn ist die Wahl gesperrt, mit Grund. Die Stimme ist eine
  Stimmen-Kennung aus deinem ElevenLabs-Konto (leer lassen für die
  voreingestellte „River“, die jedes ElevenLabs-Konto hat), das Modell standardmäßig v3 Conversational (das
  Modell der Sprach-Agenten von ElevenLabs: am natürlichsten, so schnell
  wie Flash v2.5), mit deren Stimm-Einstellungen (Stabilität 0,5,
  Ähnlichkeit 0,75).
  `ELEVENLABS_VOICE_ID` gilt hier nicht, nur für Telegram und den
  Sprechmodus.
- **Kosten:** ElevenLabs zieht für jedes gesprochene Zeichen Guthaben ab.
- **Daten:** jeder Antwortsatz geht als Text an ElevenLabs.
- **Rückfall:** Ist ElevenLabs bei einem Satz nicht erreichbar (kein
  Guthaben, zu viele Anfragen, Netz), spricht Pocket TTS genau diesen Satz,
  und oben steht ein Hinweis. Nach zwei Fehlern in Folge bleibt das
  Gespräch bis zum Auflegen bei Pocket TTS. Ohne Pocket TTS spricht die
  Browser-Stimme den Satz.
- **Stimme anhören:** spricht einen kurzen Satz mit der gespeicherten
  Stimme, ohne Rückfall (höchstens sechs Mal in zehn Minuten).

### Erkennen mit ElevenLabs Scribe (optional)

Parakeet erkennt Deutsch gut, verschluckt aber manchmal Laute bei seltenen
zusammengesetzten Wörtern. Unter Einstellungen, Sprechen, Telefonhörer wählt
„Erkennen im Gespräch“ den Erkenner: Automatisch (wie oben unter „Hören“,
im Telefonhörer aber nur lokal), fest Parakeet, whisper.cpp oder
ElevenLabs Scribe.

- **ElevenLabs Scribe** braucht `ELEVENLABS_API_KEY` (Einstellungen,
  Schlüssel); ohne ihn ist die Wahl gesperrt, mit Grund, und eine schon
  gespeicherte Wahl erkennt mit Parakeet. Telegram und der Sprechmodus
  bleiben bei ihrer Wahl unter „Hören“.
- **Kosten:** ElevenLabs berechnet die Erkennung nach Länge der Aufnahme
  und zieht dafür Guthaben ab.
- **Daten:** jede Äußerung im Gespräch geht als Aufnahme an ElevenLabs,
  schon während du sprichst (eine Verbindung je Gespräch).
- **Rückfall:** Ist Scribe bei einer Äußerung nicht erreichbar (kein
  Guthaben, zu viele Anfragen, Netz, länger als 4 Sekunden), erkennt
  Parakeet dieselbe Äußerung, und oben steht ein Hinweis. Nach zwei Fehlern
  in Folge bleibt das Gespräch bis zum Auflegen bei Parakeet. Parakeet ist
  dafür das ganze Gespräch geladen, wenn es eingerichtet ist; sonst bittet
  tybo, es noch einmal zu sagen.
- **Wartezeit:** Scribe hört schon beim Sprechen mit und liefert den Text
  in der Sprechpause. Gemessen am 02.10.2026 (Mac mit Apple M4, je drei
  Läufe mit zwei Sätzen): Ende der Äußerung bis erster Ton im Median 1,9
  Sekunden mit Scribe, 2,0 Sekunden mit Parakeet.

### Datenschutz im Telefonhörer

| Stufe | Wo es bleibt |
| --- | --- |
| Hören | Parakeet bzw. whisper.cpp auf dem eigenen Rechner: der Ton bleibt dort. Mit ElevenLabs Scribe als Erkenner geht jede Äußerung als Aufnahme an ElevenLabs |
| Denken | der Text der Äußerung und der schlanke Kontext (Agent-Prompt, Profil, Memory, letzte Nachrichten) gehen an den Anbieter des Modells: Anthropic (API oder Abo), OpenRouter samt dessen Anbieter, bei Ollama nirgends hin |
| Sprechen | Pocket TTS bzw. Piper auf dem eigenen Rechner: der Text bleibt dort; die Browser-Stimme spricht auf dem Gerät. Mit ElevenLabs als Stimme geht jeder Antwortsatz als Text an ElevenLabs |

Der Ton wird nie gespeichert, Logs nennen nie das Gesagte.

### Das Gespräch im Verlauf

Jeder Turn steht sofort im gewählten Gespräch, nicht erst nach dem Auflegen:
deine Äußerung mit der Angabe „am Telefon gesagt“, die Antwort mit
„Telefonhörer · <Modell>“. Gespeichert wird nur, was tybo wirklich gesagt
hat; eine unterbrochene Antwort endet mit „(unterbrochen)“. Nicht Verstandenes
und Füllwörter erscheinen nicht. Beim Auflegen steht eine Meldung
„Telefongespräch, 4 Min.“ (Absender Telefonhörer) da.

- Andere offene Seiten zeigen das Gespräch live. Nichts davon geht nach
  Telegram, auch nicht in Telegram-Topics, und es gibt keinen Push.
- Äußerungen und Antworten landen im gemeinsamen Gedächtnis wie getippte
  Nachrichten: `history_search` und die semantische Suche finden sie.
- Läuft im Gespräch gerade ein Denkauftrag, legt tybo die Äußerungen erst nach
  dessen Ende ab, mit der Uhrzeit, zu der sie gesagt wurden.
- Der nächste getippte Turn im selben Gespräch bekommt das Telefongespräch
  einmal als Kontext („Vorhin am Telefon: …“, höchstens 4.000 Zeichen, die
  jüngsten Äußerungen zuerst). Das gilt für jeden Motor und auch, wenn die
  Session fortgesetzt wird. Der Hinweis lebt nur im laufenden Bot; nach einem
  Neustart steht das Gespräch weiter im Verlauf, der Hinweis fehlt.

### Wenn es nicht geht

- **Kein Knopf „Telefonhörer“:** Es fehlt ein lokaler Erkenner oder ein
  Modellweg, oder der Browser ist nicht in einem sicheren Kontext. Der Grund
  steht unter Einstellungen, Sprechen, Telefonhörer, mit dem nächsten Schritt
  (`tybo setup sprache` bzw. `tybo setup zugang`).
- **Mikrofon verweigert:** In den Website-Einstellungen des Browsers das
  Mikrofon für die tybo-Adresse erlauben; auf dem iPhone in der installierten
  App beim nächsten Antippen erlauben (siehe [handy-app.md](handy-app.md)).
- **Verbindung bricht ab, besonders hinter einem eigenen Proxy:** Der
  Telefonhörer nutzt einen WebSocket (`/api/call`). Ein Proxy oder Tunnel muss
  `Upgrade`-Anfragen durchlassen und darf die Verbindung nicht nach wenigen
  Sekunden ohne Daten trennen; tybo sendet alle 25 Sekunden ein Ping.
  Tailscale und Cloudflare Tunnel können das von sich aus.
- **Antworten kommen spät:** Die Probe zeigt, welcher Weg auf deinem Gerät wie
  schnell ist. Im Abo helfen kurze Fragen; OpenRouter nur mit wenig
  Vordenken; Ollama bleibt zäh.

Fehlersuche ausführlicher: [troubleshooting.md](troubleshooting.md),
Abschnitt „Telefonhörer“.

## Anruf von tybo (ElevenLabs und Twilio)

tybo kann dich übers Telefonnetz anrufen, auch wenn kein Browser offen ist.
Auslöser sind der Befehl `/anruf [anlass]` in Telegram, im Browser und im
Terminal (ohne Anlass meldet sich tybo allgemein) und der Knopf „Anrufen“
unter Check-in und Briefing. Fehlt eine der Variablen, nennt `/anruf` sie
und ruft nicht an. Modelle mit Werkzeugen (Fallback, später der Motor `api`)
haben das Werkzeug `phone_call`; es ruft erst an, wenn du die Freigabe-Frage
im Gespräch bestätigst. Nötig sind
`ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_PHONE_NUMBER_ID` und
`USER_PHONE_NUMBER`. Der Code liegt in `src/lib/phone/`.

Ohne weitere Angabe wählt tybo über eine Twilio-Nummer bei ElevenLabs. Liegt
die Nummer an einem SIP-Trunk, etwa an der eigenen Vermittlung aus dem
nächsten Abschnitt, gehört `ELEVENLABS_PHONE_PROVIDER=sip_trunk` in die
`.env`. tybo nutzt dann den SIP-Aufruf von ElevenLabs; die Höchstdauer setzt
dort die Vermittlung. Ein anderer Wert als `twilio` oder `sip_trunk` gilt als
nicht eingerichtet, und `/anruf` nennt die Variable.

- **Anlass:** steht vor dem Wählen in der Anrufliste (`data/phone-calls.json`).
  Die Sprach-Brücke findet ihn, wenn beim ElevenLabs-Agenten unter
  „Custom LLM“ zwei Request-Header eingetragen sind: `x-voice-call-ref` mit
  der dynamischen Variable `tybo_call_ref` und `x-voice-conversation-id` mit
  `system__conversation_id`. Ohne die Header nennt nur der erste Satz den Anlass.
- **Nach dem Gespräch:** tybo holt das Protokoll bis zu 15 Minuten lang ab,
  auch über einen Neustart des Bots hinweg, ohne noch einmal anzurufen. Die
  Zusammenfassung kommt in das Gespräch, aus dem der Anruf kam (bei Check-in
  und Briefing in den Direktchat). Protokoll und Zusammenfassung landen im
  Verlauf; ist die Datenbank gerade nicht erreichbar, bleibt das Protokoll in
  der Anrufliste und tybo legt es später ab (erst nach einer Minute, dann in
  wachsenden Abständen bis zu einer Stunde, auch nach einem Neustart).
- **Aufträge:** Erkennt tybo im Gespräch einen Auftrag, fragt es mit den
  Knöpfen „Ja, erledigen“ und „Nein“ nach, in Telegram und im Browser. Erst
  nach „Ja, erledigen“ wird er ausgeführt, wie eine getippte Nachricht: mit
  „Arbeite daran …“ im Gespräch und denselben Zeitgrenzen
  (`TYBO_CLAUDE_IDLE_MIN`, `TYBO_CLAUDE_MAX_MIN`). Kam der Anruf aus einem
  reinen Web-Gespräch, startet tybo den Auftrag dort noch nicht selbst: nach
  „Ja, erledigen“ steht der Auftrag als Meldung im Gespräch, du schickst ihn
  als Nachricht.
- **Sonderfälle:** Nicht angenommen, Zeitablauf und Fehler beim Anbieter
  kommen je als eigene kurze Meldung.

## Anrufannahme über eigene Vermittlung

Mit einem privaten easybell-Anschluss nehmen Sprachagenten von ElevenLabs
Anrufe auf die eigene Festnetznummer an, und `/anruf` wählt über diese Nummer
statt über Twilio. Dazwischen steht eine kleine Telefonzentrale auf einem
eigenen Server: Ein privater Anschluss liefert Anrufe nur an ein Gerät, das
sich bei easybell anmeldet, und ElevenLabs meldet sich nicht an. Die
Vermittlung tut das an seiner Stelle und reicht die Anrufe per SIP weiter.

- **Eingehend:** easybell, Vermittlung, Sprachagent. Die Nummer des Anrufers
  kommt beim Agenten an (`system__caller_id`), damit Anruferregister und
  PIN-Prüfung sie sehen. Anrufe mit unterdrückter Nummer lehnt die Vermittlung
  ab, solange es nicht anders eingestellt ist.
- **Ausgehend:** `/anruf` schickt ElevenLabs an die Vermittlung, die wählt über
  easybell. Sie wählt nur Nummern aus einer Positivliste, ohne eigene Liste nur
  `USER_PHONE_NUMBER`; alles andere weist sie ab und schreibt es ins Log.
- **Schutz:** TLS und Digest-Anmeldung zu ElevenLabs (feste Adressen gibt es
  dort nur im Enterprise-Tarif), kein anonymer Zugang, fail2ban, höchstens zwei
  Gespräche gleichzeitig und eine Höchstdauer je Gespräch. Keine Aufzeichnung;
  im Log stehen Rufnummern nur gekürzt.
- **Kosten:** laut Preisliste von easybell 9,8 ct je Minute ins deutsche
  Mobilfunknetz (ohne Flatrate, Stand der Quelle im README). Ob eingehende
  Anrufe kostenlos sind, sagt die Preisliste nicht ausdrücklich.
- **Zustand:** `tybo pruefen` und der Nachtcheck zeigen, ob die Vermittlung bei
  easybell angemeldet ist. Fällt die Anmeldung aus, meldet `bun run sip-zustand`
  das einmal und die Erholung danach ebenfalls einmal. Die Abfrage läuft per
  SSH mit einem Schlüssel, der auf dem Server nur das Zustandsskript ausführen
  darf (`SIP_VERMITTLUNG_SSH`, `SIP_VERMITTLUNG_SSH_KEY`).

**Doppelte Anmeldung:** Ist schon ein anderes Gerät mit demselben
easybell-Zugang angemeldet, etwa ein Router mit Telefonanschluss, sind danach
zwei Geräte angemeldet. Das ist erlaubt: Laut Hilfe von easybell können fünf
Geräte auf einem SIP-Zugang angemeldet sein (Quelle mit Datum im README). Wer
dann bei einem Anruf klingelt und wer annimmt, ist nicht dokumentiert; das
zeigt erst der Test mit dem echten Anschluss. Klingeln beide, im Kundenportal
klären, ob sich das Ziel festlegen lässt, oder das andere Gerät abmelden.

Einrichtung, Primärquellen mit Abrufdatum, Prüfung, Test mit dem echten
Anschluss und Rückbau: [`deploy/sip-vermittlung/README.md`](../deploy/sip-vermittlung/README.md).
Vor dem Einsatz prüft `bun run deploy/sip-vermittlung/pruefen.ts --container`
die Vermittlung mit echtem Asterisk gegen nachgebaute Gegenstellen für easybell
und ElevenLabs, ohne Weg nach außen: Gespräche in beide Richtungen,
Anrufernummer, unterdrückte Nummern, dritter Anruf, Höchstdauer, Umleitungen,
fail2ban, gekürzte Nummern im Log und das Laden der Firewall nach einem
Neustart.

## Sprachagenten: Rezepte

Ein Sprachagent wird künftig nicht mehr von Hand beim Anbieter angelegt,
sondern aus einem Rezept: einer Datei `config/voice-agents/<kennung>.json`,
die ihn vollständig beschreibt (Entscheidung 0026). Es gibt Format, Prüfung,
die Sprachschicht, die den Agenten bei ElevenLabs anlegt, und den Befehl
`/sprachagent` zum Ansehen, Testen, Löschen, Anlegen und Ändern (unten).
`/anruf` und die Variablen in der `.env` bleiben, wie sie sind.

- **Beispiele:** `config/voice-agents.example/` enthält eine Anrufannahme,
  einen persönlichen Assistenten und einen Trainer. Der Ordner
  `config/voice-agents/` steht nicht im Repo.
- **Vorlagen:** Jedes Rezept nennt eine Vorlage (`anrufannahme`, `jarvis`,
  `experte`). Sie bringt feste Regeln mit, die ein Rezept ergänzen, aber nicht
  streichen kann: KI-Hinweis bei Fremden, Nummern Ziffer für Ziffer
  zurücklesen, im Notfall zu 112 auffordern und das Gespräch beenden, keine
  Zusagen im Namen des Nutzers. Dazu kommen je Vorlage zwei bis drei
  Standard-Tests, der Notfall immer. Das sichert den Text des Prompts; ob ein
  Modell sich daran hält, zeigen erst die Testläufe beim Anbieter.
- **Prüfung:** Unbekannte Felder sind Fehler, ein Feld `gaeste` gibt es nicht
  (der Web-Zugang liegt immer hinter dem Login). Gedächtnisstufe `voll` geht am
  Telefon nur mit `pin: true`. `anrufer: alle` und die Vorlage `anrufannahme`
  verlangen `kiHinweis` und Stufe `keins`. Pflicht sind mindestens zwei Tests,
  `maxMinuten` und `budget`; `anrufeJeNummerTag: 0` geht nur ohne Telefon.
  Werkzeuge kommen aus einer festen Liste.
- **Stimme:** Nennt ein Rezept der Art `bibliothek` keine `voiceId`, gilt die
  Einstellung `speech.call.elevenlabsVoice`, sonst `ELEVENLABS_VOICE_ID` aus
  der `.env`. Fehlt beides, scheitert das Speichern mit einer klaren Meldung;
  auf eine andere Stimme weicht tybo nicht aus. Beim Speichern wandert die
  Stimme fest ins Rezept, eine spätere Änderung der Einstellung verstellt also
  keinen bestehenden Agenten. Die Arten `design` und `eigene` brauchen immer
  eine eigene `voiceId`.
- **Laufzeitdaten:** `data/voice-agents/<kennung>/state.json` hält Anbieter,
  Agent-Kennung, letzten Abgleich und Zeitpunkte, `versionen/<n>.json` eine
  Kopie des Rezepts je Änderung. Eine neue Version entsteht nur, wenn sich das
  Rezept gegenüber der letzten Version geändert hat. Ist die letzte Version
  beschädigt, scheitert das Speichern und das aktive Rezept bleibt; der Fehler
  nennt die Datei, die berichtigt oder weggeräumt werden muss.
- **Symbolische Links:** `config/voice-agents/`, `data/voice-agents/` und alles
  darin müssen echte Ordner und Dateien sein, einem Link folgt tybo hier nicht.

### Abgleich mit ElevenLabs

Die Sprachschicht bringt ein Rezept zum Anbieter. Sie braucht
`ELEVENLABS_API_KEY`, bei `gehirn.art: bruecke` außerdem `VOICE_BRIDGE_URL` und
`VOICE_BRIDGE_TOKEN`. Telefonnummern ordnet sie nicht zu.

- **Was übertragen wird:** Name, Prompt, Modell, Stimme, Stimmmodell, Tempo,
  Sprachen und die Höchstdauer aus `zugang.maxMinuten`. Der KI-Hinweis steht vor
  dem ersten Satz, und dieser Satz lässt sich dann nicht unterbrechen. Die
  Anmeldepflicht ist immer an: Web-Gespräche gehen nur mit Token aus dem Server.
- **Anbieter oder Brücke:** Bei `anbieter` setzt das Rezept das Modell direkt.
  Bei `bruecke` spricht der Agent mit der Sprach-Brücke und schickt
  `x-tybo-rezept: <kennung>` sowie die `x-voice-*`-Köpfe mit. Das Token liegt als
  Geheimnis beim Anbieter, im Agenten steht nur ein Verweis. Wechselt ein Rezept
  zu `anbieter`, entfernt tybo Brücke und Geheimnis.
- **Wann abgeglichen wird:** Nur wenn sich der Hash des Rezepts geändert hat,
  sonst gibt es keinen Aufruf. Ändert sich nur der Prompt (neue Vorlage) oder die
  Brücke (Adresse, Token), meldet tybo das als Hinweis; übernommen wird es mit der
  nächsten Änderung am Rezept oder wenn der Agent entfernt und neu angelegt wird.
- **Handänderungen:** Vor jeder Änderung vergleicht tybo die Werte aller Felder,
  die aus dem Rezept stammen, auch innerhalb der Sprachvarianten, mit dem letzten
  bekannten Stand. Weicht etwas ab, ist der Agent gelöscht oder fehlt die
  Vergleichsgrundlage, gibt es eine Warnung mit den Feldnamen, und nichts wird
  überschrieben. Weiter geht es, wenn die Änderung beim Anbieter zurückgenommen
  ist, oder nach dem Entfernen des Agenten: Der nächste Abgleich legt ihn dann neu
  an, mit neuer Kennung. In `state.json` steht je Feld nur ein Hash, nie der Wert.
  Ging ein Schreibvorgang durch einen Zeitablauf verloren, kann die Warnung auch
  ohne Handänderung kommen.
- **Nachfrage nach dem Schreiben:** Nach jedem Schreiben liest tybo den Agenten
  zurück. Scheitert das, merkt es sich, was es gesendet hat. Der nächste Abgleich
  vergleicht damit: Stimmt alles, gilt das Schreiben als bestätigt, ohne neuen
  Schreibaufruf. Weicht etwas ab, kommt die Warnung.
- **Sprachen:** Der Abgleich gilt erst als geschafft, wenn Hauptsprache und
  Varianten zurückgelesen zum Rezept passen. Fällt eine Sprache weg, legt tybo den
  Agenten neu an und löscht den alten, sobald der neue bestätigt ist, denn nur das
  ist beim Anbieter dokumentiert. Der Agent hat dann eine neue Kennung, Tests und
  das Token der Brücke bleiben, Einstellungen außerhalb des Rezepts sind weg. Hängt
  am alten Agenten eine Telefonnummer oder ein WhatsApp-Konto, bricht tybo mit
  einem Fehler ab und ändert nichts.
- **Tests:** Jeder Standard-Test der Vorlage und jeder Test des Rezepts wird eine
  Simulation beim Anbieter, die Kennungen stehen in `state.json`. Was unverändert
  ist, wird nicht angefasst; entfernte Szenarien werden dort gelöscht. Scheitert
  der Abgleich unterwegs, bleibt das Geschaffte erhalten, und der nächste Aufruf
  holt den Rest nach, auch wenn der Agent selbst unverändert ist.
- **Testlauf:** Das Ergebnis fragt tybo sofort ab, dann nach 2, 5, 10, 15 und danach
  alle 30 Sekunden, höchstens 15 Minuten lang. Diese Frist gilt auch für die einzelne
  Anfrage: Sie wird rechtzeitig abgebrochen, und was erst danach ankommt, zählt nicht,
  auch keine Erfolgsmeldung. 429 und 5xx gelten als vorübergehend, andere Fehler und
  unlesbare Antworten beenden die Abfrage. Abgebrochene Tests und Einträge, denen
  Pflichtfelder wie die Test-Kennung fehlen, zählen nie als bestanden.
- **Geheimnisse:** Antworten des Anbieters werden gefiltert, bevor sie in einen
  Fehlertext oder die Begründung eines Tests gelangen. Die Sprachschicht schreibt
  nichts ins Log.

**Kosten je Simulationstest:** noch nicht gemessen. Der Maintainer trägt hier nach
dem ersten echten Testlauf Test-Kennung, Datum und Credits ein.

Code: `src/lib/voice-agents/` (`recipe.ts`, `state.ts`, `prompt.ts`, `layer.ts`,
`elevenlabs.ts`, `templates/`).

### Befehl /sprachagent

In Telegram, im Browser und im Terminal. Ohne Unterbefehl zeigt `/sprachagent`
eine kurze Hilfe.

| Befehl | Wirkung |
|---|---|
| `/sprachagent liste` oder `/sprachagenten` | Je Rezept Name, Vorlage, Gehirn, Gedächtnis, Zugang, ob der Agent beim Anbieter angelegt ist, letzter Testlauf („bestanden 2 von 3“) und Minuten im Monat |
| `/sprachagent testen <kennung>` | Startet alle Tests beim Anbieter. Das Ergebnis kommt in dasselbe Gespräch: je Test bestanden oder durchgefallen, mit dem verfehlten Kriterium |
| `/sprachagent loeschen <kennung>` | Rückfrage mit Knöpfen, erst „Ja, löschen“ handelt |
| `/sprachagent link <kennung>` | Adresse der Gesprächsseite `/sa/<kennung>` in der WebUI, nur mit `zugang.web.link: true` und Freischaltung (unten „Gespräch im Browser“) |
| `/sprachagent neu <beschreibung>` | Entwurf per Hintergrund-Job, danach Stimmwahl und Freigabe mit Knöpfen (unten) |
| `/sprachagent aendern <kennung> <wunsch>` | Dasselbe für ein bestehendes Rezept, die Freigabe nennt die geänderten Felder |

- **Liste:** Rezepte, die die Prüfung nicht bestehen, stehen darunter mit ihren
  Fehlern. Bei der Telefonnummer steht die Kennung der Nummer beim Anbieter, keine
  Rufnummer. Den Verbrauch an Minuten erfasst tybo noch nicht: Die Liste nennt ihn
  „unbekannt“ und dazu das Limit aus `zugang.budget.minutenMonat`, nie eine 0.
- **Testen:** Braucht `ELEVENLABS_API_KEY` und einen angelegten Agenten. Der
  letzte Lauf steht in `data/voice-agents/<kennung>/testlauf.json`, auch wenn er an
  einer Zeitüberschreitung (15 Minuten) oder einem Fehler scheiterte; die Meldung
  sagt dann, was passiert ist. Nennt der Anbieter für einen durchgefallenen Test
  keine Begründung, steht das so da. Pro Agent läuft höchstens ein Testlauf. Startet
  der Bot während eines Laufs neu, zeigt die Liste ihn als „nicht abgeholt“, und ein
  neuer Lauf lässt sich starten.
- **Löschen:** Nach „Ja“ löscht tybo beim Anbieter Tests, Agent und das hinterlegte
  Token der Brücke und verschiebt das Rezept nach
  `data/voice-agents/<kennung>/geloescht/<zeitpunkt>.json`. Endgültig gelöscht wird
  nichts, Versionen und Zustand bleiben. Ein vorhandenes Archiv wird nie
  überschrieben. Scheitert der Anbieter, bleibt das Rezept, und was schon gelöscht
  war, bleibt gelöscht; ein neues `/sprachagent loeschen` macht den Rest. Dasselbe
  gilt, wenn das Archiv nicht geschrieben werden kann. Jede Rückfrage wirkt genau
  einmal, ein zweiter Klick tut nichts; entscheiden kann nur das Gespräch, in dem
  sie steht. Eine neue Rückfrage für denselben Agenten lässt die ältere ablaufen,
  sonst gilt sie einen Tag.
- **Link:** Die Adresse ist `WEB_PUBLIC_ORIGIN`, sonst bei `WEB_HOST=0.0.0.0` die
  erste Adresse im Heimnetz, sonst Host und Port der WebUI. Ohne Freischaltung,
  ohne Web-Zugang im Rezept oder mit ausgeschalteter WebUI gibt es keinen Link,
  sondern den Grund.
- **Ohne Anbieter:** Ohne `ELEVENLABS_API_KEY` gehen Liste und Link. Ein Agent, der
  beim Anbieter nie angelegt wurde, lässt sich auch dann löschen (nur Archiv).

Code: `src/lib/commands/voice-agents.ts` (Befehl), `src/lib/voice-agents/manage.ts`
(Liste, Testlauf, Löschen), Rückfrage-Art `sprachagent` in `src/app/bot-choices.ts`.

### Entwurf per Befehl: neu und aendern

`/sprachagent neu Ein Trainer für Segelscheinprüfungen, duzt, eher streng`
lässt tybo das Rezept schreiben, beim Experten das Themenwissen recherchieren
und das Ergebnis zur Freigabe zeigen. Angelegt wird nichts ohne Knopf.

1. **Job:** Ein Hintergrund-Job (`docs/hintergrund-jobs.md`) bekommt einen
   festen Auftrag (`src/lib/voice-agents/brief.ts`): Vorlage wählen, Rezept
   nach Schema schreiben, Kennung vorschlagen, mindestens zwei eigene
   Testszenarien, eine Zeile zur gewünschten Stimme und beim Experten eine
   Wissensdatei mit Zeile `Stand: <datum>` und Abschnitt `## Quellen` (je
   Quelle Titel, URL, Abrufdatum), höchstens 40.000 Zeichen. Für einen neuen
   Experten ist die Wissensdatei Pflicht, ganz gleich, was das Rezept bei
   `gedaechtnis` sagt. Zahlen und Fakten nur aus Primärquellen. Der Job läuft
   nie mit `--full-access`, sondern in einem eigenen Arbeitsordner
   `data/voice-agents/entwuerfe/.arbeit/<entwurf>/` mit `--restricted`: Claude
   startet dort, Lesen und Schreiben reichen nicht darüber hinaus,
   Einstellungsdateien und MCP-Server bleiben aus, Befehle gibt es nicht.
   Recherche geht über WebSearch und WebFetch. Beispielrezepte, die Typen des
   Rezepts und beim Ändern das aktive Rezept bekommt er als Kopie in den
   Arbeitsordner. Steuerdaten (`entwuerfe/.steuerung/<entwurf>/`), aktive
   Rezepte, Versionen, Wissensdateien, Freischaltungen und Rückfragen liegen
   alle außerhalb.
2. **Prüfung:** tybo verfolgt den Job alle 15 Sekunden über seinen Status, auch
   nach einem Neustart des Bots. Danach prüft es ohne Sprachmodell: besteht das
   Rezept `parseRecipe`, ist die Kennung frei (bei `aendern` unverändert), steht
   keine Stimmen-Kennung darin, erfüllt die Wissensdatei Länge, Stand und
   Quellen. Zusätzlich vergleicht tybo die Hashes aller aktiven Rezepte,
   Versionen und Wissensdateien mit dem Stand beim Start. Bei Fehlern startet
   genau ein zweiter Lauf mit der Fehlerliste; scheitert auch der, kommt eine
   Meldung mit den Fehlern und der Entwurf endet. Gestoppte, abgebrochene oder
   zu lange Jobs enden ohne zweiten Lauf. Besteht der Entwurf, legt tybo ihn
   unter `data/voice-agents/entwuerfe/<kennung>/` ab (`rezept.json`,
   `wissen.md`, `stimme.txt`, dazu `entwurf-id`). Je Kennung ist höchstens ein
   Entwurf offen: Ein zweiter `neu` mit derselben Kennung bekommt das als
   Fehler für die Nachbesserung, ein zweites `aendern` startet gar nicht.
3. **Stimme:** Nennt der Entwurf eine gewünschte Stimme, schlägt tybo bis zu
   drei Stimmen des ElevenLabs-Kontos vor (vorinstallierte, aus der Bibliothek
   übernommene und dort geklonte, `GET /v1/voices`), dazu die Standardstimme
   aus den Einstellungen. Die Auswahl per Knopf kommt vor der Freigabe, die
   gewählte Kennung ins Rezept. „Standardstimme“ setzt die Stimme, die in
   diesem Moment eingestellt ist, auch bei `aendern` an die Stelle der
   bisherigen. Ohne Stimmwahl gilt beim neuen Agenten die Standardstimme vom
   Zeitpunkt der Prüfung. In jedem Fall steht die Stimme vor der Freigabe fest
   im Rezept; eine spätere Änderung der Einstellung ändert sie nicht, auch nicht
   bei „Erneut versuchen“. Die lokalen Stimmen aus „Eigene Stimme“ sind keine
   Kandidaten, sie gehen nie an ElevenLabs (Entscheidung 0023).
4. **Freigabe:** Kurzfassung mit Zweck, Vorlage, Stimme, Gehirn, Gedächtnis
   (mit Größe, Quellen und Stand der Wissensdatei), Zugang, Tests und
   geschätzten Kosten je Minute, dazu „Anlegen“ und „Verwerfen“. Ändern geht
   nach dem Anlegen mit `aendern`. Jede Rückfrage eines Entwurfs (Stimmwahl,
   Freigabe, „Erneut versuchen“, „Trotzdem freischalten“) gilt drei Tage.
   Danach beendet tybo den Entwurf, auch nach einem Neustart: nichts wird
   freigeschaltet, eine schon gespeicherte Fassung bleibt gesperrt, die Kennung
   ist wieder frei, und eine Meldung nennt den Weg zurück (`neu`, `aendern`
   oder `testen`).
5. **Anlegen:** Zuerst fragt tybo beim Anbieter, ob am bestehenden Agenten eine
   Telefonnummer oder ein WhatsApp-Konto hängt (siehe unten). Dann speichert
   `saveRecipe` das Rezept; ob die Kennung noch frei ist bzw. das
   Ausgangsrezept noch gilt, prüft es unter derselben Sperre, in der es
   speichert. Die Wissensdatei kommt nach
   `data/voice-agents/<kennung>/wissen-<hash>.md`. Danach beim Anbieter
   anlegen, Tests übertragen und ausführen. Beim Gehirn `anbieter` steht das
   Themenwissen im Prompt vor den festen Regeln, bei `bruecke` lädt die Brücke
   es selbst. Bestehen alle Tests, ist der Agent freigeschaltet
   (`data/voice-agents/<kennung>/freischaltung.json`, gebunden an den Hash
   genau dieser Fassung und an den Inhalt ihrer Wissensdatei; wird die Datei
   danach geändert, fehlt sie oder ist sie unlesbar, ist er wieder gesperrt).
   Fallen Tests durch und hat jeder Test ein Ergebnis,
   bleibt er gesperrt; ein Knopf „Trotzdem freischalten“ schaltet genau die
   getestete Fassung frei. Über die Freischaltung entscheidet nur ein
   vollständiger Lauf: Das Ergebnis enthält jede angeforderte Test-ID genau
   einmal und keine fremde. Ein Lauf, in dem ein Test fehlt, doppelt kommt,
   fremd ist, abgebrochen ist oder kein Ergebnis hat, schaltet nie frei und
   bietet diesen Knopf nie. Ohne `ELEVENLABS_API_KEY` lässt sich die
   Erreichbarkeit nicht prüfen: Eine Änderung (oder ein Agent, der beim
   Anbieter schon angelegt ist) wird dann gar nicht gespeichert, es gilt die
   bisherige Fassung, und „Erneut versuchen“ steht bereit. Bei „Erneut
   versuchen“ vergleicht tybo den Agenten beim Anbieter auch dann mit dem
   letzten Abgleich, wenn sich das Rezept nicht geändert hat; eine
   Handänderung zwischen zwei Versuchen meldet tybo und schaltet nicht frei.
   Vor jeder Freischaltung, ob nach bestandenen Tests oder über „Trotzdem
   freischalten“, liest tybo den Agenten beim Anbieter noch einmal und
   vergleicht ihn mit dem Stand, der getestet wurde. Weicht er ab (etwa ein
   von Hand geänderter erster Satz während des Laufs oder danach) oder lässt
   er sich nicht lesen, bleibt der Agent gesperrt, und tybo sagt warum. Eine
   unlesbare Antwort auf die Frage nach Telefonnummer oder WhatsApp-Konto
   gilt nie als „nicht erreichbar“: Dann speichert tybo nichts. Fehler, Abbruch und
   Zeitüberschreitung des Testlaufs, ein fehlender Anbieter, eine Handänderung
   beim Anbieter und ein Neustart mitten im Anlegen schalten nie frei; dann
   kommt „Erneut versuchen“, das mit derselben Fassung weitermacht und eine
   schon gespeicherte eigene Fassung als solche erkennt.

**Neustart:** Jeder Schritt hält zuerst den Zustand fest, dann folgt die
Wirkung. Nach einem Neustart hängt tybo einen Job, dessen Kennung noch nicht
eingetragen war, über seinen Titel an, statt einen zweiten zu starten. Fehlt
eine Rückfrage (Neustart zwischen Phasenwechsel und Frage), stellt tybo sie neu;
eine ältere desselben Entwurfs läuft dabei ab. Eine angelegte, aber nicht
zugestellte Rückfrage wird zugestellt, ohne eine neue anzulegen.

**aendern:** `/sprachagent aendern segel-trainer Antworte kürzer` schreibt den
Entwurf aus dem aktiven Rezept plus Wunsch. Die Freigabe nennt die geänderten
Felder (etwa `persona.rolle, tests` oder „Wissensdatei“), verglichen mit der
Kopie des Ausgangsrezepts in den Steuerdaten, nicht mit der im Arbeitsordner
des Jobs. Übernommen wird nur, wenn Rezept und Wissensdatei seit dem Start
unverändert sind, sonst gilt die Freigabe als veraltet. Die Übernahme schreibt
eine neue Version. Weil die Wissensdatei ihren Hash im Namen trägt, ändert auch
eine reine Wissensänderung den Hash des Rezepts, und der Abgleich beim Anbieter
läuft.

**Erreichbarkeit:** tybo ordnet keine Telefonnummer zu, und den Web-Link gibt es
erst mit der Freischaltung (SA1-6). Eine Nummer, die beim Anbieter von Hand an
einen Agenten gehängt wurde, sperrt eine lokale Freischaltungsdatei aber nicht.
Deshalb übernimmt tybo eine Änderung nicht, solange am Agenten beim Anbieter
eine Telefonnummer oder ein WhatsApp-Konto hängt: Es speichert nichts und ändert
beim Anbieter nichts, es gilt weiter die bisherige Fassung. Die Meldung sagt
das; nach dem Lösen der Zuordnung geht es mit „Erneut versuchen“ weiter. Lässt
sich die Zuordnung nicht prüfen, gilt dasselbe. Beim Schreiben prüft die
Sprachschicht die Zuordnung noch einmal (`nurOhneZuordnung`). So ist eine
ungeprüfte Fassung über keine Nummer erreichbar.

**Geschätzte Kosten:** Das Issue verweist auf „Plan Abschnitt 7“, der nicht im
Repo liegt. Ersatzgrundlage ist die eingebaute Preisgrundlage in
`src/lib/voice-agents/cost.ts`, Preisstand 7.11.2026:

| | Wert | Quelle |
|---|---|---|
| Tarif | ElevenLabs Agents, jede Minute zum Preis der Zusatzminute (im Plan enthaltene Minuten nicht abgezogen) | [Preisseite Agents](https://elevenlabs.io/pricing/agents) |
| Anbieter je Minute | 0,08 USD („Additional call minutes cost $0.08 per minute“, in jedem Plan) | [Preisseite Agents](https://elevenlabs.io/pricing/agents) |
| Gehirn beim Anbieter | je Million Token, etwa `claude-sonnet-5-5` 2,20 USD Eingabe und 11 USD Ausgabe, `claude-haiku-5-5` 0,11 und 0,55, `gemini-3.8-flash` 0,83 und 4,13 | [LLM-Preisliste](https://elevenlabs.io/scale-tier#llm-prices) |
| Annahmen | 3 Gesprächszüge je Minute, je Zug 6.700 Eingabe- und 150 Ausgabe-Token, ohne Prompt-Cache | tybos eigene Messung der Brücke |
| Telefonie | ElevenLabs berechnet sie nicht zusätzlich; der Anbieter der Nummer (SIP-Trunk, Twilio) rechnet selbst ab, nicht enthalten | [Preisseite Agents](https://elevenlabs.io/pricing/agents) |

Beispiel `claude-sonnet-5-5`: 3 × (6.700 × 2,20 + 150 × 11) / 1.000.000 =
0,049 USD fürs Gehirn, mit dem Anbieter etwa 0,129 USD je Minute. Die Freigabe
nennt dazu den Höchstbetrag je Gespräch (`maxMinuten`), mit Telefon ausdrücklich
ohne die Gebühren des Telefonanbieters. Beim Gehirn `bruecke` rechnet tybos
eigener Motor ab (Abo oder API); dann nennt die Freigabe nur den Anteil des
Anbieters, sagt, dass das Gehirn fehlt, und nennt keine Obergrenze je Gespräch.
Für ein Modell ohne Preis in der Grundlage steht „unbekannt“ da. Wer andere
Preise hat, legt `config/voice-agent-preise.json` im Format von
`config/voice-agent-preise.example.json` an; die Freigabe nennt dann diese Datei
als Preisstand.

**Grenzen:** Höchstens drei Entwürfe laufen gleichzeitig. Die Beschreibung darf
2.000 Zeichen lang sein. Verworfene und abgebrochene Entwürfe bleiben unter
`data/voice-agents/entwuerfe/` liegen, bis ein neuer Entwurf derselben Kennung
die Ablage übernimmt oder jemand sie von Hand löscht.

Code: `src/lib/voice-agents/drafts.ts` (Ablauf), `brief.ts` (Auftrag),
`draft-jobs.ts` (Jobs), `voice-catalog.ts` (Stimmen), `cost.ts` (Kosten),
`unlock.ts` (Freischaltung).

### Wizard im Browser

Der Wizard ist eine zweite Oberfläche auf demselben Kern wie
`/sprachagent neu`, so wie Terminal und Browser bei `tybo setup`
(Entscheidung 0011). Ein Satz genügt: tybo füllt die Felder vor, der Nutzer
korrigiert, und gebaut wird mit demselben Job, derselben Prüfung
(`parseRecipe`), demselben Nachbesserungslauf und denselben Rückfragen
(Stimmwahl, Freigabe, Tests, Freischaltung) wie beim Befehl. Alle Routen
liegen hinter dem Login mit Origin-Prüfung. Lesen geht auch mit dem
Terminal-Schlüssel, alles andere nur im Browser.

**Oberfläche:** Im Bereich `/sprachagenten` führt der Knopf „Neu“ in fünf
Schritte: Zweck (ein Satz, daraus der Vorschlag), Stimme (mit Hörprobe je
Stimme), Wissen und Verhalten (je Vorlage), Zugang (Browser, Telefon, Kosten)
und Prüfen und Starten (Zusammenfassung in Klartext, „Bauen“). Der Entwurf
entsteht schon in Schritt 1, sobald eine gültige Kennung dasteht (nach kurzer
Pause, spätestens mit „Weiter“ oder beim Verlassen); was davor getippt ist,
etwa nur der Satz, hält der Browser bis dahin. Danach speichert jeder
Schrittwechsel sofort und jede Änderung nach kurzer Pause, auch Satz und
Kennung. Unfertige Eingaben (ein halber Link, Telefon ohne fertige Kennung
der Nummer) bleiben gespeichert, gebaut wird erst, wenn sie stimmen. Schalter,
die aus stehen, sind auch im Rezept aus. Offene Entwürfe stehen unter der
Liste der Agenten und öffnen sich im zuletzt bearbeiteten Schritt, fertige und
abgebrochene bleiben sieben Tage unter „Zuletzt beendet“. Bauen läuft im
Hintergrund, die Seite darf zu sein. Rückfragen beantwortet der Wizard nicht
selbst: Schritt 5 sagt, was im Direktchat zu entscheiden ist, und verlinkt
ihn. Nach dem Bauen zeigt der Wizard die Schritte nur noch an, Änderungen
gehen mit `/sprachagent aendern <kennung>`. Die festen Regeln stehen sichtbar
im passenden Schritt, ohne Schalter.

| Route | Wozu |
|---|---|
| `POST /api/voice-agents/wizard/vorschlag` `{ satz }` | Vorschlag aus einem Satz (höchstens 500 Zeichen) |
| `GET /api/voice-agents/wizard/entwuerfe` | offene Entwürfe des Wizards, zuletzt geändert zuerst, je mit dem Schritt zum Fortsetzen; unter `beendet` fertige und abgebrochene der letzten sieben Tage |
| `GET /api/voice-agents/wizard/stimmen` | Standardstimme (ohne Kennung) und Stimmen des Kontos beim Anbieter |
| `POST /api/voice-agents/wizard/hoerprobe` `{ voiceId }` oder `{ standard: true }`, dazu `sprache` | Ton: der KI-Hinweis mit genau dieser Stimme |
| `GET /api/voice-agents/wizard/<kennung>` | Entwurf mit Feldern, festen Regeln, Anhängen, Kosten und Stimme |
| `PUT /api/voice-agents/wizard/<kennung>` `{ revision?, satz?, schritt?, felder, offen? }` | ohne `revision` anlegen (201), mit `revision` speichern (200); `offen` sind unfertige Eingaben, getrennt von `felder` |
| `POST …/<kennung>/umbenennen` `{ revision, kennung }` | Kennung vor dem Bauen ändern; Felder, Satz, Schritt und Anhänge ziehen mit um |
| `DELETE /api/voice-agents/wizard/<kennung>` | noch nicht gebauten Entwurf verwerfen, Kennung frei |
| `POST …/<kennung>/anhaenge` (Rohdaten, Name in `x-file-name`) | Datei für die Recherche |
| `DELETE …/<kennung>/anhaenge/<datei>` | Datei entfernen |
| `POST …/<kennung>/bauen` `{ revision }` | bauen wie `/sprachagent neu` (202) |
| `GET …/<kennung>/fortschritt` | Phase, Versuch, Prüfungsfehler, offene Rückfrage (`stimme`, `freigabe`, `freischalten`, `fortsetzen`), Testergebnisse, Freischaltung, Web-Zugang |

**Vorschlag:** Das Nebenmodell `voice-wizard` (Einstellung
`aux["voice-wizard"]`, sonst `AUX_MODEL_VOICE_WIZARD`, sonst Claude Haiku)
schlägt Vorlage, Name, Zweck, Persona, eigene Regeln und beim Experten Training
und Thema vor; die Kennung bildet tybo aus dem Namen. Es hat 20 Sekunden.
Antwortet es nicht, scheitert es oder passt die Antwort nicht genau zum Schema
(auch ein Feld zu viel), gibt es leere Felder mit Vorlage `experte` und einen
Hinweis, der Wizard läuft weiter. Höchstens zehn Vorschläge in zehn Minuten,
auch gescheiterte, und einer zur Zeit; sonst 429 mit `Retry-After` in
Sekunden. Gezählt wird im Bot-Prozess, ein Neustart setzt das zurück.

**Entwurf und Zuordnung:** Die Kennung im Pfad ist die des künftigen Agenten.
Das Anlegen reserviert `data/voice-agents/entwuerfe/<kennung>/` wie ein
geprüfter Entwurf aus `/sprachagent neu`: Der Entwurfsdienst legt einen
Entwurf in der Phase `wizard` an und schreibt seine ID nach `entwurf-id`;
`wizard.json` daneben nennt dieselbe ID. Nur wenn beide übereinstimmen, gehört
der Ordner dem Wizard. Gibt es den Agenten schon, ist die Antwort 409
`vergeben`; hält ein anderer offener Entwurf die Kennung, 409 `belegt`.
Umgekehrt sieht ein Entwurf aus `/sprachagent neu` die Kennung als belegt.
Nicht als Kennung gehen `session`, `rezept`, `test`, `link` und `loeschen`
(diese Pfade gehören einem Agenten namens `wizard`) sowie `vorschlag`,
`entwuerfe`, `stimmen` und `hoerprobe`. Unvollständige Entwürfe lassen sich speichern, leere Texte gelten
als nicht gesetzt. Ein `PUT` ohne `satz` behält den Ausgangssatz, `satz: ""`
löscht ihn. Bricht das Anlegen nach der Reservierung ab (Schreibfehler,
Neustart vor `wizard.json`), nimmt tybo die Reservierung beim Schreibfehler
zurück; nach einem Neustart übernimmt das nächste Anlegen derselben Kennung
sie, und Verwerfen gibt sie frei. Das gilt auch, wenn noch die `wizard.json`
eines früheren, beendeten Wizards derselben Kennung im Ordner liegt; nennt sie
einen Entwurf, der nicht beendet ist, bleibt die Kennung belegt. Die Kennung
bleibt so nie dauerhaft belegt.
Jede Änderung schickt die zuletzt gelesene `revision` mit;
eine veraltete ergibt 409 mit der aktuellen. Alle Änderungen laufen
nacheinander (Sperre `entwuerfe/.steuerung/wizard.lock`), deshalb gewinnt von
zwei gleichzeitigen genau eine. Nach dem Bauen lässt sich nichts mehr ändern
oder verwerfen (409 `gebaut`). Ordner und Dateien müssen echt sein, ein
symbolischer Link ergibt einen Fehler, und eine ungültige Kennung erreicht nie
einen Ordner. `wizard.json` ist kein zweites Rezeptformat: Sie hält Vorgaben,
die nach dem Job ins Rezept kommen. Sie merkt sich auch den zuletzt
bearbeiteten Schritt der Oberfläche (`schritt`, 1 bis 5).

**Kennung ändern:** Die Kennung ist ab dem ersten Speichern reserviert.
`umbenennen` reserviert die neue, zieht `wizard.json` und `anhaenge/` um und
gibt die alte frei; die Antwort ist der Entwurf unter der neuen Kennung. Ist
die neue vergeben (409 `vergeben`), belegt (409 `belegt`) oder gehört sie
schon einem offenen Wizard (409 `existiert`), bleibt der Entwurf unter der
alten Kennung, wie er war. Eine ungültige Kennung ergibt 422, nach dem Bauen
409 `gebaut`.

**Stimme und Hörprobe:** `felder.stimme` ist `{ wahl: "standard" }` oder
`{ wahl: "konto", voiceId }`. Mit einer Wahl entfällt die Stimmwahl im
Direktchat: Bei `konto` steht genau diese Kennung im Rezept, eine andere, die
der Job hineinschreibt, lehnt die Prüfung ab; bei `standard` friert tybo die
Standardstimme beim Bauen ein wie bisher. Ohne das Feld fragt tybo nach dem
Job im Direktchat. Gibt es die Stimme des Kontos beim Bauen nicht mehr, lehnt
Bauen mit 422 ab. Die Hörprobe spricht den festen KI-Hinweis der angegebenen
Sprache (`sprache`, sonst Deutsch) mit genau der genannten Stimme. Erlaubt
sind nur Kennungen aus der Stimmenliste, Text nimmt die Route nicht an, der
Ton wird nicht gespeichert. Höchstens zehn Hörproben in zehn Minuten und eine
zur Zeit (sonst 429 mit `Retry-After`), nach 15 Sekunden 504, ohne Zugang zum
Anbieter 503. Die Hörprobe des Telefonhörers in den Einstellungen bleibt, wie
sie ist.

**Felder je Vorlage:** `gehirn.denkauftrag` gibt es nur bei Jarvis.
`anrufannahme.fragen` (höchstens acht, je 200 Zeichen) und
`anrufannahme.abschlusssatz` (höchstens 466 Zeichen) werden bei der
Anrufannahme zu eigenen Regeln („Frage den Anrufer nach: …“, „Beende das
Gespräch mit dem Satz: …“); das Rezeptformat bleibt unverändert, und sie
zählen nicht gegen die Höchstzahl eigener Regeln. Training, Thema, Links und
Anhänge gelten nur beim Experten. Felder anderer Vorlagen bleiben im Entwurf
gespeichert, gehen aber nicht ins Rezept und nicht an den Job; so gehen sie
bei einem Vorlagenwechsel nicht verloren. Das Gedächtnis folgt der Vorlage
(Anrufannahme `keins`, Experte `thema`).

**Fortschritt:** `tests` nennt das Ergebnis des Testlaufs dieses Entwurfs je
Test (Name, Status, bei durchgefallenen der Grund in einem Satz, nie den
Gesprächsverlauf). tybo hält dafür die Kennung des Laufs im Entwurf fest, bei
jedem Ausgang, und liest ihn aus `testlauf.json`; liegt er dort nicht mehr,
steht `fehlt` da. `freigeschaltet` und `web` sagen, ob „Sprechen“ möglich
ist.

**Feste Regeln:** Sie liegen auf dem Server, der Entwurf meldet sie in `feste`
und bei den Regeln mit `fest: true`:

- KI-Hinweis als erster Satz, bei jeder Vorlage, also strenger als das Rezept,
  das ihn nur bei Fremden verlangt. Der Text steht fest („Hallo, hier spricht
  eine KI, ein automatischer Sprachassistent.“, bei erster Sprache Englisch
  „Hello, this is an AI, an automated voice assistant.“). Der Prompt beginnt
  die Begrüßung damit, beim Anbieter steht er vorn im ersten Satz
  (`first_message`).
- die festen Regeln der Vorlage, darunter die Notfall-Regel 112
- `anrufannahme` immer `gedaechtnis: keins`
- `gedaechtnis: voll` am Telefon nur mit PIN

Fehlt ein Wert, setzt der Server ihn. Wer ihn ausdrücklich leert, umformuliert,
eine feste Regel aus der Liste `regeln` nimmt oder eine eigene als fest
ausgibt, bekommt 422 `fest`; gespeichert wird dann nichts. Wird `regeln`
geschickt, gehören die festen Einträge dazu, so wie `GET` sie liefert. Damit
die Oberfläche das auch nach einem Vorlagenwechsel kann, nennen Entwurf und
Vorschlag unter `festeRegeln` die festen Regeln je Vorlage. Bauen
nimmt nur `{ revision }`; alles andere im Körper ergibt 422. Eine von Hand
geänderte `wizard.json`, die feste Werte verletzt, zeigt der Entwurf unter
`festFehler`, und Bauen lehnt mit 422 ab. Die Kennzeichen `fest` gelangen nie
ins Rezept.

**Bauen:** Pflicht sind Vorlage, Name und Zweck (sonst 422 mit Liste).
tybo startet denselben Job wie bei `/sprachagent neu`, mit Satz, Name und
Zweck als Beschreibung und den Feldern als Vorgaben im Auftrag. Die
Beschreibung bleibt auch bei den Höchstlängen unter 2.000 Zeichen und wird nie
gekürzt; das Thema der Recherche steht vollständig in einem eigenen Abschnitt
des Auftrags, auch beim Nachbesserungslauf. Nach dem Job
legt tybo die Vorgaben über das Rezept des Jobs, bevor `parseRecipe` prüft: Was
der Nutzer im Wizard festgelegt hat, gilt, auch wenn der Job etwas anderes
schreibt; was fehlt (Tests, Nachlauf, Wissensdatei), ergänzt der Job. Die
eigenen Regeln sind immer die aus dem Wizard. Telefon kommt nur ins Rezept,
wenn es im Wizard gewählt ist. Bei gleichen Feldern und gleicher Ausgabe des
Jobs entsteht genau das Rezept, das `/sprachagent neu` erzeugt, mit derselben
eingefrorenen Stimme und derselben Wissensdatei. Rückfragen und Meldungen gehen
in den Direktchat (ohne Telegram der der WebUI). Ein zweites oder
gleichzeitiges Bauen ergibt 409, es läuft genau ein Job. Startet der Job
nicht, bleibt der Entwurf in der Phase `wizard` und lässt sich erneut bauen.
Nach einem Neustart verfolgt der Bot den Job weiter wie jeden Entwurf.

**Anhänge und Links:** PDF (am Dateikopf erkannt, höchstens 10 MB), Text
(`.txt`) und Markdown (`.md`, gültiges UTF-8, höchstens 1 MB), höchstens fünf
je Entwurf. Sie liegen dauerhaft unter `entwuerfe/<kennung>/anhaenge/`, nicht
in der Ablage des Web-Chats, die ungesendete Dateien nach 24 Stunden löscht.
Vor dem Lesen und Entfernen prüft tybo, dass `anhaenge/` ein echter Ordner
und die Datei eine normale Datei ist; ein symbolischer Link ergibt einen
Fehler, ohne dass sich draußen etwas oder die `revision` ändert.
Beim Bauen prüft tybo ihre Prüfsumme und kopiert sie nach `eingaben/` im
eingeschränkten Arbeitsordner des Jobs; Links (nur `https`, höchstens zehn)
stehen im Auftrag. Beides steht dort ausdrücklich als fremder Inhalt: Material
für die Recherche, keine Anweisungen, keine Regeln daraus.

**Kosten:** Der Entwurf nennt `kosten` für die aktuelle Auswahl mit derselben
Grundlage wie die Freigabe (Tabelle oben): je Minute, je Gespräch von
`maxMinuten`, Preisstand, Quellen und Hinweise. Ohne gewähltes Gehirn gilt das
der Vorlage. Fehlt `maxMinuten`, fehlt der Betrag je Gespräch; beim Gehirn
`bruecke` steht nur der Anteil des Anbieters da und keiner je Gespräch; für ein
Modell ohne Preis und bei ungültiger Preisdatei heißt es `unbekannt`.
**Credits:** Eine feste Zahl Credits je Gesprächsminute nennt ElevenLabs
nicht. Gesprächsminuten zählen gegen das Minutenkontingent des Plans, die
Gebühren des Modells zieht der Anbieter von den Credits ab
([Preisseite Agents](https://elevenlabs.io/pricing/agents)). Ein Guthaben in
Dollar rechnet der Anbieter zum Satz des aktuellen Plans in Credits um
([Pay As You Go](https://elevenlabs.io/docs/overview/administration/pay-as-you-go):
„Each plan has its own credit-to-dollar rate“). tybo zeigt deshalb den
Gegenwert des Dollarbetrags zum Satz des Creator-Plans, abgerufen am 9.11.2026
von der [Preisseite](https://elevenlabs.io/pricing): 121.000 Credits für 22 USD
im Monat, also 5.500 Credits je USD, aufgerundet auf ganze Credits. Beispiel
`claude-haiku-5-5` mit 10 Minuten: 0,0825 USD je Minute ergeben 454 Credits,
ein Gespräch 0,8246 USD, also 4.536 Credits. Andere Pläne rechnen anders um
(Pro: 600.000 Credits für 99 USD). Wer einen anderen Plan hat, trägt in
`config/voice-agent-preise.json` unter `credits` eigene Werte ein (`jeEinheit`
Credits je Einheit der Währung, `tarif`, `quelle`); fehlt der Eintrag in einer
eigenen Datei, ist `credits` leer, und ein Hinweis sagt warum.

**Stimme:** Der Entwurf meldet nur, ob eine Standardstimme eingestellt ist,
nie ihre Kennung. Beim Bauen gilt dieselbe Regel wie bei `/sprachagent neu`:
Stimmwahl aus dem Konto, wenn der Job eine Stimme beschreibt und passende
findet, sonst die Standardstimme vom Zeitpunkt der Prüfung, eingefroren im
Rezept. Eine persönliche Stimmen-ID steht nirgends im Repo.

Code: `src/lib/voice-agents/wizard.ts` (Felder, feste Regeln, Vorschlag),
`wizard-store.ts` (Ablage), `drafts.ts` (`reserveWizard`, `startWizard`),
`src/web/voice-agent-wizard.ts` (Routen), `src/web/bot-voice-agent-wizard.ts`
(Verdrahtung, Rate-Limit, Kosten, Stimmenliste, Hörprobe, Fortschritt),
`src/web/public/sprachagent-wizard.js` (Oberfläche) und
`sprachagent-wizard-state.js` (Zustand, ohne Browser geprüft). In `web:dev`
läuft der Wizard gegen eine Attrappe ohne Anbieter und ohne Job
(`src/web/demo-voice-agent-wizard.ts`); den Durchlauf im Browser macht
`bun run scripts/web-sprachagent-wizard-check.ts`.

### Sprach-Brücke und Gedächtnisstufen

Agenten mit `gehirn.art: bruecke` schicken den Kopf `x-tybo-rezept`. Das Rezept
bestimmt dann Prompt, Modell (`gehirn.modell`) und wie viel das Gespräch von tybo
bekommt. Den System-Text aus der Anfrage nimmt die Brücke in diesem Fall nicht.

- **Ohne Kopf:** alles wie vor den Rezepten, mit `VOICE_MODEL`, Rufnummernprüfung
  und `VOICE_ALLOW_UNIDENTIFIED`. Der von Hand angelegte Agent läuft unverändert.
- **Unbekannte Kennung:** Auch bei einem leeren oder nicht aufgelösten Kopf, einem
  beschädigten Rezept oder einem Rezept mit `gehirn.art: anbieter` gibt es die
  kurze Absage, nie den Betrieb ohne Rezept.

| Stufe | Prompt | Gespräch bekommt | Merk-Tags | Verlauf |
|---|---|---|---|---|
| `keins` | Rezept | nichts von tybo | nein | keiner |
| `thema` | Rezept und Wissensdatei | nichts von tybo | nein | `data/voice-agents/<kennung>/verlauf.jsonl` |
| `voll` | Rezept und tybo-Kontext | Profil, Gedächtnis, Verlauf, `history_search`, Denkauftrag bei `gehirn.denkauftrag: true` | ja | Verlauf des Nutzers |

Was im laufenden Gespräch gesagt wurde, kennt das Modell auf jeder Stufe, denn der
Anbieter schickt es mit jedem Zug. Bei `keins` und `thema` spricht das Modell nach
einem eigenen Sprechstil, ohne Hinweis auf persönliche Werkzeuge und Merk-Tags. Ein
Denkauftrag wird dort live beantwortet und nicht an tybo übergeben. Von den Werkzeugen
der Anfrage bleiben auf jeder Stufe nur `end_call`, `language_detection` und die, die
das Rezept nennt.

**Die Stufe im Rezept ist eine Obergrenze.** Was der Anrufer nicht nachweist, bekommt
er nicht:

- **`voll` am Telefon** verlangt eine freigeschaltete Nummer und eine bestätigte PIN.
  `pin: true` im Rezept ist kein Nachweis. Die Bestätigung kommt erst mit SA3-2: Bis
  dahin fällt jedes Telefonat eines Rezepts mit `voll` auf `keins` zurück, auch von
  der eigenen Nummer.
- **`voll` im Web** verlangt eine Web-Freigabe für genau diese Gesprächs-ID und dieses
  Rezept. Sobald eine Rufnummer gemeldet ist, zählt sie nicht. `VOICE_ALLOW_UNIDENTIFIED`
  ist bei Rezepten nie ein Nachweis.
- **`thema`** gibt es am Telefon nur für freigeschaltete Nummern. Ohne gemeldete Nummer
  verlangt ein Rezept mit `anrufer: freigegeben` eine Web-Freigabe, denn es kann ein
  Anruf mit unterdrückter Nummer sein. Ein Rezept ganz ohne Telefon braucht ohne Nummer
  keine, weil der Anbieter dort ein Token aus dem Server verlangt.
- **Beim Rückfall** bleibt das Gespräch auf `keins`, der Prompt nennt die fehlende
  Prüfung, und von den Rezept-Werkzeugen bleibt nur `pin_pruefen`.

**Wissensdatei:** Bis 40.000 Zeichen steht sie im Prompt, mit Prompt-Caching beim
Modell. Die Brücke hält sie zehn Minuten im Speicher und liest sie früher neu, wenn sich
Größe oder Änderungszeit ändern oder das Rezept auf eine andere Datei zeigt. Ist sie
größer, fehlt sie oder ist sie nicht lesbar, sagt der Prompt, dass das Themenwissen
nicht zur Verfügung steht. Die Suche `wissen_suchen` kommt erst mit SA2-1; bis dahin
erreicht der Agent eine größere Datei also gar nicht.

**Web-Freigabe:** Die WebUI läuft im Bot, die Brücke als eigener Prozess. Beide teilen
sich `data/voice-agents/<kennung>/web-calls/`, je Gespräch eine Datei. Die Prüfsumme
(HMAC mit einem Schlüssel aus `VOICE_BRIDGE_TOKEN`) bindet Rezept, Gesprächs-ID und
Ablauf aneinander; die Gesprächs-ID kommt bei der Brücke aus `system__conversation_id`,
das nur der Anbieter setzt. Ein neues Token macht alle offenen Freigaben ungültig.
Ausgestellt wird sie beim Start eines Gesprächs im Browser (nächster Abschnitt) und
beim Auflegen zurückgenommen.

**Log:** Je Zug eine Zeile mit `rezept=`, `stufe=` und, wenn vorhanden, `angefragt=` oder
`wissen=`. Keine Inhalte, Rufnummern oder Gesprächs-IDs. Fehler stehen dort nur mit Art
und HTTP-Status, auch im Betrieb ohne Rezept, weil Fehlertexte Inhalte enthalten können.

Code: `src/lib/voice-bridge/recipes.ts`, `src/lib/voice-agents/web-calls.ts`,
`knowledge.ts`, `transcript.ts`.

### Gespräch im Browser

Experten und Jarvis lassen sich im Browser sprechen, nur nach der Anmeldung in der
WebUI. Gast-Links gibt es nicht, und das Rezept kennt kein Feld `gaeste`: Experten
sind nur für den Nutzer selbst.

**Seite:** `/sa/<kennung>`, die Adresse liefert `/sprachagent link`. Ohne Anmeldung
antwortet sie mit 401 und einem Verweis auf die Anmeldung, für unbekannte Kennungen
und Rezepte ohne `zugang.web.link: true` mit 404. Die Seite zeigt Name, ob ein
Gespräch möglich ist (sonst den Grund) und die Minuten im Monat.

**Sprechen:** Für das Mikrofon am Handy den bereits eingerichteten HTTPS-Zugang
verwenden. Die HTTP-Adresse im Heimnetz reicht nur zum Öffnen der Seite; auf dem
Rechner ist auch `http://localhost` ein sicherer Kontext.
Der Knopf „Sprechen“ fragt zuerst nach dem Mikrofon; solange der Browser darauf
wartet, ist noch nichts reserviert. Dann holt er das Token (Start unten), lädt
erst jetzt das SDK des Anbieters und verbindet über WebRTC mit genau diesem Token.
Die Seite
zeigt „Verbinde …“, dann „Verbunden. Hört zu.“ bzw. „Spricht.“. „Auflegen“
trennt die Verbindung, wartet, bis der LiveKit-Raum des SDK wirklich getrennt ist
(höchstens 15 Sekunden), und meldet erst dann das Ende; danach steht dort, wie
viele Minuten gebucht sind. Das gilt auch, wenn der Agent auflegt: Das SDK meldet
sein Ende, bevor der Raum zu ist. Kommt die Verbindung nicht
zustande, meldet die Seite das Ende ebenso und bietet „Noch einmal sprechen“ an.
Auch beim Verlassen der Seite wird zuerst getrennt und erst danach das Ende
gemeldet. Solange Tokenabruf, Verbindungsaufbau oder Auflegen noch laufen, bleibt
ein neuer Start gesperrt. Lässt sich die Verbindung nicht trennen oder das Ende
nicht melden, bleibt „Noch einmal auflegen“ stehen. Meldet der Server ein
laufendes Gespräch aus einem anderen Tab, zeigt die Seite nur einen Hinweis:
dort auflegen und diese Seite neu laden, mit der Uhrzeit, zu der der Platz
spätestens frei ist. Ein anderer Tab kann die Verbindung nicht durch eine
Endemeldung trennen.

**Wer entscheidet, ob ein Gespräch vorbei ist:** ElevenLabs, nie die Seite. Die
Seite kann eine Trennung nicht sicher belegen: Ein gescheiterter oder hängender
Verbindungsaufbau kann beim Anbieter trotzdem einen offenen Raum haben, und ein
ausgegebenes Token kann bis zu seinem Ablauf noch verbinden. Die Endemeldung der
Seite ist deshalb nur ein Anlass: Der Server fragt beim Anbieter nach
(`GET /v1/convai/conversations/<id>`, Feld `status`) und gibt Platz, Web-Freigabe
und Minuten erst frei, wenn ElevenLabs das Ende belegt. Bis dahin steht auf der
Seite „Aufgelegt. ElevenLabs hat das Ende noch nicht bestätigt“. Dieselbe
Nachfrage stellt der Server vor jedem Start und beim Laden der Seite, sodass ein
vergessenes Ende (Tab geschlossen, Netz weg) sich von selbst klärt. Folge: Kommt
eine Verbindung gar nicht zustande, bleibt der Platz belegt, bis das Token
abgelaufen ist (bei ElevenLabs 15 Minuten nach Ausgabe, laut Feld `exp`), denn
bis dahin könnte es noch verbinden.

**SDK:** `@elevenlabs/client` (MIT, enthält `livekit-client`, Apache-2.0) liegt fest
eingecheckt unter `src/web/public/vendor/elevenlabs/`, dazu das eine Worklet, das
der WebRTC-Weg lädt, die Lizenzen und `VERSION.json` mit den Prüfsummen. Kein
npm-Paket zur Laufzeit, kein CDN, ausgeliefert nur nach der Anmeldung. Eine neue
Fassung holt `bun run scripts/vendor-elevenlabs.ts <version>` aus der npm-Registry
und prüft die Integrität des Pakets. Den Bereich Sprachagenten mit Liste, Detail
und Stumm baut SA1-7 (Issue #495) auf diese Seite.

**Start:** `POST /api/voice-agents/<kennung>/session` (hinter Login, nur aus dem
Browser, gleiche Origin-Prüfung wie alle schreibenden Routen). Der Server prüft der
Reihe nach:

1. Rezept bekannt (sonst 404), nicht beschädigt (sonst 409)
2. `zugang.web.link: true` (sonst 403, `kein_web`)
3. freigeschaltet für genau diese Fassung samt Wissensdatei (sonst 403, `gesperrt`)
4. beim Anbieter in genau dieser Fassung abgeglichen: `agentId` und `letzterHash` in
   `state.json`, nichts ausstehend (sonst 409, `nicht_abgeglichen`)
5. `ELEVENLABS_API_KEY` gesetzt, bei `gehirn.art: bruecke` auch `VOICE_BRIDGE_TOKEN`
   (sonst 503)
6. unter der Sperre der Kennung: kein laufendes Gespräch (sonst 409, `laeuft`),
   Rate-Limit und Minutenbudget (sonst 429 mit `Retry-After`); dann wird reserviert
7. Token beim Anbieter holen (`GET /v1/convai/conversation/token`, zehn Sekunden,
   ohne Sperre). Scheitert das, 502 mit eigenem Satz, die Reservierung fällt weg
8. wieder unter der Sperre: Die Reservierung ist noch offen, sonst 409
   (`abgebrochen`, etwa nach Ablauf der Reservierung). Schritte 2 bis 5
   gelten noch, und Rezept, Wissensdatei und Agent beim Anbieter sind dieselben wie
   bei der Reservierung, sonst 409 (`geaendert`) bzw. der Grund aus 2 bis 5. In
   beiden Fällen gibt es weder Token noch Freigabe, und die Reservierung fällt weg
   (eine schon beendete bleibt mit ihren Minuten stehen)
9. nur bei `gehirn.art: bruecke`: Web-Freigabe für die Gesprächs-ID aus der Antwort
   des Anbieters, gültig bis zur harten Grenze der Reservierung (siehe unten). Bei
   `anbieter` (Normalfall beim Experten) gibt es keine Freigabe

Vor Schritt 6 fragt der Server für jedes offene Gespräch beim Anbieter nach, ob
es vorbei ist (siehe „Auflegen“); nur was ElevenLabs als beendet belegt, gibt den
Platz frei.

Die Antwort enthält `conversationToken`, `conversationId`, `connectionType: "webrtc"`,
`expiresInSec` (verbleibende Gültigkeit des Tokens laut dessen `exp`; ein Token ohne
`exp` wird gar nicht ausgegeben, siehe „Harte Grenze“) und `maxMinuten`, mit
`Cache-Control: no-store`. Den Schlüssel
des Anbieters sieht der Browser nie. Ins Log kommen Kennung, Ausgang und ein kurzer
Hash der Gesprächs-ID, nie Token, Schlüssel oder Fehlertext des Anbieters.

**Auflegen:** `POST /api/voice-agents/<kennung>/session/end` mit
`{ "conversationId": "…" }`, erst nachdem der LiveKit-Raum der zugehörigen
SDK-Verbindung als getrennt bestätigt ist oder der Start ohne Verbindung abgebrochen
wurde. Bestätigt die Seite das Trennen nicht (Zeitgrenze, Fehler, kein Raum), meldet
sie nichts. Ohne gültige Gesprächs-ID
antwortet der Server mit 400 und ändert nichts, für ein unbekanntes oder schon
beendetes Gespräch mit 404. Die ID liefert nur der Start; die Zustandsroute
verrät sie nicht.

Die Meldung beendet nichts selbst. Der Server fragt
`GET /v1/convai/conversations/<id>` beim Anbieter (sofort, nach 1,5 und nach 3
Sekunden, weil der Status kurz nach dem Auflegen noch `in-progress` sein kann):

| Antwort von ElevenLabs | Folge |
|---|---|
| `done`, `failed` oder `processing` | beendet: 200 mit den gebuchten Minuten (`metadata.call_duration_secs`, aufgerundet, mindestens eine, höchstens `maxMinuten`) |
| `initiated` oder `in-progress` | 202 `ausstehend` (`anbieter_aktiv`), alles bleibt |
| 404, solange das Token noch gilt | 202 `ausstehend` (`anbieter_aktiv`), alles bleibt: das Token könnte noch verbinden |
| 404 nach Tokenablauf plus einer Minute | beendet, nie zustande gekommen, null Minuten |
| nicht erreichbar, anderer Fehler, unlesbar | 202 `ausstehend` (`anbieter_unklar`), alles bleibt |

„Alles bleibt“ heißt: Platz belegt, Web-Freigabe gültig, `maxMinuten` gebucht. Bei
beendet wird erst die Freigabe gelöscht, dann das Ende gespeichert: Scheitert das
Löschen, antwortet der Server mit 503 (`widerruf`), das Gespräch gilt weiter als
laufend, und ein zweites Auflegen versucht es noch einmal.

**Harte Grenze:** Ohne Nachweis gilt ein Gespräch bis Tokenablauf plus `maxMinuten`
plus eine Minute als laufend. Später gibt es es sicher nicht mehr: Bis zum
Tokenablauf kann es beginnen, und beim Anbieter dauert es höchstens `maxMinuten`
(`max_duration_seconds`). Danach ist der Platz frei, auch wenn ElevenLabs nie
antwortet; gebucht bleiben `maxMinuten`. Den Tokenablauf liest der Server aus dem
Token (Feld `exp`) und übernimmt ihn unverändert. Ein Token ohne lesbaren Ablauf
oder mit mehr als 60 Minuten gibt er nicht an den Browser weiter (502 mit Grund
`token_ablauf`); die Reservierung wird zurückgenommen, weil nichts ausgegeben
wurde. Ein angenommener kürzerer Ablauf würde Platz, Freigabe und Minuten zu
früh freigeben, während das Token noch verbinden könnte.

**Zeitlimit der Anfragen:** Start, Zustand und Ende fragen ElevenLabs, beim Ende
bis zu dreimal mit Wartezeiten dazwischen. Das kann länger dauern als die
Ruhezeit des Web-Servers (10 Sekunden); diese Anfragen bleiben deshalb offen,
bis die Antwort fertig ist. Jeder einzelne Abruf beim Anbieter ist auf 10
Sekunden begrenzt.

**Grenzen je Rezept** (`data/voice-agents/<kennung>/web-sitzungen.json`, übersteht
einen Neustart; ist die Datei beschädigt, gibt es kein Gespräch, bis sie weg ist):

| Grenze | Wert |
|---|---|
| Gleichzeitig | ein Gespräch |
| Starts | höchstens 6 Anfragen beim Anbieter in 10 Minuten, auch gescheiterte |
| Minuten im Monat | `zugang.budget.minutenMonat`, Kalendermonat in der Zeitzone des Rechners |

Jeder Start bucht erst `maxMinuten`. Bestätigt ElevenLabs das Ende, gilt die
Dauer laut Anbieter, auf ganze Minuten aufgerundet; ohne Bestätigung bleiben
`maxMinuten` gebucht. Reicht der Rest des
Budgets nicht für `maxMinuten`, gibt es kein Gespräch bis zum Monatsanfang. Gezählt
werden nur Gespräche im Browser, Anrufe nicht.

**Zustand:** `GET /api/voice-agents/<kennung>` liefert Name, Gehirn, `maxMinuten`,
gebuchte Minuten, laufendes Gespräch (Beginn und harte Grenze), `bereit` und sonst
Grund. Vorher fragt der Server zu offenen Gesprächen beim Anbieter nach.

**Sicherheitsköpfe:** Nur die ausgelieferte Gesprächsseite bekommt in `connect-src`
die Hosts `https://api.elevenlabs.io`, `wss://api.elevenlabs.io`,
`wss://livekit.rtc.elevenlabs.io` und `https://livekit.rtc.elevenlabs.io` und die
`Permissions-Policy` `microphone=(self), camera=(), geolocation=(), payment=(), autoplay=(self)`.
Alle anderen Antworten behalten die bisherigen Köpfe, Sprechmodus und Telefonhörer
also ihr Mikrofon. Datenresidenz (EU-Hosts) ist nicht vorgesehen.

Code: `src/web/bot-voice-agent-session.ts` (Prüfungen, Token, Freigabe, Nachfrage beim Anbieter),
`src/web/voice-agent-page.ts` (Pfade, Texte, Hosts),
`src/lib/voice-agents/web-sessions.ts` (Reservierung, Rate-Limit, Budget),
`src/web/server.ts` (Routen, Köpfe), `src/web/public/sprachagent.*` (Seite),
`src/web/public/vendor/elevenlabs/` (SDK). Browser-Durchlauf mit SDK- und
Anbieter-Attrappe: `bun run scripts/web-sprachagent-check.ts`; die Attrappe gibt
Tokens mit `exp` aus wie ElevenLabs und prüft auch die Ablehnung eines Tokens ohne
`exp`.

### Nach dem Gespräch: Nachlauf und Training

ElevenLabs schickt nach jedem Gespräch das Protokoll an den Post-Call-Webhook
(`/webhook/elevenlabs`, nur im Profil `server`, siehe
[Telegram per Webhook](telegram-webhook.md)). Der Webhook gilt je Arbeitsbereich,
also für alle Agenten. tybo entscheidet deshalb, wem ein Protokoll gehört:

1. Liegt das Gespräch schon beim Rezept, bleibt es dort.
2. `agent_id` ist die aktuelle oder eine frühere Agent-Kennung eines Rezepts
   (`state.json`, Feld `bekannteAgentIds`). Ersetzt ein Abgleich den Agenten oder
   wird er entfernt, findet ein verspätetes Protokoll sein Rezept trotzdem.
3. Die Gesprächs-ID stammt aus einem Web-Gespräch des Rezepts (`web-sitzungen.json`).
4. Sonst geht es wie bisher an den Anrufdienst: `/anruf` und Anrufe, die tybo nicht
   gewählt hat, mit Zusammenfassung, Verlauf und Rückfrage.

Ist eine dieser Dateien beschädigt, ist die Zuordnung unklar: Der Webhook antwortet
mit 500 und ElevenLabs stellt erneut zu. Ein Rezept-Gespräch landet so nie als
fremder Anruf im Direktchat. Ausnahme ist der Agent aus `ELEVENLABS_AGENT_ID`, er
geht immer an den Anrufdienst. Weil der Webhook nur im Profil `server` ankommt,
müssen Rezepte und `data/voice-agents/` auf dem Server liegen.

**Ablage:** `data/voice-agents/<kennung>/gespraeche/<gesprächs-id>.json` mit
Protokoll, Zeitpunkt des Gesprächs und Stand des Nachlaufs. Eine doppelte
Zustellung, auch gleichzeitig oder nach einem Neustart, legt nichts doppelt an.
Rezept-Gespräche kommen nicht in den Chat-Verlauf des Nutzers und gehen nicht durch
Merk-Tags.

**Nachlauf je Vorlage:** Bisher hat nur das Training einen (Vorlage `experte` mit
`nachlauf.training: true`). Gespräche aller anderen Rezepte werden nur abgelegt;
Zusammenfassung, Faden und Kalendervorschlag aus `nachlauf` folgen mit eigenen
Issues. Fehlt das Rezept (gelöscht), wird das Gespräch ebenfalls nur abgelegt. Ist
es beschädigt, wartet der Nachlauf und versucht es stündlich, bis es berichtigt ist.

**Trainingsauswertung:** Das Nebenmodell `voice-training` (Einstellung
`aux["voice-training"]`, sonst `AUX_MODEL_VOICE_TRAINING`, sonst Claude Haiku)
bewertet das ganze Protokoll gegen die drei `training.kriterien`, je mit
erfüllt, teilweise oder nicht und einem wörtlichen Zitat des Übenden. Es vergleicht
mit der Selbsteinschätzung im Gespräch (nur bei `training.selbsteinschaetzung: true`)
und übernimmt die Antwort auf `training.abschlussfrage`. tybo prüft die Antwort:
genau drei Bewertungen, jede einem Kriterium zugeordnet, nur die drei Werte, und
jedes Zitat steht in einem zusammenhängenden Beitrag des Übenden, nie über eine
Äußerung des Trainers hinweg (Groß- und Kleinschreibung, Satzzeichen und Leerraum
zählen nicht). Eine genannte Selbsteinschätzung braucht einen Vergleich. Kurze
Antworten wie „Ja.“ gelten als Selbsteinschätzung oder Abschlussantwort, wenn sie
ein ganzer Beitrag sind, als Beleg für ein Kriterium nie. Sonst gilt die Antwort
als unbrauchbar. Gekürzt wird
erst ab 60.000 Zeichen und dann vom Anfang her, weil Selbsteinschätzung und
Abschlussantwort am Ende stehen.

Unbrauchbare Antworten und Modellfehler versucht tybo nach einer Minute erneut,
dann jeweils doppelt so lange (höchstens eine Stunde), insgesamt fünfmal, auch nach
einem Neustart. Danach kommt eine kurze Meldung ohne Auswertung. Ein Protokoll ohne
Beitrag des Übenden wird nicht ausgewertet, die Meldung sagt das.

**Verlauf:** `data/voice-agents/<kennung>/training.jsonl`, eine Zeile je Übung mit
Gesprächs-ID, Zeitpunkt des Gesprächs, Rezeptstand (Hash), den verwendeten
Kriterien und den Bewertungen. Für jedes Gespräch gibt es höchstens eine Zeile, auch
nach einem Absturz mitten im Nachlauf.

**Meldung:** über die Outbox an `nachlauf.ziel`, als Nur-Anzeige-Eintrag im Verlauf
(Absender `training`), also nie als Kontext eines Modells. Sie nennt je Kriterium
Bewertung, Zitat, Begründung und die letzten fünf Übungen bis zu dieser, sortiert
nach Gesprächszeit. Gezählt wird nur, wo dasselbe Kriterium wörtlich bewertet wurde:
Nach einer Änderung des Kriteriums beginnt sein Verlauf neu. Dazu kommen
Selbsteinschätzung mit Vergleich und die Abschlussantwort. Ohne Telegram geht auch
`topic:<n>` in den Web-Direktchat. Lehnt Telegram die Meldung sicher ab, versucht
tybo es nach einer Minute erneut, höchstens dreimal. Ist unklar, ob sie ankam (Netz,
Neustart während des Versands), sendet tybo sie nicht noch einmal: Die Outbox kennt
keinen Schlüssel gegen doppelte Meldungen.

Code: `src/lib/voice-agents/aftercall.ts` (Weiche, Ablage, Ablauf),
`src/lib/voice-agents/training.ts` (Prompt, Prüfung, Verlauf, Meldung),
`src/app/server-routes.ts` (Webhook), `src/app/bot-choices.ts` (Verdrahtung).
