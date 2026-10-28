/**
 * Issue #260, Checkbox 2: Wege zur Auswahl (callWays), Probe des
 * Telefonhörers (Einordnung, Median und Spanne, ohne Messwert keine
 * Einordnung), Route POST /api/voice/call/probe (Login, Origin, 429 nach der
 * vierten Probe, Zeitlimit, 503 ohne Probe), Status mit Wegen im Anschluss
 * und speech.call in der Einstellungen-API (setzen, auto, entfernen).
 * Alle Prüfungen von Claude Code, Ollama und Netz sind Attrappen; kein
 * echtes Modell.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineStatus } from "../src/lib/engines/check";
import { setSettingsPath, type Settings } from "../src/lib/settings";
import { createSpeech } from "../src/lib/speech/chain";
import type { SttProvider } from "../src/lib/speech/types";
import { callWays, probeCallModel, type CallModelDeps, type CallModelResolution, type ProbeResult } from "../src/lib/voice-brain/call-model";
import type { BrainBackend, BrainCall } from "../src/lib/voice-brain/types";
import { createBotCall, summarizeProbe, type BotCallDeps } from "../src/web/bot-call";
import { botSettings } from "../src/web/bot-settings";
import { CALL_PROBE_PATH, CALL_PROBE_TEXT, createProbeLimiter, probeResult, probeText, rateProbe, type CallProbeResult } from "../src/web/call-probe";
import type { CallPort } from "../src/web/call-protocol";
import { createWebServer, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import { fakePort } from "./call-fixture";
import { isolateAgentCatalog } from "./catalog-fixture";
import { topicServer } from "./topic-fixture";

const root = await mkdtemp(join(tmpdir(), "tybo-call-probe-"));
const servers: WebServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map(s => s.stop()));
  await rm(root, { recursive: true, force: true });
}, 30_000);
isolateAgentCatalog();

const CLAUDE_OK: EngineStatus = { engine: "claude", checked: true, installed: true, loggedIn: true, version: "2.1.286" };
const CLAUDE_OUT: EngineStatus = { engine: "claude", checked: true, installed: true, loggedIn: false, message: "Claude Code ist nicht angemeldet (claude einmal im Terminal starten)" };

function deps(o: { env?: Record<string, string>; claude?: EngineStatus; ollama?: string | null; settings?: Settings } = {}): CallModelDeps {
  return {
    settings: o.settings ?? {},
    env: o.env ?? {},
    inspectClaude: async () => o.claude ?? CLAUDE_OK,
    cliFlags: async () => ({ missing: [] }),
    ollamaCheck: async () => o.ollama ?? null,
  };
}

describe("Einordnung und Text", () => {
  test("bis 2 s flüssig, bis 4 s geht, darüber zäh", () => {
    expect(rateProbe(1_300)).toBe("fluessig");
    expect(rateProbe(2_000)).toBe("fluessig");
    expect(rateProbe(2_001)).toBe("geht");
    expect(rateProbe(4_000)).toBe("geht");
    expect(rateProbe(4_001)).toBe("zaeh");
  });

  test("Median und Spanne auf Deutsch", () => {
    expect(probeText({ medianMs: 1_300, minMs: 1_100, maxMs: 1_600, measured: 3, count: 3 })).toBe("Antwort beginnt nach 1,3 s (3 Proben: 1,1 bis 1,6 s), flüssig");
    expect(probeText({ medianMs: 3_200, minMs: 3_200, maxMs: 3_200, measured: 1, count: 3 })).toBe("Antwort beginnt nach 3,2 s (1 Probe von 3), geht");
    expect(probeText({ medianMs: 7_190, minMs: 2_730, maxMs: 9_350, measured: 3, count: 3 })).toBe("Antwort beginnt nach 7,2 s (3 Proben: 2,7 bis 9,4 s), zäh");
  });

  test("ohne Messwert keine Einordnung, nie flüssig", () => {
    const r = probeResult({ medianMs: null, minMs: null, maxMs: null, measured: 0, count: 3, model: "m", via: "api", firstError: "api" });
    expect(r).toEqual({ ok: false, reason: "Keine Probe kam an (api)" });
  });

  test("summarizeProbe: aus probeCallModel, ohne Antworttexte", () => {
    const resolution = { model: "claude-sonnet-5-5", via: "cli" } as CallModelResolution;
    const result: ProbeResult = {
      resolution,
      samples: [
        { question: 1, run: 1, firstMs: 1_600, totalMs: 3_000, cold: true },
        { question: 2, run: 1, firstMs: 1_100, totalMs: 2_000, cold: false },
        { question: 3, run: 1, firstMs: 1_300, totalMs: 2_500, cold: false },
      ],
      medianMs: 1_300,
      minMs: 1_100,
      maxMs: 1_600,
      warmMedianMs: 1_200,
    };
    expect(summarizeProbe(result)).toEqual({
      ok: true,
      medianMs: 1_300,
      minMs: 1_100,
      maxMs: 1_600,
      measured: 3,
      count: 3,
      rating: "fluessig",
      text: "Antwort beginnt nach 1,3 s (3 Proben: 1,1 bis 1,6 s), flüssig",
      model: "claude-sonnet-5-5",
      via: "cli",
    });
    const failed = summarizeProbe({ ...result, samples: result.samples.map(s => ({ ...s, firstMs: null, error: "api: Anthropic antwortet mit 529" })), medianMs: null, minMs: null, maxMs: null });
    expect(failed).toEqual({ ok: false, reason: "Keine Probe kam an (api)" });
  });

  test("Begrenzung: drei in zehn Minuten, dann Wartezeit", () => {
    let t = 0;
    const l = createProbeLimiter({ now: () => t });
    expect([l.take(), l.take(), l.take(), l.take()]).toEqual([true, true, true, false]);
    expect(l.retryAfterSeconds()).toBe(600);
    t = 600_000;
    expect(l.take()).toBe(true);
  });
});

describe("Wege zur Auswahl (callWays)", () => {
  test("alles bereit: Klartext, Abo-Abrechnung bei der CLI ohne ANTHROPIC_API_KEY", async () => {
    const ways = await callWays(deps({ env: { VOICE_ANTHROPIC_API_KEY: "sk-test", OPENROUTER_API_KEY: "or" } }));
    expect(ways.map(w => [w.id, w.model, w.claudeVia ?? null, w.label, w.ready, w.billing])).toEqual([
      ["api", "claude:claude-sonnet-5-5", "api", "Claude Sonnet 5.5 über deinen API-Schlüssel", true, "anthropic-api"],
      ["cli", "claude:claude-sonnet-5-5", "cli", "Claude Sonnet 5.5 über dein Claude-Abo", true, "subscription"],
      ["openrouter", "openrouter:anthropic/claude-sonnet-5.5", null, "OpenRouter: anthropic/claude-sonnet-5.5", true, "openrouter"],
      ["ollama", "ollama:qwen3:8b", null, "Ollama: qwen3:8b", true, "local"],
    ]);
  });

  test("nicht bereite Wege mit Grund; CLI mit ANTHROPIC_API_KEY kostet nach Verbrauch", async () => {
    const ways = await callWays(deps({ env: { ANTHROPIC_API_KEY: "sk-ant", OLLAMA_MODEL: "llama3.2" }, claude: CLAUDE_OK, ollama: "Ollama läuft nicht (ollama serve starten)" }));
    const by = Object.fromEntries(ways.map(w => [w.id, w]));
    expect(by.api).toMatchObject({ ready: false, reason: "VOICE_ANTHROPIC_API_KEY fehlt (claudeVia api ist eingestellt)" });
    expect(by.cli).toMatchObject({ ready: true, billing: "anthropic-api" });
    expect(by.cli!.label).toContain("ANTHROPIC_API_KEY");
    expect(by.openrouter).toMatchObject({ ready: false, reason: "OPENROUTER_API_KEY fehlt" });
    expect(by.ollama).toMatchObject({ model: "ollama:llama3.2", ready: false, reason: "Ollama läuft nicht (ollama serve starten)" });
    const out = await callWays(deps({ claude: CLAUDE_OUT }));
    expect(out.find(w => w.id === "cli")).toMatchObject({ ready: false, reason: CLAUDE_OUT.message });
  });
});

// --- Anschluss: Status mit Wegen, Probe ----------------------------------------------

const RESOLVED: CallModelResolution = {
  spec: "claude:claude-sonnet-5-5",
  kind: "claude",
  model: "claude-sonnet-5-5",
  via: "cli",
  effort: "low",
  ready: true,
  expectation: "erster Satz nach rund 1,5 Sekunden",
  billing: "subscription",
  costsMoney: false,
  setting: "auto",
  source: "code",
};

/**
 * Weg, dessen Antwort nie kommt, bis der Turn abgebrochen wird: zählt
 * gestartete Testfragen, abgebrochene Turns und close() (Prozess bzw. Strom zu)
 */
