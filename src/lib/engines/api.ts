/**
 * Motor "api" (Entscheidung E4, Issues #347 und #348): ein Turn geht direkt
 * an die Anthropic Messages API, ohne installierte CLI.
 *
 * Ein Lauf ist eine Werkzeugschleife: Werkzeuge anbieten (api-tools.ts),
 * tool_use-Blöcke ausführen, tool_result mit passender ID zurückgeben, bis
 * das Modell ohne Werkzeug endet oder die Rundengrenze greift (maxTurns der
 * Anfrage, sonst API_MAX_ROUNDS; dann ein Hinweis, kein Fehler). Freigaben
 * laufen über authorizeTool; jedes Werkzeug läuft in einer Unter-Ausführung,
 * die mit /stop und den Zeitlimits des Motors endet, auch während es auf
 * eine Freigabe wartet. Danach läuft kein Werkzeug und kein Abruf mehr.
 *
 * Sitzungen (api-sessions.ts): jeder Lauf liefert eine sessionId, ein
 * Folgeturn mit resumeSessionId hängt den Prompt an den gespeicherten
 * Verlauf. ask_user beendet den Lauf ohne weiteren Abruf mit der Frage als
 * [FRAGE: ...]; der Chat-Kern legt daraus die Rückfrage im Register an. Die
 * nächste Fortsetzung (Knopf oder getippte Nachricht) wird zum tool_result
 * der offenen Frage, zusammen mit den schon erzeugten Ergebnissen der Runde;
 * das Ergebnis nennt die beantwortete Frage (answeredQuestion), damit der
 * Chat-Kern sie nach einer getippten Antwort im Register schließt. Ein Knopf
 * (answersQuestion) zu einer schon beantworteten Frage setzt nichts fort.
 * Die Ausgabe einer Pause wird als Ganzes gegen scanForQuestion geprüft
 * (askOutput), damit daraus genau diese Rückfrage wird.
 * Rückfragen nur mit ausdrücklicher Freigabe (withQuestions): ask_user
 * bekommt und eine offene Pause beantwortet nur ein Lauf, dessen Aufrufer
 * die Rückfrage im Register anlegt (questions vom Chat-Kern mit onQuestion,
 * answersQuestion vom Knopf). Jeder andere Lauf (Konsultation, Denkauftrag,
 * Befehl, Anruf) sieht den Verlauf mit dem Hinweis, dass die Frage offen
 * ist, wird dann aber nicht gespeichert; die Pause bleibt genau einmal
 * beantwortbar.
 * Gespeichert wird nur nach einem Lauf ohne Fehler, Abbruch oder Zeitlimit;
 * sonst bleibt die Sitzung, wie sie war. Das gilt bis zum endgültigen
 * Schreiben: endet der Lauf vorher, meldet er aborted bzw. timedOut.
 * Eine unbekannte, ungültige oder beschädigte Sitzung ergibt errorKind
 * "context" ohne Abruf; der Chat-Kern antwortet dann mit Claude Code.
 *
 * Schlüssel: ANTHROPIC_API_KEY aus der Umgebung des Bots. Ohne Schlüssel ist
 * der Motor nicht verfügbar (checkEngine) und ein Lauf endet mit errorKind
 * "auth", dann antwortet Claude Code (chat-turn.ts).
 *
 * Intern wird immer gestreamt (src/lib/anthropic-stream.ts): so greifen
 * Leerlauf-Grenze und /stop auch mitten in einer langen Antwort. Nach außen
 * kommt der Text am Stück; im Streaming-Modus gibt es nur die Rückrufe für
 * den ersten Textblock und für jedes Werkzeug (Fortschritt).
 *
 * Kosten: Verbrauch aller Runden samt Cache-Tokens, auch wenn eine spätere
 * Runde scheitert; costUsd nur, wenn jede Runde einen bekannten Preis hatte,
 * sonst leer (unbekannt, nicht 0). Gebucht wird einmal je Lauf im Chat-Kern
 * (bookRunOutcome), nicht hier.
 */

