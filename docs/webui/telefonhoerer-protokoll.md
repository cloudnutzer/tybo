# Telefonhörer: Protokoll der Verbindung

Issue #257, Entscheidung 0024. Die Verbindung ist ein WebSocket unter
`GET /api/call`, nur mit gültiger Sitzung, nur aus dem Browser (kein
Terminal-Schlüssel) und mit passendem Origin. Code: `src/web/call.ts`
(Verbindungen, Grenzen), `src/web/call-protocol.ts` (Nachrichten,
Konstanten), `src/web/call-session.ts` (Gespräch als Zustandsmaschine),
`src/web/bot-call.ts` (Anschluss an Modell, Erkenner und Stimme).

## Browser an Server

| Nachricht | Felder | Bedeutung |
| --- | --- | --- |
| `start` | `conversationId`, `tts`: `"server"` oder `"browser"` | Gespräch öffnen; genau einmal, binnen 10 s nach dem Verbinden |
| `utterance_pause` | | 300 ms Stille: der Server beginnt schon zu erkennen |
| `utterance_end` | | Sprechende (Pause erreicht): erkennen, dann antworten |
| `interrupt` | | laufende Antwort abbrechen, zurück zum Zuhören |
| `played` | `id` (ganze Zahl ab 1) | Abschnitt `id` ist abgespielt (bzw. von der Browser-Stimme gesprochen) |
| `mute` | `on` (true/false) | Mikrofon stumm: Ton wird verworfen |
| `hangup` | | auflegen |
| binär | PCM16 LE mono 16 kHz | Aufnahme in Stücken von 20 ms, nur während der Nutzer spricht (mit Vorlauf) |

Jede Textnachricht ist ein JSON-Objekt mit genau den genannten Feldern,
höchstens 4 KB. Alles andere schließt die Verbindung.

## Server an Browser

