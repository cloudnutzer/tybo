/**
 * Telefonanrufe: anrufen, Protokoll abholen, zusammenfassen, Auftrag als
 * Rückfrage (Issue #366, Entscheidung E9).
 *
 * startCall({reason, conversation}) legt zuerst den Eintrag in der Anrufliste
 * an (ledger.ts), dann wählt der Anbieter. So kennt die Sprach-Brücke den
 * Anlass schon, bevor der Nutzer abnimmt. Danach holt follow das Protokoll
 * ab (alle POLL_MS, bis zur Frist WAIT_MS nach dem Wählen) und arbeitet die
 * Stände ab:
 *   - Zusammenfassung über summarize (call-summary.ts, Aux-Zweck
 *     "call-summary"), im Zielgespräch zugestellt, Protokoll und
 *     Zusammenfassung im Verlauf festgehalten
 *   - Auftragssuche über findTask; ein Auftrag wird nie sofort ausgeführt,
 *     sondern als Rückfrage der Art "call" angeboten
 *   - Leeres Protokoll (nicht angenommen), dauerhafter Anbieterfehler und
 *     Zeitablauf enden je mit einer eigenen Meldung
 * Zustellung der Zusammenfassung: notify meldet zugestellt, sicher abgelehnt
 * oder unklar (Werfen gilt als unklar). Zugestellt und unklar gelten als
 * erledigt (lieber keine als eine doppelte Zusammenfassung). Sicher abgelehnt
 * bleibt der Versand im Eintrag ausstehend (summarized, Versuche und nächster
 * Termin) und wird nach SEND_RETRY_MS wiederholt, auch nach einem Neustart;
 * nach MAX_SEND_ATTEMPTS Versuchen endet der Eintrag als gescheitert.
 * Der Verlauf bekommt das Protokoll dabei nur einmal.
 *
 * Ablage im Verlauf (record): als abgelegt gilt das Protokoll erst, wenn
 * record true meldet (gespeichert, oder es gibt keinen Verlauf: ohne
 * Datenbank, Web-Gespräch). false oder ein Fehler heißt: eingerichteter
 * Speicher gerade nicht erreichbar. Dann bleibt das Protokoll im Eintrag
 * (recordPending, ledger.ts), Zustellung und Rückfrage laufen weiter, und die
 * Ablage wird über einen Zeitgeber nachgeholt: erst nach RECORD_RETRY_MS,
 * dann jeweils doppelt so lange bis höchstens RECORD_RETRY_MAX_MS, ohne
 * Obergrenze an Versuchen, nach einem Neustart über resume(). Je Eintrag
 * läuft höchstens ein Versuch, nach dem Erfolg keiner mehr.
 *
 * receiveTranscript nimmt dasselbe Protokoll vom Webhook des Anbieters an
 * (Issue #351, src/app/server-routes.ts). Abfrage und Webhook enden im
 * selben bedingten Übergang von waiting nach received: wer zuerst kommt,
 * legt das Protokoll im Eintrag ab, jeder spätere findet es dort. Ab received
 * beenden weder Frist noch Anbieterfehler den Eintrag; ein Protokoll, das
 * rechtzeitig ankam, geht also nicht mehr verloren. Ist die Abholung schon
 * gescheitert (Frist, Anbieterfehler: failed mit lateTranscript, Meldung ist
 * raus), übernimmt ein später gelieferter Webhook das Protokoll trotzdem
 * (failed nach received, bedingt und einmalig), im Zielgespräch des Anrufs
 * und mit neuer Frist. Danach fasst
 * summarizeReceived zusammen (received nach summarized), je Kennung
 * höchstens ein Versuch zur Zeit, wer währenddessen kommt, wartet auf ihn.
 * summarize wirft, wenn das Modell nicht antwortet: der Webhook antwortet
 * dann mit einem Fehler (der Anbieter stellt erneut zu), die Bearbeitung
 * versucht es nach SEND_RETRY_MS erneut. Mit received beginnt eine neue
 * Frist (WAIT_MS); erst danach nimmt sie fallbackSummary statt des Modells.
 * Weil die Anrufliste dauerhaft ist, gilt das alles auch nach einem Neustart.
 *
 * Anrufe, die tybo nicht selbst gewählt hat (Kennung nicht in der
 * Anrufliste), legt receiveTranscript über inbound an, wie es das frühere
 * Gateway tat: Zusammenfassung im Direktchat, Verlauf, Rückfrage zum
 * Auftrag. Anlegen und Suche nach der Kennung laufen in einer Transaktion
 * (ledger.claim), doppelte Zustellung legt also keinen zweiten Eintrag an.
 *
 * resume() setzt beim Prozessstart alle offenen Einträge fort, ohne erneut
 * zu wählen. Ein Eintrag, der beim Neustart noch beim Wählen stand, endet als
 * gescheitert mit Hinweis, weil unklar ist, ob das Telefon klingelte. Ein
 * Eintrag beim Rückfragen (asking) wird mit dem Register abgeglichen: eine
 * offene Rückfrage zum Anruf (Art call, ref) wird übernommen, eine fehlende
 * angelegt, eine schon beendete schließt den Eintrag. So bleibt ein
 * sichtbarer Ja-Knopf wirksam, und es entsteht keine zweite Frage.
 *
 * handler beantwortet die Rückfrage: "run" führt den Auftrag über runTask im
 * Zielgespräch aus (im Bot ein vollständiger Chat-Turn, task-turn.ts), "skip"
 * nie. In einem reinen Web-Gespräch kündigt der Handler nichts an; dort meldet
 * runTask den Auftrag nur (Issue #367). Das Register entscheidet jede Rückfrage nur
 * einmal; zusätzlich schließt der Handler den Eintrag bedingt, bevor er
 * etwas tut, ein zweiter Aufruf findet ihn geschlossen und tut nichts.
 *
 * Ins Log kommen Kennung und Stand, nie Anlass, Protokoll oder Auftrag.
 */

