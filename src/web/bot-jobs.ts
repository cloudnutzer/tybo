/** Echte Jobs-Quelle. Status, Reihenfolge und Übergänge teilen sich CLI und WebUI. */
import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { claimChoiceRequest, decideChoice, listChoices, type Choice } from "../lib/choices";
import { routineConversation } from "../lib/routine-choices";
import { selectJobs, statusLabel, stopJob } from "../lib/jobs/control";
import { maskSecrets } from "../lib/jobs/mask";
import { jobDuration, logTail, safeValues } from "../lib/jobs/notice";
import { resumeJob } from "../lib/jobs/resume";
import type { JobDeps } from "../lib/jobs/runner";
import { jobFile, readAllStatuses, readStatus, resumeBlockReason, type JobStatus } from "../lib/jobs/store";
import { threadWebConversation } from "./bot-threads";
import { toApiChoice } from "./choices";
import type { JobItem, JobsPort } from "./jobs";
import { scrubHome } from "./routines";
import { isConversationId } from "./store";

const CONTENT_BYTES = 256 * 1024;
const REPORT_BYTES = 128 * 1024;
export interface BotJobsOptions {
  deps: JobDeps;
  userId: string;
  groupId(): string | null;
  home?: string;
}

export function createBotJobs({ deps, userId, groupId, home = homedir() }: BotJobsOptions): JobsPort {
  const secretsFor = (s: JobStatus) => [...deps.secrets(), ...(s.sessionId ? [s.sessionId] : [])];
  const webId = (c: Choice["conversation"]) => {
    const id = threadWebConversation(c, userId, groupId()).id;
    return id && (id === "dm" || /^topic-[1-9]\d*$/.test(id) || isConversationId(id)) ? id : null;
  };
  const display = (values: string[], s: JobStatus) => safeValues(values.map(v => scrubHome(v, home)
    .replace(/(^|[\s("'=])(?:\/[\w.~-][^\s<>"')]*|[A-Za-z]:\\[^\s<>"')]+)/g, "$1[Pfad verborgen]")), v => v.join("\n"), secretsFor(s));
  async function exists(s: JobStatus, kind: "log" | "report") {
    return lstat(jobFile(deps.root, s.id, kind)).then(f => f.isFile(), () => false);
  }
  async function toItem(s: JobStatus, choices: Choice[], title: (id: string) => Promise<string>): Promise<JobItem> {
    const chat = s.target.chatId ?? (s.target.topicId !== undefined ? groupId() : userId);
    const origin = chat ? routineConversation(chat, s.target.topicId) : null;
    const id = origin ? webId(origin) : null;
    const name = id ? (await title(id).catch(() => "")) || (id === "dm" ? "Direktchat" : id.startsWith("topic-") ? "Topic" : "Web-Gespräch") : "Gespräch nicht verfügbar";
    const [safeTitle, safeName] = display([s.title, name], s);
    let question: JobItem["question"] = null;
    if (s.phase === "waiting" && s.waiting) {
      const q = s.waiting;
      const choice = q.choiceId ? choices.find(c => c.id === q.choiceId && c.kind === "job" && c.ref === s.id && c.action === `ask-${s.run ?? 1}-${q.number}`) : undefined;
      const conversationId = choice ? webId(choice.conversation) : null;
      const labels = display([q.question.frage, q.question.kontext, ...q.question.antworten, ...(choice?.options.map(o => o.label) ?? [])], s);
      const apiChoice = choice && conversationId ? toApiChoice(choice) : null;
      if (apiChoice) apiChoice.options = apiChoice.options.map((o, i) => ({ key: o.key, label: labels[2 + q.question.antworten.length + i] }));
      question = { number: q.number, text: labels[0], context: labels[1], answers: labels.slice(2, 2 + q.question.antworten.length), conversationId, choice: apiChoice };
    }
    const actions: JobItem["actions"] = [];
    if (s.phase !== "ended") actions.push("stop");
    if (resumeBlockReason(s) === null) actions.push("resume");
    if (await exists(s, "log")) actions.push("log");
    if (await exists(s, "report")) actions.push("report");
    return { id: s.id, title: safeTitle, phase: s.phase, status: statusLabel(s), duration: jobDuration(s, deps.now()), run: s.run ?? 1,
      conversation: { id, name: safeName }, question, actions };
  }
  return {
    home,
    async list(title) {
      const { active, ended } = selectJobs(await readAllStatuses(deps.root));
      const choices = await listChoices();
      return Promise.all([...active, ...ended].map(s => toItem(s, choices, title)));
    },
    async content(id, kind, expectedRun) {
      const s = await readStatus(deps.root, id);
      if (!s) return null;
      const run = s.run ?? 1;
      if (expectedRun !== undefined && expectedRun !== run) return "stale";
      let file;
      try { file = await open(jobFile(deps.root, id, kind), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (e) { if (["ENOENT", "ELOOP"].includes((e as NodeJS.ErrnoException).code ?? "")) return null; throw e; }
      let text: string;
      try {
        const info = await file.stat();
        if (!info.isFile()) return null;
        const secrets = secretsFor(s);
        if (kind === "report" && info.size > REPORT_BYTES) {
          text = "Der Bericht ist zu groß für die WebUI (höchstens 128 KiB).";
        } else {
          // Vorlauf verhindert Teilgeheimnisse an der Lesegrenze. Nach dem Maskieren
          // fällt er weg; danach die möglicherweise unvollständige erste Zeile.
          const overlap = Math.max(4, ...secrets.map(v => Buffer.byteLength(v)));
          const start = kind === "log" ? Math.max(0, info.size - CONTENT_BYTES - overlap) : 0;
          const buffer = Buffer.alloc(Math.min(info.size, kind === "log" ? CONTENT_BYTES + overlap : REPORT_BYTES));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
          text = maskSecrets(buffer.subarray(0, bytesRead).toString("utf8"), secrets);
          if (start > 0) {
            text = text.slice(overlap);
            const line = text.indexOf("\n");
            text = line < 0 ? "(Letzte Log-Zeile zu lang)" : text.slice(line + 1);
          }
          text = scrubHome(text, home);
          text = kind === "log" ? logTail(text, secrets, 200, 60_000) || "(Log ist leer)"
            : safeValues([text], v => v[0], secrets)[0];
        }
      } finally { await file.close(); }
      // Ein Laufwechsel kann die Dateien während des Lesens archivieren.
      const after = await readStatus(deps.root, id);
      if (!after || (after.run ?? 1) !== run) return "stale";
      return { text, run };
    },
    async act(id, action, request, expectedRun) {
      const claim = await claimChoiceRequest(request, { kind: "job", ref: id, action: `${action}-${expectedRun}` });
      if (claim.status === "already") return "already";
      const s = await readStatus(deps.root, id);
      if (!s) return "unknown";
      if ((s.run ?? 1) !== expectedRun) return "stale";
      if (action === "stop") {
        if (s.phase === "ended") return "blocked";
        const result = await stopJob(id, deps, { expectedRun, backgroundDelivery: true });
        // result.message enthält in zwei Fällen eine PID und geht niemals hinaus.
        return result.tree === "gone" ? "done" : result.tree ?? "stale";
      }
      if (resumeBlockReason(s) !== null) return "blocked";
      const choice = (await listChoices()).find(c => c.kind === "job" && c.ref === id && c.action === `resume-${expectedRun}` && c.state === "open");
      if (choice) {
        const result = await decideChoice(choice.id, "resume", "web");
        if (result.status !== "decided") return "already";
        const after = await readStatus(deps.root, id);
        return after && (after.run ?? 1) > expectedRun ? "done" : "failed";
      }
      return (await resumeJob(id, deps, expectedRun)).ok ? "done" : "failed";
    },
  };
}
