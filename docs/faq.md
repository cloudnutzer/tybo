# Frequently Asked Questions

---

## Deployment & Costs

### How do the three deployment modes handle authentication?

tybo supports three deployment modes. Local mode uses the official Claude Code CLI directly — you're running Anthropic's own product. VPS and Hybrid modes use standard API keys under the Commercial Terms, which is the clearest path for any production or always-on deployment.

**Local mode** uses your Claude Code CLI directly. You authenticate Claude Code on your machine (subscription login), and tybo spawns `claude -p` subprocesses. This works while your machine is on.

**VPS mode** uses the Anthropic API with your own `ANTHROPIC_API_KEY` from console.anthropic.com. Pay-per-token. Works 24/7 on a headless server.

**Hybrid mode** (recommended) combines both: VPS with API key catches messages 24/7. When your local machine is awake, it forwards there — your Claude Code CLI handles it via subscription. When your machine sleeps, VPS processes with API tokens.

| | Local | VPS | Hybrid |
|---|---|---|---|
| **Auth** | Claude Code CLI (subscription) | API key (pay-per-token) | Both |
| **Availability** | While machine is on | 24/7 | 24/7 |
| **Cost** | Pro ($20/mo) to start, Max ($100-200/mo) for full power | VPS (~$5/mo) + API costs vary by usage and model | VPS + API costs + subscription |
| **Best for** | Personal use, testing | Always-on reliability | Best of both worlds |

**A note on Anthropic's ToS (Updated February 20, 2026):** In January 2026, Anthropic cracked down on third-party tools that extracted OAuth tokens from Claude subscriptions and used them in their own API clients. tybo does not do this — it calls `claude -p`, which is Claude Code itself. Your Claude Code handles its own authentication. tybo never touches, extracts, or forwards any OAuth tokens.

On February 19, 2026, Anthropic published updated [Legal and Compliance docs](https://code.claude.com/docs/en/legal-and-compliance) stating that subscription OAuth tokens are intended exclusively for Claude Code and Claude.ai, and that the Agent SDK requires API key authentication. For local use on your own computer, Claude Code works as it always has. If you're using tybo for business or always-on deployments, use API keys (VPS mode) with tybo's smart routing (Haiku for simple, Sonnet for medium, Opus for complex) to keep costs manageable.

---

### Do I need a VM to use my subscription on a server?

No. For always-on deployment, use VPS mode with an API key — it's simpler, cheaper, and more reliable than running a desktop OS on a server. API costs vary based on usage and model selection — tybo uses smart routing (Haiku for simple, Sonnet for medium, Opus for complex) to keep costs down. You can also use OpenRouter as a fallback (which supports hundreds of models) or even install a local model via Ollama on your VPS for fully self-hosted operation (requires more VPS resources/storage).

If you want your local machine to handle messages while it's awake (saving on API costs), use hybrid mode.

---

### I want to offer this as a service to clients (e.g., "CEO Operating System for SMBs"). What's the best architecture?

Use the **VPS + API key** approach. For each client:

1. Provision a VPS (~$5/mo per client)
2. Set up an Anthropic API key (their own or yours)
3. Deploy tybo with their profile, agents, and integrations
4. API costs vary by usage and model selection — smart routing keeps costs manageable

Your margin is the difference between what you charge and the per-client infrastructure cost (VPS + API usage). This is clean, scalable, and doesn't require any hacks with subscriptions or VMs.

---

### What's the difference between local mode, VPS mode, and hybrid mode?

| Mode | How it works | Cost | Best for |
|------|-------------|------|----------|
| **Local** | Runs on your machine with Claude Code CLI | Pro ($20/mo) to start, Max ($100-200/mo) for full power | Personal use, testing |
| **VPS** | Runs on a cloud server with API key | ~$5/mo VPS + API costs vary by usage | 24/7 reliability |
| **Hybrid** | VPS always on, forwards to local when awake | VPS + API costs + subscription | Saving on API costs |

**Hybrid** gives you the best of both worlds: your local machine handles messages via your Claude Code CLI (subscription) when it's awake, and the VPS takes over with API tokens when it's not.

---

## Setup Issues

### Bun says "command not found" after installing

Bun installs to `~/.bun/bin/` which may not be in your shell's PATH. Restart your terminal, or run:

```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```

Add those lines to your `~/.zshrc` (macOS) or `~/.bashrc` (Linux) to make it permanent.

---

### Supabase keys look different from the docs

Supabase recently renamed their API keys:

- **"anon public key"** is now called **"Publishable key"** and may start with `sb_publishable_` instead of `eyJ`
- **"service_role secret key"** is now called **"Secret key"** and may start with `sb_secret_` instead of `eyJ`

Both formats work. Paste whatever your Supabase dashboard shows. If Claude Code questions the format, tell it Supabase updated their key naming and it's correct.

---

### Claude Code keeps asking for permission during setup

This is normal. Claude Code asks before running shell commands or editing files. Select **"Allow for this session"** to approve all similar actions during the setup process.

---

### macOS shows "Software from Jared Sumner can run in the background"

This popup appears when launchd services start. Jared Sumner is the creator of the Bun runtime, which powers the bot. Click **Allow** to let the services run. You can manage this later in System Settings > General > Login Items.

---

### Claude says it's hitting sandbox restrictions on Supabase calls

This happens when the Claude subprocess runs without full permissions. The bot needs `--dangerously-skip-permissions` in `src/lib/claude.ts` to allow outbound network calls and tool access in non-interactive mode. This was fixed in commit `e43d96a` — make sure you have the latest version.

---

---

### tybo only works with Telegram?

tybo starts with Telegram as the primary interface, but it can be connected to other platforms. Community members have already connected tybo to **Google Chat, Microsoft Teams, Discord, WhatsApp, Slack**, and more. The core AI processing, memory, and agent logic are platform-agnostic — Telegram is just the default messaging layer.

---

## More Help

- [Architecture Deep Dive](./architecture.md)
- [Troubleshooting Guide](./troubleshooting.md)

<!-- Updated February 20, 2026: Updated ToS section to reflect Anthropic's Feb 19 Legal and Compliance docs update. Added Agent SDK API key requirement and smart routing recommendation. -->
