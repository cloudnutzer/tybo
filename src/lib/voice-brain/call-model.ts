/**
 * Modellwahl des Telefonhörers (Issue #256, Entscheidung 0024).
 *
 * Einstellung speech.call.model: auto oder <claude|openrouter|ollama>:<modell>
 * (Format wie src/lib/aux-model.ts). Vorrang wie in src/lib/settings.ts:
 * config/settings.json vor SPEECH_CALL_MODEL aus .env vor auto. Effort aus
 * speech.call.effort (Standard low), claudeVia aus speech.call.claudeVia.
 *
 * Wege für claude:<modell>:
 * - api: Messages API mit VOICE_ANTHROPIC_API_KEY
 * - cli: offene Claude-Code-Sitzung, angemeldet nach CLAUDE_AUTH (Abo oder
 *   eigener API-Schlüssel, src/lib/engines/claude-auth.ts); billing sagt das
 * Ohne claudeVia gilt api, wenn der Schlüssel da ist, sonst cli. claudeVia
 * erzwingt einen Weg; fehlt er (kein Schlüssel bzw. CLI nicht bereit), ist
 * der Telefonhörer nicht bereit, es wird nicht auf den anderen gewechselt.
 *
 * auto, in dieser Reihenfolge (Planungs-Nachtrag vom 30.09.2026 und Zieltext
 * des Issues):
 * 1. claude:claude-sonnet-5-5 über die API, wenn VOICE_ANTHROPIC_API_KEY
 *    gesetzt ist (entfällt bei claudeVia cli)
 * 2. claude:claude-sonnet-5-5 über die CLI, wenn Claude Code installiert und
 *    angemeldet ist (inspectEngine, wirklich geprüft) und alle Flags kennt
 *    (entfällt bei claudeVia api)
 * 3. openrouter:anthropic/claude-sonnet-5.5, wenn OPENROUTER_API_KEY gesetzt ist
 * sonst nicht bereit. Ollama wählt auto nie, auch nicht als letzte Stufe: es
 * muss ausdrücklich eingestellt sein (zäh, lokal; der Kommentar „dann Ollama"
 * im Issue ist damit ausdrücklich nicht umgesetzt).
 *
 * Kein stilles Ausweichen: createCallBackend baut genau den aufgelösten Weg.
 * Fällt er im Gespräch zweimal hintereinander aus (zwei Turns mit Fehler),
 * endet das Gespräch (BrainError "ended"); die Fallback-Kette
 * (src/lib/fallback/chain.ts) springt nie ein.
 */

import { inspectEngine, type EngineStatus } from "../engines/check";
import { claudeUsesSubscription } from "../engines/claude-auth";
import { getSettings, isCallModelSetting, parseAuxSpec, type AuxKind, type Settings } from "../settings";
import { createAnthropicBackend } from "./backends/anthropic";
import { checkCliFlags, createClaudeCliBackend } from "./backends/claude-cli";
import { createOpenAICompatBackend, OLLAMA_SHOW_URL } from "./backends/openai-compat";
import { callExpectation, type CallExpectationKey } from "./expectations";
import type { Effort } from "./plan";
import { runVoiceTurn } from "./turn";
import { BrainError, type BrainBackend, type BrainCall } from "./types";

export const CALL_DEFAULT_CLAUDE = "claude:claude-sonnet-5-5";
export const CALL_DEFAULT_OPENROUTER = "openrouter:anthropic/claude-sonnet-5.5";
export const CALL_DEFAULT_EFFORT: Effort = "low";
/** So viele Turns hintereinander dürfen ausfallen, dann endet das Gespräch */
export const CALL_FAILURE_LIMIT = 2;

export type CallVia = "api" | "cli" | "openrouter" | "ollama";

/**
 * Wer zahlt: anthropic-api (Schlüssel, nach Verbrauch), subscription
 * (zählt gegen das Agent-SDK-Guthaben des Claude-Abos), openrouter (nach
 * Verbrauch), local (Ollama, kostet nichts außer Strom)
 */
export type CallBilling = "anthropic-api" | "subscription" | "openrouter" | "local";

