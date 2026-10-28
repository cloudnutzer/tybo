/**
 * Anschluss des Telefonhörers an den Bot (Issue #257): src/web/bot-call.ts
 * mit Attrappen für Modellweg, Erkenner, Stimme, Kontext, Budget und
 * Neustart-Marker. Kein echtes Modell, kein sherpa-onnx, kein Pocket TTS.
 */
import { describe, expect, test } from "bun:test";
import { createSpeech } from "../src/lib/speech/chain";
import { pcmToWav } from "../src/lib/speech/pcm";
import { SpeechError, type SttProvider, type TtsProvider, type WarmStt } from "../src/lib/speech/types";
import type { Settings } from "../src/lib/settings";
import type { CallModelResolution } from "../src/lib/voice-brain/call-model";
import { BrainError, type BrainBackend, type BrainCall } from "../src/lib/voice-brain/types";
import { activeCallTurnCount, createBotCall, type BotCallDeps } from "../src/web/bot-call";
import { CALL_SAMPLE_RATE, CALL_TEXT, CallOpenError } from "../src/web/call";
import { CallSession } from "../src/web/call-session";
import { beginCallTurn, resetCallTurnsForTests } from "../src/web/call-turns";
import { createRestartControl } from "../src/lib/restart-control";
import { fakeClock, fakeSocket, flush, gate, pcmFrame } from "./call-fixture";

const READY: CallModelResolution = {
  spec: "claude:claude-sonnet-5-5",
  kind: "claude",
  model: "claude-sonnet-5-5",
  via: "api",
  effort: "low",
  ready: true,
  expectation: "erster Satz nach rund 1,5 Sekunden",
  billing: "anthropic-api",
  costsMoney: true,
  setting: "auto",
  source: "code",
};

interface World {
  deps: BotCallDeps;
  warmCalls: number;
  warmClosed: number;
  warmTranscribes: number;
  coldTranscribes: number;
  ttsWarm: number;
  backendCalls: BrainCall[];
  backendClosed: number;
  prepared: string[];
  backendOptions: any[];
  contexts: Array<{ agent: string; chatId: string; topicId: number | null }>;
  marker: string | null;
  warmFail: "exit" | null;
  /** Erkennung hält an, bis die Promise erfüllt ist */
  recognizeGate: Promise<void> | null;
}

function world(o: { settings?: Settings; resolution?: CallModelResolution; warm?: boolean; prepareFails?: boolean; stream?: boolean; piperRate?: number } = {}): World {
  const w: World = {
    deps: null as unknown as BotCallDeps,
    warmCalls: 0,
    warmClosed: 0,
    warmTranscribes: 0,
    coldTranscribes: 0,
    ttsWarm: 0,
    backendCalls: [],
    backendClosed: 0,
    prepared: [],
    backendOptions: [],
    contexts: [],
    marker: null,
    warmFail: null,
    recognizeGate: null,
  };
  const parakeet: SttProvider = {
    id: "parakeet",
    label: "Parakeet",
    local: true,
    available: () => ({ ok: true }),
    transcribe: async () => {
      w.coldTranscribes++;
      return "kalt erkannt";
    },
    canWarm: () => o.warm !== false,
    warm: async (): Promise<WarmStt> => {
      w.warmCalls++;
      return {
        transcribe: async () => {
          w.warmTranscribes++;
          if (w.recognizeGate) await w.recognizeGate;
          if (w.warmFail) throw new SpeechError(w.warmFail);
          return "Wie spät ist es?";
        },
        close: () => {
          w.warmClosed++;
        },
      };
    },
  };
  const eleven: SttProvider = { id: "elevenlabs", label: "ElevenLabs", local: false, available: () => ({ ok: true }), transcribe: async () => "cloud" };
  const pocket: TtsProvider = {
    id: "pocket",
    label: "Pocket",
    local: true,
    where: "server",
    available: () => ({ ok: true }),
    synthesize: async () => ({ audio: Buffer.alloc(0), mime: "audio/wav" }),
    streamSampleRate: 24_000,
    async *synthesizeStream() {
      yield new Uint8Array(480);
      yield new Uint8Array(480);
    },
    warm: async () => {
      w.ttsWarm++;
    },
  };
  const piper: TtsProvider = {
    id: "piper",
    label: "Piper",
    local: true,
    where: "server",
    available: () => ({ ok: true }),
    synthesize: async () => ({ audio: pcmToWav(Buffer.alloc((o.piperRate ?? 22_050) * 2), o.piperRate ?? 22_050), mime: "audio/wav" }),
  };
  const browser: TtsProvider = { id: "browser", label: "Browser", local: true, where: "browser", available: () => ({ ok: true }), synthesize: async () => ({ audio: Buffer.alloc(0), mime: "audio/wav" }) };
  const settings: Settings = o.settings ?? ({ speech: { tts: "pocket" } } as Settings);
  const speech = createSpeech({ stt: [parakeet, eleven], tts: [browser, pocket, piper], getSettings: () => settings, env: () => ({}), log: () => {}, readFile: async () => Buffer.alloc(0) });
  w.deps = {
    userId: "123456789",
    groupId: () => "-1001234567890",
    agentForTopic: () => "research",
    speech: () => speech,
    resolve: async () => o.resolution ?? READY,
    // Wege zur Auswahl (Issue #260): nie die echte Prüfung von Claude Code oder Ollama
    ways: async () => [],
    createBackend: (_r, options) => {
      w.backendOptions.push(options);
      const backend: BrainBackend = {
        id: "fake",
        label: "Attrappe",
        async *stream(call) {
          w.backendCalls.push(call);
          yield { text: "Es ist halb acht. " };
        },
        prepare: async system => {
          if (o.prepareFails) throw new BrainError("setup", "Claude Code kennt diese Flags nicht: --safe-mode");
          w.prepared.push(system);
        },
        close: () => {
          w.backendClosed++;
        },
      };
      return backend;
    },
    loadContext: async c => {
      w.contexts.push(c);
      return "KONTEXT";
    },
    reserveRequest: () => () => {},
    readRestart: async () => w.marker,
    isIntakeClosed: () => false,
    env: {},
    log: () => {},
  };
  return w;
}

