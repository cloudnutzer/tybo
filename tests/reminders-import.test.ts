/**
 * Issue #323, Checkbox 3: einmaliger Import aus der alten
 * config/reminders.json (src/lib/schedule/legacy-import.ts) für beide
 * Adapter, mit synthetischen Einträgen. Belegt: nur ungesendete Einträge,
 * Ortszeit in USER_TIMEZONE (Sommer- und Winterzeit), ohne Uhrzeit 9 Uhr,
 * Ziel Direktchat, ungültige Einträge gemeldet; genau einmal bei
 * zweimaligem Import, nach Neustart (frische Ablage auf derselben Datei
 * bzw. Tabelle), nach Teilfehler, bei parallelen Aufrufen und nach einer
 * Absage. Dazu `tybo erinnerungen importieren` im Projektordner.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileScheduleStore } from "../src/lib/schedule/file";
import { importLegacyReminders, legacyTaskId, LEGACY_TEXT, parseLegacyFile } from "../src/lib/schedule/legacy-import";
import { listOpenReminders } from "../src/lib/schedule/overview";
import { FIXED_ID_PATTERN, scheduleFilePath, type ScheduleStore } from "../src/lib/schedule/store";
import { supabaseScheduleStore } from "../src/lib/schedule/supabase";
import { getSupabase } from "../src/lib/supabase";
import { runTybo } from "../scripts/tybo";
import { useTaskTables } from "./tasks-fixture";

// 18.10.2026 12:00 in Berlin (Sommerzeit bis 25.10.)
const NOW = Date.parse("2026-10-18T10:00:00.000Z");
const ZONE = "Europe/Berlin";
const USER = "4711";

/** Altdatei wie vom früheren Skript, mit allen Sonderfällen */
const LEGACY = [
  { id: 1, date: "2026-10-20", time: "14:30", message: "Zahnarzt anrufen", sent: false },
  { id: 2, date: "2026-10-01", time: "08:00", message: "Schon verschickt", sent: true, sent_at: "2026-10-01T08:00:03+02:00" },
  { id: 3, date: "2026-11-02", message: "Ohne Uhrzeit", sent: false },
  { id: 4, date: "2026-10-17", time: "09:15", message: "Verpasst", sent: false },
  { id: 5, date: "2026-10-22", time: "", message: "Leere Uhrzeit", sent: false },
  { id: 6, date: "2026-10-23", time: "10:00", message: "sent_at ohne sent", sent: false, sent_at: "2026-10-23T10:00:00+02:00" },
  { id: 7, date: "2026-02-31", time: "10:00", message: "Kein Tag", sent: false },
  { id: 8, date: "20.10.2026", time: "10:00", message: "Falsches Datum", sent: false },
  { id: 9, date: "2026-10-20", time: "25:00", message: "Falsche Uhrzeit", sent: false },
  { id: 10, date: "2026-10-20", time: "10:00", message: "  ", sent: false },
  { id: 11, date: "2026-10-20", time: "10:00", message: "Ohne sent" },
  "kein Objekt",
];

