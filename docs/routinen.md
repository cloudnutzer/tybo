# Routinen

Eine Routine ist ein Dienst, der nach Zeitplan von selbst läuft: der
Nachtcheck um 03:30, ein Watcher alle 10 Minuten, ein täglicher Bericht. Die
Routinen-Zentrale zeigt alle Routinen dieses Rechners an einer Stelle, hält
fest, wie ihre Läufe ausgingen, meldet Fehler sofort und bietet Knöpfe zum
Pausieren, Fortsetzen und Testen (Entscheidung
`docs/webui/decisions/0025-routinen-und-faeden.md`).

Den Zeitplan selbst führt weiter das Betriebssystem: unter macOS launchd,
unter Linux systemd-Timer (ohne systemd cron, den Nachtcheck dann unter
PM2), eingerichtet mit `tybo dienste`. tybo plant nichts selbst. launchd und
systemd holen verpasste Kalender-Termine nach dem Aufwachen nach und starten
Routinen auch dann, wenn der Bot gerade nicht läuft.

Unter Linux tragen die Timer die Zeitzone aus `USER_TIMEZONE`
(`OnCalendar=*-*-* 03:30:00 Europe/Berlin`): Der Nachtcheck läuft um 03:30
deiner Zeit, auch wenn der Server auf UTC steht. Fehlt `USER_TIMEZONE` oder
ist der Wert keine gültige Zeitzone, gilt die des Systems; bei einem
ungültigen Wert warnt `tybo dienste`. Nach einer Änderung von
`USER_TIMEZONE` schreibt `tybo dienste` die Timer neu. cron und PM2 rechnen
immer in der Zeitzone des Systems.

## Was als Routine zählt

- **macOS:** jeder launchd-Dienst mit Label `ai.tybo.*` aus
  `~/Library/LaunchAgents` (aus `tybo dienste`, gleichbedeutend
  `bun run setup:launchd`, und `/routine`), dazu
  jeder Dienst, den du in `config/routines.json` nennst.
- **Linux:** die systemd-Timer und -Dienste `tybo-*` aus
  `~/.config/systemd/user` (aus `tybo dienste` und `tybo setup autostart`)
  zusammen mit den PM2-Prozessen `tybo-*`.
- **Windows:** die PM2-Prozesse `tybo-*`.
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
aktive zeitgesteuerte launchd-Routine, auch nicht eingebundene, unter Linux
jeden aktiven systemd-Timer `tybo-*`, und braucht dafür den Bot nicht. Er sendet keine Einzelmeldung, sondern eine Zeile im
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
- Termine gelten in der Zeitzone des Systems, wie launchd sie auswertet,
  bei systemd-Timern in der Zeitzone hinter `OnCalendar`. Die
  Ruhezeit der proaktiven Meldungen ändert nichts: launchd startet die
  Routine trotzdem, sie schweigt selbst, und ihr Lauf zählt.
- Unter Linux meldet nur der Nachtcheck eine ausgebliebene Routine. Die
  sofortige Meldung „nicht gelaufen“ aus dem Bot gibt es nur unter launchd;
  ein ausgebliebener Check-in fällt unter Linux also spätestens in der
  nächsten Nacht auf. PM2-Zeitpläne prüft der Nachtcheck nicht.
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

## Linux, PM2 und andere Systeme

- **systemd-Timer (Linux):** Check-in, Briefing, Wartung und Nachtcheck
  laufen als `tybo-<dienst>.timer` (`tybo dienste`). Die Übersicht zeigt sie
  mit Zeitplan samt Zeitzone („täglich 03:30 (Europe/Berlin)“), Zustand
  (aktiv, pausiert, nicht geladen), letztem Exit-Code und nächstem Lauf.
  Weil der Dienst über den Wrapper läuft, steht der Verlauf unter
  `data/routines/ai.tybo.<dienst>.json`, also `/routinen health-check` wie
  unter macOS. Den Bot aus `tybo setup autostart` zeigt sie als
  Dauerdienst. Antwortet `systemctl --user` nicht, steht der Zustand als
  unbekannt mit einem Hinweis unter der Liste.
- **PM2 (Linux, Windows):** Die Übersicht liest die Prozesse `tybo-*` aus PM2,
  mit Status und, falls gesetzt, `cron_restart` als Zeitplan. Unter Linux
  stehen sie in derselben Liste wie die Timer („Routinen (systemd und PM2,
  5)“).
- **Nur lesend:** Unter Linux und Windows melden Pausieren, Fortsetzen und
  Testen „auf diesem System nicht verfügbar“, und `tybo routinen einbinden`
  gibt es nur unter macOS. Zustand im Terminal:
  `systemctl --user list-timers 'tybo-*'` und `pm2 status`.
