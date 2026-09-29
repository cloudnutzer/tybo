/**
 * Echter Agenten-Turn der WebUI (Issue #6): verbindet den Web-Chat mit dem
 * Chat-Kern aus src/lib/chat-turn.ts, so wie Telegram ihn nutzt.
 *
 * Nur src/bot.ts bindet diese Datei ein. Der Web-Server (server.ts) und
 * web:dev laden nichts aus src/lib; deshalb liegt die Verdrahtung hier und
 * nicht in chat.ts. Alle Aufrufe nach außen (Claude, Gedächtnis, Neustart)
 * kommen als Abhängigkeiten herein, damit Tests ohne src/bot.ts auskommen.
 */

import { join } from "node:path";
import {
  ABORT_REPLY,
  SHUTDOWN_ABORT_REPLY,
  type TurnInfo,
  type TurnOptions,
  type TurnProgress,
  type TurnSink,
} from "../lib/chat-turn";
import { acceptedCreatedAt, sessionKeyFor } from "../lib/convex";
import { currentExecution, isAbortError, isRestartPendingError, RESTART_PENDING_REPLY, runCancelable, runExecution } from "../lib/execution-context";
import { createQueueNotifier } from "../lib/queue-notice";
import { WEB_DM_CHAT_ID } from "../lib/channels";
import { chunkForTelegram } from "../lib/telegram";
import type { TurnTools } from "../lib/turn-tools";
import { decideChoice } from "../lib/choices";
import { approvalKeyForText, type ToolApprovalPresenter } from "../lib/tool-approval";
import { capInvocations, executeInvocation, parseInvocationTags } from "../lib/cross-agent";
import {
  MediaRejectedError,
  buildMediaPrompt,
  cleanupMedia,
  defaultMediaDeps,
  finishMediaTurn,
  prepareMedia,
  type MediaDeps,
  type PreparedMedia,
} from "../lib/media-turn";
import type { MessageAttachment } from "./attachments";
import type { UploadStore } from "./uploads";
import { agentLabel } from "./agents";
import type { FollowUpOutput, MessageSource, RunTurnOptions, TurnResult, WebChat } from "./chat";
import { stripControlTags } from "./markdown";
import { pickReplyInfo, webSessionKey, type ReplyInfo } from "./store";
import { newWebMessageId, parseTelegramConversationId } from "./telegram";

export const WEB_CHANNEL = "web";

export interface WebSavedMessage {
  chat_id: string;
  role: "user" | "assistant";
  content: string;
  metadata?: Record<string, unknown>;
  /** Eingangszeitpunkt der Nutzernachricht (Issue #69); ohne Angabe setzt der Speicher den Zeitpunkt */
  created_at?: string;
}

export interface BotChatDeps {
  /** Chat-Kern, in bot.ts runStreamingTurn aus src/lib/chat-turn.ts */
  runStreamingTurn(opts: TurnOptions): Promise<string>;
  /** Gemeinsames Gedächtnis (Supabase/Convex); false heißt nicht gespeichert */
  saveMessage(message: WebSavedMessage): Promise<boolean>;
  /**
   * [REMEMBER:]/[GOAL:]-Tags; bekommt den unveränderten Antworttext und die
   * Angaben zum Turn. In bot.ts processTurnIntents (Issue #53): nach fremden
   * Inhalten nur als Vorschlag mit Telegram-Knöpfen, nie direkt.
   */
  processIntents(text: string, turn: IntentTurn): Promise<unknown>;
  abortEngineCalls(sessionKey: string): number;
  /** true, sobald shutdown() in src/bot.ts läuft */
  isShuttingDown(): boolean;
  /** Angeforderten Neustart prüfen, sobald nichts mehr läuft; ohne Chat-ID (die ist Telegram vorbehalten) */
  scheduleRestartCheck(trigger: string): void;
  allowedTools?(agent: string): string[] | undefined;
  /**
   * Anhänge in reinen Web-Gesprächen (Issue #112): dieselbe Ablage wie im
   * Web-Server. read liefert die Datei. Nie unclaim: die Nutzernachricht ist
   * dort schon gespeichert, bevor der Turn startet, die Anhänge gehören zu ihr.
   * Ohne sie scheitert ein Turn mit Anhängen.
   */
  uploads?: Pick<UploadStore, "read">;
  /** Abhängigkeiten des Medien-Kerns (Asset-Speicher, Transkription); in bot.ts die echten, in Tests Attrappen */
  media?: Partial<MediaDeps>;
  /**
   * Laufende Turns für Werkzeug-Freigaben (Issue #116); in bot.ts eine
   * gemeinsame Instanz für Web- und Telegram-Gespräche und den Freigabe-Handler.
   * Ohne Angabe eine eigene.
   */
  approvals?: ApprovalTurns;
  /** Nie Nachrichtentexte oder Zugangsdaten übergeben */
  log?(message: string): void;
  /** Topic-Namen für den Wartehinweis (Issue #188); ohne sie „Topic <id>" */
  topicNames?(): Promise<Record<string, string>>;
  /** Wartezeit bis zum Hinweis, Standard QUEUE_NOTICE_DELAY_MS; anders nur in Tests */
  queueNoticeMs?: number;
}

/**
 * Optionen für runCancelable eines Web-Turns: der Wartehinweis geht als
 * notice an den Browser (nur Anzeige, nie in den Speicher, nie nach Telegram).
 */
function queueWaitOptions(deps: BotChatDeps, sink: TurnSink) {
  return {
    onQueueWait: createQueueNotifier(text => sink.notice(text), deps.topicNames),
    ...(deps.queueNoticeMs !== undefined ? { queueNoticeMs: deps.queueNoticeMs } : {}),
  };
}

/** Angaben zu einem Turn für das Merk-Tag-Tor (src/lib/intent-gate.ts) */
export interface IntentTurn {
  /** Werkzeuge des Turns; undefined heißt unbekannt */
  tools: TurnTools | undefined;
  /** Chat des Turns; bei reinen Web-Gesprächen web:<id>, der Vorschlag geht dann in den Direktchat */
  chatId: string;
  topicId?: number;
  /** Herkunft für Vorschlag und Log */
  origin: string;
  /** Der Turn verarbeitete fremde Inhalte aus Anhängen (Issue #72), z. B. "Foto" */
  foreignInput?: string;
}

