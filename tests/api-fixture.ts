/**
 * Attrappe der Anthropic Messages API für den Motor "api" (Issue #347):
 * ersetzt Abruf und Schlüssel über setApiRuntimeForTests. Antworten kommen
 * als SSE-Text, absichtlich in kleine Stücke zerteilt (auch mitten in einem
 * UTF-8-Zeichen). Hängende Abrufe enden erst über das AbortSignal, wie beim
 * echten fetch; jeder Abbruch wird gezählt. Mehrere Antworten stehen in
 * einer Schlange, je Abruf eine (Werkzeugschleife, Issue #348).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setApiRuntimeForTests, type ApiRuntime } from "../src/lib/engines/api";
import { fileApiSessionStore } from "../src/lib/engines/api-sessions";
import type { ApiToolHost } from "../src/lib/engines/api-tools";

/** Werkzeuge ohne mcpManager: nichts angeboten, jeder Aufruf ein Fehler */
export const noTools: ApiToolHost = {
  offered: () => [],
  call: async (name) => ({ content: `kein Werkzeug ${name}`, isError: true }),
  serverOf: () => undefined,
};

export const sse = (e: Record<string, unknown>) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

/** Vollständige Antwort mit einem Textblock je Eintrag, optional mit usage in message_start und message_delta */
export function textReply(first: string, more: string[] = [], usage: { start?: object; end?: object } = {}): string {
  const blocks = [first, ...more];
  let out = sse({ type: "message_start", message: { id: "msg_1", ...(usage.start ? { usage: usage.start } : {}) } });
  blocks.forEach((text, index) => {
    out += sse({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
    // Text in zwei Deltas, damit das Zusammensetzen geprüft ist
    const half = Math.floor(text.length / 2);
    out += sse({ type: "content_block_delta", index, delta: { type: "text_delta", text: text.slice(0, half) } });
    out += sse({ type: "content_block_delta", index, delta: { type: "text_delta", text: text.slice(half) } });
    out += sse({ type: "content_block_stop", index });
  });
  out += sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, ...(usage.end ? { usage: usage.end } : {}) });
  out += sse({ type: "message_stop" });
  return out;
}

/** Bytes in Stücken zu 7 Byte: trennt Zeilen, Ereignisse und Umlaute */
function chunks(text: string): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += 7) out.push(bytes.slice(i, i + 7));
  return out;
}

type Plan =
  | { kind: "body"; text: string; delayMs?: number; gate?: Promise<void> }
  | { kind: "status"; status: number; text: string }
  | { kind: "error"; error: Error }
  | { kind: "hangConnect" }
  | { kind: "hangAfter"; text: string };

export interface ApiFake {
  respond(text: string): void;
  respondSlow(text: string, delayMs: number): void;
  /** Die Antwort kommt erst, wenn die zurückgegebene Funktion aufgerufen ist (Reihenfolge in Tests festlegen) */
  respondGated(text: string): () => void;
  respondStatus(status: number, text: string): void;
  respondError(error: Error): void;
  /** Der Abruf antwortet nie (bis zum Abbruch) */
  hangConnect(): void;
  /** Die Antwort beginnt mit text und hängt dann beim Lesen */
  hangAfter(text: string): void;
  setKey(key: string | undefined): void;
  /** Ordner der Sitzungen dieser Attrappe */
  sessionDir: string;
  /** Teile der Laufzeit ersetzen (Werkzeuge, Sitzungen, Planung); Abruf und Schlüssel bleiben die der Attrappe */
  use(partial: Partial<ApiRuntime>): void;
  calls(): number;
  aborts(): number;
  connecting(): boolean;
  reading(): boolean;
  lastUrl(): string | undefined;
  lastHeaders(): Record<string, string>;
  lastBody(): any;
  /** Rümpfe aller Abrufe in Reihenfolge */
  bodies(): any[];
  /** Noch nicht abgerufene Antworten */
  pending(): number;
  restore(): void;
}

