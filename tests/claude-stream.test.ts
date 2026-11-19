/**
 * Issue #326: stream-json-Leser ohne Prozess. Die Zeilen sind so gebaut, wie
 * die Claude-CLI sie mit --verbose --include-partial-messages schreibt.
 * Eigener Aufruf: bun test --preload ./tests/preload-env.ts tests/claude-stream.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  finishStreamReading,
  firstTextSnippet,
  MAX_RUN_STEPS,
  parseStreamLine,
  readStream,
  readStreamEvent,
  startStreamReading,
  stepFromToolBlock,
  TOOL_SIGNAL_GAP_MS,
} from "../src/lib/claude/stream";

type Event = Record<string, unknown>;

/** Zeilen mit Zeitpunkt; ohne Angabe eine Sekunde Abstand */
function lines(events: (Event | string)[], times?: number[]) {
  return events.map((e, i) => ({ line: typeof e === "string" ? e : JSON.stringify(e), at: times?.[i] ?? i * 1000 }));
}

const init = (id = "s1"): Event => ({ type: "system", subtype: "init", session_id: id });
const text = (msgId: string | undefined, t: string): Event => ({
  type: "assistant",
  message: { ...(msgId ? { id: msgId } : {}), content: [{ type: "text", text: t }] },
});
const tool = (msgId: string | undefined, name: string, input: Event = {}, id = `tu-${name}`): Event => ({
  type: "assistant",
  message: { ...(msgId ? { id: msgId } : {}), content: [{ type: "tool_use", id, name, input }] },
});
const result = (r: string, extra: Event = {}): Event => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: r,
  session_id: "s1",
  ...extra,
});
const delta = (t: string): Event => ({
  type: "stream_event",
  event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } },
});

const ANSWER = "Hier ist die eigentliche Antwort auf die Frage des Nutzers.";
const AFTER_HOOK = "Zusatz nach dem Hook: alte Befunde, die niemand wollte.";

describe("fertige Turns", () => {
  test("ein Turn: Text aus dem result-Ereignis", () => {
    const { outcome } = readStream(lines([init(), text("m1", ANSWER), result(ANSWER)]));
    expect(outcome.text).toBe(ANSWER);
    expect(outcome.joinedTurns).toBeUndefined();
  });

  test("mehrere fertige Turns: alle in Reihenfolge, Leerzeile dazwischen", () => {
    const { outcome } = readStream(
      lines([init(), text("m1", ANSWER), text("m2", AFTER_HOOK), text("m3", "Dritter Text."), result(AFTER_HOOK)])
    );
    expect(outcome.text).toBe(`${ANSWER}\n\n${AFTER_HOOK}\n\nDritter Text.`);
    expect(outcome.joinedTurns).toBe(3);
  });

  test("mehrere Blöcke derselben message.id sind ein Turn", () => {
    const { outcome } = readStream(
      lines([init(), text("m1", "Erster Teil, "), text("m1", "zweiter Teil."), result("zweiter Teil.")])
    );
    // Nur ein fertiger Turn: das result-Ereignis bleibt maßgeblich
    expect(outcome.text).toBe("zweiter Teil.");
    expect(outcome.joinedTurns).toBeUndefined();

    const two = readStream(
      lines([init(), text("m1", "Erster Teil, "), text("m1", "zweiter Teil."), text("m2", AFTER_HOOK), result(AFTER_HOOK)])
    ).outcome;
    expect(two.text).toBe(`Erster Teil, zweiter Teil.\n\n${AFTER_HOOK}`);
  });

  test("Turns mit tool_use zählen nicht, auch wenn sie Text haben", () => {
    const { outcome } = readStream(
      lines([
        init(),
        text("m1", "Ich schaue kurz in die Datei."),
        tool("m1", "Read", { file_path: "/tmp/a.txt" }),
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "inhalt" }] } },
        text("m2", ANSWER),
        result(ANSWER),
      ])
    );
    expect(outcome.text).toBe(ANSWER);
    expect(outcome.joinedTurns).toBeUndefined();
  });

  test("leere Texte zählen nicht als fertiger Turn", () => {
    const { outcome } = readStream(lines([init(), text("m1", "   "), text("m2", ANSWER), result(ANSWER)]));
    expect(outcome.joinedTurns).toBeUndefined();
    expect(outcome.text).toBe(ANSWER);
  });

  test("ohne message.id ist jedes Ereignis ein eigener Turn", () => {
    const { outcome } = readStream(lines([init(), text(undefined, ANSWER), text(undefined, AFTER_HOOK), result(AFTER_HOOK)]));
    expect(outcome.text).toBe(`${ANSWER}\n\n${AFTER_HOOK}`);
  });

  test("ohne message.id: Text nach einem Werkzeug ohne id gehört zu dessen Turn", () => {
    // Zuordnung wie vor #326: ohne id zählt „turn-<Zahl der Turns mit Text>".
    // Das Werkzeug-Ereignis hat keinen Text, der folgende Text landet im
    // selben Turn und zählt deshalb nicht als fertiger Turn
    const { outcome } = readStream(
      lines([
        init(),
        text(undefined, ANSWER),
        tool(undefined, "Read", { file_path: "/tmp/a.txt" }),
        text(undefined, AFTER_HOOK),
        result(AFTER_HOOK),
      ])
    );
    expect(outcome.text).toBe(AFTER_HOOK);
    expect(outcome.joinedTurns).toBeUndefined();
  });

  test("fehlendes result: der letzte Textblock gilt, verbunden wird trotzdem", () => {
    const single = readStream(lines([init(), text("m1", ANSWER)])).outcome;
    expect(single.text).toBe(ANSWER);
    expect(single.signal).toEqual({});

    const two = readStream(lines([init(), text("m1", ANSWER), text("m2", AFTER_HOOK)])).outcome;
    expect(two.text).toBe(`${ANSWER}\n\n${AFTER_HOOK}`);
  });

  test("weder result noch Text: leerer Text", () => {
    const { outcome } = readStream(lines([init(), tool("m1", "Bash", { command: "ls" })]));
    expect(outcome.text).toBe("");
    expect(outcome.joinedTurns).toBeUndefined();
  });
});

