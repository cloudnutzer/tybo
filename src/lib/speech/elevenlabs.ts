/**
 * ElevenLabs gestreamt für den Telefonhörer (Issue #276).
 *
 * POST /v1/text-to-speech/{voice_id}/stream mit output_format=pcm_24000:
 * roher PCM16 LE mono in 24 kHz (gleiche Rate wie Pocket TTS, kein
 * Umrechnen), Stück für Stück, sobald ElevenLabs es schickt. Die Stücke der
 * Antwort halten sich nicht an Bytepaare (gemessen am 2.10.2026: bis zu
 * zwölf ungerade Stücke je Satz); ein übriges Byte wird an das nächste Stück
 * gehängt, damit jeder gelieferte Teil aus ganzen Werten besteht. Ein
 * einzelnes Byte am Ende fällt weg.
 *
 * Fehler werfen SpeechError ohne Inhalt: http (mit Status, etwa 401 oder
 * 429), network (keine Verbindung oder abgerissen), timeout (kein erstes
 * Stück nach ELEVENLABS_FIRST_BYTE_TIMEOUT_MS, Stillstand länger als
 * ELEVENLABS_IDLE_TIMEOUT_MS, oder Abbruch über signal), empty (kein Ton).
 * Bricht der Verbraucher ab (signal oder return), endet die Anfrage sofort.
 *
 * voice_settings wie bei den Sprach-Agenten von ElevenLabs
 * (ELEVENLABS_VOICE_SETTINGS), nicht die bei ElevenLabs gespeicherten der
 * Stimme. language_code nur bei Modellen, die ihn kennen (alle außer
 * Multilingual v2).
 */

import { ELEVENLABS_MODELS, type ElevenLabsModel } from "./ids";
import { SpeechError, VOICE_PATTERN } from "./types";

export { ELEVENLABS_MODELS, type ElevenLabsModel };

export const ELEVENLABS_API = "https://api.elevenlabs.io";
/** Abtastrate des Stroms (output_format=pcm_24000) */
export const ELEVENLABS_STREAM_RATE = 24_000;
/**
 * Modelle zur Wahl (./ids.ts), das erste ist der Standard. Gemessen am
 * 2.10.2026 (Satz mit 90 Zeichen, deutsche Stimme, warme Verbindung): Flash
 * v2.5 rund 150 ms bis zum ersten Stück, Turbo v2.5 rund 210 ms,
 * Multilingual v2 rund 1.100 ms. v3 Conversational (Standard seit 5.10.2026,
 * das Modell der Sprach-Agenten von ElevenLabs): gleich schnell wie Flash v2.5, rund 200 ms
 * bei warmer Verbindung, klingt aber deutlich natürlicher.
 */
export const ELEVENLABS_DEFAULT_MODEL: ElevenLabsModel = "eleven_v3_conversational";
/** Anzeigenamen der Modelle (Einstellungsseite) */
export const ELEVENLABS_MODEL_LABELS: Record<ElevenLabsModel, string> = {
  eleven_v3_conversational: "v3 Conversational (am natürlichsten)",
  eleven_flash_v2_5: "Flash v2.5 (am schnellsten)",
  eleven_turbo_v2_5: "Turbo v2.5",
  eleven_multilingual_v2: "Multilingual v2 (am langsamsten)",
};
/** Stimm-Einstellungen wie bei den Sprach-Agenten von ElevenLabs (v3 kennt bei stability nur 0, 0,5 und 1) */
export const ELEVENLABS_VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75, speed: 1 } as const;
/** So lange darf das erste Stück ausbleiben */
export const ELEVENLABS_FIRST_BYTE_TIMEOUT_MS = 5_000;
/** So lange darf der Strom zwischen zwei Stücken stehen */
export const ELEVENLABS_IDLE_TIMEOUT_MS = 5_000;
/** Höchstlänge eines Abschnitts (der Telefonhörer teilt bei 240 Zeichen) */
const MAX_STREAM_CHARS = 1_000;

export function isElevenLabsModel(v: unknown): v is ElevenLabsModel {
  return typeof v === "string" && (ELEVENLABS_MODELS as readonly string[]).includes(v);
}

