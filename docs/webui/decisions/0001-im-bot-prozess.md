# 0001 Web-Server im Bot-Prozess

Datum: 23.09.2026. Entschieden von: Plan-Session (Vorschlag, vom Maintainer bestätigt bei der Abnahme von M1).

Der Web-Server läuft in `src/bot.ts` als zweiter `Bun.serve` auf eigenem Port
(`WEB_PORT`, Standard 3100), nicht als eigener Prozess.

Grund: Sessions (`data/sessions.json`), Abbruch (`abortClaudeCalls`), die
Warteschlange `runExecution` und die Neustart-Logik (`activeClaudeCallCount`)
leben im Bot-Prozess. Ein eigener Prozess müsste das alles über HTTP spiegeln
oder würde sich mit dem Bot um dieselbe Session streiten.

Der Health-Server (`HEALTH_PORT`, `/process`) bleibt unverändert und lokal.
Die WebUI bekommt einen eigenen Port, weil sie ins Heimnetz darf und der
Health-Server nicht.

Folge: Die WebUI ist nur da, wenn der Bot läuft. Ein Neustart des Bots trennt
laufende Browser-Verbindungen; der Browser verbindet sich neu.
