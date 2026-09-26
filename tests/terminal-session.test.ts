/**
 * Issue #60, Schritt 2: Senden, Live-Ereignisse, Stopp und Zusammenführen
 * von Verlauf, POST-Antwort und SSE (src/terminal/session.ts, live.ts, sse.ts)
 * gegen einen echten Web-Server nur im Test. Telegram-Eingänge kommen aus
 * der Demo-Quelle, nie aus echtem Telegram.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ApiClient, tokenFromFile, type Message } from "../src/terminal/api";
import { ChatSession, SYNC_ATTEMPTS, type ChatOutput } from "../src/terminal/session";
import { SseParser } from "../src/terminal/sse";
import { startTyboServer, waitFor, type TerminalTestServer } from "./terminal-fixture";

let servers: TerminalTestServer[] = [];
let sessions: ChatSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  for (const s of servers.splice(0)) await s.stop();
});

function recorder() {
  const messages: Message[] = [];
  const notes: string[] = [];
  const statuses: (string | null)[] = [];
  const output: ChatOutput = {
    message: m => messages.push(m),
    note: t => notes.push(t),
    status: t => statuses.push(t),
  };
  return { messages, notes, statuses, output };
}

async function setup(id: string, client?: (s: TerminalTestServer) => ApiClient) {
  const server = await startTyboServer();
  servers.push(server);
  const list = await server.client().listConversations();
  const conversation = list.find(c => c.id === id)!;
  const rec = recorder();
  const session = new ChatSession({
    client: client ? client(server) : server.client(),
    conversation,
    output: rec.output,
    live: { retryMinMs: 100, retryMaxMs: 200 },
  });
  sessions.push(session);
  return { server, session, ...rec };
}

async function connected(server: TerminalTestServer, n = 1) {
  await waitFor(() => server.server.eventStreamCount() >= n, 3000, "SSE-Verbindung");
}

describe("Senden", () => {
  test("Nachricht landet per POST im gewählten Topic, Quelle terminal", async () => {
    const { server, session, messages } = await setup("topic-443");
    await session.loadHistory();
    const outcome = await session.send("Hallo aus dem Terminal");
    expect(outcome).toEqual({ ok: true });
    const turn = await server.telegramChat.turn("topic-443");
    expect(turn.opts.conversationId).toBe("topic-443");
    expect(turn.opts.text).toBe("Hallo aus dem Terminal");
    expect(turn.opts.source).toBe("terminal");
    expect(messages.at(-1)).toMatchObject({ role: "user", text: "Hallo aus dem Terminal" });
    expect(session.isRunning).toBe(true);
  });

  test("Direktchat ebenso mit Quelle terminal", async () => {
    const { server, session } = await setup("dm");
    await session.loadHistory();
    expect(await session.send("Hi")).toEqual({ ok: true });
    expect((await server.telegramChat.turn("dm")).opts.source).toBe("terminal");
  });

  test("läuft schon eine Antwort: Fehler vom Server, nichts doppelt gespeichert", async () => {
    const { server, session } = await setup("topic-443");
    await session.loadHistory();
    await session.send("erste");
    await server.telegramChat.turn("topic-443");
    const second = await session.send("zweite");
    expect(second).toEqual({ ok: false, error: "In diesem Gespräch läuft schon eine Antwort" });
    expect(server.telegramChat.calls).toHaveLength(1);
  });

  test("geschlossenes Topic: kein POST, verständliche Meldung", async () => {
    const { server, session } = await setup("topic-443");
    (session.conversation as { closed?: boolean }).closed = true;
    const r = await session.send("x");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("geschlossen");
    expect(server.telegramChat.calls).toHaveLength(0);
  });

  test("status(running:false) vom Verbindungsaufbau kommt erst während des Sendens an: die Antwort gilt trotzdem als laufend (PR #83, CI-Befund)", async () => {
    let firstRead = false;
    let releaseStatus: () => void = () => {};
    const statusReleased = new Promise<void>(r => (releaseStatus = r));
    let releasePost: () => void = () => {};
    const postReleased = new Promise<void>(r => (releasePost = r));
    const { server, session, statuses } = await setup("dm", s => {
      const inner = fetch;
      return new ApiClient({
        base: s.base,
        getToken: tokenFromFile(s.tokenFile),
        fetch: (async (url: string, init: RequestInit) => {
          const u = new URL(String(url));
          if (u.pathname.endsWith("/messages") && init.method === "POST") {
            const res = await inner(url, init);
            await postReleased;
            return res;
          }
          if (!u.pathname.endsWith("/events")) return inner(url, init);
          // Nur das erste Ereignis (status vom Aufbau) kommt an, und erst auf Freigabe; alles Weitere geht verloren
          const reader = (await inner(url, init)).body!.getReader();
          const first = await reader.read();
          firstRead = true;
          void reader.cancel();
          return new Response(
            new ReadableStream({
              async start(c) {
                init.signal?.addEventListener("abort", () => c.error(new Error("abgebrochen")));
                await statusReleased;
                if (!init.signal?.aborted) c.enqueue(first.value!);
              },
            }),
            { status: 200 }
          );
        }) as typeof fetch,
      });
    });
    await session.loadHistory();
    session.startLive();
    await waitFor(() => firstRead, 3000, "erstes Ereignis");
    const sending = session.send("Frage");
    await server.telegramChat.turn("dm");
    const n = statuses.length;
    releaseStatus();
    await waitFor(() => statuses.length > n, 3000, "status vom Aufbau");
    releasePost();
    expect(await sending).toEqual({ ok: true });
    expect(session.isRunning).toBe(true);
  });

  test("Server weg: Fehler statt Absturz", async () => {
    const { server, session } = await setup("topic-443");
    await session.loadHistory();
    await server.server.stop({ graceMs: 50 });
    const r = await session.send("x");
    expect(r).toEqual({ ok: false, error: "Keine Verbindung zum Bot, die Nachricht wurde nicht gesendet." });
  });
});

describe("Verlauf und Zusammenführen", () => {
  test("zeigt höchstens die letzten 20 Nachrichten", async () => {
    const { server, session, messages } = await setup("topic-12");
    for (let i = 1; i <= 30; i++) server.receiveFromTelegram("topic-12", "user", `Nachricht ${i}`);
    await session.loadHistory();
    expect(messages).toHaveLength(20);
    expect(messages[0].text).toBe("Nachricht 11");
    expect(messages.at(-1)!.text).toBe("Nachricht 30");
  });

  test("POST-Antwort, SSE und Abgleich nach dem Verbinden: jede Nachricht genau einmal", async () => {
    const { server, session, messages } = await setup("topic-443");
    await session.loadHistory();
    const before = messages.length;
    session.startLive();
    await connected(server);
    await session.send("einmal bitte");
    await server.telegramChat.turn("topic-443");
    server.telegramChat.finish("topic-443", "**Antwort**");
    await waitFor(() => !session.isRunning, 3000, "Antwort");
    await session.sync();
    const added = messages.slice(before);
    expect(added.map(m => [m.role, m.text])).toEqual([
      ["user", "einmal bitte"],
      ["assistant", "**Antwort**"],
    ]);
    expect(new Set(messages.map(m => m.id)).size).toBe(messages.length);
  });

  test("Telegram-Nachricht im selben Gespräch erscheint live, in anderen nicht", async () => {
    const { server, session, messages } = await setup("topic-443");
    await session.loadHistory();
    session.startLive();
    await connected(server);
    await waitFor(() => messages.length >= 4, 1000, "Abgleich");
    const before = messages.length;
    server.receiveFromTelegram("topic-12", "user", "anderes Topic");
    server.receiveFromTelegram("topic-443", "user", "aus Telegram");
    await waitFor(() => messages.length > before, 3000, "Live-Nachricht");
    await new Promise(r => setTimeout(r, 50));
    expect(messages.slice(before).map(m => m.text)).toEqual(["aus Telegram"]);
  });

  test("Wiederverbindung: Nachricht aus der Lücke kommt über den Abgleich, ohne Duplikat", async () => {
    let eventCalls = 0;
    const { server, session, messages, notes } = await setup("topic-443", s => {
      const inner = fetch;
      return new ApiClient({
        base: s.base,
        getToken: tokenFromFile(s.tokenFile),
        // Erste Live-Verbindung bricht nach dem ersten Block ab (wie ein Netzausfall)
        fetch: (async (url: string, init: RequestInit) => {
          const res = await inner(url, init);
          if (!String(url).endsWith("/events") || ++eventCalls > 1) return res;
          const reader = res.body!.getReader();
          const first = await reader.read();
          void reader.cancel();
          return new Response(new ReadableStream({ start(c) { c.enqueue(first.value!); c.close(); } }), { status: 200 });
        }) as typeof fetch,
      });
    });
    await session.loadHistory();
    const before = messages.length;
    session.startLive();
    await waitFor(() => notes.some(n => n.startsWith("Verbindung zum Bot unterbrochen")), 3000, "Abbruch");
    server.receiveFromTelegram("topic-443", "user", "in der Lücke");
    await waitFor(() => notes.includes("Wieder verbunden."), 3000, "Wiederverbindung");
    await waitFor(() => messages.length > before, 3000, "Abgleich");
    server.receiveFromTelegram("topic-443", "user", "nach der Lücke");
    await waitFor(() => messages.length > before + 1, 3000, "Live nach Wiederverbindung");
    await session.sync();
    expect(messages.slice(before).map(m => m.text)).toEqual(["in der Lücke", "nach der Lücke"]);
    expect(eventCalls).toBe(2);
  });
  test("mehr als 50 Nachrichten in der Lücke: ältere Seiten per before, lückenlos und ohne Duplikat", async () => {
    let eventCalls = 0;
    let reconnect: () => void = () => {};
    const gate = new Promise<void>(r => (reconnect = r));
    const cursors: (string | null)[] = [];
    const { server, session, messages } = await setup("topic-443", s => {
      const inner = fetch;
      return new ApiClient({
        base: s.base,
        getToken: tokenFromFile(s.tokenFile),
        fetch: (async (url: string, init: RequestInit) => {
          const u = new URL(String(url));
          if (u.pathname.endsWith("/messages") && (init.method ?? "GET") === "GET") cursors.push(u.searchParams.get("before"));
          if (!u.pathname.endsWith("/events")) return inner(url, init);
          // Erste Live-Verbindung bricht nach dem ersten Block ab, die zweite wartet auf das Tor
          if (++eventCalls > 1) {
            await gate;
            return inner(url, init);
          }
          const res = await inner(url, init);
          const reader = res.body!.getReader();
          const first = await reader.read();
          void reader.cancel();
          return new Response(new ReadableStream({ start(c) { c.enqueue(first.value!); c.close(); } }), { status: 200 });
        }) as typeof fetch,
      });
    });
    await session.loadHistory();
    const before = messages.length;
    session.startLive();
    await waitFor(() => eventCalls >= 2, 3000, "Abbruch und neuer Versuch");
    for (let i = 1; i <= 60; i++) {
      server.receiveFromTelegram("topic-443", "user", `verpasst ${i}`);
      // Eigener Zeitpunkt je Nachricht, wie die Mikrosekunden aus Postgres
      await new Promise(r => setTimeout(r, 2));
    }
    cursors.length = 0;
    reconnect();
    await waitFor(() => messages.length >= before + 60, 3000, "Abgleich über mehrere Seiten");
    await new Promise(r => setTimeout(r, 50));
    expect(messages.slice(before).map(m => m.text)).toEqual(Array.from({ length: 60 }, (_, i) => `verpasst ${i + 1}`));
    expect(new Set(messages.map(m => m.id)).size).toBe(messages.length);
    // Erst die jüngste Seite, dann genau eine ältere ab der ältesten Nachricht dieser Seite
    expect(cursors).toHaveLength(2);
    expect(cursors[0]).toBeNull();
    expect(cursors[1]).toBe(messages[before + 10].createdAt);
    expect(session.isSyncing).toBe(false);
  });

  test("mehr als 50 verpasst und ein Live-Eingang während des verzögerten GET: jede Nachricht genau einmal (PR #83)", async () => {
    let eventCalls = 0;
    let reconnect: () => void = () => {};
    const gate = new Promise<void>(r => (reconnect = r));
    let holdGet = false;
    let getHeld = false;
    let releaseGet: () => void = () => {};
    const released = new Promise<void>(r => (releaseGet = r));
    const { server, session, messages } = await setup("topic-443", s => {
      const inner = fetch;
      return new ApiClient({
        base: s.base,
        getToken: tokenFromFile(s.tokenFile),
        fetch: (async (url: string, init: RequestInit) => {
          const u = new URL(String(url));
          // Erster GET des Abgleichs wartet, bis der Test den Live-Eingang geschickt hat
          if (u.pathname.endsWith("/messages") && (init.method ?? "GET") === "GET" && holdGet && !u.searchParams.get("before")) {
            holdGet = false;
            getHeld = true;
            await released;
          }
          if (!u.pathname.endsWith("/events")) return inner(url, init);
          if (++eventCalls > 1) {
            await gate;
            return inner(url, init);
          }
          const res = await inner(url, init);
          const reader = res.body!.getReader();
          const first = await reader.read();
          void reader.cancel();
          return new Response(new ReadableStream({ start(c) { c.enqueue(first.value!); c.close(); } }), { status: 200 });
        }) as typeof fetch,
      });
    });
    await session.loadHistory();
    const before = messages.length;
    session.startLive();
    await waitFor(() => eventCalls >= 2, 3000, "Abbruch und neuer Versuch");
    for (let i = 1; i <= 60; i++) {
      server.receiveFromTelegram("topic-443", "user", `verpasst ${i}`);
      await new Promise(r => setTimeout(r, 2));
    }
    holdGet = true;
    reconnect();
    await waitFor(() => getHeld, 3000, "verzögerter GET");
    server.receiveFromTelegram("topic-443", "user", "live während des Abgleichs");
    await waitFor(() => messages.some(m => m.text === "live während des Abgleichs"), 3000, "Live-Eingang");
    releaseGet();
    await waitFor(() => !session.isSyncing, 3000, "Abgleich");
    const texts = messages.slice(before).map(m => m.text);
    const expected = [...Array.from({ length: 60 }, (_, i) => `verpasst ${i + 1}`), "live während des Abgleichs"];
    expect([...texts].sort()).toEqual([...expected].sort());
    expect(new Set(messages.map(m => m.id)).size).toBe(messages.length);
    expect(session.syncFailed).toBe(false);
  });

  /**
   * Erste Live-Verbindung bricht nach dem Anfangsstatus ab, die zweite kommt
   * erst, wenn der Test reconnect() aufruft. Mit keepPosted steht jede per
   * POST angenommene Nachricht danach mit derselben ID in der jüngsten
   * Verlaufsseite, wie beim echten Bot (saveMessage mit msgId der POST-Antwort).
   */
  function cutFirstConnection(s: TerminalTestServer, counter: { events: number }, gate: Promise<void>, keepPosted = false) {
    const inner = fetch;
    const posted: Message[] = [];
    return new ApiClient({
      base: s.base,
      getToken: tokenFromFile(s.tokenFile),
      fetch: (async (url: string, init: RequestInit) => {
        const u = new URL(String(url));
        if (keepPosted && u.pathname.endsWith("/messages")) {
          const res = await inner(url, init);
          const body = await res.json();
          if (init.method === "POST" && body.message) posted.push(body.message);
          else if ((init.method ?? "GET") === "GET" && !u.searchParams.get("before")) body.messages.push(...posted);
          return Response.json(body, { status: res.status });
        }
        if (!u.pathname.endsWith("/events")) return inner(url, init);
        if (++counter.events > 1) {
          await gate;
          return inner(url, init);
        }
        const res = await inner(url, init);
        const reader = res.body!.getReader();
        const first = await reader.read();
        void reader.cancel();
        return new Response(new ReadableStream({ start(c) { c.enqueue(first.value!); c.close(); } }), { status: 200 });
      }) as typeof fetch,
    });
  }

  test("zunächst leeres Gespräch, mehr als 50 verpasst: alle Seiten, jede Nachricht genau einmal (PR #83, Runde 3)", async () => {
    const counter = { events: 0 };
    let reconnect: () => void = () => {};
    const gate = new Promise<void>(r => (reconnect = r));
    const { server, session, messages } = await setup("topic-1", s => cutFirstConnection(s, counter, gate));
    await session.loadHistory();
    expect(messages).toHaveLength(0);
    session.startLive();
    await waitFor(() => counter.events >= 2, 3000, "Abbruch und neuer Versuch");
    for (let i = 1; i <= 60; i++) {
      server.receiveFromTelegram("topic-1", "user", `verpasst ${i}`);
      await new Promise(r => setTimeout(r, 2));
    }
    reconnect();
    await waitFor(() => messages.length >= 60, 3000, "Abgleich über mehrere Seiten");
    await waitFor(() => !session.isSyncing, 3000, "Abgleich");
    expect(messages.map(m => m.text)).toEqual(Array.from({ length: 60 }, (_, i) => `verpasst ${i + 1}`));
    expect(new Set(messages.map(m => m.id)).size).toBe(messages.length);
  });

  test("bestehendes Gespräch, mehr als 50 verpasst, erfolgreicher POST vor der Wiederverbindung: jede Nachricht genau einmal (PR #83, Runde 3)", async () => {
    const counter = { events: 0 };
    let reconnect: () => void = () => {};
    const gate = new Promise<void>(r => (reconnect = r));
    const { server, session, messages } = await setup("topic-443", s => cutFirstConnection(s, counter, gate, true));
    await session.loadHistory();
    const before = messages.length;
    session.startLive();
    await waitFor(() => counter.events >= 2, 3000, "Abbruch und neuer Versuch");
    for (let i = 1; i <= 60; i++) {
      server.receiveFromTelegram("topic-443", "user", `verpasst ${i}`);
      await new Promise(r => setTimeout(r, 2));
    }
    expect(await session.send("gesendet in der Lücke")).toEqual({ ok: true });
    await server.telegramChat.turn("topic-443");
    reconnect();
    await waitFor(() => messages.length >= before + 61, 3000, "Abgleich über mehrere Seiten");
    await waitFor(() => !session.isSyncing, 3000, "Abgleich");
    const texts = messages.slice(before).map(m => m.text);
    const expected = [...Array.from({ length: 60 }, (_, i) => `verpasst ${i + 1}`), "gesendet in der Lücke"];
    expect([...texts].sort()).toEqual([...expected].sort());
    expect(new Set(messages.map(m => m.id)).size).toBe(messages.length);
  });

  test("Abbruch während des Abgleichs, mehr als 50 verpasst, POST vor dem Ende des alten GET: jede Nachricht genau einmal (PR #83, Runde 4)", async () => {
    let eventCalls = 0;
    let cut: () => void = () => {};
    let reconnect: () => void = () => {};
    const gate = new Promise<void>(r => (reconnect = r));
    let holdGet = false;
    let getHeld = false;
    let releaseGet: () => void = () => {};
    const released = new Promise<void>(r => (releaseGet = r));
    const posted: Message[] = [];
    const { server, session, messages } = await setup("topic-443", s => {
      const inner = fetch;
      return new ApiClient({
        base: s.base,
        getToken: tokenFromFile(s.tokenFile),
        fetch: (async (url: string, init: RequestInit) => {
          const u = new URL(String(url));
          if (u.pathname.endsWith("/messages")) {
            const method = init.method ?? "GET";
            const hold = method === "GET" && holdGet && !u.searchParams.get("before");
            if (hold) holdGet = false;
            // Stand zum Zeitpunkt der Anfrage festhalten, die Antwort erst später ausliefern
            const res = await inner(url, init);
            const body = await res.json();
            // Wie beim echten Bot steht die angenommene Nachricht danach im Verlauf
            if (method === "POST" && body.message) posted.push(body.message);
            else if (method === "GET" && !u.searchParams.get("before")) body.messages.push(...posted);
            if (hold) {
              getHeld = true;
              await released;
            }
            return Response.json(body, { status: res.status });
          }
          if (!u.pathname.endsWith("/events")) return inner(url, init);
          if (++eventCalls > 1) {
            await gate;
            return inner(url, init);
          }
          // Erste Live-Verbindung reicht durch, bis der Test sie kappt
          const reader = (await inner(url, init)).body!.getReader();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                let open = true;
                cut = () => {
                  if (!open) return;
                  open = false;
                  void reader.cancel();
                  c.close();
                };
                void (async () => {
                  for (;;) {
                    const r = await reader.read().catch(() => ({ done: true as const, value: undefined }));
                    if (r.done || !open) break;
                    c.enqueue(r.value);
                  }
                })();
              },
            }),
            { status: 200 }
          );
        }) as typeof fetch,
      });
    });
    await session.loadHistory();
    const before = messages.length;
    holdGet = true;
    session.startLive();
    await waitFor(() => getHeld, 3000, "zurückgehaltener Abgleichs-GET");
    cut();
    await waitFor(() => eventCalls >= 2, 3000, "Abbruch und neuer Versuch");
    for (let i = 1; i <= 60; i++) {
      server.receiveFromTelegram("topic-443", "user", `verpasst ${i}`);
      await new Promise(r => setTimeout(r, 2));
    }
    expect(await session.send("gesendet in der Lücke")).toEqual({ ok: true });
    await server.telegramChat.turn("topic-443");
    releaseGet();
    await waitFor(() => !session.isSyncing, 3000, "alter Abgleich");
    reconnect();
    await waitFor(() => messages.length >= before + 61, 3000, "Abgleich über mehrere Seiten");
    await waitFor(() => !session.isSyncing, 3000, "Abgleich");
    const texts = messages.slice(before).map(m => m.text);
    const expected = [...Array.from({ length: 60 }, (_, i) => `verpasst ${i + 1}`), "gesendet in der Lücke"];
    expect([...texts].sort()).toEqual([...expected].sort());
    expect(new Set(messages.map(m => m.id)).size).toBe(messages.length);
    expect(session.syncFailed).toBe(false);
  });

  test("Verlaufs-GET scheitert: der Abgleich wird wiederholt, bis er gelingt (PR #83)", async () => {
    let failGets = 0;
    let gets = 0;
    const { server, session, messages, notes } = await setup("topic-443", s => {
      const inner = fetch;
      return new ApiClient({
        base: s.base,
        getToken: tokenFromFile(s.tokenFile),
        fetch: (async (url: string, init: RequestInit) => {
          const u = new URL(String(url));
          if (u.pathname.endsWith("/messages") && (init.method ?? "GET") === "GET" && failGets > 0) {
            failGets--;
            gets++;
            return new Response("kaputt", { status: 500 });
          }
          return inner(url, init);
        }) as typeof fetch,
      });
    });
    await session.loadHistory();
    const before = messages.length;
    server.receiveFromTelegram("topic-443", "user", "vor der Verbindung");
    failGets = 2;
    session.startLive();
    await connected(server);
    await waitFor(() => !session.isSyncing, 3000, "Abgleich");
    expect(gets).toBe(2);
    expect(messages.slice(before).map(m => m.text)).toEqual(["vor der Verbindung"]);
    expect(session.syncFailed).toBe(false);
    expect(notes.filter(n => n.includes("ließen sich nicht laden"))).toEqual([]);
  });

  test("Verlaufs-GET scheitert jedes Mal: nach allen Versuchen Fehlermeldung und syncFailed (PR #83)", async () => {
    let gets = 0;
    let fail = false;
    const { server, session, notes } = await setup("topic-443", s => {
      const inner = fetch;
      return new ApiClient({
        base: s.base,
        getToken: tokenFromFile(s.tokenFile),
        fetch: (async (url: string, init: RequestInit) => {
          const u = new URL(String(url));
          if (fail && u.pathname.endsWith("/messages") && (init.method ?? "GET") === "GET") {
            gets++;
            return new Response("kaputt", { status: 500 });
          }
          return inner(url, init);
        }) as typeof fetch,
      });
    });
    await session.loadHistory();
    fail = true;
    session.startLive();
    await connected(server);
    await waitFor(() => !session.isSyncing, 5000, "Aufgeben");
    expect(gets).toBe(SYNC_ATTEMPTS);
    expect(session.syncFailed).toBe(true);
    expect(notes).toContain("Nachrichten aus der Unterbrechung ließen sich nicht laden, es kann etwas fehlen.");
  });
});

