/**
 * Issue #321: Vertrag des ScheduleStore (src/lib/schedule/store.ts) für
 * beide Adapter mit denselben Fällen: Anlegen mit Vorgaben, ungültige
 * Eingaben, Liste je Gespräch (Chat, Topic, Direktchat ohne Topic, Status),
 * Fällige, Ändern, Abbrechen nur wartender Einträge und Persistenz nach
 * erneutem Öffnen. Dazu die Wahl des Adapters aus der Umgebung und, nur für
 * die Datei, gleichzeitige Änderungen aus mehreren Prozessen ohne Verlust.
 *
 * Supabase läuft ohne Netz gegen die Tabellen-Attrappe (tests/tasks-fixture.ts);
 * die Tabelle selbst prüft tests/scheduled-tasks-pg.test.ts gegen echtes
 * PostgreSQL. Feste Uhr.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  getScheduleStore,
  resetScheduleStore,
  scheduleFilePath,
  type ScheduleStore,
  type ScheduledTask,
} from "../src/lib/schedule/store";
import { fileScheduleStore } from "../src/lib/schedule/file";
import { supabaseScheduleStore } from "../src/lib/schedule/supabase";
import { getSupabase } from "../src/lib/supabase";
import { throwingClient, useTaskTables } from "./tasks-fixture";

const NOW = Date.parse("2026-10-17T10:00:00.000Z");
const HOUR = 3_600_000;
const at = (offsetMs: number) => new Date(NOW + offsetMs);

interface Adapter {
  name: string;
  /** Bereitet die Ablage vor; open() liefert jedes Mal einen frischen Store auf derselben Ablage */
  setup(): { open(): ScheduleStore; cleanup(): void };
}

