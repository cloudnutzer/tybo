# tybo rund um die Uhr auf dem Raspberry Pi 5

Diese Anleitung bringt tybo auf einen Raspberry Pi 5, der zu Hause dauerhaft
läuft. Danach antwortet tybo in Telegram auch dann, wenn dein Laptop zu ist.
Die allgemeine Einrichtung mit allen Schritten des Assistenten steht in
[einrichtung.md](einrichtung.md); hier geht es um das, was auf dem Pi anders
ist.

**Worauf die Anleitung beruht.** Installer und Einrichtung wurden am
27.09.2026 in einer Debian-12-VM mit ARM64 (gleiche Architektur wie der Pi 5)
mit 8 GB und mit 4 GB Arbeitsspeicher durchgespielt, mit tybo 2.12.0 aus dem
öffentlichen Repo. Debian 12 (Bookworm) ist die Grundlage von Raspberry Pi OS
(Legacy), das diese Anleitung deshalb verwendet. Das aktuelle Raspberry Pi OS
beruht auf Debian 13 (Trixie) und ist mit dieser Anleitung nicht geprüft.
Die VM bildet weder CPU-Tempo noch Speicherkarte oder SSD des Pi ab, und ohne
Telegram-Token und Claude-Anmeldung lief dort kein echtes Gespräch. Vor jedem
Befehlsblock steht deshalb ein **Prüfstand**, ebenso bei Befehlen im Text und
in jeder Zeile der Fehlerbehebung:

- *in der VM geprüft*: genau so in der Debian-VM gelaufen. Wo der Befehl in
  der VM etwas anders aussah, steht die Abweichung dabei.
- *nicht in der VM geprüft*: folgt der offiziellen Anleitung des Herstellers
  oder dem Code von tybo, lief aber nicht in der VM (Pi-Hardware, Anmeldung,
  echter Betrieb).

Geprüfte und ungeprüfte Befehle stehen in getrennten Blöcken. Die VM hatte
keinen Hostnamen `tybo-pi.local`; jede Anmeldung per `ssh` an diesen Namen ist
deshalb nicht in der VM geprüft.

Der Autostart als systemd-Benutzerdienst und die Zahl gleichzeitiger Aufträge
nach Arbeitsspeicher sind nach dem VM-Test in tybo eingebaut worden. In der VM
lief ein von Hand angelegter Dienst derselben Bauart, nicht der Assistent
selbst; den decken die automatischen Tests von tybo ab.

## Wofür, und wofür nicht

**Wofür:**

- **Immer an.** Der Pi läuft Tag und Nacht, tybo antwortet auch, wenn dein
  Rechner schläft oder unterwegs ist.
