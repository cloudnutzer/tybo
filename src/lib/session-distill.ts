import { atomicWriteFile } from "./atomic-file";
/**
 * Session Distillate + Auto-Review (docs/topic-sessions.md F-4).
 *
 * When a per-topic session ends (idle expiry, /new, model or engine change)
 * and it had enough substance, we resume the OLD session one last time and
 * ask for two things. Fortgesetzt wird über den Motor der Session (Issue
 * #122): bei Claude auf dem billigen Aux-Modell (AUX_MODEL_DISTILL), bei
 * anderen Motoren mit dem Modell der Session.
 *
 *   1. Durable insights as [REMEMBER:]/[GOAL:] intent tags.
 *   2. Routine detection: did this session demonstrate a repeatable
 *      workflow? If yes, a [ROUTINE: description] tag.
 *
 * Nothing is written silently (Hermes-Lehre: write_approval): proposals are
 * staged in data/pending-reviews.json and the user confirms via buttons. Seit
 * Issue #117 laufen die Knoepfe ueber das Rueckfragen-Register (Art "review",
 * ref = Review-ID, src/lib/review-choices.ts): in Telegram, im Browser und im
 * Terminal, genau einmal entschieden. "ok" wendet die Tags an, "routine"
 * friert die Routine ein (createRoutineFromSession). Alte Knoepfe
 * "rev|<aktion>|<id>" wirken weiter. Legacy direct-write behavior:
 * DISTILL_AUTO_APPLY=true.
 *
 * Fire-and-forget: distillation must never block or fail a user message.
 */

import { dirname, join } from "path";
import { mkdir, readFile } from "fs/promises";
import { acquireFileLock, releaseFileLock } from "./file-lock";
import { callAux } from "./aux-model";
import { processIntents } from "./memory";
import { log as sbLog } from "./convex";
import { getEngine } from "./engines";
import { normalizeSession, type BotSession } from "./session-manager";

const DISTILL_MIN_TURNS = parseInt(
  process.env.SESSION_DISTILL_MIN_TURNS || "6",
  10
);

const AUTO_APPLY = () => process.env.DISTILL_AUTO_APPLY === "true";

const DISTILL_PROMPT = `Diese Konversations-Session endet jetzt und wird verworfen.

Zwei Aufgaben:

1. Extrahiere die dauerhaft merkenswerten Erkenntnisse aus diesem Gespraech:
- getroffene Entscheidungen und deren Begruendung
- neue Fakten ueber den User, seine Projekte oder Praeferenzen
- vereinbarte Ziele oder offene Verpflichtungen

Gib sie AUSSCHLIESSLICH als Intent-Tags aus, maximal 5:
[REMEMBER: praegnanter Fakt]
[GOAL: Ziel | DEADLINE: Frist]   (DEADLINE nur wenn eine genannt wurde)

Nimm nur Dinge auf, die in Wochen noch relevant sind. Keine Smalltalk-Details,
nichts was bereits als Fakt/Goal gespeichert wurde (siehe MEMORY im Kontext).

2. Pruefe, ob in dieser Session ein WIEDERHOLBARER ABLAUF vorgemacht oder
erarbeitet wurde (ein mehrstufiger Workflow mit konkreten Quellen, Formaten
oder Korrekturen des Users, den man erneut ausfuehren koennte). Wenn ja, gib
zusaetzlich genau einen Tag aus:
[ROUTINE: kurze Beschreibung des Ablaufs in einem Satz]
Ein normales Frage-Antwort-Gespraech ist KEINE Routine — im Zweifel weglassen.

Gib NUR Tags aus, keine weiteren Erklaerungen.
Wenn nichts Merkenswertes dabei ist, antworte exakt mit: NONE`;

// ---------------------------------------------------------------------------
// Pending reviews (staged proposals awaiting user confirmation)
// ---------------------------------------------------------------------------

export interface PendingReview {
  id: string;
  type: "memory" | "routine";
  /**
   * Chat des Vorschlags: Telegram-Chat-ID oder, seit Issue #117, web:<id> fuer
   * reine Web-Gespraeche (vorher stand dort der Direktchat)
   */
  chatId: string;
  topicId?: number;
  /** Raw intent-tag text (memory type). */
  tags?: string;
  /** Routine description from the [ROUTINE:] tag (routine type). */
  routineDescription?: string;
  /**
   * Snapshot of the ended session, needed to freeze a routine later. Fehlt
   * bei Merk-Vorschlaegen aus einem einzelnen Turn (Issue #53).
   */
  session?: BotSession;
  /** Herkunft fuer Log und Nachricht, z.B. "Turn mit fremden Inhalten" */
  origin?: string;
  createdAt: number;
}

