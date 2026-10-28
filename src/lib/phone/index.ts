/**
 * Telefonanrufe (Issue #366, Entscheidung E9): Einstieg für den Bot.
 *
 * createPhone verbindet den Dienst (service.ts) mit dem echten Anbieter
 * (ElevenLabs und Twilio), der Anrufliste unter GO_PROJECT_ROOT, der
 * Zusammenfassung über callAux (call-summary.ts; ein Modellfehler wirft,
 * damit der Dienst es erneut versucht), dem Verlauf und den Variablen für
 * den Sprachagenten. Anrufe, die tybo nicht gewählt hat, landen im
 * Direktchat (proactiveConversation), mit USER_NAME im Protokoll. Zustellung, Rückfrage und Motor kommen
 * vom Bot, weil nur er Telegram und Motor hat; ein bestätigter Auftrag läuft
 * als vollständiger Chat-Turn ohne Telegram-Context (task-turn.ts), Verlauf,
 * Merk-Tags und Aufträge über Speicher und Merk-Tag-Tor.
 */

import { createChoice, type Choice, type ChoiceConversation } from "../choices";
import type { SendAndRecordInput, SendAndRecordResult } from "../outbox";
import { classifyReminderResult, threadTarget } from "../thread-choices";
import { proactiveConversation, type CallResult } from "../proactive/choices";
import { extractTaskFromTranscript, summarizeTranscriptStrict, summaryFallback } from "../call-summary";
import { processTurnIntents } from "../intent-gate";
import { memoryContext } from "../memory/context";
import { storeOr } from "../store";
import type { Message } from "../store/types";
import { voiceAgentName } from "../voice-agent-name";
import { callVariables } from "./context";
import { createPhoneLedger, phoneLedgerPath } from "./ledger";
import { createElevenLabsCaller } from "./provider";
import { createPhoneService, PHONE_TEXT, type PhoneService, type PhoneServiceDeps } from "./service";
import { createCallTaskTurn, type CallTaskTurnDeps } from "./task-turn";
import { chatConversation } from "./conversation";

export { createPhoneService, callGreetingFor, CALL_OPTION, PHONE_TEXT, RECORD_RETRY_MS, RECORD_RETRY_MAX_MS, type PhoneService, type StartCallResult, type TranscriptDelivery } from "./service";
export { createCallTaskTurn, CALL_TASK_AGENT, CALL_TASK_TEXT, type CallTaskTurnDeps } from "./task-turn";
export { createPhoneLedger, phoneLedgerPath, type CallRecord } from "./ledger";
export { createElevenLabsCaller, linesFromTurns, phoneConfigured, type PhoneCaller, type TranscriptLine } from "./provider";
export { chatConversation } from "./conversation";
export { phoneAccess, type PhoneAccess } from "./access";
export { callIdsFrom, callNote } from "./bridge-note";

/** Absender von Zusammenfassung, Meldungen und Rückfrage im Verlauf, wie CHOICE_SOURCES.call */
export const PHONE_SOURCE = "anruf";

/** chat_id im Verlauf für ein Gespräch: Telegram-Chat bzw. Web-Direktchat */
function historyChat(conversation: ChoiceConversation): { chatId: string; topicId?: number } | null {
  if (conversation.type !== "telegram") return null;
  return conversation.topicId !== undefined ? { chatId: conversation.chatId, topicId: conversation.topicId } : { chatId: conversation.chatId };
}

/** Anrufweg für den Knopf „Anrufen“ unter proaktiven Meldungen (#362): Text der Meldung als Anlass, Ergebnis in den Direktchat */
export function proactiveCall(phone: Pick<PhoneService, "startCall">, env: Record<string, string | undefined> = process.env): (reason: string) => Promise<CallResult> {
  return async reason => {
    const result = await phone.startCall({ reason, conversation: proactiveConversation(env) });
    return { success: result.ok, message: result.message };
  };
}

/**
 * Ablage von Protokoll und Zusammenfassung im Verlauf (record im Dienst):
 * true nur, wenn save die Speicherung bestätigt oder kein Verlauf vorgesehen
 * ist (Web-Gespräch); ein false von save kommt als false zurück, ein Fehler
 * als Fehler. Beides holt der Dienst nach.
 */
export function historyRecorder(save: (message: Message) => Promise<boolean>): NonNullable<PhoneServiceDeps["record"]> {
  return async (call, transcript, summary) => {
    const target = historyChat(call.conversation);
    if (!target) return true;
    // Kopfzeilen wie bisher im Verlauf: Protokoll, Leerzeile, Zusammenfassung
    const content = ["[Phone call transcript]", transcript, "", "[Summary]", summary].join("\n");
    const saved = await save({
      chat_id: target.chatId, role: "assistant", content,
      metadata: {
        type: "call_transcript",
        conversationId: call.conversationId ?? "",
        callRef: call.ref,
        ...(target.topicId !== undefined ? { topicId: target.topicId } : {}),
      },
    });
    return saved === true;
  };
}

