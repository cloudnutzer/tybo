/**
 * Limit und Verbrauch des Schlüssels der Ersatzmodelle (Issue #674).
 * Reine Anzeige, ohne Verbindung zur Wechselregel oder zu src/lib.
 * Der Anschluss liest den Schlüssel erst beim Aufruf; die Demo liefert
 * einen fertigen Port und braucht weder Schlüssel noch Netz.
 */
export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
export const OPENROUTER_KEY_TIMEOUT_MS = 5_000;
export const OPENROUTER_KEY_CACHE_MS = 5 * 60_000;

export const OPENROUTER_KEY_TEXT = {
  rejected: "OpenRouter lehnt den Schlüssel ab",
  timeout: "OpenRouter antwortet nicht (Zeitüberschreitung)",
  unavailable: "OpenRouter ist gerade nicht erreichbar",
} as const;

export interface OpenRouterKeyReading {
  configured: true;
  limit: number | null;
  remaining: number | null;
  limitReset: "daily" | "weekly" | "monthly" | null;
  usage: number;
  usageMonthly: number;
  fetchedAt: string;
}

export type OpenRouterKeyStatus =
  | { configured: false }
  | OpenRouterKeyReading
  | { configured: true; error: typeof OPENROUTER_KEY_TEXT[keyof typeof OPENROUTER_KEY_TEXT] };

export interface OpenRouterKeyPort {
  read(): Promise<OpenRouterKeyStatus>;
}

export interface OpenRouterKeyOptions {
  key(): string | undefined;
  fetch?: (url: string, init: { signal: AbortSignal; headers: Record<string, string>; redirect: "error" }) => Promise<Response>;
  now?: () => number;
  timeoutMs?: number;
  log?: (message: string) => void;
}

class KeyError extends Error {
  constructor(readonly text: typeof OPENROUTER_KEY_TEXT[keyof typeof OPENROUTER_KEY_TEXT]) { super(text); }
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nullableNumber = (value: unknown): value is number | null => value === null || finite(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function parseReading(body: unknown): Omit<OpenRouterKeyReading, "configured" | "fetchedAt"> {
  const data = object(body) ? body.data : null;
  if (!object(data) || !nullableNumber(data.limit) || !nullableNumber(data.limit_remaining)
    || (data.limit !== null && data.limit_remaining === null)
    || !finite(data.usage) || !finite(data.usage_monthly)
    || (data.limit_reset !== null && typeof data.limit_reset !== "string")) {
    throw new KeyError(OPENROUTER_KEY_TEXT.unavailable);
  }
  return {
    limit: data.limit,
    remaining: data.limit_remaining,
    limitReset: data.limit_reset === "daily" || data.limit_reset === "weekly" || data.limit_reset === "monthly" ? data.limit_reset : null,
    usage: data.usage,
    usageMonthly: data.usage_monthly,
  };
}

/** Frist umfasst auch den Body und beendet das Warten auf signalblinde Attrappen. */
async function fetchReading(key: string, doFetch: NonNullable<OpenRouterKeyOptions["fetch"]>, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new KeyError(OPENROUTER_KEY_TEXT.timeout));
      controller.abort();
    }, timeoutMs);
  });
  const run = (async () => {
    const response = await doFetch(OPENROUTER_KEY_URL, {
      signal: controller.signal,
      redirect: "error",
      headers: { accept: "application/json", Authorization: `Bearer ${key}` },
    });
    if (response.status === 401 || response.status === 403) throw new KeyError(OPENROUTER_KEY_TEXT.rejected);
    if (!response.ok) throw new KeyError(OPENROUTER_KEY_TEXT.unavailable);
    return response.json();
  })();
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
    // Ein spätes Ergebnis kann weder den Zwischenspeicher füllen noch roh ins Log gelangen.
    run.catch(() => {});
  }
}

export function createOpenRouterKey(options: OpenRouterKeyOptions): OpenRouterKeyPort {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  let cached: { at: number; reading: OpenRouterKeyReading } | null = null;
  let inflight: Promise<OpenRouterKeyStatus> | null = null;

  async function readFresh(key: string): Promise<OpenRouterKeyStatus> {
    try {
      const fields = parseReading(await fetchReading(key, doFetch, options.timeoutMs ?? OPENROUTER_KEY_TIMEOUT_MS));
      const at = now();
      const reading: OpenRouterKeyReading = { configured: true, ...fields, fetchedAt: new Date(at).toISOString() };
      cached = { at, reading };
      return reading;
    } catch (e) {
      const error = e instanceof KeyError ? e.text : OPENROUTER_KEY_TEXT.unavailable;
      options.log?.(`OpenRouter-Schlüssel: ${error}`);
      return { configured: true, error };
    }
  }

  return {
    async read() {
      const key = options.key()?.trim();
      if (!key) return { configured: false };
      if (cached && now() - cached.at < OPENROUTER_KEY_CACHE_MS) return { ...cached.reading };
      inflight ??= readFresh(key).finally(() => { inflight = null; });
      return { ...await inflight };
    },
  };
}
