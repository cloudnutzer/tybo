/**
 * Voice-Bridge: OpenAI-Chat-Completions-Fassade vor der Anthropic Messages API,
 * mit Anschluessen an tybo (Kontext, lokale Tools, Historie, Denkauftrag).
 *
 * ElevenLabs (Custom LLM) -> POST /v1/chat/completions (SSE)
 *   -> claude-opus-5 mit output_config.effort (pro Turn gewaehlt)
 *   -> OpenAI-Chunks zurueck an ElevenLabs
 *
 * Der Kern ist laufzeitneutral und ohne Abhaengigkeiten; alles tybo-Spezifische
 * kommt ueber BridgeHooks aus src/voice-bridge.ts (damit die Tests ohne
 * Supabase und ohne laufenden Bot auskommen).
 */

import { BRAND } from "../../brand";
import { voiceAgentName } from "../voice-agent-name";
import type { ToolUse, TurnTools } from "../turn-tools";

export interface BridgeEnv {
  VOICE_ANTHROPIC_API_KEY: string;
  /** ElevenLabs schickt ihn als "Authorization: Bearer <token>". */
  VOICE_BRIDGE_TOKEN: string;
  /** Default claude-opus-5 */
  VOICE_MODEL?: string;
  /** Default medium */
  VOICE_DEFAULT_EFFORT?: string;
  /** Name des Sprachagenten, leer heißt BRAND.name (Issue #138) */
  VOICE_AGENT_NAME?: string;
}

export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: unknown;
}

export interface BridgeHooks {
  reserveRequest?: () => () => void;
  /** tybo-Kontext (Agent-Prompt, Profil, Memory, letzte Nachrichten). Caching macht der Hook. */
  loadContext?: () => Promise<string>;
  /** Lokale Tools, die die Bridge selbst ausfuehrt (z.B. history_search). */
  localTools?: () => AnthropicToolDef[];
  runLocalTool?: (name: string, input: Record<string, unknown>) => Promise<string>;
  /**
   * Turn in die Historie schreiben (assistantText ist roh, inkl. evtl. Tags).
   * tools: Werkzeuge des Turns fuer das Merk-Tag-Tor (Issue #53); Werkzeuge,
   * die ElevenLabs ausfuehrt (auch aus frueheren Anfragen seit der letzten
   * Nutzer-Nachricht), sind als external markiert.
   */
  persistTurn?: (userText: string, assistantText: string, tools: TurnTools) => Promise<void>;
  /** Denkauftrag an tybo uebergeben. */
  deepThink?: (question: string, lastUserText: string) => Promise<void>;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const MAX_TOOL_ROUNDS = 2;

type OAContentPart = { type: string; text?: string };
export interface OAMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string | OAContentPart[] | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}
export interface OATool {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
}
export interface OARequest {
  model?: string;
  messages: OAMessage[];
  stream?: boolean;
  tools?: OATool[];
  elevenlabs_extra_body?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. Effort-Router: entscheidet pro Nutzer-Aeusserung, wie viel Opus denkt
// ---------------------------------------------------------------------------

const HIGH_TRIGGERS = [
  /denk\w*\s+(mal\s+|bitte\s+|da\s+)?(gr[üu]ndlich|genau|in ruhe|richtig|scharf)/i,
  /nimm dir (ruhig\s+)?zeit/i,
  /[üu]berleg\w*\s+(mal\s+|bitte\s+|dir\s+das\s+)?(genau|gr[üu]ndlich|in ruhe)/i,
  /think (hard|carefully|deeply|it through)/i,
  /take your time/i,
];

const DEEP_TRIGGERS = [
  /denkauftrag/i,
  /rechne\s+(mir\s+)?(das|es)\s+(mal\s+)?(komplett\s+|in ruhe\s+)?durch/i,
  /(analysier|pr[üu]f|arbeite)\w*\s+(mir\s+)?(das\s+)?(mal\s+)?(ausf[üu]hrlich|komplett|gr[üu]ndlich)\s+(aus|durch)?/i,
];

export interface TurnPlan {
  effort: Effort;
  /** true: nicht live antworten, sondern den Denkauftrag an tybo geben */
  deep: boolean;
}

export function classifyTurn(lastUserText: string, fallback: Effort, override?: unknown): TurnPlan {
  if (typeof override === "string" && EFFORTS.includes(override as Effort)) {
    return { effort: override as Effort, deep: false };
  }
  if (DEEP_TRIGGERS.some((r) => r.test(lastUserText))) return { effort: "xhigh", deep: true };
  if (HIGH_TRIGGERS.some((r) => r.test(lastUserText))) return { effort: "high", deep: false };
  return { effort: fallback, deep: false };
}

// ---------------------------------------------------------------------------
// 2. OpenAI-Verlauf -> Anthropic-Verlauf
// ---------------------------------------------------------------------------

export function partText(c: OAMessage["content"]): string {
  if (!c) return "";
  if (typeof c === "string") return c;
  return c.map((p) => p.text ?? "").join("");
}

export type AContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

export interface AnthropicTurn {
  role: "user" | "assistant";
  content: string | AContent[];
}

/**
 * ElevenLabs schickt jeden Turn den kompletten Verlauf. Anthropic verlangt
 * strikten Wechsel user/assistant und keine leeren Bloecke. Tool-Nachrichten
 * alter Turns (end_call usw.) sind fuer den Sprachdialog irrelevant und fallen weg.
 */
export function toAnthropic(messages: OAMessage[]): { system: string; messages: AnthropicTurn[] } {
  const systemParts: string[] = [];
  const turns: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    const text = partText(m.content).trim();
    if (m.role === "system" || m.role === "developer") {
      if (text) systemParts.push(text);
      continue;
    }
    if (m.role === "tool") continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    let body = text;
    if (!body && m.role === "assistant" && m.tool_calls?.length) {
      body = `[Tool aufgerufen: ${m.tool_calls.map((t) => t.function.name).join(", ")}]`;
    }
    if (!body) continue;
    const prev = turns[turns.length - 1];
    if (prev && prev.role === role) prev.content += "\n\n" + body;
    else turns.push({ role, content: body });
  }
  if (!turns.length || turns[0].role !== "user") turns.unshift({ role: "user", content: "(Gesprächsbeginn)" });
  if (turns[turns.length - 1].role === "assistant") turns.push({ role: "user", content: "(Bitte fortfahren)" });
  return { system: systemParts.join("\n\n"), messages: turns };
}

