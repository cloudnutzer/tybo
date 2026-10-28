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

/**
 * Issue #286, Checkbox 4: Plists aus /routine rufen den Wrapper, und jedes
 * Script folgt der Regel „keine alten Daten" (Entscheidung 0025).
 */
test("Zeitplan: Plist ruft den Wrapper mit --id ai.tybo.<name> und Trennzeichen", () => {
  expect(prompt).toContain("src/routine-run.ts");
  expect(prompt).toContain("<bun> --no-env-file src/routine-run.ts --id ai.tybo.<name> -- <bun> run src/<name>.ts");
  expect(prompt).toContain("die --id ist genau das Label der Plist");
  expect(prompt).toContain("das -- trennt den Wrapper vom eigentlichen Befehl");
  expect(prompt).toContain("Plist-Muster in docs/routinen.md");
  expect(prompt).not.toContain("nach dem Muster der bestehenden Watcher");
});

test("Regel „keine alten Daten“: fehlende oder veraltete Quelldaten, Exit-Code 1", () => {
  expect(prompt).toContain(
    "Fehlen die Quelldaten oder sind sie älter als erwartet, schreibe eine Zeile, was fehlt, und beende das Skript mit Exit-Code 1. Nie mit alten oder zwischengespeicherten Daten weitermachen."
  );
});

test("Regel und Wrapper stehen auch ohne Hinweis im Auftrag", () => {
  const bare = buildRoutinePrompt("");
  expect(bare).toContain("src/routine-run.ts --id ai.tybo.<name> --");
  expect(bare).toContain("Exit-Code 1");
});
