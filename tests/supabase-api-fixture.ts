/**
 * Attrappe der Management-API von Supabase (Issue #163). Ein fetch, das alle
 * Anfragen aufzeichnet (Methode, Pfad, Köpfe, Rumpf) und einen kleinen
 * Zustand führt: Organisationen, Projekte, Migrationen, Schlüssel, Buckets.
 * Nichts geht ins Netz. Einzelne Antworten lassen sich über hooks ersetzen.
 */

import type { HttpFetch, HttpRequest } from "../src/setup/context";

/** Testwerte, keine echten Zugangsdaten */
export const SB = {
  token: "sbp_testtoken0000geheim1111aaaa2222bbbb",
  otherToken: "sbp_anderestoken9999geheim8888",
  ref: "abcdefghijklmnopqrst",
  otherRef: "zyxwvutsrqponmlkjihg",
  secret: "sb_secret_testschluessel_geheim_1234",
  secret2: "sb_secret_zweiterschluessel_geheim_5678",
  created: "sb_secret_neuangelegt_geheim_9999",
  publishable: "sb_publishable_testschluessel_4321",
  legacyService: "eyJ.legacy-service-role.geheim",
  legacyAnon: "eyJ.legacy-anon.geheim",
};

export interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
  /** Zeitlimit, das der Aufrufer der Anfrage mitgab */
  timeoutMs?: number;
}

export interface FakeProject {
  ref: string;
  name: string;
  organization_slug: string;
  status: string;
  /** Wie viele GET /v1/projects/{ref} noch COMING_UP liefern, bevor status gilt */
  comingUpPolls?: number;
}

export interface ApiKeyRow {
  type: string | null;
  name: string;
  api_key: string | null;
}

export interface FakeState {
  orgs: Array<{ slug: string; name: string; plan?: string }>;
  projects: FakeProject[];
  /** Migrationen je Projekt */
  migrations: Record<string, Array<{ version: string; name?: string }>>;
  keys: Record<string, ApiKeyRow[]>;
  buckets: Record<string, Record<string, boolean>>;
  /** Migrations-Endpunkt fehlt (404) */
  noMigrationsEndpoint?: boolean;
  /** Ausgeführte SQL-Texte über database/query */
  queries: string[];
  healthPolls: number;
  /** Wie viele Health-Abfragen noch COMING_UP liefern */
  healthComingUp?: number;
}

export type Hook = (req: Recorded) => Response | Promise<Response> | undefined | Promise<Response | undefined>;

export interface FakeApi {
  fetch: HttpFetch;
  calls: Recorded[];
  state: FakeState;
  /** Vor der Standardantwort: liefert eine Response, gilt diese */
  hooks: Hook[];
  /** Pfade in Reihenfolge, etwa "GET /v1/organizations" */
  trail(): string[];
}

export function defaultKeys(): ApiKeyRow[] {
  return [
    { type: "legacy", name: "anon", api_key: SB.legacyAnon },
    { type: "legacy", name: "service_role", api_key: SB.legacyService },
    { type: "publishable", name: "default", api_key: SB.publishable },
    { type: "secret", name: "default", api_key: SB.secret },
  ];
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });

