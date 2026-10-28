import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createChoice, decideChoice, onChoiceDecided, setChoicesFileForTests, type Choice, type ChoiceConversation } from "../src/lib/choices";
import { CHOICE_SOURCES } from "../src/lib/telegram-choices";
import { createThreadChoices, THREAD_OPTIONS, threadTarget } from "../src/lib/thread-choices";
import { laterReminderTime, localDateText } from "../src/lib/threads/schedule";
import { createThread, getThread, setThreadsFileForTests, updateThreads, type Thread } from "../src/lib/threads/store";

// Issue #292, Aufgabe 2: Art "thread" im Register und Handler der Knöpfe,
// echtes Register und echte Ablage im Temp-Ordner.

const ENV = { USER_TIMEZONE: "Europe/Berlin" };
const TOPIC: ChoiceConversation = { type: "telegram", chatId: "-1001", topicId: 7 };
const WEB: ChoiceConversation = { type: "web", conversationId: "0b7c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f" };

let dir: string;
let notes: { conversation: ChoiceConversation; text: string }[];
let cleanup: (() => void)[];
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-thread-choices-"));
  setChoicesFileForTests(join(dir, "choices.json"));
  setThreadsFileForTests(join(dir, "threads.json"));
  notes = [];
  cleanup = [];
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  const tc = createThreadChoices({ notify: async (conversation, text) => { notes.push({ conversation, text }); }, env: ENV, log: () => {} });
  cleanup.push(onChoiceDecided("thread", tc.handler));
});

