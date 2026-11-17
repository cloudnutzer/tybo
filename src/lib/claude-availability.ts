/**
 * Ist Claude Code da (Issue #566)? Ein Server nur mit Codex hat kein
 * Claude-Konto. Hintergrund-Jobs und alle Nebenaufgaben, die über Claude
 * laufen, scheiterten dann bei jeder Antwort. Stattdessen prüft der Bot beim
 * Start einmal (checkClaudeBeforeWork in src/app/bot-start.ts, abgewartet
 * vor WebUI, Anrufen, Zielen und Polling), merkt sich das Ergebnis und
 * schreibt genau eine Logzeile, was abgeschaltet ist und was über OpenRouter
 * oder Ollama weiterläuft. callAux wartet zusätzlich auf eine laufende
 * Prüfung (whenClaudeChecked).
 *
 * Zustände: unknown (noch nicht geprüft, etwa in Tests und kurzen Skripten;
 * alles läuft wie bisher), ready, unclear, missing. Als fehlend zählt Claude
 * nur, wenn die Prüfung es sicher sagt: Befehl nicht gefunden (Startfehler
 * ENOENT oder ENOTDIR, Exit 127) oder ausdrücklich nicht angemeldet.
 * Zeitlimit, anderer Exit-Code, andere Startfehler (etwa EAGAIN, EMFILE,
 * ENOMEM, ohne Code), gescheiterte Prüfung (unclear) und unbekannte Anmeldung
 * schalten nichts ab.
 * Gilt bis zum nächsten Start; wer Claude nachträglich anmeldet, startet den
 * Bot neu.
 *
 * Wirkung: callAux (src/lib/aux-model.ts) ruft für ein Claude-Ziel nichts
 * auf und meldet disabled; die Aufrufer (Richter, Fäden, Check-in) behandeln
 * das ohne Fehlerzeilen und ohne Wiederholung. Die Regel für Hintergrund-Jobs
 * fehlt dann im Prompt (src/agents/catalog.ts). Codex-Sessions destillieren
 * weiter über ihren eigenen Motor (src/lib/session-distill.ts).
 */

import { AUX_PURPOSE_LABELS, AUX_PURPOSES, auxEnvName, describeAuxFrom, type AuxPurpose, type AuxTarget } from "./aux-targets";
import type { EngineStatus } from "./engines/check";
import type { Settings } from "./settings";

/**
 * Meldung von inspectEngine("claude"), wenn der Befehl sicher fehlt
 * (engines/check.ts gibt sie weiter). Steht hier, damit die Einstufung ohne
 * den schweren Import von check.ts auskommt
 */
export const CLAUDE_NOT_INSTALLED =
  "Claude Code ist nicht installiert: der Befehl claude wurde nicht gefunden (anderer Pfad über CLAUDE_PATH in .env)";

/** unclear: geprüft, aber ohne sicheres Ergebnis (Zeitlimit, Exit-Code, Prüffehler); alles bleibt an */
export type ClaudeAvailability = { state: "unknown" } | { state: "ready" } | { state: "unclear" } | { state: "missing"; reason: string };

let current: ClaudeAvailability = { state: "unknown" };
/** Laufende Startprüfung; callAux wartet auf sie, bevor es entscheidet */
let pending: Promise<unknown> | null = null;

/** Wartet auf eine laufende Prüfung (sofort fertig, wenn keine läuft) */
export async function whenClaudeChecked(): Promise<void> {
  if (pending) await pending.catch(() => {});
}

export function claudeAvailability(): ClaudeAvailability {
  return current;
}

/** true nur nach einer Prüfung, die Claude sicher als fehlend erkannt hat */
export function claudeMissing(): boolean {
  return current.state === "missing";
}

export function setClaudeAvailability(next: ClaudeAvailability): void {
  current = next;
}

/** Nur für Tests */
export function resetClaudeAvailabilityForTests(): void {
  current = { state: "unknown" };
  pending = null;
}

