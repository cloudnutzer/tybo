/**
 * Issue #256: Weg "openai-compat" (OpenRouter, Ollama). Nur Fetch-Attrappen,
 * kein Aufruf bei OpenRouter oder Ollama.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  createOpenAICompatBackend,
  effectiveOllamaContext,
  loadedOllamaContext,
  OLLAMA_CHAT_URL,
  OLLAMA_GENERATE_URL,
  OLLAMA_PS_URL,
  OLLAMA_SHOW_URL,
  OPENROUTER_CHAT_URL,
  ThinkFilter,
} from "../src/lib/voice-brain/backends/openai-compat";
import { runVoiceTurn, type VoiceTurnEvent } from "../src/lib/voice-brain/turn";
import { withFailureLimit } from "../src/lib/voice-brain/call-model";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const enc = new TextEncoder();
const chunk = (delta: Record<string, unknown>) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;

interface Req {
  url: string;
  body: any;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Fetch-Attrappe: antwortet je Aufruf mit dem nächsten Eintrag. Ein Eintrag
 * ist ein Status mit Text, ein JSON-Objekt (/api/show) oder ein Strom aus
 * Byte-Stücken (auch mitten in UTF-8-Zeichen und Zeilen geteilt).
 */
type Reply = { status: number; text?: string } | { json: unknown } | { chunks: (string | Uint8Array)[]; hold?: boolean };

function fakeFetch(replies: Reply[]) {
  const requests: Req[] = [];
  const streams: { cancelled: boolean }[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    requests.push({ url: String(input), body: init?.body ? JSON.parse(init.body) : undefined, headers, signal: init?.signal });
    const reply = replies.shift();
    if (!reply) throw new Error("kein Eintrag mehr");
    if ("status" in reply) return new Response(reply.text ?? "", { status: reply.status });
    if ("json" in reply) return Response.json(reply.json);
    const state = { cancelled: false };
    streams.push(state);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const piece of reply.chunks) c.enqueue(typeof piece === "string" ? enc.encode(piece) : piece);
        if (!reply.hold) c.close();
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { requests, streams };
}

async function collect(gen: AsyncGenerator<VoiceTurnEvent>) {
  const events: VoiceTurnEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}
const segments = (events: VoiceTurnEvent[]) => events.filter((e) => e.type === "segment").map((e) => (e as { text: string }).text);
const last = (events: VoiceTurnEvent[]) => events[events.length - 1];
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const openrouter = (extra: Record<string, unknown> = {}) =>
  createOpenAICompatBackend({ kind: "openrouter", model: "anthropic/claude-sonnet-5.5", apiKey: "or-test", ...extra });

