/** Limit-Erkennung über die echten Aufrufwege; alle CLI-Ausgaben sind Prozessattrappen. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { callClaude, callClaudeStreaming, setRuntimeForTests, setSpawnForTests } from "../src/lib/claude";
import { createClaudeEngine } from "../src/lib/engines/claude";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { isolateShellEnv } from "./shell-env";

isolateShellEnv({ CLAUDE_AUTH: "subscription", ANTHROPIC_API_KEY: undefined });

const WEEKLY = "You've hit your weekly limit · resets Nov 22, 4pm";
const CREDITS = "You're out of usage credits.";
const QUOTE = "You've hit your weekly limit bedeutet, dass dein Wochenlimit erreicht ist.";
const SUCCESS = { type: "result", subtype: "success", is_error: false };
// Nach der Dokumentation gebaut, kein Mitschnitt eines echten Limits.
const rejected = (extra: object = {}) => ({
  type: "rate_limit_event",
  rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 1795359600, ...extra },
});
const assistant = (text: string, id = "m1") => ({
  type: "assistant", message: { id, content: [{ type: "text", text }] },
});

let log: ReturnType<typeof spyOn>;
beforeEach(() => {
  setMcpReaderForTests(() => new Set());
  setRuntimeForTests({ terminate: () => {} }); // pid 0 bekommt nie ein echtes Signal.
  setSpawnForTests((() => { throw new Error("Unerwarteter Prozessstart"); }) as any);
  log = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  setSpawnForTests(null);
  setRuntimeForTests(null);
  setMcpReaderForTests(null);
  log.mockRestore();
});

function output(text: string, exitCode = 0) {
  setSpawnForTests((() => ({
    pid: 0,
    stdin: { write() {}, end() {} },
    stdout: new Response(text).body!,
    stderr: new Response("").body!,
    exited: Promise.resolve(exitCode),
    kill() { throw new Error("Echtes Prozesssignal ist in diesem Test verboten"); },
  })) as any);
}

function stream(events: object[]) {
  output(events.map(event => JSON.stringify(event)).join("\n") + "\n");
  return callClaudeStreaming({ prompt: "Probe" });
}

function json(value: unknown) {
  output(JSON.stringify(value));
  return callClaude({ prompt: "Probe", outputFormat: "json" });
}

const messages = [
  [WEEKLY, "usage_limit"],
  ["You've reached your weekly limit", "usage_limit"],
  [CREDITS, "quota"],
] as const;

describe("Textausgabe und nackter Text im JSON-Modus", () => {
  for (const outputFormat of ["text", "json"] as const) {
    for (const exitCode of [0, 1]) {
      for (const [text, errorKind] of messages) {
        test(`${outputFormat}, Exit ${exitCode}, ${text}`, async () => {
          output(text, exitCode);
          expect(await callClaude({ prompt: "Probe", outputFormat })).toMatchObject({ text, isError: true, errorKind });
        });
      }
    }
  }
});

describe("JSON-Ergebnis", () => {
  for (const list of [false, true]) {
    for (const signal of [{ is_error: true }, {}]) {
      for (const [text, errorKind] of messages) {
        test(`${list ? "Liste" : "Objekt"}, Signal ${JSON.stringify(signal)}, ${text}`, async () => {
          const result = { type: "result", result: text, ...signal };
          const received = await json(list ? [result] : result);
          expect(received).toMatchObject({ text, isError: true, errorKind });
          expect(received).not.toHaveProperty("rateLimit");
        });
      }
    }

    test(`${list ? "Liste" : "Objekt"}: Erfolgssignal schützt zitierten Meldungsanfang`, async () => {
      const result = { ...SUCCESS, result: QUOTE };
      const received = await json(list ? [result] : result);
      expect(received).toMatchObject({ text: QUOTE, isError: false });
      expect(received).not.toHaveProperty("errorKind");
    });
  }

  for (const is_error of [false, true]) {
    test(`Limit-Ereignis nur für das Urteil, is_error=${is_error}`, async () => {
      const result = await json([rejected(), { ...SUCCESS, is_error, result: WEEKLY }]);
      expect(result).toMatchObject({ text: WEEKLY, isError: true, errorKind: "usage_limit" });
      expect(result).not.toHaveProperty("rateLimit");
    });
  }

  test("credits_required und leerer Erfolg werden quota, ohne Messwerte im Ergebnis", async () => {
    const result = await json([rejected({ errorCode: "credits_required" }), { ...SUCCESS, result: "" }]);
    expect(result).toMatchObject({ text: "", isError: true, errorKind: "quota" });
    expect(result).not.toHaveProperty("rateLimit");
  });

  test("fehlendes result bleibt ein Fehler, Limit-Ereignis liefert die Fehlerart", async () => {
    expect(await json([rejected({ errorCode: "credits_required" })])).toMatchObject({ text: "", isError: true, errorKind: "quota" });
  });

  test("das letzte Limit-Ereignis gilt auch in der JSON-Liste", async () => {
    const result = await json([rejected(), rejected({ status: "allowed" }), { ...SUCCESS, result: QUOTE }]);
    expect(result).toMatchObject({ text: QUOTE, isError: false });
    expect(result).not.toHaveProperty("errorKind");
    expect(result).not.toHaveProperty("rateLimit");
  });
});

describe("Ereignisstrom", () => {
  for (const is_error of [false, true]) {
    test(`rejected, Limit-Meldung und is_error=${is_error}`, async () => {
      expect(await stream([rejected(), { ...SUCCESS, is_error, result: WEEKLY }])).toMatchObject({
        text: WEEKLY, isError: true, errorKind: "usage_limit",
        rateLimit: { status: "rejected", rateLimitType: "seven_day", resetsAt: "2026-11-22T15:00:00.000Z" },
      });
    });
  }

  test.each(["", " \t\n"])("credits_required, leerer Text %j ohne assistant-Ereignis", async (text) => {
    expect(await stream([rejected({ errorCode: "credits_required" }), { ...SUCCESS, result: text }])).toMatchObject({
      isError: true, errorKind: "quota",
    });
  });

  for (const [text, errorKind] of messages) {
    test(`ohne result entscheidet der Meldungsanfang: ${text}`, async () => {
      expect(await stream([assistant(text)])).toMatchObject({ text, isError: true, errorKind });
    });
  }

  test("ohne result und ohne Antwort reicht rejected", async () => {
    expect(await stream([rejected()])).toMatchObject({ text: "", isError: true, errorKind: "usage_limit" });
  });

  test("allowed mit overageStatus rejected lässt ein Zitat als Antwort durch", async () => {
    const result = await stream([
      rejected({ status: "allowed", overageStatus: "rejected", isUsingOverage: false }),
      { ...SUCCESS, result: QUOTE },
    ]);
    expect(result).toMatchObject({ text: QUOTE, isError: false });
    expect(result).not.toHaveProperty("errorKind");
  });

  test("gewöhnliche Antwort trotz rejected mit Zusatzguthaben bleibt gelungen", async () => {
    const result = await stream([rejected({ isUsingOverage: true }), { ...SUCCESS, result: "Alles erledigt." }]);
    expect(result).toMatchObject({ text: "Alles erledigt.", isError: false });
    expect(result).not.toHaveProperty("errorKind");
  });

  test("rejected gefolgt von allowed: letzter Status zählt, Zitat bleibt Antwort", async () => {
    const result = await stream([rejected(), rejected({ status: "allowed" }), { ...SUCCESS, result: QUOTE }]);
    expect(result).toMatchObject({ text: QUOTE, isError: false, rateLimit: { status: "allowed" } });
    expect(result).not.toHaveProperty("errorKind");
  });

  for (const withResult of [false, true]) {
    test(`Limit nach mehreren fertigen Turns, result=${withResult}`, async () => {
      const result = await stream([
        assistant("Erster Teil ist erledigt.", "m1"), assistant(WEEKLY, "m2"), rejected(),
        ...(withResult ? [{ ...SUCCESS, result: WEEKLY }] : []),
      ]);
      expect(result).toMatchObject({
        text: `Erster Teil ist erledigt.\n\n${WEEKLY}`, isError: true, errorKind: "usage_limit",
      });
    });
  }
});

describe("Claude-Motor reicht die Fehlerart durch", () => {
  for (const streaming of [false, true]) {
    for (const [text, errorKind] of messages) {
      test(`${streaming ? "Strom" : "JSON"}, ${errorKind}, ${text}`, async () => {
        const events = [rejected(), { ...SUCCESS, result: text }];
        output(streaming ? events.map(event => JSON.stringify(event)).join("\n") + "\n" : JSON.stringify(events));
        const result = await createClaudeEngine().run({ prompt: "Probe", streaming, cwd: process.cwd(), timeoutMs: 5000 });
        expect(result).toMatchObject({ engine: "claude", isError: true, errorKind });
        if (!streaming) expect(result).not.toHaveProperty("rateLimit");
      });
    }
  }
});

describe("Andere Fehler bekommen keine Limit-Fehlerart", () => {
  for (const text of ["overloaded_error", "network error: connection reset"]) {
    for (const withRateLimit of [false, true]) {
      for (const format of ["Strom", "JSON"]) {
        test(`${format}, ${text}, allowed=${withRateLimit}`, async () => {
          const events = [
            ...(withRateLimit ? [rejected({ status: "allowed" })] : []),
            { type: "result", is_error: true, subtype: "error_during_execution", result: text },
          ];
          const result = await (format === "Strom" ? stream(events) : json(events));
          expect(result).toMatchObject({ text, isError: true });
          expect(result).not.toHaveProperty("errorKind");
        });
      }
    }
  }

  test("Textausgabe mit bisherigem Überlast-Marker bleibt ein Fehler ohne Limit-Fehlerart", async () => {
    output("overloaded_error", 1);
    expect(await callClaude({ prompt: "Probe" })).toEqual({ text: "overloaded_error", isError: true });
  });
});

describe("Diagnose [ClaudeLimit]", () => {
  const entries = () => log.mock.calls.map(call => String(call[0])).filter(line => line.startsWith("[ClaudeLimit] "));
  const detail = () => {
    const lines = entries();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    return JSON.parse(lines[0].slice("[ClaudeLimit] ".length));
  };

  for (const format of ["Text", "JSON", "Strom", "nacktes JSON"]) {
    test(`${format}: genau eine Zeile mit höchstens 120 Zeichen der Limit-Meldung`, async () => {
      const text = `${WEEKLY}\n${".".repeat(120 - WEEKLY.length - 1)}DAHINTER_NICHT_PROTOKOLLIEREN`;
      const event = { ...SUCCESS, is_error: true, api_error_status: 429, result: text, ignored: "NICHT_IM_LOG" };
      if (format === "Strom") await stream([rejected({ errorCode: "credits_required", overageStatus: "rejected", isUsingOverage: false }), event]);
      else if (format === "JSON") await json(event);
      else {
        output(text);
        await callClaude({ prompt: "Probe", outputFormat: format === "Text" ? "text" : "json" });
      }
      const entry = detail();
      expect(entry.message).toBe(text.slice(0, 120));
      expect(entry.message).toHaveLength(120);
      expect(entries()[0]).not.toContain("DAHINTER_NICHT_PROTOKOLLIEREN");
      expect(entries()[0]).not.toContain("NICHT_IM_LOG");
      if (format === "Strom" || format === "JSON") {
        expect(entry.result).toEqual({ is_error: true, subtype: "success", api_error_status: 429 });
      } else expect(entry.result).toEqual({ is_error: null, subtype: null, api_error_status: null });
      if (format === "Strom") {
        expect(entry.errorKind).toBe("quota");
        expect(entry.rateLimit).toEqual({
          status: "rejected", rateLimitType: "seven_day", resetsAt: "2026-11-22T15:00:00.000Z",
          errorCode: "credits_required", overageStatus: "rejected", isUsingOverage: false, windows: [],
        });
      } else expect(entry.rateLimit).toBeNull();
    });
  }

  test("JSON-Liste: Limit-Signal ist im Log, aber nicht im Ergebnis", async () => {
    const result = await json([rejected(), { ...SUCCESS, result: WEEKLY }]);
    expect(result).not.toHaveProperty("rateLimit");
    expect(detail()).toMatchObject({
      message: WEEKLY, result: { is_error: false, subtype: "success", api_error_status: null },
      rateLimit: { status: "rejected", resetsAt: "2026-11-22T15:00:00.000Z" },
    });
  });

  for (const info of [{}, { errorCode: "credits_required" }]) {
    test(`Fehler nur durch Ereignis ${JSON.stringify(info)}: letzter Antwortblock wird nicht protokolliert`, async () => {
      const text = "VERTRAULICHER_ANTWORTINHALT ".repeat(30);
      const result = await stream([
        rejected(info), assistant(text),
        { type: "result", subtype: "error_max_turns", is_error: true, result: "" },
      ]);
      expect(result).toMatchObject({ text, isError: true, errorKind: "errorCode" in info ? "quota" : "usage_limit" });
      expect(detail()).toMatchObject({ textLength: text.length, result: { is_error: true, subtype: "error_max_turns" } });
      expect(detail()).not.toHaveProperty("message");
      expect(log.mock.calls.flat().join(" ")).not.toContain("VERTRAULICHER_ANTWORTINHALT");
    });
  }

  test("Limit am Ende mehrerer Turns: kein vorangegangener Antwortinhalt im Log", async () => {
    await stream([assistant("VERTRAULICHER_ERSTER_TURN", "m1"), assistant(WEEKLY, "m2"), rejected(), { ...SUCCESS, result: WEEKLY }]);
    expect(detail().message).toBe(WEEKLY);
    expect(log.mock.calls.flat().join(" ")).not.toContain("VERTRAULICHER_ERSTER_TURN");
  });

  test("langer Text mit Limit-Anfang: Fehlerart nur vom Ereignis, deshalb nur Länge im Log", async () => {
    const text = WEEKLY + " PRIVATER_INHALT".repeat(40);
    await stream([rejected(), { ...SUCCESS, is_error: true, result: text }]);
    expect(detail().textLength).toBe(text.length);
    expect(detail()).not.toHaveProperty("message");
    expect(log.mock.calls.flat().join(" ")).not.toContain("PRIVATER_INHALT");
  });

  test("kein Limit-Log bei gewöhnlicher Antwort, erfolgreichem Zitat oder anderem Fehler", async () => {
    await stream([{ ...SUCCESS, result: "Alles erledigt" }]);
    await stream([rejected({ status: "allowed", overageStatus: "rejected" }), { ...SUCCESS, result: QUOTE }]);
    await stream([rejected({ isUsingOverage: true }), { ...SUCCESS, result: "Alles erledigt" }]);
    await stream([{ ...SUCCESS, is_error: true, result: "overloaded_error" }]);
    await json({ ...SUCCESS, result: QUOTE });
    expect(entries()).toEqual([]);
  });
});
