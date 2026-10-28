/**
 * Issue #228, umgestellt in Issue #372: tybo pruefen mit der Kanalregel.
 * Statt verifyChannels aus setup/verify.ts prüfen die Zeile „Kanal“ des
 * Berichts, der Schritt Datenbank und die Spezialprüfungen Telegram und
 * Datenbank (src/setup/checks/). Ohne Telegram, aber mit WebUI, kein Fehler
 * und keine Anfrage an Telegram, auch nicht für übrig gebliebene
 * Agenten-Tokens. Halbes Telegram und kein Kanal sind Fehler. Anbieter sind
 * Attrappen aus setup-fixture, kein Netz.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { collectReport, reportExitCode } from "../src/setup/checks/report";
import { databaseCheck, telegramCheck } from "../src/setup/checks/specials";
import { databaseStep } from "../src/setup/steps/database";
import { cleanup, FAKE, leakedSecrets, makeCtx } from "./setup-fixture";

afterAll(cleanup);

const WEB = { WEB_ENABLED: "true", WEB_PASSWORD: FAKE.webPassword };
const TELEGRAM = { TELEGRAM_BOT_TOKEN: FAKE.token, TELEGRAM_USER_ID: FAKE.userId };
const AGENT = "987654321:AAFakeAgentTokenForTests_zyxwvutsrqpon";
const DB = { SUPABASE_URL: FAKE.supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: FAKE.serviceKey };

const envText = (env: Record<string, string>) => Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join("");

async function run(env: Record<string, string>) {
  const ctx = await makeCtx({ env: envText(env), overrides: { fetch: async () => Response.json([]) } });
  const report = await collectReport({ ctx, steps: [databaseStep], specials: [telegramCheck, databaseCheck] });
  const telegramCalls = ctx.providers.calls.filter(c => c.method.startsWith("telegram"));
  const line = (section: string, label: string) => report.lines.find(l => l.section === section && l.label === label);
  return { report, telegramCalls, line, failed: report.lines.filter(l => l.status === "fail") };
}

describe("Kanalregel im Prüfbericht", () => {
  test("WebUI ohne Telegram: keine Fehler, Telegram übersprungen, kein getMe", async () => {
    const r = await run({ ...WEB, ...DB });
    expect(r.failed).toEqual([]);
    expect(r.telegramCalls).toEqual([]);
    expect(r.line("Einrichtung", "Kanal")).toMatchObject({ status: "pass", detail: "WebUI eingerichtet, Telegram nicht." });
    expect(r.line("Telegram", "Verbindung")).toMatchObject({ status: "skip", detail: "Übersprungen: Telegram ist nicht eingerichtet" });
  });

  test("übrig gebliebene Agenten-Tokens ohne Telegram: übersprungen, kein getMe", async () => {
    const r = await run({ ...WEB, ...DB, TELEGRAM_BOT_TOKEN_RESEARCH: AGENT, TELEGRAM_BOT_TOKEN_CRITIC: AGENT });
    expect(r.failed).toEqual([]);
    expect(r.telegramCalls).toEqual([]);
    expect(r.report.lines.filter(l => l.section === "Telegram").map(l => [l.label, l.status])).toEqual([["Verbindung", "skip"]]);
  });

  test("halbes Telegram (auch mit WebUI): Kanal-Fehler mit dem Grund, kein getMe, Exit 1", async () => {
    const r = await run({ ...WEB, ...DB, TELEGRAM_BOT_TOKEN: FAKE.token });
    expect(r.failed.map(l => l.label)).toEqual(["Kanal"]);
    expect(r.failed[0].detail).toBe("Telegram halb eingerichtet: TELEGRAM_BOT_TOKEN ist gesetzt, TELEGRAM_USER_ID fehlt. Beide Werte setzen oder beide entfernen.");
    expect(r.telegramCalls).toEqual([]);
    expect(reportExitCode(r.report)).toBe(1);
  });

  test("kein Kanal: Fehler mit dem Kanal-Satz", async () => {
    const r = await run({ ...DB });
    expect(r.failed.map(l => l.label)).toEqual(["Kanal"]);
    expect(r.failed[0].detail).toBe("Richte Telegram oder die WebUI ein, sonst erreicht dich tybo nirgends.");
  });

  test("WebUI ungültig ohne Telegram: Fehler mit Grund aus loadWebConfig", async () => {
    const r = await run({ ...DB, WEB_ENABLED: "true", WEB_PASSWORD: "kurz" });
    expect(r.failed.map(l => l.label)).toEqual(["Kanal"]);
    expect(r.failed[0].detail).toContain("WEB_PASSWORD ist kürzer als 12 Zeichen");
  });

  test("mit Telegram: getMe für Haupt- und Agenten-Bot, je einmal, kein Token im Bericht", async () => {
    const r = await run({ ...TELEGRAM, ...DB, TELEGRAM_BOT_TOKEN_RESEARCH: AGENT });
    expect(r.failed).toEqual([]);
    expect(r.telegramCalls.map(c => [c.method, c.args[0]])).toEqual([
      ["telegramGetMe", FAKE.token],
      ["telegramGetMe", AGENT],
    ]);
    expect(r.line("Telegram", "Verbindung")?.status).toBe("pass");
    expect(r.line("Telegram", "Agenten-Bot research")?.status).toBe("pass");
    expect(leakedSecrets(r.report)).toEqual([]);
    expect(JSON.stringify(r.report)).not.toContain(AGENT);
  });

  test("Datenbank: nur Supabase zählt, alte CONVEX_URL ist Warnung, kein Ersatz (Issue #324)", async () => {
    const legacy = { CONVEX_URL: FAKE.legacyDbUrl, CONVEX_AUTH_TOKEN: FAKE.legacyDbToken };
    type Run = Awaited<ReturnType<typeof run>>;
    const step = (r: Run) => r.report.lines.find(l => l.section === "Einrichtung" && l.label === databaseStep.title);
    const old = (r: Run) => r.line("Datenbank", "Alte Einstellung");

    // ohne Supabase: Pflichtschritt Datenbank fehlt, auch mit CONVEX_URL; keine Verbindungsprüfung
    const without = await run({ ...WEB });
    const legacyOnly = await run({ ...WEB, ...legacy });
    for (const r of [without, legacyOnly]) {
      expect(r.failed.map(l => l.label)).toEqual([databaseStep.title]);
      expect(step(r)?.detail).not.toMatch(/convex/i);
      expect(r.line("Datenbank", "Verbindung")?.status).toBe("skip");
      expect(r.line("Datenbank", "Verbindung")?.detail).toContain("setup datenbank");
    }
    expect(old(without)).toBeUndefined();
    expect(old(legacyOnly)?.status).toBe("warn");
    // Der Bericht kürzt auf 300 Zeichen, der Hinweis auf den Umzug bleibt drin
    expect(old(legacyOnly)?.detail).toContain("Umzug nach Supabase: tybo setup");

    // mit Supabase: bestanden, mit und ohne CONVEX_URL
    const supabase = await run({ ...WEB, ...DB });
    const both = await run({ ...WEB, ...DB, ...legacy });
    for (const r of [supabase, both]) {
      expect(r.failed).toEqual([]);
      expect(step(r)?.status).toBe("pass");
      expect(r.line("Datenbank", "Verbindung")?.status).toBe("pass");
    }
    expect(old(supabase)).toBeUndefined();
    expect(old(both)?.status).toBe("warn");

    for (const r of [legacyOnly, both]) {
      expect(JSON.stringify(r.report)).not.toContain(FAKE.legacyDbUrl);
      expect(JSON.stringify(r.report)).not.toContain(FAKE.legacyDbToken);
    }
  });
});
