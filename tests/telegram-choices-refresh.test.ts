/**
 * Issue #114, Schritt 3: Telegram-Nachrichten ziehen nach, wenn eine Frage im
 * Browser oder Terminal entschieden wird oder abläuft, auch nach einem
 * Neustart des Bots. Register in einer temporären Datei, Bot-API als Attrappe.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Composer, type Context } from "grammy";
import {
  attachChoiceTelegram,
  createChoice,
  decideChoice,
  expireChoice,
  expireLapsedChoices,
  getChoice,
  onChoiceChange,
  onChoiceDecided,
  setChoicesFileForTests,
  type Choice,
  type ChoiceChangeType,
  type CreateChoiceInput,
} from "../src/lib/choices";
import { textChunks } from "../src/lib/outbox";
import { choiceEditedText, createTelegramChoices, installTelegramChoices, type ChoiceEditApi } from "../src/lib/telegram-choices";

const USER = "4711";
const GROUP = "-1001234567890";

const base = mkdtempSync(join(tmpdir(), "telegram-choices-refresh-"));
let file = "";
let counter = 0;
let logSpy: ReturnType<typeof spyOn>;
let cleanup: (() => void)[] = [];
let edits: { chatId: string; messageId: number; text: string; other?: Record<string, unknown> }[] = [];
let markups: unknown[] = [];
let logs: string[] = [];
let failFor = new Set<number>();

const api: ChoiceEditApi = {
  editMessageText: async (chatId, messageId, text, other) => {
    if (failFor.has(messageId)) throw new Error("Bad Request: message to edit not found");
    // Wie die echte API: zu lange Texte scheitern
    if (text.length > 4096) throw new Error("Bad Request: MESSAGE_TOO_LONG");
    edits.push({ chatId, messageId, text, other });
  },
  editMessageReplyMarkup: async (...args) => { markups.push(args); },
};

/** Wie im Bot-Prozess: Handler-Objekt anlegen, Middleware und Zuhörer anmelden */
function startBot() {
  const choices = createTelegramChoices({ api, owner: USER, log: l => logs.push(l) });
  cleanup.push(installTelegramChoices(new Composer<Context>(), choices));
  return choices;
}

beforeEach(() => {
  file = join(base, `choices-${++counter}.json`);
  setChoicesFileForTests(file);
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  cleanup = [];
  edits = [];
  markups = [];
  logs = [];
  failFor = new Set();
});
afterEach(() => {
  logSpy.mockRestore();
  for (const off of cleanup) off();
});
afterAll(() => {
  setChoicesFileForTests(null);
  rmSync(base, { recursive: true, force: true });
});

const input = (over: Partial<CreateChoiceInput> = {}): CreateChoiceInput => ({
  kind: "review",
  conversation: { type: "telegram", chatId: GROUP, topicId: 42 },
  text: "Merken?\n- Alex trinkt Kaffee schwarz",
  options: [{ key: "ok", label: "Übernehmen" }, { key: "no", label: "Verwerfen" }],
  ...over,
});

/** Frage mit zwei gemerkten Nachrichten (Topic und Kopie im Direktchat) */
async function withTwoMessages(over: Partial<CreateChoiceInput> = {}): Promise<Choice> {
  const c = await createChoice(input(over));
  await attachChoiceTelegram(c.id, [{ chatId: GROUP, messageId: 10 }, { chatId: USER, messageId: 20 }]);
  return c;
}

