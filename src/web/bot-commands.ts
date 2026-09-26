/**
 * Slash-Befehle aus Browser und Terminal (Issue #74, Entscheidung 0013):
 * führt die Befehle der gemeinsamen Schicht (src/lib/commands) für ein
 * Gespräch der WebUI aus. Nur src/bot.ts bindet diese Datei ein; alle
 * Aufrufe nach außen kommen als Abhängigkeiten herein.
 *
 * Telegram-Gespräche (Direktchat, Topics):
 *  1. Spiegeln wie eine Nachricht („Du (Web): /new", „Du (Terminal): …").
 *     Scheitert das, bleibt der Befehl ohne Wirkung (Fehler im Verlauf).
 *  2. Nutzernachricht im Nachrichtenspeicher, mit der ID aus dem ChatHub und
 *     dem Eingangszeitpunkt, wie ein Befehl aus Telegram.
 *  3. Befehl ausführen. Antworten gehen über den Haupt-Bot nach Telegram und
 *     werden als Meldung festgehalten (display_only, source "befehl",
 *     src/lib/outbox.ts); die WebUI zeigt sie live über den Nachrichten-Feed
 *     und nach dem Neuladen aus dem Verlauf, jeweils einmal.
 *  Modellgestützte Arbeit (/critic) läuft wie ein Web-Turn unter dem
 *  Telegram-Schlüssel; die Antwort kommt vom Agenten-Bot und live mit
 *  derselben msgId wie im Verlauf.
 *  Ein Stopp (Knopf, Strg+C, /stop) bricht den ganzen Ablauf ab: bis zum
 *  Ende des Speicherns ohne jede Wirkung, danach ohne weitere Antworten.
 *  /new gilt ab dem Beginn des Resets als ausgeführt, /agent ab dem Beginn
 *  des Schreibens in der Schreibkette; dessen Antwort bleibt dann sichtbar.
 *  /board (Issue #75): jeder Beitrag live als eigene Nachricht mit Sprecher
 *  und derselben msgId wie im Nachrichtenspeicher, in Telegram vom Bot des
 *  Agenten. Ab dem Start der Sitzung beendet ein Stopp sie erst nach dem
 *  laufenden Beitrag (src/lib/board-meeting.ts); ein zweites /stop bricht hart ab.
 *  /goal (Issue #76): Antworten wie oben; die Arbeit am Ziel läuft danach im
 *  Hintergrund weiter, ihre Meldungen und die Status-Karte kommen über
 *  ./bot-goals.ts. /goal pause und /goal stop laufen ohne den Bereich.
 *  /voice (Issue #78): ein Turn wie /critic (Antwort mit type "voice_reply"),
 *  danach Synthese und Sprachnachricht über den Haupt-Bot ins Telegram-
 *  Gespräch. Während der Synthese nimmt der Stopp-Knopf wieder an
 *  (CommandExecution.followUp) und verwirft nur die Sprachnachricht.
 *
 * Ältere reine Web-Gespräche haben kein Telegram-Ziel: nichts wird
 * gespiegelt, Antworten landen als Meldung im eigenen Verlauf.
 */

