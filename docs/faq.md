# Häufige Fragen

Kurze Antworten auf das, was vor und nach der Einrichtung am häufigsten
gefragt wird. Wenn etwas nicht geht, hilft [Störungen beheben](troubleshooting.md).

---

## Was brauche ich, um tybo zu betreiben?

Einen Rechner, der möglichst immer an ist (Mac, Linux, Raspberry Pi 5 oder
ein Server), dazu Bun, Git und die Claude CLI. Telegram oder die WebUI im
Browser, mindestens eins von beiden. Für das Gedächtnis ein Supabase-Projekt,
in der Cloud oder auf diesem Rechner in Docker; ohne Datenbank liegen
Erinnerungen in einer Datei unter `data/`. Der Installer prüft Git und Bun,
alles Weitere fragt `tybo setup` Schritt für Schritt ab:
[einrichtung.md](einrichtung.md).

---

## Was kostet das, und wie rechnet Claude Code ab?

tybo selbst kostet nichts. Bezahlt wird Claude Code, und dafür gibt es zwei
Wege, die `CLAUDE_AUTH` in der `.env` festlegt:

| Weg | Abrechnung | Passt für |
|---|---|---|
| `subscription` | über dein Claude-Abo | den eigenen Rechner, an dem du angemeldet bist |
| `apiKey` | nach Verbrauch mit `ANTHROPIC_API_KEY` | Server ohne Bildschirm, feste Kosten pro Aufruf |

Ohne Wert nimmt tybo `apiKey`, wenn ein Schlüssel gesetzt ist, sonst das Abo.
Im Abo zählt `/credit` den Verbrauch mit, schützt aber nicht vor dem Limit des
Abos. Was nach Verbrauch zahlt (Ersatzmodelle, Telefonhörer), begrenzt das
Tagesbudget `DAILY_API_BUDGET`. Telegram ist kostenlos; Supabase und
Tailscale haben kostenlose Stufen, die für eine Person in der Regel reichen.

---

## Muss mein Rechner dafür immer laufen?

tybo antwortet nur, solange der Bot läuft. Auf einem Mac, der schläft, kommen
Nachrichten erst nach dem Aufwachen an; eine verpasste Erinnerung kommt dann
als verspätet markiert. Wer tybo rund um die Uhr will, hat drei Wege:

- einen Rechner, der durchläuft, etwa einen Raspberry Pi (nächste Frage);
- einen Server, der durchläuft: wie zu Hause per Polling, ohne öffentliche
  Adresse, oder im Profil `server`, bei dem Telegram jede Nachricht per
  Webhook zustellt (braucht eine öffentliche `https`-Adresse);
- den Hybrid-Betrieb: Der Server nimmt alles an und reicht es an deinen
  Rechner weiter, solange der wach ist, sonst antwortet er selbst.

Server, auch ohne Claude-Konto: [server.md](server.md). Webhook und Hybrid:
[telegram-webhook.md](telegram-webhook.md) und
[erweiterungen.md](erweiterungen.md#server-und-hybrid).

---

## Geht tybo ohne Claude-Konto?

Ja, mit Codex als Motor (ChatGPT-Anmeldung über `codex login`). Chat,
Sessions, Merk-Tags und Ersatzmodelle gehen wie mit Claude Code;
Hintergrund-Jobs gibt es dann nicht, und die Nebenaufgaben (Richter von
`/goal`, offene Fäden, Check-in und weitere) laufen nur mit einem eigenen
Nebenmodell über OpenRouter oder Ollama. Einrichten und die ganze Tabelle:
[server.md](server.md).

---

## Läuft tybo auf einem Raspberry Pi rund um die Uhr?

Ja, auf einem Raspberry Pi 5 mit dem 64-Bit-Raspberry-Pi-OS. Empfohlen sind
8 GB Arbeitsspeicher; mit 4 GB geht es, dann laufen weniger Aufträge
gleichzeitig. tybo läuft dort wie auf dem eigenen Rechner, mit dem Abo oder
einem Schlüssel, startet als systemd-Benutzerdienst und braucht wenig Strom.
Programme und MCP-Server, die es nur auf dem Mac gibt, fehlen dort.
Anleitung Schritt für Schritt: [raspberry-pi.md](raspberry-pi.md).

---

## Geht es ohne Telegram?

Ja. Ohne `TELEGRAM_BOT_TOKEN` und `TELEGRAM_USER_ID` läuft tybo nur mit der
WebUI im Browser: Antworten, Meldungen, Rückfragen und Erinnerungen kommen
dann dort an, auf dem Handy als Push. Von unterwegs erreichst du die WebUI
über Tailscale oder einen Cloudflare Tunnel (`tybo setup zugang`). Dazu gibt
es den Chat im Terminal mit `tybo`. Telegram lässt sich später mit
`tybo setup telegram` dazunehmen.

---

## Was passiert mit meinen Daten?

Gespräche, Fakten und Ziele liegen in deinem eigenen Supabase-Projekt oder in
Dateien auf deinem Rechner, nicht bei tybo. Zum Antworten gehen die
Nachrichten samt passendem Gedächtnis an das Modell, das du eingestellt hast,
also an Anthropic über Claude Code oder an einen anderen Motor. Ersatzmodelle
über OpenRouter oder Ollama auf dem eigenen Rechner wählst du selbst.
Schlüssel aus der `.env` bekommen die Subprozesse nur, wenn du sie freigibst.

---

## Kann ich statt Claude ein anderes Modell nehmen?

Ja, auf zwei Ebenen. Der Motor, der eine Antwort schreibt, ist wählbar:
Claude Code (Standard), Codex oder OpenCode, als Standard in den
Einstellungen oder je Gespräch mit `/motor`. Fällt der Motor aus, springen
Ersatzmodelle ein, etwa über OpenRouter oder Ollama (`tybo setup modelle`).
Was bei Codex und OpenCode einzurichten ist, steht in
[Störungen beheben](troubleshooting.md#codex-als-motor).

---

## Wie bekomme ich Updates?

Mit demselben Befehl wie bei der Installation:
`curl -fsSL https://tybo.ai/install | sh`. Er holt den neuen Stand in den
vorhandenen Ordner, lässt `.env`, `config/` und `data/` in Ruhe und ändert
nichts, wenn du Dateien im Ordner selbst geändert hast. Bringt das Update
neue Tabellen mit (der Installer sagt es am Ende), vorher `tybo setup
datenbank` ausführen; in der Cloud braucht das ein frisches Zugangstoken,
Supabase auf diesem Rechner holt es beim nächsten `tybo datenbank start`
selbst nach. Danach den Bot neu starten, in der WebUI mit „Neustart
anfordern“. Vergessen ist nicht schlimm: Der Bot prüft beim Start, ob
Migrationen fehlen, und meldet sich dann einmal; `tybo pruefen` zeigt es in
der Zeile „Schema“. Was sich geändert hat, steht in
[CHANGELOG.md](../CHANGELOG.md).

---

## Mehr

- [Einrichtung](einrichtung.md)
- [Erweiterungen](erweiterungen.md)
- [Störungen beheben](troubleshooting.md)
- [Architektur](architecture.md)
