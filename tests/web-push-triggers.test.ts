/**
 * Push von selbst (Issue #226): Regeln des Benachrichtigers mit Attrappen
 * (Herkunft, Sichtbarkeit, Kategorien pro Gerät, 30-Sekunden-Grenze pro Gerät,
 * Vorschau als Klartext, Dateinamen, Fehler blockieren nichts) und der Weg
 * durch den echten Web-Server mit Versand-Attrappe aus #225: fertige Antwort,
 * Anwesenheit, Telegram-Live-Feed, Meldungen, neue Rückfragen, Einstellungen
 * am Abo (Standard, Speichern, Neustart, Abo-Erneuerung, Migration). Die
 * Nutzlast wird wie im Browser entschlüsselt.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunTurnOptions, TurnResult, WebChat } from "../src/web/chat";
import type { ChoiceChange, ChoicePort } from "../src/web/choices";
import { prepareBotPush } from "../src/web/bot-push";
import { readCliToken } from "../src/web/cli-token";
import { generateVapidKeys, type VapidKeys } from "../src/web/push";
import type { DeliveryResult } from "../src/web/push-api";
import { defaultPushSettings, type PushDevice } from "../src/web/push-store";
import {
  createPushNotifier,
  plainPreview,
  REPLY_THROTTLE_MS,
  type PushNotifierDeps,
  type TriggerMessage,
} from "../src/web/push-triggers";
import { PRESENCE_TTL_MS } from "../src/web/presence";
import { createWebServer, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import type { TelegramConversation, TelegramLiveEvent, TelegramLiveFeed, TelegramSource } from "../src/web/telegram";
import { decryptPush, receiverSubscription } from "./push-fixture";

const SECRET_REPLY = "Die **geheime** Antwort: Kontostand 4711 Euro, siehe [Bank](https://bank.example).";
const SECRET_NOTICE = "Pipeline fertig: Vertrag-Mia.pdf geprüft, 3 Fehler";

// ---------------------------------------------------------------------------
// Regeln mit Attrappen
// ---------------------------------------------------------------------------

function device(n: number, settings: Partial<PushDevice["settings"]> = {}): PushDevice {
  return {
    id: `00000000-0000-4000-8000-00000000000${n}`,
    name: `Gerät ${n}`,
    endpoint: `https://fcm.googleapis.com/fcm/send/${n}`,
    keys: { p256dh: "x", auth: "y" },
    createdAt: "2026-09-28T10:00:00.000Z",
    settings: { ...defaultPushSettings(false), ...settings },
  };
}

function rig(devices: PushDevice[], options: { visible?: string[]; fail?: boolean } = {}) {
  const clock = { t: 1_000_000 };
  const sent: { device: string; message: TriggerMessage; urgency?: string }[] = [];
  const logs: string[] = [];
  const deps: PushNotifierDeps = {
    devices: () => devices,
    send: async (d, message, opts) => {
      if (options.fail) throw new Error("Netz weg");
      sent.push({ device: d.name, message, urgency: opts.urgency });
      return { status: "ok", code: 201 } as DeliveryResult;
    },
    isVisible: id => (options.visible ?? []).includes(id),
    title: async id => (id === "dm" ? "Direktchat" : "Urlaub planen"),
    now: () => clock.t,
    log: m => logs.push(m),
  };
  return { clock, sent, logs, notifier: createPushNotifier(deps) };
}

describe("Klartext-Vorschau", () => {
  test("ohne Markdown, HTML und Steuer-Tags, Leerraum zusammengezogen, höchstens 120 Zeichen", () => {
    expect(plainPreview("## Titel\n\n**fett** und _kursiv_, `code` <b>html</b> [Link](https://x.example)\n[REMEMBER: geheim]")).toBe(
      "Titel fett und kursiv, code html Link"
    );
    const long = plainPreview("a".repeat(300));
    expect([...long]).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
    expect(plainPreview("- eins\n- zwei\n1. drei")).toBe("eins zwei drei");
  });
});

describe("Benachrichtiger", () => {
  test("Antwort: aus Browser und Terminal, nicht aus Telegram; sichtbares Gespräch nie", async () => {
    const { sent, notifier } = rig([device(1)], { visible: ["dm"] });
    await notifier.reply({ conversationId: "w1", text: SECRET_REPLY, agent: "research", origin: "telegram" });
    await notifier.reply({ conversationId: "dm", text: SECRET_REPLY, agent: "research", origin: "web" });
    await notifier.reply({ conversationId: "dm", text: SECRET_REPLY, agent: "research", origin: "terminal" });
    expect(sent).toHaveLength(0);
    await notifier.reply({ conversationId: "w1", text: SECRET_REPLY, agent: "research", origin: "web" });
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toMatchObject({
      category: "reply", conversationId: "w1", title: "Urlaub planen", body: "Antwort von Research", tag: "c-w1", url: "/#/gespraech/w1",
    });
    expect(sent[0].urgency).toBe("normal");
    expect(JSON.stringify(sent[0].message)).not.toContain("4711");
    await notifier.reply({ conversationId: "w2", text: SECRET_REPLY, agent: "research", origin: "terminal" });
    expect(sent).toHaveLength(2);
    expect(sent[1].message).toMatchObject({ category: "reply", conversationId: "w2", body: "Antwort von Research" });
  });

  test("30 Sekunden je Gerät und Gespräch; ein anderes Gerät oder Gespräch ist nicht gesperrt", async () => {
    const a = device(1);
    const b = device(2, { replies: false });
    const devices = [a, b];
    const { clock, sent, notifier } = rig(devices);
    await notifier.reply({ conversationId: "w1", text: "x", origin: "web" });
    await notifier.reply({ conversationId: "w1", text: "x", origin: "web" });
    await notifier.reply({ conversationId: "w2", text: "x", origin: "web" });
    expect(sent.map(s => `${s.device} ${s.message.conversationId}`)).toEqual(["Gerät 1 w1", "Gerät 1 w2"]);
    // Gerät 2 schaltet Antworten ein: seine erste kommt, obwohl Gerät 1 für w1 noch gesperrt ist
    b.settings.replies = true;
    await notifier.reply({ conversationId: "w1", text: "x", origin: "web" });
    expect(sent.map(s => `${s.device} ${s.message.conversationId}`)).toEqual(["Gerät 1 w1", "Gerät 1 w2", "Gerät 2 w1"]);
    clock.t += REPLY_THROTTLE_MS;
    await notifier.reply({ conversationId: "w1", text: "x", origin: "web" });
    expect(sent.slice(3).map(s => s.device).sort()).toEqual(["Gerät 1", "Gerät 2"]);
  });

  test("Kategorien und Vorschau pro Gerät", async () => {
    const { sent, notifier } = rig([device(1, { preview: true }), device(2, { replies: false, choices: false, notices: false }), device(3, { notices: false })]);
    await notifier.reply({ conversationId: "w1", text: SECRET_REPLY, origin: "web" });
    await notifier.choice({ conversationId: "w1", choiceId: "abc123", kind: "tool" });
    await notifier.notice({ conversationId: "dm", text: SECRET_NOTICE, source: "pipeline" });
    const by = (name: string) => sent.filter(s => s.device === name).map(s => s.message);
    expect(by("Gerät 2")).toEqual([]);
    expect(by("Gerät 1").map(m => m.body)).toEqual([
      "Die geheime Antwort: Kontostand 4711 Euro, siehe Bank.",
      "Werkzeug-Freigabe · Urlaub planen",
      SECRET_NOTICE,
    ]);
    expect(by("Gerät 3").map(m => m.body)).toEqual(["Antwort von tybo", "Werkzeug-Freigabe · Urlaub planen"]);
  });

  test("Rückfrage: Urgency high, Kennung und Kategorie für das spätere Schließen", async () => {
    const { sent, notifier } = rig([device(1)]);
    await notifier.choice({ conversationId: "topic-5", choiceId: "q1", kind: "goal" });
    expect(sent[0].urgency).toBe("high");
    expect(sent[0].message).toMatchObject({ category: "choice", choiceId: "q1", title: "tybo fragt nach", body: "Weiter? · Urlaub planen", tag: "c-topic-5" });
  });

  test("Meldung: Absender als Titel, Datei ohne Vorschau ohne Namen; Folgen eigener Entscheidungen und Meldungen mit Knöpfen nicht", async () => {
    const { sent, notifier } = rig([device(1), device(2, { preview: true })]);
    await notifier.notice({ conversationId: "dm", text: SECRET_NOTICE, source: "pipeline" });
    await notifier.notice({ conversationId: "dm", text: "Bericht", source: "datei", file: { name: "Gehalt-Alex.pdf" } });
    await notifier.notice({ conversationId: "dm", text: "Gespeichert", source: "review" });
    await notifier.notice({ conversationId: "dm", text: "Soll ich?", source: "ziel", choiceId: "q2" });
    const one = sent.filter(s => s.device === "Gerät 1").map(s => [s.message.title, s.message.body]);
    const two = sent.filter(s => s.device === "Gerät 2").map(s => [s.message.title, s.message.body]);
    expect(one).toEqual([["Pipeline", "Neue Meldung"], ["Datei", "Neue Datei"]]);
    expect(two).toEqual([["Pipeline", SECRET_NOTICE], ["Datei", "Datei: Gehalt-Alex.pdf"]]);
  });

  test("Abgebrochener Versand landet im Log (Kategorie, Gerät, Ergebnis), nie als Ausnahme", async () => {
    const { logs, notifier } = rig([device(1)], { fail: true });
    await notifier.reply({ conversationId: "w1", text: SECRET_REPLY, origin: "web" });
    expect(logs).toEqual(["Push (Antwort) an „Gerät 1\": Fehler (Error)"]);
  });

  test("Kategorie geht als label an den Versand, der Benachrichtiger loggt Ergebnisse nicht selbst", async () => {
    const labels: (string | undefined)[] = [];
    const logs: string[] = [];
    const notifier = createPushNotifier({
      devices: () => [device(1)],
      send: async (_d, _m, opts) => {
        labels.push(opts.label);
        return { status: "retry", code: 429 };
      },
      isVisible: () => false,
      title: async () => "Urlaub planen",
      log: m => logs.push(m),
    });
    await notifier.reply({ conversationId: "w1", text: "x", origin: "web" });
    await notifier.choice({ conversationId: "w1", choiceId: "q1" });
    await notifier.notice({ conversationId: "w1", text: "x", source: "job" });
    expect(labels).toEqual(["Antwort", "Rückfrage", "Meldung"]);
    expect(logs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Durch den echten Web-Server
// ---------------------------------------------------------------------------

const PASSWORD = "test-passwort-lang";
const keys: VapidKeys = await generateVapidKeys();
const root = await mkdtemp(join(tmpdir(), "tybo-push-triggers-"));
const servers: WebServer[] = [];
let counter = 0;
afterAll(async () => {
  for (const s of servers.splice(0)) await s.stop();
  await rm(root, { recursive: true, force: true });
});

/** Antwortet sofort mit SECRET_REPLY */
function replyChat(): WebChat {
  return {
    async runTurn(_opts: RunTurnOptions): Promise<TurnResult> {
      return { text: SECRET_REPLY, info: { agent: "general" } };
    },
    stop: () => true,
  };
}

