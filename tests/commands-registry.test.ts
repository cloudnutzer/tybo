import { describe, expect, test } from "bun:test";
import { BUILTIN_COMMANDS, commandRegistry } from "../src/lib/commands/builtin";
import { createCommandRegistry } from "../src/lib/commands/registry";
import { createTelegramCommandContext } from "../src/lib/commands/telegram";
import type { CommandDefinition, CommandServices } from "../src/lib/commands/types";

const name = (text: string, channel: "telegram" | "web" | "terminal" = "web") => commandRegistry.match(text, channel)?.command.name ?? null;

describe("Befehls-Register: Erkennung", () => {
  test("umgestellte Befehle in allen drei Kanälen", () => {
    for (const channel of ["telegram", "web", "terminal"] as const) {
      expect(name("/new", channel)).toBe("new");
      expect(name("/stop", channel)).toBe("stop");
      expect(name("/agent research: kürzer", channel)).toBe("agent");
      expect(name("/topics", channel)).toBe("topics");
      expect(name("/help", channel)).toBe("help");
      expect(name("/goals", channel)).toBe("goals");
      expect(name("/learn https://example.org", channel)).toBe("learn");
      expect(name("/plan", channel)).toBe("plan");
      expect(name("/critic Idee", channel)).toBe("critic");
      expect(name("/routine", channel)).toBe("routine");
      expect(name("/board", channel)).toBe("board");
      expect(name("/board Newsletter starten?", channel)).toBe("board");
    }
  });

  test("/board (Issue #75): Thema optional; „board meeting“ ohne Schrägstrich nur in Telegram, wie bisher", () => {
    expect(commandRegistry.match("/board Preis erhöhen", "web")).toMatchObject({ args: "Preis erhöhen", command: { name: "board" } });
    expect(commandRegistry.match("/board", "terminal")).toMatchObject({ args: "", command: { name: "board" } });
    expect(name("board meeting", "telegram")).toBe("board");
    expect(name("Board Meeting", "telegram")).toBe("board");
    expect(name("board meeting", "web")).toBeNull();
    expect(name("board meeting heute", "telegram")).toBeNull();
    // Wie die frühere if-Kette: in Telegram nur mit Leerzeichen nach /board
    expect(name("/board\nThema", "telegram")).toBeNull();
    expect(name("/boardroom", "web")).toBeNull();
  });

  test("Aliase /reset, /abbruch, /hilfe; Groß- und Kleinschreibung und Rand egal", () => {
    expect(commandRegistry.match("/reset", "web")).toMatchObject({ invoked: "reset", command: { name: "new" } });
    expect(name("/abbruch")).toBe("stop");
    expect(name("/hilfe")).toBe("help");
    expect(name("  /NEW  ")).toBe("new");
  });

  test("goals ohne Schrägstrich nur in Telegram", () => {
    expect(name("goals", "telegram")).toBe("goals");
    expect(name("Goals", "telegram")).toBe("goals");
    expect(name("goals", "web")).toBeNull();
    expect(name("goals", "terminal")).toBeNull();
  });

  test("Befehlsgrenze: /newspaper ist nicht /new, /stopp nicht /stop", () => {
    expect(name("/newspaper")).toBeNull();
    expect(name("/stopp")).toBeNull();
    expect(name("/agents")).toBeNull();
    expect(name("/helpme")).toBeNull();
  });

  test("/k3 und unbekannte Befehle sind keine Befehle (gehen als Text an Claude)", () => {
    for (const channel of ["telegram", "web", "terminal"] as const) {
      expect(name("/k3 x", channel)).toBeNull();
      expect(name("/k3", channel)).toBeNull();
      expect(name("/foo", channel)).toBeNull();
      expect(name("/foo bar", channel)).toBeNull();
    }
  });

  test("Argumente: none nur allein, required nur mit", () => {
    // wie früher: "/new foo" war in Telegram kein Befehl
    expect(name("/new foo")).toBeNull();
    expect(name("/help mich")).toBeNull();
    expect(name("/critic")).toBeNull();
    expect(name("/critic   ")).toBeNull();
    expect(commandRegistry.match("/critic\nzweite Zeile", "web")?.args).toBe("zweite Zeile");
    expect(commandRegistry.match("/agent  research: antworte kuerzer ", "web")?.args).toBe("research: antworte kuerzer");
    expect(commandRegistry.match("/routine", "web")?.args).toBe("");
  });

  test("/voice in allen Kanälen, nur mit Text (Issue #78)", () => {
    for (const channel of ["telegram", "web", "terminal"] as const) {
      expect(name("/voice hallo", channel)).toBe("voice");
      expect(name("/voice", channel)).toBeNull();
    }
  });

  test("Telegram erkennt genau wie die frühere if-Kette in src/bot.ts (Trennzeichen nach dem Namen)", () => {
    // Nachbau der früheren Prüfungen (webui vor #74): text getrimmt, lowerText klein
    function before(raw: string): string | null {
      const lowerText = raw.trim().toLowerCase();
      const exact = (...names: string[]) => names.includes(lowerText);
      const withSpace = (n: string) => lowerText === n || lowerText.startsWith(`${n} `);
      const spaceOrLine = (n: string) => lowerText.startsWith(`${n} `) || lowerText.startsWith(`${n}\n`);
      if (exact("goals", "/goals")) return "goals";
      if (exact("/topics")) return "topics";
      if (exact("/new", "/reset")) return "new";
      if (withSpace("/routine")) return "routine";
      if (withSpace("/plan")) return "plan";
      if (exact("/help", "/hilfe")) return "help";
      if (exact("/stop", "/abbruch")) return "stop";
      if (withSpace("/agent")) return "agent";
      if (withSpace("/learn")) return "learn";
      if (spaceOrLine("/critic") && raw.trim().slice("/critic".length).trim()) return "critic";
      if (spaceOrLine("/voice") && raw.trim().slice("/voice".length).trim()) return "voice";
      return null;
    }
    const heads = ["/agent", "/learn", "/plan", "/routine", "/critic", "/voice", "/new", "/help", "/stop", "/topics", "/goals", "goals"];
    const tails = ["", " x", "  x", "\tx", "\nx", " x", "\r\nx", " ", "\t", "\n", "x", " \tx", "\n x"];
    for (const head of heads) {
      for (const tail of tails) {
        for (const text of [`${head}${tail}`, `  ${head.toUpperCase()}${tail}  `]) {
          expect({ text, name: name(text, "telegram") }).toEqual({ text, name: before(text) });
        }
      }
    }
    // Browser und Terminal nehmen jeden Leerraum
    expect(name("/agent\tresearch", "web")).toBe("agent");
    expect(name("/learn\nText", "terminal")).toBe("learn");
    expect(name("/agent\tresearch", "telegram")).toBeNull();
    expect(name("/routine\nHinweis", "telegram")).toBeNull();
    expect(name("/critic\nIdee", "telegram")).toBe("critic");
  });

  test("/memory, /tasks, /credit bleiben vorerst in src/bot.ts; /goal kommt aus dem Register (Issue #76)", () => {
    expect(name("/goal x", "telegram")).toBe("goal");
    for (const text of ["/memory", "/tasks", "/credit", "/k3 x"]) {
      expect(name(text, "telegram")).toBeNull();
    }
  });
});

