/**
 * Issue #250: web:dev mit WEB_DEV_SPEECH=real (scripts/web-dev.ts,
 * createWebDevSpeech in scripts/web-dev-speech.ts). Echter Web-Server mit
 * derselben Chat-Attrappe wie web:dev und der echten Sprach-Kette (createSpeech
 * mit den echten Anbietern). Statt whisper.cpp läuft ein kleines Shell-Skript
 * als whisper-cli, kein echter Anbieter, kein Netz. Dass web:dev dabei
 * src/bot.ts nicht lädt und nichts mit Telegram spricht, prüft
 * tests/web-public.test.ts.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createWebDevSpeech } from "../scripts/web-dev-speech";
import { createDemoAgents } from "../src/web/demo";
import { createFakeChat } from "../src/web/fake-chat";
import { createWebServer, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import { makeRoot, PASSWORD } from "./attachments-fixture";
import { wavSilence } from "./speech-fixture";

const repo = resolve(import.meta.dir, "..");
const root = await makeRoot("web-dev-speech-");
afterAll(() => root.cleanup());
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
});

const HEARD = "Wie wird das Wetter morgen?";

/** whisper-cli-Ersatz: prüft die übergebenen Argumente und gibt einen festen Satz aus */
async function fakeWhisper(dir: string): Promise<{ cli: string; model: string; args: string }> {
  await mkdir(dir, { recursive: true });
  const cli = join(dir, "whisper-cli");
  const model = join(dir, "ggml-test.bin");
  const args = join(dir, "args.txt");
  await writeFile(model, "kein echtes Modell");
  await writeFile(cli, `#!/bin/sh\necho "$@" > "${args}"\necho "${HEARD}"\n`);
  await chmod(cli, 0o755);
  return { cli, model, args };
}

