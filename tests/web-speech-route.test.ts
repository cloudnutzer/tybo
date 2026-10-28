/**
 * Issue #249, Checkbox 1: POST /api/conversations/<id>/speech. Echter
 * Web-Server, echter ChatHub, echte Chat-Wege (createBotChat,
 * createTelegramChat) und echte Telegram-Quelle; Erkennung (SpeechPort),
 * Chat-Kern, Nachrichtenspeicher und Telegram sind Attrappen. Kein Modell,
 * kein Netzwerk nach außen.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TurnOptions } from "../src/lib/chat-turn";
import { SPEECH_TURN_HINT } from "../src/lib/speech/spoken-turn";
import { abortExecutions, isExecutionActive, reserveExecution, runCancelable, runExecution } from "../src/lib/execution-context";
import type { Settings } from "../src/lib/settings";
import { createSpeech } from "../src/lib/speech/chain";
import type { SttId } from "../src/lib/speech/ids";
import { SpeechError, type SttProvider } from "../src/lib/speech/types";
import type { HistoryRow } from "../src/lib/store/types";
import type { TopicStateEntry } from "../src/lib/topic-state";
import { createTelegramSource } from "../src/web/bot-telegram";
import { createBotSpeech } from "../src/web/bot-speech";
import { createBotChat, type WebSavedMessage } from "../src/web/bot-turn";
import { createWebServer, type WebServer, type WebServerDeps } from "../src/web/server";
import { isNothingUnderstood, MAX_SPEECH_BYTES, type SpeechPort, type SpeechRecognition } from "../src/web/speech";
import { ConversationStore } from "../src/web/store";
import { UploadStore } from "../src/web/uploads";
import { CLOSED_TOPIC, fakeTelegramChat, GROUP, listen, makeRoot, PASSWORD, TOPIC, USER, type AttachmentCtx } from "./attachments-fixture";
import { audioDurationSeconds, prepareSpeechAudio } from "../src/web/audio-duration";
import { mp3FrameFixture, mp3Id3Fixture, oggOpusFixture } from "./audio-fixture";
import { PNG } from "./media-fixture";
import { AAC_FILL_OVERREAD, mp4Aac, mp4AacFragmented, mp4Fragmented, mp4Opus, oggOpusChained, oggOpusStream, oggPages, wavImaAdpcm, wavSilence, webmLive, webmOpusLaced } from "./speech-fixture";

const root = await makeRoot("web-speech-route-");
afterAll(() => root.cleanup());
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
});

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

/** Erkennung als Attrappe: der Test bestimmt Ergebnis und Zeitpunkt */
function fakeSpeech(initial: SpeechRecognition = { ok: true, text: "Wie wird das Wetter morgen?", provider: "attrappe" }) {
  const state = {
    result: initial as SpeechRecognition | Error,
    calls: [] as { bytes: Uint8Array; mime: string; timeoutMs: number }[],
    /** Wird vor der Antwort abgewartet */
    gate: undefined as Promise<void> | undefined,
    busy: false,
    busyChecks: [] as string[],
  };
  const port: SpeechPort = {
    async recognize(audio, mime, opts) {
      state.calls.push({ bytes: audio.slice(), mime, timeoutMs: opts.timeoutMs });
      if (state.gate) await state.gate;
      if (state.result instanceof Error) throw state.result;
      return state.result;
    },
    synthesize: async () => ({ ok: false, reason: "browser" }),
    isBusy(id) {
      state.busyChecks.push(id);
      return state.busy;
    },
  };
  return { state, port };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => (release = resolve));
  return { promise, release };
}

/**
 * Echter Port aus src/bot.ts: Beschäftigt-Prüfung und Vormerkung über den echten Ausführungskontext.
 * Topic 443 gehört wie im Telegram-Turn der Tests (fakeTelegramChat) dem Agenten finance.
 */
const botPort = (extra: Partial<Parameters<typeof createBotSpeech>[0]> = {}) =>
  createBotSpeech({ userId: USER, groupId: () => GROUP, agentForTopic: topicId => (topicId === 443 ? "finance" : undefined), ...extra });

/**
 * Erkennung als Attrappe, Beschäftigt-Prüfung und Vormerkung echt. beforeReserve
 * und afterReserve laufen unmittelbar vor bzw. nach der letzten Prüfung der
 * Route, synchron und damit ohne Zufall im Ablauf.
 */
function racingSpeech(hooks: { beforeReserve?: () => void; afterReserve?: () => void } = {}) {
  const fake = fakeSpeech();
  const bot = botPort();
  const port: SpeechPort = {
    ...fake.port,
    isBusy: id => bot.isBusy!(id),
    reserve(id, agent) {
      hooks.beforeReserve?.();
      const reservation = bot.reserve!(id, agent);
      hooks.afterReserve?.();
      return reservation;
    },
  };
  return { state: fake.state, port, bot };
}

type SttBehavior = "none" | "blank" | "throw" | "ok";

/**
 * Die ganze Kette wie im Bot: Anbieter-Attrappen in createSpeech, darüber
 * createBotSpeech. Kein Netzwerk, kein Modell.
 */
function chainSpeech(behaviors: Partial<Record<SttId, SttBehavior>>, settings: Settings = {}) {
  const calls: string[] = [];
  const stt: SttProvider[] = (Object.keys(behaviors) as SttId[]).map(id => ({
    id,
    label: id,
    local: false,
    available: () => ({ ok: true }),
    transcribe: async () => {
      calls.push(id);
      if (behaviors[id] === "throw") throw new SpeechError("http", 500);
      if (behaviors[id] === "none") return "";
      if (behaviors[id] === "blank") return " \n\t ";
      return "Wie spät ist es?";
    },
  }));
  const speech = createSpeech({ stt, tts: [], getSettings: () => settings, env: () => ({}), log: () => {}, readFile: async () => Buffer.from("x") });
  return { state: fakeSpeech().state, port: botPort({ speech: () => speech }), calls };
}

interface Ctx extends Pick<AttachmentCtx, "origin" | "cookie"> {
  dir: string;
  webId: string;
  store: ConversationStore;
  rows: HistoryRow[];
  /** Chat-Kern der reinen Web-Gespräche */
  web: { turns: TurnOptions[]; saved: WebSavedMessage[]; core: (o: TurnOptions) => Promise<string> };
  telegram: ReturnType<typeof fakeTelegramChat>["rec"];
  speech: ReturnType<typeof fakeSpeech>["state"];
  uploadsDir: string;
  say(id: string, body: Uint8Array | ReadableStream<Uint8Array> | null, headers?: Record<string, string | null>): Promise<Response>;
  api(path: string, method?: string, body?: unknown): Promise<Response>;
}

