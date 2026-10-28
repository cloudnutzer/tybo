/**
 * Issue #52, statische Prüfung: Modelltext geht nur über abgesicherte Wege an
 * Telegram (Link-Vorschau aus, Text bereinigt). src/bot.ts und src/app/ werden
 * nur als Quelltext gelesen, nie importiert. Dass die Sende-Helfer der Laufzeit die
 * Vorschau selbst abschalten, zeigt seit Issue #328 ein Verhaltenstest. Dass
 * Laufzeit und Agenten-Identitäten denselben abgesicherten Haupt-Bot nutzen
 * und an Agenten-Bots weiterleiten, prüfen seit Issue #330 Verhaltenstests
 * („Telegram-Laufzeit und Agenten-Identitäten“).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "fs";
import { Glob } from "bun";
import { join, relative } from "path";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { AgentIdentities } from "../src/channels/telegram/identities";
import { createTelegramRuntime } from "../src/lib/telegram-runtime";
import { isolateAgentCatalog } from "./catalog-fixture";

// Die Agenten-Identitäten lesen den Katalog (Issue #330): nie die echte config/agents.json
isolateAgentCatalog();

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/**
 * Direkte Bot-API-Aufrufe per fetch ohne guardTelegramPayload, mit Grund.
 * Jede neue Stelle muss den Guard nutzen oder hier begründet stehen.
 */
const DIRECT_FETCH_EXCEPTIONS: Record<string, string> = {
  "src/lib/tools/elevenlabs-tts.ts": "sendVoice ohne text und caption, nur Audio",
};

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const pattern of ["src/**/*.ts", "scripts/**/*.ts"]) {
    for (const f of new Glob(pattern).scanSync({ cwd: ROOT })) {
      files.push(relative(ROOT, join(ROOT, f)));
    }
  }
  return files.sort();
}

