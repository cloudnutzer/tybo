# tybo als App auf dem Handy

tybo gibt es nicht im App Store und nicht bei Google Play. Die WebUI lässt
sich aber wie eine App auf den Home-Bildschirm legen: eigenes Symbol, Vollbild
ohne Browserleiste, Benachrichtigungen, auf Android auch im Teilen-Menü. Diese
Anleitung zeigt Schritt für Schritt, wie das auf dem iPhone und auf Android
geht, und was die App kann und was nicht.

## Voraussetzung: eine HTTPS-Adresse

Installieren und Benachrichtigungen gehen nur über eine sichere Verbindung
(HTTPS). Im Heimnetz über `http://192.168…:3100` bleibt die WebUI eine normale
Webseite: Chatten geht, Installieren und Benachrichtigungen nicht.

Du brauchst also einen Zugang von unterwegs mit einer `https://…`-Adresse. Sie
steht in der `.env` unter `WEB_PUBLIC_ORIGIN`. Einrichten mit
`tybo setup zugang`, einer von drei Wegen; alles dazu in
[webui/fernzugang.md](webui/fernzugang.md):

- **Tailscale (empfohlen):** privates Netz nur für deine Geräte, Adresse wie
  `https://<gerät>.<tailnet>.ts.net`. Auf dem Handy muss dafür die
  Tailscale-App laufen und angemeldet sein.
- **Cloudflare Tunnel mit eigener Domain:** Adresse wie
  `https://tybo.example.org`, davor Cloudflare Access mit Einmal-Code per
  E-Mail.
- **Nur auf diesem Rechner:** dann gibt es keine App auf dem Handy.

Vor der App liegt immer das **WebUI-Passwort** wie am Rechner. Beim Weg
Cloudflare kommt davor noch **Cloudflare Access:** Beim Öffnen fragt
Cloudflare nach deiner E-Mail und schickt einen Einmal-Code. Die Anmeldung
hält so lange, wie in der Access-Anwendung unter „Session duration"
eingestellt; für die App eher 30 Tage als 24 Stunden. Danach fragt
Cloudflare wieder nach einem Code.

Außerdem muss der Rechner laufen, auf dem tybo läuft. Schläft er oder ist er
aus, zeigt die App „tybo nicht erreichbar" mit dem Knopf „Erneut versuchen".

## iPhone und iPad

Du brauchst iOS 16.4 oder neuer für Benachrichtigungen. Installieren geht nur
mit Safari.

1. Safari öffnen und deine tybo-Adresse aufrufen (`https://…`).
2. Beim Weg Cloudflare mit dem Einmal-Code anmelden, dann mit dem WebUI-Passwort.
3. Unten auf den Teilen-Knopf tippen (Quadrat mit Pfeil nach oben).
4. Nach unten scrollen und „Zum Home-Bildschirm" wählen, dann „Hinzufügen".
5. Auf dem Home-Bildschirm das tybo-Symbol antippen. Die App öffnet sich ohne
   Safari-Leiste.
6. In der App noch einmal anmelden (Einmal-Code und Passwort). Die App hat
   eigene Cookies, die Anmeldung aus Safari gilt dort nicht.
7. Benachrichtigungen einschalten: Menü oben links, „Einstellungen", Reiter
   „Benachrichtigungen", „An" antippen und die Frage von iOS mit „Erlauben"
   beantworten.

Benachrichtigungen gibt es auf dem iPhone nur in der installierten App, nicht
in Safari selbst. Kommt keine Frage von iOS oder hast du „Nicht erlauben"
gewählt: Einstellungen von iOS, „Mitteilungen", tybo wählen, „Mitteilungen
erlauben" einschalten.

## Android

Am besten mit Chrome. Edge und Samsung Internet gehen auch, die Menüs heißen
dort etwas anders.

1. Chrome öffnen und deine tybo-Adresse aufrufen (`https://…`).
2. Beim Weg Cloudflare mit dem Einmal-Code anmelden, dann mit dem WebUI-Passwort.
3. Menü oben rechts (drei Punkte), „App installieren". Heißt der Eintrag
   „Zum Startbildschirm hinzufügen", dort „Installieren" wählen.
4. Das tybo-Symbol auf dem Startbildschirm antippen. Die Anmeldung aus Chrome
   gilt meist weiter; sonst noch einmal anmelden.
5. Benachrichtigungen einschalten: Menü oben links, „Einstellungen", Reiter
   „Benachrichtigungen", „An" antippen, „Zulassen".

Wurden Benachrichtigungen einmal blockiert: lange auf das tybo-Symbol
drücken, „App-Info", „Benachrichtigungen", einschalten.

### Aus anderen Apps an tybo teilen (nur Android)

Nach der Installation steht tybo im Teilen-Menü von Android, etwa in Fotos,
Chrome oder einer Dateien-App. Eventuell erst unter „Mehr" oder nach dem
Scrollen.

1. In der anderen App „Teilen" wählen und dann tybo.
2. tybo öffnet das Gespräch, das zuletzt offen war. Text und Links stehen als
   Entwurf in der Eingabe (ein angefangener Entwurf bleibt davor stehen),
   Bilder, PDFs und Sprachdateien hängen als Anhänge darüber.
