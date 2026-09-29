import { runExecution, checkAborted, currentExecution, isIntakeClosed } from "./execution-context";
import { terminateProcessTree } from "./process-tree";
import { atomicWriteFile } from "./atomic-file";
/**
 * Goal Engine — /goal: der Bot arbeitet weiter, bis das Ziel erreicht ist
 * (nach dem Vorbild von Hermes' Persistent
 * Goals mit Judge und Quality Gates).
 *
 * Ablauf pro Zyklus:
 *   1. Quality Gates (deterministische Shell-Kommandos) — schlaegt eines
 *      fehl, entfaellt das LLM-Judging und der Fehler-Output fliesst in den
 *      naechsten Arbeits-Turn.
 *   2. Judge (billiges Aux-Modell, striktes JSON): done | continue | wait.
 *   3. continue → naechster Arbeits-Turn ueber die normale Topic-Session
 *      (--resume), Antwort geht sichtbar nach Telegram.
 *
 * Harte Grenzen (wichtiger als bei Hermes, weil Subscription-Credit):
 *   - Turn-Budget (GOAL_MAX_TURNS, Default 10) → Auto-Pause mit
 *     Weiter?-Rueckfrage statt Endlosschleife (Knoepfe Weiter +5 und
 *     Beenden, seit Issue #118 ueber das Rueckfragen-Register, siehe
 *     src/lib/goal-choices.ts).
 *   - 2 Judge-Fehlschlaege in Folge → Pause (fail-open waere hier
 *     Budget-Verbrennung).
 *   - /stop bricht den laufenden Subprocess ab und pausiert das Ziel.
 *
 * Zustand: data/goals.json (sessionKey → ActiveGoal), ueberlebt Neustarts.
 * Die Engine kennt Telegram/Claude nur ueber initGoalEngine()-Deps —
 * bot.ts injiziert die konkreten Funktionen (kein Import-Zyklus).
 *
 * Kanal-neutral (Issue #76): Statusmeldungen gehen mit Art und Knoepfen
 * (Beschriftung + Aktion) an deps.sendStatus; Telegram macht daraus wie
 * bisher ein Inline-Keyboard (src/lib/goal-actions.ts), die WebUI eine
 * Meldung im Verlauf. Jede Aenderung am Ziel meldet onGoalChange, damit die
 * Status-Karte im Browser live mitlaeuft, auch nach dem ausloesenden Befehl.
 */

import { dirname, join } from "path";
import { mkdir, readFile, writeFile } from "fs/promises";
import { callAux, parseAuxJSON } from "./aux-model";
import { processTurnIntents } from "./intent-gate";
import type { TurnTools } from "./turn-tools";
import { saveMessage, log as sbLog } from "./convex";
import { sanitizeModelOutput, truncateBeforeSanitize } from "./telegram";

export interface ActiveGoal {
  sessionKey: string;
  chatId: string;
  topicId?: number;
  agentName: string;
  goal: string;
  gates: string[];
  maxTurns: number;
  turnsUsed: number;
  status: "active" | "paused" | "done";
  createdAt: number;
  updatedAt: number;
  /** Judge-Begruendung oder Gate-Output fuer den naechsten Arbeits-Turn. */
  lastNote?: string;
  judgeFailures: number;
  /**
   * true: die letzte Pause kam vom Turn-Budget (workLoop), nicht vom User
   * oder Judge. Nur dann gilt die Budget-Frage (Issue #118); jede andere
   * Pause setzt es zurueck.
   */
  budgetPaused?: boolean;
}

/** Knopf unter einer Statusmeldung; action ist in Telegram die callback_data */
export interface GoalButton {
  label: string;
  action: string;
}

/**
 * Art einer Statusmeldung: "turn" ist der Zwischenstand vor jedem Arbeits-Turn
 * (die Karte im Browser zeigt ihn selbst), "resumed" die Fortsetzung nach einem
 * Neustart (Issue #190), die anderen beenden oder pausieren.
 */
export type GoalStatusKind = "turn" | "budget" | "waiting" | "judge-failed" | "no-reply" | "done" | "resumed";

