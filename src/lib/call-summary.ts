/**
 * Anruf-Zusammenfassung (Issue #306).
 *
 * Nach einem Telefonanruf fasst tybo das Gesprächsprotokoll zusammen und
 * sucht darin einen Auftrag. Beides läuft über den Aux-Zweck "call-summary":
 * Einstellung aux["call-summary"], sonst AUX_MODEL_CALL_SUMMARY, sonst Haiku
 * über die Claude CLI. Ob ein Aufruf möglich ist (Schlüssel, CLI, Ollama),
 * entscheidet allein callAux; hier gibt es keine eigene Vorabprüfung.
 *
 * Misslingt der Aufruf, bekommt der Anrufer statt der Zusammenfassung den
 * Anfang des Protokolls mit Hinweis und statt eines Auftrags null.
 * summarizeTranscriptStrict wirft stattdessen, damit der Anrufdienst es
 * später erneut versuchen kann. Ist die Aufgabe abgeschaltet (Claude fehlt,
 * Issue #566), wirft sie ClaudeUnavailableError: dann gibt es keinen neuen
 * Versuch, und der Nutzer bekommt den Anfang des Protokolls mit Grund.
 */

import { callAux } from "./aux-model";
import { ClaudeUnavailableError } from "./claude-availability";

/** So viel vom Anfang des Protokolls geht in die Zusammenfassung */
const SUMMARY_INPUT_CHARS = 6000;
/** So viel vom Ende des Protokolls geht in die Auftragssuche */
const TASK_INPUT_TAIL_CHARS = 2000;
/** Anfang des Protokolls, wenn keine Zusammenfassung zustande kommt */
const PREVIEW_CHARS = 500;
const SUMMARY_FAILED_NOTE = "\n\n(Summarization failed)";
/** Kürzere Antworten gelten nicht als Auftrag (vor der Bereinigung gemessen) */
const MIN_TASK_CHARS = 10;
const NO_TASK_ANSWER = "NONE";

function summaryPrompt(transcriptStart: string): string {
  return [
    "Below is the transcript of a phone call. Write a short summary of it:",
    "the main points, what was decided, and any open to-dos.",
    "",
    transcriptStart,
  ].join("\n");
}

function taskPrompt(summary: string, transcriptEnd: string): string {
  return [
    "You get the summary and the final part of a phone call transcript.",
    "Decide whether the caller asked for something concrete to be done,",
    'for example "prepare slides", "write an email", "look into X" or "set up Y".',
    "",
    `SUMMARY: ${summary}`,
    "",
    `END OF TRANSCRIPT (up to ${TASK_INPUT_TAIL_CHARS} characters):`,
    transcriptEnd,
    "",
    "If there is such a request, answer with nothing but that request, phrased as an instruction that begins with a verb.",
    `If the call was only conversation, a check-in or a general discussion without a request, answer with exactly: ${NO_TASK_ANSWER}`,
  ].join("\n");
}

/**
 * Ohne Claude und ohne eigenes Nebenmodell (Issue #566): steht unter der
 * Zusammenfassung statt eines Modelltexts und erklärt, warum
 */
export const CALL_SUMMARY_DISABLED_TEXT =
  "Keine Zusammenfassung: Sie liefe über Claude, und Claude ist hier nicht installiert oder nicht angemeldet. Abhilfe: Claude anmelden oder ein anderes Nebenmodell einstellen (AUX_MODEL_CALL_SUMMARY oder WebUI, Modelle).";

/** Antworttext des Modells, null bei Fehler oder leerer Antwort, "disabled" wenn abgeschaltet */
async function askCallModel(prompt: string, what: string): Promise<string | null | "disabled"> {
  try {
    const answer = await callAux("call-summary", prompt);
    if (answer.disabled) return "disabled";
    if (answer.isError || !answer.text.trim()) return null;
    return answer.text;
  } catch (err) {
    // callAux meldet Fehler als isError; geworfen wird etwa ein Abbruch vor dem Aufruf
    console.error(`[CallSummary] ${what} nicht möglich:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Anführungszeichen am Rand, danach ein vorangestelltes "Task:" entfernen */
function tidyTask(answer: string): string {
  let task = answer;
  if (task.startsWith('"') || task.startsWith("'")) task = task.slice(1);
  if (task.endsWith('"') || task.endsWith("'")) task = task.slice(0, -1);
  return task.replace(/^task:\s*/i, "").trim();
}

/** Ersatz, wenn keine Zusammenfassung zustande kommt: Anfang des Protokolls mit Hinweis */
export function summaryFallback(transcript: string): string {
  return transcript.slice(0, PREVIEW_CHARS) + SUMMARY_FAILED_NOTE;
}

/**
 * Zusammenfassung eines Anrufprotokolls; wirft, wenn das Modell nicht
 * antwortet (Fehler, leere Antwort). Für Aufrufer, die es später erneut
 * versuchen können (Anrufdienst, src/lib/phone/).
 */
export async function summarizeTranscriptStrict(transcript: string): Promise<string> {
  const summary = await askCallModel(summaryPrompt(transcript.slice(0, SUMMARY_INPUT_CHARS)), "Zusammenfassung");
  // Abgeschaltet: eigener Fehler, den der Anrufdienst ohne Wiederholung behandelt
  if (summary === "disabled") throw new ClaudeUnavailableError(CALL_SUMMARY_DISABLED_TEXT);
  if (summary === null) throw new Error("Zusammenfassung nicht möglich");
  return summary;
}

/**
 * Zusammenfassung eines Anrufprotokolls. Ohne Antwort des Modells: die ersten
 * 500 Zeichen des Protokolls mit dem Hinweis "(Summarization failed)".
 */
export async function summarizeTranscript(transcript: string): Promise<string> {
  return summarizeTranscriptStrict(transcript).catch(() => summaryFallback(transcript));
}

/**
 * Auftrag aus einem Anruf als direkte Anweisung, null wenn der Anruf keinen
 * enthält oder das Modell nicht antwortet.
 */
export async function extractTaskFromTranscript(transcript: string, summary: string): Promise<string | null> {
  const raw = await askCallModel(taskPrompt(summary, transcript.slice(-TASK_INPUT_TAIL_CHARS)), "Auftragssuche");
  const answer = raw === "disabled" ? null : raw?.trim();
  if (!answer || answer.length < MIN_TASK_CHARS) return null;
  if (answer === NO_TASK_ANSWER || answer.toLowerCase().includes("no actionable task")) return null;
  return tidyTask(answer);
}
