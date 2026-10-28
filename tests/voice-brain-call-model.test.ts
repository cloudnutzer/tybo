/**
 * Issue #256: Modellwahl des Telefonhörers (resolveCallModel), Einstellungen
 * speech.call, kein Ausweichen nach zwei Fehlern, Probe. Alle Prüfungen von
 * Claude Code, Ollama und Netz sind Attrappen.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  CALL_DEFAULT_CLAUDE,
  CALL_DEFAULT_OPENROUTER,
  createCallBackend,
  probeCallModel,
  resolveCallModel,
  type CallModelDeps,
  type CallModelResolution,
} from "../src/lib/voice-brain/call-model";
import { streamAnthropic } from "../src/lib/voice-brain/backends/anthropic";
import { runVoiceTurn, type VoiceTurnEvent } from "../src/lib/voice-brain/turn";
import { BrainError, type BrainBackend } from "../src/lib/voice-brain/types";
import { settingsSchema, type Settings } from "../src/lib/settings";
import { applySettingsPatch } from "../src/web/settings";
import { CALL_MEASUREMENT } from "../src/lib/voice-brain/expectations";
import type { EngineStatus } from "../src/lib/engines/check";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const CLAUDE_OK: EngineStatus = { engine: "claude", checked: true, installed: true, loggedIn: true, version: "2.1.286" };
const CLAUDE_MISSING: EngineStatus = {
  engine: "claude",
  checked: true,
  installed: false,
  loggedIn: false,
  message: "Claude Code ist nicht installiert: der Befehl claude wurde nicht gefunden (anderer Pfad über CLAUDE_PATH in .env)",
};

/** Abhängigkeiten mit Zählern, damit Tests sehen, was geprüft wurde */
function deps(o: { settings?: Settings; env?: Record<string, string>; claude?: EngineStatus; missing?: string[]; ollama?: string | null } = {}) {
  const calls = { inspect: 0, flags: 0, ollama: 0 };
  const d: CallModelDeps = {
    settings: o.settings ?? {},
    env: o.env ?? {},
    inspectClaude: async () => (calls.inspect++, o.claude ?? CLAUDE_OK),
    cliFlags: async () => (calls.flags++, { missing: o.missing ?? [] }),
    ollamaCheck: async () => (calls.ollama++, o.ollama ?? null),
  };
  return { d, calls };
}

