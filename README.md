# tybo

tybo is an always-on AI assistant that you talk to on Telegram, in the
browser or in the terminal, with Claude Code doing the actual work on your
own machine.

- **Telegram and WebUI:** chat from your phone via Telegram, or in the
  browser with the built-in WebUI (installable as an app on your phone);
  both share the same conversations. Telegram is optional: with the WebUI
  alone tybo runs without Telegram, and you need at least one of the two.
- **Claude Code as the engine:** every message runs through the Claude Code
  CLI, so your MCP servers, skills, hooks and `CLAUDE.md` are available.
  Codex, OpenCode or the Anthropic API can take over, by default or for a
  single conversation with `/motor`.
- **Agents with topics:** eight agents (research, content, finance,
  strategy, critic and more), each bound to a Telegram forum topic;
  `/board` asks the board agents in turn about one decision.
- **Memory:** facts, goals and conversation history persist in Supabase
  (cloud or local) and are pulled back in when relevant.
- **Reminders, check-ins, morning briefing:** reminders are built in;
  check-ins and the briefing run as routines and offer buttons in Telegram
  and the WebUI.
- **Background jobs:** long tasks run detached and always report back, even
  after a crash.
- **Goals with `/goal`:** set a standing goal per topic and tybo keeps
  working on it, checked after each step, until it is done or needs you.
- **Fallback models:** when Claude is unavailable, tybo answers via
  OpenRouter or a local Ollama model instead of going silent.
- **[Talk to tybo](docs/sprechen.md):** speak instead of typing in the WebUI.
  Recommended and private: Parakeet listens, Pocket TTS speaks with the German
  voice "Jürgen", all on your machine; ElevenLabs is an optional cloud extra.

## Requirements

- macOS, Linux or Windows
- [Git](https://git-scm.com)
- [Bun](https://bun.sh) 1.3.10 or newer
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI,
  installed and logged in. On macOS, Linux and WSL use the native installer,
  which needs neither Node.js nor `sudo`:
  `curl -fsSL https://claude.ai/install.sh | bash`, then `claude` and
  `/login`. On Windows (without WSL) the npm way still works:
  `npm install -g @anthropic-ai/claude-code` (needs Node.js 22 or newer)
- [Node.js](https://nodejs.org) 20 or newer with `npm`, only for PM2 or
  installing the Claude CLI via npm
- Autostart: nothing extra on macOS and on Linux with systemd (such as
  Raspberry Pi OS); Windows and Linux without systemd need
  [PM2](https://pm2.keymetrics.io) (`npm install -g pm2`)
- A Telegram account, unless you only use the WebUI

## Installation

On macOS and Linux (including WSL), one command does it:

```bash
curl -fsSL https://tybo.ai/install | sh
```

It checks for Git and Bun (offering the official Bun installer if needed),
clones tybo into `~/tybo`, installs the packages, creates the `tybo`
command and starts `tybo setup`. It never uses `sudo` and does not install
Node.js, the Claude CLI or PM2; at the end it lists what is still missing.
Run the same command again to update. Options such as `--dir` and
`--no-setup`: [setup guide](docs/einrichtung.md#schnellweg-ein-befehl).

**By hand** (also the way on Windows):

```bash
git clone https://github.com/cloudnutzer/tybo.git
cd tybo           # the folder the clone just created
bun install       # fetches the dependencies listed in package.json
bun link          # puts the tybo command into ~/.bun/bin
tybo setup        # without bun link: bun run setup
```

`tybo setup` walks through the steps one by one, tests every entry right
away and only writes `.env` after you confirm: requirements, Telegram
(optional, skip it to use only the WebUI), forum group, database, semantic
search, profile, models, speech, WebUI, access from your phone, Google
Calendar and Gmail, autostart and a final check. You need Telegram or the
WebUI. For the database the default is Supabase in the cloud: you create a
free account and a personal access token, and the assistant sets up project,
tables, storage and keys (the token is used once and stored nowhere).
`tybo setup --web` does the same in the browser, `tybo setup <step>` runs a
single step, and `tybo pruefen` prints the same check with an exit code.
The full walkthrough: [docs/einrichtung.md](docs/einrichtung.md).

## Running tybo

**Autostart.** `tybo setup autostart` registers tybo as a service that
starts with your computer and restarts after crashes: launchd on macOS
(`ai.tybo.telegram-relay`), a systemd user service on Linux with systemd
(`tybo-telegram-relay`), PM2 on Windows and Linux without systemd
(`tybo-telegram-relay`). With PM2 on Linux, run `pm2 startup` once and
execute the line it prints. Check-ins and the morning briefing are set up
separately with `tybo dienste`. Without autostart, `bun run start` runs
tybo in the current terminal. `tybo deinstallieren` removes the services
and keeps your folder, `.env` and data.

**Logs.** Output goes to `logs/telegram-relay.log`, errors to
`logs/telegram-relay.error.log` in the project folder.

**Restart.** After an update or a change to `.env`:

```bash
launchctl kickstart -k gui/$(id -u)/ai.tybo.telegram-relay   # macOS
systemctl --user restart tybo-telegram-relay                  # Linux, systemd
pm2 restart tybo-telegram-relay                               # PM2
```

From inside a conversation with tybo, use `bun run restart:request "reason"`
instead: it waits until the current reply has been sent.

**Costs.** tybo itself is free; you pay for Claude Code. `CLAUDE_AUTH` in
`.env` decides how: `subscription` uses your Claude Pro or Max plan,
`apiKey` pays per token with `ANTHROPIC_API_KEY`. Left empty, tybo uses the
key if one is set and the subscription otherwise. On the subscription
`/credit` counts usage and warns once you near a known limit; it does not
switch models and does not stop the plan's limit. Details:
[FAQ](docs/faq.md#was-kostet-das-und-wie-rechnet-claude-code-ab) (German).

## tybo on your phone

tybo has no app in the App Store or on Google Play. Instead, the WebUI
installs like an app on iPhone and Android: its own icon, full screen,
notifications, and on Android it shows up in the share menu. This needs an
HTTPS address for the WebUI that your phone can reach. `tybo setup zugang`
sets one up: Tailscale (recommended, private network for your own devices),
a Cloudflare Tunnel with your own domain and Cloudflare Access, or none
(this computer only). Details: [Access from anywhere](docs/webui/fernzugang.md)
(German). Step-by-step guide:
[tybo as an app on your phone](docs/handy-app.md) (German).

## Further reading

- [Setup guide](docs/einrichtung.md) and [extras](docs/erweiterungen.md) (German)
- [User guide](docs/user-guide.md) (German): commands, agents, topics, goals
- [FAQ](docs/faq.md) and [Raspberry Pi 5 around the clock](docs/raspberry-pi.md) (German)
- [Architecture](docs/architecture.md)
- [Troubleshooting](docs/troubleshooting.md) (German): what to do when setup, start or replies go wrong
- [Background jobs](docs/hintergrund-jobs.md), [reminders](docs/erinnerungen.md) and [routines](docs/routinen.md) (German)
- [WebUI](docs/webui/README.md)
- [tybo.ai](https://tybo.ai): product overview and guide

## License

MIT, see [LICENSE](LICENSE).
