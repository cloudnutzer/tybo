/**
 * Issue #258, Checkbox 1: Zustandsmaschine des Telefonhörers
 * (src/web/public/call.js) ohne Browser. Attrappen für WebSocket, Mikrofon,
 * AudioContext, beide Worklets, speechSynthesis, Wake Lock und Uhr
 * (tests/call-mode-fixture.ts).
 */
import { describe, expect, test } from "bun:test";
import { deferred, FakeStream } from "./speech-mode-fixture";
import { CALL_RELEASED, CALL_STATUS, callHarness, FakeWebSocket, loadPlayer } from "./call-mode-fixture";

const BROWSER_STATUS = { ...CALL_STATUS, tts: { id: "browser", where: "browser" as const, stream: false } };

describe("Verbinden bis ready", () => {
  test("Tipp: AudioContext im Tipp, Mikrofon mit Echo-Unterdrückung, beide Worklets, WebSocket, start mit dem offenen Gespräch", async () => {
    const h = callHarness();
    expect(h.view()).toMatchObject({ phase: "off", active: false });
    h.mode.start(h.CONVERSATION, CALL_STATUS, "General");
    // Noch im Tipp: AudioContext angelegt und gestartet, Mikrofon angefragt, Verbindung im Aufbau
    expect(h.fakes.contexts).toHaveLength(1);
    expect(h.fakes.contexts[0].resumed).toBe(1);
    expect(h.fakes.mic.calls).toEqual([{ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }]);
    expect(h.sockets()).toHaveLength(1);
    expect(h.ws().url).toBe("wss://tybo.example/api/call");
    expect(h.ws().binaryType).toBe("arraybuffer");
    expect(h.fakes.wake.requests).toBe(1);
    expect(h.view()).toMatchObject({ phase: "connecting", label: "Verbindet …", title: "Telefonhörer", agent: "General", expectation: "Erster Satz nach rund 1,5 Sekunden" });
    await h.flush();
    expect(h.fakes.contexts[0].modulePaths).toEqual(["/speech-worklet.js", "/call-player-worklet.js"]);
    expect(h.vadNode().options.processorOptions).toEqual({ mode: "call" });
    expect(h.playerNode()).toBeDefined();
    // Vor dem Öffnen geht nichts hinaus, danach genau start
    expect(h.ws().sent).toEqual([]);
    h.ws().open();
    expect(h.ws().json()).toEqual([{ type: "start", conversationId: h.CONVERSATION, tts: "server" }]);
    // Vor ready bleibt die Erkennung aus: kein Ton kann hinaus
    expect(h.vad()?.active ?? false).toBe(false);
    await h.emit(h.chunk());
    expect(h.ws().binaries()).toHaveLength(0);
    expect(h.view().label).toBe("Verbindet …");

    h.ws().receive({ type: "ready", model: "claude-sonnet-5-5", via: "api", stt: "parakeet", tts: "server", sampleRate: 24000 });
    h.ws().receive({ type: "state", state: "hoert-zu" });
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "listening", label: "Hört zu", micOpen: true, canMute: true, canHangup: true, duration: "00:00" });
    expect(h.vad()).toMatchObject({ type: "config", active: true, strict: false, startMs: 150, pauseMs: 800 });
    // Die Erwartung bleibt nach ready stehen, bis die erste Äußerung erkannt ist
    expect(h.view().expectation).toBe("Erster Satz nach rund 1,5 Sekunden");
    await h.advance(65_000);
    expect(h.view().duration).toBe("01:05");
    expect(h.seen.ticks).toBe(65);
  });

  test("Browser-Stimme: start mit tts browser, stummes Stück zum Freischalten im Tipp", async () => {
    const h = callHarness();
    await h.start(BROWSER_STATUS);
    expect(h.ws().json()[0]).toEqual({ type: "start", conversationId: h.CONVERSATION, tts: "browser" });
    expect(h.fakes.synth.unlocks).toHaveLength(1);
  });

  test("Rückfall server → browser: die Browser-Stimme ist schon im Tipp freigeschaltet und spricht nach ready", async () => {
    const h = callHarness();
    h.mode.start(h.CONVERSATION, CALL_STATUS, "General");
    // Noch im Tipp, obwohl Ton aus dem Server angefordert ist
    expect(h.fakes.synth.unlocks).toHaveLength(1);
    await h.flush();
    h.ws().open();
    expect(h.ws().json()[0]).toEqual({ type: "start", conversationId: h.CONVERSATION, tts: "server" });
    const ws = h.ws();
    ws.receive({ type: "ready", model: "claude-sonnet-5-5", via: "api", stt: "parakeet", tts: "browser", sampleRate: 24000 });
    ws.receive({ type: "state", state: "hoert-zu" });
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "listening", note: "" });
    await h.utter();
    await h.speaking("Hallo zurück.");
    expect(h.fakes.synth.spoken.map(u => u.text)).toEqual(["Hallo zurück."]);
    // Kein zweites Freischalten nach dem Tipp
    expect(h.fakes.synth.unlocks).toHaveLength(1);
    h.fakes.synth.spoken[0]!.onstart!();
    h.fakes.synth.spoken[0]!.onend!();
    await h.flush();
    expect(ws.json().filter(m => m.type === "played")).toEqual([{ type: "played", id: 1 }]);
    expect(h.view().lines.at(-1)).toEqual({ who: "tybo", text: "Hallo zurück." });
  });

  test("Rückfall server → browser ohne speechSynthesis: Fehler mit verständlichem Satz, alles freigegeben", async () => {
    const h = callHarness({ synth: false });
    // Mit Ton aus dem Server reicht dieser Browser
    expect(h.api.callSupported(h.win, CALL_STATUS)).toBe(true);
    await h.start();
    const ws = h.ws();
    ws.receive({ type: "ready", model: "claude-sonnet-5-5", via: "api", stt: "parakeet", tts: "browser", sampleRate: 24000 });
    ws.receive({ type: "state", state: "hoert-zu" });
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "error", label: "Fehler", note: h.api.CALL_TEXT.noVoiceFallback, canRetry: true, micOpen: false });
    expect(h.view().note).toContain("keine eigene Stimme");
    expect(ws.json().map(m => m.type)).toEqual(["start", "hangup"]);
    expect(ws.closedWith).toBe(1000);
    expect(h.released()).toEqual(CALL_RELEASED);
    // Späte Nachrichten der alten Verbindung ändern nichts mehr
    ws.receive({ type: "sentence", id: 1, text: "Zu spät." });
    await h.flush();
    expect(h.view().phase).toBe("error");
  });

  test("Mikrofon kommt erst nach ready: bis dahin „Verbindet …“, dann Zuhören", async () => {
    const h = callHarness({ microphone: "manual" });
    h.mode.start(h.CONVERSATION, CALL_STATUS, "General");
    await h.flush();
    h.ws().open();
    h.ws().receive({ type: "ready", model: "m", via: "api", stt: "parakeet", tts: "server", sampleRate: 24000 });
    h.ws().receive({ type: "state", state: "hoert-zu" });
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "connecting", micOpen: false });
    h.fakes.mic.pending[0]!.resolve(new FakeStream());
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "listening", micOpen: true });
    expect(h.vad()).toMatchObject({ active: true });
  });

  test("Fähigkeiten: unsicherer Kontext, kein WebSocket, kein audioWorklet, Browser-Stimme ohne speechSynthesis", () => {
    expect(callHarness().api.callSupported(callHarness().win, CALL_STATUS)).toBe(true);
    for (const options of [{ secure: false }, { socket: false }] as const) {
      const h = callHarness(options);
      expect(h.api.callSupported(h.win, CALL_STATUS)).toBe(false);
    }
    const noWorklet = callHarness();
    noWorklet.win.AudioContext = class {};
    expect(noWorklet.api.callSupported(noWorklet.win, CALL_STATUS)).toBe(false);
    const noSynth = callHarness({ synth: false });
    expect(noSynth.api.callSupported(noSynth.win, BROWSER_STATUS)).toBe(false);
    expect(noSynth.api.callSupported(noSynth.win, CALL_STATUS)).toBe(true);
    // MediaRecorder braucht der Telefonhörer nicht
    expect(noSynth.win.MediaRecorder).toBeUndefined();
    // readyCallMode: nur mit modes.call.ready
    const api = callHarness().api;
    expect(api.readyCallMode({ modes: { local: { ready: true } } })).toBeNull();
    expect(api.readyCallMode({ modes: { call: { ...CALL_STATUS, ready: false } } })).toBeNull();
    expect(api.readyCallMode({ modes: { call: CALL_STATUS } })).toEqual(CALL_STATUS);
    expect(api.readyCallMode(null)).toBeNull();
  });
});

