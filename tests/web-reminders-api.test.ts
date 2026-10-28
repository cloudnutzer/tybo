/**
 * Issue #323, Checkbox 2: GET /api/reminders und POST
 * /api/reminders/<id>/cancel über den Server, mit der echten Quelle
 * (createBotReminders) auf beiden Adaptern der Ablage. Belegt: Anmeldung
 * und Origin wie bei den übrigen Routen, dieselbe Auswahl wie
 * /erinnerungen, Absage genau dieses Eintrags (nie eines anderen mit
 * gleichem Anfang), kein falscher Erfolg (409, 404), eine Absage im Browser
 * wirkt in /erinnerungen und umgekehrt. Dazu die Demo-Attrappe für web:dev.
 */

import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandRegistry } from "../src/lib/commands/builtin";
import { runTelegramCommand } from "../src/lib/commands/telegram";
import type { CommandServices } from "../src/lib/commands/types";
import { fileScheduleStore } from "../src/lib/schedule/file";
import { reminderRef, REMINDERS_TEXT } from "../src/lib/schedule/overview";
import type { ScheduledTask, ScheduleStore } from "../src/lib/schedule/store";
import { supabaseScheduleStore } from "../src/lib/schedule/supabase";
import { getSupabase } from "../src/lib/supabase";
import { createBotReminders } from "../src/web/bot-reminders";
import { createDemoReminders } from "../src/web/demo";
import { REMINDERS_API_TEXT } from "../src/web/reminders";
import type { WebServer } from "../src/web/server";
import { asRow, bulkTasks, writeFileSeed } from "./reminders-seed";
import { FAKE_SUPABASE_URL } from "./supabase-fixture";
import { useTaskTables } from "./tasks-fixture";
import { topicServer } from "./topic-fixture";

const NOW = Date.parse("2026-10-18T10:00:00.000Z");
const HOUR = 3_600_000;
const USER = "4711";
const GROUP = "-1001234567890";

const root = await mkdtemp(join(tmpdir(), "web-reminders-api-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const servers: WebServer[] = [];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  setSystemTime(new Date(NOW));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  setSystemTime();
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
  logSpy.mockRestore();
  errSpy.mockRestore();
});

async function telegram(text: string, store: ScheduleStore): Promise<string[]> {
  const sent: string[] = [];
  await runTelegramCommand({
    chat: { reply: async t => void sent.push(t) },
    chatId: USER,
    sessionKey: `dm:${USER}`,
    agent: "general",
    text,
    match: commandRegistry.match(text, "telegram")!,
    services: { reminders: () => store, topicNames: async () => ({}) } as unknown as CommandServices,
    working: () => () => {},
    resetSession: async () => ({ status: "unavailable" }),
    agentTurn: async () => {},
    boardMeeting: async () => {},
  });
  return sent;
}

interface AdapterOptions {
  /** Einträge, die vor dem ersten Zugriff schon da sind */
  seed?: ScheduledTask[];
  /** Die Ablage ist nicht lesbar (Datei: data ist eine Datei; Supabase: jede Anfrage 500) */
  broken?: boolean;
}

const ADAPTERS = [
  {
    name: "Datei",
    setup(o: AdapterOptions = {}) {
      const dir = mkdtempSync(join(tmpdir(), "tybo-reminders-api-"));
      const path = join(dir, "data", "reminders.json");
      if (o.broken) writeFileSync(join(dir, "data"), "keine Ablage");
      if (o.seed) writeFileSeed(path, o.seed);
      return { store: fileScheduleStore(() => path), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    },
  },
  {
    name: "Supabase",
    setup(o: AdapterOptions = {}) {
      // Die Tabellen-Attrappe ersetzt fetch; der Web-Server des Tests braucht das echte
      const real = globalThis.fetch;
      const tables = useTaskTables({ rows: { scheduled_tasks: (o.seed ?? []).map(asRow) }, ...(o.broken ? { fail: ["scheduled_tasks"] } : {}) });
      const fake = globalThis.fetch;
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
        (input instanceof Request ? input.url : String(input)).startsWith(FAKE_SUPABASE_URL) ? fake(input, init) : real(input, init)) as typeof fetch;
      return {
        store: supabaseScheduleStore(getSupabase),
        cleanup: () => {
          globalThis.fetch = fake;
          tables.restore();
        },
      };
    },
  },
];

