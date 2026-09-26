/**
 * Issue #114: sendAndRecord gibt die message_ids der angenommenen
 * Telegram-Nachrichten zurück und schreibt metadata.choiceId. Telegram
 * antwortet hier wie die echte Bot-API mit { ok, result: { message_id } }.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sendAndRecord, type OutboxDeps } from "../src/lib/outbox";
import type { Message } from "../src/lib/supabase";

const USER = "4711";
const GROUP = "-1001234567890";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "outbox-ids-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Call {
  method: string;
  json?: Record<string, unknown>;
}

/** status(call, index): HTTP-Status oder Fehler; Antworten mit fortlaufender message_id ab 500 */
function fakeDeps(status: (call: Call, index: number) => number | Error = () => 200, body?: (id: number) => string) {
  const calls: Call[] = [];
  const recorded: Message[] = [];
  let nextId = 500;
  const deps: OutboxDeps = {
    botToken: "123:test-token",
    userId: USER,
    groupId: GROUP,
    outboxDir: join(dir, "outbox"),
    fetch: async (url, init) => {
      const call: Call = { method: url.split("/").pop() ?? "" };
      if (!(init.body instanceof FormData)) call.json = JSON.parse(String(init.body));
      calls.push(call);
      const s = status(call, calls.length - 1);
      if (s instanceof Error) throw s;
      if (s !== 200) return new Response(JSON.stringify({ ok: false, description: "Bad Request" }), { status: s });
      const id = nextId++;
      return new Response(body ? body(id) : JSON.stringify({ ok: true, result: { message_id: id } }), { status: 200 });
    },
    record: async m => {
      recorded.push(m);
      return true;
    },
    log: () => {},
    newId: () => crypto.randomUUID(),
  };
  return { deps, calls, recorded };
}

const BUTTONS = [[{ text: "Ja", callback_data: "ch|abc|y" }]];
const long = Array.from({ length: 30 }, (_, i) => `Absatz ${i} ` + "x".repeat(300)).join("\n\n");

