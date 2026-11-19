/**
 * Start des Bots (Issue #344): Startbanner und die Hintergrunddienste, die
 * nach WebUI, Goal-Engine und MCP anlaufen. Die Prüfung auf Claude Code
 * (Issue #566, checkClaudeBeforeWork) läuft vorher, src/bot.ts wartet auf sie.
 * Reihenfolge in startBackground:
 * Schemaprobe (Issue #560), Embedding-Prüfung und Nachziehen (vorgemerkte Einträge, danach Abschnitte
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
import { probeSchema, schemaGapNotice, type SchemaProbeResult } from "../lib/schema-probe";
import { botTopicState } from "../web/bot-telegram";
import { checkClaudeAtStart, claudeAvailability, type ClaudeAvailability } from "../lib/claude-availability";
import { checkEngine, inspectEngine } from "../lib/engines/check";
import { codexSkillLinksInput, setCodexSkillSync, setCodexUsageReader } from "../lib/engines/codex";
import { syncCodexSkillLinks } from "../lib/engines/codex-skills";
import { readCodexUsage } from "../lib/engines/codex-usage";
import { recordUsage } from "../lib/engines/usage";
import { getSettings } from "../lib/settings";
import { setSwitchNotifier, startSwitchWatch } from "../lib/engine-switch-notify";
import { engineMeasurements } from "../lib/engine-check-now";
import { measureClaudeUsage, requestClaudeUsageAfterChat, setClaudeUsageAfterChat, startClaudeUsageWatch } from "../lib/engines/claude-usage";

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

/** Wirksamer Claude-Standard für die Routing-Zeile, mit Effort aus den Einstellungen. */
export function defaultModelLabel(fallback: string): string {
  const defaults = getSettings().defaults;
  const model = defaults?.model ?? fallback;
  return defaults?.effort ? `${model} (Effort ${defaults.effort})` : model;
}

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
  /** Rückgaben aus data/jobs dieses Projektordners; local und server nutzen denselben Abholer. */
  pollJobReports?(): Promise<void>;
  /** Telegram-Nachricht einer Rückfrage nachziehen (ohne Telegram nichts) */
  refresh(choice: Choice, refs?: Parameters<NonNullable<Parameters<typeof startThreadReminders>[0]["refresh"]>>[1]): Promise<unknown>;
  services?: Partial<BackgroundServices>;
}

/** Keine Anmeldung beim Import: nur der laufende Bot aktiviert diese Quelle. */
export function installClaudeUsageMeasurement(measure = measureClaudeUsage, afterChat = requestClaudeUsageAfterChat): () => void {
  const source = { timeoutMs: 30_000, measure: (signal: AbortSignal) => measure({ signal, evaluate: false }) };
  engineMeasurements.claude.push(source);
  setClaudeUsageAfterChat(afterChat);
  return () => {
    const index = engineMeasurements.claude.indexOf(source);
    if (index >= 0) engineMeasurements.claude.splice(index, 1);
    setClaudeUsageAfterChat(null);
  };
}

/** Bausteine der Hintergrunddienste; Tests ersetzen sie, damit keine echten Zeitgeber laufen */
export const BACKGROUND_SERVICES = {
  /** Schemaprobe gegen Supabase (Issue #560); null ohne SUPABASE_URL und Server-Schlüssel */
  probeSchema: async (env: Env): Promise<SchemaProbeResult | null> => {
    const url = env.SUPABASE_URL?.trim();
    const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    return url && key ? probeSchema({ url, key }) : null;
  },
  /** Ist Claude Code installiert und angemeldet (Issue #566)? Echte Prüfung mit claude --version und auth status */
  inspectClaude: () => inspectEngine("claude"),
  checkCodex: () => checkEngine("codex"),
  installCodexSkillSync: setCodexSkillSync,
  installCodexUsageReader: setCodexUsageReader,
  syncCodexSkills: syncCodexSkillLinks,
  getSettings,
  checkEmbedding: checkEmbeddingAtStartup,
  drainEmbeddings: drainEmbeddingQueue,
  syncChunks: () => syncMessageChunks(),
  rotateLogs: rotateServiceLogs,
  recoverJobs: (root: string, env: Env) => recoverJobsUntilSettled(createJobDeps({ root, env })),
  watchDeps: defaultWatchDeps,
  startRoutineWatch,
  startThreadReminders,
  startReminderPlanner,
  setSwitchNotifier,
  startSwitchWatch,
  installClaudeUsageMeasurement,
  startClaudeUsageWatch,
  webConversationExists: isConversationListed,
  topicDeleted: async (chatId: string, topicId: number) => (await botTopicState.get(chatId, topicId)).deleted === true,
  /** Wiederholung ohne den Prozess am Leben zu halten */
  every: (ms: number, run: () => void) => void setInterval(run, ms).unref(),
  log: (line: string) => console.log(line),
  warn: (line: string) => console.warn(line),
  error: (line: string, error?: unknown) => (error === undefined ? console.error(line) : console.error(line, error)),
};
export type BackgroundServices = typeof BACKGROUND_SERVICES;

