// ChatHub mit der Ablage für Telegram-Gespräche (Issue #19): keine Datei,
// IDs als msgId (web-<uuid>) durch POST, Turn und Antwort durchgereicht.
import { describe, expect, test } from "bun:test";
import { ChatHub, TURN_FAILED_TEXT, type RunTurnOptions, type TurnResult } from "../src/web/chat";
import { createTelegramMessageLog, isWebMessageId } from "../src/web/telegram";

function collect(hub: ChatHub, id: string) {
  const events: { event: string; data: any }[] = [];
  const controller = new AbortController();
  const res = hub.subscribe(id, controller.signal);
  const reader = res.body!.getReader();
  let buffer = "";
  const done = (async () => {
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
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
  return {
    events,
    async close() {
      controller.abort();
      await reader.cancel().catch(() => {});
      await done;
    },
  };
}

describe("ChatHub mit Telegram-Ablage", () => {
  test("Nutzernachricht bekommt eine web-ID, der Turn sieht sie, die Antwort trägt die ID des Turns", async () => {
    const seen: RunTurnOptions[] = [];
    const replyId = "web-11111111-2222-4333-8444-555555555555";
    const hub = new ChatHub({
      store: createTelegramMessageLog(),
      chat: {
        async runTurn(opts): Promise<TurnResult> {
          seen.push(opts);
          return { text: "Antwort", messageId: replyId };
        },
        stop() {},
      },
    });
    const sse = collect(hub, "topic-443");
    const result = await hub.send({ id: "topic-443", agent: "cto" }, "Frage");
    expect(result.status).toBe("started");
    if (result.status !== "started") throw new Error();
    expect(isWebMessageId(result.message.id)).toBe(true);
    expect(result.message).toMatchObject({ role: "user", text: "Frage" });
    await hub.idle();
    await sse.close();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ conversationId: "topic-443", agent: "cto", text: "Frage", messageId: result.message.id });
    const message = sse.events.find(e => e.event === "message")!.data;
    expect(message).toMatchObject({ id: replyId, role: "assistant", text: "Antwort" });
    expect(message.html).toContain("Antwort");
    expect(sse.events.at(-1)).toEqual({ event: "status", data: { running: false } });
  });

  test("Ohne gültige Wunsch-ID eine neue; failed wird Fehlermeldung, ohne Text der Standardtext", async () => {
    const log = createTelegramMessageLog(() => Date.parse("2026-09-23T20:00:00Z"));
    const stored = await log.appendMessage("dm", { role: "assistant", text: "x", id: "../böse" });
    expect(isWebMessageId(stored.id)).toBe(true);
    expect(stored.createdAt).toBe("2026-09-23T20:00:00.000Z");

    const results: TurnResult[] = [{ text: "Nicht nach Telegram gesendet", failed: true }, { text: "", failed: true }];
    const hub = new ChatHub({
      store: log,
      chat: { runTurn: async () => results.shift()!, stop() {} },
    });
    const sse = collect(hub, "dm");
    await hub.send({ id: "dm", agent: "general" }, "eins");
    await hub.idle();
    await hub.send({ id: "dm", agent: "general" }, "zwei");
    await hub.idle();
    await sse.close();
    const errors = sse.events.filter(e => e.event === "error").map(e => e.data.text);
    expect(errors).toEqual(["Nicht nach Telegram gesendet", TURN_FAILED_TEXT]);
  });
});

describe("toTelegramApiMessage mit web-IDs", () => {
  test("gültige web-ID wird übernommen, alles andere fällt auf db-<Zeile> zurück", async () => {
    const { toTelegramApiMessage } = await import("../src/web/bot-telegram");
    const row = (msgId: unknown) => ({ id: "r1", created_at: "2026-09-23T10:00:00+00:00", role: "user", content: "x", metadata: { msgId } });
    const id = "web-11111111-2222-4333-8444-555555555555";
    expect(toTelegramApiMessage(row(id))?.id).toBe(id);
    for (const bad of ["web-", "web-xyz", `${id}x`, "WEB-11111111-2222-4333-8444-555555555555", "<b>"]) {
      expect(toTelegramApiMessage(row(bad))?.id).toBe("db-r1");
    }
  });
});
