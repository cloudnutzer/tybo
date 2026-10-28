/**
 * Issue #67: docs/einrichtung.md gegen den Code. Jeder Schritt und jedes Feld
 * aus SETUP_STEPS muss in der Anleitung stehen, damit eine neue Frage im
 * Assistenten ohne Doku in `bun run check` auffällt. Reihenfolge, bedingte
 * Felder und Rückfragen sind zusätzlich von Hand abgeglichen (Pull Request).
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MIGRATION_GUIDE } from "../src/lib/legacy-database-notice";
import { SETUP_STEPS } from "../src/setup/steps";

const DOC = await readFile(resolve(import.meta.dir, "..", "docs", "einrichtung.md"), "utf8");

describe("docs/einrichtung.md", () => {
  test("nennt jeden Schritt mit Titel und Namen für tybo setup <schritt>", () => {
    const missing = SETUP_STEPS.flatMap(s => [s.title, `\`${s.id}\``]).filter(t => !DOC.includes(t));
    expect(missing).toEqual([]);
  });

  test("nennt jedes Feld mit dem Titel aus dem Assistenten", () => {
    const missing = SETUP_STEPS.flatMap(s => s.fields.filter(f => !DOC.includes(f.label)).map(f => `${s.id}: ${f.label}`));
    expect(missing).toEqual([]);
  });

  // Ausgenommen: Effort-Stufen, die Regionen von Supabase (18 Stück, die Doku
  // nennt den Standard und die EU-Regionen) und Auswahlen vom Anbieter (choicesFrom)
  test("nennt jede feste Auswahl eines Auswahlfelds außer Effort-Stufen und Regionen", () => {
    const skip = new Set(["DEFAULT_EFFORT", "SUPABASE_REGION"]);
    const labels = SETUP_STEPS.flatMap(s =>
      s.fields.filter(f => f.kind === "choice" && !skip.has(f.name) && !f.choicesFrom).flatMap(f => (f.choices ?? []).map(c => c.label)),
    );
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.filter(l => !DOC.includes(l))).toEqual([]);
  });

  test("Schritte stehen als nummerierte Überschriften in der Reihenfolge des Assistenten", () => {
    const headings = DOC.split("\n").filter(l => /^### \d+\. /.test(l));
    expect(headings).toEqual(SETUP_STEPS.map((s, i) => `### ${i + 1}. ${s.optional ? `${s.title} (optional)` : s.title}`));
  });

  test("erklärt die Rückfragen aus terminal.ts", () => {
    const questions = [
      "Erledigte trotzdem bearbeiten?",
      "Jetzt einrichten? [J/n]",
      "Nochmal eingeben? [J/n]",
      "Erneut eingeben [E] oder überspringen [ü]?",
      "Nochmal prüfen [E] oder überspringen [ü]?",
      "Nochmal versuchen [E] oder überspringen [ü]?",
      "Speichern? [J/n]",
      "Autostart jetzt einrichten? [j/N]",
      // Issue #161: Abläufe und Auswahlen vom Anbieter
      "Jetzt ausführen? [J/n]",
      "Nochmal eingeben [E] oder überspringen [ü]?",
      "Das passiert jetzt:",
    ];
    expect(questions.filter(q => !DOC.includes(q))).toEqual([]);
  });

  // Issue #163: Standard ist Supabase in der Cloud; Issue #324: Convex entfällt
  test("README und Anleitung: Supabase in der Cloud als Standard, Convex nur noch als Umzug", async () => {
    const readme = await readFile(resolve(import.meta.dir, "..", "README.md"), "utf8");
    expect(readme).not.toMatch(/convex/i);
    expect(readme).toContain("Supabase\n  (cloud or local) and are pulled back");
    expect(DOC).toContain("Supabase in der Cloud, der Assistent richtet alles ein (Standard)");
    // Convex nur noch im Abschnitt zum Umzug, im Verweis darauf und als Log-Hinweis
    expect(DOC).not.toContain("Convex vorbereiten");
    expect(DOC).not.toContain("npx convex dev");
    expect(DOC).toContain("#### Umzug von Convex");
  });

  // Issue #324: Code und Doku nennen gemeinsam genau drei Wege
  test("Datenbank: genau drei Wege, in Doku und Code gleich", () => {
    const field = SETUP_STEPS.find(s => s.id === "datenbank")!.fields.find(f => f.name === "DB_BACKEND")!;
    const labels = field.choices!.map(c => c.label);
    expect(labels).toHaveLength(3);
    const section = DOC.slice(DOC.indexOf("### 4. Datenbank"), DOC.indexOf("#### Supabase in der Cloud (Standard)"));
    expect(section).toContain("Es gibt drei Wege");
    const listed = [...section.matchAll(/^  (\d)\. „([^“]+)“/gm)].map(m => [m[1], m[2]]);
    expect(listed).toEqual(labels.map((l, i) => [String(i + 1), l]));
  });

  test("Umzug von Convex: sichern, Supabase einrichten, Grenzen der Übernahme, aufräumen", () => {
    const start = DOC.indexOf("#### Umzug von Convex");
    const part = DOC.slice(start, DOC.indexOf("\n### ", start));
    for (const t of ["npx convex export", "tybo setup datenbank", "Ein Umzugswerkzeug von Convex nach\n   Supabase gibt es nicht", "Gegenrichtung", "`tybo erinnerungen importieren` liest nur", "CONVEX_URL"]) {
      expect(part).toContain(t);
    }
    expect(DOC).toContain(MIGRATION_GUIDE.split("„")[1].replace("“", ""));
  });

  test("keine Gedankenstriche", () => {
    expect(DOC.includes("—")).toBe(false);
  });
});
