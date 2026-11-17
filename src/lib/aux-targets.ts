/**
 * Ziele der Nebenaufgaben (Aux-Modelle), ohne Aufruf (Issue #566).
 *
 * Reine Auflösung je Zweck: config/settings.json (aux.<zweck>) vor
 * AUX_MODEL_<ZWECK> vor dem Standard aus dem Code. Ein ungültiger Wert
 * zählt wie keiner. Liegt in einem eigenen Modul, damit die Einrichtung und
 * die Startprüfung die Ziele kennen, ohne callAux und damit die Claude CLI
 * zu laden. Aufgerufen wird in src/lib/aux-model.ts.
 */

import { parseAuxSpec, type Settings } from "./settings";

export type AuxPurpose = "judge" | "distill" | "review" | "threads" | "call-summary" | "checkin" | "voice-training" | "voice-wizard";

/** Alle Zwecke in fester Reihenfolge (Log-Zeile, Einrichtung, Doku) */
export const AUX_PURPOSES: readonly AuxPurpose[] = [
  "judge",
  "distill",
  "review",
  "threads",
  "call-summary",
  "checkin",
  "voice-training",
  "voice-wizard",
];

/** Name eines Zwecks in Meldungen an den Nutzer */
export const AUX_PURPOSE_LABELS: Record<AuxPurpose, string> = {
  judge: "Richter von /goal",
  distill: "Destillat",
  review: "Review",
  threads: "offene Fäden",
  "call-summary": "Anruf-Zusammenfassung",
  checkin: "Check-in",
  "voice-training": "Auswertung von Übungsgesprächen",
  "voice-wizard": "Wizard für Sprachagenten",
};

export interface AuxTarget {
  kind: "claude" | "openrouter" | "ollama";
  model: string;
}

export type AuxSource = "settings" | "env" | "code";

export const DEFAULT_CLAUDE_AUX = "claude-haiku-5-5";

// Per-Purpose-Defaults: Der Goal-Judge entscheidet, ob autonome Arbeit
// weiterlaeuft oder stoppt: das ist Urteilsarbeit, per User-Vorgabe
// mindestens Opus (21.08.2026: "nicht Haiku, nicht Sonnet"). Destillat und
// Review sind Extraktionsaufgaben, da reicht Haiku.
export const PURPOSE_DEFAULTS: Record<AuxPurpose, AuxTarget> = {
  judge: { kind: "claude", model: "claude-opus-5" },
  distill: { kind: "claude", model: DEFAULT_CLAUDE_AUX },
  review: { kind: "claude", model: DEFAULT_CLAUDE_AUX },
  // Offene Fäden erkennen (Issue #290, Entscheidung 0025): Standard wie review
  threads: { kind: "claude", model: DEFAULT_CLAUDE_AUX },
  // Anruf-Zusammenfassung und Auftrag aus dem Anruf (Issue #306): Standard wie review
  "call-summary": { kind: "claude", model: DEFAULT_CLAUDE_AUX },
  // Check-in entscheiden und formulieren (Issue #364): Standard wie review
  checkin: { kind: "claude", model: DEFAULT_CLAUDE_AUX },
  // Übungsgespräch mit einem Experten auswerten (Issue #496): Standard wie review
  "voice-training": { kind: "claude", model: DEFAULT_CLAUDE_AUX },
  // Vorschlag des Wizards für Sprachagenten aus einem Satz (Issue #514): kleines Modell, wenige Sekunden
  "voice-wizard": { kind: "claude", model: DEFAULT_CLAUDE_AUX },
};

/** Name der Env-Variable je Zweck: Bindestriche werden zu Unterstrichen (AUX_MODEL_CALL_SUMMARY) */
export function auxEnvName(purpose: AuxPurpose): string {
  return `AUX_MODEL_${purpose.toUpperCase().replaceAll("-", "_")}`;
}

/**
 * Ziel und Quelle eines Zwecks aus Einstellungen und Umgebung. warn bekommt
 * den Namen einer ungültigen Variable (nie ihren Wert, der kann ein
 * Schlüssel sein); ohne warn bleibt es still.
 */
export function describeAuxFrom(
  purpose: AuxPurpose,
  settings: Settings,
  env: Record<string, string | undefined>,
  warn?: (envName: string, raw: string) => void
): { target: AuxTarget; source: AuxSource } {
  const fromSettings = settings.aux?.[purpose];
  const parsedSettings = fromSettings ? parseAuxSpec(fromSettings) : null;
  if (parsedSettings) return { target: parsedSettings, source: "settings" };
  const envName = auxEnvName(purpose);
  const raw = (env[envName] || "").trim();
  if (raw) {
    const parsed = parseAuxSpec(raw);
    if (parsed) return { target: parsed, source: "env" };
    warn?.(envName, raw);
  }
  return { target: PURPOSE_DEFAULTS[purpose], source: "code" };
}

/**
 * Ziel eines Aufrufs. Mit Resume immer Claude: nur die CLI kann Sessions
 * resumen, dann gilt der Claude-Default des jeweiligen Zwecks.
 */
export function auxTargetFor(target: AuxTarget, purpose: AuxPurpose, resume: boolean): AuxTarget {
  if (!resume || target.kind === "claude") return target;
  return PURPOSE_DEFAULTS[purpose].kind === "claude" ? PURPOSE_DEFAULTS[purpose] : { kind: "claude", model: DEFAULT_CLAUDE_AUX };
}
