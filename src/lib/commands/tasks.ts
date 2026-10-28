/**
 * /tasks (Issue #337): Aufträge aus async_tasks, die im Gespräch des Befehls
 * laufen oder auf eine Antwort warten, in Telegram, Browser und Terminal
 * gleich. Welche Aufträge zum Gespräch gehören, regelt task-place.ts
 * (Direktchat unter Nutzer-ID und "web" als ein Gespräch, Topic mit
 * thread_id, reines Web-Gespräch als web:<id>).
 *
 * Laufende Aufträge stehen mit ihrem Alter in Minuten da, wartende mit der
 * offenen Frage (sonst dem Anfang des Auftrags). Eine Rückfrage aus dem
 * Register (metadata.ask_id) bekommt den Hinweis, dass ihre Knöpfe an der
 * Rückfrage selbst stehen; /tasks zeigt selbst keine Knöpfe. Ins Log kommt
 * kein Auftragstext. Läuft auch während einer Antwort im Gespräch.
 */

import { storeOr } from "../store";
import type { TaskStore } from "../store/ports";
import type { AsyncTask } from "../store/types";
import { directChatIds, placeChatIds, placeOfTask, samePlace, type TaskPlace } from "../task-place";
import { ALL_CHANNELS, type CommandContext, type CommandDefinition } from "./types";

export const TASKS_TEXT = {
  empty: "In diesem Gespräch läuft gerade kein Auftrag, und keiner wartet auf deine Antwort.",
  unreadable: "Die Aufträge ließen sich gerade nicht lesen. Bitte später nochmal versuchen.",
  running: "Läuft gerade:",
  waiting: "Wartet auf deine Antwort:",
  minutes: (n: number) => `seit ${n} Min.`,
  buttonsAtQuestion: "Knöpfe an der Rückfrage",
} as const;

/** So viele Zeichen eines Auftrags oder einer Frage stehen in der Liste */
const SNIPPET_MAX = 80;

/** Auftragsspeicher ohne Datenbank: leer statt Fehler, wie bisher */
const defaultTasks = (): Pick<TaskStore, "pending" | "running"> => ({
  pending: chatId => storeOr([], store => store.tasks.pending(chatId)),
  running: chatId => storeOr([], store => store.tasks.running(chatId)),
});

function snippet(text: string | undefined): string {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  return line.length <= SNIPPET_MAX ? line : `${line.slice(0, SNIPPET_MAX - 1).trimEnd()}…`;
}

function ageMinutes(task: AsyncTask, now: number): number | null {
  const created = Date.parse(task.created_at);
  return Number.isFinite(created) ? Math.max(0, Math.round((now - created) / 60_000)) : null;
}

const isRegisterTask = (task: AsyncTask) => typeof task.metadata?.ask_id === "string";

/** Liste als Klartext; leer ergibt den Leerzustand */
export function formatTaskList(running: AsyncTask[], waiting: AsyncTask[], now: number): string {
  if (running.length === 0 && waiting.length === 0) return TASKS_TEXT.empty;
  const parts: string[] = [];
  if (running.length > 0) {
    const lines = running.map(t => {
      const age = ageMinutes(t, now);
      return `- ${snippet(t.original_prompt)}${age === null ? "" : ` (${TASKS_TEXT.minutes(age)})`}`;
    });
    parts.push([TASKS_TEXT.running, ...lines].join("\n"));
  }
  if (waiting.length > 0) {
    const lines = waiting.map(t => {
      const question = snippet(t.pending_question) || snippet(t.original_prompt);
      return `- ${question}${isRegisterTask(t) ? ` (${TASKS_TEXT.buttonsAtQuestion})` : ""}`;
    });
    parts.push([TASKS_TEXT.waiting, ...lines].join("\n"));
  }
  return parts.join("\n\n");
}

/**
 * Laufende und wartende Aufträge genau dieses Gesprächs, älteste zuerst;
 * wirft, wenn der Speicher nicht lesbar ist
 */
export async function tasksOfPlace(
  store: Pick<TaskStore, "pending" | "running">,
  place: TaskPlace,
  directIds: readonly string[]
): Promise<{ running: AsyncTask[]; waiting: AsyncTask[] }> {
  const seen = new Set<string>();
  const running: AsyncTask[] = [];
  const waiting: AsyncTask[] = [];
  for (const chatId of placeChatIds(place, directIds)) {
    const [run, wait] = await Promise.all([store.running(chatId), store.pending(chatId)]);
    for (const task of [...run, ...wait]) {
      if (seen.has(task.id) || !samePlace(placeOfTask(task), place, directIds)) continue;
      seen.add(task.id);
      if (task.status === "running") running.push(task);
      else if (task.status === "needs_input") waiting.push(task);
    }
  }
  const byAge = (a: AsyncTask, b: AsyncTask) => a.created_at.localeCompare(b.created_at);
  return { running: running.sort(byAge), waiting: waiting.sort(byAge) };
}

async function runTasks(ctx: CommandContext): Promise<void> {
  const place: TaskPlace = ctx.topicId !== undefined ? { chatId: ctx.chatId, threadId: ctx.topicId } : { chatId: ctx.chatId };
  const directIds = ctx.services.directChatIds ? ctx.services.directChatIds() : directChatIds();
  let found: { running: AsyncTask[]; waiting: AsyncTask[] };
  try {
    found = await tasksOfPlace(ctx.services.tasks ? ctx.services.tasks() : defaultTasks(), place, directIds);
  } catch (e) {
    console.log(`[tasks] /tasks: Aufträge nicht lesbar (${e instanceof Error ? e.name : "Fehler"}, ${ctx.channel})`);
    await ctx.reply(TASKS_TEXT.unreadable);
    return;
  }
  await ctx.reply(formatTaskList(found.running, found.waiting, Date.now()));
}

export const TASKS_COMMAND: CommandDefinition = {
  name: "tasks",
  aliases: [],
  // Wie bisher in Telegram auch ohne Schrägstrich
  bareWords: ["tasks"],
  description: "Aufträge dieses Gesprächs: was läuft und was auf deine Antwort wartet",
  args: "none",
  channels: ALL_CHANNELS,
  whileBusy: true,
  run: runTasks,
};
