/** Zustellung und Wiederherstellung einer Job-Frage, getrennt von Abschlussmeldungen. */
import { randomUUID } from "node:crypto";
import { createChoice, expireChoice, getChoice, listChoices, type Choice } from "../choices";
import { outboxDelivered } from "../channels";
import { routineConversation } from "../routine-choices";
import { sendChoice } from "../telegram-choices";
import type { JobChoiceTarget } from "./choices";
import { DEFAULT_RETRY_DELAYS_MS, deliverNotice, logSafe, safeValues } from "./notice";
import { ownProcessRef, processGone } from "./process";
import { answerJob } from "./resume";
import { resumeMessage } from "./resume";
import { ANSWER_MAX_CHARS, safeAnswer } from "./question-file";
import type { JobDeps } from "./runner";
import { claimOutcome, readStatus, updateStatus, type JobOutcome, type JobStatus } from "./store";

export const questionAction = (status: JobStatus) => `ask-${status.run ?? 1}-${status.waiting!.number}`;

export async function finishWaiting(status: JobStatus, outcome: JobOutcome, deps: JobDeps, detail?: string): Promise<void> {
  const claim = await claimOutcome(deps.root, status.id, outcome, ownProcessRef(deps.proc), {
    expectedRun: status.run ?? 1, expectedPhase: "waiting", expectedQuestion: status.waiting?.number, detail,
  }, deps.now);
  if (!claim.claimed) return;
  try { await deps.expireResumeChoices?.(status.id); }
  finally { await deliverNotice(status.id, claim.token!, deps); }
}

/** Antwort nur aus der gespeicherten Option; Fragetext geht nie in den Folgeauftrag. */
export async function applyQuestionChoice(choice: Choice, deps: JobDeps) {
  const match = /^ask-([1-9][0-9]*)-([1-5])$/.exec(choice.action ?? "");
  const option = choice.options.find(o => o.key === choice.result?.key);
  if (!match || !option || !choice.ref || choice.state !== "done" || !choice.result || !Number.isSafeInteger(Number(match[1]))) return;
  return answerJob(choice.ref, { run: Number(match[1]), number: Number(match[2]), choiceId: choice.id,
    text: option.label, at: choice.result.at }, deps);
}

