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
