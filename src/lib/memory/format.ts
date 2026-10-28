/**
 * Ziel- und Faktenliste als Text (Issue #314) für /goals, /memory und die
 * Dienste dahinter. Der Wortlaut ist englisch wie im übrigen Gedächtnis
 * (context.ts) und bleibt so: Nutzer und Modell kennen ihn.
 */
import type { MemoryItem } from "../store/types";
import { goalLine } from "./context";

export const NO_GOALS = "No active goals.";
export const NO_FACTS = "No stored facts.";

/** Offene Ziele nummeriert ab 1, mit Frist als Datum des Systems; leer ein fester Satz */
export function goalsList(goals: MemoryItem[]): string {
  if (goals.length === 0) return NO_GOALS;
  return goals.map((goal, index) => goalLine(goal, index + 1)).join("\n");
}

/** Fakten als Spiegelstriche in gespeicherter Reihenfolge; leer ein fester Satz */
export function factsList(facts: MemoryItem[]): string {
  if (facts.length === 0) return NO_FACTS;
  return facts.map(fact => "- " + fact.content).join("\n");
}