describe("Routen ohne Quelle und ohne Anmeldung", () => {
  test("ohne Anmeldung 401, ohne Origin beim Absagen kein Erfolg", async () => {
    const ctx = await topicServer(root, servers, null, { reminders: createDemoReminders({ now: () => NOW }) });
    expect((await fetch(`${ctx.origin}/api/reminders`, { headers: { origin: ctx.origin } })).status).toBe(401);
    const noLogin = await fetch(`${ctx.origin}/api/reminders/d3e00001-0000-4000-8000-000000000000/cancel`, { method: "POST", headers: { origin: ctx.origin }, body: "{}" });
    expect(noLogin.status).toBe(401);
    const foreign = await fetch(`${ctx.origin}/api/reminders/d3e00001-0000-4000-8000-000000000000/cancel`, {
      method: "POST",
      headers: { cookie: ctx.cookie, origin: "http://evil.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(foreign.status).toBe(403);
    expect((await (await ctx.api("/api/reminders")).json()).count).toBe(4);
  });

  test("ohne Quelle 503, falsche Methoden 405", async () => {
    const ctx = await topicServer(root, servers, null);
    const res = await ctx.api("/api/reminders");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(REMINDERS_API_TEXT.notConfigured);
    const withPort = await topicServer(root, servers, null, { reminders: createDemoReminders({ now: () => NOW }) });
    expect((await withPort.api("/api/reminders", "POST", {})).status).toBe(405);
    expect((await withPort.api("/api/reminders/d3e00001-0000-4000-8000-000000000000/cancel")).status).toBe(405);
  });
});

for (const adapter of ADAPTERS) {
  describe(`/api/reminders (${adapter.name})`, () => {
    let store: ScheduleStore;
    let cleanup: () => void;
    beforeEach(() => {
      ({ store, cleanup } = adapter.setup());
    });
    afterEach(() => cleanup());

    const server = () =>
      topicServer(root, servers, null, {
        reminders: createBotReminders({ store: () => store, now: () => NOW, timeZone: () => "Europe/Berlin", topicNames: async () => ({ "7": "Reisen" }) }),
      });

    test("Liste wie /erinnerungen: offene nach Fälligkeit mit Kennung, Ort, Wiederholung, Zustand", async () => {
      const a = await store.add({ chatId: USER, text: "Zahnarzt anrufen", dueAt: new Date(NOW + 2 * HOUR) });
      const b = await store.add({ chatId: GROUP, topicId: 7, text: "Tabletten", dueAt: new Date(NOW + 22 * HOUR), recurrence: "daily 08:05" });
      const c = await store.add({ chatId: "web", text: "Paket", dueAt: new Date(NOW - HOUR) });
      const d = await store.add({ chatId: USER, text: "Läuft", dueAt: new Date(NOW - 2 * HOUR) });
      await store.update(d!.id, { status: "running" });
      const e = await store.add({ chatId: USER, text: "Erledigt", dueAt: new Date(NOW - 3 * HOUR) });
      await store.update(e!.id, { status: "done" });
      const ctx = await server();
      const res = await ctx.api("/api/reminders");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.count).toBe(4);
      expect(body.reminders.map((r: any) => r.id)).toEqual([d!.id, c!.id, a!.id, b!.id]);
      expect(body.reminders[3]).toEqual({
        id: b!.id,
        ref: reminderRef(b!.id),
        text: "Tabletten",
        dueAt: new Date(NOW + 22 * HOUR).toISOString(),
        dueText: "19.10. 10:00",
        recurrence: "täglich 08:05",
        status: "pending",
        overdue: false,
        place: "Topic Reisen",
      });
      expect(body.reminders[0]).toMatchObject({ status: "running", overdue: false, place: "Direktchat" });
      expect(body.reminders[1]).toMatchObject({ status: "pending", overdue: true, place: "Direktchat", recurrence: null });
    });

    test("Leerzustand", async () => {
      const ctx = await server();
      expect(await (await ctx.api("/api/reminders")).json()).toEqual({ count: 0, reminders: [] });
    });

    test("Absagen im Browser wirkt in Telegram, Absagen in Telegram im Browser", async () => {
      const a = await store.add({ chatId: USER, text: "Zahnarzt anrufen", dueAt: new Date(NOW + 2 * HOUR) });
      const b = await store.add({ chatId: USER, text: "Müll", dueAt: new Date(NOW + 3 * HOUR), recurrence: "weekly mon 07:00" });
      const ctx = await server();
      const res = await ctx.api(`/api/reminders/${a!.id}/cancel`, "POST", {});
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cancelled: true, id: a!.id, text: REMINDERS_TEXT.cancelled("Zahnarzt anrufen") });
      expect((await telegram("/erinnerungen", store))[0]).not.toContain("Zahnarzt");
      expect(await telegram(`/erinnerungen absagen ${reminderRef(b!.id)}`, store)).toEqual([REMINDERS_TEXT.cancelledSeries("Müll", "jeden Montag 07:00")]);
      expect(await (await ctx.api("/api/reminders")).json()).toEqual({ count: 0, reminders: [] });
      // Zweites Absagen: kein Erfolg
      const again = await ctx.api(`/api/reminders/${a!.id}/cancel`, "POST", {});
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ error: REMINDERS_TEXT.alreadyCancelled("Zahnarzt anrufen"), status: "already-cancelled" });
      expect(ctx.logs).toContain(`Erinnerung ${a!.id} in der WebUI absagen: cancelled`);
    });

    test("kein falscher Erfolg: wird zugestellt 409, unbekannt und nur der Anfang 404", async () => {
      const a = await store.add({ chatId: USER, text: "Läuft", dueAt: new Date(NOW - HOUR) });
      await store.update(a!.id, { status: "running" });
      const ctx = await server();
      const sending = await ctx.api(`/api/reminders/${a!.id}/cancel`, "POST", {});
      expect(sending.status).toBe(409);
      expect((await sending.json()).status).toBe("sending");
      expect((await store.byId(a!.id))?.status).toBe("running");
      // Nur der Anfang der ID sagt in der WebUI nichts ab
      const prefix = await ctx.api(`/api/reminders/${a!.id.slice(0, 8)}/cancel`, "POST", {});
      expect(prefix.status).toBe(404);
      expect((await ctx.api("/api/reminders/ffffffff-0000-4000-8000-000000000000/cancel", "POST", {})).status).toBe(404);
      expect((await ctx.api("/api/reminders/..%2F..%2Fetc/cancel", "POST", {})).status).toBe(404);
    });

    test("gleichzeitige Absagen aus zwei Fenstern: genau eine ist ein Erfolg", async () => {
      const a = await store.add({ chatId: USER, text: "Doppelt", dueAt: new Date(NOW + HOUR) });
      const ctx = await server();
      const [x, y] = await Promise.all([ctx.api(`/api/reminders/${a!.id}/cancel`, "POST", {}), ctx.api(`/api/reminders/${a!.id}/cancel`, "POST", {})]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
    });

    test("Ablage nicht lesbar: 500 statt leerer Liste, Absage kein Erfolg", async () => {
      cleanup();
      ({ store, cleanup } = adapter.setup({ broken: true }));
      const ctx = await server();
      const res = await ctx.api("/api/reminders");
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: REMINDERS_API_TEXT.failed });
      const cancel = await ctx.api("/api/reminders/d3e00001-0000-4000-8000-000000000000/cancel", "POST", {});
      expect(cancel.status).toBe(500);
      expect(await cancel.json()).toEqual({ error: REMINDERS_API_TEXT.cancelFailed });
      expect(ctx.logs).toContain("Erinnerung d3e00001-0000-4000-8000-000000000000 in der WebUI absagen: unreadable");
      expect(await telegram("/erinnerungen", store)).toEqual([REMINDERS_TEXT.unreadable]);
    });

    test("mehr als 1000 erledigte und mehr als 1000 offene: vollständige Liste, Absage der neuesten mit voller ID", async () => {
      cleanup();
      const history = bulkTasks(1100, { start: NOW - 30 * 24 * HOUR, status: "done", chatId: USER, text: "Alt" });
      const open = bulkTasks(1050, { start: NOW + HOUR, status: "pending", chatId: USER, text: "Offen" });
      ({ store, cleanup } = adapter.setup({ seed: [...history, ...open] }));
      const ctx = await server();
      const body = await (await ctx.api("/api/reminders")).json();
      expect(body.count).toBe(1050);
      expect(body.reminders.map((r: any) => r.id)).toEqual(open.map(t => t.id));
      const last = open[open.length - 1];
      const res = await ctx.api(`/api/reminders/${last.id}/cancel`, "POST", {});
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cancelled: true, id: last.id, text: REMINDERS_TEXT.cancelled(last.text) });
      const old = await ctx.api(`/api/reminders/${history[0].id}/cancel`, "POST", {});
      expect(old.status).toBe(409);
      expect((await old.json()).status).toBe("done");
      expect((await (await ctx.api("/api/reminders")).json()).count).toBe(1049);
    });
  });
}

describe("Demo-Attrappe für web:dev", () => {
  test("Beispiele, Absagen einmal, laufende nicht absagbar", async () => {
    const demo = createDemoReminders({ now: () => NOW, initial: [{ text: "Eins", inHours: 1, place: "Direktchat" }, { text: "Läuft", inHours: -1, place: "Direktchat", status: "running" }] });
    const list = await demo.list();
    expect(list.map(r => r.text)).toEqual(["Läuft", "Eins"]);
    expect((await demo.cancel(list[1].id)).status).toBe("cancelled");
    expect((await demo.cancel(list[1].id)).status).toBe("already-cancelled");
    expect((await demo.cancel(list[0].id)).status).toBe("sending");
    expect((await demo.cancel("nicht-da-0000")).status).toBe("unknown");
    expect(demo.cancelled()).toBe(1);
    expect((await demo.list()).map(r => r.text)).toEqual(["Läuft"]);
  });
});
