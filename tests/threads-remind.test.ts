import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createChoice,
  decideChoice,
  getChoice,
  listChoices,
  onChoiceDecided,
  setChoicesFileForTests,
  type Choice,
  type ChoiceConversation,
  type CreateChoiceInput,
  type CreateChoiceOptions,
} from "../src/lib/choices";
import { sendAndRecord, type OutboxDeps, type SendAndRecordInput, type SendAndRecordResult } from "../src/lib/outbox";
import type { Message } from "../src/lib/store/types";
import { createThreadChoices, installThreadChoiceExpiry, THREAD_OPTIONS } from "../src/lib/thread-choices";
import { createThreadReminders, startThreadReminders, type RemindDeps } from "../src/lib/threads/remind";
import { nextReminderTime } from "../src/lib/threads/schedule";
import { closeThreads, createThread, getThread, setThreadsFileForTests, updateThreads, type Thread } from "../src/lib/threads/store";

// Issue #292, Aufgabe 6: Zeitgeber der Erinnerungen mit fester Uhr, Attrappen
// für Senden und Gesprächsprüfung, echtem Register und echter Ablage im Temp-Ordner.

const GROUP = "-1001234567890";
const TOPIC: ChoiceConversation = { type: "telegram", chatId: GROUP, topicId: 7 };
const DM: ChoiceConversation = { type: "telegram", chatId: "4711" };
const CONV_ID = "0b7c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const WEB: ChoiceConversation = { type: "web", conversationId: CONV_ID };
const ENV = { USER_TIMEZONE: "UTC" };
const T10 = Date.parse("2026-10-15T10:00:00Z");

let dir: string;
let cleanup: (() => void)[];
let logSpy: ReturnType<typeof spyOn>;
let clock: number;
let sent: SendAndRecordInput[];
let logs: string[];
let notes: { conversation: ChoiceConversation; text: string }[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-remind-"));
  setChoicesFileForTests(join(dir, "choices.json"));
  setThreadsFileForTests(join(dir, "threads.json"));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  clock = T10;
  sent = [];
  logs = [];
  notes = [];
  cleanup = [
    installThreadChoiceExpiry({ log: () => {} }),
    onChoiceDecided("thread", createThreadChoices({ notify: async (conversation, text) => { notes.push({ conversation, text }); }, env: ENV, log: () => {} }).handler),
  ];
});