const DEFAULT_PENDING_FILE = join(process.cwd(), "data", "pending-reviews.json");
let pendingFile = DEFAULT_PENDING_FILE;
/** Nach 7 Tagen ist ein Vorschlag abgelaufen und wird nicht mehr angewendet */
export const REVIEW_MAX_AGE_MS = 7 * 24 * 3_600_000;

/** Abgelaufen ab genau 7 Tagen, wie eine Rueckfrage mit expiresAt (choices.ts) */
export function isReviewExpired(review: Pick<PendingReview, "createdAt">, now = Date.now()): boolean {
  return review.createdAt + REVIEW_MAX_AGE_MS <= now;
}

/** Nur fuer Tests: Ablage der Vorschlaege umlenken, null stellt zurueck. */
export function setPendingReviewsFileForTests(path: string | null): void {
  pendingFile = path ?? DEFAULT_PENDING_FILE;
}

// Bot und Sprach-Bruecke laufen in eigenen Prozessen und schreiben dieselbe
// Datei (Issue #53). Deshalb kein Cache: jede Aenderung liest die Datei frisch,
// unter einer Sperre mit Besitzer (file-lock.ts, <datei>.lock) und schreibt sie
// atomar zurueck. Innerhalb des Prozesses reiht pendingTail die Zugriffe auf.
let pendingTail: Promise<unknown> = Promise.resolve();

async function readPendingFile(file: string): Promise<Record<string, PendingReview>> {
  try {
    return JSON.parse(await readFile(file, "utf-8"));
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    return {};
  }
}

/** Liest, aendert und schreibt die Ablage unter Sperre; fn gibt zurueck, ob geschrieben werden muss. */
function updatePending<T>(fn: (pending: Record<string, PendingReview>) => { result: T; changed: boolean }): Promise<T> {
  const file = pendingFile;
  const run = pendingTail.catch(() => {}).then(async () => {
    await mkdir(dirname(file), { recursive: true });
    const lockFile = `${file}.lock`;
    const lock = await acquireFileLock(lockFile);
    try {
      const pending = await readPendingFile(file);
      const { result, changed } = fn(pending);
      if (changed) await atomicWriteFile(file, JSON.stringify(pending, null, 2));
      return result;
    } finally {
      await releaseFileLock(lockFile, lock).catch(() => {});
    }
  });
  pendingTail = run;
  return run;
}

/** Legt einen Vorschlag ab (und raeumt abgelaufene weg). Wirft, wenn das Speichern scheitert. */
export function stagePendingReview(review: PendingReview): Promise<void> {
  return updatePending(pending => {
    const now = Date.now();
    for (const [id, r] of Object.entries(pending)) {
      if (isReviewExpired(r, now)) delete pending[id];
    }
    pending[review.id] = review;
    return { result: undefined, changed: true };
  });
}

/**
 * Nimmt einen Vorschlag genau einmal heraus; ein zweiter Klick bekommt
 * undefined. Ein Vorschlag aelter als 7 Tage gilt als abgelaufen (Issue
 * #117): er wird entfernt und nicht herausgegeben, auch wenn seit dem Ablauf
 * nichts Neues abgelegt wurde (dort raeumt stagePendingReview auf).
 */
export function takePendingReview(id: string, now = Date.now()): Promise<PendingReview | undefined> {
  return updatePending(pending => {
    const review = Object.prototype.hasOwnProperty.call(pending, id) ? pending[id] : undefined;
    if (!review) return { result: undefined, changed: false };
    delete pending[id];
    if (isReviewExpired(review, now)) return { result: undefined, changed: true };
    // Snapshots aus der Zeit vor Issue #122 tragen noch claudeSessionId ohne engine
    return { result: review.session ? { ...review, session: normalizeSession(review.session) } : review, changed: true };
  });
}

// ---------------------------------------------------------------------------
// Zustellung (in bot.ts und der Sprach-Bruecke: createReviewNotifier aus
// review-choices.ts, eine Rueckfrage im Register)
// ---------------------------------------------------------------------------

/** Ein abgelegter Vorschlag, der mit Knoepfen gezeigt werden soll */
export interface ReviewProposal {
  reviewId: string;
  type: PendingReview["type"];
  /** Wie PendingReview.chatId: Telegram-Chat-ID oder web:<id> */
  chatId: string;
  topicId?: number;
  /** Fragetext mit Vorschau, ohne Knoepfe */
  text: string;
  createdAt: number;
}

/** Zeigt einen Vorschlag; wirft, wenn er nirgends angekommen ist */
export type ReviewNotifier = (proposal: ReviewProposal) => Promise<void>;

let notifier: ReviewNotifier | null = null;

export function setReviewNotifier(fn: ReviewNotifier | null): void {
  notifier = fn;
}

