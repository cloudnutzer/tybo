/**
 * Issue #328, Aufgabe 2: sendRendered und die Übertragungen in
 * src/channels/telegram/send.ts, direkt gegen Attrappen. Kein Netz,
 * src/bot.ts wird nie importiert.
 */
import { describe, expect, test } from "bun:test";
import { Api, Context, GrammyError, HttpError } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import {
  createTypingIndicator,
  deliveryFromError,
  deliveryFromResponse,
  deliveryReason,
  piecesFor,
  sendRendered,
  transmitViaApi,
  transmitViaBotApi,
  transmitViaReply,
  TYPING_REFRESH_MS,
  type Delivery,
  type OutgoingMessage,
  type Transmit,
} from "../src/channels/telegram/send";

const PARA = "Gleicher Absatz " + "wort ".repeat(480).trim();
/** Über 4.096 Zeichen, drei gleiche Stücke */
const SAME = [PARA, PARA, PARA].join("\n\n");
const KEYBOARD = { inline_keyboard: [[{ text: "Ja", callback_data: "ja" }]] };
const NO_PREVIEW = { is_disabled: true };

/** Übertragung als Attrappe: zeichnet auf, antwortet nach Regel */
function recorder(answer: (m: OutgoingMessage, i: number) => Delivery | Error = () => ({ outcome: "accepted" })) {
  const sent: OutgoingMessage[] = [];
  const transmit: Transmit = async m => {
    sent.push(m);
    const a = answer(m, sent.length - 1);
    if (a instanceof Error) throw a;
    return a;
  };
  return { sent, transmit };
}

const ok = (messageId?: number): Delivery => ({ outcome: "accepted", messageId });
const rejected = (status: number): Delivery => ({ outcome: "rejected", status });
const unclear = (status?: number): Delivery => ({ outcome: "unclear", status });
const rejectHtml = (m: OutgoingMessage, i: number): Delivery => (m.parse_mode === "HTML" ? rejected(400) : ok(i + 1));

describe("piecesFor", () => {
  test("Markdown: HTML-Stücke; Klartext: bereinigt, ungeteilt umgewandelt", () => {
    expect(piecesFor("**a** < b", "markdown")).toEqual(["<b>a</b> &lt; b"]);
    expect(piecesFor("**a** < b ![x](https://a.b/geheim)​", "plain")).toEqual(["**a** < b x"]);
    expect(piecesFor(SAME, "markdown")).toHaveLength(3);
    expect(piecesFor("", "markdown")).toEqual([]);
  });
});