export function fakeSupabaseApi(init: Partial<FakeState> = {}): FakeApi {
  const state: FakeState = {
    orgs: [{ slug: "org-alpha", name: "Alpha", plan: "free" }],
    projects: [],
    migrations: {},
    keys: {},
    buckets: {},
    queries: [],
    healthPolls: 0,
    ...init,
  };
  const calls: Recorded[] = [];
  const hooks: Hook[] = [];

  const fetch: HttpFetch = async (url: string, request: HttpRequest = {}) => {
    if (request.signal?.aborted) throw new DOMException("Abgebrochen", "AbortError");
    const u = new URL(url);
    let body: any;
    try {
      body = request.body ? JSON.parse(request.body) : undefined;
    } catch {
      body = request.body;
    }
    const rec: Recorded = { method: request.method ?? "GET", path: u.pathname + u.search, headers: { ...(request.headers ?? {}) }, body, timeoutMs: request.timeoutMs };
    calls.push(rec);
    for (const hook of hooks) {
      const r = await hook(rec);
      if (r) return r;
    }
    if (rec.headers.Authorization !== `Bearer ${SB.token}`) return json({ message: "Unauthorized" }, 401);
    return route(rec, u);
  };

  function project(ref: string) {
    return state.projects.find(p => p.ref === ref);
  }

  function route(rec: Recorded, u: URL): Response {
    const p = u.pathname;
    const m = rec.method;
    if (m === "GET" && p === "/v1/organizations") return json(state.orgs.map(o => ({ id: o.slug, slug: o.slug, name: o.name })));
    let match = /^\/v1\/organizations\/([^/]+)$/.exec(p);
    if (m === "GET" && match) {
      const org = state.orgs.find(o => o.slug === decodeURIComponent(match![1]));
      return org ? json({ id: org.slug, name: org.name, plan: org.plan, opt_in_tags: [], allowed_release_channels: [] }) : json({}, 404);
    }
    if (m === "GET" && p === "/v1/projects") return json(state.projects.map(pr => ({ ...pr, status: pr.comingUpPolls ? "COMING_UP" : pr.status, id: pr.ref, organization_id: pr.organization_slug, region: "eu-central-1", created_at: "" })));
    if (m === "POST" && p === "/v1/projects") {
      const ref = state.projects.length === 0 ? SB.ref : SB.otherRef;
      const created: FakeProject = { ref, name: rec.body.name, organization_slug: rec.body.organization_slug, status: "ACTIVE_HEALTHY", comingUpPolls: 2 };
      state.projects.push(created);
      state.keys[ref] ??= defaultKeys();
      return json({ ...created, status: "COMING_UP", id: ref, organization_id: created.organization_slug, region: "eu-central-1", created_at: "" }, 201);
    }
    match = /^\/v1\/projects\/([a-z]{20})(\/.*)?$/.exec(p);
    if (!match) return json({}, 404);
    const ref = match[1];
    const rest = match[2] ?? "";
    const pr = project(ref);
    if (!pr) return json({ message: "not found" }, 404);
    if (m === "GET" && rest === "") {
      let status = pr.status;
      if (pr.comingUpPolls && pr.comingUpPolls > 0) {
        pr.comingUpPolls--;
        status = "COMING_UP";
      }
      return json({ ...pr, status, id: pr.ref, organization_id: pr.organization_slug, region: "eu-central-1", created_at: "", database: {} });
    }
    if (m === "GET" && rest === "/health") {
      state.healthPolls++;
      const coming = (state.healthComingUp ?? 0) > 0;
      if (coming) state.healthComingUp!--;
      const names = (u.searchParams.get("services") ?? "").split(",");
      return json(names.map(n => ({ name: n, healthy: !coming, status: coming ? "COMING_UP" : "ACTIVE_HEALTHY" })));
    }
    if (rest === "/database/migrations") {
      if (state.noMigrationsEndpoint) return json({ message: "Not Found" }, 404);
      state.migrations[ref] ??= [];
      if (m === "GET") return json(state.migrations[ref]);
      if (m === "POST") {
        state.migrations[ref].push({ version: String(20260926000000 + state.migrations[ref].length), name: rec.body.name });
        return json({}, 200);
      }
    }
    if (m === "POST" && rest === "/database/query") {
      const sql: string = rec.body.query;
      state.queries.push(sql);
      if (sql.startsWith("select version, name from supabase_migrations")) return json(state.migrations[ref] ?? []);
      const recorded = /insert into supabase_migrations\.schema_migrations \(version, name\) values \('(\d+)', '([a-z0-9_]+)'\)/.exec(sql);
      if (recorded) {
        state.migrations[ref] ??= [];
        if (!state.migrations[ref].some(x => x.version === recorded[1])) state.migrations[ref].push({ version: recorded[1], name: recorded[2] });
        return json([], 201);
      }
      const bucket = /insert into storage\.buckets \(id, name, public\) values \('([^']+)'/.exec(sql);
      if (bucket) {
        state.buckets[ref] ??= {};
        if (!(bucket[1] in state.buckets[ref])) state.buckets[ref][bucket[1]] = false;
        return json([{ public: state.buckets[ref][bucket[1]] }], 201);
      }
      return json([], 201);
    }
    if (rest === "/api-keys") {
      state.keys[ref] ??= [];
      if (m === "GET") return json(state.keys[ref].map(k => ({ ...k, id: k.name })));
      if (m === "POST") {
        const row = { type: rec.body.type, name: rec.body.name, api_key: SB.created };
        state.keys[ref].push(row);
        return json({ ...row, id: row.name }, 201);
      }
    }
    return json({}, 404);
  }

  return {
    fetch,
    calls,
    state,
    hooks,
    trail: () => calls.map(c => `${c.method} ${c.path.split("?")[0]}`),
  };
}
