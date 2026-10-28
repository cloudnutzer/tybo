/**
 * Issue #293, Checkbox 2: Einstellungen der offenen Fäden.
 * - Vorrang Einstellung (config/settings.json) vor .env vor Standard, je Feld
 * - Ruhezeit einstellbar, mit Mitternachtswechsel und USER_TIMEZONE
 * - Laufzeit: threadsEnabled, Termine und der Zeitgeber lesen die
 *   gespeicherte Einstellung frisch, aus → an wirkt ohne Neustart
 * - PATCH /api/settings mit threads und aux.threads über die echte Datei
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setChoicesFileForTests, type ChoiceConversation } from "../src/lib/choices";
import { settingsSchema, setSettingsPath } from "../src/lib/settings";
import { describeThreadsSettings, parseQuietHours } from "../src/lib/threads/config";
import { createThreadReminders, startThreadReminders } from "../src/lib/threads/remind";
import { applyQuietHours, isQuietTime, laterReminderTime, nextReminderTime, quietTargetHour } from "../src/lib/threads/schedule";
import { createThread, getThread, setThreadsFileForTests, threadsEnabled, updateThreads } from "../src/lib/threads/store";
import { botSettings } from "../src/web/bot-settings";
import { createBotThreads } from "../src/web/bot-threads";
import type { WebServer } from "../src/web/server";
import { topicServer } from "./topic-fixture";

const root = await mkdtemp(join(tmpdir(), "threads-settings-"));
let counter = 0;
let file: string;
let logSpy: ReturnType<typeof spyOn>;
const servers: WebServer[] = [];
beforeEach(() => {
  counter++;
  file = join(root, `settings-${counter}.json`);
  setSettingsPath(file);
  setThreadsFileForTests(join(root, `threads-${counter}.json`));
  setChoicesFileForTests(join(root, `choices-${counter}.json`));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
  logSpy.mockRestore();
  setSettingsPath();
});
afterAll(async () => {
  setThreadsFileForTests(null);
  setChoicesFileForTests(null);
  await rm(root, { recursive: true, force: true });
});

/** Einstellungsdatei schreiben; mtime je Schreibvorgang verschieden, damit getSettings neu liest */
let bump = 0;
async function settings(value: unknown) {
  await writeFile(file, JSON.stringify(value) + " ".repeat(++bump % 7));
}

const at = (iso: string) => Date.parse(iso);
const iso = (ts: number) => new Date(ts).toISOString();

