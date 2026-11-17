/**
 * Meldung bei verlorener Registrierung der SIP-Vermittlung (Issue #511).
 *
 * Ein Ausfall wird genau einmal gemeldet, die Erholung danach auch einmal.
 * Der Zustand liegt in data/sip-vermittlung/zustand.json und überlebt
 * Neustarts von tybo. Als Ausfall zählen "nicht-registriert" und
 * "unerreichbar", aber erst ab FAILURE_THRESHOLD Abfragen hintereinander:
 * ein einzelner Aussetzer der SSH-Verbindung meldet nichts.
 *
 * Reihenfolge im Aufrufer: bewerten, senden, und nur wenn das Senden geklappt
 * hat, "gemeldet" speichern. Scheitert das Senden, versucht es der nächste
 * Lauf noch einmal.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeStatus, type RelayStatus } from "./status";

/** So viele Fehlschläge hintereinander, bevor gemeldet wird */
export const FAILURE_THRESHOLD = 2;

export interface WatchState {
  version: 1;
  /** Fehlschläge hintereinander */
  failures: number;
  /** Ausfall gemeldet und noch nicht entwarnt */
  alerted: boolean;
  /** ISO-Zeitpunkt der ersten Abfrage dieser Fehlerserie */
  since: string | null;
}

export const INITIAL_STATE: WatchState = { version: 1, failures: 0, alerted: false, since: null };

export function statePath(root: string): string {
  return join(root, "data", "sip-vermittlung", "zustand.json");
}

/** Gespeicherten Zustand lesen; fehlt er oder ist er beschädigt, gilt der Anfangszustand */
export function readWatchState(path: string): WatchState {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<WatchState> | null;
    if (!data || data.version !== 1 || typeof data.failures !== "number" || typeof data.alerted !== "boolean") return { ...INITIAL_STATE };
    return { version: 1, failures: Math.max(0, Math.floor(data.failures)), alerted: data.alerted, since: typeof data.since === "string" ? data.since : null };
  } catch {
    return { ...INITIAL_STATE };
  }
}

export interface WatchDecision {
  /** Zustand, wenn eine anstehende Meldung zugestellt wurde (oder keine ansteht) */
  next: WatchState;
  /** Zustand, wenn die Meldung nicht zugestellt werden konnte */
  ifUndelivered: WatchState;
  /** Meldungstext oder null */
  message: string | null;
}

/** Nächster Zustand und ob gemeldet wird */
export function evaluateWatch(prev: WatchState, status: RelayStatus, now: Date): WatchDecision {
  if (status.state === "nicht-eingerichtet") {
    return { next: { ...INITIAL_STATE }, ifUndelivered: { ...INITIAL_STATE }, message: null };
  }
  if (status.state === "registriert") {
    const next = { ...INITIAL_STATE };
    if (!prev.alerted) return { next, ifUndelivered: next, message: null };
    return {
      next,
      ifUndelivered: prev,
      message: "Die SIP-Vermittlung ist wieder bei easybell registriert. Anrufe auf die Nummer kommen wieder beim Sprachagenten an.",
    };
  }
  const failing: WatchState = { version: 1, failures: prev.failures + 1, alerted: prev.alerted, since: prev.since ?? now.toISOString() };
  if (prev.alerted || failing.failures < FAILURE_THRESHOLD) return { next: failing, ifUndelivered: failing, message: null };
  const message = [
    `Die SIP-Vermittlung ist ${status.state === "unerreichbar" ? "nicht erreichbar" : "nicht bei easybell registriert"}: ${describeStatus(status, now.getTime())}.`,
    "Anrufe auf die easybell-Nummer erreichen den Sprachagenten nicht, und /anruf über diesen Weg geht nicht.",
    "Diese Meldung kommt einmal; die Entwarnung folgt, sobald die Registrierung wieder steht.",
  ].join(" ");
  return { next: { ...failing, alerted: true }, ifUndelivered: failing, message };
}

