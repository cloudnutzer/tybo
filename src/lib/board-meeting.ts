/**
 * Board-Sitzung (Issue #75): alle Board-Agenten nacheinander, dann die
 * Zusammenfassung von General. Früher fest in src/bot.ts und nur Telegram;
 * jetzt ein Kern mit Ausgabe-Schnittstelle, den Telegram, Browser und
 * Terminal gleich nutzen. Teilnehmer (Katalog), Datenbeschaffung,
 * Modellaufrufe, Speichern und Ausgabe kommen herein, damit Tests ohne
 * src/bot.ts auskommen. Prompts und Reihenfolge wie bisher.
 *
 * Gespeichert wird jeder fertige Beitrag einzeln, sobald er feststeht (Agent,
 * Dauer, Topic, msgId), die Zusammenfassung ebenso; kein Sammeltext mehr.
 *
 * Stopp (Knopf, /stop, Strg+C im Terminal): der laufende Beitrag wird fertig,
 * gespeichert und ausgegeben, danach startet kein Agent und keine
 * Zusammenfassung mehr. Ein zweites /stop bricht hart ab (abortClaudeCalls);
 * der Modellaufruf meldet das als aborted, dann endet die Sitzung sofort.
 */

import { agentLabel } from "../web/agents";

/** Was die Datenbeschaffung liefert (src/lib/board-data.ts gatherBoardData) */
export interface BoardDataLike {
  agentData: Record<string, string>;
  sharedSummary: string;
  fetchDurationMs: number;
  errors: string[];
}

export interface BoardCallResult {
  text: string;
  /** Abgebrochen (/stop zweimal, Beenden des Bots): kein Beitrag */
  aborted?: boolean;
  model?: string;
  /** Dauer des Turns; fehlt sie, misst der Kern selbst */
  durationMs?: number;
}

export interface BoardContribution {
  /** "agent": Beitrag eines Board-Agenten, "synthesis": Zusammenfassung von General */
  kind: "agent" | "synthesis";
  agent: string;
  text: string;
  durationMs: number;
  model?: string;
  /** metadata.msgId im Nachrichtenspeicher; Live-Anzeige nutzt dieselbe ID */
  msgId: string;
}

export interface BoardEnd {
  /** Anzahl ausgegebener Agenten-Beiträge (ohne Zusammenfassung) */
  contributions: number;
  synthesis: boolean;
  stopped: boolean;
  aborted: boolean;
  /** Keine Board-Agenten eingeschaltet */
  empty: boolean;
}

/** Wohin die Sitzung spricht: Telegram über die Agenten-Bots, Browser und Terminal live */
export interface BoardOutput {
  /** Ankündigung (Telegram: „Board Meeting Starting" von General) */
  start(announcement: string): Promise<void>;
  /** Fortschritt: dieser Agent arbeitet jetzt am Beitrag */
  thinking(agent: string): Promise<void>;
  /** Fertiger, schon gespeicherter Beitrag */
  contribution(c: BoardContribution): Promise<void>;
  /** Agent ohne Beitrag (Fehler oder leere Antwort) */
  failed?(agent: string): Promise<void>;
  /** Ende; nur bei Stopp, leerem Board oder ohne Beiträge steht etwas im Text */
  end(result: BoardEnd, message: string | null): Promise<void>;
}

export interface BoardDeps {
  /** Teilnehmer in Reihenfolge (src/agents/catalog.ts boardAgentNames) */
  agents(): string[];
  gatherData(): Promise<BoardDataLike>;
  /** Modellaufruf für einen Agenten im Gespräch; wirft bei Fehlern */
  callAgent(prompt: string, agent: string): Promise<BoardCallResult>;
  /** [INVOKE:]-Tags aus Beiträgen entfernen (src/lib/cross-agent.ts) */
  stripInvocationTags(text: string): string;
  /** Beitrag im Nachrichtenspeicher; false oder Fehler nur ins Log */
  save(message: { role: "assistant"; content: string; metadata: Record<string, unknown> }): Promise<boolean | void>;
  newMessageId(): string;
  /** Pause nach jedem Beitrag, Standard 1000 ms wie bisher */
  pauseMs?: number;
  now?(): number;
  /** Nie Nachrichtentexte übergeben */
  log?(message: string): void;
}

export interface BoardInput {
  /** Thema nach /board, leer ohne Thema */
  extraContext?: string;
  /** Registrierung für Stopp-Anfragen (registerBoard) */
  sessionKey: string;
  /** Gespräch, in dem die Sitzung läuft (metadata.topicId, null bei Direktchat und General) */
  topicId?: number;
  /** Weitere Metadaten jedes Beitrags, z. B. channel "web" */
  metadata?: Record<string, unknown>;
}

