# Zugang von unterwegs

Entscheidungen 0014 und 0022. Die WebUI läuft auf dem Rechner, auf dem tybo
läuft. Im Heimnetz erreicht man sie über `http://<IP des Rechners>:3100`. Für
das Handy unterwegs und für die App auf dem Handy (Installieren,
Benachrichtigungen, Teilen, siehe [../handy-app.md](../handy-app.md)) braucht
sie zusätzlich eine **HTTPS-Adresse**: Browser erlauben Installation und
Benachrichtigungen nur in einem sicheren Kontext, nicht über
`http://<LAN-IP>`.

Eingerichtet wird der Zugang mit dem Assistenten:

```bash
tybo setup zugang
```

(im Browser: `tybo setup --web`, Schritt „Zugang vom Handy“). Er fragt nach
einem von drei Wegen und installiert nichts. Die Felder und Texte des Schritts
beschreibt [../einrichtung.md](../einrichtung.md), Abschnitt „9. Zugang vom
Handy“.

| Weg | Adresse | Vor der WebUI | Für wen |
|---|---|---|---|
| **Tailscale** (empfohlen) | `https://<gerät>.<tailnet>.ts.net` | nur Geräte im eigenen Tailnet | alle; kostenlos, keine eigene Domain nötig |
| **Cloudflare Tunnel** | eigene Domain, z. B. `https://tybo.example.org` | Cloudflare Access mit Einmal-Code | wer schon eine Domain bei Cloudflare hat |
| **Nur auf diesem Rechner** | keine | nichts | wer die App auf dem Handy nicht braucht |

Auf allen Wegen bleibt das **WebUI-Passwort** Pflicht, und es gibt von
unterwegs **keine lokalen Sonderrechte**: kein Terminal-Schlüssel
(`data/cli-token`), keine Demo-Anmeldung, kein Einrichtungsmodus. Schlüssel
(Seite „Schlüssel“) sind von unterwegs nur lesbar, ändern geht nur am Rechner
bzw. im Heimnetz.

## Weg 1: Tailscale

Tailscale verbindet eigene Geräte zu einem privaten Netz (Tailnet). Das Handy
erreicht den Rechner dann unter einer festen HTTPS-Adresse mit gültigem
Zertifikat, niemand außerhalb des Tailnets kommt an die WebUI.

### Vorher selbst erledigen

