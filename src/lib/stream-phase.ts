/**
 * Wo hängt ein Claude-Aufruf? (Befund 30.9.2026)
 *
 * callClaudeStreaming liest stream-json mit --include-partial-messages. Aus
 * den Ereignissen der obersten Ebene (parent_tool_use_id leer) merkt sich
 * dieser Tracker die Phase des Laufs, damit ein Zeitlimit sagen kann, ob die
 * API keine Bytes schickte, das Modell mitten in einer Nachricht stehen blieb
 * oder ein Werkzeug lief. Ereignisse von Unter-Agenten zählen nur als
 * Aktivität (das macht der Aufrufer), die Phase bleibt „Werkzeug Agent".
 *
 * Ohne stream_event-Zeilen (ältere CLI) fehlt nur die Phase „generating";
 * Start, API-Wartezeit und Werkzeuge erkennt der Tracker trotzdem.
 */

export type StallPhase =
  /** CLI gestartet, noch kein init-Ereignis (Hooks, MCP-Server) */
  | { kind: "startup"; sinceMs: number }
  /** Anfrage an die API läuft, noch kein Byte der Antwort; afterTool: nach einem Werkzeugergebnis */
  | { kind: "api"; sinceMs: number; afterTool: boolean }
  /** Antwort läuft (message_start gesehen), aber kein Delta mehr */
  | { kind: "generating"; sinceMs: number; lastDeltaAgoMs: number; block?: "thinking" | "text" | "tool_use" }
  /** Werkzeug(e) laufen: das älteste offene; count: wie viele offen sind */
  | { kind: "tool"; sinceMs: number; name: string; count: number }
  /** Letzte Nachricht fertig ohne Werkzeug, aber kein result (etwa ein Stop-Hook) */
  | { kind: "finishing"; sinceMs: number };

type BlockKind = "thinking" | "text" | "tool_use";

export class StreamPhaseTracker {
  private state: "startup" | "api" | "generating" | "finishing" = "startup";
  private stateAt: number;
  private afterTool = false;
  private lastDeltaAt = 0;
  private block: BlockKind | undefined;
  /** Offene Werkzeugaufrufe in Startreihenfolge: id → Name, Start */
  private readonly pending = new Map<string, { name: string; at: number }>();
  private anon = 0;

  constructor(startedAt: number) {
    this.stateAt = startedAt;
  }

  /** Ein gültiges stream-json-Ereignis zum Zeitpunkt now */
  observe(event: any, now: number): void {
    if (!event || typeof event !== "object" || event.parent_tool_use_id) return;

    switch (event.type) {
      case "system":
        if (event.subtype === "init" && this.state === "startup") this.set("api", now, false);
        return;
      case "stream_event":
        this.observeStreamEvent(event.event, now);
        return;
      case "assistant": {
        // Ohne stream_event (ältere CLI) ist die Anfrage mit der ersten
        // vollständigen Nachricht beantwortet
        if (this.state === "startup" || this.state === "api") this.set("finishing", now, false);
        const content = event.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block?.type !== "tool_use") continue;
          // Ohne id (kommt von der CLI nicht vor) bleibt der Aufruf offen
          const id = typeof block.id === "string" && block.id ? block.id : `ohne-id-${++this.anon}`;
          if (!this.pending.has(id)) {
            this.pending.set(id, { name: typeof block.name === "string" && block.name ? block.name : "?", at: now });
          }
        }
        return;
      }
      case "user": {
        const content = event.message?.content;
        if (!Array.isArray(content)) return;
        let resolved = false;
        for (const block of content) {
          if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
            resolved = this.pending.delete(block.tool_use_id) || resolved;
          }
        }
        // Alle Ergebnisse da: die CLI schickt die nächste Anfrage
        if (resolved && this.pending.size === 0) this.set("api", now, true);
        return;
      }
    }
  }

  private observeStreamEvent(se: any, now: number): void {
    switch (se?.type) {
      case "message_start":
        this.set("generating", now, false);
        this.lastDeltaAt = now;
        this.block = undefined;
        return;
      case "content_block_start": {
        const t = se.content_block?.type;
        this.block = t === "thinking" || t === "redacted_thinking" ? "thinking" : t === "text" ? "text" : t === "tool_use" ? "tool_use" : undefined;
        this.lastDeltaAt = now;
        return;
      }
      case "content_block_delta":
      case "content_block_stop":
      case "message_delta":
        this.lastDeltaAt = now;
        return;
      case "message_stop":
        // Mit offenen Werkzeugen zeigt snapshot() die Werkzeug-Phase
        this.set("finishing", now, false);
        this.block = undefined;
        return;
    }
  }

  private set(state: StreamPhaseTracker["state"], now: number, afterTool: boolean): void {
    this.state = state;
    this.stateAt = now;
    this.afterTool = afterTool;
  }

  /** Phase zum Zeitpunkt now, etwa beim Zeitlimit */
  snapshot(now: number): StallPhase {
    if (this.state === "generating") {
      return {
        kind: "generating",
        sinceMs: now - this.stateAt,
        lastDeltaAgoMs: now - this.lastDeltaAt,
        ...(this.block ? { block: this.block } : {}),
      };
    }
    const oldest = this.pending.values().next().value as { name: string; at: number } | undefined;
    if (oldest) return { kind: "tool", sinceMs: now - oldest.at, name: oldest.name, count: this.pending.size };
    if (this.state === "api") return { kind: "api", sinceMs: now - this.stateAt, afterTool: this.afterTool };
    if (this.state === "finishing") return { kind: "finishing", sinceMs: now - this.stateAt };
    return { kind: "startup", sinceMs: now - this.stateAt };
  }
}

