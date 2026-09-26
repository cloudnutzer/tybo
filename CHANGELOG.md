# Changelog

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
