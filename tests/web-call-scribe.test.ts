/**
 * ElevenLabs Scribe im Telefonhörer (Issue #279, Checkboxen 2 und 3): echter
 * Anbieter aus providers.ts mit Attrappe der Realtime-Schnittstelle (kein
 * Aufruf bei ElevenLabs), echter Anschluss (bot-call.ts) und echte Sitzung
 * (call-session.ts). Verbindung beim Öffnen, Stücke beim Sprechen, Commit
 * bei utterance_pause, Verwerfen bei weiterer Sprache, Abbruch, Rückfall
 * auf Parakeet für genau diese Äußerung mit Hinweis an den Browser, nach
 * zwei Fehlern bei Parakeet (dann kein Ton mehr an ElevenLabs), Zählen nur
 * übernommener Erkennungen, Parakeet beim Öffnen geladen und beim Auflegen
 * beendet, ohne Schlüssel nicht wählbar, auto bleibt lokal, Schema und
 * PATCH, Status für GET /api/voice.
 */

import { describe, expect, test } from "bun:test";
import { createSpeech } from "../src/lib/speech/chain";
import { createSttProviders, type ProviderDeps } from "../src/lib/speech/providers";
import { SpeechError, type SttProvider, type TtsProvider, type WarmStt } from "../src/lib/speech/types";
import { settingsSchema, type Settings } from "../src/lib/settings";
import type { CallModelResolution } from "../src/lib/voice-brain/call-model";
import type { BrainBackend } from "../src/lib/voice-brain/types";
import { createBotCall } from "../src/web/bot-call";
import { CallSession } from "../src/web/call-session";
import { createWebServer } from "../src/web/server";
import { applySettingsPatch } from "../src/web/settings";
import { ConversationStore } from "../src/web/store";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClock, fakeSocket, flush, pcmFrame } from "./call-fixture";
import { fakeScribe, type ScribeReply } from "./scribe-fixture";

const KEY = "KEY-MARKER-SCRIBE";

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

function providerDeps(env: Record<string, string | undefined>, fetchFn: ProviderDeps["fetch"], connect: ProviderDeps["connectWebSocket"]): ProviderDeps {
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
    connectWebSocket: connect,
  };
}

function world(o: { settings?: Settings; env?: Record<string, string | undefined>; parakeet?: boolean; warm?: boolean; autoCommitBytes?: number } = {}) {
  const env = o.env ?? { ELEVENLABS_API_KEY: KEY };
  const scribe = fakeScribe(o.autoCommitBytes ? { autoCommitBytes: o.autoCommitBytes } : {});
  const replies: ScribeReply[] = scribe.replies;
  // Batch-Uploads (scribe_v1 für Telegram und Sprechmodus): im Telefonhörer nie
  const uploads: string[] = [];
  const logs: string[] = [];
  const counts = { warm: 0, warmClosed: 0, warmTranscribes: 0, cold: 0 };
  const parakeetText: string[] = [];
  /** Größe der Aufnahme je Erkennung des geladenen Parakeet */
  const parakeetAudio: number[] = [];
  const fetchFn: ProviderDeps["fetch"] = async url => {
    uploads.push(url);
    return Response.json({ text: "Batch" });
  };
  const [, whisper, eleven] = createSttProviders(providerDeps(env, fetchFn, scribe.connect));
  const parakeet: SttProvider = {
    id: "parakeet",
    label: "Parakeet",
    local: true,
    available: () => (o.parakeet === false ? { ok: false, reason: "nicht eingerichtet" } : { ok: true }),
    transcribe: async () => {
      counts.cold++;
      return parakeetText.shift() ?? "kalt erkannt";
    },
    canWarm: () => o.parakeet !== false && o.warm !== false,
    warm: async (): Promise<WarmStt> => {
      counts.warm++;
      return {
        transcribe: async (audio, _mime, opts) => {
          counts.warmTranscribes++;
          parakeetAudio.push(audio.length);
          const text = parakeetText.shift() ?? "Parakeet hat erkannt";
          if (text !== "hang") return text;
          // Hängt, bis die Äußerung abgebrochen wird
          return new Promise<string>((_, reject) => {
            opts.signal?.addEventListener("abort", () => reject(new SpeechError("timeout")), { once: true });
          });
        },
        close: () => {
          counts.warmClosed++;
        },
      };
    },
  };
  const browser: TtsProvider = { id: "browser", label: "Browser", local: true, where: "browser", available: () => ({ ok: true }), synthesize: async () => ({ audio: Buffer.alloc(0), mime: "audio/wav" }) };
  const settings: Settings = o.settings ?? ({ speech: { language: "de", call: { stt: "elevenlabs" } } } as Settings);
  const speech = createSpeech({ stt: [parakeet, whisper!, eleven!], tts: [browser], getSettings: () => settings, env: () => env, log: () => {}, readFile: async () => Buffer.alloc(0) });
  const backend: BrainBackend = {
    id: "fake",
    label: "Attrappe",
    async *stream() {
      yield { text: "Morgen wird es sonnig. " };
    },
  };
  const port = createBotCall({
    userId: "123456789",
    groupId: () => null,
    agentForTopic: () => "general",
    speech: () => speech,
    resolve: async () => READY,
    ways: async () => [],
    createBackend: () => backend,
    loadContext: async () => "KONTEXT",
    reserveRequest: () => () => {},
    readRestart: async () => null,
    isIntakeClosed: () => false,
    searchAvailable: () => false,
    processIntents: async () => ({ outcome: "none" }) as any,
    saveMessage: async () => true,
    addRecap: () => {},
    env,
    log: line => logs.push(line),
    now: () => 0,
  });
  return { port, speech, replies, uploads, scribe, logs, counts, parakeetText, parakeetAudio, settings };
}