- **cron** (Linux ohne systemd) erfasst die Übersicht nicht. Der Verlauf
  landet trotzdem in `data/routines/`, und Fehlschläge werden gemeldet.
- **Ohne launchd, systemd und PM2** sagt die Übersicht „auf diesem System
  nicht verfügbar“ und tut nichts.

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

## Wartung

`tybo wartung` räumt Posten weg, die sich gefahrlos neu erzeugen lassen,
und meldet, wie viel Platz frei wurde. Als Routine läuft sie einmal die
Woche, sonntags um 03:15, eingerichtet mit `tybo dienste wartung` (unter
macOS `ai.tybo.wartung`, unter Linux der Timer `tybo-wartung.timer` bzw.
eine cron-Zeile). `tybo dienste` ohne Angabe richtet sie nicht ein.

Die Posten stehen fest im Code (`src/lib/maintenance/items.ts`):

| Posten | Was passiert |
|---|---|
| Test-Simulatoren (macOS) | Geräte im Zustand Shutdown, deren Name auf ein Muster aus `simulatorMuster` passt und deren Geräteordner sich seit mindestens 12 Stunden nicht geändert hat, per `xcrun simctl delete <udid>`. Ohne Muster keine. |
| Nicht verfügbare Simulatoren (macOS) | `xcrun simctl delete unavailable`, unabhängig vom Muster: Geräte, deren Laufzeit fehlt, lassen sich nicht mehr starten. |
| Simulator-Laufzeiten ohne Gerät (macOS) | nur gemeldet; gelöscht nur mit `"runtimesLoeschen": true` |
| Caches | Inhalt der Download- und Build-Caches von Homebrew (nur `downloads`), go-build, pip, node-gyp, npm und bun |
| Logs | Dateien `*.log` direkt unter `logs/`, die größer als `abMb` sind |

Nie angefasst werden `~/Downloads`, Projektordner, `tmp/` im Projekt, der
Homebrew-Cellar (alte Versionen bleiben für ein Zurückwechseln), Ollama-
und Sprachmodelle, `~/Library/Caches` bzw. `~/.cache` als Ganzes und alles,
was nicht in der Tabelle steht.

Vorsicht ist eingebaut:

- **Simulatoren:** Laufende Geräte bleiben immer. Lässt sich der Bestand
  nicht lesen oder das Alter eines Geräts nicht feststellen, löscht die
  Wartung bei diesem Posten nichts. Direkt vor jedem Löschen liest sie den
  Bestand neu; ist das Gerät inzwischen gestartet oder umbenannt, bleibt es.
  Die 12 Stunden zählen ab der jüngsten Änderung am Geräteordner
  (`device.plist`, `data/`, letzter Start), nicht ab dem Anlegen.
- **Caches:** Die Pfade stehen je Plattform fest (macOS unter
  `~/Library/Caches`, Linux unter `~/.cache`, npm und bun in `~/.npm` bzw.
  `~/.bun`). Ist ein Cache-Ordner eine Verknüpfung oder führt sein Pfad über
  eine Verknüpfung woanders hin, bleibt er stehen. Hat sich darin in der
  letzten Stunde etwas geändert, läuft vermutlich gerade ein Build; dann
  bleibt er bis zur nächsten Wartung. Der Ordner selbst bleibt, nur sein
  Inhalt geht.
- **Logs:** Die Dienste halten ihre Logs offen. Umbenennen oder Löschen gäbe
  den Platz erst nach einem Neustart frei. Die Wartung sichert deshalb das
  Ende (`behaltenMb`) als `<name>.log.1`, ersetzt dabei die vorige Sicherung
  und kürzt die Datei auf 0. Die Dienste schreiben weiter, ohne Neustart.
- **Fehler:** Scheitert ein Posten, laufen die übrigen weiter. Der Fehler
  steht in der Meldung, der Lauf endet mit Exit-Code 1, und der Wrapper
  meldet ihn wie jede fehlgeschlagene Routine.
- **Nur einmal zugleich:** Eine Sperre (`data/wartung.lock`) verhindert, dass
  die geplante und eine Wartung von Hand gleichzeitig laufen.

`tybo wartung --dry-run` zeigt jeden Posten mit Größe und sagt, was gelöscht
würde. Der Probelauf löscht nichts, kürzt keine Logs, sendet nichts und
lässt `data/wartung.json` unverändert.