1. Tailscale auf dem Rechner installieren und anmelden: macOS aus dem Mac App
   Store oder von [tailscale.com/download](https://tailscale.com/download),
   Linux mit `curl -fsSL https://tailscale.com/install.sh | sh`, dann
   `sudo tailscale up`.
2. Die Tailscale-App auf dem Handy installieren (App Store, Google Play) und
   mit demselben Konto anmelden.
3. In der Admin-Konsole unter [DNS](https://login.tailscale.com/admin/dns)
   **MagicDNS** und **HTTPS Certificates** einschalten.
4. Nur Linux: Serve braucht Administratorrechte. Einmalig
   `sudo tailscale set --operator=$USER`, dann geht es ohne `sudo`.

### Was der Assistent tut

- prüft mit `tailscale status --json`, ob Tailscale installiert, angemeldet
  und MagicDNS samt HTTPS-Zertifikaten eingeschaltet ist; fehlt etwas, kommt
  eine Anleitung wie oben statt eines Fehlers, und nichts wird geändert
- sieht mit `tailscale serve status --json` nach, ob Port 443 in Tailscale
  frei ist; ist er für etwas anderes belegt oder Tailscale Funnel an (dann
  wäre die WebUI öffentlich im Internet), bricht er ab und ändert nichts
- richtet die Weiterleitung ein:
  `tailscale serve --bg --https=443 http://127.0.0.1:<WEB_PORT>`
  ([Tailscale-Doku zu serve](https://tailscale.com/docs/reference/tailscale-cli/serve));
  die Weiterleitung bleibt über Neustarts bestehen
- schreibt die Adresse `https://<gerät>.<tailnet>.ts.net` (aus `Self.DNSName`
  in `tailscale status --json`) als `WEB_PUBLIC_ORIGIN` in die `.env`
- testet über HTTPS (siehe „Test“ unten)

Abschalten: `tailscale serve --https=443 off` und `WEB_PUBLIC_ORIGIN` aus der
`.env` nehmen.

### Woran die WebUI Anfragen über Tailscale erkennt

`tailscale serve` verbindet sich wie cloudflared von 127.0.0.1. Solche
Anfragen dürfen nicht als lokal gelten. Die WebUI erkennt sie an den
Kopfzeilen, die Tailscale setzt (`X-Forwarded-For`, `X-Forwarded-Host`,
`X-Forwarded-Proto`, bei Geräten mit Nutzer auch `Tailscale-User-Login` und
Verwandte) und, weil die Identitäts-Kopfzeilen bei getaggten Geräten fehlen,
zusätzlich am Host: Ein Host gleich dem aus `WEB_PUBLIC_ORIGIN` kommt immer
von unterwegs. Es gibt keine pauschale Freigabe für `*.ts.net`: nur genau die
eingerichtete Adresse.

Über Tailscale gilt:

- Host genau der aus `WEB_PUBLIC_ORIGIN`, bei schreibenden Anfragen Origin
  genau `WEB_PUBLIC_ORIGIN`, sonst 421 bzw. 403
- Anmeldung mit dem WebUI-Passwort, Cookie mit `Secure`
- Login-Bremse pro Tailnet-Adresse des Besuchers, getrennt vom lokalen Zugang
- im Log `Login von <IP> (Tailscale)`

Eine Weiterleitung gilt auch ohne `WEB_PUBLIC_ORIGIN` nie als lokal; ihr Host
passt dann nicht und sie wird mit 421 abgelehnt.

## Weg 2: Cloudflare Tunnel mit eigener Domain

Für wen schon eine Domain bei Cloudflare hat und einen Tunnel betreibt (oder
einrichten will). Die WebUI ist dann unter einer eigenen Adresse im Internet
erreichbar, davor liegen zwei Schlösser:

1. **Cloudflare Access**: Wer die Adresse öffnet, meldet sich zuerst bei
   Cloudflare mit einem Einmal-Code per E-Mail an. Erst dann reicht Cloudflare
   die Anfrage an den Tunnel weiter, mit einem signierten Nachweis in der
   Kopfzeile `Cf-Access-Jwt-Assertion`.
2. **WebUI-Passwort**: dahinter wie im Heimnetz.

Die WebUI prüft den Access-Nachweis selbst. Fehlt er oder stimmt etwas nicht
(Signatur, Anwendung, Aussteller, Ablauf), antwortet sie mit 403. Eine falsch
eingestellte Access-Regel öffnet also nicht alles.

In den Beispielen steht `tybo.example.org` für die eigene Domain.

### 1. Tunnel-Eintrag

In der Konfiguration des Tunnels (Zero Trust → Networks → Tunnels → Tunnel
des Rechners → Public Hostname, oder `ingress` in der `config.yml` von
cloudflared) einen Eintrag ergänzen:

| Feld | Wert |
|---|---|
| Hostname | `tybo.example.org` |
| Service | `http://localhost:3100` |

Der Port muss zu `WEB_PORT` passen (Standard 3100). Die WebUI kann auf
`127.0.0.1` bleiben (`WEB_HOST` nicht ändern), cloudflared läuft auf
demselben Rechner. Keine „HTTP Host Header“-Umschreibung einstellen: Die
WebUI erwartet den Host der eigenen Domain.

### 2. Access-Anwendung

Zero Trust → Access → Applications → Add an application → **Self-hosted**:

- Application domain: `tybo.example.org`
- Session duration: für die App auf dem Handy eher **30 Tage** als
  24 Stunden, sonst fragt Cloudflare jeden Tag nach einem neuen Code
- Login-Methode: **One-time PIN** (Einmal-Code per E-Mail). Falls sie fehlt:
  Zero Trust → Settings → Authentication → Login methods → One-time PIN
- Policy: Action **Allow**, Include → **Emails** → die eigene E-Mail-Adresse

### 3. Team und AUD finden

- **Team-Name**: Zero Trust → Settings → Custom Pages, Feld „Team domain“,
  z. B. `meinteam.cloudflareaccess.com`. Der Team-Name ist der erste Teil,
  hier `meinteam`.
- **AUD** (Application Audience Tag): Zero Trust → Access → Applications →
  die Anwendung → Configure → Overview → „Application Audience (AUD) Tag“,
  eine lange Zeichenkette aus Ziffern und Buchstaben a bis f.

### 4. Die vier Einstellungen in der .env

`tybo setup zugang`, Weg Cloudflare, fragt Domain, Team und AUD ab, prüft sie
und schreibt:

| Variable | Beispiel | Bedeutung |
|---|---|---|
| `WEB_PUBLIC_ORIGIN` | `https://tybo.example.org` | öffentliche Adresse, genau so, ohne Pfad und Port |
| `WEB_ACCESS_TEAM` | `meinteam` | Team-Name aus Schritt 3; die ganze Adresse `meinteam.cloudflareaccess.com` geht auch |
| `WEB_ACCESS_AUD` | `4714c1…` | AUD aus Schritt 3 |
| `WEB_PORT` | `3100` | muss zum Service im Tunnel-Eintrag passen |

`WEB_ENABLED=true` und `WEB_PASSWORD` sind wie immer Voraussetzung.

`WEB_ACCESS_TEAM` und `WEB_ACCESS_AUD` gehören zusammen: Steht nur eins in
der .env oder ist eins ungültig, startet die WebUI nicht und das Log nennt den
Grund. Steht `WEB_PUBLIC_ORIGIN` mit einer eigenen Domain ohne die beiden in
der .env, lehnt die WebUI jede getunnelte Anfrage ab (sicherer Ausfall), im
Heimnetz geht alles wie bisher. Eine `ts.net`-Adresse mit Access-Werten gilt
ebenfalls als Cloudflare: Anfragen ohne Access-Nachweis werden abgelehnt.

### Woran die WebUI getunnelte Anfragen erkennt

cloudflared verbindet sich von 127.0.0.1 und setzt die Kopfzeile
`CF-Connecting-IP` mit der Adresse des Besuchers. Ist `WEB_PUBLIC_ORIGIN`
gesetzt, gilt jede solche Anfrage als getunnelt. Dann gilt:

- Host genau der aus `WEB_PUBLIC_ORIGIN`, bei schreibenden Anfragen Origin
  genau `WEB_PUBLIC_ORIGIN`, sonst 421 bzw. 403
- gültiger Access-Nachweis, sonst 403 „Zugang von unterwegs nur mit gültiger
  Cloudflare-Access-Anmeldung“, und zwar vor Anmeldung, Seiten, Dateien,
  Uploads und Live-Verbindungen; zusätzliche Tailscale-Kopfzeilen ändern
  daran nichts
- Login-Bremse pro Besucher-IP, Cookie mit `Secure`

### Schlüssel von Cloudflare

Die WebUI holt die öffentlichen Schlüssel von
`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` und behält sie eine
Stunde. Taucht ein neuer Schlüssel auf (Cloudflare wechselt sie regelmäßig),
lädt sie neu, höchstens einmal pro Minute. Ist Cloudflare nicht erreichbar,
gelten die bekannten Schlüssel noch bis zu einem Tag; ohne Schlüssel wird
abgelehnt.

Im Log stehen nur Ergebnis und Grund (`Access ok für …`,
`Access abgelehnt für …: abgelaufen`), nie der Nachweis selbst. Gleiche
Meldungen erscheinen höchstens einmal pro Minute.

## Weg 3: Nur auf diesem Rechner

Richtet nichts ein und ändert die `.env` nicht. Die WebUI bleibt auf diesem
Rechner und im Heimnetz erreichbar; die App auf dem Handy und
Benachrichtigungen gehen dann nicht. Ein schon eingerichteter Zugang bleibt,
wie er ist.

## Einrichtungsmodus

Der Einrichtungsmodus (`tybo setup --web`) gilt nur auf diesem Rechner. Er
lehnt jede Anfrage mit Kopfzeilen einer Weiterleitung (Cloudflare, Tailscale,
`X-Forwarded-*`) ab, auch ohne `WEB_PUBLIC_ORIGIN`.

## Wiederholen und Wechseln

`tybo setup zugang` lässt sich jederzeit erneut aufrufen. Der eingerichtete
Weg ist vorausgewählt. Ein anderer Weg ersetzt die Werte in der `.env` nur
nach der Rückfrage „Vorhandenen Zugang ersetzen“; Nein ändert nichts. Den
Tunnel und die Tailscale-Weiterleitung selbst fasst der Assistent dabei nicht
an, der Hinweis am Ende nennt den Befehl zum Abschalten.

## Neustart und Test

Die neuen Werte gelten erst nach einem Neustart von tybo: in der WebUI unter
Einstellungen → Status „Neustart anfordern“, oder aus einem Gespräch mit tybo
`bun run restart:request "Zugang von unterwegs"`.

Solange tybo noch nicht mit den neuen Werten läuft (bei der ersten
Einrichtung oder im Browser-Assistenten, der den Port der WebUI selbst
belegt), meldet der Test „ausstehend“ statt eines Fehlers. Nachholen mit
`tybo setup zugang`, in der Gesamtprüfung (`tybo setup pruefung`) oder von
Hand, mit mobilen Daten oder von einem Gerät im Tailnet:

```bash
# Tailscale
curl -s https://<gerät>.<tailnet>.ts.net/manifest.webmanifest
# erwartet: eine Antwort mit "name":"tybo" und "display":"standalone"

# Cloudflare, ohne Access-Anmeldung
curl -sI https://tybo.example.org/manifest.webmanifest
# erwartet: Status 302, location auf <team>.cloudflareaccess.com;
# die WebUI sieht die Anfrage nie
```

Irgendeine Antwort reicht nicht: Beim Tailscale-Weg muss es das Manifest von
tybo sein, beim Cloudflare-Weg die Weiterleitung zur Anmeldung des eigenen
Teams.

Danach am Handy:

1. Die Adresse öffnen. Bei Cloudflare kommt erst die Anmeldung mit
   E-Mail-Code, bei Tailscale direkt die Login-Seite der WebUI.
2. Nach dem Passwort der Chat.
3. Einstellungen → Schlüssel: keine Knöpfe, Hinweis „Schlüssel ändern geht
   nur im Heimnetz“.
4. Im Log beim Start keine Zeile
   `WEB_PUBLIC_ORIGIN ist gesetzt, Cloudflare Access aber nicht`; bei
   Tailscale steht dort
   `Zugang von unterwegs über Tailscale (WEB_PUBLIC_ORIGIN), Anmeldung mit dem WebUI-Passwort`.
