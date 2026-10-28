// Issue #292, Aufgabe 8: Anzeige in /faeden über format.ts. Der Anschluss im
// Bot ist seit Issue #344 Verhalten: Handler der Art thread und Ablauf der
// Rückfragen in tests/app-bot-choices.test.ts, Zeitgeber nach der
// Routinen-Wache in tests/app-bot-background.test.ts, Hinweis vor dem Turn
// nur für Nachrichten in tests/telegram-text-inbox.test.ts (threads),
// tests/telegram-reply-turn.test.ts und tests/app-bot-turns.test.ts (turnHint).
import { describe, expect, test } from "bun:test";
import { formatThreadList, reminderLine } from "../src/lib/threads/format";
import type { Thread } from "../src/lib/threads/store";

describe("/faeden: nächster Termin in Ortszeit", () => {
  const base: Thread = {
    id: "A1",
    nr: 1,
    conversation: { type: "telegram", chatId: "4711" },
    topic: "Reiseziel",
    context: "Wohin?",
    question: "Hamburg oder München?",
    createdAt: Date.parse("2026-10-15T10:00:00Z"),
    state: "open",
    reminders: 0,
    nextReminderAt: Date.parse("2026-10-18T22:30:00Z"),
  };
  const now = Date.parse("2026-10-16T10:00:00Z");

  test("Erinnerung am, zweite Erinnerung am, schließe ich am", () => {
    // 22:30 UTC ist in Berlin schon der 19.10.
    expect(reminderLine(base, "Europe/Berlin")).toBe("Erinnerung am 19.10.2026");
    expect(reminderLine({ ...base, reminders: 1 }, "Europe/Berlin")).toBe("zweite Erinnerung am 19.10.2026");
    expect(reminderLine({ ...base, reminders: 2 }, "Europe/Berlin")).toBe("schließe ich am 19.10.2026");
    expect(reminderLine({ ...base, nextReminderAt: undefined }, "UTC")).toBeNull();
  });

  test("in der Liste je Faden in der Meta-Zeile", () => {
    const text = formatThreadList([base, { ...base, id: "B2", nr: 2, reminders: 1, createdAt: base.createdAt - 1 }], { enabled: true, now, timeZone: "UTC" });
    expect(text).toContain("1. Reiseziel\n   Frage: Hamburg oder München?\n   Direktchat · seit 1 Tag · Erinnerung am 18.10.2026");
    expect(text).toContain("2. Reiseziel\n   Frage: Hamburg oder München?\n   Direktchat · seit 1 Tag · zweite Erinnerung am 18.10.2026");
  });
});