export interface GoalStatusMessage {
  kind: GoalStatusKind;
  /** Markdown, in Telegram als HTML */
  text: string;
  buttons?: GoalButton[][];
}

/**
 * Wohin eine Statusmeldung gehoert. createdAt ist die Kennung des Ziels
 * (goalId): die Budget-Frage (Issue #118) bindet ihre Knoepfe daran.
 */
export type GoalTarget = Pick<ActiveGoal, "sessionKey" | "chatId" | "topicId" | "agentName" | "goal" | "createdAt">;

/** Aenderung an einem Ziel (onGoalChange); goal null: kein Ziel mehr */
export interface GoalChange {
  sessionKey: string;
  goal: ActiveGoal | null;
  /** Die Arbeits-Schleife laeuft gerade */
  running: boolean;
  /** Nur mit goal null: erreicht oder beendet */
  ended?: "done" | "stopped";
}

export interface GoalEngineDeps {
  /** Bot-level callClaude: volle Prompt-Pipeline + Session-Resume. */
  callAgent: (
    prompt: string,
    chatId: string,
    agentName: string,
    topicId?: number
  ) => Promise<{ text: string; aborted: boolean; /** Werkzeuge des Turns, undefined: unbekannt (Issue #53) */ tools?: TurnTools }>;
  /** Antwort sichtbar unter der Agenten-Identitaet posten. */
  sendAsAgent: (
    agentName: string,
    chatId: string,
    text: string,
    topicId?: number
  ) => Promise<void>;
  /** Status-/Pause-Nachricht, kanal-neutral mit Knoepfen (Telegram: Haupt-Bot mit Inline-Keyboard). */
  sendStatus: (target: GoalTarget, message: GoalStatusMessage) => Promise<void>;
  /** Antwort eines Ziel-Turns speichern; Standard saveMessage aus ./convex (Tests reichen eine Attrappe herein) */
  saveMessage?: typeof saveMessage;
  /**
   * Der Prozess fährt herunter (Neustart, SIGTERM). Ein Abbruch gilt dann
   * nicht als /stop: das Ziel bleibt aktiv und läuft nach dem Start weiter (Issue #190).
   */
  isShuttingDown?: () => boolean;
}

/** Wie viele Turns der Weiter-Knopf nach dem Turn-Budget dazugibt (/goal weiter gibt keine) */
export const GOAL_EXTEND_TURNS = 5;

let goalsFile = join(process.cwd(), "data", "goals.json");
/** Schreibt den Zustand; Tests koennen das Speichern anhalten (configureGoalStore) */
let writeGoals: (file: string, data: string) => Promise<void> = atomicWriteFile;
const DEFAULT_MAX_TURNS = parseInt(process.env.GOAL_MAX_TURNS || "10", 10);
const GATE_TIMEOUT_MS = 5 * 60_000;
const MAX_JUDGE_FAILURES = 2;

let deps: GoalEngineDeps | null = null;
const runningLoops = new Set<string>();

export function initGoalEngine(d: GoalEngineDeps): void {
  deps = d;
}

/**
 * Andere Datei fuer den Zustand, Cache verworfen. Nur fuer Tests, damit sie
 * nie in data/goals.json des Arbeitsverzeichnisses schreiben.
 */
export function configureGoalStore(options: { file: string; write?: (file: string, data: string) => Promise<void> }): void {
  goalsFile = options.file;
  writeGoals = options.write ?? atomicWriteFile;
  cache = null;
  initialLoad = undefined;
}

const changeListeners = new Set<(change: GoalChange) => void>();

/** Meldet jede Aenderung an einem Ziel (Status-Karte der WebUI); gibt die Abmeldung zurueck */
export function onGoalChange(listener: (change: GoalChange) => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

function emitChange(sessionKey: string, ended?: GoalChange["ended"]): void {
  if (changeListeners.size === 0) return;
  const g = cache?.[sessionKey];
  const change: GoalChange = {
    sessionKey,
    goal: g ? { ...g, gates: [...g.gates] } : null,
    running: runningLoops.has(sessionKey),
    ...(ended && !g ? { ended } : {}),
  };
  for (const listener of [...changeListeners]) {
    try {
      listener(change);
    } catch (err) {
      console.error("[GoalEngine] change listener failed:", err);
    }
  }
}

function markLoop(sessionKey: string, running: boolean): void {
  if (running) runningLoops.add(sessionKey);
  else runningLoops.delete(sessionKey);
  emitChange(sessionKey);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let cache: Record<string, ActiveGoal> | null = null;

let initialLoad: ReturnType<typeof loadUncached> | undefined;
async function loadUncached(): Promise<Record<string, ActiveGoal>> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(goalsFile, "utf-8"));
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    cache = {};
  }
  return cache!;
}

