/**
 * Chat-Kern: ein Agenten-Turn unabhaengig vom Kanal.
 *
 * Prompt bauen, Session fortsetzen, den Motor aufrufen (Motor des Gesprächs
 * laut resolveEngine oder TurnOptions.engine, Issues #121/#122/#125), bei Fehlern Fallback
 * (nach einem Zeitlimit stattdessen ein Stand-Bericht), Session speichern. Telegram (src/bot.ts) und spaeter der Web-Chat nutzen
 * denselben Weg; Fortschritt und Hinweise gehen ueber einen TurnSink, das
 * Formatieren (HTML, Markdown) macht der Kanal.
 */

import { firstTextSnippet, MAX_RUN_STEPS, type RunStep } from "./claude";
import { CLAUDE_NOT_INSTALLED_NOTICE } from "./claude/start-failure";
import { getEngine, forgetEngineCheck, DEFAULT_ENGINE, type EngineErrorKind, type EngineId, type EngineRequest, type EngineResult } from "./engines";
import {
  resolveEngine,
  engineModelAndEffort,
  engineLabel,
  stageLabel,
  sessionModel,
  shouldNotifyUnavailable,
  shouldNotifyNoFreeStage,
  markEngineRecovered,
  unavailableNotice,
  modelFitsEngine,
  shouldNotifyModelMisfit,
  modelMisfitNotice,
  triedStageIds,
} from "./engine-choice";
import { maskSecrets, projectSecretsOrThrow, type SecretValue } from "./jobs/mask";
import { currentExecution, isAbortError } from "./execution-context";
import { currentJobChain, withJobChain } from "./jobs/chain-context";
import { sanitizeModelOutput } from "./telegram";
import { fallbackReplyText, runFallbackChain, type FallbackResult } from "./fallback/chain";
import { buildPromptContext, buildResumePrompt, type PromptChannel, type PromptHandover } from "./prompt-builder";
import { storeOr } from "./store";
import { sessionKeyFor } from "./store/message-rules";
import type { LogLevel } from "./store/types";
import {
  isSessionModeEnabled,
  getResumableSession,
  takeExpiredSession,
  recordSessionTurn,
  resetSession,
  getSessionsForKey,
  sessionEpoch,
  retainHandover,
  takeHandover,
  SESSION_IDLE_MS,
  type BotSession,
  type SessionHandover,
  type HandoverReason,
} from "./session-manager";
import { shouldDistill, distillSession } from "./session-distill";
import { getAgentConfigOrGeneral } from "../agents";
import { takeCallRecap } from "./call-recap";
import { getSettings, engineAuto } from "./settings";
import { formatSwitchTime, modelFamily, pickStage, stageBlock, stageId, type Stage, type StageId } from "./engine-switch";
import { readSwitchState } from "./engine-switch-state";
import { checkSwitchNotices, conversationSwitchHint } from "./engine-switch-notify";
import { ERROR_KIND_TEXT, failedAttemptPrompt, noteStageRun, stageFailureOf } from "./engine-switch-run";
import { scheduleClaudeUsageAfterChat } from "./engines/claude-usage";
import { bookRunOutcome } from "./spend/credit";
import type { TurnTools } from "./turn-tools";
import { stallPhaseLogText, stallPhaseUserText, type StallPhase } from "./stream-phase";
import { engineTimeoutLogLine, TIMEOUT_NO_FALLBACK } from "./log-lines";
import { renderQuestionTags, scanForQuestion, type FoundQuestion } from "./turn-questions";
import type { AskOffer, AskOfferOutcome, TypedAnswer } from "./ask-choices";
import type { ChoiceConversation } from "./choices";

const PROJECT_ROOT = process.cwd();

export const ABORT_REPLY = "⏹️ Abgebrochen.";

// Shown instead of ABORT_REPLY when the kill came from shutdown() (SIGTERM,
// restart) rather than from the user's /stop — otherwise a lost answer looks
// like a deliberate abort (14.9.2026). Telegram and WebUI share this text.
export const SHUTDOWN_ABORT_REPLY =
  "⚠️ Der Bot wurde waehrend der Verarbeitung beendet (Neustart oder Stop), " +
  "die Antwort ging verloren. Bitte die Nachricht noch einmal schicken.";

// ---------------------------------------------------------------------------
// Long-running Claude calls: a heads-up before the hard limit and an honest
// note when the limit kills the run. 16.9.2026: a 30-minute research run was
// killed silently and the user only saw the thin OpenRouter fallback answer.
// Issue #178: streaming turns stop after a stretch without any stream-json
// line (idle) or at an upper bound, no longer at a fixed 30 minutes.
// ---------------------------------------------------------------------------
export {
  CLAUDE_IDLE_TIMEOUT_MS,
  CLAUDE_CALL_TIMEOUT_MS,
  JSON_CALL_TIMEOUT_MS,
  resolveStreamingLimits,
  type StreamingLimits,
} from "./turn-limits";
import { JSON_CALL_TIMEOUT_MS, resolveStreamingLimits, type StreamingLimits } from "./turn-limits";

/** Logzeile im Store (Issue #314); ohne Datenbank still */
const sbLog = (level: LogLevel, service: string, message: string, metadata?: Record<string, unknown>) =>
  storeOr(undefined, store => store.logs.write(level, service, message, metadata));

export const LONG_RUN_NOTICE_MS = 1_200_000; // heads-up to the user after 20 min

/**
 * Hinweis „Läuft seit …", nach 20 Minuten und dann alle 20 Minuten bis zur
 * Obergrenze. Mit idleMin (Streaming) nennt er beide Grenzen, ohne (JSON)
 * nur die Gesamtzeit wie bisher.
 */
export function longRunNoticeText(o: { elapsedMin: number; maxMin: number; idleMin?: number }): string {
  const limit =
    o.idleMin === undefined
      ? `Bei ${o.maxMin} Minuten bricht der Bot den Lauf ab`
      : `Nach ${o.idleMin} Minuten ohne Aktivität, spätestens bei ${o.maxMin} Minuten bricht der Bot den Lauf ab`;
  return (
    `⏳ Läuft seit ${o.elapsedMin} Minuten. ${limit} und meldet den Stand. ` +
    `/stop bricht sofort ab.`
  );
}

/** JSON-Pfad: Hinweis nach 20 Minuten, Grenze 30 Minuten wie bisher */
export const LONG_RUN_NOTICE_TEXT = longRunNoticeText({
  elapsedMin: LONG_RUN_NOTICE_MS / 60_000,
  maxMin: JSON_CALL_TIMEOUT_MS / 60_000,
});

// ---------------------------------------------------------------------------
// Stand-Bericht nach einem Zeitlimit (Issue #179). Früher startete der Bot
// danach die Fallback-Kette mit der ursprünglichen Nachricht: am 26.09.2026
// hat Opus 5 den Auftrag von vorn begonnen (Commits, Issues doppelt), und
// OpenRouter antwortete ohne Zugriff auf den Mac falsch „geht nicht".
// Jetzt kommt ein fester Bericht ohne Modell: was abgebrochen wurde, welche
// Schritte der Lauf zuletzt aufgerufen hat, und wie es weitergeht.
// ---------------------------------------------------------------------------
export const REPORT_STEP_CHARS = 80;
export const REPORT_TEXT_CHARS = 400;

export interface TimeoutReportInput {
  /** Anzeigename des Motors (Issue #125); fehlt: „Claude" wie bisher */
  engineName?: string;
  /** Art des Abbruchs (Streaming); fehlt: nur „Zeitlimit" */
  kind?: "idle" | "total";
  /** Eingestellte Leerlauf-Grenze (Streaming) */
  idleLimitMs?: number;
  /** Eingestellte Obergrenze bzw. Gesamtzeit (JSON) */
  maxLimitMs?: number;
  /** Tatsächliche Laufzeit bis zum Abbruch, falls bekannt */
  stoppedAfterMs?: number;
  /** Tatsächliche Zeit ohne Aktivität beim Abbruch, falls bekannt */
  idleForMs?: number;
  /** Wo der Lauf hing (nur Claude streaming), falls bekannt */
  stallPhase?: StallPhase;
  /** Beobachtete Schritte; undefined heißt unbekannt (JSON-Pfad) */
  steps?: RunStep[];
  lastText?: string;
  /** Liegt die abgebrochene Session zum Fortsetzen bereit? */
  canResume: boolean;
  /** Werte, die nie im Bericht stehen dürfen (projectSecretsOrThrow) */
  secrets: readonly SecretValue[];
}

/** Dauer in ganzen Minuten, „unter einer Minute" für weniger */
function minutesText(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "unter einer Minute";
  return min === 1 ? "1 Minute" : `${min} Minuten`;
}

