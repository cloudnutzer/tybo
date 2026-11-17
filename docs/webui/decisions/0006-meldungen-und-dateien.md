# 0006 Hintergrundmeldungen und Dateien erscheinen in der WebUI

Datum: 24.09.2026. Entschieden von: Maintainer.

Bisher schicken mehrere Absender direkt über die Telegram-Bot-API, am Bot
vorbei: die WebUI-Pipeline, Morgen-Briefing, Check-ins, Watchdog, Watcher und
Claude-Subprozesse, die gebaute Dateien per `curl sendDocument` verschicken.
Nichts davon landet im Nachrichten-Speicher, die WebUI zeigt es nicht, und ein
Bot kann seine eigenen gesendeten Nachrichten über die API nicht zurücklesen.

Entscheidung:

- Ein gemeinsamer Weg „senden und festhalten" (`src/lib/outbox.ts` plus CLI
  `bun run notify`) schickt die Nachricht oder Datei an Telegram und speichert
  sie im Nachrichten-Speicher des passenden Gesprächs (Direktchat oder Topic).
- Solche Einträge sind **nur zur Anzeige** (`metadata.display_only = true`,
  `metadata.source` z.B. `pipeline`, `briefing`, `checkin`, `watchdog`,
  `watcher`, `datei`). Sie gehen nie in den Gesprächskontext, die semantische
  Suche, `history_search`, Destillat oder Feedback-Loop. Sonst redet tybo beim
  nächsten Mal über Pipeline-Stände.
- Dateien werden beim Senden nach `data/outbox/` kopiert (höchstens 50 MB wie
  das Telegram-Limit) und in der WebUI nur angemeldet ausgeliefert, standardmäßig
  als Download (`Content-Disposition: attachment`, `nosniff`); Vorschau für
  PNG, JPEG, WebP und GIF. SVG wird nie im Browser der WebUI geöffnet, weil es
  sonst unter derselben Adresse Skripte ausführen könnte.
- Seit 30.10.2026 lassen sich Audio und Video im Chat abspielen (Endung, Typ und
  erste Bytes müssen passen) und HTML in einem eigenen Tab öffnen. HTML kommt dann
  mit `Content-Security-Policy: sandbox` ohne `allow-same-origin`: Die Seite hat
  keinen eigenen Ursprung, kommt also nicht an Sitzung oder API.
- Der Bot-Prozess holt neue Einträge anderer Prozesse selbst ab (kurzes
  Abfrageintervall) und meldet sie live an offene Browser; die Absender
  brauchen keinen Zugang zur WebUI.
- Scheitert das Festhalten, wird trotzdem gesendet (Telegram geht vor), der
  Fehler landet im Log.
