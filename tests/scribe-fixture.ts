/**
 * Attrappe der Realtime-Schnittstelle von ElevenLabs Scribe (Issue #279):
 * kein Netz, kein Aufruf bei ElevenLabs. Antwortet je Commit der Reihe nach
 * aus replies. Mit autoCommitBytes committet sie wie der Server selbst,
 * sobald seit dem letzten Commit so viel Ton kam, und antwortet darauf aus
 * autoReplies.
 */

import type { ScribeConnect, ScribeSocket } from "../src/lib/speech/scribe";

/** Antwort auf einen Commit: Text, Fehlermeldung des Servers, keine Antwort, Verbindung zu bzw. kaputt */
export type ScribeReply = { text: string } | { error: string } | "hang" | "close" | "network";

export interface SentChunk {
  message_type: string;
  audio_base_64: string;
  commit: boolean;
  sample_rate: number;
}

export interface FakeScribeSocket extends ScribeSocket {
  url: string;
  key: string;
  sent: SentChunk[];
  closed: boolean;
  emit(type: "open" | "message" | "error" | "close", data?: unknown): void;
}

export function fakeScribe(o: { start?: boolean; autoCommitBytes?: number } = {}) {
  const sockets: FakeScribeSocket[] = [];
  const replies: ScribeReply[] = [];
  const autoReplies: ScribeReply[] = [];
  const connect: ScribeConnect = (url, key) => {
    const listeners: Record<string, ((ev: { data?: unknown }) => void)[]> = {};
    /** Ton seit dem letzten Commit beim Server */
    let buffered = 0;
    const answer = (reply: ScribeReply) =>
      queueMicrotask(() => {
        if (sock.closed) return;
        if (reply === "hang") return;
        if (reply === "close") sock.emit("close");
        else if (reply === "network") sock.emit("error");
        else if ("text" in reply) sock.emit("message", { message_type: "committed_transcript", text: reply.text });
        else sock.emit("message", { message_type: reply.error, error: "Inhalt der Fehlermeldung" });
      });
    const sock: FakeScribeSocket = {
      url,
      key,
      sent: [],
      closed: false,
      addEventListener(type, fn) {
        (listeners[type] ??= []).push(fn);
      },
      emit(type, data) {
        for (const fn of listeners[type] ?? []) fn(data === undefined ? {} : { data: typeof data === "string" ? data : JSON.stringify(data) });
      },
      send(data) {
        if (sock.closed) throw new Error("zu");
        const msg = JSON.parse(data) as SentChunk;
        sock.sent.push(msg);
        if (!msg.commit) {
          buffered += Buffer.from(msg.audio_base_64, "base64").length;
          if (o.autoCommitBytes && buffered >= o.autoCommitBytes) {
            buffered = 0;
            answer(autoReplies.shift() ?? "hang");
          }
          return;
        }
        buffered = 0;
        answer(replies.shift() ?? "hang");
      },
      close() {
        sock.closed = true;
      },
    };
    sockets.push(sock);
    if (o.start !== false) queueMicrotask(() => sock.emit("message", { message_type: "session_started", session_id: "s" }));
    return sock;
  };
  /** Alle Commits über alle Verbindungen */
  const commits = () => sockets.flatMap(s => s.sent.filter(m => m.commit));
  /** Ton, der bei ElevenLabs ankam (ohne Commits) */
  const audioBytes = () => sockets.reduce((n, s) => n + s.sent.filter(m => !m.commit).reduce((k, m) => k + Buffer.from(m.audio_base_64, "base64").length, 0), 0);
  return { connect, sockets, replies, autoReplies, commits, audioBytes };
}
