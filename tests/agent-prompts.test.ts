/**
 * Allgemeine Standard-Prompts der mitgelieferten Agenten (Issue #136).
 *
 * Die Prompts sind für jeden Nutzer gedacht: keine persönlichen Namen,
 * Arbeitgeber oder Branchen, Sprachregel statt fester Sprache. Kennungen,
 * Aliasse, Denkweisen, Modelle und Board-Schalter bleiben, wie sie waren; nur
 * der Anzeigename von content ist verallgemeinert.
 */
import { describe, expect, test } from "bun:test";
import { AGENT_ALIASES, AGENT_NAMES } from "../src/agents/names";
import { boardAgentNames, BUILTIN_AGENTS, getAgent, listAgents } from "../src/agents/catalog";
import { isolateAgentCatalog } from "./catalog-fixture";
import type { AgentConfig } from "../src/agents/base";

isolateAgentCatalog();

const load = (name: string): AgentConfig => require(`../src/agents/${name}`).default;
const LANGUAGE_RULE = "Respond in the language the user uses";

describe("mitgelieferte Agenten nach der Verallgemeinerung", () => {
  test("Kennungen, Aliasse und Reihenfolge unverändert", () => {
    expect([...AGENT_NAMES]).toEqual(["general", "research", "content", "finance", "strategy", "critic", "cto", "coo"]);
    expect(Object.keys(BUILTIN_AGENTS)).toEqual([...AGENT_NAMES]);
    expect(AGENT_ALIASES).toEqual({
      researcher: "research",
      cmo: "content",
      cfo: "finance",
      ceo: "strategy",
      "devils-advocate": "critic",
      dev: "cto",
      development: "cto",
      ops: "coo",
      operations: "coo",
      orchestrator: "general",
    });
  });

  test("Anzeigenamen und Denkweisen; content heißt Content Agent (CMO)", () => {
    const got = Object.fromEntries(AGENT_NAMES.map(n => [n, [load(n).name, load(n).reasoning]]));
    expect(got).toEqual({
      general: ["General Agent (Orchestrator)", "adaptive"],
      research: ["Research Agent (Deep Research)", "ReAct"],
      content: ["Content Agent (CMO)", "RoT"],
      finance: ["Finance Agent (CFO)", "CoT"],
      strategy: ["Strategy Agent (CEO)", "ToT"],
      critic: ["Critic Agent", "devils-advocate"],
      cto: ["Tech & Learning Agent", "systematic"],
      coo: ["Ops & Process Agent", "process-systems"],
    });
    expect(getAgent("content")!.displayName).toBe("Content Agent (CMO)");
  });

  test("alle mitgelieferten Agenten nutzen dasselbe Modell wie General, ohne Effort-Vorgabe", () => {
    const general = load("general");
    for (const name of AGENT_NAMES) {
      expect(load(name).model).toBe(general.model);
      expect(load(name).effort).toBeUndefined();
    }
    expect(require("../src/agents/custom-agent.example").default.model).toBe(general.model);
  });

  test("Board: gleiche Teilnehmer und Reihenfolge, General moderiert", () => {
    expect(boardAgentNames()).toEqual(["research", "content", "finance", "strategy", "cto", "coo", "critic"]);
    expect(getAgent("general")!.board).toBe(false);
  });

  test("ohne config/agents.json gelten die Code-Prompts", () => {
    for (const agent of listAgents()) {
      expect(agent.promptSource).toBe("code");
      expect(agent.systemPrompt).toBe(load(agent.name).systemPrompt);
    }
  });

  // Die Prüfung auf persönliche Begriffe liegt seit Issue #138 in der Werkstatt,
  // weil ihr Suchmuster die Begriffe selbst enthält
  test("Sprachregel in jedem Prompt", () => {
    const prompts = [...AGENT_NAMES.map(n => [n, load(n)] as const), ["custom-agent.example", require("../src/agents/custom-agent.example").default] as const];
    for (const [name, config] of prompts) {
      expect({ name, rule: config.systemPrompt.includes(LANGUAGE_RULE) }).toEqual({ name, rule: true });
    }
  });

  test("Denkweise steht weiter im Prompt, Finance mit Hinweis auf keine Anlage- oder Steuerberatung", () => {
    const markers: Record<string, string> = {
      research: "RESEARCH PROCESS (ReAct)",
      content: "THINKING PROCESS (Recursion of Thought)",
      finance: "STATE ASSUMPTIONS",
      strategy: "THINKING PROCESS (Tree of Thought)",
      critic: "Pre-Mortem Analysis",
      cto: "THINKING PROCESS (Systematic Engineering)",
      coo: "THINKING PROCESS (Process/Systems)",
      general: "ROUTING INTELLIGENCE",
    };
    for (const [name, marker] of Object.entries(markers)) expect(load(name).systemPrompt).toContain(marker);
    const finance = load("finance").systemPrompt;
    expect(finance).toContain("NOT FINANCIAL, INVESTMENT, OR TAX ADVICE");
    expect(finance).toMatch(/not a licensed financial, investment, or tax advisor/);
  });
});