afterEach(() => {
  for (const fn of cleanup) fn();
  logSpy.mockRestore();
  setChoicesFileForTests(null);
  setThreadsFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

let messageId = 100;
const ok = (input: SendAndRecordInput): SendAndRecordResult => ({
  sent: !String(input.chatId ?? "").startsWith("web"),
  recorded: true,
  ...(input.buttons ? { messages: [{ chatId: String(input.chatId), messageId: ++messageId, part: "text" as const, buttons: true }] } : {}),
});

type SendFn = (input: SendAndRecordInput) => Promise<SendAndRecordResult>;

function reminders(o: Partial<RemindDeps> & { sendFn?: SendFn; gone?: (c: ChoiceConversation) => Promise<boolean | null> } = {}) {
  return createThreadReminders({
    now: () => clock,
    env: () => ENV,
    telegram: () => true,
    send: async input => {
      sent.push(input);
      return o.sendFn ? o.sendFn(input) : ok(input);
    },
    conversationGone: o.gone ?? (async () => false),
    log: line => logs.push(line),
    ...o,
  });
}

async function due(question = "Hamburg oder München?", conversation: ChoiceConversation = TOPIC, fields: Partial<Thread> = {}): Promise<Thread> {
  const r = await createThread({ conversation, topic: "Reiseziel", context: "Wohin geht die Reise im Dezember?", question });
  if (r.status !== "created") throw new Error("nicht angelegt");
  await setFields(r.thread.id, { nextReminderAt: clock - 1, ...fields });
  return (await getThread(r.thread.id))!;
}

async function setFields(id: string, fields: Partial<Thread>): Promise<void> {
  await updateThreads(threads => {
    Object.assign(threads[id], fields);
    for (const [k, v] of Object.entries(fields)) if (v === undefined) delete (threads[id] as any)[k];
    return { result: null, changed: true };
  });
}

const threadChoices = async (id: string) => (await listChoices()).filter(c => c.kind === "thread" && c.ref === id);

describe("Erinnern", () => {
  test("fälliger Faden: genau eine Nachricht mit Kontext, Frage und drei Knöpfen im Gespräch des Fadens", async () => {
    const t = await due();
    const r = await reminders().tick();
    expect(r.sent).toBe(1);
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ chatId: GROUP, topicId: 7, format: "plain", source: "faeden" });
    expect(sent[0].text).toContain("🧵 Offen seit");
    expect(sent[0].text).toContain("Wohin geht die Reise im Dezember?");
    expect(sent[0].text).toContain("Frage: Hamburg oder München?");
    expect(sent[0].buttons!.flat().map(b => b.text)).toEqual(["Erledigt", "Später", "Nicht mehr wichtig"]);
    const after = (await getThread(t.id))!;
    expect(after).toMatchObject({ state: "open", reminders: 1, hintPending: true });
    expect(after.reminder).toBeUndefined();
    expect(after.nextReminderAt).toBe(nextReminderTime(clock, undefined, ENV));
    const choices = await threadChoices(t.id);
    expect(choices.length).toBe(1);
    expect(choices[0]).toMatchObject({ state: "open", id: sent[0].choiceId, telegram: [{ chatId: GROUP }] });
    // Gleich danach noch ein Durchgang: nichts
    expect((await reminders().tick()).sent).toBe(0);
  });

  test("zweite Erinnerung ersetzt die erste Rückfrage, danach still geschlossen, Rückfrage abgelaufen", async () => {
    const t = await due();
    const r = reminders();
    await r.tick();
    const first = sent[0].choiceId!;
    clock = (await getThread(t.id))!.nextReminderAt!;
    await r.tick();
    expect(sent.length).toBe(2);
    expect(sent[1].text).toContain("🧵 Noch einmal, offen seit");
    expect((await getChoice(first))?.state).toBe("expired");
    const second = sent[1].choiceId!;
    expect((await getChoice(second))?.state).toBe("open");
    expect((await getThread(t.id))!.reminders).toBe(2);
    clock = (await getThread(t.id))!.nextReminderAt!;
    const third = await r.tick();
    expect(third).toMatchObject({ sent: 0, closed: 1 });
    expect(sent.length).toBe(2);
    expect(await getThread(t.id)).toMatchObject({ state: "closed", closedReason: "keine Antwort" });
    expect((await getChoice(second))?.state).toBe("expired");
  });

  test("Später nach der zweiten Erinnerung: keine dritte, danach still geschlossen", async () => {
    const t = await due();
    const r = reminders();
    await r.tick();
    clock = (await getThread(t.id))!.nextReminderAt!;
    await r.tick();
    await decideChoice(sent[1].choiceId!, "later", "telegram");
    expect(notes[0].text).toContain("danach schließe ich ihn");
    clock = (await getThread(t.id))!.nextReminderAt!;
    await r.tick();
    expect(sent.length).toBe(2);
    expect(await getThread(t.id)).toMatchObject({ state: "closed", closedReason: "keine Antwort" });
  });

  test("sicher abgelehnt: im nächsten Durchgang wiederholt, nach 3 Versuchen Stufe verbraucht, Rückfrage abgelaufen", async () => {
    const t = await due();
    const r = reminders({ sendFn: async () => ({ sent: false, recorded: false, error: { kind: "send", message: "x", rejected: true } }) });
    await r.tick();
    expect((await getThread(t.id))!.reminder).toMatchObject({ step: 1, attempts: 1, state: "ready" });
    await r.tick();
    expect((await getThread(t.id))!.reminder).toMatchObject({ attempts: 2, state: "ready" });
    await r.tick();
    expect(sent.length).toBe(3);
    const after = (await getThread(t.id))!;
    expect(after).toMatchObject({ state: "open", reminders: 1 });
    expect(after.reminder).toBeUndefined();
    expect(after.hintPending).toBeUndefined();
    expect(after.nextReminderAt).toBe(nextReminderTime(clock, undefined, ENV));
    expect((await threadChoices(t.id)).every(c => c.state !== "open")).toBe(true);
    expect(logs.some(l => l.includes(t.id) && l.includes("3 Versuchen"))).toBe(true);
    await r.tick();
    expect(sent.length).toBe(3);
  });

  test("dauerhaft abgelehnt endet nach zwei Stufen", async () => {
    const t = await due();
    const r = reminders({ sendFn: async () => ({ sent: false, recorded: false, error: { kind: "invalid", message: "x" } }) });
    for (let i = 0; i < 3; i++) await r.tick();
    clock = (await getThread(t.id))!.nextReminderAt!;
    for (let i = 0; i < 3; i++) await r.tick();
    clock = (await getThread(t.id))!.nextReminderAt!;
    await r.tick();
    expect(sent.length).toBe(6);
    expect(await getThread(t.id)).toMatchObject({ state: "closed", closedReason: "keine Antwort" });
  });

  test("unklarer Ausgang (Ausnahme, 5xx) wird nicht wiederholt", async () => {
    const a = await due("A?");
    const b = await due("B?");
    const r = reminders({
      sendFn: async input => {
        if (input.text!.includes("A?")) throw new Error("Zeitüberschreitung");
        return { sent: false, recorded: false, error: { kind: "send", message: "HTTP 502" } };
      },
    });
    await r.tick();
    await r.tick();
    expect(sent.length).toBe(2);
    for (const t of [a, b]) {
      const after = (await getThread(t.id))!;
      expect(after).toMatchObject({ reminders: 1, hintPending: true });
      expect(after.reminder).toBeUndefined();
      expect(logs.some(l => l.includes(t.id) && l.includes("Zustellung unklar, nicht wiederholt"))).toBe(true);
    }
  });

  test("Web-Gespräch: Eintrag gespeichert, Bestätigung verloren: kein zweiter Eintrag", async () => {
    const stored: Message[] = [];
    const deps: OutboxDeps = {
      botToken: "123:test",
      userId: "4711",
      groupId: GROUP,
      outboxDir: join(dir, "outbox"),
      fetch: async () => { throw new Error("nie an Telegram"); },
      record: async m => {
        stored.push(m);
        throw new Error("Antwort verloren");
      },
      log: () => {},
      newId: () => crypto.randomUUID(),
    };
    const t = await due("Web?", WEB);
    const r = reminders({ sendFn: input => sendAndRecord(input, deps) });
    await r.tick();
    await r.tick();
    expect(stored.length).toBe(1);
    expect(stored[0]).toMatchObject({ chat_id: `web:${CONV_ID}`, metadata: { choiceId: sent[0].choiceId } });
    expect((await getThread(t.id))!).toMatchObject({ reminders: 1, hintPending: true });
  });

  test("Teilerfolg (Telegram angenommen, Festhalten gescheitert) zählt als zugestellt", async () => {
    const t = await due();
    await reminders({ sendFn: async input => ({ ...ok(input), recorded: false }) }).tick();
    await reminders().tick();
    expect(sent.length).toBe(1);
    expect((await getThread(t.id))!).toMatchObject({ reminders: 1, hintPending: true });
  });
});

