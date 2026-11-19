/** Fortsetzen-Fragen je Lauf. Der Wächter bietet nur an; entschieden wird im Bot. */
import { join } from "node:path";
import { createChoice, expireChoice, listChoices, type Choice, type ChoiceHandler } from "../choices";
import { outboxDelivered } from "../channels";
import { acquireFileLock, releaseFileLock } from "../file-lock";
import { routineConversation } from "../routine-choices";
import { sendChoice } from "../telegram-choices";
import { logSafe, safeValues } from "./notice";
import { resumeJob, resumeMessage } from "./resume";
import { applyQuestionChoice } from "./question-choices";
import type { JobDeps } from "./runner";
import { jobSessionPresent } from "./session";
import { isValidJobId, jobsDir, readStatus, resumeBlockReason, type JobStatus } from "./store";

export async function expireJobChoices(id: string): Promise<void> {
  for (const choice of await listChoices()) {
    if (choice.kind === "job" && choice.ref === id && choice.state === "open") await expireChoice(choice.id);
  }
}

export interface JobChoiceTarget {
  userId: string;
  groupId?: string;
  telegram: boolean;
}

/** Nur Auskunft für einen bereits erledigten/abgelaufenen Knopf, niemals eine zweite Entscheidung. */
export async function jobChoiceStaleText(root: string, choice: { kind?: string; ref?: string }): Promise<string | undefined> {
  if (choice.kind !== "job" || !choice.ref || !isValidJobId(choice.ref)) return;
  const status = await readStatus(root, choice.ref);
  if (status?.phase === "waiting") return `Job ${status.id} wartet auf dich. Bitte die aktuelle Frage beantworten.`;
  if (status && status.phase !== "ended") return `Job ${status.id} läuft schon.`;
}

/** Eine eigene Frage: der Markdown-Bericht bleibt unverändert und wird nie im Register abgelegt. */
export async function offerJobResume(previous: JobStatus, deps: JobDeps, target: JobChoiceTarget): Promise<void> {
  const path = join(jobsDir(deps.root), "start.lock");
  const lock = await acquireFileLock(path, { waitMs: 15_000 });
  let choice: Choice | undefined;
  try {
    const status = await readStatus(deps.root, previous.id);
    if (!status || (status.run ?? 1) !== (previous.run ?? 1) || resumeBlockReason(status)) return;
    if (!(await jobSessionPresent(deps.root, status, deps.claudeEnv(status)))) return;
    const action = `resume-${status.run ?? 1}`;
    if ((await listChoices()).some(c => c.kind === "job" && c.ref === status.id && c.action === action)) return;
    const chatId = status.target.chatId ?? (status.target.topicId !== undefined ? target.groupId : target.userId);
    if (!chatId) return;
    const conversation = routineConversation(chatId, status.target.topicId);
    if (!conversation) return;
    const render = (values: readonly string[]) =>
      `Job ${status.id} fortsetzen? ${values[0]}\n` + (status.outcome === "unanswered"
        ? "Der Job fragt erneut, soweit noch Fragen verfügbar sind. Das verbleibende Zeitbudget gilt weiter."
        : `Lauf ${(status.run ?? 1) + 1} bekommt erneut bis zu ${status.maxHours} Std.`);
    const text = render(safeValues([status.title], render, [...deps.secrets(), status.sessionId!]));
    choice = await createChoice({ kind: "job", ref: status.id, action, conversation, text,
      options: [{ key: "resume", label: "Fortsetzen" }] },
      { replace: c => c.kind === "job" && c.ref === status.id });
  } finally {
    await releaseFileLock(path, lock);
  }
  if (!choice) return;
  try {
    const c = choice.conversation;
    // Ein Wächter hat kein postWeb. Die Outbox legt die Frage direkt im Web-Gespräch ab.
    const delivered = c.type === "web"
      ? outboxDelivered(await deps.notify({ source: "job", chatId: `web:${c.conversationId}`, text: choice.text, format: "plain", choiceId: choice.id }))
      : (await sendChoice(choice, { send: input => deps.notify(input), telegram: () => target.telegram && c.chatId !== "web",
        refresh: async () => {}, log: line => logSafe(deps, line) })).sent;
    if (delivered) return;
  } catch {
    // Die Abschlussmeldung ist bereits erledigt, sie wird nicht wiederholt.
  }
  await expireChoice(choice.id);
  logSafe(deps, `[job] ${previous.id}: Fortsetzen-Frage nicht zugestellt; job resume bleibt verfügbar`);
}

/** Ein Klick benutzt denselben gesperrten Weg wie job resume, mit zusätzlicher Bindung an den Lauf. */
export function jobChoiceHandler(deps: JobDeps): ChoiceHandler {
  return async choice => {
    if (choice.kind !== "job") return;
    if (!choice.ref || !isValidJobId(choice.ref)) throw new Error("Ungültiger Job-Bezug.");
    let result;
    if (choice.action?.startsWith("ask-")) {
      result = await applyQuestionChoice(choice, deps);
      if (!result) throw new Error("Ungültige Job-Antwort.");
    } else {
      if (choice.result?.key !== "resume") return;
      const match = /^resume-([1-9][0-9]*)$/.exec(choice.action ?? "");
      if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error("Ungültiger Job-Lauf.");
      result = await resumeJob(choice.ref, deps, Number(match[1]));
    }
    const c = choice.conversation;
    const target = c.type === "web" ? { chatId: `web:${c.conversationId}` } : { chatId: c.chatId, ...(c.topicId !== undefined ? { topicId: c.topicId } : {}) };
    const text = resumeMessage(result);
    if (!outboxDelivered(await deps.notify({ ...target, source: "job", format: "plain", text }))) {
      throw new Error("Das Ergebnis der Fortsetzung konnte nicht zugestellt werden. Bitte /jobs prüfen.");
    }
  };
}
