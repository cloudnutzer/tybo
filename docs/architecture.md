# Architecture Overview

> This document provides a bird's-eye view of the entire system:
> components, data flow, session management, memory, error handling,
> and the file/directory structure.

---

## System Overview

```
+-------------------------------------------------------------------+
|                        macOS (launchd)                             |
|                                                                   |
|  +-------------------+  +------------------+  +-----------------+ |
|  | ai.tybo.telegram- |  | ai.tybo.smart-   |  | ai.tybo.morning-| |
|  | relay             |  | checkin          |  | briefing        | |
|  | (always-on)       |  | (scheduled)      |  | (daily)         | |
|  +--------+----------+  +--------+---------+  +--------+--------+ |
|           |                      |                      |         |
|  +--------v----------+  +--------v---------+  +--------v--------+ |
|  | src/bot.ts        |  | src/smart-       |  | src/morning-    | |
|  |                   |  | checkin.ts       |  | briefing.ts     | |
|  | Grammy Bot        |  |                  |  |                 | |
|  | Health Server     |  | Decision Engine  |  | Data Gatherer   | |
|  | Message Handlers  |  | (Claude decides) |  | (parallel fetch)| |
|  +--------+----------+  +--------+---------+  +--------+--------+ |
|           |                      |                      |         |
|           v                      v                      v         |
|  +--------------------------------------------------------+      |
|  |              Shared Libraries (src/lib/)                |      |
|  |                                                        |      |
|  |  claude.ts    -- Subprocess spawning                   |      |
|  |  supabase.ts  -- Database client                       |      |
|  |  memory.ts    -- Facts, goals, intents                 |      |
|  |  telegram.ts  -- Message sending, sanitization         |      |
|  |  voice.ts     -- ElevenLabs TTS + phone calls          |      |
|  |  transcribe.ts -- Gemini audio transcription           |      |
|  |  fallback-llm.ts -- OpenRouter + Ollama fallback       |      |
|  |  env.ts       -- Environment variable loader           |      |
|  +--------+------+-------+------+-------------------------+      |
|           |      |       |      |                                 |
|           v      v       v      v                                 |
|  +--------+  +---+---+  +------+-------+  +---------+            |
|  |Telegram|  |Claude |  |  Supabase    |  | Optional|            |
|  |  API   |  |Code   |  |  (Postgres)  |  |  APIs   |            |
|  |        |  |CLI    |  |              |  | ElevenL.|            |
|  +--------+  +-------+  +--------------+  | Gemini  |            |
|                                            | OpenRtr |            |
|  +-----------------+                       | Ollama  |            |
|  | ai.tybo.watchdog|                       +---------+            |
|  | (hourly)        |                                              |
|  +-----------------+                                              |
+-------------------------------------------------------------------+
```

---

## Component Relationships

### Independent Processes

The system runs as four independent processes, not a monolith:

| Process | Type | Lifecycle |
|---------|------|-----------|
| `src/bot.ts` | Long-running daemon | Always on (launchd KeepAlive / PM2) |
| `src/smart-checkin.ts` | Short-lived script | Runs at scheduled times, exits |
| `src/morning-briefing.ts` | Short-lived script | Runs once daily, exits |
| `src/watchdog.ts` | Short-lived script | Runs hourly, exits |

They share code via `src/lib/` but do not communicate directly with each other.
Communication happens indirectly through:
- **Supabase** (shared database)
- **Telegram** (shared chat)
- **File system** (lock files, state files, logs)

### Shared Libraries

All processes import from `src/lib/`:

```
src/lib/
  env.ts          -- Used by ALL processes (loads .env)
  telegram.ts     -- Used by ALL processes (sends messages)
  claude.ts       -- Used by bot.ts, smart-checkin.ts, morning-briefing.ts
  supabase.ts     -- Used by bot.ts, smart-checkin.ts, morning-briefing.ts
  memory.ts       -- Used by bot.ts (intent processing)
  task-queue.ts   -- Used by bot.ts (human-in-the-loop)
  voice.ts        -- Used by bot.ts only
  transcribe.ts   -- Used by bot.ts only
  fallback-llm.ts -- Used by bot.ts only
```

---

## MCP Servers = Claude's "Hands" (Key Concept)

Claude Code on its own is a brain — it can think and reason, but it can't
interact with the outside world. **MCP servers** are what give it "hands"
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

**How it works:** When the bot spawns a Claude Code subprocess (`claude -p "..."`),
that subprocess inherits your MCP configuration. Whatever MCP servers you've
set up in your Claude Code settings, the bot automatically has access to them.

