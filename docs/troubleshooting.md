# Troubleshooting

> This document covers common issues, their solutions, debugging commands,
> log file locations, and how to report problems.

---

## Setup Issues

### Installation mit einem Befehl

Meldungen von `curl -fsSL https://tybo.ai/install | sh` und was hilft. Der
Installer schreibt jede Meldung mit `tybo:` davor; `…` steht für Ordner und
Programmnamen, die je nach Rechner anders lauten. Vor dem Holen von tybo kann
er nach deinem Ja schon Bun installieren oder mit `bun upgrade` aktualisieren;
der offizielle Bun-Installer trägt Bun dabei auch in deine Shell-Startdatei
ein. Das nimmt der Installer bei einem späteren Fehler nicht zurück. Derselbe
Befehl kann nach der Abhilfe trotzdem einfach noch einmal laufen und findet
das vorhandene Bun. Anleitung: [einrichtung.md](einrichtung.md#schnellweg-ein-befehl).

#### `tybo: command not found` nach der Installation

**Symptom:** `tybo: command not found` (bash) bzw. `zsh: command not found: tybo`.
Das meldet die Shell, nicht der Installer.

**Meldung:** `tybo: …/bin ist nicht im PATH, der Befehl tybo wird sonst nicht gefunden.`

**Abhilfe:** `bun link` legt `tybo` in `~/.bun/bin` ab, und dieser Ordner
fehlt im `PATH`. Die zwei Zeilen, die der Installer darunter ausgibt, in
`~/.zshrc` (zsh, macOS) bzw. `~/.bashrc` (bash, Linux) eintragen und ein
neues Terminal öffnen. Hat gerade erst der Bun-Installer Bun eingerichtet,
reicht oft schon ein neues Terminal, weil er die Startdatei selbst ergänzt.
Bis dahin geht es im Projektordner mit `bun run setup` statt `tybo setup`.

#### Lokale Änderungen, nichts geändert

**Meldung:** `tybo: lokale Änderungen in …, nichts geändert. Anzeigen mit: cd … && git status`

**Abhilfe:** Beim Aktualisieren hat der Zielordner geänderte, von Git
verwaltete Dateien. Der Installer überschreibt sie nicht. Mit `git status`
nachsehen, was geändert ist, die Änderungen sichern oder mit
`git restore <datei>` verwerfen, dann den Befehl erneut ausführen. Die `.env`
und `config/profile.md` zählen nicht dazu, die verwaltet Git nicht.

Verwandt, gleiche Abhilfe nach Anzeige:

**Meldung:** `tybo: … weicht vom Stand auf origin/… ab (eigene Commits), nichts geändert.`

**Meldung:** `tybo: … steht auf Branch …, nicht auf …, nichts geändert.`

#### Gehört nicht zu tybo

**Meldung:** `tybo: … gehört nicht zu tybo, nichts geändert. Einen anderen Ordner wählen: --dir <pfad>`

**Abhilfe:** Den Zielordner (Standard `~/tybo`) gibt es schon, aber er ist
kein Klon von tybo: eine Datei, ein Ordner mit anderem Inhalt, ein
Unterordner eines anderen Git-Repos oder ein Klon eines anderen Repos. Der
Installer fasst ihn nicht an. Einen anderen Ordner wählen:

```bash
curl -fsSL https://tybo.ai/install | sh -s -- --dir ~/apps/tybo
```

Beim Aktualisieren denselben Ordner angeben wie bei der ersten Installation.

#### Kein Terminal: Einrichtung startet nicht

**Meldung:** `tybo: tybo ist installiert. Weiter mit: cd … && tybo setup`

**Abhilfe:** Ohne Terminal für Rückfragen (etwa per `ssh` ohne `-t`, in
einem Skript oder einer CI) installiert der Installer, startet aber den
Assistenten nicht. Die Einrichtung dann in einem normalen Terminal von Hand
starten, mit dem Befehl aus der Meldung. Dasselbe gilt, wenn der Assistent
abgebrochen wurde:

**Meldung:** `tybo: Einrichtung nicht abgeschlossen. Später weiter mit: cd … && tybo setup`

Fehlt außerdem Bun, kann der Installer ohne Terminal nicht fragen:

**Meldung:** `tybo: Bun fehlt oder ist zu alt, und ohne Terminal kann ich nicht fragen.`

Dann Bun selbst installieren (`curl -fsSL https://bun.sh/install | bash`) oder
den Installer mit `--yes` starten (`… | sh -s -- --yes`).

#### Linux ohne `unzip`

**Meldung:** `tybo: … fehlt, der Bun-Installer braucht bash, curl und unzip.`

**Abhilfe:** Der offizielle Bun-Installer braucht `unzip`, das auf schlanken
Linux-Systemen oft fehlt. Nachinstallieren, etwa `sudo apt install unzip`
(Debian, Ubuntu) oder `sudo dnf install unzip` (Fedora), dann den Befehl
erneut ausführen.

#### Firmen-Proxy oder gesperrter Download

**Symptom:** `curl` meldet einen Fehler, bevor der Installer etwas ausgibt,
oder eine der folgenden Meldungen erscheint:

**Meldung:** `tybo: Bun-Installer ließ sich nicht laden (…). Internetverbindung prüfen und erneut versuchen.`

**Meldung:** `tybo: git clone ist fehlgeschlagen. Internetverbindung prüfen und erneut versuchen.`

**Abhilfe:** Der Installer umgeht keinen Proxy. Braucht dein Netz einen,
die Adresse bei der IT erfragen und vorher setzen (`curl` und `git` lesen
sie), etwa `export HTTPS_PROXY=http://proxy.example:8080`. Um das Skript vor
dem Ausführen anzusehen, es erst herunterladen, lesen und nur nach
erfolgreichem Download starten:

```bash
curl -fsSL https://tybo.ai/install -o install.sh
less install.sh
sh install.sh
```

Optionen gehen dabei direkt dahinter, etwa `sh install.sh --dir ~/apps/tybo`.
Lässt sich gar nichts laden, bleibt der Weg von Hand in
[einrichtung.md](einrichtung.md#von-hand-einrichten).

---

### Bun Not Found After Installation

**Symptoms:** Running `bun install` returns "command not found" after installing Bun.

**Fix:** Bun installs to `~/.bun/bin/` which may not be in your shell's PATH. Either restart your terminal, or run:

```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```

To make this permanent, add those lines to your `~/.zshrc` (macOS) or `~/.bashrc` (Linux).

---

### Supabase Key Format Changed

**Symptoms:** Claude Code questions the format of your Supabase key, or setup fails with key validation errors.

**Explanation:** Supabase recently renamed their API keys:
- **"anon public key"** is now called **"Publishable key"** and may start with `sb_publishable_` instead of `eyJ`
- **"service_role secret key"** is now called **"Secret key"** and may start with `sb_secret_` instead of `eyJ`

**Fix:** Both formats work, in the same variables: `SUPABASE_SERVICE_ROLE_KEY` takes the secret key (`sb_secret_…`) or the old `service_role`, `SUPABASE_ANON_KEY` the publishable key (`sb_publishable_…`) or the old `anon`. Paste whatever your Supabase dashboard shows. The setup assistant rejects a `sb_publishable_…` in the field for the writing key, because it cannot write. If Claude Code questions the format, tell it that Supabase updated their key format and it's correct. With a `sb_secret_…` key the Edge Functions must be deployed with `--no-verify-jwt`, see [Semantische Suche fällt still auf Textsuche zurück](#semantische-suche-fällt-still-auf-textsuche-zurück-semantic-search-silently-falls-back).

---

### macOS "Background Items" Notification

**Symptoms:** After setting up always-on services, macOS shows a popup saying *"Software from 'Jared Sumner' can run in the background"*.

**Fix:** This is normal. Jared Sumner is the creator of the Bun runtime, which powers the bot services. Click **Allow** to let the services run on schedule. You can manage background items later in System Settings > General > Login Items.

---

### Claude Code Permission Prompts

**Symptoms:** Claude Code asks for permission before running commands during setup.

**Fix:** This is normal — Claude Code asks before executing shell commands or editing files. You can:
- Select **"Allow for this session"** to approve all similar actions during setup
- Or approve each action individually

---

## Common Issues and Fixes

### Bot Not Responding

**Symptoms:** You send a message on Telegram and get no reply.

**Check 1: Is the service running?**

```bash
launchctl list | grep ai.tybo.telegram-relay
```

Expected output:
```
1234    0    ai.tybo.telegram-relay
```

If the PID column shows `-`, the service is loaded but not running.
If the line is missing entirely, the service is not installed.

**Check 2: Is there a stale lock file?**

```bash
ls -la ~/tybo/bot.lock
```

If the file exists and the bot is not running, delete it:

```bash
rm ~/tybo/bot.lock
```

Then restart the service:

```bash
launchctl unload ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
launchctl load ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
```

**Check 3: Check the logs**

```bash
tail -50 ~/tybo/logs/telegram-relay.log
tail -50 ~/tybo/logs/telegram-relay.error.log
```

Look for error messages about missing tokens, connection failures,
or uncaught exceptions.

**Check 4: Is your bot token still valid?**

```bash
curl "https://api.telegram.org/bot<YOUR_TOKEN>/getMe"
```

If this returns an error, your token may have been revoked. Create
a new token with BotFather.

**Check 5: Is your user ID correct?**

The bot silently ignores messages from unauthorized users.
Double-check `TELEGRAM_USER_ID` in `.env` matches your actual ID.

---

### Claude Timeout

**Symptoms:** The bot shows "typing..." for a long time and then
responds with a fallback message or error.

**Cause:** Claude Code CLI is taking too long to respond.

**Fix 1: Increase the timeout**

In `src/bot.ts`, the default is 30 minutes:

```typescript
timeoutMs: 1_800_000, // 30 minutes
```

For simpler tasks, you might want to lower this. For complex multi-tool
chains, it may need to be higher.

**Fix 2: Check Claude authentication**

```bash
claude --version
claude -p "Hello" --output-format text
```

If Claude returns an auth error, re-authenticate:

```bash
claude
# Follow the OAuth flow
```

**Fix 3: Check for rate limiting**

Look for these patterns in the log:

```
API Error: 429
rate_limit_error
overloaded_error
```

These mean you have hit Anthropic's rate limits. Wait a few minutes
and try again, or configure a fallback LLM.

---

### Supabase Connection Failed

**Symptoms:** Messages are not being saved, goals/facts are not
persisting, or the verify script shows Supabase errors.

**Fix 1: Check your credentials**

```bash
bun run test:supabase
```

Common issues:
- URL missing the `https://` prefix (`http://` is only accepted for Supabase on this machine, `127.0.0.1` or `localhost`)
- Keys still contain placeholder values
- Wrong key type: `SUPABASE_SERVICE_ROLE_KEY` needs the secret key (`sb_secret_…`) or `service_role`, not the publishable key or `anon`

**Fix 2: Check the schema**

Go to your Supabase dashboard > Table Editor. Verify these tables exist:
- `messages`
- `memory`
- `logs`
- `call_transcripts`

If they are missing, run `db/schema.sql` in the SQL Editor.

**Fix 3: Check RLS policies**

If you can read but not write, the RLS policies may be misconfigured.
The simplest fix is to use the `SUPABASE_SERVICE_ROLE_KEY` (which
bypasses RLS entirely) instead of the anon key.

**Fix 4: Network connectivity**

```bash
curl -s -o /dev/null -w "%{http_code}" "https://your-project.supabase.co/rest/v1/"
```

Should return `200`. If it returns an error, check your network
connection or Supabase service status.

---

### Lokales Supabase startet nicht

Gilt für den Weg „Supabase auf diesem Rechner“ (`tybo setup datenbank`, in
Docker). Die Befehle unten laufen im Projektordner; die CLI kommt über Bun in
der Version, die tybo nutzt (`bunx --bun supabase@2.118.0`; ohne `--bun`
verlangt der Starter der CLI Node).

**Erst nachsehen:**

```bash
docker info --format '{{.ServerVersion}}'            # läuft Docker?
bunx --bun supabase@2.118.0 status --workdir .        # läuft Supabase?
docker ps --filter label=com.supabase.cli.project=tybo --format '{{.Names}}  {{.Ports}}'   # nur 127.0.0.1:544xx?
docker network inspect supabase_network_tybo --format '{{json .Options}}'                # host_binding_ipv4 127.0.0.1?
```

| Meldung oder Zeichen | Ursache und Abhilfe |
|---|---|
| „Docker fehlt. …“ | Kein `docker`-Befehl. Auf dem Mac OrbStack, Docker Desktop oder Colima (`brew install colima docker`, `colima start`) installieren, unter Linux die Docker Engine. tybo installiert Docker nie selbst. |
| „Docker läuft nicht: …“ | Docker Desktop bzw. OrbStack öffnen oder `colima start`. Zeigt `docker context ls` auf einen anderen Docker: `docker context use <name>`. |
| „… keine Berechtigung …“ | Linux: `sudo usermod -aG docker $USER`, ab- und wieder anmelden. |
| „Die Supabase-CLI ließ sich nicht laden. …“ | Bun lädt die CLI beim ersten Mal aus dem npm-Verzeichnis (rund 130 MB). Internet prüfen; `bunx --bun supabase@2.118.0 --version` zeigt den eigentlichen Fehler. Node.js ist nicht nötig. |
| „… ein Port im Bereich 54420 bis 54429 belegt …“ | Ein anderes Programm oder ein altes Supabase nutzt einen Port von tybo. `docker ps` zeigt, welcher Container; ein anderes Supabase-Projekt mit `supabase stop` in dessen Ordner anhalten. Die Ports stehen in `supabase/config.toml`. |
| „… Speicherplatz für die Docker-Images fehlt …“ | `docker system prune` löscht ungenutzte Images und Container (nicht die Volumes von tybo). Bei Docker Desktop unter Settings, Resources die virtuelle Festplatte vergrößern. |
| „Supabase ist nach 20 Minuten noch nicht gestartet. …“ | Beim ersten Start lädt Docker mehrere GB. Einfach erneut; schon geladene Images bleiben. |
| „Supabase war nicht nur auf diesem Rechner erreichbar …“ | Ein Port war nicht an `127.0.0.1` gebunden oder aus dem Heimnetz erreichbar. Die Docker-Einstellung `"ip"` (`daemon.json`) hilft hier nicht, sie gilt nur für das Standard-Netz `bridge`. Supabase läuft im Netz `supabase_network_tybo`, das der Assistent mit der Option `com.docker.network.bridge.host_binding_ipv4=127.0.0.1` anlegt. Fehlt sie (zweiter Befehl oben): `bunx --bun supabase@2.118.0 stop --workdir .`, `docker network rm supabase_network_tybo`, erneut einrichten. |
| „Das Docker-Netz supabase_network_tybo gibt es schon, aber ohne Bindung an 127.0.0.1 …“ | Wie in der Zeile darüber: anhalten, Netz entfernen, erneut einrichten; der Assistent legt es richtig an. |
| „Achtung: Supabase-Dienste laufen womöglich noch …“ | Der Schutz-Stopp ist gescheitert. Sofort `bunx --bun supabase@2.118.0 stop --workdir .`; zeigt `docker ps --filter label=com.supabase.cli.project=tybo` danach noch Container, `docker stop <name>`. |
| Nach einem Neustart des Rechners antwortet die Datenbank nicht | Supabase startet nicht von selbst: Docker starten, dann `tybo setup datenbank` oder `bunx --bun supabase@2.118.0 start --workdir . -x studio,imgproxy,logflare,vector,realtime,supavisor,mailpit,postgres-meta` (dieselben Dienste wie der Assistent). |
| Rechner wird sehr langsam | Weniger als 8 GB Arbeitsspeicher, oder die Docker-VM hat zu wenig. Bei Docker Desktop unter Settings, Resources mehr geben, bei Colima `colima start --memory 6`. |

**Daten:** Sie liegen in Docker-Volumes `supabase_<dienst>_tybo`.
`supabase stop` hält an und behält sie. `supabase stop --no-backup` und
`docker volume rm` **löschen** Gespräche, Gedächtnis und Bilder; beides nur,
wenn du wirklich neu anfangen willst. `project_id` in `supabase/config.toml`
nicht ändern: eine andere ID heißt neue, leere Volumes.

---

### Semantische Suche fällt still auf Textsuche zurück (Semantic Search Silently Falls Back)

**Symptome:** Der Bot speichert Nachrichten und findet frühere Gespräche,
aber nur bei wörtlichen Treffern. Wissenseinträge bekommen kein Embedding.
Im Log steht kein Fehler.

**Warum still:** `saveMessage()` und `searchMessages()` in
`src/lib/supabase.ts` versuchen zuerst die Edge Functions
`store-telegram-message` und `search-memory`. Antworten diese nicht mit
Erfolg, speichert der Bot direkt (ohne Embedding) bzw. sucht mit einfacher
Textsuche. Das hält den Bot am Laufen, verdeckt aber den Fehler.

**Häufige Ursachen:**

- Die Edge Functions sind nicht deployt, oder auf Supabase fehlt das Secret
  `OPENAI_API_KEY` (dann gibt es Speicherung ohne Embedding).
- In der `.env` steht ein neuer Schlüssel (`sb_secret_…`) und die Functions
  wurden ohne `--no-verify-jwt` deployt. Der Supabase-Gateway prüft dann ein
  JWT, der neue Schlüssel ist keins, die Anfrage endet mit 401.
- Eine ältere Fassung der Functions ist deployt, die nur
  `Authorization: Bearer <service_role>` kennt. Mit `sb_secret_…` schickt der
  Bot den Schlüssel nur im Kopf `apikey`.
- In `SUPABASE_SERVICE_ROLE_KEY` steht der Publishable- oder anon-Schlüssel.
  Die Functions lassen nur Secret- bzw. service_role-Schlüssel durch.

**Prüfen:** Aus dem Projektordner, der Schlüssel wird aus der `.env` gelesen
und nicht angezeigt:

```bash
set -a; . ./.env; set +a
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$SUPABASE_URL/functions/v1/search-memory" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"chat_id":"0","query":"test"}'
```

Mit einem alten `service_role`-Schlüssel zusätzlich
`-H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"` angeben. 200 heißt:
die Function antwortet. 401: Schlüssel falsch oder `verify_jwt` noch an.
404: Function nicht deployt. 503: der Function fehlen ihre Schlüssel
(`SUPABASE_SECRET_KEYS` bzw. `SUPABASE_SERVICE_ROLE_KEY` in ihrer Umgebung).

**Fix:** Die Functions aus `supabase/functions/` neu deployen, jeweils mit
`--no-verify-jwt` (die Prüfung macht jede Function selbst, siehe
`supabase/functions/_shared/auth.ts`; `supabase/config.toml` setzt
`verify_jwt = false` für alle drei):

```bash
supabase functions deploy store-telegram-message --no-verify-jwt
supabase functions deploy search-memory --no-verify-jwt
supabase functions deploy embed-knowledge --no-verify-jwt
```

Alte `service_role`-Schlüssel funktionieren danach weiter.

---

### launchd Service Not Starting

**Symptoms:** `launchctl list | grep ai.tybo` shows no entries or
the service keeps exiting.

**Fix 1: Validate the plist XML**

```bash
plutil ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
```

Should output: `OK`. If it shows errors, the XML is malformed.
Regenerate with:

```bash
bun run setup:launchd -- --service telegram-relay
```

**Fix 2: Check paths in the plist**

Open the plist and verify all paths are absolute and the files exist:

```bash
cat ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
```

Check that:
- The bun path exists: `which bun`
- The project root exists
- The script file exists

**Fix 3: Unload and reload**

```bash
launchctl unload ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
launchctl load ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
```

**Important:** You must unload before loading. Running `load` on an
already-loaded service will fail silently.

**Fix 4: Check for errors in launchd's own logs**

```bash
log show --predicate 'subsystem == "com.apple.xpc.launchd"' --last 5m | grep ai.tybo
```

---

### Voice Not Working

**Symptoms:** Voice messages are not transcribed, or the bot does not
reply with audio.

**Fix 1: Check API keys**

```bash
bun run setup:verify
```

Look for the ElevenLabs and Gemini status in the output.

**Fix 2: Check voice is enabled**

In the bot startup log:

```
Voice:       enabled
Transcribe:  enabled
```

If either shows "disabled", the corresponding API keys are missing.

**Fix 3: Test ElevenLabs directly**

```bash
curl -X POST "https://api.elevenlabs.io/v1/text-to-speech/<VOICE_ID>" \
  -H "xi-api-key: <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello", "model_id": "eleven_turbo_v2_5"}' \
  --output test.mp3
```

If this fails, your API key or voice ID may be invalid.

**Fix 4: Check your Gemini key**

For transcription issues:

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models?key=<GEMINI_KEY>"
```

Should return a list of models. If it returns an error, your key is invalid.

---

### Multiple Bot Instances

**Symptoms:** You receive duplicate responses to messages, or the bot
behaves erratically.

**Fix 1: Check for running processes**

```bash
ps aux | grep "bun run src/bot.ts"
```

If you see multiple processes, kill them all:

```bash
pkill -f "bun run src/bot.ts"
```

**Fix 2: Delete the lock file**

```bash
rm ~/tybo/bot.lock
```

**Fix 3: Restart the service**

```bash
launchctl unload ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
launchctl load ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
```

**Fix 4: Check launchctl for duplicate entries**

```bash
launchctl list | grep ai.tybo.telegram-relay
```

There should be exactly one entry. If there are multiple, unload all
and reload once.

---

### MCP Servers Not Available in Subprocess

**Symptoms:** Claude does not have access to MCP tools (Google Calendar,
Notion, etc.) when called from the bot, even though they work in
direct Claude Code sessions.

**Explanation:** Claude Code picks up MCP server configuration based on
the current working directory. When spawned as a subprocess from the bot,
the working directory may differ from where your MCP servers are configured.

**Fix 1: Use global MCP scope**

Configure MCP servers in the global `~/.claude.json` under the top-level
`mcpServers` key, not in a project-scoped config.

**Fix 2: Set the working directory**

The bot sets `cwd: PROJECT_ROOT` when spawning Claude. Ensure your
MCP configuration is accessible from that path.

---

### JSON Parse Errors from Claude

**Symptoms:** The bot logs JSON parse errors or returns garbled responses.

**Explanation:** Claude Code subprocesses sometimes wrap JSON output in
markdown code fences:

````
```json
{"result": "Hello!", "session_id": "abc123"}
```
````

**Fix:** The bot already handles this in `src/lib/claude.ts` with the
`extractJSON()` function. If you encounter this in custom code:

```typescript
export function extractJSON(output: string, key: string): any | null {
  const cleaned = output.replace(/```(?:json)?\s*/g, "").replace(/```/g, "");
  const jsonMatch = cleaned.match(new RegExp(`\\{[\\s\\S]*"${key}"[\\s\\S]*\\}`));
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
  return null;
}
```

Always strip code fences before parsing JSON from Claude subprocesses.

---

### Bot Answers About Something Else (Hook Continuation)

**Symptoms:** You ask a question and the reply is about a different, earlier
task from the same topic: design fixes, a deploy, "what the hook really
meant". The bot may also edit or deploy files you did not ask about. The
error log looks normal (`[Claude streaming] result: text=... chars`).

**Cause:** A Claude Code `Stop` hook (for example the impeccable design
detector in `.claude/settings.local.json`) returns `additionalContext` when
Claude finishes its answer. Claude then keeps working and writes a second
final message. With `SESSION_MODE=resume` a topic session lives for hours and
touches many files, so such hooks re-report old findings on every turn, no
matter what you asked. The CLI's `result` event only carries the last
message, so the real answer was dropped before it reached Telegram.

**Diagnosis:** Take the topic's session id from `data/sessions.json`, open
`~/.claude/projects/<project-dir>/<session-id>.jsonl` and look for
`hook_additional_context` entries between two assistant text messages.

**Fix (built in since 9 Sep 2026):**

- Every CLI subprocess tybo spawns carries `TYBO_SUBPROCESS=1` in its
  environment (`subprocessEnv()` in `src/lib/subprocess-env.ts`).
  Hooks inherit the environment, so gate any hook that can push context back
  into the conversation:

  ```json
  "command": "[ -n \"$TYBO_SUBPROCESS\" ] || node path/to/your-stop-hook.mjs"
  ```

  PostToolUse hooks that only report on the file just edited are harmless
  and can stay active; they run inside the turn.
- `callClaudeStreaming()` groups text blocks by API turn (`message.id`) and
  relays every final turn, joined by a blank line, instead of trusting the
  `result` event alone. The error log then shows
  `[Claude streaming] N final turns in one call (hook continuation?)`.
- The non-streaming path (`--output-format json`) has no such protection,
  so the environment-variable gate is the primary fix.

### Reply Replaced by "Abgebrochen." After a Code Change (Self-Restart)

**Symptoms:** You ask the bot to change its own code. A few minutes later
Telegram shows only `⏹️ Abgebrochen.` (since 14 Sep 2026: an explicit
"Der Bot wurde waehrend der Verarbeitung beendet" notice), the explanation
never arrives, and `logs/telegram-relay.log` shows `Received SIGTERM`
followed by a fresh `Go Telegram Bot - Starting` block.

**Cause:** The Claude subprocess that handled your message restarted the bot
(`launchctl kickstart -k`, `kill <pid>`) to activate its change. `shutdown()`
calls `abortAllClaudeCalls()`, which kills every running subprocess,
including the one that was about to send the answer. launchd (`KeepAlive`)
then started the bot again with the new code, so the change itself is live;
only the reply was lost.

**Fix (built in since 14 Sep 2026):** request the restart instead of forcing it:

```bash
bun run restart:request "Tabellen-Fix aktivieren"   # creates data/restart-requested
```

The bot checks the marker 3 s after every delivered reply and every 30 s
while idle. It exits only when no Claude subprocess or agent execution is
running, posts "🔄 Neustart mit neuem Code" to Telegram first, and lets
launchd/PM2 start it again. If the bot is not supervised (started with
`nohup`), it keeps running, clears the marker and asks for a manual restart.

**Manual restart** (from a terminal, never from inside a bot subprocess):

```bash
launchctl kickstart -k gui/$(id -u)/ai.tybo.telegram-relay  # macOS
pm2 restart tybo-telegram-relay                              # Linux/Windows
```

### Subprozess vermisst eine Variable (Subprocess Is Missing a Variable)

**Symptoms:** Something that works in your own terminal fails when the bot
does it: a `curl` or deploy inside a Claude answer reports a missing token,
`gh` asks for a login, or a script says `X_API_KEY is not set`.

**Cause (since issue #54):** Claude subprocesses no longer inherit every
secret from the bot's environment. `subprocessEnv()` in
`src/lib/subprocess-env.ts` removes variables whose name looks like a secret
(`*_TOKEN`, `*_KEY`, `*_SECRET`, `*PASSWORD*`, `*_PASS`, `SUPABASE_*`,
`TELEGRAM_*`) before starting `claude -p` or the Agent SDK. This blocks the
typical injection `env | curl …`. Network, Bash and tool permissions are
unchanged, and `.env` itself stays readable.

These pass automatically:

- `ANTHROPIC_API_KEY` when set (the CLI in API mode). Other login tokens
  such as `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_AUTH_TOKEN` need
  `TYBO_SUBPROCESS_ENV_ALLOW` or an MCP reference
- variables referenced as `${VAR}` or `$VAR` inside `mcpServers` of
  `~/.claude.json` (global and the bot's project entry), `.mcp.json`,
  `.claude/settings.json`, `.claude/settings.local.json` or
  `~/.claude/settings.json`. Hooks and permission rules do not count
- the Agent SDK's OpenRouter fallback gets the OpenRouter key only as
  `ANTHROPIC_AUTH_TOKEN`

`WEB_PASSWORD`, `CLAUDECODE` and inherited `TYBO_CHAT_ID`/`TYBO_TOPIC_ID`
are always removed; `TYBO_SUBPROCESS=1` is always set.

**Diagnosis:** At startup the bot logs the names (never the values) once:

```bash
grep "subprocess-env" logs/telegram-relay.log | tail -1
```

**Fix:** Release the variable by name in `.env`, comma-separated, then
restart the bot (`bun run restart:request "Freigabe"`):

```bash
TYBO_SUBPROCESS_ENV_ALLOW=GH_TOKEN,CLOUDFLARE_API_TOKEN
```

Only `TYBO_SUBPROCESS_ENV_ALLOW` counts.

Release only what the subprocess really needs: every released value is
visible to the whole Claude process, not just to one tool.

---

## Debugging Commands Cheatsheet

```bash
# ---- Service Status ----
launchctl list | grep ai.tybo            # Check all services
launchctl list ai.tybo.telegram-relay    # Check specific service

# ---- Force-Run a Service ----
launchctl kickstart gui/$(id -u)/ai.tybo.smart-checkin
launchctl kickstart gui/$(id -u)/ai.tybo.morning-briefing

# ---- View Logs (Real-time) ----
tail -f logs/telegram-relay.log           # Bot main log
tail -f logs/smart-checkin.log            # Check-in log
tail -f logs/morning-briefing.log         # Briefing log
tail -f logs/watchdog.log                 # Watchdog log
tail -f logs/*.log                        # All logs at once

# ---- View Error Logs ----
tail -50 logs/telegram-relay.error.log
tail -50 logs/smart-checkin.error.log

# ---- Process Management ----
ps aux | grep "bun run src"               # Find running processes
cat bot.lock                              # Check lock file PID
rm bot.lock                               # Remove stale lock

# ---- Service Restart ----
launchctl unload ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
launchctl load ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist

# ---- Full Reset ----
bun run uninstall                         # Unload all services
rm bot.lock session-state.json            # Remove state files
bun run setup:launchd -- --service all    # Reinstall all services

# ---- Health Check ----
curl http://localhost:3000/health          # Bot health endpoint
bun run setup:verify                       # Full system health check

# ---- Test Individual Components ----
bun run test:telegram                      # Test Telegram connectivity
bun run test:supabase                      # Test Supabase connectivity
bun run checkin                            # Run check-in manually
bun run briefing                           # Run briefing manually

# ---- Claude CLI ----
claude --version                           # Check CLI version
claude -p "Hello" --output-format text     # Test Claude directly
```

---

## Log File Locations

All logs are in the `logs/` directory within the project root:

| File | Source | Content |
|------|--------|---------|
| `telegram-relay.log` | Main bot stdout | Message processing, startup/shutdown |
| `telegram-relay.error.log` | Main bot stderr | Errors, stack traces |
| `smart-checkin.log` | Check-in stdout | Decision logs, message sends |
| `smart-checkin.error.log` | Check-in stderr | Errors |
| `morning-briefing.log` | Briefing stdout | Data gathering, send status |
| `morning-briefing.error.log` | Briefing stderr | Errors |
| `watchdog.log` | Watchdog stdout | Health check results |
| `watchdog.error.log` | Watchdog stderr | Errors |

Supabase also stores structured logs in the `logs` table, queryable
from the Supabase dashboard or via the REST API.

---

## When to Reset

If nothing else works, a clean reset often helps:

```bash
# 1. Stop all services
bun run uninstall

# 2. Remove state files
rm -f bot.lock session-state.json checkin-state.json

# 3. Clear logs (optional)
rm -f logs/*.log

# 4. Reinstall dependencies
bun install

# 5. Verify configuration
bun run setup:verify

# 6. Test the bot manually
bun run start
# Send a test message on Telegram
# Ctrl+C to stop

# 7. If manual test works, reinstall services
bun run setup:launchd -- --service all
```

---

## VPS Hardening & Access Recovery

### SSH Locked Out (fail2ban)

**Symptoms:** SSH connection refused or times out, even though the VPS is running.

**Cause:** fail2ban bans your IP after too many failed SSH attempts (default: 5 failures = 10min ban). This commonly happens when:
- You have a passphrase-protected SSH key and ssh-agent isn't running
- Your IP changed (dynamic IP from ISP)
- You tried multiple keys before the right one

**Recovery via hosting panel:**
1. Log into your VPS hosting panel (DigitalOcean, Hetzner, etc.)
2. Open the **web terminal / console** (browser-based SSH)
3. Check if you're banned:
   ```bash
   sudo fail2ban-client status sshd
   ```
4. Unban your IP:
   ```bash
   sudo fail2ban-client set sshd unbanip YOUR_IP_HERE
   ```
5. Find your current IP: visit `https://ifconfig.me` in your browser

**Prevention — whitelist your IP range:**

Create `/etc/fail2ban/jail.local`:
```ini
[sshd]
ignoreip = 127.0.0.1/8 ::1 YOUR_IP_RANGE/24
maxretry = 10
bantime = 3600
```

Then restart: `sudo systemctl restart fail2ban`

**Tip:** Use a `/24` subnet (e.g., `95.91.246.0/24`) instead of a single IP, since residential IPs change frequently.

---

### SSH Key Issues

**Symptoms:** `Permission denied (publickey)` or `Too many authentication failures`

**Common causes:**
- **Passphrase-protected key**: ssh-agent isn't running or key isn't loaded. Fix: `ssh-add ~/.ssh/your_key` or generate a new key without passphrase for server access
- **Wrong key**: SSH tries all keys by default. Use `IdentitiesOnly yes` in `~/.ssh/config` to force a specific key
- **Key not on server**: Your public key isn't in `~/.ssh/authorized_keys` on the VPS

**Recommended SSH config:**
```
Host my-vps
  HostName your-server-ip
  User ubuntu
  IdentityFile ~/.ssh/id_ed25519_vps
  IdentitiesOnly yes
```

**Generate a new key (no passphrase):**
```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_vps -N "" -C "my-vps"
```

Then add the public key to your VPS via the hosting panel's web terminal:
```bash
echo "YOUR_PUBLIC_KEY" >> /home/ubuntu/.ssh/authorized_keys
```

---

### UFW Firewall Rules

The VPS needs these ports open:
```bash
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP (for webhooks)
sudo ufw allow 443/tcp   # HTTPS (if using SSL)
sudo ufw allow 3000/tcp  # Bot gateway (if not behind reverse proxy)
```

Check status: `sudo ufw status verbose`

---

### API Budget & Cost Management

**How the budget system works:**
- `DAILY_API_BUDGET` in `.env` sets your daily spend limit (default: $5)
- When remaining budget drops below $1, Opus requests auto-downgrade to Sonnet
- When budget hits $0, all requests get a "budget exceeded" message
- Budget resets at midnight (server time)

**Recommended budgets:**
| Usage Level | Budget | Notes |
|------------|--------|-------|
| Light (5-10 msgs/day) | $5 | Mostly Haiku/Sonnet |
| Moderate (10-30 msgs/day) | $15 | Mix of all tiers |
| Heavy (30+ msgs/day, research) | $50+ | Frequent Opus usage |

**Monitor spending:** Check the gateway logs for `[COST]` entries:
```bash
grep COST /tmp/gateway.log | tail -20
```

---

## VPS-Specific Issues

If you deployed to a VPS, these additional issues may apply.

### Claude Subprocesses Fail on VPS

**Symptoms:** Bot returns fallback responses or errors for every message.

**Fix:** Claude Code on a headless VPS cannot use OAuth. You must set
`ANTHROPIC_API_KEY` in `.env`:

```bash
grep ANTHROPIC_API_KEY .env
# Should show your API key, not a placeholder
```

Test Claude directly:

```bash
claude -p "Hello" --output-format text
```

### PM2 Services Not Starting After Reboot

**Fix:** Ensure PM2 startup was configured:

```bash
pm2 startup
# Follow the printed command
pm2 save
```

### Cron Jobs Silent Failures

**Fix:** Check cron logs:

```bash
grep CRON /var/log/syslog | tail -20
```

Common issue: `bun` not in cron's PATH. The `setup:services` script uses
`cd /path/to/project && bun run script.ts` to handle this.

### VPS Debugging Cheatsheet

```bash
# ---- PM2 Service Status ----
pm2 status                                # All services
pm2 logs tybo-telegram-relay --lines 50   # Bot logs
pm2 logs tybo-telegram-relay --err        # Error logs only

# ---- Cron Schedule ----
crontab -l                                # View all cron entries
grep CRON /var/log/syslog | tail -20      # Cron execution log

# ---- System Resources ----
htop                                      # Interactive process viewer
free -h                                   # Memory usage
df -h                                     # Disk usage

# ---- Network ----
curl -I https://api.telegram.org          # Test Telegram API access
curl -I https://api.anthropic.com         # Test Anthropic API access

# ---- Restart Everything ----
pm2 restart all                           # Restart all PM2 services
```

---

## How to Report Issues

When reporting a problem, include:

1. **What you expected** vs **what happened**
2. **Relevant log output** (last 50 lines of the appropriate log file)
3. **Your environment:**
   ```bash
   bun --version
   claude --version
   sw_vers                   # macOS version
   bun run setup:verify      # Health check output
   ```
4. **Steps to reproduce** the issue
5. **Any recent changes** you made (new API keys, code edits, etc.)

---

## Relevant Source Files

| File | Purpose |
|------|---------|
| `src/bot.ts` | Main bot with lock file, shutdown, health server |
| `src/lib/claude.ts` | Subprocess management, timeout, JSON extraction |
| `src/lib/supabase.ts` | Database connection test function |
| `src/lib/fallback-llm.ts` | Fallback chain with error logging |
| `setup/verify.ts` | Full system health check |
| `setup/configure-launchd.ts` | Service installer |
| `.env.example` | Environment variable reference |

---

**Back to start:** [Einrichtung](./einrichtung.md)