export interface PhoneBotDeps {
  /** Outbox (Telegram und WebUI) */
  send(input: SendAndRecordInput): Promise<SendAndRecordResult>;
  /** Rückfrage zustellen (telegram-choices sendChoice); ohne Telegram hält sie sie für die WebUI fest */
  sendChoice(choice: Choice): Promise<{ sent: boolean; error?: string }>;
  /** Motor, Agenten-Bots und /goal für den Auftrag; Verlauf, Merk-Tags, Aufträge und Meldungen ergänzt createPhone */
  task: Omit<CallTaskTurnDeps, "saveMessage" | "processIntents" | "createTask" | "updateTask" | "notice">;
  env?: Record<string, string | undefined>;
  log?(line: string): void;
  /** Warten zwischen zwei Versuchen; Standard setTimeout (Tests) */
  sleep?(ms: number): Promise<void>;
}

export interface PhoneDeliveryDeps extends Pick<PhoneBotDeps, "send" | "sendChoice"> {
  /** Auftrag im Chat (samt Topic) ausführen und die Antwort dort zeigen */
  runTask(chatId: string, task: string, topicId?: number): Promise<void>;
}

/** Zustellung, Rückfrage und Ausführen über die Wege des Bots */
export function phoneDelivery(deps: PhoneDeliveryDeps, log: (line: string) => void): Pick<PhoneServiceDeps, "notify" | "ask" | "runTask"> {
  return {
    // Ausgang wie bei Erinnerungen an Fäden: sicher abgelehnt nur bei abgelehnter Eingabe oder 4xx von Telegram
    notify: async (conversation, text, format) =>
      classifyReminderResult(await deps.send({ ...threadTarget(conversation), text, source: PHONE_SOURCE, format })),
    ask: async input => {
      const choice = await createChoice(input);
      // Nicht zugestellt: die Rückfrage steht trotzdem im Register und in der WebUI
      const sent = await deps.sendChoice(choice).catch(err => ({ sent: false, error: err instanceof Error ? err.name : "Fehler" }));
      if (!sent.sent) log(`[phone] Rückfrage ${choice.id} nicht zugestellt (${sent.error ?? "unbekannt"})`);
      return choice;
    },
    runTask: async (conversation, task) => {
      if (conversation.type === "telegram") {
        await deps.runTask(conversation.chatId, task, conversation.topicId);
        return;
      }
      // Reines Web-Gespräch (Issue #367): ein Turn bräuchte einen Weg aus src/bot.ts,
      // deshalb nur eine Meldung mit dem Auftrag, ihn als Nachricht zu schicken
      const outcome = classifyReminderResult(await deps.send({ ...threadTarget(conversation), text: PHONE_TEXT.webTask(task), source: PHONE_SOURCE, format: "plain" }));
      if (outcome !== "delivered") log(`[phone] Hinweis zum Auftrag im Web-Gespräch ${outcome === "rejected" ? "nicht zugestellt" : "unklar"}`);
    },
  };
}

export function createPhone(deps: PhoneBotDeps): PhoneService {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.log(line));
  const runTask = createCallTaskTurn({
    ...deps.task,
    saveMessage: message => storeOr(false, store => store.messages.save(message)),
    // Durch das Merk-Tag-Tor wie jede Antwort (Issue #53)
    processIntents: (response, tools, target) => processTurnIntents(response, tools, target),
    createTask: (chatId, prompt, topicId) => storeOr(null, store => store.tasks.create(chatId, prompt, topicId, "mac")),
    updateTask: (taskId, changes) => storeOr(false, store => store.tasks.update(taskId, changes)),
    notice: (chatId, text, topicId) => deps.send({ ...threadTarget(chatConversation(chatId, topicId)), text, source: PHONE_SOURCE, format: "plain" }),
    log,
  });
  return createPhoneService({
    caller: createElevenLabsCaller({ env }),
    ledger: createPhoneLedger(phoneLedgerPath(env.GO_PROJECT_ROOT || process.cwd())),
    summarize: summarizeTranscriptStrict,
    fallbackSummary: summaryFallback,
    inbound: () => ({ conversation: proactiveConversation(env), userName: env.USER_NAME?.trim() || "User" }),
    findTask: extractTaskFromTranscript,
    ...phoneDelivery({ send: deps.send, sendChoice: deps.sendChoice, runTask }, log),
    log,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    agentName: () => voiceAgentName(),
    variables: call =>
      callVariables(call, {
        memory: () => storeOr("", store => memoryContext(store.memory)),
        recent: (chatId, limit) => storeOr([], store => store.messages.recent(chatId, limit)),
        timeZone: env.USER_TIMEZONE,
      }),
    // Ohne Datenbank gibt es keinen Verlauf, das ist kein Fehler (gilt als abgelegt)
    record: historyRecorder(message => storeOr(true, store => store.messages.save(message))),
  });
}
