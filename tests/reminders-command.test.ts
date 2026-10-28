/**
 * Issue #323, Checkbox 1: /erinnerungen (Alias /reminders) in Telegram,
 * Browser und Terminal über die gemeinsame Befehls-Schicht, auch ohne
 * Telegram (Direktchat "web"). Belegt: dieselbe Liste in allen Kanälen
 * (alle Gespräche, nur offene der Art reminder, Kennung, Ort, Wiederholung,
 * Zustand), Absagen mit der Kennung wirkt in allen Kanälen, nie ein falscher
 * Erfolg (laufender Versand, schon abgesagt, erledigt, fehlgeschlagen,
 * mehrdeutig, unbekannt), Serien werden ganz abgesagt, zwei gleichzeitige
 * Absagen wirken einmal, ein Knopf an einer früher zugestellten Erinnerung
 * verschiebt danach nichts mehr. Beide Adapter der Ablage, feste Uhr.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandRegistry, HELP_TEXT } from "../src/lib/commands/builtin";
import { runTelegramCommand } from "../src/lib/commands/telegram";
import type { CommandServices } from "../src/lib/commands/types";
import type { Choice } from "../src/lib/choices";
import { createReminderChoices, occurrenceAction, REMINDER_CHOICE_TEXT } from "../src/lib/reminder-choices";
import { fileScheduleStore } from "../src/lib/schedule/file";
import {
  cancelReminder,
  formatReminderList,
  listOpenReminders,
  parseReminderRef,
  recurrenceText,
  reminderPlace,
  reminderRef,
  REMINDERS_TEXT,
} from "../src/lib/schedule/overview";
import { webOnlyChatId } from "../src/lib/schedule/remind";
import type { ScheduledTask, ScheduleStore } from "../src/lib/schedule/store";
import { supabaseScheduleStore } from "../src/lib/schedule/supabase";
import { getSupabase } from "../src/lib/supabase";
import { createBotCommands } from "../src/web/bot-commands";
import { asRow, bulkTasks, writeFileSeed } from "./reminders-seed";
import { useTaskTables } from "./tasks-fixture";

const NOW = Date.parse("2026-10-18T10:00:00.000Z");
const HOUR = 3_600_000;
const USER = "4711";
const GROUP = "-1001234567890";
const WEB_ID = "0c1a2b3c-0000-4000-8000-000000000000";

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
      const dir = mkdtempSync(join(tmpdir(), "tybo-reminders-cmd-"));
      const path = join(dir, "data", "reminders.json");
      if (o.broken) writeFileSync(join(dir, "data"), "keine Ablage");
      if (o.seed) writeFileSeed(path, o.seed);
      return { store: fileScheduleStore(() => path), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    },
  },
  {
    name: "Supabase",
    setup(o: AdapterOptions = {}) {
      const tables = useTaskTables({ rows: { scheduled_tasks: (o.seed ?? []).map(asRow) }, ...(o.broken ? { fail: ["scheduled_tasks"] } : {}) });
      return { store: supabaseScheduleStore(getSupabase), cleanup: () => tables.restore() };
    },
  },
];

async function telegram(text: string, services: Partial<CommandServices>, where: { chatId: string; topicId?: number } = { chatId: USER }): Promise<string[]> {
  const sent: string[] = [];
  await runTelegramCommand({
    chat: { reply: async t => void sent.push(t) },
    chatId: where.chatId,
    ...(where.topicId !== undefined ? { topicId: where.topicId } : {}),
    sessionKey: where.topicId !== undefined ? `topic:${where.chatId}:${where.topicId}` : `dm:${where.chatId}`,
    agent: "general",
    text,
    match: commandRegistry.match(text, "telegram")!,
    services: services as CommandServices,
    working: () => () => {},
    resetSession: async () => ({ status: "unavailable" }),
    agentTurn: async () => {},
    boardMeeting: async () => {},
  });
  return sent;
}

/** Browser bzw. Terminal; conversationId "dm" ist ohne Telegram der Direktchat "web" */
async function webOrTerminal(source: "web" | "terminal", text: string, services: Partial<CommandServices>, conversationId = WEB_ID): Promise<string[]> {
  const unused = () => {
    throw new Error("nicht erwartet");
  };
  const commands = createBotCommands({
    registry: commandRegistry,
    services: services as CommandServices,
    // Ohne Telegram ist der Direktchat "web" (Issue #227)
    userId: "web",
    groupId: () => null,
    agentForTopic: () => undefined,
    sendPlain: unused,
    sendAndRecord: unused,
    saveMessage: async () => true,
    resetConversation: unused,
    runStreamingTurn: unused,
    processIntents: unused,
    sendAsAgent: unused,
    log: () => {},
  });
  const notices: string[] = [];
  await commands.run({
    conversationId,
    agent: "general",
    text,
    source,
    messageId: "m1",
    receivedAt: new Date().toISOString(),
    signal: new AbortController().signal,
    sink: {} as any,
    notice: async t => void notices.push(t),
    answer: async () => {},
    ask: async () => {},
    endAsk: () => {},
    commit: () => {},
  });
  return notices;
}

