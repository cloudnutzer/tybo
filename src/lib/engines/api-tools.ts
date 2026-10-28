/**
 * Werkzeuge des Motors "api" (Issue #348).
 *
 * Angeboten wird, was mcpManager anbietet (Built-ins mit zutreffendem
 * isAvailable und Server-Werkzeuge, die kein Built-in verdeckt), dazu vier
 * eigene Werkzeuge: ask_user und die Planungswerkzeuge schedule_task,
 * list_scheduled_tasks, cancel_scheduled_task. Ist mcpManager nicht bereit,
 * nur die vier eigenen. Die eigenen Namen sind reserviert: ein gleichnamiges
 * Server-Werkzeug wird nicht angeboten.
 *
 * Ausgeführt wird immer über mcpManager.callTool (Built-ins über
 * callBuiltinTool samt Verfügbarkeit und Freigabe, schreibende
 * MCP-Werkzeuge mit Freigabe), nie über einen Handler direkt. Die
 * Planungswerkzeuge stehen nicht in der Registry: Fallback-Modelle und
 * Sprach-Brücke sehen sie nicht. Anlegen und Absagen laufen über
 * authorizeTool mit requiresApproval, wie Built-ins.
 *
 * Gespräch der Planungswerkzeuge: aus dem Ausführungsschlüssel wie bei
 * Freigaben (conversationForExecution), Chat und Topic mit reminderChat wie
 * bei [REMIND:] (schedule/remind.ts): reines Web-Gespräch als web:<id> ohne
 * Topic, Direktchat (auch ohne Telegram "web"), Topic, Forum-Gruppe. Ein
 * Turn ohne Telegram (EngineRequest.noTelegram) in einem Telegram-Gespräch
 * legt mit Chat und Topic an, aber nur für die WebUI (webOnlyChatId);
 * Auflisten und Absagen sehen dann genau diese Einträge.
 */

import type { AnthropicToolDef } from "../anthropic-stream";
import type { ChoiceConversation } from "../choices";
import { currentExecution } from "../execution-context";
import { mcpManager, type McpManager } from "../mcp/manager";
import { parseReminderTime, reminderChat } from "../schedule/remind";
import { reminderRef, parseReminderRef } from "../schedule/overview";
import { shortStamp } from "../schedule/planner";
import { getScheduleStore } from "../schedule/store";
import type { ScheduledTask, ScheduleStore } from "../schedule/contract";
import { conversationForExecution } from "../tool-approval";
import { authorizeTool, type BuiltinTool } from "../tools/registry";
import { renderQuestionTags, scanForQuestion } from "../turn-questions";
import { effectiveTimeZone } from "../when";

export const ASK_USER = "ask_user";
export const SCHEDULE_TASK = "schedule_task";
export const LIST_SCHEDULED = "list_scheduled_tasks";
export const CANCEL_SCHEDULED = "cancel_scheduled_task";

/** Namen der eigenen Werkzeuge, reserviert gegen Server-Werkzeuge */
export const OWN_TOOL_NAMES: readonly string[] = [ASK_USER, SCHEDULE_TASK, LIST_SCHEDULED, CANCEL_SCHEDULED];

/** Höchstzahl der Antworten einer Rückfrage */
export const ASK_USER_OPTIONS_MAX = 8;
const ASK_LABEL_MAX = 200;
const ASK_QUESTION_MAX = 500;
const SCHEDULE_TEXT_MAX = 1_000;

/** Ergebnis eines Werkzeugaufrufs für das Modell */
export interface ToolOutcome {
  content: string;
  isError: boolean;
}

/** Werkzeuge aus mcpManager; in Tests ersetzbar */
export interface ApiToolHost {
  /** Angebotene Werkzeuge im Anthropic-Format; leer, wenn nicht bereit */
  offered(): AnthropicToolDef[];
  call(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
  /** Server eines MCP-Werkzeugs; undefined bei Built-ins */
  serverOf(name: string): string | undefined;
}

/** Werkzeuge eines MCP-Managers; Tests geben einen Manager mit Attrappen-Transport herein */
export function managerToolHost(manager: Pick<McpManager, "isReady" | "getAnthropicTools" | "callTool" | "serverOf">): ApiToolHost {
  return {
    offered: () =>
      manager.isReady ? manager.getAnthropicTools().map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.input_schema })) : [],
    call: (name, args) => manager.callTool(name, args),
    serverOf: (name) => manager.serverOf(name),
  };
}

