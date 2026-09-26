/**
 * Go - Audio Transcription (Optional)
 *
 * Priority chain: Local Whisper.cpp → ElevenLabs STT → Gemini (fallback).
 * Falls back to a placeholder if nothing is configured.
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { spawn } from "bun";
import { join } from "path";

const ELEVENLABS_API_KEY = () => process.env.ELEVENLABS_API_KEY || "";
const GEMINI_API_KEY = () => process.env.GEMINI_API_KEY || "";

// Whisper.cpp configuration
const WHISPER_CLI = process.env.WHISPER_CLI_PATH || "whisper-cli";
const WHISPER_MODEL_PATH =
  process.env.WHISPER_MODEL_PATH ||
  join(process.cwd(), "models", "ggml-medium.bin");

/**
 * Check if local Whisper is available (binary + model file).
 */
function isWhisperAvailable(): boolean {
  return existsSync(WHISPER_MODEL_PATH);
}

/**
 * Transcribe an audio file. Priority: Whisper.cpp → ElevenLabs → Gemini.
 * Supports OGG (Telegram voice), MP3, WAV, etc.
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  // Try local Whisper first
  if (isWhisperAvailable()) {
    try {
      const result = await transcribeWithWhisper(filePath);
      if (result && result.trim().length > 0) {
        return result;
      }
    } catch (error) {
      console.error("Whisper transcription error:", error);
      // Fall through to cloud providers
    }
  }

  // Try ElevenLabs
  if (ELEVENLABS_API_KEY()) {
    try {
      const audioBuffer = await readFile(filePath);
      return await transcribeWithElevenLabs(audioBuffer, filePath);
    } catch (error) {
      console.error("ElevenLabs transcription error:", error);
      // Fall through to Gemini
    }
  }

  // Fallback to Gemini
  if (GEMINI_API_KEY()) {
    return transcribeWithGemini(filePath);
  }

  return "[Voice transcription unavailable - no transcription provider configured]";
}

/**
 * Transcribe audio using local whisper.cpp.
 * Supports OGG, MP3, WAV, FLAC directly.
 */
