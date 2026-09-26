/**
 * Go - Voice Module (Optional)
 *
 * TTS: Qwen3-TTS lokal via MLX (primary, kostenlos/offline) →
 *      ElevenLabs → Gemini 2.5 Flash (Cloud-Fallbacks).
 * Phone calls: ElevenLabs Conversational AI + Twilio.
 * All functions gracefully skip if API keys aren't configured.
 */

import { spawn } from "bun";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import * as db from "./convex";
import { isMacAlive } from "./mac-health";
import { getCapabilitiesText } from "./capabilities";
import { voiceAgentName } from "./voice-agent-name";

// Lokales TTS: Qwen3-TTS auf Apple Silicon (mlx-audio im eigenen venv).
// Automatisch aktiv, wenn das venv existiert; abschaltbar via LOCAL_TTS=false.
const LOCAL_TTS_PYTHON = () =>
  process.env.LOCAL_TTS_PYTHON ||
  `${process.env.HOME}/.venvs/qwen3-tts/bin/python`;
const LOCAL_TTS_ENABLED = () =>
  process.env.LOCAL_TTS !== "false" && existsSync(LOCAL_TTS_PYTHON());
const LOCAL_TTS_MODEL = () =>
  process.env.LOCAL_TTS_MODEL ||
  "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit";
// Verfuegbare Stimmen: serena, vivian, uncle_fu, ryan, aiden, ono_anna, sohee, eric, dylan
const LOCAL_TTS_VOICE = () => process.env.LOCAL_TTS_VOICE || "vivian";
const LOCAL_TTS_LANG = () => process.env.LOCAL_TTS_LANG || "de";
const LOCAL_TTS_TIMEOUT_MS = 180_000;

const GEMINI_API_KEY = () => process.env.GEMINI_API_KEY || "";
const GEMINI_TTS_VOICE = () => process.env.GEMINI_TTS_VOICE || "Kore";
const ELEVENLABS_API_KEY = () => process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = () => process.env.ELEVENLABS_VOICE_ID || "";
const ELEVENLABS_AGENT_ID = () => process.env.ELEVENLABS_AGENT_ID || "";
const ELEVENLABS_PHONE_NUMBER_ID = () =>
  process.env.ELEVENLABS_PHONE_NUMBER_ID || "";
const USER_PHONE_NUMBER = () => process.env.USER_PHONE_NUMBER || "";

/**
 * Convert raw PCM (16-bit, 24kHz, mono) to WAV by prepending a 44-byte RIFF header.
 * Zero dependencies — pure math.
 */
