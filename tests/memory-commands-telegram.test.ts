/**
 * Issue #333, Checkbox 2: Gedächtnis-Befehle in Telegram über das Register,
 * mit den früheren Schreibweisen als Alias („remember: …", „forget: …",
 * „track: … | deadline: …", „done: …", „cancel: …", „memory", „facts",
 * „/memory", „recall …", „search …", „find …"). Echter Gedächtnis-Dienst auf
 * der Datei (Preload setzt MEMORY_FILE_PATH), Telegram als Attrappe.
 * src/bot.ts ruft für jede Textnachricht commandRegistry.match(text,
 * "telegram") und runTelegramCommand auf; genau das tut run() hier.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { commandRegistry } from "../src/lib/commands/builtin";
import { MEMORY_COMMAND_TEXT as T } from "../src/lib/commands/memory";
import { runTelegramCommand } from "../src/lib/commands/telegram";
import type { CommandServices, MemoryCommandServices } from "../src/lib/commands/types";
import { addFact, addGoal, cancelGoal, completeGoal, deleteFact } from "../src/lib/memory";
import { getStore, resetStore } from "../src/lib/store";
import type { Message } from "../src/lib/store/types";
import { markdownToTelegramHTML } from "../src/lib/telegram";

const FILE = process.env.MEMORY_FILE_PATH!;
const GROUP = "-1001234567890";

const restores: (() => void)[] = [];
beforeEach(() => {
  rmSync(`${FILE}.sqlite`, { force: true });
  rmSync(FILE, { force: true });
  resetStore();
  setSystemTime(new Date("2026-10-19T10:00:00.000Z"));
  const log = spyOn(console, "log").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  restores.push(() => log.mockRestore(), () => warn.mockRestore());
});
afterEach(() => {
  setSystemTime();
  while (restores.length) restores.pop()!();
  resetStore();
});

const searches: { chatId: string; query: string }[] = [];
let hits: Message[] = [];
const memory: MemoryCommandServices = {
  addFact,
  deleteFact,
  addGoal,
  completeGoal,
  cancelGoal,
  facts: () => getStore().memory.facts(),
  searchMessages: async (chatId, query) => (searches.push({ chatId, query }), hits),
};

const facts = async () => (await getStore().memory.facts()).map(f => f.content);
const goals = async () => (await getStore().memory.activeGoals()).map(g => g.content);

interface Sent {
  text: string;
  html: boolean;
}

/** Wie handleTextMessage in src/bot.ts: Register fragen, sonst ginge die Nachricht an Claude */
async function run(text: string, opts: { typing?: string[] } = {}): Promise<Sent[] | "claude"> {
  const match = commandRegistry.match(text, "telegram");
  if (!match) return "claude";
  const sent: Sent[] = [];
  await runTelegramCommand({
    chat: { reply: async (t, other) => void sent.push({ text: t, html: other?.parse_mode === "HTML" }) },
    chatId: GROUP,
    topicId: 12,
    sessionKey: `topic:${GROUP}:12`,
    agent: "general",
    text,
    match,
    services: { memory } as CommandServices,
    working: () => {
      opts.typing?.push("start");
      return () => opts.typing?.push("stop");
    },
    resetSession: async () => ({ status: "unavailable" }),
    agentTurn: async () => undefined,
    boardMeeting: async () => {},
  });
  return sent;
}

const plain = (text: string): Sent => ({ text, html: false });

