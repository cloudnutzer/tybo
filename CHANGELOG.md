# Changelog

## 2.16.0: a new public history

- **New history:** the public repository starts over with a single commit
  "tybo 2.16.0". Earlier commits, tags and releases (2.12.0 to 2.15.1) are
  gone; they still contained code from the project tybo started from. The
  code is the same as in 2.15.1.
- **Existing clones:** run the installer again,
  `curl -fsSL https://tybo.ai/install | sh`. It recognises the new history
  and moves a clone without local changes to 2.16.0; `.env`, `config/`,
  `data/`, `logs/` and `models/` stay. Updating by hand: back up your own
  changes first, then `git fetch origin && git reset --hard origin/master`
  and `bun install --frozen-lockfile`. A plain `git pull --ff-only` fails
  once.

## 2.15.1: rewritten from the ground up, installer ready for a new history

- **Installer and a rebuilt history:** running
  `curl -fsSL https://tybo.ai/install | sh` again also updates a clone when
  the public history has been rebuilt (no common ancestor with the new
  version). A clone without local changes or own commits is moved to the new
  version; `.env`, `config/`, `data/`, `logs/` and `models/` stay. With own
  commits, tracked changes or files in the way, the installer stops and
  explains what to do, without changing anything.

- **Convex removed:** tybo stores history, facts and goals in Supabase (in
  the cloud, on this machine or entered by hand). Without Supabase only facts
  and goals are kept, locally in `memory.json`; Telegram history is not
  stored then (WebUI conversations live separately under `data/web/`).
  `tybo setup datenbank` offers the three Supabase ways; the
  `convex/` folder, `bun run setup:convex`, `bun run test:convex`,
  `bun run migrate:convex` and the `convex` package are gone. If `CONVEX_URL`
  is still in your `.env`, tybo ignores it and logs a notice at start.
- **Moving from Convex:** 1. Back up your data first, best before updating:
  a backup export in the Convex dashboard or `npx convex export --path
  convex-backup.zip` in the folder where you set up Convex. 2. Run
  `tybo setup datenbank` and pick one of the three Supabase ways; your old
  Convex lines in `.env` do not get in the way. 3. There is no tool that
  copies data from Convex to Supabase: history, facts, goals and images
  start fresh in Supabase. The former `scripts/migrate-to-convex.ts` worked
  the other way round (Supabase to Convex). Re-enter important facts and
  goals in the chat and keep the backup for reference;
  `tybo erinnerungen importieren` only reads an old `config/reminders.json`,
  not Convex data, so re-create open reminders. 4. Delete `CONVEX_URL`,
  `CONVEX_AUTH_TOKEN` and any other `CONVEX_*` lines from `.env` and restart
  tybo. Step by step: `docs/einrichtung.md`, section "Umzug von Convex".

### Unabhängig: rewritten from the ground up

tybo's own code and documentation replace what the project started from.
Features were rewritten, not dropped; behaviour that worked stays, often
with fixes.

**Rewritten**

- **Storage:** one store for history, memory, knowledge base, images, jobs
  and costs on Supabase, with a new schema and Edge Functions. Fact search
  now really ranks by meaning, umlauts survive the knowledge search, and
  German deadlines in `[GOAL: … | DEADLINE: morgen]` are kept.
- **Reminders:** built in, in Supabase or without a database in `data/`,
  with repeats, buttons in Telegram and the WebUI, `/erinnerungen` and the
  `[REMIND: …]` tag.
- **Chat core:** one turn for Telegram, WebUI and terminal; commands,
  questions with buttons, progress, agent consultations and Telegram output
  (long code blocks no longer break) are shared modules. `src/bot.ts` only
  wires them together.
- **Engines and costs:** Claude Code runs on your subscription or your API
  key, set with `CLAUDE_AUTH`. A fourth engine `api` talks to the Anthropic
  API directly. Every run of every engine is booked in one place; `/credit`
  and `/plan` work in all channels.
- **Server and hybrid:** the server profile is the same bot process with a
  Telegram webhook (`bun run vps`, `TYBO_PROFILE`), hybrid with peer health.
