/**
 * Issue #66, Checkbox 1: Moduswahl beim Start. Fehlt ein Telegram-Pflichtwert
 * (auch nur TELEGRAM_USER_ID) oder steht dort noch der Platzhalter, startet
 * der Einrichtungsmodus statt „FATAL“; `tybo setup --web` erzwingt ihn.
 * src/bot.ts wird nur als Text geprüft, nie importiert oder gestartet.
 */

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { chooseStartMode, missingStartKeys, REQUIRED_START_KEYS } from "../src/setup/start-mode";
import { parseSetupArgs } from "../src/setup/terminal";
import { FAKE } from "./setup-fixture";

const repo = resolve(import.meta.dir, "..");
const FULL = { TELEGRAM_BOT_TOKEN: FAKE.token, TELEGRAM_USER_ID: FAKE.userId };

describe("chooseStartMode", () => {
  test("beide Telegram-Werte vorhanden: normaler Start", () => {
    expect(chooseStartMode(FULL)).toEqual({ mode: "normal" });
  });

  test("fehlendes Token: Einrichtungsmodus statt Exit", () => {
    expect(chooseStartMode({ TELEGRAM_USER_ID: FAKE.userId })).toEqual({
      mode: "setup",
      reason: "missing",
      missing: ["TELEGRAM_BOT_TOKEN"],
    });
  });

  test("fehlende Nutzer-ID: ebenfalls Einrichtungsmodus", () => {
    expect(chooseStartMode({ TELEGRAM_BOT_TOKEN: FAKE.token })).toEqual({
      mode: "setup",
      reason: "missing",
      missing: ["TELEGRAM_USER_ID"],
    });
  });

  test("leere .env: beide fehlen", () => {
    expect(chooseStartMode({})).toEqual({ mode: "setup", reason: "missing", missing: [...REQUIRED_START_KEYS] });
  });

  test("leere Werte und Platzhalter aus .env.example zählen als fehlend", () => {
    expect(missingStartKeys({ TELEGRAM_BOT_TOKEN: "  ", TELEGRAM_USER_ID: "" })).toEqual([...REQUIRED_START_KEYS]);
    expect(missingStartKeys({ TELEGRAM_BOT_TOKEN: "your_bot_token_here", TELEGRAM_USER_ID: "your_user_id_here" })).toEqual([
      ...REQUIRED_START_KEYS,
    ]);
  });

  test("--web erzwingt den Einrichtungsmodus auch bei vollständiger .env", () => {
    expect(chooseStartMode(FULL, { forceSetup: true })).toEqual({ mode: "setup", reason: "forced", missing: [] });
    expect(chooseStartMode({}, { forceSetup: true })).toEqual({ mode: "setup", reason: "forced", missing: [...REQUIRED_START_KEYS] });
  });

  test("tybo setup --web wird erkannt, --web mit weiteren Argumenten nicht", () => {
    expect(parseSetupArgs(["--web"])).toEqual({ mode: "web" });
    expect(parseSetupArgs(["--web", "telegram"])).toBeNull();
  });
});

describe("src/bot.ts (nur als Text)", () => {
  test("wählt den Modus vor jeder Bot-Initialisierung und vor den FATAL-Prüfungen", async () => {
    const bot = await Bun.file(join(repo, "src", "bot.ts")).text();
    expect(bot).toContain('import { chooseStartMode } from "./setup/start-mode";');
    const choose = bot.indexOf("const startMode = chooseStartMode(process.env);");
    const run = bot.indexOf('const { runSetupMode } = await import("./setup/web-mode");');
    expect(choose).toBeGreaterThan(bot.indexOf("await loadEnv("));
    expect(run).toBeGreaterThan(choose);
    for (const later of ["FATAL: TELEGRAM_BOT_TOKEN", "FATAL: TELEGRAM_USER_ID", "new Bot(BOT_TOKEN)", "acquireLock())", "startWebUi({"]) {
      expect(bot.indexOf(later)).toBeGreaterThan(run);
    }
    // Der Einrichtungsmodus endet mit process.exit, der Bot-Teil läuft danach nie
    expect(bot).toContain("process.exit(await runSetupMode({ root: PROJECT_ROOT, env: process.env, startMode, supervisor: () => detectSupervisor() }));");
  });
});