async function transcribeWithWhisper(filePath: string): Promise<string> {
  const args = [
    "--model", WHISPER_MODEL_PATH,
    "--language", "auto",
    "--no-timestamps",
    "--no-prints",
    "--file", filePath,
  ];

  const proc = spawn({
    cmd: [WHISPER_CLI, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  // Timeout: 60 seconds (medium model on Apple Silicon should be well under this)
  const timeoutMs = 60_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  clearTimeout(timer);

  if (timedOut) {
    throw new Error("Whisper transcription timed out");
  }

  if (exitCode !== 0) {
    throw new Error(`Whisper exited with code ${exitCode}: ${stderr}`);
  }

  return stdout.trim();
}

/**
 * Transcribe audio using ElevenLabs Speech-to-Text API.
 */
async function transcribeWithElevenLabs(
  audioBuffer: Buffer,
  filePath: string
): Promise<string> {
  const ext = filePath.split(".").pop()?.toLowerCase() || "ogg";
  const mimeMap: Record<string, string> = {
    ogg: "audio/ogg",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    webm: "audio/webm",
  };
  const mimeType = mimeMap[ext] || "audio/ogg";

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([new Uint8Array(audioBuffer)], { type: mimeType }),
    `audio.${ext}`
  );
  formData.append("model_id", "scribe_v1");

  const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY(),
    },
    body: formData,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs STT error ${response.status}: ${errText}`);
  }

  const result = await response.json();
  return result.text || "[Could not transcribe audio]";
}

/**
 * Transcribe audio using Gemini (last resort fallback).
 */
async function transcribeWithGemini(filePath: string): Promise<string> {
  try {
    const audioBuffer = await readFile(filePath);
    const base64Audio = audioBuffer.toString("base64");

    const ext = filePath.split(".").pop()?.toLowerCase() || "ogg";
    const mimeMap: Record<string, string> = {
      ogg: "audio/ogg",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      m4a: "audio/mp4",
      webm: "audio/webm",
    };
    const mimeType = mimeMap[ext] || "audio/ogg";

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: "Transcribe this audio message accurately. Only output the transcription, nothing else.",
                },
                {
                  inline_data: {
                    mime_type: mimeType,
                    data: base64Audio,
                  },
                },
              ],
            },
          ],
        }),
      }
    );

    const result = await response.json();
    return (
      result.candidates?.[0]?.content?.parts?.[0]?.text ||
      "[Could not transcribe audio]"
    );
  } catch (error) {
    console.error("Gemini transcription error:", error);
    return "[Transcription failed]";
  }
}

/**
 * Transcribe audio from an in-memory buffer.
 * Used by the VPS gateway where files aren't written to disk.
 * Note: Whisper.cpp requires a file, so we write a temp file for it.
 */
export async function transcribeAudioBuffer(
  audioBuffer: Buffer,
  mimeType: string = "audio/ogg"
): Promise<string> {
  // For local Whisper, write to temp file
  if (isWhisperAvailable()) {
    try {
      const ext = mimeType.split("/").pop() || "ogg";
      const tmpPath = join(process.cwd(), "uploads", `whisper_tmp_${Date.now()}.${ext}`);
      const { mkdir, writeFile, unlink } = await import("fs/promises");
      await mkdir(join(process.cwd(), "uploads"), { recursive: true });
      await writeFile(tmpPath, audioBuffer);
      const result = await transcribeWithWhisper(tmpPath);
      await unlink(tmpPath).catch(() => {});
      if (result && result.trim().length > 0) {
        return result;
      }
    } catch (error) {
      console.error("Whisper buffer transcription error:", error);
      // Fall through
    }
  }

  // Try ElevenLabs
  if (ELEVENLABS_API_KEY()) {
    try {
      const ext = mimeType.split("/").pop() || "ogg";
      const formData = new FormData();
      formData.append(
        "file",
        new Blob([new Uint8Array(audioBuffer)], { type: mimeType }),
        `audio.${ext}`
      );
      formData.append("model_id", "scribe_v1");

      const response = await fetch(
        "https://api.elevenlabs.io/v1/speech-to-text",
        {
          method: "POST",
          headers: {
            "xi-api-key": ELEVENLABS_API_KEY(),
          },
          body: formData,
        }
      );

      if (response.ok) {
        const result = await response.json();
        return result.text || "[Could not transcribe audio]";
      }

      console.error(`ElevenLabs STT buffer error: ${response.status}`);
    } catch (error) {
      console.error("ElevenLabs buffer transcription error:", error);
    }
  }

  // Fallback to Gemini
  if (!GEMINI_API_KEY()) {
    return "[Voice transcription unavailable - no provider configured]";
  }

  try {
    const base64Audio = audioBuffer.toString("base64");

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: "Transcribe this audio message accurately. Only output the transcription, nothing else.",
                },
                {
                  inline_data: {
                    mime_type: mimeType,
                    data: base64Audio,
                  },
                },
              ],
            },
          ],
        }),
      }
    );

    const result = await response.json();
    return (
      result.candidates?.[0]?.content?.parts?.[0]?.text ||
      "[Could not transcribe audio]"
    );
  } catch (error) {
    console.error("Buffer transcription error:", error);
    return "[Transcription failed]";
  }
}

/**
 * Check if transcription is configured.
 * Whisper.cpp (local) → ElevenLabs → Gemini.
 */
export function isTranscriptionEnabled(): boolean {
  return isWhisperAvailable() || !!ELEVENLABS_API_KEY() || !!GEMINI_API_KEY();
}

/**
 * Get the active transcription provider name (for logging).
 */
export function getTranscriptionProvider(): string {
  if (isWhisperAvailable()) return "whisper.cpp (local)";
  if (ELEVENLABS_API_KEY()) return "ElevenLabs";
  if (GEMINI_API_KEY()) return "Gemini";
  return "none";
}
