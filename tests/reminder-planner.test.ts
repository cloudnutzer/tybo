/**
 * Issue #322: Planer für Erinnerungen (src/lib/schedule/planner.ts) gegen
 * beide Adapter der Ablage. Belegt: fällig ergibt genau eine Zustellung,
 * auch bei zwei Durchläufen nacheinander, gleichzeitig im selben Planer und
 * in zwei Planern; Aufträge (action) und künftige Einträge bleiben liegen,
 * auch 100 ältere Aufträge verdrängen keine Erinnerung; nach einem Neustart
 * kommt Verpasstes mit Hinweis, auch bei einer Minute Verspätung, die
 * normale Verzögerung durch den Takt ohne; Absturz vor dem Versand (wird
 * nachgeholt), während des Versands und nach dem Versand vor dem Abschluss
 * (beide nicht neu gesendet); Versandfehler (abgelehnt, unklar, Ausnahme);
 * Serien bekommen den nächsten Termin; Beenden gibt Übernommenes frei und
 * wartet begrenzt auf den laufenden Durchlauf; der Zeitgeber startet nie
 * zwei Durchläufe zugleich.
 * Feste Uhr, Zeitzone Europe/Berlin.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileScheduleStore } from "../src/lib/schedule/file";
import {
  createReminderPlanner,
  LEASE_MS,
  MAX_SEND_ATTEMPTS,
  PLANNER_CLAIM_WARNING,
  PLANNER_ERRORS,
  PLANNER_STOP_GRACE_MS,
  reminderMessage,
  startReminderPlanner,
  stopReminderPlanner,
  type ReminderPlannerDeps,
  type SendOutcome,
} from "../src/lib/schedule/planner";
import type { ScheduledTask, ScheduleStore } from "../src/lib/schedule/store";
import { supabaseScheduleStore } from "../src/lib/schedule/supabase";
import { getSupabase } from "../src/lib/supabase";
import { useTaskTables } from "./tasks-fixture";

const ZONE = "Europe/Berlin";
// 18.10.2026 12:00 in Berlin (Sommerzeit, UTC+2)
const NOW = Date.parse("2026-10-18T10:00:00.000Z");
const MIN = 60_000;
const at = (offsetMs: number) => new Date(NOW + offsetMs);

const ADAPTERS = [
  {
    name: "Datei",
    setup() {
      const dir = mkdtempSync(join(tmpdir(), "tybo-planner-"));
      const path = join(dir, "data", "reminders.json");
      return { store: fileScheduleStore(() => path), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    },
  },
  {
    name: "Supabase",
    setup() {
      const tables = useTaskTables();
      return { store: supabaseScheduleStore(getSupabase), cleanup: () => tables.restore() };
    },
  },
];

let clock = NOW;
let quiet: typeof console.error;
beforeEach(() => {
  clock = NOW;
  setSystemTime(new Date(NOW));
  quiet = console.error;
  console.error = () => {};
});
afterEach(() => {
  setSystemTime();
  console.error = quiet;
});

/** Zeit weiterstellen, für Planer und Ablage */
function advance(ms: number) {
  clock += ms;
  setSystemTime(new Date(clock));
}

interface Sent {
  id: string;
  text: string;
  owner: string;
}

