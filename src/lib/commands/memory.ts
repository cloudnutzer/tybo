/**
 * Textbefehle fürs Gedächtnis (Issue #333): Fakten merken und vergessen,
 * Ziele anlegen, erledigen und streichen, Fakten zeigen, im Verlauf suchen.
 * Sie laufen über die gemeinsame Befehls-Schicht in Telegram, Browser und
 * Terminal gleich; Telegram versteht zusätzlich die früheren Schreibweisen
 * ohne Schrägstrich („remember: …", „recall …", „memory").
 *
 * Gespeichert wird über CommandServices.memory (in src/bot.ts der
 * Gedächtnis-Dienst aus src/lib/memory/service.ts). Suchtexte treffen per
 * Teiltext den ersten passenden Eintrag; die Rückfrage bei mehreren Treffern
 * gibt es nur für Merk-Tags aus Antworten, nicht für diese Befehle.
 *
 * Browser und Terminal: Ein Stopp vor dem Schreiben verhindert die Änderung
 * (beginWrite wirft), danach gilt der Befehl als ausgeführt und seine
 * Antwort bleibt sichtbar.
 *
 * Die Ziele hier sind die gespeicherten Ziele (/goals), nicht /goal.
 *
 * Geheimnisse (Issue #524): /remember speichert keinen Wert, der nach Passwort
 * oder Schlüssel aussieht, und sagt, wo er hingehört. /memory zeigt Fakten maskiert.
 */

import { BRAND } from "../../brand";
import { containsSecret, maskSecrets, secretRefusedText } from "../memory/secrets";
import type { Message } from "../store/types";
import { chunkForTelegram, sanitizeModelOutput } from "../telegram";
import { ALL_CHANNELS, type CommandContext, type CommandDefinition, type MemoryCommandServices } from "./types";

export const MEMORY_COMMAND_TEXT = {
  unavailable: "Das Gedächtnis ist hier nicht eingerichtet.",
  failed: "Das hat nicht geklappt, gespeichert ist nichts. Bitte später nochmal versuchen.",
  remembered: "Gemerkt.",
  forgotten: "Erledigt, das habe ich vergessen.",
  noFact: (query: string) => `Kein gespeicherter Fakt passt zu „${query}".`,
  tracked: (goal: string, deadline?: string) => `Ziel notiert: „${goal}"${deadline ? ` (Frist: ${deadline})` : ""}.`,
  completed: "Ziel erledigt. Gut gemacht!",
  cancelled: "Ziel gestrichen.",
  noGoal: (query: string) => `Kein offenes Ziel passt zu „${query}".`,
  goalsUnreadable: "Die Ziele konnten gerade nicht gelesen werden. Bitte später nochmal versuchen.",
  factsTitle: "Gespeicherte Fakten:",
  noFacts: "Noch keine Fakten gespeichert. Merken: /remember <fakt>",
  noHits: (query: string) => `Nichts gefunden zu „${query}".`,
  hitsTitle: (query: string) => `Suchergebnisse zu „${query}":`,
  searchFailed: "Die Suche im Verlauf hat nicht geklappt. Bitte später nochmal versuchen.",
  you: "Du",
  unknownDate: "unbekannt",
  usage: {
    remember: "Nutzung: /remember <fakt>",
    forget: "Nutzung: /forget <teil des fakts>",
    track: "Nutzung: /track <ziel> oder /track <ziel> | deadline: <frist>",
    done: "Nutzung: /done <teil des ziels>",
    cancel: "Nutzung: /cancel <teil des ziels>",
    recall: "Nutzung: /recall <wonach suchen>",
  },
} as const;

/** So viele Treffer zeigt /recall, Ausschnitt je Treffer in Zeichen */
export const RECALL_LIMIT = 5;
const SNIPPET_CHARS = 200;

const TEXT = MEMORY_COMMAND_TEXT;

/** Gedächtnis des Gesprächs oder null mit Hinweis an den Nutzer */
async function memoryOf(ctx: CommandContext): Promise<MemoryCommandServices | null> {
  if (ctx.services.memory) return ctx.services.memory;
  await ctx.reply(TEXT.unavailable);
  return null;
}

