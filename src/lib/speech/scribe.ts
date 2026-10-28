/**
 * ElevenLabs Scribe als Erkenner des Telefonhörers (Issue #279), über die
 * Realtime-Schnittstelle:
 * wss://api.elevenlabs.io/v1/speech-to-text/realtime mit model_id
 * scribe_v2_realtime, audio_format pcm_16000 (PCM16 LE mono 16 kHz, genau
 * wie es aus dem Browser kommt), commit_strategy manual und language_code,
 * wenn eine Sprache eingestellt ist (sonst erkennt Scribe sie selbst).
 *
 * Warum Realtime und nicht Batch (POST /v1/speech-to-text mit WAV):
 * gemessen am 2.10.2026 im Takt des Telefonhörers
 * (scripts/scribe-transport-measure.ts, zwei Reihen zu je 20 Läufen, Pull
 * Request zu Issue #279). Ab utterance_pause bis zum Text Realtime im
 * Median 0,23 s, Batch 0,54 s bzw. 0,67 s; was nach utterance_end noch zu
 * warten blieb, Realtime nie etwas, Batch im Median 0,04 s bzw. 0,17 s und
 * bis 0,58 s.
 *
 * Ablauf je Gespräch: eine Verbindung, schon beim Öffnen aufgebaut (warm).
 * push schickt jedes Stück der Äußerung, sobald es da ist; transcribe
 * (bei utterance_pause bzw. utterance_end) committet, was seit dem letzten
 * Commit kam, und wartet auf alle Abschnitte der Äußerung. Kommt nach der
 * Pause weitere Sprache, bleibt der erste Abschnitt gültig, der Commit bei
 * utterance_end liefert den Rest; der Text ist beides zusammen.
 * newUtterance beginnt die nächste Äußerung. Hängt dabei noch etwas
 * (Stücke ohne Commit, ausstehende Antworten), wird die Verbindung
 * verworfen und beim nächsten Stück neu aufgebaut: so gehört nie ein
 * Abschnitt zur falschen Äußerung. Schließt der Server eine ruhende
 * Verbindung, baut das nächste Stück sie ebenso neu auf.
 *
 * Fehler werfen SpeechError ohne Inhalt: unavailable (kein Schlüssel),
 * http (401 bei Anmeldefehlern, 429 bei Kontingent und Drosselung),
 * network (Verbindung scheitert oder bricht mitten in der Äußerung ab),
 * format (sonstiger Fehler des Servers), timeout (Abbruch über signal),
 * empty (kein Text: nichts gehört). Ein Fehler gilt für die laufende
 * Äußerung; die nächste versucht es neu.
 *
 * Nur der Telefonhörer nutzt das. Telegram und der Sprechmodus erkennen
 * mit ElevenLabs weiter wie vor Issue #279 (scribe_v1, ./providers.ts).
 */

import { SpeechError } from "./types";

/** Modell für den Telefonhörer (laut Doku vom 2.10.2026 das Realtime-Modell) */
export const CALL_SCRIBE_MODEL = "scribe_v2_realtime";
export const SCRIBE_REALTIME_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
/** Abtastrate der Äußerung aus dem Browser */
const SCRIBE_SAMPLE_RATE = 16_000;
/**
 * Sekunden Ton seit der letzten bekannten Grenze, ab denen ein eigener
 * Commit nicht mehr sicher zuzuordnen ist (siehe Kopf): mit Abstand unter
 * den etwa 36 Sekunden des Servers, der Rest deckt die Laufzeit der
 * Antwort auf einen automatischen Commit
 */
export const AUTO_COMMIT_RISK = 30;
/** Dasselbe in Bytes PCM16 */
const AUTO_COMMIT_RISK_BYTES = AUTO_COMMIT_RISK * SCRIBE_SAMPLE_RATE * 2;

/** Was der Telefonhörer von einer WebSocket-Verbindung braucht (Bun-WebSocket oder Attrappe) */
export interface ScribeSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (ev: { data?: unknown }) => void): void;
}

/** Verbindung aufbauen; der Schlüssel geht als Kopfzeile, nie in die Adresse */
export type ScribeConnect = (url: string, key: string) => ScribeSocket;