/** Werkzeuge des Bot-Prozesses */
export const mcpToolHost: ApiToolHost = managerToolHost(mcpManager);

// ---------------------------------------------------------------------------
// Beschreibungen der eigenen Werkzeuge
// ---------------------------------------------------------------------------

export const ASK_USER_DEF: AnthropicToolDef = {
  name: ASK_USER,
  description:
    "Ask the user a question and wait for the answer. Use it only for real decisions you cannot make yourself. " +
    "The user gets one button per option plus a cancel button; the chosen option comes back as the tool result. " +
    'Options default to yes/no. No "|", "[" or "]" in the question or the options.',
  input_schema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question, one sentence" },
      options: {
        type: "array",
        maxItems: ASK_USER_OPTIONS_MAX,
        items: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
      },
    },
    required: ["question"],
  },
};

const SCHEDULE_DEFS: AnthropicToolDef[] = [
  {
    name: SCHEDULE_TASK,
    description:
      "Create a one-time reminder in this conversation. 'when' uses the same notation as the REMIND tag " +
      "(e.g. 'morgen 9 Uhr', 'in 2 Stunden', 'Freitag 8:15', ISO time). The user confirms before it is created.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" }, when: { type: "string" } },
      required: ["text", "when"],
    },
  },
  {
    name: LIST_SCHEDULED,
    description: "List the pending reminders of this conversation with their id and due time.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: CANCEL_SCHEDULED,
    description: "Cancel a pending reminder of this conversation by its id (the short id from the list is enough). The user confirms first.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

/** Freigabe-Attrappe für authorizeTool: Name und Beschreibung erscheinen in der Frage */
function gate(name: string, description: string): BuiltinTool {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: {} },
    requiresApproval: true,
    isAvailable: () => true,
    handler: async () => "",
  };
}

// ---------------------------------------------------------------------------
// Angebot
// ---------------------------------------------------------------------------

export interface ToolOffer {
  defs: AnthropicToolDef[];
  /** Namen, die ausgeführt werden dürfen (ohne ask_user) */
  callable: Set<string>;
  /** ask_user angeboten: nur dann wird aus einem Aufruf eine Pause */
  ask: boolean;
}

/**
 * Angebot für einen Lauf. Mit allowedTools nur Werkzeuge aus der Liste, ask_user
 * nur bei ask true (Lauf mit Rückfragen-Register, EngineRequest.questions bzw. answersQuestion).
 * Ein Agent mit Namen der Claude-CLI (Read, WebSearch) bekommt so keine
 * Registry-Werkzeuge (vorsichtige Auslegung).
 */
export function toolOffer(host: ApiToolHost, allowedTools: string[] | undefined, ask = true): ToolOffer {
  const allowed = allowedTools ? new Set(allowedTools) : null;
  const permitted = (name: string) => !allowed || allowed.has(name);
  let hosted: AnthropicToolDef[] = [];
  try {
    hosted = host.offered().filter((t) => !OWN_TOOL_NAMES.includes(t.name));
  } catch {
    hosted = [];
  }
  const defs = [...hosted, ...SCHEDULE_DEFS].filter((t) => permitted(t.name));
  const seen = new Set<string>();
  const unique = defs.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)));
  return { defs: ask ? [...unique, ASK_USER_DEF] : unique, callable: new Set(unique.map((t) => t.name)), ask };
}

// ---------------------------------------------------------------------------
// ask_user
// ---------------------------------------------------------------------------

export type AskCheck = { ok: true; question: string; options: string[]; tag: string } | { ok: false; error: string };

const FORBIDDEN = /[|[\]]/;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Prüft eine Rückfrage gegen das Format [FRAGE: Frage | Antwort ...]: keine
 * Pause, aus der keine entscheidbare Rückfrage würde. Zum Schluss liest
 * scanForQuestion den Tag zurück; nur wenn er genau so erkannt wird, gilt er.
 */
