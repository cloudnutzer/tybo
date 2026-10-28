/**
 * Planer für Erinnerungen (Issue #322, Entscheidung E2): ein Zeitgeber im
 * Bot-Prozess, alle 30 Sekunden ein Durchlauf über die Ablage aus store.ts.
 * Zugestellt werden nur Einträge der Art "reminder"; Aufträge ("action")
 * bleiben unberührt liegen. Die Ablage filtert die Art schon beim Lesen, so
 * können ältere Aufträge keine Erinnerung verdrängen.
 *
 * Ablauf je Eintrag, jeder Schritt eine bedingte Änderung (updateIf):
 * 1. Übernahme: status pending → running, leaseOwner = dieser Planer,
 *    leaseUntil = jetzt + LEASE_MS. Von zwei gleichzeitigen Durchläufen
 *    (derselbe Prozess, zwei Prozesse, zwei Rechner an derselben Datenbank)
 *    gewinnt genau einer.
 * 2. Versandbeginn: sendStartedAt = jetzt, attempts + 1, nur solange der
 *    Planer Besitzer ist und noch kein Versand begonnen hat.
 * 3. Versand, dann Abschluss, nur solange der Planer noch Besitzer ist.
 *
 * Festlegung zur Zustellung (verbindlich, im Issue #322 dokumentiert):
 * - Nicht gesendet heißt nachholen. Endet eine Übernahme ohne Versandbeginn
 *   (Absturz zwischen 1. und 2., Frist abgelaufen), geht der Eintrag zurück
 *   auf pending und kommt im selben Durchlauf, mit Hinweis auf die
 *   Verspätung. Beim Beenden (stop) ebenso, sofort.
 * - Ausgang unbekannt heißt nicht wiederholen. Hat der Versand begonnen und
 *   es fehlt der Abschluss (Absturz während oder nach dem Versand), oder
 *   meldet der Versand „unklar" (Ausnahme, Netzfehler, Festhalten für die
 *   WebUI gescheitert), gilt die Erinnerung als zugestellt: einmalige werden
 *   done, Serien bekommen den nächsten Termin, lastError hält es fest. Eine
 *   doppelte Erinnerung samt zweiter Rückfrage wiegt hier schwerer als eine
 *   verlorene; das Log nennt die ID.
 * - zugestellt (auch Teilerfolg: Telegram angekommen, Festhalten
 *   gescheitert): einmalige done, Serien der nächste Termin (nextDue,
 *   verpasste Termine werden nicht nachgeholt).
 * - sicher abgelehnt: zurück auf pending, der nächste Durchlauf versucht es
 *   erneut; nach MAX_SEND_ATTEMPTS Versuchen failed.
 * Hat ein Knopf („in 1 Stunde", reminder-choices.ts) den Eintrag während
 * des Versands übernommen, ist der Planer nicht mehr Besitzer; sein
 * Abschluss trifft dann nicht und überschreibt die Entscheidung nicht.
 *
 * Neustart: Was fällig wurde, während der Bot aus war, ist noch pending und
 * geht im ersten Durchlauf nach dem Start raus, mit dem Hinweis, wann es
 * fällig war. Den Hinweis bekommt alles, was vor dem Start des Planers
 * fällig war, auch eine Minute; sonst erst ab LATE_AFTER_MS Verspätung (die
 * normale Verzögerung durch den Takt bleibt ohne Hinweis).
 *
 * Scheitert eine Übernahme, obwohl der Eintrag danach unverändert wartet,
 * war es kein anderer Durchlauf, sondern die Ablage (etwa Supabase ohne die
 * Migration 20261018_scheduled_tasks_lease.sql). Das steht einmal je
 * Prozess im Log, sonst bliebe der Planer stumm.
 *
 * Ins Log kommen nur IDs, nie Texte.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { nextDue, parseRecurrence } from "../recurrence";
import { clockAt, effectiveTimeZone } from "../when";
import type { ScheduleChanges, ScheduledTask, ScheduleStore } from "./contract";

export const PLANNER_INTERVAL_MS = 30_000;
/** Erster Durchlauf kurz nach dem Start: Verpasstes kommt gleich */
export const PLANNER_FIRST_DELAY_MS = 5_000;
/** So lange gehört ein übernommener Eintrag dem Planer */
export const LEASE_MS = 2 * 60_000;
/** Höchstens so viele Zustellungen je Durchlauf */
export const PLANNER_BATCH_MAX = 10;
export const MAX_SEND_ATTEMPTS = 3;
/** Ab dieser Verspätung steht im Text, wann die Erinnerung fällig war (auch ohne Neustart) */
export const LATE_AFTER_MS = 5 * 60_000;
/** So lange wartet das Beenden höchstens auf einen laufenden Durchlauf */
export const PLANNER_STOP_GRACE_MS = 5_000;