describe("kompletter Turn", () => {
  test("Stücke während des Sprechens, utterance_pause, utterance_end, Antwort mit Ton, played erst nach der Wiedergabe", async () => {
    const h = callHarness();
    await h.listening();
    const ws = h.ws();
    await h.emit({ type: "speechstart" });
    expect(h.view().voiceActive).toBe(true);
    await h.emit(h.chunk(100));
    await h.emit(h.chunk(200));
    expect(ws.binaries().map(b => b.byteLength)).toEqual([640, 640]);
    expect(new Int16Array(ws.binaries()[1]!)[0]).toBe(200);
    await h.emit({ type: "pause" });
    await h.emit({ type: "speechend", limit: false });
    expect(ws.types()).toEqual(["start", "pcm", "pcm", "utterance_pause", "utterance_end"]);
    // Bis der Server antwortet, geht nichts mehr hinaus
    expect(h.view()).toMatchObject({ phase: "understanding", label: "Versteht …" });
    expect(h.vad().active).toBe(false);
    await h.emit(h.chunk());
    expect(ws.binaries()).toHaveLength(2);

    ws.receive({ type: "state", state: "versteht" });
    ws.receive({ type: "transcript", text: "Wie geht es dir?" });
    ws.receive({ type: "state", state: "denkt" });
    expect(h.view()).toMatchObject({ phase: "thinking", label: "Denkt …", expectation: "" });
    expect(h.view().lines).toEqual([{ who: "user", text: "Wie geht es dir?" }]);
    ws.receive({ type: "tool", name: "history_search" });
    expect(h.view().step).toBe("schaut nach …");
    ws.receive({ type: "sentence", id: 1, text: "Mir geht es gut." });
    ws.receive({ type: "state", state: "spricht" });
    ws.receive({ type: "audio_begin", id: 1 });
    ws.receiveBinary(960);
    ws.receive({ type: "audio_end", id: 1 });
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "speaking", label: "Spricht", step: "" });
    // Der Satz steht erst da, wenn der Spieler ihn beginnt; audio_end ist noch kein played
    expect(h.view().lines).toHaveLength(1);
    expect(ws.json().filter(m => m.type === "played")).toEqual([]);
    expect(h.player().map(m => m.type)).toEqual(["flush", "begin", "audio", "end"]);
    expect(h.player()[2]).toMatchObject({ rate: 24000 });
    expect(h.player()[2].buffer.byteLength).toBe(960);
    await h.played("begin", 1);
    expect(h.view().lines).toEqual([{ who: "user", text: "Wie geht es dir?" }, { who: "tybo", text: "Mir geht es gut." }]);
    await h.played("played", 1);
    expect(ws.json().filter(m => m.type === "played")).toEqual([{ type: "played", id: 1 }]);
    // Während tybo spricht, bleibt das Mikrofon offen
    expect(h.tracks()[0]!.enabled).toBe(true);
    expect(h.view().micOpen).toBe(true);

    ws.receive({ type: "state", state: "hoert-zu" });
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "listening", label: "Hört zu" });
    expect(h.vad()).toMatchObject({ active: true, strict: false });
  });

  test("Browser-Stimme: Sätze nacheinander mit Stimme und Tempo des Geräts, played nach dem Ende, Anzeige mit dem Beginn", async () => {
    const h = callHarness({ device: { pause: "short", voice: "Anna", rate: 1.2 } });
    await h.listening(BROWSER_STATUS);
    expect(h.vad().pauseMs).toBe(500);
    const ws = h.ws();
    ws.receive({ type: "state", state: "versteht" });
    ws.receive({ type: "transcript", text: "Hallo?" });
    ws.receive({ type: "sentence", id: 1, text: "Hallo." });
    ws.receive({ type: "state", state: "spricht" });
    ws.receive({ type: "sentence", id: 2, text: "Was kann ich tun?" });
    await h.flush();
    expect(h.fakes.synth.spoken.map(u => u.text)).toEqual(["Hallo."]);
    expect(h.fakes.synth.spoken[0]).toMatchObject({ rate: 1.2, lang: "de-DE" });
    expect(h.fakes.synth.spoken[0]!.voice.voiceURI).toBe("Anna");
    // Angezeigt wird erst mit dem Beginn der Wiedergabe (start)
    expect(h.view().lines.at(-1)).toEqual({ who: "user", text: "Hallo?" });
    h.fakes.synth.spoken[0]!.onstart!();
    expect(h.view().lines.at(-1)).toEqual({ who: "tybo", text: "Hallo." });
    h.fakes.synth.spoken[0]!.onend!();
    await h.flush();
    expect(ws.json().filter(m => m.type === "played")).toEqual([{ type: "played", id: 1 }]);
    expect(h.fakes.synth.spoken.map(u => u.text)).toEqual(["Hallo.", "Was kann ich tun?"]);
    expect(h.view().lines.at(-1)).toEqual({ who: "tybo", text: "Hallo." });
    h.fakes.synth.spoken[1]!.onstart!();
    expect(h.view().lines.at(-1)).toEqual({ who: "tybo", text: "Hallo. Was kann ich tun?" });
    // Kein Ton aus dem Server: der Spieler bleibt leer
    expect(h.player().filter(m => m.type !== "flush")).toEqual([]);
  });

  test("Browser-Stimme: verzögerter Start, Anzeige erst mit start; ein zweites start zählt nicht doppelt", async () => {
    const h = callHarness();
    await h.listening(BROWSER_STATUS);
    await h.utter();
    await h.speaking("Ein Satz.");
    const spoken = h.fakes.synth.spoken[0]!;
    await h.advance(1500);
    expect(h.view().lines.map(l => l.text)).toEqual(["Wie geht es dir?"]);
    spoken.onstart!();
    spoken.onstart!();
    expect(h.view().lines.map(l => l.text)).toEqual(["Wie geht es dir?", "Ein Satz."]);
    spoken.onend!();
    await h.flush();
    expect(h.view().lines.map(l => l.text)).toEqual(["Wie geht es dir?", "Ein Satz."]);
    expect(h.ws().json().filter(m => m.type === "played")).toEqual([{ type: "played", id: 1 }]);
  });

  test("Browser-Stimme: Fehler vor dem Start zeigt den Satz nicht und sendet kein played, der nächste Satz folgt", async () => {
    const h = callHarness();
    await h.listening(BROWSER_STATUS);
    await h.utter();
    await h.speaking("Kaputt.");
    h.ws().receive({ type: "sentence", id: 2, text: "Heil." });
    await h.flush();
    const first = h.fakes.synth.spoken[0]!;
    first.onerror!();
    await h.flush();
    // Ein spätes start des gescheiterten Satzes zeigt nichts mehr
    first.onstart!();
    expect(h.view().lines.map(l => l.text)).toEqual(["Wie geht es dir?"]);
    expect(h.ws().json().filter(m => m.type === "played")).toEqual([]);
    expect(h.fakes.synth.spoken.map(u => u.text)).toEqual(["Kaputt.", "Heil."]);
    h.fakes.synth.spoken[1]!.onstart!();
    expect(h.view().lines.map(l => l.text)).toEqual(["Wie geht es dir?", "Heil."]);
  });

  test("Browser-Stimme: Unterbrechen vor dem Start, ein spätes start und end zeigen nichts und senden kein played", async () => {
    const h = callHarness();
    await h.listening(BROWSER_STATUS);
    await h.utter();
    await h.speaking("Nie gehört.");
    const spoken = h.fakes.synth.spoken[0]!;
    h.mode.tap();
    expect(h.ws().types().at(-1)).toBe("interrupt");
    spoken.onstart!();
    spoken.onend!();
    await h.flush();
    expect(h.view().lines.map(l => l.text)).toEqual(["Wie geht es dir?"]);
    expect(h.ws().json().filter(m => m.type === "played")).toEqual([]);
    expect(h.view()).toMatchObject({ phase: "listening" });
  });

  test("„nichts verstanden“ steht als Zeile da, das Gespräch hört weiter zu", async () => {
    const h = callHarness();
    await h.listening();
    await h.utter();
    h.ws().receive({ type: "state", state: "versteht" });
    h.ws().receive({ type: "notice", text: "nichts verstanden" });
    h.ws().receive({ type: "state", state: "hoert-zu" });
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "listening", note: "Nichts verstanden.", tapOnly: false });
  });
});

describe("Stumm", () => {
  test("Spur aus, angefangene Aufnahme verworfen, mute an den Server, Zustand „Stumm“; tybo spricht weiter", async () => {
    const h = callHarness();
    await h.listening();
    const ws = h.ws();
    await h.emit({ type: "speechstart" });
    await h.emit(h.chunk());
    const epoch = h.vad().epoch;
    h.mode.mute(true);
    expect(h.tracks()[0]!.enabled).toBe(false);
    expect(h.tracks()[0]!.stopped).toBe(false);
    expect(ws.json().at(-1)).toEqual({ type: "mute", on: true });
    expect(h.vad()).toMatchObject({ active: false, reset: true });
    expect(h.vad().epoch).toBeGreaterThan(epoch);
    expect(h.view()).toMatchObject({ label: "Stumm", muted: true, micOpen: false });
    // Späte Stücke der alten Laufnummer gehen nicht hinaus
    h.vadNode().port.onmessage({ data: { epoch, ...h.chunk() } });
    await h.emit({ type: "speechend" });
    expect(ws.binaries()).toHaveLength(1);
    expect(ws.types().includes("utterance_end")).toBe(false);
    // tybo spricht weiter, die Erkennung bleibt aus
    await h.speaking();
    expect(h.view()).toMatchObject({ phase: "speaking", label: "Spricht" });
    expect(h.vad().active).toBe(false);
    ws.receive({ type: "state", state: "hoert-zu" });
    await h.flush();
    expect(h.view().label).toBe("Stumm");
    h.mode.mute(false);
    expect(h.tracks()[0]!.enabled).toBe(true);
    expect(ws.json().at(-1)).toEqual({ type: "mute", on: false });
    expect(h.view()).toMatchObject({ label: "Hört zu", micOpen: true });
    expect(h.vad().active).toBe(true);
  });

  test("Stumm vor ready: kein mute vor ready (Protokollfehler), danach nachgeholt", async () => {
    const h = callHarness();
    await h.start();
    h.mode.mute(true);
    expect(h.ws().types()).toEqual(["start"]);
    h.ws().receive({ type: "ready", model: "m", via: "api", stt: "parakeet", tts: "server", sampleRate: 24000 });
    expect(h.ws().json().at(-1)).toEqual({ type: "mute", on: true });
  });
});