export interface CallModelResolution {
  /** Gewähltes Modell als <kind>:<modell>; null, wenn auto nichts fand */
  spec: string | null;
  kind: AuxKind | null;
  model: string | null;
  via: CallVia | null;
  effort: Effort;
  ready: boolean;
  /** Warum nicht bereit (deutsch, ohne Schlüssel) */
  reason?: string;
  /** Kurzer Satz aus der Messung */
  expectation: string;
  billing: CallBilling | null;
  /** Kostet der Weg Geld nach Verbrauch (API-Schlüssel, OpenRouter)? */
  costsMoney: boolean;
  /** Was eingestellt ist: auto oder ein Modell */
  setting: string;
  source: "settings" | "env" | "code";
  claudeVia?: "api" | "cli";
}

export interface CallModelDeps {
  settings?: Settings;
  env?: Record<string, string | undefined>;
  /** Claude Code installiert und angemeldet (Standard: inspectEngine("claude")) */
  inspectClaude?: () => Promise<EngineStatus>;
  /** Fehlende Flags (Standard: claude --help); null = nicht prüfbar */
  cliFlags?: () => Promise<{ missing: string[] } | null>;
  /** Ollama läuft und kennt das Modell (Standard: /api/show mit 2 s Zeitlimit); Grund oder null */
  ollamaCheck?: (model: string) => Promise<string | null>;
}

async function defaultOllamaCheck(model: string): Promise<string | null> {
  try {
    const res = await fetch(OLLAMA_SHOW_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(2_000),
    });
    if (res.ok) return null;
    if (res.status === 404) return `Ollama kennt das Modell ${model} nicht (ollama pull ${model})`;
    return `Ollama antwortet mit ${res.status}`;
  } catch {
    return "Ollama läuft nicht (ollama serve starten)";
  }
}

/** Claude Code bereit für die offene Sitzung? null oder Grund */
async function cliProblem(deps: CallModelDeps): Promise<string | null> {
  const status = await (deps.inspectClaude ?? (() => inspectEngine("claude")))();
  if (!status.installed || !status.loggedIn) return status.message ?? "Claude Code ist nicht bereit";
  const flags = await (deps.cliFlags ?? (() => checkCliFlags()))();
  if (flags === null) return "Claude Code ließ sich nicht prüfen (claude --help lief nicht)";
  if (flags.missing.length) return `Claude Code kennt diese Flags nicht: ${flags.missing.join(", ")} (Claude Code aktualisieren)`;
  return null;
}

function expectationKey(via: CallVia, model: string): CallExpectationKey {
  if (via === "cli" && /haiku/i.test(model)) return "cli-haiku";
  return via;
}

/** Was eingestellt ist, mit Quelle; ein ungültiges SPEECH_CALL_MODEL gilt als auto */
export function callModelSetting(settings: Settings, env: Record<string, string | undefined>): { setting: string; source: "settings" | "env" | "code" } {
  const fromFile = settings.speech?.call?.model?.trim();
  if (fromFile && isCallModelSetting(fromFile)) return { setting: fromFile, source: "settings" };
  const fromEnv = (env.SPEECH_CALL_MODEL ?? "").trim();
  if (fromEnv) {
    if (isCallModelSetting(fromEnv)) return { setting: fromEnv, source: "env" };
    // Ohne den Wert: dort kann versehentlich ein Schlüssel stehen
    console.warn("[Telefonhörer] SPEECH_CALL_MODEL ungültig, es gilt auto");
  }
  return { setting: "auto", source: "code" };
}

