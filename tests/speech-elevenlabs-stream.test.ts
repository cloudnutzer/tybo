/**
 * ElevenLabs gestreamt für den Telefonhörer (Issue #276, Checkbox 1):
 * Stücke vor dem Ende der Synthese, Bytepaare über Stückgrenzen, Abbruch
 * beendet die Anfrage, Fehlerarten. Nur eine Fetch-Attrappe, kein Netz.
 */

import { describe, expect, test } from "bun:test";
import {
  ELEVENLABS_DEFAULT_MODEL,
  ELEVENLABS_STREAM_RATE,
  elevenLabsVoiceName,
  streamElevenLabs,
} from "../src/lib/speech/elevenlabs";
import { createTtsProviders, type ProviderDeps } from "../src/lib/speech/providers";
import { SpeechError } from "../src/lib/speech/types";

/** Strom, den der Test Stück für Stück füttert */
function feed() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    body,
    push: (bytes: number[]) => ctrl.enqueue(new Uint8Array(bytes)),
    end: () => ctrl.close(),
    fail: () => ctrl.error(new Error("abgerissen")),
    cancelled: () => cancelled,
  };
}

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function fakeFetch(respond: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fn = async (url: string, init: RequestInit = {}) => {
    const call = { url, init, body: init.body ? JSON.parse(String(init.body)) : {} };
    calls.push(call);
    return respond(call);
  };
  return { fn, calls };
}

const KEY = "KEY-MARKER-EL";

async function next<T>(it: AsyncIterator<T>): Promise<IteratorResult<T>> {
  return it.next();
}