describe("Neustart", () => {
  test("Auftrag ready: fortgesetzt, verwaiste Rückfrage ersetzt, Versuche erhalten", async () => {
    const t = await due();
    const orphan = await createChoice({ kind: "thread", conversation: TOPIC, text: "alt", options: THREAD_OPTIONS, ref: t.id });
    await setFields(t.id, { reminder: { step: 1, attempts: 2, state: "ready", since: clock - 60_000 } });
    const r = reminders({ sendFn: async () => ({ sent: false, recorded: false, error: { kind: "send", message: "x", rejected: true } }) });
    await r.tick();
    expect(sent.length).toBe(1);
    expect(sent[0].choiceId).not.toBe(orphan.id);
    expect((await getChoice(orphan.id))?.state).toBe("expired");
    // Dritter Versuch insgesamt: Stufe verbraucht
    const after = (await getThread(t.id))!;
    expect(after.reminder).toBeUndefined();
    expect(after.reminders).toBe(1);
  });

  test("Auftrag sending: Ausgang unbekannt, nicht erneut gesendet, wie unklar ausgewertet", async () => {
    const t = await due();
    const c = await createChoice({ kind: "thread", conversation: TOPIC, text: "x", options: THREAD_OPTIONS, ref: t.id });
    await setFields(t.id, { reminder: { step: 1, choiceId: c.id, attempts: 1, state: "sending", since: clock - 60_000 } });
    await reminders().tick();
    expect(sent.length).toBe(0);
    const after = (await getThread(t.id))!;
    expect(after).toMatchObject({ reminders: 1, hintPending: true });
    expect(after.reminder).toBeUndefined();
    expect(after.nextReminderAt).toBe(nextReminderTime(clock, undefined, ENV));
    expect((await getChoice(c.id))?.state).toBe("open");
  });
});

