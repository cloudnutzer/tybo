/**
 * Issue #228, Checkbox 1: eine Kanalprüfung für Start, Einrichtung und
 * setup:verify (src/setup/channels.ts). Mindestens ein Kanal, Telegram oder
 * WebUI; halbes Telegram ist nie bereit, auch nicht mit gültiger WebUI.
 */

import { describe, expect, test } from "bun:test";
import { checkChannels, NO_CHANNEL_MESSAGE, webLocalUrl } from "../src/setup/channels";
import { FAKE } from "./setup-fixture";

const TELEGRAM = { TELEGRAM_BOT_TOKEN: FAKE.token, TELEGRAM_USER_ID: FAKE.userId };
const WEB = { WEB_ENABLED: "true", WEB_PASSWORD: FAKE.webPassword };

describe("checkChannels", () => {
  test("nur Telegram: bereit, WebUI aus", () => {
    const c = checkChannels(TELEGRAM);
    expect(c.telegram.state).toBe("ok");
    expect(c.webui.state).toBe("aus");
    expect(c.ready).toBe(true);
  });

  test("nur WebUI: bereit, Telegram fehlt", () => {
    const c = checkChannels(WEB);
    expect(c.telegram.state).toBe("fehlt");
    expect(c.webui.state).toBe("ok");
    expect(c.ready).toBe(true);
  });

  test("beides: bereit", () => {
    const c = checkChannels({ ...TELEGRAM, ...WEB });
    expect([c.telegram.state, c.webui.state, c.ready]).toEqual(["ok", "ok", true]);
  });

  test("nichts: nicht bereit, mit dem Kanal-Satz", () => {
    const c = checkChannels({});
    expect([c.telegram.state, c.webui.state, c.ready]).toEqual(["fehlt", "aus", false]);
    expect(c.message).toBe(NO_CHANNEL_MESSAGE);
    expect(c.message).toBe("Richte Telegram oder die WebUI ein, sonst erreicht dich tybo nirgends.");
  });

  test("Token ohne Nutzer-ID: halb, nicht bereit", () => {
    const c = checkChannels({ TELEGRAM_BOT_TOKEN: FAKE.token });
    expect(c.telegram.state).toBe("halb");
    expect(c.telegram.reason).toContain("TELEGRAM_USER_ID fehlt");
    expect(c.ready).toBe(false);
    expect(c.message).toBe(`Telegram halb eingerichtet: ${c.telegram.reason}. Beide Werte setzen oder beide entfernen.`);
  });

  test("Nutzer-ID ohne Token: halb, nicht bereit", () => {
    const c = checkChannels({ TELEGRAM_USER_ID: FAKE.userId });
    expect(c.telegram.state).toBe("halb");
    expect(c.telegram.reason).toContain("TELEGRAM_BOT_TOKEN fehlt");
    expect(c.ready).toBe(false);
  });

  test("Platzhalter statt Token zählt als fehlend: mit Nutzer-ID halb, beide Platzhalter fehlt", () => {
    expect(checkChannels({ TELEGRAM_BOT_TOKEN: "your_bot_token_here", TELEGRAM_USER_ID: FAKE.userId }).telegram.state).toBe("halb");
    const both = checkChannels({ TELEGRAM_BOT_TOKEN: "your_bot_token_here", TELEGRAM_USER_ID: "your_user_id_here", ...WEB });
    expect(both.telegram.state).toBe("fehlt");
    expect(both.ready).toBe(true);
  });

  test("ungültige Nutzer-ID (keine Zahl): halb", () => {
    const c = checkChannels({ TELEGRAM_BOT_TOKEN: FAKE.token, TELEGRAM_USER_ID: "@alex" });
    expect(c.telegram.state).toBe("halb");
    expect(c.telegram.reason).toBe("TELEGRAM_USER_ID ist keine Zahl");
    expect(c.ready).toBe(false);
  });

  test("halbes Telegram mit gültiger WebUI: nicht bereit", () => {
    for (const env of [
      { TELEGRAM_BOT_TOKEN: FAKE.token, ...WEB },
      { TELEGRAM_USER_ID: FAKE.userId, ...WEB },
      { TELEGRAM_BOT_TOKEN: FAKE.token, TELEGRAM_USER_ID: "abc", ...WEB },
    ]) {
      const c = checkChannels(env);
      expect(c.webui.state).toBe("ok");
      expect(c.ready).toBe(false);
      expect(c.message).toStartWith("Telegram halb eingerichtet: ");
    }
  });

  const invalidWeb: [string, Record<string, string>, string][] = [
    ["Passwort fehlt", { WEB_ENABLED: "true" }, "WEB_PASSWORD fehlt"],
    ["Passwort zu kurz", { WEB_ENABLED: "true", WEB_PASSWORD: "kurz" }, "kürzer als 12 Zeichen"],
    ["Port ungültig", { ...WEB, WEB_PORT: "70000" }, "WEB_PORT ist kein gültiger Port"],
    ["halbe Access-Werte", { ...WEB, WEB_ACCESS_TEAM: "meinteam" }, "WEB_ACCESS_TEAM und WEB_ACCESS_AUD gehören zusammen"],
    ["WEB_PUBLIC_ORIGIN", { ...WEB, WEB_PUBLIC_ORIGIN: "http://app.example.com" }, "WEB_PUBLIC_ORIGIN muss eine https-Adresse"],
  ];

  for (const [name, env, reason] of invalidWeb) {
    test(`WebUI ungültig (${name}): ohne Telegram nicht bereit mit Grund, mit Telegram bereit`, () => {
      const alone = checkChannels(env);
      expect(alone.webui.state).toBe("ungültig");
      expect(alone.webui.reason).toContain(reason);
      expect(alone.ready).toBe(false);
      expect(alone.message).toContain(reason);
      const withTelegram = checkChannels({ ...env, ...TELEGRAM });
      expect(withTelegram.ready).toBe(true);
      expect(withTelegram.webui.state).toBe("ungültig");
    });
  }
});

describe("webLocalUrl", () => {
  test("Host und Port aus der Konfiguration, IPv6 in Klammern", () => {
    expect(webLocalUrl(WEB)).toBe("http://127.0.0.1:3100");
    expect(webLocalUrl({ ...WEB, WEB_HOST: "0.0.0.0", WEB_PORT: "3177" })).toBe("http://127.0.0.1:3177");
    expect(webLocalUrl({ ...WEB, WEB_HOST: "::", WEB_PORT: "3177" })).toBe("http://127.0.0.1:3177");
    expect(webLocalUrl({ ...WEB, WEB_HOST: "192.168.1.20", WEB_PORT: "3177" })).toBe("http://192.168.1.20:3177");
    expect(webLocalUrl({ ...WEB, WEB_HOST: "::1", WEB_PORT: "3178" })).toBe("http://[::1]:3178");
    expect(webLocalUrl({ WEB_ENABLED: "false" })).toBeNull();
  });
});
