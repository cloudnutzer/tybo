/**
 * Lebenszeichen zwischen Server und eigenem Rechner (Issue #353, Hybrid).
 *
 * Der eigene Rechner (Profil peer) schreibt alle 30 Sekunden einen
 * Herzschlag in die gemeinsame Datenbank (Tabelle node_heartbeat, Knoten
 * HYBRID_NODE_ID, Standard "local"). Der Server liest ihn höchstens alle 15
 * Sekunden, nie pro Nachricht, und hält das Ergebnis samt Zeitpunkt des
 * Herzschlags dazwischen fest. Gesund heißt: letzter Herzschlag jünger als
 * 90 Sekunden, auch zwischen zwei Abfragen gerechnet. Ein Lesefehler zählt
 * als nicht gesund.
 *
 * Lehnt der Rechner sicher ab (etwa 503 beim Herunterfahren), setzt der
 * Server ihn mit markDown() sofort auf nicht gesund, bis zur nächsten
 * Abfrage. Nach stop() schreibt bzw. liest keiner der beiden mehr.
 */
import type { NodeStatus } from "../store/types";

export const HEARTBEAT_EVERY_MS = 30_000;
export const PEER_MAX_AGE_MS = 90_000;
export const STATUS_REFRESH_MS = 15_000;
export const DEFAULT_NODE_ID = "local";

/** Der Teil des TaskStore, den der Herzschlag braucht */
export interface HeartbeatStore {
  heartbeat(nodeId: string, metadata?: Record<string, unknown>): Promise<boolean>;
  nodeStatus(nodeId: string, maxAgeMs: number): Promise<NodeStatus>;
}

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** Knotenkennung aus der env; leer heißt "local" */
export function nodeIdFrom(raw: string | undefined): string {
  return (raw ?? "").trim() || DEFAULT_NODE_ID;
}

export interface PeerBeat {
  stop(): void;
}

/** Herzschlag des eigenen Rechners: sofort einmal, dann alle 30 Sekunden */
export function startPeerBeat(deps: {
  store: () => HeartbeatStore;
  nodeId: string;
  timers?: Timers;
  everyMs?: number;
  log?: (line: string) => void;
}): PeerBeat {
  const timers = deps.timers ?? realTimers;
  const log = deps.log ?? (line => console.error(line));
  let running = true;
  let warned = false;
  const beat = () => {
    if (!running) return;
    // Fehler einmal je Serie melden, nicht alle 30 Sekunden
    Promise.resolve()
      // stop() kann zwischen Einplanen und Ausführen gelaufen sein
      .then(() => (running ? deps.store().heartbeat(deps.nodeId, { profile: "peer" }) : null))
      .then(
        ok => {
          if (ok === null) return;
          if (ok) warned = false;
          else if (!warned) {
            warned = true;
            log(`[hybrid] Herzschlag für ${deps.nodeId} nicht gespeichert`);
          }
        },
        error => {
          if (warned) return;
          warned = true;
          log(`[hybrid] Herzschlag für ${deps.nodeId} gescheitert (${error instanceof Error ? error.message : String(error)})`);
        },
      );
  };
  beat();
  const handle = timers.setInterval(beat, deps.everyMs ?? HEARTBEAT_EVERY_MS);
  return {
    stop() {
      if (!running) return;
      running = false;
      timers.clearInterval(handle);
    },
  };
}

export interface PeerWatch {
  /** Gilt der eigene Rechner als gesund? Liest höchstens alle 15 Sekunden neu */
  healthy(): Promise<boolean>;
  /** Sichere Ablehnung erlebt: bis zur nächsten Abfrage nicht gesund */
  markDown(): void;
  stop(): void;
}

/** Sicht des Servers auf den eigenen Rechner */
export function watchPeer(deps: {
  store: () => HeartbeatStore;
  nodeId: string;
  now?: () => number;
  refreshMs?: number;
  maxAgeMs?: number;
}): PeerWatch {
  const now = deps.now ?? Date.now;
  const refreshMs = deps.refreshMs ?? STATUS_REFRESH_MS;
  const maxAgeMs = deps.maxAgeMs ?? PEER_MAX_AGE_MS;
  let stopped = false;
  // until: gesund bis ausschließlich zu diesem Zeitpunkt (Herzschlag plus 90 s), 0 heißt nicht gesund
  let known: { until: number; at: number } | null = null;
  let reading: Promise<boolean> | null = null;

  const read = async (): Promise<number> => {
    try {
      const status = await deps.store().nodeStatus(deps.nodeId, maxAgeMs);
      // Ohne lesbaren Zeitpunkt lässt sich die Frist nicht rechnen: nicht gesund
      const beatAt = status.lastHeartbeat ? Date.parse(status.lastHeartbeat) : NaN;
      return status.online === true && Number.isFinite(beatAt) ? beatAt + maxAgeMs : 0;
    } catch {
      return 0;
    }
  };
  const fresh = (until: number) => now() < until;

  return {
    healthy() {
      if (stopped) return Promise.resolve(false);
      if (known && now() - known.at < refreshMs) return Promise.resolve(fresh(known.until));
      // Gleichzeitige Nachrichten teilen sich eine Abfrage
      reading ??= read().then(until => {
        reading = null;
        if (!stopped) known = { until, at: now() };
        return fresh(until) && !stopped;
      });
      return reading;
    },
    markDown() {
      known = { until: 0, at: now() };
    },
    stop() {
      stopped = true;
      known = null;
    },
  };
}