function hangingBackend() {
  const stats = { streams: 0, aborted: 0, closed: 0, open: 0 };
  let current: BrainCall | null = null;
  const backend: BrainBackend = {
    id: "attrappe",
    label: "Attrappe",
    async *stream(call: BrainCall) {
      stats.streams++;
      stats.open++;
      current = call;
      try {
        await new Promise<void>(resolve => {
          if (call.signal?.aborted) return resolve();
          call.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        stats.aborted++;
        const e = new Error("abgebrochen");
        e.name = "AbortError";
        throw e;
      } finally {
        stats.open--;
      }
    },
    close() {
      stats.closed++;
      current?.abort?.();
    },
  };
  return { backend, stats };
}

describe("Abbruch der Probe (probeCallModel)", () => {
  test("Signal beendet die laufende Testfrage, schließt den Weg, keine weitere Frage", async () => {
    const h = hangingBackend();
    const abort = new AbortController();
    const running = probeCallModel({ resolution: RESOLVED, runs: 1, system: "Probe", signal: abort.signal, backendOptions: { factories: { cli: () => h.backend } } });
    for (let i = 0; i < 20 && !h.stats.streams; i++) await Bun.sleep(1);
    expect(h.stats.streams).toBe(1);
    abort.abort();
    const err = await running.then(() => null, (e: Error) => e);
    expect(err?.name).toBe("AbortError");
    for (let i = 0; i < 20 && h.stats.open; i++) await Bun.sleep(1);
    expect(h.stats).toMatchObject({ streams: 1, aborted: 1, open: 0 });
    expect(h.stats.closed).toBeGreaterThanOrEqual(1);
    await Bun.sleep(20);
    expect(h.stats.streams).toBe(1);
  });

  test("schon abgebrochen: kein Weg wird gebaut", async () => {
    let built = 0;
    const abort = new AbortController();
    abort.abort();
    const err = await probeCallModel({ resolution: RESOLVED, system: "Probe", signal: abort.signal, backendOptions: { factories: { cli: () => (built++, hangingBackend().backend) } } }).then(
      () => null,
      (e: Error) => e
    );
    expect(err?.name).toBe("AbortError");
    expect(built).toBe(0);
  });
});

function bot(o: { resolution?: CallModelResolution; stt?: boolean; probe?: BotCallDeps["runProbe"] } = {}) {
  const stt: SttProvider = { id: "parakeet", label: "Parakeet", local: true, available: () => ({ ok: true }), transcribe: async () => "x" };
  const speech = createSpeech({ stt: o.stt === false ? [] : [stt], tts: [], getSettings: () => ({}) as Settings, env: () => ({}), log: () => {}, readFile: async () => Buffer.alloc(0) });
  return createBotCall({
    userId: "4242",
    groupId: () => null,
    agentForTopic: () => "general",
    speech: () => speech,
    resolve: async () => o.resolution ?? RESOLVED,
    ways: () => callWays(deps({ env: { OPENROUTER_API_KEY: "or" } })),
    readRestart: async () => null,
    isIntakeClosed: () => false,
    reserveRequest: () => () => {},
    env: {},
    log: () => {},
    ...(o.probe ? { runProbe: o.probe } : {}),
  });
}

describe("Anschluss (createBotCall)", () => {
  test("Status nennt Abrechnung, Einstellung und alle Wege", async () => {
    const status = await bot().status();
    expect(status).toMatchObject({ ready: true, billing: "subscription", setting: "auto", settingSource: "code", probe: true });
    expect(status.ways!.map(w => [w.id, w.ready])).toEqual([
      ["api", false],
      ["cli", true],
      ["openrouter", true],
      ["ollama", true],
    ]);
  });

  test("nicht bereit: Grund aus Erkenner und Weg", async () => {
    const status = await bot({ stt: false, resolution: { ...RESOLVED, ready: false, reason: "Kein Weg für den Telefonhörer bereit: kein OPENROUTER_API_KEY", via: null, model: null } }).status();
    expect(status.ready).toBe(false);
    expect(status.reason).toContain("Kein Weg für den Telefonhörer bereit");
    expect(status.stt.id).toBeNull();
  });

  test("Probe: drei Testfragen über den eingestellten Weg, Ergebnis ohne Texte", async () => {
    const seen: unknown[] = [];
    const port = bot({
      probe: async options => {
        seen.push({ runs: options.runs, via: options.resolution?.via });
        return {
          resolution: options.resolution!,
          samples: [1_200, 1_400, 2_600].map((ms, i) => ({ question: i + 1, run: 1, firstMs: ms, totalMs: ms + 1000, cold: i === 0 })),
          medianMs: 1_400,
          minMs: 1_200,
          maxMs: 2_600,
          warmMedianMs: 2_000,
        };
      },
    });
    const r = await port.probe!();
    expect(seen).toEqual([{ runs: 1, via: "cli" }]);
    expect(r).toMatchObject({ ok: true, medianMs: 1_400, minMs: 1_200, maxMs: 2_600, rating: "fluessig", text: "Antwort beginnt nach 1,4 s (3 Proben: 1,2 bis 2,6 s), flüssig" });
  });

  test("Probe ohne bereiten Weg: Absage mit Grund, kein Abruf", async () => {
    let calls = 0;
    const port = bot({
      resolution: { ...RESOLVED, ready: false, reason: "OPENROUTER_API_KEY fehlt" },
      probe: async () => {
        calls++;
        throw new Error("darf nicht laufen");
      },
    });
    expect(await port.probe!()).toEqual({ ok: false, reason: "OPENROUTER_API_KEY fehlt" });
    expect(calls).toBe(0);
  });
});

// --- Route POST /api/voice/call/probe ------------------------------------------------

const PASSWORD = "test-passwort-probe";
const OK: CallProbeResult = { ok: true, medianMs: 1300, minMs: 1100, maxMs: 1600, measured: 3, count: 3, rating: "fluessig", text: "Antwort beginnt nach 1,3 s (3 Proben: 1,1 bis 1,6 s), flüssig", model: "claude-sonnet-5-5", via: "api" };

async function probeServer(port: CallPort | undefined, extra: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(root, "srv-"));
  const store = new ConversationStore({ dir: join(dir, "web") });
  await store.load();
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    { sessionFile: join(dir, "sessions.json"), conversationStore: store, ...(port ? { call: port } : {}), log: () => {}, ...extra }
  );
  servers.push(server);
  const url = server.url;
  const login = await fetch(`${url}/api/login`, { method: "POST", headers: { origin: url }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const post = (headers: Record<string, string> = { cookie, origin: url }) => fetch(`${url}${CALL_PROBE_PATH}`, { method: "POST", headers });
  return { url, cookie, post };
}

describe("POST /api/voice/call/probe", () => {
  test("hinter Login und Origin; vierte Probe in zehn Minuten: 429 mit Retry-After", async () => {
    let runs = 0;
    const p = fakePort();
    const port: CallPort = { ...p.port, probe: async () => (runs++, OK) };
    const s = await probeServer(port);
    expect((await s.post({ origin: s.url })).status).toBe(401);
    expect((await s.post({ cookie: s.cookie, origin: "http://evil.example" })).status).toBe(403);
    expect(runs).toBe(0);
    for (let i = 0; i < 3; i++) {
      const res = await s.post();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ probe: OK });
    }
    const fourth = await s.post();
    expect(fourth.status).toBe(429);
    expect(Number(fourth.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await fourth.json()).toEqual({ error: CALL_PROBE_TEXT.tooMany, reason: "zu-viele" });
    expect(runs).toBe(3);
    // GET ist keine Probe
    expect((await fetch(`${s.url}${CALL_PROBE_PATH}`, { headers: { cookie: s.cookie } })).status).toBe(405);
  });

  test("ohne Telefonhörer bzw. ohne Probe: 503, zählt nicht", async () => {
    const none = await probeServer(undefined);
    expect((await none.post()).status).toBe(503);
    const p = fakePort();
    const without = await probeServer(p.port);
    expect((await without.post()).status).toBe(503);
  });

  test("Zeitlimit: 504", async () => {
    const p = fakePort();
    const port: CallPort = { ...p.port, probe: () => new Promise(() => {}) };
    const s = await probeServer(port, { callProbeTimeoutMs: 50 });
    const res = await s.post();
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: CALL_PROBE_TEXT.timeout, reason: "zeitlimit" });
  });

  test("Zeitlimit beendet auch die Arbeit: Signal bis zum Weg, Weg geschlossen, keine weitere Testfrage", async () => {
    const h = hangingBackend();
    const seen: Array<AbortSignal | undefined> = [];
    // Echter Anschluss und echte Probe (probeCallModel, runVoiceTurn), nur der Weg ist eine Attrappe
    const port = bot({
      probe: options => {
        seen.push(options.signal);
        return probeCallModel({ ...options, system: "Probe", backendOptions: { ...options.backendOptions, factories: { cli: () => h.backend } } });
      },
    });
    const s = await probeServer(port, { callProbeTimeoutMs: 80 });
    const res = await s.post();
    expect(res.status).toBe(504);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(true);
    for (let i = 0; i < 50 && h.stats.open; i++) await Bun.sleep(2);
    expect(h.stats).toMatchObject({ streams: 1, aborted: 1, open: 0 });
    expect(h.stats.closed).toBeGreaterThanOrEqual(1);
    // Keine zweite oder dritte Testfrage nach dem Zeitlimit
    await Bun.sleep(100);
    expect(h.stats.streams).toBe(1);
  });

  test("Anschluss: abgebrochene Probe meldet den Abbruch statt eines Fehlers", async () => {
    const abort = new AbortController();
    const port = bot({
      probe: options =>
        new Promise((_, reject) => {
          const fail = () => {
            const e = new Error("abgebrochen");
            e.name = "AbortError";
            reject(e);
          };
          if (options.signal!.aborted) return fail();
          options.signal!.addEventListener("abort", fail);
        }),
    });
    const running = port.probe!({ signal: abort.signal });
    abort.abort();
    expect(await running).toEqual({ ok: false, reason: "Die Probe wurde abgebrochen." });
  });

  test("Probe ohne Messwert kommt als ok false mit Grund", async () => {
    const p = fakePort();
    const port: CallPort = { ...p.port, probe: async () => ({ ok: false, reason: "Keine Probe kam an (api)" }) };
    const s = await probeServer(port);
    expect(await (await s.post()).json()).toEqual({ probe: { ok: false, reason: "Keine Probe kam an (api)" } });
  });
});

