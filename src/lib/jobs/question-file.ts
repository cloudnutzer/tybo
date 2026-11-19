/** Rückfragen aus einer Datei: nur Daten, keine Werkzeuge oder Befehle. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { safeValues } from "./notice";
import { MASK, type SecretValue } from "./mask";
import { jobFile, type JobStatus } from "./store";

export const MAX_JOB_QUESTIONS = 5;
export const QUESTION_WAIT_MS = 48 * 3_600_000;
export const QUESTION_MAX_BYTES = 16 * 1024;
export const QUESTION_MAX_CHARS = 500;
export const CONTEXT_MAX_CHARS = 1_000;
export const OPTION_MAX_CHARS = 80;
export const ANSWER_MAX_CHARS = 2_000;

export interface JobQuestion {
  frage: string;
  antworten: string[];
  kontext: string;
}

export function canAskQuestion(status: Pick<JobStatus, "engine" | "sessionId" | "workDir">): boolean {
  return status.engine !== "codex" && status.workDir === undefined &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(status.sessionId ?? "");
}

const textWithin = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);

export function parseJobQuestion(value: unknown): JobQuestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const q = value as Record<string, unknown>;
  if (Object.keys(q).some(key => !["frage", "antworten", "kontext"].includes(key))) return null;
  if (!textWithin(q.frage, QUESTION_MAX_CHARS) || !textWithin(q.kontext, CONTEXT_MAX_CHARS)) return null;
  if (!Array.isArray(q.antworten) || q.antworten.length < 1 || q.antworten.length > 8 ||
    !q.antworten.every(a => textWithin(a, OPTION_MAX_CHARS))) return null;
  const answers = q.antworten.map(a => a.trim());
  if (new Set(answers).size !== answers.length) return null;
  return { frage: q.frage.trim(), kontext: q.kontext.trim(), antworten: answers };
}

export function safeQuestion(question: JobQuestion, secrets: readonly SecretValue[]): JobQuestion {
  const [frage, kontext, ...antworten] = safeValues(
    [question.frage, question.kontext, ...question.antworten], values => values.join("\n"), secrets,
  );
  const bounded = (value: string, max: number) => value.length <= max ? value : MASK;
  return { frage: bounded(frage, QUESTION_MAX_CHARS), kontext: bounded(kontext, CONTEXT_MAX_CHARS),
    antworten: antworten.map(a => bounded(a, OPTION_MAX_CHARS)) };
}

export function safeAnswer(text: string, secrets: readonly SecretValue[]): string {
  const [masked] = safeValues([text.trim()], values => values[0], secrets);
  return masked.length <= ANSWER_MAX_CHARS ? masked : MASK;
}

export type QuestionFileResult = { kind: "missing" | "ignored" } | { kind: "invalid"; detail: string } | { kind: "valid"; question: JobQuestion };

/** Kein Link, Verzeichnis oder FIFO; begrenztes Lesen auch bei gleichzeitig wachsender Datei. */
export async function readJobQuestion(root: string, status: JobStatus, secrets: readonly SecretValue[]): Promise<QuestionFileResult> {
  if (!canAskQuestion(status)) return { kind: "ignored" };
  const invalid: QuestionFileResult = { kind: "invalid", detail: "frage.json ist ungültig oder nicht sicher lesbar. Erwartet: Frage, kurzer Kontext und 1 bis 8 Antworten innerhalb der Längengrenzen." };
  let handle;
  try {
    handle = await open(jobFile(root, status.id, "question"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : invalid;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > QUESTION_MAX_BYTES) return invalid;
    const buffer = Buffer.alloc(QUESTION_MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > QUESTION_MAX_BYTES) return invalid;
    const question = parseJobQuestion(JSON.parse(buffer.subarray(0, size).toString("utf8")));
    return question ? { kind: "valid", question: safeQuestion(question, [...secrets, status.sessionId!]) } : invalid;
  } catch {
    return invalid;
  } finally {
    await handle.close();
  }
}

export function questionInstruction(root: string, status?: JobStatus): string {
  if (!status || !canAskQuestion(status)) return "";
  const remaining = Math.max(0, MAX_JOB_QUESTIONS - (status.questionCount ?? 0));
  return `Rückfragen: Höchstens ${MAX_JOB_QUESTIONS} je Job, noch ${remaining} verfügbar. ` +
    `Brauchst du eine Entscheidung, schreibe mit dem Dateiwerkzeug ${jobFile(root, status.id, "question")} ` +
    '(relativ zum Projekt: data/jobs/' + status.id + '/frage.json) als JSON: {"frage":"A oder B?","antworten":["A","B"],"kontext":"Kurzer Grund"}. ' +
    `Nur diese drei Felder; Frage bis ${QUESTION_MAX_CHARS}, Kontext bis ${CONTEXT_MAX_CHARS}, 1 bis 8 verschiedene Antworten mit je bis ${OPTION_MAX_CHARS} Zeichen, Datei bis ${QUESTION_MAX_BYTES} Bytes. ` +
    "Beende danach den Turn ohne Bericht. tybo stellt die Frage und setzt dieselbe Session mit der Antwort fort. " +
    "Keine Geheimnisse in Frage, Kontext oder Antworten. Ohne verbleibende Fragen: keine weitere Frage schreiben, sondern im Bericht die offene Entscheidung erklären und die Arbeit beenden.\n";
}
