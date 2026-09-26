# Scheduled Tasks & Reminders

tybo can schedule reminders, deferred actions, and recurring tasks that fire via Telegram — even when your computer is off.

## How It Works

```
You: "Remind me at 5pm to check emails"
  ↓
tybo → Claude detects scheduling intent → calls schedule_task tool
  ↓
Convex saves task + registers durable timer (ctx.scheduler.runAt)
  ↓
At 5pm → Convex fires internal action → sends Telegram message
  ↓
You get: "⏰ Reminder: check emails"
```

**Key insight:** Convex's scheduler runs in the cloud. Tasks persist across restarts, survive VPS reboots, and fire on time regardless of your machine's state. This is fundamentally different from Claude Code's `/loop` command, which dies when you close the terminal.

## Setup

### 1. Create a Convex account

Go to [convex.dev](https://convex.dev) and sign up (free tier is generous).

### 2. Initialize Convex in your project

```bash
npx convex dev --once --configure=new
```

This creates your Convex deployment and adds `CONVEX_URL` to your `.env`.

### 3. Set Telegram credentials in Convex

Convex needs your bot token to send notifications when tasks fire:

```bash
npx convex env set TELEGRAM_BOT_TOKEN <your_bot_token>
npx convex env set TELEGRAM_CHAT_ID <your_telegram_user_id>
```

### 4. Verify it works

Send a message to your bot: "Remind me in 2 minutes to test the scheduler"

You should get a Telegram notification 2 minutes later.

## Task Types

### Reminder
Just sends a notification at the scheduled time.

```
"Remind me at 3pm to pick up groceries"
"In 30 minutes, remind me about the call"
```

### Action
Sends a notification and prompts you to execute it. Reply to the message to have tybo act on it.

```
"Check my emails at 5pm"
"Summarize today's news at 8pm"
```

### Recurring
Repeats on a pattern. Fires indefinitely until cancelled.

```
"Every morning at 9am, give me a news summary"
"Remind me every 2 hours to drink water"
"Every weekday at 5pm, check my inbox"
```

## Recurrence Patterns

| Pattern | Fires |
|---------|-------|
| `daily` | Every 24 hours at the same time |
| `hourly` | Every hour |
| `weekly` | Every 7 days at the same time |
| `weekdays` | Monday–Friday at the same time |
| `every 2h` | Every 2 hours |
| `every 30m` | Every 30 minutes |

## Managing Tasks

### List scheduled tasks
```
"What's scheduled?"
"Show my reminders"
"List upcoming tasks"
```

### Cancel a task
```
"Cancel the email reminder"
"Remove the 5pm check"
"Stop the recurring news summary"
```

Cancellation matches against task descriptions — partial matches work.

## Architecture

### Files

| File | Purpose |
|------|---------|
| `convex/schema.ts` | `scheduledTasks` table definition with indexes |
| `convex/scheduledTasks.ts` | All Convex functions: create, list, cancel, fire, recurrence |
| `src/lib/scheduled-tasks.ts` | Client wrapper (ConvexHttpClient) + time parser |
| `src/lib/anthropic-processor.ts` | Tool definitions + executors for VPS mode |

### Convex Functions

| Function | Type | Purpose |
|----------|------|---------|
| `create` | mutation | Create task + register `ctx.scheduler.runAt` |
| `list` | query | List tasks by chatId + status filter |
| `getById` | query | Get single task |
| `cancel` | mutation | Cancel by ID, also cancels Convex scheduled function |
| `cancelBySearch` | mutation | Cancel by prompt text match |
| `fire` | internal action | Sends Telegram message when timer fires |
| `markFired` | internal mutation | Updates status after firing |
| `scheduleNext` | internal mutation | Creates next occurrence for recurring tasks |

### Flow

1. User message → Anthropic processor → Claude detects scheduling intent
2. Claude calls `schedule_task` tool with type, prompt, ISO timestamp
3. Tool executor parses time → calls Convex `scheduledTasks.create` mutation
4. Mutation inserts row + calls `ctx.scheduler.runAt(timestamp, fire, {taskId})`
5. At scheduled time, Convex fires `fire` internal action
6. Action reads task → sends Telegram message via Bot API
7. If recurring → `scheduleNext` mutation creates next occurrence + schedules it

### Why Convex (not Supabase)?

Supabase doesn't have built-in scheduled functions. You'd need an external cron service or a polling loop. Convex's `ctx.scheduler.runAt` is:

- **Durable** — survives deployments and restarts
- **Precise** — fires at exact millisecond
- **Serverless** — no polling process to maintain
- **Free** — generous free tier for personal use

The rest of tybo (messages, memory, goals) still uses Supabase. Convex is only used for scheduling.

## Troubleshooting

**Tasks not firing:**
- Check that `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set in Convex env: `npx convex env list`
- Check Convex dashboard for errors: `npx convex dashboard`
- Verify `CONVEX_URL` is set in your `.env`

**"Could not parse time" errors:**
- Claude should pass ISO 8601 timestamps. If it's confused, try being explicit: "at 5:00 PM Berlin time"
- The time parser also handles "in 2 hours", "5pm", "17:00" as fallbacks

**Recurring tasks stopped:**
- Check the Convex dashboard for failed scheduled functions
- If Convex had a temporary outage, the chain breaks. Create a new recurring task.

**Cancel not matching:**
- Cancellation uses partial text match. Try shorter search terms.
- "cancel email" will match any task containing "email" in its prompt.

## /loop vs Convex Scheduling

| Feature | Claude Code /loop | tybo + Convex |
|---------|------------------|----------------|
| Persistence | Session-only, dies on terminal close | Cloud-based, survives everything |
| Time limit | 3-day hard cap | Indefinite |
| Computer sleep | Paused | Fires anyway |
| Recurring | Yes, but limited to 3 days | Forever |
| Setup | Zero (built into CLI) | 5 min (Convex account + deploy) |
| Where it runs | Your terminal | Convex cloud → Telegram |