import { randomBytes } from "crypto";
import { isClaudeUnavailable } from "../claude-availability";
import { listChoices, type Choice, type ChoiceConversation, type ChoiceHandler, type CreateChoiceInput } from "../choices";
import type { CallRecord, CallStage, PhoneLedger } from "./ledger";
import { transcriptText, type PhoneCaller, type TranscriptLine } from "./provider";

/** Abstand der Abfragen */
export const POLL_MS = 10_000;
/** So lange nach dem Wählen wird das Protokoll abgeholt */
export const WAIT_MS = 15 * 60_000;
/** Abstand bis zum nächsten Versuch nach einer sicher abgelehnten Zusammenfassung */
export const SEND_RETRY_MS = 60_000;
/** So viele Versuche bekommt die Zusammenfassung */
export const MAX_SEND_ATTEMPTS = 3;
/** Erster Abstand bis zum nächsten Versuch der Ablage im Verlauf */
export const RECORD_RETRY_MS = 60_000;
/** Längster Abstand zwischen zwei Versuchen der Ablage */
export const RECORD_RETRY_MAX_MS = 60 * 60_000;
/** So viel vom Anlass kommt in den ersten Satz */
const GREETING_REASON_CHARS = 120;

export const CALL_OPTION = {
  run: { key: "run", label: "Ja, erledigen" },
  skip: { key: "skip", label: "Nein" },
} as const;

export const PHONE_TEXT = {
  notConfigured: "Anrufe sind nicht eingerichtet.",
  calling: "Ich rufe an.",
  dialFailed: (error: string) => `Anruf hat nicht geklappt: ${error}`,
  noTracking: "Ich rufe an. Das Protokoll kann ich diesmal nicht abholen, der Anbieter nannte keine Kennung.",
  summary: (summary: string) => `📞 **Zusammenfassung des Anrufs**\n\n${summary}`,
  empty: "📞 Der Anruf ist beendet, es gibt kein Gesprächsprotokoll (nicht angenommen oder gleich aufgelegt).",
  timeout: "📞 Das Protokoll des Anrufs kam nicht rechtzeitig an, es gibt keine Zusammenfassung.",
  providerError: (error: string) => `📞 Das Protokoll des Anrufs ließ sich nicht abholen: ${error}`,
  unknownAfterRestart: "📞 Während ich anrief, wurde ich neu gestartet. Ob das Telefon geklingelt hat, weiß ich nicht; ich rufe nicht noch einmal an.",
  question: (task: string) => `📞 Aus dem Anruf: ${task}\n\nSoll ich das erledigen?`,
  starting: (task: string) => `Ich erledige jetzt: ${task}`,
  // Reines Web-Gespräch (Issue #367): dort startet tybo den Auftrag noch nicht selbst
  webTask: (task: string) => `📞 Den Auftrag aus dem Anruf kann ich in diesem Web-Gespräch noch nicht selbst starten. Schick ihn mir hier als Nachricht, dann erledige ich ihn:\n\n${task}`,
  skipped: "Gut, ich lasse es.",
} as const;