async function start(options: { speech?: ReturnType<typeof fakeSpeech> | null; deps?: Partial<WebServerDeps>; chat?: boolean } = {}): Promise<Ctx> {
  const dir = root.next();
  const uploadsDir = join(dir, "uploads");
  const uploads = new UploadStore({ dir: uploadsDir, log: () => {} });
  const rows: HistoryRow[] = [];
  const store = new ConversationStore({ dir: join(dir, "web") });
  await store.load();
  const conversation = await store.createConversation("general");
  const web: Ctx["web"] = { turns: [], saved: [], core: async () => "Morgen wird es sonnig." };
  const chat = createBotChat({
    runStreamingTurn: o => {
      web.turns.push(o);
      return web.core(o);
    },
    saveMessage: async m => {
      web.saved.push(m);
      return true;
    },
    processIntents: async () => {},
    abortEngineCalls: key => abortExecutions(key),
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    log: () => {},
  });
  const tg = fakeTelegramChat(join(dir, "media"));
  const telegram = createTelegramSource({
    userId: USER,
    groupId: () => GROUP,
    topicNames: async () => ({ "443": "Finanzen", "444": "Alt" }),
    topicMapping: () => ({ "443": "finance" }),
    history: async (chatId, topicId) => rows.filter(r => (r as any).chat_id === chatId && ((r.metadata as any)?.topicId ?? null) === topicId),
    activity: async () => [],
    topicState: async () => new Map<number, TopicStateEntry>([[444, { closed: true }]]),
    log: () => {},
  });
  const speech = options.speech === undefined ? fakeSpeech() : options.speech;
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    {
      sessionFile: join(dir, "web-sessions.json"),
      conversationStore: store,
      telegram,
      ...(options.chat === false ? {} : { chat, telegramChat: tg.factory(rows, uploads) }),
      uploads,
      ...(speech ? { speech: speech.port } : {}),
      log: () => {},
      ...options.deps,
    }
  );
  servers.push(server);
  const origin = server.url;
  const login = await fetch(`${origin}/api/login`, { method: "POST", headers: { origin }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  return {
    origin,
    cookie,
    dir,
    webId: conversation.id,
    store,
    rows,
    web,
    telegram: tg.rec,
    speech: (speech ?? fakeSpeech()).state,
    uploadsDir,
    say(id, body, headers = {}) {
      const all: Record<string, string> = { origin, cookie, "content-type": "audio/wav" };
      for (const [k, v] of Object.entries(headers)) {
        if (v === null) delete all[k];
        else all[k] = v;
      }
      return fetch(`${origin}/api/conversations/${id}/speech`, { method: "POST", headers: all, body, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit);
    },
    api(path, method = "GET", body) {
      return fetch(`${origin}${path}`, {
        method,
        headers: { origin, cookie, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
  };
}

/** Alle Dateien unter dir, mit Pfad relativ zu dir */
/**
 * Alle Dateien unter dir. Der Ordner lebt: der Gesprächsspeicher schreibt
 * atomar über name.<pid>.tmp und benennt um, auch nach der Antwort noch. Ein
 * Eintrag, der zwischen readdir und stat verschwindet, enthält keine Daten
 * mehr und fällt weg (CI-Lauf zu #332: ENOENT auf conversations.json.*.tmp).
 */
async function allFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const path = join(dir, name);
    const info = await stat(path).catch(gone);
    if (!info) continue;
    if (info.isDirectory()) out.push(...(await allFiles(path, `${prefix}${name}/`)));
    else out.push(prefix + name);
  }
  return out;
}

/** Inhalt einer Datei aus allFiles; inzwischen umbenannt: null */
async function readIfPresent(path: string): Promise<Buffer | null> {
  return readFile(path).catch(gone);
}

function gone(err: unknown): null {
  if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
  throw err;
}

async function messages(ctx: Ctx, id: string): Promise<any[]> {
  return (await (await ctx.api(`/api/conversations/${id}/messages`)).json()).messages;
}

const WAV = wavSilence(1.2);
/** Echte Aufnahme aus tests/fixtures/recordings */
const recording = async (name: string) => new Uint8Array(await readFile(join(import.meta.dir, "fixtures", "recordings", name)));

describe("Durchsuchen des Datenordners während eines Schreibvorgangs", () => {
  // Ein Link ins Leere steht im Verzeichnis, stat findet ihn nicht: genau der
  // Zustand einer .tmp-Datei, die zwischen readdir und stat umbenannt wurde
  test("ein inzwischen umbenannter Eintrag bricht den Durchlauf nicht ab", async () => {
    const dir = root.next();
    await mkdir(join(dir, "web"), { recursive: true });
    await writeFile(join(dir, "web", "conversations.json"), "[]");
    await symlink(join(dir, "web", "weg"), join(dir, "web", "conversations.json.4711.tmp"));
    expect(await allFiles(dir)).toEqual(["web/conversations.json"]);
    expect(await readIfPresent(join(dir, "web", "conversations.json.4711.tmp"))).toBeNull();
  });

  test("andere Fehler bleiben Fehler", async () => {
    const dir = root.next();
    await mkdir(dir, { recursive: true });
    await expect(readIfPresent(dir)).rejects.toThrow();
  });
});

describe("Äußerung in einem Web-Gespräch", () => {
  test("erkannter Text wird zu genau einem Turn mit source speech, Antwort 202 mit transcript und messageId", async () => {
    const ctx = await start();
    const res = await ctx.say(ctx.webId, WAV);
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.transcript).toBe("Wie wird das Wetter morgen?");
    expect(typeof body.messageId).toBe("string");
    await waitUntil(() => ctx.web.saved.length === 2);

    // Die Erkennung bekam genau die gesendeten Bytes, den Typ aus den Bytes und das Zeitlimit von 30 Sekunden
    expect(ctx.speech.calls).toHaveLength(1);
    expect(ctx.speech.calls[0].mime).toBe("audio/wav");
    expect(ctx.speech.calls[0].timeoutMs).toBe(30_000);
    expect(Buffer.from(ctx.speech.calls[0].bytes).equals(Buffer.from(WAV))).toBe(true);

    // Genau ein Turn im richtigen Gespräch mit dem erkannten Text
    expect(ctx.web.turns).toHaveLength(1);
    expect(ctx.web.turns[0].userMessage).toBe("Wie wird das Wetter morgen?");
    expect(ctx.web.turns[0].chatId).toBe(`web:${ctx.webId}`);
    expect(ctx.web.turns[0].agentName).toBe("general");
    // Der Motor erfährt, dass die Antwort vorgelesen wird; die Nachricht selbst bleibt der erkannte Text
    expect(ctx.web.turns[0].turnHint).toBe(SPEECH_TURN_HINT);

    // Im Nachrichtenspeicher: der erkannte Text, markiert; ebenso die Antwort
    expect(ctx.web.saved[0]).toMatchObject({ role: "user", content: "Wie wird das Wetter morgen?", metadata: { channel: "web", speech: true } });
    expect(ctx.web.saved[1]).toMatchObject({ role: "assistant", content: "Morgen wird es sonnig.", metadata: { channel: "web", speech: true } });

    // Nach erneutem Laden: Nutzernachricht mit source speech unter der gemeldeten ID
    await waitUntil(async () => (await messages(ctx, ctx.webId)).length === 2);
    const [user, reply] = await messages(ctx, ctx.webId);
    expect(user).toMatchObject({ id: body.messageId, role: "user", text: "Wie wird das Wetter morgen?", source: "speech" });
    expect(user.speech).toBeUndefined();
    expect(reply).toMatchObject({ role: "assistant", text: "Morgen wird es sonnig.", speakable: "Morgen wird es sonnig.", speakSegments: ["Morgen wird es sonnig."] });
    expect(reply.source).toBeUndefined();
  });

  test("das Audio wird nirgends abgelegt", async () => {
    const ctx = await start();
    expect((await ctx.say(ctx.webId, WAV)).status).toBe(202);
    await waitUntil(() => ctx.web.saved.length === 2);
    const files = await allFiles(ctx.dir);
    // Nur Sitzungen und die Gesprächsdateien; keine Ablage, keine Arbeitskopie
    expect(await allFiles(ctx.uploadsDir)).toEqual([]);
    for (const name of files) {
      const content = await readIfPresent(join(ctx.dir, name));
      if (!content) continue;
      expect(content.subarray(0, 4).toString("latin1")).not.toBe("RIFF");
      expect(content.length).toBeLessThan(WAV.length);
    }
    // Die gespeicherte Nutzernachricht trägt keinen Anhang
    const [user] = await messages(ctx, ctx.webId);
    expect(user.attachments).toBeUndefined();
    expect(ctx.web.saved[0].metadata?.attachments).toBeUndefined();
  });

  test("getippte Nachricht danach ist nicht markiert", async () => {
    const ctx = await start();
    expect((await ctx.say(ctx.webId, WAV)).status).toBe(202);
    await waitUntil(() => ctx.web.saved.length === 2);
    await waitUntil(async () => (await (await ctx.api(`/api/conversations/${ctx.webId}`)).json()).running === false);
    expect((await ctx.api(`/api/conversations/${ctx.webId}/messages`, "POST", { text: "Und übermorgen?" })).status).toBe(202);
    await waitUntil(() => ctx.web.saved.length === 4);
    expect(ctx.web.saved[2].metadata).toEqual({ channel: "web" });
    expect(ctx.web.turns[1].turnHint).toBeUndefined();
    expect(ctx.web.saved[3].metadata?.speech).toBeUndefined();
    await waitUntil(async () => (await messages(ctx, ctx.webId)).length === 4);
    const list = await messages(ctx, ctx.webId);
    expect(list[2].source).toBeUndefined();
  });

  test("Ogg/Opus wird wie WAV angenommen, der Typ kommt aus den Bytes", async () => {
    const ctx = await start();
    const res = await ctx.say(ctx.webId, oggOpusFixture(), { "content-type": "text/plain" });
    expect(res.status).toBe(202);
    expect(ctx.speech.calls[0].mime).toBe("audio/ogg");
  });
});

describe("nichts verstanden", () => {
  for (const text of ["äh", "Ähm ...", "", "   ", "hm, hm", "[Musik]", "(Räuspern) äh", "a", "?!"]) {
    test(`„${text}" ergibt 422 und keinen Turn`, async () => {
      const ctx = await start({ speech: fakeSpeech({ ok: true, text }) });
      const res = await ctx.say(ctx.webId, WAV);
      expect(res.status).toBe(422);
      expect((await res.json()).reason).toBe("nichts-verstanden");
      await Bun.sleep(20);
      expect(ctx.web.turns).toEqual([]);
      expect(ctx.web.saved).toEqual([]);
      expect(await messages(ctx, ctx.webId)).toEqual([]);
    });
  }

  test("isNothingUnderstood: Füllwörter und Geräusch-Anmerkungen, aber keine echten Antworten", () => {
    for (const filler of ["äh", "Ähm", "öhm", "hm", "Hmm.", "mhm", "eh", "uhm", "um", "äh äh ähm", "[BLANK_AUDIO]", "(Musik)", "x", "7"]) {
      expect(isNothingUnderstood(filler)).toBe(true);
    }
    for (const real of ["Ja", "Nein", "ok", "Äh, ja", "Wie spät ist es?", "42", "Um acht", "Ehe"]) {
      expect(isNothingUnderstood(real)).toBe(false);
    }
  });
});

describe("beschäftigt", () => {
  test("läuft schon ein Turn im Gespräch: 409 beschaeftigt, keine Erkennung, kein zweiter Turn", async () => {
    const ctx = await start();
    const hold = gate();
    ctx.web.core = async () => {
      await hold.promise;
      return "Antwort auf Getipptes";
    };
    expect((await ctx.api(`/api/conversations/${ctx.webId}/messages`, "POST", { text: "getippt" })).status).toBe(202);
    await waitUntil(() => ctx.web.turns.length === 1);
    const res = await ctx.say(ctx.webId, WAV);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("beschaeftigt");
    expect(ctx.speech.calls).toEqual([]);
    hold.release();
    await waitUntil(() => ctx.web.saved.length === 2);
    await Bun.sleep(20);
    expect(ctx.web.turns).toHaveLength(1);
  });

  test("zwei Äußerungen zur selben Zeit: die zweite bekommt 409, es entsteht genau ein Turn", async () => {
    const speech = fakeSpeech();
    const hold = gate();
    speech.state.gate = hold.promise;
    const ctx = await start({ speech });
    const first = ctx.say(ctx.webId, WAV);
    await waitUntil(() => speech.state.calls.length === 1);
    const second = await ctx.say(ctx.webId, WAV);
    expect(second.status).toBe(409);
    expect((await second.json()).reason).toBe("beschaeftigt");
    hold.release();
    expect((await first).status).toBe(202);
    await waitUntil(() => ctx.web.saved.length === 2);
    expect(speech.state.calls).toHaveLength(1);
    expect(ctx.web.turns).toHaveLength(1);
  });

  test("während der Erkennung getippt: der getippte Turn läuft, die Äußerung bekommt 409 und wird nicht dahinter gestapelt", async () => {
    const speech = fakeSpeech();
    const stt = gate();
    speech.state.gate = stt.promise;
    const ctx = await start({ speech });
    const turn = gate();
    ctx.web.core = async () => {
      await turn.promise;
      return "Antwort";
    };
    const spoken = ctx.say(ctx.webId, WAV);
    await waitUntil(() => speech.state.calls.length === 1);
    expect((await ctx.api(`/api/conversations/${ctx.webId}/messages`, "POST", { text: "getippt" })).status).toBe(202);
    await waitUntil(() => ctx.web.turns.length === 1);
    stt.release();
    const res = await spoken;
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("beschaeftigt");
    turn.release();
    await waitUntil(() => ctx.web.saved.length === 2);
    await Bun.sleep(30);
    expect(ctx.web.turns.map(t => t.userMessage)).toEqual(["getippt"]);
    expect((await messages(ctx, ctx.webId)).map(m => m.text)).toEqual(["getippt", "Antwort"]);
  });

  test("Turn aus Telegram läuft schon (gemeinsamer Ausführungsschlüssel): 409 vor der Erkennung", async () => {
    const speech = fakeSpeech();
    speech.state.busy = true;
    const ctx = await start({ speech });
    const res = await ctx.say(TOPIC, WAV);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("beschaeftigt");
    expect(speech.state.busyChecks).toEqual([TOPIC]);
    expect(speech.state.calls).toEqual([]);
    expect(ctx.telegram.turns).toEqual([]);
  });

  test("Turn aus Telegram beginnt während der Erkennung: 409 danach, kein Turn, nichts gespiegelt", async () => {
    const speech = fakeSpeech();
    const stt = gate();
    speech.state.gate = stt.promise;
    const ctx = await start({ speech });
    const spoken = ctx.say(TOPIC, WAV);
    await waitUntil(() => speech.state.calls.length === 1);
    speech.state.busy = true;
    stt.release();
    const res = await spoken;
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("beschaeftigt");
    await Bun.sleep(20);
    expect(ctx.telegram.turns).toEqual([]);
    expect(ctx.telegram.plain).toEqual([]);
    expect(ctx.telegram.saved).toEqual([]);
  });

  test("Wettlauf: Telegram ruft unmittelbar nach der letzten Prüfung runExecution für Schlüssel und Agent auf, der Sprech-Turn läuft trotzdem zuerst", async () => {
    const key = `topic:${GROUP}:443`;
    const order: string[] = [];
    const telegram = gate();
    let update: Promise<void> | undefined;
    const speech = racingSpeech({
      afterReserve: () => {
        // Der Sprech-Turn hat sein runExecution noch nicht erreicht (erst Nachricht ablegen, dann spiegeln).
        // Genau jetzt kommt ein Telegram-Update wie in src/bot.ts: Update-Bereich und darin der Aufruf des
        // Agenten unter demselben Schlüssel und Agenten. Ohne Platz in der Warteschlange liefe er sofort los
        update = runCancelable(key, () =>
          runExecution(key, "finance", async () => {
            order.push("telegram:start");
            await telegram.promise;
            order.push("telegram:ende");
          })
        );
      },
    });
    const ctx = await start({ speech });
    const turn = gate();
    ctx.telegram.core = async o => {
      order.push(`sprech:start:${o.agentName}`);
      await turn.promise;
      order.push("sprech:ende");
      return "Antwort";
    };
    const res = await ctx.say(TOPIC, WAV);
    expect(res.status).toBe(202);
    await waitUntil(() => ctx.telegram.turns.length === 1);
    expect(ctx.telegram.turns[0]!.userMessage).toBe("Wie wird das Wetter morgen?");
    // Der Telegram-Turn rief runExecution zuerst auf und wartet trotzdem hinter dem Sprech-Turn
    await Bun.sleep(30);
    expect(order).toEqual(["sprech:start:finance"]);
    expect(isExecutionActive(key)).toBe(true);
    const second = await ctx.say(TOPIC, WAV);
    expect(second.status).toBe(409);
    turn.release();
    // Erst nach dem Sprech-Turn ist der Telegram-Turn an der Reihe
    await waitUntil(() => order.includes("telegram:start"));
    expect(order).toEqual(["sprech:start:finance", "sprech:ende", "telegram:start"]);
    telegram.release();
    await update;
    expect(order).toEqual(["sprech:start:finance", "sprech:ende", "telegram:start", "telegram:ende"]);
    // Vormerkung und Warteschlange sind danach leer: das Gespräch ist wieder frei
    await waitUntil(() => !isExecutionActive(key));
    expect(ctx.telegram.turns).toHaveLength(1);
    expect(speech.state.calls).toHaveLength(1);
    ctx.telegram.core = async () => "Antwort";
    expect((await ctx.say(TOPIC, WAV)).status).toBe(202);
    await waitUntil(() => !isExecutionActive(key));
  });

  test("Wettlauf: Telegram ruft unmittelbar vor der letzten Prüfung runExecution auf, die Äußerung bekommt 409 und wird nie gestapelt", async () => {
    const key = `topic:${GROUP}:443`;
    const order: string[] = [];
    const telegram = gate();
    let update: Promise<void> | undefined;
    const speech = racingSpeech({
      beforeReserve: () => {
        update = runCancelable(key, () =>
          runExecution(key, "finance", async () => {
            order.push("telegram:start");
            await telegram.promise;
          })
        );
      },
    });
    const ctx = await start({ speech });
    ctx.telegram.core = async () => {
      order.push("sprech:start");
      return "Antwort";
    };
    const res = await ctx.say(TOPIC, WAV);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("beschaeftigt");
    // Erkannt wurde (der Turn aus Telegram begann erst danach), gestartet nichts
    expect(speech.state.calls).toHaveLength(1);
    telegram.release();
    await update;
    await Bun.sleep(30);
    expect(order).toEqual(["telegram:start"]);
    expect(ctx.telegram.turns).toEqual([]);
    expect(ctx.telegram.plain).toEqual([]);
    expect(ctx.telegram.saved).toEqual([]);
    // Nichts vorgemerkt geblieben
    expect(isExecutionActive(key)).toBe(false);
  });

  test("Wettlauf im Web-Gespräch: schon während die Nutzernachricht abgelegt wird, ist der Ausführungsschlüssel belegt", async () => {
    const speech = racingSpeech();
    const ctx = await start({ speech });
    const key = `web:${ctx.webId}`;
    const append = gate();
    let appending = 0;
    const original = ctx.store.appendMessage.bind(ctx.store);
    ctx.store.appendMessage = async (id, message) => {
      if (message.role === "user") {
        appending++;
        await append.promise;
      }
      return original(id, message);
    };
    const spoken = ctx.say(ctx.webId, WAV);
    await waitUntil(() => appending === 1);
    // Zwischen letzter Prüfung und runCancelable des Turns: kein Turn läuft, aber der Schlüssel ist belegt
    expect(ctx.web.turns).toEqual([]);
    expect(isExecutionActive(key)).toBe(true);
    expect(speech.bot.isBusy!(ctx.webId)).toBe(true);
    expect(speech.bot.reserve!(ctx.webId, "general")).toBeNull();
    append.release();
    expect((await spoken).status).toBe(202);
    await waitUntil(() => ctx.web.saved.length === 2);
    await waitUntil(() => !isExecutionActive(key));
    expect(ctx.web.turns).toHaveLength(1);
  });

  test("Vormerkung bleibt nie hängen: Ablegen der Nachricht scheitert, Server wird beendet", async () => {
    const speech = racingSpeech();
    const ctx = await start({ speech });
    const key = `web:${ctx.webId}`;
    const original = ctx.store.appendMessage.bind(ctx.store);
    ctx.store.appendMessage = async () => {
      throw new Error("Platte voll");
    };
    const failed = await ctx.say(ctx.webId, WAV);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    await waitUntil(() => !isExecutionActive(key));
    expect(ctx.web.turns).toEqual([]);
    ctx.store.appendMessage = original;
    expect((await ctx.say(ctx.webId, WAV)).status).toBe(202);
    await waitUntil(() => ctx.web.saved.length === 2);
    await waitUntil(() => !isExecutionActive(key));
  });

  test("reserveExecution: prüft und belegt in einem Schritt, Freigabe genau einmal wirksam", async () => {
    const key = "topic:-100999:7";
    const first = reserveExecution(key, "general")!;
    expect(first).not.toBeNull();
    expect(isExecutionActive(key)).toBe(true);
    expect(reserveExecution(key, "general")).toBeNull();
    expect(isExecutionActive("topic:-100999:8")).toBe(false);
    first.release();
    expect(isExecutionActive(key)).toBe(false);
    const again = reserveExecution(key, "general")!;
    // Die alte Freigabe löst die neue Vormerkung nicht
    first.release();
    expect(isExecutionActive(key)).toBe(true);
    again.release();
    // Läuft schon ein Update-Bereich (Telegram), gibt es keine Vormerkung
    const hold = gate();
    const running = runCancelable(key, () => hold.promise);
    expect(reserveExecution(key, "general")).toBeNull();
    hold.release();
    await running;
    expect(isExecutionActive(key)).toBe(false);
  });

  test("reserveExecution: die Vormerkung hält den Platz in der Session-Warteschlange, der vorgemerkte Turn übernimmt ihn", async () => {
    const key = "topic:-100999:9";
    const order: string[] = [];
    const reservation = reserveExecution(key, "general")!;
    // Später gekommen, aber früher bei runExecution: wartet hinter der Vormerkung
    const later = runExecution(key, "general", async () => {
      order.push("später");
    });
    // Ein anderer Agent im selben Gespräch hat seine eigene Warteschlange
    await runExecution(key, "critic", async () => {
      order.push("anderer Agent");
    });
    await Bun.sleep(20);
    expect(order).toEqual(["anderer Agent"]);
    const hold = gate();
    const owner = runCancelable(
      key,
      () =>
        runExecution(key, "general", async () => {
          order.push("vorgemerkt");
          await hold.promise;
        }),
      { reservation }
    );
    await Bun.sleep(20);
    expect(order).toEqual(["anderer Agent", "vorgemerkt"]);
    hold.release();
    await owner;
    await later;
    expect(order).toEqual(["anderer Agent", "vorgemerkt", "später"]);
    // Übernommen und beendet: die Freigabe hebt nur noch die Belegung auf
    expect(isExecutionActive(key)).toBe(true);
    reservation.release();
    expect(isExecutionActive(key)).toBe(false);
  });

  test("reserveExecution: nur wer die Vormerkung mitbringt, übernimmt den Platz; ohne Übernahme gibt die Freigabe ihn weiter", async () => {
    const key = "topic:-100999:10";
    const order: string[] = [];
    const reservation = reserveExecution(key, "general")!;
    // Fremde Vormerkung (anderer Schlüssel) und gar keine: beide stellen sich hinten an
    const foreign = reserveExecution("topic:-100999:11", "general")!;
    const a = runCancelable(key, () => runExecution(key, "general", async () => void order.push("a")), { reservation: foreign });
    const b = runCancelable(key, () => runExecution(key, "general", async () => void order.push("b")));
    await Bun.sleep(20);
    expect(order).toEqual([]);
    foreign.release();
    // Der vorgemerkte Turn kam nie bis runExecution (etwa Spiegeln gescheitert): Freigabe lässt die Wartenden in Reihenfolge laufen
    reservation.release();
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
    expect(isExecutionActive(key)).toBe(false);
  });

  test("createBotSpeech: reserve nutzt Schlüssel und Agent des Gesprächs, ohne ermittelbaren Schlüssel nichts vorzumerken", async () => {
    const port = botPort();
    const topic = port.reserve!(TOPIC, "general")!;
    expect(isExecutionActive(`topic:${GROUP}:443`)).toBe(true);
    expect(port.isBusy!(TOPIC)).toBe(true);
    expect(port.reserve!(TOPIC, "general")).toBeNull();
    // Reserviert ist die Warteschlange des Topic-Agenten (finance), nicht die des übergebenen
    const order: string[] = [];
    const general = runExecution(`topic:${GROUP}:443`, "general", async () => void order.push("general"));
    const finance = runExecution(`topic:${GROUP}:443`, "finance", async () => void order.push("finance"));
    await general;
    await Bun.sleep(20);
    expect(order).toEqual(["general"]);
    topic.release();
    await finance;
    expect(order).toEqual(["general", "finance"]);
    expect(port.isBusy!(TOPIC)).toBe(false);
    const dm = port.reserve!("dm", "general")!;
    expect(isExecutionActive(`dm:${USER}`)).toBe(true);
    dm.release();
    // Web-Gespräch: Schlüssel web:<id>, Agent wie übergeben
    const webId = "0b3c6a2e-1f00-4c1a-9d0e-2a4b6c8d0e1f";
    const web = port.reserve!(webId, "research")!;
    expect(isExecutionActive(`web:${webId}`)).toBe(true);
    web.release();
    expect(isExecutionActive(`web:${webId}`)).toBe(false);
    // Ohne Gruppe gibt es für ein Topic keinen Schlüssel: nicht beschäftigt, Freigabe ohne Wirkung
    const noGroup = createBotSpeech({ userId: USER, groupId: () => undefined as any, agentForTopic: () => undefined });
    const free = noGroup.reserve!(TOPIC, "general");
    expect(free).not.toBeNull();
    free!.release();
  });

  test("createBotSpeech: beschäftigt folgt dem Ausführungsschlüssel des Gesprächs, auch für Telegram-Turns", async () => {
    const port = createBotSpeech({ userId: USER, groupId: () => GROUP, agentForTopic: () => undefined });
    const webId = "0b3c6a2e-1f00-4c1a-9d0e-2a4b6c8d0e1f";
    expect(port.isBusy!(TOPIC)).toBe(false);
    expect(port.isBusy!("dm")).toBe(false);
    expect(port.isBusy!(webId)).toBe(false);
    const hold = gate();
    // Wie ein Telegram-Update in src/bot.ts: runCancelable unter dem Schlüssel des Topics
    const running = runCancelable(`topic:${GROUP}:443`, () => hold.promise);
    expect(isExecutionActive(`topic:${GROUP}:443`)).toBe(true);
    expect(port.isBusy!(TOPIC)).toBe(true);
    expect(port.isBusy!("dm")).toBe(false);
    hold.release();
    await running;
    expect(port.isBusy!(TOPIC)).toBe(false);
    const dm = runCancelable(`dm:${USER}`, () => Bun.sleep(10));
    expect(port.isBusy!("dm")).toBe(true);
    await dm;
    const web = runCancelable(`web:${webId}`, () => Bun.sleep(10));
    expect(port.isBusy!(webId)).toBe(true);
    await web;
  });
});

describe("Grenzen", () => {
  test("über 2 MB mit Content-Length: 413 zu-gross ohne Erkennung", async () => {
    const ctx = await start();
    const res = await ctx.say(ctx.webId, new Uint8Array(MAX_SPEECH_BYTES + 1));
    expect(res.status).toBe(413);
    expect((await res.json()).reason).toBe("zu-gross");
    expect(ctx.speech.calls).toEqual([]);
  });

  test("über 2 MB ohne Content-Length (Strom): 413 zu-gross ohne Erkennung", async () => {
    const ctx = await start();
    const big = wavSilence(70);
    expect(big.length).toBeGreaterThan(MAX_SPEECH_BYTES);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= big.length) return controller.close();
        controller.enqueue(big.subarray(sent, sent + 65_536));
        sent += 65_536;
      },
    });
    const res = await ctx.say(ctx.webId, stream);
    expect(res.status).toBe(413);
    expect((await res.json()).reason).toBe("zu-gross");
    expect(ctx.speech.calls).toEqual([]);
  });

  test("genau 60 Sekunden WAV gehen durch, 61 Sekunden ergeben 413 zu-lang", async () => {
    const ctx = await start();
    const ok = wavSilence(60);
    expect(ok.length).toBeLessThanOrEqual(MAX_SPEECH_BYTES);
    expect((await ctx.say(ctx.webId, ok)).status).toBe(202);
    await waitUntil(() => ctx.web.saved.length === 2);
    await waitUntil(async () => (await (await ctx.api(`/api/conversations/${ctx.webId}`)).json()).running === false);
    const long = wavSilence(61);
    expect(long.length).toBeLessThanOrEqual(MAX_SPEECH_BYTES);
    const res = await ctx.say(ctx.webId, long);
    expect(res.status).toBe(413);
    expect((await res.json()).reason).toBe("zu-lang");
    expect(ctx.speech.calls).toHaveLength(1);
  });

  test("komprimiert und klein, aber länger als 60 Sekunden: 413 zu-lang", async () => {
    const ctx = await start();
    const long = webmLive(90);
    expect(long.length).toBeLessThan(50_000);
    const res = await ctx.say(ctx.webId, long);
    expect(res.status).toBe(413);
    expect((await res.json()).reason).toBe("zu-lang");
    expect(ctx.speech.calls).toEqual([]);
  });

  test("verkettetes Ogg, 80 Sekunden in zwei Streams zu 40: 413 zu-lang, keine Erkennung, kein Turn", async () => {
    const ctx = await start();
    const chained = oggOpusChained(40, 40);
    expect(chained.length).toBeLessThan(20_000);
    const res = await ctx.say(ctx.webId, chained, { "content-type": "audio/ogg" });
    expect(res.status).toBe(413);
    expect((await res.json()).reason).toBe("zu-lang");
    const topic = await ctx.say(TOPIC, oggOpusChained(30, 31), { "content-type": "audio/ogg" });
    expect(topic.status).toBe(413);
    await Bun.sleep(20);
    expect(ctx.speech.calls).toEqual([]);
    expect(ctx.web.turns).toEqual([]);
    expect(ctx.telegram.turns).toEqual([]);
    expect(ctx.telegram.plain).toEqual([]);
    expect(await messages(ctx, ctx.webId)).toEqual([]);
    // Ein einzelner Stream und eine Kette unter der Grenze gehen weiter durch
    expect((await ctx.say(ctx.webId, oggOpusChained(20, 20), { "content-type": "audio/ogg" })).status).toBe(202);
    await waitUntil(() => ctx.web.saved.length === 2);
    await waitUntil(async () => (await (await ctx.api(`/api/conversations/${ctx.webId}`)).json()).running === false);
    expect((await ctx.say(ctx.webId, oggOpusStream(40), { "content-type": "audio/ogg" })).status).toBe(202);
    await waitUntil(() => ctx.web.saved.length === 4);
    expect(ctx.speech.calls.map(c => c.mime)).toEqual(["audio/ogg", "audio/ogg"]);
  });

  test("komprimiertes WAV (IMA ADPCM, 80 Sekunden, unter 2 MB): abgelehnt ohne Erkennung, Turn, Speicherung oder Spiegelung", async () => {
    const ctx = await start();
    const adpcm = wavImaAdpcm(80);
    expect(adpcm.length).toBeLessThan(MAX_SPEECH_BYTES);
    const res = await ctx.say(ctx.webId, adpcm);
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("dauer-unbekannt");
    const topic = await ctx.say(TOPIC, adpcm);
    expect(topic.status).toBe(400);
    expect((await topic.json()).reason).toBe("dauer-unbekannt");
    // Auch eine kurze komprimierte Aufnahme geht nicht durch: die Dauer wird nie geraten
    expect((await ctx.say(ctx.webId, wavImaAdpcm(5))).status).toBe(400);
    await Bun.sleep(20);
    expect(ctx.speech.calls).toEqual([]);
    expect(ctx.web.turns).toEqual([]);
    expect(ctx.web.saved).toEqual([]);
    expect(await messages(ctx, ctx.webId)).toEqual([]);
    expect(ctx.telegram.turns).toEqual([]);
    expect(ctx.telegram.saved).toEqual([]);
    expect(ctx.telegram.plain).toEqual([]);
    expect(ctx.telegram.agentSends).toEqual([]);
    expect(await messages(ctx, TOPIC)).toEqual([]);
    // Das Gespräch bleibt frei: unkomprimiertes WAV geht danach durch
    expect((await ctx.say(ctx.webId, WAV)).status).toBe(202);
    await waitUntil(() => ctx.web.saved.length === 2);
  });

  test("WebM mit gebündelten Paketen (80 Sekunden in drei Blöcken, letzter Blockanfang bei 57,6): 413 zu-lang ohne Erkennung, Turn, Speicherung oder Spiegelung", async () => {
    const ctx = await start();
    const laced = webmOpusLaced(667);
    expect(laced.length).toBeLessThan(11_000);
    const res = await ctx.say(ctx.webId, laced, { "content-type": "audio/webm" });
    expect(res.status).toBe(413);
    expect((await res.json()).reason).toBe("zu-lang");
    const topic = await ctx.say(TOPIC, laced, { "content-type": "audio/webm" });
    expect(topic.status).toBe(413);
    expect((await topic.json()).reason).toBe("zu-lang");
    // Auch mit stehenden Zeitstempeln, zu kleiner Duration und knapp über der Grenze
    for (const file of [webmOpusLaced(667, { frozenTime: true }), webmOpusLaced(667, { durationMs: 5_000 }), webmOpusLaced(501, { lacing: "ebml" })]) {
      expect((await ctx.say(ctx.webId, file, { "content-type": "audio/webm" })).status).toBe(413);
      expect((await ctx.say(TOPIC, file, { "content-type": "audio/webm" })).status).toBe(413);
    }
    await Bun.sleep(20);
    expect(ctx.speech.calls).toEqual([]);
    expect(ctx.web.turns).toEqual([]);
    expect(ctx.web.saved).toEqual([]);
    expect(await messages(ctx, ctx.webId)).toEqual([]);
    expect(ctx.telegram.turns).toEqual([]);
    expect(ctx.telegram.saved).toEqual([]);
    expect(ctx.telegram.plain).toEqual([]);
    expect(ctx.telegram.agentSends).toEqual([]);
    expect(await messages(ctx, TOPIC)).toEqual([]);
    // Das Gespräch bleibt frei: dieselbe Bündelung mit genau 60 Sekunden geht durch
    expect((await ctx.say(ctx.webId, webmOpusLaced(500), { "content-type": "audio/webm" })).status).toBe(202);
    await waitUntil(() => ctx.web.saved.length === 2);
    // An die Erkennung geht das neu geschriebene Ogg/Opus mit denselben Paketen
    expect(ctx.speech.calls.map(c => c.mime)).toEqual(["audio/ogg"]);
  });

  test("WebM, dessen Dauer sich nicht sicher bestimmen lässt (anderer Codec, abgeschnitten): 400 dauer-unbekannt ohne Erkennung, Turn, Speicherung oder Spiegelung", async () => {
    const ctx = await start();
    const whole = webmOpusLaced(667);
    for (const file of [webmOpusLaced(667, { codec: "A_VORBIS" }), whole.subarray(0, whole.length - 100)]) {
      const res = await ctx.say(ctx.webId, file, { "content-type": "audio/webm" });
      expect(res.status).toBe(400);
      expect((await res.json()).reason).toBe("dauer-unbekannt");
      const topic = await ctx.say(TOPIC, file, { "content-type": "audio/webm" });
      expect(topic.status).toBe(400);
      expect((await topic.json()).reason).toBe("dauer-unbekannt");
    }
    await Bun.sleep(20);
    expect(ctx.speech.calls).toEqual([]);
    expect(ctx.web.turns).toEqual([]);
    expect(ctx.web.saved).toEqual([]);
    expect(await messages(ctx, ctx.webId)).toEqual([]);
    expect(ctx.telegram.turns).toEqual([]);
    expect(ctx.telegram.saved).toEqual([]);
    expect(ctx.telegram.plain).toEqual([]);
    expect(ctx.telegram.agentSends).toEqual([]);
    expect(await messages(ctx, TOPIC)).toEqual([]);
  });

  test("MP4 mit zwei AAC-Frames je Sample (80 Sekunden Ton, Tabelle und Kopf nennen 40): 400 dauer-unbekannt ohne Erkennung, Turn, Speicherung oder Spiegelung (Regression Runde 5)", async () => {
    const ctx = await start();
    // Wie in der Prüfung: 3750 AAC-Frames in mdat, stsz nennt 1875 Samples zu 8 Bytes, stts und stsc ebenso
    const packed = mp4Aac(3750, { headerSeconds: 40, framesPerSample: 2 });
    expect(packed.length).toBe(15_568);
    for (const file of [packed, mp4Aac(3750, { framesPerSample: 10 }), mp4Aac(3750, { headerSeconds: 1, framesPerSample: 3750 })]) {
      const res = await ctx.say(ctx.webId, file, { "content-type": "audio/mp4" });
      expect(res.status).toBe(400);
      expect((await res.json()).reason).toBe("dauer-unbekannt");
      const topic = await ctx.say(TOPIC, file, { "content-type": "audio/mp4" });
      expect(topic.status).toBe(400);
      expect((await topic.json()).reason).toBe("dauer-unbekannt");
    }
    await Bun.sleep(20);
    expect(ctx.speech.calls).toEqual([]);
    expect(ctx.web.turns).toEqual([]);
    expect(ctx.web.saved).toEqual([]);
    expect(await messages(ctx, ctx.webId)).toEqual([]);
    expect(ctx.telegram.turns).toEqual([]);
    expect(ctx.telegram.saved).toEqual([]);
    expect(ctx.telegram.plain).toEqual([]);
    expect(ctx.telegram.agentSends).toEqual([]);
    expect(await messages(ctx, TOPIC)).toEqual([]);
    expect(await allFiles(ctx.uploadsDir)).toEqual([]);
    // Das Gespräch bleibt frei: WAV geht danach durch
    expect((await ctx.say(ctx.webId, WAV)).status).toBe(202);
    await waitUntil(() => ctx.web.saved.length === 2);
    expect(ctx.speech.calls.map(c => c.mime)).toEqual(["audio/wav"]);
  });

  test("kurze, gültige MP4-Aufnahme (AAC-LC, fragmentiert, Stereo, Opus wie aus Chrome): genau ein Turn im Web-Gespräch und im Topic, an die Erkennung geht die neu geschriebene Datei (Befund Runde 6)", async () => {
    const ctx = await start();
    // [Upload, Typ und Dauer dessen, was an die Erkennung geht]
    const uploads: [Uint8Array, string, number][] = [
      // Die Gegenprobe aus der Prüfung: 756 Bytes, rund eine Sekunde
      [mp4Aac(47), "audio/mp4", (47 * 1024) / 48_000],
      [mp4Fragmented(3), "audio/mp4", (141 * 1024) / 48_000],
      [await recording("chrome-aac.mp4"), "audio/mp4", (71 * 1024) / 48_000],
      [await recording("moov-end-aac.mp4"), "audio/mp4", (6 * 1024) / 16_000],
      [await recording("apple-aac.m4a"), "audio/mp4", (19 * 1024) / 24_000],
      [await recording("chrome-opus.mp4"), "audio/ogg", 1.5],
    ];
    expect(uploads[0][0].length).toBe(756);
    let n = 0;
    for (const [file] of uploads) {
      n++;
      const web = await ctx.say(ctx.webId, file, { "content-type": "audio/mp4" });
      expect(web.status).toBe(202);
      expect((await web.json()).transcript).toBe("Wie wird das Wetter morgen?");
      await waitUntil(() => ctx.web.saved.length === 2 * n);
      await waitUntil(async () => (await (await ctx.api(`/api/conversations/${ctx.webId}`)).json()).running === false);
      const topic = await ctx.say(TOPIC, file, { "content-type": "audio/mp4" });
      expect(topic.status).toBe(202);
      await waitUntil(() => ctx.telegram.saved.length === 2 * n);
      await waitUntil(() => ctx.telegram.agentSends.length === n);
      // Je Äußerung genau ein Turn im richtigen Gespräch
      expect(ctx.web.turns).toHaveLength(n);
      expect(ctx.telegram.turns).toHaveLength(n);
    }
    expect(ctx.web.turns.every(t => t.userMessage === "Wie wird das Wetter morgen?" && t.chatId === `web:${ctx.webId}`)).toBe(true);
    expect(ctx.telegram.turns.every(t => t.userMessage === "Wie wird das Wetter morgen?" && t.topicId === 443)).toBe(true);
    expect(ctx.telegram.plain).toHaveLength(uploads.length);
    // An die Erkennung ging je Äußerung einmal die neu geschriebene Datei: ihre Einheiten ergeben die gezählte Dauer
    expect(ctx.speech.calls).toHaveLength(2 * uploads.length);
    uploads.forEach(([file, mime, seconds], i) => {
      for (const call of [ctx.speech.calls[2 * i], ctx.speech.calls[2 * i + 1]]) {
        expect(call.mime).toBe(mime);
        expect(audioDurationSeconds(call.bytes, call.mime)).toBe(seconds);
        expect(Buffer.from(call.bytes).equals(Buffer.from(file))).toBe(false);
        // Fixpunkt: noch einmal vorbereitet sind es dieselben Bytes
        expect(Buffer.from(prepareSpeechAudio(call.bytes, call.mime)!.audio).equals(Buffer.from(call.bytes))).toBe(true);
      }
    });
    // Nichts abgelegt
    expect(await allFiles(ctx.uploadsDir)).toEqual([]);
  });

  test("überlange oder manipulierte MP4-Aufnahme: abgelehnt ohne Erkennung, Turn, Speicherung oder Spiegelung, gleich was Kopf, Sample-Tabelle und Fragmente nennen", async () => {
    const ctx = await start();
    const whole = mp4Aac(100);
    const moved = whole.slice();
    new DataView(moved.buffer).setUint32(Buffer.from(moved).indexOf("stco") + 4 + 8, whole.length - 399);
    const files: [Uint8Array, number, string][] = [
      // Tatsächlich zu lang: ehrlich, fragmentiert, knapp über der Grenze, Opus im MP4
      [mp4Aac(3750), 413, "zu-lang"],
      [mp4Fragmented(75), 413, "zu-lang"],
      [mp4Aac(2813), 413, "zu-lang"],
      [mp4Opus(3001), 413, "zu-lang"],
      // Die Fälle aus Runde 4: Kopf-Angaben klein, tfdt zurückgesetzt, Sample-Dauer klein, widersprüchliche Tabelle
      [mp4Aac(3750, { headerSeconds: 1 }), 413, "zu-lang"],
      [mp4AacFragmented([2813, 469], { tfdt: () => 0 }), 413, "zu-lang"],
      [mp4Aac(3750, { headerSeconds: 1, sampleDelta: 12 }), 413, "zu-lang"],
      [mp4Aac(3750, { headerSeconds: 1, sttsSamples: 47 }), 413, "zu-lang"],
      [mp4Opus(3750, { headerSeconds: 1, sampleDelta: 1 }), 413, "zu-lang"],
      [mp4Aac(3000, { headerSeconds: 1, frame: AAC_FILL_OVERREAD }), 413, "zu-lang"],
      // Nicht bestimmbar: AAC in einem Eintrag, der Opus heißt, SBR als Objekttyp, Samples neben den Frames, abgeschnitten
      [mp4Aac(3750, { headerSeconds: 1, entry: "Opus" }), 400, "dauer-unbekannt"],
      [mp4Aac(100, { asc: [0x2b, 0x8b, 0x08, 0x80] }), 400, "dauer-unbekannt"],
      [moved, 400, "dauer-unbekannt"],
      [whole.subarray(0, whole.length - 2), 400, "dauer-unbekannt"],
    ];
    for (const [file, status, reason] of files) {
      const res = await ctx.say(ctx.webId, file, { "content-type": "audio/mp4" });
      expect(res.status).toBe(status);
      expect((await res.json()).reason).toBe(reason);
      const topic = await ctx.say(TOPIC, file, { "content-type": "audio/mp4" });
      expect(topic.status).toBe(status);
      expect((await topic.json()).reason).toBe(reason);
    }
    await Bun.sleep(20);
    expect(ctx.speech.calls).toEqual([]);
    expect(ctx.web.turns).toEqual([]);
    expect(ctx.web.saved).toEqual([]);
    expect(await messages(ctx, ctx.webId)).toEqual([]);
    expect(ctx.telegram.turns).toEqual([]);
    expect(ctx.telegram.saved).toEqual([]);
    expect(ctx.telegram.plain).toEqual([]);
    expect(ctx.telegram.agentSends).toEqual([]);
    expect(await messages(ctx, TOPIC)).toEqual([]);
    expect(await allFiles(ctx.uploadsDir)).toEqual([]);
    // Das Gespräch bleibt frei: dieselbe Art Aufnahme knapp unter der Grenze geht durch
    expect((await ctx.say(ctx.webId, mp4Aac(2812, { headerSeconds: 1 }), { "content-type": "audio/mp4" })).status).toBe(202);
    await waitUntil(() => ctx.web.saved.length === 2);
    expect(ctx.speech.calls.map(c => c.mime)).toEqual(["audio/mp4"]);
    expect(audioDurationSeconds(ctx.speech.calls[0].bytes, "audio/mp4")).toBeLessThanOrEqual(60);
  });

  test("Ogg mit Granule-Positionen, die eine Sekunde nennen, bei 80 Sekunden Opus-Paketen: 413 zu-lang ohne Erkennung, Turn, Speicherung oder Spiegelung", async () => {
    const ctx = await start();
    const frozen = oggOpusStream(80, 1, { granule: () => 48_312 });
    expect(frozen.length).toBeLessThan(20_000);
    for (const file of [frozen, oggOpusStream(80, 1, { granule: () => 0 }), oggOpusStream(61, 1, { granule: s => (s === 61 ? 48_312 : 312 + s * 48_000) })]) {
      const res = await ctx.say(ctx.webId, file, { "content-type": "audio/ogg" });
      expect(res.status).toBe(413);
      expect((await res.json()).reason).toBe("zu-lang");
      const topic = await ctx.say(TOPIC, file, { "content-type": "audio/ogg" });
      expect(topic.status).toBe(413);
      expect((await topic.json()).reason).toBe("zu-lang");
    }
    // Pakete, deren Dauer sich nicht lesen lässt: abgelehnt statt geraten
    const invalid = oggOpusStream(80, 1, { granule: () => 48_312, packet: new Uint8Array([0xfb, 0x00]) });
    const res = await ctx.say(ctx.webId, invalid, { "content-type": "audio/ogg" });
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("dauer-unbekannt");
    const topic = await ctx.say(TOPIC, invalid, { "content-type": "audio/ogg" });
    expect(topic.status).toBe(400);
    expect((await topic.json()).reason).toBe("dauer-unbekannt");
    await Bun.sleep(20);
    expect(ctx.speech.calls).toEqual([]);
    expect(ctx.web.turns).toEqual([]);
    expect(ctx.web.saved).toEqual([]);
    expect(await messages(ctx, ctx.webId)).toEqual([]);
    expect(ctx.telegram.turns).toEqual([]);
    expect(ctx.telegram.saved).toEqual([]);
    expect(ctx.telegram.plain).toEqual([]);
    expect(ctx.telegram.agentSends).toEqual([]);
    expect(await messages(ctx, TOPIC)).toEqual([]);
    expect(await allFiles(ctx.uploadsDir)).toEqual([]);
    // Das Gespräch bleibt frei: dieselben verstellten Granule-Positionen bei 40 Sekunden Paketen gehen durch
    expect((await ctx.say(ctx.webId, oggOpusStream(40, 1, { granule: () => 48_312 }), { "content-type": "audio/ogg" })).status).toBe(202);
    await waitUntil(() => ctx.web.saved.length === 2);
    expect(ctx.speech.calls.map(c => c.mime)).toEqual(["audio/ogg"]);
  });

  test("an die Erkennung geht nur, was gezählt wurde: ein zweiter data-Block im WAV (1 Sekunde gezählt, 62 Sekunden dahinter) erreicht sie nicht", async () => {
    const ctx = await start();
    // Der Upload: ein sauberes WAV von einer Sekunde, dahinter ein zweiter data-Block. ffmpeg dekodiert beide
    const tail = new Uint8Array(8 + 62 * 32_000);
    tail.set([0x64, 0x61, 0x74, 0x61]);
    new DataView(tail.buffer).setUint32(4, 62 * 32_000, true);
    const hidden = new Uint8Array(wavSilence(1).length + tail.length);
    hidden.set(wavSilence(1));
    hidden.set(tail, wavSilence(1).length);
    expect(hidden.length).toBeLessThan(MAX_SPEECH_BYTES);
    for (const id of [ctx.webId, TOPIC]) {
      const res = await ctx.say(id, hidden);
      expect(res.status).toBe(202);
    }
    await waitUntil(() => ctx.web.saved.length === 2 && ctx.telegram.turns.length === 1);
    // Gezählt wurde eine Sekunde, und genau diese Sekunde bekam die Erkennung: das neu geschriebene WAV, nicht der Upload
    expect(ctx.speech.calls).toHaveLength(2);
    for (const call of ctx.speech.calls) {
      expect(call.mime).toBe("audio/wav");
      expect(call.bytes.length).toBe(44 + 32_000);
      expect(Buffer.from(call.bytes).equals(Buffer.from(wavSilence(1)))).toBe(true);
      expect(audioDurationSeconds(call.bytes, call.mime)).toBe(1);
    }
  });

  test("an die Erkennung geht in jedem Format eine neu geschriebene Datei, deren Einheiten zusammen höchstens 60 Sekunden ergeben", async () => {
    const ctx = await start();
    const padded = Buffer.concat([mp3Id3Fixture(), Buffer.alloc(300), Buffer.from("TAG".padEnd(128, " "))]);
    const uploads: [Uint8Array, string, number][] = [
      // Zeitangaben im Container verstellt (Duration 5 Sekunden bzw. 15 Minuten, stehende Zeitstempel, Granule-Positionen)
      [webmOpusLaced(500, { durationMs: 5_000 }), "audio/ogg", 60],
      [webmOpusLaced(100, { durationMs: 900_000, frozenTime: true }), "audio/ogg", 12],
      [oggOpusStream(40, 1, { granule: () => 48_312 }), "audio/ogg", 40],
      [oggOpusChained(20, 20), "audio/ogg", 40],
      // ID3-Kopf, Auffüllung und ID3v1-Block bleiben zurück
      [padded, "audio/mpeg", 0.18],
      [wavSilence(2, { dataSize: 0xffffffff }), "audio/wav", 2],
      // MP4: Kopf nennt eine Sekunde bzw. 15 Minuten, Sample-Dauern verstellt
      [mp4Aac(586, { headerSeconds: 1, sampleDelta: 12 }), "audio/mp4", (586 * 1024) / 48_000],
      [mp4Opus(500, { headerSeconds: 900, sampleDelta: 1 }), "audio/ogg", 10],
      // MP4, aus dessen Samples ffmpeg je zwei Frames dekodiert (Füllelement, über das der Decoder hinausliest)
      [mp4Aac(586, { frame: AAC_FILL_OVERREAD }), "audio/mp4", (586 * 1024) / 48_000],
    ];
    for (const [file] of uploads) {
      const before = ctx.web.saved.length;
      expect((await ctx.say(ctx.webId, file)).status).toBe(202);
      await waitUntil(() => ctx.web.saved.length === before + 2);
      await waitUntil(async () => (await (await ctx.api(`/api/conversations/${ctx.webId}`)).json()).running === false);
    }
    expect(ctx.speech.calls).toHaveLength(uploads.length);
    uploads.forEach(([file, mime, seconds], i) => {
      const call = ctx.speech.calls[i];
      expect(call.mime).toBe(mime);
      // Die Dauer der weitergereichten Datei ist die gezählte, und sie liegt in der Grenze
      expect(audioDurationSeconds(call.bytes, call.mime)).toBeCloseTo(seconds, 5);
      expect(audioDurationSeconds(call.bytes, call.mime)).toBeLessThanOrEqual(60);
      expect(Buffer.from(call.bytes).equals(Buffer.from(file))).toBe(false);
    });
    // WebM und Ogg: ein Ogg-Stream mit gültigen Prüfsummen, dessen letzte Granule-Position die gezählten Pakete nennt
    expect(oggPages(ctx.speech.calls[0].bytes).every(p => p.crcOk)).toBe(true);
    expect(oggPages(ctx.speech.calls[0].bytes).at(-1)!.granule).toBe(60 * 48_000);
    expect(oggPages(ctx.speech.calls[1].bytes).at(-1)!.granule).toBe(12 * 48_000);
    expect(oggPages(ctx.speech.calls[2].bytes).at(-1)!.granule).toBe(40 * 48_000);
    // MP3: genau die fünf Frames
    expect(Buffer.from(ctx.speech.calls[4].bytes).equals(mp3FrameFixture())).toBe(true);
    // WAV: Kopf mit der echten Länge statt 0xFFFFFFFF
    expect(Buffer.from(ctx.speech.calls[5].bytes).equals(Buffer.from(wavSilence(2)))).toBe(true);
    // MP4 mit AAC: dasselbe M4A wie aus dem ehrlichen Upload, die verstellten Angaben hinterlassen keine Spur
    expect(Buffer.from(ctx.speech.calls[6].bytes).equals(Buffer.from(prepareSpeechAudio(mp4Aac(586), "audio/mp4")!.audio))).toBe(true);
    // Auch aus den Samples mit Füllelementen: nur die Kanal-Elemente gehen weiter
    expect(Buffer.from(ctx.speech.calls[8].bytes).equals(Buffer.from(ctx.speech.calls[6].bytes))).toBe(true);
    // MP4 mit Opus: dasselbe Ogg wie aus einem Ogg-Upload mit denselben Paketen
    expect(Buffer.from(ctx.speech.calls[7].bytes).equals(Buffer.from(prepareSpeechAudio(oggOpusStream(10), "audio/ogg")!.audio))).toBe(true);
  });

  test("Dauer nicht bestimmbar: 400 dauer-unbekannt statt raten", async () => {
    const ctx = await start();
    const res = await ctx.say(ctx.webId, mp4Fragmented(0));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("dauer-unbekannt");
    expect(ctx.speech.calls).toEqual([]);
  });

  test("kein Audio: 415 format; leer: 400", async () => {
    const ctx = await start();
    const png = await ctx.say(ctx.webId, PNG);
    expect(png.status).toBe(415);
    expect((await png.json()).reason).toBe("format");
    const text = await ctx.say(ctx.webId, new TextEncoder().encode("kein Audio, aber mit content-type audio/wav"));
    expect(text.status).toBe(415);
    const empty = await ctx.say(ctx.webId, new Uint8Array(0));
    expect(empty.status).toBe(400);
    expect(ctx.speech.calls).toEqual([]);
    expect(ctx.web.turns).toEqual([]);
  });
});

