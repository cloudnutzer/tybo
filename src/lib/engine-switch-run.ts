/** Auswertung eines Chat-Laufs; vor dem Einspringen wird die Sperre abgewartet. */
import { applyFailure, applyMeasurement, applySuccess, limitEvidence, type Stage, type SwitchAuto, type SwitchFailure, type SwitchUsage } from "./engine-switch";
import { updateSwitchState } from "./engine-switch-state";
import type { EngineErrorKind, EngineResult } from "./engines";
import { readUsage } from "./engines/usage";
import { stageLabel } from "./engine-choice";
import { maskSecrets, type SecretValue } from "./jobs/mask";

export const ERROR_KIND_TEXT: Partial<Record<EngineErrorKind, string>> = {
  usage_limit: "Nutzungsgrenze erreicht",
  rate_limit: "zu viele Anfragen",
  quota: "Kontingent aufgebraucht",
  capacity: "überlastet",
  context: "Gespräch zu lang",
};

export const FAILED_ATTEMPT_MAX_TOOLS = 20;
export const FAILED_ATTEMPT_TOOL_CHARS = 80;

/**
 * Ein Lauf kann nach halber Arbeit abbrechen. Die Werkzeugliste mindert
 * doppelte Wirkungen (Datei senden, Eintrag anlegen), verhindert sie aber nicht.
 * Höchstens 20 Einträge mit je 80 Zeichen; erst maskieren, dann kürzen.
 * undefined bei secrets heißt: Quelle unlesbar, deshalb nur Werkzeugnamen.
 * Reiner Baustein auch für gescheiterte Knopf-Fortsetzungen (M14-09).
 */
export function failedAttemptPrompt(
  stage: Stage, kind: EngineErrorKind | "empty" | undefined, tools: EngineResult["tools"], secrets: readonly SecretValue[] | undefined,
): string {
  const short = (value: string) => {
    const masked = maskSecrets(value, secrets ?? []).replace(/\s+/g, " ").trim();
    return masked.length > FAILED_ATTEMPT_TOOL_CHARS ? masked.slice(0, FAILED_ATTEMPT_TOOL_CHARS - 1) + "…" : masked;
  };
  const why = kind === "empty" ? "keine Antwort" : kind === "auth" ? "nicht angemeldet"
    : kind === "not_installed" ? "nicht installiert" : (kind ? ERROR_KIND_TEXT[kind] : undefined) ?? "unbekannter Fehler";
  let used = "Welche Werkzeuge er benutzt hat, ist nicht bekannt.";
  if (tools) {
    if (!tools.uses.length) used = "Er hat noch kein Werkzeug benutzt.";
    else {
      const entries = tools.uses.slice(0, FAILED_ATTEMPT_MAX_TOOLS).map(tool => {
        const detail = secrets ? [tool.command, tool.path].filter(Boolean).join("; ") : "";
        return short(`${tool.name}${detail ? `: ${detail}` : ""}`);
      });
      const omitted = tools.uses.length - entries.length;
      used = `Er hat bereits diese Werkzeuge benutzt: ${entries.join("; ")}${omitted ? `; … (${omitted} weitere Aufrufe)` : ""}.`;
    }
  }
  return `Der vorige Versuch mit ${short(stageLabel(stage))} ist abgebrochen (${why}). ${used} Prüfe den Stand, bevor du etwas wiederholst.`;
}

/** Nur endgültige Limit-Fehler und Ausfälle lösen einen Stufenwechsel aus. */
export function stageFailureOf(result: EngineResult): SwitchFailure["kind"] | undefined {
  if (!result.isError || result.aborted || result.timedOut) return undefined;
  switch (result.errorKind) {
    case "usage_limit": case "quota": return "limit";
    case "rate_limit": case "context": return undefined;
    default: return "outage";
  }
}

/**
 * Erfolg reiht sofort in die Zustandskette ein; der nächste Turn wartet darauf.
 * Ein Fehler zählt erst beim Aufgeben der Stufe (abandoned), nie vor einem
 * frischen Resume-Retry. Messwerte zählen auch bei diesem Zwischenversuch.
 * Erfolg wird ohne Warten eingereiht; der Fehlerpfad wartet vor der Auswahl.
 * Nur die Zustandsablage wartet auf eine Dateisperre (höchstens zwei Sekunden).
 */
export async function noteStageRun(
  stage: Stage, model: string | undefined, result: EngineResult, auto: SwitchAuto, now: number,
  update: typeof updateSwitchState = updateSwitchState,
  options: { readUsage?: typeof readUsage; abandoned?: boolean } = {},
): Promise<void> {
  try {
    const success = !result.isError && !result.aborted && !result.timedOut && !!result.text;
    // Der Sprech-Turn kann ein anderes Modell als die eingestellte Stufe rufen.
    const calledStage = { ...stage, model };
    const kind = options.abandoned === false ? undefined : stageFailureOf(result);
    const usage: SwitchUsage = {
      claude: [], codex: [], opencode: [], api: [],
      [stage.engine]: (result.rateLimit?.windows ?? []).map(window => ({ ...window, state: "known" as const })),
    };
    let evidence;
    if (kind === "limit") {
      let freshUsage = usage;
      try { freshUsage = await (options.readUsage ?? readUsage)(now); } catch { /* Ohne Beleg gilt die Familienpause. */ }
      evidence = limitEvidence({ stage: calledStage, model, rateLimit: result.rateLimit, usage: freshUsage, now });
    }
    const failure = kind ? { stage: calledStage, model, kind, evidence } : undefined;
    // Nur eingefangene Werte: die reine Mutation kann beim Nachholen erneut laufen.
    // Eine inzwischen synchronisierte Einstellung geht vor der des gestarteten
    // Turns: insbesondere darf ein später Erfolg Automatik aus nicht überholen.
    await update(state => {
      const measured = applyMeasurement(success ? applySuccess(state, calledStage, model) : state, usage, now, state.auto ?? auto);
      return failure ? applyFailure(measured, failure, now) : measured;
    });
  } catch { /* Weder eine gelungene Antwort noch der Fehlerpfad darf daran scheitern. */ }
}