describe("Vorrang: Einstellung vor .env vor Standard", () => {
  test("ohne Datei und .env: an, 3 Tage, 21-8 (Standard)", () => {
    expect(describeThreadsSettings({})).toEqual({
      enabled: { value: true, source: "code" },
      remindDays: { value: 3, source: "code" },
      quietHours: { value: { from: 21, to: 8 }, source: "code" },
    });
  });

  test(".env gilt ohne Einstellung", () => {
    expect(describeThreadsSettings({ THREADS: "OFF", THREADS_REMIND_DAYS: "2.5", THREADS_QUIET_HOURS: "22:00-07:00" })).toEqual({
      enabled: { value: false, source: "env" },
      remindDays: { value: 2.5, source: "env" },
      quietHours: { value: { from: 22, to: 7 }, source: "env" },
    });
  });

  test("Einstellung schlägt .env, je Feld", async () => {
    const env = { THREADS: "off", THREADS_REMIND_DAYS: "2", THREADS_QUIET_HOURS: "22-7" };
    await settings({ threads: { enabled: true, remindDays: 5 } });
    expect(describeThreadsSettings(env)).toEqual({
      enabled: { value: true, source: "settings" },
      remindDays: { value: 5, source: "settings" },
      quietHours: { value: { from: 22, to: 7 }, source: "env" },
    });
    await settings({ threads: { enabled: false, quietHours: { from: 1, to: 6 } } });
    expect(describeThreadsSettings({})).toEqual({
      enabled: { value: false, source: "settings" },
      remindDays: { value: 3, source: "code" },
      quietHours: { value: { from: 1, to: 6 }, source: "settings" },
    });
  });

  test("ungültige .env-Werte: Standard", () => {
    const d = describeThreadsSettings({ THREADS_REMIND_DAYS: "0", THREADS_QUIET_HOURS: "8-8" });
    expect(d.remindDays).toEqual({ value: 3, source: "code" });
    expect(d.quietHours).toEqual({ value: { from: 21, to: 8 }, source: "code" });
  });

  test("Format der Ruhezeit in .env", () => {
    expect(parseQuietHours("21-8")).toEqual({ from: 21, to: 8 });
    expect(parseQuietHours(" 21:00 - 08:00 ")).toEqual({ from: 21, to: 8 });
    expect(parseQuietHours("0-6")).toEqual({ from: 0, to: 6 });
    for (const bad of ["21", "24-8", "21:30-8", "8-8", "a-b", "21-8-3"]) expect(parseQuietHours(bad)).toBeNull();
  });

  test("Schema: Tage 1 bis 14 ganz, Ruhezeit 0 bis 23 und verschieden", () => {
    const ok = (threads: unknown) => settingsSchema.safeParse({ threads }).success;
    expect(ok({ enabled: false, remindDays: 1, quietHours: { from: 21, to: 8 } })).toBe(true);
    expect(ok({ remindDays: 14 })).toBe(true);
    for (const bad of [{ remindDays: 0 }, { remindDays: 15 }, { remindDays: 2.5 }, { enabled: "off" }, { quietHours: { from: 8, to: 8 } }, { quietHours: { from: 24, to: 8 } }, { quietHours: { from: 21 } }, { foo: 1 }]) {
      expect(ok(bad)).toBe(bad && "foo" in bad ? true : false);
    }
  });
});

describe("Laufzeit: gespeicherte Einstellung wirkt ohne Neustart", () => {
  test("threadsEnabled folgt der Datei, auch gegen THREADS=off", async () => {
    expect(threadsEnabled({ THREADS: "off" })).toBe(false);
    await settings({ threads: { enabled: true } });
    expect(threadsEnabled({ THREADS: "off" })).toBe(true);
    await settings({ threads: { enabled: false } });
    expect(threadsEnabled({})).toBe(false);
  });

  test("Termin neuer Fäden: Abstand aus der Einstellung", async () => {
    const base = at("2026-10-15T10:00:00Z");
    const env = { USER_TIMEZONE: "UTC", THREADS_REMIND_DAYS: "2" };
    expect(iso(nextReminderTime(base, undefined, env))).toBe("2026-10-17T10:00:00.000Z");
    await settings({ threads: { remindDays: 5 } });
    expect(iso(nextReminderTime(base, undefined, env))).toBe("2026-10-20T10:00:00.000Z");
  });

  test("createThread nimmt den gespeicherten Abstand, bestehende Termine bleiben", async () => {
    const conv: ChoiceConversation = { type: "telegram", chatId: "4711" };
    const first = await createThread({ conversation: conv, topic: "A", context: "K", question: "Eins?" });
    if (first.status !== "created") throw new Error();
    await settings({ threads: { remindDays: 5 } });
    const second = await createThread({ conversation: conv, topic: "B", context: "K", question: "Zwei?" });
    if (second.status !== "created") throw new Error();
    const days = (t: { createdAt: number; nextReminderAt?: number }) => Math.round((t.nextReminderAt! - t.createdAt) / 86_400_000);
    // Ruhezeit kann nur nach hinten schieben, höchstens um einen Tag
    expect(days(second.thread)).toBeGreaterThanOrEqual(5);
    expect(days(second.thread)).toBeLessThanOrEqual(6);
    expect((await getThread(first.thread.id))!.nextReminderAt).toBe(first.thread.nextReminderAt);
  });

  test("aus → an ohne Neustart: Zeitgeber läuft, Durchgang sendet erst nach dem Einschalten", async () => {
    await settings({ threads: { enabled: false } });
    const conv: ChoiceConversation = { type: "telegram", chatId: "-1001234567890", topicId: 7 };
    const created = await createThread({ conversation: conv, topic: "A", context: "K", question: "Fällig?" });
    if (created.status !== "created") throw new Error();
    const clock = at("2026-10-20T10:00:00Z");
    await updateThreads(threads => {
      threads[created.thread.id].nextReminderAt = clock - 1;
      return { result: null, changed: true };
    });
    const sent: unknown[] = [];
    const deps = {
      now: () => clock,
      env: () => ({ USER_TIMEZONE: "UTC" }),
      telegram: () => true,
      send: async (input: any) => (sent.push(input), { sent: true, recorded: true }),
      conversationGone: async () => false,
      log: () => {},
    };
    let timers = 0;
    const timer = startThreadReminders(deps, { setTimeout: (() => (timers++, 0)) as any, setInterval: (() => (timers++, 0)) as any, clearTimeout: (() => {}) as any, clearInterval: (() => {}) as any });
    expect(timers).toBe(2);
    timer.stop();
    const r = createThreadReminders(deps);
    expect((await r.tick()).sent).toBe(0);
    await settings({ threads: { enabled: true } });
    expect((await r.tick()).sent).toBe(1);
  });

  test("Fäden-API folgt der Einstellung: aus, keine Fäden; an, Liste", async () => {
    const conv: ChoiceConversation = { type: "telegram", chatId: "4711" };
    await createThread({ conversation: conv, topic: "A", context: "K", question: "Offen?" });
    const port = createBotThreads({ env: () => ({}), userId: () => "4711", groupId: () => null });
    await settings({ threads: { enabled: false } });
    expect(port.enabled()).toBe(false);
    await settings({});
    expect(port.enabled()).toBe(true);
    expect((await port.list(false)).open.length).toBe(1);
  });
});

