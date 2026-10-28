/**
 * Knöpfe unter proaktiven Meldungen (Issue #362, Entscheidungen 0017 und
 * E10): Art "proactive" im Rückfragen-Register, ref ist die Art der Meldung
 * (briefing oder checkin, config.ts).
 *
 * Knöpfe: „Erledigt" (done), „30 Minuten später" (snooze) und, nur wenn
 * Anrufe eingerichtet sind, „Anrufen" (call). Entschieden wird über das
 * Register, also genau einmal, egal ob aus Telegram, Browser oder Terminal.
 * Der Handler läuft nur im Gewinnerprozess (in bot.ts registriert):
 * - done: nichts weiter, nur die Antwort „Erledigt."
 * - snooze: schreibt snoozedUntil der Art in den Kern-Zustand
 *   (state.ts snoozeKind, data/proactive-state.json unter GO_PROJECT_ROOT),
 *   ab dem Klick SNOOZE_MINUTES. Mindestabstand und Ruhezeit können länger
 *   sperren. Scheitert das Schreiben, sagt die Antwort das und der Handler
 *   wirft (handlerError an der Frage): keine vorgetäuschte Ruhepause.
 * - call: ruft über das Anruf-Modul an (deps.call, in bot.ts
 *   proactiveCall aus src/lib/phone/) mit dem Text der Meldung als Anlass. Ein Anruf mit
 *   success false oder eine Ausnahme kommt sichtbar als Antwort und wirft.
 *
 * Knöpfe aus der Zeit vor dem Register (callback_data snooze, dismiss,
 * call_yes, call_no, nur vom alten Check-in) laufen über legacyCallback:
 * sie wirken wie die neuen (snooze schreibt den Snooze des Check-ins) und je
 * Telegram-Nachricht genau einmal, gesichert über einen Auftrag im Register
 * (claimChoiceRequest), auch wenn derselbe Knopf zweimal ankommt.
 *
 * Ins Log kommen Art, Knopf, Kanal und Rückfrage-ID, nie der Meldungstext.
 */

import {
  choiceCallbackData,
  claimChoiceRequest as realClaim,
  createChoice as realCreate,
  type Choice,
  type ChoiceConversation,
  type ChoiceHandler,
  type ChoiceOption,
} from "../choices";
import { dmChatId } from "../channels";
import { guardTelegramPayload } from "../telegram";
import { formatClock, localMoment, proactiveTimeZone } from "./clock";
import { PROACTIVE_KINDS, type ProactiveKind } from "./config";
import { proactiveStatePath, snoozeKind as realSnooze } from "./state";

type Env = Record<string, string | undefined>;
type Log = (line: string) => void;
const defaultLog: Log = line => console.log(line);

export const SNOOZE_MINUTES = 30;

export const PROACTIVE_OPTION = {
  done: { key: "done", label: "Erledigt" },
  snooze: { key: "snooze", label: "30 Minuten später" },
  call: { key: "call", label: "Anrufen" },
} as const satisfies Record<string, ChoiceOption>;

export const PROACTIVE_CHOICE_TEXT = {
  done: "Erledigt.",
  snoozed: (until: string) => `Ruhe bis ${until}.`,
  snoozeFailed: "Die Ruhepause ließ sich nicht speichern, es bleibt beim bisherigen Zeitplan.",
  calling: "Ich rufe an.",
  callFailed: (reason: string) => `Anruf hat nicht geklappt: ${reason}`,
  callUnavailable: "Anrufe sind nicht eingerichtet.",
  already: "Schon erledigt.",
  failed: "Das hat nicht geklappt.",
} as const;

/** Optionen einer Meldung; Anrufen nur mit eingerichteten Anrufen */
export function proactiveOptions(callAvailable: boolean): ChoiceOption[] {
  const list: ChoiceOption[] = [PROACTIVE_OPTION.done, PROACTIVE_OPTION.snooze];
  if (callAvailable) list.push(PROACTIVE_OPTION.call);
  return list.map(o => ({ key: o.key, label: o.label }));
}

