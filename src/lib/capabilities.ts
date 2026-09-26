/**
 * Capabilities Module — Single source of truth for what the bot can do.
 *
 * Mode-aware: "hybrid" when Mac is alive (full Claude Code + MCP),
 * "vps" when running standalone (Anthropic API + Agent SDK).
 *
 * Used by the ElevenLabs voice agent context endpoint so the agent
 * knows its own capabilities and never says "I can't do this."
 */

export interface Capabilities {
  mode: "vps" | "hybrid";
  capabilities: string[];
  limitations: string[];
}

const ALWAYS_AVAILABLE: string[] = [
  "Answer questions and have natural conversations",
  "Check your calendar and summarize upcoming events",
  "Summarize recent emails and flag important ones",
  "Check and update your Notion tasks and projects",
  "Set goals, reminders, and notes in memory",
  "Search your conversation history and stored memory",
  "Run morning briefings and smart check-ins",
  "Search the web and do research",
  "Analyze images you send",
  "Transcribe and respond to voice messages",
  "Extract tasks from conversations and execute them after the call",
];

const HYBRID_ONLY: string[] = [
  "Full MCP access — Notion, Google Workspace, and all connected services",
  "Create and edit Google Docs, Sheets, and Slides",
  "Send emails and manage calendar events directly",
  "Execute complex multi-step tasks with Claude Code",
  "Access all custom skills — presentations, content creation, WordPress",
  "Run bash commands and interact with the file system",
];

const LIMITATIONS: string[] = [
  "Cannot browse websites live during a phone call",
  "Cannot send messages or emails during the call itself",
  "Tasks requested during calls are queued and executed after the call ends",
  "Phone call duration is limited to 5 minutes",
];

/**
 * Get structured capabilities based on current mode.
 */
export function getCapabilities(isHybrid: boolean): Capabilities {
  return {
    mode: isHybrid ? "hybrid" : "vps",
    capabilities: isHybrid
      ? [...ALWAYS_AVAILABLE, ...HYBRID_ONLY]
      : [...ALWAYS_AVAILABLE],
    limitations: [...LIMITATIONS],
  };
}

/**
 * Get a formatted text block for use in prompts / dynamic variables.
 */
export function getCapabilitiesText(isHybrid: boolean): string {
  const caps = getCapabilities(isHybrid);
  const lines: string[] = [];

  lines.push(`Mode: ${caps.mode.toUpperCase()}`);
  lines.push("");
  lines.push("What you CAN do:");
  for (const c of caps.capabilities) {
    lines.push(`- ${c}`);
  }
  lines.push("");
  lines.push("Current limitations:");
  for (const l of caps.limitations) {
    lines.push(`- ${l}`);
  }

  return lines.join("\n");
}
