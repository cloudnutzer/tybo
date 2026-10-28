/**
 * Board-Sitzung (Issue #75): Kern aus src/lib/board-meeting.ts mit
 * Attrappen für Daten, Modell, Speicher und Telegram. Teilnehmer aus dem
 * echten Agenten-Katalog auf temporären Dateien; src/bot.ts wird nie
 * gelesen oder importiert.
 */

import { describe, expect, test } from "bun:test";
import { createBotCommandServices } from "../src/app/command-services";
import { commandRegistry } from "../src/lib/commands/builtin";
import { boardAgentNames, createAgent, setBoard } from "../src/agents/catalog";
import {
  BOARD_TEXT,
  createTelegramBoardOutput,
  isBoardRunning,
  requestBoardStop,
  runBoardMeeting,
  type BoardCallResult,
  type BoardDeps,
} from "../src/lib/board-meeting";
import { EARLIER_EXCERPT_CHARS } from "../src/lib/board/prompts";
import { stripConsultTags as stripInvocationTags } from "../src/lib/agent-consult";
import { runCancelable, runExecution } from "../src/lib/execution-context";
import { isolateAgentCatalog } from "./catalog-fixture";

isolateAgentCatalog();

const KEY = "topic:-100:7";
const DATA = "## Live-Daten für diese Sitzung\n\n### KI-Nachrichten der letzten 24 Stunden\n- Neues Modell erschienen";

interface Harness {
  deps: BoardDeps;
  saved: { content: string; metadata: Record<string, unknown> }[];
  prompts: { agent: string; prompt: string }[];
  /** Telegram-Aufrufe in Reihenfolge */
  telegram: string[];
  /** Antwort je Agent; Standard: "Beitrag <agent>" */
  answer: (agent: string, prompt: string) => Promise<BoardCallResult>;
}

function harness(agents: string[] = ["research", "finance", "critic"]): Harness {
  let n = 0;
  const h = { saved: [], prompts: [], telegram: [] } as unknown as Harness;
  h.answer = async agent => ({ text: `Beitrag ${agent}`, model: "claude-test", durationMs: 1200 });
  h.deps = {
    agents: () => agents,
    gatherData: async () => ({ agentData: { research: DATA }, sharedSummary: "Überfällige Aufgaben: 2 (unter 4 gelieferten Aufgaben)", fetchDurationMs: 3, errors: [] }),
    callAgent: (prompt, agent) => {
      h.prompts.push({ agent, prompt });
      return h.answer(agent, prompt);
    },
    stripInvocationTags,
    save: async m => {
      h.saved.push({ content: m.content, metadata: m.metadata });
      return true;
    },
    newMessageId: () => `id-${++n}`,
    pauseMs: 0,
    log: () => {},
  };
  return h;
}

function telegramOutput(h: Harness, onTyping?: (agent: string) => Promise<void>) {
  return createTelegramBoardOutput(
    {
      sendAsAgent: async (agent, chatId, text, threadId) => void h.telegram.push(`send ${agent} ${chatId} ${threadId} ${text}`),
      sendTypingAsAgent: async (agent, chatId, threadId) => {
        h.telegram.push(`typing ${agent} ${chatId} ${threadId}`);
        await onTyping?.(agent);
      },
      notice: async text => void h.telegram.push(`notice ${text}`),
    },
    "-100",
    7
  );
}