/**
 * Steuer-Tags ([REMEMBER:], [GOAL:], [INVOKE:], ...) entschärfen: der Bericht
 * läuft danach wie eine Agentenantwort durch die Tag-Auswertung, zitierte
 * Tags dürfen dort nichts auslösen. Die eckige Klammer wird zur
 * vollbreiten, die kein Tag-Muster trifft.
 */
export function defuseTags(text: string): string {
  return text.replace(/\[(?=\s*[A-Za-z_]+\s*:)/g, "［");
}

/** Erst maskieren, dann Leerraum glätten, dann kürzen: kein Geheimnis wird angeschnitten */
function reportSnippet(text: string, max: number, secrets: readonly SecretValue[]): string {
  const flat = maskSecrets(text, secrets).replace(/\s+/g, " ").trim();
  const short = flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
  return defuseTags(short);
}

function timeoutHeadline(i: TimeoutReportInput): string {
  const who = i.engineName ?? "Claude";
  const ran = i.stoppedAfterMs !== undefined ? ` nach ${minutesText(i.stoppedAfterMs)} Laufzeit` : "";
  if (i.kind === "idle") {
    const idle = i.idleForMs ?? i.idleLimitMs;
    const why = idle !== undefined ? `seit ${minutesText(idle)} keine Aktivität` : "keine Aktivität mehr";
    return `⏱ Zeitlimit: ${why}, ${who} wurde${ran} abgebrochen.`;
  }
  if (i.kind === "total" && i.maxLimitMs !== undefined) {
    return `⏱ Zeitlimit: Obergrenze von ${minutesText(i.maxLimitMs)} erreicht, ${who} wurde${ran} abgebrochen.`;
  }
  // JSON-Pfad: nur die Gesamtzeit kann gegriffen haben
  if (!ran && i.maxLimitMs !== undefined && i.idleLimitMs === undefined) {
    return `⏱ Zeitlimit: ${who} wurde nach ${minutesText(i.maxLimitMs)} abgebrochen.`;
  }
  return `⏱ Zeitlimit: ${who} wurde${ran} abgebrochen.`;
}

/**
 * Stand-Antwort nach einem Zeitlimit, ohne Modell. Werkzeugaufrufe belegen
 * keinen Erfolg, der Bericht spricht deshalb von aufgerufenen Schritten.
 * Alles aus dem Lauf wird vor dem Kürzen maskiert und von Tags befreit.
 */
export function formatTimeoutReport(i: TimeoutReportInput): string {
  const parts = [timeoutHeadline(i) + " Ich starte den Auftrag nicht neu, damit nichts doppelt passiert."];
  if (i.stallPhase) parts.push(reportSnippet(stallPhaseUserText(i.stallPhase), REPORT_TEXT_CHARS, i.secrets));

  if (i.steps === undefined) {
    parts.push("Welche Schritte der Lauf schon gemacht hat, ist nicht bekannt.");
  } else if (i.steps.length === 0) {
    parts.push("Der Lauf hat kein Werkzeug aufgerufen.");
  } else {
    const lines = i.steps.slice(-MAX_RUN_STEPS).map((step, n) => {
      const name = reportSnippet(step.name, REPORT_STEP_CHARS, i.secrets);
      const input = step.input ? reportSnippet(step.input, REPORT_STEP_CHARS, i.secrets) : "";
      return `${n + 1}. ${name}${input ? `: ${input}` : ""}`;
    });
    parts.push(`Zuletzt aufgerufen (ob die Schritte fertig wurden, ist offen):\n${lines.join("\n")}`);
  }

  const lastText = i.lastText ? reportSnippet(i.lastText, REPORT_TEXT_CHARS, i.secrets) : "";
  if (lastText) parts.push(`Letzter Zwischentext von ${i.engineName ?? "Claude"}:\n„${lastText}“`);

  parts.push(
    i.canResume
      ? "Der Lauf hat eventuell schon Dateien geändert oder Dinge angelegt. Schreib **weiter**, dann setze ich die Session fort, oder /new für einen Neustart."
      : "Der Lauf hat eventuell schon Dateien geändert oder Dinge angelegt. Bitte prüf das, bevor du den Auftrag noch einmal schickst."
  );
  return parts.join("\n\n");
}

export const FALLBACK_FAILED_REPLY =
  "I'm having trouble processing right now. Please try again in a moment.";

export interface TurnProgress {
  kind: "tool" | "snippet";
  text: string;
  /**
   * Nur Telegram (Issue #52): der Snippet aus dem vor jeder Kürzung
   * bereinigten Text (Markdown-Bilder ohne Adresse). Leer: nichts anzeigen.
   * text bleibt unverändert für die WebUI.
   */
  telegramText?: string;
}

/**
 * Ausgabekanal eines Turns. Reiner Text, kein HTML.
 * start/finish sind optional: start kommt nach dem Prompt-Bau vor dem ersten
 * Claude-Aufruf, finish sobald kein Fortschritt mehr kommt (vor Zeitlimit-
 * Hinweis und Fallback, bzw. bei Abbruch). Ausstehende progress-Aufrufe sind
 * dann abgearbeitet.
 */
export interface TurnSink {
  progress(p: TurnProgress): void | Promise<void>;
  notice(text: string): void | Promise<void>;
  start?(): void | Promise<void>;
  finish?(): void | Promise<void>;
}

/**
 * Was ein Turn ueber sich meldet (Issue #22), fuer die Zeile unter der Antwort.
 * model ist das Modell, das die Antwort tatsaechlich geliefert hat: das des
 * Agenten oder beim Fallback das Fallback-Modell. Fehlt, wenn keins geantwortet
 * hat (alle Fallbacks gescheitert). durationMs misst den Turn selbst: ab
 * Prompt-Bau bis die Antwort feststeht, samt Resume-Retry und Fallback; ohne
 * Warteschlange davor (runExecution) und ohne Versand und Speichern danach.
 */
export interface TurnInfo {
  agent: string;
  model?: string;
  /**
   * Motor, der die Antwort geliefert hat (Issue #125). Fehlt bei
   * Fallback-Antworten (dann nennt model das Fallback-Modell) und wenn
   * niemand geantwortet hat. Bei Codex ohne eingestelltes Modell fehlt model.
   */
  engine?: EngineId;
  /** Stufenkennung und Auswahlgrund bei aktiver Wechselregel (M14-06). */
  stage?: StageId;
  reason?: string;
  /** Der Stand-Bericht nach einem Zeitlimit ist keine Antwort eines Ersatzmodells. */
  timedOut?: boolean;
  durationMs: number;
}

/** Austauschbare Abhaengigkeiten, vor allem fuer Tests. */
export interface ChatTurnDeps {
  /** Motor eines Turns (src/lib/engines) */
  getEngine: typeof getEngine;
  /** Motor des Gesprächs samt Verfügbarkeit (src/lib/engine-choice.ts, Issue #125) */
  resolveEngine: typeof resolveEngine;
  readSwitchState: typeof readSwitchState;
  noteStageRun: typeof noteStageRun;
  scheduleClaudeUsageAfterChat: typeof scheduleClaudeUsageAfterChat;
  /** Ein Lauf meldete „nicht angemeldet/installiert": nächste Prüfung frisch */
  forgetEngineCheck: () => void;
  /** Fallback-Kette (src/lib/fallback/chain.ts), Kontext ist Pflicht */
  runFallbackChain: typeof runFallbackChain;
  buildPromptContext: typeof buildPromptContext;
  buildResumePrompt: typeof buildResumePrompt;
  isSessionModeEnabled: typeof isSessionModeEnabled;
  getResumableSession: typeof getResumableSession;
  takeExpiredSession: typeof takeExpiredSession;
  retainHandover: typeof retainHandover;
  takeHandover: typeof takeHandover;
  recordSessionTurn: typeof recordSessionTurn;
  getSessionsForKey: typeof getSessionsForKey;
  sessionEpoch: typeof sessionEpoch;
  resetSession: typeof resetSession;
  shouldDistill: typeof shouldDistill;
  distillSession: typeof distillSession;
  log: typeof sbLog;
  getAgentConfig: typeof getAgentConfigOrGeneral;
  getSettings: typeof getSettings;
  resolveStreamingLimits: () => StreamingLimits;
  /** Werte, die der Stand-Bericht maskiert (.env und geheime Umgebung); wirft, wenn die .env nicht lesbar ist */
  reportSecrets: () => readonly SecretValue[];
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  now: () => number;
  /** Hinweis aufs Telefongespräch dieses Gesprächs, genau einmal (Issue #260) */
  takeCallRecap: (sessionKey: string) => string | undefined;
  /** Rückfrage ins Register (offerAsk aus ask-choices.ts, Issue #336) */
  offerAsk: (offer: AskOffer) => Promise<AskOfferOutcome>;
  /** Gespräch der Rückfrage zu Chat und Topic (threadConversation); null bei unbekanntem Chat */
  questionConversation: (chatId: string, topicId?: number) => Promise<ChoiceConversation | null>;
  /** Getippte Antwort auf eine Rückfrage im Register vermerken (settleTypedAnswer aus ask-choices.ts) */
  settleTypedAnswer: (answer: TypedAnswer) => Promise<unknown>;
}

const defaultDeps: ChatTurnDeps = {
  getEngine,
  resolveEngine,
  readSwitchState,
  noteStageRun,
  scheduleClaudeUsageAfterChat,
  forgetEngineCheck,
  runFallbackChain,
  buildPromptContext,
  buildResumePrompt,
  isSessionModeEnabled,
  getResumableSession,
  takeExpiredSession,
  retainHandover,
  takeHandover,
  recordSessionTurn,
  getSessionsForKey,
  sessionEpoch,
  resetSession,
  shouldDistill,
  distillSession,
  log: sbLog,
  // Unbekannte oder geloeschte Agenten wie bisher mit General (Issue #49)
  getAgentConfig: getAgentConfigOrGeneral,
  getSettings,
  resolveStreamingLimits: () => resolveStreamingLimits(),
  reportSecrets: () => projectSecretsOrThrow(PROJECT_ROOT),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  takeCallRecap,
  // Erst beim Anbieten geladen: ask-choices.ts lädt über task-resume.ts diesen Kern
  offerAsk: async offer => (await import("./ask-choices")).offerAsk(offer),
  questionConversation: async (chatId, topicId) => (await import("./threads/detect")).threadConversation(chatId, topicId),
  settleTypedAnswer: async answer => (await import("./ask-choices")).settleTypedAnswer(answer),
};

function resolveDeps(deps?: Partial<ChatTurnDeps>): ChatTurnDeps {
  return deps ? { ...defaultDeps, ...deps } : defaultDeps;
}

/** Motor und Modell, mit denen eine Session-ID entstanden ist (Rückfrage-Tasks, Issue #122) */
export interface TurnSessionMeta {
  engine: EngineId;
  /**
   * "" bei einem Motor ohne eingestelltes Modell (Codex-Konfiguration): bewusst
   * leer, beim Fortsetzen wird nie ein Modell nachgetragen. Nur Tasks vor
   * Issue #122 haben gar keine Angabe.
   */
  model: string;
}

/** Rückruf für die Session-ID eines Turns (Telegram-Rückfragen) */
export type SessionIdListener = (id: string, meta: TurnSessionMeta) => void;

/** Rückruf für Motor und Modell eines Turns, auch ohne Session-ID (Issue #122) */
export type SessionMetaListener = (meta: TurnSessionMeta) => void;

/** Für dieselbe Eingabe bereits außerhalb des Turns gescheiterter Stufenversuch. */
export interface PriorAttempt {
  stage: { engine: EngineId; model?: string };
  result: EngineResult;
}

export interface TurnOptions {
  /** --zurueck-Kette dieses Turns, an alle Subprozess-Motoren weitergereicht. */
  jobChain?: number;
  userMessage: string;
  chatId: string;
  agentName: string;
  topicId?: number;
  priorAttempts?: PriorAttempt[];
  /** Gesammelte Hinweise dürfen nach Abschluss keinen veralteten Laufzeit-Hinweis zeigen. */
  longRunNotices?: boolean;
  /** Motor des Turns; fehlt: Motor des Gesprächs (resolveEngine: /motor, Standard, TYBO_ENGINE, Claude) */
  engine?: EngineId;
  /**
   * Hinweis nur für diesen Turn (Issue #249, Sprech-Turns): hängt an jedem
   * Prompt des Turns, voll wie fortgesetzt, bei jedem Motor, auch nach einem
   * neuen Versuch, beim Wechsel auf Claude Code und an der Frage für die
   * Fallback-Kette. Nie Teil von userMessage: Kontext-Aufbau, Suche und die
   * gespeicherte Nachricht sehen ihn nicht.
   */
  turnHint?: string;
  /**
   * Modell nur für diesen Turn (Issue #249, speech.model für gesprochene
   * Fragen). Gilt, wenn es der Form nach zum Motor des Turns passt
   * (modelFitsEngine); sonst wird es ignoriert und einmal je Gespräch als
   * Hinweis gemeldet, nie ein Fehler. effort gilt nur beim Motor Claude; bei
   * Codex und OpenCode bleibt die Stufe des Motors. Die Session bleibt unter
   * dem Modell des Gesprächs gespeichert: der Turn setzt sie fort, und der
   * nächste normale Turn setzt sie wieder mit seinem Modell fort.
   */
  turnModel?: { model: string; effort?: string };
  /**
   * Issue #260: Den Hinweis aufs Telefongespräch (src/lib/call-recap.ts)
   * nicht verbrauchen. Gesetzt bei Denkaufträgen aus dem Telefonhörer: der
   * Hinweis gehört dem nächsten getippten Turn.
   */
  skipCallRecap?: boolean;
  /**
   * Turn ohne Telegram (Denkauftrag aus dem Telefonhörer, Issue #259) im
   * WebUI-Gespräch conversationId. Geht an den Motor (EngineRequest.noTelegram):
   * Planungswerkzeuge legen dann wie [REMIND:] nur für die WebUI an.
   */
  noTelegram?: { conversationId: string };
  /**
   * Kanal der Antwort (Issue #358): bestimmt die Kanalregeln im Prompt, frisch
   * wie fortgesetzt, auch beim neuen Versuch. Fehlt er, gelten die
   * Telegram-Regeln (Telegram, WhatsApp, /goal, /board aus Telegram).
   */
  channel?: PromptChannel;
  sink: TurnSink;
  /** Bekommt jede Session-ID eines nicht abgebrochenen Laufs, auch bei Fehlern, mit Motor und Modell. */
  onSessionId?(id: string, meta: TurnSessionMeta): void | Promise<void>;
  /**
   * Motor und Modell jedes nicht abgebrochenen Laufs, auch ohne Session-ID
   * (Issue #122): eine Rückfrage ohne eigene ID setzt die Topic-Session
   * dieses Motors fort, nicht eine Claude-Session.
   */
  onSessionMeta?(meta: TurnSessionMeta): void;
  /** Agent, Modell, Motor und Dauer, sobald die Antwort feststeht; nicht bei Abbruch */
  onInfo?(info: TurnInfo): void;
  /**
   * Werkzeuge des Turns (Issue #53), sobald die Antwort feststeht; nicht bei
   * Abbruch. undefined heißt unbekannt (Fallback-Modell, CLI ohne Angaben).
   */
  onTools?(tools: TurnTools | undefined): void;
  /**
   * Rückfrage des Modells (Issue #336, turn-questions.ts): bekommt sie, wenn
   * der Motor selbst geantwortet hat und die Antwort mit einer Rückfrage
   * endet; nie bei Abbruch, Zeitlimit oder Ersatzmodell. Ohne Angabe entsteht
   * keine Rückfrage (interne Aufrufe wie Agenten-Konsultationen,
   * Denkaufträge). Angeboten wird erst mit offer(), damit der Kanal die
   * Antwort vorher zeigen kann. Nur mit Angabe (und ohne noTelegram) bietet
   * der Motor api ask_user an und beantwortet die Nachricht eine offene
   * Rückfrage (EngineRequest.questions, Issue #348).
   */
  onQuestion?(question: TurnQuestion): void;
  deps?: Partial<ChatTurnDeps>;
}

/**
 * Erkannte Rückfrage eines Turns. offer() legt sie mit Session, Motor und
 * Modell des Turns im Register an und zeigt sie im Gespräch des Turns
 * (Telegram-Topic, Direktchat, reines Web-Gespräch); wirft nie.
 */
export interface TurnQuestion extends FoundQuestion {
  offer(): Promise<AskOfferOutcome>;
}

/**
 * Session-aware prompt preparation, shared by both Claude paths.
 * With SESSION_MODE=resume and a live per-topic session of the same engine:
 * slim resume prompt. Otherwise: full context prompt (fresh session). Eine
 * Session eines anderen Motors wird nie fortgesetzt (Issue #122), sondern
 * wie eine abgelaufene über ihren eigenen Motor destilliert.
 * Bei einem Motor- oder Modellwechsel bekommt der volle Prompt zusätzlich
 * den Übergabe-Verlauf. Seine Herkunft bleibt ohne Session-ID als Notiz bis
 * zum Speichern der neuen Session erhalten, auch nach Fehler oder /stop.
 */
export async function prepareClaudeCall(
  userMessage: string, // Nachricht des Nutzers, so wie sie in den Prompt geht
  chatId: string, // Unterhaltung (Telegram-Chat oder web:<id>)
  agentName: string, // Agent des Topics; bestimmt Systemprompt und Session
  topicId?: number,
  model?: string,
  deps?: Partial<ChatTurnDeps>,
  engine: EngineId = DEFAULT_ENGINE,
  channel?: PromptChannel, // Kanal der Antwort (Issue #358); fehlt er, gelten die Telegram-Regeln
  handoverReason: (session: BotSession) => HandoverReason = () => "changed",
): Promise<{
  sessionKey: string;
  resumeId?: string;
  fullPrompt: string;
  fallbackContext: string;
  memoryWatermark: number;
  /** Fakten, die die Session mit diesem Prompt kennt; verbucht erst nach einem gelungenen Lauf */
  shownFactIds?: string[];
  expiredSession?: BotSession;
  resumedSession?: BotSession;
  handover?: SessionHandover;
}> {
  const d = resolveDeps(deps);
  // Modell der Session: Agenten-Modell nur für Claude, sonst das des Motors oder "" (Issue #125)
  const resolvedModel = model ?? sessionModel(engineModelAndEffort(engine, agentName, d).model);
  const memoryWatermark = Date.now();
  const sessionKey = sessionKeyFor(chatId, topicId ?? null);
  const epoch = d.sessionEpoch(sessionKey);
  const session = d.isSessionModeEnabled()
    ? await d.getResumableSession(sessionKey, agentName, resolvedModel, engine)
    : undefined;

  if (session?.engineSessionId && session.engine === engine) {
    // Fallback context stays empty here on purpose: if the resume call fails
    // we retry with a fresh full prompt first, which fills it properly.
    let shownFactIds = session.shownFactIds;
    const fullPrompt = await d.buildResumePrompt({
      userMessage,
      chatId,
      sinceMs: session.memoryWatermark ?? session.startedAt,
      ...(channel ? { channel } : {}),
      shownFactIds: shownFactIds ?? [],
      onFactsShown: (ids) => {
        shownFactIds = ids;
      },
    });
    return {
      sessionKey,
      resumeId: session.engineSessionId,
      resumedSession: session,
      fullPrompt,
      fallbackContext: "",
      memoryWatermark,
      ...(shownFactIds ? { shownFactIds } : {}),
    };
  }

  // Fresh session ahead: if an expired/model-mismatched session is lying
  // around, distill its insights into memory first (fire-and-forget).
  let expiredSession: BotSession | undefined;
  let handover: SessionHandover | undefined;
  if (d.isSessionModeEnabled()) {
    expiredSession = await d.takeExpiredSession(sessionKey, agentName, resolvedModel, engine);
    if (expiredSession) {
      if (Date.now() - expiredSession.lastActivity <= SESSION_IDLE_MS
        && (expiredSession.engine !== engine || expiredSession.model !== resolvedModel)) {
        await d.retainHandover(sessionKey, sessionHandover(expiredSession, handoverReason(expiredSession)), epoch);
        handover = await d.takeHandover(sessionKey, agentName, { preserveUntilRecorded: true });
      }
      if (d.shouldDistill(expiredSession)) void d.distillSession(expiredSession);
    } else {
      handover = await d.takeHandover(sessionKey, agentName, { preserveUntilRecorded: true });
    }
  }

  const { fullPrompt, fallbackContext, shownFactIds } = await d.buildPromptContext({
    userMessage,
    chatId,
    agentName,
    ...(engine === "codex" ? { engine } : {}),
    topicId,
    ...(channel ? { channel } : {}),
    ...(handover ? { handover: promptHandover(handover) } : {}),
  });
  return { sessionKey, resumeId: undefined, fullPrompt, fallbackContext, memoryWatermark,
    expiredSession, handover, ...(shownFactIds ? { shownFactIds } : {}) };
}

function sessionHandover(session: BotSession, reason: HandoverReason): SessionHandover {
  return { agentName: session.agentName, engine: session.engine, model: session.model,
    since: session.startedAt, notedAt: Date.now(), reason };
}

function promptHandover(note: SessionHandover): PromptHandover {
  return { fromLabel: stageLabel({ engine: note.engine, model: note.model || undefined }), reason: note.reason, since: note.since };
}

/**
 * Record a successful turn so the topic's next message can --resume it,
 * unter dem Motor, der das Ergebnis geliefert hat (result.engine).
 * Nach einem Zeitlimit ebenso (Issue #179): „weiter" knüpft an die
 * abgebrochene Session an. Andere Fehler und /stop speichern nichts.
 * true nur, wenn der Zeiger auf genau diese Session gespeichert wurde.
 * epoch: sessionEpoch vor dem Turn; wurde der Schlüssel seitdem mit /new
 * zurückgesetzt, bleibt die alte Session verworfen (Issue #189).
 * shownFactIds: Fakten, die die Session nach diesem Lauf kennt (Issue #523). Sie
 * gelten erst hier als gezeigt, ein gescheiterter Lauf verbucht also nichts.
 */
export async function finalizeClaudeSession(
  sessionKey: string,
  agentName: string,
  result: { engine: EngineId; sessionId?: string; isError?: boolean; text?: string; timedOut?: boolean; aborted?: boolean },
  memoryWatermark?: number,
  model?: string,
  deps?: Partial<ChatTurnDeps>,
  epoch?: number,
  shownFactIds?: string[]
): Promise<boolean> {
  const d = resolveDeps(deps);
  if (!d.isSessionModeEnabled()) return false;
  if (!result.sessionId || result.aborted) return false;
  if (!result.timedOut && (result.isError || !result.text)) return false;
  // Ohne model (Telegram-Button-Antwort in src/bot.ts) lief der Aufruf in der
  // gespeicherten Session weiter, also bleibt deren Modell. Nicht aus
  // config/settings.json nachtraeglich aufloesen: nach einem Modellwechsel
  // stuende die alte Session sonst unter dem neuen Modell und wuerde weiter
  // fortgesetzt. Massgeblich ist nur der Eintrag genau dieser Session: hat
  // inzwischen ein anderer Turn eine Nachfolgesession gespeichert (oder wurde
  // die Session zurueckgesetzt), bleibt der Speicher unangetastet.
  let resolvedModel = model;
  // "" ist ein gültiges Session-Modell (Motor-Standard, Issue #125), nur undefined heißt „gespeichertes nehmen"
  if (resolvedModel === undefined) {
    const stored = (await d.getSessionsForKey(sessionKey)).find(
      (s) => s.agentName === agentName && s.engine === result.engine && s.engineSessionId === result.sessionId
    );
    if (!stored) return false;
    resolvedModel = stored.model;
  }
  if (epoch !== undefined && d.sessionEpoch(sessionKey) !== epoch) return false;
  return await d.recordSessionTurn(sessionKey, agentName, resolvedModel, result.engine, result.sessionId, memoryWatermark, epoch, shownFactIds);
}

/** Überschrift, unter der TurnOptions.turnHint am Prompt hängt */
export const TURN_HINT_HEADING = "## HINWEIS ZU DIESEM TURN";

/** Prompt mit angehängtem Turn-Hinweis; ohne Hinweis unverändert */
export function withTurnHint(prompt: string, hint: string | undefined): string {
  const clean = hint?.trim();
  return clean ? `${prompt}\n\n---\n\n${TURN_HINT_HEADING}\n${clean}` : prompt;
}

/** Snippet für die Anzeige: ohne Markdown- und HTML-Zeichen, höchstens 120 Zeichen */
const cleanSnippet = (snippet: string) => snippet.replace(/[_*`<>]/g, "").substring(0, 120);

/**
 * Wraps the sink: errors never reach the Claude call, and fire-and-forget
 * progress updates are awaited before finish().
 */
function guardSink(sink: TurnSink) {
  const pending = new Set<Promise<unknown>>();
  let finished = false;

  const track = (fn: () => void | Promise<void>) => {
    try {
      const r = fn();
      if (r && typeof (r as Promise<void>).then === "function") {
        const p = Promise.resolve(r).catch(() => {});
        pending.add(p);
        void p.finally(() => pending.delete(p));
      }
    } catch {
      // Sink errors must not break the turn
    }
  };

  return {
    progress(p: TurnProgress) {
      if (finished) return;
      track(() => sink.progress(p));
    },
    async notice(text: string) {
      try {
        await sink.notice(text);
      } catch {}
    },
    async start() {
      try {
        await sink.start?.();
      } catch {}
    },
    async finish() {
      if (finished) return;
      finished = true;
      await Promise.all([...pending]);
      try {
        await sink.finish?.();
      } catch {}
    },
  };
}

type TurnMode = "json" | "streaming";

/** „Nicht angemeldet" oder „nicht installiert" von einem anderen Motor als Claude, beim Lauf erkannt */
function isEngineUnavailable(result: EngineResult): boolean {
  return (
    result.engine !== "claude" &&
    result.isError &&
    !result.aborted &&
    !result.timedOut &&
    (result.errorKind === "auth" || result.errorKind === "not_installed")
  );
}

/**
 * Claude Code ließ sich nicht starten, weil das Programm fehlt (Issue #565):
 * kein neuer Versuch ohne Resume, die Fallback-Kette antwortet
 */
function isClaudeMissing(result: EngineResult): boolean {
  return result.engine === "claude" && result.isError && !result.aborted && !result.timedOut && result.errorKind === "not_installed";
}

/** Fortsetzen auf dem Motor api scheiterte an der Sitzung (errorKind context): nie ein Abbruch oder Zeitlimit */
function isLostApiSession(result: EngineResult): boolean {
  return result.engine === "api" && result.isError && !result.aborted && !result.timedOut && result.errorKind === "context";
}

/** Nur Fehler, die eine frische Session beheben könnte, rechtfertigen den Retry. */
export function canRetryResume(result: EngineResult): boolean {
  if (result.aborted || result.timedOut || (!result.isError && result.text)) return false;
  return !result.isError || result.errorKind === undefined || result.errorKind === "other"
    || result.errorKind === "context" || result.errorKind === "rate_limit";
}

/** Hinweis zur verlorenen Sitzung mit der tatsächlich einspringenden Stufe. */
export function sessionLostNotice(engine: EngineId, answering: Stage | null = { engine: "claude" }): string {
  return `Die Sitzung von ${engineLabel(engine)} ist nicht mehr vorhanden, `
    + (answering ? `ich antworte mit ${stageLabel(answering)}.` : "es antwortet das Ersatzmodell.");
}

function unavailableReason(engine: EngineId, kind: EngineErrorKind | undefined): string {
  return kind === "auth" ? `${engineLabel(engine)} ist nicht angemeldet.` : `${engineLabel(engine)} ist nicht installiert.`;
}

/** Hinweis, wenn ein anderer Motor als Claude ausfällt und die Fallback-Kette antwortet */
export function engineFailedNotice(engine: EngineId, kind?: EngineErrorKind): string {
  const why = kind ? ERROR_KIND_TEXT[kind] : undefined;
  return `${engineLabel(engine)} hat keine Antwort geliefert${why ? ` (${why})` : ""}, es antwortet das Ersatzmodell.`;
}

function freeAgainText(freeAt?: string): string {
  return freeAt ? ` Frühestens wieder frei: ${formatSwitchTime(freeAt, process.env.USER_TIMEZONE || "UTC")} Uhr.` : "";
}

/** Gemeinsame feste Antwort vor dem ersten Lauf und nach aufgegebenen Stufen. */
export function noFreeEngineReply(freeAt?: string): string {
  return "Gerade ist kein Motor frei, und auch die Ersatzmodelle haben nicht geantwortet."
    + freeAgainText(freeAt) + (freeAt ? " Bitte versuch es dann noch einmal." : " Bitte versuch es in ein paar Minuten noch einmal.");
}

async function runTurn(mode: TurnMode, opts: TurnOptions): Promise<string> {
  let claudeRan = false;
  try {
    return await withJobChain(opts.jobChain ?? currentJobChain(), () => runTurnBody(mode, opts, () => { claudeRan = true; }));
  } finally {
    // Der Messlauf beginnt verzögert nach dem Turn und hält dessen Antwort nicht auf.
    if (claudeRan) (opts.deps?.scheduleClaudeUsageAfterChat ?? scheduleClaudeUsageAfterChat)();
  }
}

async function runTurnBody(mode: TurnMode, opts: TurnOptions, claudeFinished: () => void): Promise<string> {
  const { userMessage, chatId, agentName, topicId } = opts;
  const resolved = resolveDeps(opts.deps);
  const settings = resolved.getSettings();
  const d = { ...resolved, getSettings: () => settings };
  const startedAt = d.now();
  const sink = guardSink(opts.sink);
  const agentConfig = d.getAgentConfig(agentName);
  const conversationKey = sessionKeyFor(chatId, topicId ?? null);

  // Reiner /new-Merker im Arbeitsspeicher, kein Zugriff auf eine Session oder
  // deren Datei. Auch ein Reset während der Motorprüfung verwirft das Ergebnis.
  const epoch = d.sessionEpoch(conversationKey);
  // Telefongespräch (Issue #260): genau einmal als Turn-Hinweis, also an jedem Prompt dieses Turns
  const callRecap = opts.skipCallRecap ? undefined : d.takeCallRecap(conversationKey);
  const turnHint = [opts.turnHint?.trim(), callRecap].filter(Boolean).join("\n\n") || undefined;

  const reportTools = (tools: TurnTools | undefined) => {
    try {
      opts.onTools?.(tools);
    } catch {
      // Die Werkzeugliste darf den Turn nie stoeren
    }
  };
  const report = (model: string | undefined, engine?: EngineId, stage?: StageId, reason?: string, timedOut?: boolean) => {
    const info: TurnInfo = {
      agent: agentName,
      ...(model ? { model } : {}),
      ...(engine ? { engine } : {}),
      ...(stage ? { stage } : {}),
      ...(reason ? { reason } : {}),
      ...(timedOut ? { timedOut: true } : {}),
      durationMs: Math.max(0, Math.round(d.now() - startedAt)),
    };
    try {
      opts.onInfo?.(info);
    } catch {
      // Die Anzeige-Angaben duerfen den Turn nie stoeren
    }
  };
  // Motor vor der Prompt-Auswahl: /motor, Agent, Standard, TYBO_ENGINE, Claude und
  // bei Ersatzstufen die Wechselregel. Andere Motoren/Modelle beginnen frisch.
  const priorAttempts = opts.priorAttempts ?? [];
  const priorStages = priorAttempts.map(attempt => attempt.stage);
  const chosen = opts.engine ? undefined : await d.resolveEngine(conversationKey,
    { getSettings: d.getSettings, getAgentConfig: d.getAgentConfig, now: d.now,
      checkSwitch: (statuses, choiceDeps) => checkSwitchNotices(statuses, { ...choiceDeps, readSwitchState: d.readSwitchState }) },
    { agentName, ...(priorStages.length ? { tried: priorStages } : {}) });
  const modelOf = (stage: Stage) => stage.model ?? engineModelAndEffort(stage.engine, agentName, d).model;
  const tried = triedStageIds(chosen?.order ?? [], modelOf, priorStages);
  let stageAttempts = priorAttempts.length;
  const failedClaudeModels = new Set<string | undefined>();
  const failedAttempts: string[] = [];
  const addFailedAttempt = (stage: Stage, result: EngineResult) => {
    let secrets: readonly SecretValue[] | undefined;
    try { secrets = d.reportSecrets(); } catch { /* Ohne lesbare Quelle nur Werkzeugnamen. */ }
    failedAttempts.push(failedAttemptPrompt(stage, result.isError ? result.errorKind : "empty", result.tools, secrets));
  };
  const withFailedAttempts = (prompt: string) => [prompt, ...failedAttempts].join("\n\n");
  for (const attempt of priorAttempts) {
    addFailedAttempt(attempt.stage, attempt.result);
    if (attempt.stage.engine === "claude") failedClaudeModels.add(modelFamily(attempt.stage.model) ?? attempt.stage.model);
  }
  const allowClaudeCli = chosen?.claudeReady === undefined && !priorAttempts.length ? undefined : (model: string): boolean =>
    chosen?.claudeReady !== false && !stageBlock({ engine: "claude" }, model, d.readSwitchState(), d.now())
      && !failedClaudeModels.has(modelFamily(model) ?? model);
  if (chosen?.kind === "none" || stageAttempts >= 3) {
    // Kein Zugriff auf Sessions: auch ein vorhandener Zeiger bleibt unangetastet.
    const { fallbackContext } = await d.buildPromptContext({ userMessage, chatId, agentName, topicId,
      ...(opts.channel ? { channel: opts.channel } : {}) });
    const freeAt = chosen?.kind === "none" ? chosen.freeAt : undefined;
    const freeAgain = freeAgainText(freeAt);
    const failedReply = noFreeEngineReply(freeAt);
    await sink.start();
    if (shouldNotifyNoFreeStage(conversationKey)) {
      await sink.notice("Gerade ist kein Motor frei (Limit erreicht oder nicht bereit). Es antwortet ein Ersatzmodell mit eingeschränktem Werkzeugumfang." + freeAgain);
    }
    await sink.finish();
    reportTools(undefined);
    try {
      const fallback = await d.runFallbackChain({ question: withTurnHint(userMessage, turnHint), context: withFailedAttempts(fallbackContext), allowClaudeCli });
      report(fallback.source !== "none" ? fallback.model || fallback.source : undefined);
      return fallback.source === "none" ? failedReply : renderQuestionTags(fallbackReplyText(fallback));
    } catch (error) {
      report(undefined);
      if (isAbortError(error)) return ABORT_REPLY;
      console.error("[Fallback] Kette ohne freien Motor mit Fehler beendet.");
      return failedReply;
    }
  }
  const engineId = opts.engine ?? chosen!.engine;
  const engineNotice = chosen?.notice;
  const useSwitchRule = chosen?.claudeReady !== undefined;
  const auto = engineAuto(settings);
  // Auch alte Attrappen ohne kind bleiben gültig. order bleibt für den ganzen
  // Turn fest; weitere Stufen stammen ausschließlich von hier.
  const order: readonly Stage[] = chosen?.order ?? [{ engine: engineId }];
  const skippedWish = chosen?.skipped?.find(entry => stageId(entry.stage) === stageId(order[0]));
  let hintReason: "limit" | "outage" = skippedWish?.reason === "blocked" && skippedWish.block.cause !== "outage" ? "limit" : "outage";
  for (const attempt of priorAttempts) {
    if (attempt.stage.engine === order[0].engine && sessionModel(attempt.stage.model) === sessionModel(modelOf(order[0]))) {
      hintReason = stageFailureOf(attempt.result) ?? hintReason;
    }
  }
  const nextStage = () => pickStage(order, modelOf, d.readSwitchState(), chosen!.ready!, d.now(), tried);
  const selectedStage = chosen?.stage ?? { engine: engineId };
  // Modell und Effort je Motor, einmal pro Turn aufgeloest (Claude: Einstellungen
  // vor .env vor Agenten-Datei; Codex: engine.codex, OpenCode: engine.opencode,
  // leer = Konfiguration des Motors).
  // Sessionpruefung, Aufruf, Retry, Speicherung und TurnInfo nutzen dasselbe.
  let current = { stage: selectedStage, stageId: chosen?.stageId ?? stageId(selectedStage), engineId,
    ...(useSwitchRule ? { model: chosen?.model, effort: chosen?.effort } : engineModelAndEffort(engineId, agentName, d, selectedStage)),
    reason: chosen?.reason };
  // Modell des Aufrufs: das Turn-Modell (Sprech-Turn), wenn es zum Motor passt, sonst das des Gesprächs.
  // Je Stufe einmal bestimmt; ein unpassendes Modell ergibt einen Hinweis, einmal je Gespräch
  const misfits: string[] = [];
  const callModels = new Map<StageId, { model?: string; effort?: string }>();
  const callModel = (): { model?: string; effort?: string } => {
    const known = callModels.get(current.stageId);
    if (known) return known;
    let chosen: { model?: string; effort?: string } = { model: current.model, effort: current.effort };
    const wanted = opts.turnModel?.model?.trim();
    const desiredStage = !useSwitchRule || current.stageId === stageId(order[0]);
    const turnModelBlocked = wanted && useSwitchRule
      && stageBlock({ engine: current.engineId }, wanted, d.readSwitchState(), d.now());
    if (wanted && desiredStage && !turnModelBlocked) {
      if (modelFitsEngine(current.engineId, wanted)) {
        const effort = current.engineId === "claude" ? opts.turnModel?.effort : current.effort;
        chosen = { model: wanted, ...(effort ? { effort } : {}) };
      } else if (shouldNotifyModelMisfit(conversationKey, current.engineId, wanted)) {
        misfits.push(modelMisfitNotice(current.engineId, wanted));
      }
    }
    callModels.set(current.stageId, chosen);
    return chosen;
  };
  /** Hinweise zu einem unpassenden Turn-Modell ins Gespräch, sobald der Kanal bereit ist */
  const flushMisfits = async () => {
    for (const text of misfits.splice(0)) await sink.notice(text);
  };
  const streaming = mode === "streaming";

  // Assemble the prompt (topic-isolated conversation, memory, knowledge base,
  // semantic search on every message): see lib/prompt-builder. In resume
  // mode the prompt is slim: the Claude session already holds the context.
  const reasonForHandover = (old: BotSession): HandoverReason => {
    const priorFailure = priorAttempts.length ? stageFailureOf(priorAttempts[priorAttempts.length - 1].result) : undefined;
    if (priorFailure) return priorFailure;
    const skipped = chosen?.skipped?.find(entry => entry.stage.engine === old.engine && sessionModel(modelOf(entry.stage)) === old.model);
    if (skipped?.reason === "not_ready") return "outage";
    if (skipped?.reason === "blocked") return skipped.block.cause === "outage" ? "outage" : "limit";
    // Ohne Ersatzstufen kennt resolveEngine keine skipped-Liste, aber den nicht bereiten Wunschmotor.
    if (chosen && !useSwitchRule && chosen.requested === old.engine && chosen.engine !== old.engine) return "outage";
    return "changed";
  };
  let { sessionKey, resumeId, fullPrompt, fallbackContext, memoryWatermark, shownFactIds, resumedSession, handover } =
    await prepareClaudeCall(userMessage, chatId, agentName, topicId, sessionModel(current.model), d, engineId, opts.channel, reasonForHandover);
  // Fortsetzungs-Prompt ist schlank; ein Wechsel auf einen anderen Motor braucht den vollen
  let promptIsFull = !resumeId;
  let builtHandover = handover;
  let builtEngine = engineId;
  const needsFullPrompt = () => !promptIsFull || builtHandover !== handover
    || (builtEngine === "codex") !== (current.engineId === "codex");

  const beginHandover = async (reason: HandoverReason) => {
    if (!d.isSessionModeEnabled()) return;
    // Auch nach gescheitertem Resume und frischem Versuch bleibt der ursprüngliche Beginn bekannt.
    const origin = handover ?? (resumedSession ? sessionHandover(resumedSession, reason) : undefined);
    if (!origin) return;
    await d.retainHandover(sessionKey, { ...origin, reason }, epoch);
    handover = await d.takeHandover(sessionKey, agentName, { preserveUntilRecorded: true });
    // Kein Zeiger auf einen aufgegebenen Motor bleibt zum Fortsetzen liegen.
    await d.resetSession(sessionKey, agentName);
  };

  await sink.start();
  if (engineNotice) await sink.notice(engineNotice);
  callModel();
  await flushMisfits();

  // Streaming: Leerlauf-Grenze plus Obergrenze (Issue #178). JSON liefert erst
  // am Ende Ausgabe, dort bleibt es bei 30 Minuten Gesamtzeit.
  const limits = streaming ? d.resolveStreamingLimits() : undefined;
  const timeouts = limits
    ? { timeoutMs: limits.maxMs, idleTimeoutMs: limits.idleMs }
    : { timeoutMs: JSON_CALL_TIMEOUT_MS };

  let engine = d.getEngine(engineId);
  // Rückfragen nur, wo dieser Turn sie im Register anlegt (onQuestion); Denkaufträge nie (Entscheidung 0024)
  const withQuestions = !!opts.onQuestion && !opts.noTelegram;
  const baseOpts = () => ({
    streaming,
    ...(agentConfig?.allowedTools && { allowedTools: agentConfig.allowedTools }),
    ...(callModel().model ? { model: callModel().model } : {}),
    ...(callModel().effort ? { effort: callModel().effort } : {}),
    cwd: PROJECT_ROOT, // Projektordner: dessen CLAUDE.md und .claude-Einstellungen gelten
    abortKey: sessionKey, // /stop kills this subprocess
    ...(opts.noTelegram ? { noTelegram: { conversationId: opts.noTelegram.conversationId } } : {}),
    ...(withQuestions ? { questions: true } : {}),
  });
  const streamCallbacks = {
    onToolStart: (toolName: string) => {
      sink.progress({ kind: "tool", text: toolName });
    },
    onFirstText: (snippet: string, fullText?: string) => {
      const clean = cleanSnippet(snippet);
      if (clean.length > 20) {
        // Für Telegram vor der ersten Kürzung bereinigen: ein angeschnittenes
        // Bild erkennt später niemand mehr (Issue #52)
        const forTelegram = cleanSnippet(firstTextSnippet(sanitizeModelOutput(fullText ?? snippet)));
        sink.progress({ kind: "snippet", text: clean, telegramText: forTelegram.length > 20 ? forTelegram : "" });
      }
    },
  };

  // Without resume, each message gets a fresh session; continuity then comes
  // from context + memory + semantic search. The long-run heads-up is armed
  // for the duration of each call and repeats every 20 minutes below the
  // upper bound; it names the minutes actually passed.
  const maxMs = limits?.maxMs ?? JSON_CALL_TIMEOUT_MS;
  let pendingStageRun = Promise.resolve();
  const call = async (prompt: string, resumeSessionId?: string): Promise<EngineResult> => {
    if (currentExecution()?.controller.signal.aborted) return { engine: current.engineId, text: "", isError: true, aborted: true };
    if (useSwitchRule) {
      const hint = conversationSwitchHint(conversationKey, order[0], current.stage, hintReason, !!builtHandover, d.now(), agentName);
      if (hint) await sink.notice(hint);
    }
    const callStartedAt = d.now();
    let notices = 0;
    let done = false;
    let timer: unknown;
    const arm = () => {
      timer = d.setTimer(() => {
        if (done) return;
        notices++;
        const due = notices * LONG_RUN_NOTICE_MS;
        const elapsedMs = Math.max(d.now() - callStartedAt, due);
        void sink.notice(
          longRunNoticeText({
            elapsedMin: Math.floor(elapsedMs / 60_000),
            maxMin: maxMs / 60_000,
            ...(limits ? { idleMin: limits.idleMs / 60_000 } : {}),
          })
        );
        if (due + LONG_RUN_NOTICE_MS < maxMs) arm();
      }, LONG_RUN_NOTICE_MS);
    };
    if (opts.longRunNotices !== false) arm();
    try {
      const request: EngineRequest = {
        // Turn-Hinweis (Sprech-Turn) an jedem Aufruf: erster Lauf, neuer Versuch, Wechsel auf Claude Code
        prompt: withTurnHint(withFailedAttempts(prompt), turnHint),
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...baseOpts(),
        ...timeouts,
        ...(streaming ? streamCallbacks : {}),
      };
      if (!tried.has(current.stageId)) stageAttempts++;
      tried.add(current.stageId);
      const result = await engine.run(request);
      // Auch leer oder rate_limit zählt als gescheitert, unabhängig von Sperren.
      if (current.engineId === "claude" && (result.isError || !result.text)) {
        failedClaudeModels.add(modelFamily(request.model) ?? request.model);
      }
      // Genau eine Buchung je Lauf (Issue #346): vor Abbruch, neuem Versuch,
      // Motorwechsel und Fehler-Rückgabe, also für jeden gestarteten Lauf
      void bookRunOutcome("chat", result.engine, request.model, result);
      return result;
    } finally {
      done = true;
      d.clearTimer(timer);
    }
  };

  const rebuildFullPrompt = async () => {
    // Neue Session: Sie kennt nur, was der volle Prompt zeigt
    ({ fullPrompt, fallbackContext, shownFactIds } = await d.buildPromptContext({
      userMessage,
      chatId,
      agentName,
      ...(current.engineId === "codex" ? { engine: current.engineId } : {}),
      topicId,
      ...(opts.channel ? { channel: opts.channel } : {}),
      ...(handover ? { handover: promptHandover(handover) } : {}),
    }));
    promptIsFull = true;
    builtHandover = handover;
    builtEngine = current.engineId;
  };

  /** Ohne Ersatzstufen bleibt das bisherige Einspringen auf Claude Code erhalten. */
  const legacyClaudeRetry = async (failed: EngineResult, why: "unavailable" | "session"): Promise<EngineResult> => {
    const from = failed.engine;
    await beginHandover("outage");
    console.warn(`[Motor] ${engineLabel(from)} meldet ${failed.errorKind} für ${conversationKey}, antworte mit Claude Code`);
    if (why === "session") {
      await sink.notice(sessionLostNotice(from));
    } else if (shouldNotifyUnavailable(conversationKey, from, "run")) {
      await sink.notice(unavailableNotice(from, unavailableReason(from, failed.errorKind)));
    }
    current = { stage: { engine: "claude" }, stageId: "claude", engineId: "claude",
      ...engineModelAndEffort("claude", agentName, d), reason: undefined };
    engine = d.getEngine("claude");
    callModel();
    await flushMisfits();
    if (needsFullPrompt()) await rebuildFullPrompt();
    return call(fullPrompt);
  };

  const noteResult = (result: EngineResult, abandoned = true) => {
    if (useSwitchRule) pendingStageRun = d.noteStageRun(current.stage, callModel().model, result, auto, d.now(), undefined, { abandoned });
    if (result.engine === "claude" && !result.aborted) claudeFinished();
  };
  let result = await call(fullPrompt, resumeId);
  while (true) {
    // Gilt nach jedem Lauf und auch bei /stop während der Zustandsablage.
    if (result.aborted || currentExecution()?.controller.signal.aborted) {
      noteResult({ ...result, aborted: true }, false);
      await sink.finish();
      return ABORT_REPLY;
    }
    const lostSession = !!resumeId && isLostApiSession(result);
    if (useSwitchRule && !result.timedOut && (result.isError || !result.text)) {
      addFailedAttempt({ ...current.stage, model: callModel().model }, result);
    }
    if (!result.timedOut && result.isError && (result.errorKind === "auth" || result.errorKind === "not_installed")) {
      d.forgetEngineCheck();
    }
    const retryResume = resumeId && !lostSession && canRetryResume(result);
    if (retryResume) {
      // Noch nicht aufgegeben: Messung übernehmen, aber keine Fehlersperre.
      noteResult(result, false);
      console.warn(`[Session] Fortsetzen für ${sessionKey} fehlgeschlagen, versuche frisch.`);
      await d.resetSession(sessionKey, agentName);
      await rebuildFullPrompt();
      resumeId = undefined;
      result = await call(fullPrompt);
      continue;
    }

    noteResult(result);
    const failure = stageFailureOf(result);
    if (lostSession) await d.resetSession(sessionKey, agentName);
    if (useSwitchRule && (failure || lostSession)) {
      await pendingStageRun;
      if (currentExecution()?.controller.signal.aborted) {
        await sink.finish();
        return ABORT_REPLY;
      }
      await beginHandover(failure ?? "outage");
      const next = nextStage();
      if (stageAttempts >= 3 || next.kind === "none") {
        if (lostSession) await sink.notice(sessionLostNotice(result.engine, null));
        break;
      }
      const previous = current.stage;
      if (stageId(previous) === stageId(order[0])) hintReason = failure ?? "outage";
      const reason = `${stageLabel(previous)}: ${failure ?? "Sitzung verloren"}`;
      if (lostSession) await sink.notice(sessionLostNotice(result.engine, next.stage));
      sink.progress({ kind: "tool", text: `${stageLabel(previous)} ${failure === "limit" ? "ist am Limit" : "antwortet nicht"}, ${stageLabel(next.stage)} übernimmt.` });
      current = { stage: next.stage, stageId: stageId(next.stage), engineId: next.stage.engine,
        ...engineModelAndEffort(next.stage.engine, agentName, d, next.stage), reason };
      engine = d.getEngine(current.engineId);
      callModel();
      await flushMisfits();
      if (needsFullPrompt()) await rebuildFullPrompt();
      resumeId = undefined;
      result = await call(fullPrompt);
      continue;
    }
    if (!useSwitchRule && (isEngineUnavailable(result) || lostSession)) {
      result = await legacyClaudeRetry(result, lostSession ? "session" : "unavailable");
      resumeId = undefined;
      continue;
    }
    break;
  }

  // Der Motor hat geantwortet: nachgewiesen wieder bereit, ein späterer Ausfall
  // wird erneut gemeldet (eine positive Vorprüfung allein reicht nicht). Gilt
  // auch für Claude Code, dessen fehlendes Programm einmal gemeldet wird (Issue #565)
  if (!result.isError && !result.timedOut && result.text) markEngineRecovered(conversationKey, result.engine);

  // Die getippte Nachricht hat eine offene Rückfrage beantwortet (Motor api):
  // im Register schließen, noch unter der Sperre des Gesprächs, damit ein
  // Klick auf den alten Knopf nichts mehr fortsetzt
  // Nur ein Turn mit Rückfragen-Register beantwortet eine Rückfrage (withQuestions)
  if (result.answeredQuestion && withQuestions && !result.isError && !result.timedOut && !result.aborted) {
    try {
      const conversation = await d.questionConversation(chatId, topicId);
      if (conversation) await d.settleTypedAnswer({ conversation, sessionId: result.answeredQuestion, answer: userMessage });
    } catch (e) {
      console.warn(`[Rückfrage] getippte Antwort nicht vermerkt (${e instanceof Error ? e.name : "Fehler"})`);
    }
  }

  const sessionStored = await finalizeClaudeSession(
    sessionKey,
    agentName,
    result,
    memoryWatermark,
    sessionModel(current.model),
    d,
    epoch,
    shownFactIds
  );

  // Track session ID for HITL task creation (if Claude asks a question with buttons);
  // Motor und Modell auch ohne Session-ID, nie ein Claude-Modell für einen anderen Motor;
  // "" heißt bewusst Standard des Motors (nicht: Angabe fehlt)
  const sessionMeta: TurnSessionMeta = { engine: result.engine, model: sessionModel(current.model) };
  try {
    opts.onSessionMeta?.(sessionMeta);
  } catch {
    // Die Rückfrage-Angaben duerfen den Turn nie stoeren
  }
  if (result.sessionId) await opts.onSessionId?.(result.sessionId, sessionMeta);

  // No more progress from here on: the channel can clean up
  await sink.finish();

  // Claude wie bisher, andere Motoren mit ihrem Namen (Issue #125)
  const name = result.engine === "claude" ? "Claude" : engineLabel(result.engine);
  const label = streaming ? `${name} streaming` : name;

  // Zeitlimit: kein Fallback, der Auftrag liefe sonst doppelt (Issue #179).
  // Stattdessen der Stand als Antwort, nicht zusätzlich als Hinweis.
  if (result.timedOut) {
    // Text aus log-lines.ts: der Nachtcheck zählt genau diese Zeile (Issue #568)
    console.warn(
      engineTimeoutLogLine(
        label,
        result.timeoutKind,
        `steps=${result.steps?.length ?? "unbekannt"}, sessionId=${result.sessionId ? "ja" : "nein"}` +
          `${result.stallPhase ? `, phase: ${stallPhaseLogText(result.stallPhase)}` : ""}`
      )
    );
    await d.log("warn", "bot", `${label} timeout, ${TIMEOUT_NO_FALLBACK}`, {
      timedOut: true,
      ...(result.timeoutKind ? { timeoutKind: result.timeoutKind } : {}),
      ...(result.stoppedAfterMs !== undefined ? { stoppedAfterMs: result.stoppedAfterMs } : {}),
      ...(result.idleForMs !== undefined ? { idleForMs: result.idleForMs } : {}),
      ...(result.stallPhase ? { stallPhase: result.stallPhase } : {}),
    });
    // Ohne lesbare Geheimnisse nur Werkzeugnamen: ungeprüfte Eingaben und
    // Zwischentext könnten Schlüssel enthalten
    let secrets: readonly SecretValue[] | undefined;
    try {
      secrets = d.reportSecrets();
    } catch (err) {
      console.error("[chat-turn] Geheimnisse für den Stand-Bericht nicht lesbar, zeige nur Werkzeugnamen:", err);
    }
    const reply = formatTimeoutReport({
      ...(result.engine !== "claude" ? { engineName: name } : {}),
      kind: result.timeoutKind,
      ...(limits ? { idleLimitMs: limits.idleMs, maxLimitMs: limits.maxMs } : { maxLimitMs: JSON_CALL_TIMEOUT_MS }),
      stoppedAfterMs: result.stoppedAfterMs,
      idleForMs: result.idleForMs,
      ...(result.stallPhase ? { stallPhase: result.stallPhase } : {}),
      steps: secrets ? result.steps : result.steps?.map((step) => ({ name: step.name })),
      lastText: secrets ? result.lastText : undefined,
      // Nur wenn der Zeiger auf diese Session gespeichert wurde (finalizeClaudeSession
      // oben), setzt die nächste Nachricht sie fort; sonst kein Versprechen
      canResume: sessionStored,
      secrets: secrets ?? [],
    });
    // Werkzeuge des abgebrochenen Laufs: fremde Inhalte gelten auch hier
    reportTools(result.tools);
    report(undefined, undefined, undefined, undefined, true);
    return reply;
  }

  // Fehler oder leere Antwort: die Fallback-Kette springt ein
  if (result.isError || !result.text) {
    console.error(
      `${label} error (text=${result.text?.length || 0} chars${result.errorKind ? `, errorKind=${result.errorKind}` : ""}): [content omitted]`
    );
    await d.log("warn", "bot", `${label} failed, using fallback LLM`, {
      error: result.text?.substring(0, 200),
      timedOut: false,
      engine: result.engine,
      ...(result.errorKind ? { errorKind: result.errorKind } : {}),
    });
    // Andere Motoren mit Hinweis; Claude-Ausfälle bleiben still wie bisher,
    // außer wenn das Programm fehlt: das meldet sich einmal je Gespräch (Issue #565)
    if (result.engine !== "claude") await sink.notice(engineFailedNotice(result.engine, result.errorKind));
    else if (isClaudeMissing(result) && shouldNotifyUnavailable(conversationKey, "claude", "run")) {
      await sink.notice(CLAUDE_NOT_INSTALLED_NOTICE);
    }

    // Was das Fallback-Modell an Werkzeugen nutzte, ist nicht bekannt
    reportTools(undefined);
    const fallbackFreeAt = () => {
      const picked = nextStage();
      return picked.kind === "none" ? picked.freeAt : undefined;
    };
    let fallback: FallbackResult;
    try {
      if (needsFullPrompt()) await rebuildFullPrompt();
      // Neue Messwerte müssen vor der synchronen Freigabe der CLI sichtbar sein.
      await pendingStageRun;
      fallback = await d.runFallbackChain({ question: withTurnHint(userMessage, turnHint), context: withFailedAttempts(fallbackContext),
        ...(allowClaudeCli ? { allowClaudeCli } : {}) });
    } catch (chainError) {
      report(undefined);
      // /stop während der Kette: wie ein Abbruch des Hauptmotors, keine Fehlerantwort
      if (isAbortError(chainError)) return ABORT_REPLY;
      console.error("[Fallback] Kette mit Fehler beendet:", chainError);
      return useSwitchRule ? noFreeEngineReply(fallbackFreeAt()) : FALLBACK_FAILED_REPLY;
    }
    // Strukturierte Herkunft statt den Herkunftszusatz zu parsen
    report(fallback.source !== "none" ? fallback.model || fallback.source : undefined);
    // Keine Rückfrage: das Ersatzmodell hat keine Session, die eine Antwort fortsetzen könnte
    return useSwitchRule && fallback.source === "none" ? noFreeEngineReply(fallbackFreeAt()) : renderQuestionTags(fallbackReplyText(fallback));
  }

  reportTools(result.tools);
  // Das Modell, das geantwortet hat: bei einem Sprech-Turn das Turn-Modell
  report(callModel().model, result.engine, useSwitchRule ? current.stageId : undefined, current.reason);
  const scan = scanForQuestion(result.text);
  if (scan.found && opts.onQuestion) {
    const question = turnQuestion(scan.found, {
      chatId,
      topicId,
      originalPrompt: userMessage,
      agent: agentName,
      // Motor und Modell des tatsächlichen Aufrufs (bei einem Sprech-Turn das Turn-Modell):
      // die Knopf-Antwort setzt so fort, wie gefragt wurde. Die Session bleibt unter dem
      // Modell des Gesprächs gespeichert (sessionMeta), normale Folgeturns ändern sich nicht
      meta: { engine: result.engine, model: sessionModel(callModel().model) },
      sessionId: result.sessionId,
      deps: d,
    });
    try {
      opts.onQuestion(question);
    } catch {
      // Die Rückfrage darf den Turn nie stören
    }
  }
  return scan.text;
}

/** Rückfrage mit den Angaben des Turns; offer() fängt jeden Fehler */
function turnQuestion(
  found: FoundQuestion,
  turn: {
    chatId: string;
    topicId?: number;
    originalPrompt: string;
    agent: string;
    meta: TurnSessionMeta;
    sessionId?: string;
    deps: ChatTurnDeps;
  }
): TurnQuestion {
  return {
    ...found,
    async offer() {
      try {
        const conversation = await turn.deps.questionConversation(turn.chatId, turn.topicId);
        if (!conversation) return { status: "unavailable" };
        const outcome = await turn.deps.offerAsk({
          conversation,
          question: found.question,
          options: found.options,
          originalPrompt: turn.originalPrompt,
          agent: turn.agent,
          engine: turn.meta.engine,
          model: turn.meta.model,
          ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
        });
        // Nur der Ausgang ins Log, nie Frage oder Antworten
        if (outcome.status !== "offered") console.warn(`[Rückfrage] nicht angeboten (${outcome.status})`);
        return outcome;
      } catch (e) {
        console.warn(`[Rückfrage] nicht angeboten (${e instanceof Error ? e.name : "Fehler"})`);
        return { status: "not-saved" };
      }
    },
  };
}

/** Turn over the streaming subprocess: tool steps and first snippet as progress. */
export function runStreamingTurn(opts: TurnOptions): Promise<string> {
  return runTurn("streaming", opts);
}

/** Turn over the JSON subprocess: no progress, only notices. */
export function runJsonTurn(opts: TurnOptions): Promise<string> {
  return runTurn("json", opts);
}
