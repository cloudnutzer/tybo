/**
 * Issue #126, Checkbox 1: Motor in der WebUI. GET /api/engines (Standard,
 * Verfügbarkeit, abweichende Gespräche mit Namen), POST /api/engines/reset
 * („Auf Standard"), Motor je Gespräch in GET /api/conversations und das
 * SSE-Ereignis engine im Sammelstrom. Die Einstellungsdatei ist temporär
 * (setSettingsPath), der Motor-Port echt (createBotEngines), die Prüfung der
 * Motoren eine Attrappe: nie ein echtes claude oder codex.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineId, EngineStatus } from "../src/lib/engines";
import { setTopicEngine } from "../src/lib/engine-choice";
import { getSettings, setSettingsPath } from "../src/lib/settings";
import { createBotEngines } from "../src/web/bot-engines";
import { botSettings } from "../src/web/bot-settings";
import { conversationSessionKey } from "../src/web/bot-turn";
import { conversationEngines, ENGINE_TEXT, type EnginePort } from "../src/web/engines";
import type { WebServer } from "../src/web/server";
import { createConversationSessionReset, type SessionResetResult } from "../src/web/session-reset";
import type { TelegramConversation, TelegramSource } from "../src/web/telegram";
import { topicServer } from "./topic-fixture";

const GROUP = "-1001234567890";
const USER = "4242";
const DM_KEY = `dm:${USER}`;
const TOPIC_KEY = `topic:${GROUP}:443`;
const GONE_KEY = `topic:${GROUP}:999`;

const root = await mkdtemp(join(tmpdir(), "web-engines-api-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
const cleanups: (() => void)[] = [];
let file: string;
let counter = 0;
const savedEnv = process.env.TYBO_ENGINE;

beforeEach(() => {
  delete process.env.TYBO_ENGINE;
  file = join(root, `settings-${++counter}.json`);
  setSettingsPath(file);
});
afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
  setSettingsPath();
  if (savedEnv === undefined) delete process.env.TYBO_ENGINE;
  else process.env.TYBO_ENGINE = savedEnv;
});

async function readJson(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf-8"));
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Bedingung nicht erreicht");
    await new Promise(r => setTimeout(r, 10));
  }
}

const conv = (id: string, title: string): TelegramConversation => ({ id, title, agent: "general", lastActivity: null });

/** Direktchat und zwei Topics, wie der Bot sie liefert */
const telegram: TelegramSource = {
  listConversations: async () => ({ dm: conv("dm", "Direktchat"), topics: [conv("topic-443", "Recherche"), conv("topic-1", "General")] }),
  groupChatId: () => GROUP,
  getConversation: async () => null,
  history: async () => null,
};

/** Prüf-Attrappe: Codex installiert, aber nicht angemeldet, OpenCode nicht installiert; Konto-Angaben dürfen nie ankommen */
const inspect = async (id: EngineId): Promise<EngineStatus> =>
  id === "claude"
    ? { engine: "claude", checked: true, installed: true, loggedIn: true, version: "2.1.281" }
    : id === "opencode"
      ? { engine: "opencode", checked: true, installed: false, loggedIn: false, message: "OpenCode ist nicht installiert" }
      : {
        engine: "codex",
        checked: true,
        installed: true,
        loggedIn: false,
        version: "0.155.1",
        message: "Codex ist nicht angemeldet: im Terminal `codex login` ausführen",
      };

function port(overrides: { interval?: (fn: () => void) => void } = {}): EnginePort {
  return createBotEngines({
    userId: USER,
    groupId: () => GROUP,
    agentForTopic: () => "research",
    inspect,
    ...(overrides.interval
      ? {
          setInterval: fn => {
            overrides.interval!(fn);
            return 1;
          },
          clearInterval: () => {},
        }
      : {}),
  });
}

interface ResetCall {
  id: string;
}

async function server(
  options: { engines?: EnginePort; reset?: (id: string, write?: () => Promise<void>) => Promise<SessionResetResult>; noReset?: boolean; telegram?: TelegramSource } = {}
) {
  const calls: ResetCall[] = [];
  const reset =
    options.reset ??
    (async (id: string, write?: () => Promise<void>): Promise<SessionResetResult> => {
      calls.push({ id });
      if (write) await write();
      return { status: "done", reset: 1, sessionMode: true };
    });
  const ctx = await topicServer(root, servers, null, {
    telegram: options.telegram ?? telegram,
    engines: options.engines ?? port(),
    ...(options.noReset ? {} : { resetConversation: reset }),
    settings: botSettings,
  });
  return { ...ctx, calls };
}

