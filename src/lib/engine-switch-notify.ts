/** Meldungen zum Motorwechsel: Wortlaute, Merken und Zustellung (M14-10). */
import { switchWindowLabel } from "./engine-switch-text";
export { switchWindowLabel } from "./engine-switch-text";
import { engineIsReady, engineModelAndEffort, generalOrder, stageLabel, type EngineChoiceDeps } from "./engine-choice";
import { formatSwitchTime, pickStage, stageBlock, stageId, type PendingSwitchNotice, type Stage, type SwitchBlock, type SwitchNotices, type SwitchReady } from "./engine-switch";
import { checkEngine, type EngineId, type EngineStatus } from "./engines";
import { CLAUDE_NOT_INSTALLED, CODEX_NOT_INSTALLED } from "./engines/check";
import { OPENCODE_NOT_INSTALLED } from "./engines/opencode";
import type { UsageWindowId } from "./engines/usage";
import { onSwitchStateChanged, readSwitchHint, readSwitchState, rememberSwitchHint, settleSwitchStateForTests, updateSwitchState } from "./engine-switch-state";
import { engineBackups, getSettings } from "./settings";
import { getAgentConfigOrGeneral } from "../agents";
import type { UserDeliverer, UserDelivery } from "./user-notify";
import { HANDOVER_REASONS } from "./prompt-builder";

export type SwitchStatuses = Partial<Record<EngineId, EngineStatus>>;
export interface SwitchNotifyDeps extends Pick<EngineChoiceDeps, "getSettings" | "getAgentConfig" | "env" | "checkEngine" | "now" | "log" | "updateSwitchState"> {
  readSwitchState: typeof readSwitchState;
  id: () => string;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}
const defaultDeps: SwitchNotifyDeps = {
  getSettings, getAgentConfig: getAgentConfigOrGeneral, env: () => process.env, checkEngine,
  now: () => Date.now(), log: line => console.warn(line), readSwitchState, updateSwitchState,
  id: () => crypto.randomUUID(),
  setTimer: (run, ms) => setTimeout(run, ms).unref(),
  clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const NOTICE_TTL_MS = 6 * 60 * 60_000;
const CLAIM_MS = 2 * 60_000;
const RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000];
let notifier: UserDeliverer | undefined;
let deliveryStopped = false;
let deliveryDeps: SwitchNotifyDeps = defaultDeps;
let retryTimer: { handle: unknown; clear: SwitchNotifyDeps["clearTimer"] } | undefined;
let claimChain: Promise<unknown> = Promise.resolve();
const active = new Map<string, { claimedAt: string; promise: Promise<void> }>();
let generation = 0;
export const SWITCH_WATCH_MS = 15_000;
const watchers = new Set<() => void>();
const checking = new Set<Promise<void>>();

