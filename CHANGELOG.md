# Changelog

## 2.18.0: a second engine when the limit is full, jobs that come back to you

- **Backup stages:** when the limit of your subscription was full, a
  fallback model with a reduced set of tools answered. Now you can line up to
  four backup stages behind your default engine, for example Claude Code
  with another model, then Codex, then OpenCode. If a stage is at its limit
  or not ready (not installed, not signed in), the next free one answers,
  also within the same turn when a run fails at the limit. The fallback
  models stay as the last net. Set it up in the WebUI under settings,
  "Modelle", section "Motor", or as `engine.backups` in
  `config/settings.json`. Without backup stages everything works as before.
- **Automatic switch:** with backup stages tybo switches before the limit is
  hit. A measurement at or above the threshold (95 %, adjustable from 50 to
  99) blocks that limit window until it resets; a newer measurement below
  the return threshold (15 points lower by default) releases it early. A
  running answer is never switched. `/motor auto aus` turns the threshold
  off; limit errors and outages still make the next stage step in.
- **Handover and messages:** every engine keeps its own session. After a
  switch the new engine gets the conversation so far (up to 30 messages and
  24,000 characters). A switch is reported once in the direct chat and in
  the WebUI, and the conversation shows a note before the first answer of
  the other engine, also on the way back and when no stage is free.
- **Limits per engine:** tybo keeps the state of every limit window with its
  reset time: for Claude Code from the event stream of each run and from its
  usage report (week, five hours, the weekly limit of a model family), for
  Codex from the session file of each run. For OpenRouter the WebUI shows
  credit and limit of the key. Your own script can deliver measurements with
  `bun run limits set`; `bun run limits show` prints the state. tybo reads no
  login token of an engine and calls no undocumented endpoint.
- **Engine per conversation and per agent:** an agent can have its own
  engine (WebUI, settings, "Agenten"). The order of precedence is
  conversation (`/motor codex`), agent, default; `/motor standard` only
  removes the choice of the conversation. The direct Anthropic API stays a
  choice by hand and never steps in as a backup.
- **`/motor`** shows the order of stages, why this engine answers, and state
  and age of the measurements. New: `/motor auto an`, `/motor auto aus`,
  `/motor pruefen` (measure again and re-evaluate blocks) and
  `/motor werkzeuge`.
- **In the browser:** the chat always shows the engine of the conversation
  as a pill; its menu gives the reason and switches the engine for this
  conversation. The section "Motor" moved from "Agenten" to the top of the
  "Modelle" tab, with order, automatic switch, state per engine and "Jetzt
  messen". The "Status" tab lists the tools of every engine.
- **The same tools in Codex:** so that Codex can stand in for Claude Code,
  tybo hands it the MCP servers Claude Code uses as parameters of each run
  (only at permission level "Voller Zugriff", nothing is written into the
  Codex configuration), makes the skills of Claude Code visible through
  links under `.agents/skills/`, and adds the overview of Claude Code's
  project notes to a new Codex session. `/motor werkzeuge`, `tybo pruefen`
  and the "Status" tab show what each engine has and what is missing, with
  the reason. Each part can be turned off under `engine.codex` in
  `config/settings.json` (`mcp`, `skills`, `claudeNotes`).
- **Side tasks during a block:** the judge of `/goal`, threads and the
  review move to the OpenRouter fallback model while the limit windows of
  their Claude model are blocked. Without an OpenRouter key they pause until
  the block ends.

- **Jobs on Codex, defaults from the settings:** `bun run job start --engine
  codex` runs a background job on Codex. Without `--model` and `--effort` a
  job now takes model and effort from `config/settings.json`
  (`defaults.model` for Claude, `engine.codex.model` for Codex), no longer a
  fixed default.
- **Resume a job:** a job that was aborted or ran out of time can continue
  in the same Claude session, with the button "Fortsetzen" at its message or
  with `bun run job resume <id>`. Nothing resumes by itself, and the job
  keeps its ID ("Lauf 2", "Lauf 3").
