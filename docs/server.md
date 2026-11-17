# Server und Codex

Diese Seite ist der Wegweiser für tybo auf einem Rechner, der rund um die
Uhr läuft, etwa einem Linux-Server, und für tybo ohne Claude-Konto mit Codex
als Motor. Beides geht getrennt: ein Server mit Claude Code ebenso wie Codex
auf dem eigenen Rechner.

## Server heißt nicht Webhook

„Server“ meint hier nur: ein Rechner, der durchläuft. tybo holt seine
Nachrichten dort genauso ab wie zu Hause, per Polling (`TYBO_PROFILE=local`,
der Standard). Dafür braucht es **keine öffentliche Adresse**, keinen
Reverse-Proxy und keinen offenen Port.

Das Profil `server` ist etwas anderes: Telegram stellt dann jede Nachricht
per Webhook zu, und dafür braucht der Rechner eine öffentliche
`https`-Adresse. Nötig ist das nur für den Hybrid-Betrieb (Server und
eigener Rechner teilen sich die Arbeit). Beides steht in
[telegram-webhook.md](telegram-webhook.md) und
[erweiterungen.md](erweiterungen.md#server-und-hybrid).

Die WebUI bleibt auch auf einem Server nur im eigenen Netz erreichbar; vom
Handy aus geht es über Tailscale oder einen Cloudflare Tunnel mit Anmeldung
(Schritt „Zugang vom Handy“ in [einrichtung.md](einrichtung.md)).

## Ohne Claude-Konto: Codex als Motor

Wer kein Claude-Abo und keinen Anthropic-Schlüssel will, nimmt Codex mit
der ChatGPT-Anmeldung.

1. tybo installieren wie in [einrichtung.md](einrichtung.md), dazu Codex:
   ```bash
   npm install -g @openai/codex
   codex login
   ```
   Liegt `codex` nicht im `PATH`, den Pfad als `CODEX_PATH` in die `.env`
   schreiben.
2. `tybo setup` starten. Bei einem frischen Lauf gilt zunächst Claude Code
   als Motor; fehlt Claude, scheitert der Schritt „Voraussetzungen“. Dort
   „überspringen“ wählen. Der Schritt „Modelle und Fallback“ kommt dann
   gleich als nächster.
3. Im Schritt „Modelle und Fallback“ bei **Motor** „Codex“ wählen. Der Test
   prüft, ob Codex installiert und angemeldet ist. Gespeichert wird der
   Motor in `config/settings.json` (`engine.default`); er gilt vor
   `TYBO_ENGINE` aus der `.env`.
4. Die übrigen Schritte wie gewohnt. Unter Linux richtet „Autostart“ einen
   systemd-Benutzerdienst ein; dessen `PATH` enthält auch den Ordner von
   Codex (aus `CODEX_PATH` oder dort, wo `codex` gefunden wurde).
5. Am Ende prüft die Gesamtprüfung die Voraussetzungen mit Codex noch
   einmal. Fehlt nur Claude, ist das ein Hinweis und kein Fehler:
   „Claude ist nicht angemeldet: Hintergrund-Jobs und Nebenaufgaben laufen
   nicht.“ Fehlt Codex oder ist es nicht angemeldet, ist die Einrichtung
   nicht fertig.

Schon eingerichtet? Dann reicht `tybo setup modelle` oder in der WebUI
Einstellungen, Reiter Agenten, Motor.

## Was mit welchem Motor geht

| Was | Claude Code | Codex ohne Claude |
|---|---|---|
| Chat in Telegram, WebUI und Terminal | ja | ja |
| Fortlaufende Sessions je Gespräch, Fortschritt, Merk-Tags, `/stop` | ja | ja |
| Destillat beim Ende einer Session, `/routine` | ja | ja, über Codex |
| Modell je Agent | ja | nein, ein Modell und Effort für Codex |
| MCP-Server und Skills | aus der Konfiguration von Claude Code | aus der Konfiguration von Codex |
| Hooks | ja | nein |
| Hintergrund-Jobs (`bun run job start`) | ja | nein, die Job-Regel fehlt dann im Prompt |
| Nebenaufgaben (siehe unten) | ja | nur mit eigenem Nebenmodell über OpenRouter oder Ollama |
| Check-in | ja | nur mit `AUX_MODEL_CHECKIN` |
| Morgenbriefing, Erinnerungen, offene Fäden anzeigen | ja | ja |
| Ersatzmodelle (OpenRouter, Ollama), wenn der Motor ausfällt | ja | ja |
| WhatsApp | ja | nein, läuft immer über Claude Code |
| Telefonhörer | ja | nur über Anthropic-Schlüssel, OpenRouter oder Ollama |

Fällt Codex aus (nicht angemeldet, nicht erreichbar), springt
normalerweise Claude Code ein. Fehlt Claude, antworten die Ersatzmodelle,
wenn sie eingerichtet sind.

## Nebenaufgaben ohne Claude

Acht kleine Aufgaben laufen neben dem Chat auf einem eigenen, meist
billigen Modell. Ohne Einstellung ist das Claude:

| Nebenaufgabe | Variable |
|---|---|
| Richter von /goal | `AUX_MODEL_JUDGE` |
| Destillat (`/kern`, Sessions von Claude Code) | `AUX_MODEL_DISTILL` |
| Review (`/learn`) | `AUX_MODEL_REVIEW` |
| offene Fäden | `AUX_MODEL_THREADS` |
| Anruf-Zusammenfassung | `AUX_MODEL_CALL_SUMMARY` |
| Check-in | `AUX_MODEL_CHECKIN` |
| Auswertung von Übungsgesprächen | `AUX_MODEL_VOICE_TRAINING` |
| Wizard für Sprachagenten | `AUX_MODEL_VOICE_WIZARD` |

Fehlt Claude, prüft tybo das beim Start einmal und schreibt genau eine
Zeile ins Log, etwa:

```text
[Claude] Claude CLI nicht installiert: Hintergrund-Jobs sind abgeschaltet. Abgeschaltet, weil sie über Claude liefen: Richter von /goal, …
```

Die genannten Nebenaufgaben sind dann abgeschaltet: Sie scheitern nicht bei
jeder Antwort, offene Fäden werden nicht erkannt, der Check-in schickt
nichts, und ein Ziel mit `/goal` pausiert nach dem ersten Schritt mit dem
Grund. Nach einem Anruf kommt statt der Zusammenfassung der Anfang des
Protokolls mit dem Grund, nach einem Übungsgespräch eine Meldung ohne
Auswertung; tybo versucht es dann nicht erneut. Abgeschaltet wird nur, wenn
die Prüfung sicher sagt, dass `claude` fehlt oder nicht angemeldet ist. Bei
einem Zeitlimit oder einem anderen Fehler der Prüfung bleibt alles an.
Einschalten mit einem anderen Nebenmodell, in der `.env`:

```bash
AUX_MODEL_JUDGE=openrouter:<anbieter>/<modell>   # braucht OPENROUTER_API_KEY
AUX_MODEL_THREADS=ollama:<modell>                # Ollama auf diesem Rechner
```

oder in der WebUI unter Einstellungen, Modelle. Die Einstellungen der WebUI
gelten vor der `.env`. Was über OpenRouter oder Ollama läuft, nennt die
Logzeile unter „Laufen weiter“. Das Destillat einer Codex-Session läuft
immer über Codex und braucht keine Einstellung.

Wird Claude später angemeldet, gilt das ab dem nächsten Start des Bots.
