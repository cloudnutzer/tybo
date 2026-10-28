import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sendAndRecord, type OutboxDeps } from "../src/lib/outbox";

// Issue #292, Aufgabe 4: error.rejected nur, wenn Telegram das gescheiterte
// Stück sicher abgelehnt hat (4xx mit ok: false, auch 429). Netzfehler,
// Zeitüberschreitung, 5xx und unlesbare Antworten setzen es nicht.

const USER = "4711";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "outbox-rejected-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Reply = { status: number; body?: string } | Error;

function deps(replies: Reply[]): { deps: OutboxDeps; calls: number } {
  const state = { deps: undefined as unknown as OutboxDeps, calls: 0 };
  state.deps = {
    botToken: "123:test",
    userId: USER,
    groupId: null,
    outboxDir: join(dir, "outbox"),
    fetch: async () => {
      const r = replies[Math.min(state.calls, replies.length - 1)];
      state.calls++;
      if (r instanceof Error) throw r;
      return new Response(r.body ?? JSON.stringify(r.status < 300 ? { ok: true, result: { message_id: 10 + state.calls } } : { ok: false, error_code: r.status, description: "x" }), { status: r.status });
    },
    record: async () => true,
    log: () => {},
    newId: () => crypto.randomUUID(),
  };
  return state;
}

const send = (replies: Reply[], extra: Record<string, unknown> = {}) =>
  sendAndRecord({ text: "Hallo", source: "faeden", format: "plain", ...extra }, deps(replies).deps);

describe("error.rejected", () => {
  test("400 mit ok: false: gesetzt", async () => {
    const r = await send([{ status: 400 }]);
    expect(r.error).toEqual({ kind: "send", message: "Telegram hat den Text nicht angenommen", rejected: true });
    expect(r.messages).toBeUndefined();
  });

  test("403 und 429 mit ok: false: gesetzt", async () => {
    expect((await send([{ status: 403 }])).error?.rejected).toBe(true);
    expect((await send([{ status: 429 }])).error?.rejected).toBe(true);
  });

  test("Markdown: 400, dann der Klartext-Rückfall mit 400: gesetzt", async () => {
    const r = await sendAndRecord({ text: "**Hallo**", source: "faeden" }, deps([{ status: 400 }, { status: 400 }]).deps);
    expect(r.error?.rejected).toBe(true);
  });

  test("Markdown: 400, dann der Rückfall mit 502: nicht gesetzt", async () => {
    const r = await sendAndRecord({ text: "**Hallo**", source: "faeden" }, deps([{ status: 400 }, { status: 502 }]).deps);
    expect(r.error).toEqual({ kind: "send", message: "Telegram hat den Text nicht angenommen" });
  });

  test("5xx: nicht gesetzt", async () => {
    for (const status of [500, 502, 503]) {
      const r = await send([{ status }]);
      expect(r.error).toEqual({ kind: "send", message: "Telegram hat den Text nicht angenommen" });
    }
  });

  test("Netzfehler und Zeitüberschreitung: nicht gesetzt", async () => {
    const net = await send([new TypeError("fetch failed")]);
    expect(net.error).toEqual({ kind: "send", message: "Telegram hat den Text nicht angenommen" });
    const timeout = new Error("timeout");
    timeout.name = "TimeoutError";
    expect((await send([timeout])).error?.rejected).toBeUndefined();
  });

  test("4xx ohne lesbare Antwort oder ohne ok: false: nicht gesetzt", async () => {
    expect((await send([{ status: 400, body: "<html>Bad Gateway</html>" }])).error?.rejected).toBeUndefined();
    expect((await send([{ status: 404, body: "{}" }])).error?.rejected).toBeUndefined();
  });

  test("langer Text: erstes Stück angenommen, zweites abgelehnt: rejected gesetzt, angenommenes Stück in messages", async () => {
    const r = await send([{ status: 200 }, { status: 400 }], { text: "a".repeat(5000) });
    expect(r.error?.rejected).toBe(true);
    expect(r.messages?.length).toBe(1);
  });

  test("Datei: 413 mit ok: false gesetzt, 500 nicht", async () => {
    const file = join(dir, "x.txt");
    writeFileSync(file, "Inhalt");
    expect((await sendAndRecord({ file, source: "datei" }, deps([{ status: 413 }]).deps)).error?.rejected).toBe(true);
    expect((await sendAndRecord({ file, source: "datei" }, deps([{ status: 500 }]).deps)).error?.rejected).toBeUndefined();
  });

  test("Erfolg und Eingabefehler: kein rejected", async () => {
    expect((await send([{ status: 200 }])).error).toBeUndefined();
    expect((await sendAndRecord({ source: "faeden" }, deps([{ status: 200 }]).deps)).error).toEqual({ kind: "invalid", message: "Weder Text noch Datei angegeben" });
  });
});