| Nachricht | Felder | Bedeutung |
| --- | --- | --- |
| `ready` | `model`, `via`, `stt`, `tts`, `sampleRate` | Gespräch offen; `tts` sagt, wer wirklich spricht (`server` oder `browser`), `sampleRate` gilt für den Ton |
| `state` | `state` | `verbindet`, `hoert-zu`, `versteht`, `denkt`, `spricht`, `aufgelegt` |
| `transcript` | `text` | erkannter Text der Äußerung |
| `sentence` | `id`, `text` | ein Abschnitt der Antwort; IDs zählen über das ganze Gespräch hoch |
| `audio_begin` | `id` | ab hier Ton zu Abschnitt `id` |
| `audio_end` | `id` | Ton zu Abschnitt `id` vollständig gesendet (noch nicht abgespielt) |
| `audio_restart` | `id` | Rückfall der Stimme (#276): noch nicht gespielten Ton von Abschnitt `id` verwerfen, der Abschnitt kommt von vorn (vom Rückfall); schon Gehörtes bleibt |
| `speak_browser` | `id`, `text` | Rückfall auf die Browser-Stimme (#276): diesen Abschnitt spricht der Browser, sein Ton vom Server fällt weg, kein `audio_end`; er beginnt erst, wenn der Ton davor gespielt ist, und meldet `played` wie sonst. Der Server sendet bis dahin keinen weiteren Ton. Bleibt `played` über die Frist (Ton davor plus geschätzte Dauer plus 3 s) aus, kommen auch die übrigen Abschnitte des Turns als `speak_browser`, nie wieder Ton dazwischen |
| `tool` | `name`: `suche`, `rechne` oder `denkauftrag` | Werkzeug beginnt bzw. läuft noch (#259); bei `suche` zeigt die Ansicht „schaut nach …“ |
| `approval` | `choices`: Liste von `{ id, options: [{ key, label }] }` | offene Werkzeug-Freigaben dieses Gesprächs (#259), immer die ganze Liste; entschieden wird nur per Knopf über `POST /api/conversations/<id>/choices/<choiceId>` |
| `notice` | `text` | Hinweis, etwa „nichts verstanden“, beim Rückfall der Stimme „… ist nicht erreichbar, weiter mit …“ (#276) oder beim Rückfall des Erkenners „ElevenLabs Scribe ist nicht erreichbar, Parakeet erkennt diese Äußerung.“ (#279) |
| `error` | `reason`, optional `message` | Fehler: beim Start `neustart`, `gespraech`, `geschlossen`, `nicht-bereit`, `kein-erkenner`, `modell`, `start`, `zeitlimit`; im Gespräch `erkennung`, `modell`, `stimme` |
| `ended` | `reason`, `seconds` | Gespräch zu Ende |
| binär | PCM16 LE mono in `sampleRate` (24 kHz) | Ton, nur zwischen `audio_begin` und `audio_end` |

Mit `tts: "browser"` kommen nur `sentence`-Nachrichten, kein Ton.

## Ablauf eines Turns

1. Browser schickt Ton, dann `utterance_pause` und `utterance_end`.
2. Server: `state versteht`, `transcript`, `state denkt`.
3. Je Abschnitt: `sentence`, beim ersten `state spricht`, mit Server-Stimme
   `audio_begin`, Ton, `audio_end`. Die Stimme läuft dem Text hinterher:
   Abschnitt 2 wird berechnet, während Abschnitt 1 spielt.
4. Browser bestätigt jeden Abschnitt mit `played`. Erst wenn alles bestätigt
   ist (oder nach Tondauer plus 3 s), ist der Turn fertig: `state hoert-zu`.
   Nur Bestätigtes gilt als gesprochen.

Ansagen außerhalb eines Turns (Ergebnis eines Denkauftrags, Freigabe nötig)
laufen genauso: `state spricht`, `sentence`, mit Server-Stimme
`audio_begin`, Ton, `audio_end`, dann `state hoert-zu` nach `played` oder
nach Tondauer plus 3 s. Bis dahin nimmt der Server keinen Ton an; der
Browser hört nur zu, wenn Ins-Wort-Fallen per Stimme erlaubt ist, und
`interrupt` bricht die Ansage ab.

Nach `interrupt` geht für diesen Turn nichts mehr hinaus; was schon
gesendet war, verwirft der Browser selbst (#258), bis `state hoert-zu`
kommt. Der Server bestätigt jedes `interrupt` mit `state hoert-zu`, auch
wenn er schon zuhörte und nichts zu unterbrechen war. Ebenso beantwortet er
ein `utterance_end` ohne angenommenen Ton (leer oder stumm) mit
`state hoert-zu`, damit der Browser nicht bei „Versteht …“ stehen bleibt.

## Gründe in `ended` und Schließcodes

| `reason` | Schließcode | Wann |
| --- | --- | --- |
| `aufgelegt` | 1000 | `hangup` |
| `stille` | 1000 | 2 Minuten ohne Sprache |
| `dauer` | 1000 | 60 Minuten erreicht |
| `fehler` | 1000 | zweiter Fehler in Folge (Erkennen, Modell, Stimme) |
| `budget` | 1000 | Tagesbudget „voice“ erschöpft |
| `neustart` | 1000 | Neustart steht an (vorher der Satz „Ich starte kurz neu, ruf gleich wieder an.“) |
| `start` | 1000 | Start gescheitert oder `start` blieb aus |
| `verbindung` | 1000 | Browser holt den Ton 10 s lang nicht ab, oder die Verbindung riss |
| `server` | 1001 | WebUI wird beendet |
| `abgemeldet` | 4001 | Abmelden oder Sitzung abgelaufen |
| `protokoll` | 4008 | unbekannte Nachricht, Nachricht vor `start`, ungerade Tonlänge |
| `zu-gross` | 4009 | JSON über 4 KB oder Äußerung über 60 s |

Ohne `ended` schließt der Server sofort mit 4409 `besetzt` (schon ein
Gespräch offen) oder 4029 `zu-viele` (mehr als 6 Starts in 10 Minuten).
Binärnachrichten über 64 KB schließt Bun selbst (1009).

## Grenzen

- Ein Gespräch zur Zeit pro Installation, höchstens 6 Starts in 10 Minuten
- Höchstens 60 Minuten je Gespräch, Ende nach 2 Minuten ohne Sprache
- Binär höchstens 64 KB je Nachricht, Äußerung höchstens 60 s, JSON höchstens 4 KB
- Ping alle 25 s (Cloudflare trennt stille Verbindungen nach 100 s); dabei
  prüft der Server auch die Sitzung
- Ausgabepuffer: über 1 MB wartet der Ton, bis der Browser nachkommt

## Werkzeuge im Gespräch (Issue #259)

Das Gehirn schreibt Werkzeuge als Tags in den Text, nie als Function
Calling: `[SUCHE: <Begriffe>]`, `[RECHNE: <Ausdruck>]`,
`[DENKAUFTRAG: <Aufgabe>]` (`src/lib/voice-brain/tools.ts`). Tags werden
nie gesprochen. Sobald ein Tag beginnt (`[` plus Name plus `:`), kommt
`tool` und bei der Suche der Satz „Moment, ich schaue nach.“, beim
Denkauftrag „Das arbeite ich in Ruhe aus und schreibe es dir ins
Gespräch.“; Rechnen hat keinen Satz. Ist der Satz gesprochen und das
Werkzeug läuft noch, kommt wieder `state denkt` und `tool`.

- Suche: `history_search`, Ergebnis höchstens 6.000 Zeichen, Zeitlimit 8 s,
  danach „Dazu finde ich gerade nichts.“.
- Rechnen: eigener Auswerter, kein `eval`.
- Denkauftrag: ein Turn im selben Gespräch über den Chat-Kern (Warteschlange,
  Fortschritt, Push), nie nach Telegram. Kommt seine Antwort, solange das
  Gespräch läuft, sagt tybo in der nächsten ruhigen Sekunde einmal „Das
  Ergebnis vom Denkauftrag steht jetzt im Gespräch.“; der nächste Turn
  bekommt die ersten 1.500 Zeichen als gekennzeichneten Block, und ab dann
  werden Merk-Tags des Gesprächs Vorschläge.
- Höchstens zwei Werkzeug-Runden je Turn.

Wartet im Gespräch eine Werkzeug-Freigabe, kommt `approval`, und tybo sagt
einmal „Dafür brauche ich deine Freigabe, tipp bitte auf den Knopf.“
Erkannter Text geht nur an das Gehirn, nie an das Rückfragen-Register: ein
gesprochenes „ja“ gibt nichts frei. Nach dem Auflegen steht im Gespräch eine
Meldung (Absender „Telefonhörer“), was gemerkt wurde.