Nach einem echten Lauf kommt eine Meldung (`bun run notify --source
wartung`) mit dem freien Platz vorher und nachher und der Menge je Posten.
Die Summe der Posten und der gewonnene freie Platz weichen meist
voneinander ab, etwa weil andere Programme gleichzeitig schreiben oder das
Dateisystem Platz verzögert freigibt. Das Ergebnis steht danach in
`data/wartung.json` (letzter Lauf mit Zeit, Status, freiem Platz, je Posten
Anzahl, Größe, Hinweisen und Fehlern, dazu ob die Meldung rausging).

### Im Nachtcheck: „Plattenplatz“ und „Wartung“

Die Zeile „Plattenplatz“ warnt (⚠️) unter 15 % oder unter 25 GB freiem Platz
und meldet einen Fehler (❌) unter 5 % oder unter 10 GB, je nachdem, was
zuerst greift. Verglichen wird der genaue Anteil, nicht die gerundete
Anzeige; ist die Größe der Platte unbekannt, zählen nur die GB-Grenzen. Der
Hinweis nennt `tybo wartung --dry-run`, das zeigt, was sofort ginge, mit der
Summe.

Die Zeile „Wartung“ liest `data/wartung.json` und fragt den Dienst ab (unter
macOS launchd, unter Linux systemd-Timer oder cron), startet aber nichts:

| Zustand | Zeile |
|---|---|
| Dienst fehlt | – nicht eingerichtet, dahinter ein Lauf von Hand, falls es einen gab |
| eingerichtet, noch kein Lauf | ⚠️ noch kein Lauf |
| Datei ungültig oder unlesbar | ⚠️ |
| letzter Lauf ohne Fehler | ✅ mit Alter und abgeräumter Menge |
| letzter Lauf mit Fehlern (Abbruch, Posten, Dienste, Meldung) | ⚠️ mit den Fehlern |
| letzter Lauf älter als 8 Tage | ⚠️ |
| Dienst liegt da, ist aber abgeschaltet oder nicht geladen | ⚠️, einschalten mit `tybo dienste wartung` |
| Dienst nicht feststellbar | ⚠️ |

Die abgeräumte Menge ist die Summe der Posten, nicht der Unterschied beim
freien Platz.

### Einstellungen: `config/wartung.json`

Vorlage: `config/wartung.example.json`. Alle Schlüssel sind freiwillig; die
Datei ist nicht im Repo.

```json
{
  "simulatorMuster": ["MeinTest-*"],
  "runtimesLoeschen": false,
  "caches": ["homebrew-downloads", "go-build", "pip", "node-gyp", "npm", "bun"],
  "logs": { "abMb": 50, "behaltenMb": 5 }
}
```

- `simulatorMuster`: Namen der Test-Simulatoren, `*` für beliebig viele
  und `?` für genau ein Zeichen; das Muster muss auf den ganzen Namen
  passen und mindestens drei feste Zeichen haben. Standard: leer.
- `runtimesLoeschen`: Laufzeiten ohne Gerät löschen statt nur melden.
  Standard: `false`.
- `caches`: Auswahl aus den festen Kennungen oben; eigene Pfade gibt es
  nicht. Standard: alle.
- `logs`: ab welcher Größe ein Log gekürzt wird und wie viel vom Ende
  bleibt. Standard: 50 und 5 MB.

Ist die Datei ungültig (kaputtes JSON, unbekannter Schlüssel, unbekannte
Kennung, zu breites Muster), bricht die Wartung ab, ohne etwas anzufassen,
und meldet das.

### Dienste nach Updates neu starten

Ein Update ersetzt die Programmdatei, der laufende Dienst arbeitet aber mit
der alten Version weiter, bis ihn jemand neu startet. So lief etwa der
Cloudflare-Tunnel nach einem Homebrew-Update noch tagelang mit der alten
cloudflared-Version. Mit dem Schlüssel `dienste` in `config/wartung.json`
vergleicht tybo bei Dauerdiensten die laufende mit der installierten
Version und startet sie neu, wenn sie älter ist
(`src/lib/maintenance/services.ts`). Das passiert:

- in jeder Wartung (`tybo wartung`, sonntags 03:15),
- nach jedem `bun run updates --apply`, auch wenn nichts Neues kam oder ein
  Teil scheiterte.

Der Nachtcheck zeigt in der Zeile „Dienst-Versionen“ eine Abweichung als ⚠️,
startet aber nichts. `tybo wartung --dry-run`, `bun run updates --dry-run`
und `bun run updates --smoke` starten ebenfalls nie einen Dienst.

```json
{
  "dienste": [
    {
      "name": "Cloudflare-Tunnel",
      "launchd": "ai.tybo.cloudflare-tunnel",
      "versionBefehl": ["cloudflared", "--version"],
      "metrik": { "url": "http://127.0.0.1:20241/metrics", "name": "build_info", "label": "version" }
    }
  ]
}
```