describe("Ruhezeit", () => {
  test("zur Ruhezeit nichts", async () => {
    await due();
    clock = Date.parse("2026-10-15T21:00:00Z");
    const r = await reminders().tick();
    expect(r).toMatchObject({ sent: 0, quiet: true });
    clock = Date.parse("2026-10-16T07:59:00Z");
    expect((await reminders().tick()).sent).toBe(0);
    expect(sent.length).toBe(0);
  });

  test("Durchgang über 21:00 hinweg: nach 21:00 wird nichts mehr gesendet", async () => {
    clock = Date.parse("2026-10-15T20:59:00Z");
    await due("A?");
    await due("B?");
    const r = await reminders({
      sendFn: async input => {
        clock = Date.parse("2026-10-15T21:00:00Z");
        return ok(input);
      },
    }).tick();
    expect(r.sent).toBe(1);
    expect(sent.length).toBe(1);
  });

  // Uhr springt während der Vorbereitung eines Fadens über 21:00: nichts gesendet,
  // Auftrag "ready" ohne verbrauchten Versuch, Rückfrage abgelaufen, um 8 Uhr Stufe 1
  const NINE = Date.parse("2026-10-15T21:00:00Z");
  for (const [name, o] of [
    ["beim Anlegen der Rückfrage", { createChoice: async (input: CreateChoiceInput, options?: CreateChoiceOptions) => { const c = await createChoice(input, options); clock = NINE; return c; } }],
    ["bei der Gesprächsprüfung", { gone: async () => { clock = NINE; return false; } }],
    ["nach der Übernahme (ältere Rückfragen ablaufen)", { listChoices: async () => { clock = NINE; return listChoices(); } }],
  ] as [string, Partial<RemindDeps> & { gone?: (c: ChoiceConversation) => Promise<boolean | null> }][]) {
    test(`Ruhezeit beginnt ${name}: nichts gesendet, Stufe bleibt fortsetzbar`, async () => {
      clock = Date.parse("2026-10-15T20:59:59Z");
      const t = await due();
      const r = await reminders(o).tick();
      expect(r).toMatchObject({ sent: 0, quiet: true });
      expect(sent.length).toBe(0);
      const after = (await getThread(t.id))!;
      expect(after).toMatchObject({ state: "open", reminders: 0, reminder: { step: 1, attempts: 0, state: "ready" } });
      expect(after.reminder!.choiceId).toBeUndefined();
      expect((await threadChoices(t.id)).every(c => c.state === "expired")).toBe(true);

      clock = Date.parse("2026-10-16T08:00:00Z");
      expect((await reminders().tick()).sent).toBe(1);
      expect(sent.length).toBe(1);
      expect(sent[0].text).toContain("🧵 Offen seit");
      expect((await getThread(t.id))!).toMatchObject({ reminders: 1, hintPending: true });
    });
  }
});

describe("Gespräch weg", () => {
  test("gelöschtes Topic und gelöschtes Web-Gespräch: still geschlossen, nichts gesendet", async () => {
    const a = await due("A?", TOPIC);
    const b = await due("B?", WEB);
    const r = await reminders({ gone: async () => true }).tick();
    expect(r.closed).toBe(2);
    expect(sent.length).toBe(0);
    for (const t of [a, b]) expect(await getThread(t.id)).toMatchObject({ state: "closed", closedReason: "Gespräch weg" });
  });

  test("geschlossenes Topic (nicht gelöscht), Lesefehler und Sendefehler schließen nicht", async () => {
    const a = await due("A?", TOPIC);
    const b = await due("B?", { type: "telegram", chatId: GROUP, topicId: 9 });
    const r = await reminders({
      gone: async c => (c.type === "telegram" && c.topicId === 9 ? null : false),
      sendFn: async () => ({ sent: false, recorded: false, error: { kind: "send", message: "Topic geschlossen", rejected: true } }),
    }).tick();
    expect(r.closed).toBe(0);
    expect(sent.length).toBe(2);
    for (const t of [a, b]) expect((await getThread(t.id))!.state).toBe("open");
  });
});

