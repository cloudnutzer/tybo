/**
 * Modell-Listen für die Einstellungsseiten (Issue #36), GET /api/models.
 *
 * - claude: feste Liste bekannter IDs, eigene Eingabe erlaubt
 * - openrouter: öffentliche Liste ohne Schlüssel, nur id und name, erfolgreiche
 *   Antworten 10 Minuten zwischengespeichert
 * - ollama: lokal installierte Modelle, nur Namen, jedes Mal frisch
 * - opencode (Issue #129): Zeilen von `opencode models` (<anbieter>/<modell>)
 *   über einen Port, den src/bot.ts mit listOpenCodeModels aus
 *   src/lib/engines/opencode.ts füllt; Zeitlimit 10 s, erfolgreiche Listen
 *   10 Minuten zwischengespeichert, gleichzeitige Abrufe teilen sich einen
 *   Prozess. Ohne Port oder bei Fehler: leere Liste mit festem Text, das Feld
 *   bleibt frei eingebbar.
 *
 * Beide Abfragen laufen parallel und mit begrenzter Wartezeit, damit ein
 * hängendes Ollama die Liste nicht blockiert. Fehler ergeben eine leere Liste
 * mit festem Fehlertext; rohe Netzwerkfehler gehen weder in die Antwort noch
 * ins Log. Importiert nichts aus src/lib.
 */

export const CLAUDE_MODELS = [
  "claude-opus-5-5",
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
] as const;

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const OLLAMA_TAGS_URL = "http://localhost:11434/api/tags";
export const MODELS_CACHE_MS = 10 * 60_000;
export const MODELS_TIMEOUT_MS = 5_000;
/** Wie OPENCODE_MODELS_TIMEOUT_MS in src/lib/engines/opencode.ts; der Port beendet den Prozess selbst */
export const OPENCODE_MODELS_TIMEOUT_MS = 10_000;

export const OPENCODE_MODELS_TEXT = {
  unavailable: "Die Modell-Liste von OpenCode ist hier nicht abrufbar",
  failed: "OpenCode liefert keine Modellliste",
  timeout: "OpenCode antwortet nicht (Zeitüberschreitung)",
} as const;

/** Ergebnis von `opencode models` (OpenCodeModelsResult in src/lib/engines/opencode.ts); error nur mit festen Texten */
export type OpenCodeModelsPort = () => Promise<{ ok: true; models: string[] } | { ok: false; error: string }>;

export interface ModelLists {
  claude: { models: string[]; custom: true };
  openrouter: { models: { id: string; name: string }[]; error?: string };
  ollama: { models: string[]; error?: string };
  /** Kennungen <anbieter>/<modell>, unverändert wie OpenCode sie nennt */
  opencode: { models: string[]; error?: string };
}

