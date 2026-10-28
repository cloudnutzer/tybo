# tybo User Guide

> Alltagsanleitung fuer tybo mit Sessions pro Topic und den autonomen
> Features (Stand: August 2026). Schnellreferenz im Chat: **`/help`**.
> Technische Details und Betrieb: siehe [Developer Guide](developer-guide.md).
> Architektur-Hintergrund: [topic-sessions.md](topic-sessions.md).

## Was tybo ist

tybo ist dein persoenlicher AI-Assistent in Telegram. Er laeuft lokal auf deinem
Mac, nutzt Claude ueber deine Subscription (`claude -p`), merkt sich Fakten und
Ziele dauerhaft, und routet Nachrichten in Telegram-Foren-Topics an spezialisierte
Agents (Research, Finance, Strategy, ...).

## Die wichtigsten Konzepte

### Topics = getrennte Gespraeche

Jedes Telegram-Forum-Topic ist ein eigener Gespraechskontext. Was du im
Research-Topic besprichst, vermischt sich nicht mit dem General-Topic. Die
**Suche** arbeitet trotzdem topic-uebergreifend: Fragst du nach etwas, das in
einem anderen Topic besprochen wurde, findet der Bot es ueber die semantische
Suche wieder.

### Sessions: der Bot bleibt im Gespraech

Pro Topic fuehrt der Bot eine fortlaufende Claude-Session. Die erste Nachricht
in einem Topic baut den vollen Kontext auf (Profil, Memory, Verlauf), danach
laeuft das Gespraech schlank weiter, Claude erinnert sich innerhalb der Session
von selbst. Effekt: schnellere Antworten und deutlich geringerer Verbrauch
deines Subscription-Credits.

- Eine Session verfaellt nach **18 Stunden ohne Aktivitaet**, dann startet die
  naechste Nachricht frisch (der Verlauf bleibt in der Datenbank und ist per
  Suche weiter auffindbar).
- **`/new`** (oder `/reset`) startet die Session im aktuellen Topic sofort neu,
  z. B. wenn du das Thema komplett wechseln willst.

### Ziele: der Bot arbeitet selbststaendig weiter (`/goal`)

Normalerweise antwortet der Bot einmal pro Nachricht. Mit `/goal` gibst du ihm
ein stehendes Ziel, und er arbeitet von allein weiter, bis es erreicht ist:

1. `/goal Erweitere den Report auf 500 Titel und deploye ihn` setzt das Ziel.
   Der Bot legt sofort los.
2. Nach jedem Arbeitsschritt prueft ein **Judge** (laeuft auf Opus), ob das
   Ziel wirklich erreicht ist. Wenn nicht, macht der Bot mit dem naechsten
   Schritt weiter, du siehst jeden Schritt als Nachricht im Topic.
3. Optional haerter: `/goal gate add bun test` haengt ein **Quality Gate** an,
   ein Shell-Kommando, das gruen sein muss, bevor der Judge ueberhaupt
   "fertig" sagen darf. Schlaegt es fehl, fliesst der Fehler-Output direkt in
   den naechsten Arbeitsschritt.
4. Nach dem **Turn-Budget** (Standard 10 Schritte) pausiert der Bot und fragt
   per Button "Weitermachen?", statt endlos Credit zu verbrennen. `/stop`
   bricht jederzeit sofort ab.

Ein Ziel gehoert zum Topic, in dem du es setzt. Es ueberlebt Bot-Neustarts.

### Session-Rueckblick: der Bot fragt, statt dass du dran denken musst

Endet eine laengere Session (18h-Ablauf oder `/new`), schaut der Bot
automatisch zurueck und meldet sich per Buttons:

- **Merk-Vorschlaege**: "Das wuerde ich mir merken: ... [Uebernehmen]
  [Verwerfen]". Erst nach deinem Tap landet etwas im Langzeit-Memory,
  nichts wird mehr still gespeichert.
- **Routine-Erkennung**: Sah die Session nach einem wiederholbaren Ablauf aus
  (z. B. "morgens Firmen-News pruefen und zusammenfassen"), bietet der Bot an,
  ihn als Routine einzufrieren: "[Ja, einfrieren] [Nein]". Ja erzeugt
  automatisch einen Skill oder ein Script, wie beim manuellen `/routine`.

Wer das alte stille Verhalten will: `DISTILL_AUTO_APPLY=true` in der `.env`.

### Offene Fäden: tybo erinnert an seine unbeantworteten Fragen

Oft endet eine Antwort mit einer Frage an dich („Soll ich die Datei so
anlegen?", „Nehmen wir Variante A oder B?"). Antwortest du nicht, geht sie im
Verlauf leicht unter. tybo merkt sich solche Fragen als **offenen Faden** und
erinnert dich später daran.