export const BOARD_TEXT = {
  empty: "Kein Agent ist bei /board eingeschaltet. In den Einstellungen unter Agenten „Bei /board dabei“ anschalten.",
  noContributions: "Kein Agent hat einen Beitrag geliefert, deshalb keine Zusammenfassung.",
  stopRequested: "⏹️ Board-Sitzung endet nach dem laufenden Beitrag.",
  starting: "Board-Sitzung beginnt, Daten werden gesammelt …",
  stopped: (n: number) => `⏹️ Board-Sitzung gestoppt nach ${n} Beitr${n === 1 ? "ag" : "ägen"}, ohne Zusammenfassung.`,
  thinking: (agent: string) => `${agentLabel(agent)} denkt nach …`,
  failed: (agent: string) => `${agentLabel(agent)} hat keinen Beitrag geliefert.`,
} as const;

// ---------------------------------------------------------------------------
// Stopp-Anfragen je Session-Schlüssel
// ---------------------------------------------------------------------------

interface BoardHandle {
  stopRequested: boolean;
  /** Laufende Sitzungen unter dem Schlüssel (Telegram und Browser gleichzeitig) */
  sessions: number;
}

const running = new Map<string, BoardHandle>();

/**
 * Stopp für die laufende Sitzung unter dem Schlüssel: "requested" beim ersten
 * Mal (die Sitzung endet nach dem laufenden Beitrag), "again" wenn schon
 * angefragt (dann darf der Aufrufer hart abbrechen), "none" ohne Sitzung.
 */
export function requestBoardStop(sessionKey: string): "requested" | "again" | "none" {
  const handle = running.get(sessionKey);
  if (!handle) return "none";
  if (handle.stopRequested) return "again";
  handle.stopRequested = true;
  return "requested";
}