describe("Nebenläufigkeit", () => {
  test("Faden wird zwischen Schritt 2 und 3 aufgelöst: kein Versand, Rückfrage abgelaufen", async () => {
    const t = await due();
    let created: Choice | undefined;
    const r = reminders({
      createChoice: async (input: CreateChoiceInput, options?: CreateChoiceOptions) => {
        created = await createChoice(input, options);
        await closeThreads(TOPIC, [t.nr], "beantwortet");
        return created;
      },
    });
    await r.tick();
    expect(sent.length).toBe(0);
    expect((await getChoice(created!.id))?.state).toBe("expired");
    expect((await getThread(t.id))!.state).toBe("closed");
  });

  test("Klick auf eine Rückfrage vor Schritt 3 verhindert den Versand", async () => {
    const t = await due();
    const r = reminders({
      createChoice: async (input: CreateChoiceInput, options?: CreateChoiceOptions) => {
        const c = await createChoice(input, options);
        await decideChoice(c.id, "later", "web");
        return c;
      },
    });
    await r.tick();
    expect(sent.length).toBe(0);
    const after = (await getThread(t.id))!;
    expect(after.state).toBe("open");
    expect(after.reminders).toBe(1);
    expect(after.reminder).toBeUndefined();
    expect(notes.map(n => n.text)[0]).toContain("Ich frage am");
  });

  test("Auflösen, Klick und Durchgang gleichzeitig: stimmiger Zustand, höchstens eine Nachricht", async () => {
    const t = await due();
    const r = reminders({
      sendFn: async input => {
        await Promise.all([decideChoice(input.choiceId!, "later", "telegram"), closeThreads(TOPIC, [t.nr], "beantwortet")]);
        return ok(input);
      },
    });
    await Promise.all([r.tick(), r.tick()]);
    expect(sent.length).toBe(1);
    const after = (await getThread(t.id))!;
    expect(after.state).toBe("closed");
    expect(after.reminder).toBeUndefined();
    expect(after.hintPending).toBeUndefined();
    expect((await threadChoices(t.id)).some(c => c.state === "open")).toBe(false);
    expect(logs.some(l => l.includes("nichts überschrieben"))).toBe(true);
  });

  test("Später während des Versands: das späte Versandergebnis überschreibt den neuen Termin nicht", async () => {
    const t = await due();
    const r = reminders({
      sendFn: async input => {
        await decideChoice(input.choiceId!, "later", "web");
        return ok(input);
      },
    });
    await r.tick();
    const after = (await getThread(t.id))!;
    expect(after.reminders).toBe(1);
    expect(after.hintPending).toBeUndefined();
    // „Später" rechnet mit der echten Uhr: drei Tage ab jetzt, nicht der Termin des Zeitgebers
    expect(after.nextReminderAt).not.toBe(nextReminderTime(clock, undefined, ENV));
  });

  // Nach der Übernahme, vor dem Versand: Abräumen der alten Rückfragen (listChoices)
  // ist der Zeitpunkt, an dem ein Klick oder eine Textauflösung dazwischenkommt
  describe("nach der Übernahme, vor dem Versand", () => {
    function interrupted(action: (own: Choice) => Promise<unknown>) {
      let own: Choice | undefined;
      const r = reminders({
        listChoices: async () => {
          const all = await listChoices();
          own = all.find(c => c.kind === "thread" && c.state === "open");
          await action(own!);
          return listChoices();
        },
      });
      return { r, own: () => own! };
    }

    test("„Später“: kein Versand, neuer Termin bleibt", async () => {
      const t = await due();
      let afterClick: Thread | undefined;
      const { r } = interrupted(async own => {
        await decideChoice(own.id, "later", "web");
        afterClick = (await getThread(t.id))!;
      });
      await r.tick();
      expect(sent.length).toBe(0);
      const after = (await getThread(t.id))!;
      expect(after.state).toBe("open");
      expect(after.reminder).toBeUndefined();
      expect(after.hintPending).toBeUndefined();
      expect(after.reminders).toBe(afterClick!.reminders);
      expect(after.nextReminderAt).toBe(afterClick!.nextReminderAt);
      expect(logs.some(l => l.includes("vor dem Versand geändert"))).toBe(true);
    });

    test("„Erledigt“: kein Versand, Faden bleibt geschlossen, Entscheidung bleibt", async () => {
      const t = await due();
      const { r, own } = interrupted(c => decideChoice(c.id, "done", "telegram"));
      await r.tick();
      expect(sent.length).toBe(0);
      const after = (await getThread(t.id))!;
      expect(after.state).toBe("closed");
      expect(after.reminder).toBeUndefined();
      expect(after.hintPending).toBeUndefined();
      expect((await getChoice(own().id))?.state).toBe("done");
    });

    test("Textauflösung: kein Versand, Faden bleibt geschlossen, Rückfrage abgelaufen", async () => {
      const t = await due();
      const { r, own } = interrupted(() => closeThreads(TOPIC, [t.nr], "beantwortet"));
      await r.tick();
      expect(sent.length).toBe(0);
      const after = (await getThread(t.id))!;
      expect(after.state).toBe("closed");
      expect(after.closedReason).toBe("beantwortet");
      expect(after.reminder).toBeUndefined();
      expect(after.hintPending).toBeUndefined();
      expect((await getChoice(own().id))?.state).toBe("expired");
    });
  });

  test("zwei parallele Durchgänge (auch zwei Zeitgeber): eine Nachricht", async () => {
    const t = await due();
    const a = reminders();
    const b = reminders();
    await Promise.all([a.tick(), a.tick(), b.tick()]);
    expect(sent.length).toBe(1);
    expect((await getThread(t.id))!.reminders).toBe(1);
    const open = (await threadChoices(t.id)).filter(c => c.state === "open");
    expect(open.length).toBe(1);
    expect(open[0].id).toBe(sent[0].choiceId);
  });
});

