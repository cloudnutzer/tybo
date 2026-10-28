/**
 * Knöpfe in Telegram (Issue #338): Kette und Weiche für callback_query.
 *
 * Reihenfolge der Kette (installCallbackChain), jede Stufe reicht nur weiter,
 * was nicht ihr gehört:
 *   1. Besitzer: Klicks von anderen Absendern enden still, ohne Antwort
 *   2. alte Werkzeug-Freigaben "toolapproval:" (expired-approvals.ts)
 *   3. Rückfragen-Register "ch|" (telegram-choices.ts); dessen Ereignisabo
 *      zieht Nachrichten nach, die im Browser oder Terminal entschieden wurden
 *   4. die Weiche dieser Datei (createCallbackRouter)
 * Die Stufen 2 und 3 beantworten ihre Klicks selbst, die Weiche jeden Klick
 * genau einmal, bevor sie ihn einer Route gibt.
 *
 * Routen der Weiche, alle aus der Zeit vor dem Register und weiter gültig:
 *   topicmap:<topic>:<agent>  Agent eines Topics (topic-choices.ts)
 *   call_yes, call_no, snooze, dismiss  alte Check-in-Knöpfe, nur genau diese
 *   goalkb|<aktion>|<key>     /goal "Weiter?" (goal-actions.ts)
 *   rev|<aktion>|<id>         Merk-Vorschlag und Routine-Angebot (review-results.ts)
 *   atask:<auftrag>:<auswahl> Rückfrage eines alten Auftrags (legacy-task-buttons.ts)
 * Alles andere bekommt nur die Antwort auf den Klick.
 *
 * Bei atask setzt die Weiche den beanspruchten Auftrag fort: mit dem
 * gespeicherten Verlauf des früheren Gateways (messages_snapshot) über den
 * Motor api (Issue #348), sonst über die Session der Rückfrage im Mac-Zweig.
 * Alte Aufträge des Agent SDK (use_agent_sdk, agent_sdk_session_id) laufen
 * seit Issue #349 wie jeder Auftrag ohne messages_snapshot über den
 * Mac-Zweig; die Session des SDK lag beim Gateway und wird nicht benutzt.
 * Der Motor api schließt
 * wie der Mac-Zweig ab (resumeLegacyMacTask): speichern im Gespräch des
 * Auftrags, Merk-Tags mit den Werkzeugen des Laufs, Antwort, completed, eine
 * Folgefrage als Rückfrage des Registers an einem neuen Auftrag. Kein
 * Schlüssel oder ein Motorfehler ergibt wie früher die Ersatzantwort.
 */

import type { Composer, Context, MiddlewareFn } from "grammy";
import { resumeSnapshotTask, type SnapshotResumeOutcome } from "../../lib/engines/api-legacy";
import type { IntentTarget } from "../../lib/intent-gate";
import { claimLegacyTaskButton, replyWithReceipt, resumeLegacyMacTask, type LegacyTaskClaim } from "../../lib/legacy-task-buttons";
import type { AsyncTask, TaskChanges } from "../../lib/store/types";
import type { TaskPlace } from "../../lib/task-place";
import { taskResumeRecord, taskTarget, type MacResumeOutcome } from "../../lib/task-resume";
import { installTelegramChoices, type TelegramChoices } from "../../lib/telegram-choices";
import type { TurnTools } from "../../lib/turn-tools";

/** Feste Texte; englisch wie bisher, die Knöpfe stammen aus dieser Zeit */
export const CALLBACK_TEXT = {
  resumeFailed: "Error resuming task. Please try again.",
} as const;

// ---------------------------------------------------------------------------
// Präfix-Tabelle
// ---------------------------------------------------------------------------

export type CallbackRoute = "topicmap" | "checkin" | "goal" | "review" | "task";

/** Alte Check-in-Knöpfe: nur diese vier Werte, kein Präfix */
export const CHECKIN_BUTTONS: readonly string[] = ["call_yes", "call_no", "snooze", "dismiss"];