/**
 * Gemeinsamer Ablauf der Schreibbefehle: ohne Text die Nutzung, sonst
 * Schreibbeginn melden, schreiben, Ergebnis als Antwort. Ein Fehler beim
 * Schreiben ergibt den Fehlertext, nie einen falschen Erfolg.
 */
async function write(
  ctx: CommandContext,
  usage: string,
  change: (memory: MemoryCommandServices, input: string) => Promise<string>
): Promise<void> {
  const input = ctx.args.trim();
  if (!input) return ctx.reply(usage);
  const memory = await memoryOf(ctx);
  if (!memory) return;
  ctx.beginWrite?.();
  let answer: string;
  try {
    answer = await change(memory, input);
  } catch (e) {
    console.log(`[gedaechtnis] /${ctx.name} fehlgeschlagen (${e instanceof Error ? e.name : typeof e}, ${ctx.channel})`);
    answer = TEXT.failed;
  }
  await ctx.reply(answer);
}

/**
 * Ziel und Frist aus „<ziel> | deadline: <frist>", wie früher in Telegram:
 * die Frist ist der Rest bis zum Ende und einzeilig. Ein leerer Fristmarker
 * („Wartung | deadline:") oder eine Frist mit Zeilenumbruch ist keine Frist,
 * dann ist der ganze Text das Ziel.
 */
export function splitGoalDeadline(input: string): { goal: string; deadline?: string } {
  const raw = input.trim();
  const match = raw.match(/\|\s*deadline:\s*(.+)$/i);
  if (!match) return { goal: raw };
  return { goal: raw.slice(0, match.index).trim(), deadline: match[1].trim() };
}

async function runRemember(ctx: CommandContext): Promise<void> {
  await write(ctx, TEXT.usage.remember, async (memory, fact) => {
    if (containsSecret(fact)) return secretRefusedText();
    return (await memory.addFact(fact)) ? TEXT.remembered : TEXT.failed;
  });
}

async function runForget(ctx: CommandContext): Promise<void> {
  await write(ctx, TEXT.usage.forget, async (memory, query) => ((await memory.deleteFact(query)) ? TEXT.forgotten : TEXT.noFact(query)));
}

async function runTrack(ctx: CommandContext): Promise<void> {
  if (!splitGoalDeadline(ctx.args).goal) return ctx.reply(TEXT.usage.track);
  await write(ctx, TEXT.usage.track, async (memory, input) => {
    const { goal, deadline } = splitGoalDeadline(input);
    return (await memory.addGoal(goal, deadline)) ? TEXT.tracked(goal, deadline) : TEXT.failed;
  });
}

async function runDone(ctx: CommandContext): Promise<void> {
  await write(ctx, TEXT.usage.done, async (memory, query) => ((await memory.completeGoal(query)) ? TEXT.completed : TEXT.noGoal(query)));
}

async function runCancel(ctx: CommandContext): Promise<void> {
  await write(ctx, TEXT.usage.cancel, async (memory, query) => ((await memory.cancelGoal(query)) ? TEXT.cancelled : TEXT.noGoal(query)));
}

/** Markdown-Antwort; Telegram nimmt höchstens 4096 Zeichen je Nachricht, geteilt an Zeilengrenzen */
async function replyLong(ctx: CommandContext, text: string): Promise<void> {
  const parts = ctx.channel === "telegram" ? chunkForTelegram(text) : [text];
  for (const part of parts) await ctx.reply(part, { format: "markdown", plainFallback: part.replace(/\*\*/g, "") });
}

async function runMemory(ctx: CommandContext): Promise<void> {
  const memory = await memoryOf(ctx);
  if (!memory) return;
  const facts = (await memory.facts()).filter(item => item.type === "fact");
  if (facts.length === 0) return ctx.reply(TEXT.noFacts);
  await replyLong(ctx, `**${TEXT.factsTitle}**\n${facts.map(fact => `- ${maskSecrets(fact.content)}`).join("\n")}`);
}

