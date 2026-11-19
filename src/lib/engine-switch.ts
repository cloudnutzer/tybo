/**
 * engine-switch: reine Wechselregel (M14-03, Entscheidung 0027).
 *
 * Zeit im Zustand und in Ergebnissen: ISO-Zeichenketten wie measuredAt und
 * resetsAt; now: Unix-Millisekunden. Keine eigene Uhr und keine Ablage.
 * Eingaben sind geprüfte Daten; unbekannte Zustandsfelder bleiben erhalten.
 * model ist das aufgelöste Standardmodell, stage.model geht vor. Ohne Familie
 * gilt das genaue Modell, ohne Modell der ganze Motor; api sperrt motorweit.
 * ready enthält fertige Prüfergebnisse, niemals asynchrone Prüfungen.
 * returnBelow muss endlich und kleiner als threshold sein (sonst RangeError).
 * Limit-Belege verbinden usage und rateLimit.windows: jüngste Messung je
 * Fenster, bei Gleichstand die des Laufs. Zukünftige Messungen belegen nichts.
 * pickStage: not_ready vor blocked vor tried; api nur an erster Position
 * (Wunsch), spätere api-Einträge werden wie in turnOrder verworfen.
 */
import type { EngineId, EngineRateLimit } from "./engines/types";
import { rateLimitWindowId, type UsageReading, type UsageWindowId } from "./engines/usage";

export interface Stage {
  readonly engine: EngineId;
  readonly model?: string;
  readonly effort?: string;
}

export type StageId = EngineId | `claude:${string}`;
export type ModelFamily = "fable" | "opus" | "sonnet" | "haiku";

export { formatSwitchTime } from "./engine-switch-text";
export type SwitchUsage = Readonly<Record<EngineId, readonly UsageReading[]>>;
export interface SwitchAuto {
  readonly enabled: boolean;
  readonly threshold: number;
  readonly returnBelow: number;
}
export type SwitchReady = Readonly<Record<EngineId, { readonly ready: boolean; readonly message?: string }>>;

/** Höchstens eine Reichweite; ohne Angabe gilt der ganze Motor. */
export type BlockScope =
  | { readonly window: UsageWindowId; readonly family?: never; readonly model?: never }
  | { readonly window?: never; readonly family: ModelFamily; readonly model?: never }
  | { readonly window?: never; readonly family?: never; readonly model: string }
  | { readonly window?: never; readonly family?: never; readonly model?: never };

export type SwitchBlock = BlockScope & {
  readonly engine: EngineId;
  readonly cause: "threshold" | "limit" | "outage";
  readonly since: string;
  readonly until: string;
  readonly resetKnown: boolean;
  readonly percent?: number;
};

export interface FailureCounter {
  readonly engine: EngineId;
  readonly kind: "limit" | "outage";
  readonly scope: string;
  readonly count: number;
  readonly lastAt: string;
}

export interface SwitchState {
  readonly version: 1;
  readonly blocks: readonly SwitchBlock[];
  readonly counters: readonly FailureCounter[];
  readonly released?: Readonly<Partial<Record<EngineId, string>>>;
  readonly auto?: SwitchAuto;
  readonly notices?: SwitchNotices;
  readonly [field: string]: unknown;
}

export interface PendingSwitchNotice {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly attempts: number;
  readonly nextAt: string;
  readonly claimedAt?: string;
}

export interface SwitchHint {
  readonly stage: StageId;
  readonly at: string;
  /** Alte Einträge ohne Agent gehören zum bisherigen Standardagenten. */
  readonly agent?: string;
}

export interface SwitchNotices {
  readonly announced?: StageId | "none";
  readonly left?: Readonly<Partial<Record<StageId, SwitchBlock["cause"]>>>;
  readonly outageNoticeAt?: Readonly<Partial<Record<EngineId, string>>>;
  readonly pending?: readonly PendingSwitchNotice[];
  readonly hinted?: Readonly<Record<string, SwitchHint>>;
}

export interface LimitEvidence {
  readonly window: UsageWindowId;
  readonly resetsAt?: string;
}

export interface SwitchFailure {
  readonly stage: Stage;
  readonly model?: string;
  readonly kind: "limit" | "outage";
  readonly evidence?: LimitEvidence;
}

export type SkippedStage = { stage: Stage; index: number } & (
  | { reason: "not_ready"; message?: string }
  | { reason: "blocked"; block: SwitchBlock }
  | { reason: "tried" }
);
export type StagePick =
  | { kind: "stage"; stage: Stage; index: number; skipped: SkippedStage[] }
  | { kind: "none"; skipped: SkippedStage[]; freeAt?: string };