const ROUTES: readonly { route: CallbackRoute; owns(data: string): boolean }[] = [
  { route: "topicmap", owns: data => data.startsWith("topicmap:") },
  { route: "checkin", owns: data => CHECKIN_BUTTONS.includes(data) },
  { route: "goal", owns: data => data.startsWith("goalkb|") },
  { route: "review", owns: data => data.startsWith("rev|") },
  { route: "task", owns: data => data.startsWith("atask:") },
];

/** Route für die Daten eines Knopfs; null, wenn keine Route zuständig ist */
export function callbackRoute(data: string): CallbackRoute | null {
  return ROUTES.find(entry => entry.owns(data))?.route ?? null;
}

// ---------------------------------------------------------------------------
// Abhängigkeiten
// ---------------------------------------------------------------------------

type ResumeMessage = ReturnType<typeof taskResumeRecord>["message"];

export interface TaskButtonDeps {
  /** Chat-IDs des Direktchats (task-place.ts directChatIds) */
  directChatIds(): string[];
  /** Alter Auftrag mit messages_snapshot über den Motor api; Standard resumeSnapshotTask */
  resumeSnapshot?(task: AsyncTask, answer: string, fallbackChatId: string): Promise<SnapshotResumeOutcome>;
  /** Antwort eines Ersatzmodells, wenn das Fortsetzen scheitert */
  fallbackReply(task: AsyncTask, chatId: string): Promise<string>;
  /** Antwort in Telegram zeigen (sendResponse) */
  send(ctx: Context, text: string): Promise<unknown>;
  saveMessage(message: ResumeMessage): Promise<unknown>;
  /** Merk-Tags durch das Tor (processTurnIntents) */
  processIntents(text: string, tools: TurnTools | undefined, target: IntentTarget): Promise<unknown>;
  updateTask(taskId: string, changes: TaskChanges): Promise<unknown>;
  /** Offene Fäden nach der Antwort (Issue #290) */
  noteThreads(chatId: string, topicId: number | undefined, userText: string, reply: string, turnStartedAt: number): void;
  /** Meldung nach /stop bzw. beim Herunterfahren */
  abortedText(): string;
  typing(ctx: Context): { start(): void; stop(): void };
  now?(): number;
  /** Standard claimLegacyTaskButton */
  claim?(data: string, place: TaskPlace): Promise<LegacyTaskClaim>;
  /** Standard resumeLegacyMacTask */
  resumeMac?: typeof resumeLegacyMacTask;
  logError?(message: string, err: unknown): void;
}

export interface CallbackRouterDeps {
  /** topicmap: Zuordnung schreiben, Text für die Knopf-Nachricht */
  topicMap(chatId: string, topicId: string, agent: string): Promise<string>;
  /** Check-in-Knopf; null, wenn er nicht zum Check-in gehört */
  checkin(data: string, message: { chatId: string; messageId: number; text: string }): Promise<string | null>;
  /** goalkb|; null oder "" lassen die Nachricht stehen */
  goal(data: string): Promise<string | null>;
  /** rev|; leerer Text oder null lässt die Nachricht stehen */
  review(action: string, reviewId: string): Promise<{ text: string | null }>;
  task: TaskButtonDeps;
}

// ---------------------------------------------------------------------------
// Weiche
// ---------------------------------------------------------------------------

async function replaceMessage(ctx: Context, text: string): Promise<void> {
  await ctx.editMessageText(text).catch(() => {});
}

