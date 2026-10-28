/**
 * Ein Telefonhörer-Gespräch als Zustandsmaschine (Issue #257):
 * verbindet → hört zu → versteht → denkt → spricht → hört zu, dazu aufgelegt.
 *
 * - start: Gespräch prüfen, Neustart-Sperre, CallPort.open (Modellweg,
 *   Kontext, Erkenner und Stimme vorwärmen), dann ready.
 * - Äußerung: PCM16 aus dem Browser sammeln (nur im Zustand „hört zu“ und
 *   nicht stumm). utterance_pause erkennt einen unveränderlichen
 *   Schnappschuss schon in der Pause; kommt danach weitere Sprache, ist er
 *   veraltet und eine noch laufende Erkennung wird sofort abgebrochen.
 *   Je Äußerung höchstens eine solche Erkennung zur Zeit.
 *   Nur das Ergebnis, das utterance_end tatsächlich nimmt, übernimmt die
 *   Sitzung (line.adopt, Issue #279): erst dann zählt ein Fehler des
 *   Erkenners, und sein Hinweis (Rückfall von ElevenLabs Scribe auf
 *   Parakeet) geht als notice an den Browser. Veraltete oder abgebrochene
 *   Erkennungen ändern nichts, auch wenn sie schon fertig waren.
 *   Jedes angenommene Stück geht zusätzlich gleich an line.hear, jede neue
 *   Äußerung meldet line.newUtterance (Realtime-Erkennung, Issue #279).
 *   utterance_end nimmt das Pausen-Ergebnis, wenn seitdem nichts dazukam,
 *   sonst wird die ganze Aufnahme erkannt. Leer, zu kurz oder nur Füllwort:
 *   notice „nichts verstanden“, kein Turn.
 * - Turn: transcript, dann jeder Abschnitt als sentence und (Stimme auf dem
 *   Server) als Ton zwischen audio_begin und audio_end. Die Sprachausgabe
 *   läuft dem Text hinterher: ein eigener Lauf spricht Abschnitt für
 *   Abschnitt, während das Modell weiterschreibt.
 * - Abschluss: Ein Turn endet erst, wenn das Modell fertig ist, alles
 *   gesendet ist und der Browser jeden Abschnitt mit played bestätigt hat,
 *   oder nach einer Frist (Tondauer der unbestätigten Abschnitte plus 3 s),
 *   oder bei interrupt, Fehler, Auflegen, Verbindungsabbruch. Dann genau
 *   einmal onTurn mit dem bestätigten Text; nur der gilt als gesprochen und
 *   geht in den flüchtigen Verlauf dieses Gesprächs (mit „(unterbrochen)“).
 *   Bei einem unterbrochenen Turn ist auch rawText nur der bestätigte Text:
 *   der abgebrochene Rest samt Merk-Tags verfällt. Das gilt auch, wenn das
 *   Gehirn selbst done mit aborted meldet.
 *   Abschnitts-IDs zählen über das ganze Gespräch hoch; played für
 *   unbekannte, alte oder doppelte IDs wird ignoriert.
 * - interrupt: Turn-Signal abbrechen, line.interrupt(), wartende Abschnitte
 *   und Ton verwerfen; ab dann geht für diesen Turn nichts mehr hinaus.
 *   Jedes interrupt wird mit state „hört zu“ bestätigt, auch wenn nichts
 *   lief (der Browser verwirft bis dahin alles); ebenso ein utterance_end,
 *   das nichts zu erkennen hat.
 * - Rückfall der Stimme (Issue #276): speak liefert neben dem Ton
 *   Steuerereignisse. notice geht als notice an den Browser; restart heißt
 *   „dieser Abschnitt kommt von vorn“ (audio_restart, der Browser verwirft
 *   den noch nicht gespielten Ton dieses Abschnitts); browser heißt „diesen
 *   Abschnitt spricht der Browser“ (speak_browser mit dem Text, ohne
 *   audio_end), und der nächste Abschnitt wartet auf dessen played, damit
 *   sich nichts überlagert. Die Frist dafür rechnet den noch gepufferten Ton
 *   davor mit; verstreicht sie trotzdem (langsame Browser-Stimme), spricht
 *   der Browser auch den Rest des Turns, nie wieder Server-Ton dazwischen.
 *   Jeder Abschnitt behält seine ID und wird genau einmal bestätigt und
 *   verbucht.
 * - Fehler von Erkenner, Modell oder Stimme: error und ein Satz; der zweite
 *   Fehler in Folge beendet das Gespräch (ended „fehler“). Ein erschöpftes
 *   Budget beendet es mit einem Satz.
 * - Stille: Die Frist (CALL_LIMITS.silenceMs) läuft im Zustand „hört zu“ ab
 *   dem letzten angenommenen Ton, auch nach einer unvollständigen Äußerung
 *   und während das Mikrofon stumm ist.
 * - Sätze außerhalb eines Turns (Fehlersatz) bricht interrupt ab; ihr spätes
 *   Ende verwirft keine inzwischen begonnene Aufnahme.
 * - Neustart: Ein Gespräch zählt nur während eines Turns als Verarbeitung
 *   (port.turnBegin). Steht ein Neustart an, sagt tybo im Zustand „hört zu“
 *   CALL_TEXT.restartBye und legt auf. Nach der Erkennung beginnt der Turn
 *   nur, wenn kein Neustart ansteht und turnBegin ihn annimmt; sonst kommt
 *   der Abschied statt eines Modellabrufs. Über port.onRestart ruft die
 *   Neustart-Steuerung den Abschied vor shutdown auf und wartet auf ihn.
 * - Werkzeuge (Issue #259): Beginnt im Turn ein Werkzeug-Tag, geht tool
 *   { name } an den Browser und ein fester Satz in die Warteschlange des
 *   Turns („Moment, ich schaue nach.“ bzw. beim Denkauftrag „Das arbeite ich
 *   in Ruhe aus …“; Rechnen ohne Satz). Ist er gesprochen und das Werkzeug
 *   läuft noch, steht wieder „denkt“ mit tool { name }. Der Denkauftrag geht
 *   über deepTask als Turn ins selbe Gespräch (nie nach Telegram); kommt
 *   seine Antwort, solange das Gespräch läuft, sagt tybo in der nächsten
 *   ruhigen Sekunde einmal CALL_TEXT.deepResultReady, und der nächste Turn
 *   bekommt die ersten 1.500 Zeichen als gekennzeichneten Block. Ab dann
 *   tragen alle Turns foreignInput (Merk-Tags werden Vorschläge), bis zum
 *   Auflegen. Nach dem Auflegen kommt nichts mehr an.
 * - Ansagen (Denkauftrag-Ergebnis, Freigabe) laufen wie ein gesprochener
 *   Abschnitt: Zustand „spricht“, Ende mit played oder nach der Frist,
 *   interrupt bricht sie ab.
 * - Freigaben: offene Werkzeug-Freigaben des Gesprächs gehen als approval
 *   an den Browser (Knöpfe wie im Verlauf), tybo sagt einmal
 *   CALL_TEXT.approvalNeeded. Erkannter Text geht nur an das Gehirn, nie an
 *   das Rückfragen-Register: ein gesprochenes „ja“ gibt nichts frei.
 * - Nach dem Auflegen legt der Anschluss (bot-call.ts) die Meldung ab, was
 *   gemerkt wurde.
 * - Verlauf (Issue #260): Jeder abgeschlossene Turn geht mit Äußerung,
 *   bestätigt Gesprochenem und den Uhrzeiten an history (./call-history.ts),
 *   beim Auflegen eines bereiten Gesprächs dazu die Dauer.
 * - Logs: Zustände und Dauern, nie Inhalte.
 */