const signal = () => new AbortController().signal;

describe("Status modes.call", () => {
  test("bereit: Erkenner geladen, Modellweg bereit, Pocket gestreamt", async () => {
    const w = world();
    const status = await createBotCall(w.deps).status();
    expect(status).toEqual({
      ready: true,
      model: "claude-sonnet-5-5",
      via: "api",
      expectation: "erster Satz nach rund 1,5 Sekunden",
      // Issue #279: dazu Einstellung und Auswahl der Erkenner
      stt: expect.objectContaining({ id: "parakeet", local: true, warm: true, setting: "auto" }),
      // Issue #276: dazu Einstellung, Auswahl und ElevenLabs-Modelle
      tts: expect.objectContaining({ id: "pocket", where: "server", stream: true, setting: "auto" }),
      // Issue #260: Abrechnung, Einstellung, Wege zur Auswahl, Probe eingerichtet
      billing: READY.billing,
      setting: READY.setting,
      settingSource: READY.source,
      ways: [],
      probe: true,
      voiceProbe: true,
    });
  });

  test("ohne Server-Stimme bereit (Browser), ohne Dauerbetrieb „langsamer“", async () => {
    const w = world({ settings: {} as Settings, warm: false });
    const status = await createBotCall(w.deps).status();
    expect(status.ready).toBe(true);
    expect(status.tts).toMatchObject({ id: "browser", where: "browser", stream: false, setting: "auto" });
    expect(status.stt.warm).toBe(false);
    expect(status.expectation).toContain("langsamer");
  });

  test("nicht bereit: Modellweg fehlt bzw. nur Cloud-Erkennung gewählt, mit Grund", async () => {
    const notReady = { ...READY, ready: false, via: null, model: null, reason: "Kein Weg für den Telefonhörer bereit: kein VOICE_ANTHROPIC_API_KEY" } as CallModelResolution;
    const a = await createBotCall(world({ resolution: notReady }).deps).status();
    expect(a.ready).toBe(false);
    expect(a.reason).toContain("VOICE_ANTHROPIC_API_KEY");
    const b = await createBotCall(world({ settings: { speech: { stt: "elevenlabs" } } as Settings }).deps).status();
    expect(b.ready).toBe(false);
    expect(b.reason).toContain("nur lokal");
  });
});

