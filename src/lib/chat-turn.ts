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
import { getEngine, forgetEngineCheck, DEFAULT_ENGINE, type EngineErrorKind, type EngineId, type EngineRequest, type EngineResult } from "./engines";
import {
  resolveEngine,
  engineModelAndEffort,
  engineLabel,
  sessionModel,
  shouldNotifyUnavailable,
  markEngineRecovered,
  unavailableNotice,
} from "./engine-choice";
import { maskSecrets, projectSecretsOrThrow, type SecretValue } from "./jobs/mask";
import { sanitizeModelOutput } from "./telegram";
import { callFallbackLLMWithSource, formatFallbackReply, type FallbackResult } from "./fallback-llm";
import { buildPromptContext, buildResumePrompt } from "./prompt-builder";
import { sessionKeyFor, log as sbLog } from "./convex";
import {
  isSessionModeEnabled,
  getResumableSession,
  takeExpiredSession,
  recordSessionTurn,
  resetSession,
  getSessionsForKey,
  sessionEpoch,
} from "./session-manager";
import { shouldDistill, distillSession } from "./session-distill";
import { getAgentConfigOrGeneral } from "../agents";
import { getSettings } from "./settings";
import type { TurnTools } from "./turn-tools";

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
  durationMs: number;
}

/** Austauschbare Abhaengigkeiten, vor allem fuer Tests. */
export interface ChatTurnDeps {
  /** Motor eines Turns (src/lib/engines) */
  getEngine: typeof getEngine;
  /** Motor des Gesprächs samt Verfügbarkeit (src/lib/engine-choice.ts, Issue #125) */
  resolveEngine: typeof resolveEngine;
  /** Ein Lauf meldete „nicht angemeldet/installiert": nächste Prüfung frisch */
  forgetEngineCheck: () => void;
  callFallbackLLMWithSource: (prompt: string, context?: string) => Promise<FallbackResult>;
  buildPromptContext: typeof buildPromptContext;
  buildResumePrompt: typeof buildResumePrompt;
  isSessionModeEnabled: typeof isSessionModeEnabled;
  getResumableSession: typeof getResumableSession;
  takeExpiredSession: typeof takeExpiredSession;
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
}

