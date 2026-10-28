/**
 * ElevenLabs Scribe für den Telefonhörer (Issue #279, Checkbox 1): die
 * Realtime-Verbindung (scribe_v2_realtime, pcm_16000, manueller Commit,
 * language_code), Stücke beim Sprechen, Commit beim Erkennen, Abschnitte
 * einer Äußerung, neue Äußerung, Fehlerarten, Abbruch, Wiederaufbau; der
 * bisherige Weg für Telegram und Sprechmodus (scribe_v1, ohne Sprache)
 * bleibt unverändert. Nur Attrappen, kein Netz.
 */

import { describe, expect, test } from "bun:test";
import { createSttProviders, type ProviderDeps } from "../src/lib/speech/providers";
import { AUTO_COMMIT_RISK, CALL_SCRIBE_MODEL, openScribeStream, SCRIBE_REALTIME_URL } from "../src/lib/speech/scribe";
import { SpeechError } from "../src/lib/speech/types";
import { fakeScribe } from "./scribe-fixture";
import { flush } from "./call-fixture";

const KEY = "KEY-MARKER-SCRIBE";

async function kind(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof SpeechError ? `${e.kind}${e.code !== undefined ? ` ${e.code}` : ""}` : "anders";
  }
}

const PCM = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);
const live = () => new AbortController().signal;

/** Eine Sekunde Ton, PCM16 mono 16 kHz */
const SECOND = new Uint8Array(32_000);
/** Der Server committet selbst nach etwa 36 Sekunden Ton */
const AUTO_BYTES = 36 * SECOND.length;

function setup(o: { language?: string; key?: string; start?: boolean; autoCommitBytes?: number } = {}) {
  const f = fakeScribe({ ...(o.start === false ? { start: false } : {}), ...(o.autoCommitBytes ? { autoCommitBytes: o.autoCommitBytes } : {}) });
  const stream = openScribeStream({ key: o.key ?? KEY, ...(o.language ? { language: o.language } : {}), connect: f.connect });
  return { f, stream };
}

