#!/usr/bin/env bun
/**
 * Startet nur den Web-Server der WebUI, ohne Bot (kein Telegram-Polling).
 * Der Chat läuft gegen eine Attrappe (src/web/fake-chat.ts), nicht gegen Claude.
 *
 *   WEB_ENABLED=true WEB_PORT=3199 WEB_PASSWORD=... bun run web:dev
 *
 * Demo für Screenshots (nur 127.0.0.1, ohne Anmeldung, eigene Beispieldaten
 * in einem temporären Verzeichnis, WEB_PASSWORD bleibt Pflicht):
 *
 *   WEB_DEV_DEMO=1 WEB_ENABLED=true WEB_PORT=3199 WEB_PASSWORD=... bun run web:dev
 *
 * Telegram-Topics (Issue #29) laufen in beiden Fällen gegen eine Attrappe
 * (createDemoTopics): Anlegen, Umbenennen, Schließen, Öffnen und Löschen
 * wirken nur in der WebUI, nichts geht nach Telegram. Im normalen Modus
 * beginnt die Attrappe nur mit General, ihr Zustand liegt nur im
 * Arbeitsspeicher. Neue Topics bekommen wie im Bot den Titel aus der ersten
 * Nachricht (Issue #30).
 * Einstellungen, Agenten-Anweisungen und Modell-Listen (Issue #38) laufen
 * ebenfalls gegen Attrappen im Speicher, ohne Netzabruf.
 * Der Agenten-Katalog (Issue #50) ebenso: Anlegen, Löschen, Prompts und
 * Board-Schalter nur im Speicher (createDemoAgents), gemeinsam mit Topics und
 * Einstellungen; nie config/agents.json, config/topics.json oder config/settings.json.
 *
 * Schlüssel (Issue #62) ebenfalls nur im Speicher (createDemoKeys), nie .env.
 *
 * Beenden mit Ctrl+C oder: pkill -f scripts/web-dev.ts
 * Importiert src/bot.ts nicht, auch nicht über Umwege.
 */

import { join } from "node:path";
import { loadWebConfig } from "../src/web/config";
import {
  createDemoAgents,
  createDemoInstructions,
  createDemoCommands,
  createDemoKeys,
  demoSessionReset,
  createDemoModels,
  createDemoStatus,
  startDemoServer,
  withDemoAutoTitle,
} from "../src/web/demo";
import { createFakeChat } from "../src/web/fake-chat";
import { createWebServer } from "../src/web/server";
import { UploadStore } from "../src/web/uploads";
import type { TelegramLiveEvent } from "../src/web/telegram";

const result = loadWebConfig(process.env);
if (result.status === "disabled") {
  console.error("[web] WebUI ist aus. Zum Starten WEB_ENABLED=true und WEB_PASSWORD setzen.");
  process.exit(1);
}
if (result.status === "invalid") {
  console.error(`[web] WebUI startet nicht: ${result.reason}`);
  process.exit(1);
}

let stop: () => Promise<void>;
if (process.env.WEB_DEV_DEMO === "1") {
  let demo;
  try {
    demo = await startDemoServer(result.config, { chat: createFakeChat(), telegramChat: createFakeChat() });
  } catch (e) {
    console.error(`[web] Demo startet nicht: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  console.log(`[web] Demo läuft auf ${demo.server.url} (ohne Anmeldung, Beispieldaten)`);
  stop = () => demo.stop();
} else {
  // Sessions und Gespräche immer im eigenen Checkout ablegen, nie über
  // GO_PROJECT_ROOT im Verzeichnis des laufenden Bots
  const dataRoot = join(import.meta.dir, "..", "data");
  // Topics, Agenten-Katalog und Einstellungen als eine Attrappe im Speicher (Issue #50)
  const demoAgents = createDemoAgents({ seed: false });
  const demoTopics = demoAgents.topics;
  const { telegram, topics } = demoTopics;
  // Aktivität neuer Topics (automatischer Titel, Issue #30) an offene Seitenleisten
  const listeners = new Set<(event: TelegramLiveEvent) => void>();
  const server = await createWebServer(result.config, {
    sessionFile: join(dataRoot, "web-sessions.json"),
    // Terminal-Zugang (Issue #59): eigene Datei, nie data/cli-token des Bots
    cliTokenFile: join(dataRoot, "web-dev", "cli-token"),
    dataDir: join(dataRoot, "web"),
    chat: createFakeChat(),
    telegram,
    telegramLive: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    telegramChat: withDemoAutoTitle(createFakeChat(), demoTopics, event => {
      for (const listener of [...listeners]) listener(event);
    }),
    topics,
    // Status-Attrappe: "Jetzt neu starten" schreibt nie den echten Marker (Issue #37)
    status: createDemoStatus(),
    // Einstellungen und Anweisungen nur im Speicher, Modell-Listen ohne Netz (Issue #38):
    // nie config/settings.json oder config/agent-overrides.json des Checkouts
    settings: demoAgents.settings,
    agentCatalog: demoAgents.catalog,
    instructions: createDemoInstructions(),
    models: createDemoModels(),
    // /new aus tybo (Issue #61): keine echten Sessions in web:dev
    resetConversation: demoSessionReset,
    // Befehlsliste (Issue #77): echtes Register, ausgeführt wird nichts
    commands: createDemoCommands(),
    // Schlüssel (Issue #62): nur im Speicher, nie die .env des Checkouts
    keys: createDemoKeys(),
    // Anhänge (Issue #72): eigene Ablage im Checkout, nie data/uploads des Bots
    uploads: new UploadStore({ dir: join(dataRoot, "web-dev", "uploads") }),
  });
  console.log(`[web] WebUI läuft auf ${server.url}`);
  stop = () => server.stop();
}

async function shutdown() {
  await stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
