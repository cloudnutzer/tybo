# tybo — Always-On AI Telegram Agent

> Claude Code reads this file automatically. Follow the setup phases below.
> Each phase is designed to be completed through conversation with Claude Code.
>
> New here? Start with [`README.md`](README.md) (what tybo is, installation,
> operation) and [`docs/einrichtung.md`](docs/einrichtung.md) (setup step by
> step). The phases below are the detailed reference.

tybo ([tybo.ai](https://tybo.ai), command `tybo`; name, command and domain in
`src/brand.ts`). Its repository is `cloudnutzer/tybo` (`BRAND.repo` in
`src/brand.ts`). The Supabase bucket comes from `SUPABASE_ASSETS_BUCKET`
(default `tybo-assets`). Variables are `TYBO_*`, services `ai.tybo.*` (launchd) /
`tybo-*` (PM2), the only command is `tybo`.

## What This Sets Up

> 💳 **Heads-up on Claude subscription billing (read first).** tybo runs by default
> on **your Claude Pro/Max subscription** (no API key needed). From **June 15, 2026**,
> Anthropic meters programmatic `claude -p` usage on a subscription against a fixed
> monthly **Agent SDK credit** (Pro $20 / Max 5x $100 / Max 20x $200). tybo handles
> this for you: it routes each message to the cheapest model that fits (so your credit
> lasts much longer), shows your usage with **`/credit`**, warns at 80%, and keeps
> working at the cap. If you'd rather have unlimited pay-as-you-go, add your own
> `ANTHROPIC_API_KEY` (then you're exempt). You can stay on subscription and switch to
> an API key later if you keep hitting the limit. Configure it in `.env` (see the
> *Credit Guard* block) or just run with the safe defaults.

An always-on Telegram agent that:
- Relays your messages to Claude and sends back responses
- **Two processing engines**: Claude Code CLI (local, uses your subscription) or Anthropic API (VPS, pay-per-token). Local mode runs Anthropic's official Claude Code CLI directly — nothing changes there. For production/always-on deployments, we recommend API keys with smart routing to manage costs. See [Anthropic's Legal and Compliance page](https://code.claude.com/docs/en/legal-and-compliance) for the latest authentication policies.
- **Subscription credit guard**: on a Claude subscription, tybo routes models to stretch your monthly Agent SDK credit, self-meters spend (`/credit`), warns at 80%, and learns your real plan ceiling automatically. Fail-open — never blocks your bot.
- **Hybrid mode**: VPS always on, forwards to local when your machine is awake
- Runs multiple specialized AI agents (Research, Content, Finance, Strategy, Critic)
- **Extensible via MCP**: Connect any MCP servers you use (email, calendar, project management, etc.)
- **Human-in-the-loop**: Claude asks for confirmation via inline buttons before taking actions
- Proactively checks in with smart context awareness
- Sends morning briefings with pluggable data sources (goals, calendar, email, news, tasks)
- Persists memory (facts, goals, conversation history) via Convex (Supabase fallback)
- Stores images persistently in Convex Storage with AI-generated descriptions and semantic search
- Survives reboots via launchd (macOS) or PM2 + scheduler (Windows/Linux)
- Falls back to OpenRouter/Ollama when Claude is unavailable
- Optional: voice replies, phone calls, audio transcription

## Prerequisites

Before starting, ensure you have:
- [ ] **macOS, Windows, or Linux**
- [ ] **Bun** runtime installed (`curl -fsSL https://bun.sh/install | bash`)
  - **Important:** After installing Bun, restart your terminal or add Bun to your PATH:
    ```bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    ```
  - To make this permanent, add those two lines to your `~/.zshrc` (macOS) or `~/.bashrc` (Linux)
- [ ] **Claude Code** CLI installed and authenticated (`claude --version`)
- [ ] A **Telegram** account
- [ ] **Windows/Linux only**: PM2 for daemon services (`npm install -g pm2`)

## What to Expect During Setup

Claude Code will ask for permission before running commands or editing files. When you see a permission prompt:
- **"Allow tool access"** — Select "Allow for this session" or "Always allow" to let Claude Code run setup commands
- **macOS "Background Items" popup** — When launchd services start, macOS may show a notification saying *"Software from 'Jared Sumner' can run in the background"*. This is normal — Jared Sumner is the creator of the Bun runtime. Click **Allow** to let the bot services run.

---

## Phase 0: Environment Scan (Automatic, ~1 min)

> **New machine (macOS, Linux): `curl -fsSL https://tybo.ai/install | sh`.** The
> installer checks Git and Bun, clones to `~/tybo`, runs `bun install` and `bun link`
> and then starts `tybo setup`; it does not install Node.js, the Claude CLI or PM2.
> Options and updates: [`docs/einrichtung.md`](docs/einrichtung.md), section
> "Schnellweg: ein Befehl"; errors: `docs/troubleshooting.md`, "Installation mit
> einem Befehl".
>
> **Preferred for an existing checkout: `tybo setup`.** The setup assistant (`bun install`,
> `bun link`, then `tybo setup`; without `bun link`: `bun run setup`; in the browser:
> `tybo setup --web`) walks through the setup without this file. Step-by-step guide:
> [`docs/einrichtung.md`](docs/einrichtung.md).
>
> `tybo setup` covers: prerequisites (checks Bun, Claude CLI, Git; the Claude login only in
> the terminal, not with `--web`; installs nothing), Phase 1 (Telegram token, user ID, test message), Phase 2 (default: Supabase in
> the cloud, set up from a personal access token `sbp_…`: project, schema, private bucket,
> keys, `.env`; the token is used for that run only and stored nowhere. Alternatively it
> stores and tests existing Supabase or Convex credentials; it does not create the Convex
> OIDC issuer), Phase 3 (name, timezone, optional profession, `config/profile.md`;
> no interview about work style), the forum group from Phase 4 (group ID only), fallback
> models from Phase 8 (default model, effort, OpenRouter, Ollama), the WebUI, and Phase 7
> for the bot itself (`telegram-relay` via launchd or PM2; no check-in, briefing or
> watchdog services, and on Linux `pm2 startup` stays a manual step).
>
> `tybo setup` does **not** do: this environment scan of old installs, Phase 2.5,
> agent customization and topic IDs from Phase 4, multi-bot tokens, Phase 6 and 6.5,
> the other integrations from Phase 8 (voice, calls, transcription), Phase 8.5, 9 and 10.
> For those, follow the phases below.

> **Claude Code: Run this BEFORE starting Phase 1. Always. Even if the user says they're starting fresh.**

### What Claude Code does:

**Step 1 — Ask the user:**

"Have you previously set up a Telegram bot with Claude Code, or any similar AI assistant project? For example, the free mini-course relay, or your own custom setup?"

**Step 2 — Scan regardless of answer:**

Even if the user says "no," run these checks silently. They may have forgotten, or someone else set it up on their machine.

1. **Check if this is a ZIP download (no git):**
   - Check if `.git/` directory exists in the project root
   - If NO `.git/`: this is a ZIP download. Tell the user:
     "This looks like a ZIP download. Run `bun run upgrade` to connect to the official repo — this lets you pull future updates with `git pull` without losing your config."
   - If `.git/` exists: check `git remote get-url origin` — verify it points to the repo in `BRAND.repo` (`src/brand.ts`, HTTPS or SSH form)
   - If wrong remote: suggest `bun run upgrade` to fix it

2. **Check for existing `.env` file** in this project directory. If it exists, read it and catalog every variable that has a real value (not a placeholder like `your_bot_token_here`).

3. **Check for other bot projects** on the machine:
   - Look for `~/.claude-relay/` directory (free mini-course relay)
   - Look for `~/claude-telegram-relay/` or any folder matching `*telegram*relay*` in `~/`, `~/Desktop/`, `~/Downloads/`, `~/Documents/`, `~/development/`
   - If found, read their `.env` files for reusable credentials

4. **Check for running services:**
   - macOS: `launchctl list | grep -E "com\.go\.|claude.*relay|telegram"`
   - Linux/Windows: `pm2 list` (if pm2 exists)
   - Report any existing bot services that might conflict

5. **Check for existing database:**
   - If `CONVEX_URL` configured and working → report "Database — Convex (active)", skip Phase 2
   - If `SUPABASE_URL` configured and working → report "Database — Supabase (active)", skip Phase 2
   - If neither → Phase 2 will present the choice
   - Do NOT suggest migration unless user asks

7. **Check for existing profile:**
   - Look for `config/profile.md` in this project
   - Look for `~/.claude-relay/profile.md` or similar in discovered projects

**Step 3 — Report findings:**

Present a clear summary to the user:

```
ENVIRONMENT SCAN RESULTS

Git connection: ✅ Connected to cloudnutzer/tybo / ⚠️ ZIP download (run: bun run upgrade)
Existing setup found: Yes/No
Source: [this project / claude-telegram-relay at ~/path / other]

✅ Telegram Bot Token — found, valid
✅ Telegram User ID — found
✅ Database — Convex (active) / Supabase (active) / ❌ not configured (set up in Phase 2)
✅ User Name — "Sarah"
✅ User Timezone — "Europe/Berlin"
✅ Profile — found at [path]
❌ Anthropic API Key — not set (needed for VPS mode)
❌ Voice/ElevenLabs — not configured
❌ Fallback LLMs — not configured

Supabase tables:
✅ messages (1,247 rows — your history is preserved)
✅ memory (23 rows)
✅ logs (456 rows)
❌ async_tasks — missing (new in tybo)
❌ node_heartbeat — missing (new in tybo)

Running services:
⚠️ claude-relay daemon running (will conflict — needs stopping)

RECOMMENDATION:
I can carry over your Telegram, Supabase, and profile settings.
I'll add the missing tables without touching your existing data.
Phases 1-3 can be skipped. Starting at Phase 4 (Agents).
Stop the old relay service first? [Yes/No]
```

**Step 4 — Act on findings:**

- **Reusable credentials found:** Copy them into this project's `.env`. Confirm with the user before overwriting anything. Never delete the source.
- **Existing database found:** Report which backend is active. Both are supported. Run `db/schema.sql` for Supabase if needed (uses `IF NOT EXISTS` — safe for existing tables).
- **Conflicting services found:** Ask the user before stopping them. Explain that two bots polling the same Telegram token will cause message conflicts.
- **Profile found:** Offer to copy it to `config/profile.md`. Let user review it first.
- **Nothing found:** Proceed normally from Phase 1. No special handling needed.

**Step 5 — Skip completed phases:**

Based on the scan, tell the user which phases are already done and which remain. Jump directly to the first incomplete phase.

---

## Phase 1: Telegram Bot (Required, ~5 min)

### What you need to do:
1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts to create your bot
3. Copy the bot token (looks like `123456789:ABCdefGhIjKlMnOpQrStUvWxYz`)
4. Get your Telegram user ID:
   - Click this exact link: **[@userinfobot](https://t.me/userinfobot)** (make sure it says "userinfobot", not "usinfobot" or similar)
   - Send it any message (like "hi") — it immediately replies with your numeric user ID
   - Your user ID is a number like `123456789` (this is NOT your username)
   - **Warning:** There are copycat bots with similar names (like "@usinfobot"). Make sure you open the link above — the correct bot replies instantly with your ID, no menus or buttons

Faster: `tybo setup telegram`

### What Claude Code does:
- Creates `.env` from `.env.example` if it doesn't exist
- Saves your `TELEGRAM_BOT_TOKEN` and `TELEGRAM_USER_ID` to `.env`
- Runs `bun run setup/test-telegram.ts` to verify connectivity

### Tell me:
"Here's my bot token: [TOKEN] and my user ID: [ID]"

---

## Phase 2: Database (Required, ~5 min)

Default: `tybo setup datenbank`, choice "Supabase in der Cloud". The user only creates a free
Supabase account and a personal access token (https://supabase.com/dashboard/account/tokens,
starts with `sbp_`, set an expiry). The assistant uses the Supabase Management API to pick
the organization (free plan only), find or create the project (region default Frankfurt),
wait until it is ready, apply `db/schema.sql` and `db/migrations/*.sql`, create the private
bucket, fetch the keys and write `.env`, then tests the connection. The token lives only in
memory for that run. Running it again finds the project and only adds what is missing. Details:
`docs/einrichtung.md`, section "4. Datenbank".

tybo works with Supabase (cloud, on this machine or self-hosted) or Convex. The four ways in `tybo setup datenbank`:

1. **Supabase in the cloud (default):** as above, no manual SQL or dashboard work.
2. **Supabase on this machine:** in Docker (Docker Desktop, OrbStack or Colima; the assistant
   installs nothing), Supabase CLI via `bunx --bun supabase@<version>`, started from the project's
   `supabase/` folder (ports 54420-54429, data in Docker volumes `supabase_*_tybo`), schema,
   private bucket, `.env` with `http://127.0.0.1:54421`. Creates the Docker network
   `supabase_network_tybo` with `host_binding_ipv4=127.0.0.1` before the start and stops again
   (verified) if a port is not bound to loopback or reachable from the home network. Details: `src/setup/local-supabase.ts`.
3. **Supabase, enter credentials yourself:** an existing project or your own Supabase server
   (Phase 2B below).
4. **Convex (advanced):** needs your own OIDC token issuer and a token that expires
   (Phase 2A below).

| | Supabase | Convex (advanced) |
|---|---|---|
| Setup | `tybo setup datenbank` does it (cloud), or ~10 min by hand | One command plus your own OIDC issuer |
| Schema | SQL, applied by the assistant (cloud) or by hand | TypeScript, auto-managed |
| Semantic search | Requires edge functions | Built-in vector indexes |
| File storage | Private bucket, created by the assistant (cloud) | Built-in |
| Data access | Full SQL + Dashboard | Dashboard + export |
| Self-hosting | Yes (open source) | No (cloud only) |
| Free tier | Two active projects per account | Generous for single user |

**Recommendation:** Supabase in the cloud via `tybo setup datenbank`; Convex only if you already
run an OIDC issuer (scheduled tasks in Phase 8.5 need Convex).

**User says:** "Set up the database" (Supabase in the cloud), "I have a Supabase project" or "I'll use Convex"

### Phase 2A: Convex Setup

1. Go to [convex.dev](https://convex.dev) and create a free account
2. Claude Code runs: `npx convex dev --once --configure=new`
3. This creates your Convex deployment and gives you a `CONVEX_URL`

**What Claude Code does:**
- Runs `npx convex dev --once --configure=new` to create your Convex project
- Saves your `CONVEX_URL` to `.env`
- Deploys the schema and server functions
- Runs `bun run setup/test-convex.ts` to verify connectivity

### Phase 2B: Supabase Setup (enter credentials yourself)

Only for an existing project or a self-hosted server; in the cloud `tybo setup datenbank` does all of this.

1. Go to [supabase.com](https://supabase.com) and create a free account
2. Create a new project
3. Get your 3 keys from **Settings → API**:
   - Project URL (`SUPABASE_URL`)
   - Anon public key (`SUPABASE_ANON_KEY`)
   - Service role key (`SUPABASE_SERVICE_ROLE_KEY`)
4. Run `db/schema.sql` in the **SQL Editor** (Supabase Dashboard → SQL Editor → New Query → Paste & Run)
5. Create a Storage bucket: **Storage → New Bucket → Name: `tybo-assets` → Private**. Another name works too: create it private and set `SUPABASE_ASSETS_BUCKET` in `.env`

**What Claude Code does:**
- Saves your keys to `.env`
- Runs `bun run setup/test-supabase.ts` to verify connectivity

**Optional:** Install Supabase MCP server for direct DB access:
```bash
npx supabase mcp setup --project-ref YOUR_PROJECT_REF
```

### Switching databases later

- **Supabase → Convex:** Set up Convex, run `bun run scripts/migrate-to-convex.ts`
- **Convex → Supabase:** Set up Supabase, remove `CONVEX_URL` from `.env`
- If both are set, Convex takes priority

---

## Phase 2.5: Semantic Search (Optional, ~5 min)

Enable AI-powered memory search. Without this, the bot still works — it just uses basic text matching instead of understanding meaning.

### If using Convex:
- Get an OpenAI API key from [platform.openai.com](https://platform.openai.com)
- Claude Code sets the key as a Convex env var: `npx convex env set OPENAI_API_KEY <key>`
- Convex actions automatically generate embeddings for new messages and assets

### If using Supabase:
- Save an OpenAI or Gemini API key to `.env` as `OPENAI_API_KEY` or `GEMINI_API_KEY`
- Edge functions handle embedding generation (advanced setup)
- Basic text search works immediately without this step

### Tell me:
"Set up semantic search. My OpenAI key is [your key]" or "Skip" to use basic text search.

---

## Phase 3: Personalization (Required, ~5 min)

Faster: `tybo setup profil` (name, timezone, profession; no work-style interview)

### What Claude Code does:
- Asks you questions about yourself (name, timezone, profession, constraints)
- Creates `config/profile.md` with your answers
- Sets `USER_TIMEZONE` in `.env`

### Tell me:
Answer the questions I'll ask about your name, timezone, and work style.

---

## Phase 4: Agent Customization (Optional, ~10 min)

The bot includes 8 pre-configured agents. You can customize them or use defaults.

### Default agents:
| Agent | Reasoning | Purpose |
|-------|-----------|---------|
| General (Orchestrator) | Adaptive | Default assistant, cross-agent coordination |
| Research | ReAct | Research with sources: products, technology, markets, news |
| Content (CMO) | RoT | Posts, emails, presentations, audience and tone |
| Finance (CFO) | CoT | Costs, budgets, money decisions, unit economics (no investment or tax advice) |
| Strategy (CEO) | ToT | Major decisions, options, long-term consequences |
| Critic | Devil's Advocate | Stress-testing, pre-mortem analysis |
| CTO (Tech & Learning) | Systematic | Technology, learning, projects with AI, self-hosting, tybo itself |
| COO (Operations) | Process/Systems | Tasks, schedules, processes, organization |

### To use forum topics (multi-agent routing):
1. Create a Telegram group with forum/topics enabled
2. Add your bot as admin
3. Create topics: Research, Content, Finance, Strategy, General
4. Send a message in each topic -- check logs for the topic ID numbers
5. Tell me the topic IDs and I'll update `src/agents/base.ts`

### Multi-Bot Agent Identities (Optional)

Each agent can have its own Telegram bot, so messages appear from separate identities (e.g., "Research Bot", "Finance Bot") instead of all coming from the main bot.

**Without multi-bot:** Everything works fine — all agents respond through your main bot.
**With multi-bot:** Each agent sends messages from its own bot account for visual separation.

#### Setup steps:
1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. Create up to 5 agent bots with `/newbot`. Suggested names:
   - `YourName Research Bot` → `yourname_research_bot`
   - `YourName Content Bot` → `yourname_content_bot`
   - `YourName Finance Bot` → `yourname_finance_bot`
   - `YourName Strategy Bot` → `yourname_strategy_bot`
   - `YourName Critic Bot` → `yourname_critic_bot`
3. Copy each bot token and add to `.env`:
   ```
   TELEGRAM_BOT_TOKEN_RESEARCH=token_here
   TELEGRAM_BOT_TOKEN_CONTENT=token_here
   TELEGRAM_BOT_TOKEN_FINANCE=token_here
   TELEGRAM_BOT_TOKEN_STRATEGY=token_here
   TELEGRAM_BOT_TOKEN_CRITIC=token_here
   ```
4. You don't need to set up webhooks — agent bots are outbound-only (send messages, no polling).

Any tokens you skip will gracefully fall back to the main bot. You can add 1, 3, or all 5.

### Cross-Agent Consultation

When enabled (via multi-bot tokens), agents can consult each other during conversations. For example, the General agent can ask Research for data, or Strategy can ask Finance for numbers. This happens automatically through `[INVOKE:agent|question]` tags in the agent's thinking.

### Board Meetings (`/board`)

The `/board` command triggers a multi-agent discussion. All configured agents weigh in on a topic sequentially, then a synthesis is generated. Useful for major decisions.

Example: `/board Should we launch a paid newsletter?`

Each agent responds from its own perspective (Research provides data, Finance runs numbers, Critic stress-tests, etc.).

**Note:** Board meetings work with or without multi-bot tokens. Without them, all responses come from the main bot.

### Tell me:
"Use defaults" or "I want to customize agents" or provide your topic IDs. For multi-bot, share the tokens you created.

---

## Phase 5: Test Core Bot (Required, ~2 min)

### What Claude Code does:
- Runs `bun run start` to start the bot manually
- Tells you to send a test message on Telegram
- Verifies the bot responds
- Ctrl+C to stop

### Tell me:
"Start the test" and then confirm if you got a response on Telegram.

---

## Phase 6: Scheduled Services (Optional, ~10 min)

### Smart Check-ins
Proactive messages based on your goals, schedule, and conversation history.

### Morning Briefing
Daily summary with goals and context from your configured MCP servers.

### What Claude Code does:
- Asks your preferred check-in schedule (or uses defaults from `config/schedule.example.json`)
- Creates `config/schedule.json`
- Generates launchd plist files

### Tell me:
"Set up check-ins and briefings" or "Skip for now"

---

## Phase 6.5: Data Sources (Optional, ~5 min)

### What This Does
Morning briefings pull live data from connected services. Each source auto-enables when its env vars are set — no config files needed.

### Available Sources

| Source | Env Vars Needed | What It Shows |
|--------|----------------|---------------|
| **Goals** | _(always on)_ | Active goals from Supabase/local |
| **AI News** | `XAI_API_KEY` | Top AI news via xAI Grok API |
| **Gmail** | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | Unread email count + top subjects |
| **Calendar** | _(same Google OAuth)_ | Today's events with times |
| **Notion Tasks** | `NOTION_TOKEN`, `NOTION_DATABASE_ID` | Due and overdue tasks |

### Google OAuth Setup (Gmail + Calendar)
Run the interactive setup script:
```bash
bun run setup/setup-google-oauth.ts
```
This opens your browser, authorizes Gmail + Calendar read access, and saves the tokens to `.env`.

**Prerequisites:** A Google Cloud project with Gmail API and Calendar API enabled. The script walks you through it.

### xAI Grok (AI News)
1. Get an API key from [x.ai](https://x.ai)
2. Add to `.env`: `XAI_API_KEY=your_key`

### Notion Tasks
1. Create a [Notion integration](https://www.notion.so/my-integrations)
2. Share your tasks database with the integration
3. Add to `.env`:
   ```
   NOTION_TOKEN=your_integration_token
   NOTION_DATABASE_ID=your_tasks_database_id
   ```
Your Notion database needs `Due` (date) and `Status` (status with "Done") properties.

### Custom Sources
Copy the template and implement your own:
```bash
cp src/lib/data-sources/sources/custom.example.ts src/lib/data-sources/sources/my-source.ts
```
Then import it in `src/lib/data-sources/sources/index.ts`.

### VPS / Hybrid Note
Data sources use direct REST APIs — no MCP servers needed. They work on VPS, local, and hybrid mode equally.

### Tell me:
"Set up data sources" or list which ones you want, or "Skip"

---

## Phase 7: Always-On (Required after Phase 5, ~5 min)

Faster: `tybo setup autostart` (only the bot itself, `telegram-relay`)

### What Claude Code does:
- **macOS**: Runs `bun run setup:launchd -- --service all` to generate and load launchd services
- **Windows/Linux**: Runs `bun run setup:services -- --service all` to configure PM2 + scheduler
- Verifies services are running
- Explains how to check logs and restart services

### Tell me:
"Make it always-on"

---

## Phase 8: Optional Integrations (~5 min each)

### Voice Replies (ElevenLabs)
- Text-to-speech for voice message responses
- Requires: ElevenLabs API key + voice ID

### Phone Calls (ElevenLabs + Twilio)
- AI can call you for urgent check-ins
- Requires: ElevenLabs agent + Twilio phone number

### Audio Transcription (Gemini)
- Transcribe voice messages before sending to Claude
- Requires: Google Gemini API key

### Fallback LLM (OpenRouter / Ollama)
- Backup responses when Claude is unavailable
- **Tier 1 — OpenRouter** (cloud): Recommended. Get a key at [openrouter.ai](https://openrouter.ai), set `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` (default: `minimax/minimax-m2.7`)
- **Tier 2 — Ollama** (local): Offline fallback. Install [Ollama](https://ollama.com), pull a model (default: `qwen3:8b`), set `OLLAMA_MODEL`
- Set `FALLBACK_OFFLINE_ONLY=true` to skip OpenRouter and only use Ollama

### MCP Tools for Fallback Models (Automatic)
When Claude is rate-limited and tybo falls to OpenRouter/Ollama, your MCP tools
(Notion, email, calendar, etc.) now come along for the ride. MCPManager boots your
bun-based MCP servers at startup and provides tools to **any** model in the right format.

- **Zero setup if you already have MCP servers** — auto-discovers bun-based servers from `~/.claude.json`
- **Custom config** — create `config/mcp-servers.json` (see `config/mcp-servers.example.json`)
- **Model-agnostic** — works with DeepSeek, Llama, Qwen, Mistral, GPT-4, or any model that supports function calling
- **Graceful fallback** — if a model doesn't support tools, retries without them automatically
- **Test it:** `bun run setup/test-mcp-client.ts`

### Tell me:
"Set up [integration name]" with your API keys, or "Skip integrations"

---

## Phase 8.5: Scheduled Tasks & Reminders (Optional, ~5 min)

Durable scheduling powered by Convex. Say "remind me at 5pm" or "check emails every morning at 9am" — tasks persist across restarts and fire even when machines are offline.

**Requires:** Convex (Phase 2A). If you're using Supabase, scheduling is not yet available.

### Setup
```bash
bun run setup:convex
```
This reuses your existing `TELEGRAM_BOT_TOKEN` and `TELEGRAM_USER_ID` from `.env` — no re-entry needed.

### Task Types
| Type | Behavior |
|------|----------|
| `reminder` | Send a Telegram notification at the scheduled time |
| `action` | Notify + include the original prompt for execution |
| `recurring` | Repeats: `daily`, `hourly`, `weekly`, `weekdays`, `every Xh`, `every Xm` |

### Architecture
- Convex `ctx.scheduler.runAt()` for durable scheduling
- `convex/scheduledTasks.ts` — backend (create, list, cancel, fire, recurrence)
- `src/lib/convex.ts` — client wrappers
- `src/lib/anthropic-processor.ts` — 3 VPS tools (gated on `CONVEX_URL`)

### Upgrade Path (Existing Users)
```bash
git pull origin master
bun install
bun run setup:convex    # if not using Convex yet
npx convex dev --once   # if already using Convex (deploys new table)
```

Full docs: `docs/scheduling.md`

### Tell me:
"Set up scheduled tasks" or "Skip"

---

## Phase 9: VPS Deployment (Optional, ~30 min)

### What This Does
Deploy the bot to a cloud VPS so it runs 24/7 without depending on your local machine.

| Mode | How It Works | Cost |
|------|-------------|------|
| **Local Only** | Runs on your machine using Claude Code CLI | Claude Pro to get started ($20/mo), Max for full power ($100-200/mo) |
| **VPS** (recommended for 24/7) | Same code on VPS, Claude Code CLI + API key | VPS (~$5/mo) + API costs vary by usage and model selection |
| **Hybrid** | VPS always on, forwards to local when awake | VPS + API costs + subscription |

### How VPS Works — Same Code, Full Power

The key insight: **Claude Code CLI works with an `ANTHROPIC_API_KEY` environment variable.** When set, it uses the Anthropic API (pay-per-token). Without it, Claude Code uses your subscription authentication. Both approaches are compliant — tybo calls `claude -p` (Claude Code's official subprocess mode), not a third-party API client. You still get ALL Claude Code features:

- **MCP servers** — whatever you've configured (email, calendar, databases, etc.)
- **Skills** — Your custom Claude Code skills (presentations, research, etc.)
- **Hooks** — Pre/post tool execution hooks
- **CLAUDE.md** — Project instructions loaded automatically
- **Built-in tools** — WebSearch, Read, Write, Bash, etc.

This means: **clone the repo on VPS, install Claude Code, set your API key, and run `bun run start`.** Same experience as local. One codebase everywhere.

### Tiered Model Routing

All processing paths now include intelligent model routing that classifies message complexity:

| Tier | Model | When | Response Time |
|------|-------|------|--------------|
| **Haiku** | claude-haiku-4-5 | Greetings, status checks, short questions | 2-5s |
| **Sonnet** | claude-sonnet-4-5 | Medium tasks, unclear complexity | 5-15s |
| **Opus** | claude-opus-4-6 | Research, analysis, strategy, long writing | 15-60s |

- **Mac mode:** Routing is UX-only — all messages use Claude Code subprocess (subscription). Sonnet/Opus tier uses **streaming subprocess** (`--output-format stream-json`) that sends live progress updates to Telegram: which tools are being used, first snippet of Claude's plan. Haiku tier uses standard subprocess (instant response, no progress needed).
- **VPS mode:** Routing selects the actual model. Haiku uses direct API (fast), Sonnet/Opus use Agent SDK when enabled.
- **Budget tracking:** Daily cost limit (`DAILY_API_BUDGET`, default $5). Auto-downgrades Opus→Sonnet when budget runs low.

### VPS Gateway + Agent SDK

The VPS gateway (`src/vps-gateway.ts`) now supports two processing modes:

**Direct API (default):** Anthropic Messages API with 2 tools (ask_user, phone_call). Fast (2-5s) but limited capabilities. Used for all Haiku requests and when Agent SDK is disabled.

**Agent SDK (`USE_AGENT_SDK=true`):** Full Claude Code capabilities on VPS for Sonnet/Opus requests. The Agent SDK spawns a Claude Code subprocess that loads:
- Your `CLAUDE.md` (project instructions)
- Your MCP servers (from Claude Code settings via `settingSources: ["user", "project"]`)
- Your skills and hooks
- Built-in tools (Read, Write, Bash, WebSearch, etc.)
- Session persistence for HITL resume

To enable: set `USE_AGENT_SDK=true` in your VPS `.env`. Requires `@anthropic-ai/claude-agent-sdk` (installed via `bun install`).

### VPS Gateway (Direct API)

When Agent SDK is disabled (or for Haiku tier), the VPS gateway falls back to direct Anthropic Messages API — no Claude Code overhead. Responds in 2-5s but with limited capabilities (Supabase context only, no MCP servers or skills).

### Hybrid Mode

VPS catches messages 24/7. When your local machine is awake, forward messages there — local uses Claude Code with your subscription, keeping API costs down. When your machine sleeps, VPS handles it with its own Claude Code + API key.

### What you need:
1. **A VPS** — Any VPS provider works
2. **Anthropic API key** — From [console.anthropic.com](https://console.anthropic.com)
3. **Claude Code CLI** — Installed on your VPS (`npm install -g @anthropic-ai/claude-code`)

### What Claude Code does:
- Walks you through provisioning and hardening the VPS (SSH keys, UFW, fail2ban)
- Installs Bun and Claude Code CLI
- Clones your repo from GitHub
- Sets up `.env` with `ANTHROPIC_API_KEY` + Supabase credentials
- Configures MCP servers on VPS (same ones you use locally)
- Configures PM2 for process management
- Sets up GitHub webhook for auto-deploy (optional)

### VPS .env setup:
```bash
# Required for VPS — enables pay-per-token API access (no subscription login needed on headless servers)
ANTHROPIC_API_KEY=sk-ant-api03-your_key_here

# Same credentials as local
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_USER_ID=your_user_id

# Database — use same backend as local
# Convex:
CONVEX_URL=https://your-deployment.convex.cloud
# Supabase:
# SUPABASE_URL=https://your-project.supabase.co
# SUPABASE_ANON_KEY=your_anon_key
```

### Tell me:
"Deploy to VPS" and I'll walk you through it.

---

## Phase 10: Verification (Required, ~2 min)

### What Claude Code does:
- Runs `bun run setup:verify` for full health check
- Tests all configured services
- Reports pass/fail for each component

### Tell me:
"Run verification"

---

## Giving Claude "Hands" — MCP Servers & Tool Access

Claude Code on its own is a brain — it can think and reason, but it can't interact
with the outside world. **MCP servers** and **direct APIs** are what give it "hands"
to actually do things:

```
Claude Code (brain)
  │
  ├── MCP Server: [email]      → read, send, reply to emails
  ├── MCP Server: [calendar]   → check schedule, create events
  ├── MCP Server: [databases]  → query tasks, update records
  ├── MCP Server: Supabase     → persistent memory, goals, facts
  ├── MCP Server: [your tools] → whatever MCP servers you connect
  │
  └── Built-in Tools           → web search, file read, code execution
```

**How to connect MCP servers:** Follow the setup guides for each MCP server you want.
Once configured in your Claude Code settings, the bot automatically has access to them
because it spawns Claude Code subprocesses that inherit your MCP configuration.

**Local mode:** Claude Code CLI uses your MCP servers directly.
**VPS mode:** Uses Anthropic API with Supabase context. External service access
happens when your local machine handles the message (hybrid mode).

## Project Structure

```
convex/                  # Convex backend (primary database)
  schema.ts              # Table definitions with vector indexes
  messages.ts            # Message CRUD + semantic search
  memory.ts              # Facts, goals, memory context
  logs.ts                # Observability logging
  asyncTasks.ts          # Human-in-the-loop task management
  nodeHeartbeat.ts       # Hybrid mode health tracking
  assets.ts              # File/image storage with Convex Storage
  knowledge.ts           # Structured knowledge base
  scheduledTasks.ts      # Durable scheduled tasks (reminders, recurring)
  interactionScores.ts   # Feedback loop scoring (insert, query, dedup)
  embeddings.ts          # OpenAI embedding generation (actions)
  http.ts                # HTTP webhook routes (future)
scripts/
  migrate-to-convex.ts   # Supabase → Convex data migration
src/
  bot.ts                 # Main relay daemon (local mode, polling)
  vps-gateway.ts         # VPS gateway (webhook mode, Anthropic API)
  smart-checkin.ts       # Proactive check-ins
  morning-briefing.ts    # Daily briefing
  watchdog.ts            # Health monitor
  feedback.ts            # Feedback loop CLI (bun run feedback)
  lib/                   # Shared utilities
    env.ts               # Environment loader
    telegram.ts          # Telegram helpers
    claude.ts            # Claude Code subprocess (local mode) + streaming progress
    anthropic-processor.ts  # Anthropic API processor (VPS mode, direct API)
    agent-session.ts     # Agent SDK processor (VPS mode, full Claude Code)
    model-router.ts      # Complexity classifier + tiered model selection
    mcp-client.ts        # MCPManager — model-agnostic MCP tool access
    mac-health.ts        # Local machine health checking (hybrid mode)
    task-queue.ts        # Human-in-the-loop task management
    asset-store.ts       # Persistent image/file storage with AI descriptions
    convex.ts            # Database client (Convex primary, Supabase fallback)
    supabase.ts          # Supabase client (used as fallback)
    memory.ts            # Facts, goals, intents
    feedback-loop.ts     # Interaction scoring, pattern generation, weekly analysis
    fallback-llm.ts      # Backup LLM chain (with MCP tool support)
    data-sources/        # Pluggable morning briefing data
      types.ts           # DataSource interface
      registry.ts        # Register, discover, fetch all
      google-auth.ts     # Google OAuth token refresh
      sources/           # Individual data sources
        goals.ts         # Supabase goals (built-in)
        grok-news.ts     # AI news via xAI Grok
        gmail.ts         # Unread emails
        calendar.ts      # Today's events
        notion-tasks.ts  # Due/overdue tasks
        custom.example.ts # Template for custom sources
    voice.ts             # ElevenLabs TTS/calls/context
    transcribe.ts        # Gemini transcription (file + buffer)
  agents/                # Multi-agent system
    base.ts              # Agent interface + routing
    index.ts             # Registry
    general.ts           # Orchestrator
    research.ts          # ReAct reasoning
    content.ts           # RoT reasoning
    finance.ts           # CoT reasoning
    strategy.ts          # ToT reasoning
    critic.ts            # Devil's advocate
config/
  profile.md             # User personalization
  schedule.json          # Check-in schedule
  schedule.example.json  # Default schedule template
db/
  schema.sql             # Supabase database schema
deploy.sh               # Auto-deploy script (VPS)
setup/
  install.ts             # Prerequisites checker + installer
  configure-launchd.ts   # macOS launchd plist generator
  configure-services.ts  # Windows/Linux PM2 + scheduler
  verify.ts              # Full health check
  test-telegram.ts       # Telegram connectivity test
  test-supabase.ts       # Supabase connectivity test
  setup-google-oauth.ts  # Google OAuth token setup (Gmail + Calendar)
  configure-convex.ts    # Convex setup for scheduled tasks
  uninstall.ts           # Clean removal (cross-platform)
launchd/
  templates/             # Plist templates for services (macOS)
logs/                    # Service log files
docs/
  architecture.md        # Architecture deep dive
  scheduling.md          # Scheduled tasks & reminders docs
  troubleshooting.md     # Common issues and fixes
```

## Per-Topic Sessions (optional)

With `SESSION_MODE=resume` in `.env`, each Telegram forum topic (and the DM)
keeps one continuous Claude CLI session via `claude -p --resume`: follow-up
messages send only a slim prompt instead of rebuilding the full context.
Sessions expire after `SESSION_IDLE_HOURS` (default 18) of inactivity; ending
sessions with enough substance are automatically distilled into memory
([REMEMBER:]/[GOAL:] extraction). Full design: `docs/topic-sessions.md`.

Telegram commands: `/new` resets the current topic's session, `/topics` shows
the topic→agent mapping (configure in `config/topics.json`, hot-reloaded).
Messages in unmapped topics trigger a one-time ask which agent owns the
topic (since issue #119 via the Rueckfragen-Register, `src/lib/topic-choices.ts`,
buttons also in the browser; old `topicmap:` buttons still work). `/routine [hint]` freezes the workflow demonstrated in
the current topic's session into a reusable artifact ("Teach a Task"): a
Claude Code skill for judgment-heavy flows, or a deterministic script in the
watcher pattern (plus launchd schedule only when the user named one) — see
`src/lib/session-routine.ts`.

Hooks: every CLI subprocess runs with `TYBO_SUBPROCESS=1` (`subprocessEnv()` in
`src/lib/subprocess-env.ts`). Secrets (`*_TOKEN`, `*_KEY`, ...) are not
inherited unless an MCP config references them or `TYBO_SUBPROCESS_ENV_ALLOW`
lists them; see `docs/troubleshooting.md`, "Subprozess vermisst eine Variable". A `Stop` hook that returns `additionalContext` makes
Claude answer twice and only the last message reaches Telegram, so gate such
hooks in `.claude/settings.local.json` with `[ -n "$TYBO_SUBPROCESS" ] ||`.
The streaming parser additionally relays all final turns of a call, not just
the `result` event. Details: `docs/troubleshooting.md`, "Bot Answers About
Something Else".

Neustart nach Code-Aenderungen: nie aus einem Bot-Subprozess heraus
`launchctl kickstart -k`, `launchctl unload/load` oder `kill <Bot-PID>`
ausfuehren. `shutdown()` in `src/bot.ts` killt alle laufenden Subprozesse,
also auch den, der gerade die Antwort schreibt; in Telegram kommt dann nur
"Abgebrochen." an (passiert am 14.9.2026). Stattdessen
`bun run restart:request "Grund"` (legt `data/restart-requested` an): der Bot
startet erst neu, wenn keine Verarbeitung mehr laeuft, also direkt nach der
laufenden Antwort, und launchd (KeepAlive) bzw. PM2 starten ihn wieder.
Ohne Supervisor (nohup) bleibt er laufen und bittet um manuellen Neustart.
Details: `src/lib/restart-request.ts`, `docs/troubleshooting.md`
"Reply Replaced by Abgebrochen".

## Autonome Features (umgesetzt 21.08.2026)

- **`/goal <text>`** (`src/lib/goal-engine.ts`): stehendes Ziel pro Topic. Der
  Bot arbeitet ueber die Topic-Session selbststaendig weiter; nach jedem Turn
  laufen erst Quality Gates (`/goal gate add <cmd>`, deterministische
  Shell-Checks), dann ein Judge auf dem Aux-Modell (done/continue/wait).
  Turn-Budget (`GOAL_MAX_TURNS`, Default 10) mit Weiter?-Rueckfrage statt
  Endlosschleife (seit Issue #118 ueber das Rueckfragen-Register,
  `src/lib/goal-choices.ts`: Knoepfe an die goalId gebunden, auch im Browser). `/goal pause|weiter|stop|status|max <n>`. Zustand in
  `data/goals.json`.
- **`/stop`**: killt die laufenden Claude-Subprozesse des Topics
  (`abortClaudeCalls` in `src/lib/claude.ts`, Prozessbaum via pkill) und
  pausiert ein aktives Ziel. Kein Fallback-LLM bei Abbruch.
- **Session-Review** (`src/lib/session-distill.ts`): beim Session-Ende schlaegt
  der Bot Merk-Eintraege und erkannte Routinen per Inline-Buttons vor, statt
  still zu schreiben (Staging in `data/pending-reviews.json`;
  `DISTILL_AUTO_APPLY=true` stellt das alte Direkt-Schreiben wieder her).
  Laeuft auf dem Aux-Modell (`AUX_MODEL_DISTILL`). Knoepfe seit Issue #117 ueber
  das Rueckfragen-Register (`src/lib/review-choices.ts`), also auch im Browser;
  Vorschlaege aus reinen Web-Gespraechen dort und als Kopie im Direktchat.
- **Merk-Tags aus fremden Inhalten** (`src/lib/intent-gate.ts`, Issue #53): hat
  ein Turn Web, Mail, MCP-Leser, Dateien ausserhalb des Projekts oder eine
  hochgeladene Datei gelesen, landen seine `[REMEMBER:]`/`[GOAL:]`/`[FORGET:]`/
  `[DONE:]`/`[CANCEL:]` als Vorschlag mit Knoepfen im selben Review-Weg, nie
  direkt (auch nicht mit `DISTILL_AUTO_APPLY=true`). Liste der fremden
  Werkzeuge: `src/lib/turn-tools.ts`. Gilt fuer Telegram, WebUI, `/goal` und
  Sprach-Bruecke; unbekannte Werkzeuge (Fallback-Modell) wie bisher direkt, mit Log.
- **Aux-Modell-Routing** (`src/lib/aux-model.ts`): Nebenaufgaben auf eigenen
  Modellen, Format `claude:|openrouter:|ollama:<model>`. Defaults: Goal-Judge
  auf `claude-opus-5` mit effort high (User-Vorgabe: mindestens Opus, xhigh
  war bis 30.8.2026 Fable-exklusiv, geht jetzt auch auf Opus 5), Destillat/Review auf Haiku.
- **`/agent`** (`src/lib/agent-overrides.ts`): Agenten per Telegram anpassen,
  z.B. `/agent research: antworte kuerzer`. Anweisungen liegen in
  `config/agent-overrides.json` (hot-reloaded) und werden an den System-Prompt
  angehaengt; greifen ab der naechsten frischen Session (/new erzwingt sofort).
- **Mention-Routing**: `@agentbot`-Erwaehnung in beliebigem Topic holt diesen
  Agenten (BotRegistry.agentForMention); [INVOKE:]-Konsultationen pro Antwort
  auf `AGENT_INVOKE_BUDGET` (Default 3) gedeckelt.
- **`history_search`** (`src/lib/tools/history-search.ts`): Built-in-Tool, mit
  dem Fallback-Modelle selbst in Historie + Knowledge Base suchen.
- **HITL-Gate fuer schreibende Tools** (PRD Phase 3, `src/lib/tools/registry.ts`):
  requiresApproval-Tools werden angeboten und warten beim Aufruf auf
  Inline-Button-Freigabe (10 Min Frist, sonst abgelehnt).
- **`/help`**: Spickzettel aller Kommandos.

## Useful Commands

```bash
# Local mode (polling, uses Claude Code CLI)
bun run start

# VPS mode (webhook, uses Anthropic API directly)
bun run vps

# WebUI (browser chat in the bot process): WEB_ENABLED=true + WEB_PASSWORD in .env,
# then restart; address is logged as "[web] WebUI läuft: ...". See docs/webui/README.md
bun run restart:request "WebUI aktivieren"

# Datei an den Nutzer schicken (statt curl sendDocument): landet in Telegram und in der WebUI.
# Im Gespraech setzt tybo TYBO_CHAT_ID/TYBO_TOPIC_ID, die Datei kommt damit
# automatisch im richtigen Topic an; ohne diese Variablen in den Direktchat
bun run notify --source datei --file <pfad> [--caption <text>]
# Meldung (Markdown) bzw. gezielt in ein Topic (1 = General): --text <text>, --topic <id>

# Langer Auftrag als Hintergrund-Job (statt setsid + claude -p): meldet sich immer
# zurueck, auch bei Absturz; --full-access nur fuer selbst formulierte Auftraege.
# Details: docs/hintergrund-jobs.md
bun run job start --title "<Titel>" --brief <datei> [--max-hours 6]
bun run job list
bun run job stop <id>
bun run job log <id>

# Run check-in manually
bun run checkin

# Run morning briefing manually
bun run briefing

# Feedback loop (score interactions, generate patterns)
bun run feedback
bun run feedback --analyze

# Full health check
bun run setup:verify

# --- macOS ---
launchctl list | grep ai.tybo                          # Check service status
launchctl unload ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist  # Stop
launchctl load ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist    # Start

# --- VPS (PM2) ---
pm2 start src/vps-gateway.ts --name go-bot --interpreter bun  # Start
pm2 status                         # Check service status
pm2 restart go-bot                 # Restart
pm2 logs go-bot --lines 50        # View logs

# --- Windows/Linux (local mode with PM2) ---
npx pm2 status                      # Check service status
npx pm2 restart tybo-telegram-relay # Restart a service
npx pm2 logs                        # View logs
```

## Troubleshooting

See `docs/troubleshooting.md` for common issues and fixes.

### Quick Fixes

**Bot not responding:**
1. Check if the service is running: `launchctl list | grep ai.tybo.telegram-relay`
2. Check logs: `tail -50 logs/telegram-relay.log`
3. Restart: `launchctl unload ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist && launchctl load ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist` (from a terminal, never from a bot subprocess)

**Claude subprocess failures:**
- JSON responses are often wrapped in ```json``` fences -- the bot strips these automatically
- Bot answers about a different, earlier task in the topic (design fixes, a deploy): a `Stop` hook pushed context after the real answer and only the last message was relayed. Gate the hook on `TYBO_SUBPROCESS` -- see `docs/troubleshooting.md`, "Bot Answers About Something Else"
- Always kill subprocesses on timeout to avoid zombie processes
- Check `claude --version` to ensure CLI is still authenticated
- **Key lesson:** Never use Claude subprocesses to fetch data (email, calendar, etc.) from background scripts. Claude initializes all MCP servers on startup (60-180s). Use direct REST APIs instead -- see `docs/architecture.md`
- **"claude: No such file or directory" in launchd:** The Claude CLI lives in `~/.local/bin/`. launchd plists must include this path: `<string>/Users/YOU/.local/bin:/Users/YOU/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>`. Without it, the bot silently falls back to OpenRouter/Ollama. Check `logs/telegram-relay.error.log` (stderr) for this error — it does NOT appear in the stdout log

**Bot responding via OpenRouter/Ollama instead of Claude:**
- This means `claude -p` is failing. Check `logs/telegram-relay.error.log` for the actual error
- Common causes: Claude CLI not in PATH (see above), subscription limit reached, auth expired
- Verify Claude works: `echo "test" | claude -p --output-format json`

**launchd services not firing on schedule:**
- `StartInterval` pauses during sleep and does NOT catch up
- `StartCalendarInterval` fires immediately after wake if the time was missed
- After editing a plist: unload then load (not just load)

**VPS gateway not processing:**
- Check `ANTHROPIC_API_KEY` is set and valid
- Verify Telegram webhook is set: `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
- Check PM2 logs: `pm2 logs go-bot --lines 50`
- For hybrid mode: verify `MAC_HEALTH_URL` is reachable from VPS

**VPS API errors (401/403):**
- If using external APIs on VPS, ensure your tokens/keys are still valid
- Refresh tokens can expire if unused for 6+ months

**Human-in-the-loop buttons not working:**
- Ensure `async_tasks` table exists in Supabase (run `db/schema.sql`)
- Check that the bot has callback_query permissions (BotFather settings)
- Stale tasks auto-remind after 2 hours

**Supabase connection errors:**
- Verify your keys in `.env` match the Supabase dashboard
- Ensure the `service_role` key is used (not just `anon`) for write operations
- Check that `db/schema.sql` was fully applied (all tables exist)

<!-- Updated February 19, 2026: Clarified deployment modes and authentication following Anthropic's January 2026 ToS enforcement. -->