/** Gespräch mit echter Sitzung; Äußerungen wie der Browser */
async function session(w: ReturnType<typeof world>) {
  const s = fakeSocket();
  const sess = new CallSession({ socket: s.socket, port: w.port, checkConversation: async () => ({ ok: true, agent: "general" }), clock: fakeClock(), log: () => {}, onEnd: () => {} });
  sess.begin();
  sess.receive(JSON.stringify({ type: "start", conversationId: "dm", tts: "browser" }));
  await flush(20);
  const speak = (frames = 10) => {
    for (let i = 0; i < frames; i++) sess.receive(pcmFrame());
  };
  const send = (type: string) => sess.receive(JSON.stringify({ type }));
  /** Antwort im Browser bestätigen, bis die Sitzung wieder zuhört */
  const finishTurn = async () => {
    for (const m of s.json("sentence")) sess.receive(JSON.stringify({ type: "played", id: m.id }));
    await flush(20);
  };
  return { s, sess, speak, send, finishTurn };
}

describe("Schema und PATCH für speech.call.stt", () => {
  test("auto, parakeet, whisper-cpp, elevenlabs gültig; gemini und Unsinn abgelehnt", () => {
    for (const stt of ["auto", "parakeet", "whisper-cpp", "elevenlabs"]) expect(settingsSchema.safeParse({ speech: { call: { stt } } }).success).toBe(true);
    for (const stt of ["gemini", "scribe", ""]) expect(settingsSchema.safeParse({ speech: { call: { stt } } }).success).toBe(false);
  });

  test("PATCH setzt und entfernt stt, andere Felder bleiben; ein Schlüsselfeld wird abgelehnt", () => {
    const current = { speech: { stt: "parakeet", call: { model: "auto", tts: "elevenlabs" } } };
    const r = applySettingsPatch(current, { speech: { call: { stt: "elevenlabs" } } }, []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.speech).toEqual({ stt: "parakeet", call: { model: "auto", tts: "elevenlabs", stt: "elevenlabs" } });
    const back = applySettingsPatch(r.value, { speech: { call: { stt: null } } }, []);
    expect(back.ok && back.value.speech).toEqual({ stt: "parakeet", call: { model: "auto", tts: "elevenlabs" } });
    // Ungültige Werte lehnt das Schema beim Schreiben ab (bot-settings.ts)
    const bad = applySettingsPatch(current, { speech: { call: { stt: "gemini" } } }, []);
    expect(!bad.ok || !settingsSchema.safeParse(bad.value).success).toBe(true);
    const key = applySettingsPatch(current, { speech: { call: { elevenlabsApiKey: KEY } } }, []);
    expect(key.ok).toBe(false);
    if (!key.ok) expect(key.error).not.toContain(KEY);
  });
});

