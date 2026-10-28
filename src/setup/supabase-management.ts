/**
 * Port zur Management-API von Supabase (Issue #163): Organisationen,
 * Projekte, Migrationen, Schlüssel. Für den Ablauf „Supabase in der
 * Cloud“ (src/setup/supabase-cloud.ts) und, seit Issue #166, für Edge
 * Functions und Geheimnisse der semantischen Suche
 * (src/setup/semantic-search.ts).
 *
 * Regeln:
 * - Netz nur über das fetch aus dem Kontext (Tests: Attrappe).
 * - Das Zugangstoken (sbp_…) steht nur im Kopf Authorization, nie in einer
 *   Adresse, und lebt nur in diesem Objekt, solange der Lauf dauert.
 * - Fehler sind SupabaseManagementError mit festen Sätzen aus diesem Code.
 *   Antworten der API werden nie durchgereicht; gelesen wird der Text nur,
 *   um die Projektgrenze zu erkennen.
 * - 429: wartet so viele Sekunden, wie X-RateLimit-Reset sagt (verbleibende
 *   Sekunden, keine Uhrzeit), über sleep mit Abbruch; nie kürzer, damit keine
 *   Wiederholung vor dem Reset kommt. Verlangt der Kopf mehr als
 *   RATE_LIMIT_MAX_WAIT_MS, bricht die Anfrage sofort mit Fehler "rate" ab
 *   und nennt die Wartezeit. Ohne Kopf RATE_LIMIT_MAX_WAIT_MS. Nach
 *   RATE_LIMIT_RETRIES Versuchen Fehler "rate".
 * - Frist (deps.remainingMs, etwa die zehn Minuten beim Warten aufs Projekt):
 *   keine Anfrage nach Fristende, Zeitlimit jeder Anfrage und jede Wartezeit
 *   höchstens die Restzeit; reicht sie nicht, Fehler "frist". Das gilt auch,
 *   wenn erst das Lesen des Antwortinhalts an der Frist scheitert.
 * - Bricht das Lesen des Antwortinhalts ab, ist das ein Fehler, nie eine
 *   leere Antwort.
 */

import { DEFAULT_TIMEOUT_MS, type HttpFetch } from "./context";

export const SUPABASE_API = "https://api.supabase.com";
export const SUPABASE_TOKEN_PAGE = "https://supabase.com/dashboard/account/tokens";
export const SUPABASE_DASHBOARD = "https://supabase.com/dashboard";

export const RATE_LIMIT_RETRIES = 3;
export const RATE_LIMIT_MAX_WAIT_MS = 60_000;
/** Migrationen können dauern; das Standard-Zeitlimit von defaultFetch (15 s) reicht dafür nicht */
export const SQL_TIMEOUT_MS = 180_000;

export type ManagementErrorKind =
  /** 401: Token abgelehnt */
  | "token"
  /** 403: Token darf das nicht */
  | "verboten"
  /** 404 */
  | "nichtGefunden"
  /** Grenze der kostenlosen Projekte erreicht */
  | "grenze"
  /** 429 nach allen Wartezeiten */
  | "rate"
  /** Frist aus deps.remainingMs abgelaufen oder reicht nicht */
  | "frist"
  /** Netz, Zeitlimit, unerwartete Antwort */
  | "netz"
  | "abgebrochen"
  /** Andere Fehlerantwort */
  | "fehler";