afterEach(() => {
  for (const fn of cleanup) fn();
  logSpy.mockRestore();
  setChoicesFileForTests(null);
  setThreadsFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

async function thread(conversation: ChoiceConversation = TOPIC, reminders = 1): Promise<Thread> {
  const r = await createThread({ conversation, topic: "Reiseziel", context: "Wohin geht die Reise?", question: "Hamburg oder München?" });
  if (r.status !== "created") throw new Error("nicht angelegt");
  await updateThreads(threads => {
    threads[r.thread.id].reminders = reminders;
    return { result: null, changed: true };
  });
  return (await getThread(r.thread.id))!;
}

async function reminderChoice(t: Thread): Promise<Choice> {
  return createChoice({ kind: "thread", conversation: t.conversation, text: `Frage: ${t.question}`, options: THREAD_OPTIONS, ref: t.id });
}

describe("Register", () => {
  test("Art thread mit Absender faeden; Anzeige-Name in der WebUI", async () => {
    const t = await thread();
    const c = await reminderChoice(t);
    expect(c).toMatchObject({ kind: "thread", ref: t.id, state: "open" });
    expect(c.options.map(o => o.label)).toEqual(["Erledigt", "Später", "Nicht mehr wichtig"]);
    expect(CHOICE_SOURCES.thread).toBe("faeden");
    const app = await Bun.file(join(import.meta.dir, "..", "src", "web", "public", "app.js")).text();
    expect(app).toContain('faeden: "Fäden"');
  });

  test("Antwortziel: Topic in Chat und Topic, Web-Gespräch nur im Gespräch selbst", () => {
    expect(threadTarget(TOPIC)).toEqual({ chatId: "-1001", topicId: 7 });
    expect(threadTarget(WEB)).toEqual({ chatId: `web:${(WEB as any).conversationId}` });
    expect(threadTarget({ type: "telegram", chatId: "web" })).toEqual({ chatId: "web" });
  });
});

describe("Knöpfe", () => {
  test("Erledigt: geschlossen mit Grund erledigt, Antwort im Gespräch", async () => {
    const t = await thread();
    const c = await reminderChoice(t);
    expect((await decideChoice(c.id, "done", "telegram")).status).toBe("decided");
    expect(await getThread(t.id)).toMatchObject({ state: "closed", closedReason: "erledigt" });
    expect(notes).toEqual([{ conversation: TOPIC, text: "Erledigt." }]);
  });

  test("Nicht mehr wichtig: geschlossen, Antwort Vergessen.", async () => {
    const t = await thread(WEB);
    const c = await reminderChoice(t);
    await decideChoice(c.id, "drop", "web");
    expect(await getThread(t.id)).toMatchObject({ state: "closed", closedReason: "nicht mehr wichtig" });
    expect(notes).toEqual([{ conversation: WEB, text: "Vergessen." }]);
  });

  test("Später nach der ersten Erinnerung: 3 Tage, reminders bleibt, „Ich frage am … wieder.“", async () => {
    const t = await thread(TOPIC, 1);
    const c = await reminderChoice(t);
    const before = Date.now();
    await decideChoice(c.id, "later", "telegram");
    const after = (await getThread(t.id))!;
    expect(after).toMatchObject({ state: "open", reminders: 1 });
    expect(after.nextReminderAt!).toBeGreaterThanOrEqual(laterReminderTime(before, ENV) - 1000);
    expect(after.nextReminderAt!).toBeLessThanOrEqual(laterReminderTime(Date.now(), ENV));
    expect(after.nextReminderAt! - before).toBeGreaterThanOrEqual(3 * 86_400_000 - 2 * 3_600_000);
    expect(notes).toEqual([{ conversation: TOPIC, text: `Ich frage am ${localDateText(after.nextReminderAt!, "Europe/Berlin")} wieder.` }]);
  });

  test("Später nach der zweiten Erinnerung: keine dritte versprochen", async () => {
    const t = await thread(TOPIC, 2);
    const c = await reminderChoice(t);
    await decideChoice(c.id, "later", "web");
    const after = (await getThread(t.id))!;
    expect(after).toMatchObject({ state: "open", reminders: 2 });
    expect(notes[0].text).toBe(`Ich lasse ihn bis ${localDateText(after.nextReminderAt!, "Europe/Berlin")} offen, danach schließe ich ihn.`);
    expect(notes[0].text).not.toContain("wieder");
  });

  test("Später, während die zweite Erinnerung noch unterwegs ist: Stufe zählt, keine dritte versprochen, Auftrag beendet", async () => {
    const t = await thread(TOPIC, 1);
    const c = await reminderChoice(t);
    await updateThreads(threads => {
      threads[t.id].reminder = { step: 2, choiceId: c.id, attempts: 1, state: "sending", since: Date.now() };
      return { result: null, changed: true };
    });
    await decideChoice(c.id, "later", "telegram");
    const after = (await getThread(t.id))!;
    expect(after.reminders).toBe(2);
    expect(after.reminder).toBeUndefined();
    expect(notes[0].text).toContain("danach schließe ich ihn");
  });

  test("Knopf eines geschlossenen Fadens: „Schon erledigt.“, keine Änderung", async () => {
    const t = await thread();
    const c = await reminderChoice(t);
    // Wie ein anderer Prozess, der den Faden geschlossen hat, bevor dessen Rückfrage abgelaufen ist
    const file = join(dir, "threads.json");
    const store = JSON.parse(readFileSync(file, "utf-8"));
    Object.assign(store.threads[t.id], { state: "closed", closedReason: "beantwortet", closedAt: Date.now() });
    writeFileSync(file, JSON.stringify(store));
    expect((await decideChoice(c.id, "later", "telegram")).status).toBe("decided");
    expect(notes).toEqual([{ conversation: TOPIC, text: "Schon erledigt." }]);
    expect(await getThread(t.id)).toMatchObject({ state: "closed", closedReason: "beantwortet" });
    expect((await getThread(t.id))!.nextReminderAt).toBe(t.nextReminderAt);
  });

  test("Knopf eines verschwundenen Fadens: „Schon erledigt.“", async () => {
    const c = await createChoice({ kind: "thread", conversation: TOPIC, text: "Frage", options: THREAD_OPTIONS, ref: "Unbekannt12" });
    await decideChoice(c.id, "done", "telegram");
    expect(notes).toEqual([{ conversation: TOPIC, text: "Schon erledigt." }]);
  });

  test("gleichzeitiger Klick aus Telegram und Browser: genau eine Änderung, genau eine Antwort", async () => {
    const t = await thread(TOPIC, 1);
    const c = await reminderChoice(t);
    const [a, b] = await Promise.all([decideChoice(c.id, "done", "telegram"), decideChoice(c.id, "later", "web")]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["already", "decided"]);
    expect(notes.length).toBe(1);
    const after = (await getThread(t.id))!;
    const winner = a.status === "decided" ? "done" : "later";
    if (winner === "done") {
      expect(after).toMatchObject({ state: "closed", closedReason: "erledigt" });
      expect(notes[0].text).toBe("Erledigt.");
    } else {
      expect(after).toMatchObject({ state: "open", reminders: 1 });
      expect(notes[0].text).toContain("Ich frage am");
    }
  });
});
