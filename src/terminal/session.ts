/**
 * Chat-Logik von tybo ohne Terminal (Issue #60): Verlauf laden, senden,
 * stoppen, Live-Ereignisse verarbeiten. Die Anzeige hängt über ChatOutput
 * daran (echtes Terminal in app.ts, Aufzeichnung in Tests).
 *
 * Nachrichten kommen auf drei Wegen: Verlauf (GET), Antwort auf das Senden
 * (POST) und Live-Ereignisse (SSE). Jede Nachricht hat eine ID; was schon
 * bekannt ist, wird nicht noch einmal gezeigt. Nach jeder Wiederverbindung
 * gleicht die Sitzung den Verlauf ab, denn der Server holt verpasste
 * Ereignisse nicht nach.
 */

import { BRAND } from "../brand";
import { ApiError, isMessage, toChoice, type ApiChoice, type ApiClient, type ConversationSummary, type Message } from "./api";
import { LiveConnection, type LiveEvent, type LiveOptions } from "./live";
import { sanitizeLine } from "./sanitize";
import { HISTORY_LINES, progressLabel } from "./view";

export interface ChatOutput {
  /** Eine Nachricht aus Verlauf, Senden oder live */
  message(m: Message): void;
  /** Hinweis von tybo selbst (Verbindung, Fehler beim Senden) */
  note(text: string, kind?: "info" | "error"): void;
  /** Statuszeile geändert (null: keine Antwort läuft) */
  status(text: string | null): void;
  /**
   * Rückfrage einer schon gezeigten Nachricht hat sich geändert (Issue #120):
   * erledigt oder abgelaufen (Zeile „Erledigt: …"), oder ihr Stand kam erst
   * jetzt und sie ist offen (Optionen nachreichen). reminder: eine neuere
   * Frage ist erledigt, Zahlen gelten jetzt wieder für diese ältere.
   */
  choice?(choice: ApiChoice, reminder?: boolean): void;
}

/**
 * Ergebnis einer Auswahl per Zahl. handled false: keine offene Rückfrage,
 * die Eingabe gilt als normale Nachricht. settled: die Frage ist jetzt
 * erledigt oder nicht mehr wählbar (auch bei einem Fehler wie „schon
 * entschieden"), der Entwurf kommt nicht zurück.
 */
export type ChooseOutcome = { handled: false } | { handled: true; ok: boolean; settled: boolean; error?: string };

export type SendOutcome = { ok: true } | { ok: false; error: string };

export interface ChatSessionOptions {
  client: ApiClient;
  conversation: ConversationSummary;
  output: ChatOutput;
  live?: LiveOptions;
  now?: () => number;
}

export const NOT_REACHABLE_TEXT = "Keine Verbindung zum Bot, die Nachricht wurde nicht gesendet.";

/** Versuche eines Verlaufsabgleichs, bevor die Sitzung aufgibt */
export const SYNC_ATTEMPTS = 5;

/** Höchstens so viele Rückfragen fragt ein Abgleich ab (wie MAX_CHOICE_SNAPSHOT im Server) */
const CHOICE_SNAPSHOT_MAX = 200;
/** Wie CHOICE_ID_PATTERN in src/web/store.ts */
const CHOICE_ID = /^[A-Za-z0-9]{1,12}$/;

function isSelectable(c: ApiChoice): boolean {
  return c.state === "open" && c.options.length > 0 && !c.elsewhere;
}

