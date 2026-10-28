/**
 * Issue #290, Checkbox 5: /faeden (Alias /threads) in Telegram, Browser und
 * Terminal über die gemeinsame Befehls-Schicht, dazu /help.
 * Issue #291: feste Nummern, /faeden zu <nr> (auch erledigt), /faeden alle.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { commandRegistry, HELP_TEXT } from "../src/lib/commands/builtin";
import { runTelegramCommand } from "../src/lib/commands/telegram";
import type { CommandServices } from "../src/lib/commands/types";
import { deadlineText, formatClosedThreads, formatThreadList, threadAge, THREADS_TEXT } from "../src/lib/threads/format";
import { closeThreads, createThread, listAllThreads, listOpenThreads, setThreadsFileForTests, type Thread } from "../src/lib/threads/store";
import { createBotCommands } from "../src/web/bot-commands";

const NOW = Date.parse("2026-10-15T10:00:00Z");
const DAY = 86_400_000;

function thread(over: Partial<Thread> & Pick<Thread, "id">): Thread {
  return {
    nr: 1,
    conversation: { type: "telegram", chatId: "-1001", topicId: 3 },
    topic: "Reiseziel",
    context: "Hamburg oder München.",
    question: "Hamburg oder München?",
    createdAt: NOW - 3 * DAY,
    state: "open",
    reminders: 0,
    ...over,
  };
}

async function telegram(text: string, services: Partial<CommandServices>, where: { chatId: string; topicId?: number } = { chatId: "-1001", topicId: 3 }): Promise<string[]> {
  const sent: string[] = [];
  await runTelegramCommand({
    chat: { reply: async t => void sent.push(t) },
    chatId: where.chatId,
    ...(where.topicId !== undefined ? { topicId: where.topicId } : {}),
    sessionKey: where.topicId !== undefined ? `topic:${where.chatId}:${where.topicId}` : `dm:${where.chatId}`,
    agent: "general",
    text,
    match: commandRegistry.match(text, "telegram")!,
    services: services as CommandServices,
    working: () => () => {},
    resetSession: async () => ({ status: "unavailable" }),
    agentTurn: async () => {},
    boardMeeting: async () => {},
  });
  return sent;
}

const WEB_ID = "0c1a2b3c-0000-4000-8000-000000000000";

async function webOrTerminal(source: "web" | "terminal", text: string, services: Partial<CommandServices>, conversationId = WEB_ID): Promise<string[]> {
  const unused = () => {
    throw new Error("nicht erwartet");
  };
  const commands = createBotCommands({
    registry: commandRegistry,
    services: services as CommandServices,
    groupId: () => null,
    agentForTopic: () => undefined,
    sendPlain: unused,
    sendAndRecord: unused,
    saveMessage: async () => true,
    resetConversation: unused,
    runStreamingTurn: unused,
    processIntents: unused,
    sendAsAgent: unused,
    log: () => {},
  });
  const notices: string[] = [];
  await commands.run({
    conversationId,
    agent: "general",
    text,
    source,
    messageId: "m1",
    receivedAt: new Date().toISOString(),
    signal: new AbortController().signal,
    sink: {} as any,
    notice: async t => void notices.push(t),
    answer: async () => {},
    ask: async () => {},
    endAsk: () => {},
    commit: () => {},
  });
  return notices;
}

let saved: string | undefined;
let dir: string;
let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  saved = process.env.THREADS;
  delete process.env.THREADS;
  dir = mkdtempSync(join(tmpdir(), "tybo-threads-cmd-"));
  setThreadsFileForTests(join(dir, "threads.json"));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  if (saved === undefined) delete process.env.THREADS;
  else process.env.THREADS = saved;
  setThreadsFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
  logSpy.mockRestore();
});

describe("/faeden im Register", () => {
  test("alle drei Kanäle, Alias /threads, mit und ohne Argumente", () => {
    for (const channel of ["telegram", "web", "terminal"] as const) {
      expect(commandRegistry.match("/faeden", channel)?.command.name).toBe("faeden");
      expect(commandRegistry.match("/threads", channel)?.command.name).toBe("faeden");
      expect(commandRegistry.match("/faeden zu 3", channel)?.args).toBe("zu 3");
      expect(commandRegistry.match("/threads erledigt 3", channel)?.args).toBe("erledigt 3");
      expect(commandRegistry.match("/faeden alle", channel)?.args).toBe("alle");
    }
    expect(commandRegistry.list("web").find(c => c.name === "faeden")).toMatchObject({ args: "optional", argsHint: "[alle | zu <nr>]" });
  });

  test("/help nennt /faeden", () => {
    const group = HELP_TEXT.slice(HELP_TEXT.indexOf("**Wissen:**"), HELP_TEXT.indexOf("**Sonstiges:**"));
    expect(group).toContain("\n/faeden - offene Faeden");
    expect(group).toContain("\n/faeden zu <nr> - Faden schliessen · /faeden alle - auch die geschlossenen der letzten 7 Tage");
  });
});

describe("Text der Liste", () => {
  test("neueste oben, feste Nummer (nicht die Position), Thema, Frage, Gespräch, Alter, Frist", () => {
    const text = formatThreadList(
      [
        thread({ id: "A", nr: 1, createdAt: NOW - 3 * DAY }),
        thread({ id: "B", nr: 2, topic: "Versicherung", question: "Soll ich den Widerspruch aufsetzen?", createdAt: NOW - 2 * 3_600_000, deadline: "2026-10-29", conversation: { type: "telegram", chatId: "4242" } }),
        thread({ id: "C", nr: 3, topic: "Pipeline", question: "Variante A oder B?", createdAt: NOW - 5 * 60_000, conversation: { type: "web", conversationId: "0c1a2b3c-0000-4000-8000-000000000000" } }),
        thread({ id: "D", nr: 4, topic: "Release", question: "Heute oder morgen?", createdAt: NOW - DAY - 1, conversation: { type: "telegram", chatId: "-1001" } }),
        thread({ id: "E", nr: 5, topic: "Unbenannt", question: "Was jetzt?", createdAt: NOW - 30_000, conversation: { type: "telegram", chatId: "-1001", topicId: 99 } }),
      ],
      { enabled: true, now: NOW, topicNames: { "3": "Reisen" } }
    );
    expect(text).toBe(
      [
        "Offene Fäden (5):",
        "5. Unbenannt\n   Frage: Was jetzt?\n   Topic 99 · seit gerade eben",
        "3. Pipeline\n   Frage: Variante A oder B?\n   Web-Gespräch · seit 5 Minuten",
        "2. Versicherung\n   Frage: Soll ich den Widerspruch aufsetzen?\n   Direktchat · seit 2 Stunden · Frist 29.10.2026",
        "4. Release\n   Frage: Heute oder morgen?\n   General · seit 1 Tag",
        "1. Reiseziel\n   Frage: Hamburg oder München?\n   Topic Reisen · seit 3 Tagen",
      ].join("\n\n")
    );
  });

  test("leer und aus", () => {
    expect(formatThreadList([], { enabled: true })).toBe("Keine offenen Fäden.");
    expect(formatThreadList([thread({ id: "A" })], { enabled: false })).toBe("Offene Fäden sind ausgeschaltet (Einstellungen der WebUI, Abschnitt „Offene Fäden“, oder THREADS=off).");
  });

  test("Alter und Frist", () => {
    expect(threadAge(NOW - 60_000, NOW)).toBe("seit 1 Minute");
    expect(threadAge(NOW - 3_600_000, NOW)).toBe("seit 1 Stunde");
    expect(threadAge(NOW - 10 * DAY, NOW)).toBe("seit 10 Tagen");
    expect(threadAge(NOW + 5_000, NOW)).toBe("seit gerade eben");
    expect(deadlineText("2026-10-16")).toBe("16.10.2026");
  });
});

describe("/faeden in den Kanälen", () => {
  test("Telegram, Browser und Terminal zeigen dieselbe Liste aus data/threads.json; Topic-Namen aus den Diensten", async () => {
    await createThread({ conversation: { type: "telegram", chatId: "-1001", topicId: 3 }, topic: "Reiseziel", context: "Kontext.", question: "Hamburg oder München?", deadline: "2026-10-16" });
    const services: Partial<CommandServices> = { topicNames: async () => ({ "3": "Reisen" }) };
    const tg = await telegram("/faeden", services);
    expect(tg.length).toBe(1);
    expect(tg[0]).toStartWith("Offene Fäden (1):\n\n1. Reiseziel\n   Frage: Hamburg oder München?\n   Topic Reisen · seit gerade eben · Frist 16.10.2026");
    expect(await webOrTerminal("web", "/faeden", services)).toEqual(tg);
    expect(await webOrTerminal("terminal", "/threads", services)).toEqual(tg);
    expect(await telegram("/threads", services)).toEqual(tg);
  });

  test("leer in allen Kanälen", async () => {
    const services: Partial<CommandServices> = { openThreads: async () => [], topicNames: async () => ({}) };
    expect(await telegram("/faeden", services)).toEqual([THREADS_TEXT.none]);
    expect(await webOrTerminal("web", "/faeden", services)).toEqual([THREADS_TEXT.none]);
    expect(await webOrTerminal("terminal", "/faeden", services)).toEqual([THREADS_TEXT.none]);
  });

  test("THREADS=off: Hinweis statt Liste, die Ablage wird nicht gelesen", async () => {
    process.env.THREADS = "off";
    let read = 0;
    const services: Partial<CommandServices> = {
      openThreads: async () => (read++, [thread({ id: "A" })]),
      topicNames: async () => ({}),
    };
    expect(await telegram("/faeden", services)).toEqual([THREADS_TEXT.off]);
    expect(await webOrTerminal("web", "/faeden", services)).toEqual([THREADS_TEXT.off]);
    expect(await webOrTerminal("terminal", "/threads", services)).toEqual([THREADS_TEXT.off]);
    expect(read).toBe(0);
  });

  test("lange Liste: in Telegram in Teilen bis 4096 Zeichen, im Browser am Stück", async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      thread({ id: `T${i}`, nr: i + 1, topic: `Thema ${i} ${"x".repeat(60)}`, question: `Frage ${i}? ${"y".repeat(60)}`, createdAt: NOW - i * 60_000 })
    );
    const services: Partial<CommandServices> = { openThreads: async () => many, topicNames: async () => ({}) };
    const tg = await telegram("/faeden", services);
    expect(tg.length).toBeGreaterThan(1);
    for (const part of tg) expect(part.length).toBeLessThanOrEqual(4096);
    const web = await webOrTerminal("web", "/faeden", services);
    expect(web.length).toBe(1);
    expect(tg.join("\n").replace(/\s+/g, " ")).toBe(web[0].replace(/\s+/g, " "));
  });

  test("Topic-Namen nicht lesbar: „Topic <id>“ statt Fehler", async () => {
    const services: Partial<CommandServices> = {
      openThreads: async () => [thread({ id: "A", createdAt: Date.now() })],
      topicNames: async () => {
        throw new Error("weg");
      },
    };
    expect((await telegram("/faeden", services))[0]).toContain("Topic 3 · seit gerade eben");
  });
});

describe("/faeden zu <nr> (Issue #291)", () => {
  const topic3 = { type: "telegram" as const, chatId: "-1001", topicId: 3 };
  const webConv = { type: "web" as const, conversationId: WEB_ID };
  const make = async (conversation: any, question: string, topicText: string) =>
    (await createThread({ conversation, topic: topicText, context: "Kontext.", question })).thread;

  test("Telegram: schließt den Faden des Topics von Hand, Nummer bleibt stabil", async () => {
    const a = await make(topic3, "Hamburg oder München?", "Reiseziel");
    const b = await make(topic3, "Zug oder Auto?", "Anreise");
    expect(await telegram(`/faeden zu ${a.nr}`, {})).toEqual([`Faden ${a.nr} geschlossen: Reiseziel`]);
    const stored = (await listAllThreads()).find(t => t.id === a.id)!;
    expect(stored.state).toBe("closed");
    expect(stored.closedReason).toBe("von Hand");
    // b behält seine Nummer, auch wenn er jetzt an erster Stelle steht
    const list = await telegram("/faeden", {});
    expect(list[0]).toStartWith(`Offene Fäden (1):\n\n${b.nr}. Anreise`);
    expect(b.nr).toBe(2);
  });

  test("Alias /threads und erledigt, in Browser und Terminal", async () => {
    const a = await make(webConv, "Variante A oder B?", "Pipeline");
    const b = await make(webConv, "Heute oder morgen?", "Release");
    expect(await webOrTerminal("web", `/faeden erledigt ${a.nr}`, {})).toEqual([`Faden ${a.nr} geschlossen: Pipeline`]);
    expect(await webOrTerminal("terminal", `/threads zu #${b.nr}`, {})).toEqual([`Faden ${b.nr} geschlossen: Release`]);
    expect(await listOpenThreads()).toEqual([]);
  });

  test("unbekannte und schon geschlossene Nummer", async () => {
    const a = await make(topic3, "Hamburg oder München?", "Reiseziel");
    expect(await telegram("/faeden zu 99", {})).toEqual(["Keinen offenen Faden 99. /faeden zeigt alle."]);
    await closeThreads(topic3, [a.nr], "beantwortet");
    expect(await telegram(`/faeden zu ${a.nr}`, {})).toEqual([`Keinen offenen Faden ${a.nr}. /faeden zeigt alle.`]);
    // Grund bleibt
    expect((await listAllThreads())[0].closedReason).toBe("beantwortet");
  });

  test("Faden aus einem anderen Gespräch: bleibt offen, Hinweis wo", async () => {
    const a = await make(topic3, "Hamburg oder München?", "Reiseziel");
    const services: Partial<CommandServices> = { topicNames: async () => ({ "3": "Reisen" }) };
    expect(await telegram(`/faeden zu ${a.nr}`, services, { chatId: "4242" })).toEqual([
      `Faden ${a.nr} gehört zu einem anderen Gespräch (Topic Reisen). Schließen geht nur dort: /faeden zu ${a.nr}`,
    ]);
    expect(await webOrTerminal("web", `/faeden zu ${a.nr}`, services)).toEqual([
      `Faden ${a.nr} gehört zu einem anderen Gespräch (Topic Reisen). Schließen geht nur dort: /faeden zu ${a.nr}`,
    ]);
    expect((await listOpenThreads()).map(t => t.id)).toEqual([a.id]);
  });

  test("unbekannte Angabe: Hinweis, nichts geschlossen", async () => {
    await make(topic3, "Hamburg oder München?", "Reiseziel");
    for (const text of ["/faeden zu", "/faeden zu abc", "/faeden weg 1", "/faeden zu 1 2"]) {
      expect(await telegram(text, {})).toEqual([THREADS_TEXT.usage]);
    }
    expect((await listOpenThreads()).length).toBe(1);
  });

  test("THREADS=off: nichts geschlossen", async () => {
    const a = await make(topic3, "Hamburg oder München?", "Reiseziel");
    process.env.THREADS = "off";
    expect(await telegram(`/faeden zu ${a.nr}`, {})).toEqual([THREADS_TEXT.off]);
    expect(await telegram("/faeden alle", {})).toEqual([THREADS_TEXT.off]);
    delete process.env.THREADS;
    expect((await listOpenThreads()).length).toBe(1);
  });

  test("über die Dienste: Schließen geht an closeThreads mit Gespräch und Grund", async () => {
    const seen: unknown[] = [];
    const services: Partial<CommandServices> = {
      closeThreads: async (conversation, nrs, reason) => {
        seen.push({ conversation, nrs, reason });
        return { closed: [thread({ id: "X", nr: nrs[0], topic: "Reiseziel" })], skipped: [] };
      },
    };
    expect(await telegram("/faeden zu 7", services)).toEqual(["Faden 7 geschlossen: Reiseziel"]);
    expect(seen).toEqual([{ conversation: topic3, nrs: [7], reason: "von Hand" }]);
  });
});

describe("/faeden alle (Issue #291)", () => {
  test("offene und die in 7 Tagen geschlossenen mit Grund, feste Zeit", () => {
    const text = formatClosedThreads(
      [
        thread({ id: "A", nr: 4, state: "closed", closedReason: "beantwortet", closedAt: NOW - 2 * DAY }),
        thread({ id: "B", nr: 9, topic: "Anreise", question: "Zug oder Auto?", state: "closed", closedReason: "von Hand", closedAt: NOW - 30_000 }),
        thread({ id: "C", nr: 2, topic: "Alt", question: "Was?", state: "closed", closedReason: "limit", closedAt: NOW - 3 * 3_600_000, conversation: { type: "telegram", chatId: "4242" } }),
      ],
      { now: NOW, topicNames: { "3": "Reisen" } }
    );
    expect(text).toBe(
      [
        "Geschlossen in den letzten 7 Tagen (3):",
        "9. Anreise\n   Frage: Zug oder Auto?\n   Topic Reisen · geschlossen gerade eben · von Hand",
        "2. Alt\n   Frage: Was?\n   Direktchat · geschlossen vor 3 Stunden · Obergrenze erreicht",
        "4. Reiseziel\n   Frage: Hamburg oder München?\n   Topic Reisen · geschlossen vor 2 Tagen · beantwortet",
      ].join("\n\n")
    );
    expect(formatClosedThreads([])).toBe("Geschlossen in den letzten 7 Tagen: keine.");
  });

  test("in allen Kanälen: Liste plus Abschnitt; ohne alle kein Abschnitt", async () => {
    const services: Partial<CommandServices> = {
      openThreads: async () => [thread({ id: "O", nr: 5, createdAt: Date.now() })],
      recentlyClosedThreads: async () => [thread({ id: "A", nr: 4, state: "closed", closedReason: "beantwortet", closedAt: Date.now() })],
      topicNames: async () => ({ "3": "Reisen" }),
    };
    const expected = [
      "Offene Fäden (1):\n\n5. Reiseziel\n   Frage: Hamburg oder München?\n   Topic Reisen · seit gerade eben\n\n" +
        "Geschlossen in den letzten 7 Tagen (1):\n\n4. Reiseziel\n   Frage: Hamburg oder München?\n   Topic Reisen · geschlossen gerade eben · beantwortet",
    ];
    expect(await telegram("/faeden alle", services)).toEqual(expected);
    expect(await webOrTerminal("web", "/faeden alle", services)).toEqual(expected);
    expect(await webOrTerminal("terminal", "/threads alle", services)).toEqual(expected);
    expect((await telegram("/faeden", services))[0]).not.toContain("Geschlossen");
  });

  test("aus der Ablage: zuletzt per Hand geschlossener erscheint mit Grund", async () => {
    const t = (await createThread({ conversation: { type: "telegram", chatId: "-1001", topicId: 3 }, topic: "Reiseziel", context: "K.", question: "Hamburg?" })).thread;
    await telegram(`/faeden zu ${t.nr}`, {});
    const text = (await telegram("/faeden alle", {}))[0];
    expect(text).toBe(`Keine offenen Fäden.\n\nGeschlossen in den letzten 7 Tagen (1):\n\n${t.nr}. Reiseziel\n   Frage: Hamburg?\n   Topic 3 · geschlossen gerade eben · von Hand`);
  });
});