import { BOARD_TEXT, createTelegramBoardOutput, requestBoardStop, runBoardMeeting, type BoardDeps, type BoardEnd, type BoardOutput } from "../lib/board-meeting";
import { ABORT_REPLY, type TurnInfo, type TurnOptions } from "../lib/chat-turn";
import type { CommandRegistry } from "../lib/commands/registry";
import { detectAudioType } from "../lib/audio-type";
import type {
  AgentTurnOptions,
  CommandButton,
  CommandContext,
  CommandServices,
  ReplyOptions,
  SessionResetOutcome,
  VoiceMessagePort,
  VoiceMessageResult,
  VoiceSynthesis,
} from "../lib/commands/types";
import { sessionKeyFor } from "../lib/convex";
import { currentExecution, runCancelable, runExecution } from "../lib/execution-context";
import type { SendAndRecordInput } from "../lib/outbox";
import type { TurnTools } from "../lib/turn-tools";
import type { MessageSource, RunTurnOptions } from "./chat";
import { COMMAND_NOTICE_SOURCE, COMMANDS_TEXT, type CommandListEntry, type CommandOutcome, type CommandPort, type CommandRequest } from "./commands";
import {
  createWebSink,
  MIRROR_FAILED_TEXT,
  mirrorChunks,
  replyInfoFrom,
  resolveTelegramTarget,
  TELEGRAM_UNAVAILABLE_TEXT,
  WEB_CHANNEL,
  webChatId,
  type ApprovalTurns,
  type IntentTurn,
  type WebSavedMessage,
} from "./bot-turn";
import { stripControlTags } from "./markdown";
import type { ConversationSessionReset } from "./session-reset";
import { pickReplyInfo } from "./store";
import { newWebMessageId, parseTelegramConversationId } from "./telegram";