export const PLANNER_CLAIM_WARNING =
  "[erinnerung] Übernahme scheitert an der Ablage, keine Zustellung (Supabase: Migration 20261018_scheduled_tasks_lease.sql eingespielt? tybo setup datenbank)";

export const PLANNER_ERRORS = {
  unclear: "Zustellung unklar, nicht wiederholt",
  orphaned: "Übernahme abgelaufen, Ausgang unbekannt, nicht wiederholt",
  rejected: "Zustellung abgelehnt",
} as const;

/** Ausgang eines Versands, siehe Kopf */
export type SendOutcome = "delivered" | "rejected" | "unclear";

export interface ReminderPlannerDeps {
  /** Die Ablage, bei jedem Durchlauf gefragt */
  store(): ScheduleStore;
  now(): number;
  /** Stellt eine Erinnerung zu; darf werfen (gilt als unklar) */
  send(task: ScheduledTask, text: string): Promise<SendOutcome>;
  /** Kennung dieses Planers als leaseOwner; Standard: Rechner, Prozess, Zufall */
  owner?: string;
  /** IANA-Zeitzone für Hinweis und Wiederholung; Standard USER_TIMEZONE */
  timeZone?(): string;
  log?(line: string): void;
}

export interface PlannerTickResult {
  /** Zugestellt oder unklar (beides gilt als zugestellt) */
  sent: number;
  /** Sicher abgelehnt, später neuer Versuch */
  retry: number;
  failed: number;
  /** Abgelaufene Übernahmen mit begonnenem Versand, abgeschlossen ohne neuen Versand */
  recovered: number;
  /** Abgelaufene Übernahmen ohne Versandbeginn, zurück auf pending */
  resumed: number;
}

