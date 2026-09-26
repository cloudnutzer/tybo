/**
 * Modell-Listen für die Einstellungsseiten (Issue #36), GET /api/models.
 *
 * - claude: feste Liste bekannter IDs, eigene Eingabe erlaubt
 * - openrouter: öffentliche Liste ohne Schlüssel, nur id und name, erfolgreiche
 *   Antworten 10 Minuten zwischengespeichert
 * - ollama: lokal installierte Modelle, nur Namen, jedes Mal frisch
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

export interface ModelLists {
  claude: { models: string[]; custom: true };
  openrouter: { models: { id: string; name: string }[]; error?: string };
  ollama: { models: string[]; error?: string };
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

  return {
    async list() {
      const [or, ol] = await Promise.all([openrouter(), ollama()]);
      return { claude: { models: [...CLAUDE_MODELS], custom: true }, openrouter: or, ollama: ol };
    },
  };
}
