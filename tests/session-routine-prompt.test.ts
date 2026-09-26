/**
 * Issue #46, Aufgabe 8: Die /routine-Vorlage schickt Telegram-Meldungen
 * neuer Watcher über bun run notify statt über direkte REST-Calls.
 */
import { expect, test } from "bun:test";
import { buildRoutinePrompt } from "../src/lib/session-routine";

const prompt = buildRoutinePrompt("jeden Morgen um 9");

test("nennt bun run notify --source watcher für Telegram-Meldungen", () => {
  expect(prompt).toContain("bun run notify --source watcher");
  expect(prompt).toContain("--file <pfad>");
  expect(prompt).toContain("nie per direktem REST-Call an die Bot-API");
});

test("keine Anweisung mehr, selbst mit TELEGRAM_BOT_TOKEN an Telegram zu senden", () => {
  expect(prompt).not.toContain("Telegram-Meldung ueber TELEGRAM_BOT_TOKEN");
  expect(prompt).not.toContain("Vorlage: src/");
});

test("Watcher-Name nur als allgemeines Namensbeispiel, keine privaten Watcher", () => {
  expect(prompt).toContain("src/preis-watch.ts (nur ein Namensbeispiel, keine vorhandene Datei)");
});

test("Hinweis des Users bleibt im Prompt", () => {
  expect(prompt).toContain('"jeden Morgen um 9"');
});
