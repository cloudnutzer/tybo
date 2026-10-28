/**
 * Effort-Router: entscheidet pro Nutzer-Aeusserung, wie viel das Modell denkt
 * und ob die Frage als Denkauftrag an tybo geht. Aus der Sprach-Brücke
 * herausgelöst (Issue #255).
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

const HIGH_TRIGGERS = [
  /denk\w*\s+(mal\s+|bitte\s+|da\s+)?(gr[üu]ndlich|genau|in ruhe|richtig|scharf)/i,
  /nimm dir (ruhig\s+)?zeit/i,
  /[üu]berleg\w*\s+(mal\s+|bitte\s+|dir\s+das\s+)?(genau|gr[üu]ndlich|in ruhe)/i,
  /think (hard|carefully|deeply|it through)/i,
  /take your time/i,
];

const DEEP_TRIGGERS = [
  /denkauftrag/i,
  /rechne\s+(mir\s+)?(das|es)\s+(mal\s+)?(komplett\s+|in ruhe\s+)?durch/i,
  /(analysier|pr[üu]f|arbeite)\w*\s+(mir\s+)?(das\s+)?(mal\s+)?(ausf[üu]hrlich|komplett|gr[üu]ndlich)\s+(aus|durch)?/i,
];

export interface TurnPlan {
  effort: Effort;
  /** true: nicht live antworten, sondern den Denkauftrag an tybo geben */
  deep: boolean;
}

export function classifyTurn(lastUserText: string, fallback: Effort, override?: unknown): TurnPlan {
  if (typeof override === "string" && EFFORTS.includes(override as Effort)) {
    return { effort: override as Effort, deep: false };
  }
  if (DEEP_TRIGGERS.some((r) => r.test(lastUserText))) return { effort: "xhigh", deep: true };
  if (HIGH_TRIGGERS.some((r) => r.test(lastUserText))) return { effort: "high", deep: false };
  return { effort: fallback, deep: false };
}