describe("GET /api/engines", () => {
  test("Standard, Motoren, Verfügbarkeit aus der Attrappe, Ausnahmen mit Namen; nicht zuzuordnende am Ende", async () => {
    await writeFile(file, JSON.stringify({ engine: { topics: { [TOPIC_KEY]: "codex", [GONE_KEY]: "codex", [DM_KEY]: "claude" } } }));
    const ctx = await server();
    const res = await ctx.api("/api/engines");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.default).toEqual({ engine: "claude", source: "code" });
    expect(body.engines).toEqual([
      { id: "claude", label: "Claude Code" },
      { id: "codex", label: "Codex" },
      { id: "opencode", label: "OpenCode" },
    ]);
    expect(body.availability).toEqual([
      { engine: "claude", label: "Claude Code", installed: true, loggedIn: true, version: "2.1.281" },
      {
        engine: "codex",
        label: "Codex",
        installed: true,
        loggedIn: false,
        version: "0.155.1",
        message: "Codex ist nicht angemeldet: im Terminal `codex login` ausführen",
      },
      { engine: "opencode", label: "OpenCode", installed: false, loggedIn: false, message: "OpenCode ist nicht installiert" },
    ]);
    expect(body.overrides).toEqual([
      { key: DM_KEY, engine: "claude", label: "Claude Code", conversationId: "dm", title: "Direktchat" },
      { key: TOPIC_KEY, engine: "codex", label: "Codex", conversationId: "topic-443", title: "Recherche" },
      { key: GONE_KEY, engine: "codex", label: "Codex", conversationId: null, title: null },
    ]);
  });

  test("Standard aus TYBO_ENGINE mit Quelle env; Verfügbarkeit nicht ermittelbar ergibt null", async () => {
    process.env.TYBO_ENGINE = "codex";
    const failing: EnginePort = { ...port(), availability: async () => Promise.reject(new Error("kaputt")) };
    const ctx = await server({ engines: failing });
    const body = await (await ctx.api("/api/engines")).json();
    expect(body.default).toEqual({ engine: "codex", source: "env" });
    expect(body.availability).toBeNull();
    expect(ctx.logs.some(l => l.includes("Verfügbarkeit nicht ermittelbar"))).toBe(true);
  });

  test("Schutz: ohne Anmeldung 401, falsche Methode 405, ohne Port 503", async () => {
    const ctx = await server();
    expect((await fetch(`${ctx.origin}/api/engines`, { headers: { origin: ctx.origin } })).status).toBe(401);
    expect((await ctx.api("/api/engines", "POST", {})).status).toBe(405);
    expect((await ctx.api("/api/engines/reset")).status).toBe(405);
    const bare = await topicServer(root, servers, null, {});
    expect((await bare.api("/api/engines")).status).toBe(503);
    expect((await bare.api("/api/engines/reset", "POST", { key: DM_KEY })).status).toBe(503);
  });
});

describe("Motor je Gespräch in GET /api/conversations", () => {
  test("Ausnahme sonst Standard, dazu der Standard; ohne Port keine Angaben", async () => {
    await writeFile(file, JSON.stringify({ engine: { default: "codex", topics: { [DM_KEY]: "claude" } } }));
    const ctx = await server();
    const web = await ctx.store.createConversation("research");
    const body = await (await ctx.api("/api/conversations")).json();
    expect(body.engine).toEqual({ default: "codex" });
    expect(body.telegram.dm.engine).toBe("claude");
    expect(body.telegram.topics.map((t: any) => [t.id, t.engine])).toEqual([
      ["topic-443", "codex"],
      ["topic-1", "codex"],
    ]);
    expect(body.conversations.find((c: any) => c.id === web.id).engine).toBe("codex");

    const bare = await topicServer(root, servers, null, { telegram });
    const plain = await (await bare.api("/api/conversations")).json();
    expect(plain.engine).toBeUndefined();
    expect(plain.telegram.dm.engine).toBeUndefined();
  });

  test("conversationEngines: Schlüssel wie beim Schreiben, unbekannte IDs bekommen den Standard", () => {
    const fake = {
      standard: () => ({ engine: "claude", source: "code" as const }),
      overrides: () => ({ [TOPIC_KEY]: "codex" }),
      sessionKey: (id: string) => (id === "topic-443" ? TOPIC_KEY : id === "kaputt" ? (() => { throw new Error("x"); })() : null),
    };
    expect(conversationEngines(fake, ["topic-443", "dm", "kaputt"])).toEqual({ "topic-443": "codex", dm: "claude", kaputt: "claude" });
  });
});

