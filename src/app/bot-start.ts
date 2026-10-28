/**
 * Start des Bots (Issue #344): Startbanner und die Hintergrunddienste, die
 * nach WebUI, Goal-Engine und MCP anlaufen. Reihenfolge in startBackground:
 * Embedding-Prüfung und Nachziehen (vorgemerkte Einträge, danach Abschnitte
 * langer Nachrichten), Log-Rotation, verwaiste Jobs,
 * Routinen-Wache, Fäden-Erinnerungen, Erinnerungs-Planer und zuletzt die
 * erste Ablauf-Prüfung der Rückfragen. Auf diese wartet der Start des
 * Pollings und die Fortsetzung aktiver Ziele (startAfterFirstSweep).
 */
import { BRAND } from "../brand";
import { checkEmbeddingAtStartup, drainEmbeddingQueue, DRAIN_INTERVAL_MS } from "../lib/embedding";
import { recoverJobsUntilSettled } from "../lib/jobs/control";
import { createJobDeps } from "../lib/jobs/default-deps";
import { rotateServiceLogs } from "../lib/log-retention";
import { syncMessageChunks } from "../lib/message-chunks";
import { menuAlertSender, routineChannel, routineConversation, type createRoutineChoices } from "../lib/routine-choices";
import { defaultWatchDeps, startRoutineWatch, type RoutineWatch } from "../lib/routines/watch";
import { createReminderSender } from "../lib/reminder-choices";
import { startReminderPlanner, type ReminderPlannerTimer } from "../lib/schedule/planner";
import { getScheduleStore } from "../lib/schedule/store";
import { dmChatId, telegramConfigured } from "../lib/channels";
import { sendAndRecord } from "../lib/outbox";
import type { BotNotices } from "../lib/bot-notices";
import type { PostWeb } from "../lib/review-choices";
import type { TelegramChoices } from "../lib/telegram-choices";
import type { Choice } from "../lib/choices";
import { conversationGoneCheck, startThreadReminders, type ThreadReminderTimer } from "../lib/threads/remind";
import { isConversationListed } from "../web/store";
import { botTopicState } from "../web/bot-telegram";

type Env = Record<string, string | undefined>;

export interface BannerInfo {
  pid: number;
  root: string;
  timezone: string;
  healthPort: number;
  telegram: boolean;
  web: boolean;
  claudePath: string;
  voice: boolean;
  phone: boolean;
  /** Anbieter der Transkription, undefined wenn aus */
  transcription?: string;
  /** Status der MCP-Werkzeuge, undefined wenn aus */
  mcp?: string;
  sessionId?: string | null;
  defaultModel: string;
}

const RULE = "=".repeat(50);
const LABEL_WIDTH = 13;

/** Zeilen des Startbanners; jede Zeile „Bezeichnung: Wert" */
export function startBanner(info: BannerInfo): string[] {
  const onOff = (on: boolean) => (on ? "enabled" : "disabled");
  const rows: [string, string][] = [
    ["PID", String(info.pid)],
    ["Project", info.root],
    ["Timezone", info.timezone],
    ["Health", `http://localhost:${info.healthPort}/health`],
    ["Telegram", info.telegram ? "an" : "nicht eingerichtet (nur WebUI)"],
    ["WebUI", info.web ? "an (Adressen in der [web]-Zeile oben)" : "aus"],
    ["Claude", info.claudePath],
    ["Voice", onOff(info.voice)],
    ["Phone", onOff(info.phone)],
    ["Transcribe", info.transcription ? `enabled (${info.transcription})` : "disabled"],
    ["MCP tools", info.mcp ?? "disabled"],
    ["Session", info.sessionId || "new"],
    ["HITL", "Rückfragen über das Rückfragen-Register (Telegram und WebUI)"],
    ["Routing", `festes Standardmodell ${info.defaultModel}, Einstellungen je Agent haben Vorrang`],
  ];
  return [RULE, `${BRAND.name} - Starting`, RULE, ...rows.map(([label, value]) => `${label}:`.padEnd(LABEL_WIDTH) + value), RULE];
}

export interface BackgroundDeps {
  root: string;
  env: Env;
  notices: BotNotices;
  choices: TelegramChoices;
  routineChoices: ReturnType<typeof createRoutineChoices>;
  postWeb: PostWeb;
  /** Telegram-Nachricht einer Rückfrage nachziehen (ohne Telegram nichts) */
  refresh(choice: Choice, refs?: Parameters<NonNullable<Parameters<typeof startThreadReminders>[0]["refresh"]>>[1]): Promise<unknown>;
  services?: Partial<BackgroundServices>;
}

/** Bausteine der Hintergrunddienste; Tests ersetzen sie, damit keine echten Zeitgeber laufen */
export const BACKGROUND_SERVICES = {
  checkEmbedding: checkEmbeddingAtStartup,
  drainEmbeddings: drainEmbeddingQueue,
  syncChunks: () => syncMessageChunks(),
  rotateLogs: rotateServiceLogs,
  recoverJobs: (root: string, env: Env) => recoverJobsUntilSettled(createJobDeps({ root, env })),
  watchDeps: defaultWatchDeps,
  startRoutineWatch,
  startThreadReminders,
  startReminderPlanner,
  webConversationExists: isConversationListed,
  topicDeleted: async (chatId: string, topicId: number) => (await botTopicState.get(chatId, topicId)).deleted === true,
  /** Wiederholung ohne den Prozess am Leben zu halten */
  every: (ms: number, run: () => void) => void setInterval(run, ms).unref(),
  log: (line: string) => console.log(line),
  warn: (line: string) => console.warn(line),
  error: (line: string, error?: unknown) => (error === undefined ? console.error(line) : console.error(line, error)),
};
export type BackgroundServices = typeof BACKGROUND_SERVICES;