/**
 * Laufende Browser- und Terminal-Turns für Werkzeug-Freigaben (Issue #116).
 *
 * Der gemeinsame Freigabe-Handler (src/lib/tool-approval.ts) sucht hier über
 * den Ausführungsschlüssel (web:<id>, dm:…, topic:…, group:…) den Turn, der
 * die Frage im Browser zeigt: in reinen Web-Gesprächen als Nachricht mit
 * choiceId, in Telegram-Gesprächen nur als Status (die Nachricht kommt dort
 * über sendChoice und den Nachrichtenspeicher, nie doppelt). Eine eingetippte
 * Antwort („ja“, alles andere lehnt ab) entscheidet die Frage im Register,
 * aber nur, wenn genau sie in diesem Gespräch offen ist.
 */
export interface ApprovalTurns {
  /** Turn anmelden; gibt die Abmeldung zurück */
  register(executionKey: string, turn: ApprovalTurn): () => void;
  presenter(executionKey: string): ToolApprovalPresenter | undefined;
  /** Text-Antwort auf die offene Frage approvalId; false, wenn sie hier nicht (mehr) offen ist oder schon entschieden wurde */
  answer(conversationId: string, text: string, approvalId: string, source: MessageSource): Promise<boolean>;
}

export interface ApprovalTurn {
  conversationId: string;
  title?: string;
  ask: NonNullable<RunTurnOptions["ask"]>;
  endAsk?: RunTurnOptions["endAsk"];
  /** false: Frage nicht als Nachricht ablegen, nur den Status setzen (Telegram-Gespräche) */
  record: boolean;
}

export interface ApprovalTurnsDeps {
  /** Standard decideChoice aus dem Rückfragen-Register */
  decide?(id: string, key: string, via: MessageSource): Promise<{ status: string }>;
}

export function createApprovalTurns(deps: ApprovalTurnsDeps = {}): ApprovalTurns {
  const decide = deps.decide ?? ((id: string, key: string, via: MessageSource) => decideChoice(id, key, via));
  interface Entry extends ApprovalTurn {
    pendingId?: string;
  }
  const turns = new Map<string, Entry>();
  return {
    register(executionKey, turn) {
      const entry: Entry = { ...turn };
      turns.set(executionKey, entry);
      return () => {
        if (turns.get(executionKey) === entry) turns.delete(executionKey);
      };
    },
    presenter(executionKey) {
      const entry = turns.get(executionKey);
      if (!entry) return undefined;
      return {
        title: entry.title,
        async ask(choice, question) {
          await entry.ask(question, choice.id, { record: entry.record });
          entry.pendingId = choice.id;
        },
        end(choiceId) {
          if (entry.pendingId === choiceId) entry.pendingId = undefined;
          entry.endAsk?.(choiceId);
        },
      };
    },
    async answer(conversationId, text, approvalId, source) {
      const entry = [...turns.values()].find(e => e.conversationId === conversationId);
      if (!entry || entry.pendingId !== approvalId) return false;
      const outcome = await decide(approvalId, approvalKeyForText(text), source);
      return outcome.status === "decided";
    },
  };
}

export interface BotChat extends WebChat {
  /**
   * Modellgestützte Befehlsarbeit (/critic, /board, Issue #74) in einem
   * älteren Web-Gespräch: fn läuft mit demselben Freigabeablauf wie ein Turn
   * (Rückfrage über ask, Antwort über answer, Frist, Abbruch; title für den
   * Hinweis an der Telegram-Kopie).
   */
  withApprovals<T>(conversationId: string, turn: Pick<RunTurnOptions, "ask" | "endAsk" | "title">, fn: () => Promise<T>): Promise<T>;
}

export const WEB_ATTACHMENTS_UNAVAILABLE_TEXT = "Anhänge sind hier nicht eingerichtet.";
export const WEB_ATTACHMENT_FAILED_TEXT =
  "Ein Anhang konnte nicht verarbeitet werden. Bitte die Datei noch einmal anhängen und senden.";

/** Chat-ID eines Web-Gesprächs; zugleich sein Session-Schlüssel (sessionKeyFor). */
export function webChatId(conversationId: string): string {
  return webSessionKey(conversationId);
}

/**
 * Sink des Chat-Kerns für den Web-Chat: reicht Fortschritt und Hinweise an
 * den SSE-Sink des ChatHub weiter. Nach finish() kommt kein Fortschritt mehr,
 * Hinweise (etwa das Zeitlimit vor dem Fallback) aber schon. Fehler des
 * Ziels erreichen den Turn nie.
 */
export function createWebSink(target: TurnSink): TurnSink {
  let finished = false;
  const safe = async (fn: () => void | Promise<void>) => {
    try {
      await fn();
    } catch {
      // Eine abgebrochene Browser-Verbindung darf den Turn nicht stören
    }
  };
  return {
    progress: (p: TurnProgress) => (finished ? undefined : safe(() => target.progress(p))),
    notice: (text: string) => safe(() => target.notice(text)),
    start: () => safe(() => target.start?.()),
    finish: () => {
      finished = true;
      return safe(() => target.finish?.());
    },
  };
}

/**
 * Angaben unter der Antwort (Issue #22): was der Chat-Kern gemeldet hat,
 * geprüft; ohne Meldung nur der Agent, der den Turn bekommen hat.
 */
