/**
 * Versand proaktiver Meldungen (Issue #361): Regeln, Reservierung, Text,
 * Outbox, Zustand, Exit-Code. Briefing und Check-in (später als Routinen)
 * rufen runProactive bzw. proactiveMain und liefern nur den Text.
 *
 * Ablauf:
 * 1. Alte Dateien übernehmen, wenn noch nicht geschehen (migrate.ts)
 * 2. Regeln prüfen und reservieren (state.ts reserveSend). Greift eine Regel
 *    oder läuft schon ein anderer Lauf derselben Art: skipped.
 * 3. compose baut den Text, währenddessen wird die Reservierung erneuert
 *    (renewClaim). null oder leerer Text: skipped ("nothing"), nichts wird
 *    gesendet, Versandzeit bleibt.
 * 4. Vor dem Senden bestätigen (confirmSend): unter der Sperre mit frischem
 *    Zustand, erst dort gelesener Uhr und Einstellungen die Regeln
 *    noch einmal prüfen. Hat ein anderer Lauf die Reservierung übernommen
 *    (dieser hing zu lange): skipped ("overtaken"). Hat während compose das
 *    Zeitfenster geschlossen, die Ruhezeit begonnen oder jemand Snooze
 *    gesetzt bzw. die Art abgeschaltet: skipped mit diesem Grund. In beiden
 *    Fällen wird nichts gesendet und keine Versandzeit gesetzt.
 * 5. Senden über die Outbox (Direktchat, Quelle wie die Art: briefing bzw.
 *    checkin; Telegram und WebUI). Zugestellt heißt outboxDelivered: Telegram
 *    angenommen (auch wenn das Festhalten scheiterte) oder ohne Telegram
 *    festgehalten.
 * 6. Reservierung lösen; nur bei Zustellung Versandzeit und Tagesmarke setzen.
 *
 * Knöpfe (Issue #362, message.ask): Nach dem Bestätigen und vor dem Senden
 * entsteht die Rückfrage der Art proactive (choices.ts in diesem Ordner),
 * gesendet wird genau einmal mit choiceId und ihren Knöpfen; ohne Telegram
 * hält die Outbox nur fest und die WebUI zeigt die Knöpfe aus dem Register.
 * Die Telegram-Nachricht mit den Knöpfen wird an der Rückfrage gemerkt, damit
 * der Bot Klicks annimmt und erledigte Knöpfe nachzieht. Scheitert das
 * Anlegen, geht die Meldung ohne Knöpfe raus (Log); kommt sie nicht an, läuft
 * die Rückfrage ab. Wurde sie schon während des Sendens entschieden (etwa im
 * Browser) oder ist sie verschwunden, kam das Ereignis ohne diese Nachricht:
 * dann zieht der Versand sie selbst nach (register.refresh, Endzustand, Knöpfe
 * weg), wie sendChoice in telegram-choices.ts.
 *
 * Exit-Code (proactiveExitCode): 1 bei failed (Sendefehler, nicht
 * zugestellt, Ausnahme beim Bauen oder Senden, Zustand nicht lesbar oder
 * nicht schreibbar), sonst 0. Ein Überspringen nach den Regeln ist kein
 * Fehler. Ins Log kommen Art, Ergebnis und Grund, nie der Text.
 */

import type { Settings } from "../settings";
import { getSettings } from "../settings";
import { outboxDelivered } from "../channels";
import type { InlineButton, OutboxSender } from "../outbox";
import type { Choice, ChoiceTelegramRef } from "../choices";
import { proactiveTimeZone } from "./clock";
import { proactiveConfig, type ProactiveConfig, type ProactiveKind } from "./config";
import { botApiEditor, openProactiveChoice, proactiveButtons } from "./choices";
import { importLegacyProactive, legacyPaths, type LegacyPaths } from "./migrate";
import { judgeKind, type KindRecord, type SkipReason } from "./rules";
import { CLAIM_RENEW_MS, confirmSend, finishSend, proactiveStatePath, renewClaim, reserveSend } from "./state";

type Env = Record<string, string | undefined>;

export interface ProactiveMessage {
  text: string;
  format?: "markdown" | "plain";
  buttons?: InlineButton[][];
  /** Knöpfe Erledigt, 30 Minuten später, Anrufen über das Rückfragen-Register; ersetzt buttons */
  ask?: boolean;
}

/** Der Teil des Rückfragen-Registers, den der Versand braucht (choices.ts) */
export interface ProactiveChoiceRegister {
  create(kind: ProactiveKind, text: string): Promise<Choice>;
  attach(id: string, refs: ChoiceTelegramRef[]): Promise<Choice | undefined>;
  expire(id: string): Promise<unknown>;
  /** Telegram-Nachrichten einer erledigten oder abgelaufenen Frage nachziehen; wirft nicht */
  refresh(choice: Choice, refs: ChoiceTelegramRef[]): Promise<unknown>;
}