describe("OpenRouter", () => {
  test("Anfrage trägt reasoning: { effort: low }, Kopfzeilen und den Verlauf (höchstens 12 Äußerungen)", async () => {
    const f = fakeFetch([{ chunks: [chunk({ content: "Hallo Mia, " }), chunk({ content: "schön dich zu hören." }), "data: [DONE]\n\n"] }]);
    const history = Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `Satz ${i}` }));
    const events = await collect(runVoiceTurn({ backend: openrouter(), system: "S", history, userText: "Wie geht's?" }));
    expect(segments(events).join(" ")).toBe("Hallo Mia, schön dich zu hören.");
    expect(f.requests[0].url).toBe(OPENROUTER_CHAT_URL);
    expect(f.requests[0].body.reasoning).toEqual({ effort: "low" });
    expect(f.requests[0].body.stream).toBe(true);
    expect(f.requests[0].headers.authorization).toBe("Bearer or-test");
    const msgs = f.requests[0].body.messages;
    expect(msgs[0]).toEqual({ role: "system", content: "S" });
    expect(msgs.length).toBe(1 + 13);
    expect(msgs[1].content).toBe("Satz 8");
    expect(msgs[msgs.length - 1]).toEqual({ role: "user", content: "Wie geht's?" });
  });

  test("400 auf reasoning: einmal ohne den Zusatz, für das Gespräch gemerkt; Budget je Abruf genau einmal", async () => {
    const f = fakeFetch([
      { status: 400, text: "reasoning not supported" },
      { chunks: [chunk({ content: "Gut." }), "data: [DONE]\n\n"] },
      { chunks: [chunk({ content: "Auch gut." }), "data: [DONE]\n\n"] },
    ]);
    const log = { reserved: 0, settled: 0 };
    const backend = openrouter({ reserveRequest: () => (log.reserved++, () => void log.settled++) });
    const first = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Und?" }));
    expect(segments(first)).toEqual(["Gut."]);
    const second = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Noch was?" }));
    expect(segments(second)).toEqual(["Auch gut."]);
    expect(f.requests.map((r) => r.body.reasoning)).toEqual([{ effort: "low" }, undefined, undefined]);
    expect(log).toEqual({ reserved: 3, settled: 3 });
  });

  test("zweites 400 ohne reasoning: Fehler, keine weitere Wiederholung", async () => {
    const f = fakeFetch([{ status: 400, text: "a" }, { status: 400, text: "b" }]);
    const events = await collect(runVoiceTurn({ backend: openrouter(), system: "S", history: [], userText: "Und?" }));
    expect(last(events)).toMatchObject({ type: "error", reason: "api" });
    expect(f.requests).toHaveLength(2);
  });

  test("delta.reasoning und reasoning_content werden nie zu einem Abschnitt", async () => {
    fakeFetch([
      {
        chunks: [
          chunk({ reasoning: "Der Nutzer fragt nach dem Wetter. Ich sollte kurz antworten." }),
          chunk({ reasoning_content: "Noch ein Gedanke." }),
          chunk({ content: "Morgen wird es sonnig." }),
          chunk({ reasoning: "Fertig." }),
          "data: [DONE]\n\n",
        ],
      },
    ]);
    const events = await collect(runVoiceTurn({ backend: openrouter(), system: "S", history: [], userText: "Wetter?" }));
    expect(segments(events)).toEqual(["Morgen wird es sonnig."]);
    expect((last(events) as { rawText: string }).rawText).toBe("Morgen wird es sonnig.");
  });

  test("SSE über Stückgrenzen: geteilte Zeilen und geteilte UTF-8-Zeichen", async () => {
    const whole = enc.encode(chunk({ content: "Grüße aus Köln. " }) + chunk({ content: "Schön hier." }) + "data: [DONE]\n\n");
    // mitten in "ü" (zwei Bytes) und mitten in einer Zeile teilen
    const at = whole.indexOf(0xc3) + 1;
    fakeFetch([{ chunks: [whole.slice(0, 5), whole.slice(5, at), whole.slice(at, at + 9), whole.slice(at + 9)] }]);
    const events = await collect(runVoiceTurn({ backend: openrouter(), system: "S", history: [], userText: "Hi", earlyFirst: false }));
    expect(segments(events)).toEqual(["Grüße aus Köln.", "Schön hier."]);
  });

  test("Abbruch beendet den Abruf (Signal am fetch, Strom geschlossen)", async () => {
    const f = fakeFetch([{ chunks: [chunk({ content: "Es war einmal " })], hold: true }]);
    const ctrl = new AbortController();
    const pending = collect(runVoiceTurn({ backend: openrouter(), system: "S", history: [], userText: "Erzähl", signal: ctrl.signal }));
    await tick();
    ctrl.abort();
    const events = await pending;
    expect(last(events)).toMatchObject({ type: "done", aborted: true });
    expect(f.requests[0].signal?.aborted).toBe(true);
    expect(f.streams[0].cancelled).toBe(true);
  });

  test("close() nach dem ersten Abschnitt: kein weiterer Abschnitt, Abschluss ended, Abruf beendet", async () => {
    const f = fakeFetch([{ chunks: [chunk({ content: "Rom wurde gegründet. Dann kamen die Könige. Später " })], hold: true }]);
    const backend = withFailureLimit(openrouter());
    const turn = runVoiceTurn({ backend, system: "S", history: [], userText: "Erzähl von Rom", earlyFirst: false });
    expect((await turn.next()).value).toMatchObject({ type: "segment", text: "Rom wurde gegründet." });
    backend.close?.();
    const rest: VoiceTurnEvent[] = [];
    for await (const e of turn) rest.push(e);
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({ type: "error", reason: "ended", spokenText: "Rom wurde gegründet." });
    expect(f.requests[0].signal?.aborted).toBe(true);
    expect(f.streams[0].cancelled).toBe(true);
    const again = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Hallo?" }));
    expect(again[0]).toMatchObject({ type: "error", reason: "ended" });
    expect(f.requests).toHaveLength(1);
  });

  test("Abschluss per finish_reason ohne [DONE] gilt als vollständig", async () => {
    fakeFetch([{ chunks: [chunk({ content: "Gut, " }), `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "danke." }, finish_reason: "stop" }] })}\n\n`] }]);
    const events = await collect(runVoiceTurn({ backend: openrouter(), system: "S", history: [], userText: "Wie geht's?" }));
    expect(segments(events).join(" ")).toBe("Gut, danke.");
    expect(last(events)).toMatchObject({ type: "done", aborted: false });
  });

  test("leerer Strom ohne Abschluss ist ein Fehler, kein leerer Erfolg", async () => {
    fakeFetch([{ chunks: [] }]);
    const log = { reserved: 0, settled: 0 };
    const events = await collect(runVoiceTurn({ backend: openrouter({ reserveRequest: () => (log.reserved++, () => void log.settled++) }), system: "S", history: [], userText: "Hi" }));
    expect(last(events)).toMatchObject({ type: "error", reason: "network" });
    expect((last(events) as { message: string }).message).toContain("vorzeitig");
    expect(log).toEqual({ reserved: 1, settled: 1 });
  });

  test("abgerissener Strom: angefangener Satz wird nicht gesprochen, Turn endet mit Fehler", async () => {
    fakeFetch([{ chunks: [chunk({ content: "Morgen wird es sonnig. " }), chunk({ content: "Am Nachmittag zieht" })] }]);
    const events = await collect(runVoiceTurn({ backend: openrouter(), system: "S", history: [], userText: "Wetter?", earlyFirst: false }));
    expect(segments(events)).toEqual(["Morgen wird es sonnig."]);
    expect(last(events)).toMatchObject({ type: "error", reason: "network", spokenText: "Morgen wird es sonnig." });
  });

  test("zwei abgerissene Ströme hintereinander beenden das Gespräch", async () => {
    const f = fakeFetch([{ chunks: [] }, { chunks: [chunk({ content: "Es war einmal" })] }]);
    const backend = withFailureLimit(openrouter());
    const first = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Erzähl" }));
    expect(last(first)).toMatchObject({ type: "error", reason: "network" });
    const second = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Nochmal" }));
    expect(last(second)).toMatchObject({ type: "error", reason: "ended" });
    expect(segments(second).join(" ")).not.toContain("einmal");
    const third = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Hallo?" }));
    expect(last(third)).toMatchObject({ type: "error", reason: "ended" });
    expect(f.requests).toHaveLength(2);
  });

  test("ohne OPENROUTER_API_KEY: kein Abruf, Grund setup", async () => {
    const f = fakeFetch([]);
    const events = await collect(runVoiceTurn({ backend: openrouter({ apiKey: "" }), system: "S", history: [], userText: "Hi" }));
    expect(last(events)).toMatchObject({ type: "error", reason: "setup" });
    expect(f.requests).toHaveLength(0);
  });
});