/** Ausgang einer Meldung: zugestellt, sicher nicht angekommen oder unklar */
export type DeliveryOutcome = "delivered" | "rejected" | "unclear";

export interface StartCallInput {
  /** Anlass, leer heißt allgemeines Melden */
  reason: string;
  /** Hier landen Zusammenfassung und Rückfrage */
  conversation: ChoiceConversation;
  userName?: string;
}

export interface StartCallResult {
  ok: boolean;
  message: string;
  ref?: string;
}

export interface PhoneServiceDeps {
  caller: PhoneCaller;
  ledger: PhoneLedger;
  /** Zusammenfassung; wirft, wenn keine zustande kommt (neuer Versuch später) */
  summarize(transcript: string): Promise<string>;
  /** Ersatz nach Fristablauf, wenn summarize weiter scheitert; Standard Anfang des Protokolls */
  fallbackSummary?(transcript: string): string;
  /** Ziel für Anrufe, die tybo nicht gewählt hat; null oder fehlend: solche Anrufe bleiben unbearbeitet */
  inbound?(): { conversation: ChoiceConversation; userName: string } | null;
  findTask(transcript: string, summary: string): Promise<string | null>;
  /** Meldung im Gespräch; Werfen gilt als unklar */
  notify(conversation: ChoiceConversation, text: string, format: "markdown" | "plain"): Promise<DeliveryOutcome>;
  /** Rückfrage anlegen und zustellen; wirft, wenn sie nicht angelegt ist */
  ask(input: CreateChoiceInput): Promise<Choice>;
  /** Auftrag im Gespräch ausführen (Motor, Antwort) */
  runTask(conversation: ChoiceConversation, task: string): Promise<void>;
  /** Rückfrage zum Anruf im Register (Art call, ref), offene zuerst; Standard listChoices */
  findChoice?(ref: string): Promise<Choice | undefined>;
  /**
   * Protokoll und Zusammenfassung im Verlauf. true: abgelegt oder kein
   * Verlauf vorgesehen; false oder Fehler: nicht abgelegt, wird nachgeholt
   */
  record?(call: CallRecord, transcript: string, summary: string): Promise<boolean>;
  /** Dynamische Variablen für den Sprachagenten (context.ts) */
  variables?(call: CallRecord): Promise<Record<string, string>>;
  agentName?(): string;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  pollMs?: number;
  waitMs?: number;
  retryMs?: number;
  /** Erster Abstand für die Ablage im Verlauf; Standard RECORD_RETRY_MS */
  recordRetryMs?: number;
  /** Zeitgeber für das Nachholen der Ablage; Standard setTimeout (unref) */
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  newRef?(): string;
  log?(line: string): void;
}

/**
 * Ausgang eines gelieferten Protokolls (Webhook): übernommen, schon
 * bearbeitet (doppelt zugestellt, Abfrage war schneller, Eintrag fertig) oder
 * nicht bearbeitet (fremder Anruf ohne Ziel bzw. ohne Inhalt)
 */
export type TranscriptDelivery = "accepted" | "known" | "unknown";