async function persist(): Promise<void> {
  if (!cache) return;
  try {
    await mkdir(dirname(goalsFile), { recursive: true });
    await writeGoals(goalsFile, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error("[GoalEngine] persist failed:", err);
  }
}

export async function getGoal(sessionKey: string): Promise<ActiveGoal | undefined> {
  return (await load())[sessionKey];
}

export async function setGoal(goal: {
  sessionKey: string;
  chatId: string;
  topicId?: number;
  agentName: string;
  goal: string;
}): Promise<ActiveGoal> {
  const goals = await load();
  const now = Date.now();
  const existing = goals[goal.sessionKey];
  const entry: ActiveGoal = {
    ...goal,
    gates: existing?.gates ?? [],
    maxTurns: existing?.maxTurns ?? DEFAULT_MAX_TURNS,
    turnsUsed: 0,
    status: "active",
    // createdAt ist die Kennung des Ziels (goalId): ein Nachfolger in derselben Millisekunde bekommt eine neue
    createdAt: existing && existing.createdAt >= now ? existing.createdAt + 1 : now,
    updatedAt: now,
    judgeFailures: 0,
  };
  goals[goal.sessionKey] = entry;
  emitChange(goal.sessionKey);
  await persist();
  return entry;
}

/**
 * Gilt goalId (createdAt) nicht fuer das gespeicherte Ziel, hat es jemand
 * ersetzt: dann nichts aendern. Aufrufer pruefen nach dem letzten await,
 * damit zwischen Pruefen und Aendern kein anderer Ablauf drankommt.
 */
function goalFor(
  goals: Record<string, ActiveGoal>,
  sessionKey: string,
  goalId?: number,
  onlyIf?: (g: ActiveGoal) => boolean
): ActiveGoal | undefined {
  const g = goals[sessionKey];
  return g && (goalId === undefined || g.createdAt === goalId) && (!onlyIf || onlyIf(g)) ? g : undefined;
}

/**
 * ended: wie die Status-Karte endet (Standard "stopped", finishGoal sagt "done").
 * goalId: nur dieses Ziel loeschen, nie einen Nachfolger.
 * onCleared laeuft ohne await nach Pruefen und Loeschen, also bevor ein
 * Nachfolger gesetzt sein kann (Stopp bricht dort die Arbeit des geloeschten
 * Ziels ab, nie die seines Nachfolgers).
 * onlyIf: weitere Bedingung an das Ziel, geprueft im selben Schritt wie goalId.
 */
export async function clearGoal(
  sessionKey: string,
  ended: "done" | "stopped" = "stopped",
  goalId?: number,
  onCleared?: () => void,
  onlyIf?: (g: ActiveGoal) => boolean
): Promise<boolean> {
  const goals = await load();
  if (!goalFor(goals, sessionKey, goalId, onlyIf)) return false;
  delete goals[sessionKey];
  onCleared?.();
  emitChange(sessionKey, ended);
  await persist();
  return true;
}

/** goalId: nur dieses Ziel aendern; undefined, wenn es nicht mehr da oder ersetzt ist */
export async function updateGoal(
  sessionKey: string,
  patch: Partial<ActiveGoal>,
  goalId?: number
): Promise<ActiveGoal | undefined> {
  const goals = await load();
  const g = goalFor(goals, sessionKey, goalId);
  if (!g) return undefined;
  Object.assign(g, patch, { updatedAt: Date.now() });
  emitChange(sessionKey);
  await persist();
  return g;
}

/**
 * Weiter-Knopf nach dem Turn-Budget: nur ein pausiertes Ziel wird wieder
 * aktiv und bekommt extraTurns dazu. Pruefen und Setzen ohne await
 * dazwischen, damit ein Doppelklick das Budget nicht zweimal erhoeht.
 * goalId (createdAt) schuetzt vor einem Knopf eines frueheren Ziels,
 * onlyIf (im selben Schritt geprueft) vor einer ueberholten Entscheidung.
 */
export async function extendGoal(
  sessionKey: string,
  extraTurns: number,
  goalId?: number,
  onlyIf?: (g: ActiveGoal) => boolean
): Promise<"resumed" | "active" | "missing"> {
  const goals = await load();
  const g = goalFor(goals, sessionKey, goalId, onlyIf);
  if (!g || g.status === "done") return "missing";
  if (g.status !== "paused") return "active";
  Object.assign(g, {
    status: "active",
    judgeFailures: 0,
    maxTurns: g.maxTurns + Math.max(0, extraTurns),
    updatedAt: Date.now(),
  });
  emitChange(sessionKey);
  await persist();
  void startGoalWork(sessionKey);
  return "resumed";
}

/** budget: Auto-Pause am Turn-Budget (workLoop); sonst manuell, /stop oder Judge */
export async function pauseGoal(
  sessionKey: string,
  note?: string,
  goalId?: number,
  budget = false
): Promise<ActiveGoal | undefined> {
  return updateGoal(sessionKey, { status: "paused", budgetPaused: budget, ...(note ? { lastNote: note } : {}) }, goalId);
}

export function isGoalLoopRunning(sessionKey: string): boolean {
  return runningLoops.has(sessionKey);
}

/** Laufende Ziel-Schleifen, auch zwischen ihren Turns (Neustart-Prüfung, Issue #190) */
export function runningGoalLoopCount(): number {
  return runningLoops.size;
}

export function formatGoalStatus(g: ActiveGoal | undefined): string {
  if (!g) {
    return "Kein aktives Ziel in diesem Topic.\n\nSo geht's: `/goal <was erreicht werden soll>`: ich arbeite dann selbststaendig weiter, bis es erreicht ist (oder das Turn-Budget aufgebraucht ist und ich nachfrage).";
  }
  const statusLabel =
    g.status === "active" ? "aktiv" : g.status === "paused" ? "pausiert" : "erledigt";
  const lines = [
    `**Ziel:** ${g.goal}`,
    `**Status:** ${statusLabel}, Turn ${g.turnsUsed}/${g.maxTurns}`,
  ];
  if (g.gates.length > 0) {
    lines.push(`**Gates:**\n${g.gates.map((c, i) => `${i + 1}. \`${c}\``).join("\n")}`);
  }
  // Befund des Judge-Modells: vor dem Kürzen bereinigt (Issue #52)
  if (g.lastNote) lines.push(`**Letzter Befund:** ${sanitizeModelOutput(g.lastNote).substring(0, 300)}`);
  lines.push(
    `\nBefehle: /goal pause · /goal weiter · /goal stop · /goal gate add <cmd> · /goal max <n>`
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Quality Gates
// ---------------------------------------------------------------------------

/** Run all gates; returns failure output of the first failing gate, or null. */
async function runGatesUnlocked(g: ActiveGoal): Promise<string | null> {
  for (const cmd of g.gates) {
    checkAborted();
    try {
      const proc = Bun.spawn({
        detached: process.platform !== "win32",
        cmd: ["/bin/sh", "-c", cmd],
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const signal = currentExecution()?.controller.signal;
      const abort = () => terminateProcessTree(proc);
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        try {
          terminateProcessTree(proc);
        } catch {}
      }, GATE_TIMEOUT_MS);
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      checkAborted();
      if (exitCode !== 0) {
        const tail = (stdout + "\n" + stderr).trim().split("\n").slice(-25).join("\n");
        return `Gate fehlgeschlagen (exit ${exitCode}): \`${cmd}\`\n${tail.substring(0, 1500)}`;
      }
    } catch (err) {
      return `Gate nicht ausfuehrbar: \`${cmd}\`: ${String(err).substring(0, 200)}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

interface Verdict {
  verdict: "done" | "continue" | "wait";
  reason: string;
}

async function judgeGoalUnlocked(g: ActiveGoal, lastResponse: string): Promise<Verdict | null> {
  const prompt = `Du bist der Ziel-Judge eines autonomen Assistenten. Bewerte streng, ob das Ziel des Users durch die bisherige Arbeit ERREICHT ist.

ZIEL: ${g.goal}

LETZTE ANTWORT DES AGENTEN (Turn ${g.turnsUsed}/${g.maxTurns}):
${lastResponse.substring(0, 5000)}

Bewertungsregeln:
- "done" NUR, wenn die Antwort belegt, dass das Ziel vollstaendig erreicht ist (Ergebnis liegt vor, nicht nur ein Plan oder eine Ankuendigung).
- "continue", wenn noch konkrete Arbeit offen ist. Nenne in reason den naechsten Schritt.
- "wait", wenn gerade nichts getan werden kann (es laeuft ein externer Prozess, es fehlt eine Information, die nur der User liefern kann). Nenne in reason, worauf gewartet wird.
- Eine blosse Absichtserklaerung ("ich werde jetzt...") ist NIE "done".

Antworte AUSSCHLIESSLICH mit einem JSON-Objekt, ohne weiteren Text:
{"verdict": "done" | "continue" | "wait", "reason": "kurze Begruendung bzw. naechster Schritt"}`;

  const result = await callAux("judge", prompt, { timeoutMs: 120_000 });
  if (result.isError) return null;
  const parsed = parseAuxJSON(result.text);
  if (!parsed || !["done", "continue", "wait"].includes(parsed.verdict)) return null;
  // Befund bleibt Original (lastNote, Prompt), nur auf 500 Zeichen gekürzt.
  // Bereinigt wird erst beim Senden an Telegram (Guard, Issue #52)
  return { verdict: parsed.verdict, reason: truncateBeforeSanitize(String(parsed.reason || ""), 500) };
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

function continuationPrompt(g: ActiveGoal): string {
  return `[Autonome Ziel-Fortsetzung, Turn ${g.turnsUsed + 1}/${g.maxTurns}]

Aktives Ziel: ${g.goal}
${g.lastNote ? `\nBefund aus dem letzten Zyklus (Judge oder Quality Gate):\n${g.lastNote}\n` : ""}
Arbeite jetzt den naechsten konkreten Schritt Richtung Ziel ab. Erledige echte Arbeit (Tools nutzen, Dateien schreiben, pruefen), keine Plaene ankuendigen. Wenn du das Ziel fuer vollstaendig erreicht haeltst, fasse das Ergebnis kompakt zusammen und benenne, woran man das Erreichen erkennt.`;
}

/**
 * Evaluate the latest agent response for a goal and keep working if needed.
 * Called fire-and-forget after user-driven turns AND internally by the loop.
 */
export async function onAgentTurnForGoal(
  sessionKey: string,
  agentName: string,
  lastResponse: string
): Promise<void> {
  if (!deps) return;
  const g = await getGoal(sessionKey);
  if (!g || g.status !== "active") return;
  if (g.agentName !== agentName) return;
  // Neustart läuft (Issue #190): keine neue Schleife, das Ziel bleibt aktiv und geht danach weiter
  if (runningLoops.has(sessionKey) || isIntakeClosed()) return;

  markLoop(sessionKey, true);
  let finished = false;
  try {
    await evaluateAndContinue(sessionKey, g.createdAt, lastResponse);
    await continueWhileActive(sessionKey);
    finished = true;
  } finally {
    endLoop(sessionKey, finished);
  }
}

/** Kick off work on a freshly set goal (first turn) — used by /goal <text>. */
export async function startGoalWork(sessionKey: string): Promise<void> {
  if (!deps) return;
  // Neustart läuft (Issue #190): nicht anfangen, resumeActiveGoalsAfterStart setzt fort
  if (runningLoops.has(sessionKey) || isIntakeClosed() || deps.isShuttingDown?.()) return;
  markLoop(sessionKey, true);
  let finished = false;
  try {
    await continueWhileActive(sessionKey);
    finished = true;
  } finally {
    endLoop(sessionKey, finished);
  }
}

/**
 * Solange die Schleife markiert ist, prallt jedes startGoalWork ab: ein
 * Nachfolger (/goal <text>) oder ein fortgesetztes Ziel (Weiter, /goal weiter,
 * waehrend die Budget- oder Warte-Meldung noch lief) wird hier weitergefuehrt.
 * workLoop kehrt bei einem aktiven Ziel nur zurueck, wenn es inzwischen
 * jemand fortgesetzt oder ersetzt hat.
 */
async function continueWhileActive(sessionKey: string): Promise<void> {
  for (;;) {
    const next = await getGoal(sessionKey);
    // Beim Shutdown (Issue #190) keinen weiteren Turn anfangen, das Ziel bleibt aktiv
    if (!next || next.status !== "active" || deps?.isShuttingDown?.()) return;
    await workLoop(sessionKey, next.createdAt);
  }
}

/**
 * Markierung loesen und ohne await dazwischen nachsehen, ob das Ziel nach der
 * letzten Pruefung in continueWhileActive fortgesetzt wurde: dann neu starten.
 * Nach einem Fehler (finished false) nicht, sonst liefe er endlos wieder an.
 */
function endLoop(sessionKey: string, finished: boolean): void {
  markLoop(sessionKey, false);
  if (finished && cache?.[sessionKey]?.status === "active") void startGoalWork(sessionKey);
}

let resumedAfterStart = false;

/** Meldung, mit der ein aktives Ziel nach dem Neustart weiterläuft */
export function goalResumedText(g: ActiveGoal): string {
  return `🔄 Nach dem Neustart arbeite ich am Ziel weiter (Turn ${g.turnsUsed}/${g.maxTurns}):\n"${g.goal}"`;
}

/**
 * Nach dem Start (Issue #190): aktive Ziele aus data/goals.json fortsetzen,
 * je mit einer Meldung im Gespräch des Ziels. Pausierte (auch am Turn-Budget)
 * und erledigte bleiben stehen. Budget, turnsUsed und judgeFailures bleiben,
 * wie sie gespeichert sind. Wirkt einmal pro Prozess; gibt die fortgesetzten
 * Session-Schlüssel zurück.
 */
export async function resumeActiveGoalsAfterStart(): Promise<string[]> {
  if (!deps || resumedAfterStart) return [];
  resumedAfterStart = true;
  const resumed: string[] = [];
  for (const g of Object.values(await load())) {
    if (g.status !== "active" || runningLoops.has(g.sessionKey)) continue;
    try {
      await deps.sendStatus(g, { kind: "resumed", text: goalResumedText(g) });
    } catch (err) {
      console.error("[GoalEngine] Fortsetzungs-Meldung nicht gesendet:", err instanceof Error ? err.name : typeof err);
    }
    // Während der Meldung gestoppt, pausiert oder ersetzt: nicht mehr fortsetzen
    const current = cache?.[g.sessionKey];
    if (!current || current.createdAt !== g.createdAt || current.status !== "active") continue;
    resumed.push(g.sessionKey);
    void startGoalWork(g.sessionKey);
  }
  return resumed;
}

/**
 * onStart-Handler für bot.start (Issue #190): grammY ruft ihn erst nach der
 * Initialisierung (getMe, deleteWebhook), vorher läuft kein Ziel weiter.
 * Mehrfache Aufrufe setzen nichts doppelt fort (resumeActiveGoalsAfterStart).
 */
export function goalResumeOnStart(resume: () => Promise<string[]> = resumeActiveGoalsAfterStart): () => Promise<void> {
  return () =>
    resume()
      .then(keys => { if (keys.length) console.log(`[GoalEngine] ${keys.length} aktive Ziele nach dem Start fortgesetzt`); })
      .catch(e => console.error(`[GoalEngine] Fortsetzen nach dem Start gescheitert (${e instanceof Error ? e.name : "Fehler"})`));
}

/** Nur für Tests: resumeActiveGoalsAfterStart wieder erlauben */
export function resetGoalResumeForTests(): void {
  resumedAfterStart = false;
}

/**
 * Resume a paused goal (/goal weiter or the Weiter?-button). goalId: nur
 * dieses Ziel; Pruefen und Setzen ohne await dazwischen.
 */
export async function resumeGoalWork(sessionKey: string, extraTurns = 0, goalId?: number): Promise<boolean> {
  const goals = await load();
  const g = goalFor(goals, sessionKey, goalId);
  if (!g || g.status === "done") return false;
  Object.assign(g, {
    status: "active",
    judgeFailures: 0,
    ...(extraTurns > 0 ? { maxTurns: g.maxTurns + extraTurns } : {}),
    updatedAt: Date.now(),
  });
  emitChange(sessionKey);
  await persist();
  void startGoalWork(sessionKey);
  return true;
}

/**
 * Gates + Judge fuer die letzte Antwort, dann ggf. weiterarbeiten. Alles nur
 * fuer das Ziel goalId: ist es nach einem await ersetzt oder geloescht, endet
 * der Ablauf ohne Aenderung.
 */
async function evaluateAndContinue(sessionKey: string, goalId: number, lastResponse: string): Promise<void> {
  if (!deps) return;
  const g = await getGoal(sessionKey);
  if (!g || g.createdAt !== goalId || g.status !== "active") return;
  if (await afterChecks(sessionKey, goalId, g, lastResponse)) await workLoop(sessionKey, goalId);
}

/**
 * Gates und Judge nach einer Antwort. true: weiterarbeiten; false: fertig,
 * wartend, pausiert oder das Ziel gehoert nicht mehr diesem Ablauf.
 */
async function afterChecks(sessionKey: string, goalId: number, g: ActiveGoal, lastResponse: string): Promise<boolean> {
  if (!deps) return false;

  // 1. Quality Gates zuerst — deterministisch schlaegt LLM
  const gateFailure = await runGates(g);
  // Shutdown-Abbruch (Issue #190): Gate oder Judge wurde abgebrochen, kein
  // Befund. Nichts zaehlen oder pausieren, das Ziel laeuft nach dem Start weiter
  if (deps.isShuttingDown?.()) return false;
  if (gateFailure) return !!(await updateGoal(sessionKey, { lastNote: gateFailure }, goalId));

  // 2. Judge
  const verdict = await judgeGoal(g, lastResponse);
  if (deps.isShuttingDown?.()) return false;
  if (!verdict) {
    const failed = await updateGoal(sessionKey, { judgeFailures: g.judgeFailures + 1 }, goalId);
    if (!failed) return false;
    if (failed.judgeFailures >= MAX_JUDGE_FAILURES) {
      const paused = await pauseGoal(sessionKey, "Judge mehrfach nicht erreichbar", goalId);
      if (!paused) return false;
      await deps.sendStatus(paused, {
        kind: "judge-failed",
        text: `⚠️ Ziel pausiert: Der Judge war ${MAX_JUDGE_FAILURES}x nicht erreichbar. Mit /goal weiter geht es weiter.`,
      });
      return false;
    }
    return true;
  }

  const current = await updateGoal(sessionKey, { judgeFailures: 0 }, goalId);
  if (!current) return false;

  if (verdict.verdict === "done") {
    await finishGoal(current, verdict.reason);
    return false;
  }

  if (verdict.verdict === "wait") {
    const paused = await pauseGoal(sessionKey, verdict.reason, goalId);
    if (!paused) return false;
    await deps.sendStatus(paused, {
      kind: "waiting",
      text: `⏸️ Ziel wartet: ${verdict.reason}\n\nSobald es weitergehen kann: /goal weiter`,
    });
    return false;
  }

  return !!(await updateGoal(sessionKey, { lastNote: verdict.reason }, goalId));
}

/** Arbeits-Turns bis done/wait/pause/Budget, nur fuer das Ziel goalId. */
async function workLoop(sessionKey: string, goalId: number): Promise<void> {
  if (!deps) return;

  while (true) {
    // Beim Shutdown (Issue #190) keinen weiteren Turn, das Ziel bleibt aktiv
    if (deps.isShuttingDown?.()) return;
    let g = await getGoal(sessionKey);
    if (!g || g.createdAt !== goalId || g.status !== "active") return;

    // Turn-Budget: Auto-Pause mit Nachfrage statt Endlosschleife
    if (g.turnsUsed >= g.maxTurns) {
      if (!(await pauseGoal(sessionKey, undefined, goalId, true))) return;
      await deps.sendStatus(g, {
        kind: "budget",
        text: `⏸️ Turn-Budget erreicht (${g.turnsUsed}/${g.maxTurns}) fuer das Ziel:\n"${g.goal}"\n\nWeitermachen?`,
      });
      return;
    }

    await deps.sendStatus(g, {
      kind: "turn",
      text: `🎯 Ziel-Turn ${g.turnsUsed + 1}/${g.maxTurns}: arbeite weiter...`,
    });

    // Waehrend sendStatus gestoppt, pausiert oder ersetzt: der Abbruch fand
    // noch keinen Agentenaufruf, die alte Arbeit darf jetzt nicht starten
    const stillCurrent = await getGoal(sessionKey);
    if (!stillCurrent || stillCurrent.createdAt !== goalId || stillCurrent.status !== "active") return;
    // Shutdown begann waehrend sendStatus: abortAllEngineCalls ist schon
    // durchgelaufen und faende diesen Aufruf nicht mehr
    if (deps.isShuttingDown?.()) return;

    const { text, aborted, tools } = await deps.callAgent(
      continuationPrompt(g),
      g.chatId,
      g.agentName,
      g.topicId
    );

    if (aborted) {
      // Abbruch durch den Shutdown (Issue #190): nicht pausieren, der Zustand
      // bleibt aktiv und resumeActiveGoalsAfterStart setzt nach dem Start fort
      if (deps.isShuttingDown?.()) return;
      await pauseGoal(sessionKey, "Vom User gestoppt (/stop)", goalId);
      return;
    }

    // Gestoppt oder ersetzt, waehrend der Agent arbeitete: Antwort verwerfen
    const counted = await updateGoal(sessionKey, { turnsUsed: g.turnsUsed + 1 }, goalId);
    if (!counted) return;
    g = counted;

    if (!text) {
      if (!(await pauseGoal(sessionKey, "Agent lieferte keine Antwort", goalId))) return;
      await deps.sendStatus(g, {
        kind: "no-reply",
        text: "⚠️ Ziel pausiert: Der Agent hat keine Antwort geliefert. Mit /goal weiter geht es weiter.",
      });
      return;
    }

    await deps.sendAsAgent(g.agentName, g.chatId, text, g.topicId);
    await (deps.saveMessage ?? saveMessage)({
      chat_id: g.chatId,
      role: "assistant",
      content: text,
      metadata: { agent: g.agentName, topicId: g.topicId, type: "goal_turn" },
    }).catch(() => {});
    await processTurnIntents(text, tools, { chatId: g.chatId, topicId: g.topicId, origin: "Ziel-Turn" }).catch(() => {});

    // Gates + Judge auf diesen Turn — bei continue laeuft die Schleife weiter
    const current = await getGoal(sessionKey);
    if (!current || current.createdAt !== goalId) return;
    if (!(await afterChecks(sessionKey, goalId, current, text))) return;
  }
}

/** Nur das Ziel g loeschen; ist es inzwischen ersetzt, keine Meldung */
async function finishGoal(g: ActiveGoal, reason: string): Promise<void> {
  if (!(await clearGoal(g.sessionKey, "done", g.createdAt))) return;
  await deps?.sendStatus(g, {
    kind: "done",
    text: `✅ Ziel erreicht (${g.turnsUsed}/${g.maxTurns} Turns):\n"${g.goal}"\n\n${reason}`,
  });
  await sbLog("info", "bot", "Goal completed", {
    sessionKey: g.sessionKey,
    goal: g.goal.substring(0, 200),
    turns: g.turnsUsed,
  }).catch(() => {});
}

async function runGates(g: ActiveGoal) {
  return runExecution(g.sessionKey, g.agentName, () => runGatesUnlocked(g));
}
async function judgeGoal(g: ActiveGoal, lastResponse: string) {
  return runExecution(g.sessionKey, g.agentName, () => judgeGoalUnlocked(g, lastResponse));
}

async function load() {
  if (cache) return cache;
  initialLoad ||= loadUncached().catch(error => { initialLoad = undefined; throw error; });
  return initialLoad;
}
