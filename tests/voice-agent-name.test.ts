/**
 * Issue #138: Der Sprachagent heißt nach VOICE_AGENT_NAME, ohne Variable wie
 * das Produkt (BRAND.name). Geprüft werden beide Begrüßungen am Telefon (über
 * createPhone und startCall mit Attrappe für HTTP, ohne Datenbank; seit
 * Issue #367 der Anrufweg aus src/lib/phone/), der Sprechstil im Systemprompt
 * der Sprach-Brücke und der Text des Denkauftrags. Der Server-Einstieg
 * src/voice-bridge.ts wird nicht geladen.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BRAND } from "../src/brand";
import { resetStore } from "../src/lib/store";
import { voiceAgentName } from "../src/lib/voice-agent-name";
import { callGreetingFor, createPhone } from "../src/lib/phone";
import { deepThinkText, handleBridge, type BridgeEnv } from "../src/lib/voice-bridge/bridge";

const CALL_ENV = {
  ELEVENLABS_API_KEY: "test-key",
  ELEVENLABS_AGENT_ID: "agent-1",
  ELEVENLABS_PHONE_NUMBER_ID: "phone-1",
  USER_PHONE_NUMBER: "+10000000000",
};
const KEYS = ["VOICE_AGENT_NAME", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];

let saved: Record<string, string | undefined>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  delete process.env.VOICE_AGENT_NAME;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  globalThis.fetch = realFetch;
});

describe("voiceAgentName", () => {
  test("ohne Variable, leer oder nur Leerzeichen: BRAND.name", () => {
    expect(voiceAgentName({})).toBe(BRAND.name);
    expect(voiceAgentName({ VOICE_AGENT_NAME: "" })).toBe(BRAND.name);
    expect(voiceAgentName({ VOICE_AGENT_NAME: "   " })).toBe(BRAND.name);
  });

  test("mit Variable: der Name, ohne Rand-Leerzeichen", () => {
    expect(voiceAgentName({ VOICE_AGENT_NAME: " Mia " })).toBe("Mia");
  });

  test("liest process.env beim Aufruf, nicht beim Laden", () => {
    expect(voiceAgentName()).toBe(BRAND.name);
    process.env.VOICE_AGENT_NAME = "Mia";
    expect(voiceAgentName()).toBe("Mia");
  });
});

describe("Begrüßung am Telefon", () => {
  /** Erster Satz beim Anbieter, über createPhone wie im Bot (fetch-Attrappe, Anrufliste im Testordner) */
  async function firstMessage(reason: string): Promise<string> {
    const bodies: any[] = [];
    // Ohne conversation_id holt der Dienst kein Protokoll ab, es läuft nichts nach
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ success: true });
    }) as unknown as typeof fetch;
    // Ohne Datenbank liefert der Store leeres Gedächtnis und keinen Verlauf (Issue #314)
    for (const name of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) delete process.env[name];
    resetStore();
    const phone = createPhone({
      send: async () => ({ ok: true }) as never,
      sendChoice: async () => ({ sent: true }),
      task: {} as never,
      env: { ...CALL_ENV, GO_PROJECT_ROOT: root },
      log: () => {},
    });
    const result = await phone.startCall({ reason, conversation: { type: "telegram", chatId: "4711" }, userName: "Alex" });
    phone.stop();
    expect(result.ok).toBe(true);
    expect(bodies).toHaveLength(1);
    return bodies[0].first_message;
  }

  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "voice-agent-name-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("ohne VOICE_AGENT_NAME nennt sich der Anruf BRAND.name, in beiden Zweigen", async () => {
    expect(await firstMessage("")).toBe(`Hallo Alex, hier ist ${BRAND.name}. Ich melde mich kurz: Was beschäftigt dich gerade?`);
    expect(await firstMessage("Umzug planen")).toBe(`Hallo Alex, hier ist ${BRAND.name}. Ich rufe an wegen: Umzug planen. Passt es gerade?`);
  });

  test("mit VOICE_AGENT_NAME=Mia nennt sich der Anruf Mia, in beiden Zweigen", async () => {
    process.env.VOICE_AGENT_NAME = "Mia";
    expect(await firstMessage("")).toBe("Hallo Alex, hier ist Mia. Ich melde mich kurz: Was beschäftigt dich gerade?");
    expect(await firstMessage("Umzug planen")).toBe("Hallo Alex, hier ist Mia. Ich rufe an wegen: Umzug planen. Passt es gerade?");
  });

  test("callGreetingFor nimmt einen ausdrücklich übergebenen Namen", () => {
    expect(callGreetingFor("Alex", "Mia", "")).toContain("hier ist Mia.");
    expect(callGreetingFor("Alex", "Mia", "Umzug planen")).toContain("hier ist Mia.");
  });
});

describe("Sprach-Brücke", () => {
  // Ohne Rufnummer-Header (Web-Gespraech): hier geht es nur um den Sprechstil
  const baseEnv: BridgeEnv = { VOICE_ANTHROPIC_API_KEY: "sk-test", VOICE_BRIDGE_TOKEN: "secret-token", VOICE_ALLOW_UNIDENTIFIED: "true" };

  async function systemPrompt(env: BridgeEnv): Promise<string> {
    const bodies: any[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const req = new Request("https://bridge.test/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
      body: JSON.stringify({ model: "x", stream: true, messages: [{ role: "user", content: "Hallo!" }] }),
    });
    const res = await handleBridge(req, env, {}, () => {});
    await res.text();
    expect(bodies).toHaveLength(1);
    return bodies[0].system;
  }

  test("Sprechstil ohne VOICE_AGENT_NAME: BRAND.name", async () => {
    expect(await systemPrompt(baseEnv)).toContain(`(Voice-Agent ${BRAND.name})`);
  });

  test("Sprechstil mit VOICE_AGENT_NAME=Mia: Mia", async () => {
    const system = await systemPrompt({ ...baseEnv, VOICE_AGENT_NAME: "Mia" });
    expect(system).toContain("(Voice-Agent Mia)");
    expect(system).not.toContain(`(Voice-Agent ${BRAND.name})`);
  });

  test("Denkauftrag nennt den Sprachagenten", () => {
    expect(deepThinkText("Vergleich A vs B", voiceAgentName({}))).toBe(
      `Denkauftrag aus dem Sprachgespräch mit ${BRAND.name}: Vergleich A vs B\n\nArbeite das gründlich aus und antworte hier in Telegram.`,
    );
    expect(deepThinkText("Vergleich A vs B", voiceAgentName({ VOICE_AGENT_NAME: "Mia" }))).toStartWith("Denkauftrag aus dem Sprachgespräch mit Mia: ");
  });
});