/** Grund, wenn Claude fehlt; die Meldungen aus engines/check.ts enthalten keine Kontodaten */
const NOT_INSTALLED = "Claude CLI nicht installiert";
const NOT_LOGGED_IN = "Claude nicht angemeldet";

/**
 * Ergebnis von inspectEngine("claude") als Zustand. installed=false heißt
 * dort nicht immer „nicht installiert“: auch ein Zeitlimit, ein anderer
 * Exit-Code von claude --version oder eine gescheiterte Prüfung liefern es.
 * Als nicht installiert zählt nur, was die Prüfung sicher so meldet
 * (Startfehler ENOENT oder ENOTDIR oder Exit 127, Meldung
 * CLAUDE_NOT_INSTALLED); vorübergehende oder unbekannte Startfehler meldet
 * check.ts mit einer anderen Meldung. Alles
 * andere ist unklar und schaltet nichts ab, ebenso eine unbekannte Anmeldung.
 */
export function availabilityFromStatus(status: EngineStatus): ClaudeAvailability {
  if (!status.installed) return status.message === CLAUDE_NOT_INSTALLED ? { state: "missing", reason: NOT_INSTALLED } : { state: "unclear" };
  if (!status.loggedIn && !status.loginUnknown) return { state: "missing", reason: NOT_LOGGED_IN };
  return { state: "ready" };
}

/**
 * Wird geworfen, wenn eine Nebenaufgabe abgeschaltet ist (callAux meldet
 * disabled). Aufrufer erkennen es mit isClaudeUnavailable und versuchen es
 * nicht erneut; message ist für den Nutzer gedacht.
 */
export class ClaudeUnavailableError extends Error {
  readonly disabled = true;
  constructor(message: string) {
    super(message);
    this.name = "ClaudeUnavailableError";
  }
}

export function isClaudeUnavailable(error: unknown): error is ClaudeUnavailableError {
  return error instanceof ClaudeUnavailableError;
}

export interface AuxPlanEntry {
  purpose: AuxPurpose;
  target: AuxTarget;
  /** OpenRouter ohne OPENROUTER_API_KEY: eingestellt, scheitert aber */
  missingKey?: true;
}

export interface AuxPlan {
  /** Zwecke mit Claude-Ziel: ohne Claude abgeschaltet */
  onClaude: AuxPurpose[];
  /** Zwecke auf OpenRouter oder Ollama: laufen ohne Claude weiter */
  elsewhere: AuxPlanEntry[];
}

/**
 * Welche Nebenaufgabe wohin geht, je tatsächlich aufgelöstem Ziel
 * (Einstellungen vor AUX_MODEL_* vor Standard; ungültige Werte zählen wie
 * keine). Ohne Resume: das Destillat einer Claude-Session gibt es ohne
 * Claude ohnehin nicht, das einer Codex-Session läuft über Codex.
 */
export function auxPlan(settings: Settings, env: Record<string, string | undefined>): AuxPlan {
  const onClaude: AuxPurpose[] = [];
  const elsewhere: AuxPlanEntry[] = [];
  for (const purpose of AUX_PURPOSES) {
    const { target } = describeAuxFrom(purpose, settings, env);
    if (target.kind === "claude") onClaude.push(purpose);
    else elsewhere.push({ purpose, target, ...(target.kind === "openrouter" && !env.OPENROUTER_API_KEY?.trim() ? { missingKey: true as const } : {}) });
  }
  return { onClaude, elsewhere };
}

const KIND_LABEL: Record<AuxTarget["kind"], string> = { claude: "Claude", openrouter: "OpenRouter", ollama: "Ollama" };

function labels(purposes: AuxPurpose[]): string {
  return purposes.map(p => AUX_PURPOSE_LABELS[p]).join(", ");
}

/**
 * Was ohne Claude nicht läuft, als ein Satz für Einrichtung und Log. Nennt
 * nie eine Nebenaufgabe als abgeschaltet, die über OpenRouter oder Ollama
 * läuft.
 */
