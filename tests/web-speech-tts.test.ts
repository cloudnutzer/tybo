/**
 * Issue #249, Checkbox 3: POST /api/speech/tts und die vorlesbare Fassung in
 * API und Live-Ereignissen. Echter Web-Server; die Sprachausgabe ist eine
 * Attrappe (SpeechPort) bzw. die echte Kette mit Anbieter-Attrappen. Kein
 * Netzwerk nach außen, kein ElevenLabs.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpeech } from "../src/lib/speech/chain";
import { TTS_IDS, type TtsId } from "../src/lib/speech/ids";
import type { TtsProvider } from "../src/lib/speech/types";
import { AI_GENERATED_NOTE, readWavInfo } from "../src/lib/speech/wav";
import { createBotSpeech } from "../src/web/bot-speech";
import type { WebServer, WebServerDeps } from "../src/web/server";
import { SPEAKABLE_CODE_NOTE, SPEAKABLE_TABLE_NOTE } from "../src/web/speakable";
import { MAX_TTS_CHARS, TTS_RATE_LIMIT, TTS_RATE_WINDOW_MS, createRateLimit, type SpeechPort, type SpeechSynthesis } from "../src/web/speech";
import type { RunTurnOptions, TurnResult, WebChat } from "../src/web/chat";
import { mp3FrameFixture, oggOpusFixture, wavFixture } from "./audio-fixture";
import { wavSilence } from "./speech-fixture";
import { topicServer } from "./topic-fixture";

const root = await mkdtemp(join(tmpdir(), "web-speech-tts-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
});

function fakeTts(initial: SpeechSynthesis | Error = { ok: true, audio: mp3FrameFixture(), mime: "audio/mpeg", provider: "attrappe" }) {
  const state = { result: initial, calls: [] as { text: string; voice?: string }[] };
  const port: SpeechPort = {
    recognize: async () => ({ ok: true, text: "Was steht im Plan?" }),
    async synthesize(text, opts) {
      state.calls.push({ text, ...(opts.voice !== undefined ? { voice: opts.voice } : {}) });
      if (state.result instanceof Error) throw state.result;
      return state.result;
    },
  };
  return { state, port };
}

async function server(deps: Partial<WebServerDeps>) {
  return topicServer(root, servers, null, deps);
}

const tts = (ctx: Awaited<ReturnType<typeof server>>, body: unknown, headers?: Record<string, string>) => ctx.api("/api/speech/tts", "POST", body, headers);

describe("POST /api/speech/tts", () => {
  test("liefert das Audio des Anbieters mit seinem Typ, nie zwischengespeichert", async () => {
    const t = fakeTts();
    const ctx = await server({ speech: t.port });
    const res = await tts(ctx, { text: "  Guten Morgen.  " });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).equals(mp3FrameFixture())).toBe(true);
    expect(t.state.calls).toEqual([{ text: "Guten Morgen." }]);
    // Der Text steht nie im Log
    expect(ctx.logs.join("\n")).not.toContain("Guten Morgen");
  });

  test("WAV und Ogg gehen mit ihrem Typ durch", async () => {
    const t = fakeTts({ ok: true, audio: wavFixture(), mime: "audio/wav" });
    const ctx = await server({ speech: t.port });
    expect((await tts(ctx, { text: "a" })).headers.get("content-type")).toBe("audio/wav");
    t.state.result = { ok: true, audio: oggOpusFixture(), mime: "audio/ogg" };
    expect((await tts(ctx, { text: "a" })).headers.get("content-type")).toBe("audio/ogg");
  });

  test("Akzeptanz: ohne serverseitigen Anbieter (Browser-Stimme) 409", async () => {
    const t = fakeTts({ ok: false, reason: "browser" });
    const ctx = await server({ speech: t.port });
    const res = await tts(ctx, { text: "Hallo" });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("browser");
  });

  test("echte Kette: auto und browser ergeben 409, ein Server-Anbieter liefert gekennzeichnetes WAV", async () => {
    let choice: string | undefined;
    const synthesized: TtsId[] = [];
    const providers: TtsProvider[] = TTS_IDS.map(id => ({
      id,
      label: id,
      local: true,
      where: id === "browser" ? "browser" : "server",
      available: () => ({ ok: true }),
      synthesize: async () => {
        synthesized.push(id);
        return { audio: Buffer.from(wavSilence(0.2)), mime: "audio/wav" };
      },
    }));
    const speech = createSpeech({
      stt: [],
      tts: providers,
      getSettings: () => (choice ? { speech: { tts: choice as TtsId } } : {}),
      env: () => ({}),
      log: () => {},
      readFile: async () => Buffer.from("x"),
    });
    const port = createBotSpeech({ userId: "4711", groupId: () => null, agentForTopic: () => undefined, speech: () => speech });
    const ctx = await server({ speech: port });
    for (const value of [undefined, "auto", "browser"]) {
      choice = value;
      const res = await tts(ctx, { text: "Hallo" });
      expect(res.status).toBe(409);
      expect((await res.json()).reason).toBe("browser");
    }
    expect(synthesized).toEqual([]);
    choice = "gemini";
    const res = await tts(ctx, { text: "Hallo" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    const audio = Buffer.from(await res.arrayBuffer());
    expect(readWavInfo(audio).ICMT).toBe(AI_GENERATED_NOTE);
    expect(audio.readUInt32LE(4)).toBe(audio.length - 8);
    expect(synthesized).toEqual(["gemini"]);
  });

  test("höchstens 600 Zeichen je Aufruf: 600 gehen, 601 ergeben 413 ohne Aufruf des Anbieters", async () => {
    const t = fakeTts();
    const ctx = await server({ speech: t.port });
    expect((await tts(ctx, { text: "ä".repeat(MAX_TTS_CHARS) })).status).toBe(200);
    const res = await tts(ctx, { text: "ä".repeat(MAX_TTS_CHARS + 1) });
    expect(res.status).toBe(413);
    expect((await res.json()).reason).toBe("zu-lang");
    expect(t.state.calls).toHaveLength(1);
  });

  test("ungültige Anfragen: 400 ohne Aufruf des Anbieters", async () => {
    const t = fakeTts();
    const ctx = await server({ speech: t.port });
    for (const body of ["kein json", [], {}, { text: "" }, { text: "   " }, { text: 5 }, { text: null }]) {
      expect((await tts(ctx, body)).status).toBe(400);
    }
    for (const voice of ["", "-rf", "a b", "../x", 5, null, "a".repeat(65)]) {
      const res = await tts(ctx, { text: "Hallo", voice });
      expect(res.status).toBe(400);
      expect((await res.json()).reason).toBe("stimme");
    }
    expect(t.state.calls).toEqual([]);
  });

  test("Stimme je Aufruf geht an den Anbieter", async () => {
    const t = fakeTts();
    const ctx = await server({ speech: t.port });
    expect((await tts(ctx, { text: "Hallo", voice: "Kore_2-x" })).status).toBe(200);
    expect(t.state.calls).toEqual([{ text: "Hallo", voice: "Kore_2-x" }]);
  });

  test("nicht verfügbar 503, gescheitert 502, Stimme nicht freigegeben 400, Ausnahme 502, fremder Typ 502", async () => {
    const t = fakeTts({ ok: false, reason: "unavailable" });
    const ctx = await server({ speech: t.port });
    const unavailable = await tts(ctx, { text: "Hallo" });
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).reason).toBe("nicht-verfuegbar");
    t.state.result = { ok: false, reason: "failed" };
    expect((await tts(ctx, { text: "Hallo" })).status).toBe(502);
    // Stimme beim Anbieter nicht freigegeben (Pocket TTS, Issue #252): 400 wie eine ungültige Stimme
    t.state.result = { ok: false, reason: "voice" };
    const voice = await tts(ctx, { text: "Hallo", voice: "cosette" });
    expect(voice.status).toBe(400);
    expect((await voice.json()).reason).toBe("stimme");
    t.state.result = new Error("geheim /pfad");
    const thrown = await tts(ctx, { text: "Hallo" });
    expect(thrown.status).toBe(502);
    expect(JSON.stringify(await thrown.json())).not.toContain("geheim");
    t.state.result = { ok: true, audio: Buffer.from("<html>"), mime: "text/html" };
    const html = await tts(ctx, { text: "Hallo" });
    expect(html.status).toBe(502);
    expect(html.headers.get("content-type")).toContain("application/json");
    t.state.result = { ok: true, audio: new Uint8Array(0), mime: "audio/wav" };
    expect((await tts(ctx, { text: "Hallo" })).status).toBe(502);
  });

  test("ohne Anmeldung 401, fremder Origin 403, falsche Methode 405, ohne Anbindung 503", async () => {
    const t = fakeTts();
    const ctx = await server({ speech: t.port });
    const noLogin = await fetch(`${ctx.origin}/api/speech/tts`, { method: "POST", headers: { origin: ctx.origin }, body: JSON.stringify({ text: "Hallo" }) });
    expect(noLogin.status).toBe(401);
    expect((await tts(ctx, { text: "Hallo" }, { origin: "https://fremd.example" })).status).toBe(403);
    const get = await ctx.api("/api/speech/tts");
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect(t.state.calls).toEqual([]);
    const none = await server({});
    expect((await tts(none, { text: "Hallo" })).status).toBe(503);
  });

  test("Rate-Limit: 120 Aufrufe in 10 Minuten für den ganzen Server, danach 429 mit Retry-After, nach dem Fenster wieder frei", async () => {
    const t = fakeTts();
    const clock = { t: Date.now() };
    const ctx = await server({ speech: t.port, now: () => clock.t });
    // Zweite Anmeldung: das Limit gilt über Sitzungen hinweg
    const login = await fetch(`${ctx.origin}/api/login`, { method: "POST", headers: { origin: ctx.origin }, body: JSON.stringify({ password: "test-passwort-lang" }) });
    const otherCookie = login.headers.get("set-cookie")!.split(";")[0];
    for (let i = 0; i < TTS_RATE_LIMIT; i++) {
      clock.t += 1000;
      const res = await tts(ctx, { text: `Satz ${i}` }, i % 2 ? { cookie: otherCookie } : {});
      expect(res.status).toBe(200);
    }
    // Ungültige Anfragen zählen nicht mit und bleiben 400
    expect((await tts(ctx, { text: "" })).status).toBe(400);
    const blocked = await tts(ctx, { text: "zu viel" }, { cookie: otherCookie });
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).reason).toBe("zu-viele");
    // Der erste Aufruf lag 119 Sekunden zurück: er fällt nach weiteren 481 Sekunden aus dem Fenster
    expect(blocked.headers.get("retry-after")).toBe(String((TTS_RATE_WINDOW_MS - 119_000) / 1000));
    expect(t.state.calls).toHaveLength(TTS_RATE_LIMIT);
    clock.t += TTS_RATE_WINDOW_MS - 119_000 - 1;
    expect((await tts(ctx, { text: "noch zu früh" })).status).toBe(429);
    clock.t += 1;
    expect((await tts(ctx, { text: "wieder frei" })).status).toBe(200);
    expect((await tts(ctx, { text: "wieder zu" })).status).toBe(429);
  });

  test("createRateLimit: gleitendes Fenster", () => {
    const clock = { t: 0 };
    const limit = createRateLimit(2, 1000, () => clock.t);
    expect(limit.take()).toEqual({ ok: true });
    clock.t = 400;
    expect(limit.take()).toEqual({ ok: true });
    expect(limit.take()).toEqual({ ok: false, retryAfterMs: 600 });
    clock.t = 1000;
    expect(limit.take()).toEqual({ ok: true });
    expect(limit.take()).toEqual({ ok: false, retryAfterMs: 400 });
  });
});

// --- Vorlesbare Fassung in API und Live-Ereignissen ------------------------------------

const ANSWER = ["## Plan", "", "| Tag | Aufgabe |", "|---|---|", "| Mo | Schreiben |", "", "```sh", "ls | wc", "```", "", "Mehr steht im [Dokument](https://example.org/plan) 📄. [REMEMBER: Plan besprochen]"].join("\n");

class AnswerChat implements WebChat {
  turns: RunTurnOptions[] = [];
  async runTurn(opts: RunTurnOptions): Promise<TurnResult> {
    this.turns.push(opts);
    return { text: ANSWER, info: { agent: "general", model: "attrappe" } };
  }
  stop() {}
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

describe("speakable und speakSegments", () => {
  test("Antwort auf einen Sprech-Turn: vorlesbare Fassung in SSE und nach dem Neuladen, Anzeige unverändert; getippt danach ohne", async () => {
    const chat = new AnswerChat();
    const ctx = await server({ speech: fakeTts().port, chat });
    const conversation = await ctx.store.createConversation("general");
    const id = conversation.id;

    // Live mitlesen
    const controller = new AbortController();
    const stream = await fetch(`${ctx.origin}/api/conversations/${id}/events`, { headers: { cookie: ctx.cookie, origin: ctx.origin }, signal: controller.signal });
    const reader = stream.body!.getReader();
    const live: any[] = [];
    const reading = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) break;
        buffer += decoder.decode(value);
        let i: number;
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const event = /^event: (.+)$/m.exec(chunk)?.[1];
          const data = /^data: (.+)$/m.exec(chunk)?.[1];
          if (event === "message" && data) live.push(JSON.parse(data));
        }
      }
    })();

    const spoken = await fetch(`${ctx.origin}/api/conversations/${id}/speech`, {
      method: "POST",
      headers: { cookie: ctx.cookie, origin: ctx.origin, "content-type": "audio/wav" },
      body: wavSilence(1),
    });
    expect(spoken.status).toBe(202);
    expect(chat.turns[0].speech).toBe(true);
    await waitUntil(() => live.some(m => m.role === "assistant"));

    const expected = `Plan. ${SPEAKABLE_TABLE_NOTE} ${SPEAKABLE_CODE_NOTE} Mehr steht im Dokument.`;
    const sse = live.find(m => m.role === "assistant");
    expect(sse.speakable).toBe(expected);
    expect(sse.speakSegments.join(" ")).toBe(expected);
    expect(sse.speakable).not.toContain("|");
    expect(sse.speakable).not.toContain("`");
    // Die angezeigte Antwort bleibt, wie sie ist
    expect(sse.text).toBe(ANSWER);
    expect(sse.html).toContain("<table>");
    expect(sse.html).toContain("<pre><code");
    expect(sse.copyText).toContain("| Mo | Schreiben |");
    expect(sse.model).toBe("attrappe");

    // Nach erneutem Laden dieselbe Fassung
    await waitUntil(async () => (await (await ctx.api(`/api/conversations/${id}`)).json()).running === false);
    let list = (await (await ctx.api(`/api/conversations/${id}/messages`)).json()).messages;
    expect(list[0]).toMatchObject({ role: "user", text: "Was steht im Plan?", source: "speech" });
    expect(list[1].speakable).toBe(expected);
    expect(list[1].speakSegments).toEqual(sse.speakSegments);

    // Getippte Nachricht im selben Gespräch: dieselbe Antwort, aber ohne vorlesbare Fassung
    expect((await ctx.api(`/api/conversations/${id}/messages`, "POST", { text: "Und getippt?" })).status).toBe(202);
    await waitUntil(() => live.filter(m => m.role === "assistant").length === 2);
    expect(chat.turns[1].speech).toBeUndefined();
    const typed = live.filter(m => m.role === "assistant")[1];
    expect(typed.speakable).toBeUndefined();
    expect(typed.speakSegments).toBeUndefined();
    list = (await (await ctx.api(`/api/conversations/${id}/messages`)).json()).messages;
    expect(list[2].source).toBeUndefined();
    expect(list[3].speakable).toBeUndefined();

    controller.abort();
    await reader.cancel().catch(() => {});
    await reading;
  });
});