describe("Ruhezeit", () => {
  test("Standard wie bisher: vor 8 Uhr auf 9 Uhr, ab 21 Uhr auf 9 Uhr am nächsten Tag", () => {
    expect(iso(applyQuietHours(at("2026-10-16T07:59:00Z"), "UTC"))).toBe("2026-10-16T09:00:00.000Z");
    expect(iso(applyQuietHours(at("2026-10-15T21:00:00Z"), "UTC"))).toBe("2026-10-16T09:00:00.000Z");
    expect(quietTargetHour()).toBe(9);
  });

  test("eigene Ruhezeit über Mitternacht (22-6)", () => {
    const q = { from: 22, to: 6 };
    expect(isQuietTime(at("2026-10-15T21:59:00Z"), "UTC", q)).toBe(false);
    expect(isQuietTime(at("2026-10-15T22:00:00Z"), "UTC", q)).toBe(true);
    expect(isQuietTime(at("2026-10-16T05:59:00Z"), "UTC", q)).toBe(true);
    expect(isQuietTime(at("2026-10-16T06:00:00Z"), "UTC", q)).toBe(false);
    expect(iso(applyQuietHours(at("2026-10-15T23:30:00Z"), "UTC", q))).toBe("2026-10-16T07:00:00.000Z");
    expect(iso(applyQuietHours(at("2026-10-16T03:00:00Z"), "UTC", q))).toBe("2026-10-16T07:00:00.000Z");
  });

  test("eigene Ruhezeit am Tag (12-14), Ende 23 Uhr und Ende direkt vor dem Beginn", () => {
    const q = { from: 12, to: 14 };
    expect(isQuietTime(at("2026-10-15T11:59:00Z"), "UTC", q)).toBe(false);
    expect(isQuietTime(at("2026-10-15T13:00:00Z"), "UTC", q)).toBe(true);
    expect(iso(applyQuietHours(at("2026-10-15T13:00:00Z"), "UTC", q))).toBe("2026-10-15T15:00:00.000Z");
    expect(iso(applyQuietHours(at("2026-10-15T20:00:00Z"), "UTC", q))).toBe("2026-10-15T20:00:00.000Z");
    // Ende 23 Uhr: keine 24 Uhr, sondern das Ende selbst
    expect(quietTargetHour({ from: 20, to: 23 })).toBe(23);
    expect(iso(applyQuietHours(at("2026-10-15T21:00:00Z"), "UTC", { from: 20, to: 23 }))).toBe("2026-10-15T23:00:00.000Z");
    // Stunde nach dem Ende ist wieder Ruhezeit: das Ende selbst
    expect(quietTargetHour({ from: 9, to: 8 })).toBe(8);
  });

  test("Ortszeit aus USER_TIMEZONE, Ruhezeit aus der Einstellung", async () => {
    await settings({ threads: { remindDays: 1, quietHours: { from: 18, to: 10 } } });
    const env = { USER_TIMEZONE: "Europe/Berlin" };
    // 15.10. 15:00 Berlin (13:00 UTC) + 1 Tag = 16.10. 15:00 Berlin, frei
    expect(iso(nextReminderTime(at("2026-10-15T13:00:00Z"), undefined, env))).toBe("2026-10-16T13:00:00.000Z");
    // 15.10. 19:00 Berlin + 1 Tag = 16.10. 19:00, Ruhezeit: 17.10. 11:00 Berlin (09:00 UTC)
    expect(iso(nextReminderTime(at("2026-10-15T17:00:00Z"), undefined, env))).toBe("2026-10-17T09:00:00.000Z");
    // „Später" ebenso
    expect(iso(laterReminderTime(at("2026-10-15T17:00:00Z"), env))).toBe("2026-10-19T09:00:00.000Z");
  });
});

