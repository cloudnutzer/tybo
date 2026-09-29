/**
 * Bausteine der Terminal-Anzeige von tybo (Issue #60): Kopfzeile,
 * Nachrichten und Text der Statuszeile. Reine Funktionen ohne Terminal,
 * alle Texte vom Server laufen durch sanitizeTerminal/sanitizeLine.
 */

import { BRAND } from "../brand";
import { agentLabel } from "../web/agents";
import { stripControlTags } from "../web/markdown";
import type { ChoiceVia } from "../web/choices";
import { toChoice, type ApiChoice, type ConversationSummary, type Message } from "./api";
import { COMMAND_HELP } from "./commands";
import { displayWidth, renderTerminalMarkdown, type Style } from "./render";
import { sanitizeLine, sanitizeTerminal } from "./sanitize";

/** So viele Nachrichten zeigt tybo beim Öffnen eines Gesprächs */
export const HISTORY_LINES = 20;

/** Werkzeugnamen aus den Live-Ereignissen als kurze Tätigkeit */
const TOOL_ACTIVITY: Record<string, string> = {
  Read: "Liest eine Datei",
  "Reading file": "Liest eine Datei",
  Write: "Schreibt eine Datei",
  "Writing file": "Schreibt eine Datei",
  Edit: "Bearbeitet eine Datei",
  "Editing file": "Bearbeitet eine Datei",
  Glob: "Sucht Dateien",
  "Searching files": "Sucht Dateien",
  Grep: "Durchsucht den Code",
  "Searching code": "Durchsucht den Code",
  Bash: "Führt einen Befehl aus",
  "Running command": "Führt einen Befehl aus",
  WebSearch: "Durchsucht das Web",
  "Searching the web": "Durchsucht das Web",
  WebFetch: "Ruft eine Seite ab",
  "Fetching page": "Ruft eine Seite ab",
  Task: "Gibt eine Aufgabe weiter",
  "Delegating task": "Gibt eine Aufgabe weiter",
  AskUserQuestion: "Stellt eine Rückfrage",
  "Asking a question": "Stellt eine Rückfrage",
};

/** Text der Statuszeile zu einem progress-Ereignis ({ kind, text }) */
export function progressLabel(kind: unknown, text: unknown): string {
  if (kind === "snippet") return "Formuliert die Antwort …";
  const raw = sanitizeLine(text);
  if (TOOL_ACTIVITY[raw]) return `${TOOL_ACTIVITY[raw]} …`;
  if (raw.startsWith("mcp__")) return `Nutzt ${(raw.split("__")[1] || "MCP").replace(/[-_]/g, " ")} …`;
  if (raw.startsWith("Using ")) return `Nutzt ${raw.slice(6)} …`;
  return raw ? `${raw} …` : "Arbeitet …";
}

export function conversationName(c: Pick<ConversationSummary, "id" | "title">): string {
  return sanitizeLine(c.title) || c.id;
}

/** Oberste Zeile: Name, Gespräch, Agent; geschlossene Topics sind nur lesbar */
export function headerLine(c: ConversationSummary, style: Style): string {
  const agent = sanitizeLine(c.agent);
  const parts = [style.bold(BRAND.name), style.bold(conversationName(c)), agent ? `Agent ${agentLabel(agent)}` : ""];
  if (c.closed) parts.push(style.yellow("geschlossen, nur lesen"));
  return parts.filter(Boolean).join(style.dim(" · "));
}

export function hintLine(style: Style): string {
  return style.dim("Enter sendet · Alt+Enter oder \\ am Zeilenende: neue Zeile · ↑/↓ frühere Eingaben · Strg+C stoppt, zweimal beendet · /tasten");
}

export const HELP_TEXT = [
  "Tasten im Chat:",
  "  Enter              Nachricht senden",
  "  Alt+Enter          neue Zeile (oder \\ am Zeilenende, dann Enter)",
  "  ↑ / ↓              frühere Eingaben",
  "  ← / →, Pos1/Ende   im Text bewegen (auch Strg+A / Strg+E)",
  "  Strg+U             Eingabe leeren",
  "  Strg+C             laufende Antwort stoppen; ohne Antwort zweimal: beenden",
  "  Strg+D             beenden (bei leerer Eingabe)",
  "  Tab                Befehl, Gesprächs- oder Agentennamen ergänzen",
  "",
  COMMAND_HELP,
].join("\n");

function timeOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function durationText(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  const seconds = ms / 1000;
  return seconds < 60 ? `${seconds.toFixed(1).replace(".", ",")} s` : `${Math.round(seconds / 60)} min`;
}

/** Motoren, die im Kopf einer Antwort genannt werden (Issue #125); Claude bleibt ungenannt */
const ENGINE_NAMES: Record<string, string> = { codex: "Codex", opencode: "OpenCode" };