export async function resolveCallModel(deps: CallModelDeps = {}): Promise<CallModelResolution> {
  const settings = deps.settings ?? getSettings();
  const env = deps.env ?? process.env;
  const { setting, source } = callModelSetting(settings, env);
  const effort: Effort = settings.speech?.call?.effort ?? CALL_DEFAULT_EFFORT;
  const claudeVia = settings.speech?.call?.claudeVia;
  const voiceKey = !!(env.VOICE_ANTHROPIC_API_KEY ?? "").trim();
  const openrouterKey = !!(env.OPENROUTER_API_KEY ?? "").trim();
  const subscription = claudeUsesSubscription(env);
  const base = { effort, setting, source, ...(claudeVia ? { claudeVia } : {}) };

  const ready = (spec: string, via: CallVia): CallModelResolution => {
    const parsed = parseAuxSpec(spec)!;
    const billing: CallBilling =
      via === "api" ? "anthropic-api" : via === "cli" ? (subscription ? "subscription" : "anthropic-api") : via === "openrouter" ? "openrouter" : "local";
    return {
      ...base,
      spec,
      kind: parsed.kind,
      model: parsed.model,
      via,
      ready: true,
      expectation: callExpectation(expectationKey(via, parsed.model)),
      billing,
      costsMoney: billing === "anthropic-api" || billing === "openrouter",
    };
  };
  const notReady = (spec: string | null, via: CallVia | null, reason: string): CallModelResolution => {
    const parsed = spec ? parseAuxSpec(spec) : null;
    return {
      ...base,
      spec,
      kind: parsed?.kind ?? null,
      model: parsed?.model ?? null,
      via,
      ready: false,
      reason,
      expectation: callExpectation("none"),
      billing: null,
      costsMoney: false,
    };
  };

  if (setting === "auto") {
    const reasons: string[] = [];
    if (claudeVia !== "cli") {
      if (voiceKey) return ready(CALL_DEFAULT_CLAUDE, "api");
      reasons.push("kein VOICE_ANTHROPIC_API_KEY");
    }
    if (claudeVia !== "api") {
      const problem = await cliProblem(deps);
      if (!problem) return ready(CALL_DEFAULT_CLAUDE, "cli");
      reasons.push(problem);
    }
    if (openrouterKey) return ready(CALL_DEFAULT_OPENROUTER, "openrouter");
    reasons.push("kein OPENROUTER_API_KEY");
    return notReady(
      null,
      null,
      `Kein Weg für den Telefonhörer bereit: ${reasons.join("; ")}. Ollama nur ausdrücklich (speech.call.model = ollama:<modell>). Sprechen geht weiter über den Sprechmodus.`,
    );
  }

  const parsed = parseAuxSpec(setting)!;
  if (parsed.kind === "claude") {
    if (claudeVia === "api" || (claudeVia === undefined && voiceKey)) {
      return voiceKey ? ready(setting, "api") : notReady(setting, "api", "VOICE_ANTHROPIC_API_KEY fehlt (claudeVia api ist eingestellt)");
    }
    const problem = await cliProblem(deps);
    return problem ? notReady(setting, "cli", problem) : ready(setting, "cli");
  }
  if (parsed.kind === "openrouter") {
    return openrouterKey ? ready(setting, "openrouter") : notReady(setting, "openrouter", "OPENROUTER_API_KEY fehlt");
  }
  const problem = await (deps.ollamaCheck ?? defaultOllamaCheck)(parsed.model);
  return problem ? notReady(setting, "ollama", problem) : ready(setting, "ollama");
}

// ---------------------------------------------------------------------------
// Wählbare Wege (Issue #260)
// ---------------------------------------------------------------------------

export type CallWayId = "api" | "cli" | "openrouter" | "ollama";

/** Ein Weg zur Auswahl im Reiter „Sprechen" und in tybo setup sprache */
export interface CallWay {
  id: CallWayId;
  /** Was gespeichert wird: speech.call.model, bei Claude dazu claudeVia */
  model: string;
  claudeVia?: "api" | "cli";
  /** Klartext, etwa „Claude Sonnet 5.5 über dein Claude-Abo" */
  label: string;
  ready: boolean;
  reason?: string;
  expectation: string;
  billing: CallBilling | null;
}

/** Ollama-Modell für den Weg zur Auswahl: OLLAMA_MODEL, sonst das Standardmodell der Fallback-Kette */
export function callOllamaModel(env: Record<string, string | undefined>): string {
  const m = (env.OLLAMA_MODEL ?? "").trim();
  return m && /^[A-Za-z0-9._:/-]{1,100}$/.test(m) ? m : "qwen3:8b";
}

