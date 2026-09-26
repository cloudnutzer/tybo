/**
 * TTS Built-in — Text in Sprache umwandeln und als Telegram-Voice an
 * den Owner schicken.
 *
 * Nutzt die bestehende Tier-Kette aus voice.ts (lokales Qwen3-TTS →
 * ElevenLabs → Gemini), Name bleibt elevenlabs_tts wie im PRD.
 * Empfaenger ist fest TELEGRAM_USER_ID — Inward-Aktion, kein HITL noetig.
 */

import { textToSpeech, isVoiceEnabled } from "../voice";
import { optionalCredential } from "../credentials";
import { registerBuiltinTool } from "./registry";

function botToken(): string {
  return optionalCredential("TELEGRAM_BOT_TOKEN");
}

function ownerChatId(): string {
  return optionalCredential("TELEGRAM_USER_ID");
}

registerBuiltinTool({
  name: "elevenlabs_tts",
  description:
    "Convert text to speech and send it as a voice message to the user's Telegram chat. Use when the user asks for a voice reply or an audio version of a text.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The text to speak (max ~4500 chars, longer is truncated)",
      },
    },
    required: ["text"],
  },
  isAvailable: () => isVoiceEnabled() && !!botToken() && !!ownerChatId(),
  handler: async (args) => {
    const text = String(args.text || "").trim();
    if (!text) return JSON.stringify({ error: "text ist leer" });

    const audio = await textToSpeech(text);
    if (!audio) {
      return JSON.stringify({
        error: "TTS fehlgeschlagen (alle Engines: lokal, ElevenLabs, Gemini)",
      });
    }

    const form = new FormData();
    form.append("chat_id", ownerChatId());
    form.append("voice", new Blob([new Uint8Array(audio)]), "response.ogg");

    const res = await fetch(
      `https://api.telegram.org/bot${botToken()}/sendVoice`,
      { method: "POST", body: form, signal: AbortSignal.timeout(60_000) }
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Telegram HTTP ${res.status}: ${errText.substring(0, 200)}`);
    }
    return JSON.stringify({
      success: true,
      chars: text.length,
      audioBytes: audio.length,
      sent_to: "owner DM",
    });
  },
});
