/**
 * Attrappen für „Supabase auf diesem Rechner“ (Issue #164): docker und die
 * Supabase-CLI als aufzeichnender CommandRunner, Postgres als aufzeichnender
 * SqlRunner, Heimnetz-Prüfung und Arbeitsspeicher als feste Werte. Kein
 * echtes Docker, kein Postgres, kein Netz.
 */

import type { CommandResult, CommandRunner, RunOptions } from "../src/setup/context";
import { LOCAL_API_PORT, LOCAL_DB_PORT, SUPABASE_CLI_VERSION, type LocalSupabaseDeps, type SqlRunner } from "../src/setup/local-supabase";

/** Testwerte in der Form der lokalen Schlüssel, keine echten */
export const LOCAL = {
  secret: "sb_secret_lokalertestschluessel_geheim_1111",
  publishable: "sb_publishable_lokalertestschluessel_2222",
  legacyService: "eyJ.lokal-service-role.geheim",
  legacyAnon: "eyJ.lokal-anon.geheim",
  dbPassword: "lokales-db-passwort-geheim-3333",
  get dbUrl() {
    return `postgresql://postgres:${this.dbPassword}@127.0.0.1:${LOCAL_DB_PORT}/postgres`;
  },
  apiUrl: `http://127.0.0.1:${LOCAL_API_PORT}`,
};

export const LOCAL_SECRETS = [LOCAL.secret, LOCAL.publishable, LOCAL.legacyService, LOCAL.legacyAnon, LOCAL.dbPassword, LOCAL.dbUrl];

export function statusJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    API_URL: LOCAL.apiUrl,
    DB_URL: LOCAL.dbUrl,
    ANON_KEY: LOCAL.legacyAnon,
    SERVICE_ROLE_KEY: LOCAL.legacyService,
    PUBLISHABLE_KEY: LOCAL.publishable,
    SECRET_KEY: LOCAL.secret,
    JWT_SECRET: "super-secret-jwt-token-with-at-least-32-characters-long",
    ...overrides,
  });
}

export interface RecordedRun {
  cmd: string[];
  options: RunOptions;
}

/** Antwort je Befehl; Schlüssel: "docker --version", "docker info", "supabase --version", "supabase start" … */
export type Answer = Partial<CommandResult> | ((cmd: string[], options: RunOptions) => Partial<CommandResult> | Promise<Partial<CommandResult>>);

export const CLI_PREFIX = [process.execPath, "x", "--bun", `supabase@${SUPABASE_CLI_VERSION}`];

/** Container nach einem Start: alle Ports nur an 127.0.0.1 (wie im Netz supabase_network_tybo) */
export const SAFE_CONTAINERS = ["supabase_kong_tybo\t127.0.0.1:54421->8000/tcp", "supabase_db_tybo\t127.0.0.1:54422->5432/tcp", "supabase_auth_tybo\t"];
/** So sieht docker ps aus, wenn Docker an alle Schnittstellen bindet */
export const OPEN_CONTAINERS = ["supabase_kong_tybo\t0.0.0.0:54421->8000/tcp, [::]:54421->8000/tcp", "supabase_db_tybo\t0.0.0.0:54422->5432/tcp"];

/** Kurzname eines Befehls: "docker info", "docker network inspect" bzw. "supabase start" */
export function shortName(cmd: string[]): string {
  if (cmd[0] === "docker" && cmd[1] === "network") return `docker network ${cmd[2]}`;
  if (cmd[0] === "docker") return `docker ${cmd[1]}`;
  if (cmd.slice(0, CLI_PREFIX.length).join("\0") === CLI_PREFIX.join("\0")) return `supabase ${cmd[CLI_PREFIX.length]}`;
  return cmd.join(" ");
}

