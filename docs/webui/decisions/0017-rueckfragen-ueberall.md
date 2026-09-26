# 0017 Rückfragen mit Knöpfen in Telegram, Browser und Terminal

Datum: 25.09.2026. Entschieden von: Maintainer.

- Die Knöpfe, mit denen tybo in Telegram nachfragt (Werkzeug-Freigabe,
  Merk-Vorschlag und Routine-Angebot, `/goal` „Weiter?", „Welcher Agent gehört
  zu diesem Topic?"), erscheinen in der WebUI als echte Knöpfe unter der
  Nachricht und wirken genauso wie in Telegram. Im Terminal-Chat als
  nummerierte Auswahl (`1`, `2` …).
- Eine Entscheidung gilt überall: Wer in Telegram klickt, sieht die Frage im
  Browser als erledigt („Erledigt: Erlauben · in Telegram") und umgekehrt, die
  Telegram-Nachricht wird nachgezogen. Doppeltes Auslösen ist ausgeschlossen.
- Dafür gibt es ein gemeinsames Rückfragen-Register (`data/choices.json`, mit
  Sperre wie `pending-reviews.json`, weil auch die Sprach-Brücke schreibt).
  Eine Frage wird darin genau einmal entschieden, egal aus welchem Kanal.
- Sicherheitsregeln wie bei allen schreibenden Routen: Login bzw. lokaler
  Terminal-Schlüssel, Cloudflare-Access-Nachweis über den Tunnel,
  Origin-Prüfung; eine Frage ist nur aus ihrem eigenen Gespräch entscheidbar.
- Entschieden (Maintainer, 25.09.2026): Werkzeug-Freigaben erscheinen im Gespräch des Turns
  (Topic, Direktchat, Web-Gespräch) statt immer im Direktchat; Fragen aus
  reinen Web-Gesprächen zusätzlich als Kopie im Direktchat. Die Text-Antwort
  „ja" bleibt als zweiter Weg.
- Knöpfe aus der Zeit vor dem Update (`toolapproval:`, `rev|`, `goalkb|`,
  `topicmap:`) wirken weiter bzw. melden „abgelaufen".
- Nicht in M10: Check-in-Knöpfe und `ask_user`-Rückfragen; `buttonsAsText`
  bleibt für Befehle ohne Register-Eintrag.
- `docs/webui/SPEC.md` wird angepasst: „Freigabe-Buttons im Web-Chat" steht
  nicht mehr unter „Gar nicht gebaut wird".
