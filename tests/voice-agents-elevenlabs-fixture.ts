/**
 * Attrappe von ElevenLabs für die Sprachschicht (Issue #490): hält Agenten,
 * Geheimnisse und Tests im Speicher, zeichnet jeden Aufruf auf und kann einzelne
 * Aufrufe scheitern lassen. Es gibt keine echten Anfragen.
 */
import { parseRecipe, type Recipe } from "../src/lib/voice-agents/recipe";

export const API_KEY = "xi-test-schluessel-1234567890";
export const BRIDGE_TOKEN = "brueckentoken-abcdef-987654";
export const BRIDGE_URL = "https://bruecke.example.com/v1/chat/completions";
export const ENV = { ELEVENLABS_API_KEY: API_KEY };
export const BRIDGE_ENV = { ...ENV, VOICE_BRIDGE_URL: BRIDGE_URL, VOICE_BRIDGE_TOKEN: BRIDGE_TOKEN };

export interface RecordedCall {
  method: string;
  path: string;
  body: any;
  raw: string;
  apiKey: string | null;
}

type Reply = (call: RecordedCall) => Response | Promise<Response>;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

/** Tief zusammenführen, null ersetzt. Die Doku des Anbieters legt das für language_presets nicht fest; siehe PresetPatch. */
function merge(target: any, patch: any): any {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = { ...(target && typeof target === "object" ? target : {}) };
  for (const [key, value] of Object.entries(patch)) out[key] = merge(out[key], value);
  return out;
}

/**
 * Was PATCH mit language_presets tun könnte; die Doku des Anbieters lässt es offen.
 * Ein null in der Karte lehnt die Attrappe immer ab: Laut Schema ist es kein Wert.
 * Belegt sind nur POST /agents/create (genau die gesendeten Einträge) und DELETE.
 */
export type PresetPatch = "zusammenfuehren" | "ersetzen";

export class FakeElevenLabs {
  calls: RecordedCall[] = [];
  agents = new Map<string, any>();
  secrets = new Map<string, any>();
  tests = new Map<string, any>();
  invocations: any[] = [];
  presetPatch: PresetPatch = "zusammenfuehren";
  private nextId = 1;
  private overrides: { match: (call: RecordedCall) => boolean; reply: Reply; times: number }[] = [];

  /** Die nächsten times passenden Aufrufe bekommen diese Antwort */
  override(match: (call: RecordedCall) => boolean, reply: Reply, times = 1): void {
    this.overrides.push({ match, reply, times });
  }

  /** Aufrufe außer den Lesezugriffen */
  writes(): RecordedCall[] {
    return this.calls.filter((call) => call.method !== "GET");
  }