describe("<think> ausfiltern", () => {
  test("ThinkFilter: über Stücke verteilte Tags, offenes Tag am Ende", () => {
    const f = new ThinkFilter();
    const out = ["<thi", "nk>geheim", " noch</th", "ink>Hallo ", "Welt <", "b>"].map((c) => f.push(c)).join("") + f.flush();
    expect(out).toBe("Hallo Welt <b>");
    const g = new ThinkFilter();
    expect(g.push("Vorher. <think>nie geschlossen") + g.flush()).toBe("Vorher. ");
  });

  test("Ollama: reasoning_effort none, <think> erscheint in keinem Abschnitt", async () => {
    const f = fakeFetch([
      { json: { parameters: "num_ctx 8192", model_info: { "qwen3.context_length": 40960 } } },
      { chunks: [chunk({ content: "<thi" }), chunk({ content: "nk>Hmm, der Nutzer will" }), chunk({ content: " das Wetter.</think>" }), chunk({ content: "Es wird sonnig." }), "data: [DONE]\n\n"] },
    ]);
    const backend = createOpenAICompatBackend({ kind: "ollama", model: "qwen3:8b" });
    const events = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Wetter?" }));
    expect(segments(events)).toEqual(["Es wird sonnig."]);
    expect(f.requests[0].url).toBe(OLLAMA_SHOW_URL);
    expect(f.requests[0].body).toEqual({ model: "qwen3:8b" });
    expect(f.requests[1].url).toBe(OLLAMA_CHAT_URL);
    expect(f.requests[1].body.reasoning_effort).toBe("none");
    expect(f.requests[1].body.reasoning).toBeUndefined();
    expect(f.requests[1].headers.authorization).toBeUndefined();
  });

  test("Ollama: ungeschlossenes <think> am Ende wird nie gesprochen", async () => {
    fakeFetch([{ json: { parameters: "num_ctx 8192" } }, { chunks: [chunk({ content: "Kurz: ja. <think>und dann" }), chunk({ content: " denke ich weiter" }), "data: [DONE]\n\n"] }]);
    const backend = createOpenAICompatBackend({ kind: "ollama", model: "qwen3:8b" });
    const events = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Ja?" }));
    expect(segments(events).join(" ")).not.toContain("denke");
    expect(segments(events).join(" ")).not.toContain("think");
  });
});