export function replyInfoFrom(agent: string, info: TurnInfo | undefined): ReplyInfo {
  return pickReplyInfo(info ? { ...info, agent: info.agent || agent } : { agent });
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

/**
 * WebChat über den echten Chat-Kern. Der Turn läuft in runCancelable und
 * runExecution unter dem Schlüssel web:<id>: Warteschlange, /stop-Logik und
 * die Neustart-Prüfung (activeExecutionCount) zählen ihn mit.
 */
export function createBotChat(deps: BotChatDeps): BotChat {
  const log = deps.log ?? ((m: string) => console.log(`[web] ${m}`));
  const approvals = deps.approvals ?? createApprovalTurns();

  interface OpenTurn {
    /** Ab dem Speichern der Antwort gilt der Turn als fertig; stop() lehnt dann ab */
    committed: boolean;
  }
  const open = new Map<string, OpenTurn>();

  /** Freigaben unter web:<id> zeigt dieser Turn als Nachricht mit choiceId */
  function registerApprovals(conversationId: string, turn: Pick<RunTurnOptions, "ask" | "endAsk" | "title">): () => void {
    if (!turn.ask) return () => {};
    return approvals.register(sessionKeyFor(webChatId(conversationId)), {
      conversationId,
      ...(turn.title ? { title: turn.title } : {}),
      ask: turn.ask,
      endAsk: turn.endAsk,
      record: true,
    });
  }

  const aborted = () => ({
    text: deps.isShuttingDown() ? SHUTDOWN_ABORT_REPLY : "",
    aborted: true as const,
  });

  async function save(message: WebSavedMessage, conversationId: string): Promise<void> {
    try {
      const ok = await deps.saveMessage(message);
      if (!ok) log(`${message.role === "user" ? "Nachricht" : "Antwort"} aus Gespräch ${conversationId} nicht im Gedächtnis gespeichert`);
    } catch (e) {
      log(`Gedächtnis-Speichern für Gespräch ${conversationId} fehlgeschlagen (${errorName(e)})`);
    }
  }

  async function runTurn({ conversationId, agent, text, sink, ask, endAsk, title, attachments = [] }: RunTurnOptions): Promise<TurnResult> {
    const chatId = webChatId(conversationId);
    const sessionKey = sessionKeyFor(chatId);
    const entry: OpenTurn = { committed: false };
    open.set(conversationId, entry);
    const unregister = registerApprovals(conversationId, { ask, endAsk, title });
    const prepared: PreparedMedia[] = [];
    const webSink = createWebSink(sink);
    try {
      return await runCancelable(sessionKey, async () => {
        const signal = currentExecution()?.controller.signal;
        const wasAborted = () => !!signal?.aborted;

        // Anhänge (Issue #112): je Datei durch den Medien-Kern wie im
        // Telegram-Gespräch, nur ohne Spiegelung. Arbeitskopien unter
        // uploads/web/<Gespräch>/, damit das Löschen des Gesprächs sie findet
        const files: { attachment: MessageAttachment; bytes: Uint8Array }[] = [];
        if (attachments.length) {
          if (!deps.uploads) return { text: WEB_ATTACHMENTS_UNAVAILABLE_TEXT, failed: true };
          const mediaDeps: Partial<MediaDeps> = {
            ...deps.media,
            uploadsDir: join(webMediaDir(deps.media?.uploadsDir), conversationId),
            now: uniqueMediaClock(deps.media?.now ?? Date.now),
          };
          try {
            for (const a of attachments) files.push(await deps.uploads.read(conversationId, a.id));
            for (const f of files) {
              if (wasAborted()) return aborted();
              prepared.push(
                await prepareMedia(
                  {
                    kind: f.attachment.kind,
                    bytes: f.bytes,
                    ext: "",
                    chatId,
                    caption: text.trim() ? text : undefined,
                    fileName: f.attachment.name,
                    source: { channel: "web" },
                  },
                  mediaDeps
                )
              );
            }
          } catch (e) {
            if (wasAborted()) return aborted();
            if (e instanceof MediaRejectedError) return { text: `Anhang abgelehnt: ${e.reason}`, failed: true };
            log(`Anhang in Gespräch ${conversationId} nicht verarbeitet (${errorName(e)})`);
            return { text: WEB_ATTACHMENT_FAILED_TEXT, failed: true };
          }
          if (wasAborted()) return aborted();
        }

        // Mit Anhängen im Speicher Text plus je Anhang eine Zeile (Kontext, Suche),
        // der geschriebene Text und die Anhänge in metadata, wie in Telegram-Gesprächen
        const content = prepared.length
          ? [text.trim() ? text : "", ...files.map((f, i) => attachmentLine(f.attachment, prepared[i]))].filter(Boolean).join("\n")
          : text;
        const mediaMeta = prepared.length
          ? {
              webText: text,
              attachments: files.map((f, i) => ({
                ...f.attachment,
                ...(prepared[i].assetId ? { assetId: prepared[i].assetId } : {}),
              })),
            }
          : {};
        await save({ chat_id: chatId, role: "user", content, metadata: { channel: WEB_CHANNEL, ...mediaMeta } }, conversationId);
        if (wasAborted()) return aborted();

        let response: string;
        let turnInfo: TurnInfo | undefined;
        let turnTools: TurnTools | undefined;
        try {
          response = await runExecution(
            sessionKey,
            agent,
            () =>
              deps.runStreamingTurn({
                userMessage: prepared.length ? buildMediaPrompt(prepared, text) : text,
                chatId,
                agentName: agent,
                sink: webSink,
                onInfo: i => {
                  turnInfo = i;
                },
                onTools: t => {
                  turnTools = t;
                },
              }),
            deps.allowedTools?.(agent)
          );
        } catch (e) {
          // Abbruch, während der Turn noch in der Warteschlange stand
          if (isAbortError(e)) return aborted();
          throw e;
        }

        // Nicht nur ABORT_REPLY: auch ein abgebrochener Fallback liefert Text
        // (FALLBACK_FAILED_REPLY oder eine halbe Antwort), der nicht ins Gedächtnis darf
        if (response === ABORT_REPLY || wasAborted()) return aborted();
        // Bildbeschreibungen aus [ASSET_DESC] nachtragen, Tags entfernen
        if (prepared.length) response = finishMediaTurn(prepared, response, deps.media);
        if (!response.trim()) return { text: "" };

        // Ab hier verbindlich: Antwort und Merk-Tags laufen zu Ende, ein
        // späterer Stopp wird abgelehnt statt als Abbruch gemeldet
        entry.committed = true;
        const info = replyInfoFrom(agent, turnInfo);
        await save(
          { chat_id: chatId, role: "assistant", content: response, metadata: { agent, ...info, channel: WEB_CHANNEL } },
          conversationId
        );
        try {
          // Fremde Inhalte aus Anhängen (Foto, Datei; Sprache nicht): Merk-Tags nur als Vorschlag (Issue #53)
          const foreignInput = [...new Set(prepared.map(p => p.foreignInput).filter((f): f is string => !!f))].join(", ");
          await deps.processIntents(response, { tools: turnTools, chatId, origin: "Web-Gespräch", ...(foreignInput ? { foreignInput } : {}) });
        } catch (e) {
          log(`Merk-Tags aus Gespräch ${conversationId} nicht verarbeitet (${errorName(e)})`);
        }
        return { text: response, info };
      }, queueWaitOptions(deps, webSink));
    } catch (e) {
      if (isAbortError(e)) return aborted();
      // Neustart läuft (Issue #190): nicht angenommen, klare Meldung
      if (isRestartPendingError(e)) return { text: RESTART_PENDING_REPLY, failed: true };
      throw e;
    } finally {
      if (open.get(conversationId) === entry) open.delete(conversationId);
      unregister();
      // Sprachdateien löschen, auch nach Fehler oder Abbruch
      for (const p of prepared) await cleanupMedia(p, deps.media);
      deps.scheduleRestartCheck("nach Web-Antwort");
    }
  }

  async function withApprovals<T>(conversationId: string, turn: Pick<RunTurnOptions, "ask" | "endAsk" | "title">, fn: () => Promise<T>): Promise<T> {
    const unregister = registerApprovals(conversationId, turn);
    try {
      return await fn();
    } finally {
      unregister();
    }
  }

  return {
    runTurn,
    withApprovals,
    /** false, wenn die Antwort schon gespeichert wird: dann gibt es nichts mehr abzubrechen */
    stop(conversationId: string) {
      if (open.get(conversationId)?.committed) return false;
      deps.abortEngineCalls(sessionKeyFor(webChatId(conversationId)));
      return true;
    },
    /** Nur für die offene Frage mit dieser Register-ID; eine verspätete Antwort bewirkt nichts */
    answer: (conversationId, text, approvalId, source = "web") => approvals.answer(conversationId, text, approvalId, source),
  };
}

// ---------------------------------------------------------------------------
// Schreiben in Telegram-Gespräche (Issue #19, docs/webui/decisions/0004)
// ---------------------------------------------------------------------------

/** Vorsatz der gespiegelten Nachricht in Telegram, je Quelle (Issue #59, Entscheidung 0010) */
export const MIRROR_PREFIXES: Record<MessageSource, string> = {
  web: "Du (Web): ",
  terminal: "Du (Terminal): ",
};
/** Vorsatz einer im Browser geschriebenen Nachricht */
export const MIRROR_PREFIX = MIRROR_PREFIXES.web;
export const MIRROR_FAILED_TEXT =
  "Die Nachricht konnte nicht nach Telegram gesendet werden. Nichts wurde verarbeitet, bitte noch einmal versuchen.";
export const TELEGRAM_UNAVAILABLE_TEXT = "Dieses Telegram-Gespräch ist gerade nicht erreichbar (Chat-ID fehlt).";

/** Direktchat: Telegram-Nutzer-ID oder, ohne Telegram, "web" (WEB_DM_CHAT_ID, Issue #227) */
const TELEGRAM_USER_ID_PATTERN = /^(\d{1,20}|web)$/;

/**
 * Ohne Telegram ist der Direktchat ein Web-Gespräch unter der Chat-ID "web"
 * (Issue #227): nichts spiegeln, keine Antwort vom Agenten-Bot, keine
 * Tippt-Anzeige. Alle Telegram-Aufrufe dieser Datei fragen hier.
 */
export function mirrorsToTelegram(chatId: string): boolean {
  return chatId !== WEB_DM_CHAT_ID;
}
const TELEGRAM_GROUP_ID_PATTERN = /^-\d{1,20}$/;
/** Forum-Thema General: in der Bot-API ohne Thread-ID, Session group:<chatId> */
const GENERAL_TOPIC = 1;

export interface TelegramChatDeps extends BotChatDeps {
  /** Chat des Direktchats: TELEGRAM_USER_ID, ohne Telegram "web" (dmChatId, Issue #227) */
  userId?: string;
  /** Chat-ID der Forum-Gruppe (wie in bot-telegram.ts); null: keine */
  groupId(): string | null;
  /** getAgentByTopicId aus src/agents/base.ts */
  agentForTopic(topicId: number, chatId: string): string | undefined;
  /**
   * Haupt-Bot, ein Teil als Klartext (kein parse_mode). Wirft, wenn Telegram
   * ihn nicht annimmt; dann läuft kein Turn.
   */
  sendPlain(chatId: string, text: string, threadId?: number): Promise<void>;
  /**
   * Haupt-Bot, ein Anhang als Foto oder Dokument mit Beschriftung als
   * Klartext (Issue #72). Wirft, wenn Telegram ihn nicht annimmt. Ohne sie
   * scheitert ein Turn mit Anhängen.
   */
  sendFile?(chatId: string, file: MirrorFile, options: { as: "photo" | "document"; caption: string; threadId?: number }): Promise<void>;
  /** botRegistry.sendAsAgent: Markdown zu Telegram-HTML, Aufteilen, Rückfall Klartext */
  sendAsAgent(agent: string, chatId: string, text: string, threadId?: number): Promise<void>;
  /**
   * Höchstens so viele [INVOKE:]-Rückfragen je Antwort (AGENT_INVOKE_BUDGET,
   * Issue #76). Fehlt die Angabe, werden Rückfragen wie vor M5 nicht ausgeführt.
   */
  invokeBudget?: number;
  /** Tippt-Anzeige des gefragten Agenten in Telegram */
  sendTypingAsAgent?(agent: string, chatId: string, threadId?: number): Promise<void>;
  /** Nach einer Antwort im Browser: aktives /goal prüfen und ggf. weiterarbeiten (onAgentTurnForGoal) */
  onAgentTurn?(sessionKey: string, agent: string, response: string): void;
  /**
   * Anhänge (Issue #72): dieselbe Ablage wie im Web-Server. read liefert die
   * Datei, unclaim gibt sie wieder frei, wenn die Nachricht nicht gespeichert
   * wird. Ohne sie scheitert ein Turn mit Anhängen.
   */
  uploads?: Pick<UploadStore, "read" | "unclaim">;
  /** Abhängigkeiten des Medien-Kerns (Asset-Speicher, Transkription); in bot.ts die echten, in Tests Attrappen */
  media?: Partial<MediaDeps>;
}

export const ATTACHMENTS_UNAVAILABLE_TEXT = "Anhänge sind hier nicht eingerichtet. Nichts wurde nach Telegram gesendet.";
export const ATTACHMENT_FAILED_TEXT =
  "Ein Anhang konnte nicht verarbeitet werden. Nichts wurde nach Telegram gesendet, bitte noch einmal versuchen.";

/** Zeile für den Nachrichtenspeicher je Anhang (Kontext und Suche; im Browser steht der geschriebene Text) */
function attachmentLine(a: MessageAttachment, p: PreparedMedia): string {
  if (p.kind === "image") return `[Photo: ${a.name}]`;
  if (p.kind === "document") return `[Document: ${a.name}]`;
  return `[Voice message: ${a.name}] ${p.transcript ?? ""}`.trimEnd();
}

/**
 * Unterordner der Arbeitsdateien aus dem Web-Chat unter dem uploads/ des
 * Medien-Kerns: Telegram legt photo_<Zeit>_<UUID> und voice_<Zeit>_<UUID>
 * direkt in uploads/ ab. Seit Issue #190 sind die Namen schon durch die UUID
 * eindeutig; der eigene Ordner trennt Web und Telegram zusätzlich.
 */
export const WEB_MEDIA_SUBDIR = "web";

/** Ordner der Web-Arbeitsdateien zu einem uploads/ des Medien-Kerns */
export function webMediaDir(uploadsDir: string = defaultMediaDeps.uploadsDir): string {
  return join(uploadsDir, WEB_MEDIA_SUBDIR);
}

let lastMediaTs = 0;
/**
 * Uhr für prepareMedia, die nie zweimal denselben Wert liefert: Bild- und
 * Sprachdateien heißen nach dem Zeitpunkt, mehrere Anhänge derselben
 * Millisekunde würden sich sonst überschreiben.
 */
function uniqueMediaClock(base: () => number): () => number {
  return () => {
    const t = Math.max(Math.floor(base()), lastMediaTs + 1);
    lastMediaTs = t;
    return t;
  };
}

/** Wo eine Rückfrage läuft: dasselbe Gespräch und derselbe Session-Schlüssel wie die Antwort */
export interface InvocationTurn {
  sourceAgent: string;
  chatId: string;
  topicId?: number;
  sessionKey: string;
  conversationId: string;
  /** Metadaten jeder gespeicherten Antwort (channel "web", topicId, via) */
  metadata: Record<string, unknown>;
}

export type InvocationDeps = Pick<
  TelegramChatDeps,
  "runStreamingTurn" | "saveMessage" | "sendAsAgent" | "sendTypingAsAgent" | "allowedTools" | "log"
>;

const SILENT_SINK: TurnSink = { progress: () => {}, notice: () => {} };

/**
 * [INVOKE:agent|Frage] aus einer Antwort im Browser ausführen (Issue #76):
 * wie in Telegram (Budget, canInvokeAgent, keine verschachtelten Rückfragen),
 * jede Antwort gespeichert mit Agent und eigener msgId, im Browser als eigene
 * Nachricht mit Sprecher (dieselbe ID) und in Telegram vom Bot des Agenten.
 */
export async function runWebInvocations(
  response: string,
  turn: InvocationTurn,
  budget: number,
  deps: InvocationDeps,
  output: FollowUpOutput
): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(`[web] ${m}`));
  const { chatId, topicId, sessionKey, conversationId } = turn;
  const invocations = capInvocations(parseInvocationTags(response), Math.max(0, budget));
  // Stopp-Knopf (output.signal) oder /stop (Abbruch der Ausführung): keine weitere Rückfrage
  const stopped = () => output.signal.aborted || !!currentExecution()?.controller.signal.aborted;
  for (const invocation of invocations) {
    if (stopped()) return;
    let info: TurnInfo | undefined;
    try {
      await executeInvocation(turn.sourceAgent, invocation, {
        typing: async target => {
          await output.notice(`${agentLabel(target)} denkt nach …`);
          if (!mirrorsToTelegram(chatId)) return;
          try {
            await deps.sendTypingAsAgent?.(target, chatId, topicId);
          } catch {
            // Tippt-Anzeige ist nur Beiwerk
          }
        },
        call: async (prompt, target) => {
          info = undefined;
          try {
            return await runExecution(
              sessionKey,
              target,
              () =>
                deps.runStreamingTurn({
                  userMessage: prompt,
                  chatId,
                  agentName: target,
                  topicId,
                  sink: SILENT_SINK,
                  onInfo: i => {
                    info = i;
                  },
                }),
              deps.allowedTools?.(target)
            );
          } catch (e) {
            if (isAbortError(e)) return ABORT_REPLY;
            throw e;
          }
        },
        deliver: async (target, text) => {
          // Abgebrochen oder leer: nichts speichern, nichts senden
          if (!text.trim() || text === ABORT_REPLY || stopped()) return;
          const messageId = newWebMessageId();
          const replyInfo = replyInfoFrom(target, info);
          await deps.saveMessage({
            chat_id: chatId,
            role: "assistant",
            content: text,
            metadata: { ...turn.metadata, msgId: messageId, agent: target, invokedBy: turn.sourceAgent, ...replyInfo },
          });
          await output.answer(text, replyInfo, messageId);
          const visible = stripControlTags(text);
          if (visible.trim() && mirrorsToTelegram(chatId)) {
            try {
              await deps.sendAsAgent(target, chatId, visible, topicId);
            } catch (e) {
              log(`Rückfrage-Antwort nach Telegram (${conversationId}) nicht gesendet (${errorName(e)})`);
            }
          }
        },
      });
    } catch (e) {
      log(`Rückfrage in ${conversationId} fehlgeschlagen (${errorName(e)})`);
    }
  }
}