describe("Unterbrechen", () => {
  test("Antippen während „Spricht“: Wiedergabe sofort leer, interrupt, wieder Zuhören; Spätes aus dem alten Turn verfällt", async () => {
    const h = callHarness();
    await h.listening();
    await h.utter();
    await h.speaking("Erster Satz.");
    const ws = h.ws();
    ws.receive({ type: "audio_begin", id: 1 });
    ws.receiveBinary(960);
    await h.played("begin", 1);
    const oldEpoch = h.player().filter(m => m.type === "flush").at(-1).epoch;
    expect(h.view().tappable).toBe(true);
    h.mode.tap();
    // Leeren mit neuer Laufnummer, interrupt an den Server
    const flush = h.player().filter(m => m.type === "flush").at(-1);
    expect(flush.epoch).toBeGreaterThan(oldEpoch);
    expect(ws.json().at(-1)).toEqual({ type: "interrupt" });
    expect(h.view()).toMatchObject({ phase: "listening", label: "Hört zu" });
    expect(h.vad()).toMatchObject({ active: true, strict: false });
    const commands = h.player().length;
    // Was vom abgebrochenen Turn noch unterwegs ist: kein Satz, kein Ton, kein played
    ws.receiveBinary(960);
    ws.receive({ type: "audio_end", id: 1 });
    ws.receive({ type: "sentence", id: 2, text: "Zweiter Satz." });
    ws.receive({ type: "audio_begin", id: 2 });
    ws.receiveBinary(960);
    await h.played("played", 1, oldEpoch);
    expect(h.player()).toHaveLength(commands);
    expect(ws.json().filter(m => m.type === "played")).toEqual([]);
    expect(h.view().lines.map(l => l.text)).toEqual(["Wie geht es dir?", "Erster Satz."]);
    // Die neue Äußerung geht nach dem interrupt hinaus
    await h.emit({ type: "speechstart" });
    await h.emit(h.chunk());
    const types = ws.types();
    expect(types.lastIndexOf("interrupt")).toBeLessThan(types.lastIndexOf("pcm"));
    // Ab „hört zu“ des Servers gehört alles zum nächsten Turn
    ws.receive({ type: "state", state: "hoert-zu" });
    await h.emit({ type: "speechend" });
    ws.receive({ type: "state", state: "versteht" });
    ws.receive({ type: "transcript", text: "Und morgen?" });
    ws.receive({ type: "sentence", id: 3, text: "Morgen auch." });
    ws.receive({ type: "audio_begin", id: 3 });
    await h.flush();
    expect(h.player().at(-1)).toEqual({ type: "begin", id: 3 });
  });

  test("Unterbrechen während „Versteht“: verspätetes transcript, denkt, sentence, spricht, audio_begin und Ton verfallen bis „hört zu“; die neue Aufnahme bleibt", async () => {
    const h = callHarness();
    await h.listening();
    await h.utter();
    const ws = h.ws();
    expect(h.view().phase).toBe("understanding");
    h.mode.tap();
    expect(ws.types().at(-1)).toBe("interrupt");
    expect(h.view().phase).toBe("listening");
    // Der Nutzer spricht schon wieder
    await h.emit({ type: "speechstart" });
    await h.emit(h.chunk());
    const epoch = h.vad().epoch;
    const configs = h.vadNode().port.posted.filter((m: any) => m.type === "config").length;
    const commands = h.player().length;
    const lines = h.view().lines.length;
    // Alles aus dem abgebrochenen Turn, das der Server vor dem interrupt schon geschickt hatte
    ws.receive({ type: "state", state: "versteht" });
    ws.receive({ type: "transcript", text: "Alte Frage" });
    ws.receive({ type: "state", state: "denkt" });
    ws.receive({ type: "tool", name: "suche" });
    ws.receive({ type: "sentence", id: 1, text: "Alte Antwort." });
    ws.receive({ type: "state", state: "spricht" });
    ws.receive({ type: "audio_begin", id: 1 });
    ws.receiveBinary(960);
    ws.receive({ type: "audio_end", id: 1 });
    await h.flush();
    // Keine alte Ausgabe, keine alte Zeile, kein Zustandswechsel
    expect(h.player()).toHaveLength(commands);
    expect(h.view().lines).toHaveLength(lines);
    expect(h.view()).toMatchObject({ phase: "listening", label: "Hört zu", voiceActive: true, step: "" });
    // Die neue Aufnahme läuft unverändert weiter: keine neue Einstellung, gleiche Laufnummer
    expect(h.vadNode().port.posted.filter((m: any) => m.type === "config")).toHaveLength(configs);
    expect(h.vad()).toMatchObject({ active: true, epoch });
    await h.emit(h.chunk());
    expect(ws.types().at(-1)).toBe("pcm");
    // Der Server bestätigt das Unterbrechen: die Aufnahme bleibt, ab hier gilt alles
    ws.receive({ type: "state", state: "hoert-zu" });
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "listening", voiceActive: true });
    expect(h.vadNode().port.posted.filter((m: any) => m.type === "config")).toHaveLength(configs);
    await h.emit({ type: "pause" });
    await h.emit({ type: "speechend" });
    expect(ws.types().slice(-2)).toEqual(["utterance_pause", "utterance_end"]);
    ws.receive({ type: "state", state: "versteht" });
    ws.receive({ type: "transcript", text: "Neue Frage" });
    ws.receive({ type: "state", state: "denkt" });
    ws.receive({ type: "sentence", id: 2, text: "Neue Antwort." });
    ws.receive({ type: "state", state: "spricht" });
    ws.receive({ type: "audio_begin", id: 2 });
    ws.receiveBinary(960);
    await h.flush();
    expect(h.player().slice(commands).map(m => m.type)).toEqual(["begin", "audio"]);
    expect(h.player().at(-2)).toEqual({ type: "begin", id: 2 });
    await h.played("begin", 2);
    expect(h.view().lines.map(l => l.text)).toEqual(["Neue Frage", "Neue Antwort."]);
    expect(h.view().phase).toBe("speaking");
  });

  test("Bestätigung „hört zu“ kommt erst, als die neue Äußerung schon hinaus ist: „Versteht …“ bleibt, der neue Turn gilt", async () => {
    const h = callHarness();
    await h.listening();
    await h.utter();
    await h.speaking("Alt.");
    const ws = h.ws();
    h.mode.tap();
    await h.utter();
    expect(ws.types().slice(-2)).toEqual(["utterance_pause", "utterance_end"]);
    expect(h.view().phase).toBe("understanding");
    ws.receive({ type: "sentence", id: 2, text: "Noch alt." });
    ws.receive({ type: "state", state: "hoert-zu" });
    await h.flush();
    expect(h.view().phase).toBe("understanding");
    expect(h.vad().active).toBe(false);
    ws.receive({ type: "state", state: "versteht" });
    ws.receive({ type: "transcript", text: "Neu?" });
    ws.receive({ type: "state", state: "denkt" });
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "thinking" });
    expect(h.view().lines.map(l => l.text)).toEqual(["Wie geht es dir?", "Neu?"]);
  });

  test("Leertaste bzw. Antippen beim Denken unterbricht ebenfalls; beim Zuhören passiert nichts", async () => {
    const h = callHarness();
    await h.listening();
    h.mode.tap();
    expect(h.ws().types()).not.toContain("interrupt");
    await h.utter();
    h.ws().receive({ type: "state", state: "denkt" });
    h.mode.tap();
    expect(h.ws().types().at(-1)).toBe("interrupt");
    expect(h.view().phase).toBe("listening");
  });

  test("Browser-Stimme: Antippen bricht speechSynthesis ab, ein spätes end sendet kein played", async () => {
    const h = callHarness();
    await h.listening(BROWSER_STATUS);
    await h.utter();
    await h.speaking("Ein Satz.");
    const spoken = h.fakes.synth.spoken[0]!;
    const cancelled = h.fakes.synth.cancelled;
    h.mode.tap();
    expect(h.fakes.synth.cancelled).toBeGreaterThan(cancelled);
    spoken.onend!();
    await h.flush();
    expect(h.ws().json().filter(m => m.type === "played")).toEqual([]);
  });

  // Ersatzstimme im Server-Gespräch (speak_browser, Issue #276): spricht gerade, ein zweiter Satz wartet
  async function speakingBrowserFallback() {
    const h = callHarness();
    await h.listening();
    await h.utter();
    await h.speaking("Erster Satz.");
    h.ws().receive({ type: "audio_begin", id: 1 });
    h.ws().receive({ type: "speak_browser", id: 1, text: "Erster Satz." });
    h.ws().receive({ type: "sentence", id: 2, text: "Zweiter Satz." });
    h.ws().receive({ type: "speak_browser", id: 2, text: "Zweiter Satz." });
    await h.flush();
    expect(h.mode.state.ttsActual).toBe("server");
    expect(h.fakes.synth.spoken.map(u => u.text)).toEqual(["Erster Satz."]);
    return h;
  }

  async function expectSilentAfter(h: ReturnType<typeof callHarness>, stop: () => void) {
    const spoken = h.fakes.synth.spoken[0]!;
    const cancelled = h.fakes.synth.cancelled;
    stop();
    expect(h.fakes.synth.cancelled).toBeGreaterThan(cancelled);
    // Spätes end, Wächter und Frist: kein played, der wartende Satz startet nicht
    spoken.onend!();
    await h.advance(60_000);
    await h.flush();
    expect(h.ws().json().filter(m => m.type === "played")).toEqual([]);
    expect(h.fakes.synth.spoken.map(u => u.text)).toEqual(["Erster Satz."]);
  }

  test("Ersatzstimme im Server-Gespräch: Antippen bricht speechSynthesis ab, kein spätes played", async () => {
    const h = await speakingBrowserFallback();
    await expectSilentAfter(h, () => h.mode.tap());
    expect(h.ws().types()).toContain("interrupt");
  });

  test("Ersatzstimme im Server-Gespräch: Auflegen bricht speechSynthesis ab, kein spätes played", async () => {
    const h = await speakingBrowserFallback();
    await expectSilentAfter(h, () => h.mode.hangUp());
    expect(h.view().phase).toBe("off");
  });

  test("Ersatzstimme im Server-Gespräch: Erkennung aus, Sprechbeginn unterbricht nicht; danach Server-Ton wieder per Stimme", async () => {
    const h = await speakingBrowserFallback();
    // Die Browser-Stimme geht an der Echo-Unterdrückung vorbei: sie darf sich nicht selbst abbrechen
    expect(h.vad().active).toBe(false);
    await h.emit({ type: "speechstart" });
    expect(h.ws().types()).not.toContain("interrupt");
    expect(h.view().phase).toBe("speaking");
    // Beide Sätze gesprochen: Erkennung wieder streng an
    h.fakes.synth.spoken[0]!.onend!();
    await h.flush();
    expect(h.vad().active).toBe(false);
    h.fakes.synth.spoken[1]!.onend!();
    await h.flush();
    expect(h.ws().json().filter(m => m.type === "played")).toEqual([{ type: "played", id: 1 }, { type: "played", id: 2 }]);
    expect(h.vad()).toMatchObject({ active: true, strict: true });
    // Spätere Ausgabe aus dem Server: per Stimme unterbrechbar wie eingestellt
    h.ws().receive({ type: "sentence", id: 3, text: "Dritter Satz." });
    h.ws().receive({ type: "audio_begin", id: 3 });
    await h.flush();
    await h.emit({ type: "speechstart" });
    expect(h.ws().types().at(-1)).toBe("interrupt");
    expect(h.view().phase).toBe("listening");
  });

  test("Ersatzstimme im Server-Gespräch: Antippen unterbricht weiterhin", async () => {
    const h = await speakingBrowserFallback();
    expect(h.vad().active).toBe(false);
    h.mode.tap();
    expect(h.ws().types().at(-1)).toBe("interrupt");
    expect(h.view().phase).toBe("listening");
    expect(h.vad()).toMatchObject({ active: true, strict: false });
  });

  test("Ersatzstimme im Server-Gespräch ohne speechSynthesis: Fehler mit verständlichem Satz, hangup, kein spätes played", async () => {
    const h = callHarness({ synth: false });
    await h.listening();
    await h.utter();
    await h.speaking("Erster Satz.");
    const ws = h.ws();
    ws.receive({ type: "audio_begin", id: 1 });
    ws.receive({ type: "speak_browser", id: 1, text: "Erster Satz." });
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "error", note: h.api.CALL_TEXT.noVoiceFallback, canRetry: true, micOpen: false });
    expect(ws.types()).toContain("hangup");
    expect(ws.closedWith).toBe(1000);
    expect(h.released()).toEqual(CALL_RELEASED);
    // Späte Meldungen von Spieler und Server ändern nichts mehr
    await h.played("played", 1);
    ws.receive({ type: "speak_browser", id: 2, text: "Zu spät." });
    await h.advance(60_000);
    await h.flush();
    expect(ws.json().filter(m => m.type === "played")).toEqual([]);
    expect(h.view().phase).toBe("error");
  });

  test("per Stimme: während „Spricht“ strenge Schwelle mit 300 ms; Sprechbeginn unterbricht, interrupt vor dem ersten Stück, die Äußerung läuft weiter", async () => {
    const h = callHarness();
    await h.listening();
    await h.utter();
    await h.speaking();
    expect(h.vad()).toMatchObject({ active: true, strict: true, startMs: 300 });
    const epoch = h.vad().epoch;
    await h.emit({ type: "speechstart" });
    expect(h.ws().types().at(-1)).toBe("interrupt");
    expect(h.player().at(-1).type).toBe("flush");
    // Gleiche Laufnummer, Schwelle normal, nichts verworfen
    expect(h.vad()).toMatchObject({ active: true, strict: false, keep: true, reset: false, epoch });
    expect(h.view()).toMatchObject({ phase: "listening", voiceActive: true });
    await h.emit(h.chunk());
    await h.emit({ type: "speechend" });
    expect(h.ws().types().slice(-3)).toEqual(["interrupt", "pcm", "utterance_end"]);
  });

  test("per Stimme aus: Browser-Stimme (an der Echo-Unterdrückung vorbei) und Einstellung „nur Antippen“", async () => {
    const browser = callHarness();
    await browser.listening(BROWSER_STATUS);
    await browser.utter();
    await browser.speaking();
    expect(browser.vad().active).toBe(false);
    expect(browser.view().micOpen).toBe(true);
    await browser.emit({ type: "speechstart" });
    expect(browser.ws().types()).not.toContain("interrupt");

    const tapOnly = callHarness({ callDevice: { bargeIn: "tap" } });
    await tapOnly.listening();
    await tapOnly.utter();
    await tapOnly.speaking();
    expect(tapOnly.vad().active).toBe(false);
    tapOnly.mode.tap();
    expect(tapOnly.ws().types().at(-1)).toBe("interrupt");
  });

  test("Selbstschutz: zweimal hintereinander „nichts verstanden“ nach Unterbrechen per Stimme schaltet auf „nur Antippen“", async () => {
    const h = callHarness();
    await h.listening();
    const bargeAndNothing = async () => {
      await h.utter();
      await h.speaking();
      await h.emit({ type: "speechstart" });
      await h.emit(h.chunk());
      await h.emit({ type: "speechend" });
      h.ws().receive({ type: "state", state: "versteht" });
      h.ws().receive({ type: "notice", text: "nichts verstanden" });
      h.ws().receive({ type: "state", state: "hoert-zu" });
      await h.flush();
    };
    await bargeAndNothing();
    expect(h.view().tapOnly).toBe(false);
    await bargeAndNothing();
    expect(h.view()).toMatchObject({ tapOnly: true, note: h.api.CALL_TEXT.tapOnly });
    // Ab jetzt hört die Erkennung während „Spricht“ nicht mehr zu; Antippen geht weiter
    await h.utter();
    await h.speaking();
    expect(h.vad().active).toBe(false);
    h.mode.tap();
    expect(h.ws().types().at(-1)).toBe("interrupt");
    // Nur für dieses Gespräch: die Einstellung des Geräts bleibt
    expect(h.api.readCallDevice(h.fakes.storage).bargeIn).toBe("voice");
  });

  test("Ein erkanntes Unterbrechen per Stimme setzt den Zähler zurück", async () => {
    const h = callHarness();
    await h.listening();
    for (const outcome of ["nothing", "heard", "nothing"]) {
      await h.utter();
      await h.speaking();
      await h.emit({ type: "speechstart" });
      await h.emit({ type: "speechend" });
      h.ws().receive({ type: "state", state: "versteht" });
      if (outcome === "nothing") h.ws().receive({ type: "notice", text: "nichts verstanden" });
      else h.ws().receive({ type: "transcript", text: "Moment" });
      h.ws().receive({ type: "state", state: "hoert-zu" });
      await h.flush();
    }
    expect(h.view().tapOnly).toBe(false);
  });
});

