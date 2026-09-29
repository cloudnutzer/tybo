/**
 * Issue #228, Checkbox 3: setup:verify mit der Kanalregel. Env und fetch sind
 * übergeben (verifyChannels); ohne Telegram, aber mit WebUI, kein Fehler und
 * kein Aufruf an api.telegram.org, auch nicht für übrig gebliebene
 * Agenten-Tokens. Halbes Telegram und kein Kanal sind Fehler.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { verifyChannels, type CheckResult } from "../setup/verify";
import { FAKE } from "./setup-fixture";

const WEB = { WEB_ENABLED: "true", WEB_PASSWORD: FAKE.webPassword };
const TELEGRAM = { TELEGRAM_BOT_TOKEN: FAKE.token, TELEGRAM_USER_ID: FAKE.userId };
const AGENT = "987654321:AAFakeAgentTokenForTests_zyxwvutsrqpon";
const DB = { CONVEX_URL: FAKE.convexUrl };

let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => { logSpy = spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => logSpy.mockRestore());

async function run(env: Record<string, string>) {
  const results: CheckResult[] = [];
  const urls: string[] = [];
  const fetchFn = async (url: string) => {
    urls.push(url);
    return Response.json({ ok: true, result: { username: "test_bot", id: 1 } });
  };
  await verifyChannels(env, fetchFn, (name, status, message) => results.push({ name, status, message }));
  return { results, urls, failed: results.filter(r => r.status === "fail") };
}

describe("verifyChannels", () => {
  test("WebUI ohne Telegram: keine Fehler, Telegram und getMe übersprungen", async () => {
    const r = await run({ ...WEB, ...DB });
    expect(r.failed).toEqual([]);
    expect(r.urls).toEqual([]);
    expect(r.results.find(x => x.name === "Channels")).toEqual({ name: "Channels", status: "pass", message: "WebUI eingerichtet, Telegram nicht." });
    expect(r.results.find(x => x.name === "Telegram")?.status).toBe("skip");
    expect(r.results.find(x => x.name === "Telegram API")).toEqual({ name: "Telegram API", status: "skip", message: "Übersprungen: Telegram ist nicht eingerichtet" });
  });

  test("übrig gebliebene Agenten-Tokens ohne Telegram: übersprungen, kein getMe", async () => {
    const r = await run({ ...WEB, ...DB, TELEGRAM_BOT_TOKEN_RESEARCH: AGENT, TELEGRAM_BOT_TOKEN_CRITIC: AGENT });
    expect(r.failed).toEqual([]);
    expect(r.urls).toEqual([]);
    expect(r.results.find(x => x.name === "Research agent bot")?.status).toBe("skip");
    expect(r.results.find(x => x.name === "Critic agent bot")?.message).toBe("Übersprungen: Telegram ist nicht eingerichtet");
  });

  test("halbes Telegram (auch mit WebUI): Fehler mit dem Grund, kein getMe", async () => {
    const r = await run({ ...WEB, ...DB, TELEGRAM_BOT_TOKEN: FAKE.token });
    expect(r.failed.map(x => x.name)).toEqual(["Channels", "Telegram"]);
    expect(r.failed[0].message).toBe("Telegram halb eingerichtet: TELEGRAM_BOT_TOKEN ist gesetzt, TELEGRAM_USER_ID fehlt. Beide Werte setzen oder beide entfernen.");
    expect(r.urls).toEqual([]);
  });

  test("kein Kanal: Fehler mit dem Kanal-Satz", async () => {
    const r = await run({ ...DB });
    expect(r.failed.map(x => x.name)).toEqual(["Channels"]);
    expect(r.failed[0].message).toBe("Richte Telegram oder die WebUI ein, sonst erreicht dich tybo nirgends.");
  });

  test("WebUI ungültig ohne Telegram: Fehler mit Grund aus loadWebConfig", async () => {
    const r = await run({ ...DB, WEB_ENABLED: "true", WEB_PASSWORD: "kurz" });
    expect(r.failed.map(x => x.name)).toEqual(["Channels", "WebUI"]);
    expect(r.failed[1].message).toContain("WEB_PASSWORD ist kürzer als 12 Zeichen");
  });

  test("mit Telegram wie bisher: getMe für Haupt- und Agenten-Bot", async () => {
    const r = await run({ ...TELEGRAM, ...DB, TELEGRAM_BOT_TOKEN_RESEARCH: AGENT });
    expect(r.failed).toEqual([]);
    expect(r.urls).toEqual([`https://api.telegram.org/bot${FAKE.token}/getMe`, `https://api.telegram.org/bot${AGENT}/getMe`]);
    expect(r.results.find(x => x.name === "Telegram API")?.status).toBe("pass");
    expect(r.results.find(x => x.name === "Research agent bot")?.status).toBe("pass");
    // Kein Wert in den Meldungen außer gekürzt
    expect(JSON.stringify(r.results)).not.toContain(FAKE.token);
  });
});