export interface TelegramTarget {
  chatId: string;
  /** Nur bei echten Topics (nicht General): Thread-ID und topicId im Speicher */
  topicId?: number;
  sessionKey: string;
  agent: string;
}

/**
 * Wohin ein Web-Turn in einem Telegram-Gespräch geht: dieselbe Chat-ID,
 * dasselbe Topic, derselbe Session-Schlüssel und derselbe Agent wie bei einer
 * Nachricht aus Telegram. null ohne gültige Chat-ID.
 */
export function resolveTelegramTarget(
  conversationId: string,
  deps: Pick<TelegramChatDeps, "userId" | "groupId" | "agentForTopic">
): TelegramTarget | null {
  const ref = parseTelegramConversationId(conversationId);
  if (!ref) return null;
  if (ref.kind === "dm") {
    const chatId = deps.userId?.trim();
    if (!chatId || !TELEGRAM_USER_ID_PATTERN.test(chatId)) return null;
    return { chatId, sessionKey: sessionKeyFor(chatId, null), agent: "general" };
  }
  let chatId: string | null;
  try {
    chatId = deps.groupId();
  } catch {
    chatId = null;
  }
  if (!chatId || !TELEGRAM_GROUP_ID_PATTERN.test(chatId)) return null;
  // General kommt in Telegram ohne Thread-ID an: Agent general, Schlüssel group:<chatId>
  if (ref.topicId === GENERAL_TOPIC) return { chatId, sessionKey: sessionKeyFor(chatId, null), agent: "general" };
  let agent: string | undefined;
  try {
    agent = deps.agentForTopic(ref.topicId, chatId);
  } catch {
    agent = undefined;
  }
  return { chatId, topicId: ref.topicId, sessionKey: sessionKeyFor(chatId, ref.topicId), agent: agent || "general" };
}