describe("sendRendered", () => {
  test("Markdown: jedes Stück HTML, Vorschau aus, Chat; ohne Thread-ID kein Feld", async () => {
    const r = recorder((_m, i) => ok(10 + i));
    const report = await sendRendered({ text: SAME, format: "markdown", chatId: 5, transmit: r.transmit });
    expect(r.sent).toHaveLength(3);
    for (const m of r.sent) {
      expect(m).toMatchObject({ chat_id: 5, parse_mode: "HTML", link_preview_options: NO_PREVIEW });
      expect("message_thread_id" in m).toBe(false);
      expect("reply_markup" in m).toBe(false);
    }
    expect(report).toEqual({
      total: 3,
      complete: true,
      pieces: [0, 1, 2].map(index => ({ index, delivery: ok(10 + index), keyboard: false })),
    });
  });

  test("Thread-ID an jedem Stück, auch im Rückfall", async () => {
    const r = recorder(rejectHtml);
    await sendRendered({ text: SAME, format: "markdown", chatId: 5, threadId: 9, transmit: r.transmit });
    expect(r.sent).toHaveLength(6);
    expect(r.sent.every(m => m.message_thread_id === 9 && m.link_preview_options.is_disabled)).toBe(true);
  });

  test("gleiche Stücke: Knöpfe genau einmal, per Position am letzten, auch im Klartext-Rückfall", async () => {
    const plain = recorder();
    const r1 = await sendRendered({ text: SAME, format: "markdown", chatId: 5, keyboard: KEYBOARD, transmit: plain.transmit });
    expect(new Set(plain.sent.map(m => m.text)).size).toBe(1);
    expect(plain.sent.map(m => m.reply_markup)).toEqual([undefined, undefined, KEYBOARD]);
    expect(r1.pieces.map(p => p.keyboard)).toEqual([false, false, true]);

    const fallback = recorder(rejectHtml);
    const r2 = await sendRendered({ text: SAME, format: "markdown", chatId: 5, keyboard: KEYBOARD, transmit: fallback.transmit });
    const accepted = fallback.sent.filter(m => m.parse_mode === undefined);
    expect(accepted.map(m => m.reply_markup)).toEqual([undefined, undefined, KEYBOARD]);
    // Der abgelehnte HTML-Versuch des letzten Stücks trägt sie auch, die früheren nicht
    expect(fallback.sent.filter(m => m.parse_mode === "HTML").map(m => m.reply_markup)).toEqual([undefined, undefined, KEYBOARD]);
    expect(r2.complete).toBe(true);
    expect(r2.pieces.map(p => p.keyboard)).toEqual([false, false, true]);
  });

  test("Knöpfe werden unverändert weitergegeben (dasselbe Objekt)", async () => {
    const r = recorder();
    const keyboard = { inline_keyboard: [] };
    await sendRendered({ text: "x", format: "markdown", chatId: 1, keyboard, transmit: r.transmit });
    expect(r.sent[0].reply_markup).toBe(keyboard);
  });

  test("Rückfall bei jedem Fehler: auch bei unklarem Ausgang und geworfenem Fehler", async () => {
    for (const first of [unclear(), unclear(502), rejected(403), new Error("weg")]) {
      const r = recorder((_m, i) => (i === 0 ? first : ok(7)));
      const report = await sendRendered({ text: "**a** < b", format: "markdown", chatId: 1, transmit: r.transmit });
      expect(r.sent.map(m => m.text)).toEqual(["<b>a</b> &lt; b", "a < b"]);
      expect(r.sent[1].parse_mode).toBeUndefined();
      expect(r.sent[1].link_preview_options).toEqual(NO_PREVIEW);
      expect(report.pieces[0].delivery).toEqual(ok(7));
      expect(report.pieces[0].htmlAttempt?.outcome).toBe(first instanceof Error ? "unclear" : (first as Delivery).outcome);
    }
  });

  test("Rückfall nur bei 400: andere Ausgänge bleiben ohne zweiten Versand", async () => {
    for (const first of [unclear(), unclear(502), rejected(403), rejected(429), new Error("weg")]) {
      const r = recorder((_m, i) => (i === 0 ? first : ok()));
      const report = await sendRendered({ text: "a", format: "markdown", chatId: 1, transmit: r.transmit, plainRetry: "on-bad-request" });
      expect(r.sent).toHaveLength(1);
      expect(report.complete).toBe(false);
    }
    // 400 zählt, auch als unklarer Ausgang (unlesbarer Antwortkörper)
    for (const first of [rejected(400), unclear(400)]) {
      const r = recorder((_m, i) => (i === 0 ? first : ok()));
      await sendRendered({ text: "a", format: "markdown", chatId: 1, transmit: r.transmit, plainRetry: "on-bad-request" });
      expect(r.sent).toHaveLength(2);
    }
  });

  test("Klartext: kein parse_mode, nie ein Rückfall", async () => {
    const r = recorder(() => rejected(400));
    const report = await sendRendered({ text: "a < b", format: "plain", chatId: 1, transmit: r.transmit });
    expect(r.sent).toEqual([{ chat_id: 1, text: "a < b", link_preview_options: NO_PREVIEW }]);
    expect(report.pieces[0].htmlAttempt).toBeUndefined();
  });

  test("weitermachen nach gescheitertem Stück (Standard) oder abbrechen", async () => {
    const failSecond = (_m: OutgoingMessage, i: number) => (i === 1 ? unclear() : ok(i));
    const goOn = recorder(failSecond);
    const r1 = await sendRendered({ text: SAME, format: "plain", chatId: 1, transmit: goOn.transmit });
    expect(goOn.sent).toHaveLength(3);
    expect(r1.pieces.map(p => p.delivery.outcome)).toEqual(["accepted", "unclear", "accepted"]);
    expect(r1.complete).toBe(false);

    const stop = recorder(failSecond);
    const r2 = await sendRendered({ text: SAME, format: "plain", chatId: 1, transmit: stop.transmit, afterFailure: "stop" });
    expect(stop.sent).toHaveLength(2);
    expect(r2.total).toBe(3);
    expect(r2.pieces).toHaveLength(2);
    expect(r2.complete).toBe(false);
  });

  test("Abbruch zählt erst nach dem Rückfall", async () => {
    const r = recorder((m, i) => (m.parse_mode === "HTML" && i === 0 ? rejected(400) : ok(i)));
    const report = await sendRendered({ text: SAME, format: "markdown", chatId: 1, transmit: r.transmit, afterFailure: "stop", plainRetry: "on-bad-request" });
    expect(r.sent).toHaveLength(4);
    expect(report.complete).toBe(true);
  });

  test("leerer Text: nichts gesendet, nichts gescheitert", async () => {
    const r = recorder();
    expect(await sendRendered({ text: "", format: "markdown", chatId: 1, transmit: r.transmit })).toEqual({ total: 0, pieces: [], complete: true });
    expect(r.sent).toEqual([]);
  });
});

