# 0014 Zugang von unterwegs über app.tybo.ai

Datum: 25.09.2026. Entschieden von: Maintainer.

- Die WebUI wird zusätzlich unter **https://app.tybo.ai** erreichbar, über den
  Cloudflare-Tunnel-Dienst des Rechners (`ai.tybo.cloudflare-tunnel`).
- **Zwei Schlösser:** Cloudflare Access davor (Einmal-Code per E-Mail), dahinter
  weiterhin das WebUI-Passwort. Die WebUI prüft selbst den Access-Nachweis
  (`Cf-Access-Jwt-Assertion`) und lehnt Tunnel-Anfragen ohne gültigen Nachweis
  ab, damit eine falsch konfigurierte Access-Regel nicht alles öffnet.
- **Keine lokalen Sonderrechte über den Tunnel:** Über den Tunnel kommen
  Anfragen scheinbar von 127.0.0.1. Terminal-Schlüssel (`data/cli-token`) und
  Einrichtungsmodus gelten nur für echte lokale Anfragen, nie für getunnelte.
- **Schlüssel ändern nur im Heimnetz** (Empfehlung der Plan-Session, vom Maintainer
  nicht widersprochen); von unterwegs sind Schlüssel nur lesbar.
- Bis zu diesem Meilenstein gilt Entscheidung 0002 (nur Heimnetz) weiter.
