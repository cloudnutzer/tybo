/**
 * Issue #333: Gedächtnis-Befehle (/remember, /forget, /memory, /track,
 * /done, /cancel, /recall samt /search und /find) über die gemeinsame
 * Befehls-Schicht in Browser und Terminal, mit dem echten Befehls-Port
 * (createBotCommands), dem echten Register und dem echten Gedächtnis-Dienst
 * auf der Datei (die Preload-Datei setzt MEMORY_FILE_PATH auf eine
 * Temp-Datei). Attrappen: Telegram-Versand, Nachrichtenspeicher, Suche.
 *
 * Gesprächsarten: Telegram-Direktchat und -Topic (gespiegelt), Direktchat
 * ohne Telegram ("web") und ein älteres reines Web-Gespräch.
 * Telegram-Schreibweisen ohne Schrägstrich prüft memory-commands-telegram.test.ts.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { commandRegistry, HELP_TEXT } from "../src/lib/commands/builtin";
import { MEMORY_COMMAND_TEXT as T, RECALL_LIMIT } from "../src/lib/commands/memory";
import type { CommandServices, MemoryCommandServices } from "../src/lib/commands/types";
import { addFact, addGoal, cancelGoal, completeGoal, deleteFact } from "../src/lib/memory";
import { getStore, resetStore } from "../src/lib/store";
import type { Message } from "../src/lib/store/types";
import type { SendAndRecordInput } from "../src/lib/outbox";
import { createBotCommands } from "../src/web/bot-commands";
import { webChatId } from "../src/web/bot-turn";
import type { CommandOutcome } from "../src/web/commands";

const FILE = process.env.MEMORY_FILE_PATH!;
const USER = "4711";
const GROUP = "-1001234567890";
const WEB_ID = "0c1a2b3c-0000-4000-8000-000000000333";
const CHANNELS = ["web", "terminal"] as const;
type Channel = (typeof CHANNELS)[number];

const restores: (() => void)[] = [];
let savedZone: string | undefined;
beforeEach(() => {
  rmSync(`${FILE}.sqlite`, { force: true });
  rmSync(FILE, { force: true });
  resetStore();
  savedZone = process.env.USER_TIMEZONE;
  process.env.USER_TIMEZONE = "Europe/Berlin";
  setSystemTime(new Date("2026-10-19T10:00:00.000Z"));
  const log = spyOn(console, "log").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  restores.push(() => log.mockRestore(), () => warn.mockRestore());
});
afterEach(() => {
  setSystemTime();
  while (restores.length) restores.pop()!();
  if (savedZone === undefined) delete process.env.USER_TIMEZONE;
  else process.env.USER_TIMEZONE = savedZone;
  resetStore();
});

interface SearchCall {
  chatId: string;
  query: string;
  limit: number;
}

/** Wie in src/bot.ts: Gedächtnis-Dienst und eine Such-Attrappe */
function realMemory(hits: Message[] = [], calls: SearchCall[] = []): MemoryCommandServices {
  return {
    addFact,
    deleteFact,
    addGoal,
    completeGoal,
    cancelGoal,
    facts: () => getStore().memory.facts(),
    searchMessages: async (chatId, query, limit) => (calls.push({ chatId, query, limit }), hits),
  };
}

const facts = async () => (await getStore().memory.facts()).map(f => f.content);
const goals = async () => (await getStore().memory.activeGoals()).map(g => ({ content: g.content, deadline: g.deadline ?? null }));

interface RunResult {
  /** Antworten: im älteren Web-Gespräch live, sonst über sendAndRecord */
  replies: string[];
  outcome: CommandOutcome;
  records: SendAndRecordInput[];
  mirrored: string[];
  saved: Message[];
}

interface RunOptions {
  conversationId?: string;
  /** Ohne Telegram: Direktchat "web" (Issue #227) */
  telegram?: boolean;
  services?: Partial<CommandServices>;
  memory?: MemoryCommandServices;
  /** Dienste unverändert an createBotCommands, ohne sie beim Aufbau zu lesen (Getter wirken erst im Befehl) */
  servicesAsIs?: CommandServices;
  /** Bekommt den Stopp-Controller des Befehls, z. B. um mitten im Ablauf zu stoppen */
  controller?: AbortController;
}