export function withoutClaudeSentence(plan: AuxPlan): string {
  if (plan.elsewhere.length === 0) return "Hintergrund-Jobs und Nebenaufgaben laufen nicht.";
  if (plan.onClaude.length === 0) return "Hintergrund-Jobs laufen nicht, die Nebenaufgaben laufen über OpenRouter oder Ollama.";
  return `Hintergrund-Jobs und die Nebenaufgaben auf Claude laufen nicht (${labels(plan.onClaude)}).`;
}

/** Die eine Logzeile beim Start, wenn Claude fehlt; ohne Modellnamen und ohne Werte */
export function claudeMissingLogLine(reason: string, plan: AuxPlan): string {
  const parts = [`[Claude] ${reason}: Hintergrund-Jobs sind abgeschaltet.`];
  if (plan.onClaude.length) {
    parts.push(`Abgeschaltet, weil sie über Claude liefen: ${labels(plan.onClaude)}.`);
    parts.push(`Einschalten mit einem anderen Nebenmodell, etwa ${auxEnvName(plan.onClaude[0])}=openrouter:<modell> in .env oder in der WebUI unter Modelle.`);
  }
  const working = plan.elsewhere.filter(e => !e.missingKey);
  const broken = plan.elsewhere.filter(e => e.missingKey);
  if (working.length) parts.push(`Laufen weiter: ${working.map(e => `${AUX_PURPOSE_LABELS[e.purpose]} (${KIND_LABEL[e.target.kind]})`).join(", ")}.`);
  if (broken.length) parts.push(`Auf OpenRouter eingestellt, aber OPENROUTER_API_KEY fehlt: ${labels(broken.map(e => e.purpose))}.`);
  return parts.join(" ");
}

export interface ClaudeStartCheckDeps {
  inspect(): Promise<EngineStatus>;
  getSettings(): Settings;
  env(): Record<string, string | undefined>;
  log(line: string): void;
}

/**
 * Prüfung beim Start: Ergebnis merken, bei fehlendem Claude genau eine
 * Logzeile. Scheitert die Prüfung selbst, bleibt der Zustand unbekannt
 * (vorsichtig: lieber ein Fehler bei einer Nebenaufgabe als eine
 * fälschlich abgeschaltete).
 */
export function checkClaudeAtStart(deps: ClaudeStartCheckDeps): Promise<ClaudeAvailability> {
  const run = (async (): Promise<ClaudeAvailability> => {
    let status: EngineStatus;
    try {
      status = await deps.inspect();
    } catch {
      return current;
    }
    const next = availabilityFromStatus(status);
    setClaudeAvailability(next);
    if (next.state === "missing") deps.log(claudeMissingLogLine(next.reason, auxPlan(deps.getSettings(), deps.env())));
    return next;
  })();
  const tracked = run.finally(() => {
    if (pending === tracked) pending = null;
  });
  pending = tracked;
  return run;
}

/** Echte Bausteine: inspectEngine("claude") und die Einstellungen; erst beim Aufruf geladen */
export async function defaultClaudeStartCheckDeps(): Promise<ClaudeStartCheckDeps> {
  const [{ inspectEngine }, { getSettings }] = await Promise.all([import("./engines/check"), import("./settings")]);
  return {
    inspect: () => inspectEngine("claude"),
    getSettings,
    env: () => process.env,
    log: line => console.warn(line),
  };
}

/**
 * Für Prozesse außerhalb des Bots (Check-in): einmal prüfen, wenn noch
 * unbekannt. Liefert den Zustand danach.
 */
export async function ensureClaudeChecked(deps?: ClaudeStartCheckDeps): Promise<ClaudeAvailability> {
  if (current.state !== "unknown") return current;
  return checkClaudeAtStart(deps ?? (await defaultClaudeStartCheckDeps()));
}