/** Bot-API-Methoden, die Text oder Captions senden oder bearbeiten */
const SEND_URL = /api\.telegram\.org\/bot\$\{[^}]+\}\/(?:send\w+|edit\w+|copyMessage|\$\{)/;

describe("Verdrahtung des Bots und src/lib/telegram-runtime.ts (nur Quelltext)", () => {
  // Issue #344: die Verdrahtung steht in src/bot.ts und src/app/; Bot, Guard und Sende-Helfer
  // leben in der Telegram-Laufzeit (Issue #228)
  const wiring = ["src/bot.ts", ...new Glob("src/app/*.ts").scanSync({ cwd: ROOT })].map(f => ({ file: f, source: read(f) }));
  const runtime = read("src/lib/telegram-runtime.ts");

  test("genau ein Bot (in der Laufzeit), Guard direkt danach installiert", () => {
    for (const { file, source } of wiring) {
      expect({ file, newBot: /new Bot\(/.test(source), identities: /new AgentIdentities\(/.test(source) }).toEqual({ file, newBot: false, identities: false });
    }
    expect(runtime.match(/new Bot\(/g) ?? []).toHaveLength(1);
    const created = runtime.indexOf("const bot = createBot(");
    expect(created).toBeGreaterThan(-1);
    const afterCreation = runtime.slice(created, created + 400);
    expect(afterCreation).toContain("installTelegramOutputGuard(bot.api);");
    // Guard vor der ersten Sendung und vor den Agenten-Identitäten: Verhaltenstests unten.
    // Die Handler hängen erst beim Start am Bot: der Kanal ist ein Composer ohne Bot (tests/telegram-channel.test.ts)
  });

  test("keine eigene Api, kein direkter fetch an Sende-Methoden", () => {
    for (const source of [runtime, ...wiring.map(w => w.source)]) {
      expect(source).not.toMatch(/new Api\(/);
      expect(source).not.toMatch(SEND_URL);
    }
  });

  test("alle Api-Aufrufe laufen über den abgesicherten Bot oder ctx", () => {
    for (const source of [runtime, ...wiring.map(w => w.source)]) {
      for (const m of source.matchAll(/(\w+)\.api\.(send\w+|edit\w+|copyMessage)\(/g)) {
        expect(["bot", "ctx"]).toContain(m[1]);
      }
    }
  });
});

describe("alle Versandmodule", () => {
  const files = sourceFiles();

  test("findet die bekannten Module", () => {
    for (const f of ["src/bot.ts", "src/lib/telegram-runtime.ts", "src/lib/telegram.ts", "src/channels/telegram/send.ts", "src/lib/outbox.ts", "src/channels/telegram/identities.ts"]) {
      expect(files).toContain(f);
    }
  });

  test("jeder neue Bot bekommt den Guard", () => {
    for (const f of files) {
      const source = read(f);
      if (!/new Bot\(/.test(source)) continue;
      expect({ file: f, guarded: source.includes("installTelegramOutputGuard(") }).toEqual({ file: f, guarded: true });
    }
  });

  test("direkter fetch an Sende-Methoden nur mit guardTelegramPayload oder begründeter Ausnahme", () => {
    const direct: string[] = [];
    for (const f of files) {
      const source = read(f);
      if (!SEND_URL.test(source)) continue;
      direct.push(f);
      if (DIRECT_FETCH_EXCEPTIONS[f]) continue;
      expect({ file: f, guarded: source.includes("guardTelegramPayload(") }).toEqual({ file: f, guarded: true });
    }
    // Jede einzelne Sende-URL: in ihrer Funktion läuft die Nutzlast durch guardTelegramPayload
    for (const f of direct) {
      if (DIRECT_FETCH_EXCEPTIONS[f]) continue;
      const source = read(f);
      for (const m of source.matchAll(new RegExp(SEND_URL.source, "g"))) {
        const fnStart = Math.max(source.lastIndexOf("\nasync function ", m.index), source.lastIndexOf("\nfunction ", m.index), source.lastIndexOf("\nexport ", m.index));
        const fnEnd = source.indexOf("\n}\n", m.index);
        const body = source.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
        expect({ file: f, at: m.index, guarded: body.includes("guardTelegramPayload(") }).toEqual({ file: f, at: m.index, guarded: true });
      }
    }
    // Die Ausnahmen gibt es noch; sonst Liste bereinigen
    for (const f of Object.keys(DIRECT_FETCH_EXCEPTIONS)) expect(direct).toContain(f);
  });

  test("jede Datei, die selbst einen Bot anlegt, installiert den Guard (Issue #352: ohne Gateway nur Laufzeit und Identitäten)", () => {
    const creators = sourceFiles().filter(f => /new Bot\(/.test(read(f)));
    expect(creators).toEqual(["src/channels/telegram/identities.ts", "src/lib/telegram-runtime.ts"]);
    for (const f of creators) expect({ file: f, guard: read(f).includes("installTelegramOutputGuard(") }).toEqual({ file: f, guard: true });
    // Verhalten: Tests „Telegram-Laufzeit und Agenten-Identitäten“
  });
});

describe("Sende-Helfer der Laufzeit setzen die Vorschau selbst (Issue #328)", () => {
  const ME = { id: 42, is_bot: true, first_name: "Test", username: "haupt_bot" } as UserFromGetMe;
  const LONG = Array.from({ length: 3 }, (_, i) => `Absatz ${i} ` + "wort ".repeat(900)).join("\n\n");

  /** Laufzeit, deren Bot den Output-Guard nicht annimmt: die Attrappe sieht die Nutzlast der Helfer selbst */
  function unguardedRuntime(failHtml: boolean) {
    const payloads: Record<string, any>[] = [];
    const runtime = createTelegramRuntime({
      env: { TELEGRAM_BOT_TOKEN: "123456789:AAFakeTokenForTestsOnly_abcdefghijklmn", TELEGRAM_USER_ID: "424242" },
      createBot: token => {
        const bot = new Bot(token, { botInfo: ME });
        bot.api.config.use(async (_prev, method, payload) => {
          const p = payload as Record<string, any>;
          if (method === "sendMessage") payloads.push(p);
          if (failHtml && p.parse_mode === "HTML") throw new Error("Bad Request: can't parse entities");
          return { ok: true, result: { message_id: payloads.length, date: 0, chat: { id: 1, type: "private" } } } as any;
        });
        // Danach installierte Transformer (der Output-Guard) greifen nicht
        bot.api.config.use = () => {};
        return bot;
      },
      createAgentBots: bot => new AgentIdentities(bot, { env: {} }),
      log: () => {},
    });
    return { runtime, payloads };
  }

  for (const failHtml of [false, true]) {
    test(`sendMessage und sendStatus: jedes Stück ohne Vorschau${failHtml ? ", auch im Klartext-Rückfall" : ""}`, async () => {
      const quiet = [spyOn(console, "error").mockImplementation(() => {}), spyOn(console, "warn").mockImplementation(() => {})];
      try {
        const { runtime, payloads } = unguardedRuntime(failHtml);
        await runtime.sendMessage("424242", LONG, 5);
        await runtime.sendStatus("424242", LONG, 5, { inline_keyboard: [[{ text: "Ja", callback_data: "y" }]] });
        // Beide Helfer teilen den langen Text in mehrere Stücke
        expect(payloads.length).toBeGreaterThanOrEqual(failHtml ? 12 : 6);
        for (const p of payloads) expect(p.link_preview_options).toEqual({ is_disabled: true });
        if (failHtml) expect(payloads.filter(p => p.parse_mode === undefined)).toHaveLength(payloads.length / 2);
      } finally {
        for (const q of quiet) q.mockRestore();
      }
    });
  }
});

describe("Telegram-Laufzeit und Agenten-Identitäten (Verhalten, Issue #330)", () => {
  const MAIN_TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghijklmn";
  const RESEARCH_TOKEN = "987654321:AAFakeAgentTokenForTests_zyxwvutsrqpon";
  const USER = "424242";
  let fetchSpy: ReturnType<typeof spyOn>;
  let quiet: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new Error("Netz im Test verboten"); }) as any);
    quiet = [spyOn(console, "log").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {})];
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    for (const q of quiet) q.mockRestore();
  });

  /**
   * Laufzeit mit der Standard-Verdrahtung der Agenten-Identitäten. Die Fabrik
   * baut echte grammY-Bots; jede Api zeichnet auf, was nach dem Output-Guard
   * ankommt. Agenten-Bots dürfen nie pollen.
   */
  function realRuntime(env: Record<string, string> = {}) {
    const sent: { token: string; method: string; payload: Record<string, any> }[] = [];
    const bots: Bot[] = [];
    const runtime = createTelegramRuntime({
      env: { TELEGRAM_BOT_TOKEN: MAIN_TOKEN, TELEGRAM_USER_ID: USER, ...env },
      createBot: token => {
        const username = token === MAIN_TOKEN ? "haupt_bot" : "research_agent_bot";
        const bot = new Bot(token, { botInfo: { id: bots.length + 1, is_bot: true, first_name: username, username } as UserFromGetMe });
        bot.api.config.use(async (_prev, method, payload) => {
          sent.push({ token, method, payload: { ...(payload as Record<string, any>) } });
          return { ok: true, result: method === "sendChatAction" ? true : { message_id: sent.length, date: 0, chat: { id: 1, type: "private" } } } as any;
        });
        if (token !== MAIN_TOKEN) bot.start = async () => { throw new Error("Agenten-Bots pollen nie"); };
        bots.push(bot);
        return bot;
      },
      log: () => {},
    });
    return { runtime, sent, bots };
  }

  test("gleicher Haupt-Bot: ohne Agenten-Token senden Laufzeit und Identitäten über denselben Bot", async () => {
    const { runtime, sent, bots } = realRuntime();
    await runtime.initialize();
    expect(bots).toHaveLength(1);
    expect(runtime.bot).toBe(bots[0]);
    await runtime.sendPlain(USER, "von der Laufzeit");
    await runtime.agents.sendAsAgent("research", USER, "vom Agenten", { threadId: 4 });
    await runtime.agents.sendAsAgent("general", USER, "von General");
    expect(sent.map(s => [s.token, s.method, s.payload.text])).toEqual([
      [MAIN_TOKEN, "sendMessage", "von der Laufzeit"],
      [MAIN_TOKEN, "sendMessage", "vom Agenten"],
      [MAIN_TOKEN, "sendMessage", "von General"],
    ]);
    expect(sent[1].payload.message_thread_id).toBe(4);
  });

  test("Guard vor der ersten Sendung: schon der erste Aufruf am Haupt-Bot ist abgesichert", async () => {
    const { runtime, sent } = realRuntime();
    // Erster Aufruf überhaupt, direkt an der Api und ohne eigene Optionen
    await runtime.bot!.api.sendMessage(USER, "siehe https://example.org");
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.link_preview_options).toEqual({ is_disabled: true });
    // Auch der erste Agenten-Versand über den Haupt-Bot
    await runtime.agents.sendAsAgent("content", USER, "mehr unter https://example.org");
    expect(sent[1]).toMatchObject({ token: MAIN_TOKEN, method: "sendMessage" });
    expect(sent[1].payload.link_preview_options).toEqual({ is_disabled: true });
  });

  test("Weiterleitung an Agenten-Bots: gleiche Fabrik, nur angemeldet, abgesichert", async () => {
    const { runtime, sent, bots } = realRuntime({ TELEGRAM_BOT_TOKEN_RESEARCH: RESEARCH_TOKEN });
    expect(bots).toHaveLength(1);
    await runtime.initialize();
    expect(bots).toHaveLength(2);
    expect(bots[1].token).toBe(RESEARCH_TOKEN);
    await runtime.agents.sendAsAgent("research", USER, "**Quelle**: https://example.org", { threadId: 2 });
    await runtime.agents.sendTypingAsAgent("research", USER, 2);
    await runtime.agents.sendAsAgent("finance", USER, "Zahlen");
    expect(sent.map(s => [s.token, s.method])).toEqual([
      [RESEARCH_TOKEN, "sendMessage"],
      [RESEARCH_TOKEN, "sendChatAction"],
      [MAIN_TOKEN, "sendMessage"],
    ]);
    expect(sent[0].payload).toMatchObject({ parse_mode: "HTML", message_thread_id: 2, link_preview_options: { is_disabled: true } });
    expect(runtime.agents.agentForMention("@research_agent_bot such")).toEqual({ agent: "research", cleanedText: "such" });
    // Auch direkte Aufrufe am Agenten-Bot laufen durch den Guard
    await bots[1].api.sendMessage(USER, "https://example.org");
    expect(sent.at(-1)!.payload.link_preview_options).toEqual({ is_disabled: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
