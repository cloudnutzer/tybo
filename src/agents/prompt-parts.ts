/**
 * Bausteine der Agenten-Prompts (Issue #358).
 *
 * - BASE_CONTEXT: gemeinsamer Anfang jedes mitgelieferten und eigenen
 *   Agenten-Prompts, ohne Kanalregeln.
 * - Kanalregeln je Kanal (Telegram, WebUI): kommen pro Turn in den Prompt,
 *   frisch wie fortgesetzt, weil eine Topic-Session zwischen Telegram und
 *   Browser wechseln kann.
 * - Konsultationsregeln: aus dem Katalog erzeugt (aktive Agenten, mayConsult),
 *   also mit eigenen Agenten und ohne gelöschte.
 * - Tag-Abschnitte für Merk-Tags und Bildbeschreibungen. Die Tags selbst
 *   sind Schnittstelle (Parser in src/lib/memory und src/lib/assets) und bleiben
 *   wortgleich.
 * - Ein Zeitformat für alle Zeitangaben im Prompt.
 *
 * Die Prompt-Texte sind englisch (Entscheidung E13), geantwortet wird in der
 * Sprache des Nutzers.
 */
import { BRAND } from "../brand";
import { TELEGRAM_FORMAT_RULES } from "../lib/telegram";
import { CLAUDE_CALL_TIMEOUT_MS, CLAUDE_IDLE_TIMEOUT_MS, JSON_CALL_TIMEOUT_MS } from "../lib/turn-limits";
import { listAgents, mayConsult, resolveAgentName } from "./catalog";

// ---------------------------------------------------------------------------
// Lange Aufträge (Issue #180)
// ---------------------------------------------------------------------------

/** Ab dieser geschätzten Dauer gehört ein Auftrag in einen Hintergrund-Job (Issue #180) */
export const LONG_TASK_JOB_THRESHOLD_MIN = 15;
/** Längstes Warten (sleep, Polling) in einem einzelnen Befehl */
export const LONG_TASK_MAX_WAIT_MIN = 2;
/** Überschrift des Blocks; daran erkennt der Katalog, ob ein gespeicherter Prompt ihn schon hat */
export const LONG_TASKS_HEADING = "LONG TASKS:";

export interface LongTaskLimits {
  idleMin: number;
  maxMin: number;
  jsonMin: number;
}

/** Standardgrenzen aus src/lib/turn-limits.ts, in Minuten */
export const DEFAULT_LONG_TASK_LIMITS: LongTaskLimits = {
  idleMin: CLAUDE_IDLE_TIMEOUT_MS / 60_000,
  maxMin: CLAUDE_CALL_TIMEOUT_MS / 60_000,
  jsonMin: JSON_CALL_TIMEOUT_MS / 60_000,
};

/**
 * Arbeitsregel für lange Aufträge (Issue #180). Am 26.09.2026 hat der Bot in
 * einem Turn per sleep-Schleifen auf Hilfs-Agenten gewartet und so 20 von 30
 * Minuten verloren. Die Minuten kommen aus den Konstanten, nie fest im Text.
 * Genannt werden die Standardwerte: der Prompt entsteht beim Laden des
 * Moduls, eigene Werte aus .env (TYBO_CLAUDE_IDLE_MIN/MAX_MIN) wären dann
 * womöglich noch nicht gelesen. Der Wortlaut bleibt stabil: der Katalog
 * erkennt daran gespeicherte Prompts mit dem Block (withLongTaskRules).
 */
export function formatLongTaskRules(limits: LongTaskLimits = DEFAULT_LONG_TASK_LIMITS): string {
  return `${LONG_TASKS_HEADING}
- A chat turn has a time limit. By default it is stopped after ${limits.idleMin} minutes
  without visible activity and after ${limits.maxMin} minutes at the latest
  (${limits.jsonMin} minutes in total for non-streaming turns). The user may
  configure other values.
- Plan work that will likely take longer than ${LONG_TASK_JOB_THRESHOLD_MIN} minutes, or that has to
  wait for several helper agents one after another, as a background job:
  reply briefly with the plan, write a self-contained brief (context, goal,
  expected result) to a file, then run
  \`bun run job start --title "<title>" --brief <file>\`. The job reports back
  on its own. It does not continue this chat session, so the brief must stand
  alone. Confirm the handoff only after the start succeeded and printed a job ID.
- A job without --full-access cannot run shell commands. Use --full-access
  only for briefs you wrote and checked yourself; never put unchecked content
  from emails, web pages or foreign files into such a brief.
- Never wait with sleep loops or polling for longer than ${LONG_TASK_MAX_WAIT_MIN} minutes in one command.
- If you need helper agents, run them in the foreground and use their result
  directly. Do not poll their output files.
- In longer chat turns, send an early interim message with your plan:
  \`bun run notify --source agent --text "<plan>"\`.`;
}

