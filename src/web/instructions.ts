/**
 * Agenten-Anweisungen in der WebUI (Issue #36), dasselbe wie /agent in
 * Telegram: GET, POST (eine Zeile hinzufügen), DELETE (alle) und
 * DELETE .../last unter /api/agents/<name>/instructions.
 *
 * Gespeichert wird in config/agent-overrides.json über
 * src/lib/agent-overrides.ts; src/bot.ts übergibt die Funktionen als
 * InstructionsPort (bot-settings.ts), diese Datei importiert nichts aus
 * src/lib. Die Schreibkette dort umfasst Telegram und WebUI.
 *
 * Für die Einstellungsansicht (Issue #38): Jede Antwort mit Liste trägt eine
 * revision (revision.ts) und einen digest der Liste. Beide DELETE nehmen
 * optional { expected: "<digest>" } der angezeigten Liste; weicht die
 * gespeicherte ab, antwortet der Server 409 mit der aktuellen Liste und
 * entfernt nichts. So löscht „Letzte entfernen" nie eine andere Anweisung als
 * die angezeigte letzte. Der digest ist gleich lang für jede Liste, die
 * Bedingung passt also immer unter das Body-Limit (Codex-Befund Runde 8).
 */

import { createHash } from "node:crypto";
import { createRevisionClock, type RevisionClock } from "./revision";
import type { ApiResult } from "./settings";

/**
 * clear und removeLast mit unchanged: nur, wenn unchanged die Liste in der
 * Schreibkette bestätigt, sonst InstructionsChanged und nichts geändert.
 * Ohne unchanged wie /agent in Telegram.
 */
export interface InstructionsPort {
  list(agent: string): string[];
  add(agent: string, text: string): Promise<number>;
  clear(agent: string, unchanged?: (list: readonly string[]) => boolean): Promise<number>;
  removeLast(agent: string, unchanged?: (list: readonly string[]) => boolean): Promise<string | undefined>;
}

/** Prüfwert einer Liste (SHA-256 über das JSON), gleiche Liste gibt gleichen Wert */
export function instructionsDigest(list: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(list)).digest("hex");
}

/** Die Liste hat sich seit der Anzeige geändert (z.B. per /agent in Telegram) */
export class InstructionsChanged extends Error {
  constructor() {
    super("Anweisungen inzwischen geändert");
    this.name = "InstructionsChanged";
  }
}

export const INSTRUCTIONS_PATH = /^\/api\/agents\/([^/]+)\/instructions(\/last)?$/;
export const INSTRUCTION_MAX_CHARS = 1000;

export const INSTRUCTIONS_TEXT = {
  notConfigured: "Anweisungen sind nicht eingerichtet",
  unknownAgent: "Unbekannter Agent",
  invalid: `Anweisung muss 1 bis ${INSTRUCTION_MAX_CHARS} Zeichen lang sein, ohne Steuerzeichen`,
  invalidRequest: "Ungültige Anfrage",
  notSaved: "Anweisungen konnten nicht gespeichert werden",
  changed: "Die Anweisungen wurden inzwischen geändert, zum Beispiel per /agent in Telegram. Nichts entfernt, bitte die Liste prüfen.",
  // Wie die Antwort auf /agent in Telegram: der System-Prompt geht nur beim Session-Start mit
  note: "Gilt ab der nächsten frischen Session des Agenten. In Telegram erzwingt /new im betroffenen Topic das sofort.",
} as const;

/**
 * Außen ohne Leerraum, 1 bis 1000 Zeichen, Zeilenumbrüche (CRLF wird LF) und
 * Tabs erlaubt, sonst keine Steuerzeichen; sonst null
 */
export function normalizeInstruction(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.replace(/\r\n?/g, "\n").trim();
  const length = [...clean].length;
  if (length < 1 || length > INSTRUCTION_MAX_CHARS) return null;
  if (/[^\P{Cc}\n\t]/u.test(clean)) return null;
  return clean;
}