/**
 * Server ohne Claude-Konto (Issue #566): einmal prüfen, ob Claude Code
 * installiert und angemeldet ist. src/bot.ts wartet darauf, bevor Anrufe,
 * Übungsgespräche, WebUI, Ziele und Polling anlaufen: Schon die erste Arbeit
 * kennt so den Zustand (keine Nebenaufgabe über Claude, keine Job-Regel im
 * Prompt, wenn Claude fehlt). Fehlt Claude, steht genau eine Logzeile da.
 * Wirft nie; die Prüfung selbst endet nach höchstens zwei Zeitlimits von
 * inspectEngine.
 */
export async function checkClaudeBeforeWork(env: Env, services: Partial<Pick<BackgroundServices, "inspectClaude" | "getSettings" | "warn">> = {}): Promise<ClaudeAvailability> {
  const svc = { ...BACKGROUND_SERVICES, ...services };
  return checkClaudeAtStart({ inspect: svc.inspectClaude, getSettings: svc.getSettings, env: () => env, log: svc.warn }).catch(() => claudeAvailability());
}

export interface Background {
  routineWatch: RoutineWatch;
  threadReminders: ThreadReminderTimer;
  reminderPlanner: ReminderPlannerTimer;
  stopSwitchNotices(): void;
  /** Erste Ablauf-Prüfung der Rückfragen */
  firstSweep: Promise<void>;
}

const errorName = (e: unknown) => (e instanceof Error ? e.name : "Fehler");

export function startBackground(deps: BackgroundDeps): Background {
  const { env } = deps;
  const svc = { ...BACKGROUND_SERVICES, ...deps.services };

  // Anmeldung ist für Links nicht nötig. Die Prüfung hält den Bot-Start nicht auf.
  svc.installCodexSkillSync(svc.syncCodexSkills);
  svc.installCodexUsageReader(readCodexUsage, recordUsage);
  void Promise.resolve().then(() => svc.checkCodex()).then(status => {
    if (status.installed) svc.syncCodexSkills(codexSkillLinksInput(svc.getSettings().engine?.codex?.skills !== false));
  }).catch(() => svc.error("[Codex] Skill-Abgleich beim Start fehlgeschlagen; Start läuft weiter."));

  // Fehlende Migrationen nach einem Update (Issue #560): genau eine Meldung je Start über den
  // Meldeweg (Telegram und WebUI), dazu immer ins Log. Ohne Telegram hält die Outbox die Meldung
  // in messages fest; scheitert das (etwa weil gerade diese Tabelle fehlt), bleibt nur das Log
  void svc
    .probeSchema(env)
    .then(async result => {
      if (!result) return;
      if (result.state === "ok") return svc.log("[schema] alle Migrationen eingespielt");
      if (result.state === "unknown") return svc.warn(`[schema] nicht prüfbar: ${result.reason}`);
      const text = schemaGapNotice(result);
      if (!text) return;
      svc.warn(`[schema] ACHTUNG: ${text}`);
      if (!(await deps.notices.notifyUser(text))) svc.warn("[schema] Meldung an den Nutzer nicht zugestellt, der Hinweis steht nur hier im Log");
    })
    .catch(e => svc.error(`[schema] Schemaprobe gescheitert (${errorName(e)})`));

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

  // Auch während des Betriebs: Fragefrist, verlorene Auswahlen und unterbrochene Handler nachholen.
  const recover = () => {
    void deps.pollJobReports?.().catch(e => svc.error(`[job] Rückgaben nicht abgeholt (${errorName(e)})`));
    // Versandversuche eines Jobs dürfen die Fristprüfung anderer Jobs nicht blockieren.
    // Statussperre und Versandbesitzer verhindern doppelte Arbeit je Job.
    void svc.recoverJobs(deps.root, env)
      .then(r => {
        if (r.aborted.length || r.resent.length) svc.log(`[job] ${r.aborted.length} verwaiste Jobs gemeldet, ${r.resent.length} Meldungen nachgeholt`);
      })
      .catch(e => svc.error(`[job] Wiederherstellung gescheitert (${errorName(e)})`));
  };
  recover();
  svc.every(60_000, recover);

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

  // startBackground läuft erst nach acquireLockOrExit, auch ohne WebUI.
  svc.setSwitchNotifier(deps.notices.deliverToUser);
  const stopSwitchWatch = svc.startSwitchWatch();
  const removeClaudeMeasurement = svc.installClaudeUsageMeasurement();
  const stopClaudeUsageWatch = svc.startClaudeUsageWatch();
  const stopSwitchNotices = () => {
    stopClaudeUsageWatch(); removeClaudeMeasurement(); stopSwitchWatch(); svc.setSwitchNotifier(null);
  };

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

  return { routineWatch, threadReminders, reminderPlanner, stopSwitchNotices, firstSweep };
}