export class ChatSession {
  readonly conversation: ConversationSummary;
  private readonly client: ApiClient;
  private readonly output: ChatOutput;
  private readonly known = new Set<string>();
  private live: LiveConnection | null = null;
  private readonly liveOptions?: LiveOptions;
  private readonly now: () => number;
  private running = false;
  private approvalId: string | undefined;
  /**
   * Rückfragen, deren Nachricht angezeigt wurde. Der Status kann vor der
   * Nachricht kommen (Telegram-Gespräche: erst Status, dann sendChoice); bis
   * die Frage zu sehen ist, gilt sie nicht als offen, sonst träfe ein spätes
   * „ja“ zur vorigen Frage eine noch unsichtbare neue.
   */
  private readonly shownChoices = new Set<string>();
  /**
   * Rückfragen (Issue #120): angezeigter Stand je Frage, Endzustände (werden
   * nie wieder offen, nur „abgelaufen" darf noch zu „erledigt" werden),
   * wählbare Fragen in Anzeigereihenfolge (die letzte gilt für eine Zahl),
   * gezeigte Fragen ohne lesbaren Stand und laufende Auswahlen.
   */
  private readonly displayedChoices = new Map<string, ApiChoice>();
  private readonly finalChoices = new Map<string, ApiChoice>();
  private readonly selectable: string[] = [];
  private readonly unresolvedChoices = new Set<string>();
  private readonly choosing = new Set<string>();
  private activity: string | null = null;
  private startedAt = 0;
  private connected = false;
  private gone = false;
  private closed = false;
  /** Laufender Abgleich des Verlaufs samt Wiederholungen (siehe beginSync) */
  private syncLoop: Promise<void> | null = null;
  /** Eine (Wieder-)Verbindung wartet noch auf ihren Abgleich */
  private syncAgain = false;
  /**
   * Was vor der ersten nicht abgeglichenen Unterbrechung bekannt war,
   * festgehalten beim Start der Live-Verbindung und beim Abbruch, nicht erst
   * beim Wiederverbinden. Bleibt stehen, bis ein Abgleich gelungen ist; live
   * oder per POST eingegangene Nachrichten zählen nicht dazu, sonst endet die
   * Seitensuche zu früh.
   */
  private syncBoundary: Set<string> | null = null;
  /** Der Verlauf wurde vollständig geladen: eine leere Grenze heißt dann „alles ist neu“ */
  private historyLoaded = false;
  private syncGaveUp = false;
  private wakeSyncRetry: (() => void) | null = null;
  /**
   * Zählt status-Ereignisse mit running:true: kam während des Sendens eins,
   * gilt der Live-Stand statt der eigenen Annahme. Ein status(running:false)
   * allein zählt nicht, er kann noch vom Aufbau der Verbindung vor dem Senden
   * stammen.
   */
  private runningSeq = 0;
  /**
   * Zählt, was neuer ist als der Stand eines Verlaufs-GET: angenommene
   * Nachrichten (POST) und status-Ereignisse außer dem Anfangsstatus einer
   * Verbindung. Der Anfangsstatus stammt vom Aufbau der Verbindung, also von
   * vor dem Abgleichs-GET.
   */
  private stateSeq = 0;
  /** Das nächste status-Ereignis ist der Anfangsstatus einer neuen Verbindung */
  private initialStatusPending = false;
  /**
   * running kommt nur aus der eigenen Annahme nach einem POST, noch von
   * keinem status bestätigt. Wurde der POST im selben Verbindungsversuch
   * gesendet, dessen Anfangsstatus running:false meldet, ist dieser Status
   * älter als der POST und beendet die Antwort nicht; den Stand liefert der
   * Abgleichs-GET. Ein späterer Versuch baut erst nach dem POST auf, sein
   * Anfangsstatus gilt.
   */
  private runningAssumed = false;
  /** Verbindungsversuch, in dem der POST hinter runningAssumed gesendet wurde */
  private assumedAttempt = -1;
  /** Zählt die Verbindungsversuche (jeder Abbruch beginnt einen neuen) */
  private attempt = 0;

