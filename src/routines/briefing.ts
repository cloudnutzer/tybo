/**
 * Morgenbriefing als Routine (Issue #363).
 *
 *   bun run briefing              einmal am Tag senden (Telegram und WebUI)
 *   bun run briefing --dry-run    nur zeigen, was gesendet würde
 *
 * Der Text entsteht ohne Modellaufruf: jede bereite Quelle aus
 * src/lib/sources/list.ts liefert ihren Abschnitt (Zeitlimit je Quelle aus
 * run.ts), diese Datei setzt daraus deterministisch ein deutsches Markdown
 * zusammen. Die Quellen selbst fragen ihre Dienste ab; die Nachrichtenquelle
 * (news.ts) nutzt dafür eine Suche bei xAI bzw. OpenRouter. Das ist ein
 * Abruf der Quelle wie jeder andere und gehört nicht zum Zusammenbau.
 *
 * Versand über den Kern der proaktiven Meldungen (src/lib/proactive,
 * Art briefing): Zeitfenster, Ruhezeit, Snooze und „höchstens einmal je
 * Ortstag" prüft der Kern, Tagesmarke gibt es nur bei Zustellung. Zugestellt
 * ist auch, was ohne Telegram nur für die WebUI festgehalten wurde.
 *
 * Abschnitte stehen in der Reihenfolge der Quellen-Liste. Eine nicht
 * eingerichtete Quelle fehlt still. Scheitert eine eingerichtete Quelle oder
 * läuft sie ins Zeitlimit, steht an ihrer Stelle ein Hinweis, das Briefing
 * geht trotzdem raus, und der Lauf endet mit Exit 1 (Entscheidung 0025,
 * „keine alten Daten"), damit der Wrapper den Fehler meldet.
 *
 * Exit-Code: 1 bei Fehler des Versands (siehe proactiveExitCode) oder einer
 * gescheiterten Quelle, sonst 0. Ein Überspringen nach den Regeln ist kein
 * Fehler. --dry-run sendet nichts, schreibt keinen Zustand, übernimmt keine
 * alten Dateien und reserviert nichts; der Exit-Code folgt nur den Quellen.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { proactiveExitCode, runProactive, type ProactiveDeps } from "../lib/proactive/deliver";
import { proactiveTimeZone } from "../lib/proactive/clock";
import { SOURCES } from "../lib/sources/list";
import { runSources, type RunOptions } from "../lib/sources/run";
import type { Env, Section, SectionItem, Source, SourceOutcome } from "../lib/sources/types";

/** Ein Abschnitt, wie er im Briefing steht */
export interface BriefingPart {
  id: string;
  /** Überschrift ohne Symbol und Anzahl */
  title: string;
  symbol: string;
  status: "ok" | "failed" | "timeout";
  /** Anzahl in der Überschrift; fehlt bei Abschnitten ohne Zählung und bei Fehlern */
  count?: number;
  /** Zeilen unter der Überschrift (bei Fehlern der Hinweis) */
  lines: string[];
}

export interface BriefingDraft {
  text: string;
  parts: BriefingPart[];
  /** Kennungen der eingerichteten Quellen, die nichts geliefert haben */
  failed: string[];
}

interface Look {
  title: string;
  symbol: string;
  counted: boolean;
  /** Zeile für einen leeren Abschnitt ohne Hinweis der Quelle */
  empty: string;
  /** Eigene Zeilen für Einträge; sonst plainLine */
  lines?: (section: Section, zone: string) => string[];
  count?: (section: Section) => number;
}

