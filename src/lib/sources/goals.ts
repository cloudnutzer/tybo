/**
 * Quelle Ziele (Issue #354): offene Ziele aus dem Gedächtnis-Dienst, also
 * Supabase oder ohne Datenbank die Datei. Erreichte Ziele kommen nicht vor
 * (früher zeigte das Morgenbriefing auch sie). Immer bereit.
 *
 * Auswahl wie im bisherigen Briefing: Mit Supabase höchstens MAX_GOALS,
 * die zuletzt angelegten zuerst (Ziele ohne Anlagezeit hinten); ohne
 * Datenbank alle offenen Ziele der Datei in ihrer Reihenfolge. Die Frist
 * (deadline, ISO) wird zum Tag in der Zeitzone des Nutzers, eine
 * verstrichene markiert den Eintrag. Scheitert Supabase, liefert der
 * Gedächtnis-Dienst die offenen Ziele der lokalen Ablage (Auswahl dann wie
 * ohne Datenbank); fehlen auch die, scheitert die Quelle.
 */
import { openGoals, type OpenGoals } from "../memory";
import type { Backend } from "../store";
import type { MemoryItem } from "../store/types";
import { dayIn } from "./run";
import type { Section, SectionItem, Source, SourceContext } from "./types";

export const MAX_GOALS = 5;

/** Woher die Ziele kommen, samt Speicher; in Tests ersetzbar */
export type GoalReader = () => Promise<OpenGoals>;

/** Bisherige Auswahl: Supabase die neuesten MAX_GOALS, die Datei alle in ihrer Reihenfolge */
function pick(open: MemoryItem[], backend: Backend): MemoryItem[] {
  if (backend === "file") return open;
  return [...open].sort((a, b) => createdMs(b) - createdMs(a)).slice(0, MAX_GOALS);
}

const createdMs = (goal: MemoryItem) => {
  const ms = goal.created_at ? Date.parse(goal.created_at) : NaN;
  return Number.isNaN(ms) ? -Infinity : ms;
};

function toItem(goal: MemoryItem, today: string, timeZone: string): SectionItem {
  const item: SectionItem = { text: goal.content };
  const deadline = goal.deadline ? new Date(goal.deadline) : null;
  if (deadline && !Number.isNaN(deadline.getTime())) {
    item.due = dayIn(deadline, timeZone);
    if (item.due < today) item.overdue = true;
  }
  return item;
}

export function goalsSource(read: GoalReader = openGoals): Source {
  return {
    id: "goals",
    label: "Active Goals",
    timeoutMs: 10_000,
    ready: () => true,
    async collect(ctx: SourceContext): Promise<Section> {
      const today = dayIn(ctx.now, ctx.timeZone);
      const { goals, from } = await read();
      const open = goals.filter(goal => goal.completed !== true);
      return { items: pick(open, from).map(goal => toItem(goal, today, ctx.timeZone)) };
    },
  };
}
