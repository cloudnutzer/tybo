/**
 * /sprachagent (Issue #492, Entscheidung 0026): Sprachagenten aus Rezepten
 * bedienen, in Telegram, Browser und Terminal: liste, testen, loeschen, link
 * und (Issue #493) neu und aendern, die einen Entwurf per Hintergrund-Job
 * anstoßen. Beschreibung und Wunsch sind der ganze Rest der Zeile, auch über
 * mehrere Wörter und Zeilen.
 *
 * /sprachagenten ist ein eigener Befehl und kein Alias: ctx.name trägt immer
 * den kanonischen Namen, und ohne Argument zeigt /sprachagenten die Liste,
 * /sprachagent die Hilfe.
 *
 * Die Arbeit machen die Dienste services.voiceAgents
 * (src/lib/voice-agents/manage.ts) und services.voiceDrafts
 * (src/lib/voice-agents/drafts.ts), die der Bot verdrahtet; fehlen sie
 * (web:dev, Demo), sagt der Befehl das.
 */

import { chunkForTelegram } from "../telegram";
import { threadConversation } from "../threads/detect";
import type { StartDraftOutcome } from "../voice-agents/drafts";
import { passedSummary, type VoiceAgentEntry, type VoiceAgentOverview } from "../voice-agents/manage";
import { ALL_CHANNELS, type CommandContext, type CommandDefinition } from "./types";

export const VOICE_AGENT_COMMAND_TEXT = {
  help: [
    "🎙️ Sprachagenten aus Rezepten (config/voice-agents/):",
    "/sprachagent liste - alle mit Vorlage, Gehirn, Zugang, letztem Test und Minuten (auch /sprachagenten)",
    "/sprachagent testen <kennung> - Testlauf beim Anbieter, das Ergebnis kommt hierher",
    "/sprachagent loeschen <kennung> - mit Rückfrage: Agent und Tests beim Anbieter löschen, Rezept ins Archiv",
    "/sprachagent link <kennung> - Web-Link zum Gespräch im Browser",
    "/sprachagent neu <beschreibung> - Entwurf per Hintergrund-Job, danach Freigabe mit Knöpfen",
    "/sprachagent aendern <kennung> <wunsch> - Änderung als Entwurf, die Freigabe zeigt die geänderten Felder",
  ].join("\n"),
  unavailable: "Sprachagenten gibt es in diesem Prozess nicht.",
  needKennung: (sub: string) => `Welcher Sprachagent? /sprachagent ${sub} <kennung>`,
  unknown: (kennung: string) => `Einen Sprachagenten ${kennung} gibt es nicht. Alle zeigt /sprachagent liste.`,
  empty: "Noch keine Sprachagenten. Ein Rezept ist eine Datei config/voice-agents/<kennung>.json, Beispiele in config/voice-agents.example/. Anleitung: docs/sprechen.md.",
  noConversation: "In diesem Gespräch lässt sich keine Rückfrage und keine Meldung zeigen, nichts geändert.",
  noProvider: "Der Anbieter ist nicht eingerichtet: ELEVENLABS_API_KEY fehlt in .env. Anleitung: docs/sprechen.md.",
  testStarted: (name: string) => `🧪 Testlauf für ${name} gestartet. Das Ergebnis kommt hierher, das dauert meist ein paar Minuten (höchstens 15).`,
  testRunning: (name: string, since: string) => `Für ${name} läuft schon ein Testlauf (seit ${since}). Das Ergebnis kommt hierher.`,
  notDeployed: (name: string) => `${name} ist beim Anbieter noch nicht angelegt, es gibt nichts zu testen.`,
  testFailed: (name: string, fehler: string) => `Der Testlauf für ${name} ließ sich nicht starten: ${fehler}`,
  deleteAsked: (name: string) => `Rückfrage zum Löschen von ${name} steht oben.`,
  deleteNotDelivered: "Die Rückfrage ließ sich nicht zustellen, nichts gelöscht.",
  noWeb: (name: string) => `${name} hat keinen Web-Zugang (zugang.web.link ist aus).`,
  link: (name: string, url: string) => `🔗 Gespräch mit ${name} im Browser, nur nach Anmeldung in der WebUI:\n${url}`,
  linkBroken: (name: string) => `Das Rezept von ${name} ist beschädigt, es gibt keinen Link.`,
  linkLocked: (name: string) =>
    `${name} ist nicht freigeschaltet: kein Link, bis die Tests der aktuellen Fassung bestehen oder du ihn trotzdem freischaltest (/sprachagent testen).`,
  noWebUi: (name: string) => `Für ${name} gibt es keinen Link: Die WebUI ist aus (WEB_ENABLED).`,
  failed: "Das hat nicht geklappt, Details im Log.",
  draftsUnavailable: "Entwürfe für Sprachagenten gibt es in diesem Prozess nicht.",
  needDescription: "Was soll der Sprachagent tun? /sprachagent neu <beschreibung>",
  needWish: (kennung: string) => `Was soll sich ändern? /sprachagent aendern ${kennung} <wunsch>`,
  draftStarted: (art: "neu" | "aendern", kennung?: string) =>
    art === "neu"
      ? "✍️ Entwurf läuft als Hintergrund-Job: Rezept, Tests und bei Experten die Recherche. Das dauert meist einige Minuten; danach kommen Stimmwahl und Freigabe hierher. Angelegt wird erst nach deinem Klick."
      : `✍️ Änderung an ${kennung} läuft als Hintergrund-Job. Danach kommt die Freigabe mit den geänderten Feldern hierher.`,
  draftTooLong: "Die Beschreibung ist zu lang, höchstens 2.000 Zeichen.",
  draftTooMany: "Es laufen schon drei Entwürfe. Bitte warten, bis einer fertig ist.",
  draftBroken: (kennung: string, fehler: string) => `Das Rezept von ${kennung} ist beschädigt, nichts gestartet: ${fehler}`,
  draftFailed: (fehler: string) => `Der Entwurf ließ sich nicht starten: ${fehler}`,
  draftOpen: (kennung: string) => `Für ${kennung} ist schon ein Entwurf offen. Erst freigeben oder verwerfen, dann neu ändern.`,
} as const;

