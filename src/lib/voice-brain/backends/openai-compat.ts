/**
 * Weg "openai-compat" für den Telefonhörer (Issue #256): gestreamte
 * Chat-Completions für openrouter: und ollama:, an dieselben Adressen wie
 * callAux (src/lib/aux-model.ts). Den Verlauf hält tybo: System-Prompt plus
 * die letzten höchstens 12 Äußerungen.
 *
 * - OpenRouter: immer reasoning: { effort: "low" } (ohne den Zusatz denken
 *   die Modelle vor, gemessen 4,5 bis 7,2 s bis zum ersten Satz). Antwortet
 *   der Endpunkt darauf mit 400, wird einmal ohne den Zusatz wiederholt und
 *   das für dieses Gespräch gemerkt. Kopfzeilen OPENROUTER_APP_HEADERS.
 * - Ollama: reasoning_effort: "none".
 * - Vordenk-Text wird nie gesprochen: delta.reasoning und
 *   delta.reasoning_content werden verworfen, <think>…</think> im Text
 *   ausgefiltert, auch über mehrere Stücke verteilt; ein nie geschlossenes
 *   <think> verschluckt den Rest.
 * - Kontextlänge bei Ollama (beim ersten Turn, dann zwischengespeichert):
 *   maßgeblich ist, womit der Ollama-Server das Modell lädt, nicht tybos
 *   Umgebung (OLLAMA_CONTEXT_LENGTH gilt nur im Prozess von ollama serve).
 *   Steht num_ctx in den Parametern des Modells (/api/show), gilt das. Sonst
 *   lädt tybo das Modell ohne eigene Optionen (/api/generate ohne prompt,
 *   wie danach die Chat-Anfrage) und liest die Länge des geladenen Modells
 *   aus /api/ps (context_length). Begrenzt wird zusätzlich durch die
 *   Trainingslänge (model_info.*.context_length). Gebraucht werden die
 *   geschätzten Token aus System-Prompt, Verlauf und aktueller Frage
 *   (Zeichen / 3, aufgerundet, vorsichtig für Deutsch) plus die
 *   Antwortreserve (max_tokens). Reicht es nicht oder ist die Länge nicht
 *   feststellbar, endet der Turn mit BrainError "setup" und dem Grund; nichts
 *   wird still abgeschnitten.
 * - Ein Strom gilt nur mit protokollgemäßem Abschluss als vollständig:
 *   "data: [DONE]" oder ein Stück mit finish_reason. Endet er vorher, ist das
 *   ein Fehler ("network"); der zurückgehaltene Rest wird nicht gesprochen.
 * - Abbruch über AbortSignal beendet den Abruf.
 * - Budget: reserveRequest vor jedem Abruf (auch der Wiederholung nach 400),
 *   genau eine Abrechnung je Reservierung.
 */

import { OPENROUTER_APP_HEADERS } from "../../../brand";
import { BrainError, type BrainBackend, type BrainCall, type BrainMessage } from "../types";

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OLLAMA_CHAT_URL = "http://localhost:11434/v1/chat/completions";
export const OLLAMA_SHOW_URL = "http://localhost:11434/api/show";
export const OLLAMA_GENERATE_URL = "http://localhost:11434/api/generate";
export const OLLAMA_PS_URL = "http://localhost:11434/api/ps";
/** Höchstens so viele Äußerungen des Verlaufs gehen mit */
export const COMPAT_HISTORY = 12;
/** Antwortreserve (max_tokens) */
export const COMPAT_MAX_TOKENS = 1024;

export interface OpenAICompatOptions {
  kind: "openrouter" | "ollama";
  model: string;
  /** OPENROUTER_API_KEY (nur openrouter) */
  apiKey?: string;
  reserveRequest?: () => () => void;
}

/** Geschätzte Token eines Texts: Zeichen / 3, aufgerundet */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** num_ctx aus den Parametern des Modells (/api/show); null, wenn nicht gesetzt */
export function modelNumCtx(show: any): number | null {
  const m = show && typeof show.parameters === "string" ? /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(show.parameters) : null;
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** context_length des geladenen Modells laut /api/ps; null, wenn nicht geladen oder ohne Angabe (ältere Ollama-Versionen) */
export function loadedOllamaContext(ps: any, model: string): number | null {
  const models: any[] = Array.isArray(ps?.models) ? ps.models : [];
  const names = new Set([model, model.includes(":") ? model : `${model}:latest`]);
  const entry = models.find((m) => names.has(m?.name) || names.has(m?.model));
  const n = entry?.context_length;
  return typeof n === "number" && n > 0 ? n : null;
}

/**
 * Wirksame Kontextlänge: num_ctx des Modells, sonst die Länge, mit der der
 * Server es geladen hat (/api/ps), jeweils höchstens die Trainingslänge.
 * null, wenn keins von beiden bekannt ist.
 */
export function effectiveOllamaContext(show: any, loaded: number | null): { tokens: number; from: string } | null {
  if (!show || typeof show !== "object") return null;
  const candidates: { tokens: number; from: string }[] = [];
  const numCtx = modelNumCtx(show);
  if (numCtx) candidates.push({ tokens: numCtx, from: "num_ctx des Modells" });
  else if (loaded) candidates.push({ tokens: loaded, from: "vom Ollama-Server geladen" });
  else return null;
  const info = show.model_info && typeof show.model_info === "object" ? show.model_info : {};
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith(".context_length") && typeof value === "number" && value > 0) candidates.push({ tokens: value, from: "Trainingslänge des Modells" });
  }
  return candidates.reduce((a, b) => (b.tokens < a.tokens ? b : a));
}