/** Gespräch proaktiver Meldungen: der Direktchat, ohne Telegram der Web-Direktchat */
export function proactiveConversation(env: Env = process.env): ChoiceConversation {
  return { type: "telegram", chatId: dmChatId(env) };
}

export function isProactiveKind(value: unknown): value is ProactiveKind {
  return typeof value === "string" && (PROACTIVE_KINDS as readonly string[]).includes(value);
}

/** Telegram-Knöpfe einer Frage, alle in einer Reihe (höchstens drei Optionen) */
export function proactiveButtons(choice: Pick<Choice, "id" | "options">): { text: string; callback_data: string }[][] {
  return [choice.options.map(o => ({ text: o.label, callback_data: choiceCallbackData(choice.id, o.key) }))];
}

/** Legt die offene Frage zu einer Meldung an (Text der Meldung als Fragetext) */
export function openProactiveChoice(
  kind: ProactiveKind,
  text: string,
  deps: { env?: Env; callAvailable?: boolean; create?: typeof realCreate } = {},
): Promise<Choice> {
  return (deps.create ?? realCreate)({
    kind: "proactive",
    conversation: proactiveConversation(deps.env),
    text,
    options: proactiveOptions(deps.callAvailable ?? false),
    ref: kind,
  });
}

/**
 * Bearbeiten über die Bot-API per fetch, ohne Bot-Prozess (für das Nachziehen
 * aus der Routine, refreshChoiceMessages). Wirft bei jeder Ablehnung; die
 * Nutzlast läuft durch guardTelegramPayload wie beim Senden.
 */
export function botApiEditor(
  token: string,
  doFetch: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): {
  editMessageText(chatId: string, messageId: number, text: string, other?: Record<string, unknown>): Promise<unknown>;
  editMessageReplyMarkup(chatId: string, messageId: number, other?: Record<string, unknown>): Promise<unknown>;
} {
  async function call(method: string, payload: Record<string, unknown>): Promise<unknown> {
    if (!token) throw new Error("kein Bot-Token");
    const response = await doFetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(guardTelegramPayload(method, payload)),
      signal: AbortSignal.timeout(EDIT_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean } | null;
    if (!response.ok || body?.ok !== true) throw new Error(`${method} abgelehnt (${response.status})`);
    return body;
  }
  return {
    editMessageText: (chatId, messageId, text, other = {}) => call("editMessageText", { ...other, chat_id: chatId, message_id: messageId, text }),
    editMessageReplyMarkup: (chatId, messageId, other = {}) => call("editMessageReplyMarkup", { ...other, chat_id: chatId, message_id: messageId }),
  };
}

const EDIT_TIMEOUT_MS = 15_000;

export interface CallResult {
  success: boolean;
  message: string;
}

export interface ProactiveChoicesDeps {
  /** Antwort im Gespräch der Rückfrage, source ist die Art; darf werfen, geloggt wird hier */
  notify(conversation: ChoiceConversation, text: string, kind: ProactiveKind): Promise<void>;
  /** Anruf mit Anlass; fehlt: Anrufen nicht möglich */
  call?: (context: string) => Promise<CallResult>;
  /** Standard proactiveStatePath(GO_PROJECT_ROOT) */
  statePath?: string;
  snooze?: typeof realSnooze;
  claim?: typeof realClaim;
  now?: () => Date;
  env?: Env;
  log?: Log;
}

export interface ProactiveChoices {
  /** Handler der Art "proactive" (onChoiceDecided) */
  handler: ChoiceHandler;
  /**
   * Alte Knöpfe (snooze, dismiss, call_yes, call_no) einer Telegram-Nachricht.
   * null: kein alter Check-in-Knopf, sonst der neue Text der Nachricht.
   */
  legacyCallback(data: string, message: { chatId: string; messageId: number; text: string }): Promise<string | null>;
}

type Action = "done" | "snooze" | "call";

const LEGACY: Record<string, { action: Action; request: string }> = {
  snooze: { action: "snooze", request: "snooze" },
  dismiss: { action: "done", request: "dismiss" },
  call_no: { action: "done", request: "call-no" },
  call_yes: { action: "call", request: "call-yes" },
};