describe("streamElevenLabs", () => {
  test("Stücke kommen an, bevor die Synthese fertig ist; Anfrage wie dokumentiert", async () => {
    const f = feed();
    const { fn, calls } = fakeFetch(() => new Response(f.body, { status: 200 }));
    const it = streamElevenLabs(fn, "Hallo Welt.", { key: KEY, voice: "voiceA", language: "de" })[Symbol.asyncIterator]();
    const first = next(it);
    f.push([1, 2, 3, 4]);
    const got = await first;
    expect(got.done).toBe(false);
    expect([...(got.value as Uint8Array)]).toEqual([1, 2, 3, 4]);
    // Die Synthese läuft noch: der Strom ist nicht zu
    const second = next(it);
    f.push([5, 6]);
    expect([...((await second).value as Uint8Array)]).toEqual([5, 6]);
    f.end();
    expect((await next(it)).done).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voiceA/stream?output_format=pcm_24000");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["xi-api-key"]).toBe(KEY);
    expect(calls[0]!.body).toEqual({ text: "Hallo Welt.", model_id: ELEVENLABS_DEFAULT_MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1 }, language_code: "de" });
    expect(ELEVENLABS_DEFAULT_MODEL).toBe("eleven_v3_conversational");
  });

  test("Bytepaare bleiben über Stückgrenzen erhalten, ein Rest-Byte am Ende fällt weg", async () => {
    const f = feed();
    const { fn } = fakeFetch(() => new Response(f.body));
    const out: number[][] = [];
    const run = (async () => {
      for await (const c of streamElevenLabs(fn, "Satz.", { key: KEY, voice: "v" })) out.push([...c]);
    })();
    f.push([1, 2, 3]);
    f.push([4]);
    f.push([5]);
    f.push([6, 7, 8, 9]);
    f.end();
    await run;
    for (const c of out) expect(c.length % 2).toBe(0);
    expect(out.flat()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("Multilingual v2 bekommt keinen language_code", async () => {
    const f = feed();
    const { fn, calls } = fakeFetch(() => new Response(f.body));
    const run = (async () => {
      for await (const _ of streamElevenLabs(fn, "Satz.", { key: KEY, voice: "v", model: "eleven_multilingual_v2", language: "de" })) void _;
    })();
    f.push([1, 2]);
    f.end();
    await run;
    expect(calls[0]!.body).toEqual({ text: "Satz.", model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1 } });
  });

  test("Abbruch über signal beendet die Anfrage sofort, danach kein Stück mehr", async () => {
    const f = feed();
    const { fn, calls } = fakeFetch(() => new Response(f.body));
    const ctrl = new AbortController();
    const it = streamElevenLabs(fn, "Satz.", { key: KEY, voice: "v", signal: ctrl.signal })[Symbol.asyncIterator]();
    const first = next(it);
    f.push([1, 2]);
    await first;
    const pending = next(it);
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ kind: "timeout" });
    expect((calls[0]!.init.signal as AbortSignal).aborted).toBe(true);
    expect(f.cancelled()).toBe(true);
  });

  test("return() des Verbrauchers bricht die Anfrage ab", async () => {
    const f = feed();
    const { fn, calls } = fakeFetch(() => new Response(f.body));
    f.push([1, 2]);
    for await (const _ of streamElevenLabs(fn, "Satz.", { key: KEY, voice: "v" })) {
      void _;
      break;
    }
    expect(f.cancelled()).toBe(true);
    expect((calls[0]!.init.signal as AbortSignal).aborted).toBe(true);
  }, 2000);

  test("Abbruch vor der Antwort: fetch bekommt das Signal", async () => {
    const ctrl = new AbortController();
    let seen: AbortSignal | undefined;
    const fn = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        seen = init?.signal ?? undefined;
        seen?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const p = (async () => {
      for await (const _ of streamElevenLabs(fn, "Satz.", { key: KEY, voice: "v", signal: ctrl.signal })) void _;
    })();
    await Bun.sleep(5);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ kind: "timeout" });
    expect(seen?.aborted).toBe(true);
  });

  for (const status of [401, 429, 402, 500]) {
    test(`HTTP ${status} wirft SpeechError http ohne Inhalt`, async () => {
      const { fn } = fakeFetch(() => new Response(`{"detail":"ANTWORT-MARKER ${KEY}"}`, { status }));
      const p = (async () => {
        for await (const _ of streamElevenLabs(fn, "Satz.", { key: KEY, voice: "v" })) void _;
      })();
      const err = await p.catch(e => e);
      expect(err).toBeInstanceOf(SpeechError);
      expect(err.kind).toBe("http");
      expect(err.code).toBe(status);
      expect(String(err.message)).not.toContain("ANTWORT-MARKER");
      expect(String(err.message)).not.toContain(KEY);
    });
  }

  test("Netzfehler beim Verbinden und Abriss mitten im Strom: network", async () => {
    const down = fakeFetch(() => Promise.reject(new TypeError(`fetch failed ${KEY}`)));
    const e1 = await (async () => {
      for await (const _ of streamElevenLabs(down.fn, "Satz.", { key: KEY, voice: "v" })) void _;
    })().catch(e => e);
    expect(e1).toMatchObject({ kind: "network" });
    expect(String(e1.message)).not.toContain(KEY);

    const f = feed();
    const torn = fakeFetch(() => new Response(f.body));
    const got: number[] = [];
    const p = (async () => {
      for await (const c of streamElevenLabs(torn.fn, "Satz.", { key: KEY, voice: "v" })) got.push(...c);
    })();
    f.push([1, 2]);
    await Bun.sleep(1);
    f.fail();
    expect(await p.catch(e => e)).toMatchObject({ kind: "network" });
    expect(got).toEqual([1, 2]);
  });

  test("leerer Strom: empty; Stillstand: timeout (erstes Stück und zwischen Stücken)", async () => {
    const f = feed();
    const empty = fakeFetch(() => new Response(f.body));
    const p = (async () => {
      for await (const _ of streamElevenLabs(empty.fn, "Satz.", { key: KEY, voice: "v" })) void _;
    })();
    f.end();
    expect(await p.catch(e => e)).toMatchObject({ kind: "empty" });

    const silent = feed();
    const s1 = fakeFetch(() => new Response(silent.body));
    const p1 = (async () => {
      for await (const _ of streamElevenLabs(s1.fn, "Satz.", { key: KEY, voice: "v", firstByteTimeoutMs: 20 })) void _;
    })();
    expect(await p1.catch(e => e)).toMatchObject({ kind: "timeout" });
    expect(silent.cancelled()).toBe(true);

    const stall = feed();
    const s2 = fakeFetch(() => new Response(stall.body));
    const got: number[] = [];
    const p2 = (async () => {
      for await (const c of streamElevenLabs(s2.fn, "Satz.", { key: KEY, voice: "v", idleTimeoutMs: 20 })) got.push(...c);
    })();
    stall.push([1, 2]);
    expect(await p2.catch(e => e)).toMatchObject({ kind: "timeout" });
    expect(got).toEqual([1, 2]);
  });

  test("ohne Schlüssel, mit ungültiger Stimme oder unbekanntem Modell: kein Aufruf", async () => {
    const { fn, calls } = fakeFetch(() => new Response(new Uint8Array([1, 2])));
    for (const o of [{ key: "", voice: "v" }, { key: KEY, voice: "-x" }, { key: KEY, voice: "v/../x" }, { key: KEY, voice: "v", model: "eleven_v9" }]) {
      const e = await (async () => {
        for await (const _ of streamElevenLabs(fn, "Satz.", o)) void _;
      })().catch(e => e);
      expect(e).toMatchObject({ kind: "unavailable" });
    }
    expect(calls).toHaveLength(0);
  });
});