async function start(env: Record<string, string>) {
  const dir = root.next();
  const whisper = await fakeWhisper(join(dir, "bin"));
  const agents = createDemoAgents({ seed: false });
  const lines: string[] = [];
  const real = createWebDevSpeech(agents.settings, {
    env: () => ({ WHISPER_CLI_PATH: whisper.cli, WHISPER_MODEL_PATH: whisper.model, ...env }),
    cwd: () => dir,
    log: line => lines.push(line),
  });
  const store = new ConversationStore({ dir: join(dir, "web") });
  await store.load();
  const conversation = await store.createConversation("general");
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    {
      sessionFile: join(dir, "web-sessions.json"),
      conversationStore: store,
      // Wie web:dev: der Chat bleibt die Attrappe
      chat: createFakeChat({ delayMs: 10, stepMs: 5 }),
      settings: real.settings,
      voice: real.voice,
      speech: real.port,
      log: () => {},
    }
  );
  servers.push(server);
  const origin = server.url;
  const login = await fetch(`${origin}/api/login`, { method: "POST", headers: { origin }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const api = (path: string, method = "GET", body?: unknown) =>
    fetch(`${origin}${path}`, {
      method,
      headers: { origin, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const say = () =>
    fetch(`${origin}/api/conversations/${conversation.id}/speech`, { method: "POST", headers: { origin, cookie, "content-type": "audio/wav" }, body: wavSilence(1.2) });
  return { api, say, whisper, lines, conversationId: conversation.id, settings: agents.settings };
}

describe("web:dev mit WEB_DEV_SPEECH=real", () => {
  test("SPEECH_STT aus der Befehlszeile wählt den echten Anbieter; die Äußerung geht durch die echte Kette, der Chat bleibt die Attrappe", async () => {
    const ctx = await start({ SPEECH_STT: "whisper-cpp" });
    const voice = await (await ctx.api("/api/voice")).json();
    expect(voice.modes.local).toMatchObject({ ready: true, stt: { id: "whisper-cpp", label: "whisper.cpp", available: true }, tts: { id: "browser", where: "browser" } });

    const res = await ctx.say();
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.transcript).toBe(HEARD);
    // Aufgerufen wurde whisper-cli mit dem Modell aus der Umgebung
    const args = await readFile(ctx.whisper.args, "utf8");
    expect(args).toContain(`--model ${ctx.whisper.model}`);
    expect(ctx.lines.some(l => l.includes("whisper-cpp"))).toBe(true);

    // Die Antwort kommt von der Chat-Attrappe
    let messages: any[] = [];
    for (let i = 0; i < 100 && !messages.some(m => m.role === "assistant"); i++) {
      await Bun.sleep(20);
      messages = (await (await ctx.api(`/api/conversations/${ctx.conversationId}/messages`)).json()).messages ?? [];
    }
    expect(messages.find(m => m.id === body.messageId)).toMatchObject({ role: "user", text: HEARD, source: "speech" });
    expect(messages.some(m => m.role === "assistant")).toBe(true);
  });

  test("der Reiter „Sprechen“ zeigt die echten Anbieter; seine Wahl (nur im Speicher) geht der Befehlszeile vor", async () => {
    const ctx = await start({ SPEECH_STT: "whisper-cpp" });
    const before = await (await ctx.api("/api/settings")).json();
    const stt = Object.fromEntries(before.speechOptions.stt.map((o: any) => [o.id, o]));
    expect(stt["whisper-cpp"]).toMatchObject({ available: true });
    // Ohne Schlüssel in der Umgebung sind Cloud-Anbieter nicht verfügbar (die Attrappe meldete Gemini als verfügbar)
    expect(stt.gemini).toMatchObject({ available: false, reason: "GEMINI_API_KEY fehlt" });

    expect((await ctx.api("/api/settings", "PATCH", { speech: { stt: "gemini" } })).status).toBe(200);
    expect(ctx.settings.data().speech).toMatchObject({ stt: "gemini" });
    const voice = await (await ctx.api("/api/voice")).json();
    expect(voice.modes.local).toMatchObject({ ready: false, stt: { id: "gemini", available: false } });
    expect(voice.modes.local.reason).toContain("Gemini");
    const res = await ctx.say();
    expect(res.status).toBe(503);
    expect((await res.json()).reason).toBe("kein-anbieter");
  });

  test("ohne Anbieter: der Status sagt, was fehlt", async () => {
    const ctx = await start({ SPEECH_STT: "whisper-cpp", WHISPER_MODEL_PATH: "/gibt/es/nicht.bin" });
    const voice = await (await ctx.api("/api/voice")).json();
    expect(voice.modes.local).toMatchObject({ ready: false, reason: "Hören: whisper.cpp ist nicht verfügbar (Modelldatei fehlt)" });
  });
});

describe("scripts/web-dev.ts", () => {
  test("Schalter, Kopfkommentar und Verdrahtung: echte Sprach-Schnittstelle, Chat-Attrappe", async () => {
    const source = await readFile(join(repo, "scripts", "web-dev.ts"), "utf8");
    const header = source.slice(0, source.indexOf("*/"));
    expect(header).toContain("WEB_DEV_SPEECH=real SPEECH_STT=whisper-cpp WEB_ENABLED=true WEB_PORT=3199");
    expect(header).toContain("src/bot.ts wird nicht geladen, nichts pollt");
    expect(source).toContain("speech: realSpeech ? realSpeech.port : createDemoSpeech()");
    expect(source).toContain("voice: realSpeech ? realSpeech.voice : createDemoVoice(demoAgents.settings)");
    expect(source).toContain("settings: realSpeech ? realSpeech.settings : demoAgents.settings");
    // Der Chat bleibt in jedem Fall die Attrappe
    expect(source).toContain("chat: createFakeChat(),");
    // Im Code (ohne Kommentare) weder der Bot noch sein Sprachweg
    const code = source.slice(source.indexOf("*/")).replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/bot-speech|getSpeech\(|src\/bot/);
  });
});
