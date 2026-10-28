/**
 * Motor-Schnittstelle (Entscheidung 0018, Issue #121): ein Chat-Turn läuft
 * über einen Motor: Claude Code, Codex (Issue #123), OpenCode (Issue #127)
 * oder die Anthropic API (Issue #347), alle hinter derselben Schnittstelle.
 */

import type { RunStep } from "../claude";
import type { TurnTools } from "../turn-tools";
import type { StallPhase } from "../stream-phase";

export type EngineId = "claude" | "codex" | "opencode" | "api";

export const ENGINE_IDS: readonly EngineId[] = ["claude", "codex", "opencode", "api"];

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
  /**
   * Der Prompt ist die Antwort auf eine Rückfrage des Registers (Knopf,
   * task-resume.ts). Motor api: eine schon beantwortete Rückfrage wird dann
   * nicht noch einmal fortgesetzt. Schließt questions ein: wer per Knopf
   * fortsetzt, legt eine Folgefrage selbst im Register an. Andere Motoren
   * ignorieren das Feld.
   */
  answersQuestion?: boolean;
  /**
   * Der Aufrufer legt eine Rückfrage aus der Antwort im Register an (Chat-Kern
   * mit onQuestion). Nur dann bietet der Motor api ask_user an, und nur dann
   * beantwortet der Prompt eine offene Pause. Ohne Angabe (Konsultation,
   * Denkauftrag, Befehl, Anruf, jeder künftige Aufrufer) bleibt eine offene
   * Pause offen und es entsteht keine neue: die Freigabe muss ausdrücklich
   * kommen, nicht das Verbot (Issue #348).
   */
  questions?: boolean;
  /**
   * Turn ohne Telegram (Denkauftrag aus dem Telefonhörer, Issue #259) im
   * WebUI-Gespräch conversationId: Planungswerkzeuge des Motors api legen
   * Erinnerungen dann wie [REMIND:] nur für die WebUI an.
   */
  noTelegram?: { conversationId: string };
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
  /**
   * Nur Motor api: dieser Lauf hat die offene Rückfrage beantwortet, die
   * unter dieser sessionId gestellt wurde. Der Chat-Kern schließt damit die
   * Rückfrage im Register, wenn die Antwort getippt kam.
   */
  answeredQuestion?: string;
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
  /** Nur Claude streaming bei timedOut: wo der Lauf hing (API, Modell, Werkzeug) */
  stallPhase?: StallPhase;
}

export interface Engine {
  id: EngineId;
  run(request: EngineRequest): Promise<EngineResult>;
  /** Anzeigename, etwa „Claude Code" */
  describe(): string;
}
