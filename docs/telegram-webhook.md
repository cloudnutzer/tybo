# Telegram per Webhook

Auf dem eigenen Rechner holt tybo neue Telegram-Nachrichten per Polling ab:
der Bot fragt Telegram laufend, ob etwas Neues da ist. Das bleibt der
Standard. Auf einem Server kann derselbe Bot-Prozess stattdessen einen
Webhook nutzen: Telegram schickt jede Nachricht selbst an eine Adresse des
Servers (Issue #350). Code: `src/lib/runtime-profile.ts`
(Profil) und `src/lib/telegram-runtime.ts` (Listener).

## Einstellungen in der `.env`

| Variable | Bedeutung |
|----------|-----------|
| `TYBO_PROFILE` | `local` (Standard, auch wenn leer): Polling. `server`: Webhook |
| `TELEGRAM_WEBHOOK_SECRET` | Pflicht bei `server`. 16 bis 256 Zeichen aus `A-Z`, `a-z`, `0-9`, `_` und `-`. Telegram schickt es in jedem Aufruf im Kopf `X-Telegram-Bot-Api-Secret-Token` mit; Anfragen ohne oder mit falschem Secret bekommen 401 |
| `TELEGRAM_WEBHOOK_HOST` | Adresse des Listeners, Standard `127.0.0.1` |
| `TELEGRAM_WEBHOOK_PORT` | Port des Listeners, Standard `3080`. Darf nicht der Health-Port (`HEALTH_PORT`, Standard 3000) und bei eingeschalteter WebUI nicht `WEB_PORT` (Standard 3100) sein |
| `TELEGRAM_WEBHOOK_URL` | Öffentliche `https`-Adresse, unter der Telegram den Listener erreicht, etwa `https://bot.example.org/telegram`. Gesetzt: der Bot trägt den Webhook beim Start selbst bei Telegram ein |

Ein Secret erzeugen: `openssl rand -hex 32`.

Der Listener nimmt `POST /telegram` an, dazu die Server-Wege aus dem
nächsten Abschnitt. Telegram verlangt `https`; der
Listener selbst spricht nur `http`. Davor gehört deshalb ein Reverse-Proxy
oder Tunnel, der `https://…/telegram` an `http://127.0.0.1:3080/telegram`
weitergibt. Die WebUI wird dadurch nicht öffentlich: der Proxy leitet nur
diesen Pfad (und bei Bedarf die Server-Wege) weiter.

## Server-Wege

Nur im Profil `server` hängen am selben Listener drei weitere Wege (Issue
#351, Code: `src/app/server-routes.ts`). Auf dem eigenen Rechner gibt es sie
nicht; dort bleibt der lokale Health-Server mit `/health` und `/process`.

| Weg | Wozu | Voraussetzung |
|-----|------|---------------|
| `GET /health` | Lebenszeichen: `status: ok` und `revision` aus `RELEASE_REVISION` (ohne Wert `working-tree`). Keine Session, keine Gesprächsdaten | immer |
| `POST /deploy` | Push-Ereignis von GitHub startet das Deploy-Skript (`DEPLOY_SCRIPT`, Standard `deploy.sh`), höchstens eins zur Zeit | `DEPLOY_SECRET` |
| `POST /webhook/elevenlabs` | Protokoll nach einem Anruf; tybo fasst es zusammen wie ein abgefragtes Protokoll | `ELEVENLABS_WEBHOOK_SECRET` |

`/deploy`: In GitHub unter Settings → Webhooks die Adresse
`https://…/deploy`, Content type `application/json` und als Secret den Wert
von `DEPLOY_SECRET` eintragen. Geprüft wird der Kopf `X-Hub-Signature-256`
über den unveränderten Body. Nur ein Push auf `DEPLOY_BRANCH` löst etwas aus
(Standard `refs/heads/master`; `main` und `refs/heads/main` meinen
dasselbe), ein `ping` und andere Ereignisse nicht.

`/webhook/elevenlabs`: Im ElevenLabs-Agenten den Post-Call-Webhook
(Transkription) auf `https://…/webhook/elevenlabs` setzen und das dort
angezeigte Secret als `ELEVENLABS_WEBHOOK_SECRET` übernehmen. Die Signatur
im Kopf `ElevenLabs-Signature` darf höchstens 5 Minuten alt sein. Die
Zusammenfassung eines Anrufs, den tybo gestartet hat, kommt in dessen
Gespräch; die eines anderen Anrufs mit demselben Agenten in den Direktchat
(Name im Protokoll aus `USER_NAME`), samt Verlauf und Rückfrage zum Auftrag.
Kommt dasselbe Protokoll mehrfach (Wiederholung, Neustart, die Abfrage war
schneller), gibt es trotzdem genau eine Zusammenfassung. Scheitert die
Zusammenfassung, antwortet tybo mit 500, damit ElevenLabs erneut zustellt;
das Protokoll bleibt gespeichert, tybo versucht es auch selbst erneut und
nimmt nach Ablauf der Frist (15 Minuten nach dem Wählen bzw. nach dem
ersten Protokoll eines fremden Anrufs) den Anfang des Protokolls.

Ohne Secret antwortet der jeweilige Weg mit 503 und tut nichts. Falsche
oder fehlende Signatur ergibt 401, ein Body über 512 KiB 413.

Ist etwas ungültig (Secret fehlt oder ist zu kurz, Port belegt, Adresse
ohne `https`, unbekanntes Profil), meldet der Bot beim Start
`[telegram] Profil …: kein Telegram-Eingang (…)`. Er startet dann weder
einen Webhook ohne Secret noch Polling; WebUI, Erinnerungen und Meldungen
laufen weiter.

## Start und Ausrollen auf dem Server

`bun run vps` startet denselben Bot wie `bun run start`, aber mit
`--profile server` (Issue #352). Die Angabe auf der Befehlszeile gilt vor
`TYBO_PROFILE` aus der `.env`; steht dort etwas anderes, sagt es eine
Logzeile beim Start. Ohne gültiges `TELEGRAM_WEBHOOK_SECRET` gibt es dann
keinen Telegram-Eingang, nie Polling.

`deploy.sh` (gestartet über `POST /deploy` oder von Hand) packt den neuen
Stand als eigenes Verzeichnis unter `.releases/` aus, installiert und prüft
ihn mit `bun run check` und fasst erst danach den laufenden PM2-Prozess an:
alten Prozess anhalten, neuen als `src/bot.ts --profile server` starten,
auf `/health` mit der neuen Revision warten, sonst zurück zur vorigen
Einstellung. Höchstens ein Deploy läuft zur Zeit. Ein Protokoll je Lauf
liegt unter `.releases/deploy-*.log`.

| Variable | Bedeutung |
|----------|-----------|
| `DEPLOY_DIR` | Projektordner mit `.git`, `.env` und Daten. Standard: Ordner des Skripts |
| `DEPLOY_BRANCH` | Branch, Standard `master` |
| `DEPLOY_REMOTE` | Remote für `git fetch`, Standard `origin` |
| `DEPLOY_APP` | PM2-Name des Bots, Standard `tybo` |
| `DEPLOY_PREVIOUS_APP` | PM2-Name des laufenden Prozesses, wenn er anders heißt; einmal gesetzt für den Wechsel auf `tybo` (Rückweg unter dem alten Namen) |
| `RELEASE_ROOT` | Ablage der Releases, Standard `DEPLOY_DIR/.releases` |
| `DEPLOY_HEALTH_URL` | Prüfadresse. Standard `http://127.0.0.1:<TELEGRAM_WEBHOOK_PORT>/health`, also Port 3080 |

Was alle Releases teilen (`.env`, `config/`, `data/`, `uploads/`,
`logs/` und einige Einzeldateien), steht in `scripts/deploy-shared.txt`,
mit Format und Regeln am Anfang der Datei. Ordner werden als Ganzes
verlinkt, damit Dateien, die tybo atomar ersetzt (`config/settings.json`,
`config/agents.json`, `config/topics.json`), erhalten bleiben. Kommt der
Server vom bisherigen Layout (dort war `config/` im Release ein echter
Ordner), übernimmt der erste Deploy nach dem Anhalten die Dateien, die der
Bot dort geschrieben hat, in den Projektordner. Die `.env` im Release ist
ein Link auf die `.env` im Projektordner; Schlüssel-Seite und das erstmalige
Anlegen der Push-Schlüssel schreiben diese echte Datei, nie über den Link.

## Webhook bei Telegram eintragen

Mit `TELEGRAM_WEBHOOK_URL` passiert das beim Start von selbst. Ohne die
Variable einmal von Hand (Token und Secret aus der `.env`):

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d url=https://bot.example.org/telegram \
  -d secret_token=<SECRET>
```

Prüfen: `curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"`.
`url` muss die eigene Adresse zeigen, `last_error_message` sollte fehlen.

## Zurück zum Polling

`TYBO_PROFILE=local` setzen (oder die Zeile löschen) und den Bot neu
starten. Beim Start des Pollings löscht grammY den Webhook bei Telegram
selbst; liegengebliebene Nachrichten holt das Polling danach ab.

Nie beides gleichzeitig: Solange ein Webhook eingetragen ist, lehnt Telegram
Polling mit demselben Token ab, und ein Bot, der pollt, löscht den Webhook
eines anderen.

## Verhalten

- Antwort an Telegram kommt sofort; der Turn läuft danach im Hintergrund.
  Dauert die Annahme länger als 10 Sekunden, antwortet der Listener trotzdem
  mit 200, damit Telegram nicht erneut zustellt.
- Ein Fehler in der Verarbeitung landet als Zeile
  `Telegram-Handler fehlgeschlagen (Update …)` im Fehlerprotokoll, die
  Antwort ist trotzdem 200.
- Stellt Telegram dasselbe Update noch einmal zu, löst es keinen zweiten
  Turn aus (`[telegram] Update … erneut zugestellt, übersprungen`).
- Nachrichten fremder Absender werden wie beim Polling ignoriert.
- Beim Beenden schließt der Bot den Listener. Was Telegram in der Zeit
  schicken will, stellt es später erneut zu.

## Hybrid: Server und eigener Rechner

Optional (Issue #353): Der Server bleibt der einzige Empfänger der
Telegram-Updates und reicht sie an den eigenen Rechner weiter, solange der
sich gesund meldet. Der eigene Rechner antwortet dann mit seinem Motor
(etwa dem Abo), der Server springt nur ein, wenn der Rechner fehlt oder
sicher ablehnt. Code: `src/app/hybrid.ts` und `src/lib/hybrid/`.

### Einrichtung

Beide Rechner nutzen dasselbe Supabase-Projekt (`SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`), denselben Telegram-Bot und dasselbe
`GATEWAY_SECRET` (`openssl rand -hex 32`). Ohne Datenbank gibt es keinen
Hybrid-Betrieb.

| Wo | Variable | Bedeutung |
|----|----------|-----------|
| Server | `TYBO_PROFILE=server` | wie oben, mit gültigem Webhook |
| Server | `HYBRID_PEER_URL` | Basisadresse des Health-Ports des eigenen Rechners, etwa `http://100.64.0.2:3000` (Tailscale) oder `https://rechner.example.org` (Tunnel). Leer: kein Hybrid |
| Server | `HYBRID_PEER_NODE_ID` | Kennung des eigenen Rechners, Standard `local` |
| eigener Rechner | `TYBO_PROFILE=peer` | kein Polling, kein Eingriff in den Webhook; Updates kommen nur über `POST /relay` am Health-Port |
| eigener Rechner | `HYBRID_NODE_ID` | eigene Kennung für den Herzschlag, Standard `local` |
| eigener Rechner | `HEALTH_HOST`, `HEALTH_PORT` | wo der Health-Port lauscht, Standard `127.0.0.1:3000`; für den Server etwa die Tailscale-Adresse |
| beide | `GATEWAY_SECRET` | gemeinsames Geheimnis, auch für `/process` |

Der Health-Port gehört nie offen ins Internet: nur über ein privates Netz
wie Tailscale oder einen `https`-Tunnel erreichbar machen. Prüfen vom Server
aus: `curl <HYBRID_PEER_URL>/health`.

Fehlt dem eigenen Rechner im Profil `peer` das Geheimnis oder die
Datenbank, startet er ohne Telegram-Eingang
(`[telegram] Profil peer: kein Telegram-Eingang (…)`), nie mit Polling.
Fehlt auf dem Server etwas, steht beim Start `[hybrid] Hybrid aus: …` im
Log und der Server arbeitet allein wie bisher.

### Ablauf

- Der eigene Rechner schreibt alle 30 Sekunden einen Herzschlag in die
  Tabelle `node_heartbeat`. Der Server liest ihn höchstens alle 15 Sekunden;
  gesund heißt: jünger als 90 Sekunden.
- Nachrichten (auch Befehle, Fotos, Sprache, Dateien) aus freigegebenen
  Chats (`TELEGRAM_USER_ID`, `TELEGRAM_CHAT_ID`, `GATEWAY_ALLOWED_CHAT_IDS`
  und die Gruppe des Bots) und Knöpfe gehen bei gesundem Rechner dorthin,
  wenn sie vom Besitzer (`TELEGRAM_USER_ID`) kommen. Fremde Absender bleiben
  auf dem Server und wie beim Polling ohne Antwort. Der Rechner verarbeitet sie mit denselben Handlern wie beim Polling:
  Topic, Agent, Session und `/stop` gelten dort.
- Lehnt der Rechner sicher ab (falsches Geheimnis, Chat nicht freigegeben,
  voll, er fährt gerade herunter) oder ist er nicht erreichbar, antwortet
  der Server selbst.
- Ist unklar, ob der Rechner eine Nachricht angenommen hat (Zeitüberschreitung,
  Fehler des Tunnels), versucht der Server es genau einmal erneut. Bleibt es
  unklar, führt er nichts aus und schreibt in den Chat, dass die Nachricht
  bei Bedarf noch einmal zu senden ist. Lieber einmal zu wenig als doppelt.
- Rückfragen gehören dem Rechner, auf dem sie entstanden sind. Ein Klick auf
  einen Knopf einer Frage des eigenen Rechners geht dorthin; ist er nicht
  erreichbar, bleibt die Frage offen und der Klick bekommt einen Hinweis.
- Sessions liegen je Rechner. Wechselt die Verarbeitung, arbeitet der
  andere Rechner mit seiner eigenen Session weiter (oder beginnt eine neue)
  und holt sich den Verlauf aus der gemeinsamen Datenbank. Topic-Zuordnungen
  und Agenten-Einstellungen sind ebenfalls je Rechner; für gleiches Verhalten
  auf beiden gleich halten.
- `/stop` erreicht den Rechner, der die Nachricht bekommt. Läuft ein Turn
  auf dem eigenen Rechner und der gilt gerade nicht als gesund, sagt der
  Server, dass bei ihm nichts läuft.
- Beim Herunterfahren antwortet der eigene Rechner sofort mit 503, der Server
  übernimmt dann ohne die 90 Sekunden abzuwarten.

Laufen beide Rechner gleichzeitig an derselben Datenbank, können beide
Erinnerungen, Faden-Erinnerungen und Routinen-Meldungen senden. Das ändert
der Hybrid-Betrieb nicht.