export interface BotCommandDeps {
  registry: CommandRegistry;
  /** Dieselben Funktionen wie in Telegram (src/bot.ts commandServices) */
  services: CommandServices;
  /** TELEGRAM_USER_ID */
  userId?: string;
  groupId(): string | null;
  agentForTopic(topicId: number, chatId: string): string | undefined;
  /** Haupt-Bot, Klartext; wirft, wenn Telegram ihn nicht annimmt */
  sendPlain(chatId: string, text: string, threadId?: number): Promise<void>;
  /** Senden und festhalten (src/lib/outbox.ts sendAndRecord) */
  sendAndRecord(input: SendAndRecordInput): Promise<{ sent: boolean; recorded: boolean }>;
  saveMessage(message: WebSavedMessage): Promise<boolean>;
  /** Session-Reset wie POST .../reset (./bot-session-reset.ts), mit Sperre gegen laufende Antworten */
  resetConversation: ConversationSessionReset;
  runStreamingTurn(opts: TurnOptions): Promise<string>;
  processIntents(text: string, turn: IntentTurn): Promise<unknown>;
  sendAsAgent(agent: string, chatId: string, text: string, threadId?: number): Promise<void>;
  /** Tippt-Anzeige des Agenten-Bots während eines Board-Beitrags */
  sendTypingAsAgent?(agent: string, chatId: string, threadId?: number): Promise<void>;
  /** /board (Issue #75): Teilnehmer, Daten, [INVOKE:]-Filter wie in Telegram; fehlt: /board meldet das */
  board?: Pick<BoardDeps, "agents" | "gatherData" | "stripInvocationTags" | "pauseMs">;
  allowedTools?(agent: string): string[] | undefined;
  /** /voice (Issue #78): Sprachsynthese (src/lib/voice-message.ts); fehlt, gilt die Stimme als nicht eingerichtet */
  voice?: VoiceSynthesis;
  /** /voice: Sprachnachricht über den Haupt-Bot, nicht über sendAndRecord; wirft, wenn Telegram sie nicht annimmt */
  sendVoice?(chatId: string, audio: Buffer, fileName: string, threadId?: number): Promise<void>;
  /** Freigabeablauf der Web-Turns (createBotChat.withApprovals), für /critic und /board in älteren Web-Gesprächen */
  withApprovals?<T>(conversationId: string, turn: Pick<RunTurnOptions, "ask" | "endAsk" | "title">, fn: () => Promise<T>): Promise<T>;
  /**
   * Laufende Turns für Werkzeug-Freigaben (createApprovalTurns, dieselben wie
   * für createTelegramChat): /critic und /board in Telegram-Gesprächen melden
   * die Frage als Status, die Nachricht kommt über sendChoice
   */
  approvals?: Pick<ApprovalTurns, "register">;
  /** Nie Nachrichtentexte oder Zugangsdaten übergeben */
  log?(message: string): void;
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

/**
 * Laufen ohne den Bereich unter dem Session-Schlüssel, wie in Telegram
 * (handleUpdateScope): /stop bräche sich sonst selbst ab, /new scheiterte an
 * der eigenen Sperre des Resets.
 */
const UNSCOPED_COMMANDS = new Set(["stop", "new"]);

/** Knöpfe außerhalb von Telegram: nur die Beschriftungen als Text (keine Freigabe-Oberfläche im Web) */
export function buttonsAsText(text: string, rows: CommandButton[][]): string {
  const labels = rows.flat().map(b => b.label).filter(Boolean);
  return labels.length ? `${text}\n\nAuswahl in Telegram: ${labels.join(" · ")}` : text;
}

/** Wo ein Befehl eines Gesprächs wirkt */
interface CommandTarget {
  chatId: string;
  topicId?: number;
  sessionKey: string;
  agent: string;
  /** Nur Telegram-Gespräche: Ziel für sendAndRecord (topicId 1 ist General) */
  outbox?: { topicId?: number };
}

export function createBotCommands(deps: BotCommandDeps): CommandPort {
  const log = deps.log ?? ((m: string) => console.log(`[web] ${m}`));

  function list(channel: MessageSource): CommandListEntry[] {
    return deps.registry.list(channel);
  }

  function match(text: string, channel: MessageSource) {
    const found = deps.registry.match(text, channel);
    if (!found) return null;
    // /goal pause und /goal stop (unscoped) gehen wie /stop auch während einer laufenden Antwort
    return { name: found.command.name, whileBusy: !!found.command.whileBusy || !!found.command.unscoped?.(found.args) };
  }

  async function save(message: WebSavedMessage, conversationId: string): Promise<void> {
    try {
      if (!(await deps.saveMessage(message))) log(`Befehl aus ${conversationId} nicht im Gedächtnis gespeichert`);
    } catch (e) {
      log(`Gedächtnis-Speichern für ${conversationId} fehlgeschlagen (${errorName(e)})`);
    }
  }

  async function run(req: CommandRequest): Promise<CommandOutcome> {
    const found = deps.registry.match(req.text, req.source);
    if (!found) return { failed: COMMANDS_TEXT.failed };
    const { conversationId, source } = req;
    const ref = parseTelegramConversationId(conversationId);
    // Stopp-Knopf, Strg+C im Terminal und Beenden: ab hier bis zum Ende des Befehls
    const stopped = () => req.signal.aborted;
    if (stopped()) return { aborted: true };

    let target: CommandTarget;
    const metaBase: Record<string, unknown> = { channel: WEB_CHANNEL, ...(source === "terminal" ? { via: "terminal" } : {}) };
    if (ref) {
      const resolved = resolveTelegramTarget(conversationId, deps);
      if (!resolved) return { failed: TELEGRAM_UNAVAILABLE_TEXT };
      target = { ...resolved, outbox: ref.kind === "topic" ? { topicId: ref.topicId } : {} };
      metaBase.topicId = resolved.topicId ?? null;
    } else {
      const chatId = webChatId(conversationId);
      target = { chatId, sessionKey: sessionKeyFor(chatId), agent: req.agent };
    }

    // Wie in Telegram (handleUpdateScope in src/bot.ts) läuft der ganze Ablauf
    // ab dem Spiegeln unter dem Session-Schlüssel des Gesprächs (runCancelable):
    // /stop erreicht so schon Spiegelung und Speichern, dann Aux-Arbeit (/learn)
    // und Claude-Aufrufe (/routine, /critic); der Stopp-Knopf bricht denselben
    // Bereich ab. /stop und /new laufen wie dort ohne diesen Bereich.
    let scope: AbortController | undefined;
    let replyFailed = false;
    let aborted = false;
    /** Die Antwort eines Agenten wird gespeichert: ein späterer Stopp ändert nichts mehr */
    let committed = false;
    /** /agent oder /learn hat mit dem Schreiben begonnen: das Ergebnis wird auch nach einem Stopp gemeldet */
    let writeStarted = false;
    /** /voice: Synthese hat begonnen, ihr Ergebnis (auch der Abbruch) wird nach einem Stopp gemeldet */
    let voiceStarted = false;
    /** /board läuft: ein Stopp beendet die Sitzung nach dem laufenden Beitrag statt sofort */
    let gracefulStop: (() => void) | undefined;
    let boardResult: BoardEnd | undefined;
    const isAborted = () => aborted || stopped() || !!scope?.signal.aborted;

    async function post(text: string, options: ReplyOptions = {}, buttons?: CommandButton[][], force = false): Promise<void> {
      // Nach einem Stopp keine Antworten mehr, weder in Telegram noch im Verlauf,
      // außer dem Ergebnis einer begonnenen Änderung (/agent, /learn) und dem Ende einer Board-Sitzung
      if (isAborted() && !writeStarted && !voiceStarted && !force) return;
      if (!target.outbox) {
        await req.notice(buttons ? buttonsAsText(text, buttons) : text);
        return;
      }
      const input: SendAndRecordInput = {
        text,
        ...target.outbox,
        source: COMMAND_NOTICE_SOURCE,
        format: options.format === "markdown" ? "markdown" : "plain",
        ...(buttons ? { buttons: buttons.map(row => row.map(b => ({ text: b.label, callback_data: b.action }))) } : {}),
      };
      let result: { sent: boolean; recorded: boolean };
      try {
        result = await deps.sendAndRecord(input);
      } catch (e) {
        log(`Befehlsantwort (${conversationId}) nicht gesendet (${errorName(e)})`);
        result = { sent: false, recorded: false };
      }
      if (!result.sent) {
        replyFailed = true;
        // Wenigstens im offenen Browser zeigen, ohne Speichern
        await req.notice(text).catch(() => {});
        return;
      }
      // Gesendet, aber nicht festgehalten: der Feed meldet es nicht, also direkt (nur live)
      if (!result.recorded) await req.notice(text).catch(() => {});
    }

    /**
     * Werkzeug-Freigaben während eines Agenten-Turns (Issue #116), wie bei
     * einem Turn desselben Gesprächs: ältere Web-Gespräche zeigen die Frage im
     * Verlauf (Kopie im Direktchat mit Titel), Telegram-Gespräche setzen nur
     * den Status, die Frage kommt dort über sendChoice. Beide nehmen „ja“ als
     * Text über das Register an.
     */
    async function withApprovals<T>(fn: () => Promise<T>): Promise<T> {
      if (!target.outbox) {
        const turn = { ask: req.ask, endAsk: req.endAsk, ...(req.title ? { title: req.title } : {}) };
        return deps.withApprovals ? deps.withApprovals(conversationId, turn, fn) : fn();
      }
      const unregister = deps.approvals?.register(target.sessionKey, { conversationId, ask: req.ask, endAsk: req.endAsk, record: false }) ?? (() => {});
      try {
        return await fn();
      } finally {
        unregister();
      }
    }

    /** Gibt die gespeicherte Antwort zurück; undefined bei Stopp, Abbruch oder leerer Antwort */
    async function agentTurn(agent: string, prompt: string, options: AgentTurnOptions = {}): Promise<string | undefined> {
      const { chatId, topicId, sessionKey } = target;
      let turnInfo: TurnInfo | undefined;
      let turnTools: TurnTools | undefined;
      const turn = () =>
        runExecution(
          sessionKey,
          agent,
          () =>
            deps.runStreamingTurn({
              userMessage: prompt,
              chatId,
              agentName: agent,
              topicId,
              sink: createWebSink(req.sink),
              onInfo: i => {
                turnInfo = i;
              },
              onTools: t => {
                turnTools = t;
              },
            }),
          deps.allowedTools?.(agent)
        );
      let response: string;
      try {
        if (isAborted()) throw new DOMException("Befehl gestoppt", "AbortError");
        response = await withApprovals(turn);
      } catch (e) {
        if (isAbortError(e) || isAborted()) {
          aborted = true;
          return undefined;
        }
        throw e;
      }
      if (response === ABORT_REPLY || isAborted()) {
        aborted = true;
        return undefined;
      }
      if (!response.trim()) return undefined;
      committed = true;
      req.commit();
      const info = replyInfoFrom(agent, turnInfo);
      const replyId = newWebMessageId();
      await save(
        {
          chat_id: chatId,
          role: "assistant",
          content: response,
          metadata: { ...metaBase, msgId: replyId, agent, ...info, ...(options.replyType ? { type: options.replyType } : {}) },
        },
        conversationId
      );
      // Live in Browser und Terminal mit der ID aus dem Verlauf; der Nachrichten-Feed
      // meldet Web-Einträge (channel "web") nur als Aktivität, also genau einmal
      await req.answer(response, info, replyId);
      if (target.outbox) {
        const visible = stripControlTags(response);
        if (visible.trim()) {
          try {
            await deps.sendAsAgent(agent, chatId, visible, topicId);
          } catch (e) {
            log(`Antwort nach Telegram (${conversationId}) nicht gesendet (${errorName(e)})`);
          }
        }
      }
      try {
        await deps.processIntents(response, { tools: turnTools, chatId, topicId, origin: target.outbox ? "WebUI" : "Web-Gespräch" });
      } catch (e) {
        log(`Merk-Tags aus ${conversationId} nicht verarbeitet (${errorName(e)})`);
      }
      return response;
    }

    async function boardMeeting(extraContext: string): Promise<void> {
      if (!deps.board) {
        await post(COMMANDS_TEXT.boardUnavailable);
        return;
      }
      // Stopp bis hierher: keine Sitzung. Ab hier gilt der Befehl als ausgeführt,
      // aber ohne req.commit(): Stopp-Knopf und Strg+C bleiben möglich und
      // beenden die Sitzung nach dem laufenden Beitrag
      if (isAborted()) throw new DOMException("Befehl gestoppt", "AbortError");
      committed = true;
      const { chatId, topicId, sessionKey } = target;
      const logged = (what: string, fn: () => Promise<unknown>) =>
        fn().then(
          () => {},
          e => log(`${what} (${conversationId}) nicht gesendet (${errorName(e)})`)
        );
      const telegram = target.outbox
        ? createTelegramBoardOutput(
            {
              sendAsAgent: (agent, id, text, threadId) => deps.sendAsAgent(agent, id, text, threadId),
              sendTypingAsAgent: (agent, id, threadId) => deps.sendTypingAsAgent?.(agent, id, threadId) ?? Promise.resolve(),
              notice: async () => {},
            },
            chatId,
            topicId
          )
        : null;
      const sink = createWebSink(req.sink);
      const output: BoardOutput = {
        async start(announcement) {
          await sink.notice(BOARD_TEXT.starting);
          if (telegram) await logged("Board-Ankündigung", () => telegram.start(announcement));
        },
        async thinking(agent) {
          await sink.notice(BOARD_TEXT.thinking(agent));
          if (telegram) await logged("Tippt-Anzeige", () => telegram.thinking(agent));
        },
        async contribution(c) {
          // Live in Browser und Terminal mit der ID aus dem Verlauf (Feed meldet channel "web" nur als Aktivität)
          await req.answer(c.text, pickReplyInfo({ agent: c.agent, model: c.model, durationMs: c.durationMs }), c.msgId);
          if (telegram) await logged("Board-Beitrag", () => telegram.contribution(c));
        },
        async failed(agent) {
          await sink.notice(BOARD_TEXT.failed(agent));
        },
        async end(_result, message) {
          if (message) await post(message, {}, undefined, true);
        },
      };
      const callAgent: BoardDeps["callAgent"] = async (prompt, agent) => {
        let turnInfo: TurnInfo | undefined;
        const turn = () =>
          runExecution(
            sessionKey,
            agent,
            () =>
              deps.runStreamingTurn({
                userMessage: prompt,
                chatId,
                agentName: agent,
                topicId,
                sink: createWebSink(req.sink),
                onInfo: i => {
                  turnInfo = i;
                },
              }),
            deps.allowedTools?.(agent)
          );
        const response = await withApprovals(turn);
        // Nur ein harter Abbruch (zweites /stop, Beenden) zählt; der Stopp-Knopf wartet den Beitrag ab
        if (response === ABORT_REPLY || scope?.signal.aborted) return { text: "", aborted: true };
        return { text: response, ...(turnInfo?.model ? { model: turnInfo.model } : {}), ...(turnInfo ? { durationMs: turnInfo.durationMs } : {}) };
      };
      gracefulStop = () => requestBoardStop(sessionKey);
      try {
        boardResult = await runBoardMeeting(
          {
            ...deps.board,
            callAgent,
            save: m => deps.saveMessage({ chat_id: chatId, ...m }),
            newMessageId: newWebMessageId,
            log,
          },
          { extraContext: extraContext || undefined, sessionKey, topicId, metadata: metaBase },
          output
        );
      } catch (e) {
        if (!isAbortError(e) && !scope?.signal.aborted) throw e;
        boardResult = { contributions: 0, synthesis: false, stopped: false, aborted: true, empty: false };
      } finally {
        gracefulStop = undefined;
      }
    }

    async function resetSession(): Promise<SessionResetOutcome> {
      // Letzte Gelegenheit für einen Stopp; ab dem Reset gilt der Befehl als
      // ausgeführt, ein späterer Stopp meldet keinen Abbruch mehr
      if (isAborted()) throw new DOMException("Befehl gestoppt", "AbortError");
      committed = true;
      req.commit();
      const result = await deps.resetConversation(conversationId);
      return result.status === "done" ? { status: "done", reset: result.reset, sessionMode: result.sessionMode } : result;
    }

    function beginWrite(): void {
      // /agent: in der Schreibkette von config/agent-overrides.json vor dem Lesen,
      // /learn: direkt vor dem Speichern in der Knowledge Base. Ein Stopp bis
      // hierher verhindert das Schreiben, danach zählt das Ergebnis
      if (isAborted()) throw new DOMException("Befehl gestoppt", "AbortError");
      committed = true;
      writeStarted = true;
      req.commit();
    }

    /**
     * /voice: nach der gespeicherten Antwort synthetisieren und als
     * Sprachnachricht in dasselbe Telegram-Gespräch schicken. Stopp-Knopf
     * (followUp), /stop (Bereich des Schlüssels) und Beenden verwerfen ein
     * spätes Ergebnis; textToSpeech selbst lässt sich nicht abbrechen.
     */
    async function sendVoiceMessage(text: string): Promise<VoiceMessageResult> {
      voiceStarted = true;
      const signals = [req.signal, req.followUp?.(), scope?.signal].filter((s): s is AbortSignal => !!s);
      const signal = AbortSignal.any(signals);
      if (signal.aborted) return "aborted";
      const spoken = stripControlTags(text).trim();
      if (!spoken || !deps.voice || !deps.sendVoice) return "failed";
      let onAbort = () => {};
      const stopped = new Promise<"aborted">(resolve => {
        onAbort = () => resolve("aborted");
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        let audio: Awaited<ReturnType<VoiceSynthesis["synthesize"]>> | "aborted";
        try {
          audio = await Promise.race([deps.voice.synthesize(spoken), stopped]);
        } catch (e) {
          log(`Sprachsynthese (${conversationId}) fehlgeschlagen (${errorName(e)})`);
          return signal.aborted ? "aborted" : "failed";
        }
        if (audio === "aborted" || signal.aborted) return "aborted";
        // Nur Sprachnachrichten-Formate gehen raus (WAV nie); die Endung kommt aus den Bytes
        const type = audio ? detectAudioType(audio.audio) : null;
        if (!audio || !type || type.ext === ".wav") return "failed";
        try {
          await deps.sendVoice(target.chatId, audio.audio, `antwort${type.ext}`, target.topicId);
        } catch (e) {
          log(`Sprachnachricht nach Telegram (${conversationId}) nicht gesendet (${errorName(e)})`);
          return "failed";
        }
        return "sent";
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }

    const voiceMessage: VoiceMessagePort | undefined = target.outbox
      ? { enabled: () => deps.voice?.enabled() ?? false, send: sendVoiceMessage }
      : undefined;

    const ctx: CommandContext = {
      channel: source,
      chatId: target.chatId,
      ...(target.topicId !== undefined ? { topicId: target.topicId } : {}),
      sessionKey: target.sessionKey,
      agent: target.agent,
      name: found.command.name,
      args: found.args,
      text: req.text,
      reply: (text, options) => post(text, options),
      notice: text => post(text),
      buttons: (text, rows) => post(text, {}, rows),
      // Browser und Terminal zeigen den laufenden Befehl ohnehin an
      working: () => () => {},
      resetSession,
      agentTurn,
      boardMeeting,
      beginWrite,
      ...(voiceMessage ? { voiceMessage } : {}),
      services: deps.services,
    };

    async function execute(): Promise<CommandOutcome | undefined> {
      // 1. Spiegeln; scheitert das oder kommt ein Stopp dazwischen, keine Wirkung
      if (target.outbox) {
        try {
          for (const chunk of mirrorChunks(req.text, source)) {
            if (isAborted()) return { aborted: true };
            await deps.sendPlain(target.chatId, chunk, target.topicId);
          }
        } catch (e) {
          if (isAborted()) return { aborted: true };
          log(`Befehl nach Telegram (${conversationId}) nicht gespiegelt (${errorName(e)})`);
          return { failed: MIRROR_FAILED_TEXT };
        }
        if (isAborted()) return { aborted: true };
      }

      // 2. Nutzernachricht wie ein Befehl aus Telegram
      await save(
        {
          chat_id: target.chatId,
          role: "user",
          content: req.text,
          metadata: { ...metaBase, msgId: req.messageId },
          created_at: req.receivedAt,
        },
        conversationId
      );

      // 3. Ausführen, außer nach einem Stopp während des Speicherns
      if (isAborted()) return { aborted: true };
      await command.run(ctx);
      return undefined;
    }

    const command = found.command;
    // Während einer Board-Sitzung endet sie nach dem laufenden Beitrag, sonst sofort
    const onStop = () => (gracefulStop ? gracefulStop() : scope?.abort());
    req.signal.addEventListener("abort", onStop, { once: true });
    try {
      const early =
        command.whileBusy || UNSCOPED_COMMANDS.has(command.name) || command.unscoped?.(found.args)
          ? await execute()
          : await runCancelable(target.sessionKey, async () => {
              scope = currentExecution()!.controller;
              if (stopped()) scope.abort();
              scope.signal.throwIfAborted();
              return execute();
            });
      if (early) return early;
    } catch (e) {
      if (!committed && (isAbortError(e) || isAborted())) aborted = true;
      else throw e;
    } finally {
      req.signal.removeEventListener("abort", onStop);
    }
    if (boardResult?.aborted) return { aborted: true };
    if (replyFailed) return { failed: COMMANDS_TEXT.replyNotSent };
    return !committed && isAborted() ? { aborted: true } : {};
  }

  return { list, match, run };
}