describe("Entscheidung in einem anderen Kanal", () => {
  test("im Browser: genau ein editMessageText je gemerkter Nachricht mit (im Browser)", async () => {
    startBot();
    cleanup.push(onChoiceDecided("review", () => {}));
    const c = await withTwoMessages();
    await decideChoice(c.id, "ok", "web");
    const expected = "Merken?\n- Alex trinkt Kaffee schwarz\n\n✓ Übernehmen (im Browser)";
    expect(edits).toEqual([
      { chatId: GROUP, messageId: 10, text: expected, other: { link_preview_options: { is_disabled: true } } },
      { chatId: USER, messageId: 20, text: expected, other: { link_preview_options: { is_disabled: true } } },
    ]);
    expect(markups).toEqual([]);
  });

  test("im Terminal: (im Terminal)", async () => {
    startBot();
    cleanup.push(onChoiceDecided("review", () => {}));
    const c = await withTwoMessages();
    await decideChoice(c.id, "no", "terminal");
    expect(edits.map(e => e.text.split("\n\n").pop())).toEqual(["✓ Verwerfen (im Terminal)", "✓ Verwerfen (im Terminal)"]);
  });

  test("Handler fehlt oder scheitert: handler-error führt zu keinem zweiten Bearbeiten", async () => {
    startBot();
    const types: ChoiceChangeType[] = [];
    cleanup.push(onChoiceChange(e => { types.push(e.type); }));
    const a = await withTwoMessages();
    await decideChoice(a.id, "ok", "web");
    cleanup.push(onChoiceDecided("review", () => { throw new Error("kaputt"); }));
    const b = await withTwoMessages();
    await decideChoice(b.id, "ok", "web");
    expect(types.filter(t => t === "handler-error")).toHaveLength(2);
    expect(edits).toHaveLength(4);
  });

  test("created ändert nichts, spätere Entscheidungen ändern nichts mehr", async () => {
    startBot();
    cleanup.push(onChoiceDecided("review", () => {}));
    const c = await withTwoMessages();
    expect(edits).toEqual([]);
    await decideChoice(c.id, "ok", "web");
    await decideChoice(c.id, "no", "terminal");
    await expireChoice(c.id);
    expect(edits).toHaveLength(2);
  });

  test("Bearbeitungsfehler an einer Nachricht: geloggt ohne Inhalt, die andere wird trotzdem bearbeitet", async () => {
    startBot();
    cleanup.push(onChoiceDecided("review", () => {}));
    failFor.add(10);
    const c = await withTwoMessages();
    const outcome = await decideChoice(c.id, "ok", "web");
    expect(outcome.status).toBe("decided");
    expect(edits.map(e => e.messageId)).toEqual([20]);
    expect(logs.some(l => l.includes("10") && l.includes(c.id) && l.includes("Error"))).toBe(true);
    expect(logs.join("\n")).not.toContain("Kaffee");
  });

  test("Frage ohne gemerkte Nachricht: kein Aufruf", async () => {
    startBot();
    cleanup.push(onChoiceDecided("review", () => {}));
    const c = await createChoice(input());
    await decideChoice(c.id, "ok", "web");
    expect(edits).toEqual([]);
  });

  test("lange Frage: nur das letzte Stück plus Ergebniszeile, höchstens 4096 Zeichen", async () => {
    startBot();
    cleanup.push(onChoiceDecided("review", () => {}));
    const text = Array.from({ length: 30 }, (_, i) => `Absatz ${i} ` + "x".repeat(300)).join("\n\n");
    const c = await createChoice(input({ text }));
    await attachChoiceTelegram(c.id, [{ chatId: GROUP, messageId: 10 }]);
    await decideChoice(c.id, "ok", "web");
    const chunks = textChunks(text, "plain");
    expect(chunks.length).toBeGreaterThan(1);
    expect(edits).toHaveLength(1);
    expect(edits[0].text).toBe(`${chunks[chunks.length - 1]}\n\n✓ Übernehmen (im Browser)`);
    expect(edits[0].text).not.toContain("Absatz 0 ");
  });

  test("Ergebniszeile passt immer in 4096 Zeichen", () => {
    const now = Date.now();
    const c: Choice = {
      id: "abc", kind: "review", conversation: { type: "web", conversationId: "w" }, text: "y".repeat(4000),
      options: [{ key: "ok", label: "L".repeat(300) }], state: "done",
      result: { key: "ok", label: "L".repeat(300), via: "web", at: now }, createdAt: now,
    };
    const edited = choiceEditedText(c, `✓ ${"L".repeat(300)} (im Browser)`);
    expect(edited.length).toBeLessThanOrEqual(4096);
    expect(edited).toEndWith("(im Browser)");
  });

  test("lange gültige Beschriftung: nachgezogen in höchstens 4096 Zeichen, Kanalhinweis bleibt", async () => {
    startBot();
    cleanup.push(onChoiceDecided("review", () => {}));
    const label = "Übernehmen ".repeat(600);
    const c = await withTwoMessages({ text: "y".repeat(4000), options: [{ key: "ok", label }, { key: "no", label: "Verwerfen" }] });
    await decideChoice(c.id, "ok", "web");
    expect(edits).toHaveLength(2);
    for (const e of edits) {
      expect(e.text.length).toBeLessThanOrEqual(4096);
      expect(e.text).toStartWith("yyy");
      expect(e.text).toEndWith("… (im Browser)");
    }
    expect(logs).toEqual([]);
  });

  test("überlange Ergebniszeile von außen: Gesamttext höchstens 4096 Zeichen", () => {
    const now = Date.now();
    const c: Choice = {
      id: "abc", kind: "review", conversation: { type: "web", conversationId: "w" }, text: "y".repeat(4000),
      options: [{ key: "ok", label: "ok" }], state: "done",
      result: { key: "ok", label: "ok", via: "web", at: now }, createdAt: now,
    };
    expect(choiceEditedText(c, "S".repeat(5000)).length).toBeLessThanOrEqual(4096);
    expect(choiceEditedText({ ...c, text: "" }, "S".repeat(5000)).length).toBeLessThanOrEqual(4096);
  });
});

