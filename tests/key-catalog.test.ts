/**
 * Issue #62, Checkbox 2: Katalog bekannter Variablen (src/web/key-catalog.ts),
 * abgeglichen mit .env.example, STATUS_KEY_GROUPS und AGENT_TOKEN_MAP.
 */

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { AGENT_TOKEN_MAP } from "../src/lib/bot-registry";
import { ENV_NAME_PATTERN } from "../src/lib/env-file";
import {
  catalogEntry,
  catalogGroup,
  isLockedKey,
  isValidKeyName,
  KEY_CATALOG,
  KEY_GROUPS,
} from "../src/web/key-catalog";
import { STATUS_KEY_GROUPS } from "../src/web/status";

const repo = resolve(import.meta.dir, "..");

describe("Katalog", () => {
  test("jede Gruppe ist belegt, Namen eindeutig und gültig, Beschreibung vorhanden", () => {
    expect([...KEY_GROUPS]).toEqual(["LLM-Anbieter", "Werkzeuge", "Dienste", "Telegram", "WebUI", "Datenbank"]);
    for (const g of KEY_GROUPS) expect(KEY_CATALOG.some(e => e.group === g)).toBe(true);
    const names = KEY_CATALOG.map(e => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const e of KEY_CATALOG) {
      expect(ENV_NAME_PATTERN.test(e.name)).toBe(true);
      expect(e.description.trim().length).toBeGreaterThan(5);
      expect(e.description).not.toContain("—");
    }
  });

  test("enthält alle Schlüssel der Statusseite und alle Agentenbot-Tokens", () => {
    for (const { names } of STATUS_KEY_GROUPS) for (const n of names) expect(catalogEntry(n)).toBeDefined();
    for (const n of Object.values(AGENT_TOKEN_MAP)) {
      expect(catalogGroup(n)).toBe("Telegram");
      // Agentenbots sperren niemanden aus: änderbar
      expect(catalogEntry(n)!.editable).toBe(true);
    }
  });

  test("jeder Katalogname steht in .env.example", async () => {
    const example = await Bun.file(join(repo, ".env.example")).text();
    for (const e of KEY_CATALOG) expect(example).toMatch(new RegExp(`^#?\\s*${e.name}=`, "m"));
  });

  test("gesperrt sind genau WEB_*, TELEGRAM_BOT_TOKEN und TELEGRAM_USER_ID", () => {
    for (const e of KEY_CATALOG) {
      const locked = e.name.startsWith("WEB_") || e.name === "TELEGRAM_BOT_TOKEN" || e.name === "TELEGRAM_USER_ID";
      expect(e.editable).toBe(!locked);
    }
    expect(catalogEntry("WEB_PASSWORD")!.editable).toBe(false);
    expect(catalogEntry("WEB_ALLOW_KEY_EDIT")!.editable).toBe(false);
    expect(catalogEntry("ANTHROPIC_API_KEY")!.editable).toBe(true);
  });

  test("Sperre gilt auch für unbekannte Namen", () => {
    expect(isLockedKey("WEB_IRGENDWAS")).toBe(true);
    expect(isLockedKey("WEB_")).toBe(true);
    expect(isLockedKey("TELEGRAM_BOT_TOKEN")).toBe(true);
    expect(isLockedKey("TELEGRAM_USER_ID")).toBe(true);
    expect(isLockedKey("TELEGRAM_BOT_TOKEN_NEU")).toBe(false);
    expect(isLockedKey("MY_WEB_KEY")).toBe(false);
  });

  test("Ausnahmeliste nur als Aufrufparameter (Einrichtungsmodus M8)", () => {
    const setup = new Set(["TELEGRAM_BOT_TOKEN", "WEB_PASSWORD"]);
    expect(isLockedKey("TELEGRAM_BOT_TOKEN", setup)).toBe(false);
    expect(isLockedKey("WEB_PASSWORD", setup)).toBe(false);
    expect(isLockedKey("WEB_HOST", setup)).toBe(true);
    expect(isLockedKey("TELEGRAM_BOT_TOKEN")).toBe(true);
  });

  test("Namensprüfung ist vollständig verankert", () => {
    for (const ok of ["AB", "MY_KEY_2", `A${"B".repeat(63)}`]) expect(isValidKeyName(ok)).toBe(true);
    for (const bad of ["A", "ab", "_AB", "2AB", "AB-C", "AB C", "AB\n", "\nAB", "X_KEY\nWEB_PASSWORD", `A${"B".repeat(64)}`, "AB%20", "ÄB"]) {
      expect(isValidKeyName(bad)).toBe(false);
    }
  });

  test("unbekannte Namen haben keine Gruppe (Einfügen am Dateiende)", () => {
    expect(catalogGroup("EIGENER_SCHLUESSEL")).toBeUndefined();
    expect(catalogGroup("OPENAI_API_KEY")).toBe("LLM-Anbieter");
  });
});