3. Über den Anhängen steht „Geteilt: …". Soll es in ein anderes Gespräch:
   „Anderes Gespräch" antippen und das Gespräch in der Liste wählen. Mit
   wandert nur, was geteilt wurde.
4. Nichts wird von selbst gesendet. Erst ein Tipp auf Senden schickt es ab.

Lief beim Teilen in einem Gespräch noch ein Senden oder Hochladen und öffnet
Android für das Geteilte ein neues tybo-Fenster, bleibt dieses Gespräch im
alten Fenster. Das neue zeigt dann das Geteilte und den Hinweis „Entwurf wird
noch in einem anderen Fenster gesendet".

Grenzen wie bei der Büroklammer: höchstens 5 Dateien, Bilder (PNG, JPEG, WebP,
GIF) und PDFs bis 20 MB, Sprachdateien bis 25 MB. Videos und andere Dateien
nimmt tybo nicht an; ein Hinweis nennt, was nicht übernommen wurde. Geteiltes
wartet höchstens 10 Minuten auf dem Handy, bis die App es übernimmt.

## Bedienung am Handy

- **Foto aufnehmen:** Büroklammer antippen, „Foto aufnehmen". Die Kamera
  öffnet sich, das Foto hängt danach als Anhang in der Eingabe. „Datei wählen"
  nimmt Bilder und Dateien vom Gerät.
- **Gesprächsliste:** Menü oben links oder vom linken Bildschirmrand nach
  rechts wischen. Nach links wischen schließt die Liste wieder.
- **Zurück:** Die Zurück-Geste oder -Taste schließt zuerst die offene Liste.
  Aus einem Gespräch führt Zurück in die Gesprächsliste, erst danach verlässt
  es die App.
- **Tastatur:** Eingabe und letzte Nachricht bleiben über der Tastatur. Warst
  du im Verlauf ganz unten, bleibt er unten.

## Benachrichtigungen

Benachrichtigungen gelten pro Gerät. Jedes Handy und jeder Browser wird
einzeln eingeschaltet und steht in den Einstellungen unter
„Benachrichtigungen" mit Namen; dort lassen sich andere Geräte auch entfernen.

Pro Gerät gibt es vier Schalter:

- **Antworten:** eine Antwort ist fertig.
- **Rückfragen:** tybo braucht eine Entscheidung (Freigabe, Merken, „Weiter?").
- **Meldungen:** Nachrichten anderer Dienste (Pipeline, Jobs, Briefing,
  Check-in, Dateien). Mit eingerichtetem Telegram standardmäßig aus, damit
  nichts doppelt kommt.
- **Inhalt zeigen:** Ohne diesen Schalter nennt die Benachrichtigung nur
  Gespräch oder Absender, nicht den Text. Das schützt, was auf dem
  Sperrbildschirm steht.

Für das Gespräch, das gerade offen auf dem Bildschirm ist, kommt keine
Benachrichtigung. Ein Tipp auf eine Benachrichtigung öffnet genau das
Gespräch.

## Nur Web-App, nur Telegram oder beides

tybo läuft mit jeder der drei Möglichkeiten:

- **Nur Web-App:** ohne Telegram-Bot. Alles, was sonst nach Telegram ginge,
  landet in der WebUI und als Benachrichtigung auf dem Handy. Siehe
  [webui/README.md](webui/README.md), Abschnitt „Ohne Telegram".
- **Nur Telegram:** wie bisher, die WebUI bleibt aus oder nur am Rechner.
- **Beides:** Gespräche erscheinen in beiden. Antworten auf Nachrichten, die
  du in Telegram geschrieben hast, meldet Telegram selbst; die App meldet sie
  nicht noch einmal.

Was du beim Einrichten wählst, steht in [einrichtung.md](einrichtung.md),
Abschnitt „Telegram, WebUI oder beides".

## Grenzen

- **Kein Teilen-Ziel auf dem iPhone:** Safari erlaubt Web-Apps nicht, im
  Teilen-Menü zu erscheinen. Auf dem iPhone Text kopieren und in tybo
  einfügen, Bilder über die Büroklammer anhängen.
- **Keine Offline-Nutzung:** Die App speichert keine Gespräche auf dem Handy.
  Ohne Netz oder bei ausgeschaltetem Rechner zeigt sie nur „tybo nicht
  erreichbar".
- **Nicht im Heimnetz über http://:** Über `http://<IP>:3100` lässt sich nichts
  installieren und es kommen keine Benachrichtigungen. Dafür braucht es die
  HTTPS-Adresse.
- **Anmeldung läuft ab:** Beim Weg Cloudflare gilt die Access-Anmeldung nur für die
  eingestellte Dauer, danach fragt Cloudflare wieder nach dem Einmal-Code. Die
  Anmeldung mit dem WebUI-Passwort hält 30 Tage.
- **Benachrichtigungen brauchen den Rechner:** Der Rechner mit tybo verschickt
  sie. Schläft er oder ist er aus, kommt nichts, auch nicht später.