- **Agents and board:** new prompts for all eight agents; the morning
  briefing and `/board` read the same data sources (goals, Google Calendar
  and Gmail, Notion, news). `tybo setup google` connects Google.
- **Check-ins and briefing:** routines with quiet hours, windows and a real
  snooze, settings in the `proactive` block of `config/settings.json`, a
  German briefing without completed goals. Check-ins can offer a phone call
  as a button; the nightly check replaces the old watchdog.
- **Phone calls:** `/anruf [reason]` in every channel instead of the words
  "call me" in a Telegram message, with the call summary in the chat.
- **Services:** `tybo dienste`, `tybo pruefen` and `tybo deinstallieren`
  set up, check and remove the background services on macOS and Linux.
- **Docs:** `CLAUDE.md`, troubleshooting, FAQ, architecture and
  `.env.example` are new, the developer guide is shorter.

**Removed**

- Convex (see above).
- The Agent SDK session (`USE_AGENT_SDK` and the package): the `claude`
  engine with `CLAUDE_AUTH=apiKey` does the same.
- Model routing by complexity: tybo always uses the configured model, and
  `/credit` counts and warns but never switches models.
- The feedback loop that wrote `config/patterns.md`.
- `upgrade.ts` (run the installer again to update) and the Windows Task
  Scheduler for check-ins and the briefing (on Windows only the bot runs,
  via PM2).

**Moving over**

- **Convex:** see "Moving from Convex" above.
- **Old reminders** in `config/reminders.json`: `tybo erinnerungen
  importieren` takes them over once.
- **Check-in times** from `config/schedule.json` and the old check-in state
  are taken over once into `config/settings.json` and
  `data/proactive-state.json`; existing new values win. If you set up
  check-ins or the briefing before, run `tybo dienste` once more so the
  services start the new routines.
- **Subscription counter:** the old `credit-tally.json` is taken over once,
  the current cycle is kept.
- **`CLAUDE_AUTH`:** without it tybo behaves as before (API key if set,
  otherwise the subscription). Set `CLAUDE_AUTH=subscription` to keep
  `ANTHROPIC_API_KEY` only for the `api` engine and image descriptions.

## 2.15.0: talk to tybo, privately on your own machine

- **Private voice, recommended:** NVIDIA Parakeet listens and Kyutai Pocket
  TTS answers with the German voice "Jürgen" (`juergen`, CC-BY-4.0), both on
  your own machine: no audio or text goes to a speech service and there is
  no cost per minute. `tybo setup sprache` downloads, verifies and tests
  both (Mac with Apple Silicon, Linux x64 and arm64). On slow machines such
  as a Raspberry Pi it suggests Piper (voice Thorsten) instead.
- **Talk mode:** a microphone button in the WebUI. Each spoken question
  becomes a full tybo turn with all tools; tybo detects the pause, reads the
  answer aloud (no tables or code) and listens again. Tap to interrupt.
- **Handset:** a running conversation in the WebUI with short answers after
  about two to three seconds. Interrupt tybo by speaking, mute, hang up;
  tools during the call (web search, calculations, a thinking task that
  continues in the chat), memory tags and approvals, and the whole call in
  the conversation history. When tybo is unsure what it heard, it asks back
  instead of guessing.
- **ElevenLabs, optional cloud:** as an alternative, ElevenLabs can speak in
  the handset (streamed, v3 Conversational by default) and Scribe can
  recognise speech, each falling back to the local way when ElevenLabs is
  unreachable. It costs ElevenLabs credit and sends the reply text or your audio to
  ElevenLabs.
- **Your own voice:** clone your voice for talk mode with Pocket TTS or
  Qwen3-TTS, optional and only with consent; never used for
  Telegram or phone calls.
- **Settings, "Speech" tab:** choose recogniser, voice and the model for
  spoken questions and for the handset, with a voice sample and a probe.
- **Nightly check:** `bun run health` tests all important functions and
  sends a report with ticks, warnings and errors to Telegram and the WebUI.
- **Reliability:** a streaming watchdog counts partial messages as signs of
  life and names the phase on a timeout; background jobs no longer start
  detached commands and report leftovers.
- **Voice bridge:** only approved phone numbers get your profile, memory and
  tools.

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
