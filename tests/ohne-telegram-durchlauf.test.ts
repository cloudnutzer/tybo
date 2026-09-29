/**
 * Issue #228, Checkbox 5: Durchlauf ohne Telegram von der Einrichtung bis zum
 * ersten Gespräch, isoliert statt am echten Rechner (Arbeitsregeln: src/bot.ts
 * wird weder gestartet noch importiert, kein Neustart-Marker, kein launchctl).
 *
 * 1. Temporäres Projekt ohne .env, `tybo setup` im Terminal mit simulierten
 *    Eingaben: Telegram übersprungen, WebUI eingerichtet, Ende „fertig“.
 *    Anbieter, Claude und PM2 sind Attrappen (tests/setup-fixture.ts).
 * 2. Die geschriebene .env ergibt chooseStartMode = normal.
 * 3. createTelegramRuntime auf dieser .env ruft die Bot-Fabrik nie auf.
 * 4. Eine WebUI mit Attrappen-Chat (wie scripts/web-dev.ts) auf der
 *    Konfiguration aus der .env, ohne Telegram-Quelle und ohne Topics: der
 *    Terminal-API-Client legt mit /neu ein Web-Gespräch an und bekommt auf
 *    eine Nachricht eine Antwort.
 * Während des ganzen Durchlaufs geht kein Aufruf an api.telegram.org.
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bot } from "grammy";
import { parseEnvContent } from "../src/lib/env-file";
import { createTelegramRuntime } from "../src/lib/telegram-runtime";
import { chooseStartMode } from "../src/setup/start-mode";
import { ApiClient, type ConversationSummary } from "../src/terminal/api";
import { CommandRunner } from "../src/terminal/command-runner";
import { parseInput } from "../src/terminal/commands";
import { createStyle } from "../src/terminal/render";
import { loadWebConfig } from "../src/web/config";
import { createFakeChat } from "../src/web/fake-chat";
import { createWebServer, type WebServer } from "../src/web/server";
import { cleanup, FAKE } from "./setup-fixture";
import { linuxCtx, runWith, scripted } from "./setup-terminal-fixture";

afterAll(cleanup);

const WEB_ONLY_RUN = [
  "", // Auswahl: nur offene Schritte
  "n", // Telegram: Jetzt einrichten? nein
  "j", // WebUI (kommt als nächster Schritt): Jetzt einrichten?
  "j", // einschalten
  FAKE.webPassword,
  "1", // Nur dieser Rechner
  "", // Port Standard
  "", // Speichern
  "4", // Datenbank: Convex
  FAKE.convexUrl,
  FAKE.convexToken,
  "j",
  "n", // Semantische Suche
  "Testperson",
  "Europe/Berlin",
  "",
  "",
  "n", // Modelle
  "n", // Zugang vom Handy (Issue #231)
  "j", // Autostart (PM2-Attrappe)
];

let fetchSpy: ReturnType<typeof spyOn>;
let telegramCalls: string[] = [];
const servers: WebServer[] = [];

beforeEach(() => {
  telegramCalls = [];
  const original = globalThis.fetch;
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("api.telegram.org")) {
      telegramCalls.push(url);
      return Promise.reject(new Error("Telegram im Test verboten"));
    }
    return original(input, init);
  }) as typeof fetch);
});
afterEach(async () => {
  fetchSpy.mockRestore();
  for (const s of servers.splice(0)) await s.stop();
});

describe("Durchlauf ohne Telegram", () => {
  test("Einrichtung bis fertig, normaler Start ohne Bot, WebUI antwortet, /neu legt ein Web-Gespräch an", async () => {
    // 1. Einrichtung im Terminal
    const ctx = await linuxCtx();
    const prompter = scripted(WEB_ONLY_RUN);
    const setup = await runWith({ mode: "all" }, ctx, prompter);
    expect(setup.code).toBe(0);
    expect(prompter.left()).toBe(0);
    expect(setup.out).toContain("Alle Pflichtschritte sind erledigt.");
    expect(setup.out).toContain("Öffne die WebUI unter http://127.0.0.1:3100.");
    expect(setup.out).not.toContain("Noch offen");
    const env = parseEnvContent(await readFile(ctx.envPath, "utf8"));
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.TELEGRAM_USER_ID).toBeUndefined();

    // 2. Startbedingung
    expect(chooseStartMode(env)).toEqual({ mode: "normal" });

    // 3. Telegram-Laufzeit: keine Fabrik, kein Bot, onReady einmal
    const created: string[] = [];
    const logs: string[] = [];
    const runtime = createTelegramRuntime({
      env,
      createBot: token => {
        created.push(token);
        throw new Error("darf nicht gebaut werden");
      },
      log: line => logs.push(line),
    });
    let ready = 0;
    await runtime.initialize();
    await runtime.start(() => { ready++; });
    expect(created).toEqual([]);
    expect(runtime.bot).toBeNull();
    expect(runtime.topicApi).toBeUndefined();
    expect(ready).toBe(1);
    expect(logs).toContain("Telegram nicht eingerichtet: nur WebUI");

    // 4. WebUI mit Attrappen-Chat auf der Konfiguration aus der .env (Port frei statt 3100)
    const web = loadWebConfig(env);
    expect(web.status).toBe("ok");
    if (web.status !== "ok") return;
    const dataDir = join(ctx.root, "data");
    await mkdir(dataDir, { recursive: true });
    const tokenFile = join(dataDir, "cli-token");
    const server = await createWebServer(
      { ...web.config, port: 0 },
      {
        sessionFile: join(dataDir, "web-sessions.json"),
        cliTokenFile: tokenFile,
        dataDir: join(dataDir, "web"),
        chat: createFakeChat({ delayMs: 5, stepMs: 5 }),
        // Wie bot.ts ohne Telegram: keine Topic-API, also keine Topic-Verwaltung (topics fehlt)
        log: () => {},
      },
    );
    servers.push(server);
    const client = new ApiClient({ base: server.url, getToken: async () => (await readFile(tokenFile, "utf8")).trim() });
    expect(await client.me()).toBe(true);

    // Topic-Rechte ohne Telegram: keine Gruppe
    const rights = await client.request("GET", "/api/telegram/rights");
    expect(await rights.json()).toEqual({ manageTopics: false, deleteMessages: false, group: false });

    // /neu im Terminal: Web-Gespräch mit Agent und Titel
    let current: ConversationSummary = { id: "dm", title: "Direktchat", agent: "general", kind: "dm" };
    const notes: string[] = [];
    const errors: string[] = [];
    const runner = new CommandRunner({
      client,
      style: createStyle(false),
      current: () => current,
      switchTo: async (c, note) => {
        current = c;
        if (note) notes.push(note);
      },
      updateCurrent: c => { current = c; },
      info: () => {},
      error: t => errors.push(t),
      quit: () => {},
    });
    const parsed = parseInput("/neu research Mein Titel");
    if (parsed.kind !== "command") throw new Error("kein Befehl");
    expect(await runner.run(parsed.command)).toBe(true);
    expect(errors).toEqual([]);
    expect(current).toMatchObject({ kind: "web", title: "Mein Titel", agent: "research" });
    expect(notes).toEqual(["Neues Gespräch mit Research."]);

    // Nachricht im Web-Gespräch, die Attrappe antwortet
    const sent = await client.send(current.id, "Hallo, bist du da?");
    expect(sent.status).toBe("accepted");
    let reply: string | undefined;
    for (let i = 0; i < 100 && !reply; i++) {
      await Bun.sleep(20);
      const page = await client.messages(current.id);
      reply = page.messages.find(m => m.role === "assistant")?.text;
    }
    expect(reply).toContain("Antwort der Attrappe");

    expect(telegramCalls).toEqual([]);
  });
});
