/**
 * Rückfrage-Knöpfe über den Web-Server (Issue #115): echter Server, echte
 * Telegram-Quelle und echter Live-Feed mit Attrappen für den
 * Nachrichtenspeicher, echtes Rückfragen-Register in einer Test-Datei und
 * der echte ChoicePort. Geprüft: choice im Verlauf beider Gesprächsarten,
 * Route mit Zugehörigkeit und Schutzregeln (Anmeldung, Origin, Access,
 * Terminal-Schlüssel nur lokal), SSE choice an alle Verbindungen des
 * Gesprächs, den Direktchat (Kopie) und den Sammelstrom, Änderungen anderer
 * Prozesse per Abgleich, Wiederverbinden und verspätetes GET.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideChoice, getChoice, setChoicesFileForTests } from "../src/lib/choices";
import type { MessageSavedListener } from "../src/lib/convex";
import type { HistoryRow } from "../src/lib/supabase";
import type { RunTurnOptions, WebChat } from "../src/web/chat";
import { readCliToken } from "../src/web/cli-token";
import { createTelegramLiveFeed, createTelegramSource } from "../src/web/bot-telegram";
import { ACCESS_DENIED_TEXT, createWebServer, TELEGRAM_ACTIVITY_PATH, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import { ACCESS, FakeCerts, validJwt } from "./access-fixture";
import { testChoices, type TestChoices } from "./choices-fixture";

const PASSWORD = "test-passwort-lang";
const USER = "4711";
const GROUP = "-1001234567890";
const PUBLIC = "https://app.tybo.ai";
const root = await mkdtemp(join(tmpdir(), "tybo-choices-server-"));
let counter = 0;
const servers: WebServer[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  for (const s of servers.splice(0)) await s.stop();
});
afterAll(async () => {
  setChoicesFileForTests(null);
  await rm(root, { recursive: true, force: true });
});

class QuietChat implements WebChat {
  async runTurn(_opts: RunTurnOptions) {
    return { text: "Antwort" };
  }
  stop() {}
}

interface Ctx {
  url: string;
  cookie: string;
  token: string;
  webId: string;
  otherWebId: string;
  store: ConversationStore;
  choices: TestChoices;
  rows: (HistoryRow & { chat_id: string })[];
  /** Wie saveMessage: Zeile ablegen und den Hook des Live-Feeds auslösen */
  save(chatId: string, content: string, metadata: Record<string, unknown>): Promise<void>;
}

async function start(): Promise<Ctx> {
  const dir = join(root, `case-${++counter}`);
  const store = new ConversationStore({ dir: join(dir, "web") });
  await store.load();
  const webId = (await store.createConversation("general")).id;
  const otherWebId = (await store.createConversation("general")).id;
  const choices = testChoices(join(dir, "choices.json"), { userId: USER, groupId: GROUP });
  const rows: Ctx["rows"] = [];
  let hook: MessageSavedListener | null = null;
  const telegram = createTelegramSource({
    userId: USER,
    groupId: () => GROUP,
    topicNames: async () => ({ "443": "Recherche", "8": "Finanzen" }),
    topicMapping: () => ({}),
    history: async (chatId, topicId) =>
      rows.filter(r => r.chat_id === chatId && ((r.metadata as any)?.topicId ?? null) === topicId),
    activity: async () => [],
    log: () => {},
  });
  const telegramLive = createTelegramLiveFeed({
    userId: USER,
    groupId: () => GROUP,
    onMessageSaved: listener => {
      hook = listener;
      return () => {
        hook = null;
      };
    },
    log: () => {},
  });
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [], publicOrigin: PUBLIC, access: ACCESS },
    {
      sessionFile: join(dir, "sessions.json"),
      conversationStore: store,
      chat: new QuietChat(),
      telegram,
      telegramChat: new QuietChat(),
      telegramLive,
      choices: choices.port,
      cliTokenFile: join(dir, "cli-token"),
      accessCerts: new FakeCerts().fetch,
      keepaliveMs: 60_000,
      log: () => {},
    }
  );
  servers.push(server);
  const res = await fetch(`${server.url}/api/login`, { method: "POST", headers: { origin: server.url }, body: JSON.stringify({ password: PASSWORD }) });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  const token = (await readCliToken(join(dir, "cli-token")))!;
  let n = 0;
  const ctx: Ctx = {
    url: server.url,
    cookie,
    token,
    webId,
    otherWebId,
    store,
    choices,
    rows,
    async save(chatId, content, metadata) {
      const row = { id: `row-${++n}`, chat_id: chatId, created_at: new Date(Date.now() + n).toISOString(), role: "assistant", content, metadata } as any;
      rows.push(row);
      await hook?.({ chatId, role: "assistant", content, metadata, createdAt: row.created_at });
    },
  };
  // Startstand des Abgleichs, bevor ein Test etwas ändert
  await choices.tick();
  return ctx;
}

