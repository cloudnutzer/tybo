/**
 * Issue #312: Vertrag für Aufträge mit Rückfrage (async_tasks) und das
 * Lebenszeichen der Rechner (node_heartbeat) über Supabase. Hielt fest, was
 * die alten Einstiege in supabase.ts taten (entfallen mit Issue #382), und
 * prüft getStore().tasks gegen dieselben Fälle: Anlegen als running, Ändern samt updated_at ohne
 * undefined zu null zu machen, wartende und laufende Aufträge je Chat
 * (neueste zuerst), liegengebliebene nach Grenze, Upsert des Lebenszeichens
 * und seine Altersgrenze. Kein Netz, feste Uhr.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { getStore, resetStore } from "../src/lib/store";
import { supabaseTasks } from "../src/lib/store/supabase/tasks";
import type { TaskStore } from "../src/lib/store/ports";
import { throwingClient, useTaskTables, type Row, type TaskTablesOptions } from "./tasks-fixture";

const WAYS: { name: string; tasks: () => TaskStore }[] = [
  {
    name: "getStore().tasks",
    tasks: () => {
      resetStore();
      const store = getStore();
      expect(store.backend).toBe("supabase");
      return store.tasks;
    },
  },
];

const NOW = Date.parse("2026-10-17T10:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

const cleanups: (() => void)[] = [];
let quiet: typeof console.error;
beforeEach(() => {
  setSystemTime(new Date(NOW));
  // Die alten Einstiege melden Fehler auf stderr; im Test stört das nur
  quiet = console.error;
  console.error = () => {};
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  setSystemTime();
  console.error = quiet;
  resetStore();
});

function tables(options: TaskTablesOptions = {}) {
  const fake = useTaskTables(options);
  cleanups.push(() => fake.restore());
  return fake;
}

const task = (fields: Row): Row => ({ original_prompt: "Bericht schreiben", ...fields });

for (const way of WAYS) {
  describe(`Aufträge über ${way.name}`, () => {
    test("create legt mit status running an und gibt die ganze Zeile zurück", async () => {
      const fake = tables();
      const created = await way.tasks().create("42", "Fasse den Tag zusammen", 7, "mac");
      expect(created).not.toBeNull();
      expect(created!.status).toBe("running");
      expect(created!.chat_id).toBe("42");
      expect(created!.original_prompt).toBe("Fasse den Tag zusammen");
      expect(created!.thread_id).toBe(7);
      expect(created!.processed_by).toBe("mac");
      expect(created!.reminder_sent).toBe(false);
      expect(typeof created!.id).toBe("string");
      expect(fake.tables.async_tasks).toHaveLength(1);
    });

    test("create ohne Topic und Rechner lässt die Spalten leer", async () => {
      const fake = tables();
      const created = await way.tasks().create("42", "x");
      expect(created!.status).toBe("running");
      expect(fake.tables.async_tasks[0].thread_id).toBeUndefined();
      expect(fake.tables.async_tasks[0].processed_by).toBeUndefined();
      const body = JSON.parse(fake.requestsTo("async_tasks")[0].body);
      expect("thread_id" in body).toBe(false);
    });

    test("create scheitert still: null bei Datenbankfehler", async () => {
      tables({ fail: ["async_tasks"] });
      expect(await way.tasks().create("42", "x")).toBeNull();
    });

    test("update ändert die Felder, setzt updated_at auf jetzt und erhält Metadaten, Session und Optionen", async () => {
      const fake = tables({
        rows: {
          async_tasks: [
            task({ id: "t1", chat_id: "42", status: "running", updated_at: at(-HOUR), thread_id: 9, metadata: { tool_use_id: "tu_1", messages_snapshot: [{ role: "user" }] } }),
          ],
        },
      });
      const options = [
        { label: "Ja", value: "1" },
        { label: "Nein", value: "2" },
      ];
      const ok = await way.tasks().update("t1", { status: "needs_input", session_id: "s-1", pending_question: "Weiter?", pending_options: options });
      expect(ok).toBe(true);
      const row = fake.tables.async_tasks[0];
      expect(row.status).toBe("needs_input");
      expect(row.session_id).toBe("s-1");
      expect(row.pending_options).toEqual(options);
      expect(row.updated_at).toBe(at(0));
      expect(row.thread_id).toBe(9);
      expect(row.metadata).toEqual({ tool_use_id: "tu_1", messages_snapshot: [{ role: "user" }] });
    });

    test("update mit undefined löscht nichts: das Feld fehlt im Body, kein null", async () => {
      const fake = tables({
        rows: { async_tasks: [task({ id: "t1", chat_id: "42", status: "needs_input", pending_question: "Weiter?", pending_options: [{ label: "Ja", value: "1" }], session_id: "s-1" })] },
      });
      const ok = await way.tasks().update("t1", { status: "running", user_response: "Ja", pending_question: undefined, pending_options: undefined, session_id: undefined });
      expect(ok).toBe(true);
      const body = JSON.parse(fake.requestsTo("async_tasks").at(-1)!.body);
      expect(Object.keys(body).sort()).toEqual(["status", "updated_at", "user_response"]);
      const row = fake.tables.async_tasks[0];
      expect(row.pending_question).toBe("Weiter?");
      expect(row.pending_options).toEqual([{ label: "Ja", value: "1" }]);
      expect(row.session_id).toBe("s-1");
    });

    test("update setzt metadata als Ganzes, wenn sie mitkommt", async () => {
      const fake = tables({ rows: { async_tasks: [task({ id: "t1", chat_id: "42", status: "running", metadata: { a: 1 } })] } });
      await way.tasks().update("t1", { metadata: { assistant_content: [{ type: "text" }], tool_use_id: "tu_9" } });
      expect(fake.tables.async_tasks[0].metadata).toEqual({ assistant_content: [{ type: "text" }], tool_use_id: "tu_9" });
    });

    test("update scheitert still: false bei Datenbankfehler", async () => {
      tables({ fail: ["async_tasks"] });
      expect(await way.tasks().update("t1", { status: "completed" })).toBe(false);
    });

    test("byId liefert die Zeile oder null", async () => {
      tables({ rows: { async_tasks: [task({ id: "t1", chat_id: "42", status: "running", thread_id: 3 })] } });
      const found = await way.tasks().byId("t1");
      expect(found?.id).toBe("t1");
      expect(found?.thread_id).toBe(3);
      expect(await way.tasks().byId("fehlt")).toBeNull();
    });

    test("pending: nur needs_input dieses Chats, neueste zuerst", async () => {
      tables({
        rows: {
          async_tasks: [
            task({ id: "alt", chat_id: "42", status: "needs_input", created_at: at(-3 * HOUR) }),
            task({ id: "neu", chat_id: "42", status: "needs_input", created_at: at(-HOUR) }),
            task({ id: "laeuft", chat_id: "42", status: "running", created_at: at(-MIN) }),
            task({ id: "fremd", chat_id: "99", status: "needs_input", created_at: at(-MIN) }),
          ],
        },
      });
      expect((await way.tasks().pending("42")).map(t => t.id)).toEqual(["neu", "alt"]);
    });

    test("running: nur running dieses Chats, neueste zuerst", async () => {
      tables({
        rows: {
          async_tasks: [
            task({ id: "r1", chat_id: "42", status: "running", created_at: at(-2 * HOUR) }),
            task({ id: "r2", chat_id: "42", status: "running", created_at: at(-MIN) }),
            task({ id: "fertig", chat_id: "42", status: "completed", created_at: at(-MIN) }),
            task({ id: "fremd", chat_id: "99", status: "running", created_at: at(-MIN) }),
          ],
        },
      });
      expect((await way.tasks().running("42")).map(t => t.id)).toEqual(["r2", "r1"]);
    });

    test("stale: needs_input, noch nicht erinnert, updated_at strikt vor der Grenze, über alle Chats", async () => {
      tables({
        rows: {
          async_tasks: [
            task({ id: "alt", chat_id: "42", status: "needs_input", reminder_sent: false, updated_at: at(-3 * HOUR) }),
            task({ id: "fremd", chat_id: "99", status: "needs_input", reminder_sent: false, updated_at: at(-2 * HOUR - 1) }),
            task({ id: "genau", chat_id: "42", status: "needs_input", reminder_sent: false, updated_at: at(-2 * HOUR) }),
            task({ id: "frisch", chat_id: "42", status: "needs_input", reminder_sent: false, updated_at: at(-MIN) }),
            task({ id: "erinnert", chat_id: "42", status: "needs_input", reminder_sent: true, updated_at: at(-3 * HOUR) }),
            task({ id: "laeuft", chat_id: "42", status: "running", reminder_sent: false, updated_at: at(-3 * HOUR) }),
          ],
        },
      });
      expect((await way.tasks().stale(2 * HOUR)).map(t => t.id).sort()).toEqual(["alt", "fremd"]);
    });

    test("Lesen scheitert still: leere Listen und null bei Fehler", async () => {
      tables({ fail: ["async_tasks"] });
      expect(await way.tasks().pending("42")).toEqual([]);
      expect(await way.tasks().running("42")).toEqual([]);
      expect(await way.tasks().stale(HOUR)).toEqual([]);
      expect(await way.tasks().byId("t1")).toBeNull();
    });
  });

  describe(`Lebenszeichen über ${way.name}`, () => {
    test("heartbeat legt an und überschreibt beim zweiten Mal dieselbe Zeile", async () => {
      const fake = tables();
      expect(await way.tasks().heartbeat("mac", { started_at: at(0) })).toBe(true);
      setSystemTime(new Date(NOW + 30_000));
      expect(await way.tasks().heartbeat("mac")).toBe(true);
      expect(fake.tables.node_heartbeat).toEqual([{ node_id: "mac", last_heartbeat: at(30_000), metadata: {} }]);
    });

    test("heartbeat scheitert still: false bei Fehler", async () => {
      tables({ fail: ["node_heartbeat"] });
      expect(await way.tasks().heartbeat("mac")).toBe(false);
    });

    test("nodeStatus: online nur, wenn jünger als die Grenze", async () => {
      tables({
        rows: {
          node_heartbeat: [
            { node_id: "frisch", last_heartbeat: at(-30_000) },
            { node_id: "grenze", last_heartbeat: at(-90_000) },
            { node_id: "alt", last_heartbeat: at(-5 * MIN) },
          ],
        },
      });
      const tasks = way.tasks();
      expect(await tasks.nodeStatus("frisch", 90_000)).toEqual({ online: true, lastHeartbeat: at(-30_000) });
      expect(await tasks.nodeStatus("grenze", 90_000)).toEqual({ online: false, lastHeartbeat: at(-90_000) });
      expect(await tasks.nodeStatus("alt", 90_000)).toEqual({ online: false, lastHeartbeat: at(-5 * MIN) });
    });

    test("nodeStatus ohne Zeile oder bei Fehler: offline ohne Zeitpunkt", async () => {
      tables();
      expect(await way.tasks().nodeStatus("unbekannt", 90_000)).toEqual({ online: false, lastHeartbeat: null });
      cleanups.pop()!();
      tables({ fail: ["node_heartbeat"] });
      expect(await way.tasks().nodeStatus("mac", 90_000)).toEqual({ online: false, lastHeartbeat: null });
    });
  });
}

describe("Supabase-Aufträge: Ausnahmen und fehlender Client", () => {
  test("eine Ausnahme des Clients wird still zu null, false oder []", async () => {
    const store = supabaseTasks(throwingClient);
    expect(await store.create("42", "x")).toBeNull();
    expect(await store.update("t1", { status: "completed" })).toBe(false);
    expect(await store.byId("t1")).toBeNull();
    expect(await store.pending("42")).toEqual([]);
    expect(await store.running("42")).toEqual([]);
    expect(await store.stale(HOUR)).toEqual([]);
    expect(await store.heartbeat("mac")).toBe(false);
    expect(await store.nodeStatus("mac", 90_000)).toEqual({ online: false, lastHeartbeat: null });
  });

  test("ohne Client schreibt nichts und liest leer", async () => {
    const store = supabaseTasks(() => null);
    expect(await store.create("42", "x")).toBeNull();
    expect(await store.update("t1", { status: "completed" })).toBe(false);
    expect(await store.pending("42")).toEqual([]);
    expect(await store.heartbeat("mac")).toBe(false);
    expect(await store.nodeStatus("mac", 90_000)).toEqual({ online: false, lastHeartbeat: null });
  });
});