export interface ModelCatalogOptions {
  fetch?: (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;
  now?: () => number;
  timeoutMs?: number;
  cacheMs?: number;
  openrouterUrl?: string;
  ollamaUrl?: string;
  /** Nur feste Texte übergeben */
  log?: (message: string) => void;
  /** `opencode models` (Issue #129); fehlt: kein Abruf, Hinweis „nicht abrufbar" */
  opencode?: OpenCodeModelsPort;
  /** Zeitlimit für den OpenCode-Port, Standard OPENCODE_MODELS_TIMEOUT_MS */
  opencodeTimeoutMs?: number;
}

export interface ModelCatalog {
  list(): Promise<ModelLists>;
}

class ListError extends Error {}

/**
 * Abfrage mit Frist über Antwort und Body; wirft ListError mit festem Text.
 * Auch eine Attrappe, die das Signal nicht beachtet, endet nach der Frist.
 */
async function fetchJson(
  label: string,
  url: string,
  opts: Required<Pick<ModelCatalogOptions, "fetch" | "timeoutMs">>
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ListError(`${label} antwortet nicht (Zeitüberschreitung)`));
    }, opts.timeoutMs);
  });
  const run = (async () => {
    let res: Response;
    try {
      res = await opts.fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    } catch {
      throw new ListError(`${label} ist nicht erreichbar`);
    }
    if (!res.ok) throw new ListError(`${label} antwortet mit HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new ListError(`${label} liefert keine gültige Modellliste`);
    }
  })();
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
    // Späte Fehler der verlorenen Abfrage nicht unbehandelt lassen
    run.catch(() => {});
  }
}

function parseOpenRouter(data: unknown): { id: string; name: string }[] {
  const list = (data as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) throw new ListError("OpenRouter liefert keine gültige Modellliste");
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const id = (entry as { id?: unknown })?.id;
    if (typeof id !== "string" || !id.trim() || id.length > 200 || seen.has(id)) continue;
    const rawName = (entry as { name?: unknown }).name;
    const name = typeof rawName === "string" && rawName.trim() ? rawName.trim().slice(0, 200) : id;
    seen.add(id);
    out.push({ id, name });
  }
  return out;
}

function parseOllama(data: unknown): string[] {
  const list = (data as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) throw new ListError("Ollama liefert keine gültige Modellliste");
  const names = new Set<string>();
  for (const entry of list) {
    const name = (entry as { name?: unknown })?.name;
    if (typeof name === "string" && name.trim() && name.length <= 200) names.add(name);
  }
  return [...names];
}

export function createModelCatalog(options: ModelCatalogOptions = {}): ModelCatalog {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? MODELS_TIMEOUT_MS;
  const cacheMs = options.cacheMs ?? MODELS_CACHE_MS;
  const openrouterUrl = options.openrouterUrl ?? OPENROUTER_MODELS_URL;
  const ollamaUrl = options.ollamaUrl ?? OLLAMA_TAGS_URL;
  const log = options.log ?? (() => {});
  const net = { fetch: doFetch, timeoutMs };

  let cached: { at: number; models: { id: string; name: string }[] } | null = null;
  // Gleichzeitige Aufrufe teilen sich eine Abfrage
  let inflight: Promise<ModelLists["openrouter"]> | null = null;

  async function openrouter(): Promise<ModelLists["openrouter"]> {
    if (cached && now() - cached.at < cacheMs) return { models: cached.models };
    inflight ??= (async () => {
      try {
        const models = parseOpenRouter(await fetchJson("OpenRouter", openrouterUrl, net));
        cached = { at: now(), models };
        return { models };
      } catch (e) {
        // Fehler werden nicht zwischengespeichert: der nächste Aufruf fragt neu
        const error = e instanceof ListError ? e.message : "OpenRouter liefert keine gültige Modellliste";
        log(`Modellliste: ${error}`);
        return { models: [], error };
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function ollama(): Promise<ModelLists["ollama"]> {
    try {
      return { models: parseOllama(await fetchJson("Ollama", ollamaUrl, net)) };
    } catch (e) {
      const error = e instanceof ListError ? e.message : "Ollama liefert keine gültige Modellliste";
      log(`Modellliste: ${error}`);
      return { models: [], error };
    }
  }

  const opencodePort = options.opencode;
  const opencodeTimeoutMs = options.opencodeTimeoutMs ?? OPENCODE_MODELS_TIMEOUT_MS;
  let opencodeCached: { at: number; models: string[] } | null = null;
  let opencodeInflight: Promise<ModelLists["opencode"]> | null = null;

  /** Fester Text aus dem Port, sonst ein eigener; nie mehr als eine kurze Zeile */
  const portError = (raw: unknown): string =>
    typeof raw === "string" && /^[^\n\r]{1,120}$/.test(raw) ? raw : OPENCODE_MODELS_TEXT.failed;

  async function opencode(): Promise<ModelLists["opencode"]> {
    if (!opencodePort) return { models: [], error: OPENCODE_MODELS_TEXT.unavailable };
    if (opencodeCached && now() - opencodeCached.at < cacheMs) return { models: [...opencodeCached.models] };
    opencodeInflight ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const call = opencodePort();
        // Auch ein Port, der sein Zeitlimit nicht einhält, hält die Liste nicht auf
        const timeout = new Promise<{ ok: false; error: string }>(resolve => {
          timer = setTimeout(() => resolve({ ok: false, error: OPENCODE_MODELS_TEXT.timeout }), opencodeTimeoutMs);
        });
        call.catch(() => {});
        const r = await Promise.race([call, timeout]);
        if (r.ok && Array.isArray(r.models)) {
          const models = r.models.filter(m => typeof m === "string" && m.length > 0 && m.length <= 200);
          opencodeCached = { at: now(), models };
          return { models: [...models] };
        }
        const error = portError(r.ok ? undefined : r.error);
        log(`Modellliste: ${error}`);
        return { models: [], error };
      } catch {
        log(`Modellliste: ${OPENCODE_MODELS_TEXT.failed}`);
        return { models: [], error: OPENCODE_MODELS_TEXT.failed };
      } finally {
        clearTimeout(timer);
        opencodeInflight = null;
      }
    })();
    return opencodeInflight;
  }

  return {
    async list() {
      const [or, ol, oc] = await Promise.all([openrouter(), ollama(), opencode()]);
      return { claude: { models: [...CLAUDE_MODELS], custom: true }, openrouter: or, ollama: ol, opencode: oc };
    },
  };
}