export interface ComposeContext {
  kind: ProactiveKind;
  now: Date;
  zone: string;
  config: ProactiveConfig;
}

export type ProactiveOutcome =
  | { status: "sent" }
  | { status: "skipped"; reason: SkipReason | "busy" | "nothing" | "overtaken" }
  | { status: "failed"; reason: "compose" | "send" | "undelivered" | "state" };

export interface ProactiveDeps {
  send?: OutboxSender;
  now?: () => Date;
  env?: Env;
  settings?: Settings;
  statePath?: string;
  /** null: keine Übernahme alter Dateien */
  legacy?: LegacyPaths | null;
  /** Abstand der Erneuerungen der Reservierung; 0: keine (nur für Tests) */
  renewMs?: number;
  /** Register für message.ask; Standard das echte unter GO_PROJECT_ROOT */
  choices?: ProactiveChoiceRegister;
}

/** Standard-Sender von Briefing und Check-in: die Outbox (Telegram und WebUI) */
export async function defaultSend(): Promise<OutboxSender> {
  // Erst hier geladen: die Outbox zieht Telegram und Agenten nach
  return (await import("../outbox")).sendViaOutbox;
}

async function defaultChoices(root: string, env: Env): Promise<ProactiveChoiceRegister> {
  // Wie der Bot: Ablage im Projektordner, auch wenn die Routine woanders läuft
  const register = await import("../choices");
  register.useChoicesFileIn(root);
  const { phoneConfigured } = await import("../phone/provider");
  const { refreshChoiceMessages } = await import("../telegram-choices");
  const editor = botApiEditor(env.TELEGRAM_BOT_TOKEN?.trim() ?? "");
  return {
    create: (kind, text) => openProactiveChoice(kind, text, { env, callAvailable: phoneConfigured(env), create: register.createChoice }),
    attach: register.attachChoiceTelegram,
    expire: register.expireChoice,
    refresh: (choice, refs) => refreshChoiceMessages(choice, editor, undefined, refs),
  };
}

/** Rückfrage zur Meldung anlegen; scheitert es, null (Meldung geht ohne Knöpfe) */
async function askFor(kind: ProactiveKind, text: string, deps: ProactiveDeps, root: string, env: Env): Promise<{ register: ProactiveChoiceRegister; choice: Choice } | null> {
  try {
    const register = deps.choices ?? (await defaultChoices(root, env));
    return { register, choice: await register.create(kind, text) };
  } catch (error) {
    console.error(`[proactive] ${kind}: Rückfrage nicht angelegt, Meldung ohne Knöpfe (${errorName(error)})`);
    return null;
  }
}

