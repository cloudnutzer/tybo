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
   Bilder, PDFs, Sprachdateien und Videos hängen als Anhänge darüber.
3. Über den Anhängen steht „Geteilt: …". Soll es in ein anderes Gespräch:
   „Anderes Gespräch" antippen und das Gespräch in der Liste wählen. Mit
   wandert nur, was geteilt wurde.
4. Nichts wird von selbst gesendet. Erst ein Tipp auf Senden schickt es ab.

Lief beim Teilen in einem Gespräch noch ein Senden oder Hochladen und öffnet
Android für das Geteilte ein neues tybo-Fenster, bleibt dieses Gespräch im
alten Fenster. Das neue zeigt dann das Geteilte und den Hinweis „Entwurf wird
noch in einem anderen Fenster gesendet".

Grenzen wie bei der Büroklammer: höchstens 5 Dateien, Bilder (PNG, JPEG, WebP,
GIF) und PDFs bis 20 MB, Sprachdateien bis 25 MB, Videos (MP4, MOV, WebM, MKV)
bis 95 MB. Andere Dateien nimmt tybo nicht an; ein Hinweis nennt, was nicht
übernommen wurde. Geteiltes wartet höchstens 10 Minuten auf dem Handy, bis die
App es übernimmt.

## Bedienung am Handy

- **Foto aufnehmen:** Büroklammer antippen, „Foto aufnehmen". Die Kamera
  öffnet sich, das Foto hängt danach als Anhang in der Eingabe. „Datei wählen"
  nimmt Bilder, Videos und Dateien vom Gerät (auf Android auch aus der
  Galerie). Videos bis 95 MB, längere besser kürzer aufnehmen oder als Link
  schicken.
- **Gesprächsliste:** Menü oben links oder vom linken Bildschirmrand nach
  rechts wischen. Nach links wischen schließt die Liste wieder.
- **Zurück:** Die Zurück-Geste oder -Taste schließt zuerst die offene Liste.
  Aus einem Gespräch führt Zurück in die Gesprächsliste, erst danach verlässt
  es die App.
- **Tastatur:** Eingabe und letzte Nachricht bleiben über der Tastatur. Warst
  du im Verlauf ganz unten, bleibt er unten.
- **Sprechen:** „Mit tybo sprechen“ im Gespräch startet den Sprechmodus:
  zuhören, nach einer kurzen Pause senden, Antwort vorlesen, Antippen
  unterbricht. Was es braucht, wie lange es dauert und welche Stimmen es gibt
  (Browser, lokal mit Pocket TTS, ElevenLabs): [sprechen.md](sprechen.md).
- **Telefonhörer:** „Mit tybo telefonieren“ (Hörer-Symbol neben „Sprechen“)
  öffnet ein flüssiges Gespräch: reden, nach rund zwei bis drei Sekunden
  kommt die Antwort, „Stumm“ schaltet das Mikrofon aus, „Auflegen“ beendet.
  Ins Wort fallen per Stimme klappt zuverlässig nur mit Kopfhörer; über
  Lautsprecher die Ansicht antippen. Den Knopf gibt es nur, wenn der
  Telefonhörer auf dem Rechner bereit ist.

### Mikrofon

- Das Mikrofon geht nur über HTTPS (siehe oben) und erst nach einem Tipp auf
  einen der Knöpfe; vorher fragt die App nicht.
- **iPhone (installierte App):** Die Frage nach dem Mikrofon kann bei jedem
  Gespräch neu kommen. Das ist eine Eigenheit von iOS, einfach erlauben.
  Während eines Gesprächs bleibt das Mikrofon offen, damit iOS nicht
  mittendrin erneut fragt.
- **Hintergrund:** Wechselst du während eines Gesprächs am Telefonhörer in
  eine andere App und das iPhone hält den Ton an, legt tybo auf und zeigt
  „Gespräch beendet, weil die App im Hintergrund war". Zuhören im
  Hintergrund oder bei gesperrtem Bildschirm gibt es nicht. Solange das
  Gespräch läuft, bleibt der Bildschirm an, wo das Gerät es erlaubt.
- **Android (Chrome, installierte App):** normale Erlaubnis, einmal pro App.

### Mit tybo sprechen

- **Knopf:** Im Gespräch neben der Eingabe stehen „Mit tybo sprechen“
  (Sprechmodus) und „Mit tybo telefonieren“ (Hörer-Symbol, Telefonhörer). Den
  Telefonhörer gibt es nur, wenn er auf dem Rechner bereit ist; der Grund
  steht sonst unter Einstellungen, Sprechen, Telefonhörer.
- **Mikrofon-Nachfrage auf dem iPhone:** In der installierten App fragt iOS
  oft bei jedem Gespräch neu. Erlauben; die Frage kommt erst nach dem Tipp
  auf den Knopf.
- **Kopfhörer:** Mit Kopfhörer kannst du tybo per Stimme ins Wort fallen.
  Über den Lautsprecher die Ansicht antippen; sonst hört tybo sich womöglich
  selbst.
- **Bildschirm bleibt an:** Solange das Gespräch läuft, hält die App den
  Bildschirm an, wo das Gerät es erlaubt. Sperren oder in eine andere App
  wechseln beendet das Gespräch.
- **Auflegen:** „Auflegen“ beendet das Gespräch. Danach steht es im Verlauf,
  mit einer Meldung „Telefongespräch, 4 Min.“, und der nächste getippte Satz
  weiß, worüber ihr gesprochen habt. Mehr: [sprechen.md](sprechen.md),
  Abschnitt „Telefonhörer“.

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
