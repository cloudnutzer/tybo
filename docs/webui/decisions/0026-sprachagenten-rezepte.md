# 0026 Sprachagenten-Baukasten: Rezepte statt Einzelstücke

Datum: 30.10.2026. Entschieden von: Maintainer (Milestones „SA1“ bis „SA4“,
Gäste und Gehirn des Experten am 29. und 30.10.2026), Umsetzungsdetails aus
der Prüfung vor dem Bau von Issue #489.

## Kontext

tybo hat genau einen Sprachagenten, konfiguriert über die `.env`. Weitere
entstehen von Hand beim Anbieter, ohne Tests und ohne Verlauf in tybo. Der
Maintainer will drei Arten per Knopfdruck: eine Anrufannahme für Fremde, einen
persönlichen Assistenten mit Gedächtnis und Experten zum Üben.

Dieses Dokument hält fest, was das Format bestimmt. Anbieter-Anbindung,
Befehl, Oberfläche und Nachlauf regeln ihre Issues.

## Entscheidung

### Rezept als einzige Quelle

- Ein Sprachagent ist eine Datei `config/voice-agents/<kennung>.json`. Was beim
  Anbieter liegt, folgt aus dem Rezept. Vorlagen dafür liegen in
  `config/voice-agents.example/`.
- Laufzeitdaten liegen getrennt unter `data/voice-agents/<kennung>/`. Der
  Ordnername `entwuerfe` ist für Entwürfe reserviert und keine gültige Kennung.
- Prüfung ohne Sprachmodell. Unbekannte Felder sind Fehler und werden nicht
  still entfernt: Ein Tippfehler in einem Sicherheitsfeld darf nicht durchgehen.

### Leitplanken

- **Keine Gäste:** Kein Feld `gaeste`, der Web-Zugang liegt immer hinter dem
  Login. Eine Freigabe fürs Team wird bei Bedarf einzeln gebaut.
- **Gedächtnis `voll`** am Telefon nur mit PIN. Ohne Telefon entscheidet die
  Freigabe im Server.
- **Fremde** (`anrufer: alle` oder Vorlage `anrufannahme`): KI-Hinweis Pflicht,
  Stufe `keins`.
- **Kostenschutz:** `maxMinuten` und `budget` sind Pflicht. Mit Telefon muss
  `anrufeJeNummerTag` mindestens 1 sein.
- **Feste Regeln** der Vorlagen kann ein Rezept ergänzen, nicht streichen.
  Regeln und Standard-Tests werden zusammengeführt; ein Rezept-Test gleichen
  Namens verdrängt keinen Standard-Test.

### Gehirn des Experten

Standard ist `anbieter` mit `claude-sonnet-5-5` (gemessen 1,39 s bis zum ersten
Ton). Themenwissen steht im Prompt oder in einer Wissensdatei des Agenten.
`bruecke` mit Stufe `thema` bleibt als Rückfall erlaubt, `voll` gibt es beim
Experten nicht.

### Stimme

Keine persönliche Stimmen-ID im Repo, die Beispiele nennen keine. Vorrang:
`stimme.voiceId` im Rezept, dann `speech.call.elevenlabsVoice`, dann
`ELEVENLABS_VOICE_ID`. Ohne alle drei scheitert das Speichern mit einer klaren
Meldung. Übernommen wird beim Speichern, die Stimme steht danach im Rezept:
Sonst änderte eine Einstellung den Agenten, ohne dass sich der Hash des Rezepts
ändert, und der Abgleich bemerkte nichts. Nur die Art `bibliothek` erbt;
`design` und `eigene` nennen ihre Stimme selbst.

### Versionen

Hash über die sortierte JSON-Fassung (Schlüssel rekursiv sortiert, Listen in
ihrer Reihenfolge). `saveRecipe` legt eine neue Version an, wenn der Hash von
dem der letzten Version abweicht. Der Abgleich beim Anbieter hat einen eigenen
Hash in `state.json`: Ein gescheiterter Abgleich darf keine Version erzeugen.

### Speichern und Ablage

- **Sperre je Kennung:** `saveRecipe` läuft ganz unter
  `data/voice-agents/<kennung>/speichern.lock` (`src/lib/file-lock.ts`, gilt über
  Prozesse). Bleibt sie 30 Sekunden belegt, scheitert das Speichern und nichts
  ändert sich.