import { join } from "node:path";
import {
  AnthropicHttpError,
  AnthropicStreamError,
  postMessages,
  readMessageStream,
  streamText,
  type AContent,
  type AnthropicToolDef,
  type AnthropicTurn,
  type FetchLike,
  type Usage,
} from "../anthropic-stream";
import { firstTextSnippet } from "../claude/stream";
import { DEFAULT_CLAUDE_MODEL } from "../default-model";
import { checkAborted, runWithSignal } from "../execution-context";
import type { ToolUse } from "../turn-tools";
import { appendUser, assistantContent, RunAccount, runRoundTools, skippedResults } from "./api-loop";
import {
  fileApiSessionStore,
  newPauseMark,
  newSessionId,
  parseSessionRef,
  sessionRef,
  type ApiPause,
  type ApiSession,
  type ApiSessionStore,
} from "./api-sessions";
import { askOutput, mcpToolHost, realScheduleToolDeps, runScheduleTool, toolOffer, type ApiToolHost, type ScheduleToolDeps } from "./api-tools";
import { registerEngineCall, unregisterEngineCall } from "./calls";
import type { Engine, EngineErrorKind, EngineRequest, EngineResult, EngineUsage } from "./types";

/** Obergrenze der Ausgabe je Runde */
export const API_MAX_TOKENS = 16_000;

/** Rundengrenze der Werkzeugschleife ohne maxTurns in der Anfrage */
export const API_MAX_ROUNDS = 15;

export const API_TEXT = {
  sessionGone: "Sitzung nicht mehr vorhanden",
  questionAnswered: "Diese Rückfrage ist schon beantwortet, Sitzung nicht mehr vorhanden",
  /** tool_result der offenen Frage, nur im Verlauf eines Laufs ohne Rückfragen-Register (nie gespeichert) */
  questionOpen: "Noch nicht beantwortet: diese Rückfrage bleibt offen, bis der Nutzer antwortet. Erledige den folgenden Auftrag ohne die Antwort.",
  roundLimit: (rounds: number) =>
    `Ich habe nach ${rounds} Werkzeugrunden angehalten, um nicht endlos weiterzulaufen. Schreib „weiter“, dann mache ich an dieser Stelle weiter.`,
} as const;

/** Effort-Stufen, die die Messages API als output_config.effort annimmt */
const API_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Modellnamen, die die API annimmt: nur volle Namen, keine Kurzformen der CLI (opus, sonnet) */
const API_MODEL = /^claude-[a-z0-9][\w.-]*$/;

export const API_KEY_MISSING =
  "Für den Motor api fehlt ANTHROPIC_API_KEY in der .env (Schlüssel aus console.anthropic.com)";

export interface ApiRuntime {
  fetch: FetchLike;
  /** Schlüssel für die Messages API; leer oder undefined heißt: keiner */
  apiKey(): string | undefined;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  /** Werkzeuge aus mcpManager (Angebot und Ausführung) */
  tools: ApiToolHost;
  /** Ablage der Sitzungen */
  sessions: ApiSessionStore;
  /** Ablage, Uhr, Gespräch und Freigabe der Planungswerkzeuge */
  schedule: ScheduleToolDeps;
}

/** Ordner der Sitzungen: data/api-sessions im Projektordner (GO_PROJECT_ROOT, sonst Arbeitsordner) */
export function apiSessionDir(env: Record<string, string | undefined> = process.env): string {
  return join(env.GO_PROJECT_ROOT || process.cwd(), "data", "api-sessions");
}

const realRuntime: ApiRuntime = {
  fetch: (url, init) => fetch(url, init),
  apiKey: () => process.env.ANTHROPIC_API_KEY,
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  tools: mcpToolHost,
  sessions: fileApiSessionStore(() => apiSessionDir()),
  schedule: realScheduleToolDeps,
};

let runtime: ApiRuntime = realRuntime;

/** Nur für Tests: Abruf, Schlüssel und Uhr ersetzen (Teile genügen); null stellt alles zurück */
export function setApiRuntimeForTests(partial: Partial<ApiRuntime> | null): void {
  runtime = partial ? { ...realRuntime, ...partial } : realRuntime;
}

/** Ablage der Sitzungen (alte Aufträge übernehmen ihren Stand dorthin, api-legacy.ts) */
export function apiSessionStore(): ApiSessionStore {
  return runtime.sessions;
}

/** Schlüssel für den Motor, getrimmt; undefined ohne Schlüssel */
export function apiKey(): string | undefined {
  const key = runtime.apiKey()?.trim();
  return key ? key : undefined;
}

/** Modell für die API: ein voller Claude-Name, sonst (Kurzform, „[1m]", leer) der Standard */
export function apiModel(model: string | undefined): string {
  return model && API_MODEL.test(model) ? model : DEFAULT_CLAUDE_MODEL;
}

/** Effort für die API oder undefined, wenn die Stufe unbekannt ist (dann fehlt das Feld) */
export function apiEffort(effort: string | undefined): string | undefined {
  return effort && API_EFFORTS.has(effort) ? effort : undefined;
}