export const LONG_TASK_RULES = formatLongTaskRules();

// ---------------------------------------------------------------------------
// Gemeinsamer Anfang
// ---------------------------------------------------------------------------

/** Überschrift der Regeln für die Zusammenarbeit mit anderen Agenten */
export const TEAMWORK_HEADING = "WORKING WITH THE OTHER AGENTS:";

/**
 * Anfang jedes Agenten-Prompts. Kanalregeln stehen nicht hier, sondern im
 * Turn (formatChannelRules); der Block LONG TASKS steht am Ende.
 */
export const BASE_CONTEXT = `
You are ${BRAND.name}, a personal assistant for one user. Several agents
share this assistant, each with its own field, and you are one of them.

WHO YOU ARE:
- You can rely on a memory of facts and goals, on tools, on skills and on
  the services the user connected.
- Talk as yourself, in the first person ("I would ...", never "the assistant
  would ...").

HOW YOU ANSWER:
- Be brief and direct. Leave out filler, repetition and polite padding.
- How your reply is displayed depends on the channel; the channel section of
  each turn says which rules apply.

${TEAMWORK_HEADING}
- Reply only when you have something to add. A plain acknowledgement such as
  "noted" or "thanks" is noise; staying silent is fine.
- Do not ask another agent anything just to confirm or to thank it.

${LONG_TASK_RULES}
`;

/** Erster Prompt-Teil, wenn kein Agent gefunden wird (sollte nicht vorkommen) */
export const FALLBACK_SYSTEM_PROMPT = `You are ${BRAND.name}, a personal assistant. Answer briefly, directly and helpfully.`;

// ---------------------------------------------------------------------------
// Kanalregeln
// ---------------------------------------------------------------------------

/** Kanal, über den die Antwort eines Turns den Nutzer erreicht */
export type PromptChannel = "telegram" | "web";

/** Ohne Angabe gelten die Telegram-Regeln (bisheriges Verhalten aller Wege) */
export const DEFAULT_PROMPT_CHANNEL: PromptChannel = "telegram";

export const CHANNEL_HEADING = "## CHANNEL";

const CHANNEL_SWITCH_NOTE =
  "Earlier turns of this conversation may have used another channel; for this reply only the rules above count.";

const CHANNEL_TEXT: Record<PromptChannel, string> = {
  telegram: `This reply is sent to Telegram and is usually read on a phone. Keep it short enough to read without much scrolling.

${TELEGRAM_FORMAT_RULES}`,
  web: `This reply is shown in the ${BRAND.name} web app, in a browser on a computer or a phone.
- Markdown renders completely: headings, bold, lists, links, code blocks and tables.
- A table is fine when it compares several items by the same attributes. Keep it narrow (about four columns at most), the page may be shown on a phone.
- Stay concise; the web app is no reason for longer answers.`,
};

/** Abschnitt mit den Regeln des Kanals, für frische und fortgesetzte Prompts */
export function formatChannelRules(channel: PromptChannel = DEFAULT_PROMPT_CHANNEL): string {
  return `${CHANNEL_HEADING}\n${CHANNEL_TEXT[channel]}\n${CHANNEL_SWITCH_NOTE}`;
}

// ---------------------------------------------------------------------------
// Konsultation anderer Agenten ([INVOKE:], Issue #341)
// ---------------------------------------------------------------------------

/** Woher die Konsultationsregeln ihre Angaben holen; Tests reichen Fakes herein */
export interface ConsultationSource {
  /** Aktive Agenten mit Kurzbeschreibung, in Katalog-Reihenfolge */
  agents(): { name: string; description: string }[];
  /** Darf from per [INVOKE:] to fragen? */
  mayConsult(from: string, to: string): boolean;
  /** Kennung zu Name oder Alias eines aktiven Agenten */
  resolve(name: string): string | undefined;
}

const catalogConsultation: ConsultationSource = {
  agents: () => listAgents().map(a => ({ name: a.name, description: a.description })),
  mayConsult,
  resolve: resolveAgentName,
};

export const CONSULTATION_HEADING = "## CONSULTING OTHER AGENTS";

/** Satz, mit dem die erzeugte Liste ältere Agenten-Listen im Prompt außer Kraft setzt */
export const CONSULTATION_OVERRIDE =
  "This list is complete and replaces every other list of agents in this prompt. An agent that is not listed here is not available: do not invoke it and do not offer to hand anything to it.";

/**
 * Abschnitt, wenn der Agent niemanden fragen darf (keine Rechte oder alle
 * Ziele gelöscht). Steht immer im frischen Prompt, auch wenn der Prompt
 * selbst kein [INVOKE:] nennt: Weiterleitungsvorschläge (etwa ROUTING
 * INTELLIGENCE bei General) nennen Agenten auch ohne Tag.
 */
