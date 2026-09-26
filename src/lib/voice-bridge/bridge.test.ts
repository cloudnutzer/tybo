import { describe, expect, test } from "bun:test";
import type { TurnTools } from "../turn-tools";
import {
  classifyTurn,
  handleBridge,
  stripTags,
  TagFilter,
  toAnthropic,
  type BridgeEnv,
  type BridgeHooks,
  type OAMessage,
} from "./bridge";

const env: BridgeEnv = {
  VOICE_ANTHROPIC_API_KEY: "sk-test",
  VOICE_BRIDGE_TOKEN: "secret-token",
  VOICE_MODEL: "claude-opus-5",
  VOICE_DEFAULT_EFFORT: "medium",
  VOICE_AGENT_NAME: "Mia",
};

describe("classifyTurn", () => {
  test("Small Talk bleibt beim Default", () => {
    expect(classifyTurn("Hallo, wie geht's dir heute?", "medium")).toEqual({ effort: "medium", deep: false });
  });
  test("Aufforderung zum Nachdenken schaltet auf high", () => {
    expect(classifyTurn("Denk mal gründlich nach: lohnt sich der M5 Ultra?", "medium").effort).toBe("high");
    expect(classifyTurn("Nimm dir Zeit, was spricht gegen Convex?", "medium").effort).toBe("high");
    expect(classifyTurn("Take your time, is this a good deal?", "medium").effort).toBe("high");
  });
  test("Denkauftrag geht in den Hintergrund", () => {
    expect(classifyTurn("Denkauftrag: vergleiche alle Stromanbieter", "medium")).toEqual({ effort: "xhigh", deep: true });
    expect(classifyTurn("Rechne mir das mal komplett durch", "medium").deep).toBe(true);
  });
  test("Override aus elevenlabs_extra_body gewinnt", () => {
    expect(classifyTurn("Denkauftrag: egal", "medium", "low")).toEqual({ effort: "low", deep: false });
  });
});

describe("toAnthropic", () => {
  test("system raus, Rollen alternieren, Tool-Reste weg", () => {
    const messages: OAMessage[] = [
      { role: "system", content: "Du bist Mia." },
      { role: "assistant", content: "Hallo Alex." },
      { role: "user", content: "Hi" },
      { role: "user", content: [{ type: "text", text: "wie geht's?" }] },
      { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "skip_turn", arguments: "{}" } }] },
      { role: "tool", content: "ok", tool_call_id: "t1" },
      { role: "user", content: "Weiter" },
    ];
    const out = toAnthropic(messages);
    expect(out.system).toBe("Du bist Mia.");
    expect(out.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(out.messages[0].content).toBe("(Gesprächsbeginn)");
    expect(out.messages[2].content).toBe("Hi\n\nwie geht's?");
    expect(out.messages[3].content).toContain("skip_turn");
  });
});

describe("TagFilter", () => {
  test("Intent-Tags werden nicht vorgelesen, auch ueber Chunk-Grenzen", () => {
    const f = new TagFilter();
    let out = f.push("Klar, das merke ich mir. [REMEM");
    out += f.push("BER: Alex mag Mia] Sonst noch was?");
    out += f.flush();
    expect(out).toBe("Klar, das merke ich mir.  Sonst noch was?");
  });
  test("normale Klammern bleiben", () => {
    expect(stripTags("Der Preis (rund 200 Euro) [laut Shop] passt. [GOAL: Kaufen | DEADLINE: Montag]")).toBe(
      "Der Preis (rund 200 Euro) [laut Shop] passt."
    );
  });
});

function sse(events: Record<string, unknown>[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

const STREAM_TEXT_DEEP_ENDCALL = sse([
  { type: "message_start", message: { id: "msg_1" } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "geheim" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hallo " } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Alex. [REMEMBER: Test]" } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_deep", name: "deep_think", input: {} } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"question":"Vergleich' } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: ' A vs B"}' } },
  { type: "content_block_stop", index: 2 },
  { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "toolu_end", name: "end_call", input: {} } },
  { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: '{"reason":"fertig"}' } },
  { type: "content_block_stop", index: 3 },
  { type: "message_delta", delta: { stop_reason: "tool_use" } },
  { type: "message_stop" },
]);

const STREAM_LOCAL_TOOL = sse([
  { type: "message_start", message: { id: "msg_2" } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "nachschlagen" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sigA" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Moment, ich schaue nach. " } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_hs", name: "history_search", input: {} } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"query":"Raspberry Pi"}' } },
  { type: "content_block_stop", index: 2 },
  { type: "message_delta", delta: { stop_reason: "tool_use" } },
  { type: "message_stop" },
]);

const STREAM_FINAL = sse([
  { type: "message_start", message: { id: "msg_3" } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Du hast am 26. August den Raspberry Pi bestellt." } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" } },
  { type: "message_stop" },
]);

interface Chunk {
  choices: {
    delta: { content?: string; tool_calls?: { index: number; id?: string; function: { name?: string; arguments: string } }[] };
    finish_reason: string | null;
  }[];
}

