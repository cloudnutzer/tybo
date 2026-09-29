/**
 * Gemeinsame Befehls-Schicht (Issue #74, Entscheidung 0013): Typen.
 *
 * Ein Befehl ist einmal beschrieben und läuft in Telegram, im Browser und im
 * Terminal. Was je Kanal verschieden ist (Antworten senden, Session-Reset,
 * Agenten-Turn), bringt der Kontext mit; die übrigen Funktionen (Anweisungen,
 * Goal-Engine, Wissen) kommen als CommandServices herein, damit Tests ohne
 * src/bot.ts auskommen.
 *
 * Nur Typen, keine Laufzeit-Importe.
 */

import type { GoalAction, GoalActionResult } from "../goal-actions";
import type { ActiveGoal } from "../goal-engine";

export type CommandChannel = "telegram" | "web" | "terminal";

export const ALL_CHANNELS: readonly CommandChannel[] = ["telegram", "web", "terminal"];

/**
 * Argumente: "none" nur der Befehl allein ("/new foo" ist kein Befehl und
 * geht wie bisher als Text an Claude), "optional" mit oder ohne, "required"
 * nur mit ("/critic" allein ist kein Befehl).
 */
export type CommandArgMode = "none" | "optional" | "required";

export interface CommandButton {
  label: string;
  /** In Telegram callback_data */
  action: string;
}

export interface ReplyOptions {
  /** "plain" (Standard) geht als Klartext, "markdown" in Telegram als HTML mit Klartext-Rückfall */
  format?: "plain" | "markdown";
  /** Nur mit "markdown": Klartext, falls Telegram das HTML ablehnt (Standard: der Text selbst) */
  plainFallback?: string;
}

export type SessionResetOutcome =
  | { status: "done"; reset: number; sessionMode: boolean }
  /** Im Gespräch läuft gerade eine Antwort: Browser und Terminal immer, Telegram nur mit whileBlocked */
  | { status: "busy" }
  /** Kein Session-Schlüssel ermittelbar */
  | { status: "unavailable" };

export interface SessionResetOptions {
  /**
   * Läuft nach dem Reset, solange neue Ausführungen des Gesprächs noch
   * gesperrt sind (/motor schreibt hier die Einstellung, Issue #125): kein
   * Turn kann zwischen Reset und Schreiben mit dem alten Motor beginnen.
   * Mit dieser Angabe lehnt auch Telegram ab („busy"), solange im Gespräch
   * eine Antwort läuft. Wirft sie, gibt resetSession den Fehler weiter.
   */
  whileBlocked?(): Promise<void>;
}

/** Laufende Session eines Gesprächs für /routine (gleich welcher Motor); Aufbau kennt nur der Dienst */
export type RoutineSession = { readonly engineSessionId?: string | null; readonly lastActivity: number };

export interface CommandServices {
  isSessionModeEnabled(): boolean;
  getGoal(sessionKey: string): Promise<{ status: string } | undefined>;
  pauseGoal(sessionKey: string, reason: string): Promise<unknown>;
  /** Bricht laufende Claude-Aufrufe unter dem Schlüssel ab, Anzahl zurück */
  abortEngineCalls(sessionKey: string): number;
  /** Anweisungen aller aktiven Agenten (gelöschte Agenten fehlen) */
  listAllOverrides(): Record<string, string[]>;
  listAgentNames(): string[];
  /** Kennung zu Name oder Alias, nur aktive Agenten */
  resolveAgentName(raw: string): string | undefined;
  getAgentOverrides(agent: string): string[];
  /** onWriteStart laeuft in der Schreibkette vor dem Lesen; wirft er, wird nichts geschrieben */
  clearAgentOverrides(agent: string, onWriteStart?: () => void): Promise<number>;
  removeLastAgentOverride(agent: string, onWriteStart?: () => void): Promise<string | undefined>;
  addAgentOverride(agent: string, text: string, onWriteStart?: () => void): Promise<number>;
  topicMapping(chatId: string): Record<string, string>;
  topicNames(): Promise<Record<string, string>>;
  listGoals(): Promise<string>;
  /** onWriteStart laeuft direkt vor dem Speichern; wirft er, wird nichts gespeichert */
  learn(input: string, onWriteStart?: () => void): Promise<{ message: string }>;
  formatPlan(): Promise<string>;
  sessionsForKey(sessionKey: string): Promise<RoutineSession[]>;
  /**
   * Epoche des Session-Schlüssels (Issue #189, session-manager.ts): /routine
   * erfasst sie vor der Session-Auswahl und reicht sie an createRoutine durch,
   * damit ein /new während der Startmeldung die Session nicht zurückbringt
   */
  sessionEpoch?(sessionKey: string): number;
  createRoutine(session: RoutineSession, hint: string, epoch?: number): Promise<{ isError?: boolean; text?: string }>;
  /**
   * Stopp für eine laufende Board-Sitzung unter dem Schlüssel (Issue #75,
   * src/lib/board-meeting.ts requestBoardStop): "requested" endet nach dem
   * laufenden Beitrag, "again" (schon angefragt) bricht /stop hart ab
   */
  requestBoardStop?(sessionKey: string): "requested" | "again" | "none";
  /** /goal (Issue #76): Goal-Engine und gemeinsame Aktionen; fehlt, meldet /goal das */
  goals?: GoalCommandServices;
  /**
   * /jobs (Issue #103): Übersicht der Hintergrund-Jobs als Klartext; fehlt,
   * liest der Befehl data/jobs im Projektordner selbst
   */
  jobsOverview?(): Promise<string>;
  /** /voice in Telegram: Antwort als Sprachnachricht; fehlt außerhalb von Telegram (dort ctx.voiceMessage) */
  voiceReply?(ctx: CommandContext, text: string): Promise<void>;
  /** /motor (Issue #125): Motor-Wahl in config/settings.json; fehlt, meldet /motor das */
  engines?: EngineCommandServices;
}