export interface FakeLocal {
  run: CommandRunner & { calls: RecordedRun[] };
  /** Kurznamen der Befehle in Reihenfolge */
  trail(): string[];
  answers: Record<string, Answer>;
  sql: SqlRunner;
  /** Sitzungen: Adresse, Aufrufe (file:<pfad> bzw. query:<text>), geschlossen? */
  sessions: Array<{ dbUrl: string; ops: string[]; closed: boolean; signal: AbortSignal }>;
  /** Antwort auf eine Abfrage; Standard: Bilder-Ordner fehlt vorab, danach privat */
  onQuery: (text: string) => Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>>;
  onFile: (path: string) => void | Promise<void>;
  lan: number[];
  mem: number;
  /** Laufende Container (Zeilen von docker ps: Name, Tab, Ports) */
  containers: string[];
  /** Container nach supabase start; Standard: SAFE_CONTAINERS bei Erfolg, sonst unverändert */
  afterStart: string[] | null;
  /** supabase stop hält die Container nicht an (gescheiterter Stopp) */
  stopKeeps: boolean;
  deps: Partial<LocalSupabaseDeps>;
}

export function fakeLocal(answers: Record<string, Answer> = {}): FakeLocal {
  const calls: RecordedRun[] = [];
  const f: FakeLocal = {
    answers: {
      "docker --version": { stdout: "Docker version 28.4.0, build abc" },
      "docker info": { stdout: "28.4.0" },
      "docker network inspect": { code: 1, stderr: "Error response from daemon: network supabase_network_tybo not found" },
      "docker network create": { stdout: "0123abcd" },
      "docker ps": () => ({ stdout: f.containers.map(c => `${c}\n`).join("") }),
      "supabase --version": { stdout: SUPABASE_CLI_VERSION },
      "supabase start": { stdout: `Started supabase local development setup.\nDB URL: ${LOCAL.dbUrl}\nSecret: ${LOCAL.secret}` },
      "supabase status": { stdout: statusJson() },
      "supabase stop": { stdout: "Stopped supabase local development setup." },
      ...answers,
    },
    run: undefined as any,
    trail: () => calls.map(c => shortName(c.cmd)),
    sql: undefined as any,
    sessions: [],
    onQuery: text => (text.startsWith("select public from storage.buckets") ? [] : text.includes("insert into storage.buckets") ? [{ public: false }] : []),
    onFile: () => {},
    lan: [],
    mem: 16 * 1024 ** 3,
    containers: [],
    afterStart: null,
    stopKeeps: false,
    deps: undefined as any,
  };
  const run = (async (cmd: string[], options: RunOptions = {}) => {
    calls.push({ cmd, options });
    if (options.signal?.aborted) return { code: -1, stdout: "", stderr: "Abgebrochen", aborted: true };
    const answer = f.answers[shortName(cmd)];
    if (!answer) return { code: -1, stdout: "", stderr: "Befehl nicht gefunden" };
    const r = typeof answer === "function" ? await answer(cmd, options) : answer;
    const result = { code: 0, stdout: "", stderr: "", ...r };
    const name = shortName(cmd);
    if (name === "supabase start") f.containers = f.afterStart ?? (result.code === 0 ? SAFE_CONTAINERS : f.containers);
    if (name === "supabase stop" && result.code === 0 && !f.stopKeeps) f.containers = [];
    return result;
  }) as FakeLocal["run"];
  run.calls = calls;
  f.run = run;
  f.sql = (dbUrl, signal) => {
    const s = { dbUrl, ops: [] as string[], closed: false, signal };
    f.sessions.push(s);
    return {
      async file(path) {
        s.ops.push(`file:${path}`);
        await f.onFile(path);
      },
      async query(text) {
        s.ops.push(`query:${text}`);
        return f.onQuery(text);
      },
      async close() {
        s.closed = true;
      },
    };
  };
  f.deps = {
    sql: (url, signal) => f.sql(url, signal),
    lanReachable: async ports => ports.filter(p => f.lan.includes(p)),
    totalMem: () => f.mem,
  };
  return f;
}
