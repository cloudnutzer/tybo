import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ChoiceConversation } from "../src/lib/choices";
import { conversationGoneCheck } from "../src/lib/threads/remind";
import { isConversationListed } from "../src/web/store";

// Issue #292, Nachbesserung: „Gespräch weg" für Web-Gespräche nur, wenn eine
// gültige Liste gelesen wurde und das Gespräch darin fehlt. Fehlende,
// unlesbare oder kaputte Ablage heißt unbekannt (null), nie weg.

const ID = "0b7c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const OTHER = "1c8d3f5a-2b3c-4d4e-9f0a-1b2c3d4e5f60";
const WEB: ChoiceConversation = { type: "web", conversationId: ID };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-gone-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const entry = (id: string) => ({ id, title: "Urlaub planen", agent: "general", createdAt: "2026-10-15T10:00:00.000Z", updatedAt: "2026-10-15T10:00:00.000Z" });
const list = (content: string) => writeFileSync(join(dir, "conversations.json"), content);
const check = conversationGoneCheck({
  webConversationExists: id => isConversationListed(id, dir),
  topicDeleted: async () => false,
});

describe("Web-Gespräch weg?", () => {
  test("Gespräch tatsächlich entfernt (gültige Liste ohne es): weg", async () => {
    list(JSON.stringify([entry(OTHER)]));
    expect(await check(WEB)).toBe(true);
    list(JSON.stringify([]));
    expect(await check(WEB)).toBe(true);
  });

  test("Gespräch in der Liste: da", async () => {
    list(JSON.stringify([entry(OTHER), entry(ID)]));
    expect(await check(WEB)).toBe(false);
  });

  test("Liste fehlt: unbekannt, nicht weg", async () => {
    expect(await check(WEB)).toBeNull();
  });

  test("Lesefehler: unbekannt, nicht weg", async () => {
    // Ein Ordner an der Stelle der Datei: readFile scheitert mit EISDIR
    mkdirSync(join(dir, "conversations.json"));
    expect(await check(WEB)).toBeNull();
  });

  test("beschädigte Datei (kein JSON, keine Liste): unbekannt, nicht weg", async () => {
    list("[{\"id\": \"");
    expect(await check(WEB)).toBeNull();
    list(JSON.stringify({ conversations: [] }));
    expect(await check(WEB)).toBeNull();
  });

  test("ungültige Einträge: unbekannt, nicht weg", async () => {
    list(JSON.stringify([null]));
    expect(await check(WEB)).toBeNull();
    list(JSON.stringify([{ id: 123 }]));
    expect(await check(WEB)).toBeNull();
    // Gemischt: ohne das Gespräch unbekannt, mit ihm (gültig) da
    list(JSON.stringify([entry(OTHER), { id: ID }]));
    expect(await check(WEB)).toBeNull();
    list(JSON.stringify([entry(OTHER), null]));
    expect(await check(WEB)).toBeNull();
    list(JSON.stringify([null, entry(ID)]));
    expect(await check(WEB)).toBe(false);
  });
});

// Gesprächsprüfung im Bot über die Gesprächsliste: tests/app-bot-background.test.ts (Issue #344)