/**
 * Filtert <think>…</think> aus einem Strom von Textstücken. Ein Tag darf
 * über Stückgrenzen gehen; ein offenes <think> verschluckt alles bis zum
 * schließenden Tag oder bis zum Ende.
 */
export class ThinkFilter {
  private buf = "";
  private inside = false;

  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    while (this.buf) {
      if (this.inside) {
        const end = this.buf.indexOf("</think>");
        if (end < 0) {
          // Möglichen Anfang von </think> behalten
          this.buf = this.buf.slice(Math.max(0, this.buf.length - 7));
          return out;
        }
        this.buf = this.buf.slice(end + 8);
        this.inside = false;
        continue;
      }
      const start = this.buf.indexOf("<think>");
      if (start >= 0) {
        out += this.buf.slice(0, start);
        this.buf = this.buf.slice(start + 7);
        this.inside = true;
        continue;
      }
      // Ein angefangenes "<think" am Ende zurückhalten
      const tail = partialTagTail(this.buf, "<think>");
      out += this.buf.slice(0, this.buf.length - tail);
      this.buf = this.buf.slice(this.buf.length - tail);
      return out;
    }
    return out;
  }

  /** Rest am Ende: außerhalb eines Tags der zurückgehaltene Text, innerhalb nichts */
  flush(): string {
    const rest = this.inside ? "" : this.buf;
    this.buf = "";
    return rest;
  }
}

function partialTagTail(text: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
    if (text.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

function abortError(): Error {
  const err = new Error("Abgebrochen");
  err.name = "AbortError";
  return err;
}

/** SSE-Zeilen "data: …" der Chat-Completions; ein Abbruch beendet auch ein wartendes read() */
async function* sseData(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  const dec = new TextDecoder();
  let buf = "";
  let finished = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (signal?.aborted) throw abortError();
      if (done) {
        finished = true;
        buf += dec.decode();
        break;
      }
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
    if (buf.startsWith("data:")) yield buf.slice(5).trim();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!finished) reader.cancel().catch(() => {});
  }
}

