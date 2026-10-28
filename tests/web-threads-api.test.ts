/**
 * Issue #293, Checkbox 1: GET /api/threads und POST /api/threads/<id>/close
 * über den Server, mit der echten Quelle (createBotThreads) auf einer
 * Ablage und einem Rückfragen-Register in eigenen Dateien. Der Zuhörer
 * installThreadChoiceExpiry ist eingerichtet wie in src/bot.ts.
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChoice, getChoice, setChoicesFileForTests, type ChoiceConversation } from "../src/lib/choices";
import { setSettingsPath } from "../src/lib/settings";
import { installThreadChoiceExpiry, THREAD_OPTIONS } from "../src/lib/thread-choices";
import { noteTurnForThreads, threadsWorkPending, type ThreadDetectDeps } from "../src/lib/threads/detect";
import type { ThreadResolveDeps } from "../src/lib/threads/resolve";
import { createThread, getThread, setThreadsFileForTests, updateThreads } from "../src/lib/threads/store";
import { createBotThreads, threadWebConversation } from "../src/web/bot-threads";
import type { WebServer } from "../src/web/server";
import { THREADS_API_TEXT } from "../src/web/threads";
import { topicServer } from "./topic-fixture";

const USER = "4711";
const GROUP = "-1001234567890";
const TOPIC: ChoiceConversation = { type: "telegram", chatId: GROUP, topicId: 31 };
const DM: ChoiceConversation = { type: "telegram", chatId: USER };

const root = await mkdtemp(join(tmpdir(), "web-threads-api-"));
afterAll(async () => {
  setChoicesFileForTests(null);
  setThreadsFileForTests(null);
  setSettingsPath();
  await rm(root, { recursive: true, force: true });
});
const servers: WebServer[] = [];
let counter = 0;
let offExpiry: () => void = () => {};
let logSpy: ReturnType<typeof spyOn>;
let env: Record<string, string | undefined> = {};
beforeEach(() => {
  counter++;
  setChoicesFileForTests(join(root, `choices-${counter}.json`));
  setThreadsFileForTests(join(root, `threads-${counter}.json`));
  setSettingsPath(join(root, `settings-${counter}.json`));
  env = { USER_TIMEZONE: "Europe/Berlin" };
  offExpiry = installThreadChoiceExpiry({ log: () => {} });
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  offExpiry();
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
  logSpy.mockRestore();
});

const port = () => createBotThreads({ env: () => env, userId: () => USER, groupId: () => GROUP });
const server = () => topicServer(root, servers, null, { threads: port() });

async function thread(conversation: ChoiceConversation, question: string) {
  const out = await createThread({ conversation, topic: `Thema zu ${question}`, context: "Kurzer Kontext.", question });
  if (out.status !== "created") throw new Error("nicht angelegt");
  return out.thread;
}

describe("GET /api/threads", () => {
  test("ohne Anmeldung 401", async () => {
    const ctx = await server();
    const res = await fetch(`${ctx.origin}/api/threads`, { headers: { origin: ctx.origin } });
    expect(res.status).toBe(401);
  });

  test("ohne Quelle 503", async () => {
    const ctx = await topicServer(root, servers, null);
    const res = await ctx.api("/api/threads");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(THREADS_API_TEXT.notConfigured);
  });

  test("Liste mit ID, Nummer, Zustand, Texten und Gespräch, neueste zuerst", async () => {
    const ctx = await server();
    const web = await ctx.store.createConversation("general");
    await ctx.store.renameConversation(web.id, "Reiseplanung");
    const a = await thread(TOPIC, "Soll ich die Issues anlegen?");
    const b = await thread({ type: "web", conversationId: web.id }, "Nehmen wir den frühen Zug?");
    await updateThreads((threads, now) => {
      threads[a.id].createdAt = now - 3 * 86_400_000 - 60_000;
      threads[a.id].deadline = "2030-01-15";
      return { result: null, changed: true };
    });
    const res = await ctx.api("/api/threads");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.count).toBe(2);
    expect(body.closed).toEqual([]);
    expect(body.open.map((t: any) => t.id)).toEqual([b.id, a.id]);
    const first = body.open[1];
    expect(first).toMatchObject({
      id: a.id,
      nr: a.nr,
      state: "open",
      topic: a.topic,
      context: "Kurzer Kontext.",
      question: "Soll ich die Issues anlegen?",
      conversation: { type: "topic", id: "topic-31", name: "Topic 31" },
      age: "seit 3 Tagen",
      deadline: "2030-01-15",
      deadlineText: "15.01.2030",
      reminders: 0,
      closedAt: null,
      closedReason: null,
    });
    expect(first.reminder).toMatch(/^Erinnerung am \d\d\.\d\d\.\d{4}$/);
    expect(typeof first.nextReminderAt).toBe("string");
    expect(body.open[0].conversation).toEqual({ type: "web", id: web.id, name: "Reiseplanung" });
  });

  test("?alle=1 dazu die geschlossenen der letzten 7 Tage, ältere nicht", async () => {
    const ctx = await server();
    const open = await thread(TOPIC, "Offen?");
    const recent = await thread(TOPIC, "Kürzlich zu?");
    const old = await thread(DM, "Lange zu?");
    await updateThreads((threads, now) => {
      threads[recent.id].state = "closed";
      threads[recent.id].closedAt = now - 6 * 86_400_000;
      threads[recent.id].closedReason = "erledigt";
      threads[old.id].state = "closed";
      threads[old.id].closedAt = now - 8 * 86_400_000;
      return { result: null, changed: true };
    });
    const plain = await (await ctx.api("/api/threads")).json();
    expect(plain.open.map((t: any) => t.id)).toEqual([open.id]);
    expect(plain.closed).toEqual([]);
    const all = await (await ctx.api("/api/threads?alle=1")).json();
    expect(all.count).toBe(1);
    expect(all.closed.map((t: any) => t.id)).toEqual([recent.id]);
    expect(all.closed[0]).toMatchObject({ state: "closed", closedReason: "erledigt", reminder: null, nextReminderAt: null });
  });

  test("ausgeschaltet (THREADS=off): enabled false, keine Fäden", async () => {
    const ctx = await server();
    await thread(TOPIC, "Offen?");
    env.THREADS = "off";
    const body = await (await ctx.api("/api/threads")).json();
    expect(body).toEqual({ enabled: false, count: 0, open: [], closed: [] });
  });
});

describe("GET /api/threads: pending, solange Nacharbeit läuft oder wartet", () => {
  const WEB_TURN_REPLY = "Ich habe zwei Varianten vorbereitet. Nehmen wir den frühen Zug?";
  const openJSON = JSON.stringify({ open: true, topic: "Zugwahl", context: "Früher oder später Zug.", question: "Nehmen wir den frühen Zug?", deadline: null });

  async function drained() {
    for (let i = 0; i < 200 && threadsWorkPending(); i++) await new Promise(r => setTimeout(r, 5));
    expect(threadsWorkPending()).toBe(false);
  }

  test("späte Neuanlage, dann späte Auflösung durch eine wartende Nacharbeit: pending bis alles geschrieben ist", async () => {
    const ctx = await server();
    const web = await ctx.store.createConversation("general");
    const conversation: ChoiceConversation = { type: "web", conversationId: web.id };
    // Erkennung des ersten Turns hängt am Nebenmodell; der zweite Turn wartet in der Warteschlange
    let releaseDetect!: () => void;
    const detectGate = new Promise<void>(r => (releaseDetect = r));
    let releaseResolve!: () => void;
    const resolveGate = new Promise<void>(r => (releaseResolve = r));
    const deps: Partial<ThreadDetectDeps & ThreadResolveDeps> = {
      callAux: async (_purpose, prompt) => {
        if (prompt.includes("echten, offenen Frage")) {
          await detectGate;
          return { text: openJSON, isError: false };
        }
        await resolveGate;
        const t = (await (await ctx.api("/api/threads")).json()).open[0];
        return { text: JSON.stringify({ answered: [t.nr] }), isError: false };
      },
      listChoices: async () => [],
      pendingAskUser: async () => [],
      now: () => new Date(),
      timeZone: () => "Europe/Berlin",
      env: {},
      log: () => {},
    };
    const started = Date.now();
    noteTurnForThreads({ conversation, userText: "Welcher Zug?", reply: WEB_TURN_REPLY, turnStartedAt: started }, deps);
    noteTurnForThreads({ conversation, userText: "Ja, der frühe.", reply: "Gut, dann der frühe Zug.", turnStartedAt: started }, deps);

    let body = await (await ctx.api("/api/threads")).json();
    expect(body).toMatchObject({ enabled: true, count: 0, pending: true });

    // Neuanlage geschrieben, der zweite Turn wartet noch auf das Auflösen
    releaseDetect();
    for (let i = 0; i < 200 && body.count === 0; i++) {
      await new Promise(r => setTimeout(r, 5));
      body = await (await ctx.api("/api/threads")).json();
    }
    expect(body).toMatchObject({ count: 1, pending: true });

    releaseResolve();
    await drained();
    body = await (await ctx.api("/api/threads")).json();
    expect(body).toMatchObject({ enabled: true, count: 0, pending: false, open: [] });
  });

  test("ohne Nacharbeit: pending false", async () => {
    const ctx = await server();
    await thread(TOPIC, "Offen?");
    const body = await (await ctx.api("/api/threads")).json();
    expect(body).toMatchObject({ count: 1, pending: false });
  });
});

describe("POST /api/threads/<id>/close", () => {
  test("ohne Anmeldung 401, Faden bleibt offen", async () => {
    const ctx = await server();
    const t = await thread(TOPIC, "Offen?");
    const res = await fetch(`${ctx.origin}/api/threads/${t.id}/close`, { method: "POST", headers: { origin: ctx.origin }, body: JSON.stringify({ reason: "erledigt" }) });
    expect(res.status).toBe(401);
    expect((await getThread(t.id))?.state).toBe("open");
  });

  test("falsche Origin 403, Faden bleibt offen", async () => {
    const ctx = await server();
    const t = await thread(TOPIC, "Offen?");
    const res = await ctx.api(`/api/threads/${t.id}/close`, "POST", { reason: "erledigt" }, { origin: "http://evil.example" });
    expect(res.status).toBe(403);
    expect((await getThread(t.id))?.state).toBe("open");
  });

  test("ungültiger Grund 400, Faden bleibt offen", async () => {
    const ctx = await server();
    const t = await thread(TOPIC, "Offen?");
    for (const body of [{ reason: "später" }, {}, { reason: 1 }, "kein json"]) {
      const res = await ctx.api(`/api/threads/${t.id}/close`, "POST", body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(THREADS_API_TEXT.invalidReason);
    }
    expect((await getThread(t.id))?.state).toBe("open");
  });

  test("GET ist dort nicht erlaubt", async () => {
    const ctx = await server();
    const t = await thread(TOPIC, "Offen?");
    expect((await ctx.api(`/api/threads/${t.id}/close`)).status).toBe(405);
  });

  test("schließt mit Grund und lässt die offene Rückfrage ablaufen, andere bleiben", async () => {
    const ctx = await server();
    const t = await thread(TOPIC, "Soll ich?");
    const other = await thread(DM, "Und das?");
    const choice = await createChoice({ kind: "thread", conversation: t.conversation, text: "Frage", options: THREAD_OPTIONS, ref: t.id });
    const otherChoice = await createChoice({ kind: "thread", conversation: other.conversation, text: "Frage", options: THREAD_OPTIONS, ref: other.id });
    const res = await ctx.api(`/api/threads/${t.id}/close`, "POST", { reason: "erledigt" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ closed: true, id: t.id });
    const stored = await getThread(t.id);
    expect(stored).toMatchObject({ state: "closed", closedReason: "erledigt" });
    expect((await getChoice(choice.id))?.state).toBe("expired");
    expect((await getChoice(otherChoice.id))?.state).toBe("open");
    expect((await getThread(other.id))?.state).toBe("open");
    const list = await (await ctx.api("/api/threads")).json();
    expect(list.open.map((x: any) => x.id)).toEqual([other.id]);
  });

  test("„nicht mehr wichtig“ als Grund", async () => {
    const ctx = await server();
    const t = await thread(TOPIC, "Soll ich?");
    expect((await ctx.api(`/api/threads/${t.id}/close`, "POST", { reason: "nicht mehr wichtig" })).status).toBe(200);
    expect(await getThread(t.id)).toMatchObject({ state: "closed", closedReason: "nicht mehr wichtig" });
  });

  test("gleichzeitig zweimal: genau ein Abschluss, der andere 404; danach 404", async () => {
    const ctx = await server();
    const t = await thread(TOPIC, "Soll ich?");
    let closedEvents = 0;
    const { onThreadsClosed } = await import("../src/lib/threads/store");
    const off = onThreadsClosed(list => {
      closedEvents += list.filter(x => x.id === t.id).length;
    });
    try {
      const [r1, r2] = await Promise.all([
        ctx.api(`/api/threads/${t.id}/close`, "POST", { reason: "erledigt" }),
        ctx.api(`/api/threads/${t.id}/close`, "POST", { reason: "nicht mehr wichtig" }),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([200, 404]);
      expect(closedEvents).toBe(1);
      const again = await ctx.api(`/api/threads/${t.id}/close`, "POST", { reason: "erledigt" });
      expect(again.status).toBe(404);
      expect((await again.json()).error).toBe(THREADS_API_TEXT.unknown);
      expect(closedEvents).toBe(1);
    } finally {
      off();
    }
  });

  test("unbekannte und ungültige Kennung 404", async () => {
    const ctx = await server();
    expect((await ctx.api("/api/threads/Unbekannt12/close", "POST", { reason: "erledigt" })).status).toBe(404);
    expect((await ctx.api("/api/threads/..%2F..%2Fx/close", "POST", { reason: "erledigt" })).status).toBe(404);
  });

  test("ausgeschaltet: 409, Faden bleibt offen", async () => {
    const ctx = await server();
    const t = await thread(TOPIC, "Soll ich?");
    env.THREADS = "off";
    expect((await ctx.api(`/api/threads/${t.id}/close`, "POST", { reason: "erledigt" })).status).toBe(409);
    expect((await getThread(t.id))?.state).toBe("open");
  });
});

describe("Gespräch der WebUI zu einem Faden", () => {
  test("Direktchat, Web-Direktchat, General, Topic, Web-Gespräch und fremde Chats", () => {
    expect(threadWebConversation(DM, USER, GROUP)).toEqual({ type: "dm", id: "dm" });
    expect(threadWebConversation({ type: "telegram", chatId: "web" }, null, null)).toEqual({ type: "dm", id: "dm" });
    expect(threadWebConversation({ type: "telegram", chatId: GROUP }, USER, GROUP)).toEqual({ type: "general", id: "topic-1" });
    expect(threadWebConversation({ type: "telegram", chatId: GROUP, topicId: 1 }, USER, GROUP)).toEqual({ type: "general", id: "topic-1" });
    expect(threadWebConversation(TOPIC, USER, GROUP)).toEqual({ type: "topic", id: "topic-31" });
    expect(threadWebConversation({ type: "web", conversationId: "abc" }, USER, GROUP)).toEqual({ type: "web", id: "abc" });
    // Ohne Telegram oder aus einer anderen Gruppe: kein Sprung
    expect(threadWebConversation(TOPIC, USER, null)).toEqual({ type: "topic", id: null });
    expect(threadWebConversation({ type: "telegram", chatId: "-1009" , topicId: 5 }, USER, GROUP)).toEqual({ type: "topic", id: null });
  });
});
