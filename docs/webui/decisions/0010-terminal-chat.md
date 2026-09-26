# 0010 Chat im Terminal über den laufenden Bot

Datum: 24.09.2026. Entschieden von: Maintainer (Wunsch, wie bei Hermes), Umsetzung Plan-Session.

- `tybo` (ohne Argumente) startet einen Chat im Terminal. Er ist ein schlanker
  Client des **laufenden** Bots über dieselbe HTTP-Schnittstelle wie die WebUI,
  kein zweiter Bot (zwei Prozesse mit demselben Telegram-Token stören sich).
- Gleiche Gespräche, Topics, Sessions und Gedächtnis wie Telegram und Web.
  Terminal-Nachrichten erscheinen in Telegram gespiegelt als „Du (Terminal): …"
  (wie 0004 für das Web).
- Anmeldung ohne Passwort: Der Bot legt beim Start einen zufälligen Schlüssel in
  `data/cli-token` ab (Rechte 0600). Er gilt nur für Anfragen von 127.0.0.1/::1.
  Wer auf dem Rechner als dieser Benutzer arbeitet, auch per SSH, kann chatten;
  aus dem Netz geht das nur mit dem WebUI-Passwort.
- Läuft der Bot nicht, sagt `tybo` das klar und nennt den Startbefehl, statt
  selbst einen Bot zu starten.