async function run(source: Channel, text: string, o: RunOptions = {}): Promise<RunResult> {
  const telegram = o.telegram ?? true;
  const records: SendAndRecordInput[] = [];
  const mirrored: string[] = [];
  const saved: Message[] = [];
  const replies: string[] = [];
  const unused = () => {
    throw new Error("nicht erwartet");
  };
  const services = o.servicesAsIs ?? ({ memory: o.memory ?? realMemory(), ...o.services } as CommandServices);
  const commands = createBotCommands({
    registry: commandRegistry,
    services,
    userId: telegram ? USER : "web",
    groupId: () => (telegram ? GROUP : null),
    agentForTopic: () => "research",
    sendPlain: async (_chatId, t) => void mirrored.push(t),
    sendAndRecord: async input => {
      records.push(input);
      replies.push(input.text);
      return { sent: telegram, recorded: true };
    },
    saveMessage: async m => (saved.push(m as Message), true),
    resetConversation: unused,
    runStreamingTurn: unused,
    processIntents: unused,
    sendAsAgent: unused,
    log: () => {},
  });
  const controller = o.controller ?? new AbortController();
  const outcome = await commands.run({
    conversationId: o.conversationId ?? "dm",
    agent: "general",
    text,
    source,
    messageId: "m1",
    receivedAt: new Date().toISOString(),
    signal: controller.signal,
    sink: {} as any,
    notice: async t => void replies.push(t),
    answer: async () => {},
    ask: async () => {},
    endAsk: () => {},
    commit: () => {},
  });
  return { replies, outcome, records, mirrored, saved };
}

describe("Register: Gedächtnis-Befehle in allen Kanälen", () => {
  test("Namen, Aliasse, Argumente", () => {
    for (const channel of ["telegram", "web", "terminal"] as const) {
      const name = (text: string) => commandRegistry.match(text, channel)?.command.name ?? null;
      expect(name("/remember Alex mag Tee")).toBe("remember");
      expect(name("/remember")).toBe("remember");
      expect(name("/forget Tee")).toBe("forget");
      expect(name("/memory")).toBe("memory");
      expect(name("/facts")).toBe("memory");
      expect(name("/memory x")).toBeNull();
      expect(name("/track Buch | deadline: morgen")).toBe("track");
      expect(name("/done Buch")).toBe("done");
      expect(name("/cancel Buch")).toBe("cancel");
      expect(name("/recall Urlaub")).toBe("recall");
      expect(name("/search Urlaub")).toBe("recall");
      expect(name("/find Urlaub")).toBe("recall");
      // Befehlsgrenzen: der Name endet an Leerraum oder am Ende
      expect(name("/remembering x")).toBeNull();
      expect(name("/donex")).toBeNull();
      expect(name("/recalled x")).toBeNull();
    }
  });

  test("frühere Schreibweisen ohne Schrägstrich gelten nur in Telegram", () => {
    for (const channel of ["web", "terminal"] as const) {
      for (const text of ["remember: x", "forget: x", "track: x", "done: x", "cancel: x", "memory", "facts", "recall x", "search x", "find x"]) {
        expect({ text, match: commandRegistry.match(text, channel) }).toEqual({ text, match: null });
      }
    }
  });

  test("Liste je Kanal und Spickzettel nennen die Befehle", () => {
    for (const channel of ["telegram", "web", "terminal"] as const) {
      const names = commandRegistry.list(channel).map(c => c.name);
      for (const n of ["remember", "forget", "memory", "track", "done", "cancel", "recall"]) expect(names).toContain(n);
    }
    const recall = commandRegistry.list("web").find(c => c.name === "recall")!;
    expect(recall).toEqual({ name: "recall", aliases: ["search", "find"], description: expect.any(String), args: "optional", argsHint: "<frage>" });
    for (const hint of ["/remember <fakt>", "/forget <text>", "/track <ziel>", "/done <text>", "/cancel <text>", "/recall <frage>"]) {
      expect(HELP_TEXT).toContain(hint);
    }
  });
});

