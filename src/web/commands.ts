/**
 * Slash-Befehle aus Browser und Terminal (Issue #74, Entscheidung 0013).
 *
 * Beginnt eine Nachricht mit einem registrierten Befehl, führt der Server
 * ihn aus statt eines Claude-Turns. Die Befehle selbst stehen in
 * src/lib/commands; der Web-Server kennt nur diesen Port, den src/bot.ts
 * mit createBotCommands (./bot-commands.ts) einbindet. Ohne Port geht
 * jede Nachricht wie bisher an den Chat.
 *
 * Nur Typen und Texte, nichts aus src/lib zur Laufzeit.
 */

import type { TurnSink } from "../lib/chat-turn";
import type { MessageSource } from "./chat";
import type { ReplyInfo } from "./store";

/** Absender der gespeicherten Befehlsantworten (metadata.source) */
export const COMMAND_NOTICE_SOURCE = "befehl";

export const COMMANDS_TEXT = {
  notConfigured: "Befehle sind nicht eingerichtet",
  replyNotSent: "Die Antwort des Befehls konnte nicht nach Telegram gesendet werden.",
  failed: "Der Befehl ist fehlgeschlagen.",
  boardUnavailable: "Board-Sitzungen sind hier nicht eingerichtet.",
} as const;

/** Eintrag für GET /api/commands */
export interface CommandListEntry {
  name: string;
  aliases: string[];
  description: string;
  /** "none", "optional" oder "required" */
  args: string;
  argsHint?: string;
}

export interface CommandMatchInfo {
  name: string;
  /** Läuft auch während einer laufenden Antwort (/stop) */
  whileBusy: boolean;
}

/**
 * Was der ChatHub einem Befehl mitgibt. notice und answer legen im eigenen
 * Verlauf ab (ältere Web-Gespräche) und zeigen live; in Telegram-Gesprächen
 * nur live, gespeichert wird dort über den Nachrichtenspeicher.
 */
export interface CommandExecution {
  /** ID der abgelegten Nutzernachricht */
  messageId: string;
  /** Eingangszeitpunkt der Nutzernachricht */
  receivedAt: string;
  /** Abgebrochen über Stopp-Knopf oder Beenden */
  signal: AbortSignal;
  /** Fortschritt eines Agenten-Turns (z. B. /critic) */
  sink: TurnSink;
  notice(text: string): Promise<void>;
  /**
   * Antwort eines Agenten (/critic). messageId: ID der Antwort im
   * Nachrichtenspeicher (metadata.msgId), damit Live und Verlauf dieselbe ID tragen
   */
  answer(text: string, info?: ReplyInfo, messageId?: string): Promise<void>;
  /** Werkzeug-Freigabe als Rückfrage im Verlauf, wie bei einem Turn (RunTurnOptions.ask) */
  ask(question: string, choiceId: string, options?: { record?: boolean }): Promise<void>;
  endAsk(choiceId: string): void;
  /** Ab hier verbindlich (Antwort wird gespeichert): der Stopp-Knopf lehnt ab */
  commit(): void;
  /**
   * Nacharbeit nach der verbindlichen Antwort (Issue #78, /voice: Synthese
   * und Versand). Ab hier nimmt der Stopp-Knopf wieder an und bricht nur
   * diese Nacharbeit über das gelieferte Signal ab; die Antwort bleibt.
   */
  followUp?(): AbortSignal;
}

export interface CommandRequest extends CommandExecution {
  conversationId: string;
  /** Agent des Gesprächs */
  agent: string;
  text: string;
  source: MessageSource;
  /** Titel eines reinen Web-Gesprächs, für den Hinweis an der Telegram-Kopie einer Freigabe */
  title?: string;
}

export interface CommandOutcome {
  /** Fehlertext für den Verlauf; die Wirkung des Befehls ist dann ausgeblieben oder unvollständig */
  failed?: string;
  /** Die Arbeit des Befehls wurde abgebrochen (Stopp); der Verlauf bekommt „Abgebrochen." */
  aborted?: boolean;
}

export interface CommandPort {
  list(channel: MessageSource): CommandListEntry[];
  /** null: kein Befehl, die Nachricht geht an den Chat */
  match(text: string, channel: MessageSource): CommandMatchInfo | null;
  run(request: CommandRequest): Promise<CommandOutcome>;
}
