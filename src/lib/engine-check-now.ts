/** Prüfung von Hand für WebUI und /motor: keine Chat-Turns, keine Anmeldedaten. */
import { engineAutoDeps, type EngineAutoDeps } from "./engine-auto-sync";
import { expireBlocks, recheck, syncAuto, type SwitchBlock } from "./engine-switch";
import { checkEngine, forgetEngineCheckFor, type EngineStatus } from "./engines/check";
import { ENGINE_IDS, type EngineId } from "./engines/types";
import { engineAuto } from "./settings";
import { claudeUsesSubscription } from "./engines/claude-auth";

export type EngineMeasurementStatus = "measured" | "failed" | "not-measurable";
export interface EngineMeasurementResult { status: EngineMeasurementStatus }

export interface EngineMeasurement {
  timeoutMs: number;
  /** Muss das Signal beachten und darf nach Abbruch keine Messung mehr speichern. */
  measure(signal: AbortSignal): Promise<EngineMeasurementResult | void>;
}

/** Nur beim Bot-Start befüllt; ein Import oder web:dev startet keinen Messlauf. */
export const engineMeasurements: Record<EngineId, EngineMeasurement[]> = { claude: [], codex: [], opencode: [], api: [] };

export interface EngineCheckNowDeps extends EngineAutoDeps {
  measurements: Readonly<Partial<Record<EngineId, readonly EngineMeasurement[]>>>;
  checkEngine(id: EngineId): Promise<EngineStatus>;
  forgetCheck(id: EngineId): void;
  claudeSubscription(): boolean;
}
export interface EngineCheckNowResult {
  notMeasured: EngineId[];
  measured: Record<EngineId, boolean>;
  measurementResults: Record<EngineId, EngineMeasurementStatus>;
  before: number;
  lifted: number;
  remaining: number;
  liftedWithoutMeasurement: number;
  /** Bereits geprüfte Motoren für die anschließende Vorschau, ohne zweite Prüfung. */
  statuses: Partial<Record<EngineId, EngineStatus>>;
}

async function measureWithinLimit(source: EngineMeasurement): Promise<EngineMeasurementResult | void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutMs = Number.isFinite(source.timeoutMs) ? Math.max(1, Math.min(30_000, source.timeoutMs)) : 5_000;
    return await Promise.race([
      Promise.resolve().then(() => source.measure(controller.signal)),
      new Promise<EngineMeasurementResult>(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ status: "failed" }); }, timeoutMs); }),
    ]);
  } catch {
    // Eine einzelne Quelle darf die übrigen Prüfungen nicht verhindern.
    return { status: "failed" };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Eigener Prüfer für injizierte Quellen; gleichzeitige Aufrufe teilen denselben Durchgang. */
export function createEngineChecker(deps: Partial<EngineCheckNowDeps> = {}): () => Promise<EngineCheckNowResult> {
  const d: EngineCheckNowDeps = { ...engineAutoDeps, measurements: engineMeasurements, checkEngine,
    forgetCheck: forgetEngineCheckFor, claudeSubscription: claudeUsesSubscription, ...deps };
  let running: Promise<EngineCheckNowResult> | undefined;
  async function run(): Promise<EngineCheckNowResult> {
    const started = d.now();
    const checkStartedAt = new Date(started).toISOString();
    const initialState = d.readState();
    const sourceResults = Object.fromEntries(await Promise.all(ENGINE_IDS.map(async id => [id,
      await Promise.all((id === "claude" && !d.claudeSubscription() ? [] : d.measurements[id] ?? []).map(measureWithinLimit)),
    ]))) as Record<EngineId, (EngineMeasurementResult | void)[]>;
    const state = d.readState();
    const ready: Record<EngineId, { ready: boolean }> = { claude: { ready: false }, codex: { ready: false }, opencode: { ready: false }, api: { ready: false } };
    const statuses: EngineCheckNowResult["statuses"] = {};
    const outages = new Set(state.blocks.filter(block => block.cause === "outage" && Date.parse(block.until) > d.now()).map(block => block.engine));
    await Promise.all([...outages].map(async id => {
      try {
        d.forgetCheck(id);
        const status = await d.checkEngine(id);
        statuses[id] = status;
        ready[id] = { ready: status.installed && status.loggedIn && !status.loginUnknown };
      } catch { statuses[id] = { engine: id, checked: true, installed: false, loggedIn: false }; }
    }));
    const now = d.now();
    const usage = await d.readUsage(now);
    const auto = engineAuto(d.readSettings());
    const fresh = Object.fromEntries(ENGINE_IDS.map(id => [id, new Set(usage[id].filter(window => window.state === "known"
      && Date.parse(window.measuredAt) >= started && (!window.resetsAt || Date.parse(window.resetsAt) > now))
      .map(window => window.id))])) as Record<EngineId, Set<string>>;
    const measurementResults = Object.fromEntries(ENGINE_IDS.map(id => {
      const results = sourceResults[id];
      // Ein erfolgreicher Bericht zählt auch mit alten, nicht enthaltenen Fenstern.
      const status: EngineMeasurementStatus = id === "claude" && !d.claudeSubscription() ? "not-measurable"
        : results.some(result => result?.status === "measured") ? "measured"
        : results.some(result => result?.status === "failed") ? "failed"
        : results.some(result => result?.status === "not-measurable") ? "not-measurable"
        : fresh[id].size > 0 ? "measured" : "not-measurable";
      return [id, status];
    })) as Record<EngineId, EngineMeasurementStatus>;
    // Fehlgeschlagen ist eine eigene Meldung. Im API-Modus gibt es kein Abo-Limit.
    const notMeasured = ENGINE_IDS.filter(id => (id === "codex" || id === "claude" && d.claudeSubscription())
      && measurementResults[id] === "not-measurable");
    const input = { usage, checkStartedAt, ready, auto };
    const key = (block: SwitchBlock) => JSON.stringify([block.engine, block.cause, block.window, block.family, block.model]);
    let counts = { before: 0, lifted: 0, remaining: 0, liftedWithoutMeasurement: 0 };
    await d.updateState(current => {
      // Nur innerhalb der Mutation zählen: parallele Turns und erneute Mutationen sind erlaubt.
      const active = expireBlocks(current, now);
      const next = expireBlocks(recheck(syncAuto(active, auto, usage, now), input, now), now);
      const remaining = new Set(next.blocks.map(key));
      // Ein schon laufender Hintergrundmesslauf kann zwischen Start und Mutation
      // fertig werden. Seine Freigabe gehört ebenfalls zum sichtbaren Prüfergebnis.
      const counted = [...new Map([...expireBlocks(initialState, now).blocks, ...active.blocks].map(block => [key(block), block])).values()];
      const lifted = counted.filter(block => !remaining.has(key(block)));
      counts = { before: counted.length, lifted: lifted.length, remaining: next.blocks.length,
        liftedWithoutMeasurement: lifted.filter(block => block.cause !== "outage" && (!block.window || !fresh[block.engine].has(block.window))).length };
      return next;
    });
    const measured = Object.fromEntries(ENGINE_IDS.map(id => [id, measurementResults[id] === "measured"])) as Record<EngineId, boolean>;
    return { notMeasured, measured, measurementResults, ...counts, statuses };
  }
  return () => {
    if (!running) running = run().finally(() => { running = undefined; });
    return running;
  };
}

const sharedCheck = createEngineChecker();
export function checkEnginesNow(): Promise<EngineCheckNowResult> {
  return sharedCheck();
}
