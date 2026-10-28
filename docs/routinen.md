# Routinen

Eine Routine ist ein Dienst, der nach Zeitplan von selbst läuft: der
Nachtcheck um 03:30, ein Watcher alle 10 Minuten, ein täglicher Bericht. Die
Routinen-Zentrale zeigt alle Routinen dieses Rechners an einer Stelle, hält
fest, wie ihre Läufe ausgingen, meldet Fehler sofort und bietet Knöpfe zum
Pausieren, Fortsetzen und Testen (Entscheidung
`docs/webui/decisions/0025-routinen-und-faeden.md`).

Den Zeitplan selbst führt weiter das Betriebssystem: unter macOS launchd,
unter Linux systemd-Timer (ohne systemd cron), eingerichtet mit
`tybo dienste`. tybo plant nichts selbst. launchd holt
verpasste Kalender-Termine nach dem Aufwachen nach und startet Routinen auch
dann, wenn der Bot gerade nicht läuft.

## Was als Routine zählt

- **macOS:** jeder launchd-Dienst mit Label `ai.tybo.*` aus
  `~/Library/LaunchAgents` (aus `tybo dienste`, gleichbedeutend
  `bun run setup:launchd`, und `/routine`), dazu
  jeder Dienst, den du in `config/routines.json` nennst.
- **Linux und Windows:** die PM2-Prozesse `tybo-*`.
- **Dauerdienste** ohne Zeitplan (etwa der Bot selbst, `telegram-relay`)
  erscheinen gesondert mit „läuft" oder „läuft nicht", ohne Knöpfe.

### Eigene Dienste: `config/routines.json`

Eigene launchd-Dienste mit anderem Label erscheinen nur, wenn sie in
`config/routines.json` stehen. Die Datei liegt nur auf deinem Rechner, nicht
im Repo; die Vorlage ist `config/routines.example.json`:

```bash
cp config/routines.example.json config/routines.json
```

```json
{
  "labels": ["com.example.backup"],
  "prefixes": ["com.example.watch."]
}
```

- `labels`: genaue Labels, je ein Dienst.
- `prefixes`: alle Dienste, deren Label so beginnt (hier etwa
  `com.example.watch.preise` und `com.example.watch.wetter`).

tybo liest die Datei bei jedem Aufruf neu, ein Neustart ist nicht nötig. Ist
sie kein gültiges JSON, gilt sie als leer, und die Übersicht sagt das in
einer Hinweiszeile. Ein Dienst aus dieser Datei gilt als dir übergeben: Die
Zentrale zeigt ihn und darf ihn auf Knopfdruck pausieren, fortsetzen und
testen. Einrichtung, Updates und Deinstallation (`tybo dienste`,
`tybo deinstallieren`) fassen ihn nie an.

## Übersicht

| Wo | Wie |
|---|---|
| Telegram, Browser-Chat, Terminal-Chat | `/routinen` |
| WebUI | Einstellungen, Reiter „Routinen" |
| Terminal | `tybo routinen` |

Je Routine stehen dort Name, Zeitplan in Klartext („täglich 03:30", „alle
10 Minuten", „werktags 08:00"), Status (aktiv, pausiert, nicht geladen),
letzter Lauf und nächster Lauf. Der Name ist bei `ai.tybo.*` der Teil nach
dem Präfix (`health-check`), bei eigenen Diensten das ganze Label.

