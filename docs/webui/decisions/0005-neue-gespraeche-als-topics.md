# 0005 Neue Gespräche aus dem Browser sind Telegram-Topics

Datum: 24.09.2026. Entschieden von: Maintainer.

Jedes neue Gespräch, das im Browser angelegt wird, ist ein echtes Topic in der
Forum-Gruppe (Bot-API `createForumTopic`) mit dem gewählten Agenten in
`config/topics.json`. Damit gibt es nur noch eine Art Gespräch, und alles ist in
Telegram und im Browser sichtbar (gespiegelt nach 0004).

- Umbenennen im Browser ruft `editForumTopic` auf und aktualisiert
  `data/topic-names.json`.
- Schließen (`closeForumTopic`) ist umkehrbar; Löschen (`deleteForumTopic`)
  entfernt Topic und alle Telegram-Nachrichten darin endgültig. Deshalb nur mit
  ausdrücklicher Rückfrage, die den Namen nennt. Der Verlauf in Supabase und das
  Gedächtnis bleiben erhalten; Zuordnung und Session des Topics werden entfernt.
- „General" und der Direktchat sind davon ausgenommen.
- Rechte: Der Bot braucht in der Gruppe „Topics verwalten" (vorhanden) und für
  Löschen zusätzlich „Nachrichten löschen" (Stand 24.9. fehlt). Fehlt ein Recht,
  zeigt die WebUI das klar an, statt stumm zu scheitern.
- Reine Web-Gespräche von vorher bleiben bestehen, neue entstehen nicht mehr.
