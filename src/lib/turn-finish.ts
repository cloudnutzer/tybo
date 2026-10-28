/**
 * Gemeinsamer Abschluss eines fertigen Turns. Telegram (Issue #339: Text in
 * src/channels/telegram/reply-turn.ts, Medien in
 * src/channels/telegram/media-inbox.ts) und die WebUI (Issue #340:
 * createBotChat und createTelegramChat in src/web/bot-turn.ts) enden hier.
 *
 * Der Abschluss hat drei Stufen, damit die WebUI sie verteilen kann:
 *  1. verbindlich (createTurnStages): Antwort einmal speichern, Merk-Tags
 *     durchs Tor, /goal des Gesprächs anstoßen, eigenen Text zeigen (mit
 *     [INVOKE:] ohne die Tags)
 *  2. consult: befragte Agenten nacheinander, höchstens invokeBudget
 *  3. settle: die Rückfrage (nur ohne [INVOKE:]), danach offene Fäden
 * Telegram führt alle drei direkt nacheinander aus (createTurnFinish). Die
 * WebUI ruft Stufe 1 im Turn auf, Stufe 2 in der Nacharbeit unter der
 * Gesprächssperre (TurnResult.followUp) und Stufe 3, wenn der ChatHub die
 * Antwort veröffentlicht hat (TurnResult.afterReply).
 *
 * Antworten der befragten Agenten speichert der Abschluss selbst, genau
 * einmal, damit die WebUI sie als ihre Nachricht zeigt (Issue #76). Ein
 * scheiterndes Anbieten der Rückfrage kostet weder die Antwort noch die Fäden.
 *
 * Die WebUI behält ihr bisheriges Verhalten über drei Schalter: zeigen vor
 * Merk-Tags und /goal (showBeforeIntents), keine Konsultationsantwort nach
 * gescheitertem Speichern (saveConsulted), keine Fäden nach gescheitertem
 * Anbieten der Rückfrage (skipThreadsAfterFailedOffer).
 *
 * Abbrüche erkennt der Kanal vorher: hier kommen nur Antworten an, die
 * gespeichert und gezeigt werden. Ohne grammY, Versand liefert der Kanal.
 */
import { ABORT_REPLY, type TurnQuestion } from "./chat-turn";
import { extractConsults, limitConsults, stripConsultTags, type ConsultRequest } from "./agent-consult";
import type { IntentTarget } from "./intent-gate";
import { sessionKeyFor } from "./store/message-rules";
import type { Message } from "./store/types";
import type { TurnTools } from "./turn-tools";

/**
 * Antwort eines befragten Agenten festhalten. Ohne metadata die Angaben des
 * Telegram-Kanals (agent, topicId, invokedBy); die WebUI gibt ihre eigenen
 * mit (msgId, channel, Modell), damit Browser und Speicher dieselbe ID haben.
 */
export type KeepConsulted = (targetAgent: string, text: string, metadata?: Record<string, unknown>) => Promise<void>;

/** Eine Konsultation ausführen; keep läuft, sobald die Antwort des befragten Agenten draußen ist */
export type ConsultRunner = (invocation: ConsultRequest, keep: KeepConsulted) => Promise<unknown>;

export interface TurnFinishDeps {
  saveMessage(message: Message): Promise<unknown>;
  processIntents(text: string, tools: TurnTools | undefined, target: IntentTarget): Promise<unknown>;
  /** /goal des Gesprächs auf diese Antwort prüfen, ohne zu warten */
  onGoalTurn(sessionKey: string, agent: string, reply: string): void;
  /**
   * Standard für consult() ohne eigenen Ausführer (Telegram:
   * consultViaAgentBots). Fehlt er, laufen Konsultationen nur mit dem
   * Ausführer, den der Kanal an consult() übergibt.
   */
  invoke?(
    fromAgent: string,
    invocation: ConsultRequest,
    chatId: string,
    topicId: number | undefined,
    delivered: KeepConsulted,
  ): Promise<unknown>;
  /** Höchstens so viele Konsultationen je Antwort; 0 heißt keine */
  invokeBudget: number;
  noteThreads(chatId: string, topicId: number | undefined, userText: string, reply: string, turnStartedAt: number): void;
  /**
   * WebUI: erst zeigen, dann Merk-Tags und /goal (bisherige Reihenfolge von
   * createTelegramChat). Ohne: Merk-Tags und /goal vor dem Zeigen (Telegram)
   */
  showBeforeIntents?: boolean;
  /**
   * WebUI: Antwort eines befragten Agenten hiermit speichern; ein Fehler
   * erreicht den Ausführer, der die Antwort dann nicht zeigt. Ohne:
   * saveMessage, ein Fehler wird nur geloggt (Telegram)
   */
  saveConsulted?(message: Message): Promise<unknown>;
  /** WebUI: nach gescheitertem Anbieten der Rückfrage keine Fäden. Ohne: Fäden trotzdem (Telegram) */
  skipThreadsAfterFailedOffer?: boolean;
  logError?(message: string, error: unknown): void;
}