describe("Verbindung weg, Ende, Fehler", () => {
  test("Netzabbruch nach ready: „Verbindung weg“, genau ein neuer Versuch als neues start, alte Ausgabe verworfen", async () => {
    const h = callHarness();
    await h.listening();
    await h.utter();
    await h.speaking();
    const first = h.ws();
    first.drop(1006);
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "lost", label: "Verbindung weg" });
    expect(h.player().at(-1).type).toBe("flush");
    expect(h.vad().active).toBe(false);
    // Der Strom bleibt offen
    expect(h.tracks()[0]!.stopped).toBe(false);
    expect(h.sockets()).toHaveLength(1);
    await h.advance(1000);
    expect(h.sockets()).toHaveLength(2);
    h.ws().open();
    expect(h.ws().json()).toEqual([{ type: "start", conversationId: h.CONVERSATION, tts: "server" }]);
    // Späte Meldungen der alten Verbindung gelten nicht
    first.receive({ type: "state", state: "spricht" });
    expect(h.view().phase).toBe("lost");
    h.ws().receive({ type: "ready", model: "m", via: "api", stt: "parakeet", tts: "server", sampleRate: 24000 });
    h.ws().receive({ type: "state", state: "hoert-zu" });
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "listening", note: "Wieder verbunden." });
    expect(h.vad().active).toBe(true);
    // Ein zweiter Abbruch: kein weiterer Versuch, Aufgelegt mit Grund
    h.ws().drop(1006);
    await h.advance(5000);
    expect(h.sockets()).toHaveLength(2);
    expect(h.view()).toMatchObject({ phase: "ended", label: "Aufgelegt", note: "Die Verbindung ist abgerissen.", canRetry: true });
    expect(h.released()).toEqual(CALL_RELEASED);
  });

  test("Der neue Versuch wird nicht bereit: nach der Frist Aufgelegt", async () => {
    const h = callHarness();
    await h.listening();
    h.ws().drop(1006);
    await h.advance(1000);
    h.ws().open();
    await h.advance(15_000);
    expect(h.view()).toMatchObject({ phase: "ended", note: "Die Verbindung ist abgerissen." });
    expect(h.ws().json().at(-1)).toEqual({ type: "hangup" });
    expect(h.released()).toEqual(CALL_RELEASED);
  });

  test("Endgültige Gründe ohne neuen Versuch: ended budget, besetzt, zu viele, Abbruch vor ready", async () => {
    const budget = callHarness();
    await budget.listening();
    budget.ws().receive({ type: "ended", reason: "budget", seconds: 75 });
    budget.ws().drop(1000);
    await budget.advance(5000);
    expect(budget.sockets()).toHaveLength(1);
    expect(budget.view()).toMatchObject({ phase: "ended", note: "Das Tagesbudget für Sprache ist aufgebraucht.", duration: "01:15" });
    expect(budget.released()).toEqual(CALL_RELEASED);

    const busy = callHarness();
    await busy.start();
    busy.ws().drop(4409);
    await busy.advance(5000);
    expect(busy.view()).toMatchObject({ phase: "error", label: "Fehler", note: busy.api.CALL_TEXT.busy, canRetry: true });
    expect(busy.sockets()).toHaveLength(1);

    const many = callHarness();
    await many.start();
    many.ws().drop(4029);
    expect(many.view().note).toBe(many.api.CALL_TEXT.tooMany);

    const early = callHarness();
    await early.start();
    early.ws().drop(1006);
    await early.advance(5000);
    expect(early.view()).toMatchObject({ phase: "error", note: early.api.CALL_TEXT.connectFailed });
    expect(early.sockets()).toHaveLength(1);
    expect(early.released()).toEqual(CALL_RELEASED);
  });

  test("Start scheitert beim Server: Satz des Servers und „Noch einmal“ startet neu (aus einem Tipp)", async () => {
    const h = callHarness();
    await h.start();
    h.ws().receive({ type: "error", reason: "kein-erkenner", message: "Kein Erkenner bereit." });
    h.ws().receive({ type: "ended", reason: "start", seconds: 0 });
    h.ws().drop(1000);
    expect(h.view()).toMatchObject({ phase: "error", note: "Kein Erkenner bereit.", canRetry: true, canHangup: false });
    expect(h.released()).toEqual(CALL_RELEASED);
    h.mode.retry();
    expect(h.view().phase).toBe("connecting");
    expect(h.sockets()).toHaveLength(2);
    expect(h.fakes.contexts).toHaveLength(2);
    await h.flush();
    h.ws().open();
    expect(h.ws().json()[0]).toMatchObject({ type: "start", conversationId: h.CONVERSATION });
  });

  test("Fehler im Gespräch (Erkennen, Modell, Stimme): Zeile, das Gespräch läuft weiter", async () => {
    const h = callHarness();
    await h.listening();
    h.ws().receive({ type: "error", reason: "modell" });
    expect(h.view()).toMatchObject({ phase: "listening", note: "Das Modell hat nicht geantwortet." });
  });

  test("Abgemeldet (ended abgemeldet oder Code 4001): auflegen und zur Anmeldung", async () => {
    const a = callHarness();
    await a.listening();
    a.ws().receive({ type: "ended", reason: "abgemeldet", seconds: 3 });
    expect(a.seen.unauthorized).toBe(1);
    expect(a.view().phase).toBe("off");
    expect(a.released()).toEqual(CALL_RELEASED);
    const b = callHarness();
    await b.listening();
    b.ws().drop(4001);
    expect(b.seen.unauthorized).toBe(1);
    expect(b.view().phase).toBe("off");
  });
});

