/**
 * Issue #323, Checkbox 4: docs/erinnerungen.md ersetzt docs/scheduling.md.
 * Belegt: die alte Datei ist weg, die neue nennt keinen Convex-Zwang und
 * verspricht keine Zustellung bei ausgeschaltetem Rechner, ihre Befehle und
 * Texte stimmen mit dem Code überein, Links zeigen auf vorhandene Dateien,
 * keine Gedankenstriche, kein privates Dienstlabel. Die Weiterleitung
 * docs/scheduling.md fiel mit #324 weg, zusammen mit setup/configure-convex.ts,
 * dem letzten Verweis darauf. CLAUDE.md (seit #375 der Abschnitt
 * „Erinnerungen“ im Einrichtungsteil) und docs/einrichtung.md nennen für
 * Erinnerungen keinen Convex-Zwang: sie gehen mit Supabase oder einer Datei
 * unter data/ und kommen nur, solange der Bot läuft.
 */
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { commandRegistry } from "../src/lib/commands/builtin";
import { REMINDERS_TEXT } from "../src/lib/schedule/overview";
import { REMINDER_OPTIONS } from "../src/lib/reminder-choices";
import { remindersUsage } from "../scripts/tybo";

const ROOT = resolve(import.meta.dir, "..");
const DOC = "docs/erinnerungen.md";
const text = readFileSync(join(ROOT, DOC), "utf8");

describe("docs/erinnerungen.md", () => {
  test("ersetzt docs/scheduling.md: die alte Datei ist weg (seit #324 auch die Weiterleitung)", () => {
    expect(existsSync(join(ROOT, "docs", "scheduling.md"))).toBe(false);
  });

  test("kein Convex-Zwang, kein Versprechen bei ausgeschaltetem Rechner", () => {
    expect(text).not.toMatch(/convex/i);
    expect(text).not.toMatch(/auch wenn (der|dein) (Rechner|Computer) aus/i);
    expect(text).toContain("**Sie kommt nur, wenn der Bot\nläuft.**");
    expect(text).toContain("verspätet, fällig war");
  });

  test("Befehle, Knöpfe und Texte wie im Code", () => {
    const cmd = commandRegistry.list("telegram").find(c => c.name === "erinnerungen")!;
    expect(cmd.argsHint).toBe("[absagen <kennung>]");
    expect(text).toContain("**`/erinnerungen absagen <kennung>`**");
    for (const option of REMINDER_OPTIONS) expect(text).toContain(`**${option.label}**`);
    expect(text).toContain(REMINDERS_TEXT.cancelHint);
    expect(text).toContain("tybo erinnerungen importieren");
    expect(remindersUsage()).toContain("erinnerungen importieren [Datei]");
    expect(text).toContain("Reiter\n„Erinnerungen\"");
  });

  test("Links zeigen auf vorhandene Dateien, keine Gedankenstriche", () => {
    const links = [...text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)].map(m => m[1]).filter(h => !/^https?:/.test(h));
    for (const href of links) expect({ href, exists: existsSync(resolve(join(ROOT, dirname(DOC)), href)) }).toEqual({ href, exists: true });
    expect(text).not.toContain("—");
  });

  test("Bedienungsanleitung verweist auf die neue Seite", () => {
    const guide = readFileSync(join(ROOT, "docs", "user-guide.md"), "utf8");
    expect(guide).toContain("[Erinnerungen](erinnerungen.md)");
    expect(guide).toContain("`/erinnerungen absagen <kennung>`");
  });

  test("kein privates Dienstlabel in der öffentlichen Doku", () => {
    expect(text).not.toContain("reminder-checker");
    expect(text).not.toContain("check-reminders");
  });
});

describe("übrige Doku ohne Widerspruch zu docs/erinnerungen.md", () => {
  test("auf docs/scheduling.md verweist keine Datei mehr", () => {
    // git grep über alle getrackten Dateien; Dateien, die im Arbeitsbaum fehlen, zählen nicht
    const grep = spawnSync("git", ["grep", "-l", "-F", "scheduling.md", "--", ".", ":!tests/erinnerungen-doc.test.ts"], { cwd: ROOT, encoding: "utf8" });
    expect(grep.stdout.trim().split("\n").filter(f => f && existsSync(join(ROOT, f)))).toEqual([]);
  });

  test("CLAUDE.md: Erinnerungen ohne Convex, mit Supabase oder Datei, nur bei laufendem Bot", () => {
    const claude = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
    const start = claude.indexOf("\n## Erinnerungen\n");
    const end = claude.indexOf("\n## ", start + 1);
    const part = claude.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // nirgends in der Datei ein Convex-Zwang
    expect(claude).not.toMatch(/Requires:\s*\**\s*Convex|powered by Convex|setup:convex/i);
    expect(part).not.toMatch(/auch wenn (der|dein) (Rechner|Computer) aus|even when machines are offline/i);
    expect(part).toContain("Convex ist nicht nötig");
    expect(part).toContain("einzurichten ist nichts");
    expect(part).toContain("in Supabase oder, ohne Datenbank, in einer Datei unter `data/`");
    expect(part).toContain("Eine Erinnerung kommt nur, solange der Bot läuft");
    expect(part).toContain("`/erinnerungen absagen <kennung>`");
    expect(part).toContain("`tybo erinnerungen importieren`");
    expect(part).toContain("[`docs/erinnerungen.md`](docs/erinnerungen.md)");
    expect(part).not.toContain("—");
  });

  test("docs/einrichtung.md: kein Convex-Zwang für Erinnerungen", () => {
    const setup = readFileSync(join(ROOT, "docs", "einrichtung.md"), "utf8");
    expect(setup).not.toMatch(/Erinnerungen über Convex/);
  });
});