- **Erst die Version, dann das Rezept:** So hat jedes aktive Rezept eine Version.
  Scheitert die Version, etwa an einer beschädigten letzten Version, bleibt das
  aktive Rezept unberührt und der Fehler nennt die Datei. tybo repariert sie
  nicht selbst: Wer sie wegräumt oder berichtigt, kann wieder speichern.
- **Rezept nicht schreibbar:** Die gerade angelegte Version wird zurückgenommen.
  Bleibt sie nach einem Absturz oder einer gescheiterten Rücknahme liegen, ist
  sie neuer als das aktive Rezept, bis zum nächsten Speichern. Dasselbe Rezept
  erzeugt dann keine weitere Version, und das aktive Rezept wird geschrieben.
- **Keine symbolischen Links:** `config/voice-agents`, `data/voice-agents`, die
  Agentenordner, `versionen` und alle Dateien darin müssen echt sein, sonst gibt
  es einen Fehler. Was oberhalb dieser Ordner liegt, gehört dem Nutzer und darf
  verlinkt sein. Dateien werden mit `O_NOFOLLOW` geöffnet. Bei Ordnern bleibt ein
  Zeitfenster zwischen Prüfung und Zugriff; wer dort gerade Links tauschen kann,
  hat ohnehin Schreibrecht auf die Ablage.
- **Zustand und Versionen:** Eine fehlende Datei gilt als „noch nichts da“, ein
  JSON-`null` als beschädigt. Auch eine Version, die kein JSON-Objekt ist, gilt
  als beschädigt.

### Sprachschicht (Issue #490)

- **Abgleich:** `letzterHash` ist der Hash beim letzten Abgleich. Gleicher Hash
  heißt: kein Aufruf, ohne Ausnahme. Prompt und Brücke ändern ihn nicht; eine
  Abweichung wird lokal erkannt und nur als Hinweis gemeldet, übernommen wird sie
  mit der nächsten Rezeptänderung oder nach Entfernen und neuem Anlegen.
- **Handänderungen:** Geprüft wird unmittelbar vor der nächsten Änderung gegen den
  zuletzt gelesenen Stand, je Feld als Hash über die Werte, auch die innerhalb von
  `language_presets`. Abweichung heißt Warnung und Abbruch. Überschreiben lässt
  sich eine Handänderung nicht: Der Ausweg ist, sie beim Anbieter zurückzunehmen
  oder den Agenten mit `remove` zu entfernen und neu anzulegen. Einen eigenen
  Überschreib-Befehl sieht Issue #490 nicht vor; er bräuchte eine Entscheidung des
  Maintainers. Nach jedem Schreiben wird der Stand neu gelesen, damit Ergänzungen
  des Anbieters nicht als Handänderung gelten.
- **Gescheiterte Nachfrage:** Vor der Nachfrage steht in `ausstehend`, was gesendet
  wurde (je Feld als Hash). Der nächste Abgleich vergleicht damit, schreibt bei
  Übereinstimmung nichts und warnt sonst. Fehlt jede Vergleichsgrundlage, warnt er
  ebenfalls. So überschreibt tybo nie etwas, das es nicht vergleichen konnte.
- **Entfernte Sprachen:** Die Doku von `PATCH /agents/{id}` legt nicht fest, ob
  `language_presets` ersetzt oder zusammengeführt wird, und erlaubt `null` als Wert
  nicht. Dokumentiert sind nur `POST /agents/create` und `DELETE /agents/{id}`.
  Entfällt eine Sprache, legt tybo deshalb einen neuen Agenten an, liest ihn zurück
  und löscht erst dann den alten (`ersetzterAgentId` im Zustand, bis das geklappt
  hat). Die Kennung ändert sich, und Einstellungen außerhalb des Rezepts gehen
  verloren; hängt am alten Agenten eine Telefonnummer oder ein WhatsApp-Konto, bricht
  tybo ab. Hinzukommende Sprachen gehen weiter über `PATCH` mit der vollständigen
  Karte, das wirkt bei beiden Verhalten gleich; maßgeblich bleibt der zurückgelesene
  Stand.