export interface Background {
  routineWatch: RoutineWatch;
  threadReminders: ThreadReminderTimer;
  reminderPlanner: ReminderPlannerTimer;
  /** Erste Ablauf-Prüfung der Rückfragen */
  firstSweep: Promise<void>;
}

const errorName = (e: unknown) => (e instanceof Error ? e.name : "Fehler");

export function startBackground(deps: BackgroundDeps): Background {
  const { env } = deps;
  const svc = { ...BACKGROUND_SERVICES, ...deps.services };

  // Embedding-Anbieter gegen die Kennung der Datenbank (Issue #167): Abweichung laut melden
  void svc.checkEmbedding().then(check => {
    if (check?.ok) svc.log(`[embedding] ${check.message}`);
    else if (check) svc.warn(`[embedding] ACHTUNG: ${check.message}`);
  });
  // Vorgemerkte Einträge nach einem Anbieterwechsel nachziehen (Issue #168), danach
  // Abschnitte langer Nachrichten, die beim Speichern nicht entstanden
  // (src/lib/message-chunks.ts); sofort und regelmäßig
  const drain = () =>
    void svc
      .drainEmbeddings()
      .then(r => {
        if (r?.state === "fertig" && (r.written || r.rejected)) svc.log(`[embedding] ${r.written} vorgemerkte Einträge nachgezogen, ${r.rejected} abgelehnt`);
      })
      .catch(() => {})
      .then(() => svc.syncChunks())
      .then(r => {
        if (r && r.state !== "fehlt" && (r.messages || r.failed)) svc.log(`[embedding] Abschnitte für ${r.messages} lange Nachrichten nachgezogen (${r.chunks} Abschnitte), ${r.failed} gescheitert`);
      })
      .catch(() => {});
  drain();
  svc.every(DRAIN_INTERVAL_MS, drain);
  void svc.rotateLogs().catch(error => svc.error("Log rotation failed", error));
  svc.every(3_600_000, () => void svc.rotateLogs().catch(() => {}));

  // Hintergrund-Jobs (Issue #103): verwaiste Jobs melden, halb gesendete Meldungen nachholen
  void svc
    .recoverJobs(deps.root, env)
    .then(r => {
      if (r.aborted.length || r.resent.length) svc.log(`[job] Beim Start: ${r.aborted.length} verwaiste Jobs gemeldet, ${r.resent.length} Meldungen nachgeholt`);
    })
    .catch(e => svc.error(`[job] Aufräumen beim Start gescheitert (${errorName(e)})`));

  // Routinen (Issue #287/#288): ausgebliebene Läufe alle 10 Minuten, mit Menü im Direktchat
  const watchDeps = svc.watchDeps(deps.root, env);
  const dm = routineConversation(dmChatId(env));
  const offer = (id: string, text: string) => (dm ? deps.routineChoices.offerMenu(dm, id, text) : Promise.resolve({ status: "none" as const }));
  const routineWatch = svc.startRoutineWatch({ ...watchDeps, send: menuAlertSender(watchDeps.send, offer, undefined, () => routineChannel(dm)) });

  const telegram = () => telegramConfigured(env);
  const refresh = async (choice: Choice, refs?: Parameters<BackgroundDeps["refresh"]>[1]) => void (await deps.refresh(choice, refs));

  // Offene Fäden (Issue #292): fällige alle 15 Minuten, außerhalb der Ruhezeit
  const threadReminders = svc.startThreadReminders({
    now: () => Date.now(),
    env: () => env,
    telegram,
    send: input => sendAndRecord(input),
    refresh,
    // Weg nur bei gelöschtem Web-Gespräch oder Topic mit Merker deleted; unlesbare Liste heißt unbekannt
    conversationGone: conversationGoneCheck({ webConversationExists: svc.webConversationExists, topicDeleted: svc.topicDeleted }),
  });

  // Erinnerungen (Issue #322): fällige alle 30 Sekunden genau einmal zustellen
  const reminderPlanner = svc.startReminderPlanner({
    store: () => getScheduleStore(),
    now: () => Date.now(),
    send: createReminderSender({ deliver: deps.notices.deliverToUser, postWeb: deps.postWeb, telegram, refresh }),
  });

  // Rückfragen mit abgelaufener Frist, auch aus der Zeit, als der Bot aus war
  const sweep = () =>
    deps.choices
      .sweep()
      .then(expired => {
        if (expired.length) svc.log(`[choices] ${expired.length} Rückfragen abgelaufen`);
      })
      .catch(e => svc.error(`[choices] Ablauf-Prüfung gescheitert (${errorName(e)})`));
  const firstSweep = sweep();
  svc.every(60_000, () => void sweep());

  return { routineWatch, threadReminders, reminderPlanner, firstSweep };
}
