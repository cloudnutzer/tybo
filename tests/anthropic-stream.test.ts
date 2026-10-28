/**
 * Gemeinsamer SSE-Teil der Anthropic Messages API (Issue #347) und der
 * Sprachweg darauf (streamAnthropic für Brücke und Telefonhörer). Nur
 * Attrappen, kein Netz.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readMessageStream, sseEvents, usageCost } from "../src/lib/anthropic-stream";
import { streamAnthropic, type AnthropicCall } from "../src/lib/voice-brain/backends/anthropic";
import { sse } from "./api-fixture";

const enc = new TextEncoder();

/** Rumpf aus Bytestücken einer festen Größe */
function body(text: string, size = 5): ReadableStream<Uint8Array> {
  const bytes = enc.encode(text);
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
      c.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const out: { event: string; data: string }[] = [];
  for await (const e of sseEvents(stream)) out.push(e);
  return out;
}

describe("sseEvents", () => {
  test("zerteilte Bytes, auch mitten in Umlauten, ergeben ganze Ereignisse", async () => {
    const text = sse({ type: "content_block_delta", delta: { text: "Grüße aus Köln 😀" } }) + sse({ type: "message_stop" });
    for (const size of [1, 2, 3, 7]) {
      const events = await collect(body(text, size));
      expect(events.map((e) => e.event)).toEqual(["content_block_delta", "message_stop"]);
      expect(JSON.parse(events[0]!.data).delta.text).toBe("Grüße aus Köln 😀");
    }
  });

  test("CRLF zählt wie LF, letztes Ereignis ohne Leerzeile wird gelesen, Kommentare ignoriert", async () => {
    const text = ': ping\r\n\r\nevent: a\r\ndata: {"x":1}\r\n\r\nevent: b\ndata: {"x":2}';
    const events = await collect(body(text));
    expect(events).toEqual([
      { event: "a", data: '{"x":1}' },
      { event: "b", data: '{"x":2}' },
    ]);
  });

  test("CRLF über Stückgrenzen, mehrere data-Zeilen: Name und Daten unabhängig von der Stückelung", async () => {
    const text = 'event: a\r\ndata: {"x":\r\ndata: 1}\r\n\r\nevent: b\r\ndata: zeile1\r\ndata: zeile2\r\n\r\nevent: c\r\ndata: ende\r\n\r\n';
    const expected = [
      { event: "a", data: '{"x":\n1}' },
      { event: "b", data: "zeile1\nzeile2" },
      { event: "c", data: "ende" },
    ];
    for (let size = 1; size <= text.length; size++) {
      expect(await collect(body(text, size))).toEqual(expected);
    }
  });

  test("Ein-Byte-Stücke mit CRLF ergeben dieselben Ereignisse wie ein Stück", async () => {
    const text =
      sse({ type: "message_start", message: { usage: { input_tokens: 3 } } }) +
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Grüße" } }) +
      sse({ type: "message_stop" });
    const crlf = text.replace(/\n/g, "\r\n");
    const whole = await collect(body(crlf, crlf.length));
    expect(whole.map((e) => e.event)).toEqual(["message_start", "content_block_delta", "message_stop"]);
    expect(await collect(body(crlf, 1))).toEqual(whole);
  });

  test("Abbruch beendet ein wartendes Lesen mit AbortError", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const hanging = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(sse({ type: "message_start" })));
      },
      cancel() {
        cancelled = true;
      },
    });
    const seen: string[] = [];
    const reading = (async () => {
      for await (const e of sseEvents(hanging, controller.signal)) seen.push(e.event);
    })();
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toEqual(["message_start"]);
    expect(cancelled).toBe(true);
  });
});