describe("Telegram: frühere Schreibweisen als Alias", () => {
  test("remember: und forget: (Groß- und Kleinschreibung egal)", async () => {
    expect(await run("remember: Alex trinkt Tee")).toEqual([plain(T.remembered)]);
    expect(await run("  Remember:Mia spielt Cello  ")).toEqual([plain(T.remembered)]);
    expect(await facts()).toEqual(["Alex trinkt Tee", "Mia spielt Cello"]);
    expect(await run("FORGET: cello")).toEqual([plain(T.forgotten)]);
    expect(await run("forget: gibt es nicht")).toEqual([plain(T.noFact("gibt es nicht"))]);
    expect(await facts()).toEqual(["Alex trinkt Tee"]);
  });

  test("track: mit und ohne Frist, done: und cancel:", async () => {
    expect(await run("track: Buch fertig")).toEqual([plain(T.tracked("Buch fertig"))]);
    expect(await run("track: Steuer | deadline: 2026-12-01")).toEqual([plain(T.tracked("Steuer", "2026-12-01"))]);
    const stored = await getStore().memory.activeGoals();
    expect(stored.map(g => [g.content, g.deadline ? new Date(g.deadline).toISOString().slice(0, 10) : null])).toEqual([
      ["Buch fertig", null],
      ["Steuer", "2026-12-01"],
    ]);
    expect(await run("done: buch")).toEqual([plain(T.completed)]);
    expect(await run("cancel: Steuer")).toEqual([plain(T.cancelled)]);
    expect(await run("done: Urlaub")).toEqual([plain(T.noGoal("Urlaub"))]);
    expect(await goals()).toEqual([]);
  });

  test("track: speichert Zieltext und Frist wie die frühere Zerlegung", async () => {
    const stored = async () =>
      (await getStore().memory.activeGoals()).map(g => [g.content, g.deadline ? new Date(g.deadline).toISOString().slice(0, 10) : null]);
    // Leerer Fristmarker: keine Frist, der ganze Text ist das Ziel
    expect(await run("track: Wartung | deadline:")).toEqual([plain(T.tracked("Wartung | deadline:"))]);
    // Mehrzeilig: die Frist ist einzeilig bis zum Ende, sonst gilt alles als Ziel
    expect(await run("track: Bericht | deadline: 2026-12-01\nmit Anhang")).toEqual([
      plain(T.tracked("Bericht | deadline: 2026-12-01\nmit Anhang")),
    ]);
    expect(await run("track: Umzug\n| deadline:\n2026-11-15")).toEqual([plain(T.tracked("Umzug", "2026-11-15"))]);
    expect(await stored()).toEqual([
      ["Wartung | deadline:", null],
      ["Bericht | deadline: 2026-12-01\nmit Anhang", null],
      ["Umzug", "2026-11-15"],
    ]);
  });

  test("track: ohne Zieltext vor der Frist geht wie bisher an Claude, nichts gespeichert", async () => {
    for (const text of ["track: | deadline: morgen", "track:   |deadline: 2026-12-01", "Track:\n| deadline: morgen"]) {
      expect({ text, result: await run(text) }).toEqual({ text, result: "claude" });
    }
    expect(await goals()).toEqual([]);
  });

  test("memory, facts und /memory zeigen die Fakten (HTML), leer ein deutscher Satz", async () => {
    expect(await run("memory")).toEqual([plain(T.noFacts)]);
    await addFact("Alex trinkt Tee");
    const html = { text: markdownToTelegramHTML(`**${T.factsTitle}**\n- Alex trinkt Tee`), html: true };
    for (const text of ["memory", "Facts", "/memory", "/facts"]) expect(await run(text)).toEqual([html]);
  });

  test("recall, search und find suchen im Chat, mit Tippt-Anzeige", async () => {
    searches.length = 0;
    hits = [{ chat_id: GROUP, role: "user", content: "Urlaub in Rom", created_at: "2026-08-04T10:00:00.000Z" }];
    const typing: string[] = [];
    const expected = [{ text: markdownToTelegramHTML(`**${T.hitsTitle("Urlaub Rom")}**\n\n1. [4.8.2026] Du: Urlaub in Rom`), html: true }];
    process.env.USER_TIMEZONE = "Europe/Berlin";
    try {
      expect(await run("recall Urlaub   Rom", { typing })).toEqual(expected);
      expect(await run("Search Urlaub Rom")).toEqual(expected);
      expect(await run("find Urlaub Rom")).toEqual(expected);
      expect(await run("/recall Urlaub Rom")).toEqual(expected);
    } finally {
      delete process.env.USER_TIMEZONE;
    }
    expect(typing).toEqual(["start", "stop"]);
    expect(searches).toEqual(Array.from({ length: 4 }, () => ({ chatId: GROUP, query: "Urlaub Rom" })));
    hits = [];
    expect(await run("recall nichts")).toEqual([plain(T.noHits("nichts"))]);
  });

  test("ohne Text dahinter wie bisher kein Befehl, die Nachricht geht an Claude", async () => {
    for (const text of ["remember:", "remember:   ", "forget:", "track:", "done:", "cancel:", "recall", "recall ", "search", "find"]) {
      expect({ text, result: await run(text) }).toEqual({ text, result: "claude" });
    }
    expect(await facts()).toEqual([]);
  });

  test("Befehlsgrenzen: nur am Anfang und mit dem bisherigen Trennzeichen", async () => {
    for (const text of [
      "bitte remember: x",
      "remember x",
      "recalls x",
      "recall\tx",
      "finder x",
      "memory x",
      "memorys",
      "/memory x",
      "searching x",
      "track x",
      "done x",
      "cancelled: x",
    ]) {
      expect({ text, result: await run(text) }).toEqual({ text, result: "claude" });
    }
  });

  test("erkennt genau wie die frühere Kette in handleTextMessage", () => {
    // Nachbau der früheren Prüfungen (vor #333): text getrimmt, lowerText klein, Argument nicht leer
    function before(raw: string): string | null {
      const text = raw.trim();
      const lower = text.toLowerCase();
      const prefixed = (p: string) => lower.startsWith(p) && text.slice(p.length).trim() !== "";
      if (prefixed("remember:")) return "remember";
      if (lower.startsWith("track:")) {
        // Frühere Fristzerlegung: Befehl nur mit Zieltext vor der Frist
        const body = text.slice(6).trim();
        const cut = /\|\s*deadline:\s*(.+)$/i.exec(body)?.index;
        if ((cut === undefined ? body : body.slice(0, cut).trim()) !== "") return "track";
      }
      if (prefixed("done:")) return "done";
      if (prefixed("forget:")) return "forget";
      if (prefixed("cancel:")) return "cancel";
      if (["memory", "facts", "/memory"].includes(lower)) return "memory";
      if (["recall ", "search ", "find "].some(p => lower.startsWith(p)) && text.split(/\s+/).slice(1).join(" ")) return "recall";
      return null;
    }
    const heads = ["remember:", "forget:", "track:", "done:", "cancel:", "memory", "facts", "/memory", "recall", "search", "find"];
    const tails = [
      "",
      " x",
      "x",
      "  x  ",
      "\nx",
      " ",
      "\t",
      ": x",
      "s x",
      " | deadline: morgen",
      " | deadline:",
      " x | deadline:",
      " x | deadline: morgen",
      " x\n| deadline: morgen",
      " | deadline: morgen\nmehr",
      " x | deadline:\nmorgen",
    ];
    for (const head of heads) {
      for (const tail of tails) {
        for (const text of [`${head}${tail}`, `  ${head.toUpperCase()}${tail}  `]) {
          const now = commandRegistry.match(text, "telegram")?.command.name ?? null;
          expect({ text, name: now }).toEqual({ text, name: before(text) });
        }
      }
    }
  });
});