interface Sent { url: string; headers: Record<string, string>; payload: Promise<any> }

async function start(options: { telegram?: boolean; dir?: string; failFetch?: boolean; status?: () => number } = {}) {
  const dir = options.dir ?? join(root, `case-${++counter}`);
  const clock = { t: Date.now() };
  const sent: Sent[] = [];
  const logs: string[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    if (options.failFetch) throw new TypeError("Netz weg");
    sent.push({ url, headers: init.headers as Record<string, string>, payload: decryptPush(init.body as Uint8Array).then(t => JSON.parse(t)) });
    return new Response(null, { status: options.status?.() ?? 201 });
  }) as unknown as typeof fetch;
  const liveListeners: ((e: TelegramLiveEvent) => void)[] = [];
  const telegramLive: TelegramLiveFeed = { subscribe: l => { liveListeners.push(l); return () => {}; } };
  const choiceListeners: ((c: ChoiceChange) => void)[] = [];
  const choices: ChoicePort = {
    view: async id => ({ id, options: [], state: "open" }),
    decide: async () => ({ status: "not_found" }),
    subscribe: l => { choiceListeners.push(l); return () => {}; },
  };
  const dm: TelegramConversation = { id: "dm", title: "Direktchat", agent: "general", lastActivity: null };
  const topic: TelegramConversation = { id: "topic-5", title: "Reisen", agent: "general", lastActivity: null };
  const telegram: TelegramSource = {
    listConversations: async () => ({ dm, topics: [topic] }),
    getConversation: async id => (id === "dm" ? dm : id === "topic-5" ? topic : null),
    history: async () => ({ messages: [], hasMore: false }),
  };
  const conversationStore = new ConversationStore({ dir: join(dir, "web"), now: () => clock.t });
  await conversationStore.load();
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [], publicOrigin: null, access: null },
    {
      sessionFile: join(dir, "sessions.json"),
      dataDir: join(dir, "web"),
      cliTokenFile: join(dir, "cli-token"),
      conversationStore,
      chat: replyChat(),
      telegramChat: replyChat(),
      telegram,
      telegramLive,
      choices,
      now: () => clock.t,
      push: { keys, subject: "https://tybo.example", fetch: fakeFetch, ...(options.telegram === undefined ? {} : { telegram: options.telegram }) },
      log: m => logs.push(m),
    }
  );
  servers.push(server);
  const res = await fetch(`${server.url}/api/login`, { method: "POST", headers: { origin: server.url }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${server.url}${path}`, {
      method,
      headers: { origin: server.url, cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let seq = 0;
  const presence = (conversation: string | null, visible: boolean, tab = "tab-aaaaaaaaaaaa") =>
    call("POST", "/api/presence", { tab, seq: ++seq, conversation, visible });
  const conversation = async (title = "Urlaub planen") => {
    const c = await conversationStore.createConversation("general");
    await conversationStore.renameConversation(c.id, title);
    return c.id;
  };
  const cliToken = (await readCliToken(join(dir, "cli-token")))!;
  /** Nachricht schicken (Browser oder Terminal) und warten, bis der Turn fertig ist */
  const ask = async (id: string, text = "Wie steht mein Konto?", via: "web" | "terminal" = "web") => {
    const r =
      via === "terminal"
        ? await fetch(`${server.url}/api/conversations/${id}/messages`, {
            method: "POST",
            headers: { authorization: `Bearer ${cliToken}`, "content-type": "application/json" },
            body: JSON.stringify({ text }),
          })
        : await call("POST", `/api/conversations/${id}/messages`, { text });
    expect(r.status).toBe(202);
    for (let i = 0; i < 200; i++) {
      const s = await (await call("GET", `/api/conversations/${id}`)).json();
      if (!s.running) break;
      await Bun.sleep(5);
    }
    await Bun.sleep(20);
  };
  const subscribe = async (n: number | string = 1) => {
    const r = await call("POST", "/api/push/subscriptions", { subscription: receiverSubscription(n) });
    expect(r.status).toBe(201);
    return (await r.json()).device;
  };
  return {
    server, dir, clock, sent, logs, call, presence, conversation, ask, subscribe,
    live: (e: TelegramLiveEvent) => { for (const l of liveListeners) l(e); },
    choice: (c: ChoiceChange) => { for (const l of choiceListeners) l(c); },
  };
}

const flush = () => Bun.sleep(30);

describe("Antworten durch den Server", () => {
  test("sichtbar gemeldet: kein Push; verdeckt: Push ohne Antworttext in der entschlüsselten Nutzlast", async () => {
    const ctx = await start();
    await ctx.subscribe();
    const id = await ctx.conversation();
    await ctx.presence(id, true);
    await ctx.ask(id);
    expect(ctx.sent).toHaveLength(0);
    await ctx.presence(id, false);
    await ctx.ask(id);
    expect(ctx.sent).toHaveLength(1);
    const payload = await ctx.sent[0].payload;
    expect(payload).toEqual({
      category: "reply", conversationId: id, title: "Urlaub planen", body: "Antwort von General", tag: `c-${id}`, url: `/#/gespraech/${id}`,
    });
    expect(JSON.stringify(payload)).not.toContain("4711");
    expect(JSON.stringify(payload)).not.toContain("geheim");
    expect(ctx.sent[0].headers.Urgency).toBe("normal");
    // Log: Kategorie, Gerät, Ergebnis; kein Inhalt, kein Endpunkt
    const log = ctx.logs.join("\n");
    expect(log).toContain("Push (Antwort) an „Gerät\": ok");
    expect(log).not.toContain("geheim-1");
    expect(log).not.toContain("4711");
  });

  test("Antwort auf eine Nachricht aus dem Terminal: Push, wenn das Gespräch nicht sichtbar ist; sichtbar nicht", async () => {
    const ctx = await start();
    await ctx.subscribe();
    const id = await ctx.conversation();
    await ctx.presence(id, true);
    await ctx.ask(id, "Frage aus dem Terminal", "terminal");
    expect(ctx.sent).toHaveLength(0);
    await ctx.presence(id, false);
    await ctx.ask(id, "Frage aus dem Terminal", "terminal");
    expect(ctx.sent).toHaveLength(1);
    expect(await ctx.sent[0].payload).toMatchObject({ category: "reply", conversationId: id, body: "Antwort von General" });
    expect(ctx.logs.join("\n")).toContain("Push (Antwort) an „Gerät\": ok");
  });

  test("nach 70 Sekunden ohne Meldung gilt das Gespräch als nicht sichtbar: Push", async () => {
    const ctx = await start();
    await ctx.subscribe();
    const id = await ctx.conversation();
    await ctx.presence(id, true);
    ctx.clock.t += PRESENCE_TTL_MS;
    await ctx.ask(id);
    expect(ctx.sent).toHaveLength(1);
  });

  test("anderes Gespräch sichtbar offen: Push für dieses; höchstens eine Antwort je 30 Sekunden", async () => {
    const ctx = await start();
    await ctx.subscribe();
    const id = await ctx.conversation();
    const other = await ctx.conversation("Anderes");
    await ctx.presence(other, true);
    await ctx.ask(id);
    await ctx.ask(id);
    expect(ctx.sent).toHaveLength(1);
    ctx.clock.t += REPLY_THROTTLE_MS;
    await ctx.ask(id);
    expect(ctx.sent).toHaveLength(2);
  });

  test("mit „Inhalt zeigen\" steht die Antwort als Klartext drin", async () => {
    const ctx = await start();
    const d = await ctx.subscribe();
    const r = await ctx.call("PATCH", `/api/push/subscriptions/${d.id}`, { settings: { preview: true } });
    expect(r.status).toBe(200);
    const id = await ctx.conversation();
    await ctx.ask(id);
    expect((await ctx.sent[0].payload).body).toBe("Die geheime Antwort: Kontostand 4711 Euro, siehe Bank.");
  });

  test("Telegram-Gespräch aus dem Browser beschrieben: Push; Antwort aus Telegram (Live-Feed): kein Push", async () => {
    const ctx = await start();
    await ctx.subscribe();
    ctx.live({
      conversationId: "topic-5",
      at: new Date(ctx.clock.t).toISOString(),
      message: { id: "tg-10", role: "assistant", text: SECRET_REPLY, createdAt: new Date(ctx.clock.t).toISOString() } as any,
    });
    await flush();
    expect(ctx.sent).toHaveLength(0);
    await ctx.ask("topic-5");
    expect(ctx.sent).toHaveLength(1);
    expect((await ctx.sent[0].payload).conversationId).toBe("topic-5");
  });
});