describe("Anbieter elevenlabs (providers.ts)", () => {
  function deps(env: Record<string, string | undefined>, fetchFn: ProviderDeps["fetch"]): ProviderDeps {
    return {
      env: () => env,
      run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
      fetch: fetchFn,
      exists: () => false,
      which: () => null,
      readFile: async () => Buffer.alloc(0),
      writeFile: async () => {},
      unlink: async () => {},
      mkdir: async () => {},
      cwd: () => "/nirgends",
      tmpDir: "/tmp",
      unique: () => "u",
    };
  }

  test("streamAvailable braucht nur den Schlüssel, available weiter auch ELEVENLABS_VOICE_ID", () => {
    const p = createTtsProviders(deps({ ELEVENLABS_API_KEY: KEY }, async () => new Response("")) ).find(x => x.id === "elevenlabs")!;
    expect(p.streamAvailable!()).toEqual({ ok: true });
    expect(p.available().ok).toBe(false);
    expect(p.streamSampleRate).toBe(ELEVENLABS_STREAM_RATE);
    const none = createTtsProviders(deps({}, async () => new Response(""))).find(x => x.id === "elevenlabs")!;
    expect(none.streamAvailable!()).toEqual({ ok: false, reason: "ELEVENLABS_API_KEY fehlt" });
  });

  test("synthesizeStream nimmt Stimme und Modell je Aufruf; warm holt den Namen der Stimme", async () => {
    const { fn, calls } = fakeFetch(call =>
      call.url.includes("/v1/voices/") ? Response.json({ name: "Testa", voice_id: "voiceB" }) : new Response(new Uint8Array([9, 8, 7, 6])),
    );
    const p = createTtsProviders(deps({ ELEVENLABS_API_KEY: KEY, ELEVENLABS_VOICE_ID: "envvoice" }, fn)).find(x => x.id === "elevenlabs")!;
    const out: number[] = [];
    for await (const c of p.synthesizeStream!("Satz.", { voice: "voiceB", model: "eleven_turbo_v2_5" })) out.push(...c);
    expect(out).toEqual([9, 8, 7, 6]);
    expect(calls[0]!.url).toContain("/v1/text-to-speech/voiceB/stream");
    expect(calls[0]!.body.model_id).toBe("eleven_turbo_v2_5");
    expect(p.voiceName!("voiceB")).toBeNull();
    await p.warm!({ voice: "voiceB" });
    expect(calls[1]!.url).toBe("https://api.elevenlabs.io/v1/voices/voiceB");
    expect(p.voiceName!("voiceB")).toBe("Testa");
  });

  test("elevenLabsVoiceName: Fehler ergeben null", async () => {
    expect(await elevenLabsVoiceName(async () => new Response("", { status: 401 }), KEY, "v")).toBeNull();
    expect(await elevenLabsVoiceName(async () => Promise.reject(new Error("x")), KEY, "v")).toBeNull();
    expect(await elevenLabsVoiceName(async () => Response.json({}), KEY, "v")).toBeNull();
    expect(await elevenLabsVoiceName(async () => Response.json({ name: "A" }), "", "v")).toBeNull();
  });
});
