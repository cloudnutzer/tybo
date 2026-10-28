/**
 * Kontext für die Fallback-Kette (Issue #331): jeder Aufrufer gibt den
 * Kontext seiner Unterhaltung mit, gebaut wie der fallbackContext eines
 * normalen Turns (buildPromptContext, topic-isoliert). Dazu zwei kleine
 * Einstiege für Aufrufer ohne eigenen Prompt-Bau: fallbackReplyFor
 * (Unterhaltung bekannt) und fallbackReplyForTask (Rückfrage-Task).
 */
import { buildPromptContext, type PromptContextOptions, type PromptContext } from "../prompt-builder";
import { taskTarget, type ResumableTask } from "../task-resume";
import { fallbackReplyText, runFallbackChain, type FallbackRequest, type FallbackResult } from "./chain";

export interface FallbackConversation {
  chatId: string;
  /** Forum-Topic; fehlt im Direktchat und bei Kanälen ohne Topics */
  topicId?: number;
  /** Agent der Unterhaltung, Standard general */
  agent?: string;
  message: string;
}

type BuildContext = (options: PromptContextOptions) => Promise<Pick<PromptContext, "fallbackContext">>;

/**
 * Fallback-Kontext einer Unterhaltung. Scheitert der Aufbau (Speicher nicht
 * erreichbar) oder bricht der Nutzer ab, geht der Fehler an den Aufrufer:
 * ohne Kontext startet die Kette nicht.
 */
export async function fallbackContextFor(
  conversation: FallbackConversation,
  build: BuildContext = buildPromptContext
): Promise<string> {
  const { fallbackContext } = await build({
    userMessage: conversation.message,
    chatId: conversation.chatId,
    agentName: conversation.agent ?? "general",
    topicId: conversation.topicId,
  });
  return fallbackContext;
}

export interface FallbackHelperDeps {
  loadContext(conversation: FallbackConversation): Promise<string>;
  runChain(request: FallbackRequest): Promise<FallbackResult>;
}

const realHelper: FallbackHelperDeps = {
  loadContext: (conversation) => fallbackContextFor(conversation),
  runChain: (request) => runFallbackChain(request),
};
let helper: FallbackHelperDeps = realHelper;

/** Nur für Tests: Kontext und Kette ersetzen; ohne Argument zurück zu den echten */
export function setFallbackHelperForTests(overrides?: Partial<FallbackHelperDeps>): void {
  helper = { ...realHelper, ...overrides };
}

/** Fallback-Antwort für eine Unterhaltung, als Text für den Nutzer */
export async function fallbackReplyFor(conversation: FallbackConversation): Promise<string> {
  const context = await helper.loadContext(conversation);
  return fallbackReplyText(await helper.runChain({ question: conversation.message, context }));
}

/**
 * Fallback für eine fortgesetzte Rückfrage: Unterhaltung des Tasks (chat_id,
 * thread_id, metadata.agent_name), nicht die, in der der Knopf gedrückt wurde.
 */
export async function fallbackReplyForTask(
  task: ResumableTask & { original_prompt: string },
  fallbackChatId: string
): Promise<string> {
  const { chatId, topicId, agent } = taskTarget(task, fallbackChatId);
  return fallbackReplyFor({ chatId, topicId, agent, message: task.original_prompt });
}