export function checkAskUser(input: Record<string, unknown>): AskCheck {
  const question = typeof input.question === "string" ? oneLine(input.question) : "";
  if (!question) return { ok: false, error: "ask_user braucht eine Frage (question)." };
  if (question.length > ASK_QUESTION_MAX) return { ok: false, error: `Die Frage ist zu lang (höchstens ${ASK_QUESTION_MAX} Zeichen).` };
  const raw = input.options === undefined ? [{ label: "Ja" }, { label: "Nein" }] : input.options;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > ASK_USER_OPTIONS_MAX) {
    return { ok: false, error: `ask_user braucht 1 bis ${ASK_USER_OPTIONS_MAX} Antworten (options mit label).` };
  }
  const options = raw.map((o) => (o && typeof o === "object" && typeof (o as { label?: unknown }).label === "string" ? oneLine((o as { label: string }).label) : ""));
  if (options.some((o) => !o || o.length > ASK_LABEL_MAX)) return { ok: false, error: "Jede Antwort braucht ein label mit Text (höchstens 200 Zeichen)." };
  if (FORBIDDEN.test(question) || options.some((o) => FORBIDDEN.test(o))) {
    return { ok: false, error: 'Frage und Antworten dürfen kein "|", "[" oder "]" enthalten.' };
  }
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return { ok: false, error: "Zwei Antworten sind gleich." };
  const tag = `[FRAGE: ${question} | ${options.join(" | ")}]`;
  const read = scanForQuestion(tag).found;
  if (!read || read.via !== "tag" || read.question !== question || read.options.length !== options.length) {
    return { ok: false, error: "Diese Rückfrage lässt sich nicht als Knöpfe zeigen; bitte einfacher formulieren." };
  }
  return { ok: true, question, options, tag };
}

/** Liest scanForQuestion die ganze Ausgabe als genau diese Rückfrage (Tag, gleiche Frage und Antworten)? */
function readsAs(output: string, question: string, options: string[]): boolean {
  const read = scanForQuestion(output).found;
  return !!read && read.via === "tag" && read.question === question && read.options.length === options.length && read.options.every((o, i) => o === options[i]);
}

