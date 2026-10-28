/**
 * Issue #322: bedingte Änderung (updateIf) des ScheduleStore für beide
 * Adapter. Belegt: jede Bedingung (Status, genauer Termin, fällig bis,
 * Besitzer, abgelaufene Frist) greift; ungültige Bedingungen und Werte
 * ändern nichts; von zwei gleichzeitigen Übernahmen gewinnt genau eine, für
 * die Datei auch über Prozessgrenzen; Einträge aus der Zeit vor #322 ohne
 * Lease-Felder lesen sich mit leeren Feldern. Versandbeginn (sendStartedAt)
 * als Bedingung notSending; fällige Einträge je Art (due mit kind), der
 * Filter vor dem Limit. Dazu die Filter, die der Supabase-Adapter schickt.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { updateJsonState } from "../src/lib/json-state";
import type { ScheduledTask, ScheduleStore } from "../src/lib/schedule/store";
import { fileScheduleStore } from "../src/lib/schedule/file";
import { supabaseScheduleStore } from "../src/lib/schedule/supabase";
import { getSupabase } from "../src/lib/supabase";
import { useTaskTables } from "./tasks-fixture";

const NOW = Date.parse("2026-10-18T10:00:00.000Z");
const MIN = 60_000;
const at = (offsetMs: number) => new Date(NOW + offsetMs);

const ADAPTERS = [
  {
    name: "Datei",
    setup() {
      const dir = mkdtempSync(join(tmpdir(), "tybo-lease-"));
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

let quiet: typeof console.error;
beforeEach(() => {
  setSystemTime(new Date(NOW));
  quiet = console.error;
  console.error = () => {};
});
afterEach(() => {
  setSystemTime();
  console.error = quiet;
});

for (const adapter of ADAPTERS) {
  describe(`updateIf (${adapter.name})`, () => {
    let store: ScheduleStore;
    let cleanup: () => void;
    beforeEach(() => {
      ({ store, cleanup } = adapter.setup());
    });
    afterEach(() => cleanup());

    const add = async (offsetMs = -MIN): Promise<ScheduledTask> => {
      const task = await store.add({ chatId: "1", text: "Zahnarzt", dueAt: at(offsetMs) });
      if (!task) throw new Error("nicht angelegt");
      return task;
    };
    const claim = (task: ScheduledTask, owner: string) =>
      store.updateIf(task.id, { status: "pending", dueBy: new Date(NOW) }, { status: "running", leaseOwner: owner, leaseUntil: at(2 * MIN) });

    test("neue Einträge ohne Übernahme", async () => {
      expect(await add()).toMatchObject({ leaseOwner: null, leaseUntil: null });
    });

    test("Übernahme eines fälligen Eintrags setzt Status, Besitzer und Frist", async () => {
      const task = await add();
      const taken = await claim(task, "bot-a");
      expect(taken).toMatchObject({ status: "running", leaseOwner: "bot-a", leaseUntil: "2026-10-18T10:02:00.000Z" });
      expect(await store.byId(task.id)).toEqual(taken);
    });

    test("zweite Übernahme scheitert, auch gleichzeitig: genau einer gewinnt", async () => {
      const task = await add();
      const results = await Promise.all([claim(task, "bot-a"), claim(task, "bot-b")]);
      expect(results.filter(Boolean).length).toBe(1);
      const winner = results.find(Boolean)!;
      expect((await store.byId(task.id))?.leaseOwner).toBe(winner.leaseOwner);
      expect(await claim(task, "bot-c")).toBeNull();
    });

    test("noch nicht fällig: keine Übernahme", async () => {
      const task = await add(5 * MIN);
      expect(await claim(task, "bot-a")).toBeNull();
      expect((await store.byId(task.id))?.status).toBe("pending");
    });

    test("genauer Termin muss passen", async () => {
      const task = await add();
      expect(await store.updateIf(task.id, { dueAt: at(-2 * MIN) }, { text: "anders" })).toBeNull();
      expect((await store.updateIf(task.id, { dueAt: at(-MIN) }, { text: "anders" }))?.text).toBe("anders");
    });

    test("Abschluss nur durch den Besitzer", async () => {
      const task = await add();
      await claim(task, "bot-a");
      expect(await store.updateIf(task.id, { status: "running", leaseOwner: "bot-b" }, { status: "done" })).toBeNull();
      const done = await store.updateIf(task.id, { status: "running", leaseOwner: "bot-a" }, { status: "done", leaseOwner: null, leaseUntil: null });
      expect(done).toMatchObject({ status: "done", leaseOwner: null, leaseUntil: null });
    });

    test("abgelaufene Frist: ein anderer darf übernehmen, vorher nicht", async () => {
      const task = await add();
      await claim(task, "bot-a");
      const takeOver = () =>
        store.updateIf(task.id, { status: "running", leaseOwner: "bot-a", leaseUntilBefore: new Date(Date.now()) }, { leaseOwner: "bot-b", leaseUntil: new Date(Date.now() + 2 * MIN) });
      expect(await takeOver()).toBeNull();
      setSystemTime(at(3 * MIN));
      expect(await takeOver()).toMatchObject({ leaseOwner: "bot-b", leaseUntil: "2026-10-18T10:05:00.000Z" });
      // Der alte Besitzer kann danach nichts mehr abschließen
      expect(await store.updateIf(task.id, { status: "running", leaseOwner: "bot-a" }, { status: "done" })).toBeNull();
    });

    test("Versandbeginn: nur einmal setzbar, Bedingung notSending in beide Richtungen", async () => {
      const task = await add();
      await claim(task, "bot-a");
      const mark = () => store.updateIf(task.id, { status: "running", leaseOwner: "bot-a", notSending: true }, { sendStartedAt: at(0) });
      expect(await mark()).toMatchObject({ sendStartedAt: "2026-10-18T10:00:00.000Z" });
      expect(await mark()).toBeNull();
      expect(await store.updateIf(task.id, { notSending: false }, { sendStartedAt: null })).toMatchObject({ sendStartedAt: null });
      expect(await store.updateIf(task.id, { notSending: "ja" as never }, { attempts: 1 })).toBeNull();
      expect(await store.updateIf(task.id, {}, { sendStartedAt: new Date(NaN) })).toBeNull();
    });

    test("fällig je Art: Filter vor dem Limit", async () => {
      for (let i = 0; i < 5; i++) await store.add({ chatId: "1", kind: "action", text: `a${i}`, dueAt: at(-10 * MIN + i) });
      const reminder = await add();
      expect((await store.due(at(0), 3)).map(t => t.kind)).toEqual(["action", "action", "action"]);
      expect((await store.due(at(0), 3, "reminder")).map(t => t.id)).toEqual([reminder.id]);
      expect((await store.due(at(0), 10, "action")).length).toBe(5);
    });

    test("leerer Besitzer als Bedingung", async () => {
      const task = await add();
      expect((await store.updateIf(task.id, { leaseOwner: null }, { attempts: 1 }))?.attempts).toBe(1);
      await claim(task, "bot-a");
      expect(await store.updateIf(task.id, { leaseOwner: null }, { attempts: 2 })).toBeNull();
    });

    test("ungültige Bedingung oder Werte und unbekannte ID ändern nichts", async () => {
      const task = await add();
      expect(await store.updateIf(task.id, { status: "sent" as never }, { attempts: 1 })).toBeNull();
      expect(await store.updateIf(task.id, { dueBy: new Date(NaN) }, { attempts: 1 })).toBeNull();
      expect(await store.updateIf(task.id, { leaseOwner: " " }, { attempts: 1 })).toBeNull();
      expect(await store.updateIf(task.id, {}, { leaseOwner: "" })).toBeNull();
      expect(await store.updateIf(task.id, {}, { leaseUntil: new Date(NaN) })).toBeNull();
      expect(await store.updateIf("00000000-0000-4000-8000-000000000000", {}, { attempts: 1 })).toBeNull();
      expect(await store.byId(task.id)).toEqual(task);
    });
  });
}

describe("Datei: Übernahme über Prozessgrenzen", () => {
  test("sechs Prozesse wollen dieselben drei Einträge, jeder geht an genau einen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tybo-lease-race-"));
    try {
      const path = join(dir, "data", "reminders.json");
      const store = fileScheduleStore(() => path);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await store.add({ chatId: "1", text: `t${i}`, dueAt: new Date("2020-01-01T00:00:00Z") }))!.id);
      const script = join(dir, "claim.ts");
      const module = resolve(import.meta.dir, "../src/lib/schedule/file.ts");
      writeFileSync(
        script,
        `import { fileScheduleStore } from ${JSON.stringify(module)};
const store = fileScheduleStore(() => ${JSON.stringify(path)});
const won = [];
for (const id of ${JSON.stringify(ids)}) {
  const t = await store.updateIf(id, { status: "pending", dueBy: new Date() }, { status: "running", leaseOwner: process.argv[2], leaseUntil: new Date(Date.now() + 60000) });
  if (t) won.push(id);
}
console.log(JSON.stringify(won));
`,
      );
      const runs = Array.from({ length: 6 }, (_, n) => Bun.spawn([process.execPath, script, `p${n}`], { stdout: "pipe", stderr: "pipe" }));
      const outputs = await Promise.all(runs.map(r => new Response(r.stdout).text()));
      const won = outputs.flatMap(o => JSON.parse(o) as string[]);
      expect(won.sort()).toEqual([...ids].sort());
      const tasks = await store.list();
      expect(tasks.every(t => t.status === "running" && /^p\d$/.test(t.leaseOwner ?? ""))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("Datei: Einträge von vor #322", () => {
  test("ohne Lease-Felder gelesen und übernehmbar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tybo-lease-old-"));
    try {
      const path = join(dir, "data", "reminders.json");
      const old = {
        id: "a1",
        chatId: "1",
        topicId: null,
        kind: "reminder",
        text: "alt",
        dueAt: new Date(NOW - MIN).toISOString(),
        recurrence: null,
        status: "pending",
        attempts: 0,
        lastError: null,
        createdAt: new Date(NOW - 2 * MIN).toISOString(),
        updatedAt: new Date(NOW - 2 * MIN).toISOString(),
      };
      updateJsonState(path, () => ({ tasks: [] as unknown[] }), stored => {
        stored.tasks.push(old);
      });
      const store = fileScheduleStore(() => path);
      expect(await store.byId("a1")).toMatchObject({ leaseOwner: null, leaseUntil: null });
      expect(await store.updateIf("a1", { leaseOwner: null, status: "pending" }, { status: "running", leaseOwner: "bot" })).toMatchObject({ leaseOwner: "bot" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Supabase: Filter der bedingten Änderung", () => {
  test("eine PATCH-Anfrage mit allen Bedingungen", async () => {
    const tables = useTaskTables();
    try {
      const store = supabaseScheduleStore(getSupabase);
      const task = (await store.add({ chatId: "1", text: "x", dueAt: at(-MIN) }))!;
      await store.updateIf(
        task.id,
        { status: "running", dueAt: at(-MIN), dueBy: at(0), leaseOwner: "bot-a", leaseUntilBefore: at(0) },
        { status: "done", leaseOwner: null, leaseUntil: null },
      );
      await store.updateIf(task.id, { leaseOwner: null }, { attempts: 1 });
      const [, patch, patchNull] = tables.requestsTo("scheduled_tasks");
      expect(patch.method).toBe("PATCH");
      const params = patch.url.searchParams;
      expect(params.get("id")).toBe(`eq.${task.id}`);
      expect(params.get("status")).toBe("eq.running");
      expect(params.getAll("due_at")).toEqual(["eq.2026-10-18T09:59:00.000Z", "lte.2026-10-18T10:00:00.000Z"]);
      expect(params.get("lease_owner")).toBe("eq.bot-a");
      expect(params.get("lease_until")).toBe("lt.2026-10-18T10:00:00.000Z");
      expect(JSON.parse(patch.body)).toMatchObject({ status: "done", lease_owner: null, lease_until: null });
      expect(patchNull.url.searchParams.get("lease_owner")).toBe("is.null");
    } finally {
      tables.restore();
    }
  });
});