for (const adapter of ADAPTERS) {
  describe(`Planer (${adapter.name})`, () => {
    let store: ScheduleStore;
    let cleanup: () => void;
    let sent: Sent[];
    let logs: string[];
    beforeEach(() => {
      ({ store, cleanup } = adapter.setup());
      sent = [];
      logs = [];
    });
    afterEach(() => cleanup());

    function planner(owner: string, extra: Partial<ReminderPlannerDeps> = {}) {
      return createReminderPlanner({
        store: () => store,
        now: () => clock,
        owner,
        timeZone: () => ZONE,
        send: async (task, text) => {
          sent.push({ id: task.id, text, owner });
          return "delivered";
        },
        log: line => logs.push(line),
        ...extra,
      });
    }

    const add = async (input: Partial<Parameters<ScheduleStore["add"]>[0]> = {}): Promise<ScheduledTask> => {
      const task = await store.add({ chatId: "1", text: "Zahnarzt anrufen", dueAt: at(-MIN), ...input });
      if (!task) throw new Error("nicht angelegt");
      return task;
    };

    test("fällig: genau eine Zustellung, auch bei zwei Durchläufen nacheinander", async () => {
      // Fällig beim Start des Planers, also nicht verpasst: ohne Hinweis
      const task = await add({ dueAt: at(0) });
      const p = planner("a");
      expect(await p.tick()).toMatchObject({ sent: 1 });
      expect(await p.tick()).toMatchObject({ sent: 0 });
      expect(sent).toEqual([{ id: task.id, text: "⏰ Erinnerung: Zahnarzt anrufen", owner: "a" }]);
      expect(await store.byId(task.id)).toMatchObject({ status: "done", attempts: 1, leaseOwner: null, leaseUntil: null, lastError: null });
    });

    test("zwei gleichzeitige Durchläufe im selben Planer und in zwei Planern: eine Zustellung", async () => {
      const tasks = [await add({ text: "eins" }), await add({ text: "zwei" })];
      const a = planner("a");
      const b = planner("b");
      await Promise.all([a.tick(), a.tick(), b.tick(), b.tick()]);
      expect(sent.map(s => s.id).sort()).toEqual(tasks.map(t => t.id).sort());
      for (const t of tasks) expect((await store.byId(t.id))?.status).toBe("done");
    });

    test("künftige Einträge und Aufträge (action) bleiben liegen", async () => {
      const future = await add({ dueAt: at(MIN) });
      const action = await add({ kind: "action", text: "Mails prüfen" });
      await planner("a").tick();
      expect(sent).toEqual([]);
      expect((await store.byId(future.id))?.status).toBe("pending");
      expect(await store.byId(action.id)).toMatchObject({ status: "pending", attempts: 0 });
      advance(2 * MIN);
      await planner("a").tick();
      expect(sent.map(s => s.id)).toEqual([future.id]);
    });

    test("Neustart: Verpasstes kommt im ersten Durchlauf, mit Hinweis auf den fälligen Zeitpunkt", async () => {
      // Fällig um 11:00 Berliner Zeit, der Bot war bis 12:00 aus
      const task = await add({ dueAt: at(-60 * MIN) });
      const fresh = planner("nach-neustart");
      await fresh.tick();
      expect(sent).toEqual([{ id: task.id, text: "⏰ Erinnerung: Zahnarzt anrufen\n(verspätet, fällig war 18.10. 11:00)", owner: "nach-neustart" }]);
    });

    test("Neustart mit einer Minute Verspätung: Hinweis; Verzögerung durch den Takt: keiner", async () => {
      const missed = await add({ text: "verpasst", dueAt: at(-MIN) });
      const p = planner("nach-neustart");
      // Erster Durchlauf 5 Sekunden nach dem Start
      advance(5000);
      await p.tick();
      expect(sent.map(x => [x.id, x.text])).toEqual([[missed.id, "⏰ Erinnerung: verpasst\n(verspätet, fällig war 18.10. 11:59)"]]);
      // Fällig, während der Planer lief: kommt mit dem nächsten Takt, ohne Hinweis
      const later = await add({ text: "im Takt", dueAt: at(10_000) });
      advance(30_000);
      await p.tick();
      expect(sent.map(x => [x.id, x.text])[1]).toEqual([later.id, "⏰ Erinnerung: im Takt"]);
    });

    test("Absturz nach der Übernahme, vor dem Versand: nach Ablauf der Frist nachgeholt, genau einmal", async () => {
      const task = await add();
      // Der alte Prozess hat übernommen und ist vor dem Versand abgestürzt
      await store.updateIf(task.id, { status: "pending" }, { status: "running", leaseOwner: "alt", leaseUntil: at(LEASE_MS) });
      const fresh = planner("neu");
      expect(await fresh.tick()).toMatchObject({ resumed: 0, sent: 0 });
      expect((await store.byId(task.id))?.status).toBe("running");
      advance(LEASE_MS + 1000);
      expect(await fresh.tick()).toMatchObject({ resumed: 1, recovered: 0, sent: 1 });
      expect(await fresh.tick()).toMatchObject({ resumed: 0, sent: 0 });
      expect(sent).toEqual([{ id: task.id, text: "⏰ Erinnerung: Zahnarzt anrufen\n(verspätet, fällig war 18.10. 11:59)", owner: "neu" }]);
      expect(await store.byId(task.id)).toMatchObject({ status: "done", attempts: 1, lastError: null, leaseOwner: null, sendStartedAt: null });
      expect(logs.some(l => l.includes(task.id) && l.includes("wird nachgeholt"))).toBe(true);
      expect(logs.join("\n")).not.toContain("Zahnarzt");
    });

    test("Absturz während des Versands: Ausgang unbekannt, abgeschlossen, nicht neu gesendet", async () => {
      const task = await add();
      let a: ReturnType<typeof createReminderPlanner>;
      // Der Versand von a kehrt nie zurück (Prozess stirbt mittendrin)
      a = planner("a", { send: async t => (sent.push({ id: t.id, text: "", owner: "a" }), new Promise<SendOutcome>(() => {})) });
      void a.tick();
      await Bun.sleep(20);
      expect(sent).toHaveLength(1);
      expect(await store.byId(task.id)).toMatchObject({ status: "running", leaseOwner: "a", attempts: 1 });
      expect((await store.byId(task.id))?.sendStartedAt).not.toBeNull();
      advance(LEASE_MS + 1000);
      const fresh = planner("neu");
      expect(await fresh.tick()).toMatchObject({ recovered: 1, resumed: 0, sent: 0 });
      await fresh.tick();
      expect(sent).toHaveLength(1);
      expect(await store.byId(task.id)).toMatchObject({ status: "done", lastError: PLANNER_ERRORS.orphaned, leaseOwner: null, sendStartedAt: null });
      expect(logs.some(l => l.includes(task.id) && l.includes("nicht wiederholt"))).toBe(true);
    });

    test("Absturz nach dem Versand, vor dem Abschluss: nicht neu gesendet", async () => {
      const task = await add();
      // a sendet, der Prozess stirbt beim Schreiben des Abschlusses
      const dying: ScheduleStore = {
        ...store,
        updateIf: async (id, condition, changes) => {
          if (changes.status === "done") throw new Error("Prozess beendet");
          return store.updateIf(id, condition, changes);
        },
      };
      await planner("a", { store: () => dying }).tick();
      expect(sent.map(x => x.owner)).toEqual(["a"]);
      expect((await store.byId(task.id))?.status).toBe("running");
      advance(LEASE_MS + 1000);
      const fresh = planner("neu");
      expect(await fresh.tick()).toMatchObject({ recovered: 1, sent: 0 });
      expect(sent).toHaveLength(1);
      expect(await store.byId(task.id)).toMatchObject({ status: "done", lastError: PLANNER_ERRORS.orphaned });
    });

    test("100 ältere fällige Aufträge verdrängen keine Erinnerung", async () => {
      for (let i = 0; i < 100; i++) await add({ kind: "action", text: `Auftrag ${i}`, dueAt: at(-60 * MIN + i) });
      const reminder = await add({ text: "trotzdem", dueAt: at(-MIN) });
      expect(await planner("a").tick()).toMatchObject({ sent: 1 });
      expect(sent.map(x => x.id)).toEqual([reminder.id]);
      expect((await store.due(new Date(clock), 200, "action")).length).toBe(100);
    });

    test("sicher abgelehnt: neuer Versuch im nächsten Durchlauf, nach drei Versuchen failed", async () => {
      const task = await add();
      const p = planner("a", { send: async t => (sent.push({ id: t.id, text: "", owner: "a" }), "rejected" as SendOutcome) });
      expect(await p.tick()).toMatchObject({ retry: 1 });
      expect(await store.byId(task.id)).toMatchObject({ status: "pending", attempts: 1, lastError: PLANNER_ERRORS.rejected, leaseOwner: null });
      await p.tick();
      expect(await p.tick()).toMatchObject({ failed: 1 });
      expect(await store.byId(task.id)).toMatchObject({ status: "failed", attempts: MAX_SEND_ATTEMPTS });
      await p.tick();
      expect(sent.length).toBe(MAX_SEND_ATTEMPTS);
    });

    test("unklar und Ausnahme: gelten als zugestellt, kein zweiter Versand", async () => {
      const unclear = await add({ text: "a" });
      const thrown = await add({ text: "b", dueAt: at(-2 * MIN) });
      let calls = 0;
      const p = planner("a", {
        send: async task => {
          calls++;
          if (task.id === thrown.id) throw new Error("Netz weg");
          return "unclear";
        },
      });
      expect(await p.tick()).toMatchObject({ sent: 2 });
      await p.tick();
      expect(calls).toBe(2);
      for (const t of [unclear, thrown]) expect(await store.byId(t.id)).toMatchObject({ status: "done", lastError: PLANNER_ERRORS.unclear });
    });

    test("Serie: nach der Zustellung pending mit dem nächsten Termin, Verpasstes nicht nachgeholt", async () => {
      // Seit drei Tagen fällig (täglich 08:00 Berlin), Bot war aus
      const task = await add({ dueAt: new Date("2026-10-15T06:00:00.000Z"), recurrence: "daily 08:00" });
      await planner("a").tick();
      expect(sent.length).toBe(1);
      expect(sent[0].text).toContain("(verspätet, fällig war 15.10. 08:00)");
      expect(await store.byId(task.id)).toMatchObject({ status: "pending", dueAt: "2026-10-19T06:00:00.000Z", attempts: 0, leaseOwner: null });
      await planner("a").tick();
      expect(sent.length).toBe(1);
    });

    test("Beenden zwischen Übernahme und Versand: Eintrag geht zurück auf pending", async () => {
      const task = await add();
      let p: ReturnType<typeof createReminderPlanner>;
      const stopping: ScheduleStore = {
        ...store,
        updateIf: async (id, condition, changes) => {
          const result = await store.updateIf(id, condition, changes);
          if (changes.status === "running") p.stop();
          return result;
        },
      };
      p = planner("a", { store: () => stopping });
      await p.tick();
      expect(sent).toEqual([]);
      expect(await store.byId(task.id)).toMatchObject({ status: "pending", attempts: 0, leaseOwner: null, leaseUntil: null });
      // Ein gestoppter Planer tut nichts mehr
      expect(await p.tick()).toEqual({ sent: 0, retry: 0, failed: 0, recovered: 0, resumed: 0 });
    });

    test("Übernahme scheitert an der Ablage: einmal eine Warnung im Log, nichts gesendet", async () => {
      await add({ text: "a" });
      await add({ text: "b" });
      const broken: ScheduleStore = { ...store, updateIf: async () => null };
      const p = planner("a", { store: () => broken });
      await p.tick();
      await p.tick();
      expect(sent).toEqual([]);
      expect(logs.filter(l => l === PLANNER_CLAIM_WARNING)).toHaveLength(1);
    });

    test("verlorenes Rennen ist keine Störung der Ablage: keine Warnung", async () => {
      const task = await add();
      const racing: ScheduleStore = {
        ...store,
        updateIf: async (id, condition, changes) => {
          // Ein anderer Planer übernimmt unmittelbar vorher
          if (changes.status === "running") await store.updateIf(id, { status: "pending" }, { status: "running", leaseOwner: "b", leaseUntil: at(LEASE_MS) });
          return store.updateIf(id, condition, changes);
        },
      };
      await planner("a", { store: () => racing }).tick();
      expect(sent).toEqual([]);
      expect(logs).not.toContain(PLANNER_CLAIM_WARNING);
      expect((await store.byId(task.id))?.leaseOwner).toBe("b");
    });

    test("Ergebnis nach Ablauf der Übernahme überschreibt nichts", async () => {
      const task = await add();
      const b = planner("b");
      const a = planner("a", {
        send: async t => {
          sent.push({ id: t.id, text: "", owner: "a" });
          // Versand hängt über die Frist hinaus, ein zweiter Planer wertet aus
          advance(LEASE_MS + 1000);
          await b.tick();
          return "delivered";
        },
      });
      await a.tick();
      expect(sent.length).toBe(1);
      expect((await store.byId(task.id))?.lastError).toBe(PLANNER_ERRORS.orphaned);
      expect(logs.some(l => l.includes("nichts überschrieben"))).toBe(true);
    });

    test("Beenden während des Versands: wartet auf den Abschluss, höchstens die Frist", async () => {
      const task = await add();
      let finish: (o: SendOutcome) => void = () => {};
      const timer = startReminderPlanner(
        { store: () => store, now: () => clock, owner: "a", timeZone: () => ZONE, log: () => {}, send: () => new Promise<SendOutcome>(r => (finish = r)) },
        { firstDelayMs: 0, intervalMs: 60 * MIN },
      );
      await Bun.sleep(20);
      expect((await store.byId(task.id))?.status).toBe("running");
      const stopping = stopReminderPlanner(timer, 1000);
      finish("delivered");
      expect(await stopping).toBe(true);
      expect((await store.byId(task.id))?.status).toBe("done");
    });
  });
}

