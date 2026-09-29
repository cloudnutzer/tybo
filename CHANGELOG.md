# Changelog

## 2.14.0: tybo as an app on your phone, Telegram optional

- **Install the WebUI as an app:** on iPhone (Safari, "Add to Home Screen")
  and Android, tybo gets its own icon and opens full screen. When the
  computer running tybo is asleep, the app says so and offers a retry.
- **Notifications:** Web Push per device for finished answers, questions
  that need your decision and reports, never for the conversation you are
  looking at. Switch it on under Settings, "Notifications".
- **Share and camera:** on Android tybo appears in the share menu (photos,
  links, text); on both platforms you can take a photo straight from the
  chat.
- **Telegram is optional:** conversations, reports and approval buttons
  work in the WebUI alone. `tybo setup`, the terminal chat and the health
  check handle a setup without a bot token.
- **Access from your phone for everyone:** `tybo setup zugang` sets up
  Tailscale (recommended), your own domain via Cloudflare Tunnel with
  Access, or local only. Guide: `docs/handy-app.md`.

## 2.13.0: choose your engine, guided search, Raspberry Pi

- **Choose the engine:** besides Claude Code, tybo can now run on **Codex**
  (with your ChatGPT login) or **OpenCode** (with OpenRouter or another
  provider). Pick a default in the WebUI settings or switch per conversation
  with `/motor`; sessions remember their engine.
- **Local Supabase for good:** Supabase on your own machine now starts
  with the system and comes with a backup command (`tybo datenbank`).
- **Semantic search, guided:** `tybo setup suche` deploys the Edge Functions
  and tests them; choose OpenAI, Google Gemini or a local Ollama model for
  embeddings, and switch later with a background recompute.
- **Raspberry Pi and Linux:** a systemd user service via `tybo setup
  autostart`, parallel jobs sized to the available memory, clearer installer
  hints, and a guide for running tybo around the clock on a Raspberry Pi 5
  (`docs/raspberry-pi.md`).
- **Parallel work, safer:** a notice when all slots are busy, `/stop` works
  immediately, `/new` no longer comes back, button answers land in the right
  topic, goals resume after a restart.
- **Long runs:** the time limit counts idle time instead of total time, and
  after a timeout tybo reports the state instead of restarting with a
  fallback model.
- **WebUI:** timestamps on all messages.

## 2.12.0: first public release

The first public version of tybo, an always-on AI assistant on Telegram and
in the browser, powered by Claude Code.

- **Telegram relay:** messages go to the Claude Code CLI on your machine,
  answers come back with live progress for longer tasks; photos, documents
  and voice messages are supported.
- **WebUI and terminal chat:** chat in the browser (also from your phone in
  the home network) or with `tybo` in the terminal, with the same topics,
  commands, files and inline questions as in Telegram.
- **Setup assistant:** `tybo setup` (or `tybo setup --web` in the browser)
  checks the requirements, tests every entry and sets up autostart via
  launchd or PM2.
- **Agents and topics:** specialised agents bound to Telegram forum topics,
  one continuous Claude session per topic, `/board` for multi-agent
  discussions, `/agent` to adjust an agent from the chat.
- **Memory:** facts, goals and conversation history in Convex or Supabase;
  when a session ends, tybo suggests what to remember instead of writing it
  silently.
- **Goals:** `/goal` keeps tybo working on a standing goal per topic, with
  quality gates, a judge model and a turn budget; `/stop` interrupts.
- **Background jobs:** `tybo job` runs long tasks detached and always
  reports back, even after a crash.
- **Fallback models:** OpenRouter or a local Ollama model answer when Claude
  is unavailable, with your MCP tools.
- **Subscription credit guard:** routes models to stretch the Agent SDK
  credit of a Claude subscription and shows usage with `/credit`.
