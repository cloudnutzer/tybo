/**
 * Issue #52, Nachbesserung: Fortschrittsmeldungen über den tatsächlichen Weg.
 * Der Claude-Prozess ist eine Attrappe (setSpawnForTests) mit stream-json,
 * callClaudeStreaming, runStreamingTurn und createTelegramProgressSink laufen
 * echt, die Bot-API ist eine Attrappe mit installiertem Guard. Die WebUI
 * bekommt weiter den unveränderten Snippet.
 *
 * Issue #329: Drosselung mit Uhr-Attrappe (höchstens ein Aufruf je 1,5 s,
 * Bündeln, Nachreichen, Abschluss vor Ablauf, langsame API), deutsche
 * Kopfzeile und Länge der Statusnachricht.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Api, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { callClaudeStreaming, setSpawnForTests } from "../src/lib/claude";
import { runStreamingTurn, type ChatTurnDeps, type TurnProgress, type TurnSink } from "../src/lib/chat-turn";
import { installTelegramOutputGuard } from "../src/lib/telegram";
import {
  createTelegramProgressSink,
  progressLine,
  PROGRESS_EDIT_INTERVAL_MS,
  PROGRESS_HEADER,
  renderProgress,
  type ProgressClock,
} from "../src/lib/telegram-progress";
import { TELEGRAM_TEXT_MAX } from "../src/channels/telegram/format";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { createClaudeEngine } from "../src/lib/engines";

const SECRET = "https://a.b/geheim";
/**
 * Bild mit langer Adresse: die Kürzungen schneiden die schließende Klammer ab
 * (kurzer Vorspann, damit der Parser keinen Satzanfang vor der Adresse findet)
 */
const FIRST_TEXT = `Bild geprüft: ![x](${SECRET}${"z".repeat(200)}) und mache weiter.`;

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function streamLines(firstText: string): string {
  return [
    { type: "system", subtype: "init", session_id: "s1" },
    { type: "assistant", message: { id: "m1", content: [{ type: "text", text: firstText }] } },
    { type: "result", subtype: "success", is_error: false, result: "fertig", session_id: "s1" },
  ]
    .map(e => JSON.stringify(e) + "\n")
    .join("");
}

let currentStream = "";
beforeAll(() => {
  // Nie die echte ~/.claude.json lesen (Issue #54)
  setMcpReaderForTests(() => new Set());
  setSpawnForTests((() => ({
    pid: 0,
    stdin: { write() {}, end() {} },
    stdout: stream(currentStream),
    stderr: stream(""),
    exited: Promise.resolve(0),
    kill() {},
  })) as any);
});
afterAll(() => {
  setSpawnForTests(null);
  setMcpReaderForTests(null);
});

/** Alle Abhängigkeiten außer callClaudeStreaming sind Attrappen: kein Prompt-Bau, keine Datenbank */
const DEPS: Partial<ChatTurnDeps> = {
  getEngine: () =>
    createClaudeEngine({
      callClaudeStreaming,
      callClaude: async () => {
        throw new Error("unerwartet");
      },
    }),
  runFallbackChain: async () => ({ text: "fallback", source: "none" }),
  buildPromptContext: async () => ({ fullPrompt: "prompt", fallbackContext: "" }),
  buildResumePrompt: async () => "resume",
  isSessionModeEnabled: () => false,
  getResumableSession: async () => undefined,
  takeExpiredSession: async () => undefined,
  recordSessionTurn: async () => {},
  resetSession: async () => 0,
  shouldDistill: () => false,
  distillSession: async () => {},
  log: async () => {},
  getAgentConfig: () => ({ model: "test-model" }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
  getSettings: () => ({}),
  setTimer: () => 0,
  clearTimer: () => {},
  now: () => 0,
};

/** Integrationstests prüfen den Inhalt, nicht die Drosselung: ohne Mindestabstand */
const NO_WAIT = { intervalMs: 0 };

const ME = { id: 42, is_bot: true, first_name: "Test", username: "test_bot" } as UserFromGetMe;

function telegram() {
  const api = new Api("123:test");
  const calls: { method: string; payload: Record<string, any> }[] = [];
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    return { ok: true, result: { message_id: calls.length, date: 0, chat: { id: 1, type: "private" } } } as any;
  });
  installTelegramOutputGuard(api);
  const update = {
    update_id: 1,
    message: { message_id: 7, date: 0, chat: { id: 1, type: "private", first_name: "E" }, text: "hi" },
  } as Update;
  return { ctx: new Context(update, api, ME), calls };
}

