import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import {
  runStreamingTurn,
  runJsonTurn,
  ABORT_REPLY,
  LONG_RUN_NOTICE_MS,
  LONG_RUN_NOTICE_TEXT,
  TIMEOUT_NOTICE_TEXT,
  FALLBACK_FAILED_REPLY,
  CLAUDE_CALL_TIMEOUT_MS,
  type ChatTurnDeps,
  type TurnInfo,
  type TurnProgress,
  type TurnSink,
} from "../src/lib/chat-turn";
import { sessionKeyFor } from "../src/lib/convex";
import type { ClaudeResult, ClaudeStreamOptions } from "../src/lib/claude";
import type { BotSession } from "../src/lib/session-manager";
import type { FallbackResult } from "../src/lib/fallback-llm";

// Alle Abhaengigkeiten sind Fakes: kein Claude, kein Fallback, keine Dateien,
// keine Datenbank, keine echten Timer.

// CLAUDE_EFFORT aus der Shell hat Vorrang vor dem Effort der Agenten-Datei;
// fuer diese Tests ausblenden, damit der Effort aus der Fake-Konfiguration gilt.
const savedClaudeEffort = process.env.CLAUDE_EFFORT;
beforeAll(() => {
  delete process.env.CLAUDE_EFFORT;
});
afterAll(() => {
  if (savedClaudeEffort !== undefined) process.env.CLAUDE_EFFORT = savedClaudeEffort;
});

const CHAT = "4242";
const AGENT = "general";
const MODEL = "test-model";
const KEY = sessionKeyFor(CHAT, null);

interface Recorder {
  events: string[];
  claudeCalls: ClaudeStreamOptions[];
  fallbackCalls: [string, string | undefined][];
  recorded: unknown[][];
  resets: unknown[][];
  distilled: BotSession[];
  logs: unknown[][];
  timers: { fn: () => void; ms: number; handle: number; cleared: boolean }[];
}

function setup(opts: {
  results: ClaudeResult[];
  sessionMode?: boolean;
  resumeSession?: Partial<BotSession>;
  expiredSession?: Partial<BotSession>;
  /** Standard: Text ohne Herkunft (source "none"), damit der Text unverändert bleibt */
  fallback?: () => Promise<FallbackResult>;
  /** Uhr in Millisekunden; jeder Aufruf von now() liefert den nächsten Wert, der letzte bleibt */
  clock?: number[];
  /** Stattdessen eine Uhr, die der Test selbst weiterstellt */
  now?: () => number;
  /** Wird waehrend des Claude-Aufrufs ausgefuehrt (z. B. Callbacks feuern). */
  duringCall?: (o: ClaudeStreamOptions, r: Recorder) => void | Promise<void>;
}) {
  const r: Recorder = {
    events: [],
    claudeCalls: [],
    fallbackCalls: [],
    recorded: [],
    resets: [],
    distilled: [],
    logs: [],
    timers: [],
  };
  const results = [...opts.results];
  const fakeCall = async (o: ClaudeStreamOptions): Promise<ClaudeResult> => {
    r.claudeCalls.push(o);
    r.events.push("claude");
    await opts.duringCall?.(o, r);
    const next = results.shift();
    if (!next) throw new Error("unerwarteter Claude-Aufruf");
    return next;
  };

  const deps: Partial<ChatTurnDeps> = {
    callClaude: fakeCall,
    callClaudeStreaming: fakeCall,
    callFallbackLLMWithSource: async (msg, ctx) => {
      r.fallbackCalls.push([msg, ctx]);
      r.events.push("fallback");
      return opts.fallback ? opts.fallback() : { text: "fallback-antwort", source: "none" };
    },
    buildPromptContext: async () => ({
      fullPrompt: "voller-prompt",
      fallbackContext: "fallback-kontext",
    }),
    buildResumePrompt: async () => "resume-prompt",
    isSessionModeEnabled: () => opts.sessionMode ?? true,
    getResumableSession: async () =>
      opts.resumeSession
        ? ({ startedAt: 1, messageCount: 1, ...opts.resumeSession } as BotSession)
        : undefined,
    takeExpiredSession: async () =>
      opts.expiredSession ? (opts.expiredSession as BotSession) : undefined,
    recordSessionTurn: async (...args) => {
      r.recorded.push(args);
      r.events.push("record");
    },
    resetSession: async (...args) => {
      r.resets.push(args);
      r.events.push("reset");
      return 1;
    },
    shouldDistill: () => true,
    distillSession: async (s) => {
      r.distilled.push(s);
    },
    log: async (...args) => {
      r.logs.push(args);
    },
    getAgentConfig: () =>
      ({ model: MODEL, effort: "high", allowedTools: ["WebSearch"] }) as ReturnType<
        ChatTurnDeps["getAgentConfig"]
      >,
    // Keine Einstellungsdatei: Modell und Effort kommen aus der Agenten-Konfiguration
    getSettings: () => ({}),
    setTimer: (fn, ms) => {
      const handle = r.timers.length + 1;
      r.timers.push({ fn, ms, handle, cleared: false });
      return handle;
    },
    clearTimer: (handle) => {
      const t = r.timers.find((x) => x.handle === handle);
      if (t) t.cleared = true;
    },
    now: opts.now ?? (() => (clock.length > 1 ? clock.shift()! : clock[0]!)),
  };
  const clock = [...(opts.clock ?? [0])];

  const progress: TurnProgress[] = [];
  const notices: string[] = [];
  const sink: TurnSink = {
    progress: (p) => {
      progress.push(p);
      r.events.push(`progress:${p.kind}`);
    },
    notice: (text) => {
      notices.push(text);
      r.events.push("notice");
    },
    start: () => {
      r.events.push("start");
    },
    finish: () => {
      r.events.push("finish");
    },
  };
  const sessionIds: string[] = [];
  const onSessionId = async (id: string) => {
    sessionIds.push(id);
    r.events.push("sessionId");
  };
  const infos: TurnInfo[] = [];
  const onInfo = (info: TurnInfo) => {
    infos.push(info);
    r.events.push("info");
  };

  return { r, deps, sink, progress, notices, sessionIds, onSessionId, infos, onInfo };
}