describe("auto: Reihenfolge", () => {
  test("Stufe 1: VOICE_ANTHROPIC_API_KEY gesetzt, Sonnet über die API, Claude Code wird gar nicht geprüft", async () => {
    const { d, calls } = deps({ env: { VOICE_ANTHROPIC_API_KEY: "sk-test", OPENROUTER_API_KEY: "or" } });
    const r = await resolveCallModel(d);
    expect(r).toMatchObject({ spec: CALL_DEFAULT_CLAUDE, via: "api", ready: true, billing: "anthropic-api", costsMoney: true, effort: "low", setting: "auto", source: "code" });
    expect(r.expectation).toContain("1,5 Sekunden");
    expect(r.expectation).toContain(CALL_MEASUREMENT);
    expect(calls.inspect).toBe(0);
  });

  test("Stufe 2: ohne Schlüssel, Claude Code bereit, Sonnet über die offene Sitzung im Abo", async () => {
    const { d, calls } = deps({ env: { OPENROUTER_API_KEY: "or" } });
    const r = await resolveCallModel(d);
    expect(r).toMatchObject({ spec: CALL_DEFAULT_CLAUDE, via: "cli", ready: true, billing: "subscription", costsMoney: false });
    expect(r.expectation).toContain("bis 5 Sekunden");
    expect(calls).toMatchObject({ inspect: 1, flags: 1 });
  });

  test("CLI mit ANTHROPIC_API_KEY im Bot ist nicht das Abo: billing anthropic-api", async () => {
    const { d } = deps({ env: { ANTHROPIC_API_KEY: "sk-bot" } });
    expect(await resolveCallModel(d)).toMatchObject({ via: "cli", billing: "anthropic-api", costsMoney: true });
  });

  test("Stufe 3: Claude Code nicht angemeldet oder ohne Flags, OpenRouter mit Schlüssel", async () => {
    const notLoggedIn = deps({ env: { OPENROUTER_API_KEY: "or" }, claude: { ...CLAUDE_OK, loggedIn: false, message: "nicht angemeldet" } });
    expect(await resolveCallModel(notLoggedIn.d)).toMatchObject({ spec: CALL_DEFAULT_OPENROUTER, via: "openrouter", ready: true, billing: "openrouter", costsMoney: true });
    const oldCli = deps({ env: { OPENROUTER_API_KEY: "or" }, missing: ["--safe-mode"] });
    expect(await resolveCallModel(oldCli.d)).toMatchObject({ via: "openrouter" });
  });

  test("nur Codex (kein Claude Code, keine Schlüssel): nicht bereit, Grund nennt alle Stufen", async () => {
    const { d, calls } = deps({ claude: CLAUDE_MISSING, settings: { engine: { default: "codex" }, fallback: { ollamaModel: "qwen3:8b" } } });
    const r = await resolveCallModel(d);
    expect(r.ready).toBe(false);
    expect(r.spec).toBeNull();
    expect(r.via).toBeNull();
    expect(r.reason).toContain("kein VOICE_ANTHROPIC_API_KEY");
    expect(r.reason).toContain("Claude Code ist nicht installiert");
    expect(r.reason).toContain("kein OPENROUTER_API_KEY");
    expect(r.reason).toContain("Sprechmodus");
    // Ollama wird von auto nie gewählt, nicht einmal geprüft
    expect(calls.ollama).toBe(0);
    expect(() => createCallBackend(r)).toThrow(BrainError);
  });

  test("Ollama wählt auto nie, auch wenn sonst nichts bereit ist und OLLAMA_MODEL gesetzt ist", async () => {
    const { d, calls } = deps({ claude: CLAUDE_MISSING, env: { OLLAMA_MODEL: "qwen3:8b", OLLAMA_CONTEXT_LENGTH: "32768" } });
    const r = await resolveCallModel(d);
    expect(r.ready).toBe(false);
    expect(r.via).not.toBe("ollama");
    expect(calls.ollama).toBe(0);
  });

  test("claudeVia cli: auto überspringt die API trotz Schlüssel; claudeVia api: auto prüft die CLI nicht", async () => {
    const cli = deps({ env: { VOICE_ANTHROPIC_API_KEY: "sk" }, settings: { speech: { call: { claudeVia: "cli" } } } });
    expect(await resolveCallModel(cli.d)).toMatchObject({ via: "cli", claudeVia: "cli" });
    const api = deps({ env: { OPENROUTER_API_KEY: "or" }, settings: { speech: { call: { claudeVia: "api" } } } });
    expect(await resolveCallModel(api.d)).toMatchObject({ via: "openrouter" });
    expect(api.calls.inspect).toBe(0);
  });
});