describe("Auflegen gibt alles frei", () => {
  test("hangup, Verbindung zu, alle Spuren gestoppt, AudioContext zu, Wake Lock frei, keine Zeitgeber", async () => {
    const h = callHarness();
    await h.listening();
    await h.advance(3000);
    expect(h.fakes.wake.sentinels).toHaveLength(1);
    h.mode.hangUp();
    expect(h.ws().json().at(-1)).toEqual({ type: "hangup" });
    expect(h.ws().closedWith).toBe(1000);
    expect(h.vadNode().port.posted.at(-1)).toEqual({ type: "close" });
    expect(h.playerNode().port.posted.at(-1)).toEqual({ type: "close" });
    expect(h.view()).toMatchObject({ phase: "off", active: false });
    expect(h.released()).toEqual(CALL_RELEASED);
    // Späte Meldungen nach dem Auflegen ändern nichts
    h.ws().onmessage?.({ data: JSON.stringify({ type: "state", state: "spricht" }) });
    expect(h.view().phase).toBe("off");
  });

  test("Zweites Gespräch nach dem Auflegen: der neue Spieler bekommt die laufende Nummer, Satzanzeige und played gehen", async () => {
    const h = callHarness();
    await h.listening();
    h.mode.hangUp();
    await h.listening();
    // Gleich nach dem Anlegen: flush mit der Nummer der Zustandsmaschine
    expect(h.player()[0]).toEqual({ type: "flush", epoch: h.mode.state.playEpoch });
    await h.utter();
    await h.speaking("Zweites Gespräch.");
    h.ws().receive({ type: "audio_begin", id: 1 });
    h.ws().receive({ type: "audio_end", id: 1 });
    await h.played("begin", 1);
    await h.played("played", 1);
    expect(h.view().lines.at(-1)).toEqual({ who: "tybo", text: "Zweites Gespräch." });
    expect(h.ws().json().filter(m => m.type === "played")).toEqual([{ type: "played", id: 1 }]);
  });

  test("Mikrofonfreigabe kommt erst nach dem Auflegen: der Strom wird sofort gestoppt, nichts startet", async () => {
    const h = callHarness({ microphone: "manual" });
    h.mode.start(h.CONVERSATION, CALL_STATUS, "General");
    await h.flush();
    h.mode.hangUp();
    const late = new FakeStream();
    h.fakes.mic.pending[0]!.resolve(late);
    await h.flush();
    expect(late.tracks[0]!.stopped).toBe(true);
    expect(h.vadNode()).toBeUndefined();
    expect(h.view().phase).toBe("off");
    expect(h.released()).toEqual(CALL_RELEASED);
  });

  test("Mikrofon verweigert: Satz zum Mikrofon, Verbindung zu, nichts gesendet außer start und hangup", async () => {
    const h = callHarness({ microphone: "deny" });
    h.mode.start(h.CONVERSATION, CALL_STATUS, "General");
    h.ws().open();
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "error", note: "Mikrofon: NotAllowedError", canRetry: true });
    expect(h.ws().types()).toEqual(["start", "hangup"]);
    expect(h.released()).toEqual(CALL_RELEASED);
  });

  test("Worklet lässt sich nicht laden: Fehler, alles frei", async () => {
    const h = callHarness({ module: "fail" });
    h.mode.start(h.CONVERSATION, CALL_STATUS, "General");
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "error", note: h.api.CALL_TEXT.micFailed });
    expect(h.released()).toEqual(CALL_RELEASED);
  });

  test("Mikrofon fällt weg (Spur endet): Fehler", async () => {
    const h = callHarness();
    await h.listening();
    h.tracks()[0]!.onended!();
    expect(h.view()).toMatchObject({ phase: "error", note: h.api.CALL_TEXT.micLost });
    expect(h.released()).toEqual(CALL_RELEASED);
  });

  test("Hintergrund: hält der Browser den Ton an, legt tybo auf und sagt es", async () => {
    const h = callHarness();
    await h.listening();
    const context = h.fakes.contexts[0];
    h.mode.visibility(false);
    expect(h.view().phase).toBe("listening");
    context.state = "interrupted";
    context.onstatechange();
    expect(h.view()).toMatchObject({ phase: "ended", note: "Gespräch beendet, weil die App im Hintergrund war." });
    expect(h.ws().json().at(-1)).toEqual({ type: "hangup" });
    expect(h.released()).toEqual(CALL_RELEASED);
  });

  test("Hintergrund ohne Anhalten (Android, Desktop): das Gespräch läuft weiter; zurück im Vordergrund mit stehendem Ton: auflegen", async () => {
    const h = callHarness();
    await h.listening();
    h.fakes.contexts[0].state = "running";
    h.mode.visibility(false);
    h.mode.visibility(true);
    expect(h.view().phase).toBe("listening");
    h.mode.visibility(false);
    h.fakes.contexts[0].state = "suspended";
    h.mode.visibility(true);
    expect(h.view().note).toBe("Gespräch beendet, weil die App im Hintergrund war.");
  });

  test("Wake Lock: im Tipp angefragt, späte Zusage nach dem Auflegen sofort frei", async () => {
    const h = callHarness({ wakeAuto: false });
    h.mode.start(h.CONVERSATION, CALL_STATUS, "General");
    expect(h.fakes.wake.requests).toBe(1);
    h.mode.hangUp();
    const lock = h.fakes.wake.sentinel();
    h.fakes.wake.pending[0]!.resolve(lock);
    await h.flush();
    expect(lock.released).toBe(true);
  });
});