/** Zustellen; ein Fehler bleibt im Log, der Vorschlag liegt weiter in der Ablage */
async function notify(proposal: ReviewProposal): Promise<void> {
  if (!notifier) {
    console.warn(`[Review] Vorschlag ${proposal.reviewId} abgelegt, aber kein Zustellweg eingerichtet`);
    return;
  }
  try {
    await notifier(proposal);
  } catch (err) {
    console.error(`[Review] Vorschlag ${proposal.reviewId} abgelegt, Zustellung fehlgeschlagen:`, err);
  }
}

export interface StageMemoryReviewOptions {
  /** Telegram-Chat-ID oder web:<id> (reines Web-Gespraech) */
  chatId: string;
  topicId?: number;
  /** Nur Intent-Tags, nie der ganze Antworttext */
  tags: string;
  /** Erste Zeile der Nachricht, vor der Vorschau */
  header: string;
  origin?: string;
  session?: BotSession;
}

/**
 * Merk-Vorschlag ablegen und mit Knoepfen zustellen (Session-Review und
 * Issue #53). Wendet nie etwas an. Ohne Vorschau (keine erkennbaren Tags)
 * passiert nichts. Scheitert das Ablegen, wirft die Funktion; scheitert nur
 * die Zustellung, bleibt der Vorschlag liegen und es steht im Log.
 * Rueckgabe: die ID oder null ohne Vorschlag.
 */
export async function stageMemoryReview(opts: StageMemoryReviewOptions): Promise<string | null> {
  const preview = describeTags(opts.tags);
  if (!preview) return null;
  const id = newId();
  const createdAt = Date.now();
  await stagePendingReview({
    id,
    type: "memory",
    chatId: opts.chatId,
    ...(opts.topicId !== undefined ? { topicId: opts.topicId } : {}),
    tags: opts.tags,
    ...(opts.session ? { session: opts.session } : {}),
    ...(opts.origin ? { origin: opts.origin } : {}),
    createdAt,
  });
  await notify({
    reviewId: id,
    type: "memory",
    chatId: opts.chatId,
    ...(opts.topicId !== undefined ? { topicId: opts.topicId } : {}),
    text: `${opts.header}\n\n${preview}`,
    createdAt,
  });
  return id;
}

export interface StageRoutineReviewOptions {
  chatId: string;
  topicId?: number;
  description: string;
  session: BotSession;
}

/**
 * Routine-Angebot ablegen und mit Knoepfen zustellen, wie stageMemoryReview.
 * Wirft, wenn das Ablegen scheitert. Rueckgabe: die ID.
 */
export async function stageRoutineReview(opts: StageRoutineReviewOptions): Promise<string> {
  const id = newId();
  const createdAt = Date.now();
  await stagePendingReview({
    id,
    type: "routine",
    chatId: opts.chatId,
    ...(opts.topicId !== undefined ? { topicId: opts.topicId } : {}),
    routineDescription: opts.description,
    session: opts.session,
    createdAt,
  });
  await notify({
    reviewId: id,
    type: "routine",
    chatId: opts.chatId,
    ...(opts.topicId !== undefined ? { topicId: opts.topicId } : {}),
    text: `🔁 Diese Session sah nach einer wiederholbaren Routine aus:\n\n"${opts.description}"\n\nSoll ich den Ablauf als Routine einfrieren (Skill oder Script)?`,
    createdAt,
  });
  return id;
}

// ---------------------------------------------------------------------------
// Distillation
// ---------------------------------------------------------------------------

/** A session is worth distilling when it had a real conversation. */
export function shouldDistill(session: BotSession): boolean {
  return !!session.engineSessionId && session.messageCount >= DISTILL_MIN_TURNS;
}

/**
 * Parse chat/topic out of a session storage key
 * ("topic:{chatId}:{topicId}:{agent}" | "dm:{userId}:{agent}" | "group:{chatId}:{agent}"
 * | "web:{Gespraechs-ID}:{agent}", Issue #117: Vorschlag im Web-Gespraech).
 */
export function parseStorageKey(key: string): { chatId: string; topicId?: number } | null {
  const parts = key.split(":");
  if (parts[0] === "web" && parts.length >= 3 && WEB_CONVERSATION_ID.test(parts[1])) {
    return { chatId: `web:${parts[1]}` };
  }
  if (parts[0] === "topic" && parts.length >= 4) {
    return { chatId: parts[1], topicId: parseInt(parts[2], 10) };
  }
  if ((parts[0] === "dm" || parts[0] === "group") && parts.length >= 3) {
    return { chatId: parts[1] };
  }
  return null;
}

const WEB_CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Lesbare Vorschau aller fuenf Intent-Tags (Entscheidung 0008) fuer die
 * Bestaetigungs-Nachricht. Leer, wenn keins erkennbar ist.
 */