describe("Telegram-Weg wie bisher", () => {
  test("Ankündigung, je Agent Tippt-Anzeige und Beitrag vom Agenten-Bot, dann Zusammenfassung von General", async () => {
    const h = harness();
    h.answer = async (agent, prompt) =>
      agent === "general" ? { text: "Zusammenfassung" } : { text: `Beitrag ${agent} [INVOKE:finance|Zahlen?]` };
    const result = await runBoardMeeting(h.deps, { sessionKey: KEY, topicId: 7, extraContext: "Newsletter" }, telegramOutput(h));
    expect(h.telegram).toEqual([
      "send general -100 7 *Board Meeting Starting*\n\nGathering perspectives from all agents...\n\nAdditional context: Newsletter",
      "typing research -100 7",
      "send research -100 7 Beitrag research",
      "typing finance -100 7",
      "send finance -100 7 Beitrag finance",
      "typing critic -100 7",
      "send critic -100 7 Beitrag critic",
      "typing general -100 7",
      "send general -100 7 Zusammenfassung",
    ]);
    expect(result).toEqual({ contributions: 3, synthesis: true, stopped: false, aborted: false, empty: false });
  });

  test("deutsche Prompts: Thema, Datenblock des Agenten, bisherige Beiträge; Zusammenfassung mit allen und dem Stand", async () => {
    const h = harness(["research", "finance"]);
    await runBoardMeeting(h.deps, { sessionKey: KEY, extraContext: "Preis" }, telegramOutput(h));
    expect(h.prompts.map(p => p.agent)).toEqual(["research", "finance", "general"]);
    expect(h.prompts[0].prompt).toBe(`Du nimmst an einer Board-Sitzung teil und bringst die Sicht deines Fachgebiets ein.

Thema der Sitzung: Preis

${DATA}

Dein Auftrag: Nenne 2 bis 4 Punkte, die aus deiner Sicht jetzt am meisten zählen, knapp und begründet. Stütze dich dabei auf die Einträge und Zahlen unter „Live-Daten“ oben und nenne sie konkret.`);
    expect(h.prompts[1].prompt).toBe(`Du nimmst an einer Board-Sitzung teil und bringst die Sicht deines Fachgebiets ein.

Thema der Sitzung: Preis

## Bisherige Beiträge (gekürzt)
**research**: Beitrag research

Dein Auftrag: Nenne 2 bis 4 Punkte, die aus deiner Sicht jetzt am meisten zählen, knapp und begründet. Für dein Fachgebiet liegen in dieser Sitzung keine Live-Daten vor. Argumentiere aus deinem Fachwissen und dem bisherigen Gespräch und erfinde keine Zahlen.`);
    expect(h.prompts[2].prompt).toBe(`Die Board-Sitzung ist vorbei. Fasse sie als Leitung zusammen.

## Beiträge

### RESEARCH
Beitrag research

---

### FINANCE
Beitrag finance

## Aktueller Stand
Überfällige Aufgaben: 2 (unter 4 gelieferten Aufgaben)

Dein Auftrag: Nenne die tragenden Themen, zeige, wo sich die Agenten widersprechen oder einig sind, und schlage 3 bis 5 konkrete Maßnahmen vor, jede mit einer klaren Zuständigkeit. Beziehe die Maßnahmen auf den aktuellen Stand oben.`);
  });

  test("ohne Thema, Daten und Stand: kein Bezug auf Live-Daten, frühere Beiträge auf 300 Zeichen gekürzt", async () => {
    const h = harness(["cto", "projekt-planer"]);
    h.deps.gatherData = async () => ({ agentData: { cto: "" }, sharedSummary: "", fetchDurationMs: 0, errors: [] });
    const long = "x".repeat(EARLIER_EXCERPT_CHARS + 50);
    h.answer = async agent => ({ text: agent === "cto" ? long : `Beitrag ${agent}` });
    await runBoardMeeting(h.deps, { sessionKey: KEY }, telegramOutput(h));
    const [cto, planer, general] = h.prompts.map(p => p.prompt);
    for (const prompt of [cto, planer]) {
      expect(prompt).not.toContain("Live-Daten“ oben");
      expect(prompt).toContain("keine Live-Daten vor");
      expect(prompt).not.toContain("Thema der Sitzung");
    }
    expect(planer).toContain(`**cto**: ${"x".repeat(EARLIER_EXCERPT_CHARS)} …\n`);
    expect(general).toContain(`### CTO\n${long}\n`);
    expect(general).not.toContain("Aktueller Stand");
    expect(general).not.toContain("aktuellen Stand oben");
  });

  test("Teilnehmer und Reihenfolge aus dem Katalog: mitgelieferte, eigene mit Board-Schalter, Critic zuletzt", async () => {
    await createAgent({ name: "projekt-planer", description: "Plant Projekte", systemPrompt: "Du planst.", board: true });
    await setBoard("content", false);
    const h = harness();
    h.deps.agents = boardAgentNames;
    await runBoardMeeting(h.deps, { sessionKey: KEY }, telegramOutput(h));
    expect(h.prompts.map(p => p.agent)).toEqual(["research", "finance", "strategy", "cto", "coo", "projekt-planer", "critic", "general"]);
  });

  // Telegram-Anbindung als Verhalten: tests/telegram-commands.test.ts („/board", Issue #344)
  test("/board kommt aus dem Register, der Stopp aus den Befehls-Diensten des Bots", () => {
    expect(commandRegistry.match("/board Thema", "telegram")?.command.name).toBe("board");
    expect(createBotCommandServices({ routineMenu: async () => false }).requestBoardStop).toBe(requestBoardStop);
  });
});