import {
  CALL_CLOSE,
  CALL_LIMITS,
  CALL_QUIET_MS,
  CALL_TEXT,
  CALL_TOOL_TEXT,
  DEEP_RESULT_CONTEXT_CHARS,
  type CallApproval,
  type CallApprovalWatch,
  type CallDeepTaskPort,
  type CallToolName,
  MAX_UTTERANCE_BYTES,
  parseCallMessage,
  type CallClientMessage,
  type CallClock,
  type CallConversationCheck,
  type CallHistoryMessage,
  type CallLine,
  type CallPort,
  type CallRecognition,
  type CallTtsMode,
} from "./call-protocol";
import type { CallHistoryPort } from "./call-history";
import { isNothingUnderstood } from "./speech";

export type { CallClock } from "./call-protocol";

export interface CallSocket {
  send(data: string | Uint8Array): number;
  bufferedAmount(): number;
  close(code: number, reason: string): void;
  ping(): void;
  isAuthorized(): boolean;
}

export type CallState = "verbindet" | "hoert-zu" | "versteht" | "denkt" | "spricht" | "aufgelegt";

export type CallEndReason =
  | "aufgelegt"
  | "stille"
  | "dauer"
  | "fehler"
  | "budget"
  | "neustart"
  | "abgemeldet"
  | "verbindung"
  | "server"
  | "start"
  | "protokoll"
  | "zu-gross";

/** Ton-Stücke an den Browser höchstens so groß */
export const AUDIO_CHUNK_BYTES = 16 * 1024;
/** Prüfabstand für einen angeforderten Neustart im Zustand „hört zu“ */
export const RESTART_POLL_MS = 2_000;
/** Zuschlag auf die Tondauer, bis unbestätigte Abschnitte als nicht gesprochen gelten */
export const PLAYED_GRACE_MS = 3_000;
/** Ohne Ton (Browser-Stimme): geschätzte Sprechdauer je Zeichen */
const BROWSER_MS_PER_CHAR = 80;

interface Segment {
  id: number;
  text: string;
  /** Dauer des gesendeten Tons */
  audioMs: number;
  sent: boolean;
  confirmed: boolean;
  /** Wartet auf played (Abschnitt spricht die Browser-Stimme, Issue #276) */
  onConfirmed?: () => void;
}

interface Turn {
  userText: string;
  /** Zeitpunkt der Äußerung (Erkennung fertig), für den Verlauf (Issue #260) */
  userAt: number;
  /** Erster Abschnitt der Antwort, für den Verlauf */
  firstSegmentAt: number | null;
  /** Was das Modell bekommt: userText, davor einmal der Block mit dem Denkauftrag-Ergebnis */
  modelText: string;
  /** Laufendes Werkzeug (nach seinem festen Satz zeigt die Ansicht wieder „denkt“) */
  tool: CallToolName | null;
  /** foreignInput für die Merk-Tags dieses Turns */
  foreignInput?: string;
  /** Werkzeug-Runden (Tag und Ergebnis) für den Verlauf, nur bei vollständigem Turn */
  toolMessages: CallHistoryMessage[];
  controller: AbortController;
  segments: Segment[];
  queue: Segment[];
  speaking: boolean;
  brainDone: boolean;
  rawText: string;
  /** Das Gehirn meldete done mit aborted: Rohtext samt Merk-Tags verfällt wie bei interrupt */
  aborted: boolean;
  failed: "modell" | "stimme" | null;
  /** Kein Ton mehr in diesem Turn (Stimme ausgefallen) */
  textOnly: boolean;
  /**
   * Ein Satz der Browser-Stimme blieb über seine Frist unbestätigt: der Rest
   * des Turns geht ebenfalls an die Browser-Stimme, damit kein Server-Ton
   * vor oder über ihm läuft (Issue #276)
   */
  browserOnly: boolean;
  finalized: boolean;
  release: () => void;
  confirmTimer: unknown;
  startedAt: number;
  firstSegmentLogged: boolean;
  firstAudioLogged: boolean;
}

interface Utterance {
  chunks: Buffer[];
  bytes: number;
  early: { bytes: number; controller: AbortController; promise: Promise<CallRecognition>; settled: boolean } | null;
}

export interface CallSessionOptions {
  socket: CallSocket;
  port: CallPort;
  checkConversation: CallConversationCheck;
  clock: CallClock;
  log: (line: string) => void;
  onEnd: () => void;
  /** Denkaufträge über den Chat-Kern (Issue #259); ohne gibt es keinen */
  deepTask?: CallDeepTaskPort;
  /** Offene Werkzeug-Freigaben des Gesprächs beobachten (Issue #259) */
  approvals?: CallApprovalWatch;
  /** Verlauf im Gespräch (Issue #260); ohne steht das Gespräch nur in der Ansicht */
  history?: CallHistoryPort;
}

const END_CODES: Partial<Record<CallEndReason, number>> = {
  protokoll: CALL_CLOSE.protocol,
  "zu-gross": CALL_CLOSE.tooLarge,
  abgemeldet: CALL_CLOSE.unauthorized,
  server: CALL_CLOSE.goingAway,
};