export function isBoardRunning(sessionKey: string): boolean {
  return running.has(sessionKey);
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

/** Läuft eine Sitzung; wirft nie wegen eines Abbruchs, sondern meldet ihn im Ergebnis */
export async function runBoardMeeting(deps: BoardDeps, input: BoardInput, output: BoardOutput): Promise<BoardEnd> {
  const log = deps.log ?? ((m: string) => console.log(`[BoardMeeting] ${m}`));
  const now = deps.now ?? Date.now;
  const pauseMs = deps.pauseMs ?? 1000;
  // Mitgelieferte (ohne geloeschte und ausgeschaltete) plus eigene mit Board-Schalter
  const boardAgents = deps.agents();
  const result: BoardEnd = { contributions: 0, synthesis: false, stopped: false, aborted: false, empty: boardAgents.length === 0 };
  if (result.empty) {
    await output.end(result, BOARD_TEXT.empty);
    return result;
  }

  // Eine zweite Sitzung unter demselben Schlüssel teilt den Stopp; die
  // Registrierung bleibt, bis die letzte davon endet
  const handle: BoardHandle = running.get(input.sessionKey) ?? { stopRequested: false, sessions: 0 };
  running.set(input.sessionKey, handle);
  handle.sessions++;
  try {
    return await run();
  } finally {
    handle.sessions--;
    if (handle.sessions === 0 && running.get(input.sessionKey) === handle) running.delete(input.sessionKey);
  }

  async function save(c: Omit<BoardContribution, "msgId">): Promise<BoardContribution> {
    const msgId = deps.newMessageId();
    const contribution = { ...c, msgId };
    const metadata: Record<string, unknown> = {
      ...input.metadata,
      type: "board_meeting",
      board: c.kind,
      agent: c.agent,
      durationMs: c.durationMs,
      ...(c.model ? { model: c.model } : {}),
      topicId: input.topicId ?? null,
      msgId,
    };
    try {
      if ((await deps.save({ role: "assistant", content: c.text, metadata })) === false) log(`Beitrag von ${c.agent} nicht gespeichert`);
    } catch (e) {
      log(`Beitrag von ${c.agent} nicht gespeichert (${errorName(e)})`);
    }
    return contribution;
  }

  async function call(prompt: string, agent: string): Promise<{ text: string; durationMs: number; model?: string } | "aborted" | null> {
    const started = now();
    let response: BoardCallResult;
    try {
      response = await deps.callAgent(prompt, agent);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "aborted";
      log(`${agent} failed (${errorName(e)})`);
      return null;
    }
    if (response.aborted) return "aborted";
    return {
      text: response.text,
      durationMs: typeof response.durationMs === "number" ? response.durationMs : now() - started,
      ...(response.model ? { model: response.model } : {}),
    };
  }

  async function run(): Promise<BoardEnd> {
    const contextNote = input.extraContext ? `\n\nAdditional context: ${input.extraContext}` : "";

    // Orchestrator announces
    await output.start(`*Board Meeting Starting*\n\nGathering perspectives from all agents...${contextNote}`);

    // Gather live data
    const boardData = await deps.gatherData();
    log(`Data gathered in ${boardData.fetchDurationMs}ms (errors: ${boardData.errors.join(", ") || "none"})`);

    const agentResponses: { agent: string; response: string }[] = [];

    // Each agent contributes sequentially
    for (const agent of boardAgents) {
      if (handle.stopRequested) break;
      await output.thinking(agent);
      // Stopp kann während der Fortschrittsausgabe (Telegram) eingehen
      if (handle.stopRequested) break;

      // Build board prompt for this agent
      const previousInput = agentResponses
        .map((r) => `**${r.agent}**: ${r.response.substring(0, 300)}`)
        .join("\n\n");

      const dataBlock = boardData.agentData[agent] || "";
      const boardPrompt = `You are participating in a board meeting. Review recent activity and provide your specialized perspective.${contextNote}

${dataBlock}

${previousInput ? `## PREVIOUS AGENT INPUTS\n${previousInput}` : ""}

Reference specific numbers and data from your LIVE DATA section above. Provide a concise analysis from your domain. Focus on what matters most from your perspective. Keep it to 2-4 key points.`;

      const answer = await call(boardPrompt, agent);
      if (answer === "aborted") {
        result.aborted = true;
        await output.end(result, null);
        return result;
      }
      const cleanResponse = answer ? deps.stripInvocationTags(answer.text) : "";
      if (!answer || !cleanResponse.trim()) {
        agentResponses.push({ agent, response: "(unavailable)" });
        await output.failed?.(agent);
        continue;
      }
      agentResponses.push({ agent, response: cleanResponse });
      const saved = await save({ kind: "agent", agent, text: cleanResponse, durationMs: answer.durationMs, ...(answer.model ? { model: answer.model } : {}) });
      await output.contribution(saved);
      result.contributions++;

      // Brief pause for readability
      if (pauseMs > 0 && !handle.stopRequested) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }

    const stopped = async (): Promise<BoardEnd> => {
      result.stopped = true;
      await output.end(result, BOARD_TEXT.stopped(result.contributions));
      return result;
    };
    if (handle.stopRequested) return stopped();
    if (result.contributions === 0) {
      await output.end(result, BOARD_TEXT.noContributions);
      return result;
    }

    // Orchestrator synthesizes
    await output.thinking("general");
    // Noch nicht begonnen: ein Stopp während der Fortschrittsausgabe verhindert sie
    if (handle.stopRequested) return stopped();

    const synthesisPrompt = `Board meeting synthesis requested. Here are all agent contributions:

${agentResponses.map((r) => `**${r.agent.toUpperCase()}**:\n${r.response}`).join("\n\n---\n\n")}

${boardData.sharedSummary ? `## CURRENT METRICS SNAPSHOT\n${boardData.sharedSummary}\n` : ""}
Synthesize the key themes, identify conflicts or alignments between agents, and propose 3-5 concrete action items with clear ownership. Ground your action items in the specific numbers above.`;

    const synthesis = await call(synthesisPrompt, "general");
    if (synthesis === "aborted") {
      result.aborted = true;
      await output.end(result, null);
      return result;
    }
    if (!synthesis || !synthesis.text.trim()) {
      await output.failed?.("general");
      await output.end(result, null);
      return result;
    }
    // Ein Stopp während der Zusammenfassung: sie ist der laufende Beitrag und wird fertig
    const saved = await save({ kind: "synthesis", agent: "general", text: synthesis.text, durationMs: synthesis.durationMs, ...(synthesis.model ? { model: synthesis.model } : {}) });
    await output.contribution(saved);
    result.synthesis = true;
    await output.end(result, null);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Telegram-Ausgabe
// ---------------------------------------------------------------------------

export interface TelegramBoardSender {
  /** Agenten-Bot (Rückfall Haupt-Bot), Markdown als HTML (BotRegistry.sendAsAgent) */
  sendAsAgent(agent: string, chatId: string, text: string, threadId?: number): Promise<unknown>;
  sendTypingAsAgent(agent: string, chatId: string, threadId?: number): Promise<unknown>;
  /** Hinweise zum Ablauf (Stopp, leeres Board) vom Haupt-Bot */
  notice(text: string): Promise<unknown>;
}

/**
 * Telegram wie bisher: Ankündigung und Zusammenfassung von General, jeder
 * Beitrag vom Bot seines Agenten, Tippt-Anzeige des Agenten, der gerade
 * arbeitet. Ein Agent ohne Beitrag bleibt stumm wie früher.
 */
export function createTelegramBoardOutput(sender: TelegramBoardSender, chatId: string, topicId?: number): BoardOutput {
  return {
    start: async text => void (await sender.sendAsAgent("general", chatId, text, topicId)),
    thinking: async agent => void (await sender.sendTypingAsAgent(agent, chatId, topicId)),
    contribution: async c => void (await sender.sendAsAgent(c.agent, chatId, c.text, topicId)),
    end: async (_result, message) => {
      if (message) await sender.notice(message);
    },
  };
}