describe("ausdrückliche Wahl", () => {
  test("claude:<modell> mit Schlüssel über die API, ohne über die CLI; claudeVia erzwingt, ohne auszuweichen", async () => {
    const withKey = deps({ env: { VOICE_ANTHROPIC_API_KEY: "sk" }, settings: { speech: { call: { model: "claude:claude-haiku-5-5" } } } });
    expect(await resolveCallModel(withKey.d)).toMatchObject({ via: "api", model: "claude-haiku-5-5", source: "settings" });
    const noKey = deps({ settings: { speech: { call: { model: "claude:claude-haiku-5-5" } } } });
    const cli = await resolveCallModel(noKey.d);
    expect(cli).toMatchObject({ via: "cli", ready: true });
    expect(cli.expectation).toContain("1,2 Sekunden");
    const forcedApi = deps({ env: { OPENROUTER_API_KEY: "or" }, settings: { speech: { call: { model: "claude:claude-sonnet-5-5", claudeVia: "api" } } } });
    expect(await resolveCallModel(forcedApi.d)).toMatchObject({ ready: false, via: "api", reason: expect.stringContaining("VOICE_ANTHROPIC_API_KEY fehlt") });
    const forcedCli = deps({ env: { VOICE_ANTHROPIC_API_KEY: "sk" }, claude: CLAUDE_MISSING, settings: { speech: { call: { model: "claude:claude-sonnet-5-5", claudeVia: "cli" } } } });
    expect(await resolveCallModel(forcedCli.d)).toMatchObject({ ready: false, via: "cli", reason: expect.stringContaining("nicht installiert") });
  });

  test("fehlende CLI-Flags werden als Grund gemeldet", async () => {
    const { d } = deps({ missing: ["--safe-mode", "--tools"], settings: { speech: { call: { model: "claude:claude-sonnet-5-5" } } } });
    const r = await resolveCallModel(d);
    expect(r.ready).toBe(false);
    expect(r.reason).toContain("--safe-mode, --tools");
  });

  test("openrouter: ohne Schlüssel nicht bereit; ollama: ausdrücklich gewählt, geprüft, lokal und zäh", async () => {
    const or = deps({ settings: { speech: { call: { model: "openrouter:anthropic/claude-sonnet-5.5" } } } });
    expect(await resolveCallModel(or.d)).toMatchObject({ ready: false, reason: "OPENROUTER_API_KEY fehlt" });
    const ol = deps({ settings: { speech: { call: { model: "ollama:qwen3:8b" } } } });
    const r = await resolveCallModel(ol.d);
    expect(r).toMatchObject({ via: "ollama", model: "qwen3:8b", ready: true, billing: "local", costsMoney: false });
    expect(r.expectation).toContain("zäh");
    const down = deps({ ollama: "Ollama läuft nicht (ollama serve starten)", settings: { speech: { call: { model: "ollama:qwen3:8b" } } } });
    expect(await resolveCallModel(down.d)).toMatchObject({ ready: false, reason: "Ollama läuft nicht (ollama serve starten)" });
  });

  test("Datei schlägt .env, .env schlägt auto, ungültiges SPEECH_CALL_MODEL gilt als auto", async () => {
    const both = deps({ env: { SPEECH_CALL_MODEL: "claude:claude-sonnet-5-5", OPENROUTER_API_KEY: "or" }, settings: { speech: { call: { model: "openrouter:openai/gpt-x" } } } });
    expect(await resolveCallModel(both.d)).toMatchObject({ spec: "openrouter:openai/gpt-x", source: "settings" });
    const envOnly = deps({ env: { SPEECH_CALL_MODEL: "openrouter:openai/gpt-x", OPENROUTER_API_KEY: "or" } });
    expect(await resolveCallModel(envOnly.d)).toMatchObject({ spec: "openrouter:openai/gpt-x", source: "env" });
    const fileAuto = deps({ env: { SPEECH_CALL_MODEL: "openrouter:openai/gpt-x", VOICE_ANTHROPIC_API_KEY: "sk" }, settings: { speech: { call: { model: "auto" } } } });
    expect(await resolveCallModel(fileAuto.d)).toMatchObject({ setting: "auto", source: "settings", via: "api" });
    const bad = deps({ env: { SPEECH_CALL_MODEL: "gpt:-rm", VOICE_ANTHROPIC_API_KEY: "sk" } });
    expect(await resolveCallModel(bad.d)).toMatchObject({ setting: "auto", source: "code", via: "api" });
  });

  test("Effort aus speech.call.effort, Standard low", async () => {
    const { d } = deps({ env: { VOICE_ANTHROPIC_API_KEY: "sk" }, settings: { speech: { call: { effort: "medium" } } } });
    expect((await resolveCallModel(d)).effort).toBe("medium");
  });
});

