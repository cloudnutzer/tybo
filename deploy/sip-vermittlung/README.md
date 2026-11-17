# SIP-Vermittlung: easybell und ElevenLabs

Eine kleine Telefonzentrale (Asterisk mit PJSIP) auf einem eigenen Server. Sie
verbindet einen easybell-Anschluss mit einem SIP-Trunk bei ElevenLabs:

- **Eingehend:** Wer die easybell-Nummer anruft, landet beim Sprachagenten, der
  bei ElevenLabs auf dieser Nummer liegt. Die Nummer des Anrufers geht mit
  (From, P-Asserted-Identity und `X-Caller-ID`), damit der Agent sie in
  `system__caller_id` sieht.
- **Ausgehend:** `/anruf` lässt ElevenLabs über die Vermittlung wählen. Die
  Vermittlung wählt über easybell nur Nummern aus einer Positivliste, ohne
  eigenen Wert nur `USER_PHONE_NUMBER`.

Warum es sie gibt: Ein privater easybell-Anschluss liefert Anrufe nur an ein
Gerät, das sich bei easybell anmeldet (registriert). ElevenLabs registriert sich
nicht, ein direkter Import der Nummer als SIP-Trunk bekommt deshalb keine Anrufe.
Die Vermittlung registriert sich an seiner Stelle. Entscheidung:
[0026, Nachtrag E1](../../docs/webui/decisions/0026-sprachagenten-rezepte.md).
Überblick für Nutzer: [docs/sprechen.md](../../docs/sprechen.md), Abschnitt
„Anrufannahme über eigene Vermittlung“.

## Was im Ordner liegt

| Datei | Wozu |
|---|---|
| `compose.yaml` | Dienst `vorlagen` (erzeugt die Konfiguration, ohne Netz), Dienst `asterisk` (Image aus `image/`, Host-Netz) |
| `image/` | Dockerfile auf dem Standard-Image mit festem Tag, dazu der pjproject-Patch für TLS-Folgeverbindungen (siehe „Folgeverbindungen“) |
| `beispiel.env` | alle Einstellungen mit erfundenen Werten; Vorlage für die `.env` auf dem Server |
| `render.ts` | Generator: prüft die `.env` und füllt `vorlagen/` nach `erzeugt/` |
| `vorlagen/asterisk/*.vorlage` | `pjsip.conf`, `extensions.conf`, `rtp.conf` und die Grunddateien mit Platzhaltern `{{NAME}}` |
| `vorlagen/firewall.nft.vorlage` | eigene nftables-Tabelle `sip_vermittlung` |
| `firewall.sh` | lädt die Firewall, füllt das Set `easybell` aus dem DNS und legt die Marke `/run/sip-vermittlung/geladen` an |
| `systemd/sip-vermittlung-firewall.service` | lädt die Firewall bei jedem Systemstart, bevor Docker startet |
| `container/start.sh` | Start von Asterisk: nur mit Marke der Firewall, Meldungen durch den Logfilter |
| `container/logfilter.pl` | kürzt Rufnummern in allen Meldungen, bevor sie gespeichert werden |
| `fail2ban/sip-vermittlung.local` | Sperre nach fehlgeschlagenen Anmeldungen |
| `zustand.sh` | Zustand für tybo: registriert ja/nein, letzte Registrierung |
| `zertifikat-erneuern.sh` | übernimmt das TLS-Zertifikat, bei der Einrichtung und danach täglich |
| `pruefen.ts`, `pruefung/` | Prüfung vor dem Einsatz: statisch, Laufzeit mit SIP-Gegenstellen, Neustart |

Ersetzt werden nur Platzhalter der Form `{{NAME}}`. Asterisk-Ausdrücke wie
`${EXTEN}` bleiben stehen. Ein unbekannter oder offener Platzhalter und jeder
ungültige Wert brechen den Lauf ab; dann startet Asterisk nicht. Fehlermeldungen
nennen nur den Namen der Einstellung, nie ihren Wert.

## Primärquellen (abgerufen am 6.11.2026)

**ElevenLabs, SIP-Trunk** ([SIP trunking](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking)):

- Anrufe an ElevenLabs gehen an `sip:<nummer>@sip.rtc.elevenlabs.io`, TCP auf
  5060, TLS auf `5061;transport=tls`. UDP heißt dort „experimental“, nur zum
  Testen. Die Nummer muss genau so geschrieben sein wie beim Import (mit `+`).
- TLS 1.2 oder neuer; ElevenLabs zeigt ein gültiges Zertifikat für
  `sip.rtc.elevenlabs.io`.
- Codecs: G.711 (PCMU, PCMA) mit 8 kHz oder G.722. Medienverschlüsselung
  (SRTP) je Richtung „Disabled“, „Allowed“ oder „Required“; empfohlen ist TLS mit
  „Required“.
- Eingehend (zu ElevenLabs): Digest-Anmeldung mit Benutzername und Passwort,
  dazu optional erlaubte Absenderadressen (nur TCP und TLS).
- Ausgehend (von ElevenLabs): Ziel ist ein Rechnername oder eine Adresse, kein
  SIP-URI; Transport TCP, TLS oder UDP; Digest-Anmeldung „strongly
  recommended“, ohne sie verlangt ElevenLabs eine Freigabe seiner Adressen.