describe("Ablauf", () => {
  test("expireChoice: Knöpfe weg, Zeile Abgelaufen, genau einmal je Nachricht", async () => {
    startBot();
    const c = await withTwoMessages();
    await expireChoice(c.id);
    await expireChoice(c.id);
    expect(edits.map(e => [e.messageId, e.text])).toEqual([
      [10, "Merken?\n- Alex trinkt Kaffee schwarz\n\nAbgelaufen, nichts geändert"],
      [20, "Merken?\n- Alex trinkt Kaffee schwarz\n\nAbgelaufen, nichts geändert"],
    ]);
  });

  test("Frist ohne Klick: sweep speichert den Ablauf und zieht nach, ein zweiter sweep tut nichts", async () => {
    const bot = startBot();
    let runs = 0;
    cleanup.push(onChoiceDecided("review", () => { runs++; }));
    const lapsing = await withTwoMessages({ expiresAt: Date.now() + 20 });
    const open = await withTwoMessages({ expiresAt: Date.now() + 60_000 });
    await new Promise(r => setTimeout(r, 30));
    const expired = await bot.sweep();
    expect(expired.map(c => c.id)).toEqual([lapsing.id]);
    expect(JSON.parse(readFileSync(file, "utf-8")).choices[lapsing.id].state).toBe("expired");
    expect(edits.map(e => e.messageId)).toEqual([10, 20]);
    expect(edits.every(e => e.text.endsWith("Abgelaufen, nichts geändert"))).toBe(true);
    expect((await getChoice(open.id))?.state).toBe("open");
    expect(await bot.sweep()).toEqual([]);
    expect(edits).toHaveLength(2);
    // Ein später Klick wird nicht mehr wirksam
    expect((await decideChoice(lapsing.id, "ok", "telegram")).status).toBe("expired");
    expect(runs).toBe(0);
  });

  test("Start nach Ausfall: während der Ausfallzeit abgelaufene Fragen werden einmal nachgezogen", async () => {
    // Stand, den der Bot vor dem Ausfall hinterlassen hat
    const now = Date.now();
    const stored = (id: string, over: Partial<Choice>): Choice => ({
      id, kind: "tool", conversation: { type: "telegram", chatId: USER }, text: `Frage ${id}`,
      options: [{ key: "y", label: "Erlauben" }, { key: "n", label: "Ablehnen" }],
      state: "open", createdAt: now - 3_600_000, telegram: [{ chatId: USER, messageId: Number(id.slice(1)) }], ...over,
    });
    writeFileSync(file, JSON.stringify({ version: 1, choices: {
      q1: stored("q1", { expiresAt: now - 1_800_000 }),
      q2: stored("q2", { expiresAt: now + 600_000 }),
      q3: stored("q3", { state: "done", result: { key: "y", label: "Erlauben", via: "web", at: now - 3_000_000 } }),
      q4: stored("q4", { state: "expired", expiresAt: now - 3_000_000 }),
      q5: stored("q5", {}),
    } }));
    // Neuer Prozess: frisch angelegt, Abgleich beim Start
    const bot = startBot();
    const expired = await bot.sweep();
    expect(expired.map(c => c.id)).toEqual(["q1"]);
    expect(edits).toEqual([
      { chatId: USER, messageId: 1, text: "Frage q1\n\nAbgelaufen, nichts geändert", other: { link_preview_options: { is_disabled: true } } },
    ]);
    const disk = JSON.parse(readFileSync(file, "utf-8")).choices;
    expect([disk.q1.state, disk.q2.state, disk.q3.state, disk.q4.state, disk.q5.state]).toEqual(["expired", "open", "done", "expired", "open"]);
    // Zweiter Start ändert nichts mehr
    await startBot().sweep();
    expect(edits).toHaveLength(1);
  });

  test("Start nach Ausfall: Frage älter als 7 Tage mit Telegram-Nachricht wird einmal nachgezogen, nicht still gelöscht", async () => {
    const now = Date.now();
    const old: Choice = {
      id: "alt1", kind: "tool", conversation: { type: "telegram", chatId: USER }, text: "Frage alt",
      options: [{ key: "y", label: "Erlauben" }, { key: "n", label: "Ablehnen" }],
      state: "open", createdAt: now - 8 * 24 * 3_600_000, expiresAt: now - 3_600_000,
      telegram: [{ chatId: USER, messageId: 77 }],
    };
    writeFileSync(file, JSON.stringify({ version: 1, choices: { alt1: old } }));
    const bot = startBot();
    const expired = await bot.sweep();
    expect(expired.map(c => c.id)).toEqual(["alt1"]);
    expect(edits).toEqual([
      { chatId: USER, messageId: 77, text: "Frage alt\n\nAbgelaufen, nichts geändert", other: { link_preview_options: { is_disabled: true } } },
    ]);
    expect(JSON.parse(readFileSync(file, "utf-8")).choices).toEqual({});
    // Zweiter Abgleich bearbeitet nichts mehr, die Frage bleibt unentscheidbar
    expect(await startBot().sweep()).toEqual([]);
    expect(edits).toHaveLength(1);
    expect((await decideChoice("alt1", "y", "telegram")).status).toBe("unknown");
  });

  test("Frage älter als 7 Tage mit Telegram-Nachricht: vor dem Abgleich schon abgelaufen, nicht entscheidbar", async () => {
    const now = Date.now();
    const old: Choice = {
      id: "alt2", kind: "tool", conversation: { type: "telegram", chatId: USER }, text: "Frage alt",
      options: [{ key: "y", label: "Erlauben" }], state: "open", createdAt: now - 8 * 24 * 3_600_000,
      telegram: [{ chatId: USER, messageId: 78 }],
    };
    writeFileSync(file, JSON.stringify({ version: 1, choices: { alt2: old } }));
    startBot();
    let runs = 0;
    cleanup.push(onChoiceDecided("tool", () => { runs++; }));
    // Eine andere Änderung räumt zuerst auf: Eintrag bleibt als expired für den Abgleich
    await createChoice(input());
    expect(JSON.parse(readFileSync(file, "utf-8")).choices.alt2.state).toBe("expired");
    expect((await decideChoice("alt2", "y", "telegram")).status).toBe("expired");
    expect(runs).toBe(0);
    expect((await expireLapsedChoices()).map(c => c.id)).toEqual(["alt2"]);
    expect(edits.map(e => e.messageId)).toEqual([78]);
    expect(JSON.parse(readFileSync(file, "utf-8")).choices.alt2).toBeUndefined();
  });

  test("expireLapsedChoices ohne Zuhörer: speichert trotzdem", async () => {
    const c = await createChoice(input({ expiresAt: Date.now() - 1 }));
    expect((await expireLapsedChoices()).map(x => x.id)).toEqual([c.id]);
    expect(JSON.parse(readFileSync(file, "utf-8")).choices[c.id].state).toBe("expired");
  });

  test("src/bot.ts ruft den Abgleich beim Start und danach regelmäßig", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "bot.ts"), "utf8");
    const sweep = source.indexOf("const sweepChoices = () => telegramChoices.sweep()");
    expect(sweep).toBeGreaterThan(-1);
    const block = source.slice(sweep, source.indexOf("bot.start({", sweep));
    expect(block).toContain("void sweepChoices();");
    expect(block).toMatch(/setInterval\(\(\) => \{ void sweepChoices\(\); \}, 60_000\)\.unref\(\);/);
  });
});
