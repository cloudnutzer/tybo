/**
 * Motor-Vertrag für den Motor "api" (Issue #347, Grundlauf). Der Abruf bei
 * Anthropic ist eine Attrappe (setApiRuntimeForTests), kein Netz, kein
 * echter Schlüssel. Die Timer sind echt, die Zeitgrenzen kurz.
 *
 * Hier gelten die Zusagen des Grundlaufs: Antwort in beiden Modi, Fehler,
 * Abbruch über abortEngineCalls (auch beim Verbindungsaufbau und beim
 * wartenden Lesen), Zeitlimits, Kosten. Seit Issue #348 mit Session-ID und
 * Fortsetzen; Werkzeugschleife, Sitzungen und Rückfragen im Einzelnen in
 * tests/engine-api-*.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CLAUDE_MODEL } from "../src/lib/default-model";
import { setApiRuntimeForTests, API_KEY_MISSING, API_MAX_TOKENS } from "../src/lib/engines/api";
import { abortEngineCalls, activeEngineCallCount, createApiEngine, getEngine, registeredEngineIds, type EngineRequest } from "../src/lib/engines";
import { runCancelable, abortExecutions } from "../src/lib/execution-context";
import { sse, textReply, until, installApiFake, type ApiFake } from "./api-fixture";

const SHORT_MS = 40;
const LONG_MS = 60_000;

let fake: ApiFake;
beforeEach(() => {
  fake = installApiFake();
});
afterEach(() => fake.restore());

const request = (streaming: boolean, extra: Partial<EngineRequest> = {}): EngineRequest => ({
  prompt: "Hallo",
  streaming,
  timeoutMs: LONG_MS,
  cwd: process.cwd(),
  ...extra,
});

describe("Motor-Vertrag: api (Grundlauf)", () => {
  test("registriert, describe liefert einen Anzeigenamen, id stimmt", () => {
    expect(registeredEngineIds()).toContain("api");
    const engine = getEngine("api");
    expect(engine.id).toBe("api");
    expect(engine.describe()).toBe("Anthropic API");
  });

  for (const [label, streaming] of [
    ["JSON", false],
    ["Streaming", true],
  ] as const) {
    describe(label, () => {
      test("Antwort mit Session-ID, Werkzeuge bekannt leer, Zählung zurück auf 0", async () => {
        fake.respond(textReply("Hallo zurück"));
        const r = await createApiEngine().run(request(streaming));
        expect(r).toMatchObject({ engine: "api", text: "Hallo zurück", isError: false });
        // Fortsetzbar (Issue #348): eine UUID, die Sitzung liegt im Ordner der Attrappe
        expect(r.sessionId).toMatch(/^[0-9a-f-]{36}$/);
        expect(r.tools).toEqual({ uses: [], cwd: process.cwd() });
        expect(r.aborted).toBeFalsy();
        expect(r.timedOut).toBeFalsy();
        expect(activeEngineCallCount()).toBe(0);
      });

      test("Fortsetzen: gespeicherter Verlauf plus neue Nachricht, dieselbe Session-ID", async () => {
        fake.respond(textReply("erste Antwort"));
        const first = await createApiEngine().run(request(streaming, { prompt: "Erste Frage" }));
        fake.respond(textReply("zweite Antwort"));
        const second = await createApiEngine().run(request(streaming, { prompt: "Zweite Frage", resumeSessionId: first.sessionId }));
        expect(second).toMatchObject({ isError: false, text: "zweite Antwort", sessionId: first.sessionId });
        expect(fake.lastBody().messages).toEqual([
          { role: "user", content: "Erste Frage" },
          { role: "assistant", content: [{ type: "text", text: "erste Antwort" }] },
          { role: "user", content: "Zweite Frage" },
        ]);
        // Die Kennung selbst geht nie an die API
        expect(JSON.stringify(fake.lastBody())).not.toContain(first.sessionId!);
      });

      test("HTTP-Fehler: isError mit Art, Kosten 0, weder Abbruch noch Zeitlimit", async () => {
        fake.respondStatus(529, JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
        const r = await createApiEngine().run(request(streaming));
        expect(r).toMatchObject({ engine: "api", isError: true, errorKind: "capacity", costUsd: 0 });
        expect(r.text).toContain("Overloaded");
        expect(r.aborted).toBeFalsy();
        expect(r.timedOut).toBeFalsy();
        expect(activeEngineCallCount()).toBe(0);
      });

      test("Fehler-Ereignis im Strom: isError, Kosten unbekannt", async () => {
        fake.respond(
          sse({ type: "message_start", message: { usage: { input_tokens: 10 } } }) +
            sse({ type: "error", error: { type: "rate_limit_error", message: "zu viele" } })
        );
        const r = await createApiEngine().run(request(streaming));
        expect(r).toMatchObject({ engine: "api", isError: true, errorKind: "rate_limit" });
        expect(r.costUsd).toBeUndefined();
      });

      test("vorzeitiges Streamende ohne message_stop: Fehler, kein halber Text als Antwort", async () => {
        fake.respond(textReply("Halber Sat").replace(/event: message_stop[\s\S]*$/, ""));
        const r = await createApiEngine().run(request(streaming));
        expect(r).toMatchObject({ engine: "api", isError: true, errorKind: "other" });
        expect(r.text).toContain("vorzeitig");
      });

      test("Netzfehler: isError, errorKind other", async () => {
        fake.respondError(new TypeError("fetch failed"));
        const r = await createApiEngine().run(request(streaming));
        expect(r).toMatchObject({ engine: "api", isError: true, errorKind: "other" });
        expect(r.text).toContain("fetch failed");
      });

      test("/stop beim wartenden Lesen: aborted, Abruf beendet, Register leer", async () => {
        fake.hangAfter(sse({ type: "message_start", message: { usage: { input_tokens: 5 } } }));
        const running = createApiEngine().run(request(streaming, { abortKey: "contract:api" }));
        await until(() => activeEngineCallCount() === 1 && fake.reading());
        expect(abortEngineCalls("contract:api")).toBe(1);
        const r = await running;
        expect(r).toMatchObject({ engine: "api", aborted: true, isError: true });
        expect(r.timedOut).toBeFalsy();
        expect(fake.aborts()).toBe(1);
        expect(activeEngineCallCount()).toBe(0);
      });

      test("/stop beim Verbindungsaufbau: aborted, Abruf beendet", async () => {
        fake.hangConnect();
        const running = createApiEngine().run(request(streaming, { abortKey: "contract:api" }));
        await until(() => activeEngineCallCount() === 1 && fake.connecting());
        expect(abortEngineCalls("contract:api")).toBe(1);
        const r = await running;
        expect(r).toMatchObject({ aborted: true, isError: true });
        expect(fake.aborts()).toBe(1);
        expect(activeEngineCallCount()).toBe(0);
      });

      test("Zeitlimit: timedOut, kein Abbruch, Abruf beendet", async () => {
        fake.hangAfter(sse({ type: "message_start", message: {} }));
        const r = await createApiEngine().run(request(streaming, { timeoutMs: SHORT_MS }));
        expect(r).toMatchObject({ engine: "api", timedOut: true, isError: true });
        expect(r.aborted).toBeFalsy();
        expect(r.sessionId).toBeUndefined();
        expect(fake.aborts()).toBe(1);
        expect(activeEngineCallCount()).toBe(0);
        if (streaming) expect(r.timeoutKind).toBe("total");
      });
    });
  }

  test("Streaming: Leerlauf-Grenze greift mit timeoutKind idle, Lebenszeichen setzen sie zurück", async () => {
    fake.hangAfter(sse({ type: "message_start", message: {} }));
    const r = await createApiEngine().run(request(true, { idleTimeoutMs: SHORT_MS }));
    expect(r).toMatchObject({ timedOut: true, timeoutKind: "idle", isError: true });
    expect(r.idleForMs).toBeGreaterThanOrEqual(SHORT_MS - 5);
    expect(fake.aborts()).toBe(1);
  });

  test("JSON-Modus kennt keine Leerlauf-Grenze", async () => {
    fake.respondSlow(textReply("spät, aber da"), SHORT_MS * 2);
    const r = await createApiEngine().run(request(false, { idleTimeoutMs: SHORT_MS }));
    expect(r).toMatchObject({ isError: false, text: "spät, aber da" });
  });

  test("Streaming: erster Textblock geht an onFirstText, Text am Stück im Ergebnis", async () => {
    const long = "Ich suche jetzt nach aktuellen Quellen zu diesem Thema. Danach fasse ich zusammen.";
    fake.respond(textReply(long, ["Zweiter Block."]));
    const texts: [string, string][] = [];
    const tools: string[] = [];
    const r = await createApiEngine().run(
      request(true, { onFirstText: (s, f) => texts.push([s, f]), onToolStart: (n) => tools.push(n) })
    );
    expect(texts).toHaveLength(1);
    expect(texts[0]![0]).toBe("Ich suche jetzt nach aktuellen Quellen zu diesem Thema.");
    expect(texts[0]![1]).toBe(long);
    expect(tools).toEqual([]);
    expect(r.text).toBe(long + "Zweiter Block.");
  });

  test("JSON-Modus: keine Rückrufe", async () => {
    fake.respond(textReply("Ein ausreichend langer erster Textblock für einen Rückruf."));
    const texts: string[] = [];
    await createApiEngine().run(request(false, { onFirstText: (s) => texts.push(s) }));
    expect(texts).toEqual([]);
  });

  test("Ohne Schlüssel: errorKind auth, kein Abruf", async () => {
    fake.setKey(undefined);
    const r = await createApiEngine().run(request(true));
    expect(r).toMatchObject({ engine: "api", isError: true, errorKind: "auth", text: API_KEY_MISSING });
    expect(fake.calls()).toBe(0);
  });

  test("Abbruch der Ausführung (execution-context) beendet den Abruf", async () => {
    fake.hangAfter(sse({ type: "message_start", message: {} }));
    const running = runCancelable("exec:api", () => createApiEngine().run(request(true)));
    await until(() => fake.reading());
    abortExecutions("exec:api");
    const r = await running.catch((e) => ({ thrown: e }));
    expect(r).toMatchObject({ aborted: true });
    expect(fake.aborts()).toBe(1);
    expect(activeEngineCallCount()).toBe(0);
  });
});

describe("Anfrage und Kosten", () => {
  test("Rumpf: Schlüssel im Kopf, voller Prompt als Nutzer-Turn, Modell und Effort, eigene Werkzeuge, Strom", async () => {
    fake.respond(textReply("ok"));
    // Wie ein Turn mit Rückfragen-Register (Chat-Kern mit onQuestion)
    await createApiEngine().run(request(false, { prompt: "Voller Prompt", model: "claude-sonnet-5-5", effort: "high", questions: true }));
    expect(fake.lastUrl()).toBe("https://api.anthropic.com/v1/messages");
    expect(fake.lastHeaders()["x-api-key"]).toBe("sk-test-attrappe");
    const { tools, ...rest } = fake.lastBody();
    expect(rest).toEqual({
      model: "claude-sonnet-5-5",
      max_tokens: API_MAX_TOKENS,
      messages: [{ role: "user", content: "Voller Prompt" }],
      output_config: { effort: "high" },
      stream: true,
    });
    // Ohne mcpManager nur die vier eigenen Werkzeuge (Issue #348)
    expect(tools.map((t: { name: string }) => t.name)).toEqual(["schedule_task", "list_scheduled_tasks", "cancel_scheduled_task", "ask_user"]);
    // Ohne Rückfragen-Register (keine Freigabe questions) kein ask_user
    fake.respond(textReply("ok"));
    await createApiEngine().run(request(false, { prompt: "Voller Prompt" }));
    expect(fake.lastBody().tools.map((t: { name: string }) => t.name)).toEqual(["schedule_task", "list_scheduled_tasks", "cancel_scheduled_task"]);
  });

  test("Kurzform oder [1m] der CLI wird zum Standardmodell, unbekannter Effort fehlt", async () => {
    fake.respond(textReply("ok"));
    await createApiEngine().run(request(false, { model: "opus", effort: "turbo" }));
    expect(fake.lastBody()).toMatchObject({ model: DEFAULT_CLAUDE_MODEL });
    expect(fake.lastBody()).not.toHaveProperty("output_config");
    fake.respond(textReply("ok"));
    await createApiEngine().run(request(false, { model: "claude-opus-5-5[1m]" }));
    expect(fake.lastBody()).toMatchObject({ model: DEFAULT_CLAUDE_MODEL });
  });

  test("Kosten aus usage samt Cache-Tokens, Verbrauch im Ergebnis", async () => {
    fake.respond(
      textReply("ok", [], {
        start: { input_tokens: 1000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2000, output_tokens: 1 },
        end: { output_tokens: 200 },
      })
    );
    const r = await createApiEngine().run(request(false, { model: "claude-opus-5-5" }));
    // 1000*4 + 200*20 + 10000*0.4 + 2000*5 = 22000 / 1e6
    expect(r.costUsd).toBeCloseTo(0.022, 10);
    expect(r.usage).toEqual({ inputTokens: 13_000, cachedInputTokens: 10_000, outputTokens: 200 });
  });

  test("Unbekanntes Modell: Kosten unbekannt statt 0, Verbrauch bleibt", async () => {
    fake.respond(textReply("ok", [], { start: { input_tokens: 10 }, end: { output_tokens: 3 } }));
    const r = await createApiEngine().run(request(false, { model: "claude-neu-9" }));
    expect(r.costUsd).toBeUndefined();
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
  });

  test("Streamende nach vorläufiger usage und Textdeltas: Kosten unbekannt, Verbrauch bleibt", async () => {
    fake.respond(
      sse({ type: "message_start", message: { usage: { input_tokens: 1000, output_tokens: 1 } } }) +
        sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Halber " } }) +
        sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Sat" } })
    );
    const r = await createApiEngine().run(request(false, { model: "claude-opus-5-5" }));
    expect(r).toMatchObject({ engine: "api", isError: true, errorKind: "other" });
    expect(r.text).toContain("vorzeitig");
    expect(r.costUsd).toBeUndefined();
    expect(r.usage).toEqual({ inputTokens: 1000, outputTokens: 1 });
  });

  test("Ohne usage-Meldung: weder Kosten noch Verbrauch", async () => {
    fake.respond(textReply("ok"));
    const r = await createApiEngine().run(request(false));
    expect(r.costUsd).toBeUndefined();
    expect(r.usage).toBeUndefined();
  });

  test("401: errorKind auth (Chat-Kern wechselt auf Claude Code), Fehlertext ohne Schlüssel", async () => {
    fake.respondStatus(401, JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
    const r = await createApiEngine().run(request(false));
    expect(r).toMatchObject({ isError: true, errorKind: "auth" });
    expect(r.text).not.toContain("sk-test-attrappe");
  });
});