function toAnthropicTools(tools: OATool[] | undefined): AnthropicToolDef[] {
  return (tools ?? [])
    .filter((t) => t.type === "function" && t.function?.name)
    .map((t) => ({
      name: t.function.name,
      description: t.function.description ?? "",
      input_schema: t.function.parameters ?? { type: "object", properties: {} },
    }));
}

const DEEP_THINK_TOOL: AnthropicToolDef = {
  name: "deep_think",
  description:
    "Nutze dieses Tool, wenn der Nutzer eine gruendliche Analyse, Berechnung oder Recherche will, " +
    "die ehrlicherweise laenger als eine halbe Minute braucht. " + BRAND.name + " erarbeitet das Ergebnis im Hintergrund " +
    "mit allen Werkzeugen und schickt es dem Nutzer per Telegram. Sag ihm das kurz und frag nicht nach Bestaetigung.",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "Die Aufgabe vollstaendig formuliert, mit allem Kontext aus dem Gespraech, den man dafuer braucht.",
      },
    },
    required: ["question"],
  },
};

const voiceStyle = (agentName: string) =>
  `Du bist gerade im Sprachgespraech (Voice-Agent ${agentName}). Du sprichst, du schreibst nicht: ` +
  "Antworte in ein bis drei gesprochenen Saetzen, ausser der Nutzer will ausdruecklich mehr. " +
  "Keine Aufzaehlungen, keine Markdown-Zeichen, keine URLs vorlesen, keine Emojis. Zahlen so nennen, wie man sie sagt. " +
  "Wenn dir Kontext aus frueheren Gespraechen fehlt, nutze history_search, statt zu raten. " +
  "Wenn eine Frage echte Analyse braucht, die laenger als eine halbe Minute dauert, nutze deep_think, statt den Nutzer warten zu lassen. " +
  "Merk-Tags wie [REMEMBER: ...] oder [GOAL: ...] darfst du ans Ende setzen; sie werden nicht vorgelesen. " +
  "[INVOKE:...]-Tags funktionieren hier nicht, lass sie weg.";