describe("readMessageStream", () => {
  test("Blöcke, Verbrauch, stop_reason und complete", async () => {
    const text =
      sse({ type: "message_start", message: { usage: { input_tokens: 7, output_tokens: 1 } } }) +
      sse({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) +
      sse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } }) +
      sse({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }) +
      sse({ type: "content_block_stop", index: 0 }) +
      sse({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }) +
      sse({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hallo" } }) +
      sse({ type: "content_block_stop", index: 1 }) +
      sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }) +
      sse({ type: "message_stop" });
    const ended: string[] = [];
    const r = await readMessageStream(body(text), { onBlockEnd: (b) => ended.push(b.type) });
    expect(r.blocks).toEqual([
      { type: "thinking", thinking: "hm", signature: "sig" },
      { type: "text", text: "Hallo" },
    ]);
    expect(r.usage).toEqual({ input_tokens: 7, output_tokens: 9 });
    expect(r.stopReason).toBe("end_turn");
    expect(r.complete).toBe(true);
    expect(ended).toEqual(["thinking", "text"]);
  });

  test("Strom ohne message_stop: complete false", async () => {
    const r = await readMessageStream(body(sse({ type: "message_start", message: {} })));
    expect(r.complete).toBe(false);
  });

  test("usageCost: Cache-Tokens mit eigenen Preisen, unbekanntes Modell undefined", () => {
    expect(usageCost("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(14.7, 10);
    expect(usageCost("claude-unbekannt", { input_tokens: 5 })).toBeUndefined();
  });
});