describe("Fehlersignale der CLI", () => {
  test("is_error true: kein Verbinden, Signal und Text unverändert", () => {
    const { outcome } = readStream(
      lines([
        init(),
        text("m1", ANSWER),
        text("m2", AFTER_HOOK),
        result("API Error: 529 overloaded", { is_error: true, subtype: "error_during_execution", api_error_status: 529 }),
      ])
    );
    expect(outcome.text).toBe("API Error: 529 overloaded");
    expect(outcome.joinedTurns).toBeUndefined();
    expect(outcome.signal).toEqual({ is_error: true, subtype: "error_during_execution", api_error_status: 529 });
  });

  test("fehlender api_error_status wird null, subtype bleibt", () => {
    const { outcome } = readStream(lines([init(), result("", { is_error: false, subtype: "error_max_turns" })]));
    expect(outcome.signal).toEqual({ is_error: false, subtype: "error_max_turns", api_error_status: null });
    expect(outcome.text).toBe("");
  });

  test("leeres result ohne Fehler: letzter Textblock", () => {
    const { outcome } = readStream(lines([init(), text("m1", ANSWER), result("")]));
    expect(outcome.text).toBe(ANSWER);
  });
});

describe("Session und Kosten", () => {
  test("Session aus init, das result-Ereignis hat Vorrang", () => {
    expect(readStream(lines([init("s-init"), text("m1", ANSWER)])).outcome.sessionId).toBe("s-init");
    expect(readStream(lines([init("s-init"), result(ANSWER, { session_id: "s-result" })])).outcome.sessionId).toBe(
      "s-result"
    );
    // result ohne Session behält die aus init
    expect(readStream(lines([init("s-init"), result(ANSWER, { session_id: undefined })])).outcome.sessionId).toBe(
      "s-init"
    );
    expect(readStream(lines([text("m1", ANSWER)])).outcome.sessionId).toBeUndefined();
  });

  test("Kosten im Ergebnis, ohne Signal (gebucht wird beim Aufrufer, Issue #346); ohne Zahl keine", () => {
    const run = readStream(lines([init(), result(ANSWER, { total_cost_usd: 0.42 })]));
    expect(run.signals).toEqual([]);
    expect(run.outcome.costUsd).toBe(0.42);

    // Mehrere result-Ereignisse (Hook-Folgeturns): Summe
    const two = readStream(lines([init(), result(ANSWER, { total_cost_usd: 0.1 }), result(ANSWER, { total_cost_usd: 0.25 })]));
    expect(two.outcome.costUsd).toBeCloseTo(0.35, 10);

    const none = readStream(lines([init(), result(ANSWER, { total_cost_usd: "0.42" })]));
    expect(none.signals).toEqual([]);
    expect(none.outcome.costUsd).toBeUndefined();
  });
});