- Anrufernummer: `X-Caller-ID` wird zu `system__caller_id`, `X-Call-ID` zu
  `system__call_sid`. From und P-Asserted-Identity nennt die Seite nicht; die
  Vermittlung setzt alle drei.
- Feste Adressen gibt es nur im Enterprise-Tarif (`sip-static.rtc.elevenlabs.io`,
  ein /24-Block). Sonst: „SIP requests may come from different IP addresses“.
  RTP „typically ports 10000-60000“.
- REFER erwähnt die Seite nur bei TLS-Verbindungen innerhalb eines Gesprächs.
  Die Vermittlung lädt kein REFER-Modul, Weiterleitungen scheitern also.
- Folgeverbindungen („Follow-up connections“): Ist die TLS-Verbindung eines
  Gesprächs schon zu, brauchen Anfragen wie BYE eine neue. Zu ElevenLabs geht
  sie an den Contact aus der Antwort, `<ip>.hosts.rtc.elevenlabs.io`, mit einem
  Zertifikat für `*.hosts.rtc.elevenlabs.io`. Von ElevenLabs geht sie an die
  Adresse im obersten Via, oft eine IP-Adresse; das Zertifikat der Gegenstelle
  prüft ElevenLabs dann gegen die „Remote Domains“ in den Einstellungen der
  Nummer. Bei fehlgeschlagener Prüfung rät die Seite, dort den Namen
  einzutragen, auf den das Zertifikat ausgestellt ist.

