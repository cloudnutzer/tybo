/**
 * Rückfall der Stimme im Telefonhörer (Issue #276, Checkbox 3): ElevenLabs
 * (echter Anbieter aus providers.ts mit Fetch-Attrappe, kein Aufruf bei
 * ElevenLabs) und Pocket TTS als Attrappe. Fehler je Abschnitt, zwei in
 * Folge, Abbruch, Fehler nach dem ersten Stück, fehlendes und scheiterndes
 * Pocket; dazu die Sitzung (audio_restart, notice, speak_browser, played
 * genau einmal) und der Anschluss in bot-call.ts.
 */

import { describe, expect, test } from "bun:test";
import { createSpeech } from "../src/lib/speech/chain";
import { createTtsProviders, type ProviderDeps } from "../src/lib/speech/providers";
import { SpeechError, type SttProvider, type TtsProvider, type WarmStt } from "../src/lib/speech/types";
import type { Settings } from "../src/lib/settings";
import type { CallModelResolution } from "../src/lib/voice-brain/call-model";
import type { BrainBackend } from "../src/lib/voice-brain/types";
import { createBotCall } from "../src/web/bot-call";
import type { CallTurnEvent } from "../src/web/call";
import type { CallSpeakEvent } from "../src/web/call-protocol";
import { CallSession, PLAYED_GRACE_MS } from "../src/web/call-session";
import { CALL_VOICE_MAX_FAILURES, createCallVoice } from "../src/web/call-voice";
import { fakeClock, fakeLine, fakePort, fakeSocket, flush, pcmFrame } from "./call-fixture";

const KEY = "KEY-MARKER-EL";

type Plan = { status: number } | { network: true } | { chunks: number[][]; failAfter?: boolean; stall?: boolean } | { empty: true };

/** ElevenLabs über die echte Anbieter-Fabrik, fetch beantwortet nach Plan (je Aufruf ein Eintrag, danach ok) */
function elevenWorld(plans: Plan[]) {
  const calls: { url: string; signal?: AbortSignal | null }[] = [];
  let i = 0;
  const fetchFn: ProviderDeps["fetch"] = async (url, init) => {
    calls.push({ url, signal: init?.signal ?? null });
    if (url.includes("/v1/voices/")) return Response.json({ name: "Testa" });
    const plan = plans[i++] ?? { chunks: [[1, 0, 2, 0]] };
    if ("status" in plan) return new Response(`{"detail":"${KEY}"}`, { status: plan.status });
    if ("network" in plan) throw new TypeError("fetch failed");
    if ("empty" in plan) return new Response(new ReadableStream({ start: c => c.close() }));
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        for (const ch of plan.chunks) c.enqueue(new Uint8Array(ch));
        if (plan.stall) return;
        await Bun.sleep(1);
        if (plan.failAfter) c.error(new Error("abgerissen"));
        else c.close();
      },
    });
    return new Response(body);
  };
  const deps: ProviderDeps = {
    env: () => ({ ELEVENLABS_API_KEY: KEY }),
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
  const eleven = createTtsProviders(deps).find(p => p.id === "elevenlabs")!;
  const ttsCalls = () => calls.filter(c => c.url.includes("/text-to-speech/"));
  return { eleven, calls, ttsCalls };
}

function fakePocket(o: { fail?: () => boolean } = {}) {
  const texts: string[] = [];
  const p: TtsProvider = {
    id: "pocket",
    label: "Pocket TTS (Kyutai)",
    local: true,
    where: "server",
    available: () => ({ ok: true }),
    voiceName: () => "Jürgen",
    synthesize: async () => ({ audio: Buffer.alloc(0), mime: "audio/wav" }),
    streamSampleRate: 24_000,
    async *synthesizeStream(text) {
      texts.push(text);
      yield new Uint8Array([9, 9]);
      if (o.fail?.()) throw new SpeechError("exit", 1);
      yield new Uint8Array([8, 8]);
    },
    warm: async () => {},
  };
  return { p, texts };
}

async function collect(it: AsyncIterable<Uint8Array | CallSpeakEvent>) {
  const out: (number[] | CallSpeakEvent)[] = [];
  for await (const x of it) out.push(x instanceof Uint8Array ? [...x] : x);
  return out;
}

