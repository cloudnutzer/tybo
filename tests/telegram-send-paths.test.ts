/**
 * Issue #52, statische Prüfung: Modelltext geht nur über abgesicherte Wege an
 * Telegram (Link-Vorschau aus, Text bereinigt). src/bot.ts wird nur als
 * Quelltext gelesen, nie importiert.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { Glob } from "bun";
import { join, relative } from "path";

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** Außerhalb des Umfangs (Issue #52): VPS-Gateway mit eigenem Bot */
const OUT_OF_SCOPE = new Set(["src/vps-gateway.ts"]);

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
      const rel = relative(ROOT, join(ROOT, f));
      if (!OUT_OF_SCOPE.has(rel)) files.push(rel);
    }
  }
  return files.sort();
}

/** Bot-API-Methoden, die Text oder Captions senden oder bearbeiten */
const SEND_URL = /api\.telegram\.org\/bot\$\{[^}]+\}\/(?:send\w+|edit\w+|copyMessage|\$\{)/;

describe("src/bot.ts und src/lib/telegram-runtime.ts (nur Quelltext)", () => {
  const source = read("src/bot.ts");
  // Issue #228: Bot, Guard und Sende-Helfer leben in der Telegram-Laufzeit
  const runtime = read("src/lib/telegram-runtime.ts");

  test("genau ein Bot (in der Laufzeit), Guard direkt danach installiert", () => {
    expect(source).not.toMatch(/new Bot\(/);
    expect(source).not.toMatch(/\bbot\.api\./);
    expect(runtime.match(/new Bot\(/g) ?? []).toHaveLength(1);
    const created = runtime.indexOf("const bot = createBot(");
    expect(created).toBeGreaterThan(-1);
    const afterCreation = runtime.slice(created, created + 400);
    expect(afterCreation).toContain("installTelegramOutputGuard(bot.api);");
    // Der Guard steht vor jeder Sendung und vor den Agenten-Bots
    const guardAt = runtime.indexOf("installTelegramOutputGuard(bot.api);");
    for (const use of ["bot.api.", "new BotRegistry("]) {
      const first = runtime.indexOf(use, created + 1);
      expect({ use, afterGuard: first === -1 || first > guardAt }).toEqual({ use, afterGuard: true });
    }
    // Die Handler hängen erst beim Start am Bot
    expect(source.indexOf("telegramRuntime.bot?.use(telegramHandlers);")).toBeGreaterThan(source.indexOf("createTelegramRuntime({ env: process.env })"));
  });

  test("keine eigene Api, kein direkter fetch an Sende-Methoden", () => {
    for (const file of [source, runtime]) {
      expect(file).not.toMatch(/new Api\(/);
      expect(file).not.toMatch(SEND_URL);
    }
    // Erlaubt sind nur Datei-Downloads und getFile
    for (const m of source.matchAll(/api\.telegram\.org\/([^`"'\s]*)/g)) {
      expect(m[1]).toMatch(/^(file\/bot|bot\$\{BOT_TOKEN\}\/getFile)/);
    }
  });

  test("alle Api-Aufrufe laufen über den abgesicherten Bot oder ctx", () => {
    for (const file of [source, runtime]) {
      for (const m of file.matchAll(/(\w+)\.api\.(send\w+|edit\w+|copyMessage)\(/g)) {
        expect(["bot", "ctx"]).toContain(m[1]);
      }
    }
  });

  test("Sende-Helfer setzen die Vorschau selbst", () => {
    for (const fn of ["async sendMessage(", "async sendStatus("]) {
      const start = runtime.indexOf(fn);
      expect(start).toBeGreaterThan(-1);
      const body = runtime.slice(start, runtime.indexOf("\n    },\n", start));
      expect(body).toContain("link_preview_options: NO_LINK_PREVIEW");
    }
    expect(source).toContain("return telegramRuntime.sendMessage(chatId, text, threadId);");
    expect(source).toContain("return telegramRuntime.sendStatus(chatId, text, threadId, keyboard);");
  });

  test("Agenten-Antworten über BotRegistry mit demselben Bot", () => {
    expect(runtime).toContain("new BotRegistry(b, { env: e, createBot: factory })");
    expect(source).toContain("const botRegistry = telegramRuntime.agents;");
  });
});

describe("alle Versandmodule", () => {
  const files = sourceFiles();

  test("findet die bekannten Module", () => {
    for (const f of ["src/bot.ts", "src/lib/telegram-runtime.ts", "src/lib/telegram.ts", "src/lib/outbox.ts", "src/lib/bot-registry.ts", "src/feedback.ts"]) {
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

  test("Module, die einen fremden Bot bekommen und selbst senden, installieren den Guard", () => {
    // installTelegramToolApproval sendet Werkzeugargumente des Modells
    expect(read("src/lib/telegram-tool-approval.ts")).toContain("installTelegramOutputGuard(bot.api)");
    expect(read("src/lib/bot-registry.ts")).toContain("installTelegramOutputGuard(primaryBot.api)");
    expect(read("src/lib/bot-registry.ts")).toContain("installTelegramOutputGuard(agentBot.api)");
  });
});