**Was als Faden zählt:** eine echte Frage oder offene Entscheidung, auf die
tybo eine Antwort von dir braucht. Nicht dazu gehören Höflichkeitsfloskeln
(„Soll ich noch etwas tun?"), rhetorische Fragen, Antworten aus `/goal`, aus
der Sprach-Brücke (Telefon, Telefonhörer) und automatische Meldungen. Der
Sprechmodus im Browser zählt wie ein normaler Turn: Endet die gesprochene
Antwort mit einer Frage, entsteht ein Faden. Fragt tybo schon über Knöpfe
nach (etwa eine Freigabe oder ein Rückblick-Vorschlag), entsteht kein
zusätzlicher Faden, denn diese Fragen erinnern selbst.

**Wie ein Faden zugeht:** Schreibst du später im selben Gespräch etwas, das
die Frage beantwortet oder entscheidet, schließt tybo den Faden still. Im
Zweifel bleibt er offen.

**Wann erinnert wird:** Nach 3 Tagen ohne Antwort (einstellbar, 1 bis 14
Tage) kommt eine kurze Nachricht in dasselbe Gespräch: erst worum es ging,
dann die Frage. Hat tybo eine Frist erkannt, kommt die Erinnerung
früher, in der Regel am Vortag der Frist um 9 Uhr. Erinnert wird nicht in der
Ruhezeit (Standard 21 bis 8 Uhr, gerechnet in deiner Zeitzone `USER_TIMEZONE`,
ohne Angabe in UTC). Unter der Erinnerung stehen drei Knöpfe:

- **Erledigt**: der Faden ist zu.
- **Später**: noch einmal in 3 Tagen erinnern.
- **Nicht mehr wichtig**: der Faden ist zu, ohne weitere Erinnerung.

Höchstens zwei Erinnerungen je Faden; bleibt auch die zweite ohne Antwort,
schließt tybo den Faden still. Nach einer Erinnerung bekommt tybo deine
nächste Nachricht in diesem Gespräch zusammen mit der Frage, damit es sie
richtig einordnet.

**Überblick:**

- `/faeden` zeigt alle offenen Fäden aus allen Gesprächen, neueste oben, mit
  Nummer, Gespräch, Alter und nächstem Termin.
- `/faeden zu <nr>` schließt einen Faden von Hand. Das geht nur im Gespräch,
  aus dem er stammt; sonst sagt tybo, wo er liegt.
- `/faeden alle` zeigt zusätzlich die in den letzten 7 Tagen geschlossenen.
- Im Browser steht in der Seitenleiste der Eintrag „Offene Fäden" mit der
  Anzahl (Adresse `#/faeden`).

**Abschalten:** In der WebUI unter Einstellungen, Modelle, Abschnitt „Offene
Fäden", „Aus" wählen und im Abschnitt auf „Speichern" klicken. Erst nach
erfolgreichem Speichern gilt die Einstellung, dann sofort und ohne Neustart. Dort
stellst du auch die Tage bis zur Erinnerung und die Ruhezeit ein. Ohne
WebUI: `THREADS=off` in der `.env` und tybo neu starten. Was in den
Einstellungen der WebUI gespeichert ist (`config/settings.json`), hat Vorrang
vor der `.env`: Steht dort „an", hilft `THREADS=off` nicht.

**Welche Inhalte wohin gehen (Datenschutz):** Erkennen und Auflösen laufen
nach der Antwort auf dem Aux-Modell für Nebenaufgaben (Zweck `threads`,
Standard Claude Haiku über dein Abo bzw. deinen API-Schlüssel). Dorthin geht:

- zum Erkennen, nur wenn das Ende der Antwort ein Fragezeichen oder eine
  Formulierung wie „sag Bescheid" enthält: höchstens die letzten 1.500
  Zeichen der Antwort (ohne Code-Blöcke) und die letzten 500 Zeichen deiner
  Nachricht;
- zum Auflösen, nur wenn das Gespräch offene Fäden hat: höchstens die
  letzten 1.000 Zeichen deiner Nachricht, die ersten 500 Zeichen der Antwort
  und von den zehn neuesten offenen Fäden dieses Gesprächs Nummer, Thema und
  Frage.

Ein anderes Modell wählst du in den Einstellungen unter Modelle, Abschnitt
„Nebenmodelle", Eintrag „Offene Fäden", oder mit `AUX_MODEL_THREADS` in der
`.env`; auch hier hat die WebUI Vorrang. Mit `ollama:<modell>` bleibt diese Auswertung auf deinem
Rechner. Unabhängig davon gilt:

- Die Fäden selbst liegen nur lokal in `data/threads.json`.
- Eine Erinnerung ist eine normale Nachricht: Sie landet wie alle Nachrichten
  im eingestellten Nachrichtenspeicher (etwa Supabase), in
  Telegram-Gesprächen geht sie über Telegram, und mit eingeschalteten
  Push-Benachrichtigungen meldet sie der Browser wie andere Meldungen.
- Nach einer Erinnerung bekommt die nächste Antwort in diesem Gespräch Thema
  und Frage als Hinweis mit, also auch das Hauptmodell.
- Ins Log kommen nur Kennungen von Fäden und Gesprächen, nie Fragen oder
  Antworten.

**Was es kostet:** je Antwort höchstens zwei kleine Aux-Aufrufe, einer zum
Auflösen (nur in Gesprächen mit offenem Faden) und einer zum Erkennen (nur
wenn die Antwort mit einer Frage oder Entscheidung endet). Die meisten
Antworten lösen keinen Aufruf aus. Mit `ollama:` kostet es nichts.

### Memory: Fakten und Ziele

Der Bot speichert Fakten und Ziele dauerhaft und gibt sie Claude bei jeder
neuen Session mit. Bei sehr vielen Fakten waehlt er automatisch die zur
aktuellen Nachricht relevantesten aus. Mit `/learn <URL oder Text>`
destillierst du eine externe Quelle direkt in die Knowledge Base, die jeder
Agent im Kontext hat.

### Agenten anpassen, direkt aus Telegram (`/agent`)

Du musst keine Code-Dateien anfassen, um einen Agenten umzuerziehen:

- `/agent research: antworte kuerzer` haengt die Anweisung dauerhaft an den
  Research-Agenten (sie hat Vorrang vor seinem Standard-Verhalten).
- `/agent research` zeigt die aktiven Anweisungen, `/agent research undo`
  entfernt die letzte, `/agent research reset` alle.
- Anweisungen gelten ab der naechsten frischen Session; `/new` im betroffenen
  Topic erzwingt sie sofort.

Die Anweisungen liegen in `config/agent-overrides.json` und greifen ohne
Bot-Neustart. Fuer groessere Umbauten (Rolle, Domaene, Format) bleibt der Weg
ueber die Agent-Dateien in `src/agents/` (siehe README "Agents & Models").

## Befehle

### Memory
Diese Befehle gehen in Telegram, im Browser und im Terminal gleich, die
Antworten kommen auf Deutsch.

| Befehl | Wirkung |
|---|---|
| `/remember <Fakt>` | Fakt dauerhaft speichern |
| `/forget <Text>` | Ersten gespeicherten Fakt loeschen, der den Text enthaelt |
| `/memory` oder `/facts` | Alle gespeicherten Fakten anzeigen |
| `/track <Ziel>` | Ziel anlegen, mit Frist: `/track <Ziel> \| deadline: <Frist>` (etwa `morgen`, `2026-12-01`) |
| `/done <Text>` | Erstes passendes Ziel als erledigt markieren |
| `/cancel <Text>` | Erstes passendes Ziel verwerfen |
| `/goals` | Aktive Ziele anzeigen |
| `/recall <Suche>` (auch `/search`, `/find`) | Die fuenf besten Treffer im Verlauf dieses Chats |
| `/learn <URL oder Text>` | Quelle in die Knowledge Base destillieren |

Ohne Text dahinter zeigt der Befehl, wie er benutzt wird. Die Ziele hier
sind gespeicherte Ziele, nicht `/goal` (siehe unten).

In Telegram gelten weiter die frueheren Schreibweisen ohne Schraegstrich:
`remember: <Fakt>`, `forget: <Text>`, `track: <Ziel> | deadline: <Frist>`,
`done: <Text>`, `cancel: <Text>`, `memory`, `facts`, `goals` sowie
`recall <Suche>`, `search <Suche>`, `find <Suche>`. Ohne Text dahinter geht
so eine Nachricht wie bisher als normale Nachricht an den Agenten.

Du kannst das auch einfach im Gespraech sagen ("merk dir, dass ...", "erinnere
mich an ..."): Claude setzt dann selbst die passenden Speicher-Tags. Wie
Erinnerungen mit Uhrzeit funktionieren, steht in [Erinnerungen](erinnerungen.md).

### Autonome Ziele
| Befehl | Wirkung |
|---|---|
| `/goal <Text>` | Ziel setzen, der Bot arbeitet selbststaendig bis "fertig" |
| `/goal` oder `/goal status` | Stand: Ziel, Turns, Gates, letzter Judge-Befund |
| `/goal pause` / `/goal weiter` | Anhalten / fortsetzen |
| `/goal stop` | Ziel beenden und laufende Arbeit abbrechen |
| `/goal gate add <cmd>` | Quality Gate (Shell-Kommando muss gruen sein) |
| `/goal gate list` / `clear` | Gates anzeigen / entfernen |
| `/goal max <n>` | Turn-Budget aendern (Standard 10) |
| `/stop` | Laufende Antwort oder Ziel-Arbeit im Topic sofort abbrechen |

### Sessions & Topics
| Befehl | Wirkung |
|---|---|
| `/new` oder `/reset` | Session des aktuellen Topics neu starten (Destillat laeuft vorher automatisch) |
| `/topics` | Topic→Agent-Zuordnung dieses Chats anzeigen, inkl. ID des aktuellen Topics |

Schreibst du in ein **neues, noch nicht zugeordnetes Topic**, fragt der Bot
einmalig per Buttons, welcher Agent dort antworten soll. Bis du waehlst,
uebernimmt der General-Agent. Die Auswahl laesst sich jederzeit in
`config/topics.json` aendern (gilt ohne Neustart).

### Agents & Diskussionen
| Befehl | Wirkung |
|---|---|
| `/board <Thema>` | Board Meeting: alle Agents diskutieren nacheinander, General fasst zusammen |
| `/critic <Frage>` | Devil's-Advocate-Antwort vom Critic-Agent |
| `/agent <name>: <Anweisung>` | Agent dauerhaft anpassen (siehe Konzept oben) |
| `@agentbot <Frage>` | Mention eines Agent-Bots holt diesen Agenten in ein beliebiges Topic |

Das Mention-Routing braucht die Multi-Bot-Tokens (`TELEGRAM_BOT_TOKEN_RESEARCH`
usw., siehe [Eigener Bot je Agent](erweiterungen.md#eigener-bot-je-agent)). Ohne sie antworten alle Agents ueber den
Haupt-Bot, und Mentions bleiben normale Nachrichten an den Topic-Agenten.

### Sonstiges
| Befehl | Wirkung |
|---|---|
| `/help` | Spickzettel aller Befehle im Chat |
| `/tasks` | Offene Human-in-the-Loop-Aufgaben anzeigen |
| `/faeden` | Offene Fäden: tybos Fragen, auf die noch deine Antwort fehlt (siehe Konzept oben) |
| `/faeden zu <nr>` / `/faeden alle` | Faden schließen / auch die geschlossenen der letzten 7 Tage |
| `/erinnerungen` | Offene Erinnerungen aller Gespräche mit Kennung (siehe [Erinnerungen](erinnerungen.md)) |
| `/erinnerungen absagen <kennung>` | Erinnerung absagen, eine Serie ganz |
| `/credit` | Verbrauch deines Agent-SDK-Credits im aktuellen Abrechnungszyklus |
| `/plan` | Erkannter/konfigurierter Plan-Ceiling des Credit Guards |
| `/voice <Text>` | Antwort zusaetzlich als Sprachnachricht |

Faellt Claude aus und ein Fallback-Modell will ein schreibendes Tool nutzen
(Datei senden, Deploy), fragt der Bot vorher per Button um Erlaubnis; ohne
Antwort innerhalb von 10 Minuten gilt das als abgelehnt.

## Medien

- **Sprachnachrichten** werden lokal transkribiert und normal beantwortet.
- **Bilder** analysiert der Bot, speichert sie mit Beschreibung und Tags, und
  findet sie spaeter per Suche wieder.

## Wenn etwas nicht funktioniert

- Bot antwortet nicht: bis ~30 s warten (laengere Claude-Antworten), dann im
  [Developer Guide](developer-guide.md#betrieb--troubleshooting) nachsehen.
- Antwort kommt von OpenRouter/Ollama statt Claude: Claude war kurzzeitig nicht
  erreichbar (Rate Limit, Auth). Der Bot sagt dir, welches Backend geantwortet
  hat; das renkt sich normalerweise von selbst wieder ein.
- Der Bot wirkt "vergesslich" innerhalb eines Topics: pruefe mit `/topics`, ob
  du im erwarteten Topic bist, und ob evtl. jemand `/new` ausgefuehrt hat.
- Der Bot arbeitet an etwas Falschem oder zu lange: `/stop` bricht sofort ab.
  Ein pausiertes Ziel setzt `/goal weiter` fort, `/goal stop` beendet es.
- Ein Ziel kommt nicht voran (Judge sagt immer "continue"): `/goal status`
  zeigt den letzten Befund. Oft hilft ein praeziseres Ziel oder ein Quality
  Gate, an dem sich "fertig" messen laesst.