export function createOpenAICompatBackend(options: OpenAICompatOptions): BrainBackend {
  const url = options.kind === "openrouter" ? OPENROUTER_CHAT_URL : OLLAMA_CHAT_URL;
  /** OpenRouter: Endpunkt lehnt reasoning ab, für dieses Gespräch ohne */
  let withoutReasoning = false;
  let ollamaContext: { tokens: number; from: string } | null = null;
  let closed = false;
  /** Laufender Turn: close() beendet ihn über call.abort() (Signal des Turns, Abruf bricht ab) */
  let current: BrainCall | null = null;

  const reserve = () => {
    if (!options.reserveRequest) return undefined;
    try {
      return options.reserveRequest();
    } catch (err) {
      throw new BrainError("budget", err instanceof Error ? err.message : String(err));
    }
  };

  /** Modell ohne Optionen laden und context_length aus /api/ps lesen; null, wenn Ollama sie nicht nennt */
  async function loadOllamaModel(signal?: AbortSignal): Promise<number | null> {
    try {
      const load = await fetch(OLLAMA_GENERATE_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: options.model, stream: false }), signal });
      await load.text().catch(() => "");
      if (!load.ok) throw new BrainError("setup", `Ollama lädt ${options.model} nicht (${load.status})`);
      const ps = await fetch(OLLAMA_PS_URL, { signal });
      if (!ps.ok) return null;
      return loadedOllamaContext(await ps.json(), options.model);
    } catch (err) {
      if (err instanceof BrainError) throw err;
      if (signal?.aborted) throw abortError();
      throw new BrainError("setup", "Ollama antwortet nicht: Kontextlänge nicht feststellbar (läuft ollama serve?)");
    }
  }

  async function checkOllamaContext(messages: { content: string }[], signal?: AbortSignal) {
    if (!ollamaContext) {
      let show: unknown = null;
      try {
        const res = await fetch(OLLAMA_SHOW_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: options.model }), signal });
        if (res.ok) show = await res.json();
        else if (res.status === 404) throw new BrainError("setup", `Ollama kennt das Modell ${options.model} nicht (ollama pull ${options.model})`);
      } catch (err) {
        if (err instanceof BrainError) throw err;
        if (signal?.aborted) throw abortError();
        throw new BrainError("setup", "Ollama antwortet nicht: Kontextlänge nicht feststellbar (läuft ollama serve?)");
      }
      if (!show || typeof show !== "object") throw new BrainError("setup", "Kontextlänge des Ollama-Modells nicht feststellbar (/api/show nicht lesbar)");
      // Ohne num_ctx entscheidet der Server (seine eigene Umgebung): Modell so laden wie die Chat-Anfrage, dann nachsehen
      const loaded = modelNumCtx(show) ? null : await loadOllamaModel(signal);
      ollamaContext = effectiveOllamaContext(show, loaded);
      if (!ollamaContext) {
        throw new BrainError(
          "setup",
          `Kontextlänge von ${options.model} nicht feststellbar: Ollama meldet sie für das geladene Modell nicht. num_ctx im Modell setzen (Modelfile: PARAMETER num_ctx 16384) oder Ollama aktualisieren.`,
        );
      }
    }
    const need = messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0) + COMPAT_MAX_TOKENS;
    if (need > ollamaContext.tokens) {
      throw new BrainError(
        "setup",
        `Kontext zu klein: ${options.model} hat ${ollamaContext.tokens} Token (${ollamaContext.from}), das Gespräch braucht rund ${need}. Größere Kontextlänge einstellen (OLLAMA_CONTEXT_LENGTH beim Start von ollama serve oder num_ctx im Modell).`,
      );
    }
  }

  function body(messages: { role: string; content: string }[]) {
    const out: Record<string, unknown> = { model: options.model, messages, stream: true, max_tokens: COMPAT_MAX_TOKENS };
    if (options.kind === "openrouter" && !withoutReasoning) out.reasoning = { effort: "low" };
    if (options.kind === "ollama") out.reasoning_effort = "none";
    return out;
  }

  async function* stream(call: BrainCall): AsyncGenerator<{ text: string }> {
    if (closed) throw new BrainError("ended", "Gespräch beendet");
    if (call.signal?.aborted) throw abortError();
    current = call;
    try {
      yield* streamTurn(call);
    } finally {
      if (current === call) current = null;
    }
  }

  async function* streamTurn(call: BrainCall): AsyncGenerator<{ text: string }> {
    if (options.kind === "openrouter" && !options.apiKey) throw new BrainError("setup", "OPENROUTER_API_KEY fehlt");
    const history: BrainMessage[] = call.messages.slice(-(COMPAT_HISTORY + 1));
    const messages = [{ role: "system", content: call.system }, ...history.map((m) => ({ role: m.role, content: m.content }))];
    if (options.kind === "ollama") await checkOllamaContext(messages, call.signal);

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.kind === "openrouter") {
      headers.authorization = `Bearer ${options.apiKey}`;
      Object.assign(headers, OPENROUTER_APP_HEADERS);
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const settle = reserve();
      try {
        let res: Response;
        try {
          res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body(messages)), signal: call.signal });
        } catch (err) {
          if (call.signal?.aborted) throw abortError();
          throw new BrainError("network", err instanceof Error ? err.message : String(err));
        }
        if (res.status === 400 && options.kind === "openrouter" && !withoutReasoning) {
          await res.text().catch(() => "");
          withoutReasoning = true;
          continue;
        }
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => "");
          throw new BrainError("api", `${options.kind === "openrouter" ? "OpenRouter" : "Ollama"} ${res.status}: ${text.slice(0, 300)}`);
        }
        const filter = new ThinkFilter();
        let complete = false;
        for await (const data of sseData(res.body, call.signal)) {
          if (data === "[DONE]") {
            complete = true;
            break;
          }
          let ev: any;
          try {
            ev = JSON.parse(data);
          } catch {
            continue;
          }
          if (ev?.error) throw new BrainError("api", String(ev.error.message ?? JSON.stringify(ev.error)).slice(0, 300));
          if (ev?.choices?.[0]?.finish_reason) complete = true;
          // delta.reasoning (OpenRouter) und reasoning_content werden nie gesprochen
          const content = ev?.choices?.[0]?.delta?.content;
          if (typeof content !== "string" || !content) continue;
          const text = filter.push(content);
          if (text) yield { text };
        }
        // Ende ohne Abschluss: abgerissen, der zurückgehaltene Rest wird nicht gesprochen
        if (!complete) throw new BrainError("network", `${options.kind === "openrouter" ? "OpenRouter" : "Ollama"}: Antwort brach vorzeitig ab`);
        const rest = filter.flush();
        if (rest) yield { text: rest };
        return;
      } catch (err) {
        if (call.signal?.aborted && !(err instanceof BrainError)) throw abortError();
        throw err;
      } finally {
        settle?.();
      }
    }
    throw new BrainError("api", "OpenRouter lehnt die Anfrage ab (400)");
  }

  return {
    id: options.kind,
    label: `${options.kind === "openrouter" ? "OpenRouter" : "Ollama"} (${options.model})`,
    stream,
    close() {
      closed = true;
      current?.abort?.(new BrainError("ended", "Gespräch beendet"));
    },
  };
}