function voiceWith(plans: Plan[], o: { pocket?: ReturnType<typeof fakePocket> | null } = {}) {
  const w = elevenWorld(plans);
  const pocket = o.pocket === undefined ? fakePocket() : o.pocket;
  const logs: string[] = [];
  const voice = createCallVoice({
    primary: w.eleven,
    primaryOpts: { voice: "anrufStimme", model: "eleven_flash_v2_5", language: "de" },
    fallback: { provider: pocket?.p ?? null, opts: {}, primaryName: () => "Testa", fallbackName: pocket ? "Jürgen" : "der Browser-Stimme" },
    log: l => logs.push(l),
  });
  return { voice, w, pocket, logs };
}

const sig = () => new AbortController().signal;

describe("createCallVoice: Rückfall je Abschnitt", () => {
  test("ElevenLabs klappt: Stücke ohne Steuerereignis, Stimme und Modell aus speech.call", async () => {
    const v = voiceWith([{ chunks: [[1, 2], [3, 4]] }]);
    expect(await collect(v.voice.speak("Satz eins.", sig()))).toEqual([[1, 2], [3, 4]]);
    expect(v.w.ttsCalls()[0]!.url).toContain("/v1/text-to-speech/anrufStimme/stream?output_format=pcm_24000");
    expect(v.pocket!.texts).toEqual([]);
  });

  for (const [name, plan] of [
    ["HTTP 401", { status: 401 }],
    ["HTTP 429", { status: 429 }],
    ["Netzfehler", { network: true }],
    ["leerer Strom", { empty: true }],
  ] as const) {
    test(`${name}: genau dieser Satz mit Pocket, Hinweis, der nächste wieder mit ElevenLabs`, async () => {
      const v = voiceWith([plan as Plan]);
      expect(await collect(v.voice.speak("Satz eins.", sig()))).toEqual([{ type: "notice", text: "Testa ist nicht erreichbar, weiter mit Jürgen." }, [9, 9], [8, 8]]);
      expect(v.pocket!.texts).toEqual(["Satz eins."]);
      expect(await collect(v.voice.speak("Satz zwei.", sig()))).toEqual([[1, 0, 2, 0]]);
      expect(v.pocket!.texts).toEqual(["Satz eins."]);
      expect(v.w.ttsCalls()).toHaveLength(2);
      expect(v.logs.join("\n")).not.toContain(KEY);
      expect(v.logs.join("\n")).not.toContain("Satz");
    });
  }

  test("Fehler nach dem ersten Stück: restart, Hinweis, der ganze Satz von Pocket", async () => {
    const v = voiceWith([{ chunks: [[1, 2]], failAfter: true }]);
    expect(await collect(v.voice.speak("Satz eins.", sig()))).toEqual([[1, 2], { type: "restart" }, { type: "notice", text: "Testa ist nicht erreichbar, weiter mit Jürgen." }, [9, 9], [8, 8]]);
  });

  test("zwei Fehler in Folge: das Gespräch bleibt bei Pocket, ElevenLabs wird nicht mehr gefragt", async () => {
    expect(CALL_VOICE_MAX_FAILURES).toBe(2);
    const v = voiceWith([{ status: 429 }, { network: true }]);
    await collect(v.voice.speak("Eins.", sig()));
    const second = await collect(v.voice.speak("Zwei.", sig()));
    expect(second[0]).toEqual({ type: "notice", text: "Testa ist nicht erreichbar, das Gespräch bleibt bei Jürgen." });
    expect(v.voice.stuck).toBe(true);
    // Über Turns hinweg: weitere Sätze nur Pocket, ohne Hinweis
    expect(await collect(v.voice.speak("Drei.", sig()))).toEqual([[9, 9], [8, 8]]);
    expect(v.w.ttsCalls()).toHaveLength(2);
    expect(v.pocket!.texts).toEqual(["Eins.", "Zwei.", "Drei."]);
  });

  test("ein erfolgreicher ElevenLabs-Satz setzt den Zähler zurück, ein erfolgreicher Pocket-Rückfall nicht", async () => {
    const a = voiceWith([{ status: 401 }, { chunks: [[1, 2]] }, { status: 401 }, { chunks: [[1, 2]] }]);
    for (const t of ["A.", "B.", "C.", "D."]) await collect(a.voice.speak(t, sig()));
    expect(a.voice.stuck).toBe(false);
    expect(a.w.ttsCalls()).toHaveLength(4);
    // Pocket klappt jedes Mal, trotzdem zählen die ElevenLabs-Fehler weiter
    const b = voiceWith([{ status: 401 }, { status: 401 }]);
    await collect(b.voice.speak("A.", sig()));
    await collect(b.voice.speak("B.", sig()));
    expect(b.voice.stuck).toBe(true);
  });

  test("Abbruch zählt nicht und startet keinen Rückfall: kein Pocket, kein Hinweis, nichts mehr danach", async () => {
    const v = voiceWith([{ chunks: [[1, 2]], stall: true }, { chunks: [[1, 2]], stall: true }, { chunks: [[5, 6]] }]);
    for (let round = 0; round < 2; round++) {
      const ctrl = new AbortController();
      const out: unknown[] = [];
      const run = (async () => {
        for await (const x of v.voice.speak("Satz.", ctrl.signal)) {
          out.push(x);
          ctrl.abort();
        }
      })();
      await run;
      expect(out).toEqual([new Uint8Array([1, 2])]);
      // Die Anfrage ist beendet
      expect(v.w.ttsCalls()[round]!.signal!.aborted).toBe(true);
    }
    expect(v.pocket!.texts).toEqual([]);
    expect(v.voice.stuck).toBe(false);
    expect(await collect(v.voice.speak("Weiter.", sig()))).toEqual([[5, 6]]);
  });

  test("ohne Pocket: der Browser spricht diesen Abschnitt", async () => {
    const v = voiceWith([{ status: 401 }], { pocket: null });
    expect(await collect(v.voice.speak("Satz.", sig()))).toEqual([{ type: "notice", text: "Testa ist nicht erreichbar, weiter mit der Browser-Stimme." }, { type: "browser" }]);
  });

  test("Pocket scheitert auch: restart für seinen Teil, dann der Browser; nach zwei Pocket-Fehlern in Folge nur noch der Browser", async () => {
    const pocket = fakePocket({ fail: () => true });
    const v = voiceWith([{ status: 401 }, { status: 401 }], { pocket });
    expect(await collect(v.voice.speak("A.", sig()))).toEqual([{ type: "notice", text: "Testa ist nicht erreichbar, weiter mit Jürgen." }, [9, 9], { type: "restart" }, { type: "browser" }]);
    await collect(v.voice.speak("B.", sig()));
    expect(await collect(v.voice.speak("C.", sig()))).toEqual([{ type: "browser" }]);
    expect(pocket.texts).toEqual(["A.", "B."]);
  });

  test("ohne Rückfall (Pocket als Hauptstimme): Fehler werfen wie bisher", async () => {
    const pocket = fakePocket({ fail: () => true });
    const voice = createCallVoice({ primary: pocket.p, primaryOpts: {}, log: () => {} });
    await expect(collect(voice.speak("A.", sig()))).rejects.toBeInstanceOf(SpeechError);
  });
});

