/**
 * Ausgebliebene Läufe melden (Issue #287, Entscheidung 0025). Der Bot prüft
 * alle 10 Minuten jede eingebundene, aktive, zeitgesteuerte launchd-Routine.
 * Pausierte, nicht geladene, unbekannte, nicht eingebundene Routinen,
 * Dauerdienste und PM2 gelten nie als überfällig.
 *
 * Schlaf des Rechners: Der Bot misst selbst, seit wann er ohne Lücke läuft
 * (Herzschlag in alerts.json). Jeder Bot-Start setzt den Herzschlag zurück,
 * eine Lücke über 15 Minuten heißt „Rechner schlief"; danach beginnt jede
 * Frist neu, denn launchd holt verpasste Läufe nach dem Aufwachen nach.
 *
 * Offener Termin: der erste Termin nach dem Beginn des letzten Laufs (aus
 * dem Protokoll oder, für einen laufenden Lauf, aus alerts.json), frühestens
 * nach dem Zeitpunkt, seit dem der Bot die Routine ohne Unterbrechung als
 * prüfbar sieht (seenAt; fällt weg, sobald sie pausiert, nicht geladen oder
 * ausgebunden ist). So bleibt bei einer stündlichen Routine der verpasste
 * Termin stehen, statt mit jeder Stunde weiterzurücken, und eine eben
 * fortgesetzte oder neu eingebundene Routine gilt nicht sofort als überfällig.
 *
 * - StartCalendarInterval: überfällig, wenn der offene Termin und der Beginn
 *   der wachen Zeit beide mehr als 2 Stunden zurückliegen.
 * - StartInterval: überfällig, wenn der letzte Beginn (frühestens seenAt) und der Beginn der wachen Zeit beide länger als dreimal das
 *   Intervall plus 10 Minuten zurückliegen. Fällig war der Lauf beim letzten
 *   Beginn plus Intervall.
 *
 * Läuft die Routine gerade (running in alerts.json, mindestens ein
 * eingetragener Wrapper-Prozess lebt), ist sie nie überfällig, wie lange der
 * Lauf auch dauert.
 *
 * Gemeldet wird einmal je Serie (alerts.ts): Bis zum nächsten Lauf bleibt der
 * offene Termin derselbe, es kommt keine zweite Meldung; endet der nächste
 * Lauf erfolgreich, entwarnt der Wrapper (oder der Bot, wenn der Erfolg
 * kam, während seine Meldung unterwegs war). Alle Ansprüche einer Prüfung
 * entstehen gleichzeitig, gesendet wird nacheinander; deshalb prüft und
 * erneuert der Bot jeden Anspruch unmittelbar vor dem Versand (renewClaim)
 * und sendet nicht, wenn er ihn verloren hat. Zeigt der Herzschlag dabei
 * eine Lücke (der Rechner schlief während der Prüfung), beginnt die wache
 * Zeit neu und die übrigen Meldungen werden zurückgestellt, bis eine
 * spätere Prüfung sie nach der vollen neuen Frist wieder fällig sieht.
 * Bis dahin ist der Anspruch nur vorgemerkt (reserved): beginnt die Routine inzwischen, fällt die Serie weg;
 * scheitert ein Lauf, übernimmt der Wrapper mit seiner Fehlermeldung. Jede Meldung ist maskiert wie
 * im Wrapper. Ins Log kommen nur Routinen-IDs.
 */

import { listRoutines, defaultRoutinesDeps } from "./catalog";
import { projectSecretsOrThrow, type SecretValue } from "../jobs/mask";
import {
  ALERT_SOURCE,
  alertName,
  alertsEnabled,
  claimFresh,
  delivered,
  fileAlertsStore,
  finishClaim,
  missedText,
  recoveredText,
  renewClaim,
  type AlertClaim,
  type AlertMeta,
  type AlertSender,
  type AlertsState,
  type AlertsStore,
  type RoutineAlertState,
} from "./alerts";
import { whenText } from "./format";
import { nextRun, systemTimeZone, type LaunchdSchedule } from "./schedule";
import type { Routine, RoutineList } from "./types";

export const WATCH_INTERVAL_MS = 10 * 60_000;
/** Längere Lücke im Herzschlag: der Rechner schlief */
export const SLEEP_GAP_MS = 15 * 60_000;
/** Frist für Kalender-Routinen nach dem fälligen Termin */
export const CALENDAR_GRACE_MS = 2 * 60 * 60_000;
/** Zuschlag auf dreimal das Intervall */
export const INTERVAL_SLACK_MS = 10 * 60_000;

/** Herzschlag fortschreiben; reset beim Bot-Start, Lücke über SLEEP_GAP_MS heißt Schlaf */
export function beat(state: AlertsState, now: number, reset = false): number {
  const at = new Date(now).toISOString();
  const last = state.heartbeat ? Date.parse(state.heartbeat.lastBeat) : NaN;
  const awake = state.heartbeat ? Date.parse(state.heartbeat.awakeSince) : NaN;
  const gap = !Number.isFinite(last) || now - last > SLEEP_GAP_MS || now < last;
  const awakeSince = reset || gap || !Number.isFinite(awake) ? now : awake;
  state.heartbeat = { awakeSince: new Date(awakeSince).toISOString(), lastBeat: at };
  return awakeSince;
}

