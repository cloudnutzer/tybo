# 0011 Einrichtungsassistent im Terminal und im Browser

Datum: 24.09.2026. Entschieden von: Maintainer (Wunsch, wie `hermes setup`), Umsetzung Plan-Session.

- Ein gemeinsamer Kern beschreibt die Schritte der Einrichtung als Daten
  (prüfen, abfragen, testen, schreiben). Terminal und Browser sind nur zwei
  Oberflächen dafür, damit beide nie auseinanderlaufen.
- Schritte: Voraussetzungen (Bun, Claude CLI angemeldet), Telegram (Token,
  Nutzer-ID, Test), optional Forum-Gruppe, Datenbank (Supabase oder Convex,
  Test), Profil (Name, Zeitzone), Modelle und Fallback, WebUI (Passwort, Host),
  Autostart (launchd auf macOS, PM2 sonst), Gesamtprüfung.
- Terminal: `tybo setup` führt durch alles, `tybo setup <abschnitt>` durch
  einen Teil. Vorhandene Werte werden erkannt und nur als „gesetzt" gezeigt.
- Browser: Fehlt beim Start eine Pflichtangabe (Telegram), startet der Bot im
  **Einrichtungsmodus**: kein Telegram, nur der Assistent, erreichbar nur über
  127.0.0.1, geschützt durch einen Einmal-Code, der im Terminal und Log steht.
  `tybo setup --web` startet diesen Modus auch bewusst. Nach Abschluss startet
  der Bot normal neu.
- Geschrieben wird die `.env` nach den Schutzregeln aus M6 (Sicherung, atomar,
  0600, Kommentare bleiben, Werte nie zurück an die Oberfläche). Ausnahme nur im
  Einrichtungsmodus und im Terminal: `TELEGRAM_*` und `WEB_*` dürfen gesetzt
  werden, im normalen Betrieb bleiben sie in der WebUI gesperrt.
