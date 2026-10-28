/**
 * Probe des Telefonhörers (Issue #260): Einordnung und Text, gemeinsam für
 * den Reiter „Sprechen" (POST /api/voice/call/probe) und tybo setup sprache.
 *
 * Gemessen wird, wie lange es vom Absenden einer Testfrage bis zum ersten
 * sprechbaren Abschnitt der Antwort dauert (probeCallModel in
 * src/lib/voice-brain/call-model.ts). Der erste Abschnitt kann ein Teilsatz
 * sein (Satz-Strom mit earlyFirst, Entscheidung 0024), deshalb heißt der
 * Wert „Antwort beginnt nach", nicht „erster Satz". Es sind drei Proben:
 * jede der drei Testfragen einmal (runs 1).
 *
 * Einordnung nach dem Median: bis 2 s flüssig, bis 4 s geht, darüber zäh.
 * Ohne Messwert (jede Probe scheiterte) gibt es keine Einordnung, nie
 * „flüssig".
 *
 * Reine Web-Seite: nichts aus src/lib.
 */

export const CALL_PROBE_PATH = "/api/voice/call/probe";

export const CALL_PROBE_TEXT = {
  notConfigured: "Telefonhörer ist nicht eingerichtet",
  tooMany: "Höchstens drei Proben in zehn Minuten. Bitte etwas warten.",
  timeout: "Die Probe hat zu lange gedauert.",
  failed: "Die Probe ist gescheitert.",
  busy: "Während eines Gesprächs am Telefonhörer gibt es keine Probe.",
} as const;

/** Proben je Messung: die drei Testfragen je einmal */
export const CALL_PROBE_RUNS = 1;
export const CALL_PROBE_COUNT = 3;
/** Höchstens so viele Proben in CALL_PROBE_WINDOW_MS (eine Installation) */
export const CALL_PROBE_LIMIT = 3;
export const CALL_PROBE_WINDOW_MS = 10 * 60_000;
/** Eine Probe darf so lange dauern, dann gilt sie als gescheitert */
export const CALL_PROBE_TIMEOUT_MS = 90_000;

export type CallProbeRating = "fluessig" | "geht" | "zaeh";

export const CALL_PROBE_RATING_TEXT: Record<CallProbeRating, string> = {
  fluessig: "flüssig",
  geht: "geht",
  zaeh: "zäh",
};

/** Ergebnis für Browser und Terminal; nie Antworttexte, nie Schlüssel */
export type CallProbeResult =
  | {
      ok: true;
      medianMs: number;
      minMs: number;
      maxMs: number;
      /** Proben mit Messwert */
      measured: number;
      /** Proben insgesamt */
      count: number;
      rating: CallProbeRating;
      text: string;
      model: string;
      via: string;
    }
  | { ok: false; reason: string };

/** Anschluss an den Bot (bot-call.ts); wirft nie, Fehler als ok false */
export type CallProbePort = () => Promise<CallProbeResult>;

export function rateProbe(medianMs: number): CallProbeRating {
  if (medianMs <= 2_000) return "fluessig";
  if (medianMs <= 4_000) return "geht";
  return "zaeh";
}

/** „1,3 s" mit einer Nachkommastelle */
export function seconds(ms: number): string {
  return `${(Math.round(ms / 100) / 10).toFixed(1).replace(".", ",")} s`;
}

/** „Antwort beginnt nach 1,3 s (3 Proben: 1,1 bis 1,6 s), flüssig" */
export function probeText(o: { medianMs: number; minMs: number; maxMs: number; measured: number; count: number }): string {
  const proben = o.measured === 1 ? "1 Probe" : `${o.measured} Proben`;
  const of = o.measured < o.count ? ` von ${o.count}` : "";
  const range = o.measured > 1 ? `: ${seconds(o.minMs).replace(" s", "")} bis ${seconds(o.maxMs)}` : "";
  return `Antwort beginnt nach ${seconds(o.medianMs)} (${proben}${of}${range}), ${CALL_PROBE_RATING_TEXT[rateProbe(o.medianMs)]}`;
}

