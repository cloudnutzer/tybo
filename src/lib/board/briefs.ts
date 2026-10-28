/**
 * Datenblöcke der Board-Agenten (Issue #357): aus den Ausgängen der Quellen
 * baut je Agent eine Funktion einen deutschen Block. Die Überschriften sind
 * eigene, nicht die Anzeigenamen der Quellen.
 *
 * Regel für fehlende Daten: Ist eine Quelle nicht eingerichtet (skipped oder
 * nicht in der Liste), fehlt ihr Abschnitt. Ist sie gescheitert oder im
 * Zeitlimit, steht im Abschnitt „nicht verfügbar". Eine Zahl steht nur da,
 * wenn die Quelle wirklich geantwortet hat. Gibt es für einen Agenten
 * nichts, ist sein Block leer.
 *
 * Agenten ohne eigene Daten (content, cto, general, eigene Board-Agenten)
 * bekommen einen leeren Block.
 */
import { MAX_TASKS } from "../sources/notion";
import type { Section, SectionItem, SourceOutcome } from "../sources/types";

/** Was die Blöcke von einem Lauf sehen */
export interface SourceView {
  outcome(id: string): SourceOutcome | undefined;
  /** Zeitzone des Nutzers für Uhrzeiten */
  timeZone: string;
}

export const UNAVAILABLE = "nicht verfügbar";
export const BLOCK_HEADING = "## Live-Daten für diese Sitzung";

type Reading = { kind: "absent" } | { kind: "unavailable" } | { kind: "ok"; section: Section };

function reading(view: SourceView, id: string): Reading {
  const outcome = view.outcome(id);
  if (!outcome || outcome.status === "skipped") return { kind: "absent" };
  if (outcome.status === "ok") return { kind: "ok", section: outcome.section };
  return { kind: "unavailable" };
}

/** Abschnitt mit Überschrift; null, wenn die Quelle nicht eingerichtet ist */
function part(heading: string, from: Reading, lines: (section: Section) => string[]): string | null {
  if (from.kind === "absent") return null;
  const body = from.kind === "ok" ? lines(from.section) : [UNAVAILABLE];
  return [`### ${heading}`, ...body].join("\n");
}

function block(parts: (string | null)[]): string {
  const present = parts.filter((p): p is string => p !== null);
  return present.length ? [BLOCK_HEADING, ...present].join("\n\n") : "";
}

const bullet = (text: string) => `- ${text}`;
const orNone = (lines: string[], none: string) => (lines.length ? lines : [none]);

// ---------------------------------------------------------------------------
// Zeilen je Quelle
// ---------------------------------------------------------------------------

function newsLines(limit?: number) {
  return (section: Section) => {
    const items = limit === undefined ? section.items : section.items.slice(0, limit);
    return orNone(items.map(item => bullet(item.link ? `${item.text} (${item.link})` : item.text)), "Keine belegten Nachrichten gefunden.");
  };
}

function unreadCount(section: Section): string {
  return typeof section.total === "number" ? String(section.total) : "unbekannt";
}

function mailLines(section: Section): string[] {
  if (section.total === 0) return ["Keine ungelesenen Mails."];
  return [`Ungelesen im Posteingang: ${unreadCount(section)}`, ...section.items.map(item => bullet(item.text))];
}

/**
 * Der sichere Teil des Betreffs aus einem Mail-Eintrag der Quelle gmail. Sie
 * liefert „Absender: Betreff". Ein Absender in Anführungszeichen („"Team:
 * Billing"") endet am schließenden Zeichen, dahinter muss „: " folgen; so ist
 * die Trennung genau. Ohne Anführungszeichen ist sie nur bei genau einem „: "
 * eindeutig. Bei mehreren kann jeder Teil vor dem letzten noch zum Absender
 * gehören, deshalb zählt dann nur der Teil nach dem letzten „: ". Ohne Trenner
 * ist der Betreff unbekannt (null).
 */
export function mailSubject(text: string): string | null {
  if (text.startsWith('"')) {
    for (let i = 1; i < text.length; i++) {
      if (text[i] === "\\") i++;
      else if (text[i] === '"') return text.startsWith(": ", i + 1) ? text.slice(i + 3) : null;
    }
    return null;
  }
  const at = text.lastIndexOf(": ");
  return at < 0 ? null : text.slice(at + 2);
}

/**
 * Kostenwörter als eigene Wörter, Groß- und Kleinschreibung egal:
 * Rechnung und Zahlung auch mit Anhang (Rechnungsnummer, Zahlungserinnerung)
 * sowie Abrechnung und Bezahlung, Abo (auch Abos, Abonnement), Beleg(e),
 * dazu englisch invoice, receipt, payment, billing, subscription, charge.
 */
const COST_WORD =
  /(?<![\p{L}\p{N}])(?:(?:ab)?rechnung\p{L}*|(?:be)?zahlung\p{L}*|abo(?:s|nnement\p{L}*)?|belege?n?|invoices?|invoiced|receipts?|payments?|billing|subscriptions?|charge[sd]?)(?![\p{L}\p{N}])/iu;

