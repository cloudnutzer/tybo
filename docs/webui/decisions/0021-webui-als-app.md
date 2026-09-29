# 0021 WebUI als installierbare App statt eigener Handy-Apps

Datum: 28.09.2026. Entschieden von: Maintainer (Web-App statt nativer Apps,
Telegram optional), Umsetzungsdetails Plan-Session W2 und Issue #224.

- Es gibt keine eigenen iOS- oder Android-Apps. Die WebUI wird zur
  installierbaren Web-App (PWA): Web-App-Manifest, Home-Bildschirm-Symbol,
  Vollbild ohne Browserleiste (`display: standalone`), Benachrichtigungen per
  Web Push. Zugang von unterwegs bleibt die öffentliche Adresse aus
  `WEB_PUBLIC_ORIGIN` (etwa `https://app.tybo.ai`) mit Cloudflare Access und
  WebUI-Passwort (Entscheidung 0014); daran ändert W2 nichts.
- **Wahlfreiheit:** tybo läuft mit Web-App allein, mit Telegram allein oder
  mit beidem. Telegram ist nicht mehr Pflicht: ohne `TELEGRAM_BOT_TOKEN`
  startet der Bot ohne Polling, `tybo setup` überspringt den Schritt, und alles,
  was heute nur nach Telegram geht, landet in der WebUI (und per Push).
  Pflicht ist mindestens ein Kanal: Telegram oder WebUI.
- **Nachtrag zu 0005:** Ohne Forum-Gruppe (mit oder ohne Telegram) legt „Neues
  Gespräch" ein reines Web-Gespräch an; mit Gruppe bleibt es beim Topic. Ohne
  Telegram ist der Direktchat ein Web-Gespräch unter der festen Chat-ID `web`.
- **Service Worker nur so weit nötig:** Installierbarkeit, Push-Empfang,
  Klick auf eine Benachrichtigung, Teilen-Ziel und eine eigene Seite „tybo
  nicht erreichbar", wenn der Rechner oder der Tunnel weg ist. Keine
  Offline-Kopie von Gesprächen, Antworten, Dateien oder API-Antworten; der
  Service Worker cacht nur die Offline-Seite und was sie zum Anzeigen braucht
  (ihr Skript, `style.css`, `theme.js`, `favicon.svg`). Als „nicht erreichbar"
  gelten ein Netzfehler und die Status 502, 503, 504 und 520 bis 530
  (Cloudflare meldet einen abgeschalteten Tunnel mit 530).
- **Hinter Cloudflare Access:** Browser holen das Manifest ohne Cookies, Access
  leitet solche Anfragen auf die Anmeldung um. Deshalb
  `<link rel="manifest" crossorigin="use-credentials">`. Manifest, Symbole,
  Service Worker und Offline-Seite liefert die WebUI ohne WebUI-Login aus
  (ohne Inhalt, der etwas über den Nutzer verrät), über den Tunnel aber wie
  alles andere nur mit gültigem Access-Nachweis. Kein Access-Bypass für
  einzelne Pfade. Navigationen reicht der Service Worker unverändert durch,
  damit Weiterleitungen von Access beim Browser ankommen.
- **Web Push:** VAPID-Schlüssel stehen in der `.env` (`WEB_PUSH_PUBLIC_KEY`,
  `WEB_PUSH_PRIVATE_KEY`, `WEB_PUSH_SUBJECT`; fehlen sie, erzeugt der Bot sie
  beim Start), nie im Repo; Abos pro Gerät in
  `data/web/push-subscriptions.json`. Versand mit eigener, kleiner Umsetzung auf
  WebCrypto (VAPID nach RFC 8292, Verschlüsselung `aes128gcm` nach RFC 8291),
  ohne neue Abhängigkeit; Begründung im Issue zur Push-Grundlage. Push-Adressen nur über
  HTTPS zu bekannten Push-Diensten (Schutz gegen Anfragen an beliebige
  Adressen). Abgelaufene Abos (404, 410) werden gelöscht.
- **Wann gepusht wird, entscheidet der Server:** Jede offene Seite meldet
  regelmäßig, welches Gespräch sichtbar offen ist (Anwesenheit im Speicher,
  verfällt nach kurzer Zeit). Für ein sichtbares
  Gespräch geht kein Push raus. Der Service Worker unterdrückt nichts selbst,
  weil Browser (iOS, Chrome) für jeden Push eine sichtbare Benachrichtigung
  verlangen.
- Auslöser: fertige Antwort in einem Gespräch, das nicht sichtbar offen ist
  (nicht für Antworten auf Telegram-Nachrichten, die meldet Telegram selbst);
  neue Rückfrage aus dem Register (Entscheidung 0017); Meldungen mit Absender
  (Entscheidung 0006: Pipeline, Jobs, Briefing, Check-in, Watchdog, Watcher,
  Dateien). Benachrichtigungen zeigen standardmäßig nur Gespräch bzw. Absender,
  den Inhalt nur, wenn das Gerät es eingestellt hat (Sperrbildschirm).
  Kategorien (Antworten, Rückfragen, Meldungen) pro Gerät; Meldungen sind mit
  eingerichtetem Telegram standardmäßig aus, damit nichts doppelt kommt.
- Installation und Push gehen nur im sicheren Kontext: über HTTPS (die
  Adresse aus `WEB_PUBLIC_ORIGIN` oder ein anderer HTTPS-Zugang) und als
  Ausnahme über `http://localhost`, nicht über `http://<LAN-IP>` im Heimnetz.
  Dort bleibt die WebUI eine normale Webseite.
- **iOS:** Push nur als installierte Web-App ab iOS 16.4, Berechtigung nur nach
  einem Tipp auf einen Knopf; die Oberfläche erklärt das, statt einen toten
  Schalter zu zeigen. Teilen-Ziel gibt es nur auf Android (Safari kennt
  `share_target` nicht).
- Das Teilen-Ziel übernimmt der Service Worker: geteilter Text, Links und
  Bilder werden kurz im Gerät zwischengelegt und als Entwurf bzw. Anhang in
  das gewählte Gespräch übergeben; abgeschickt wird erst nach einem Tipp.
