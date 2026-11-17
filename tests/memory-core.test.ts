/**
 * Issue #522: Ablage des Kerns und Trennung von Entwurf und Bestätigung. Alle
 * Daten sind erfunden.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptCoreDraft,
  CORE_MAX_CHARS,
  coreBackupFile,
  coreDraftFile,
  coreFile,
  coreFingerprint,
  coreForPrompt,
  deleteCore,
  dropCoreDraft,
  fitCore,
  normalizeCore,
  readCore,
  setCore,
  storeCoreDraft,
} from "../src/lib/memory/core";

describe("Kern: Ablage", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tybo-kern-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const place = (text: string) => {
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(coreFile(root), text);
  };

  test("ohne Datei kein Kern und kein Fehler", async () => {
    expect(await readCore(root)).toEqual({ ok: true, text: "" });
    expect(await coreForPrompt(root)).toBe("");
  });

  test("Lesefehler ist nicht dasselbe wie kein Kern, der Prompt läuft ohne Abschnitt weiter", async () => {
    mkdirSync(coreFile(root), { recursive: true });
    const log = spyOn(console, "log").mockImplementation(() => {});
    expect(await readCore(root)).toEqual({ ok: false });
    expect(await coreForPrompt(root)).toBe("");
    expect(log.mock.calls.flat().join("")).toContain("nicht lesbar");
    log.mockRestore();
  });

  test("Kommentare der Vorlage zählen nicht, nur Kommentare sind kein Kern", async () => {
    expect(normalizeCore("<!-- Hinweis -->\n\n## Wer\r\n- Alex\n<!-- Ende -->\n")).toBe("## Wer\n- Alex");
    place("<!-- nur ein Hinweis -->\n");
    expect(await coreForPrompt(root)).toBe("");
    expect(await deleteCore(root)).toBe("none");
    expect(existsSync(coreFile(root))).toBe(true);
  });

  test("die Vorlage trägt nur Platzhalter", () => {
    const template = readFileSync(join(import.meta.dir, "..", "config", "kern.example.md"), "utf-8");
    expect(normalizeCore(template).length).toBeLessThan(CORE_MAX_CHARS);
    for (const line of normalizeCore(template).split("\n")) expect(line === "" || line.startsWith("## ") || /^- \[.+\]$/.test(line)).toBe(true);
  });

  test("Text aus der Datei wirkt ohne Neustart: jeder Aufruf liest neu", async () => {
    place("Alex");
    expect(await coreForPrompt(root)).toBe("Alex");
    place("Mia");
    expect(await coreForPrompt(root)).toBe("Mia");
  });

  test("von Hand zu lang: der Prompt nimmt ganze Zeilen bis zur Grenze, die Datei bleibt", async () => {
    const line = `- ${"x".repeat(98)}`;
    const long = Array.from({ length: 30 }, () => line).join("\n");
    place(long);
    const log = spyOn(console, "log").mockImplementation(() => {});
    const inPrompt = await coreForPrompt(root);
    log.mockRestore();
    expect(inPrompt.length).toBeLessThanOrEqual(CORE_MAX_CHARS);
    expect(inPrompt.split("\n").every(l => l === line)).toBe(true);
    expect(readFileSync(coreFile(root), "utf-8")).toBe(long);
  });

  test("fitCore schneidet eine einzelne lange Zeile hart, ohne ein Zeichenpaar zu zerreißen", () => {
    expect(fitCore("abc", 5)).toBe("abc");
    expect(fitCore("abcdefgh", 5)).toBe("abcde");
    expect(fitCore("abcd😀fg", 5)).toBe("abcd");
  });

  test("setzen: legt an, sichert den alten Stand, lehnt zu langen und leeren Text ab", async () => {
    expect(await setCore("  Alex  ", root)).toBe("saved");
    expect(readFileSync(coreFile(root), "utf-8")).toBe("Alex\n");
    expect(existsSync(coreBackupFile(root))).toBe(false);

    expect(await setCore("Alex", root)).toBe("unchanged");
    expect(await setCore("Mia", root)).toBe("saved");
    expect(readFileSync(coreBackupFile(root), "utf-8")).toBe("Alex\n");

    expect(await setCore("x".repeat(CORE_MAX_CHARS + 1), root)).toBe("too_long");
    expect(await setCore("<!-- nichts -->", root)).toBe("empty");
    expect((await readCore(root) as { text: string }).text).toBe("Mia");
    expect(await setCore("x".repeat(CORE_MAX_CHARS), root)).toBe("saved");
  });

  test("setzen und löschen ändern nichts, wenn der Kern nicht lesbar ist", async () => {
    mkdirSync(coreFile(root), { recursive: true });
    expect(await setCore("Alex", root)).toBe("unreadable");
    expect(await deleteCore(root)).toBe("unreadable");
  });

  test("löschen: Datei weg, letzte Fassung gesichert; danach ist nichts mehr da", async () => {
    await setCore("Alex", root);
    expect(await deleteCore(root)).toBe("deleted");
    expect(existsSync(coreFile(root))).toBe(false);
    expect(readFileSync(coreBackupFile(root), "utf-8")).toBe("Alex\n");
    expect(await deleteCore(root)).toBe("none");
  });

  test("gleichzeitiges Setzen hinterlässt einen der Texte ganz und keine Reste", async () => {
    await Promise.all(["Alex", "Mia", "Sam", "Kim"].map(name => setCore(name, root)));
    expect(["Alex", "Mia", "Sam", "Kim"]).toContain((await readCore(root) as { text: string }).text);
    expect(existsSync(`${coreFile(root)}.lock`)).toBe(false);
  });
});

describe("Kern: Entwurf", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tybo-kern-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("Entwurf wirkt nicht: weder Prompt noch Kern-Datei, liegt unter data/", async () => {
    const draft = await storeCoreDraft("Alex mag Tee", coreFingerprint(""), root);
    expect(await coreForPrompt(root)).toBe("");
    expect(existsSync(coreFile(root))).toBe(false);
    expect(coreDraftFile(root)).toBe(join(root, "data", "kern-entwurf.json"));
    expect(JSON.parse(readFileSync(coreDraftFile(root), "utf-8")).id).toBe(draft.id);
  });

  test("übernehmen schreibt genau den Text und räumt den Entwurf weg", async () => {
    const draft = await storeCoreDraft("Alex mag Tee", coreFingerprint(""), root);
    expect(await adoptCoreDraft(draft.id, root)).toBe("adopted");
    expect(await coreForPrompt(root)).toBe("Alex mag Tee");
    expect(existsSync(coreDraftFile(root))).toBe(false);
    expect(await adoptCoreDraft(draft.id, root)).toBe("overtaken");
  });

  test("ein neuerer Entwurf löst den älteren ab", async () => {
    const old = await storeCoreDraft("alt", coreFingerprint(""), root);
    const fresh = await storeCoreDraft("neu", coreFingerprint(""), root);
    expect(await adoptCoreDraft(old.id, root)).toBe("overtaken");
    expect(await coreForPrompt(root)).toBe("");
    await dropCoreDraft(old.id, root);
    expect(await adoptCoreDraft(fresh.id, root)).toBe("adopted");
    expect(await coreForPrompt(root)).toBe("neu");
  });

  test("hat sich der Kern seit dem Entwurf geändert, bleibt er, auch bei einer Änderung von Hand", async () => {
    await setCore("Stand A", root);
    const draft = await storeCoreDraft("Entwurf", coreFingerprint("Stand A"), root);
    writeFileSync(coreFile(root), "Von Hand\n");
    expect(await adoptCoreDraft(draft.id, root)).toBe("stale");
    expect(await coreForPrompt(root)).toBe("Von Hand");
    expect(existsSync(coreDraftFile(root))).toBe(false);
  });

  test("übernehmen sichert den bisherigen Kern", async () => {
    await setCore("Stand A", root);
    const draft = await storeCoreDraft("Stand B", coreFingerprint("Stand A"), root);
    expect(await adoptCoreDraft(draft.id, root)).toBe("adopted");
    expect(readFileSync(coreBackupFile(root), "utf-8")).toBe("Stand A\n");
  });

  test("kaputte Entwurfsdatei gilt als überholt, der Kern bleibt", async () => {
    await setCore("Stand A", root);
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(coreDraftFile(root), "{kaputt");
    expect(await adoptCoreDraft("abc", root)).toBe("overtaken");
    expect(await coreForPrompt(root)).toBe("Stand A");
  });
});