const timeOfDay = (iso: string | undefined, zone: string): string => {
  const at = new Date(iso ?? "");
  if (!Number.isFinite(at.getTime())) return "?";
  return at.toLocaleTimeString("de-DE", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
};

function eventLines(section: Section, zone: string): string[] {
  return section.items.map(item =>
    item.allDay ? `• ganztägig: ${item.text}` : `• ${timeOfDay(item.start, zone)} bis ${timeOfDay(item.end, zone)}: ${item.text}`,
  );
}

const unread = (section: Section) => section.total ?? section.items.length;

function mailLines(section: Section): string[] {
  const all = unread(section);
  if (section.items.length === 0) return [all === 1 ? "1 ungelesene Mail" : `${all} ungelesene Mails`];
  const lines = section.items.map(item => `• ${item.text}`);
  const rest = all - section.items.length;
  if (rest > 0) lines.push(`_und ${rest} weitere_`);
  return lines;
}

function taskLines(section: Section): string[] {
  return section.items.map(item => {
    const due = item.due ? ` (fällig ${item.due})` : "";
    return `• ${item.overdue ? "⚠️ überfällig: " : ""}${item.text}${due}`;
  });
}

function goalLines(section: Section): string[] {
  return section.items.map(item => `• ${item.text}${item.due ? ` (bis ${item.due})` : ""}`);
}

function plainLine(item: SectionItem): string {
  const due = item.due ? ` (${item.overdue ? "überfällig seit " : ""}${item.due})` : "";
  const link = item.link ? ` (${item.link})` : "";
  return `• ${item.text}${due}${link}`;
}

/** Aussehen der eingebauten Quellen, nach Kennung */
const LOOKS: Record<string, Look> = {
  calendar: { title: "Termine heute", symbol: "📅", counted: true, empty: "Keine Termine, der Tag ist frei", lines: eventLines },
  gmail: { title: "Ungelesene Mails", symbol: "📧", counted: true, empty: "Keine ungelesenen Mails", lines: mailLines, count: unread },
  "notion-tasks": { title: "Aufgaben", symbol: "✅", counted: true, empty: "Heute ist nichts fällig", lines: taskLines },
  news: { title: "KI-Nachrichten", symbol: "📰", counted: false, empty: "Keine belegten Nachrichten gefunden" },
  goals: { title: "Ziele", symbol: "🎯", counted: true, empty: "Keine offenen Ziele", lines: goalLines },
};

const lookFor = (source: Source): Look =>
  LOOKS[source.id] ?? { title: source.label, symbol: "🔌", counted: true, empty: "Nichts zu melden" };

function isEmpty(section: Section, look: Look): boolean {
  return section.items.length === 0 && (look.count ? look.count(section) : 0) === 0;
}

/** Ein Ausgang als Abschnitt; null für nicht eingerichtete Quellen */
export function briefingPart(outcome: SourceOutcome, zone: string): BriefingPart | null {
  const look = lookFor(outcome.source);
  const head = { id: outcome.source.id, title: look.title, symbol: look.symbol };
  switch (outcome.status) {
    case "skipped":
      return null;
    case "failed":
      return { ...head, status: "failed", lines: ["_⚠️ Konnte nicht abgerufen werden._"] };
    case "timeout":
      return { ...head, status: "timeout", lines: ["_⚠️ Hat zu lange gebraucht und fehlt deshalb._"] };
    case "ok": {
      const { section } = outcome;
      // Eingebaute Quellen bekommen nur die festen deutschen Zeilen; Hinweise eigener Quellen bleiben, wie sie sind
      const note = LOOKS[outcome.source.id] ? undefined : section.note;
      let lines: string[];
      if (isEmpty(section, look)) lines = [note ?? look.empty];
      else {
        lines = look.lines ? look.lines(section, zone) : section.items.map(plainLine);
        if (note) lines.push(`_${note}_`);
      }
      const part: BriefingPart = { ...head, status: "ok", lines };
      if (look.counted) part.count = look.count ? look.count(section) : section.items.length;
      return part;
    }
  }
}

function heading(part: BriefingPart): string {
  const count = part.count !== undefined ? ` (${part.count})` : "";
  return `${part.symbol} **${part.title}**${count}`;
}

function longDate(now: Date, zone: string): string {
  return now.toLocaleDateString("de-DE", { timeZone: zone, weekday: "long", day: "numeric", month: "long" });
}

/** Text aus den Ausgängen der Quellen; rein, ohne Uhr und Dateien */
export function renderBriefing(outcomes: readonly SourceOutcome[], at: { now: Date; zone: string; name?: string }): BriefingDraft {
  const parts = outcomes.map(o => briefingPart(o, at.zone)).filter((p): p is BriefingPart => p !== null);
  const greeting = at.name ? `☀️ **Guten Morgen, ${at.name}!**` : "☀️ **Guten Morgen!**";
  const blocks = [`${greeting}\n_${longDate(at.now, at.zone)}_`];
  if (parts.length === 0) blocks.push("_Keine Quelle eingerichtet._");
  for (const part of parts) blocks.push([heading(part), ...part.lines].join("\n"));
  blocks.push("_Antworte einfach, wenn du etwas davon besprechen willst._");
  const failed = parts.filter(p => p.status !== "ok").map(p => p.id);
  return { text: blocks.join("\n\n"), parts, failed };
}

/** Name für die Anrede: USER_NAME, sonst die erste Überschrift in config/profile.md */
export async function greetingName(env: Env, root: string): Promise<string | undefined> {
  const own = env.USER_NAME?.trim();
  if (own) return own;
  try {
    const profile = await readFile(join(root, "config", "profile.md"), "utf-8");
    return /^#[ \t]+(.+)$/m.exec(profile)?.[1].trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface DraftOptions extends RunOptions {
  sources?: readonly Source[];
  /** Name für die Anrede; ohne Angabe greetingName */
  name?: string;
  root?: string;
}

/** Fragt alle Quellen ab und setzt das Briefing zusammen; wirft nie wegen einer Quelle */
export async function draftBriefing(options: DraftOptions = {}): Promise<BriefingDraft> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const root = options.root ?? (env.GO_PROJECT_ROOT || process.cwd());
  const outcomes = await runSources(options.sources ?? SOURCES, { ...options, env, now });
  for (const o of outcomes) {
    // Ins Log kommen Quelle und Ausgang, nie der Inhalt
    if (o.status === "failed") console.error(`[briefing] Quelle ${o.source.id} gescheitert: ${o.error}`);
    else if (o.status === "timeout") console.error(`[briefing] Quelle ${o.source.id} im Zeitlimit (${o.ms} ms)`);
    else if (o.status === "ok") console.log(`[briefing] Quelle ${o.source.id}: ok, ${o.section.items.length} Einträge, ${o.ms} ms`);
  }
  const name = options.name ?? (await greetingName(env, root));
  return renderBriefing(outcomes, { now, zone: proactiveTimeZone(env), name });
}

export interface BriefingRunDeps extends ProactiveDeps {
  sources?: readonly Source[];
  fetch?: typeof fetch;
  name?: string;
  /** Vorschau statt Versand */
  dryRun?: boolean;
  /** Ausgabe der Vorschau; Standard stdout */
  print?: (text: string) => void;
  /** Wartezeit vor dem Lauf (nach dem Aufwachen ist das Netz oft noch nicht da) */
  wait?: () => Promise<void>;
}

/** Bis zu 30 Sekunden warten, damit nach dem Aufwachen nicht alles gleichzeitig startet */
export const settleAfterWake = (): Promise<void> => new Promise(r => setTimeout(r, Math.floor(Math.random() * 30_000)));

/** Ein Lauf der Routine; Ergebnis ist der Exit-Code */
export async function runBriefing(deps: BriefingRunDeps = {}): Promise<0 | 1> {
  const env = deps.env ?? process.env;
  const draft = (now: Date) =>
    draftBriefing({ sources: deps.sources, env, now, fetch: deps.fetch, name: deps.name });

  if (deps.dryRun) {
    const preview = await draft(deps.now?.() ?? new Date());
    (deps.print ?? (t => console.log(t)))(preview.text);
    return preview.failed.length > 0 ? 1 : 0;
  }

  await (deps.wait ?? settleAfterWake)();
  let failedSources: string[] = [];
  const outcome = await runProactive(
    "briefing",
    async ({ now }) => {
      const built = await draft(now);
      failedSources = built.failed;
      return { text: built.text };
    },
    deps,
  );
  const detail = outcome.status === "sent" ? "" : ` (${outcome.reason})`;
  const line = `[briefing] ${outcome.status}${detail}`;
  if (outcome.status === "failed") console.error(line);
  else console.log(line);

  if (proactiveExitCode(outcome) === 1) return 1;
  if (outcome.status === "sent" && failedSources.length > 0) {
    console.error(`[briefing] gesendet, aber ohne ${failedSources.join(", ")}`);
    return 1;
  }
  return 0;
}

/** Erlaubt ist nur --dry-run; sonst null */
export function parseBriefingArgs(args: readonly string[]): { dryRun: boolean } | null {
  if (args.some(a => a !== "--dry-run")) return null;
  return { dryRun: args.includes("--dry-run") };
}

async function main(): Promise<number> {
  const parsed = parseBriefingArgs(process.argv.slice(2));
  if (!parsed) {
    console.error("Aufruf: bun run briefing [--dry-run]");
    return 2;
  }
  // Erst hier: der Import allein liest keine .env
  const { loadEnv } = await import("../lib/env");
  await loadEnv();
  return runBriefing({ dryRun: parsed.dryRun });
}

if (import.meta.main) {
  main().then(
    code => process.exit(code),
    error => {
      console.error(`[briefing] abgebrochen (${error instanceof Error ? error.name : "Fehler"})`);
      process.exit(1);
    },
  );
}