/** Weiche für alle Knöpfe, die nicht Werkzeug-Freigabe oder Register sind */
export function createCallbackRouter(deps: CallbackRouterDeps): (ctx: Context) => Promise<void> {
  const handlers: Record<CallbackRoute, (ctx: Context, data: string) => Promise<void>> = {
    async topicmap(ctx, data) {
      const [, topic = "", agent = ""] = data.split(":");
      await replaceMessage(ctx, await deps.topicMap(String(ctx.chat?.id ?? ""), topic, agent));
    },
    async checkin(ctx, data) {
      const message = ctx.callbackQuery?.message;
      const text = await deps.checkin(data, {
        chatId: String(ctx.chat?.id ?? ""),
        messageId: message?.message_id ?? 0,
        text: (message && "text" in message ? message.text : undefined) || "",
      });
      if (text !== null) await replaceMessage(ctx, text);
    },
    async goal(ctx, data) {
      const text = await deps.goal(data);
      if (text) await replaceMessage(ctx, text);
    },
    async review(ctx, data) {
      const [, action = "", reviewId = ""] = data.split("|");
      const { text } = await deps.review(action, reviewId);
      if (text) await replaceMessage(ctx, text);
    },
    task: (ctx, data) => continueTask(ctx, data, deps.task),
  };

  return async ctx => {
    const payload = ctx.callbackQuery?.data ?? "";
    if (payload === "") return;
    await ctx.answerCallbackQuery().catch(() => {});
    const route = callbackRoute(payload);
    if (route) await handlers[route](ctx, payload);
  };
}

// ---------------------------------------------------------------------------
// atask: alten Auftrag fortsetzen
// ---------------------------------------------------------------------------

async function continueTask(ctx: Context, data: string, deps: TaskButtonDeps): Promise<void> {
  const chatId = ctx.chat ? String(ctx.chat.id) : "";
  const topicId = ctx.msg?.message_thread_id;
  const place: TaskPlace = topicId === undefined ? { chatId } : { chatId, threadId: topicId };
  const claim = await (deps.claim ?? ((d, p) => claimLegacyTaskButton(d, p, { directChatIds: () => deps.directChatIds() })))(data, place);

  if (claim.status === "rejected") {
    // Gültige Knöpfe bleiben stehen, die Meldung kommt als eigene Nachricht
    if (claim.keepButtons) await ctx.reply(claim.text, { message_thread_id: topicId } as any).catch(() => {});
    else await replaceMessage(ctx, claim.text);
    return;
  }
  if (claim.status === "cancelled") {
    await replaceMessage(ctx, claim.text);
    return;
  }

  const { task, answer } = claim;
  // Ab hier zählt eine neue Rückfrage für die offenen Fäden (Issue #290)
  const startedAt = (deps.now ?? Date.now)();
  await replaceMessage(ctx, claim.text);
  const noteReply = (reply: string) => {
    const target = taskTarget(task, chatId);
    deps.noteThreads(target.chatId, target.topicId, answer, reply, startedAt);
  };

  const typing = deps.typing(ctx);
  typing.start();
  try {
    if (task.metadata?.messages_snapshot) await resumeSnapshot(ctx, chatId, task, answer, place, topicId, noteReply, deps);
    else await resumeOnMac(ctx, task, answer, place, topicId, noteReply, deps);
  } finally {
    typing.stop();
  }
}

/** Fortsetzen gescheitert: Ersatzantwort im Chat, sonst eine feste Meldung; Auftrag failed */
async function answerWithFallback(ctx: Context, chatId: string, task: AsyncTask, label: string, err: unknown, deps: TaskButtonDeps): Promise<void> {
  (deps.logError ?? console.error)(`${label} error:`, err);
  try {
    await deps.send(ctx, await deps.fallbackReply(task, chatId));
  } catch {
    await ctx.reply(CALLBACK_TEXT.resumeFailed);
  }
  await deps.updateTask(task.id, { status: "failed", result: String(err) });
}

/**
 * Alter Auftrag mit messages_snapshot: Motor api mit dem übernommenen
 * Verlauf, Abschluss wie im Mac-Zweig. Unvollständiger Stand: kein
 * Motoraufruf, Auftrag failed, Meldung im Topic.
 */