describe.each(CHANNELS)("%s: Schreiben", source => {
  test("/remember speichert den Fakt, deutsche Antwort, gespiegelt und festgehalten", async () => {
    const r = await run(source, "/remember   Alex trinkt morgens Tee  ");
    expect(r.outcome).toEqual({});
    expect(r.replies).toEqual([T.remembered]);
    expect(await facts()).toEqual(["Alex trinkt morgens Tee"]);
    expect(r.mirrored).toEqual([`Du (${source === "web" ? "Web" : "Terminal"}): /remember   Alex trinkt morgens Tee  `]);
    expect(r.saved.map(m => [m.role, m.content])).toEqual([["user", "/remember   Alex trinkt morgens Tee  "]]);
    expect(r.records.map(x => [x.source, x.format])).toEqual([["befehl", "plain"]]);
  });

  test("/forget löscht per Teiltext, sonst deutscher Hinweis ohne Änderung", async () => {
    await addFact("Alex trinkt morgens Tee");
    await addFact("Mia spielt Cello");
    expect((await run(source, "/forget kein Treffer")).replies).toEqual([T.noFact("kein Treffer")]);
    expect(await facts()).toEqual(["Alex trinkt morgens Tee", "Mia spielt Cello"]);
    expect((await run(source, "/forget cello")).replies).toEqual([T.forgotten]);
    expect(await facts()).toEqual(["Alex trinkt morgens Tee"]);
  });

  test("/track legt ein Ziel an, mit Frist aus „| deadline:“", async () => {
    expect((await run(source, "/track Buch fertig schreiben")).replies).toEqual([T.tracked("Buch fertig schreiben")]);
    expect((await run(source, "/track Steuer abgeben | deadline: 2026-12-01")).replies).toEqual([T.tracked("Steuer abgeben", "2026-12-01")]);
    expect((await run(source, "/track Garten | Deadline: morgen")).replies).toEqual([T.tracked("Garten", "morgen")]);
    const list = await goals();
    expect(list.map(g => g.content)).toEqual(["Buch fertig schreiben", "Steuer abgeben", "Garten"]);
    expect(list[0].deadline).toBeNull();
    expect(new Date(list[1].deadline!).toISOString().slice(0, 10)).toBe("2026-12-01");
    // „morgen“ in USER_TIMEZONE: 20.10.2026
    expect(new Date(list[2].deadline!).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" })).toBe("20.10.2026");
    expect(T.tracked("Garten", "morgen")).toBe("Ziel notiert: „Garten\" (Frist: morgen).");
  });

  test("/track mit übergroßer Frist: nichts gespeichert, Fehlertext statt Erfolg", async () => {
    const r = await run(source, "/track Riesig | deadline: in 99999999999 days");
    expect(r.replies).toEqual([T.failed]);
    expect(await goals()).toEqual([]);
  });

  test("/done und /cancel ändern gespeicherte Ziele per Teiltext", async () => {
    await addGoal("Buch fertig schreiben");
    await addGoal("Steuer abgeben");
    expect((await run(source, "/done Urlaub")).replies).toEqual([T.noGoal("Urlaub")]);
    expect((await run(source, "/done buch")).replies).toEqual([T.completed]);
    expect((await run(source, "/cancel buch")).replies).toEqual([T.noGoal("buch")]);
    expect((await run(source, "/cancel steuer")).replies).toEqual([T.cancelled]);
    expect(await goals()).toEqual([]);
  });

  test("fehlende Argumente: Nutzungshinweis, keine Änderung", async () => {
    await addFact("bleibt");
    for (const [text, usage] of [
      ["/remember", T.usage.remember],
      ["/forget", T.usage.forget],
      ["/track", T.usage.track],
      ["/track   | deadline: morgen", T.usage.track],
      ["/done", T.usage.done],
      ["/cancel", T.usage.cancel],
      ["/recall", T.usage.recall],
      ["/search", T.usage.recall],
    ] as const) {
      expect({ text, replies: (await run(source, text)).replies }).toEqual({ text, replies: [usage] });
    }
    expect(await facts()).toEqual(["bleibt"]);
    expect(await goals()).toEqual([]);
  });

  test("Speichern scheitert: Fehlertext, nie ein falscher Erfolg", async () => {
    const memory = { ...realMemory(), addFact: async () => false, completeGoal: async () => Promise.reject(new Error("weg")) };
    expect((await run(source, "/remember x", { memory })).replies).toEqual([T.failed]);
    expect((await run(source, "/done x", { memory })).replies).toEqual([T.failed]);
  });

  test("ohne Gedächtnis-Dienst: deutscher Hinweis", async () => {
    const r = await run(source, "/remember x", { services: { memory: undefined } });
    expect(r.replies).toEqual([T.unavailable]);
  });
});

describe.each(CHANNELS)("%s: Stopp", source => {
  test.each(["/remember nie gespeichert", "/forget Tee", "/track Buch | deadline: morgen", "/done Buch", "/cancel Buch"])(
    "Stopp im laufenden Befehl direkt vor beginWrite (%s): kein Schreibaufruf, keine Änderung, Abbruch",
    async text => {
      await addFact("Alex trinkt Tee");
      await addGoal("Buch fertig");
      const before = { facts: await facts(), goals: await goals() };
      const controller = new AbortController();
      const writes: string[] = [];
      const spy = (name: string, fn: (...a: any[]) => Promise<boolean>) => async (...a: any[]) => (writes.push(name), fn(...a));
      const memory: MemoryCommandServices = {
        ...realMemory(),
        addFact: spy("addFact", addFact),
        deleteFact: spy("deleteFact", deleteFact),
        addGoal: spy("addGoal", addGoal),
        completeGoal: spy("completeGoal", completeGoal),
        cancelGoal: spy("cancelGoal", cancelGoal),
      };
      // Der Befehls-Handler holt den Dienst unmittelbar vor beginWrite; erst dort kommt der Stopp
      let stoppedBeforeHandler: boolean | undefined;
      const services = {
        get memory() {
          if (stoppedBeforeHandler === undefined) {
            stoppedBeforeHandler = controller.signal.aborted;
            controller.abort();
          }
          return memory;
        },
      } as CommandServices;
      const r = await run(source, text, { servicesAsIs: services, controller });
      // Handler erreicht, und zwar ohne vorherigen Stopp
      expect(stoppedBeforeHandler).toBe(false);
      expect(writes).toEqual([]);
      expect({ facts: await facts(), goals: await goals() }).toEqual(before);
      expect(r.outcome).toEqual({ aborted: true });
      expect(r.replies).toEqual([]);
    }
  );

  test("Stopp nach dem Schreibbeginn: gespeichert, Antwort sichtbar, kein Abbruch gemeldet", async () => {
    const controller = new AbortController();
    const memory = { ...realMemory(), addFact: async (t: string) => (controller.abort(), addFact(t)) };
    const r = await run(source, "/remember trotzdem gespeichert", { memory, controller });
    expect(r.outcome).toEqual({});
    expect(r.replies).toEqual([T.remembered]);
    expect(await facts()).toEqual(["trotzdem gespeichert"]);
  });
});

describe.each(CHANNELS)("%s: Lesen", source => {
  test("/memory und /facts listen die Fakten, leer ein deutscher Satz", async () => {
    expect((await run(source, "/memory")).replies).toEqual([T.noFacts]);
    await addFact("Alex trinkt morgens Tee");
    await addFact("Mia spielt Cello");
    const r = await run(source, "/facts");
    expect(r.replies).toEqual([`**${T.factsTitle}**\n- Alex trinkt morgens Tee\n- Mia spielt Cello`]);
    expect(r.records[0].format).toBe("markdown");
    expect(T.noFacts).not.toMatch(/stored|No /);
  });

  test("/recall: Suche im Chat des Gesprächs, fünf Treffer, bereinigt vor dem Kürzen", async () => {
    const calls: SearchCall[] = [];
    const long = `​${"a".repeat(250)}`;
    const hits: Message[] = [
      { chat_id: USER, role: "user", content: "Wann war der Urlaub?", created_at: "2026-08-03T22:30:00.000Z" },
      { chat_id: USER, role: "assistant", content: long, created_at: "2026-08-05T09:00:00.000Z" },
      { chat_id: USER, role: "assistant", content: "Bild ![Strand](https://x.invalid/a.png) dazu" },
    ];
    const r = await run(source, "/recall   Urlaub\n im  Sommer", { memory: realMemory(hits, calls) });
    expect(calls).toEqual([{ chatId: USER, query: "Urlaub im Sommer", limit: RECALL_LIMIT }]);
    expect(RECALL_LIMIT).toBe(5);
    expect(r.replies).toEqual([
      `**${T.hitsTitle("Urlaub im Sommer")}**\n\n` +
        "1. [4.8.2026] Du: Wann war der Urlaub?\n\n" +
        `2. [5.8.2026] tybo: ${"a".repeat(200)}...\n\n` +
        `3. [${T.unknownDate}] tybo: Bild Strand dazu`,
    ]);
  });

  test("/search und /find wie /recall, ohne Treffer ein deutscher Satz", async () => {
    expect((await run(source, "/search Urlaub")).replies).toEqual([T.noHits("Urlaub")]);
    expect((await run(source, "/find Urlaub")).replies).toEqual([T.noHits("Urlaub")]);
  });

  test("/recall: Suche scheitert, deutscher Hinweis", async () => {
    const memory = { ...realMemory(), searchMessages: async () => Promise.reject(new Error("db")) };
    expect((await run(source, "/recall Urlaub", { memory })).replies).toEqual([T.searchFailed]);
  });

  test("/recall sucht im richtigen Chat: Topic, Direktchat ohne Telegram, älteres Web-Gespräch", async () => {
    const calls: SearchCall[] = [];
    const memory = realMemory([], calls);
    await run(source, "/recall a", { memory, conversationId: "topic-443" });
    await run(source, "/recall b", { memory, telegram: false });
    const web = await run(source, "/recall c", { memory, conversationId: WEB_ID, telegram: false });
    expect(calls.map(c => c.chatId)).toEqual([GROUP, "web", webChatId(WEB_ID)]);
    // Älteres Web-Gespräch: nichts nach Telegram, Antwort im eigenen Verlauf
    expect(web.mirrored).toEqual([]);
    expect(web.records).toEqual([]);
    expect(web.replies).toEqual([T.noHits("c")]);
  });
});

describe.each(CHANNELS)("%s: reine Web-Gespräche ohne Telegram", source => {
  test("Direktchat ohne Telegram: Speichern wirkt, Antwort nur in der WebUI", async () => {
    const r = await run(source, "/remember ohne Telegram", { telegram: false });
    expect(r.replies).toEqual([T.remembered]);
    expect(r.mirrored).toEqual([]);
    expect(r.records.map(x => x.chatId)).toEqual(["web"]);
    expect(await facts()).toEqual(["ohne Telegram"]);
  });

  test("älteres Web-Gespräch: alle Befehle wirken", async () => {
    const opts = { conversationId: WEB_ID, telegram: false };
    expect((await run(source, "/track Web-Ziel", opts)).replies).toEqual([T.tracked("Web-Ziel")]);
    expect((await run(source, "/done web-ziel", opts)).replies).toEqual([T.completed]);
    expect((await run(source, "/remember Web-Fakt", opts)).replies).toEqual([T.remembered]);
    expect((await run(source, "/memory", opts)).replies).toEqual([`**${T.factsTitle}**\n- Web-Fakt`]);
    expect((await run(source, "/forget Web", opts)).replies).toEqual([T.forgotten]);
    expect(await facts()).toEqual([]);
  });
});
