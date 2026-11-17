/**
 * Prompt-Builder (Issue #358): Aufbau des frischen und des fortgesetzten
 * Prompts mit Attrappen als Quellen, Kanalregeln je Kanal, Konsultation,
 * ein Zeitformat und der Kontext der Fallback-Kette. Dazu der Kanal im
 * Chat-Kern: frisch, fortgesetzt, Neuversuch, Wechsel zwischen Telegram und
 * Browser in derselben Topic-Session und Konsultationen im Browser.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, deleteAgent, getAgent, setPrompt } from "../src/agents/catalog";
import type { AgentConfig } from "../src/agents/types";
import {
  CHANNEL_HEADING,
  CONSULTATION_HEADING,
  CONSULTATION_OVERRIDE,
  FALLBACK_SYSTEM_PROMPT,
  formatChannelRules,
  formatPromptTime,
  IMAGE_TAG_SECTION,
  MEMORY_TAGS_SECTION,
  NO_CONSULTATION_RULES,
  STATIC_CONSULTATION_HEADING,
} from "../src/agents/prompt-parts";
import { resolveStreamingLimits, runStreamingTurn, type ChatTurnDeps, type TurnOptions } from "../src/lib/chat-turn";
import type { Engine, EngineRequest, EngineResult } from "../src/lib/engines";
import { buildPromptContext, buildResumePrompt, type PromptSources } from "../src/lib/prompt-builder";
import {
  getResumableSession,
  getSessionsForKey,
  recordSessionTurn,
  resetSession,
  sessionEpoch,
  setSessionsFileForTests,
  takeExpiredSession,
} from "../src/lib/session-manager";
import { getSettings, setSettingsPath } from "../src/lib/settings";
import type { Message } from "../src/lib/store/types";
import { TELEGRAM_FORMAT_RULES } from "../src/lib/telegram";
import { QUESTION_TAG_SECTION } from "../src/lib/turn-questions";
import { webConsultRunner } from "../src/web/bot-turn";
import { isolateAgentCatalog } from "./catalog-fixture";

isolateAgentCatalog();

const NOW = new Date("2026-10-22T12:05:00Z");
const ZONE = "Europe/Berlin";
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const msg = (role: Message["role"], content: string, created_at?: string): Message => ({ chat_id: "100", role, content, created_at });

function fakeSources(over: Partial<PromptSources> = {}): { sources: PromptSources; seen: Record<string, unknown[]> } {
  const seen: Record<string, unknown[]> = { recent: [], similar: [], memorySince: [] };
  const sources: PromptSources = {
    agent: name => (name === "general" ? ({ name: "General", systemPrompt: "SYSTEM-GENERAL", model: "m" } as AgentConfig) : undefined),
    overrides: () => "",
    consultation: name => `${CONSULTATION_HEADING}\nfür ${name}`,
    profile: async () => "Name: Alex",
    core: async () => "",
    memory: async () => "FACTS:\n- mag Tee",
    knowledge: async () => "- [howto] Drucker",
    recent: async (chatId, limit, topicId) => {
      seen.recent.push({ chatId, limit, topicId });
      return [msg("user", "Hallo", minutesAgo(30)), msg("assistant", "Hi", minutesAgo(29))];
    },
    similar: async (chatId, query, limit) => {
      seen.similar.push({ chatId, query, limit });
      return [msg("user", "Ökostrom ist wichtig", minutesAgo(60 * 24 * 9))];
    },
    memorySince: async since => {
      seen.memorySince.push(since.getTime());
      return "- [fact] wohnt in Leipzig";
    },
    // Wie der echte Suchweg: Treffer und Fakten aus einer Suche; Tests geben Treffer über similar vor
    followUp: async (chatId, query, limit) => ({ messages: await sources.similar(chatId, query, limit), facts: [] }),
    now: () => NOW,
    timeZone: () => ZONE,
    ...over,
  };
  return { sources, seen };
}

const sections = (prompt: string) => prompt.split("\n\n---\n\n");
const heads = (prompt: string) => sections(prompt).map(s => s.split("\n")[0]);

describe("fester Kern (Issue #522)", () => {
  const HEADING = "## USER CORE (confirmed by the user)";

  test("steht nach dem Profil im frischen Prompt und im Fallback-Kontext, das Budget der Suche bleibt getrennt", async () => {
    const { sources } = fakeSources({ core: async () => "Alex, Imkerin" });
    const { fullPrompt, fallbackContext } = await buildPromptContext({ userMessage: "q", chatId: "1", agentName: "general" }, sources);
    const order = heads(fullPrompt);
    expect(order.slice(order.indexOf("## USER PROFILE"), order.indexOf("## USER PROFILE") + 3)).toEqual(["## USER PROFILE", HEADING, "## CURRENT TIME"]);
    expect(sections(fullPrompt)).toContain(`${HEADING}\nAlex, Imkerin`);
    expect(sections(fullPrompt)).toContain("## MEMORY\nFACTS:\n- mag Tee");
    expect(fallbackContext.split("\n\n")).toContain(`${HEADING}\nAlex, Imkerin`);
    expect(fallbackContext).toContain("## MEMORY (facts & goals)\nFACTS:\n- mag Tee");
  });

  test("ohne Kern fehlt der Abschnitt, der Prompt ist derselbe wie ohne diese Quelle", async () => {
    const { sources } = fakeSources();
    const { fullPrompt, fallbackContext } = await buildPromptContext({ userMessage: "q", chatId: "1", agentName: "general" }, sources);
    expect(fullPrompt).not.toContain("USER CORE");
    expect(fallbackContext).not.toContain("USER CORE");
  });

  test("ein Fehler der Quelle kostet nur den Abschnitt", async () => {
    const { sources } = fakeSources({ core: async () => { throw new Error("kaputt"); } });
    const { fullPrompt } = await buildPromptContext({ userMessage: "q", chatId: "1", agentName: "general" }, sources);
    expect(fullPrompt).not.toContain("USER CORE");
    expect(fullPrompt).toContain("## USER MESSAGE\nq");
  });

  test("die Folgenachricht einer Session trägt ihn nicht", async () => {
    let asked = 0;
    const { sources } = fakeSources({ core: async () => (asked++, "Alex, Imkerin") });
    const prompt = await buildResumePrompt({ userMessage: "q", chatId: "1", sinceMs: 1 }, sources);
    expect(prompt).not.toContain("Imkerin");
    expect(asked).toBe(0);
  });
});

describe("frischer Prompt", () => {
  test("Reihenfolge der Abschnitte, Kanal Telegram ohne Angabe", async () => {
    const { sources } = fakeSources();
    const { fullPrompt } = await buildPromptContext({ userMessage: "Frage?", chatId: "100", agentName: "general", topicId: 7 }, sources);
    expect(heads(fullPrompt)).toEqual([
      "SYSTEM-GENERAL",
      CHANNEL_HEADING,
      "## USER PROFILE",
      "## CURRENT TIME",
      "## MEMORY",
      "## KNOWLEDGE BASE",
      "## RECENT CONVERSATION",
      "## SEMANTIC SEARCH RESULTS",
      CONSULTATION_HEADING,
      "## LOOKING UP EARLIER INFORMATION",
      "## MEMORY TAGS",
      "## QUESTIONS WITH BUTTONS",
      "## IMAGES",
      "## USER MESSAGE",
    ]);
    expect(fullPrompt).toContain(formatChannelRules("telegram"));
    expect(fullPrompt).toContain(MEMORY_TAGS_SECTION);
    expect(fullPrompt).toContain(QUESTION_TAG_SECTION);
    expect(fullPrompt).toContain(IMAGE_TAG_SECTION);
    expect(fullPrompt.endsWith("## USER MESSAGE\nFrage?")).toBe(true);
  });

  test("Kanal web: Regeln der WebUI statt Telegram", async () => {
    const { sources } = fakeSources();
    const { fullPrompt } = await buildPromptContext({ userMessage: "x", chatId: "web:1", agentName: "general", channel: "web" }, sources);
    expect(fullPrompt).toContain(formatChannelRules("web"));
    expect(fullPrompt).not.toContain(TELEGRAM_FORMAT_RULES);
  });

  test("Verlauf nur aus dem eigenen Topic (ohne Topic null), Suche mit fünf Treffern", async () => {
    const { sources, seen } = fakeSources();
    await buildPromptContext({ userMessage: "q", chatId: "100", agentName: "general" }, sources);
    await buildPromptContext({ userMessage: "q", chatId: "100", agentName: "general", topicId: 9 }, sources);
    expect(seen.recent).toEqual([
      { chatId: "100", limit: 10, topicId: null },
      { chatId: "100", limit: 10, topicId: 9 },
    ]);
    expect(seen.similar).toEqual([
      { chatId: "100", query: "q", limit: 5 },
      { chatId: "100", query: "q", limit: 5 },
    ]);
  });

  test("leere Quellen ergeben keine leeren Abschnitte; ohne Konsultationsziele ausdrücklich niemand", async () => {
    const { sources } = fakeSources({
      profile: async () => "",
      memory: async () => "",
      knowledge: async () => "",
      recent: async () => [],
      similar: async () => [],
      consultation: () => "",
    });
    const { fullPrompt, fallbackContext } = await buildPromptContext({ userMessage: "q", chatId: "1", agentName: "general" }, sources);
    expect(heads(fullPrompt)).toEqual([
      "SYSTEM-GENERAL",
      CHANNEL_HEADING,
      "## CURRENT TIME",
      CONSULTATION_HEADING,
      "## LOOKING UP EARLIER INFORMATION",
      "## MEMORY TAGS",
      "## QUESTIONS WITH BUTTONS",
      "## IMAGES",
      "## USER MESSAGE",
    ]);
    expect(fullPrompt).toContain(NO_CONSULTATION_RULES);
    expect(fallbackContext).toBe("");
  });

  test("Suche und Wissensbasis dürfen scheitern, der Rest bleibt", async () => {
    const { sources } = fakeSources({
      similar: async () => {
        throw new Error("Suche weg");
      },
      knowledge: async () => {
        throw new Error("Wissen weg");
      },
    });
    const { fullPrompt } = await buildPromptContext({ userMessage: "q", chatId: "1", agentName: "general" }, sources);
    expect(fullPrompt).not.toContain("## SEMANTIC SEARCH RESULTS");
    expect(fullPrompt).not.toContain("## KNOWLEDGE BASE");
    expect(fullPrompt).toContain("## RECENT CONVERSATION");
  });

  test("ohne Agent der Ersatz-Prompt; Anweisungen per /agent direkt danach", async () => {
    const { sources } = fakeSources({ agent: () => undefined, overrides: name => `## USER INSTRUCTIONS FOR THIS AGENT\nfür ${name}` });
    const { fullPrompt, fallbackContext } = await buildPromptContext({ userMessage: "q", chatId: "1", agentName: "x" }, sources);
    expect(heads(fullPrompt).slice(0, 3)).toEqual([FALLBACK_SYSTEM_PROMPT, "## USER INSTRUCTIONS FOR THIS AGENT", CHANNEL_HEADING]);
    expect(fallbackContext.startsWith("## USER INSTRUCTIONS FOR THIS AGENT\nfür x")).toBe(true);
  });

  test("Fallback-Kontext: Profil, Gedächtnis, Wissen, Verlauf, Treffer; ohne System-Prompt, Kanal und Tags", async () => {
    const { sources } = fakeSources();
    const { fallbackContext } = await buildPromptContext({ userMessage: "q", chatId: "1", agentName: "general" }, sources);
    expect(fallbackContext.split("\n\n## ").map((p, i) => (i === 0 ? p : `## ${p}`).split("\n")[0])).toEqual([
      "## USER PROFILE",
      "## MEMORY (facts & goals)",
      "## KNOWLEDGE BASE",
      "## RECENT CONVERSATION",
      "## SEMANTIC SEARCH RESULTS",
    ]);
    for (const absent of ["SYSTEM-GENERAL", CHANNEL_HEADING, "## MEMORY TAGS", "## USER MESSAGE"]) expect(fallbackContext).not.toContain(absent);
  });

  test("langer Treffer wird nach 300 Zeichen gekürzt", async () => {
    const { sources } = fakeSources({ similar: async () => [msg("assistant", "a".repeat(400), minutesAgo(5))] });
    const { fullPrompt } = await buildPromptContext({ userMessage: "q", chatId: "1", agentName: "general" }, sources);
    expect(fullPrompt).toContain(`Bot: ${"a".repeat(300)}...`);
    expect(fullPrompt).not.toContain("a".repeat(301));
  });
});

describe("ein Zeitformat", () => {
  test("aktuelle Zeit und Suchtreffer im selben Format, frisch wie fortgesetzt", async () => {
    const { sources } = fakeSources();
    const now = formatPromptTime(NOW, ZONE);
    const hit = formatPromptTime(new Date(minutesAgo(60 * 24 * 9)), ZONE);
    expect(now).toBe("Thursday, Oct 22, 2026 at 14:05 GMT+2");
    expect(hit).toBe("Tuesday, Oct 13, 2026 at 14:05 GMT+2");
    const { fullPrompt } = await buildPromptContext({ userMessage: "q", chatId: "1", agentName: "general" }, sources);
    const resume = await buildResumePrompt({ userMessage: "q", chatId: "1" }, sources);
    for (const prompt of [fullPrompt, resume]) {
      expect(prompt).toContain(`## CURRENT TIME\n${now}`);
      expect(prompt).toContain(`[${hit}] User: Ökostrom ist wichtig`);
    }
    // Verlauf bleibt relativ, gemessen an derselben Uhr
    expect(fullPrompt).toContain("[30 minutes ago] User: Hallo");
  });

  test("Treffer ohne Zeit", async () => {
    const { sources } = fakeSources({ similar: async () => [msg("user", "ohne Zeit")] });
    const resume = await buildResumePrompt({ userMessage: "q", chatId: "1" }, sources);
    expect(resume).toContain("[time unknown] User: ohne Zeit");
  });
});

describe("fortgesetzter Prompt", () => {
  test("Zeit, Kanal, neue Merk-Einträge seit Sessionbeginn, Treffer, Nachricht", async () => {
    const { sources, seen } = fakeSources();
    const since = NOW.getTime() - 3_600_000;
    const prompt = await buildResumePrompt({ userMessage: "weiter", chatId: "1", sinceMs: since, channel: "web" }, sources);
    expect(heads(prompt)).toEqual(["## CURRENT TIME", CHANNEL_HEADING, "## MEMORY UPDATES", "## SEMANTIC SEARCH RESULTS", "## USER MESSAGE"]);
    expect(prompt).toContain(formatChannelRules("web"));
    expect(prompt).toContain("- [fact] wohnt in Leipzig");
    expect(seen.memorySince).toEqual([since]);
    // Kein System-Prompt, kein Profil, keine Tags: die Session hat sie schon
    for (const absent of ["SYSTEM-GENERAL", "## USER PROFILE", "## MEMORY TAGS", CONSULTATION_HEADING]) expect(prompt).not.toContain(absent);
  });

  test("ohne sinceMs kein Delta; Fehler der Quellen zählen als leer; ohne Kanal Telegram", async () => {
    const { sources, seen } = fakeSources({
      similar: async () => {
        throw new Error("weg");
      },
    });
    const prompt = await buildResumePrompt({ userMessage: "weiter", chatId: "1" }, sources);
    expect(seen.memorySince).toEqual([]);
    expect(heads(prompt)).toEqual(["## CURRENT TIME", CHANNEL_HEADING, "## USER MESSAGE"]);
    expect(prompt).toContain(TELEGRAM_FORMAT_RULES);
    const failing = fakeSources({
      memorySince: async () => {
        throw new Error("weg");
      },
    }).sources;
    expect(heads(await buildResumePrompt({ userMessage: "w", chatId: "1", sinceMs: 1 }, failing))).not.toContain("## MEMORY UPDATES");
  });
});

describe("echte Konsultationsregeln im Prompt", () => {
  test("General bekommt die erzeugte Liste, Critic ausdrücklich niemanden", async () => {
    const { sources } = fakeSources();
    const { consultation: _, agent: __, ...rest } = sources;
    const general = await buildPromptContext({ userMessage: "q", chatId: "1", agentName: "general" }, rest);
    expect(general.fullPrompt).toContain(`${CONSULTATION_HEADING}\n`);
    expect(general.fullPrompt).toContain("- critic: ");
    expect(general.fullPrompt).not.toContain(NO_CONSULTATION_RULES);
    const critic = await buildPromptContext({ userMessage: "q", chatId: "1", agentName: "critic" }, rest);
    expect(critic.fullPrompt).toContain(NO_CONSULTATION_RULES);
    expect(critic.fullPrompt.split(CONSULTATION_HEADING).length - 1).toBe(1);
  });

  /** Echte Agenten und echte Regeln, übrige Quellen als Attrappe */
  async function realPrompt(agentName: string): Promise<string> {
    const { consultation: _, agent: __, ...rest } = fakeSources().sources;
    return (await buildPromptContext({ userMessage: "q", chatId: "1", agentName }, rest)).fullPrompt;
  }
  const targets = (prompt: string) => [...prompt.matchAll(/^- ([a-z][a-z0-9-]*): /gm)].map(m => m[1]);
  const count = (text: string, part: string) => text.split(part).length - 1;

  test("research gelöscht: General und CTO nennen research nirgends mehr als Ziel, nur die erzeugte Liste steht im Prompt", async () => {
    for (const agent of ["general", "cto"]) {
      const before = await realPrompt(agent);
      expect(targets(before)).toContain("research");
    }
    await deleteAgent("research");
    for (const agent of ["general", "cto"]) {
      const prompt = await realPrompt(agent);
      expect(prompt).not.toContain(STATIC_CONSULTATION_HEADING);
      expect(prompt).not.toContain("**research**");
      expect(prompt).not.toMatch(/\[INVOKE:research\|/);
      expect(targets(prompt)).not.toContain("research");
      expect(count(prompt, CONSULTATION_HEADING)).toBe(1);
      expect(prompt).toContain(CONSULTATION_OVERRIDE);
      // Die erzeugte Liste steht nach Rolle und Kontext, vor den Tags
      expect(prompt.indexOf(CONSULTATION_HEADING)).toBeLessThan(prompt.indexOf("## MEMORY TAGS"));
    }
    expect(targets(await realPrompt("cto"))).toEqual(["critic"]);
    expect(targets(await realPrompt("general"))).toEqual(["content", "finance", "strategy", "critic", "cto", "coo"]);
  });

  test("gespeicherter Prompt bleibt wortgleich im Prompt und in der Datei, die erzeugte Liste setzt seine alte außer Kraft", async () => {
    const stored = "Du bist mein Technik-Agent.\n\n## CROSS-AGENT CONSULTATION (VISIBLE)\nAvailable agents you can invoke:\n- **research** — Recherche\nExample: [INVOKE:research|Was ist neu?]";
    await setPrompt("cto", stored);
    await deleteAgent("research");
    const prompt = await realPrompt("cto");
    expect(prompt.startsWith(stored)).toBe(true);
    expect(getAgent("cto")!.systemPrompt).toBe(stored);
    const generated = prompt.slice(prompt.indexOf(CONSULTATION_HEADING));
    expect(targets(generated)).toEqual(["critic"]);
    expect(generated).toContain(CONSULTATION_OVERRIDE);
    expect(prompt.indexOf(CONSULTATION_HEADING)).toBeGreaterThan(prompt.indexOf(stored) + stored.length);
  });

  test("darf niemanden fragen: ausdrücklich niemand, mit und ohne [INVOKE:] im gespeicherten Prompt", async () => {
    for (const stored of ["Du prüfst Pläne. Frag bei Bedarf [INVOKE:research|Quelle?]", "Du prüfst Pläne."]) {
      await setPrompt("critic", stored);
      const prompt = await realPrompt("critic");
      expect(prompt.startsWith(stored)).toBe(true);
      expect(prompt).toContain(NO_CONSULTATION_RULES);
      expect(count(prompt, CONSULTATION_HEADING)).toBe(1);
    }
  });

  const OTHERS = ["research", "content", "finance", "strategy", "critic", "cto", "coo"];

  test("alle anderen Agenten gelöscht: vollständiger General-Prompt sagt eindeutig, dass es keine Konsultationsziele gibt", async () => {
    const before = await realPrompt("general");
    expect(before).toContain("## ROUTING INTELLIGENCE");
    expect(before).not.toContain(NO_CONSULTATION_RULES);
    for (const name of OTHERS) await deleteAgent(name);
    const prompt = await realPrompt("general");
    // Seit #359 nennt ROUTING INTELLIGENCE keine Agenten mehr, sondern verweist auf diesen Abschnitt
    expect(prompt).toContain("## ROUTING INTELLIGENCE");
    expect(prompt).not.toContain(STATIC_CONSULTATION_HEADING);
    expect(prompt).not.toContain("## ADDITIONAL AGENTS");
    expect(prompt).not.toContain(CONSULTATION_OVERRIDE);
    expect(prompt).not.toMatch(/\[INVOKE:[a-z]/);
    expect(targets(prompt.slice(prompt.indexOf(CONSULTATION_HEADING)))).toEqual([]);
    expect(count(prompt, CONSULTATION_HEADING)).toBe(1);
    expect(prompt).toContain(NO_CONSULTATION_RULES);
    expect(NO_CONSULTATION_RULES).toMatch(/routing/);
    // Nach Rolle, Kanal und Kontext, vor den Tags
    expect(prompt.indexOf(NO_CONSULTATION_RULES)).toBeGreaterThan(prompt.indexOf("## ROUTING INTELLIGENCE"));
    expect(prompt.indexOf(NO_CONSULTATION_RULES)).toBeLessThan(prompt.indexOf("## MEMORY TAGS"));
  });

  test("alle anderen Agenten gelöscht: gespeicherter General-Prompt bleibt wortgleich im Prompt und in der Datei", async () => {
    const stored = "Du bist mein Assistent.\n\n## ROUTING\nRecherche gib an den Research-Agenten: [INVOKE:research|Frage]";
    await setPrompt("general", stored);
    for (const name of OTHERS) await deleteAgent(name);
    const prompt = await realPrompt("general");
    expect(prompt.startsWith(stored)).toBe(true);
    expect(getAgent("general")!.systemPrompt).toBe(stored);
    expect(count(prompt, CONSULTATION_HEADING)).toBe(1);
    expect(prompt.indexOf(NO_CONSULTATION_RULES)).toBeGreaterThan(stored.length);
  });

  test("neu formulierte Prompts (#359): Ziele nur aus der erzeugten Liste, genau einmal", async () => {
    const expected: Record<string, string[]> = {
      general: ["research", "content", "finance", "strategy", "critic", "cto", "coo"],
      research: ["critic"],
      content: ["research", "critic"],
      finance: ["critic"],
    };
    for (const [agent, want] of Object.entries(expected)) {
      const prompt = await realPrompt(agent);
      expect({ agent, targets: targets(prompt) }).toEqual({ agent, targets: want });
      expect(prompt).not.toContain(STATIC_CONSULTATION_HEADING);
      expect(count(prompt, CONSULTATION_HEADING)).toBe(1);
      expect(prompt).toContain(CONSULTATION_OVERRIDE);
    }
    // General verweist auf genau diesen Abschnitt, der nach dem Verweis steht
    const general = await realPrompt("general");
    expect(general.indexOf("## ROUTING INTELLIGENCE")).toBeLessThan(general.indexOf(CONSULTATION_HEADING));
    expect(general).toContain(`in the section\n  ${CONSULTATION_HEADING.replace(/^#+\s*/, "")}.`);
  });

  test("eigener Agent: kein angehängter fester Hinweis, die erzeugte Liste gilt", async () => {
    await createAgent({ name: "reise-planer", description: "Plant Reisen", systemPrompt: "Du planst Reisen." });
    await deleteAgent("research");
    const prompt = await realPrompt("reise-planer");
    expect(prompt).not.toContain(STATIC_CONSULTATION_HEADING);
    expect(prompt).toContain("Du planst Reisen.");
    expect(targets(prompt)).toEqual(["critic"]);
    expect(await realPrompt("general")).not.toContain("## ADDITIONAL AGENTS");
    expect(targets(await realPrompt("general"))).toContain("reise-planer");
  });
});