describe("Hinweise und Einstellungen pro Gerät", () => {
  test("Kopfhörer-Hinweis einmal pro Gerät, bis „Verstanden“", async () => {
    const h = callHarness();
    await h.listening();
    expect(h.view().hint).toBe(true);
    h.mode.acknowledgeHint();
    expect(h.view().hint).toBe(false);
    expect(JSON.parse(h.fakes.stored.get("tybo-call-device")!)).toMatchObject({ hintSeen: true });
    // Getrennt von den Einstellungen des Sprechmodus
    expect(h.fakes.stored.has("tybo-speech-device")).toBe(false);
    h.mode.hangUp();
    await h.listening();
    expect(h.view().hint).toBe(false);
  });

  test("iPhone-App: der Satz zur Mikrofon-Nachfrage steht einmal unter „Verbindet …“, kein Fehler", async () => {
    const h = callHarness({ ios: true });
    expect(h.api.callIosApp(h.win)).toBe(true);
    h.mode.start(h.CONVERSATION, CALL_STATUS, "General");
    expect(h.view()).toMatchObject({ phase: "connecting", note: h.api.CALL_TEXT.iosMic });
    h.mode.hangUp();
    h.mode.start(h.CONVERSATION, CALL_STATUS, "General");
    expect(h.view().note).toBe("");
    expect(callHarness().api.callIosApp(callHarness().win)).toBe(false);
  });

  test("readCallDevice: Standard, kaputter Inhalt, kein Speicher", () => {
    const { api } = callHarness();
    expect(api.readCallDevice(null)).toEqual({ bargeIn: "voice", hintSeen: false, iosHintSeen: false });
    expect(api.readCallDevice({ getItem: () => "{kaputt" })).toEqual({ bargeIn: "voice", hintSeen: false, iosHintSeen: false });
    expect(api.readCallDevice({ getItem: () => { throw new Error("gesperrt"); } })).toEqual({ bargeIn: "voice", hintSeen: false, iosHintSeen: false });
    expect(api.readCallDevice({ getItem: () => JSON.stringify({ bargeIn: "tap", hintSeen: true, extra: 1 }) })).toEqual({ bargeIn: "tap", hintSeen: true, iosHintSeen: false });
    expect(api.writeCallDevice(null, { bargeIn: "tap" })).toBe(false);
    expect(api.callClock(3_725_000)).toBe("62:05");
  });

  test("Abschnitt im Reiter „Sprechen“: Umschalter schreibt sofort nur in localStorage", () => {
    const h = callHarness();
    const made: any[] = [];
    const hFn = (tag: string, props: any = {}, children: any[] = []) => {
      const n = { tag, props, children, listeners: {} as Record<string, (e?: any) => void>, addEventListener(t: string, f: () => void) { this.listeners[t] = f; } };
      made.push(n);
      return n;
    };
    let renders = 0;
    let picked: ((v: string) => void) | null = null;
    const settings = h.api.createCallDeviceSettings({
      storage: h.fakes.storage,
      render: () => void renders++,
      h: hFn,
      sectionNode: (id: string, title: string, hints: string[], children: any[]) => ({ id, title, hints, children }),
      segment: (_h: unknown, labelId: string, _p: string, choices: any[], value: string, disabled: boolean, pick: (v: string) => void) => {
        picked = pick;
        return { labelId, choices, value, disabled };
      },
    });
    const [section] = settings.nodes();
    expect(section).toMatchObject({ id: "call-device", title: "Telefonhörer auf diesem Gerät" });
    const segment = section.children[0].children[1].children[0];
    expect(segment).toMatchObject({ labelId: "call-device-barge", value: "voice", disabled: false });
    expect(segment.choices.map((c: any) => c.label)).toEqual(["Per Stimme und Antippen", "Nur Antippen"]);
    picked!("tap");
    expect(renders).toBe(1);
    expect(h.api.readCallDevice(h.fakes.storage).bargeIn).toBe("tap");
    // Ohne Speicher: Hinweis und gesperrt
    const none = h.api.createCallDeviceSettings({ storage: null, h: hFn, sectionNode: (id: string, t: string, hi: string[], children: any[]) => ({ children }), segment: (...a: any[]) => ({ disabled: a[5] }) });
    const children = none.nodes()[0].children;
    expect(children[0].props["data-call-device"]).toBe("no-storage");
    expect(children[1].children[1].children[0].disabled).toBe(true);
    void made;
    void deferred;
    void FakeWebSocket;
  });
});

describe("Werkzeuge und Freigaben (Issue #259)", () => {
  test("Suche zeigt „schaut nach …“, Rechnen und Denkauftrag bleiben bei „Denkt …“", async () => {
    const h = callHarness();
    await h.listening();
    const ws = h.ws();
    await h.emit({ type: "speechstart" });
    await h.emit(h.chunk());
    await h.emit({ type: "speechend", limit: false });
    ws.receive({ type: "state", state: "versteht" });
    ws.receive({ type: "transcript", text: "Wie viel sind 18 Prozent von 2.450?" });
    ws.receive({ type: "state", state: "denkt" });
    ws.receive({ type: "tool", name: "rechne" });
    expect(h.view()).toMatchObject({ label: "Denkt …", step: "" });
    ws.receive({ type: "tool", name: "denkauftrag" });
    expect(h.view().step).toBe("");
    ws.receive({ type: "tool", name: "suche" });
    expect(h.view().step).toBe("schaut nach …");
  });

  test("approval: geprüfte Freigaben in der Ansicht, ungültige fallen weg, leere Liste räumt, Auflegen auch", async () => {
    const h = callHarness();
    await h.listening();
    const ws = h.ws();
    expect(h.view().approvals).toEqual([]);
    ws.receive({
      type: "approval",
      choices: [
        { id: "abc123", options: [{ key: "ok", label: "Freigeben" }, { key: "no", label: "Ablehnen" }] },
        { id: "<script>", options: [{ key: "ok", label: "x" }] },
        { id: "def456", options: [{ key: "bad key!", label: "x" }] },
        { id: "ghi789" },
      ],
    });
    expect(h.view().approvals).toEqual([{ id: "abc123", options: [{ key: "ok", label: "Freigeben" }, { key: "no", label: "Ablehnen" }] }]);
    // Der Browser schickt dafür nichts an den Server: entschieden wird nur per Knopf in der Ansicht
    expect(ws.types()).toEqual(["start"]);
    ws.receive({ type: "approval", choices: [] });
    expect(h.view().approvals).toEqual([]);
    ws.receive({ type: "approval", choices: [{ id: "abc123", options: [{ key: "ok", label: "Freigeben" }] }] });
    h.mode.hangUp();
    expect(h.view().approvals).toEqual([]);
  });
});