describe("Rückfragen (Issue #116, PR #147)", () => {
  /**
   * Server-Attrappe hinter fetch: Verlauf, Senden (merkt sich die Anfragen)
   * und ein SSE-Strom, in den der Test Ereignisse schiebt. So lässt sich
   * genau nachstellen, dass in Telegram-Gesprächen der Status awaiting vor
   * der Nachricht mit der Frage ankommt (createTelegramChat, record:false).
   */
  function fakeServer() {
    const posts: { text: string; approvalId?: string }[] = [];
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let streams = 0;
    const history: Message[] = [];
    let n = 0;
    const message = (text: string, choiceId?: string): Message =>
      ({ id: `m${++n}`, role: "assistant", text, createdAt: new Date(Date.now() + n).toISOString(), ...(choiceId ? { choiceId } : {}) }) as Message;
    const client = new ApiClient({
      base: "http://attrappe.test",
      getToken: async () => "schluessel",
      fetch: (async (url: string, init: RequestInit = {}) => {
        const u = new URL(String(url));
        if (u.pathname.endsWith("/events")) {
          streams++;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                controller = c;
                c.enqueue(encoder.encode(`event: status\ndata: ${JSON.stringify({ running: true })}\n\n`));
                init.signal?.addEventListener("abort", () => c.error(new Error("abgebrochen")));
              },
            }),
            { status: 200 }
          );
        }
        if (u.pathname.endsWith("/messages") && init.method === "POST") {
          const body = JSON.parse(String(init.body)) as { text: string; approvalId?: string };
          posts.push(body);
          if (!body.approvalId) return Response.json({ error: "In diesem Gespräch läuft schon eine Antwort" }, { status: 409 });
          return Response.json({ message: { id: `u${++n}`, role: "user", text: body.text, createdAt: new Date().toISOString() } }, { status: 202 });
        }
        return Response.json({ messages: history, hasMore: false, running: true });
      }) as typeof fetch,
    });
    return {
      client,
      posts,
      streams: () => streams,
      emit(event: string, data: unknown) {
        controller!.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      },
      message,
      history,
    };
  }

  test("Status für Frage B vor ihrer Nachricht: ein spätes „ja“ gibt B nicht frei, erst nach der Anzeige", async () => {
    const fake = fakeServer();
    const rec = recorder();
    const session = new ChatSession({
      client: fake.client,
      conversation: { id: "dm", title: "Direktchat", agent: "general", kind: "telegram", lastActivity: null },
      output: rec.output,
      live: { retryMinMs: 100, retryMaxMs: 200 },
    });
    sessions.push(session);
    await session.loadHistory();
    session.startLive();
    await waitFor(() => fake.streams() > 0, 3000, "SSE-Verbindung");

    // Frage A: Status, dann die Nachricht; sichtbar, also offen
    fake.emit("status", { running: true, awaiting: true, approvalId: "FrageA" });
    fake.emit("message", fake.message("Freigabe nötig: A", "FrageA"));
    await waitFor(() => session.isAwaiting, 3000, "Frage A sichtbar");
    expect(rec.statuses.at(-1)).toBe("Wartet auf deine Antwort auf die Rückfrage");

    // A ist anderswo entschieden, B wartet schon im Status, ihre Nachricht ist noch unterwegs
    fake.emit("status", { running: true });
    fake.emit("status", { running: true, awaiting: true, approvalId: "FrageB" });
    await waitFor(() => (session as unknown as { approvalId?: string }).approvalId === "FrageB", 3000, "Status B");
    expect(session.isAwaiting).toBe(false);
    expect(rec.statuses.at(-1)).not.toBe("Wartet auf deine Antwort auf die Rückfrage");

    // Das „ja“ galt der sichtbaren Frage A: keine Freigabe für B
    const late = await session.send("ja");
    expect(late.ok).toBe(false);
    expect(fake.posts).toEqual([{ text: "ja" }]);

    // Jetzt kommt B an: erst ab hier geht die Antwort mit ihrer ID
    fake.emit("message", fake.message("Freigabe nötig: B", "FrageB"));
    await waitFor(() => session.isAwaiting, 3000, "Frage B sichtbar");
    expect(rec.messages.at(-1)).toMatchObject({ text: "Freigabe nötig: B" });
    expect(rec.statuses.at(-1)).toBe("Wartet auf deine Antwort auf die Rückfrage");
    expect(await session.send("ja")).toEqual({ ok: true });
    expect(fake.posts.at(-1)).toEqual({ text: "ja", approvalId: "FrageB" });
  });

  test("Frage aus dem Register (choice statt choiceId) zählt ebenso als angezeigt", async () => {
    const fake = fakeServer();
    const rec = recorder();
    const session = new ChatSession({
      client: fake.client,
      conversation: { id: "topic-443", title: "Topic", agent: "general", kind: "telegram", lastActivity: null },
      output: rec.output,
    });
    sessions.push(session);
    fake.history.push({ ...fake.message("Freigabe nötig: C"), choice: { id: "FrageC", options: [], state: "open" } } as Message);
    await session.loadHistory();
    session.startLive();
    await waitFor(() => fake.streams() > 0, 3000, "SSE-Verbindung");
    fake.emit("status", { running: true, awaiting: true, approvalId: "FrageC" });
    await waitFor(() => session.isAwaiting, 3000, "Frage C offen");
    expect(await session.send("nein")).toEqual({ ok: true });
    expect(fake.posts).toEqual([{ text: "nein", approvalId: "FrageC" }]);
  });
});

