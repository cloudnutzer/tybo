/**
 * Web-Gespräche verwalten über die API (Issue #21): Agentenliste,
 * Agent beim Anlegen, umbenennen, löschen samt Sperre und Session-Reset.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS } from "../src/agents";
import { agentLabel, agentList, FALLBACK_AGENT_NAMES } from "../src/web/agents";
import { ChatHub, type MessageLog, type RunTurnOptions, type WebChat } from "../src/web/chat";
import { createWebServer, type WebServer, type WebServerDeps } from "../src/web/server";
import { ConversationStore, type NewMessage, type StoredMessage } from "../src/web/store";

const PASSWORD = "test-passwort-lang";
const root = await mkdtemp(join(tmpdir(), "tybo-web-manage-"));
let counter = 0;
afterAll(() => rm(root, { recursive: true, force: true }));

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

/** Turn-Attrappe: jeder Turn wartet, bis der Test ihn beendet. */
class FakeChat implements WebChat {
  calls: RunTurnOptions[] = [];
  answers: string[] = [];
  private pending = new Map<string, { resolve(r: { text: string; aborted?: boolean }): void; opts: RunTurnOptions }>();

  runTurn(opts: RunTurnOptions) {
    this.calls.push(opts);
    return new Promise<{ text: string; aborted?: boolean }>(resolve => this.pending.set(opts.conversationId, { resolve, opts }));
  }
  stop(id: string): void {
    const p = this.pending.get(id);
    this.pending.delete(id);
    p?.resolve({ text: "", aborted: true });
  }
  answer(_id: string, text: string): boolean {
    this.answers.push(text);
    return true;
  }
  async started(id: string): Promise<RunTurnOptions> {
    await waitUntil(() => this.pending.has(id));
    return this.pending.get(id)!.opts;
  }
  async finish(id: string, text: string): Promise<void> {
    await this.started(id);
    const p = this.pending.get(id)!;
    this.pending.delete(id);
    p.resolve({ text });
  }
}

interface Ctx {
  server: WebServer;
  origin: string;
  cookie: string;
  chat: FakeChat;
  dataDir: string;
  resets: string[];
  logs: string[];
  /** Seit Issue #29 legt die API keine Web-Gespräche mehr an: ältere Gespräche direkt im Speicher */
  store: ConversationStore;
}

const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
});

async function start(deps: Partial<WebServerDeps> = {}): Promise<Ctx> {
  const dir = join(root, `case-${++counter}`);
  const chat = new FakeChat();
  const resets: string[] = [];
  const logs: string[] = [];
  const dataDir = join(dir, "web");
  const store = new ConversationStore({ dir: dataDir });
  await store.load();
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    {
      sessionFile: join(dir, "web-sessions.json"),
      dataDir,
      conversationStore: store,
      chat,
      resetSession: async key => {
        resets.push(key);
        return 1;
      },
      log: m => logs.push(m),
      ...deps,
    }
  );
  servers.push(server);
  const origin = server.url;
  const res = await fetch(`${origin}/api/login`, { method: "POST", headers: { origin }, body: JSON.stringify({ password: PASSWORD }) });
  expect(res.status).toBe(200);
  return { server, origin, cookie: res.headers.get("set-cookie")!.split(";")[0], chat, dataDir, resets, logs, store };
}

