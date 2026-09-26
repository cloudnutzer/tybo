/**
 * Issue #20: onMessageSaved und msgId in src/lib/convex.ts.
 * Gespeichert wird über eine Attrappe (saveMessageWith), kein Netz.
 */
import { afterEach, expect, test } from "bun:test";
import {
  onMessageSaved,
  saveMessage,
  saveMessageWith,
  type Message,
  type SavedMessageEvent,
} from "../src/lib/convex";

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
  const ok = await saveMessageWith(
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
  await saveMessageWith(
    { chat_id: "1", role: "assistant", content: "x", metadata: { msgId: "web-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed" } },
    backend.persist
  );
  expect(backend.saved[0].metadata?.msgId).toBe("web-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed");
  expect(events[0].metadata.msgId).toBe("web-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed");
});

test("ohne metadata wird eine angelegt, das Original bleibt unverändert", async () => {
  const backend = fakeBackend();
  const message: Message = { chat_id: "1", role: "user", content: "x" };
  await saveMessageWith(message, backend.persist);
  expect(message.metadata).toBeUndefined();
  expect(String(backend.saved[0].metadata?.msgId)).toMatch(UUID);
});

test("jede Nachricht bekommt eine eigene msgId", async () => {
  const backend = fakeBackend();
  await saveMessageWith({ chat_id: "1", role: "user", content: "a" }, backend.persist);
  await saveMessageWith({ chat_id: "1", role: "user", content: "b" }, backend.persist);
  expect(backend.saved[0].metadata?.msgId).not.toBe(backend.saved[1].metadata?.msgId);
});

test("kein Ereignis, wenn das Speichern false liefert", async () => {
  let calls = 0;
  listen(() => {
    calls++;
  });
  const ok = await saveMessageWith({ chat_id: "1", role: "user", content: "x" }, fakeBackend(false).persist);
  expect(ok).toBe(false);
  expect(calls).toBe(0);
});

test("kein Ereignis, wenn das Speichern wirft; der Fehler geht wie bisher an den Aufrufer", async () => {
  let calls = 0;
  listen(() => {
    calls++;
  });
  await expect(
    saveMessageWith({ chat_id: "1", role: "user", content: "x" }, async () => {
      throw new Error("kaputt");
    })
  ).rejects.toThrow("kaputt");
  expect(calls).toBe(0);
});

test("kein Ereignis ohne Backend (weder CONVEX_URL noch SUPABASE_URL)", async () => {
  const saved = { convex: process.env.CONVEX_URL, supabase: process.env.SUPABASE_URL };
  delete process.env.CONVEX_URL;
  delete process.env.SUPABASE_URL;
  try {
    let calls = 0;
    listen(() => {
      calls++;
    });
    expect(await saveMessage({ chat_id: "1", role: "user", content: "x" })).toBe(false);
    expect(calls).toBe(0);
  } finally {
    if (saved.convex !== undefined) process.env.CONVEX_URL = saved.convex;
    if (saved.supabase !== undefined) process.env.SUPABASE_URL = saved.supabase;
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
  const ok = await saveMessageWith({ chat_id: "1", role: "user", content: "trotzdem" }, backend.persist);
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
  await saveMessageWith({ chat_id: "1", role: "user", content: "a" }, backend.persist);
  off();
  off();
  await saveMessageWith({ chat_id: "1", role: "user", content: "b" }, backend.persist);
  expect(calls).toBe(1);
});