const ADAPTERS: Adapter[] = [
  {
    name: "Datei",
    setup() {
      const dir = mkdtempSync(join(tmpdir(), "tybo-schedule-"));
      const path = join(dir, "data", "reminders.json");
      return { open: () => fileScheduleStore(() => path), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    },
  },
  {
    name: "Supabase",
    setup() {
      const tables = useTaskTables();
      return { open: () => supabaseScheduleStore(getSupabase), cleanup: () => tables.restore() };
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
  resetScheduleStore();
});

for (const adapter of ADAPTERS) {
  describe(`ScheduleStore (${adapter.name})`, () => {
    let open: () => ScheduleStore;
    let cleanup: () => void;
    let store: ScheduleStore;

    beforeEach(() => {
      ({ open, cleanup } = adapter.setup());
      store = open();
    });
    afterEach(() => cleanup());

    const add = async (input: Parameters<ScheduleStore["add"]>[0]): Promise<ScheduledTask> => {
      const task = await store.add(input);
      if (!task) throw new Error("nicht angelegt");
      return task;
    };

    test("Anlegen: Vorgaben, ISO-Zeitpunkte, eigene ID", async () => {
      const task = await add({ chatId: "123", text: "Zahnarzt anrufen", dueAt: at(HOUR) });
      expect(task).toEqual({
        id: expect.any(String),
        chatId: "123",
        topicId: null,
        kind: "reminder",
        text: "Zahnarzt anrufen",
        dueAt: "2026-10-17T11:00:00.000Z",
        recurrence: null,
        status: "pending",
        attempts: 0,
        lastError: null,
        leaseOwner: null,
        leaseUntil: null,
        sendStartedAt: null,
        createdAt: "2026-10-17T10:00:00.000Z",
        updatedAt: "2026-10-17T10:00:00.000Z",
      });
      const other = await add({ chatId: "123", text: "zweite", dueAt: at(HOUR) });
      expect(other.id).not.toBe(task.id);
      expect(await store.byId(task.id)).toEqual(task);
    });

    test("Anlegen mit Topic, Art action, Wiederholung und Web-Kennung", async () => {
      const task = await add({ chatId: "web:3f2a9c", topicId: 42, kind: "action", text: "Mails prüfen", dueAt: at(HOUR), recurrence: "daily 09:00" });
      expect(task).toMatchObject({ chatId: "web:3f2a9c", topicId: 42, kind: "action", recurrence: "daily 09:00" });
    });

    test("Wiederholung in kanonischer Form", async () => {
      const task = await add({ chatId: "1", text: "x", dueAt: at(HOUR), recurrence: "  Weekly MON 7:05 " });
      expect(task.recurrence).toBe("weekly mon 07:05");
      expect((await store.update(task.id, { recurrence: "EVERY 3h" }))?.recurrence).toBe("every 3h");
    });

    test("ungültige Eingaben: nichts angelegt", async () => {
      const bad: Parameters<ScheduleStore["add"]>[0][] = [
        { chatId: "", text: "x", dueAt: at(HOUR) },
        { chatId: "  ", text: "x", dueAt: at(HOUR) },
        { chatId: "1", text: "   ", dueAt: at(HOUR) },
        { chatId: "1", text: "x", dueAt: new Date(NaN) },
        { chatId: "1", text: "x", dueAt: "morgen" as unknown as Date },
        { chatId: "1", text: "x", dueAt: at(HOUR), topicId: 1.5 },
        { chatId: "1", text: "x", dueAt: at(HOUR), kind: "recurring" as never },
        { chatId: "1", text: "x", dueAt: at(HOUR), recurrence: "manchmal" },
        { chatId: "1", text: "x", dueAt: at(HOUR), recurrence: "every 0h" },
        { chatId: "1", text: "x", dueAt: at(HOUR), recurrence: "daily" },
      ];
      for (const input of bad) expect(await store.add(input)).toBeNull();
      expect(await store.list()).toEqual([]);
    });

    test("Liste je Gespräch: Chat, Topic, ohne Topic, Status; nach Fälligkeit sortiert", async () => {
      const late = await add({ chatId: "1", topicId: 5, text: "spät", dueAt: at(3 * HOUR) });
      const early = await add({ chatId: "1", topicId: 5, text: "früh", dueAt: at(HOUR) });
      const direct = await add({ chatId: "1", text: "direkt", dueAt: at(2 * HOUR) });
      const web = await add({ chatId: "web:abc", text: "web", dueAt: at(HOUR) });
      await store.cancel(late.id);

      const ids = (tasks: ScheduledTask[]) => tasks.map(t => t.text);
      expect(ids(await store.list())).toEqual(["früh", "web", "direkt", "spät"]);
      expect(ids(await store.list({ chatId: "1" }))).toEqual(["früh", "direkt", "spät"]);
      expect(ids(await store.list({ chatId: "1", topicId: 5 }))).toEqual(["früh", "spät"]);
      expect(ids(await store.list({ chatId: "1", topicId: null }))).toEqual(["direkt"]);
      expect(ids(await store.list({ chatId: "web:abc" }))).toEqual(["web"]);
      expect(ids(await store.list({ chatId: "1", status: ["pending"] }))).toEqual(["früh", "direkt"]);
      expect(ids(await store.list({ status: ["cancelled", "done"] }))).toEqual(["spät"]);
      expect(await store.list({ chatId: "2" })).toEqual([]);
      expect(early.id && direct.id && web.id).toBeTruthy();
    });

    test("Fällige: nur wartende bis jetzt, älteste zuerst, höchstens limit", async () => {
      await add({ chatId: "1", text: "künftig", dueAt: at(HOUR) });
      await add({ chatId: "1", text: "genau jetzt", dueAt: at(0) });
      await add({ chatId: "1", text: "vor zwei Stunden", dueAt: at(-2 * HOUR) });
      const sent = await add({ chatId: "1", text: "schon erledigt", dueAt: at(-3 * HOUR) });
      await store.update(sent.id, { status: "done" });
      await add({ chatId: "2", text: "anderer Chat", dueAt: at(-HOUR) });

      const due = await store.due(new Date(NOW), 10);
      expect(due.map(t => t.text)).toEqual(["vor zwei Stunden", "anderer Chat", "genau jetzt"]);
      expect((await store.due(new Date(NOW), 2)).map(t => t.text)).toEqual(["vor zwei Stunden", "anderer Chat"]);
      expect(await store.due(at(-4 * HOUR), 10)).toEqual([]);
    });

    test("Ändern: Felder einzeln, updatedAt neu, Rest bleibt", async () => {
      const task = await add({ chatId: "1", text: "alt", dueAt: at(HOUR), recurrence: "every 2h" });
      setSystemTime(new Date(NOW + 60_000));
      const changed = await store.update(task.id, { status: "failed", attempts: 2, lastError: "Telegram weg" });
      expect(changed).toEqual({ ...task, status: "failed", attempts: 2, lastError: "Telegram weg", updatedAt: "2026-10-17T10:01:00.000Z" });
      const moved = await store.update(task.id, { dueAt: at(5 * HOUR), status: "pending", lastError: null, recurrence: null, text: "neu" });
      expect(moved).toMatchObject({ dueAt: "2026-10-17T15:00:00.000Z", status: "pending", lastError: null, recurrence: null, text: "neu", attempts: 2 });
      expect(await store.byId(task.id)).toEqual(moved);
    });

    test("Ändern: unbekannte ID oder ungültige Werte ergeben null und lassen den Eintrag stehen", async () => {
      const task = await add({ chatId: "1", text: "x", dueAt: at(HOUR) });
      expect(await store.update("00000000-0000-4000-8000-000000000000", { status: "done" })).toBeNull();
      expect(await store.update(task.id, { status: "sent" as never })).toBeNull();
      expect(await store.update(task.id, { attempts: -1 })).toBeNull();
      expect(await store.update(task.id, { attempts: 1.5 })).toBeNull();
      expect(await store.update(task.id, { dueAt: new Date(NaN) })).toBeNull();
      expect(await store.update(task.id, { text: " " })).toBeNull();
      expect(await store.update(task.id, { recurrence: "nie" })).toBeNull();
      expect(await store.byId(task.id)).toEqual(task);
      expect(await store.byId("00000000-0000-4000-8000-000000000000")).toBeNull();
    });

    test("Abbrechen nur, solange der Eintrag wartet", async () => {
      const waiting = await add({ chatId: "1", text: "a", dueAt: at(HOUR) });
      const done = await add({ chatId: "1", text: "b", dueAt: at(HOUR) });
      await store.update(done.id, { status: "done" });
      expect(await store.cancel(waiting.id)).toBe(true);
      expect((await store.byId(waiting.id))?.status).toBe("cancelled");
      expect(await store.cancel(waiting.id)).toBe(false);
      expect(await store.cancel(done.id)).toBe(false);
      expect((await store.byId(done.id))?.status).toBe("done");
      expect(await store.cancel("00000000-0000-4000-8000-000000000000")).toBe(false);
    });

    test("nach erneutem Öffnen ist alles noch da", async () => {
      const task = await add({ chatId: "1", topicId: 3, text: "bleibt", dueAt: at(HOUR), recurrence: "weekdays 08:30" });
      await store.update(task.id, { attempts: 1 });
      const reopened = open();
      expect(await reopened.list()).toEqual([{ ...task, attempts: 1 }]);
    });
  });
}

describe("ScheduleStore (Supabase) bei Fehlern", () => {
  test("Fehler der Datenbank: null, false bzw. leere Listen", async () => {
    const tables = useTaskTables({ fail: ["scheduled_tasks"] });
    try {
      const store = supabaseScheduleStore(getSupabase);
      expect(await store.add({ chatId: "1", text: "x", dueAt: at(HOUR) })).toBeNull();
      expect(await store.byId("x")).toBeNull();
      expect(await store.list()).toEqual([]);
      expect(await store.due(new Date(NOW), 5)).toEqual([]);
      expect(await store.update("x", { status: "done" })).toBeNull();
      expect(await store.cancel("x")).toBe(false);
    } finally {
      tables.restore();
    }
  });

  test("Ausnahme im Client und kein Client: ebenso still", async () => {
    for (const source of [() => throwingClient(), () => null]) {
      const store = supabaseScheduleStore(source);
      expect(await store.add({ chatId: "1", text: "x", dueAt: at(HOUR) })).toBeNull();
      expect(await store.list({ chatId: "1" })).toEqual([]);
      expect(await store.due(new Date(NOW), 5)).toEqual([]);
      expect(await store.cancel("x")).toBe(false);
    }
  });

  test("Spalten und Filter so, wie die Tabelle sie kennt", async () => {
    const tables = useTaskTables();
    try {
      const store = supabaseScheduleStore(getSupabase);
      await store.add({ chatId: "1", topicId: 9, text: "x", dueAt: at(HOUR) });
      await store.due(new Date(NOW), 3);
      const [insert, due] = tables.requestsTo("scheduled_tasks");
      expect(JSON.parse(insert.body)).toEqual({
        chat_id: "1",
        topic_id: 9,
        kind: "reminder",
        text: "x",
        due_at: "2026-10-17T11:00:00.000Z",
        recurrence: null,
      });
      expect(due.url.searchParams.get("status")).toBe("eq.pending");
      expect(due.url.searchParams.get("due_at")).toBe("lte.2026-10-17T10:00:00.000Z");
      expect(due.url.searchParams.get("limit")).toBe("3");
    } finally {
      tables.restore();
    }
  });
});

describe("Wahl des Adapters", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GO_PROJECT_ROOT"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("Ort der Datei: data/reminders.json im Projektordner", () => {
    expect(scheduleFilePath({ GO_PROJECT_ROOT: "/srv/tybo" })).toBe("/srv/tybo/data/reminders.json");
    expect(scheduleFilePath({})).toBe(join(process.cwd(), "data", "reminders.json"));
  });

  test("ohne Supabase die Datei, einmal gewählt bleibt es derselbe Store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tybo-schedule-pick-"));
    try {
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      process.env.GO_PROJECT_ROOT = dir;
      resetScheduleStore();
      const store = getScheduleStore();
      expect(store.backend).toBe("file");
      expect(getScheduleStore()).toBe(store);
      await store.add({ chatId: "1", text: "x", dueAt: at(HOUR) });
      // Abgelegt wird über updateJsonState, also in reminders.json.sqlite
      expect(existsSync(join(dir, "data", "reminders.json.sqlite"))).toBe(true);
      expect(existsSync(join(dir, "data", "reminders.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mit URL und Service-Role-Key Supabase", async () => {
    const tables = useTaskTables();
    try {
      resetScheduleStore();
      const store = getScheduleStore();
      expect(store.backend).toBe("supabase");
      await store.add({ chatId: "1", text: "x", dueAt: at(HOUR) });
      expect(tables.tables.scheduled_tasks.length).toBe(1);
    } finally {
      tables.restore();
    }
  });
});

describe("Datei: gleichzeitige Änderungen", () => {
  test("acht Prozesse legen gleichzeitig an, keiner geht verloren", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tybo-schedule-race-"));
    try {
      const path = join(dir, "data", "reminders.json");
      const script = join(dir, "add.ts");
      const module = resolve(import.meta.dir, "../src/lib/schedule/file.ts");
      writeFileSync(
        script,
        `import { fileScheduleStore } from ${JSON.stringify(module)};
const store = fileScheduleStore(() => ${JSON.stringify(path)});
for (let i = 0; i < 5; i++) {
  const task = await store.add({ chatId: "1", text: process.argv[2] + "-" + i, dueAt: new Date(Date.now() + 3600000) });
  if (!task) process.exit(1);
}
`,
      );
      const runs = Array.from({ length: 8 }, (_, n) => Bun.spawn([process.execPath, script, `p${n}`], { stdout: "ignore", stderr: "pipe" }));
      const codes = await Promise.all(runs.map(r => r.exited));
      expect(codes).toEqual(Array(8).fill(0));
      const texts = (await fileScheduleStore(() => path).list()).map(t => t.text).sort();
      const expected = Array.from({ length: 8 }, (_, n) => Array.from({ length: 5 }, (_, i) => `p${n}-${i}`)).flat().sort();
      expect(texts).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
