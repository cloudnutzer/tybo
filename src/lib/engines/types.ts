/**
 * Motor-Schnittstelle (Entscheidung 0018, Issue #121): ein Chat-Turn läuft
 * über einen Motor: Claude Code, Codex (Issue #123) oder OpenCode (Issue #127),
 * alle hinter derselben Schnittstelle.
 */

import type { RunStep } from "../claude";
import type { TurnTools } from "../turn-tools";

export type EngineId = "claude" | "codex" | "opencode";

export const ENGINE_IDS: readonly EngineId[] = ["claude", "codex", "opencode"];

export interface EngineRequest {
  prompt: string;
  /** true: Fortschritt während des Laufs (Rückrufe, Leerlauf-Grenze); false: Ergebnis am Ende */
  streaming: boolean;
  /** Modell des Motors; fehlt: Standard des Motors */
  model?: string;
  /** Effort-Stufe; fehlt: Standard des Motors */
  effort?: string;
  /** Session des Motors fortsetzen */
  resumeSessionId?: string;
  /** Obergrenze der Gesamtzeit */
  timeoutMs: number;
  /**
   * Nur streaming: so lange ohne Lebenszeichen des Motors wird der Lauf
   * beendet (timeoutKind "idle"). Fehlt: nur timeoutMs gilt.
   */
  idleTimeoutMs?: number;
  cwd: string;
  /** Schlüssel für /stop (abortEngineCalls); meist der Session-Schlüssel des Gesprächs */
  abortKey?: string;
  allowedTools?: string[];
  maxTurns?: number;
  /** Nur streaming: ein Werkzeug startet (Anzeigename), gedrosselt */
  onToolStart?: (toolName: string) => void;
  /** Nur streaming: erster Textblock; fullText ist der ungekürzte Block */
  onFirstText?: (snippet: string, fullText: string) => void;
}

/** Token-Verbrauch eines Laufs, soweit der Motor ihn meldet */
export interface EngineUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  /** Codex und OpenCode: Anteil der Ausgabe fürs Nachdenken (reasoning_output_tokens bzw. tokens.reasoning) */
  reasoningOutputTokens?: number;
}

/**
 * Art eines Motor-Fehlers, soweit erkennbar (Codex, Issue #123): Grundlage
 * für Hinweise wie „Nutzungsgrenze erreicht" oder „nicht angemeldet".
 */
export type EngineErrorKind =
  | "usage_limit"
  | "rate_limit"
  | "quota"
  | "capacity"
  | "auth"
  | "context"
  | "not_installed"
  | "other";

export interface EngineResult {
  engine: EngineId;
  text: string;
  sessionId?: string;
  isError: boolean;
  /** Nur bei isError und nur, wenn der Motor sie meldet (Codex, OpenCode) */
  errorKind?: EngineErrorKind;
  costUsd?: number;
  usage?: EngineUsage;
  /** Per /stop oder Shutdown beendet: kein Retry, kein Fallback */
  aborted?: boolean;
  /** Zeitlimit gegriffen: kein Retry, kein Fallback, Session bleibt fortsetzbar */
  timedOut?: boolean;
  /** Nur streaming bei timedOut: Leerlauf oder Obergrenze */
  timeoutKind?: "idle" | "total";
  /** Werkzeuge des Laufs; undefined heißt unbekannt, nicht leer */
  tools?: TurnTools;
  /** Nur streaming bei timedOut: die letzten Werkzeugschritte, Eingabe ungekürzt */
  steps?: RunStep[];
  /** Nur streaming bei timedOut: letzter Textblock, ungekürzt */
  lastText?: string;
  /** Nur streaming bei timedOut: Laufzeit bis zum Abbruch */
  stoppedAfterMs?: number;
  /** Nur streaming bei timedOut: Zeit seit dem letzten Lebenszeichen */
  idleForMs?: number;
}

export interface Engine {
  id: EngineId;
  run(request: EngineRequest): Promise<EngineResult>;
  /** Anzeigename, etwa „Claude Code" */
  describe(): string;
}
