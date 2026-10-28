/**
 * Issue #253: Routen für „Eigene Stimme" (/api/speech/voices) mit dem echten
 * Port (src/web/bot-voice-clone.ts), echter Ablage im Temp-Ordner und einer
 * Pocket-Attrappe als Klon-Engine. Einwilligung serverseitig, kein
 * Formular-Upload, Kennzeichnung der Probe, Löschen samt Auswahl. Dazu:
 * Telegram behält seine Wahl, die Auswahl übersteht einen Neustart.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSettings, setSettingsPath, updateSettings, type Settings } from "../src/lib/settings";
import { createSpeech } from "../src/lib/speech/chain";
import type { TtsId } from "../src/lib/speech/ids";
import type { TtsProvider } from "../src/lib/speech/types";
import { AI_CLONED_NOTE, readWavInfo } from "../src/lib/speech/wav";
import { botSettings } from "../src/web/bot-settings";
import { createBotVoiceClone } from "../src/web/bot-voice-clone";
import type { WebServer } from "../src/web/server";
import type { VoiceClonePort } from "../src/web/voice-clone";
import { topicServer } from "./topic-fixture";
import { cleanupCloneWorlds, cloneWorld, recordingWav, type CloneWorldOptions } from "./voice-clone-fixture";

const root = await mkdtemp(join(tmpdir(), "web-voice-clone-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
  cleanupCloneWorlds();
});

async function setup(o: CloneWorldOptions = {}) {
  const w = cloneWorld(o);
  const port = createBotVoiceClone({ clone: () => w.clone, getSettings: w.getSettings, updateSettings: w.updateSettings, log: () => {} });
  const ctx = await topicServer(root, servers, null, { voiceClone: port });
  const upload = (query: string, body: Buffer | string, headers: Record<string, string> = {}) =>
    fetch(`${ctx.origin}/api/speech/voices${query}`, {
      method: "POST",
      headers: { cookie: ctx.cookie, origin: ctx.origin, "content-type": "audio/wav", ...headers },
      body: typeof body === "string" ? body : new Uint8Array(body),
    });
  return { w, ctx, port, upload };
}

const files = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

describe("POST /api/speech/voices: Einwilligung serverseitig", () => {
  test("ohne consent=ja: 400, nichts abgelegt, auch mit gültiger Aufnahme", async () => {
    const { w, upload } = await setup();
    for (const q of ["?name=Alex", "?name=Alex&consent=true", "?name=Alex&consent=1", "?name=Alex&consent=ja&consent=ja", "?name=Alex&consent="]) {
      const res = await upload(q, recordingWav(8));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ reason: "einwilligung" });
    }
    expect(files(w.voices)).toEqual([]);
    expect(existsSync(w.voices)).toBe(false);
  });

  test("Einwilligung prüft der Server vor dem Port: der Port sieht ohne sie keinen Aufruf", async () => {
    const calls: unknown[] = [];
    const port: VoiceClonePort = {
      list: async () => ({ voices: [], engine: { ready: false }, inUse: false, texts: { consent: "", reading: "", probe: "", minSeconds: 5, maxSeconds: 30 } }),
      create: async input => {
        calls.push(input);
        return { ok: false, reason: "format" };
      },
      probe: async () => ({ ok: false, reason: "unbekannt" }),
      use: async () => ({ ok: false, reason: "unbekannt" }),
      remove: async () => false,
    };
    const ctx = await topicServer(root, servers, null, { voiceClone: port });
    const res = await fetch(`${ctx.origin}/api/speech/voices?name=Alex`, { method: "POST", headers: { cookie: ctx.cookie, origin: ctx.origin, "content-type": "audio/wav" }, body: new Uint8Array(recordingWav(8)) });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("mit Einwilligung: 201, Stimme heißt „<Name> (KI-Stimme)\", Einwilligung mit Zeitpunkt und Gerät", async () => {
    const { w, ctx, upload } = await setup();
    const res = await upload("?name=Alex&consent=ja", recordingWav(8), { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1" });
    expect(res.status).toBe(201);
    const { voice } = await res.json();
    expect(voice).toMatchObject({ name: "Alex", label: "Alex (KI-Stimme)", seconds: 8, active: false });
    expect(voice.referencePath).toBeUndefined();
    const stored = await w.clone.voices().get(voice.id);
    expect(stored?.consent.device).toBe("Safari auf iPhone");
    expect(stored?.consent.confirmedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const list = await (await ctx.api("/api/speech/voices")).json();
    expect(list.voices.map((v: { label: string }) => v.label)).toEqual(["Alex (KI-Stimme)"]);
    expect(list.engine).toMatchObject({ ready: true, id: "pocket" });
    expect(list.texts.consent).toContain("ausdrücklich erlaubt");
    expect(list.inUse).toBe(false);
  });
});

describe("POST /api/speech/voices: keine Datei als Referenz", () => {
  test("Formular-Upload (multipart) und andere Typen: 415, nichts abgelegt", async () => {
    const { w, upload } = await setup();
    const form = `--b\r\nContent-Disposition: form-data; name="file"; filename="stimme.wav"\r\nContent-Type: audio/wav\r\n\r\n${recordingWav(8).toString("latin1")}\r\n--b--\r\n`;
    expect((await upload("?name=Alex&consent=ja", form, { "content-type": "multipart/form-data; boundary=b" })).status).toBe(415);
    expect((await upload("?name=Alex&consent=ja", recordingWav(8), { "content-type": "audio/webm" })).status).toBe(415);
    expect((await upload("?name=Alex&consent=ja", recordingWav(8), { "content-type": "application/octet-stream" })).status).toBe(415);
    expect(files(w.voices)).toEqual([]);
  });

  test("ohne Anmeldung 401, fremder Origin 403, nichts abgelegt", async () => {
    const { w, ctx } = await setup();
    const anon = await fetch(`${ctx.origin}/api/speech/voices?name=Alex&consent=ja`, { method: "POST", headers: { origin: ctx.origin, "content-type": "audio/wav" }, body: new Uint8Array(recordingWav(8)) });
    expect(anon.status).toBe(401);
    const foreign = await fetch(`${ctx.origin}/api/speech/voices?name=Alex&consent=ja`, { method: "POST", headers: { cookie: ctx.cookie, origin: "https://evil.example", "content-type": "audio/wav" }, body: new Uint8Array(recordingWav(8)) });
    expect(foreign.status).toBe(403);
    expect((await fetch(`${ctx.origin}/api/speech/voices`)).status).toBe(401);
    expect(files(w.voices)).toEqual([]);
  });

  test("Grenzen: zu groß 413, zu kurz 400, kein WAV 415", async () => {
    const { w, upload } = await setup();
    expect((await upload("?name=Alex&consent=ja", Buffer.alloc(3 * 1_048_576 + 1))).status).toBe(413);
    expect(await (await upload("?name=Alex&consent=ja", recordingWav(3))).json()).toMatchObject({ reason: "zu-kurz" });
    expect((await upload("?name=Alex&consent=ja", Buffer.from("kein wav"))).status).toBe(415);
    expect(files(w.voices)).toEqual([]);
  });
});

describe("Probe, Verwenden, Löschen", () => {
  async function withVoice(o: CloneWorldOptions = {}) {
    const s = await setup(o);
    const res = await s.upload("?name=Alex&consent=ja", recordingWav(8));
    const { voice } = await res.json();
    return { ...s, id: voice.id as string };
  }

  test("Probe liefert WAV mit „KI-generiert, geklonte Stimme\" und startet Pocket nur mit der geprüften Kennung", async () => {
    const { w, ctx, id } = await withVoice();
    const res = await ctx.api(`/api/speech/voices/${id}/probe`, "POST", {});
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(readWavInfo(Buffer.from(await res.arrayBuffer())).ICMT).toBe(AI_CLONED_NOTE);
    expect(w.children).toHaveLength(1);
    const cmd = w.children[0]!.cmd;
    expect(cmd.slice(cmd.indexOf("--clone-dir"))).toEqual(["--clone-dir", w.voices, "--clone-id", id]);
    expect(cmd).not.toContain("--voice");
  });

  test("Probe und Verwenden ohne gültige Einwilligung: 404, keine Ausgabe", async () => {
    const { w, ctx, id } = await withVoice();
    unlinkSync(join(w.voices, id, "consent.json"));
    expect((await ctx.api(`/api/speech/voices/${id}/probe`, "POST", {})).status).toBe(404);
    expect((await ctx.api(`/api/speech/voices/${id}/use`, "POST", {})).status).toBe(404);
    expect(w.children).toHaveLength(0);
    expect(w.state.settings.speech?.cloneVoice).toBeUndefined();
  });

  test("ohne Klon-Engine: Probe und Verwenden 409", async () => {
    const { w, ctx, id } = await withVoice({ pocket: false });
    expect(await (await ctx.api(`/api/speech/voices/${id}/probe`, "POST", {})).json()).toMatchObject({ reason: "engine" });
    expect((await ctx.api(`/api/speech/voices/${id}/use`, "POST", {})).status).toBe(409);
    expect(w.state.settings.speech).toBeUndefined();
    const list = await (await ctx.api("/api/speech/voices")).json();
    expect(list.engine.ready).toBe(false);
    expect(list.engine.reason).toContain("setup sprache");
  });

  test("Verwenden stellt das Vorlesen auf die eigene Stimme, die Liste zeigt sie als gewählt", async () => {
    const { w, ctx, id } = await withVoice({ settings: { speech: { stt: "parakeet", tts: "pocket" } } });
    expect((await ctx.api(`/api/speech/voices/${id}/use`, "POST", {})).status).toBe(200);
    expect(w.state.settings.speech).toEqual({ stt: "parakeet", tts: "clone", cloneVoice: id, telegramTts: "pocket" });
    const list = await (await ctx.api("/api/speech/voices")).json();
    expect(list.inUse).toBe(true);
    expect(list.voices[0]).toMatchObject({ id, active: true });
  });

  test("Löschen entfernt Referenz, Text und Einwilligung, hebt die Auswahl auf und beendet den Pocket-Prozess", async () => {
    const { w, ctx, id } = await withVoice({ settings: { speech: { tts: "browser" } } });
    expect((await ctx.api(`/api/speech/voices/${id}/use`, "POST", {})).status).toBe(200);
    expect((await ctx.api(`/api/speech/voices/${id}/probe`, "POST", {})).status).toBe(200);
    expect(w.children[0]!.killed).toEqual([]);
    const res = await ctx.api(`/api/speech/voices/${id}`, "DELETE");
    expect(res.status).toBe(200);
    expect(existsSync(join(w.voices, id))).toBe(false);
    expect(w.children[0]!.killed).toEqual(["SIGTERM"]);
    expect(w.state.settings.speech).toEqual({ tts: "browser" });
    expect((await ctx.api(`/api/speech/voices/${id}`, "DELETE")).status).toBe(404);
    expect((await ctx.api(`/api/speech/voices/${id}/probe`, "POST", {})).status).toBe(404);
    expect((await (await ctx.api("/api/speech/voices")).json()).voices).toEqual([]);
  });

  test("Löschen während einer laufenden Probe: keine Ausgabe der gelöschten Stimme", async () => {
    const { w, ctx, id } = await withVoice();
    const release = w.hold();
    const probe = ctx.api(`/api/speech/voices/${id}/probe`, "POST", {});
    while (w.ttsTexts.length === 0) await Bun.sleep(5);
    expect((await ctx.api(`/api/speech/voices/${id}`, "DELETE")).status).toBe(200);
    release();
    const res = await probe;
    expect(res.status).not.toBe(200);
  });

  test("unbekannte Methode und Kennung", async () => {
    const { ctx } = await setup();
    expect((await ctx.api("/api/speech/voices", "PATCH", {})).status).toBe(405);
    expect((await ctx.api("/api/speech/voices/0123456789abcdef", "GET")).status).toBe(405);
    expect((await ctx.api("/api/speech/voices/..%2Fx", "DELETE")).status).toBe(404);
    expect((await ctx.api("/api/speech/voices/0123456789abcdef/use", "POST", {})).status).toBe(404);
  });

  test("ohne Port: 503", async () => {
    const ctx = await topicServer(root, servers, null, {});
    expect((await ctx.api("/api/speech/voices")).status).toBe(503);
    const res = await fetch(`${ctx.origin}/api/speech/voices?name=A&consent=ja`, { method: "POST", headers: { cookie: ctx.cookie, origin: ctx.origin, "content-type": "audio/wav" }, body: new Uint8Array(recordingWav(8)) });
    expect(res.status).toBe(503);
  });
});

describe("Telegram behält seine Wahl (Verwenden und Löschen der eigenen Stimme)", () => {
  /** Server-Stimme als Attrappe, zählt Aufrufe */
  function server(id: TtsId): TtsProvider & { calls: number } {
    const p: TtsProvider & { calls: number } = {
      id,
      label: id,
      local: false,
      where: "server",
      calls: 0,
      available: () => ({ ok: true }),
      async synthesize() {
        p.calls++;
        return { audio: recordingWav(1), mime: "audio/wav" };
      },
    };
    return p;
  }

  async function telegramWorld(settings: Settings, ids: TtsId[], env: Record<string, string> = {}) {
    const s = await setup({ settings });
    const res = await s.upload("?name=Alex&consent=ja", recordingWav(8));
    const id = ((await res.json()) as { voice: { id: string } }).voice.id;
    const providers = Object.fromEntries(ids.map(i => [i, server(i)]));
    const speech = createSpeech({ stt: [], tts: [...Object.values(providers), s.w.clone.provider], getSettings: s.w.getSettings, env: () => env, log: () => {}, readFile: async () => Buffer.alloc(0) });
    return { ...s, id, providers, speech };
  }

  for (const fixed of ["pocket", "piper", "elevenlabs"] as const) {
    test(`fest gewählt ${fixed}: Telegram spricht nach Verwenden weiter mit ${fixed}, nach Löschen ist ${fixed} wieder die Wahl`, async () => {
      const t = await telegramWorld({ speech: { tts: fixed } }, ["qwen3-mlx", "elevenlabs", "gemini", "pocket", "piper"].filter(i => i !== fixed).concat(fixed) as TtsId[]);
      expect((await t.port.use(t.id)).ok).toBe(true);
      expect(t.w.state.settings.speech).toEqual({ tts: "clone", cloneVoice: t.id, telegramTts: fixed });
      expect(t.speech.telegramTts()).toBe(fixed);
      expect(await t.speech.synthesizeServer("Hallo")).not.toBeNull();
      expect(t.providers[fixed]!.calls).toBe(1);
      for (const [i, p] of Object.entries(t.providers)) if (i !== fixed) expect(p.calls).toBe(0);
      // Sprechmodus liest mit der eigenen Stimme
      expect(await t.speech.synthesizeSpeech("Hallo")).toMatchObject({ ok: true, provider: "clone" });

      expect(await t.port.remove(t.id)).toBe(true);
      expect(t.w.state.settings.speech).toEqual({ tts: fixed });
      expect(await t.speech.synthesizeServer("Hallo")).not.toBeNull();
      expect(t.providers[fixed]!.calls).toBe(2);
    });
  }

  test("Installation ohne Anbieter der Auto-Kette: fest gewähltes Pocket spricht nach Verwenden weiter in Telegram", async () => {
    const t = await telegramWorld({ speech: { tts: "pocket" } }, ["pocket"]);
    expect(t.speech.isVoiceEnabled()).toBe(true);
    expect((await t.port.use(t.id)).ok).toBe(true);
    expect(t.speech.isVoiceEnabled()).toBe(true);
    expect(await t.speech.synthesizeServer("Hallo")).not.toBeNull();
    expect(t.providers.pocket!.calls).toBe(1);
    expect(await t.port.remove(t.id)).toBe(true);
    expect(t.w.state.settings.speech).toEqual({ tts: "pocket" });
    expect(t.speech.isVoiceEnabled()).toBe(true);
  });

  test("zweimal Verwenden (andere Stimme) behält die gemerkte Telegram-Wahl", async () => {
    const t = await telegramWorld({ speech: { tts: "piper" } }, ["piper"]);
    const second = ((await (await t.upload("?name=Mia&consent=ja", recordingWav(8))).json()) as { voice: { id: string } }).voice.id;
    expect((await t.port.use(t.id)).ok).toBe(true);
    expect((await t.port.use(second)).ok).toBe(true);
    expect(t.w.state.settings.speech).toEqual({ tts: "clone", cloneVoice: second, telegramTts: "piper" });
    // Löschen einer nicht gewählten Stimme lässt alles stehen
    expect(await t.port.remove(t.id)).toBe(true);
    expect(t.w.state.settings.speech).toEqual({ tts: "clone", cloneVoice: second, telegramTts: "piper" });
    expect(await t.port.remove(second)).toBe(true);
    expect(t.w.state.settings.speech).toEqual({ tts: "piper" });
  });

  test("ohne eigene Wahl in der Datei: Telegram folgt SPEECH_TTS, nach Löschen fehlt tts wieder", async () => {
    const t = await telegramWorld({}, ["gemini", "pocket"], { SPEECH_TTS: "pocket" });
    expect((await t.port.use(t.id)).ok).toBe(true);
    expect(t.w.state.settings.speech).toEqual({ tts: "clone", cloneVoice: t.id });
    expect(t.speech.telegramTts()).toBe("pocket");
    expect(await t.speech.synthesizeServer("Hallo")).not.toBeNull();
    expect(t.providers.pocket!.calls).toBe(1);
    expect(t.providers.gemini!.calls).toBe(0);
    expect(await t.port.remove(t.id)).toBe(true);
    expect(t.w.state.settings.speech).toEqual({});
  });
});

