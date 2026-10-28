/**
 * WhatsApp-Gateway über Twilio (Issue #345): eigener Prozess neben dem Bot,
 * Start mit `bun run whatsapp`.
 *
 * Diese Datei verdrahtet nur: Umgebung lesen, Twilio-Versand, Besitzer-Turn
 * über den Chat-Kern samt Zustellwegen für Merk-Vorschläge, Gäste-Assistent,
 * Webhook-Server und Beenden über den gemeinsamen Lebenszyklus. Die Logik liegt in src/channels/whatsapp/.
 * Variablen: .env.example, Abschnitt WhatsApp.
 */
import { join } from "path";
import { BRAND } from "./brand";
import { installSignalHandlers } from "./app/lifecycle";
import { installWhatsAppChoices } from "./channels/whatsapp/choices";
import { readWhatsAppConfig } from "./channels/whatsapp/config";
import { createWhatsAppInbound } from "./channels/whatsapp/inbound";
import { createOwnerTurn } from "./channels/whatsapp/owner-turn";
import { createGatewayLifecycle } from "./channels/whatsapp/shutdown";
import { createTwilioSender } from "./channels/whatsapp/twilio";
import { createWhatsAppWebhook, WEBHOOK_PATH, HEALTH_PATH } from "./channels/whatsapp/webhook";
import { getAgentConfigOrGeneral } from "./agents";
import { runJsonTurn } from "./lib/chat-turn";
import { abortAllEngineCalls } from "./lib/engines/calls";
import { loadEnv } from "./lib/env";
import { runExecution } from "./lib/execution-context";
import { answerGuest, isWhatsAppOwner, saveGuestMessage } from "./lib/guest-assistant";
import { processTurnIntents } from "./lib/intent-gate";
import { storeOr } from "./lib/store";
import type { LogLevel } from "./lib/store/types";
import {
  findGroupForNumber,
  handleGroupCommand,
  isDmMessage,
  isNumberInAnyGroup,
  loadGroups,
  shouldBotRespond,
} from "./lib/whatsapp-groups";

await loadEnv(join(process.cwd(), ".env"));
const config = readWhatsAppConfig(process.env);

/** Eintrag im Datenbank-Log; ohne Datenbank still */
const dbLog = (level: LogLevel, message: string, metadata?: Record<string, unknown>) =>
  storeOr(undefined, store => store.logs.write(level, "whatsapp", message, metadata));

// Merk-Vorschläge und Auswahl bei mehrdeutigen Merk-Tags aus dem Besitzer-Turn:
// Rückfrage im Register, gezeigt im Direktchat (Telegram, sonst WebUI), den Klick beantwortet der Bot
installWhatsAppChoices(process.env);

const sender = createTwilioSender({ accountSid: config.accountSid, authToken: config.authToken, from: config.from });

const ownerTurn = createOwnerTurn({
  runJsonTurn,
  runExecution,
  saveMessage: message => storeOr(false, store => store.messages.save(message)),
  processIntents: processTurnIntents,
  notice: (number, text) => sender.send(number, text),
  allowedTools: agent => getAgentConfigOrGeneral(agent)?.allowedTools,
});

let server: ReturnType<typeof Bun.serve> | null = null;
const lifecycle = createGatewayLifecycle({
  exit: code => process.exit(code),
  afterRelease: reason => dbLog("info", `Shutdown: ${reason}`),
  parts: { abortRunning: abortAllEngineCalls, server: () => server },
});
installSignalHandlers(lifecycle, {
  on: (event, handler) => void process.on(event, handler),
  report: error => dbLog("error", `Uncaught exception: ${error.message}`, { stack: error.stack }),
});

const inbound = createWhatsAppInbound({
  sender,
  isOwner: isWhatsAppOwner,
  ownerTurn,
  guest: { answer: answerGuest, save: saveGuestMessage },
  groups: {
    find: findGroupForNumber,
    botQuestion: shouldBotRespond,
    directPart: isDmMessage,
    command: handleGroupCommand,
  },
  queue: (key, fn) => runExecution(key, "guest", fn),
  botName: BRAND.name,
  isShuttingDown: () => lifecycle.isShuttingDown(),
});

server = Bun.serve({
  hostname: config.host,
  port: config.port,
  maxRequestBodySize: 64 * 1024,
  fetch: createWhatsAppWebhook({
    authToken: config.authToken,
    publicUrl: config.publicUrl,
    isAllowed: number => config.allowed.has(number) || isNumberInAnyGroup(number),
    handle: inbound,
    health: () => ({ uptime: process.uptime(), pid: process.pid, twilioFrom: config.from, timestamp: new Date().toISOString() }),
  }),
});

const groupCount = Object.keys(loadGroups().groups).length;
console.log(`[WhatsApp] Gateway läuft auf ${config.host}:${config.port} (PID ${process.pid})`);
console.log(`[WhatsApp] Webhook ${WEBHOOK_PATH}, Zustand ${HEALTH_PATH}, Absender ${config.from}`);
console.log(`[WhatsApp] ${config.allowed.size} freigegebene Nummer(n), ${groupCount} Gruppe(n)`);
await dbLog("info", "WhatsApp gateway started", { pid: process.pid, port: config.port, from: config.from });