/**
 * Session-Schlüssel eines Gesprächs (Issue #61, Reset wie /new): Telegram-
 * Gespräche wie resolveTelegramTarget, ältere Web-Gespräche web:<id>. null,
 * wenn sich keiner ermitteln lässt.
 */
export function conversationSessionKey(
  conversationId: string,
  deps: Pick<TelegramChatDeps, "userId" | "groupId" | "agentForTopic">
): string | null {
  if (parseTelegramConversationId(conversationId)) return resolveTelegramTarget(conversationId, deps)?.sessionKey ?? null;
  return sessionKeyFor(webChatId(conversationId));
}

/** Spiegel-Nachricht in Teilen, die Telegram annimmt (Klartext, höchstens 4000 Zeichen je Teil). */
export function mirrorChunks(text: string, source: MessageSource = "web"): string[] {
  return chunkForTelegram((MIRROR_PREFIXES[source] ?? MIRROR_PREFIX) + text);
}

// ---------------------------------------------------------------------------
// Anhänge spiegeln (Issue #72)
// ---------------------------------------------------------------------------

/** Beschriftung weiterer Anhänge und Anhänge ohne Text */
export const MIRROR_LABELS: Record<MessageSource, string> = {
  web: "Du (Web)",
  terminal: "Du (Terminal)",
};
/** Telegram: Beschriftung eines Fotos oder Dokuments höchstens 1024 Zeichen (UTF-16) */
export const TELEGRAM_CAPTION_MAX = 1024;
/** Telegram: Fotos höchstens 10 MB, größere Bilder gehen als Dokument */
export const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1_048_576;
export const MIRROR_PARTIAL_TEXT =
  "Die Nachricht ging nur teilweise nach Telegram. Nichts wurde verarbeitet, bitte noch einmal versuchen.";

