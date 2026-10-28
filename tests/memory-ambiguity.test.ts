/**
 * Issue #316, Aufgabe 3: mehrdeutige DONE, CANCEL und FORGET werden zur
 * Rückfrage (Art "memory" im Rückfragen-Register) statt still einen
 * beliebigen Eintrag zu treffen. Echtes Register mit eigener Datei, echter
 * Dienst mit eigener Gedächtnis-Datei bzw. Supabase-Attrappe; nur Telegram
 * und Browser-Zustellung sind Attrappen.
 *
 * Geprüft: vor der Auswahl keine Änderung, danach genau der gewählte
 * Eintrag (per ID, auch bei gleichen Texten), Doppelentscheidung, Eintrag
 * inzwischen weg, „Keins davon", Neustart, falsches Gespräch, Telegram,
 * Browser und Terminal, Web-Gespräch und Turn ohne Telegram, keine
 * Zustellung, und das Tor für fremde Inhalte.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideChoice, getChoice, listChoices, onChoiceDecided, setChoicesFileForTests, type Choice } from "../src/lib/choices";
import { decideReview, processTurnIntents } from "../src/lib/intent-gate";
import { listFacts, listGoals, processIntents, setMemoryAsker, addFact, addGoal } from "../src/lib/memory";
import { createMemoryAsker, createMemoryChoices, MEMORY_CHOICE_TEXT, MEMORY_SOURCE } from "../src/lib/memory/choices";
import { getStore, resetStore } from "../src/lib/store";
import type { SendAndRecordInput } from "../src/lib/outbox";
import type { WebPost } from "../src/lib/review-choices";
import { createChoicePort } from "../src/web/choices";
import { register } from "./choices-fixture";
import { useMemoryTable } from "./memory-fixture";

const DM = "4711";
const GROUP = "-100200";
const TOPIC = { conversation: { type: "telegram" as const, chatId: GROUP, topicId: 7 } };
const WEB_ID = "0b5e4c8a-1d2f-4a3b-9c8d-7e6f5a4b3c2d";

interface World {
  sentChoices: Choice[];
  webPosts: { conversationId: string; post: WebPost }[];
  notes: SendAndRecordInput[];
  logs: string[];
  /** sendChoice meldet „gesendet" */
  telegramUp: boolean;
  webUp: boolean;
}

let world: World;
const cleanups: (() => void)[] = [];

function install(): void {
  setMemoryAsker(
    createMemoryAsker({
      sendChoice: async choice => {
        world.sentChoices.push(choice);
        return { sent: world.telegramUp };
      },
      postWeb: async (conversationId, post) => {
        world.webPosts.push({ conversationId, post });
        return world.webUp;
      },
      log: line => world.logs.push(line),
    }),
  );
  const choices = createMemoryChoices({
    sendAndRecord: async input => {
      world.notes.push(input);
      return { sent: true, recorded: true };
    },
    postWeb: async (conversationId, post) => {
      world.webPosts.push({ conversationId, post });
      return true;
    },
    dmChatId: () => DM,
    log: line => world.logs.push(line),
  });
  const off = onChoiceDecided("memory", choices.handler);
  cleanups.push(off);
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "tybo-mehrdeutig-"));
  const savedFile = process.env.MEMORY_FILE_PATH;
  process.env.MEMORY_FILE_PATH = join(dir, "memory.json");
  setChoicesFileForTests(join(dir, "choices.json"));
  resetStore();
  world = { sentChoices: [], webPosts: [], notes: [], logs: [], telegramUp: true, webUp: true };
  install();
  const log = spyOn(console, "log").mockImplementation(line => void world.logs.push(String(line)));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  cleanups.push(() => {
    log.mockRestore();
    warn.mockRestore();
    setMemoryAsker(null);
    setChoicesFileForTests(null);
    process.env.MEMORY_FILE_PATH = savedFile;
    resetStore();
    rmSync(dir, { recursive: true, force: true });
  });
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const memoryChoices = async () => (await listChoices()).filter(c => c.kind === "memory");