### Supabase for Data, Claude for Decisions

Background scripts (smart check-ins, morning briefings) need to be fast and
reliable. They use a two-tier approach:

| Task | Approach | Speed |
|------|----------|-------|
| Fetch goals, facts | Supabase REST API directly | <1s |
| Get conversation history | Supabase REST API directly | <1s |
| Make a decision | Claude subprocess | 5-15s |
| Gather daily context | Claude subprocess (uses your MCPs) | 10-60s |
| Process user message | Claude subprocess (with tools) | 10-60s |

**Why not Claude for everything?** Claude Code subprocesses initialize all
configured MCP servers on startup. With many servers, this can take 10-60+
seconds. For simple data reads (goals, facts, messages), hitting Supabase
directly is instant and avoids the overhead.

### Key Files

- `src/smart-checkin.ts` -- Supabase for data, Claude subprocess for decisions only
- `src/morning-briefing.ts` -- Supabase for goals, Claude subprocess to gather context via your MCPs
- `src/lib/claude.ts` -- Claude Code subprocess spawner

---

## Same Code on VPS — How It Works

Claude Code CLI accepts an `ANTHROPIC_API_KEY` environment variable. When set, it uses the Anthropic API directly (pay-per-token). Without it, Claude Code uses your subscription authentication. Both modes load all Claude Code features:

```
Local Machine                        VPS
┌────────────────────┐              ┌────────────────────┐
│ Claude Code CLI    │              │ Claude Code CLI    │
│ + subscription     │              │ + ANTHROPIC_API_KEY│
│   auth             │              │                    │
│ ✅ MCP Servers     │              │ ✅ MCP Servers     │
│ ✅ Skills          │              │ ✅ Skills          │
│ ✅ Hooks           │              │ ✅ Hooks           │
│ ✅ CLAUDE.md       │              │ ✅ CLAUDE.md       │
│ ✅ Built-in Tools  │              │ ✅ Built-in Tools  │
│                    │              │                    │
│ Auth: subscription │              │ Auth: API key      │
└────────────────────┘              └────────────────────┘
         │                                   │
         └──────────┬────────────────────────┘
                    │
             ┌──────┴───────┐
             │  Supabase    │
             │  (shared)    │
             └──────────────┘
```

**Same `bot.ts`, same `bun run start`, same everything.** The only difference
is the billing model. Clone the repo on VPS, install Claude Code, set your API
key, and it works identically.

### VPS Gateway (Optional Speed Optimization)

The `src/vps-gateway.ts` + `src/lib/anthropic-processor.ts` path uses the raw
Anthropic Messages API without Claude Code. This is faster (2-5s vs 10-60s per
message) but has limited capabilities — no MCP servers, no skills, no hooks.
Only Supabase context + `ask_user` + `phone_call` tools.

Use the gateway only if response speed is more important than tool access.

### Hooks in Bot Subprocesses

The subprocess inherits your Claude Code hooks, which is usually what you
want (linting after edits, project conventions). One class of hook is
harmful in a bot: a `Stop` hook that returns `additionalContext`. Claude
treats it as new input and produces a second final message, and only the
last message is relayed to Telegram. In a long-lived resumed session the
hook fires on every turn, so an unrelated question gets answered with work
on an old finding.

Two safeguards (`src/lib/claude.ts`):