describe("Fortschritt und Stopp", () => {
  test("Fortschrittsereignisse erscheinen in der Statuszeile", async () => {
    const { server, session, statuses } = await setup("topic-443");
    await session.loadHistory();
    session.startLive();
    await connected(server);
    await session.send("recherchiere");
    const turn = await server.telegramChat.turn("topic-443");
    await turn.opts.sink.progress({ kind: "tool", text: "WebSearch" });
    await waitFor(() => statuses.some(s => s?.startsWith("Durchsucht das Web …")), 3000, "Statuszeile");
    await turn.opts.sink.progress({ kind: "snippet", text: "Ich schaue nach" });
    await waitFor(() => statuses.some(s => s?.startsWith("Formuliert die Antwort …")), 3000, "Statuszeile Snippet");
    server.telegramChat.finish("topic-443", "fertig");
    await waitFor(() => statuses.at(-1) === null, 3000, "Statuszeile leer");
  });

  test("Stopp bricht die laufende Antwort ab; danach nichts mehr abzubrechen", async () => {
    const { server, session, messages, notes } = await setup("topic-443");
    await session.loadHistory();
    session.startLive();
    await connected(server);
    await session.send("lange Aufgabe");
    await server.telegramChat.turn("topic-443");
    expect(await session.stop()).toBe(true);
    expect(server.telegramChat.stops).toEqual(["topic-443"]);
    await waitFor(() => messages.some(m => m.text === "Abgebrochen."), 3000, "Abbruchmeldung");
    await waitFor(() => !session.isRunning, 3000, "Ende");
    expect(await session.stop()).toBe(false);
    expect(notes).toContain("Nichts mehr abzubrechen, die Antwort wird schon gespeichert.");
  });

  test("Steuerzeichen im Fortschritt landen nicht in der Statuszeile", async () => {
    const { server, session, statuses } = await setup("topic-443");
    await session.loadHistory();
    session.startLive();
    await connected(server);
    await session.send("x");
    const turn = await server.telegramChat.turn("topic-443");
    await turn.opts.sink.progress({ kind: "tool", text: "\u001b]52;c;Ym9lc2U=\u0007\u001b[2JBash" });
    await waitFor(() => statuses.some(s => s?.startsWith("Führt einen Befehl aus")), 3000, "Statuszeile");
    expect(statuses.join("")).not.toContain("\u001b");
  });
});

