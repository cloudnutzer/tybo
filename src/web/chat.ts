/**
 * Chat-Ablauf der WebUI (Issue #4): Turn im Hintergrund, Sperre pro
 * Gespräch, Live-Ereignisse per Server-Sent Events.
 *
 * Der eigentliche Agenten-Turn kommt als WebChat herein (echt ab #6, in
 * Tests und web:dev eine Attrappe). TurnSink wird nur als Typ importiert,
 * damit zur Laufzeit nichts aus src/lib geladen wird.
 */

import type { TurnSink } from "../lib/chat-turn";
import type { ApiAttachment, MessageAttachment } from "./attachments";
import type { ApiChoice } from "./choices";
import { COMMAND_NOTICE_SOURCE, COMMANDS_TEXT, type CommandExecution, type CommandOutcome } from "./commands";
import { renderMarkdown, stripControlTags } from "./markdown";
import { NOTICE_SOURCE_PATTERN, pickNoticeFile, type NoticeFile } from "./notice";
import { pickReplyInfo, type Conversation, type NewMessage, type ReplyInfo, type StoredMessage } from "./store";

export const MAX_MESSAGE_CHARS = 20_000;
export const DEFAULT_KEEPALIVE_MS = 20_000;
export const ABORTED_TEXT = "Abgebrochen.";
export const TURN_FAILED_TEXT = "Bei der Antwort ist ein Fehler aufgetreten. Bitte noch einmal versuchen.";
export const EMPTY_REPLY_TEXT = "Keine Antwort erhalten. Bitte noch einmal versuchen.";
export const SAVE_FAILED_TEXT = "Die Antwort konnte nicht gespeichert werden.";
export const DEFAULT_SHUTDOWN_GRACE_MS = 3000;
const SHUTDOWN_FLUSH_MS = 100;

/** Woher eine Nachricht kam (Issue #59): Browser oder Terminal (tybo) */
export type MessageSource = "web" | "terminal";

export interface RunTurnOptions {
  conversationId: string;
  agent: string;
  text: string;
  /** ID der eben abgelegten Nutzernachricht (Telegram-Gespräche speichern sie unter dieser msgId) */
  messageId?: string;
  /**
   * Eingangszeitpunkt der Nutzernachricht (createdAt aus der Ablage, Issue
   * #69): Telegram-Gespräche speichern sie am Turn-Ende mit diesem created_at
   */
  receivedAt?: string;
  /** Herkunft aus der Anmeldeart der Anfrage; fehlt sie, gilt "web" */
  source?: MessageSource;
  /**
   * Anhänge der Nutzernachricht (Issue #72), schon angenommen (UploadStore.claim).
   * Telegram- und (seit Issue #112) Web-Gespräche.
   */
  attachments?: MessageAttachment[];
  sink: TurnSink;
  /** Titel des Gesprächs (reine Web-Gespräche), für den Hinweis an der Freigabe-Kopie im Direktchat */
  title?: string;
  /**
   * Stellt eine Rückfrage (Werkzeug-Freigabe, Issue #116) mit der Register-ID
   * choiceId als Nachricht in den Verlauf (record false: nur den Status, die
   * Nachricht kommt auf anderem Weg); die nächste eingetippte Nachricht mit
   * derselben Kennung geht dann per answer() an den Turn.
   */
  ask?(question: string, choiceId: string, options?: { record?: boolean }): Promise<void>;
  /** Die Rückfrage mit dieser Kennung ist erledigt (entschieden, abgelaufen, abgebrochen) */
  endAsk?(choiceId: string): void;
}

export interface TurnResult {
  text: string;
  /**
   * Abbruch. Ein Text ist dann die Meldung dafür (z. B. „Bot wurde beendet"),
   * ohne Text gilt ABORTED_TEXT.
   */
  aborted?: boolean;
  /** Der Turn ist gescheitert; text ist die Fehlermeldung für den Verlauf */
  failed?: boolean;
  /** ID, unter der die Antwort abgelegt werden soll (Telegram-Gespräche: ihre msgId) */
  messageId?: string;
  /** Agent, Modell und Dauer der Antwort (Issue #22); fehlt, was der Turn nicht kennt */
  info?: ReplyInfo;
  /**
   * Arbeit nach der Antwort, noch unter der Sperre des Gesprächs (Issue #76:
   * [INVOKE:]-Rückfragen). Läuft erst, wenn die Antwort gespeichert und
   * gesendet ist; was sie liefert, erscheint danach als eigene Nachrichten.
   */
  followUp?(output: FollowUpOutput): Promise<void>;
}

/** Was eine Nacharbeit (TurnResult.followUp) im Verlauf zeigen kann */
export interface FollowUpOutput {
  /** Eigene Nachricht eines Agenten; messageId wie im Nachrichtenspeicher */
  answer(text: string, info?: ReplyInfo, messageId?: string): Promise<void>;
  /** Zwischenstand in der Statuszeile, z. B. „Critic denkt nach …" */
  notice(text: string): Promise<void>;
  /** Stopp-Knopf während der Nacharbeit: laufende Rückfrage abbrechen, keine weitere starten */
  signal: AbortSignal;
}