/** Kann vom Wächter, beim Bot-Start und regelmäßig aufgerufen werden. */
export async function recoverWaitingQuestion(previous: JobStatus, deps: JobDeps, target: JobChoiceTarget): Promise<void> {
  let status = await readStatus(deps.root, previous.id);
  if (!status || status.phase !== "waiting" || !status.waiting) return;
  if (status.waiting.reply && status.waiting.choiceId) {
    const reply = status.waiting.reply;
    const result = await answerJob(status.id, { run: status.run ?? 1, number: status.waiting.number,
      choiceId: status.waiting.choiceId, text: reply.text, at: reply.at }, deps);
    if (!result.ok) await finishWaiting(status, "question_failed", deps, "Die gespeicherte Antwort konnte nicht sicher fortgesetzt werden.");
    return;
  }
  let choice = status.waiting.choiceId ? await getChoice(status.waiting.choiceId) : undefined;
  // Die Register-Entscheidung wurde vor dem Handler gespeichert. Nach Absturz selbst nachholen.
  if (choice?.state === "done" && choice.result && choice.result.at < Date.parse(status.waiting.deadlineAt)) {
    const result = await applyQuestionChoice(choice, deps);
    if (result?.ok) return;
    await finishWaiting(status, "question_failed", deps, "Die gespeicherte Antwort konnte nicht sicher fortgesetzt werden. Bitte einen neuen Auftrag starten.");
    return;
  }
  if (deps.now().getTime() >= Date.parse(status.waiting.deadlineAt)) {
    await finishWaiting(status, "unanswered", deps);
    return;
  }
  const run = status.run ?? 1;
  const number = status.waiting.number;
  // Anlegen und Bezug speichern unter status.lock. Ein vor dem Speichern angelegter Eintrag wird wiedergefunden.
  const prepared = await updateStatus(deps.root, status.id, async s => {
    if (s.phase !== "waiting" || (s.run ?? 1) !== run || s.waiting?.number !== number) return null;
    const q = s.waiting;
    const entries = await listChoices().catch(() => []);
    choice = entries.find(c => c.id === q.choiceId) ?? entries.find(c => c.kind === "job" && c.ref === s.id && c.action === questionAction(s) && c.state !== "expired");
    if (!choice || choice.state === "expired") {
      const chatId = s.target.chatId ?? (s.target.topicId !== undefined ? target.groupId : target.userId);
      const conversation = chatId ? routineConversation(chatId, s.target.topicId) : null;
      if (!conversation) throw new Error("Kein gültiges Gespräch für die Job-Frage.");
      const render = (v: readonly string[]) => `Job ${s.id}: ${v[0]}\nFrage ${number} von 5: ${v[1]}\n${v[2]}\nBitte einen Knopf wählen; in Telegram auch als Antwort auf diese Meldung. Frist: 48 Stunden.`;
      const values = safeValues([s.title, q.question.frage, q.question.kontext, ...q.question.antworten],
        v => render(v) + "\n" + v.slice(3).join("\n"), [...deps.secrets(), s.sessionId!]);
      choice = await createChoice({ kind: "job", ref: s.id, action: questionAction(s), conversation,
        text: render(values), options: values.slice(3).map((label, i) => ({ key: `a${i + 1}`, label })),
        expiresAt: Date.parse(q.deadlineAt) }, { replace: c => c.kind === "job" && c.ref === s.id && c.action?.startsWith("ask-") === true });
      q.delivery = { state: "pending", attempts: 0 };
    }
    q.choiceId = choice.id;
    return s;
  });
  if (!prepared.changed || !choice) return;
  status = prepared.status!;
  if (choice.state === "done") {
    await applyQuestionChoice(choice, deps);
    return;
  }
  const token = randomUUID();
  const owner = ownProcessRef(deps.proc);
  const claimed = await updateStatus(deps.root, status.id, s => {
    const q = s.waiting;
    if (s.phase !== "waiting" || !q || q.choiceId !== choice!.id || q.delivery.state === "sent" ||
      (q.delivery.owner && !processGone(q.delivery.owner, deps.proc))) return null;
    q.delivery.owner = { ...owner, token };
    return s;
  });
  if (!claimed.changed) return;
  const delays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  try {
    for (;;) {
      const begun = await updateStatus(deps.root, status.id, s => {
        if (s.phase !== "waiting" || s.waiting?.delivery.owner?.token !== token) return null;
        s.waiting.delivery.state = "sending";
        s.waiting.delivery.attempts++;
        return s;
      });
      if (!begun.changed) return;
      const attempt = begun.status!.waiting!.delivery.attempts;
      let delivered = false;
      try {
        const c = choice.conversation;
        delivered = c.type === "web"
          ? outboxDelivered(await deps.notify({ source: "job", chatId: `web:${c.conversationId}`, text: choice.text, format: "plain", choiceId: choice.id }))
          : (await sendChoice(choice, { send: input => deps.notify(input), telegram: () => target.telegram && c.chatId !== "web",
            refresh: async () => {}, log: line => logSafe(deps, line) })).sent;
      } catch { /* Wiederholen ohne Fehlerinhalt aus dem Netz. */ }
      await updateStatus(deps.root, status.id, s => {
        if (s.phase !== "waiting" || s.waiting?.delivery.owner?.token !== token) return null;
        s.waiting.delivery.state = delivered ? "sent" : "pending";
        s.waiting.delivery.at = deps.now().toISOString();
        return s;
      });
      if (delivered) {
        logSafe(deps, `[job] ${status.id}: Frage ${number} zugestellt (Versuch ${attempt})`);
        return;
      }
      if (attempt > delays.length) {
        await finishWaiting(status, "question_failed", deps);
        return;
      }
      await deps.sleep(delays[attempt - 1]);
    }
  } finally {
    await updateStatus(deps.root, status.id, s => {
      if (s.phase !== "waiting" || s.waiting?.delivery.owner?.token !== token) return null;
      delete s.waiting.delivery.owner;
      return s;
    });
  }
}

export interface JobReply {
  userId: string;
  chatId: string;
  topicId?: number;
  messageId?: number;
  text: string;
}

/** Nur ein gezielter Reply des Besitzers, niemals die nächste gewöhnliche Chat-Nachricht. */
export async function settleJobReply(input: JobReply, owner: string | undefined, deps: JobDeps): Promise<string | undefined> {
  if (!owner || input.userId !== owner || input.messageId === undefined) return;
  const choice = (await listChoices()).find(c => c.kind === "job" && c.action?.startsWith("ask-") &&
    c.conversation.type === "telegram" && c.conversation.chatId === input.chatId && c.conversation.topicId === input.topicId &&
    c.telegram?.some(ref => ref.chatId === input.chatId && ref.messageId === input.messageId));
  if (!choice?.ref) return;
  if (!input.text.trim() || input.text.length > ANSWER_MAX_CHARS) return `Bitte antworte mit 1 bis ${ANSWER_MAX_CHARS} Zeichen auf die Fragemeldung.`;
  const saved = await updateStatus(deps.root, choice.ref, async s => {
    const q = s.waiting;
    if (s.phase !== "waiting" || !q || q.choiceId !== choice.id || q.reply || deps.now().getTime() >= Date.parse(q.deadlineAt)) return null;
    // Unter derselben Statussperre wie die Wiederherstellung: zuerst Knöpfe ungültig machen.
    if ((await expireChoice(choice.id)).status !== "expired") return null;
    const text = safeAnswer(input.text, [...deps.secrets(), s.sessionId!]);
    q.reply = { text, at: deps.now().getTime() };
    return s;
  });
  if (!saved.changed) return "Diese Job-Frage ist bereits beantwortet oder abgelaufen. Bitte /jobs prüfen.";
  const s = saved.status!;
  const q = s.waiting!;
  return resumeMessage(await answerJob(s.id, { run: s.run ?? 1, number: q.number, choiceId: choice.id,
    text: q.reply!.text, at: q.reply!.at }, deps));
}