  of(method: string, pattern: RegExp): RecordedCall[] {
    return this.calls.filter((call) => call.method === method && pattern.test(call.path));
  }

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const path = url.replace("https://api.elevenlabs.io/v1/convai", "");
    const raw = typeof init.body === "string" ? init.body : "";
    const call: RecordedCall = { method: init.method ?? "GET", path, raw, body: raw ? JSON.parse(raw) : undefined, apiKey: (init.headers as Record<string, string>)["xi-api-key"] ?? null };
    this.calls.push(call);
    const special = this.overrides.find((item) => item.times > 0 && item.match(call));
    if (special) {
      special.times--;
      return special.reply(call);
    }
    return this.route(call);
  };

  private id(prefix: string): string {
    return `${prefix}_${this.nextId++}`;
  }

  private route({ method, path, body }: RecordedCall): Response {
    let match: RegExpMatchArray | null;
    if (method === "POST" && path === "/agents/create") {
      const id = this.id("agent");
      // Zuordnungen kommen als leere Listen, wie GET /agents/{id} sie liefert
      this.agents.set(id, merge({ metadata: { created_at_unix_secs: 1 }, conversation_config: { asr: { quality: "high" } }, phone_numbers: [], whatsapp_accounts: [] }, body));
      return json({ agent_id: id });
    }
    if ((match = path.match(/^\/agents\/([^/]+)$/))) {
      const agent = this.agents.get(match[1]!);
      if (!agent) return json({ detail: "not found" }, 404);
      if (method === "GET") return json({ agent_id: match[1], ...agent });
      if (method === "PATCH") {
        const presets = body?.conversation_config?.language_presets;
        if (presets && Object.values(presets).some((item) => item === null)) return json({ detail: "language_presets: value is not a valid dict" }, 422);
        const merged = merge(agent, body);
        if (presets && this.presetPatch === "ersetzen") merged.conversation_config.language_presets = presets;
        this.agents.set(match[1]!, merged);
        return json({ agent_id: match[1], ...this.agents.get(match[1]!) });
      }
      if (method === "DELETE") {
        this.agents.delete(match[1]!);
        return new Response(null, { status: 204 });
      }
    }
    if (method === "POST" && path === "/secrets") {
      const id = this.id("secret");
      this.secrets.set(id, body);
      return json({ type: "stored", secret_id: id, name: body.name });
    }
    if ((match = path.match(/^\/secrets\/([^/]+)$/))) {
      if (!this.secrets.has(match[1]!)) return json({ detail: "not found" }, 404);
      if (method === "PATCH") {
        this.secrets.set(match[1]!, body);
        return json({ type: "stored", secret_id: match[1], name: body.name });
      }
      if (method === "DELETE") {
        this.secrets.delete(match[1]!);
        return new Response(null, { status: 204 });
      }
    }
    if (method === "POST" && path === "/agent-testing/create") {
      const id = this.id("test");
      this.tests.set(id, body);
      return json({ id });
    }
    if ((match = path.match(/^\/agent-testing\/([^/]+)$/))) {
      if (!this.tests.has(match[1]!)) return json({ detail: "not found" }, 404);
      if (method === "PUT") {
        this.tests.set(match[1]!, body);
        return json({ id: match[1], ...body });
      }
      if (method === "DELETE") {
        this.tests.delete(match[1]!);
        return new Response(null, { status: 204 });
      }
    }
    if (method === "POST" && /^\/agents\/[^/]+\/run-tests$/.test(path)) return json({ id: "lauf_1", test_runs: [] });
    if (method === "GET" && path.startsWith("/test-invocations/")) {
      const next = this.invocations.length > 1 ? this.invocations.shift() : this.invocations[0];
      return next === undefined ? json({ detail: "not found" }, 404) : json(next);
    }
    return json({ detail: `unbekannt: ${method} ${path}` }, 400);
  }
}

export function fakeClock(start = Date.parse("2026-10-30T12:00:00Z")) {
  const clock = {
    time: start,
    sleeps: [] as number[],
    now: () => clock.time,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.time += ms;
    },
  };
  return clock;
}

export function baseRecipe(): any {
  return {
    schema: 1,
    kennung: "beispiel",
    name: "Beispiel",
    vorlage: "jarvis",
    zweck: "Hilft im Alltag.",
    persona: { rolle: "Ruhiger Assistent", anrede: "du", sprachen: ["de"], ersterSatz: "Was liegt an?" },
    stimme: { art: "bibliothek", voiceId: "stimme-1", modell: "eleven_flash_v2_5", tempo: 1.1 },
    gehirn: { art: "anbieter", modell: "claude-sonnet-5-5" },
    gedaechtnis: "voll",
    zugang: { web: { link: true }, maxMinuten: 12, budget: { minutenMonat: 300, anrufeJeNummerTag: 0 } },
    nachlauf: { zusammenfassung: true, faden: false, kalendervorschlag: false, anruferMerken: false, training: false, ziel: "direktchat" },
    tests: [
      { name: "Erster", szenario: "Jemand fragt nach", kriterien: ["antwortet"], maxZuege: 4 },
      { name: "Zweiter", szenario: "Jemand drängelt", kriterien: ["bleibt ruhig"], maxZuege: 6 },
    ],
  };
}

export function recipeFrom(raw: unknown): Recipe {
  const parsed = parseRecipe(raw);
  if (!parsed.ok) throw new Error(parsed.fehler.join("; "));
  return parsed.recipe;
}

export function bridgeRecipe(): Recipe {
  const raw = baseRecipe();
  raw.gehirn = { art: "bruecke", modell: "claude-opus-5-5" };
  return recipeFrom(raw);
}

export function jsonResponse(data: unknown, status = 200): Response {
  return json(data, status);
}
