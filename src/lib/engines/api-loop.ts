/**
 * Bausteine der Werkzeugschleife des Motors "api" (Issue #348): Verbrauch
 * und Kosten über alle Runden, Verlauf im Format der Messages API und die
 * Ausführung der Werkzeuge einer Runde.
 *
 * Eine Runde: alle tool_use-Blöcke nacheinander in ihrer Reihenfolge, jeder
 * bekommt genau ein tool_result mit derselben ID. Fehler, unbekanntes oder
 * nicht erlaubtes Werkzeug und abgelehnte Freigabe ergeben ein Ergebnis mit
 * is_error, die Schleife läuft weiter. ask_user läuft zuletzt: die übrigen
 * Werkzeuge der Runde laufen vorher, dann endet der Lauf mit einer Pause.
 * Höchstens eine Pause je Runde; jedes weitere ask_user bekommt einen Fehler.
 */

import type { AContent, AnthropicTurn, MessageStream, StreamBlock, Usage } from "../anthropic-stream";
import { toolInput, usageCost } from "../anthropic-stream";
import type { ToolUse } from "../turn-tools";
import type { ApiToolResult } from "./api-sessions";
import { ASK_USER, OWN_TOOL_NAMES, checkAskUser, type ApiToolHost, type ToolOutcome, type ToolOffer } from "./api-tools";
import { toolLabel } from "./tool-labels";
import type { EngineUsage } from "./types";

// ---------------------------------------------------------------------------
// Verbrauch und Kosten
// ---------------------------------------------------------------------------

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** Verbrauch und Kosten aller Runden eines Laufs */
export class RunAccount {
  private usage: EngineUsage = {};
  private cost = 0;
  private rounds = 0;
  /** Kosten bleiben nur bekannt, wenn jede Runde einen bekannten Preis hatte */
  private priced = true;

  constructor(private readonly model: string) {}

  /** Eine gelesene Runde; complete nur mit message_stop. Ohne Verbrauch oder Preis: Kosten unbekannt */
  addRound(u: Usage | null, complete: boolean): void {
    this.rounds++;
    if (u) this.addUsage(u);
    const roundCost = u && complete ? usageCost(this.model, u) : undefined;
    if (roundCost === undefined) this.priced = false;
    else this.cost += roundCost;
  }

  /** Abgelehnte Anfrage (HTTP-Fehler): nichts verbraucht, kostet 0 */
  addRejected(): void {
    this.rounds++;
  }

  private addUsage(u: Usage): void {
    const plain = count(u.input_tokens);
    const written = count(u.cache_creation_input_tokens);
    const read = count(u.cache_read_input_tokens);
    const output = count(u.output_tokens);
    if (plain !== undefined || written !== undefined || read !== undefined) {
      this.usage.inputTokens = (this.usage.inputTokens ?? 0) + (plain ?? 0) + (written ?? 0) + (read ?? 0);
    }
    if (read !== undefined) this.usage.cachedInputTokens = (this.usage.cachedInputTokens ?? 0) + read;
    if (output !== undefined) this.usage.outputTokens = (this.usage.outputTokens ?? 0) + output;
  }