/** Text des Denkauftrags an den laufenden Bot; nennt den Sprachagenten wie der Sprechstil. */
export function deepThinkText(question: string, agentName: string): string {
  return `Denkauftrag aus dem Sprachgespräch mit ${agentName}: ${question}\n\nArbeite das gründlich aus und antworte hier in Telegram.`;
}

// ---------------------------------------------------------------------------
// 3. Tag-Filter: Intent-Tags werden nicht vorgelesen
// ---------------------------------------------------------------------------

const TAG_RE = /^\[(REMEMBER|GOAL|DONE|CANCEL|FORGET|INVOKE|ASSET_DESC)\b/i;

/** Haelt "[..." zurueck, bis klar ist, ob es ein Intent-Tag ist. */
export class TagFilter {
  private buf = "";
  push(t: string): string {
    this.buf += t;
    let out = "";
    while (this.buf) {
      const i = this.buf.indexOf("[");
      if (i < 0) {
        out += this.buf;
        this.buf = "";
        break;
      }
      out += this.buf.slice(0, i);
      this.buf = this.buf.slice(i);
      const j = this.buf.indexOf("]");
      if (j < 0) {
        if (this.buf.length > 400) {
          out += this.buf;
          this.buf = "";
        }
        break;
      }
      const tag = this.buf.slice(0, j + 1);
      this.buf = this.buf.slice(j + 1);
      if (!TAG_RE.test(tag)) out += tag;
    }
    return out;
  }
  flush(): string {
    const rest = this.buf;
    this.buf = "";
    return TAG_RE.test(rest) ? "" : rest;
  }
}

export function stripTags(text: string): string {
  const f = new TagFilter();
  return (f.push(text) + f.flush()).replace(/[ \t]+\n/g, "\n").trim();
}

// ---------------------------------------------------------------------------
// 4. Anthropic-Stream lesen und in OpenAI-Chunks uebersetzen
// ---------------------------------------------------------------------------

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function anthropicHeaders(env: BridgeEnv) {
  return {
    "x-api-key": env.VOICE_ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
}

export function oaChunk(id: string, model: string, delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) yield { event, data };
    }
  }
}

interface AnthropicCall {
  model: string;
  system: string;
  messages: AnthropicTurn[];
  effort: Effort;
  max_tokens: number;
  tools: AnthropicToolDef[];
  signal?: AbortSignal;
}

interface Sinks {
  onText(t: string): void;
  onToolStart(i: number, id: string, name: string): void;
  onToolArgs(i: number, json: string): void;
}