/** Rumpf einer Runde: Verlauf, Werkzeuge, Modell und Effort, ohne Thinking */
export function apiRequestBody(
  req: Pick<EngineRequest, "model" | "effort">,
  messages: AnthropicTurn[],
  tools: AnthropicToolDef[] = []
): Record<string, unknown> {
  const effort = apiEffort(req.effort);
  return {
    model: apiModel(req.model),
    max_tokens: API_MAX_TOKENS,
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...(effort ? { output_config: { effort } } : {}),
    stream: true,
  };
}

/** Verbrauch einer Meldung als EngineUsage; Eingabe samt Cache wie bei Claude Code (claudeUsage) */
export function apiUsage(u: Usage | null): EngineUsage | undefined {
  if (!u) return undefined;
  const account = new RunAccount("");
  account.addRound(u, false);
  return account.fields().usage;
}

/** Art eines HTTP-Fehlers */
function httpErrorKind(err: AnthropicHttpError): EngineErrorKind {
  if (err.status === 401 || err.status === 403) return "auth";
  if (err.status === 429) return "rate_limit";
  if (err.status === 529 || err.status === 503) return "capacity";
  if (err.status === 400 && /prompt is too long|context/i.test(err.body)) return "context";
  return "other";
}

/** Art eines Fehler-Ereignisses im Strom */
function streamErrorKind(err: AnthropicStreamError): EngineErrorKind {
  if (err.errorType === "overloaded_error") return "capacity";
  if (err.errorType === "rate_limit_error") return "rate_limit";
  if (err.errorType === "authentication_error" || err.errorType === "permission_error") return "auth";
  return "other";
}

/** Nachricht aus einem Fehlerrumpf der API, gekürzt; der Schlüssel steht dort nie */
function apiMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === "string" && message) return message.slice(0, 300);
  } catch {
    // kein JSON: Rohtext
  }
  return raw.replace(/\s+/g, " ").trim().slice(0, 300);
}

type StopReason = "abort" | "total" | "idle";

export function createApiEngine(): Engine {
  return {
    id: "api",
    describe: () => "Anthropic API",
    run: (req) => runApi(req),
  };
}

/** Läufe derselben Sitzung nacheinander (Knopf und getippte Antwort gleichzeitig) */
const sessionQueues = new Map<string, Promise<unknown>>();

function inSessionQueue<T>(id: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!id) return fn();
  const previous = sessionQueues.get(id) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  sessionQueues.set(id, tail);
  void tail.then(() => {
    if (sessionQueues.get(id) === tail) sessionQueues.delete(id);
  });
  return run;
}

/** Lauf mit Rückfragen-Register: nur er bekommt ask_user und beantwortet eine offene Pause */
const withQuestions = (req: EngineRequest): boolean => !!req.questions || !!req.answersQuestion;

const contextError = (text: string): EngineResult => ({ engine: "api", text, isError: true, errorKind: "context" });

interface OpenedSession {
  session: ApiSession;
  messages: AnthropicTurn[];
  /** Werkzeuge des pausierten Laufs */
  carried: ToolUse[];
  /** Kennung der Rückfrage, die dieser Lauf beantwortet */
  answered?: string;
  /** Denkauftrag oder Konsultation bei offener Pause: nichts speichern, die Pause bleibt */
  aside?: boolean;
}

/**
 * Verlauf und Sitzung für den Lauf; ein EngineResult heißt: nicht
 * fortsetzbar, kein Abruf.
 *
 * Offene Pause: der Prompt beantwortet sie, ob Knopf oder getippte
 * Nachricht. Nur die Antwort auf einen Knopf (answersQuestion) muss zur
 * Marke passen: ein alter Knopf setzt nie eine spätere Frage fort. Ohne
 * offene Pause ist eine Marke veraltet: ein Knopf bekommt questionAnswered,
 * eine getippte Nachricht ist ein normaler Folgeturn derselben Sitzung (kein
 * Fehler, also auch kein neuer Lauf im Chat-Kern). Ein Lauf ohne
 * Rückfragen-Register (withQuestions falsch) beantwortet keine Pause:
 * Nebenlauf auf dem Verlauf, die Frage als offen gemeldet, der Auftrag als
 * Text dahinter.
 */