describe("Fehler der Erkennung", () => {
  test("Zeitlimit: 504 zeitlimit, und auch ein spätes Ergebnis startet keinen Turn mehr", async () => {
    const speech = fakeSpeech();
    // Von Hand freigegeben statt Bun.sleep: unter Last dauerte der Serverstart
    // länger als die Wartezeit, die Erkennung war dann vor dem Zeitlimit fertig (PR #262)
    const late = gate();
    speech.state.gate = late.promise;
    const ctx = await start({ speech, deps: { speechSttTimeoutMs: 30 } });
    const res = await ctx.say(ctx.webId, WAV);
    expect(res.status).toBe(504);
    expect((await res.json()).reason).toBe("zeitlimit");
    expect(speech.state.calls[0].timeoutMs).toBe(30);
    // Die Attrappe antwortet erst jetzt mit Text
    late.release();
    await Bun.sleep(200);
    expect(ctx.web.turns).toEqual([]);
    expect(ctx.web.saved).toEqual([]);
    expect(await messages(ctx, ctx.webId)).toEqual([]);
    // Danach ist das Gespräch wieder frei
    speech.state.gate = undefined;
    expect((await ctx.say(ctx.webId, WAV)).status).toBe(202);
  });

  for (const [name, text] of [
    ["leeren", "none"],
    ["nur weißen", "blank"],
  ] as const) {
    test(`Anbieter liefert ${name} Text, fest gewählt: 422 nichts-verstanden über die ganze Kette, kein Turn, nichts gespeichert`, async () => {
      const speech = chainSpeech({ "whisper-cpp": text, gemini: "ok" }, { speech: { stt: "whisper-cpp" } });
      const ctx = await start({ speech });
      for (const id of [ctx.webId, TOPIC]) {
        const res = await ctx.say(id, WAV);
        expect(res.status).toBe(422);
        expect((await res.json()).reason).toBe("nichts-verstanden");
      }
      await Bun.sleep(20);
      // Fest gewählt: nur dieser Anbieter, kein Wechsel auf einen anderen
      expect(speech.calls).toEqual(["whisper-cpp", "whisper-cpp"]);
      expect(ctx.web.turns).toEqual([]);
      expect(ctx.web.saved).toEqual([]);
      expect(await messages(ctx, ctx.webId)).toEqual([]);
      expect(ctx.telegram.turns).toEqual([]);
      expect(ctx.telegram.plain).toEqual([]);
      expect(ctx.telegram.saved).toEqual([]);
      expect(ctx.rows).toEqual([]);
      expect(isExecutionActive(`web:${ctx.webId}`)).toBe(false);
    });

    test(`Anbieter liefern ${name} Text, auto: 422 nichts-verstanden über die ganze Kette, kein Turn, nichts gespeichert`, async () => {
      const speech = chainSpeech({ "whisper-cpp": text, elevenlabs: "throw", gemini: text });
      const ctx = await start({ speech });
      for (const id of [ctx.webId, TOPIC]) {
        const res = await ctx.say(id, WAV);
        expect(res.status).toBe(422);
        expect((await res.json()).reason).toBe("nichts-verstanden");
      }
      await Bun.sleep(20);
      expect(speech.calls).toEqual(["whisper-cpp", "elevenlabs", "gemini", "whisper-cpp", "elevenlabs", "gemini"]);
      expect(ctx.web.turns).toEqual([]);
      expect(ctx.web.saved).toEqual([]);
      expect(await messages(ctx, ctx.webId)).toEqual([]);
      expect(ctx.telegram.turns).toEqual([]);
      expect(ctx.telegram.plain).toEqual([]);
      expect(ctx.telegram.saved).toEqual([]);
      expect(ctx.rows).toEqual([]);
    });
  }

  test("ganze Kette: technischer Fehler bleibt 502, ein Text nach einem leeren Anbieter startet den Turn", async () => {
    const broken = chainSpeech({ "whisper-cpp": "throw", gemini: "throw" });
    const failing = await start({ speech: broken });
    const res = await failing.say(failing.webId, WAV);
    expect(res.status).toBe(502);
    expect((await res.json()).reason).toBe("erkennung-fehlgeschlagen");
    expect(failing.web.turns).toEqual([]);
    const rescued = chainSpeech({ "whisper-cpp": "none", gemini: "ok" });
    const ctx = await start({ speech: rescued });
    const ok = await ctx.say(ctx.webId, WAV);
    expect(ok.status).toBe(202);
    expect((await ok.json()).transcript).toBe("Wie spät ist es?");
    await waitUntil(() => ctx.web.saved.length === 2);
    await waitUntil(() => !isExecutionActive(`web:${ctx.webId}`));
  });

  test("Attrappe meldet empty: 422 nichts-verstanden", async () => {
    const speech = fakeSpeech({ ok: false, reason: "empty" });
    const ctx = await start({ speech });
    const res = await ctx.say(ctx.webId, WAV);
    expect(res.status).toBe(422);
    expect((await res.json()).reason).toBe("nichts-verstanden");
    expect(ctx.web.turns).toEqual([]);
  });

  test("kein Anbieter 503, gescheitert 502, Ausnahme 502: nie ein Turn, nie ein Platzhaltertext", async () => {
    const speech = fakeSpeech({ ok: false, reason: "unavailable" });
    const ctx = await start({ speech });
    const none = await ctx.say(ctx.webId, WAV);
    expect(none.status).toBe(503);
    expect((await none.json()).reason).toBe("kein-anbieter");
    speech.state.result = { ok: false, reason: "failed" };
    const failed = await ctx.say(ctx.webId, WAV);
    expect(failed.status).toBe(502);
    expect((await failed.json()).reason).toBe("erkennung-fehlgeschlagen");
    speech.state.result = new Error("geheimer Pfad /x/y");
    const thrown = await ctx.say(ctx.webId, WAV);
    expect(thrown.status).toBe(502);
    expect(JSON.stringify(await thrown.json())).not.toContain("geheim");
    speech.state.result = { ok: false, reason: "timeout" };
    expect((await ctx.say(ctx.webId, WAV)).status).toBe(504);
    expect(ctx.web.turns).toEqual([]);
    expect(await messages(ctx, ctx.webId)).toEqual([]);
  });
});

