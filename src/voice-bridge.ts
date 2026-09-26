import { BRAND } from "./brand";
import { reserveBudget, settleBudget } from "./lib/daily-budget";
/**
 * Voice-Bridge: tybo im Echtzeitmodus fuer den ElevenLabs-Agenten (Name aus VOICE_AGENT_NAME, Standard BRAND.name).
 *
 * ElevenLabs (Custom LLM) -> https://bridge.example.com (eigener Cloudflare Tunnel)
 *   -> dieser Prozess (Port 8013) -> claude-opus-5 via Anthropic Messages API
 *
 * Anschluesse an tybo (siehe docs/voice-agent-bridge-anleitung.html):
 *   - Kontext: general-Agent-Prompt + profile.md + Memory + letzte 20 Nachrichten (10 Min Cache)
 *   - Tools:   history_search aus der Built-in-Registry (lokal ausgefuehrt)
 *   - Historie: jeder Turn per saveMessage (type voice_call)
 *   - Denkauftrag: POST /process an den laufenden Bot, Antwort kommt in Telegram
 *
 * Start: bun run src/voice-bridge.ts   (launchd: ai.tybo.voice-bridge)
 */

import { join } from "path";
import { loadEnv } from "./lib/env";

await loadEnv(join(process.cwd(), ".env"));

// Dynamische Imports: erst nach loadEnv, weil die Module process.env beim Laden lesen.
const { deepThinkText, handleBridge, stripTags } = await import("./lib/voice-bridge/bridge");
const { voiceAgentName } = await import("./lib/voice-agent-name");
type BridgeEnv = import("./lib/voice-bridge/bridge").BridgeEnv;
type BridgeHooks = import("./lib/voice-bridge/bridge").BridgeHooks;
await import("./lib/tools/index");
const { getBuiltinTool, callBuiltinTool } = await import("./lib/tools/registry");
const { getUserProfile } = await import("./agents/base");
const { default: generalAgent } = await import("./agents/general");
const { getMemoryContext } = await import("./lib/memory");
const { processTurnIntents } = await import("./lib/intent-gate");
const { setReviewNotifier } = await import("./lib/session-distill");
const { createReviewNotifier } = await import("./lib/review-choices");
const { createTelegramChoices } = await import("./lib/telegram-choices");
const { Api } = await import("grammy");
type TurnTools = import("./lib/turn-tools").TurnTools;
const { getRecentMessages, saveMessage } = await import("./lib/convex");

const PORT = parseInt(process.env.VOICE_BRIDGE_PORT || "8013", 10);
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const BOT_PROCESS_URL = `http://localhost:${process.env.HEALTH_PORT || "3000"}/process`;
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || "";
const CONTEXT_TTL_MS = 10 * 60_000;
const LOCAL_TOOL_NAMES = ["history_search"];

const env: BridgeEnv = {
  VOICE_ANTHROPIC_API_KEY: process.env.VOICE_ANTHROPIC_API_KEY || "",
  VOICE_BRIDGE_TOKEN: process.env.VOICE_BRIDGE_TOKEN || "",
  VOICE_MODEL: process.env.VOICE_MODEL,
  VOICE_DEFAULT_EFFORT: process.env.VOICE_DEFAULT_EFFORT,
  VOICE_AGENT_NAME: process.env.VOICE_AGENT_NAME,
};

if (!env.VOICE_ANTHROPIC_API_KEY) console.error("[voice-bridge] VOICE_ANTHROPIC_API_KEY fehlt in .env");
if (!env.VOICE_BRIDGE_TOKEN) console.error("[voice-bridge] VOICE_BRIDGE_TOKEN fehlt in .env");

// ---------------------------------------------------------------------------
// Kontext: einmal pro Gespraech (10 Min Cache), nicht pro Turn
// ---------------------------------------------------------------------------

let contextCache: { text: string; at: number } | null = null;