async function openSession(req: EngineRequest, store: ApiSessionStore, model: string, nowIso: string): Promise<OpenedSession | EngineResult> {
  if (!req.resumeSessionId) {
    const session: ApiSession = { id: newSessionId(), model, createdAt: nowIso, updatedAt: nowIso, messages: [] };
    return { session, messages: [{ role: "user", content: req.prompt }], carried: [] };
  }
  const ref = parseSessionRef(req.resumeSessionId);
  if (!ref) return contextError(API_TEXT.sessionGone);
  const loaded = await store.load(ref.id);
  if (loaded.status !== "ok") return contextError(API_TEXT.sessionGone);
  const session = loaded.session;
  const pause = session.pause;
  if (!pause) {
    if (ref.mark && req.answersQuestion) return contextError(API_TEXT.questionAnswered);
    return { session, messages: appendUser(session.messages, req.prompt), carried: [] };
  }
  if (!withQuestions(req)) {
    const open: AContent = { type: "tool_result", tool_use_id: pause.toolUseId, content: API_TEXT.questionOpen };
    const turn: AContent[] = [...pause.results, open, { type: "text", text: req.prompt }];
    return { session, messages: appendUser(session.messages, turn), carried: pause.uses, aside: true };
  }
  if (req.answersQuestion && ref.mark && ref.mark !== pause.mark) return contextError(API_TEXT.questionAnswered);
  // Antwort auf die offene Frage: in einer Nutzernachricht mit den übrigen Ergebnissen der Runde
  const answer: AContent = { type: "tool_result", tool_use_id: pause.toolUseId, content: req.prompt };
  return { session, messages: appendUser(session.messages, [...pause.results, answer]), carried: pause.uses, answered: sessionRef(session) };
}

async function runApi(req: EngineRequest): Promise<EngineResult> {
  const key = apiKey();
  if (!key) return { engine: "api", text: API_KEY_MISSING, isError: true, errorKind: "auth" };
  if (!req.prompt.trim()) return { engine: "api", text: "Leerer Auftrag für die Anthropic API", isError: true, errorKind: "other" };
  checkAborted();
  const ref = req.resumeSessionId ? parseSessionRef(req.resumeSessionId) : null;
  return inSessionQueue(ref?.id, () => runLoop(req, key));
}