describe("Gespräch öffnen", () => {
  test("Erkenner wird pro Gespräch einmal geladen, Stimme vorgewärmt, Sitzung vorbereitet; Auflegen schließt alles", async () => {
    const w = world();
    const port = createBotCall(w.deps);
    const line = await port.open({ conversationId: "4f9a2c3e-1111-4222-8333-444455556666", agent: "research", tts: "server", signal: signal() });
    expect(w.warmCalls).toBe(1);
    expect(w.ttsWarm).toBe(1);
    expect(w.prepared).toHaveLength(1);
    expect(w.prepared[0]).toContain("KONTEXT");
    expect(w.prepared[0]).toContain("Telefonhörer");
    expect(line.info).toEqual({ model: "claude-sonnet-5-5", via: "api", stt: "parakeet", tts: "server", sampleRate: CALL_SAMPLE_RATE, sttWarm: true });
    for (let i = 0; i < 3; i++) expect(await line.recognize(new Uint8Array(640), signal())).toEqual({ ok: true, text: "Wie spät ist es?", provider: "parakeet" });
    expect(w.warmCalls).toBe(1);
    expect(w.warmTranscribes).toBe(3);
    expect(w.coldTranscribes).toBe(0);
    line.close();
    line.close();
    expect(w.warmClosed).toBe(1);
    expect(w.backendClosed).toBe(1);
  });

  test("Kontext genau dieses Gesprächs: Web-Gespräch, Topic, Direktchat; Budget und /stop-Schlüssel am Weg", async () => {
    const w = world();
    const port = createBotCall(w.deps);
    (await port.open({ conversationId: "4f9a2c3e-1111-4222-8333-444455556666", agent: "general", tts: "browser", signal: signal() })).close();
    (await port.open({ conversationId: "topic-42", agent: "research", tts: "browser", signal: signal() })).close();
    (await port.open({ conversationId: "dm", agent: "general", tts: "browser", signal: signal() })).close();
    expect(w.contexts).toEqual([
      { agent: "general", chatId: "web:4f9a2c3e-1111-4222-8333-444455556666", topicId: null },
      { agent: "research", chatId: "-1001234567890", topicId: 42 },
      { agent: "general", chatId: "123456789", topicId: null },
    ]);
    expect(typeof w.backendOptions[0].reserveRequest).toBe("function");
    // Die Umgebung des Anschlusses (Schlüssel) geht an den Weg, nicht still process.env
    expect(w.backendOptions[0].env).toBe(w.deps.env);
    expect(w.backendOptions[0].abortKey).toContain("web:4f9a2c3e");
    expect(w.backendOptions[1].abortKey).toContain("-1001234567890");
  });

  test("Turn: Kontext samt Sprechstil, Verlauf und Äußerung gehen an den Weg", async () => {
    const w = world();
    const line = await createBotCall(w.deps).open({ conversationId: "dm", agent: "general", tts: "browser", signal: signal() });
    const events = [];
    for await (const e of line.turn({ userText: "Wie spät ist es?", history: [{ role: "user", content: "Hallo" }, { role: "assistant", content: "Hi." }], signal: signal() })) events.push(e);
    expect(events.map(e => e.type)).toEqual(["segment", "done"]);
    expect(w.backendCalls[0]!.messages).toEqual([
      { role: "user", content: "Hallo" },
      { role: "assistant", content: "Hi." },
      { role: "user", content: "Wie spät ist es?" },
    ]);
    expect(w.backendCalls[0]!.system).toContain("KONTEXT");
    line.close();
  });

  test("Stimme: Pocket gestreamt unverändert, Piper am Stück auf 24 kHz umgerechnet, Browser ohne speak", async () => {
    const w = world();
    const line = await createBotCall(w.deps).open({ conversationId: "dm", agent: "general", tts: "server", signal: signal() });
    const chunks: Uint8Array[] = [];
    for await (const c of line.speak!("Hallo.", signal())) chunks.push(c);
    expect(chunks.map(c => c.length)).toEqual([480, 480]);
    line.close();
    const p = world({ settings: { speech: { tts: "piper" } } as Settings });
    const pl = await createBotCall(p.deps).open({ conversationId: "dm", agent: "general", tts: "server", signal: signal() });
    const pc: Uint8Array[] = [];
    for await (const c of pl.speak!("Hallo.", signal())) pc.push(c);
    expect(pc[0]!.length).toBe(24_000 * 2);
    pl.close();
    const b = await createBotCall(world().deps).open({ conversationId: "dm", agent: "general", tts: "browser", signal: signal() });
    expect(b.info.tts).toBe("browser");
    expect(b.speak).toBeUndefined();
    b.close();
  });

  test("Erkennungsprozess weg: weiter je Äußerung, diese Äußerung gleich noch einmal", async () => {
    const w = world();
    const line = await createBotCall(w.deps).open({ conversationId: "dm", agent: "general", tts: "browser", signal: signal() });
    w.warmFail = "exit";
    expect(await line.recognize(new Uint8Array(640), signal())).toEqual({ ok: true, text: "kalt erkannt", provider: "parakeet" });
    expect(w.warmClosed).toBe(1);
    expect(await line.recognize(new Uint8Array(640), signal())).toEqual({ ok: true, text: "kalt erkannt", provider: "parakeet" });
    expect(w.warmTranscribes).toBe(1);
    line.close();
  });

  test("Startfehler (CLI-Flag fehlt): CallOpenError modell, Erkenner und Weg wieder zu", async () => {
    const w = world({ prepareFails: true });
    const err = await createBotCall(w.deps)
      .open({ conversationId: "dm", agent: "general", tts: "server", signal: signal() })
      .catch(e => e);
    expect(err).toBeInstanceOf(CallOpenError);
    expect(err.reason).toBe("modell");
    expect(err.message).toContain("--safe-mode");
    expect(w.warmClosed).toBe(1);
    expect(w.backendClosed).toBe(1);
  });

  test("Abbruch während des Öffnens: alles wieder zu", async () => {
    const w = world();
    const controller = new AbortController();
    const opening = createBotCall(w.deps).open({ conversationId: "dm", agent: "general", tts: "server", signal: controller.signal });
    controller.abort();
    await expect(opening).rejects.toBeInstanceOf(CallOpenError);
    expect(w.backendClosed).toBe(1);
  });

  test("Modellweg nicht bereit, kein lokaler Erkenner, Neustart angefordert: kein Öffnen", async () => {
    const notReady = { ...READY, ready: false, reason: "OPENROUTER_API_KEY fehlt" } as CallModelResolution;
    await expect(createBotCall(world({ resolution: notReady }).deps).open({ conversationId: "dm", agent: "general", tts: "server", signal: signal() })).rejects.toMatchObject({ reason: "nicht-bereit" });
    await expect(createBotCall(world({ settings: { speech: { stt: "elevenlabs" } } as Settings }).deps).open({ conversationId: "dm", agent: "general", tts: "server", signal: signal() })).rejects.toMatchObject({ reason: "kein-erkenner" });
    const w = world();
    w.marker = "Update";
    const port = createBotCall(w.deps);
    await expect(port.open({ conversationId: "dm", agent: "general", tts: "server", signal: signal() })).rejects.toMatchObject({ reason: "neustart" });
    expect(port.restartPending()).toBe(true);
    expect(w.warmCalls).toBe(0);
  });

  test("Turns zählen für den Neustart, das offene Gespräch nicht", async () => {
    const port = createBotCall(world().deps);
    const line = await port.open({ conversationId: "dm", agent: "general", tts: "browser", signal: signal() });
    const before = activeCallTurnCount();
    const release = port.turnBegin();
    expect(activeCallTurnCount()).toBe(before + 1);
    release();
    release();
    expect(activeCallTurnCount()).toBe(before);
    line.close();
  });
});