/** Messwert und Beginn sind kein Wechsel. Die Reihenfolge der Sperren ebenso wenig. */
function blocksFingerprint(blocks: readonly SwitchBlock[]): string {
  return JSON.stringify(blocks.map(block => [block.engine, block.cause, block.window ?? null,
    block.family ?? null, block.model ?? null, block.until]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

/** Eigene und fremde Schreiber brauchen nur updateSwitchState, keinen eigenen Meldeweg. */
export function startSwitchWatch(deps: Partial<SwitchNotifyDeps> = deliveryDeps): () => void {
  const d = { ...defaultDeps, ...deps };
  let stopped = false;
  let fingerprint: string | undefined;
  let timer: unknown;
  const check = async () => {
    const settings = d.getSettings();
    if (stopped || !engineBackups(settings).length) return;
    const fixed = { ...d, getSettings: () => settings };
    const statuses = await engineStatuses(generalOrder(fixed), fixed);
    if (!stopped) await checkSwitchNotices(statuses, fixed);
  };
  const track = (run: () => Promise<void>) => {
    const task = Promise.resolve().then(run).catch(() => log(d, "Beobachtung fehlgeschlagen; der nächste Durchgang prüft erneut."));
    checking.add(task);
    void task.finally(() => checking.delete(task));
    return task;
  };
  const pass = async () => {
    try {
      if (stopped || !engineBackups(d.getSettings()).length) return;
      const state = d.readSwitchState();
      const next = blocksFingerprint(state.blocks);
      if (next !== fingerprint) {
        await check();
        if (stopped) return;
        fingerprint = next;
      }
      const now = d.now();
      if (state.notices?.pending?.some(notice => dueAt(notice) <= now || now - Date.parse(notice.createdAt) >= NOTICE_TTL_MS)) {
        void flushSwitchNotices(d);
      }
    } finally {
      if (!stopped) timer = d.setTimer(() => { void track(pass); }, SWITCH_WATCH_MS);
    }
  };
  // Keine Anmeldung beim Einbinden des Moduls: nur der gestartete Bot beobachtet.
  const unsubscribe = onSwitchStateChanged(() => track(check));
  const stop = () => {
    stopped = true;
    if (timer !== undefined) d.clearTimer(timer);
    unsubscribe();
    watchers.delete(stop);
  };
  watchers.add(stop);
  void track(pass);
  return stop;
}

function clearRetryTimer(): void {
  if (retryTimer) retryTimer.clear(retryTimer.handle);
  retryTimer = undefined;
}

/** Ohne Meldeweg beansprucht der Prozess nichts. Anschließen holt wartende Meldungen nach. */
export function setSwitchNotifier(deliver: UserDeliverer | null, deps: Partial<SwitchNotifyDeps> = {}): void {
  clearRetryTimer();
  notifier = deliver ?? undefined;
  deliveryStopped = deliver === null;
  deliveryDeps = { ...defaultDeps, ...deps };
  if (deliver) void flushSwitchNotices();
}

function dueAt(notice: PendingSwitchNotice): number {
  return Math.max(Date.parse(notice.nextAt), notice.claimedAt ? Date.parse(notice.claimedAt) + CLAIM_MS : 0);
}

function scheduleNext(d: SwitchNotifyDeps): void {
  clearRetryTimer();
  if (deliveryStopped) return;
  const pending = d.readSwitchState().notices?.pending ?? [];
  if (!pending.length) return;
  const next = Math.min(...pending.map(notice => Math.min(Date.parse(notice.createdAt) + NOTICE_TTL_MS,
    notifier ? dueAt(notice) : Infinity)));
  retryTimer = { clear: d.clearTimer, handle: d.setTimer(() => {
    retryTimer = undefined;
    void flushSwitchNotices(d);
  }, Math.max(1, next - d.now())) };
}

async function sendClaimed(notice: PendingSwitchNotice, deliver: UserDeliverer, d: SwitchNotifyDeps, epoch: number): Promise<void> {
  try {
    let outcome: UserDelivery["outcome"];
    try { outcome = (await deliver(notice.text, { format: "plain" })).outcome; }
    catch { outcome = "unclear"; }
    if (epoch !== generation) return;
    const now = d.now();
    const attempts = notice.attempts + 1;
    const expired = now - Date.parse(notice.createdAt) >= NOTICE_TTL_MS;
    const discard = outcome !== "delivered" && (attempts > RETRY_MS.length || expired);
    const result = await d.updateSwitchState(state => ({ ...state, notices: { ...state.notices,
      pending: (state.notices?.pending ?? []).flatMap(current => {
        if (current.id !== notice.id || current.claimedAt !== notice.claimedAt) return [current];
        if (outcome === "delivered" || discard) return [];
        const { claimedAt: _claim, ...rest } = current;
        return [{ ...rest, attempts, nextAt: new Date(now + RETRY_MS[attempts - 1]).toISOString() }];
      }),
    } }));
    if (discard && !result.state.notices?.pending?.some(current => current.id === notice.id)) {
      log(d, expired ? "Meldung verworfen (6 Stunden abgelaufen)." : "Meldung verworfen (drei Wiederholungen erfolglos).");
    }
  } catch { log(d, "Zustellung nicht abgeschlossen; der Anspruch wird nach Ablauf erneut versucht."); }
  finally {
    if (epoch === generation) {
      if (active.get(notice.id)?.claimedAt === notice.claimedAt) active.delete(notice.id);
      scheduleNext(d);
    }
  }
}

/**
 * Nur das Beanspruchen läuft in Reihe. Eine hängende Zustellung hält weder
 * einen Turn noch die Zustellung späterer Wechsel auf. Kein Aufrufer im Bot wartet.
 */
export async function flushSwitchNotices(deps: Partial<SwitchNotifyDeps> = deliveryDeps): Promise<void> {
  const d = { ...deliveryDeps, ...deps };
  const epoch = generation;
  const sent: Promise<void>[] = [];
  const claim = claimChain.catch(() => {}).then(async () => {
    if (epoch !== generation || deliveryStopped || !engineBackups(d.getSettings()).length) return;
    const now = d.now();
    let pending = d.readSwitchState().notices?.pending ?? [];
    const expired = pending.filter(notice => now - Date.parse(notice.createdAt) >= NOTICE_TTL_MS);
    if (expired.length) {
      const ids = new Set(expired.map(notice => notice.id));
      const result = await d.updateSwitchState(state => ({ ...state, notices: { ...state.notices,
        pending: (state.notices?.pending ?? []).filter(notice => !ids.has(notice.id)),
      } }));
      pending = result.state.notices?.pending ?? [];
      for (const notice of expired) if (!pending.some(item => item.id === notice.id)) log(d, "Meldung verworfen (6 Stunden abgelaufen).");
    }
    const deliver = notifier;
    const due = deliver ? pending.filter(notice => dueAt(notice) <= now) : [];
    if (due.length) {
      const at = new Date(now).toISOString();
      const result = await d.updateSwitchState(state => ({ ...state, notices: { ...state.notices,
        pending: (state.notices?.pending ?? []).map(notice => due.some(item => item.id === notice.id
          && item.claimedAt === notice.claimedAt && item.attempts === notice.attempts) ? { ...notice, claimedAt: at } : notice),
      } }));
      if (epoch !== generation || notifier !== deliver) return;
      for (const notice of result.state.notices?.pending ?? []) {
        if (notice.claimedAt !== at || !due.some(item => item.id === notice.id)) continue;
        const sending = sendClaimed(notice, deliver!, d, epoch);
        active.set(notice.id, { claimedAt: at, promise: sending });
        sent.push(sending);
      }
    }
    if (epoch === generation) scheduleNext(d);
  });
  claimChain = claim;
  try { await claim; await Promise.all(sent); }
  catch { log(d, "Meldungsversand fehlgeschlagen; gespeicherte Meldungen bleiben erhalten."); }
}

/** Nur Tests mit abgeschlossener Arbeit: setzt einen Prozessneustart nach. */
export function resetSwitchNotifyForTests(): void {
  for (const stop of watchers) stop();
  generation++;
  clearRetryTimer();
  notifier = undefined;
  deliveryStopped = false;
  deliveryDeps = defaultDeps;
  claimChain = Promise.resolve();
  active.clear();
  checking.clear();
}

export async function settleSwitchNoticesForTests(): Promise<void> {
  while (checking.size) await Promise.all([...checking]);
  await claimChain;
  await Promise.all([...active.values()].map(item => item.promise));
  await settleSwitchStateForTests();
}

function log(d: Pick<SwitchNotifyDeps, "log">, message: string): void {
  try { d.log(`[Motorwechsel] ${message}`); } catch { /* Auch ein kaputtes Log kostet keinen Turn. */ }
}

async function engineStatuses(order: readonly Stage[], d: SwitchNotifyDeps): Promise<SwitchStatuses> {
  const statuses: SwitchStatuses = {};
  await Promise.all([...new Set(order.map(stage => stage.engine))].map(async engine => {
    try { statuses[engine] = await d.checkEngine(engine); } catch { /* Nicht bereit. */ }
  }));
  return statuses;
}

function readiness(statuses: SwitchStatuses): SwitchReady {
  const ready = (engine: EngineId) => ({ ready: !!statuses[engine] && engineIsReady(engine, statuses[engine]!) });
  return { claude: ready("claude"), codex: ready("codex"), opencode: ready("opencode"), api: ready("api") };
}

/** Alle Auslöser prüfen dieselbe allgemeine Reihenfolge, niemals den Gesprächswunsch. */
export function checkSwitchNotices(statuses?: SwitchStatuses, deps: Partial<SwitchNotifyDeps> = {}): Promise<void> {
  const task = checkSwitch(statuses, deps);
  checking.add(task);
  void task.finally(() => checking.delete(task));
  return task;
}

async function checkSwitch(statuses: SwitchStatuses | undefined, deps: Partial<SwitchNotifyDeps>): Promise<void> {
  const d = { ...defaultDeps, ...deps };
  const epoch = generation;
  try {
    const settings = d.getSettings();
    if (!engineBackups(settings).length) return;
    void flushSwitchNotices(d);
    const fixed = { ...d, getSettings: () => settings };
    const order = generalOrder(fixed);
    const checked = statuses ?? await engineStatuses(order, fixed);
    if (epoch !== generation) return;
    const ready = readiness(checked);
    const now = d.now();
    const state = d.readSwitchState();
    const modelOf = (stage: Stage) => stage.model ?? engineModelAndEffort(stage.engine, "general", fixed).model;
    const picked = pickStage(order, modelOf, state, ready, now);
    const next = picked.kind === "stage" ? stageId(picked.stage) : "none";
    const announced = state.notices?.announced;
    const previous = announced ?? stageId(order[0]);
    if (previous === next) return;
    const oldIndex = previous === "none" ? order.length : order.findIndex(stage => stageId(stage) === previous);
    const nextIndex = picked.kind === "stage" ? picked.index : order.length;
    const left = { ...state.notices?.left };
    const outageNoticeAt = { ...state.notices?.outageNoticeAt };
    const zone = d.env().USER_TIMEZONE || "UTC";
    let text: string | undefined;
    if (oldIndex >= 0) {
      if (nextIndex > oldIndex) {
        for (const stage of order.slice(oldIndex, nextIndex)) {
          const block = stageBlock(stage, modelOf(stage), state, now);
          const cause = block?.cause ?? (!ready[stage.engine].ready ? "outage" : undefined);
          if (cause) left[stageId(stage)] = cause;
        }
        const old = order[oldIndex];
        const block = stageBlock(old, modelOf(old), state, now);
        if (picked.kind === "none") text = noFreeSwitchNotice(picked.freeAt, zone);
        else if (block?.cause === "threshold") text = thresholdSwitchNotice(old, picked.stage, block, zone);
        else if (block?.cause === "limit") text = limitSwitchNotice(old, picked.stage, block, zone);
        else if (block?.cause === "outage" || !ready[old.engine].ready) {
          const last = outageNoticeAt[old.engine];
          if (!last || now - Date.parse(last) >= 60 * 60_000) {
            text = outageSwitchNotice(old, picked.stage, checked[old.engine]);
            outageNoticeAt[old.engine] = new Date(now).toISOString();
          }
        }
      } else if (picked.kind === "stage") {
        const returned = stageId(picked.stage);
        if (left[returned] === "threshold" || left[returned] === "limit") text = returnSwitchNotice(picked.stage);
        delete left[returned];
      }
    }
    const at = new Date(now).toISOString();
    const pending = text ? { id: d.id(), text, createdAt: at, attempts: 0, nextAt: at } : undefined;
    // Vergleich-und-Setzen: mutate darf später auf einem fremden Stand erneut laufen.
    const result = await d.updateSwitchState(current => {
      if (current.notices?.announced !== announced) return current;
      const notices: SwitchNotices = { ...current.notices, announced: next, left, outageNoticeAt,
        ...(pending ? { pending: [...(current.notices?.pending ?? []), pending] } : {}) };
      return { ...current, notices };
    });
    if (epoch === generation && pending && result.state.notices?.pending?.some(notice => notice.id === pending.id)) void flushSwitchNotices(d);
  } catch { log(d, "Wechselprüfung fehlgeschlagen; der Turn läuft weiter."); }
}

/** Vor dem Stufenlauf; unabhängig davon, ob es überhaupt Sessions gibt. */
export function conversationSwitchHint(sessionKey: string, wanted: Stage, answering: Stage,
  reason: "limit" | "outage", handover: boolean, now: number, agent: string): string | undefined {
  try {
    const known = readSwitchHint(sessionKey);
    const sameAgent = known && (known.agent ?? "general") === agent;
    const stage = stageId(answering);
    let text: string;
    if (stage === stageId(wanted)) {
      if (!sameAgent) return undefined;
      text = `Hier antwortet wieder ${stageLabel(answering)}.`;
      rememberSwitchHint(sessionKey, undefined);
    } else {
      if (sameAgent && known.stage === stage) return undefined;
      text = `Hier antwortet jetzt ${stageLabel(answering)} statt ${stageLabel(wanted)} (${HANDOVER_REASONS[reason]}).`;
      rememberSwitchHint(sessionKey, { stage, at: new Date(now).toISOString(), agent });
    }
    return text + (handover ? " Der Verlauf ist übergeben." : "");
  } catch { return undefined; }
}


function resetText(block: SwitchBlock, timeZone: string, threshold: boolean): string {
  const time = formatSwitchTime(block.until, timeZone);
  if (!block.resetKnown) return `Ich versuche es um ${time.slice(-5)} Uhr wieder.`;
  return `Zurück geht es von selbst ${threshold ? "nach dem Reset am" : "ab"} ${time} Uhr.`;
}

export function thresholdSwitchNotice(old: Stage, next: Stage, block: SwitchBlock, timeZone: string): string {
  const level = block.percent === undefined ? "hat die Schwelle erreicht" : `steht bei ${Math.round(block.percent)} %`;
  const window = block.window ? ` (${switchWindowLabel(block.window)})` : "";
  return `Motorwechsel: ${stageLabel(old)} ${level}${window}. Ab der nächsten Nachricht antwortet ${stageLabel(next)}. ${resetText(block, timeZone, true)} Stand und Wahl: /motor`;
}

export function limitSwitchNotice(old: Stage, next: Stage, block: SwitchBlock, timeZone: string): string {
  const window = block.window ? ` (${switchWindowLabel(block.window)})` : "";
  return `Motorwechsel: ${stageLabel(old)} hat das Limit erreicht${window}. Ab sofort antwortet ${stageLabel(next)}. ${resetText(block, timeZone, false)} Stand und Wahl: /motor`;
}

export function returnSwitchNotice(stage: Stage): string {
  return `Motorwechsel: ${stageLabel(stage)} ist wieder frei. Ab der nächsten Nachricht antwortet wieder ${stageLabel(stage)}.`;
}

export function outageSwitchNotice(old: Stage, next: Stage, status?: EngineStatus): string {
  const missing = [CLAUDE_NOT_INSTALLED, CODEX_NOT_INSTALLED, OPENCODE_NOT_INSTALLED];
  const reason = status?.message && missing.includes(status.message) ? "nicht installiert"
    : status?.installed && !status.loggedIn && !status.loginUnknown ? "nicht angemeldet" : "Fehler beim letzten Lauf";
  return `${stageLabel(old)} antwortet gerade nicht (${reason}). ${stageLabel(next)} springt ein.`;
}

export function noFreeSwitchNotice(freeAt: string | undefined, timeZone: string): string {
  return "Alle Motoren sind am Limit oder nicht bereit. " + (freeAt
    ? `Bis ${formatSwitchTime(freeAt, timeZone)} Uhr antworten Ersatzmodelle mit eingeschränktem Werkzeugumfang.`
    : "Es antworten Ersatzmodelle mit eingeschränktem Werkzeugumfang.");
}
