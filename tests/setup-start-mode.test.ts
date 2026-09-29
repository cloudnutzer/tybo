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
const WEB = { WEB_ENABLED: "true", WEB_PASSWORD: FAKE.webPassword };

describe("chooseStartMode", () => {
  test("beide Telegram-Werte vorhanden: normaler Start", () => {
    expect(chooseStartMode(FULL)).toEqual({ mode: "normal" });
  });

  test("fehlendes Token: Einrichtungsmodus statt Exit (halbes Telegram)", () => {
    expect(chooseStartMode({ TELEGRAM_USER_ID: FAKE.userId })).toEqual({
      mode: "setup",
      reason: "missing",
      missing: ["TELEGRAM_BOT_TOKEN"],
      message: "Telegram halb eingerichtet: TELEGRAM_USER_ID ist gesetzt, TELEGRAM_BOT_TOKEN fehlt. Beide Werte setzen oder beide entfernen.",
    });
  });

  test("fehlende Nutzer-ID: ebenfalls Einrichtungsmodus", () => {
    expect(chooseStartMode({ TELEGRAM_BOT_TOKEN: FAKE.token })).toEqual({
      mode: "setup",
      reason: "missing",
      missing: ["TELEGRAM_USER_ID"],
      message: "Telegram halb eingerichtet: TELEGRAM_BOT_TOKEN ist gesetzt, TELEGRAM_USER_ID fehlt. Beide Werte setzen oder beide entfernen.",
    });
  });

  test("leere .env: beide fehlen, Kanal-Satz", () => {
    expect(chooseStartMode({})).toEqual({
      mode: "setup",
      reason: "missing",
      missing: [...REQUIRED_START_KEYS],
      message: "Richte Telegram oder die WebUI ein, sonst erreicht dich tybo nirgends.",
    });
  });

  test("Issue #228: nur WebUI, ohne Telegram: normaler Start", () => {
    expect(chooseStartMode(WEB)).toEqual({ mode: "normal" });
    expect(chooseStartMode({ ...WEB, TELEGRAM_BOT_TOKEN: "your_bot_token_here", TELEGRAM_USER_ID: "" })).toEqual({ mode: "normal" });
  });

  test("Issue #228: halbes Telegram mit gültiger WebUI: Einrichtungsmodus", () => {
    const mode = chooseStartMode({ ...WEB, TELEGRAM_BOT_TOKEN: FAKE.token });
    expect(mode.mode).toBe("setup");
    expect((mode as any).message).toStartWith("Telegram halb eingerichtet: ");
    const invalid = chooseStartMode({ ...WEB, ...FULL, TELEGRAM_USER_ID: "alex" });
    expect((invalid as any).message).toContain("TELEGRAM_USER_ID ist keine Zahl");
  });

  test("Issue #228: WebUI ungültig ohne Telegram: Einrichtungsmodus mit dem Grund; mit Telegram normal", () => {
    const mode = chooseStartMode({ WEB_ENABLED: "true", WEB_PASSWORD: "kurz" });
    expect(mode.mode).toBe("setup");
    expect((mode as any).message).toContain("WEB_PASSWORD ist kürzer als 12 Zeichen");
    expect(chooseStartMode({ ...FULL, WEB_ENABLED: "true", WEB_PASSWORD: "kurz" })).toEqual({ mode: "normal" });
    expect(chooseStartMode({ ...FULL, WEB_ENABLED: "false" })).toEqual({ mode: "normal" });
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
  test("wählt den Modus vor jeder Bot-Initialisierung; kein FATAL-Abbruch mehr (Issue #228)", async () => {
    const bot = await Bun.file(join(repo, "src", "bot.ts")).text();
    expect(bot).toContain('import { chooseStartMode } from "./setup/start-mode";');
    const choose = bot.indexOf("const startMode = chooseStartMode(process.env);");
    const run = bot.indexOf('const { runSetupMode } = await import("./setup/web-mode");');
    expect(choose).toBeGreaterThan(bot.indexOf("await loadEnv("));
    expect(run).toBeGreaterThan(choose);
    // Ohne Telegram startet der Bot mit der WebUI allein: kein exit(1) je Schlüssel
    expect(bot).not.toContain("FATAL: TELEGRAM_BOT_TOKEN");
    expect(bot).not.toContain("FATAL: TELEGRAM_USER_ID");
    for (const later of ["createTelegramRuntime({ env: process.env })", "acquireLock())", "startWebUi({"]) {
      expect(bot.indexOf(later)).toBeGreaterThan(run);
    }
    // Der Einrichtungsmodus endet mit process.exit, der Bot-Teil läuft danach nie
    expect(bot).toContain("process.exit(await runSetupMode({ root: PROJECT_ROOT, env: process.env, startMode, supervisor: () => detectSupervisor() }));");
  });
});