describe("Meldungen und Rückfragen durch den Server", () => {
  test("Meldung aus dem Live-Feed: mit Telegram standardmäßig aus, eingeschaltet Push ohne Text", async () => {
    const ctx = await start({ telegram: true });
    const d = await ctx.subscribe();
    expect(d.settings).toEqual({ replies: true, choices: true, notices: false, preview: false });
    const notice = () =>
      ctx.live({
        conversationId: "dm",
        at: new Date(ctx.clock.t).toISOString(),
        message: { id: `tg-${++counter}`, role: "assistant", kind: "notice", source: "pipeline", text: SECRET_NOTICE, createdAt: new Date(ctx.clock.t).toISOString() } as any,
      });
    notice();
    await flush();
    expect(ctx.sent).toHaveLength(0);
    await ctx.call("PATCH", `/api/push/subscriptions/${d.id}`, { settings: { notices: true } });
    notice();
    await flush();
    expect(ctx.sent).toHaveLength(1);
    const payload = await ctx.sent[0].payload;
    expect(payload).toMatchObject({ category: "notice", title: "Pipeline", body: "Neue Meldung", url: "/#/gespraech/dm" });
    expect(JSON.stringify(payload)).not.toContain("Vertrag");
  });

  test("ohne Telegram sind Meldungen an; postToConversation (Meldung im Web-Gespräch) pusht", async () => {
    const ctx = await start({ telegram: false });
    expect((await ctx.subscribe()).settings.notices).toBe(true);
    const id = await ctx.conversation();
    expect(await ctx.server.postToConversation(id, { text: SECRET_NOTICE, kind: "notice", source: "job" })).toBe(true);
    await flush();
    expect(ctx.sent).toHaveLength(1);
    expect(await ctx.sent[0].payload).toMatchObject({ title: "Job", body: "Neue Meldung", conversationId: id });
  });

  test("neue Rückfrage pusht einmal mit Urgency high, die Kopie im Direktchat nicht noch einmal; Entscheidungen nicht", async () => {
    const ctx = await start();
    await ctx.subscribe();
    const id = await ctx.conversation();
    ctx.choice({ conversationId: id, choice: { id: "q1", options: [{ key: "y", label: "Ja" }], state: "open" }, copyInDm: true, created: true, kind: "tool" });
    ctx.choice({ conversationId: id, choice: { id: "q1", options: [], state: "done" }, copyInDm: true });
    await flush();
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0].headers.Urgency).toBe("high");
    expect(await ctx.sent[0].payload).toMatchObject({ category: "choice", choiceId: "q1", title: "tybo fragt nach", body: "Werkzeug-Freigabe · Urlaub planen" });
  });

  test("Push-Fehler blockieren den Chat nicht", async () => {
    const ctx = await start({ failFetch: true });
    await ctx.subscribe();
    const id = await ctx.conversation();
    await ctx.ask(id);
    const pushLogs = ctx.logs.filter(l => l.includes("Push") && !l.startsWith("Push-Gerät"));
    expect(pushLogs).toEqual(["Push (Antwort) an „Gerät\": fehlgeschlagen (Netzfehler)"]);
    const m = await (await ctx.call("GET", `/api/conversations/${id}/messages`)).json();
    expect(m.messages.filter((x: any) => x.role === "assistant")).toHaveLength(1);
  });

  test("Versandlog je Push eine Zeile mit Kategorie, Gerät und Ergebnis: 404/410, 429/5xx, ohne Dienst und Endpunkt", async () => {
    for (const [code, expected, kept] of [
      [404, "abgelaufen (404), Gerät entfernt", false],
      [410, "abgelaufen (410), Gerät entfernt", false],
      [429, "nicht angenommen (429), Abo bleibt", true],
      [503, "nicht angenommen (503), Abo bleibt", true],
    ] as const) {
      const ctx = await start({ status: () => code });
      await ctx.subscribe();
      const id = await ctx.conversation();
      ctx.choice({ conversationId: id, choice: { id: "q1", options: [{ key: "y", label: "Ja" }], state: "open" }, created: true, kind: "tool" });
      await flush();
      expect(ctx.sent).toHaveLength(1);
      const pushLogs = ctx.logs.filter(l => l.includes("Push") && !l.startsWith("Push-Gerät"));
      expect(pushLogs).toEqual([`Push (Rückfrage) an „Gerät": ${expected}`]);
      const log = pushLogs.join("\n");
      expect(log).not.toContain("googleapis");
      expect(ctx.logs.join("\n")).not.toContain("geheim-1");
      const list = await (await ctx.call("GET", "/api/push")).json();
      expect(list.devices).toHaveLength(kept ? 1 : 0);
    }
  });
});

