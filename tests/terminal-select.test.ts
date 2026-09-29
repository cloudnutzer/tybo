/**
 * Issue #60: Gesprächswahl (src/terminal/select.ts) und zuletzt genutztes
 * Gespräch (src/terminal/state.ts). Reihenfolge: --topic vor gespeichertem
 * Gespräch vor Direktchat.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ConversationSummary } from "../src/terminal/api";
import { findConversation, selectConversation } from "../src/terminal/select";
import { loadState, saveState, stateFile } from "../src/terminal/state";

const LIST: ConversationSummary[] = [
  { id: "dm", title: "Direktchat", agent: "general", kind: "dm" },
  { id: "topic-443", title: "Recherche", agent: "research", kind: "topic" },
  { id: "topic-12", title: "Finanzen", agent: "finance", kind: "topic" },
  { id: "topic-13", title: "finanzen", agent: "general", kind: "topic" },
  { id: "topic-7", title: "Archiv", agent: "cto", kind: "topic", closed: true },
  { id: "topic-1", title: "General", agent: "general", kind: "topic" },
];

const base = await mkdtemp(join(tmpdir(), "tybo-terminal-state-"));
afterAll(() => rm(base, { recursive: true, force: true }));

describe("Reihenfolge der Gesprächswahl", () => {
  test("ohne alles: Direktchat", () => {
    const r = selectConversation(LIST, {});
    expect(r.ok && r.conversation.id).toBe("dm");
  });

  test("gespeichertes Gespräch vor Direktchat", () => {
    const r = selectConversation(LIST, { savedId: "topic-443" });
    expect(r.ok && r.conversation.id).toBe("topic-443");
    expect(r.ok && r.note).toBeUndefined();
  });

  test("--topic vor gespeichertem Gespräch", () => {
    const r = selectConversation(LIST, { topic: "General", savedId: "topic-443" });
    expect(r.ok && r.conversation.id).toBe("topic-1");
  });

  test("gespeichertes Gespräch gelöscht: Direktchat mit Hinweis", () => {
    const r = selectConversation(LIST, { savedId: "topic-999" });
    expect(r.ok && r.conversation.id).toBe("dm");
    expect(r.ok && r.note).toBe("Das zuletzt genutzte Gespräch gibt es nicht mehr, weiter im Direktchat.");
  });

  test("gespeichertes Gespräch geschlossen: Direktchat mit Hinweis", () => {
    const r = selectConversation(LIST, { savedId: "topic-7" });
    expect(r.ok && r.conversation.id).toBe("dm");
    expect(r.ok && r.note).toContain("Archiv (topic-7) ist geschlossen");
  });

  test("ohne Direktchat: General, ohne General das erste Gespräch", () => {
    const noDm = LIST.filter(c => c.kind !== "dm");
    const r = selectConversation(noDm, { savedId: "topic-999" });
    expect(r.ok && r.conversation.id).toBe("topic-1");
    expect(r.ok && r.note).toContain("weiter in General");
    const r2 = selectConversation(noDm.filter(c => c.id !== "topic-1"), {});
    expect(r2.ok && r2.conversation.id).toBe("topic-443");
  });

  test("leere Liste: Fehler statt Absturz", () => {
    expect(selectConversation([], {}).ok).toBe(false);
  });
});

describe("--topic <name|id>", () => {
  test("IDs: dm, topic-<n>, bloße Nummer, Direktchat", () => {
    for (const [wanted, id] of [["dm", "dm"], ["topic-443", "topic-443"], ["443", "topic-443"], ["Direktchat", "dm"], ["DM", "dm"]]) {
      const r = findConversation(LIST, wanted);
      expect(r.ok && r.conversation.id).toBe(id);
    }
  });

  test("Name ohne Rücksicht auf Groß- und Kleinschreibung, außen Leerraum egal", () => {
    const r = findConversation(LIST, "  recherche ");
    expect(r.ok && r.conversation.id).toBe("topic-443");
  });

  test("doppelter Name: Fehler mit beiden IDs, keine Auswahl geraten", () => {
    const r = findConversation(LIST, "Finanzen");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("topic-12");
    expect(!r.ok && r.error).toContain("topic-13");
  });

  test("unbekannte ID oder Name: Fehler mit den vorhandenen Gesprächen", () => {
    for (const wanted of ["topic-999", "999", "Gibtsnicht", "Rech"]) {
      const r = findConversation(LIST, wanted);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain("Recherche (topic-443)");
    }
  });

  test("geschlossenes Topic lässt sich ausdrücklich wählen (lesen)", () => {
    const r = findConversation(LIST, "Archiv");
    expect(r.ok && r.conversation.closed).toBe(true);
  });

  test("Steuerzeichen im gesuchten Namen landen nicht in der Fehlermeldung", () => {
    const r = findConversation(LIST, "\u001b]0;boese\u0007x");
    expect(!r.ok && r.error).not.toContain("\u001b");
  });
});

describe("state.json", () => {
  test("Pfad ~/.config/tybo/state.json, für web:dev eine eigene Datei", () => {
    expect(stateFile("/home/x")).toBe("/home/x/.config/tybo/state.json");
    expect(stateFile("/home/x", true)).toBe("/home/x/.config/tybo/state-dev.json");
  });

  test("speichern und laden; Datei 0600, Ordner 0700", async () => {
    const file = stateFile(join(base, "h1"));
    expect(await saveState(file, { conversationId: "topic-443" })).toBe(true);
    expect(await loadState(file)).toEqual({ conversationId: "topic-443" });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(file))).mode & 0o777).toBe(0o700);
  });

  test("fehlende, kaputte oder unsinnige Datei gilt als leer", async () => {
    expect(await loadState(join(base, "gibtsnicht.json"))).toEqual({});
    const file = stateFile(join(base, "h2"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "{kaputt");
    expect(await loadState(file)).toEqual({});
    await writeFile(file, JSON.stringify({ conversationId: "../../etc/passwd" }));
    expect(await loadState(file)).toEqual({});
  });
});

describe("Issue #228: ohne Telegram", () => {
  const WEB_ONLY: ConversationSummary[] = [
    { id: "dm", title: "Direktchat", agent: "general", kind: "dm" },
    { id: "0f0e0d0c-0b0a-4908-8706-050403020100", title: "Plan", agent: "research", kind: "web" },
  ];

  test("ohne Topics und ohne gespeichertes Gespräch: Direktchat (API-ID dm)", () => {
    const r = selectConversation(WEB_ONLY, {});
    expect(r.ok && r.conversation.id).toBe("dm");
  });

  test("gespeichertes Web-Gespräch wird wieder gewählt", () => {
    const r = selectConversation(WEB_ONLY, { savedId: "0f0e0d0c-0b0a-4908-8706-050403020100" });
    expect(r.ok && r.conversation.kind).toBe("web");
  });
});