const MESSAGES: Record<ManagementErrorKind, string> = {
  token: "Supabase lehnt das Zugangstoken ab. Unter supabase.com/dashboard/account/tokens ein neues erzeugen und erneut versuchen.",
  verboten: "Das Zugangstoken darf das bei Supabase nicht. Ein Token ohne Einschränkungen erzeugen und erneut versuchen.",
  nichtGefunden: "Supabase kennt das Gesuchte nicht.",
  grenze:
    "Supabase legt kein weiteres Projekt an: Kostenlos gibt es zwei aktive Projekte pro Konto. Im Dashboard eines pausieren oder löschen, oder „Zugangsdaten selbst eintragen“ wählen und ein vorhandenes Projekt nutzen.",
  rate: "Supabase bremst gerade (zu viele Anfragen in kurzer Zeit). In einer Minute erneut versuchen.",
  frist: "Die Frist ist abgelaufen.",
  netz: "Supabase ist nicht erreichbar oder antwortet unerwartet. Internetverbindung prüfen und erneut versuchen.",
  abgebrochen: "Abgebrochen.",
  fehler: "Supabase meldet einen Fehler.",
};

export class SupabaseManagementError extends Error {
  readonly kind: ManagementErrorKind;
  readonly status?: number;
  constructor(kind: ManagementErrorKind, status?: number, message: string = MESSAGES[kind]) {
    super(status ? `${message} (HTTP ${status})` : message);
    this.name = "SupabaseManagementError";
    this.kind = kind;
    this.status = status;
  }
}

export interface SupabaseOrganization {
  slug: string;
  name: string;
  /** Nur bei organization(): free, pro, team, …; fehlt, wenn die API es nicht nennt */
  plan?: string;
}

export interface SupabaseProject {
  ref: string;
  name: string;
  organizationSlug: string;
  status: string;
}

export interface SupabaseServiceHealth {
  name: string;
  /** COMING_UP, ACTIVE_HEALTHY, UNHEALTHY */
  status: string;
}

export interface SupabaseApiKey {
  /** legacy, publishable, secret oder null */
  type: string | null;
  name: string;
  apiKey: string | null;
}

export interface SupabaseMigration {
  version: string;
  name?: string;
}

/** Eine Datei einer Edge Function; path relativ zum Projektordner, mit / */
export interface FunctionFile {
  path: string;
  content: string;
}

export interface DeployFunctionInput {
  slug: string;
  /** Einstiegsdatei, einer der Pfade aus files */
  entrypoint: string;
  files: FunctionFile[];
  verifyJwt: boolean;
}

export interface CreateProjectInput {
  name: string;
  organizationSlug: string;
  region: string;
  dbPass: string;
}

export interface SupabaseManagement {
  organizations(signal?: AbortSignal): Promise<SupabaseOrganization[]>;
  organization(slug: string, signal?: AbortSignal): Promise<SupabaseOrganization>;
  projects(signal?: AbortSignal): Promise<SupabaseProject[]>;
  /** null, wenn das Projekt nicht existiert oder mit diesem Token nicht sichtbar ist (404) */
  project(ref: string, signal?: AbortSignal): Promise<SupabaseProject | null>;
  createProject(input: CreateProjectInput, signal?: AbortSignal): Promise<SupabaseProject>;
  health(ref: string, services: string[], signal?: AbortSignal): Promise<SupabaseServiceHealth[]>;
  /** null, wenn der Migrations-Endpunkt fehlt (404) */
  migrations(ref: string, signal?: AbortSignal): Promise<SupabaseMigration[] | null>;
  /** false, wenn der Migrations-Endpunkt fehlt (404) */
  applyMigration(ref: string, migration: { name: string; query: string; idempotencyKey: string }, signal?: AbortSignal): Promise<boolean>;
  /** SQL über database/query; Antwort: Zeilen */
  query(ref: string, sql: string, signal?: AbortSignal): Promise<unknown[]>;
  apiKeys(ref: string, signal?: AbortSignal): Promise<SupabaseApiKey[]>;
  createSecretKey(ref: string, name: string, signal?: AbortSignal): Promise<SupabaseApiKey>;
  /**
   * Edge Function ausliefern (anlegen oder ersetzen), Issue #166:
   * POST /v1/projects/{ref}/functions/deploy?slug=<slug> als multipart
   */
  deployFunction(ref: string, input: DeployFunctionInput, signal?: AbortSignal): Promise<void>;
  /** Namen der Geheimnisse der Edge Functions, nie Werte */
  secretNames(ref: string, signal?: AbortSignal): Promise<string[]>;
  /** Geheimnisse setzen (vorhandene gleichen Namens werden ersetzt) */
  setSecrets(ref: string, secrets: Array<{ name: string; value: string }>, signal?: AbortSignal): Promise<void>;
}

