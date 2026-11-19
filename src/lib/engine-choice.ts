/**
 * Welcher Motor ein Gespräch bekommt (Entscheidung 0018, Issue #125).
 *
 * Vorrang: Ausnahme des Gesprächs (engine.topics in config/settings.json,
 * gesetzt mit /motor), dann agents.<id>.engine, dann engine.default, dann TYBO_ENGINE aus .env, dann
 * Claude Code. Ein Motor, der laut checkEngine nicht installiert oder nicht
 * angemeldet ist, wird übersprungen: dann antwortet Claude Code, mit einer
 * Log-Zeile bei jedem Turn und einer Meldung im Gespräch, einmal, bis der
 * Motor wieder bereit ist oder /motor neu gesetzt wird. Wurde der Ausfall
 * erst beim Lauf erkannt, zählt als bereit nur ein gelungener Lauf, nicht
 * schon eine positive Vorprüfung.
 *
 * Modell und Effort: für Claude pro Agent wie bisher (resolveAgentModel,
 * resolveAgentEffort), für Codex aus engine.codex, für OpenCode aus
 * engine.opencode (Variante als Effort, Issue #129); leer heißt, der Motor
 * nimmt seine eigene Konfiguration. Agenten-Modelle gehen nie an Codex oder
 * OpenCode. Die Anthropic API (Issue #347) nimmt Modell und Effort des
 * Agenten wie Claude Code, aber nur volle Modellnamen (claude-…); eine
 * Kurzform der CLI wird zum Standardmodell.
 *
 * Nur für Chat-Turns (Chat-Kern, Rückfragen). Hintergrund-Jobs, Check-in,
 * Aux-Modelle, WhatsApp und VPS-Modus bleiben bei Claude.
 */

import { checkEngine, type EngineId, type EngineStatus } from "./engines";
import { apiEffort, apiModel } from "./engines/api";
import {
  getSettings,
  engineBackups,
  engineAuto,
  updateSettings,
  OPENCODE_MODEL_PATTERN,
  SELECTABLE_ENGINES,
  type SelectableEngine,
  type Settings,
} from "./settings";
import { resolveAgentModel, resolveAgentEffort, settingsKey, type AgentResolveDeps } from "../agents/base";
import { getAgentConfigOrGeneral } from "../agents";
import type { EngineCommandServices } from "./commands/types";
import { applyMeasurement, expireBlocks, pickStage, stageBlock, stageId, syncAuto, turnOrder, type Stage, type StageId, type SkippedStage, type SwitchReady, type SwitchState, type SwitchUsage } from "./engine-switch";
import { readSwitchState, rememberSwitchHint, updateSwitchState } from "./engine-switch-state";
import { readUsage, type UsageReading } from "./engines/usage";
import { engineStageViews, type StageView } from "./engine-stage-view";
import { syncEngineAuto } from "./engine-auto-sync";
import { checkEnginesNow, type EngineCheckNowResult } from "./engine-check-now";
import { createToolParitySnapshot, type ToolParitySnapshot } from "./engines/tool-parity";

export { SELECTABLE_ENGINES, type SelectableEngine };

/** Anzeigename eines Motors in Meldungen und unter der Antwort */
export const ENGINE_LABELS: Record<EngineId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  api: "Anthropic API",
};

export function engineLabel(id: EngineId): string {
  return ENGINE_LABELS[id] ?? id;
}

/** Woher der Motor eines Gesprächs kommt */
export type EngineSource = "topic" | "agent" | "settings" | "env" | "code" | "auto";

export interface EngineChoiceDeps extends AgentResolveDeps {
  env: () => Record<string, string | undefined>;
  checkEngine: (id: EngineId) => Promise<EngineStatus>;
  log: (line: string) => void;
  now: () => number;
  readUsage: typeof readUsage;
  readSwitchState: typeof readSwitchState;
  updateSwitchState: typeof updateSwitchState;
  /** Vom Chat-Kern hereingereicht; Merken und Senden halten die Motorwahl nicht auf. */
  checkSwitch?: (statuses: Partial<Record<EngineId, EngineStatus>>, deps: EngineChoiceDeps) => void | Promise<void>;
}

const defaultDeps: EngineChoiceDeps = {
  getSettings,
  getAgentConfig: getAgentConfigOrGeneral,
  env: () => process.env,
  checkEngine,
  log: (line) => console.warn(line),
  now: Date.now,
  readUsage,
  readSwitchState,
  updateSwitchState,
};