describe("Grenzen und Schalter", () => {
  test("höchstens 5 je Durchgang, der Rest im nächsten", async () => {
    for (let i = 0; i < 7; i++) await due(`F${i}?`);
    const r = reminders();
    expect((await r.tick()).sent).toBe(5);
    expect((await r.tick()).sent).toBe(2);
    expect(sent.length).toBe(7);
  });

  test("Telegram-Gespräch ohne Telegram: kein Versand, verschoben, reminders bleibt, einmal ins Log", async () => {
    const t = await due("Ohne?", DM);
    const r = reminders({ telegram: () => false });
    expect((await r.tick()).deferred).toBe(1);
    const after = (await getThread(t.id))!;
    expect(after.reminders).toBe(0);
    expect(after.nextReminderAt).toBe(nextReminderTime(clock, undefined, ENV));
    clock = after.nextReminderAt!;
    await r.tick();
    expect(sent.length).toBe(0);
    expect(logs.filter(l => l.includes(t.id) && l.includes("Telegram nicht eingerichtet")).length).toBe(1);
  });

  test("Web-Gespräch ohne Telegram wird trotzdem erinnert", async () => {
    await due("Web?", WEB);
    await reminders({ telegram: () => false }).tick();
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ chatId: `web:${CONV_ID}` });
    expect(sent[0].buttons).toBeUndefined();
  });

  test("Altbestand ohne Termin: bekommt einen, keine sofortige Erinnerung", async () => {
    const t = await due();
    await setFields(t.id, { nextReminderAt: undefined });
    await reminders().tick();
    expect(sent.length).toBe(0);
    expect((await getThread(t.id))!.nextReminderAt).toBe(nextReminderTime(clock, undefined, ENV));
  });

  test("THREADS=off: Zeitgeber läuft trotzdem (Einschalten ohne Neustart, Issue #293), Durchgang tut nichts", async () => {
    await due();
    let intervals = 0;
    const timer = startThreadReminders(
      { now: () => clock, env: () => ({ THREADS: "off" }), telegram: () => true, send: async i => ok(i), conversationGone: async () => false },
      { setInterval: (() => { intervals++; return 0; }) as any, setTimeout: (() => { intervals++; return 0; }) as any, clearInterval: (() => {}) as any, clearTimeout: (() => {}) as any }
    );
    timer.stop();
    expect(intervals).toBe(2);
    const r = createThreadReminders({ now: () => clock, env: () => ({ THREADS: "off" }), telegram: () => true, send: async i => ok(i), conversationGone: async () => false });
    expect((await r.tick()).sent).toBe(0);
  });

  test("Zeitgeber: erster Durchgang kurz nach dem Start, dann alle 15 Minuten, stop räumt auf", async () => {
    const calls: { kind: string; ms: number }[] = [];
    let cleared = 0;
    const timer = startThreadReminders(
      { now: () => clock, env: () => ENV, telegram: () => true, send: async i => ok(i), conversationGone: async () => false },
      {
        setTimeout: ((_: unknown, ms: number) => { calls.push({ kind: "timeout", ms }); return 1; }) as any,
        setInterval: ((_: unknown, ms: number) => { calls.push({ kind: "interval", ms }); return 2; }) as any,
        clearTimeout: (() => { cleared++; }) as any,
        clearInterval: (() => { cleared++; }) as any,
      }
    );
    expect(calls).toEqual([{ kind: "timeout", ms: 30_000 }, { kind: "interval", ms: 15 * 60_000 }]);
    timer.stop();
    expect(cleared).toBe(2);
  });
});
