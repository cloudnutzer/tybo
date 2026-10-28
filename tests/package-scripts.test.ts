/**
 * Issue #374: Skripte in package.json geordnet, upgrade und feedback entfernt
 * (E7, E12). Jedes Skript zeigt auf eine vorhandene Datei, die Reihenfolge
 * folgt den Gruppen Betrieb, Aufgaben, Einrichtung, Entwicklung.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const scripts: Record<string, string> = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;

describe("package.json-Skripte", () => {
  test("Reihenfolge nach Gruppen, keine Namen verloren", () => {
    expect(Object.keys(scripts)).toEqual([
      // Betrieb
      "tybo", "start", "vps", "whatsapp", "voice",
      // Aufgaben und Routinen
      "restart:request", "notify", "job", "checkin", "briefing", "health", "updates",
      // Einrichtung
      "setup", "setup:launchd", "setup:services", "setup:verify", "setup:google", "uninstall", "test:tools",
      // Entwicklung
      "web:dev", "typecheck", "test", "check",
    ]);
  });

  test("jede .ts-Datei, die ein Skript startet, gibt es", () => {
    for (const [name, command] of Object.entries(scripts)) {
      for (const file of command.match(/\S+\.ts\b/g) ?? []) {
        expect({ name, file, exists: existsSync(join(ROOT, file)) }).toEqual({ name, file, exists: true });
      }
    }
  });
});

/**
 * Verlauf und Planung dürfen frühere Namen nennen: Entscheidungen, Changelog,
 * Anforderungsliste, Werkstatt-Notizen und Tests (Negativtests).
 */
const HISTORY = [/^docs\/webui\/decisions\//, /^docs\/werkstatt\//, /^CHANGELOG\.md$/, /^PRD\.md$/, /^tests\//];

function trackedTextFiles(): string[] {
  const out = Bun.spawnSync(["git", "ls-files"], { cwd: ROOT }).stdout.toString();
  return out
    .split("\n")
    .filter(f => /\.(md|ts|sh|html|js|json)$/.test(f))
    .filter(f => !HISTORY.some(re => re.test(f)))
    .filter(f => existsSync(join(ROOT, f)));
}

test("Akzeptanz #374: kein Aufruf `bun run <name>` nennt ein Skript, das es nicht gibt", () => {
  const dead: string[] = [];
  for (const file of trackedTextFiles()) {
    const text = readFileSync(join(ROOT, file), "utf8");
    // Nur Skriptnamen, keine Pfade wie bun run src/bot.ts und keine Suchmuster wie grep "bun run src"
    for (const m of text.matchAll(/bun run ([a-z][a-z0-9:_-]*)(?![\w./-])/g)) {
      if (!(m[1] in scripts) && !existsSync(join(ROOT, m[1]))) dead.push(`${file}: ${m[1]}`);
    }
  }
  expect(dead).toEqual([]);
});
