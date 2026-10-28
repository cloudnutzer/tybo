/**
 * Issue #20: onMessageSaved und msgId, seit #314 direkt aus dem Store
 * (store/events.ts, saveAndAnnounce in store/message-rules.ts).
 * Gespeichert wird über eine Attrappe (saveAndAnnounce), kein Netz.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { resetStore, storeOr } from "../src/lib/store";
import { emitMessageSaved, onMessageSaved, type SavedMessageEvent } from "../src/lib/store/events";
import { saveAndAnnounce } from "../src/lib/store/message-rules";
import type { Message } from "../src/lib/store/types";


const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const cleanups: (() => void)[] = [];

function listen(listener: (e: SavedMessageEvent) => void | Promise<void>): void {
  cleanups.push(onMessageSaved(listener));
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function fakeBackend(result = true) {
  const saved: Message[] = [];
  return {
    saved,
    persist: async (m: Message) => {
      saved.push(m);
      return result;
    },
  };
}

test("Zuhörer bekommt die Nachricht genau einmal, mit msgId als UUID", async () => {
  const events: SavedMessageEvent[] = [];
  listen(e => {
    events.push(e);
  });
  const backend = fakeBackend();
  const ok = await saveAndAnnounce(
    { chat_id: "-100777", role: "user", content: "Hallo", metadata: { topicId: 443, messageId: 99 } },
    backend.persist
  );
  expect(ok).toBe(true);
  expect(events).toHaveLength(1);
  const [e] = events;
  expect(e.chatId).toBe("-100777");
  expect(e.role).toBe("user");
  expect(e.content).toBe("Hallo");
  expect(e.metadata.topicId).toBe(443);
  // Telegram-Nachrichten-ID bleibt, msgId kommt dazu
  expect(e.metadata.messageId).toBe(99);
  expect(String(e.metadata.msgId)).toMatch(UUID);
  expect(Number.isFinite(Date.parse(e.createdAt))).toBe(true);
  // Gespeichert wird dieselbe msgId, die der Zuhörer sieht
  expect(backend.saved[0].metadata?.msgId).toBe(e.metadata.msgId);
});

test("vorhandene msgId wird nicht überschrieben", async () => {
  const events: SavedMessageEvent[] = [];
  listen(e => {
    events.push(e);
  });
  const backend = fakeBackend();
  await saveAndAnnounce(
    { chat_id: "1", role: "assistant", content: "x", metadata: { msgId: "web-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed" } },
    backend.persist
  );
  expect(backend.saved[0].metadata?.msgId).toBe("web-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed");
  expect(events[0].metadata.msgId).toBe("web-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed");
});

test("ohne metadata wird eine angelegt, das Original bleibt unverändert", async () => {
  const backend = fakeBackend();
  const message: Message = { chat_id: "1", role: "user", content: "x" };
  await saveAndAnnounce(message, backend.persist);
  expect(message.metadata).toBeUndefined();
  expect(String(backend.saved[0].metadata?.msgId)).toMatch(UUID);
});

test("jede Nachricht bekommt eine eigene msgId", async () => {
  const backend = fakeBackend();
  await saveAndAnnounce({ chat_id: "1", role: "user", content: "a" }, backend.persist);
  await saveAndAnnounce({ chat_id: "1", role: "user", content: "b" }, backend.persist);
  expect(backend.saved[0].metadata?.msgId).not.toBe(backend.saved[1].metadata?.msgId);
});

test("kein Ereignis, wenn das Speichern false liefert", async () => {
  let calls = 0;
  listen(() => {
    calls++;
  });
  const ok = await saveAndAnnounce({ chat_id: "1", role: "user", content: "x" }, fakeBackend(false).persist);
  expect(ok).toBe(false);
  expect(calls).toBe(0);
});

test("kein Ereignis, wenn das Speichern wirft; der Fehler geht wie bisher an den Aufrufer", async () => {
  let calls = 0;
  listen(() => {
    calls++;
  });
  await expect(
    saveAndAnnounce({ chat_id: "1", role: "user", content: "x" }, async () => {
      throw new Error("kaputt");
    })
  ).rejects.toThrow("kaputt");
  expect(calls).toBe(0);
});

test("kein Ereignis ohne Backend (SUPABASE_URL fehlt)", async () => {
  const saved = { supabase: process.env.SUPABASE_URL };
  delete process.env.SUPABASE_URL;
  resetStore();
  try {
    let calls = 0;
    listen(() => {
      calls++;
    });
    expect(await storeOr(false, store => store.messages.save({ chat_id: "1", role: "user", content: "x" }))).toBe(false);
    expect(calls).toBe(0);
  } finally {
    if (saved.supabase !== undefined) process.env.SUPABASE_URL = saved.supabase;
    resetStore();
  }
});

test("werfender oder ablehnender Zuhörer verhindert weder Speichern noch andere Zuhörer", async () => {
  const seen: string[] = [];
  listen(() => {
    throw new Error("Zuhörer kaputt");
  });
  listen(async () => {
    throw new Error("Zuhörer async kaputt");
  });
  listen(e => {
    seen.push(e.content);
  });
  const backend = fakeBackend();
  const ok = await saveAndAnnounce({ chat_id: "1", role: "user", content: "trotzdem" }, backend.persist);
  expect(ok).toBe(true);
  expect(backend.saved).toHaveLength(1);
  expect(seen).toEqual(["trotzdem"]);
  // Abgelehnte Promise darf nicht als unbehandelter Fehler hochkommen
  await new Promise(resolve => setTimeout(resolve, 5));
});

test("Abmeldung: danach keine Ereignisse mehr", async () => {
  let calls = 0;
  const off = onMessageSaved(() => {
    calls++;
  });
  const backend = fakeBackend();
  await saveAndAnnounce({ chat_id: "1", role: "user", content: "a" }, backend.persist);
  off();
  off();
  await saveAndAnnounce({ chat_id: "1", role: "user", content: "b" }, backend.persist);
  expect(calls).toBe(1);
});

// ---------------------------------------------------------------------------
// Issue #308: Die Zuhörer-Liste liegt in src/lib/store/events.ts, seit #314
// die einzige Importstelle.
// ---------------------------------------------------------------------------

describe("gemeinsame Zuhörer-Liste über store/events.ts", () => {
  test("über events.ts angemeldet: Ereignis aus saveMessageWith genau einmal", async () => {
    const events: SavedMessageEvent[] = [];
    cleanups.push(
      onMessageSaved(e => {
        events.push(e);
      })
    );
    const ok = await saveAndAnnounce({ chat_id: "5", role: "assistant", content: "neu" }, fakeBackend().persist);
    expect(ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].chatId).toBe("5");
    expect(events[0].content).toBe("neu");
    expect(String(events[0].metadata.msgId)).toMatch(UUID);
  });

  test("Ereignis aus emitMessageSaved genau einmal", () => {
    const seen: string[] = [];
    listen(e => {
      seen.push(e.content);
    });
    emitMessageSaved({ chatId: "5", role: "user", content: "direkt", metadata: { msgId: "m-1" }, createdAt: "2026-10-16T15:00:00.000Z" });
    expect(seen).toEqual(["direkt"]);
  });

  test("kein Ereignis bei false oder Ausnahme für über events.ts angemeldete Zuhörer", async () => {
    let calls = 0;
    cleanups.push(
      onMessageSaved(() => {
        calls++;
      })
    );
    expect(await saveAndAnnounce({ chat_id: "1", role: "user", content: "x" }, fakeBackend(false).persist)).toBe(false);
    await expect(
      saveAndAnnounce({ chat_id: "1", role: "user", content: "x" }, async () => {
        throw new Error("kaputt");
      })
    ).rejects.toThrow("kaputt");
    expect(calls).toBe(0);
  });

  test("werfender Zuhörer bleibt isoliert, auch beim direkten emitMessageSaved", async () => {
    const seen: string[] = [];
    cleanups.push(
      onMessageSaved(() => {
        throw new Error("Zuhörer kaputt");
      })
    );
    cleanups.push(onMessageSaved(() => Promise.reject(new Error("abgelehnt"))));
    listen(e => {
      seen.push(e.content);
    });
    expect(() =>
      emitMessageSaved({ chatId: "1", role: "user", content: "weiter", metadata: {}, createdAt: "2026-10-16T15:00:00.000Z" })
    ).not.toThrow();
    expect(seen).toEqual(["weiter"]);
    await new Promise(resolve => setTimeout(resolve, 5));
  });

  test("Benachrichtigung ist synchron und wartet nicht auf Promises der Zuhörer", () => {
    const order: string[] = [];
    cleanups.push(
      onMessageSaved(async () => {
        order.push("start");
        await new Promise(resolve => setTimeout(resolve, 1));
        order.push("ende");
      })
    );
    emitMessageSaved({ chatId: "1", role: "user", content: "x", metadata: {}, createdAt: "2026-10-16T15:00:00.000Z" });
    order.push("zurück");
    expect(order).toEqual(["start", "zurück"]);
  });

  test("während der Benachrichtigung gilt eine Momentaufnahme der Liste", () => {
    const seen: string[] = [];
    let offLate: (() => void) | undefined;
    const offSecond = onMessageSaved(() => {
      seen.push("zweiter");
    });
    cleanups.unshift(offSecond);
    // Der erste meldet den zweiten ab und einen neuen an: beides wirkt erst beim nächsten Mal
    const offFirst = onMessageSaved(() => {
      seen.push("erster");
      offSecond();
      offLate ??= onMessageSaved(() => {
        seen.push("neu");
      });
    });
    // Reihenfolge der Anmeldung: zweiter vor erstem
    cleanups.push(offFirst, () => offLate?.());
    emitMessageSaved({ chatId: "1", role: "user", content: "x", metadata: {}, createdAt: "2026-10-16T15:00:00.000Z" });
    expect(seen).toEqual(["zweiter", "erster"]);
    seen.length = 0;
    emitMessageSaved({ chatId: "1", role: "user", content: "y", metadata: {}, createdAt: "2026-10-16T15:00:00.000Z" });
    expect(seen).toEqual(["erster", "neu"]);
  });
});