async function runLoop(req: EngineRequest, key: string): Promise<EngineResult> {
  const rt = runtime;
  const model = apiModel(req.model);
  const opened = await openSession(req, rt.sessions, model, new Date(rt.now()).toISOString());
  if ("engine" in opened) return opened;
  const { session } = opened;
  let messages = opened.messages;
  checkAborted();

  const startedAt = rt.now();
  const controller = new AbortController();
  let stopped: StopReason | undefined;
  let markStopped!: () => void;
  const whenStopped = new Promise<void>((resolve) => (markStopped = resolve));
  const stop = (why: StopReason) => {
    if (stopped) return;
    stopped = why;
    controller.abort();
    markStopped();
  };

  // Für das Register ein Pseudo-Prozess: beenden heißt den Abruf abbrechen
  const proc = { pid: 0, kill: () => stop("abort") };
  const entry = registerEngineCall(req.abortKey, proc, (p) => p.kill());

  let lastSignAt = startedAt;
  let idleTimer: unknown;
  const idleMs = req.streaming ? req.idleTimeoutMs : undefined;
  const armIdle = () => {
    if (idleMs === undefined) return;
    rt.clearTimeout(idleTimer);
    idleTimer = rt.setTimeout(() => stop("idle"), idleMs);
  };
  const disarmIdle = () => rt.clearTimeout(idleTimer);
  const totalTimer = rt.setTimeout(() => stop("total"), req.timeoutMs);

  const account = new RunAccount(model);
  const uses: ToolUse[] = [...opened.carried];
  // Ohne Register keine Rückfrage, also auch kein ask_user
  const offer = toolOffer(rt.tools, req.allowedTools, withQuestions(req));
  const maxRounds = req.maxTurns && req.maxTurns > 0 ? req.maxTurns : API_MAX_ROUNDS;
  let firstTextSent = false;
  let lastText = "";
  let roundUsage: Usage | null = null;

  const toolsField = () => ({ uses: [...uses], cwd: req.cwd });
  const finish = async (text: string, pause?: ApiPause): Promise<EngineResult> => {
    let saved: ApiSession = session;
    if (!opened.aside) {
      saved = { ...session, model, messages, updatedAt: new Date(rt.now()).toISOString() };
      if (pause) saved.pause = pause;
      else delete saved.pause;
      // Endet der Lauf vor dem endgültigen Schreiben, wirft save: aborted bzw. timedOut (catch unten)
      await rt.sessions.save(saved, controller.signal);
    }
    return {
      engine: "api",
      text,
      isError: false,
      sessionId: sessionRef(saved),
      ...(opened.answered ? { answeredQuestion: opened.answered } : {}),
      tools: toolsField(),
      ...account.fields(),
    };
  };

  try {
    for (let round = 1; ; round++) {
      // Eine Runde: senden, Strom lesen
      roundUsage = null;
      armIdle();
      let stream;
      try {
        const body = await postMessages(key, apiRequestBody(req, messages, offer.defs), controller.signal, rt.fetch);
        lastSignAt = rt.now();
        armIdle();
        stream = await readMessageStream(
          body,
          {
            onEvent: () => {
              lastSignAt = rt.now();
              armIdle();
            },
            onUsage: (u) => void (roundUsage = u),
            onBlockEnd: (block) => {
              if (block.type !== "text" || !block.text.trim()) return;
              lastText = block.text;
              if (!req.streaming || firstTextSent) return;
              firstTextSent = true;
              req.onFirstText?.(firstTextSnippet(block.text), block.text);
            },
          },
          controller.signal
        );
      } catch (err) {
        if (err instanceof AnthropicHttpError) account.addRejected();
        else account.addRound(roundUsage, false);
        throw err;
      }
      disarmIdle();
      account.addRound(stream.usage, stream.complete);
      const text = streamText(stream.blocks).trim();
      if (!stream.complete) {
        // Ohne abschließenden Verbrauch ist nur der vorläufige aus message_start bekannt: Kosten unbekannt
        return { engine: "api", text: "Die Antwort der Anthropic API brach vorzeitig ab", isError: true, errorKind: "other", tools: toolsField(), ...account.fields() };
      }
      if (stream.stopReason === "refusal") {
        return { engine: "api", text: text || "Die Anthropic API hat die Anfrage abgelehnt", isError: true, errorKind: "other", tools: toolsField(), ...account.fields() };
      }
      const content = assistantContent(stream.blocks);
      if (content.length > 0) messages = [...messages, { role: "assistant", content }];
      const calls = content.filter((b): b is Extract<AContent, { type: "tool_use" }> => b.type === "tool_use");
      if (calls.length === 0) return await finish(text);

      if (round >= maxRounds) {
        // Grenze erreicht: Werkzeuge laufen nicht mehr, der Verlauf bleibt gültig
        messages = appendUser(messages, skippedResults(calls));
        return await finish([text, API_TEXT.roundLimit(round)].filter(Boolean).join("\n\n"));
      }

      const outcome = await runRoundTools(calls, {
        host: rt.tools,
        offer,
        schedule: (name, input) => runScheduleTool(name, input, rt.schedule, req.noTelegram),
        guard: (fn) => runWithSignal(controller.signal, fn),
        stopped: () => stopped !== undefined,
        whenStopped,
        ...(req.streaming && req.onToolStart ? { onToolStart: req.onToolStart } : {}),
      });
      uses.push(...outcome.uses);
      if (outcome.stopped || stopped) throw new Error("Lauf beendet");
      if (outcome.pause) {
        // Ohne weiteren Abruf: die Frage geht als [FRAGE: ...] an den Chat-Kern, die ganze Ausgabe geprüft
        const pause: ApiPause = { toolUseId: outcome.pause.toolUseId, mark: newPauseMark(), results: outcome.results, uses: [...uses] };
        return await finish(askOutput(text, outcome.pause), pause);
      }
      messages = appendUser(messages, outcome.results);
    }
  } catch (err) {
    const accounting = account.fields();
    if (stopped === "abort" || entry.aborted) return { engine: "api", text: "", isError: true, aborted: true, tools: toolsField(), ...accounting };
    if (stopped === "total" || stopped === "idle") {
      if (!req.streaming) return { engine: "api", text: "", isError: true, timedOut: true, tools: toolsField(), ...accounting };
      const now = rt.now();
      return {
        engine: "api",
        text: "",
        isError: true,
        timedOut: true,
        timeoutKind: stopped,
        stoppedAfterMs: now - startedAt,
        idleForMs: now - lastSignAt,
        tools: toolsField(),
        ...accounting,
        ...(lastText ? { lastText } : {}),
      };
    }
    if (err instanceof AnthropicHttpError) {
      return { engine: "api", text: `Anthropic API ${err.status}: ${apiMessage(err.body)}`, isError: true, errorKind: httpErrorKind(err), tools: toolsField(), ...accounting };
    }
    if (err instanceof AnthropicStreamError) {
      return { engine: "api", text: `Anthropic API: ${apiMessage(err.detail)}`, isError: true, errorKind: streamErrorKind(err), tools: toolsField(), ...accounting };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return { engine: "api", text: `Anthropic API nicht erreichbar: ${reason.slice(0, 300)}`, isError: true, errorKind: "other", tools: toolsField(), ...accounting };
  } finally {
    rt.clearTimeout(totalTimer);
    rt.clearTimeout(idleTimer);
    unregisterEngineCall(req.abortKey, entry);
  }
}
