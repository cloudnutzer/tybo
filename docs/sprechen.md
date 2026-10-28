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