/** Anlass eines alten Check-in-Anrufs: der Text nach „about:" und Leerzeile */
function legacyCallContext(text: string): string {
  return text.replace(/^.*?about:\n\n/s, "").trim() || "Check-in";
}

export function createProactiveChoices(deps: ProactiveChoicesDeps): ProactiveChoices {
  const log = deps.log ?? defaultLog;
  const env = () => deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const statePath = () => deps.statePath ?? proactiveStatePath(env().GO_PROJECT_ROOT || process.cwd());
  const snooze = deps.snooze ?? realSnooze;

  /** Führt eine Aktion aus; reply bekommt jede Antwort, Fehler werfen nach der Antwort */
  async function perform(kind: ProactiveKind, action: Action, context: string, reply: (text: string) => Promise<void>): Promise<void> {
    if (action === "done") {
      await reply(PROACTIVE_CHOICE_TEXT.done);
      return;
    }
    if (action === "snooze") {
      const until = new Date(now().getTime() + SNOOZE_MINUTES * 60_000);
      try {
        await snooze(statePath(), kind, until);
      } catch (error) {
        await reply(PROACTIVE_CHOICE_TEXT.snoozeFailed);
        throw error;
      }
      await reply(PROACTIVE_CHOICE_TEXT.snoozed(formatClock(localMoment(until, proactiveTimeZone(env())).minutes)));
      return;
    }
    if (!deps.call) {
      await reply(PROACTIVE_CHOICE_TEXT.callUnavailable);
      throw new Error("Anrufen nicht eingerichtet");
    }
    let result: CallResult;
    try {
      result = await deps.call(context);
    } catch (error) {
      await reply(PROACTIVE_CHOICE_TEXT.callFailed(error instanceof Error ? error.message : "unbekannter Fehler"));
      throw error;
    }
    if (!result.success) {
      await reply(PROACTIVE_CHOICE_TEXT.callFailed(result.message || "unbekannter Fehler"));
      throw new Error("Anruf gescheitert");
    }
    await reply(PROACTIVE_CHOICE_TEXT.calling);
  }

  const handler: ChoiceHandler = async choice => {
    const kind = choice.ref;
    const key = choice.result?.key;
    if (!isProactiveKind(kind) || (key !== "done" && key !== "snooze" && key !== "call")) {
      throw new Error("Meldungs-Frage ohne Art oder gültige Auswahl");
    }
    log(`[proactive] ${kind}: Knopf ${key} (${choice.result?.via ?? "-"}), Rückfrage ${choice.id}`);
    await perform(kind, key, choice.text, async text => {
      try {
        await deps.notify(choice.conversation, text, kind);
      } catch {
        log(`[proactive] Antwort zu Rückfrage ${choice.id} nicht zugestellt`);
      }
    });
  };

  async function legacyCallback(data: string, message: { chatId: string; messageId: number; text: string }): Promise<string | null> {
    const legacy = Object.prototype.hasOwnProperty.call(LEGACY, data) ? LEGACY[data] : undefined;
    if (!legacy) return null;
    // Je Nachricht genau einmal, auch über Prozesse und Doppelklicks hinweg
    const requestKey = `proactive-legacy-${message.chatId}-${message.messageId}`;
    let claimed: boolean;
    try {
      const outcome = await (deps.claim ?? realClaim)(requestKey, { kind: "proactive", ref: "checkin", action: legacy.request });
      claimed = outcome.status === "claimed";
    } catch {
      log(`[proactive] alter Knopf ${data} an Nachricht ${message.messageId}: Register nicht nutzbar`);
      return PROACTIVE_CHOICE_TEXT.failed;
    }
    if (!claimed) return PROACTIVE_CHOICE_TEXT.already;
    log(`[proactive] checkin: alter Knopf ${data} an Nachricht ${message.messageId}`);
    const lines: string[] = [];
    try {
      await perform("checkin", legacy.action, legacyCallContext(message.text), async text => { lines.push(text); });
    } catch {
      // Die Antwort steht schon in lines
    }
    return lines.join("\n") || PROACTIVE_CHOICE_TEXT.failed;
  }

  return { handler, legacyCallback };
}