// ---------------------------------------------------------------------------
// Kanal im Chat-Kern
// ---------------------------------------------------------------------------

describe("Kanal im Chat-Kern", () => {
  let dir: string;
  let requests: EngineRequest[];
  let failNextResume = false;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tybo-358-kanal-"));
    setSettingsPath(join(dir, "settings.json"));
    setSessionsFileForTests(join(dir, "sessions.json"));
    requests = [];
    failNextResume = false;
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(async () => {
    logSpy.mockRestore();
    setSettingsPath();
    setSessionsFileForTests(null);
    await rm(dir, { recursive: true, force: true });
  });

  function deps(over: Partial<PromptSources> = {}): Partial<ChatTurnDeps> {
    const { sources } = fakeSources(over);
    let n = 0;
    const engine: Engine = {
      id: "claude",
      describe: () => "Attrappe",
      async run(req) {
        requests.push(req);
        n++;
        if (req.resumeSessionId && failNextResume) {
          failNextResume = false;
          return { engine: "claude", text: "", isError: true } as EngineResult;
        }
        return { engine: "claude", text: `antwort ${n}`, sessionId: "s-1", isError: false } as EngineResult;
      },
    };
    return {
      getEngine: () => engine,
      resolveEngine: async () => ({ engine: "claude" }),
      forgetEngineCheck: () => {},
      runFallbackChain: async () => ({ text: "ersatz", source: "openrouter", model: "ersatz" }),
      buildPromptContext: o => buildPromptContext(o, sources),
      buildResumePrompt: o => buildResumePrompt(o, sources),
      isSessionModeEnabled: () => true,
      getResumableSession,
      takeExpiredSession,
      recordSessionTurn,
      getSessionsForKey,
      sessionEpoch,
      resetSession,
      shouldDistill: () => false,
      distillSession: async () => {},
      log: async () => {},
      getAgentConfig: () => ({ name: "General", systemPrompt: "SYSTEM-GENERAL", model: "claude-agent-modell" }),
      getSettings,
      resolveStreamingLimits: () => resolveStreamingLimits({}),
      reportSecrets: () => [],
      setTimer: () => 0,
      clearTimer: () => {},
      now: () => 0,
    };
  }

  const turn = (d: Partial<ChatTurnDeps>, extra: Partial<TurnOptions> = {}) =>
    runStreamingTurn({
      userMessage: "Frage",
      chatId: "-100555",
      agentName: "general",
      topicId: 5,
      sink: { progress: () => {}, notice: () => {} },
      deps: d,
      ...extra,
    });

  const isTelegram = (prompt: string) => prompt.includes(formatChannelRules("telegram"));
  const isWeb = (prompt: string) => prompt.includes(formatChannelRules("web"));

  test("Wechsel Telegram, Browser, Telegram in derselben Topic-Session: jeder fortgesetzte Prompt trägt seinen Kanal", async () => {
    const d = deps();
    await turn(d);
    await turn(d, { channel: "web" });
    await turn(d);
    await turn(d, { channel: "telegram" });
    expect(requests.map(r => !!r.resumeSessionId)).toEqual([false, true, true, true]);
    expect(requests.map(r => (isTelegram(r.prompt) ? "telegram" : isWeb(r.prompt) ? "web" : "?"))).toEqual([
      "telegram",
      "web",
      "telegram",
      "telegram",
    ]);
    // Der Kanal stammt nie aus der Chat-ID: dieselbe Gruppe, verschiedene Kanäle
    expect(new Set(requests.map(r => r.resumeSessionId ?? "frisch"))).toEqual(new Set(["frisch", "s-1"]));
  });

  test("Kern (Issue #522): Session-Start und erste Nachricht nach /new tragen ihn, Folgenachrichten nicht; eine Änderung wirkt ohne Neustart", async () => {
    let core = "Kern A";
    const d = deps({ core: async () => core });
    await turn(d);
    core = "Kern B";
    await turn(d);
    expect(requests[0]!.resumeSessionId).toBeUndefined();
    expect(requests[0]!.prompt).toContain("Kern A");
    expect(requests[1]!.resumeSessionId).toBe("s-1");
    expect(requests[1]!.prompt).not.toContain("Kern");

    await resetSession("topic:-100555:5");
    requests.length = 0;
    await turn(d);
    expect(requests[0]!.resumeSessionId).toBeUndefined();
    expect(requests[0]!.prompt).toContain("Kern B");
    expect(requests[0]!.prompt).not.toContain("Kern A");
  });

  test("frische Session im Browser", async () => {
    await turn(deps(), { channel: "web" });
    expect(requests).toHaveLength(1);
    expect(isWeb(requests[0]!.prompt)).toBe(true);
    expect(requests[0]!.prompt).not.toContain(TELEGRAM_FORMAT_RULES);
    expect(requests[0]!.prompt.startsWith("SYSTEM-GENERAL")).toBe(true);
  });

  test("Neuversuch nach gescheiterter Fortsetzung: frischer Prompt mit demselben Kanal", async () => {
    const d = deps();
    await turn(d);
    failNextResume = true;
    await turn(d, { channel: "web" });
    expect(requests.map(r => !!r.resumeSessionId)).toEqual([false, true, false]);
    expect(isWeb(requests[1]!.prompt)).toBe(true);
    expect(isWeb(requests[2]!.prompt)).toBe(true);
    expect(requests[2]!.prompt.startsWith("SYSTEM-GENERAL")).toBe(true);
  });

  test("Konsultation aus dem Browser läuft mit den Kanalregeln der WebUI", async () => {
    const seen: TurnOptions[] = [];
    const runner = webConsultRunner(
      { sourceAgent: "general", chatId: "web:dm", sessionKey: "web:dm", conversationId: "c1", metadata: {}, noTelegram: true },
      {
        runStreamingTurn: async o => {
          seen.push(o);
          return "Einwand";
        },
        recentMessages: async () => [],
        log: () => {},
      },
      { answer: async () => {}, notice: async () => {}, signal: new AbortController().signal }
    );
    await runner({ targetAgent: "critic", question: "Hält der Plan?" }, async () => true);
    expect(seen.map(o => [o.agentName, o.channel])).toEqual([["critic", "web"]]);
  });
});