- `subprocessEnv()` (`src/lib/subprocess-env.ts`) sets `TYBO_SUBPROCESS=1`
  for every spawned CLI and strips secrets (see troubleshooting, "Subprozess
  vermisst eine Variable"). Gate
  context-pushing hooks on it in your settings:
  `[ -n "$TYBO_SUBPROCESS" ] || <hook command>`.
- `callClaudeStreaming()` tracks text per API turn (`message.id`) and joins
  all final turns instead of returning only the `result` event.

See `docs/troubleshooting.md`, "Bot Answers About Something Else".

### Agent Tool Access

Agents no longer restrict which tools Claude can use. By default, every agent
gets full access to all Claude Code capabilities — MCP servers, skills, hooks,
built-in tools. If you want to restrict a specific agent, you can optionally
add `allowedTools` to its config:

```typescript
// Full access (default — no allowedTools field)
const config: AgentConfig = {
  name: "Research Agent",
  model: "claude-opus-4-5-20251101",
  reasoning: "ReAct",
  personality: "analytical, thorough",
  systemPrompt: "..."
};

// Restricted access (optional)
const config: AgentConfig = {
  name: "Restricted Agent",
  allowedTools: ["Read", "WebSearch"],  // Only these tools available
  ...
};
```

---

## Data Flow: Message Lifecycle

A complete message lifecycle from send to response:

```
1. User types "Research AI agents" in the Research topic on Telegram

2. Telegram servers deliver the update to Grammy via long polling

3. Security middleware checks user ID (src/bot.ts:210)
   PASS: userId matches ALLOWED_USER_ID

4. handleTextMessage() fires (src/bot.ts:232)
   - Text: "Research AI agents"
   - Topic ID: 3 (maps to "research" agent)
   - No built-in command match

5. saveMessage() persists to Supabase (src/lib/supabase.ts:175)
   - Tries edge function for embedding generation
   - Falls back to direct insert

6. callClaudeAndReply() begins (src/bot.ts:767)
   - Creates typing indicator
   - Calls callClaude()

7. callClaude() assembles context (src/bot.ts:656)
   - Loads Research agent config (src/agents/research.ts)
   - Loads user profile (config/profile.md)
   - Gets memory context (facts + goals from Supabase)
   - Gets conversation context (last 10 messages)
   - Adds session resumption note
   - Adds intent detection instructions
   - Joins all sections with --- separators

8. callClaudeSubprocess() spawns CLI (src/lib/claude.ts:69)
   - claude -p "<full prompt>" --output-format json
   - --allowedTools WebSearch,WebFetch,Read,Glob,Grep
   - --resume <sessionId>
   - 30-minute timeout with process kill

9. Claude Code processes the request
   - Follows ReAct reasoning from the Research agent prompt
   - May use WebSearch, WebFetch to gather information
   - Returns JSON with result and session_id

10. Response processing (src/bot.ts:729-760)
    - Parse JSON output
    - Update session ID
    - Check for errors -> fallback LLM chain if needed

11. Back in callClaudeAndReply() (src/bot.ts:780-798)
    - Save response to Supabase
    - processIntents() scans for [GOAL:], [DONE:], [REMEMBER:] tags
    - sendResponse() delivers to Telegram

12. sendResponse() (src/lib/telegram.ts:108)
    - Check for embedded image tags
    - Split long messages (>4000 chars) at paragraph boundaries
    - Send with Markdown parsing, fall back to plain text on error

13. User sees the response in Telegram
```

---

## Session Management

### How Sessions Work

Claude Code maintains conversation context through session IDs.
The bot persists the session ID in `session-state.json`:

```json
{
  "sessionId": "abc123-def456-ghi789",
  "pendingFiles": []
}
```

On each message:
1. Load session state from disk
2. Pass `--resume <sessionId>` to Claude
3. Claude continues the conversation context
4. Claude returns a (possibly new) session ID
5. Save updated session ID to disk

### Stale Sessions

Sessions can become stale if:
- The Claude CLI is updated (session format changes)
- The session expires server-side
- The session file is corrupted

When a stale session is detected (Claude returns an error), the bot
falls back to starting a new session without `--resume`.

### Timeout Handling

Chat-Turns über den Streaming-Weg haben zwei Grenzen (Issue #178):
Leerlauf (Standard 15 Minuten ohne stream-json-Zeile) und eine Obergrenze
(Standard 90 Minuten). Ein Lauf, der sichtbar arbeitet, darf also länger
laufen; einer, der hängt, wird früher beendet. Der JSON-Weg liefert erst am
Ende Ausgabe und bleibt bei 30 Minuten Gesamtzeit. Werte und `.env`-Schalter:
`docs/troubleshooting.md`, Abschnitt "Claude Timeout".

On timeout, the subprocess tree is **killed** (not just abandoned), via
`terminateProcessTree()` in `src/lib/process-tree.ts` (SIGTERM an die
Prozessgruppe, SIGKILL nach 1,5 Sekunden).

This prevents zombie processes from accumulating.

---

## Memory Architecture

### Two-Tier Storage

```
Tier 1: Supabase (persistent, searchable, shared across processes)
  - messages table: conversation history
  - memory table: facts, goals
  - logs table: structured logging
  - call_transcripts: phone call records

Tier 2: Local files (fallback when Supabase unavailable)
  - memory.json: facts and goals
  - session-state.json: Claude session ID
  - checkin-state.json: check-in timing state
```

### Memory Flow

```
User message arrives
  |
  v
saveMessage() --> Supabase (messages table)
  |
  v
Claude processes --> response with intent tags
  |
  v
processIntents() --> Parse [GOAL:], [DONE:], [REMEMBER:]
  |                         |
  v                         v
addGoal()/addFact()    completeGoal()
  |                         |
  v                         v
Supabase (memory table) or memory.json (fallback)
```

### Context Assembly

Before each Claude call, memory is gathered:

```
getMemoryContext()        --> "Known Facts: ...\nActive Goals: ..."
getConversationContext()  --> "[2m ago] User: ...\n[1m ago] Bot: ..."
getUserProfile()          --> contents of config/profile.md
```

All three are injected into the prompt so Claude has full context.

---

## Error Handling: The Fallback Chain

```
Claude Code (primary)
  |
  | Error? (auth failure, rate limit, timeout)
  v
OpenRouter (cloud fallback)
  |
  | Error? (API key missing, service down)
  v
Ollama (local fallback)
  |
  | Error? (not running, model not downloaded)
  v
Static error message: "I'm having trouble connecting..."
```

Each tier is tried in order. The response indicates which tier was used:

```
Normal:   [response from Claude]
Fallback: [response from OpenRouter] _(responded via fallback)_
Error:    "I'm having trouble connecting to all my backends..."
```

---

## File and Directory Structure

```
tybo/
  .env                          # Your API keys (never committed)
  .env.example                  # Template with placeholder values
  .gitignore                    # Excludes .env, node_modules, logs, etc.
  CLAUDE.md                     # Setup guide (read by Claude Code)
  README.md                     # Project overview
  package.json                  # Dependencies and npm scripts
  tsconfig.json                 # TypeScript configuration
  bun.lock                      # Dependency lock file

  src/
    bot.ts                      # Main relay daemon (877 lines)
    smart-checkin.ts            # Proactive check-in script (287 lines)
    morning-briefing.ts         # Daily briefing script (230 lines)
    watchdog.ts                 # Health monitor (122 lines)

    lib/
      env.ts                    # .env file loader (40 lines)
      claude.ts                 # Claude subprocess spawner (201 lines)
      supabase.ts               # Supabase client + all DB ops (533 lines)
      memory.ts                 # Unified memory with fallback (290 lines)
      telegram.ts               # Telegram helpers (195 lines)
      voice.ts                  # ElevenLabs TTS + calls (214 lines)
      transcribe.ts             # Gemini transcription (78 lines)
      fallback-llm.ts           # OpenRouter + Ollama chain (89 lines)
      task-queue.ts             # Human-in-the-loop task management

    agents/
      base.ts                   # AgentConfig interface, topic map, cross-agent (156 lines)
      index.ts                  # Registry and exports (53 lines)
      general.ts                # Orchestrator agent (80 lines)
      research.ts               # ReAct reasoning (56 lines)
      content.ts                # RoT reasoning (56 lines)
      finance.ts                # CoT reasoning (60 lines)
      strategy.ts               # ToT reasoning (62 lines)
      critic.ts                 # Devil's advocate (75 lines)
      custom-agent.example.ts   # Template for new agents (63 lines)

  config/
    profile.example.md          # User profile template
    schedule.example.json       # Check-in schedule template

  db/
    schema.sql                  # Supabase database schema (150 lines)

  setup/
    install.ts                  # Prerequisites checker + installer (cross-platform)
    configure-launchd.ts        # launchd plist generator (macOS)
    configure-services.ts       # PM2 + scheduler setup (Windows/Linux)
    verify.ts                   # Full health check (cross-platform)
    uninstall.ts                # Clean removal (cross-platform)

  launchd/                        # macOS service templates
    ai.tybo.telegram-relay.plist.template
    ai.tybo.smart-checkin.plist.template
    ai.tybo.morning-briefing.plist.template
    ai.tybo.watchdog.plist.template

  logs/                         # Service log files (gitignored)
  temp/                         # Temporary files (gitignored)
  uploads/                      # Downloaded media files (gitignored)
  docs/                         # Course documentation (you are here)
```

---

## Design Principles

1. **Single user, full power.** This is a personal AI system, not a SaaS product.
2. **Graceful degradation.** Missing APIs disable features, they do not crash.
3. **Process isolation.** Each service is independent -- one crashing does not take others down.
4. **Context over memory.** Claude gets full context each call rather than relying on session persistence alone.
5. **Local fallback.** Supabase down? Use local files. Claude down? Use OpenRouter. OpenRouter down? Use Ollama.

---

**Next document:** [Troubleshooting](./troubleshooting.md)

<!-- Updated February 19, 2026: Clarified deployment modes and authentication following Anthropic's January 2026 ToS enforcement. -->
