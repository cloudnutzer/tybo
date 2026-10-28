/**
 * Text für /faeden (Issue #290): offene Fäden, neueste oben, je Faden
 * Nummer, Thema, Frage, Gespräch, Alter und Frist. Reiner Text ohne
 * Markdown, weil Thema und Frage beliebige Zeichen enthalten können.
 *
 * Seit Issue #291 ist die Nummer die feste Nummer aus der Ablage (nr), nicht
 * die Position in der Liste; /faeden zu <nr> nimmt dieselbe. /faeden alle
 * hängt die in den letzten 7 Tagen geschlossenen mit Grund an.
 *
 * Seit Issue #292 nennt jeder offene Faden den nächsten Termin in Ortszeit
 * (USER_TIMEZONE): „Erinnerung am", nach der ersten „zweite Erinnerung am",
 * nach der zweiten „schließe ich am".
 */

import { localDateText, reminderTimeZone } from "./schedule";
import { CLOSED_REASON, type Thread } from "./store";

export const THREADS_TEXT = {
  off: "Offene Fäden sind ausgeschaltet (Einstellungen der WebUI, Abschnitt „Offene Fäden“, oder THREADS=off).",
  none: "Keine offenen Fäden.",
  heading: (n: number) => `Offene Fäden (${n}):`,
  direct: "Direktchat",
  general: "General",
  web: "Web-Gespräch",
  closedHeading: (n: number) => `Geschlossen in den letzten 7 Tagen (${n}):`,
  closedNone: "Geschlossen in den letzten 7 Tagen: keine.",
  closed: (nr: number, topic: string) => `Faden ${nr} geschlossen: ${topic}`,
  unknown: (nr: number) => `Keinen offenen Faden ${nr}. /faeden zeigt alle.`,
  elsewhere: (nr: number, place: string) => `Faden ${nr} gehört zu einem anderen Gespräch (${place}). Schließen geht nur dort: /faeden zu ${nr}`,
  noConversation: "In diesem Gespräch gibt es keine Fäden zum Schließen.",
  usage: "So geht es: /faeden zeigt die offenen Fäden, /faeden alle auch die geschlossenen der letzten 7 Tage, /faeden zu <nr> schließt einen.",
} as const;

/** Grund eines geschlossenen Fadens für die Anzeige */
export function closedReasonText(reason: string | undefined): string {
  if (reason === CLOSED_REASON.limit) return "Obergrenze erreicht";
  return reason?.trim() || "geschlossen";
}

/** "seit 3 Tagen", "seit 1 Stunde", "seit 5 Minuten", unter einer Minute "seit gerade eben" */
export function threadAge(createdAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - createdAt) / 60_000);
  if (minutes < 1) return "seit gerade eben";
  if (minutes < 60) return minutes === 1 ? "seit 1 Minute" : `seit ${minutes} Minuten`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "seit 1 Stunde" : `seit ${hours} Stunden`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "seit 1 Tag" : `seit ${days} Tagen`;
}

/** Frist YYYY-MM-DD als TT.MM.JJJJ */
export function deadlineText(deadline: string): string {
  const [y, m, d] = deadline.split("-");
  return `${d}.${m}.${y}`;
}

/** Nächster Termin eines offenen Fadens in Ortszeit; null ohne Termin */
export function reminderLine(thread: Pick<Thread, "reminders" | "nextReminderAt">, timeZone: string): string | null {
  if (thread.nextReminderAt === undefined) return null;
  const date = localDateText(thread.nextReminderAt, timeZone);
  if (thread.reminders >= 2) return `schließe ich am ${date}`;
  if (thread.reminders === 1) return `zweite Erinnerung am ${date}`;
  return `Erinnerung am ${date}`;
}

/** Ort eines Fadens: Topic-Name (sonst „Topic <id>"), General, Direktchat oder Web-Gespräch */
export function threadPlace(thread: Thread, topicNames: Record<string, string>): string {
  const c = thread.conversation;
  if (c.type === "web") return THREADS_TEXT.web;
  if (c.topicId !== undefined) {
    const name = topicNames[String(c.topicId)];
    return name ? `Topic ${name}` : `Topic ${c.topicId}`;
  }
  // Gruppen-IDs sind negativ: ohne Topic ist das General, sonst der Direktchat (auch "web" ohne Telegram)
  return c.chatId.startsWith("-") ? THREADS_TEXT.general : THREADS_TEXT.direct;
}

export function formatThreadList(
  threads: Thread[],
  opts: { enabled: boolean; now?: number; topicNames?: Record<string, string>; timeZone?: string }
): string {
  if (!opts.enabled) return THREADS_TEXT.off;
  if (threads.length === 0) return THREADS_TEXT.none;
  const now = opts.now ?? Date.now();
  const names = opts.topicNames ?? {};
  const zone = opts.timeZone ?? reminderTimeZone();
  const sorted = [...threads].sort((a, b) => b.createdAt - a.createdAt || b.nr - a.nr);
  const blocks = sorted.map(t => {
    const reminder = reminderLine(t, zone);
    const meta = [
      threadPlace(t, names),
      threadAge(t.createdAt, now),
      ...(t.deadline ? [`Frist ${deadlineText(t.deadline)}`] : []),
      ...(reminder ? [reminder] : []),
    ];
    return `${t.nr}. ${t.topic}\n   Frage: ${t.question}\n   ${meta.join(" · ")}`;
  });
  return `${THREADS_TEXT.heading(threads.length)}\n\n${blocks.join("\n\n")}`;
}

/** "vor 3 Tagen", "gerade eben" (aus threadAge) */
function closedAgo(closedAt: number, now: number): string {
  const age = threadAge(closedAt, now);
  return age === "seit gerade eben" ? "gerade eben" : age.replace(/^seit /, "vor ");
}

/** Abschnitt für /faeden alle: geschlossene Fäden, zuletzt geschlossene oben, mit Grund */
export function formatClosedThreads(threads: Thread[], opts: { now?: number; topicNames?: Record<string, string> } = {}): string {
  if (threads.length === 0) return THREADS_TEXT.closedNone;
  const now = opts.now ?? Date.now();
  const names = opts.topicNames ?? {};
  const sorted = [...threads].sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  const blocks = sorted.map(t => {
    const meta = [threadPlace(t, names), `geschlossen ${closedAgo(t.closedAt ?? now, now)}`, closedReasonText(t.closedReason)];
    return `${t.nr}. ${t.topic}\n   Frage: ${t.question}\n   ${meta.join(" · ")}`;
  });
  return `${THREADS_TEXT.closedHeading(threads.length)}\n\n${blocks.join("\n\n")}`;
}
