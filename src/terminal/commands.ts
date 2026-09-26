/**
 * Slash-Befehle von tybo (Issue #61, seit Issue #74 mit der gemeinsamen
 * Befehls-Schicht): Zerlegen der Eingabe, ohne Terminal und ohne Netz.
 *
 * Lokal bleiben nur, was das Terminal selbst betrifft (Entscheidung 0013):
 * /tasten (Tasten und Befehle), /gespraeche, /wechsel, /neu, /zuordnen,
 * /quit. Alles andere mit Schrägstrich geht als Nachricht an den Bot; der
 * Server führt bekannte Befehle aus wie in Telegram (/new, /stop, /agent,
 * /topics, /help …) und gibt unbekannte (/foo) als Text an Claude.
 * /stop, /abbruch, /goal pause und /goal stop (samt Aliasen) gehen auch
 * während einer laufenden Antwort und während Rückfragen ([INVOKE:]) raus.
 * Wer eine Nachricht mit einem lokalen Befehlsnamen beginnen will, schreibt
 * zwei Schrägstriche: aus „//wechsel" wird die Nachricht „/wechsel".
 *
 * Bedeutung wie in Telegram (Issue #74): /agent <name> zeigt die
 * Anweisungen des Agenten, /topics die Zuordnung Topic zu Agent. Den Agenten
 * eines Topics ändert hier /zuordnen <Agent> (früher /agent <Name>), die
 * Liste zum Wechseln zeigt /gespraeche (früher auch /topics).
 * Nummern bei /wechsel sind Listennummern aus der zuletzt gezeigten
 * /gespraeche-Liste, keine Telegram-Topic-IDs (dafür topic-<n>).
 */

import { BRAND } from "../brand";
import type { ConversationSummary } from "./api";
import { sanitizeLine } from "./sanitize";

export type Command =
  | { type: "keys" }
  | { type: "list" }
  | { type: "switch"; target: string }
  | { type: "create"; args: string }
  | { type: "assign"; agent: string }
  | { type: "quit" };

export type ParsedInput =
  /**
   * Nachricht an den Bot (bei // ohne den ersten Schrägstrich); beginnt sie
   * mit einem Befehl des Bots, führt ihn der Server aus. urgent: /stop oder
   * /goal pause|stop, geht auch während einer laufenden Antwort
   */
  | { kind: "message"; text: string; urgent?: boolean }
  | { kind: "command"; command: Command }
  /** Lokaler Befehl, aber falsch benutzt: Hinweis, nichts wird gesendet */
  | { kind: "invalid"; error: string };

/** Lokale Befehle, wie sie Tab ergänzt (ohne Schrägstrich) */
export const COMMAND_NAMES = ["tasten", "gespraeche", "wechsel", "neu", "zuordnen", "quit"] as const;

const ALIASES: Record<string, (typeof COMMAND_NAMES)[number]> = {
  gespräche: "gespraeche",
};

/** Befehle des Bots, die auch während einer Antwort gehen (wie whileBusy im Register) */
const URGENT = new Set(["stop", "abbruch"]);
/** /goal mit diesen Worten geht ebenfalls sofort raus (wie goalUnscoped im Register) */
const URGENT_GOAL = new Set(["pause", "stop", "cancel", "done", "abbrechen"]);

function isUrgent(raw: string, args: string): boolean {
  if (URGENT.has(raw)) return !args;
  return raw === "goal" && URGENT_GOAL.has(args.toLowerCase());
}

export const COMMAND_HELP = [
  "Befehle im Terminal:",
  "  /tasten                  diese Hilfe (Tasten und Terminal-Befehle)",
  "  /gespraeche              Gespräche mit Nummer, Agent, letzter Aktivität",
  "  /wechsel <Nr. oder Name> in ein anderes Gespräch; Nummer aus der letzten",
  "                           /gespraeche-Liste, auch topic-<n> oder dm",
  "  /neu [Agent] [Titel]     neues Topic in Telegram, ohne Agent: General",
  "  /zuordnen <Agent>        Agent dieses Topics ändern",
  `  /quit                    ${BRAND.name} beenden`,
  "Alle anderen Befehle führt der Bot aus wie in Telegram, z.B. /new, /stop,",
  "/agent, /topics, /help (Spickzettel). Unbekannte gehen als Text an den Bot.",
  "Eine Nachricht, die mit einem Befehl hier beginnen soll: zwei Schrägstriche",
  "(//wechsel).",
  "Rückfragen mit Knöpfen erscheinen nummeriert ([1] Erlauben  [2] Ablehnen).",
  "1 oder /1 wählt bei der zuletzt gezeigten offenen Rückfrage, auch während",
  "einer Antwort. Ohne offene Rückfrage ist 1 eine normale Nachricht; eine",
  "Freigabe lässt sich weiter auch mit „ja“ oder „nein“ beantworten.",
].join("\n");