describe("Befehls-Register: Liste je Kanal", () => {
  test("Name, Beschreibung, Argumente; /voice überall (Issue #78)", () => {
    const web = commandRegistry.list("web");
    const names = web.map(c => c.name);
    expect(names).toEqual(["help", "stop", "new", "topics", "agent", "goal", "goals", "learn", "plan", "critic", "board", "routine", "jobs", "voice"]);
    expect(commandRegistry.list("terminal").map(c => c.name)).toEqual(names);
    expect(commandRegistry.list("telegram").map(c => c.name)).toEqual(names);
    expect(web.find(c => c.name === "voice")).toEqual({ name: "voice", aliases: [], description: "Antwort als Sprachnachricht", args: "required", argsHint: "<text>" });
    const critic = web.find(c => c.name === "critic")!;
    expect(critic).toEqual({ name: "critic", aliases: [], description: expect.any(String), args: "required", argsHint: "<idee>" });
    expect(web.find(c => c.name === "new")!.aliases).toEqual(["reset"]);
    // keine Funktionen in der Liste
    expect(JSON.parse(JSON.stringify(web))).toEqual(web);
  });

  test("doppelte Namen werden abgelehnt", () => {
    const dup: CommandDefinition = { ...BUILTIN_COMMANDS[0], name: "x", aliases: ["hilfe"] };
    expect(() => createCommandRegistry([...BUILTIN_COMMANDS, dup])).toThrow();
  });

  test("k3 ist nirgends mehr registriert", () => {
    for (const c of BUILTIN_COMMANDS) expect([c.name, ...c.aliases]).not.toContain("k3");
  });
});

describe("Telegram-Kontext", () => {
  const services = {} as CommandServices;
  function context() {
    const calls: { text: string; other?: Record<string, unknown> }[] = [];
    let failHtml = false;
    const chat = {
      async reply(text: string, other?: Record<string, unknown>) {
        if (failHtml && other?.parse_mode === "HTML") throw new Error("400");
        calls.push(other ? { text, other } : { text });
      },
    };
    const ctx = createTelegramCommandContext({
      chat,
      chatId: "-100",
      topicId: 7,
      sessionKey: "topic:-100:7",
      agent: "research",
      text: "/agent x",
      match: commandRegistry.match("/agent x", "telegram")!,
      services,
      working: () => () => {},
      resetSession: async () => ({ status: "done", reset: 1, sessionMode: true }),
      agentTurn: async () => {},
      boardMeeting: async () => {},
    });
    return { ctx, calls, failHtml: () => (failHtml = true) };
  }

  test("Gespräch und Befehl im Kontext", () => {
    const { ctx } = context();
    expect(ctx).toMatchObject({ channel: "telegram", chatId: "-100", topicId: 7, sessionKey: "topic:-100:7", agent: "research", name: "agent", args: "x" });
  });

  test("reply: Klartext ohne Optionen, Markdown als HTML mit Klartext-Rückfall", async () => {
    const t = context();
    await t.ctx.reply("a_b");
    await t.ctx.reply("**fett**", { format: "markdown" });
    expect(t.calls).toEqual([{ text: "a_b" }, { text: "<b>fett</b>", other: { parse_mode: "HTML" } }]);
    t.failHtml();
    await t.ctx.reply("**x**", { format: "markdown", plainFallback: "x" });
    await t.ctx.reply("**y**", { format: "markdown" });
    expect(t.calls.slice(2)).toEqual([{ text: "x" }, { text: "**y**" }]);
  });

  test("buttons als inline_keyboard", async () => {
    const t = context();
    await t.ctx.buttons("Wählen", [[{ label: "Ja", action: "a:1" }]]);
    expect(t.calls).toEqual([{ text: "Wählen", other: { reply_markup: { inline_keyboard: [[{ text: "Ja", callback_data: "a:1" }]] } } }]);
  });
});