export interface WebChat {
  runTurn(opts: RunTurnOptions): Promise<TurnResult>;
  /** false: Abbruch abgelehnt, weil die Antwort schon verbindlich gespeichert wird */
  stop(conversationId: string): boolean | void;
  /**
   * Eingetippte Antwort auf die Rückfrage mit dieser Kennung, entschieden über
   * das Register mit der Quelle (Browser oder Terminal); false, wenn genau
   * diese nicht mehr offen ist oder schon anders entschieden wurde
   */
  answer?(conversationId: string, text: string, approvalId: string, source?: MessageSource): boolean | Promise<boolean>;
}

export type ApiMessage = StoredMessage & {
  html?: string;
  /** Markdown-Text der Antwort ohne Steuer-Tags, für den Kopieren-Knopf */
  copyText?: string;
  /** Meldung (Entscheidung 0006, Issue #47): Nur-Anzeige-Eintrag, keine Antwort eines Agenten */
  kind?: "notice";
  /** Absender der Meldung, z. B. pipeline */
  source?: string;
  /** Datei der Meldung, Download über /api/files/<id> */
  file?: NoticeFile;
  /**
   * Rückfrage mit Knöpfen (Issue #115); ersetzt choiceId, sobald der Server
   * den Zustand aus dem Register gelesen hat (ChatHubOptions.decorate). Bleibt
   * choiceId ohne choice, war das Register nicht lesbar: der Browser fragt
   * den Stand dann über die Stand-Abfrage nach.
   */
  choice?: ApiChoice;
};

/** Eingabe für toApiMessage: gespeicherte Nachricht, bei Meldungen mit kind, source und file */
export type ApiMessageInput = StoredMessage & { kind?: "notice"; source?: unknown; file?: unknown };

/**
 * Antworten bekommen zusätzlich sicheres HTML und den Markdown-Text zum
 * Kopieren (beide ohne Steuer-Tags; text bleibt unverändert) sowie nur
 * gültige Angaben zu Agent, Modell und Dauer. Meldungen (kind "notice")
 * bekommen HTML, geprüfte source und file, aber keine Angaben zu Agent,
 * Modell oder Dauer und keinen Kopiertext.
 */
export function toApiMessage(m: ApiMessageInput): ApiMessage {
  const { agent: _agent, model: _model, engine: _engine, durationMs: _durationMs, kind: _kind, source: _source, file: _file, ...base } = m;
  if (m.kind === "notice") {
    const source = typeof m.source === "string" && NOTICE_SOURCE_PATTERN.test(m.source) ? m.source : undefined;
    const file = pickNoticeFile(m.file);
    return {
      ...base,
      role: "assistant",
      kind: "notice",
      ...(source ? { source } : {}),
      ...(file ? { file } : {}),
      html: renderMarkdown(m.text),
    };
  }
  if (m.role !== "assistant") return base;
  return { ...base, ...pickReplyInfo(m), html: renderMarkdown(m.text), copyText: stripControlTags(m.text) };
}

/**
 * Prüft den Nachrichtentext: 1 bis 20.000 Zeichen (Unicode-Codepoints), nicht
 * nur Leerraum. Mit allowEmpty (Nachricht mit Anhang, Issue #72) darf er leer sein.
 */
export function validateMessageText(text: unknown, options: { allowEmpty?: boolean } = {}): string | null {
  if (typeof text !== "string") return "Feld text fehlt oder ist kein Text";
  if (!text.trim() && !options.allowEmpty) return "Nachricht ist leer";
  if ([...text].length > MAX_MESSAGE_CHARS) return "Nachricht ist länger als 20.000 Zeichen";
  return null;
}

interface Subscriber {
  /** Anmelde-Session, an die die Verbindung gebunden ist */
  session?: string;
  send(chunk: string): void;
  close(): void;
  /** Aufräumen und die Verbindung beenden */
  terminate(): void;
}

export interface SubscribeOptions {
  /** Kennung der Anmelde-Session; closeSession() beendet alle Verbindungen dazu */
  session?: string;
  /** Vor jedem Senden geprüft; false beendet die Verbindung ohne weitere Daten */
  isAuthorized?: () => boolean;
  /** Anfangs-status senden (Standard); false für Ströme ohne Turn, z.B. die Aktivität der Seitenleiste */
  initialStatus?: boolean;
}

interface RunningTurn {
  stopRequested: boolean;
  started: boolean;
  /** Eine Rückfrage wartet auf die eingetippte Antwort */
  awaiting: boolean;
  /** Kennung der angezeigten Rückfrage; der Browser schickt sie mit der Antwort zurück */
  approvalId?: string;
  /** runTurn ist fertig, die Abschlussmeldung wird gespeichert: nichts mehr abzubrechen */
  finishing: boolean;
  /** Ein Befehl statt eines Turns (Issue #74); Stopp bricht über diesen Controller ab */
  command?: AbortController;
  /** Nacharbeit nach der gespeicherten Antwort (Issue #76, [INVOKE:]); Stopp bricht über diesen Controller ab */
  followUp?: AbortController;
}

export interface TurnStatus {
  running: boolean;
  awaiting?: boolean;
  approvalId?: string;
}

export interface ChatShutdownOptions {
  /** Wie lange laufende Turns ihre Abschlussmeldung noch speichern dürfen */
  graceMs?: number;
  /** Meldung für Turns, die das Beenden abbricht, bevor sie selbst eine liefern */
  abortText?: string;
}