/** Woher der Motor eines Gesprächs kommt: /motor, Einstellungsdatei, .env oder eingebaut */
export type EngineChoiceSource = "topic" | "settings" | "env" | "code";

/** Ein wählbarer Motor mit Bereitschaft (src/lib/engine-choice.ts) */
export interface EngineAvailability {
  engine: string;
  label: string;
  ready: boolean;
  /** Warum nicht bereit, verständlich */
  message?: string;
}

/** src/lib/engine-choice.ts, für /motor in allen Kanälen */
export interface EngineCommandServices {
  /** Eingestellter Motor des Gesprächs, ohne Verfügbarkeitsprüfung */
  configured(sessionKey: string): { engine: string; source: EngineChoiceSource };
  /** Standard ohne Ausnahme */
  standard(): { engine: string; source: Exclude<EngineChoiceSource, "topic"> };
  /** Wählbare Motoren mit Bereitschaft */
  available(): Promise<EngineAvailability[]>;
  /** Ausnahme setzen (engine) oder entfernen (null); wirft SettingsFileInvalidError bei ungültiger Datei */
  setTopic(sessionKey: string, engine: string | null): Promise<void>;
}

/** Ergebnis einer Sprachsynthese (Issue #78); Endung und MIME-Typ aus den Bytes (src/lib/audio-type.ts) */
export interface SynthesizedAudio {
  audio: Buffer;
  mime: string;
  fileName: string;
}

/** Sprachsynthese für /voice aus Browser und Terminal (src/lib/voice-message.ts) */
export interface VoiceSynthesis {
  /** Lokales TTS, ElevenLabs oder Gemini eingerichtet */
  enabled(): boolean;
  /** null: Synthese fehlgeschlagen oder kein brauchbares Audio */
  synthesize(text: string): Promise<SynthesizedAudio | null>;
}

/** Ausgang von VoiceMessagePort.send */
export type VoiceMessageResult = "sent" | "failed" | "aborted";

/**
 * /voice aus Browser und Terminal (Issue #78): Sprachnachricht in das
 * gespiegelte Telegram-Gespräch. Nur in Gesprächen mit Telegram-Ziel.
 */
export interface VoiceMessagePort {
  enabled(): boolean;
  /**
   * Synthese der Antwort und Versand als Sprachnachricht über den Haupt-Bot.
   * Ein Stopp bis zum Versand verwirft das Audio ("aborted").
   */
  send(text: string): Promise<VoiceMessageResult>;
}

/** src/lib/goal-engine.ts und src/lib/goal-actions.ts, für /goal in allen Kanälen */
export interface GoalCommandServices {
  get(sessionKey: string): Promise<ActiveGoal | undefined>;
  set(goal: { sessionKey: string; chatId: string; topicId?: number; agentName: string; goal: string }): Promise<ActiveGoal>;
  update(sessionKey: string, patch: Partial<Pick<ActiveGoal, "gates" | "maxTurns">>): Promise<ActiveGoal | undefined>;
  /** Wie die Knöpfe (Telegram und Status-Karte): pause, resume (/goal weiter), stop */
  action(sessionKey: string, action: GoalAction): Promise<GoalActionResult>;
  /** Arbeit am frisch gesetzten Ziel beginnen, im Hintergrund */
  start(sessionKey: string): void;
  formatStatus(goal: ActiveGoal | undefined): string;
}