/** Eine Datei für Telegram */
export interface MirrorFile {
  bytes: Uint8Array;
  /** Anzeigename */
  name: string;
  mime: string;
}

export interface MirrorPlan {
  /** Je Anhang in Reihenfolge: als Foto oder Dokument, mit Beschriftung */
  files: { as: "photo" | "document"; caption: string }[];
  /** Text, der nicht in die Beschriftung passt, danach als Klartext */
  textChunks: string[];
}

/**
 * Wie eine Nachricht mit Anhängen in Telegram erscheint: der erste Anhang
 * trägt „Du (Web): <Text>", weitere nur „Du (Web)". Passt der Text nicht in
 * die Beschriftung, tragen alle Anhänge nur „Du (Web)" und der Text folgt in
 * Teilen wie eine Textnachricht. Bilder (PNG, JPEG, WebP bis 10 MB) als Foto,
 * alles andere (GIF, PDF, Sprache, große Bilder) als Dokument.
 */
export function attachmentMirrorPlan(
  text: string,
  source: MessageSource,
  files: Pick<MessageAttachment, "kind" | "mime" | "size">[]
): MirrorPlan {
  const label = MIRROR_LABELS[source] ?? MIRROR_LABELS.web;
  const full = text.trim() ? (MIRROR_PREFIXES[source] ?? MIRROR_PREFIX) + text : label;
  const fits = full.length <= TELEGRAM_CAPTION_MAX;
  return {
    files: files.map((f, i) => ({
      as: f.kind === "image" && f.mime !== "image/gif" && f.size <= TELEGRAM_PHOTO_MAX_BYTES ? "photo" : "document",
      caption: i === 0 && fits ? full : label,
    })),
    textChunks: fits ? [] : mirrorChunks(text, source),
  };
}

/**
 * WebChat für Direktchat und Topics. Ablauf je Turn, alles unter dem
 * Telegram-Schlüssel (runCancelable, damit Stopp und /stop greifen):
 *  1. Haupt-Bot spiegelt „Du (Web): …" bzw. „Du (Terminal): …" als Klartext; scheitert das, endet
 *     der Turn ohne Speichern und ohne Claude-Aufruf
 *  2. Claude-Aufruf in runExecution(Schlüssel, Agent): dieselbe Warteschlange
 *     wie ein Telegram-Turn desselben Agenten im selben Gespräch
 *  3. verbindlich: Nutzernachricht (msgId = ID aus dem ChatHub) und Antwort
 *     speichern, über den Agenten-Bot senden (ohne Steuer-Tags), Merk-Tags
 *     verarbeiten. Ab hier lehnt stop() ab.
 * Die Nutzernachricht bekommt als created_at ihren Eingangszeitpunkt
 * (Issue #69), die Antwort den Speicherzeitpunkt: Meldungen und Dateien, die
 * während des Turns gespeichert werden, stehen im Verlauf dazwischen.
 * Ein angenommener Stopp vor Schritt 3: kein weiterer Spiegel-Teil, keine
 * Antwort in Telegram, nichts gespeichert, keine Merk-Tags. Was schon
 * gespiegelt ist, bleibt in Telegram stehen.
 * Mit Anhängen (Issue #72) davor: jede Datei durch prepareMedia (Asset,
 * Transkript), abgelegt in uploads/web/ (webMediaDir); Schritt 1 schickt
 * die Dateien als Foto bzw. Dokument
 * (attachmentMirrorPlan), Schritt 2 bekommt den gemeinsamen Prompt, Schritt 3
 * trägt Bildbeschreibungen nach. Wird die Nachricht nicht gespeichert
 * (Fehler vor dem Claude-Aufruf, Stopp), sind die Anhänge wieder frei.
 * Werkzeug-Freigaben (Issue #116) erscheinen als Rückfrage im Telegram-Gespräch
 * (sendChoice) und von dort im Browser; der Turn setzt nur den Status
 * awaiting, damit auch „ja“ als Text wirkt.
 */