`/routinen <name>` zeigt eine Routine im Einzelnen: die letzten 20 Läufe mit
Zeit, Dauer und Ergebnis, darunter die Knöpfe (siehe „Knöpfe"). Statt des
Namens geht auch das Label. Im Browser öffnet ein Klick auf eine Routine im
Reiter „Routinen" dasselbe. Im Terminal gibt es nur die Liste
(`tybo routinen`); einen Befehl `tybo routinen <name>` gibt es nicht, den
Verlauf zeigt `/routinen <name>`.

## Verlauf und Wrapper

launchd selbst weiß über einen Dienst nur den letzten Exit-Code. Den Verlauf
hält ein Wrapper fest: `src/routine-run.ts` startet den eigentlichen Befehl,
reicht Ausgabe und Exit-Code unverändert durch und schreibt je Routine die
letzten 20 Läufe nach `data/routines/<label>.json` (Beginn, Dauer,
Exit-Code, letzte Zeilen der Ausgabe). Werte aus der `.env` stehen dort nur
verdeckt, wie bei den Hintergrund-Jobs.

```bash
bun run src/routine-run.ts --id <label> -- <befehl> [argumente]
```

- `--id` ist genau das Label der Routine. Zugelassen sind `ai.tybo.*` und
  Labels bzw. Präfixe aus `config/routines.json`.
- `--` trennt den Wrapper vom eigentlichen Befehl.
- Der Wrapper endet mit dem Exit-Code des Befehls. Fehlt `--id` oder der
  Befehl, oder passt die id zu keiner Routine, endet er mit 2, ohne etwas zu
  starten. Konnte der Befehl nicht starten, endet er mit 127.
- Die Log-Dateien aus der Plist (`StandardOutPath`, `StandardErrorPath`)
  bleiben, wie sie sind.

Die Vorlagen aus `bun run setup:launchd` und die Plists, die `/routine`
anlegt, rufen den Wrapper von selbst. Eine Routine ohne Wrapper zeigt in der
Übersicht „kein Verlauf (nicht eingebunden)" und nur den letzten Exit-Code
von launchd.

## Bestehende Routinen einbinden

Ältere Plists oder eigene Dienste bekommen den Wrapper mit einem Befehl im
Terminal. Das Skript der Routine bleibt unverändert, nur der Aufruf in der
Plist bekommt den Wrapper vorangestellt:

```bash
tybo routinen einbinden <label>     # Wrapper vor den Befehl der Plist setzen
tybo routinen ausbinden <label>     # Wrapper wieder entfernen
tybo routinen help                  # Hilfe
```

Ohne `bun link` geht dasselbe mit `bun run scripts/tybo.ts routinen …`.

- Nur macOS, immer genau ein Dienst, nur `ai.tybo.*` und Dienste aus
  `config/routines.json`, nie der Bot-Dienst und nie Dauerdienste.
- Der Dienst muss geladen und aktiv sein und darf gerade nicht laufen. Eine
  pausierte Routine erst fortsetzen.
- Vor der Änderung zeigt der Befehl, was sich ändert, und fragt
  `Einbinden? [j/N]`. `--ja` überspringt die Frage.
- **Sicherung:** Die alte Plist landet zuerst in `data/launchd-backup/`
  (Name mit Label und Zeitpunkt). Danach lädt der Befehl den Dienst mit der
  neuen Plist neu. Scheitert dabei etwas, kommt die Sicherung zurück und der
  alte Dienst wird wieder geladen.
- **Rückweg:** `tybo routinen ausbinden <label>` entfernt den Wrapper wieder,
  ebenfalls mit Sicherung. Die Routine selbst bleibt, nur der Verlauf hört
  auf. Die Sicherungen in `data/launchd-backup/` kannst du jederzeit von Hand
  zurückkopieren.
- Ist in der Plist `RunAtLoad` gesetzt, startet das Neuladen die Routine
  sofort einmal; der Befehl weist vorher darauf hin.

Der Verlauf erscheint in `/routinen`, sobald die Routine einmal gelaufen ist.

## Meldungen

Meldungen kommen in den Telegram-Direktchat und in die WebUI (Absender
`routine`), ohne Telegram nur in die WebUI.

- **Fehlgeschlagen:** Endet ein Lauf mit einem Exit-Code ungleich 0, meldet
  der Wrapper sofort: `⚠️ Routine <name> fehlgeschlagen (Exit <code>,
  <dauer>)`, darunter die letzte Fehlerzeile der Ausgabe, der Pfad zur
  Log-Datei und der Hinweis auf `/routinen <name>`. Das geht nur bei
  eingebundenen Routinen, denn nur der Wrapper sieht den Exit-Code.
- **Nicht gelaufen:** Der Bot prüft alle 10 Minuten jede eingebundene,
  aktive launchd-Routine mit Zeitplan. Eine Routine mit festem Termin
  (`StartCalendarInterval`) gilt als ausgeblieben, wenn der Termin mehr als
  2 Stunden zurückliegt und sie seitdem nicht begonnen hat. Eine Routine mit
  Intervall (`StartInterval`) gilt als ausgeblieben, wenn ihr letzter Beginn
  länger als dreimal das Intervall plus 10 Minuten zurückliegt. Dann kommt
  `⏰ Routine <name> ist nicht gelaufen (fällig <zeit>)`. Pausierte, nicht
  geladene und nicht eingebundene Routinen, Dauerdienste und PM2 gelten nie
  als ausgeblieben. Eine Routine, die gerade läuft, auch nicht.
- **Einmal je Serie:** Nach der ersten Meldung kommt keine weitere, bis ein
  Lauf wieder gelingt. Dann folgt eine kurze Entwarnung
  `✅ Routine <name> läuft wieder`, und der nächste Fehler wird wieder
  gemeldet.
- **Schlaf des Rechners:** Schläft der Rechner (der Bot sieht eine Lücke von
  mehr als 15 Minuten) oder startet der Bot neu, beginnen alle Fristen von
  vorn. launchd holt verpasste Termine nach dem Aufwachen ohnehin nach; eine
  Meldung kommt erst, wenn die Routine auch danach die volle Frist ausbleibt.
- **Abschalten:** `ROUTINE_ALERTS=off` in der `.env` schaltet beide Arten
  von Meldungen ab. Übersicht und Verlauf bleiben.

Die Meldungen „fehlgeschlagen" und „nicht gelaufen" tragen dieselben Knöpfe
wie `/routinen <name>`.

### Im Nachtcheck: „Routinen pünktlich"

Der Nachtcheck (`bun run health`, täglich 03:30) prüft zusätzlich jede
aktive zeitgesteuerte launchd-Routine, auch nicht eingebundene, und braucht
dafür den Bot nicht. Er sendet keine Einzelmeldung, sondern eine Zeile im
Report: `✅ Routinen pünktlich: 4 pünktlich` oder `⚠️ Routinen pünktlich:
ausgeblieben: morning-briefing (fällig gestern 09:00)`.

- Fällig ist der letzte Termin, der mindestens 2 Stunden zurückliegt. Um
  03:30 ist das für ein Briefing um 09:00 der Termin von gestern.
- Intervall-Routinen gelten wie oben nach dreimal dem Intervall plus 10
  Minuten als ausgeblieben.
- Belegt wird ein Lauf durch den Verlauf des Wrappers. Ohne Verlauf zählt
  die letzte Änderung der Log-Dateien aus dem Plist (`laut Log`); eine
  Routine, die ohne Anlass nichts schreibt, wirkt dann ausgeblieben. Genauer
  wird es nach `tybo routinen einbinden <label>`.
- Termine gelten in der Zeitzone des Systems, wie launchd sie auswertet. Die
  Ruhezeit der proaktiven Meldungen ändert nichts: launchd startet die
  Routine trotzdem, sie schweigt selbst, und ihr Lauf zählt.
- Pausierte und nicht geladene Routinen, Dauerdienste und laufende Routinen
  gelten nie als ausgeblieben. Unlesbarer Zeitplan (auch ein einzelner
  Eintrag einer Liste), ein letzter Termin vor mehr als vier Jahren,
  unbekannter Zustand oder gar keine Spur eines Laufs stehen als
  `nicht prüfbar` im Report, nie als pünktlich.

Die Prüfung ersetzt den früheren Watchdog, der nur den Check-in überwachte.

## Knöpfe

Unter `/routinen <name>` und unter jeder Meldung „fehlgeschlagen" oder „nicht
gelaufen" stehen je nach Zustand:

- **▶️ Jetzt testen:** startet die Routine sofort einmal außer der Reihe
  (`launchctl kickstart`, ein laufender Lauf wird nicht abgebrochen). Ohne
  Rückfrage.
- **⏸️ Pausieren:** fragt erst „<name> wirklich pausieren?" (Knöpfe „Ja,
  pausieren" und „Abbrechen"). Danach läuft die Routine nicht mehr, auch
  nicht nach einem Neustart des Rechners (`launchctl disable` und `bootout`).