describe("Audio-Sitzung (Issue #280)", () => {
  /** Wert von navigator.audioSession.type, als AudioContext und Mikrofon angefragt wurden */
  function watchOrder(h: ReturnType<typeof callHarness>) {
    const seen: { context: string[]; mic: string[] } = { context: [], mic: [] };
    const Context = h.win.AudioContext;
    h.win.AudioContext = class extends Context {
      constructor() {
        seen.context.push(h.win.navigator.audioSession?.type);
        super();
      }
    };
    const getUserMedia = h.win.navigator.mediaDevices.getUserMedia;
    h.win.navigator.mediaDevices.getUserMedia = (constraints: unknown) => {
      seen.mic.push(h.win.navigator.audioSession?.type);
      return getUserMedia(constraints);
    };
    return seen;
  }

  test("Tipp setzt play-and-record vor AudioContext und Mikrofon, Auflegen setzt den vorigen Wert zurück", async () => {
    const h = callHarness({ audioSession: "ok" });
    const seen = watchOrder(h);
    await h.listening();
    expect(seen).toEqual({ context: ["play-and-record"], mic: ["play-and-record"] });
    expect(h.win.navigator.audioSession.type).toBe("play-and-record");
    h.mode.hangUp();
    expect(h.win.navigator.audioSession.type).toBe("auto");
    expect(h.win.navigator.audioSession.sets).toEqual(["play-and-record", "auto"]);
  });

  test("Ein anderer voriger Wert kommt genau so zurück", async () => {
    const h = callHarness({ audioSession: "ok" });
    h.win.navigator.audioSession.type = "playback";
    await h.listening();
    h.mode.hangUp();
    expect(h.win.navigator.audioSession.sets).toEqual(["playback", "play-and-record", "playback"]);
  });

  test("Zurückgesetzt bei jedem Ende: Startfehler, Mikrofon verweigert, Ende vom Server, Hintergrund, Netzabbruch vor ready", async () => {
    const startError = callHarness({ audioSession: "ok" });
    await startError.start();
    startError.ws().receive({ type: "ended", reason: "start", seconds: 0 });
    expect(startError.view().phase).toBe("error");
    expect(startError.win.navigator.audioSession.type).toBe("auto");

    const denied = callHarness({ audioSession: "ok", microphone: "deny" });
    await denied.start();
    expect(denied.view().phase).toBe("error");
    expect(denied.win.navigator.audioSession.type).toBe("auto");

    const server = callHarness({ audioSession: "ok" });
    await server.listening();
    server.ws().receive({ type: "ended", reason: "stille", seconds: 120 });
    expect(server.view().phase).toBe("ended");
    expect(server.win.navigator.audioSession.type).toBe("auto");

    const background = callHarness({ audioSession: "ok" });
    await background.listening();
    background.mode.visibility(false);
    background.fakes.contexts[0].state = "interrupted";
    background.fakes.contexts[0].onstatechange();
    expect(background.view().phase).toBe("ended");
    expect(background.win.navigator.audioSession.type).toBe("auto");

    const dropped = callHarness({ audioSession: "ok" });
    await dropped.start();
    dropped.ws().drop(1006);
    expect(dropped.view().phase).toBe("error");
    expect(dropped.win.navigator.audioSession.type).toBe("auto");

    // „Noch einmal“ setzt die Sitzung wieder
    dropped.mode.retry();
    expect(dropped.win.navigator.audioSession.type).toBe("play-and-record");
    dropped.mode.hangUp();
    expect(dropped.win.navigator.audioSession.sets).toEqual(["play-and-record", "auto", "play-and-record", "auto"]);
  });

  test("Schnell auflegen und neu anrufen, die erste Mikrofon-Freigabe kommt zu spät: die neue Sitzung bleibt, danach zurück", async () => {
    const h = callHarness({ audioSession: "ok", microphone: "manual" });
    h.mode.start(h.CONVERSATION, CALL_STATUS, "General");
    h.mode.hangUp();
    expect(h.win.navigator.audioSession.type).toBe("auto");
    h.mode.start(h.CONVERSATION, CALL_STATUS, "General");
    expect(h.win.navigator.audioSession.type).toBe("play-and-record");
    // Die alte Freigabe kommt jetzt: ihr Strom wird gestoppt, die Sitzung bleibt bei der laufenden
    h.fakes.mic.pending[0]!.resolve(new FakeStream());
    await h.flush();
    expect(h.fakes.mic.streams[0]!.tracks.every(t => t.stopped)).toBe(true);
    expect(h.win.navigator.audioSession.type).toBe("play-and-record");
    h.mode.hangUp();
    h.fakes.mic.pending[1]!.resolve(new FakeStream());
    await h.flush();
    expect(h.win.navigator.audioSession.type).toBe("auto");
    expect(h.win.navigator.audioSession.sets).toEqual(["play-and-record", "auto", "play-and-record", "auto"]);
  });

  test("Ohne API (Chrome, Firefox, Android) und mit einer API, die beim Setzen wirft: kein Fehler, Gespräch wie bisher", async () => {
    for (const audioSession of [undefined, "throws"] as const) {
      const h = callHarness({ audioSession });
      await h.listening();
      expect(h.view()).toMatchObject({ phase: "listening", micOpen: true });
      await h.utter();
      await h.speaking();
      expect(h.vad()).toMatchObject({ active: true, strict: true });
      h.mode.hangUp();
      expect(h.view().phase).toBe("off");
      expect(h.released()).toEqual(CALL_RELEASED);
    }
    const throwing = callHarness({ audioSession: "throws" });
    await throwing.listening();
    expect(throwing.win.navigator.audioSession.type).toBe("auto");
    expect(throwing.mode.state.audioSession).toBeNull();
  });
});

describe("Echo-Schutz und Wiedergabeweg (Issue #280)", () => {
  test("Ohne Audio-Sitzung wie vor #280: der Spieler spielt nur direkt, die Erkennung bekommt seinen Ton nicht", async () => {
    const h = callHarness();
    await h.listening();
    expect(h.vadNode().options).toMatchObject({ numberOfInputs: 2, processorOptions: { mode: "call" } });
    expect(h.playerNode().targets).toEqual([{ target: h.fakes.contexts[0].destination, output: 0, input: 0 }]);
    // Kein <audio>-Element ohne Audio-Sitzung
    expect(h.fakes.audios).toHaveLength(0);
  });

  test("Mit Audio-Sitzung: Ton über MediaStream in ein <audio>-Element, gestartet im Tipp; Auflegen hält es an und löst den Strom", async () => {
    const h = callHarness({ audioSession: "ok" });
    h.mode.start(h.CONVERSATION, CALL_STATUS, "General");
    // Noch im Tipp: Element angelegt und gestartet
    expect(h.fakes.audios).toHaveLength(1);
    const element = h.fakes.audios[0];
    expect(element.plays).toBe(1);
    expect(element.autoplay).toBe(true);
    expect(element.srcObject).toEqual({ id: "wiedergabe-1" });
    await h.flush();
    h.ws().open();
    h.ws().receive({ type: "ready", model: "m", via: "api", stt: "parakeet", tts: "server", sampleRate: 24000 });
    h.ws().receive({ type: "state", state: "hoert-zu" });
    await h.flush();
    const targets = h.playerNode().targets;
    expect(targets.map((t: any) => t.target.kind ?? "vad")).toEqual(["stream-destination", "vad"]);
    expect(targets[1]).toMatchObject({ target: h.vadNode(), input: 1 });
    h.mode.hangUp();
    expect(element.paused).toBe(true);
    expect(element.srcObject).toBeNull();
    expect(h.released()).toEqual(CALL_RELEASED);
  });

  test("Mit Audio-Sitzung, aber das <audio>-Element darf nicht spielen: der Spieler spielt direkt, vorher und nachher verbunden", async () => {
    // Weigerung, bevor der Spieler steht
    const early = callHarness({ audioSession: "ok" });
    early.fakes.playMode.value = "blocked";
    await early.listening();
    expect(early.playerNode().targets.map((t: any) => t.target)).toEqual([early.fakes.contexts[0].destination, early.vadNode()]);

    // Weigerung, nachdem der Spieler schon am Strom hängt
    const late = callHarness({ audioSession: "ok", module: "manual" });
    const pending: Array<(e: unknown) => void> = [];
    late.fakes.playMode.value = "ok";
    late.win.Audio = class extends late.win.Audio {
      play() {
        this.plays++;
        return new Promise((_ok, fail) => pending.push(fail));
      }
    };
    late.mode.start(late.CONVERSATION, CALL_STATUS, "General");
    await late.flush();
    for (const m of late.fakes.modules) m.resolve();
    await late.flush();
    expect(late.playerNode().targets.map((t: any) => t.target.kind ?? "vad")).toEqual(["stream-destination", "vad"]);
    pending[0]!(new Error("NotAllowedError"));
    await late.flush();
    expect(late.playerNode().targets.map((t: any) => t.target.kind ?? "vad")).toEqual(["vad", "destination"]);
    expect(late.fakes.audios[0].srcObject).toBeNull();
  });

  test("Fehlalarm nach Unterbrechen per Stimme macht den Echo-Schutz strenger; mit Audio-Sitzung erst nach vier in Folge nur Antippen", async () => {
    const h = callHarness({ audioSession: "ok" });
    await h.listening();
    const echoes = () => h.vadNode().port.posted.filter((m: any) => m.type === "echo").length;
    const bargeAndNothing = async () => {
      await h.utter();
      await h.speaking();
      await h.emit({ type: "speechstart" });
      await h.emit({ type: "speechend" });
      h.ws().receive({ type: "state", state: "versteht" });
      h.ws().receive({ type: "notice", text: "nichts verstanden" });
      h.ws().receive({ type: "state", state: "hoert-zu" });
      await h.flush();
    };
    for (let i = 1; i <= 3; i++) {
      await bargeAndNothing();
      expect(echoes()).toBe(i);
      expect(h.view()).toMatchObject({ tapOnly: false, note: "Nichts verstanden." });
    }
    // Per Stimme geht weiter: während „Spricht“ hört die Erkennung streng zu
    await h.utter();
    await h.speaking();
    expect(h.vad()).toMatchObject({ active: true, strict: true });
    await h.emit({ type: "speechstart" });
    await h.emit({ type: "speechend" });
    h.ws().receive({ type: "state", state: "versteht" });
    h.ws().receive({ type: "notice", text: "nichts verstanden" });
    h.ws().receive({ type: "state", state: "hoert-zu" });
    await h.flush();
    expect(echoes()).toBe(4);
    expect(h.view()).toMatchObject({ tapOnly: true, note: h.api.CALL_TEXT.tapOnly });
  });

  test("Ohne Audio-Sitzung: wie bisher nach zwei Fehlalarmen nur Antippen, der Echo-Schutz wird trotzdem strenger", async () => {
    const h = callHarness();
    await h.listening();
    for (let i = 0; i < 2; i++) {
      await h.utter();
      await h.speaking();
      await h.emit({ type: "speechstart" });
      await h.emit({ type: "speechend" });
      h.ws().receive({ type: "state", state: "versteht" });
      h.ws().receive({ type: "notice", text: "nichts verstanden" });
      h.ws().receive({ type: "state", state: "hoert-zu" });
      await h.flush();
    }
    expect(h.vadNode().port.posted.filter((m: any) => m.type === "echo")).toHaveLength(2);
    expect(h.view().tapOnly).toBe(true);
  });

  test("Browser-Stimme und „Nur Antippen“ bleiben mit Audio-Sitzung, wie sie sind: während „Spricht“ hört die Erkennung nicht zu", async () => {
    const browser = callHarness({ audioSession: "ok" });
    await browser.listening(BROWSER_STATUS);
    await browser.utter();
    await browser.speaking();
    expect(browser.vad().active).toBe(false);
    const tap = callHarness({ audioSession: "ok", callDevice: { bargeIn: "tap" } });
    await tap.listening();
    await tap.utter();
    await tap.speaking();
    expect(tap.vad().active).toBe(false);
  });
});