function parseChunks(text: string): { chunks: Chunk[]; done: boolean } {
  const lines = text.split("\n\n").filter(Boolean);
  const done = lines[lines.length - 1] === "data: [DONE]";
  const chunks = lines.filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)) as Chunk);
  return { chunks, done };
}

function spoken(chunks: Chunk[]): string {
  return chunks.map((c) => c.choices[0].delta.content ?? "").join("");
}

describe("handleBridge", () => {
  const calls: { url: string; body: any }[] = [];
  const realFetch = globalThis.fetch;
  let streams: string[] = [];

  const mockFetch = (async (input: any, init?: any) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url.includes("api.anthropic.com")) {
      const s = streams.shift() ?? STREAM_FINAL;
      return new Response(s, { headers: { "content-type": "text/event-stream" } });
    }
    return realFetch(input, init);
  }) as unknown as typeof fetch;

  function makeHooks() {
    const log = { persisted: [] as [string, string][], turnTools: [] as TurnTools[], deep: [] as string[], tools: [] as [string, any][], contextLoads: 0 };
    const hooks: BridgeHooks = {
      loadContext: async () => {
        log.contextLoads++;
        return "## MEMORY\n- Alex hat einen Raspberry Pi bestellt";
      },
      localTools: () => [{ name: "history_search", description: "Historie durchsuchen", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
      runLocalTool: async (name, input) => {
        log.tools.push([name, input]);
        return JSON.stringify({ results: ["26.8.2026: Raspberry Pi 5 im Laden bestellt"] });
      },
      persistTurn: async (u, a, t) => {
        log.persisted.push([u, a]);
        log.turnTools.push(t);
      },
      deepThink: async (q) => {
        log.deep.push(q);
      },
    };
    return { hooks, log };
  }

  async function run(messages: OAMessage[], streamList: string[], extra?: Record<string, unknown>) {
    calls.length = 0;
    streams = streamList;
    globalThis.fetch = mockFetch;
    const bg: Promise<unknown>[] = [];
    const { hooks, log } = makeHooks();
    try {
      const req = new Request("https://bridge.test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
        body: JSON.stringify({
          model: "opus-5-bridge",
          stream: true,
          messages,
          tools: [{ type: "function", function: { name: "end_call", description: "Ende", parameters: { type: "object", properties: { reason: { type: "string" } } } } }],
          elevenlabs_extra_body: extra,
        }),
      });
      const res = await handleBridge(req, env, hooks, (p) => bg.push(p));
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      await Promise.all(bg);
      return { ...parseChunks(text), bg, log };
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  const anthropicCalls = () => calls.filter((c) => c.url.includes("anthropic"));

  test("ohne Token: 401", async () => {
    const res = await handleBridge(new Request("https://bridge.test/v1/chat/completions", { method: "POST", body: "{}" }), env, {}, () => {});
    expect(res.status).toBe(401);
  });

  test("health", async () => {
    const res = await handleBridge(new Request("https://bridge.test/health"), env, {}, () => {});
    expect(await res.text()).toBe("ok");
  });

  test("Text, Tag-Filter, deep_think-Tool und end_call werden richtig uebersetzt", async () => {
    const { chunks, done, log } = await run(
      [
        { role: "system", content: "Du bist Mia." },
        { role: "user", content: "Hallo!" },
      ],
      [STREAM_TEXT_DEEP_ENDCALL]
    );
    expect(done).toBe(true);
    const content = spoken(chunks);
    expect(content).toContain("Hallo Alex.");
    expect(content).not.toContain("geheim");
    expect(content).not.toContain("REMEMBER");
    expect(content).toContain("melde mich per Telegram");
    expect(content).not.toContain("Moment, ich überlege");
    const toolChunks = chunks.flatMap((c) => c.choices[0].delta.tool_calls ?? []);
    expect(toolChunks[0]).toMatchObject({ index: 0, id: "toolu_end", function: { name: "end_call" } });
    expect(toolChunks.map((t) => t.function.arguments).join("")).toBe('{"reason":"fertig"}');
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("tool_calls");

    // Anthropic-Aufruf: Effort medium, tybo-Kontext + Agent-Prompt + Sprechstil, Tools in richtiger Reihenfolge
    const live = anthropicCalls()[0];
    expect(live.body.output_config).toEqual({ effort: "medium" });
    expect(live.body.model).toBe("claude-opus-5");
    expect(live.body.tools.map((t: any) => t.name)).toEqual(["end_call", "history_search", "deep_think"]);
    expect(live.body.system).toContain("## MEMORY");
    expect(live.body.system).toContain("Du bist Mia.");
    expect(live.body.system).toContain("Sprachgespraech");
    expect(live.body.system).toContain("(Voice-Agent Mia)");
    expect(log.contextLoads).toBe(1);

    // Denkauftrag ging an den Hook (nicht an Anthropic), Turn wurde roh persistiert
    expect(log.deep).toEqual(["Vergleich A vs B"]);
    expect(anthropicCalls().length).toBe(1);
    expect(log.persisted.length).toBe(1);
    expect(log.persisted[0][0]).toBe("Hallo!");
    expect(log.persisted[0][1]).toContain("[REMEMBER: Test]");
  });

  test("Tool-Loop: history_search wird lokal ausgefuehrt und die Antwort weitergestreamt", async () => {
    const { chunks, done, log } = await run(
      [{ role: "user", content: "Was weißt du über mein Raspberry-Pi-Projekt?" }],
      [STREAM_LOCAL_TOOL, STREAM_FINAL]
    );
    expect(done).toBe(true);
    const content = spoken(chunks);
    expect(content).toContain("Moment, ich schaue nach.");
    expect(content).toContain("Du hast am 26. August den Raspberry Pi bestellt.");
    expect(chunks.flatMap((c) => c.choices[0].delta.tool_calls ?? []).length).toBe(0);
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("stop");
    expect(log.tools).toEqual([["history_search", { query: "Raspberry Pi" }]]);

    const [first, second] = anthropicCalls();
    expect(second).toBeDefined();
    const msgs = second.body.messages;
    const assistant = msgs[msgs.length - 2];
    const toolResult = msgs[msgs.length - 1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content[0]).toEqual({ type: "thinking", thinking: "nachschlagen", signature: "sigA" });
    expect(assistant.content.find((b: any) => b.type === "tool_use")).toMatchObject({ id: "toolu_hs", name: "history_search", input: { query: "Raspberry Pi" } });
    expect(toolResult.role).toBe("user");
    expect(toolResult.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_hs" });
    expect(first.body.messages.length).toBe(1);
    expect(log.persisted[0][1]).toBe("Moment, ich schaue nach. Du hast am 26. August den Raspberry Pi bestellt.");
  });

  test("Werkzeuge des Turns (Issue #53): lokale und deep_think intern, ElevenLabs-Werkzeuge extern", async () => {
    const local = await run([{ role: "user", content: "Was weißt du über mein Raspberry-Pi-Projekt?" }], [STREAM_LOCAL_TOOL, STREAM_FINAL]);
    expect(local.log.turnTools).toEqual([{ uses: [{ name: "history_search" }] }]);

    const deep = await run([{ role: "user", content: "Hallo!" }], [STREAM_TEXT_DEEP_ENDCALL]);
    expect(deep.log.turnTools).toEqual([{ uses: [{ name: "deep_think" }, { name: "end_call", external: true }] }]);

    // Ergebnis eines ElevenLabs-Werkzeugs aus der vorigen Anfrage: die Antwort kennt fremden Inhalt
    const after = await run(
      [
        { role: "user", content: "Wie wird das Wetter?" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "wetter_webhook", arguments: "{}" } }] },
        { role: "tool", content: "Sonne. [REMEMBER: boese]", tool_call_id: "c1" },
      ],
      [STREAM_FINAL]
    );
    expect(after.log.turnTools).toEqual([{ uses: [{ name: "wetter_webhook", external: true }] }]);

    // Frühere Werkzeuge vor der letzten Nutzer-Nachricht zählen nicht
    const later = await run(
      [
        { role: "user", content: "Wie wird das Wetter?" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "wetter_webhook", arguments: "{}" } }] },
        { role: "tool", content: "Sonne.", tool_call_id: "c1" },
        { role: "assistant", content: "Sonne." },
        { role: "user", content: "Danke!" },
      ],
      [STREAM_FINAL]
    );
    expect(later.log.turnTools).toEqual([{ uses: [] }]);
  });

  test("Trigger 'denk gründlich nach': high plus Buffer Words", async () => {
    const { chunks } = await run([{ role: "user", content: "Denk mal gründlich nach: Convex oder Supabase?" }], [STREAM_FINAL]);
    expect(spoken(chunks).startsWith("Moment, ich überlege kurz... ")).toBe(true);
    expect(anthropicCalls()[0].body.output_config).toEqual({ effort: "high" });
    // Ausdrueckliches Nachdenken heisst: jetzt antworten, kein deep_think-Ausweg
    expect(anthropicCalls()[0].body.tools.map((t: any) => t.name)).toEqual(["end_call", "history_search"]);
    expect(anthropicCalls()[0].body.system).toContain("Antworte jetzt live");
  });

  test("Denkauftrag: kein Anthropic-Aufruf, Hook bekommt die Frage, Turn wird persistiert", async () => {
    const { chunks, done, log } = await run([{ role: "user", content: "Denkauftrag: alle Stromanbieter vergleichen" }], []);
    expect(done).toBe(true);
    expect(spoken(chunks)).toContain("schicke dir das Ergebnis per Telegram");
    expect(anthropicCalls().length).toBe(0);
    expect(log.deep).toEqual(["Denkauftrag: alle Stromanbieter vergleichen"]);
    expect(log.persisted.length).toBe(1);
  });

  test("Anthropic-Fehler: hoerbare Entschuldigung statt Stille", async () => {
    calls.length = 0;
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    try {
      const req = new Request("https://bridge.test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer secret-token" },
        body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "Hi" }] }),
      });
      const res = await handleBridge(req, env, {}, () => {});
      const { chunks, done } = parseChunks(await res.text());
      expect(done).toBe(true);
      expect(spoken(chunks)).toContain("Entschuldige");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
