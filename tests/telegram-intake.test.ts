/**
 * Issue #562: Ein Telegram-Konflikt (409) oder ungültiger Token (401) legt nur
 * den Telegram-Eingang still. Geprüft gegen eine Attrappe von runtime.start
 * und gegen den echten Ablauf von grammY mit abgefangener API (Transformer
 * statt Netz). Kein Test startet src/bot.ts oder spricht mit Telegram: fetch
 * ist ein Spion, der jeden Aufruf ablehnt.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Bot } from "grammy";
import { setChoicesFileForTests } from "../src/lib/choices";
import {
  classifyStartError,
  createIntakeReporter,
  currentIntakeView,
  INTAKE_TEXT,
  retryDelaySeconds,
  superviseTelegramIntake,
  type IntakeEvent,
  type TelegramStartOptions,
} from "../src/lib/telegram-intake";
import { createTelegramRuntime, startAfterFirstSweep, type AgentBots } from "../src/lib/telegram-runtime";
import { isolateAgentCatalog } from "./catalog-fixture";
import { createChoicePostWeb } from "../src/app/bot-choices";
import { createTelegramNoticeRecorder } from "../src/web/bot-turn";

isolateAgentCatalog();

const TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghijklmn";
const USER = "424242";
const base = mkdtempSync(join(tmpdir(), "telegram-intake-"));
let counter = 0;
let fetchCalls: string[] = [];
let fetchSpy: ReturnType<typeof spyOn>;
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  setChoicesFileForTests(join(base, `choices-${++counter}.json`));
  fetchCalls = [];
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: any) => {
    fetchCalls.push(String(input instanceof Request ? input.url : input));
    throw new Error("Netz im Test verboten");
  }) as any);
});
afterEach(() => {
  fetchSpy.mockRestore();
  process.off("unhandledRejection", onUnhandled);
});
afterAll(() => {
  setChoicesFileForTests(null);
  rmSync(base, { recursive: true, force: true });
});

/** Fehler wie grammY ihn wirft (GrammyError trägt error_code); die Meldung enthält absichtlich den Token */
function telegramError(code: number, description: string) {
  return Object.assign(new Error(`Call to 'getUpdates' failed! (${code}: ${description}) https://api.telegram.org/bot${TOKEN}/getUpdates`), {
    ok: false,
    error_code: code,
    description,
  });
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe("Einstufung und Pause", () => {
  test("409, 401 und Anderes", () => {
    expect(classifyStartError(telegramError(409, "Conflict"))).toBe("conflict");
    expect(classifyStartError(telegramError(401, "Unauthorized"))).toBe("unauthorized");
    expect(classifyStartError(telegramError(500, "Internal"))).toBe("other");
    expect(classifyStartError(new Error("fetch failed"))).toBe("other");
    expect(classifyStartError("x")).toBe("other");
  });

  test("wächst von 15 Sekunden bis höchstens 600", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 50].map(retryDelaySeconds)).toEqual([15, 30, 60, 120, 240, 480, 600, 600, 600]);
  });

  test("Meldungen wörtlich wie im Issue", () => {
    expect(INTAKE_TEXT.conflict(30)).toBe("Telegram: Ein anderer Bot nutzt denselben Token (409). Telegram-Eingang pausiert, nächster Versuch in 30 Sekunden.");
    expect(INTAKE_TEXT.unauthorized).toBe("Telegram lehnt den Token ab (401). Telegram-Eingang aus, bis der Token stimmt.");
  });
});

/** Attrappe von runtime.start: je Aufruf das nächste Verhalten der Liste */
function fakeStart(plan: Array<"409" | "401" | "boom" | "ok-then-409" | "run">) {
  const calls: TelegramStartOptions[] = [];
  let running = 0;
  let maxParallel = 0;
  const pending: Array<() => void> = [];
  const start = async (ready: () => void, options: TelegramStartOptions) => {
    calls.push(options);
    running++;
    maxParallel = Math.max(maxParallel, running);
    try {
      const step = plan[calls.length - 1] ?? "run";
      await tick();
      if (step === "409") throw telegramError(409, "Conflict: terminated by other getUpdates request");
      if (step === "401") throw telegramError(401, "Unauthorized");
      if (step === "boom") throw new Error(`fetch failed for bot${TOKEN}`);
      ready();
      options.onPolling();
      if (step === "ok-then-409") throw telegramError(409, "Conflict");
      // läuft, bis gestoppt
      await new Promise<void>(resolve => pending.push(resolve));
    } finally {
      running--;
    }
  };
  return { start, calls, maxParallel: () => maxParallel, stopAll: () => pending.splice(0).forEach(r => r()) };
}

