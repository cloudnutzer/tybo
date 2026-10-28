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
import { classifyTurn, EFFORTS, type Effort } from "../voice-brain/plan";
import { voiceStyle } from "../voice-brain/style";
import { TagFilter } from "../voice-brain/tags";
import { callIdsFrom, type CallIds } from "../phone/bridge-note";
import { streamAnthropic, type AContent, type AnthropicToolDef, type AnthropicTurn, type Sinks } from "../voice-brain/backends/anthropic";

export type { AContent, AnthropicToolDef, AnthropicTurn } from "../voice-brain/backends/anthropic";
export type { Effort, TurnPlan } from "../voice-brain/plan";

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
  /** Freigeschaltete Rufnummern, kommagetrennt (Default in voice-bridge.ts: USER_PHONE_NUMBER) */
  VOICE_ALLOWED_CALLERS?: string;
  /** "true": Gespraeche ohne Rufnummer (Web, Widget, fehlende Header) zulassen. Default: abweisen */
  VOICE_ALLOW_UNIDENTIFIED?: string;
  /** Laendervorwahl fuer nationale Nummern wie 0151..., Default 49 */
  VOICE_DEFAULT_COUNTRY_CODE?: string;
}

export interface BridgeHooks {
  reserveRequest?: () => (actualUsd?: number) => void;
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
  /**
   * Anlass eines ausgehenden Anrufs (Issue #366), je Turn frisch gelesen und
   * nicht im Kontext-Cache: ids aus den Headern x-voice-call-ref und
   * x-voice-conversation-id (src/lib/phone/bridge-note.ts). null: kein
   * bekannter Anruf. Läuft erst nach Token- und Rufnummernprüfung.
   */
  callNote?: (ids: CallIds) => string | null | Promise<string | null>;
}

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

// 1. Effort-Router: src/lib/voice-brain/plan.ts (classifyTurn)

// ---------------------------------------------------------------------------
// 2. OpenAI-Verlauf -> Anthropic-Verlauf
// ---------------------------------------------------------------------------