- **▶️ Fortsetzen:** fragt ebenso nach und lädt die Routine wieder
  (`enable` und `bootstrap`).

Nach jeder Aktion kommt eine Bestätigung mit dem neu gelesenen Zustand. Ein
Klick in Telegram oder im Browser entscheidet genau einmal; ein alter Knopf
einer schon pausierten Routine meldet nur „ist schon pausiert". Im Reiter
„Routinen" der WebUI gehen dieselben Aktionen über eigene Knöpfe, mit
derselben Rückfrage. Der Bot-Dienst und Dauerdienste haben keine Knöpfe.

## PM2 und andere Systeme

- **PM2 (Linux, Windows):** Die Übersicht liest die Prozesse `tybo-*` aus PM2,
  mit Status und, falls gesetzt, `cron_restart` als Zeitplan. Sie bleibt dort
  nur lesend: Pausieren, Fortsetzen und Testen melden „auf diesem System
  nicht verfügbar", Ausbleiben wird nicht geprüft, und
  `tybo routinen einbinden` gibt es nur unter macOS.
- **systemd-Timer und cron** werden nicht erfasst. Check-in und Briefing
  laufen unter Linux so (`tybo dienste`, Timer `tybo-<dienst>.timer` bzw.
  cron-Zeilen mit `# tybo-<dienst>`); ihren Verlauf schreibt der Wrapper
  trotzdem nach `data/routines/`, und Fehlschläge werden gemeldet. Zustand:
  `systemctl --user list-timers 'tybo-*'`.
