import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunTurnOptions, WebChat } from "../src/web/chat";
import { ABORTED_TEXT, MAX_MESSAGE_CHARS, TURN_FAILED_TEXT } from "../src/web/chat";
import { SESSION_TTL_MS } from "../src/web/auth";
import { MAX_MESSAGE_BODY_BYTES, createWebServer, type WebServer, type WebServerDeps } from "../src/web/server";
import { ConversationStore } from "../src/web/store";

const PASSWORD = "test-passwort-lang";
const SECRET = "sk-ant-api03-GEHEIM";
const root = await mkdtemp(join(tmpdir(), "tybo-web-chat-"));
let counter = 0;
afterAll(() => rm(root, { recursive: true, force: true }));

type Result = { text: string; aborted?: boolean };

/** Fake-runTurn: jeder Turn wartet, bis der Test ihn freigibt. */
class FakeChat implements WebChat {
  calls: RunTurnOptions[] = [];
  stopped: string[] = [];
  private pending = new Map<string, { resolve(r: Result): void; reject(e: unknown): void; opts: RunTurnOptions }>();

  runTurn(opts: RunTurnOptions): Promise<Result> {
    this.calls.push(opts);
    return new Promise((resolve, reject) => this.pending.set(opts.conversationId, { resolve, reject, opts }));
  }

  stop(id: string): void {
    this.stopped.push(id);
    const p = this.pending.get(id);
    this.pending.delete(id);
    p?.resolve({ text: "", aborted: true });
  }

  /** Wartet, bis der Turn läuft, und gibt seinen Sink zurück. */
  async started(id: string): Promise<RunTurnOptions> {
    await waitUntil(() => this.pending.has(id));
    return this.pending.get(id)!.opts;
  }

  async finish(id: string, result: Result): Promise<void> {
    await this.started(id);
    const p = this.pending.get(id)!;
    this.pending.delete(id);
    p.resolve(result);
  }

  async fail(id: string, error: unknown): Promise<void> {
    await this.started(id);
    const p = this.pending.get(id)!;
    this.pending.delete(id);
    p.reject(error);
  }
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

interface Ctx {
  server: WebServer;
  origin: string;
  cookie: string;
  chat: FakeChat;
  logs: string[];
  dataDir: string;
  /** Seit Issue #29 legt die API keine Web-Gespräche mehr an: ältere Gespräche direkt im Speicher */
  store: ConversationStore;
}

const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

async function start(deps: Partial<WebServerDeps> = {}, withChat = true): Promise<Ctx> {
  const dir = join(root, `case-${++counter}`);
  const chat = new FakeChat();
  const logs: string[] = [];
  const dataDir = join(dir, "web");
  const store = new ConversationStore({ dir: deps.dataDir ?? dataDir, now: deps.now });
  await store.load();
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    {
      sessionFile: join(dir, "web-sessions.json"),
      dataDir,
      conversationStore: store,
      chat: withChat ? chat : undefined,
      log: m => logs.push(m),
      ...deps,
    }
  );
  servers.push(server);
  const origin = server.url;
  const res = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { origin },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return { server, origin, cookie: res.headers.get("set-cookie")!.split(";")[0], chat, logs, dataDir, store };
}

