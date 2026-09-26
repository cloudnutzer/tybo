import { BRAND } from "./brand";
import { runExecution } from "./lib/execution-context";
import { answerGuest, isWhatsAppOwner, saveGuestMessage } from "./lib/guest-assistant";
/**
 * Go - WhatsApp Gateway (Twilio)
 *
 * Receives Twilio WhatsApp webhooks and routes messages through
 * the same Claude pipeline as the Telegram bot. Responds via
 * Twilio REST API.
 *
 * Usage: bun run src/whatsapp-gateway.ts
 *
 * Twilio sends form-encoded POST data to /webhook/whatsapp with fields:
 *   Body, From, To, MessageSid, NumMedia, etc.
 *
 * Required env vars:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, WHATSAPP_USER_NUMBER
 *
 * Optional:
 *   PORT_WHATSAPP (default 3001), TWILIO_WHATSAPP_NUMBER, TWILIO_SANDBOX_NUMBER
 */

import { join } from "path";
import { createHmac } from "crypto";

// ---------------------------------------------------------------------------
// Local Modules
// ---------------------------------------------------------------------------

import { loadEnv, requireEnv, optionalEnv } from "./lib/env";
import {
  callClaude as callClaudeSubprocess,
  isClaudeErrorResponse,
} from "./lib/claude";
import {
  processIntents,
  getMemoryContext,
} from "./lib/memory";
import { callFallbackLLM } from "./lib/fallback-llm";
import {
  saveMessage as saveOwnerMessage,
  getConversationContext,
  log as sbLog,
} from "./lib/convex";
import {
  getAgentConfigOrGeneral,
  getUserProfile,
} from "./agents";
import {
  loadGroups,
  findGroupForNumber,
  isNumberInAnyGroup,
  shouldBotRespond,
  isDmMessage,
  handleGroupCommand,
  type GroupConfig,
} from "./lib/whatsapp-groups";

// ---------------------------------------------------------------------------
// 1. Load Environment
// ---------------------------------------------------------------------------

await loadEnv(join(process.cwd(), ".env"));

// ---------------------------------------------------------------------------
// 2. Configuration
// ---------------------------------------------------------------------------