function resolveDeps(deps?: Partial<EngineChoiceDeps>): EngineChoiceDeps {
  return deps ? { ...defaultDeps, ...deps } : defaultDeps;
}

export function isSelectableEngine(value: unknown): value is SelectableEngine {
  return typeof value === "string" && (SELECTABLE_ENGINES as readonly string[]).includes(value);
}

let warnedEnv: string | undefined;

/** TYBO_ENGINE aus .env; ein unbekannter Wert wird einmal geloggt und ignoriert */
function envEngine(d: EngineChoiceDeps, quiet = false): SelectableEngine | undefined {
  const raw = d.env().TYBO_ENGINE?.trim().toLowerCase();
  if (!raw) return undefined;
  if (isSelectableEngine(raw)) return raw;
  if (!quiet && warnedEnv !== raw) {
    warnedEnv = raw;
    d.log(`[Motor] TYBO_ENGINE="${raw.slice(0, 20)}" ist kein bekannter Motor (${SELECTABLE_ENGINES.join(", ")}), gilt Claude Code`);
  }
  return undefined;
}

/** Standard-Motor ohne Ausnahme: Einstellungsdatei, .env, Claude Code */
export function defaultEngineSetting(deps?: Partial<EngineChoiceDeps>, quiet = false): { engine: SelectableEngine; source: Exclude<EngineSource, "topic" | "agent" | "auto"> } {
  const d = resolveDeps(deps);
  const fromSettings = d.getSettings().engine?.default;
  if (fromSettings) return { engine: fromSettings, source: "settings" };
  const fromEnv = envEngine(d, quiet);
  if (fromEnv) return { engine: fromEnv, source: "env" };
  return { engine: "claude", source: "code" };
}

/** Allgemeine Reihenfolge ohne Gesprächswunsch; api bleibt ausschließlich an erster Stelle. */
export function generalOrder(deps?: Partial<EngineChoiceDeps>): Stage[] {
  const d = resolveDeps(deps);
  const settings = d.getSettings();
  const standard = { engine: defaultEngineSetting({ ...d, getSettings: () => settings }).engine };
  return turnOrder(undefined, standard, engineBackups(settings));
}

/** Eingestellter Motor eines Gesprächs, ohne Verfügbarkeitsprüfung */
export function configuredEngine(sessionKey: string, agentName: string, deps?: Partial<EngineChoiceDeps>, quiet = false): { engine: SelectableEngine; source: Exclude<EngineSource, "auto"> } {
  const d = resolveDeps(deps);
  const fromTopic = d.getSettings().engine?.topics?.[sessionKey];
  if (fromTopic) return { engine: fromTopic, source: "topic" };
  return agentEngineSetting(agentName, d, quiet);
}

/** Motor ohne Gesprächswahl: Agent (wie Modell und Effort aufgelöst), sonst Standard. */
export function agentEngineSetting(agentName: string, deps?: Partial<EngineChoiceDeps>, quiet = false): { engine: SelectableEngine; source: Exclude<EngineSource, "topic" | "auto"> } {
  const d = resolveDeps(deps);
  const engine = d.getSettings().agents?.[settingsKey(agentName)]?.engine;
  return engine ? { engine, source: "agent" } : defaultEngineSetting(d, quiet);
}

/** Ausnahme des Gesprächs (/motor), sonst undefined */
export function topicEngine(sessionKey: string, deps?: Partial<EngineChoiceDeps>): SelectableEngine | undefined {
  return resolveDeps(deps).getSettings().engine?.topics?.[sessionKey];
}

/** Woher eine Nichtverfügbarkeit bekannt ist: Vorprüfung (checkEngine) oder Lauf des Motors */
export type UnavailableOrigin = "check" | "run";

// Gespräche, die die Meldung „nicht verfügbar" für einen Motor schon bekommen haben, mit Herkunft
const notified = new Map<string, UnavailableOrigin>();
const noFreeNotified = new Set<string>();

/** Der Hinweis kommt erst nach einer beantwortenden Stufe erneut. */
export function shouldNotifyNoFreeStage(sessionKey: string): boolean {
  if (noFreeNotified.has(sessionKey)) return false;
  noFreeNotified.add(sessionKey);
  return true;
}