/**
 * Wo der ChatHub Nachrichten ablegt: für Web-Gespräche der ConversationStore,
 * für Telegram-Gespräche ein Protokoll ohne eigene Datei (dort speichert der
 * Turn selbst in Supabase). id ist ein Wunsch, den nur Letzteres beachtet.
 */
export interface MessageLog {
  appendMessage(conversationId: string, message: NewMessage & { id?: string }): Promise<StoredMessage>;
}

/** Was der ChatHub von einem Gespräch braucht; title nur bei reinen Web-Gesprächen */
export type HubConversation = Pick<Conversation, "id" | "agent"> & { title?: string };

export interface ChatHubOptions {
  store: MessageLog;
  chat?: WebChat;
  keepaliveMs?: number;
  log?: (message: string) => void;
  /**
   * Nutzernachricht auch als SSE-message veröffentlichen (Telegram-Gespräche):
   * andere offene Browser sehen sie sofort; der sendende Browser kennt die ID
   * schon aus dem POST und doppelt sie nicht.
   */
  publishUserMessages?: boolean;
  /**
   * Ergänzt Nachrichten mit choiceId vor dem Senden per SSE um den Zustand der
   * Rückfrage (Issue #115). Solange das läuft, warten spätere Ereignisse des
   * Gesprächs, damit die Reihenfolge bleibt. Ohne decorate fällt choiceId weg.
   */
  decorate?: (conversationId: string, message: ApiMessage) => Promise<ApiMessage>;
  /**
   * Die Antwort eines Turns ist gespeichert und gesendet (Issue #226, Push).
   * Nur die eigentliche Antwort: keine Fehler, Abbrüche, Rückfragen, Nacharbeit
   * oder Befehle. source ist die Herkunft der Nachricht, auf die der Turn
   * antwortet. Läuft unabhängig davon, ob jemand zuhört; Fehler landen im Log.
   */
  onReply?: (event: { conversationId: string; text: string; agent?: string; source: MessageSource }) => void;
}