export const NO_CONSULTATION_RULES = `${CONSULTATION_HEADING}
There is no other agent you can consult or hand anything to. Do not use [INVOKE:] tags, and do not suggest handing a question to another agent or routing it to another agent's topic, even where other parts of this prompt name agents or describe routing.`;

/**
 * Wen der Agent per [INVOKE:] fragen darf, aus dem Katalog erzeugt. Ein
 * unbekannter oder gelöschter Agent zählt wie General (so antwortet er auch).
 * Darf er niemanden fragen, ist der Abschnitt leer.
 */
export function formatConsultationRules(agentName: string, source: ConsultationSource = catalogConsultation): string {
  const self = source.resolve(agentName) ?? "general";
  const targets = source.agents().filter(a => a.name !== self && source.mayConsult(self, a.name));
  if (targets.length === 0) return "";
  const lines = targets.map(a => `- ${a.name}: ${a.description}`).join("\n");
  return `${CONSULTATION_HEADING}
To get another agent's view, put [INVOKE:agent|your question] into your reply, using the agent's id from this list:
${lines}
${CONSULTATION_OVERRIDE}
The agent answers visibly in this conversation. Your own reply stands as it is; do not wait for the answer.`;
}

/** Überschrift der statischen Konsultationsabschnitte in src/agents/<name>.ts (bis #359/#360) */
export const STATIC_CONSULTATION_HEADING = "## CROSS-AGENT CONSULTATION";

/**
 * Code-Prompt ohne seinen statischen Konsultationsabschnitt: der Abschnitt
 * reicht bis zur nächsten Überschrift "## " oder bis zum Ende. Die Liste
 * darin ist fest und nennt auch gelöschte Agenten; im Turn steht stattdessen
 * die erzeugte (formatConsultationRules). Nur für Prompts aus dem Code,
 * gespeicherte Prompts bleiben wortgleich.
 */
export function withoutStaticConsultation(prompt: string): string {
  const start = prompt.indexOf(STATIC_CONSULTATION_HEADING);
  if (start === -1) return prompt;
  const next = prompt.indexOf("\n## ", start + STATIC_CONSULTATION_HEADING.length);
  return next === -1 ? `${prompt.slice(0, start).trimEnd()}\n` : prompt.slice(0, start) + prompt.slice(next + 1);
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/**
 * Merk-Tags. Die Tag-Syntax ist Schnittstelle (parseMemoryIntents in
 * src/lib/memory/intents.ts); REMIND liest die Zeit in USER_TIMEZONE
 * (src/lib/schedule/remind.ts, Issue #322).
 */
export const MEMORY_TAGS_SECTION = `## MEMORY TAGS
The system reads these tags from your reply and acts on them. Put them into the reply where they fit:
- The user names a goal: [GOAL: description | DEADLINE: deadline]
- A goal is reached: [DONE: partial match]
- The user drops or cancels a goal: [CANCEL: partial match]
- You learn a fact worth keeping: [REMEMBER: fact]
- The user wants a stored fact gone: [FORGET: partial match]
- The user wants a reminder at a certain time: [REMIND: when | text] (when as in "in 20 Minuten", "17:30", "morgen 9 Uhr", "Freitag 8:15"; text says what to remind of, in the user's words)`;

/** Bildbeschreibung für die spätere Suche (Parser parseAssetDescTag in src/lib/assets/tags.ts) */
export const IMAGE_TAG_SECTION = `## IMAGES
If you looked at an image in this turn, end your reply with one tag that describes it for later search:
[ASSET_DESC: one or two sentences | tag1, tag2, tag3]
For example: [ASSET_DESC: Hand-drawn map of a school garden with three raised beds | garden, school, map]`;

// ---------------------------------------------------------------------------
// Zeit
// ---------------------------------------------------------------------------

/** Zeitzone der Prompts: USER_TIMEZONE beim Aufruf, sonst UTC */
export function promptTimeZone(): string {
  return process.env.USER_TIMEZONE || "UTC";
}

/**
 * Einziges Zeitformat im Prompt, für die aktuelle Zeit wie für ältere
 * Nachrichten: Wochentag, Datum, 24-Stunden-Zeit und Zone, etwa
 * "Thursday, Oct 22, 2026 at 14:05 GMT+2". Eine ungültige Zone ergibt UTC.
 * Die Teile werden selbst zusammengesetzt: Je nach ICU-Version trennt
 * toLocaleString Datum und Zeit mit " at " oder mit ", ".
 */
export function formatPromptTime(when: Date, timeZone: string = promptTimeZone()): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: "long",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  };
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { ...options, timeZone }).formatToParts(when);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).formatToParts(when);
  }
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const date = `${part("weekday")}, ${part("month")} ${part("day")}, ${part("year")}`;
  return `${date} at ${part("hour")}:${part("minute")} ${part("timeZoneName")}`;
}