export const connectScribe: ScribeConnect = (url, key) =>
  // Bun erlaubt Kopfzeilen beim WebSocket-Client
  new WebSocket(url, { headers: { "xi-api-key": key } } as unknown as string[]) as unknown as ScribeSocket;

export interface ScribeStreamOptions {
  key: string;
  /** Sprachcode aus zwei Kleinbuchstaben; fehlt: Scribe erkennt die Sprache */
  language?: string;
  connect?: ScribeConnect;
}

/** Erkennen im Telefonhörer über eine Verbindung je Gespräch (siehe Kopf) */
export interface ScribeStream {
  /** Verbindung schon jetzt aufbauen (beim Öffnen des Gesprächs) */
  warm(): void;
  /** Ein Stück der laufenden Äußerung, PCM16 LE mono 16 kHz */
  push(pcm: Uint8Array): void;
  /** Die nächste Äußerung beginnt */
  newUtterance(): void;
  /** Text der Äußerung bis jetzt; wirft SpeechError (siehe Kopf) */
  transcribe(signal: AbortSignal): Promise<string>;
  /** Verbindung beenden; danach geht nichts mehr hinaus */
  close(): void;
}

interface Pending {
  promise: Promise<string>;
  resolve(text: string): void;
  reject(e: SpeechError): void;
}