describe("POST /api/engines/reset („Auf Standard\")", () => {
  test("Akzeptanz: entfernt genau einen Eintrag, über den Session-Reset des Gesprächs wie /motor standard", async () => {
    await writeFile(
      file,
      JSON.stringify({ engine: { default: "claude", codex: { sandbox: "read-only" }, topics: { [TOPIC_KEY]: "codex", [DM_KEY]: "codex", [GONE_KEY]: "claude" } } })
    );
    const ctx = await server();
    const res = await ctx.api("/api/engines/reset", "POST", { key: TOPIC_KEY });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(await readJson()).toEqual({
      engine: { default: "claude", codex: { sandbox: "read-only" }, topics: { [DM_KEY]: "codex", [GONE_KEY]: "claude" } },
    });
    expect(ctx.calls).toEqual([{ id: "topic-443" }]);
    expect(body.overrides.map((o: any) => o.key)).toEqual([DM_KEY, GONE_KEY]);
    // Log ohne Schlüssel
    expect(ctx.logs.join("\n")).not.toContain(TOPIC_KEY);
  });

  test("Ausnahme einer anderen Gruppe: kann kein Gespräch der WebUI sein, direkt entfernt, ohne Session-Reset", async () => {
    const foreign = "topic:-1009999999999:5";
    await writeFile(file, JSON.stringify({ engine: { topics: { [foreign]: "codex" } } }));
    const ctx = await server();
    const res = await ctx.api("/api/engines/reset", "POST", { key: foreign });
    expect(res.status).toBe(200);
    expect(await readJson()).toEqual({});
    expect(ctx.calls).toEqual([]);
  });

  test("Topic der eigenen Gruppe, das nicht in der Liste steht: trotzdem über den Session-Reset", async () => {
    await writeFile(file, JSON.stringify({ engine: { topics: { [GONE_KEY]: "codex" } } }));
    const ctx = await server();
    const res = await ctx.api("/api/engines/reset", "POST", { key: GONE_KEY });
    expect(res.status).toBe(200);
    expect(await readJson()).toEqual({});
    expect(ctx.calls).toEqual([{ id: "topic-999" }]);
  });

  test("laufende Antwort im Gespräch: 409, nichts geändert", async () => {
    const before = JSON.stringify({ engine: { topics: { [DM_KEY]: "codex" } } });
    await writeFile(file, before);
    const ctx = await server({ reset: async () => ({ status: "busy" }) });
    const res = await ctx.api("/api/engines/reset", "POST", { key: DM_KEY });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("läuft gerade eine Antwort");
    expect(await readFile(file, "utf-8")).toBe(before);
  });

  test("Gesprächsliste nicht lesbar oder unvollständig: Session-Schutz bleibt, laufende Antwort ergibt 409", async () => {
    const failing: TelegramSource = { ...telegram, listConversations: async () => Promise.reject(new Error("offline")) };
    const partial: TelegramSource = { ...telegram, listConversations: async () => ({ dm: null, topics: [] }) };
    for (const source of [failing, partial]) {
      for (const key of [DM_KEY, TOPIC_KEY, `group:${GROUP}`]) {
        const before = JSON.stringify({ engine: { topics: { [key]: "codex" } } });
        await writeFile(file, before);
        const ids: string[] = [];
        const ctx = await server({
          telegram: source,
          reset: async id => {
            ids.push(id);
            return { status: "busy" };
          },
        });
        const res = await ctx.api("/api/engines/reset", "POST", { key });
        expect(res.status).toBe(409);
        expect(await readFile(file, "utf-8")).toBe(before);
        expect(ids).toEqual([key === DM_KEY ? "dm" : key === TOPIC_KEY ? "topic-443" : "topic-1"]);
      }
    }
  });

  test("Web-Gespräch, das nicht in der Liste steht: Session-Reset über den Schlüssel web:<id>", async () => {
    const key = "web:abc-123";
    await writeFile(file, JSON.stringify({ engine: { topics: { [key]: "codex" } } }));
    const ctx = await server();
    expect((await ctx.api("/api/engines/reset", "POST", { key })).status).toBe(200);
    expect(ctx.calls).toEqual([{ id: "abc-123" }]);
    expect(await readJson()).toEqual({});
  });

  test("Zuordnung nicht feststellbar (Schlüssel nicht bildbar): 503, nichts geändert", async () => {
    const before = JSON.stringify({ engine: { topics: { [DM_KEY]: "codex" } } });
    await writeFile(file, before);
    const broken: EnginePort = {
      ...port(),
      sessionKey: () => {
        throw new Error("kaputt");
      },
    };
    const ctx = await server({ engines: broken });
    const res = await ctx.api("/api/engines/reset", "POST", { key: DM_KEY });
    expect(res.status).toBe(503);
    expect(await readFile(file, "utf-8")).toBe(before);
    expect(ctx.calls).toEqual([]);
  });

  /**
   * Echte Kette wie in src/bot.ts: createBotEngines und der Session-Reset
   * bilden den Schlüssel über conversationSessionKey/resolveTelegramTarget;
   * im Gespräch läuft eine Antwort (isActive).
   */
  function realChain(keyDeps: { userId?: string; groupId: () => string | null; resetGroupId?: () => string | null }) {
    const touched: string[] = [];
    const engines = createBotEngines({ userId: keyDeps.userId, groupId: keyDeps.groupId, agentForTopic: () => "research", inspect });
    const reset = createConversationSessionReset<never>({
      sessionKey: id => conversationSessionKey(id, { userId: keyDeps.userId, groupId: keyDeps.resetGroupId ?? keyDeps.groupId, agentForTopic: () => "research" }),
      isActive: () => true,
      block: key => {
        touched.push(`block ${key}`);
        return () => {};
      },
      sessionsForKey: async () => [],
      shouldDistill: () => false,
      distill: async () => {},
      reset: async key => {
        touched.push(`reset ${key}`);
        return 0;
      },
      sessionModeEnabled: () => true,
      log: () => {},
    });
    return { engines, reset, touched };
  }

  test("Gruppenzuordnung null oder fehlschlagend (echte Schlüssel-Kette): 503, Datei bytegleich, laufende Antwort nicht umgangen", async () => {
    const failing = [
      { name: "null", groupId: () => null },
      {
        name: "wirft",
        groupId: (): string | null => {
          throw new Error("config/topics.json nicht lesbar");
        },
      },
    ];
    for (const { groupId } of failing) {
      for (const key of [TOPIC_KEY, `group:${GROUP}`]) {
        const before = JSON.stringify({ engine: { topics: { [key]: "codex", [DM_KEY]: "claude" } } });
        await writeFile(file, before);
        const chain = realChain({ userId: USER, groupId });
        const ctx = await server({ engines: chain.engines, reset: chain.reset });
        const res = await ctx.api("/api/engines/reset", "POST", { key });
        expect(res.status).toBe(503);
        expect((await res.json()).error).toBe(ENGINE_TEXT.unassignable);
        expect(await readFile(file, "utf-8")).toBe(before);
        expect(chain.touched).toEqual([]);
        expect(ctx.logs.join("\n")).not.toContain(key);
      }
    }
    // Direktchat ohne TELEGRAM_USER_ID: ebenso nicht zuzuordnen
    const before = JSON.stringify({ engine: { topics: { [DM_KEY]: "codex" } } });
    await writeFile(file, before);
    const chain = realChain({ userId: undefined, groupId: () => GROUP });
    const ctx = await server({ engines: chain.engines, reset: chain.reset });
    expect((await ctx.api("/api/engines/reset", "POST", { key: DM_KEY })).status).toBe(503);
    expect(await readFile(file, "utf-8")).toBe(before);
  });

  test("Session-Reset meldet unavailable (Gruppe fällt zwischendurch weg): 503, nichts geschrieben, laufende Antwort nicht umgangen", async () => {
    const before = JSON.stringify({ engine: { topics: { [TOPIC_KEY]: "codex" } } });
    await writeFile(file, before);
    // Zuordnung gelingt noch, beim Session-Reset ist die Gruppe nicht mehr lesbar
    const chain = realChain({ userId: USER, groupId: () => GROUP, resetGroupId: () => null });
    const ctx = await server({ engines: chain.engines, reset: chain.reset });
    const res = await ctx.api("/api/engines/reset", "POST", { key: TOPIC_KEY });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(ENGINE_TEXT.unassignable);
    expect(await readFile(file, "utf-8")).toBe(before);
    expect(chain.touched).toEqual([]);

    // Attrappe: unavailable ergibt nie ein Schreiben, auch wenn write mitgegeben wird
    await writeFile(file, before);
    let writeCalled = false;
    const ctx2 = await server({
      reset: async () => ({ status: "unavailable" }),
      engines: { ...port(), removeOverride: async () => ((writeCalled = true), true) },
    });
    expect((await ctx2.api("/api/engines/reset", "POST", { key: TOPIC_KEY })).status).toBe(503);
    expect(writeCalled).toBe(false);
    expect(await readFile(file, "utf-8")).toBe(before);
  });

  test("unbekannter Schlüssel 404 mit aktuellem Stand, ungültige Anfrage 400, ungültige Datei 409", async () => {
    await writeFile(file, JSON.stringify({ engine: { topics: { [DM_KEY]: "codex" } } }));
    const ctx = await server();
    let res = await ctx.api("/api/engines/reset", "POST", { key: TOPIC_KEY });
    expect(res.status).toBe(404);
    expect((await res.json()).overrides).toHaveLength(1);
    for (const body of ["{", JSON.stringify({ key: "x; rm -rf" }), JSON.stringify({ key: 7 }), JSON.stringify([])]) {
      expect((await ctx.api("/api/engines/reset", "POST", body)).status).toBe(400);
    }
    // Ausnahme gelesen, dann die Datei kaputt: nichts überschrieben
    const engines = port();
    const ctx2 = await server({ engines, noReset: true });
    expect(engines.overrides()).toEqual({ [DM_KEY]: "codex" });
    await writeFile(file, "{ kaputt");
    res = await ctx2.api("/api/engines/reset", "POST", { key: DM_KEY });
    expect(res.status).toBe(409);
    expect(await readFile(file, "utf-8")).toBe("{ kaputt");
  });

  test("gleichzeitig mit /motor: kein Eintrag geht verloren", async () => {
    await writeFile(file, JSON.stringify({ engine: { topics: { [GONE_KEY]: "codex" } } }));
    const ctx = await server();
    await Promise.all([ctx.api("/api/engines/reset", "POST", { key: GONE_KEY }), setTopicEngine(DM_KEY, "codex"), setTopicEngine(TOPIC_KEY, "claude")]);
    expect(await readJson()).toEqual({ engine: { topics: { [DM_KEY]: "codex", [TOPIC_KEY]: "claude" } } });
  });
});

