/**
 * Echter Agenten-Katalog für die Agenten-API (Issue #50): src/agents/catalog.ts
 * mit config/agents.json und config/topics.json. Wie bot-settings.ts bindet
 * nur src/bot.ts diese Datei ein; Tests nutzen sie mit temporären Dateien
 * (setAgentCatalogPaths).
 *
 * Fehler des Katalogs werden zu AgentPortError mit festen Texten; nur bei
 * „invalid" geht die Meldung des Katalogs mit (Texte aus dem Schema, nie
 * Inhalte der Datei).
 */

import {
  AgentCatalogError,
  AgentCatalogFileInvalid,
  AgentCatalogNameTaken,
  AgentCatalogNotFound,
  AgentCatalogTopicsInvalid,
  AgentCatalogTopicsNotMoved,
  BUILTIN_AGENTS,
  createAgent,
  deleteAgent,
  getAgent,
  getBuiltinCodePrompt,
  isAgentNameTaken,
  listAgents,
  listDeletedBuiltins,
  listTopicUsage,
  resetPrompt,
  restoreBuiltin,
  setBoard,
  setPrompt,
} from "../agents/catalog";
import { AgentPortError, type AgentCatalogPort } from "./agent-catalog";

function translate(e: unknown): unknown {
  if (e instanceof AgentCatalogNotFound) return new AgentPortError("notFound", "Unbekannter Agent");
  if (e instanceof AgentCatalogNameTaken) return new AgentPortError("taken", "Kennung vergeben");
  if (e instanceof AgentCatalogFileInvalid) return new AgentPortError("fileInvalid", "config/agents.json ist ungültig");
  if (e instanceof AgentCatalogTopicsInvalid) return new AgentPortError("topicsInvalid", "config/topics.json ist ungültig");
  if (e instanceof AgentCatalogTopicsNotMoved) return new AgentPortError("topicsNotMoved", "Topics nicht umgestellt");
  if (e instanceof AgentCatalogError) return new AgentPortError("invalid", e.message);
  return e;
}

async function wrap<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw translate(e);
  }
}

export const botAgentCatalog: AgentCatalogPort = {
  list: () =>
    listAgents().map(a => ({
      name: a.name,
      description: a.description,
      origin: a.origin,
      promptSource: a.promptSource,
      board: a.board,
    })),
  deleted: () => listDeletedBuiltins().map(name => ({ name, description: BUILTIN_AGENTS[name] })),
  prompt(name) {
    // Nur die genaue Kennung, keine Aliasse
    const agent = getAgent(name);
    if (!agent || agent.name !== name) return undefined;
    return {
      systemPrompt: agent.systemPrompt,
      codePrompt: agent.origin === "builtin" ? getBuiltinCodePrompt(name) ?? null : null,
      promptSource: agent.promptSource,
    };
  },
  isNameTaken: isAgentNameTaken,
  topicUsage: listTopicUsage,
  setPrompt: (name, text) => wrap(() => setPrompt(name, text)),
  resetPrompt: name => wrap(() => resetPrompt(name)),
  create: input => wrap(async () => void (await createAgent(input))),
  delete: name => wrap(() => deleteAgent(name)),
  restore: name => wrap(async () => void (await restoreBuiltin(name))),
  setBoard: (name, on) => wrap(() => setBoard(name, on)),
};
