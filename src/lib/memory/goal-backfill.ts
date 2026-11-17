/**
 * Ziele nachholen (Issue #518): Bis dahin scheiterte jedes [GOAL:] mit
 * Supabase still (Spalte completed fehlte), die Tags stehen aber noch in alten
 * Antworten. `tybo gedaechtnis ziele-nachholen` sucht sie und legt jedes Ziel
 * als eigenen Vorschlag mit Knöpfen vor (stageMemoryReview, review-choices.ts).
 * Gespeichert wird erst, wenn der Nutzer zustimmt.
 *
 * Vollständig: gelesen wird seitenweise nach ID über alle Antworten, ohne
 * Meldungen (display_only). Scheitert eine Seite, wird nichts vorgeschlagen.
 *
 * Wiederholbar: je Zieltext (ohne Rücksicht auf Groß- und Kleinschreibung und
 * Leerraum) höchstens ein Vorschlag, die jüngste Nennung zählt. Es entfällt,
 * was als offenes oder erledigtes Ziel schon gespeichert ist und was schon
 * einmal vorgeschlagen wurde; das steht als Prüfsumme, ohne Text, in
 * data/goal-backfill.json. Wer verworfen hat, wird nicht noch einmal gefragt.
 * Nur ein zugestellter Vorschlag zählt als vorgeschlagen.
 *
 * Eine relative Frist wie „morgen“ gilt ab der alten Antwort, nicht ab heute:
 * sie steht im Vorschlag als fester Zeitpunkt. Eine unlesbare Frist ergibt
 * wie beim normalen Anlegen ein Ziel ohne Frist.
 *
 * Ins Log und in die Ausgabe des Befehls kommen keine Zieltexte.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { containsPattern } from "../../../supabase/functions/_shared/like-pattern";
import { atomicWriteFile } from "../atomic-file";
import { acquireFileLock, releaseFileLock } from "../file-lock";
import { NOT_DISPLAY_ONLY_FILTER } from "../store/supabase/messages";
import { parseDeadline } from "../when";
import { parseMemoryIntents } from "./intents";

/** So viele Zeilen je Abruf; Supabase liefert ohnehin höchstens 1000 */
const PAGE_SIZE = 500;

export interface OldReply {
  id: string | number;
  content: string;
  created_at: string;
}

/** Ein Ziel aus einer alten Antwort */
export interface GoalCandidate {
  /** Prüfsumme des Zieltexts */
  key: string;
  text: string;
  /** Fester Zeitpunkt der Frist, ISO */
  deadline?: string;
  /** Zeitpunkt der alten Antwort, ISO */
  mentionedAt: string;
}

const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/** Prüfsumme eines Zieltexts; so steht kein Zieltext im Vermerk */
export const goalKey = (text: string) => createHash("sha256").update(normalized(text)).digest("hex").slice(0, 32);

/** Frist einer alten Antwort als fester Zeitpunkt; unlesbar: keine */
function fixedDeadline(words: string | undefined, mentionedAt: Date, timeZone: string): string | undefined {
  if (!words) return undefined;
  try {
    return parseDeadline(words, { now: mentionedAt, timeZone })?.toISOString();
  } catch {
    return undefined;
  }
}

/** Ziele aus alten Antworten, je Zieltext einmal mit der jüngsten Nennung */
export function goalCandidates(replies: OldReply[], timeZone: string): GoalCandidate[] {
  const found = new Map<string, GoalCandidate>();
  for (const reply of replies) {
    const mentionedAt = new Date(reply.created_at);
    if (!Number.isFinite(mentionedAt.getTime())) continue;
    for (const intent of parseMemoryIntents(reply.content)) {
      if (intent.type !== "goal") continue;
      const key = goalKey(intent.text);
      const deadline = fixedDeadline(intent.deadline, mentionedAt, timeZone);
      const known = found.get(key);
      if (known && Date.parse(known.mentionedAt) > mentionedAt.getTime()) continue;
      found.set(key, { key, text: intent.text, mentionedAt: mentionedAt.toISOString(), ...(deadline ? { deadline } : {}) });
    }
  }
  return [...found.values()].sort((a, b) => Date.parse(a.mentionedAt) - Date.parse(b.mentionedAt));
}

/** Das Ziel als Tag für den Vorschlag, die Frist als fester Zeitpunkt */
export function goalTag(candidate: GoalCandidate): string {
  return `[GOAL: ${candidate.text}${candidate.deadline ? ` | DEADLINE: ${candidate.deadline}` : ""}]`;
}

