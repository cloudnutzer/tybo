/**
 * Zeitgrenzen eines Chat-Turns (Issue #178), ohne weitere Abhängigkeiten.
 *
 * Eigenes Modul, weil chat-turn.ts die Agenten importiert und der
 * Agenten-Prompt (src/agents/base.ts, Issue #180) dieselben Werte nennt:
 * ein Import von chat-turn.ts in base.ts wäre ein Kreis. chat-turn.ts
 * exportiert die Werte weiter wie bisher.
 */

export const CLAUDE_IDLE_TIMEOUT_MS = 900_000; // 15 min ohne stream-json-Zeile (Streaming)
export const CLAUDE_CALL_TIMEOUT_MS = 5_400_000; // 90 min Obergrenze (Streaming)
export const JSON_CALL_TIMEOUT_MS = 1_800_000; // 30 min Gesamtzeit (JSON-Pfad, unverändert)

/** Obergrenze für die Minuten aus .env: ein Tag */
const MAX_ENV_MINUTES = 24 * 60;

export interface StreamingLimits {
  idleMs: number;
  maxMs: number;
}

// Pro Variable der zuletzt gemeldete Rohwert: die Log-Zeile kommt einmal pro
// ungültigem Wert, nicht bei jedem Turn. Der Wert selbst steht nie im Log.
const warnedEnv = new Map<string, string>();

function minutesFromEnv(
  name: string,
  fallbackMs: number,
  env: Record<string, string | undefined>,
  warn: (msg: string) => void
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallbackMs;
  const value = raw.trim();
  const minutes = /^\d+$/.test(value) ? Number(value) : NaN;
  if (Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= MAX_ENV_MINUTES) {
    warnedEnv.delete(name);
    return minutes * 60_000;
  }
  if (warnedEnv.get(name) !== raw) {
    warnedEnv.set(name, raw);
    warn(
      `[chat-turn] ${name} ungültig (erwartet ganze Minuten von 1 bis ${MAX_ENV_MINUTES}), ` +
        `nutze Standard ${fallbackMs / 60_000} Minuten`
    );
  }
  return fallbackMs;
}

/**
 * Grenzen der Streaming-Turns: TYBO_CLAUDE_IDLE_MIN und TYBO_CLAUDE_MAX_MIN
 * aus .env (ganze Minuten), sonst 15 und 90 Minuten.
 */
export function resolveStreamingLimits(
  env: Record<string, string | undefined> = process.env,
  warn: (msg: string) => void = (m) => console.warn(m)
): StreamingLimits {
  return {
    idleMs: minutesFromEnv("TYBO_CLAUDE_IDLE_MIN", CLAUDE_IDLE_TIMEOUT_MS, env, warn),
    maxMs: minutesFromEnv("TYBO_CLAUDE_MAX_MIN", CLAUDE_CALL_TIMEOUT_MS, env, warn),
  };
}
