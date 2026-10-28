/**
 * Issue #255: Gesprächs-Turn des Telefonhörers mit dem Weg "anthropic".
 * Nur Fetch-Attrappen, kein Aufruf bei Anthropic, keine Brücke als Prozess.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createAnthropicBackend } from "../src/lib/voice-brain/backends/anthropic";
import { runVoiceTurn, type VoiceTurnEvent } from "../src/lib/voice-brain/turn";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const sse = (e: Record<string, unknown>) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
const START = sse({ type: "message_start", message: { id: "msg_1" } }) + sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
const delta = (text: string) => sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const END = sse({ type: "content_block_stop", index: 0 }) + sse({ type: "message_delta", delta: { stop_reason: "end_turn" } }) + sse({ type: "message_stop" });

/** Fetch-Attrappe mit einem Strom, den der Test Stück für Stück füllt */
function controlledFetch() {
  const enc = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  const requests: { url: string; body: any; signal?: AbortSignal }[] = [];
  let closed = false;
  globalThis.fetch = (async (input: any, init?: any) => {
    requests.push({ url: String(input), body: JSON.parse(init.body), signal: init.signal });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return {
    requests,
    send: (s: string) => controller.enqueue(enc.encode(s)),
    close: () => {
      if (!closed) controller.close();
      closed = true;
    },
  };
}

function budget(reject = false) {
  const log = { reserved: 0, settled: 0 };
  const reserveRequest = () => {
    if (reject) throw new Error("Daily API budget reached");
    log.reserved++;
    return () => void log.settled++;
  };
  return { log, reserveRequest };
}

function backend(reserveRequest?: () => () => void) {
  return createAnthropicBackend({ apiKey: "sk-test", model: "claude-sonnet-5-5", effort: "medium", reserveRequest });
}

const base = { system: "Kontext und Sprechstil", history: [{ role: "assistant" as const, content: "Hallo Alex." }], userText: "Wie wird das Wetter?" };

async function collect(gen: AsyncGenerator<VoiceTurnEvent>) {
  const events: VoiceTurnEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

/** Wartet ein paar Runden der Ereignisschleife, damit der Strom gelesen ist */
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("runVoiceTurn mit dem Weg anthropic", () => {
  test("drei Sätze: drei Abschnitte in Reihenfolge, der erste kommt vor dem Ende des Stroms", async () => {
    const f = controlledFetch();
    const turn = runVoiceTurn({ ...base, backend: backend(), earlyFirst: false });
    f.send(START + delta("Morgen wird es in Berlin sonnig. ") + delta("Am Nach"));
    const first = await turn.next();
    expect(first.value).toEqual({ type: "segment", text: "Morgen wird es in Berlin sonnig." });
    // Der Strom ist noch offen: weder Ende noch zweiter Satz gesendet
    f.send(delta("mittag kommen Wolken auf. [REMEMBER: Alex fragt oft nach dem Wetter] Abends regnet es leicht."));
    f.send(END);
    f.close();
    const rest = await collect(turn);
    const segments = [first.value, ...rest].filter((e) => e.type === "segment").map((e) => (e as { text: string }).text);
    expect(segments).toEqual(["Morgen wird es in Berlin sonnig.", "Am Nachmittag kommen Wolken auf.", "Abends regnet es leicht."]);
    for (const s of segments) expect(s).not.toMatch(/\[(REMEMBER|GOAL|DONE|CANCEL|FORGET|INVOKE|ASSET_DESC)/i);
    const last = rest[rest.length - 1];
    expect(last).toEqual({
      type: "done",
      rawText: "Morgen wird es in Berlin sonnig. Am Nachmittag kommen Wolken auf. [REMEMBER: Alex fragt oft nach dem Wetter] Abends regnet es leicht.",
      spokenText: "Morgen wird es in Berlin sonnig. Am Nachmittag kommen Wolken auf. Abends regnet es leicht.",
      aborted: false,
    });
  });

  test("Tag mit innerer Klammer über mehrere Textstücke: kein Abschnitt enthält ein Intent-Tag", async () => {
    const texts = [
      "Gern. [Notiz [REMEMBER: Alex mag [grünen] Tee]] Bis morgen.",
      "Gern. [GOAL: [grünen] Tee kaufen | DEADLINE: Montag] Bis morgen.",
    ];
    for (const text of texts) {
      for (const cut of [8, 20, 30, 35, 45]) {
        const f = controlledFetch();
        f.send(START + delta(text.slice(0, cut)) + delta(text.slice(cut, cut + 6)) + delta(text.slice(cut + 6)) + END);
        f.close();
        const events = await collect(runVoiceTurn({ ...base, backend: backend(), earlyFirst: false }));
        const segments = events.filter((e) => e.type === "segment").map((e) => (e as { text: string }).text);
        for (const s of segments) expect(s).not.toMatch(/\[(REMEMBER|GOAL|DONE|CANCEL|FORGET|INVOKE|ASSET_DESC)/i);
        const last = events[events.length - 1];
        expect(last.type).toBe("done");
        expect((last as { spokenText: string }).spokenText).not.toMatch(/REMEMBER|GOAL|grünen/);
        expect((last as { rawText: string }).rawText).toBe(text);
      }
    }
  });

  test("KNOWLEDGE über mehrere Textstücke: nie vorgelesen, im Rohtext für das Gate erhalten (Issue #317)", async () => {
    const text = "Gern. [KNOWLEDGE: reference | Rahmengröße | Der Rahmen hat 56 cm | Rad] Bis morgen.";
    for (const cut of [8, 14, 30, 50, 70]) {
      const f = controlledFetch();
      f.send(START + delta(text.slice(0, cut)) + delta(text.slice(cut, cut + 6)) + delta(text.slice(cut + 6)) + END);
      f.close();
      const events = await collect(runVoiceTurn({ ...base, backend: backend(), earlyFirst: false }));
      const segments = events.filter((e) => e.type === "segment").map((e) => (e as { text: string }).text);
      expect(segments.join(" ")).toBe("Gern. Bis morgen.");
      const last = events[events.length - 1] as { type: string; rawText: string; spokenText: string };
      expect(last.type).toBe("done");
      expect(last.spokenText).not.toMatch(/KNOWLEDGE|Rahmengröße/);
      expect(last.rawText).toBe(text);
    }
  });

  test("Anfrage-Rumpf: System mit cache_control, Verlauf plus Äußerung, Effort, ohne tools und thinking", async () => {
    const f = controlledFetch();
    f.send(START + delta("Gern, bis bald.") + END);
    f.close();
    await collect(runVoiceTurn({ ...base, backend: backend() }));
    expect(f.requests.length).toBe(1);
    const { url, body } = f.requests[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(body.system).toEqual([{ type: "text", text: "Kontext und Sprechstil", cache_control: { type: "ephemeral" } }]);
    expect(body.messages).toEqual([
      { role: "assistant", content: "Hallo Alex." },
      { role: "user", content: "Wie wird das Wetter?" },
    ]);
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.output_config).toEqual({ effort: "medium" });
    expect(body.stream).toBe(true);
    expect("tools" in body).toBe(false);
    expect("thinking" in body).toBe(false);
  });

  test("Abbruch mitten im Satz: Abruf beendet, aborted: true, kein halber Satz, danach nichts mehr", async () => {
    const f = controlledFetch();
    const b = budget();
    const ctrl = new AbortController();
    const turn = runVoiceTurn({ ...base, backend: backend(b.reserveRequest), signal: ctrl.signal, earlyFirst: false });
    f.send(START + delta("Der erste Satz ist schon fertig. ") + delta("Der zweite Satz bricht hier mitt"));
    const first = await turn.next();
    expect(first.value).toEqual({ type: "segment", text: "Der erste Satz ist schon fertig." });
    const pending = turn.next();
    await tick();
    ctrl.abort();
    const end = await pending;
    expect(end.value).toEqual({ type: "done", rawText: "Der erste Satz ist schon fertig. Der zweite Satz bricht hier mitt", spokenText: "Der erste Satz ist schon fertig.", aborted: true });
    expect(f.requests[0].signal?.aborted).toBe(true);
    // Später eintreffender Text erzeugt keinen Abschnitt mehr
    try {
      f.send(delta("e ab. Und noch ein Satz danach."));
    } catch {}
    expect((await turn.next()).done).toBe(true);
    expect(b.log).toEqual({ reserved: 1, settled: 1 });
  });

  test("Abbruch beim Verbraucher direkt nach einem Abschnitt: kein weiterer Abschnitt", async () => {
    const f = controlledFetch();
    const ctrl = new AbortController();
    const events: VoiceTurnEvent[] = [];
    f.send(START + delta("Der erste Satz ist schon fertig. Der zweite Satz ist auch schon fertig. Und ein dritter Satz."));
    for await (const e of runVoiceTurn({ ...base, backend: backend(), signal: ctrl.signal, earlyFirst: false })) {
      events.push(e);
      if (e.type === "segment") ctrl.abort();
    }
    expect(events.map((e) => e.type)).toEqual(["segment", "done"]);
    expect(events[1]).toMatchObject({ aborted: true, spokenText: "Der erste Satz ist schon fertig." });
    expect(f.requests[0].signal?.aborted).toBe(true);
  });

  test("Abbruch beim letzten Restabschnitt: done mit aborted: true", async () => {
    const f = controlledFetch();
    const ctrl = new AbortController();
    const events: VoiceTurnEvent[] = [];
    f.send(START + delta("Gern geschehen, bis später") + END);
    f.close();
    for await (const e of runVoiceTurn({ ...base, backend: backend(), signal: ctrl.signal })) {
      events.push(e);
      if (e.type === "segment") ctrl.abort();
    }
    expect(events).toEqual([
      { type: "segment", text: "Gern geschehen, bis später" },
      { type: "done", rawText: "Gern geschehen, bis später", spokenText: "Gern geschehen, bis später", aborted: true },
    ]);
  });

  test("schon abgebrochenes Signal: kein Abruf, kein Budget, sofort done mit aborted", async () => {
    const f = controlledFetch();
    const b = budget();
    const ctrl = new AbortController();
    ctrl.abort();
    const events = await collect(runVoiceTurn({ ...base, backend: backend(b.reserveRequest), signal: ctrl.signal }));
    expect(events).toEqual([{ type: "done", rawText: "", spokenText: "", aborted: true }]);
    expect(f.requests.length).toBe(0);
    expect(b.log).toEqual({ reserved: 0, settled: 0 });
  });

  test("Verbraucher hört vorzeitig auf: Abruf wird beendet und genau einmal abgerechnet", async () => {
    const f = controlledFetch();
    const b = budget();
    f.send(START + delta("Der erste Satz ist schon fertig. Und dann kommt noch mehr"));
    for await (const e of runVoiceTurn({ ...base, backend: backend(b.reserveRequest), earlyFirst: false })) {
      expect(e.type).toBe("segment");
      break;
    }
    expect(f.requests[0].signal?.aborted).toBe(true);
    expect(b.log).toEqual({ reserved: 1, settled: 1 });
  });

  test("API-Fehler wird zum error-Ereignis, ohne done danach, Budget einmal abgerechnet", async () => {
    globalThis.fetch = (async () => new Response('{"type":"error","error":{"type":"overloaded_error"}}', { status: 529 })) as unknown as typeof fetch;
    const b = budget();
    const events = await collect(runVoiceTurn({ ...base, backend: backend(b.reserveRequest) }));
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ type: "error", reason: "api", rawText: "", spokenText: "" });
    expect((events[0] as { message: string }).message).toContain("529");
    expect(b.log).toEqual({ reserved: 1, settled: 1 });
  });

  test("Fehler im Strom nach einem Abschnitt: Abschnitt bleibt, dann error", async () => {
    const f = controlledFetch();
    f.send(START + delta("Der erste Satz ist schon fertig. Der zwei") + sse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    f.close();
    const events = await collect(runVoiceTurn({ ...base, backend: backend(), earlyFirst: false }));
    expect(events.map((e) => e.type)).toEqual(["segment", "error"]);
    expect(events[1]).toMatchObject({ reason: "api", spokenText: "Der erste Satz ist schon fertig." });
  });

  test("Netzfehler wird zu error mit reason network", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const b = budget();
    const events = await collect(runVoiceTurn({ ...base, backend: backend(b.reserveRequest) }));
    expect(events).toEqual([{ type: "error", reason: "network", message: "fetch failed", rawText: "", spokenText: "" }]);
    expect(b.log).toEqual({ reserved: 1, settled: 1 });
  });

  test("Tagesbudget erschöpft: keine Anfrage, error mit reason budget", async () => {
    const f = controlledFetch();
    const b = budget(true);
    const events = await collect(runVoiceTurn({ ...base, backend: backend(b.reserveRequest) }));
    expect(events).toEqual([{ type: "error", reason: "budget", message: "Daily API budget reached", rawText: "", spokenText: "" }]);
    expect(f.requests.length).toBe(0);
  });

  test("Erfolg: genau einmal reserviert und abgerechnet; Antwort ohne Satzende kommt beim Abschluss", async () => {
    const f = controlledFetch();
    const b = budget();
    f.send(START + delta("Gern geschehen, bis später") + END);
    f.close();
    const events = await collect(runVoiceTurn({ ...base, backend: backend(b.reserveRequest) }));
    expect(events).toEqual([
      { type: "segment", text: "Gern geschehen, bis später" },
      { type: "done", rawText: "Gern geschehen, bis später", spokenText: "Gern geschehen, bis später", aborted: false },
    ]);
    expect(b.log).toEqual({ reserved: 1, settled: 1 });
  });

  test("Weg anthropic: id und label", () => {
    const b = backend();
    expect(b.id).toBe("anthropic");
    expect(b.label).toContain("claude-sonnet-5-5");
  });
});

describe("Abrechnung mit echten Kosten", () => {
  function settled(model = "claude-sonnet-5-5") {
    const amounts: (number | undefined)[] = [];
    const reserveRequest = () => (actual?: number) => void amounts.push(actual);
    return { amounts, backend: createAnthropicBackend({ apiKey: "sk-test", model, effort: "medium", reserveRequest }) };
  }
  const USAGE_START = sse({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 1000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0, output_tokens: 1 } } });
  const USAGE_END = sse({ type: "content_block_stop", index: 0 }) + sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 200 } }) + sse({ type: "message_stop" });
  const respond = (s: string) => {
    globalThis.fetch = (async () => new Response(s, { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
  };

  test("Sonnet 5.5: Kosten aus usage statt der Reservierung", async () => {
    respond(USAGE_START + sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) + delta("Gut, danke.") + USAGE_END);
    const s = settled();
    await collect(runVoiceTurn({ ...base, backend: s.backend }));
    // 1000*2 + 10000*0,2 + 200*10 = 6000 Mikro-USD
    expect(s.amounts.length).toBe(1);
    expect(s.amounts[0]).toBeCloseTo(0.006, 9);
  });

  test("abgelehnte Anfrage kostet nichts", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 529 })) as unknown as typeof fetch;
    const s = settled();
    await collect(runVoiceTurn({ ...base, backend: s.backend }));
    expect(s.amounts).toEqual([0]);
  });

  test("unbekanntes Modell: Reservierung zählt", async () => {
    respond(USAGE_START + sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) + delta("Gut.") + USAGE_END);
    const s = settled("claude-unbekannt");
    await collect(runVoiceTurn({ ...base, backend: s.backend }));
    expect(s.amounts).toEqual([undefined]);
  });
});