function relTime(iso?: string): string {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 60 / 24)}d`;
}

async function buildContext(): Promise<string> {
  const [profile, memory, recent] = await Promise.all([
    getUserProfile().catch(() => ""),
    getMemoryContext().catch(() => ""),
    CHAT_ID ? getRecentMessages(CHAT_ID, 20).catch(() => []) : Promise.resolve([]),
  ]);
  const recentText = recent
    .map((m) => `[${relTime(m.created_at)}] ${m.role === "user" ? "User" : "Bot"}: ${m.content.replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");
  const now = new Date().toLocaleString("de-DE", { timeZone: process.env.USER_TIMEZONE || "Europe/Berlin", dateStyle: "full", timeStyle: "short" });
  return [
    generalAgent.systemPrompt,
    profile ? `## USER PROFILE\n${profile}` : "",
    `## CURRENT TIME\n${now}`,
    memory ? `## MEMORY\n${memory}` : "",
    recentText ? `## RECENT TELEGRAM CONVERSATION\n${recentText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

async function loadContext(): Promise<string> {
  if (contextCache && Date.now() - contextCache.at < CONTEXT_TTL_MS) return contextCache.text;
  const started = Date.now();
  const text = await buildContext();
  contextCache = { text, at: Date.now() };
  console.log(`[voice-bridge] Kontext geladen: ${text.length} Zeichen in ${Date.now() - started} ms`);
  return text;
}

// ---------------------------------------------------------------------------
// Lokale Tools aus der Built-in-Registry
// ---------------------------------------------------------------------------

function localTools() {
  return LOCAL_TOOL_NAMES.map((name) => getBuiltinTool(name))
    .filter((t): t is NonNullable<typeof t> => !!t && t.isAvailable())
    .map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}

async function runLocalTool(name: string, input: Record<string, unknown>): Promise<string> {
  const started = Date.now();
  const result = await callBuiltinTool(name, input);
  console.log(`[voice-bridge] Tool ${name} in ${Date.now() - started} ms${result.isError ? " (Fehler)" : ""}`);
  return result.content.slice(0, 6000);
}

// ---------------------------------------------------------------------------
// Historie + Intent-Tags
// ---------------------------------------------------------------------------

// Merk-Vorschlaege aus Turns mit fremden Inhalten (Issue #53, #117): eigener
// Prozess ohne pollenden Bot. Die Rueckfrage kommt in dasselbe Register
// (data/choices.json), Versand und Festhalten wie im Bot (sendChoice ueber die
// Bot-API); Klicks aus Telegram und Browser beantwortet der laufende Bot
const reviewChoices = createTelegramChoices({ api: new Api(process.env.TELEGRAM_BOT_TOKEN || ""), owner: CHAT_ID });
setReviewNotifier(createReviewNotifier({ sendChoice: (choice) => reviewChoices.sendChoice(choice) }));

async function persistTurn(userText: string, assistantRaw: string, tools: TurnTools): Promise<void> {
  if (!CHAT_ID) return;
  // Intent-Tags weg (siehe bridge.ts) und v3-Audio-Tags wie [excited] oder [thoughtful],
  // die ElevenLabs dem LLM fuer eleven_v3 nahelegt; die gehoeren in den Ton, nicht in die Historie.
  const spokenText = stripTags(assistantRaw)
    .replace(/\[[a-z][a-z ,'-]{1,30}\]/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  await saveMessage({ chat_id: CHAT_ID, role: "user", content: userText, metadata: { type: "voice_call", agent: "general" } });
  if (spokenText) {
    await saveMessage({ chat_id: CHAT_ID, role: "assistant", content: spokenText, metadata: { type: "voice_call", agent: "general" } });
  }
  if (/\[(REMEMBER|GOAL|DONE|CANCEL|FORGET):/i.test(assistantRaw)) {
    const outcome = await processTurnIntents(assistantRaw, tools, { chatId: CHAT_ID, origin: "Sprach-Brücke" }).catch((err) => {
      console.error("[voice-bridge] processIntents:", err);
      return "none" as const;
    });
    if (outcome === "applied") contextCache = null; // neue Fakten beim naechsten Gespraech sofort dabei
  }
}

// ---------------------------------------------------------------------------
// Denkauftrag: an den laufenden Bot, Antwort kommt ueber die normale Pipeline
// ---------------------------------------------------------------------------

async function deepThink(question: string): Promise<void> {
  const text = deepThinkText(question, voiceAgentName(env));
  if (!GATEWAY_SECRET || !CHAT_ID) throw new Error("GATEWAY_SECRET and TELEGRAM_USER_ID required for deep thinking");
  const res = await fetch(BOT_PROCESS_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...(GATEWAY_SECRET ? { authorization: `Bearer ${GATEWAY_SECRET}` } : {}) },
    body: JSON.stringify({ text, chatId: CHAT_ID }),
  });
  if (!res.ok) throw new Error(`Bot /process ${res.status}: ${await res.text()}`);
  console.log(`[voice-bridge] Denkauftrag an ${BRAND.name} uebergeben: ${question.slice(0, 80)}`);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const hooks: BridgeHooks = { loadContext, localTools, runLocalTool, persistTurn, deepThink,
  reserveRequest: () => { const id = reserveBudget("voice", Number(process.env.VOICE_REQUEST_RESERVATION_USD || "1")); return () => settleBudget(id); },
};

Bun.serve({
  hostname: process.env.VOICE_BRIDGE_HOST || "127.0.0.1",
  maxRequestBodySize: 256 * 1024,
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const started = Date.now();
    const res = await handleBridge(req, env, hooks, (p) => {
      p.catch((err) => console.error("[voice-bridge] Hintergrund:", err));
    });
    if (new URL(req.url).pathname.endsWith("/chat/completions")) {
      console.log(`[voice-bridge] Turn gestartet (${res.status}) nach ${Date.now() - started} ms`);
    }
    return res;
  },
});

console.log(
  `[voice-bridge] laeuft auf :${PORT} (Modell ${env.VOICE_MODEL || "claude-opus-5"}, Effort ${env.VOICE_DEFAULT_EFFORT || "medium"}, Tools: ${localTools().map((t) => t.name).join(", ") || "keine"})`
);