const TWILIO_ACCOUNT_SID = requireEnv("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN = requireEnv("TWILIO_AUTH_TOKEN");
const WHATSAPP_USER_NUMBER = requireEnv("WHATSAPP_USER_NUMBER");
const WHATSAPP_ALLOWED_NUMBERS_RAW = optionalEnv("WHATSAPP_ALLOWED_NUMBERS", "");

// Build allowlist: always includes WHATSAPP_USER_NUMBER + any extras from WHATSAPP_ALLOWED_NUMBERS
const ALLOWED_NUMBERS: Set<string> = new Set(
  [WHATSAPP_USER_NUMBER, ...WHATSAPP_ALLOWED_NUMBERS_RAW.split(",")]
    .map((n) => normalizeNumber(n.trim()))
    .filter(Boolean)
);
const TWILIO_WHATSAPP_NUMBER = optionalEnv("TWILIO_WHATSAPP_NUMBER", "");
const TWILIO_SANDBOX_NUMBER = optionalEnv("TWILIO_SANDBOX_NUMBER", "+14155238886");
const PORT = parseInt(optionalEnv("PORT_WHATSAPP", "3001"), 10);
const PROJECT_ROOT = process.cwd();
const TIMEZONE = optionalEnv("USER_TIMEZONE", "UTC");

// The "from" number Twilio uses to send messages.
// In sandbox mode, MUST use the sandbox number. Your purchased number only works
// after WhatsApp Business profile approval (Meta verification).
const TWILIO_FROM_NUMBER = TWILIO_SANDBOX_NUMBER || TWILIO_WHATSAPP_NUMBER;

// WhatsApp message character limit
const WHATSAPP_MAX_LENGTH = 4096;

// ---------------------------------------------------------------------------
// 3. Twilio Signature Validation
// ---------------------------------------------------------------------------

/**
 * Validate Twilio webhook signature (X-Twilio-Signature header).
 * See: https://www.twilio.com/docs/usage/security#validating-requests
 */
function validateTwilioSignature(
  signature: string,
  url: string,
  params: Record<string, string>
): boolean {
  // Sort parameters alphabetically by key and concatenate key+value
  const sortedKeys = Object.keys(params).sort();
  let dataString = url;
  for (const key of sortedKeys) {
    dataString += key + params[key];
  }

  const computed = createHmac("sha1", TWILIO_AUTH_TOKEN)
    .update(dataString, "utf-8")
    .digest("base64");

  return computed === signature;
}

/**
 * Normalize a WhatsApp number for comparison.
 * Strips the "whatsapp:" prefix if present.
 */
function normalizeNumber(num: string): string {
  return num.replace(/^whatsapp:/, "").trim();
}

// ---------------------------------------------------------------------------
// 4. Parse Form-Encoded Body
// ---------------------------------------------------------------------------

/**
 * Parse application/x-www-form-urlencoded body into a key-value object.
 */
function parseFormBody(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of body.split("&")) {
    const [rawKey, ...rawValueParts] = pair.split("=");
    if (rawKey) {
      params[decodeURIComponent(rawKey)] = decodeURIComponent(
        rawValueParts.join("=").replace(/\+/g, " ")
      );
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// 5. Twilio REST API — Send Message
// ---------------------------------------------------------------------------

/**
 * Send a WhatsApp message via Twilio REST API.
 * Returns true on success.
 */
async function sendWhatsAppMessage(to: string, body: string): Promise<boolean> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

  const fromNumber = `whatsapp:${TWILIO_FROM_NUMBER}`;
  const toNumber = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;

  const formData = new URLSearchParams({
    From: fromNumber,
    To: toNumber,
    Body: body,
  });

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`Twilio send error (${response.status}):`, errorBody);
      return false;
    }

    return true;
  } catch (error) {
    console.error("Twilio send error:", error);
    return false;
  }
}

/**
 * Send a response, splitting into multiple messages if it exceeds
 * WhatsApp's 4096 character limit.
 */
async function sendWhatsAppResponse(to: string, text: string): Promise<void> {
  if (text.length <= WHATSAPP_MAX_LENGTH) {
    await sendWhatsAppMessage(to, text);
    return;
  }

  // Split at paragraph boundaries
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of text.split("\n\n")) {
    if ((current + "\n\n" + paragraph).length > WHATSAPP_MAX_LENGTH) {
      if (current) chunks.push(current);
      current = paragraph;
    } else {
      current = current ? current + "\n\n" + paragraph : paragraph;
    }
  }
  if (current) chunks.push(current);

  // If any single chunk still exceeds the limit, hard-split it
  const finalChunks: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= WHATSAPP_MAX_LENGTH) {
      finalChunks.push(chunk);
    } else {
      for (let i = 0; i < chunk.length; i += WHATSAPP_MAX_LENGTH) {
        finalChunks.push(chunk.slice(i, i + WHATSAPP_MAX_LENGTH));
      }
    }
  }

  for (const chunk of finalChunks) {
    await sendWhatsAppMessage(to, chunk);
  }
}

// ---------------------------------------------------------------------------
// 6. Claude Processing (reuses same pipeline as bot.ts)
// ---------------------------------------------------------------------------

/**
 * Call Claude Code subprocess with memory, conversation context,
 * and agent config. Same logic as bot.ts callClaude().
 * Falls back to secondary LLMs on error.
 */
