# Erinnerungen

tybo erinnert dich zu einem Zeitpunkt an etwas, einmal oder regelmäßig. Du
sagst es im Gespräch, tybo legt die Erinnerung an und schickt sie zur
fälligen Zeit in dasselbe Gespräch, in Telegram und in der WebUI, mit
Knöpfen zum Verschieben.

Erinnerungen laufen im Bot-Prozess und speichern in der Datenbank, die tybo
ohnehin nutzt (Supabase) oder ohne Datenbank in einer Datei unter `data/`.
Ein Cloud-Dienst oder eine zusätzliche Einrichtung ist nicht nötig.

## Erinnerung anlegen

Einfach schreiben, etwa:

- „Erinnere mich morgen um 9 an den Zahnarzt."
- „In 20 Minuten: Tee aus der Kanne nehmen."
- „Jeden Montag um 8 an den Wochenplan erinnern."

tybo setzt dafür in seiner Antwort den Tag `[REMIND: wann | Text]`, die
Erinnerung steht danach sofort in der Liste. Zeitangaben gelten in deiner
Zeitzone (`USER_TIMEZONE` in `.env`, ohne Angabe UTC):

| Angabe | Bedeutung |
|---|---|
| `17:30`, `9 Uhr`, `5pm` | heute zu dieser Uhrzeit, sonst morgen |
| `in 2 Stunden`, `in 20 Minuten` | ab jetzt |
| `morgen 9 Uhr`, `Freitag 8:15`, `2026-10-20 18 Uhr` | Tag und Uhrzeit |
| `morgen`, `Freitag`, `in 3 Tagen` | an diesem Tag um 9 Uhr |

Wiederholungen: täglich, werktags (Montag bis Freitag), einmal die Woche an
einem Wochentag oder alle n Stunden. Über eine Zeitumstellung bleibt die
Uhrzeit gleich.

Kommt die Bitte aus fremdem Inhalt (eine Webseite, eine Mail, eine
hochgeladene Datei), legt tybo die Erinnerung nicht direkt an, sondern
schlägt sie mit Knöpfen vor.

## Wann die Erinnerung kommt

Der Bot prüft alle 30 Sekunden, ob etwas fällig ist, und schickt jede
Erinnerung genau einmal. Das heißt auch: **Sie kommt nur, wenn der Bot
läuft.** Ist der Rechner aus oder schläft er, kommt sie, sobald der Bot
wieder läuft, mit dem Hinweis „verspätet, fällig war …". Bei einer Serie
kommt danach der nächste reguläre Termin; verpasste Termine einer Serie
werden nicht nachgeholt.

Unter jeder Erinnerung stehen drei Knöpfe, in Telegram und im Browser:

- **Erledigt**: nichts weiter. Eine Serie läuft weiter.
- **in 1 Stunde**: noch einmal in einer Stunde.
- **morgen 9 Uhr**: noch einmal morgen früh.

Bei einer Serie verschieben die Knöpfe nur diesen einen Termin; die Serie
bleibt, wie sie ist.

Ohne Telegram (nur WebUI) kommen Erinnerungen in den Direktchat der WebUI.

## Übersicht und Absagen

**`/erinnerungen`** zeigt alle offenen Erinnerungen aller Gespräche, nach
Fälligkeit, in Telegram, im Browser und im Terminal (`tybo`) gleich:

```
Offene Erinnerungen (2):

• 20.10. 14:30 · Zahnarzt anrufen
   Kennung 3f2a9c1e · Direktchat

• 21.10. 08:05 · Tabletten
   Kennung 9b07d4a2 · Topic Gesundheit · täglich 08:05

Absagen: /erinnerungen absagen <kennung>
```

**`/erinnerungen absagen <kennung>`** sagt eine Erinnerung ab, aus jedem
Gespräch. Eine Serie endet damit ganz. Wird die Erinnerung genau in dem
Moment verschickt, sagt tybo das und sagt nichts ab; eine Serie lässt sich
gleich danach absagen. Ein Knopf an einer früher verschickten Erinnerung
meldet nach der Absage nur noch, dass es sie nicht mehr gibt.

In der **WebUI** steht dieselbe Liste unter Einstellungen, Reiter
„Erinnerungen", mit einem Knopf „Absagen" je Eintrag (mit Rückfrage).

## Wo die Erinnerungen liegen

- Mit Supabase in der Tabelle `scheduled_tasks` (Migration
  `db/migrations/20261017_scheduled_tasks.sql` und
  `20261018_scheduled_tasks_lease.sql`; `tybo setup datenbank` spielt sie ein).
- Ohne Datenbank in `data/reminders.json.sqlite` (der Pfad heißt
  `data/reminders.json`, geschrieben wird über SQLite, damit gleichzeitige
  Änderungen nicht verloren gehen).

Abgesagte und verschickte Einträge bleiben in der Ablage stehen, die Liste
zeigt sie nicht mehr.

## Alte Erinnerungen übernehmen

Wer vorher ein eigenes Skript mit einer Datei `config/reminders.json`
benutzt hat (ein Array mit `id`, `date`, `time`, `message`, `sent` und
optional `sent_at`), übernimmt deren offene Einträge einmal:

1. Das alte Skript bzw. seinen Dienst zuerst anhalten und warten, bis ein
   laufender Durchlauf fertig ist. Sonst schicken beide.
2. Im Projektordner:

   ```bash
   tybo erinnerungen importieren
   ```

   Eine andere Datei geht mit `tybo erinnerungen importieren <datei>`
   (relativ zum Projektordner).

Übernommen werden nur Einträge mit `sent: false` und ohne `sent_at`. Datum
und Uhrzeit gelten in `USER_TIMEZONE`, ohne Uhrzeit um 9 Uhr. Ziel ist der
Direktchat. Was schon vorbei ist, kommt kurz nach dem nächsten Start des
Bots mit Verspätungshinweis. Einträge mit unlesbarem Datum, unlesbarer
Uhrzeit oder ohne Text nennt der Befehl mit Position und übernimmt sie
nicht.

Jeder Eintrag kommt genau einmal an: Der Befehl lässt sich gefahrlos
wiederholen, auch nach einem Abbruch; schon übernommene, inzwischen
abgesagte oder verschickte Einträge kommen nicht wieder.

## Wenn etwas nicht funktioniert

- **Erinnerung kam nicht:** Läuft der Bot (`tybo` meldet sonst „kein Bot")?
  Steht sie in `/erinnerungen`? Steht dort länger als zwei Minuten „wird
  gerade zugestellt", war der Bot mitten im Versand weg; der nächste
  Durchlauf holt eine noch nicht begonnene Zustellung nach und schließt eine
  begonnene ab, ohne sie ein zweites Mal zu schicken.
- **Falsche Uhrzeit:** `USER_TIMEZONE` in `.env` prüfen (etwa
  `Europe/Berlin`); ohne Angabe rechnet tybo in UTC.
- **Mit Supabase „nicht angelegt":** Die Migrationen oben fehlen. `tybo setup
  datenbank` erneut ausführen.