  constructor(options: ChatSessionOptions) {
    this.client = options.client;
    this.conversation = options.conversation;
    this.output = options.output;
    this.liveOptions = options.live;
    this.now = options.now ?? Date.now;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Eine Rückfrage wartet: die nächste Nachricht ist die Antwort darauf */
  get isAwaiting(): boolean {
    return !!this.shownApprovalId;
  }

  /** Offene Rückfrage, deren Nachricht schon angezeigt wurde */
  private get shownApprovalId(): string | undefined {
    return this.running && this.approvalId && this.shownChoices.has(this.approvalId) ? this.approvalId : undefined;
  }

  get isGone(): boolean {
    return this.gone;
  }

  /** Text der Statuszeile samt Laufzeit, null ohne laufende Antwort */
  statusText(): string | null {
    if (!this.running) return null;
    if (this.shownApprovalId) return "Wartet auf deine Antwort auf die Rückfrage";
    const seconds = Math.max(0, Math.floor((this.now() - this.startedAt) / 1000));
    return `${this.activity ?? "Denkt nach …"} (${seconds} s)`;
  }

  private emitStatus(): void {
    this.output.status(this.statusText());
  }

  /**
   * Zeigt nur noch nicht bekannte Nachrichten, in der gegebenen Reihenfolge.
   * Bei bekannten zählt nur ein neuer Stand ihrer Rückfrage (Abgleich).
   */
  private add(messages: Message[], show = true): void {
    let awaitedShown = false;
    for (const raw of messages) {
      const choice = raw.role === "user" ? null : toChoice(raw.choice);
      if (this.known.has(raw.id)) {
        if (choice) this.updateChoice(choice);
        continue;
      }
      this.known.add(raw.id);
      const m: Message = choice ? { ...raw, choice: this.settle(choice) } : raw;
      if (!show) continue;
      this.output.message(m);
      const choiceId = m.choice?.id ?? m.choiceId;
      if (!choiceId) continue;
      this.shownChoices.add(choiceId);
      if (m.choice) this.display(m.choice);
      else if (CHOICE_ID.test(choiceId)) this.unresolvedChoices.add(choiceId);
      if (choiceId === this.approvalId) awaitedShown = true;
    }
    // Status kam vor der Nachricht: jetzt erst wartet die Frage sichtbar
    if (awaitedShown && this.running) this.emitStatus();
  }

  /**
   * Stand einer Rückfrage mit den bekannten Endzuständen: ein Endzustand
   * wird nie wieder offen (verspätete Daten), nur „abgelaufen" darf noch zu
   * „erledigt" werden. Merkt sich neue Endzustände.
   */
  private settle(c: ApiChoice): ApiChoice {
    if (c.state !== "open") {
      const known = this.finalChoices.get(c.id);
      if (!known || (known.state === "expired" && c.state === "done")) {
        this.finalChoices.set(c.id, { id: c.id, state: c.state, options: [], ...(c.result ? { result: c.result } : {}) });
      }
    }
    const final = this.finalChoices.get(c.id);
    if (!final) return c;
    return { ...final, ...(c.elsewhere ? { elsewhere: c.elsewhere } : {}) };
  }

  /** Frage ist jetzt sichtbar: offen und mit Knöpfen wird sie die Frage für Zahlen */
  private display(c: ApiChoice): void {
    this.displayedChoices.set(c.id, c);
    this.unresolvedChoices.delete(c.id);
    const i = this.selectable.indexOf(c.id);
    if (i >= 0) this.selectable.splice(i, 1);
    if (isSelectable(c)) this.selectable.push(c.id);
  }

  /**
   * Neuer Stand einer Rückfrage (SSE choice, Antwort auf die Auswahl,
   * Abgleich). Eine sichtbare offene Frage, die jetzt erledigt ist, bekommt
   * genau eine Zeile; eine gezeigte Frage ohne Stand bekommt ihre Optionen.
   * Fragen, die hier nicht zu sehen sind, merken nur ihren Endzustand.
   */
  private updateChoice(incoming: ApiChoice): void {
    const settled = this.settle(incoming);
    const before = this.displayedChoices.get(settled.id);
    if (!before) {
      if (!this.unresolvedChoices.has(settled.id)) return;
      this.display(settled);
      this.output.choice?.(settled);
      return;
    }
    // Aus Sicht dieser Nachricht: ein Verweis auf ein anderes Gespräch bleibt
    const next = before.elsewhere ? { ...settled, options: [], elsewhere: before.elsewhere } : settled;
    // Schon erledigt: nur „abgelaufen" zu „erledigt" nachziehen, keine zweite Zeile
    if (before.state !== "open") {
      this.displayedChoices.set(next.id, next);
      return;
    }
    if (next.state === "open") return;
    const wasTarget = this.choiceTarget?.id === next.id;
    this.display(next);
    this.output.choice?.(next);
    const target = this.choiceTarget;
    if (wasTarget && target) this.output.choice?.(target, true);
  }

  /** Offene Rückfrage, für die eine Zahl gilt: die zuletzt gezeigte wählbare dieses Gesprächs */
  get choiceTarget(): ApiChoice | null {
    const id = this.selectable.at(-1);
    return id ? (this.displayedChoices.get(id) ?? null) : null;
  }

  /**
   * Option n (ab 1) der Frage aus choiceTarget wählen, genau ein POST. Ohne
   * offene Frage handled false. Eine ungültige Nummer sendet nichts. 409 und
   * 404 übernehmen den Stand des Servers; die Eingabe geht danach nie als
   * Nachricht oder als andere Auswahl raus.
   */
  async choose(n: number): Promise<ChooseOutcome> {
    const target = this.choiceTarget;
    if (!target) return { handled: false };
    if (this.choosing.has(target.id)) return { handled: true, ok: false, settled: true, error: "Die Auswahl wird schon gesendet." };
    const count = target.options.length;
    if (!Number.isInteger(n) || n < 1 || n > count) {
      return { handled: true, ok: false, settled: false, error: `Keine Option ${n} bei dieser Rückfrage, möglich ${count === 1 ? "ist 1" : `sind 1 bis ${count}`}.` };
    }
    const option = target.options[n - 1];
    this.choosing.add(target.id);
    try {
      const result = await this.client.decideChoice(this.conversation.id, target.id, option.key);
      switch (result.status) {
        case "decided":
          this.updateChoice(result.choice);
          return { handled: true, ok: true, settled: true };
        case "already":
        case "expired":
          this.updateChoice(result.choice);
          return {
            handled: true,
            ok: false,
            settled: true,
            error: sanitizeLine(result.error) || (result.status === "already" ? "Diese Rückfrage ist schon entschieden." : "Diese Rückfrage ist abgelaufen."),
          };
        case "not_found":
          this.updateChoice({ id: target.id, state: "expired", options: [] });
          return { handled: true, ok: false, settled: true, error: sanitizeLine(result.error) || "Diese Rückfrage gibt es in diesem Gespräch nicht." };
        default:
          return { handled: true, ok: false, settled: false, error: sanitizeLine(result.error) || "Ungültige Auswahl" };
      }
    } catch (e) {
      const error =
        e instanceof ApiError && e.status === 0
          ? "Keine Verbindung zum Bot, die Auswahl wurde nicht gesendet."
          : sanitizeLine(e instanceof Error ? e.message : String(e)) || "Die Auswahl ist fehlgeschlagen.";
      return { handled: true, ok: false, settled: false, error };
    } finally {
      this.choosing.delete(target.id);
    }
  }

  /**
   * Nach einem Abgleich: Stand der sichtbaren offenen und der noch
   * ungelesenen Rückfragen nachfragen. Ihre Nachrichten sind schon bekannt,
   * ein in der Lücke verpasstes SSE choice käme sonst nie an. Fehler lassen
   * den bisherigen Stand stehen.
   */
  private async refreshChoices(): Promise<void> {
    const open = [...this.displayedChoices.values()].filter(c => c.state === "open").map(c => c.id);
    const ids = [...new Set([...open, ...this.unresolvedChoices])].slice(-CHOICE_SNAPSHOT_MAX);
    if (ids.length === 0) return;
    try {
      const list = await this.client.choices(this.conversation.id, ids);
      if (this.closed) return;
      for (const c of list) if (ids.includes(c.id)) this.updateChoice(c);
    } catch {
      // Nächste Wiederverbindung oder SSE bringt den Stand
    }
  }

  /** Verlauf laden: die letzten 20 zeigen, alle als bekannt merken */
  async loadHistory(): Promise<void> {
    const page = await this.client.messages(this.conversation.id);
    const older = page.messages.slice(0, Math.max(0, page.messages.length - HISTORY_LINES));
    this.add(older, false);
    this.add(page.messages.slice(-HISTORY_LINES));
    this.applyState(page.running, page.approvalId);
    this.historyLoaded = true;
  }

  private applyState(running: boolean, approvalId?: string): void {
    this.runningAssumed = false;
    if (running && !this.running) {
      this.startedAt = this.now();
      this.activity = null;
    }
    this.running = running;
    this.approvalId = running ? approvalId : undefined;
    if (!running) this.activity = null;
    this.emitStatus();
  }

  /** Ein Abgleich nach (Wieder-)Verbindung läuft noch oder wird wiederholt; die Pipe wartet ihn ab */
  get isSyncing(): boolean {
    return this.syncLoop !== null;
  }

  /** Der letzte Abgleich ist auch nach allen Versuchen gescheitert: es können Nachrichten fehlen */
  get syncFailed(): boolean {
    return this.syncGaveUp;
  }

  /**
   * Ein Durchgang des Abgleichs: was in der Lücke kam, nachtragen. Der Server
   * liefert bei Telegram nur die jüngsten 50. Ist keine davon in boundary,
   * holt die Sitzung über den before-Cursor ältere Seiten, bis eine Nachricht
   * aus boundary auftaucht oder es keine älteren mehr gibt, und zeigt dann
   * alles in zeitlicher Reihenfolge. Scheitert eine Seite, wirft sync und
   * zeigt nichts; ein neuer Durchgang mit derselben Grenze holt alles.
   * Eine leere Grenze nach geladenem Verlauf heißt: alles ist neu, die Suche
   * läuft bis zur ältesten Seite. Kam seit dem ersten GET nichts Neueres
   * (Nachricht angenommen, status), gilt danach dessen Stand der Antwort.
   * Liefert die IDs aller abgeglichenen Seiten.
   */
  async sync(boundary: ReadonlySet<string> = new Set(this.known)): Promise<Set<string>> {
    const id = this.conversation.id;
    const pages: Message[][] = [];
    const seq = this.stateSeq;
    let page = await this.client.messages(id);
    const first = page;
    pages.push(page.messages);
    const seen = new Set(page.messages.map(m => m.id));
    while ((boundary.size > 0 || this.historyLoaded) && page.hasMore && !page.messages.some(m => boundary.has(m.id))) {
      const oldest = page.messages.find(m => m.createdAt);
      if (!oldest) break;
      page = await this.client.messages(id, oldest.createdAt);
      const fresh = page.messages.filter(m => !seen.has(m.id));
      // Kam nichts Neues, gibt es auch nichts mehr zu holen (keine Endlosschleife)
      if (fresh.length === 0) break;
      for (const m of fresh) seen.add(m.id);
      pages.unshift(fresh);
    }
    this.add(pages.flat());
    if (seq === this.stateSeq) this.applyState(first.running, first.approvalId);
    return seen;
  }

  /**
   * Abgleich nach (Wieder-)Verbindung, vor dem ersten Ereignis gezählt.
   * Gescheiterte Durchgänge werden wiederholt (Abstände wie beim Neuverbinden),
   * nach SYNC_ATTEMPTS Fehlschlägen gibt die Sitzung auf und meldet es. Kommt
   * während eines Abgleichs eine weitere Verbindung, folgt ein weiterer
   * Durchgang mit derselben Grenze.
   */
  private beginSync(): void {
    this.syncAgain = true;
    this.syncGaveUp = false;
    this.syncBoundary ??= new Set(this.known);
    if (this.syncLoop) return;
    this.syncLoop = this.runSyncLoop().finally(() => (this.syncLoop = null));
  }

  private async runSyncLoop(): Promise<void> {
    const minMs = this.liveOptions?.retryMinMs ?? 1000;
    const maxMs = this.liveOptions?.retryMaxMs ?? 15_000;
    let failures = 0;
    let delay = minMs;
    while (this.syncAgain && !this.closed) {
      this.syncAgain = false;
      try {
        const boundary = this.syncBoundary ?? new Set(this.known);
        const synced = await this.sync(boundary);
        await this.refreshChoices();
        failures = 0;
        delay = minMs;
        // Schon wieder getrennt: die nächste Lücke beginnt beim Stand dieses Abgleichs. Nicht
        // bei known, das kann schon Neueres aus der Lücke enthalten (POST während des GET)
        if (!this.syncAgain) this.syncBoundary = this.connected ? null : new Set([...boundary, ...synced]);
      } catch {
        if (this.closed) return;
        if (++failures >= SYNC_ATTEMPTS) {
          // Grenze bleibt: die nächste Wiederverbindung sucht von dort aus
          this.syncGaveUp = true;
          this.output.note("Nachrichten aus der Unterbrechung ließen sich nicht laden, es kann etwas fehlen.", "error");
          return;
        }
        this.syncAgain = true;
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, delay);
          this.wakeSyncRetry = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wakeSyncRetry = null;
        delay = Math.min(delay * 2, maxMs);
      }
    }
  }