describe("Ausgänge", () => {
  test("deliveryFromResponse: 2xx angenommen, ID nur wenn lesbar", async () => {
    expect(await deliveryFromResponse(new Response(JSON.stringify({ ok: true, result: { message_id: 12 } })))).toEqual(ok(12));
    for (const body of ["kein json", "{}", JSON.stringify({ ok: true, result: { message_id: "12" } }), JSON.stringify({ ok: true, result: { message_id: -1 } })]) {
      expect(await deliveryFromResponse(new Response(body, { status: 200 }))).toEqual(ok(undefined));
    }
  });

  test("deliveryFromResponse: 4xx mit ok: false abgelehnt, sonst unklar", async () => {
    const res = (status: number, body: string) => deliveryFromResponse(new Response(body, { status }));
    const no = JSON.stringify({ ok: false, description: "Forbidden" });
    expect(await res(403, no)).toEqual({ outcome: "rejected", status: 403, detail: "Forbidden" });
    expect((await res(429, no)).outcome).toBe("rejected");
    expect(await res(400, "kaputt")).toEqual({ outcome: "unclear", status: 400, detail: undefined });
    expect((await res(403, "{}")).outcome).toBe("unclear");
    expect((await res(502, no)).outcome).toBe("unclear");
  });

  test("deliveryFromError: GrammyError mit 4xx abgelehnt, 5xx und Netzfehler unklar", () => {
    const grammy = (code: number) => new GrammyError("x", { ok: false, error_code: code, description: "d" }, "sendMessage", {});
    expect(deliveryFromError(grammy(400))).toEqual({ outcome: "rejected", status: 400, detail: "d" });
    expect(deliveryFromError(grammy(500))).toMatchObject({ outcome: "unclear", status: 500 });
    expect(deliveryFromError(new HttpError("x", new Error("Netz")))).toMatchObject({ outcome: "unclear" });
    expect(deliveryFromError(new HttpError("x", new Error("Netz"))).outcome).toBe("unclear");
  });

  test("deliveryReason: Status oder Fehlername, nie Inhalt", () => {
    expect(deliveryReason(rejected(403))).toBe("HTTP 403");
    expect(deliveryReason({ outcome: "unclear", error: new TypeError("geheim") })).toBe("TypeError");
    expect(deliveryReason({ outcome: "unclear", error: "geheim" })).toBe("unbekannt");
  });
});