export interface AgentTurnOptions {
  /** metadata.type der gespeicherten Antwort, z. B. "voice_reply" (Issue #78) */
  replyType?: string;
}

export interface CommandContext {
  channel: CommandChannel;
  /** Telegram-Chat (Direktchat oder Forum-Gruppe), bei älteren Web-Gesprächen web:<id> */
  chatId: string;
  /** Topic-ID (Telegram message_thread_id), fehlt bei Direktchat und General */
  topicId?: number;
  sessionKey: string;
  /** Agent des Gesprächs */
  agent: string;
  /** Kanonischer Name des Befehls ohne Schrägstrich */
  name: string;
  /** Text nach dem Befehl, getrimmt */
  args: string;
  /** Die ganze Nachricht */
  text: string;
  reply(text: string, options?: ReplyOptions): Promise<void>;
  /** Zwischenstand (z. B. „Ich lese die Quelle …"), Klartext */
  notice(text: string): Promise<void>;
  /** Text mit Knöpfen; außerhalb von Telegram nur als Text mit den Beschriftungen */
  buttons(text: string, rows: CommandButton[][]): Promise<void>;
  /** Tippt-Anzeige für längere Arbeit; gibt die Stopp-Funktion zurück */
  working(): () => void;
  /** /new, /motor: Session des Gesprächs zurücksetzen (endende Sessions vorher destilliert) */
  resetSession(options?: SessionResetOptions): Promise<SessionResetOutcome>;
  /**
   * Modellgestützte Befehlsarbeit (z. B. /critic): Prompt an einen Agenten,
   * Antwort wie ein normaler Turn. Browser und Terminal geben die gespeicherte
   * Antwort zurück (undefined bei Stopp, Abbruch oder leerer Antwort),
   * Telegram immer undefined.
   */
  agentTurn(agent: string, prompt: string, options?: AgentTurnOptions): Promise<string | undefined>;
  /** /board: Board-Sitzung im Gespräch (src/lib/board-meeting.ts), Thema leer ohne Thema */
  boardMeeting(extraContext: string): Promise<void>;
  /**
   * Nur Browser und Terminal: verbindlicher Beginn einer Änderung (/agent, /learn).
   * Wirft nach einem Stopp (AbortError); danach gilt der Befehl als
   * ausgeführt und seine Antwort bleibt sichtbar.
   */
  beginWrite?(): void;
  /** Nur Browser und Terminal in mit Telegram gespiegelten Gesprächen: Sprachnachricht dorthin (/voice) */
  voiceMessage?: VoiceMessagePort;
  services: CommandServices;
}

export interface CommandDefinition {
  /** Ohne Schrägstrich, klein */
  name: string;
  /** Weitere Namen mit Schrägstrich (/reset, /hilfe …), ohne Schrägstrich angegeben */
  aliases: string[];
  /** Nur Telegram: ganze Nachricht ohne Schrägstrich (wie bisher „goals") */
  bareWords?: string[];
  description: string;
  args: CommandArgMode;
  /**
   * Nur Telegram: Zeichen direkt nach dem Namen, mit denen Argumente beginnen
   * dürfen, wie in der früheren if-Kette von src/bot.ts. Standard nur das
   * Leerzeichen; Browser und Terminal nehmen jeden Leerraum.
   */
  telegramArgSeparators?: readonly string[];
  /** Kurzform der Argumente für Hilfe und Autovervollständigung, z. B. „<idee>" */
  argsHint?: string;
  channels: readonly CommandChannel[];
  /**
   * Läuft auch, während im Gespräch eine Antwort läuft (/stop). Alle anderen
   * Befehle warten in Browser und Terminal wie eine Nachricht.
   */
  whileBusy?: boolean;
  /**
   * Browser und Terminal: mit diesen Argumenten ohne den Bereich unter dem
   * Session-Schlüssel laufen (/goal stop bricht Aufrufe dieses Schlüssels ab
   * und träfe sonst sich selbst), wie in Telegram handleUpdateScope. Solche
   * Aufrufe gelten zugleich als whileBusy: sie laufen auch während einer
   * Antwort oder [INVOKE:]-Rückfrage im Gespräch
   */
  unscoped?(args: string): boolean;
  run(ctx: CommandContext): Promise<void>;
}

export interface CommandMatch {
  command: CommandDefinition;
  /** Wie getippt, klein, ohne Schrägstrich (z. B. "reset" für /new) */
  invoked: string;
  args: string;
}

/** Eintrag für GET /api/commands */
export interface CommandInfo {
  name: string;
  aliases: string[];
  description: string;
  args: CommandArgMode;
  argsHint?: string;
}