describe("streamAnthropic (Sprachweg) auf dem gemeinsamen Teil", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const call = (extra: Partial<AnthropicCall> = {}): AnthropicCall => ({
    model: "claude-sonnet-5-5",
    system: "S",
    messages: [{ role: "user", content: "Hallo" }],
    effort: "medium",
    max_tokens: 4000,
    ...extra,
  });

  function respond(text: string, status = 200) {
    let sent: any;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return status === 200 ? new Response(body(text, 3), { status }) : new Response(text, { status });
    }) as unknown as typeof fetch;
    return () => sent;
  }

  const TOOLS_REPLY =
    sse({ type: "message_start", message: { usage: { input_tokens: 1000, cache_read_input_tokens: 2000 } } }) +
    sse({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) +
    sse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Überlegung" } }) +
    sse({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG" } }) +
    sse({ type: "content_block_stop", index: 0 }) +
    sse({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } }) +
    sse({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "ohne Signatur" } }) +
    sse({ type: "content_block_stop", index: 1 }) +
    sse({ type: "content_block_start", index: 2, content_block: { type: "redacted_thinking", data: "XYZ" } }) +
    sse({ type: "content_block_stop", index: 2 }) +
    sse({ type: "content_block_start", index: 3, content_block: { type: "text", text: "" } }) +
    sse({ type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "Moment, " } }) +
    sse({ type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "ich schaue." } }) +
    sse({ type: "content_block_stop", index: 3 }) +
    sse({ type: "content_block_start", index: 4, content_block: { type: "tool_use", id: "t-local", name: "history_search" } }) +
    sse({ type: "content_block_delta", index: 4, delta: { type: "input_json_delta", partial_json: '{"query":' } }) +
    sse({ type: "content_block_delta", index: 4, delta: { type: "input_json_delta", partial_json: '"Urlaub"}' } }) +
    sse({ type: "content_block_stop", index: 4 }) +
    sse({ type: "content_block_start", index: 5, content_block: { type: "tool_use", id: "t-deep", name: "deep_think" } }) +
    sse({ type: "content_block_delta", index: 5, delta: { type: "input_json_delta", partial_json: '{"question":"Warum?"}' } }) +
    sse({ type: "content_block_stop", index: 5 }) +
    sse({ type: "content_block_start", index: 6, content_block: { type: "tool_use", id: "t-ext", name: "send_sms" } }) +
    sse({ type: "content_block_delta", index: 6, delta: { type: "input_json_delta", partial_json: "{kaputt" } }) +
    sse({ type: "content_block_stop", index: 6 }) +
    sse({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 100 } }) +
    sse({ type: "message_stop" });

  test("Thinking mit Signatur, redacted, Text, lokale, deep- und externe Werkzeuge wie bisher", async () => {
    const sent = respond(TOOLS_REPLY);
    const texts: string[] = [];
    const starts: [number, string, string][] = [];
    const args: [number, string][] = [];
    const settled: (number | undefined)[] = [];
    const r = await streamAnthropic(
      "sk-test",
      call({ tools: [{ name: "history_search", description: "d", input_schema: {} }] }),
      new Set(["history_search"]),
      { onText: (t) => texts.push(t), onToolStart: (i, id, name) => starts.push([i, id, name]), onToolArgs: (i, j) => args.push([i, j]) },
      () => (usd) => settled.push(usd)
    );
    expect(sent()).toMatchObject({ model: "claude-sonnet-5-5", system: "S", tools: [{ name: "history_search" }], output_config: { effort: "medium" }, stream: true });
    expect(texts.join("")).toBe("Moment, ich schaue.");
    // Nur externe Werkzeuge gehen an die Sinks, gezählt ab 0
    expect(starts).toEqual([[0, "t-ext", "send_sms"]]);
    expect(args).toEqual([[0, "{kaputt"]]);
    expect(r.finish).toBe("tool_calls");
    expect(r.complete).toBe(true);
    expect(r.text).toBe("Moment, ich schaue.");
    expect(r.content).toEqual([
      { type: "thinking", thinking: "Überlegung", signature: "SIG" },
      { type: "redacted_thinking", data: "XYZ" },
      { type: "text", text: "Moment, ich schaue." },
      { type: "tool_use", id: "t-local", name: "history_search", input: { query: "Urlaub" } },
      { type: "tool_use", id: "t-deep", name: "deep_think", input: { question: "Warum?" } },
      { type: "tool_use", id: "t-ext", name: "send_sms", input: {} },
    ]);
    expect(r.localCalls).toEqual([{ id: "t-local", name: "history_search", input: { query: "Urlaub" } }]);
    expect(r.deepCalls).toEqual([{ id: "t-deep", question: "Warum?" }]);
    // Genau eine Abrechnung mit den echten Kosten: 1000*2 + 100*10 + 2000*0.2 = 3400 / 1e6
    expect(settled).toHaveLength(1);
    expect(settled[0]).toBeCloseTo(0.0034, 10);
  });

  test("Abgelehnte Anfrage: BrainError api, Abrechnung genau einmal mit 0", async () => {
    respond('{"error":{"message":"bad"}}', 400);
    const settled: (number | undefined)[] = [];
    await expect(
      streamAnthropic("sk-test", call(), new Set(), { onText() {}, onToolStart() {}, onToolArgs() {} }, () => (usd) => settled.push(usd))
    ).rejects.toMatchObject({ reason: "api" });
    expect(settled).toEqual([0]);
  });

  test("Fehler-Ereignis im Strom: BrainError api, abgerechnet mit dem bisherigen Verbrauch", async () => {
    respond(sse({ type: "message_start", message: { usage: { input_tokens: 1000 } } }) + sse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    const settled: (number | undefined)[] = [];
    await expect(
      streamAnthropic("sk-test", call(), new Set(), { onText() {}, onToolStart() {}, onToolArgs() {} }, () => (usd) => settled.push(usd))
    ).rejects.toMatchObject({ reason: "api" });
    expect(settled).toHaveLength(1);
    expect(settled[0]).toBeCloseTo(0.002, 10);
  });

  test("Vorzeitiges Ende: complete false, ohne usage zählt die Reservierung (undefined)", async () => {
    respond(sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) + sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Halb" } }));
    const settled: (number | undefined)[] = [];
    const r = await streamAnthropic("sk-test", call(), new Set(), { onText() {}, onToolStart() {}, onToolArgs() {} }, () => (usd) => settled.push(usd));
    expect(r.complete).toBe(false);
    expect(r.finish).toBe("stop");
    expect(settled).toEqual([undefined]);
  });

  test("Schon abgebrochen: AbortError, keine Reservierung, kein Abruf", async () => {
    let fetched = false;
    globalThis.fetch = (async () => ((fetched = true), new Response(""))) as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    let reserved = false;
    await expect(
      streamAnthropic("sk-test", call({ signal: controller.signal }), new Set(), { onText() {}, onToolStart() {}, onToolArgs() {} }, () => ((reserved = true), () => {}))
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetched).toBe(false);
    expect(reserved).toBe(false);
  });
});