/** Kann die Routine überhaupt ausbleiben? Nur eingebunden, aktiv, zeitgesteuert, launchd */
export function watchable(r: Routine): r is Routine & { schedule: LaunchdSchedule } {
  if (r.source !== "launchd" || r.kind !== "scheduled" || r.state !== "active" || !r.wrapped) return false;
  const s = r.schedule;
  return s?.type === "launchd" && (s.StartCalendarInterval !== undefined || s.StartInterval !== undefined);
}

function ms(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** Beginn des letzten Laufs: Protokoll oder laufender Lauf aus alerts.json, der spätere */
export function lastStart(r: Routine, st: RoutineAlertState | undefined): number | null {
  const a = ms(r.lastRun?.startedAt);
  const b = ms(st?.startedAt);
  if (a === null) return b;
  return b === null ? a : Math.max(a, b);
}

export interface Overdue {
  /** Fälliger Termin in ms */
  due: number;
}

/** Lebt der Prozess? EPERM heißt: er lebt, gehört nur einem anderen Nutzer */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Ist die Routine überfällig? null, wenn nicht, wenn sie gerade läuft
 * (running) oder wenn sich das nicht sicher sagen lässt (ungültiger
 * Zeitplan, nie gesehen).
 */
export function overdue(r: Routine & { schedule: LaunchdSchedule }, st: RoutineAlertState | undefined, awakeSince: number, now: number, timeZone: string, running = false): Overdue | null {
  if (running) return null;
  const started = lastStart(r, st);
  const seen = ms(st?.seenAt);
  if (seen === null) return null;
  const base = started === null ? seen : Math.max(started, seen);
  const s = r.schedule;
  if (s.StartCalendarInterval !== undefined) {
    const due = nextRun({ type: "launchd", StartCalendarInterval: s.StartCalendarInterval, otherTriggers: [] }, { now: base, lastStart: null, timeZone });
    if (due === null) return null;
    return now - Math.max(due, awakeSince) > CALENDAR_GRACE_MS ? { due } : null;
  }
  const interval = s.StartInterval;
  if (typeof interval !== "number" || !Number.isInteger(interval) || interval < 1) return null;
  const limit = 3 * interval * 1000 + INTERVAL_SLACK_MS;
  return now - Math.max(base, awakeSince) > limit ? { due: base + interval * 1000 } : null;
}

export interface WatchDeps {
  store: AlertsStore;
  list(): Promise<RoutineList>;
  send: AlertSender;
  now(): number;
  pid: number;
  home: string;
  timeZone?: string;
  /** ROUTINE_ALERTS, bei jeder Prüfung frisch */
  enabled(): boolean;
  /** Werte zum Maskieren (.env und geheime Umgebung); null: .env nicht lesbar */
  secrets(): readonly SecretValue[] | null;
  /** Lebt der Wrapper-Prozess eines laufenden Laufs? */
  alive(pid: number): boolean;
  /** Nur Routinen-IDs, nie Ausgaben */
  log(line: string): void;
}

/**
 * Eine Prüfung: Herzschlag, dann je überfälliger Routine eine Meldung, wenn
 * für sie keine Serie läuft (oder eine ausgebliebene noch nicht zugestellt
 * ist). Liefert die IDs, zu denen eine Meldung zugestellt wurde. Wirft nicht.
 */
export async function watchTick(deps: WatchDeps, opts: { reset?: boolean } = {}): Promise<string[]> {
  if (!deps.enabled()) return [];
  const timeZone = deps.timeZone ?? systemTimeZone();
  let list: RoutineList;
  try {
    list = await deps.list();
  } catch {
    deps.log("[routinen] Prüfung auf ausgebliebene Läufe: Liste nicht lesbar");
    list = { available: false, source: null, routines: [], notes: [] };
  }
  const now = deps.now();
  const routines = list.routines.filter(watchable);
  const others = list.routines.filter(r => !watchable(r)).map(r => r.id);
  const claim: AlertClaim = { pid: deps.pid, at: new Date(now).toISOString() };
  let due: { routine: Routine; due: number }[];
  let awakeSince = now;
  try {
    due = await deps.store.update(state => {
      awakeSince = beat(state, now, opts.reset);
      for (const id of others) if (state.routines[id]) delete state.routines[id].seenAt;
      const out: { routine: Routine; due: number }[] = [];
      for (const r of routines) {
        const st = (state.routines[r.id] ??= {});
        st.seenAt ??= claim.at;
        const series = st.series;
        if (series && (claimFresh(series.claim, now) || series.kind === "failed" || series.alertedAt)) continue;
        const running = !!st.running?.some(x => deps.alive(x.pid));
        const o = overdue(r, st, awakeSince, now, timeZone, running);
        if (!o) continue;
        // Nur vorgemerkt: beginnt oder endet ein Lauf vor dem Versand, verdrängt er die Meldung
        st.series = { kind: "missed", since: series?.since ?? claim.at, due: new Date(o.due).toISOString(), claim: { ...claim, reserved: true } };
        out.push({ routine: r, due: o.due });
      }
      return out;
    });
  } catch {
    deps.log("[routinen] Prüfung auf ausgebliebene Läufe: alerts.json nicht lesbar oder schreibbar");
    return [];
  }

  const alerted: string[] = [];
  if (!due.length) return alerted;
  let secrets: readonly SecretValue[] | null;
  try {
    secrets = deps.secrets();
  } catch {
    secrets = null;
  }
  const send = async (text: string, meta: AlertMeta): Promise<boolean> => {
    try {
      return delivered(await deps.send(text, meta));
    } catch {
      return false;
    }
  };
  for (const { routine: r, due: at } of due) {
    const name = alertName(r.id);
    // Die vorigen Sendungen können gedauert haben: Anspruch jetzt prüfen und erneuern
    // Schlief der Rechner inzwischen, beginnt die wache Zeit neu: zurückstellen bis zur neuen Frist
    let mine: AlertClaim | "held" | null;
    try {
      const t = deps.now();
      mine = await renewClaim(deps.store, r.id, claim, t, s => beat(s, t) > awakeSince);
    } catch {
      mine = null;
    }
    if (mine === "held") {
      deps.log(`[routinen] ${r.id} ausgeblieben, Meldung zurückgestellt (Rechner schlief während der Prüfung)`);
      continue;
    }
    if (!mine) {
      deps.log(`[routinen] ${r.id} ausgeblieben, Meldung entfällt (Anspruch nicht mehr beim Bot)`);
      continue;
    }
    const ok = await send(missedText({ name, dueText: whenText(at, { now, timeZone }), logPath: r.errorLogPath ?? r.logPath, home: deps.home, secrets }), { id: r.id, kind: "missed" });
    let recover = false;
    try {
      recover = await finishClaim(deps.store, r.id, mine, ok, deps.now());
    } catch {
      deps.log(`[routinen] ${r.id}: Meldezustand nicht gespeichert`);
    }
    deps.log(ok ? `[routinen] ${r.id} ausgeblieben, gemeldet` : `[routinen] ${r.id} ausgeblieben, Meldung nicht zugestellt`);
    if (ok) alerted.push(r.id);
    // Inzwischen lief die Routine erfolgreich: Entwarnung zur eben zugestellten Meldung
    if (recover) deps.log(`[routinen] ${r.id} läuft wieder, ${(await send(recoveredText(name, secrets), { id: r.id, kind: "recovered" })) ? "entwarnt" : "Entwarnung nicht zugestellt"}`);
  }
  return alerted;
}

export interface RoutineWatch {
  stop(): void;
  /** Läuft gerade eine Prüfung, das Versprechen auf ihr Ende (für Tests) */
  idle(): Promise<void>;
}

/**
 * Startet die Prüfung: sofort einmal mit zurückgesetztem Herzschlag, dann alle
 * WATCH_INTERVAL_MS. Überlappt nie; stop hält den Zeitgeber an.
 */
export function startRoutineWatch(deps: WatchDeps, o: { intervalMs?: number; setInterval?: typeof setInterval; clearInterval?: typeof clearInterval } = {}): RoutineWatch {
  let running: Promise<void> | null = null;
  let stopped = false;
  const tick = (reset: boolean) => {
    if (stopped || running) return;
    running = watchTick(deps, { reset })
      .then(() => {})
      .catch(() => {})
      .finally(() => {
        running = null;
      });
  };
  tick(true);
  const set = o.setInterval ?? setInterval;
  const clear = o.clearInterval ?? clearInterval;
  const timer = set(() => tick(false), o.intervalMs ?? WATCH_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  return {
    stop() {
      stopped = true;
      clear(timer);
    },
    idle: () => running ?? Promise.resolve(),
  };
}

/** Abhängigkeiten im Bot: launchd-Übersicht, alerts.json, Outbox (die .env ist geladen), Masken aus der .env */
export function defaultWatchDeps(projectRoot: string, env: Record<string, string | undefined> = process.env): WatchDeps {
  const routinesDeps = defaultRoutinesDeps(projectRoot, env);
  return {
    store: fileAlertsStore(projectRoot),
    list: () => listRoutines(routinesDeps),
    send: async text => {
      const { defaultOutboxDeps, sendAndRecord } = await import("../outbox");
      return sendAndRecord({ source: ALERT_SOURCE, text, format: "plain" }, defaultOutboxDeps(env));
    },
    now: () => Date.now(),
    pid: process.pid,
    home: routinesDeps.home,
    enabled: () => alertsEnabled(env),
    secrets: () => {
      try {
        return projectSecretsOrThrow(projectRoot, env);
      } catch {
        return null;
      }
    },
    alive: pidAlive,
    log: line => console.log(line),
  };
}
