/** Gesperrte Übergänge zwischen Arbeit und einer dauerhaft gespeicherten Frage. */
import { canAskQuestion, MAX_JOB_QUESTIONS, QUESTION_WAIT_MS, type JobQuestion } from "./question-file";
import { accountWork, archiveQuestion, archiveRunFiles, nextRun, remainingWorkMs, updateStatus } from "./store";

export async function claimQuestion(root: string, id: string, run: number, question: JobQuestion, now: () => Date) {
  return updateStatus(root, id, status => {
    if (status.phase !== "running" || (status.run ?? 1) !== run || !canAskQuestion(status) || (status.questionCount ?? 0) >= MAX_JOB_QUESTIONS) return null;
    const at = now();
    accountWork(status, at);
    status.phase = "waiting";
    status.questionCount = (status.questionCount ?? 0) + 1;
    status.waiting = { number: status.questionCount, question, askedAt: at.toISOString(),
      deadlineAt: new Date(at.getTime() + QUESTION_WAIT_MS).toISOString(), delivery: { state: "pending", attempts: 0 } };
    return status;
  });
}

export interface JobAnswer {
  run: number;
  number: number;
  choiceId: string;
  text: string;
  /** Zeitpunkt der gespeicherten Auswahl; ein vor der Frist angenommener Klick bleibt gültig. */
  at: number;
}

/** Der Aufrufer hält start.lock. Genau ein Klick, Reply, Stopp oder Fristablauf gewinnt. */
export async function claimAnswer(root: string, id: string, answer: JobAnswer, now: () => Date) {
  return updateStatus(root, id, async status => {
    const q = status.waiting;
    if (status.phase !== "waiting" || !q || (status.run ?? 1) !== answer.run || q.number !== answer.number ||
      q.choiceId !== answer.choiceId || answer.at >= Date.parse(q.deadlineAt) || !canAskQuestion(status) || remainingWorkMs(status) <= 0) return null;
    await archiveQuestion(root, status);
    await archiveRunFiles(root, status);
    nextRun(status, now());
    status.resumeReason = "answer";
    status.answer = { text: answer.text, questionNumber: answer.number };
    return status;
  });
}
