/**
 * Gesprächs-Turn des Telefonhörers (Issue #255): eine Äußerung an das Modell,
 * die Antwort als sprechbare Abschnitte, sobald sie fertig sind.
 *
 * Ereignisse, in dieser Reihenfolge:
 * - beliebig viele { type: "segment", text } (Tags schon entfernt)
 * - genau ein Abschluss: { type: "done", rawText, spokenText, aborted } oder
 *   { type: "error", reason, ... }. Nach dem Abschluss kommt nichts mehr.
 *
 * Ein Abbruch endet sofort mit aborted: true, ohne weiteren Abschnitt, gleich
 * woher er kommt: signal des Aufrufers, backend.interrupt(), /stop oder
 * close() (#256; die beiden letzten enden als error mit reason "ended").
 * Alle Wege setzen dasselbe Turn-Signal (BrainCall.abort). Schon gelieferte
 * Abschnitte bleiben gültig, ein angefangener Satz wird verworfen. Fehler
 * des Modells werden zum error-Ereignis, nie zu einer Ausnahme im Strom.
 * Den Satz für den Nutzer („Entschuldige, …") wählt der Aufrufer.
 *
 * Werkzeuge (Issue #259, ./tools.ts), nur mit tools:
 * - { type: "tool", name, phase: "start" }, sobald ein Werkzeug-Tag beginnt,
 *   das ausgeführt wird (der Aufrufer spricht dann einen festen Satz).
 * - [SUCHE:] und [RECHNE:]: Die Runde endet mit der "]" (der Rest dieser
 *   Runde wird verworfen, auch Merk-Tags darin), das Ergebnis geht als
 *   gekennzeichnete Nutzer-Nachricht in die nächste Runde. Höchstens
 *   MAX_TOOL_ROUNDS Werkzeug-Runden; ein Tag danach wird weder gesprochen
 *   noch ausgeführt. Suche länger als 8 s oder mit Fehler: der Abschnitt
 *   „Dazu finde ich gerade nichts.“, keine weitere Runde; ein spätes
 *   Ergebnis bewirkt nichts mehr.
 * - [DENKAUFTRAG:]: { type: "tool", name: "denkauftrag", phase: "call", task };
 *   den Auftrag startet der Aufrufer. Danach endet der Turn.
 * - Sagt der Nutzer selbst „Denkauftrag“ (classifyTurn), gibt es keinen
 *   Modellabruf: gleich start und call mit seiner Äußerung als Aufgabe.
 * - rawText enthält nur Behaltenes: Text vor und mit den Tags, nie den
 *   verworfenen Rest einer Runde.
 * - done trägt bei Werkzeug-Runden toolMessages: die Nachrichten zwischen
 *   Äußerung und letzter Antwort (Tag des Modells, gekennzeichnetes
 *   Ergebnis), damit Folgeturns über die API das Ergebnis im Verlauf sehen.
 */

import { classifyTurn } from "./plan";
import { SentenceStream } from "./sentences";
import { calcResultMessage, MAX_TOOL_ROUNDS, SEARCH_TIMEOUT_MS, searchResultMessage, TOOL_TAG_NAMES, TOOL_TEXT, ToolTagScanner, type ToolScanEvent, type VoiceToolName } from "./tools";
import { BrainError, type BrainBackend, type BrainErrorReason, type BrainMessage } from "./types";

export type VoiceTurnEvent =
  | { type: "segment"; text: string }
  | { type: "tool"; name: VoiceToolName; phase: "start" }
  | { type: "tool"; name: "denkauftrag"; phase: "call"; task: string }
  | { type: "done"; rawText: string; spokenText: string; aborted: boolean; toolMessages?: BrainMessage[] }
  | { type: "error"; reason: BrainErrorReason; message: string; rawText: string; spokenText: string };