function wayLabel(id: CallWayId, model: string, billing: CallBilling | null): string {
  const name = /claude-sonnet-5-5/.test(model) ? "Claude Sonnet 5.5" : model;
  if (id === "api") return `${name} über deinen API-Schlüssel`;
  if (id === "cli") return billing === "anthropic-api" ? `${name} über Claude Code (mit ANTHROPIC_API_KEY, Kosten nach Verbrauch)` : `${name} über dein Claude-Abo`;
  if (id === "openrouter") return `OpenRouter: ${model}`;
  return `Ollama: ${model}`;
}

/**
 * Alle Wege mit Bereitschaft und Grund: jeder Weg einzeln über
 * resolveCallModel aufgelöst, als wäre er eingestellt. Nichts wird gespeichert.
 */
export async function callWays(deps: CallModelDeps = {}): Promise<CallWay[]> {
  const settings = deps.settings ?? getSettings();
  const env = deps.env ?? process.env;
  const candidates: Array<{ id: CallWayId; model: string; claudeVia?: "api" | "cli" }> = [
    { id: "api", model: CALL_DEFAULT_CLAUDE, claudeVia: "api" },
    { id: "cli", model: CALL_DEFAULT_CLAUDE, claudeVia: "cli" },
    { id: "openrouter", model: CALL_DEFAULT_OPENROUTER },
    { id: "ollama", model: `ollama:${callOllamaModel(env)}` },
  ];
  const ways: CallWay[] = [];
  for (const c of candidates) {
    const call = { ...(settings.speech?.call ?? {}), model: c.model, ...(c.claudeVia ? { claudeVia: c.claudeVia } : {}) };
    if (!c.claudeVia) delete (call as { claudeVia?: string }).claudeVia;
    const r = await resolveCallModel({ ...deps, env, settings: { ...settings, speech: { ...(settings.speech ?? {}), call } } });
    const model = parseAuxSpec(c.model)!.model;
    ways.push({
      id: c.id,
      model: c.model,
      ...(c.claudeVia ? { claudeVia: c.claudeVia } : {}),
      label: wayLabel(c.id, model, r.billing ?? (c.id === "cli" && !claudeUsesSubscription(env) ? "anthropic-api" : null)),
      ready: r.ready,
      ...(r.ready ? {} : { reason: r.reason ?? "nicht bereit" }),
      expectation: r.ready ? r.expectation : callExpectation(c.id),
      billing: r.billing,
    });
  }
  return ways;
}

// ---------------------------------------------------------------------------
// Weg bauen
// ---------------------------------------------------------------------------

export interface CallBackendOptions {
  /** Session-Schlüssel des Gesprächs (für /stop der CLI-Sitzung) */
  abortKey?: string;
  /** Tagesbudget "voice": reservieren, Rückgabe rechnet ab */
  reserveRequest?: () => (actualUsd?: number) => void;
  agentName?: string;
  env?: Record<string, string | undefined>;
  /** Nur Tests: Wege ersetzen */
  factories?: Partial<Record<CallVia, () => BrainBackend>>;
}

/**
 * Höchstens CALL_FAILURE_LIMIT Turns hintereinander mit Fehler; danach ist
 * das Gespräch beendet und der Weg geschlossen. Ein erfolgreicher Turn setzt
 * die Zählung zurück. Abbrüche und ein erschöpftes Budget zählen nicht.
 */