- **Jobs can ask:** a Claude job can stop, ask you a question with answer
  buttons and carry on with your answer; in Telegram you can also reply to
  the question with a text. Up to five questions per job; a question
  unanswered for 48 hours ends the job, which can then be resumed.
- **`--zurueck`:** with this option the report of a job goes back into the
  conversation that started it, and tybo works on with it, for example to
  check it or to start the next step. At most three such jobs may follow
  one another.
- **Jobs in the browser:** a new view "Jobs" next to "Offene Fäden" lists
  jobs that wait for you, running ones and the last 20 finished. There you
  answer a question, resume or stop a job and read its log and report.

- **Files in the installed app on iPhone and iPad:** opening or downloading a
  file led to a page with no way back. "Herunterladen" now hands the file to
  the share sheet, and "Öffnen" shows an HTML file in a viewer with a close
  button. In every browser a tap on an image preview opens the image in that
  viewer.

## 2.17.0: voice agents from recipes, a tidier memory

- **Voice agents from recipes:** a voice agent is no longer assembled by hand
  at ElevenLabs but described in a recipe, a file
  `config/voice-agents/<id>.json` (examples in `config/voice-agents.example/`:
  a call answering service, a personal assistant and a trainer). tybo creates
  the agent at ElevenLabs from it, with its tests. Each recipe names a
  template (`anrufannahme`, `jarvis`, `experte`) whose fixed rules cannot be
  removed: say that an AI is speaking, read numbers back digit by digit, in
  an emergency point to 112 and end the call, make no promises on your
  behalf. Needs `ELEVENLABS_API_KEY`. `/anruf` and an agent you set up by
  hand keep working as before. tybo does not assign phone numbers.
- **`/sprachagent`** in Telegram, the WebUI and the terminal: `liste`,
  `testen <id>`, `loeschen <id>`, `link <id>`, and `neu <description>` or
  `aendern <id> <wish>`. For `neu`, a background job writes the recipe (for
  an expert also a knowledge file with sources), you pick a voice and approve
  with buttons; the approval shows the estimated cost per minute. Nothing is
  created without a button, and an agent is only unlocked once its tests
  pass or you unlock it yourself.
- **Voice agents in the browser:** a new area "Sprachagenten" in the WebUI
  with a list, details and a wizard in five steps (purpose, voice with a
  sample, knowledge and behaviour, access, check and start). Experts and the
  personal assistant can be talked to on a page of their own, only after
  login: one conversation at a time, with the limit per call and the monthly
  minute budget from the recipe.
- **Practice with an expert:** after a practice conversation tybo rates it
  against the three criteria of the recipe, with quotes of what you said, and
  shows the last five sessions. This needs the ElevenLabs post-call webhook,
  which only the `server` profile receives.
- **Own phone line (optional):** `ELEVENLABS_PHONE_PROVIDER=sip_trunk` lets
  `/anruf` dial through a SIP trunk. `deploy/sip-vermittlung/` holds a small
  exchange for a private easybell line, so agents can answer calls to a
  landline number.

- **Memory, goals:** with Supabase every goal failed silently; goals work
  now, and a failed save is reported in the conversation.
  `tybo gedaechtnis ziele-nachholen` offers goals from old answers again, as
  suggestions with buttons.
- **Memory, the core:** `/kern` keeps a short overview (who you are, how you
  work, what you are working on; at most 2,000 characters) that is in every
  fresh session, whatever the topic. `/kern entwurf` drafts it from your
  facts, `/kern setzen <text>` takes your own text; the file is
  `config/kern.md`.
- **Memory, facts:** every fact carries its date in the prompt, with a note
  that older ones may be outdated. Follow-up messages bring up to five
  matching facts the session has not seen yet, and tybo can look facts up
  during a conversation. tybo remembers more strictly: research goes into the
  knowledge base, not into facts.
- **Memory, tidying up:** facts can be archived instead of deleted and
  brought back (`tybo gedaechtnis archiv`, `zurueckholen`).
  `tybo gedaechtnis bereinigen --datei <path>` works through a list of
  duplicates and outdated facts, confirmed with buttons.
