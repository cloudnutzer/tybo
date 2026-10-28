/**
 * Anthropic Messages API (SSE) für Sprachgespräche. Aus der Sprach-Brücke
 * herausgelöst (Issue #255), seit Issue #347 auf dem gemeinsamen SSE-Teil
 * (src/lib/anthropic-stream.ts, auch für den Motor "api"):
 * - streamAnthropic ordnet die Blöcke für die Werkzeug-Schleife der Brücke
 *   (Thinking mit Signatur, lokale Werkzeuge, deep_think, externe Werkzeuge)
 *   und rechnet das Tagesbudget genau einmal ab
 * - createAnthropicBackend ist der Weg "anthropic" für den Telefonhörer: nur
 *   Text, ohne tools und ohne thinking, System-Prompt mit Prompt-Caching
 */

import {
  abortError,
  AnthropicHttpError,
  AnthropicStreamError,
  postMessages,
  readMessageStream,
  toolInput,
  usageCost,
  type AContent,
  type AnthropicToolDef,
  type AnthropicTurn,
  type Usage,
} from "../../anthropic-stream";
import type { Effort } from "../plan";
import { BrainError, type BrainBackend, type BrainCall } from "../types";

export { ANTHROPIC_URL, usageCost, type AContent, type AnthropicToolDef, type AnthropicTurn, type Usage } from "../../anthropic-stream";

/** Werkzeug, das die Brücke selbst als tiefes Nachdenken ausführt */
const DEEP_THINK = "deep_think";

export interface AnthropicCall {
  model: string;
  system: string;
  messages: AnthropicTurn[];
  effort: Effort;
  max_tokens: number;
  /** Ohne Angabe fehlt das Feld im Rumpf ganz */
  tools?: AnthropicToolDef[];
  /** System-Prompt als Block mit cache_control (Prompt-Caching); die Brücke ruft ohne */
  cacheSystem?: boolean;
  signal?: AbortSignal;
}

export interface Sinks {
  onText(t: string): void;
  /** Nur externe Werkzeuge (weder lokal noch deep_think), i zählt sie ab 0 */
  onToolStart(i: number, id: string, name: string): void;
  onToolArgs(i: number, json: string): void;
}

export interface StreamResult {
  finish: "stop" | "tool_calls";
  /** Assistant-Bloecke fuer die Fortsetzung (Thinking mit Signatur, Text, tool_use). */
  content: AContent[];
  localCalls: { id: string; name: string; input: Record<string, unknown> }[];
  deepCalls: { id: string; question: string }[];
  text: string;
  /** message_stop kam an; false heißt, der Strom riss vorher ab (die Brücke wertet das nicht aus) */
  complete: boolean;
}

/** Rumpf der Anfrage; tools nur, wenn angegeben, thinking nie */
export function anthropicBody(call: AnthropicCall): Record<string, unknown> {
  return {
    model: call.model,
    max_tokens: call.max_tokens,
    system: call.cacheSystem ? [{ type: "text", text: call.system, cache_control: { type: "ephemeral" } }] : call.system,
    messages: call.messages,
    ...(call.tools ? { tools: call.tools } : {}),
    output_config: { effort: call.effort },
    stream: true,
  };
}

/**
 * Ein Abruf der Messages API. reserveRequest reserviert im Tagesbudget, bevor
 * etwas gesendet wird (wirft, wenn es erschöpft ist), und rechnet genau einmal
 * ab, gleich wie der Abruf endet: mit den echten Kosten aus usage, 0 bei
 * abgelehnter Anfrage, sonst mit der Reservierung.
 */