async function callClaudeUnlocked(
  userMessage: string,
  chatId: string,
  agentName: string = "general",
  groupContext?: { groupName: string; senderName: string; memberNames: string[] }
): Promise<string> {
  if (groupContext || !chatId.startsWith("wa:") || !isWhatsAppOwner(chatId.slice(3)))
    return answerGuest(chatId, userMessage);
  const agentConfig = getAgentConfigOrGeneral(agentName);
  const userProfile = await getUserProfile();
  const memoryCtx = await getMemoryContext();
  const conversationCtx = await getConversationContext(chatId, 10);

  const now = new Date().toLocaleString("en-US", {
    timeZone: TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  // Build the full prompt
  const sections: string[] = [];

  if (agentConfig) {
    sections.push(agentConfig.systemPrompt);
  } else {
    sections.push(
      "You are Go, a personal AI assistant. Be concise, direct, and helpful."
    );
  }

  if (userProfile) {
    sections.push(`## USER PROFILE\n${userProfile}`);
  }

  sections.push(`## CURRENT TIME\n${now}`);

  if (memoryCtx) {
    sections.push(`## MEMORY\n${memoryCtx}`);
  }

  if (conversationCtx) {
    sections.push(`## RECENT CONVERSATION\n${conversationCtx}`);
  }

  sections.push("## CHANNEL\nWhatsApp: Antworte kurz und mobilfreundlich.");

  // Intent detection instructions
  sections.push(`## INTENT DETECTION
If the user sets a goal, include: [GOAL: description | DEADLINE: deadline]
If a goal is completed, include: [DONE: partial match]
If the user wants to cancel/abandon a goal, include: [CANCEL: partial match]
If you learn a fact worth remembering, include: [REMEMBER: fact]
If the user wants to forget a stored fact, include: [FORGET: partial match]
These tags will be parsed automatically. Include them naturally in your response.`);

  // The actual user message
  sections.push(`## USER MESSAGE\n${userMessage}`);

  const fullPrompt = sections.join("\n\n---\n\n");

  // Call Claude subprocess
  const result = await callClaudeSubprocess({
    prompt: fullPrompt,
    outputFormat: "json",
    ...(agentConfig?.allowedTools
      ? { allowedTools: agentConfig.allowedTools }
      : {}),
    timeoutMs: 1_800_000, // 30 minutes
    cwd: PROJECT_ROOT,
  });

  // Handle errors with fallback
  if (result.isError || !result.text) {
    console.error("Claude error, falling back to secondary LLM...");
    await sbLog("warn", "whatsapp", "Claude failed, using fallback LLM", {
      error: result.text?.substring(0, 200),
    });

    try {
      return await callFallbackLLM(userMessage);
    } catch (fallbackError) {
      console.error("Fallback LLM also failed:", fallbackError);
      return "I'm having trouble processing right now. Please try again in a moment.";
    }
  }

  return result.text;
}

// ---------------------------------------------------------------------------
// 7. Webhook Handler
// ---------------------------------------------------------------------------

/**
 * Process an incoming WhatsApp message in the background.
 * Handles /group commands, /dm private messages, group relay, and 1:1 mode.
 */
async function processWhatsAppMessage(
  from: string,
  body: string
): Promise<void> {
  const senderNumber = normalizeNumber(from);

  // --- /group commands (always available) ---
  if (body.trim().toLowerCase().startsWith("/group")) {
    const response = handleGroupCommand(senderNumber, body);
    await sendWhatsAppResponse(from, response);
    return;
  }

  const groupInfo = findGroupForNumber(senderNumber);

  // --- /dm: private message to bot (bypass group relay) ---
  if (groupInfo) {
    const dm = isDmMessage(body);
    if (dm) {
      console.log(`[WhatsApp] DM from ${groupInfo.senderName} (bypassing group)`);
      await processDirectMessage(from, dm.message);
      return;
    }
  }

  // --- Route to group or direct ---
  if (groupInfo) {
    await processGroupMessage(from, body, groupInfo);
  } else {
    await processDirectMessage(from, body);
  }
}

/**
 * Process a direct 1:1 message (no group).
 */
async function processDirectMessage(
  from: string,
  body: string
): Promise<void> {
  const chatId = `wa:${normalizeNumber(from)}`;

  console.log(`[WhatsApp] Message from ${normalizeNumber(from)}: ${body.length} chars...`);

  // Persist user message
  await saveMessage({
    chat_id: chatId,
    role: "user",
    content: body,
    metadata: { channel: "whatsapp", from: normalizeNumber(from) },
  });

  try {
    // Process with Claude
    const response = await callClaude(body, chatId, "general");

    // Persist bot response
    await saveMessage({
      chat_id: chatId,
      role: "assistant",
      content: response,
      metadata: { channel: "whatsapp", agent: "general" },
    });

    // Process intents (goals, facts, etc.)
    if (isWhatsAppOwner(normalizeNumber(from))) await processIntents(response);

    // Send response via Twilio
    await sendWhatsAppResponse(from, response);

    console.log(`[WhatsApp] Response sent (${response.length} chars)`);
  } catch (error) {
    console.error("[WhatsApp] Processing error:", error);
    await sendWhatsAppMessage(
      from,
      "Sorry, something went wrong processing your message. Please try again."
    );
  }
}

/**
 * Process a message from a group member.
 * Relays to all other members, and optionally invokes the bot.
 */
async function processGroupMessage(
  from: string,
  body: string,
  groupInfo: { groupId: string; group: GroupConfig; senderName: string }
): Promise<void> {
  const { groupId, group, senderName } = groupInfo;
  const senderNumber = normalizeNumber(from);
  const chatId = `wa:group:${groupId}`;

  console.log(`[WhatsApp] Group "${group.name}" message from ${senderName}: ${body.length} chars...`);

  // Persist user message with group context
  await saveMessage({
    chat_id: chatId,
    role: "user",
    content: `[${senderName}]: ${body}`,
    metadata: { channel: "whatsapp", from: senderNumber, group: groupId, senderName },
  });

  // Relay message to all other group members
  const relayText = `[${senderName}]: ${body}`;
  const otherMembers = Object.keys(group.members).filter((n) => n !== senderNumber);

  for (const memberNumber of otherMembers) {
    await sendWhatsAppMessage(memberNumber, relayText);
  }

  console.log(`[WhatsApp] Relayed to ${otherMembers.length} group member(s)`);

  // Check if bot should respond
  const botTrigger = shouldBotRespond(body);
  if (botTrigger) {
    const question = botTrigger.question;
    console.log(`[WhatsApp] Bot triggered in group "${group.name}": ${question.length} chars...`);

    try {
      const response = await callClaude(question, chatId, "general", {
        groupName: group.name,
        senderName,
        memberNames: Object.values(group.members),
      });

      // Persist bot response
      await saveMessage({
        chat_id: chatId,
        role: "assistant",
        content: response,
        metadata: { channel: "whatsapp", agent: "general", group: groupId },
      });

      // Group replies cannot change owner memory.

      // Send bot response to ALL group members (including sender)
      const botReply = `[${BRAND.name}]: ${response}`;
      for (const memberNumber of Object.keys(group.members)) {
        await sendWhatsAppResponse(memberNumber, botReply);
      }

      console.log(`[WhatsApp] Bot response sent to ${Object.keys(group.members).length} member(s)`);
    } catch (error) {
      console.error("[WhatsApp] Group bot processing error:", error);
      await sendWhatsAppMessage(from, "Sorry, I couldn't process that. Try again.");
    }
  }
}

// ---------------------------------------------------------------------------
// 8. HTTP Server
// ---------------------------------------------------------------------------

let isShuttingDown = false;

const server = Bun.serve({
  hostname: process.env.WHATSAPP_HOST || "127.0.0.1",
  maxRequestBodySize: 64 * 1024,
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // ----- Health Check -----
    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({
        status: "ok",
        service: "tybo-whatsapp-gateway",
        uptime: process.uptime(),
        pid: process.pid,
        twilioFrom: TWILIO_FROM_NUMBER,
        timestamp: new Date().toISOString(),
      });
    }

    // ----- Twilio WhatsApp Webhook -----
    if (url.pathname === "/webhook/whatsapp" && req.method === "POST") {
      // Parse form-encoded body
      const rawBody = await req.text();
      const params = parseFormBody(rawBody);

      // Validate Twilio signature
      const signature = req.headers.get("X-Twilio-Signature") || "";
      // Reconstruct the full URL Twilio used to compute the signature.
      // Use the request URL but ensure it matches what Twilio has configured
      // (including any proxy/tunnel URL).
      const webhookUrl =
        optionalEnv("WHATSAPP_WEBHOOK_URL", "") || url.toString();

      if (!validateTwilioSignature(signature, webhookUrl, params)) {
        console.warn("[WhatsApp] Invalid Twilio signature — rejecting request");
        return new Response("Forbidden", { status: 403 });
      }

      const messageBody = params.Body || "";
      const from = params.From || "";
      const messageSid = params.MessageSid || "";

      // Validate sender — allow if in env allowlist OR in any group
      const senderNumber = normalizeNumber(from);

      if (!ALLOWED_NUMBERS.has(senderNumber) && !isNumberInAnyGroup(senderNumber)) {
        console.warn(
          `[WhatsApp] Unauthorized sender: ${senderNumber}`
        );
        // Return 200 with empty TwiML to acknowledge but not respond
        return new Response(
          '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
          {
            headers: { "Content-Type": "application/xml" },
          }
        );
      }

      if (!messageBody.trim()) {
        // No text content (could be media-only) — acknowledge silently
        return new Response(
          '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
          {
            headers: { "Content-Type": "application/xml" },
          }
        );
      }

      console.log(
        `[WhatsApp] Incoming message ${messageSid} from ${senderNumber}`
      );

      // Process in background — return 200 immediately so Twilio doesn't retry
      processWhatsAppMessage(from, messageBody.trim()).catch((err) => {
        console.error("[WhatsApp] Background processing error:", err);
      });

      // Return empty TwiML response (we send the reply via REST API instead)
      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        {
          headers: { "Content-Type": "application/xml" },
        }
      );
    }

    return new Response("Not Found", { status: 404 });
  },
});

