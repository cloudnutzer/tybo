/**
 * Issue #312: Protokoll und Verbindungstest über Supabase. Die Tabelle logs
 * hat laut db/schema.sql die Pflichtspalte event und keine Spalte service;
 * der Store schreibt den Dienstnamen deshalb nach event. Logfehler bleiben
 * still. ping() antwortet immer mit { ok, message }: bei leerer Tabelle,
 * ohne Client, bei Fehlern und bei Ausnahmen. Kein Netz.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getStore, resetStore } from "../src/lib/store";
import { supabaseLogs } from "../src/lib/store/supabase/logs";
import { throwingClient, useTaskTables, type TaskTablesOptions } from "./tasks-fixture";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetStore();
});

function tables(options: TaskTablesOptions = {}) {
  const fake = useTaskTables(options);
  cleanups.push(() => fake.restore());
  return fake;
}

/** Logs aus dem öffentlichen Zugang, neu gewählt für die Umgebung der Attrappe */
function logs() {
  resetStore();
  const store = getStore();
  expect(store.backend).toBe("supabase");
  return store.logs;
}

describe("logs.write", () => {
  test("schreibt level, Dienst als event, message und metadata", async () => {
    const fake = tables();
    await logs().write("warn", "watchdog", "Mac antwortet nicht", { node: "mac", tries: 3 });
    expect(fake.tables.logs).toHaveLength(1);
    const row = fake.tables.logs[0];
    expect(row.level).toBe("warn");
    expect(row.event).toBe("watchdog");
    expect(row.message).toBe("Mac antwortet nicht");
    expect(row.metadata).toEqual({ node: "mac", tries: 3 });
    expect("service" in row).toBe(false);
  });

  test("ohne metadata gilt die Vorgabe der Tabelle", async () => {
    const fake = tables();
    await logs().write("info", "bot", "gestartet");
    expect(fake.tables.logs[0].metadata).toEqual({});
    expect(JSON.parse(fake.requestsTo("logs")[0].body)).toEqual({ level: "info", event: "bot", message: "gestartet" });
  });

  test("alle vier Stufen passen", async () => {
    const fake = tables();
    for (const level of ["debug", "info", "warn", "error"] as const) await logs().write(level, "test", level);
    expect(fake.tables.logs.map(r => r.level)).toEqual(["debug", "info", "warn", "error"]);
  });

  test("Fehler der Datenbank und Ausnahmen des Clients bleiben still", async () => {
    tables({ fail: ["logs"] });
    await expect(logs().write("error", "bot", "x")).resolves.toBeUndefined();
    await expect(supabaseLogs(throwingClient).write("error", "bot", "x")).resolves.toBeUndefined();
  });

  test("ohne Client schreibt nichts und wirft nicht", async () => {
    await expect(supabaseLogs(() => null).write("info", "bot", "x")).resolves.toBeUndefined();
  });
});

describe("logs.ping", () => {
  test("erreichbar mit Zeilen: ok", async () => {
    const fake = tables({ rows: { messages: [{ chat_id: "42", role: "user", content: "Hallo" }] } });
    const result = await logs().ping();
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Supabase-Verbindung steht.");
    const request = fake.requestsTo("messages")[0];
    expect(request.method).toBe("GET");
    expect(request.url.searchParams.get("select")).toBe("id");
    expect(request.url.searchParams.get("limit")).toBe("1");
  });

  test("erreichbar mit leerer Tabelle: ebenfalls ok", async () => {
    tables();
    expect(await logs().ping()).toEqual({ ok: true, message: "Supabase-Verbindung steht." });
  });

  test("Fehler der Datenbank: nicht ok, mit ihrer Meldung", async () => {
    tables({ fail: ["messages"] });
    const result = await logs().ping();
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Supabase antwortet mit Fehler: kaputt");
  });

  test("Ausnahme mitten in der Abfrage: nicht ok, wirft nicht", async () => {
    expect(await supabaseLogs(throwingClient).ping()).toEqual({ ok: false, message: "Supabase nicht erreichbar: Netz weg" });
  });

  test("ohne Client: nicht ok, mit Hinweis auf die fehlenden Variablen", async () => {
    expect(await supabaseLogs(() => null).ping()).toEqual({
      ok: false,
      message: "Supabase nicht eingerichtet (SUPABASE_URL oder SUPABASE_SERVICE_ROLE_KEY fehlt).",
    });
  });

  test("wirft der Client selbst, kommt trotzdem eine Antwort", async () => {
    const broken = () => {
      throw new Error("kaputter Client");
    };
    const result = await supabaseLogs(broken as never).ping();
    expect(result).toEqual({ ok: false, message: "Supabase nicht erreichbar: kaputter Client" });
  });
});