describe("Kontextlänge bei Ollama", () => {
  test("wirksam: num_ctx des Modells, sonst die vom Server geladene Länge, höchstens die Trainingslänge; sonst unbekannt", () => {
    expect(effectiveOllamaContext({ parameters: "temperature 0.6\nnum_ctx 8192", model_info: { "qwen3.context_length": 40960 } }, 16384)).toEqual({ tokens: 8192, from: "num_ctx des Modells" });
    expect(effectiveOllamaContext({ model_info: { "qwen3.context_length": 40960 } }, 16384)).toEqual({ tokens: 16384, from: "vom Ollama-Server geladen" });
    expect(effectiveOllamaContext({ model_info: { "llama.context_length": 2048 } }, 16384)).toEqual({ tokens: 2048, from: "Trainingslänge des Modells" });
    expect(effectiveOllamaContext({}, null)).toBeNull();
    expect(effectiveOllamaContext(null, 4096)).toBeNull();
    const ps = { models: [{ name: "qwen3:8b", model: "qwen3:8b", context_length: 4096 }, { name: "llama3:latest", model: "llama3:latest", context_length: 8192 }] };
    expect(loadedOllamaContext(ps, "qwen3:8b")).toBe(4096);
    expect(loadedOllamaContext(ps, "llama3")).toBe(8192);
    expect(loadedOllamaContext({ models: [{ name: "qwen3:8b" }] }, "qwen3:8b")).toBeNull();
  });

  test("tybos OLLAMA_CONTEXT_LENGTH zählt nicht: Server lädt mit 4096, rund 7000 Token werden abgelehnt", async () => {
    const before = process.env.OLLAMA_CONTEXT_LENGTH;
    process.env.OLLAMA_CONTEXT_LENGTH = "16384";
    try {
      const f = fakeFetch([
        { json: { model_info: { "qwen3.context_length": 40960 } } },
        { json: { model: "qwen3:8b", done: true, done_reason: "load" } },
        { json: { models: [{ name: "qwen3:8b", model: "qwen3:8b", context_length: 4096 }] } },
      ]);
      const backend = createOpenAICompatBackend({ kind: "ollama", model: "qwen3:8b" });
      const events = await collect(runVoiceTurn({ backend, system: "K".repeat(18000), history: [], userText: "Hallo" }));
      expect(last(events)).toMatchObject({ type: "error", reason: "setup" });
      const message = (last(events) as { message: string }).message;
      expect(message).toContain("Kontext zu klein");
      expect(message).toContain("4096");
      expect(message).toContain("vom Ollama-Server geladen");
      expect(f.requests.map((r) => r.url)).toEqual([OLLAMA_SHOW_URL, OLLAMA_GENERATE_URL, OLLAMA_PS_URL]);
      // Geladen ohne eigene Optionen, so wie danach die Chat-Anfrage
      expect(f.requests[1].body).toEqual({ model: "qwen3:8b", stream: false });
    } finally {
      if (before === undefined) delete process.env.OLLAMA_CONTEXT_LENGTH;
      else process.env.OLLAMA_CONTEXT_LENGTH = before;
    }
  });

  test("Server lädt mit 16384: dieselbe Anfrage geht durch", async () => {
    const f = fakeFetch([
      { json: { model_info: { "qwen3.context_length": 40960 } } },
      { json: { done: true } },
      { json: { models: [{ name: "qwen3:8b", model: "qwen3:8b", context_length: 16384 }] } },
      { chunks: [chunk({ content: "Hallo." }), "data: [DONE]\n\n"] },
    ]);
    const backend = createOpenAICompatBackend({ kind: "ollama", model: "qwen3:8b" });
    const events = await collect(runVoiceTurn({ backend, system: "K".repeat(18000), history: [], userText: "Hallo" }));
    expect(segments(events)).toEqual(["Hallo."]);
    expect(f.requests[3].url).toBe(OLLAMA_CHAT_URL);
  });

  test("Server nennt keine Kontextlänge und num_ctx fehlt: verständliche Ablehnung, kein Chat-Abruf", async () => {
    const f = fakeFetch([{ json: { model_info: { "qwen3.context_length": 40960 } } }, { json: { done: true } }, { json: { models: [{ name: "qwen3:8b" }] } }]);
    const backend = createOpenAICompatBackend({ kind: "ollama", model: "qwen3:8b" });
    const events = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Hallo" }));
    expect(last(events)).toMatchObject({ type: "error", reason: "setup" });
    expect((last(events) as { message: string }).message).toContain("nicht feststellbar");
    expect((last(events) as { message: string }).message).toContain("num_ctx");
    expect(f.requests).toHaveLength(3);
  });

  test("zu kleiner Kontext wird als Grund gemeldet, kein Chat-Abruf", async () => {
    const f = fakeFetch([{ json: { parameters: "num_ctx 2048" } }]);
    const backend = createOpenAICompatBackend({ kind: "ollama", model: "qwen3:8b" });
    const events = await collect(runVoiceTurn({ backend, system: "K".repeat(6000), history: [], userText: "Hallo" }));
    expect(last(events)).toMatchObject({ type: "error", reason: "setup" });
    expect((last(events) as { message: string }).message).toContain("Kontext zu klein");
    expect((last(events) as { message: string }).message).toContain("2048");
    expect(f.requests).toHaveLength(1);
  });

  test("Ollama nicht erreichbar oder Modell fehlt: Grund statt stillem Abbruch", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const down = await collect(runVoiceTurn({ backend: createOpenAICompatBackend({ kind: "ollama", model: "qwen3:8b" }), system: "S", history: [], userText: "Hi" }));
    expect(last(down)).toMatchObject({ type: "error", reason: "setup" });
    fakeFetch([{ status: 404, text: "not found" }]);
    const missing = await collect(runVoiceTurn({ backend: createOpenAICompatBackend({ kind: "ollama", model: "gibtsnicht:1b" }), system: "S", history: [], userText: "Hi" }));
    expect((last(missing) as { message: string }).message).toContain("ollama pull gibtsnicht:1b");
  });
});