const encoder = new TextEncoder();

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class ChatHub {
  private readonly store: MessageLog;
  private readonly chat?: WebChat;
  private readonly keepaliveMs: number;
  private readonly log: (message: string) => void;
  private readonly publishUserMessages: boolean;
  private readonly decorate?: (conversationId: string, message: ApiMessage) => Promise<ApiMessage>;
  private readonly onReply?: ChatHubOptions["onReply"];
  /** Ereignisse je Gespräch, die auf eine Ergänzung (decorate) warten */
  private readonly pending = new Map<string, Promise<void>>();
  private readonly running = new Map<string, RunningTurn>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly turns = new Set<Promise<void>>();
  /** Wartende auf das Ende der Sperre eines Gesprächs (postAfterTurn) */
  private readonly idleWaiters = new Map<string, (() => void)[]>();
  private closing = false;
  private shutdownAbortText?: string;

  constructor(options: ChatHubOptions) {
    this.store = options.store;
    this.chat = options.chat;
    this.keepaliveMs = options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
    this.log = options.log ?? (() => {});
    this.publishUserMessages = !!options.publishUserMessages;
    this.decorate = options.decorate;
    this.onReply = options.onReply;
  }

  get available(): boolean {
    return !!this.chat;
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /** true, solange eine Rückfrage des laufenden Turns auf Antwort wartet */
  isAwaiting(id: string): boolean {
    return !!this.running.get(id)?.awaiting;
  }

  /** Vollständiger Zustand für status-Ereignisse und Abrufe, samt Kennung einer offenen Rückfrage */
  status(id: string): TurnStatus {
    const turn = this.running.get(id);
    if (!turn) return { running: false };
    if (!turn.awaiting || !turn.approvalId) return { running: true, awaiting: false };
    return { running: true, awaiting: true, approvalId: turn.approvalId };
  }

  /**
   * Speichert die Nutzernachricht und startet den Turn im Hintergrund.
   * "busy", wenn im Gespräch schon ein Turn läuft; dann wird nichts gespeichert.
   * Wartet der laufende Turn auf eine Rückfrage, ist die Nachricht die Antwort,
   * aber nur mit der Kennung genau dieser Rückfrage. Eine Antwort auf eine
   * abgelaufene oder andere Rückfrage ist "stale"; dann wird nichts gespeichert.
   * Anhänge (Issue #72) stehen in der Nutzernachricht (POST-Antwort, SSE) und
   * gehen ohne Adressen an den Turn; mit einer Rückfrage-Antwort gibt es keine.
   */
  async send(
    conversation: HubConversation,
    text: string,
    approvalId?: string,
    source: MessageSource = "web",
    attachments: ApiAttachment[] = []
  ): Promise<{ status: "busy" } | { status: "stale" } | { status: "closing" } | { status: "started"; message: StoredMessage }> {
    const id = conversation.id;
    if (this.closing) return { status: "closing" };
    if (approvalId !== undefined && attachments.length) throw new Error("Anhänge nur mit einer neuen Nachricht");
    // Prüfen und Reservieren ohne await dazwischen: gleichzeitige Anfragen sehen die Sperre
    const current = this.running.get(id);
    if (approvalId !== undefined) {
      if (!current?.awaiting || !this.chat?.answer || current.approvalId !== approvalId) return { status: "stale" };
      return this.answer(id, current, text, approvalId, source);
    }
    if (current) return { status: "busy" };
    const turn: RunningTurn = { stopRequested: false, started: false, awaiting: false, finishing: false };
    this.running.set(id, turn);

    // Schon vor dem ersten await verfolgen: shutdown() wartet auch auf einen
    // Turn, dessen Nutzernachricht gerade noch gespeichert wird
    const accepted = this.store.appendMessage(id, { role: "user", text, ...(attachments.length ? { attachments } : {}) });
    const forTurn: MessageAttachment[] = attachments.map(a => ({ id: a.id, name: a.name, size: a.size, mime: a.mime, kind: a.kind }));
    const done = accepted.then(
      message => {
        if (this.publishUserMessages) this.publishApiMessage(id, toApiMessage(message));
        this.publish(id, "status", { running: true });
        return this.runInBackground(conversation, text, turn, message.id, message.createdAt, source, forTurn);
      },
      () => {
        this.running.delete(id);
        this.wakeIdle(id);
      }
    );
    this.turns.add(done);
    void done.finally(() => this.turns.delete(done));
    const message = await accepted;
    return { status: "started", message };
  }

  /**
   * Slash-Befehl aus Browser oder Terminal (Issue #74): Nutzernachricht
   * ablegen, dann den Befehl statt eines Turns ausführen. Seine Antworten legt
   * er selbst ab (Meldungen); der Hub speichert keine Antwort und meldet kein
   * „Keine Antwort erhalten", nur einen Fehler (outcome.failed) oder einen
   * Abbruch. Ein Befehl sperrt das Gespräch wie ein Turn ("busy", Stopp-Knopf
   * wirkt über signal). whileBusy (/stop) läuft ohne Sperre, auch während
   * eines Turns, und ist beim Zurückkommen schon fertig; running sagt dann,
   * ob im Gespräch noch etwas läuft.
   */
  async sendCommand(
    conversation: HubConversation,
    text: string,
    run: (execution: CommandExecution) => Promise<CommandOutcome>,
    options: { whileBusy?: boolean } = {}
  ): Promise<{ status: "busy" } | { status: "closing" } | { status: "started"; message: StoredMessage; running: boolean }> {
    const id = conversation.id;
    if (this.closing) return { status: "closing" };
    const controller = new AbortController();
    let turn: RunningTurn | null = null;
    if (!options.whileBusy) {
      // Prüfen und Reservieren ohne await dazwischen, wie bei send()
      if (this.running.has(id)) return { status: "busy" };
      turn = { stopRequested: false, started: true, awaiting: false, finishing: false, command: controller };
      this.running.set(id, turn);
    }
    let message: StoredMessage;
    try {
      message = await this.store.appendMessage(id, { role: "user", text });
    } catch (e) {
      if (turn && this.running.get(id) === turn) this.running.delete(id);
      this.wakeIdle(id);
      throw e;
    }
    if (this.publishUserMessages) this.publishApiMessage(id, toApiMessage(message));
    if (turn) this.publish(id, "status", { running: true });
    const done = this.runCommand(id, message, controller, turn, run).finally(() => {
      if (!turn) {
        this.publish(id, "status", this.status(id));
        return;
      }
      if (this.running.get(id) === turn) this.running.delete(id);
      this.publish(id, "status", { running: false });
      this.wakeIdle(id);
    });
    this.turns.add(done);
    void done.finally(() => this.turns.delete(done));
    if (!turn) await done;
    return { status: "started", message, running: turn ? true : this.isRunning(id) };
  }

  private async runCommand(
    id: string,
    message: StoredMessage,
    controller: AbortController,
    turn: RunningTurn | null,
    run: (execution: CommandExecution) => Promise<CommandOutcome>
  ): Promise<void> {
    let active = true;
    const sink: TurnSink = {
      progress: p => {
        if (active) this.publish(id, "progress", { kind: p.kind, text: p.text });
      },
      notice: t => {
        if (active) this.publish(id, "notice", { text: t });
      },
    };
    const post = async (m: NewMessage & { id?: string }) => {
      const stored = await this.store.appendMessage(id, m);
      this.publishApiMessage(id, toApiMessage(stored));
    };
    // Rückfragen (Werkzeug-Freigaben) wie in runInBackground; /stop (ohne Sperre) fragt nie
    const ask = async (question: string, choiceId: string, options: { record?: boolean } = {}) => {
      if (!active || !turn) throw new Error("Befehl beendet");
      if (options.record !== false) {
        const stored = await this.store.appendMessage(id, { role: "assistant", text: question, choiceId });
        this.publishApiMessage(id, toApiMessage(stored));
      }
      if (!active) throw new Error("Befehl beendet");
      turn.approvalId = choiceId;
      turn.awaiting = true;
      this.publish(id, "status", this.status(id));
    };
    const endAsk = (approvalId: string) => {
      if (!turn || turn.approvalId !== approvalId) return;
      const wasAwaiting = turn.awaiting;
      turn.awaiting = false;
      turn.approvalId = undefined;
      if (wasAwaiting && active) this.publish(id, "status", this.status(id));
    };
    let outcome: CommandOutcome;
    try {
      outcome = await run({
        messageId: message.id,
        receivedAt: message.createdAt,
        signal: controller.signal,
        sink,
        notice: text => post({ role: "assistant", kind: "notice", source: COMMAND_NOTICE_SOURCE, text }),
        answer: (text, info, messageId) => post({ role: "assistant", text, ...pickReplyInfo(info), ...(messageId ? { id: messageId } : {}) }),
        ask,
        endAsk,
        commit: () => {
          if (turn) turn.finishing = true;
        },
        followUp: () => {
          // Wie die Nacharbeit eines Turns: stop() prüft followUp vor finishing
          const followUp = new AbortController();
          // Ohne Sperre (whileBusy) gibt es keinen Stopp-Knopf, das Signal bleibt dann offen
          if (turn && active) turn.followUp = followUp;
          return followUp.signal;
        },
      });
    } catch (e) {
      // Nur der Fehlertyp ins Log, wie bei Turns
      this.log(`Befehl in Gespräch ${id} fehlgeschlagen (${e instanceof Error ? e.name : typeof e})`);
      outcome = { failed: COMMANDS_TEXT.failed };
    }
    active = false;
    if (turn) {
      turn.awaiting = false;
      turn.approvalId = undefined;
      turn.followUp = undefined;
    }
    const errorText = outcome.failed ?? (outcome.aborted ? this.abortText() : null);
    if (!errorText) return;
    try {
      const stored = await this.store.appendMessage(id, { role: "error", text: errorText });
      this.publish(id, "error", stored);
    } catch (e) {
      this.log(`Fehler in Gespräch ${id} nicht gespeichert (${e instanceof Error ? e.name : typeof e})`);
      this.publish(id, "error", { text: SAVE_FAILED_TEXT });
    }
  }

  /**
   * Eingetippte Antwort auf eine Rückfrage (Issue #116): erst im Register
   * entscheiden (mit der Quelle Browser oder Terminal), dann in den Verlauf.
   * Ist die Frage inzwischen anders entschieden, abgelaufen oder abgebrochen,
   * ist die Antwort "stale" und wird nicht gespeichert.
   */
  private async answer(
    id: string,
    turn: RunningTurn,
    text: string,
    approvalId: string,
    source: MessageSource
  ): Promise<{ status: "stale" } | { status: "started"; message: StoredMessage }> {
    // Sofort sperren: eine zweite Antwort zur selben Zeit ist "stale"
    turn.awaiting = false;
    const restore = () => {
      if (this.running.get(id) === turn && turn.approvalId === approvalId) turn.awaiting = true;
    };
    let decided: boolean;
    try {
      decided = await this.chat!.answer!(id, text, approvalId, source);
    } catch (e) {
      restore();
      throw e;
    }
    if (!decided) {
      // Die Frage ist woanders erledigt: endAsk setzt den Status; steht sie noch, bleibt sie offen
      restore();
      return { status: "stale" };
    }
    const message = await this.store.appendMessage(id, { role: "user", text });
    if (this.running.get(id) === turn) this.publish(id, "status", this.status(id));
    return { status: "started", message };
  }

  /**
   * Führt fn aus, während das Gespräch wie bei einem laufenden Turn gesperrt
   * ist (Issue #21: Löschen). "busy", wenn schon ein Turn läuft, auch wenn er
   * auf eine Rückfrage wartet oder seine Abschlussmeldung speichert. Prüfen
   * und Reservieren ohne await dazwischen; die Sperre hält, bis fn fertig
   * ist, und ein gleichzeitiges send() bekommt so lange "busy".
   */
  async exclusive<T>(id: string, fn: () => Promise<T>): Promise<{ status: "busy" } | { status: "closing" } | { status: "done"; value: T }> {
    if (this.closing) return { status: "closing" };
    if (this.running.has(id)) return { status: "busy" };
    // finishing: Stopp-Knopf und shutdown() haben nichts abzubrechen
    const lock: RunningTurn = { stopRequested: false, started: false, awaiting: false, finishing: true };
    this.running.set(id, lock);
    let work: Promise<T>;
    try {
      work = fn();
    } catch (e) {
      work = Promise.reject(e);
    }
    const done = work.then(
      () => {},
      () => {}
    );
    this.turns.add(done);
    void done.finally(() => this.turns.delete(done));
    try {
      return { status: "done", value: await work };
    } finally {
      if (this.running.get(id) === lock) this.running.delete(id);
      this.wakeIdle(id);
    }
  }

  /**
   * Das Gespräch gibt es nicht mehr: offene Browser bekommen ein
   * deleted-Ereignis, danach werden ihre Verbindungen beendet.
   */
  closeConversation(id: string): void {
    const close = () => {
      this.deliver(id, "deleted", { id });
      for (const s of [...(this.subscribers.get(id) ?? [])]) s.terminate();
    };
    // Nach einer noch wartenden ergänzten Nachricht, sonst sofort
    if (this.pending.has(id)) this.enqueue(id, close);
    else close();
  }

  /** Bricht den laufenden Turn ab. false, wenn keiner läuft. */
  stop(id: string): boolean {
    const turn = this.running.get(id);
    if (!turn) return false;
    // Nacharbeit läuft: die gespeicherte Antwort bleibt, nur die Rückfragen enden
    if (turn.followUp) {
      turn.stopRequested = true;
      turn.followUp.abort();
      return true;
    }
    // Turn fertig, Abschlussmeldung wird gespeichert: kein Abbruch mehr melden
    if (turn.finishing) return false;
    if (turn.command) {
      turn.stopRequested = true;
      turn.command.abort();
      return true;
    }
    // Wird die Antwort schon gespeichert, lehnt der Chat ab: kein Abbruch melden
    if (turn.started && this.chat?.stop(id) === false) return false;
    turn.stopRequested = true;
    return true;
  }

  /**
   * SSE-Antwort; status kommt sofort, danach alle Ereignisse des Gesprächs.
   * Die Verbindung gehört zu einer Anmelde-Session: Ist sie abgelaufen oder
   * abgemeldet, geht nichts mehr raus und der Stream wird beendet.
   */
  subscribe(id: string, signal: AbortSignal, options: SubscribeOptions = {}): Response {
    const isAuthorized = options.isAuthorized ?? (() => true);
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        let closed = false;
        const subscriber: Subscriber = {
          session: options.session,
          send(chunk) {
            if (closed) return;
            if (!isAuthorized()) {
              subscriber.terminate();
              return;
            }
            try {
              controller.enqueue(encoder.encode(chunk));
            } catch {
              cleanup();
            }
          },
          // Nur aufräumen, nicht controller.close(): Trennt der Browser im selben
          // Moment, bleibt Buns server.stop(true) danach hängen (Bun 1.3.10).
          // Die Verbindung selbst schließt server.stop(true).
          close: () => cleanup(),
          terminate: () => {
            if (closed) return;
            cleanup();
            try {
              controller.close();
            } catch {
              // schon geschlossen
            }
          },
        };
        const timer = setInterval(() => subscriber.send(": keepalive\n\n"), this.keepaliveMs);
        cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          signal.removeEventListener("abort", cleanup);
          const set = this.subscribers.get(id);
          set?.delete(subscriber);
          if (set?.size === 0) this.subscribers.delete(id);
        };
        signal.addEventListener("abort", cleanup);
        let set = this.subscribers.get(id);
        if (!set) this.subscribers.set(id, (set = new Set()));
        set.add(subscriber);
        // Samt offener Rückfrage: sonst hielte der Browser sie nach dem Neuverbinden für erledigt
        // Ohne status ein Kommentar: Bun schickt die Kopfzeilen erst mit dem ersten Byte
        subscriber.send(options.initialStatus === false ? ": verbunden\n\n" : sseEvent("status", this.status(id)));
      },
      cancel: () => cleanup(),
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  }

  /**
   * Nachricht, die nicht über send() kam (Issue #20: in Telegram geschrieben
   * und gespeichert), an die offenen Browser genau dieses Gesprächs.
   */
  publishMessage(id: string, message: ApiMessage): void {
    this.publishApiMessage(id, message);
  }

  /**
   * Nachricht von außerhalb eines Turns (Issue #117: Merk-Vorschlag mit
   * choiceId, Ergebnis einer Entscheidung) ablegen und an die offenen Browser
   * senden. Läuft im Gespräch gerade ein Turn oder Befehl, erst danach: ein
   * Vorschlag aus der Antwort steht so unter ihr. Wartet nie selbst; Fehler
   * (etwa Gespräch inzwischen gelöscht) landen nur im Log. onStored läuft nach
   * dem Senden mit der gespeicherten Nachricht (Issue #226: Push für Meldungen).
   */
  postAfterTurn(id: string, message: NewMessage, onStored?: (stored: StoredMessage) => void): void {
    const work = this.whenIdle(id)
      .then(async () => {
        const stored = await this.store.appendMessage(id, message);
        this.publishApiMessage(id, toApiMessage(stored));
        try {
          onStored?.(stored);
        } catch (e) {
          this.log(`Nachfolge zu einer Nachricht in ${id} fehlgeschlagen (${e instanceof Error ? e.name : typeof e})`);
        }
      })
      .catch(e => this.log(`Nachricht in Gespräch ${id} nicht abgelegt (${e instanceof Error ? e.name : typeof e})`));
    this.turns.add(work);
    void work.finally(() => this.turns.delete(work));
  }

  /** Erfüllt, sobald im Gespräch nichts mehr läuft (oder der Hub beendet wird) */
  private whenIdle(id: string): Promise<void> {
    if (!this.running.has(id) || this.closing) return Promise.resolve();
    return new Promise(resolve => {
      const list = this.idleWaiters.get(id) ?? [];
      list.push(resolve);
      this.idleWaiters.set(id, list);
    });
  }

  private wakeIdle(id: string): void {
    if (this.running.has(id) && !this.closing) return;
    const list = this.idleWaiters.get(id);
    if (!list) return;
    this.idleWaiters.delete(id);
    for (const resolve of list) resolve();
  }

  /**
   * Neuer Zustand einer Rückfrage (Issue #115) an die offenen Browser dieses
   * Gesprächs bzw. an einen Sammelstrom; data wie in server.ts beschrieben
   */
  publishChoice(id: string, data: unknown): void {
    this.publish(id, "choice", data);
  }

  /** Status-Karte eines Ziels (Issue #76) an die offenen Browser dieses Gesprächs; null: keine Karte mehr */
  publishGoal(id: string, card: unknown): void {
    this.publish(id, "goal", { card });
  }

  /** Aktivität eines Gesprächs an einen Sammelstrom (Seitenleiste), ohne Nachrichteninhalt */
  publishActivity(streamId: string, activity: { id: string; lastActivity: string }): void {
    this.publish(streamId, "activity", { id: activity.id, lastActivity: activity.lastActivity });
  }

  /** Name eines Telegram-Topics geändert oder Topic neu (Issue #32): nur die ID, der Browser holt die Liste */
  publishTopicChange(streamId: string, id: string): void {
    this.publish(streamId, "topic", { id });
  }

  /** Motor-Einstellungen geändert (Issue #126): ohne Inhalt, der Browser holt die Gesprächsliste */
  publishEngineChange(streamId: string): void {
    this.publish(streamId, "engine", {});
  }

  /** Anzahl offener SSE-Verbindungen (für Tests). */
  subscriberCount(id?: string): number {
    if (id) return this.subscribers.get(id)?.size ?? 0;
    let n = 0;
    for (const set of this.subscribers.values()) n += set.size;
    return n;
  }

  /** Beendet alle SSE-Verbindungen einer Anmelde-Session (Abmelden). */
  closeSession(session: string): void {
    for (const set of [...this.subscribers.values()]) {
      for (const s of [...set]) if (s.session === session) s.terminate();
    }
  }

  /** Meldet alle SSE-Zuhörer ab und räumt Timer auf; die Sockets schließt der Server-Stopp. */
  close(): void {
    for (const set of [...this.subscribers.values()]) for (const s of [...set]) s.close();
    this.subscribers.clear();
  }

  /**
   * Geordnetes Beenden: keine neuen Turns mehr, laufende abbrechen, ihnen
   * begrenzt Zeit für die Abschlussmeldung (speichern und per SSE senden)
   * geben, danach alle SSE-Zuhörer abmelden.
   */
  async shutdown(options: ChatShutdownOptions = {}): Promise<void> {
    this.closing = true;
    if (options.abortText) this.shutdownAbortText = options.abortText;
    for (const id of [...this.idleWaiters.keys()]) this.wakeIdle(id);
    for (const id of [...this.running.keys()]) this.stop(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>(resolve => {
      timer = setTimeout(resolve, options.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
    });
    const hadTurns = this.turns.size > 0;
    await Promise.race([this.idle(), grace]);
    clearTimeout(timer);
    // Bun schickt eingereihte SSE-Daten erst im nächsten Durchlauf raus; ohne
    // kurze Pause schneidet server.stop(true) die letzte Meldung ab
    if (hadTurns) await new Promise(resolve => setTimeout(resolve, SHUTDOWN_FLUSH_MS));
    this.close();
  }

  private abortText(): string {
    return this.shutdownAbortText ?? ABORTED_TEXT;
  }

  /** Wartet auf alle laufenden Turns (für Tests und geordnetes Beenden). */
  async idle(): Promise<void> {
    while (this.turns.size) await Promise.allSettled([...this.turns]);
  }

  /**
   * Nachricht per SSE: mit choiceId erst ergänzt (decorate), dann gesendet;
   * alle späteren Ereignisse des Gesprächs warten so lange
   */
  private publishApiMessage(id: string, message: ApiMessage): void {
    const { choiceId, ...rest } = message;
    const decorate = this.decorate;
    if (!choiceId || !decorate) {
      this.publish(id, "message", rest);
      return;
    }
    this.enqueue(id, async () => {
      const { choice: _choice, ...unread } = message;
      let out: ApiMessage = unread;
      try {
        out = await decorate(id, message);
      } catch (e) {
        // Ohne Zustand nur die Kennung: der Browser fragt den Stand nach, bis er lesbar ist
        this.log(`Rückfrage zu einer Nachricht in ${id} nicht lesbar (${e instanceof Error ? e.name : typeof e})`);
      }
      this.deliver(id, "message", out);
    });
  }

  private enqueue(id: string, step: () => Promise<void> | void): void {
    const previous = this.pending.get(id) ?? Promise.resolve();
    const next = previous.then(step).catch(() => {});
    this.pending.set(id, next);
    void next.then(() => {
      if (this.pending.get(id) === next) this.pending.delete(id);
    });
  }

  private publish(id: string, event: string, data: unknown): void {
    // Wartet im Gespräch eine ergänzte Nachricht, bleibt die Reihenfolge
    if (this.pending.has(id)) {
      this.enqueue(id, () => this.deliver(id, event, data));
      return;
    }
    this.deliver(id, event, data);
  }

  private deliver(id: string, event: string, data: unknown): void {
    const set = this.subscribers.get(id);
    if (!set) return;
    const chunk = sseEvent(event, data);
    for (const s of [...set]) s.send(chunk);
  }

  private notifyReply(conversationId: string, text: string, agent: string | undefined, source: MessageSource): void {
    if (!this.onReply) return;
    try {
      this.onReply({ conversationId, text, ...(agent ? { agent } : {}), source });
    } catch (e) {
      this.log(`Benachrichtigung zu Gespräch ${conversationId} fehlgeschlagen (${e instanceof Error ? e.name : typeof e})`);
    }
  }

  /** Nacharbeit eines Turns (Issue #76); ihre Fehler beenden nur sie, nie den Turn */
  private async runFollowUp(id: string, followUp: NonNullable<TurnResult["followUp"]>, signal: AbortSignal): Promise<void> {
    try {
      await followUp({
        signal,
        answer: async (text, info, messageId) => {
          const stored = await this.store.appendMessage(id, { role: "assistant", text, ...pickReplyInfo(info), ...(messageId ? { id: messageId } : {}) });
          this.publishApiMessage(id, toApiMessage(stored));
        },
        notice: async text => {
          this.publish(id, "notice", { text });
        },
      });
    } catch (e) {
      this.log(`Nacharbeit in Gespräch ${id} fehlgeschlagen (${e instanceof Error ? e.name : typeof e})`);
    }
  }

  private async runInBackground(
    conversation: HubConversation,
    text: string,
    turn: RunningTurn,
    messageId: string,
    receivedAt: string,
    source: MessageSource,
    attachments: MessageAttachment[] = []
  ): Promise<void> {
    const id = conversation.id;
    let active = true;
    const sink: TurnSink = {
      progress: p => {
        if (active) this.publish(id, "progress", { kind: p.kind, text: p.text });
      },
      notice: t => {
        if (active) this.publish(id, "notice", { text: t });
      },
    };

    let reply: NewMessage & { role: "assistant" | "error"; id?: string };
    let followUp: TurnResult["followUp"];
    try {
      if (!this.chat) throw new Error("Kein Chat eingebunden");
      if (turn.stopRequested) {
        reply = { role: "error", text: this.abortText() };
      } else {
        turn.started = true;
        const ask = async (question: string, choiceId: string, options: { record?: boolean } = {}) => {
          if (!active) throw new Error("Turn beendet");
          // Telegram-Gespräche (record false): die Frage kommt über den Nachrichtenspeicher, nie doppelt
          if (options.record !== false) {
            const stored = await this.store.appendMessage(id, { role: "assistant", text: question, choiceId });
            this.publishApiMessage(id, toApiMessage(stored));
          }
          if (!active) throw new Error("Turn beendet");
          turn.approvalId = choiceId;
          turn.awaiting = true;
          this.publish(id, "status", this.status(id));
        };
        const endAsk = (approvalId: string) => {
          if (turn.approvalId !== approvalId) return;
          const wasAwaiting = turn.awaiting;
          turn.awaiting = false;
          turn.approvalId = undefined;
          if (wasAwaiting && active) this.publish(id, "status", this.status(id));
        };
        const result = await this.chat.runTurn({
          conversationId: id,
          agent: conversation.agent,
          text,
          ...(conversation.title ? { title: conversation.title } : {}),
          messageId,
          receivedAt,
          source,
          ...(attachments.length ? { attachments } : {}),
          sink,
          ask,
          endAsk,
        });
        if (result.aborted || turn.stopRequested) {
          // Eine eigene Abbruchmeldung des Turns (Bot beendet) geht vor
          const own = result.aborted && result.text?.trim() ? result.text : null;
          reply = { role: "error", text: own ?? this.abortText() };
        }
        else if (result.failed) reply = { role: "error", text: result.text?.trim() ? result.text : TURN_FAILED_TEXT };
        else if (!result.text?.trim()) reply = { role: "error", text: EMPTY_REPLY_TEXT };
        else {
          reply = {
            role: "assistant",
            text: result.text,
            ...(result.messageId ? { id: result.messageId } : {}),
            ...pickReplyInfo(result.info),
          };
          followUp = result.followUp;
        }
      }
    } catch (e) {
      // Nur der Fehlertyp ins Log: Meldungen können Pfade oder Zugangsdaten enthalten
      this.log(`Turn in Gespräch ${id} fehlgeschlagen (${e instanceof Error ? e.name : typeof e})`);
      reply = turn.stopRequested ? { role: "error", text: this.abortText() } : { role: "error", text: TURN_FAILED_TEXT };
    }
    active = false;
    turn.finishing = true;
    turn.awaiting = false;
    turn.approvalId = undefined;

    // Erst speichern, dann senden, dann Nacharbeit, dann die Sperre lösen
    try {
      const stored = await this.store.appendMessage(id, reply);
      if (stored.role === "assistant") {
        this.publishApiMessage(id, toApiMessage(stored));
        this.notifyReply(id, stored.text, stored.agent ?? conversation.agent, source);
      } else this.publish(id, "error", stored);
      if (followUp && stored.role === "assistant") {
        // Eigener Lebenszyklus: der Stopp-Knopf bricht die Rückfragen ab, die Antwort bleibt gespeichert
        const controller = new AbortController();
        turn.followUp = controller;
        try {
          await this.runFollowUp(id, followUp, controller.signal);
        } finally {
          turn.followUp = undefined;
        }
        if (controller.signal.aborted) {
          const stopped = await this.store.appendMessage(id, { role: "error", text: this.abortText() });
          this.publish(id, "error", stopped);
        }
      }
    } catch (e) {
      this.log(`Antwort in Gespräch ${id} nicht gespeichert (${e instanceof Error ? e.name : typeof e})`);
      this.publish(id, "error", { text: SAVE_FAILED_TEXT });
    } finally {
      this.running.delete(id);
      this.publish(id, "status", { running: false });
      this.wakeIdle(id);
    }
  }
}