describe("Übertragungen", () => {
  test("transmitViaBotApi: URL mit Token, Nutzlast durch den Output-Guard, Zeitlimit wenn gesetzt", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const transmit = transmitViaBotApi({
      token: "123:t",
      timeoutMs: 1000,
      fetch: async (url, init) => {
        seen.push({ url, init });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 3 } }));
      },
    });
    const d = await transmit({ chat_id: "1", text: "a​b", link_preview_options: NO_PREVIEW });
    expect(d).toEqual(ok(3));
    expect(seen[0].url).toBe("https://api.telegram.org/bot123:t/sendMessage");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ chat_id: "1", text: "ab", link_preview_options: NO_PREVIEW });
    expect(seen[0].init.signal).toBeInstanceOf(AbortSignal);

    const noTimeout = transmitViaBotApi({ token: "1:t", fetch: async (_u, init) => (seen.push({ url: "", init }), new Response("{}")) });
    await noTimeout({ chat_id: 1, text: "x", link_preview_options: NO_PREVIEW });
    expect(seen[1].init.signal).toBeUndefined();
  });

  test("transmitViaBotApi: geworfener Netzfehler wird in sendRendered unklar", async () => {
    const transmit = transmitViaBotApi({ token: "1:t", fetch: async () => { throw new TypeError("Netz weg"); } });
    const report = await sendRendered({ text: "a", format: "markdown", chatId: 1, transmit, plainRetry: "on-bad-request" });
    expect(report.pieces[0].delivery).toMatchObject({ outcome: "unclear" });
    expect(deliveryReason(report.pieces[0].delivery)).toBe("TypeError");
  });

  function fakeApi(fail = false) {
    const api = new Api("123:test");
    const calls: { method: string; payload: Record<string, any> }[] = [];
    api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, any> });
      if (fail) throw new GrammyError("x", { ok: false, error_code: 400, description: "Bad Request" }, method, payload as any);
      return { ok: true, result: { message_id: 77, date: 0, chat: { id: 1, type: "private" } } } as any;
    });
    return { api, calls };
  }

  test("transmitViaApi: sendMessage mit allen Feldern, ID aus dem Ergebnis; GrammyError abgelehnt", async () => {
    const { api, calls } = fakeApi();
    const d = await transmitViaApi(api)({ chat_id: 5, text: "x", message_thread_id: 3, parse_mode: "HTML", link_preview_options: NO_PREVIEW, reply_markup: KEYBOARD });
    expect(d).toEqual(ok(77));
    expect(calls[0]).toEqual({ method: "sendMessage", payload: { chat_id: 5, text: "x", message_thread_id: 3, parse_mode: "HTML", link_preview_options: NO_PREVIEW, reply_markup: KEYBOARD } });
    const failing = fakeApi(true);
    expect(await transmitViaApi(failing.api)({ chat_id: 5, text: "x", link_preview_options: NO_PREVIEW })).toMatchObject({ outcome: "rejected", status: 400 });
  });

  test("transmitViaReply: an den Chat des Updates, im Topic mit dessen Thread-ID", async () => {
    const { api, calls } = fakeApi();
    const ME = { id: 42, is_bot: true, first_name: "T", username: "t_bot" } as UserFromGetMe;
    const update = {
      update_id: 1,
      message: { message_id: 7, date: 0, chat: { id: -100, type: "supergroup", title: "G" }, text: "hi", is_topic_message: true, message_thread_id: 31 },
    } as Update;
    const d = await transmitViaReply(new Context(update, api, ME))({ chat_id: 0, text: "x", link_preview_options: NO_PREVIEW });
    expect(d).toEqual(ok(77));
    expect(calls[0].payload).toMatchObject({ chat_id: -100, message_thread_id: 31, text: "x", link_preview_options: NO_PREVIEW });
  });
});

describe("createTypingIndicator", () => {
  test("typing sofort und je Periode, stop beendet, erneuter Start ersetzt den Zeitgeber", async () => {
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const timers = new Map<number, { fn: () => void; ms: number }>();
    let id = 0;
    globalThis.setInterval = ((fn: () => void, ms: number) => (timers.set(++id, { fn, ms }), id)) as unknown as typeof setInterval;
    globalThis.clearInterval = ((t: number) => void timers.delete(t)) as unknown as typeof clearInterval;
    try {
      const actions: string[] = [];
      const typing = createTypingIndicator({ replyWithChatAction: (async (a: string) => (actions.push(a), true)) as any });
      typing.start();
      expect(actions).toEqual(["typing"]);
      expect([...timers.values()].map(t => t.ms)).toEqual([TYPING_REFRESH_MS]);
      for (const t of timers.values()) t.fn();
      expect(actions).toEqual(["typing", "typing"]);
      typing.start();
      expect(timers.size).toBe(1);
      typing.stop();
      typing.stop();
      expect(timers.size).toBe(0);
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }
  });
});