interface StreamResult {
  finish: "stop" | "tool_calls";
  /** Assistant-Bloecke fuer die Fortsetzung (Thinking mit Signatur, Text, tool_use). */
  content: AContent[];
  localCalls: { id: string; name: string; input: Record<string, unknown> }[];
  deepCalls: { id: string; question: string }[];
  text: string;
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

async function streamAnthropic(env: BridgeEnv, call: AnthropicCall, localNames: Set<string>, sinks: Sinks, hooks: BridgeHooks): Promise<StreamResult> {
  const settle = hooks.reserveRequest?.();
  try {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: anthropicHeaders(env),
    signal: call.signal,
    body: JSON.stringify({
      model: call.model,
      max_tokens: call.max_tokens,
      system: call.system,
      messages: call.messages,
      tools: call.tools,
      output_config: { effort: call.effort },
      stream: true,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);

  type Block = {
    kind: "text" | "tool" | "local" | "deep" | "thinking" | "redacted" | "other";
    oaIndex: number;
    id: string;
    name: string;
    args: string;
    text: string;
    signature: string;
    data: string;
  };
  const blocks = new Map<number, Block>();
  const order: number[] = [];
  let oaToolCount = 0;
  let finish: "stop" | "tool_calls" = "stop";

  for await (const ev of sseEvents(res.body)) {
    const data = JSON.parse(ev.data);
    switch (data.type) {
      case "content_block_start": {
        const cb = data.content_block;
        const b: Block = { kind: "other", oaIndex: -1, id: cb.id ?? "", name: cb.name ?? "", args: "", text: "", signature: "", data: cb.data ?? "" };
        if (cb.type === "tool_use" && cb.name === "deep_think") b.kind = "deep";
        else if (cb.type === "tool_use" && localNames.has(cb.name)) b.kind = "local";
        else if (cb.type === "tool_use") {
          b.kind = "tool";
          b.oaIndex = oaToolCount++;
          sinks.onToolStart(b.oaIndex, cb.id, cb.name);
          finish = "tool_calls";
        } else if (cb.type === "text") b.kind = "text";
        else if (cb.type === "thinking") b.kind = "thinking";
        else if (cb.type === "redacted_thinking") b.kind = "redacted";
        blocks.set(data.index, b);
        order.push(data.index);
        break;
      }
      case "content_block_delta": {
        const b = blocks.get(data.index);
        if (!b) break;
        const d = data.delta;
        if (d.type === "text_delta" && b.kind === "text") {
          b.text += d.text;
          sinks.onText(d.text);
        } else if (d.type === "input_json_delta") {
          b.args += d.partial_json;
          if (b.kind === "tool") sinks.onToolArgs(b.oaIndex, d.partial_json);
        } else if (d.type === "thinking_delta" && b.kind === "thinking") {
          b.text += d.thinking;
        } else if (d.type === "signature_delta" && b.kind === "thinking") {
          b.signature += d.signature;
        }
        break;
      }
      case "error":
        throw new Error(JSON.stringify(data.error));
    }
  }

  const content: AContent[] = [];
  const localCalls: StreamResult["localCalls"] = [];
  const deepCalls: StreamResult["deepCalls"] = [];
  let text = "";
  for (const idx of order) {
    const b = blocks.get(idx)!;
    switch (b.kind) {
      case "thinking":
        if (b.signature) content.push({ type: "thinking", thinking: b.text, signature: b.signature });
        break;
      case "redacted":
        content.push({ type: "redacted_thinking", data: b.data });
        break;
      case "text":
        if (b.text) content.push({ type: "text", text: b.text });
        text += b.text;
        break;
      case "tool":
      case "local":
      case "deep": {
        const input = safeJson(b.args);
        content.push({ type: "tool_use", id: b.id, name: b.name, input });
        if (b.kind === "local") localCalls.push({ id: b.id, name: b.name, input });
        if (b.kind === "deep") deepCalls.push({ id: b.id, question: String(input.question ?? "") });
        break;
      }
    }
  }
  return { finish, content, localCalls, deepCalls, text };
  } finally { settle?.(); }
}

// ---------------------------------------------------------------------------
// 5. HTTP-Handler
// ---------------------------------------------------------------------------

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

const DEEP_ACK = "Alles klar, das denke ich in Ruhe durch und schicke dir das Ergebnis per Telegram.";
const DEEP_ACK_TOOL = " Ich denke das in Ruhe durch und melde mich per Telegram.";

export async function handleBridge(
  req: Request,
  env: BridgeEnv,
  hooks: BridgeHooks,
  background: (p: Promise<unknown>) => void
): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") return new Response("ok");
  if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
    return new Response("not found", { status: 404 });
  }
  const auth = req.headers.get("authorization") ?? "";
  if (!env.VOICE_BRIDGE_TOKEN || auth !== `Bearer ${env.VOICE_BRIDGE_TOKEN}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const body = (await req.json()) as OARequest;
  const model = env.VOICE_MODEL || "claude-opus-5";
  const fallback = (EFFORTS.includes(env.VOICE_DEFAULT_EFFORT as Effort) ? env.VOICE_DEFAULT_EFFORT : "medium") as Effort;
  const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
  // Werkzeuge, deren Ergebnisse ElevenLabs seit der letzten Nutzer-Nachricht
  // zurueckgeschickt hat: die Antwort dieses Turns kennt ihre Inhalte
  const lastUserIndex = lastUser ? body.messages.lastIndexOf(lastUser) : -1;
  const turnUses: ToolUse[] = body.messages
    .slice(lastUserIndex + 1)
    .flatMap((m) => (m.role === "assistant" ? m.tool_calls ?? [] : []))
    .map((c) => ({ name: c.function?.name || "unbekannt", external: true }));
  const lastUserText = partText(lastUser?.content ?? "").trim();
  const plan = classifyTurn(lastUserText, fallback, body.elevenlabs_extra_body?.effort);
  const { system: agentSystem, messages: history } = toAnthropic(body.messages);
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const enc = new TextEncoder();

  const localTools = hooks.localTools?.() ?? [];
  const localNames = new Set(localTools.map((t) => t.name));
  // Hat der Nutzer ausdruecklich um Nachdenken gebeten (high), will er die Antwort jetzt hoeren:
  // dann kein deep_think anbieten, sonst vertagt Opus nach 20 s Denkzeit auf Telegram.
  const thinkNow = plan.effort !== "medium" && plan.effort !== "low";
  const tools: AnthropicToolDef[] = [...toAnthropicTools(body.tools), ...localTools, ...(thinkNow ? [] : [DEEP_THINK_TOOL])];
  const thinkNowHint = thinkNow
    ? "Der Nutzer hat dich gerade ausdruecklich gebeten, gruendlich nachzudenken: Antworte jetzt live und vollstaendig mit deiner Einschaetzung, verweise nicht auf spaeter oder auf Telegram."
    : "";

  // Kappt ElevenLabs die Verbindung (Unterbrechung, eigener Timeout), brechen wir Anthropic mit ab.
  let closed = false;
  const abort = new AbortController();

  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      closed = true;
      abort.abort();
    },
    async start(controller) {
      const send = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          closed = true;
          abort.abort();
        }
      };
      const filter = new TagFilter();
      const startedAt = Date.now();
      let toolRounds = 0;
      // Keepalive waehrend langer Denkzeit: ElevenLabs wartet nur wenige Sekunden auf den naechsten
      // Chunk und springt sonst (entgegen der Doku) auf das Backup-LLM. Ein Leerzeichen ist unhoerbar.
      let keepalive: ReturnType<typeof setInterval> | null = null;
      const stopKeepalive = () => {
        if (keepalive) clearInterval(keepalive);
        keepalive = null;
      };
      // Nur bis zur letzten Wortgrenze rausgeben: Anthropic streamt Wortfragmente,
      // ElevenLabs haengt Chunks direkt aneinander, halbe Woerter wuerden hoerbar zerhackt.
      let wordBuf = "";
      const emitWords = (force: boolean) => {
        let cut = wordBuf.length;
        if (!force) {
          cut = 0;
          for (let i = wordBuf.length - 1; i >= 0; i--) {
            if (/\s/.test(wordBuf[i])) {
              cut = i + 1;
              break;
            }
          }
        }
        if (cut <= 0) return;
        const out = wordBuf.slice(0, cut);
        wordBuf = wordBuf.slice(cut);
        if (out) send(oaChunk(id, model, { content: out }));
      };
      const speak = (t: string) => {
        stopKeepalive();
        wordBuf += filter.push(t);
        emitWords(false);
      };
      const end = (finish: string) => {
        stopKeepalive();
        wordBuf += filter.flush();
        emitWords(true);
        send(oaChunk(id, model, {}, finish));
        send("data: [DONE]\n\n");
        console.log(
          `[bridge] Turn fertig: effort=${plan.effort}${plan.deep ? " (deep)" : ""} tool_rounds=${toolRounds} finish=${finish} dauer=${Date.now() - startedAt} ms`
        );
      };
      let rawAssistant = "";
      const persist = () => {
        if (!hooks.persistTurn || !lastUserText) return;
        background(hooks.persistTurn(lastUserText, rawAssistant, { uses: turnUses }));
      };

      try {
        send(oaChunk(id, model, { role: "assistant", content: "" }));

        if (plan.deep) {
          rawAssistant = DEEP_ACK;
          send(oaChunk(id, model, { content: DEEP_ACK }));
          if (hooks.deepThink) background(hooks.deepThink(lastUserText, lastUserText));
          end("stop");
          persist();
          return;
        }

        // Buffer Words (ElevenLabs-Doku): "... " mit Leerzeichen, damit TTS sauber anschliesst
        if (plan.effort !== "medium" && plan.effort !== "low") {
          send(oaChunk(id, model, { content: "Moment, ich überlege kurz... " }));
          keepalive = setInterval(() => send(oaChunk(id, model, { content: " " })), 3000);
        }

        let context = "";
        if (hooks.loadContext) {
          try {
            context = await hooks.loadContext();
          } catch (err) {
            console.error("[bridge] loadContext:", err);
          }
        }
        const system = [context, agentSystem, voiceStyle(voiceAgentName(env)), thinkNowHint].filter(Boolean).join("\n\n");
        const messages: AnthropicTurn[] = [...history];
        const sinks: Sinks = {
          onText: speak,
          onToolStart: (i, tid, name) =>
            send(oaChunk(id, model, { tool_calls: [{ index: i, id: tid, type: "function", function: { name, arguments: "" } }] })),
          onToolArgs: (i, json) => send(oaChunk(id, model, { tool_calls: [{ index: i, function: { arguments: json } }] })),
        };

        let finish: "stop" | "tool_calls" = "stop";
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          const r = await streamAnthropic(
            env,
            {
              model,
              system,
              messages,
              effort: plan.effort,
              max_tokens: plan.effort === "medium" || plan.effort === "low" ? 4000 : 12000,
              tools,
              signal: abort.signal,
            },
            localNames,
            sinks,
            hooks
          );
          rawAssistant += r.text;
          finish = r.finish;
          for (const b of r.content) {
            if (b.type !== "tool_use") continue;
            // Lokal (history_search) und deep_think laufen in tybo, alles andere bei ElevenLabs
            const external = !localNames.has(b.name) && b.name !== DEEP_THINK_TOOL.name;
            turnUses.push(external ? { name: b.name, external } : { name: b.name });
          }

          for (const d of r.deepCalls) {
            speak(DEEP_ACK_TOOL);
            rawAssistant += DEEP_ACK_TOOL;
            if (hooks.deepThink) background(hooks.deepThink(d.question || lastUserText, lastUserText));
          }

          const canLoop = r.localCalls.length > 0 && r.finish === "stop" && round < MAX_TOOL_ROUNDS && hooks.runLocalTool;
          if (!canLoop) break;
          toolRounds++;

          const results = await Promise.all(
            r.localCalls.map(async (c) => {
              try {
                return await hooks.runLocalTool!(c.name, c.input);
              } catch (err) {
                return JSON.stringify({ error: String(err).slice(0, 300) });
              }
            })
          );
          const toolResults: AContent[] = r.localCalls.map((c, i) => ({ type: "tool_result", tool_use_id: c.id, content: results[i] }));
          for (const d of r.deepCalls) toolResults.push({ type: "tool_result", tool_use_id: d.id, content: "Denkauftrag angenommen, Ergebnis kommt per Telegram." });
          messages.push({ role: "assistant", content: r.content });
          messages.push({ role: "user", content: toolResults });
        }
        end(finish);
        persist();
      } catch (err) {
        if (closed) {
          console.log(`[bridge] Turn abgebrochen (Client weg) nach ${Date.now() - startedAt} ms, effort=${plan.effort}`);
        } else {
          console.error("[bridge]", err);
          const sorry = "Entschuldige, da ist gerade etwas schiefgelaufen. Frag mich bitte noch einmal.";
          send(oaChunk(id, model, { content: sorry }));
          end("stop");
        }
      } finally {
        stopKeepalive();
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