export function withFailureLimit(inner: BrainBackend, limit = CALL_FAILURE_LIMIT): BrainBackend {
  let failures = 0;
  let ended: string | null = null;
  /**
   * Zuletzt begonnener Turn, auch nach dem Ende seines Stroms: runVoiceTurn
   * spricht danach noch den Rest aus sentences.flush(), close() muss ihn
   * auch dann beenden. Ein schon abgeschlossener Turn ignoriert das.
   */
  let last: BrainCall | null = null;
  return {
    id: inner.id,
    label: inner.label,
    async *stream(call: BrainCall) {
      if (ended) throw new BrainError("ended", ended);
      last = call;
      try {
        yield* inner.stream(call);
        failures = 0;
      } catch (err) {
        // Der Weg selbst ist beendet (/stop, close(), zweiter Absturz): auch hier Schluss, auch wenn das Signal abgebrochen ist
        if (err instanceof BrainError && err.reason === "ended") {
          ended = ended ?? err.message;
          inner.close?.();
          throw err;
        }
        const aborted = call.signal?.aborted || (err instanceof Error && err.name === "AbortError");
        const budget = err instanceof BrainError && err.reason === "budget";
        if (!aborted && !budget) {
          failures++;
          if (failures >= limit) {
            ended = `Gespräch beendet: ${inner.label} ist ${limit}-mal hintereinander ausgefallen (${err instanceof Error ? err.message : String(err)})`;
            inner.close?.();
            throw new BrainError("ended", ended);
          }
        }
        throw err;
      }
    },
    interrupt: inner.interrupt ? () => inner.interrupt!() : undefined,
    prepare: inner.prepare ? system => inner.prepare!(system) : undefined,
    close: () => {
      ended = ended ?? "Gespräch beendet";
      inner.close?.();
      last?.abort?.(new BrainError("ended", ended));
    },
  };
}