/** Zerlegt eine Eingabe. Führender Leerraum zählt nicht, Groß- und Kleinschreibung beim Befehl auch nicht. */
export function parseInput(input: string): ParsedInput {
  const text = input.replace(/^[ \t]+/, "");
  if (!text.startsWith("/")) return { kind: "message", text: input };
  if (text.startsWith("//")) return { kind: "message", text: text.slice(1) };
  const match = /^\/(\S*)([\s\S]*)$/.exec(text)!;
  // /befehl@botname wie in Telegram-Gruppen
  const raw = match[1].replace(/@\S*$/, "").toLocaleLowerCase("de");
  const name = ALIASES[raw] ?? raw;
  const args = match[2].trim();
  const noArgs = (command: Command): ParsedInput =>
    args ? { kind: "invalid", error: `/${name} erwartet nichts dahinter.` } : { kind: "command", command };

  switch (name) {
    case "tasten":
      return noArgs({ type: "keys" });
    case "gespraeche":
      return noArgs({ type: "list" });
    case "wechsel":
      if (!args) return { kind: "invalid", error: "/wechsel braucht eine Nummer aus /gespraeche oder einen Namen." };
      return { kind: "command", command: { type: "switch", target: args } };
    case "neu":
      return { kind: "command", command: { type: "create", args } };
    case "zuordnen":
      if (!args || /\s/.test(args)) return { kind: "invalid", error: "/zuordnen braucht genau einen Agenten, z.B. /zuordnen research." };
      return { kind: "command", command: { type: "assign", agent: args.toLowerCase() } };
    case "quit":
      return noArgs({ type: "quit" });
    default:
      // Befehl des Bots oder unbekannt: der Server entscheidet
      return isUrgent(raw, args) ? { kind: "message", text: input, urgent: true } : { kind: "message", text: input };
  }
}

/**
 * Eingabe als Auswahl einer Rückfrage (Issue #120): eine bloße Zahl oder
 * /<zahl>, Leerraum drumherum egal. Ob sie wirklich wählt, entscheidet der
 * Aufrufer: nur, wenn im Gespräch eine Rückfrage offen ist. Sonst bleibt es
 * eine normale Nachricht; /wechsel <Nr.> ist davon nie betroffen. //1 ist
 * wie bei Befehlen die Nachricht „/1".
 */
export function parseChoiceNumber(input: string): number | null {
  const match = /^\s*\/?([0-9]{1,6})\s*$/.exec(input);
  return match ? Number(match[1]) : null;
}

/**
 * /neu [agent] [titel]: Ist das erste Wort ein Agent (Groß- und
 * Kleinschreibung egal), gilt es als Agent und der Rest als Titel. Sonst ist
 * alles der Titel und der Agent der Standard. Ein Titel, der mit einem
 * Agentennamen beginnt, braucht den Agenten davor (/neu general Research-Plan).
 */
export function splitAgentAndTitle(args: string, agents: readonly string[], defaultAgent: string): { agent: string; title?: string } {
  const trimmed = args.trim();
  if (!trimmed) return { agent: defaultAgent };
  const first = trimmed.split(/\s+/)[0];
  const lower = first.toLowerCase();
  if (agents.includes(lower)) {
    const title = trimmed.slice(first.length).trim();
    return title ? { agent: lower, title } : { agent: lower };
  }
  return { agent: defaultAgent, title: trimmed };
}

export type SwitchTarget = { ok: true; conversation: ConversationSummary } | { ok: false; error: string };

/**
 * Ziel von /wechsel. Eine bloße Zahl ist die Nummer aus der zuletzt gezeigten
 * /gespraeche-Liste (shown: IDs in Anzeigereihenfolge); so zeigt sie auch nach
 * neuer Aktivität noch auf dasselbe Gespräch. Ohne gezeigte Liste gilt eine
 * Zahl nicht, tybo rät nicht. Sonst wie --topic: dm, topic-<n>, ID eines
 * Web-Gesprächs oder genau der Name; mehrere gleichnamige sind ein Fehler.
 */