- **Dienst:** genau einer von `launchd` (Label `ai.tybo.<dienst>`),
  `systemd` (Benutzerdienst `tybo-<dienst>.service`) oder `pm2` (Prozess
  `tybo-<dienst>`). Dienste mit anderen Namen fasst tybo nicht an.
- `versionBefehl`: Befehl für die installierte Version als Liste, ohne
  Shell. Zählt die erste Versionsnummer der Ausgabe.
- Laufende Version, genau eins von beiden:
  - `metrik`: Adresse auf diesem Rechner (`127.0.0.1`, `localhost`,
    `[::1]`) mit Prometheus-Text; `name` und `label` nennen die Zeile, etwa
    `build_info{version="2026.10.3"}`. Standard: `build_info` und
    `version`. Den Port von cloudflared nennt sein Log beim Start
    („Starting metrics server on 127.0.0.1:…/metrics“); ist er ein
    anderer als in der Vorlage, hier eintragen.
  - `binaer`: Ersatz für Dienste ohne Metrik, absoluter Pfad der
    Programmdatei. tybo vergleicht den Prozess des Diensts (PID vom
    Dienstmanager) mit dieser Datei samt Symlink-Ziel: Läuft er aus einem
    anderen Pfad mit gleichem Programmnamen (etwa einem alten
    Homebrew-Cellar) oder hat sich die Datei nach seinem Start geändert,
    gilt er als veraltet. Eine Versionsnummer beweist das nicht; gehört der
    Prozess zu einem anderen Programm, bleibt der Dienst unangetastet.
- `wartezeitSek`: so lange wartet die Nachprüfung nach dem Neustart
  höchstens (5 bis 300, Standard 60).

Fehlt `dienste`, wird kein Dienst angefasst. Die Vorlage nennt cloudflared
unter launchd; unter Linux stattdessen `"systemd":
"tybo-cloudflare-tunnel.service"` bzw. `"pm2": "tybo-cloudflare-tunnel"`.

Ablauf je Dienst:

1. Läuft der Dienst nicht, ist die installierte oder die laufende Version
   nicht feststellbar oder läuft er sogar neuer als installiert: kein
   Neustart, nur ein Hinweis in Meldung und Nachtcheck.
2. Läuft er älter: Neustart mit `launchctl kickstart -k gui/<uid>/<label>`,
   `systemctl --user restart <unit>` bzw. `pm2 restart <name>`.
3. Danach misst tybo alle zwei Sekunden frisch, bis der Dienst mit neuer
   PID läuft und die neue Version meldet, höchstens `wartezeitSek`. Jede
   Messung bekommt nur die restliche Wartezeit; was erst danach ankommt,
   zählt nicht. Klappt das nicht (Neustart scheitert, Dienst bleibt aus,
   alte Version, Messung zu spät), steht es als Fehler in der Meldung, im
   Zustand (`data/wartung.json` bzw. `data/software-update.json`) und im
   Exit-Code der Wartung. Mit `binaer` gibt es danach keine gemessene
   Versionsnummer; die Meldung nennt dann die bestandene Prozess- und
   Dateiprüfung („danach: Prozess jünger als die Datei“).

Fehlertexte nennen vom `versionBefehl` nur das Programm, nicht die
Argumente. Werte geheim benannter Variablen (`*_TOKEN`, `*_KEY`, auch aus
der `.env`), Zugangsdaten aus den Argumenten (`--token=…`, `--password …`)
und Muster wie `token=…` oder ein Passwort in einer Adresse stehen weder in
Meldung und Zustand noch im Terminal, sondern als `[verborgen]`.

Der Bot selbst (`ai.tybo.telegram-relay` oder `TYBO_LAUNCHD_LABEL`,
`tybo-telegram-relay.service` oder `TYBO_SYSTEMD_UNIT`, PM2
`tybo-telegram-relay`) startet nie über den Dienstmanager neu: dabei fielen
alle laufenden Antworten weg. `tybo wartung` liest `TYBO_LAUNCHD_LABEL` und
`TYBO_SYSTEMD_UNIT` dafür auch aus der `.env` des Projekts. Für ihn fordert tybo den Neustart über
`data/restart-requested` an, wie `bun run restart:request`; der Bot startet
neu, sobald keine Antwort mehr läuft.

Wartung und Update teilen sich die Sperre `data/dienste.lock`. Laufen beide
gleichzeitig, prüft der zweite keine Dienste und sagt das in seiner Meldung.