/** Aus den Messwerten der Probe; ohne einen einzigen Messwert ok false */
export function probeResult(o: {
  medianMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  measured: number;
  count: number;
  model: string;
  via: string;
  firstError?: string;
}): CallProbeResult {
  if (o.medianMs === null || o.minMs === null || o.maxMs === null || !o.measured) {
    return { ok: false, reason: o.firstError ? `Keine Probe kam an (${o.firstError})` : "Keine Probe kam an" };
  }
  const values = { medianMs: o.medianMs, minMs: o.minMs, maxMs: o.maxMs, measured: o.measured, count: o.count };
  return { ok: true, ...values, rating: rateProbe(o.medianMs), text: probeText(values), model: o.model, via: o.via };
}

/** Gleitendes Fenster für die Probe: höchstens limit Starts in windowMs */
export function createProbeLimiter(o: { limit?: number; windowMs?: number; now?: () => number } = {}) {
  const limit = o.limit ?? CALL_PROBE_LIMIT;
  const windowMs = o.windowMs ?? CALL_PROBE_WINDOW_MS;
  const now = o.now ?? Date.now;
  const starts: number[] = [];
  return {
    /** true und gezählt, wenn noch eine Probe erlaubt ist; sonst false */
    take(): boolean {
      const t = now();
      while (starts.length && t - starts[0]! >= windowMs) starts.shift();
      if (starts.length >= limit) return false;
      starts.push(t);
      return true;
    },
    /** Sekunden bis zur nächsten erlaubten Probe */
    retryAfterSeconds(): number {
      if (starts.length < limit) return 0;
      return Math.max(1, Math.ceil((starts[0]! + windowMs - now()) / 1000));
    },
  };
}

/** Was summarizeProbe aus probeCallModel braucht (ProbeResult in src/lib/voice-brain/call-model.ts) */
export interface ProbeSamples {
  resolution: { model: string | null; via: string | null };
  samples: Array<{ firstMs: number | null; error?: string }>;
  medianMs: number | null;
  minMs: number | null;
  maxMs: number | null;
}

/** Ergebnis von probeCallModel für Browser und Terminal: Median, Spanne, Einordnung; nie Antworttexte */
export function summarizeProbe(result: ProbeSamples): CallProbeResult {
  const measured = result.samples.filter(s => s.firstMs !== null);
  const firstError = result.samples.find(s => s.error)?.error?.split(":")[0];
  return probeResult({
    medianMs: result.medianMs,
    minMs: result.minMs,
    maxMs: result.maxMs,
    measured: measured.length,
    count: Math.max(result.samples.length, CALL_PROBE_COUNT),
    model: result.resolution.model ?? "",
    via: result.resolution.via ?? "",
    ...(firstError ? { firstError } : {}),
  });
}

/**
 * Hörprobe der Stimme des Telefonhörers (Issue #276): ein fester Satz mit
 * der eingestellten Stimme des Telefonhörers (speech.call.tts samt
 * ElevenLabs-Stimme und -Modell), nie mit speech.tts. POST ohne Inhalt,
 * hinter Login und Origin, höchstens CALL_VOICE_PROBE_LIMIT in zehn Minuten
 * (ElevenLabs berechnet jedes Zeichen), höchstens
 * CALL_VOICE_PROBE_TIMEOUT_MS, nicht während eines Gesprächs. Kein
 * Rückfall: die Probe zeigt ehrlich, ob genau diese Stimme spricht.
 */
export const CALL_VOICE_PROBE_PATH = "/api/voice/call/voice-probe";
export const CALL_VOICE_PROBE_TEXT_SPOKEN = "Hallo, so klinge ich am Telefonhörer.";
export const CALL_VOICE_PROBE_LIMIT = 6;
export const CALL_VOICE_PROBE_TIMEOUT_MS = 20_000;

export const CALL_VOICE_PROBE_TEXT = {
  notConfigured: "Hörprobe ist nicht eingerichtet",
  tooMany: "Höchstens sechs Hörproben in zehn Minuten. Bitte etwas warten.",
  timeout: "Die Hörprobe hat zu lange gedauert.",
  failed: "Die Hörprobe ist gescheitert.",
  busy: "Während eines Gesprächs am Telefonhörer gibt es keine Hörprobe.",
  browser: "Am Telefonhörer spricht die Browser-Stimme; die Hörprobe gibt es nur für Stimmen auf dem Server.",
} as const;

/** WAV (PCM16 mono) samt Dauer bis zum ersten Ton, oder Grund (deutsch, ohne Werte) */
export type CallVoiceProbeResult = { ok: true; audio: Buffer; provider: string; firstMs: number } | { ok: false; reason: string };