describe("Beenden", () => {
  test("hängt der Durchlauf, endet das Warten nach der Frist", async () => {
    let stopped = false;
    const hanging = { stop: () => void (stopped = true), idle: () => new Promise<void>(() => {}) };
    const started = Date.now();
    expect(await stopReminderPlanner(hanging, 30)).toBe(false);
    expect(stopped).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(PLANNER_STOP_GRACE_MS).toBe(5000);
  });
});

describe("Text der Erinnerung", () => {
  test("pünktlich ohne Hinweis, ab fünf Minuten mit Zeitpunkt in der Zone", () => {
    const task = { text: "Blumen", dueAt: "2026-10-18T10:00:00.000Z" };
    expect(reminderMessage(task, NOW + 4 * MIN, ZONE)).toBe("⏰ Erinnerung: Blumen");
    expect(reminderMessage(task, NOW + 5 * MIN, ZONE)).toBe("⏰ Erinnerung: Blumen\n(verspätet, fällig war 18.10. 12:00)");
    expect(reminderMessage(task, NOW + 5 * MIN, "UTC")).toContain("18.10. 10:00");
  });

  test("vor dem Start des Planers fällig: Hinweis auch bei kurzer Verspätung", () => {
    const task = { text: "Blumen", dueAt: "2026-10-18T10:00:00.000Z" };
    expect(reminderMessage(task, NOW + MIN, ZONE, NOW + 30_000)).toBe("⏰ Erinnerung: Blumen\n(verspätet, fällig war 18.10. 12:00)");
    expect(reminderMessage(task, NOW + MIN, ZONE, NOW)).toBe("⏰ Erinnerung: Blumen");
  });
});