/**
 * CI-Lauf zu #332: bun führt alle Testdateien in einem Prozess aus, die
 * Reihenfolge hängt vom Dateisystem ab. Lief tests/web-call-scribe.test.ts
 * (lässt Turns offen) vor dieser Datei, meldeten die Neustart-Tests „busy“.
 * Der Vorlauf stellt das in fester Reihenfolge nach: er lässt einen Turn
 * offen, danach folgen die Neustart-Tests. tests/preload-env.ts setzt den
 * Zähler vor jedem Test zurück.
 */
describe("offener Turn eines früheren Tests", () => {
  test("Vorlauf: Turn bleibt offen, wie ein Gespräch, das nie auflegt", () => {
    const port = createBotCall(world().deps);
    expect(port.turnBegin()).not.toBeNull();
    expect(activeCallTurnCount()).toBe(1);
  });

  test("der nächste Test beginnt ohne laufenden Turn", () => {
    expect(activeCallTurnCount()).toBe(0);
  });

  test("ein spätes Ende nach dem Zurücksetzen zählt nicht ins Minus", () => {
    const end = beginCallTurn();
    resetCallTurnsForTests();
    const other = beginCallTurn();
    end();
    end();
    expect(activeCallTurnCount()).toBe(1);
    other();
    expect(activeCallTurnCount()).toBe(0);
  });

  test("Vorlauf vor den Neustart-Tests: wieder ein offener Turn", () => {
    expect(createBotCall(world().deps).turnBegin()).not.toBeNull();
  });
});