export class CallSession {
  private state: CallState = "verbindet";
  private ended = false;
  private started = false;
  private line: CallLine | null = null;
  private readonly openController = new AbortController();
  private startedAt = 0;
  private muted = false;
  private utt: Utterance = { chunks: [], bytes: 0, early: null };
  /** Zählt jeden Wechsel der Äußerung bzw. Erkennung; späte Ergebnisse älterer Stände zählen nicht */
  private stage = 0;
  private recognizeController: AbortController | null = null;
  private turn: Turn | null = null;
  private segmentId = 0;
  private readonly history: CallHistoryMessage[] = [];
  private failures = 0;
  private goodbye = false;
  /** Läuft der Abschied (Neustart, Budget): erfüllt, wenn aufgelegt */
  private farewell: Promise<void> | null = null;
  private unregisterRestart: (() => void) | null = null;
  /** Satz außerhalb eines Turns (Fehler, Abschied), abbrechbar */
  private sayController: AbortController | null = null;
  /** Ansage wartet auf played für diesen Abschnitt */
  private sayPlayed: { id: number; done: () => void } | null = null;
  private timers: { start?: unknown; silence?: unknown; max?: unknown; ping?: unknown; restart?: unknown; announce?: unknown } = {};
  private conversationId: string | null = null;
  /** Agent des Gesprächs (Prüfung beim Start), für den Verlauf */
  private agent = "general";
  /** Denkauftrag in diesem Gespräch möglich (beim Start geprüft) */
  private deepAvailable = false;
  private deepSeq = 0;
  /** Ergebnis eines Denkauftrags für den nächsten Turn (gekürzt) */
  private deepContext: string | null = null;
  /** Seit einem Denkauftrag-Ergebnis: Merk-Tags nur noch als Vorschlag, bis zum Auflegen */
  private foreign = false;
  /** Sätze für die nächste ruhige Sekunde; key verhindert Doppeltes und erlaubt Zurückziehen */
  private announcements: Array<{ key: string; text: string }> = [];
  private readonly announced = new Set<string>();
  private readonly openApprovals = new Map<string, CallApproval>();
  private readonly closedApprovals = new Set<string>();
  private unwatchApprovals: (() => void) | null = null;
  private drainWaiters: Array<() => void> = [];

  constructor(private readonly o: CallSessionOptions) {}

  /** Nach dem Upgrade: Frist für start, Ping und Sitzungsprüfung */
  begin(): void {
    this.o.log("Telefonhörer: verbunden");
    this.timers.start = this.o.clock.setTimeout(() => {
      if (!this.started) this.end("start");
    }, CALL_LIMITS.startTimeoutMs);
    this.timers.ping = this.o.clock.setInterval(() => {
      if (!this.o.socket.isAuthorized()) {
        this.end("abgemeldet");
        return;
      }
      try {
        this.o.socket.ping();
      } catch {
        // Verbindung weg: close() meldet das
      }
    }, CALL_LIMITS.pingMs);
  }

  get currentState(): CallState {
    return this.state;
  }

  // -------------------------------------------------------------------------
  // Senden
  // -------------------------------------------------------------------------

  private sendJson(msg: Record<string, unknown>): void {
    if (this.ended && msg.type !== "ended" && msg.type !== "state") return;
    try {
      this.o.socket.send(JSON.stringify(msg));
    } catch {
      // Verbindung weg
    }
  }

  private setState(state: CallState): void {
    if (this.state === state) return;
    this.state = state;
    this.sendJson({ type: "state", state });
  }

  /** „hört zu“ noch einmal senden, obwohl sich nichts ändert: Antwort auf interrupt bzw. utterance_end ohne Ton */
  private confirmListening(): void {
    if (this.ended || this.goodbye || this.state !== "hoert-zu") return;
    this.sendJson({ type: "state", state: "hoert-zu" });
  }

  /** Wartet, bis der Ausgabepuffer unter der Grenze ist; false, wenn der Browser zu lange nicht abholt */
  private async roomToSend(signal: AbortSignal): Promise<boolean> {
    const deadline = this.o.clock.now() + CALL_LIMITS.drainTimeoutMs;
    while (this.o.socket.bufferedAmount() > CALL_LIMITS.maxBufferedBytes) {
      if (signal.aborted || this.ended) return false;
      const left = deadline - this.o.clock.now();
      if (left <= 0) {
        this.o.log("Telefonhörer: Browser holt den Ton nicht ab, lege auf");
        this.end("verbindung");
        return false;
      }
      await new Promise<void>(resolve => {
        const timer = this.o.clock.setTimeout(resolve, Math.min(left, 500));
        this.drainWaiters.push(() => {
          this.o.clock.clearTimeout(timer);
          resolve();
        });
      });
    }
    return !signal.aborted && !this.ended;
  }