/**
 * true genau beim ersten Mal je Gespräch und Motor: dann gehört die Meldung
 * ins Gespräch. Ein beim Lauf erkannter Ausfall ("run") hält die Sperre auch
 * über positive Vorprüfungen hinweg, bis ein Lauf des Motors wieder gelingt
 * (markEngineRecovered). Eine Sperre aus der Vorprüfung hebt schon die
 * nächste positive Prüfung auf. /motor setzt alles zurück (resetEngineNotice).
 */
export function shouldNotifyUnavailable(sessionKey: string, engine: EngineId, origin: UnavailableOrigin = "check"): boolean {
  const key = `${sessionKey}\0${engine}`;
  const known = notified.get(key);
  if (known === undefined) {
    notified.set(key, origin);
    return true;
  }
  if (origin === "run") notified.set(key, "run");
  return false;
}

/** Positive Vorprüfung: behebt nur eine Nichtverfügbarkeit aus der Vorprüfung, nie einen Ausfall beim Lauf */
function markCheckReady(sessionKey: string, engine: EngineId): void {
  const key = `${sessionKey}\0${engine}`;
  if (notified.get(key) === "check") notified.delete(key);
}

/** Ein Lauf des Motors hat geantwortet: wieder bereit, ein späterer Ausfall wird erneut gemeldet */
export function markEngineRecovered(sessionKey: string, engine: EngineId): void {
  notified.delete(`${sessionKey}\0${engine}`);
  noFreeNotified.delete(sessionKey);
}

/** Nach /motor: die nächste Nichtverfügbarkeit wird wieder gemeldet */
export function resetEngineNotice(sessionKey: string): void {
  for (const key of [...notified.keys()]) if (key.startsWith(`${sessionKey}\0`)) notified.delete(key);
  rememberSwitchHint(sessionKey, undefined);
}

/** Nur für Tests: alle Meldungs-Sperren und die TYBO_ENGINE-Warnung zurücksetzen */
export function resetEngineChoiceForTests(): void {
  notified.clear();
  noFreeNotified.clear();
  misfitNotified.clear();
  warnedEnv = undefined;
}

/** Meldung im Gespräch, wenn ein Motor übersprungen wird */
export function unavailableNotice(engine: EngineId, reason?: string, answering: Stage = { engine: "claude" }): string {
  const base = `${engineLabel(engine)} ist nicht verfügbar, ich antworte mit ${stageLabel(answering)}.`;
  return reason ? `${base} ${reason}` : base;
}

export function stageLabel(stage: Stage): string {
  return `${engineLabel(stage.engine)}${stage.model ? ` mit ${stage.model}` : ""}`;
}

interface ResolvedCommon {
  /** Eingestellter Wunschmotor, unabhängig von der tatsächlich gewählten Stufe. */
  requested: SelectableEngine;
  source: EngineSource;
  /** Vollständige Reihenfolge, einmal zu Beginn des Turns bestimmt. */
  order: readonly Stage[];
  skipped: SkippedStage[];
  /** Nur bei geltender Regel, auch wenn Claude nicht in order vorkommt. */
  claudeReady?: boolean;
  /** Bereitschaft aller Motoren der Reihenfolge, für weitere Versuche im selben Turn. */
  ready?: SwitchReady;
}

export interface ResolvedStage extends ResolvedCommon {
  kind: "stage";
  /** Motor, mit dem der Turn läuft */
  engine: EngineId;
  /** Gewählte Stufe und ihre Kennung, bei Claude auch mit eigenem Modell. */
  stage: Stage;
  stageId: StageId;
  model?: string;
  effort?: string;
  reason?: string;
  /** Nur beim ersten Überspringen im Gespräch: Meldung für das Gespräch */
  notice?: string;
}

export interface NoFreeStage extends ResolvedCommon {
  kind: "none";
  freeAt?: string;
}

export type ResolvedEngine = ResolvedStage | NoFreeStage;

/** Ein unklarer Login darf eine bestehende Claude-Session nicht verwerfen. */
export function engineIsReady(engine: EngineId, status: EngineStatus): boolean {
  return status.installed && (status.loggedIn || (engine === "claude" && status.loginUnknown === true));
}

/** Versuche tragen aufgelöste Modelle; Codex und OpenCode haben nur eine Stufe je Motor. */
export function triedStageIds(order: readonly Stage[], modelOf: (stage: Stage) => string | undefined, tried: readonly Stage[]): Set<StageId> {
  return new Set(order.filter(stage => tried.some(attempt => attempt.engine === stage.engine
    && (stage.engine === "codex" || stage.engine === "opencode" || sessionModel(modelOf(stage)) === sessionModel(attempt.model))))
    .map(stageId));
}

