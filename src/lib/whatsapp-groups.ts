import { BRAND } from "../brand";
import { isWhatsAppOwner } from "./guest-assistant";
/**
 * WhatsApp Group Management
 *
 * Simulated group chats over WhatsApp via message relay.
 * Each member chats 1:1 with the bot, which relays messages
 * to all other group members. Use @bot or /ask to get a
 * Claude response visible to everyone.
 *
 * Groups are stored in config/whatsapp-groups.json.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GroupConfig {
  name: string;
  members: Record<string, string>; // normalized number → display name
}

export interface GroupsFile {
  groups: Record<string, GroupConfig>;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

const CONFIG_PATH = join(process.cwd(), "config", "whatsapp-groups.json");

export function loadGroups(): GroupsFile {
  if (!existsSync(CONFIG_PATH)) return { groups: {} };
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return { groups: {} };
  }
}

export function saveGroups(groupsFile: GroupsFile): void {
  const temp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(groupsFile, null, 2), { mode: 0o600 });
  renameSync(temp, CONFIG_PATH);
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/**
 * Normalize a WhatsApp number — strips "whatsapp:" prefix and whitespace.
 */
function normalize(num: string): string {
  return num.replace(/^whatsapp:/, "").replace(/\s/g, "").trim();
}

/**
 * Find which group a number belongs to.
 */
export function findGroupForNumber(
  number: string
): { groupId: string; group: GroupConfig; senderName: string } | null {
  const groupsFile = loadGroups();
  const normalized = normalize(number);
  for (const [groupId, group] of Object.entries(groupsFile.groups)) {
    if (normalized in group.members) {
      return { groupId, group, senderName: group.members[normalized] };
    }
  }
  return null;
}

/**
 * Check if a number is in any group (for sender validation).
 */
export function isNumberInAnyGroup(number: string): boolean {
  return findGroupForNumber(number) !== null;
}

// ---------------------------------------------------------------------------
// Bot mention detection
// ---------------------------------------------------------------------------

/**
 * Check if a message should trigger a bot response.
 * Returns the cleaned question, or null if bot wasn't invoked.
 */
export function shouldBotRespond(body: string): { question: string } | null {
  const trimmed = body.trim();

  // /ask <question>
  if (/^\/(ask|frag)\s/i.test(trimmed)) {
    return { question: trimmed.replace(/^\/(ask|frag)\s*/i, "").trim() };
  }

  // @bot <question> or @tybo <question>
  const mentionMatch = trimmed.match(/@(?:bot|tybo)\s+([\s\S]+)/i);
  if (mentionMatch) {
    return { question: mentionMatch[1].trim() };
  }

  return null;
}

/**
 * Check if a message is a /dm (private message to bot, not relayed).
 */
