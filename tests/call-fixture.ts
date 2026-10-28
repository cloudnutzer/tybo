/**
 * Attrappen für den Telefonhörer (Issue #257): CallPort, CallLine, Uhr und
 * Socket. Kein Test selbst. Kein echtes Modell, kein sherpa-onnx, keine
 * Stimme.
 */
import type { CallClock, CallLine, CallLineInfo, CallModeStatus, CallPort, CallRecognition, CallTurnEvent, CallTurnRecord } from "../src/web/call";
import type { CallSocket } from "../src/web/call-session";

export const LINE_INFO: CallLineInfo = { model: "claude-sonnet-5-5", via: "api", stt: "parakeet", tts: "server", sampleRate: 24_000, sttWarm: true };

export const READY_STATUS: CallModeStatus = {
  ready: true,
  model: "claude-sonnet-5-5",
  via: "api",
  expectation: "erster Satz nach rund 1,5 Sekunden",
  stt: { id: "parakeet", local: true, warm: true },
  tts: { id: "pocket", where: "server", stream: true },
};

/** Promise, die sich von außen auflösen lässt */
export function gate<T = void>(): { promise: Promise<T>; open(value: T): void } {
  let open!: (value: T) => void;
  const promise = new Promise<T>(resolve => (open = resolve));
  return { promise, open };
}

export interface FakeLineControl {
  line: CallLine;
  records: CallTurnRecord[];
  recognized: Uint8Array[];
  /** Ergebnisse, die die Sitzung übernommen hat (adopt, Issue #279) */
  adopted: CallRecognition[];
  closed: number;
  interrupts: number;
  spoken: string[];
  turnSignals: AbortSignal[];
}

export interface FakeLineOptions {
  info?: Partial<CallLineInfo>;
  recognize?: (pcm: Uint8Array, signal: AbortSignal) => Promise<CallRecognition>;
  /** Hinweis bei Übernahme eines Ergebnisses (Issue #279) */
  adopt?: (result: CallRecognition) => string | undefined;
  turn?: (o: { userText: string; signal: AbortSignal; context?: string; deepTask?: boolean }) => AsyncIterable<CallTurnEvent>;
  speak?: ((text: string, signal: AbortSignal) => AsyncIterable<Uint8Array | import("../src/web/call-protocol").CallSpeakEvent>) | null;
}

/** Standard-Turn: zwei Abschnitte, dann fertig */
export async function* twoSegments(): AsyncGenerator<CallTurnEvent> {
  yield { type: "segment", text: "Mir geht es gut, danke." };
  yield { type: "segment", text: "Und dir?" };
  yield { type: "done", rawText: "Mir geht es gut, danke. Und dir?", spokenText: "Mir geht es gut, danke. Und dir?", aborted: false };
}

/** Standard-Stimme: zwei Stücke je Abschnitt */
export async function* twoChunks(): AsyncGenerator<Uint8Array> {
  yield new Uint8Array(960).fill(1);
  yield new Uint8Array(960).fill(2);
}

export function fakeLine(o: FakeLineOptions = {}): FakeLineControl {
  const ctl: FakeLineControl = { line: null as unknown as CallLine, records: [], recognized: [], adopted: [], closed: 0, interrupts: 0, spoken: [], turnSignals: [] };
  const speak = o.speak === null ? undefined : o.speak ?? twoChunks;
  ctl.line = {
    info: { ...LINE_INFO, ...(speak ? {} : { tts: "browser" as const }), ...o.info },
    recognize: async (pcm, signal) => {
      ctl.recognized.push(pcm);
      return o.recognize ? o.recognize(pcm, signal) : { ok: true, text: "Wie geht es dir heute?" };
    },
    adopt: r => {
      ctl.adopted.push(r);
      return o.adopt?.(r);
    },
    turn: ({ userText, signal, context, deepTask }) => {
      ctl.turnSignals.push(signal);
      return o.turn ? o.turn({ userText, signal, ...(context !== undefined ? { context } : {}), ...(deepTask !== undefined ? { deepTask } : {}) }) : twoSegments();
    },
    interrupt: async () => {
      ctl.interrupts++;
    },
    ...(speak
      ? {
          speak: (text: string, signal: AbortSignal) => {
            ctl.spoken.push(text);
            return speak(text, signal);
          },
        }
      : {}),
    onTurn: r => ctl.records.push(r),
    close: () => {
      ctl.closed++;
    },
  };
  return ctl;
}