export function partText(c: OAMessage["content"]): string {
  if (!c) return "";
  if (typeof c === "string") return c;
  return c.map((p) => p.text ?? "").join("");
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

/** Text des Denkauftrags an den laufenden Bot; nennt den Sprachagenten wie der Sprechstil. */
export function deepThinkText(question: string, agentName: string): string {
  return `Denkauftrag aus dem Sprachgespräch mit ${agentName}: ${question}\n\nArbeite das gründlich aus und antworte hier in Telegram.`;
}

// 3. Tag-Filter: src/lib/voice-brain/tags.ts (TagFilter, stripTags)

// ---------------------------------------------------------------------------
// 4. OpenAI-Chunks (Anthropic-Stream lesen: src/lib/voice-brain/backends/anthropic.ts)
// ---------------------------------------------------------------------------

export function oaChunk(id: string, model: string, delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

// ---------------------------------------------------------------------------
// 5. Rufnummer-Pruefung: nur freigeschaltete Nummern bekommen tybo
// ---------------------------------------------------------------------------

/**
 * ElevenLabs setzt diese Header aus den System-Variablen (custom_llm.request_headers,
 * {"variable_name": "system__caller_id"} usw.). Der Anrufer kann sie nicht beeinflussen,
 * anders als elevenlabs_extra_body, das vom Client kommt.
 */
export const CALLER_HEADER = "x-voice-caller-id";
export const CALLED_HEADER = "x-voice-called-number";
export const CHANNEL_HEADER = "x-voice-channel";

/** Rufnummer auf Ziffern mit Laendervorwahl bringen: "+49 151 ...", "0049151...", "0151...", "sip:+49...@host" -> "49151...". */
export function normalizePhone(raw: string | null | undefined, defaultCc = "49"): string {
  if (!raw) return "";
  let s = raw.trim();
  // Nicht aufgeloeste Variable (Web-Gespraech ohne Rufnummer)
  if (s.includes("{{") || s.includes("system__")) return "";
  s = s.replace(/^(sip|sips|tel):/i, "").split(/[@;]/)[0];
  const digits = s.replace(/\D/g, "");
  if (digits.length < 6) return "";
  if (s.startsWith("+")) return digits;
  if (digits.startsWith("00")) return digits.slice(2);
  if (digits.startsWith("0")) return defaultCc + digits.slice(1);
  return digits;
}

export interface CallerVerdict {
  ok: boolean;
  /** Fuers Log: welche Nummern ElevenLabs gemeldet hat */
  caller: string;
  called: string;
  channel: string;
}

/**
 * Freigabe, wenn eine Seite des Gespraechs eine freigeschaltete Nummer ist: eingehend
 * ruft der Nutzer an (caller), ausgehend ruft tybo ihn an (called). Ohne jede Rufnummer
 * (Web, Widget, Header nicht eingerichtet) nur mit VOICE_ALLOW_UNIDENTIFIED=true.
 */
export function checkCaller(headers: Headers, env: BridgeEnv): CallerVerdict {
  const cc = env.VOICE_DEFAULT_COUNTRY_CODE || "49";
  const caller = normalizePhone(headers.get(CALLER_HEADER), cc);
  const called = normalizePhone(headers.get(CALLED_HEADER), cc);
  const channel = (headers.get(CHANNEL_HEADER) ?? "").replace(/\{\{.*\}\}/, "").trim() || "unbekannt";
  const allowed = new Set(
    (env.VOICE_ALLOWED_CALLERS ?? "")
      .split(/[,;]/)
      .map((n) => normalizePhone(n, cc))
      .filter(Boolean)
  );
  const numbers = [caller, called].filter(Boolean);
  const ok = numbers.length ? numbers.some((n) => allowed.has(n)) : env.VOICE_ALLOW_UNIDENTIFIED === "true";
  return { ok, caller, called, channel };
}

const REJECT_TEXT = "Dieser Anschluss ist privat. Auf Wiederhören.";

/** Abweisung ohne Kontext, Tools, Historie und ohne Anthropic-Aufruf; legt per end_call auf, wenn ElevenLabs es anbietet. */
function rejectResponse(body: OARequest, model: string): Response {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const endCall = (body.tools ?? []).find((t) => t.type === "function" && t.function?.name === "end_call");
  const props = (endCall?.function.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  const args = JSON.stringify("reason" in props ? { reason: "Rufnummer nicht freigeschaltet" } : {});
  const parts = [oaChunk(id, model, { role: "assistant", content: REJECT_TEXT })];
  if (endCall) {
    parts.push(oaChunk(id, model, { tool_calls: [{ index: 0, id: `call_${crypto.randomUUID()}`, type: "function", function: { name: "end_call", arguments: args } }] }));
  }
  parts.push(oaChunk(id, model, {}, endCall ? "tool_calls" : "stop"), "data: [DONE]\n\n");
  return new Response(parts.join(""), { headers: SSE_HEADERS });
}

// ---------------------------------------------------------------------------
// 6. HTTP-Handler
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
  const verdict = checkCaller(req.headers, env);
  if (!verdict.ok) {
    console.warn(
      `[bridge] Abgewiesen: kanal=${verdict.channel} anrufer=${verdict.caller || "-"} angerufen=${verdict.called || "-"}` +
        (verdict.caller || verdict.called ? "" : " (keine Rufnummer: Header fehlen oder Web-Gespraech)")
    );
    return rejectResponse(body, model);
  }
  const callIds = callIdsFrom(req.headers);
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
        let callNote: string | null = null;
        if (hooks.callNote) {
          try {
            callNote = await hooks.callNote(callIds);
          } catch (err) {
            console.error("[bridge] callNote:", err);
          }
        }
        const system = [context, callNote, agentSystem, voiceStyle({ agentName: voiceAgentName(env), channel: "phone" }), thinkNowHint].filter(Boolean).join("\n\n");
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
            env.VOICE_ANTHROPIC_API_KEY,
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
            hooks.reserveRequest
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