function pcmToWav(pcmBuffer: Buffer): Buffer {
  const sampleRate = 24000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Local TTS via Qwen3-TTS on MLX. Generates WAV via subprocess, converts to
 * OGG/Opus (Telegram voice format) with ffmpeg. Returns null on any failure
 * so the caller falls through to cloud TTS. Model load dominates latency
 * (~20-60s cold on the M4 Air) — acceptable for voice replies.
 */
async function localTextToSpeech(text: string): Promise<Buffer | null> {
  const voiceText = text.length > 4500 ? text.substring(0, 4500) + "..." : text;
  const prefix = `tybo_tts_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const wavPath = `/tmp/${prefix}_000.wav`;
  const oggPath = `/tmp/${prefix}.ogg`;

  try {
    const gen = spawn({
      cmd: [
        LOCAL_TTS_PYTHON(),
        "-m",
        "mlx_audio.tts.generate",
        "--model",
        LOCAL_TTS_MODEL(),
        "--voice",
        LOCAL_TTS_VOICE(),
        "--lang_code",
        LOCAL_TTS_LANG(),
        "--text",
        voiceText,
        "--file_prefix",
        prefix,
      ],
      cwd: "/tmp",
      stdout: "ignore",
      stderr: "pipe",
    });
    const killTimer = setTimeout(() => gen.kill(), LOCAL_TTS_TIMEOUT_MS);
    const exitCode = await gen.exited;
    clearTimeout(killTimer);

    if (exitCode !== 0 || !existsSync(wavPath)) {
      const stderr = await new Response(gen.stderr).text().catch(() => "");
      console.error(
        `Local TTS failed (exit ${exitCode}): ${stderr.substring(stderr.length - 300)}`
      );
      return null;
    }

    const ff = spawn({
      cmd: ["ffmpeg", "-y", "-loglevel", "error", "-i", wavPath, "-c:a", "libopus", "-b:a", "48k", oggPath],
      stdout: "ignore",
      stderr: "ignore",
    });
    const ffTimer = setTimeout(() => ff.kill(), 30_000);
    const ffExit = await ff.exited;
    clearTimeout(ffTimer);

    // OGG/Opus ist das native Telegram-Voice-Format; ohne ffmpeg tut es auch das WAV
    const outPath = ffExit === 0 && existsSync(oggPath) ? oggPath : wavPath;
    const buffer = Buffer.from(readFileSync(outPath));
    return buffer.length > 1000 ? buffer : null;
  } catch (error) {
    console.error("Local TTS error:", error);
    return null;
  } finally {
    for (const p of [wavPath, oggPath]) {
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {}
    }
  }
}

/**
 * Convert text to speech: local Qwen3-TTS first (free, offline),
 * then ElevenLabs, then Gemini. Returns audio buffer or null.
 */
export async function textToSpeech(text: string): Promise<Buffer | null> {
  // Tier 0: local Qwen3-TTS (MLX)
  if (LOCAL_TTS_ENABLED()) {
    const local = await localTextToSpeech(text);
    if (local) return local;
    console.error("Local TTS unavailable — falling back to cloud TTS");
  }

  // Try ElevenLabs first
  if (ELEVENLABS_API_KEY() && ELEVENLABS_VOICE_ID()) {
    try {
      const voiceText =
        text.length > 4500 ? text.substring(0, 4500) + "..." : text;

      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID()}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": ELEVENLABS_API_KEY(),
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text: voiceText,
            model_id: "eleven_multilingual_v2",
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
            },
          }),
        }
      );

      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }

      console.error(`ElevenLabs TTS error: ${response.status}`);
      // Fall through to Gemini
    } catch (error) {
      console.error("ElevenLabs TTS error:", error);
      // Fall through to Gemini
    }
  }

  // Fallback to Gemini
  if (!GEMINI_API_KEY()) {
    return null;
  }

  try {
    const voiceText =
      text.length > 4500 ? text.substring(0, 4500) + "..." : text;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${GEMINI_API_KEY()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: voiceText }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: GEMINI_TTS_VOICE() },
              },
            },
          },
        }),
      }
    );

    if (!response.ok) {
      console.error(`Gemini TTS error: ${response.status}`);
      return null;
    }

    const result = await response.json();
    const audioData = result.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!audioData) {
      console.error("Gemini TTS: no audio data in response");
      return null;
    }

    // Gemini returns raw PCM (16-bit, 24kHz, mono) — convert to WAV
    const pcmBuffer = Buffer.from(audioData, "base64");
    return pcmToWav(pcmBuffer);
  } catch (error) {
    console.error("TTS error:", error);
    return null;
  }
}

/**
 * Erster Satz des Anrufs; der Agent nennt sich mit VOICE_AGENT_NAME (Standard BRAND.name).
 */
export function callGreeting(userName: string, context: string, agentName: string = voiceAgentName()): string {
  return context
    ? `Hallo ${userName}, hier ist ${agentName}. Du wolltest reden: ${context.substring(0, 120)}. Wo fangen wir an?`
    : `Hallo ${userName}, hier ist ${agentName}. Ich melde mich kurz: Was beschäftigt dich gerade?`;
}

/**
 * Initiate a phone call via ElevenLabs + Twilio.
 */
export async function initiatePhoneCall(
  context: string,
  userName: string = "User"
): Promise<{
  success: boolean;
  message: string;
  conversationId?: string;
}> {
  if (
    !ELEVENLABS_API_KEY() ||
    !ELEVENLABS_AGENT_ID() ||
    !ELEVENLABS_PHONE_NUMBER_ID() ||
    !USER_PHONE_NUMBER()
  ) {
    return { success: false, message: "Phone call not configured" };
  }

  try {
    console.log("📞 Initiating phone call...");

    // Get context for the call (with fallbacks for empty data)
    let memoryContext = "";
    let conversationHistory = "";
    try {
      memoryContext = await db.getMemoryContext();
      const chatId = process.env.TELEGRAM_USER_ID || "";
      const recentMessages = await db.getRecentMessages(chatId, 10);
      conversationHistory = recentMessages
        .map((m) => {
          const role = m.role === "user" ? userName : "Bot";
          return `${role}: ${m.content.substring(0, 200)}`;
        })
        .join("\n");
    } catch (err) {
      console.error("Failed to load call context from Supabase:", err);
    }

    if (!memoryContext) {
      memoryContext = "No stored memory available. Start fresh.";
    }
    if (!conversationHistory) {
      conversationHistory = "No recent messages. This is a new conversation.";
    }

    const berlinTime = new Date().toLocaleString("en-US", {
      timeZone: process.env.USER_TIMEZONE || "UTC",
      weekday: "long",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const response = await fetch(
      "https://api.elevenlabs.io/v1/convai/twilio/outbound-call",
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agent_id: ELEVENLABS_AGENT_ID(),
          agent_phone_number_id: ELEVENLABS_PHONE_NUMBER_ID(),
          max_duration_seconds: 300,
          to_number: USER_PHONE_NUMBER(),
          conversation_initiation_client_data: {
            dynamic_variables: {
              user_name: userName,
              current_time: berlinTime,
              call_reason: context || "general check-in",
              memory: memoryContext.substring(0, 1000),
              recent_telegram: conversationHistory.substring(0, 2000),
            },
          },
          first_message: callGreeting(userName, context),
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("Call error:", response.status, error);
      return { success: false, message: error };
    }

    const result = await response.json();
    return {
      success: true,
      message: result.message || "Call started!",
      conversationId: result.conversation_id,
    };
  } catch (error) {
    console.error("Phone call error:", error);
    return { success: false, message: String(error) };
  }
}

/**
 * Fetch call transcript from ElevenLabs API.
 */
export async function getCallTranscript(
  conversationId: string
): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`,
      { headers: { "xi-api-key": ELEVENLABS_API_KEY() } }
    );

    if (!response.ok) return null;

    const data = await response.json();
    if (data.status !== "done") return null;

    return (
      data.transcript
        ?.map(
          (msg: any) =>
            `${msg.role === "agent" ? "Bot" : "User"}: ${msg.message}`
        )
        .join("\n") || ""
    );
  } catch {
    return null;
  }
}