describe("Web-Direktchat ohne Telegram: Schlüssel dm:web (Issue #227)", () => {
  const WEB_DM_KEY = "dm:web";
  const webPort = () => createBotEngines({ userId: "web", groupId: () => null, agentForTopic: () => "general", inspect });
  const webOnly: TelegramSource = {
    listConversations: async () => ({ dm: conv("dm", "Direktchat"), topics: [] }),
    groupChatId: () => null,
    getConversation: async () => null,
    history: async () => null,
  };

  test("Motor setzen, Einstellung neu laden, in der Übersicht dem Direktchat zugeordnet, Auf Standard entfernt ihn", async () => {
    const engines = webPort();
    expect(engines.sessionKey("dm")).toBe(WEB_DM_KEY);
    await setTopicEngine(WEB_DM_KEY, "codex");
    expect(await readJson()).toEqual({ engine: { topics: { [WEB_DM_KEY]: "codex" } } });
    // Neu laden: dieselbe Datei frisch eingelesen, der Schlüssel wird nicht verworfen
    setSettingsPath();
    setSettingsPath(file);
    expect(getSettings().engine?.topics).toEqual({ [WEB_DM_KEY]: "codex" });

    const ctx = await server({ engines, telegram: webOnly });
    const body = await (await ctx.api("/api/engines")).json();
    expect(body.overrides).toEqual([{ key: WEB_DM_KEY, engine: "codex", label: "Codex", conversationId: "dm", title: "Direktchat" }]);

    const res = await ctx.api("/api/engines/reset", "POST", { key: WEB_DM_KEY });
    expect(res.status).toBe(200);
    expect(ctx.calls).toEqual([{ id: "dm" }]);
    expect(await readJson()).toEqual({});
  });
});