describe("SSE-Parser", () => {
  test("geteilte Blöcke, auch mitten in einem UTF-8-Zeichen, \\r\\n und Keepalive", () => {
    const bytes = new TextEncoder().encode(': keepalive\r\n\r\nevent: progress\r\ndata: {"kind":"tool","text":"Größe ✓"}\r\n\r\nevent: status\ndata: {"running":false}\n\n');
    const parser = new SseParser();
    const events = [];
    for (let i = 0; i < bytes.length; i++) events.push(...parser.push(bytes.subarray(i, i + 1)));
    expect(events).toEqual([
      { event: "progress", data: '{"kind":"tool","text":"Größe ✓"}' },
      { event: "status", data: '{"running":false}' },
    ]);
  });

  test("mehrzeilige data-Felder, Ereignis ohne Namen heißt message", () => {
    const parser = new SseParser();
    expect(parser.push("data: a\ndata: b\n\n")).toEqual([{ event: "message", data: "a\nb" }]);
  });
});

describe("Rückfragen als nummerierte Auswahl (Issue #120)", () => {
  /** Server mit Rückfragen-Register; merkt sich alle Anfragen des Terminals */
  async function setupChoices(id = "topic-443", options: { intercept?: (u: URL, forward: () => Promise<Response>) => Promise<Response> | null } = {}) {
    const server = await startTyboServer({ choices: true });
    servers.push(server);
    const requests: { method: string; path: string; body?: unknown }[] = [];
    let reconnect: () => void = () => {};
    const gate = new Promise<void>(r => (reconnect = r));
    let dropStream: () => void = () => {};
    let dropped = false;
    const inner = fetch;
    const client = new ApiClient({
      base: server.base,
      getToken: tokenFromFile(server.tokenFile),
      fetch: (async (url: string, init: RequestInit = {}) => {
        const u = new URL(String(url));
        requests.push({ method: init.method ?? "GET", path: `${u.pathname}${u.search}`, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
        if (u.pathname.endsWith("/events")) {
          // Nach drop() kommt die nächste Verbindung erst mit reconnect()
          if (dropped) await gate;
          const res = await inner(url, init);
          const reader = res.body!.getReader();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                dropStream = () => {
                  dropped = true;
                  void reader.cancel();
                  c.close();
                };
              },
              async pull(c) {
                const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
                if (done) {
                  try {
                    c.close();
                  } catch {
                    // schon geschlossen
                  }
                } else c.enqueue(value!);
              },
            }),
            { status: 200 }
          );
        }
        return options.intercept?.(u, () => inner(url, init)) ?? inner(url, init);
      }) as typeof fetch,
    });
    const conversation = (await server.client().listConversations()).find(c => c.id === id)!;
    const rec = recorder();
    const choices: { id: string; state: string; via?: string; reminder?: boolean }[] = [];
    const session = new ChatSession({
      client,
      conversation,
      output: { ...rec.output, choice: (c, reminder) => choices.push({ id: c.id, state: c.state, ...(c.result ? { via: c.result.via } : {}), ...(reminder ? { reminder } : {}) }) },
      live: { retryMinMs: 100, retryMaxMs: 200 },
    });
    sessions.push(session);
    await session.loadHistory();
    session.startLive();
    await connected(server);
    await waitFor(() => !session.isSyncing, 3000, "erster Abgleich");
    const choicePosts = () => requests.filter(r => r.method === "POST" && r.path.includes("/choices/"));
    return { server, session, requests, choicePosts, choices, reconnect, drop: () => dropStream(), ...rec };
  }

  test("offene Rückfrage wird wählbar; 1 sendet genau einen POST mit der ersten Option, Erledigt-Zeile genau einmal", async () => {
    const { server, session, messages, choices, choicePosts } = await setupChoices();
    const id = server.ask("topic-443", "Research möchte `Write` ausführen");
    await waitFor(() => session.choiceTarget?.id === id, 3000, "Frage sichtbar");
    expect(messages.at(-1)!.choice).toMatchObject({ id, state: "open", options: [{ key: "ok", label: "Erlauben" }, { key: "no", label: "Ablehnen" }] });

    expect(await session.choose(1)).toEqual({ handled: true, ok: true, settled: true });
    expect(choicePosts()).toEqual([{ method: "POST", path: `/api/conversations/topic-443/choices/${id}`, body: { option: "ok" } }]);
    expect(server.choices!.decisions).toEqual([{ id, key: "ok", via: "terminal" }]);
    // SSE choice kommt zusätzlich an: keine zweite Zeile
    await new Promise(r => setTimeout(r, 150));
    expect(choices).toEqual([{ id, state: "done", via: "terminal" }]);
    expect(session.choiceTarget).toBeNull();
    expect(await session.choose(1)).toEqual({ handled: false });
    expect(choicePosts()).toHaveLength(1);
  });

  test("in Telegram entschieden: Erledigt-Zeile per SSE, danach wählt 1 nichts mehr", async () => {
    const { server, session, choices, choicePosts } = await setupChoices();
    const id = server.ask("topic-443", "Freigabe?");
    await waitFor(() => session.choiceTarget?.id === id, 3000, "Frage sichtbar");
    await server.choices!.decideIn("telegram", id, "no");
    await waitFor(() => choices.length === 1, 3000, "SSE choice");
    expect(choices).toEqual([{ id, state: "done", via: "telegram" }]);
    expect(session.choiceTarget).toBeNull();
    expect(await session.choose(1)).toEqual({ handled: false });
    expect(choicePosts()).toHaveLength(0);
  });

  test("ungültige Nummer: Hinweis, kein POST, Frage bleibt offen", async () => {
    const { server, session, choicePosts } = await setupChoices();
    const id = server.ask("topic-443", "Freigabe?");
    await waitFor(() => session.choiceTarget?.id === id, 3000, "Frage sichtbar");
    for (const n of [0, 3, 99]) {
      const outcome = await session.choose(n);
      expect(outcome).toEqual({ handled: true, ok: false, settled: false, error: `Keine Option ${n} bei dieser Rückfrage, möglich sind 1 bis 2.` });
    }
    expect(choicePosts()).toHaveLength(0);
    expect(session.choiceTarget?.id).toBe(id);
  });

  test("mehrere offene Fragen: die zuletzt gezeigte gilt; ist sie erledigt, wieder die frühere (mit Hinweis)", async () => {
    const { server, session, choices, choicePosts } = await setupChoices();
    const a = server.ask("topic-443", "Frage A");
    const b = server.ask("topic-443", "Frage B", [
      { key: "x", label: "Übernehmen" },
      { key: "y", label: "Verwerfen" },
      { key: "z", label: "Später" },
    ]);
    await waitFor(() => session.choiceTarget?.id === b, 3000, "Frage B sichtbar");
    expect(await session.choose(3)).toMatchObject({ ok: true });
    expect(choicePosts().at(-1)).toMatchObject({ path: `/api/conversations/topic-443/choices/${b}`, body: { option: "z" } });
    expect(session.choiceTarget?.id).toBe(a);
    expect(choices).toEqual([
      { id: b, state: "done", via: "terminal" },
      { id: a, state: "open", reminder: true },
    ]);
    expect(await session.choose(2)).toMatchObject({ ok: true });
    expect(choicePosts().at(-1)).toMatchObject({ path: `/api/conversations/topic-443/choices/${a}`, body: { option: "no" } });
    expect(session.choiceTarget).toBeNull();
  });

  test("409 schon entschieden bzw. abgelaufen: Stand des Servers übernehmen, nichts weiter senden", async () => {
    const { server, session, choices, choicePosts, requests } = await setupChoices();
    const a = server.ask("topic-443", "Frage A");
    await waitFor(() => session.choiceTarget?.id === a, 3000, "A sichtbar");
    // Anderer Prozess (Sprach-Brücke) hat entschieden, ohne dass dieser Server es meldet
    server.choices!.decideSilently(a, "no", "web");
    const outcome = await session.choose(1);
    expect(outcome).toEqual({ handled: true, ok: false, settled: true, error: "Diese Rückfrage ist schon entschieden." });
    expect(choices).toEqual([{ id: a, state: "done", via: "web" }]);
    expect(session.choiceTarget).toBeNull();

    const b = server.ask("topic-443", "Frage B");
    await waitFor(() => session.choiceTarget?.id === b, 3000, "B sichtbar");
    server.choices!.expireSilently(b);
    expect(await session.choose(2)).toEqual({ handled: true, ok: false, settled: true, error: "Diese Rückfrage ist abgelaufen." });
    expect(choices.at(-1)).toEqual({ id: b, state: "expired" });
    expect(choicePosts()).toHaveLength(2);
    // Die Eingabe ging nie als Nachricht raus
    expect(requests.filter(r => r.method === "POST" && r.path.endsWith("/messages"))).toHaveLength(0);
  });

  test("Frage aus einem anderen Gespräch ist hier nicht wählbar, auch ihr SSE nicht", async () => {
    const { server, session, choices } = await setupChoices();
    const other = server.ask("topic-31", "Frage in Strategie");
    await new Promise(r => setTimeout(r, 100));
    expect(session.choiceTarget).toBeNull();
    await server.choices!.decideIn("telegram", other, "ok");
    await new Promise(r => setTimeout(r, 100));
    expect(choices).toEqual([]);
  });

  test("Wiederverbindung: in der Lücke entschiedene Frage wird per Stand-Abfrage erledigt, auch wenn ihre Nachricht nicht mehr auf der ersten Seite steht", async () => {
    const { server, session, messages, choices, notes, reconnect, drop, requests } = await setupChoices();
    const id = server.ask("topic-443", "Frage vor vielen Nachrichten");
    await waitFor(() => session.choiceTarget?.id === id, 3000, "Frage sichtbar");
    // Mehr als eine Seite (50) danach: der Abgleich holt die Frage nicht erneut
    const before = messages.length;
    for (let i = 0; i < 55; i++) server.receiveFromTelegram("topic-443", "user", `danach ${i}`);
    await waitFor(() => messages.length === before + 55, 3000, "Nachrichten danach");
    expect(session.choiceTarget?.id).toBe(id);
    drop();
    await waitFor(() => notes.some(n => n.startsWith("Verbindung zum Bot unterbrochen")), 3000, "Abbruch");
    // In der Lücke in Telegram entschieden: kein SSE erreicht das Terminal
    await server.choices!.decideIn("telegram", id, "ok");
    reconnect();
    await waitFor(() => notes.includes("Wieder verbunden."), 3000, "Wiederverbindung");
    await waitFor(() => choices.length === 1, 3000, "Stand nach Wiederverbindung");
    expect(choices).toEqual([{ id, state: "done", via: "telegram" }]);
    expect(requests.some(r => r.path === `/api/conversations/topic-443/choices?ids=${id}`)).toBe(true);
    expect(session.choiceTarget).toBeNull();
  });

  test("verspätete Daten öffnen eine erledigte Frage nicht wieder", async () => {
    // Stand-Abfrage und Verlauf beginnen, solange die Frage offen ist; ihre Antworten kommen erst nach der Entscheidung
    let hold = false;
    let releaseHeld!: () => void;
    const held = new Promise<void>(r => (releaseHeld = r));
    const served = { choices: 0, history: 0 };
    const stale: { choices: unknown; history: unknown } = { choices: null, history: null };
    const intercept = (u: URL, forward: () => Promise<Response>) => {
      if (!hold || u.pathname.endsWith("/events")) return null;
      const kind = u.pathname.endsWith("/choices") ? "choices" : u.pathname.endsWith("/messages") ? "history" : null;
      if (!kind) return null;
      return (async () => {
        // Antwort vom Stand bei Anfrage, ausgeliefert erst nach der Freigabe
        const data = await (await forward()).json();
        stale[kind] = data;
        await held;
        served[kind]++;
        return Response.json(data);
      })();
    };
    const { server, session, choices, messages, choicePosts } = await setupChoices("topic-443", { intercept });
    const id = server.ask("topic-443", "Frage");
    await waitFor(() => session.choiceTarget?.id === id, 3000, "sichtbar");
    const shown = messages.length;

    hold = true;
    const refresh = (session as unknown as { refreshChoices(): Promise<void> }).refreshChoices();
    const sync = session.sync();
    await waitFor(() => stale.choices !== null && stale.history !== null, 3000, "beide Antworten mit altem Stand");
    // Beide Antworten melden die Frage wirklich noch offen
    expect(stale.choices).toMatchObject({ choices: [{ id, state: "open" }] });
    expect((stale.history as { messages: { choice?: { id: string; state: string } }[] }).messages.find(m => m.choice?.id === id)!.choice).toMatchObject({ state: "open" });

    // Entscheidung in Telegram, per SSE verarbeitet, bevor die alten Antworten ankommen
    await server.choices!.decideIn("telegram", id, "ok");
    await waitFor(() => choices.length === 1, 3000, "erledigt per SSE");
    expect(served).toEqual({ choices: 0, history: 0 });
    expect(session.choiceTarget).toBeNull();

    releaseHeld();
    await refresh;
    await sync;
    expect(served).toEqual({ choices: 1, history: 1 });
    expect(session.choiceTarget).toBeNull();
    expect(choices).toEqual([{ id, state: "done", via: "telegram" }]);
    expect(messages).toHaveLength(shown);
    expect(await session.choose(1)).toEqual({ handled: false });
    expect(choicePosts()).toHaveLength(0);
  });

  test("Auswahl während eines laufenden Turns; „ja“ mit approvalId bleibt wie in #116", async () => {
    const { server, session, choicePosts, requests } = await setupChoices();
    const answers: { text: string; approvalId: string }[] = [];
    server.telegramChat.answer = (_id: string, text: string, approvalId: string) => {
      answers.push({ text, approvalId });
      return true;
    };
    await session.send("mach mal");
    const turn = await server.telegramChat.turn("topic-443");
    const first = server.ask("topic-443", "Research möchte `Bash` ausführen");
    await turn.opts.ask!("Research möchte `Bash` ausführen", first, { record: false });
    await waitFor(() => session.isAwaiting && session.choiceTarget?.id === first, 3000, "Freigabe sichtbar");
    expect(session.isRunning).toBe(true);
    // Text-Antwort wie bisher: POST /messages mit approvalId, keine Auswahl
    expect(await session.send("ja")).toEqual({ ok: true });
    expect(requests.filter(r => r.path.endsWith("/messages") && r.method === "POST").at(-1)!.body).toEqual({ text: "ja", approvalId: first });
    expect(answers).toEqual([{ text: "ja", approvalId: first }]);
    expect(choicePosts()).toHaveLength(0);
    turn.opts.endAsk!(first);

    // Zweite Frage im selben Turn: per Zahl, während die Antwort weiterläuft
    const second = server.ask("topic-443", "Research möchte `Write` ausführen");
    await waitFor(() => session.choiceTarget?.id === second, 3000, "zweite sichtbar");
    expect(await session.choose(1)).toMatchObject({ ok: true });
    expect(session.isRunning).toBe(true);
    expect(server.choices!.get(second)!.result).toMatchObject({ key: "ok", via: "terminal" });
    server.telegramChat.finish("topic-443", "fertig");
  });
});