describe("callChoice: Erkenner des Telefonhörers", () => {
  test("fehlend und auto bleiben lokal wie vor #279, auch mit Schlüssel und bei speech.stt elevenlabs", () => {
    for (const call of [undefined, { stt: "auto" as const }]) {
      const local = world({ settings: { speech: { stt: "auto", ...(call ? { call } : {}) } } as Settings }).speech.callChoice();
      expect(local.stt?.id).toBe("parakeet");
      expect(local.sttSetting).toBe("auto");
      expect(local.sttFallback).toBeUndefined();
      // Cloud-Wahl in speech.stt (Telegram, Sprechmodus) macht den Telefonhörer weiter nicht bereit, statt in die Cloud zu gehen
      const cloud = world({ settings: { speech: { stt: "elevenlabs", ...(call ? { call } : {}) } } as Settings }).speech.callChoice();
      expect(cloud.stt).toBeNull();
      expect(cloud.sttReason).toContain("hört nur lokal");
    }
  });

  test("fest parakeet bzw. whisper-cpp, unabhängig von speech.stt; fehlt er: nicht bereit mit Grund", () => {
    expect(world({ settings: { speech: { stt: "elevenlabs", call: { stt: "parakeet" } } } as Settings }).speech.callChoice().stt?.id).toBe("parakeet");
    const whisper = world({ settings: { speech: { call: { stt: "whisper-cpp" } } } as Settings }).speech.callChoice();
    expect(whisper.stt).toBeNull();
    expect(whisper.sttReason).toContain("whisper.cpp ist nicht verfügbar");
  });

  test("elevenlabs mit Schlüssel: Scribe, Parakeet als Rückfall; ohne Parakeet kein Rückfall", () => {
    const c = world().speech.callChoice();
    expect(c.stt?.id).toBe("elevenlabs");
    expect(c.sttFallback?.id).toBe("parakeet");
    const none = world({ parakeet: false }).speech.callChoice();
    expect(none.stt?.id).toBe("elevenlabs");
    expect(none.sttFallback).toBeNull();
  });

  test("ohne Schlüssel nicht wählbar (Grund in den Optionen); eine gespeicherte Wahl erkennt mit Parakeet", () => {
    const w = world({ env: {} });
    const option = w.speech.callSttOptions().find(x => x.id === "elevenlabs");
    expect(option).toEqual({ id: "elevenlabs", label: "ElevenLabs Scribe", available: false, reason: "ELEVENLABS_API_KEY fehlt" });
    const c = w.speech.callChoice();
    expect(c.stt?.id).toBe("parakeet");
    expect(c.sttNote).toBe("ElevenLabs Scribe ist nicht wählbar (ELEVENLABS_API_KEY fehlt), es erkennt Parakeet");
    const nothing = world({ env: {}, parakeet: false }).speech.callChoice();
    expect(nothing.stt).toBeNull();
    expect(nothing.sttReason).toContain("ELEVENLABS_API_KEY fehlt");
  });

  test("Sprechmodus (V2) und Telegram unverändert: speech.call.stt wirkt dort nicht, keine Verbindung zu Scribe", async () => {
    const w = world({ settings: { speech: { stt: "parakeet", call: { stt: "elevenlabs" } } } as Settings });
    expect(await w.speech.recognize(Buffer.from("RIFF"), "audio/wav", { timeoutMs: 1000 })).toEqual({ ok: true, text: "kalt erkannt", provider: "parakeet" });
    expect(await w.speech.transcribeBuffer(Buffer.from("OggS"))).toBe("kalt erkannt");
    expect(w.speech.getTranscriptionProvider()).toBe("Parakeet (local)");
    expect(w.uploads).toHaveLength(0);
    expect(w.scribe.sockets).toHaveLength(0);
  });

  test("Optionen: Automatisch, Parakeet, whisper.cpp, ElevenLabs Scribe", () => {
    expect(world().speech.callSttOptions().map(o => [o.id, o.available])).toEqual([
      ["auto", true],
      ["parakeet", true],
      ["whisper-cpp", false],
      ["elevenlabs", true],
    ]);
  });
});