/** Bot-Anschluss, Gespräch und Neustart-Steuerung zusammen; Annahmesperre als Zähler */
function restartWorld() {
  const w = world();
  let intake = 0;
  w.deps.isIntakeClosed = () => intake > 0;
  const port = createBotCall(w.deps);
  const order: string[] = [];
  const clock = fakeClock();
  const s = fakeSocket();
  const session = new CallSession({
    socket: s.socket,
    port,
    checkConversation: async () => ({ ok: true, agent: "general" }),
    clock,
    log: () => {},
    onEnd: () => order.push("aufgelegt"),
  });
  session.begin();
  const hold: { clear: Promise<void> | null } = { clear: null };
  const control = createRestartControl({
    readRequest: async () => w.marker,
    clearRequest: async () => {
      if (hold.clear) await hold.clear;
      w.marker = null;
    },
    busyCount: () => activeCallTurnCount(),
    detectSupervisor: async () => "launchd",
    closeIntake: () => {
      intake++;
      order.push("sperre");
      let done = false;
      return () => {
        if (done) return;
        done = true;
        intake--;
      };
    },
    send: async () => {
      order.push("meldung");
    },
    beforeShutdown: () => port.farewellAll(),
    shutdown: async () => {
      order.push("shutdown");
    },
    isShuttingDown: () => false,
    log: () => {},
  });
  const ready = async () => {
    session.receive(JSON.stringify({ type: "start", conversationId: "dm", tts: "server" }));
    await flush(20);
  };
  return { w, port, session, s, order, control, hold, ready };
}

describe("Neustart mit offenem Gespräch (createRestartControl)", () => {
  test("Erkennung endet nach der Annahmesperre: kein Modellabruf, Abschied vor shutdown", async () => {
    const r = restartWorld();
    await r.ready();
    expect(r.s.types()).toContain("ready");
    for (let i = 0; i < 25; i++) r.session.receive(pcmFrame());
    const recognized = gate();
    r.w.recognizeGate = recognized.promise;
    r.session.receive(JSON.stringify({ type: "utterance_end" }));
    await flush();
    expect(r.session.currentState).toBe("versteht");
    // Neustart angefordert; die Steuerung hängt nach der Sperre beim Löschen des Markers
    r.w.marker = "Update";
    const cleared = gate();
    r.hold.clear = cleared.promise;
    const restart = r.control.maybeRestart("idle");
    await flush();
    expect(r.order).toEqual(["sperre"]);
    expect(r.port.turnBegin()).toBeNull();
    // Jetzt kommt das Ergebnis der Erkennung
    recognized.open();
    await flush(10);
    expect(r.w.backendCalls).toEqual([]);
    expect(r.s.json("transcript")).toEqual([]);
    cleared.open();
    expect(await restart).toBe("restarting");
    expect(r.w.backendCalls).toEqual([]);
    expect(r.s.json("sentence").map(m => m.text)).toEqual([CALL_TEXT.restartBye]);
    expect(r.s.json("ended")[0]).toMatchObject({ reason: "neustart" });
    expect(r.order).toEqual(["sperre", "aufgelegt", "meldung", "shutdown"]);
    expect(activeCallTurnCount()).toBe(0);
  });

  test("Gespräch hört zu, Neustart vor dem nächsten Marker-Poll: Abschied gesprochen und aufgelegt vor shutdown", async () => {
    const r = restartWorld();
    await r.ready();
    expect(r.session.currentState).toBe("hoert-zu");
    r.w.marker = "Update";
    expect(await r.control.maybeRestart("idle")).toBe("restarting");
    expect(r.s.json("sentence").map(m => m.text)).toEqual([CALL_TEXT.restartBye]);
    const types = r.s.types();
    // Ton des Abschieds vollständig vor ended
    expect(types.indexOf("audio_end")).toBeGreaterThan(types.indexOf("audio"));
    expect(types.indexOf("ended")).toBeGreaterThan(types.indexOf("audio_end"));
    expect(r.s.json("ended")[0]).toMatchObject({ reason: "neustart" });
    expect(r.order).toEqual(["sperre", "aufgelegt", "meldung", "shutdown"]);
    expect(activeCallTurnCount()).toBe(0);
  });
});

describe("Verdrahtung", () => {
  // Übergabe an die WebUI: tests/app-bot-web.test.ts; Telefonhörer-Turns im Neustart und Abschied
  // vor dem Exit: tests/app-bot-restart.test.ts (Issue #344)

  test("startWebUi gibt den CallPort an den Server weiter", async () => {
    const { startWebUi } = await import("../src/web/startup");
    const port = createBotCall(world().deps);
    let seen: unknown;
    await startWebUi({
      env: { WEB_ENABLED: "true", WEB_PASSWORD: "passwort-fuer-den-test", WEB_PORT: "3199" },
      chat: { runTurn: async () => {} } as any,
      call: port,
      createServer: async (_config, deps) => {
        seen = deps.call;
        return { url: "http://127.0.0.1:3199" } as any;
      },
      log: () => {},
      lanAddresses: () => [],
    });
    expect(seen).toBe(port);
  });
});