/** Rückfrage wie sendChoice in einem Telegram-Gespräch: Register-Eintrag und Meldung mit choiceId */
async function askInTelegram(ctx: Ctx, where: { chatId: string; topicId?: number }, expiresAt?: number) {
  const choice = await ctx.choices.create({ conversation: { type: "telegram", ...where }, ...(expiresAt ? { expiresAt } : {}) });
  await ctx.save(where.chatId, "Werkzeug ausführen?", {
    display_only: true,
    source: "freigabe",
    choiceId: choice.id,
    msgId: crypto.randomUUID(),
    ...(where.topicId ? { topicId: where.topicId } : {}),
  });
  return choice;
}

function post(ctx: Ctx, conversationId: string, choiceId: string, body: unknown, headers: Record<string, string> = { origin: ctx.url, cookie: ctx.cookie }) {
  return fetch(`${ctx.url}/api/conversations/${conversationId}/choices/${choiceId}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function messages(ctx: Ctx, conversationId: string): Promise<any[]> {
  const res = await fetch(`${ctx.url}/api/conversations/${conversationId}/messages`, { headers: { cookie: ctx.cookie } });
  expect(res.status).toBe(200);
  return (await res.json()).messages;
}

async function listen(ctx: Ctx, path: string) {
  const controller = new AbortController();
  const res = await fetch(`${ctx.url}${path}`, { headers: { cookie: ctx.cookie }, signal: controller.signal });
  expect(res.status).toBe(200);
  const events: { event: string; data: any }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let opened = false;
  const done = (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      opened = true;
      buffer += decoder.decode(value);
      let i: number;
      while ((i = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const event = /^event: (.+)$/m.exec(chunk)?.[1];
        const data = /^data: (.+)$/m.exec(chunk)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
    }
  })();
  cleanups.push(() => controller.abort());
  await waitUntil(() => opened);
  return {
    events,
    of: (name: string) => events.filter(e => e.event === name).map(e => e.data),
    async close() {
      controller.abort();
      await reader.cancel().catch(() => {});
      await done;
    },
  };
}

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

describe("Verlauf: choice statt choiceId", () => {
  test("Telegram-Topic: offene Rückfrage mit Knöpfen, choiceId fehlt im API-Format", async () => {
    const ctx = await start();
    const c = await askInTelegram(ctx, { chatId: GROUP, topicId: 443 });
    const [m] = await messages(ctx, "topic-443");
    expect(m.kind).toBe("notice");
    expect(m.choiceId).toBeUndefined();
    expect(m.choice).toEqual({
      id: c.id,
      options: [
        { key: "ok", label: "Erlauben" },
        { key: "no", label: "Ablehnen" },
      ],
      state: "open",
    });
  });

  test("reines Web-Gespräch: choiceId in StoredMessage, choice im Verlauf; ohne Register-Eintrag abgelaufen", async () => {
    const ctx = await start();
    const c = await ctx.choices.create({ conversation: { type: "web", conversationId: ctx.webId } });
    await ctx.store.appendMessage(ctx.webId, { role: "assistant", text: "Werkzeug ausführen?", choiceId: c.id });
    await ctx.store.appendMessage(ctx.webId, { role: "assistant", text: "Alte Frage", choiceId: "Weg12345678" });
    // Nutzernachrichten tragen nie eine Rückfrage
    await ctx.store.appendMessage(ctx.webId, { role: "user", text: "ja", choiceId: c.id });
    const list = await messages(ctx, ctx.webId);
    expect(list.map(m => m.choice?.state ?? null)).toEqual(["open", "expired", null]);
    expect(list[0].choice.options.map((o: any) => o.label)).toEqual(["Erlauben", "Ablehnen"]);
    expect(list.every(m => m.choiceId === undefined)).toBe(true);
  });

  test("Kopie einer Web-Frage im Direktchat: keine Knöpfe, Verweis auf das Web-Gespräch; POST dort 404", async () => {
    const ctx = await start();
    const c = await ctx.choices.create({ conversation: { type: "web", conversationId: ctx.webId } });
    await ctx.save(USER, "Werkzeug ausführen?", { display_only: true, source: "freigabe", choiceId: c.id, msgId: crypto.randomUUID() });
    const [m] = await messages(ctx, "dm");
    expect(m.choice).toEqual({ id: c.id, options: [], state: "open", elsewhere: ctx.webId });
    expect((await post(ctx, "dm", c.id, { option: "ok" })).status).toBe(404);
    expect((await getChoice(c.id))!.state).toBe("open");
  });

  test("Frist abgelaufen: im Verlauf expired, POST 409 mit expired", async () => {
    const ctx = await start();
    const c = await askInTelegram(ctx, { chatId: USER }, Date.now() - 1);
    const [m] = await messages(ctx, "dm");
    expect(m.choice).toEqual({ id: c.id, options: [], state: "expired" });
    const res = await post(ctx, "dm", c.id, { option: "ok" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ expired: true, choice: { id: c.id, state: "expired" } });
  });
});

describe("Route POST /api/conversations/<id>/choices/<choiceId>", () => {
  test("Klick entscheidet für alle Kanäle (via web); Doppelklick 409 mit dem ersten Ergebnis", async () => {
    const ctx = await start();
    const c = await askInTelegram(ctx, { chatId: GROUP, topicId: 443 });
    const res = await post(ctx, "topic-443", c.id, { option: "no" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choice).toMatchObject({ id: c.id, options: [], state: "done", result: { key: "no", label: "Ablehnen", via: "web" } });
    expect((await getChoice(c.id))!.result).toMatchObject({ key: "no", via: "web" });
    const again = await post(ctx, "topic-443", c.id, { option: "ok" });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ already: true, choice: { state: "done", result: { key: "no", via: "web" } } });
    // Verlauf danach: erledigt
    expect((await messages(ctx, "topic-443"))[0].choice.state).toBe("done");
  });

  test("Frage aus Gespräch A ist über Gespräch B nicht entscheidbar (Topics und Web-Gespräche): 404, Frage bleibt offen", async () => {
    const ctx = await start();
    const topic = await askInTelegram(ctx, { chatId: GROUP, topicId: 443 });
    const web = await ctx.choices.create({ conversation: { type: "web", conversationId: ctx.webId } });
    expect((await post(ctx, "topic-8", topic.id, { option: "ok" })).status).toBe(404);
    expect((await post(ctx, "dm", topic.id, { option: "ok" })).status).toBe(404);
    expect((await post(ctx, ctx.otherWebId, web.id, { option: "ok" })).status).toBe(404);
    expect((await post(ctx, "topic-443", web.id, { option: "ok" })).status).toBe(404);
    expect((await getChoice(topic.id))!.state).toBe("open");
    expect((await getChoice(web.id))!.state).toBe("open");
    // Im eigenen Web-Gespräch geht es
    expect((await post(ctx, ctx.webId, web.id, { option: "ok" })).status).toBe(200);
  });

  test("unbekannte Frage, ungültige Kennung, unbekanntes Gespräch: 404", async () => {
    const ctx = await start();
    const c = await askInTelegram(ctx, { chatId: USER });
    expect((await post(ctx, "dm", "Gibtsnicht12", { option: "ok" })).status).toBe(404);
    expect((await post(ctx, "dm", "..%2Fx", { option: "ok" })).status).toBe(404);
    expect((await post(ctx, "topic-99999", c.id, { option: "ok" })).status).toBe(404);
    expect((await post(ctx, "00000000-0000-4000-8000-000000000000", c.id, { option: "ok" })).status).toBe(404);
    expect((await getChoice(c.id))!.state).toBe("open");
  });

  test("400 für fehlende, falsch typisierte oder unbekannte option und kaputtes JSON; GET 405", async () => {
    const ctx = await start();
    const c = await askInTelegram(ctx, { chatId: USER });
    for (const body of [{}, { option: 1 }, { option: "" }, { option: "vielleicht" }, { option: "a b" }, "kein json", [1]]) {
      expect((await post(ctx, "dm", c.id, body)).status).toBe(400);
    }
    const get = await fetch(`${ctx.url}/api/conversations/dm/choices/${c.id}`, { headers: { cookie: ctx.cookie } });
    expect(get.status).toBe(405);
    expect((await getChoice(c.id))!.state).toBe("open");
  });

  test("ohne Anmeldung 401 (mit gültigem Origin), fremder Origin 403, ohne Origin 403", async () => {
    const ctx = await start();
    const c = await askInTelegram(ctx, { chatId: USER });
    expect((await post(ctx, "dm", c.id, { option: "ok" }, { origin: ctx.url })).status).toBe(401);
    expect((await post(ctx, "dm", c.id, { option: "ok" }, { origin: "http://evil.example", cookie: ctx.cookie })).status).toBe(403);
    expect((await post(ctx, "dm", c.id, { option: "ok" }, { cookie: ctx.cookie })).status).toBe(403);
    expect((await getChoice(c.id))!.state).toBe("open");
  });

  test("über den Tunnel ohne Access-Nachweis 403; Terminal-Schlüssel über den Tunnel 401", async () => {
    const ctx = await start();
    const c = await askInTelegram(ctx, { chatId: USER });
    const tunnel = { host: "app.tybo.ai", origin: PUBLIC, "cf-connecting-ip": "203.0.113.7" };
    const noAccess = await post(ctx, "dm", c.id, { option: "ok" }, { ...tunnel, cookie: ctx.cookie });
    expect(noAccess.status).toBe(403);
    expect((await noAccess.json()).error).toBe(ACCESS_DENIED_TEXT);
    // Mit gültigem Access-Nachweis, aber Schlüssel statt Anmeldung: gilt nur lokal
    const viaKey = await post(ctx, "dm", c.id, { option: "ok" }, { ...tunnel, "cf-access-jwt-assertion": validJwt(), authorization: `Bearer ${ctx.token}` });
    expect(viaKey.status).toBe(401);
    expect((await getChoice(c.id))!.state).toBe("open");
  });

  test("Terminal-Schlüssel lokal: entscheidet mit via terminal", async () => {
    const ctx = await start();
    const c = await askInTelegram(ctx, { chatId: USER });
    const res = await post(ctx, "dm", c.id, { option: "ok" }, { authorization: `Bearer ${ctx.token}` });
    expect(res.status).toBe(200);
    expect((await res.json()).choice.result.via).toBe("terminal");
  });
});

describe("Live: SSE choice", () => {
  test("Klick im Browser: beide Verbindungen des Gesprächs und der Sammelstrom (nur ID und Zustand)", async () => {
    const ctx = await start();
    const c = await askInTelegram(ctx, { chatId: GROUP, topicId: 443 });
    const a = await listen(ctx, "/api/conversations/topic-443/events");
    const b = await listen(ctx, "/api/conversations/topic-443/events");
    const other = await listen(ctx, "/api/conversations/topic-8/events");
    const activity = await listen(ctx, TELEGRAM_ACTIVITY_PATH);
    expect((await post(ctx, "topic-443", c.id, { option: "ok" })).status).toBe(200);
    await waitUntil(() => a.of("choice").length === 1 && b.of("choice").length === 1 && activity.of("choice").length === 1);
    for (const s of [a, b]) {
      expect(s.of("choice")[0]).toEqual({
        conversationId: "topic-443",
        choice: { id: c.id, options: [], state: "done", result: { key: "ok", label: "Erlauben", via: "web", at: expect.any(String) } },
      });
    }
    expect(activity.of("choice")[0]).toEqual({ conversationId: "topic-443", id: c.id, state: "done" });
    expect(other.of("choice")).toEqual([]);
  });

  test("Entscheidung in Telegram (via telegram) kommt ohne Neuladen; Web-Frage auch als Kopie in den Direktchat", async () => {
    const ctx = await start();
    const topic = await askInTelegram(ctx, { chatId: GROUP, topicId: 443 });
    const web = await ctx.choices.create({ conversation: { type: "web", conversationId: ctx.webId } });
    const t = await listen(ctx, "/api/conversations/topic-443/events");
    const w = await listen(ctx, `/api/conversations/${ctx.webId}/events`);
    const dm = await listen(ctx, "/api/conversations/dm/events");
    await decideChoice(topic.id, "no", "telegram");
    await decideChoice(web.id, "ok", "telegram");
    await waitUntil(() => t.of("choice").length === 1 && w.of("choice").length === 1 && dm.of("choice").length === 1);
    expect(t.of("choice")[0].choice.result).toMatchObject({ via: "telegram", label: "Ablehnen" });
    expect(w.of("choice")[0]).toMatchObject({ conversationId: ctx.webId, choice: { state: "done", result: { via: "telegram" } } });
    expect(dm.of("choice")[0]).toMatchObject({ conversationId: "dm", choice: { id: web.id, options: [], state: "done", elsewhere: ctx.webId } });
  });

  test("anderer Prozess (Sprach-Brücke) entscheidet: mit dem nächsten Abgleich kommt choice", async () => {
    const ctx = await start();
    const c = await askInTelegram(ctx, { chatId: USER });
    const s = await listen(ctx, "/api/conversations/dm/events");
    await ctx.choices.tick();
    await ctx.choices.editFile(choices => {
      choices[c.id].state = "done";
      choices[c.id].result = { key: "ok", label: "Erlauben", via: "telegram", at: Date.now() };
    });
    expect(s.of("choice")).toEqual([]);
    await ctx.choices.tick();
    await waitUntil(() => s.of("choice").length === 1);
    expect(s.of("choice")[0].choice).toMatchObject({ id: c.id, state: "done" });
  });

  test("neue Rückfrage live: SSE message trägt choice mit Knöpfen", async () => {
    const ctx = await start();
    const s = await listen(ctx, "/api/conversations/topic-443/events");
    const c = await askInTelegram(ctx, { chatId: GROUP, topicId: 443 });
    await waitUntil(() => s.of("message").length === 1);
    const m = s.of("message")[0];
    expect(m.choiceId).toBeUndefined();
    expect(m.choice).toMatchObject({ id: c.id, state: "open", options: [{ key: "ok" }, { key: "no" }] });
  });

  test("Wiederverbinden nach verpasster Entscheidung: neuer Strom plus GET zeigen erledigt", async () => {
    const ctx = await start();
    const c = await askInTelegram(ctx, { chatId: USER });
    const first = await listen(ctx, "/api/conversations/dm/events");
    await first.close();
    await decideChoice(c.id, "ok", "telegram");
    const second = await listen(ctx, "/api/conversations/dm/events");
    const [m] = await messages(ctx, "dm");
    expect(m.choice).toMatchObject({ state: "done", result: { via: "telegram" } });
    expect(second.of("choice")).toEqual([]);
  });
});

describe("Stand-Abfrage GET /api/conversations/<id>/choices?ids=", () => {
  function snapshot(ctx: Ctx, conversationId: string, ids: string, headers: Record<string, string> = { cookie: ctx.cookie }) {
    return fetch(`${ctx.url}/api/conversations/${conversationId}/choices?ids=${ids}`, { headers });
  }

  test("Frage außerhalb der jüngsten Seite, in der Lücke in Telegram entschieden: nicht im Verlauf, aber in der Stand-Abfrage", async () => {
    const ctx = await start();
    const old = await askInTelegram(ctx, { chatId: USER });
    for (let i = 0; i < 60; i++) await ctx.save(USER, `Meldung ${i}`, { display_only: true, source: "pipeline", msgId: crypto.randomUUID() });
    // Der Browser hat die ältere Seite nachgeladen und die Frage offen gesehen, dann bricht die Verbindung ab
    const stream = await listen(ctx, "/api/conversations/dm/events");
    await stream.close();
    await decideChoice(old.id, "no", "telegram");
    await listen(ctx, "/api/conversations/dm/events");
    const latest = await messages(ctx, "dm");
    expect(latest).toHaveLength(50);
    expect(latest.some(m => m.choice?.id === old.id)).toBe(false);
    const res = await snapshot(ctx, "dm", old.id);
    expect(res.status).toBe(200);
    const { choices } = await res.json();
    expect(choices).toEqual([
      { id: old.id, options: [], state: "done", result: { key: "no", label: "Ablehnen", via: "telegram", at: expect.any(String) } },
    ]);
  });

  test("Sicht des Gesprächs: offen mit Knöpfen, unbekannt abgelaufen, Web-Frage im Direktchat mit Verweis; ungültige Kennungen fallen weg", async () => {
    const ctx = await start();
    const topic = await askInTelegram(ctx, { chatId: GROUP, topicId: 443 });
    const web = await ctx.choices.create({ conversation: { type: "web", conversationId: ctx.webId } });
    const res = await snapshot(ctx, "topic-443", `${topic.id},Unbek4nnt,${topic.id},%3Cx%3E`);
    expect(res.status).toBe(200);
    expect((await res.json()).choices).toEqual([
      { id: topic.id, options: [{ key: "ok", label: "Erlauben" }, { key: "no", label: "Ablehnen" }], state: "open" },
      { id: "Unbek4nnt", options: [], state: "expired" },
    ]);
    const dm = await (await snapshot(ctx, "dm", web.id)).json();
    expect(dm.choices).toEqual([{ id: web.id, options: [], state: "open", elsewhere: ctx.webId }]);
    const empty = await snapshot(ctx, ctx.webId, "");
    expect(await empty.json()).toEqual({ choices: [] });
  });

  test("Register nicht lesbar: 503 statt abgelaufen; danach wieder der echte Stand", async () => {
    const ctx = await start();
    const c = await askInTelegram(ctx, { chatId: USER });
    const good = await readFile(ctx.choices.file, "utf8");
    await writeFile(ctx.choices.file, "{kaputt");
    const broken = await snapshot(ctx, "dm", c.id);
    expect(broken.status).toBe(503);
    expect((await broken.json()).choices).toBeUndefined();
    // Der Verlauf zeigt die Nachricht ohne Knöpfe, nicht als abgelaufen, behält aber die Kennung für die Stand-Abfrage
    const [m] = await messages(ctx, "dm");
    expect(m.choice).toBeUndefined();
    expect(m.choiceId).toBe(c.id);
    await writeFile(ctx.choices.file, good);
    expect((await (await snapshot(ctx, "dm", c.id)).json()).choices).toEqual([expect.objectContaining({ id: c.id, state: "open" })]);
  });

  test("Register nicht lesbar: Web-Verlauf und Live-Nachricht behalten choiceId ohne choice; nach der Erholung wieder choice", async () => {
    const ctx = await start();
    const web = await ctx.choices.create({ conversation: { type: "web", conversationId: ctx.webId } });
    await ctx.store.appendMessage(ctx.webId, { role: "assistant", text: "Werkzeug ausführen?", choiceId: web.id });
    const good = await readFile(ctx.choices.file, "utf8");
    const s = await listen(ctx, "/api/conversations/topic-443/events");
    await writeFile(ctx.choices.file, "{kaputt");
    const [w] = await messages(ctx, ctx.webId);
    expect(w.choice).toBeUndefined();
    expect(w.choiceId).toBe(web.id);
    await ctx.save(GROUP, "Werkzeug ausführen?", { display_only: true, source: "freigabe", choiceId: "Live1234", msgId: crypto.randomUUID(), topicId: 443 });
    await waitUntil(() => s.of("message").length === 1);
    expect(s.of("message")[0].choice).toBeUndefined();
    expect(s.of("message")[0].choiceId).toBe("Live1234");
    await writeFile(ctx.choices.file, good);
    const [again] = await messages(ctx, ctx.webId);
    expect(again.choiceId).toBeUndefined();
    expect(again.choice).toMatchObject({ id: web.id, state: "open" });
  });

  test("unbekanntes Gespräch 404, zu viele Kennungen 400, POST ohne Kennung 405, ohne Anmeldung 401", async () => {
    const ctx = await start();
    expect((await snapshot(ctx, "topic-999", "Abc123")).status).toBe(404);
    expect((await snapshot(ctx, "0b8f2a3c-1d2e-4f50-8a6b-7c8d9e0f1a2b", "Abc123")).status).toBe(404);
    const many = Array.from({ length: 201 }, (_, i) => `Id${i}`).join(",");
    expect((await snapshot(ctx, "dm", many)).status).toBe(400);
    const res = await fetch(`${ctx.url}/api/conversations/dm/choices`, { method: "POST", headers: { origin: ctx.url, cookie: ctx.cookie }, body: "{}" });
    expect(res.status).toBe(405);
    expect((await snapshot(ctx, "dm", "Abc123", {})).status).toBe(401);
  });
});