describe("Status modes.call.stt (GET /api/voice)", () => {
  test("elevenlabs: Scribe erkennt, Rückfall parakeet, warm, keine Warnung „langsamer“", async () => {
    const status = await world().port.status();
    expect(status.ready).toBe(true);
    expect(status.stt).toMatchObject({ id: "elevenlabs", local: false, warm: true, setting: "elevenlabs", fallback: "parakeet" });
    expect(status.stt.options?.map(o => o.id)).toEqual(["auto", "parakeet", "whisper-cpp", "elevenlabs"]);
    expect(status.expectation).not.toContain("langsamer");
  });

  test("GET /api/voice meldet die Wahl in modes.call.stt (echter Server, echter Anschluss)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tybo-call-scribe-"));
    const store = new ConversationStore({ dir: join(dir, "web") });
    await store.load();
    const password = "test-passwort-279";
    const server = await createWebServer(
      { host: "127.0.0.1", port: 0, password, allowedHosts: [] },
      {
        sessionFile: join(dir, "sessions.json"),
        conversationStore: store,
        call: world().port,
        voice: { localMode: () => ({ ready: true, stt: { id: "parakeet", label: "Parakeet", local: true, available: true }, tts: { id: "browser", label: "Browser-Stimme", where: "browser", available: true } }) },
        log: () => {},
      },
    );
    try {
      const login = await fetch(`${server.url}/api/login`, { method: "POST", headers: { origin: server.url }, body: JSON.stringify({ password }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const body = (await (await fetch(`${server.url}/api/voice`, { headers: { cookie } })).json()) as any;
      expect(body.modes.call.stt).toMatchObject({ id: "elevenlabs", setting: "elevenlabs", fallback: "parakeet", warm: true });
      expect(body.modes.call.stt.options.find((o: any) => o.id === "elevenlabs")).toEqual({ id: "elevenlabs", label: "ElevenLabs Scribe", available: true });
      expect(JSON.stringify(body)).not.toContain(KEY);
    } finally {
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ohne Schlüssel: Parakeet mit Grund; auto ohne Rückfall-Feld", async () => {
    const noKey = await world({ env: {} }).port.status();
    expect(noKey.stt).toMatchObject({ id: "parakeet", setting: "elevenlabs", reason: expect.stringContaining("ELEVENLABS_API_KEY fehlt") });
    const auto = await world({ settings: { speech: {} } as Settings }).port.status();
    expect(auto.stt).toMatchObject({ id: "parakeet", setting: "auto" });
    expect(auto.stt.fallback).toBeUndefined();
  });
});

describe("Gespräch mit Scribe", () => {
  const SINGLE = "ElevenLabs Scribe ist nicht erreichbar, Parakeet erkennt diese Äußerung.";
  const STAY = "ElevenLabs Scribe ist nicht erreichbar, das Gespräch bleibt bei Parakeet.";

  test("Verbindung und Parakeet als Rückfall beim Öffnen, beide beim Auflegen beendet", async () => {
    const w = world();
    const line = await w.port.open({ conversationId: "dm", agent: "general", tts: "browser", signal: new AbortController().signal });
    expect(line.info).toMatchObject({ stt: "elevenlabs", sttWarm: true });
    expect(w.scribe.sockets).toHaveLength(1);
    expect(new URL(w.scribe.sockets[0]!.url).searchParams.get("language_code")).toBe("de");
    expect(w.counts.warm).toBe(1);
    expect(w.logs).toContain("Rückfall-Erkenner parakeet geladen in 0 ms");
    line.close();
    expect(w.counts.warmClosed).toBe(1);
    expect(w.scribe.sockets[0]!.closed).toBe(true);
  });

  test("auto bleibt lokal: keine Verbindung zu Scribe, Parakeet erkennt", async () => {
    const w = world({ settings: { speech: { language: "de" } } as Settings });
    const c = await session(w);
    c.speak();
    c.send("utterance_pause");
    c.send("utterance_end");
    await flush(20);
    expect(w.scribe.sockets).toHaveLength(0);
    expect(w.uploads).toHaveLength(0);
    expect(c.s.json("transcript").map(m => m.text)).toEqual(["Parakeet hat erkannt"]);
  });

  test("Stücke gehen beim Sprechen hinaus, Commit bei utterance_pause, Ergebnis bei utterance_end ohne zweiten Commit", async () => {
    const w = world();
    w.replies.push({ text: "Wie wird das Wetter morgen in Berlin?" });
    const c = await session(w);
    c.speak();
    await flush();
    // Schon vor der Pause ist die ganze Äußerung bei Scribe, aber noch kein Commit
    expect(w.scribe.audioBytes()).toBe(10 * 640);
    expect(w.scribe.commits()).toHaveLength(0);
    c.send("utterance_pause");
    await flush();
    expect(w.scribe.commits()).toHaveLength(1);
    c.send("utterance_end");
    await flush(20);
    expect(w.scribe.commits()).toHaveLength(1);
    expect(w.scribe.sockets).toHaveLength(1);
    expect(w.uploads).toHaveLength(0);
    expect(c.s.json("transcript").map(m => m.text)).toEqual(["Wie wird das Wetter morgen in Berlin?"]);
    expect(c.s.json("notice")).toEqual([]);
    expect(w.counts.warmTranscribes).toBe(0);
    expect(w.logs).toContain("Hören elevenlabs: ok, 0 ms");
    expect(w.logs.join("\n")).not.toContain("Wetter");
  });

  test("weitere Sprache verwirft das Pausen-Ergebnis: zählt nicht, kein Rückfall; utterance_end liefert die ganze Äußerung", async () => {
    const w = world();
    w.replies.push("hang", { text: "mit Sahne." });
    const c = await session(w);
    c.speak(5);
    c.send("utterance_pause");
    await flush();
    expect(w.scribe.commits()).toHaveLength(1);
    c.speak(5);
    await flush();
    // Die Antwort auf den ersten Commit kommt erst jetzt; sie gehört weiter zu dieser Äußerung
    w.scribe.sockets[0]!.emit("message", { message_type: "committed_transcript", text: "Ich hätte gern ein Schokoeis" });
    c.send("utterance_end");
    await flush(20);
    expect(w.scribe.commits()).toHaveLength(2);
    expect(w.scribe.audioBytes()).toBe(10 * 640);
    expect(c.s.json("transcript").map(m => m.text)).toEqual(["Ich hätte gern ein Schokoeis mit Sahne."]);
    expect(c.s.json("notice")).toEqual([]);
    expect(w.counts.warmTranscribes).toBe(0);
    expect(w.logs).toContain("Hören elevenlabs: abgebrochen, 0 ms");
  });

  test("automatischer Commit des Servers bei langer Äußerung: alle Abschnitte im Transkript, kein Rückfall", async () => {
    // 36 Sekunden sind 1800 Stücke zu 20 ms
    const w = world({ autoCommitBytes: 1800 * 640 });
    w.scribe.autoReplies.push({ text: "Anfang der langen Äußerung" });
    w.replies.push({ text: "nur der Schluss" });
    const c = await session(w);
    c.speak(1900);
    await flush();
    c.send("utterance_pause");
    c.send("utterance_end");
    await flush(20);
    expect(w.scribe.commits()).toHaveLength(1);
    expect(c.s.json("transcript").map(m => m.text)).toEqual(["Anfang der langen Äußerung nur der Schluss"]);
    expect(c.s.json("notice")).toEqual([]);
    expect(w.counts.warmTranscribes).toBe(0);
  });

  test("Überschneidung mit einem eigenen Commit: Parakeet erkennt die ganze Aufnahme, die nächste Äußerung bekommt keine Altabschnitte", async () => {
    const w = world({ autoCommitBytes: 1800 * 640 });
    w.scribe.autoReplies.push("hang");
    w.parakeetText.push("Die ganze lange Äußerung");
    const c = await session(w);
    c.speak(1850);
    await flush();
    c.send("utterance_pause");
    c.send("utterance_end");
    await flush(20);
    // Späte Antworten der verworfenen Verbindung
    w.scribe.sockets[0]!.emit("message", { message_type: "committed_transcript", text: "Anfang der langen Äußerung" });
    w.scribe.sockets[0]!.emit("message", { message_type: "committed_transcript", text: "nur der Schluss" });
    expect(c.s.json("transcript").map(m => m.text)).toEqual(["Die ganze lange Äußerung"]);
    expect(w.parakeetAudio).toHaveLength(1);
    expect(w.parakeetAudio[0]).toBeGreaterThanOrEqual(1850 * 640);
    expect(c.s.json("notice").map(m => m.text)).toEqual([SINGLE]);
    expect(w.logs).toContain("Hören elevenlabs: Fehler (unerwartete Antwort), 0 ms");
    await c.finishTurn();
    w.replies.push({ text: "Neue Frage?" });
    c.speak();
    c.send("utterance_end");
    await flush(20);
    expect(w.scribe.sockets).toHaveLength(2);
    expect(c.s.json("transcript").map(m => m.text)).toEqual(["Die ganze lange Äußerung", "Neue Frage?"]);
  });

  test("Auflegen während des Erkennens: Abbruch, kein Rückfall, Verbindung zu", async () => {
    const w = world();
    w.replies.push("hang");
    const c = await session(w);
    c.speak();
    c.send("utterance_end");
    await flush();
    c.send("hangup");
    await flush(20);
    expect(w.counts.warmTranscribes).toBe(0);
    expect(c.s.json("notice")).toEqual([]);
    expect(w.scribe.sockets[0]!.closed).toBe(true);
  });

  test("Scribe scheitert (401): Parakeet erkennt genau diese Äußerung, Hinweis bei der Übernahme; nach dem zweiten Fehler bleibt es bei Parakeet, kein Ton mehr an ElevenLabs", async () => {
    const w = world();
    w.replies.push({ error: "auth_error" }, { error: "quota_exceeded" });
    w.parakeetText.push("Erste Äußerung", "Zweite Äußerung", "Dritte Äußerung");
    const c = await session(w);
    // Erste Äußerung: Fehler beim Commit in der Pause, der Rückfall erkennt dieselbe Aufnahme; der Hinweis kommt mit der Übernahme
    c.speak();
    c.send("utterance_pause");
    await flush(20);
    expect(c.s.json("notice")).toEqual([]);
    c.send("utterance_end");
    await flush(20);
    expect(c.s.json("notice").map(m => m.text)).toEqual([SINGLE]);
    expect(c.s.json("transcript").map(m => m.text)).toEqual(["Erste Äußerung"]);
    expect(w.counts.warmTranscribes).toBe(1);
    await c.finishTurn();
    // Zweite Äußerung: neue Verbindung, zweiter Fehler in Folge, das Gespräch bleibt bei Parakeet
    c.speak();
    c.send("utterance_end");
    await flush(20);
    expect(w.scribe.sockets).toHaveLength(2);
    expect(c.s.json("transcript").map(m => m.text)).toEqual(["Erste Äußerung", "Zweite Äußerung"]);
    expect(c.s.json("notice").map(m => m.text)).toEqual([SINGLE, STAY]);
    expect(w.scribe.sockets.every(s => s.closed)).toBe(true);
    await c.finishTurn();
    // Dritte: kein Ton und keine Verbindung mehr
    const audio = w.scribe.audioBytes();
    c.speak();
    c.send("utterance_pause");
    c.send("utterance_end");
    await flush(20);
    expect(w.scribe.audioBytes()).toBe(audio);
    expect(w.scribe.sockets).toHaveLength(2);
    expect(c.s.json("transcript").map(m => m.text).at(-1)).toBe("Dritte Äußerung");
    expect(c.s.json("notice")).toHaveLength(2);
    expect(w.logs).toContain("Hören elevenlabs: Fehler (HTTP 401), 0 ms");
    expect(w.logs).toContain("Hören elevenlabs: Gespräch bleibt bei parakeet");
    expect(w.logs.join("\n")).not.toContain("Inhalt");
    expect(w.logs.join("\n")).not.toContain("Äußerung,");
  });

  test("Abbruch während des Parakeet-Rückfalls, zweimal hintereinander: zählt nicht, kein Hinweis, Scribe bleibt", async () => {
    const w = world();
    w.replies.push({ error: "auth_error" }, { error: "auth_error" }, { error: "rate_limited" });
    w.parakeetText.push("hang", "hang", "Dritte Äußerung");
    const c = await session(w);
    for (let i = 0; i < 2; i++) {
      // Scribe scheitert, Parakeet erkennt als Rückfall und hängt; Unterbrechen bricht genau diesen Rückfall ab
      c.speak();
      c.send("utterance_end");
      await flush(20);
      expect(w.counts.warmTranscribes).toBe(i + 1);
      c.send("interrupt");
      await flush(20);
    }
    expect(w.logs.filter(l => l.startsWith("Hören parakeet (geladen): abgebrochen"))).toHaveLength(2);
    expect(c.s.json("transcript")).toEqual([]);
    expect(c.s.json("notice")).toEqual([]);
    expect(c.s.json("error")).toEqual([]);
    expect(w.logs).not.toContain("Hören elevenlabs: Gespräch bleibt bei parakeet");
    // Die dritte Äußerung geht wieder an Scribe; ihr Fehler ist der erste gezählte
    const before = w.scribe.sockets.length;
    c.speak();
    c.send("utterance_end");
    await flush(20);
    expect(w.scribe.sockets.length).toBe(before + 1);
    expect(w.scribe.commits()).toHaveLength(3);
    expect(c.s.json("transcript").map(m => m.text)).toEqual(["Dritte Äußerung"]);
    expect(c.s.json("notice").map(m => m.text)).toEqual([SINGLE]);
  });

  test("schon fertige Pausen-Erkennung mit Rückfall, dann weitere Sprache: zählt nicht, kein Hinweis", async () => {
    const w = world();
    w.replies.push({ error: "rate_limited" }, { error: "rate_limited" });
    w.parakeetText.push("veraltet", "Ich hätte gern ein Schokoeis mit Sahne.", "Wie wird das Wetter morgen in Berlin?");
    const c = await session(w);
    c.speak(5);
    c.send("utterance_pause");
    await flush(20);
    // Rückfall fertig, Ergebnis liegt bereit; der Nutzer spricht weiter
    expect(w.counts.warmTranscribes).toBe(1);
    c.speak(5);
    c.send("utterance_end");
    await flush(20);
    // Scribe bleibt für diese Äußerung gescheitert, Parakeet erkennt die ganze Aufnahme; übernommen ist das der erste Fehler
    expect(c.s.json("transcript").map(m => m.text)).toEqual(["Ich hätte gern ein Schokoeis mit Sahne."]);
    expect(c.s.json("notice").map(m => m.text)).toEqual([SINGLE]);
    await c.finishTurn();
    // Nächster Fehler ist erst der zweite gezählte (der verworfene zählte nicht): jetzt bleibt es bei Parakeet
    c.speak();
    c.send("utterance_end");
    await flush(20);
    expect(c.s.json("transcript").map(m => m.text).at(-1)).toBe("Wie wird das Wetter morgen in Berlin?");
    expect(c.s.json("notice").map(m => m.text)).toEqual([SINGLE, STAY]);
  });

  test("Netzfehler ohne eingerichtetes Parakeet: Fehlersatz der Sitzung, kein Hinweis", async () => {
    const w = world({ parakeet: false });
    w.replies.push("network");
    const c = await session(w);
    c.speak();
    c.send("utterance_end");
    await flush(20);
    expect(c.s.json("transcript")).toEqual([]);
    expect(c.s.json("notice")).toEqual([]);
    expect(c.s.json("error").map(m => m.reason)).toEqual(["erkennung"]);
  });
});