async function twoReports(): Promise<void> {
  await addGoal("Bericht A schreiben");
  await addGoal("Bericht B schreiben");
}

describe("DONE mit mehreren Treffern", () => {
  test("vor der Auswahl ändert sich nichts, die Frage nennt alle Treffer", async () => {
    await twoReports();
    const r = await processIntents("[DONE: Bericht]", TOPIC);
    expect(r.goalsCompleted).toEqual([]);
    expect(r.asked).toEqual([{ action: "done", query: "Bericht" }]);
    expect(await listGoals()).toBe("1. Bericht A schreiben\n2. Bericht B schreiben");

    const [choice] = await memoryChoices();
    expect(choice).toMatchObject({ state: "open", action: "done", conversation: TOPIC.conversation });
    expect(choice.options.map(o => o.key)).toEqual(["e0", "e1", "none"]);
    expect(choice.options.map(o => o.label)).toEqual(["1. Bericht A schreiben", "2. Bericht B schreiben", "Keins davon"]);
    expect(choice.text.split("\n")[0]).toBe(MEMORY_CHOICE_TEXT.question.done("Bericht"));
    expect(choice.text).toContain("\n1. Bericht A schreiben (vom ");
    expect(choice.text).toContain(MEMORY_CHOICE_TEXT.untouched);
    expect(JSON.parse(choice.ref!)).toHaveLength(2);
    // Telegram-Gespräch: per sendChoice dorthin, nicht in den Browser-Weg
    expect(world.sentChoices.map(c => c.id)).toEqual([choice.id]);
    expect(world.webPosts).toEqual([]);
  });

  test("nach der Auswahl genau der gewählte Eintrag, Meldung im Gespräch der Frage", async () => {
    await twoReports();
    await processIntents("[DONE: Bericht]", TOPIC);
    const [choice] = await memoryChoices();
    expect((await decideChoice(choice.id, "e1", "telegram")).status).toBe("decided");
    expect(await listGoals()).toBe("1. Bericht A schreiben");
    expect(world.notes).toEqual([
      { chatId: GROUP, topicId: 7, text: MEMORY_CHOICE_TEXT.applied.done("2. Bericht B schreiben"), source: MEMORY_SOURCE, format: "plain" },
    ]);
    expect((await getChoice(choice.id))?.handlerError).toBeUndefined();
  });

  test("Doppelentscheidung: der zweite Klick ändert nichts mehr", async () => {
    await twoReports();
    await processIntents("[DONE: Bericht]", TOPIC);
    const [choice] = await memoryChoices();
    await decideChoice(choice.id, "e0", "web");
    const second = await decideChoice(choice.id, "e1", "telegram");
    expect(second.status).toBe("already");
    expect(await listGoals()).toBe("1. Bericht B schreiben");
    expect(world.notes).toHaveLength(1);
  });

  test("gleiche Texte: die Frist unterscheidet sie, gewählt wird per ID", async () => {
    process.env.USER_TIMEZONE = "Europe/Berlin";
    cleanups.push(() => void delete process.env.USER_TIMEZONE);
    await addGoal("Steuer", "2026-11-01");
    await addGoal("Steuer", "2026-12-01");
    await processIntents("[DONE: Steuer]", TOPIC);
    const [choice] = await memoryChoices();
    expect(choice.text).toContain("1. Steuer (fällig 01.11.2026)");
    expect(choice.text).toContain("2. Steuer (fällig 01.12.2026)");
    await decideChoice(choice.id, "e0", "telegram");
    const left = await getStore().memory.activeGoals();
    expect(left.map(g => g.deadline)).toEqual([new Date("2026-12-01").toISOString()]);
  });

  test("Eintrag inzwischen weg: nichts geändert, Meldung sagt das", async () => {
    await twoReports();
    await processIntents("[DONE: Bericht]", TOPIC);
    const [choice] = await memoryChoices();
    await getStore().memory.cancelGoal("Bericht B");
    await decideChoice(choice.id, "e1", "telegram");
    expect(await listGoals()).toBe("1. Bericht A schreiben");
    expect(world.notes.map(n => n.text)).toEqual([MEMORY_CHOICE_TEXT.gone]);
  });

  test("Keins davon: nichts geändert", async () => {
    await twoReports();
    await processIntents("[DONE: Bericht]", TOPIC);
    const [choice] = await memoryChoices();
    await decideChoice(choice.id, "none", "telegram");
    expect(await listGoals()).toBe("1. Bericht A schreiben\n2. Bericht B schreiben");
    expect(world.notes.map(n => n.text)).toEqual([MEMORY_CHOICE_TEXT.nothing]);
  });

  test("Neustart zwischen Frage und Klick: neuer Handler, Frage und Einträge aus den Dateien", async () => {
    await twoReports();
    await processIntents("[DONE: Bericht]", TOPIC);
    const [choice] = await memoryChoices();
    // Wie ein neuer Prozess: Handler neu, Store neu gewählt
    while (cleanups.length > 1) cleanups.shift()!();
    resetStore();
    install();
    expect((await decideChoice(choice.id, "e0", "telegram")).status).toBe("decided");
    expect(await listGoals()).toBe("1. Bericht B schreiben");
  });

  test("mehr als zehn Treffer: die ältesten zehn zur Auswahl, Hinweis im Text", async () => {
    for (let i = 1; i <= 12; i++) await addGoal(`Bericht ${String(i).padStart(2, "0")}`);
    await processIntents("[DONE: Bericht]", TOPIC);
    const [choice] = await memoryChoices();
    expect(choice.options).toHaveLength(11);
    expect(choice.options[9].label).toBe("10. Bericht 10");
    expect(choice.text).toContain(MEMORY_CHOICE_TEXT.more);
  });
});

