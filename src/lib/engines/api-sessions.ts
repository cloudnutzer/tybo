/**
 * Sitzungen des Motors "api" (Issue #348): je Sitzung eine Datei unter
 * data/api-sessions/, Name ist die Kennung (zufällige UUID). Darin stehen
 * Modell, Zeitpunkte, der Verlauf im Format der Messages API und eine offene
 * ask_user-Pause.
 *
 * Kennung nach außen (EngineResult.sessionId): die UUID allein, oder bei
 * offener Pause "<uuid>.<pausenmarke>". Die Marke unterscheidet die Antwort
 * auf genau diese Pause von einem späteren Folgeturn: Ein Knopf mit Marke
 * (EngineRequest.answersQuestion), obwohl die Pause schon beantwortet ist
 * (Knopf nach getippter Antwort), bekommt einen Fehler statt einer zweiten
 * Fortsetzung; eine getippte Nachricht mit veralteter Marke ist ein normaler
 * Folgeturn.
 *
 * Regeln:
 * - Die Kennung wird vor jedem Lesen gegen ein festes Muster geprüft; aus der
 *   Anfrage kommt nie ein Pfadanteil.
 * - Schreiben atomar (temporäre Datei, dann umbenennen), Datei 0600, Ordner 0700.
 *   Ist das Signal des Laufs vor dem Umbenennen ausgelöst, bleibt die alte Datei.
 * - Werkzeugergebnisse werden beim Speichern auf TOOL_RESULT_KEEP Zeichen
 *   gekürzt, damit Sitzungen nicht unbegrenzt wachsen.
 * - Sitzungen, die SESSION_MAX_IDLE_DAYS nicht benutzt wurden, entfernt der
 *   Speicher beim nächsten Schreiben.
 * - Unbekannt, ungültig oder beschädigt heißt: nicht ladbar, nichts wird
 *   überschrieben. Beschädigt ist auch ein Verlauf, den die API ablehnen
 *   würde (validHistory): fehlende Blockfelder, falsche Rollenfolge, ein
 *   tool_use ohne passendes tool_result, eine Pause, die nicht zum Ende des
 *   Verlaufs passt. So geht nie ein halber Verlauf an die API.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AContent, AnthropicTurn } from "../anthropic-stream";
import type { ToolUse } from "../turn-tools";

/** So viele Zeichen eines Werkzeugergebnisses bleiben in der Datei */
export const TOOL_RESULT_KEEP = 4_000;
/** Nach so vielen Tagen ohne Nutzung wird eine Sitzung entfernt */
export const SESSION_MAX_IDLE_DAYS = 30;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const SESSION_FILE = new RegExp(`^(${UUID})\\.json$`);
const SESSION_REF = new RegExp(`^(${UUID})(?:\\.([0-9a-f]{12}))?$`);

/** Ergebnis eines Werkzeugs, wie es in der nächsten Nutzernachricht steht */
export interface ApiToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** Offene Rückfrage: auf diese tool_use_id wartet das Modell */
export interface ApiPause {
  toolUseId: string;
  /** Marke der Pause, Teil der Kennung nach außen */
  mark: string;
  /** Ergebnisse der übrigen Werkzeuge derselben Runde, schon ausgeführt */
  results: ApiToolResult[];
  /** Werkzeuge des pausierten Laufs: fremde Inhalte gelten auch für die Fortsetzung */
  uses: ToolUse[];
}

export interface ApiSession {
  id: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messages: AnthropicTurn[];
  pause?: ApiPause;
}

export type ApiSessionLoad =
  | { status: "ok"; session: ApiSession }
  /** Kennung passt nicht zum Muster */
  | { status: "invalid" }
  | { status: "missing" }
  /** Datei da, aber nicht lesbar oder kein gültiger Inhalt */
  | { status: "broken" };

export interface ApiSessionStore {
  load(id: string): Promise<ApiSessionLoad>;
  /**
   * Wirft, wenn nicht gespeichert werden konnte. Mit signal: ist es vor dem
   * endgültigen Schreiben ausgelöst (Abbruch, Zeitlimit), bleibt der
   * bisherige Stand und save wirft.
   */
  save(session: ApiSession, signal?: AbortSignal): Promise<void>;
}

/** Nur für Tests: hält das Schreiben vor dem Umbenennen an */
export interface ApiSessionStoreHooks {
  beforeCommit?(): Promise<void>;
}