describe("Speichern: jeder Beitrag einzeln, kein Sammeltext", () => {
  test("Agent, Dauer, Modell, Topic und msgId je Beitrag, Zusammenfassung von General", async () => {
    const h = harness(["research", "critic"]);
    h.answer = async agent => ({ text: agent === "general" ? "Fazit" : `Beitrag ${agent}`, model: "claude-test", durationMs: 1500 });
    await runBoardMeeting(h.deps, { sessionKey: KEY, topicId: 7, metadata: { channel: "web" } }, telegramOutput(h));
    expect(h.saved).toEqual([
      {
        content: "Beitrag research",
        metadata: { channel: "web", type: "board_meeting", board: "agent", agent: "research", durationMs: 1500, model: "claude-test", topicId: 7, msgId: "id-1" },
      },
      {
        content: "Beitrag critic",
        metadata: { channel: "web", type: "board_meeting", board: "agent", agent: "critic", durationMs: 1500, model: "claude-test", topicId: 7, msgId: "id-2" },
      },
      {
        content: "Fazit",
        metadata: { channel: "web", type: "board_meeting", board: "synthesis", agent: "general", durationMs: 1500, model: "claude-test", topicId: 7, msgId: "id-3" },
      },
    ]);
  });

  test("Motor des Beitrags wird mitgespeichert, wenn der Turn ihn meldet (Issue #125)", async () => {
    const h = harness(["research"]);
    h.answer = async agent => ({ text: agent, engine: "codex", model: "gpt-5.6-sol", durationMs: 900 });
    await runBoardMeeting(h.deps, { sessionKey: KEY, topicId: 7 }, telegramOutput(h));
    expect(h.saved.map(m => m.metadata.engine)).toEqual(["codex", "codex"]);
    expect(h.saved[0].metadata).toMatchObject({ engine: "codex", model: "gpt-5.6-sol" });
  });

  test("ohne Dauer vom Turn misst der Kern selbst; Direktchat mit topicId null", async () => {
    const h = harness(["research"]);
    let t = 1000;
    h.deps.now = () => (t += 250);
    h.answer = async () => ({ text: "x" });
    await runBoardMeeting(h.deps, { sessionKey: "dm:1" }, telegramOutput(h));
    expect(h.saved[0].metadata).toMatchObject({ agent: "research", durationMs: 250, topicId: null });
    expect(h.saved[0].metadata.model).toBeUndefined();
  });

  test("Beitrag wird gespeichert, bevor er ausgegeben wird", async () => {
    const h = harness(["research"]);
    const order: string[] = [];
    const save = h.deps.save;
    h.deps.save = async m => (order.push(`save ${m.content}`), save(m));
    await runBoardMeeting(h.deps, { sessionKey: KEY }, {
      start: async () => {},
      thinking: async () => {},
      contribution: async c => void order.push(`out ${c.text} ${c.msgId}`),
      end: async () => {},
    });
    expect(order).toEqual(["save Beitrag research", "out Beitrag research id-1", "save Beitrag general", "out Beitrag general id-2"]);
  });
});