describe("Sitzung: Steuerereignisse der Stimme", () => {
  function setup(speak: (text: string, signal: AbortSignal) => AsyncIterable<Uint8Array | CallSpeakEvent>) {
    return setupTurn(undefined, speak);
  }

  function setupTurn(turn: (() => AsyncIterable<CallTurnEvent>) | undefined, speak: (text: string, signal: AbortSignal) => AsyncIterable<Uint8Array | CallSpeakEvent>) {
    const clock = fakeClock();
    const s = fakeSocket();
    const port = fakePort({ line: () => fakeLine({ speak, ...(turn ? { turn } : {}) }) });
    const session = new CallSession({
      socket: s.socket,
      port: port.port,
      checkConversation: async () => ({ ok: true, agent: "research" }),
      clock,
      log: () => {},
      onEnd: () => {},
    });
    session.begin();
    const send = (msg: Record<string, unknown>) => session.receive(JSON.stringify(msg));
    const talk = async () => {
      send({ type: "start", conversationId: "abc", tts: "server" });
      await flush();
      for (let i = 0; i < 25; i++) session.receive(pcmFrame(1000));
      await flush();
      send({ type: "utterance_end" });
      await flush();
    };
    return { clock, s, port, send, talk, line: () => port.lines[0]! };
  }

  test("restart und notice: audio_restart nur nach gesendetem Ton, ein audio_end, played zählt einmal", async () => {
    let n = 0;
    const t = setup(async function* () {
      n++;
      if (n === 1) {
        yield new Uint8Array(480);
        yield { type: "restart" } as CallSpeakEvent;
        yield { type: "notice", text: "Testa ist nicht erreichbar, weiter mit Jürgen." } as CallSpeakEvent;
        yield new Uint8Array(480);
      } else {
        yield { type: "restart" } as CallSpeakEvent;
        yield new Uint8Array(480);
      }
    });
    await t.talk();
    const types = t.s.types();
    const first = types.indexOf("audio_begin");
    expect(types.slice(first, first + 6)).toEqual(["audio_begin", "audio", "audio_restart", "notice", "audio", "audio_end"]);
    // Zweiter Abschnitt: restart ohne gesendeten Ton bleibt still
    expect(types.filter(x => x === "audio_restart")).toHaveLength(1);
    expect(t.s.json("notice")[0]!.text).toBe("Testa ist nicht erreichbar, weiter mit Jürgen.");
    const ids = t.s.json("sentence").map(m => m.id);
    expect(t.s.json("audio_restart")[0]!.id).toBe(ids[0]);
    for (const id of ids) {
      t.send({ type: "played", id });
      t.send({ type: "played", id });
    }
    expect(t.line().records).toEqual([{ userText: "Wie geht es dir heute?", spokenText: "Mir geht es gut, danke. Und dir?", rawText: "Mir geht es gut, danke. Und dir?", interrupted: false }]);
  });

  test("browser: speak_browser mit Text statt audio_end; der nächste Abschnitt wartet auf played", async () => {
    let n = 0;
    const t = setup(async function* () {
      n++;
      if (n === 1) {
        yield { type: "notice", text: "Testa ist nicht erreichbar, weiter mit der Browser-Stimme." } as CallSpeakEvent;
        yield { type: "browser" } as CallSpeakEvent;
        yield new Uint8Array(480);
        return;
      }
      yield new Uint8Array(480);
    });
    await t.talk();
    const ids = t.s.json("sentence").map(m => m.id);
    expect(ids).toHaveLength(1);
    expect(t.s.json("speak_browser")).toEqual([{ type: "speak_browser", id: ids[0], text: "Mir geht es gut, danke." }]);
    expect(t.s.json("audio_end")).toEqual([]);
    expect(t.s.types().filter(x => x === "audio")).toHaveLength(0);
    // Erst nach played kommt der nächste Abschnitt mit Ton
    t.send({ type: "played", id: ids[0] });
    await flush();
    const after = t.s.json("sentence").map(m => m.id);
    expect(after).toHaveLength(2);
    expect(t.s.json("audio_end").map(m => m.id)).toEqual([after[1]]);
    t.send({ type: "played", id: after[1] });
    expect(t.line().records[0]).toMatchObject({ spokenText: "Mir geht es gut, danke. Und dir?", interrupted: false });
  });

  test("Reihenfolge: langer Satz 1 läuft noch, kurzer Browser-Satz 2 ist langsam; Satz 3 kommt nie als Ton vor oder über Satz 2", async () => {
    // Satz 1: 10 s Ton vom Server; Satz 2: Browser-Stimme; Satz 3 hätte wieder Ton
    const LONG = 24_000 * 2 * 10;
    const t = setupTurn(
      async function* () {
        yield { type: "segment", text: "Das ist ein langer erster Satz." };
        yield { type: "segment", text: "Kurz." };
        yield { type: "segment", text: "Dritter Satz." };
        yield { type: "done", rawText: "x", spokenText: "Das ist ein langer erster Satz. Kurz. Dritter Satz.", aborted: false };
      },
      async function* (text: string) {
        if (text === "Kurz.") {
          yield { type: "browser" } as CallSpeakEvent;
          return;
        }
        yield new Uint8Array(text.startsWith("Das") ? LONG : 4800);
      },
    );
    await t.talk();
    const ids = t.s.json("sentence").map(m => m.id);
    expect(ids).toHaveLength(2);
    expect(t.s.json("speak_browser").map(m => m.id)).toEqual([ids[1]]);
    const afterBrowser = () => t.s.types().slice(t.s.types().indexOf("speak_browser") + 1);
    // Die alte Frist (geschätzte Dauer von Satz 2 plus Zuschlag) ist um, Satz 1 spielt noch: nichts Neues
    await t.clock.advance("Kurz.".length * 80 + PLAYED_GRACE_MS + 1);
    await flush();
    expect(t.s.json("sentence")).toHaveLength(2);
    // Satz 1 zu Ende gespielt, der Browser spricht Satz 2 langsam: weiter kein Ton
    await t.clock.advance(6_000);
    t.send({ type: "played", id: ids[0] });
    await flush();
    await t.clock.advance(PLAYED_GRACE_MS);
    await flush();
    expect(t.s.json("sentence")).toHaveLength(2);
    expect(afterBrowser().filter(x => x === "audio" || x === "audio_begin")).toEqual([]);
    // Frist samt Satz 1 (10 s + 0,4 s + Zuschlag) verstrichen, Satz 2 weiter unbestätigt: Satz 3 geht an die Browser-Stimme, nicht als Ton
    await t.clock.advance(1_100);
    await flush();
    const all = t.s.json("sentence").map(m => m.id);
    expect(all).toHaveLength(3);
    expect(t.s.json("speak_browser").map(m => m.id)).toEqual([ids[1], all[2]]);
    expect(afterBrowser().filter(x => x === "audio" || x === "audio_begin" || x === "audio_end")).toEqual([]);
    expect(t.line().spoken).toEqual(["Das ist ein langer erster Satz.", "Kurz."]);
    // Der Browser bestätigt beide Sätze nacheinander: alles genau einmal verbucht
    t.send({ type: "played", id: ids[1] });
    t.send({ type: "played", id: all[2] });
    await flush();
    expect(t.line().records).toHaveLength(1);
    expect(t.line().records[0]).toMatchObject({ interrupted: false });
  });

  test("Reihenfolge: bestätigt der Browser Satz 2 rechtzeitig, kommt Satz 3 wieder als Ton", async () => {
    const t = setupTurn(
      async function* () {
        yield { type: "segment", text: "Das ist ein langer erster Satz." };
        yield { type: "segment", text: "Kurz." };
        yield { type: "segment", text: "Dritter Satz." };
        yield { type: "done", rawText: "x", spokenText: "x", aborted: false };
      },
      async function* (text: string) {
        if (text === "Kurz.") {
          yield { type: "browser" } as CallSpeakEvent;
          return;
        }
        yield new Uint8Array(4800);
      },
    );
    await t.talk();
    const ids = t.s.json("sentence").map(m => m.id);
    t.send({ type: "played", id: ids[0] });
    await t.clock.advance(1_000);
    t.send({ type: "played", id: ids[1] });
    await flush();
    const all = t.s.json("sentence").map(m => m.id);
    expect(all).toHaveLength(3);
    expect(t.s.json("audio_end").map(m => m.id)).toEqual([ids[0], all[2]]);
  });

  test("browser ohne played: nach der Frist geht es weiter; Unterbrechen beendet das Warten ohne weiteren Ton", async () => {
    const t = setup(async function* () {
      yield { type: "browser" } as CallSpeakEvent;
    });
    await t.talk();
    expect(t.s.json("sentence")).toHaveLength(1);
    await t.clock.advance(60_000);
    await flush();
    expect(t.s.json("sentence")).toHaveLength(2);
    t.send({ type: "interrupt" });
    await flush();
    await t.clock.advance(60_000);
    await flush();
    expect(t.s.json("sentence")).toHaveLength(2);
  });
});