describe("message_ids", () => {
  test("ein Text-Stück: eine Nachricht mit Chat und ID", async () => {
    const { deps } = fakeDeps();
    const r = await sendAndRecord({ text: "Hallo", source: "pipeline" }, deps);
    expect(r).toEqual({ sent: true, recorded: true, messages: [{ chatId: USER, messageId: 500, part: "text", buttons: false }] });
  });

  test("lange Frage: alle Stücke in Reihenfolge, Knöpfe nur am letzten", async () => {
    const { deps, calls } = fakeDeps();
    const r = await sendAndRecord({ text: long, source: "freigabe", format: "plain", buttons: BUTTONS, topicId: 7 }, deps);
    expect(calls.length).toBeGreaterThan(1);
    expect(r.messages).toHaveLength(calls.length);
    expect(r.messages!.map(m => m.messageId)).toEqual(calls.map((_, i) => 500 + i));
    expect(r.messages!.every(m => m.chatId === GROUP && m.part === "text")).toBe(true);
    expect(r.messages!.map(m => m.buttons)).toEqual(calls.map((_, i) => i === calls.length - 1));
    expect(calls.map(c => "reply_markup" in (c.json ?? {}))).toEqual(r.messages!.map(m => m.buttons));
  });

  test("HTML-Rückfall: die ID des Klartext-Rückfalls zählt", async () => {
    const { deps, calls } = fakeDeps((_c, i) => (i === 0 ? 400 : 200));
    const r = await sendAndRecord({ text: "a < b", source: "watchdog", buttons: BUTTONS }, deps);
    expect(calls).toHaveLength(2);
    expect(r.messages).toEqual([{ chatId: USER, messageId: 500, part: "text", buttons: true }]);
  });

  test("Teilerfolg: schon angenommene Stücke stehen drin, sent bleibt false", async () => {
    const { deps, calls, recorded } = fakeDeps((_c, i) => (i === 1 ? new Error("Netz weg") : 200));
    const r = await sendAndRecord({ text: long, source: "briefing" }, deps);
    expect(calls.length).toBe(2);
    expect(r.sent).toBe(false);
    expect(r.messages).toEqual([{ chatId: USER, messageId: 500, part: "text", buttons: false }]);
    expect(recorded).toHaveLength(0);
  });

  test("Text und Datei: erst Text, dann Datei", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "Inhalt");
    const { deps } = fakeDeps();
    const r = await sendAndRecord({ text: "Anbei", file, source: "datei" }, deps);
    expect(r.messages).toEqual([
      { chatId: USER, messageId: 500, part: "text", buttons: false },
      { chatId: USER, messageId: 501, part: "file", buttons: false },
    ]);
  });

  test("Antwort ohne lesbare message_id: Feld fehlt, Versand bleibt gültig", async () => {
    for (const body of [() => "{}", () => "kein json", (id: number) => JSON.stringify({ ok: true, result: { message_id: String(id) } })]) {
      const { deps } = fakeDeps(undefined, body);
      const r = await sendAndRecord({ text: "Hallo", source: "pipeline" }, deps);
      expect(r).toEqual({ sent: true, recorded: true });
    }
  });

  test("abgelehnte Eingabe: keine Nachrichten", async () => {
    const { deps, calls } = fakeDeps();
    const r = await sendAndRecord({ text: "", source: "pipeline" }, deps);
    expect(r.sent).toBe(false);
    expect(r.messages).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("metadata.choiceId", () => {
  test("steht am Text-Eintrag, neben source und topicId", async () => {
    const { deps, recorded } = fakeDeps();
    await sendAndRecord({ text: "Erlauben?", source: "freigabe", topicId: 7, buttons: BUTTONS, choiceId: "Abc123XyZ0" }, deps);
    expect(recorded).toEqual([
      {
        chat_id: GROUP,
        role: "assistant",
        content: "Erlauben?",
        metadata: { display_only: true, source: "freigabe", choiceId: "Abc123XyZ0", topicId: 7 },
      },
    ]);
  });

  test("ohne choiceId kein Feld", async () => {
    const { deps, recorded } = fakeDeps();
    await sendAndRecord({ text: "Hallo", source: "pipeline" }, deps);
    expect(recorded[0].metadata).toEqual({ display_only: true, source: "pipeline" });
  });

  test("ungültige choiceId oder ohne Text: abgelehnt, nichts gesendet", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "Inhalt");
    for (const input of [
      { text: "x", choiceId: "../etc" },
      { text: "x", choiceId: "a".repeat(13) },
      { text: "x", choiceId: 5 as unknown as string },
      { file, choiceId: "abc" },
    ]) {
      const { deps, calls } = fakeDeps();
      const r = await sendAndRecord({ source: "freigabe", ...input }, deps);
      expect(r.error?.kind).toBe("invalid");
      expect(calls).toHaveLength(0);
    }
  });
});

describe("record false (Issue #119)", () => {
  test("nur gesendet, nichts festgehalten, message_id zurück", async () => {
    const { deps, calls, recorded } = fakeDeps();
    const r = await sendAndRecord({ text: "Weitere Auswahl", source: "topic", topicId: 7, buttons: BUTTONS, format: "plain", record: false }, deps);
    expect(r).toMatchObject({ sent: true, recorded: false, messages: [{ chatId: GROUP, messageId: 500, part: "text", buttons: true }] });
    expect(calls.map(c => c.method)).toEqual(["sendMessage"]);
    expect(recorded).toEqual([]);
  });

  test("record true ist nicht erlaubt", async () => {
    const { deps, calls } = fakeDeps();
    const r = await sendAndRecord({ text: "x", source: "topic", record: true as unknown as false }, deps);
    expect(r.error?.kind).toBe("invalid");
    expect(calls).toHaveLength(0);
  });
});