/** Werkzeuge des Turns (Issue #259); ohne tools gibt es keine Werkzeug-Tags */
export interface VoiceTurnTools {
  /** Suche im eigenen Verlauf (history_search); fehlt sie, wird [SUCHE:] nicht ausgeführt */
  search?(query: string, signal: AbortSignal): Promise<string>;
  /** Denkauftrag möglich: den Auftrag startet der Aufrufer beim Ereignis call */
  deepTask?: boolean;
  /** Zeitlimit der Suche, Standard SEARCH_TIMEOUT_MS */
  searchTimeoutMs?: number;
  /** Höchstens so viele Werkzeug-Runden, Standard MAX_TOOL_ROUNDS */
  maxRounds?: number;
}

export interface VoiceTurnOptions {
  backend: BrainBackend;
  /** Kontext, Agent-Prompt und Sprechstil (voiceStyle mit channel "call") */
  system: string;
  history: BrainMessage[];
  userText: string;
  /**
   * Block vor der Äußerung, nur für das Modell (Issue #259: Ergebnis eines
   * Denkauftrags); zählt nicht für die Erkennung eines ausdrücklichen Denkauftrags
   */
  context?: string;
  signal?: AbortSignal;
  /** Erster Abschnitt schon am Komma (Standard an), damit die Stimme früher beginnt */
  earlyFirst?: boolean;
  tools?: VoiceTurnTools;
}

type SearchOutcome = { ok: true; text: string } | { ok: false };

