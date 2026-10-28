/**
 * Issue #350, Checkbox 2: Betriebsprofil (src/lib/runtime-profile.ts) und
 * seine Wirkung auf die Telegram-Laufzeit. Polling bleibt Standard; server
 * ergibt den Webhook nur mit gültigem Secret und freiem Port. Ungültige
 * Angaben ergeben keinen Eingang (weder Webhook ohne Secret noch Polling),
 * der Rest des Bots läuft weiter. Kein Netz; src/bot.ts wird nie importiert.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { setChoicesFileForTests } from "../src/lib/choices";
import { DEFAULT_WEBHOOK_PORT, resolveRuntimeProfile } from "../src/lib/runtime-profile";
import { createTelegramRuntime } from "../src/lib/telegram-runtime";
import { createServerRoutes } from "../src/app/server-routes";
import { startHealthServer } from "../src/app/health-server";
import { isolateAgentCatalog } from "./catalog-fixture";

isolateAgentCatalog();

const SECRET = "webhook-secret-fuer-tests_0123456789";
const TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghijklmn";
const TELEGRAM = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_USER_ID: "4242" };
const me = { id: 123456789, is_bot: true, first_name: "tybo", username: "tybo_bot" } as UserFromGetMe;

const base = mkdtempSync(join(tmpdir(), "runtime-profile-"));
let counter = 0;
beforeEach(() => setChoicesFileForTests(join(base, `choices-${++counter}.json`)));
afterAll(() => {
  setChoicesFileForTests(null);
  rmSync(base, { recursive: true, force: true });
});

function reason(env: Record<string, string>): string {
  const result = resolveRuntimeProfile(env);
  if (result.ok) throw new Error("gültig, erwartet war ungültig");
  return result.reason;
}

describe("resolveRuntimeProfile", () => {
  test("ohne Angabe und mit local: Polling", () => {
    for (const env of [{}, { TYBO_PROFILE: "" }, { TYBO_PROFILE: "local" }, { TYBO_PROFILE: " Local " }]) {
      expect(resolveRuntimeProfile(env)).toEqual({ ok: true, profile: { name: "local", telegram: { mode: "polling" } } });
    }
  });

  test("local ignoriert Webhook-Angaben", () => {
    const result = resolveRuntimeProfile({ TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_WEBHOOK_URL: "https://x.example/telegram" });
    expect(result.ok && result.profile.telegram.mode).toBe("polling");
  });

  test("server mit Secret: Webhook unter /telegram auf 127.0.0.1 und Standardport, ohne öffentliche Adresse", () => {
    expect(resolveRuntimeProfile({ TYBO_PROFILE: "server", TELEGRAM_WEBHOOK_SECRET: SECRET })).toEqual({
      ok: true,
      profile: {
        name: "server",
        telegram: { mode: "webhook", webhook: { hostname: "127.0.0.1", port: DEFAULT_WEBHOOK_PORT, path: "/telegram", secret: SECRET, publicUrl: null } },
      },
    });
  });

  test("server mit Host, Port und öffentlicher Adresse", () => {
    const result = resolveRuntimeProfile({
      TYBO_PROFILE: "server",
      TELEGRAM_WEBHOOK_SECRET: SECRET,
      TELEGRAM_WEBHOOK_HOST: "0.0.0.0",
      TELEGRAM_WEBHOOK_PORT: "8443",
      TELEGRAM_WEBHOOK_URL: "https://tybo.example.org/telegram",
    });
    expect(result.ok && result.profile.telegram).toEqual({
      mode: "webhook",
      webhook: { hostname: "0.0.0.0", port: 8443, path: "/telegram", secret: SECRET, publicUrl: "https://tybo.example.org/telegram" },
    });
  });

  test("server ohne oder mit untauglichem Secret: ungültig, nie ein Webhook ohne Secret", () => {
    expect(reason({ TYBO_PROFILE: "server" })).toContain("TELEGRAM_WEBHOOK_SECRET");
    expect(reason({ TYBO_PROFILE: "server", TELEGRAM_WEBHOOK_SECRET: "   " })).toContain("TELEGRAM_WEBHOOK_SECRET");
    expect(reason({ TYBO_PROFILE: "server", TELEGRAM_WEBHOOK_SECRET: "zu-kurz" })).toContain("16 bis 256");
    expect(reason({ TYBO_PROFILE: "server", TELEGRAM_WEBHOOK_SECRET: "leer zeichen sind verboten!!" })).toContain("16 bis 256");
  });

  test("Portkonflikte mit Health-Port und WebUI, ungültiger Port", () => {
    const server = { TYBO_PROFILE: "server", TELEGRAM_WEBHOOK_SECRET: SECRET };
    expect(reason({ ...server, TELEGRAM_WEBHOOK_PORT: "3000" })).toContain("schon vergeben");
    expect(reason({ ...server, TELEGRAM_WEBHOOK_PORT: "4000", HEALTH_PORT: "4000" })).toContain("schon vergeben");
    expect(reason({ ...server, TELEGRAM_WEBHOOK_PORT: "3100", WEB_ENABLED: "true" })).toContain("schon vergeben");
    expect(reason({ ...server, TELEGRAM_WEBHOOK_PORT: "3199", WEB_ENABLED: "true", WEB_PORT: "3199" })).toContain("schon vergeben");
    expect(reason({ ...server, TELEGRAM_WEBHOOK_PORT: "70000" })).toContain("kein gültiger Port");
    expect(reason({ ...server, TELEGRAM_WEBHOOK_PORT: "abc" })).toContain("kein gültiger Port");
    // WebUI aus: 3100 ist frei
    expect(resolveRuntimeProfile({ ...server, TELEGRAM_WEBHOOK_PORT: "3100" }).ok).toBe(true);
  });

  test("öffentliche Adresse nur mit https; unbekanntes Profil ungültig", () => {
    expect(reason({ TYBO_PROFILE: "server", TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_WEBHOOK_URL: "http://x.example/telegram" })).toContain("https");
    expect(reason({ TYBO_PROFILE: "server", TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_WEBHOOK_URL: "kaputt" })).toContain("https");
    expect(reason({ TYBO_PROFILE: "sever" })).toContain("unbekannt");
  });
});

describe("Profil in der Telegram-Laufzeit", () => {
  function runtimeFor(env: Record<string, string>) {
    const calls: string[] = [];
    const logs: string[] = [];
    const runtime = createTelegramRuntime({
      env: { ...TELEGRAM, ...env },
      createBot: token => {
        const bot = new Bot(token, { botInfo: me });
        bot.api.config.use(async (_prev, method) => (calls.push(method), { ok: true, result: true } as never));
        bot.start = async () => void calls.push("start");
        return bot;
      },
      log: line => logs.push(line),
    });
    return { runtime, calls, logs };
  }

  test("ohne TYBO_PROFILE: Polling (bot.start), kein Listener", async () => {
    const { runtime, calls } = runtimeFor({});
    let ready = 0;
    await runtime.start(() => void ready++);
    expect(calls).toEqual(["start"]);
    expect(runtime.webhookPort()).toBeNull();
    runtime.stop();
  });

  test("server: Webhook-Listener statt Polling, stop schließt ihn", async () => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port!;
    probe.stop(true);
    const { runtime, calls, logs } = runtimeFor({ TYBO_PROFILE: "server", TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_WEBHOOK_PORT: String(port) });
    let ready = 0;
    await runtime.start(() => void ready++);
    expect(calls).not.toContain("start");
    expect(runtime.webhookPort()).toBe(port);
    expect(ready).toBe(1);
    expect(logs).toContain("[telegram] Profil server: Updates per Webhook");
    runtime.stop();
    expect(runtime.webhookPort()).toBeNull();
  });

  test("server ohne Secret: kein Eingang (weder Webhook noch Polling), Fehler im Log, onReady trotzdem einmal", async () => {
    const { runtime, calls, logs } = runtimeFor({ TYBO_PROFILE: "server" });
    let ready = 0;
    await runtime.start(() => void ready++);
    await runtime.start(() => void ready++);
    expect(calls).toEqual([]);
    expect(runtime.webhookPort()).toBeNull();
    expect(ready).toBe(1);
    expect(logs.some(line => line.includes("kein Telegram-Eingang") && line.includes("TELEGRAM_WEBHOOK_SECRET"))).toBe(true);
    expect(() => runtime.stop()).not.toThrow();
  });

  test("ausdrücklich übergebener Weg hat Vorrang vor der env", async () => {
    const { runtime, calls } = runtimeFor({ TYBO_PROFILE: "server" });
    const explicit = createTelegramRuntime({
      env: { ...TELEGRAM, TYBO_PROFILE: "server" },
      intake: { mode: "polling" },
      createBot: token => {
        const bot = new Bot(token, { botInfo: me });
        bot.start = async () => void calls.push("explicit-start");
        return bot;
      },
      log: () => {},
    });
    await explicit.start(() => {});
    expect(calls).toEqual(["explicit-start"]);
    runtime.stop();
  });
});

/**
 * Issue #351, Checkbox 2: Die Server-Wege (/health mit Revision, /deploy,
 * /webhook/elevenlabs) hängen am Webhook-Listener. Den gibt es nur mit
 * TYBO_PROFILE=server; im Profil local bleibt nur der lokale Health-Server
 * (Entscheidung 0001), und der kennt die neuen Wege nicht.
 */