// ---------------------------------------------------------------------------
// 9. Graceful Shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\nReceived ${signal}. Shutting down WhatsApp gateway...`);
  await sbLog("info", "whatsapp", `Shutdown: ${signal}`);

  server.stop();
  console.log("Shutdown complete.");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
process.on("uncaughtException", async (error) => {
  console.error("Uncaught exception:", error);
  await sbLog("error", "whatsapp", `Uncaught exception: ${error.message}`, {
    stack: error.stack,
  });
  await shutdown("uncaughtException");
});

// ---------------------------------------------------------------------------
// 10. Startup
// ---------------------------------------------------------------------------

console.log("=".repeat(50));
console.log("Go WhatsApp Gateway - Starting");
console.log("=".repeat(50));
console.log(`PID:         ${process.pid}`);
console.log(`Port:        ${PORT}`);
console.log(`Webhook:     http://localhost:${PORT}/webhook/whatsapp`);
console.log(`Health:      http://localhost:${PORT}/health`);
console.log(`Twilio From: ${TWILIO_FROM_NUMBER}`);
console.log(`Allowed:     ${[...ALLOWED_NUMBERS].join(", ")}`);
const groupsConfig = loadGroups();
const groupCount = Object.keys(groupsConfig.groups).length;
if (groupCount > 0) {
  for (const [gid, g] of Object.entries(groupsConfig.groups)) {
    const memberNames = Object.values(g.members).join(", ");
    console.log(`Group:       "${g.name}" (${gid}) — ${memberNames}`);
  }
}
console.log(`Timezone:    ${TIMEZONE}`);
console.log("=".repeat(50));

await sbLog("info", "whatsapp", "WhatsApp gateway started", {
  pid: process.pid,
  port: PORT,
  from: TWILIO_FROM_NUMBER,
});

async function saveMessage(message: Parameters<typeof saveOwnerMessage>[0]): Promise<boolean> {
  if (message.chat_id.startsWith("wa:") && isWhatsAppOwner(message.chat_id.slice(3))) return saveOwnerMessage(message);
  saveGuestMessage(message.chat_id, message.role, message.content);
  return true;
}

async function callClaude(...args: Parameters<typeof callClaudeUnlocked>): Promise<string> {
  return runExecution(args[1], args[2] || "general", () => callClaudeUnlocked(...args));
}
