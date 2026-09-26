# WebUI von unterwegs: app.tybo.ai

Entscheidung 0014. Die WebUI ist zusätzlich unter **https://app.tybo.ai**
erreichbar, über den Cloudflare-Tunnel-Dienst des Rechners (`ai.tybo.cloudflare-tunnel`).
Davor liegen zwei Schlösser:

1. **Cloudflare Access**: Wer app.tybo.ai öffnet, meldet sich zuerst bei
   Cloudflare mit einem Einmal-Code per E-Mail an. Erst dann reicht Cloudflare
   die Anfrage an den Tunnel weiter, mit einem signierten Nachweis in der
   Kopfzeile `Cf-Access-Jwt-Assertion`.
2. **WebUI-Passwort**: dahinter wie im Heimnetz.

Die WebUI prüft den Access-Nachweis selbst. Fehlt er oder stimmt etwas nicht
(Signatur, Anwendung, Aussteller, Ablauf), antwortet sie mit 403. Eine falsch
eingestellte Access-Regel öffnet also nicht alles.

Über den Tunnel gibt es keine lokalen Sonderrechte: kein Terminal-Schlüssel
(`data/cli-token`), kein Einrichtungsmodus. Schlüssel (Seite „Schlüssel") sind
von unterwegs nur lesbar, ändern geht nur im Heimnetz.

## Woran die WebUI getunnelte Anfragen erkennt

cloudflared verbindet sich von 127.0.0.1 und setzt die Kopfzeile
`CF-Connecting-IP` mit der Adresse des Besuchers. Ist `WEB_PUBLIC_ORIGIN`
gesetzt, gilt jede solche Anfrage als getunnelt. Dann gilt:

- Host genau `app.tybo.ai`, bei schreibenden Anfragen Origin genau
  `https://app.tybo.ai`, sonst 421 bzw. 403
- gültiger Access-Nachweis, sonst 403 „Zugang von unterwegs nur mit gültiger
  Cloudflare-Access-Anmeldung", und zwar vor Anmeldung, Seiten, Dateien,
  Uploads und Live-Verbindungen
- Login-Bremse pro Besucher-IP, Cookie mit `Secure`

Der Einrichtungsmodus lehnt jede Anfrage mit Tunnel-Kopfzeilen ab, auch ohne
`WEB_PUBLIC_ORIGIN`.

## 1. Tunnel-Eintrag

In der Konfiguration des bestehenden Tunnels (Zero Trust → Networks →
Tunnels → Tunnel des Macs → Public Hostname, oder `ingress` in der
`config.yml` von cloudflared) einen Eintrag ergänzen:

| Feld | Wert |
|---|---|
| Hostname | `app.tybo.ai` |
| Service | `http://localhost:3100` |

Der Port muss zu `WEB_PORT` passen (Standard 3100). Die WebUI kann auf
`127.0.0.1` bleiben (`WEB_HOST` nicht ändern), cloudflared läuft auf
demselben Mac. Keine „HTTP Host Header"-Umschreibung einstellen: Die WebUI
erwartet den Host `app.tybo.ai`.

## 2. Access-Anwendung

Zero Trust → Access → Applications → Add an application → **Self-hosted**:

- Application domain: `app.tybo.ai`
- Session duration: nach Geschmack, z. B. 24 Stunden
- Login-Methode: **One-time PIN** (Einmal-Code per E-Mail). Falls sie fehlt:
  Zero Trust → Settings → Authentication → Login methods → One-time PIN
- Policy: Action **Allow**, Include → **Emails** → die eigene E-Mail-Adresse

## 3. Team und AUD finden

- **Team-Name**: Zero Trust → Settings → Custom Pages, Feld „Team domain",
  z. B. `meinteam.cloudflareaccess.com`. Der Team-Name ist der erste Teil,
  hier `meinteam`.
- **AUD** (Application Audience Tag): Zero Trust → Access → Applications →
  app.tybo.ai → Configure → Overview → „Application Audience (AUD) Tag",
  eine lange Zeichenkette aus Ziffern und Buchstaben a bis f.

## 4. Die vier Einstellungen in der .env

| Variable | Beispiel | Bedeutung |
|---|---|---|
| `WEB_PUBLIC_ORIGIN` | `https://app.tybo.ai` | öffentliche Adresse, genau so, ohne Pfad und Port |
| `WEB_ACCESS_TEAM` | `meinteam` | Team-Name aus Schritt 3; die ganze Adresse `meinteam.cloudflareaccess.com` geht auch |
| `WEB_ACCESS_AUD` | `4714c1…` | AUD aus Schritt 3 |
| `WEB_PORT` | `3100` | muss zum Service im Tunnel-Eintrag passen |

`WEB_ENABLED=true` und `WEB_PASSWORD` sind wie immer Voraussetzung.

`WEB_ACCESS_TEAM` und `WEB_ACCESS_AUD` gehören zusammen: Steht nur eins in
der .env oder ist eins ungültig, startet die WebUI nicht und das Log nennt den
Grund. Steht `WEB_PUBLIC_ORIGIN` ohne die beiden in der .env, lehnt die
WebUI jede getunnelte Anfrage ab (sicherer Ausfall), im Heimnetz geht alles
wie bisher.

Danach neu starten: `bun run restart:request "Zugang von unterwegs"`.

## 5. Test

1. Im Log nach dem Start: keine Zeile
   `WEB_PUBLIC_ORIGIN ist gesetzt, Cloudflare Access aber nicht`.
2. Handy ohne WLAN (mobile Daten): https://app.tybo.ai öffnen. Erst kommt die
   Cloudflare-Anmeldung mit E-Mail-Code, danach die Login-Seite der WebUI,
   nach dem Passwort der Chat.
3. Im Log steht `[web] Access ok für <IP> (Tunnel)` und `Login von <IP> (Tunnel)`.
4. Einstellungen → Schlüssel: keine Knöpfe, Hinweis „Schlüssel ändern geht
   nur im Heimnetz".
5. Ohne Access-Anmeldung, etwa `curl -sI https://app.tybo.ai/login`: Cloudflare
   leitet auf die Anmeldung um (302), die WebUI sieht die Anfrage nie.

Im Log stehen nur Ergebnis und Grund (`Access ok für …`,
`Access abgelehnt für …: abgelaufen`), nie der Nachweis selbst. Gleiche
Meldungen erscheinen höchstens einmal pro Minute.

## Schlüssel von Cloudflare

Die WebUI holt die öffentlichen Schlüssel von
`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` und behält sie eine
Stunde. Taucht ein neuer Schlüssel auf (Cloudflare wechselt sie regelmäßig),
lädt sie neu, höchstens einmal pro Minute. Ist Cloudflare nicht erreichbar,
gelten die bekannten Schlüssel noch bis zu einem Tag; ohne Schlüssel wird
abgelehnt.
