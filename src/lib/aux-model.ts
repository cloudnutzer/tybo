import { OPENROUTER_APP_HEADERS } from "../brand";
import { checkAborted, executionSignal } from "./execution-context";
/**
 * Aux-Modell-Routing.
 *
 * Nebenaufgaben (Goal-Judge, Session-Destillat, Session-Review) laufen auf
 * einem billigen Modell statt auf dem teuren Hauptmodell — das Muster aus
 * Hermes: teurer Hauptagent, billige Judges. Spart Subscription-Credit genau
 * dort, wo die autonomen Features sonst am meisten kosten.
 *
 * Konfiguration per .env, Format "<kind>:<model>":
 *   AUX_MODEL_JUDGE=claude:claude-haiku-5-5     (Default)
 *   AUX_MODEL_DISTILL=claude:claude-haiku-5-5   (Default)
 *   AUX_MODEL_REVIEW=openrouter:minimax/minimax-m2.7
 *   AUX_MODEL_JUDGE=ollama:qwen3:8b
 *
 * Regeln:
 * - kind "claude" laeuft ueber claude -p (Subscription), andere Kinds ueber
 *   die jeweilige REST-API ohne Tools.
 * - Aufrufe mit resumeSessionId (Destillat resumed die alte Session) gehen
 *   immer ueber claude — nur die CLI kann Sessions fortsetzen. Ist ein
 *   Nicht-Claude-Kind konfiguriert, wird fuer diese Aufrufe auf den
 *   Claude-Default zurueckgefallen.
 * - Fail-open: Fehler liefern isError=true, werfen nie.
 */

import { callClaude } from "./claude";
import { claudeMissing, whenClaudeChecked } from "./claude-availability";
import { bookRunOutcome } from "./spend/credit";
import { getSettings, type Settings } from "./settings";
import { auxTargetFor, describeAuxFrom, type AuxPurpose, type AuxSource, type AuxTarget } from "./aux-targets";

export { auxEnvName, type AuxPurpose } from "./aux-targets";

/** Vorrang: config/settings.json (aux.<purpose>) vor AUX_MODEL_<PURPOSE> vor Default. */
export function resolveAux(purpose: AuxPurpose): AuxTarget {
  return describeAux(purpose).target;
}

/**
 * Wie resolveAux, zusaetzlich mit Quelle (WebUI, Issue #36). Ein ungueltiges
 * AUX_MODEL_* faellt auf den Code-Standard zurueck. `settings` nur fuer die
 * WebUI, die den Stand direkt nach dem Speichern beschreibt; `quiet`
 * unterdrueckt die Warnung bei reinen Abfragen.
 */
export function describeAux(
  purpose: AuxPurpose,
  settings: Settings = getSettings(),
  quiet = false
): { target: AuxTarget; source: AuxSource } {
  return describeAuxFrom(purpose, settings, process.env, quiet ? undefined : (envName, raw) => {
    console.warn(`[AuxModel] Ungueltiges Format fuer ${envName}: "${raw}" — nutze Default`);
  });
}

/**
 * Ziel eines Aufrufs. Mit Resume immer Claude: nur die CLI kann Sessions
 * resumen, dann gilt der Claude-Default des jeweiligen Purpose.
 */
export function resolveAuxTarget(purpose: AuxPurpose, resume: boolean): AuxTarget {
  return auxTargetFor(resolveAux(purpose), purpose, resume);
}

/**
 * Ist dieser Aufruf abgeschaltet (Issue #566)? Ja, wenn er über Claude
 * liefe und Claude laut Startprüfung fehlt (src/lib/claude-availability.ts).
 * Unbekannt (noch nicht geprüft) zählt nicht: dann läuft der Aufruf wie
 * bisher.
 */
export function auxDisabled(purpose: AuxPurpose, resume = false): boolean {
  return claudeMissing() && resolveAuxTarget(purpose, resume).kind === "claude";
}

export interface AuxResult {
  text: string;
  isError: boolean;
  /**
   * Abgeschaltet (Issue #566): Claude fehlt und kein anderes Nebenmodell ist
   * eingestellt. Dann ist isError true, aufgerufen wurde nichts, und der
   * Aufrufer schreibt keine Fehlerzeile und versucht es nicht erneut.
   */
  disabled?: true;
}

/**
 * Run an aux task on the configured cheap model.
 * With resumeSessionId, the call always goes through the Claude CLI.
 */
export async function callAux(
  purpose: AuxPurpose,
  prompt: string,
  opts?: {
    resumeSessionId?: string;
    timeoutMs?: number;
    /**
     * Keine eigenen Log-Zeilen (Issue #290): der Aufrufer schreibt selbst
     * genau eine Zeile ohne Inhalt, etwa bei offenen Fäden, wo ein rohes
     * Fehlerobjekt Teile von Frage oder Antwort enthalten könnte.
     */
    quiet?: boolean;
  }
): Promise<AuxResult> {
  checkAborted();
  const target = resolveAuxTarget(purpose, !!opts?.resumeSessionId);
  if (target.kind === "claude") {
    // Läuft die Startprüfung noch, erst ihr Ergebnis abwarten (Issue #566)
    await whenClaudeChecked();
    checkAborted();
    if (claudeMissing()) return { text: "", isError: true, disabled: true };
  }
  const timeoutMs = opts?.timeoutMs ?? 180_000;

  try {
    if (target.kind === "claude") {
      const result = await callClaude({
        prompt,
        model: target.model,
        outputFormat: "json",
        // Effort pro Modellfamilie: Fable darf die Defaults (seit 22.9.2026 high) erben;
        // Opus 5 laeuft als Aux-Judge bewusst auf "high" (xhigh geht seit 30.8.2026
        // auch auf Opus 5, ist hier aber nicht noetig); kleinere Modelle kriegen keinen Effort-Flag,
        // auch nicht via globalem CLAUDE_EFFORT-Override.
        ...(target.model.includes("fable")
          ? {}
          : target.model.includes("opus")
            ? { effort: "high" }
            : { effort: "" }),
        ...(opts?.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
        timeoutMs,
        cwd: process.cwd(),
        ...(opts?.quiet ? { quiet: true } : {}),
      });
      void bookRunOutcome("aux", "claude", target.model, result);
      return { text: result.text || "", isError: result.isError || !result.text };
    }

    const url =
      target.kind === "openrouter"
        ? "https://openrouter.ai/api/v1/chat/completions"
        : "http://localhost:11434/v1/chat/completions";
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (target.kind === "openrouter") {
      const key = process.env.OPENROUTER_API_KEY || "";
      if (!key) return { text: "", isError: true };
      headers["Authorization"] = `Bearer ${key}`;
      Object.assign(headers, OPENROUTER_APP_HEADERS);
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: target.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 2048,
      }),
      signal: executionSignal(timeoutMs),
    });
    if (!response.ok) {
      if (!opts?.quiet) console.error(`[AuxModel] ${purpose} API error ${response.status}`);
      return { text: "", isError: true };
    }
    const data = (await response.json()) as any;
    const text = data.choices?.[0]?.message?.content || "";
    return { text, isError: !text };
  } catch (err) {
    if (!opts?.quiet) console.error(`[AuxModel] ${purpose} failed:`, err);
    return { text: "", isError: true };
  }
}

/**
 * Extract the first JSON object from an aux response (models often wrap
 * JSON in code fences or prose). Returns null when nothing parses.
 */
export function parseAuxJSON(text: string): any | null {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
