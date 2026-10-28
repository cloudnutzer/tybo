/**
 * Issue #304: Agentennamen und Aliasse werden an drei Stellen aufgelöst, mit
 * bewusst unterschiedlichen Tabellen: Katalog (resolveAgentName,
 * canonicalAgentName), Agenten-Identitäten (Absender-Bot, Issue #330) und der Befehl /agent.
 * Diese Tabelle hält fest, was jede Stelle heute liefert. Angleichen wäre eine
 * Verhaltensänderung und ist nicht Teil des Issues.
 */
import { describe, expect, test } from "bun:test";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { createAgent, deleteAgent, isActiveAgent, resolveAgentName } from "../src/agents/catalog";
import { canonicalAgentName } from "../src/agents/names";
import { resolveCommandAgentName } from "../src/agents/command-agent";
import { AGENT_TOKEN_MAP, AgentIdentities } from "../src/channels/telegram/identities";
import { isolateAgentCatalog } from "./catalog-fixture";

isolateAgentCatalog();

/** Alle Aliasse aus allen drei Tabellen, Schreibweisen und ein unbekannter Name */
const INPUTS = [
  "researcher", "cmo", "cfo", "ceo", "devils-advocate", "dev", "development",
  "ops", "operations", "orchestrator", "outreach", "tech",
  "general", "research", "CFO", "Tech", " cfo ", "unbekannt",
] as const;
type Input = (typeof INPUTS)[number];

const CATALOG: Record<Input, string | undefined> = {
  researcher: "research", cmo: "content", cfo: "finance", ceo: "strategy",
  "devils-advocate": "critic", dev: "cto", development: "cto", ops: "coo",
  operations: "coo", orchestrator: "general", outreach: undefined, tech: undefined,
  general: "general", research: "research", CFO: "finance", Tech: undefined,
  " cfo ": "finance", unbekannt: undefined,
};

const CANONICAL: Record<Input, string> = {
  ...(Object.fromEntries(Object.entries(CATALOG).map(([k, v]) => [k, v ?? "general"])) as Record<Input, string>),
  // canonicalAgentName schneidet keine Leerzeichen ab
  " cfo ": "general",
};

/** Agent, dessen Bot die Identitäten liefern; "primary" ist der Haupt-Bot */
const REGISTRY: Record<Input, string> = {
  researcher: "research", cmo: "content", cfo: "finance", ceo: "strategy",
  "devils-advocate": "critic", dev: "cto", development: "cto", ops: "coo",
  operations: "coo", orchestrator: "primary", outreach: "primary", tech: "primary",
  general: "primary", research: "research", CFO: "finance", Tech: "primary",
  " cfo ": "primary", unbekannt: "primary",
};

/** /agent: outreach und tech ja, devils-advocate, development, orchestrator nein; kein Trimmen */
const COMMAND: Record<Input, string | undefined> = {
  researcher: "research", cmo: "content", cfo: "finance", ceo: "strategy",
  "devils-advocate": undefined, dev: "cto", development: undefined, ops: "coo",
  operations: "coo", orchestrator: undefined, outreach: "content", tech: "cto",
  general: "general", research: "research", CFO: "finance", Tech: "cto",
  " cfo ": undefined, unbekannt: undefined,
};

// Seit dem Umzug (Issue #304, Aufgabe 3) eigenes Modul; vorher stand die Tabelle in src/bot.ts
const resolveForCommand = resolveCommandAgentName;

describe("Katalog", () => {
  for (const input of INPUTS) {
    test(`resolveAgentName(${JSON.stringify(input)})`, () => {
      expect(resolveAgentName(input)).toBe(CATALOG[input]);
    });
    test(`canonicalAgentName(${JSON.stringify(input)})`, () => {
      expect(canonicalAgentName(input)).toBe(CANONICAL[input]);
    });
  }

  test("eigene und gelöschte Agenten", async () => {
    await createAgent({ name: "planer", description: "Plant", systemPrompt: "Du planst." });
    await deleteAgent("cto");
    expect(resolveAgentName("planer")).toBe("planer");
    expect(resolveAgentName("Planer")).toBe("planer");
    expect(resolveAgentName("dev")).toBeUndefined();
    expect(resolveAgentName("cto")).toBeUndefined();
  });
});

describe("Agenten-Identitäten", () => {
  const ME = { id: 1, is_bot: true, first_name: "Test", username: "test_bot" } as UserFromGetMe;

  async function registry(): Promise<{ reg: AgentIdentities; names: Map<Bot, string> }> {
    const names = new Map<Bot, string>();
    const primary = new Bot("1:primary", { botInfo: ME });
    names.set(primary, "primary");
    const env = Object.fromEntries(Object.entries(AGENT_TOKEN_MAP).map(([agent, envVar]) => [envVar, `2:${agent}`]));
    const reg = new AgentIdentities(primary, {
      env,
      createBot: token => {
        const bot = new Bot(token, { botInfo: { ...ME, username: `${token.slice(2)}_bot` } });
        names.set(bot, token.slice(2));
        return bot;
      },
    });
    const log = console.log;
    console.log = () => {};
    try {
      await reg.initialize();
    } finally {
      console.log = log;
    }
    return { reg, names };
  }

  test("jeder Agent mit Token hat einen eigenen Bot", async () => {
    const { reg, names } = await registry();
    for (const agent of Object.keys(AGENT_TOKEN_MAP)) expect(names.get(reg.botFor(agent))).toBe(agent);
  });

  for (const input of INPUTS) {
    test(`botFor(${JSON.stringify(input)})`, async () => {
      const { reg, names } = await registry();
      expect(names.get(reg.botFor(input))).toBe(REGISTRY[input]);
    });
  }
});

describe("/agent", () => {
  for (const input of INPUTS) {
    test(`${JSON.stringify(input)} mit allen mitgelieferten Agenten`, () => {
      expect(resolveForCommand(input, isActiveAgent)).toBe(COMMAND[input]);
    });
  }

  test("aktive Agenten gelten je Aufruf: eigene ja, gelöschte nicht mehr", async () => {
    expect(resolveForCommand("tech", isActiveAgent)).toBe("cto");
    await createAgent({ name: "planer", description: "Plant", systemPrompt: "Du planst." });
    await deleteAgent("cto");
    expect(resolveForCommand("planer", isActiveAgent)).toBe("planer");
    expect(resolveForCommand("PLANER", isActiveAgent)).toBe("planer");
    expect(resolveForCommand("tech", isActiveAgent)).toBeUndefined();
    expect(resolveForCommand("dev", isActiveAgent)).toBeUndefined();
    expect(resolveForCommand("cto", isActiveAgent)).toBeUndefined();
  });

  test("ohne Katalog: nur was der übergebene Prüfer kennt", () => {
    const only = (...names: string[]) => (name: string) => names.includes(name);
    expect(resolveForCommand("outreach", only("content"))).toBe("content");
    expect(resolveForCommand("outreach", only("research"))).toBeUndefined();
    expect(resolveForCommand("eigener", only("eigener"))).toBe("eigener");
  });
});