describe("PATCH /api/settings mit threads und aux.threads", () => {
  const server = () => topicServer(root, servers, null, { settings: botSettings });

  test("GET: wirksame und geerbte Werte für Fäden und das vierte Nebenmodell", async () => {
    const ctx = await server();
    const body = await (await ctx.api("/api/settings")).json();
    expect(body.effective.threads).toEqual({
      enabled: { value: true, source: "code" },
      remindDays: { value: 3, source: "code" },
      quietHours: { value: { from: 21, to: 8 }, source: "code" },
    });
    expect(body.effective.aux.threads).toEqual({ value: "claude:claude-haiku-5-5", source: "code" });
    expect(body.inheritedModels.threads.remindDays).toEqual({ value: 3, source: "code" });
    expect(body.inheritedModels.aux.threads.source).toBe("code");
  });

  test("setzen, gilt sofort, zurücksetzen mit null", async () => {
    const ctx = await server();
    let res = await ctx.api("/api/settings", "PATCH", { threads: { enabled: false, remindDays: 5, quietHours: { from: 22, to: 7 } }, aux: { threads: "ollama:qwen3:8b" } });
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.settings.threads).toEqual({ enabled: false, remindDays: 5, quietHours: { from: 22, to: 7 } });
    expect(body.settings.aux).toEqual({ threads: "ollama:qwen3:8b" });
    expect(body.effective.threads.remindDays).toEqual({ value: 5, source: "settings" });
    // Geerbt: was nach „Standard" gälte
    expect(body.inheritedModels.threads.remindDays).toEqual({ value: 3, source: "code" });
    expect(threadsEnabled({})).toBe(false);
    expect(describeThreadsSettings({}).quietHours.value).toEqual({ from: 22, to: 7 });

    res = await ctx.api("/api/settings", "PATCH", { threads: { remindDays: null, quietHours: null } });
    body = await res.json();
    expect(body.settings.threads).toEqual({ enabled: false });
    res = await ctx.api("/api/settings", "PATCH", { threads: null });
    body = await res.json();
    expect(body.settings.threads).toBeUndefined();
    expect(threadsEnabled({})).toBe(true);
  });

  test("ungültig: 400, nichts gespeichert", async () => {
    const ctx = await server();
    for (const threads of [{ remindDays: 15 }, { remindDays: "5" }, { quietHours: { from: 8, to: 8 } }, { quietHours: { from: 8 } }, { quietHours: "21-8" }, { enabled: "aus" }, { other: 1 }]) {
      const res = await ctx.api("/api/settings", "PATCH", { threads });
      expect(res.status).toBe(400);
    }
    const body = await (await ctx.api("/api/settings")).json();
    expect(body.settings).toEqual({});
  });
});
