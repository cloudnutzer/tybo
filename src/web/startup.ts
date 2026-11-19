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
import type { VoicePort } from "./voice";
import type { SpeechPort } from "./speech";
import type { CallMemoryPort } from "./call-history";
import type { CallPort } from "./call-protocol";
import type { VoiceClonePort } from "./voice-clone";
import type { VoiceAgentSessionPort } from "./voice-agent-page";
import type { InstructionsPort } from "./instructions";
import type { ModelCatalog, OpenCodeModelsPort } from "./models";
import type { OpenRouterKeyPort } from "./openrouter-key";
import type { StatusPort } from "./status";
import type { JobsPort } from "./jobs";
import type { PipelinesPort } from "./pipelines";
import type { RoutinesPort } from "./routines";
import type { ThreadsPort } from "./threads";
import type { RemindersPort } from "./reminders";
import type { EnginePort } from "./engines";
import type { FilesDeps } from "./files";
import type { UploadStore } from "./uploads";
import { defaultCliTokenFile } from "./cli-token";
import type { ConversationSessionReset } from "./session-reset";
import type { CommandPort } from "./commands";
import type { GoalPort } from "./goals";
import type { ChoicePort } from "./choices";
import type { KeysPort } from "./keys";
import type { PushDeps } from "./push-api";

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
  onSettingsSaved?: () => Promise<unknown>;
  /** Status der Sprechmodi für GET /api/voice (Issue #248); in bot.ts botVoice */
  voice?: VoicePort;
  /** Sprechmodus: Hören und Sprechen für die Routen aus Issue #249; in bot.ts createBotSpeech */
  speech?: SpeechPort;
  /** Telefonhörer (Issue #257): WebSocket /api/call und modes.call; in bot.ts createBotCall */
  call?: CallPort;
  /** Telefongespräch im Verlauf (Issue #260): Gedächtnis; in bot.ts createCallMemory */
  callMemory?: CallMemoryPort;
  /** Eigene Stimme (Issue #253) */
  voiceClone?: VoiceClonePort;
  /** Web-Gespräch je Rezept (Issue #494); in bot.ts createVoiceAgentSessions */
  voiceAgentSessions?: VoiceAgentSessionPort;
  /** Bereich „Sprachagenten“ (Issue #495); in bot.ts createVoiceAgentAdmin */
  voiceAgentAdmin?: WebServerDeps["voiceAgentAdmin"];
  voiceAgentWizard?: WebServerDeps["voiceAgentWizard"];
  /** Agenten-Anweisungen wie /agent (Issue #36); in bot.ts botInstructions */
  instructions?: InstructionsPort;
  /** Modell-Listen (Issue #36); ohne Angabe die Standard-Abfrage im Server */
  models?: ModelCatalog;
  /** `opencode models` für die Modell-Liste (Issue #129); in bot.ts listOpenCodeModels */
  opencodeModels?: OpenCodeModelsPort;
  /** Status und Neustart-Anforderung (Issue #37); in bot.ts createBotStatus */
  status?: StatusPort;
  /** Routinen-Zentrale, nur lesend (Issue #284); in bot.ts createBotRoutines */
  routines?: RoutinesPort;
  jobs?: JobsPort;
  pipelines?: PipelinesPort;
  /** Offene Fäden (Issue #293); in bot.ts createBotThreads */
  threads?: ThreadsPort;
  /** Erinnerungen (Issue #323): GET /api/reminders, POST /api/reminders/<id>/cancel */
  reminders?: RemindersPort;
  /** Motor-Wahl (Issue #126); in bot.ts createBotEngines */
  engines?: EnginePort;
  /** Limit des Ersatzmodell-Schlüssels, ohne Einfluss auf die Motorwahl (Issue #674). */
  openrouterKey?: OpenRouterKeyPort;
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
  /** Web Push (Issue #225): Schlüssel und Kontakt; in bot.ts prepareBotPush aus ./bot-push */
  push?: PushDeps;
  /** Meldungen für reine Web-Gespräche (Issue #227); in bot.ts getDisplayOnlyPage und onMessageSaved */
  webNotices?: WebServerDeps["webNotices"];
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

/**
 * Adresse der WebUI für Links, die tybo verschickt (/sprachagent link, Issue
 * #494): WEB_PUBLIC_ORIGIN, sonst bei 0.0.0.0 die erste LAN-Adresse, sonst der
 * eingestellte Host. null, wenn die WebUI aus oder falsch eingestellt ist.
 */
export function webUiBaseUrl(env: Record<string, string | undefined>, lan: () => string[] = lanIPv4Addresses): string | null {
  const result = loadWebConfig(env);
  if (result.status !== "ok") return null;
  if (result.config.publicOrigin) return result.config.publicOrigin;
  const urls = reachableUrls(result.config.host, result.config.port, lan());
  return urls[1] ?? urls[0];
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
      onSettingsSaved: options.onSettingsSaved,
      voice: options.voice,
      speech: options.speech,
      call: options.call,
      callMemory: options.callMemory,
      voiceClone: options.voiceClone,
      voiceAgentSessions: options.voiceAgentSessions,
      voiceAgentAdmin: options.voiceAgentAdmin,
      voiceAgentWizard: options.voiceAgentWizard,
      instructions: options.instructions,
      models: options.models,
      opencodeModels: options.opencodeModels,
      status: options.status,
      routines: options.routines,
      jobs: options.jobs,
      pipelines: options.pipelines,
      threads: options.threads,
      reminders: options.reminders,
      engines: options.engines,
      openrouterKey: options.openrouterKey,
      files: options.files,
      uploads: options.uploads,
      commands: options.commands,
      goals: options.goals,
      choices: options.choices,
      keys: options.keys,
      push: options.push,
      webNotices: options.webNotices,
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
