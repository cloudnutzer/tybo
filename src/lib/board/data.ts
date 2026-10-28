/**
 * Daten für die Board-Sitzung (Issue #357, Entscheidung E8): das Board
 * sammelt über die Quellen-Registry (src/lib/sources/) statt über eigene
 * Abrufe. Ziele kommen damit nur über die Quelle goals, also über den
 * Gedächtnis-Dienst; einen eigenen Supabase-Abruf gibt es hier nicht.
 *
 * Im Board gilt je Quelle höchstens BOARD_SOURCE_TIMEOUT_MS. Dafür läuft eine
 * Kopie der Quelle mit gekürztem timeoutMs, die Quelle selbst bleibt, wie sie
 * ist (das Morgenbriefing nutzt ihre eigenen Zeitlimits).
 *
 * Die Rückgabe hat die Form, die runBoardMeeting erwartet (BoardDataLike);
 * in errors stehen die Kennungen gescheiterter Quellen und solcher im
 * Zeitlimit, nicht eingerichtete fehlen dort.
 */
import type { BoardDataLike } from "../board-meeting";
import { SOURCES } from "../sources/list";
import { DEFAULT_SOURCE_TIMEOUT_MS, runSources, userTimeZone } from "../sources/run";
import type { Env, Source, SourceOutcome } from "../sources/types";
import { briefsFor, overdueSummary } from "./briefs";

/** Obergrenze je Quelle im Board */
export const BOARD_SOURCE_TIMEOUT_MS = 20_000;

export type BoardData = BoardDataLike;

export interface BoardDataOptions {
  /** Quellen-Liste, Standard SOURCES aus der Registry */
  sources?: readonly Source[];
  env?: Env;
  fetch?: typeof fetch;
  now?: Date;
  /** Obergrenze je Quelle; Tests setzen eine kurze */
  limitMs?: number;
  /** Nie Inhalte der Quellen übergeben */
  log?: (message: string) => void;
}

/** Kopie der Quelle, die höchstens limitMs läuft */
function capped(source: Source, limitMs: number): Source {
  const own = source.timeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
  return own <= limitMs ? source : { ...source, timeoutMs: limitMs };
}

function problems(outcomes: SourceOutcome[], log: (message: string) => void): string[] {
  const ids: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === "failed") log(`Quelle ${outcome.source.id} gescheitert: ${outcome.error}`);
    else if (outcome.status === "timeout") log(`Quelle ${outcome.source.id} im Zeitlimit nach ${outcome.ms} ms`);
    else continue;
    ids.push(outcome.source.id);
  }
  return ids;
}

export async function gatherBoardData(options: BoardDataOptions = {}): Promise<BoardData> {
  const began = Date.now();
  const env = options.env ?? process.env;
  const limitMs = options.limitMs ?? BOARD_SOURCE_TIMEOUT_MS;
  const log = options.log ?? ((message: string) => console.warn(`[Board] ${message}`));
  const list = (options.sources ?? SOURCES).map(source => capped(source, limitMs));

  const outcomes = await runSources(list, { env, now: options.now, fetch: options.fetch, timeoutMs: limitMs });
  const byId = new Map(outcomes.map(outcome => [outcome.source.id, outcome]));
  const view = { outcome: (id: string) => byId.get(id), timeZone: userTimeZone(env) };

  return {
    agentData: briefsFor(view),
    sharedSummary: overdueSummary(view),
    fetchDurationMs: Date.now() - began,
    errors: problems(outcomes, log),
  };
}