function hitDate(iso: string | undefined): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return TEXT.unknownDate;
  const timeZone = process.env.USER_TIMEZONE?.trim();
  try {
    return date.toLocaleDateString("de-DE", timeZone ? { timeZone } : {});
  } catch {
    return date.toLocaleDateString("de-DE");
  }
}

/** Ein Treffer als Zeile: bereinigt, dann auf SNIPPET_CHARS gekürzt (Issue #52) */
function hitLine(hit: Message, position: number): string {
  const clean = sanitizeModelOutput(hit.content);
  const snippet = clean.length > SNIPPET_CHARS ? `${clean.slice(0, SNIPPET_CHARS)}...` : clean;
  const speaker = hit.role === "user" ? TEXT.you : BRAND.name;
  return `${position}. [${hitDate(hit.created_at)}] ${speaker}: ${snippet}`;
}

async function runRecall(ctx: CommandContext): Promise<void> {
  const query = ctx.args.split(/\s+/).filter(Boolean).join(" ");
  if (!query) return ctx.reply(TEXT.usage.recall);
  const memory = await memoryOf(ctx);
  if (!memory) return;
  const stop = ctx.working();
  try {
    let hits: Message[];
    try {
      hits = await memory.searchMessages(ctx.chatId, query, RECALL_LIMIT);
    } catch (e) {
      console.log(`[gedaechtnis] /recall fehlgeschlagen (${e instanceof Error ? e.name : typeof e}, ${ctx.channel})`);
      return ctx.reply(TEXT.searchFailed);
    }
    if (hits.length === 0) return ctx.reply(TEXT.noHits(query));
    const lines = hits.slice(0, RECALL_LIMIT).map((hit, i) => hitLine(hit, i + 1));
    await replyLong(ctx, `**${TEXT.hitsTitle(query)}**\n\n${lines.join("\n\n")}`);
  } finally {
    stop();
  }
}

export const MEMORY_COMMANDS: readonly CommandDefinition[] = [
  {
    name: "remember",
    aliases: [],
    telegramPrefixes: ["remember:"],
    description: "Fakt dauerhaft merken",
    args: "optional",
    argsHint: "<fakt>",
    channels: ALL_CHANNELS,
    run: runRemember,
  },
  {
    name: "forget",
    aliases: [],
    telegramPrefixes: ["forget:"],
    description: "Gespeicherten Fakt vergessen, der den Text enthält",
    args: "optional",
    argsHint: "<text>",
    channels: ALL_CHANNELS,
    run: runForget,
  },
  {
    name: "memory",
    aliases: ["facts"],
    bareWords: ["memory", "facts"],
    description: "Alle gespeicherten Fakten",
    args: "none",
    channels: ALL_CHANNELS,
    run: runMemory,
  },
  {
    name: "track",
    aliases: [],
    telegramPrefixes: ["track:"],
    // Wie früher: ohne Zieltext vor der Frist („track: | deadline: morgen") an Claude
    acceptsPrefixArgs: args => splitGoalDeadline(args).goal !== "",
    description: "Ziel speichern, mit Frist: <ziel> | deadline: <frist>",
    args: "optional",
    argsHint: "<ziel> [| deadline: <frist>]",
    channels: ALL_CHANNELS,
    run: runTrack,
  },
  {
    name: "done",
    aliases: [],
    telegramPrefixes: ["done:"],
    description: "Gespeichertes Ziel als erledigt markieren",
    args: "optional",
    argsHint: "<text>",
    channels: ALL_CHANNELS,
    run: runDone,
  },
  {
    name: "cancel",
    aliases: [],
    telegramPrefixes: ["cancel:"],
    description: "Gespeichertes Ziel streichen",
    args: "optional",
    argsHint: "<text>",
    channels: ALL_CHANNELS,
    run: runCancel,
  },
  {
    name: "recall",
    aliases: ["search", "find"],
    telegramPrefixes: ["recall ", "search ", "find "],
    description: "Frühere Gespräche durchsuchen",
    args: "optional",
    argsHint: "<frage>",
    channels: ALL_CHANNELS,
    run: runRecall,
  },
];