/** Kennung eines Planers: Rechner, Prozess und Zufall */
export function plannerOwner(): string {
  return `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

const two = (n: number) => String(n).padStart(2, "0");

/** Zeitpunkt als „18.10. 14:05" in der Zone */
export function shortStamp(ms: number, timeZone: string): string {
  const c = clockAt(ms, timeZone);
  return `${two(c.day)}.${two(c.month)}. ${two(c.hour)}:${two(c.minute)}`;
}

/**
 * Text der Erinnerung; mit dem fälligen Zeitpunkt, wenn sie vor startedAt
 * (Start des Planers, also während der Bot aus war) fällig war oder
 * mindestens LATE_AFTER_MS zu spät kommt
 */
export function reminderMessage(task: Pick<ScheduledTask, "text" | "dueAt">, now: number, timeZone: string, startedAt?: number): string {
  const due = Date.parse(task.dueAt);
  const lines = [`⏰ Erinnerung: ${task.text}`];
  const missed = startedAt !== undefined && due < startedAt;
  if (missed || now - due >= LATE_AFTER_MS) lines.push(`(verspätet, fällig war ${shortStamp(due, timeZone)})`);
  return lines.join("\n");
}

/**
 * Abschluss nach einer Zustellung: Serien auf den nächsten Termin, sonst
 * done. Die Übernahme wird freigegeben.
 */
export function completion(task: ScheduledTask, now: number, timeZone: string, lastError: string | null): ScheduleChanges {
  const free = { leaseOwner: null, leaseUntil: null, sendStartedAt: null, lastError } as const;
  const rule = task.recurrence ? parseRecurrence(task.recurrence) : null;
  const next = rule ? nextDue(rule, new Date(task.dueAt), { now: new Date(now), timeZone }) : undefined;
  if (next) return { ...free, status: "pending", dueAt: next, attempts: 0 };
  return { ...free, status: "done" };
}

export interface ReminderPlanner {
  /** Ein Durchlauf (für Tests direkt aufrufbar); wirft nicht */
  tick(): Promise<PlannerTickResult>;
  /** Ab jetzt keine Zustellung mehr */
  stop(): void;
  readonly owner: string;
}

export function createReminderPlanner(deps: ReminderPlannerDeps): ReminderPlanner {
  const owner = deps.owner ?? plannerOwner();
  const log = deps.log ?? ((line: string) => console.log(line));
  const zone = () => effectiveTimeZone(deps.timeZone?.());
  /** Was davor fällig war, hat der Bot verpasst (Hinweis im Text) */
  const startedAt = deps.now();
  let stopped = false;
  let claimWarned = false;

  /** Übernahme freigeben, ohne gesendet zu haben */
  const release = { status: "pending", leaseOwner: null, leaseUntil: null, sendStartedAt: null } as const;

  /** Abgelaufene Übernahmen: ohne Versandbeginn nachholen, sonst abschließen ohne neuen Versand */
  async function recover(store: ScheduleStore, now: number, result: PlannerTickResult): Promise<void> {
    for (const task of await store.list({ status: ["running"] })) {
      if (task.kind !== "reminder") continue;
      if (task.leaseUntil !== null && Date.parse(task.leaseUntil) >= now) continue;
      const lease =
        task.leaseUntil === null
          ? { status: "running" as const, leaseOwner: task.leaseOwner }
          : { status: "running" as const, leaseOwner: task.leaseOwner, leaseUntilBefore: new Date(now) };
      if (task.sendStartedAt === null) {
        if (!(await store.updateIf(task.id, { ...lease, notSending: true }, release))) continue;
        result.resumed++;
        log(`[erinnerung] ${task.id}: Übernahme abgelaufen, nicht gesendet, wird nachgeholt`);
        continue;
      }
      const done = await store.updateIf(task.id, { ...lease, notSending: false }, completion(task, now, zone(), PLANNER_ERRORS.orphaned));
      if (!done) continue;
      result.recovered++;
      log(`[erinnerung] ${task.id}: Übernahme abgelaufen, Ausgang unbekannt, nicht wiederholt`);
    }
  }

  /** Einen fälligen Eintrag übernehmen, senden und abschließen */
  async function deliver(store: ScheduleStore, task: ScheduledTask, result: PlannerTickResult): Promise<void> {
    const claimedAt = deps.now();
    const claimed = await store.updateIf(
      task.id,
      { status: "pending", dueAt: new Date(task.dueAt), dueBy: new Date(claimedAt) },
      { status: "running", leaseOwner: owner, leaseUntil: new Date(claimedAt + LEASE_MS), sendStartedAt: null },
    );
    // Ein anderer Durchlauf war schneller, oder der Eintrag hat sich geändert
    if (!claimed) {
      const after = await store.byId(task.id);
      if (!claimWarned && after?.status === "pending" && after.dueAt === task.dueAt && after.leaseOwner === null) {
        claimWarned = true;
        log(PLANNER_CLAIM_WARNING);
      }
      return;
    }
    const mine = { status: "running" as const, leaseOwner: owner };
    if (stopped) {
      await store.updateIf(task.id, { ...mine, notSending: true }, release);
      return;
    }
    // Versandbeginn festhalten: ab hier wird nach einem Absturz nicht neu gesendet
    const sending = await store.updateIf(task.id, { ...mine, notSending: true }, { sendStartedAt: new Date(deps.now()), attempts: claimed.attempts + 1 });
    if (!sending) {
      log(`[erinnerung] ${task.id}: Übernahme vor dem Versand verloren, nichts gesendet`);
      return;
    }

    let outcome: SendOutcome;
    try {
      outcome = await deps.send(sending, reminderMessage(sending, deps.now(), zone(), startedAt));
    } catch {
      outcome = "unclear";
    }

    const now = deps.now();
    const free = { leaseOwner: null, leaseUntil: null, sendStartedAt: null } as const;
    let changes: ScheduleChanges;
    if (outcome === "delivered") changes = completion(sending, now, zone(), null);
    else if (outcome === "unclear") changes = completion(sending, now, zone(), PLANNER_ERRORS.unclear);
    else if (sending.attempts >= MAX_SEND_ATTEMPTS) changes = { ...free, status: "failed", lastError: PLANNER_ERRORS.rejected };
    else changes = { ...free, status: "pending", lastError: PLANNER_ERRORS.rejected };

    const finished = await store.updateIf(task.id, mine, changes);
    if (!finished) {
      log(`[erinnerung] ${task.id}: Eintrag inzwischen geändert (Knopf oder abgelaufene Übernahme), nichts überschrieben`);
    }
    if (outcome === "rejected") {
      if (changes.status === "failed") {
        result.failed++;
        log(`[erinnerung] ${task.id}: nach ${sending.attempts} Versuchen nicht zugestellt`);
      } else result.retry++;
      return;
    }
    result.sent++;
    if (outcome === "unclear") log(`[erinnerung] ${task.id}: Zustellung unklar, nicht wiederholt`);
  }

  async function tick(): Promise<PlannerTickResult> {
    const result: PlannerTickResult = { sent: 0, retry: 0, failed: 0, recovered: 0, resumed: 0 };
    if (stopped) return result;
    const store = deps.store();
    try {
      await recover(store, deps.now(), result);
    } catch {
      log("[erinnerung] abgelaufene Übernahmen nicht geprüft");
    }
    let due: ScheduledTask[];
    try {
      due = await store.due(new Date(deps.now()), PLANNER_BATCH_MAX, "reminder");
    } catch {
      log("[erinnerung] Ablage nicht lesbar, keine Zustellung");
      return result;
    }
    for (const task of due) {
      if (stopped) break;
      if (task.kind !== "reminder") continue;
      try {
        await deliver(store, task, result);
      } catch {
        log(`[erinnerung] ${task.id}: Durchlauf gescheitert`);
      }
    }
    return result;
  }

  return {
    tick,
    stop() {
      stopped = true;
    },
    owner,
  };
}

export interface ReminderPlannerTimer {
  /** Keine weiteren Durchläufe, keine weitere Zustellung */
  stop(): void;
  /** Bis der laufende Durchlauf fertig ist */
  idle(): Promise<void>;
  readonly owner: string;
}

export interface PlannerTimerOptions {
  intervalMs?: number;
  firstDelayMs?: number;
  setTimeout?: typeof setTimeout;
  setInterval?: typeof setInterval;
  clearTimeout?: typeof clearTimeout;
  clearInterval?: typeof clearInterval;
}

/**
 * Startet den Planer: erster Durchlauf nach PLANNER_FIRST_DELAY_MS, dann
 * alle PLANNER_INTERVAL_MS. Ein Durchlauf läuft nie zweimal gleichzeitig.
 */
export function startReminderPlanner(deps: ReminderPlannerDeps, o: PlannerTimerOptions = {}): ReminderPlannerTimer {
  const planner = createReminderPlanner(deps);
  let running: Promise<void> | null = null;
  let stopped = false;
  const run = () => {
    if (stopped || running) return;
    running = planner
      .tick()
      .then(() => {})
      .catch(() => {})
      .finally(() => {
        running = null;
      });
  };
  const first = (o.setTimeout ?? setTimeout)(run, o.firstDelayMs ?? PLANNER_FIRST_DELAY_MS);
  const timer = (o.setInterval ?? setInterval)(run, o.intervalMs ?? PLANNER_INTERVAL_MS);
  (first as { unref?: () => void }).unref?.();
  (timer as { unref?: () => void }).unref?.();
  return {
    stop() {
      stopped = true;
      planner.stop();
      (o.clearTimeout ?? clearTimeout)(first);
      (o.clearInterval ?? clearInterval)(timer);
    },
    idle: () => running ?? Promise.resolve(),
    owner: planner.owner,
  };
}

/**
 * Beenden für shutdown(): keine neuen Durchläufe, dann höchstens graceMs auf
 * den laufenden warten, damit ein begonnener Versand noch abschließt. true,
 * wenn er rechtzeitig fertig war. Was danach noch läuft, gilt beim nächsten
 * Start als „Ausgang unbekannt" bzw. wird nachgeholt (siehe Kopf).
 */
export async function stopReminderPlanner(timer: Pick<ReminderPlannerTimer, "stop" | "idle">, graceMs = PLANNER_STOP_GRACE_MS): Promise<boolean> {
  timer.stop();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>(resolve => {
    timeout = setTimeout(() => resolve(false), graceMs);
  });
  try {
    return await Promise.race([timer.idle().then(() => true as const, () => true as const), late]);
  } finally {
    clearTimeout(timeout);
  }
}
