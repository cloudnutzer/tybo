/**
 * Offene Fäden still schließen (Issue #291, Entscheidung 0025).
 *
 * Nach einem Turn prüft das Aux-Modell (Zweck "threads"), ob die Nachricht
 * des Nutzers einen der offenen Fäden desselben Gesprächs beantwortet,
 * entscheidet oder ausdrücklich verwirft. Wenn ja, wird er geschlossen
 * (closedReason "beantwortet"), ohne Meldung.
 *
 * Ablauf (resolveThreads):
 * 1. THREADS=off: nichts, kein Aufruf.
 * 2. Offene Fäden dieses Gesprächs lesen; ohne offene kein Aufruf. Vorgelegt
 *    werden höchstens THREADS_RESOLVE_MAX, die neuesten.
 * 3. Aux-Aufruf mit Nutzer-Nachricht (Ende), Anfang der Antwort und je Faden
 *    Nummer, Thema und Frage. Ausgabe JSON {"answered": [<nr>, ...]}.
 * 4. Fehler, Zeitüberschreitung, ungültiges JSON: nichts schließen.
 * 5. Nur Nummern aus der vorgelegten Auswahl zählen; geschlossen wird unter
 *    der Sperre der Ablage, die das Gespräch noch einmal prüft.
 *
 * Kein Vorfilter wie bei der Erkennung: auch eine Antwort ohne Frage kann auf
 * eine Nutzer-Nachricht folgen, die einen Faden beantwortet. Ins Log kommen
 * nur Faden- und Gesprächskennungen und Gründe.
 */

import { callAux as realCallAux, type AuxPurpose, type AuxResult } from "../aux-model";
import type { ChoiceConversation } from "../choices";
import {
  closeThreads as realCloseThreads,
  CLOSED_REASON,
  listOpenThreads as realListOpenThreads,
  threadsEnabled,
  type CloseThreadsOutcome,
  type Thread,
} from "./store";

/** So viel der Nutzer-Nachricht bekommt das Aux-Modell (das Ende) */
export const RESOLVE_USER_CHARS = 1_000;
/** So viel der Antwort bekommt das Aux-Modell (der Anfang) */
export const RESOLVE_REPLY_CHARS = 500;
/** Höchstens so viele offene Fäden werden vorgelegt, die neuesten */
export const THREADS_RESOLVE_MAX = 10;
/** Höchstdauer eines Aux-Aufrufs */
export const RESOLVE_TIMEOUT_MS = 60_000;

export interface ResolveInput {
  conversation: ChoiceConversation;
  userText: string;
  reply: string;
}

export interface ThreadResolveDeps {
  callAux(purpose: AuxPurpose, prompt: string, opts: { timeoutMs: number; quiet: true }): Promise<AuxResult>;
  listOpenThreads(conversation: ChoiceConversation): Promise<Thread[]>;
  closeThreads(conversation: ChoiceConversation, nrs: number[], reason: string): Promise<CloseThreadsOutcome>;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  log(message: string): void;
}

const defaultDeps: ThreadResolveDeps = {
  callAux: realCallAux,
  listOpenThreads: realListOpenThreads,
  closeThreads: realCloseThreads,
  env: process.env,
  timeoutMs: RESOLVE_TIMEOUT_MS,
  log: message => console.log(`[threads] ${message}`),
};

export type ResolveOutcome =
  | { status: "off" }
  | { status: "no-threads" }
  | { status: "none" }
  | { status: "closed"; nrs: number[] }
  | { status: "failed"; reason: "fehler" | "zeitüberschreitung" | "ungültige Antwort" };

/** Kennung eines Gesprächs fürs Log, ohne Inhalt (wie conversationKey in detect.ts) */
function key(c: ChoiceConversation): string {
  return c.type === "web" ? `web:${c.conversationId}` : c.topicId !== undefined ? `tg:${c.chatId}:${c.topicId}` : `tg:${c.chatId}`;
}