describe("Einstellungen am Abo", () => {
  test("prepareBotPush meldet dem Server, ob Telegram eingerichtet ist (Standard für Meldungen)", async () => {
    const env = { WEB_ENABLED: "true", WEB_PUSH_PUBLIC_KEY: keys.publicKey, WEB_PUSH_PRIVATE_KEY: keys.privateKey };
    const envPath = join(root, "nie-gelesen.env");
    expect((await prepareBotPush({ ...env, TELEGRAM_BOT_TOKEN: "123:abc" }, { envPath, log: () => {} }))?.telegram).toBe(true);
    expect((await prepareBotPush({ ...env, TELEGRAM_BOT_TOKEN: " " }, { envPath, log: () => {} }))?.telegram).toBe(false);
    expect((await prepareBotPush(env, { envPath, log: () => {} }))?.telegram).toBe(false);
  });

  test("Standard, Ändern, ungültige Werte, über Neustart und Abo-Erneuerung erhalten", async () => {
    const dir = join(root, `case-${++counter}`);
    const ctx = await start({ dir, telegram: false });
    const d = await ctx.subscribe(1);
    expect(d.settings).toEqual({ replies: true, choices: true, notices: true, preview: false });
    expect((await ctx.call("PATCH", `/api/push/subscriptions/${d.id}`, { settings: { replies: "ja" } })).status).toBe(400);
    expect((await ctx.call("PATCH", `/api/push/subscriptions/${d.id}`, { settings: { unbekannt: true } })).status).toBe(400);
    expect((await ctx.call("PATCH", `/api/push/subscriptions/${d.id}`, { settings: {} })).status).toBe(400);
    const r = await ctx.call("PATCH", `/api/push/subscriptions/${d.id}`, { settings: { replies: false, preview: true } });
    expect((await r.json()).device.settings).toEqual({ replies: false, choices: true, notices: true, preview: true });
    // Abo-Erneuerung (neuer Endpunkt, gleiches Gerät)
    const renewed = await ctx.call("POST", "/api/push/subscriptions", { id: d.id, subscription: receiverSubscription(2) });
    expect((await renewed.json()).device.settings).toEqual({ replies: false, choices: true, notices: true, preview: true });
    await ctx.server.stop();
    servers.splice(servers.indexOf(ctx.server), 1);
    // Neustart, jetzt mit Telegram: gespeicherte Einstellungen bleiben
    const again = await start({ dir, telegram: true });
    const list = await (await again.call("GET", "/api/push")).json();
    expect(list.devices[0].settings).toEqual({ replies: false, choices: true, notices: true, preview: true });
  });

  test("Abos aus #225 ohne Einstellungen bekommen beim Laden die Standardwerte und werden so gespeichert", async () => {
    const dir = join(root, `case-${++counter}`);
    await mkdir(join(dir, "web"), { recursive: true });
    const old = { id: "0f1e2d3c-4b5a-4968-8776-655443322110", name: "Mac · Chrome", createdAt: "2026-09-27T10:00:00.000Z", settings: {}, ...receiverSubscription(9) };
    await writeFile(join(dir, "web", "push-subscriptions.json"), JSON.stringify([old]));
    const ctx = await start({ dir, telegram: true });
    const list = await (await ctx.call("GET", "/api/push")).json();
    expect(list.devices[0].settings).toEqual({ replies: true, choices: true, notices: false, preview: false });
    const file = JSON.parse(await readFile(join(dir, "web", "push-subscriptions.json"), "utf8"));
    expect(file[0].settings).toEqual({ replies: true, choices: true, notices: false, preview: false });
  });
});