  startLive(): void {
    if (this.live) return;
    this.connected = true;
    this.syncBoundary ??= new Set(this.known);
    this.live = new LiveConnection(
      this.client,
      this.conversation.id,
      {
        onConnected: reconnect => {
          if (reconnect) this.output.note("Wieder verbunden.");
          this.connected = true;
          this.initialStatusPending = true;
          // Vor dem ersten Ereignis (status) zählen, sonst endet eine Pipe vor dem Nachtragen
          this.beginSync();
        },
        onEvent: event => this.onEvent(event),
        onDisconnected: retryMs => {
          if (this.connected) this.output.note(`Verbindung zum Bot unterbrochen, neuer Versuch in ${Math.round(retryMs / 1000)} s …`, "error");
          this.connected = false;
          this.initialStatusPending = false;
          this.attempt++;
          // Grenze jetzt festhalten: was bis zum Wiederverbinden per POST kommt, gehört schon zur Lücke
          this.syncBoundary ??= new Set(this.known);
        },
        onGone: () => {
          this.gone = true;
          this.running = false;
          this.output.note(`Dieses Gespräch gibt es nicht mehr. Mit ${BRAND.cli} --topic <Name> ein anderes öffnen.`, "error");
          this.emitStatus();
        },
      },
      this.liveOptions
    );
    this.live.start();
  }