export function createTelegramChat(deps: TelegramChatDeps): WebChat {
  const log = deps.log ?? ((m: string) => console.log(`[web] ${m}`));
  const approvals = deps.approvals ?? createApprovalTurns();

  interface OpenTurn {
    sessionKey: string;
    committed: boolean;
  }
  const open = new Map<string, OpenTurn>();

  const aborted = (): TurnResult => ({
    text: deps.isShuttingDown() ? SHUTDOWN_ABORT_REPLY : "",
    aborted: true,
  });

  async function save(message: WebSavedMessage, conversationId: string): Promise<void> {
    try {
      const ok = await deps.saveMessage(message);
      if (!ok) log(`${message.role === "user" ? "Nachricht" : "Antwort"} aus ${conversationId} nicht im Gedächtnis gespeichert`);
    } catch (e) {
      log(`Gedächtnis-Speichern für ${conversationId} fehlgeschlagen (${errorName(e)})`);
    }
  }

  async function runTurn({ conversationId, text, messageId, receivedAt, source = "web", sink, ask, endAsk, attachments = [] }: RunTurnOptions): Promise<TurnResult> {
    // Vor Spiegeln und Warteschlange festhalten; ohne gültigen Wert aus dem ChatHub jetzt
    const createdAt = acceptedCreatedAt(receivedAt) ?? new Date().toISOString();
    /** Nutzernachricht gespeichert: dann gehören die Anhänge zu ihr, sonst werden sie wieder frei */
    let userSaved = false;
    const prepared: PreparedMedia[] = [];
    const releaseAttachments = async () => {
      if (!attachments.length || userSaved || !deps.uploads) return;
      try {
        await deps.uploads.unclaim(conversationId, attachments.map(a => a.id));
      } catch (e) {
        log(`Anhänge aus ${conversationId} nicht freigegeben (${errorName(e)})`);
      }
    };
    const target = resolveTelegramTarget(conversationId, deps);
    if (!target) {
      await releaseAttachments();
      return { text: TELEGRAM_UNAVAILABLE_TEXT, failed: true };
    }
    const { chatId, topicId, sessionKey, agent } = target;
    // Web-Direktchat ohne Telegram (Issue #227): kein Spiegeln, keine Antwort in Telegram
    const mirror = mirrorsToTelegram(chatId);
    const entry: OpenTurn = { sessionKey, committed: false };
    open.set(conversationId, entry);
    // Die Frage selbst kommt über sendChoice in den Verlauf, hier nur der Status
    const unregister = ask ? approvals.register(sessionKey, { conversationId, ask, endAsk, record: false }) : () => {};
    // topicId null bei Direktchat und General: sonst entstünde topic:<chatId>:1
    // channel bleibt "web" (über die HTTP-Schnittstelle, Filter in bot-telegram.ts);
    // Terminal-Nachrichten tragen zusätzlich via: "terminal" (Issue #59)
    const metaBase = { topicId: topicId ?? null, channel: WEB_CHANNEL, ...(source === "terminal" ? { via: "terminal" } : {}) };
    const webSink = createWebSink(sink);
    try {
      return await runCancelable(sessionKey, async () => {
        const signal = currentExecution()?.controller.signal;
        const wasAborted = () => !!signal?.aborted;
        if (wasAborted()) return aborted();

        // Anhänge (Issue #72): laden und je Datei durch den Medien-Kern, bevor
        // etwas nach Telegram geht; scheitert das, bleibt Telegram unberührt
        const files: { attachment: MessageAttachment; bytes: Uint8Array }[] = [];
        if (attachments.length) {
          if (!deps.uploads || (mirror && !deps.sendFile)) {
            return { text: mirror ? ATTACHMENTS_UNAVAILABLE_TEXT : WEB_ATTACHMENTS_UNAVAILABLE_TEXT, failed: true };
          }
          const mediaDeps: Partial<MediaDeps> = {
            ...deps.media,
            uploadsDir: webMediaDir(deps.media?.uploadsDir),
            now: uniqueMediaClock(deps.media?.now ?? Date.now),
          };
          try {
            for (const a of attachments) files.push(await deps.uploads.read(conversationId, a.id));
            for (const f of files) {
              if (wasAborted()) return aborted();
              prepared.push(
                await prepareMedia(
                  {
                    kind: f.attachment.kind,
                    bytes: f.bytes,
                    ext: "",
                    chatId,
                    topicId,
                    caption: text.trim() ? text : undefined,
                    fileName: f.attachment.name,
                    source: { channel: "web" },
                  },
                  mediaDeps
                )
              );
            }
          } catch (e) {
            if (wasAborted()) return aborted();
            if (e instanceof MediaRejectedError) {
              return { text: `Anhang abgelehnt: ${e.reason}${mirror ? " Nichts wurde nach Telegram gesendet." : ""}`, failed: true };
            }
            log(`Anhang in ${conversationId} nicht verarbeitet (${errorName(e)})`);
            return { text: mirror ? ATTACHMENT_FAILED_TEXT : WEB_ATTACHMENT_FAILED_TEXT, failed: true };
          }
          if (wasAborted()) return aborted();
        }

        // Anhänge zuerst (der erste trägt den Text, wenn er passt), dann Text in Teilen;
        // ohne Telegram gibt es nichts zu spiegeln
        const plan: MirrorPlan = !mirror
          ? { files: [], textChunks: [] }
          : files.length
            ? attachmentMirrorPlan(text, source, files.map(f => f.attachment))
            : { files: [], textChunks: mirrorChunks(text, source) };
        let sentParts = 0;
        try {
          // Zwischen den Teilen prüfen: nach angenommenem Stopp geht kein weiterer Teil raus
          for (const [i, step] of plan.files.entries()) {
            if (wasAborted()) return aborted();
            const { attachment, bytes } = files[i];
            const file: MirrorFile = { bytes, name: attachment.name, mime: attachment.mime };
            try {
              await deps.sendFile!(chatId, file, { as: step.as, caption: step.caption, threadId: topicId });
            } catch (e) {
              // Foto abgelehnt (Maße, Format): als Dokument geht es meist trotzdem
              if (step.as !== "photo" || wasAborted()) throw e;
              log(`Foto nach Telegram (${conversationId}) abgelehnt, sende als Dokument (${errorName(e)})`);
              await deps.sendFile!(chatId, file, { as: "document", caption: step.caption, threadId: topicId });
            }
            sentParts++;
          }
          for (const chunk of plan.textChunks) {
            if (wasAborted()) return aborted();
            await deps.sendPlain(chatId, chunk, topicId);
            sentParts++;
          }
        } catch (e) {
          if (wasAborted()) return aborted();
          log(`Spiegeln nach Telegram (${conversationId}) fehlgeschlagen (${errorName(e)})`);
          return { text: files.length && sentParts > 0 ? MIRROR_PARTIAL_TEXT : MIRROR_FAILED_TEXT, failed: true };
        }
        if (wasAborted()) return aborted();

        // Die Nutzernachricht wird erst gespeichert, wenn der Turn nicht
        // abgebrochen endet: nach angenommenem Stopp bleibt nichts im Gedächtnis
        // Mit Anhängen: im Speicher Text plus je Anhang eine Zeile (Kontext, Suche),
        // der geschriebene Text und die Anhänge für den Verlauf in metadata
        const content = prepared.length
          ? [text.trim() ? text : "", ...files.map((f, i) => attachmentLine(f.attachment, prepared[i]))].filter(Boolean).join("\n")
          : text;
        const mediaMeta = prepared.length
          ? {
              webText: text,
              attachments: files.map((f, i) => ({
                ...f.attachment,
                ...(prepared[i].assetId ? { assetId: prepared[i].assetId } : {}),
              })),
            }
          : {};
        const saveUser = () => {
          userSaved = true;
          return save(
            {
              chat_id: chatId,
              role: "user",
              content,
              metadata: { ...metaBase, msgId: messageId ?? newWebMessageId(), ...mediaMeta },
              created_at: createdAt,
            },
            conversationId
          );
        };

        let response: string;
        let turnInfo: TurnInfo | undefined;
        let turnTools: TurnTools | undefined;
        try {
          response = await runExecution(
            sessionKey,
            agent,
            () =>
              deps.runStreamingTurn({
                userMessage: prepared.length ? buildMediaPrompt(prepared, text) : text,
                chatId,
                agentName: agent,
                topicId,
                sink: webSink,
                onInfo: i => {
                  turnInfo = i;
                },
                onTools: t => {
                  turnTools = t;
                },
              }),
            deps.allowedTools?.(agent)
          );
        } catch (e) {
          if (isAbortError(e) || wasAborted()) return aborted();
          // Gescheitert, nicht abgebrochen: die Nutzernachricht bleibt wie bisher.
          // Ab hier verbindlich, damit stop() während des Speicherns ablehnt
          entry.committed = true;
          await saveUser();
          throw e;
        }
        if (response === ABORT_REPLY || wasAborted()) return aborted();

        entry.committed = true;
        await saveUser();
        // Bildbeschreibungen aus [ASSET_DESC] nachtragen, Tags entfernen
        if (prepared.length) response = finishMediaTurn(prepared, response, deps.media);
        if (!response.trim()) return { text: "" };

        const replyId = newWebMessageId();
        const info = replyInfoFrom(agent, turnInfo);
        await save(
          { chat_id: chatId, role: "assistant", content: response, metadata: { ...metaBase, msgId: replyId, agent, ...info } },
          conversationId
        );
        // Telegram bekommt die Antwort ohne Steuer-Tags; [INVOKE:] läuft danach (followUp)
        const visible = stripControlTags(response);
        if (visible.trim() && mirror) {
          try {
            await deps.sendAsAgent(agent, chatId, visible, topicId);
          } catch (e) {
            log(`Antwort nach Telegram (${conversationId}) nicht gesendet (${errorName(e)})`);
          }
        }
        try {
          // Fremde Inhalte aus Anhängen (Foto, Datei): Merk-Tags nur als Vorschlag (Issue #53)
          const foreignInput = [...new Set(prepared.map(p => p.foreignInput).filter((f): f is string => !!f))].join(", ");
          await deps.processIntents(response, { tools: turnTools, chatId, topicId, origin: "WebUI", ...(foreignInput ? { foreignInput } : {}) });
        } catch (e) {
          log(`Merk-Tags aus ${conversationId} nicht verarbeitet (${errorName(e)})`);
        }
        // Aktives /goal in diesem Gespräch: Gates und Judge auf diese Antwort, wie in Telegram (Issue #76)
        try {
          deps.onAgentTurn?.(sessionKey, agent, response);
        } catch (e) {
          log(`Ziel-Prüfung für ${conversationId} fehlgeschlagen (${errorName(e)})`);
        }
        const budget = deps.invokeBudget;
        const hasInvocations = budget !== undefined && budget > 0 && parseInvocationTags(response).length > 0;
        return {
          text: response,
          messageId: replyId,
          info,
          // [INVOKE:] erst nach der Antwort, noch unter der Sperre des Gesprächs (Issue #76)
          ...(hasInvocations
            ? {
                followUp: (output: FollowUpOutput) => {
                  // Stopp-Knopf während der Rückfragen: wie /stop über den Telegram-Schlüssel
                  const stop = () => deps.abortEngineCalls(sessionKey);
                  output.signal.addEventListener("abort", stop, { once: true });
                  return runCancelable(sessionKey, () =>
                    runWebInvocations(response, { sourceAgent: agent, chatId, topicId, sessionKey, conversationId, metadata: metaBase }, budget!, deps, output)
                  )
                    .catch(async e => {
                      // Neustart dazwischen (Issue #190): Rückfragen entfallen, sichtbar gemeldet
                      if (isRestartPendingError(e)) return output.notice(RESTART_PENDING_REPLY).catch(() => {});
                      if (!isAbortError(e)) throw e;
                    })
                    .finally(() => output.signal.removeEventListener("abort", stop));
                },
              }
            : {}),
        };
      }, queueWaitOptions(deps, webSink));
    } catch (e) {
      if (isAbortError(e)) return aborted();
      // Neustart läuft (Issue #190): nicht angenommen, klare Meldung
      if (isRestartPendingError(e)) return { text: RESTART_PENDING_REPLY, failed: true };
      throw e;
    } finally {
      if (open.get(conversationId) === entry) open.delete(conversationId);
      unregister();
      // Sprachdateien löschen, auch nach Fehler oder Abbruch
      for (const p of prepared) await cleanupMedia(p, deps.media);
      await releaseAttachments();
      deps.scheduleRestartCheck("nach Web-Antwort");
    }
  }

  return {
    runTurn,
    /**
     * Beendet den Turn über den Telegram-Schlüssel; das trifft wie /stop auch
     * einen gleichzeitig laufenden Telegram-Turn dieses Gesprächs. false, wenn
     * die Antwort schon verbindlich gespeichert und gesendet wird oder der
     * Turn schon fertig ist.
     */
    stop(conversationId: string) {
      const entry = open.get(conversationId);
      // Ohne offenen Turn (schon fertig) gibt es nichts mehr abzubrechen
      if (!entry || entry.committed) return false;
      deps.abortEngineCalls(entry.sessionKey);
      return true;
    },
    answer: (conversationId, text, approvalId, source = "web") => approvals.answer(conversationId, text, approvalId, source),
  };
}