describe("Server-Wege nur im Server-Profil", () => {
  const ROUTE_ENV = { RELEASE_REVISION: "rev-351", DEPLOY_SECRET: "deploy-secret-fuer-tests", ELEVENLABS_WEBHOOK_SECRET: "el-secret-fuer-tests" };

  function freePort(): number {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port!;
    probe.stop(true);
    return port;
  }

  function runtimeWithRoutes(env: Record<string, string>) {
    const hits: string[] = [];
    const routes = createServerRoutes({ env, root: base, transcripts: () => null, startDeploy: () => ({ started: Promise.resolve(), done: Promise.resolve() }), log: () => {} });
    const runtime = createTelegramRuntime({
      env: { ...TELEGRAM, ...env },
      routes: request => (hits.push(new URL(request.url).pathname), routes(request)),
      createBot: token => {
        const bot = new Bot(token, { botInfo: me });
        bot.api.config.use(async () => ({ ok: true, result: true }) as never);
        bot.start = async () => {};
        return bot;
      },
      log: () => {},
    });
    return { runtime, hits };
  }

  test("server: /health mit Revision, /deploy und /webhook/elevenlabs prüfen die Signatur, /process gibt es dort nicht", async () => {
    const port = freePort();
    const { runtime } = runtimeWithRoutes({ ...ROUTE_ENV, TYBO_PROFILE: "server", TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_WEBHOOK_PORT: String(port) });
    await runtime.start(() => {});
    const at = (path: string) => `http://127.0.0.1:${port}${path}`;
    try {
      const health = await fetch(at("/health"));
      expect(health.status).toBe(200);
      const body = (await health.json()) as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expect(body.revision).toBe("rev-351");
      expect(body).not.toHaveProperty("sessionId");
      expect((await fetch(at("/deploy"), { method: "POST", body: "{}" })).status).toBe(401);
      expect((await fetch(at("/webhook/elevenlabs"), { method: "POST", body: "{}" })).status).toBe(401);
      expect((await fetch(at("/process"), { method: "POST", body: "{}" })).status).toBe(404);
      expect((await fetch(at("/"))).status).toBe(404);
      // /telegram bleibt beim Telegram-Eingang: ohne Secret 401
      expect((await fetch(at("/telegram"), { method: "POST", body: "{}" })).status).toBe(401);
    } finally {
      runtime.stop();
    }
  });

  test("local: kein Listener, die Wege werden nie gefragt", async () => {
    const { runtime, hits } = runtimeWithRoutes({ ...ROUTE_ENV });
    await runtime.start(() => {});
    expect(runtime.webhookPort()).toBeNull();
    expect(hits).toEqual([]);
    runtime.stop();
  });

  test("local: der lokale Health-Server kennt /deploy und /webhook/elevenlabs nicht, /health ohne Revision wie bisher", async () => {
    const server = startHealthServer({
      port: 0,
      session: () => ({ sessionId: null, engine: null }),
      secret: () => "",
      allowChat: () => false,
      process: async () => {},
    });
    const at = (path: string) => `http://127.0.0.1:${server.port}${path}`;
    try {
      expect((await fetch(at("/deploy"), { method: "POST", body: "{}" })).status).toBe(404);
      expect((await fetch(at("/webhook/elevenlabs"), { method: "POST", body: "{}" })).status).toBe(404);
      const health = (await (await fetch(at("/health"))).json()) as Record<string, unknown>;
      expect(health.status).toBe("ok");
      expect(health).not.toHaveProperty("revision");
    } finally {
      await server.stop();
    }
  });

  test("server mit ungültigem Profil: kein Listener, also auch keine Server-Wege", async () => {
    const { runtime, hits } = runtimeWithRoutes({ ...ROUTE_ENV, TYBO_PROFILE: "server" });
    await runtime.start(() => {});
    expect(runtime.webhookPort()).toBeNull();
    expect(hits).toEqual([]);
    runtime.stop();
  });
});