export interface FinishedTurn {
  chatId: string;
  topicId?: number;
  agentName: string;
  /** Endgültige Antwort, so wie sie gespeichert wird (Medien: schon nachbereitet) */
  reply: string;
  /** Metadaten der gespeicherten Antwort */
  metadata: Record<string, unknown>;
  tools?: TurnTools;
  /** Herkunft für Merk-Tor und Log; Standard "Telegram" */
  origin?: string;
  /** Fremder Inhalt ohne Werkzeug (Foto, Datei, Video), für das Merk-Tor */
  foreignInput?: string;
  /** Turn ohne Telegram (Issue #259): ein Merk-Vorschlag erscheint nur in diesem WebUI-Gespräch */
  noTelegram?: { conversationId: string };
  /** Vom Chat-Kern gemeldete Rückfrage (onQuestion) */
  question?: TurnQuestion;
  /** Offene Fäden erkennen; fehlt bei Befehlen */
  threads?: { userText: string; startedAt: number };
  /** Text im Gespräch des Turns zeigen (Kanal entscheidet über Absender und Ziel) */
  send(text: string): Promise<unknown>;
}

/** Was nach Stufe 1 noch zu tun ist */
export interface TurnStages {
  /** Befragte Agenten, schon auf invokeBudget gekürzt; leer ohne [INVOKE:] */
  consultations: ConsultRequest[];
  /** Stufe 2: Konsultationen nacheinander, mit run statt deps.invoke, wenn angegeben */
  consult(run?: ConsultRunner): Promise<void>;
  /** true, wenn settle etwas zu tun hat (Rückfrage oder Fäden) */
  settles: boolean;
  /**
   * Stufe 3: erst die Rückfrage, dann die Fäden. Wirft nie wegen der
   * Rückfrage; ein Fehler der Fäden-Erkennung kommt ohne Rückfrage sofort
   * (synchron), sonst als abgelehntes Promise
   */
  settle(): Promise<void>;
}

/** Stufe 1 eines Turns ausführen; liefert die übrigen Stufen */
export function createTurnStages(deps: TurnFinishDeps): (turn: FinishedTurn) => Promise<TurnStages> {
  const logError = deps.logError ?? ((message, error) => console.error(message, error));

  return async turn => {
    const { chatId, topicId, agentName, reply } = turn;
    await deps.saveMessage({ chat_id: chatId, role: "assistant", content: reply, metadata: turn.metadata });

    const target: IntentTarget = { chatId, topicId, origin: turn.origin ?? "Telegram" };
    if (turn.foreignInput) target.foreignInput = turn.foreignInput;
    if (turn.noTelegram) target.noTelegram = turn.noTelegram;
    const intents = async () => {
      await deps.processIntents(reply, turn.tools, target);
      deps.onGoalTurn(sessionKeyFor(chatId, topicId ?? null), agentName, reply);
    };

    const asked = extractConsults(reply);
    if (!deps.showBeforeIntents) await intents();
    if (asked.length > 0) {
      const own = stripConsultTags(reply);
      if (own) await turn.send(own);
    } else {
      await turn.send(reply);
    }
    if (deps.showBeforeIntents) await intents();
    const consultations = asked.length > 0 && deps.invokeBudget > 0 ? limitConsults(asked, deps.invokeBudget) : [];
    // Mit [INVOKE:] keine Rückfrage: erst antworten die befragten Agenten
    const question = asked.length > 0 ? undefined : turn.question;

    const keep: KeepConsulted = async (targetAgent, text, metadata) => {
      if (!text.trim() || text === ABORT_REPLY) return;
      const message: Message = {
        chat_id: chatId,
        role: "assistant",
        content: text,
        metadata: metadata ?? { agent: targetAgent, topicId, invokedBy: agentName },
      };
      // WebUI: ein Fehler geht an den Ausführer, die Antwort erscheint dann nicht
      if (deps.saveConsulted) {
        await deps.saveConsulted(message);
        return;
      }
      await Promise.resolve()
        .then(() => deps.saveMessage(message))
        .catch(error => logError("[Konsultation] Antwort nicht gespeichert:", error));
    };

    return {
      consultations,
      async consult(run) {
        const runner: ConsultRunner | undefined =
          run ?? (deps.invoke ? (invocation, done) => deps.invoke!(agentName, invocation, chatId, topicId, done) : undefined);
        if (!runner) return;
        for (const invocation of consultations) await runner(invocation, keep);
      },
      settles: !!question || !!turn.threads,
      settle() {
        const note = () => {
          if (turn.threads) deps.noteThreads(chatId, topicId, turn.threads.userText, reply, turn.threads.startedAt);
        };
        // Ohne Rückfrage sofort: ein Fehler der Fäden-Erkennung kommt dann direkt beim Aufrufer an
        if (!question) {
          note();
          return Promise.resolve();
        }
        // Vor den Fäden: die sehen die offene Rückfrage und legen keinen eigenen an
        return question.offer().then(note, error => {
          logError("[Rückfrage] nicht angeboten:", error);
          if (!deps.skipThreadsAfterFailedOffer) note();
        });
      },
    };
  };
}

/** Alle Stufen direkt nacheinander, wie Telegram einen Turn abschließt */
export function createTurnFinish(deps: TurnFinishDeps): (turn: FinishedTurn) => Promise<void> {
  const commit = createTurnStages(deps);
  return async turn => {
    const stages = await commit(turn);
    await stages.consult();
    await stages.settle();
  };
}