  /** usage und costUsd für das Ergebnis */
  fields(): { usage?: EngineUsage; costUsd?: number } {
    return {
      ...(Object.keys(this.usage).length > 0 ? { usage: { ...this.usage } } : {}),
      ...(this.rounds > 0 && this.priced ? { costUsd: this.cost } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Verlauf
// ---------------------------------------------------------------------------

/** Antwortblöcke als Inhalt einer Assistenten-Nachricht; leere Textblöcke fallen weg */
export function assistantContent(blocks: StreamBlock[]): AContent[] {
  const out: AContent[] = [];
  for (const b of blocks) {
    if (b.type === "text" && b.text) out.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") out.push({ type: "tool_use", id: b.id, name: b.name, input: toolInput(b.args) });
    else if (b.type === "thinking") out.push({ type: "thinking", thinking: b.thinking, signature: b.signature });
    else if (b.type === "redacted_thinking") out.push({ type: "redacted_thinking", data: b.data });
  }
  return out;
}

/**
 * Hängt eine Nutzernachricht an. Endet der Verlauf schon mit einer
 * Nutzernachricht (Rundengrenze, leere Antwort), kommt der Inhalt dort dazu:
 * die API erwartet abwechselnde Rollen.
 */
export function appendUser(messages: AnthropicTurn[], content: string | AContent[]): AnthropicTurn[] {
  const last = messages.at(-1);
  if (last?.role !== "user") return [...messages, { role: "user", content }];
  const asBlocks = (c: string | AContent[]): AContent[] => (typeof c === "string" ? [{ type: "text", text: c }] : c);
  return [...messages.slice(0, -1), { role: "user", content: [...asBlocks(last.content), ...asBlocks(content)] }];
}

// ---------------------------------------------------------------------------
// Werkzeuge einer Runde
// ---------------------------------------------------------------------------

export interface RoundToolsDeps {
  host: ApiToolHost;
  offer: ToolOffer;
  /** Planungswerkzeug ausführen */
  schedule(name: string, input: Record<string, unknown>): Promise<ToolOutcome>;
  /** Läuft fn so, dass Zeitlimit und /stop eine wartende Freigabe beenden */
  guard<T>(fn: () => Promise<T>): Promise<T>;
  /** Lauf beendet (Abbruch, Zeitlimit): kein weiteres Werkzeug */
  stopped(): boolean;
  /** Wird erfüllt, sobald der Lauf beendet ist */
  whenStopped: Promise<void>;
  /** Nur streaming: Anzeigename des Werkzeugs */
  onToolStart?(label: string): void;
}

export interface RoundOutcome {
  results: ApiToolResult[];
  /** Ausgeführte Werkzeuge für classifyTurnTools */
  uses: ToolUse[];
  /** Erste gültige Rückfrage der Runde */
  pause?: { toolUseId: string; question: string; options: string[]; tag: string };
  /** Lauf während der Runde beendet */
  stopped: boolean;
}

const result = (id: string, outcome: ToolOutcome): ApiToolResult => ({
  type: "tool_result",
  tool_use_id: id,
  content: outcome.content || (outcome.isError ? "Fehler ohne Meldung" : "(leer)"),
  ...(outcome.isError ? { is_error: true } : {}),
});

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Führt die Werkzeuge einer Runde aus (siehe Kopf) */
export async function runRoundTools(blocks: Extract<AContent, { type: "tool_use" }>[], d: RoundToolsDeps): Promise<RoundOutcome> {
  const results = new Map<string, ApiToolResult>();
  const uses: ToolUse[] = [];
  let pause: RoundOutcome["pause"];
  let askAt: string | undefined;

  for (const block of blocks) {
    if (d.stopped()) return { results: [], uses, stopped: true };
    if (block.name === ASK_USER) {
      if (!d.offer.ask) {
        // Nicht angeboten (Denkauftrag, Konsultation): keine Pause, die niemand beantworten könnte
        results.set(block.id, result(block.id, { content: "In diesem Auftrag sind keine Rückfragen möglich; antworte ohne Rückfrage.", isError: true }));
        continue;
      }
      if (pause) {
        results.set(block.id, result(block.id, { content: "Nur eine Rückfrage je Antwort; diese wurde nicht gestellt.", isError: true }));
        continue;
      }
      const check = checkAskUser(block.input);
      if (!check.ok) {
        results.set(block.id, result(block.id, { content: check.error, isError: true }));
        continue;
      }
      pause = { toolUseId: block.id, question: check.question, options: check.options, tag: check.tag };
      askAt = block.id;
      uses.push({ name: ASK_USER });
      d.onToolStart?.(toolLabel("AskUserQuestion"));
      continue;
    }

    const own = OWN_TOOL_NAMES.includes(block.name);
    if (!d.offer.callable.has(block.name)) {
      results.set(block.id, result(block.id, { content: `Unbekanntes oder nicht erlaubtes Werkzeug: ${block.name}`, isError: true }));
      continue;
    }
    const server = own ? undefined : d.host.serverOf(block.name);
    const shownName = server ? `mcp__${server}__${block.name}` : block.name;
    d.onToolStart?.(toolLabel(shownName));
    // Eigene Werkzeuge ohne external, alles aus mcpManager mit: fremde Inhalte für das Merk-Tag-Tor
    uses.push(own ? { name: block.name } : { name: shownName, external: true });
    let outcome: ToolOutcome;
    try {
      const running = d.guard(() => (own ? d.schedule(block.name, block.input) : d.host.call(block.name, block.input)));
      const winner = await Promise.race([running.then((o) => ({ o })), d.whenStopped.then(() => null)]);
      if (!winner || d.stopped()) {
        running.catch(() => {});
        return { results: [], uses, stopped: true };
      }
      outcome = winner.o;
    } catch (e) {
      if (d.stopped()) return { results: [], uses, stopped: true };
      outcome = { content: `Werkzeug ${block.name} fehlgeschlagen: ${reason(e)}`, isError: true };
    }
    results.set(block.id, result(block.id, outcome));
  }

  // In der Reihenfolge der Blöcke; die offene Rückfrage fehlt, ihr Ergebnis kommt mit der Antwort
  const ordered = blocks.filter((b) => b.id !== askAt).map((b) => results.get(b.id)!).filter(Boolean);
  return { results: ordered, uses, ...(pause ? { pause } : {}), stopped: false };
}

/** Ergebnisse für Werkzeuge, die wegen der Rundengrenze nicht mehr liefen */
export function skippedResults(blocks: Extract<AContent, { type: "tool_use" }>[]): ApiToolResult[] {
  return blocks.map((b) => result(b.id, { content: "Nicht ausgeführt: Grenze der Werkzeugrunden erreicht.", isError: true }));
}

export type { MessageStream };
