# 0025 Routinen-Zentrale und offene Fäden

Datum: 15.10.2026. Entschieden von: Maintainer (Umsetzung beider Ideen nach
einem Vergleich mit Grok Bot von xAI am 14.10.2026), Umsetzungsdetails aus
der Planung der Milestones „A1 Routinen-Zentrale" und „A2 Offene Fäden".

## Kontext

Grok Bot (xAI, seit August 2026) hat eine Seite für Routinen mit Zeitplan,
Status, letztem Lauf und Knöpfen zum Pausieren und Testen, und seine Bots
greifen liegen gelassene Fäden von sich aus wieder auf
(<https://x.ai/news/introducing-grok-bot>,
<https://docs.x.ai/grok-bot/skills-routines-and-automations>). Beides fehlt
tybo.

**Routinen:** Auf einem Mac laufen zeitgesteuerte Dienste über launchd, ein
Teil davon heißt `ai.tybo.*` (aus `bun run setup:launchd` und `/routine`),
dazu kommen eigene Watcher des Nutzers mit anderen Labels. Eine Übersicht gibt
es nicht. Ein Dienst, der abbricht, schreibt nur in seine Log-Datei; das
fällt erst auf, wenn der Nutzer das Ergebnis vermisst. Belegtes Beispiel: Ein
täglicher Refresh brach ab, weil `python3` nach einem Homebrew-Update auf ein
älteres System-Python zeigte, und niemand bekam eine Meldung. Unter Linux und
Windows laufen die Dienste über PM2 (`tybo-*`).

**Fäden:** tybo beendet Antworten oft mit einer Frage oder einer offenen
Entscheidung an den Nutzer („Soll ich die Issues anlegen?", „Nehmen wir
Variante A oder B?"). Bleibt sie unbeantwortet, geht sie im Verlauf
unter. Belegtes Beispiel: Eine Rückfrage zu einem Vertrag stand eine Woche
offen, bis ein Schreiben mit zweiwöchiger Frist kam; die Frage war da immer
noch offen.

## Entscheidung

### Routinen-Zentrale (A1)

- **Was eine Routine ist:** jeder launchd-Dienst mit Label `ai.tybo.*` aus
  `~/Library/LaunchAgents` und jeder Dienst, den der Nutzer in
  `config/routines.json` ausdrücklich nennt (Labels oder Präfixe, Vorlage
  `config/routines.example.json`, nicht im Repo). Eigene Watcher stehen so
  nie im Code. Unter PM2 sind es die Prozesse `tybo-*`. Dauerdienste ohne
  Zeitplan (KeepAlive, etwa der Bot selbst) erscheinen als „Dauerdienst"
  mit läuft/läuft nicht, ohne Knöpfe.
- **Ausnahme zu Issue #142** („Dienste anderer Namen fasst tybo nie an"):
  Ein Dienst aus `config/routines.json` gilt als vom Nutzer übergeben. Die
  Zentrale zeigt ihn und darf ihn auf Knopfdruck pausieren, fortsetzen und
  testen. Einrichtung, Updates und Deinstallation (`setup:launchd`,
  `setup/uninstall.ts`) fassen ihn weiter nicht an.
- **Übersicht** in Telegram (`/routinen`, auch Browser und Terminal über die
  gemeinsame Befehls-Schicht) und als Reiter „Routinen" in den
  Einstellungen der WebUI: Name, Zeitplan in Klartext („täglich 06:30",
  „alle 10 Minuten"), Status (aktiv, pausiert, nicht geladen), letzter Lauf
  (Zeit, Dauer, Erfolg oder Fehler), nächster Lauf.
- **Lauf-Protokoll über einen Wrapper:** `src/routine-run.ts` startet den
  eigentlichen Befehl, reicht Ausgabe und Exit-Code unverändert durch und
  hält je Routine die letzten 20 Läufe fest (Beginn, Dauer, Exit-Code,
  letzte Zeilen der Ausgabe, maskiert wie bei Hintergrund-Jobs) unter
  `data/routines/`. Die Vorlagen aus `setup:launchd` und Plists aus
  `/routine` rufen den Wrapper. Bestehende Plists bindet
  `tybo routinen einbinden <label>` ein (mit Sicherung, rückgängig per
  `tybo routinen ausbinden <label>`); kein Skript wird dafür umgeschrieben.
  Ohne Wrapper zeigt die Übersicht nur, was launchd selbst weiß (letzter
  Exit-Code), und sagt, wie man den Verlauf einschaltet.
- **Bedienen:** Pausieren, Fortsetzen und „Jetzt testen" über das
  Rückfragen-Register (Art `routine`, Entscheidung 0017), also mit Knöpfen
  in Telegram und im Browser. Pausieren und Fortsetzen fragen vorher nach
  („Wirklich pausieren?") und bestätigen danach mit dem neu gelesenen
  Zustand. Pausieren heißt `launchctl disable` plus `bootout` (übersteht
  einen Neustart), Fortsetzen `enable` plus `bootstrap`, Testen
  `kickstart` ohne `-k`. Der Bot-Dienst selbst (`telegram-relay`) und
  Dauerdienste sind davon ausgenommen.
- **Fehler sofort melden:** Endet ein Lauf mit Exit-Code ungleich 0, schickt
  der Wrapper eine Meldung über die Outbox (Absender `routine`, Direktchat
  und WebUI) mit Routine, Fehlerzeile und Log-Pfad. Läuft eine Routine
  nicht, obwohl sie fällig war, meldet der Bot das ebenfalls. Je
  Fehlerserie genau eine Meldung, die nächste erst nach einem erfolgreichen
  Lauf.
- **Regel „keine alten Daten":** Fehlen die Quelldaten einer Routine oder
  sind sie veraltet, meldet sie das und endet mit einem Exit-Code ungleich 0,
  statt mit alten Daten weiterzumachen. Das steht in der Doku für neue
  Routinen und im Auftrag von `/routine`.
- **PM2 (Linux, Windows):** Die Übersicht liest `pm2 jlist` (Name, Status,
  `cron_restart` als Zeitplan). Pausieren, Fortsetzen und Testen sagen dort
  „auf diesem System nicht verfügbar". Ohne launchd und ohne PM2 sagt die
  Übersicht genau das und tut nichts.

### Offene Fäden (A2)

- **Erkennen:** Nach einem Turn aus Telegram oder dem Browser, dessen Antwort
  mit einer Frage oder offenen Entscheidung an den Nutzer endet, legt tybo
  einen Faden an: Thema in einem Satz, kurzer Kontext, die Frage, Gespräch
  (Chat und Topic oder Web-Gespräch), Zeitpunkt und, wenn erkennbar, eine
  Frist. Die Erkennung läuft nach der Antwort auf dem Aux-Modell (neuer Zweck
  `threads`, Standard wie `review`), nie im Haupt-Turn. Ein lokaler Vorfilter
  (Fragezeichen oder Entscheidungs-Formulierung am Ende) spart Aufrufe.
  Rhetorische Fragen und Höflichkeitsfloskeln („Soll ich noch etwas tun?")
  zählen nicht. Keine Fäden aus `/goal`-Turns, aus der Sprach-Brücke, aus
  Meldungen der Outbox und für Fragen, die schon als Rückfrage im Register
  oder als `ask_user`-Aufgabe offen sind (die haben eigene Erinnerungen).
- **Auflösen:** Schreibt der Nutzer später im selben Gespräch, prüft das
  Aux-Modell, ob die Nachricht einen offenen Faden beantwortet; wenn ja, wird
  er still geschlossen. Im Zweifel und bei Fehlern bleibt er offen.
- **Erinnern:** Nach einer einstellbaren Zeit (Standard 3 Tage, früher bei
  erkannter Frist) kommt eine kurze Nachricht in dasselbe Gespräch, erst mit
  Kontext, dann mit der Frage, mit den Knöpfen „Erledigt", „Später" (+3
  Tage) und „Nicht mehr wichtig" über das Rückfragen-Register (Art
  `thread`). Höchstens zwei Erinnerungen je Faden, danach wird er still
  geschlossen. Erinnert wird nur zwischen 8 und 21 Uhr in `USER_TIMEZONE`.
  Der nächste Turn im Gespräch bekommt den Faden als Hinweis, damit tybo die
  Antwort einordnen kann.
- **Übersicht:** `/faeden` (alle Kanäle) und der Bereich „Offene Fäden" in
  der WebUI.
- **Ablage:** `data/threads.json` mit Sperre und atomarem Schreiben wie
  `data/choices.json`, keine Supabase-Tabelle. Gründe: Die anderen
  Zustände der autonomen Features (`goals.json`, `pending-reviews.json`,
  `choices.json`) liegen ebenso unter `data/`; die Datenmenge ist klein; es
  braucht keine Migration und funktioniert gleich unter Supabase, Convex und
  ohne Datenbank; Bot und Sprach-Brücke laufen in getrennten Prozessen, das
  Sperr-Muster ist erprobt. Kein Inhalt geht an Dritte außer an das gewählte
  Aux-Modell; ins Log kommen nur Kennungen.
- **Abgrenzung zum Pipeline-Wächter:** Der Wächter der Werkstatt
  (`ai.tybo.pipeline-watch`) meldet Pipelines, die auf eine Abnahme warten
  oder stehen. Er bleibt getrennt und fließt nicht in die Fäden ein: Er ist
  nicht Teil von tybo, seine Meldungen gehen über die Outbox und erzeugen
  deshalb nie einen Faden, und er erinnert an einen Zustand, nicht an eine
  Frage aus einem Gespräch. Doppelte Erinnerungen entstehen so nicht. Fragt
  tybo in einem Gespräch selbst „Soll ich die Pipeline starten?", ist das ein
  normaler Faden.

## Alternativen

- **Routinen als eigene Zeitsteuerung im Bot statt launchd:** verworfen.
  launchd holt verpasste Läufe nach dem Aufwachen nach und läuft auch, wenn
  der Bot steht; ein zweiter Zeitplaner würde das nachbauen.
- **Verlauf aus den Log-Dateien raten:** verworfen. Log-Formate sind je
  Skript verschieden, Exit-Code und Dauer stehen dort nicht.
- **Jedes Skript selbst protokollieren lassen:** verworfen, der Wrapper
  erreicht dasselbe ohne Änderung an den Skripten.
- **Fäden im Haupt-Turn per Tag (`[OPEN:]`) erkennen:** verworfen. Das
  verlängert jeden Prompt, hängt am Gehorsam des Hauptmodells und mischt
  sich mit den Merk-Tags.
- **Fäden in einer Supabase-Tabelle:** verworfen, siehe Ablage oben.
- **Pipeline-Halte als Fäden:** verworfen, siehe Abgrenzung oben.

## Folgen

- Neue Arten `routine` und `thread` im Rückfragen-Register; neuer Aux-Zweck
  `threads` mit Feld in den Einstellungen.
- Neue Dateien unter `data/` (`routines/`, `threads.json`) und
  `config/routines.json` (lokal, nicht im Repo).
- Die Plist-Vorlagen unter `launchd/` rufen künftig den Wrapper. Wer neu
  einrichtet, bekommt den Verlauf von selbst; bestehende Installationen
  holen ihn mit `setup:launchd` oder `tybo routinen einbinden` nach.
- Jeder Turn mit einer Frage am Ende kostet einen kleinen Aux-Aufruf, jede
  spätere Nachricht in einem Gespräch mit offenem Faden einen weiteren.
  `THREADS=off` in der `.env` schaltet die Fäden ab.
- Tests rufen nie `launchctl` oder `pm2` auf und nie ein echtes Modell; alles
  Äußere ist austauschbar wie in `setup/configure-launchd.ts`.
