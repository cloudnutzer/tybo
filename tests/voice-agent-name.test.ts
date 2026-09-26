/**
 * Issue #138: Der Sprachagent heißt nach VOICE_AGENT_NAME, ohne Variable wie
 * das Produkt (BRAND.name). Geprüft werden beide Begrüßungen am Telefon (über
 * initiatePhoneCall mit Attrappen für HTTP und Datenbank), der Sprechstil im
 * Systemprompt der Sprach-Brücke und der Text des Denkauftrags. Der
 * Server-Einstieg src/voice-bridge.ts wird nicht geladen.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { BRAND } from "../src/brand";
import * as db from "../src/lib/convex";
import { voiceAgentName } from "../src/lib/voice-agent-name";
import { callGreeting, initiatePhoneCall } from "../src/lib/voice";
import { deepThinkText, handleBridge, type BridgeEnv } from "../src/lib/voice-bridge/bridge";

const CALL_ENV = {
  ELEVENLABS_API_KEY: "test-key",
  ELEVENLABS_AGENT_ID: "agent-1",
  ELEVENLABS_PHONE_NUMBER_ID: "phone-1",
  USER_PHONE_NUMBER: "+10000000000",
  TELEGRAM_USER_ID: "4711",
};
const KEYS = [...Object.keys(CALL_ENV), "VOICE_AGENT_NAME"];

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
  async function firstMessage(context: string): Promise<string> {
    Object.assign(process.env, CALL_ENV);
    const bodies: any[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ conversation_id: "c1" });
    }) as unknown as typeof fetch;
    const memory = spyOn(db, "getMemoryContext").mockResolvedValue("");
    const recent = spyOn(db, "getRecentMessages").mockResolvedValue([]);
    try {
      const result = await initiatePhoneCall(context, "Alex");
      expect(result.success).toBe(true);
    } finally {
      memory.mockRestore();
      recent.mockRestore();
    }
    expect(bodies).toHaveLength(1);
    return bodies[0].first_message;
  }

  test("ohne VOICE_AGENT_NAME nennt sich der Anruf BRAND.name, in beiden Zweigen", async () => {
    expect(await firstMessage("")).toBe(`Hallo Alex, hier ist ${BRAND.name}. Ich melde mich kurz: Was beschäftigt dich gerade?`);
    expect(await firstMessage("Umzug planen")).toBe(`Hallo Alex, hier ist ${BRAND.name}. Du wolltest reden: Umzug planen. Wo fangen wir an?`);
  });

  test("mit VOICE_AGENT_NAME=Mia nennt sich der Anruf Mia, in beiden Zweigen", async () => {
    process.env.VOICE_AGENT_NAME = "Mia";
    expect(await firstMessage("")).toBe("Hallo Alex, hier ist Mia. Ich melde mich kurz: Was beschäftigt dich gerade?");
    expect(await firstMessage("Umzug planen")).toBe("Hallo Alex, hier ist Mia. Du wolltest reden: Umzug planen. Wo fangen wir an?");
  });

  test("callGreeting nimmt einen ausdrücklich übergebenen Namen", () => {
    expect(callGreeting("Alex", "", "Mia")).toContain("hier ist Mia.");
  });
});

describe("Sprach-Brücke", () => {
  const baseEnv: BridgeEnv = { VOICE_ANTHROPIC_API_KEY: "sk-test", VOICE_BRIDGE_TOKEN: "secret-token" };

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