export interface FakePortControl {
  port: CallPort;
  opened: Array<{ conversationId: string; agent: string; tts: string }>;
  turnsActive: number;
  restart: boolean;
  lines: FakeLineControl[];
  /** turnBegin liefert null (Annahme gesperrt) */
  intakeClosed: boolean;
  farewells: Set<() => Promise<void>>;
}

export function fakePort(o: { line?: () => FakeLineControl; open?: CallPort["open"]; status?: () => Promise<CallModeStatus> } = {}): FakePortControl {
  const ctl: FakePortControl = { port: null as unknown as CallPort, opened: [], turnsActive: 0, restart: false, lines: [], intakeClosed: false, farewells: new Set() };
  ctl.port = {
    status: o.status ?? (async () => READY_STATUS),
    restartPending: () => ctl.restart || ctl.intakeClosed,
    onRestart: farewell => {
      ctl.farewells.add(farewell);
      return () => ctl.farewells.delete(farewell);
    },
    turnBegin: () => {
      if (ctl.intakeClosed) return null;
      ctl.turnsActive++;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        ctl.turnsActive--;
      };
    },
    open:
      o.open ??
      (async args => {
        ctl.opened.push({ conversationId: args.conversationId, agent: args.agent, tts: args.tts });
        const l = (o.line ?? (() => fakeLine()))();
        ctl.lines.push(l);
        return l.line;
      }),
  };
  return ctl;
}

/** Uhr zum Vorspulen: Zeitgeber laufen nur über advance() */
export function fakeClock(start = 1_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  const clock: CallClock & { advance(ms: number): Promise<void>; now(): number; pending(): number } = {
    now: () => t,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout: h => {
      timers.delete(h as number);
    },
    setInterval: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn, every: ms });
      return id;
    },
    clearInterval: h => {
      timers.delete(h as number);
    },
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void; every?: number }] | null = null;
        for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
        if (!next) break;
        const [id, timer] = next;
        t = timer.at;
        if (timer.every) timer.at += timer.every;
        else timers.delete(id);
        timer.fn();
        await flush(1);
      }
      t = end;
      await flush();
    },
    pending: () => timers.size,
  };
  return clock;
}

/** Mikrotasks und einen Makrotask abwarten */
export async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

export interface SocketEvent {
  json?: Record<string, any>;
  binary?: Uint8Array;
}

/** Socket-Attrappe: zeichnet alles auf; bufferedAmount einstellbar (langsamer Empfänger) */
export function fakeSocket() {
  const events: SocketEvent[] = [];
  const state = { closed: null as null | { code: number; reason: string }, buffered: 0, pings: 0, authorized: true };
  const socket: CallSocket = {
    send: data => {
      if (state.closed) return 0;
      if (typeof data === "string") events.push({ json: JSON.parse(data) });
      else events.push({ binary: new Uint8Array(data) });
      return 1;
    },
    bufferedAmount: () => state.buffered,
    close: (code, reason) => {
      state.closed ??= { code, reason };
    },
    ping: () => {
      state.pings++;
    },
    isAuthorized: () => state.authorized,
  };
  const types = () => events.map(e => (e.json ? (e.json.type === "state" ? `state:${e.json.state}` : e.json.type) : "audio"));
  return { socket, events, state, types, json: (type: string) => events.filter(e => e.json?.type === type).map(e => e.json!) };
}

/** 20 ms PCM16 mono 16 kHz */
export function pcmFrame(value = 1000): Uint8Array {
  const b = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) b.writeInt16LE(value, i * 2);
  return new Uint8Array(b);
}
