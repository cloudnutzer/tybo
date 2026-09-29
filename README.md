# tybo

tybo is an always-on AI assistant that you talk to on Telegram, in the
browser or both, with Claude Code doing the actual work on your own machine.

- **Telegram and WebUI:** chat from your phone via Telegram, or in the
  browser with the built-in WebUI (installable as an app on your phone);
  both share the same conversations. Telegram is optional: with the WebUI
  alone tybo runs without Telegram, and you need at least one of the two.
- **Claude Code as the engine:** every message runs through the Claude Code
  CLI, so your MCP servers, skills, hooks and `CLAUDE.md` are available.
- **Agents with topics:** specialised agents (research, content, finance,
  strategy, critic and more), each bound to a Telegram forum topic.
- **Memory:** facts, goals and conversation history persist in Supabase
  (cloud or local) or Convex and are pulled back in when relevant.
- **Background jobs:** long tasks run detached and always report back, even
  after a crash.
- **Goals with `/goal`:** set a standing goal per topic and tybo keeps
  working on it, checked after each step, until it is done or needs you.
- **Fallback models:** when Claude is unavailable, tybo answers via
  OpenRouter or a local Ollama model instead of going silent.

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
- [Node.js](https://nodejs.org) 20 or newer with `npm`, only for PM2, the
  optional Convex setup (`npx`) or installing the Claude CLI via npm
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
command and starts `tybo setup`. It never uses `sudo`, does not touch your
shell startup files and does not install Node.js, the Claude CLI or PM2; at
the end it lists what is still missing. Run the same command again to update.
Options such as `--dir` and `--no-setup` are described in the
[setup guide](docs/einrichtung.md#schnellweg-ein-befehl).

**By hand** (also the way on Windows):

```bash
git clone https://github.com/cloudnutzer/tybo.git
cd tybo
bun install
bun link          # puts the tybo command into ~/.bun/bin
tybo setup
```

`tybo setup` asks for your Telegram bot token (optional, skip it to use only
the WebUI), your database, your name and timezone, tests every entry right
away and only writes `.env` after you confirm. You need Telegram or the
WebUI; skip Telegram and the assistant offers the WebUI next. For the database the default is Supabase in the cloud: you only
create a free account and a personal access token, and the assistant sets
up the project, tables, storage and keys (the token is used once and stored
nowhere). Right after the database, an optional step sets up semantic search
(finding messages by meaning, not just by words): with an OpenAI key it
deploys the Supabase Edge Functions, stores the key where they read it and
proves it works with a test message; skip it and tybo uses plain text search,
catch up later with `tybo setup suche`. Prefer the browser? Run
`tybo setup --web` instead. Without
`bun link`, use `bun run setup` in the project folder.

The full walkthrough, including what the assistant does not cover, is in
[docs/einrichtung.md](docs/einrichtung.md).

## Running tybo

**Autostart.** `tybo setup autostart` registers tybo as a service that
starts with your computer and restarts after crashes: launchd on macOS
(`ai.tybo.telegram-relay`), a systemd user service on Linux with systemd
(`tybo-telegram-relay`), PM2 on Windows and Linux without systemd
(`tybo-telegram-relay`). With PM2 on Linux, run `pm2 startup` once and
execute the line it prints so PM2 itself survives a reboot. Without
autostart, `bun run start` runs tybo in the current terminal.

**Raspberry Pi.** To run tybo around the clock at home on a Raspberry Pi 5,
follow the [Raspberry Pi guide](docs/raspberry-pi.md) (German).

**Logs.** Output goes to `logs/telegram-relay.log`, errors to
`logs/telegram-relay.error.log` in the project folder.

**Restart.** After an update or a change to `.env`:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/ai.tybo.telegram-relay
# Linux with systemd
systemctl --user restart tybo-telegram-relay
# PM2 (Windows, Linux without systemd)
pm2 restart tybo-telegram-relay
```

From inside a conversation with tybo, use `bun run restart:request "reason"`
instead: it waits until the current reply has been sent.

**Costs.** By default tybo runs on your Claude Pro or Max subscription, and
programmatic use draws from that plan's monthly Agent SDK credit; `/credit`
shows how much is left. If you set your own `ANTHROPIC_API_KEY`, you pay
per token instead and the subscription limit no longer applies.

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

- [Setup guide](docs/einrichtung.md) (German)
- [Raspberry Pi 5 around the clock](docs/raspberry-pi.md) (German)
- [User guide](docs/user-guide.md) (German): commands, agents, topics, goals
- [Architecture](docs/architecture.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Background jobs](docs/hintergrund-jobs.md) (German)
- [WebUI](docs/webui/README.md)
- [tybo as an app on your phone](docs/handy-app.md) (German)
- [tybo.ai](https://tybo.ai): product overview and guide

## License

MIT, see [LICENSE](LICENSE).