describe("Fehler und Sonderfälle", () => {
  test("Agentenfehler: kein Beitrag, kein Speichern, die übrigen laufen, Zusammenfassung mit (kein Beitrag)", async () => {
    const h = harness();
    h.answer = async agent => {
      if (agent === "finance") throw new Error("kaputt");
      return { text: `Beitrag ${agent}` };
    };
    const failed: string[] = [];
    const out = telegramOutput(h);
    await runBoardMeeting(h.deps, { sessionKey: KEY }, { ...out, failed: async a => void failed.push(a) });
    expect(failed).toEqual(["finance"]);
    expect(h.saved.map(s => s.metadata.agent)).toEqual(["research", "critic", "general"]);
    expect(h.prompts.at(-1)!.prompt).toContain("### FINANCE\n(kein Beitrag)");
    expect(h.prompts.find(p => p.agent === "critic")!.prompt).toContain("**finance**: (kein Beitrag)");
    expect(h.telegram.filter(t => t.startsWith("send finance"))).toEqual([]);
  });

  test("Abbruch-Antwort (ABORT_REPLY als aborted) ist nie ein Beitrag: Ende ohne weitere Agenten", async () => {
    const h = harness();
    h.answer = async agent => (agent === "finance" ? { text: "", aborted: true } : { text: `Beitrag ${agent}` });
    const ends: unknown[] = [];
    const out = telegramOutput(h);
    const result = await runBoardMeeting(h.deps, { sessionKey: KEY }, { ...out, end: async (r, m) => void ends.push([r.aborted, m]) });
    expect(result.aborted).toBe(true);
    expect(h.prompts.map(p => p.agent)).toEqual(["research", "finance"]);
    expect(h.saved.map(s => s.content)).toEqual(["Beitrag research"]);
    expect(ends).toEqual([[true, null]]);
  });

  test("AbortError aus dem Modellaufruf zählt als Abbruch", async () => {
    const h = harness(["research", "critic"]);
    h.answer = async () => {
      throw new DOMException("weg", "AbortError");
    };
    const result = await runBoardMeeting(h.deps, { sessionKey: KEY }, telegramOutput(h));
    expect(result).toMatchObject({ aborted: true, contributions: 0 });
    expect(h.saved).toEqual([]);
  });

  test("leeres Board: kein Modellaufruf, Hinweis statt Ankündigung", async () => {
    const h = harness([]);
    const result = await runBoardMeeting(h.deps, { sessionKey: KEY }, telegramOutput(h));
    expect(result.empty).toBe(true);
    expect(h.prompts).toEqual([]);
    expect(h.telegram).toEqual([`notice ${BOARD_TEXT.empty}`]);
  });

  test("alle Agenten ohne Beitrag: keine Zusammenfassung, Hinweis", async () => {
    const h = harness(["research"]);
    h.answer = async () => ({ text: "   " });
    await runBoardMeeting(h.deps, { sessionKey: KEY }, telegramOutput(h));
    expect(h.prompts.map(p => p.agent)).toEqual(["research"]);
    expect(h.telegram.at(-1)).toBe(`notice ${BOARD_TEXT.noContributions}`);
  });
});