describe("Live: SSE-Ereignis engine im Sammelstrom", () => {
  async function listen(ctx: { origin: string; cookie: string }) {
    const controller = new AbortController();
    const res = await fetch(`${ctx.origin}/api/telegram/events`, { headers: { cookie: ctx.cookie, origin: ctx.origin }, signal: controller.signal });
    expect(res.status).toBe(200);
    const events: { event: string; data: any }[] = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let connected = false;
    void (async () => {
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) break;
        connected = true;
        buffer += decoder.decode(value);
        let i: number;
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const event = /^event: (.+)$/m.exec(chunk)?.[1];
          const data = /^data: (.+)$/m.exec(chunk)?.[1];
          if (event && data) events.push({ event, data: JSON.parse(data) });
        }
      }
    })();
    cleanups.push(() => controller.abort());
    await waitUntil(() => connected);
    return events;
  }

  test("/motor aus jedem Kanal, Standard aus der Einstellungsseite und „Auf Standard\" melden engine ohne Inhalt", async () => {
    let tick: (() => void) | null = null;
    const ctx = await server({ engines: port({ interval: fn => (tick = fn) }) });
    const events = await listen(ctx);
    expect(tick).not.toBeNull();
    const engineEvents = () => events.filter(e => e.event === "engine");

    tick!();
    expect(engineEvents()).toHaveLength(0);
    // /motor codex (Telegram, Browser oder Terminal schreiben alle über setTopicEngine)
    await setTopicEngine(DM_KEY, "codex");
    tick!();
    await waitUntil(() => engineEvents().length === 1);
    expect(engineEvents()[0].data).toEqual({});
    // Standard auf der Einstellungsseite
    expect((await ctx.api("/api/settings", "PATCH", { engine: { default: "codex" } })).status).toBe(200);
    tick!();
    await waitUntil(() => engineEvents().length === 2);
    // „Auf Standard"
    await ctx.api("/api/engines/reset", "POST", { key: DM_KEY });
    tick!();
    await waitUntil(() => engineEvents().length === 3);
    // Ohne Änderung kein Ereignis
    tick!();
    await new Promise(r => setTimeout(r, 50));
    expect(engineEvents()).toHaveLength(3);
  });

  test("createBotEngines: Abgleich nur mit Zuhörern, Abmelden stoppt ihn", () => {
    let started = 0;
    let stopped = 0;
    const engines = createBotEngines({
      userId: USER,
      groupId: () => GROUP,
      agentForTopic: () => "general",
      inspect,
      setInterval: () => {
        started++;
        return 7;
      },
      clearInterval: h => {
        expect(h).toBe(7);
        stopped++;
      },
    });
    const off1 = engines.subscribe!(() => {});
    const off2 = engines.subscribe!(() => {});
    expect(started).toBe(1);
    off1();
    expect(stopped).toBe(0);
    off2();
    expect(stopped).toBe(1);
  });
});