describe("Zugang", () => {
  test("ohne Anmeldung 401, fremder Origin 403, falsche Methode 405, unbekanntes Gespräch 404", async () => {
    const ctx = await start();
    expect((await ctx.say(ctx.webId, WAV, { cookie: null })).status).toBe(401);
    expect((await ctx.say(ctx.webId, WAV, { origin: "https://fremd.example" })).status).toBe(403);
    // GET ist seit Issue #250 die Beschäftigt-Abfrage (tests/web-speech-busy.test.ts)
    const put = await ctx.api(`/api/conversations/${ctx.webId}/speech`, "PUT", {});
    expect(put.status).toBe(405);
    expect(put.headers.get("allow")).toBe("GET, POST");
    expect((await ctx.say("0b3c6a2e-1f00-4c1a-9d0e-2a4b6c8d0e1f", WAV)).status).toBe(404);
    expect((await ctx.say("topic-999", WAV)).status).toBe(404);
    expect(ctx.speech.calls).toEqual([]);
    expect(ctx.web.turns).toEqual([]);
  });

  test("ohne Sprach-Anbindung 503, ohne Chat 503", async () => {
    const none = await start({ speech: null });
    expect((await none.say(none.webId, WAV)).status).toBe(503);
    const noChat = await start({ chat: false });
    expect((await noChat.say(noChat.webId, WAV)).status).toBe(503);
    expect(noChat.speech.calls).toEqual([]);
  });
});

