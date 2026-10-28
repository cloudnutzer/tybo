/**
 * Issue #136, Aufgabe 4: gesicherte Prompts im echten WebUI-Adapter
 * (src/web/bot-agents.ts, nicht web:dev/demo.ts). Nach dem Sichern zeigt
 * die Agenten-Seite den alten Prompt als eigenen, den neuen allgemeinen als
 * Standard zum Zurücksetzen. Katalog nur in temporären Dateien.
 */
import { describe, expect, test } from "bun:test";
import { addMissingBuiltinPrompts, BUILTIN_AGENTS, getBuiltinCodePrompt } from "../src/agents/catalog";
import { botAgentCatalog } from "../src/web/bot-agents";
import { isolateAgentCatalog } from "./catalog-fixture";

isolateAgentCatalog();

const ALL = Object.keys(BUILTIN_AGENTS);
const oldPrompt = (name: string) => `Alter Prompt von ${name}\n## ROLE\nPersönlich zugeschnitten.`;

describe("WebUI-Adapter mit gesicherten Prompts", () => {
  test("ohne Katalog: neuer Standard als systemPrompt und codePrompt, promptSource code", () => {
    for (const name of ALL) {
      const code = require(`../src/agents/${name}`).default.systemPrompt;
      expect(botAgentCatalog.prompt(name)).toEqual({ systemPrompt: code, codePrompt: code, promptSource: "code" });
    }
  });

  test("nach dem Sichern: alter systemPrompt, neuer codePrompt, promptSource custom", async () => {
    const result = await addMissingBuiltinPrompts(Object.fromEntries(ALL.map(n => [n, oldPrompt(n)])));
    expect(result.added).toEqual(ALL);
    for (const name of ALL) {
      const code = require(`../src/agents/${name}`).default.systemPrompt;
      expect(code).not.toBe(oldPrompt(name));
      expect(getBuiltinCodePrompt(name)).toBe(code);
      expect(botAgentCatalog.prompt(name)).toEqual({ systemPrompt: oldPrompt(name), codePrompt: code, promptSource: "custom" });
    }
    expect(botAgentCatalog.list().map(a => [a.name, a.promptSource])).toEqual(ALL.map(n => [n, "custom"]));
  });

  test("Zurücksetzen holt den neuen allgemeinen Prompt", async () => {
    await addMissingBuiltinPrompts({ research: oldPrompt("research") });
    await botAgentCatalog.resetPrompt("research");
    const code = getBuiltinCodePrompt("research")!;
    expect(botAgentCatalog.prompt("research")).toEqual({ systemPrompt: code, codePrompt: code, promptSource: "code" });
  });

  test("Liste und gelöschte Agenten zeigen die neuen Beschreibungen", async () => {
    await botAgentCatalog.delete("cto");
    expect(botAgentCatalog.deleted()).toEqual([{ name: "cto", description: BUILTIN_AGENTS.cto }]);
    const result = await addMissingBuiltinPrompts({ cto: oldPrompt("cto"), coo: oldPrompt("coo") });
    expect(result.skipped).toEqual([{ name: "cto", reason: "gelöscht" }]);
    expect(botAgentCatalog.prompt("cto")).toBeUndefined();
    expect(botAgentCatalog.list().find(a => a.name === "content")!.description).toBe(BUILTIN_AGENTS.content);
  });
});