function turnOpts(s: ReturnType<typeof setup>, userMessage = "Frage?") {
  return {
    userMessage,
    chatId: CHAT,
    agentName: AGENT,
    sink: s.sink,
    onSessionId: s.onSessionId,
    onInfo: s.onInfo,
    deps: s.deps,
  };
}

const ok = (text: string, sessionId = "sid-1"): ClaudeResult => ({ text, sessionId, isError: false });
const fail = (sessionId?: string): ClaudeResult => ({ text: "", sessionId, isError: true });

describe("runStreamingTurn", () => {
  test("Erfolg: Antwort zurueck, Session gespeichert, onSessionId aufgerufen", async () => {
    const s = setup({ results: [ok("Antwort", "sid-neu")] });
    const reply = await runStreamingTurn(turnOpts(s));

    expect(reply).toBe("Antwort");
    expect(s.r.recorded).toHaveLength(1);
    expect(s.r.recorded[0]!.slice(0, 4)).toEqual([KEY, AGENT, MODEL, "sid-neu"]);
    expect(typeof s.r.recorded[0]![4]).toBe("number"); // memoryWatermark
    expect(s.sessionIds).toEqual(["sid-neu"]);
    expect(s.r.fallbackCalls).toHaveLength(0);
    expect(s.r.events).toEqual(["start", "claude", "record", "sessionId", "finish", "info"]);

    // Aufrufoptionen wie bisher: Modell, Effort, Werkzeuge, Zeitlimit, abortKey
    const call = s.r.claudeCalls[0]!;
    expect(call.prompt).toBe("voller-prompt");
    expect(call.resumeSessionId).toBeUndefined();
    expect(call.model).toBe(MODEL);
    expect(call.effort).toBe("high");
    expect(call.allowedTools).toEqual(["WebSearch"]);
    expect(call.timeoutMs).toBe(CLAUDE_CALL_TIMEOUT_MS);
    expect(call.abortKey).toBe(KEY);
    expect(call.outputFormat).toBeUndefined();
  });

  test("Ohne Session-Modus: kein recordSessionTurn, onSessionId trotzdem", async () => {
    const s = setup({ results: [ok("Antwort", "sid-x")], sessionMode: false });
    expect(await runStreamingTurn(turnOpts(s))).toBe("Antwort");
    expect(s.r.recorded).toHaveLength(0);
    expect(s.sessionIds).toEqual(["sid-x"]);
  });

  test("Werkzeug-Start und erstes Snippet kommen als progress im Sink an", async () => {
    const s = setup({
      results: [ok("Antwort")],
      duringCall: (o) => {
        o.onToolStart?.("Web Search");
        o.onFirstText?.("zu kurz");
        o.onFirstText?.("**Ich** suche `zuerst` nach <aktuellen> Quellen_und " + "x".repeat(200));
      },
    });
    await runStreamingTurn(turnOpts(s));

    expect(s.progress).toHaveLength(2);
    expect(s.progress[0]).toEqual({ kind: "tool", text: "Web Search" });
    expect(s.progress[1]!.kind).toBe("snippet");
    const snippet = s.progress[1]!.text;
    expect(snippet.startsWith("Ich suche zuerst nach aktuellen Quellenund")).toBe(true);
    expect(snippet).not.toMatch(/[_*`<>]/);
    expect(snippet.length).toBe(120);
    expect(s.r.events.indexOf("progress:snippet")).toBeLessThan(s.r.events.indexOf("finish"));
  });

  test("Ausstehender asynchroner Fortschritt ist vor finish abgearbeitet", async () => {
    const s = setup({
      results: [ok("Antwort")],
      duringCall: (o) => o.onToolStart?.("Bash"),
    });
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const order: string[] = [];
    s.sink.progress = async () => {
      await gate;
      order.push("progress-fertig");
    };
    s.sink.finish = () => {
      order.push("finish");
    };
    setTimeout(() => release(), 5);
    await runStreamingTurn(turnOpts(s));
    expect(order).toEqual(["progress-fertig", "finish"]);
  });

  test("Fehler im Sink brechen den Turn nicht ab", async () => {
    const s = setup({
      results: [{ text: "", isError: true, timedOut: true }],
      duringCall: (o) => o.onToolStart?.("Bash"),
    });
    s.sink.progress = () => {
      throw new Error("Telegram weg");
    };
    s.sink.notice = async () => {
      throw new Error("Telegram weg");
    };
    s.sink.start = async () => {
      throw new Error("Telegram weg");
    };
    s.sink.finish = async () => {
      throw new Error("Telegram weg");
    };
    expect(await runStreamingTurn(turnOpts(s))).toBe("fallback-antwort");
  });

  test("Abbruch: ABORT_REPLY, kein Fallback, keine Session", async () => {
    const s = setup({ results: [{ text: "", isError: false, aborted: true, sessionId: "sid" }] });
    expect(await runStreamingTurn(turnOpts(s))).toBe(ABORT_REPLY);
    expect(s.r.fallbackCalls).toHaveLength(0);
    expect(s.r.recorded).toHaveLength(0);
    expect(s.sessionIds).toHaveLength(0);
    expect(s.r.events).toEqual(["start", "claude", "finish"]);
  });

  test("Fehler ohne Resume: Fallback mit Nachricht und fallbackContext", async () => {
    const s = setup({ results: [fail("sid-fehler")] });
    const reply = await runStreamingTurn(turnOpts(s, "Wie wird das Wetter?"));

    expect(reply).toBe("fallback-antwort");
    expect(s.r.fallbackCalls).toEqual([["Wie wird das Wetter?", "fallback-kontext"]]);
    expect(s.r.claudeCalls).toHaveLength(1);
    expect(s.r.resets).toHaveLength(0);
    expect(s.r.recorded).toHaveLength(0); // Fehler: kein recordSessionTurn
    expect(s.sessionIds).toEqual(["sid-fehler"]); // aber onSessionId wie bisher
    expect(s.notices).toHaveLength(0); // kein Zeitlimit, kein Hinweis
    expect(s.r.logs[0]!.slice(0, 3)).toEqual([
      "warn",
      "bot",
      "Claude streaming failed, using fallback LLM",
    ]);
    // Fortschritt ist weg, bevor der Fallback laeuft
    expect(s.r.events.indexOf("finish")).toBeLessThan(s.r.events.indexOf("fallback"));
  });

  test("Resume schlaegt fehl: Session zurueckgesetzt, zweiter Aufruf ohne Resume", async () => {
    const s = setup({
      resumeSession: { claudeSessionId: "sid-alt" },
      results: [fail(), ok("frische Antwort", "sid-frisch")],
    });
    const reply = await runStreamingTurn(turnOpts(s));

    expect(reply).toBe("frische Antwort");
    expect(s.r.claudeCalls).toHaveLength(2);
    expect(s.r.claudeCalls[0]!.resumeSessionId).toBe("sid-alt");
    expect(s.r.claudeCalls[0]!.prompt).toBe("resume-prompt");
    expect(s.r.claudeCalls[1]!.resumeSessionId).toBeUndefined();
    expect(s.r.claudeCalls[1]!.prompt).toBe("voller-prompt");
    expect(s.r.resets).toEqual([[KEY, AGENT]]);
    expect(s.r.events.indexOf("reset")).toBeLessThan(s.r.events.lastIndexOf("claude"));
    expect(s.r.fallbackCalls).toHaveLength(0);
    expect(s.sessionIds).toEqual(["sid-frisch"]);
  });

  test("Resume schlaegt fehl, zweiter Versuch abgebrochen: ABORT_REPLY, kein Fallback", async () => {
    const s = setup({
      resumeSession: { claudeSessionId: "sid-alt" },
      results: [fail(), { text: "", isError: false, aborted: true }],
    });
    expect(await runStreamingTurn(turnOpts(s))).toBe(ABORT_REPLY);
    expect(s.r.claudeCalls).toHaveLength(2);
    expect(s.r.fallbackCalls).toHaveLength(0);
    expect(s.r.events.at(-1)).toBe("finish");
  });

  test("Resume schlaegt fehl, auch frisch Fehler: Fallback mit frischem fallbackContext", async () => {
    const s = setup({
      resumeSession: { claudeSessionId: "sid-alt" },
      results: [fail(), fail()],
    });
    expect(await runStreamingTurn(turnOpts(s, "Hallo"))).toBe("fallback-antwort");
    expect(s.r.fallbackCalls).toEqual([["Hallo", "fallback-kontext"]]);
  });

  test("Zeitlimit mit Resume-Session: Hinweis, kein zweiter Aufruf, Fallback ohne Kontext", async () => {
    const s = setup({
      resumeSession: { claudeSessionId: "sid-alt" },
      results: [{ text: "", isError: true, timedOut: true }],
    });
    const reply = await runStreamingTurn(turnOpts(s, "Langer Bericht"));

    expect(reply).toBe("fallback-antwort");
    expect(s.r.claudeCalls).toHaveLength(1);
    expect(s.r.resets).toHaveLength(0);
    expect(s.notices).toEqual([TIMEOUT_NOTICE_TEXT]);
    // Unveraendert: ohne frischen Prompt bleibt der Fallback-Kontext leer
    expect(s.r.fallbackCalls).toEqual([["Langer Bericht", ""]]);
    // Reihenfolge: Fortschritt weg, dann Hinweis, dann Fallback
    const e = s.r.events;
    expect(e.indexOf("finish")).toBeLessThan(e.indexOf("notice"));
    expect(e.indexOf("notice")).toBeLessThan(e.indexOf("fallback"));
  });

  test("Hinweis nach 20 Minuten und Timer wird nach jedem Aufruf aufgeraeumt", async () => {
    const s = setup({
      resumeSession: { claudeSessionId: "sid-alt" },
      results: [fail(), ok("Antwort")],
      duringCall: (_o, r) => {
        // Waehrend des ersten Aufrufs laufen 20 Minuten ab
        if (r.claudeCalls.length === 1) r.timers.at(-1)!.fn();
      },
    });
    await runStreamingTurn(turnOpts(s));

    expect(s.r.timers).toHaveLength(2); // pro Aufruf ein Timer
    for (const t of s.r.timers) {
      expect(t.ms).toBe(LONG_RUN_NOTICE_MS);
      expect(t.cleared).toBe(true);
    }
    expect(s.notices).toEqual([LONG_RUN_NOTICE_TEXT]);
  });

  test("Timer wird auch aufgeraeumt, wenn der Claude-Aufruf wirft", async () => {
    const s = setup({ results: [] });
    await expect(runStreamingTurn(turnOpts(s))).rejects.toThrow("unerwarteter Claude-Aufruf");
    expect(s.r.timers).toHaveLength(1);
    expect(s.r.timers[0]!.cleared).toBe(true);
  });

  test("Fallback scheitert: feste Entschuldigung", async () => {
    const s = setup({
      results: [fail()],
      fallback: async () => {
        throw new Error("alles weg");
      },
    });
    expect(await runStreamingTurn(turnOpts(s))).toBe(FALLBACK_FAILED_REPLY);
  });

  test("Abgelaufene Session wird vor frischem Start destilliert", async () => {
    const expired = { claudeSessionId: "sid-abgelaufen", messageCount: 9 };
    const s = setup({ results: [ok("Antwort")], expiredSession: expired });
    await runStreamingTurn(turnOpts(s));
    expect(s.r.distilled).toEqual([expired as BotSession]);
  });
});

describe("runJsonTurn", () => {
  test("Erfolg: JSON-Aufruf ohne Fortschritts-Callbacks", async () => {
    const s = setup({ results: [ok("kurze Antwort", "sid-j")] });
    const reply = await runJsonTurn(turnOpts(s));

    expect(reply).toBe("kurze Antwort");
    const call = s.r.claudeCalls[0]!;
    expect(call.outputFormat).toBe("json");
    expect(call.onToolStart).toBeUndefined();
    expect(call.onFirstText).toBeUndefined();
    expect(call.abortKey).toBe(KEY);
    expect(s.r.recorded).toHaveLength(1);
    expect(s.sessionIds).toEqual(["sid-j"]);
  });

  test("Abbruch: ABORT_REPLY, kein Fallback, kein Retry trotz Resume", async () => {
    const s = setup({
      resumeSession: { claudeSessionId: "sid-alt" },
      results: [{ text: "", isError: false, aborted: true }],
    });
    expect(await runJsonTurn(turnOpts(s))).toBe(ABORT_REPLY);
    expect(s.r.claudeCalls).toHaveLength(1);
    expect(s.r.fallbackCalls).toHaveLength(0);
    expect(s.r.resets).toHaveLength(0);
  });

  test("Fehler ohne Resume: Fallback mit fallbackContext", async () => {
    const s = setup({ results: [fail()] });
    expect(await runJsonTurn(turnOpts(s, "Hi"))).toBe("fallback-antwort");
    expect(s.r.fallbackCalls).toEqual([["Hi", "fallback-kontext"]]);
    expect(s.r.logs[0]!.slice(0, 3)).toEqual(["warn", "bot", "Claude failed, using fallback LLM"]);
  });

  test("Resume schlaegt fehl: Reset und zweiter Aufruf ohne Resume", async () => {
    const s = setup({
      resumeSession: { claudeSessionId: "sid-alt" },
      results: [fail(), ok("frisch")],
    });
    expect(await runJsonTurn(turnOpts(s))).toBe("frisch");
    expect(s.r.claudeCalls.map((c) => c.resumeSessionId)).toEqual(["sid-alt", undefined]);
    expect(s.r.claudeCalls[1]!.outputFormat).toBe("json");
    expect(s.r.resets).toEqual([[KEY, AGENT]]);
  });

  test("Resume schlaegt fehl, zweiter Versuch abgebrochen: ABORT_REPLY", async () => {
    const s = setup({
      resumeSession: { claudeSessionId: "sid-alt" },
      results: [fail(), { text: "", isError: false, aborted: true }],
    });
    expect(await runJsonTurn(turnOpts(s))).toBe(ABORT_REPLY);
    expect(s.r.fallbackCalls).toHaveLength(0);
  });

  test("Zeitlimit mit Resume-Session: Hinweis, kein zweiter Aufruf", async () => {
    const s = setup({
      resumeSession: { claudeSessionId: "sid-alt" },
      results: [{ text: "", isError: true, timedOut: true }],
    });
    expect(await runJsonTurn(turnOpts(s, "Bericht"))).toBe("fallback-antwort");
    expect(s.r.claudeCalls).toHaveLength(1);
    expect(s.notices).toEqual([TIMEOUT_NOTICE_TEXT]);
    expect(s.r.fallbackCalls).toEqual([["Bericht", ""]]);
  });

  test("Hinweis nach 20 Minuten, Timer aufgeraeumt", async () => {
    const s = setup({
      results: [ok("Antwort")],
      duringCall: (_o, r) => r.timers.at(-1)!.fn(),
    });
    await runJsonTurn(turnOpts(s));
    expect(s.notices).toEqual([LONG_RUN_NOTICE_TEXT]);
    expect(s.r.timers).toHaveLength(1);
    expect(s.r.timers[0]!.ms).toBe(LONG_RUN_NOTICE_MS);
    expect(s.r.timers[0]!.cleared).toBe(true);
  });
});

test("Hinweistexte unveraendert", () => {
  expect(ABORT_REPLY).toBe("⏹️ Abgebrochen.");
  expect(LONG_RUN_NOTICE_TEXT).toBe(
    "⏳ Läuft seit 20 Minuten. Bei 30 Minuten bricht der Bot den Lauf ab und holt eine kürzere Fallback-Antwort. /stop bricht sofort ab."
  );
  expect(TIMEOUT_NOTICE_TEXT).toBe(
    "⏱ Zeitlimit: Claude wurde nach 30 Minuten abgebrochen, der Zwischenstand ist verloren. Ich hole jetzt eine kürzere Antwort über den Fallback, das kann noch ein paar Minuten dauern."
  );
});

describe("Agent, Modell und Dauer (Issue #22)", () => {
  test("Erfolg: Agent, Modell des Agenten und Dauer ab Turn-Beginn", async () => {
    const s = setup({ results: [ok("Antwort")], clock: [1_000, 43_250] });
    expect(await runStreamingTurn(turnOpts(s))).toBe("Antwort");
    expect(s.infos).toEqual([{ agent: AGENT, model: MODEL, durationMs: 42_250 }]);
    // gemeldet, nachdem der Fortschritt beendet ist
    expect(s.r.events.at(-1)).toBe("info");
  });

  test("JSON-Turn meldet ebenso", async () => {
    const s = setup({ results: [ok("kurz")], clock: [0, 1_500] });
    await runJsonTurn(turnOpts(s));
    expect(s.infos).toEqual([{ agent: AGENT, model: MODEL, durationMs: 1_500 }]);
  });

  test("Fallback: Modell ist das Fallback-Modell, Dauer schließt den Fallback ein", async () => {
    let time = 0;
    const s = setup({
      results: [fail()],
      now: () => time,
      duringCall: () => {
        time = 5_000; // Claude scheitert nach 5 s
      },
      fallback: async () => {
        time = 9_000; // der Fallback braucht weitere 4 s
        return { text: "Ersatz", source: "openrouter", model: "minimax/minimax-m2.7" };
      },
    });
    const reply = await runStreamingTurn(turnOpts(s));
    // Der sichtbare Zusatz bleibt wie bisher
    expect(reply).toBe("Ersatz\n\n_(responded via openrouter)_");
    expect(s.infos).toHaveLength(1);
    expect(s.infos[0]!.model).toBe("minimax/minimax-m2.7");
    expect(s.infos[0]!.model).not.toBe(MODEL);
    expect(s.infos[0]!.durationMs).toBe(9_000);
    expect(s.r.events.indexOf("fallback")).toBeLessThan(s.r.events.indexOf("info"));
  });

  test("Fallback ohne Modell-ID: Name der Quelle, nie das Agenten-Modell", async () => {
    const s = setup({ results: [fail()], fallback: async () => ({ text: "Ersatz", source: "ollama" }) });
    await runStreamingTurn(turnOpts(s));
    expect(s.infos[0]!.model).toBe("ollama");
  });

  test("Resume-Retry: Dauer über beide Aufrufe, Modell des Agenten", async () => {
    const s = setup({
      resumeSession: { claudeSessionId: "sid-alt" },
      results: [fail(), ok("frisch")],
      clock: [100, 60_100],
    });
    await runStreamingTurn(turnOpts(s));
    expect(s.infos).toEqual([{ agent: AGENT, model: MODEL, durationMs: 60_000 }]);
  });

  test("Alle Fallbacks gescheitert: kein erfundenes Modell", async () => {
    const none = setup({ results: [fail()], clock: [0, 2_000] });
    await runStreamingTurn(turnOpts(none));
    expect(none.infos).toEqual([{ agent: AGENT, durationMs: 2_000 }]);

    const thrown = setup({
      results: [fail()],
      fallback: async () => {
        throw new Error("alles weg");
      },
    });
    expect(await runStreamingTurn(turnOpts(thrown))).toBe(FALLBACK_FAILED_REPLY);
    expect(thrown.infos).toHaveLength(1);
    expect("model" in thrown.infos[0]!).toBe(false);
  });

  test("Abbruch: keine Meldung", async () => {
    const s = setup({ results: [{ text: "", isError: false, aborted: true }] });
    expect(await runStreamingTurn(turnOpts(s))).toBe(ABORT_REPLY);
    expect(s.infos).toHaveLength(0);
  });

  test("Fehler in onInfo stört den Turn nicht", async () => {
    const s = setup({ results: [ok("Antwort")] });
    const reply = await runStreamingTurn({
      ...turnOpts(s),
      onInfo: () => {
        throw new Error("kaputt");
      },
    });
    expect(reply).toBe("Antwort");
  });
});