export type EnginePreviewStage = StageView & {
  label: string;
  windows: readonly UsageReading[];
}

export interface EnginePreview {
  answering: EnginePreviewStage | null;
  role: "first" | "backup" | "manual" | "none";
  reason?: EnginePreviewStage;
  stages: EnginePreviewStage[];
  auto: ReturnType<typeof engineAuto>;
  earliestFree?: string;
  hasBackups: boolean;
  configured: ReturnType<typeof configuredEngine>;
  standard: ReturnType<typeof defaultEngineSetting>;
  /** Ohne Ersatzstufen ergänzt erst der Befehlsdienst die vollständige Verfügbarkeitsliste. */
  available: import("./commands/types").EngineAvailability[];
}

/** Ein ausgewerteter Zustand für beliebig viele Gespräche und Wunsch-Stufen. */
export interface EnginePreviewSnapshot {
  deps: EngineChoiceDeps;
  now: number;
  state: SwitchState | null;
  usage: SwitchUsage;
  ready: SwitchReady;
  available: EnginePreview["available"];
}

/** Nur lesen: Einstellungen, Uhr und Sperren einmal festhalten, jeden Motor einmal prüfen. */
export async function prepareEnginePreview(deps?: Partial<EngineChoiceDeps>): Promise<EnginePreviewSnapshot> {
  const resolved = resolveDeps(deps);
  const settings = resolved.getSettings();
  const now = resolved.now();
  const d = { ...resolved, getSettings: () => settings, now: () => now };
  const hasBackups = engineBackups(settings).length > 0;
  const auto = engineAuto(settings);
  const usage = hasBackups ? await d.readUsage(now) : { claude: [], codex: [], opencode: [], api: [] };
  const state = hasBackups
    ? applyMeasurement(syncAuto(expireBlocks(structuredClone(d.readSwitchState()), now), auto, usage, now), usage, now, auto)
    : null;
  const available = await Promise.all(SELECTABLE_ENGINES.map(async engine => {
    let status: EngineStatus;
    try { status = await d.checkEngine(engine); }
    catch { status = { engine, checked: true, installed: false, loggedIn: false }; }
    const ready = engineIsReady(engine, status);
    return { engine, label: engineLabel(engine), ready, ...(!ready && status.message ? { message: status.message } : {}) };
  }));
  const ready = Object.fromEntries(available.map(status => [status.engine, status])) as unknown as SwitchReady;
  return { deps: d, now, usage, state, ready, available };
}

/** Zustand genau der Wunsch-Stufe, reine Logik auf dem gemeinsamen Snapshot. */
export function previewEngineChoice(wish: Stage, agentName: string, snapshot: EnginePreviewSnapshot, answering: EnginePreviewStage | null): StageView {
  const model = wish.model ?? engineModelAndEffort(wish.engine, agentName, snapshot.deps).model;
  const base = { id: stageId(wish), engine: wish.engine, ...(model ? { model } : {}) };
  const status = snapshot.ready[wish.engine];
  if (!status.ready) return { ...base, state: "not_ready", ...(status.message ? { message: status.message } : {}) };
  const block = snapshot.state && stageBlock(wish, model, snapshot.state, snapshot.now);
  if (block) return { ...base, state: "blocked", cause: block.cause, blockedUntil: block.until, resetKnown: block.resetKnown,
    ...(block.window ? { window: block.window } : {}) };
  return { ...base, state: answering?.id === base.id && answering.model === model ? "answering" : "free" };
}

