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
 * Sprechmodus (Issue #249): POST /api/conversations/<id>/speech „erkennt" aus
 * jeder Aufnahme denselben Text (createDemoSpeech), POST /api/speech/tts
 * antwortet mit 409, weil die Browser-Stimme spricht. Kein Anbieter, kein Netz.
 *
 * Echtes Hören und Sprechen (Issue #250) mit WEB_DEV_SPEECH=real: speech und
 * voice kommen aus der echten Sprach-Schnittstelle (dieselbe Kette wie
 * getSpeech(): recognize, synthesizeSpeech, localMode; scripts/web-dev-speech.ts).
 * Der Chat bleibt die Attrappe, src/bot.ts wird nicht geladen, nichts pollt
 * Telegram. Den Anbieter wählt die Befehlszeile:
 *
 *   WEB_DEV_SPEECH=real SPEECH_STT=whisper-cpp WEB_ENABLED=true WEB_PORT=3199 WEB_PASSWORD=... bun run web:dev
 *
 * whisper.cpp braucht whisper-cli im PATH (oder WHISPER_CLI_PATH) und das
 * Modell unter models/ggml-medium.bin (oder WHISPER_MODEL_PATH). Die
 * Einstellungen im Reiter „Sprechen" (nur im Speicher) gehen der Befehlszeile
 * vor, wie config/settings.json im Bot; config/settings.json selbst liest
 * web:dev nie. Der Sprechen-Knopf braucht einen sicheren Kontext: im Browser
 * http://127.0.0.1:<Port> oder http://localhost:<Port>. Gilt nur ohne
 * WEB_DEV_DEMO; ohne den Schalter lädt web:dev nichts außerhalb von src/web.
 *
 * Web Push (Issue #225) nur mit WEB_DEV_PUSH=1: frische VAPID-Schlüssel bei
 * jedem Start, nur im Speicher (nie .env, nie data/). Abos in der Demo im
 * temporären Verzeichnis, sonst in data/web-dev/push-subscriptions.json. Nach
 * einem Neustart passen alte Abos nicht mehr zum Schlüssel: Benachrichtigungen
 * dann aus- und wieder einschalten. Versand geht echt an den Push-Dienst des
 * Browsers, nur so kommt „Test senden" an. Push braucht einen sicheren
 * Kontext: im Browser http://127.0.0.1:<Port> oder http://localhost:<Port>.
 *
 * Sprachagenten (Issue #495): Bereich /sprachagenten mit Beispielagenten im
 * Speicher (src/web/demo-voice-agents.ts), die Gesprächsseite bekommt eine
 * SDK-Attrappe (src/web/demo-voice-sdk.ts) statt des eingecheckten SDK,
 * nichts geht an den Anbieter. Der Wizard „Neu“ (Issue #515) läuft gegen
 * src/web/demo-voice-agent-wizard.ts: Vorschlag, Bauen und Hörprobe ohne
 * Anbieter und ohne Job, gesteuert über Wörter im Satz (siehe dort). Dauer
 * je Phase nach dem Bauen: WEB_DEV_WIZARD_STEP_MS (Standard 2000).
 *
 * Beenden mit Ctrl+C oder: pkill -f scripts/web-dev.ts
 * Importiert src/bot.ts nicht, auch nicht über Umwege (tests/web-public.test.ts).
 */

import { join } from "node:path";
import { loadWebConfig } from "../src/web/config";
import { DEFAULT_PUSH_SUBJECT, generateVapidKeys } from "../src/web/push";
import type { PushDeps } from "../src/web/push-api";
import {
  createDemoAgents,
  createDemoInstructions,
  createDemoCommands,
  createDemoEngines,
  DEMO_ENGINE_HINT,
  createDemoVoice,
  createDemoSpeech,
  createDemoKeys,
  demoSessionReset,
  createDemoModels,
  createDemoStatus,
  createDemoRoutines,
  createDemoJobs,
  createDemoPipelines,
  createDemoChoices,
  createDemoThreads,
  createDemoReminders,
  startDemoServer,
  withDemoAutoTitle,
} from "../src/web/demo";
import { createDemoVoiceAgents } from "../src/web/demo-voice-agents";
import { createDemoVoiceAgentWizard } from "../src/web/demo-voice-agent-wizard";
import { DEMO_VOICE_AGENT_SDK } from "../src/web/demo-voice-sdk";
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

/** Push nur auf Wunsch, Schlüssel nur im Speicher; file fehlt: Demo legt die Abos im eigenen temporären Verzeichnis ab */
async function devPush(file?: string): Promise<PushDeps | undefined> {
  if (process.env.WEB_DEV_PUSH !== "1") return undefined;
  console.log("[web] Push an: Schlüssel nur für diesen Lauf");
  return { keys: await generateVapidKeys(), subject: DEFAULT_PUSH_SUBJECT, ...(file ? { file } : {}) };
}

/** Echtes Hören und Sprechen nur mit WEB_DEV_SPEECH=real; jeder andere Wert bleibt bei der Attrappe */
const speechMode = process.env.WEB_DEV_SPEECH ?? "";
if (speechMode && (speechMode !== "real" || process.env.WEB_DEV_DEMO === "1")) {
  console.error(
    speechMode === "real"
      ? "[web] WEB_DEV_SPEECH=real gilt nicht in der Demo (WEB_DEV_DEMO=1): Sprechmodus mit Attrappe"
      : `[web] WEB_DEV_SPEECH kennt nur „real": Sprechmodus mit Attrappe`
  );
}

// Alter Stand als Fotovorlage; ausschließlich die Attrappe im Speicher.
const pipelines = createDemoPipelines(Date.now(), process.env.WEB_DEV_DEMO === "1" ? "topic-60" : "topic-1");
if (process.env.WEB_DEV_PIPELINES_STALE === "1") {
  const snapshot = (await pipelines.read())!;
  snapshot.generatedAt = new Date(Date.now() - 6 * 60_000).toISOString();
  pipelines.setSnapshot(snapshot);
}

let stop: () => Promise<void>;
if (process.env.WEB_DEV_DEMO === "1") {
  let demo;
  try {
    const engineExample = { notice: DEMO_ENGINE_HINT, replyInfo: { engine: "codex" as const, model: "gpt-6-astra" } };
    demo = await startDemoServer(result.config, { chat: createFakeChat(engineExample), telegramChat: createFakeChat(engineExample), pipelines, push: await devPush() });
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
  const demoChoices = createDemoChoices(Date.now(), 1);
  const demoAgents = createDemoAgents({ seed: false });
  const demoTopics = demoAgents.topics;
  const { telegram, topics } = demoTopics;
  // Sprechmodus mit echter Sprach-Schnittstelle (Issue #250): nur geladen, wenn der Schalter gesetzt ist
  const realSpeech = speechMode === "real" ? (await import("./web-dev-speech")).createWebDevSpeech(demoAgents.settings) : null;
  if (realSpeech) {
    const local = realSpeech.voice.localMode();
    const hear = local.stt ? local.stt.label : "kein Anbieter";
    console.log(`[web] Sprechmodus echt: Hören ${hear}, Sprechen ${local.tts.label}${local.ready ? "" : ` (nicht bereit: ${local.reason ?? "ohne Grund"})`}`);
  }
  // Aktivität neuer Topics (automatischer Titel, Issue #30) an offene Seitenleisten
  const listeners = new Set<(event: TelegramLiveEvent) => void>();
  // Sprachagenten (Issue #495): Verwaltung und Gesprächsroute als Attrappe, nie config/voice-agents des Checkouts
  const demoVoiceAgents = createDemoVoiceAgents({ origin: () => `http://${result.config.host}:${result.config.port}` });
  // Wizard (Issue #515): Attrappe im Speicher, fertige Agenten landen in der Liste oben
  const demoWizard = createDemoVoiceAgentWizard({
    register: demoVoiceAgents.register,
    taken: demoVoiceAgents.has,
    ...(process.env.WEB_DEV_WIZARD_STEP_MS ? { stepMs: Number(process.env.WEB_DEV_WIZARD_STEP_MS) } : {}),
  });
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
    // Routinen (Issue #284): feste Beispieldaten, nie launchctl oder pm2 des Rechners
    routines: createDemoRoutines(),
    jobs: createDemoJobs(demoChoices, { id: "topic-1", name: "General" }),
    pipelines,
    choices: demoChoices,
    // Offene Fäden (Issue #293): Beispieldaten im Speicher, nie data/threads.json des Checkouts
    threads: createDemoThreads({ settings: demoAgents.settings }),
    // Erinnerungen (Issue #323): Beispieldaten im Speicher, nie data/reminders.json oder Supabase
    reminders: createDemoReminders(),
    // Einstellungen und Anweisungen nur im Speicher, Modell-Listen ohne Netz (Issue #38):
    // nie config/settings.json oder config/agent-overrides.json des Checkouts
    settings: realSpeech ? realSpeech.settings : demoAgents.settings,
    // Motor (Issue #126): Standard und Ausnahmen aus denselben Demo-Einstellungen, feste Verfügbarkeit
    engines: createDemoEngines(demoAgents.settings),
    // Sprechmodus (Issue #248): feste Demo-Anbieter, keine echte Prüfung; mit WEB_DEV_SPEECH=real die echte Kette
    voice: realSpeech ? realSpeech.voice : createDemoVoice(demoAgents.settings),
    // Sprechmodus (Issue #249): jede Äußerung ergibt einen festen Text, vorgelesen wird im Browser;
    // mit WEB_DEV_SPEECH=real hören und sprechen die echten Anbieter (Issue #250)
    speech: realSpeech ? realSpeech.port : createDemoSpeech(),
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
    // Web Push (Issue #225): nur mit WEB_DEV_PUSH=1, eigene Abo-Datei, nie data/web des Bots
    push: await devPush(join(dataRoot, "web-dev", "push-subscriptions.json")),
    // Gesprächsseite /sa/<kennung> (Issue #495): SDK-Attrappe statt des echten SDK, kein Anbieter
    voiceAgentSdkScript: DEMO_VOICE_AGENT_SDK,
    voiceAgentSessions: demoVoiceAgents.sessions,
    voiceAgentAdmin: demoVoiceAgents.admin,
    voiceAgentWizard: demoWizard,
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