describe("Puffer des <audio>-Wegs (Issue #280)", () => {
  const playedIds = (h: ReturnType<typeof callHarness>) => h.ws().json().filter(m => m.type === "played").map(m => m.id);

  /** Mit Audio-Sitzung bis „Spricht“, Abschnitt 1 mit Ton vom Server ist im Spieler */
  async function speakingViaRoute(options: Parameters<typeof callHarness>[0] = {}) {
    const h = callHarness({ audioSession: "ok", ...options });
    await h.listening();
    await h.utter();
    await h.speaking("Erster Satz.");
    h.ws().receive({ type: "audio_begin", id: 1 });
    h.ws().receiveBinary(960);
    h.ws().receive({ type: "audio_end", id: 1 });
    await h.flush();
    await h.played("begin", 1);
    return h;
  }

  test("played erst, wenn auch der Puffer des <audio>-Elements gespielt ist", async () => {
    const h = await speakingViaRoute();
    expect(h.mode.state.route).not.toBeNull();
    await h.played("played", 1);
    expect(playedIds(h)).toEqual([]);
    await h.advance(299);
    expect(playedIds(h)).toEqual([]);
    await h.advance(1);
    expect(playedIds(h)).toEqual([1]);
  });

  test("Unterbrechen kurz vor dem Wiedergabeende: der Rest im Puffer verstummt sofort, das Satzende wird nicht bestätigt", async () => {
    const h = await speakingViaRoute();
    const element = h.fakes.audios[0];
    await h.played("played", 1);
    await h.advance(250);
    h.mode.tap();
    expect(h.ws().types().at(-1)).toBe("interrupt");
    // Stumm, ohne das Element anzuhalten (ein neues play() bräuchte unter iOS einen Tipp)
    expect(element.muted).toBe(true);
    expect(element.paused).toBe(false);
    await h.advance(299);
    expect(element.muted).toBe(true);
    await h.advance(1);
    expect(element.muted).toBe(false);
    await h.advance(5_000);
    expect(playedIds(h)).toEqual([]);
  });

  test("Unterbrechen per Stimme schaltet den Puffer ebenso stumm", async () => {
    const h = await speakingViaRoute();
    await h.emit({ type: "speechstart" });
    expect(h.ws().types().at(-1)).toBe("interrupt");
    expect(h.fakes.audios[0].muted).toBe(true);
  });

  test("Die Ersatzstimme beginnt erst, wenn der Ton davor auch aus dem Puffer heraus ist", async () => {
    const h = await speakingViaRoute();
    h.ws().receive({ type: "sentence", id: 2, text: "Zweiter Satz." });
    h.ws().receive({ type: "speak_browser", id: 2, text: "Zweiter Satz." });
    await h.flush();
    expect(h.fakes.synth.spoken).toHaveLength(0);
    await h.played("played", 1);
    await h.advance(299);
    expect(h.fakes.synth.spoken).toHaveLength(0);
    await h.advance(1);
    expect(h.fakes.synth.spoken.map(u => u.text)).toEqual(["Zweiter Satz."]);
    expect(playedIds(h)).toEqual([1]);
  });

  // Prüfung am Pull Request #283: Rückfall innerhalb eines Satzes, dessen Anfang schon im Puffer steckt
  test("Rückfall mitten im Satz: der ausgegebene Anfang verklingt aus dem Puffer, erst danach spricht die Ersatzstimme", async () => {
    const h = callHarness({ audioSession: "ok" });
    await h.listening();
    await h.utter();
    await h.speaking("Erster Satz.");
    // Nachbildung der Ausgabe: der echte Spieler bekommt die Befehle von call.js, sein Ton kommt
    // 300 ms später aus dem <audio>-Element (dessen Puffer), stumm geschaltet ist er nicht zu hören
    const RATE = 48000;
    const STEP_MS = 10;
    const DELAY_STEPS = 300 / STEP_MS;
    const node = h.playerNode();
    const model = loadPlayer().createCallPlayer({ outputRate: RATE, emit: (data: any) => node.port.onmessage?.({ data }) });
    let taken = 0;
    const line: boolean[] = [];
    let t = 0;
    const heard: number[] = [];
    let voiceAt: number | null = null;
    async function step() {
      const posted = h.player();
      for (; taken < posted.length; taken++) {
        const m = posted[taken];
        if (m.type === "audio") model.audio(new Int16Array(m.buffer), m.rate);
        else if (m.type === "flush") model.flush(m.epoch);
        else if (typeof model[m.type] === "function") model[m.type](m.id);
      }
      const out = new Float32Array((RATE * STEP_MS) / 1000);
      model.render(out);
      line.push(out.some(v => v !== 0));
      const audible = line.length > DELAY_STEPS && line[line.length - 1 - DELAY_STEPS]! && !h.fakes.audios[0].muted;
      if (audible) heard.push(t);
      if (voiceAt === null && h.fakes.synth.spoken.length) voiceAt = t;
      await h.advance(STEP_MS);
      t += STEP_MS;
    }

    // Satz 1 vom Server: eine halbe Sekunde Ton, audio_end steht noch aus
    h.ws().receive({ type: "audio_begin", id: 1 });
    h.ws().receiveBinary(24000, 3000);
    await h.flush();
    for (let i = 0; i < 15; i++) await step();
    // Nach 150 ms fällt die Stimme aus: den Satz spricht ab jetzt der Browser
    const fallbackAt = t;
    h.ws().receive({ type: "speak_browser", id: 1, text: "Erster Satz." });
    await h.flush();
    for (let i = 0; i < 60; i++) await step();

    // Der Anfang des Satzes kam aus dem Puffer, die Ersatzstimme danach, ohne Überlagerung
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.at(-1)!).toBeGreaterThanOrEqual(fallbackAt);
    expect(voiceAt).not.toBeNull();
    expect(voiceAt!).toBeGreaterThan(heard.at(-1)!);
    // Und nicht länger als der Puffer gewartet
    expect(voiceAt! - fallbackAt).toBeLessThanOrEqual(300 + STEP_MS);
    expect(h.fakes.synth.spoken.map(u => u.text)).toEqual(["Erster Satz."]);
    // Den abgebrochenen Ton bestätigt niemand, den Satz bestätigt die Ersatzstimme
    expect(playedIds(h)).toEqual([]);
  });

  test("Rückfall mitten im Satz, dann Unterbrechen: die wartende Ersatzstimme beginnt nicht mehr", async () => {
    const h = await speakingViaRoute();
    await h.played("played", 1);
    h.ws().receive({ type: "sentence", id: 2, text: "Zweiter Satz." });
    h.ws().receive({ type: "audio_begin", id: 2 });
    h.ws().receiveBinary(960);
    h.ws().receive({ type: "speak_browser", id: 2, text: "Zweiter Satz." });
    await h.flush();
    h.mode.tap();
    await h.advance(5_000);
    expect(h.fakes.synth.spoken).toHaveLength(0);
    expect([...h.mode.state.playedTimers]).toEqual([]);
  });

  test("Rückfall ohne schon ausgegebenen Ton oder auf dem direkten Weg: die Ersatzstimme beginnt sofort wie bisher", async () => {
    const h = await speakingViaRoute();
    await h.played("played", 1);
    await h.advance(300);
    h.ws().receive({ type: "audio_begin", id: 2 });
    h.ws().receive({ type: "speak_browser", id: 2, text: "Zweiter Satz." });
    await h.flush();
    expect(h.fakes.synth.spoken.map(u => u.text)).toEqual(["Zweiter Satz."]);

    const direct = callHarness({ audioSession: "ok" });
    direct.fakes.playMode.value = "blocked";
    await direct.listening();
    await direct.utter();
    await direct.speaking("Erster Satz.");
    direct.ws().receive({ type: "audio_begin", id: 1 });
    direct.ws().receiveBinary(960);
    direct.ws().receive({ type: "speak_browser", id: 1, text: "Erster Satz." });
    await direct.flush();
    expect(direct.fakes.synth.spoken.map(u => u.text)).toEqual(["Erster Satz."]);
  });

  test("Auflegen mit wartendem played: nichts geht mehr hinaus, alle Zeitgeber weg", async () => {
    const h = await speakingViaRoute();
    await h.played("played", 1);
    h.mode.hangUp();
    expect(h.released()).toEqual(CALL_RELEASED);
    expect(playedIds(h)).toEqual([]);
  });

  test("Spielt das <audio>-Element nicht (direkter Weg) oder fehlt die Audio-Sitzung: played sofort wie bisher", async () => {
    const blocked = callHarness({ audioSession: "ok" });
    blocked.fakes.playMode.value = "blocked";
    await blocked.listening();
    await blocked.utter();
    await blocked.speaking();
    blocked.ws().receive({ type: "audio_begin", id: 1 });
    await blocked.flush();
    await blocked.played("played", 1);
    expect(playedIds(blocked)).toEqual([1]);

    const plain = callHarness();
    await plain.listening();
    await plain.utter();
    await plain.speaking();
    plain.ws().receive({ type: "audio_begin", id: 1 });
    await plain.flush();
    await plain.played("played", 1);
    expect(playedIds(plain)).toEqual([1]);
    plain.mode.tap();
    expect(plain.fakes.audios).toHaveLength(0);
  });
});