describe("Verdrahtung (nur als Text bzw. mit Attrappen)", () => {
  const repo = join(import.meta.dir, "..");

  test("startWebUi reicht engines an createServer weiter", async () => {
    const { startWebUi } = await import("../src/web/startup");
    const engines = port();
    let received: any = null;
    await startWebUi({
      env: { WEB_ENABLED: "true", WEB_PASSWORD: "test-passwort-lang" },
      chat: { runTurn: async () => ({ text: "" }), stop() {} },
      engines,
      createServer: async (_config, deps) => {
        received = deps;
        return { url: "http://127.0.0.1:3100", eventStreamCount: () => 0, stop: async () => {} } as unknown as WebServer;
      },
      log: () => {},
      lanAddresses: () => [],
    });
    expect(received.engines).toBe(engines);
  });

  test("src/bot.ts übergibt createBotEngines mit denselben Schlüssel-Angaben wie der Session-Reset", async () => {
    const bot = await Bun.file(join(repo, "src", "bot.ts")).text();
    expect(bot).toContain('import { createBotEngines } from "./web/bot-engines";');
    const call = bot.slice(bot.indexOf("webServer = await startWebUi({"));
    const args = call.slice(0, call.indexOf("\n});"));
    expect(args).toContain("engines: createBotEngines({");
    const engines = args.slice(args.indexOf("engines: createBotEngines({"));
    // Direktchat ohne Telegram: "web" (Issue #227)
    expect(engines).toContain("userId: dmChatId(process.env),");
    expect(engines).toContain("groupId: () => botGroupId(process.env),");
    expect(engines).toContain("agentForTopic: (topicId, chatId) => getAgentByTopicId(topicId, chatId),");
  });

  test("web:dev und Demo nutzen die Motor-Attrappe, nie bot-engines oder die echte Prüfung", async () => {
    const dev = await Bun.file(join(repo, "scripts", "web-dev.ts")).text();
    expect(dev).toContain("engines: createDemoEngines(demoAgents.settings),");
    const demo = await Bun.file(join(repo, "src", "web", "demo.ts")).text();
    for (const src of [dev, demo]) {
      const imports = [...src.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map(m => m[1]);
      for (const path of imports) expect(/bot-engines|lib\/engines/.test(path)).toBe(false);
    }
  });
});