/** Eine Zeile Text: Zeilenumbrüche und Anführungszeichen würden die Liste im Prompt zerreißen */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function buildResolvePrompt(input: { userText: string; reply: string; threads: Thread[] }): string {
  const user = input.userText.trim().slice(-RESOLVE_USER_CHARS);
  const reply = input.reply.trim().slice(0, RESOLVE_REPLY_CHARS);
  const list = input.threads.map(t => `- Nr. ${t.nr}: Thema: ${oneLine(t.topic)} | Frage: ${oneLine(t.question)}`).join("\n");
  return `Du prüfst, ob eine Nachricht des Nutzers offene Fragen beantwortet, die ein Assistent ihm früher in diesem Gespräch gestellt hat.

Offene Fragen:
${list}

Schließe eine Frage nur, wenn die Nachricht des Nutzers
- die Frage beantwortet oder
- die verlangte Entscheidung trifft oder
- die Frage ausdrücklich verwirft ("vergiss das", "hat sich erledigt").

Sei zurückhaltend. Eine Nachricht zu einem anderen Thema schließt nichts, auch wenn sie eine neue Frage stellt. Im Zweifel nichts schließen. Die Antwort des Assistenten dient nur als Hinweis, worauf sich die Nachricht bezieht; sie selbst schließt keine Frage.

Nachricht des Nutzers (Ende):
"""
${user}
"""

Antwort des Assistenten (Anfang):
"""
${reply}
"""

Antworte nur mit JSON, ohne weiteren Text:
{"answered": [Nummern der beantworteten Fragen]}
Ist keine beantwortet: {"answered": []}`;
}

/**
 * Prüft die JSON-Ausgabe streng; null, wenn sie nicht dem Schema entspricht.
 * Die ganze Antwort muss gültiges JSON mit einem Objekt als Wurzel sein; nur
 * ein umschließender Code-Block ```json ... ``` wird entfernt. Ein in Text
 * oder ein Array eingebettetes Objekt zählt nicht.
 */
export function parseResolveVerdict(text: string): number[] | null {
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/.exec(text.trim());
  let raw: any;
  try {
    raw = JSON.parse(fenced ? fenced[1] : text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.answered)) return null;
  if (!raw.answered.every((n: unknown) => Number.isSafeInteger(n) && (n as number) >= 1)) return null;
  return [...new Set<number>(raw.answered)];
}

class Timeout extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Timeout()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Auflösen nach einem Turn; wartet auf das Ergebnis (für Tests und noteTurnForThreads). */
export async function resolveThreads(input: ResolveInput, deps: Partial<ThreadResolveDeps> = {}): Promise<ResolveOutcome> {
  const d = { ...defaultDeps, ...deps };
  if (!threadsEnabled(d.env)) return { status: "off" };
  const k = key(input.conversation);
  const fail = (reason: "fehler" | "zeitüberschreitung" | "ungültige Antwort"): ResolveOutcome => {
    d.log(`kein Auflösen für Gespräch ${k} (${reason})`);
    return { status: "failed", reason };
  };

  let shown: Thread[];
  try {
    shown = [...(await d.listOpenThreads(input.conversation))].sort((a, b) => b.createdAt - a.createdAt || b.nr - a.nr).slice(0, THREADS_RESOLVE_MAX);
  } catch {
    return fail("fehler");
  }
  if (shown.length === 0) return { status: "no-threads" };

  let result: AuxResult;
  try {
    const prompt = buildResolvePrompt({ userText: input.userText, reply: input.reply, threads: shown });
    // Eigene Grenze zusätzlich zu der von callAux: ein spätes Ergebnis schließt nichts mehr
    result = await withTimeout(d.callAux("threads", prompt, { timeoutMs: d.timeoutMs, quiet: true }), d.timeoutMs + 5_000);
  } catch (e) {
    return fail(e instanceof Timeout ? "zeitüberschreitung" : "fehler");
  }
  if (result.isError) return fail("fehler");
  const answered = parseResolveVerdict(result.text);
  if (!answered) return fail("ungültige Antwort");

  const offered = new Set(shown.map(t => t.nr));
  const nrs = answered.filter(nr => offered.has(nr));
  if (nrs.length === 0) return { status: "none" };

  try {
    const outcome = await d.closeThreads(input.conversation, nrs, CLOSED_REASON.answered);
    if (outcome.closed.length === 0) return { status: "none" };
    d.log(`${outcome.closed.length} Faden/Fäden beantwortet (Gespräch ${k}): ${outcome.closed.map(t => t.id).join(", ")}`);
    return { status: "closed", nrs: outcome.closed.map(t => t.nr) };
  } catch {
    return fail("fehler");
  }
}