describe("openScribeStream", () => {
  test("Verbindung mit scribe_v2_realtime, pcm_16000, manuellem Commit und Sprache; Schlüssel nur als Kopfzeile", async () => {
    const { f, stream } = setup({ language: "de" });
    stream.warm();
    expect(f.sockets).toHaveLength(1);
    const url = new URL(f.sockets[0]!.url);
    expect(`${url.origin}${url.pathname}`.replace("https:", "wss:")).toBe(SCRIBE_REALTIME_URL);
    expect(CALL_SCRIBE_MODEL).toBe("scribe_v2_realtime");
    expect(url.searchParams.get("model_id")).toBe("scribe_v2_realtime");
    expect(url.searchParams.get("audio_format")).toBe("pcm_16000");
    expect(url.searchParams.get("commit_strategy")).toBe("manual");
    expect(url.searchParams.get("language_code")).toBe("de");
    expect(f.sockets[0]!.url).not.toContain(KEY);
    expect(f.sockets[0]!.key).toBe(KEY);
    // Zweimal warm: weiter eine Verbindung
    stream.warm();
    expect(f.sockets).toHaveLength(1);
  });

  test("ohne Sprache kein language_code (Scribe erkennt sie selbst)", () => {
    const { f, stream } = setup();
    stream.warm();
    expect(new URL(f.sockets[0]!.url).searchParams.get("language_code")).toBeNull();
  });

  test("Stücke gehen beim Sprechen hinaus (erst nach session_started), transcribe committet und liefert den Text", async () => {
    const { f, stream } = setup({ start: false });
    stream.push(PCM);
    stream.push(PCM);
    // Vor session_started wartet alles
    expect(f.sockets[0]!.sent).toEqual([]);
    f.sockets[0]!.emit("message", { message_type: "session_started" });
    expect(f.sockets[0]!.sent.map(m => m.commit)).toEqual([false, false]);
    expect(f.sockets[0]!.sent[0]).toEqual({ message_type: "input_audio_chunk", audio_base_64: Buffer.from(PCM).toString("base64"), commit: false, sample_rate: 16_000 });
    f.replies.push({ text: " Wie wird das Wetter morgen in Berlin? " });
    expect(await stream.transcribe(live())).toBe("Wie wird das Wetter morgen in Berlin?");
    expect(f.commits()).toEqual([{ message_type: "input_audio_chunk", audio_base_64: "", commit: true, sample_rate: 16_000 }]);
  });

  test("Pause, dann weitere Sprache: der erste Abschnitt bleibt, der zweite Commit liefert den Rest", async () => {
    const { f, stream } = setup();
    f.replies.push({ text: "Ich hätte jetzt gern" }, { text: "ein Schokoeis mit Sahne." });
    stream.push(PCM);
    expect(await stream.transcribe(live())).toBe("Ich hätte jetzt gern");
    stream.push(PCM);
    expect(await stream.transcribe(live())).toBe("Ich hätte jetzt gern ein Schokoeis mit Sahne.");
    // Ohne neue Stücke kein weiterer Commit
    expect(await stream.transcribe(live())).toBe("Ich hätte jetzt gern ein Schokoeis mit Sahne.");
    expect(f.commits()).toHaveLength(2);
    expect(f.sockets).toHaveLength(1);
  });

  test("abgebrochenes Warten (weitere Sprache) verliert den Abschnitt nicht", async () => {
    const { f, stream } = setup();
    f.replies.push("hang");
    stream.push(PCM);
    const ctrl = new AbortController();
    const p = kind(stream.transcribe(ctrl.signal));
    ctrl.abort();
    expect(await p).toBe("timeout");
    // Die Antwort zum ersten Commit kommt spät, der zweite Commit gleich
    stream.push(PCM);
    f.replies.push({ text: "Sahne." });
    const end = stream.transcribe(live());
    f.sockets[0]!.emit("message", { message_type: "committed_transcript", text: "Schokoeis mit" });
    expect(await end).toBe("Schokoeis mit Sahne.");
  });

  test("neue Äußerung: Abschnitte beginnen leer; nichts gehört heißt empty", async () => {
    const { f, stream } = setup();
    f.replies.push({ text: "Erste" }, { text: "Zweite" }, { text: "  " });
    stream.push(PCM);
    expect(await stream.transcribe(live())).toBe("Erste");
    stream.newUtterance();
    expect(await kind(stream.transcribe(live()))).toBe("empty");
    stream.push(PCM);
    expect(await stream.transcribe(live())).toBe("Zweite");
    stream.newUtterance();
    stream.push(PCM);
    expect(await kind(stream.transcribe(live()))).toBe("empty");
    // Alles erledigt: dieselbe Verbindung bleibt
    expect(f.sockets).toHaveLength(1);
  });

  test("neue Äußerung mit Stücken ohne Commit oder ausstehender Antwort: Verbindung neu, nichts rutscht hinüber", async () => {
    const { f, stream } = setup();
    stream.push(PCM);
    await flush();
    stream.newUtterance();
    expect(f.sockets[0]!.closed).toBe(true);
    f.replies.push("hang");
    stream.push(PCM);
    await flush();
    expect(f.sockets).toHaveLength(2);
    const p = kind(stream.transcribe(new AbortController().signal));
    await flush();
    stream.newUtterance();
    expect(f.sockets[1]!.closed).toBe(true);
    // Die späte Antwort der alten Verbindung zählt nirgends
    f.sockets[1]!.emit("message", { message_type: "committed_transcript", text: "alt" });
    f.replies.push({ text: "neu" });
    stream.push(PCM);
    expect(await stream.transcribe(live())).toBe("neu");
    expect(f.sockets).toHaveLength(3);
    void p;
  });

  test("automatischer Commit des Servers vor utterance_pause (über 36 Sekunden Ton): beide Abschnitte vollständig, dann neue Äußerung ohne Altabschnitte", async () => {
    const { f, stream } = setup({ autoCommitBytes: AUTO_BYTES });
    f.autoReplies.push({ text: "Anfang der langen Äußerung" });
    f.replies.push({ text: "nur der Schluss" }, { text: "Neue Frage?" });
    for (let i = 0; i < 40; i++) stream.push(SECOND);
    await flush();
    // Der Server hat nach 36 Sekunden selbst committet, eigener Commit noch keiner
    expect(f.commits()).toHaveLength(0);
    expect(await stream.transcribe(live())).toBe("Anfang der langen Äußerung nur der Schluss");
    expect(f.commits()).toHaveLength(1);
    // utterance_end ohne neue Stücke: dasselbe Ergebnis, kein weiterer Commit
    expect(await stream.transcribe(live())).toBe("Anfang der langen Äußerung nur der Schluss");
    expect(f.commits()).toHaveLength(1);
    stream.newUtterance();
    stream.push(PCM);
    expect(await stream.transcribe(live())).toBe("Neue Frage?");
    expect(f.sockets).toHaveLength(1);
  });

  test("automatischer Commit, dann Pause und weitere Sprache: alle Abschnitte in Reihenfolge", async () => {
    const { f, stream } = setup({ autoCommitBytes: AUTO_BYTES });
    f.autoReplies.push({ text: "Eins" });
    f.replies.push({ text: "zwei" }, { text: "drei." });
    for (let i = 0; i < 38; i++) stream.push(SECOND);
    await flush();
    expect(await stream.transcribe(live())).toBe("Eins zwei");
    for (let i = 0; i < 5; i++) stream.push(SECOND);
    expect(await stream.transcribe(live())).toBe("Eins zwei drei.");
  });

  test("Überschneidung mit einem eigenen Commit: nicht sicher zuzuordnen, format; späte Antworten zählen nirgends, die neue Äußerung beginnt sauber", async () => {
    expect(AUTO_COMMIT_RISK).toBeLessThan(36);
    // Der Server committet nach 36 Sekunden selbst, antwortet aber erst nach unserem Commit
    const { f, stream } = setup({ autoCommitBytes: AUTO_BYTES });
    f.autoReplies.push("hang");
    for (let i = 0; i < 37; i++) stream.push(SECOND);
    await flush();
    expect(await kind(stream.transcribe(live()))).toBe("format");
    // Die Verbindung ist verworfen, kein Commit ging hinaus, der Fehler bleibt für diese Äußerung
    expect(f.sockets[0]!.closed).toBe(true);
    expect(f.commits()).toHaveLength(0);
    expect(await kind(stream.transcribe(live()))).toBe("format");
    // Späte Antworten der alten Verbindung (automatisch und eigen)
    f.sockets[0]!.emit("message", { message_type: "committed_transcript", text: "Anfang der langen Äußerung" });
    f.sockets[0]!.emit("message", { message_type: "committed_transcript", text: "nur der Schluss" });
    stream.newUtterance();
    f.replies.push({ text: "Neue Frage?" });
    stream.push(PCM);
    expect(await stream.transcribe(live())).toBe("Neue Frage?");
    expect(f.sockets).toHaveLength(2);
  });

  test("eigener Commit knapp unter der Grenze bleibt Scribe; ab der Grenze nicht mehr", async () => {
    const under = setup();
    under.f.replies.push({ text: "knapp darunter" });
    for (let i = 0; i < AUTO_COMMIT_RISK - 1; i++) under.stream.push(SECOND);
    expect(await under.stream.transcribe(live())).toBe("knapp darunter");
    const at = setup();
    for (let i = 0; i < AUTO_COMMIT_RISK; i++) at.stream.push(SECOND);
    expect(await kind(at.stream.transcribe(live()))).toBe("format");
  });

  test("Antwort ohne passenden Commit und ohne Ton: frühere Zuordnung unsicher, format; neue Äußerung auf neuer Verbindung ohne Altabschnitte", async () => {
    const { f, stream } = setup();
    f.replies.push({ text: "Anfang" });
    stream.push(PCM);
    expect(await stream.transcribe(live())).toBe("Anfang");
    // Eine zweite Antwort, zu der kein Commit passt
    f.sockets[0]!.emit("message", { message_type: "committed_transcript", text: "Schluss" });
    expect(f.sockets[0]!.closed).toBe(true);
    expect(await kind(stream.transcribe(live()))).toBe("format");
    stream.newUtterance();
    f.replies.push({ text: "Neue Frage?" });
    stream.push(PCM);
    expect(await stream.transcribe(live())).toBe("Neue Frage?");
    expect(f.sockets).toHaveLength(2);
  });

  test("Fehler des Servers: 401 bei Anmeldung, 429 bei Kontingent und Drosselung, sonst format; nie mit Inhalt", async () => {
    for (const [error, expected] of [
      ["auth_error", "http 401"],
      ["quota_exceeded", "http 429"],
      ["rate_limited", "http 429"],
      ["commit_throttled", "http 429"],
      ["transcriber_error", "format"],
    ] as const) {
      const { f, stream } = setup();
      f.replies.push({ error });
      stream.push(PCM);
      let caught: unknown;
      try {
        await stream.transcribe(live());
      } catch (e) {
        caught = e;
      }
      expect(caught instanceof SpeechError ? `${caught.kind}${caught.code !== undefined ? ` ${caught.code}` : ""}` : "anders").toBe(expected);
      expect(String(caught)).not.toContain("Inhalt");
      expect(String(caught)).not.toContain(KEY);
    }
  });

  test("Verbindung bricht mitten in der Äußerung ab: network; die nächste Äußerung baut neu auf", async () => {
    for (const reply of ["close", "network"] as const) {
      const { f, stream } = setup();
      f.replies.push(reply);
      stream.push(PCM);
      expect(await kind(stream.transcribe(live()))).toBe("network");
      // Weitere Stücke dieser Äußerung gehen nicht mehr hinaus, der Fehler bleibt
      stream.push(PCM);
      expect(await kind(stream.transcribe(live()))).toBe("network");
      stream.newUtterance();
      f.replies.push({ text: "wieder da" });
      stream.push(PCM);
      expect(await stream.transcribe(live())).toBe("wieder da");
      expect(f.sockets).toHaveLength(2);
    }
  });

  test("Verbindung scheitert schon beim Aufbau: die Äußerung scheitert mit network", async () => {
    const f = fakeScribe();
    const stream = openScribeStream({
      key: KEY,
      connect: () => {
        throw new Error("kein Netz");
      },
    });
    stream.push(PCM);
    expect(await kind(stream.transcribe(live()))).toBe("network");
    expect(f.sockets).toHaveLength(0);
  });

  test("ruhende Verbindung vom Server geschlossen: kein Fehler, das nächste Stück baut neu auf", async () => {
    const { f, stream } = setup();
    stream.warm();
    await flush();
    f.sockets[0]!.emit("close");
    f.replies.push({ text: "Hallo" });
    stream.push(PCM);
    expect(await stream.transcribe(live())).toBe("Hallo");
    expect(f.sockets).toHaveLength(2);
  });

  test("Abbruch: schon abgebrochen kein Commit; während des Wartens timeout", async () => {
    const { f, stream } = setup();
    stream.push(PCM);
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await kind(stream.transcribe(ctrl.signal))).toBe("timeout");
    expect(f.commits()).toHaveLength(0);
  });

  test("ohne Schlüssel: keine Verbindung, unavailable", async () => {
    const { f, stream } = setup({ key: "" });
    stream.warm();
    stream.push(PCM);
    expect(await kind(stream.transcribe(live()))).toBe("unavailable");
    expect(f.sockets).toHaveLength(0);
  });

  test("close: Verbindung zu, danach geht kein Ton mehr hinaus", async () => {
    const { f, stream } = setup();
    stream.push(PCM);
    await flush();
    stream.close();
    expect(f.sockets[0]!.closed).toBe(true);
    stream.newUtterance();
    stream.push(PCM);
    expect(f.sockets).toHaveLength(1);
    expect(f.audioBytes()).toBe(PCM.length);
  });
});

