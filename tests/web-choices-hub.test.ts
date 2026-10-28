/**
 * ChatHub und Rückfragen (Issue #115): Nachrichten mit choiceId werden vor
 * dem Senden ergänzt (decorate), spätere Ereignisse des Gesprächs warten so
 * lange; ohne decorate oder bei einem Lesefehler fällt choiceId weg.
 */
import { describe, expect, test } from "bun:test";
import { ChatHub, type ApiMessage } from "../src/web/chat";
import { createTelegramMessageLog } from "../src/web/telegram";

function reader(hub: ChatHub, id: string) {
  const controller = new AbortController();
  const res = hub.subscribe(id, controller.signal, { initialStatus: false });
  const events: { event: string; data: any }[] = [];
  const r = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    for (;;) {
      const { done, value } = await r.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      buffer += decoder.decode(value);
      let i: number;
      while ((i = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const event = /^event: (.+)$/m.exec(chunk)?.[1];
        const data = /^data: (.+)$/m.exec(chunk)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
    }
  })();
  return { events, close: () => controller.abort() };
}

const message = (over: Partial<ApiMessage> = {}): ApiMessage => ({
  id: "m1",
  role: "assistant",
  text: "Erlauben?",
  createdAt: new Date().toISOString(),
  kind: "notice",
  ...over,
});

describe("ChatHub: decorate", () => {
  test("Nachricht mit choiceId kommt ergänzt und vor später veröffentlichten Ereignissen", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const hub = new ChatHub({
      store: createTelegramMessageLog(),
      decorate: async (_id, m) => {
        await gate;
        const { choiceId, ...rest } = m;
        return { ...rest, choice: { id: choiceId!, options: [{ key: "ok", label: "Erlauben" }], state: "open" } };
      },
    });
    const s = reader(hub, "dm");
    await Bun.sleep(5);
    hub.publishMessage("dm", message({ choiceId: "Abc123" }));
    hub.publishChoice("dm", { conversationId: "dm", choice: { id: "Abc123", options: [], state: "done" } });
    hub.publishMessage("dm", message({ id: "m2", text: "ohne Rückfrage" }));
    await Bun.sleep(5);
    expect(s.events).toEqual([]);
    release();
    await Bun.sleep(10);
    expect(s.events.map(e => e.event)).toEqual(["message", "choice", "message"]);
    expect(s.events[0].data.choice).toEqual({ id: "Abc123", options: [{ key: "ok", label: "Erlauben" }], state: "open" });
    expect(s.events[0].data.choiceId).toBeUndefined();
    // Danach wieder sofort
    hub.publishChoice("dm", { conversationId: "dm", choice: { id: "x", options: [], state: "expired" } });
    await Bun.sleep(5);
    expect(s.events).toHaveLength(4);
    s.close();
  });

  test("ohne decorate fällt choiceId weg; Lesefehler: Nachricht ohne choice, aber mit choiceId", async () => {
    const plain = new ChatHub({ store: createTelegramMessageLog() });
    const a = reader(plain, "dm");
    await Bun.sleep(5);
    plain.publishMessage("dm", message({ choiceId: "Abc123" }));
    await Bun.sleep(5);
    expect(a.events[0].data.choiceId).toBeUndefined();
    expect(a.events[0].data.choice).toBeUndefined();
    a.close();

    const logs: string[] = [];
    const failing = new ChatHub({ store: createTelegramMessageLog(), log: m => logs.push(m), decorate: async () => { throw new Error("kaputt"); } });
    const b = reader(failing, "dm");
    await Bun.sleep(5);
    failing.publishMessage("dm", message({ choiceId: "Abc123" }));
    await Bun.sleep(10);
    expect(b.events[0].data).toMatchObject({ id: "m1", text: "Erlauben?" });
    expect(b.events[0].data.choice).toBeUndefined();
    // Die Kennung bleibt, damit der Browser den Stand nachholen kann
    expect(b.events[0].data.choiceId).toBe("Abc123");
    expect(logs.join("\n")).toContain("Rückfrage");
    b.close();
  });

  test("Telegram-Ablage übernimmt choiceId nur bei Antworten mit gültiger Kennung", async () => {
    const log = createTelegramMessageLog();
    expect((await log.appendMessage("dm", { role: "assistant", text: "x", choiceId: "Abc123" })).choiceId).toBe("Abc123");
    expect((await log.appendMessage("dm", { role: "assistant", text: "x", choiceId: "../x" })).choiceId).toBeUndefined();
    expect((await log.appendMessage("dm", { role: "user", text: "x", choiceId: "Abc123" })).choiceId).toBeUndefined();
  });
});
