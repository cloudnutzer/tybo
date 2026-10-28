# 0022 Zugang vom Handy für alle: Tailscale, eigene Domain oder nur lokal

Datum: 28.09.2026. Entschieden von: Maintainer (Issue #231), Umsetzungsdetails
aus der Prüfung vor dem Bau und dem Bau von Issue #231.

## Zusammenhang

- `SPEC.md` schließt unter „Nicht im Umfang“ Zugriff aus dem Internet und
  HTTPS aus. Entscheidung 0014 hat davon den Zugang über Cloudflare Tunnel und
  Access ausgenommen, Entscheidung 0021 hält daran fest und verlangt für
  Installation und Push eine HTTPS-Adresse.
- Diese Entscheidung erweitert die Ausnahme aus 0014 um Tailscale und macht
  sie für alle Nutzer einrichtbar. `SPEC.md` bleibt unverändert; die Ausnahme
  steht hier und in 0014.

## Entscheidung

- `tybo setup` bekommt den optionalen Schritt „Zugang vom Handy“
  (`tybo setup zugang`, Terminal und Browser), nach der WebUI und nur mit
  eingeschalteter WebUI. Drei Wege:
  1. **Tailscale (empfohlen, Standard):** `tailscale serve --bg --https=443
     http://127.0.0.1:<WEB_PORT>` im eigenen Tailnet, Adresse
     `https://<gerät>.<tailnet>.ts.net` aus `tailscale status --json` als
     `WEB_PUBLIC_ORIGIN`. Kein Tailscale Funnel (die WebUI wäre dann
     öffentlich).
  2. **Cloudflare Tunnel mit eigener Domain und Access:** wie 0014, mit
     beliebiger Domain statt einer festen Adresse; schreibt
     `WEB_PUBLIC_ORIGIN`, `WEB_ACCESS_TEAM`, `WEB_ACCESS_AUD`, `WEB_PORT`.
  3. **Nur auf diesem Rechner:** richtet nichts ein, ändert nichts.
- Der Assistent installiert weder Tailscale noch cloudflared und legt keinen
  Tunnel und keine Access-Anwendung an. Fehlt etwas, erklärt er es. Belegte
  Serve-Einstellungen und vorhandene Werte überschreibt er nicht still; ein
  Wegwechsel verlangt eine Bestätigung.
- Der Weg ergibt sich aus der `.env`: eine `ts.net`-Adresse ohne Access-Werte
  ist Tailscale, alles andere Cloudflare (mit Access-Pflicht, sicherer
  Ausfall).

## Sicherheit

- Anfragen über `tailscale serve` kommen wie über cloudflared von Loopback.
  Sie gelten nie als lokal: kein Terminal-Schlüssel, keine Demo-Anmeldung,
  kein Einrichtungsmodus, Schlüssel nur lesbar. Das WebUI-Passwort bleibt
  Pflicht; es gibt kein Tailscale-Gegenstück zum Access-Nachweis.
- Erkannt werden sie an den Weiterleitungs-Kopfzeilen (`X-Forwarded-*`,
  `Tailscale-User-*`) und, weil Identitäts-Kopfzeilen bei getaggten Geräten
  fehlen, an genau dem Host aus `WEB_PUBLIC_ORIGIN`. Keine pauschale Freigabe
  für `*.ts.net`.
- Seit dieser Entscheidung gilt eine Loopback-Anfrage mit
  Weiterleitungs-Kopfzeilen auch ohne `WEB_PUBLIC_ORIGIN` nicht mehr als
  lokal (vorher nur mit gesetzter Adresse, 0014).
- Mit eingerichtetem Cloudflare ersetzen zusätzliche Tailscale-Kopfzeilen den
  Access-Nachweis nicht; mit eingerichtetem Tailscale werden Anfragen mit
  Cloudflare-Kopfzeilen wie ein Tunnel ohne Access abgelehnt.

Doku: `docs/webui/fernzugang.md`.