describe("CANCEL und FORGET", () => {
  test("CANCEL mit zwei Treffern streicht genau den gewählten", async () => {
    await twoReports();
    const r = await processIntents("[CANCEL: Bericht]", TOPIC);
    expect(r.goalsCancelled).toEqual([]);
    const [choice] = await memoryChoices();
    expect(choice.action).toBe("cancel");
    await decideChoice(choice.id, "e0", "terminal");
    expect(await listGoals()).toBe("1. Bericht B schreiben");
    expect(world.notes.map(n => n.text)).toEqual([MEMORY_CHOICE_TEXT.applied.cancel("1. Bericht A schreiben")]);
  });

  test("FORGET mit zwei Treffern vergisst genau den gewählten Fakt", async () => {
    await addFact("Alex trinkt Tee");
    await addFact("Mia trinkt Tee");
    const r = await processIntents("[FORGET: Tee]", TOPIC);
    expect(r.factsRemoved).toEqual([]);
    expect(await listFacts()).toBe("- Alex trinkt Tee\n- Mia trinkt Tee");
    const [choice] = await memoryChoices();
    expect(choice.action).toBe("forget");
    expect(choice.text.split("\n")[0]).toBe(MEMORY_CHOICE_TEXT.question.forget("Tee"));
    await decideChoice(choice.id, "e1", "telegram");
    expect(await listFacts()).toBe("- Alex trinkt Tee");
  });

  test("null und ein Treffer: keine Rückfrage", async () => {
    await twoReports();
    await addFact("Alex trinkt Tee");
    const r = await processIntents("[DONE: Bericht A] [FORGET: Kaffee] [CANCEL: Urlaub]", TOPIC);
    expect(r.goalsCompleted).toEqual(["Bericht A"]);
    expect(r.factsRemoved).toEqual([]);
    expect(r.asked).toBeUndefined();
    expect(await memoryChoices()).toEqual([]);
  });
});