export interface PhoneService {
  startCall(input: StartCallInput): Promise<StartCallResult>;
  /**
   * Protokoll zur Kennung beim Anbieter, geliefert statt abgefragt (Webhook,
   * Issue #351). Wirft, wenn die Zusammenfassung scheitert; das Protokoll
   * bleibt dann im Eintrag und ein neuer Versuch ist möglich
   */
  receiveTranscript(conversationId: string, lines: TranscriptLine[]): Promise<TranscriptDelivery>;
  /** Offene Einträge fortsetzen und ausstehende Ablagen einplanen (Prozessstart) */
  resume(): void;
  handler: ChoiceHandler;
  /** Wartet, bis alle laufenden Abholungen dieses Prozesses fertig sind (Tests) */
  idle(): Promise<void>;
  /** Abholungen und geplante Ablagen dieses Prozesses anhalten, ohne den Stand zu ändern (Tests: Neustart) */
  stop(): void;
}

/** Erster Satz des Anrufs */
export function callGreetingFor(userName: string, agentName: string, reason: string): string {
  const topic = reason.replace(/\s+/g, " ").trim().slice(0, GREETING_REASON_CHARS);
  return topic
    ? `Hallo ${userName}, hier ist ${agentName}. Ich rufe an wegen: ${topic}. Passt es gerade?`
    : `Hallo ${userName}, hier ist ${agentName}. Ich melde mich kurz: Was beschäftigt dich gerade?`;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 120) : "Fehler";
}

/** So viel vom Protokoll ersetzt die Zusammenfassung, wenn keine zustande kommt */
const FALLBACK_SUMMARY_CHARS = 500;

