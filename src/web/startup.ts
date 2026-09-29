/**
 * Start der WebUI aus src/bot.ts (Issue #6). Fehler hier dürfen den Bot nie
 * aufhalten: deaktiviert, ungültig konfiguriert oder nicht startbar heißt
 * „Bot läuft ohne WebUI weiter", mit einer Log-Zeile ohne Passwort.
 */

import { networkInterfaces } from "node:os";
import { loadWebConfig, type WebConfig } from "./config";
import type { AgentInfo } from "./agents";
import type { AgentCatalogPort } from "./agent-catalog";
import type { WebChat } from "./chat";
import type { WebServer, WebServerDeps } from "./server";
import type { TelegramLiveFeed, TelegramSource } from "./telegram";
import type { TopicManager } from "./topics";
import type { SettingsPort } from "./settings";
import type { InstructionsPort } from "./instructions";
import type { ModelCatalog, OpenCodeModelsPort } from "./models";
import type { StatusPort } from "./status";
import type { EnginePort } from "./engines";
import type { FilesDeps } from "./files";
import type { UploadStore } from "./uploads";
import { defaultCliTokenFile } from "./cli-token";
import type { ConversationSessionReset } from "./session-reset";
import type { CommandPort } from "./commands";
import type { GoalPort } from "./goals";
import type { ChoicePort } from "./choices";
import type { KeysPort } from "./keys";

type Env = Record<string, string | undefined>;

export interface StartWebUiOptions {
  env: Env;
  chat: WebChat;
  /** Telegram-Direktchat und -Topics zum Lesen (Issue #17); in bot.ts createBotTelegram */
  telegram?: TelegramSource;
  /** Schreiben in Telegram-Gespräche (Issue #19); in bot.ts createTelegramChat */
  telegramChat?: WebChat;
  /** Neue Nachrichten aus Telegram live (Issue #20); in bot.ts createBotTelegramLive */
  telegramLive?: TelegramLiveFeed;
  /** Agenten für neue Web-Gespräche (Issue #21); ohne Angabe aus agentCatalog */
  agents?: AgentInfo[] | (() => AgentInfo[]);
  /** Agenten-Katalog verwalten (Issue #50); in bot.ts botAgentCatalog, liefert auch die Agentenlisten */
  agentCatalog?: AgentCatalogPort;
  /** Session-Reset beim Löschen eines Web-Gesprächs (Issue #21); in bot.ts resetSession */
  resetSession?: (sessionKey: string) => Promise<unknown>;
  /** Session eines Gesprächs frisch starten wie /new (Issue #61); in bot.ts createBotSessionReset */
  resetConversation?: ConversationSessionReset;
  /** Telegram-Topics anlegen und verwalten (Issue #29); in bot.ts createBotTopics */
  topics?: TopicManager;
  /** Einstellungen lesen und ändern (Issue #36); in bot.ts botSettings */
  settings?: SettingsPort;
  /** Agenten-Anweisungen wie /agent (Issue #36); in bot.ts botInstructions */
  instructions?: InstructionsPort;
  /** Modell-Listen (Issue #36); ohne Angabe die Standard-Abfrage im Server */
  models?: ModelCatalog;
  /** `opencode models` für die Modell-Liste (Issue #129); in bot.ts listOpenCodeModels */
  opencodeModels?: OpenCodeModelsPort;
  /** Status und Neustart-Anforderung (Issue #37); in bot.ts createBotStatus */
  status?: StatusPort;
  /** Motor-Wahl (Issue #126); in bot.ts createBotEngines */
  engines?: EnginePort;
  /** Dateien aus Meldungen herunterladen (Issue #47); in bot.ts createBotFiles */
  files?: FilesDeps;
  /** Anhänge aus dem Web-Chat (Issue #72); in bot.ts eine UploadStore auf data/uploads */
  uploads?: UploadStore;
  /** Slash-Befehle aus Browser und Terminal (Issue #74); in bot.ts createBotCommands */
  commands?: CommandPort;
  /** Status-Karte der Ziele (Issue #76); in bot.ts createBotGoals */
  goals?: GoalPort;
  /** Rückfrage-Knöpfe aus dem Register (Issue #115); in bot.ts createBotChoices */
  choices?: ChoicePort;
  /** Schlüssel in .env lesen und schreiben (Issue #62); in bot.ts createBotKeys */
  keys?: KeysPort;
  /**
   * Schlüsseldatei für den Terminal-Zugang (Issue #59). Standard:
   * data/cli-token im Projekt (GO_PROJECT_ROOT oder Arbeitsverzeichnis).
   */
  cliTokenFile?: string;
  /** In bot.ts createWebServer aus ./server, in Tests eine Attrappe */
  createServer(config: WebConfig, deps: WebServerDeps): Promise<WebServer>;
  log?(message: string): void;
  /** IPv4-Adressen im Heimnetz, Standard: aus os.networkInterfaces() */
  lanAddresses?(): string[];
}

/** IPv4-Adressen aller Netzwerkkarten außer localhost. */
export function lanIPv4Addresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}

/** Adressen, unter denen die WebUI erreichbar ist. Bei 0.0.0.0 oder :: localhost plus LAN-IPs. */
export function reachableUrls(host: string, port: number, lan: string[]): string[] {
  if (host === "0.0.0.0" || host === "::") {
    return [`http://localhost:${port}`, ...lan.map(ip => `http://${ip}:${port}`)];
  }
  return [`http://${host.includes(":") ? `[${host}]` : host}:${port}`];
}

/** Entfernt das Passwort aus Fehlermeldungen, falls es darin vorkommt. */
function scrub(message: string, password: string): string {
  return password ? message.split(password).join("***") : message;
}

/** Startet die WebUI, wenn sie eingeschaltet und gültig ist; sonst null. Wirft nie. */
export async function startWebUi(options: StartWebUiOptions): Promise<WebServer | null> {
  const log = options.log ?? ((m: string) => console.log(`[web] ${m}`));
  const result = loadWebConfig(options.env);
  if (result.status === "disabled") {
    log("WebUI aus (WEB_ENABLED ist nicht true)");
    return null;
  }
  if (result.status === "invalid") {
    log(`WebUI startet nicht: ${result.reason} (Bot läuft ohne WebUI weiter)`);
    return null;
  }
  const config = result.config;
  let server: WebServer;
  try {
    server = await options.createServer(config, {
      chat: options.chat,
      telegram: options.telegram,
      telegramChat: options.telegramChat,
      telegramLive: options.telegramLive,
      agents: options.agents,
      agentCatalog: options.agentCatalog,
      resetSession: options.resetSession,
      resetConversation: options.resetConversation,
      topics: options.topics,
      settings: options.settings,
      instructions: options.instructions,
      models: options.models,
      opencodeModels: options.opencodeModels,
      status: options.status,
      engines: options.engines,
      files: options.files,
      uploads: options.uploads,
      commands: options.commands,
      goals: options.goals,
      choices: options.choices,
      keys: options.keys,
      cliTokenFile: options.cliTokenFile ?? defaultCliTokenFile(),
      log,
    });
  } catch (e) {
    const reason = scrub(e instanceof Error ? e.message : String(e), config.password);
    log(`WebUI startet nicht auf ${config.host}:${config.port}: ${reason} (Bot läuft ohne WebUI weiter)`);
    return null;
  }
  const port = Number(new URL(server.url).port) || config.port;
  const urls = reachableUrls(config.host, port, (options.lanAddresses ?? lanIPv4Addresses)());
  log(`WebUI läuft: ${urls.join(", ")}`);
  return server;
}
