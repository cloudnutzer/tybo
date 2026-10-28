import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  closeThreads,
  createThread,
  findThread,
  listRecentlyClosedThreads,
  isCalendarDate,
  listAllThreads,
  listOpenThreads,
  setThreadsFileForTests,
  THREADS_CLOSED_KEEP_MS,
  THREADS_OPEN_MAX,
  type Thread,
} from "../src/lib/threads/store";

// Ablage der offenen Fäden (Issue #290): eigene Datei je Test im Temp-Verzeichnis.

let dir: string;
let file: string;
let logSpy: ReturnType<typeof spyOn>;
const web = (conversationId: string) => ({ type: "web" as const, conversationId });
const topic = (topicId?: number) => ({ type: "telegram" as const, chatId: "-1001", ...(topicId !== undefined ? { topicId } : {}) });
const input = (question: string, conversation: any = web("w1")) => ({ conversation, topic: "Reiseziel", context: "Hamburg oder München.", question });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-threads-"));
  file = join(dir, "threads.json");
  setThreadsFileForTests(file);
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  setThreadsFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("Ablage offener Fäden", () => {
  test("Anlegen: alle Felder, offen, ohne Erinnerung, mit Frist", async () => {
    const r = await createThread({ ...input("Hamburg oder München?"), deadline: "2026-10-16" });
    expect(r.status).toBe("created");
    if (r.status !== "created") return;
    expect(r.thread).toMatchObject({
      conversation: web("w1"),
      topic: "Reiseziel",
      context: "Hamburg oder München.",
      question: "Hamburg oder München?",
      deadline: "2026-10-16",
      state: "open",
      reminders: 0,
    });
    expect(r.thread.id).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(await listOpenThreads()).toEqual([r.thread]);
    const saved = JSON.parse(readFileSync(file, "utf-8"));
    expect(saved.version).toBe(1);
    expect(saved.threads[r.thread.id].question).toBe("Hamburg oder München?");
  });

  test("ungültige Eingaben werfen", async () => {
    await expect(createThread({ ...input("Frage?"), deadline: "2026-02-30" })).rejects.toThrow("ungültige Frist");
    await expect(createThread(input("   "))).rejects.toThrow("leeres Feld");
    await expect(createThread(input("Frage?", { type: "web", conversationId: "" }))).rejects.toThrow("ungültiges Gespräch");
  });

  test("Kalenderdatum", () => {
    expect(isCalendarDate("2026-10-16")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2026-02-29")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("16.10.2026")).toBe(false);
    expect(isCalendarDate(null)).toBe(false);
  });

  test("gleiche Frage im selben Gespräch nur einmal, in anderem Gespräch eigener Faden", async () => {
    const a = await createThread(input("Hamburg oder München?"));
    const b = await createThread(input("  hamburg oder  München ? "));
    expect(b.status).toBe("duplicate");
    expect(b.thread.id).toBe(a.thread.id);
    expect((await createThread(input("Hamburg oder München?", web("w2")))).status).toBe("created");
    expect((await createThread(input("Hamburg oder München?", topic(7)))).status).toBe("created");
    // Telegram-Chat ohne Topic ist ein anderes Gespräch als mit Topic
    expect((await createThread(input("Hamburg oder München?", topic()))).status).toBe("created");
    expect((await listOpenThreads()).length).toBe(4);
    expect((await listOpenThreads(topic(7))).length).toBe(1);
    expect((await listOpenThreads(web("w1"))).map(t => t.id)).toEqual([a.thread.id]);
  });

  test("neueste zuerst", async () => {
    const a = await createThread(input("Erste?"));
    await Bun.sleep(3);
    const b = await createThread(input("Zweite?"));
    expect((await listOpenThreads()).map(t => t.id)).toEqual([b.thread.id, a.thread.id]);
  });

  test(`Obergrenze ${THREADS_OPEN_MAX}: der 201. Faden schließt den ältesten offenen`, async () => {
    const threads: Record<string, Thread> = {};
    for (let i = 0; i < THREADS_OPEN_MAX; i++) {
      const id = `T${String(i).padStart(4, "0")}`;
      threads[id] = { id, conversation: web("w1"), topic: "t", context: "c", question: `Frage ${i}?`, createdAt: 1_000 + i, state: "open", reminders: 0 };
    }
    writeFileSync(file, JSON.stringify({ version: 1, threads }));
    const r = await createThread(input("Neue Frage?"));
    expect(r.status).toBe("created");
    if (r.status !== "created") return;
    expect(r.closed.map(t => t.id)).toEqual(["T0000"]);
    const open = await listOpenThreads();
    expect(open.length).toBe(THREADS_OPEN_MAX);
    expect(open[0].id).toBe(r.thread.id);
    const oldest = (await listAllThreads()).find(t => t.id === "T0000")!;
    expect(oldest).toMatchObject({ state: "closed", closedReason: "limit" });
    // im Log nur Kennungen, keine Frage
    const logged = logSpy.mock.calls.map(c => String(c[0])).join("\n");
    expect(logged).toContain("T0000");
    expect(logged).not.toContain("Frage");
  });

  test("geschlossene Fäden verschwinden 30 Tage nach closedAt, offene nie", async () => {
    const now = Date.now();
    const base = { conversation: web("w1"), topic: "t", context: "c", reminders: 0 };
    writeFileSync(file, JSON.stringify({
      version: 1,
      threads: {
        Alt: { ...base, id: "Alt", question: "a?", createdAt: now - 90 * 86_400_000, state: "closed", closedReason: "erledigt", closedAt: now - THREADS_CLOSED_KEEP_MS - 60_000 },
        Jung: { ...base, id: "Jung", question: "b?", createdAt: now - 90 * 86_400_000, state: "closed", closedAt: now - THREADS_CLOSED_KEEP_MS + 60_000 },
        Offen: { ...base, id: "Offen", question: "c?", createdAt: now - 90 * 86_400_000, state: "open" },
      },
    }));
    await createThread(input("Neu?"));
    const ids = (await listAllThreads()).map(t => t.id).sort();
    expect(ids).toContain("Jung");
    expect(ids).toContain("Offen");
    expect(ids).not.toContain("Alt");
  });

  test("kaputte Datei: Lesen leer, Anlegen bewahrt sie auf und vergibt keine alte Nummer", async () => {
    const a = await createThread(input("Eins?"));
    const b = await createThread(input("Zwei?"));
    expect([a.thread.nr, b.thread.nr]).toEqual([1, 2]);
    expect(readFileSync(`${file}.nr`, "utf-8").trim()).toBe("3");
    writeFileSync(file, "{kaputt");
    expect(await listOpenThreads()).toEqual([]);
    const c = await createThread(input("Drei?"));
    expect(c.status).toBe("created");
    expect(c.thread.nr).toBe(3);
    expect(readdirSync(dir).filter(f => f.startsWith("threads.json.kaputt-")).length).toBe(1);
    // ein alter Befehl /faeden zu 1 trifft den neuen Faden nicht
    expect(await closeThreads(web("w1"), [1, 2], "von Hand")).toEqual({ closed: [], skipped: [1, 2] });
    expect((await listOpenThreads()).map(t => t.nr)).toEqual([3]);
    expect((await createThread(input("Vier?"))).thread.nr).toBe(4);
  });

  test("kaputte Datei ohne gesicherten Nummernstand: Änderungen abgelehnt, Datei bleibt liegen", async () => {
    writeFileSync(file, "{kaputt");
    await expect(createThread(input("Frage?"))).rejects.toThrow("Nummernstand");
    await expect(closeThreads(web("w1"), [1], "von Hand")).rejects.toThrow("Nummernstand");
    expect(readFileSync(file, "utf-8")).toBe("{kaputt");
    expect(readdirSync(dir).filter(f => f.startsWith("threads.json.kaputt-"))).toEqual([]);
    expect(existsSync(`${file}.nr`)).toBe(false);
  });

  test("zwei Prozesse über die Sperre: kein Eintrag geht verloren, dieselbe Frage nur einmal", async () => {
    const child = join(import.meta.dir, "fixtures", "threads", "create-child.ts");
    const run = (questions: string[], conversationId: string) =>
      Bun.spawn(["bun", child, file, questions.join("|"), conversationId], { stdout: "pipe", stderr: "pipe" });
    const qa = Array.from({ length: 15 }, (_, i) => `A${i}?`);
    const qb = Array.from({ length: 15 }, (_, i) => `B${i}?`);
    // beide Prozesse legen zusätzlich dieselbe Frage im selben Gespräch an
    const p1 = run([...qa, "Gemeinsam?"], "w1");
    const p2 = run([...qb, "Gemeinsam?"], "w1");
    const [o1, o2] = await Promise.all([new Response(p1.stdout).text(), new Response(p2.stdout).text()]);
    expect(await p1.exited).toBe(0);
    expect(await p2.exited).toBe(0);
    const statuses = [...JSON.parse(o1), ...JSON.parse(o2)];
    expect(statuses.filter((s: string) => s === "duplicate").length).toBe(1);
    const open = await listOpenThreads();
    expect(open.length).toBe(31);
    expect(open.filter(t => t.question === "Gemeinsam?").length).toBe(1);
    // Nummern unter der Sperre: jede genau einmal, lückenlos 1 bis 31
    expect(open.map(t => t.nr).sort((a, b) => a - b)).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
  }, 30_000);
});

// Issue #291: feste Nummern und Schließen
describe("Nummern und Schließen", () => {
  test("Nummern ab 1 in der Reihenfolge des Anlegens, stabil nach Sortieren und Neulesen", async () => {
    const a = await createThread(input("Eins?"));
    const b = await createThread(input("Zwei?"));
    const c = await createThread(input("Drei?", topic(3)));
    expect([a, b, c].map(r => r.thread.nr)).toEqual([1, 2, 3]);
    // Neustart: die Datei wird frisch gelesen
    const open = await listOpenThreads();
    expect(open.map(t => [t.question, t.nr])).toEqual([["Drei?", 3], ["Zwei?", 2], ["Eins?", 1]]);
    expect(JSON.parse(readFileSync(file, "utf-8")).nextNr).toBe(4);
  });

  test("Nummern werden nie wiederverwendet, auch nicht nach dem Aufräumen", async () => {
    const a = await createThread(input("Eins?"));
    await createThread(input("Zwei?"));
    await closeThreads(web("w1"), [a.thread.nr], "von Hand");
    // geschlossenen Faden alt machen, das nächste Schreiben räumt ihn weg
    const stored = JSON.parse(readFileSync(file, "utf-8"));
    stored.threads[a.thread.id].closedAt = Date.now() - THREADS_CLOSED_KEEP_MS - 60_000;
    writeFileSync(file, JSON.stringify(stored));
    const c = await createThread(input("Drei?"));
    expect((await listAllThreads()).map(t => t.nr).sort()).toEqual([2, 3]);
    expect(c.thread.nr).toBe(3);
    // auch wenn der Faden mit der höchsten Nummer verschwindet
    await closeThreads(web("w1"), [3], "von Hand");
    const again = JSON.parse(readFileSync(file, "utf-8"));
    again.threads[c.thread.id].closedAt = Date.now() - THREADS_CLOSED_KEEP_MS - 60_000;
    writeFileSync(file, JSON.stringify(again));
    expect((await createThread(input("Vier?"))).thread.nr).toBe(4);
  });

  test("Migration: Fäden ohne Nummer bekommen eine nach Alter; Lesen und Schreiben zeigen dieselben", async () => {
    const now = Date.now();
    const base = { conversation: web("w1"), topic: "t", context: "c", reminders: 0, state: "open" };
    writeFileSync(file, JSON.stringify({
      version: 1,
      threads: {
        Neu: { ...base, id: "Neu", question: "n?", createdAt: now - 1_000 },
        Alt: { ...base, id: "Alt", question: "a?", createdAt: now - 9_000 },
        Mitte: { ...base, id: "Mitte", question: "m?", createdAt: now - 5_000 },
      },
    }));
    const before = (await listOpenThreads()).map(t => [t.id, t.nr]);
    expect(before).toEqual([["Neu", 3], ["Mitte", 2], ["Alt", 1]]);
    // Datei unverändert, bis geschrieben wird
    expect(JSON.parse(readFileSync(file, "utf-8")).threads.Alt.nr).toBeUndefined();
    const created = await createThread(input("Neu dazu?"));
    expect(created.thread.nr).toBe(4);
    const stored = JSON.parse(readFileSync(file, "utf-8"));
    expect([stored.threads.Alt.nr, stored.threads.Mitte.nr, stored.threads.Neu.nr, stored.nextNr]).toEqual([1, 2, 3, 5]);
  });

  test("doppelte oder ungültige Nummern werden neu vergeben, ohne bestehende zu ändern", async () => {
    const now = Date.now();
    const base = { conversation: web("w1"), topic: "t", context: "c", reminders: 0, state: "open" };
    writeFileSync(file, JSON.stringify({
      version: 1,
      nextNr: 8,
      threads: {
        A: { ...base, id: "A", nr: 5, question: "a?", createdAt: now - 9_000 },
        B: { ...base, id: "B", nr: 5, question: "b?", createdAt: now - 5_000 },
        C: { ...base, id: "C", nr: 0, question: "c?", createdAt: now - 1_000 },
      },
    }));
    const byId = Object.fromEntries((await listOpenThreads()).map(t => [t.id, t.nr]));
    expect(byId).toEqual({ A: 5, B: 8, C: 9 });
  });

  test("closeThreads: nur offene dieses Gesprächs, gemeinsam gespeichert, Grund bleibt", async () => {
    const own1 = await createThread(input("Eins?", topic(3)));
    const own2 = await createThread(input("Zwei?", topic(3)));
    const other = await createThread(input("Drei?", topic(4)));
    const r = await closeThreads(topic(3), [own1.thread.nr, own2.thread.nr, other.thread.nr, 77], "beantwortet");
    expect(r.closed.map(t => t.nr)).toEqual([1, 2]);
    expect(r.skipped).toEqual([3, 77]);
    expect((await listOpenThreads()).map(t => t.nr)).toEqual([3]);
    // schon geschlossen: Grund und Zeitpunkt bleiben
    const closedAt = (await findThread(1))!.closedAt;
    const again = await closeThreads(topic(3), [1], "von Hand");
    expect(again).toEqual({ closed: [], skipped: [1] });
    expect((await findThread(1))!.closedReason).toBe("beantwortet");
    expect((await findThread(1))!.closedAt).toBe(closedAt);
    // General ohne Topic ist ein anderes Gespräch als Topic 3
    expect((await closeThreads(topic(), [3], "von Hand")).closed).toEqual([]);
  });

  test("closeThreads: scheitert das Ersetzen der Datei, bleiben alle Fäden offen", async () => {
    const a = await createThread(input("Eins?"));
    const b = await createThread(input("Zwei?"));
    const realRename = fsp.rename;
    const spy = spyOn(fsp, "rename").mockImplementation(async (from: any, to: any) => {
      if (to === file) throw Object.assign(new Error("Platte voll"), { code: "ENOSPC" });
      return realRename(from, to);
    });
    try {
      await expect(closeThreads(web("w1"), [a.thread.nr, b.thread.nr], "von Hand")).rejects.toThrow("Platte voll");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    // frisch gelesen: beide unverändert offen
    const stored = JSON.parse(readFileSync(file, "utf-8"));
    for (const t of [a.thread, b.thread]) {
      expect(stored.threads[t.id].state).toBe("open");
      expect(stored.threads[t.id].closedAt).toBeUndefined();
    }
    expect((await listOpenThreads(web("w1"))).map(t => t.nr).sort()).toEqual([1, 2]);
    expect(readdirSync(dir).filter(f => f.endsWith(".tmp"))).toEqual([]);
  });

  // Alte Ablage aus der Zeit vor den Nummern: A und B ohne nr und ohne nextNr
  function writeLegacy(): void {
    const now = Date.now();
    const base = { conversation: web("w1"), topic: "t", context: "c", reminders: 0, state: "open" };
    writeFileSync(file, JSON.stringify({
      version: 1,
      threads: {
        A: { ...base, id: "A", question: "a?", createdAt: now - 9_000 },
        B: { ...base, id: "B", question: "b?", createdAt: now - 5_000 },
      },
    }));
  }

  test("Migration: ein Leser vor dem Ersetzen der Ablage sieht die Nummern, die danach gelten", async () => {
    writeLegacy();
    const realRename = fsp.rename;
    let seen: Record<string, number> | null = null;
    const spy = spyOn(fsp, "rename").mockImplementation(async (from: any, to: any) => {
      // Nummernstand ist schon geschrieben, threads.json noch die alte
      if (to === file && !seen) {
        expect(readFileSync(`${file}.nr`, "utf-8").trim()).toBe("4");
        seen = Object.fromEntries((await listOpenThreads()).map(t => [t.id, t.nr]));
      }
      return realRename(from, to);
    });
    let cNr = 0;
    try {
      cNr = (await createThread(input("c?"))).thread.nr;
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual({ A: 1, B: 2 });
    expect(cNr).toBe(3);
    const stored = JSON.parse(readFileSync(file, "utf-8"));
    expect([stored.threads.A.nr, stored.threads.B.nr, stored.nextNr]).toEqual([1, 2, 4]);
    const d = await createThread(input("d?"));
    expect(d.thread.nr).toBe(4);
    // veralteter Befehl bzw. Aux-Ergebnis mit der vorher bei A gelesenen Nummer
    const r = await closeThreads(web("w1"), [seen!.A], "beantwortet");
    expect(r.closed.map(t => t.id)).toEqual(["A"]);
    expect((await listOpenThreads()).map(t => t.nr)).toEqual([4, 3, 2]);
    // eine Nummer, die es vor der Migration nicht gab, trifft D nicht
    expect(await closeThreads(web("w1"), [5], "von Hand")).toEqual({ closed: [], skipped: [5] });
  });

  test("Migration: scheitert das gemeinsame Schließen, bleiben die gelesenen Nummern", async () => {
    writeLegacy();
    const before = Object.fromEntries((await listOpenThreads()).map(t => [t.id, t.nr]));
    expect(before).toEqual({ A: 1, B: 2 });
    const original = readFileSync(file, "utf-8");
    const realRename = fsp.rename;
    const spy = spyOn(fsp, "rename").mockImplementation(async (from: any, to: any) => {
      if (to === file) throw Object.assign(new Error("Platte voll"), { code: "ENOSPC" });
      return realRename(from, to);
    });
    try {
      await expect(closeThreads(web("w1"), [1, 2], "von Hand")).rejects.toThrow("Platte voll");
    } finally {
      spy.mockRestore();
    }
    // Hauptdatei unverändert, Nummernstand schon weiter
    expect(readFileSync(file, "utf-8")).toBe(original);
    expect(readFileSync(`${file}.nr`, "utf-8").trim()).toBe("3");
    expect(Object.fromEntries((await listOpenThreads()).map(t => [t.id, t.nr]))).toEqual(before);
    expect((await findThread(1))!.id).toBe("A");
    expect(await findThread(3)).toBeNull();
    // der nächste Versuch mit den vorher gelesenen Nummern schließt dieselben Fäden
    const r = await closeThreads(web("w1"), [before.B], "beantwortet");
    expect(r.closed.map(t => t.id)).toEqual(["B"]);
    const stored = JSON.parse(readFileSync(file, "utf-8"));
    expect([stored.threads.A.nr, stored.threads.B.nr, stored.nextNr]).toEqual([1, 2, 3]);
    expect((await createThread(input("c?"))).thread.nr).toBe(3);
  });

  test("veralteter Nummernstand größer als die Ablage: alte Fäden behalten ihre Nummern, neue liegen darüber", async () => {
    writeLegacy();
    writeFileSync(`${file}.nr`, "7\n");
    expect(Object.fromEntries((await listOpenThreads()).map(t => [t.id, t.nr]))).toEqual({ A: 1, B: 2 });
    const c = await createThread(input("c?"));
    expect(c.thread.nr).toBe(7);
    const stored = JSON.parse(readFileSync(file, "utf-8"));
    expect([stored.threads.A.nr, stored.threads.B.nr, stored.nextNr]).toEqual([1, 2, 8]);
    expect(readFileSync(`${file}.nr`, "utf-8").trim()).toBe("8");
  });

  test("listRecentlyClosedThreads: Grenze 7 Tage nach closedAt, feste Zeit", async () => {
    const now = Date.parse("2026-10-15T10:00:00Z");
    const day = 86_400_000;
    const base = { conversation: web("w1"), topic: "t", context: "c", reminders: 0, createdAt: now - 20 * day };
    writeFileSync(file, JSON.stringify({
      version: 1,
      nextNr: 5,
      threads: {
        A: { ...base, id: "A", nr: 1, question: "a?", state: "closed", closedReason: "beantwortet", closedAt: now - 7 * day },
        B: { ...base, id: "B", nr: 2, question: "b?", state: "closed", closedReason: "von Hand", closedAt: now - 7 * day - 1 },
        C: { ...base, id: "C", nr: 3, question: "c?", state: "closed", closedReason: "limit", closedAt: now - day },
        D: { ...base, id: "D", nr: 4, question: "d?", state: "open" },
      },
    }));
    expect((await listRecentlyClosedThreads(now)).map(t => t.id)).toEqual(["C", "A"]);
  });
});