let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
let savedZone: string | undefined;
beforeEach(() => {
  setSystemTime(new Date(NOW));
  savedZone = process.env.USER_TIMEZONE;
  process.env.USER_TIMEZONE = "Europe/Berlin";
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  setSystemTime();
  if (savedZone === undefined) delete process.env.USER_TIMEZONE;
  else process.env.USER_TIMEZONE = savedZone;
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe("/erinnerungen im Register", () => {
  test("alle drei Kanäle, Alias /reminders, mit und ohne Argumente", () => {
    for (const channel of ["telegram", "web", "terminal"] as const) {
      expect(commandRegistry.match("/erinnerungen", channel)?.command.name).toBe("erinnerungen");
      expect(commandRegistry.match("/reminders", channel)?.command.name).toBe("erinnerungen");
      expect(commandRegistry.match("/erinnerungen absagen 3f2a9c1e", channel)?.args).toBe("absagen 3f2a9c1e");
    }
    expect(commandRegistry.list("web").find(c => c.name === "erinnerungen")).toMatchObject({ args: "optional", argsHint: "[absagen <kennung>]" });
  });

  test("/help nennt /erinnerungen", () => {
    expect(HELP_TEXT).toContain("\n/erinnerungen - offene Erinnerungen aller Gespraeche · /erinnerungen absagen <kennung>\n");
  });
});

describe("Bausteine", () => {
  test("Kennung, Eingabe der Kennung, Wiederholung in Worten", () => {
    expect(reminderRef("3F2A9C1E-5b7d-4e8f-9a0b-1c2d3e4f5a6b")).toBe("3f2a9c1e");
    expect(parseReminderRef("#3F2A9C1E")).toBe("3f2a9c1e");
    expect(parseReminderRef("3f2")).toBeNull();
    expect(parseReminderRef("3f2a 9c")).toBeNull();
    expect(recurrenceText("daily 08:05")).toBe("täglich 08:05");
    expect(recurrenceText("weekdays 07:30")).toBe("werktags 07:30");
    expect(recurrenceText("weekly mon 09:00")).toBe("jeden Montag 09:00");
    expect(recurrenceText("every 1h")).toBe("jede Stunde");
    expect(recurrenceText("every 3h")).toBe("alle 3 Stunden");
    expect(recurrenceText(null)).toBeNull();
  });

  test("Ort: Direktchat (mit und ohne Telegram), General, Topic, Web-Gespräch, nur WebUI", () => {
    expect(reminderPlace({ chatId: USER, topicId: null })).toBe("Direktchat");
    expect(reminderPlace({ chatId: "web", topicId: null })).toBe("Direktchat");
    expect(reminderPlace({ chatId: GROUP, topicId: null })).toBe("General");
    expect(reminderPlace({ chatId: GROUP, topicId: 1 })).toBe("General");
    expect(reminderPlace({ chatId: GROUP, topicId: 7 }, { "7": "Reisen" })).toBe("Topic Reisen");
    expect(reminderPlace({ chatId: GROUP, topicId: 8 })).toBe("Topic 8");
    expect(reminderPlace({ chatId: `web:${WEB_ID}`, topicId: null })).toBe("Web-Gespräch");
    expect(reminderPlace({ chatId: webOnlyChatId(GROUP), topicId: 7 }, { "7": "Reisen" })).toBe("Topic Reisen (nur WebUI)");
  });
});

for (const adapter of ADAPTERS) {
  describe(`/erinnerungen (${adapter.name})`, () => {
    let store: ScheduleStore;
    let cleanup: () => void;
    let services: Partial<CommandServices>;

    beforeEach(() => {
      ({ store, cleanup } = adapter.setup());
      services = { reminders: () => store, topicNames: async () => ({ "7": "Reisen" }) };
    });
    afterEach(() => cleanup());

    async function add(text: string, offset: number, over: Partial<Parameters<ScheduleStore["add"]>[0]> = {}): Promise<ScheduledTask> {
      const task = await store.add({ chatId: USER, text, dueAt: new Date(NOW + offset), ...over });
      expect(task).not.toBeNull();
      return task!;
    }

    test("leer: in allen Kanälen derselbe Hinweis", async () => {
      expect(await telegram("/erinnerungen", services)).toEqual([REMINDERS_TEXT.none]);
      expect(await webOrTerminal("web", "/erinnerungen", services)).toEqual([REMINDERS_TEXT.none]);
      expect(await webOrTerminal("terminal", "/reminders", services)).toEqual([REMINDERS_TEXT.none]);
    });

    test("dieselbe Liste in Telegram, Browser, Terminal und ohne Telegram; nur offene Erinnerungen", async () => {
      const zahnarzt = await add("Zahnarzt anrufen", 2 * HOUR);
      const serie = await add("Tabletten", 22 * HOUR, { chatId: GROUP, topicId: 7, recurrence: "daily 08:05" });
      const web = await add("Paket abholen", -HOUR, { chatId: `web:${WEB_ID}` });
      const nurWeb = await add("Ohne Telegram angelegt", 3 * HOUR, { chatId: "web" });
      const laufend = await add("Wird gerade verschickt", -2 * HOUR);
      await store.update(laufend.id, { status: "running" });
      const erledigt = await add("Schon erledigt", -3 * HOUR);
      await store.update(erledigt.id, { status: "done" });
      const abgesagt = await add("Abgesagt", HOUR);
      await store.cancel(abgesagt.id);
      const fehler = await add("Fehlgeschlagen", -4 * HOUR);
      await store.update(fehler.id, { status: "failed" });
      await add("Ein Auftrag", HOUR, { kind: "action" });

      const expected = [
        [
          "Offene Erinnerungen (5):",
          "",
          `• 18.10. 10:00 · Wird gerade verschickt\n   Kennung ${reminderRef(laufend.id)} · Direktchat · wird gerade zugestellt`,
          "",
          `• 18.10. 11:00 · Paket abholen\n   Kennung ${reminderRef(web.id)} · Web-Gespräch · überfällig`,
          "",
          `• 18.10. 14:00 · Zahnarzt anrufen\n   Kennung ${reminderRef(zahnarzt.id)} · Direktchat`,
          "",
          `• 18.10. 15:00 · Ohne Telegram angelegt\n   Kennung ${reminderRef(nurWeb.id)} · Direktchat`,
          "",
          `• 19.10. 10:00 · Tabletten\n   Kennung ${reminderRef(serie.id)} · Topic Reisen · täglich 08:05`,
          "",
          REMINDERS_TEXT.cancelHint,
        ].join("\n"),
      ];
      const tg = await telegram("/erinnerungen", services);
      expect(tg).toEqual(expected);
      expect(await telegram("/reminders", services, { chatId: GROUP, topicId: 7 })).toEqual(expected);
      expect(await webOrTerminal("web", "/erinnerungen", services)).toEqual(expected);
      expect(await webOrTerminal("web", "/erinnerungen", services, "dm")).toEqual(expected);
      expect(await webOrTerminal("terminal", "/erinnerungen", services)).toEqual(expected);
      expect((await listOpenReminders(store))!.map(t => t.id)).toEqual([laufend.id, web.id, zahnarzt.id, nurWeb.id, serie.id]);
    });

    test("Absagen in Telegram wirkt im Browser, Absagen im Terminal wirkt in Telegram", async () => {
      const a = await add("Zahnarzt anrufen", 2 * HOUR);
      const b = await add("Müll rausbringen", 3 * HOUR, { chatId: "web" });
      expect(await telegram(`/erinnerungen absagen ${reminderRef(a.id)}`, services)).toEqual([REMINDERS_TEXT.cancelled("Zahnarzt anrufen")]);
      const web = (await webOrTerminal("web", "/erinnerungen", services))[0];
      expect(web).not.toContain("Zahnarzt");
      expect(web).toContain("Müll rausbringen");
      expect(await webOrTerminal("terminal", `/erinnerungen absagen #${reminderRef(b.id).toUpperCase()}`, services, "dm")).toEqual([REMINDERS_TEXT.cancelled("Müll rausbringen")]);
      expect(await telegram("/erinnerungen", services)).toEqual([REMINDERS_TEXT.none]);
      expect((await store.byId(a.id))?.status).toBe("cancelled");
      expect((await store.byId(b.id))?.status).toBe("cancelled");
    });

    test("Serie: ganz abgesagt, kein weiterer Termin", async () => {
      const serie = await add("Tabletten", HOUR, { recurrence: "daily 08:05" });
      expect(await webOrTerminal("web", `/erinnerungen absagen ${reminderRef(serie.id)}`, services)).toEqual([REMINDERS_TEXT.cancelledSeries("Tabletten", "täglich 08:05")]);
      expect((await store.byId(serie.id))?.status).toBe("cancelled");
      expect(await store.due(new Date(NOW + 10 * 24 * HOUR), 10)).toEqual([]);
    });

    test("kein falscher Erfolg: laufend, schon abgesagt, erledigt, fehlgeschlagen, unbekannt, ungültig", async () => {
      const laufend = await add("Wird verschickt", -HOUR);
      await store.update(laufend.id, { status: "running", leaseOwner: "planer", leaseUntil: new Date(NOW + HOUR) });
      expect(await telegram(`/erinnerungen absagen ${reminderRef(laufend.id)}`, services)).toEqual([REMINDERS_TEXT.sending("Wird verschickt")]);
      expect((await store.byId(laufend.id))?.status).toBe("running");

      const weg = await add("Schon weg", HOUR);
      await store.cancel(weg.id);
      expect(await telegram(`/erinnerungen absagen ${reminderRef(weg.id)}`, services)).toEqual([REMINDERS_TEXT.alreadyCancelled("Schon weg")]);

      const erledigt = await add("Erledigt", -HOUR);
      await store.update(erledigt.id, { status: "done" });
      expect(await telegram(`/erinnerungen absagen ${reminderRef(erledigt.id)}`, services)).toEqual([REMINDERS_TEXT.alreadyDone("Erledigt")]);
      expect((await store.byId(erledigt.id))?.status).toBe("done");

      const fehler = await add("Kaputt", -HOUR);
      await store.update(fehler.id, { status: "failed" });
      expect(await telegram(`/erinnerungen absagen ${reminderRef(fehler.id)}`, services)).toEqual([REMINDERS_TEXT.alreadyFailed("Kaputt")]);

      expect(await telegram("/erinnerungen absagen ffffffff", services)).toEqual([REMINDERS_TEXT.unknown("ffffffff")]);
      expect(await telegram("/erinnerungen absagen x!", services)).toEqual([REMINDERS_TEXT.unknown("x!")]);
      expect(await telegram("/erinnerungen quatsch", services)).toEqual([REMINDERS_TEXT.usage]);
    });

    test("übernimmt der Planer zwischen Lesen und Absagen, meldet die Absage das", async () => {
      const task = await add("Knapp", -HOUR);
      const racing: ScheduleStore = {
        ...store,
        cancel: async id => {
          // Der Planer war schneller
          await store.updateIf(id, { status: "pending" }, { status: "running", leaseOwner: "planer", leaseUntil: new Date(NOW + HOUR) });
          return store.cancel(id);
        },
      };
      expect(await cancelReminder(racing, reminderRef(task.id))).toMatchObject({ status: "sending" });
      expect((await store.byId(task.id))?.status).toBe("running");
    });

    test("zwei gleichzeitige Absagen: genau eine wirkt", async () => {
      const task = await add("Doppelt", HOUR);
      const ref = reminderRef(task.id);
      const outcomes = await Promise.all([cancelReminder(store, ref), cancelReminder(store, ref)]);
      expect(outcomes.map(o => o.status).sort()).toEqual(["already-cancelled", "cancelled"]);
    });

    test("Knopf an einer früher zugestellten Erinnerung verschiebt nach der Absage nichts", async () => {
      const serie = await add("Tabletten", HOUR, { recurrence: "daily 08:05" });
      expect((await cancelReminder(store, reminderRef(serie.id))).status).toBe("cancelled");
      const said: string[] = [];
      const { handler } = createReminderChoices({ store: () => store, now: () => NOW, timeZone: () => "Europe/Berlin", notify: async (_c, t) => void said.push(t), log: () => {} });
      const choice = {
        id: "c1",
        kind: "reminder",
        conversation: { type: "telegram", chatId: USER },
        ref: serie.id,
        action: occurrenceAction(serie.dueAt),
        result: { key: "hour", via: "telegram" },
      } as unknown as Choice;
      await handler(choice);
      expect(said).toEqual([REMINDER_CHOICE_TEXT.gone]);
      expect((await store.list()).length).toBe(1);
    });

    test("Knopf und Absage gleichzeitig, Absage zwischen Lesen und Kopie: keine Kopie, keine falsche Antwort", async () => {
      const serie = await add("Tabletten", HOUR, { recurrence: "daily 08:05" });
      const said: string[] = [];
      let cancel: Promise<unknown> | null = null;
      const racing: ScheduleStore = {
        ...store,
        add: async input => {
          // /erinnerungen absagen kommt genau zwischen dem Lesen der Serie und dem Anlegen der Kopie
          cancel = telegram(`/erinnerungen absagen ${reminderRef(serie.id)}`, services);
          await cancel;
          return store.add(input);
        },
      };
      const { handler } = createReminderChoices({ store: () => racing, now: () => NOW, timeZone: () => "Europe/Berlin", notify: async (_c, t) => void said.push(t), log: () => {} });
      await handler(buttonChoice(serie));
      expect(await cancel).toEqual([REMINDERS_TEXT.cancelledSeries("Tabletten", "täglich 08:05")]);
      expect(said).toEqual([REMINDER_CHOICE_TEXT.gone]);
      expect((await store.byId(serie.id))?.status).toBe("cancelled");
      expect(await listOpenReminders(store)).toEqual([]);
      expect(await store.due(new Date(NOW + 10 * 24 * HOUR), 10)).toEqual([]);
    });

    test("Knopf und Absage gleichzeitig, Absage zwischen Kopie und Prüfung: Kopie zurückgenommen", async () => {
      const serie = await add("Tabletten", HOUR, { recurrence: "daily 08:05" });
      const said: string[] = [];
      const racing: ScheduleStore = {
        ...store,
        add: async input => {
          const copy = await store.add(input);
          expect((await cancelReminder(store, reminderRef(serie.id))).status).toBe("cancelled");
          return copy;
        },
      };
      const { handler } = createReminderChoices({ store: () => racing, now: () => NOW, timeZone: () => "Europe/Berlin", notify: async (_c, t) => void said.push(t), log: () => {} });
      await handler(buttonChoice(serie));
      expect(said).toEqual([REMINDER_CHOICE_TEXT.gone]);
      expect(await listOpenReminders(store)).toEqual([]);
      const all = await store.list();
      expect(all.map(t => t.status).sort()).toEqual(["cancelled", "cancelled"]);
    });

    test("Knopf ohne Absage: Kopie bleibt, die Serie läuft weiter", async () => {
      const serie = await add("Tabletten", HOUR, { recurrence: "daily 08:05" });
      const said: string[] = [];
      const { handler } = createReminderChoices({ store: () => store, now: () => NOW, timeZone: () => "Europe/Berlin", notify: async (_c, t) => void said.push(t), log: () => {} });
      await handler(buttonChoice(serie));
      expect(said).toEqual([REMINDER_CHOICE_TEXT.copied("18.10. 13:00")]);
      expect((await listOpenReminders(store))!.map(t => t.status)).toEqual(["pending", "pending"]);
    });

    test("Serie nach dem Kopieren nicht lesbar: Kopie zurückgenommen, Fehler statt „läuft weiter\"", async () => {
      const serie = await add("Tabletten", HOUR, { recurrence: "daily 08:05" });
      const said: string[] = [];
      const blind: ScheduleStore = { ...store, listAll: async () => null };
      const { handler } = createReminderChoices({ store: () => blind, now: () => NOW, timeZone: () => "Europe/Berlin", notify: async (_c, t) => void said.push(t), log: () => {} });
      await expect(handler(buttonChoice(serie))).rejects.toThrow();
      expect(said).toEqual([REMINDER_CHOICE_TEXT.failed]);
      expect((await listOpenReminders(store))!.map(t => t.id)).toEqual([serie.id]);
    });

    test("mehr als 1000 erledigte und mehr als 1000 offene: vollständige Liste, Absage mit Kennung und voller ID", async () => {
      cleanup();
      const history = bulkTasks(1100, { start: NOW - 30 * 24 * HOUR, status: "done", chatId: USER, text: "Alt" });
      const open = bulkTasks(1050, { start: NOW + HOUR, status: "pending", chatId: USER, text: "Offen" });
      ({ store, cleanup } = adapter.setup({ seed: [...history, ...open] }));
      const listed = await listOpenReminders(store);
      expect(listed!.length).toBe(1050);
      expect(new Set(listed!.map(t => t.id)).size).toBe(1050);
      expect((await telegram("/erinnerungen", services))[0].split("\n")[0]).toBe(REMINDERS_TEXT.heading(1050));
      // Die neueste offene steht hinter allen alten; Kennung und volle ID finden sie
      const last = open[open.length - 1];
      expect(await telegram(`/erinnerungen absagen ${reminderRef(last.id)}`, services)).toEqual([REMINDERS_TEXT.cancelled(last.text)]);
      const other = open[open.length - 2];
      expect(await webOrTerminal("terminal", `/erinnerungen absagen ${other.id}`, services)).toEqual([REMINDERS_TEXT.cancelled(other.text)]);
      expect(await telegram(`/erinnerungen absagen ${reminderRef(history[0].id)}`, services)).toEqual([REMINDERS_TEXT.alreadyDone(history[0].text)]);
      expect((await listOpenReminders(store))!.length).toBe(1048);
    });

    test("Ablage nicht lesbar: kein „keine offenen\", keine Absage", async () => {
      cleanup();
      ({ store, cleanup } = adapter.setup({ broken: true }));
      expect(await listOpenReminders(store)).toBeNull();
      expect(await telegram("/erinnerungen", services)).toEqual([REMINDERS_TEXT.unreadable]);
      expect(await webOrTerminal("web", "/erinnerungen", services)).toEqual([REMINDERS_TEXT.unreadable]);
      expect(await webOrTerminal("terminal", "/erinnerungen", services)).toEqual([REMINDERS_TEXT.unreadable]);
      expect(await telegram("/erinnerungen absagen abcd1234", services)).toEqual([REMINDERS_TEXT.unreadableCancel]);
      expect(await cancelReminder(store, "abcd1234")).toEqual({ status: "unreadable" });
    });
  });
}

function buttonChoice(task: ScheduledTask): Choice {
  return {
    id: "c1",
    kind: "reminder",
    conversation: { type: "telegram", chatId: USER },
    ref: task.id,
    action: occurrenceAction(task.dueAt),
    result: { key: "hour", via: "telegram" },
  } as unknown as Choice;
}

describe("Supabase: kleinere max_rows", () => {
  test("listAll liest weiter, bis eine leere Seite kommt", async () => {
    const seed = bulkTasks(620, { start: NOW, status: "pending", chatId: USER, text: "Offen" });
    const tables = useTaskTables({ rows: { scheduled_tasks: seed.map(asRow) }, maxRows: 250 });
    try {
      const store = supabaseScheduleStore(getSupabase);
      expect((await store.list()).length).toBe(250);
      const all = await store.listAll();
      expect(all!.map(t => t.id)).toEqual(seed.map(t => t.id));
    } finally {
      tables.restore();
    }
  });
});

describe("Supabase: Bestand ändert sich zwischen zwei Seiten", () => {
  // 1001 offene: die Liste braucht zwei Seiten zu je höchstens 1000 Zeilen
  const seed = () => bulkTasks(1001, { start: NOW + HOUR, status: "pending", chatId: USER, text: "Offen" });

  test("Serie nach Seite 1 fortgeschrieben: jeder Eintrag genau einmal, keiner fehlt", async () => {
    const tasks = seed();
    const serie = tasks[0];
    const tables = useTaskTables({
      rows: { scheduled_tasks: tasks.map(t => asRow(t.id === serie.id ? { ...t, recurrence: "daily 08:05" } : t)) },
      afterRead: (table, n, rows) => {
        // Der Planer schreibt die Serie fort: der früheste Termin rückt hinter alle anderen
        if (table === "scheduled_tasks" && n === 1) rows.find(r => r.id === serie.id)!.due_at = new Date(NOW + 400 * 24 * HOUR).toISOString();
      },
    });
    try {
      const listed = (await listOpenReminders(supabaseScheduleStore(getSupabase)))!;
      expect(listed.length).toBe(1001);
      expect(new Set(listed.map(t => t.id))).toEqual(new Set(tasks.map(t => t.id)));
    } finally {
      tables.restore();
    }
  });

  test("Zustellung zwischen den Seiten: kein weiterhin offener Eintrag fehlt", async () => {
    const tasks = seed();
    const sent = tasks[0];
    const tables = useTaskTables({
      rows: { scheduled_tasks: tasks.map(asRow) },
      afterRead: (table, n, rows) => {
        if (table === "scheduled_tasks" && n === 1) rows.find(r => r.id === sent.id)!.status = "done";
      },
    });
    try {
      const listed = (await listOpenReminders(supabaseScheduleStore(getSupabase)))!;
      const ids = listed.map(t => t.id);
      expect(new Set(ids).size).toBe(ids.length);
      // Der zugestellte darf fehlen (oder stehen, wenn er schon gelesen war), alle anderen müssen da sein
      const stillOpen = tasks.filter(t => t.id !== sent.id).map(t => t.id);
      expect(stillOpen.filter(id => !ids.includes(id))).toEqual([]);
      expect(ids.filter(id => id !== sent.id).length).toBe(1000);
    } finally {
      tables.restore();
    }
  });
});

describe("Mehrdeutige Kennung", () => {
  const task = (id: string, status: ScheduledTask["status"]): ScheduledTask => ({
    id,
    chatId: USER,
    topicId: null,
    kind: "reminder",
    text: `Text ${id}`,
    dueAt: new Date(NOW + HOUR).toISOString(),
    recurrence: null,
    status,
    attempts: 0,
    lastError: null,
    leaseOwner: null,
    leaseUntil: null,
    sendStartedAt: null,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  });
  const fake = (tasks: ScheduledTask[], cancelled: string[] = []): ScheduleStore =>
    ({
      list: async () => tasks,
      listAll: async () => tasks,
      byId: async (id: string) => tasks.find(t => t.id === id) ?? null,
      cancel: async (id: string) => {
        cancelled.push(id);
        return true;
      },
    }) as unknown as ScheduleStore;

  test("zwei offene mit demselben Anfang: nichts abgesagt", async () => {
    const cancelled: string[] = [];
    const store = fake([task("abcd1111", "pending"), task("abcd2222", "pending")], cancelled);
    expect(await cancelReminder(store, "abcd")).toEqual({ status: "ambiguous" });
    expect(cancelled).toEqual([]);
    expect((await cancelReminder(store, "abcd2")).status).toBe("cancelled");
    expect(cancelled).toEqual(["abcd2222"]);
  });

  test("ein offener und ein erledigter mit demselben Anfang: der offene", async () => {
    const cancelled: string[] = [];
    const store = fake([task("abcd1111", "done"), task("abcd2222", "pending")], cancelled);
    expect((await cancelReminder(store, "abcd")).status).toBe("cancelled");
    expect(cancelled).toEqual(["abcd2222"]);
  });

  test("Liste ohne bekannten Topic-Namen nennt die Nummer", () => {
    const text = formatReminderList([{ ...task("abcd1111", "pending"), chatId: GROUP, topicId: 9 }], { now: NOW, timeZone: "Europe/Berlin" });
    expect(text).toContain("Topic 9");
  });
});