export async function streamAnthropic(
  apiKey: string,
  call: AnthropicCall,
  localNames: Set<string>,
  sinks: Sinks,
  reserveRequest?: () => (actualUsd?: number) => void,
): Promise<StreamResult> {
  if (call.signal?.aborted) throw abortError();
  const settle = reserveRequest?.();
  let usage: Usage | null = null;
  let rejected = false;
  try {
    let body: ReadableStream<Uint8Array>;
    try {
      body = await postMessages(apiKey, anthropicBody(call), call.signal);
    } catch (err) {
      if (!(err instanceof AnthropicHttpError)) throw err;
      rejected = true;
      throw new BrainError("api", err.message);
    }

    // Blocknummer im Strom zu laufender Nummer der externen Werkzeuge
    const external = new Map<number, number>();
    const isExternal = (name: string) => name !== DEEP_THINK && !localNames.has(name);
    let stream: Awaited<ReturnType<typeof readMessageStream>>;
    try {
      stream = await readMessageStream(
        body,
        {
          onText: (text) => sinks.onText(text),
          onToolStart: (index, id, name) => {
            if (!isExternal(name)) return;
            external.set(index, external.size);
            sinks.onToolStart(external.get(index)!, id, name);
          },
          onToolArgs: (index, json) => {
            const n = external.get(index);
            if (n !== undefined) sinks.onToolArgs(n, json);
          },
          onUsage: (u) => void (usage = u),
        },
        call.signal,
      );
    } catch (err) {
      if (err instanceof AnthropicStreamError) throw new BrainError("api", err.detail);
      throw err;
    }

    const content: AContent[] = [];
    const localCalls: StreamResult["localCalls"] = [];
    const deepCalls: StreamResult["deepCalls"] = [];
    let text = "";
    for (const block of stream.blocks) {
      if (block.type === "thinking") {
        // Ohne Signatur nimmt die API den Block in der Fortsetzung nicht an
        if (block.signature) content.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
      } else if (block.type === "redacted_thinking") {
        content.push({ type: "redacted_thinking", data: block.data });
      } else if (block.type === "text") {
        if (block.text) content.push({ type: "text", text: block.text });
        text += block.text;
      } else if (block.type === "tool_use") {
        const input = toolInput(block.args);
        content.push({ type: "tool_use", id: block.id, name: block.name, input });
        if (block.name === DEEP_THINK) deepCalls.push({ id: block.id, question: String(input.question ?? "") });
        else if (localNames.has(block.name)) localCalls.push({ id: block.id, name: block.name, input });
      }
    }
    return { finish: external.size > 0 ? "tool_calls" : "stop", content, localCalls, deepCalls, text, complete: stream.complete };
  } finally {
    settle?.(rejected ? 0 : usage ? usageCost(call.model, usage) : undefined);
  }
}

export interface AnthropicBackendOptions {
  /** VOICE_ANTHROPIC_API_KEY */
  apiKey: string;
  /** z. B. claude-sonnet-5-5 (ohne Präfix "claude:") */
  model: string;
  effort: Effort;
  /** Standard 4000 (wie die Brücke bei low und medium) */
  maxTokens?: number;
  /** Tagesbudget "voice" wie in der Brücke: reservieren, Rückgabe rechnet ab */
  reserveRequest?: () => (actualUsd?: number) => void;
}

/** Fehler eines Abrufs als BrainError; ein Abbruch bleibt ein Abbruch */
function toBrainError(err: unknown): unknown {
  if (err instanceof BrainError) return err;
  if (err instanceof Error && err.name === "AbortError") return err;
  return new BrainError("network", err instanceof Error ? err.message : String(err));
}

/** Weg "anthropic" für den Telefonhörer: Messages API ohne tools und ohne thinking, mit Prompt-Caching */
export function createAnthropicBackend(options: AnthropicBackendOptions): BrainBackend {
  const reserve = options.reserveRequest
    ? () => {
        try {
          return options.reserveRequest!();
        } catch (err) {
          throw new BrainError("budget", err instanceof Error ? err.message : String(err));
        }
      }
    : undefined;

  let closed = false;
  /** Laufender Turn: close() beendet ihn über call.abort() (Signal des Turns, Abruf bricht ab) */
  let current: BrainCall | null = null;

  return {
    id: "anthropic",
    label: `Anthropic Messages API (${options.model})`,
    close() {
      closed = true;
      current?.abort?.(new BrainError("ended", "Gespräch beendet"));
    },
    async *stream(call: BrainCall) {
      if (closed) throw new BrainError("ended", "Gespräch beendet");
      current = call;
      // Eigener Abbruch: verknüpft mit dem Signal des Aufrufers und ausgelöst, wenn der Verbraucher vorzeitig aufhört
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      if (call.signal?.aborted) abort.abort();
      else call.signal?.addEventListener("abort", onAbort, { once: true });

      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const notify = () => {
        const w = wake;
        wake = null;
        w?.();
      };
      let finished = false;
      let failure: unknown = null;
      const running = streamAnthropic(
        options.apiKey,
        {
          model: options.model,
          system: call.system,
          messages: call.messages,
          effort: options.effort,
          max_tokens: options.maxTokens ?? 4000,
          cacheSystem: true,
          signal: abort.signal,
        },
        new Set(),
        { onText: (t) => (queue.push(t), notify()), onToolStart: () => {}, onToolArgs: () => {} },
        reserve,
      ).then(
        (result) => {
          // Ende ohne message_stop: abgerissen, zählt als Ausfall; der angefangene Satz wird nicht gesprochen
          if (!result.complete) failure = new BrainError("network", "Anthropic: Antwort brach vorzeitig ab");
          finished = true;
          notify();
        },
        (err) => {
          failure = toBrainError(err);
          finished = true;
          notify();
        },
      );

      try {
        while (true) {
          if (queue.length) {
            yield { text: queue.shift()! };
            continue;
          }
          if (finished) break;
          await new Promise<void>((resolve) => (wake = resolve));
        }
        if (failure) throw failure;
      } finally {
        if (current === call) current = null;
        call.signal?.removeEventListener("abort", onAbort);
        if (!finished) abort.abort();
        // Erst zurück, wenn der Abruf beendet und das Budget abgerechnet ist
        await running;
      }
    },
  };
}