describe("Stopp: nach dem laufenden Beitrag", () => {
  test("Stopp während eines Beitrags: der Beitrag wird fertig, gespeichert und gesendet, dann Schluss ohne Zusammenfassung", async () => {
    const h = harness();
    h.answer = async agent => {
      if (agent === "finance") expect(requestBoardStop(KEY)).toBe("requested");
      return { text: `Beitrag ${agent}` };
    };
    const result = await runBoardMeeting(h.deps, { sessionKey: KEY }, telegramOutput(h));
    expect(result).toEqual({ contributions: 2, synthesis: false, stopped: true, aborted: false, empty: false });
    expect(h.prompts.map(p => p.agent)).toEqual(["research", "finance"]);
    expect(h.saved.map(s => s.content)).toEqual(["Beitrag research", "Beitrag finance"]);
    expect(h.telegram.at(-2)).toBe("send finance -100 7 Beitrag finance");
    expect(h.telegram.at(-1)).toBe(`notice ${BOARD_TEXT.stopped(2)}`);
    expect(isBoardRunning(KEY)).toBe(false);
    expect(requestBoardStop(KEY)).toBe("none");
  });

  test("zweiter Stopp meldet again; Stopp während der Datenbeschaffung: kein Agent startet", async () => {
    const h = harness();
    h.deps.gatherData = async () => {
      expect(requestBoardStop(KEY)).toBe("requested");
      expect(requestBoardStop(KEY)).toBe("again");
      return { agentData: {}, sharedSummary: "", fetchDurationMs: 0, errors: [] };
    };
    const result = await runBoardMeeting(h.deps, { sessionKey: KEY }, telegramOutput(h));
    expect(result).toMatchObject({ stopped: true, contributions: 0 });
    expect(h.prompts).toEqual([]);
    expect(h.telegram.at(-1)).toBe(`notice ${BOARD_TEXT.stopped(0)}`);
  });

  test("Stopp während der Zusammenfassung: sie ist der laufende Beitrag und wird fertig", async () => {
    const h = harness(["research"]);
    h.answer = async agent => {
      if (agent === "general") requestBoardStop(KEY);
      return { text: `Beitrag ${agent}` };
    };
    const result = await runBoardMeeting(h.deps, { sessionKey: KEY }, telegramOutput(h));
    expect(result).toMatchObject({ synthesis: true, stopped: false });
    expect(h.telegram.at(-1)).toBe("send general -100 7 Beitrag general");
  });

  test("Stopp gilt nur für den eigenen Schlüssel", async () => {
    const h = harness(["research", "critic"]);
    h.answer = async agent => {
      expect(requestBoardStop("topic:-100:8")).toBe("none");
      return { text: `Beitrag ${agent}` };
    };
    const result = await runBoardMeeting(h.deps, { sessionKey: KEY }, telegramOutput(h));
    expect(result.synthesis).toBe(true);
  });

  test("Stopp während der Tippt-Anzeige eines Agenten: dieser Agent startet nicht mehr", async () => {
    const h = harness();
    const output = telegramOutput(h, async agent => {
      await new Promise(resolve => setTimeout(resolve, 5));
      if (agent === "finance") expect(requestBoardStop(KEY)).toBe("requested");
    });
    const result = await runBoardMeeting(h.deps, { sessionKey: KEY }, output);
    expect(result).toEqual({ contributions: 1, synthesis: false, stopped: true, aborted: false, empty: false });
    expect(h.prompts.map(p => p.agent)).toEqual(["research"]);
    expect(h.telegram.at(-1)).toBe(`notice ${BOARD_TEXT.stopped(1)}`);
  });

  test("Stopp während der Tippt-Anzeige vor der Zusammenfassung: sie startet nicht mehr", async () => {
    const h = harness(["research"]);
    const output = telegramOutput(h, async agent => {
      await new Promise(resolve => setTimeout(resolve, 5));
      if (agent === "general") expect(requestBoardStop(KEY)).toBe("requested");
    });
    const result = await runBoardMeeting(h.deps, { sessionKey: KEY }, output);
    expect(result).toEqual({ contributions: 1, synthesis: false, stopped: true, aborted: false, empty: false });
    expect(h.prompts.map(p => p.agent)).toEqual(["research"]);
    expect(h.saved.map(s => s.metadata.board)).toEqual(["agent"]);
  });

  test("Telegram und Browser gleichzeitig im selben Gespräch: Stopp wirkt, bis die letzte Sitzung endet", async () => {
    const key = "topic:-100:9";
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => (releaseFirst = resolve));
    const telegram = harness(["research"]);
    const web = harness(["research"]);
    // Wie im Bot: die Sitzung unter runCancelable, jeder Modellaufruf unter runExecution
    for (const h of [telegram, web]) {
      const answer = h.deps.callAgent;
      h.deps.callAgent = (prompt, agent) => runExecution(key, agent, () => answer(prompt, agent));
    }
    telegram.answer = async agent => {
      if (agent === "research") await firstGate;
      return { text: `Beitrag ${agent}` };
    };
    let firstDone!: Promise<unknown>;
    let stop: string | undefined;
    web.answer = async agent => {
      // Wartet hinter der Sperre der ersten Sitzung; die ist danach ganz vorbei
      await firstDone;
      stop = requestBoardStop(key);
      return { text: `Beitrag ${agent}` };
    };
    firstDone = runCancelable(key, () => runBoardMeeting(telegram.deps, { sessionKey: key }, telegramOutput(telegram)));
    const second = runCancelable(key, () => runBoardMeeting(web.deps, { sessionKey: key }, telegramOutput(web)));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(web.prompts).toEqual([]);
    releaseFirst();
    expect(await firstDone).toMatchObject({ synthesis: true });
    expect(isBoardRunning(key)).toBe(true);
    const result = await second;
    expect(stop).toBe("requested");
    expect(result).toEqual({ contributions: 1, synthesis: false, stopped: true, aborted: false, empty: false });
    expect(web.prompts.map(p => p.agent)).toEqual(["research"]);
    expect(isBoardRunning(key)).toBe(false);
    expect(requestBoardStop(key)).toBe("none");
  });
});
