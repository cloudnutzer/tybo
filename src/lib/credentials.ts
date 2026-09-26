/**
 * Credential Registry — Source of Truth fuer externe Tool-Zugaenge (Tool-Gateway Phase 0)
 *
 * Jeder produktive Key liegt in `.env`. Die Registry loest alternative
 * Quellen (z.B. ~/.claude.json MCP env) nur als Migrations-Fallback auf
 * und warnt dabei einmalig, damit der Key in .env nachgezogen wird.
 *
 * Regeln:
 * - Niemals Key-Werte loggen, nur Quell-Typen.
 * - Funktioniert auch standalone (Watcher-Skripte ohne env.ts-Boot):
 *   die env-Quelle faellt auf direktes Lesen der .env-Datei zurueck.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface CredentialSource {
  type: "env" | "claudeJsonMcpEnv";
  /** Nur fuer claudeJsonMcpEnv: Server-Name in ~/.claude.json mcpServers */
  server?: string;
  /** Nur fuer claudeJsonMcpEnv: env-Key dort (default: Credential-Name) */
  envKey?: string;
}

export interface CredentialSpec {
  name: string;
  /** Tools/Features, die diesen Key brauchen (fuer verify-tools Bericht) */
  usedBy?: string[];
  sources: CredentialSource[];
}

export interface ResolvedCredential {
  name: string;
  value: string;
  source: CredentialSource;
}

const specs = new Map<string, CredentialSpec>();
const cache = new Map<string, ResolvedCredential | null>();
const warned = new Set<string>();

const PROJECT_ROOT = process.env.GO_PROJECT_ROOT || process.cwd();

function readDotEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const p = join(PROJECT_ROOT, ".env");
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

let dotEnvCache: Record<string, string> | null = null;
function dotEnv(): Record<string, string> {
  if (!dotEnvCache) dotEnvCache = readDotEnv();
  return dotEnvCache;
}

function trySource(
  name: string,
  src: CredentialSource
): string | null {
  switch (src.type) {
    case "env": {
      const v = process.env[name] ?? dotEnv()[name];
      return v && v.trim() ? v.trim() : null;
    }
    case "claudeJsonMcpEnv": {
      const cfg = join(homedir(), ".claude.json");
      if (!existsSync(cfg)) return null;
      try {
        const raw = JSON.parse(readFileSync(cfg, "utf8"));
        const server = src.server ?? "";
        const key = src.envKey ?? name;
        const v = raw?.mcpServers?.[server]?.env?.[key];
        return typeof v === "string" && v.trim() ? v.trim() : null;
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

function warnOnce(name: string, src: CredentialSource): void {
  if (warned.has(name)) return;
  warned.add(name);
  console.warn(
    `[Credentials] ${name} kommt aus Migrations-Fallback (${src.type}${src.server ? `/${src.server}` : ""}). ` +
      `Bitte in .env nachziehen.`
  );
}

/** Deklariere ein Credential mit seinen Quellen (Prio = Array-Reihenfolge). */
export function declareCredential(spec: CredentialSpec): void {
  specs.set(spec.name, spec);
  cache.delete(spec.name);
}

/**
 * Loest ein Credential auf. Erste Quelle mit Wert gewinnt; bei jeder
 * Nicht-.env-Quelle wird einmalig gewarnt. Ergebnis wird gecached.
 */
export function resolveCredential(name: string): ResolvedCredential | null {
  if (cache.has(name)) return cache.get(name)!;

  const spec = specs.get(name) ?? {
    name,
    // Undeklarierte Keys: .env + Prozess-env sind immer die erste Wahl
    sources: [{ type: "env" } as CredentialSource],
  };

  for (const src of spec.sources) {
    const value = trySource(name, src);
    if (value) {
      if (src.type !== "env") warnOnce(name, src);
      const hit: ResolvedCredential = { name, value, source: src };
      cache.set(name, hit);
      return hit;
    }
  }
  cache.set(name, null);
  return null;
}

/** Wie resolveCredential, wirft aber wenn nichts gefunden wurde. */
export function requireCredential(name: string): string {
  const hit = resolveCredential(name);
  if (!hit) throw new Error(`Credential ${name} nicht gefunden (.env ist Source of Truth)`);
  return hit.value;
}

/** Wert oder Default, fuer optionale Keys. */
export function optionalCredential(name: string, fallback = ""): string {
  return resolveCredential(name)?.value ?? fallback;
}

/**
 * Status-Report fuer `setup:verify-tools` — keine Werte, nur Quell-Typen.
 */
export function credentialStatus(): {
  name: string;
  found: boolean;
  sourceType: string | null;
  usedBy: string[];
}[] {
  return Array.from(specs.values()).map((spec) => {
    const hit = resolveCredential(spec.name);
    return {
      name: spec.name,
      found: !!hit,
      sourceType: hit ? hit.source.type : null,
      usedBy: spec.usedBy ?? [],
    };
  });
}

// ---------------------------------------------------------------------------
// Standard-Credentials (ergaenzbar von Tools/Watchern via declareCredential)
// ---------------------------------------------------------------------------

declareCredential({
  name: "FIRECRAWL_API_KEY",
  usedBy: ["firecrawl_scrape", "firecrawl_search"],
  sources: [
    { type: "env" },
    { type: "claudeJsonMcpEnv", server: "firecrawl" },
  ],
});

declareCredential({
  name: "APIFY_API_KEY",
  usedBy: ["apify_run_actor"],
  sources: [{ type: "env" }],
});

declareCredential({
  name: "CLOUDFLARE_API_TOKEN",
  usedBy: ["cloudflare_deployments"],
  sources: [{ type: "env" }],
});

declareCredential({
  name: "CLOUDFLARE_ACCOUNT_ID",
  usedBy: ["cloudflare_deployments"],
  sources: [{ type: "env" }],
});

declareCredential({
  name: "ELEVENLABS_API_KEY",
  usedBy: ["elevenlabs_tts", "elevenlabs_call", "voice"],
  sources: [{ type: "env" }],
});
