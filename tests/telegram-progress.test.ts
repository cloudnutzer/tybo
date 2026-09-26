/**
 * Issue #52, Nachbesserung: Fortschrittsmeldungen über den tatsächlichen Weg.
 * Der Claude-Prozess ist eine Attrappe (setSpawnForTests) mit stream-json,
 * callClaudeStreaming, runStreamingTurn und createTelegramProgressSink laufen
 * echt, die Bot-API ist eine Attrappe mit installiertem Guard. Die WebUI
 * bekommt weiter den unveränderten Snippet.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Api, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { callClaudeStreaming, setSpawnForTests } from "../src/lib/claude";
import { runStreamingTurn, type ChatTurnDeps, type TurnProgress, type TurnSink } from "../src/lib/chat-turn";
import { installTelegramOutputGuard } from "../src/lib/telegram";
import { createTelegramProgressSink } from "../src/lib/telegram-progress";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";

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
  callClaudeStreaming,
  callClaude: async () => {
    throw new Error("unerwartet");
  },
  callFallbackLLMWithSource: async () => ({ text: "fallback", source: "none" }),
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
    expect(await turn(FIRST_TEXT, createTelegramProgressSink(ctx, async () => {}))).toBe("fertig");

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
    await turn(`![${"a".repeat(3)}](${SECRET}${"z".repeat(200)}) ok.`, createTelegramProgressSink(ctx, async () => {}));
    expect(JSON.stringify(calls)).not.toContain("a.b/geheim");
    expect(calls.filter(c => c.method === "editMessageText")).toHaveLength(0);
  });
});
