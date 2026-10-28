# 0003 Schlüssel im Browser nur schreibend und mit Opt-in

Datum: 23.09.2026. Entschieden von: Maintainer (Wunsch), Schutzregeln von der Plan-Session.

Der Maintainer wollte API-Schlüssel wie bei Hermes im Browser pflegen. Das hebt die
frühere Regel „die WebUI schreibt nie in `.env`" für genau diesen Fall auf.

Weil die WebUI im Heimnetz über HTTP läuft und Claude Code mit allen Werkzeugen
starten kann, gelten die Schutzregeln aus `SPEC.md` (Abschnitt „Schutzregeln
für Schlüssel"): nur schreiben, nie zurücklesen; Opt-in über
`WEB_ALLOW_KEY_EDIT`; Sicherung vor dem Schreiben;
Zugangsdaten für WebUI und Telegram bleiben Handarbeit.

Gebaut wird das als letzter Meilenstein (M6), nach Chat, Einstellungen,
Dateien und Autonomie.

Nachtrag 23.09.2026: Keine erneute Passwortabfrage pro Änderung (Maintainer). Die
WebUI läuft nur im eigenen Heimnetz, nicht in öffentlichen WLANs.