describe("Äußerung in einem Topic", () => {
  test("gespiegelt nach Telegram wie eine Web-Nachricht, Agent des Topics, markiert im Speicher, in SSE und nach dem Neuladen", async () => {
    const ctx = await start();
    const live = await listen(ctx as unknown as AttachmentCtx, TOPIC);
    const res = await ctx.say(TOPIC, WAV);
    expect(res.status).toBe(202);
    const body = await res.json();
    await waitUntil(() => ctx.telegram.saved.length === 2);

    // Spiegelung und Turn wie bei einer getippten Web-Nachricht
    expect(ctx.telegram.plain).toEqual([{ chatId: GROUP, text: "Du (Web): Wie wird das Wetter morgen?", threadId: 443 }]);
    expect(ctx.telegram.turns).toHaveLength(1);
    expect(ctx.telegram.turns[0]).toMatchObject({ userMessage: "Wie wird das Wetter morgen?", chatId: GROUP, topicId: 443, agentName: "finance" });
    expect(ctx.telegram.agentSends).toEqual([{ agent: "finance", chatId: GROUP, text: "Antwort", threadId: 443 }]);

    // Speicher: Text ohne Zusatz, Markierung in metadata
    expect(ctx.telegram.saved[0]).toMatchObject({
      role: "user",
      content: "Wie wird das Wetter morgen?",
      metadata: { topicId: 443, channel: "web", msgId: body.messageId, speech: true },
    });
    expect(ctx.telegram.saved[1]).toMatchObject({ role: "assistant", content: "Antwort", metadata: { topicId: 443, channel: "web", speech: true } });

    // SSE: die Nutzernachricht für andere offene Browser trägt source speech
    await waitUntil(() => live.events.some(e => e.event === "message" && e.data.role === "assistant"));
    const sseUser = live.events.find(e => e.event === "message" && e.data.role === "user")!.data;
    expect(sseUser).toMatchObject({ id: body.messageId, text: "Wie wird das Wetter morgen?", source: "speech" });
    // Die Antwort trägt die vorlesbare Fassung
    const sseReply = live.events.find(e => e.event === "message" && e.data.role === "assistant")!.data;
    expect(sseReply).toMatchObject({ text: "Antwort", speakable: "Antwort", speakSegments: ["Antwort"] });
    await live.close();

    // Nach erneutem Laden aus dem Nachrichtenspeicher
    const list = await messages(ctx, TOPIC);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: body.messageId, role: "user", text: "Wie wird das Wetter morgen?", source: "speech" });
    expect(list[1]).toMatchObject({ role: "assistant", text: "Antwort", agent: "finance", speakable: "Antwort", speakSegments: ["Antwort"] });
    expect(list[1].source).toBeUndefined();
    expect(list[1].speech).toBeUndefined();
  });

  test("im Direktchat: Agent general, gespiegelt ohne Thread", async () => {
    const ctx = await start();
    expect((await ctx.say("dm", WAV)).status).toBe(202);
    await waitUntil(() => ctx.telegram.saved.length === 2);
    expect(ctx.telegram.plain).toEqual([{ chatId: USER, text: "Du (Web): Wie wird das Wetter morgen?", threadId: undefined }]);
    expect(ctx.telegram.turns[0]).toMatchObject({ chatId: USER, agentName: "general" });
    expect(ctx.telegram.saved[0].metadata).toMatchObject({ topicId: null, speech: true });
  });

  test("geschlossenes Topic: 409 closed, keine Erkennung", async () => {
    const ctx = await start();
    const res = await ctx.say(CLOSED_TOPIC, WAV);
    expect(res.status).toBe(409);
    expect((await res.json()).closed).toBe(true);
    expect(ctx.speech.calls).toEqual([]);
  });
});
