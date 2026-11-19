/** Issue #674: dieselben reinen Textfunktionen wie im Browser. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { OPENROUTER_KEY_TEXT } from "../src/web/openrouter-key";

const source = await readFile(new URL("../src/web/public/settings.js", import.meta.url), "utf8");
const browser = new Function(`${source}\nreturn { openRouterKeyText, OPENROUTER_KEY_ERRORS, OPENROUTER_KEY_LABEL, OPENROUTER_KEY_NOTE };`)();
const NOW = Date.parse("2026-11-18T12:00:00Z");
const reading = { configured: true, limit: 50, remaining: 12.4, limitReset: null, usage: 37.6, usageMonthly: 3.2,
  fetchedAt: new Date(NOW - 180_000).toISOString() };

test("Überschrift und Hinweis nennen genau den Schlüssel der Ersatzmodelle", () => {
  expect(browser.OPENROUTER_KEY_LABEL).toBe("OpenRouter (Schlüssel der Ersatzmodelle)");
  expect(browser.OPENROUTER_KEY_NOTE).toBe("OpenCode nutzt seine eigene Anmeldung. Das kann ein anderer Schlüssel sein als dieser.");
});
test("mit Limit: Dollar, Komma, zwei Nachkommastellen, Alter wie die Motoren", () => {
  expect(browser.openRouterKeyText(reading, NOW)).toBe("12,40 $ von 50,00 $ übrig · vor 3 Minuten");
  expect(browser.openRouterKeyText({ ...reading, fetchedAt: new Date(NOW).toISOString() }, NOW)).toBe("12,40 $ von 50,00 $ übrig · gerade eben");
  expect(browser.openRouterKeyText({ ...reading, fetchedAt: new Date(NOW - 60_000).toISOString() }, NOW)).toContain("vor 1 Minute");
});
test.each([["daily", "täglich"], ["weekly", "wöchentlich"], ["monthly", "monatlich"]])("Erneuerung %s", (reset, text) => {
  expect(browser.openRouterKeyText({ ...reading, limitReset: reset }, NOW)).toBe(`12,40 $ von 50,00 $ übrig · Limit erneuert sich ${text} · vor 3 Minuten`);
});
test("ohne Limit nur Monatsverbrauch, keine Aussage zum Kontoguthaben", () => {
  expect(browser.openRouterKeyText({ ...reading, limit: null, remaining: null }, NOW)).toBe("kein Limit am Schlüssel, in diesem Monat 3,20 $ verbraucht · vor 3 Minuten");
});
test("unbekannte Erneuerung wird nicht angezeigt", () => {
  for (const limitReset of [null, "yearly", "constructor", "TESTWERT-674-BROWSER"]) {
    expect(browser.openRouterKeyText({ ...reading, limitReset }, NOW)).toBe("12,40 $ von 50,00 $ übrig · vor 3 Minuten");
  }
});
test("überzogener Schlüssel und Limit null oder null Dollar bleiben unterscheidbar", () => {
  expect(browser.openRouterKeyText({ ...reading, remaining: -0.5 }, NOW)).toBe("0,00 $ von 50,00 $ übrig · vor 3 Minuten");
  expect(browser.openRouterKeyText({ ...reading, remaining: 0, limit: 0 }, NOW)).toBe("0,00 $ von 0,00 $ übrig · vor 3 Minuten");
});
test("Fehler nur mit den festen Texten, keine rohe Meldung und kein erfundenes Alter", () => {
  expect(browser.OPENROUTER_KEY_ERRORS).toEqual(OPENROUTER_KEY_TEXT);
  for (const error of Object.values(OPENROUTER_KEY_TEXT)) {
    expect(browser.openRouterKeyText({ configured: true, error }, NOW)).toBe(error);
  }
  expect(browser.openRouterKeyText({ configured: true, error: "TESTWERT-674-BROWSER" }, NOW)).toBe(OPENROUTER_KEY_TEXT.unavailable);
});
test("configured false und noch nicht geladen: keine Zeile", () => {
  for (const data of [null, undefined, { configured: false }, { configured: false, error: "egal" }]) {
    expect(browser.openRouterKeyText(data, NOW)).toBeNull();
  }
});
test("unvollständige Anzeige bricht das Zeichnen des Motorabschnitts nicht ab", () => {
  for (const data of [{ configured: true }, { ...reading, limit: "50" }, { ...reading, remaining: null }, { ...reading, fetchedAt: "kaputt" }]) {
    expect(browser.openRouterKeyText(data, NOW)).toBe(OPENROUTER_KEY_TEXT.unavailable);
  }
});