function harness(plan: Parameters<typeof fakeStart>[0]) {
  const fake = fakeStart(plan);
  const controller = new AbortController();
  const sleeps: number[] = [];
  const logs: string[] = [];
  const events: IntakeEvent[] = [];
  let ready = 0;
  const done = superviseTelegramIntake({
    start: fake.start,
    onReady: () => { ready++; },
    signal: controller.signal,
    report: event => { events.push(event); },
    log: line => logs.push(line),
    now: () => 1_000_000,
    tokens: [TOKEN],
    sleep: async ms => { sleeps.push(ms); },
  });
  return { fake, controller, sleeps, logs, events, done, ready: () => ready };
}

describe("Aufsicht über runtime.start (Attrappe)", () => {
  test("nach 409 lebt der Prozess, wiederholt mit wachsender Pause, onReady genau einmal", async () => {
    const h = harness(["409", "409", "409", "run"]);
    await Bun.sleep(30);
    expect(h.fake.calls.length).toBe(4);
    expect(h.sleeps).toEqual([15_000, 30_000, 60_000]);
    expect(h.ready()).toBe(1);
    expect(h.logs.slice(0, 3)).toEqual([INTAKE_TEXT.conflict(15), INTAKE_TEXT.conflict(30), INTAKE_TEXT.conflict(60)]);
    expect(h.fake.maxParallel()).toBe(1);
    // Erholung: ein Zustand ok, Meldung an die WebUI nur beim ersten 409
    expect(h.events.map(e => [e.state, e.firstInSeries])).toEqual([["conflict", true], ["conflict", false], ["conflict", false], ["ok", false]]);
    expect(h.events[0].nextAttemptAt).toBe(1_000_000 + 15_000);
    h.controller.abort();
    h.fake.stopAll();
    await h.done;
    expect(unhandled).toEqual([]);
  });

  test("viele 409: Pause bleibt bei 600 Sekunden", async () => {
    const h = harness(Array.from({ length: 10 }, () => "409" as const));
    await Bun.sleep(60);
    expect(h.sleeps).toEqual([15, 30, 60, 120, 240, 480, 600, 600, 600, 600].map(s => s * 1000));
    h.controller.abort();
    h.fake.stopAll();
    await h.done;
  });

  test("erster angenommener Abruf ohne Fehler: Zustand läuft, keine Logzeile, keine Meldung", async () => {
    const h = harness(["run"]);
    await Bun.sleep(20);
    expect(h.events).toEqual([{ state: "ok", message: INTAKE_TEXT.running, firstInSeries: false }]);
    expect(h.logs).toEqual([]);
    expect(h.ready()).toBe(1);
    h.controller.abort();
    h.fake.stopAll();
    await h.done;
  });

  test("401: kein neuer Versuch, onReady trotzdem einmal, Prozess lebt", async () => {
    const h = harness(["401"]);
    await h.done;
    expect(h.fake.calls.length).toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(h.ready()).toBe(1);
    expect(h.logs).toEqual([INTAKE_TEXT.unauthorized]);
    expect(h.events).toEqual([{ state: "unauthorized", message: INTAKE_TEXT.unauthorized, firstInSeries: true }]);
    expect(unhandled).toEqual([]);
  });

  test("anderer Fehler: neuer Versuch, Meldung ohne Token", async () => {
    const h = harness(["boom", "boom", "run"]);
    await Bun.sleep(30);
    expect(h.fake.calls.length).toBe(3);
    expect(h.sleeps).toEqual([15_000, 30_000]);
    expect(h.logs[0]).toStartWith("Telegram-Eingang gestört (fetch failed for bot");
    expect(h.logs[0]).toEndWith("Nächster Versuch in 15 Sekunden.");
    for (const line of [...h.logs, ...h.events.map(e => e.message)]) expect(line).not.toContain(TOKEN);
    expect(h.events.filter(e => e.firstInSeries).length).toBe(1);
    h.controller.abort();
    h.fake.stopAll();
    await h.done;
  });

  test("Erholung setzt die Pause zurück, ein neuer Konflikt beginnt eine neue Serie", async () => {
    const h = harness(["409", "409", "ok-then-409", "409", "run"]);
    await Bun.sleep(40);
    expect(h.sleeps).toEqual([15_000, 30_000, 15_000, 30_000]);
    expect(h.ready()).toBe(1);
    expect(h.events.map(e => [e.state, e.firstInSeries])).toEqual([
      ["conflict", true],
      ["conflict", false],
      ["ok", false],
      ["conflict", true],
      ["conflict", false],
      ["ok", false],
    ]);
    h.controller.abort();
    h.fake.stopAll();
    await h.done;
  });

  test("Beenden bricht die wartende Wiederholung ab, kein weiterer Start", async () => {
    const fake = fakeStart(["409", "409"]);
    const controller = new AbortController();
    const done = superviseTelegramIntake({ start: fake.start, onReady: () => {}, signal: controller.signal, log: () => {} });
    await Bun.sleep(20);
    expect(fake.calls.length).toBe(1);
    // Die echte Pause (15 Sekunden) läuft; Abbruch beendet sie sofort
    controller.abort();
    await done;
    await Bun.sleep(20);
    expect(fake.calls.length).toBe(1);
  });

  test("Fehler in report und onReady beenden nichts", async () => {
    const fake = fakeStart(["409", "run"]);
    const controller = new AbortController();
    const logs: string[] = [];
    const done = superviseTelegramIntake({
      start: fake.start,
      onReady: () => Promise.reject(new Error("Ziel kaputt")),
      signal: controller.signal,
      report: () => { throw new Error("Melden kaputt"); },
      log: line => logs.push(line),
      sleep: async () => {},
    });
    await Bun.sleep(30);
    expect(fake.calls.length).toBe(2);
    expect(logs.some(l => l.includes("Zustand nicht gemeldet"))).toBe(true);
    expect(logs.some(l => l.includes("Fortsetzen nach dem Start gescheitert"))).toBe(true);
    controller.abort();
    fake.stopAll();
    await done;
    expect(unhandled).toEqual([]);
  });
});