const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

/** Kurzform für die Log-Zeile „timeout (idle)" */
export function stallPhaseLogText(p: StallPhase): string {
  switch (p.kind) {
    case "startup":
      return `CLI-Start seit ${secs(p.sinceMs)} (kein init)`;
    case "api":
      return `wartet auf API seit ${secs(p.sinceMs)} (keine Bytes seit ${p.afterTool ? "Werkzeugergebnis" : "Request/init"})`;
    case "generating":
      return `Modell generiert (letztes Delta vor ${secs(p.lastDeltaAgoMs)}${p.block ? `, Block ${p.block}` : ""}, message_start vor ${secs(p.sinceMs)})`;
    case "tool":
      return `Werkzeug ${p.name} läuft seit ${secs(p.sinceMs)}${p.count > 1 ? ` (${p.count} offen)` : ""}`;
    case "finishing":
      return `Nachricht fertig seit ${secs(p.sinceMs)}, kein result (Hook?)`;
  }
}

/** Dauer für Nutzer: Sekunden bis 90 s, sonst ganze Minuten */
function durationText(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return s === 1 ? "1 Sekunde" : `${s} Sekunden`;
  const min = Math.round(ms / 60_000);
  return `${min} Minuten`;
}

const BLOCK_TEXT: Record<BlockKind, string> = {
  thinking: "beim Nachdenken",
  text: "beim Schreiben",
  tool_use: "beim Formulieren eines Werkzeugaufrufs",
};

/** Ein Satz für die Zeitlimit-Meldung: wo der Lauf hing */
export function stallPhaseUserText(p: StallPhase): string {
  switch (p.kind) {
    case "startup":
      return `Hing beim Start von Claude Code (seit ${durationText(p.sinceMs)} nicht bereit).`;
    case "api":
      return `Hing beim Warten auf die Anthropic-API: seit ${durationText(p.sinceMs)} kam keine Antwort${p.afterTool ? " (nach dem letzten Werkzeug)" : ""}.`;
    case "generating":
      return `Hing mitten in einer Antwort des Modells${p.block ? ` ${BLOCK_TEXT[p.block]}` : ""}: das letzte Stück kam vor ${durationText(p.lastDeltaAgoMs)}.`;
    case "tool":
      return `Hing im Werkzeug ${p.name}: läuft seit ${durationText(p.sinceMs)}.`;
    case "finishing":
      return `Die Antwort war fertig, Claude Code hat danach ${durationText(p.sinceMs)} lang nicht abgeschlossen (vermutlich ein Hook).`;
  }
}