describe("Anbieter elevenlabs fürs Hören (providers.ts)", () => {
  function deps(env: Record<string, string | undefined>, fetchFn: ProviderDeps["fetch"], connect?: ProviderDeps["connectWebSocket"]): ProviderDeps {
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
      ...(connect ? { connectWebSocket: connect } : {}),
    };
  }

  function fakeFetch(respond: () => Response) {
    const calls: { url: string; form: FormData }[] = [];
    const fn = async (url: string, init: RequestInit = {}) => {
      calls.push({ url, form: init.body as FormData });
      return respond();
    };
    return { fn, calls };
  }

  test("openCallStream nutzt Scribe v2 Realtime mit Sprache und dem Schlüssel aus der Umgebung", async () => {
    const f = fakeScribe();
    const { fn, calls } = fakeFetch(() => Response.json({ text: "x" }));
    const p = createSttProviders(deps({ ELEVENLABS_API_KEY: KEY }, fn, f.connect)).find(x => x.id === "elevenlabs")!;
    const stream = p.openCallStream!({ language: "de" });
    f.replies.push({ text: "Schokoeis" });
    stream.push(PCM);
    expect(await stream.transcribe(live())).toBe("Schokoeis");
    expect(new URL(f.sockets[0]!.url).searchParams.get("model_id")).toBe("scribe_v2_realtime");
    expect(new URL(f.sockets[0]!.url).searchParams.get("language_code")).toBe("de");
    expect(f.sockets[0]!.key).toBe(KEY);
    expect(calls).toHaveLength(0);
  });

  test("Telegram und Sprechmodus unverändert: transcribe sendet scribe_v1 als Datei, ohne Sprache und ohne file_format", async () => {
    const f = fakeScribe();
    const { fn, calls } = fakeFetch(() => Response.json({ text: "Hallo" }));
    const p = createSttProviders(deps({ ELEVENLABS_API_KEY: KEY }, fn, f.connect)).find(x => x.id === "elevenlabs")!;
    expect(await p.transcribe(Buffer.from("OggS"), "audio/ogg", { language: "de" })).toBe("Hallo");
    const form = calls[0]!.form;
    expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(form.get("model_id")).toBe("scribe_v1");
    expect(form.get("language_code")).toBeNull();
    expect(form.get("file_format")).toBeNull();
    expect((form.get("file") as File).name).toBe("audio.ogg");
    expect(f.sockets).toHaveLength(0);
  });

  test("ohne Schlüssel weder verfügbar noch Verbindung", async () => {
    const f = fakeScribe();
    const p = createSttProviders(deps({}, async () => new Response(""), f.connect)).find(x => x.id === "elevenlabs")!;
    expect(p.available()).toEqual({ ok: false, reason: "ELEVENLABS_API_KEY fehlt" });
    const stream = p.openCallStream!({});
    stream.warm();
    stream.push(PCM);
    expect(await kind(stream.transcribe(live()))).toBe("unavailable");
    expect(f.sockets).toHaveLength(0);
  });

  test("lokale Erkenner haben keinen eigenen Weg des Telefonhörers", () => {
    const list = createSttProviders(deps({}, async () => new Response("")));
    expect(list.find(x => x.id === "parakeet")!.openCallStream).toBeUndefined();
    expect(list.find(x => x.id === "whisper-cpp")!.openCallStream).toBeUndefined();
  });
});
