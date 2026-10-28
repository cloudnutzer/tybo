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
import { bookRunOutcome } from "./spend/credit";
import { getSettings, parseAuxSpec, type Settings } from "./settings";

export type AuxPurpose = "judge" | "distill" | "review" | "threads" | "call-summary" | "checkin";

interface AuxTarget {
  kind: "claude" | "openrouter" | "ollama";
  model: string;
}

const DEFAULT_CLAUDE_AUX = "claude-haiku-5-5";

// Per-Purpose-Defaults: Der Goal-Judge entscheidet, ob autonome Arbeit
// weiterlaeuft oder stoppt — das ist Urteilsarbeit, per User-Vorgabe
// mindestens Opus (21.08.2026: "nicht Haiku, nicht Sonnet"). Destillat und
// Review sind Extraktionsaufgaben, da reicht Haiku.
const PURPOSE_DEFAULTS: Record<AuxPurpose, AuxTarget> = {
  judge: { kind: "claude", model: "claude-opus-5" },
  distill: { kind: "claude", model: DEFAULT_CLAUDE_AUX },
  review: { kind: "claude", model: DEFAULT_CLAUDE_AUX },
  // Offene Fäden erkennen (Issue #290, Entscheidung 0025): Standard wie review
  threads: { kind: "claude", model: DEFAULT_CLAUDE_AUX },
  // Anruf-Zusammenfassung und Auftrag aus dem Anruf (Issue #306): Standard wie review
  "call-summary": { kind: "claude", model: DEFAULT_CLAUDE_AUX },
  // Check-in entscheiden und formulieren (Issue #364): Standard wie review
  checkin: { kind: "claude", model: DEFAULT_CLAUDE_AUX },
};

/** Name der Env-Variable je Zweck: Bindestriche werden zu Unterstrichen (AUX_MODEL_CALL_SUMMARY) */
export function auxEnvName(purpose: AuxPurpose): string {
  return `AUX_MODEL_${purpose.toUpperCase().replaceAll("-", "_")}`;
}

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
): { target: AuxTarget; source: "settings" | "env" | "code" } {
  const fromSettings = settings.aux?.[purpose];
  const parsedSettings = fromSettings ? parseAuxSpec(fromSettings) : null;
  if (parsedSettings) return { target: parsedSettings, source: "settings" };
  const envName = auxEnvName(purpose);
  const raw = (process.env[envName] || "").trim();
  if (raw) {
    const parsed = parseAuxSpec(raw);
    if (parsed) return { target: parsed, source: "env" };
    if (!quiet) console.warn(`[AuxModel] Ungueltiges Format fuer ${envName}: "${raw}" — nutze Default`);
  }
  return { target: PURPOSE_DEFAULTS[purpose], source: "code" };
}

/**
 * Ziel eines Aufrufs. Mit Resume immer Claude: nur die CLI kann Sessions
 * resumen, dann gilt der Claude-Default des jeweiligen Purpose.
 */
export function resolveAuxTarget(purpose: AuxPurpose, resume: boolean): AuxTarget {
  const target = resolveAux(purpose);
  if (!resume || target.kind === "claude") return target;
  return PURPOSE_DEFAULTS[purpose].kind === "claude"
    ? PURPOSE_DEFAULTS[purpose]
    : { kind: "claude", model: DEFAULT_CLAUDE_AUX };
}

export interface AuxResult {
  text: string;
  isError: boolean;
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