/** Wie die nächste Turn-Wahl, aber ohne Schreiben, Hinweise, Meldungen oder Sessions. */
export async function previewEngine(sessionKey: string, agentName: string, deps?: Partial<EngineChoiceDeps>, snapshot?: EnginePreviewSnapshot): Promise<EnginePreview> {
  const resolved = snapshot?.deps ?? resolveDeps(deps);
  const settings = resolved.getSettings();
  const d = { ...resolved, getSettings: () => settings };
  const configured = configuredEngine(sessionKey, agentName, d, true);
  const standard = defaultEngineSetting(d, true);
  const backups = engineBackups(settings);
  const auto = engineAuto(settings);
  const order = turnOrder({ engine: configured.engine }, { engine: standard.engine }, backups);
  const modelOf = (stage: Stage) => stage.model ?? engineModelAndEffort(stage.engine, agentName, d).model;
  const inspect = async (engine: EngineId): Promise<EngineStatus> => {
    try { return await d.checkEngine(engine); }
    catch { return { engine, checked: true, installed: false, loggedIn: false }; }
  };
  const base = { configured, standard, hasBackups: backups.length > 0, auto };
  if (!backups.length) {
    // Keine Mess-/Zustandsdatei, keine Claude-Prüfung, wie im alten Turn-Pfad.
    const status = configured.engine === "claude" ? undefined : await inspect(configured.engine);
    const unavailable = status && !(status.installed && status.loggedIn);
    const engine = unavailable ? "claude" : configured.engine;
    const stages = order.map((stage): EnginePreviewStage => ({
      id: stageId(stage), engine: stage.engine, label: engineLabel(stage.engine), model: modelOf(stage), windows: [],
      state: stage.engine === engine ? "answering" : unavailable && stage.engine === configured.engine ? "not_ready" : "free",
      ...(unavailable && stage.engine === configured.engine && status.message ? { message: status.message } : {}),
    }));
    const answering: EnginePreviewStage = stages.find(stage => stage.engine === engine) ?? {
      id: engine, engine, label: engineLabel(engine), model: modelOf({ engine }), windows: [], state: "answering",
    };
    return { ...base, stages, answering, available: [],
      role: unavailable ? "backup" : configured.source === "topic" ? "manual" : "first",
      ...(unavailable ? { reason: stages[0] } : {}),
    };
  }
  const { now, usage, state, available, ready } = snapshot ?? await prepareEnginePreview(d);
  const view = engineStageViews(order, modelOf, state!, ready, now);
  const stages = view.stages.map(stage => ({ ...stage, label: engineLabel(stage.engine), windows: usage[stage.engine] }));
  const { picked } = view;
  const answering = picked.kind === "stage" ? stages[picked.index] : null;
  return { ...base, stages, answering, available,
    role: !answering ? "none" : picked.kind === "stage" && picked.index > 0 ? "backup" : configured.source === "topic" ? "manual" : "first",
    ...(picked.skipped.length ? { reason: stages[picked.skipped[0].index] } : {}),
    ...(picked.kind === "none" && picked.freeAt ? { earliestFree: picked.freeAt } : {}),
  };
}

/**
 * Mit Ersatzstufen: erste freie und bereite Stufe nach der Wechselregel.
 * Ohne Ersatzstufen bleibt die bisherige Wahl: Claude ohne Vorprüfung,
 * andere Motoren über checkEngine und bei Nichtverfügbarkeit Claude Code.
 */
