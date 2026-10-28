/**
 * Check-in als Routine (Issue #364, Entscheidung E10).
 *
 *   bun run checkin              prüfen und, wenn es passt, eine Meldung senden
 *   bun run checkin --dry-run    nur zeigen, was entschieden würde
 *
 * Reihenfolge eines Laufs; was früher greift, spart alles Spätere:
 * 1. Regeln des Kerns (src/lib/proactive, Art checkin): abgeschaltet,
 *    Ruhezeit, Zeitfenster, Snooze, Mindestabstand, ein anderer Lauf ist
 *    schon dabei. Greift eine davon, gibt es keinen Modellaufruf.
 * 2. Letzte Nutzernachricht aus dem Speicher (getStore().messages,
 *    lastUserMessageAt): jüngste Nachricht mit role user über alle
 *    Gespräche, Telegram wie Browser, ohne Antworten und Meldungen. Schreibt
 *    der Nutzer gerade (jünger als ACTIVE_MINUTES), meldet sich der Check-in
 *    nicht, ebenfalls ohne Modellaufruf. Ein Abruffehler, ein Speicher ohne
 *    Verlauf (ohne Datenbank) oder eine ungültige Zeit beenden den Lauf als
 *    Fehler (Entscheidung 0025, „keine alten Daten"); es gibt keine
 *    geschätzte Ersatzzeit.
 * 3. Offene Ziele aus der Quelle goals (src/lib/sources) und die letzten
 *    Beiträge der Gespräche, beide streng: scheitert die Supabase-Abfrage
 *    der Ziele, gilt nicht die lokale Ablage (ohne Aktualitätsnachweis),
 *    und ein Fehler beim Lesen der Beiträge ist keine leere Liste. Beides
 *    beendet den Lauf als Fehler.
 * 4. Entscheidung über das Aux-Modell (Zweck checkin, Standard Haiku) als
 *    JSON, siehe readDecision. Kein JSON, unbekannte Aktion, leere oder zu
 *    lange Nachricht, Modellfehler oder Zeitlimit: nichts senden, Exit 1.
 * 5. Versand über den Kern mit den Knöpfen Erledigt, 30 Minuten später und,
 *    nur mit eingerichteten Anrufen, Anrufen (message.ask). Der Kern prüft
 *    die Regeln vor dem Senden noch einmal (Snooze während der Auswertung
 *    verhindert die Meldung) und setzt die Versandzeit nur bei Zustellung.
 *
 * Anrufen: Das Modell darf "call" nur vorschlagen. Mit eingerichteten
 * Anrufen wird daraus eine Meldung, die den Anruf anbietet; angerufen wird
 * erst, wenn der Nutzer den Knopf drückt (Rückfragen-Register). Ohne
 * Einrichtung wird "call" zur gewöhnlichen Meldung ohne Anruf-Knopf.
 *
 * Exit-Code: 1 bei jedem Fehler (Daten, Modell, Versand, Zustand), sonst 0;
 * ein Überspringen nach den Regeln oder weil das Modell nichts senden will
 * ist kein Fehler. Ins Log kommen Schritt und Grund, nie Inhalte.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { parseAuxJSON, type AuxResult } from "../lib/aux-model";
import { proactiveTimeZone } from "../lib/proactive/clock";
import { proactiveConfig } from "../lib/proactive/config";
import { proactiveExitCode, runProactive, type ProactiveDeps, type ProactiveMessage } from "../lib/proactive/deliver";
import { judgeKind } from "../lib/proactive/rules";
import { proactiveStatePath, readProactiveState } from "../lib/proactive/state";
import { getSettings } from "../lib/settings";
import { openGoals } from "../lib/memory";
import { goalsSource } from "../lib/sources/goals";
import { runSource } from "../lib/sources/run";
import type { Env, SectionItem, Source } from "../lib/sources/types";
import type { BoardRow } from "../lib/store/types";
import { settleAfterWake } from "./briefing";

/** Schreibt der Nutzer seit weniger Minuten, stört der Check-in nicht */
export const ACTIVE_MINUTES = 30;
/** Längste Meldung, die das Modell liefern darf */
export const MAX_MESSAGE_CHARS = 1_200;
/** Zeitlimit des Modellaufrufs */
export const AUX_TIMEOUT_MS = 90_000;
/** So viele jüngste Beiträge (über alle Gespräche) sieht das Modell, je gekürzt */
const RECENT_ROWS = 12;
const RECENT_CHARS = 300;
const PROFILE_CHARS = 1_500;

export const CALL_OFFER_PREFIX = "📞 Ich würde dich gern anrufen:\n\n";

