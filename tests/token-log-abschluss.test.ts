/**
 * Issue #526: Stream-Lebenszyklus statt einzelner Ausgabestellen. end hat in
 * Bun einen eigenen Schreibweg. Abschlusschunk und wartender Rest müssen
 * gemeinsam maskiert und genau einmal vor dem Abschluss ausgegeben werden.
 * Alle Tokens sind erfunden; kein Test importiert oder startet bot.ts.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Writable } from "node:stream";
import { flushLogMask, installLogMask, TOKEN_MASK } from "../src/lib/telegram-token-mask";

const MAIN = "123456789:AAFakeHauptTokenNurFuerTests_abcdefgh";
const AGENT = "777:FakeAgentTokenNurTest-ijkl";
const EXPECTED = `Grüße ✓ https://api.telegram.org/bot${TOKEN_MASK}/sendMessage file/bot${TOKEN_MASK}/photos/a.jpg`;

async function run(channel: string, kind: string, mode: string) {
  const proc = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "fixtures", "token-log-abschluss.ts"), channel, kind, mode], {
    cwd: join(import.meta.dir, ".."),
    env: { PATH: process.env.PATH ?? "", TELEGRAM_BOT_TOKEN: MAIN, TELEGRAM_BOT_TOKEN_RESEARCH: AGENT },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { text: channel === "stdout" ? out : err, other: channel === "stdout" ? err : out, code };
}

describe("Stream-Abschluss im eigenen Bun-Prozess", () => {
  for (const channel of ["stdout", "stderr"]) {
    for (const kind of ["text", "bytes", "uint8", "hex"]) {
      for (const mode of ["direkt", "haupt", "kodiert", "ohne-chunk"]) {
        test(`${channel}, ${kind}, ${mode}: Abschluss ohne Token, Bruchstücke oder verlorene Daten`, async () => {
          const { text, other, code } = await run(channel, kind, mode);
          expect(code).toBe(0);
          expect(text).toBe(EXPECTED);
          expect(other).toBe("Abschluss genau einmal\n");
        });
      }
    }

    test(`${channel}: erzwungene Teilung einer langen Zeile, danach end`, async () => {
      const { text, other, code } = await run(channel, "bytes", "lang");
      expect(code).toBe(0);
      expect(text).toBe(TOKEN_MASK + "x".repeat(20_000) + TOKEN_MASK + "y".repeat(1000) + "\n");
      expect(other).toBe("Abschluss genau einmal\n");
    });
  }
});

function capture() {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  installLogMask({ console: {}, stdout: stream, stderr: { write: () => true }, tokens: () => [MAIN, AGENT] });
  return { stream, bytes: () => Buffer.concat(chunks) };
}

function finish(stream: Writable, chunk?: string | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => stream.end(chunk, (error?: Error | null) => error ? reject(error) : resolve()));
}

describe("gemeinsamer Zustand für write, end und Prozessende", () => {
  for (const token of [MAIN, AGENT, encodeURIComponent(MAIN), encodeURIComponent(AGENT)]) {
    test(`jede Schnittstelle von ${token === MAIN || token === AGENT ? "rohem" : "kodiertem"} Token mit Länge ${token.length}`, async () => {
      // Jede Byte-Grenze, einschließlich leerem write und leerem end, mit
      // wechselnder Darstellung; die Endausgabe enthält kein Zeilenende.
      for (let at = 0; at <= token.length; at++) {
        const { stream, bytes } = capture();
        stream.write(`bot${token.slice(0, at)}`);
        await finish(stream, Buffer.from(token.slice(at)));
        expect(bytes().toString()).toBe(`bot${TOKEN_MASK}`);
      }
    });
  }

  test("cork/uncork und Abschluss erhalten Reihenfolge und Callbacks", async () => {
    const { stream, bytes } = capture();
    const events: string[] = [];
    stream.cork();
    stream.write(`eins: bot${MAIN.slice(0, 15)}`, () => events.push("write 1"));
    stream.write(`${MAIN.slice(15)}/sendMessage\n`, () => events.push("write 2"));
    await finish(stream, `zwei: bot${AGENT}`);
    events.push("end");
    flushLogMask();
    expect(events).toEqual(["write 1", "write 2", "end"]);
    expect(bytes().toString()).toBe(`eins: bot${TOKEN_MASK}/sendMessage\nzwei: bot${TOKEN_MASK}`);
  });

  test("halbes UTF-8-Zeichen und Binärbytes bleiben am Abschluss erhalten", async () => {
    const { stream, bytes } = capture();
    const unicode = Buffer.from("Grüße ✓");
    stream.write(unicode.subarray(0, unicode.length - 1));
    const binary = Buffer.from([0xff, 0x00, 0xfe]);
    await finish(stream, Buffer.concat([unicode.subarray(-1), binary, Buffer.from(`bot${MAIN}`)]));
    expect(bytes()).toEqual(Buffer.concat([unicode, binary, Buffer.from(`bot${TOKEN_MASK}`)]));
  });

  test("end ist auch bei erneuter Installation geschützt; kein Rest nach finish", async () => {
    const { stream, bytes } = capture();
    const end = stream.end;
    installLogMask({ console: {}, stdout: stream, stderr: { write: () => true }, tokens: () => [MAIN, AGENT] });
    expect(stream.end).toBe(end);
    stream.write(`bot${AGENT}`);
    await finish(stream);
    const completed = bytes();
    flushLogMask();
    flushLogMask();
    expect(bytes()).toEqual(completed);
    expect(completed.toString()).toBe(`bot${TOKEN_MASK}`);
  });

  test("ein Ziel mit end über this.write puffert fertige Bytes nicht erneut", () => {
    const chunks: Buffer[] = [];
    const stream = {
      write(chunk: unknown) {
        chunks.push(Buffer.from(chunk as Uint8Array));
        return true;
      },
      end(chunk?: unknown, callback?: unknown) {
        if (chunk !== undefined) this.write(chunk);
        if (typeof callback === "function") callback();
        return this;
      },
    };
    installLogMask({ console: {}, stdout: stream, stderr: { write: () => true }, tokens: () => [MAIN, AGENT] });
    stream.write(`bot${AGENT.slice(0, 10)}`);
    let called = 0;
    expect(stream.end(AGENT.slice(10), () => called++)).toBe(stream);
    expect(called).toBe(1);
    expect(Buffer.concat(chunks).toString()).toBe(`bot${TOKEN_MASK}`);
    const count = chunks.length;
    flushLogMask();
    expect(chunks).toHaveLength(count);
  });

  test("write nach end bleibt ein Schreibfehler, auch wenn alles im Puffer warten würde", async () => {
    const { stream, bytes } = capture();
    stream.on("error", () => {});
    await finish(stream, `bot${MAIN}`);
    const error = await new Promise<Error | null | undefined>(resolve => stream.write("12345", resolve));
    expect((error as NodeJS.ErrnoException).code).toBe("ERR_STREAM_WRITE_AFTER_END");
    flushLogMask();
    expect(bytes().toString()).toBe(`bot${TOKEN_MASK}`);
  });

  test("Schreibfehler des Ziels bleiben am Abschluss sichtbar", async () => {
    const failure = new Error("Testziel nicht schreibbar");
    const received: string[] = [];
    const stream = new Writable({ write(chunk, _encoding, callback) {
      received.push(chunk.toString());
      callback(failure);
    } });
    const errors: Error[] = [];
    stream.on("error", error => errors.push(error));
    installLogMask({ console: {}, stdout: stream, stderr: { write: () => true }, tokens: () => [MAIN, AGENT] });
    await expect(finish(stream, `bot${MAIN}`)).rejects.toBe(failure);
    await new Promise(resolve => process.nextTick(resolve));
    expect(received).toEqual([`bot${TOKEN_MASK}`]);
    expect(errors).toEqual([failure]);
  });
});