- **Memory, secrets:** a value that looks like a password, token or API key
  is not stored as a fact. Older facts with such a value stay, but the value
  is masked in every prompt and output; `tybo gedaechtnis geheimnisse` lets
  you keep or archive them one by one.
- **Memory, suggestions:** tybo now only asks before remembering when the
  turn read content from the net or an uploaded file. Files on your own
  machine no longer count as foreign, nor does `gh` against repositories of
  the accounts in `TYBO_TRUSTED_GITHUB_OWNERS`.
- **Telegram token:** the bot token never appears in a log; the nightly
  check searches the logs for it and warns.

- **Maintenance:** `tybo wartung` clears things that can be recreated safely
  (Xcode test simulators, download and build caches, oversized own logs) and
  reports the space gained; `--dry-run` only shows. As a weekly routine:
  `tybo dienste wartung` (Sundays 03:15), settings in `config/wartung.json`.
- **Services after updates:** services listed in `config/wartung.json` are
  restarted when they still run an older version than the installed one, for
  example the Cloudflare tunnel. The bot itself is never restarted that way.
- **Nightly check:** it now runs on Linux too (systemd timer in your time
  zone from `USER_TIMEZONE`, otherwise PM2 or cron) and checks whether the
  bot process runs and answers and whether the chosen engine is installed and
  logged in. It warns earlier about low disk space and shows maintenance,
  service versions and new facts of the last seven days. Set it up with
  `tybo dienste health-check`. On Linux `/routinen` lists the systemd timers.
- **`tybo pruefen`:** checks the chosen engine and its login with the `PATH`
  of the service, whether the bot really runs (on macOS a loaded but stopped
  service is an error) and, in the line "Schema", whether the database is
  missing a migration.
- **Without a Claude account:** a machine with only Codex can be set up;
  `tybo setup` asks for the engine in the step `modelle` and says clearly
  what is missing (background jobs and the side tasks need Claude or a side
  model of their own). `docs/server.md` has the table of what works with
  which engine.
- **Updates and the database:** an update brings new code but no new tables.
  The installer now says when `db/` changed, the bot checks for missing
  migrations at every start and reports them once, and Supabase on this
  machine applies them itself at `tybo datenbank start`.
- **Telegram conflicts:** a second bot with the same token (409) or a
  rejected token (401) only pauses the Telegram intake. WebUI, reminders,
  background jobs and goals keep running, and the WebUI status page and
  `tybo pruefen` show it. tybo never deletes a Telegram webhook itself any
  more: when moving back from the `server` profile to polling, delete it by
  hand (`docs/telegram-webhook.md`).
- **Background jobs under systemd:** they survive a restart of the bot
  (`KillMode=process` in the unit file).
- **More robust:** a stale `bot.lock` no longer blocks the start, and a
  refused start says which process holds the lock. `/stop` during an active
  goal never ends the bot. When the Claude CLI is missing, the fallback
  models also step in on Linux, and the reply names the reason once per
  conversation.
- **WebUI:** audio and video from messages play in the chat, HTML files open
  in a tab of their own, sandboxed. The Telegram list and the message
  fetcher read far less from Supabase.
- **Models:** `claude-fable-5-2` is in the model list, and effort `max` can
  be chosen for Claude too.

**Updating from 2.16.0**

- Run the installer again, `curl -fsSL https://tybo.ai/install | sh`, then
  `tybo setup datenbank` before restarting: two new migrations (fact archive,
  fact search). In the cloud this needs a fresh access token (`sbp_…`).
- With semantic search in the cloud, run `tybo setup suche` once more so the
  updated Edge Function `search-memory` is deployed. Until then follow-up
  messages find facts by shared words only.
- Linux with systemd: run `tybo setup autostart` once to add
  `KillMode=process` to the existing unit file (`tybo pruefen` warns until
  then), and `tybo dienste health-check` for the nightly check.
- PM2: recreate the bot entry once with `tybo dienste telegram-relay`, so it
  gets the longer stop timeout and can release its lock (the bot restarts).

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
