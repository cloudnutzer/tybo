/**
 * Stimmen für einen Entwurf vorschlagen (Issue #493). Das Rezept bekommt eine
 * Kennung, die der Anbieter kennt: Stimmen des Kontos bei ElevenLabs, also
 * vorinstallierte, aus der Bibliothek übernommene und dort geklonte. Die
 * lokalen Klone aus src/lib/speech/voices.ts gehören nicht dazu: Entscheidung
 * 0023 schließt ihre Übernahme durch ElevenLabs aus.
 *
 * Abruf: GET /v1/voices (Liste der Stimmen des Kontos mit name, category,
 * labels und description), wie GET /v1/voices/{id} in speech/elevenlabs.ts.
 * Die Auswahl trifft kein Sprachmodell, sondern ein Abgleich der Wörter der
 * Beschreibung mit Name, Merkmalen und Beschreibung der Stimme.
 */
import { VOICE_PATTERN } from "../speech/types";

export const VOICE_SUGGESTIONS_MAX = 3;
const NAME_MAX = 40;
const API = "https://api.elevenlabs.io";
const TIMEOUT_MS = 10_000;

export interface ProviderVoice {
  voiceId: string;
  name: string;
  /** premade, cloned, generated, professional, … wie beim Anbieter */
  category: string;
  /** Merkmale und Beschreibung, klein geschrieben, für den Abgleich */
  words: string;
}

export interface VoiceSuggestion {
  voiceId: string;
  name: string;
  /** true: eine geklonte Stimme des Kontos */
  klon: boolean;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Name zum Anzeigen: druckbar, kurz, ohne Zeilenumbrüche */
export function cleanVoiceName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
}

/** Stimmen des Kontos; leer ohne Schlüssel oder bei jedem Fehler (der Entwurf geht dann mit der Standardstimme weiter) */
export async function listProviderVoices(env: Record<string, string | undefined>, doFetch: Fetch = (url, init) => fetch(url, init)): Promise<ProviderVoice[]> {
  const key = env.ELEVENLABS_API_KEY?.trim();
  if (!key) return [];
  try {
    const res = await doFetch(`${API}/v1/voices`, { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return [];
    }
    const json = (await res.json()) as { voices?: unknown };
    if (!Array.isArray(json?.voices)) return [];
    const out: ProviderVoice[] = [];
    for (const raw of json.voices as any[]) {
      const voiceId = typeof raw?.voice_id === "string" && VOICE_PATTERN.test(raw.voice_id) ? raw.voice_id : null;
      const name = cleanVoiceName(raw?.name);
      if (!voiceId || !name) continue;
      const labels = raw?.labels && typeof raw.labels === "object" ? Object.values(raw.labels).filter((v): v is string => typeof v === "string") : [];
      const words = [name, ...labels, typeof raw?.description === "string" ? raw.description : ""].join(" ").toLowerCase();
      out.push({ voiceId, name, category: typeof raw?.category === "string" ? raw.category : "", words });
    }
    return out;
  } catch {
    return [];
  }
}

/** Deutsche Wörter der Beschreibung und ihre Entsprechung in den (englischen) Merkmalen des Anbieters */
const SYNONYMS: Record<string, string[]> = {
  weiblich: ["female", "woman"],
  weibliche: ["female", "woman"],
  männliche: ["male", "man"],
  maennliche: ["male", "man"],
  frau: ["female", "woman"],
  männlich: ["male", "man"],
  maennlich: ["male", "man"],
  mann: ["male", "man"],
  jung: ["young"],
  junge: ["young"],
  alt: ["old"],
  älter: ["old", "middle"],
  mittel: ["middle"],
  mittleres: ["middle"],
  ruhig: ["calm", "soft"],
  ruhige: ["calm", "soft"],
  tief: ["deep"],
  tiefe: ["deep"],
  warm: ["warm"],
  warme: ["warm"],
  freundlich: ["friendly"],
  freundliche: ["friendly"],
  professionell: ["professional"],
  professionelle: ["professional"],
  deutsch: ["german", "de"],
  englisch: ["english", "en", "american", "british"],
  klar: ["clear", "crisp"],
  klare: ["clear", "crisp"],
  energisch: ["energetic"],
  lebhaft: ["energetic", "upbeat"],
};

/** Wörter, die jede Beschreibung enthält und die nichts unterscheiden */
const STOP_WORDS = new Set(["stimme", "voice", "eine", "einer", "mit", "und", "der", "die", "das", "sehr"]);

function terms(description: string): string[] {
  const words = description.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  return [...new Set(words.flatMap((w) => [w, ...(SYNONYMS[w] ?? [])]))];
}

function score(voice: ProviderVoice, wanted: string[]): number {
  const own = new Set(voice.words.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  return wanted.reduce((sum, term) => sum + (own.has(term) ? 1 : 0), 0);
}

/**
 * Bis zu drei Stimmen, die am besten passen; bei Gleichstand geklonte Stimmen
 * des Kontos zuerst, dann nach Name. Ohne jede Übereinstimmung gibt es keine
 * Vorschläge, nur die Standardstimme.
 */
export function suggestVoices(description: string, voices: readonly ProviderVoice[], max = VOICE_SUGGESTIONS_MAX): VoiceSuggestion[] {
  const wanted = terms(description);
  return voices
    .map((voice) => ({ voice, points: score(voice, wanted) }))
    .filter((entry) => entry.points > 0)
    .sort((a, b) => b.points - a.points || Number(b.voice.category === "cloned") - Number(a.voice.category === "cloned") || a.voice.name.localeCompare(b.voice.name))
    .slice(0, max)
    .map(({ voice }) => ({ voiceId: voice.voiceId, name: voice.name, klon: voice.category === "cloned" }));
}
