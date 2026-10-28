/**
 * Issue #324, Checkbox 3: Hinweis beim Start, wenn noch eine Convex-Adresse
 * aus früheren Versionen gesetzt ist. Umgebung und Logger sind übergeben;
 * der Hinweis nennt nie einen Wert. Die Reihenfolge beim Start (nach
 * loadEnv) prüft tests/app-bot-boot.test.ts; src/bot.ts wird nicht
 * gelesen, importiert oder gestartet.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { legacyDatabaseNotice, logLegacyDatabaseNotice, MIGRATION_GUIDE } from "../src/lib/legacy-database-notice";

const OLD_URL = "https://happy-otter-123.convex.cloud";
const OLD_TOKEN = "alter-convex-token-geheim-4711";
const SUPABASE = { SUPABASE_URL: "https://abcdefgh.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_hinweis-test-geheim-0815" };

function capture(env: Record<string, string | undefined>) {
  const lines: string[] = [];
  const wrote = logLegacyDatabaseNotice(env, line => lines.push(line));
  return { wrote, lines };
}

describe("Hinweis auf eine alte Convex-Adresse", () => {
  test("nicht gesetzt, leer oder nur Leerzeichen: kein Hinweis", () => {
    for (const env of [{}, { CONVEX_URL: "" }, { CONVEX_URL: "  \t" }, SUPABASE]) {
      expect(legacyDatabaseNotice(env)).toBeNull();
      expect(capture(env)).toEqual({ wrote: false, lines: [] });
    }
  });

  test("gesetzt ohne Supabase: eine Zeile mit Umzugsweg über tybo setup datenbank", () => {
    const { wrote, lines } = capture({ CONVEX_URL: OLD_URL, CONVEX_AUTH_TOKEN: OLD_TOKEN });
    expect(wrote).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("[datenbank] CONVEX_URL ist gesetzt, aber Convex wird nicht mehr unterstützt");
    // Ohne Supabase: nur Fakten und Ziele lokal, kein Telegram-Verlauf; WebUI-Gespräche getrennt
    expect(lines[0]).toContain("nur Fakten und Ziele, lokal in memory.json");
    expect(lines[0]).toContain("den Telegram-Verlauf speichert es nicht");
    expect(lines[0]).toContain("Gespräche der WebUI liegen getrennt unter data/web/");
    expect(lines[0]).not.toMatch(/Verlauf (nur )?in Dateien|landen .*Verlauf/);
    expect(lines[0]).toContain("tybo setup datenbank");
    expect(lines[0]).toContain(MIGRATION_GUIDE);
  });

  test("gesetzt neben Supabase: Supabase bleibt der Speicher, Hinweis zum Entfernen", () => {
    const { lines } = capture({ CONVEX_URL: OLD_URL, ...SUPABASE });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Gespeichert wird in Supabase.");
    expect(lines[0]).toContain("CONVEX_URL aus der .env entfernen");
    expect(lines[0]).not.toContain("data/");
  });

  test("nur Supabase-Adresse ohne Schlüssel zählt nicht als Supabase (wie die Store-Auswahl)", () => {
    expect(legacyDatabaseNotice({ CONVEX_URL: OLD_URL, SUPABASE_URL: SUPABASE.SUPABASE_URL })).toContain("nur Fakten und Ziele, lokal in memory.json");
  });

  test("nennt keine Werte, weder Adresse noch Schlüssel", () => {
    for (const env of [{ CONVEX_URL: OLD_URL, CONVEX_AUTH_TOKEN: OLD_TOKEN }, { CONVEX_URL: OLD_URL, CONVEX_AUTH_TOKEN: OLD_TOKEN, ...SUPABASE }]) {
      const text = capture(env).lines.join("\n");
      for (const value of Object.values(env)) expect(text).not.toContain(value);
      expect(text).not.toContain("happy-otter");
    }
  });
});

describe("Standardwerte und Verdrahtung", () => {
  const saved = process.env.CONVEX_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.CONVEX_URL;
    else process.env.CONVEX_URL = saved;
  });

  test("ohne Argumente: liest process.env zum Zeitpunkt des Aufrufs", () => {
    const lines: string[] = [];
    delete process.env.CONVEX_URL;
    expect(logLegacyDatabaseNotice(undefined, l => lines.push(l))).toBe(false);
    process.env.CONVEX_URL = OLD_URL;
    expect(logLegacyDatabaseNotice(undefined, l => lines.push(l))).toBe(true);
    expect(lines).toHaveLength(1);
  });

  // Genau einmal, nach dem Laden der .env: Verhalten in tests/app-bot-boot.test.ts (Issue #344)
});