/** Modell und Effort eigener Ersatzstufen gelten nur bei Claude Code. */
export function stageId(stage: Stage): StageId {
  return stage.engine === "claude" && stage.model ? `claude:${stage.model}` : stage.engine;
}

/** api ist nur als Wunsch zulässig, auch wenn es als Standard eingestellt ist. */
export function turnOrder(wish: Stage | undefined, standard: Stage, backups: readonly Stage[]): Stage[] {
  const first = wish ?? standard;
  const order: Stage[] = [{ ...first }];
  for (const stage of [standard, ...backups]) {
    if (stage.engine === "api") continue;
    if (order.some(previous => stageId(previous) === stageId(stage)
      || (!stage.model && previous.engine === stage.engine))) continue;
    order.push({ ...stage });
  }
  return order;
}

/** Voller Claude-Name (auch alte Versionspräfixe), Kurzform und [1m]. */
export function modelFamily(model: string | undefined): ModelFamily | undefined {
  return model?.trim().match(/^(?:claude-)?(?:\d+(?:[.-]\d+)*-)?(fable|opus|sonnet|haiku)(?=[.\-\[]|$)/i)
    ?.[1].toLowerCase() as ModelFamily | undefined;
}

export function windowCounts(stage: Stage, model: string | undefined, windowId: UsageWindowId): boolean {
  if (stage.engine === "codex") return true;
  if (stage.engine !== "claude") return false;
  if (windowId === "weekly_all" || windowId === "session" || windowId.startsWith("window_")) return true;
  const family = modelFamily(stage.model ?? model);
  return family !== undefined && windowId.startsWith("weekly_scoped:")
    && windowId.slice("weekly_scoped:".length).toLowerCase().split(/[^a-z0-9]+/).includes(family);
}

const MINUTE = 60_000;
const iso = (time: number): string => new Date(time).toISOString();

function assertAuto(auto: SwitchAuto): void {
  if (!Number.isFinite(auto.threshold) || !Number.isFinite(auto.returnBelow) || auto.returnBelow >= auto.threshold) {
    throw new RangeError("Schwelle und Rückkehrschwelle müssen endlich sein; Rückkehrschwelle muss kleiner sein.");
  }
}

function latestReadings(readings: readonly UsageReading[]): Map<UsageWindowId, UsageReading> {
  const latest = new Map<UsageWindowId, UsageReading>();
  for (const reading of readings) {
    const previous = latest.get(reading.id);
    if (!previous || Date.parse(reading.measuredAt) >= Date.parse(previous.measuredAt)) latest.set(reading.id, reading);
  }
  return latest;
}

/** usage kann vor now gelesen worden sein: auch known erneut auf Ablauf prüfen. */
function isKnown(reading: UsageReading | undefined, now: number): reading is Extract<UsageReading, { state: "known" }> {
  return reading?.state === "known" && (reading.resetsAt === undefined || Date.parse(reading.resetsAt) > now);
}

function sameScope(left: SwitchBlock, right: SwitchBlock): boolean {
  return left.engine === right.engine && left.cause === right.cause
    && left.window === right.window && left.family === right.family && left.model === right.model;
}

/** Neue Messungen lösen nur Fenstersperren; fehlende/abgelaufene Werte lösen nichts. */
export function applyMeasurement(state: SwitchState, usage: SwitchUsage, now: number, auto: SwitchAuto): SwitchState {
  assertAuto(auto);
  let blocks = [...state.blocks];
  for (const engine of Object.keys(usage) as EngineId[]) {
    if (engine === "opencode" || engine === "api") continue;
    const latest = latestReadings(usage[engine]);
    blocks = blocks.filter(block => {
      if (block.engine !== engine || block.cause === "outage" || !block.window) return true;
      const reading = latest.get(block.window);
      return !(isKnown(reading, now) && Date.parse(reading.measuredAt) > Date.parse(block.since)
        && reading.percent < auto.returnBelow);
    });
    if (!auto.enabled) continue;
    for (const reading of latest.values()) {
      if (!isKnown(reading, now) || reading.percent < auto.threshold) continue;
      const released = state.released?.[engine];
      if (released !== undefined && Date.parse(reading.measuredAt) < Date.parse(released)) continue;
      const until = reading.resetsAt ?? iso(Date.parse(reading.measuredAt) + 60 * MINUTE);
      if (Date.parse(until) <= now) continue;
      const existing = blocks.findIndex(block => block.engine === engine && block.cause === "threshold"
        && block.window === reading.id);
      if (existing >= 0) {
        // since bleibt; resetKnown folgt der Herkunft der nachgeführten Endzeit.
        blocks[existing] = { ...blocks[existing], percent: reading.percent, until, resetKnown: reading.resetsAt !== undefined };
      } else {
        blocks.push({ engine, cause: "threshold", window: reading.id, since: iso(now), until,
          resetKnown: reading.resetsAt !== undefined, percent: reading.percent });
      }
    }
  }
  return { ...state, blocks };
}

export interface LimitEvidenceInput {
  readonly stage: Stage;
  readonly model?: string;
  readonly rateLimit?: EngineRateLimit;
  readonly usage: SwitchUsage;
  readonly now: number;
}

/** Nur ein ausdrückliches rejected oder genau ein frisches, volles Fenster ist ein Beleg. */
export function limitEvidence({ stage, model, rateLimit, usage, now }: LimitEvidenceInput): LimitEvidence | undefined {
  const reported = rateLimitWindowId(rateLimit?.rateLimitType);
  if (rateLimit?.status === "rejected" && reported && windowCounts(stage, model, reported)) {
    return { window: reported, ...(rateLimit.resetsAt && Date.parse(rateLimit.resetsAt) > now
      ? { resetsAt: rateLimit.resetsAt } : {}) };
  }
  const readings = latestReadings([
    ...usage[stage.engine],
    ...(rateLimit?.windows ?? []).map(window => ({ ...window, state: "known" as const })),
  ]);
  const full = [...readings.values()].filter(reading => {
    const age = now - Date.parse(reading.measuredAt);
    return isKnown(reading, now) && reading.percent === 100 && age >= 0 && age <= 10 * MINUTE
      && windowCounts(stage, model, reading.id);
  });
  if (full.length !== 1) return undefined;
  const reading = full[0];
  return { window: reading.id, ...(reading.resetsAt ? { resetsAt: reading.resetsAt } : {}) };
}

function limitScope(stage: Stage, model: string | undefined): { scope: string; block: BlockScope } {
  if (stage.engine !== "claude") return { scope: stage.engine, block: {} };
  const resolvedModel = stage.model ?? model;
  const family = modelFamily(resolvedModel);
  if (family) return { scope: family, block: { family } };
  if (resolvedModel) return { scope: resolvedModel, block: { model: resolvedModel } };
  return { scope: stage.engine, block: {} };
}

/** Exponent vor dem Rechnen begrenzen, unabhängig vom weiterlaufenden Fehlerzähler. */
function pauseMinutes(kind: SwitchFailure["kind"], count: number): number {
  const first = kind === "limit" ? 60 : 10;
  const maximum = kind === "limit" ? 360 : 60;
  return Math.min(maximum, first * 2 ** Math.min(3, count - 1));
}

export function applyFailure(state: SwitchState, failure: SwitchFailure, now: number): SwitchState {
  const { stage, model, kind } = failure;
  const scope = kind === "outage" ? { scope: stage.engine, block: {} } : limitScope(stage, model);
  const sameCounter = (counter: FailureCounter) => counter.engine === stage.engine && counter.kind === kind
    && counter.scope === scope.scope;
  const count = (state.counters.find(sameCounter)?.count ?? 0) + 1;
  const counters = [...state.counters.filter(counter => !sameCounter(counter)),
    { engine: stage.engine, kind, scope: scope.scope, count, lastAt: iso(now) }];
  const evidence = kind === "limit" && failure.evidence && windowCounts(stage, model, failure.evidence.window)
    ? failure.evidence : undefined;
  const reset = evidence?.resetsAt && Date.parse(evidence.resetsAt) > now ? evidence.resetsAt : undefined;
  const block: SwitchBlock = {
    engine: stage.engine, cause: kind, ...(evidence ? { window: evidence.window } : scope.block),
    since: iso(now), until: reset ?? iso(now + pauseMinutes(kind, count) * MINUTE), resetKnown: reset !== undefined,
  };
  return { ...state, counters, blocks: [...state.blocks.filter(previous => !sameScope(previous, block)), block] };
}

export function applySuccess(state: SwitchState, stage: Stage, model: string | undefined): SwitchState {
  const { scope } = limitScope(stage, model);
  return { ...state, counters: state.counters.filter(counter => counter.engine !== stage.engine
    || (counter.kind === "limit" && counter.scope !== scope)) };
}

export function expireBlocks(state: SwitchState, now: number): SwitchState {
  return { ...state, blocks: state.blocks.filter(block => Date.parse(block.until) > now) };
}

/** Bei mehreren treffenden Sperren ist erst das späteste Ende eine Freigabe. */
export function stageBlock(stage: Stage, model: string | undefined, state: SwitchState, now: number): SwitchBlock | undefined {
  let latest: SwitchBlock | undefined;
  const resolvedModel = stage.model ?? model;
  for (const block of state.blocks) {
    if (block.engine !== stage.engine || Date.parse(block.until) <= now) continue;
    if (block.window && !windowCounts(stage, model, block.window)) continue;
    if (block.family && block.family !== modelFamily(resolvedModel)) continue;
    if (block.model && block.model !== resolvedModel) continue;
    if (!latest || Date.parse(block.until) > Date.parse(latest.until)) latest = block;
  }
  return latest;
}

/** Nebenaufgaben beachten Limits, aber keine Ausfälle des Motors. */
export function claudeBlockedFor(state: SwitchState, model: string, now: number): string | undefined {
  const limits = { ...state, blocks: state.blocks.filter(block => block.cause !== "outage") };
  return stageBlock({ engine: "claude" }, model, limits, now)?.until;
}

export function pickStage(
  order: readonly Stage[], modelOf: (stage: Stage) => string | undefined, state: SwitchState,
  ready: SwitchReady, now: number, tried: ReadonlySet<StageId> = new Set(),
): StagePick {
  const skipped: SkippedStage[] = [];
  let freeAt: string | undefined;
  for (const [index, stage] of order.entries()) {
    if (stage.engine === "api" && index !== 0) continue;
    const status = ready[stage.engine];
    if (!status.ready) {
      skipped.push({ stage, index, reason: "not_ready", ...(status.message ? { message: status.message } : {}) });
      continue;
    }
    const block = stageBlock(stage, modelOf(stage), state, now);
    if (block) {
      skipped.push({ stage, index, reason: "blocked", block });
      if (!freeAt || Date.parse(block.until) < Date.parse(freeAt)) freeAt = block.until;
      continue;
    }
    if (tried.has(stageId(stage))) {
      skipped.push({ stage, index, reason: "tried" });
      continue;
    }
    return { kind: "stage", stage, index, skipped };
  }
  return { kind: "none", skipped, ...(freeAt ? { freeAt } : {}) };
}

export interface RecheckInput {
  readonly usage: SwitchUsage;
  /** ISO-Zeitpunkt vor dem Start der Messungen. */
  readonly checkStartedAt: string;
  readonly ready: SwitchReady;
  readonly auto: SwitchAuto;
}

export function recheck(state: SwitchState, { usage, checkStartedAt, ready, auto }: RecheckInput, now: number): SwitchState {
  assertAuto(auto);
  const blocks = state.blocks.filter(block => {
    if (block.cause === "outage") return !ready[block.engine].ready;
    if (!block.window) return false;
    const reading = latestReadings(usage[block.engine]).get(block.window);
    return isKnown(reading, now) && Date.parse(reading.measuredAt) >= Date.parse(checkStartedAt)
      && reading.percent >= auto.returnBelow;
  });
  const released = { ...state.released };
  for (const engine of Object.keys(usage) as EngineId[]) released[engine] = checkStartedAt;
  return applyMeasurement({ ...state, blocks, released }, usage, now, auto);
}

/** Einstellungen merken und nur bei Änderungen bestehende Schwellen-Sperren neu bewerten. */
export function syncAuto(state: SwitchState, auto: SwitchAuto, usage: SwitchUsage, now: number): SwitchState {
  assertAuto(auto);
  let blocks = state.blocks;
  const previous = state.auto;
  if (previous?.enabled && !auto.enabled) {
    blocks = blocks.filter(block => block.cause !== "threshold");
  } else if (previous && (previous.threshold !== auto.threshold || previous.returnBelow !== auto.returnBelow)) {
    blocks = blocks.filter(block => {
      if (block.cause !== "threshold") return true;
      const reading = block.window ? latestReadings(usage[block.engine]).get(block.window) : undefined;
      return isKnown(reading, now) && reading.percent >= auto.returnBelow;
    });
  }
  return { ...state, blocks, auto: { ...auto } };
}