export interface ManagementDeps {
  fetch: HttpFetch;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Basis der API, nur für Tests anders */
  base?: string;
  /** Restzeit einer Frist in ms; fehlt, gibt es keine Frist */
  remainingMs?: () => number;
}

/** Fehler "rate" für einen Reset, der länger ist als RATE_LIMIT_MAX_WAIT_MS */
function rateLimitTooLong(seconds: number): SupabaseManagementError {
  const minutes = Math.ceil(seconds / 60);
  return new SupabaseManagementError(
    "rate",
    429,
    `Supabase bremst gerade und nimmt erst in etwa ${minutes} Minuten wieder Anfragen an. Dann erneut versuchen.`,
  );
}

/** Projekt-Ref (20 Kleinbuchstaben) aus https://<ref>.supabase.co, sonst null */
export function refFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    const m = /^([a-z]{20})\.supabase\.co$/.exec(u.hostname);
    return u.protocol === "https:" && m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Liegt die Adresse bei Supabase in der Cloud (*.supabase.co)? */
export function isSupabaseCloudUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" && u.hostname.endsWith(".supabase.co");
  } catch {
    return false;
  }
}

export function projectUrl(ref: string): string {
  return `https://${ref}.supabase.co`;
}

const REF = /^[a-z]{20}$/;