function pending(): Pending {
  let resolve!: (text: string) => void;
  let reject!: (e: SpeechError) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Abschnitte, auf die niemand mehr wartet, sollen keinen unbehandelten Fehler werfen
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Fehlermeldung des Servers als SpeechError, ohne Inhalt */
function serverError(type: string): SpeechError {
  if (/auth/i.test(type)) return new SpeechError("http", 401);
  if (/quota|rate|throttl|overflow|exhausted/i.test(type)) return new SpeechError("http", 429);
  return new SpeechError("format");
}

/** Nachrichten des Servers ohne Fehlerbedeutung */
const BENIGN = new Set(["session_started", "partial_transcript", "committed_transcript", "committed_transcript_with_timestamps", "scribe_warning", "warning"]);

export function openScribeStream(o: ScribeStreamOptions): ScribeStream {
  const connect = o.connect ?? connectScribe;
  const params = new URLSearchParams({ model_id: CALL_SCRIBE_MODEL, audio_format: `pcm_${SCRIBE_SAMPLE_RATE}`, commit_strategy: "manual" });
  if (o.language && /^[a-z]{2}$/.test(o.language)) params.set("language_code", o.language);
  const url = `${SCRIBE_REALTIME_URL}?${params}`;

  let sock: ScribeSocket | null = null;
  /** Server hat die Sitzung begonnen; vorher wartet alles in queue */
  let ready = false;
  let queue: string[] = [];
  /** Commits in Reihenfolge, die auf committed_transcript warten */
  let awaiting: Pending[] = [];
  /** Abschnitte der laufenden Äußerung */
  let segments: Promise<string>[] = [];
  /** Bytes der laufenden Äußerung seit dem letzten eigenen Commit */
  let uncommitted = 0;
  /** Bytes seit der letzten bekannten Grenze (eigener oder gesehener automatischer Commit) */
  let sinceBoundary = 0;
  /** Fehler der laufenden Äußerung */
  let broken: SpeechError | null = null;
  let closed = false;

  const send = (msg: object) => {
    const data = JSON.stringify(msg);
    if (sock && ready) sock.send(data);
    else queue.push(data);
  };

  /** Verbindung verwerfen; ausstehende Abschnitte scheitern mit err */
  function drop(err: SpeechError): void {
    const s = sock;
    sock = null;
    ready = false;
    queue = [];
    for (const p of awaiting) p.reject(err);
    awaiting = [];
    try {
      s?.close();
    } catch {
      // schon zu
    }
  }

  /** Fehler der Verbindung: die laufende Äußerung scheitert, wenn sie schon etwas geschickt hat */
  function fail(err: SpeechError): void {
    if (uncommitted > 0 || awaiting.length > 0 || segments.length > 0) broken ??= err;
    drop(err);
  }

  function open(): void {
    if (closed || sock || !o.key) return;
    let s: ScribeSocket;
    try {
      s = connect(url, o.key);
    } catch {
      fail(new SpeechError("network"));
      return;
    }
    sock = s;
    ready = false;
    s.addEventListener("message", ev => {
      if (sock !== s) return;
      let msg: { message_type?: unknown; text?: unknown };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        fail(new SpeechError("format"));
        return;
      }
      const type = typeof msg.message_type === "string" ? msg.message_type : "";
      if (type === "session_started") {
        ready = true;
        for (const data of queue) s.send(data);
        queue = [];
      } else if (type === "committed_transcript") {
        const text = typeof msg.text === "string" ? msg.text.trim() : "";
        const own = awaiting.shift();
        if (own) own.resolve(text);
        else if (uncommitted > 0) {
          // Automatischer Commit des Servers: Abschnitt der laufenden Äußerung
          segments.push(Promise.resolve(text));
          sinceBoundary = 0;
        } else {
          // Weder Commit noch Ton passt: eine frühere Antwort war falsch zugeordnet
          fail(new SpeechError("format"));
        }
      } else if (!BENIGN.has(type) && /error|exceeded|limited|throttled|overflow|exhausted/i.test(type)) {
        fail(serverError(type));
      }
    });
    s.addEventListener("error", () => {
      if (sock === s) fail(new SpeechError("network"));
    });
    s.addEventListener("close", () => {
      if (sock !== s) return;
      // Ruhende Verbindung zu: beim nächsten Stück neu; mitten in der Äußerung: Fehler
      if (uncommitted > 0 || awaiting.length > 0) fail(new SpeechError("network"));
      else drop(new SpeechError("network"));
    });
  }

  function commit(): void {
    if (sinceBoundary >= AUTO_COMMIT_RISK_BYTES) {
      // Der Server könnte kurz vorher selbst committet haben: nicht sicher zuzuordnen
      fail(new SpeechError("format"));
      return;
    }
    const p = pending();
    awaiting.push(p);
    segments.push(p.promise);
    uncommitted = 0;
    sinceBoundary = 0;
    send({ message_type: "input_audio_chunk", audio_base_64: "", commit: true, sample_rate: SCRIBE_SAMPLE_RATE });
  }

  return {
    warm: open,
    push(pcm) {
      if (closed || !o.key || broken || !pcm.length) return;
      // Erst zählen, dann verbinden: scheitert der Aufbau, scheitert diese Äußerung
      uncommitted += pcm.length;
      sinceBoundary += pcm.length;
      open();
      if (broken) return;
      send({ message_type: "input_audio_chunk", audio_base_64: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64"), commit: false, sample_rate: SCRIBE_SAMPLE_RATE });
    },
    newUtterance() {
      // Hängt noch etwas der alten Äußerung, darf es nicht in die neue rutschen
      if (uncommitted > 0 || awaiting.length > 0) drop(new SpeechError("timeout"));
      segments = [];
      uncommitted = 0;
      sinceBoundary = 0;
      broken = null;
    },
    async transcribe(signal) {
      if (!o.key) throw new SpeechError("unavailable");
      if (signal.aborted) throw new SpeechError("timeout");
      if (broken) throw broken;
      if (closed) throw new SpeechError("network");
      if (uncommitted > 0) commit();
      if (broken) throw broken;
      if (!segments.length) throw new SpeechError("empty");
      const all = Promise.all(segments);
      const texts = await new Promise<string[]>((resolve, reject) => {
        const onAbort = () => reject(new SpeechError("timeout"));
        signal.addEventListener("abort", onAbort, { once: true });
        all.then(
          t => {
            signal.removeEventListener("abort", onAbort);
            resolve(t);
          },
          e => {
            signal.removeEventListener("abort", onAbort);
            reject(e instanceof SpeechError ? e : new SpeechError("network"));
          }
        );
      });
      const text = texts.filter(Boolean).join(" ").trim();
      if (!text) throw new SpeechError("empty");
      return text;
    },
    close() {
      if (closed) return;
      closed = true;
      drop(new SpeechError("timeout"));
    },
  };
}