export function isDmMessage(body: string): { message: string } | null {
  if (/^\/dm\s/i.test(body.trim())) {
    return { message: body.trim().replace(/^\/dm\s*/i, "").trim() };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Group Commands (/group ...)
// ---------------------------------------------------------------------------

/**
 * Handle /group commands. Returns a response string.
 */
export function handleGroupCommand(
  senderNumber: string,
  body: string
): string {
  const normalized = normalize(senderNumber);
  const parts = body.trim().split(/\s+/);
  const subcommand = parts[1]?.toLowerCase();

  if (!subcommand || subcommand === "help") {
    return [
      "*WhatsApp Group Commands:*",
      "",
      "/group create <name> — Create a new group",
      "/group add <+number> <name> — Add a member",
      "/group remove <+number> — Remove a member",
      "/group rename <+number> <name> — Change display name",
      "/group list — Show your group details",
      "/group leave — Leave your current group",
      "",
      "*In a group:*",
      "Messages are relayed to all members.",
      `@bot <question> or /ask <question> — ${BRAND.name} responds.`,
      "/dm <message> — Private message to bot (not relayed).",
    ].join("\n");
  }

  if (["create", "add", "remove", "rename"].includes(subcommand) && !isWhatsAppOwner(normalized))
    return "Nur der Owner darf Gruppen und Mitglieder verwalten.";
  const groupsFile = loadGroups();

  switch (subcommand) {
    case "create": {
      const name = parts[2]?.toLowerCase();
      if (!name) return "Usage: /group create <name>";
      if (!/^[a-z0-9_-]+$/.test(name))
        return "Name: lowercase letters, numbers, hyphens, underscores only.";
      if (groupsFile.groups[name])
        return `Group "${name}" already exists.`;

      const existing = findGroupForNumber(normalized);
      if (existing)
        return `You're already in group *${existing.group.name}*. Leave first: /group leave`;

      groupsFile.groups[name] = {
        name: name.charAt(0).toUpperCase() + name.slice(1),
        members: { [normalized]: "Admin" },
      };
      saveGroups(groupsFile);
      return `Group *${name}* created!\n\nAdd members:\n/group add +491234567890 Name`;
    }

    case "add": {
      const rawNumber = parts[2];
      const displayName = parts.slice(3).join(" ") || "Member";
      if (!rawNumber) return "Usage: /group add <+number> <display name>";

      const num = normalize(rawNumber);
      if (!num.startsWith("+"))
        return "Number must start with + (e.g., +491234567890)";

      const myGroup = findGroupForNumber(normalized);
      if (!myGroup)
        return "You're not in a group. Create one: /group create <name>";

      const theirGroup = findGroupForNumber(num);
      if (theirGroup && theirGroup.groupId !== myGroup.groupId)
        return `${num} is already in group *${theirGroup.group.name}*.`;

      groupsFile.groups[myGroup.groupId].members[num] = displayName;
      saveGroups(groupsFile);
      return `Added *${displayName}* (${num}) to *${myGroup.group.name}*`;
    }

    case "remove": {
      const num = normalize(parts[2] || "");
      if (!num) return "Usage: /group remove <+number>";

      const myGroup = findGroupForNumber(normalized);
      if (!myGroup) return "You're not in a group.";

      if (!(num in groupsFile.groups[myGroup.groupId].members))
        return `${num} is not in *${myGroup.group.name}*`;

      if (num === normalized)
        return "Use /group leave to remove yourself.";

      const removedName = groupsFile.groups[myGroup.groupId].members[num];
      delete groupsFile.groups[myGroup.groupId].members[num];
      saveGroups(groupsFile);
      return `Removed *${removedName}* (${num}) from *${myGroup.group.name}*`;
    }

    case "rename": {
      const num = normalize(parts[2] || "");
      const newName = parts.slice(3).join(" ");
      if (!num || !newName)
        return "Usage: /group rename <+number> <new name>";

      const myGroup = findGroupForNumber(normalized);
      if (!myGroup) return "You're not in a group.";

      if (!(num in groupsFile.groups[myGroup.groupId].members))
        return `${num} is not in *${myGroup.group.name}*`;

      groupsFile.groups[myGroup.groupId].members[num] = newName;
      saveGroups(groupsFile);
      return `Renamed ${num} to *${newName}*`;
    }

    case "leave": {
      const myGroup = findGroupForNumber(normalized);
      if (!myGroup) return "You're not in a group.";

      delete groupsFile.groups[myGroup.groupId].members[normalized];
      if (Object.keys(groupsFile.groups[myGroup.groupId].members).length === 0) {
        delete groupsFile.groups[myGroup.groupId];
      }
      saveGroups(groupsFile);
      return `Left *${myGroup.group.name}*. Messages are now 1:1 with ${BRAND.name}.`;
    }

    case "list":
    case "info": {
      const myGroup = findGroupForNumber(normalized);
      if (!myGroup)
        return "You're not in a group. Create one: /group create <name>";

      const memberList = Object.entries(myGroup.group.members)
        .map(
          ([num, name]) =>
            `  ${name} (${num})${num === normalized ? " ← you" : ""}`
        )
        .join("\n");

      return [
        `*Group: ${myGroup.group.name}*`,
        "",
        "Members:",
        memberList,
        "",
        `@bot or /ask — invoke ${BRAND.name}`,
        "/dm <msg> — private message to bot",
      ].join("\n");
    }

    default:
      return `Unknown: /group ${subcommand}\nSend /group help for commands.`;
  }
}