function api(ctx: Ctx, path: string, method = "GET", body?: unknown) {
  return fetch(`${ctx.origin}${path}`, {
    method,
    headers: { cookie: ctx.cookie, origin: ctx.origin, "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Älteres Web-Gespräch (vor Issue #29 angelegt) direkt im Speicher */
async function create(ctx: Ctx, body: { agent?: string } = {}): Promise<any> {
  return ctx.store.createConversation(body.agent ?? "general");
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

describe("Agentenliste", () => {
  test("Ersatzliste passt zu AGENTS in src/agents", () => {
    expect([...FALLBACK_AGENT_NAMES].sort()).toEqual(Object.keys(AGENTS).sort());
  });

  test("agentList: General zuerst, ohne Doppelte und ungültige Namen, Anzeigenamen", () => {
    expect(agentList(["research", "general", "cto", "research", "../x", "Bad"])).toEqual([
      { name: "general", label: "General" },
      { name: "research", label: "Research" },
      { name: "cto", label: "CTO" },
    ]);
    expect(agentList([{ name: "coo", label: " Betrieb " }, { name: "finance" }])).toEqual([
      { name: "coo", label: "Betrieb" },
      { name: "finance", label: "Finance" },
    ]);
    expect(agentLabel("coo")).toBe("COO");
  });

  test("GET /api/agents liefert die Liste; nur GET, nur angemeldet", async () => {
    const ctx = await start();
    const res = await api(ctx, "/api/agents");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.defaultAgent).toBe("general");
    expect(body.agents[0]).toEqual({ name: "general", label: "General" });
    expect(body.agents.map((a: any) => a.name).sort()).toEqual([...FALLBACK_AGENT_NAMES].sort());
    // POST legt seit Issue #50 Agenten an, ohne Katalog 503; andere Methoden 405
    expect((await api(ctx, "/api/agents", "POST", {})).status).toBe(503);
    expect((await api(ctx, "/api/agents", "PUT", {})).status).toBe(405);
    const anon = await fetch(`${ctx.origin}/api/agents`);
    expect(anon.status).toBe(401);
  });

  test("übergebene Liste (wie aus bot.ts) gilt für GET und POST", async () => {
    const ctx = await start({ agents: [{ name: "research", label: "Research" }, { name: "general", label: "General" }] });
    expect((await (await api(ctx, "/api/agents")).json()).agents).toEqual([
      { name: "general", label: "General" },
      { name: "research", label: "Research" },
    ]);
    expect((await api(ctx, "/api/conversations", "POST", { agent: "cto" })).status).toBe(400);
    // Gültiger Agent: geprüft wird bestanden; ohne Forum-Gruppe ein Web-Gespräch (Issue #227)
    expect((await api(ctx, "/api/conversations", "POST", { agent: "research" })).status).toBe(201);
  });
});

describe("Anlegen mit Agent", () => {
  test("gültige Agenten bestehen die Prüfung (ohne Forum-Gruppe Web-Gespräch, Issue #227), unbekannter Agent 400 ohne Gespräch", async () => {
    const ctx = await start();
    const agents: string[] = [];
    for (const body of [{ agent: "research" }, {}, undefined]) {
      const res = await api(ctx, "/api/conversations", "POST", body);
      expect(res.status).toBe(201);
      agents.push((await res.json()).conversation.agent);
    }
    expect(agents).toEqual(["research", "general", "general"]);
    for (const agent of ["hacker", "zz", "general2", 5, "", null]) {
      const res = await api(ctx, "/api/conversations", "POST", { agent });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Ungültiger Agent");
    }
    expect((await (await api(ctx, "/api/conversations")).json()).conversations).toHaveLength(3);
  });
});

describe("Umbenennen (PATCH)", () => {
  test("Titel normalisiert setzen, nach Neustart erhalten", async () => {
    const ctx = await start();
    const c = await create(ctx);
    const res = await api(ctx, `/api/conversations/${c.id}`, "PATCH", { title: "  Reise\n nach   Rom " });
    expect(res.status).toBe(200);
    expect((await res.json()).conversation).toMatchObject({ id: c.id, title: "Reise nach Rom" });
    expect((await (await api(ctx, `/api/conversations/${c.id}`)).json()).conversation.title).toBe("Reise nach Rom");

    // Die erste Nachricht überschreibt den Titel nicht
    expect((await api(ctx, `/api/conversations/${c.id}/messages`, "POST", { text: "Erste Frage" })).status).toBe(202);
    await ctx.chat.finish(c.id, "Antwort");

    await waitUntil(async () => !(await (await api(ctx, `/api/conversations/${c.id}`)).json()).running);
    const fresh = new ConversationStore({ dir: ctx.dataDir });
    await fresh.load();
    expect((await fresh.getConversation(c.id))!.title).toBe("Reise nach Rom");
    expect((await fresh.getMessages(c.id)).map(m => m.text)).toEqual(["Erste Frage", "Antwort"]);
  });

  test("80 Zeichen nach Normalisieren ok, 81 Zeichen, leer und typfalsch 400", async () => {
    const ctx = await start();
    const c = await create(ctx);
    const ok80 = "  " + "a".repeat(40) + "\n\n" + "b".repeat(39) + "  ";
    const ok = await api(ctx, `/api/conversations/${c.id}`, "PATCH", { title: ok80 });
    expect(ok.status).toBe(200);
    expect([...(await ok.json()).conversation.title].length).toBe(80);

    for (const body of [
      { title: "x".repeat(81) },
      { title: "" },
      { title: "   \n " },
      { title: 42 },
      { title: null },
      { title: ["a"] },
      {},
      [1],
      "{kaputt",
    ]) {
      const res = await api(ctx, `/api/conversations/${c.id}`, "PATCH", body);
      expect(res.status).toBe(400);
    }
    expect((await (await api(ctx, `/api/conversations/${c.id}`)).json()).conversation.title).toBe(ok80.replace(/\s+/g, " ").trim());
  });

  test("unbekanntes Gespräch 404, andere Methoden 405", async () => {
    const ctx = await start();
    expect((await api(ctx, `/api/conversations/${crypto.randomUUID()}`, "PATCH", { title: "a" })).status).toBe(404);
    const c = await create(ctx);
    const put = await api(ctx, `/api/conversations/${c.id}`, "PUT", { title: "a" });
    expect(put.status).toBe(405);
    expect(put.headers.get("allow")).toBe("GET, PATCH, DELETE");
  });

  test("fremder Origin wird abgewiesen", async () => {
    const ctx = await start();
    const c = await create(ctx);
    const res = await fetch(`${ctx.origin}/api/conversations/${c.id}`, {
      method: "PATCH",
      headers: { cookie: ctx.cookie, origin: "http://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ title: "gekapert" }),
    });
    expect(res.status).toBe(403);
    const del = await fetch(`${ctx.origin}/api/conversations/${c.id}`, {
      method: "DELETE",
      headers: { cookie: ctx.cookie, origin: "http://evil.example" },
    });
    expect(del.status).toBe(403);
  });
});

describe("Löschen (DELETE)", () => {
  test("entfernt Gespräch und Datei, danach 404 für Gespräch und Verlauf; Session-Reset mit web:<id>", async () => {
    const ctx = await start();
    const c = await create(ctx, { agent: "research" });
    const keep = await create(ctx);
    await api(ctx, `/api/conversations/${c.id}/messages`, "POST", { text: "Hallo" });
    await ctx.chat.finish(c.id, "Hi");
    await waitUntil(async () => !(await (await api(ctx, `/api/conversations/${c.id}`)).json()).running);
    const file = join(ctx.dataDir, `${c.id}.jsonl`);
    expect(await exists(file)).toBe(true);

    const res = await api(ctx, `/api/conversations/${c.id}`, "DELETE");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(ctx.resets).toEqual([`web:${c.id}`]);
    expect(await exists(file)).toBe(false);

    expect((await api(ctx, `/api/conversations/${c.id}`)).status).toBe(404);
    expect((await api(ctx, `/api/conversations/${c.id}/messages`)).status).toBe(404);
    expect((await api(ctx, `/api/conversations/${c.id}/messages`, "POST", { text: "noch da?" })).status).toBe(404);
    expect((await api(ctx, `/api/conversations/${c.id}`, "DELETE")).status).toBe(404);
    expect(ctx.resets).toHaveLength(1);

    const list = (await (await api(ctx, "/api/conversations")).json()).conversations;
    expect(list.map((x: any) => x.id)).toEqual([keep.id]);
    // Nach Neuladen des Speichers bleibt es gelöscht
    const fresh = new ConversationStore({ dir: ctx.dataDir });
    await fresh.load();
    expect(await fresh.getConversation(c.id)).toBeNull();
    expect(JSON.parse(await readFile(join(ctx.dataDir, "conversations.json"), "utf8")).map((x: any) => x.id)).toEqual([keep.id]);
  });

  test("neues Gespräch ohne Verlaufsdatei lässt sich löschen", async () => {
    const ctx = await start();
    const c = await create(ctx);
    expect((await api(ctx, `/api/conversations/${c.id}`, "DELETE")).status).toBe(200);
    expect(ctx.resets).toEqual([`web:${c.id}`]);
  });

  test("während eines Turns 409, danach möglich", async () => {
    const ctx = await start();
    const c = await create(ctx);
    expect((await api(ctx, `/api/conversations/${c.id}/messages`, "POST", { text: "Frage" })).status).toBe(202);
    await ctx.chat.started(c.id);
    const res = await api(ctx, `/api/conversations/${c.id}`, "DELETE");
    expect(res.status).toBe(409);
    expect(ctx.resets).toEqual([]);
    expect(await exists(join(ctx.dataDir, `${c.id}.jsonl`))).toBe(true);

    await ctx.chat.finish(c.id, "Antwort");
    await waitUntil(async () => !(await (await api(ctx, `/api/conversations/${c.id}`)).json()).running);
    expect((await api(ctx, `/api/conversations/${c.id}`, "DELETE")).status).toBe(200);
  });

  test("wartende Rückfrage zählt als laufender Turn: 409", async () => {
    const ctx = await start();
    const c = await create(ctx);
    await api(ctx, `/api/conversations/${c.id}/messages`, "POST", { text: "Datei löschen?" });
    const opts = await ctx.chat.started(c.id);
    await opts.ask!("Darf ich?", "frage-1");
    const status = await (await api(ctx, `/api/conversations/${c.id}`)).json();
    expect(status).toMatchObject({ running: true, awaiting: true });
    expect((await api(ctx, `/api/conversations/${c.id}`, "DELETE")).status).toBe(409);
    await ctx.chat.finish(c.id, "ok");
  });

  test("Telegram-Gespräche: dm und General 405, andere Topics ohne Topic-Verwaltung 503 (seit Issue #29)", async () => {
    const ctx = await start();
    for (const id of ["topic-1", "dm"]) {
      for (const method of ["PATCH", "DELETE"]) {
        const res = await api(ctx, `/api/conversations/${id}`, method, method === "PATCH" ? { title: "neu" } : undefined);
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET");
      }
    }
    for (const method of ["PATCH", "DELETE"]) {
      expect((await api(ctx, "/api/conversations/topic-443", method, method === "PATCH" ? { title: "neu" } : undefined)).status).toBe(503);
    }
    expect(ctx.resets).toEqual([]);
  });

  test("Fehler beim Session-Reset: Gespräch trotzdem gelöscht, Log ohne Details", async () => {
    const ctx = await start({
      resetSession: async () => {
        throw new Error("/Users/geheim/pfad");
      },
    });
    const c = await create(ctx);
    expect((await api(ctx, `/api/conversations/${c.id}`, "DELETE")).status).toBe(200);
    expect((await api(ctx, `/api/conversations/${c.id}`)).status).toBe(404);
    expect(ctx.logs.join("\n")).toContain("nicht zurückgesetzt (Error)");
    expect(ctx.logs.join("\n")).not.toContain("geheim");
  });

  test("ohne resetSession (web:dev, Demo) wird nur gelöscht", async () => {
    const ctx = await start({ resetSession: undefined });
    const c = await create(ctx);
    expect((await api(ctx, `/api/conversations/${c.id}`, "DELETE")).status).toBe(200);
  });

  test("offene Live-Verbindung bekommt deleted und wird beendet", async () => {
    const ctx = await start();
    const c = await create(ctx);
    const res = await api(ctx, `/api/conversations/${c.id}/events`);
    const reader = res.body!.getReader();
    await waitUntil(() => ctx.server.eventStreamCount() === 1);
    expect((await api(ctx, `/api/conversations/${c.id}`, "DELETE")).status).toBe(200);
    let received = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += new TextDecoder().decode(value);
    }
    expect(received).toContain("event: deleted");
    expect(ctx.server.eventStreamCount()).toBe(0);
  });

  test("gleichzeitig Nachricht und Löschen: nie beides erfolgreich, kein verwaister Verlauf", async () => {
    for (let round = 0; round < 15; round++) {
      const ctx = await start();
      const c = await create(ctx);
      const [post, del] = await Promise.all([
        api(ctx, `/api/conversations/${c.id}/messages`, "POST", { text: `Runde ${round}` }),
        api(ctx, `/api/conversations/${c.id}`, "DELETE"),
      ]);
      const file = join(ctx.dataDir, `${c.id}.jsonl`);
      if (del.status === 200) {
        expect(post.status).toBe(404);
        expect(ctx.chat.calls).toHaveLength(0);
        expect(await exists(file)).toBe(false);
        expect((await api(ctx, `/api/conversations/${c.id}`)).status).toBe(404);
      } else {
        expect(del.status).toBe(409);
        expect(post.status).toBe(202);
        expect(ctx.resets).toEqual([]);
        await ctx.chat.finish(c.id, "Antwort");
      }
      for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
    }
  });
});

describe("ChatHub.exclusive", () => {
  /** Speicher-Attrappe, deren Speichern der Antwort der Test freigibt */
  class SlowLog implements MessageLog {
    release: (() => void) | null = null;
    async appendMessage(_id: string, m: NewMessage): Promise<StoredMessage> {
      if (m.role !== "user") await new Promise<void>(resolve => (this.release = resolve));
      return { id: crypto.randomUUID(), role: m.role, text: m.text, createdAt: new Date().toISOString() };
    }
  }

  test("Speichern der Abschlussmeldung zählt als laufender Turn", async () => {
    const log = new SlowLog();
    const chat = new FakeChat();
    const hub = new ChatHub({ store: log, chat });
    await hub.send({ id: "a", agent: "general" }, "hallo");
    await chat.finish("a", "Antwort");
    await waitUntil(() => log.release !== null);
    let ran = false;
    expect(await hub.exclusive("a", async () => (ran = true))).toEqual({ status: "busy" });
    expect(ran).toBe(false);
    log.release!();
    await hub.idle();
    expect(await hub.exclusive("a", async () => 7)).toEqual({ status: "done", value: 7 });
  });

  test("hält die Sperre bis zum Ende: send ist solange busy, Stopp hat nichts abzubrechen", async () => {
    const hub = new ChatHub({ store: new SlowLog(), chat: new FakeChat() });
    let finish!: () => void;
    const pending = hub.exclusive("a", () => new Promise<string>(resolve => (finish = () => resolve("weg"))));
    expect(await hub.send({ id: "a", agent: "general" }, "hi")).toEqual({ status: "busy" });
    expect(hub.stop("a")).toBe(false);
    expect(await hub.exclusive("a", async () => 1)).toEqual({ status: "busy" });
    finish();
    expect(await pending).toEqual({ status: "done", value: "weg" });
    expect(hub.isRunning("a")).toBe(false);
  });

  test("Fehler in fn gibt die Sperre frei und wird weitergereicht", async () => {
    const hub = new ChatHub({ store: new SlowLog(), chat: new FakeChat() });
    await expect(hub.exclusive("a", async () => { throw new Error("kaputt"); })).rejects.toThrow("kaputt");
    expect(hub.isRunning("a")).toBe(false);
  });

  test("nach shutdown: closing", async () => {
    const hub = new ChatHub({ store: new SlowLog(), chat: new FakeChat() });
    await hub.shutdown({ graceMs: 10 });
    expect(await hub.exclusive("a", async () => 1)).toEqual({ status: "closing" });
  });
});

describe("Verdrahtung in src/bot.ts (nur statisch gelesen, nie importiert)", () => {
  test("startWebUi bekommt Agentenliste und resetSession", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "bot.ts"), "utf8");
    const call = source.slice(source.indexOf("webServer = await startWebUi({"));
    const block = call.slice(0, call.indexOf("});"));
    // Issue #50: Agentenliste über den Katalog-Port, bei jeder Anfrage neu gelesen
    expect(block).toContain("agentCatalog: botAgentCatalog,");
    expect(block).toContain("resetSession: sessionKey => resetSession(sessionKey)");
  });
});