- **Wenig Strom.** Im Leerlauf rechnen wir mit etwa 5 Watt (Annahme, nicht
  gemessen; siehe [Stromkosten](#stromkosten)).
- **Statt eines Servers im Rechenzentrum.** Kein VPS, keine Monatsmiete, das
  Gerät steht bei dir.
- **Programm und Einstellungen bleiben zu Hause.** tybo selbst, die `.env`
  mit deinen Schlüsseln und die Dateien in `config/` und `data/` liegen auf
  dem Pi.

**Was trotzdem das Haus verlässt:**

- Jede Nachricht an Claude geht zu Anthropic, wie auf jedem anderen Rechner
  auch. Nachrichten an Telegram laufen über die Server von Telegram.
- Mit dem empfohlenen Weg **Supabase in der Cloud** liegen Verlauf und
  Gedächtnis bei Supabase, nicht auf dem Pi.
- Die semantische Suche rechnet mit OpenAI oder Gemini, wenn du sie
  einschaltest.

**Grenzen:**

- **Keine Mac-Programme und keine MCP-Server vom Mac.** Der Pi sieht nur,
  was auf ihm selbst eingerichtet ist. MCP-Server, Skills und Hooks aus der
  Claude-Konfiguration deines Macs sind dort nicht da; die richtest du auf dem
  Pi neu ein, soweit sie unter Linux laufen.
- **Ollama bringt auf dem Pi wenig.** Als Ersatz-Chatmodell ist ein Pi 5 zu
  langsam (Einschätzung, nicht gemessen). Für die semantische Suche geht
  Ollama nur zusammen mit Supabase auf diesem Rechner, nicht mit Supabase in
  der Cloud (siehe [Semantische Suche](einrichtung.md#5-semantische-suche-optional)).
  Mit Supabase in der Cloud nimmst du für die Suche einen Schlüssel von
  OpenAI oder Gemini.
- **Nur Raspberry Pi 5 mit 64-Bit-System.** Bun gibt es unter Linux nur für
  64 Bit; ein 32-Bit-Raspberry-Pi-OS geht also nicht. Ein Pi 4 mit 64-Bit-OS
  und genug Arbeitsspeicher könnte laufen, ist aber nicht geprüft.

## Einkaufsliste

| Teil | Empfehlung | Warum |
|---|---|---|
| Raspberry Pi 5 | **8 GB** Arbeitsspeicher | tybo erlaubt dann 3 gleichzeitige Aufträge. Mit **4 GB** geht es auch, dann sind es 2. |
| Netzteil | offizielles 27-W-USB-C-Netzteil | Der Pi 5 meldet mit schwächeren Netzteilen Unterspannung und drosselt USB. |
| Kühlung | Active Cooler (Lüfter mit Kühlkörper) oder ein Gehäuse mit Lüfter | Der Pi läuft dauerhaft, Claude-Aufträge erzeugen Last. |
| Speicher | **NVMe-SSD** (128 GB oder mehr) mit M.2-HAT für den Pi 5 | Speicherkarten nutzen sich im Dauerbetrieb ab und sind langsam. tybo braucht nach der Installation etwa 2,4 GB, plus Protokolle und Updates. |
| Gehäuse | passend zu HAT und Kühlung | Nicht jedes Gehäuse hat Platz für beides. |
| Für die Installation | eine microSD-Karte oder ein USB-Adapter für NVMe-SSDs | Siehe [System auf die SSD](#1-system-auf-die-ssd). |
| Netz | LAN-Kabel, wenn möglich | Stabiler als WLAN für ein Gerät, das immer erreichbar sein soll. |

## Einrichtung

Du brauchst einen zweiten Rechner (Laptop) mit Terminal und SSH. Alle Befehle
ab Schritt 2 laufen per SSH auf dem Pi, als dein normaler Benutzer, nie als
root.

### 1. System auf die SSD

Das System ist **Raspberry Pi OS (Legacy) Lite (64-bit)** auf Debian 12
(Bookworm), ohne Bildschirmoberfläche. Im
[Raspberry Pi Imager](https://www.raspberrypi.com/software/) steht es unter
„Raspberry Pi OS (other)“; die oberste Empfehlung dort ist das aktuelle
Raspberry Pi OS auf Trixie, das diese Anleitung nicht abdeckt (siehe
„Worauf die Anleitung beruht“ am Anfang).
Mit dem Imager schreibst du das System und stellst vorab ein (Zahnrad bzw.
„Einstellungen bearbeiten“):

- Hostname, etwa `tybo-pi`
- Benutzername und Passwort
- WLAN (falls kein Kabel), Land für WLAN, Zeitzone
- **SSH aktivieren**, am besten mit deinem öffentlichen SSH-Schlüssel

Wie das System auf die SSD kommt, hängt davon ab, was du da hast. Beide Wege
sind nicht in der VM geprüft; maßgeblich ist die
[offizielle Dokumentation des Raspberry Pi](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html)
(Abschnitte zu NVMe und zur Startreihenfolge) und die Anleitung deines HATs.

- **Mit USB-Adapter für die SSD (einfachster Weg):** SSD in den Adapter,
  Adapter an den Laptop, im Imager die SSD als Ziel wählen und schreiben.
  Danach die SSD in den HAT am Pi, keine Speicherkarte einlegen, einschalten.
  Ein Pi 5 mit aktueller Firmware startet ohne Speicherkarte von der SSD.
- **Ohne Adapter:** Erst mit dem Imager auf eine microSD-Karte schreiben
  (gleiche Einstellungen), davon starten und per SSH anmelden (Schritt 2).
  Dann Firmware aktualisieren und die SSD als Startlaufwerk einstellen, danach
  das System auf die SSD bringen, wie es die offizielle Anleitung beschreibt
  (etwa mit dem Imager über die Netzwerk-Installation des Pi 5, dafür braucht
  es einmal Bildschirm und Tastatur).

*Prüfstand: nicht in der VM geprüft (Pi-Hardware).*

```bash
sudo rpi-eeprom-update -a      # Firmware aktualisieren, danach sudo reboot
sudo raspi-config              # Advanced Options, Boot Order, NVMe/USB Boot
```

Manche HATs, die nicht nach dem offiziellen HAT+-Standard gebaut sind,
brauchen zusätzlich eine Zeile in `/boot/firmware/config.txt`; das steht dann
in der Anleitung des HATs.

### 2. Per SSH anmelden

Vom Laptop aus, mit dem Hostnamen und Benutzer aus dem Imager:

*Prüfstand: nicht in der VM geprüft (Namensauflösung `.local` im Heimnetz).*

```bash
ssh <benutzer>@tybo-pi.local
```

Findet der Laptop den Namen nicht, nimm die IP-Adresse des Pi aus deinem
Router.

Danach die Werkzeuge holen, die der Installer braucht. Im Debian-Cloud-Image
der VM fehlten `git` und `unzip`; ob Raspberry Pi OS Lite sie schon
mitbringt, ist nicht geprüft. Der Befehl schadet nicht, wenn sie da sind.

*Prüfstand: in der VM geprüft (`apt-get update` und `apt-get install` für git und unzip, Lauf 1 und 2); curl brachte das Image schon mit, seine Installation lief also nicht.*

```bash
sudo apt-get update
sudo apt-get install -y git curl unzip
```

Dann das System auf den neuesten Stand bringen:

*Prüfstand: nicht in der VM geprüft.*

```bash
sudo apt-get full-upgrade -y
```

### 3. Claude CLI installieren und anmelden

tybo arbeitet über die Claude CLI. Auf dem Pi empfehlen wir den **nativen
Installer** von Anthropic: er braucht weder Node.js noch `sudo`, aktualisiert
sich selbst und legt `claude` in `~/.local/bin` ab.

*Prüfstand: in der VM geprüft (Claude Code 2.1.283, ohne Node, ohne sudo, Lauf 1 und 2).*

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Dann **die SSH-Sitzung beenden und neu anmelden**. Erst in einer neuen
Anmeldung ist `~/.local/bin` im `PATH`, und `claude` wird gefunden.

*Prüfstand: nicht in der VM geprüft (Anmeldung an `tybo-pi.local`).*

```bash
exit
ssh <benutzer>@tybo-pi.local
```

*Prüfstand: in der VM geprüft (`--version` nach neuer Anmeldung).*

```bash
claude --version
```

Jetzt einmal anmelden. Der Pi hat keinen Browser: `claude` zeigt einen Link,
den du auf dem Laptop oder Handy öffnest; dort meldest du dich mit deinem
Claude-Konto an und gibst den angezeigten Code im Terminal ein.

*Prüfstand: nicht in der VM geprüft (die VM hatte keine Claude-Anmeldung).*

```bash
claude          # dann /login, Link auf einem anderen Gerät öffnen
```

Mit einem eigenen `ANTHROPIC_API_KEY` statt Abo geht es auch; den trägst du
später in die `.env` ein.

**Warum nicht über npm?** Der früher genannte Weg
`npm install -g @anthropic-ai/claude-code` ist auf Raspberry Pi OS Bookworm
umständlich: Debian liefert Node.js 18, die Claude CLI verlangt Node.js 22
(sie lief in der VM nur mit Warnung), `npm install -g` braucht `sudo`, und
das automatische Update geht dann nicht. *Prüfstand: in der VM geprüft (ohne
`sudo` EACCES, mit `sudo` Claude Code 2.1.283 mit Warnung EBADENGINE, Lauf 1).*
Node.js brauchst du auf dem Pi nur, wenn du PM2 oder Convex nutzt, siehe
[PM2 statt systemd](#pm2-statt-systemd).

### 4. tybo installieren

Der Installer prüft Git und Bun, installiert Bun (mit Rückfrage), holt tybo
nach `~/tybo`, installiert die Pakete und legt den Befehl `tybo` an. Danach
startet er gleich den Assistenten (Schritt 5).

*Prüfstand: nicht in der VM geprüft in dieser Form (Rückfrage zu Bun und Start des Assistenten aus dem Installer); in der VM lief derselbe Installer mit `--no-setup --yes`, siehe unten.*

```bash
curl -fsSL https://tybo.ai/install | sh
```

Lieber in zwei Etappen, etwa weil die Installation lange dauert? Dann nur
installieren (`--yes` installiert Bun ohne Rückfrage):

*Prüfstand: in der VM geprüft (Lauf 1 und 2, rc 0, gut 5 Minuten).*

```bash
curl -fsSL https://tybo.ai/install | sh -s -- --no-setup --yes
```

Danach neu anmelden, damit `bun` und `tybo` im `PATH` sind:

*Prüfstand: nicht in der VM geprüft (Anmeldung an `tybo-pi.local`; in der VM fand eine neue interaktive Shell `bun` und `tybo`).*

```bash
exit
ssh <benutzer>@tybo-pi.local
```

Und den Assistenten starten (Schritt 5):

*Prüfstand: nicht in der VM geprüft (in der VM lief nur `tybo setup voraussetzungen`, siehe Schritt 5).*

```bash
tybo setup
```

Worauf du achten solltest:

- **Dauer.** In der VM dauerte die Installation gut 5 Minuten, fast alles
  davon ein einzelner hängender Download in `bun install` (*Prüfstand: in der
  VM geprüft, Lauf 1 und 2*). Ob das am Pi auch so ist, ist nicht geprüft.
  Siehe [Fehlerbehebung](#fehlerbehebung).
- **Hinweise am Ende.** Der Bun-Installer trägt Bun meist selbst in
  `~/.bashrc` ein. Findet der tybo-Installer dort einen Eintrag, empfiehlt er
  eine neue SSH-Sitzung (oder `source ~/.bashrc`), ohne zu versprechen, dass
  es damit sicher klappt, und nennt die zwei Zeilen als Rückfall, falls
  `tybo` danach trotzdem fehlt. Steht nirgends ein Eintrag, nennt er nur die
  zwei Zeilen. Node.js nennt
  er nur noch mit dem Zusatz, wofür es gebraucht wird (PM2, Convex, npm);
  auf dem Pi mit systemd kannst du das übergehen. Liegt `claude` schon in
  `~/.local/bin`, verweist er auf eine neue Sitzung statt auf eine
  Installation. *Prüfstand: nicht in der VM geprüft (mit Test-Attrappen in
  `tests/install-sh.test.ts` geprüft).*
- **Platz sparen bei älteren Installationen.** Frühere tybo-Versionen
  luden bei der Installation einen Chrome-Browser für x86-64 (652 MB) nach
  `~/.cache/puppeteer`, der auf dem Pi nicht läuft und von tybo nicht
  gebraucht wird. Eine neue Installation macht das nicht mehr. Hast du vorher
  installiert und nutzt kein anderes Programm auf dem Pi Puppeteer, kannst du
  den Ordner löschen:

  *Prüfstand: nicht in der VM geprüft (das Löschen selbst; Ordner und Größe in Lauf 1 festgestellt).*

  ```bash
  rm -rf ~/.cache/puppeteer
  ```

### 5. tybo setup

Der Assistent fragt Schritt für Schritt: Voraussetzungen, Telegram, Forum-Gruppe,
Datenbank, Suche, Profil, Modelle, WebUI, Autostart. Alle Felder beschreibt
[einrichtung.md](einrichtung.md#die-schritte). Für den Pi:

- **Im Terminal einrichten**, also direkt in der SSH-Sitzung. Das ist der
  einfachste Weg.
- **Datenbank:** „Supabase in der Cloud“ (Standard). Supabase auf dem Pi
  selbst braucht Docker und PM2 und ist auf dem Pi nicht geprüft.
- **Semantische Suche:** mit einem Schlüssel von OpenAI oder Gemini, nicht
  mit Ollama (siehe [Grenzen](#wofür-und-wofür-nicht)).
- **WebUI:** Für das Handy im Heimnetz bei „Erreichbar von“ die Wahl
  „Heimnetz“. Die Adresse ist dann `http://<IP-des-Pi>:3100`.
- **Autostart:** siehe nächster Schritt.

*Prüfstand: nicht in der VM geprüft (kein Telegram-Token, keine Schlüssel).*

```bash
tybo setup                     # alles der Reihe nach
```

*Prüfstand: in der VM geprüft (Bun, Claude CLI, Git erkannt; fehlende Claude-Anmeldung korrekt gemeldet; Lauf 2b).*

```bash
tybo setup voraussetzungen     # nur die Voraussetzungen prüfen
```

**Einrichtung im Browser vom Laptop aus.** Der Assistent im Browser (Schalter
`--web`) lauscht nur auf dem Pi selbst (`127.0.0.1`). Vom Laptop kommst du per
SSH-Tunnel dran, mit **demselben Port auf beiden Seiten**. Auf dem Laptop:

*Prüfstand: in der VM geprüft mit Port 3177 statt 3100 und der Adresse der VM statt `tybo-pi.local` (Einrichtungsseite erreichbar; anderer lokaler Port ergibt „421 Misdirected Request“).*

```bash
ssh -L 3100:127.0.0.1:3100 <benutzer>@tybo-pi.local
```

In dieser SSH-Sitzung auf dem Pi den Assistenten im Browser starten:

*Prüfstand: nicht in der VM geprüft (in den VM-Befunden ist nicht festgehalten, ob hinter dem Tunnel dieser Befehl oder der Einrichtungsmodus des Bot-Diensts lief).*

```bash
tybo setup --web
```

Dann auf dem Laptop `http://127.0.0.1:3100` öffnen. Den Einmal-Code zeigt das
Terminal. Ist Port 3100 auf dem Laptop belegt, änderst du beide Seiten, auf
dem Laptop:

*Prüfstand: in der VM geprüft mit der Adresse der VM statt `tybo-pi.local`.*

```bash
ssh -L 3177:127.0.0.1:3177 <benutzer>@tybo-pi.local
```

und in dieser Sitzung auf dem Pi:

*Prüfstand: nicht in der VM geprüft (in der VM war `WEB_PORT=3177` gesetzt; nicht festgehalten ist, ob für diesen Befehl oder für den Bot-Dienst).*

```bash
WEB_PORT=3177 tybo setup --web
```

### 6. Autostart per systemd

Im Schritt Autostart schlägt der Assistent auf dem Pi einen
**systemd-Benutzerdienst** vor (`tybo-telegram-relay`); Enter nimmt den
Vorschlag. Er legt `~/.config/systemd/user/tybo-telegram-relay.service` an,
mit eigenem `PATH` (Bun und `~/.local/bin`), `Restart=always` und dem
Protokoll in `~/tybo/logs/`. Einzeln aufrufen:

*Prüfstand: nicht in der VM geprüft (der Assistent kam nach dem VM-Test; in der VM lief ein von Hand angelegter Dienst derselben Bauart und startete nach einem Neustart ohne Anmeldung).*

```bash
tybo setup autostart
```

**Linger** sorgt dafür, dass der Dienst nach einem Neustart des Pi startet,
ohne dass sich jemand anmeldet. Der Assistent schaltet es ohne `sudo` ein,
wenn das System es erlaubt (in der VM ging das). Sonst nennt er genau einen
Befehl:

*Prüfstand: nicht in der VM geprüft (in der VM lief `loginctl enable-linger $USER` ohne sudo, rc 0).*

```bash
sudo loginctl enable-linger $USER      # nur, wenn der Assistent es verlangt
```

Danach den Autostart noch einmal:

*Prüfstand: nicht in der VM geprüft (der Assistent kam nach dem VM-Test).*

```bash
tybo setup autostart
```

Nachsehen, ob Linger an ist:

*Prüfstand: in der VM geprüft (Anzeige `Linger=yes`).*

```bash
loginctl show-user $USER -p Linger     # erwartet: Linger=yes
```

Den Befehl für Benutzerdienste (`systemctl --user`) rufst du immer als dein
Benutzer auf, **nie mit `sudo`**: unter `sudo` fehlt die Laufzeitumgebung des
Benutzers (`XDG_RUNTIME_DIR`), der Benutzerdienst antwortet dann nicht.
*Prüfstand: in der VM geprüft, dass `systemctl --user` in der SSH-Sitzung
läuft und `XDG_RUNTIME_DIR` dort gesetzt ist; der Aufruf mit `sudo` nicht in
der VM geprüft.*

### 7. Neustart-Test

Erst wenn tybo einen Neustart des Pi übersteht, ist er wirklich „rund um die
Uhr“. Den Test machst du selbst:

1. Den Pi neu starten (erster Befehl unten). Die SSH-Verbindung bricht ab.
2. **Nicht wieder per SSH anmelden.** Eine Anmeldung würde einen fehlenden
   Linger verdecken.
3. Zwei Minuten warten, dann in Telegram deinem Bot schreiben, etwa „Bist du
   wieder da?“.
4. Erwartet: tybo antwortet wie gewohnt.
5. Erst jetzt per SSH anmelden und nachsehen (zweiter Block unten).

*Prüfstand: nicht in der VM geprüft (die VM wurde neu gestartet, der Befehl dafür ist in den Befunden nicht festgehalten).*

```bash
sudo reboot
```

*Prüfstand: nicht in der VM geprüft (Anmeldung an `tybo-pi.local`, Dienst des Assistenten kam nach dem VM-Test).*

```bash
# nach der Antwort in Telegram, vom Laptop:
ssh <benutzer>@tybo-pi.local
systemctl --user status tybo-telegram-relay    # erwartet: active (running)
```

Antwortet tybo nicht, siehe [Fehlerbehebung](#fehlerbehebung).

## Betrieb

### Aktualisieren

Den Installer noch einmal ausführen. Er holt den neuesten Stand (nur
Vorspulen, `--ff-only`) und installiert die Pakete neu; den Assistenten startet
er dabei nicht, und den laufenden Bot startet er **nicht** neu. Danach selbst
neu starten.

*Prüfstand: nicht in der VM geprüft (der zweite Lauf des Installers und der Neustart über systemd liefen dort nicht).*

```bash
curl -fsSL https://tybo.ai/install | sh
systemctl --user restart tybo-telegram-relay
```

Von Hand geht dasselbe so; nur den Code zu holen reicht nicht, die Pakete
können sich geändert haben:

*Prüfstand: nicht in der VM geprüft.*

```bash
cd ~/tybo
git pull --ff-only
bun install --frozen-lockfile
systemctl --user restart tybo-telegram-relay
```

Aus einem Gespräch mit tybo heraus (also wenn tybo selbst den Neustart
anstoßen soll) nie direkt über systemd neu starten, sondern einen Neustart
anfordern: tybo beendet sich nach der laufenden Antwort, systemd startet ihn
neu.

*Prüfstand: nicht in der VM geprüft (in der VM lief ein von Hand angelegter Dienst; belegt ist nur, dass systemd den Bot nach `kill -TERM` neu startet).*

```bash
bun run restart:request "Update"
```

### Protokoll

Das Protokoll steht in Dateien, nicht im Journal: `journalctl --user` zeigte
in der VM nichts, weil der Benutzer nicht in der Gruppe `adm` bzw.
`systemd-journal` war. *Prüfstand: in der VM geprüft (keine Einträge bzw.
„insufficient permissions“, Lauf 1 und 2).*

*Prüfstand: nicht in der VM geprüft (die Protokolldateien legt der Dienst des Assistenten an, der nach dem VM-Test kam).*

```bash
tail -f ~/tybo/logs/telegram-relay.log          # laufend mitlesen
tail -50 ~/tybo/logs/telegram-relay.error.log   # Fehler
systemctl --user status tybo-telegram-relay     # läuft der Dienst?
```

### Arbeitsspeicher

tybo richtet die Zahl gleichzeitiger Aufträge nach dem Arbeitsspeicher: unter
3 GiB 1, unter 6 GiB 2, sonst 3. Ein Pi mit 4 GB meldet etwa 3,8 GiB und
bekommt 2, einer mit 8 GB (etwa 7,8 GiB) bekommt 3. Die Zeile
`[agents] Gleichzeitige Aufträge: …` im Protokoll zeigt den Wert. Eine eigene
Zahl setzt `MAX_AGENT_PROCESSES` in der `.env`.

In der VM brauchte der Bot im Leerlauf rund 85 MB, ein Claude-Aufruf bis zur
Meldung „nicht angemeldet“ rund 230 MB. Wie viel ein echter Auftrag mit
Werkzeugen braucht, ist nicht gemessen. Wird es auf einem 4-GB-Pi eng, setzt
du `MAX_AGENT_PROCESSES=1`. Raspberry Pi OS richtet eine Auslagerungsdatei
ein; wie sie sich unter Last verhält, ist nicht geprüft.

*Prüfstand: nicht in der VM geprüft (in den VM-Befunden stehen nur die Speicherwerte, nicht der Befehl, mit dem sie gemessen wurden).*

```bash
free -m      # Spalte "available": freier Arbeitsspeicher
```

### Stromkosten

Rechnung mit **5 Watt als Annahme** (nicht am Pi gemessen; unter Last ist es
mehr, das 27-W-Netzteil ist die Obergrenze, nicht der Verbrauch):

0,005 kW × 24 h × 365 Tage = **43,8 kWh im Jahr**

Mal deinen Strompreis. Bei beispielsweise 0,35 € je kWh sind das rund
**15,30 € im Jahr**. Genau misst du mit einem Zwischenstecker-Messgerät.

### Sicherung

Zwei Dinge sind zu sichern, und sie liegen an verschiedenen Orten:

1. **Auf dem Pi:** die `.env` (alle Schlüssel und Tokens), `config/` (Profil,
   Agenten-Anpassungen, Einstellungen der WebUI) und `data/` (Ziele,
   Sessions, Zustand). Am einfachsten vom Laptop aus kopieren; die Kopie
   enthält Schlüssel, bewahre sie entsprechend geschützt auf.

   *Prüfstand: nicht in der VM geprüft.*

   ```bash
   mkdir -p tybo-sicherung
   scp <benutzer>@tybo-pi.local:tybo/.env tybo-sicherung/
   scp -r <benutzer>@tybo-pi.local:tybo/config tybo-sicherung/
   scp -r <benutzer>@tybo-pi.local:tybo/data tybo-sicherung/
   ```

2. **Die Datenbank:** Mit Supabase in der Cloud liegen Verlauf und Gedächtnis
   bei Supabase. Was Supabase selbst sichert, hängt vom Tarif ab; das
   Dashboard zeigt es. `tybo datenbank sichern` gilt nur für Supabase auf
   diesem Rechner (siehe [Supabase lokal im Alltag](einrichtung.md#supabase-lokal-im-alltag)),
   nicht für die Cloud. *Prüfstand: nicht in der VM geprüft.*

Den Pi selbst musst du nicht sichern: nach einem Totalausfall richtest du
ihn nach dieser Anleitung neu ein und legst `.env`, `config/` und `data/`
zurück nach `~/tybo/`.

### PM2 statt systemd

Wer lieber PM2 nutzt, wählt es im Schritt Autostart (Auswahl 2). PM2 braucht
Node.js und einen eigenen Systemdienst, damit es einen Neustart übersteht.
Node.js 22 kommt über NodeSource, die Node-Version aus Debian (18) ist zu alt:

*Prüfstand: in der VM geprüft (Node 22.23.3 über NodeSource, PM2 7.0.4, Lauf 2).*

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

Dann im Assistenten PM2 wählen:

*Prüfstand: nicht in der VM geprüft (in der VM fragte der Assistent vor dem Einbau von systemd nur `[j/N]` für PM2, ohne Auswahl).*

```bash
tybo setup autostart           # Auswahl 2) PM2
```

Und PM2 beim Systemstart einrichten:

*Prüfstand: in der VM geprüft (Dienst `pm2-<benutzer>` übersteht Neustart ohne Anmeldung und ohne Linger, Lauf 2).*

```bash
pm2 startup                    # gibt eine Zeile mit sudo aus: diese ausführen
pm2 save
```

## Fehlerbehebung

Die Spalte Prüfstand gilt für die Meldung und für die genannten Befehle.

| Was du siehst | Was zu tun ist | Prüfstand |
|---|---|---|
| Installer: „Git fehlt. Installieren mit: sudo apt install git …“ | `sudo apt-get install -y git curl unzip`, dann den Installer erneut. | Meldung in der VM geprüft; Installation wie in Schritt 2. |
| Installer: „unzip fehlt, der Bun-Installer braucht bash, curl und unzip …“ | Wie oben. Der Installer nennt fehlende Werkzeuge einzeln, deshalb gleich alle drei installieren. | Meldung in der VM geprüft; Installation wie in Schritt 2. |
| Installer bricht ab mit Hinweis auf `--yes` | Er lief ohne Terminal (etwa über ein Skript). In einer normalen SSH-Sitzung ausführen oder `sh -s -- --yes` anhängen. | in der VM geprüft (Abbruch ohne Terminal; `--yes` in Lauf 1 und 2). |
| Installation hängt minutenlang bei „installiere Pakete“ | In der VM wartete `bun install` rund 260 s auf einen einzigen Download. Abwarten, oder abbrechen und mit weniger parallelen Downloads fortsetzen: `cd ~/tybo && bun install --frozen-lockfile --network-concurrency 8 && bun link`. | Hänger in der VM geprüft; der Befehl in dieser Form nicht in der VM geprüft (dort lief nur `bun install --network-concurrency 8`). |
| `tybo: command not found` direkt nach der Installation | Neue SSH-Sitzung öffnen (oder `source ~/.bashrc`). Der Bun-Installer hat den `PATH` in `~/.bashrc` eingetragen. | Neue Sitzung in der VM geprüft; `source ~/.bashrc` nicht in der VM geprüft. |
| `/usr/bin/env: 'bun': No such file or directory` | Wie oben: `bun` ist in dieser Sitzung noch nicht im `PATH`. | Meldung in der VM geprüft. |
| `tybo` fehlt bei `ssh <pi> tybo …` (Befehl direkt hinter ssh) | Ohne interaktive Shell liest Bash `~/.bashrc` nicht zu Ende. Erst per SSH anmelden, dann in der Sitzung `tybo` aufrufen. | in der VM geprüft mit `bash -lc 'command -v tybo'` statt `ssh`. |
| `tybo setup`: „Claude CLI liegt in ~/.local/bin, das ist noch nicht im PATH: neue Sitzung öffnen.“ | Nichts neu installieren, neu per SSH anmelden. Ältere tybo-Versionen meldeten hier „Claude CLI nicht gefunden.“ mit einem npm-Befehl; auch dann genügt die neue Anmeldung. | Neue Meldung nicht in der VM geprüft (mit Test-Attrappen in `tests/setup-prereq-autostart.test.ts`); alte Meldung in der VM geprüft (Lauf 2b); neue Anmeldung wie in Schritt 3. |
| `tybo setup`: „Claude CLI ist nicht angemeldet. …“ | `claude` starten, `/login`, Link auf einem anderen Gerät öffnen. | Meldung in der VM geprüft; die Anmeldung nicht in der VM geprüft. |
| `npm install -g …`: `EACCES` | Globale npm-Pakete brauchen auf Debian `sudo`. Für die Claude CLI stattdessen den nativen Installer nehmen (Schritt 3). | in der VM geprüft. |
| Claude CLI über npm: Warnung `EBADENGINE`, „Can't auto-update“ | Debian-Node 18 ist zu alt, und der globale npm-Ordner gehört root. Auf den nativen Installer wechseln. | in der VM geprüft. |
| Browser: „421 Misdirected Request“ | Der SSH-Tunnel nutzt lokal einen anderen Port als auf dem Pi. Gleiche Portnummer auf beiden Seiten. | in der VM geprüft. |
| Nach dem Neustart antwortet tybo erst, wenn du dich per SSH anmeldest | Linger ist aus. `sudo loginctl enable-linger $USER`, dann `tybo setup autostart`. | nicht in der VM geprüft (siehe Schritt 6). |
| „Der systemd-Benutzerdienst antwortet nicht (systemctl --user). …“ | `tybo setup` als normaler Benutzer in einer SSH-Sitzung starten, nicht über `sudo` oder `su`. | nicht in der VM geprüft (Meldung des Assistenten, der nach dem VM-Test kam). |
| `journalctl --user` zeigt nichts | Normal auf Raspberry Pi OS ohne die Gruppe `adm`. Das Protokoll steht in `~/tybo/logs/`. | Meldung in der VM geprüft; Protokolldateien nicht in der VM geprüft. |
| Autostart läuft, der Bot meldet im Protokoll eine Adresse `http://127.0.0.1:3100` und einen Einmal-Code | Telegram-Token oder Nutzer-ID fehlen in der `.env`; der Bot wartet im Einrichtungsmodus. `tybo setup telegram` ausführen, dann `systemctl --user restart tybo-telegram-relay`. | Einrichtungsmodus als Dienst in der VM geprüft (PM2); `tybo setup telegram` und der Neustart nicht in der VM geprüft. |
| Wenig Platz auf der SSD nach einer älteren Installation | `rm -rf ~/.cache/puppeteer` (652 MB, nur wenn kein anderes Programm Puppeteer nutzt, siehe Schritt 4). | nicht in der VM geprüft (siehe Schritt 4). |

Mehr Fehlerbilder: [einrichtung.md](einrichtung.md#typische-fehler) und
[troubleshooting.md](troubleshooting.md).
