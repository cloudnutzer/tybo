/**
 * Letzte Session des Bots (Issue #342, vorher Issues #189 und #122): ID und
 * Motor des zuletzt gemeldeten Turns in session-state.json. Nur für Anzeige
 * (Health-Antwort, Startzeile); Fortsetzen läuft über data/sessions.json
 * (session-manager) bzw. die Aufgabe der Rückfrage.
 *
 * Format der Datei bleibt: { "sessionId": string | null, "engine": string | null }.
 * Ältere Dateien ohne engine stammen von Claude.
 */
import { readFile } from "fs/promises";
import { atomicWriteFile } from "../lib/atomic-file";
import type { EngineId } from "../lib/engines/types";

export interface LastSession {
  sessionId: string | null;
  engine: EngineId | null;
}

export interface LastSessionDeps {
  path: string;
  read?: (path: string) => Promise<string>;
  write?: (path: string, content: string) => Promise<void>;
}

export interface LastSessionStore {
  current(): LastSession;
  /** liest die Datei; fehlt sie oder ist sie kaputt, bleibt der leere Stand */
  load(): Promise<void>;
  /** merkt sich ID und Motor und speichert sofort */
  remember(sessionId: string, engine: EngineId): Promise<void>;
  /** schreibt den Stand atomar; Fehler werden geschluckt, der Bot läuft weiter */
  save(): Promise<void>;
}

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

export function createLastSessionStore(deps: LastSessionDeps): LastSessionStore {
  const read = deps.read ?? (path => readFile(path, "utf-8"));
  const write = deps.write ?? atomicWriteFile;
  let state: LastSession = { sessionId: null, engine: null };

  const save = async () => {
    try {
      await write(deps.path, JSON.stringify(state, null, 2));
    } catch {
      // nur Anzeige, nichts hängt davon ab
    }
  };

  return {
    current: () => ({ ...state }),
    async load() {
      try {
        const parsed = JSON.parse(await read(deps.path)) as Record<string, unknown> | null;
        const sessionId = text(parsed?.sessionId);
        state = { sessionId, engine: (text(parsed?.engine) as EngineId | null) ?? (sessionId ? "claude" : null) };
      } catch {
        // keine oder unlesbare Datei: leerer Stand
      }
    },
    async remember(sessionId, engine) {
      state = { sessionId, engine };
      await save();
    },
    save,
  };
}
