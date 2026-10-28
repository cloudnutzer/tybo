/**
 * Alte Aufträge mit messages_snapshot fortsetzen (Issue #348): Das frühere
 * VPS-Gateway hat bei ask_user den Verlauf am Auftrag gespeichert
 * (metadata.messages_snapshot, assistant_content, tool_use_id) und
 * atask:-Knöpfe geschickt. Ein Klick darauf (beansprucht über
 * claimLegacyTaskButton, #337) setzt jetzt der Motor "api" fort: Der Stand
 * wird in eine neue Sitzung mit offener Rückfrage übernommen, die Antwort
 * ist das tool_result „User chose: <Antwort>" wie bisher.
 *
 * Werkzeuge, die im Verlauf vor der Rückfrage liefen (etwa ein Abruf einer
 * Webseite), kommen als fremde Inhalte in die Pause: Merk-Tags der
 * Fortsetzung gehen dann ins Review wie bei einem Lauf des Motors selbst.
 *
 * Unvollständiger Stand heißt: kein Motoraufruf. Dazu zählt eine Antwort
 * des Modells mit weiteren Werkzeugaufrufen neben ask_user: deren
 * Ergebnisse hat das Gateway nie gespeichert, und sie noch einmal
 * auszuführen hätte Nebenwirkungen.
 *
 * Der Lauf geht unter runExecution im Gespräch des Auftrags (Sperre,
 * Freigaben im richtigen Gespräch, /stop), mit ANTHROPIC_MODEL bzw. dem
 * Standard des Motors.
 */

import { getAgentConfigOrGeneral } from "../../agents";
import type { AnthropicTurn } from "../anthropic-stream";
import { runExecution, isAbortError } from "../execution-context";
import { bookRunOutcome } from "../spend/credit";
import { taskTarget, TASK_RESUME_TIMEOUT_MS, type ResumableTask } from "../task-resume";
import type { ToolUse } from "../turn-tools";
import { apiModel, apiSessionStore } from "./api";
import { newPauseMark, newSessionId, sessionRef, validHistory, type ApiSession, type ApiSessionStore, type ApiToolResult } from "./api-sessions";
import { ASK_USER } from "./api-tools";
import { getEngine } from "./index";
import type { EngineResult } from "./types";

export const SNAPSHOT_TEXT = {
  incomplete: "Dieser alte Auftrag lässt sich nicht fortsetzen: sein gespeicherter Stand ist unvollständig. Bitte die Frage neu stellen.",
  otherTools: "Dieser alte Auftrag lässt sich nicht fortsetzen: neben der Rückfrage liefen dort weitere Werkzeuge ohne gespeichertes Ergebnis. Bitte die Frage neu stellen.",
} as const;

export type SnapshotResumeOutcome =
  /** Stand unvollständig: kein Motoraufruf */
  | { status: "invalid"; text: string }
  /** /stop oder Neustart, auch in der Warteschlange */
  | { status: "aborted" }
  | { status: "done"; result: EngineResult; sessionId: string; agent: string; model: string };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Werkzeuge, die vor der Rückfrage im Verlauf des Auftrags liefen: ihre
 * Ergebnisse stehen dort und gelten wie im Motor als fremde Inhalte
 * (alles außer ask_user mit external), damit Merk-Tags der Fortsetzung ins
 * Review gehen, auch wenn sie selbst kein Werkzeug mehr ruft.
 */
export function snapshotUses(messages: AnthropicTurn[]): ToolUse[] {
  return messages.flatMap((turn) =>
    turn.role !== "assistant" || typeof turn.content === "string"
      ? []
      : turn.content.flatMap((b): ToolUse[] => (b.type !== "tool_use" || b.name === ASK_USER ? [] : [{ name: b.name, external: true }]))
  );
}

/**
 * Sitzung aus dem Stand des Auftrags; ein Text heißt: nicht fortsetzbar.
 * Der Stand muss vollständig gültig sein wie eine geladene Sitzung
 * (validHistory): Blockfelder, Rollen, Zuordnung der Ergebnisse, die offene
 * Rückfrage am Ende.
 */
export function snapshotSession(metadata: Record<string, unknown> | undefined, model: string, nowIso: string): ApiSession | { invalid: string } {
  const snapshot = metadata?.messages_snapshot;
  const content = metadata?.assistant_content;
  const toolUseId = metadata?.tool_use_id;
  if (!Array.isArray(snapshot) || typeof toolUseId !== "string" || !toolUseId || !Array.isArray(content)) return { invalid: SNAPSHOT_TEXT.incomplete };
  const calls = content.filter((b) => isObject(b) && b.type === "tool_use");
  if (!calls.some((b) => b.id === toolUseId && b.name === ASK_USER)) return { invalid: SNAPSHOT_TEXT.incomplete };
  if (calls.length > 1) return { invalid: SNAPSHOT_TEXT.otherTools };
  const messages: unknown[] = [...snapshot, { role: "assistant", content }];
  const pause = { toolUseId, mark: newPauseMark(), results: [] as ApiToolResult[] };
  if (!validHistory(messages, pause)) return { invalid: SNAPSHOT_TEXT.incomplete };
  return {
    id: newSessionId(),
    model,
    createdAt: nowIso,
    updatedAt: nowIso,
    messages,
    pause: { ...pause, uses: snapshotUses(messages) },
  };
}

export interface SnapshotResumeDeps {
  runExecution: typeof runExecution;
  getEngine: typeof getEngine;
  sessions(): ApiSessionStore;
  model(): string;
  allowedTools(agent: string): string[] | undefined;
  now(): number;
  cwd: string;
}

const defaultDeps: SnapshotResumeDeps = {
  runExecution,
  getEngine,
  sessions: () => apiSessionStore(),
  model: () => apiModel(process.env.ANTHROPIC_MODEL?.trim()),
  allowedTools: (agent) => getAgentConfigOrGeneral(agent)?.allowedTools,
  now: () => Date.now(),
  cwd: process.cwd(),
};

/** Setzt einen beanspruchten alten Auftrag über den Motor api fort; wirft nur bei unerwarteten Fehlern */
export async function resumeSnapshotTask(
  task: ResumableTask,
  answer: string,
  fallbackChatId: string,
  deps?: Partial<SnapshotResumeDeps>
): Promise<SnapshotResumeOutcome> {
  const d = deps ? { ...defaultDeps, ...deps } : defaultDeps;
  const { sessionKey, agent } = taskTarget(task, fallbackChatId);
  const model = d.model();
  const session = snapshotSession(task.metadata, model, new Date(d.now()).toISOString());
  if ("invalid" in session) return { status: "invalid", text: session.invalid };
  const allowedTools = d.allowedTools(agent);
  try {
    return await d.runExecution(
      sessionKey,
      agent,
      async (): Promise<SnapshotResumeOutcome> => {
        await d.sessions().save(session);
        const result = await d.getEngine("api").run({
          prompt: `User chose: ${answer}`,
          streaming: false,
          resumeSessionId: sessionRef(session),
          answersQuestion: true,
          timeoutMs: TASK_RESUME_TIMEOUT_MS,
          cwd: d.cwd,
          model,
          ...(allowedTools ? { allowedTools } : {}),
          abortKey: sessionKey, // /stop beendet auch diesen Lauf
        });
        void bookRunOutcome("task-resume", "api", model, result);
        if (result.aborted) return { status: "aborted" };
        return { status: "done", result, sessionId: result.sessionId || session.id, agent, model };
      },
      allowedTools
    );
  } catch (error) {
    if (isAbortError(error)) return { status: "aborted" };
    throw error;
  }
}
