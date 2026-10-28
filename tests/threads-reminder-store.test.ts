import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createChoice, decideChoice, getChoice, onChoiceDecided, setChoicesFileForTests, type ChoiceConversation } from "../src/lib/choices";
import { createThreadChoices, installThreadChoiceExpiry, sweepThreadChoices, THREAD_OPTIONS } from "../src/lib/thread-choices";
import { nextReminderTime } from "../src/lib/threads/schedule";
import {
  closeThreadIn,
  closeThreads,
  createThread,
  fillMissingReminders,
  getThread,
  listAllThreads,
  onThreadsClosed,
  setThreadsFileForTests,
  takeReminderHints,
  THREADS_OPEN_MAX,
  updateThreads,
  type Thread,
} from "../src/lib/threads/store";

// Issue #292, Aufgabe 3: nextReminderAt beim Anlegen, Felder reminder und
// hintPending, onThreadsClosed auf jedem Schließweg (Rückfrage läuft ab),
// takeReminderHints und Altbestand ohne nextReminderAt.

const TOPIC: ChoiceConversation = { type: "telegram", chatId: "-1001", topicId: 7 };
const OTHER: ChoiceConversation = { type: "telegram", chatId: "-1001", topicId: 8 };

let dir: string;
let file: string;
let cleanup: (() => void)[];
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-threads-reminder-"));
  file = join(dir, "threads.json");
  setThreadsFileForTests(file);
  setChoicesFileForTests(join(dir, "choices.json"));
  cleanup = [installThreadChoiceExpiry({ log: () => {} })];
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  for (const fn of cleanup) fn();
  logSpy.mockRestore();
  setThreadsFileForTests(null);
  setChoicesFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

async function thread(question = "Hamburg oder München?", conversation: ChoiceConversation = TOPIC, deadline?: string): Promise<Thread> {
  const r = await createThread({ conversation, topic: "Reiseziel", context: "Wohin?", question, ...(deadline ? { deadline } : {}) });
  if (r.status !== "created") throw new Error("nicht angelegt");
  return r.thread;
}

const choiceFor = (t: Thread) => createChoice({ kind: "thread", conversation: t.conversation, text: "Frage", options: THREAD_OPTIONS, ref: t.id });

describe("Anlegen und Felder", () => {
  test("createThread setzt nextReminderAt = nextReminderTime(createdAt, deadline)", async () => {
    const a = await thread("A?");
    const b = await thread("B?", TOPIC, "2099-01-01");
    expect(a.nextReminderAt).toBe(nextReminderTime(a.createdAt, undefined));
    expect(b.nextReminderAt).toBe(nextReminderTime(b.createdAt, "2099-01-01"));
  });

  test("reminder und hintPending werden gelesen und geprüft; alte Dateien ohne sie bleiben gültig", async () => {
    const t = await thread();
    const store = JSON.parse(readFileSync(file, "utf-8"));
    const old = { ...store.threads[t.id] };
    delete old.nextReminderAt;
    store.threads.alt = { ...old, id: "alt", nr: 50, question: "Alt?" };
    store.threads.gut = { ...old, id: "gut", nr: 51, question: "Gut?", reminder: { step: 2, choiceId: "Abc123", attempts: 1, state: "sending", since: 5 }, hintPending: true };
    store.threads.kaputt1 = { ...old, id: "kaputt1", nr: 52, reminder: { step: 3, attempts: 0, state: "ready", since: 1 } };
    store.threads.kaputt2 = { ...old, id: "kaputt2", nr: 53, reminder: { step: 1, attempts: 0, state: "irgendwas", since: 1 } };
    store.threads.kaputt3 = { ...old, id: "kaputt3", nr: 54, hintPending: "ja" };
    writeFileSync(file, JSON.stringify(store));
    const ids = (await listAllThreads()).map(x => x.id).sort();
    expect(ids).toEqual([t.id, "alt", "gut"].sort());
    expect(await getThread("gut")).toMatchObject({ reminder: { step: 2, choiceId: "Abc123", state: "sending" }, hintPending: true });
  });
});