/** Kennung nach außen in UUID und Pausenmarke zerlegen; null, wenn sie nicht passt */
export function parseSessionRef(ref: string): { id: string; mark?: string } | null {
  const m = SESSION_REF.exec(ref);
  if (!m) return null;
  return m[2] ? { id: m[1], mark: m[2] } : { id: m[1] };
}

/** Kennung nach außen: mit Marke, solange eine Pause offen ist */
export function sessionRef(session: Pick<ApiSession, "id" | "pause">): string {
  return session.pause ? `${session.id}.${session.pause.mark}` : session.id;
}

export function newSessionId(): string {
  return randomUUID();
}

export function newPauseMark(): string {
  return randomBytes(6).toString("hex");
}

function cut(text: string): string {
  return text.length > TOOL_RESULT_KEEP ? `${text.slice(0, TOOL_RESULT_KEEP)} […gekürzt]` : text;
}

/** Werkzeugergebnisse im Verlauf und in der Pause gekürzt */
export function trimSession(session: ApiSession): ApiSession {
  const trimBlock = (block: AContent): AContent => (block.type === "tool_result" ? { ...block, content: cut(block.content) } : block);
  const messages = session.messages.map((turn) => (typeof turn.content === "string" ? turn : { ...turn, content: turn.content.map(trimBlock) }));
  const pause = session.pause ? { ...session.pause, results: session.pause.results.map((r) => ({ ...r, content: cut(r.content) })) } : undefined;
  return { ...session, messages, ...(pause ? { pause } : {}) };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const filled = (v: unknown): v is string => typeof v === "string" && v !== "";
const optional = (v: unknown, type: "string" | "boolean") => v === undefined || typeof v === type;

/** Name der Rückfrage, wie ASK_USER in api-tools.ts (Schnittstelle zum Modell) */
const ASK_USER_NAME = "ask_user";

type Role = "user" | "assistant";

/** Ein Block mit allen Pflichtfeldern; tool_use und Denkblöcke nur vom Modell, tool_result nur vom Nutzer */
function validBlock(b: unknown, role: Role): boolean {
  if (!isObject(b)) return false;
  switch (b.type) {
    case "text":
      return filled(b.text);
    case "tool_use":
      return role === "assistant" && filled(b.id) && filled(b.name) && isObject(b.input);
    case "tool_result":
      return role === "user" && validResult(b);
    case "thinking":
      return role === "assistant" && typeof b.thinking === "string" && typeof b.signature === "string";
    case "redacted_thinking":
      return role === "assistant" && typeof b.data === "string";
    default:
      return false;
  }
}

function validResult(r: unknown): r is ApiToolResult {
  return isObject(r) && r.type === "tool_result" && filled(r.tool_use_id) && typeof r.content === "string" && optional(r.is_error, "boolean");
}

const blocksOf = (turn: AnthropicTurn): AContent[] => (typeof turn.content === "string" ? [] : turn.content);
const useIds = (turn: AnthropicTurn) => blocksOf(turn).flatMap((b) => (b.type === "tool_use" ? [b.id] : []));
const resultIds = (turn: AnthropicTurn) => blocksOf(turn).flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : []));

/** Gleiche Kennungen, jede genau einmal */
function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length || new Set(a).size !== a.length) return false;
  const want = new Set(b);
  return a.every((id) => want.has(id));
}

/**
 * Verlauf, den die Messages API ohne Fehler annimmt: mindestens eine
 * Nachricht, erst der Nutzer, dann abwechselnd; Inhalt nicht leer, jeder
 * Block mit seinen Feldern. Auf jedes tool_use antwortet die nächste
 * Nutzernachricht mit genau einem tool_result derselben ID (die Ergebnisse
 * vorn), Kennungen nie doppelt. Unbeantwortet bleiben darf nur das letzte
 * Modell-tool_use einer offenen Pause: genau deren Ergebnisse und die Frage.
 */