/** Erste Zeile des Vorschlags: woher das Ziel kommt */
export function goalHeader(candidate: GoalCandidate, timeZone: string): string {
  const day = new Date(candidate.mentionedAt).toLocaleDateString("de-DE", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" });
  return `🧠 Ziel aus einer alten Antwort vom ${day}. Nichts ist gespeichert, bis du zustimmst:`;
}

// ---------------------------------------------------------------------------
// Lesen aus Supabase
// ---------------------------------------------------------------------------

/** Alle Zeilen über Seiten nach ID; wirft, wenn eine Seite scheitert */
async function allPages<T extends { id: string | number }>(page: (afterId: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const rows: T[] = [];
  let after = 0;
  while (true) {
    const { data, error } = await page(after);
    if (error || !Array.isArray(data)) throw new Error("Seite nicht lesbar");
    rows.push(...(data as T[]));
    if (data.length < PAGE_SIZE) return rows;
    after = Number((data[data.length - 1] as T).id);
  }
}

/** Alle Antworten mit einem [GOAL:]-Tag, ohne Meldungen */
export function readRepliesWithGoals(client: SupabaseClient): Promise<OldReply[]> {
  return allPages<OldReply>(after =>
    client
      .from("messages")
      .select("id,content,created_at")
      .eq("role", "assistant")
      .or(NOT_DISPLAY_ONLY_FILTER)
      .ilike("content", containsPattern("[GOAL:"))
      .gt("id", after)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE),
  );
}

/** Texte aller gespeicherten Ziele, offen oder erledigt */
export async function readStoredGoalTexts(client: SupabaseClient): Promise<string[]> {
  const rows = await allPages<{ id: number; content: string }>(after =>
    client.from("memory").select("id,content").in("type", ["goal", "completed_goal"]).gt("id", after).order("id", { ascending: true }).limit(PAGE_SIZE),
  );
  return rows.map(row => row.content);
}

// ---------------------------------------------------------------------------
// Vermerk der Vorschläge
// ---------------------------------------------------------------------------

export function goalBackfillFile(root: string): string {
  return join(root, "data", "goal-backfill.json");
}

async function readOffered(file: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return {};
    throw e;
  }
  const parsed: unknown = JSON.parse(raw);
  const offered = (parsed as { offered?: unknown } | null)?.offered;
  if (!offered || typeof offered !== "object") throw new Error("Vermerk nicht lesbar");
  return offered as Record<string, string>;
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------

export interface GoalBackfillDeps {
  readReplies(): Promise<OldReply[]>;
  readStoredGoals(): Promise<string[]>;
  /** Vermerk der Vorschläge, liegt unter data/; daneben die Sperre für parallele Aufrufe */
  file: string;
  timeZone: string;
  /** Legt den Vorschlag ab und zeigt ihn; false oder Wurf: nicht zugestellt */
  propose(candidate: GoalCandidate): Promise<boolean>;
  now?(): Date;
}

export interface GoalBackfillReport {
  /** Verschiedene Ziele in alten Antworten */
  found: number;
  /** Schon als offenes oder erledigtes Ziel gespeichert */
  stored: number;
  /** Schon bei einem früheren Aufruf vorgeschlagen */
  offeredBefore: number;
  /** Jetzt vorgeschlagen */
  offered: number;
  /** Nicht zugestellt, beim nächsten Aufruf wieder dabei */
  failed: number;
}

/** Sucht und schlägt vor; wirft, wenn etwas nicht lesbar ist, dann ist nichts vorgeschlagen */
export async function runGoalBackfill(deps: GoalBackfillDeps): Promise<GoalBackfillReport> {
  await mkdir(dirname(deps.file), { recursive: true });
  const lockFile = `${deps.file}.lock`;
  const lock = await acquireFileLock(lockFile);
  try {
    const offered = await readOffered(deps.file);
    const [replies, storedGoals] = await Promise.all([deps.readReplies(), deps.readStoredGoals()]);
    const stored = new Set(storedGoals.map(goalKey));
    const candidates = goalCandidates(replies, deps.timeZone);
    const report: GoalBackfillReport = { found: candidates.length, stored: 0, offeredBefore: 0, offered: 0, failed: 0 };
    for (const candidate of candidates) {
      if (stored.has(candidate.key)) {
        report.stored++;
        continue;
      }
      if (offered[candidate.key]) {
        report.offeredBefore++;
        continue;
      }
      let delivered = false;
      try {
        delivered = await deps.propose(candidate);
      } catch (e) {
        console.error(`[Gedächtnis] Ziel nachholen: Vorschlag nicht zugestellt (${e instanceof Error ? e.name : "Fehler"})`);
      }
      if (!delivered) {
        report.failed++;
        continue;
      }
      report.offered++;
      // Nach jedem Vorschlag: ein Abbruch mittendrin fragt beim nächsten Aufruf nicht doppelt
      offered[candidate.key] = (deps.now?.() ?? new Date()).toISOString();
      await atomicWriteFile(deps.file, JSON.stringify({ offered }, null, 2));
    }
    return report;
  } finally {
    await releaseFileLock(lockFile, lock).catch(() => {});
  }
}