export async function resolveEngine(sessionKey: string, deps: Partial<EngineChoiceDeps> | undefined, turn: { agentName: string; tried?: readonly Stage[] }): Promise<ResolvedEngine> {
  const resolved = resolveDeps(deps);
  const settings = resolved.getSettings();
  const d = { ...resolved, getSettings: () => settings };
  const { engine: requested, source } = configuredEngine(sessionKey, turn.agentName, d);
  const backups = engineBackups(settings);
  const order = turnOrder({ engine: requested }, { engine: defaultEngineSetting(d).engine }, backups);
  if (backups.length) {
    const now = d.now();
    const auto = engineAuto(settings);
    const usage = await d.readUsage(now);
    const { state } = await d.updateSwitchState(state =>
      applyMeasurement(syncAuto(expireBlocks(state, now), auto, usage, now), usage, now, auto));
    const ready: Record<EngineId, SwitchReady[EngineId]> = {
      claude: { ready: false }, codex: { ready: false }, opencode: { ready: false }, api: { ready: false },
    };
    const statuses: Partial<Record<EngineId, EngineStatus>> = {};
    await Promise.all([...new Set<EngineId>([...order.map(stage => stage.engine), ...generalOrder(d).map(stage => stage.engine), "claude"])].map(async engine => {
      try {
        const status = await d.checkEngine(engine);
        statuses[engine] = status;
        ready[engine] = { ready: engineIsReady(engine, status),
          ...(status.message ? { message: status.message } : {}) };
      } catch { /* Eine werfende Prüfung gilt als nicht bereit. */ }
      if (ready[engine].ready) markCheckReady(sessionKey, engine);
    }));
    // Nur Bereitschaft weiterreichen, keine Auswahl, tried-Liste oder Agenten-Modelle.
    void Promise.resolve().then(() => d.checkSwitch?.(statuses, d)).catch(() => {
      try { d.log("[Motor] Wechselprüfung fehlgeschlagen; der Turn läuft weiter."); } catch { /* Log ist optional. */ }
    });
    const modelOf = (stage: Stage) => stage.model ?? engineModelAndEffort(stage.engine, turn.agentName, d).model;
    const picked = pickStage(order, modelOf, state, ready, now, triedStageIds(order, modelOf, turn.tried ?? []));
    const common = { requested, source, order, skipped: picked.skipped, ready, claudeReady: ready.claude.ready };
    if (picked.kind === "none") return { ...common, kind: "none", ...(picked.freeAt ? { freeAt: picked.freeAt } : {}) };
    const { stage } = picked;
    const unavailable = picked.skipped.find(skipped => skipped.reason === "not_ready");
    if (unavailable?.reason === "not_ready") {
      d.log(`[Motor] ${stageLabel(unavailable.stage)} für ${sessionKey} nicht bereit, antworte mit ${stageLabel(stage)}`);
    }
    const reason = picked.skipped.map(skipped => `${stageLabel(skipped.stage)}: ${skipped.reason === "blocked"
      ? `${skipped.block.cause}${skipped.block.window || skipped.block.family || skipped.block.model
        ? ` (${skipped.block.window ?? skipped.block.family ?? skipped.block.model})` : ""}`
      : skipped.reason === "tried" ? "bereits versucht" : "nicht bereit"}`).join("; ");
    return { ...common, kind: "stage", engine: stage.engine, stage, stageId: stageId(stage),
      ...engineModelAndEffort(stage.engine, turn.agentName, d, stage, d.log),
      source: picked.index > 0 ? "auto" : source, ...(reason ? { reason } : {}) };
  }
  // Ohne Ersatzstufen: keine Zustands-/Messdatei und keine Claude-Prüfung.
  const legacy = (engine: EngineId): ResolvedStage => ({ kind: "stage", engine, requested, source,
    stage: { engine }, stageId: engine, order, skipped: [] });
  if (requested === "claude") return legacy("claude");
  let status: EngineStatus;
  try {
    status = await d.checkEngine(requested);
  } catch {
    status = { engine: requested, checked: true, installed: false, loggedIn: false };
  }
  if (status.installed && status.loggedIn) {
    markCheckReady(sessionKey, requested);
    return legacy(requested);
  }
  d.log(`[Motor] ${engineLabel(requested)} für ${sessionKey} nicht bereit (${status.message ?? "nicht installiert oder nicht angemeldet"}), antworte mit Claude Code`);
  const notice = shouldNotifyUnavailable(sessionKey, requested) ? unavailableNotice(requested, status.message) : undefined;
  return { ...legacy("claude"), ...(notice ? { notice } : {}) };
}

/**
 * Modell und Effort eines Turns je Motor. Claude: pro Agent (Einstellungen,
 * CLAUDE_EFFORT, Agenten-Datei). Codex: engine.codex, OpenCode:
 * engine.opencode (model, variant als Effort); fehlt ein Wert, entscheidet
 * die Konfiguration des Motors (kein Modell erfunden).
 */
export function engineModelAndEffort(
  engine: EngineId,
  agentName: string,
  deps: Partial<AgentResolveDeps> = {},
  stage?: Stage,
  log: (line: string) => void = console.warn,
): { model?: string; effort?: string } {
  const getS = deps.getSettings ?? getSettings;
  if (engine === "claude") {
    const own = stage?.engine === "claude" ? stage : undefined;
    const model = own?.model ?? resolveAgentModel(agentName, deps);
    let effort = own?.effort ?? resolveAgentEffort(agentName, deps);
    if (own?.model || own?.effort) effort = claudeStageEffort(model, effort, log);
    return { model, ...(effort ? { effort } : {}) };
  }
  if (engine === "codex") {
    const codex = getS().engine?.codex;
    return { ...(codex?.model ? { model: codex.model } : {}), ...(codex?.effort ? { effort: codex.effort } : {}) };
  }
  if (engine === "api") {
    const effort = apiEffort(resolveAgentEffort(agentName, deps));
    return { model: apiModel(resolveAgentModel(agentName, deps)), ...(effort ? { effort } : {}) };
  }
  if (engine === "opencode") {
    const opencode = getS().engine?.opencode;
    return { ...(opencode?.model ? { model: opencode.model } : {}), ...(opencode?.variant ? { effort: opencode.variant } : {}) };
  }
  return {};
}

