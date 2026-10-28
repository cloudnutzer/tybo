/**
 * Telefonhörer im Server (Issue #257, Entscheidung 0024): stehende
 * WebSocket-Verbindung GET /api/call hinter dem WebUI-Login.
 *
 * - Vor dem Upgrade prüft server.ts Host, Tunnel- bzw. Access-Nachweis,
 *   Sitzung (nur Browser, kein Terminal-Schlüssel) und ausdrücklich den
 *   Origin, auch wenn der Handshake ein GET ist. Sonst 401 bzw. 403 ohne
 *   Upgrade.
 * - Grenzen: ein Gespräch zur Zeit pro Installation (zweites: Schließcode
 *   4409 „besetzt“), höchstens 6 Gesprächsstarts in 10 Minuten (4029
 *   „zu-viele“), 60 Minuten je Gespräch, Ende nach 2 Minuten ohne Sprache.
 *   Binäre Nachricht höchstens 64 KB, Äußerung höchstens 60 s, JSON höchstens
 *   4 KB; unbekannte oder zu große Nachrichten schließen die Verbindung.
 *   Alle 25 s ein Ping (Cloudflare trennt stille Verbindungen nach 100 s);
 *   dabei wird auch die Sitzung geprüft (Abmelden, Ablauf).
 * - Das Gespräch selbst ist ./call-session.ts. Modell, Erkenner und Stimme
 *   kommen über CallPort herein (in bot.ts ./bot-call.ts), damit der
 *   Web-Server nichts aus src/lib lädt.
 *
 * Protokoll (Tabelle in docs/webui/telefonhoerer-protokoll.md):
 * Browser → Server, Text: start, utterance_pause, utterance_end, interrupt,
 * played, mute, hangup. Binär: PCM16 LE mono 16 kHz, nur während der Nutzer
 * spricht. Server → Browser, Text: ready, state, transcript, sentence,
 * audio_begin, audio_end, tool, notice, error, ended. Binär: PCM16 LE mono
 * in CALL_SAMPLE_RATE, jeweils zwischen audio_begin und audio_end.
 */

import type { CallHistoryPort } from "./call-history";
import { CallSession, type CallSocket } from "./call-session";
import { CALL_CLOSE, CALL_LIMITS, CALL_TEXT, realClock, type CallApprovalWatch, type CallClock, type CallConversationCheck, type CallDeepTaskPort, type CallPort } from "./call-protocol";

export * from "./call-protocol";

// ---------------------------------------------------------------------------
// Verbindungen
// ---------------------------------------------------------------------------

/** Was beim Upgrade an der Verbindung hängt */
export interface CallSocketData {
  /** Hash der Sitzung (Abmelden beendet Gespräche dieser Sitzung) */
  session: string;
  isAuthorized(): boolean;
  /** Platz im Manager, vergeben beim Öffnen */
  call?: CallConnection;
}

/** Was call.ts von Buns ServerWebSocket braucht (Tests reichen eine Attrappe) */
export interface RawCallSocket {
  data: CallSocketData;
  send(data: string | Uint8Array): number;
  close(code?: number, reason?: string): void;
  ping?(): void;
  getBufferedAmount?(): number;
}

export interface CallConnection {
  session: CallSession;
  drained(): void;
  message(data: string | Buffer): void;
  closed(): void;
}

export interface CallManagerOptions {
  port: CallPort;
  checkConversation: CallConversationCheck;
  log: (line: string) => void;
  clock?: CallClock;
  /** Issue #259: Denkauftrag und Freigaben (siehe CallSessionOptions) */
  deepTask?: CallDeepTaskPort;
  approvals?: CallApprovalWatch;
  /** Issue #260: Verlauf im Gespräch (siehe CallSessionOptions) */
  history?: CallHistoryPort;
}

/**
 * Hält die Gespräche der Installation: ein Platz, Startbremse, Abmelden und
 * Stopp. Bun.serve ruft open/message/close/drain, server.ts reicht sie durch.
 */
export function createCallManager(o: CallManagerOptions) {
  const clock = o.clock ?? realClock;
  const starts: number[] = [];
  let current: { ws: RawCallSocket; conn: CallConnection } | null = null;
  let stopping = false;

  function takeStart(): boolean {
    const t = clock.now();
    while (starts.length && t - starts[0] >= CALL_LIMITS.startWindowMs) starts.shift();
    if (starts.length >= CALL_LIMITS.starts) return false;
    starts.push(t);
    return true;
  }

  function open(ws: RawCallSocket): void {
    if (stopping) {
      ws.close(CALL_CLOSE.goingAway, "server");
      return;
    }
    // Platz vor allem Asynchronen belegen; besetzt zählt nicht als Start
    if (current) {
      o.log("Telefonhörer: zweites Gespräch abgelehnt (besetzt)");
      ws.close(CALL_CLOSE.busy, CALL_TEXT.busy);
      return;
    }
    if (!takeStart()) {
      o.log("Telefonhörer: Start abgelehnt (mehr als 6 in 10 Minuten)");
      ws.close(CALL_CLOSE.tooMany, CALL_TEXT.tooMany);
      return;
    }
    const socket: CallSocket = {
      send: data => ws.send(data),
      bufferedAmount: () => ws.getBufferedAmount?.() ?? 0,
      close: (code, reason) => ws.close(code, reason),
      ping: () => ws.ping?.(),
      isAuthorized: () => ws.data.isAuthorized(),
    };
    const session = new CallSession({
      socket,
      port: o.port,
      checkConversation: o.checkConversation,
      clock,
      log: o.log,
      ...(o.deepTask ? { deepTask: o.deepTask } : {}),
      ...(o.approvals ? { approvals: o.approvals } : {}),
      ...(o.history ? { history: o.history } : {}),
      onEnd: () => {
        if (current?.conn === conn) current = null;
      },
    });
    const conn: CallConnection = {
      session,
      drained: () => session.drained(),
      message: data => session.receive(data),
      closed: () => session.socketClosed(),
    };
    ws.data.call = conn;
    current = { ws, conn };
    session.begin();
  }

  return {
    open,
    message(ws: RawCallSocket, data: string | Buffer) {
      ws.data.call?.message(data);
    },
    close(ws: RawCallSocket) {
      ws.data.call?.closed();
    },
    drain(ws: RawCallSocket) {
      ws.data.call?.drained();
    },
    /** Abmelden: Gespräche dieser Sitzung enden */
    endSession(sessionHash: string) {
      if (current && current.ws.data.session === sessionHash) current.conn.session.end("abgemeldet");
    },
    /** Server stoppt: Gespräch beenden, keine neuen */
    stopAll() {
      stopping = true;
      current?.conn.session.end("server");
    },
    activeCount: () => (current ? 1 : 0),
  };
}

export type CallManager = ReturnType<typeof createCallManager>;
