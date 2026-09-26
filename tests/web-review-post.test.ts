/**
 * Issue #117: Merk-Vorschläge im reinen Web-Gespräch. Der Web-Server legt
 * eine Nachricht von außerhalb eines Turns (postToConversation) im Gespräch
 * ab, bei laufendem Turn erst danach, und schickt sie mit dem Zustand der
 * Rückfrage (choice) an die offenen Browser. Echter Server, echtes Register
 * (Temp-Datei) und echter ChoicePort; der Chat ist eine Attrappe, die der
 * Test freigibt.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideChoice, setChoicesFileForTests } from "../src/lib/choices";
import type { RunTurnOptions, TurnResult, WebChat } from "../src/web/chat";
import { createWebServer, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import { testChoices, type TestChoices } from "./choices-fixture";

const PASSWORD = "test-passwort-lang";
const USER = "4711";
const root = await mkdtemp(join(tmpdir(), "tybo-review-post-"));
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

/** Turn, der erst endet, wenn der Test release() ruft */
class HeldChat implements WebChat {
  private releases: (() => void)[] = [];
  started = 0;
  async runTurn(_opts: RunTurnOptions): Promise<TurnResult> {
    this.started++;
    await new Promise<void>(resolve => this.releases.push(resolve));
    return { text: "Antwort mit Merk-Tag" };
  }
  release() {
    for (const r of this.releases.splice(0)) r();
  }
  stop() {}
}

interface Ctx {
  url: string;
  cookie: string;
  server: WebServer;
  store: ConversationStore;
  webId: string;
  chat: HeldChat;
  choices: TestChoices;
}

async function start(): Promise<Ctx> {
  const dir = join(root, `case-${++counter}`);
  const store = new ConversationStore({ dir: join(dir, "web") });
  await store.load();
  const webId = (await store.createConversation("general")).id;
  const choices = testChoices(join(dir, "choices.json"), { userId: USER });
  const chat = new HeldChat();
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    { sessionFile: join(dir, "sessions.json"), conversationStore: store, chat, choices: choices.port, keepaliveMs: 60_000, log: () => {} }
  );
  servers.push(server);
  const res = await fetch(`${server.url}/api/login`, { method: "POST", headers: { origin: server.url }, body: JSON.stringify({ password: PASSWORD }) });
  expect(res.status).toBe(200);
  await choices.tick();
  return { url: server.url, cookie: res.headers.get("set-cookie")!.split(";")[0], server, store, webId, chat, choices };
}