- **Ohne launchd und ohne PM2** sagt die Übersicht „auf diesem System nicht
  verfügbar" und tut nichts.

## Neue Routine anlegen

Der einfachste Weg: einen Ablauf einmal im Chat durchspielen und dann im
selben Topic `/routine täglich 7 Uhr` senden. tybo schreibt daraus ein Skript
und, weil ein Zeitplan genannt ist, eine Plist mit Label `ai.tybo.<name>`,
die den Wrapper nutzt und die Regel unten einhält. Ohne Zeitplan entsteht
nur das Skript; den Zeitplan kannst du später per Nachricht nachrüsten.

Von Hand gehst du so vor:

1. Das Skript schreiben, etwa `src/preise-holen.ts`, und die Regel „keine
   alten Daten" einbauen (Beispiel unten).
2. Einmal von Hand im Projektordner testen: `bun run src/preise-holen.ts`,
   danach `echo $?` (0 heißt Erfolg).
3. Die Plist nach dem Muster unten als
   `~/Library/LaunchAgents/ai.tybo.preise-holen.plist` speichern.
4. Laden: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.tybo.preise-holen.plist`.
5. In `/routinen` nachsehen: Die Routine steht dort mit ihrem Zeitplan.
   Mit `/routinen preise-holen` und „▶️ Jetzt testen" einmal auslösen.

Ein anderes Label als `ai.tybo.*` geht auch, dann muss es in
`config/routines.json` stehen, sonst lässt der Wrapper den Lauf nicht zu
(Exit 2).

### Regel „keine alten Daten"

Eine Routine, die mit alten Daten weitermacht, sieht erfolgreich aus und
liefert trotzdem Falsches: ein Bericht mit den Kursen von letzter Woche, eine
Webseite mit dem Stand von vorgestern. Deshalb gilt für jede Routine:

> Fehlen die Quelldaten oder sind sie veraltet, schreibt die Routine eine
> Zeile, was fehlt, und endet mit Exit-Code 1; nie mit alten Daten
> weitermachen.

Der Exit-Code 1 sorgt dafür, dass der Wrapper sofort meldet, und die Zeile
steht dann als Fehlerzeile in der Meldung. Schreib sie auf stderr
(`console.error`), dann wählt der Wrapper genau sie. Exit-Code 0 nur, wenn
der Lauf mit frischen Daten wirklich fertig ist.

### Beispiel: Alter einer Datei prüfen

Die Routine liest eine Datei, die ein anderer Dienst einmal am Tag schreibt.
Fehlt sie oder ist sie älter als 26 Stunden, bricht sie ab:

```ts
// src/preise-holen.ts: arbeitet nur mit frischen Quelldaten
import { statSync } from "node:fs";

