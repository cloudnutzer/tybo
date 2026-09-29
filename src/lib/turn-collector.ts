import type { TurnInfo, TurnSessionMeta } from "./chat-turn";
import type { TurnTools } from "./turn-tools";

/**
 * Sammelt, was ein Turn über sich meldet: Modell, Motor (Issue #125) und Dauer für die Metadaten
 * der gespeicherten Antwort (die WebUI zeigt sie unter der Antwort, Issue #22),
 * die Werkzeuge für das Merk-Tag-Tor (Issue #53) und die Session-ID genau
 * dieses Turns samt Motor und Modell für eine Rückfrage mit Knöpfen (Issues
 * #189, #122). Früher nahm die
 * Rückfrage die zuletzt gemeldete Session irgendeines Topics.
 */
export function turnInfoCollector() {
  let info: TurnInfo | undefined;
  // Ohne Meldung unbekannt
  let tools: TurnTools | undefined;
  let sessionId: string | undefined;
  let sessionMeta: TurnSessionMeta | undefined;
  return {
    onInfo: (i: TurnInfo) => {
      info = i;
    },
    onTools: (t: TurnTools | undefined) => {
      tools = t;
    },
    onSessionId: (id: string, meta?: TurnSessionMeta) => {
      sessionId = id;
      if (meta) sessionMeta = meta;
    },
    /** Motor und Modell des Turns, auch wenn der Motor keine Session-ID lieferte (Issue #122) */
    onSessionMeta: (meta: TurnSessionMeta) => {
      sessionMeta = meta;
    },
    tools: () => tools,
    /** Letzte Session-ID des Turns (nach einem Resume-Neustart die neue) */
    sessionId: () => sessionId,
    /** Motor und Modell des Turns; fehlt nur bei Abbruch */
    sessionMeta: () => sessionMeta,
    /** Metadaten eines Rückfrage-Tasks: Agent, Motor und Modell der Session des Turns */
    taskMetadata: (agentName: string): Record<string, unknown> => ({ agent_name: agentName, ...(sessionMeta ?? {}) }),
    // Ohne Meldung (Abbruch) bleiben die Metadaten wie bisher
    metadata: (): Record<string, unknown> =>
      info
        ? { ...(info.model ? { model: info.model } : {}), ...(info.engine ? { engine: info.engine } : {}), durationMs: info.durationMs }
        : {},
  };
}