export function createPhoneService(deps: PhoneServiceDeps): PhoneService {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const pollMs = deps.pollMs ?? POLL_MS;
  const waitMs = deps.waitMs ?? WAIT_MS;
  const retryMs = deps.retryMs ?? SEND_RETRY_MS;
  const recordRetryMs = deps.recordRetryMs ?? RECORD_RETRY_MS;
  const setTimer =
    deps.setTimer ??
    ((run: () => void, ms: number) => {
      const timer = setTimeout(run, ms);
      (timer as { unref?: () => void }).unref?.();
      return timer;
    });
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const log = deps.log ?? ((line: string) => console.log(line));
  const newRef = deps.newRef ?? (() => randomBytes(9).toString("base64url"));
  const fallbackSummary =
    deps.fallbackSummary ?? ((transcript: string) => `${transcript.slice(0, FALLBACK_SUMMARY_CHARS)}\n\n(Zusammenfassung nicht möglich)`);
  const agentName = deps.agentName ?? (() => "tybo");
  const findChoice =
    deps.findChoice ??
    (async (ref: string) => {
      const found = (await listChoices()).filter(c => c.kind === "call" && c.ref === ref);
      return found.find(c => c.state === "open") ?? found[0];
    });
  const { ledger } = deps;
  const running = new Map<string, Promise<void>>();
  /** Geplante bzw. laufende Ablagen im Verlauf je Kennung */
  const recordTimers = new Map<string, unknown>();
  const recording = new Set<string>();
  /** Laufende Zusammenfassung je Kennung (summarizeReceived) */
  const summarizing = new Map<string, Promise<boolean>>();
  let stopped = false;

  const advance = (ref: string, from: CallStage[], to: CallStage, patch?: Partial<CallRecord>, when?: (call: CallRecord) => boolean) =>
    ledger.advance(ref, from, to, patch, when);

  async function tell(call: CallRecord, text: string, format: "markdown" | "plain" = "plain"): Promise<DeliveryOutcome> {
    try {
      const outcome = await deps.notify(call.conversation, text, format);
      if (outcome !== "delivered") log(`[phone] ${call.ref}: ${outcome === "rejected" ? "Meldung nicht zugestellt" : "Zustellung der Meldung unklar"}`);
      return outcome;
    } catch (err) {
      log(`[phone] ${call.ref}: Zustellung der Meldung unklar (${errorName(err)})`);
      return "unclear";
    }
  }

  /** Nachholen der Ablage zum Termin des Eintrags einplanen, höchstens einmal je Kennung */
  function scheduleRecord(call: CallRecord): void {
    if (stopped || recordTimers.has(call.ref)) return;
    const wait = Math.max(0, (call.recordRetryAt ?? now()) - now());
    const handle = setTimer(() => {
      recordTimers.delete(call.ref);
      if (stopped) return;
      const current = ledger.get(call.ref);
      if (current?.recordPending) void storeRecord(current);
    }, wait);
    recordTimers.set(call.ref, handle);
  }

  /** Protokoll in den Verlauf; true: abgelegt (oder kein Verlauf vorgesehen), sonst ausstehend und eingeplant */
  async function storeRecord(call: CallRecord): Promise<boolean> {
    const { ref } = call;
    if (!deps.record || call.recorded) return true;
    if (recording.has(ref)) return false;
    recording.add(ref);
    try {
      let saved = false;
      try {
        saved = (await deps.record(call, call.transcript ?? "", call.summary ?? "")) === true;
      } catch (err) {
        log(`[phone] ${ref}: Ablage im Verlauf mit Fehler (${errorName(err)})`);
      }
      if (saved) {
        ledger.patch(ref, () => ({ recorded: true, recordPending: undefined, recordAttempts: undefined, recordRetryAt: undefined }));
        if (call.recordPending) log(`[phone] ${ref}: Protokoll im Verlauf nachgeholt`);
        return true;
      }
      const attempts = (call.recordAttempts ?? 0) + 1;
      const wait = Math.min(recordRetryMs * 2 ** Math.min(attempts - 1, 20), RECORD_RETRY_MAX_MS);
      const pending = ledger.patch(ref, current =>
        current.recorded ? null : { recordPending: true, recordAttempts: attempts, recordRetryAt: now() + wait },
      );
      log(`[phone] ${ref}: Protokoll nicht im Verlauf (Versuch ${attempts}), bleibt in der Anrufliste, neuer Versuch später`);
      if (pending) scheduleRecord(pending);
      return false;
    } finally {
      recording.delete(ref);
    }
  }

  /** Zusammenfassung zustellen; sicher abgelehnt bleibt sie ausstehend */
  async function report(call: CallRecord): Promise<boolean> {
    const { ref } = call;
    if (call.retryAt !== undefined && now() < call.retryAt) {
      await sleep(Math.min(call.retryAt - now(), pollMs));
      return !stopped;
    }
    const summary = call.summary ?? "";
    // Erster Versuch der Ablage; scheitert er, holt der Zeitgeber sie nach
    if (deps.record && !call.recorded && !call.recordPending) {
      await storeRecord(call);
      if (ledger.get(ref)?.stage !== "summarized") return true;
    }
    const reporting = advance(ref, ["summarized"], "reporting");
    if (!reporting) return true;
    const outcome = await tell(reporting, PHONE_TEXT.summary(summary), "markdown");
    if (outcome !== "rejected") {
      advance(ref, ["reporting"], "reported", { sendAttempts: undefined, retryAt: undefined, ...(outcome === "unclear" ? { note: "Zustellung unklar" } : {}) });
      return true;
    }
    const attempts = (reporting.sendAttempts ?? 0) + 1;
    if (attempts >= MAX_SEND_ATTEMPTS) {
      log(`[phone] ${ref}: Zusammenfassung nach ${attempts} Versuchen nicht zugestellt`);
      advance(ref, ["reporting"], "failed", { note: "Zusammenfassung nicht zugestellt", retryAt: undefined });
      return false;
    }
    log(`[phone] ${ref}: Zusammenfassung nicht zugestellt, neuer Versuch später`);
    advance(ref, ["reporting"], "summarized", { sendAttempts: attempts, retryAt: now() + retryMs });
    return true;
  }

  /** Rückfrage zum Auftrag: eine vorhandene zum Anruf übernehmen, sonst genau eine anlegen */
  async function offer(call: CallRecord): Promise<void> {
    const { ref } = call;
    const existing = await findChoice(ref);
    if (existing?.state === "open") {
      advance(ref, ["asking"], "asked", { choiceId: existing.id });
      return;
    }
    if (existing) {
      // Entschieden oder abgelaufen: nichts mehr offen, was ein Knopf auslösen könnte
      log(`[phone] ${ref}: Rückfrage ${existing.id} schon beendet`);
      advance(ref, ["asking"], "closed", { note: "Rückfrage beendet" });
      return;
    }
    if (!call.task) {
      advance(ref, ["asking"], "closed", { note: "kein Auftrag" });
      return;
    }
    try {
      const choice = await deps.ask({
        kind: "call",
        conversation: call.conversation,
        text: PHONE_TEXT.question(call.task),
        options: [CALL_OPTION.run, CALL_OPTION.skip].map(o => ({ key: o.key, label: o.label })),
        ref,
      });
      advance(ref, ["asking"], "asked", { choiceId: choice.id });
    } catch (err) {
      log(`[phone] ${ref}: Rückfrage nicht angelegt (${errorName(err)})`);
      advance(ref, ["asking"], "closed", { note: "Rückfrage nicht angelegt" });
    }
  }

  /** Protokoll abholen, bis es da ist oder die Frist abläuft */
  async function collect(ref: string): Promise<void> {
    while (!stopped) {
      const call = ledger.get(ref);
      if (!call || call.stage !== "waiting") return;
      if (now() >= call.deadline) {
        const failed = advance(ref, ["waiting"], "failed", { note: "Zeitablauf", lateTranscript: true });
        if (failed) await tell(failed, PHONE_TEXT.timeout);
        return;
      }
      const result = await deps.caller.transcript(call.conversationId ?? "");
      if (stopped) return;
      if (result.state === "pending") {
        await sleep(pollMs);
        continue;
      }
      if (result.state === "error") {
        const failed = advance(ref, ["waiting"], "failed", { note: result.error.slice(0, 200), lateTranscript: true });
        if (failed) await tell(failed, PHONE_TEXT.providerError(result.error));
        return;
      }
      await take(call, result.lines);
      return;
    }
  }

  /**
   * Fertiges Protokoll übernehmen, gleich ob abgefragt oder per Webhook
   * geliefert: leer schließt den Eintrag, sonst steht es danach im Eintrag
   * (received). Der Übergang ist bedingt, also gewinnt genau einer von
   * mehreren Lieferanten; true nur für ihn.
   */
  async function take(call: CallRecord, lines: TranscriptLine[]): Promise<boolean> {
    if (lines.length > 0) return receive(call, lines);
    const closed = advance(call.ref, ["waiting"], "closed", { note: "leeres Protokoll" });
    if (closed) await tell(closed, PHONE_TEXT.empty);
    return closed !== null;
  }

  /**
   * Nicht leeres Protokoll in den Eintrag (waiting nach received), ohne zu
   * warten. Auch nach gescheiterter Abholung (failed mit lateTranscript): ein
   * spät geliefertes Protokoll nimmt den Eintrag einmal wieder auf.
   */
  function receive(call: CallRecord, lines: TranscriptLine[]): boolean {
    const transcript = transcriptText(lines, { agent: agentName(), user: call.userName });
    // Neue Frist: so lange versucht es das Modell, danach Ersatztext
    const taken = advance(
      call.ref,
      ["waiting", "failed"],
      "received",
      { transcript, deadline: now() + waitMs, lateTranscript: undefined, note: undefined },
      current => current.stage === "waiting" || current.lateTranscript === true,
    );
    if (taken && call.stage === "failed") log(`[phone] ${call.ref}: Protokoll nach gescheiterter Abholung übernommen`);
    return taken !== null;
  }

  /**
   * Empfangenes Protokoll zusammenfassen (received nach summarized). Je
   * Kennung läuft höchstens ein Versuch, wer währenddessen kommt, bekommt
   * dessen Ausgang. Wirft, wenn summarize scheitert; der Eintrag bleibt dann
   * received. fallback: Ersatztext statt Modell (nach der Frist). Ist die
   * Zusammenfassung abgeschaltet (ClaudeUnavailableError, Issue #566), gilt
   * sofort der Anfang des Protokolls mit Grund, ohne Wiederholung.
   */
  function summarizeReceived(ref: string, fallback = false): Promise<boolean> {
    const active = summarizing.get(ref);
    if (active) return active;
    const job = (async () => {
      const call = ledger.get(ref);
      if (!call || call.stage !== "received") return false;
      const transcript = call.transcript ?? "";
      if (fallback) return advance(ref, ["received"], "summarized", { summary: fallbackSummary(transcript), note: "Zusammenfassung gescheitert" }) !== null;
      let summary: string;
      try {
        summary = await deps.summarize(transcript);
      } catch (err) {
        if (!isClaudeUnavailable(err)) throw err;
        // Abgeschaltet (Issue #566): kein neuer Versuch, der Nutzer bekommt den Anfang des Protokolls mit Grund
        log(`[phone] ${ref}: Zusammenfassung abgeschaltet (Claude fehlt), Anfang des Protokolls statt Zusammenfassung`);
        const disabled = `${transcript.slice(0, FALLBACK_SUMMARY_CHARS)}\n\n(${err.message})`;
        return advance(ref, ["received"], "summarized", { summary: disabled, note: "Zusammenfassung abgeschaltet" }) !== null;
      }
      return advance(ref, ["received"], "summarized", { summary }) !== null;
    })().finally(() => summarizing.delete(ref));
    summarizing.set(ref, job);
    return job;
  }

  /** Ein Schritt je Stand; false: nichts mehr zu tun */
  async function step(ref: string): Promise<boolean> {
    const call = ledger.get(ref);
    if (!call) return false;
    switch (call.stage) {
      case "dialing": {
        // Nur nach einem Neustart: der Prozess, der wählte, ist weg
        const failed = advance(ref, ["dialing"], "failed", { note: "Neustart während der Anwahl" });
        if (failed) await tell(failed, PHONE_TEXT.unknownAfterRestart);
        return false;
      }
      case "waiting":
        await collect(ref);
        return !stopped;
      case "received": {
        // Nach der Frist ohne Modell: Anfang des Protokolls statt gar keiner Zusammenfassung
        try {
          await summarizeReceived(ref, now() >= call.deadline);
        } catch (err) {
          log(`[phone] ${ref}: Zusammenfassung gescheitert (${errorName(err)}), neuer Versuch später`);
          if (!stopped) await sleep(Math.max(0, Math.min(retryMs, call.deadline - now())));
        }
        return !stopped;
      }
      case "summarized":
        return report(call);
      case "reporting":
        // Abbruch während der Zustellung: lieber keine als eine doppelte Zusammenfassung
        log(`[phone] ${ref}: Zustellung der Zusammenfassung vor dem Neustart unklar, nicht wiederholt`);
        advance(ref, ["reporting"], "reported", { note: "Zustellung unklar" });
        return true;
      case "reported": {
        const task = await deps.findTask(call.transcript ?? "", call.summary ?? "");
        if (stopped) return false;
        if (!task) {
          advance(ref, ["reported"], "closed");
          return false;
        }
        const asking = advance(ref, ["reported"], "asking", { task });
        if (!asking) return true;
        await offer(asking);
        return false;
      }
      case "asking":
        // Nach einem Neustart: Rückfrage im Register suchen, sonst nachholen
        await offer(call);
        return false;
      default:
        return false;
    }
  }

  function follow(ref: string): Promise<void> {
    const active = running.get(ref);
    if (active) return active;
    const job = (async () => {
      try {
        while (!stopped && (await step(ref)));
      } catch (err) {
        log(`[phone] ${ref}: Bearbeitung unterbrochen (${errorName(err)}), weiter beim nächsten Start`);
      } finally {
        running.delete(ref);
      }
    })();
    running.set(ref, job);
    return job;
  }

  return {
    async startCall(input) {
      if (deps.caller.missing().length > 0) return { ok: false, message: PHONE_TEXT.notConfigured };
      const ref = newRef();
      const created = now();
      const record: CallRecord = {
        ref,
        reason: input.reason.trim(),
        conversation: input.conversation,
        userName: input.userName?.trim() || "User",
        createdAt: created,
        deadline: created + waitMs,
        stage: "dialing",
        updatedAt: created,
      };
      try {
        ledger.add(record);
      } catch (err) {
        // Ohne Eintrag kein Anruf: weder Anlass für die Brücke noch Abholen
        log(`[phone] Anrufliste nicht beschreibbar (${errorName(err)})`);
        return { ok: false, message: PHONE_TEXT.dialFailed("Anrufliste nicht beschreibbar") };
      }
      const variables = deps.variables ? await deps.variables(record).catch(() => ({})) : {};
      const dialed = await deps.caller.dial({
        ref,
        greeting: callGreetingFor(record.userName, agentName(), record.reason),
        variables: { user_name: record.userName, call_reason: record.reason, ...variables },
      });
      if (!dialed.ok) {
        advance(ref, ["dialing"], "failed", { note: dialed.error.slice(0, 200) });
        log(`[phone] ${ref}: Anwahl gescheitert`);
        return { ok: false, message: PHONE_TEXT.dialFailed(dialed.error), ref };
      }
      if (!dialed.conversationId) {
        advance(ref, ["dialing"], "closed", { note: "keine Kennung beim Anbieter" });
        return { ok: true, message: PHONE_TEXT.noTracking, ref };
      }
      advance(ref, ["dialing"], "waiting", { conversationId: dialed.conversationId, deadline: now() + waitMs });
      log(`[phone] ${ref}: Anruf ausgelöst`);
      void follow(ref);
      return { ok: true, message: PHONE_TEXT.calling, ref };
    },

    async receiveTranscript(conversationId, lines) {
      if (!conversationId) return "unknown";
      let call = ledger.byConversationId(conversationId);
      let took = false;
      if (!call) {
        // Nicht von tybo gewählt: wie beim früheren Gateway in den Direktchat
        const target = lines.length > 0 ? (deps.inbound?.() ?? null) : null;
        if (!target) return "unknown";
        const created = now();
        const userName = target.userName.trim() || "User";
        const claimed = ledger.claim({
          ref: newRef(),
          reason: "",
          conversation: target.conversation,
          userName,
          createdAt: created,
          deadline: created + waitMs,
          stage: "received",
          updatedAt: created,
          conversationId,
          inbound: true,
          transcript: transcriptText(lines, { agent: agentName(), user: userName }),
        });
        call = claimed.call;
        took = claimed.created;
        if (took) log(`[phone] ${call.ref}: Anruf nicht von tybo, Protokoll per Webhook angelegt`);
      } else if (call.stage === "waiting" || (call.stage === "failed" && call.lateTranscript)) {
        // Leer nach gescheiterter Abholung: der Nutzer hat die Meldung schon, take ändert nichts
        if (lines.length === 0) return (await take(call, lines)) ? "accepted" : "known";
        // Ohne Warten bis zum Start der Zusammenfassung: eine parallele Zustellung findet sie laufend
        took = receive(call, lines);
      }
      const { ref } = call;
      if (ledger.get(ref)?.stage !== "received") return took ? "accepted" : "known";
      // Läuft schon ein Versuch (Abfrage, parallele Zustellung), zählt dessen Ausgang
      const joined = summarizing.has(ref);
      try {
        await summarizeReceived(ref);
      } finally {
        // Auch nach einem Fehler: die Bearbeitung versucht es selbst erneut
        if (!stopped) void follow(ref);
      }
      if (took || !joined) {
        log(`[phone] ${ref}: Protokoll per Webhook übernommen`);
        return "accepted";
      }
      return "known";
    },

    resume() {
      for (const call of ledger.open()) {
        if (call.stage === "asked" || running.has(call.ref)) continue;
        log(`[phone] ${call.ref}: fortgesetzt (${call.stage})`);
        void follow(call.ref);
      }
      for (const call of ledger.recordsPending()) scheduleRecord(call);
    },

    async handler(choice) {
      const ref = choice.ref ?? "";
      const run = choice.result?.key === CALL_OPTION.run.key;
      const closed = advance(ref, ["asking", "asked"], "closed", { note: run ? "Auftrag bestätigt" : "Auftrag abgelehnt" });
      if (!closed) {
        log(`[phone] ${ref || "?"}: Rückfrage ${choice.id} ohne offenen Anruf, nichts getan`);
        return;
      }
      if (!run || !closed.task) {
        await tell(closed, PHONE_TEXT.skipped);
        return;
      }
      // Im reinen Web-Gespräch meldet runTask nur (phoneDelivery), also keine Zusage
      if (closed.conversation.type !== "web") await tell(closed, PHONE_TEXT.starting(closed.task));
      await deps.runTask(closed.conversation, closed.task);
    },

    async idle() {
      while (running.size > 0) await Promise.all([...running.values()]);
    },

    stop() {
      stopped = true;
      for (const handle of recordTimers.values()) clearTimer(handle);
      recordTimers.clear();
    },
  };
}