describe("Rückfrage ohne lesbaren Stand (Issue #120)", () => {
  test("choiceId ohne choice: nicht wählbar, bis die Stand-Abfrage sie offen meldet; dann Optionen nachgereicht", async () => {
    let snapshot: unknown = null;
    const client = new ApiClient({
      base: "http://attrappe.test",
      getToken: async () => "schluessel",
      fetch: (async (url: string) => {
        const u = new URL(String(url));
        if (u.pathname.endsWith("/choices")) return snapshot ? Response.json(snapshot) : Response.json({ error: "nicht lesbar" }, { status: 503 });
        return Response.json({
          messages: [{ id: "m1", role: "assistant", text: "Freigabe?", createdAt: new Date().toISOString(), choiceId: "FrageX" }],
          hasMore: false,
          running: false,
        });
      }) as typeof fetch,
    });
    const rec = recorder();
    const shown: { id: string; options: number }[] = [];
    const session = new ChatSession({
      client,
      conversation: { id: "topic-443", title: "Topic", agent: "general", kind: "topic", lastActivity: null },
      output: { ...rec.output, choice: c => shown.push({ id: c.id, options: c.options.length }) },
    });
    sessions.push(session);
    await session.loadHistory();
    expect(session.choiceTarget).toBeNull();
    expect(await session.choose(1)).toEqual({ handled: false });
    const refresh = () => (session as unknown as { refreshChoices(): Promise<void> }).refreshChoices();
    // Register weiter nicht lesbar: nichts ändert sich
    await refresh();
    expect(shown).toEqual([]);
    snapshot = { choices: [{ id: "FrageX", state: "open", options: [{ key: "ok", label: "Erlauben" }, { key: "no", label: "Ablehnen" }] }] };
    await refresh();
    expect(shown).toEqual([{ id: "FrageX", options: 2 }]);
    expect(session.choiceTarget?.id).toBe("FrageX");
  });
});