export function validHistory(value: unknown, pause?: Pick<ApiPause, "toolUseId" | "results">): value is AnthropicTurn[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const turns = value as unknown[];
  for (const [i, turn] of turns.entries()) {
    if (!isObject(turn) || turn.role !== (i % 2 === 0 ? "user" : "assistant")) return false;
    const role = turn.role as Role;
    if (typeof turn.content === "string") {
      if (turn.content === "") return false;
    } else if (!Array.isArray(turn.content) || turn.content.length === 0 || !turn.content.every((b) => validBlock(b, role))) {
      return false;
    }
  }
  const history = turns as AnthropicTurn[];
  const allUses = history.flatMap(useIds);
  if (new Set(allUses).size !== allUses.length) return false;
  for (const [i, turn] of history.entries()) {
    if (turn.role === "user") {
      const blocks = blocksOf(turn);
      const firstOther = blocks.findIndex((b) => b.type !== "tool_result");
      if (firstOther >= 0 && blocks.slice(firstOther).some((b) => b.type === "tool_result")) return false;
      // Ergebnisse nur zu den Aufrufen der Modellnachricht direkt davor
      const asked = i > 0 ? useIds(history[i - 1]) : [];
      if (!sameIds(resultIds(turn), asked)) return false;
      continue;
    }
    if (i < history.length - 1) continue; // die folgende Nutzernachricht prüft die Zuordnung
    const open = useIds(turn);
    if (!pause) return open.length === 0;
    const asked = blocksOf(turn).find((b) => b.type === "tool_use" && b.id === pause.toolUseId);
    if (!asked || asked.type !== "tool_use" || asked.name !== ASK_USER_NAME) return false;
    return sameIds([...pause.results.map((r) => r.tool_use_id), pause.toolUseId], open);
  }
  // Endet mit einer Nutzernachricht: eine offene Pause hätte keine Frage
  return !pause;
}

function validUse(u: unknown): u is ToolUse {
  return isObject(u) && filled(u.name) && optional(u.path, "string") && optional(u.command, "string") && optional(u.external, "boolean");
}

function validPause(value: unknown): value is ApiPause {
  return (
    isObject(value) &&
    filled(value.toolUseId) &&
    typeof value.mark === "string" &&
    /^[0-9a-f]{12}$/.test(value.mark) &&
    Array.isArray(value.results) &&
    value.results.every(validResult) &&
    Array.isArray(value.uses) &&
    value.uses.every(validUse)
  );
}

const isTime = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));

/** Sitzung mit gültigem Verlauf und einer Pause, die zu dessen Ende passt; sonst null */
export function asSession(raw: unknown, id: string): ApiSession | null {
  if (!isObject(raw) || raw.id !== id || !filled(raw.model) || !isTime(raw.createdAt) || !isTime(raw.updatedAt)) return null;
  if (raw.pause !== undefined && !validPause(raw.pause)) return null;
  if (!validHistory(raw.messages, raw.pause as ApiPause | undefined)) return null;
  return raw as unknown as ApiSession;
}

/** Ablage in einem Ordner; dir wird bei jedem Zugriff neu bestimmt (Tests, GO_PROJECT_ROOT) */
export function fileApiSessionStore(dir: () => string, now: () => number = Date.now, hooks: ApiSessionStoreHooks = {}): ApiSessionStore {
  async function sweep(folder: string, keep: string): Promise<void> {
    const limit = now() - SESSION_MAX_IDLE_DAYS * 86_400_000;
    let names: string[];
    try {
      names = await readdir(folder);
    } catch {
      return;
    }
    for (const name of names) {
      const m = SESSION_FILE.exec(name);
      if (!m || m[1] === keep) continue;
      try {
        if ((await stat(join(folder, name))).mtimeMs < limit) await rm(join(folder, name), { force: true });
      } catch {
        // Aufräumen ist Beiwerk
      }
    }
  }

  return {
    async load(id) {
      if (!new RegExp(`^${UUID}$`).test(id)) return { status: "invalid" };
      let text: string;
      try {
        text = await readFile(join(dir(), `${id}.json`), "utf8");
      } catch (e) {
        return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? { status: "missing" } : { status: "broken" };
      }
      try {
        const session = asSession(JSON.parse(text), id);
        return session ? { status: "ok", session } : { status: "broken" };
      } catch {
        return { status: "broken" };
      }
    },

    async save(session, signal) {
      if (!new RegExp(`^${UUID}$`).test(session.id)) throw new Error("Ungültige Sitzungskennung");
      const folder = dir();
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await chmod(folder, 0o700);
      const target = join(folder, `${session.id}.json`);
      const temp = join(folder, `.${session.id}.${randomBytes(4).toString("hex")}.tmp`);
      try {
        await writeFile(temp, JSON.stringify(trimSession(session)), { mode: 0o600 });
        await hooks.beforeCommit?.();
        // Umbenennen ist das endgültige Schreiben: davor beendet heißt, der alte Stand bleibt
        signal?.throwIfAborted();
        await rename(temp, target);
      } catch (e) {
        await rm(temp, { force: true }).catch(() => {});
        throw e;
      }
      await sweep(folder, session.id);
    },
  };
}
