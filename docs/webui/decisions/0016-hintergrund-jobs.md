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