  private onEvent({ event, data }: LiveEvent): void {
    const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    if (event === "status") {
      const initial = this.initialStatusPending;
      this.initialStatusPending = false;
      // Anfangsstatus von vor dem eigenen POST: nicht das Ende dieser Antwort, der Abgleich entscheidet
      if (initial && record.running !== true && this.runningAssumed && this.assumedAttempt === this.attempt) return;
      if (!initial) this.stateSeq++;
      if (record.running === true) this.runningSeq++;
      const approvalId = record.awaiting === true && typeof record.approvalId === "string" ? record.approvalId : undefined;
      this.applyState(record.running === true, approvalId);
    } else if (event === "progress") {
      if (!this.running) this.applyState(true);
      this.activity = progressLabel(record.kind, record.text);
      this.emitStatus();
    } else if (event === "notice") {
      this.output.note(sanitizeLine(record.text));
    } else if (event === "message") {
      if (isMessage(data)) this.add([data]);
    } else if (event === "error") {
      if (isMessage(data)) this.add([data]);
      else this.output.note(sanitizeLine(record.text) || "Unbekannter Fehler", "error");
    } else if (event === "choice") {
      // Nur Fragen dieses Gesprächs; die Kopie im Direktchat kommt mit conversationId "dm"
      if (record.conversationId !== this.conversation.id) return;
      const choice = toChoice(record.choice);
      if (choice) this.updateChoice(choice);
    }
  }