/** Nachricht mit Knöpfen an der Rückfrage merken bzw. die Rückfrage ablaufen lassen; wirft nicht */
async function settleChoice(kind: ProactiveKind, ask: { register: ProactiveChoiceRegister; choice: Choice }, delivered: boolean, refs: ChoiceTelegramRef[]): Promise<void> {
  const id = ask.choice.id;
  try {
    if (refs.length > 0) {
      const stored = await ask.register.attach(id, refs);
      if (!stored || stored.state !== "open") {
        // Das Ereignis kam ohne diese Nachricht: hier nachziehen
        console.log(`[proactive] ${kind}: Rückfrage ${id} schon während des Sendens erledigt, Knöpfe werden nachgezogen`);
        await ask.register.refresh(stored ?? { ...ask.choice, state: "expired" }, refs);
        return;
      }
    }
    if (!delivered) await ask.register.expire(id);
  } catch (error) {
    console.error(`[proactive] ${kind}: Rückfrage ${id} nicht nachgetragen (${errorName(error)})`);
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Fehler";
}

export async function runProactive(
  kind: ProactiveKind,
  compose: (ctx: ComposeContext) => Promise<ProactiveMessage | null>,
  deps: ProactiveDeps = {},
): Promise<ProactiveOutcome> {
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const root = env.GO_PROJECT_ROOT || process.cwd();
  const statePath = deps.statePath ?? proactiveStatePath(root);
  const zone = proactiveTimeZone(env);

  const judgeAt = (at: Date, config: ProactiveConfig) => (record: KindRecord) =>
    judgeKind({ now: at, zone, quietHours: config.quietHours, kind: config[kind], record });

  let token: string;
  let config: ProactiveConfig;
  try {
    if (deps.legacy !== null) await importLegacyProactive(deps.legacy ?? legacyPaths(root), now());
    config = proactiveConfig(deps.settings ?? getSettings());
    const at = now();
    const reservation = await reserveSend(statePath, kind, at, judgeAt(at, config));
    if (!reservation.ok) return { status: "skipped", reason: reservation.reason };
    token = reservation.token;
  } catch (error) {
    console.error(`[proactive] ${kind}: Zustand nicht nutzbar (${errorName(error)})`);
    return { status: "failed", reason: "state" };
  }

  let message: ProactiveMessage | null = null;
  let outcome: ProactiveOutcome | undefined;
  const renewMs = deps.renewMs ?? CLAIM_RENEW_MS;
  // Die nächste Erneuerung erst renewMs nach dem Ende der vorigen: wartet eine
  // länger auf die Sperre, stauten sich sonst Erneuerungen davor und
  // verdrängten andere Läufe, die dort nur begrenzt warten
  let renewing = renewMs > 0;
  let renewer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRenew = () => {
    if (!renewing) return;
    renewer = setTimeout(() => void renewClaim(statePath, kind, token, now()).catch(() => {}).finally(scheduleRenew), renewMs);
  };
  scheduleRenew();
  try {
    message = await compose({ kind, now: now(), zone, config });
    if (!message || message.text.trim() === "") outcome = { status: "skipped", reason: "nothing" };
  } catch (error) {
    console.error(`[proactive] ${kind}: Text nicht gebaut (${errorName(error)})`);
    outcome = { status: "failed", reason: "compose" };
  } finally {
    renewing = false;
    clearTimeout(renewer);
  }

  if (!outcome) {
    try {
      // Uhr und Einstellungen erst unter der Sperre lesen: eine Änderung während compose
      // oder während des Wartens auf die Sperre (Fensterende, abgeschaltet) zählt
      const confirmed = await confirmSend(statePath, kind, token, now, (record, at) =>
        judgeAt(at, proactiveConfig(deps.settings ?? getSettings()))(record),
      );
      if (!confirmed.ok) {
        if (confirmed.reason === "overtaken") console.log(`[proactive] ${kind}: Reservierung von einem anderen Lauf übernommen, nicht gesendet`);
        else console.log(`[proactive] ${kind}: Regel greift nach dem Bauen des Texts (${confirmed.reason}), nicht gesendet`);
        outcome = { status: "skipped", reason: confirmed.reason };
      }
    } catch (error) {
      console.error(`[proactive] ${kind}: Zustand nicht nutzbar (${errorName(error)})`);
      outcome = { status: "failed", reason: "state" };
    }
  }

  let delivered = false;
  if (!outcome) {
    const ask = message!.ask ? await askFor(kind, message!.text, deps, root, env) : null;
    let refs: ChoiceTelegramRef[] = [];
    try {
      const send = deps.send ?? (await defaultSend());
      const result = await send({
        text: message!.text,
        source: kind,
        format: message!.format,
        buttons: ask ? proactiveButtons(ask.choice) : message!.buttons,
        ...(ask ? { choiceId: ask.choice.id } : {}),
      });
      delivered = outboxDelivered(result);
      refs = (result.messages ?? []).filter(m => m.buttons).map(m => ({ chatId: m.chatId, messageId: m.messageId }));
      outcome = delivered ? { status: "sent" } : { status: "failed", reason: "undelivered" };
    } catch (error) {
      console.error(`[proactive] ${kind}: Senden gescheitert (${errorName(error)})`);
      outcome = { status: "failed", reason: "send" };
    }
    if (ask) await settleChoice(kind, ask, delivered || refs.length > 0, refs);
  }

  try {
    await finishSend(statePath, kind, token, delivered, now(), zone);
  } catch (error) {
    // Zugestellt, aber nicht vermerkt: als Fehler melden, sonst käme die Meldung bald doppelt
    console.error(`[proactive] ${kind}: Zustand nicht geschrieben (${errorName(error)})`);
    return { status: "failed", reason: "state" };
  }
  return outcome!;
}

export function proactiveExitCode(outcome: ProactiveOutcome): 0 | 1 {
  return outcome.status === "failed" ? 1 : 0;
}

/** Für Skripte: ausführen, Ergebnis ins Log, Exit-Code zurück */
export async function proactiveMain(
  kind: ProactiveKind,
  compose: (ctx: ComposeContext) => Promise<ProactiveMessage | null>,
  deps: ProactiveDeps = {},
): Promise<0 | 1> {
  let outcome: ProactiveOutcome;
  try {
    outcome = await runProactive(kind, compose, deps);
  } catch (error) {
    console.error(`[proactive] ${kind}: abgebrochen (${errorName(error)})`);
    return 1;
  }
  const detail = outcome.status === "sent" ? "" : ` (${outcome.reason})`;
  const line = `[proactive] ${kind}: ${outcome.status}${detail}`;
  if (outcome.status === "failed") console.error(line);
  else console.log(line);
  return proactiveExitCode(outcome);
}