const TEXT = VOICE_AGENT_COMMAND_TEXT;

const BRAIN: Record<VoiceAgentEntry["gehirn"]["art"], string> = { anbieter: "Anbieter", bruecke: "Brücke" };

/** Zeitpunkt kurz, in der Zeitzone des Prozesses */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("de-DE", { day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function accessLine(entry: VoiceAgentEntry): string {
  const parts: string[] = [];
  if (entry.web) parts.push("Web-Link");
  // Die Nummer im Rezept ist die Kennung beim Anbieter, keine Rufnummer
  if (entry.telefon) parts.push(`Telefon (Nummer beim Anbieter: ${entry.telefon.nummer}, Anrufer: ${entry.telefon.anrufer})`);
  return `Zugang: ${parts.length > 0 ? parts.join(", ") : "keiner"}`;
}

function testLine(entry: VoiceAgentEntry): string {
  const run = entry.letzterTest;
  let last: string;
  if (!run) last = "noch keiner";
  else if (run.ergebnis === "fehler") last = `Abfrage gescheitert (${formatWhen(run.beendetAm)})`;
  else if (run.ergebnis === "zeitueberschreitung") last = `kein Ergebnis in der Frist, ${passedSummary(run)} bis dahin (${formatWhen(run.beendetAm)})`;
  else last = `${passedSummary(run)}${run.ergebnis === "abgebrochen" ? ", abgebrochen" : ""} (${formatWhen(run.beendetAm)})`;
  const running = entry.laufenderTest;
  const now = running
    ? running.verfolgt
      ? `; läuft gerade seit ${formatWhen(running.gestartetAm)}`
      : `; Lauf vom ${formatWhen(running.gestartetAm)} nicht abgeholt (Bot neu gestartet)`
    : "";
  return `Letzter Testlauf: ${last}${now}`;
}

export function formatVoiceAgentOverview(overview: VoiceAgentOverview): string {
  if (overview.agents.length === 0 && overview.fehler.length === 0) return TEXT.empty;
  const blocks = overview.agents.map((entry) =>
    [
      `${entry.name} (${entry.kennung})`,
      `Vorlage: ${entry.vorlage} · Gehirn: ${BRAIN[entry.gehirn.art]}, ${entry.gehirn.modell} · Gedächtnis: ${entry.gedaechtnis}`,
      accessLine(entry),
      `Beim Anbieter: ${entry.angelegt ? "angelegt" : "noch nicht angelegt"}`,
      testLine(entry),
      // Verbrauch erfasst tybo noch nicht: unbekannt, nie 0
      entry.minuten.verbraucht === null
        ? `Minuten im Monat: Verbrauch unbekannt, Limit ${entry.minuten.limit}`
        : `Minuten im Monat: ${entry.minuten.verbraucht} von ${entry.minuten.limit}`,
      ...(entry.problem ? [`⚠️ ${entry.problem}`] : []),
    ].join("\n"),
  );
  const broken = overview.fehler.map((f) => `⚠️ ${f.datei}: ${f.fehler.join("; ")}`);
  return [`🎙️ Sprachagenten (${overview.agents.length})`, ...blocks, ...(broken.length > 0 ? [`Rezepte mit Fehlern (gelten nicht als Agenten):\n${broken.join("\n")}`] : [])].join("\n\n");
}

async function list(ctx: CommandContext): Promise<void> {
  const text = formatVoiceAgentOverview(await ctx.services.voiceAgents!.overview());
  for (const part of ctx.channel === "telegram" ? chunkForTelegram(text) : [text]) await ctx.reply(part);
}

async function test(ctx: CommandContext, kennung: string): Promise<void> {
  const service = ctx.services.voiceAgents!;
  const conversation = threadConversation(ctx.chatId, ctx.topicId);
  if (!conversation) return ctx.reply(TEXT.noConversation);
  const outcome = await service.startTest(kennung, conversation);
  switch (outcome.status) {
    case "gestartet":
      return ctx.reply(TEXT.testStarted(outcome.name));
    case "unbekannt":
      return ctx.reply(TEXT.unknown(kennung));
    case "kein_anbieter":
      return ctx.reply(TEXT.noProvider);
    case "nicht_angelegt":
      return ctx.reply(TEXT.notDeployed(outcome.name));
    case "laeuft":
      return ctx.reply(TEXT.testRunning(outcome.name, formatWhen(outcome.seit)));
    case "fehler":
      return ctx.reply(TEXT.testFailed(outcome.name, outcome.fehler));
  }
}

async function remove(ctx: CommandContext, kennung: string): Promise<void> {
  const service = ctx.services.voiceAgents!;
  const conversation = threadConversation(ctx.chatId, ctx.topicId);
  if (!conversation) return ctx.reply(TEXT.noConversation);
  const outcome = await service.offerDelete(kennung, conversation);
  if (outcome.status === "unbekannt") return ctx.reply(TEXT.unknown(kennung));
  if (outcome.status === "nicht_zugestellt") return ctx.reply(TEXT.deleteNotDelivered);
  await ctx.reply(TEXT.deleteAsked(outcome.name));
}

async function link(ctx: CommandContext, kennung: string): Promise<void> {
  const outcome = await ctx.services.voiceAgents!.link(kennung);
  if (outcome.status === "unbekannt") return ctx.reply(TEXT.unknown(kennung));
  switch (outcome.status) {
    case "kein_web":
      return ctx.reply(TEXT.noWeb(outcome.name));
    case "kaputt":
      return ctx.reply(TEXT.linkBroken(outcome.name));
    case "gesperrt":
      return ctx.reply(TEXT.linkLocked(outcome.name));
    case "keine_webui":
      return ctx.reply(TEXT.noWebUi(outcome.name));
    case "link":
      return ctx.reply(TEXT.link(outcome.name, outcome.url));
  }
}

const SUBCOMMANDS: Record<string, (ctx: CommandContext, kennung: string) => Promise<void>> = {
  testen: test,
  loeschen: remove,
  löschen: remove,
  link,
};

function draftReply(ctx: CommandContext, outcome: StartDraftOutcome, art: "neu" | "aendern", kennung?: string): Promise<void> {
  switch (outcome.status) {
    case "gestartet":
      return ctx.reply(TEXT.draftStarted(art, kennung));
    case "leer":
      return ctx.reply(art === "neu" ? TEXT.needDescription : TEXT.needWish(kennung ?? "<kennung>"));
    case "zu_lang":
      return ctx.reply(TEXT.draftTooLong);
    case "unbekannt":
      return ctx.reply(TEXT.unknown(kennung ?? ""));
    case "kaputt":
      return ctx.reply(TEXT.draftBroken(kennung ?? "", outcome.fehler));
    case "zu_viele":
      return ctx.reply(TEXT.draftTooMany);
    case "offen":
      return ctx.reply(TEXT.draftOpen(kennung ?? ""));
    case "fehler":
      return ctx.reply(TEXT.draftFailed(outcome.fehler));
  }
}

/** neu <beschreibung> und aendern <kennung> <wunsch>: der Rest der Zeile zählt ganz */
async function draft(ctx: CommandContext, sub: "neu" | "aendern", rest: string): Promise<void> {
  const service = ctx.services.voiceDrafts;
  if (!service) return ctx.reply(TEXT.draftsUnavailable);
  const conversation = threadConversation(ctx.chatId, ctx.topicId);
  if (sub === "neu") {
    if (!rest) return ctx.reply(TEXT.needDescription);
    if (!conversation) return ctx.reply(TEXT.noConversation);
    return draftReply(ctx, await service.startNew(rest, conversation), "neu");
  }
  const [, rawKennung = "", wish = ""] = /^(\S*)\s*([\s\S]*)$/.exec(rest) ?? [];
  if (!rawKennung) return ctx.reply(TEXT.needKennung("aendern"));
  const kennung = rawKennung.toLowerCase();
  if (!wish.trim()) return ctx.reply(TEXT.needWish(kennung));
  if (!conversation) return ctx.reply(TEXT.noConversation);
  return draftReply(ctx, await service.startChange(kennung, wish, conversation), "aendern", kennung);
}

async function runDraft(ctx: CommandContext, sub: "neu" | "aendern", rest: string): Promise<void> {
  try {
    await draft(ctx, sub, rest);
  } catch (e) {
    console.log(`[sprachagent] /${ctx.name} ${sub} fehlgeschlagen (${e instanceof Error ? e.name : typeof e}, ${ctx.channel})`);
    await ctx.reply(TEXT.failed);
  }
}

/** emptyMeansList: /sprachagenten ohne Argument zeigt die Liste, /sprachagent die Hilfe */
async function dispatch(ctx: CommandContext, emptyMeansList: boolean): Promise<void> {
  const multi = /^(neu|aendern|ändern)(?:\s+([\s\S]*))?$/i.exec(ctx.args.trim());
  if (multi) return runDraft(ctx, multi[1].toLowerCase() === "neu" ? "neu" : "aendern", (multi[2] ?? "").trim());
  const [rawSub = "", rawKennung = "", ...rest] = ctx.args.trim().split(/\s+/).filter(Boolean);
  const sub = rawSub.toLowerCase();
  if (!sub) return emptyMeansList ? runWith(ctx, list) : ctx.reply(TEXT.help);
  if (sub === "liste" || sub === "list") return runWith(ctx, list);
  const action = SUBCOMMANDS[sub];
  if (!action || rest.length > 0) return ctx.reply(TEXT.help);
  if (!rawKennung) return ctx.reply(TEXT.needKennung(sub === "löschen" ? "loeschen" : sub));
  return runWith(ctx, (c) => action(c, rawKennung.toLowerCase()));
}

async function runWith(ctx: CommandContext, work: (ctx: CommandContext) => Promise<void>): Promise<void> {
  if (!ctx.services.voiceAgents) return ctx.reply(TEXT.unavailable);
  try {
    await work(ctx);
  } catch (e) {
    console.log(`[sprachagent] /${ctx.name} fehlgeschlagen (${e instanceof Error ? e.name : typeof e}, ${ctx.channel})`);
    await ctx.reply(TEXT.failed);
  }
}

export const VOICE_AGENT_COMMAND: CommandDefinition = {
  name: "sprachagent",
  aliases: [],
  description: "Sprachagenten: liste, testen, loeschen, link, neu, aendern",
  args: "optional",
  argsHint: "[liste | testen <kennung> | loeschen <kennung> | link <kennung> | neu <beschreibung> | aendern <kennung> <wunsch>]",
  channels: ALL_CHANNELS,
  run: (ctx) => dispatch(ctx, false),
};

export const VOICE_AGENTS_LIST_COMMAND: CommandDefinition = {
  name: "sprachagenten",
  aliases: [],
  description: "Alle Sprachagenten (wie /sprachagent liste)",
  args: "optional",
  argsHint: "[testen <kennung> | loeschen <kennung> | link <kennung> | neu <beschreibung> | aendern <kennung> <wunsch>]",
  channels: ALL_CHANNELS,
  run: (ctx) => dispatch(ctx, true),
};
