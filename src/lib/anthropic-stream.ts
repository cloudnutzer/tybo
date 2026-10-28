/**
 * Anthropic Messages API als Strom (SSE), gemeinsam für den Motor "api"
 * (src/lib/engines/api.ts, Issue #347) und die Sprachgespräche
 * (src/lib/voice-brain/backends/anthropic.ts, Sprach-Brücke).
 *
 * Hier steht nur, was beide brauchen: Anfrage senden, den Strom in Blöcke
 * zerlegen (Text, Werkzeug, Thinking mit Signatur), Verbrauch mitlesen und
 * daraus Kosten rechnen. Was ein Block bedeutet (lokales Werkzeug, deep_think,
 * Budget), entscheidet der Aufrufer.
 *
 * Abbruch: ein AbortSignal beendet den Abruf und auch ein wartendes Lesen;
 * danach wirft das Lesen einen Fehler mit name "AbortError".
 */

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: unknown;
}

export type AContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

export interface AnthropicTurn {
  role: "user" | "assistant";
  content: string | AContent[];
}

/** Verbrauch wie in message_start und message_delta gemeldet */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Abgelehnte Anfrage (HTTP-Status außer 2xx); body ist gekürzt */
export class AnthropicHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Anthropic ${status}: ${body}`);
    this.name = "AnthropicHttpError";
  }
}

/** Fehler-Ereignis im Strom (etwa overloaded_error), nachdem die Anfrage angenommen war */
export class AnthropicStreamError extends Error {
  constructor(
    readonly errorType: string,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "AnthropicStreamError";
  }
}

export function abortError(): Error {
  const err = new Error("Abgebrochen");
  err.name = "AbortError";
  return err;
}

/** Höchstens so viel vom Fehlertext einer Antwort wird behalten */
const ERROR_BODY_CHARS = 2000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Sendet den Rumpf an die Messages API. Wirft AnthropicHttpError bei einem
 * Status außer 2xx oder ohne Rumpf, einen AbortError bei Abbruch.
 */
export async function postMessages(
  apiKey: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): Promise<ReadableStream<Uint8Array>> {
  if (signal?.aborted) throw abortError();
  const res = await fetchImpl(ANTHROPIC_URL, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
    signal,
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new AnthropicHttpError(res.status, text.slice(0, ERROR_BODY_CHARS));
  }
  return res.body;
}

/** Ein SSE-Ereignis aus Rohtext (Zeilen event: und data:), sonst null */
function parseSseEvent(raw: string): { event: string; data: string } | null {
  let event = "";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

/**
 * SSE-Ereignisse eines Rumpfs. Bytes dürfen beliebig zerteilt ankommen, auch
 * mitten in einem UTF-8-Zeichen oder einer Zeile; CRLF zählt wie LF. Ein
 * Abbruch über signal beendet auch ein wartendes read().
 */
export async function* sseEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let pending = "";
  let drained = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (signal?.aborted) throw abortError();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // Ein CR am Ende des Stücks zurückhalten: folgt im nächsten das LF, ist es ein Zeilenende, keine zwei
      const carry = !done && pending.endsWith("\r") ? "\r" : "";
      if (carry) pending = pending.slice(0, -1);
      pending = pending.replace(/\r\n?/g, "\n");
      let cut: number;
      while ((cut = pending.indexOf("\n\n")) >= 0) {
        const parsed = parseSseEvent(pending.slice(0, cut));
        pending = pending.slice(cut + 2);
        if (parsed) yield parsed;
      }
      if (done) {
        drained = true;
        // Letztes Ereignis ohne abschließende Leerzeile
        const rest = parseSseEvent(pending);
        if (rest) yield rest;
        return;
      }
      pending += carry;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    // Vorzeitig beendet (Abbruch, Fehler, Verbraucher weg): Verbindung schließen
    if (!drained) cancel();
  }
}

/** Ein Inhaltsblock der Antwort, wie er im Strom zusammengesetzt wurde */
export type StreamBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; args: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "other" };

export interface StreamSinks {
  /** Textstück eines Textblocks */
  onText?(text: string, index: number): void;
  /** Ein Werkzeugblock beginnt */
  onToolStart?(index: number, id: string, name: string): void;
  /** Teil der Werkzeug-Eingabe (JSON-Bruchstück) */
  onToolArgs?(index: number, json: string): void;
  /** Ein Block ist fertig */
  onBlockEnd?(block: StreamBlock, index: number): void;
  /** Irgendein Ereignis kam an (Lebenszeichen) */
  onEvent?(): void;
  /** Verbrauch wurde gemeldet oder ergänzt; usage ist der Stand bisher */
  onUsage?(usage: Usage): void;
}

export interface MessageStream {
  /** Blöcke in der Reihenfolge des Stroms */
  blocks: StreamBlock[];
  usage: Usage | null;
  stopReason?: string;
  /** message_stop kam an; false heißt, der Strom riss vorher ab */
  complete: boolean;
}

function field(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Liest den Strom einer Messages-API-Antwort zu Ende. Wirft
 * AnthropicStreamError bei einem Fehler-Ereignis, einen AbortError bei
 * Abbruch, SyntaxError bei kaputtem JSON.
 */
export async function readMessageStream(body: ReadableStream<Uint8Array>, sinks: StreamSinks = {}, signal?: AbortSignal): Promise<MessageStream> {
  const byIndex = new Map<number, StreamBlock>();
  const order: number[] = [];
  let usage: Usage | null = null;
  let stopReason: string | undefined;
  let complete = false;

  const mergeUsage = (part: unknown) => {
    if (!part || typeof part !== "object") return;
    usage = { ...(usage ?? {}), ...(part as Usage) };
    sinks.onUsage?.(usage);
  };

  for await (const ev of sseEvents(body, signal)) {
    sinks.onEvent?.();
    const msg = JSON.parse(ev.data);
    switch (msg?.type) {
      case "message_start":
        mergeUsage(msg.message?.usage);
        break;
      case "content_block_start": {
        const raw = msg.content_block ?? {};
        const index = Number(msg.index);
        let block: StreamBlock;
        if (raw.type === "text") block = { type: "text", text: field(raw.text) };
        else if (raw.type === "tool_use") block = { type: "tool_use", id: field(raw.id), name: field(raw.name), args: "" };
        else if (raw.type === "thinking") block = { type: "thinking", thinking: field(raw.thinking), signature: field(raw.signature) };
        else if (raw.type === "redacted_thinking") block = { type: "redacted_thinking", data: field(raw.data) };
        else block = { type: "other" };
        if (!byIndex.has(index)) order.push(index);
        byIndex.set(index, block);
        if (block.type === "tool_use") sinks.onToolStart?.(index, block.id, block.name);
        if (block.type === "text" && block.text) sinks.onText?.(block.text, index);
        break;
      }
      case "content_block_delta": {
        const index = Number(msg.index);
        const block = byIndex.get(index);
        const delta = msg.delta ?? {};
        if (!block) break;
        if (delta.type === "text_delta" && block.type === "text") {
          block.text += field(delta.text);
          sinks.onText?.(field(delta.text), index);
        } else if (delta.type === "input_json_delta" && block.type === "tool_use") {
          block.args += field(delta.partial_json);
          sinks.onToolArgs?.(index, field(delta.partial_json));
        } else if (delta.type === "thinking_delta" && block.type === "thinking") {
          block.thinking += field(delta.thinking);
        } else if (delta.type === "signature_delta" && block.type === "thinking") {
          block.signature += field(delta.signature);
        }
        break;
      }
      case "content_block_stop": {
        const index = Number(msg.index);
        const block = byIndex.get(index);
        if (block) sinks.onBlockEnd?.(block, index);
        break;
      }
      case "message_delta":
        if (typeof msg.delta?.stop_reason === "string") stopReason = msg.delta.stop_reason;
        mergeUsage(msg.usage);
        break;
      case "message_stop":
        complete = true;
        break;
      case "error":
        throw new AnthropicStreamError(field(msg.error?.type) || "error", JSON.stringify(msg.error ?? {}));
    }
  }
  return { blocks: order.map((i) => byIndex.get(i)!), usage, ...(stopReason ? { stopReason } : {}), complete };
}

/** Eingabe eines Werkzeugblocks als Objekt; kaputtes oder fehlendes JSON heißt {} */
export function toolInput(args: string): Record<string, unknown> {
  try {
    const value = JSON.parse(args || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Text aller Textblöcke, aneinandergehängt */
export function streamText(blocks: StreamBlock[]): string {
  return blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
}

/** USD pro Million Tokens: Eingabe, Ausgabe, Cache-Lesen, Cache-Schreiben */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-opus-5-5": [4, 20, 0.4, 5],
};

/** Kosten eines Abrufs in USD; undefined bei unbekanntem Modell */
export function usageCost(model: string, u: Usage): number | undefined {
  const p = PRICES[model];
  if (!p) return undefined;
  const n = (v?: number) => (Number.isFinite(v) ? v! : 0);
  return (n(u.input_tokens) * p[0] + n(u.output_tokens) * p[1] + n(u.cache_read_input_tokens) * p[2] + n(u.cache_creation_input_tokens) * p[3]) / 1_000_000;
}