describe("Gespräche und Kanäle", () => {
  test("Browser: nur aus dem eigenen Gespräch entscheidbar", async () => {
    await twoReports();
    await processIntents("[DONE: Bericht]", TOPIC);
    const [choice] = await memoryChoices();
    const port = createChoicePort({ register, userId: DM, groupId: () => GROUP, every: () => () => {}, log: () => {} });
    expect(await port.decide("dm", choice.id, "e0", "web")).toEqual({ status: "not_found" });
    expect(await port.decide("topic-8", choice.id, "e0", "web")).toEqual({ status: "not_found" });
    expect((await getChoice(choice.id))?.state).toBe("open");
    expect(await listGoals()).toBe("1. Bericht A schreiben\n2. Bericht B schreiben");
    expect((await port.decide("topic-7", choice.id, "e0", "web")).status).toBe("decided");
    expect(await listGoals()).toBe("1. Bericht B schreiben");
  });

  test("Terminal: Auswahl im Direktchat", async () => {
    await twoReports();
    await processIntents("[DONE: Bericht]", { conversation: { type: "telegram", chatId: DM } });
    const [choice] = await memoryChoices();
    const port = createChoicePort({ register, userId: DM, groupId: () => GROUP, every: () => () => {}, log: () => {} });
    expect((await port.decide("dm", choice.id, "e1", "terminal")).status).toBe("decided");
    expect(await listGoals()).toBe("1. Bericht A schreiben");
    expect(world.notes[0]).toMatchObject({ chatId: DM, source: MEMORY_SOURCE });
  });

  test("reines Web-Gespräch: Frage im Gespräch und als Kopie im Direktchat, Ergebnis ebenso", async () => {
    await twoReports();
    await processIntents("[DONE: Bericht]", { conversation: { type: "web", conversationId: WEB_ID } });
    const [choice] = await memoryChoices();
    expect(world.webPosts).toEqual([{ conversationId: WEB_ID, post: { text: choice.text, kind: "notice", source: MEMORY_SOURCE, choiceId: choice.id } }]);
    expect(world.sentChoices.map(c => c.id)).toEqual([choice.id]);
    await decideChoice(choice.id, "e0", "web");
    expect(world.webPosts.at(-1)).toEqual({ conversationId: WEB_ID, post: { text: MEMORY_CHOICE_TEXT.applied.done("1. Bericht A schreiben"), kind: "notice", source: MEMORY_SOURCE } });
    expect(world.notes).toEqual([{ chatId: DM, text: `(Web-Gespräch) ${MEMORY_CHOICE_TEXT.applied.done("1. Bericht A schreiben")}`, source: MEMORY_SOURCE, format: "plain" }]);
  });

  test("Turn ohne Telegram: Frage und Ergebnis nur im WebUI-Gespräch", async () => {
    await twoReports();
    await processIntents("[DONE: Bericht]", { conversation: { type: "telegram", chatId: DM }, noTelegram: { conversationId: WEB_ID } });
    const [choice] = await memoryChoices();
    expect(choice.noTelegram).toEqual({ conversationId: WEB_ID });
    expect(world.sentChoices).toEqual([]);
    expect(world.webPosts.map(p => p.conversationId)).toEqual([WEB_ID]);
    await decideChoice(choice.id, "e1", "web");
    expect(world.notes).toEqual([]);
    expect(world.webPosts.at(-1)?.post.text).toBe(MEMORY_CHOICE_TEXT.applied.done("2. Bericht B schreiben"));
  });

  test("nirgends zugestellt: Frage läuft ab, nichts geändert", async () => {
    world.telegramUp = false;
    await twoReports();
    const r = await processIntents("[DONE: Bericht]", TOPIC);
    expect(r.asked).toBeUndefined();
    const [choice] = await memoryChoices();
    expect(choice.state).toBe("expired");
    expect(await listGoals()).toBe("1. Bericht A schreiben\n2. Bericht B schreiben");
  });

  test("ohne Gespräch oder ohne Zustellweg: nichts geändert, keine Frage", async () => {
    await twoReports();
    expect((await processIntents("[DONE: Bericht]")).goalsCompleted).toEqual([]);
    setMemoryAsker(null);
    expect((await processIntents("[DONE: Bericht]", TOPIC)).goalsCompleted).toEqual([]);
    expect(await memoryChoices()).toEqual([]);
    expect(await listGoals()).toBe("1. Bericht A schreiben\n2. Bericht B schreiben");
  });
});