export interface ElevenLabsStreamOptions {
  key: string;
  voice: string;
  model?: string;
  /** Sprachcode aus zwei Buchstaben; bei Multilingual v2 nicht gesendet */
  language?: string;
  signal?: AbortSignal;
  firstByteTimeoutMs?: number;
  idleTimeoutMs?: number;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Text als PCM16-Strom. Wirft SpeechError (siehe Kopf); ein Abbruch über
 * signal endet mit timeout, wie bei Pocket TTS.
 */
export async function* streamElevenLabs(fetchFn: FetchFn, text: string, o: ElevenLabsStreamOptions): AsyncGenerator<Uint8Array> {
  if (!o.key) throw new SpeechError("unavailable");
  if (!VOICE_PATTERN.test(o.voice)) throw new SpeechError("unavailable");
  const model = o.model ?? ELEVENLABS_DEFAULT_MODEL;
  if (!isElevenLabsModel(model)) throw new SpeechError("unavailable");
  const clean = text.trim().slice(0, MAX_STREAM_CHARS);
  if (!clean) throw new SpeechError("empty");
  if (o.signal?.aborted) throw new SpeechError("timeout");

  const local = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      local.abort();
    }, ms);
  };
  const onOuter = () => local.abort();
  o.signal?.addEventListener("abort", onOuter, { once: true });
  const stopped = () => local.signal.aborted || !!o.signal?.aborted;
  const failure = (fallback: SpeechError) => (timedOut || o.signal?.aborted ? new SpeechError("timeout") : fallback);

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    arm(o.firstByteTimeoutMs ?? ELEVENLABS_FIRST_BYTE_TIMEOUT_MS);
    const body: Record<string, unknown> = { text: clean, model_id: model, voice_settings: ELEVENLABS_VOICE_SETTINGS };
    if (o.language && model !== "eleven_multilingual_v2") body.language_code = o.language;
    let res: Response;
    try {
      res = await fetchFn(`${ELEVENLABS_API}/v1/text-to-speech/${o.voice}/stream?output_format=pcm_24000`, {
        method: "POST",
        headers: { "xi-api-key": o.key, "Content-Type": "application/json", Accept: "audio/pcm" },
        body: JSON.stringify(body),
        signal: local.signal,
      });
    } catch {
      throw failure(new SpeechError("network"));
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw failure(new SpeechError("http", res.status));
    }
    reader = res.body.getReader();
    // Abbruch beendet auch ein laufendes read(), selbst wenn der Body das Signal nicht beachtet
    const r = reader;
    local.signal.addEventListener("abort", () => void r.cancel().catch(() => {}), { once: true });
    let carry: number | null = null;
    let total = 0;
    for (;;) {
      if (stopped()) throw failure(new SpeechError("network"));
      let step: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
      try {
        step = await reader.read();
      } catch {
        throw failure(new SpeechError("network"));
      }
      if (stopped()) throw failure(new SpeechError("network"));
      if (step.done) break;
      arm(o.idleTimeoutMs ?? ELEVENLABS_IDLE_TIMEOUT_MS);
      let bytes = step.value;
      if (!bytes.length) continue;
      if (carry !== null) {
        const joined = new Uint8Array(bytes.length + 1);
        joined[0] = carry;
        joined.set(bytes, 1);
        bytes = joined;
        carry = null;
      }
      if (bytes.length % 2) {
        carry = bytes[bytes.length - 1]!;
        bytes = bytes.subarray(0, bytes.length - 1);
      }
      if (!bytes.length) continue;
      total += bytes.length;
      yield bytes;
    }
    if (!total) throw new SpeechError("empty");
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onOuter);
    local.abort();
    await reader?.cancel().catch(() => {});
  }
}

/**
 * Name der Stimme beim Konto (GET /v1/voices/{voice_id}); null bei jedem
 * Fehler. Öffnet nebenbei die Verbindung, damit das erste Sprechen nicht den
 * Verbindungsaufbau trägt (gemessen: erster Aufruf rund 2,3 s statt 0,15 s).
 */
export async function elevenLabsVoiceName(fetchFn: FetchFn, key: string, voice: string, signal?: AbortSignal, timeoutMs = 4_000): Promise<string | null> {
  if (!key || !VOICE_PATTERN.test(voice)) return null;
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetchFn(`${ELEVENLABS_API}/v1/voices/${voice}`, { headers: { "xi-api-key": key }, signal: sig });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const json = (await res.json()) as { name?: unknown };
    const name = typeof json?.name === "string" ? json.name.trim().replace(/\s+/g, " ").slice(0, 60) : "";
    return name || null;
  } catch {
    return null;
  }
}