describe("Fortschritt", () => {
  test("erster Text einmal, erst ab mehr als 30 Zeichen, mit Kurzfassung und vollem Text", () => {
    const long = "Ich prüfe zuerst die Konfiguration. Danach schaue ich in die Logs.";
    const { signals } = readStream(
      lines([init(), text("m1", "Kurz."), text("m1", "x".repeat(30)), text("m2", long), text("m3", ANSWER)])
    );
    const firsts = signals.filter((s) => s.kind === "firstText");
    expect(firsts).toEqual([{ kind: "firstText", snippet: "Ich prüfe zuerst die Konfiguration.", text: long }]);
  });

  test("Werkzeuge höchstens alle fünf Sekunden, der erste sofort, rohe Namen", () => {
    const events = [tool("m1", "Read"), tool("m1", "Grep"), tool("m2", "Bash"), tool("m3", "mcp__gmail__search")];
    const { signals } = readStream(lines(events, [0, TOOL_SIGNAL_GAP_MS - 1, TOOL_SIGNAL_GAP_MS, 2 * TOOL_SIGNAL_GAP_MS]));
    expect(signals).toEqual([
      { kind: "tool", name: "Read" },
      { kind: "tool", name: "Bash" },
      { kind: "tool", name: "mcp__gmail__search" },
    ]);
  });

  test("gedrosselte Werkzeuge stehen trotzdem in uses und steps", () => {
    const { outcome } = readStream(lines([tool("m1", "Read", { file_path: "/a" }), tool("m1", "Grep", { pattern: "x" })], [0, 1]));
    expect(outcome.uses.map((u) => u.name)).toEqual(["Read", "Grep"]);
    expect(outcome.steps).toEqual([
      { name: "Read", input: "/a" },
      { name: "Grep", input: "x" },
    ]);
  });

  test("Werkzeug ohne Namen: kein Signal, kein Schritt, Turn zählt aber als Werkzeug-Turn", () => {
    const nameless: Event = { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t" }, { type: "text", text: ANSWER }] } };
    const { signals, outcome } = readStream(lines([nameless, text("m2", AFTER_HOOK), result(AFTER_HOOK)]));
    expect(signals.filter((s) => s.kind === "tool")).toEqual([]);
    expect(outcome.steps).toEqual([]);
    expect(outcome.joinedTurns).toBeUndefined();
  });
});

describe("Lebenszeichen und Teil-Nachrichten", () => {
  test("gültige Zeilen aller Art zählen, leere und kaputte nicht", () => {
    const run = readStream(
      lines([
        "",
        "   ",
        "{kaputt",
        "42",
        "null",
        init(),
        delta("Hal"),
        { type: "tool_progress", tool_use_id: "t1", elapsed_time_seconds: 30 },
        { type: "user", message: { content: [] } },
      ])
    );
    expect(run.activeLines).toBe(4);
    expect(parseStreamLine("")).toBeUndefined();
    expect(parseStreamLine("{kaputt")).toBeUndefined();
    expect(parseStreamLine('{"type":"stream_event"}')).toEqual({ type: "stream_event" });
  });

  test("Deltas doppeln weder Text noch Werkzeuge noch Rückrufe", () => {
    const run = readStream(
      lines([
        init(),
        { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } },
        delta(ANSWER.slice(0, 20)),
        delta(ANSWER.slice(20)),
        {
          type: "stream_event",
          event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "Read" } },
        },
        text("m1", ANSWER),
        { type: "stream_event", event: { type: "message_stop" } },
        result(ANSWER),
      ])
    );
    expect(run.outcome.text).toBe(ANSWER);
    expect(run.outcome.uses).toEqual([]);
    expect(run.signals).toEqual([{ kind: "firstText", snippet: firstTextSnippet(ANSWER), text: ANSWER }]);
  });
});