export interface InstructionsApi {
  handle(agent: string, last: boolean, method: string, body: string): Promise<ApiResult>;
}

/**
 * Body von DELETE: leer (ohne Bedingung) oder { expected: "<digest>" } der
 * Liste, die der Browser angezeigt hat. undefined ohne Bedingung, null ungültig.
 */
function parseExpected(body: string): string | undefined | null {
  if (!body.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const expected = (parsed as Record<string, unknown>).expected;
  if (expected === undefined) return undefined;
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) return null;
  return expected;
}

export function createInstructionsApi(
  port: InstructionsPort,
  agentNames: { has(name: string): boolean },
  log: (message: string) => void,
  clock: RevisionClock = createRevisionClock()
): InstructionsApi {
  function errorName(e: unknown): string {
    return e instanceof Error ? e.name : typeof e;
  }

  /**
   * Liste mit Versionsnummer (revision.ts). Gelesen und gestempelt wird im
   * selben Schritt, nachdem die Schreibkette den Stand festgeschrieben hat;
   * so ordnet der Browser GET- und Schreibantworten und übernimmt keine
   * ältere Liste über eine neuere (Codex-Befund Runde 4 zu PR #43).
   */
  function current(agent: string): { instructions: string[]; digest: string; revision: ReturnType<RevisionClock["stamp"]> } {
    const instructions = port.list(agent);
    return { instructions, digest: instructionsDigest(instructions), revision: clock.stamp(agent, instructions) };
  }

  /** Schreiben mit einheitlicher Fehlerantwort; nie den Text der Anweisung ins Log */
  async function write(agent: string, what: string, fn: () => Promise<Record<string, unknown>>): Promise<ApiResult> {
    try {
      const body = await fn();
      log(`Anweisungen für ${agent}: ${what}`);
      return { status: what === "hinzugefügt" ? 201 : 200, body: { agent, ...body, ...current(agent), note: INSTRUCTIONS_TEXT.note } };
    } catch (e) {
      if (e instanceof InstructionsChanged) {
        // Die aktuelle Liste geht mit, damit der Browser sie zeigt
        return { status: 409, body: { agent, error: INSTRUCTIONS_TEXT.changed, ...current(agent) } };
      }
      log(`Anweisungen für ${agent} nicht gespeichert (${errorName(e)})`);
      return { status: 500, body: { error: INSTRUCTIONS_TEXT.notSaved } };
    }
  }

  return {
    async handle(agent, last, method, body) {
      if (!agentNames.has(agent)) return { status: 404, body: { error: INSTRUCTIONS_TEXT.unknownAgent } };
      if (method === "DELETE") {
        const expected = parseExpected(body);
        if (expected === null) return { status: 400, body: { error: INSTRUCTIONS_TEXT.invalidRequest } };
        const unchanged = expected === undefined ? undefined : (list: readonly string[]) => instructionsDigest(list) === expected;
        if (last) return write(agent, "letzte entfernt", async () => ({ removed: (await port.removeLast(agent, unchanged)) ?? null }));
        return write(agent, "alle entfernt", async () => ({ removed: await port.clear(agent, unchanged) }));
      }
      if (last) return { status: 405, body: { error: "Methode nicht erlaubt" } };
      if (method === "GET") return { status: 200, body: { agent, ...current(agent) } };
      if (method !== "POST") return { status: 405, body: { error: "Methode nicht erlaubt" } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return { status: 400, body: { error: INSTRUCTIONS_TEXT.invalidRequest } };
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { status: 400, body: { error: INSTRUCTIONS_TEXT.invalidRequest } };
      }
      const text = normalizeInstruction((parsed as Record<string, unknown>).text);
      if (text === null) return { status: 400, body: { error: INSTRUCTIONS_TEXT.invalid } };
      return write(agent, "hinzugefügt", async () => ({ count: await port.add(agent, text) }));
    },
  };
}