export type CheckinAction = "none" | "text" | "call";
const ACTIONS: readonly CheckinAction[] = ["none", "text", "call"];

export interface CheckinDecision {
  action: CheckinAction;
  /** Leer bei none */
  message: string;
}

export type DecisionProblem = "no-json" | "action" | "empty" | "too-long";

/** Auslesen der Modellantwort; jede Abweichung vom Vertrag ist ein Problem */
export function readDecision(text: string): { ok: true; decision: CheckinDecision } | { ok: false; problem: DecisionProblem } {
  const parsed: unknown = parseAuxJSON(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, problem: "no-json" };
  const { action, message: raw } = parsed as { action?: unknown; message?: unknown };
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) return { ok: false, problem: "action" };
  if (action === "none") return { ok: true, decision: { action, message: "" } };
  const message = typeof raw === "string" ? raw.trim() : "";
  if (message === "") return { ok: false, problem: "empty" };
  if (message.length > MAX_MESSAGE_CHARS) return { ok: false, problem: "too-long" };
  return { ok: true, decision: { action: action as CheckinAction, message } };
}

/** Was aus einer gültigen Entscheidung gesendet wird; null bei none */
export function messageFor(decision: CheckinDecision, callAvailable: boolean): ProactiveMessage | null {
  if (decision.action === "none") return null;
  const offerCall = decision.action === "call" && callAvailable;
  return { text: offerCall ? `${CALL_OFFER_PREFIX}${decision.message}` : decision.message, ask: true };
}

/** Fehler eines Laufs mit Grund für das Log; der Kern beendet den Lauf dann mit Exit 1 */
export class CheckinError extends Error {
  constructor(readonly step: "history" | "goals" | "model", reason: string) {
    super(`${step}: ${reason}`);
    this.name = "CheckinError";
  }
}

/** Alles, was das Modell zur Entscheidung bekommt */
export interface CheckinFacts {
  now: Date;
  zone: string;
  /** null: der Nutzer hat noch nie geschrieben */
  lastUserMessage: Date | null;
  /** Letzte zugestellte Check-in-Meldung, aus dem Zustand des Kerns */
  lastCheckin: Date | null;
  goals: SectionItem[];
  pendingItems: string[];
  recent: BoardRow[];
  profile: string;
  callAvailable: boolean;
}

const minutesBetween = (later: Date, earlier: Date) => Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / 60_000));

function since(now: Date, at: Date | null, none: string): string {
  if (!at) return none;
  const minutes = minutesBetween(now, at);
  if (minutes < 120) return `vor ${minutes} Minuten`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `vor ${hours} Stunden` : `vor ${Math.floor(hours / 24)} Tagen`;
}