describe("kein Ausweichen", () => {
  const resolution = (via: "openrouter" | "api" | "cli" | "ollama" = "openrouter"): CallModelResolution => ({
    spec: CALL_DEFAULT_OPENROUTER,
    kind: "openrouter",
    model: "anthropic/claude-sonnet-5.5",
    via,
    effort: "low",
    ready: true,
    expectation: "",
    billing: "openrouter",
    costsMoney: true,
    setting: "auto",
    source: "code",
  });

  function flaky(plan: ("ok" | "fail")[]) {
    const log = { calls: 0, closed: 0 };
    const backend: BrainBackend = {
      id: "attrappe",
      label: "Attrappe",
      async *stream() {
        log.calls++;
        const step = plan.shift() ?? "fail";
        if (step === "fail") throw new BrainError("network", "weg");
        yield { text: "Alles gut." };
      },
      close: () => void log.closed++,
    };
    return { backend, log };
  }

  async function turn(b: BrainBackend) {
    const events: VoiceTurnEvent[] = [];
    for await (const e of runVoiceTurn({ backend: b, system: "S", history: [], userText: "Hallo" })) events.push(e);
    return events[events.length - 1];
  }

  test("zwei Ausfälle hintereinander beenden das Gespräch; kein anderer Weg, keine Fallback-Kette", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      throw new Error("kein Netz in Tests");
    }) as unknown as typeof fetch;
    const { backend, log } = flaky(["fail", "fail", "ok"]);
    const b = createCallBackend(resolution(), { factories: { openrouter: () => backend } });
    expect(await turn(b)).toMatchObject({ type: "error", reason: "network" });
    expect(await turn(b)).toMatchObject({ type: "error", reason: "ended" });
    expect(await turn(b)).toMatchObject({ type: "error", reason: "ended" });
    // Der dritte Turn erreicht den Weg nicht mehr, nichts anderes springt ein
    expect(log.calls).toBe(2);
    expect(log.closed).toBe(1);
    expect(fetches).toBe(0);
  });

  test("ein erfolgreicher Turn setzt die Zählung zurück; Budget zählt nicht als Ausfall", async () => {
    const { backend, log } = flaky(["fail", "ok", "fail", "ok"]);
    const b = createCallBackend(resolution(), { factories: { openrouter: () => backend } });
    expect(await turn(b)).toMatchObject({ type: "error" });
    expect(await turn(b)).toMatchObject({ type: "done" });
    expect(await turn(b)).toMatchObject({ type: "error", reason: "network" });
    expect(await turn(b)).toMatchObject({ type: "done" });
    expect(log.calls).toBe(4);

    let n = 0;
    const budget: BrainBackend = {
      id: "b",
      label: "B",
      async *stream() {
        n++;
        if (n <= 2) throw new BrainError("budget", "Daily API budget reached");
        yield { text: "Wieder Budget da." };
      },
    };
    const bb = createCallBackend(resolution(), { factories: { openrouter: () => budget } });
    expect(await turn(bb)).toMatchObject({ reason: "budget" });
    expect(await turn(bb)).toMatchObject({ reason: "budget" });
    expect(await turn(bb)).toMatchObject({ type: "done" });
  });

  test("API-Weg: close() nach dem ersten Abschnitt beendet den laufenden Turn, Abruf ab, Budget einmal abgerechnet", async () => {
    const enc = new TextEncoder();
    const sse = (e: Record<string, unknown>) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
    const requests: { signal?: AbortSignal }[] = [];
    let cancelled = false;
    globalThis.fetch = (async (_input: any, init?: any) => {
      requests.push({ signal: init?.signal });
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            enc.encode(
              sse({ type: "message_start", message: { id: "msg_1" } }) +
                sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
                sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Rom wurde gegründet. Dann kamen die Könige. Später " } }),
            ),
          );
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const budget = { reserved: 0, settled: 0 };
    const b = createCallBackend(
      { ...resolution("api"), spec: CALL_DEFAULT_CLAUDE, kind: "claude", model: "claude-sonnet-5-5", billing: "anthropic-api" },
      { env: { VOICE_ANTHROPIC_API_KEY: "sk-test" }, reserveRequest: () => (budget.reserved++, () => void budget.settled++) },
    );
    const t = runVoiceTurn({ backend: b, system: "S", history: [], userText: "Erzähl von Rom", earlyFirst: false });
    expect((await t.next()).value).toMatchObject({ type: "segment", text: "Rom wurde gegründet." });
    b.close?.();
    const rest: VoiceTurnEvent[] = [];
    for await (const e of t) rest.push(e);
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({ type: "error", reason: "ended", spokenText: "Rom wurde gegründet." });
    expect(requests[0].signal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
    expect(budget).toEqual({ reserved: 1, settled: 1 });
    expect(await turn(b)).toMatchObject({ type: "error", reason: "ended" });
    expect(requests).toHaveLength(1);
  });

  test("API-Weg: abgerissene Antwort ohne message_stop ist ein Ausfall; zweiter beendet das Gespräch, Rest nicht gesprochen", async () => {
    const enc = new TextEncoder();
    const sse = (e: Record<string, unknown>) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
    const partial =
      sse({ type: "message_start", message: { id: "msg_1" } }) +
      sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Morgen wird es sonnig. Am Nachmittag zieht" } });
    const replies = ["", partial];
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      const text = replies.shift() ?? "";
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          if (text) c.enqueue(enc.encode(text));
          c.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const budget = { reserved: 0, settled: 0 };
    const b = createCallBackend(
      { ...resolution("api"), spec: CALL_DEFAULT_CLAUDE, kind: "claude", model: "claude-sonnet-5-5", billing: "anthropic-api" },
      { env: { VOICE_ANTHROPIC_API_KEY: "sk-test" }, reserveRequest: () => (budget.reserved++, () => void budget.settled++) },
    );
    const run = async () => {
      const events: VoiceTurnEvent[] = [];
      for await (const e of runVoiceTurn({ backend: b, system: "S", history: [], userText: "Wetter?", earlyFirst: false })) events.push(e);
      return events;
    };
    // Leerer Strom
    const first = await run();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: "error", reason: "network" });
    // Teilweise geliefert: der fertige Satz ist gesprochen, der angefangene nicht
    const second = await run();
    expect(second.filter((e) => e.type === "segment").map((e) => (e as { text: string }).text)).toEqual(["Morgen wird es sonnig."]);
    expect(second[second.length - 1]).toMatchObject({ type: "error", reason: "ended", spokenText: "Morgen wird es sonnig." });
    // Gespräch beendet: kein weiterer Abruf
    expect((await run())[0]).toMatchObject({ type: "error", reason: "ended" });
    expect(fetches).toBe(2);
    expect(budget).toEqual({ reserved: 2, settled: 2 });
  });

  test("Sprach-Brücke unverändert: streamAnthropic liefert einen abgerissenen Strom weiter als Ergebnis, nur mit complete false", async () => {
    const enc = new TextEncoder();
    const sse = (e: Record<string, unknown>) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
    const send = (withStop: boolean) => {
      globalThis.fetch = (async () => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              enc.encode(
                sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
                  sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hallo" } }) +
                  (withStop ? sse({ type: "message_stop" }) : ""),
              ),
            );
            c.close();
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }) as unknown as typeof fetch;
    };
    const call = { model: "m", system: "S", messages: [], effort: "low" as const, max_tokens: 10 };
    const sinks = { onText: () => {}, onToolStart: () => {}, onToolArgs: () => {} };
    send(false);
    expect(await streamAnthropic("sk-test", call, new Set(), sinks)).toMatchObject({ finish: "stop", text: "Hallo", complete: false });
    send(true);
    expect(await streamAnthropic("sk-test", call, new Set(), sinks)).toMatchObject({ finish: "stop", text: "Hallo", complete: true });
  });

  test("close() beim letzten, erst aus sentences.flush() gelieferten Abschnitt: Abschluss ended statt done", async () => {
    const enc = new TextEncoder();
    const chunk = (content: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(chunk("Rom wurde gegründet. Dann kamen die Könige.") + "data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const b = createCallBackend(resolution(), { env: { OPENROUTER_API_KEY: "or-test" } });
    const t = runVoiceTurn({ backend: b, system: "S", history: [], userText: "Erzähl von Rom", earlyFirst: false });
    expect((await t.next()).value).toMatchObject({ type: "segment", text: "Rom wurde gegründet." });
    expect((await t.next()).value).toMatchObject({ type: "segment", text: "Dann kamen die Könige." });
    b.close?.();
    const rest: VoiceTurnEvent[] = [];
    for await (const e of t) rest.push(e);
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({ type: "error", reason: "ended" });
    expect(await turn(b)).toMatchObject({ type: "error", reason: "ended" });
    expect(fetches).toBe(1);
  });

  test("createCallBackend baut genau den aufgelösten Weg", () => {
    const made: string[] = [];
    const fake = (id: string) => () => (made.push(id), { id, label: id, async *stream() {} }) as BrainBackend;
    const factories = { api: fake("api"), cli: fake("cli"), openrouter: fake("openrouter"), ollama: fake("ollama") };
    for (const via of ["api", "cli", "openrouter", "ollama"] as const) createCallBackend(resolution(via), { factories });
    expect(made).toEqual(["api", "cli", "openrouter", "ollama"]);
  });
});