/**
 * Feste Kompatibilitätsregel für Ersatzstufen, keine Modellprobe im Chat.
 * Stand 17.11.2026: code.claude.com/docs/en/model-config#adjust-effort-level.
 * Opus 5.5 erlaubt max. Bei unbekannten Modellen bleiben wir höchstens bei high.
 * Normale Agenten-Aufrufe behalten ihre bisherige Effort-Wahl.
 */
function claudeStageEffort(model: string, effort: string | undefined, log: (line: string) => void): string | undefined {
  if (effort !== "max" && effort !== "xhigh") return effort;
  const name = model.toLowerCase().replace(/^claude-/, "").replace(/\[1m\]$/, "").replaceAll(".", "-");
  const allLevels = /^(?:fable(?:-5(?:-[12])?)?|opus(?:-5(?:-5)?|-4-[78])?|sonnet(?:-5(?:-5)?)?|haiku(?:-5-5)?)$/.test(name);
  const maxWithoutXhigh = /^(?:opus|sonnet)-4-6$/.test(name);
  if (allLevels || (maxWithoutXhigh && effort === "max")) return effort;
  log(`[Motor] Ersatzstufe Claude Code mit ${model}: Effort ${effort} nicht bestätigt, verwende high.`);
  return "high";
}

/** Claude-Modelle: Namen mit claude- oder eine Kurzform der CLI, auch mit „[1m]" */
const CLAUDE_MODEL_NAME = /^(?:claude-[\w.-]+|opus|sonnet|haiku|fable)(?:\[1m\])?$/i;
/** Volle Claude-Namen, wie sie die Anthropic API annimmt (API_MODEL in engines/api.ts) */
const API_MODEL_NAME = /^claude-[a-z0-9][\w.-]*$/;
/** Wie MODEL in engines/codex.ts, aber ohne Schrägstrich: der trennt bei OpenCode Anbieter und Modell */
const CODEX_MODEL_NAME = /^[A-Za-z0-9][\w.:-]*$/;

/**
 * Passt ein Modellname der Form nach zu einem Motor (Issue #249, Modell für
 * gesprochene Fragen)? Es gibt keine gemeinsame Modell-Liste aller Motoren,
 * deshalb entscheidet die Form: Claude-Namen (claude-…, opus, sonnet, haiku,
 * fable) gehören zu Claude Code, volle claude-Namen auch zur Anthropic API, <anbieter>/<modell> zu OpenCode, jeder
 * andere Name ohne Schrägstrich zu Codex. Ein unpassendes Modell geht nie an
 * den Motor: der lehnte den Lauf sonst ab.
 */
export function modelFitsEngine(engine: EngineId, model: string): boolean {
  const claude = CLAUDE_MODEL_NAME.test(model);
  if (engine === "claude") return claude;
  if (engine === "opencode") return !claude && model.includes("/") && OPENCODE_MODEL_PATTERN.test(model);
  if (engine === "codex") return !claude && CODEX_MODEL_NAME.test(model);
  if (engine === "api") return API_MODEL_NAME.test(model);
  return false;
}

// Gespräche, die den Hinweis „Modell passt nicht zum Motor" für genau dieses Modell schon bekommen haben
const misfitNotified = new Set<string>();

/**
 * true genau beim ersten Mal je Gespräch, Motor und Modell: dann gehört der
 * Hinweis ins Gespräch. Nur im Speicher; nach einem Neustart oder mit einem
 * anderen Modell oder Motor kommt er einmal wieder.
 */
export function shouldNotifyModelMisfit(sessionKey: string, engine: EngineId, model: string): boolean {
  const key = `${sessionKey}\0${engine}\0${model}`;
  if (misfitNotified.has(key)) return false;
  misfitNotified.add(key);
  return true;
}

/** Hinweis im Gespräch, wenn das Modell für gesprochene Fragen nicht zum Motor passt */
export function modelMisfitNotice(engine: EngineId, model: string): string {
  return `Das Modell für gesprochene Fragen (${model}) passt nicht zu ${engineLabel(engine)}, ich antworte mit dem Modell des Gesprächs.`;
}

/**
 * Modell, unter dem eine Session gespeichert wird (BotSession.model ist ein
 * Pflichtfeld): das Modell selbst oder "" für den Standard des Motors.
 */
export function sessionModel(model: string | undefined): string {
  return model ?? "";
}

