/**
 * /kern (Issue #522): zeigt und ändert den festen Kern in Telegram, Browser und
 * Terminal gleich. Der Text kommt wörtlich vom Nutzer (/kern setzen) oder aus
 * einem Entwurf, den er per Knopf übernimmt (src/lib/memory/core-choices.ts).
 * Antworten sind Klartext, damit eigener Text nie am Markdown scheitert.
 */
import { isAbortError } from "../execution-context";
import { CORE_MAX_CHARS, CORE_TARGET_CHARS, deleteCore, readCore, setCore } from "../memory/core";
import { retireCoreDrafts, type OfferDraftOutcome } from "../memory/core-choices";
import { maskSecrets, secretRefusedText } from "../memory/secrets";
import { chunkForTelegram } from "../telegram";
import { threadConversation } from "../threads/detect";
import { ALL_CHANNELS, type CommandContext, type CommandDefinition } from "./types";
import { formatSwitchTime } from "../engine-switch-text";

const APPLIES = "Gilt ab der nächsten frischen Session, /new erzwingt es hier sofort.";

export const CORE_COMMAND_TEXT = {
  usage: "Nutzung: /kern · /kern entwurf · /kern setzen <text> · /kern loeschen",
  none: `Noch kein Kern. Er steht bei jedem Start einer Session im Prompt, etwa ${CORE_TARGET_CHARS} Zeichen: wer du bist, wie du arbeitest, woran du hauptsächlich arbeitest.\n\n/kern entwurf legt dir einen Entwurf aus den Fakten vor, /kern setzen <text> nimmt deinen eigenen.`,
  current: (chars: number) => `Dein Kern (${chars} Zeichen, Ziel etwa ${CORE_TARGET_CHARS}):`,
  tooLongInFile: (chars: number) => `Achtung: ${chars} Zeichen sind mehr als die Grenze von ${CORE_MAX_CHARS}, in den Prompt kommt nur der Anfang.`,
  change: "Ändern: /kern setzen <text> · /kern entwurf · /kern loeschen",
  unreadable: "config/kern.md ist nicht lesbar, nichts geändert. Bitte die Datei prüfen.",
  saved: (chars: number) => `Kern gespeichert (${chars} Zeichen). ${APPLIES}`,
  unchanged: "Der Kern lautet schon so, nichts geändert.",
  tooLong: (chars: number) => `Das sind ${chars} Zeichen, die Grenze ist ${CORE_MAX_CHARS} (Ziel etwa ${CORE_TARGET_CHARS}). Nichts geändert, bitte kürzen.`,
  deleted: `Kern gelöscht, die letzte Fassung liegt in config/kern.md.vorher. ${APPLIES}`,
  noneToDelete: "Es gibt keinen Kern, nichts geändert.",
  failed: "Das hat nicht geklappt, der Kern bleibt, wie er ist. Bitte später nochmal versuchen.",
  draftUnavailable: "Entwürfe gibt es hier nicht, weil die Rückfragen fehlen. /kern setzen <text> geht trotzdem.",
  noConversation: "In diesem Gespräch lässt sich keine Rückfrage zeigen, nichts geändert.",
  working: "Ich fasse die Fakten zu einem Entwurf zusammen, das kann ein paar Minuten dauern...",
  blocked: (until: string) => `Kein Entwurf: Claude Code ist bis ${until} am Limit. Abhilfe: ein anderes Nebenmodell für das Destillat einstellen (WebUI, Modelle) oder nach dem Reset /kern entwurf erneut senden. Nichts geändert.`,
  draft: {
    offered: "Der Entwurf steht zur Entscheidung bereit, übernommen ist noch nichts.",
    no_facts: "Es gibt noch keine Fakten für einen Entwurf. /kern setzen <text> nimmt deinen eigenen Text.",
    facts_unreadable: "Die Fakten sind gerade nicht lesbar, also gibt es keinen Entwurf. Nichts geändert.",
    core_unreadable: "config/kern.md ist nicht lesbar, also gibt es keinen Entwurf. Nichts geändert.",
    model_failed: "Das Modell für den Entwurf hat nichts Brauchbares geliefert. Nichts geändert.",
    not_delivered: "Der Entwurf ließ sich nicht zustellen. Nichts geändert.",
  } satisfies Record<Extract<OfferDraftOutcome, string>, string>,
} as const;