describe("Zeitgeber", () => {
  test("erster Durchlauf nach kurzer Wartezeit, dann im Takt, nie zwei zugleich; stop hält an", async () => {
    let started = 0;
    let release: () => void = () => {};
    const store = {
      list: async () => [],
      due: async () => {
        started++;
        await new Promise<void>(r => (release = r));
        return [];
      },
    } as unknown as ScheduleStore;
    const timeouts: (() => void)[] = [];
    const intervals: (() => void)[] = [];
    const timer = startReminderPlanner(
      { store: () => store, now: () => clock, send: async () => "delivered", owner: "t" },
      {
        setTimeout: ((fn: () => void, ms: number) => (timeouts.push(fn), expect(ms).toBe(5000), 1)) as never,
        setInterval: ((fn: () => void, ms: number) => (intervals.push(fn), expect(ms).toBe(30_000), 2)) as never,
        clearTimeout: (() => {}) as never,
        clearInterval: (() => {}) as never,
      },
    );
    expect(timer.owner).toBe("t");
    timeouts[0]();
    await Bun.sleep(0);
    intervals[0]();
    await Bun.sleep(0);
    expect(started).toBe(1);
    release();
    await timer.idle();
    intervals[0]();
    await Bun.sleep(0);
    expect(started).toBe(2);
    release();
    await timer.idle();
    timer.stop();
    intervals[0]();
    await Bun.sleep(0);
    expect(started).toBe(2);
  });
});