const ADAPTERS = [
  {
    name: "Datei",
    setup() {
      const dir = mkdtempSync(join(tmpdir(), "tybo-reminders-import-"));
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

let errSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  setSystemTime(new Date(NOW));
  errSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  setSystemTime();
  errSpy.mockRestore();
});

const options = { chatId: USER, timeZone: ZONE, now: NOW };

describe("Feste ID", () => {
  test("UUID-Form, gleich für gleiche Felder, verschieden sonst", () => {
    const a = legacyTaskId({ id: 1, date: "2026-10-20", time: "14:30", message: "Zahnarzt" });
    expect(a).toMatch(FIXED_ID_PATTERN);
    expect(legacyTaskId({ id: 1, date: "2026-10-20", time: "14:30", message: "Zahnarzt" })).toBe(a);
    expect(legacyTaskId({ id: 2, date: "2026-10-20", time: "14:30", message: "Zahnarzt" })).not.toBe(a);
    expect(legacyTaskId({ id: 1, date: "2026-10-20", time: "14:31", message: "Zahnarzt" })).not.toBe(a);
  });

  test("Datei: kein JSON, kein Array", () => {
    expect(() => parseLegacyFile("{kaputt")).toThrow(LEGACY_TEXT.unreadable);
    expect(() => parseLegacyFile('{"reminders": []}')).toThrow(LEGACY_TEXT.notArray);
    expect(parseLegacyFile("[]")).toEqual([]);
  });
});

for (const adapter of ADAPTERS) {
  describe(`Import (${adapter.name})`, () => {
    let open: () => ScheduleStore;
    let cleanup: () => void;
    beforeEach(() => {
      ({ open, cleanup } = adapter.setup());
    });
    afterEach(() => cleanup());

    test("nur ungesendete, Ortszeit, ohne Uhrzeit 9 Uhr, Direktchat, Ungültiges gemeldet", async () => {
      const store = open();
      const report = await importLegacyReminders(store, LEGACY, options);
      expect(report.added.map(a => [a.text, a.dueAt, a.overdue])).toEqual([
        ["Zahnarzt anrufen", "2026-10-20T12:30:00.000Z", false],
        // 2.11.: schon Winterzeit (+01:00)
        ["Ohne Uhrzeit", "2026-11-02T08:00:00.000Z", false],
        ["Verpasst", "2026-10-17T07:15:00.000Z", true],
        ["Leere Uhrzeit", "2026-10-22T07:00:00.000Z", false],
      ]);
      expect(report.sent).toBe(2);
      expect(report.existing).toBe(0);
      expect(report.failed).toBe(0);
      expect(report.invalid).toEqual([
        { position: 7, reason: LEGACY_TEXT.badDate },
        { position: 8, reason: LEGACY_TEXT.badDate },
        { position: 9, reason: LEGACY_TEXT.badTime },
        { position: 10, reason: LEGACY_TEXT.noText },
        { position: 11, reason: LEGACY_TEXT.badSent },
        { position: 12, reason: LEGACY_TEXT.notObject },
      ]);
      const tasks = await listOpenReminders(store);
      expect(tasks.map(t => t.text)).toEqual(["Verpasst", "Zahnarzt anrufen", "Leere Uhrzeit", "Ohne Uhrzeit"]);
      expect(tasks.every(t => t.chatId === USER && t.topicId === null && t.kind === "reminder" && t.status === "pending" && t.recurrence === null)).toBe(true);
    });

    test("genau einmal: zweiter Import, Neustart, nach Absage", async () => {
      const first = await importLegacyReminders(open(), LEGACY, options);
      expect(first.added.length).toBe(4);
      const again = await importLegacyReminders(open(), LEGACY, options);
      expect(again.added).toEqual([]);
      expect(again.existing).toBe(4);
      // Neustart: frische Ablage auf derselben Datei bzw. Tabelle
      const restarted = open();
      expect((await importLegacyReminders(restarted, LEGACY, options)).existing).toBe(4);
      const zahnarzt = (await listOpenReminders(restarted)).find(t => t.text === "Zahnarzt anrufen")!;
      expect(await restarted.cancel(zahnarzt.id)).toBe(true);
      const afterCancel = await importLegacyReminders(open(), LEGACY, options);
      expect(afterCancel.added).toEqual([]);
      expect((await restarted.byId(zahnarzt.id))?.status).toBe("cancelled");
      expect((await restarted.list()).length).toBe(4);
    });

    test("Teilfehler: was angelegt ist, bleibt einmal; die Wiederholung holt den Rest nach", async () => {
      const store = open();
      let calls = 0;
      const flaky: ScheduleStore = { ...store, addOnce: async (id, task) => (++calls === 2 ? "failed" : store.addOnce(id, task)) };
      const first = await importLegacyReminders(flaky, LEGACY, options);
      expect(first.added.length).toBe(3);
      expect(first.failed).toBe(1);
      const retry = await importLegacyReminders(open(), LEGACY, options);
      expect(retry.added.map(a => a.text)).toEqual(["Ohne Uhrzeit"]);
      expect(retry.existing).toBe(3);
      expect((await listOpenReminders(open())).length).toBe(4);
    });

    test("parallele Aufrufe: jeder Eintrag genau einmal", async () => {
      const reports = await Promise.all([importLegacyReminders(open(), LEGACY, options), importLegacyReminders(open(), LEGACY, options), importLegacyReminders(open(), LEGACY, options)]);
      expect(reports.reduce((n, r) => n + r.added.length, 0)).toBe(4);
      expect(reports.reduce((n, r) => n + r.existing, 0)).toBe(8);
      const texts = (await listOpenReminders(open())).map(t => t.text).sort();
      expect(texts).toEqual(["Leere Uhrzeit", "Ohne Uhrzeit", "Verpasst", "Zahnarzt anrufen"]);
    });

    test("addOnce: gleiche ID zweimal gleichzeitig, ungültige ID", async () => {
      const store = open();
      const id = legacyTaskId({ id: 1, date: "2026-10-20", time: "14:30", message: "x" });
      const task = { chatId: USER, text: "x", dueAt: new Date(NOW + 3_600_000) };
      expect((await Promise.all([store.addOnce(id, task), store.addOnce(id, task)])).sort()).toEqual(["added", "exists"]);
      expect(await store.addOnce("nicht-uuid", task)).toBe("failed");
      expect(await store.addOnce(id.toUpperCase(), task)).toBe("failed");
      expect(await store.addOnce(legacyTaskId({ date: "a", time: "", message: "b" }), { ...task, text: " " })).toBe("failed");
      expect((await store.list()).length).toBe(1);
    });
  });
}

describe("tybo erinnerungen importieren", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tybo-reminders-cli-"));
    mkdirSync(join(root, "config"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const env = { USER_TIMEZONE: ZONE, TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_USER_ID: USER };
  async function run(args: string[], extraEnv: Record<string, string> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runTybo({ args, env: { ...env, ...extraEnv }, root, out: l => void out.push(l), err: l => void err.push(l) });
    return { code, out, err };
  }

  test("Standarddatei im Projektordner, zweimal: beim zweiten Mal nichts neu", async () => {
    writeFileSync(join(root, "config", "reminders.json"), JSON.stringify(LEGACY));
    const first = await run(["erinnerungen", "importieren"]);
    expect(first.code).toBe(0);
    expect(first.out[0]).toBe("Ablage: data/reminders.json, Zeitzone Europe/Berlin");
    expect(first.out).toContain("  neu: 20.10. 14:30 · Zahnarzt anrufen");
    expect(first.out).toContain("  neu: 17.10. 09:15 · Verpasst (überfällig, kommt gleich nach dem Start des Bots)");
    expect(first.out).toContain("  nicht übernommen: Eintrag 7 (Datum fehlt oder ist nicht JJJJ-MM-TT)");
    expect(first.out.at(-1)).toBe("Neu: 4 · schon übernommen: 0 · schon zugestellt: 2 · ungültig: 6 · fehlgeschlagen: 0");
    const second = await run(["erinnerungen", "importieren"]);
    expect(second.code).toBe(0);
    expect(second.out.at(-1)).toBe("Neu: 0 · schon übernommen: 4 · schon zugestellt: 2 · ungültig: 6 · fehlgeschlagen: 0");
    const tasks = await listOpenReminders(fileScheduleStore(() => scheduleFilePath({ GO_PROJECT_ROOT: root })));
    expect(tasks.length).toBe(4);
    expect(tasks.every(t => t.chatId === USER)).toBe(true);
  });

  test("ohne Telegram in den Web-Direktchat; eigene Datei relativ zum Projektordner", async () => {
    writeFileSync(join(root, "alt.json"), JSON.stringify([{ id: "a", date: "2026-10-20", time: "10:00", message: "Web", sent: false }]));
    const res = await run(["erinnerungen", "importieren", "alt.json"], { TELEGRAM_BOT_TOKEN: "", TELEGRAM_USER_ID: "" });
    expect(res.code).toBe(0);
    const tasks = await listOpenReminders(fileScheduleStore(() => scheduleFilePath({ GO_PROJECT_ROOT: root })));
    expect(tasks.map(t => [t.chatId, t.text])).toEqual([["web", "Web"]]);
  });

  test("fehlende oder kaputte Datei: Exit 1, nichts angelegt; falscher Aufruf: Exit 2; Hilfe", async () => {
    const missing = await run(["erinnerungen", "importieren"]);
    expect(missing.code).toBe(1);
    expect(missing.err[0]).toStartWith("Datei nicht gefunden: ");
    writeFileSync(join(root, "config", "reminders.json"), "{}");
    const broken = await run(["erinnerungen", "importieren"]);
    expect(broken.code).toBe(1);
    expect(broken.err[0]).toEndWith(LEGACY_TEXT.notArray);
    expect((await run(["erinnerungen", "loeschen"])).code).toBe(2);
    expect((await run(["erinnerungen", "importieren", "a", "b"])).code).toBe(2);
    const help = await run(["erinnerungen"]);
    expect(help.code).toBe(0);
    expect(help.out.join("\n")).toContain("importieren [Datei]");
  });
});