/** Antwort mit Werkzeugaufrufen (stop_reason tool_use), optional mit Text davor und usage */
export function toolReply(uses: { id: string; name: string; input?: object }[], opts: { text?: string; usage?: { start?: object; end?: object } } = {}): string {
  let out = sse({ type: "message_start", message: { id: "msg_t", ...(opts.usage?.start ? { usage: opts.usage.start } : {}) } });
  let index = 0;
  if (opts.text) {
    out += sse({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
    out += sse({ type: "content_block_delta", index, delta: { type: "text_delta", text: opts.text } });
    out += sse({ type: "content_block_stop", index });
    index++;
  }
  for (const use of uses) {
    const json = JSON.stringify(use.input ?? {});
    out += sse({ type: "content_block_start", index, content_block: { type: "tool_use", id: use.id, name: use.name, input: {} } });
    // Eingabe in zwei Bruchstücken, wie die API sie schickt
    out += sse({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(0, 3) } });
    out += sse({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(3) } });
    out += sse({ type: "content_block_stop", index });
    index++;
  }
  out += sse({ type: "message_delta", delta: { stop_reason: "tool_use" }, ...(opts.usage?.end ? { usage: opts.usage.end } : {}) });
  out += sse({ type: "message_stop" });
  return out;
}

export function installApiFake(extra: Partial<ApiRuntime> = {}): ApiFake {
  // Antworten der Reihe nach, je Abruf eine (Werkzeugschleife: mehrere Runden)
  const plans: Plan[] = [];
  const bodies: any[] = [];
  let key: string | undefined = "sk-test-attrappe";
  let calls = 0;
  let aborts = 0;
  let connecting = false;
  let reading = false;
  let last: { url: string; init: RequestInit } | undefined;

  const fetchFake = async (url: string, init: RequestInit): Promise<Response> => {
    calls++;
    last = { url, init };
    bodies.push(JSON.parse(String(init.body)));
    const p = plans.shift();
    if (!p) throw new Error("unerwarteter Abruf");
    const signal = init.signal ?? undefined;
    const onAbort = (fn: () => void) => signal?.addEventListener("abort", () => (aborts++, fn()), { once: true });
    if (p.kind === "error") throw p.error;
    if (p.kind === "status") return new Response(p.text, { status: p.status });
    if (p.kind === "hangConnect") {
      connecting = true;
      return new Promise<Response>((_, reject) => onAbort(() => reject(new DOMException("aborted", "AbortError"))));
    }
    const parts = chunks(p.text);
    const hang = p.kind === "hangAfter";
    const delayMs = p.kind === "body" ? p.delayMs ?? 0 : 0;
    const gate = p.kind === "body" ? p.gate : undefined;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        onAbort(() => {
          try {
            controller.error(new DOMException("aborted", "AbortError"));
          } catch {
            // schon geschlossen
          }
        });
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (gate) await gate;
        for (const part of parts) controller.enqueue(part);
        if (hang) reading = true;
        else controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  // Sitzungen in einem eigenen Ordner, nie in data/ des Arbeitsordners
  const sessionDir = mkdtempSync(join(tmpdir(), "tybo-api-sessions-"));
  const own: Partial<ApiRuntime> = { fetch: fetchFake, apiKey: () => key, tools: noTools, sessions: fileApiSessionStore(() => sessionDir) };
  let current: Partial<ApiRuntime> = { ...own, ...extra };
  setApiRuntimeForTests(current);

  return {
    respond: (text) => void plans.push({ kind: "body", text }),
    respondSlow: (text, delayMs) => void plans.push({ kind: "body", text, delayMs }),
    respondGated: (text) => {
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      plans.push({ kind: "body", text, gate });
      return open;
    },
    respondStatus: (status, text) => void plans.push({ kind: "status", status, text }),
    respondError: (error) => void plans.push({ kind: "error", error }),
    hangConnect: () => void plans.push({ kind: "hangConnect" }),
    hangAfter: (text) => void plans.push({ kind: "hangAfter", text }),
    setKey: (k) => void (key = k),
    sessionDir,
    use: (partial) => {
      current = { ...current, ...partial, fetch: fetchFake, apiKey: () => key };
      setApiRuntimeForTests(current);
    },
    calls: () => calls,
    aborts: () => aborts,
    connecting: () => connecting,
    reading: () => reading,
    lastUrl: () => last?.url,
    lastHeaders: () => (last?.init.headers ?? {}) as Record<string, string>,
    lastBody: () => (last ? JSON.parse(String(last.init.body)) : undefined),
    bodies: () => bodies,
    pending: () => plans.length,
    restore: () => {
      setApiRuntimeForTests(null);
      rmSync(sessionDir, { recursive: true, force: true });
    },
  };
}

/**
 * Wartet, bis die Bedingung gilt. Die Grenze ist nur ein Notausgang gegen Hängen, kein Teil
 * der Prüfung: großzügig, damit eine ausgelastete Maschine (Gesamtlauf) nicht scheitert.
 */
export async function until(cond: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("Bedingung nicht erreicht");
    await new Promise((r) => setTimeout(r, 1));
  }
}