async function resumeSnapshot(
  ctx: Context,
  chatId: string,
  task: AsyncTask,
  answer: string,
  place: TaskPlace,
  topicId: number | undefined,
  noteReply: (reply: string) => void,
  deps: TaskButtonDeps
): Promise<void> {
  let outcome: SnapshotResumeOutcome;
  try {
    outcome = await (deps.resumeSnapshot ?? resumeSnapshotTask)(task, answer, chatId);
  } catch (err) {
    await answerWithFallback(ctx, chatId, task, "API resume", err, deps);
    return;
  }
  if (outcome.status === "invalid") {
    await deps.updateTask(task.id, { status: "failed", result: outcome.text });
    await ctx.reply(outcome.text, { message_thread_id: topicId } as any).catch(() => {});
    return;
  }
  // Kein Schlüssel oder Motorfehler: Ersatzantwort wie früher; Zeitlimit und Abbruch meldet der Mac-Zweig
  if (outcome.status === "done" && outcome.result.isError && !outcome.result.timedOut) {
    await answerWithFallback(ctx, chatId, task, "API resume", new Error(outcome.result.text || "Motorfehler"), deps);
    return;
  }
  const finished: MacResumeOutcome =
    outcome.status === "aborted"
      ? { status: "aborted" }
      : { status: "done", result: outcome.result, resumeId: outcome.sessionId, agent: outcome.agent, engine: "api", model: outcome.model };
  await resumeOnMac(ctx, task, answer, place, topicId, noteReply, deps, {
    resume: async () => finished,
    processIntents: (text, tools, target) => deps.processIntents(text, tools, target),
  });
}

async function resumeOnMac(
  ctx: Context,
  task: AsyncTask,
  answer: string,
  place: TaskPlace,
  topicId: number | undefined,
  noteReply: (reply: string) => void,
  deps: TaskButtonDeps,
  extra: Pick<Parameters<typeof resumeLegacyMacTask>[3], "resume" | "processIntents"> = {}
): Promise<void> {
  // Unter der Session-Sperre (Issue #189); eine Folgefrage wird Rückfrage des Registers
  const outcome = await (deps.resumeMac ?? resumeLegacyMacTask)(task, answer, place, {
    conversation: topicId === undefined ? { type: "telegram", chatId: place.chatId } : { type: "telegram", chatId: place.chatId, topicId },
    reply: text => replyWithReceipt(ctx, text, deps.send),
    notice: async text => {
      await ctx.reply(text, { message_thread_id: topicId } as any);
    },
    saveMessage: message => deps.saveMessage(message),
    abortedText: () => deps.abortedText(),
    ...extra,
  });
  if (outcome.status === "replied") noteReply(outcome.response);
}

// ---------------------------------------------------------------------------
// Kette
// ---------------------------------------------------------------------------

export interface CallbackChain {
  /** Telegram-ID des Besitzers */
  owner: string;
  /** Stufe 2: alte Werkzeug-Freigaben */
  toolApproval: MiddlewareFn<Context>;
  /** Stufe 3: Register; fehlt, wenn Telegram keine Rückfrage-Knöpfe hat */
  choices?: TelegramChoices;
  router: (ctx: Context) => Promise<void>;
  /** Bereich des Updates (Warteschlange, /stop, Neustart); Standard: direkt */
  scope?(ctx: Context, run: () => Promise<void>): Promise<void>;
  logError?(message: string, err: unknown): void;
}

/** Hängt die Kette an; zurück kommt das Abmelden vom Register */
export function installCallbackChain(composer: Composer<Context>, chain: CallbackChain): () => void {
  composer.on("callback_query:data", async (ctx, next) => {
    if (String(ctx.from?.id ?? "") === chain.owner) await next();
  });
  composer.on("callback_query:data", chain.toolApproval);
  const unsubscribe = chain.choices ? installTelegramChoices(composer, chain.choices) : () => {};
  const scope = chain.scope ?? ((_ctx, run) => run());
  composer.on("callback_query:data", ctx => {
    // Nicht warten: ein langer Auftrag hält sonst die übrigen Updates auf
    scope(ctx, () => chain.router(ctx)).catch(err => (chain.logError ?? console.error)("Callback query error:", err));
  });
  return unsubscribe;
}