- **Token der Brücke:** liegt als Geheimnis beim Anbieter, der Agent trägt nur
  den Verweis (`custom_llm.api_key.secret_id`). So steht es in keiner Antwort, die
  den Agenten liefert. Ein Kopf `Authorization` als Klartext wäre einfacher, läge
  aber im Agenten offen.
- **Teilerfolge:** Jede Kennung wird sofort nach ihrem Aufruf gespeichert. Tests
  haben pro Name einen eigenen Hash, deshalb lässt sich ein gescheiterter Abgleich
  der Tests auch bei unverändertem Agenten wiederholen.
- **Sperre:** `deploy`, `syncTests` und `remove` laufen unter derselben Sperre wie
  `saveRecipe`.

### Brücke (Issue #491)

- **Stufe als Obergrenze:** `voll` nur als „Nutzer“: am Telefon Nummer und bestätigte
  PIN, im Web eine Freigabe. Sonst `keins`. `thema` am Telefon nur für freigeschaltete
  Nummern, damit `anrufer: freigegeben` auch für die Wissensdatei gilt.
- **Web-Freigabe als Datei:** je Gespräch eine Datei unter
  `data/voice-agents/<kennung>/web-calls/`, weil WebUI und Brücke getrennte Prozesse
  sind und ein Neustart des einen die Freigabe nicht kosten soll. Liegt beim Rezept,
  denn jede Kennung ist auch als Ordnername gültig, ein gemeinsamer Ordner könnte mit
  einem Agenten zusammenfallen. Laufzeit höchstens längstes Gespräch plus fünf Minuten.
- **Ohne Kopf bleibt alles:** Der Betrieb ohne Rezept behält `VOICE_ALLOW_UNIDENTIFIED`
  und den Nummern-Nachweis allein. Ein ungültiger Kopf fällt nie dorthin zurück.
- **Reihenfolge im Prompt:** Die festen Regeln bleiben zuletzt, Wissen und Kontext
  stehen davor.

## Alternativen

- **Agenten weiter von Hand anlegen:** verworfen, ohne Rezept gibt es weder
  Tests noch Versionen.
- **`src/lib/json-state.ts` für `state.json`:** verworfen, es schreibt nach
  `<pfad>.sqlite`, die JSON-Datei bliebe veraltet.
- **Rückfall auf die vorinstallierte Stimme des Telefonhörers:** verworfen, ein
  Agent spräche sonst still mit einer Stimme, die niemand gewählt hat.

## Folgen

- Neue Module unter `src/lib/voice-agents/`, neue Ordner
  `config/voice-agents/` (lokal) und `data/voice-agents/`.
- Bestehende Variablen und `/anruf` bleiben unverändert.
- Der Nachweis für die festen Regeln ist der erzeugte Prompt. Ob ein Modell sie
  einhält und wirklich auflegt, zeigen erst die Testläufe beim Anbieter.

## Nachtrag E1: Anrufannahme über eigene SIP-Vermittlung (Issue #511)

Datum: 30.10.2026, umgesetzt am 6.11.2026. Entschieden von: Maintainer.

- **Nummer:** Die Anrufannahme nutzt eine vorhandene Rufnummer bei einem
  deutschen SIP-Anbieter, erprobt mit easybell. Twilio vergibt deutsche
  Nummern nur mit Gewerbenachweis. Ein direkter Import der Nummer als
  SIP-Trunk scheiterte, weil ein Privatkunden-Anschluss bei easybell Anrufe
  nur an registrierte Geräte liefert.
- **Vermittlung:** Asterisk mit PJSIP auf einem eigenen Server
  (`deploy/sip-vermittlung/`). Sie registriert sich bei easybell, reicht
  eingehende Anrufe per TLS und Digest an ElevenLabs weiter und nimmt Anrufe von
  ElevenLabs nur mit Digest-Anmeldung an. Ausgehend wählt sie nur eine
  Positivliste.
- **`/anruf`:** Abweichend von „Bestehende Variablen und `/anruf` bleiben
  unverändert“ unter Folgen kann `/anruf` jetzt über einen SIP-Trunk wählen
  (`ELEVENLABS_PHONE_PROVIDER=sip_trunk`, Aufruf
  `/v1/convai/sip-trunk/outbound-call`). Ohne die Variable bleibt alles wie
  bisher mit Twilio; bestehende Einrichtungen ändern sich nicht.