describe("Dauerhafte Auswahl: echte Einstellungsdatei, neu eingelesen, neue Instanzen", () => {
  afterEach(() => setSettingsPath());

  /** Port und Kette wie in src/bot.ts, aber auf der Ablage unter root und der aktiven Einstellungsdatei */
  function boot(rootDir?: string) {
    const w = cloneWorld({ ...(rootDir ? { root: rootDir } : {}), getSettings });
    const port = createBotVoiceClone({ clone: () => w.clone, getSettings, updateSettings: mutate => updateSettings(mutate), log: () => {} });
    const pocket: TtsProvider & { calls: number } = {
      id: "pocket",
      label: "Pocket",
      local: true,
      where: "server",
      calls: 0,
      available: () => ({ ok: true }),
      async synthesize() {
        pocket.calls++;
        return { audio: recordingWav(1), mime: "audio/wav" };
      },
    };
    const speech = createSpeech({ stt: [], tts: [pocket, w.clone.provider], getSettings, env: () => ({}), log: () => {}, readFile: async () => Buffer.alloc(0) });
    return { w, port, speech, pocket };
  }

  test("Verwenden überlebt den Neustart, Löschen ebenso", async () => {
    const file = join(root, `settings-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ speech: { stt: "parakeet", tts: "pocket" } }));
    setSettingsPath(file);

    const first = boot();
    const created = await first.w.clone.voices().create({ name: "Alex", consent: true, device: "Chrome auf macOS", audio: recordingWav(8) });
    if (!created.ok) throw new Error("Stimme erwartet");
    const id = created.voice.id;
    expect(await first.port.use(id)).toEqual({ ok: true });

    // Datei selbst: gespeichert, Telegram-Wahl gemerkt
    expect(JSON.parse(readFileSync(file, "utf8")).speech).toEqual({ stt: "parakeet", tts: "clone", cloneVoice: id, telegramTts: "pocket" });

    // Neustart: Datei neu einlesen, alle Instanzen neu
    setSettingsPath(file);
    const second = boot(first.w.root);
    const list = await second.port.list();
    expect(list.inUse).toBe(true);
    expect(list.voices).toHaveLength(1);
    expect(list.voices[0]).toMatchObject({ id, label: "Alex (KI-Stimme)", active: true });
    expect(second.speech.localMode().tts).toMatchObject({ id: "clone", label: "Alex (KI-Stimme)", available: true });
    const spoken = await second.speech.synthesizeSpeech("Hallo");
    expect(spoken).toMatchObject({ ok: true, provider: "clone", mime: "audio/wav" });
    if (spoken.ok) expect(readWavInfo(spoken.audio).ICMT).toBe(AI_CLONED_NOTE);
    expect(second.pocket.calls).toBe(0);
    // Telegram weiter mit Pocket
    expect(await second.speech.synthesizeServer("Hallo")).not.toBeNull();
    expect(second.pocket.calls).toBe(1);

    // Löschen und erneut einlesen
    expect(await second.port.remove(id)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).speech).toEqual({ stt: "parakeet", tts: "pocket" });
    setSettingsPath(file);
    const third = boot(first.w.root);
    const after = await third.port.list();
    expect(after.voices).toEqual([]);
    expect(after.inUse).toBe(false);
    expect(existsSync(join(third.w.voices, id))).toBe(false);
    expect(third.speech.localMode().tts).toMatchObject({ id: "pocket" });
    const spokenAfter = await third.speech.synthesizeSpeech("Hallo");
    expect(spokenAfter).toMatchObject({ ok: true, provider: "pocket" });
    if (spokenAfter.ok) expect(readWavInfo(spokenAfter.audio).ICMT).not.toBe(AI_CLONED_NOTE);
  });

  test("Wechsel über das allgemeine Auswahlfeld: Pocket → Klon → ElevenLabs → Klon, Telegram behält ElevenLabs", async () => {
    const file = join(root, `settings-patch-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ speech: { tts: "pocket" } }));
    setSettingsPath(file);

    const first = boot();
    const created = await first.w.clone.voices().create({ name: "Alex", consent: true, device: "Chrome auf macOS", audio: recordingWav(8) });
    if (!created.ok) throw new Error("Stimme erwartet");
    const id = created.voice.id;
    const ctx = await topicServer(root, servers, null, { settings: botSettings, voiceClone: first.port });
    const choose = async (tts: string) => expect((await ctx.api("/api/settings", "PATCH", { speech: { tts } })).status).toBe(200);
    const stored = () => JSON.parse(readFileSync(file, "utf8")).speech;

    // Pocket → Klon über „Verwenden"
    expect((await ctx.api(`/api/speech/voices/${id}/use`, "POST")).status).toBe(200);
    expect(stored()).toEqual({ tts: "clone", cloneVoice: id, telegramTts: "pocket" });
    // → ElevenLabs und zurück zum Klon, beides über das allgemeine Auswahlfeld
    await choose("elevenlabs");
    expect(stored()).toEqual({ tts: "elevenlabs", cloneVoice: id });
    await choose("clone");
    expect(stored()).toEqual({ tts: "clone", cloneVoice: id, telegramTts: "elevenlabs" });
    expect(first.speech.telegramTts()).toBe("elevenlabs");

    // Neu eingelesen: Telegram weiter mit ElevenLabs
    setSettingsPath(file);
    const second = boot(first.w.root);
    expect(second.speech.telegramTts()).toBe("elevenlabs");

    // Klon-Stimme löschen: Sprechen zurück auf ElevenLabs, Telegram ebenso
    expect(await second.port.remove(id)).toBe(true);
    expect(stored()).toEqual({ tts: "elevenlabs" });
    setSettingsPath(file);
    expect(boot(first.w.root).speech.telegramTts()).toBe("elevenlabs");
  });
});
