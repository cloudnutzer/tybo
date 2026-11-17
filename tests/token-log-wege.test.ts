/**
 * Issue #526: kein Bot-Token in irgendeiner Log-Ausgabe. Nachgestellter
 * Netzfehler mit erfundenem Haupt- und Agenten-Token über alle Logwege:
 * tatsächliche Ausgabe eines eigenen Prozesses mit eingeschalteter
 * Maskierung (jede console-Methode, Bytes, über mehrere write-Aufrufe
 * verteilte Tokens), die Standard-Logger der Telegram-Module (channel.ts,
 * reply-turn.ts) und von lifecycle.ts, handlerFailureLine und das
 * Datenbank-Log. bot.ts wird nie importiert.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Context, HttpError, type Api } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { createTelegramChannel, type TelegramChannelDeps } from "../src/channels/telegram/channel";
import { createTelegramReply, TELEGRAM_TURN_FAILED_TEXT } from "../src/channels/telegram/reply-turn";
import type { MediaInboxDeps } from "../src/channels/telegram/media-inbox";
import type { TextInboxDeps } from "../src/channels/telegram/text-inbox";
import { installSignalHandlers } from "../src/app/lifecycle";
import { handlerFailureLine } from "../src/lib/telegram-runtime";
import { supabaseLogs } from "../src/lib/store/supabase/logs";
import { installLogMask, logErrorMasked, TOKEN_MASK } from "../src/lib/telegram-token-mask";

// Erfunden. Das Agenten-Token weicht vom Muster ab und ist nur über die Umgebung erkennbar
const MAIN = "123456789:AAFakeHauptTokenNurFuerTests_abcdefgh";
const AGENT = "777:FakeAgentTokenNurTest-ijkl";

function netzfehler(): HttpError {
  const inner = Object.assign(new Error(`Unable to connect bot${AGENT}/getMe`), {
    code: "ConnectionRefused",
    path: `https://api.telegram.org/bot${MAIN}/sendMessage`,
  });
  inner.cause = new Error(`fetch failed https://api.telegram.org/file/bot${encodeURIComponent(MAIN)}/a.jpg`);
  return new HttpError(`Network request for 'sendMessage' failed! bot${MAIN}/sendMessage`, inner);
}

function expectClean(text: string) {
  // auch Bruchstücke: ein geteiltes Token darf in keinem Teil durchrutschen
  for (const piece of ["AAFake", "HauptToken", "NurFuerTests", "FakeAgent", "AgentToken", "NurTest", encodeURIComponent(MAIN)]) {
    expect(text).not.toContain(piece);
  }
}

describe("Ausgabe eines Prozesses mit eingeschalteter Maskierung", () => {
  test("jede console-Methode, Bytes und verteilte write-Aufrufe ohne Token, Pfad und Methode lesbar", async () => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "fixtures", "token-log-netzfehler.ts")], {
      cwd: join(import.meta.dir, ".."),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TELEGRAM_BOT_TOKEN: MAIN, TELEGRAM_BOT_TOKEN_RESEARCH: AGENT },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0);
    expectClean(out + err);
    const masked = (method: string) => `https://api.telegram.org/bot${TOKEN_MASK}/${method}`;
    // console.error, warn, assert und trace gehen auf stderr
    expect(err).toContain("Network request for 'sendMessage' failed!");
    expect(err).toContain(masked("sendMessage"));
    expect(err).toContain(`bot${TOKEN_MASK}/getMe`);
    expect(err).toContain(`file/bot${TOKEN_MASK}/photos/a.jpg`);
    expect(err).toContain(`bot${TOKEN_MASK}/getUpdates`);
    expect(err).toContain("ConnectionRefused");
    expect(err).toContain(`Assertion failed: assert: ${masked("assertMethod")}`);
    expect(err).toContain(`Trace: trace: ${masked("traceMethod")}`);
    // die übrigen console-Methoden auf stdout
    for (const line of [
      `info: ${masked("getChat")}`,
      `debug: ${masked("getChat")}`,
      masked("dirMethod"),
      `dirxml: ${masked("dirxmlMethod")}`,
      masked("tableMethod"),
      masked("tableAgent"),
      `count: ${masked("countMethod")}: 1`,
      `group: ${masked("groupMethod")}`,
      `  in der Gruppe: ${masked("inGroup")}`,
      `zeit: ${masked("timeMethod")}: `,
      `console.write: ${masked("consoleWrite")}`,
    ]) {
      expect(out).toContain(line);
    }
    // direkt als Zeichenkette und als Bytes
    expect(err).toContain(`direkt: ${masked("sendMessage")}\n`);
    expect(out).toContain(`direkt: ${masked("sendMessage")}\n`);
    expect(err).toContain(`buffer: ${masked("bufferMethod")}\n`);
    expect(out).toContain(`uint8: ${masked("uint8Method")}\n`);
    expect(out).toContain(`hex: ${masked("hexMethod")}\n`);
    // über mehrere write-Aufrufe verteilt, auch byteweise mit geteiltem UTF-8-Zeichen
    expect(err).toContain(`geteilt: ${masked("splitMain")}\n`);
    expect(out).toContain(`geteilt: ${masked("splitAgent")}\n`);
    expect(err).toContain(`kodiert: file/bot${TOKEN_MASK}/b.jpg\n`);
    expect(out).toContain(`Grüße ✓ ${masked("byteweise")}\n`);
    expect(out).toContain("original-unveraendert: true");
    // ohne Zeilenende geschrieben, beim Beenden maskiert ausgegeben
    expect(out).toEndWith(`ende: bot${TOKEN_MASK}`);
  });
});

describe("lange Zeile ohne Trennzeichen in einem Prozess", () => {
  // Erfunden, beide nach dem Muster eines Bot-Tokens (wie in telegram-token-mask.test.ts)
  const LONG_MAIN = "123456789:AAFakeHauptTokenNurFuerTests_abcdefgh";
  const LONG_AGENT = "987654321:AAFakeAgentTokenNurFuerTests-ijklmnop";

  test("Token, 20000 x, zweites Token, 1000 y: beide maskiert, auf stdout und stderr, in beiden Reihenfolgen", async () => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "fixtures", "token-log-lange-zeile.ts")], {
      cwd: join(import.meta.dir, ".."),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TELEGRAM_BOT_TOKEN: LONG_MAIN, TELEGRAM_BOT_TOKEN_RESEARCH: LONG_AGENT },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0);
    const line = TOKEN_MASK + "x".repeat(20_000) + TOKEN_MASK + "y".repeat(1000) + "\n";
    for (const text of [out, err]) {
      for (const piece of ["AAFake", "HauptToken", "AgentToken", "NurFuerTests", LONG_MAIN.slice(-24), LONG_AGENT.slice(-24)]) {
        expect(text).not.toContain(piece);
      }
      expect(text).toBe(line + line);
    }
  });
});

describe("Standard-Logger im Prozess", () => {
  const saved = { error: console.error, main: process.env.TELEGRAM_BOT_TOKEN, agent: process.env.TELEGRAM_BOT_TOKEN_RESEARCH };
  let lines: string[] = [];
  beforeEach(() => {
    lines = [];
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    process.env.TELEGRAM_BOT_TOKEN = MAIN;
    process.env.TELEGRAM_BOT_TOKEN_RESEARCH = AGENT;
  });
  afterEach(() => {
    console.error = saved.error;
    if (saved.main === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = saved.main;
    if (saved.agent === undefined) delete process.env.TELEGRAM_BOT_TOKEN_RESEARCH;
    else process.env.TELEGRAM_BOT_TOKEN_RESEARCH = saved.agent;
  });

  test("logErrorMasked: ein maskierter Text statt des Fehlerobjekts", () => {
    logErrorMasked("[Telegram] Antwort fehlgeschlagen:", netzfehler());
    expect(lines).toHaveLength(1);
    expectClean(lines[0]!);
    expect(lines[0]).toContain(`bot${TOKEN_MASK}/sendMessage`);
  });

  test("channel.ts ohne eigenen logError", async () => {
    const api = { sendMessage: async () => ({}), sendChatAction: async () => true } as unknown as Api;
    const me = { id: 1, is_bot: true, first_name: "tybo", username: "tybo_bot" } as UserFromGetMe;
    const deps: TelegramChannelDeps = {
      owner: "1000",
      scope: async () => {
        throw netzfehler();
      },
      text: {} as TextInboxDeps<Context>,
      media: {} as MediaInboxDeps,
      callbacks: { toolApproval: async (_ctx, next) => next(), router: async () => {} },
      topicService: () => {},
    };
    const channel = createTelegramChannel(deps);
    const update = {
      update_id: 1,
      message: { message_id: 5, date: 0, chat: { id: -100, type: "supergroup", title: "G" }, from: { id: 1000, is_bot: false, first_name: "Alex" }, text: "hallo" },
    } as Update;
    await channel.handlers.middleware()(new Context(update, api, me), async () => {});
    await new Promise(r => setTimeout(r, 5));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("Text handler error:");
    expectClean(lines[0]!);
    expect(lines[0]).toContain(`bot${TOKEN_MASK}/sendMessage`);
  });

  test("reply-turn.ts ohne eigenen logError: Netzfehler maskiert, Fehlerbehandlung wie bisher", async () => {
    const error = netzfehler();
    const events: string[] = [];
    const replies: string[] = [];
    const reply = createTelegramReply<{ id: number }>({
      runTurn: async () => {
        throw error;
      },
      typing: () => ({ start: () => void events.push("tippt"), stop: () => void events.push("tippt nicht mehr") }),
      reply: async (_ctx, text) => void replies.push(text),
      sendAsAgent: async () => {
        throw new Error("darf nicht gesendet werden");
      },
      finishTurn: async () => {
        throw new Error("kein Abschluss nach einem Fehler");
      },
      threadTurnHint: async () => undefined,
      isShuttingDown: () => false,
      afterTurn: (chatId, topicId) => void events.push(`afterTurn ${chatId} ${topicId}`),
    });
    await reply({ ctx: { id: 1 }, chatId: "4711", userMessage: "hallo", agentName: "research", topicId: 9 });
    expect(lines).toHaveLength(1);
    expectClean(lines[0]!);
    expect(lines[0]).toStartWith("[Telegram] Antwort fehlgeschlagen: HttpError: Network request for 'sendMessage' failed!");
    expect(lines[0]).toContain(`https://api.telegram.org/bot${TOKEN_MASK}/sendMessage`);
    expect(lines[0]).toContain(`bot${TOKEN_MASK}/getMe`);
    expect(lines[0]).toContain(`file/bot${TOKEN_MASK}/a.jpg`);
    expect(lines[0]).toContain("ConnectionRefused");
    // unveränderte Fehlerbehandlung: Hinweis an den Nutzer, Tippen aus, afterTurn, Originalfehler unberührt
    expect(replies).toEqual([TELEGRAM_TURN_FAILED_TEXT]);
    expect(events).toEqual(["tippt", "tippt nicht mehr", "afterTurn 4711 9"]);
    expect((error.error as { path: string }).path).toBe(`https://api.telegram.org/bot${MAIN}/sendMessage`);
  });

  test("lifecycle.ts: unerwarteter Fehler im Log und im Absturzbericht ohne Token", async () => {
    const handlers = new Map<string, (arg?: unknown) => unknown>();
    const rows: unknown[] = [];
    const logs = supabaseLogs(() => ({ from: () => ({ insert: async (row: unknown) => void rows.push(row) }) }) as never);
    installSignalHandlers(
      { shutdown: async () => {} },
      {
        on: (event, handler) => void handlers.set(event, handler),
        // wie der Absturzbericht in bot.ts: über store.logs.write ins Datenbank-Log
        report: error => logs.write("error", "bot", `Uncaught exception: ${error.message}`, { stack: error.stack }),
      },
    );
    await handlers.get("uncaughtException")!(netzfehler());
    expect(lines).toHaveLength(1);
    expectClean(lines[0]!);
    expect(lines[0]).toStartWith("Uncaught exception:");
    expect(rows).toHaveLength(1);
    expectClean(JSON.stringify(rows[0]));
    expect(JSON.stringify(rows[0])).toContain(`bot${TOKEN_MASK}/sendMessage`);
  });

  test("handlerFailureLine reicht die Meldung nur maskiert durch", () => {
    const line = handlerFailureLine({ error: netzfehler(), ctx: { update: { update_id: 7 } } });
    expectClean(line);
    expect(line).toBe(`Telegram-Handler fehlgeschlagen (Update 7): Network request for 'sendMessage' failed! bot${TOKEN_MASK}/sendMessage`);
  });

  test("Datenbank-Log: Meldung und Metadaten maskiert", async () => {
    const rows: unknown[] = [];
    const client = { from: () => ({ insert: async (row: unknown) => void rows.push(row) }) };
    const logs = supabaseLogs(() => client as never);
    const error = netzfehler();
    await logs.write("error", "bot", `Uncaught exception: ${error.message}`, { stack: error.stack, error });
    expect(rows).toHaveLength(1);
    const text = JSON.stringify(rows[0]);
    expectClean(text);
    expect(text).toContain(`bot${TOKEN_MASK}/sendMessage`);
    expect(text).toContain("ConnectionRefused");
  });
});

describe("installLogMask mit eigenen Strömen", () => {
  function capture() {
    const chunks: Buffer[] = [];
    const stream = {
      write: (chunk: unknown, ...rest: unknown[]) => {
        chunks.push(Buffer.from(chunk as Uint8Array));
        (rest.find(r => typeof r === "function") as (() => void) | undefined)?.();
        return true;
      },
    };
    return { stream, text: () => Buffer.concat(chunks).toString("utf8"), bytes: () => Buffer.concat(chunks) };
  }

  test("wirkt einmal, auch bei zweitem Aufruf; console geht über die maskierten Ströme", () => {
    const out = capture();
    const err = capture();
    const fake: Record<string, unknown> = { log: () => {}, error: () => {}, dir: () => {}, table: () => {} };
    installLogMask({ console: fake, stdout: out.stream, stderr: err.stream, tokens: () => [AGENT] });
    installLogMask({ console: fake, stdout: out.stream, stderr: err.stream, tokens: () => [AGENT] });
    (fake.error as (...a: unknown[]) => void)("a", `bot${AGENT}/getMe`);
    (fake.dir as (...a: unknown[]) => void)({ url: `bot${MAIN}/dir` });
    out.stream.write(`bot${MAIN}/x\n`);
    expect(err.text()).toBe(`a bot${TOKEN_MASK}/getMe\n`);
    expect(out.text()).toBe(`{ url: 'bot${TOKEN_MASK}/dir' }\nbot${TOKEN_MASK}/x\n`);
  });

  test("Token über mehrere Aufrufe: der Anfang wartet, bis klar ist, wie es weitergeht", () => {
    const out = capture();
    const stream = out.stream;
    installLogMask({ console: {}, stdout: stream, stderr: capture().stream, tokens: () => [AGENT] });
    stream.write("Zeile https://api.telegram.org/bot123456789:AAFake");
    // bis hierher nur, was sicher kein Token ist
    expect(out.text()).toBe("Zeile https://api.telegram.org/");
    stream.write(Buffer.from("HauptTokenNurFuerTests_abcdefgh/sendMessage\n"));
    stream.write("bot777:Fake");
    stream.write(new TextEncoder().encode("AgentTokenNurTest-ijkl/getMe\n"));
    expect(out.text()).toBe(`Zeile https://api.telegram.org/bot${TOKEN_MASK}/sendMessage\nbot${TOKEN_MASK}/getMe\n`);
  });

  test("Bytes bleiben Byte für Byte erhalten, auch ein halbes UTF-8-Zeichen", () => {
    const out = capture();
    installLogMask({ console: {}, stdout: out.stream, stderr: capture().stream, tokens: () => [] });
    const bytes = Buffer.from("Grüße ✓ \u{1F600}\n");
    for (const byte of bytes) out.stream.write(Buffer.from([byte]));
    const binary = Buffer.from([0xff, 0x00, 0xfe, 0x0a]);
    out.stream.write(binary);
    expect(out.bytes().equals(Buffer.concat([bytes, binary]))).toBe(true);
  });

  test("eine riesige Zeile ohne Trennzeichen wird geteilt, ohne ein Token zu zerschneiden", () => {
    const out = capture();
    installLogMask({ console: {}, stdout: out.stream, stderr: capture().stream, tokens: () => [] });
    const filler = "x".repeat(20_000);
    // Geteilt wird 1024 Zeichen vor dem Ende; das Token beginnt 5 Zeichen davor
    const tail = ":" + "y".repeat(1024 + 5 - MAIN.length - 1);
    out.stream.write(filler + MAIN + tail);
    expect(out.text()).toBe(filler);
    out.stream.write("\n");
    expect(out.text()).toBe(filler + TOKEN_MASK + tail + "\n");
  });
});