describe("Schritte für den Bericht beim Zeitlimit", () => {
  test("die letzten acht in Reihenfolge, Eingabe ungekürzt, letzter Text", () => {
    const longCommand = "echo " + "x".repeat(500);
    const events: Event[] = [];
    for (let i = 1; i <= 11; i++) events.push(tool(`m${i}`, "Bash", { command: i === 11 ? longCommand : `schritt ${i}` }));
    events.push(text("m12", "Zwischenstand, gleich geht es weiter mit dem Rest."));
    const reading = events.reduce((r, e, i) => readStreamEvent(r, e, i).reading, startStreamReading());
    const outcome = finishStreamReading(reading);
    expect(MAX_RUN_STEPS).toBe(8);
    expect(outcome.steps.map((s) => s.input)).toEqual([
      "schritt 4",
      "schritt 5",
      "schritt 6",
      "schritt 7",
      "schritt 8",
      "schritt 9",
      "schritt 10",
      longCommand,
    ]);
    expect(outcome.lastText).toBe("Zwischenstand, gleich geht es weiter mit dem Rest.");
    // Spätere Ereignisse ändern weder das Ergebnis noch den alten Zustand
    readStreamEvent(reading, tool("m13", "Read", { file_path: "/b" }), 13);
    expect(outcome.steps).toHaveLength(8);
    expect(outcome.steps[7].input).toBe(longCommand);
    expect(finishStreamReading(reading)).toEqual(outcome);
  });

  test("Eingabefelder in fester Rangfolge, leere übersprungen", () => {
    const block = (input: unknown) => ({ type: "tool_use", name: "X", input });
    expect(stepFromToolBlock(block({ description: "d", command: "c" }))).toEqual({ name: "X", input: "c" });
    expect(stepFromToolBlock(block({ command: "  ", file_path: "/f" }))).toEqual({ name: "X", input: "/f" });
    expect(stepFromToolBlock(block({ notebook_path: "/n", path: "/p" }))).toEqual({ name: "X", input: "/n" });
    expect(stepFromToolBlock(block({ url: "https://example.org", query: "q" }))).toEqual({ name: "X", input: "https://example.org" });
    expect(stepFromToolBlock(block({ pattern: "p", description: "d" }))).toEqual({ name: "X", input: "p" });
    expect(stepFromToolBlock(block({ count: 3 }))).toEqual({ name: "X" });
    expect(stepFromToolBlock(block(null))).toEqual({ name: "X" });
    expect(stepFromToolBlock({ type: "tool_use", name: "" })).toBeNull();
    expect(stepFromToolBlock({ type: "text", text: "a" })).toBeNull();
    expect(stepFromToolBlock(null)).toBeNull();
  });
});

/** Tiefe Kopie und tief eingefroren: jede Änderung wirft (Module laufen strikt) */
function frozen<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (v: unknown) => {
    if (typeof v !== "object" || v === null) return;
    Object.freeze(v);
    for (const inner of Object.values(v)) freeze(inner);
  };
  freeze(copy);
  return copy;
}

