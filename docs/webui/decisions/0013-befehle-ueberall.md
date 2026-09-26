# 0013 Slash-Befehle in Browser und Terminal wie in Telegram

Datum: 24.09.2026. Entschieden von: Maintainer.

- Alle Slash-Befehle aus Telegram gehen auch im Browser und im Terminal, nicht
  nur `/goal` und `/board`. Dafür gibt es eine gemeinsame Befehls-Schicht, die
  Telegram, Web und Terminal gleich behandelt, statt jeden Befehl je Kanal neu
  zu bauen.
- Ausgewertet wird auf dem Server: Eine Nachricht aus Browser oder Terminal,
  die mit einem bekannten Befehl beginnt, wird als Befehl ausgeführt. Rein
  lokale Befehle der Oberflächen (`/b64` im Browser, `/wechsel`, `/quit` im
  Terminal) bleiben beim Client.
- In Telegram gespiegelt wie gewohnt: „Du (Web): /board …", danach die
  Beiträge der Agenten.
- Reihenfolge: M5 nach M7 Terminal-Chat.