describe("probeCallModel", () => {
  test("drei Fragen je Lauf, Median, kleinster und größter Wert bis zum ersten Abschnitt, erster Turn kalt", async () => {
    let clock = 0;
    const delays = [3000, 1000, 1500, 2000, 1200, 1800];
    const backend: BrainBackend = {
      id: "attrappe",
      label: "Attrappe",
      async *stream() {
        clock += delays.shift()!;
        yield { text: "Das ist eine Antwort. Und noch" };
        clock += 500;
      },
    };
    const r = await probeCallModel({
      runs: 2,
      system: "S",
      now: () => clock,
      resolution: { ...(await resolveCallModel(deps({ env: { OPENROUTER_API_KEY: "or" }, claude: CLAUDE_MISSING }).d)) },
      backendOptions: { factories: { openrouter: () => backend } },
    });
    expect(r.samples).toHaveLength(6);
    expect(r.samples.map((s) => s.question)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(r.samples[0].cold).toBe(true);
    expect(r.samples.slice(1).every((s) => !s.cold)).toBe(true);
    expect(r.minMs).toBe(1000);
    expect(r.maxMs).toBe(3000);
    expect(r.medianMs).toBe(1650);
    expect(r.warmMedianMs).toBe(1500);
  });

  test("Gespräch beendet (zweimal ausgefallen): die Probe misst nicht weiter", async () => {
    const backend: BrainBackend = {
      id: "kaputt",
      label: "Kaputt",
      async *stream() {
        throw new BrainError("setup", "Kontext zu klein");
      },
    };
    const resolution = await resolveCallModel(deps({ env: { OPENROUTER_API_KEY: "or" }, claude: CLAUDE_MISSING }).d);
    const r = await probeCallModel({ runs: 3, system: "S", resolution, backendOptions: { factories: { openrouter: () => backend } } });
    expect(r.samples).toHaveLength(2);
    expect(r.samples[0].error).toBe("setup: Kontext zu klein");
    expect(r.samples[1].error?.startsWith("ended:")).toBe(true);
    expect(r.medianMs).toBeNull();
  });

  test("nicht bereit: Probe wirft mit dem Grund", async () => {
    await expect(probeCallModel({ ...deps({ claude: CLAUDE_MISSING }).d, system: "S" })).rejects.toThrow("Kein Weg für den Telefonhörer bereit");
  });
});

describe("Einstellungen speech.call", () => {
  test("Schema: auto und <kind>:<modell>, nichts mit - am Anfang, claudeVia nur api oder cli", () => {
    const ok = (call: unknown) => settingsSchema.safeParse({ speech: { call } }).success;
    expect(ok({ model: "auto", effort: "low", claudeVia: "cli" })).toBe(true);
    expect(ok({ model: "ollama:qwen3:8b" })).toBe(true);
    expect(ok({ model: "openrouter:anthropic/claude-sonnet-5.5" })).toBe(true);
    expect(ok({ model: "claude:-rm" })).toBe(false);
    expect(ok({ model: "gpt:x" })).toBe(false);
    expect(ok({ model: "claude:" })).toBe(false);
    expect(ok({ claudeVia: "abo" })).toBe(false);
    expect(ok({ effort: "turbo" })).toBe(false);
    expect(ok({ unbekannt: 1 })).toBe(true); // zod entfernt Unbekanntes beim Lesen
  });

  test("PATCH: speech.call verschachtelt, übrige Sprach- und Klon-Einstellungen bleiben", () => {
    const current = { speech: { stt: "parakeet", tts: "clone", cloneVoice: "0123456789abcdef", telegramTts: "pocket", call: { effort: "medium" } } } as any;
    const set = applySettingsPatch(current, { speech: { call: { model: "claude:claude-sonnet-5-5", claudeVia: "cli" } } }, []);
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.value.speech).toEqual({ stt: "parakeet", tts: "clone", cloneVoice: "0123456789abcdef", telegramTts: "pocket", call: { effort: "medium", model: "claude:claude-sonnet-5-5", claudeVia: "cli" } } as any);
    expect(settingsSchema.safeParse(set.value).success).toBe(true);
    expect(set.changed).toEqual(["speech.call.model", "speech.call.claudeVia"]);

    const field = applySettingsPatch(set.value, { speech: { call: { claudeVia: null, effort: "" } } }, []);
    expect(field.ok && field.value.speech?.call).toEqual({ model: "claude:claude-sonnet-5-5" });

    const removed = applySettingsPatch(set.value, { speech: { call: null } }, []);
    expect(removed.ok && removed.value.speech).toEqual({ stt: "parakeet", tts: "clone", cloneVoice: "0123456789abcdef", telegramTts: "pocket" } as any);

    const emptied = applySettingsPatch({ speech: { call: { model: "auto" } } }, { speech: { call: { model: null } } }, []);
    expect(emptied.ok && emptied.value.speech).toBeUndefined();

    const flat = applySettingsPatch(set.value, { speech: { stt: "auto" } }, []);
    expect(flat.ok && (flat.value.speech as any).call).toEqual({ effort: "medium", model: "claude:claude-sonnet-5-5", claudeVia: "cli" });
  });

  test("PATCH: unbekanntes Feld oder falscher Typ in speech.call ergibt einen Fehler", () => {
    expect(applySettingsPatch({}, { speech: { call: { voice: "x" } } }, [])).toEqual({ ok: false, error: "Unbekanntes Feld: speech.call.voice" });
    expect(applySettingsPatch({}, { speech: { call: "auto" } }, []).ok).toBe(false);
    const invalid = applySettingsPatch({}, { speech: { call: { model: "claude:-x" } } }, []);
    expect(invalid.ok).toBe(true);
    if (invalid.ok) expect(settingsSchema.safeParse(invalid.value).success).toBe(false);
  });
});