/**
 * Poll for call transcript completion (up to 15 min).
 */
export async function waitForTranscript(
  conversationId: string
): Promise<string | null> {
  const maxAttempts = 90;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10000));
    const transcript = await getCallTranscript(conversationId);
    if (transcript) return transcript;
  }
  return null;
}

/**
 * Check if voice features (TTS) are configured.
 * ElevenLabs (primary) or Gemini (fallback).
 */
export function isVoiceEnabled(): boolean {
  return (
    LOCAL_TTS_ENABLED() ||
    !!(ELEVENLABS_API_KEY() && ELEVENLABS_VOICE_ID()) ||
    !!GEMINI_API_KEY()
  );
}

/**
 * Check if phone calls are configured.
 */
export function isCallEnabled(): boolean {
  return !!(
    ELEVENLABS_API_KEY() &&
    ELEVENLABS_AGENT_ID() &&
    ELEVENLABS_PHONE_NUMBER_ID() &&
    USER_PHONE_NUMBER()
  );
}

/**
 * Summarize a phone call transcript using Anthropic API.
 * Falls back to truncated transcript if API unavailable.
 */
export async function summarizeTranscript(
  transcript: string
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey && !process.env.OPENROUTER_API_KEY) {
    return transcript.substring(0, 500) + "\n\n(Full summary unavailable)";
  }

  try {
    const { createResilientMessage, getModelForProvider } = await import("./resilient-client");

    const response = await createResilientMessage({
      model: getModelForProvider("claude-opus-5-5"),
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `Summarize this phone call transcript concisely. Include key points, decisions made, and any action items.\n\n${transcript.substring(0, 6000)}`,
        },
      ],
    });

    const textBlocks = response.content.filter(
      (b) => b.type === "text"
    );
    return textBlocks.map((b) => b.text).join("\n") || "No summary generated.";
  } catch (err: any) {
    console.error("Transcript summarization error:", err.message);
    return transcript.substring(0, 500) + "\n\n(Summarization failed)";
  }
}