  /** Bun meldet: Puffer geleert */
  drained(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const w of waiters) w();
  }

  // -------------------------------------------------------------------------
  // Empfangen
  // -------------------------------------------------------------------------

  receive(data: string | Buffer | Uint8Array): void {
    if (this.ended) return;
    if (typeof data === "string") {
      const msg = parseCallMessage(data);
      if (!msg) {
        this.o.log("Telefonhörer: unbekannte oder zu große Textnachricht");
        this.end(Buffer.byteLength(data, "utf8") > CALL_LIMITS.maxTextBytes ? "zu-gross" : "protokoll");
        return;
      }
      this.handle(msg);
      return;
    }
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.length > CALL_LIMITS.maxBinaryBytes) {
      this.end("zu-gross");
      return;
    }
    // Vor ready gibt es keinen Ton; PCM16 heißt gerade Länge
    if (!this.line || bytes.length % 2 !== 0) {
      this.end("protokoll");
      return;
    }
    if (this.state !== "hoert-zu" || this.muted || this.goodbye) return;
    if (this.utt.bytes + bytes.length > MAX_UTTERANCE_BYTES) {
      this.o.log("Telefonhörer: Äußerung länger als 60 s");
      this.end("zu-gross");
      return;
    }
    // Weitere Sprache: eine noch laufende Pausen-Erkennung ist veraltet, sofort abbrechen (Issue #279)
    const early = this.utt.early;
    if (early && !early.settled) {
      early.controller.abort();
      this.utt.early = null;
    }
    // Kopie: der Puffer von Bun kann wiederverwendet werden
    const chunk = Buffer.from(bytes);
    this.utt.chunks.push(chunk);
    this.utt.bytes += chunk.length;
    // Realtime-Erkennung bekommt das Stück schon beim Sprechen (Issue #279)
    this.line.hear?.(chunk);
    // Stille zählt ab dem letzten Ton, auch wenn die Äußerung unvollständig bleibt
    this.armSilence();
  }

  private handle(msg: CallClientMessage): void {
    if (msg.type === "hangup") {
      this.end("aufgelegt");
      return;
    }
    if (msg.type === "start") {
      if (this.started) {
        this.end("protokoll");
        return;
      }
      this.started = true;
      this.clearTimer("start");
      void this.open(msg.conversationId, msg.tts);
      return;
    }
    // Alles andere erst nach ready
    if (!this.line) {
      this.end("protokoll");
      return;
    }
    switch (msg.type) {
      case "utterance_pause":
        this.pause();
        return;
      case "utterance_end":
        void this.utteranceEnd();
        return;
      case "interrupt":
        this.interrupt();
        return;
      case "played":
        this.played(msg.id);
        return;
      case "mute":
        this.muted = msg.on;
        // Stumm: begonnene Äußerung verwerfen; die Stille-Frist läuft weiter
        if (msg.on && this.state === "hoert-zu") {
          this.resetUtterance();
          this.armSilence();
        }
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  private async open(conversationId: string, tts: CallTtsMode): Promise<void> {
    const t0 = this.o.clock.now();
    try {
      if (this.o.port.restartPending()) {
        this.sendJson({ type: "error", reason: "neustart", message: CALL_TEXT.restartBye });
        this.end("neustart");
        return;
      }
      const check = await this.o.checkConversation(conversationId);
      if (this.ended) return;
      if (!check.ok) {
        this.sendJson({ type: "error", reason: check.reason, message: check.message });
        this.end("start");
        return;
      }
      this.conversationId = conversationId;
      this.agent = check.agent;
      try {
        this.deepAvailable = !!this.o.deepTask && (await this.o.deepTask.available(conversationId));
      } catch {
        this.deepAvailable = false;
      }
      if (this.ended) return;
      let timer: unknown;
      const timeout = new Promise<never>((_, reject) => {
        timer = this.o.clock.setTimeout(() => {
          this.openController.abort();
          reject(Object.assign(new Error("Zeitlimit beim Öffnen"), { reason: "zeitlimit" }));
        }, CALL_LIMITS.openTimeoutMs);
      });
      const opening = this.o.port.open({ conversationId, agent: check.agent, tts, signal: this.openController.signal, deepTask: this.deepAvailable });
      let line: CallLine;
      try {
        line = await Promise.race([opening, timeout]);
      } catch (e) {
        // Kam das Öffnen doch noch zu Ende: sofort wieder schließen
        void opening.then(l => l.close(), () => {});
        throw e;
      } finally {
        this.o.clock.clearTimeout(timer);
      }
      if (this.ended) {
        line.close();
        return;
      }
      this.line = line;
      this.startedAt = this.o.clock.now();
      const i = line.info;
      this.o.log(`Telefonhörer: bereit nach ${this.startedAt - t0} ms (${i.via}, Hören ${i.stt}${i.sttWarm ? " geladen" : " je Äußerung"}, Stimme ${i.tts})`);
      this.sendJson({ type: "ready", model: i.model, via: i.via, stt: i.stt, tts: i.tts, sampleRate: i.sampleRate });
      if (!i.sttWarm) this.sendJson({ type: "notice", text: "Die Spracherkennung startet für jede Äußerung neu, das ist langsamer." });
      this.timers.max = this.o.clock.setTimeout(() => {
        this.sendJson({ type: "notice", text: CALL_TEXT.maxDuration });
        this.end("dauer");
      }, CALL_LIMITS.maxCallMs);
      this.timers.restart = this.o.clock.setInterval(() => this.checkRestart(), RESTART_POLL_MS);
      this.unregisterRestart = this.o.port.onRestart(() => this.restartFarewell());
      this.watchApprovals(conversationId);
      this.toListening();
    } catch (e) {
      if (this.ended) return;
      const reason = typeof (e as { reason?: unknown })?.reason === "string" ? (e as { reason: string }).reason : "start";
      const message = e instanceof Error && e.name === "CallOpenError" ? e.message : "Der Telefonhörer ließ sich nicht starten.";
      this.o.log(`Telefonhörer: Start gescheitert (${reason})`);
      this.sendJson({ type: "error", reason, message });
      this.end("start");
    }
  }

  // -------------------------------------------------------------------------
  // Zuhören und Erkennen
  // -------------------------------------------------------------------------

  private resetUtterance(): void {
    this.utt.early?.controller.abort();
    this.utt = { chunks: [], bytes: 0, early: null };
    this.stage++;
    this.line?.newUtterance?.();
  }

  private toListening(): void {
    if (this.ended) return;
    this.resetUtterance();
    this.recognizeController = null;
    this.setState("hoert-zu");
    this.armSilence();
    this.checkRestart();
    this.scheduleAnnounce();
  }

  /** Stille-Frist (neu) starten; greift nur im Zustand „hört zu“ */
  private armSilence(): void {
    this.clearTimer("silence");
    this.timers.silence = this.o.clock.setTimeout(() => {
      delete this.timers.silence;
      if (this.ended || this.goodbye || this.state !== "hoert-zu") return;
      this.sendJson({ type: "notice", text: CALL_TEXT.silence });
      this.end("stille");
    }, CALL_LIMITS.silenceMs);
  }

  private snapshot(): Buffer {
    return Buffer.concat(this.utt.chunks, this.utt.bytes);
  }

  /** Erkennen schon in der Pause; höchstens eine solche Erkennung zur Zeit */
  private pause(): void {
    if (this.state !== "hoert-zu" || !this.utt.bytes || this.muted) return;
    const early = this.utt.early;
    if (early && !early.settled) return;
    if (early && early.bytes === this.utt.bytes) return;
    const controller = new AbortController();
    const entry = { bytes: this.utt.bytes, controller, settled: false, promise: Promise.resolve<CallRecognition>({ ok: false, reason: "failed" }) };
    entry.promise = this.line!.recognize(this.snapshot(), controller.signal).finally(() => {
      entry.settled = true;
    });
    this.utt.early = entry;
  }

  private async utteranceEnd(): Promise<void> {
    if (this.state !== "hoert-zu") return;
    if (!this.utt.bytes || this.muted) {
      // Nichts zu erkennen: bestätigen, sonst bliebe der Browser bei „Versteht …“
      this.confirmListening();
      return;
    }
    const stage = ++this.stage;
    const utt = this.utt;
    this.setState("versteht");
    const t0 = this.o.clock.now();
    let result: CallRecognition;
    let reused = false;
    if (utt.early && utt.early.bytes === utt.bytes) {
      reused = true;
      result = await utt.early.promise;
    } else {
      utt.early?.controller.abort();
      const controller = new AbortController();
      this.recognizeController = controller;
      result = await this.line!.recognize(this.snapshot(), controller.signal);
    }
    // Inzwischen unterbrochen, aufgelegt oder neu begonnen: Ergebnis verwerfen
    if (this.ended || stage !== this.stage) return;
    // Erst das übernommene Ergebnis zählt beim Erkenner und bringt seinen Hinweis (Issue #279)
    const notice = this.line!.adopt?.(result);
    if (notice) this.sendJson({ type: "notice", text: notice });
    this.o.log(`Telefonhörer: erkannt in ${this.o.clock.now() - t0} ms${reused ? " (aus der Pause)" : ""}, ${result.ok ? `Text${result.provider ? ` (${result.provider})` : ""}` : result.reason}`);
    if (!result.ok && result.reason === "failed") {
      this.failure("erkennung");
      return;
    }
    const text = result.ok ? result.text.trim() : "";
    if (!text || isNothingUnderstood(text)) {
      this.sendJson({ type: "notice", text: CALL_TEXT.nothingUnderstood });
      this.toListening();
      return;
    }
    // Neustart angefordert oder Annahme gesperrt: kein Modellabruf mehr, sondern der Abschied
    const release = this.o.port.restartPending() ? null : this.o.port.turnBegin();
    if (!release) {
      void this.restartFarewell();
      return;
    }
    this.sendJson({ type: "transcript", text });
    this.runTurn(text, release);
  }

  // -------------------------------------------------------------------------
  // Turn
  // -------------------------------------------------------------------------

  private runTurn(userText: string, release: () => void): void {
    this.stage++;
    this.setState("denkt");
    // Ergebnis eines Denkauftrags genau einmal als gekennzeichneter Block vor der Äußerung
    const context = this.deepContext;
    this.deepContext = null;
    const block = context ? `${CALL_TOOL_TEXT.deepResultLabel}\n${context}\n${CALL_TOOL_TEXT.deepResultEnd}` : undefined;
    const modelText = block ? `${block}\n\n${userText}` : userText;
    const turn: Turn = {
      userText,
      userAt: this.o.clock.now(),
      firstSegmentAt: null,
      modelText,
      tool: null,
      toolMessages: [],
      ...(this.foreign ? { foreignInput: CALL_TOOL_TEXT.foreignReason } : {}),
      controller: new AbortController(),
      segments: [],
      queue: [],
      speaking: false,
      brainDone: false,
      rawText: "",
      aborted: false,
      failed: null,
      textOnly: false,
      browserOnly: false,
      finalized: false,
      release,
      confirmTimer: null,
      startedAt: this.o.clock.now(),
      firstSegmentLogged: false,
      firstAudioLogged: false,
    };
    this.turn = turn;
    const history = this.history.slice();
    void (async () => {
      try {
        for await (const ev of this.line!.turn({ userText, ...(block ? { context: block } : {}), history, signal: turn.controller.signal, deepTask: this.deepAvailable })) {
          if (turn.finalized || turn.controller.signal.aborted) break;
          if (ev.type === "segment") {
            turn.tool = null;
            if (!turn.firstSegmentLogged) {
              turn.firstSegmentLogged = true;
              turn.firstSegmentAt = this.o.clock.now();
              this.o.log(`Telefonhörer: erster Abschnitt nach ${this.o.clock.now() - turn.startedAt} ms`);
            }
            this.enqueue(turn, ev.text);
          } else if (ev.type === "tool") {
            if (ev.phase === "call") {
              this.startDeepTask(ev.task);
              continue;
            }
            turn.tool = ev.name;
            this.o.log(`Telefonhörer: Werkzeug ${ev.name} nach ${this.o.clock.now() - turn.startedAt} ms`);
            this.sendJson({ type: "tool", name: ev.name });
            const ack = ev.name === "suche" ? CALL_TOOL_TEXT.searchAck : ev.name === "denkauftrag" ? CALL_TOOL_TEXT.deepAck : null;
            if (ack) this.enqueue(turn, ack);
          } else if (ev.type === "done") {
            turn.rawText = ev.rawText;
            turn.aborted = ev.aborted;
            turn.toolMessages = ev.aborted ? [] : ev.toolMessages ?? [];
            turn.brainDone = true;
          } else {
            turn.rawText = ev.rawText;
            turn.brainDone = true;
            this.o.log(`Telefonhörer: Modell meldet Fehler (${ev.reason})`);
            if (ev.reason === "budget") {
              this.goodbye = true;
              this.finalize(turn, false);
              await this.sayAndEnd(CALL_TEXT.budgetSentence, "budget");
              return;
            }
            if (ev.reason === "ended") {
              // Weg beendet (zweimal ausgefallen, /stop): kein weiterer Turn möglich
              this.sendJson({ type: "error", reason: "modell" });
              this.end("fehler");
              return;
            }
            turn.failed = "modell";
          }
        }
      } catch {
        // Der Turn wirft nie; sicherheitshalber wie ein Modellfehler
        if (!turn.finalized) {
          turn.brainDone = true;
          turn.failed = "modell";
        }
      }
      turn.brainDone = true;
      this.maybeFinish(turn);
    })();
  }

  /** Spricht die Abschnitte der Reihe nach, während das Modell weiterschreibt */
  private async pump(turn: Turn): Promise<void> {
    if (turn.speaking) return;
    turn.speaking = true;
    const signal = turn.controller.signal;
    try {
      while (turn.queue.length && !signal.aborted && !this.ended) {
        const seg = turn.queue.shift()!;
        this.sendJson({ type: "sentence", id: seg.id, text: seg.text });
        this.setState("spricht");
        const speak = this.line!.speak;
        if (this.line!.info.tts === "server" && speak && !turn.textOnly && turn.browserOnly) {
          // Nach einer verstrichenen Frist: der Browser spricht den Rest der Reihe nach, kein Server-Ton mehr
          this.sendJson({ type: "speak_browser", id: seg.id, text: seg.text });
          seg.audioMs = seg.text.length * BROWSER_MS_PER_CHAR;
        } else if (this.line!.info.tts === "server" && speak && !turn.textOnly) {
          this.sendJson({ type: "audio_begin", id: seg.id });
          let bytes = 0;
          let local = false;
          try {
            for await (const chunk of speak.call(this.line, seg.text, signal)) {
              // Rückfall je Abschnitt (Issue #276): Hinweis, Neubeginn oder Browser-Stimme
              if (!(chunk instanceof Uint8Array)) {
                if (signal.aborted || this.ended) break;
                if (chunk.type === "notice") this.sendJson({ type: "notice", text: chunk.text });
                else if (chunk.type === "restart") {
                  if (bytes) this.sendJson({ type: "audio_restart", id: seg.id });
                  bytes = 0;
                } else if (chunk.type === "browser") {
                  local = true;
                  break;
                }
                continue;
              }
              for (let off = 0; off < chunk.length; off += AUDIO_CHUNK_BYTES) {
                if (!(await this.roomToSend(signal))) break;
                // Nach interrupt: kein Ton mehr
                if (signal.aborted || this.ended) break;
                const piece = chunk.subarray(off, Math.min(chunk.length, off + AUDIO_CHUNK_BYTES));
                this.o.socket.send(piece);
                bytes += piece.length;
                if (!turn.firstAudioLogged) {
                  turn.firstAudioLogged = true;
                  this.o.log(`Telefonhörer: erster Ton nach ${this.o.clock.now() - turn.startedAt} ms`);
                }
              }
              if (signal.aborted || this.ended) break;
            }
          } catch {
            if (!signal.aborted && !this.ended) {
              this.o.log("Telefonhörer: Stimme ausgefallen, Rest nur als Text");
              turn.failed = "stimme";
              turn.textOnly = true;
            }
          }
          if (signal.aborted || this.ended) break;
          if (local) {
            // Die Browser-Stimme spricht diesen Abschnitt; erst nach played kommt der nächste Ton
            this.sendJson({ type: "speak_browser", id: seg.id, text: seg.text });
            seg.audioMs = seg.text.length * BROWSER_MS_PER_CHAR;
            seg.sent = true;
            const result = await this.segmentPlayed(turn, seg, signal);
            if (result === "aborted") break;
            if (result === "timeout") {
              this.o.log("Telefonhörer: Browser-Stimme nicht bestätigt, Rest des Turns spricht der Browser");
              turn.browserOnly = true;
            }
            continue;
          }
          this.sendJson({ type: "audio_end", id: seg.id });
          seg.audioMs = (bytes / 2 / this.line!.info.sampleRate) * 1000;
        } else {
          seg.audioMs = seg.text.length * BROWSER_MS_PER_CHAR;
        }
        seg.sent = true;
      }
    } finally {
      turn.speaking = false;
    }
    // Fester Satz gesprochen, das Werkzeug läuft noch: wieder „denkt“, die Ansicht zeigt das Werkzeug
    if (turn.tool && !turn.brainDone && !turn.finalized && !signal.aborted && !this.ended) {
      this.setState("denkt");
      this.sendJson({ type: "tool", name: turn.tool });
    }
    this.maybeFinish(turn);
  }

  /**
   * Wartet, bis der Browser einen selbst gesprochenen Abschnitt bestätigt
   * (Issue #276). Der Browser spricht ihn erst nach dem noch gepufferten Ton
   * davor, deshalb zählt dessen Dauer zur Frist: Dauer der unbestätigten
   * älteren Abschnitte plus geschätzte eigene Dauer plus PLAYED_GRACE_MS.
   * "timeout": Frist verstrichen (der Aufrufer gibt danach keinen Server-Ton
   * mehr frei), "aborted": abgebrochen oder aufgelegt.
   */
  private segmentPlayed(turn: Turn, seg: Segment, signal: AbortSignal): Promise<"played" | "timeout" | "aborted"> {
    if (seg.confirmed) return Promise.resolve("played");
    if (signal.aborted || this.ended) return Promise.resolve("aborted");
    const earlier = turn.segments.filter(s => s.id < seg.id && s.sent && !s.confirmed).reduce((sum, s) => sum + s.audioMs, 0);
    return new Promise(resolve => {
      let done = false;
      const finish = (result: "played" | "timeout" | "aborted") => {
        if (done) return;
        done = true;
        this.o.clock.clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        seg.onConfirmed = undefined;
        resolve(signal.aborted || this.ended ? "aborted" : result);
      };
      const onAbort = () => finish("aborted");
      const timer = this.o.clock.setTimeout(() => finish("timeout"), earlier + seg.audioMs + PLAYED_GRACE_MS);
      signal.addEventListener("abort", onAbort, { once: true });
      seg.onConfirmed = () => finish("played");
    });
  }

  /** Abschnitt in die Warteschlange des Turns, die Stimme spricht ihn nach den vorigen */
  private enqueue(turn: Turn, text: string): void {
    const seg: Segment = { id: ++this.segmentId, text, audioMs: 0, sent: false, confirmed: false };
    turn.segments.push(seg);
    turn.queue.push(seg);
    void this.pump(turn);
  }

  /** Fertig, wenn das Modell fertig, alles gesendet und alles bestätigt ist; sonst Frist für die Bestätigung */
  private maybeFinish(turn: Turn): void {
    if (turn.finalized || this.ended || !turn.brainDone || turn.queue.length || turn.speaking) return;
    const open = turn.segments.filter(s => !s.confirmed);
    if (!open.length) {
      this.finalize(turn, false);
      return;
    }
    if (turn.confirmTimer !== null) return;
    const ms = open.reduce((sum, s) => sum + s.audioMs, 0) + PLAYED_GRACE_MS;
    turn.confirmTimer = this.o.clock.setTimeout(() => {
      turn.confirmTimer = null;
      if (!turn.finalized) {
        this.o.log("Telefonhörer: Wiedergabe nicht bestätigt, Rest gilt als nicht gesprochen");
        this.finalize(turn, false);
      }
    }, ms);
  }

  private played(id: number): void {
    if (this.sayPlayed?.id === id) {
      this.sayPlayed.done();
      return;
    }
    const turn = this.turn;
    if (!turn || turn.finalized) return;
    const seg = turn.segments.find(s => s.id === id);
    if (!seg || !seg.sent || seg.confirmed) return;
    seg.confirmed = true;
    seg.onConfirmed?.();
    if (turn.brainDone && !turn.queue.length && !turn.speaking && turn.segments.every(s => s.confirmed)) {
      if (turn.confirmTimer !== null) this.o.clock.clearTimeout(turn.confirmTimer);
      turn.confirmTimer = null;
      this.finalize(turn, false);
    }
  }

  /** Genau einmal je Turn: onTurn, Verlauf, Neustart-Zählung, dann weiter zuhören */
  private finalize(turn: Turn, interrupted: boolean): void {
    if (turn.finalized) return;
    turn.finalized = true;
    if (turn.confirmTimer !== null) this.o.clock.clearTimeout(turn.confirmTimer);
    turn.confirmTimer = null;
    turn.controller.abort();
    turn.queue.length = 0;
    turn.release();
    const spoken = turn.segments.filter(s => s.confirmed).map(s => s.text);
    // Vom Gehirn gemeldeter Abbruch zählt wie interrupt, auch wenn alles Gesendete bestätigt ist
    const wasInterrupted = interrupted || turn.aborted || turn.segments.some(s => !s.confirmed);
    const spokenText = spoken.join(" ");
    // Unterbrochen: auch die Rohfassung nur so weit wie gesprochen (der abgebrochene Rest samt Tags verfällt)
    const rawText = wasInterrupted ? spokenText : turn.rawText;
    try {
      this.line?.onTurn({ userText: turn.userText, spokenText, rawText, interrupted: wasInterrupted, ...(turn.foreignInput ? { foreignInput: turn.foreignInput } : {}) });
    } catch {
      this.o.log("Telefonhörer: Anschluss nach dem Turn fehlgeschlagen");
    }
    this.recordTurn(turn, spokenText, wasInterrupted);
    this.history.push({ role: "user", content: turn.modelText });
    // Vollständiger Turn mit Werkzeugen: Tag und Ergebnis bleiben im Verlauf, sonst hielte das Modell die Antwort später für unbelegt
    if (!wasInterrupted) this.history.push(...turn.toolMessages);
    this.history.push({ role: "assistant", content: wasInterrupted ? `${spokenText} (unterbrochen)`.trim() : spokenText || "…" });
    if (this.turn === turn) this.turn = null;
    this.o.log(`Telefonhörer: Turn beendet nach ${this.o.clock.now() - turn.startedAt} ms${wasInterrupted ? " (unterbrochen)" : ""}`);
    if (this.ended || this.goodbye) return;
    if (interrupted) {
      this.toListening();
      return;
    }
    if (turn.failed) {
      this.failure(turn.failed);
      return;
    }
    this.failures = 0;
    this.toListening();
  }

  /** Turn in den Verlauf des Gesprächs (Issue #260); wirft nie */
  private recordTurn(turn: Turn, spokenText: string, interrupted: boolean): void {
    const history = this.o.history;
    if (!history || !this.conversationId || !this.line) return;
    try {
      history.turn({
        conversationId: this.conversationId,
        agent: this.agent,
        model: this.line.info.model,
        userText: turn.userText,
        userAt: new Date(turn.userAt).toISOString(),
        spokenText,
        interrupted,
        replyAt: new Date(turn.firstSegmentAt ?? this.o.clock.now()).toISOString(),
      });
    } catch {
      this.o.log("Telefonhörer: Verlauf nach dem Turn fehlgeschlagen");
    }
  }

  private interrupt(): void {
    // Satz außerhalb eines Turns (Fehlersatz): stoppen und gleich wieder zuhören; der Abschied bleibt
    if (this.sayController && !this.goodbye) {
      this.sayController.abort();
      this.sayController = null;
      this.recognizeController?.abort();
      this.o.log("Telefonhörer: Satz unterbrochen");
      const was = this.state;
      this.toListening();
      // Stand der Zustand schon auf „hört zu“, sendet toListening nichts: dann ausdrücklich bestätigen
      if (was === "hoert-zu") this.confirmListening();
      return;
    }
    if (this.state === "versteht") {
      this.recognizeController?.abort();
      this.o.log("Telefonhörer: Erkennung unterbrochen");
      this.toListening();
      return;
    }
    const turn = this.turn;
    if (!turn || turn.finalized) {
      // Nichts zu unterbrechen: trotzdem bestätigen, der Browser wartet darauf
      this.confirmListening();
      return;
    }
    turn.controller.abort();
    void this.line?.interrupt().catch(() => {});
    this.o.log("Telefonhörer: unterbrochen");
    this.finalize(turn, true);
  }

  // -------------------------------------------------------------------------
  // Fehler, Neustart, Ende
  // -------------------------------------------------------------------------

  /** Fehler einer Stufe: Satz und weiter, beim zweiten in Folge Ende */
  private failure(stage: "erkennung" | "modell" | "stimme"): void {
    this.failures++;
    this.sendJson({ type: "error", reason: stage });
    if (this.failures >= 2) {
      this.o.log(`Telefonhörer: zweiter Fehler in Folge (${stage})`);
      this.end("fehler");
      return;
    }
    // Nach interrupt (Satz abgebrochen) hört die Sitzung schon zu: kein zweites toListening
    void this.say(CALL_TEXT.errorSentence).then(done => {
      if (done) this.toListening();
    });
  }

  /**
   * Ein Satz außerhalb eines Turns (Fehler, Abschied): Text und, wenn möglich,
   * Ton; keine Bestätigung nötig. false: abgebrochen (interrupt) oder aufgelegt.
   */
  private async say(text: string, awaitPlayed = false): Promise<boolean> {
    if (this.ended || !this.line) return false;
    this.sayController?.abort();
    const controller = new AbortController();
    this.sayController = controller;
    const signal = controller.signal;
    const id = ++this.segmentId;
    try {
      this.sendJson({ type: "sentence", id, text });
      const speak = this.line.speak;
      let audioMs = text.length * BROWSER_MS_PER_CHAR;
      if (this.line.info.tts === "server" && speak) {
        this.sendJson({ type: "audio_begin", id });
        let bytes = 0;
        let local = false;
        try {
          for await (const chunk of speak.call(this.line, text, signal)) {
            // Rückfall wie in pump (Issue #276)
            if (!(chunk instanceof Uint8Array)) {
              if (signal.aborted || this.ended) return false;
              if (chunk.type === "notice") this.sendJson({ type: "notice", text: chunk.text });
              else if (chunk.type === "restart") {
                if (bytes) this.sendJson({ type: "audio_restart", id });
                bytes = 0;
              } else if (chunk.type === "browser") {
                local = true;
                break;
              }
              continue;
            }
            for (let off = 0; off < chunk.length; off += AUDIO_CHUNK_BYTES) {
              if (!(await this.roomToSend(signal))) return false;
              const piece = chunk.subarray(off, Math.min(chunk.length, off + AUDIO_CHUNK_BYTES));
              this.o.socket.send(piece);
              bytes += piece.length;
            }
            if (signal.aborted || this.ended) return false;
          }
        } catch {
          // Stimme aus: der Satz steht als Text da
        }
        if (signal.aborted || this.ended) return false;
        if (local) this.sendJson({ type: "speak_browser", id, text });
        else {
          this.sendJson({ type: "audio_end", id });
          audioMs = (bytes / 2 / this.line.info.sampleRate) * 1000;
        }
      }
      if (!awaitPlayed) return true;
      return await this.waitPlayed(id, audioMs, signal);
    } finally {
      if (this.sayController === controller) this.sayController = null;
    }
  }

  /**
   * Wartet auf played für einen Satz außerhalb eines Turns, höchstens
   * Tondauer plus PLAYED_GRACE_MS. false: abgebrochen (interrupt) oder aufgelegt.
   */
  private waitPlayed(id: number, audioMs: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || this.ended) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      const finish = (ok: boolean) => {
        if (this.sayPlayed?.id === id) this.sayPlayed = null;
        this.o.clock.clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(ok && !signal.aborted && !this.ended);
      };
      const onAbort = () => finish(false);
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = this.o.clock.setTimeout(() => finish(true), audioMs + PLAYED_GRACE_MS);
      this.sayPlayed = { id, done: () => finish(true) };
    });
  }

  private sayAndEnd(text: string, reason: CallEndReason): Promise<void> {
    if (this.farewell) return this.farewell;
    this.goodbye = true;
    this.setState("spricht");
    this.farewell = this.say(text).then(() => this.end(reason));
    return this.farewell;
  }

  /**
   * Abschied beim Neustart: Erkennung und Satz abbrechen, restartBye sagen,
   * auflegen. Die Neustart-Steuerung wartet über port.onRestart darauf.
   */
  private restartFarewell(): Promise<void> {
    if (this.ended) return Promise.resolve();
    if (this.farewell) return this.farewell;
    this.o.log("Telefonhörer: Neustart steht an, lege auf");
    this.recognizeController?.abort();
    this.resetUtterance();
    this.sayController?.abort();
    this.sayController = null;
    // Der Abschied zählt wie ein Turn, damit ein späterer Neustart-Check ihn nicht abschneidet;
    // bei gesperrter Annahme wartet die Neustart-Steuerung selbst auf ihn
    const release = this.o.port.turnBegin();
    return this.sayAndEnd(CALL_TEXT.restartBye, "neustart").finally(() => release?.());
  }

  // -------------------------------------------------------------------------
  // Werkzeuge: Denkauftrag, Ansagen, Freigaben
  // -------------------------------------------------------------------------

  /** Denkauftrag als Turn im selben Gespräch; die Antwort genau dieses Auftrags kommt über onResult */
  private startDeepTask(task: string): void {
    const port = this.o.deepTask;
    const conversationId = this.conversationId;
    const id = ++this.deepSeq;
    const fail = () => {
      if (this.ended) return;
      this.o.log(`Telefonhörer: Denkauftrag ${id} nicht gestartet`);
      this.announce(`deep-fail:${id}`, CALL_TOOL_TEXT.deepUnavailable);
    };
    if (!port || !conversationId || !this.deepAvailable || !task.trim()) {
      fail();
      return;
    }
    const text = `Denkauftrag aus dem Telefongespräch: ${task.trim()}\n\nAntworte hier im Gespräch.`;
    let result = false;
    port
      .start({
        conversationId,
        text,
        onResult: answer => {
          if (result) return;
          result = true;
          this.deepResult(id, answer);
        },
      })
      .then(
        status => {
          if (status === "unavailable") fail();
          else this.o.log(`Telefonhörer: Denkauftrag ${id} ${status === "queued" ? "eingereiht und gestartet" : "gestartet"}`);
        },
        () => fail()
      );
  }

  /** Antwort eines Denkauftrags: einmal ansagen, Kontext für den nächsten Turn, ab jetzt fremde Inhalte */
  private deepResult(id: number, answer: string): void {
    // Nach dem Auflegen steht die Antwort nur noch im Gespräch
    if (this.ended || !answer.trim()) return;
    this.foreign = true;
    this.deepContext = answer.slice(0, DEEP_RESULT_CONTEXT_CHARS);
    this.o.log(`Telefonhörer: Ergebnis von Denkauftrag ${id} ist da`);
    this.announce(`deep:${id}`, CALL_TEXT.deepResultReady);
  }

  /** Satz für die nächste ruhige Sekunde, je key höchstens einmal im Gespräch */
  private announce(key: string, text: string): void {
    if (this.ended || this.announced.has(key)) return;
    this.announced.add(key);
    this.announcements.push({ key, text });
    this.scheduleAnnounce();
  }

  /** Ruhig: tybo hört zu, nichts angefangen, kein Turn, kein anderer Satz */
  private quiet(): boolean {
    return !this.ended && !this.goodbye && !!this.line && this.state === "hoert-zu" && !this.utt.bytes && !this.turn && !this.sayController;
  }

  private scheduleAnnounce(): void {
    if (this.ended || !this.announcements.length || this.timers.announce !== undefined) return;
    this.timers.announce = this.o.clock.setTimeout(() => {
      delete this.timers.announce;
      if (!this.announcements.length || this.ended) return;
      if (!this.quiet()) {
        this.scheduleAnnounce();
        return;
      }
      const next = this.announcements.shift()!;
      void this.speakAnnouncement(next.text);
    }, CALL_QUIET_MS);
  }

  /**
   * Ansage wie ein Abschnitt im Turn: Zustand „spricht“ (der Browser sperrt
   * die Aufnahme bzw. erlaubt nur das Ins-Wort-Fallen nach seiner
   * Einstellung, der Server nimmt keinen Ton an), Ende erst mit played oder
   * nach der Frist, dann wieder „hört zu“. interrupt bricht sie ab und hört zu.
   */
  private async speakAnnouncement(text: string): Promise<void> {
    this.setState("spricht");
    const done = await this.say(text, true);
    // Abgebrochen: interrupt hört schon zu, Abschied oder Auflegen übernehmen selbst
    if (done && !this.ended && !this.goodbye && this.state === "spricht") this.toListening();
    else this.scheduleAnnounce();
  }

  private watchApprovals(conversationId: string): void {
    const watch = this.o.approvals;
    if (!watch) return;
    try {
      this.unwatchApprovals = watch(conversationId, {
        opened: approval => {
          // Schon geschlossen (entschieden, abgelaufen): eine verspätete Meldung öffnet sie nicht wieder
          if (this.ended || this.openApprovals.has(approval.id) || this.closedApprovals.has(approval.id)) return;
          this.openApprovals.set(approval.id, approval);
          this.sendApprovals();
          this.announce(`approval:${approval.id}`, CALL_TEXT.approvalNeeded);
        },
        closed: id => {
          this.closedApprovals.add(id);
          if (this.ended || !this.openApprovals.delete(id)) return;
          // Noch nicht gesagt: nicht mehr nötig
          this.announcements = this.announcements.filter(a => a.key !== `approval:${id}`);
          this.sendApprovals();
        },
      });
    } catch {
      this.o.log("Telefonhörer: Freigaben nicht beobachtbar");
    }
  }

  private sendApprovals(): void {
    this.sendJson({ type: "approval", choices: [...this.openApprovals.values()].map(a => ({ id: a.id, options: a.options })) });
  }

  private checkRestart(): void {
    if (this.ended || this.goodbye || this.state !== "hoert-zu" || this.utt.bytes) return;
    if (!this.o.port.restartPending()) return;
    void this.restartFarewell();
  }

  private clearTimer(name: keyof CallSession["timers"]): void {
    const h = this.timers[name];
    if (h === undefined) return;
    if (name === "ping" || name === "restart") this.o.clock.clearInterval(h);
    else this.o.clock.clearTimeout(h);
    delete this.timers[name];
  }

  /** Verbindung zu (vom Browser oder vom Netz) */
  socketClosed(): void {
    if (!this.ended) this.end("verbindung", false);
  }

  /** Gespräch beenden, genau einmal: Turn abschließen, alles schließen, ended senden */
  end(reason: CallEndReason, socketOpen = true): void {
    if (this.ended) return;
    const turn = this.turn;
    if (turn && !turn.finalized) {
      turn.controller.abort();
      // onTurn noch mit dem bestätigten Teil; danach keine Ausgabe mehr
      this.ended = true;
      this.finalize(turn, true);
    }
    this.ended = true;
    for (const name of Object.keys(this.timers) as Array<keyof CallSession["timers"]>) this.clearTimer(name);
    this.openController.abort();
    this.recognizeController?.abort();
    this.sayController?.abort();
    this.unregisterRestart?.();
    this.unregisterRestart = null;
    this.unwatchApprovals?.();
    this.unwatchApprovals = null;
    this.announcements = [];
    this.utt.early?.controller.abort();
    this.drained();
    try {
      this.line?.close();
    } catch {
      // schon zu
    }
    const seconds = this.startedAt ? Math.round((this.o.clock.now() - this.startedAt) / 1000) : 0;
    this.o.log(`Telefonhörer: aufgelegt (${reason}) nach ${seconds} s`);
    // Verlauf (Issue #260): nur ein Gespräch, das bereit war, bekommt die Meldung zum Ende
    if (this.startedAt && this.conversationId && this.o.history) {
      try {
        this.o.history.ended({ conversationId: this.conversationId, seconds, at: new Date(this.o.clock.now()).toISOString() });
      } catch {
        this.o.log("Telefonhörer: Meldung zum Ende fehlgeschlagen");
      }
    }
    if (socketOpen) {
      this.state = "aufgelegt";
      this.sendJson({ type: "state", state: "aufgelegt" });
      this.sendJson({ type: "ended", reason, seconds });
      try {
        this.o.socket.close(END_CODES[reason] ?? CALL_CLOSE.normal, reason);
      } catch {
        // schon zu
      }
    }
    this.o.onEnd();
  }
}