// ---------------------------------------------------------------------------
// Issue #359: Prompts von general, research, content und finance neu
// ---------------------------------------------------------------------------

describe("neu formulierte Prompts (Issue #359)", () => {
  const REWRITTEN = ["general", "research", "content", "finance"] as const;
  const { CONSULTATION_HEADING, STATIC_CONSULTATION_HEADING } = require("../src/agents/prompt-parts") as typeof import("../src/agents/prompt-parts");
  const prompt = (name: string) => load(name).systemPrompt;

  test("je Prompt Rolle, Arbeitsweise, Ausgabeform und Grenzen", () => {
    for (const name of REWRITTEN) {
      const p = prompt(name);
      expect({ name, role: p.includes("## ROLE: ") }).toEqual({ name, role: true });
      expect({ name, limits: p.includes("## LIMITS") }).toEqual({ name, limits: true });
    }
    expect(prompt("general")).toContain("## HOW YOU WORK");
    for (const name of ["research", "content", "finance"]) expect(prompt(name)).toContain("## SHAPE OF THE ANSWER");
  });

  test("keine festen Agentenlisten und keine festen Weiterleitungsziele mehr", () => {
    const others = AGENT_NAMES.filter(n => n !== "general");
    for (const name of REWRITTEN) {
      const p = prompt(name);
      expect(p).not.toContain(STATIC_CONSULTATION_HEADING);
      expect(p).not.toMatch(/\[INVOKE:[a-z][a-z0-9-]*\|/);
      expect(p).not.toMatch(/^- \*\*[a-z-]+\*\*/m);
      for (const other of others) {
        const display = load(other).name;
        expect({ name, other, named: p.includes(display) }).toEqual({ name, other, named: false });
      }
      // Kurzformen der Rollen, mit denen frühere Prompts weitergeleitet haben
      expect(p).not.toMatch(/\b(CMO|CFO|CEO|CTO|COO)\b/);
      expect(p).not.toMatch(/\b(Research|Content|Finance|Strategy|Critic|Tech & Learning|Ops) agent\b/);
    }
  });

  test("General verweist auf die erzeugte Liste aus dem Katalog und spielt kein Board", () => {
    const p = prompt("general");
    expect(p).toContain(CONSULTATION_HEADING.replace(/^#+\s*/, ""));
    expect(p).toMatch(/Never name, suggest or invoke an agent that is not\s+listed there/);
    expect(p).toContain("## BOARD MEETINGS");
    expect(p).toContain("/board <topic>");
    expect(p).toMatch(/Never act out a board meeting yourself/);
    expect(p).toContain("/topics");
  });

  test("Research: Quellen und Preis/Bestand nur aus dem sichtbaren Seitentext", () => {
    const p = prompt("research");
    expect(p).toMatch(/link to its source/);
    expect(p).toMatch(/only from the visible page text/);
    expect(p).toMatch(/Never rely on schema\.org, OpenGraph or JSON-LD metadata/);
  });

  test("Content: Zielgruppe, Kanal und Sprache des Publikums", () => {
    const p = prompt("content");
    expect(p).toContain("## AUDIENCE FIRST");
    expect(p).toMatch(/write the text itself in the\s+language its audience needs/);
  });

  test("Finance: Annahmen, Rechenweg, Szenarien und Beratungsgrenze", () => {
    const p = prompt("finance");
    expect(p).toMatch(/show the numbers/);
    expect(p).toMatch(/cautious, an expected and an optimistic case/);
    expect(p).toMatch(/Do not tell the user\s+to buy or sell a specific security/);
    expect(p).toMatch(/currency and date/);
  });

  test("Sprachweg: General erklärt GOAL mit DEADLINE, DONE und REMEMBER in beiden Sprachstilen", async () => {
    const { createVoiceContext } = require("../src/lib/voice-brain/context") as typeof import("../src/lib/voice-brain/context");
    const { voiceStyle } = require("../src/lib/voice-brain/style") as typeof import("../src/lib/voice-brain/style");
    const { parseMemoryIntents } = require("../src/lib/memory/intents") as typeof import("../src/lib/memory/intents");
    // Wie Brücke (src/voice-bridge.ts) und Telefonhörer (src/web/bot-call.ts): Agenten-Prompt ohne Builder
    const context = createVoiceContext({
      agent: { systemPrompt: prompt("general") },
      deps: { getUserProfile: async () => "", getMemoryContext: async () => "", getRecentMessages: async () => [] },
    });
    const loaded = await context.load("");
    for (const channel of ["phone", "call"] as const) {
      const system = [loaded, voiceStyle({ agentName: "Mia", channel })].join("\n\n");
      const goal = /\[GOAL: [^\]|]+\| DEADLINE: [^\]]+\]/.exec(system)?.[0];
      expect({ channel, goal: Boolean(goal) }).toEqual({ channel, goal: true });
      // Die erklärte Syntax ist die, die der Parser liest
      expect(parseMemoryIntents(goal!)).toEqual([{ type: "goal", text: "goal", deadline: "deadline" }]);
      expect(system).toMatch(/Leave out\s+"\| DEADLINE: \.\.\." when there is no deadline/);
      expect(system).toMatch(/A goal is reached: \[DONE: [^\]]+\]/);
      expect(system).toMatch(/A fact is worth keeping: \[REMEMBER: [^\]]+\]/);
    }
  });

  test("Basis-Teil steht vorn, genau einmal", () => {
    const { BASE_CONTEXT } = require("../src/agents/prompt-parts") as typeof import("../src/agents/prompt-parts");
    for (const name of REWRITTEN) {
      expect(prompt(name).startsWith(BASE_CONTEXT)).toBe(true);
      expect(prompt(name).split(BASE_CONTEXT).length - 1).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #360: Prompts von strategy, critic, cto, coo und der Vorlage neu
// ---------------------------------------------------------------------------

describe("neu formulierte Prompts (Issue #360)", () => {
  const REWRITTEN = ["strategy", "critic", "cto", "coo"] as const;
  const { BASE_CONTEXT, STATIC_CONSULTATION_HEADING } = require("../src/agents/prompt-parts") as typeof import("../src/agents/prompt-parts");
  const example = (): AgentConfig => require("../src/agents/custom-agent.example").default;
  const prompt = (name: string) => load(name).systemPrompt;
  const all = () => [...REWRITTEN.map(n => [n, prompt(n)] as const), ["custom-agent.example", example().systemPrompt] as const];

  test("je Prompt Rolle, Ausgabeform, Grenzen und Sprachregel", () => {
    for (const [name, p] of all()) {
      for (const heading of ["## ROLE: ", "## SHAPE OF THE ANSWER", "## LIMITS"]) {
        expect({ name, heading, found: p.includes(heading) }).toEqual({ name, heading, found: true });
      }
      expect(p).toContain(LANGUAGE_RULE);
    }
  });

  test("Basis-Teil steht vorn, genau einmal", () => {
    for (const [name, p] of all()) {
      expect({ name, start: p.startsWith(BASE_CONTEXT) }).toEqual({ name, start: true });
      expect({ name, count: p.split(BASE_CONTEXT).length - 1 }).toEqual({ name, count: 1 });
    }
  });

  test("keine festen Agentenlisten und keine festen Weiterleitungsziele mehr", () => {
    for (const [name, p] of all()) {
      expect(p).not.toContain(STATIC_CONSULTATION_HEADING);
      expect(p).not.toMatch(/\[INVOKE:[a-z][a-z0-9-]*\|/);
      expect(p).not.toMatch(/^- \*\*[a-z-]+\*\*/m);
      for (const other of AGENT_NAMES.filter(n => n !== name)) {
        expect({ name, other, named: p.includes(load(other).name) }).toEqual({ name, other, named: false });
      }
      expect(p).not.toMatch(/\b(CMO|CFO|CEO|CTO|COO)\b/);
      expect(p).not.toMatch(/\b(Research|Content|Finance|Strategy|Critic|Tech & Learning|Ops) agent\b/);
    }
  });

  test("Strategy: verschiedene Wege, Blick in die Zukunft, eine klare Empfehlung", () => {
    const p = prompt("strategy");
    expect(p).toMatch(/three to five paths that really differ/);
    expect(p).toMatch(/three\s+months, after one year, after three years/);
    expect(p).toMatch(/Always commit to one recommendation/);
    expect(p).toMatch(/The decision stays with the user/);
  });

  test("Critic: Pre-Mortem, Bewertung der Risiken und immer ein Weg nach vorn", () => {
    const p = prompt("critic");
    expect(p).toMatch(/plan went badly wrong/);
    expect(p).toMatch(/likelihood and impact/);
    expect(p).toMatch(/Always end with a way forward/);
    expect(p).toMatch(/Criticize the plan, never the person/);
  });

  test("CTO: erklärt das Warum, Aufwand je Schritt, Sicherheit und Paketnamen", () => {
    const p = prompt("cto");
    expect(p).toMatch(/explain why\s+things work/);
    expect(p).toMatch(/Every plan or recommendation comes with an effort estimate/);
    expect(p).toMatch(/Point out security problems right away/);
    expect(p).toMatch(/check its exact name, its source/);
  });

  test("COO: Zuständigkeit und Frist je Aufgabe, Zeitzone, kein erfundener Stand", () => {
    const p = prompt("coo");
    expect(p).toMatch(/Give every task one owner and a due date/);
    expect(p).toMatch(/with owner and due date for each item/);
    expect(p).toMatch(/user's time zone/);
    expect(p).toMatch(/Do not guess whether something is done/);
  });

  test("Vorlage: nicht registriert, erklärt den Weg ohne Code und die Registrierung", () => {
    const { BUILTIN_AGENTS } = require("../src/agents/catalog") as typeof import("../src/agents/catalog");
    const source: string = require("fs").readFileSync(require("path").join(import.meta.dir, "../src/agents/custom-agent.example.ts"), "utf8");
    expect(Object.values(BUILTIN_AGENTS).some(d => d.includes(example().name))).toBe(false);
    expect(listAgents().some(a => a.displayName === example().name)).toBe(false);
    for (const hint of ["config/agents.json", "AGENT_NAMES", "BUILTIN_AGENTS", "BUILTIN_LOADERS"]) expect(source).toContain(hint);
  });
});