async function messages(ctx: Ctx): Promise<any[]> {
  const res = await fetch(`${ctx.url}/api/conversations/${ctx.webId}/messages`, { headers: { cookie: ctx.cookie } });
  expect(res.status).toBe(200);
  return (await res.json()).messages;
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

async function listen(ctx: Ctx) {
  const controller = new AbortController();
  const res = await fetch(`${ctx.url}/api/conversations/${ctx.webId}/events`, { headers: { cookie: ctx.cookie }, signal: controller.signal });
  expect(res.status).toBe(200);
  const events: { event: string; data: any }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let opened = false;
  void (async () => {
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
  return { of: (name: string) => events.filter(e => e.event === name).map(e => e.data) };
}

const REVIEW_OPTIONS = [
  { key: "ok", label: "Übernehmen" },
  { key: "no", label: "Verwerfen" },
];

describe("postToConversation", () => {
  test("während eines Turns: Vorschlag erscheint erst nach der Antwort, mit Knöpfen, live und im Verlauf", async () => {
    const ctx = await start();
    const sse = await listen(ctx);
    const choice = await ctx.choices.create({ kind: "review", conversation: { type: "web", conversationId: ctx.webId }, options: REVIEW_OPTIONS, text: "🧠 Merk-Vorschlag" });

    const sent = await fetch(`${ctx.url}/api/conversations/${ctx.webId}/messages`, {
      method: "POST",
      headers: { origin: ctx.url, cookie: ctx.cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "lies die Seite" }),
    });
    expect(sent.status).toBe(202);
    await waitUntil(() => ctx.chat.started === 1);

    // Angenommen, ohne auf den Turn zu warten
    expect(await ctx.server.postToConversation(ctx.webId, { text: "🧠 Merk-Vorschlag\n\n• Fakt merken: x", kind: "notice", source: "review", choiceId: choice.id })).toBe(true);
    await Bun.sleep(20);
    expect((await messages(ctx)).map(m => m.role)).toEqual(["user"]);

    ctx.chat.release();
    await waitUntil(async () => (await messages(ctx)).length === 3);
    const list = await messages(ctx);
    expect(list.map(m => [m.role, m.kind ?? null])).toEqual([["user", null], ["assistant", null], ["assistant", "notice"]]);
    expect(list[2]).toMatchObject({ source: "review", text: "🧠 Merk-Vorschlag\n\n• Fakt merken: x", choice: { id: choice.id, state: "open", options: REVIEW_OPTIONS } });
    expect(list[2].choiceId).toBeUndefined();

    // Live: Antwort, dann der Vorschlag mit Knöpfen
    await waitUntil(() => sse.of("message").length === 2);
    const live = sse.of("message");
    expect(live[0].text).toBe("Antwort mit Merk-Tag");
    expect(live[1]).toMatchObject({ kind: "notice", source: "review", choice: { id: choice.id, state: "open", options: REVIEW_OPTIONS } });

    // Entscheidung aus Telegram: der Browser sieht sie ohne Neuladen
    await decideChoice(choice.id, "no", "telegram");
    await waitUntil(() => sse.of("choice").length > 0);
    expect(sse.of("choice")[0]).toMatchObject({ conversationId: ctx.webId, choice: { id: choice.id, state: "done", result: { label: "Verwerfen", via: "telegram" } } });
  });

  test("ohne laufenden Turn sofort; Meldung ohne Rückfrage (Ergebnis) und Antwort (Routine-Bericht)", async () => {
    const ctx = await start();
    expect(await ctx.server.postToConversation(ctx.webId, { text: "Verworfen, nichts gespeichert.", kind: "notice", source: "review" })).toBe(true);
    expect(await ctx.server.postToConversation(ctx.webId, { text: "Routine gespeichert" })).toBe(true);
    await waitUntil(async () => (await messages(ctx)).length === 2);
    const [notice, report] = await messages(ctx);
    expect(notice).toMatchObject({ role: "assistant", kind: "notice", source: "review", text: "Verworfen, nichts gespeichert." });
    expect(notice.choice).toBeUndefined();
    expect(report).toMatchObject({ role: "assistant", text: "Routine gespeichert" });
    expect(report.kind).toBeUndefined();
  });

  test("unbekanntes oder ungültiges Gespräch, leerer Text, beendeter Server: false, nichts abgelegt", async () => {
    const ctx = await start();
    expect(await ctx.server.postToConversation("11111111-2222-4333-8444-555555555555", { text: "x" })).toBe(false);
    expect(await ctx.server.postToConversation("dm", { text: "x" })).toBe(false);
    expect(await ctx.server.postToConversation("../web", { text: "x" })).toBe(false);
    expect(await ctx.server.postToConversation(ctx.webId, { text: "  " })).toBe(false);
    // Ungültige Quelle und Kennung fallen weg, die Meldung bleibt
    expect(await ctx.server.postToConversation(ctx.webId, { text: "Hinweis", kind: "notice", source: "Böse Quelle", choiceId: "../x" })).toBe(true);
    await waitUntil(async () => (await messages(ctx)).length === 1);
    const [m] = await messages(ctx);
    expect(m.source).toBeUndefined();
    expect(m.choice).toBeUndefined();
    await ctx.server.stop();
    servers.splice(servers.indexOf(ctx.server), 1);
    expect(await ctx.server.postToConversation(ctx.webId, { text: "x" })).toBe(false);
  });
});