describe("Anschluss bot-call.ts mit ElevenLabs", () => {
  const READY: CallModelResolution = {
    spec: "claude:claude-sonnet-5-5",
    kind: "claude",
    model: "claude-sonnet-5-5",
    via: "api",
    effort: "low",
    ready: true,
    expectation: "x",
    billing: "anthropic-api",
    costsMoney: true,
    setting: "auto",
    source: "code",
  };

  function botWith(plans: Plan[], settings: Settings, o: { pocket?: boolean } = {}) {
    const w = elevenWorld(plans);
    const pocket = fakePocket();
    const parakeet: SttProvider = {
      id: "parakeet",
      label: "Parakeet",
      local: true,
      available: () => ({ ok: true }),
      transcribe: async () => "x",
      canWarm: () => true,
      warm: async (): Promise<WarmStt> => ({ transcribe: async () => "Hallo?", close: () => {} }),
    };
    const browser: TtsProvider = { id: "browser", label: "Browser", local: true, where: "browser", available: () => ({ ok: true }), synthesize: async () => ({ audio: Buffer.alloc(0), mime: "audio/wav" }) };
    const pocketP: TtsProvider = { ...pocket.p, available: () => (o.pocket === false ? { ok: false, reason: "fehlt" } : { ok: true }) };
    const speech = createSpeech({ stt: [parakeet], tts: [browser, w.eleven, pocketP], getSettings: () => settings, env: () => ({ ELEVENLABS_API_KEY: KEY }), log: () => {}, readFile: async () => Buffer.alloc(0) });
    const logs: string[] = [];
    const bot = createBotCall({
      userId: "123456789",
      groupId: () => "-1001234567890",
      agentForTopic: () => "research",
      speech: () => speech,
      resolve: async () => READY,
      ways: async () => [],
      createBackend: () => ({ id: "fake", label: "Attrappe", async *stream() {} }) as BrainBackend,
      loadContext: async () => "KONTEXT",
      reserveRequest: () => () => {},
      readRestart: async () => null,
      isIntakeClosed: () => false,
      env: {},
      log: l => logs.push(l),
    });
    return { bot, w, pocket, logs };
  }

  test("GET /api/voice: modes.call.tts nennt ElevenLabs mit where, stream, Rückfall, Stimme, Modell und Name nach dem Öffnen", async () => {
    const b = botWith([], { speech: { tts: "pocket", call: { tts: "elevenlabs", elevenlabsVoice: "anrufStimme" } } });
    const before = await b.bot.status();
    expect(before.tts).toMatchObject({ id: "elevenlabs", where: "server", stream: true, setting: "elevenlabs", fallback: "pocket", fallbackName: "Jürgen", voice: "anrufStimme", model: "eleven_v3_conversational" });
    expect(before.tts.voiceName).toBeUndefined();
    expect(before.tts.options!.find(x => x.id === "elevenlabs")).toMatchObject({ available: true });
    const line = await b.bot.open({ conversationId: "abc", agent: "research", tts: "server", signal: sig() });
    expect(line.info.tts).toBe("server");
    // Vorwärmen holte den Namen der Stimme (GET /v1/voices)
    expect(b.w.calls[0]!.url).toBe("https://api.elevenlabs.io/v1/voices/anrufStimme");
    expect((await b.bot.status()).tts.voiceName).toBe("Testa");
    line.close();
  });

  test("speak: 401 bei einem Satz, dieser mit Pocket und Hinweis mit dem Namen der Stimme", async () => {
    const b = botWith([{ status: 401 }], { speech: { call: { tts: "elevenlabs", elevenlabsVoice: "anrufStimme", elevenlabsModel: "eleven_turbo_v2_5" } } });
    const line = await b.bot.open({ conversationId: "abc", agent: "research", tts: "server", signal: sig() });
    expect(await collect(line.speak!("Satz eins.", sig()))).toEqual([{ type: "notice", text: "Testa ist nicht erreichbar, weiter mit Jürgen." }, [9, 9], [8, 8]]);
    expect(await collect(line.speak!("Satz zwei.", sig()))).toEqual([[1, 0, 2, 0]]);
    const tts = b.w.ttsCalls();
    expect(tts.map(c => c.url)).toEqual(["https://api.elevenlabs.io/v1/text-to-speech/anrufStimme/stream?output_format=pcm_24000", "https://api.elevenlabs.io/v1/text-to-speech/anrufStimme/stream?output_format=pcm_24000"]);
    expect(b.logs.join("\n")).toContain("Stimme elevenlabs: Fehler (HTTP 401)");
    line.close();
  });

  test("ohne Pocket: Rückfall auf die Browser-Stimme je Abschnitt", async () => {
    const b = botWith([{ status: 429 }], { speech: { call: { tts: "elevenlabs" } } }, { pocket: false });
    const line = await b.bot.open({ conversationId: "abc", agent: "research", tts: "server", signal: sig() });
    // Der Name der Stimme kam beim Vorwärmen
    expect(await collect(line.speak!("Satz.", sig()))).toEqual([{ type: "notice", text: "Testa ist nicht erreichbar, weiter mit der Browser-Stimme." }, { type: "browser" }]);
    line.close();
  });

  test("Browser gewählt im Browser (tts browser beim Start): keine Server-Stimme, kein Aufruf bei ElevenLabs", async () => {
    const b = botWith([], { speech: { call: { tts: "elevenlabs" } } });
    const line = await b.bot.open({ conversationId: "abc", agent: "research", tts: "browser", signal: sig() });
    expect(line.info.tts).toBe("browser");
    expect(line.speak).toBeUndefined();
    expect(b.w.calls).toHaveLength(0);
    line.close();
  });
});

