# 0002 Sicherheit: immer Passwort, Heimnetz nur auf Wunsch

Datum: 23.09.2026. Entschieden von: Plan-Session (Vorschlag, vom Maintainer bestätigt bei der Abnahme von M1).

Der Web-Chat startet Claude Code mit allen Werkzeugen (Bash, Dateien, MCP).
Wer die WebUI bedienen kann, kann also Befehle auf dem Mac ausführen.

- Ohne `WEB_PASSWORD` startet die WebUI nicht, auch nicht auf `127.0.0.1`.
  Grund: Jede Webseite im Browser kann Anfragen an localhost schicken.
- `WEB_HOST` ist standardmäßig `127.0.0.1`. Heimnetz nur mit `WEB_HOST=0.0.0.0`
  oder einer festen LAN-IP.
- Session-Cookie `HttpOnly`, `SameSite=Strict`, 30 Tage, serverseitig
  zufälliges Token. Schreibende Anfragen prüfen zusätzlich den `Origin`-Header.
- `Host`-Header muss localhost, 127.0.0.1, eine IP des Rechners oder ein
  Eintrag aus `WEB_ALLOWED_HOSTS` sein (Schutz gegen DNS-Rebinding).
- Login: höchstens 10 Fehlversuche pro IP und 15 Minuten, danach 429.
- Strenge `Content-Security-Policy` ohne Inline-Skripte; Markdown der Antworten
  wird auf dem Server gerendert, rohes HTML darin wird escaped.

Bekannte Grenze: Im Heimnetz läuft HTTP unverschlüsselt. Wer im selben WLAN
mitschneidet, sieht Passwort und Chat. Für mehr ist Tailscale der Weg (später).