**Asterisk 22.11.0** ([pjsip_transport_events.c](https://raw.githubusercontent.com/asterisk/asterisk/22.11.0/res/res_pjsip/pjsip_transport_events.c)):
Mit `verify_server = yes` lehnt Asterisk ein Zertifikat ab, dessen Name nicht
genau zum geprüften Namen passt. Ein Wildcard-Name (`*.` vor genau einer
Stelle) zählt nur mit `allow_wildcard_certs = yes` am Transport.

**pjproject 2.17**, die Fassung, die Asterisk 22.11.0 mitbringt
([versions.mak](https://raw.githubusercontent.com/asterisk/asterisk/22.11.0/third-party/versions.mak),
[sip_dialog.c](https://raw.githubusercontent.com/pjsip/pjproject/2.17/pjsip/src/pjsip/sip_dialog.c),
[sip_util.c](https://raw.githubusercontent.com/pjsip/pjproject/2.17/pjsip/src/pjsip/sip_util.c);
in `master` unverändert, abgerufen am 6.11.2026):
Ein Gespräch merkt sich den Namen der Verbindung, über die die Antwort kam
(`initial_dest`), und setzt ihn bei jeder weiteren Anfrage als Zielnamen. Für
SNI und Namensprüfung einer Folgeverbindung nimmt das unveränderte Asterisk
deshalb `sip.rtc.elevenlabs.io`, nicht den Namen aus dem Contact, und lehnt
das Zertifikat `*.hosts.rtc.elevenlabs.io` ab, auch mit
`allow_wildcard_certs`. ACK und BYE kämen dann nicht an: Gespräche brächen ab
oder liefen bei ElevenLabs weiter. Abhilfe ist der Patch unter
„Folgeverbindungen“ weiter unten.

**ElevenLabs, Anruf über SIP-Trunk** ([Outbound call](https://elevenlabs.io/docs/api-reference/sip-trunk/outbound-call)):
`POST /v1/convai/sip-trunk/outbound-call` mit `agent_id`,
`agent_phone_number_id`, `to_number`, optional
`conversation_initiation_client_data` und `telephony_call_config`. Antwort:
`success`, `message`, `conversation_id`, `sip_call_id`. Ein Feld
`max_duration_seconds` wie beim Twilio-Aufruf gibt es dort nicht; die Höchstdauer
setzt deshalb die Vermittlung durch.

**easybell** ([VoIP-Experteneinstellungen](https://www.easybell.de/hilfe/telefon-konfiguration/allgemein/voip-experteneinstellungen/), Stand 31.8.2026;
[Telefonie verschlüsseln](https://www.easybell.de/hilfe/telefon-konfiguration/allgemein/so-koennen-sie-telefonie-verschluesseln/), Stand 19.8.2026;
[Firewall](https://www.easybell.de/hilfe/telefon-konfiguration/allgemein/firewall-fuer-easybell-voip-und-sip-trunking-konfigurieren/), Stand 31.8.2026;
[Preisliste](https://www.easybell.de/telefon-preisliste/)):

- Registrar `voip.easybell.de`; SIP 5060 (UDP/TCP), TLS 5061. Die alten
  Registrare `secure.sip.easybell.de` und `sip.easybell.de` nur für Geräte ohne
  DNS-SRV.
- Verschlüsselung: TLS für SIP und SRTP für die Medien, „Das Endgerät muss TLS
  und SRTP unterstützen.“
- Codecs: G.722, G.711A, G.711U; „Der Codec G.711A muss zwingend konfiguriert
  werden.“ Die Vermittlung nutzt nur G.711A.
- RTP-Ports von easybell: 10.000 bis 50.000 (UDP).
- Adressbereiche: keine veröffentlicht. Die Firewall-Seite sagt: „Nutzen Sie
  dann bitte unbedingt die FQDN und nicht die IP-Adressen. Letztere können sich
  jederzeit ändern.“
- Geräte je Zugang ([Wieviele Geräte kann ich auf einem Anschluss anmelden?](https://www.easybell.de/hilfe/fragen/fragen-zum-telefonanschluss/antwort/wieviele-geraete-kann-ich-auf-einem-anschluss-anmelden/),
  Stand 4.9.2026): „Es können fünf Geräte auf einem SIP-Account angemeldet
  werden.“ Die Vermittlung belegt einen dieser Plätze.
- Preis ins deutsche Mobilfunknetz ohne Flatrate: 9,8 ct/min, minutengenau.
  Ob eingehende Anrufe kostenlos sind, sagt die Preisliste nicht ausdrücklich
  („Die Kosten für Anrufe und Rufweiterleitungen richten sich nach Ihrem Tarif.“).

**Nicht belegt** (offen bis zum Live-Test, siehe unten):

- Wer bei einem Anruf klingelt, wenn außer der Vermittlung noch ein Gerät mit
  demselben Zugang angemeldet ist. Dass beide angemeldet sein dürfen, belegt
  die Hilfe oben; welches Gerät klingelt, zeigt erst der Live-Test.
- Ob easybell eingehende Anrufe über die von der Vermittlung aufgebaute
  TLS-Verbindung zustellt. Das ist bei TLS üblich, die Hilfe sagt dazu nichts.
- Ob eingehende Anrufe kostenlos sind.
- Den Minutenpreis des Twilio-Wegs (0,3763 $ laut Bericht vom 30.10.2026) hat
  dieses Issue nicht neu geprüft.
- Welches Zertifikat die einzelnen Server hinter `<ip>.hosts.rtc.elevenlabs.io`
  tatsächlich zeigen. Die Vermittlung richtet sich nach der Dokumentation
  (`*.hosts.rtc.elevenlabs.io`) und verlangt das in der Containerprüfung.
  Abgefragt am 6.11.2026: Die gemeinsame Adresse von `sip.rtc.elevenlabs.io`
  zeigt ein Zertifikat nur für `sip.rtc.elevenlabs.io`, die einzelnen Server
  sind ohne Gespräch nicht bekannt.

## Folgeverbindungen

Wegen `initial_dest` in pjproject (siehe „Primärquellen“) läuft die
Vermittlung nicht im Standard-Image selbst, sondern in einem daraus gebauten
(`image/Dockerfile`, Tag `sip-vermittlung-asterisk:22.11.0-folge1`).
Ausgetauscht wird nur `libasteriskpj.so.2`: pjproject 2.17, so wie Asterisk
22.11.0 es mit `--with-pjproject-bundled` baut, plus
`image/0100-tls-folgeverbindung-zielname.patch`. Der Patch ändert eine Stelle
in `sip_util.c`: Hat das Ziel einer Anfrage (Contact oder erste Route) einen
eigenen Rechnernamen, gelten SNI und Zertifikatsprüfung diesem Namen, wie es
RFC 5922 verlangt. Den Namen der ersten Verbindung nimmt pjproject nur noch,
wenn das Ziel eine IP-Adresse ist, denn dafür war `initial_dest` gedacht.
`verify_server` und `allow_wildcard_certs` bleiben, die Prüfung selbst
(`pjsip_transport_events.c`) ist unverändert: Ein Zertifikat für
`*.hosts.rtc.elevenlabs.io` passt zu `<ip>.hosts.rtc.elevenlabs.io`, eines für
`sip.rtc.elevenlabs.io` oder einen anderen Namen dort nicht.

Der Build bricht ab, wenn die neue Bibliothek andere Symbole anbietet als die
ersetzte oder der Patch nicht in ihr steckt. Nebenwirkung: Eine noch offene
Verbindung zur selben Adresse unter anderem Namen nutzt pjproject für solche
Anfragen nicht mehr mit, es baut eine neue unter dem Namen des Ziels auf. Bei
einem Update von Asterisk muss der Patch mitwandern; `pruefen.ts --container`
zeigt, ob er noch greift.

### Abweichung vom Issue: vom Maintainer freigegeben

Issue #511 verlangt ein Standard-Image mit festem Tag. Das Image aus `image/`
ist keins, und ein unverändertes, das passt, gibt es nicht (geprüft am
6.11.2026):

- `initial_dest` steckt seit pjproject 2.12 in `sip_dialog.c`, also in jeder
  Fassung, die ein gepflegtes Asterisk mitbringt. In `master` ist
  `sip_util.c` an dieser Stelle unverändert.
- Asterisk 22.12.0, 23.6.0 und 24.0.0 (alle vom 5.11.2026) bringen pjproject
  2.17 mit ([versions.mak](https://raw.githubusercontent.com/asterisk/asterisk/22.12.0/third-party/versions.mak)).
  Keiner ihrer pjproject-Patches berührt `sip_dialog.c` oder `sip_util.c`.
- Mit dem unveränderten Standard-Image `andrius/asterisk:22.11.0_debian-trixie-1b724ca`
  scheitert die Probe `folgeverbindung_wildcard` (Gegenprobe im Pull Request
  #543), und `folgeverbindung_erster_name` nimmt ein falsches Zertifikat an.
- Ohne Patch ginge es nur, wenn die Namensprüfung fällt (`verify_server`)
  oder Anfragen im Gespräch über `sip.rtc.elevenlabs.io` statt an den Contact
  liefen. Das Erste schwächt den Schutz, das Zweite beschreibt ElevenLabs
  nicht und ließe sich vor dem Live-Test nicht belegen.

Der Maintainer hat das Image aus `image/` am 6.11.2026 für Issue #511
freigegeben, eng begrenzt auf diesen einen Patch (Nachtrag E1, „Freigabe
gepatchtes Image“, in `docs/webui/decisions/0026-sprachagenten-rezepte.md`).
Bedingungen: Die Zertifikatsprüfung bleibt an, kein weiterer Patch, und jedes
Update des Images oder von Asterisk geht erst auf den Server, wenn
`pruefen.ts --container` die Folgeverbindungsproben erneut besteht
(`folgeverbindung_wildcard`, `folgeverbindung_falscher_name`,
`folgeverbindung_erster_name`, `folgeverbindung_ip_adresse`). Behebt ein
Standard-Image die Ursache, entfällt der Patch.

## Wie die Vermittlung geschützt ist

- **Keine anonymen Wege.** Jeder Endpunkt hat eine feste Zuordnung:
  - easybell nur über den Parameter `line=` aus der eigenen Registrierung,
  - der Weg von ElevenLabs nur über den Benutzernamen der Digest-Anmeldung
    (`identify_by = auth_username`),
  - der Weg zu ElevenLabs nimmt gar nichts an.

  Eine Anfrage ohne Zuordnung bekommt eine Anmelde-Aufforderung (401), egal ob
  es den Namen gibt. Das ist in PJSIP eingebaut; die Option `alwaysauthreject`
  gibt es nur im alten `chan_sip` und fehlt deshalb mit Absicht.
- **Positivliste.** Der Wählplan vergleicht das Ziel nach dem Vereinheitlichen
  (`0151…`, `0049151…` und `+49151…` sind dieselbe Nummer) Zeichen für Zeichen mit
  jeder erlaubten Nummer. Alles andere endet mit 403 und einer Logzeile
  „Ausgehend abgewiesen“. Zeichen außer `+` und Ziffern führen ebenfalls zur
  Abweisung.
- **Unterdrückte Nummer** auf dem easybell-Weg: Standard ist ablehnen
  (`UNTERDRUECKTE_NUMMER=ablehnen`). Ohne Nummer greifen weder die PIN-Prüfung
  noch die Grenze für Anrufe je Nummer und Tag. Unterdrückt heißt auch: Die
  Nummer kommt zwar mit (etwa in P-Asserted-Identity), die Anzeige ist aber
  nicht erlaubt (`Privacy: id`). Asterisk übernimmt die Nummer dann trotzdem
  in `CALLERID(num)`; der Wählplan prüft deshalb zuerst die Anzeige
  (`CALLERID(num-pres)`). Mit `annehmen` geht ein solcher Anruf nur als
  `anonymous` weiter, ohne Nummer und Namen in irgendeiner Kopfzeile.
- **Höchstens zwei Gespräche** über beide Richtungen (`GROUP_COUNT`). Jeder Anruf
  trägt sich zuerst ein und zählt dann; kommen zwei zugleich, sehen beide den
  höheren Stand und im Zweifel wird abgewiesen (503).
- **Höchstdauer** je Gespräch (`MAX_MINUTEN`, Standard 10): `Dial(…,S())` legt
  nach so vielen Sekunden ab Annahme auf, `TIMEOUT(absolute)` beendet den Kanal
  spätestens 90 Sekunden danach, auch wenn es noch klingelt.
- **TLS und SRTP** auf beiden Seiten. RTP fließt über die Vermittlung
  (`direct_media = no`), `strictrtp` nimmt Medien nur von der Gegenstelle an.
  Asterisk prüft Zertifikat und Namen jeder Gegenstelle (`verify_server`) und
  nimmt dabei Wildcard-Zertifikate an (`allow_wildcard_certs`), weil
  ElevenLabs Folgeverbindungen mit `*.hosts.rtc.elevenlabs.io` beantwortet.
  Geprüft wird gegen den Namen, mit dem sich Asterisk verbindet, bei
  Folgeverbindungen also gegen den Contact (Patch, siehe „Folgeverbindungen“).
  Ein Zertifikat für einen anderen Namen lehnt Asterisk ab.
- **Kein REFER, keine Umleitung, keine Aufnahme, keine Datensätze:**
  `modules.conf` lädt nur die nötigen Module (`autoload = no`);
  `res_pjsip_refer`, `app_mixmonitor`, `app_record`, CDR und CEL sind nicht
  dabei. Ein REFER bleibt deshalb unbeantwortet und verbindet nichts. Beide
  `Dial()` haben die Option `i`: Eine Umleitung (302) der Gegenstelle führt zu
  keinem weiteren Anruf (ohne `i` liefe sie im Kontext des Endpunkts weiter).
  Manager, HTTP und IAX sind aus.
- **Logs ohne Inhalt, Nummern gekürzt.** Asterisk läuft ohne `-v` und `-d` und
  schreibt nur Hinweise, Warnungen, Fehler und Sicherheitsereignisse, und zwar
  nur auf die Konsole. `container/start.sh` leitet die Konsole durch
  `container/logfilter.pl`, der jede Ziffernfolge ab sieben Ziffern kürzt
  (`+49155...`), auch in Standardmeldungen wie dem From-URI oder Benutzernamen
  einer fehlgeschlagenen Anmeldung, und auch dann, wenn sie wie eine Adresse
  oder ein Datum aussieht (`030.123.45.67` wird `03012...`). Erst danach
  landet die Zeile in `logs/messages` (für fail2ban) und im Docker-Log. Stehen
  bleiben Zeitstempel, Ports und die Absenderadresse, aber nur in den Feldern,
  aus denen fail2ban sie liest (`failed for '…'`, `RemoteAddress="…"`).
- **Firewall** (`erzeugt/firewall.nft`, eigene Tabelle): Der TLS-Port bleibt
  offen, weil ElevenLabs keine festen Adressen hat; je Absender höchstens 20 neue
  Verbindungen pro Minute. UDP-SIP gibt es nur mit `EASYBELL_TRANSPORT=udp`, und
  dann nur für die Adressen von easybell aus dem DNS. Der RTP-Bereich ist klein
  (Standard 10000 bis 10019, vier Ports je Gespräch, doppelt bemessen).
- **Firewall vor Asterisk, auch nach einem Neustart des Servers.** nft-Regeln
  leben nur im laufenden Kernel. Die Unit `sip-vermittlung-firewall.service`
  lädt sie bei jedem Systemstart, bevor Docker startet, und nach einem
  Neustart von `nftables.service` erneut. `firewall.sh` legt danach die Marke
  `/run/sip-vermittlung/geladen` an; `/run` ist nach jedem Systemstart leer.
  Ohne Marke startet Asterisk nicht (`container/start.sh`), Docker versucht es
  mit wachsendem Abstand weiter. Scheitert die Firewall, bleibt also nur die
  Vermittlung aus, die übrigen Container auf dem Server starten normal.
- **fail2ban** sperrt eine Adresse nach fünf fehlgeschlagenen Anmeldungen in
  zehn Minuten für einen Tag. Asterisk schreibt die Zeit in UTC, das Jail liest
  sie mit `logtimezone = UTC`, unabhängig von der Zeitzone des Servers.

## Einrichtung

Voraussetzungen auf dem Server: Docker mit Compose, nftables, fail2ban, ein
Rechnername mit gültigem Zertifikat (etwa `sip.example.org`). Beispielpfad hier:
`/docker/sip-vermittlung`.

Reihenfolge: erst Firewall und Schutz, dann der öffentlich erreichbare Start.

1. Den Ordner `deploy/sip-vermittlung/` auf den Server kopieren, etwa nach
   `/docker/sip-vermittlung`.
2. `cp beispiel.env .env && chmod 600 .env`, dann die Werte eintragen:
   - easybell: SIP-Benutzer und Passwort aus dem Kundenportal, Rufnummer in E.164.
   - Zwei neue Zugangsdaten für ElevenLabs ausdenken (Passwörter mit
     mindestens 16 Zeichen, etwa `openssl rand -base64 24`, ohne `;`):
     `ELEVENLABS_EIN_*` (die Vermittlung meldet sich bei ElevenLabs an) und
     `ELEVENLABS_AUS_*` (ElevenLabs meldet sich bei der Vermittlung an).
   - `SIP_HOSTNAME`, Positivliste (`ERLAUBTE_ZIELE` oder `USER_PHONE_NUMBER`).
3. Zertifikat für `SIP_HOSTNAME` beschaffen. Läuft Traefik auf dem Server, kann
   es das Zertifikat beziehen (ein Router mit diesem Namen genügt);
   `ldez/traefik-certs-dumper:v2.11.4` legt es als Dateien `fullchain.pem` und
   `privkey.pem` in einem Ordner ab. Dann als root
   `sudo ./zertifikat-erneuern.sh <ordner>`: Das kopiert beides nach
   `zertifikat/`, gibt den Schlüssel nur dem Asterisk-Nutzer im Container
   (uid 1000, Rechte 0640) und startet nichts neu, solange Asterisk noch nicht
   läuft. Täglich per Cron (root):
   `17 4 * * * /docker/sip-vermittlung/zertifikat-erneuern.sh <ordner>`. Bei
   jedem Lauf stellt das Skript Schlüssel und Rechte sicher; ein neues
   Zertifikat übernimmt Asterisk per Neustart, aber erst, wenn kein Gespräch
   läuft (sonst beim nächsten Lauf). Scheitert die Abfrage bei Docker oder ist
   die Antwort unlesbar, startet nichts neu: Der Neustart bleibt offen, das
   Skript meldet den Fehler und endet mit Exit 1.
4. Konfiguration erzeugen, ohne Asterisk zu starten:
   `docker compose run --rm vorlagen`. Fehler nennen die Einstellung. Dann
   das Asterisk-Image bauen: `docker compose build asterisk` (einmal mit
   Internet, einige Minuten; siehe „Folgeverbindungen“).
5. Firewall dauerhaft einrichten: `sudo ./firewall.sh --anzeigen` zum Ansehen,
   dann die Unit für jeden Systemstart:
   `sudo cp systemd/sip-vermittlung-firewall.service /etc/systemd/system/`
   (liegt der Ordner nicht unter `/docker/sip-vermittlung`, `ExecStart`
   anpassen), `sudo systemctl daemon-reload`,
   `sudo systemctl enable --now sip-vermittlung-firewall.service`. Prüfen:
   `sudo nft list table inet sip_vermittlung` und
   `cat /run/sip-vermittlung/geladen`. Mit `EASYBELL_TRANSPORT=udp` zusätzlich
   stündlich per Cron `sudo ./firewall.sh`, weil easybell seine Adressen ändern
   kann. Erst danach den TLS-Port und den RTP-Bereich in einer vorgeschalteten
   Firewall (etwa beim Hoster) freigeben.
6. fail2ban: `sudo cp fail2ban/sip-vermittlung.local /etc/fail2ban/jail.d/`,
   `logpath` prüfen, `mkdir -p logs`, `sudo systemctl reload fail2ban`.
7. Starten: `docker compose up -d`. Ohne Marke aus Schritt 5 endet der Container
   mit „Firewall der Vermittlung seit dem Systemstart nicht geladen“. Dann
   `docker exec sip-vermittlung asterisk -rx "pjsip show registrations"`:
   Zustand `Registered`.
8. Zustand für tybo: einen eigenen SSH-Schlüssel auf dem tybo-Rechner anlegen
   (`ssh-keygen -t ed25519 -f ~/.ssh/tybo-sip-zustand -N ""`) und auf dem Server
   in `authorized_keys` des Kontos, das `docker` aufrufen darf, als erzwungenen
   Befehl eintragen:
   `command="/docker/sip-vermittlung/zustand.sh",restrict ssh-ed25519 AAAA… tybo-sip-zustand`.
   `restrict` schaltet Weiterleitungen, Terminal und Agent ab; der Schlüssel
   kann nur diesen Befehl ausführen. In der `.env` von tybo:
   `SIP_VERMITTLUNG_SSH=<konto>@<server>` und
   `SIP_VERMITTLUNG_SSH_KEY=~/.ssh/tybo-sip-zustand`.
9. Bei ElevenLabs die Nummer (SIP-Trunk) umstellen:
   - Inbound: Digest-Anmeldung mit `ELEVENLABS_EIN_BENUTZER` und
     `ELEVENLABS_EIN_PASSWORT`, Medienverschlüsselung „Required“. Unter
     „Remote Domains“ `SIP_HOSTNAME` eintragen. Baut ElevenLabs für ein BYE
     eine neue TLS-Verbindung zur Vermittlung auf, geht sie an die Adresse im
     Via, in der Regel an die IP-Adresse des Servers; das Zertifikat der Vermittlung
     lautet aber auf `SIP_HOSTNAME`. Ohne diesen Eintrag scheitert die
     Prüfung, und ElevenLabs kann ein Gespräch nicht beenden, dessen erste
     Verbindung schon zu ist.
   - Outbound: Adresse `SIP_HOSTNAME`, Transport TLS, Digest-Anmeldung mit
     `ELEVENLABS_AUS_BENUTZER` und `ELEVENLABS_AUS_PASSWORT`, Medienverschlüsselung
     „Required“, Codec PCMA.
   - Zuerst einen harmlosen Test-Agenten zuweisen, nicht den eigentlichen
     Assistenten.
10. `/anruf` auf diesen Weg umstellen, in der `.env` von tybo:
    `ELEVENLABS_PHONE_PROVIDER=sip_trunk`, `ELEVENLABS_PHONE_NUMBER_ID` auf die
    Kennung der easybell-Nummer bei ElevenLabs. `/anruf` nimmt
    `ELEVENLABS_AGENT_ID`, unabhängig davon, welcher Agent eingehend auf der
    Nummer liegt: für den ersten Test also auch dort den Test-Agenten eintragen.

## Zustand und Meldung

`zustand.sh` gibt Zeilen `name=wert` aus:

```
version=1
zeit=2026-11-06T10:00:00Z
status=Registered
letzte_registrierung=2026-11-06T10:00:00Z
gespraeche=0
```

- `status`: der Zustand der Registrierung bei easybell aus
  `pjsip show registrations` (`Registered`, `Unregistered`, `Rejected` …),
  `gestoppt`, wenn Asterisk nicht antwortet, `unbekannt`, wenn die Zeile fehlt.
- `letzte_registrierung`: Zeitpunkt der letzten Abfrage, bei der die
  Vermittlung registriert war (UTC). Er steht in `zustand/` auf dem Server und
  wird nur durch Abfragen fortgeschrieben; leer heißt: noch nie gesehen.
- `gespraeche`: laufende Gespräche (Kanäle im Zähler).

tybo fragt das per SSH ab (Zeitlimit 15 Sekunden). `tybo pruefen` zeigt den
Zustand nur an, der Nachtcheck nimmt ihn in den Bericht auf. Die Meldung bei
Ausfall kommt von `bun run sip-zustand`; das schreibt sich einen Zustand in
`data/sip-vermittlung/zustand.json` und meldet einen Ausfall genau einmal, nach
zwei Abfragen hintereinander ohne Registrierung, und die Erholung einmal. Ein
Neustart von tybo ändert daran nichts. Alle zehn Minuten als Routine, mit dem
Wrapper aus `docs/routinen.md`:
`bun run src/routine-run.ts --id ai.tybo.sip-zustand -- bun run src/sip-zustand.ts`
(Plist nach dem Muster dort, `StartInterval` 600). Ohne `SIP_VERMITTLUNG_SSH`
gilt die Vermittlung als „nicht eingerichtet“, dann meldet nichts.

## Prüfung vor dem Einsatz

Im Repo, ohne Server und ohne echte Gegenstelle:

```
bun run deploy/sip-vermittlung/pruefen.ts              # statisch
bun run deploy/sip-vermittlung/pruefen.ts --container  # zusätzlich Laufzeit und Neustart mit Docker
```

Die Images haben feste Tags (`python:3.13-alpine`, `crazymax/fail2ban:1.1.0`,
die Grundlage in `image/Dockerfile`). Das Asterisk-Image baut die Prüfung
selbst aus `image/`, mit demselben Tag wie `compose.yaml`; das Bild für die
Neustartprüfung entsteht aus `pruefung/systemd.Dockerfile` (Debian mit festem
Digest). Für beide braucht der erste Build Internet. Die Container selbst
haben keinen Weg nach außen. Für die Fehlersuche: `SIP_PRUEFUNG_NUR=refer,weiterleitung` (nur diese
Gruppen), `SIP_PRUEFUNG_PROTOKOLL=1` (SIP-Startzeilen),
`SIP_PRUEFUNG_BEHALTEN=1` (Container bleiben stehen).

Die Containerprüfung (etwa drei Minuten) startet Asterisk mit der
Konfiguration aus `beispiel.env`, aber einer Minute Höchstdauer, in zwei
internen Docker-Netzen ohne Weg nach außen. `pruefung/sip_probe.py` spielt in
einem zweiten Container easybell (Registrar auf `voip.easybell.de`) und
ElevenLabs (SIP-Trunk auf `sip.rtc.elevenlabs.io`), beide mit Digest und mit
Zertifikaten einer Prüf-CA, der Asterisk statt der öffentlichen vertraut.
Geprüft wird, was Asterisk tatsächlich tut:

- Geladene URIs mit `transport=tls`; REGISTER über TLS mit `transport=tls` und
  `line=` im Contact, Zustand `Registered`.
- Eingehend über die Registrierung: Anruf kommt bei ElevenLabs an (nach
  Digest), mit der Nummer des Anrufers in `X-Caller-ID`, From und
  P-Asserted-Identity, auch aus nationaler Schreibweise; Auflegen beendet beide
  Seiten. Ohne oder mit falschem `line=` ist ein Anruf nicht easybell (401).
- Ausgehend: Anmeldung (401, dann 200), Wahl über easybell mit Digest an die
  Nummer in E.164, auch aus `0…`; ohne Anmeldung, mit falschem Passwort,
  unbekanntem Konto, verbotenem Ziel oder Buchstaben: 401, 401, 401, 403, 404,
  ohne Anruf bei easybell.
- Unterdrückte Nummer (From `anonymous`, und Nummer in P-Asserted-Identity mit
  `Privacy: id`): standardmäßig abgelehnt; mit `annehmen` nur als
  `anonymous`, die Nummer steht in keiner Zeile des INVITE an ElevenLabs.
- Gleichzeitig: Zwei Gespräche laufen, der dritte Anruf wird in beide
  Richtungen abgewiesen; drei Starts im selben Augenblick ergeben höchstens
  zwei Gespräche; danach ist der Zähler wieder frei.
- Folgeverbindung zu ElevenLabs: Der Contact im 200 OK lautet
  `<ip>.hosts.rtc.elevenlabs.io` und zeigt wie dokumentiert ein Zertifikat für
  `*.hosts.rtc.elevenlabs.io`. Das ACK muss über eine neue TLS-Verbindung
  dorthin ankommen. Dann schließt die Attrappe alle Verbindungen des
  Gesprächs und easybell legt auf: Das BYE muss über eine weitere neue
  Verbindung ankommen, und jede dieser Verbindungen muss per SNI den Namen
  des Contacts nennen. Zeigt der Contact ein Zertifikat für einen anderen
  Namen oder für `sip.rtc.elevenlabs.io`, darf über die Verbindung nichts
  gehen. Gegenprobe: Ist der Contact eine IP-Adresse, gilt weiter der Name der
  ersten Verbindung, ACK und BYE kommen mit dessen Zertifikat an.
- Umleitung (302) von ElevenLabs oder easybell und REFER aus allen vier
  Richtungen: kein weiterer Anruf, das Gespräch endet erst beim Auflegen.
- Höchstdauer: Niemand legt auf, die Vermittlung beendet alle vier Gesprächs-
  hälften nach 60 Sekunden.
- fail2ban mit dem Jail aus `fail2ban/` (in einer anderen Zeitzone): Der
  Filter trifft die Zeilen in `logs/messages`, ein Angreifer mit eigener
  Adresse wird nach seinen Fehlversuchen gesperrt und erreicht die Vermittlung
  nicht mehr.
- Logs: In `logs/messages` und im Docker-Log steht keine der verwendeten
  Nummern vollständig, auch nicht aus From oder Benutzername der Angriffe.
- Ohne Marke der Firewall startet Asterisk nicht; die offenen Ports sind nur
  der TLS-Port (und der RTP-Bereich).

Die Neustartprüfung startet Debian mit systemd im Container, richtet die Unit
und eine Attrappe von `docker.service` ein und startet dreimal neu (mit Unit,
ohne Unit, mit Unit). Erwartet: Beim Start von Docker sind Tabelle und Marke
da, ohne Unit beide nicht. Die Bun-Tests (`tests/sip-vermittlung.test.ts`)
prüfen Generator, Auswertung, Logfilter, Startsperre, `firewall.sh` und
`zertifikat-erneuern.sh` mit Attrappen.

## Live-Test (mit dem Nutzer, nicht in der Pipeline)

Was nur mit echtem Anschluss geht, Schritt für Schritt abhaken:

1. Firewall und fail2ban aktiv (`systemctl status sip-vermittlung-firewall`,
   `sudo nft list table inet sip_vermittlung`,
   `sudo fail2ban-client status sip-vermittlung`), erst dann `docker compose up -d`.
2. Registrierung: `zustand.sh` zeigt `status=Registered`.
3. Doppel-Registrierung: Ist ein weiteres Gerät (etwa ein Router mit
   Telefonanschluss) mit demselben Zugang angemeldet? Testanruf und notieren,
   wer klingelt und wer annimmt. Falls beide klingeln, im Kundenportal klären,
   ob sich das Zielgerät festlegen lässt, oder das andere Gerät abmelden.
4. Eingehend: vom Handy die easybell-Nummer anrufen. Erwartet: Der Test-Agent
   meldet sich, beide Seiten hören sich, im Gesprächsprotokoll bei ElevenLabs
   steht die eigene Nummer als `system__caller_id`. Mindestens eine Minute
   sprechen, dann am Handy auflegen: Das Gespräch bricht vorher nicht ab und
   endet bei ElevenLabs mit dem Auflegen (Folgeverbindungen, die Prüfung vor
   dem Einsatz deckt sie schon ab).
5. Mit unterdrückter Nummer anrufen: Erwartet wird eine Ablehnung
   (Standard `ablehnen`).
6. Ausgehend: `/anruf Test` in tybo. Erwartet: Das eigene Handy klingelt, die
   Anzeige zeigt die easybell-Nummer, beide Seiten hören sich.
7. Verbotenes Ziel: einmal per API (`/v1/convai/sip-trunk/outbound-call`) eine
   andere Nummer wählen lassen. Erwartet: Es klingelt nirgends, im Log steht
   „Ausgehend abgewiesen“.
8. Logs: `grep -E '[0-9]{7,}' logs/messages` und dasselbe auf
   `docker logs sip-vermittlung 2>&1` finden keine vollständige Rufnummer.
9. Ausfall: `docker stop sip-vermittlung`; nach zwei Läufen von
   `bun run sip-zustand` kommt genau eine Meldung, nach `docker start` und
   zwei weiteren Läufen die Entwarnung.
10. Neustart des Servers (wenn vertretbar): danach
    `systemctl status sip-vermittlung-firewall` aktiv, Tabelle geladen,
    `zustand.sh` zeigt wieder `status=Registered`.

Dritter Anruf, Höchstdauer, Umleitung und REFER prüft schon die
Containerprüfung mit lokalen Gegenstellen; am echten Anschluss sind sie nicht
mehr nötig.

## Rückbau

1. Bei ElevenLabs den Agenten von der Nummer nehmen und in der `.env` von tybo
   `ELEVENLABS_PHONE_PROVIDER` entfernen (wieder Twilio) bzw. die alte
   `ELEVENLABS_PHONE_NUMBER_ID` eintragen.
2. Auf dem Server: `docker compose down --rmi local` (entfernt auch das
   gebaute Asterisk-Image), dann
   `sudo systemctl disable --now sip-vermittlung-firewall.service`,
   `sudo rm /etc/systemd/system/sip-vermittlung-firewall.service`,
   `sudo systemctl daemon-reload`, `sudo rm -rf /run/sip-vermittlung`,
   `sudo nft delete table inet sip_vermittlung`,
   `sudo rm /etc/fail2ban/jail.d/sip-vermittlung.local && sudo systemctl reload fail2ban`,
   die Cron-Zeilen entfernen und den SSH-Schlüssel aus `authorized_keys`
   löschen.
3. Den Ordner löschen; `.env` und `zertifikat/` enthalten Zugangsdaten.
4. In der `.env` von tybo `SIP_VERMITTLUNG_SSH` und `SIP_VERMITTLUNG_SSH_KEY`
   entfernen und die Routine `ai.tybo.sip-zustand` ausbinden.

Ohne Vermittlung meldet sich easybell wieder nur bei den übrigen Geräten; der
Twilio-Weg für `/anruf` bleibt unverändert nutzbar.
