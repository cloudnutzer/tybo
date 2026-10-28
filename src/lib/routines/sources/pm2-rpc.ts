/**
 * Prozessliste direkt vom laufenden PM2-Daemon (Issue #284), ohne PM2-CLI.
 *
 * Jeder Aufruf der PM2-CLI (auch `pm2 jlist` und `pm2 ping`) startet einen
 * neuen Daemon, wenn keiner antwortet (Client.start in PM2). Eine Vorprüfung
 * davor (pm2.pid, Socket) schließt das nie ganz aus: Die PID kann veraltet
 * sein, und der Daemon kann zwischen Prüfung und Abfrage enden. Darum fragt
 * tybo den Daemon selbst über seinen RPC-Socket: Verbindung, Anfrage und
 * Antwort sind ein einziger Schritt, und ein Socket-Aufbau startet nie
 * etwas. Antwortet niemand, heißt das „PM2 läuft nicht", sonst nichts.
 *
 * Abgefragt wird `getMonitorData`, dieselbe Methode, die `pm2 jlist` nutzt.
 * Protokoll: axon req/rep mit AMP-Rahmen (ein Kopf-Byte Version << 4 | Anzahl
 * der Teile, je Teil 4 Byte Länge und Inhalt; Inhalt "j:<JSON>" oder
 * "s:<Text>"). Anfrage [{type:"call", method, args:[{}]}, "<id>"], Antwort
 * [{args:[liste]} oder {error}, "<id>"].
 */

import { connect } from "node:net";
import { join } from "node:path";

export type Pm2Query = { status: "ok"; processes: unknown[] } | { status: "not-running" } | { status: "failed" };

/** Socket des PM2-Daemons: PM2_HOME/rpc.sock, unter Windows eine feste Named Pipe (paths.js in PM2) */
export function pm2RpcSocketPath(platform: NodeJS.Platform, pm2Home: string): string {
  return platform === "win32" ? "\\\\.\\pipe\\rpc.sock" : join(pm2Home, "rpc.sock");
}

const AMP_VERSION = 1;

function packArg(arg: unknown): Buffer {
  return Buffer.from(typeof arg === "string" ? `s:${arg}` : `j:${JSON.stringify(arg ?? null)}`);
}

export function encodeAmp(args: unknown[]): Buffer {
  const parts = args.map(packArg);
  const head = Buffer.from([(AMP_VERSION << 4) | parts.length]);
  const framed = parts.flatMap(p => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(p.length, 0);
    return [len, p];
  });
  return Buffer.concat([head, ...framed]);
}

function unpackArg(buf: Buffer): unknown {
  const tag = buf.subarray(0, 2).toString();
  if (tag === "j:") return JSON.parse(buf.subarray(2).toString());
  if (tag === "s:") return buf.subarray(2).toString();
  return buf;
}

/**
 * Eine vollständige AMP-Nachricht vom Anfang des Puffers; null, solange
 * noch Bytes fehlen.
 */
export function decodeAmp(buf: Buffer): { args: unknown[]; rest: Buffer } | null {
  if (buf.length < 1) return null;
  const argc = buf[0] & 0x0f;
  let off = 1;
  const args: unknown[] = [];
  for (let i = 0; i < argc; i++) {
    if (buf.length < off + 4) return null;
    const len = buf.readUInt32BE(off);
    off += 4;
    if (buf.length < off + len) return null;
    args.push(unpackArg(buf.subarray(off, off + len)));
    off += len;
  }
  return { args, rest: buf.subarray(off) };
}

/** Fehler beim Verbindungsaufbau, die heißen: Hier lauscht kein Daemon */
const NO_DAEMON = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK", "ENOTDIR"]);

/**
 * Fragt den Daemon an socketPath nach seiner Prozessliste. Startet nie
 * einen Prozess; nach timeoutMs ohne Antwort gilt die Abfrage als
 * gescheitert.
 */
export function queryPm2Daemon(socketPath: string, timeoutMs = 5_000): Promise<Pm2Query> {
  return new Promise(resolve => {
    const id = `tybo-${process.pid}:0`;
    let connected = false;
    let settled = false;
    let buf: Buffer = Buffer.alloc(0);
    const sock = connect({ path: socketPath });
    const finish = (result: Pm2Query) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: "failed" }), timeoutMs);
    sock.on("connect", () => {
      connected = true;
      sock.write(encodeAmp([{ type: "call", method: "getMonitorData", args: [{}] }, id]));
    });
    sock.on("data", chunk => {
      buf = Buffer.concat([buf, chunk]);
      let msg: ReturnType<typeof decodeAmp>;
      try {
        msg = decodeAmp(buf);
      } catch {
        return finish({ status: "failed" });
      }
      if (!msg) return;
      buf = msg.rest;
      const [reply, replyId] = msg.args;
      if (replyId !== id) return;
      const list = (reply as { args?: unknown[] } | null)?.args?.[0];
      finish(Array.isArray(list) ? { status: "ok", processes: list } : { status: "failed" });
    });
    sock.on("error", (e: NodeJS.ErrnoException) => finish(!connected && NO_DAEMON.has(e.code ?? "") ? { status: "not-running" } : { status: "failed" }));
    // Daemon schließt die Verbindung vor der Antwort (etwa weil er gerade endet)
    sock.on("close", () => finish(connected ? { status: "failed" } : { status: "not-running" }));
  });
}