function api(ctx: Ctx, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const body = init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  return fetch(`${ctx.origin}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie: ctx.cookie, origin: ctx.origin, "content-type": "application/json", ...init.headers },
    body,
  });
}

/** Älteres Web-Gespräch (vor Issue #29 angelegt) direkt im Speicher */
async function createConversation(ctx: Ctx, body: { agent?: string } = {}): Promise<string> {
  return (await ctx.store.createConversation(body.agent ?? "general")).id;
}

function sendMessage(ctx: Ctx, id: string, text: unknown) {
  return api(ctx, `/api/conversations/${id}/messages`, { method: "POST", body: { text } });
}

async function messages(ctx: Ctx, id: string): Promise<any[]> {
  const res = await api(ctx, `/api/conversations/${id}/messages`);
  expect(res.status).toBe(200);
  return (await res.json()).messages;
}

async function waitForMessages(ctx: Ctx, id: string, count: number): Promise<any[]> {
  let list: any[] = [];
  await waitUntil(async () => (list = await messages(ctx, id)).length >= count);
  return list;
}

// ---------------------------------------------------------------------------
// SSE-Leser
// ---------------------------------------------------------------------------

interface SseItem {
  event?: string;
  data?: any;
  comment?: string;
}

class SseClient {
  private items: SseItem[] = [];
  private waiters: (() => void)[] = [];
  private buffer = "";
  readonly abort = new AbortController();
  status = 0;
  contentType = "";

  static async open(ctx: Ctx, id: string): Promise<SseClient> {
    const client = new SseClient();
    const res = await fetch(`${ctx.origin}/api/conversations/${id}/events`, {
      headers: { cookie: ctx.cookie },
      signal: client.abort.signal,
    });
    client.status = res.status;
    client.contentType = res.headers.get("content-type") ?? "";
    if (res.ok) void client.pump(res.body!);
    return client;
  }

  private async pump(body: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of body) {
        this.buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = this.buffer.indexOf("\n\n")) >= 0) {
          const block = this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + 2);
          const item: SseItem = {};
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) item.comment = line.slice(1).trim();
            else if (line.startsWith("event: ")) item.event = line.slice(7);
            else if (line.startsWith("data: ")) item.data = JSON.parse(line.slice(6));
          }
          this.items.push(item);
          this.waiters.splice(0).forEach(w => w());
        }
      }
    } catch {
      // abgebrochen
    }
    this.closed = true;
    this.waiters.splice(0).forEach(w => w());
  }

  closed = false;

  /** Nächstes Ereignis (ohne Keepalive-Kommentare). */
  async next(timeoutMs = 2000): Promise<SseItem> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const i = this.items.findIndex(x => x.event);
      if (i >= 0) {
        const [item] = this.items.splice(0, i + 1).slice(-1);
        return item;
      }
      if (this.closed) throw new Error("SSE-Verbindung geschlossen");
      if (Date.now() > end) throw new Error("Kein SSE-Ereignis");
      await new Promise<void>(r => {
        this.waiters.push(r);
        setTimeout(r, 20);
      });
    }
  }

  get all(): SseItem[] {
    return this.items;
  }

  close() {
    this.abort.abort();
  }
}

// ---------------------------------------------------------------------------
// API-Routen
// ---------------------------------------------------------------------------

describe("API-Routen", () => {
  test("ohne Login 401, auch mit gültigem Origin", async () => {
    const ctx = await start();
    const id = await createConversation(ctx);
    const paths: [string, string][] = [
      ["GET", "/api/conversations"],
      ["POST", "/api/conversations"],
      ["GET", `/api/conversations/${id}/messages`],
      ["POST", `/api/conversations/${id}/messages`],
      ["GET", `/api/conversations/${id}/events`],
      ["POST", `/api/conversations/${id}/stop`],
    ];
    for (const [method, path] of paths) {
      const res = await fetch(`${ctx.origin}${path}`, {
        method,
        headers: { origin: ctx.origin },
        body: method === "POST" ? JSON.stringify({ text: "hallo" }) : undefined,
      });
      expect(res.status).toBe(401);
    }
    expect(ctx.chat.calls).toHaveLength(0);
    expect(await messages(ctx, id)).toEqual([]);
  });

  test("schreibende Routen ohne oder mit fremdem Origin: 403", async () => {
    const ctx = await start();
    const id = await createConversation(ctx);
    for (const origin of [undefined, "http://evil.example"]) {
      for (const path of ["/api/conversations", `/api/conversations/${id}/messages`, `/api/conversations/${id}/stop`]) {
        const headers: Record<string, string> = { cookie: ctx.cookie };
        if (origin) headers.origin = origin;
        const res = await fetch(`${ctx.origin}${path}`, { method: "POST", headers, body: JSON.stringify({ text: "x" }) });
        expect(res.status).toBe(403);
      }
    }
    expect(await messages(ctx, id)).toEqual([]);
    expect((await (await api(ctx, "/api/conversations")).json()).conversations).toHaveLength(1);
  });

  test("Gespräche auflisten; Anlegen ohne Forum-Gruppe legt ein Web-Gespräch an (Issue #227)", async () => {
    const ctx = await start();
    const a = await createConversation(ctx);
    const b = await createConversation(ctx, { agent: "research" });
    const created: string[] = [];
    for (const body of [undefined, "{}", '{"agent":"research"}']) {
      const res = await api(ctx, "/api/conversations", { method: "POST", body });
      expect(res.status).toBe(201);
      created.push((await res.json()).conversation.id);
    }

    const list = (await (await api(ctx, "/api/conversations")).json()).conversations;
    expect(list.map((c: any) => c.id).sort()).toEqual([a, b, ...created].sort());
    const first = list.find((c: any) => c.id === a);
    expect(first).toMatchObject({ title: "Neues Gespräch", agent: "general" });
    expect(Object.keys(first).sort()).toEqual(["agent", "createdAt", "id", "title", "updatedAt"]);
    expect(list.find((c: any) => c.id === b).agent).toBe("research");
    expect((await readdir(ctx.dataDir)).filter(f => f.endsWith(".jsonl"))).toEqual([]);

    for (const body of ['{"agent":"../x"}', '{"agent":5}', '{"agent":""}', "{kaputt", "[1]"]) {
      expect((await api(ctx, "/api/conversations", { method: "POST", body })).status).toBe(400);
    }
    expect((await api(ctx, "/api/conversations", { method: "DELETE" })).status).toBe(405);
  });

  test("Nachricht wird gespeichert, 202, Turn bekommt Agent und Text", async () => {
    const ctx = await start();
    const id = await createConversation(ctx, { agent: "research" });
    const res = await sendMessage(ctx, id, "Wie spät ist es?");
    expect(res.status).toBe(202);
    const { message } = await res.json();
    expect(message).toMatchObject({ role: "user", text: "Wie spät ist es?" });

    const opts = await ctx.chat.started(id);
    expect(opts).toMatchObject({ conversationId: id, agent: "research", text: "Wie spät ist es?" });
    expect((await messages(ctx, id)).map(m => m.role)).toEqual(["user"]);
    const conv = (await (await api(ctx, "/api/conversations")).json()).conversations[0];
    expect(conv.title).toBe("Wie spät ist es?");

    await ctx.chat.finish(id, { text: "# Zeit\n\n- 12 Uhr\n\n[REMEMBER: test]" });
    const list = await waitForMessages(ctx, id, 2);
    expect(list[1]).toMatchObject({ role: "assistant", text: "# Zeit\n\n- 12 Uhr\n\n[REMEMBER: test]" });
    expect(list[1].html).toContain("<h1>Zeit</h1>");
    expect(list[1].html).not.toContain("[REMEMBER:");
    expect(list[0].html).toBeUndefined();
  });

  test("zweite Nachricht während eines laufenden Turns: 409, nichts gespeichert", async () => {
    const ctx = await start();
    const id = await createConversation(ctx);
    // gleichzeitig abgeschickt
    const results = await Promise.all([sendMessage(ctx, id, "eins"), sendMessage(ctx, id, "zwei"), sendMessage(ctx, id, "drei")]);
    expect(results.map(r => r.status).sort()).toEqual([202, 409, 409]);
    expect(await messages(ctx, id)).toHaveLength(1);
    expect((await sendMessage(ctx, id, "vier")).status).toBe(409);
    expect(await messages(ctx, id)).toHaveLength(1);
    expect(ctx.chat.calls).toHaveLength(1);

    // anderes Gespräch ist nicht gesperrt
    const other = await createConversation(ctx);
    expect((await sendMessage(ctx, other, "parallel")).status).toBe(202);

    await ctx.chat.finish(id, { text: "fertig" });
    await waitForMessages(ctx, id, 2);
    expect((await sendMessage(ctx, id, "fünf")).status).toBe(202);
    await ctx.chat.finish(id, { text: "auch fertig" });
    await ctx.chat.finish(other, { text: "ok" });
    expect((await waitForMessages(ctx, id, 4)).map(m => m.text)).toEqual(["eins", "fertig", "fünf", "auch fertig"]);
  });

  test("leere, typfalsche und zu lange Nachrichten werden abgelehnt", async () => {
    const ctx = await start();
    const id = await createConversation(ctx);
    for (const body of ['{"text":""}', '{"text":"   \\n"}', '{"text":5}', '{"text":null}', "{}", "[]", "kaputt", ""]) {
      const res = await api(ctx, `/api/conversations/${id}/messages`, { method: "POST", body });
      expect(res.status).toBe(400);
    }
    expect((await sendMessage(ctx, id, "a".repeat(MAX_MESSAGE_CHARS + 1))).status).toBe(400);
    expect((await sendMessage(ctx, id, "😀".repeat(MAX_MESSAGE_CHARS + 1))).status).toBe(400);
    expect(await messages(ctx, id)).toEqual([]);
    expect(ctx.chat.calls).toHaveLength(0);
  });

  test("20.000 Zeichen passen auch dann, wenn das JSON über 64 KiB liegt", async () => {
    const ctx = await start();
    const cases = [
      "a".repeat(MAX_MESSAGE_CHARS),
      "😀".repeat(MAX_MESSAGE_CHARS), // 80 KB UTF-8
      "\u0001".repeat(MAX_MESSAGE_CHARS), // JSON \u0001: 120 KB
    ];
    for (const text of cases) {
      const id = await createConversation(ctx);
      const res = await sendMessage(ctx, id, text);
      expect(res.status).toBe(202);
      await ctx.chat.finish(id, { text: "ok" });
      expect((await waitForMessages(ctx, id, 2))[0].text).toBe(text);
    }
    // Schlimmster Fall: jedes Zeichen als \uXXXX\uXXXX escaped, 240 KB
    const id = await createConversation(ctx);
    const escaped = `{"text":"${"\\ud83d\\ude00".repeat(MAX_MESSAGE_CHARS)}"}`;
    expect(Buffer.byteLength(escaped)).toBeGreaterThan(200_000);
    expect((await api(ctx, `/api/conversations/${id}/messages`, { method: "POST", body: escaped })).status).toBe(202);
    await ctx.chat.finish(id, { text: "ok" });

    // Darüber hinaus 413, andere Routen behalten 64 KiB
    const huge = JSON.stringify({ text: "a".repeat(MAX_MESSAGE_BODY_BYTES) });
    expect((await api(ctx, `/api/conversations/${id}/messages`, { method: "POST", body: huge })).status).toBe(413);
    const big = JSON.stringify({ agent: "a".repeat(70 * 1024) });
    expect((await api(ctx, "/api/conversations", { method: "POST", body: big })).status).toBe(413);
    const login = await fetch(`${ctx.origin}/api/login`, {
      method: "POST",
      headers: { origin: ctx.origin },
      body: JSON.stringify({ password: "x".repeat(70 * 1024) }),
    });
    expect(login.status).toBe(413);
  });

  test("unbekannte UUID und ../x: 404, kein Aufruf, keine Datei", async () => {
    const ctx = await start();
    await createConversation(ctx);
    const unknown = crypto.randomUUID();
    for (const id of [unknown, "..%2Fx", "%2E%2E%2Fx", "x", "..%2F..%2Fweb-sessions"]) {
      expect((await api(ctx, `/api/conversations/${id}/messages`)).status).toBe(404);
      expect((await sendMessage(ctx, id, "hallo")).status).toBe(404);
      expect((await api(ctx, `/api/conversations/${id}/events`)).status).toBe(404);
      expect((await api(ctx, `/api/conversations/${id}/stop`, { method: "POST" })).status).toBe(404);
    }
    // Roh gesendet, damit fetch "../x" nicht vorher auflöst
    for (const path of ["/api/conversations/../x/messages", "/api/conversations/..%2Fx/messages", "/api/conversations/../../web-sessions.json"]) {
      const raw = await rawGet(ctx, path);
      expect(raw).toMatch(/^HTTP\/1\.1 404/);
    }
    expect(ctx.chat.calls).toHaveLength(0);
    expect((await readdir(ctx.dataDir)).sort()).toEqual(["conversations.json"]);
  });

  test("ohne eingebundenen Chat: 503, nichts gespeichert", async () => {
    const ctx = await start({}, false);
    const id = await createConversation(ctx);
    expect((await sendMessage(ctx, id, "hallo")).status).toBe(503);
    expect(await messages(ctx, id)).toEqual([]);
  });

  test("Stop führt zu gespeicherter Abgebrochen-Nachricht, danach neuer Turn möglich", async () => {
    const ctx = await start();
    const id = await createConversation(ctx);
    const idle = await api(ctx, `/api/conversations/${id}/stop`, { method: "POST" });
    expect(await idle.json()).toEqual({ stopping: false });
    expect(ctx.chat.stopped).toEqual([]);

    await sendMessage(ctx, id, "lange Aufgabe");
    await ctx.chat.started(id);
    const res = await api(ctx, `/api/conversations/${id}/stop`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopping: true });
    expect(ctx.chat.stopped).toEqual([id]);
    const list = await waitForMessages(ctx, id, 2);
    expect(list[1]).toMatchObject({ role: "error", text: ABORTED_TEXT });

    await waitUntil(async () => (await sendMessage(ctx, id, "nochmal")).status === 202);
    await ctx.chat.finish(id, { text: "geht wieder" });
    expect((await waitForMessages(ctx, id, 4))[3]).toMatchObject({ role: "assistant", text: "geht wieder" });
  });

  test("Fehler in runTurn: error-Nachricht ohne Stacktrace und Zugangsdaten, danach neuer Turn", async () => {
    const ctx = await start();
    const id = await createConversation(ctx);
    await sendMessage(ctx, id, "mach was");
    const error = new Error(`Verbindung fehlgeschlagen mit Key ${SECRET}`);
    await ctx.chat.fail(id, error);
    const list = await waitForMessages(ctx, id, 2);
    expect(list[1]).toMatchObject({ role: "error", text: TURN_FAILED_TEXT });
    const raw = JSON.stringify(list);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("at ");
    expect(ctx.logs.join("\n")).not.toContain(SECRET);

    await waitUntil(async () => (await sendMessage(ctx, id, "nochmal")).status === 202);
    await ctx.chat.finish(id, { text: "jetzt klappt es" });
    expect((await waitForMessages(ctx, id, 4))[3].text).toBe("jetzt klappt es");
  });

  test("Gespräche und Nachrichten überstehen einen Neustart", async () => {
    const ctx = await start();
    const id = await createConversation(ctx);
    await sendMessage(ctx, id, "bleib da");
    await ctx.chat.finish(id, { text: "**bin da**" });
    await waitForMessages(ctx, id, 2);
    await ctx.server.stop();

    const again = await start({ dataDir: ctx.dataDir });
    const list = (await (await api(again, "/api/conversations")).json()).conversations;
    expect(list.map((c: any) => [c.id, c.title])).toEqual([[id, "bleib da"]]);
    const msgs = await messages(again, id);
    expect(msgs.map(m => m.text)).toEqual(["bleib da", "**bin da**"]);
    expect(msgs[1].html).toContain("<strong>bin da</strong>");
  });
});

function rawGet(ctx: Ctx, path: string): Promise<string> {
  const { hostname, port, host } = new URL(ctx.origin);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nCookie: ${ctx.cookie}\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.on("data", d => {
      data += d.toString();
      if (data.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Server-Sent Events
// ---------------------------------------------------------------------------

describe("Server-Sent Events", () => {
  test("status, dann progress und notice, dann message mit html ohne [REMEMBER:, dann status", async () => {
    const ctx = await start();
    const id = await createConversation(ctx);
    const sse = await SseClient.open(ctx, id);
    expect(sse.status).toBe(200);
    expect(sse.contentType).toContain("text/event-stream");
    expect(await sse.next()).toEqual({ event: "status", data: { running: false } });

    expect((await sendMessage(ctx, id, "Hallo")).status).toBe(202);
    expect(await sse.next()).toEqual({ event: "status", data: { running: true } });

    const { sink } = await ctx.chat.started(id);
    await sink.progress({ kind: "tool", text: "Read" });
    await sink.progress({ kind: "snippet", text: "Ich schaue nach" });
    await sink.notice("Läuft seit 20 Minuten");
    await ctx.chat.finish(id, { text: "## Antwort\n\n- eins\n\n```ts\nconst a = 1;\n```\n\n[REMEMBER: test]" });

    expect(await sse.next()).toEqual({ event: "progress", data: { kind: "tool", text: "Read" } });
    expect(await sse.next()).toEqual({ event: "progress", data: { kind: "snippet", text: "Ich schaue nach" } });
    expect(await sse.next()).toEqual({ event: "notice", data: { text: "Läuft seit 20 Minuten" } });
    const message = await sse.next();
    expect(message.event).toBe("message");
    expect(message.data.role).toBe("assistant");
    expect(message.data.html).toContain("<h2>Antwort</h2>");
    expect(message.data.html).toContain("<li>eins</li>");
    expect(message.data.html).not.toContain("[REMEMBER:");
    // Antwort ist gespeichert, bevor das Ereignis kommt
    const stored = await messages(ctx, id);
    expect(stored[1].id).toBe(message.data.id);
    expect(stored[1].html).toBe(message.data.html);
    expect(await sse.next()).toEqual({ event: "status", data: { running: false } });

    // Späte Sink-Aufrufe nach Turn-Ende gehen nicht mehr raus
    await sink.progress({ kind: "tool", text: "zu spät" });
    await Bun.sleep(50);
    expect(sse.all.some(i => i.event)).toBe(false);
    sse.close();
  });

  test("Neue Verbindung während eines Turns meldet running: true, mehrere Zuhörer bekommen alles", async () => {
    const ctx = await start();
    const id = await createConversation(ctx);
    await sendMessage(ctx, id, "Hallo");
    const a = await SseClient.open(ctx, id);
    const b = await SseClient.open(ctx, id);
    expect(await a.next()).toEqual({ event: "status", data: { running: true, awaiting: false } });
    expect(await b.next()).toEqual({ event: "status", data: { running: true, awaiting: false } });
    await ctx.chat.finish(id, { text: "fertig" });
    for (const c of [a, b]) {
      expect((await c.next()).event).toBe("message");
      expect(await c.next()).toEqual({ event: "status", data: { running: false } });
      c.close();
    }
    // Stopp, während die Browser gerade trennen, darf nicht hängen
    await ctx.server.stop();
  });

  test("Stop: error-Ereignis mit Abgebrochen.", async () => {
    const ctx = await start();
    const id = await createConversation(ctx);
    const sse = await SseClient.open(ctx, id);
    await sse.next();
    await sendMessage(ctx, id, "lange");
    await sse.next();
    await ctx.chat.started(id);
    await api(ctx, `/api/conversations/${id}/stop`, { method: "POST" });
    const err = await sse.next();
    expect(err.event).toBe("error");
    expect(err.data).toMatchObject({ role: "error", text: ABORTED_TEXT });
    expect(await sse.next()).toEqual({ event: "status", data: { running: false } });
    sse.close();
  });

  test("Fehler in runTurn: error-Ereignis ohne Stacktrace", async () => {
    const ctx = await start();
    const id = await createConversation(ctx);
    const sse = await SseClient.open(ctx, id);
    await sse.next();
    await sendMessage(ctx, id, "mach was");
    await sse.next();
    await ctx.chat.fail(id, new Error(`kaputt ${SECRET}`));
    const err = await sse.next();
    expect(err.event).toBe("error");
    expect(err.data.text).toBe(TURN_FAILED_TEXT);
    expect(JSON.stringify(err.data)).not.toContain(SECRET);
    expect(JSON.stringify(err.data)).not.toMatch(/\bat\s|\.ts:\d/);
    expect(await sse.next()).toEqual({ event: "status", data: { running: false } });
    sse.close();
  });

  test("Keepalive-Kommentar im eingestellten Abstand", async () => {
    const ctx = await start({ keepaliveMs: 30 });
    const id = await createConversation(ctx);
    const sse = await SseClient.open(ctx, id);
    await sse.next();
    await waitUntil(() => sse.all.filter(i => i.comment === "keepalive").length >= 2, 1000);
    sse.close();
  });

  test("Keepalive-Standard: 20 Sekunden, nicht früher", async () => {
    const ctx = await start();
    const id = await createConversation(ctx);
    const sse = await SseClient.open(ctx, id);
    await sse.next();
    await Bun.sleep(100);
    expect(sse.all.some(i => i.comment)).toBe(false);
    sse.close();
  });

  test("Abmelden und Server-Stopp räumen Verbindungen und Timer auf", async () => {
    const ctx = await start({ keepaliveMs: 10 });
    const id = await createConversation(ctx);
    const a = await SseClient.open(ctx, id);
    const b = await SseClient.open(ctx, id);
    await a.next();
    await b.next();
    expect(ctx.server.eventStreamCount()).toBe(2);
    a.close();
    await waitUntil(() => ctx.server.eventStreamCount() === 1);

    await ctx.server.stop();
    expect(ctx.server.eventStreamCount()).toBe(0);
    await waitUntil(() => b.closed, 1000);
  });
});

describe("SSE und Anmelde-Session", () => {
  async function login(ctx: Ctx): Promise<string> {
    const res = await fetch(`${ctx.origin}/api/login`, {
      method: "POST",
      headers: { origin: ctx.origin },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    return res.headers.get("set-cookie")!.split(";")[0];
  }

  test("/api/logout beendet offene Streams dieser Session, andere Session läuft weiter", async () => {
    const ctx = await start();
    const other: Ctx = { ...ctx, cookie: await login(ctx) };
    const id = await createConversation(ctx);
    const mine = await SseClient.open(ctx, id);
    const theirs = await SseClient.open(other, id);
    await mine.next();
    await theirs.next();
    expect(ctx.server.eventStreamCount()).toBe(2);

    expect((await api(ctx, "/api/logout", { method: "POST" })).status).toBe(200);
    await waitUntil(() => mine.closed, 1000);
    expect(ctx.server.eventStreamCount()).toBe(1);

    // Neue Daten kommen nur noch bei der anderen Session an
    const before = mine.all.length;
    expect((await sendMessage(other, id, "geheim")).status).toBe(202);
    await ctx.chat.finish(id, { text: "vertrauliche Antwort" });
    expect(await theirs.next()).toEqual({ event: "status", data: { running: true } });
    expect((await theirs.next()).data.text).toBe("vertrauliche Antwort");
    expect(await theirs.next()).toEqual({ event: "status", data: { running: false } });
    expect(mine.all.length).toBe(before);
    expect(JSON.stringify(mine.all)).not.toContain("vertrauliche Antwort");

    // Der alte Cookie öffnet keinen neuen Stream
    expect((await SseClient.open(ctx, id)).status).toBe(401);
    theirs.close();
  });

  test("abgelaufene Session: keine Daten mehr, Stream wird beendet, andere Session läuft weiter", async () => {
    let now = Date.now();
    const ctx = await start({ now: () => now });
    const id = await createConversation(ctx);
    const old = await SseClient.open(ctx, id);
    await old.next();

    // Kurz vor Ablauf der ersten Session eine zweite anmelden, dann die erste ablaufen lassen
    now += SESSION_TTL_MS - 1000;
    const other: Ctx = { ...ctx, cookie: await login(ctx) };
    const fresh = await SseClient.open(other, id);
    await fresh.next();
    now += 2000;

    const before = old.all.length;
    expect((await sendMessage(other, id, "geheim")).status).toBe(202);
    await ctx.chat.finish(id, { text: "vertrauliche Antwort" });
    expect(await fresh.next()).toEqual({ event: "status", data: { running: true } });
    expect((await fresh.next()).data.text).toBe("vertrauliche Antwort");
    await waitUntil(() => old.closed, 1000);
    expect(old.all.length).toBe(before);
    expect(ctx.server.eventStreamCount()).toBe(1);
    fresh.close();
  });

  test("abgelaufene Session ohne Ereignisse: Keepalive beendet den Stream", async () => {
    let now = Date.now();
    const ctx = await start({ now: () => now, keepaliveMs: 20 });
    const id = await createConversation(ctx);
    const sse = await SseClient.open(ctx, id);
    await sse.next();
    await waitUntil(() => sse.all.some(i => i.comment === "keepalive"), 1000);
    now += SESSION_TTL_MS + 1;
    await waitUntil(() => sse.closed, 1000);
    expect(ctx.server.eventStreamCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Attrappe für web:dev
// ---------------------------------------------------------------------------

describe("Attrappe", () => {
  test("zwei Fortschritte, dann Markdown mit [REMEMBER: test]; stop bricht ab", async () => {
    const { createFakeChat, FAKE_REPLY } = await import("../src/web/fake-chat");
    const chat = createFakeChat({ delayMs: 20, stepMs: 5 });
    const events: string[] = [];
    const sink = { progress: (p: { kind: string }) => void events.push(p.kind), notice: () => {} };
    const result = await chat.runTurn({ conversationId: "a", agent: "general", text: "hi", sink });
    expect(events).toEqual(["tool", "snippet"]);
    // Issue #22: Agent, Modell der Attrappe und gemessene Dauer (mindestens die Wartezeiten)
    expect(result).toEqual({ text: FAKE_REPLY, info: { agent: "general", model: "attrappe", durationMs: expect.any(Number) } });
    expect(result.info!.durationMs).toBeGreaterThanOrEqual(20);
    expect(FAKE_REPLY).toMatch(/^## /m);
    expect(FAKE_REPLY).toMatch(/^- /m);
    expect(FAKE_REPLY).toContain("```ts");
    expect(FAKE_REPLY).toContain("[REMEMBER: test]");

    const slow = createFakeChat({ delayMs: 5000 });
    const pending = slow.runTurn({ conversationId: "b", agent: "general", text: "hi", sink });
    slow.stop("b");
    expect(await pending).toEqual({ text: "", aborted: true });
  });
});