// --- Echter grammY-Ablauf, Netz durch einen Transformer ersetzt ---

type Reply = { ok: true; result: unknown } | { ok: false; error_code: number; description: string };

/** Telegram-Attrappe auf der untersten Transformer-Ebene: zeichnet Methoden auf, antwortet nach Plan */
function fakeTelegram(getUpdatesPlan: Array<"409" | "401" | "ok">, options: { getMe?: "ok" | "401"; webhook?: string } = {}) {
  const methods: string[] = [];
  let updates = 0;
  // Webhook eines anderen Bots (Server); solange er steht, lehnt Telegram getUpdates mit 409 ab
  const state = { webhook: options.webhook ?? "" };
  const transformer = async (_prev: unknown, method: string, payload: any, signal?: AbortSignal): Promise<Reply> => {
    methods.push(method);
    if (method === "getMe") {
      if (options.getMe === "401") return { ok: false, error_code: 401, description: "Unauthorized" };
      return { ok: true, result: { id: 1, is_bot: true, first_name: "Test", username: "haupt_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } };
    }
    if (method === "deleteWebhook") {
      state.webhook = "";
      return { ok: true, result: true };
    }
    if (method === "getWebhookInfo") return { ok: true, result: { url: state.webhook, has_custom_certificate: false, pending_update_count: 0 } };
    if (method === "getUpdates") {
      if (state.webhook) return { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first" };
      // Bestätigung beim Stoppen (ohne Signal, limit 1)
      if (payload?.limit === 1 && !signal) return { ok: true, result: [] };
      const step = getUpdatesPlan[updates++] ?? "hang";
      if (step === "409") return { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running" };
      if (step === "401") return { ok: false, error_code: 401, description: "Unauthorized" };
      if (step === "ok") return { ok: true, result: [] };
      // Langes Polling: wartet, bis abgebrochen
      return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    }
    return { ok: true, result: true };
  };
  return { methods, transformer, state };
}

const fakeAgents: AgentBots = {
  initialize: async () => {},
  agentForMention: () => null,
  sendAsAgent: async () => {},
  sendTypingAsAgent: async () => {},
  sendWithKeyboardAsAgent: async () => {},
};

function realRuntime(telegram: ReturnType<typeof fakeTelegram>, logs: string[]) {
  return createTelegramRuntime({
    env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_USER_ID: USER, TYBO_PROFILE: "local" },
    intake: { mode: "polling" },
    createBot: token => {
      const bot = new Bot(token);
      // Unterste Ebene: hier enden alle Aufrufe, nichts geht ins Netz
      bot.api.config.use(telegram.transformer as any);
      return bot;
    },
    createAgentBots: () => fakeAgents,
    log: line => logs.push(line),
  });
}

describe("echter Ablauf von grammY mit abgefangener API", () => {
  test("409, 409, dann läuft: nie deleteWebhook, onReady einmal, onStart setzt die Pause nicht zurück", async () => {
    const telegram = fakeTelegram(["409", "409", "409", "ok"]);
    const logs: string[] = [];
    const runtime = realRuntime(telegram, logs);
    const sleeps: number[] = [];
    const events: IntakeEvent[] = [];
    let ready = 0;
    const done = startAfterFirstSweep(runtime, Promise.resolve(), () => { ready++; }, {
      report: e => { events.push(e); },
      log: line => logs.push(line),
      sleep: async ms => { sleeps.push(ms); },
    });
    for (let i = 0; i < 50 && !events.some(e => e.state === "ok"); i++) await Bun.sleep(10);

    // Auch der erste Start nicht (Grenze des Issues: kein Verdrängen)
    expect(telegram.methods.filter(m => m === "deleteWebhook").length).toBe(0);
    expect(telegram.methods.filter(m => m === "getMe").length).toBe(1);
    // grammY meldet vor jedem getUpdates „online“; die Pause wächst trotzdem
    expect(logs.filter(l => l.startsWith("Bot online as @haupt_bot")).length).toBe(4);
    expect(sleeps).toEqual([15_000, 30_000, 60_000]);
    expect(ready).toBe(1);
    expect(events.map(e => e.state)).toEqual(["conflict", "conflict", "conflict", "ok"]);
    expect(logs).toContain(INTAKE_TEXT.conflict(15));
    expect(logs).toContain(`[telegram] ${INTAKE_TEXT.recovered}`);
    for (const line of logs) expect(line).not.toContain(TOKEN);

    runtime.stop();
    await done;
    expect(fetchCalls).toEqual([]);
    expect(unhandled).toEqual([]);
  });

  test("401 schon bei der Anmeldung: kein Polling, kein neuer Versuch, onReady einmal", async () => {
    const telegram = fakeTelegram([], { getMe: "401" });
    const logs: string[] = [];
    const runtime = realRuntime(telegram, logs);
    let ready = 0;
    const events: IntakeEvent[] = [];
    await startAfterFirstSweep(runtime, Promise.reject(new Error("Prüfung kaputt")), () => { ready++; }, {
      report: e => { events.push(e); },
      log: line => logs.push(line),
      sleep: async () => { throw new Error("darf nicht warten"); },
    });
    expect(ready).toBe(1);
    expect(telegram.methods).not.toContain("getUpdates");
    expect(events.map(e => e.state)).toEqual(["unauthorized"]);
    expect(logs).toContain(INTAKE_TEXT.unauthorized);
    for (const line of logs) expect(line).not.toContain(TOKEN);
    expect(fetchCalls).toEqual([]);
    expect(unhandled).toEqual([]);
  });

  test("Beenden während der Pause: kein weiterer Start, kein deleteWebhook", async () => {
    const telegram = fakeTelegram(["409"]);
    const logs: string[] = [];
    const runtime = realRuntime(telegram, logs);
    const done = startAfterFirstSweep(runtime, Promise.resolve(), () => {}, { log: line => logs.push(line) });
    for (let i = 0; i < 50 && !logs.includes(INTAKE_TEXT.conflict(15)); i++) await Bun.sleep(10);
    expect(logs).toContain(INTAKE_TEXT.conflict(15));
    runtime.stop();
    await done;
    expect(telegram.methods.filter(m => m === "getUpdates").length).toBe(1);
    expect(telegram.methods.filter(m => m === "deleteWebhook").length).toBe(0);
  });

  test("Webhook eines anderen Bots steht schon: bleibt stehen, auch beim ersten Start; Eingang pausiert mit 409", async () => {
    const SERVER = "https://server.example/telegram";
    const telegram = fakeTelegram([], { webhook: SERVER });
    const logs: string[] = [];
    const runtime = realRuntime(telegram, logs);
    const sleeps: number[] = [];
    const events: IntakeEvent[] = [];
    let ready = 0;
    const done = startAfterFirstSweep(runtime, Promise.resolve(), () => { ready++; }, {
      report: e => { events.push(e); },
      log: line => logs.push(line),
      sleep: async ms => { sleeps.push(ms); await Bun.sleep(1); },
    });
    for (let i = 0; i < 100 && sleeps.length < 3; i++) await Bun.sleep(10);
    runtime.stop();
    await done;

    expect(sleeps.slice(0, 3)).toEqual([15_000, 30_000, 60_000]);
    expect(telegram.state.webhook).toBe(SERVER);
    expect(telegram.methods).not.toContain("deleteWebhook");
    expect(telegram.methods).not.toContain("setWebhook");
    expect(telegram.methods).not.toContain("logOut");
    expect(telegram.methods).not.toContain("close");
    expect(telegram.methods.filter(m => m === "getUpdates").length).toBeGreaterThanOrEqual(3);
    expect(events.every(e => e.state === "conflict")).toBe(true);
    expect(events.filter(e => e.firstInSeries).length).toBe(1);
    expect(logs).toContain(INTAKE_TEXT.conflict(15));
    expect(ready).toBe(1);
    expect(fetchCalls).toEqual([]);
    expect(unhandled).toEqual([]);
  });
});

describe("Zustand und Meldung in der WebUI", () => {
  test("Zustand mit PID, Meldung je Serie einmal als Notiz im Direktchat, Erholung nur im Zustand", async () => {
    const path = join(base, `state-${++counter}`, "telegram-intake.json");
    const posts: Array<[string, { text: string; kind: string; source: string }]> = [];
    const report = createIntakeReporter({
      statePath: path,
      postWeb: async (id, post) => { posts.push([id, post]); return true; },
      now: () => Date.UTC(2026, 10, 12, 9, 0, 0),
      pid: 4321,
      log: () => {},
    });
    await report({ state: "conflict", message: INTAKE_TEXT.conflict(15), firstInSeries: true, nextAttemptAt: Date.UTC(2026, 10, 12, 9, 0, 15) });
    await report({ state: "conflict", message: INTAKE_TEXT.conflict(30), firstInSeries: false });
    expect(posts).toEqual([["dm", { text: INTAKE_TEXT.conflict(15), kind: "notice", source: "telegram" }]]);
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored).toEqual({ state: "conflict", message: INTAKE_TEXT.conflict(30), since: "2026-11-12T09:00:00.000Z", pid: 4321 });
    await report({ state: "ok", message: INTAKE_TEXT.recovered, firstInSeries: false });
    expect(posts.length).toBe(1);
    expect(JSON.parse(readFileSync(path, "utf8")).state).toBe("ok");
    expect(await currentIntakeView(path, pid => pid === 4321)).toEqual({ state: "ok", message: INTAKE_TEXT.recovered, since: "2026-11-12T09:00:00.000Z" });
    // Prozess beendet: der Zustand gilt nicht mehr
    expect(await currentIntakeView(path, () => false)).toBeNull();
  });

  test("Zustand eines früheren Prozesses fällt beim Anlegen weg; Fehler beim Melden beenden nichts", async () => {
    const dir = join(base, `state-${++counter}`);
    const path = join(dir, "telegram-intake.json");
    await Bun.write(path, JSON.stringify({ state: "unauthorized", message: "alt", since: "x", pid: 1 }));
    const logs: string[] = [];
    const report = createIntakeReporter({ statePath: path, postWeb: async () => { throw new Error("WebUI weg"); }, log: line => logs.push(line) });
    await Bun.sleep(10);
    expect(existsSync(path)).toBe(false);
    await report({ state: "unauthorized", message: INTAKE_TEXT.unauthorized, firstInSeries: true });
    expect(logs).toEqual(["[telegram] Meldung zum Eingang nicht in der WebUI abgelegt (Error)"]);
    expect(JSON.parse(readFileSync(path, "utf8")).state).toBe("unauthorized");
  });

  test("Meldung landet als display_only im Direktchat, ohne Telegram-Versand und ohne laufende WebUI", async () => {
    const saved: any[] = [];
    const postWeb = createChoicePostWeb({
      web: () => null,
      recordNotice: createTelegramNoticeRecorder({
        userId: USER,
        groupId: () => null,
        agentForTopic: () => undefined,
        recordNotice: async message => { saved.push(message); return true; },
      }),
    });
    const report = createIntakeReporter({ statePath: join(base, `state-${++counter}`, "telegram-intake.json"), postWeb, log: () => {} });
    await report({ state: "unauthorized", message: INTAKE_TEXT.unauthorized, firstInSeries: true });
    expect(saved).toEqual([
      { chat_id: USER, role: "assistant", content: INTAKE_TEXT.unauthorized, metadata: { display_only: true, source: "telegram" } },
    ]);
    expect(fetchCalls).toEqual([]);
  });

  test("unlesbarer Zustand zählt als keiner", async () => {
    const path = join(base, `kaputt-${++counter}.json`);
    writeFileSync(path, "{kein json");
    expect(await currentIntakeView(path, () => true)).toBeNull();
    writeFileSync(path, JSON.stringify({ state: "unbekannt", message: "x", since: "y", pid: 1 }));
    expect(await currentIntakeView(path, () => true)).toBeNull();
  });
});