describe("Schließen lässt die Rückfrage ablaufen", () => {
  test("Auflösen (beantwortet) und /faeden zu (von Hand)", async () => {
    for (const reason of ["beantwortet", "von Hand"]) {
      const t = await thread(`Frage ${reason}?`);
      const c = await choiceFor(t);
      await closeThreads(TOPIC, [t.nr], reason);
      expect((await getChoice(c.id))?.state).toBe("expired");
    }
  });

  test("Knopf: andere offene Rückfragen desselben Fadens laufen ab", async () => {
    cleanup.push(onChoiceDecided("thread", createThreadChoices({ notify: async () => {}, log: () => {} }).handler));
    const t = await thread();
    const old = await choiceFor(t);
    const now = await choiceFor(t);
    await decideChoice(now.id, "done", "telegram");
    expect((await getChoice(old.id))?.state).toBe("expired");
    expect((await getChoice(now.id))?.state).toBe("done");
  });

  test("Zeitgeber (still geschlossen, Gespräch weg) über updateThreads/closeThreadIn", async () => {
    const t = await thread();
    const c = await choiceFor(t);
    await updateThreads((threads, now) => {
      closeThreadIn(threads[t.id], "keine Antwort", now);
      return { result: null, changed: true };
    });
    expect(await getThread(t.id)).toMatchObject({ state: "closed", closedReason: "keine Antwort" });
    expect((await getChoice(c.id))?.state).toBe("expired");
  });

  test("Obergrenze: der älteste wird still geschlossen, seine Rückfrage läuft ab", async () => {
    const store: any = { version: 1, nextNr: THREADS_OPEN_MAX + 1, threads: {} };
    const base = Date.now() - 1000;
    for (let i = 0; i < THREADS_OPEN_MAX; i++) {
      const id = `T${String(i).padStart(4, "0")}`;
      store.threads[id] = { id, nr: i + 1, conversation: TOPIC, topic: "T", context: "K", question: `F${i}?`, createdAt: base + i, state: "open", reminders: 0 };
    }
    writeFileSync(file, JSON.stringify(store));
    const c = await createChoice({ kind: "thread", conversation: TOPIC, text: "Frage", options: THREAD_OPTIONS, ref: "T0000" });
    await thread("Neu?");
    expect(await getThread("T0000")).toMatchObject({ state: "closed", closedReason: "limit" });
    expect((await getChoice(c.id))?.state).toBe("expired");
  });

  test("onThreadsClosed meldet erst nach dem Schreiben und nur wirklich geschlossene", async () => {
    const seen: string[][] = [];
    cleanup.push(onThreadsClosed(async threads => {
      const disk = JSON.parse(readFileSync(file, "utf-8"));
      for (const t of threads) expect(disk.threads[t.id].state).toBe("closed");
      seen.push(threads.map(t => t.id));
    }));
    const a = await thread("A?");
    await closeThreads(TOPIC, [a.nr], "von Hand");
    await closeThreads(TOPIC, [a.nr], "von Hand");
    expect(seen).toEqual([[a.id]]);
  });

  test("Durchgang räumt Rückfragen ab, deren Faden ein anderer Prozess geschlossen hat oder die verschwunden sind", async () => {
    const t = await thread();
    const keep = await thread("Bleibt?");
    const c1 = await choiceFor(t);
    const c2 = await createChoice({ kind: "thread", conversation: TOPIC, text: "Frage", options: THREAD_OPTIONS, ref: "Weg1234567" });
    const c3 = await choiceFor(keep);
    const store = JSON.parse(readFileSync(file, "utf-8"));
    Object.assign(store.threads[t.id], { state: "closed", closedAt: Date.now(), closedReason: "von Hand" });
    writeFileSync(file, JSON.stringify(store));
    expect(await sweepThreadChoices({ log: () => {} })).toBe(2);
    expect((await getChoice(c1.id))?.state).toBe("expired");
    expect((await getChoice(c2.id))?.state).toBe("expired");
    expect((await getChoice(c3.id))?.state).toBe("open");
  });

  test("kaputte Ablage: der Durchgang räumt nichts ab", async () => {
    const t = await thread();
    const c = await choiceFor(t);
    writeFileSync(file, "{kaputt");
    await expect(sweepThreadChoices({ log: () => {} })).rejects.toThrow();
    expect((await getChoice(c.id))?.state).toBe("open");
  });
});

describe("Hinweis und Altbestand", () => {
  test("takeReminderHints: nur dieses Gespräch, nur einmal", async () => {
    const t = await thread();
    const o = await thread("Andere?", OTHER);
    await updateThreads(threads => {
      threads[t.id].hintPending = true;
      threads[o.id].hintPending = true;
      return { result: null, changed: true };
    });
    expect((await takeReminderHints(TOPIC)).map(x => x.id)).toEqual([t.id]);
    expect(await takeReminderHints(TOPIC)).toEqual([]);
    expect((await getThread(o.id))?.hintPending).toBe(true);
  });

  test("zwei gleichzeitige Turns verbrauchen den Hinweis einmal", async () => {
    const t = await thread();
    await updateThreads(threads => {
      threads[t.id].hintPending = true;
      return { result: null, changed: true };
    });
    const [a, b] = await Promise.all([takeReminderHints(TOPIC), takeReminderHints(TOPIC)]);
    expect(a.length + b.length).toBe(1);
  });

  test("Altbestand ohne nextReminderAt bekommt nextReminderTime(jetzt, deadline), nicht sofort fällig", async () => {
    const a = await thread("A?");
    const b = await thread("B?", TOPIC, "2099-01-01");
    const store = JSON.parse(readFileSync(file, "utf-8"));
    delete store.threads[a.id].nextReminderAt;
    delete store.threads[b.id].nextReminderAt;
    writeFileSync(file, JSON.stringify(store));
    const before = Date.now();
    expect(await fillMissingReminders({})).toBe(2);
    const after = Date.now();
    const ta = (await getThread(a.id))!;
    expect(ta.nextReminderAt!).toBeGreaterThanOrEqual(nextReminderTime(before, undefined, {}));
    expect(ta.nextReminderAt!).toBeLessThanOrEqual(nextReminderTime(after, undefined, {}));
    expect(ta.nextReminderAt!).toBeGreaterThan(after);
    expect(await fillMissingReminders({})).toBe(0);
  });
});