describe("Verdrahtung über das Tor", () => {
  test("Turn ohne fremde Inhalte: Rückfrage im Topic des Turns", async () => {
    await twoReports();
    const outcome = await processTurnIntents("Erledigt! [DONE: Bericht]", { uses: [] }, { chatId: GROUP, topicId: 7, origin: "Telegram" }, { log: () => {} });
    expect(outcome).toBe("applied");
    const [choice] = await memoryChoices();
    expect(choice.conversation).toEqual(TOPIC.conversation);
  });

  test("Turn aus einem reinen Web-Gespräch: Rückfrage dort", async () => {
    await twoReports();
    await processTurnIntents("[DONE: Bericht]", { uses: [] }, { chatId: `web:${WEB_ID}`, origin: "Web-Gespräch" }, { log: () => {} });
    const [choice] = await memoryChoices();
    expect(choice.conversation).toEqual({ type: "web", conversationId: WEB_ID });
  });

  test("Turn mit fremden Inhalten: erst der Vorschlag, die Auswahl erst nach dem Übernehmen", async () => {
    await twoReports();
    const staged: { tags: string; chatId: string; topicId?: number }[] = [];
    const outcome = await processTurnIntents(
      "[DONE: Bericht]",
      { uses: [{ name: "WebFetch", input: { url: "https://example.org" } }] },
      { chatId: GROUP, topicId: 7, origin: "Telegram" },
      { log: () => {}, stageMemoryReview: async opts => (staged.push(opts), "rev1") },
    );
    expect(outcome).toBe("staged");
    expect(await memoryChoices()).toEqual([]);
    expect(await listGoals()).toBe("1. Bericht A schreiben\n2. Bericht B schreiben");

    const review = { id: "rev1", type: "memory" as const, chatId: GROUP, topicId: 7, tags: staged[0].tags, createdAt: Date.now() };
    const decision = await decideReview("ok", "rev1", { takePendingReview: async () => review, processIntents });
    expect(decision).toMatchObject({ kind: "applied", text: "✅ Übernommen: 0 Fakt(en), 0 Ziel(e), 1 Rückfrage(n) zur Auswahl." });
    const [choice] = await memoryChoices();
    expect(choice.conversation).toEqual(TOPIC.conversation);
    expect(await listGoals()).toBe("1. Bericht A schreiben\n2. Bericht B schreiben");
  });
});

describe("Supabase", () => {
  test("UUIDs bleiben im Bezug, die Knöpfe kurz; geändert wird per ID", async () => {
    const ids = ["6f1c2e1a-8b7d-4c3e-9a2b-1d0e5f4a3b21", "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"];
    const fake = useMemoryTable({
      rows: [
        { id: ids[0], type: "goal", content: "Bericht A", completed: false },
        { id: ids[1], type: "goal", content: "Bericht B", completed: false },
      ],
    });
    cleanups.push(() => fake.restore());
    resetStore();
    expect(getStore().backend).toBe("supabase");
    await processIntents("[DONE: Bericht]", TOPIC);
    const [choice] = await memoryChoices();
    expect(JSON.parse(choice.ref!)).toEqual(ids);
    expect(choice.options.every(o => o.key.length <= 32)).toBe(true);
    expect(fake.table.every(r => r.completed === false)).toBe(true);
    await decideChoice(choice.id, "e1", "telegram");
    expect(fake.table.map(r => [r.content, r.completed])).toEqual([
      ["Bericht A", false],
      ["Bericht B", true],
    ]);
    const patch = fake.tableRequests().find(r => r.method === "PATCH")!;
    expect(patch.url.searchParams.get("id")).toBe(`eq.${ids[1]}`);
  });
});