const SOURCE = process.argv[2] ?? "data/preise.json";
const MAX_AGE_HOURS = 26;

let modifiedMs: number;
try {
  modifiedMs = statSync(SOURCE).mtimeMs;
} catch {
  console.error(`Quelldaten fehlen: ${SOURCE} gibt es nicht.`);
  process.exit(1);
}

const ageHours = (Date.now() - modifiedMs) / 3_600_000;
if (ageHours > MAX_AGE_HOURS) {
  console.error(`Quelldaten veraltet: ${SOURCE} ist ${Math.round(ageHours)} Stunden alt, erlaubt sind ${MAX_AGE_HOURS}.`);
  process.exit(1);
}

// Ab hier die eigentliche Arbeit, nur mit frischen Daten
console.log(`Fertig mit ${SOURCE} (${Math.round(ageHours)} Stunden alt).`);
```

Fehlt die Datei, steht in der Meldung „Quelldaten fehlen: data/preise.json
gibt es nicht."; ist sie zu alt, „Quelldaten veraltet: …". Beides endet mit
Exit-Code 1, eine frische Datei mit 0.

### Plist-Muster

Aufgebaut wie die Plist des Nachtchecks `ai.tybo.health-check`, die
`bun run setup:launchd -- --service health-check` aus dem Dienstkatalog
(`src/lib/services/catalog.ts`) erzeugt. Ersetze
`/Users/NAME` durch deinen Home-Ordner, `/Users/NAME/tybo` durch den
Projektordner und `/Users/NAME/.bun/bin/bun` durch die Ausgabe von
`which bun`. launchd kennt weder `~` noch Variablen, alle Pfade müssen
absolut sein.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.tybo.preise-holen</string>

    <key>ProgramArguments</key>
    <array>
        <string>/Users/NAME/.bun/bin/bun</string>
        <string>--no-env-file</string>
        <string>src/routine-run.ts</string>
        <string>--id</string>
        <string>ai.tybo.preise-holen</string>
        <string>--</string>
        <string>/Users/NAME/.bun/bin/bun</string>
        <string>run</string>
        <string>src/preise-holen.ts</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/Users/NAME/tybo</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/NAME/.local/bin:/Users/NAME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin</string>
        <key>HOME</key>
        <string>/Users/NAME</string>
    </dict>

    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>7</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>

    <key>StandardOutPath</key>
    <string>/Users/NAME/tybo/logs/preise-holen.log</string>

    <key>StandardErrorPath</key>
    <string>/Users/NAME/tybo/logs/preise-holen.error.log</string>
</dict>
</plist>
```

Worauf es ankommt:

- **Wrapper:** `ProgramArguments` beginnt mit bun, `--no-env-file` und
  `src/routine-run.ts`; `--id` ist genau das `Label` der Plist; `--` trennt
  den Wrapper vom eigentlichen Befehl. `--no-env-file` verhindert, dass bun
  die `.env` in den Befehl lädt; der Wrapper liest sie selbst, nur für die
  Meldungen.
- **PATH:** launchd startet Dienste mit einem sehr kurzen PATH. Ohne
  `~/.local/bin` (als absoluter Pfad) findet ein Skript die Claude CLI nicht,
  ohne `/opt/homebrew/bin` keine Homebrew-Programme. Die Zeile oben enthält
  beides.
- **WorkingDirectory** ist der Projektordner, damit `src/routine-run.ts` und
  relative Pfade wie `data/preise.json` stimmen.
- **Zeitplan:** `StartCalendarInterval` für feste Termine (holt verpasste
  Termine nach dem Aufwachen nach), `StartInterval` mit Sekunden für „alle
  X Minuten" (pausiert im Schlaf und holt nicht nach).
- Nach jeder Änderung an einer geladenen Plist den Dienst einmal neu laden
  (`launchctl bootout gui/$(id -u)/ai.tybo.preise-holen`, dann wieder
  `bootstrap` wie oben); `plutil -lint <datei>` prüft die Datei vorher.

Fehlersuche: `docs/troubleshooting.md`, Abschnitte „Routine meldet Fehler"
und „Routine fehlt in der Übersicht".