describe("Zustandsübergang", () => {
  const EVENTS: Event[] = [
    init(),
    text("m1", "Ich schaue zuerst in die Konfiguration und dann in die Logs."),
    tool("m1", "Read", { file_path: "/a" }),
    tool(undefined, "Bash", { command: "ls" }),
    text(undefined, ANSWER),
    text("m3", AFTER_HOOK),
    { type: "rate_limit_event", rate_limit_info: { rateLimitType: "five_hour", utilization: 0.42 } },
    { type: "rate_limit_event", rate_limit_info: { rateLimitType: "seven_day", utilization: 0.91 } },
    { type: "rate_limit_event", rate_limit_info: { rateLimitType: "seven_day", utilization: 0.92 } },
    result(AFTER_HOOK, { total_cost_usd: 0.1 }),
  ];

  test("Zustand und Ereignis bleiben unverändert, auch eingefroren", () => {
    let reading = startStreamReading();
    EVENTS.forEach((event, i) => {
      const before = frozen(reading);
      const input = frozen(event);
      const snapshot = structuredClone(reading);
      const step = readStreamEvent(before, input, i * 1000);
      expect(before).toEqual(snapshot);
      expect(input).toEqual(event);
      reading = step.reading;
    });
    const end = frozen(reading);
    const outcome = finishStreamReading(end);
    // ANSWER hat keine id und folgt auf Bash ohne id: Werkzeug-Turn, zählt nicht
    expect(outcome.text).toBe(AFTER_HOOK);
    expect(outcome.joinedTurns).toBeUndefined();
    expect(outcome.steps.map((s) => s.name)).toEqual(["Read", "Bash"]);
    expect(outcome.costUsd).toBe(0.1);
  });

  test("derselbe Ausgangszustand ergibt wiederholt dasselbe", () => {
    let reading = startStreamReading();
    EVENTS.forEach((event, i) => {
      const first = readStreamEvent(reading, event, i * 1000);
      const second = readStreamEvent(reading, event, i * 1000);
      expect(second).toEqual(first);
      reading = first.reading;
    });
    expect(finishStreamReading(reading)).toEqual(finishStreamReading(reading));
    // Ein Zwischenstand bleibt nutzbar: zwei Fortsetzungen vom selben Stand
    const middle = EVENTS.slice(0, 3).reduce((r, e, i) => readStreamEvent(r, e, i * 1000).reading, startStreamReading());
    const a = readStreamEvent(middle, text("m9", ANSWER), 5000);
    const b = readStreamEvent(middle, text("m9", ANSWER), 5000);
    expect(a).toEqual(b);
    expect(finishStreamReading(middle).lastText).toBe("Ich schaue zuerst in die Konfiguration und dann in die Logs.");
  });
});