/** Eine Nachricht als Textblock: Kopf (wer, wann) und Inhalt */
export function formatMessage(m: Message, style: Style, fallbackAgent = ""): string {
  const time = timeOf(m.createdAt);
  const sep = style.dim(" · ");
  let head: string;
  let body: string;
  if (m.kind === "notice") {
    const source = sanitizeLine(m.source ?? "");
    head = [style.magenta(source ? `Meldung von ${source}` : "Meldung"), time].filter(Boolean).join(sep);
    body = renderTerminalMarkdown(stripControlTags(m.text), style);
    if (m.file?.name) body += `\n${style.dim(`[Datei: ${sanitizeLine(m.file.name)}]`)}`;
  } else if (m.role === "user") {
    head = [style.green(style.bold("Du")), time].filter(Boolean).join(sep);
    body = sanitizeTerminal(m.text);
  } else if (m.role === "assistant") {
    const agent = sanitizeLine(m.agent ?? fallbackAgent);
    // Motor nur, wenn er nicht Claude ist (Issue #125), z. B. „Codex · gpt-5.6-sol"
    const engine = typeof m.engine === "string" && Object.hasOwn(ENGINE_NAMES, m.engine) ? ENGINE_NAMES[m.engine] : "";
    const meta = [time, engine, sanitizeLine(m.model ?? ""), durationText(m.durationMs)].filter(Boolean).join(sep);
    head = [style.cyan(style.bold(agent ? agentLabel(agent) : BRAND.name)), meta].filter(Boolean).join(sep);
    body = renderTerminalMarkdown(typeof m.copyText === "string" ? m.copyText : stripControlTags(m.text), style);
  } else {
    head = [style.red(style.bold("Fehler")), time].filter(Boolean).join(sep);
    body = sanitizeTerminal(m.text);
  }
  const choice = m.role === "user" ? null : toChoice(m.choice);
  const extra = choice ? formatChoice(choice, style) : "";
  return `${head}\n${body}${extra ? `\n${extra}` : ""}`;
}

const CHOICE_VIA_TEXT: Record<ChoiceVia, string> = { telegram: "in Telegram", web: "im Browser", terminal: "im Terminal" };

/** Knöpfe als nummerierte Auswahl: „[1] Erlauben  [2] Ablehnen" */
export function choiceOptionsText(choice: ApiChoice, style: Style): string {
  return choice.options.map((o, i) => `${style.bold(`[${i + 1}]`)} ${sanitizeLine(o.label)}`).join("  ");
}

/** „Erledigt: Erlauben · in Telegram" bzw. „Abgelaufen"; null, solange die Frage offen ist */
export function choiceStatusText(choice: ApiChoice): string | null {
  if (choice.state === "expired") return "Abgelaufen";
  if (choice.state !== "done") return null;
  if (!choice.result) return "Erledigt";
  const label = sanitizeLine(choice.result.label);
  return [label ? `Erledigt: ${label}` : "Erledigt", CHOICE_VIA_TEXT[choice.result.via]].filter(Boolean).join(" · ");
}

/**
 * Zeile unter einer Nachricht mit Rückfrage (Issue #120): offene mit
 * Knöpfen nummeriert, erledigte und abgelaufene mit ihrem Stand. Eine Frage
 * aus einem anderen Gespräch (Kopie im Direktchat) ist hier nicht wählbar.
 */
export function formatChoice(choice: ApiChoice, style: Style): string {
  const status = choiceStatusText(choice);
  if (status) return style.dim(status);
  if (choice.elsewhere) return style.dim("Antwort im Gespräch, aus dem die Frage kommt.");
  if (choice.options.length === 0) return style.dim("Antwort in Telegram.");
  return choiceOptionsText(choice, style);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Letzte Aktivität kurz: „heute 14:05", „gestern 09:12", „03.09. 18:40", aus anderen Jahren mit Jahr */
export function activityText(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "noch nichts";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "noch nichts";
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const today = new Date(now);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, today)) return `heute ${time}`;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameDay(date, yesterday)) return `gestern ${time}`;
  const day = `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.`;
  return date.getFullYear() === today.getFullYear() ? `${day} ${time}` : `${day}${date.getFullYear()} ${time}`;
}

const NAME_COLUMN = 28;

function padTo(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

function cut(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let out = "";
  for (const ch of text) {
    if (displayWidth(out + ch) > width - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/**
 * Liste für /gespraeche (Issue #61): Nummer, Name, Agent, letzte Aktivität, in
 * der Reihenfolge des Servers. Das offene Gespräch ist mit › markiert,
 * geschlossene Topics mit „geschlossen".
 */
export function formatConversationList(list: ConversationSummary[], currentId: string, style: Style, now: number = Date.now()): string {
  if (list.length === 0) return style.dim("Keine Gespräche.");
  const numberWidth = String(list.length).length;
  const agentWidth = Math.max(5, ...list.map(c => displayWidth(agentLabel(sanitizeLine(c.agent) || "general"))));
  const lines = list.map((c, i) => {
    const mark = c.id === currentId ? style.cyan("›") : " ";
    const n = String(i + 1).padStart(numberWidth, " ");
    const name = padTo(cut(conversationName(c), NAME_COLUMN), NAME_COLUMN);
    const agent = padTo(agentLabel(sanitizeLine(c.agent) || "general"), agentWidth);
    const extra = c.closed ? style.yellow(" geschlossen") : "";
    return `${mark} ${style.bold(n)}  ${name}  ${agent}  ${style.dim(activityText(c.lastActivity, now))}${extra}`;
  });
  return [style.bold("Gespräche"), ...lines, style.dim("Wechseln mit /wechsel <Nr.> oder /wechsel <Name>.")].join("\n");
}
