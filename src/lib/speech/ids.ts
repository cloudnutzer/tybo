/**
 * Kennungen der Sprach-Anbieter (Issue #248). Ohne Importe, weil
 * src/lib/settings.ts sie für das Schema braucht und die Anbieter die
 * Einstellungen lesen.
 */

/** Hören (Spracherkennung), in der Reihenfolge von auto */
export const STT_IDS = ["parakeet", "whisper-cpp", "elevenlabs", "gemini"] as const;
export type SttId = (typeof STT_IDS)[number];

/**
 * Sprechen (Sprachausgabe); Server-Kette für Telegram: qwen3-mlx, elevenlabs,
 * gemini. pocket und piper (Issue #252) nur fest gewählt. clone (Issue #253):
 * die gewählte eigene Stimme, nur im Sprechmodus der WebUI, nie für Telegram.
 */
export const TTS_IDS = ["browser", "qwen3-mlx", "elevenlabs", "gemini", "pocket", "piper", "clone"] as const;
export type TtsId = (typeof TTS_IDS)[number];

/**
 * Klon-Engines für eigene Stimmen (Issue #253): Pocket TTS mit den
 * Klon-Gewichten (gated, mit Hugging-Face-Token eingerichtet) und Qwen3-TTS
 * Base über mlx-audio (nur Mac mit Apple Silicon)
 */
export const CLONE_ENGINE_IDS = ["pocket", "qwen3-base"] as const;
export type CloneEngineId = (typeof CLONE_ENGINE_IDS)[number];

/** Kennung einer eigenen Stimme (wie VOICE_ID_PATTERN in ./voices.ts) */
export const CLONE_VOICE_ID_PATTERN = /^[a-f0-9]{16}$/;

export type SttChoice = "auto" | SttId;
export type TtsChoice = "auto" | TtsId;

/**
 * Wahl für Telegram, solange die eigene Stimme vorliest (Issue #253):
 * alles außer clone (speech.telegramTts)
 */
export const TELEGRAM_TTS_CHOICES = ["auto", ...TTS_IDS.filter((id): id is Exclude<TtsId, "clone"> => id !== "clone")] as const;
export type TelegramTtsChoice = Exclude<TtsChoice, "clone">;

/** Sprachen, die die WebUI zur Auswahl anbietet (dazu Automatisch) */
export const SPEECH_LANGUAGES = ["de", "en"] as const;

/** Sprachcode in config/settings.json: auto oder zwei Kleinbuchstaben */
export const SPEECH_LANGUAGE_PATTERN = /^(auto|[a-z]{2})$/;

export function isSttChoice(value: unknown): value is SttChoice {
  return value === "auto" || (typeof value === "string" && (STT_IDS as readonly string[]).includes(value));
}

export function isTtsChoice(value: unknown): value is TtsChoice {
  return value === "auto" || (typeof value === "string" && (TTS_IDS as readonly string[]).includes(value));
}

/**
 * Stimme des Telefonhörers (speech.call.tts, Issue #276). auto: wie bisher
 * (Pocket TTS oder Piper, wenn speech.tts so steht, sonst der Browser);
 * elevenlabs spricht gestreamt mit Pocket TTS als Rückfall je Abschnitt.
 */
export const CALL_TTS_CHOICES = ["auto", "pocket", "piper", "elevenlabs", "browser"] as const;
export type CallTtsChoice = (typeof CALL_TTS_CHOICES)[number];

/**
 * ElevenLabs-Modelle für den Telefonhörer (Issue #276), das erste ist der
 * Standard; Messwerte in ./elevenlabs.ts
 */
export const ELEVENLABS_MODELS = ["eleven_v3_conversational", "eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_multilingual_v2"] as const;
export type ElevenLabsModel = (typeof ELEVENLABS_MODELS)[number];

/**
 * Stimme des Telefonhörers bei ElevenLabs, wenn speech.call.elevenlabsVoice
 * fehlt (Issue #276): „River“ aus den vorinstallierten Stimmen, die jedes
 * ElevenLabs-Konto hat (Kategorie premade, Einsatz conversational).
 */
export const CALL_ELEVENLABS_DEFAULT_VOICE = "SAz9YHcvj6GT2YYXdXww";

export function isCallTtsChoice(value: unknown): value is CallTtsChoice {
  return typeof value === "string" && (CALL_TTS_CHOICES as readonly string[]).includes(value);
}

/**
 * Erkenner des Telefonhörers (speech.call.stt, Issue #279). auto (oder
 * fehlend): wie vor #279, nur lokal nach speech.stt; parakeet bzw.
 * whisper-cpp fest; elevenlabs: ElevenLabs Scribe mit Parakeet als Rückfall
 * je Äußerung.
 */
export const CALL_STT_CHOICES = ["auto", "parakeet", "whisper-cpp", "elevenlabs"] as const;
export type CallSttChoice = (typeof CALL_STT_CHOICES)[number];

export function isCallSttChoice(value: unknown): value is CallSttChoice {
  return typeof value === "string" && (CALL_STT_CHOICES as readonly string[]).includes(value);
}