describe("Limit-Messwerte", () => {
  const at = Date.parse("2026-01-02T12:00:00.000Z");
  const reset = "2026-11-22T15:00:00.000Z";
  const event = (rate_limit_info: unknown): Event => ({ type: "rate_limit_event", rate_limit_info });
  const known = { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.91, resetsAt: 1795359600 };
  const read = (info: unknown) => readStream(lines([event(info)], [at])).outcome.rateLimit;

  test("Vorlage: 6 Prozent, Reset in UTC, Quelle stream, Messzeit der Zeile, Antwort unverändert", () => {
    const fixture = readFileSync(new URL("./fixtures/claude-rate-limit-stream.jsonl", import.meta.url), "utf8").trim().split("\n");
    const run = readStream(fixture.map((line, i) => ({ line, at: at + i * 1000 })));
    expect(run.activeLines).toBe(4);
    expect(run.signals).toEqual([]);
    expect(run.outcome).toMatchObject({ text: "ok", costUsd: 0.005, signal: { is_error: false }, rateLimit: {
      status: "allowed", rateLimitType: "seven_day", resetsAt: reset,
      overageStatus: "rejected", isUsingOverage: false,
      windows: [{ id: "weekly_all", percent: 6, resetsAt: reset, measuredAt: "2026-01-02T12:00:02.000Z", source: "stream" }],
    } });
    expect(run.outcome.rateLimit).not.toHaveProperty("overageDisabledReason");
  });

  // Die folgenden Ereignisse sind aus dem dokumentierten Format gebaut,
  // keine Mitschnitte eines echten Laufs.
  test("ohne unifiedWindows kommen 91 Prozent aus der obersten Ebene", () => {
    expect(read(known)).toEqual({ status: "allowed_warning", rateLimitType: "seven_day", resetsAt: reset,
      windows: [{ id: "weekly_all", percent: 91, resetsAt: reset, measuredAt: new Date(at).toISOString(), source: "stream" }],
    });
  });

  test("fünf Stunden neben der Woche, interne Fenster haben Vorrang", () => {
    const rate = read({ ...known, unifiedWindows: {
      five_hour: { utilization: 0.42, resetsAt: 1794790800, status: "allowed" },
      seven_day: { utilization: 0.06, resetsAt: 1795359600, status: "allowed" },
    } });
    expect(rate?.windows).toEqual([
      { id: "session", percent: 42, resetsAt: "2026-11-16T01:00:00.000Z", measuredAt: new Date(at).toISOString(), source: "stream" },
      { id: "weekly_all", percent: 6, resetsAt: reset, measuredAt: new Date(at).toISOString(), source: "stream" },
    ]);
  });

  test("Teil-Limits: Opus und Sonnet, Reset darf fehlen", () => {
    for (const family of ["opus", "sonnet"]) {
      expect(read({ rateLimitType: `seven_day_${family}`, utilization: 0.5 })?.windows).toEqual([
        { id: `weekly_scoped:${family}`, percent: 50, measuredAt: new Date(at).toISOString(), source: "stream" },
      ]);
    }
  });

  test("Arten ohne Zuordnung behalten die Kopffelder, auch Reset und Fehler ohne Prozentfenster", () => {
    for (const rateLimitType of ["overage", "seven_day_overage_included", "unbekannt"]) {
      expect(read({ ...known, rateLimitType, errorCode: "credits_required", overageStatus: "rejected", isUsingOverage: true }))
        .toEqual({ status: "allowed_warning", rateLimitType, resetsAt: reset,
          errorCode: "credits_required", overageStatus: "rejected", isUsingOverage: true, windows: [] });
    }
    const { utilization: _, ...withoutPercent } = known;
    expect(read(withoutPercent)).toEqual({ status: "allowed_warning", rateLimitType: "seven_day", resetsAt: reset, windows: [] });
  });

  test("Rundung und obere Begrenzung nur im Aufrufer der Ablage", () => {
    for (const [utilization, percent] of [[0, 0], [0.0649, 6], [0.065, 7], [1, 100], [1.5, 100], [Number.MAX_VALUE, 100]]) {
      expect(read({ ...known, utilization })?.windows[0]?.percent).toBe(percent);
    }
  });

  test("kaputte oberste Ebene verändert weder Zustand noch bisherige Messungen", () => {
    const good = frozen(readStreamEvent(startStreamReading(), event(known), at).reading);
    for (const info of [undefined, null, "Text", [], {}, { ...known, utilization: "0.5" },
      { ...known, utilization: -1 }, { ...known, utilization: NaN }, { ...known, utilization: Infinity },
      { ...known, resetsAt: "1795359600" }, { ...known, resetsAt: -1 }, { ...known, resetsAt: 1e99 }]) {
      expect(readStreamEvent(startStreamReading(), event(info), at).reading.rateLimit?.windows ?? []).toEqual([]);
      expect(readStreamEvent(good, event(info), at).reading).toBe(good);
    }
  });

  test("kaputte einzelne interne Fenster werden verworfen, gültige bleiben", () => {
    for (const broken of [null, "Text", { utilization: "0.5" }, { utilization: -1 },
      { utilization: NaN }, { utilization: Infinity }, { utilization: 0.5, resetsAt: "1795359600" },
      { utilization: 0.5, resetsAt: -1 }, { utilization: 0.5, resetsAt: 1e99 }]) {
      const rate = read({ ...known, unifiedWindows: { seven_day: broken, five_hour: { utilization: 0.42 } } });
      expect(rate?.windows.map(w => [w.id, w.percent])).toEqual([["session", 42]]);
    }
  });

  test("unifiedWindows ohne Objekt nutzt die oberste Ebene; leeres oder unbekanntes Objekt bleibt leer", () => {
    for (const unifiedWindows of [undefined, null, "Text", 1, []]) {
      expect(read({ ...known, unifiedWindows })?.windows[0]?.percent).toBe(91);
    }
    for (const unifiedWindows of [{}, { overage: { utilization: 0.9 } }, { seven_day: { utilization: "0.5" } }]) {
      expect(read({ ...known, unifiedWindows })?.windows).toEqual([]);
    }
  });

  test("gleiche Art: letzte Messung; verschiedene Arten: beide Fenster, letzte Kopffelder", () => {
    const events = [event({ ...known, rateLimitType: "five_hour", utilization: 0.42, isUsingOverage: false }),
      event(known), event({ rateLimitType: "seven_day", utilization: 0.92, status: "rejected", errorCode: "limit" })];
    const outcome = readStream(lines(events, [at, at + 1000, at + 2000])).outcome;
    expect(outcome.rateLimit).toEqual({ rateLimitType: "seven_day", status: "rejected", errorCode: "limit", windows: [
      { id: "session", percent: 42, resetsAt: reset, measuredAt: new Date(at).toISOString(), source: "stream" },
      { id: "weekly_all", percent: 92, measuredAt: new Date(at + 2000).toISOString(), source: "stream" },
    ] });
    expect(readStream(lines([...events, event({ rateLimitType: "overage" })])).outcome.rateLimit?.windows).toHaveLength(2);
  });

  test("ohne Ereignis kein neues Ergebnisfeld, unbrauchbare Uhrzeit kein Wurf", () => {
    expect(readStream(lines([result("ok")])).outcome).not.toHaveProperty("rateLimit");
    for (const at of [NaN, Infinity, 1e99]) {
      expect(readStreamEvent(startStreamReading(), event(known), at).reading).not.toHaveProperty("rateLimit");
    }
  });
});