/** Text des Modells ohne eigene Rückfrage-Tags: vollständige lesbar, angefangene ohne Klammer */
const withoutTags = (text: string) => renderQuestionTags(text).replace(/\[(FRAGE:)/gi, "$1");

/**
 * Ausgabe einer ask_user-Pause: Text des Modells aus derselben Runde, dann
 * der geprüfte Tag. Der Chat-Kern liest die ganze Ausgabe mit
 * scanForQuestion; ein eigener [FRAGE:]-Tag im Text (dann gälte keiner) oder
 * ein offener Codeblock (dann stünde der Tag im Code) ergäben keine
 * entscheidbare Rückfrage. Deshalb gilt die erste Fassung, die genau als
 * diese Rückfrage gelesen wird: Text unverändert, Text ohne eigene Tags,
 * dazu ein geschlossener Zaun; sonst der Tag allein.
 */
export function askOutput(text: string, ask: { question: string; options: string[]; tag: string }): string {
  const body = text.trim();
  if (!body) return ask.tag;
  const plain = withoutTags(body);
  const tries = [body, plain, `${plain}\n\`\`\``, `${plain}\n~~~`];
  for (const t of tries) {
    const output = `${t}\n\n${ask.tag}`;
    if (readsAs(output, ask.question, ask.options)) return output;
  }
  return ask.tag;
}

// ---------------------------------------------------------------------------
// Planungswerkzeuge
// ---------------------------------------------------------------------------

/**
 * Chat und Topic im ScheduleStore für ein Gespräch, mit reminderChat wie bei
 * [REMIND:]: ein Turn ohne Telegram legt nur für die WebUI an.
 */
export function scheduleChat(conversation: ChoiceConversation, noTelegram?: { conversationId: string }): { chatId: string; topicId: number | null } {
  return reminderChat({ conversation, ...(noTelegram ? { noTelegram } : {}) });
}

export interface ScheduleToolDeps {
  store(): ScheduleStore;
  now(): number;
  timeZone(): string;
  /** Gespräch des laufenden Turns; null, wenn keins bestimmbar ist */
  conversation(): ChoiceConversation | null;
  /** Freigabe; null heißt erlaubt, sonst das Fehlerergebnis */
  authorize(tool: BuiltinTool, args: Record<string, unknown>): Promise<ToolOutcome | null>;
}

export const realScheduleToolDeps: ScheduleToolDeps = {
  store: () => getScheduleStore(),
  now: () => Date.now(),
  timeZone: () => effectiveTimeZone(),
  conversation: () => conversationForExecution(currentExecution()?.key),
  authorize: (tool, args) => authorizeTool(tool, args),
};

const fail = (content: string): ToolOutcome => ({ content, isError: true });
const ok = (content: string): ToolOutcome => ({ content, isError: false });

const NO_CONVERSATION = "Kein Gespräch bestimmbar, nichts geplant.";
const STORE_DOWN = "Die Ablage für Erinnerungen ist gerade nicht erreichbar.";

function line(task: ScheduledTask, zone: string): string {
  return `${reminderRef(task.id)} · ${shortStamp(Date.parse(task.dueAt), zone)} · ${task.text}`;
}

function sameChat(task: ScheduledTask, where: { chatId: string; topicId: number | null }): boolean {
  return task.chatId === where.chatId && (task.topicId ?? null) === where.topicId;
}

/**
 * Führt ein Planungswerkzeug aus; wirft nicht außer bei Abbruch (aus
 * authorize). noTelegram aus der Anfrage des Motors: Anlegen, Auflisten und
 * Absagen gelten dann der WebUI-Fassung des Gesprächs.
 */
export async function runScheduleTool(name: string, input: Record<string, unknown>, d: ScheduleToolDeps, noTelegram?: { conversationId: string }): Promise<ToolOutcome> {
  const conversation = d.conversation();
  if (!conversation) return fail(NO_CONVERSATION);
  const where = scheduleChat(conversation, noTelegram);
  const zone = d.timeZone();

  if (name === SCHEDULE_TASK) {
    const text = typeof input.text === "string" ? input.text.trim() : "";
    const when = typeof input.when === "string" ? input.when.trim() : "";
    if (!text || text.length > SCHEDULE_TEXT_MAX) return fail("schedule_task braucht einen Text (höchstens 1.000 Zeichen).");
    const dueAt = parseReminderTime(when, { now: new Date(d.now()), timeZone: zone });
    if (!dueAt) return fail(`Die Zeitangabe „${when.slice(0, 80)}“ ist nicht lesbar, nichts angelegt.`);
    const denied = await d.authorize(gate(SCHEDULE_TASK, `Erinnerung anlegen: ${text.slice(0, 80)}`), { text, when: dueAt.toISOString() });
    if (denied) return denied;
    const task = await d.store().add({ ...where, kind: "reminder", text, dueAt });
    if (!task) return fail(STORE_DOWN);
    return ok(`Erinnerung angelegt. Kennung ${reminderRef(task.id)}, fällig ${shortStamp(Date.parse(task.dueAt), zone)}.`);
  }

  if (name === LIST_SCHEDULED) {
    const tasks = await d.store().listAll({ chatId: where.chatId, topicId: where.topicId, status: ["pending"] });
    if (!tasks) return fail(STORE_DOWN);
    const own = tasks.filter((t) => sameChat(t, where));
    if (own.length === 0) return ok("In diesem Gespräch ist nichts geplant.");
    return ok(own.map((t) => line(t, zone)).join("\n"));
  }

  if (name === CANCEL_SCHEDULED) {
    const ref = typeof input.id === "string" ? parseReminderRef(input.id) : null;
    if (!ref) return fail("cancel_scheduled_task braucht eine Kennung aus list_scheduled_tasks.");
    const found = await d.store().listAll({ idPrefix: ref });
    if (!found) return fail(STORE_DOWN);
    const hits = found.filter((t) => t.id.toLowerCase().startsWith(ref));
    if (hits.length === 0) return fail(`Keine Erinnerung mit der Kennung ${ref}.`);
    if (hits.length > 1) return fail(`Die Kennung ${ref} passt auf mehrere Einträge; bitte länger angeben.`);
    const hit = hits[0];
    if (!sameChat(hit, where)) return fail(`Die Erinnerung ${ref} gehört zu einem anderen Gespräch, nichts geändert.`);
    if (hit.status !== "pending") return fail(`Die Erinnerung ${ref} wartet nicht mehr, nichts geändert.`);
    const denied = await d.authorize(gate(CANCEL_SCHEDULED, `Erinnerung absagen: ${hit.text.slice(0, 80)}`), { id: reminderRef(hit.id) });
    if (denied) return denied;
    if (!(await d.store().cancel(hit.id))) return fail(`Die Erinnerung ${ref} wartet nicht mehr, nichts geändert.`);
    return ok(`Erinnerung ${reminderRef(hit.id)} abgesagt.`);
  }

  return fail(`Unbekanntes Werkzeug ${name}`);
}