/** Ausnahme für ein Gespräch setzen (engine) oder entfernen (null), in der Schreibkette der Einstellungen */
export async function setTopicEngine(sessionKey: string, engine: SelectableEngine | null): Promise<void> {
  await updateSettings((current) => {
    const section = { ...(current.engine ?? {}) };
    const topics = { ...(section.topics ?? {}) };
    if (engine) topics[sessionKey] = engine;
    else delete topics[sessionKey];
    if (Object.keys(topics).length) section.topics = topics;
    else delete section.topics;
    const next = { ...current };
    if (Object.keys(section).length) next.engine = section;
    else delete next.engine;
    return next;
  });
  resetEngineNotice(sessionKey);
}

/**
 * /motor in allen Kanälen (CommandServices.engines, Issue #125); Tests reichen
 * eine Prüf-Attrappe herein. available() zeigt seit Issue #567 auch für
 * Claude Code den echten Stand (installiert, angemeldet).
 */
export function createEngineCommandServices(deps?: Partial<EngineChoiceDeps> & {
  toolSnapshot?: () => ToolParitySnapshot;
  checkNow?: () => Promise<EngineCheckNowResult>;
  updateSettings?: typeof updateSettings;
}): EngineCommandServices {
  const d = resolveDeps(deps);
  const snapshots = new WeakMap<object, ToolParitySnapshot>();
  const preview = async (sessionKey: string, agent: string, statuses: EngineCheckNowResult["statuses"] = {}): Promise<EnginePreview> => {
    const checked = new Map<EngineId, Promise<EngineStatus>>(Object.entries(statuses).map(([id, status]) => [id as EngineId, Promise.resolve(status)]));
    const checkOnce = (id: EngineId) => {
      if (!checked.has(id)) checked.set(id, Promise.resolve().then(() => d.checkEngine(id))
        .catch(() => ({ engine: id, checked: true, installed: false, loggedIn: false })));
      return checked.get(id)!;
    };
    const result = await previewEngine(sessionKey, agent, { ...d, checkEngine: checkOnce });
    if (!result.hasBackups) result.available = await available(checkOnce);
    return result;
  };
  const available = (check: EngineChoiceDeps["checkEngine"]) => Promise.all(SELECTABLE_ENGINES.map(async engine => {
    let status: EngineStatus;
    try { status = await check(engine); }
    catch { status = { engine, checked: true, installed: false, loggedIn: false }; }
    const ready = status.installed && status.loggedIn;
    return { engine, label: engineLabel(engine), ready, ...(!ready && status.message ? { message: status.message } : {}) };
  }));
  return {
    preview,
    async setAuto(enabled) {
      await (deps?.updateSettings ?? updateSettings)(current => ({ ...current,
        engine: { ...current.engine, auto: { ...current.engine?.auto, enabled } },
      }));
      const runtime = { readSettings: d.getSettings, readState: d.readSwitchState, updateState: d.updateSwitchState,
        readUsage: d.readUsage, now: d.now };
      await syncEngineAuto(runtime);
      const settings = d.getSettings();
      const auto = engineAuto(settings);
      if (enabled) {
        const now = d.now();
        const usage = await d.readUsage(now);
        await d.updateSwitchState(state => applyMeasurement(state, usage, now, auto));
      }
      return { enabled: settings.engine?.auto?.enabled === true, auto, hasBackups: engineBackups(settings).length > 0 };
    },
    async check(sessionKey, agent) {
      const result = await (deps?.checkNow ?? checkEnginesNow)();
      return { ...result, preview: await preview(sessionKey, agent, result.statuses) };
    },
    ...(deps?.toolSnapshot ? { tools(engine: EngineId, request: object = {}) {
      let snapshot = snapshots.get(request);
      if (!snapshot) { snapshot = deps.toolSnapshot!(); snapshots.set(request, snapshot); }
      return { inventory: snapshot.inventory(engine), gaps: snapshot.gaps(engine) };
    } } : {}),
    configured: (sessionKey, agent) => configuredEngine(sessionKey, agent, d),
    standard: () => defaultEngineSetting(d),
    inherited: agent => agentEngineSetting(agent, d),
    available: () => available(d.checkEngine),
    async setTopic(sessionKey, engine) {
      if (engine !== null && !isSelectableEngine(engine)) throw new Error("Unbekannter Motor");
      await setTopicEngine(sessionKey, engine);
    },
  };
}

export const engineCommandServices: EngineCommandServices = createEngineCommandServices({ toolSnapshot: createToolParitySnapshot });