describe("Verbrauchsbericht", () => {
  test("letztes Objekt aus assistant, auch ohne Nachrichtenblöcke; übriges Ergebnis unverändert", () => {
    const first = frozen({ rate_limits: { limits: [] } });
    const last = frozen({ rate_limits: { limits: [{ kind: "session", percent: 21 }] } });
    const events = [init(), text("m1", ANSWER), result(ANSWER, { total_cost_usd: 0 })];
    const before = readStream(lines(events)).outcome;
    const run = readStream(lines([
      ...events, frozen({ type: "assistant", usage_report: first }),
      frozen({ type: "assistant", usage_report: last }),
      { type: "result", ...result(ANSWER), usage_report: first },
    ]));
    expect(run.outcome).toEqual({ ...before, usageReport: last });
  });

  test("fehlend, null, Text und Array übergehen; bisherigen Bericht behalten", () => {
    const report = frozen({ rate_limits: { limits: null } });
    const reading = frozen(readStreamEvent(startStreamReading(), { type: "assistant", usage_report: report }, 0).reading);
    for (const usage_report of [undefined, null, "Bericht", 1, []]) {
      const event = frozen({ type: "assistant", usage_report });
      expect(finishStreamReading(readStreamEvent(startStreamReading(), event, 1).reading)).not.toHaveProperty("usageReport");
      expect(readStreamEvent(reading, event, 1).reading).toBe(reading);
    }
    expect(readStream(lines(["{kaputt"])).outcome).not.toHaveProperty("usageReport");
  });
});

describe("firstTextSnippet", () => {
  test("erster Satz zwischen 30 und 150 Zeichen", () => {
    expect(firstTextSnippet("Das ist ein Satz mit genug Zeichen. Und noch einer.")).toBe("Das ist ein Satz mit genug Zeichen.");
    expect(firstTextSnippet("Kurz. Danach kommt ein langer zweiter Satz mit Inhalt!")).toBe(
      "Kurz. Danach kommt ein langer zweiter Satz mit Inhalt!"
    );
    expect(firstTextSnippet("Eine Zeile ohne Satzzeichen, aber lang genug\nzweite Zeile")).toBe(
      "Eine Zeile ohne Satzzeichen, aber lang genug"
    );
  });

  test("Zeilenumbruch vor dem 30. Zeichen oder kein Satzende: die ersten 150 Zeichen", () => {
    expect(firstTextSnippet("Titel\nDanach ein langer Absatz mit einem Punkt am Ende.")).toBe(
      "Titel\nDanach ein langer Absatz mit einem Punkt am Ende."
    );
    const long = "a".repeat(200);
    expect(firstTextSnippet(long)).toBe("a".repeat(150));
    expect(firstTextSnippet("a".repeat(150) + ".")).toBe("a".repeat(150) + ".");
    expect(firstTextSnippet("a".repeat(151) + ".")).toBe("a".repeat(150));
    expect(firstTextSnippet("  kurz  ")).toBe("kurz");
  });
});