  /** Nachricht senden; bei Fehler bleibt der Entwurf beim Aufrufer */
  async send(text: string): Promise<SendOutcome> {
    if (this.gone) return { ok: false, error: "Dieses Gespräch gibt es nicht mehr." };
    if (this.conversation.closed) return { ok: false, error: "Dieses Topic ist geschlossen. In der WebUI wieder öffnen, dann hier schreiben." };
    const seq = this.runningSeq;
    const attempt = this.attempt;
    try {
      const result = await this.client.send(this.conversation.id, text, this.shownApprovalId);
      if (result.status === "accepted") {
        this.add([result.message]);
        this.stateSeq++;
        // Live kann schneller sein als die POST-Antwort, bis hin zum Ende der Antwort;
        // nach einem Befehl, bei dem danach nichts mehr läuft (/stop), nichts annehmen
        if (result.running !== false && !this.running && seq === this.runningSeq) {
          this.applyState(true);
          this.runningAssumed = true;
          this.assumedAttempt = attempt;
        }
        return { ok: true };
      }
      return { ok: false, error: sanitizeLine(result.error) || "Die Nachricht wurde nicht angenommen." };
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) return { ok: false, error: NOT_REACHABLE_TEXT };
      return { ok: false, error: sanitizeLine(e instanceof Error ? e.message : String(e)) };
    }
  }

  /**
   * Stopp wie der Knopf in der WebUI. Klappt er, kommt „Abgebrochen." als
   * Nachricht; ein Hinweis nur, wenn nichts mehr abzubrechen war oder der
   * Stopp nicht ankam.
   */
  async stop(): Promise<boolean> {
    try {
      const stopping = await this.client.stop(this.conversation.id);
      if (!stopping) this.output.note("Nichts mehr abzubrechen, die Antwort wird schon gespeichert.");
      return stopping;
    } catch (e) {
      this.output.note(e instanceof ApiError && e.status === 0 ? "Keine Verbindung zum Bot, Stopp nicht gesendet." : "Stopp hat nicht geklappt.", "error");
      return false;
    }
  }

  /** Statuszeile mit neuer Laufzeit (einmal pro Sekunde aus der Anzeige) */
  tick(): void {
    if (this.running) this.emitStatus();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.wakeSyncRetry?.();
    await this.live?.close();
    this.live = null;
  }
}
