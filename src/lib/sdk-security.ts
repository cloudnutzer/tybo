import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

export const shellSecurityHook: HookCallback = async input => {
  if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return {};
  const command = (input.tool_input as { command?: unknown })?.command;
  const blocked = typeof command !== "string" || [
    /rm\s+-rf\s+\/(?!tmp(?:\/|\s|$))/, /mkfs/, /dd\s+if=/,
    /iptables\s+-F/, /systemctl\s+(stop|disable)\s+(docker|traefik|ssh)/,
  ].some(pattern => pattern.test(command));
  return blocked ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: "Blocked by shell security policy" } } : {};
};