export function resolveSwitchTarget(list: ConversationSummary[], shown: readonly string[] | null, wanted: string): SwitchTarget {
  const value = wanted.trim();
  if (/^[0-9]+$/.test(value)) {
    if (!shown) return { ok: false, error: "Nummern gelten für die /gespraeche-Liste. Erst /gespraeche, dann /wechsel <Nr.>." };
    const n = Number(value);
    if (n < 1 || n > shown.length) return { ok: false, error: `Keine Nummer ${value} in der letzten Liste (1 bis ${shown.length}).` };
    const found = list.find(c => c.id === shown[n - 1]);
    if (!found) return { ok: false, error: `Gespräch Nr. ${value} gibt es nicht mehr. /gespraeche zeigt die aktuelle Liste.` };
    return { ok: true, conversation: found };
  }
  const lower = value.toLowerCase();
  const id = lower === "direktchat" ? "dm" : value;
  const exact = list.find(c => c.id === id) ?? list.find(c => c.id === lower);
  if (exact) return { ok: true, conversation: exact };
  const name = sanitizeLine(value).toLocaleLowerCase("de");
  const matches = list.filter(c => sanitizeLine(c.title).toLocaleLowerCase("de") === name);
  if (matches.length === 1) return { ok: true, conversation: matches[0] };
  const label = (c: ConversationSummary) => {
    const n = shown ? shown.indexOf(c.id) + 1 : 0;
    return n > 0 ? `Nr. ${n} (${c.id})` : c.id;
  };
  if (matches.length > 1) {
    return { ok: false, error: `Mehrere Gespräche heißen „${sanitizeLine(value)}": ${matches.map(label).join(", ")}. Mit Nummer oder ID wählen.` };
  }
  return { ok: false, error: `Kein Gespräch „${sanitizeLine(value)}". /gespraeche zeigt alle.` };
}

export interface CompletionSources {
  conversations: readonly string[];
  agents: readonly string[];
  /** Befehle des Bots aus GET /api/commands (Issue #74), ohne Schrägstrich */
  commands?: readonly string[];
}

export interface Completion {
  /** Neue Eingabe (gleich der alten, wenn nichts zu ergänzen war) */
  text: string;
  /** Mehrere Treffer: zur Auswahl zeigen */
  options: string[];
}

/** Längster gemeinsamer Anfang, Groß- und Kleinschreibung egal; Schreibweise vom ersten Treffer */
function commonPrefix(values: readonly string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0];
  for (const v of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < v.length && prefix[i].toLocaleLowerCase("de") === v[i].toLocaleLowerCase("de")) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

function completeFrom(head: string, partial: string, candidates: readonly string[], suffix: string): Completion | null {
  const lower = partial.toLocaleLowerCase("de");
  const matches = [...new Set(candidates)].filter(c => c.toLocaleLowerCase("de").startsWith(lower));
  if (matches.length === 0) return null;
  if (matches.length === 1) return { text: `${head}${matches[0]}${suffix}`, options: [] };
  const prefix = commonPrefix(matches);
  // Nichts Neues dazu: die getippte Schreibweise behalten
  const next = prefix.length > partial.length ? prefix : partial;
  return { text: `${head}${next}`, options: matches };
}

/**
 * Tab-Ergänzung (Issue #61) für die Eingabe bis zum Cursor am Ende:
 * Befehlsnamen (lokal und vom Bot), bei /wechsel Gesprächsnamen, bei
 * /agent, /zuordnen und /neu Agenten.
 * null: nichts zu ergänzen.
 */
export function completeInput(input: string, sources: CompletionSources): Completion | null {
  if (input.includes("\n")) return null;
  const command = /^(\s*\/)(\S*)$/.exec(input);
  if (command) {
    const names = [...COMMAND_NAMES.map(n => n as string), ...(sources.commands ?? [])];
    return completeFrom(command[1], command[2], names, " ");
  }
  const withArg = /^(\s*\/(\S+)\s+)([\s\S]*)$/.exec(input);
  if (!withArg) return null;
  const name = withArg[2].toLocaleLowerCase("de");
  const arg = withArg[3];
  if (name === "wechsel") return completeFrom(withArg[1], arg, sources.conversations, "");
  if (/\s/.test(arg)) return null;
  if (name === "agent" || name === "zuordnen") return completeFrom(withArg[1], arg, sources.agents, "");
  if (name === "neu") return completeFrom(withArg[1], arg, sources.agents, " ");
  return null;
}