async function turn(firstText: string, sink: TurnSink): Promise<string> {
  currentStream = streamLines(firstText);
  return runStreamingTurn({ userMessage: "hallo", chatId: "1", agentName: "general", sink, deps: DEPS });
}

describe("Fortschritt nach Telegram", () => {
  test("angeschnittenes Bild: keine Adresse in der Fortschrittsmeldung", async () => {
    const { ctx, calls } = telegram();
    expect(await turn(FIRST_TEXT, createTelegramProgressSink(ctx, async () => {}, NO_WAIT))).toBe("fertig");

    const texts = calls.filter(c => c.method === "sendMessage" || c.method === "editMessageText");
    expect(texts.length).toBeGreaterThan(1);
    expect(JSON.stringify(calls)).not.toContain("a.b/geheim");
    const progress = texts.at(-1)!.payload;
    expect(progress.text).toContain("Bild geprüft: x und mache weiter.");
    expect(progress.link_preview_options).toEqual({ is_disabled: true });
    expect(calls.at(-1)!.method).toBe("deleteMessage");
  });

  test("ohne Bereinigung vor der Kürzung sähe der Guard das Bild nicht mehr", async () => {
    // Belegt, dass der Test oben die Kürzung trifft: der WebUI-Snippet ist angeschnitten
    const web: TurnProgress[] = [];
    await turn(FIRST_TEXT, { progress: p => void web.push(p), notice: () => {} });
    expect(web[0].text).toContain("a.b/geheim");
    expect(web[0].text).not.toContain(")");
  });

  test("WebUI-Ausgabe unverändert: text wie bisher, telegramText nur zusätzlich", async () => {
    const web: TurnProgress[] = [];
    await turn(FIRST_TEXT, { progress: p => void web.push(p), notice: () => {} });
    expect(web).toHaveLength(1);
    // Bisherige Kürzung: 150 Zeichen im Parser, dann ohne _*`<> auf 120
    expect(web[0].kind).toBe("snippet");
    expect(web[0].text).toBe(FIRST_TEXT.substring(0, 150).trim().replace(/[_*`<>]/g, "").substring(0, 120));
    expect(web[0].telegramText).toBe("Bild geprüft: x und mache weiter.");
  });

  test("bleibt nach dem Bereinigen zu wenig übrig: keine Snippet-Meldung in Telegram", async () => {
    const { ctx, calls } = telegram();
    await turn(`![${"a".repeat(3)}](${SECRET}${"z".repeat(200)}) ok.`, createTelegramProgressSink(ctx, async () => {}, NO_WAIT));
    expect(JSON.stringify(calls)).not.toContain("a.b/geheim");
    expect(calls.filter(c => c.method === "editMessageText")).toHaveLength(0);
  });
});

/** Uhr-Attrappe: Zeit steht, bis advance sie vorstellt; fällige Zeitgeber laufen dann der Reihe nach */
function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: ProgressClock = {
    now: () => now,
    setTimer: (run, ms) => {
      timers.set(++nextId, { at: now + ms, run });
      return nextId;
    },
    clearTimer: handle => void timers.delete(handle as number),
  };
  return {
    clock,
    timers,
    get now() {
      return now;
    },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

/** Lässt laufende Promise-Ketten (Attrappen-API, Sink) zu Ende laufen */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Bot-API-Attrappe mit Zeitstempel je Aufruf; slow hält Antworten zurück, bis release kommt */
function timedTelegram(clock: ReturnType<typeof fakeClock>) {
  const api = new Api("123:test");
  const calls: { method: string; at: number; payload: Record<string, any> }[] = [];
  const held: (() => void)[] = [];
  let slow = false;
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, at: clock.now, payload: payload as Record<string, any> });
    if (slow) await new Promise<void>(r => held.push(r));
    return { ok: true, result: { message_id: 99, date: 0, chat: { id: 1, type: "private" } } } as any;
  });
  installTelegramOutputGuard(api);
  const update = {
    update_id: 1,
    message: { message_id: 7, date: 0, chat: { id: 1, type: "private", first_name: "E" }, text: "hi" },
  } as Update;
  return {
    ctx: new Context(update, api, ME),
    calls,
    edits: () => calls.filter(c => c.method === "editMessageText"),
    setSlow: (on: boolean) => void (slow = on),
    release: async () => {
      held.splice(0).forEach(r => r());
      await settle();
    },
  };
}

const tool = (text: string): TurnProgress => ({ kind: "tool", text });

describe("Drosselung der Statusnachricht", () => {
  test("start sendet sofort, mit deutscher Kopfzeile und ohne Link-Vorschau", async () => {
    const c = fakeClock();
    const t = timedTelegram(c);
    const sink = createTelegramProgressSink(t.ctx, async () => {}, { clock: c.clock });
    await sink.start!();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].method).toBe("sendMessage");
    expect(t.calls[0].payload.text).toBe(PROGRESS_HEADER);
    expect(PROGRESS_HEADER).toBe("<i>Arbeite daran …</i>");
    expect(t.calls[0].payload.parse_mode).toBe("HTML");
    expect(t.calls[0].payload.link_preview_options).toEqual({ is_disabled: true });
    await sink.finish!();
  });

  test("Meldungen im Fenster werden gebündelt und ohne weiteres Ereignis nachgereicht", async () => {
    const c = fakeClock();
    const t = timedTelegram(c);
    const sink = createTelegramProgressSink(t.ctx, async () => {}, { clock: c.clock });
    await sink.start!();
    await c.advance(200);
    expect(sink.progress(tool("Datei lesen"))).toBeUndefined();
    await c.advance(300);
    sink.progress(tool("Im Web suchen"));
    sink.progress({ kind: "snippet", text: "Ich schaue nach" });
    await settle();
    expect(t.edits()).toHaveLength(0);

    // Genau ein Intervall nach dem Senden kommt eine Bearbeitung mit allen drei Zeilen
    await c.advance(PROGRESS_EDIT_INTERVAL_MS - 500 - 1);
    expect(t.edits()).toHaveLength(0);
    await c.advance(1);
    expect(t.edits()).toHaveLength(1);
    expect(t.edits()[0].at).toBe(PROGRESS_EDIT_INTERVAL_MS);
    expect(t.edits()[0].payload.text).toBe(
      [PROGRESS_HEADER, "→ Datei lesen", "→ Im Web suchen", "→ <i>„Ich schaue nach …“</i>"].join("\n")
    );
    expect(t.edits()[0].payload.link_preview_options).toEqual({ is_disabled: true });
    expect(c.timers.size).toBe(0);
    await sink.finish!();
  });

  test("mindestens 1.500 ms zwischen allen Aufrufen, auch bei vielen Meldungen", async () => {
    const c = fakeClock();
    const t = timedTelegram(c);
    const sink = createTelegramProgressSink(t.ctx, async () => {}, { clock: c.clock });
    await sink.start!();
    for (let i = 0; i < 40; i++) {
      sink.progress(tool(`Schritt ${i}`));
      await c.advance(250);
    }
    await c.advance(5000);
    const at = t.calls.filter(x => x.method !== "deleteMessage").map(x => x.at);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(PROGRESS_EDIT_INTERVAL_MS);
    // 40 Meldungen über 10 s ergeben höchstens 7 Bearbeitungen, die letzte zeigt alles
    expect(t.edits().length).toBeLessThanOrEqual(7);
    expect(t.edits().at(-1)!.payload.text).toContain("→ Schritt 39");
    await sink.finish!();
  });

  test("ohne neue Meldung keine Bearbeitung, kein offener Zeitgeber", async () => {
    const c = fakeClock();
    const t = timedTelegram(c);
    const sink = createTelegramProgressSink(t.ctx, async () => {}, { clock: c.clock });
    await sink.start!();
    sink.progress({ kind: "snippet", text: "x", telegramText: "" });
    await c.advance(10_000);
    expect(t.edits()).toHaveLength(0);
    expect(c.timers.size).toBe(0);
    await sink.finish!();
  });

  test("langsame API: nie zwei Aufrufe gleichzeitig, Neues danach gebündelt", async () => {
    const c = fakeClock();
    const t = timedTelegram(c);
    const sink = createTelegramProgressSink(t.ctx, async () => {}, { clock: c.clock });
    await sink.start!();
    t.setSlow(true);
    sink.progress(tool("Eins"));
    await c.advance(PROGRESS_EDIT_INTERVAL_MS);
    expect(t.edits()).toHaveLength(1);
    // Die Bearbeitung hängt 4 s; währenddessen zwei Meldungen, kein zweiter Aufruf
    sink.progress(tool("Zwei"));
    await c.advance(2000);
    sink.progress(tool("Drei"));
    await c.advance(2000);
    expect(t.edits()).toHaveLength(1);
    t.setSlow(false);
    await t.release();
    // Intervall seit Beginn des hängenden Aufrufs ist längst vorbei: sofort weiter, beides zusammen
    expect(t.edits()).toHaveLength(2);
    expect(t.edits()[1].at).toBe(PROGRESS_EDIT_INTERVAL_MS + 4000);
    expect(t.edits()[1].payload.text).toContain("→ Zwei\n→ Drei");
    await sink.finish!();
  });

  test("finish vor Ablauf des Zeitgebers: nichts nachgereicht, Zeitgeber weg, Nachricht gelöscht", async () => {
    const c = fakeClock();
    const t = timedTelegram(c);
    const sink = createTelegramProgressSink(t.ctx, async () => {}, { clock: c.clock });
    await sink.start!();
    sink.progress(tool("Datei lesen"));
    expect(c.timers.size).toBe(1);
    await c.advance(100);
    await sink.finish!();
    expect(c.timers.size).toBe(0);
    await c.advance(10_000);
    sink.progress(tool("zu spät"));
    await c.advance(10_000);
    expect(t.calls.map(x => x.method)).toEqual(["sendMessage", "deleteMessage"]);
    expect(t.calls[1].payload.message_id).toBe(99);
  });

  test("finish wartet auf die laufende Bearbeitung, gelöscht wird zuletzt", async () => {
    const c = fakeClock();
    const t = timedTelegram(c);
    const sink = createTelegramProgressSink(t.ctx, async () => {}, { clock: c.clock });
    await sink.start!();
    t.setSlow(true);
    sink.progress(tool("Eins"));
    await c.advance(PROGRESS_EDIT_INTERVAL_MS);
    let done = false;
    const finishing = Promise.resolve(sink.finish!()).then(() => void (done = true));
    await settle();
    expect(done).toBe(false);
    expect(t.calls.map(x => x.method)).toEqual(["sendMessage", "editMessageText"]);
    t.setSlow(false);
    await t.release();
    await finishing;
    expect(t.calls.map(x => x.method)).toEqual(["sendMessage", "editMessageText", "deleteMessage"]);
  });

  test("hängendes Senden beim Start: finish wartet und löscht die Nachricht danach", async () => {
    const c = fakeClock();
    const t = timedTelegram(c);
    t.setSlow(true);
    const sink = createTelegramProgressSink(t.ctx, async () => {}, { clock: c.clock });
    void sink.start!();
    const finishing = Promise.resolve(sink.finish!());
    await settle();
    t.setSlow(false);
    await t.release();
    await finishing;
    expect(t.calls.map(x => x.method)).toEqual(["sendMessage", "deleteMessage"]);
  });

  test("ohne start: die erste Meldung sendet die Nachricht sofort", async () => {
    const c = fakeClock();
    const t = timedTelegram(c);
    const sink = createTelegramProgressSink(t.ctx, async () => {}, { clock: c.clock });
    sink.progress(tool("Datei lesen"));
    await settle();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].method).toBe("sendMessage");
    expect(t.calls[0].payload.text).toBe(`${PROGRESS_HEADER}\n→ Datei lesen`);
    await sink.finish!();
  });

  test("gescheiterte Bearbeitung wird nicht wiederholt, erst eine neue Meldung löst wieder aus", async () => {
    const c = fakeClock();
    const api = new Api("123:test");
    const calls: string[] = [];
    api.config.use(async (_prev, method) => {
      calls.push(method);
      if (method === "editMessageText") throw new Error("Bad Request: message is too old");
      return { ok: true, result: { message_id: 5, date: 0, chat: { id: 1, type: "private" } } } as any;
    });
    const ctx = new Context(
      { update_id: 1, message: { message_id: 7, date: 0, chat: { id: 1, type: "private", first_name: "E" }, text: "hi" } } as Update,
      api,
      ME
    );
    const sink = createTelegramProgressSink(ctx, async () => {}, { clock: c.clock });
    await sink.start!();
    sink.progress(tool("Eins"));
    await c.advance(10_000);
    expect(calls).toEqual(["sendMessage", "editMessageText"]);
    sink.progress(tool("Zwei"));
    await c.advance(10_000);
    expect(calls).toEqual(["sendMessage", "editMessageText", "editMessageText"]);
    await sink.finish!();
  });

  test("notice geht unverändert an den Sendeweg", async () => {
    const c = fakeClock();
    const t = timedTelegram(c);
    const sent: string[] = [];
    const sink = createTelegramProgressSink(t.ctx, async text => void sent.push(text), { clock: c.clock });
    await sink.notice("Hinweis <b>roh</b>");
    expect(sent).toEqual(["Hinweis <b>roh</b>"]);
    expect(t.calls).toHaveLength(0);
  });
});

describe("Zeilen und Länge der Statusnachricht", () => {
  test("Werkzeug und Textanfang werden HTML-maskiert", () => {
    expect(progressLine(tool("<script> & co"))).toBe("→ &lt;script&gt; &amp; co");
    expect(progressLine({ kind: "snippet", text: "a<b", telegramText: "x > y" })).toBe("→ <i>„x &gt; y …“</i>");
    expect(progressLine({ kind: "snippet", text: "roh" })).toBe("→ <i>„roh …“</i>");
    expect(progressLine({ kind: "snippet", text: "roh", telegramText: "" })).toBe("");
  });

  test("lange Werkzeugfolgen bleiben unter dem Telegram-Limit, älteste Zeilen fallen weg", () => {
    const lines = Array.from({ length: 500 }, (_, i) => progressLine(tool(`Werkzeug Nummer ${i} mit etwas Text`)));
    const text = renderProgress(lines);
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX);
    expect(text.startsWith(`${PROGRESS_HEADER}\n<i>(`)).toBe(true);
    expect(text).toMatch(/frühere Schritte ausgeblendet/);
    expect(text.endsWith("Werkzeug Nummer 499 mit etwas Text")).toBe(true);
    expect(text).not.toContain("Werkzeug Nummer 0 ");
    // Überlange Einzelzeilen werden vor dem Maskieren gekürzt
    expect(progressLine(tool("&".repeat(10_000))).length).toBeLessThan(2000);
  });

  test("Einzahl im Hinweis und kein Hinweis, wenn alles passt", () => {
    expect(renderProgress(["→ a", "→ b"])).toBe(`${PROGRESS_HEADER}\n→ a\n→ b`);
    expect(renderProgress([`→ ${"a".repeat(60)}`, "→ b"], PROGRESS_HEADER.length + 50)).toBe(
      `${PROGRESS_HEADER}\n<i>(1 früherer Schritt ausgeblendet)</i>\n→ b`
    );
  });

  test("lange Folge über den Sink: jede Bearbeitung unter dem Limit", async () => {
    const c = fakeClock();
    const t = timedTelegram(c);
    const sink = createTelegramProgressSink(t.ctx, async () => {}, { clock: c.clock });
    await sink.start!();
    for (let i = 0; i < 400; i++) sink.progress(tool(`Datei ${i} ${"x".repeat(40)}`));
    await c.advance(2000);
    expect(t.edits()).toHaveLength(1);
    expect(t.edits()[0].payload.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX);
    await sink.finish!();
  });
});
