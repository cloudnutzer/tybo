/**
 * Issue #317, Schritt 2: der Tag [KNOWLEDGE: Kategorie | Titel | Inhalt |
 * Projekt] über Parser, Gedächtnis-Dienst und intent-gate. Ohne fremde
 * Inhalte direkt gespeichert; nach fremden Inhalten nur als Vorschlag ohne
 * Schreibzugriff, bei Zustimmung genau einmal, bei Ablehnung nie. Die
 * Wissensbasis läuft echt über den Store gegen eine Supabase-Attrappe hinter
 * globalThis.fetch; Vorschläge liegen in einer Temp-Datei.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { decideReview, describeApplied, extractIntentTags, gateTurnIntents, processVoiceIntents } from "../src/lib/intent-gate";
import { processIntents } from "../src/lib/memory";
import { parseMemoryIntents } from "../src/lib/memory/intents";
import { resetStore } from "../src/lib/store";
import {
  describeTags,
  setPendingReviewsFileForTests,
  setReviewNotifier,
  takePendingReview,
  type ReviewProposal,
} from "../src/lib/session-distill";
import { resetSupabaseClient } from "../src/lib/supabase";
import { callMemoryNotice } from "../src/web/bot-call";

const base = mkdtempSync(join(tmpdir(), "knowledge-intents-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const VARS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "DISTILL_AUTO_APPLY"];
const PROJECT = join(base, "projekt");
const WEBFETCH = { uses: [{ name: "WebFetch" }], cwd: PROJECT };
const TAG = "[KNOWLEDGE: reference | Rahmengröße | Der Rahmen hat 56 cm | Rad]";

let saved: Record<string, string | undefined>;
let realFetch: typeof fetch;
let writes: Record<string, unknown>[];
let sent: ReviewProposal[];
let counter = 0;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map(k => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  resetSupabaseClient();
  resetStore();
  writes = [];
  sent = [];
  setPendingReviewsFileForTests(join(base, `pending-${++counter}.json`));
  setReviewNotifier(async proposal => {
    sent.push(proposal);
  });
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/rest/v1/knowledge" && init?.method === "POST") {
      writes.push(JSON.parse(String(init.body)));
      return Response.json({ id: `k-${writes.length}` }, { status: 201 });
    }
    if (url.pathname.startsWith("/functions/v1/")) return Response.json({ ok: true });
    return new Response("unerwartet", { status: 599 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setReviewNotifier(null);
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetSupabaseClient();
  resetStore();
});
afterAll(() => setPendingReviewsFileForTests(null));

describe("Parser", () => {
  test("Kategorie, Titel, Inhalt, Projekt; Kategorie ohne Rücksicht auf Groß und klein", () => {
    expect(parseMemoryIntents(TAG)).toEqual([
      { type: "knowledge", category: "reference", title: "Rahmengröße", content: "Der Rahmen hat 56 cm", project: "Rad" },
    ]);
    expect(parseMemoryIntents("[knowledge: Decision | Server | Wir nehmen Hetzner]")).toEqual([
      { type: "knowledge", category: "decision", title: "Server", content: "Wir nehmen Hetzner" },
    ]);
  });

  test("unbekannte Kategorie, fehlender Titel oder Inhalt: kein Eintrag", () => {
    expect(parseMemoryIntents("[KNOWLEDGE: x] [KNOWLEDGE: rezept | A | B] [KNOWLEDGE: tool | | B] [KNOWLEDGE: tool | A |  ]")).toEqual([]);
  });

  test("KNOWLEDGE kommt nach allen Gedächtnis-Tags", () => {
    expect(parseMemoryIntents(`${TAG} [REMEMBER: Alex fährt Rad]`).map(i => i.type)).toEqual(["fact", "knowledge"]);
  });
});

describe("direkt angewendet", () => {
  test("ohne fremde Inhalte: genau ein Eintrag, Ergebnis nennt ihn", async () => {
    const result = await gateTurnIntents(`Notiert. ${TAG}`, { uses: [], cwd: PROJECT }, { chatId: "111", origin: "Telegram" }, { projectRoot: PROJECT, log: () => {} });
    expect(result.outcome).toBe("applied");
    expect(result.processed?.knowledgeAdded).toEqual(["Rahmengröße"]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ category: "reference", title: "Rahmengröße", content: "Der Rahmen hat 56 cm", related_project: "Rad", status: "active" });
    expect(describeApplied(result.processed!)).toBe("✅ Übernommen: 0 Fakt(en), 0 Ziel(e), 1 Wissenseintrag/-einträge.");
  });

  test("Wissensbasis nicht erreichbar: nichts als gespeichert gemeldet", async () => {
    globalThis.fetch = (async () => Response.json({ message: "aus" }, { status: 503 })) as unknown as typeof fetch;
    const processed = await processIntents(TAG);
    expect(processed.knowledgeAdded).toBeUndefined();
  });

  test("Meldung nach dem Telefonat nennt den Eintrag", () => {
    const notice = callMemoryNotice([{ goalsAdded: [], goalsCompleted: [], goalsCancelled: [], factsAdded: [], factsRemoved: [], knowledgeAdded: ["Rahmengröße"] }], 0);
    expect(notice).toContain("- Wissen gespeichert: Rahmengröße");
  });
});

describe("aus fremden Inhalten nur als Vorschlag", () => {
  test("Vorschlag ohne Schreibzugriff, Vorschau lesbar; Zustimmung genau einmal", async () => {
    expect(extractIntentTags(`Laut Seite ... ${TAG}`)).toBe(TAG);
    const result = await gateTurnIntents(`Laut Seite ... ${TAG}`, WEBFETCH, { chatId: "111", topicId: 7, origin: "Telegram" }, { projectRoot: PROJECT, log: () => {} });
    expect(result.outcome).toBe("staged");
    expect(writes).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("• Wissen speichern: reference | Rahmengröße | Der Rahmen hat 56 cm | Rad");

    const id = sent[0].reviewId;
    const decision = await decideReview("ok", id);
    expect(decision).toMatchObject({ kind: "applied", text: "✅ Übernommen: 0 Fakt(en), 0 Ziel(e), 1 Wissenseintrag/-einträge." });
    expect(writes).toHaveLength(1);
    expect(await decideReview("ok", id)).toEqual({ kind: "expired" });
    expect(writes).toHaveLength(1);
  });

  test("Ablehnung: nichts gespeichert, Vorschlag weg", async () => {
    await gateTurnIntents(TAG, WEBFETCH, { chatId: "111", origin: "Telegram" }, { projectRoot: PROJECT, log: () => {} });
    const id = sent[0].reviewId;
    expect(await decideReview("no", id)).toMatchObject({ kind: "discarded" });
    expect(await takePendingReview(id)).toBeFalsy();
    expect(writes).toEqual([]);
  });

  test("describeTags: reiner KNOWLEDGE-Vorschlag ist nicht leer (sonst würde er verworfen)", () => {
    expect(describeTags(TAG)).toBe("• Wissen speichern: reference | Rahmengröße | Der Rahmen hat 56 cm | Rad");
  });
});

describe("Sprach-Brücke: reine KNOWLEDGE-Antwort", () => {
  const quiet = { projectRoot: PROJECT, log: () => {} };

  test("ohne fremde Inhalte direkt gespeichert", async () => {
    const outcome = await processVoiceIntents(`Merke ich mir. ${TAG}`, { uses: [], cwd: PROJECT }, "111", quiet);
    expect(outcome).toBe("applied");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ category: "reference", title: "Rahmengröße", content: "Der Rahmen hat 56 cm", related_project: "Rad" });
    expect(sent).toEqual([]);
  });

  test("nach fremden Inhalten ausschließlich vorgeschlagen", async () => {
    const outcome = await processVoiceIntents(`Laut Seite ... ${TAG}`, WEBFETCH, "111", quiet);
    expect(outcome).toBe("staged");
    expect(writes).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("• Wissen speichern: reference | Rahmengröße | Der Rahmen hat 56 cm | Rad");
  });

  test("ohne Tags: nichts", async () => {
    expect(await processVoiceIntents("Gern, bis bald.", WEBFETCH, "111", quiet)).toBe("none");
    expect(writes).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("die Brücke nutzt den gemeinsamen Weg statt einer eigenen Tag-Liste", () => {
    const source = readFileSync(join(import.meta.dir, "../src/voice-bridge.ts"), "utf-8");
    expect(source).toContain("processVoiceIntents(assistantRaw, tools, CHAT_ID)");
    expect(source).not.toMatch(/\[\(REMEMBER\|GOAL/);
  });
});