function wallClock(at: Date, zone: string): string {
  return at.toLocaleString("de-DE", { timeZone: zone, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** Auftrag an das Aux-Modell; rein, damit der Test ihn ohne Modell sieht */
export function checkinPrompt(facts: CheckinFacts): string {
  const goals = facts.goals.length
    ? facts.goals.map(g => `- ${g.text}${g.due ? ` (bis ${g.due}${g.overdue ? ", überfällig" : ""})` : ""}`).join("\n")
    : "- keine";
  const pending = facts.pendingItems.length ? facts.pendingItems.map(p => `- ${oneLine(p, RECENT_CHARS)}`).join("\n") : "- keine";
  const recent = facts.recent.length
    ? facts.recent
        .slice(0, RECENT_ROWS)
        .reverse()
        .map(r => `- ${r.role === "user" ? "Nutzer" : "tybo"}: ${oneLine(r.content ?? "", RECENT_CHARS)}`)
        .join("\n")
    : "- keine";
  const actions = facts.callAvailable
    ? '"none" (nichts senden), "text" (kurze Nachricht) oder "call" (Anruf anbieten, nur bei Dringendem wie einer Frist heute)'
    : '"none" (nichts senden) oder "text" (kurze Nachricht); Anrufe sind nicht eingerichtet';
  return [
    "Du bist tybo, ein persönlicher Assistent, und entscheidest, ob du dich jetzt von dir aus beim Nutzer meldest.",
    "Die harten Regeln (Ruhezeit, Zeitfenster, Mindestabstand, Snooze) sind schon geprüft und erlauben eine Meldung.",
    "",
    `Jetzt: ${wallClock(facts.now, facts.zone)} (${facts.zone})`,
    `Letzte Nachricht des Nutzers: ${since(facts.now, facts.lastUserMessage, "noch keine")}`,
    `Letzter Check-in: ${since(facts.now, facts.lastCheckin, "noch keiner")}`,
    "",
    "Offene Ziele:",
    goals,
    "",
    "Offene Punkte aus früheren Check-ins:",
    pending,
    "",
    "Letzte Beiträge (älteste zuerst):",
    recent,
    ...(facts.profile ? ["", "Profil des Nutzers:", facts.profile] : []),
    "",
    "Melde dich nur mit einem konkreten Anlass: ein Ziel mit naher Frist, eine offene Sache aus den letzten Beiträgen,",
    "oder wenn der Nutzer seit vielen Stunden nichts geschrieben hat. Sonst none. Schreib die Nachricht auf Deutsch,",
    "höchstens drei Sätze, freundlich und konkret, ohne Begrüßungsfloskel und ohne Gedankenstriche.",
    "",
    `Erlaubte Aktionen: ${actions}.`,
    'Antworte nur mit JSON: {"action": "none" | "text" | "call", "message": "Text der Nachricht, leer bei none"}',
  ].join("\n");
}

function validDate(value: string, what: string): Date {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new CheckinError("history", `${what} ist keine gültige Zeit`);
  return new Date(ms);
}

export interface CheckinRunDeps extends ProactiveDeps {
  /** Zeitpunkt der jüngsten Nutzernachricht (Speicher), null ohne Nachricht; wirft bei Abruffehler */
  lastUserMessageAt?: () => Promise<string | null>;
  /** Jüngste Beiträge über alle Gespräche, neueste zuerst */
  recentRows?: () => Promise<BoardRow[]>;
  /** Quelle der offenen Ziele; Standard goalsSource() ohne Rückfall auf die lokale Ablage */
  goals?: Source;
  fetch?: typeof fetch;
  /** Modellaufruf; Standard callAux("checkin", …) */
  aux?: (prompt: string) => Promise<AuxResult>;
  /** Anrufe eingerichtet? Standard isCallEnabled aus voice.ts */
  callAvailable?: () => boolean;
  /** Inhalt von config/profile.md; Standard aus GO_PROJECT_ROOT */
  profile?: () => Promise<string>;
  /** Vorschau statt Versand */
  dryRun?: boolean;
  print?: (text: string) => void;
  wait?: () => Promise<void>;
}

async function defaultLastUserMessageAt(): Promise<string | null> {
  const { getStore } = await import("../lib/store");
  return getStore().messages.lastUserMessageAt();
}

async function defaultRecentRows(): Promise<BoardRow[]> {
  const { getStore } = await import("../lib/store");
  return getStore().messages.boardRows(2, { strict: true });
}

async function defaultAux(prompt: string): Promise<AuxResult> {
  const { callAux } = await import("../lib/aux-model");
  return callAux("checkin", prompt, { timeoutMs: AUX_TIMEOUT_MS, quiet: true });
}

/** Knopf „Anrufen“ nur mit eingerichteten Anrufen, dieselbe Prüfung wie /anruf (Issue #367) */
export async function defaultCallAvailable(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const { phoneConfigured } = await import("../lib/phone/provider");
  return phoneConfigured(env);
}

async function readProfile(root: string): Promise<string> {
  try {
    return (await readFile(join(root, "config", "profile.md"), "utf-8")).slice(0, PROFILE_CHARS).trim();
  } catch {
    return "";
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Fehler";
}

type Decided = { kind: "quiet"; reason: string } | { kind: "message"; message: ProactiveMessage | null; decision: CheckinDecision };

/**
 * Schritte 2 bis 4: Daten holen, Regel „Nutzer aktiv", Modell. Wirft
 * CheckinError bei fehlenden Daten oder unbrauchbarer Antwort.
 */
async function decide(now: Date, zone: string, deps: CheckinRunDeps, env: Env): Promise<Decided> {
  const root = env.GO_PROJECT_ROOT || process.cwd();

  let lastRaw: string | null;
  try {
    lastRaw = await (deps.lastUserMessageAt ?? defaultLastUserMessageAt)();
  } catch (error) {
    throw new CheckinError("history", `Verlauf nicht lesbar (${errorName(error)})`);
  }
  const lastUserMessage = lastRaw === null ? null : validDate(lastRaw, "Letzte Nutzernachricht");
  if (lastUserMessage && now.getTime() - lastUserMessage.getTime() < ACTIVE_MINUTES * 60_000) {
    return { kind: "quiet", reason: "Nutzer aktiv" };
  }

  const goals = await runSource(deps.goals ?? goalsSource(() => openGoals({ localFallback: false })), { env, now, fetch: deps.fetch });
  if (goals.status !== "ok") throw new CheckinError("goals", `Ziele nicht lesbar (${goals.status})`);

  let recent: BoardRow[];
  try {
    recent = await (deps.recentRows ?? defaultRecentRows)();
  } catch (error) {
    throw new CheckinError("history", `Beiträge nicht lesbar (${errorName(error)})`);
  }

  const state = await readProactiveState(deps.statePath ?? proactiveStatePath(root));
  const lastSent = state.checkin.lastSentAt ? Date.parse(state.checkin.lastSentAt) : NaN;
  const callAvailable = deps.callAvailable ? deps.callAvailable() : await defaultCallAvailable();
  const facts: CheckinFacts = {
    now,
    zone,
    lastUserMessage,
    lastCheckin: Number.isFinite(lastSent) ? new Date(lastSent) : null,
    goals: goals.section.items,
    pendingItems: state.checkin.pendingItems,
    recent,
    profile: await (deps.profile ?? (() => readProfile(root)))(),
    callAvailable,
  };

  const answer = await (deps.aux ?? defaultAux)(checkinPrompt(facts));
  if (answer.isError) throw new CheckinError("model", "Modell ohne Antwort (Fehler oder Zeitlimit)");
  const read = readDecision(answer.text);
  if (!read.ok) throw new CheckinError("model", `Antwort unbrauchbar (${read.problem})`);
  return { kind: "message", decision: read.decision, message: messageFor(read.decision, callAvailable) };
}

/** Vorschau: Regeln ohne Reservierung prüfen, dann entscheiden und ausgeben, nichts senden oder schreiben */
async function preview(deps: CheckinRunDeps, env: Env): Promise<0 | 1> {
  const print = deps.print ?? (t => console.log(t));
  const now = deps.now?.() ?? new Date();
  const zone = proactiveTimeZone(env);
  const config = proactiveConfig(deps.settings ?? getSettings());
  const state = await readProactiveState(deps.statePath ?? proactiveStatePath(env.GO_PROJECT_ROOT || process.cwd()));
  const verdict = judgeKind({ now, zone, quietHours: config.quietHours, kind: config.checkin, record: state.checkin });
  if (!verdict.send) {
    print(`Kein Check-in jetzt (${verdict.reason}), kein Modellaufruf.`);
    return 0;
  }
  try {
    const decided = await decide(now, zone, deps, env);
    if (decided.kind === "quiet") print(`Kein Check-in jetzt (${decided.reason}), kein Modellaufruf.`);
    else if (!decided.message) print("Das Modell würde nichts senden.");
    else print(`Würde senden (${decided.decision.action}):\n\n${decided.message.text}`);
    return 0;
  } catch (error) {
    print(`Fehler: ${error instanceof Error ? error.message : "unbekannt"}`);
    return 1;
  }
}

/** Ein Lauf der Routine; Ergebnis ist der Exit-Code */
export async function runCheckin(deps: CheckinRunDeps = {}): Promise<0 | 1> {
  const env = deps.env ?? process.env;
  if (deps.dryRun) return preview(deps, env);

  await (deps.wait ?? settleAfterWake)();
  const outcome = await runProactive(
    "checkin",
    async ({ now, zone }) => {
      let decided: Decided;
      try {
        decided = await decide(now, zone, deps, env);
      } catch (error) {
        if (error instanceof CheckinError) console.error(`[checkin] ${error.message}`);
        throw error;
      }
      if (decided.kind === "quiet") console.log(`[checkin] keine Meldung (${decided.reason})`);
      else console.log(`[checkin] Entscheidung des Modells: ${decided.decision.action}`);
      return decided.kind === "message" ? decided.message : null;
    },
    deps,
  );
  const detail = outcome.status === "sent" ? "" : ` (${outcome.reason})`;
  const line = `[checkin] ${outcome.status}${detail}`;
  if (outcome.status === "failed") console.error(line);
  else console.log(line);
  return proactiveExitCode(outcome);
}

/** Erlaubt ist nur --dry-run; sonst null */
export function parseCheckinArgs(args: readonly string[]): { dryRun: boolean } | null {
  if (args.some(a => a !== "--dry-run")) return null;
  return { dryRun: args.includes("--dry-run") };
}

async function main(): Promise<number> {
  const parsed = parseCheckinArgs(process.argv.slice(2));
  if (!parsed) {
    console.error("Aufruf: bun run checkin [--dry-run]");
    return 2;
  }
  // Erst hier: der Import allein liest keine .env
  const { loadEnv } = await import("../lib/env");
  await loadEnv();
  return runCheckin({ dryRun: parsed.dryRun });
}

if (import.meta.main) {
  main().then(
    code => process.exit(code),
    error => {
      console.error(`[checkin] abgebrochen (${errorName(error)})`);
      process.exit(1);
    },
  );
}