const defaultDeps: ChatTurnDeps = {
  getEngine,
  resolveEngine,
  forgetEngineCheck,
  callFallbackLLMWithSource,
  buildPromptContext,
  buildResumePrompt,
  isSessionModeEnabled,
  getResumableSession,
  takeExpiredSession,
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

export interface TurnOptions {
  userMessage: string;
  chatId: string;
  agentName: string;
  topicId?: number;
  /** Motor des Turns; fehlt: Motor des Gesprächs (resolveEngine: /motor, Standard, TYBO_ENGINE, Claude) */
  engine?: EngineId;
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
  deps?: Partial<ChatTurnDeps>;
}

/**
 * Session-aware prompt preparation, shared by both Claude paths.
 * With SESSION_MODE=resume and a live per-topic session of the same engine:
 * slim resume prompt. Otherwise: full context prompt (fresh session). Eine
 * Session eines anderen Motors wird nie fortgesetzt (Issue #122), sondern
 * wie eine abgelaufene über ihren eigenen Motor destilliert.
 */
export async function prepareClaudeCall(
  userMessage: string,
  chatId: string,
  agentName: string,
  topicId?: number,
  model?: string,
  deps?: Partial<ChatTurnDeps>,
  engine: EngineId = DEFAULT_ENGINE
): Promise<{
  sessionKey: string;
  resumeId?: string;
  fullPrompt: string;
  fallbackContext: string;
  memoryWatermark: number;
}> {
  const d = resolveDeps(deps);
  // Modell der Session: Agenten-Modell nur für Claude, sonst das des Motors oder "" (Issue #125)
  const resolvedModel = model ?? sessionModel(engineModelAndEffort(engine, agentName, d).model);
  const memoryWatermark = Date.now();
  const sessionKey = sessionKeyFor(chatId, topicId ?? null);
  const session = d.isSessionModeEnabled()
    ? await d.getResumableSession(sessionKey, agentName, resolvedModel, engine)
    : undefined;

  if (session?.engineSessionId && session.engine === engine) {
    // Fallback context stays empty here on purpose: if the resume call fails
    // we retry with a fresh full prompt first, which fills it properly.
    const fullPrompt = await d.buildResumePrompt({
      userMessage,
      chatId,
      sinceMs: session.memoryWatermark ?? session.startedAt,
    });
    return {
      sessionKey,
      resumeId: session.engineSessionId,
      fullPrompt,
      fallbackContext: "",
      memoryWatermark,
    };
  }

  // Fresh session ahead: if an expired/model-mismatched session is lying
  // around, distill its insights into memory first (fire-and-forget).
  if (d.isSessionModeEnabled()) {
    const expired = await d.takeExpiredSession(sessionKey, agentName, resolvedModel, engine);
    if (expired && d.shouldDistill(expired)) void d.distillSession(expired);
  }

  const { fullPrompt, fallbackContext } = await d.buildPromptContext({
    userMessage,
    chatId,
    agentName,
    topicId,
  });
  return { sessionKey, resumeId: undefined, fullPrompt, fallbackContext, memoryWatermark };
}

/**
 * Record a successful turn so the topic's next message can --resume it,
 * unter dem Motor, der das Ergebnis geliefert hat (result.engine).
 * Nach einem Zeitlimit ebenso (Issue #179): „weiter" knüpft an die
 * abgebrochene Session an. Andere Fehler und /stop speichern nichts.
 * true nur, wenn der Zeiger auf genau diese Session gespeichert wurde.
 * epoch: sessionEpoch vor dem Turn; wurde der Schlüssel seitdem mit /new
 * zurückgesetzt, bleibt die alte Session verworfen (Issue #189).
 */
export async function finalizeClaudeSession(
  sessionKey: string,
  agentName: string,
  result: { engine: EngineId; sessionId?: string; isError?: boolean; text?: string; timedOut?: boolean; aborted?: boolean },
  memoryWatermark?: number,
  model?: string,
  deps?: Partial<ChatTurnDeps>,
  epoch?: number
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
  return await d.recordSessionTurn(sessionKey, agentName, resolvedModel, result.engine, result.sessionId, memoryWatermark, epoch);
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

function unavailableReason(engine: EngineId, kind: EngineErrorKind | undefined): string {
  return kind === "auth" ? `${engineLabel(engine)} ist nicht angemeldet.` : `${engineLabel(engine)} ist nicht installiert.`;
}

const ERROR_KIND_TEXT: Partial<Record<EngineErrorKind, string>> = {
  usage_limit: "Nutzungsgrenze erreicht",
  rate_limit: "zu viele Anfragen",
  quota: "Kontingent aufgebraucht",
  capacity: "überlastet",
  context: "Gespräch zu lang",
};

/** Hinweis, wenn ein anderer Motor als Claude ausfällt und die Fallback-Kette antwortet */
export function engineFailedNotice(engine: EngineId, kind?: EngineErrorKind): string {
  const why = kind ? ERROR_KIND_TEXT[kind] : undefined;
  return `${engineLabel(engine)} hat keine Antwort geliefert${why ? ` (${why})` : ""}, es antwortet das Ersatzmodell.`;
}

async function runTurn(mode: TurnMode, opts: TurnOptions): Promise<string> {
  const { userMessage, chatId, agentName, topicId } = opts;
  const d = resolveDeps(opts.deps);
  const startedAt = d.now();
  const sink = guardSink(opts.sink);
  const agentConfig = d.getAgentConfig(agentName);
  const conversationKey = sessionKeyFor(chatId, topicId ?? null);

  // Vor allem anderen: ein /new ab hier verwirft die Session dieses Turns
  const epoch = d.sessionEpoch(conversationKey);

  // Motor vor der Prompt-Auswahl (Issue #125): /motor des Gesprächs, Standard,
  // TYBO_ENGINE, Claude; ein nicht bereiter Motor wird übersprungen. Eine
  // Session eines anderen Motors wird nicht fortgesetzt.
  let engineNotice: string | undefined;
  let engineId: EngineId;
  if (opts.engine) {
    engineId = opts.engine;
  } else {
    const chosen = await d.resolveEngine(conversationKey, { getSettings: d.getSettings });
    engineId = chosen.engine;
    engineNotice = chosen.notice;
  }
  // Modell und Effort je Motor, einmal pro Turn aufgeloest (Claude: Einstellungen
  // vor .env vor Agenten-Datei; Codex: engine.codex, OpenCode: engine.opencode,
  // leer = Konfiguration des Motors).
  // Sessionpruefung, Aufruf, Retry, Speicherung und TurnInfo nutzen dasselbe.
  let current = { engineId, ...engineModelAndEffort(engineId, agentName, d) };
  const streaming = mode === "streaming";
  const reportTools = (tools: TurnTools | undefined) => {
    try {
      opts.onTools?.(tools);
    } catch {
      // Die Werkzeugliste darf den Turn nie stoeren
    }
  };
  const report = (model: string | undefined, engine?: EngineId) => {
    const info: TurnInfo = {
      agent: agentName,
      ...(model ? { model } : {}),
      ...(engine ? { engine } : {}),
      durationMs: Math.max(0, Math.round(d.now() - startedAt)),
    };
    try {
      opts.onInfo?.(info);
    } catch {
      // Die Anzeige-Angaben duerfen den Turn nie stoeren
    }
  };

  // Assemble the prompt (topic-isolated conversation, memory, knowledge base,
  // semantic search on every message): see lib/prompt-builder. In resume
  // mode the prompt is slim: the Claude session already holds the context.
  let { sessionKey, resumeId, fullPrompt, fallbackContext, memoryWatermark } =
    await prepareClaudeCall(userMessage, chatId, agentName, topicId, sessionModel(current.model), d, engineId);
  // Fortsetzungs-Prompt ist schlank; ein Wechsel auf einen anderen Motor braucht den vollen
  let promptIsFull = !resumeId;

  await sink.start();
  if (engineNotice) await sink.notice(engineNotice);

  // Streaming: Leerlauf-Grenze plus Obergrenze (Issue #178). JSON liefert erst
  // am Ende Ausgabe, dort bleibt es bei 30 Minuten Gesamtzeit.
  const limits = streaming ? d.resolveStreamingLimits() : undefined;
  const timeouts = limits
    ? { timeoutMs: limits.maxMs, idleTimeoutMs: limits.idleMs }
    : { timeoutMs: JSON_CALL_TIMEOUT_MS };

  let engine = d.getEngine(engineId);
  const baseOpts = () => ({
    streaming,
    ...(agentConfig?.allowedTools ? { allowedTools: agentConfig.allowedTools } : {}),
    ...(current.model ? { model: current.model } : {}),
    ...(current.effort ? { effort: current.effort } : {}),
    cwd: PROJECT_ROOT,
    abortKey: sessionKey, // /stop kills this subprocess
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
  const call = async (prompt: string, resumeSessionId?: string): Promise<EngineResult> => {
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
    arm();
    try {
      const request: EngineRequest = {
        prompt,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...baseOpts(),
        ...timeouts,
        ...(streaming ? streamCallbacks : {}),
      };
      return await engine.run(request);
    } finally {
      done = true;
      d.clearTimer(timer);
    }
  };

  const rebuildFullPrompt = async () => {
    ({ fullPrompt, fallbackContext } = await d.buildPromptContext({
      userMessage,
      chatId,
      agentName,
      topicId,
    }));
    promptIsFull = true;
  };

  /**
   * Der Motor meldet beim Lauf „nicht angemeldet" oder „nicht installiert",
   * obwohl die Prüfung bereit sagte (Entscheidung 0018, Issue #125): wie
   * beim Überspringen vor dem Turn antwortet Claude Code, mit einer Meldung
   * je Gespräch, frisch ohne Resume. Nicht nach Abbruch oder Zeitlimit.
   */
  const switchToClaude = async (failed: EngineResult): Promise<EngineResult> => {
    const from = failed.engine;
    console.warn(`[Motor] ${engineLabel(from)} meldet ${failed.errorKind} für ${conversationKey}, antworte mit Claude Code`);
    d.forgetEngineCheck();
    if (shouldNotifyUnavailable(conversationKey, from, "run")) {
      await sink.notice(unavailableNotice(from, unavailableReason(from, failed.errorKind)));
    }
    current = { engineId: "claude", ...engineModelAndEffort("claude", agentName, d) };
    engine = d.getEngine("claude");
    if (!promptIsFull) await rebuildFullPrompt();
    return await call(fullPrompt);
  };

  let result = await call(fullPrompt, resumeId);

  // Vom User abgebrochen (/stop): kein Retry, kein Fallback
  if (result.aborted) {
    await sink.finish();
    return ABORT_REPLY;
  }

  if (isEngineUnavailable(result)) {
    result = await switchToClaude(result);
    if (result.aborted) {
      await sink.finish();
      return ABORT_REPLY;
    }
  } else if (resumeId && !result.timedOut && (result.isError || !result.text)) {
    // Resume can fail (session file gone, CLI updated, context limit):
    // reset the session and retry once with a fresh full prompt. Not after a
    // timeout: that would burn another full window on the same task.
    console.warn(
      `[Session] ${streaming ? "streaming resume" : "resume"} failed for ${sessionKey}, retrying fresh`
    );
    await d.resetSession(sessionKey, agentName);
    await rebuildFullPrompt();
    result = await call(fullPrompt);
    if (!result.aborted && isEngineUnavailable(result)) result = await switchToClaude(result);
    if (result.aborted) {
      await sink.finish();
      return ABORT_REPLY;
    }
  }

  // Ein anderer Motor als Claude hat geantwortet: nachgewiesen wieder bereit,
  // ein späterer Ausfall wird erneut gemeldet (eine positive Vorprüfung allein reicht nicht)
  if (result.engine !== "claude" && !result.isError && !result.timedOut) markEngineRecovered(conversationKey, result.engine);

  const sessionStored = await finalizeClaudeSession(
    sessionKey,
    agentName,
    result,
    memoryWatermark,
    sessionModel(current.model),
    d,
    epoch
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
    console.warn(
      `${label} timeout${result.timeoutKind ? `/${result.timeoutKind}` : ""}, kein Fallback ` +
        `(steps=${result.steps?.length ?? "unbekannt"}, sessionId=${result.sessionId ? "ja" : "nein"})`
    );
    await d.log("warn", "bot", `${label} timeout, kein Fallback`, {
      timedOut: true,
      ...(result.timeoutKind ? { timeoutKind: result.timeoutKind } : {}),
      ...(result.stoppedAfterMs !== undefined ? { stoppedAfterMs: result.stoppedAfterMs } : {}),
      ...(result.idleForMs !== undefined ? { idleForMs: result.idleForMs } : {}),
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
      steps: secrets ? result.steps : result.steps?.map((step) => ({ name: step.name })),
      lastText: secrets ? result.lastText : undefined,
      // Nur wenn der Zeiger auf diese Session gespeichert wurde (finalizeClaudeSession
      // oben), setzt die nächste Nachricht sie fort; sonst kein Versprechen
      canResume: sessionStored,
      secrets: secrets ?? [],
    });
    // Werkzeuge des abgebrochenen Laufs: fremde Inhalte gelten auch hier
    reportTools(result.tools);
    report(undefined);
    return reply;
  }

  // Handle errors with fallback
  if (result.isError || !result.text) {
    console.error(
      `${label} error (text=${result.text?.length || 0} chars): [content omitted]`
    );
    await d.log("warn", "bot", `${label} failed, using fallback LLM`, {
      error: result.text?.substring(0, 200),
      timedOut: false,
      engine: result.engine,
      ...(result.errorKind ? { errorKind: result.errorKind } : {}),
    });
    // Nur bei anderen Motoren: Claude-Ausfälle bleiben still wie bisher
    if (result.engine !== "claude") await sink.notice(engineFailedNotice(result.engine, result.errorKind));

    // Was das Fallback-Modell an Werkzeugen nutzte, ist nicht bekannt
    reportTools(undefined);
    let fallback: FallbackResult;
    try {
      fallback = await d.callFallbackLLMWithSource(userMessage, fallbackContext);
    } catch (fallbackError) {
      console.error("Fallback LLM also failed:", fallbackError);
      report(undefined);
      return FALLBACK_FAILED_REPLY;
    }
    // Strukturierte Herkunft statt den "responded via"-Zusatz zu parsen
    report(fallback.source !== "none" ? fallback.model || fallback.source : undefined);
    return formatFallbackReply(fallback);
  }

  reportTools(result.tools);
  report(current.model, result.engine);
  return result.text;
}

/** Turn over the streaming subprocess: tool steps and first snippet as progress. */
export function runStreamingTurn(opts: TurnOptions): Promise<string> {
  return runTurn("streaming", opts);
}

/** Turn over the JSON subprocess: no progress, only notices. */
export function runJsonTurn(opts: TurnOptions): Promise<string> {
  return runTurn("json", opts);
}