export function describeTags(tags: string): string {
  const lines: string[] = [];
  const patterns: [RegExp, string][] = [
    [/\[REMEMBER:\s*([^\]]+?)\s*\]/gi, "Fakt merken"],
    [/\[GOAL:\s*([^\]]+?)\s*\]/gi, "Ziel"],
    [/\[DONE:\s*([^\]]+?)\s*\]/gi, "Ziel erledigt"],
    [/\[CANCEL:\s*([^\]]+?)\s*\]/gi, "Ziel streichen"],
    [/\[FORGET:\s*([^\]]+?)\s*\]/gi, "Fakt vergessen"],
  ];
  for (const [pattern, label] of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(tags)) !== null) lines.push(`• ${label}: ${m[1].trim()}`);
  }
  return lines.join("\n");
}

/** Nur fuer Tests austauschbar: Aux-Aufruf, Motor und direktes Schreiben */
export interface DistillDeps {
  callAux: typeof callAux;
  processIntents: typeof processIntents;
  getEngine?: typeof getEngine;
}

const DISTILL_TIMEOUT_MS = 300_000;

/**
 * Die beendete Session einmal fortsetzen, über ihren eigenen Motor. Claude
 * wie bisher über callAux (Aux-Modell "distill" samt Effort-Regeln und
 * Claude-Ersatz, wenn OpenRouter/Ollama eingestellt ist); andere Motoren mit
 * dem Modell der Session. Eine fremde Session-ID geht nie an Claude: ist der
 * Motor nicht verfügbar, wirft getEngine und es gibt kein Destillat.
 */
async function resumeForDistill(session: BotSession, deps: DistillDeps): Promise<{ text: string; isError: boolean }> {
  if (session.engine === "claude") {
    return deps.callAux("distill", DISTILL_PROMPT, {
      resumeSessionId: session.engineSessionId,
      timeoutMs: DISTILL_TIMEOUT_MS,
    });
  }
  const engine = (deps.getEngine ?? getEngine)(session.engine);
  const result = await engine.run({
    prompt: DISTILL_PROMPT,
    streaming: false,
    model: session.model,
    ...(session.engineSessionId ? { resumeSessionId: session.engineSessionId } : {}),
    timeoutMs: DISTILL_TIMEOUT_MS,
    cwd: process.cwd(),
  });
  return { text: result.text || "", isError: result.isError || !!result.aborted || !!result.timedOut || !result.text };
}

/**
 * Resume the ended session once (über ihren Motor), extract insights and a
 * possible routine, and stage both for user confirmation. Never throws.
 */
export async function distillSession(
  session: BotSession,
  deps: DistillDeps = { callAux, processIntents }
): Promise<void> {
  try {
    const result = await resumeForDistill(session, deps);

    if (result.isError || !result.text || /^\s*NONE\s*$/.test(result.text)) {
      return;
    }

    // Split routine tag from memory tags
    const routineMatch = result.text.match(/\[ROUTINE:\s*([^\]]+?)\s*\]/i);
    const memoryTags = result.text.replace(/\[ROUTINE:\s*[^\]]+?\s*\]/gi, "").trim();
    const hasMemoryTags = /\[(REMEMBER|GOAL|DONE|CANCEL|FORGET):/i.test(memoryTags);

    const target = parseStorageKey(session.key);

    // Legacy path or no way to ask → apply directly (fail-open)
    if (AUTO_APPLY() || !notifier || !target) {
      if (hasMemoryTags) {
        const processed = await deps.processIntents(memoryTags);
        const added = processed.factsAdded.length + processed.goalsAdded.length;
        if (added > 0) {
          console.log(
            `[Distill] ${session.key}: +${processed.factsAdded.length} facts, +${processed.goalsAdded.length} goals (auto)`
          );
        }
      }
      return;
    }

    // Staged: memory proposals with confirm buttons
    if (hasMemoryTags) {
      await stageMemoryReview({
        chatId: target.chatId,
        topicId: target.topicId,
        tags: memoryTags,
        header: `🧠 Session-Rueckblick (${session.agentName}): das wuerde ich mir merken:`,
        origin: "Session-Rueckblick",
        session,
      });
    }

    // Staged: routine proposal
    if (routineMatch) {
      await stageRoutineReview({
        chatId: target.chatId,
        topicId: target.topicId,
        description: routineMatch[1].trim(),
        session,
      });
    }

    await sbLog("info", "bot", "Session review staged", {
      sessionKey: session.key,
      memory: hasMemoryTags,
      routine: !!routineMatch,
    });
  } catch (err) {
    console.error(`[Distill] ${session.key} failed:`, err);
  }
}