// --- speech.call in der Einstellungen-API -----------------------------------------------

describe("speech.call über PATCH /api/settings", () => {
  let file: string;
  let n = 0;
  beforeEach(() => {
    file = join(root, `settings-${++n}.json`);
    setSettingsPath(file);
  });
  afterEach(() => setSettingsPath());

  test("Weg setzen (model und claudeVia), auf auto stellen, entfernen; ungültiges Modell abgelehnt", async () => {
    const ctx = await topicServer(root, servers, null, { settings: botSettings });
    const read = async () => JSON.parse(await readFile(file, "utf8"));
    let res = await ctx.api("/api/settings", "PATCH", { speech: { stt: "parakeet", call: { model: "claude:claude-sonnet-5-5", claudeVia: "cli" } } });
    expect(res.status).toBe(200);
    expect((await read()).speech).toEqual({ stt: "parakeet", call: { model: "claude:claude-sonnet-5-5", claudeVia: "cli" } });
    res = await ctx.api("/api/settings", "PATCH", { speech: { call: { model: "auto", claudeVia: null } } });
    expect(res.status).toBe(200);
    expect((await read()).speech).toEqual({ stt: "parakeet", call: { model: "auto" } });
    res = await ctx.api("/api/settings", "PATCH", { speech: { call: { model: null } } });
    expect(res.status).toBe(200);
    expect((await read()).speech).toEqual({ stt: "parakeet" });
    res = await ctx.api("/api/settings", "PATCH", { speech: { call: { model: "gpt-5" } } });
    expect(res.status).toBe(400);
    expect((await read()).speech).toEqual({ stt: "parakeet" });
  });

  test("Status nach dem Speichern sofort aktuell: nicht bereit auf bereit, ohne dass die Uhr weiterläuft", async () => {
    const ctx = await topicServer(root, servers, null, { settings: botSettings });
    const stt: SttProvider = { id: "parakeet", label: "Parakeet", local: true, available: () => ({ ok: true }), transcribe: async () => "x" };
    const speech = createSpeech({ stt: [stt], tts: [], getSettings: () => ({}) as Settings, env: () => ({}), log: () => {}, readFile: async () => Buffer.alloc(0) });
    let resolved = 0;
    // Echter Anschluss: resolve, ways und Einstellungen aus der Datei (getSettings), nur Claude Code und Ollama als Attrappe
    const port = createBotCall({
      userId: "4242",
      groupId: () => null,
      agentForTopic: () => "general",
      speech: () => speech,
      readRestart: async () => null,
      isIntakeClosed: () => false,
      reserveRequest: () => () => {},
      env: { VOICE_ANTHROPIC_API_KEY: "sk-test-voice" },
      log: () => {},
      now: () => 1_000,
      callModel: { inspectClaude: async () => (resolved++, CLAUDE_OUT), cliFlags: async () => ({ missing: [] }), ollamaCheck: async () => null },
    });
    expect((await ctx.api("/api/settings", "PATCH", { speech: { call: { model: "openrouter:minimax/minimax-m2.7" } } })).status).toBe(200);
    const before = await port.status();
    expect(before).toMatchObject({ ready: false, via: "openrouter", billing: null, setting: "openrouter:minimax/minimax-m2.7", settingSource: "settings" });
    expect(before.reason).toContain("OPENROUTER_API_KEY fehlt");
    // Innerhalb der Cache-Zeit ohne Änderung: aus dem Cache
    const checks = resolved;
    expect(await port.status()).toEqual(before);
    expect(resolved).toBe(checks);

    expect((await ctx.api("/api/settings", "PATCH", { speech: { call: { model: "claude:claude-sonnet-5-5", claudeVia: "api" } } })).status).toBe(200);
    const after = await port.status();
    expect(after).toMatchObject({ ready: true, via: "api", model: "claude-sonnet-5-5", billing: "anthropic-api", setting: "claude:claude-sonnet-5-5", settingSource: "settings", claudeVia: "api" });
    expect(after.reason).toBeUndefined();
    expect(after.expectation).not.toBe(before.expectation);

    // Zurück auf auto mit claudeVia cli: Abo nicht angemeldet, OpenRouter fehlt, also wieder nicht bereit
    expect((await ctx.api("/api/settings", "PATCH", { speech: { call: { model: "auto", claudeVia: "cli" } } })).status).toBe(200);
    expect(await port.status()).toMatchObject({ ready: false, via: null, billing: null, setting: "auto", settingSource: "settings" });
  });
});