export async function* runVoiceTurn({ backend, system, history, userText, context, signal, earlyFirst = true, tools }: VoiceTurnOptions): AsyncGenerator<VoiceTurnEvent> {
  const sentences = new SentenceStream({ earlyFirst, ...(tools ? { extraTags: TOOL_TAG_NAMES } : {}) });
  const spoken: string[] = [];
  let rawText = "";
  /** Nachrichten der Werkzeug-Runden (ab dem Ende des Verlaufs plus Äußerung) */
  let toolMessages: BrainMessage[] = [];
  const done = (aborted: boolean): VoiceTurnEvent => ({
    type: "done",
    rawText,
    spokenText: spoken.join(" "),
    aborted,
    ...(toolMessages.length && !aborted ? { toolMessages } : {}),
  });

  if (signal?.aborted) {
    yield done(true);
    return;
  }

  // Ein Zustand für den ganzen Turn: Abbruch über signal des Aufrufers oder am
  // Weg (interrupt(), /stop, close() über call.abort()). Jede Ausgabestelle
  // prüft nur diesen einen Zustand.
  const turn = new AbortController();
  const onOuterAbort = () => turn.abort(signal?.reason);
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  const abortWait = new Promise<"abort">((resolve) => turn.signal.addEventListener("abort", () => resolve("abort"), { once: true }));
  const stopped = () => turn.signal.aborted;
  /** Abschluss nach Abbruch: ein BrainError als Grund (etwa "ended" nach /stop) wird zum Fehler */
  const stoppedOutcome = (): VoiceTurnEvent => {
    const reason = turn.signal.reason;
    if (reason instanceof BrainError) return { type: "error", reason: reason.reason, message: reason.message, rawText, spokenText: spoken.join(" ") };
    return done(true);
  };

  // Ausdrücklicher Denkauftrag des Nutzers: ohne Umweg über das Modell
  if (tools?.deepTask && classifyTurn(userText, "low").deep) {
    signal?.removeEventListener("abort", onOuterAbort);
    yield { type: "tool", name: "denkauftrag", phase: "start" };
    if (stopped()) {
      yield stoppedOutcome();
      return;
    }
    yield { type: "tool", name: "denkauftrag", phase: "call", task: userText };
    yield stopped() ? stoppedOutcome() : done(false);
    return;
  }

  const maxRounds = tools?.maxRounds ?? MAX_TOOL_ROUNDS;
  const messages: BrainMessage[] = [...history, { role: "user", content: context ? `${context}\n\n${userText}` : userText }];
  let toolRounds = 0;
  const runs = (name: VoiceToolName): boolean => {
    if (!tools || toolRounds >= maxRounds) return false;
    if (name === "suche") return !!tools.search;
    if (name === "denkauftrag") return !!tools.deepTask;
    return true;
  };

  /** Ein Abruf beim Weg; return() beendet ihn (CLI: Unterbrechen), ohne den Turn abzubrechen */
  let round: { iterator: AsyncIterator<{ text: string }>; closing: boolean; closed: boolean } | null = null;
  const closeRound = async (interrupted: boolean) => {
    const r = round;
    if (!r || r.closed) return;
    r.closed = true;
    // Der Weg sieht den Abbruch am Signal des Turns und unterbricht selbst
    if (interrupted && !turn.signal.aborted) turn.abort();
    // Nur während return(): das Unterbrechen, das der Weg dabei meldet, beendet die Runde, nicht den Turn
    r.closing = !interrupted;
    // Beendet den Abruf des Wegs (Verbindung zu, Budget abgerechnet), bevor es weitergeht
    try {
      await r.iterator.return?.()?.catch(() => {});
    } finally {
      r.closing = false;
    }
  };
  const openRound = () => {
    const roundCtrl = new AbortController();
    const onTurnAbort = () => roundCtrl.abort(turn.signal.reason);
    turn.signal.addEventListener("abort", onTurnAbort, { once: true });
    const r = {
      closing: false,
      closed: false,
      iterator: backend
        .stream({
          system,
          messages: messages.slice(),
          signal: roundCtrl.signal,
          // Beendet der Turn die Runde selbst (Werkzeug-Tag), meldet der Weg das Unterbrechen hier: nur die Runde endet
          abort: (reason) => (r.closing ? roundCtrl.abort(reason) : turn.abort(reason)),
        })
        [Symbol.asyncIterator](),
    };
    round = r;
    return r;
  };

  /** Ergebnis der Suche mit Zeitlimit; ein spätes Ergebnis bewirkt nichts mehr */
  const search = async (query: string): Promise<SearchOutcome | "abort"> => {
    const ctrl = new AbortController();
    const onTurnAbort = () => ctrl.abort();
    turn.signal.addEventListener("abort", onTurnAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<SearchOutcome>((resolve) => {
      timer = setTimeout(() => {
        ctrl.abort();
        resolve({ ok: false });
      }, tools?.searchTimeoutMs ?? SEARCH_TIMEOUT_MS);
    });
    const running = tools!.search!(query, ctrl.signal).then(
      (text): SearchOutcome => ({ ok: true, text }),
      (): SearchOutcome => ({ ok: false }),
    );
    try {
      const r = await Promise.race([running, timeout, abortWait]);
      return r === "abort" ? "abort" : r;
    } finally {
      clearTimeout(timer);
      turn.signal.removeEventListener("abort", onTurnAbort);
    }
  };

  let outcome: VoiceTurnEvent | null = null;
  try {
    rounds: while (!stopped()) {
      const r = openRound();
      const scanner = tools ? new ToolTagScanner() : null;
      // rawText wächst mit dem Strom (auch ein Abbruch zeigt den Stand); verworfen wird nur, was nie hinzukam
      const roundStart = rawText.length;
      let pending: Extract<ToolScanEvent, { type: "tag" }> | null = null;
      let finished = false;

      /** Ereignisse des Scanners verarbeiten; liefert Abschnitte und Werkzeug-Beginn */
      const handle = function* (events: ToolScanEvent[]): Generator<VoiceTurnEvent> {
        for (const ev of events) {
          if (pending || stopped()) return;
          if (ev.type === "text") {
            rawText += ev.text;
            for (const text of sentences.push(ev.text)) {
              if (stopped()) return;
              spoken.push(text);
              yield { type: "segment", text };
            }
          } else if (ev.type === "start") {
            if (!runs(ev.name)) continue;
            // Angefangener Satz vor dem Tag zuerst, dann der feste Satz des Aufrufers
            for (const text of sentences.flush()) {
              if (stopped()) return;
              spoken.push(text);
              yield { type: "segment", text };
            }
            yield { type: "tool", name: ev.name, phase: "start" };
          } else if (ev.type === "tag") {
            rawText += ev.raw;
            if (runs(ev.name)) pending = ev;
          }
          // "incomplete": nie gesprochen, nie ausgeführt
        }
      };

      while (!finished && !stopped() && !pending) {
        const next = r.iterator.next();
        // Verliert next() das Rennen gegen den Abbruch, darf seine spätere Ablehnung nicht unbehandelt bleiben
        next.catch(() => {});
        const step = await Promise.race([next, abortWait]);
        if (step === "abort" || stopped()) break;
        if (step.done) {
          finished = true;
          break;
        }
        if (!scanner) {
          rawText += step.value.text;
          for (const text of sentences.push(step.value.text)) {
            // Vor jedem Abschnitt, auch aus demselben Textstück: abgebrochen heißt nichts mehr
            if (stopped()) break;
            spoken.push(text);
            yield { type: "segment", text };
          }
        } else yield* handle(scanner.push(step.value.text));
      }
      if (stopped()) break;
      if (!pending && scanner) yield* handle(scanner.flush());
      // Werkzeug-Tag vollständig: der Rest dieser Runde wird verworfen
      await closeRound(false);
      if (stopped()) break;
      if (!pending) break;

      const tag: Extract<ToolScanEvent, { type: "tag" }> = pending;
      toolRounds++;
      if (tag.name === "denkauftrag") {
        yield { type: "tool", name: "denkauftrag", phase: "call", task: tag.arg };
        break;
      }
      let result: string;
      if (tag.name === "rechne") result = calcResultMessage(tag.arg);
      else {
        const found = await search(tag.arg);
        if (found === "abort" || stopped()) break;
        if (!found.ok) {
          for (const text of [...sentences.flush(), TOOL_TEXT.searchNothing]) {
            if (stopped()) break rounds;
            spoken.push(text);
            yield { type: "segment", text };
          }
          break;
        }
        result = searchResultMessage(found.text);
      }
      messages.push({ role: "assistant", content: rawText.slice(roundStart) });
      messages.push({ role: "user", content: toolRounds >= maxRounds ? `${result}\n\n${TOOL_TEXT.lastRound}` : result });
      toolMessages = messages.slice(history.length + 1);
    }
    if (stopped()) {
      await closeRound(true);
      outcome = stoppedOutcome();
    } else {
      // Rest nach dem Strom: noch Abschnitte, dann der Abschluss
      const rest = sentences.flush();
      for (const text of rest) {
        if (stopped()) break;
        spoken.push(text);
        yield { type: "segment", text };
      }
      // Der Verbraucher kann auch beim letzten Restabschnitt abgebrochen haben
      outcome = stopped() ? stoppedOutcome() : done(false);
    }
  } catch (err) {
    // Abbruch des Turns, auch direkt am Weg (AbortError ohne Signal des Aufrufers)
    const wasAborted = stopped() || (err instanceof Error && err.name === "AbortError");
    await closeRound(wasAborted);
    if (stopped()) outcome = stoppedOutcome();
    else if (wasAborted) outcome = done(true);
    else {
      const reason: BrainErrorReason = err instanceof BrainError ? err.reason : "network";
      const message = err instanceof Error ? err.message : String(err);
      outcome = { type: "error", reason, message, rawText, spokenText: spoken.join(" ") };
    }
  } finally {
    // Verbraucher hört vorzeitig auf (break im for await): Abruf trotzdem beenden
    await closeRound(true);
    // Erst jetzt: ein Abbruch beim letzten Restabschnitt zählt noch
    signal?.removeEventListener("abort", onOuterAbort);
  }
  yield outcome;
}
