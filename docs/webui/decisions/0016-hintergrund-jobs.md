# 0016 Hintergrund-Jobs mit verlässlicher Rückmeldung

Datum: 25.09.2026. Entschieden von: Maintainer.

- Lange Aufträge laufen als eigener, losgelöster Claude-Prozess (eigene
  Prozess-Session, kein Zeitlimit einer Antwort), gesteuert über eine
  Auftragsdatei. Der Starter meldet sich **immer**: bei Erfolg mit dem Bericht
  des Jobs, bei Absturz, Zeitüberschreitung oder fehlendem Bericht mit den
  letzten Log-Zeilen. Rückkanal ist `sendAndRecord` (Telegram-Topic + WebUI).
- Jobs liegen unter `data/jobs/<id>/` (Auftrag, Log, Status, Bericht) und sind
  auflistbar und stoppbar. Ohne Rückfragen, deshalb volle Werkzeug-Rechte nur
  für Aufträge, die tybo selbst formuliert hat.

## Nachtrag 18.11.2026: Job-Rückfragen (Issue #624)

Entschieden von: Maintainer (Freigabe der Ideen 1, 2 und 4 am 12.11.2026).

„Ohne Rückfragen“ gilt weiterhin für Werkzeugfreigaben. Claude-Jobs mit
gespeicherter Session und ohne eigenen Arbeitsordner dürfen eine fachliche
Entscheidung über `frage.json` erfragen. Der Wächter speichert `waiting`,
stellt die Frage im Zielgespräch mit Knöpfen und endet. Eine Antwort eröffnet
unter den Job-Sperren einen neuen Lauf derselben Session. Im Browser gibt es
Knöpfe, in Telegram zusätzlich einen gezielten Reply auf die Fragemeldung.

Wartezeit verbraucht kein Arbeitszeitbudget. Antworten nutzen nur den Rest;
die Arbeitszeit wird über alle Läufe aufsummiert. Nur eine ausdrückliche
Fortsetzung nach Abbruch oder Zeitüberschreitung erneuert wie bisher das
Budget. Nach 48 Stunden ohne Antwort endet der Job als `unanswered` mit
Fortsetzen-Knopf. Fortsetzen bittet Claude um dieselbe Frage, solange vom
Limit von fünf Fragen noch welche übrig sind; sonst schreibt Claude einen
Bericht über die offene Entscheidung. Es entscheidet nicht stellvertretend.
Die fünfte Frage darf beantwortet werden; eine sechste wird mit Meldung
abgelehnt. Der Zähler überdauert alle Fortsetzungen.

Codex, alte Jobs ohne Session und Jobs mit `workDir` (Sprachagenten-Entwürfe)
bekommen keinen Frage-Zusatz und ignorieren eine solche Datei. Pipeline und
eine übergreifende Übersicht offener Entscheidungen gehören nicht dazu.

## Nachtrag 18.11.2026: Bericht zurück ins Gespräch (Issue #625)

Entschieden von: Maintainer (Freigabe der Idee 2 am 12.11.2026).

Nur mit `job start --zurueck` geht ein erfolgreicher Job-Bericht zusätzlich
als Eingabe in das Zielgespräch. Das ist eine ausdrückliche Ausnahme zur
Regel „nie im Gesprächskontext“ aus Entscheidung 0006. Ohne die Option bleibt
der Bericht eine Nur-Anzeige-Meldung. Agent, Motor und Session richten sich
beim Abholen nach dem aktuellen Gespräch, auch nach `/new`.

Der Bericht ist fremder Inhalt: maskiert, begrenzt und als `<job-bericht>`
gekennzeichnet. Merk-Tags aus dem Turn werden über das Intent-Gate vorgeschlagen,
nicht automatisch übernommen. Die gespeicherte Eingabe erhält Herkunftsmetadaten,
bleibt beim Motorwechsel verfügbar und erscheint nicht als zweite Nutzerblase.
Diese Turns erzeugen keine offenen Fäden.

Die Rückgabe steht je Job und Lauf unter der vorhandenen Statussperre. Sie
wartet auf den endgültigen Versandzustand der Meldung und auf einen freien Turn.
Abbrüche, Zeitlimits, Fragen und fehlende Berichte lösen keinen Turn aus.
Nach Übernahme und Absturz wird kein Modelllauf wiederholt; stattdessen wird
die Unterbrechung einmal gemeldet und protokolliert. Das verhindert doppelte
Werkzeuge und Folge-Jobs, ohne ein unmögliches „genau einmal“ mitten im Turn
zu versprechen. Höchstens drei `--zurueck`-Jobs dürfen über den vererbten
Kettenzähler aufeinander folgen; der vierte wird mit Exit 2 abgelehnt.
