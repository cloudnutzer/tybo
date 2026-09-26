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
| Befehl | Wirkung |
|---|---|
| `remember: <Fakt>` | Fakt dauerhaft speichern |
| `forget: <Text>` | Passenden Fakt loeschen |
| `memory` oder `facts` | Alle gespeicherten Fakten anzeigen |
| `track: <Ziel>` | Ziel anlegen |
| `done: <Text>` | Passendes Ziel als erledigt markieren |
| `cancel: <Text>` | Passendes Ziel verwerfen |
| `goals` | Aktive Ziele anzeigen |
| `recall <Suche>` / `search <Suche>` / `find <Suche>` | Semantische Suche im Verlauf |
| `/learn <URL oder Text>` | Quelle in die Knowledge Base destillieren |

Du kannst das auch einfach im Gespraech sagen ("merk dir, dass ...", "erinnere
mich an ..."): Claude setzt dann selbst die passenden Speicher-Tags.

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
usw., siehe CLAUDE.md Phase 4). Ohne sie antworten alle Agents ueber den
Haupt-Bot, und Mentions bleiben normale Nachrichten an den Topic-Agenten.

### Sonstiges
| Befehl | Wirkung |
|---|---|
| `/help` | Spickzettel aller Befehle im Chat |
| `/tasks` | Offene Human-in-the-Loop-Aufgaben anzeigen |
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