export function isCostMail(item: SectionItem): boolean {
  const subject = mailSubject(item.text);
  return subject !== null && COST_WORD.test(subject);
}

function costMailLines(section: Section): string[] {
  return orNone(section.items.filter(isCostMail).map(item => bullet(item.text)), "Keine unter den gezeigten ungelesenen Mails.");
}

function goalLines(section: Section): string[] {
  return orNone(
    section.items.map(item => {
      if (!item.due) return bullet(item.text);
      return bullet(`${item.text} (Frist ${item.due}${item.overdue ? ", verstrichen" : ""})`);
    }),
    "Keine offenen Ziele.",
  );
}

function eventLines(timeZone: string) {
  const clock = (iso: string) => new Date(iso).toLocaleTimeString("de-DE", { timeZone, hour: "2-digit", minute: "2-digit" });
  return (section: Section) =>
    orNone(
      section.items.map(item => {
        if (item.allDay) return bullet(`ganztägig: ${item.text}`);
        return bullet(item.start ? `${clock(item.start)} Uhr: ${item.text}` : item.text);
      }),
      "Keine Termine heute.",
    );
}

/** Zahl der überfälligen unter den gelieferten Aufgaben, mit Hinweis auf die Grenze der Liste */
function overdueCount(section: Section): string {
  const overdue = section.items.filter(item => item.overdue).length;
  const capped = section.items.length >= MAX_TASKS ? `, Liste auf ${MAX_TASKS} begrenzt` : "";
  return `${overdue} (unter ${section.items.length} gelieferten Aufgaben${capped})`;
}

function taskLines(section: Section): string[] {
  if (section.items.length === 0) return ["Keine Aufgaben, die bis heute fällig sind."];
  return [
    `Überfällig: ${overdueCount(section)}`,
    ...section.items.map(item => bullet(item.due ? `${item.text} (fällig ${item.due}${item.overdue ? ", überfällig" : ", heute"})` : item.text)),
  ];
}

// ---------------------------------------------------------------------------
// Blöcke je Agent
// ---------------------------------------------------------------------------

type Brief = (view: SourceView) => string;

const nothing: Brief = () => "";

const research: Brief = view =>
  block([
    part("KI-Nachrichten der letzten 24 Stunden", reading(view, "news"), newsLines()),
    part("Ungelesene Mails", reading(view, "gmail"), mailLines),
  ]);

const finance: Brief = view => block([part("Mails mit Kostenbezug im Betreff", reading(view, "gmail"), costMailLines)]);

const strategy: Brief = view =>
  block([
    part("Offene Ziele", reading(view, "goals"), goalLines),
    part("Termine heute", reading(view, "calendar"), eventLines(view.timeZone)),
    part("Wichtigste Nachrichten", reading(view, "news"), newsLines(3)),
  ]);

const coo: Brief = view =>
  block([
    part("Aufgaben, fällig bis heute", reading(view, "notion-tasks"), taskLines),
    part("Termine heute", reading(view, "calendar"), eventLines(view.timeZone)),
    part("Ungelesene Mails", reading(view, "gmail"), mailLines),
  ]);

/** Eine Kennzahl je eingerichteter Quelle, „nicht verfügbar" bei Ausfall */
function metric(label: string, from: Reading, value: (section: Section) => string): string | null {
  if (from.kind === "absent") return null;
  return bullet(`${label}: ${from.kind === "ok" ? value(from.section) : UNAVAILABLE}`);
}

const critic: Brief = view => {
  const lines = [
    metric("Überfällige Aufgaben", reading(view, "notion-tasks"), overdueCount),
    metric("Ungelesene Mails", reading(view, "gmail"), unreadCount),
  ].filter((line): line is string => line !== null);
  return block([lines.length ? ["### Risiko-Kennzahlen", ...lines].join("\n") : null]);
};

/** Agent-Kennung zu Block; wer fehlt, bekommt einen leeren Block */
const BRIEFS: Readonly<Record<string, Brief>> = {
  research,
  finance,
  strategy,
  coo,
  critic,
  content: nothing,
  cto: nothing,
  general: nothing,
};

export function briefFor(agent: string, view: SourceView): string {
  return Object.hasOwn(BRIEFS, agent) ? BRIEFS[agent](view) : "";
}

/** Blöcke aller Agenten der Tabelle */
export function briefsFor(view: SourceView): Record<string, string> {
  return Object.fromEntries(Object.keys(BRIEFS).map(agent => [agent, briefFor(agent, view)]));
}

/** Für die Zusammenfassung: überfällige Aufgaben, wenn Notion geliefert hat, sonst leer */
export function overdueSummary(view: SourceView): string {
  const from = reading(view, "notion-tasks");
  return from.kind === "ok" ? `Überfällige Aufgaben: ${overdueCount(from.section)}` : "";
}