/** Baut genau den aufgelösten Weg (kein Ausweichen); wirft, wenn er nicht bereit ist */
export function createCallBackend(resolution: CallModelResolution, options: CallBackendOptions = {}): BrainBackend {
  if (!resolution.ready || !resolution.via || !resolution.model) {
    throw new BrainError("setup", resolution.reason ?? "Kein Weg für den Telefonhörer bereit");
  }
  const env = options.env ?? process.env;
  const via = resolution.via;
  const model = resolution.model;
  const factory =
    options.factories?.[via] ??
    (() => {
      switch (via) {
        case "api":
          return createAnthropicBackend({ apiKey: env.VOICE_ANTHROPIC_API_KEY ?? "", model, effort: resolution.effort, reserveRequest: options.reserveRequest });
        case "cli":
          return createClaudeCliBackend({ model, effort: resolution.effort, abortKey: options.abortKey, agentName: options.agentName, reserveRequest: options.reserveRequest });
        case "openrouter":
          return createOpenAICompatBackend({ kind: "openrouter", model, apiKey: env.OPENROUTER_API_KEY ?? "", reserveRequest: options.reserveRequest });
        case "ollama":
          return createOpenAICompatBackend({ kind: "ollama", model, reserveRequest: options.reserveRequest });
      }
    });
  return withFailureLimit(factory());
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/** Drei feste deutsche Testfragen (wie scripts/voice-brain-probe.ts) */
export const PROBE_QUESTIONS = [
  "Wie spät ist es gerade, und welcher Tag ist heute?",
  "Was weißt du über meine aktuellen Ziele?",
  "Gib mir einen kurzen Tipp, wie ich heute Abend besser einschlafe.",
];

export interface ProbeSample {
  question: number;
  run: number;
  /** Millisekunden bis zum ersten Abschnitt; null ohne Abschnitt */
  firstMs: number | null;
  totalMs: number;
  /** Erster Turn des Gesprächs: enthält bei der CLI den Prozessstart */
  cold: boolean;
  error?: string;
}

export interface ProbeResult {
  resolution: CallModelResolution;
  samples: ProbeSample[];
  /** Über alle Turns mit erstem Abschnitt */
  medianMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  /** Ohne den kalten ersten Turn */
  warmMedianMs: number | null;
}

export interface ProbeOptions extends CallModelDeps {
  /** Läufe je Frage (Standard 1): runs = 3 ergibt neun Turns */
  runs?: number;
  /** Kontext und Sprechstil; ohne Angabe der echte Kontext wie in der Brücke */
  system?: string;
  /** Statt resolveCallModel (etwa für einen bestimmten Weg) */
  resolution?: CallModelResolution;
  backendOptions?: CallBackendOptions;
  now?: () => number;
  /**
   * Abbruch (Zeitlimit der Route, Abbruch der Einrichtung): die laufende
   * Testfrage endet über runVoiceTurn, der Weg wird geschlossen (Prozess der
   * CLI, offene Ströme), keine weitere Testfrage beginnt; dann wirft die
   * Probe einen Fehler mit name "AbortError".
   */
  signal?: AbortSignal;
}

/** Fehler einer abgebrochenen Probe */
function probeAborted(): Error {
  const e = new Error("Probe abgebrochen");
  e.name = "AbortError";
  return e;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return (s[Math.floor((s.length - 1) / 2)] + s[Math.ceil((s.length - 1) / 2)]) / 2;
}

/** Echter Kontext wie in der Brücke (Profil, Memory, letzte Nachrichten) mit Sprechstil "call" */
async function realSystem(): Promise<string> {
  const { createVoiceContext } = await import("./context");
  const { voiceStyle } = await import("./style");
  const { voiceAgentName } = await import("../voice-agent-name");
  const { getUserProfile } = await import("../../agents/base");
  const { default: generalAgent } = await import("../../agents/general");
  const { getMemoryContext } = await import("../memory");
  const { storeOr } = await import("../store");
  const getRecentMessages = (chatId: string, limit: number, topicId?: number | null) =>
    storeOr([], store => store.messages.recent(chatId, limit, topicId));
  const context = createVoiceContext({
    agent: generalAgent,
    deps: { getUserProfile, getMemoryContext: () => getMemoryContext(), getRecentMessages, timeZone: process.env.USER_TIMEZONE },
  });
  const text = await context.load(process.env.TELEGRAM_USER_ID || "");
  return [text, voiceStyle({ agentName: voiceAgentName(), channel: "call" })].join("\n\n");
}

/**
 * Probe über den eingestellten Weg: die drei Testfragen nacheinander in einem
 * Gespräch (ein Weg, bei der CLI ein Prozess), je Frage `runs` Läufe ohne
 * Verlauf. Messbeginn unmittelbar vor runVoiceTurn, also nach dem Laden des
 * Kontexts; gemessen bis zum ersten sprechbaren Abschnitt. Der erste Turn
 * ist kalt (Prozessstart bei der CLI, Kontextprüfung bei Ollama).
 */
export async function probeCallModel(options: ProbeOptions = {}): Promise<ProbeResult> {
  const signal = options.signal;
  if (signal?.aborted) throw probeAborted();
  const resolution = options.resolution ?? (await resolveCallModel(options));
  if (!resolution.ready) throw new BrainError("setup", resolution.reason ?? "Kein Weg bereit");
  const system = options.system ?? (await realSystem());
  if (signal?.aborted) throw probeAborted();
  const runs = Math.max(1, Math.floor(options.runs ?? 1));
  const now = options.now ?? (() => performance.now());
  const backend = createCallBackend(resolution, options.backendOptions);
  // Abbruch schließt den Weg sofort (CLI-Prozess, offene Ströme), nicht erst nach der Testfrage
  const onAbort = () => backend.close?.();
  signal?.addEventListener("abort", onAbort, { once: true });
  const samples: ProbeSample[] = [];
  try {
    probe: for (const [qi, question] of PROBE_QUESTIONS.entries()) {
      for (let run = 1; run <= runs; run++) {
        if (signal?.aborted) break probe;
        const t0 = now();
        let first: number | null = null;
        let error: string | undefined;
        for await (const event of runVoiceTurn({ backend, system, history: [], userText: question, ...(signal ? { signal } : {}) })) {
          if (event.type === "segment" && first === null) first = now() - t0;
          if (event.type === "error") error = `${event.reason}: ${event.message}`;
        }
        samples.push({ question: qi + 1, run, firstMs: first, totalMs: now() - t0, cold: samples.length === 0, ...(error ? { error } : {}) });
        // Gespräch beendet (zweimal ausgefallen): weitere Fragen messen nichts mehr
        if (error?.startsWith("ended:")) break probe;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    backend.close?.();
  }
  if (signal?.aborted) throw probeAborted();
  const firsts = samples.filter((s) => s.firstMs !== null).map((s) => s.firstMs!);
  const warm = samples.filter((s) => !s.cold && s.firstMs !== null).map((s) => s.firstMs!);
  return {
    resolution,
    samples,
    medianMs: median(firsts),
    minMs: firsts.length ? Math.min(...firsts) : null,
    maxMs: firsts.length ? Math.max(...firsts) : null,
    warmMedianMs: median(warm),
  };
}