const TEXT = CORE_COMMAND_TEXT;

async function replyLong(ctx: CommandContext, text: string): Promise<void> {
  const parts = ctx.channel === "telegram" ? chunkForTelegram(text) : [text];
  for (const part of parts) await ctx.reply(part);
}

async function show(ctx: CommandContext): Promise<void> {
  const read = await readCore();
  if (!read.ok) return ctx.reply(TEXT.unreadable);
  if (!read.text) return ctx.reply(TEXT.none);
  const warning = read.text.length > CORE_MAX_CHARS ? `\n\n${TEXT.tooLongInFile(read.text.length)}` : "";
  await replyLong(ctx, `${TEXT.current(read.text.length)}\n\n${maskSecrets(read.text)}${warning}\n\n${TEXT.change}`);
}

async function change(ctx: CommandContext, work: () => Promise<string>): Promise<void> {
  ctx.beginWrite?.();
  let answer: string;
  try {
    answer = await work();
  } catch (e) {
    console.log(`[kern] /kern fehlgeschlagen (${e instanceof Error ? e.name : typeof e}, ${ctx.channel})`);
    answer = TEXT.failed;
  }
  await ctx.reply(answer);
}

async function set(ctx: CommandContext, text: string): Promise<void> {
  await change(ctx, async () => {
    const outcome = await setCore(text);
    if (outcome === "too_long") return TEXT.tooLong(text.trim().length);
    if (outcome === "secret") return secretRefusedText();
    if (outcome === "unreadable") return TEXT.unreadable;
    if (outcome === "unchanged") return TEXT.unchanged;
    if (outcome === "empty") return TEXT.usage;
    await retireCoreDrafts();
    const read = await readCore();
    return TEXT.saved(read.ok ? read.text.length : text.trim().length);
  });
}

async function remove(ctx: CommandContext): Promise<void> {
  await change(ctx, async () => {
    const outcome = await deleteCore();
    if (outcome === "unreadable") return TEXT.unreadable;
    if (outcome === "none") return TEXT.noneToDelete;
    await retireCoreDrafts();
    return TEXT.deleted;
  });
}

async function draft(ctx: CommandContext): Promise<void> {
  const core = ctx.services.core;
  if (!core) return ctx.reply(TEXT.draftUnavailable);
  const conversation = threadConversation(ctx.chatId, ctx.topicId);
  if (!conversation) return ctx.reply(TEXT.noConversation);
  await ctx.notice(TEXT.working);
  const stop = ctx.working();
  try {
    const outcome = await core.offerDraft(conversation);
    await ctx.reply(typeof outcome === "string" ? TEXT.draft[outcome]
      : TEXT.blocked(formatSwitchTime(outcome.blockedUntil, process.env.USER_TIMEZONE || "UTC")));
  } catch (e) {
    if (isAbortError(e)) throw e;
    console.log(`[kern] /kern entwurf fehlgeschlagen (${e instanceof Error ? e.name : typeof e}, ${ctx.channel})`);
    await ctx.reply(TEXT.failed);
  } finally {
    stop();
  }
}

async function runCore(ctx: CommandContext): Promise<void> {
  const args = ctx.args.trim();
  if (!args) return show(ctx);
  if (/^entwurf$/i.test(args)) return draft(ctx);
  if (/^l(?:oe|ö)schen$/i.test(args)) return remove(ctx);
  const setting = /^(?:setzen|aendern|ändern)\s+([\s\S]+)$/i.exec(args);
  if (setting) return set(ctx, setting[1]);
  await ctx.reply(TEXT.usage);
}

export const CORE_COMMAND: CommandDefinition = {
  name: "kern",
  aliases: ["core"],
  description: "Fester Kern im Prompt: zeigen, Entwurf aus den Fakten, ändern, löschen",
  args: "optional",
  argsHint: "[entwurf | setzen <text> | loeschen]",
  channels: ALL_CHANNELS,
  run: runCore,
};