/**
 * Extract an actionable task from a call transcript.
 * Returns the task description as a direct instruction, or null if no task.
 */
export async function extractTaskFromTranscript(
  transcript: string,
  summary: string
): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENROUTER_API_KEY) return null;

  try {
    const { createResilientMessage, getModelForProvider } = await import("./resilient-client");

    const response = await createResilientMessage({
      model: getModelForProvider("claude-opus-5-5"),
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: `Analyze this phone call transcript and summary. Did the caller request a specific actionable task?

SUMMARY: ${summary}

TRANSCRIPT (last 2000 chars):
${transcript.slice(-2000)}

If there is a clear, actionable task request (e.g. "create a presentation", "draft an email", "research X", "set up Y"), respond with ONLY the task description as a direct instruction. Start with a verb.

If there is NO actionable task (just a conversation, check-in, or general discussion), respond with exactly: NONE`,
        },
      ],
    });

    const textBlocks = response.content.filter(
      (b) => b.type === "text"
    );
    const output = textBlocks.map((b) => b.text).join("").trim();

    if (
      !output ||
      output === "NONE" ||
      output.toLowerCase().includes("no actionable task") ||
      output.length < 10
    ) {
      return null;
    }

    return output.replace(/^["']|["']$/g, "").replace(/^Task:\s*/i, "").trim();
  } catch (err: any) {
    console.error("Task extraction error:", err.message);
    return null;
  }
}

/**
 * Build dynamic context payload for ElevenLabs voice agent.
 * Called by the /context endpoint when ElevenLabs agent starts a call.
 */
export async function buildVoiceAgentContext(): Promise<Record<string, any>> {
  const userName = process.env.USER_NAME || "User";
  const userTimezone = process.env.USER_TIMEZONE || "UTC";

  const now = new Date();
  const localTime = now.toLocaleString("en-US", {
    timeZone: userTimezone,
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  // Gather context from Supabase
  let memory = "";
  let recentChat = "";
  let goals = "";

  try {
    memory = await db.getMemoryContext();
    const chatId = process.env.TELEGRAM_USER_ID || "";
    const messages = await db.getRecentMessages(chatId, 5);
    recentChat = messages
      .map((m) => {
        const role = m.role === "user" ? userName : "Bot";
        return `${role}: ${m.content.substring(0, 200)}`;
      })
      .join("\n");
    const activeGoals = await db.getActiveGoals();
    goals = activeGoals
      .map((g) => `- ${g.content}${g.deadline ? ` (by ${g.deadline})` : ""}`)
      .join("\n");
  } catch (err) {
    console.error("Voice context fetch error:", err);
  }

  // Ensure ElevenLabs agent always has usable context
  if (!memory) memory = "No stored memory available. Start fresh.";
  if (!recentChat) recentChat = "No recent messages. This is a new conversation.";
  if (!goals) goals = "No active goals set.";

  const hybrid = isMacAlive();
  const capabilities = getCapabilitiesText(hybrid);
  const mode = hybrid ? "hybrid" : "vps";

  console.log(`Voice context: mode=${mode}, memory=${memory.length}chars, chat=${recentChat.length}chars, goals=${goals.length}chars`);

  return {
    user_name: userName,
    current_time: localTime,
    timezone: userTimezone,
    memory: memory.substring(0, 2000),
    recent_telegram: recentChat.substring(0, 2000),
    active_goals: goals.substring(0, 1000),
    mode,
    capabilities,
  };
}