- **Zustand:** per SSH mit erzwungenem Befehl statt eines zusätzlichen offenen
  Ports. Gemeldet wird ein Ausfall einmal, nach zwei Fehlabfragen hintereinander,
  und die Erholung einmal; der Zustand liegt in `data/sip-vermittlung/`.


### Freigabe gepatchtes Image (6.11.2026)

Entschieden von: Maintainer (Option A aus der Eskalation im Pull Request #543).
Diese Freigabe ändert für Issue #511 das Kriterium „Standard-Image mit festem
Tag“.

- **Was ersetzt wird:** Die Vermittlung läuft in einem Image, das aus dem
  Standard-Image `andrius/asterisk:22.11.0_debian-trixie-1b724ca` gebaut wird
  (`deploy/sip-vermittlung/image/`, Tag `sip-vermittlung-asterisk:22.11.0-folge1`).
  Ausgetauscht wird allein `libasteriskpj.so.2`: pjproject 2.17, wie Asterisk
  22.11.0 es mitbringt, plus `0100-tls-folgeverbindung-zielname.patch`.
- **Warum:** pjproject merkt sich den Namen der ersten Verbindung eines Dialogs
  (`initial_dest`) und nimmt ihn für SNI und Zertifikatsprüfung jeder weiteren
  Anfrage, auch beim Wechsel zum Contact
  ([sip_dialog.c](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_dialog.c),
  [sip_util.c](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_util.c)).
  ElevenLabs beantwortet Folgeverbindungen unter `<ip>.hosts.rtc.elevenlabs.io`
  mit dem Zertifikat `*.hosts.rtc.elevenlabs.io`
  ([Follow-up connections](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking#follow-up-connections)).
  Das unveränderte Image prüft gegen den falschen Namen und lehnt das richtige
  Zertifikat ab. Asterisk 22.12.0, 23.6.0 und 24.0.0 bringen weiterhin
  pjproject 2.17 ohne Änderung an diesen Stellen mit
  ([22.12.0](https://github.com/asterisk/asterisk/blob/22.12.0/third-party/versions.mak),
  [23.6.0](https://github.com/asterisk/asterisk/blob/23.6.0/third-party/versions.mak),
  [24.0.0](https://github.com/asterisk/asterisk/blob/24.0.0/third-party/versions.mak);
  geprüft am 6.11.2026).
- **Umfang:** nur der vorhandene Patch, die Zielnamenswahl in `sip_util.c`:
  Rechnername des nächsten Ziels für SNI und Zertifikatsprüfung,
  `initial_dest` nur als Rückfall für Ziele, die als IP-Adresse angegeben sind.
  Kein weiterer Patch, keine abgeschaltete Namensprüfung (`verify_server` und
  `allow_wildcard_certs` bleiben wie sie sind), kein Weg über einen Proxy, den
  ElevenLabs nicht beschreibt.
- **Bedingungen:** Die Zertifikatsprüfung bleibt an. Die Folgeverbindungsproben
  in `deploy/sip-vermittlung/pruefen.ts --container` bleiben Pflicht:
  `folgeverbindung_wildcard` (ACK und BYE über neue Verbindungen mit dem
  Namen des Contacts), die beiden Ablehnungsfälle
  `folgeverbindung_falscher_name` und `folgeverbindung_erster_name` sowie die
  Gegenprobe `folgeverbindung_ip_adresse`.
- **Updates:** Jedes Update des Images oder von Asterisk braucht diese
  Nachweise erneut, bevor es auf den Server geht.
- **Ende des Patches:** Sobald ein Standard-Image die Ursache behebt und die
  Proben ohne Patch bestehen, entfällt der Patch und die Vermittlung nutzt
  wieder das unveränderte Image.

## Nachtrag SA1-5: Entwurf per Befehl (Issue #493)

Datum: 7.11.2026. Entschieden von: Maintainer (Issue #493), Umsetzungsdetails aus
der Prüfung vor dem Bau.

- **Job statt Turn:** Entwurf und Recherche laufen als Hintergrund-Job, nie mit
  `--full-access`. `acceptEdits` erlaubt Dateiänderungen im ganzen
  Arbeitsverzeichnis ([Claude-Code-Doku](https://code.claude.com/docs/en/permissions));
  Schreibregeln und ein Vergleich nach dem Lauf schützen aktive Daten nicht.
  Deshalb startet der Job in einem eigenen Arbeitsordner
  (`data/voice-agents/entwuerfe/.arbeit/<entwurf>/`) mit `--restricted`,
  `--strict-mcp-config` und `--tools` ohne Bash: Er kann nur dort lesen und
  schreiben. Steuerdaten (`entwuerfe/.steuerung/<entwurf>/`), aktive Rezepte,
  Versionen, Wissensdateien, Freischaltungen und Rückfragen liegen außerhalb.
  Der Hash-Vergleich aktiver Dateien nach dem Lauf bleibt als zweite Prüfung.
- **Abschluss verfolgen:** Der Wächter des Jobs ist ein eigener Prozess und
  meldet sich nicht beim Bot. Der Bot liest deshalb alle 15 Sekunden den Status
  der Jobs offener Entwürfe; Job, Versuch, Schritt und Gespräch stehen in
  `data/voice-agents/entwuerfe/.steuerung/<entwurf>/entwurf.json`. Jeder Schritt
  schreibt erst den Zustand, dann folgt die Wirkung; ein Job ohne eingetragene
  Kennung wird nach einem Neustart über seinen Titel angehängt, eine fehlende
  Rückfrage neu gestellt.
- **Ablage:** Der geprüfte Entwurf liegt wie im Issue gefordert unter
  `data/voice-agents/entwuerfe/<kennung>/`. Weil der Job die Kennung erst
  vorschlägt, entsteht der Ordner nach der Prüfung; vorher arbeitet der Job in
  seinem Arbeitsordner. Je Kennung ist höchstens ein Entwurf offen (Datei
  `entwurf-id`), damit sich zwei Entwürfe nicht überschreiben.
- **Ein Nachbesserungslauf:** nur bei Prüfungsfehlern oder fehlender Ausgabe.
  Gestoppt, Zeitlimit, Absturz und Abbruch beenden den Entwurf ohne zweiten Lauf.
- **Wissensdatei mit Hash im Namen:** `wissen-<hash>.md`. So ändert auch eine
  reine Wissensänderung den Rezept-Hash, es entsteht eine Version, und der
  Abgleich beim Anbieter läuft. Beim Gehirn `anbieter` steht das Wissen im
  Prompt (`providerPrompt`), vor den festen Regeln.
- **Stimme:** Die Beschreibung bleibt ein Metadatum des Entwurfs (`stimme.txt`),
  das Rezept-Schema bleibt strikt. Vorgeschlagen werden Stimmen des Kontos beim
  Anbieter, nie lokale Klone (Entscheidung 0023).
- **Freischaltung:** `data/voice-agents/<kennung>/freischaltung.json`, gebunden an
  den Hash der getesteten Fassung und an den Hash des Inhalts ihrer
  Wissensdatei (der Name allein schützt nicht vor einer späteren Änderung, und
  die Brücke liest die Datei bei jedem Gespräch). Nur bestandene Tests oder „Trotzdem
  freischalten“ nach einem vollständigen Lauf mit durchgefallenen Tests schalten
  frei; ein Lauf mit einem abgebrochenen Test, Fehler, Zeitüberschreitung und
  Neustart nie. Den Web-Link baut SA1-6 (Nachtrag unten) und fragt dafür `isUnlocked`.
- **Erreichbarkeit:** Eine lokale Freischaltungsdatei sperrt keine Nummer, die
  beim Anbieter am Agenten hängt. Eine ungeprüfte Fassung bleibt deshalb
  unerreichbar: Hängt am bestehenden Agenten eine Telefonnummer oder ein
  WhatsApp-Konto (oder lässt sich das nicht prüfen), übernimmt tybo die
  Änderung nicht, und `deploy` prüft es mit `nurOhneZuordnung` beim Schreiben
  noch einmal.
- **Speichern:** `saveRecipe` nimmt eine Vorbedingung (`guard`), die unter der
  Sperre der Kennung prüft, ob die Kennung frei ist bzw. das Ausgangsrezept
  noch gilt. Die eigene, schon gespeicherte Fassung gilt als erfüllt. Der guard
  nimmt die Sperre nicht selbst.
- **Stimme eingefroren:** Vor der Freigabe steht die Stimme fest im Rezept,
  auch die Standardstimme; der Freigabe-Hash umfasst sie.
- **Kosten:** „Plan Abschnitt 7“ aus dem Issue liegt nicht im Repo. Ersatz ist
  eine eingebaute Preisgrundlage mit Tarif, Annahmen, Preisstand und
  Primärquellen (`src/lib/voice-agents/cost.ts`, Tabelle in `docs/sprechen.md`):
  0,08 USD je Minute beim Anbieter
  ([Preisseite](https://elevenlabs.io/pricing/agents)), Modellpreise je Million
  Token aus der [LLM-Preisliste](https://elevenlabs.io/scale-tier#llm-prices),
  3 Züge je Minute mit je 6.700 Eingabe- und 150 Ausgabe-Token ohne Cache,
  Preisstand 7.11.2026. Beim Gehirn `bruecke` nennt die Freigabe nur den Anteil
  des Anbieters und keinen Höchstbetrag je Gespräch. Eine eigene
  `config/voice-agent-preise.json` geht vor.

## Nachtrag SA1-6: Web-Gespräch je Rezept (Issue #494)

Datum: 7.11.2026. Entschieden von: Maintainer (Issue #494, E3 und E6),
Umsetzungsdetails aus der Prüfung vor dem Bau.

- **Nur hinter dem Login:** Gesprächsseite `/sa/<kennung>` und Routen
  `/api/voice-agents/<kennung>`, `…/session`, `…/session/end`. Die Seite antwortet
  ohne Anmeldung mit 401 statt mit der Umleitung der übrigen Seiten, damit kein
  Gesprächslink ohne Login etwas ausliefert. Ein Token gibt es nur für den Browser,
  nicht mit dem Terminal-Schlüssel.
- **Reihenfolge:** Web-Zugang, Freischaltung (`isUnlocked`), abgeglichene Fassung in
  `state.json` (`letzterHash` gleich dem Hash des Rezepts, nichts ausstehend), dann
  unter der Sperre der Kennung Parallelität, Rate-Limit und Budget samt Reservierung,
  erst danach der Anbieter. Die Prüfungen laufen unter derselben Sperre wie Speichern
  und Abgleich, also gegen einen festen Stand.
- **Gesprächs-ID:** ausschließlich `conversation_id` aus der Token-Antwort des
  Anbieters. Die Web-Freigabe steht vor der Antwort an den Browser, nur bei
  `gehirn.art: bruecke`; bei `anbieter` gibt es weder Freigabe noch Brückenschlüssel.
- **Grenzen:** ein Gespräch zur Zeit je Rezept, 6 Anfragen beim Anbieter in 10
  Minuten (auch gescheiterte), Minutenbudget im Kalendermonat. Jeder Start bucht
  `maxMinuten`, nach dem vom Anbieter bestätigten Ende dessen Dauer (angefangene
  Minuten). Ohne Bestätigung bleibt `maxMinuten` gebucht. Ablage in `web-sitzungen.json` beim Rezept, damit ein
  Neustart nichts freigibt.
- **Köpfe:** CSP und `Permissions-Policy` nur für die ausgelieferte Gesprächsseite
  erweitert (Hosts des Anbieters in `connect-src`, Kamera aus). Alle anderen
  Antworten bleiben unverändert, auch Sprechmodus und Telefonhörer.
- **Nach dem Abruf beim Anbieter:** Der Abruf läuft ohne Sperre. Danach prüft der
  Server unter der Sperre, ob die Reservierung noch offen ist und ob Rezept,
  Wissensdatei, Web-Zugang, Freischaltung, Abgleich und Agent dieselben sind. Sonst
  gibt es weder Token noch Freigabe. Ein Browser, der während des Abrufs auflegt,
  startet mit einem verspäteten Token keine Verbindung und meldet dessen Ende.
- **Auflegen:** nur mit der Gesprächs-ID aus dem eigenen Start, nie ohne ID für
  irgendein laufendes Gespräch. Der Browser bindet Token, SDK-Verbindung und
  Endemeldung an einen Sitzungskontext und lässt bis zu dessen Abschluss keinen
  neuen Start zu. Auch beim Verlassen wartet er auf einen laufenden
  Verbindungsaufbau und trennt dessen Ergebnis, bevor er das Ende meldet. Scheitert
  das Trennen oder wird die Seite vorher entladen, bleiben Sperre und volle
  Minuten reserviert. Ein anderer Tab zeigt nur einen Hinweis, weil er diese
  Verbindung nicht trennen kann. Auf dem Server erst die Web-Freigabe löschen,
  dann das Ende speichern. Scheitert
  das Löschen, bleibt das Gespräch laufend (503), damit eine Wiederholung es findet
  und die Berechtigung nicht stehen bleibt.
- **Getrennt heißt: Raum getrennt.** Das SDK ruft beim Beenden `room.disconnect()`
  ohne `await` auf; `endSession()` und `onDisconnect` kommen also vor dem Ende des
  Transports. Die Seite wartet deshalb selbst auf `room.disconnect()` des
  LiveKit-Raums (läuft im SDK unter einer Sperre, ein zweiter Aufruf wartet auf den
  ersten) und meldet das Ende nur bei `room.state` „disconnected“. Ohne Bestätigung
  binnen 15 Sekunden bleibt alles reserviert und „Noch einmal auflegen“ wartet
  erneut. Das eingecheckte SDK bleibt unverändert.
- **Wahrheit beim Anbieter (Eskalation 4, 8.11.2026):** Vier Prüfrunden fanden
  immer neue Rennen derselben Art (zwei LiveKit-Räume zugleich, Minuten zu früh
  zurückgebucht), weil Sperre, Freigabe und Buchung an Meldungen des Browsers
  hingen (endSession, onDisconnect, Aufbau-Zeitgeber). Der Browser kann eine
  Trennung nie sicher belegen: Scheitert der SDK-Aufbau vor
  `onConversationCreated`, kennt die Seite keine Sitzung, der Raum kann aber
  verbunden sein; und ein Zeitgeber bricht `startSession` nicht ab. Deshalb ist die
  Endemeldung nur ein Anlass für den Server, beim Anbieter nachzufragen
  (`GET /v1/convai/conversations/<id>`, Status `initiated`, `in-progress`,
  `processing`, `done`, `failed`, Dauer in `metadata.call_duration_secs`). Platz,
  Freigabe und endgültige Minuten werden nur frei, wenn ElevenLabs das Ende belegt
  (beendet, oder Gesprächs-ID unbekannt nach Tokenablauf). Dieselbe Nachfrage vor
  jedem Start und für die Zustandsroute. Ohne Nachweis (aktiv, nicht erreichbar,
  unklar) bleibt alles bis zur harten Grenze Tokenablauf plus `maxMinuten` plus eine
  Minute; den Ablauf liest der Server aus dem Token (`exp`) und übernimmt ihn
  unverändert. Ohne lesbaren Ablauf oder mit mehr als 60 Minuten geht das Token
  nicht an den Browser, die Reservierung wird zurückgenommen.
  Aufbau-Frist und Meldung „verbunden“ sind damit entfallen. Preis: Kommt eine
  Verbindung nicht zustande, bleibt der Platz bis zum Tokenablauf belegt, weil das
  Token bis dahin noch verbinden könnte.
- **Browser-Verbindung:** auf der Gesprächsseite selbst (Aufgabe 2b), WebRTC mit
  genau dem ausgegebenen Token über `@elevenlabs/client`. Die Bibliothek ist nach
  den Vorgaben aus #245 fest eingecheckt (`src/web/public/vendor/elevenlabs/`,
  Prüfsummen, Lizenzen, `scripts/vendor-elevenlabs.ts`), geladen erst beim Tipp auf
  „Sprechen“, ohne CDN; das Worklet kommt von eigenem Pfad, weil die CSP `blob:`
  und `data:` verbietet. Auflegen, Verbindungsfehler und Verlassen der Seite melden
  das Ende über `/session/end`. Den Bereich Sprachagenten mit Liste, Detail und
  Stumm baut SA1-7 (Issue #495) darauf.

## Nachtrag SA1-8: Nachlauf-Weiche und Trainingsauswertung (Issue #496)

Datum: 8.11.2026. Entschieden von: Maintainer (Issue #496), Umsetzungsdetails aus
der Prüfung vor dem Bau.

- **Zuordnung:** schon abgelegtes Gespräch, dann `agent_id` gegen `agentId`,
  `ersetzterAgentId` und `bekannteAgentIds` in `state.json`, dann die Gesprächs-ID in
  `web-sitzungen.json`, sonst der Anrufdienst wie bisher. `updateState` hält jede
  Agent-Kennung in `bekannteAgentIds` fest, damit Ersetzen und Entfernen die Zuordnung
  verspäteter Protokolle nicht kosten. Ein Lesefehler heißt „unklar“ (500, ElevenLabs
  stellt erneut zu), nie „fremder Anruf“. Der Agent aus `ELEVENLABS_AGENT_ID` geht
  ohne Nachschlagen an den Anrufdienst, damit eine beschädigte Datei `/anruf` nicht
  aufhält.
- **Kein fremder Nachlauf:** Rezepte ohne Training bekommen weder Zusammenfassung noch
  Rückfrage des Anrufdienstes, ihr Gespräch wird nur abgelegt.
- **Webhook wartet nicht auf das Modell:** Sobald das Gespräch dauerhaft abgelegt ist,
  antwortet er mit 200. Wiederholungen plant tybo selbst, aus dem Zustand der
  Gesprächsdatei auch nach einem Neustart.
- **Prüfbare Auswertung:** genau drei Bewertungen mit `nr` 1 bis 3, nur `erfuellt`,
  `teilweise`, `nicht`, Zitate wörtlich aus den Beiträgen des Übenden (normalisiert).
  Ohne Zitat nur bei `nicht`. Keine Kürzung auf 6000 Zeichen wie bei `call-summary`.
- **Verlauf:** an das Rezept (Datei beim Rezept) und den Wortlaut des Kriteriums
  gebunden, sortiert nach Gesprächszeit. Jeder Eintrag trägt Rezept-Hash und
  verwendete Kriterien.
- **Meldung ohne Idempotenzschlüssel:** Vor dem Versand steht `sendet` im Zustand;
  zugestellt, unklar und `sendet` nach Neustart beenden, nur sicher abgelehnt wird
  wiederholt.
- **Ziel ohne Telegram:** `topic:<n>` geht dann in den Web-Direktchat, weil die
  Outbox ohne Telegram keine Topics kennt.

## Nachtrag SA1-9: Wizard, Serverteil (Issue #514)

Datum: 9.11.2026. Entschieden von: Maintainer (Issue #514), Umsetzungsdetails aus
der Prüfung vor dem Bau.

- **Ein Kern:** Der Wizard baut über `startWizard` des Entwurfsdienstes, also mit
  demselben Job, derselben Prüfung und denselben Rückfragen wie `/sprachagent neu`.
  Seine Felder sind Vorgaben, die nach dem Job über das Rezept gelegt werden, bevor
  `parseRecipe` prüft. Kein zweites Rezeptformat; die Kennzeichen `fest` gelangen nie
  ins Rezept.
- **Zuordnung:** Die Kennung im Pfad ist die des künftigen Agenten. Ein Entwurf in der
  Phase `wizard` reserviert `entwuerfe/<kennung>/` über `entwurf-id`; `wizard.json`
  nennt dieselbe ID. Sonst gilt der Wizard als unbekannt.
- **Feste Regeln:** Der KI-Hinweis gilt im Wizard für jede Vorlage, mit festem Text.
  Fehlt ein fester Wert, setzt ihn der Server; eine Änderung oder ein Abschalten ergibt
  422.
- **Telefon nur ausdrücklich:** Ohne Telefon im Wizard entfernt tybo ein Telefon aus
  dem Rezept des Jobs, damit keine Nummer dazukommt, die der Nutzer nicht gewählt hat.
- **Credits:** Gegenwert des Dollarbetrags zum Satz des Creator-Plans, belegt auf der
  Preisseite des Anbieters (121.000 Credits für 22 USD im Monat, 5.500 Credits je USD,
  abgerufen am 9.11.2026); die Doku zu Pay As You Go nennt je Plan einen eigenen Satz
  von Credits zu Dollar. Eine eigene Umrechnung in `config/voice-agent-preise.json`
  (`credits`) geht vor.
- **Kennungen:** `session`, `rezept`, `test`, `link`, `loeschen`, `vorschlag` und
  `entwuerfe` nimmt der Wizard nicht als Kennung, damit die Routen eines Agenten namens
  `wizard` erhalten bleiben.