function checkRef(ref: string): string {
  if (!REF.test(ref)) throw new SupabaseManagementError("nichtGefunden");
  return ref;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function toProject(raw: any): SupabaseProject {
  return { ref: str(raw?.ref), name: str(raw?.name), organizationSlug: str(raw?.organization_slug), status: str(raw?.status) };
}

function toKey(raw: any): SupabaseApiKey {
  return {
    type: typeof raw?.type === "string" ? raw.type : null,
    name: str(raw?.name),
    apiKey: typeof raw?.api_key === "string" && raw.api_key ? raw.api_key : null,
  };
}

/** Erkennt die Projektgrenze an Status und Stichwort (die Antwort ist nicht dokumentiert) */
export function looksLikeProjectLimit(status: number, text: string): boolean {
  if (![400, 402, 403, 409, 422].includes(status)) return false;
  const t = text.toLowerCase();
  return /limit|maximum|max\b|free project|quota|exceed/.test(t);
}

export function createSupabaseManagement(token: string, deps: ManagementDeps): SupabaseManagement {
  const base = deps.base ?? SUPABASE_API;

  interface Call {
    method?: string;
    body?: unknown;
    /** multipart statt JSON; Content-Type setzt fetch samt Grenze selbst */
    form?: FormData;
    headers?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  }

  const remaining = () => deps.remainingMs?.() ?? Number.POSITIVE_INFINITY;

  /** Eine Anfrage mit Warten bei 429; wirft nur SupabaseManagementError */
  async function send(path: string, call: Call = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      if (call.signal?.aborted) throw new SupabaseManagementError("abgebrochen");
      if (remaining() <= 0) throw new SupabaseManagementError("frist");
      const timeoutMs = deps.remainingMs ? Math.min(call.timeoutMs ?? DEFAULT_TIMEOUT_MS, remaining()) : call.timeoutMs;
      let res: Response;
      try {
        res = await deps.fetch(`${base}${path}`, {
          method: call.method ?? "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(call.body !== undefined && !call.form ? { "Content-Type": "application/json" } : {}),
            ...call.headers,
          },
          body: call.form ?? (call.body !== undefined ? JSON.stringify(call.body) : undefined),
          timeoutMs,
          signal: call.signal,
        });
      } catch {
        // Nie den Fehlertext: er könnte die Anfrage wiedergeben
        if (call.signal?.aborted) throw new SupabaseManagementError("abgebrochen");
        throw new SupabaseManagementError(remaining() <= 0 ? "frist" : "netz");
      }
      if (res.status !== 429) return res;
      await res.body?.cancel().catch(() => {});
      if (attempt >= RATE_LIMIT_RETRIES) throw new SupabaseManagementError("rate", 429);
      const seconds = Number(res.headers.get("X-RateLimit-Reset"));
      const known = Number.isFinite(seconds) && seconds > 0;
      const waitMs = known ? Math.ceil(seconds * 1000) : RATE_LIMIT_MAX_WAIT_MS;
      // Nie vor dem Reset erneut: zu lange Wartezeit heißt Abbruch mit Hinweis
      if (known && waitMs > RATE_LIMIT_MAX_WAIT_MS) throw rateLimitTooLong(seconds);
      if (waitMs >= remaining()) throw new SupabaseManagementError("frist");
      await deps.sleep(waitMs, call.signal);
      if (call.signal?.aborted) throw new SupabaseManagementError("abgebrochen");
    }
  }

  /** Fehlerart zu einer nicht erfolgreichen Antwort */
  function failure(res: Response): SupabaseManagementError {
    if (res.status === 401) return new SupabaseManagementError("token", 401);
    if (res.status === 403) return new SupabaseManagementError("verboten", 403);
    if (res.status === 404) return new SupabaseManagementError("nichtGefunden", 404);
    return new SupabaseManagementError(res.status >= 500 ? "netz" : "fehler", res.status);
  }

  /**
   * Liest den Antwortinhalt. Bricht das Lesen ab (Zeitlimit, Frist, Netz),
   * gilt es wie ein Fehler der Anfrage selbst, nie als leere Antwort
   */
  async function body(res: Response, signal?: AbortSignal): Promise<string> {
    try {
      return await res.text();
    } catch {
      if (signal?.aborted) throw new SupabaseManagementError("abgebrochen");
      throw new SupabaseManagementError(remaining() <= 0 ? "frist" : "netz", res.status);
    }
  }

  async function json(res: Response, signal?: AbortSignal): Promise<any> {
    const text = await body(res, signal);
    try {
      return JSON.parse(text);
    } catch {
      throw new SupabaseManagementError("netz", res.status);
    }
  }

  async function getJson(path: string, signal?: AbortSignal): Promise<any> {
    const res = await send(path, { signal });
    if (!res.ok) throw failure(res);
    return json(res, signal);
  }

  function list(data: any): any[] {
    if (!Array.isArray(data)) throw new SupabaseManagementError("netz");
    return data;
  }

  return {
    async organizations(signal) {
      return list(await getJson("/v1/organizations", signal))
        .map(o => ({ slug: str(o?.slug), name: str(o?.name) || str(o?.slug) }))
        .filter(o => o.slug);
    },

    async organization(slug, signal) {
      const data = await getJson(`/v1/organizations/${encodeURIComponent(slug)}`, signal);
      return { slug, name: str(data?.name) || slug, ...(typeof data?.plan === "string" ? { plan: data.plan } : {}) };
    },

    async projects(signal) {
      return list(await getJson("/v1/projects", signal)).map(toProject).filter(p => REF.test(p.ref));
    },

    async project(ref, signal) {
      const res = await send(`/v1/projects/${checkRef(ref)}`, { signal });
      if (res.status === 404) return null;
      if (!res.ok) throw failure(res);
      const p = toProject(await json(res, signal));
      if (!REF.test(p.ref)) throw new SupabaseManagementError("netz");
      return p;
    },

    async createProject(input, signal) {
      const res = await send("/v1/projects", {
        method: "POST",
        signal,
        body: {
          name: input.name,
          db_pass: input.dbPass,
          organization_slug: input.organizationSlug,
          region_selection: { type: "specific", code: input.region },
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (looksLikeProjectLimit(res.status, text)) throw new SupabaseManagementError("grenze", res.status);
        throw failure(res);
      }
      const p = toProject(await json(res, signal));
      if (!REF.test(p.ref)) throw new SupabaseManagementError("netz");
      return p;
    },

    async health(ref, services, signal) {
      const query = encodeURIComponent(services.join(","));
      return list(await getJson(`/v1/projects/${checkRef(ref)}/health?services=${query}`, signal)).map(s => ({
        name: str(s?.name),
        status: str(s?.status) || (s?.healthy === true ? "ACTIVE_HEALTHY" : ""),
      }));
    },

    async migrations(ref, signal) {
      const res = await send(`/v1/projects/${checkRef(ref)}/database/migrations`, { signal });
      if (res.status === 404) return null;
      if (!res.ok) throw failure(res);
      return list(await json(res, signal)).map(m => ({ version: str(m?.version), ...(typeof m?.name === "string" ? { name: m.name } : {}) }));
    },

    async applyMigration(ref, migration, signal) {
      const res = await send(`/v1/projects/${checkRef(ref)}/database/migrations`, {
        method: "POST",
        signal,
        timeoutMs: SQL_TIMEOUT_MS,
        headers: { "Idempotency-Key": migration.idempotencyKey },
        body: { query: migration.query, name: migration.name },
      });
      if (res.status === 404) return false;
      await res.body?.cancel().catch(() => {});
      if (!res.ok) throw failure(res);
      return true;
    },

    async query(ref, sql, signal) {
      const res = await send(`/v1/projects/${checkRef(ref)}/database/query`, {
        method: "POST",
        signal,
        timeoutMs: SQL_TIMEOUT_MS,
        body: { query: sql },
      });
      if (!res.ok) throw failure(res);
      // Unterbrochener Inhalt ist keine leere Liste: sonst gälten verbuchte Migrationen als fehlend
      const text = await body(res, signal);
      if (!text.trim()) return [];
      try {
        const data = JSON.parse(text);
        return Array.isArray(data) ? data : [];
      } catch {
        throw new SupabaseManagementError("netz", res.status);
      }
    },

    async apiKeys(ref, signal) {
      return list(await getJson(`/v1/projects/${checkRef(ref)}/api-keys?reveal=true`, signal)).map(toKey);
    },

    async createSecretKey(ref, name, signal) {
      const res = await send(`/v1/projects/${checkRef(ref)}/api-keys?reveal=true`, {
        method: "POST",
        signal,
        body: { type: "secret", name },
      });
      if (!res.ok) throw failure(res);
      return toKey(await json(res, signal));
    },

    async deployFunction(ref, input, signal) {
      const form = new FormData();
      form.append("metadata", JSON.stringify({ entrypoint_path: input.entrypoint, name: input.slug, verify_jwt: input.verifyJwt }));
      for (const f of input.files) form.append("file", new Blob([f.content], { type: "application/typescript" }), f.path);
      const res = await send(`/v1/projects/${checkRef(ref)}/functions/deploy?slug=${encodeURIComponent(input.slug)}`, {
        method: "POST",
        signal,
        timeoutMs: SQL_TIMEOUT_MS,
        form,
      });
      await res.body?.cancel().catch(() => {});
      if (!res.ok) throw failure(res);
    },

    async secretNames(ref, signal) {
      return list(await getJson(`/v1/projects/${checkRef(ref)}/secrets`, signal))
        .map(x => str(x?.name))
        .filter(Boolean);
    },

    async setSecrets(ref, secrets, signal) {
      const res = await send(`/v1/projects/${checkRef(ref)}/secrets`, { method: "POST", signal, body: secrets });
      await res.body?.cancel().catch(() => {});
      if (!res.ok) throw failure(res);
    },
  };
}
